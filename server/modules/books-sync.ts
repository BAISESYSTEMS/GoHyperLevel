import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, str, type Ctx } from '../core/http.js';
import { openSecret, sealSecret } from '../core/secrets.js';
import { id, now } from '../core/util.js';
import { BooksApiError, BooksClient, lexApi, sevApi, type BooksDeps } from '../services/books-sync-http.js';
import {
  PROVIDER_LABEL,
  PROVIDERS,
  RateLimiter,
  backoffMs,
  bookedTotalCents,
  cleanOptions,
  isProvider,
  lexContact,
  lexPaid,
  lexVoucher,
  sevContact,
  sevCreditNote,
  sevInvoice,
  sevPaid,
  type ContactInput,
  type Provider,
  type SyncOptions,
} from '../services/books-sync-model.js';
import { getContact } from '../services/contacts.js';
import type { DocSnapshot } from '../services/einvoice-model.js';
import { docOf, loadInvoice, recordPayment, type Inv } from '../services/invoice-flow.js';
import { openCents } from '../services/invoice-model.js';
import { invoicePdfOf } from '../services/invoice-render.js';
import { safeFetch } from '../services/net.js';

/**
 * Lexware Office / sevDesk live sync (Apps → Buchhaltung): one connection per sub-account (API key sealed), mapping options,
 * "Verbindung testen". Every finalised invoice and credit note goes into a queue (one job per document and tool – never two),
 * is pushed with contact upsert, lines/tax rates and the PDF, its remote id lands in invoice_links, failures retry with backoff
 * and show in the log. A tick pulls the payment status of open linked invoices and records payments through recordPayment.
 * Logic: services/books-sync-model.ts (pure) and books-sync-http.ts (API clients). Docs: docs/integrations.md.
 */

const PULL_EVERY_MS = 2 * 3600_000;
const LOCK_MS = 10 * 60_000;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Settings {
  provider: Provider | '';
  enabled: boolean;
  apiKey: string;
  hint: string;
  options: SyncOptions;
  row: any;
}

type Job = { id: string; location_id: string; invoice_id: string; provider: Provider; status: string; attempts: number; stage: string; remote_id: string; remote_total_cents: number };

const KEY_HELP: Record<Provider, { label: string; help: string; docs: string }> = {
  lexware: { label: 'API-Schlüssel (Lexware Office Public API)', help: 'Lexware Office → Einstellungen → Erweiterungen → Public API → „Schlüssel erstellen“ (Tarif mit API-Zugang).', docs: 'https://developers.lexware.io/docs/' },
  sevdesk: { label: 'API-Token (sevDesk)', help: 'sevDesk → Einstellungen → Benutzer → dein Benutzer → API-Token (32 Zeichen).', docs: 'https://api.sevdesk.de/' },
};

export const booksSyncModule: Module = {
  name: 'books-sync',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE books_sync_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, provider TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1, secret_sealed TEXT NOT NULL DEFAULT '', hint TEXT NOT NULL DEFAULT '', options TEXT NOT NULL DEFAULT '{}',
        last_test_at TEXT, last_test_ok INTEGER, last_test_result TEXT NOT NULL DEFAULT '', last_pull_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE books_sync_jobs (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, provider TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'push',
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, locked_until TEXT,
        stage TEXT NOT NULL DEFAULT '', remote_id TEXT NOT NULL DEFAULT '', remote_total_cents INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '', checked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(location_id, invoice_id, provider, action)
      );
      CREATE INDEX books_sync_jobs_due ON books_sync_jobs(status, next_at);
      CREATE INDEX books_sync_jobs_location ON books_sync_jobs(location_id, created_at);
      CREATE TABLE books_sync_contacts (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, provider TEXT NOT NULL,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, remote_id TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (location_id, provider, contact_id)
      );
      CREATE TABLE books_sync_log (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, invoice_id TEXT,
        provider TEXT NOT NULL, level TEXT NOT NULL, action TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX books_sync_log_location ON books_sync_log(location_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const sleep = (ms: number): Promise<void> => (app.services.booksSyncSleep ?? realSleep)(ms);
    const limiter = new RateLimiter({ sleep });
    const deps = (): BooksDeps => ({ fetch: app.services.booksSyncFetch ?? safeFetch, sleep, limiter });

    // --- settings -------------------------------------------------------------------------------------------------------------
    const settings = (loc: string): Settings | undefined => {
      const row = db.get('SELECT * FROM books_sync_settings WHERE location_id = ?', loc);
      if (!row) return undefined;
      let apiKey = '';
      try {
        apiKey = row.secret_sealed ? openSecret(app, row.secret_sealed) : '';
      } catch {
        apiKey = ''; // the server key changed: the connection has to be entered again
      }
      let options: Record<string, unknown> = {};
      try {
        options = JSON.parse(row.options || '{}');
      } catch {
        options = {};
      }
      return { provider: isProvider(row.provider) ? row.provider : '', enabled: !!row.enabled, apiKey, hint: row.hint ?? '', options: cleanOptions({}, options as Partial<SyncOptions>), row };
    };
    const active = (s: Settings | undefined): s is Settings & { provider: Provider } => !!(s && s.provider && s.enabled && s.apiKey);
    const clientOf = (s: Settings & { provider: Provider }) => new BooksClient(deps(), s.provider, s.apiKey);
    const saveOptions = (loc: string, o: SyncOptions) => db.run('UPDATE books_sync_settings SET options = ?, updated_at = ? WHERE location_id = ?', JSON.stringify(o), now(), loc);

    const log = (loc: string, provider: string, level: 'info' | 'error', action: string, message: string, invoiceId: string | null = null) => {
      db.insert('books_sync_log', { id: id(), location_id: loc, invoice_id: invoiceId, provider, level, action, message: message.slice(0, 600), created_at: now() });
      // keep the newest 500 lines per sub-account
      db.run(`DELETE FROM books_sync_log WHERE location_id = ? AND id IN (SELECT id FROM books_sync_log WHERE location_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 500)`, loc, loc);
    };

    const view = (loc: string) => {
      const s = settings(loc);
      const counts = Object.fromEntries(db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM books_sync_jobs WHERE location_id = ? GROUP BY status', loc).map((r) => [r.status, r.n]));
      return {
        providers: PROVIDERS.map((p) => ({ key: p, name: PROVIDER_LABEL[p], key_label: KEY_HELP[p].label, key_help: KEY_HELP[p].help, docs: KEY_HELP[p].docs })),
        provider: s?.provider ?? '',
        enabled: s ? s.enabled : false,
        connected: !!s?.apiKey,
        hint: s?.hint ?? '',
        options: s?.options ?? cleanOptions({}),
        last_test_at: s?.row.last_test_at ?? null,
        last_test_ok: s?.row.last_test_ok === null || s?.row.last_test_ok === undefined ? null : !!s.row.last_test_ok,
        last_test_result: s?.row.last_test_result ?? '',
        last_pull_at: s?.row.last_pull_at ?? null,
        counts,
      };
    };

    // --- queue ----------------------------------------------------------------------------------------------------------------
    /** One job per document and tool: a second finalise event, a manual push or a backfill never creates a second one. */
    const enqueue = (loc: string, invoiceId: string, provider: Provider, reset = false): Job => {
      const t = now();
      db.run(
        `INSERT INTO books_sync_jobs (id, location_id, invoice_id, provider, action, status, next_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'push', 'pending', ?, ?, ?)
         ON CONFLICT(location_id, invoice_id, provider, action) DO NOTHING`,
        id(), loc, invoiceId, provider, t, t, t,
      );
      if (reset) db.run(`UPDATE books_sync_jobs SET status = 'pending', attempts = 0, next_at = ?, last_error = '', updated_at = ? WHERE location_id = ? AND invoice_id = ? AND provider = ? AND status IN ('failed', 'skipped', 'retry')`, t, t, loc, invoiceId, provider);
      return db.get<Job>('SELECT * FROM books_sync_jobs WHERE location_id = ? AND invoice_id = ? AND provider = ?', loc, invoiceId, provider)!;
    };

    const finish = (job: Job, status: 'done' | 'skipped', message: string) => {
      db.run(`UPDATE books_sync_jobs SET status = ?, locked_until = NULL, last_error = ?, updated_at = ? WHERE id = ?`, status, status === 'skipped' ? message.slice(0, 500) : '', now(), job.id);
      log(job.location_id, job.provider, 'info', status === 'done' ? 'push' : 'skip', message, job.invoice_id);
    };

    const fail = (job: Job, e: unknown, inv?: Inv) => {
      const msg = (e as Error)?.message || String(e);
      const attempts = job.attempts + 1;
      const status = e instanceof BooksApiError ? e.status : 0;
      // A refused key, a missing right or a payload the tool rejects will fail the same way again: stop until someone retries.
      const permanent = (e instanceof BooksApiError && e.fatal) || (status >= 400 && status < 500 && ![404, 408, 409, 429].includes(status));
      const wait = permanent ? null : backoffMs(attempts);
      const t = now();
      db.run(
        `UPDATE books_sync_jobs SET status = ?, attempts = ?, next_at = ?, locked_until = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
        wait === null ? 'failed' : 'retry', attempts, wait === null ? t : new Date(Date.now() + wait).toISOString(), msg.slice(0, 500), t, job.id,
      );
      log(job.location_id, job.provider, 'error', 'push', `${inv ? `${inv.kind === 'credit_note' ? 'Gutschrift' : 'Rechnung'} ${inv.number}: ` : ''}${msg}${wait === null ? ' – angehalten, bitte prüfen und „Erneut versuchen“' : ` – neuer Versuch in ${Math.round(wait / 60_000)} Min.`}`, job.invoice_id);
    };

    /** Remote id stored the moment it exists – in the job (stage) and in invoice_links, so a retry continues instead of creating again. */
    const saveRemote = (job: Job, inv: Inv, remoteId: string, stage: string, totalCents: number) => {
      db.run('UPDATE books_sync_jobs SET remote_id = ?, stage = ?, remote_total_cents = ?, updated_at = ? WHERE id = ?', remoteId, stage, totalCents, now(), job.id);
      db.run(
        `INSERT INTO invoice_links (invoice_id, location_id, provider, external_id, number, status, url, synced_at) VALUES (?, ?, ?, ?, ?, 'sent', '', ?)
         ON CONFLICT(invoice_id) DO UPDATE SET provider = excluded.provider, external_id = excluded.external_id, number = excluded.number, synced_at = excluded.synced_at`,
        inv.id, inv.location_id, job.provider, remoteId, inv.number, now(),
      );
      Object.assign(job, { remote_id: remoteId, stage, remote_total_cents: totalCents });
    };
    const setStage = (job: Job, stage: string) => {
      db.run('UPDATE books_sync_jobs SET stage = ?, updated_at = ? WHERE id = ?', stage, now(), job.id);
      job.stage = stage;
    };

    /** The tool's contact for the invoice's contact: cached link → customer number → e-mail → newly created. */
    async function remoteContact(s: Settings & { provider: Provider }, client: BooksClient, inv: Inv, doc: DocSnapshot): Promise<string | undefined> {
      if (!inv.contact_id) return undefined;
      const cached = db.get<{ remote_id: string }>('SELECT remote_id FROM books_sync_contacts WHERE location_id = ? AND provider = ? AND contact_id = ?', inv.location_id, s.provider, inv.contact_id);
      if (cached) return cached.remote_id;
      const c = getContact(app, inv.location_id, inv.contact_id);
      if (!c) return undefined;
      const field = s.options.customer_number_field;
      const number = field ? String(c.custom?.[field] ?? '').trim().slice(0, 60) : '';
      const email = String(c.email || doc.buyer.email || '').trim().toLowerCase();
      const input: ContactInput = { first_name: c.first_name, last_name: c.last_name, company: c.company, email, phone: c.phone, customer_number: number };
      let rid: string | undefined;
      if (s.provider === 'lexware') {
        const api = lexApi(client);
        rid = (number ? await api.contactByNumber(number) : undefined) ?? (email ? await api.contactByEmail(email) : undefined);
        if (!rid) rid = await api.createContact(lexContact(input, doc.buyer));
      } else {
        const api = sevApi(client);
        rid = (number ? await api.contactByNumber(number) : undefined) ?? (email ? await api.contactByEmail(email) : undefined);
        if (!rid) rid = await api.createContact(sevContact(input, doc.buyer), email || undefined);
      }
      if (!rid) throw new Error(`${PROVIDER_LABEL[s.provider]} hat keine Kontakt-ID zurückgegeben`);
      db.run(
        `INSERT INTO books_sync_contacts (location_id, provider, contact_id, remote_id, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(location_id, provider, contact_id) DO UPDATE SET remote_id = excluded.remote_id, updated_at = excluded.updated_at`,
        inv.location_id, s.provider, inv.contact_id, rid, now(),
      );
      return rid;
    }

    async function pushLexware(s: Settings & { provider: Provider }, job: Job, inv: Inv): Promise<string> {
      const client = clientOf(s);
      const api = lexApi(client);
      const doc = docOf(app, inv);
      let adopted = false;
      if (!job.remote_id) {
        const found = await api.voucherByNumber(inv.number);
        if (found) {
          adopted = true;
          saveRemote(job, inv, found, 'adopted', bookedTotalCents(doc));
          log(inv.location_id, s.provider, 'info', 'adopt', `${inv.number}: Beleg gibt es in Lexware Office schon – verknüpft statt doppelt angelegt`, inv.id);
        }
      }
      if (!job.remote_id) {
        const contactId = s.options.contact_match === 'collective' ? undefined : await remoteContact(s, client, inv, doc);
        const rid = await api.createVoucher(lexVoucher(doc, { contactId, categoryId: s.options.category_id }));
        if (!rid) throw new Error('Lexware Office hat keine Beleg-ID zurückgegeben');
        saveRemote(job, inv, rid, 'created', bookedTotalCents(doc));
      }
      if (s.options.attach_pdf && !adopted && job.stage === 'created') {
        const { pdf, filename } = invoicePdfOf(app, inv);
        await api.attachFile(job.remote_id, { name: filename, data: pdf });
        setStage(job, 'attached');
      }
      return job.remote_id;
    }

    async function pushSevdesk(s: Settings & { provider: Provider }, job: Job, inv: Inv): Promise<string> {
      const client = clientOf(s);
      const api = sevApi(client);
      const doc = docOf(app, inv);
      const credit = inv.kind === 'credit_note';
      let adopted = false;
      if (!job.remote_id) {
        const found = credit ? await api.creditNoteByNumber(inv.number) : await api.invoiceByNumber(inv.number);
        if (found) {
          adopted = true;
          saveRemote(job, inv, found, 'adopted', bookedTotalCents(doc));
          log(inv.location_id, s.provider, 'info', 'adopt', `${inv.number}: gibt es in sevDesk schon – verknüpft statt doppelt angelegt`, inv.id);
        }
      }
      if (!job.remote_id) {
        if (!s.options.sev_user_id) {
          const users = await api.users();
          if (!users[0]?.id) throw new Error('sevDesk: kein Benutzer für „Ansprechpartner“ gefunden');
          s.options = { ...s.options, sev_user_id: String(users[0].id) };
          saveOptions(inv.location_id, s.options);
        }
        const contactId = await remoteContact(s, client, inv, doc);
        if (!contactId) throw new BooksApiError(422, 'sevDesk braucht einen Kontakt – die Rechnung hat keinen');
        const input = { contactId, sevUserId: s.options.sev_user_id, unityId: s.options.unity_id };
        const rid = credit ? await api.saveCreditNote(sevCreditNote(doc, input)) : await api.saveInvoice(sevInvoice(doc, input));
        if (!rid) throw new Error('sevDesk hat keine ID zurückgegeben');
        saveRemote(job, inv, rid, 'created', bookedTotalCents(doc));
      }
      if (!credit && s.options.mark_sent && !adopted && job.stage === 'created') {
        await api.markSent(job.remote_id);
        setStage(job, 'sent');
      }
      return job.remote_id;
    }

    async function runJob(job: Job) {
      const s = settings(job.location_id);
      if (!active(s) || s.provider !== job.provider) return finish(job, 'skipped', `${PROVIDER_LABEL[job.provider] ?? job.provider} ist nicht (mehr) verbunden`);
      const inv = loadInvoice(app, job.location_id, job.invoice_id);
      if (!inv || !inv.finalised_at || inv.kind === 'estimate') return finish(job, 'skipped', 'Kein festgeschriebener Beleg');
      if (inv.kind === 'credit_note' && !s.options.push_credit_notes) return finish(job, 'skipped', `Gutschrift ${inv.number}: Gutschriften werden laut Einstellung nicht übertragen`);
      const link = db.get<{ provider: string; external_id: string }>('SELECT provider, external_id FROM invoice_links WHERE invoice_id = ?', inv.id);
      if (link && link.provider !== job.provider) return finish(job, 'skipped', `${inv.number}: schon mit „${link.provider}“ verknüpft – nichts übertragen`);
      if (link?.external_id && !job.remote_id) Object.assign(job, { remote_id: link.external_id, stage: 'linked' });
      try {
        const rid = job.provider === 'lexware' ? await pushLexware(s, job, inv) : await pushSevdesk(s, job, inv);
        finish(job, 'done', `${inv.kind === 'credit_note' ? 'Gutschrift' : 'Rechnung'} ${inv.number} übertragen (ID ${rid})`);
      } catch (e) {
        fail(job, e, inv);
      }
    }

    const busy = new Set<string>();
    /** Works through the due jobs of a sub-account, oldest first (a credit note after its invoice). One run per sub-account at a time. */
    async function runLocation(loc: string, limit = 25): Promise<number> {
      if (busy.has(loc)) return 0;
      busy.add(loc);
      let n = 0;
      try {
        const seen = new Set<string>();
        while (n < limit) {
          const job = db.get<Job>(`SELECT * FROM books_sync_jobs WHERE location_id = ? AND status IN ('pending', 'retry') AND next_at <= ? ORDER BY created_at, rowid LIMIT 1`, loc, now());
          if (!job || seen.has(job.id)) break;
          seen.add(job.id);
          const claimed = db.run(`UPDATE books_sync_jobs SET status = 'running', locked_until = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'retry')`, new Date(Date.now() + LOCK_MS).toISOString(), now(), job.id).changes;
          if (!claimed) continue;
          await runJob(job);
          n++;
        }
      } finally {
        busy.delete(loc);
      }
      return n;
    }

    /** Payment status of open linked invoices; what the tool has received more than HyperLevel knows becomes a payment here. */
    async function pullPayments(loc: string, limit = 25): Promise<{ checked: number; updated: number }> {
      const s = settings(loc);
      if (!active(s) || !s.options.pull_payments) return { checked: 0, updated: 0 };
      const label = PROVIDER_LABEL[s.provider];
      const rows = db.all<Job>(
        `SELECT j.* FROM books_sync_jobs j JOIN invoices i ON i.id = j.invoice_id
         WHERE j.location_id = ? AND j.provider = ? AND j.status = 'done' AND j.remote_id != '' AND i.kind = 'invoice' AND i.status = 'sent'
         ORDER BY COALESCE(j.checked_at, '') LIMIT ?`,
        loc, s.provider, limit,
      );
      const client = clientOf(s);
      let updated = 0;
      for (const j of rows) {
        const inv = loadInvoice(app, loc, j.invoice_id);
        if (!inv) continue;
        try {
          const booked = j.remote_total_cents || inv.total_cents - (inv.deducted_cents ?? 0);
          const st = s.provider === 'lexware' ? lexPaid(await lexApi(client).payments(j.remote_id), booked) : sevPaid(await sevApi(client).invoice(j.remote_id), booked);
          const delta = Math.min(st.paidCents - (inv.paid_cents ?? 0), openCents(inv));
          if (delta > 0) {
            const paidAt = st.paidAt && !Number.isNaN(Date.parse(st.paidAt)) && Date.parse(st.paidAt) <= Date.now() ? new Date(st.paidAt).toISOString() : undefined;
            const r = recordPayment(app, loc, inv.id, { amount_cents: delta, paid_at: paidAt, method: label, note: `Zahlungseingang aus ${label} übernommen` }, { id: null, name: label }, { source: s.provider, via: label });
            updated++;
            log(loc, s.provider, 'info', 'payment', `Rechnung ${inv.number}: ${r.paid ? 'bezahlt' : 'Teilzahlung'} laut ${label} (${(delta / 100).toFixed(2).replace('.', ',')} ${inv.currency})`, inv.id);
          }
          if (st.settled || delta > 0) db.run(`UPDATE invoice_links SET status = ?, synced_at = ? WHERE invoice_id = ? AND provider = ?`, st.settled ? 'paid' : 'sent', now(), inv.id, s.provider);
        } catch (e) {
          log(loc, s.provider, 'error', 'payment', `Rechnung ${inv.number}: Zahlungsstatus nicht abrufbar – ${(e as Error).message}`, inv.id);
        }
        db.run('UPDATE books_sync_jobs SET checked_at = ? WHERE id = ?', now(), j.id);
      }
      db.run('UPDATE books_sync_settings SET last_pull_at = ? WHERE location_id = ?', now(), loc);
      return { checked: rows.length, updated };
    }

    app.services.booksSync = { enqueue, run: runLocation, pull: pullPayments, settings: (loc: string) => view(loc) };

    // Every finalised invoice / credit note (also Storno documents and adopted stragglers) goes to the connected tool.
    app.events.on('invoice.finalised', async (e) => {
      const inv = e.data?.invoice;
      if (!inv?.id || inv.kind === 'estimate') return;
      const s = settings(e.locationId);
      if (!active(s)) return;
      if (inv.kind === 'credit_note' && !s.options.push_credit_notes) return;
      enqueue(e.locationId, inv.id, s.provider);
      await runLocation(e.locationId);
    });

    let ticking = false;
    app.onTick(async () => {
      if (ticking) return;
      ticking = true;
      try {
        // A run that died half-way (restart) is picked up again; the remote lookup by number prevents a second document.
        db.run(`UPDATE books_sync_jobs SET status = 'retry', locked_until = NULL WHERE status = 'running' AND locked_until < ?`, now());
        for (const d of db.all<{ location_id: string }>(`SELECT DISTINCT location_id FROM books_sync_jobs WHERE status IN ('pending', 'retry') AND next_at <= ? LIMIT 50`, now())) {
          await runLocation(d.location_id).catch((err) => console.warn('[books-sync] run', d.location_id, (err as Error).message));
        }
        const due = db.all<{ location_id: string }>(
          `SELECT location_id FROM books_sync_settings WHERE enabled = 1 AND provider != '' AND secret_sealed != '' AND (last_pull_at IS NULL OR last_pull_at < ?) ORDER BY COALESCE(last_pull_at, '') LIMIT 20`,
          new Date(Date.now() - PULL_EVERY_MS).toISOString(),
        );
        for (const d of due) await pullPayments(d.location_id).catch((err) => console.warn('[books-sync] pull', d.location_id, (err as Error).message));
      } finally {
        ticking = false;
      }
    });

    // --- routes ---------------------------------------------------------------------------------------------------------------
    router.get('/api/books-sync', 'location', (ctx) => view(ctx.locationId));

    router.put('/api/books-sync', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const cur = settings(ctx.locationId);
      const provider = b.provider === undefined ? (cur?.provider ?? '') : String(b.provider ?? '');
      if (provider && !isProvider(provider)) throw bad('Unbekanntes Programm – lexware oder sevdesk');
      if (!provider) throw bad('Bitte Lexware Office oder sevDesk wählen');
      let options: SyncOptions;
      try {
        options = cleanOptions(b.options ?? {}, cur?.options ?? {});
      } catch (e) {
        throw bad((e as Error).message);
      }
      const key = str(b.api_key, 'API-Schlüssel', { max: 300 });
      if (key && !/^[A-Za-z0-9._~+/=-]{16,300}$/.test(key)) throw bad('Der API-Schlüssel sieht nicht richtig aus (ohne Leerzeichen einfügen)');
      const changedProvider = !!cur?.provider && cur.provider !== provider;
      if (changedProvider && !key) throw bad(`Für ${PROVIDER_LABEL[provider as Provider]} bitte den API-Schlüssel eingeben`);
      const sealed = key ? sealSecret(app, key) : (cur?.row.secret_sealed ?? '');
      if (!sealed) throw bad('API-Schlüssel fehlt');
      const hint = key ? `…${key.slice(-4)}` : (cur?.hint ?? '');
      const enabled = b.enabled === undefined ? (cur ? cur.enabled : true) : !!b.enabled;
      const t = now();
      db.run(
        `INSERT INTO books_sync_settings (location_id, provider, enabled, secret_sealed, hint, options, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(location_id) DO UPDATE SET provider = excluded.provider, enabled = excluded.enabled, secret_sealed = excluded.secret_sealed, hint = excluded.hint, options = excluded.options, updated_at = excluded.updated_at
           ${key || changedProvider ? `, last_test_at = NULL, last_test_ok = NULL, last_test_result = ''` : ''}`,
        ctx.locationId, provider, enabled ? 1 : 0, sealed, hint, JSON.stringify(options), t,
      );
      // Jobs of the tool that was replaced stop here (nothing goes to two programs).
      if (changedProvider) db.run(`UPDATE books_sync_jobs SET status = 'skipped', last_error = 'Programm gewechselt', updated_at = ? WHERE location_id = ? AND provider != ? AND status IN ('pending', 'retry')`, t, ctx.locationId, provider);
      return view(ctx.locationId);
    });

    router.delete('/api/books-sync', 'location', (ctx) => {
      const t = now();
      db.run(`UPDATE books_sync_settings SET secret_sealed = '', hint = '', enabled = 0, last_test_at = NULL, last_test_ok = NULL, last_test_result = '', updated_at = ? WHERE location_id = ?`, t, ctx.locationId);
      db.run(`UPDATE books_sync_jobs SET status = 'skipped', last_error = 'Verbindung getrennt', updated_at = ? WHERE location_id = ? AND status IN ('pending', 'retry')`, t, ctx.locationId);
      db.run('DELETE FROM books_sync_contacts WHERE location_id = ?', ctx.locationId);
      return view(ctx.locationId);
    });

    router.post('/api/books-sync/test', 'location', async (ctx) => {
      const s = settings(ctx.locationId);
      if (!s?.provider || !s.apiKey) throw new HttpError(409, 'Erst Programm und API-Schlüssel speichern.');
      const client = new BooksClient(deps(), s.provider, s.apiKey);
      let ok = true;
      let detail = '';
      try {
        if (s.provider === 'lexware') {
          const p = await lexApi(client).profile();
          detail = `Verbunden mit ${String(p?.companyName ?? p?.organizationName ?? 'Lexware Office').slice(0, 100)}`;
        } else {
          const users = await sevApi(client).users();
          if (!users.length) throw new Error('sevDesk: kein Benutzer gefunden');
          const u = users.find((x) => String(x.id) === s.options.sev_user_id) ?? users[0];
          if (!s.options.sev_user_id) saveOptions(ctx.locationId, { ...s.options, sev_user_id: String(u.id) });
          detail = `Verbunden – Ansprechpartner auf Rechnungen: ${String([u.firstName ?? u.fullname ?? '', u.lastName ?? ''].join(' ').trim() || u.username || u.id).slice(0, 80)}`;
        }
      } catch (e) {
        ok = false;
        detail = (e as Error).message;
      }
      db.run('UPDATE books_sync_settings SET last_test_at = ?, last_test_ok = ?, last_test_result = ? WHERE location_id = ?', now(), ok ? 1 : 0, detail.slice(0, 300), ctx.locationId);
      if (!ok) throw new HttpError(400, detail);
      return { ok, detail };
    });

    const jobView = (loc: string, where = '', params: string[] = [], limit = 200) =>
      db.all(
        `SELECT j.id, j.invoice_id, j.provider, j.status, j.attempts, j.next_at, j.stage, j.remote_id, j.last_error, j.checked_at, j.created_at, j.updated_at,
                i.number, i.kind, i.credit_type, i.total_cents, i.currency, i.status AS invoice_status
         FROM books_sync_jobs j JOIN invoices i ON i.id = j.invoice_id WHERE j.location_id = ? ${where} ORDER BY j.created_at DESC LIMIT ?`,
        loc, ...params, limit,
      );

    router.get('/api/books-sync/jobs', 'location', (ctx) => {
      const status = ctx.query.get('status');
      return status ? jobView(ctx.locationId, 'AND j.status = ?', [status], clampLimit(ctx.query.get('limit'), 200, 500)) : jobView(ctx.locationId, '', [], clampLimit(ctx.query.get('limit'), 200, 500));
    });
    router.get('/api/books-sync/log', 'location', (ctx) => db.all('SELECT id, invoice_id, provider, level, action, message, created_at FROM books_sync_log WHERE location_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', ctx.locationId, clampLimit(ctx.query.get('limit'), 100, 500)));

    const kick = (loc: string) => void runLocation(loc).catch((e) => console.warn('[books-sync] run', loc, (e as Error).message));

    router.post('/api/books-sync/jobs/:id/retry', 'location', (ctx) => {
      const job = db.get('SELECT * FROM books_sync_jobs WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!job) throw notFound('Auftrag nicht gefunden');
      if (job.status === 'done') throw new HttpError(409, 'Schon übertragen');
      if (job.status === 'running') throw new HttpError(409, 'Läuft gerade');
      db.run(`UPDATE books_sync_jobs SET status = 'pending', attempts = 0, next_at = ?, last_error = '', updated_at = ? WHERE id = ?`, now(), now(), job.id);
      kick(ctx.locationId);
      return jobView(ctx.locationId, 'AND j.id = ?', [job.id], 1)[0];
    });

    router.post('/api/books-sync/invoices/:id/push', 'location', (ctx) => {
      const s = settings(ctx.locationId);
      if (!active(s)) throw new HttpError(409, 'Lexware Office / sevDesk ist nicht verbunden');
      const inv = loadInvoice(app, ctx.locationId, ctx.params.id);
      if (!inv) throw notFound('Rechnung nicht gefunden');
      if (inv.kind === 'estimate' || !inv.finalised_at) throw new HttpError(409, 'Nur festgeschriebene Rechnungen und Gutschriften lassen sich übertragen');
      const job = enqueue(ctx.locationId, inv.id, s.provider, true);
      kick(ctx.locationId);
      return jobView(ctx.locationId, 'AND j.id = ?', [job.id], 1)[0];
    });

    router.post('/api/books-sync/backfill', 'location', (ctx) => {
      const s = settings(ctx.locationId);
      if (!active(s)) throw new HttpError(409, 'Lexware Office / sevDesk ist nicht verbunden');
      const since = String(ctx.body?.since ?? '');
      if (!/^\d{4}-\d\d-\d\d$/.test(since)) throw bad('Ab wann? Datum als JJJJ-MM-TT');
      const kinds = s.options.push_credit_notes ? `('invoice', 'credit_note')` : `('invoice')`;
      const rows = db.all<{ id: string }>(
        `SELECT i.id FROM invoices i WHERE i.location_id = ? AND i.kind IN ${kinds} AND i.finalised_at IS NOT NULL AND i.issued_at >= ?
           AND NOT EXISTS (SELECT 1 FROM invoice_links l WHERE l.invoice_id = i.id)
           AND NOT EXISTS (SELECT 1 FROM books_sync_jobs j WHERE j.invoice_id = i.id AND j.provider = ?)
         ORDER BY i.issued_at, i.number LIMIT 200`,
        ctx.locationId, `${since}T00:00:00.000Z`, s.provider,
      );
      for (const r of rows) enqueue(ctx.locationId, r.id, s.provider);
      if (rows.length) {
        log(ctx.locationId, s.provider, 'info', 'backfill', `${rows.length} ältere Belege ab ${since.split('-').reverse().join('.')} in die Warteschlange gestellt`);
        kick(ctx.locationId);
      }
      return { queued: rows.length };
    });

    router.post('/api/books-sync/pull', 'location', async (ctx: Ctx) => {
      const s = settings(ctx.locationId);
      if (!active(s)) throw new HttpError(409, 'Lexware Office / sevDesk ist nicht verbunden');
      if (!s.options.pull_payments) throw new HttpError(409, 'Zahlungsabgleich ist in den Einstellungen aus');
      return pullPayments(ctx.locationId, 100);
    });

    // --- catalogue ------------------------------------------------------------------------------------------------------------
    const probe = (provider: Provider) => (_ctx: Ctx, loc: string) => {
      const s = settings(loc);
      if (!s?.apiKey || s.provider !== provider) return { status: 'missing', detail: 'Nicht verbunden' };
      if (!s.enabled) return { status: 'info', detail: 'Pausiert' };
      const failed = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM books_sync_jobs WHERE location_id = ? AND status = 'failed'`, loc)!.n;
      if (failed) return { status: 'partial', detail: `${failed} Beleg(e) mit Fehler` };
      if (s.row.last_test_ok === 0) return { status: 'partial', detail: `Test fehlgeschlagen: ${String(s.row.last_test_result).slice(0, 80)}` };
      return { status: 'ok', detail: 'Verbunden – Rechnungen werden übertragen' };
    };
    app.services.catalogExtra = [
      ...(app.services.catalogExtra ?? []),
      ...PROVIDERS.map((p) => ({
        entry: {
          key: `books_${p}`,
          name: `${PROVIDER_LABEL[p]} (Live-Sync)`,
          category: 'Zahlungen',
          icon: 'invoices',
          scope: 'location' as const,
          setup: { location: 'apps/books' },
          description: 'Festgeschriebene Rechnungen und Gutschriften automatisch übertragen (Kontakt, Positionen, Steuersätze' + (p === 'lexware' ? ', PDF' : '') + '), Zahlungseingänge zurückholen.',
          credentials: `${KEY_HELP[p].label} unter Apps → Buchhaltung.`,
          docs: 'docs/integrations.md#lexware-office-and-sevdesk-live-sync',
        },
        location: probe(p),
      })),
    ];
  },
};
