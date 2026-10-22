import type { App, Module } from '../core/app.js';
import { bad, clampLimit, type Ctx, type RawResult } from '../core/http.js';
import { deDate } from '../services/creator-kit.js';
import { actorOf } from '../services/invoice-flow.js';
import { sendToContact } from '../services/messaging.js';
import { callRoute } from '../services/route-call.js';
import {
  captureUrl,
  createMandate,
  creditorOf,
  endMandate,
  mandateOut,
  mustMandate,
  patchMandate,
  reactivateMandate,
  renewLink,
  requestMandate,
  saveSettings,
  settingsOf,
  todayOf,
  expireSweep,
  type MandateRow,
} from '../services/sepa-mandates.js';
import { DEFAULT_SETTINGS, RETURN_CODES, earliestCollection, maskIban } from '../services/sepa-model.js';
import { cancelRun, candidateOut, candidates, createRun, createTransfer, markPaid, markReturned, markRunPaid, mustRun, payables, planRun, renotify, runOut, settleByInvoice, submitRun, type RunRow } from '../services/sepa-runs.js';
import { registerTriggers } from '../services/wfx-kit.js';
import { sepaPublicModule } from './sepa-public.js';
import { sepaToolsModule } from './sepa-tools.js';

/**
 * SEPA without Stripe (docs/sepa.md): direct-debit mandates per contact (paper or online with proof), collection runs as
 * pain.008.001.08 with pre-notification, paid / returned collections through the invoice flow, and pain.001.001.09 transfer
 * batches for open supplier invoices or a manual payout list. Routes under /api/sepa (permission area "payments"); the public
 * mandate page lives in sepa-public.ts, the MCP tools in sepa-tools.ts. No bank is ever called – files are uploaded by hand.
 */

const SQL = `
CREATE TABLE sepa_settings (
  location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', ref_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE sepa_mandates (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  reference TEXT NOT NULL, scheme TEXT NOT NULL DEFAULT 'CORE', kind TEXT NOT NULL DEFAULT 'RCUR', status TEXT NOT NULL DEFAULT 'pending',
  holder TEXT NOT NULL DEFAULT '', iban TEXT NOT NULL DEFAULT '', bic TEXT NOT NULL DEFAULT '', street TEXT NOT NULL DEFAULT '', postal_code TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', signed_at TEXT, signed_place TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'paper',
  capture_token TEXT UNIQUE, capture_expires_at TEXT, text TEXT NOT NULL DEFAULT '', text_hash TEXT NOT NULL DEFAULT '', proof TEXT NOT NULL DEFAULT '{}',
  final_next INTEGER NOT NULL DEFAULT 0, first_used_at TEXT, last_used_at TEXT, ended_at TEXT, end_reason TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(location_id, reference)
);
CREATE INDEX sepa_mandates_loc ON sepa_mandates(location_id, status, created_at);
CREATE INDEX sepa_mandates_contact ON sepa_mandates(contact_id);
CREATE INDEX sepa_mandates_status ON sepa_mandates(status);
CREATE TABLE sepa_runs (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'debit', status TEXT NOT NULL DEFAULT 'draft',
  exec_date TEXT NOT NULL, msg_id TEXT NOT NULL, tx_count INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0, xml TEXT, xml_sha256 TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'invoices', note TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL, submitted_at TEXT, closed_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX sepa_runs_loc ON sepa_runs(location_id, created_at);
CREATE TABLE sepa_items (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES sepa_runs(id) ON DELETE CASCADE, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  invoice_id TEXT, receipt_id TEXT, mandate_id TEXT, contact_id TEXT, name TEXT NOT NULL DEFAULT '', iban TEXT NOT NULL DEFAULT '', bic TEXT NOT NULL DEFAULT '',
  street TEXT NOT NULL DEFAULT '', postal_code TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
  end_to_end TEXT NOT NULL, remittance TEXT NOT NULL DEFAULT '', amount_cents INTEGER NOT NULL, seq TEXT NOT NULL DEFAULT '', scheme TEXT NOT NULL DEFAULT '',
  mandate_ref TEXT NOT NULL DEFAULT '', mandate_date TEXT, status TEXT NOT NULL DEFAULT 'draft', notify_status TEXT NOT NULL DEFAULT '', notified_at TEXT,
  notify_error TEXT NOT NULL DEFAULT '', payment_id TEXT, paid_at TEXT, returned_at TEXT, return_code TEXT NOT NULL DEFAULT '', return_note TEXT NOT NULL DEFAULT '',
  fee_cents INTEGER NOT NULL DEFAULT 0, fee_invoice_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX sepa_items_run ON sepa_items(run_id);
CREATE INDEX sepa_items_loc ON sepa_items(location_id, status);
CREATE INDEX sepa_items_invoice ON sepa_items(invoice_id, status);
CREATE INDEX sepa_items_mandate ON sepa_items(mandate_id, status);
CREATE INDEX sepa_items_receipt ON sepa_items(receipt_id, status);
CREATE INDEX sepa_items_contact ON sepa_items(contact_id);
`;

/** Reason of the Mahnstopp the module sets while a collection is with the bank (lifted again on return or withdrawal). */
const HOLD_REASON = 'SEPA-Lastschrift eingereicht';

export const sepaModule: Module = {
  name: 'sepa',
  migrations: [['001-init', SQL]],
  register(app: App) {
    const { db, router } = app;
    const uid = (ctx: Ctx) => ctx.user?.id ?? null;
    const hasTable = (name: string) => !!db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

    // --- dunning: no reminders while a collection is under way (through the dunning route, when the module is there) ----------
    const hold = async (ctx: Ctx, invoiceIds: string[], on: boolean) => {
      if (!invoiceIds.length || !app.router.match('POST', '/api/dunning/invoices/x/hold') || !hasTable('dunning_holds')) return;
      for (const iid of invoiceIds) {
        const cur = db.get<{ reason: string }>('SELECT reason FROM dunning_holds WHERE invoice_id = ? AND location_id = ?', iid, ctx.locationId);
        if (on ? cur : !cur?.reason.startsWith(HOLD_REASON)) continue; // never replace or lift a hold someone set by hand
        try {
          await callRoute(app, ctx, 'POST', `/api/dunning/invoices/${encodeURIComponent(iid)}/hold`, { on, reason: HOLD_REASON });
        } catch (e) {
          console.error('[sepa] Mahnstopp', (e as Error).message);
        }
      }
    };

    const listMandates = (loc: string, q: URLSearchParams) => {
      const where = ['m.location_id = ?'];
      const params: (string | number)[] = [loc];
      const status = q.get('status');
      if (status === 'ended') where.push(`m.status IN ('revoked', 'expired', 'used', 'final')`);
      else if (status && /^[a-z]+$/.test(status)) (where.push('m.status = ?'), params.push(status));
      const contact = q.get('contact_id');
      if (contact) (where.push('m.contact_id = ?'), params.push(contact));
      const s = (q.get('q') ?? '').trim().toLowerCase();
      if (s) {
        where.push(`(lower(m.reference) LIKE ? OR lower(m.holder) LIKE ? OR lower(c.first_name || ' ' || c.last_name) LIKE ? OR lower(c.company) LIKE ? OR lower(c.email) LIKE ?)`);
        params.push(...Array(5).fill(`%${s}%`));
      }
      const today = todayOf(app, loc);
      const used = new Set(db.all<{ mandate_id: string }>(`SELECT DISTINCT mandate_id FROM sepa_items WHERE location_id = ? AND status IN ('submitted', 'paid') AND mandate_id IS NOT NULL`, loc).map((r) => r.mandate_id));
      return db
        .all<MandateRow & { c_first: string; c_last: string; c_company: string; c_email: string }>(
          `SELECT m.*, c.first_name AS c_first, c.last_name AS c_last, c.company AS c_company, c.email AS c_email FROM sepa_mandates m LEFT JOIN contacts c ON c.id = m.contact_id
            WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT ?`,
          ...params,
          clampLimit(q.get('limit'), 300, 1000),
        )
        .map((m) => mandateOut(app, m, { today, used: used.has(m.id), contact: m.contact_id && (m.c_first || m.c_last || m.c_company || m.c_email) ? { first_name: m.c_first, last_name: m.c_last, company: m.c_company, email: m.c_email } : null }));
    };

    const sendLink = async (loc: string, m: MandateRow) => {
      if (!m.contact_id || !m.capture_token) return { sent: false, error: 'Kein Kontakt' };
      const cr = creditorOf(app, loc);
      const L = app.location(loc)!;
      const c = db.get<{ first_name: string; email: string }>('SELECT first_name, email FROM contacts WHERE id = ? AND location_id = ?', m.contact_id, loc);
      if (!c?.email) return { sent: false, error: 'Der Kontakt hat keine E-Mail-Adresse – bitte den Link selbst weitergeben' };
      const body = `Hallo${c.first_name ? ` ${c.first_name}` : ''},\n\n${cr.name || L.name} bittet dich um ein SEPA-Lastschriftmandat (Mandatsreferenz ${m.reference}). Über diesen Link liest du den Mandatstext, trägst dein Konto ein und bestätigst:\n\n${captureUrl(app, m.capture_token)}\n\nDer Link gilt bis ${deDate(m.capture_expires_at, L.timezone || 'Europe/Berlin')}.\n\nViele Grüße\n${L.name}`;
      try {
        const r = await sendToContact(app, loc, { contactId: m.contact_id, channel: 'email', subject: `Bitte SEPA-Lastschriftmandat erteilen – ${cr.name || L.name}`, body, source: 'SEPA-Mandat', ignoreDnd: true, purpose: 'transactional' });
        return r.status === 'failed' ? { sent: false, error: String(r.error ?? 'Versand fehlgeschlagen') } : { sent: true };
      } catch (e) {
        return { sent: false, error: (e as Error).message };
      }
    };

    // --- overview and settings ----------------------------------------------------------------------------------------------------
    router.get('/api/sepa/overview', 'location', (ctx) => {
      const loc = ctx.locationId;
      const s = settingsOf(app, loc);
      const cr = creditorOf(app, loc, s);
      const m = Object.fromEntries(db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM sepa_mandates WHERE location_id = ? GROUP BY status', loc).map((r) => [r.status, r.n]));
      const runs = Object.fromEntries(db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM sepa_runs WHERE location_id = ? AND kind = 'debit' GROUP BY status`, loc).map((r) => [r.status, r.n]));
      const open = db.get<{ n: number; c: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c FROM sepa_items WHERE location_id = ? AND status = 'submitted' AND invoice_id IS NOT NULL`, loc)!;
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const returns = db.get<{ n: number; c: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c FROM sepa_items WHERE location_id = ? AND status = 'returned' AND returned_at >= ?`, loc, since)!;
      const cands = candidates(app, loc);
      return {
        ready: !cr.problems.length,
        problems: cr.problems,
        creditor: { name: cr.name, creditor_id: cr.creditor_id, iban_masked: maskIban(cr.iban) },
        mandates: { active: m.active ?? 0, pending: m.pending ?? 0, suspended: m.suspended ?? 0, ended: (m.revoked ?? 0) + (m.expired ?? 0) + (m.used ?? 0) + (m.final ?? 0) },
        candidates: { count: cands.filter((c) => c.ok).length, total_cents: cands.filter((c) => c.ok).reduce((n, c) => n + c.open_cents, 0) },
        runs: { draft: runs.draft ?? 0, submitted: runs.submitted ?? 0 },
        submitted_open: { count: open.n, total_cents: open.c },
        returns_30d: { count: returns.n, total_cents: returns.c },
        prenotify_days: s.prenotify_days,
        earliest: earliestCollection(todayOf(app, loc), s.prenotify_days),
      };
    });
    router.get('/api/sepa/settings', 'location', (ctx) => {
      const s = settingsOf(app, ctx.locationId);
      const cr = creditorOf(app, ctx.locationId, s);
      return { settings: s, defaults: DEFAULT_SETTINGS, creditor: { name: cr.name, address: cr.address, creditor_id: cr.creditor_id, iban: cr.iban, bic: cr.bic, problems: cr.problems }, return_codes: RETURN_CODES };
    });
    router.put('/api/sepa/settings', 'location', (ctx) => ({ settings: saveSettings(app, ctx.locationId, ctx.body ?? {}) }));

    // --- mandates -------------------------------------------------------------------------------------------------------------
    router.get('/api/sepa/mandates', 'location', (ctx) => listMandates(ctx.locationId, ctx.query));
    router.post('/api/sepa/mandates', 'location', (ctx) => mandateOut(app, createMandate(app, ctx.locationId, ctx.body ?? {}, uid(ctx)), { full: true }));
    router.post('/api/sepa/mandates/request', 'location', async (ctx) => {
      const m = requestMandate(app, ctx.locationId, ctx.body ?? {}, uid(ctx));
      const mail = ctx.body?.send ? await sendLink(ctx.locationId, m) : null;
      return { ...mandateOut(app, m, { full: true }), mail };
    });
    router.get('/api/sepa/mandates/:id', 'location', (ctx) => {
      const m = mustMandate(app, ctx.locationId, ctx.params.id);
      const items = db.all<any>(
        `SELECT s.id, s.run_id, s.invoice_id, s.amount_cents, s.seq, s.status, s.return_code, s.paid_at, s.returned_at, r.exec_date, i.number AS invoice_number
           FROM sepa_items s JOIN sepa_runs r ON r.id = s.run_id LEFT JOIN invoices i ON i.id = s.invoice_id WHERE s.mandate_id = ? AND s.location_id = ? ORDER BY r.exec_date DESC LIMIT 200`,
        m.id,
        ctx.locationId,
      );
      return { ...mandateOut(app, m, { full: true }), collections: items };
    });
    router.patch('/api/sepa/mandates/:id', 'location', (ctx) => mandateOut(app, patchMandate(app, ctx.locationId, ctx.params.id, ctx.body ?? {}), { full: true }));
    router.post('/api/sepa/mandates/:id/revoke', 'location', (ctx) => {
      const reason = String(ctx.body?.reason ?? '').trim();
      return mandateOut(app, endMandate(app, ctx.locationId, ctx.params.id, 'revoked', reason || 'Widerrufen'), { full: true });
    });
    router.post('/api/sepa/mandates/:id/reactivate', 'location', (ctx) => mandateOut(app, reactivateMandate(app, ctx.locationId, ctx.params.id), { full: true }));
    router.post('/api/sepa/mandates/:id/link', 'location', async (ctx) => {
      const m = renewLink(app, ctx.locationId, ctx.params.id);
      const mail = ctx.body?.send ? await sendLink(ctx.locationId, m) : null;
      return { ...mandateOut(app, m, { full: true }), mail };
    });

    // --- collection runs ----------------------------------------------------------------------------------------------------------
    router.get('/api/sepa/candidates', 'location', (ctx) => {
      const s = settingsOf(app, ctx.locationId);
      return { earliest: earliestCollection(todayOf(app, ctx.locationId), s.prenotify_days), prenotify_days: s.prenotify_days, items: candidates(app, ctx.locationId).map(candidateOut) };
    });
    router.post('/api/sepa/runs/preview', 'location', (ctx) => {
      const p = planRun(app, ctx.locationId, ctx.body ?? {});
      return { ...p, ok: !p.errors.length, rows: p.rows.map(candidateOut) };
    });
    router.post('/api/sepa/runs', 'location', async (ctx) => runOut(app, await createRun(app, ctx.locationId, ctx.body ?? {}, uid(ctx)), true));
    router.get('/api/sepa/runs', 'location', (ctx) => {
      const kind = ctx.query.get('kind');
      return db
        .all<RunRow>(`SELECT * FROM sepa_runs WHERE location_id = ?${kind === 'debit' || kind === 'transfer' ? ' AND kind = ?' : ''} ORDER BY created_at DESC LIMIT ?`, ctx.locationId, ...(kind === 'debit' || kind === 'transfer' ? [kind] : []), clampLimit(ctx.query.get('limit'), 100, 500))
        .map((r) => runOut(app, r));
    });
    router.get('/api/sepa/runs/:id', 'location', (ctx) => runOut(app, mustRun(app, ctx.locationId, ctx.params.id), true));
    router.get('/api/sepa/runs/:id/xml', 'location', (ctx): RawResult => {
      const run = mustRun(app, ctx.locationId, ctx.params.id);
      if (!run.xml) throw bad('Die Datei entsteht beim Einreichen – bitte den Lauf zuerst einreichen');
      const name = `SEPA-${run.kind === 'debit' ? 'Lastschrift' : 'Ueberweisung'}-${run.exec_date}-${run.msg_id.slice(-6)}.xml`;
      return { __raw: true, status: 200, headers: { 'content-type': 'application/xml; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: run.xml };
    });
    router.post('/api/sepa/runs/:id/submit', 'location', async (ctx) => {
      const r = submitRun(app, ctx.locationId, ctx.params.id, actorOf(ctx));
      await hold(ctx, r.invoices, true);
      return { ...runOut(app, r.run, true), dropped: r.dropped };
    });
    router.post('/api/sepa/runs/:id/notify', 'location', async (ctx) => runOut(app, await renotify(app, ctx.locationId, ctx.params.id), true));
    router.post('/api/sepa/runs/:id/cancel', 'location', async (ctx) => {
      const r = cancelRun(app, ctx.locationId, ctx.params.id, actorOf(ctx), String(ctx.body?.reason ?? ''));
      await hold(ctx, r.invoices, false);
      return runOut(app, r.run, true);
    });
    router.post('/api/sepa/runs/:id/paid', 'location', (ctx) => {
      const r = markRunPaid(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, actorOf(ctx));
      return { ...runOut(app, mustRun(app, ctx.locationId, ctx.params.id), true), paid: r.paid, failed: r.failed };
    });
    router.post('/api/sepa/items/:id/paid', 'location', (ctx) => {
      const it = markPaid(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, actorOf(ctx));
      return runOut(app, mustRun(app, ctx.locationId, it.run_id), true);
    });
    router.post('/api/sepa/items/:id/return', 'location', async (ctx) => {
      const r = markReturned(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, actorOf(ctx));
      if (r.item.invoice_id) await hold(ctx, [r.item.invoice_id], false);
      return { ...runOut(app, mustRun(app, ctx.locationId, r.item.run_id), true), fee_invoice_id: r.fee_invoice_id };
    });

    // --- transfers ----------------------------------------------------------------------------------------------------------------
    router.get('/api/sepa/payables', 'location', (ctx) => payables(app, ctx.locationId));
    router.post('/api/sepa/transfers', 'location', (ctx) => runOut(app, createTransfer(app, ctx.locationId, ctx.body ?? {}, uid(ctx)), true));

    // --- hooks ----------------------------------------------------------------------------------------------------------------------
    // A collection that got paid another way (bank match, by hand) is settled, so its run can close.
    app.events.on('invoice.paid', (e) => {
      const inv = e.data?.invoice;
      if (inv?.id) settleByInvoice(app, e.locationId, inv.id);
    });

    let swept = '';
    app.onTick(() => {
      const day = new Date().toISOString().slice(0, 10);
      if (day === swept) return;
      swept = day;
      expireSweep(app, day);
    });

    registerTriggers(app, [
      {
        type: 'sepa.mandate_signed',
        label: 'SEPA-Mandat erteilt',
        category: 'payments',
        summary: 'Ein SEPA-Lastschriftmandat wurde erfasst oder online erteilt.',
        doc: '{{event.mandate.reference}}, {{event.mandate.scheme}} (CORE/B2B), {{event.mandate.kind}} (RCUR/OOFF) und {{event.mandate.source}} (paper/online) stehen bereit – z. B. für eine Willkommens-Mail oder ein Tag „Lastschrift“.',
        fields: [],
        sample: { mandate: { id: 'm1', reference: 'M-2026-000001', scheme: 'CORE', kind: 'RCUR', source: 'online' } },
        keywords: 'sepa lastschrift mandat einzug bankeinzug',
      },
      {
        type: 'sepa.returned',
        label: 'SEPA-Lastschrift zurückgegeben',
        category: 'payments',
        summary: 'Eine Lastschrift kam zurück (Rücklastschrift) – die Rechnung ist wieder offen.',
        doc: '{{event.code}} (z. B. AM04), {{event.label}}, {{event.amount_cents}}, {{event.fee_cents}} und {{event.invoice.number}} stehen bereit – z. B. für eine Aufgabe „Kunde anrufen“.',
        fields: [],
        sample: { invoice: { id: 'i1', number: 'RE-1001', total_cents: 11900 }, code: 'AM04', label: 'Keine ausreichende Deckung', amount_cents: 11900, fee_cents: 300, mandate_ref: 'M-2026-000001' },
        keywords: 'sepa rücklastschrift lastschrift zurück deckung widerspruch',
      },
    ]);

    // DSGVO: collections and mandates that were used are payment records (kept, without the link to the contact); unused ones go.
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, loc: string, contact: { id: string }) => {
        db.run(`DELETE FROM sepa_mandates WHERE location_id = ? AND contact_id = ? AND NOT EXISTS (SELECT 1 FROM sepa_items s WHERE s.mandate_id = sepa_mandates.id)`, loc, contact.id);
        db.run(`UPDATE sepa_mandates SET contact_id = NULL, capture_token = NULL WHERE location_id = ? AND contact_id = ?`, loc, contact.id);
        db.run('UPDATE sepa_items SET contact_id = NULL WHERE location_id = ? AND contact_id = ?', loc, contact.id);
      },
    ];
    app.services.privacyExport = [
      ...(app.services.privacyExport ?? []),
      (_a: App, loc: string, contact: { id: string }) => {
        const rows = db.all<any>('SELECT reference, scheme, kind, status, holder, iban, bic, signed_at, signed_place, source, text, proof, last_used_at, ended_at, end_reason FROM sepa_mandates WHERE location_id = ? AND contact_id = ?', loc, contact.id);
        const items = db.all<any>(`SELECT s.end_to_end, s.amount_cents, s.seq, s.status, s.return_code, r.exec_date FROM sepa_items s JOIN sepa_runs r ON r.id = s.run_id WHERE s.location_id = ? AND s.contact_id = ?`, loc, contact.id);
        return { ...(rows.length ? { 'SEPA-Mandate': rows } : {}), ...(items.length ? { 'SEPA-Lastschriften': items } : {}) };
      },
    ];
  },
};

/** One registry line in modules/index.ts: the API, the public mandate page, the MCP tools. */
export const sepaModules: Module[] = [sepaModule, sepaPublicModule, sepaToolsModule];
