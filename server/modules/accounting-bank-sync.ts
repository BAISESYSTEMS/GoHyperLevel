import { SESSION_COOKIE, type App, type Module } from '../core/app.js';
import { HttpError, bad, html, notFound, redirect, type Ctx, type User } from '../core/http.js';
import { messagePage } from '../core/page.js';
import { openSecret, sealSecret } from '../core/secrets.js';
import { id, now, sha256, token } from '../core/util.js';
import { requireEnabled, trail } from '../services/acc-ledger.js';
import {
  BankSyncError,
  FIRST_SYNC_DAYS,
  MAX_CONSENT_DAYS,
  accountIban,
  addDays,
  checkPrivateKey,
  ebClient,
  isAppId,
  isoDay,
  mapTransaction,
  pickBalance,
  psuHeaders,
  syncKeys,
  type EbAspsp,
  type EbCreds,
  type SyncedTxn,
} from '../services/bank-sync.js';
import { STATE_TTL_MS, signState, verifyState, type Purpose, type StatePayload } from '../services/oauth.js';
import { actor } from './accounting.js';
import { insertBankTxns, rematchBank } from './accounting-bank.js';
import { canManageLocation } from './oauth-connect.js';
import { writeAudit } from './security.js';

/**
 * Bank sync for the accounting (Buchhaltung → Bank): a sub-account connects its business account through Enable Banking
 * (PSD2, read only) and the booked transactions arrive by themselves – every 8 hours and on „Jetzt abrufen“ – into the same
 * list as imported statements, where they are matched with open invoices and receipts. The agency registers the Enable
 * Banking application once (ID + private key); the consent at the bank lasts up to 180 days, then the bank is connected again.
 */

const AGENCY_KEY = 'bank_sync';
const RETURN_TO = '/app/accounting/bank';
export const SYNC_EVERY_MS = 8 * 3600_000;
const RETRY_AFTER_MS = 2 * 3600_000;
const MASK = '••••••••';

export const bankRedirectUri = (origin: string) => `${origin}/oauth/bank/enablebanking/callback`;

interface ConnRow {
  id: string;
  location_id: string;
  session: string;
  aspsp_name: string;
  aspsp_country: string;
  psu_type: string;
  valid_until: string;
  status: string;
  last_error: string | null;
  last_sync_at: string | null;
  next_sync_at: string | null;
  created_at: string;
}
interface AccRow {
  id: string;
  connection_id: string;
  location_id: string;
  uid: string;
  iban: string;
  name: string;
  currency: string;
  enabled: number;
  synced_from: string;
  last_booking_date: string | null;
  balance_cents: number | null;
  balance_currency: string | null;
  balance_at: string | null;
  last_sync_at: string | null;
}

// --- agency credentials ---------------------------------------------------------------------------------------------

function savedAgency(app: App): Record<string, string> {
  const row = app.db.get<{ value: string }>('SELECT value FROM agency_settings WHERE key = ?', AGENCY_KEY);
  try {
    return row ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}

/** The agency's Enable Banking application, or null while it is not set up. */
export function bankSyncCreds(app: App): EbCreds | null {
  const s = savedAgency(app);
  const appId = s.app_id || process.env.PGHL_ENABLEBANKING_APP_ID || '';
  let privateKey = process.env.PGHL_ENABLEBANKING_PRIVATE_KEY || '';
  if (s.private_key) {
    try {
      privateKey = openSecret(app, s.private_key);
    } catch {
      privateKey = ''; // the server's data key changed: the key has to be entered again
    }
  }
  return appId && privateKey ? { appId, privateKey } : null;
}

function saveAgency(app: App, patch: Record<string, string | null>) {
  const next: Record<string, string> = { ...savedAgency(app) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') delete next[k];
    else next[k] = k === 'private_key' ? sealSecret(app, v) : v;
  }
  app.db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', AGENCY_KEY, JSON.stringify(next));
}

const fetcherOf = (app: App): typeof fetch => app.services.bankSyncFetch ?? fetch;
const clientOf = (app: App) => {
  const c = bankSyncCreds(app);
  if (!c) throw new HttpError(409, 'Die Agentur hat Enable Banking noch nicht eingerichtet (Buchhaltung → Bank → Bank verbinden → Agentur)');
  return ebClient(fetcherOf(app), c);
};

function origins(app: App): string[] {
  const list = [app.config.baseUrl.replace(/\/$/, '')];
  const pub = app.services.publicBaseUrl?.();
  if (pub) list.push(String(pub).replace(/\/$/, ''));
  return [...new Set(list)];
}

const isHuman = (ctx: Ctx) => ctx.via === 'session' || ctx.via === 'app';
const fullUser = (row: any): User => ({ id: row.id, email: row.email, name: row.name, role: row.role, locations: JSON.parse(row.locations || '[]'), permissions: row.permissions ? JSON.parse(row.permissions) : null });

// --- the list of banks (cached: it changes rarely and every call counts) -----------------------------------------------

const bankCache = new Map<string, { at: number; list: EbAspsp[] }>();
async function banksOf(app: App, country: string): Promise<EbAspsp[]> {
  const hit = bankCache.get(country);
  if (hit && Date.now() - hit.at < 12 * 3600_000) return hit.list;
  const list = (await clientOf(app).aspsps(country)).filter((a) => a && a.name);
  bankCache.set(country, { at: Date.now(), list });
  return list;
}
export const clearBankListCache = () => bankCache.clear();

// --- sync -------------------------------------------------------------------------------------------------------------

const running = new Set<string>();

export interface SyncResult {
  added: number;
  matched: number;
  accounts: number;
}

/**
 * Reads the booked transactions of every switched-on account of one connection since its last booking (10 days overlap:
 * banks book late) and stores the new ones; then the open lines are matched again. `psu` = the account holder is present.
 */
export async function syncConnection(app: App, connId: string, o: { psu?: Record<string, string>; who?: { id: string | null; name: string } } = {}): Promise<SyncResult> {
  const { db } = app;
  const conn = db.get<ConnRow>('SELECT * FROM bank_connections WHERE id = ?', connId);
  if (!conn) throw notFound('Bankverbindung nicht gefunden');
  if (running.has(connId)) throw new HttpError(409, 'Der Abruf läuft gerade schon');
  const loc = conn.location_id;
  const later = (ms: number) => new Date(Date.now() + ms).toISOString();
  if (Date.parse(conn.valid_until) <= Date.now()) {
    db.run(`UPDATE bank_connections SET status = 'expired', last_error = ?, updated_at = ? WHERE id = ?`, 'Die Freigabe bei der Bank ist abgelaufen – bitte die Bank neu verbinden', now(), connId);
    throw bad('Die Freigabe bei der Bank ist abgelaufen – bitte die Bank neu verbinden');
  }
  running.add(connId);
  let added = 0;
  const accounts = db.all<AccRow>('SELECT * FROM bank_connection_accounts WHERE connection_id = ? AND enabled = 1', connId);
  try {
    requireEnabled(app, loc);
    const client = clientOf(app);
    for (const a of accounts) {
      const from = a.last_booking_date && addDays(a.last_booking_date, -10) > a.synced_from ? addDays(a.last_booking_date, -10) : a.synced_from;
      const txns: SyncedTxn[] = [];
      let key: string | undefined;
      let pages = 0;
      do {
        const r = await client.transactions(a.uid, { date_from: from, continuation_key: key }, o.psu);
        for (const t of r.transactions ?? []) {
          const m = mapTransaction(t, a.iban);
          // Some banks ignore date_from: nothing before the start of the sync (that part came from statement files).
          if (m && m.booking_date >= a.synced_from) txns.push(m);
        }
        key = r.continuation_key || undefined;
      } while (key && ++pages < 50);
      const keys = syncKeys(txns, a.iban || a.uid);
      const importId = id();
      let newIds: string[] = [];
      db.tx(() => {
        newIds = insertBankTxns(app, loc, importId, txns.map((txn, i) => ({ txn, key: keys[i] })));
        if (newIds.length) db.insert('acc_bank_imports', { id: importId, location_id: loc, name: `${conn.aspsp_name}${a.iban ? ` ···${a.iban.slice(-4)}` : ''} (Bank-Sync)`.slice(0, 200), format: 'sync', txns: txns.length, new_txns: newIds.length, created_by: o.who?.id ?? null, created_at: now() });
      });
      added += newIds.length;
      let balance: ReturnType<typeof pickBalance> = null;
      try {
        balance = pickBalance((await client.balances(a.uid, o.psu)).balances);
      } catch (e) {
        if (e instanceof BankSyncError && e.code === 'EXPIRED') throw e; // a balance the bank does not give is no reason to stop
      }
      const last = txns.reduce((m, t) => (t.booking_date > m ? t.booking_date : m), a.last_booking_date ?? '');
      db.run(
        'UPDATE bank_connection_accounts SET last_sync_at = ?, last_booking_date = ?, balance_cents = COALESCE(?, balance_cents), balance_currency = COALESCE(?, balance_currency), balance_at = COALESCE(?, balance_at) WHERE id = ?',
        now(), last || null, balance?.cents ?? null, balance?.currency ?? null, balance ? balance.at || now() : null, a.id,
      );
    }
    db.run(`UPDATE bank_connections SET status = 'active', last_error = NULL, last_sync_at = ?, next_sync_at = ?, updated_at = ? WHERE id = ?`, now(), later(SYNC_EVERY_MS), now(), connId);
  } catch (e) {
    const expired = e instanceof BankSyncError && e.code === 'EXPIRED';
    const msg = (e as Error).message.slice(0, 300);
    db.run('UPDATE bank_connections SET status = ?, last_error = ?, next_sync_at = ?, updated_at = ? WHERE id = ?', expired ? 'expired' : conn.status === 'expired' ? 'expired' : 'active', msg, later(e instanceof BankSyncError && e.status === 429 ? SYNC_EVERY_MS : RETRY_AFTER_MS), now(), connId);
    throw e instanceof HttpError ? e : new HttpError(e instanceof BankSyncError && e.status < 500 && e.status !== 401 ? 409 : 502, msg);
  } finally {
    running.delete(connId);
  }
  const matched = added ? rematchBank(app, loc) : 0;
  // The append-only accounting log gets a line when something arrived, not for every empty background run.
  if (added) trail(app, loc, o.who ?? { id: null, name: 'Bank-Sync' }, 'bank.sync', null, `${conn.aspsp_name}: ${added} neue Umsätze, ${matched} zugeordnet`);
  return { added, matched, accounts: accounts.length };
}

// --- module -------------------------------------------------------------------------------------------------------------

export const bankSyncModule: Module = {
  name: 'accounting-bank-sync',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE bank_sync_pending (
        nonce TEXT PRIMARY KEY, user_id TEXT NOT NULL, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        aspsp_name TEXT NOT NULL, aspsp_country TEXT NOT NULL, psu_type TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE bank_connections (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, provider TEXT NOT NULL DEFAULT 'enablebanking',
        session TEXT NOT NULL, aspsp_name TEXT NOT NULL, aspsp_country TEXT NOT NULL, psu_type TEXT NOT NULL DEFAULT 'business',
        valid_until TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', last_error TEXT, last_sync_at TEXT, next_sync_at TEXT,
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX bank_connections_loc ON bank_connections(location_id);
      CREATE INDEX bank_connections_due ON bank_connections(status, next_sync_at);
      CREATE TABLE bank_connection_accounts (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, uid TEXT NOT NULL, iban TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT 'EUR', enabled INTEGER NOT NULL DEFAULT 1, synced_from TEXT NOT NULL,
        last_booking_date TEXT, balance_cents INTEGER, balance_currency TEXT, balance_at TEXT, last_sync_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX bank_connection_accounts_conn ON bank_connection_accounts(connection_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    const person = (ctx: Ctx) => {
      if (!isHuman(ctx)) throw new HttpError(403, 'Das geht nur angemeldet in der Oberfläche – nicht mit API-Schlüssel, MCP oder Agent');
    };
    const manager = (ctx: Ctx) => {
      if (!canManageLocation(ctx.user, ctx.locationId)) throw new HttpError(403, 'Eine Bank verbinden oder trennen dürfen nur Admins und Personen mit dem Recht „Einstellungen“');
    };
    const getConn = (ctx: Ctx) => {
      const c = db.get<ConnRow>('SELECT * FROM bank_connections WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound('Bankverbindung nicht gefunden');
      return c;
    };
    const audit = (ctx: Ctx | undefined, action: string, summary: string, locationId: string | null, extra: { userId?: string; actor?: string } = {}) =>
      writeAudit(app, { ctx, action, summary, locationId, entityId: null, actor: extra.actor, userId: extra.userId });

    /** What the browser sees of a connection: never the session. */
    const out = (c: ConnRow) => {
      const accounts = db.all<AccRow>('SELECT * FROM bank_connection_accounts WHERE connection_id = ? ORDER BY created_at', c.id);
      const daysLeft = Math.floor((Date.parse(c.valid_until) - Date.now()) / 86400_000);
      return {
        id: c.id,
        bank: c.aspsp_name,
        country: c.aspsp_country,
        psu_type: c.psu_type,
        status: c.status === 'active' && daysLeft < 0 ? 'expired' : c.status,
        valid_until: c.valid_until,
        days_left: daysLeft,
        renew_soon: c.status === 'active' && daysLeft >= 0 && daysLeft <= 14,
        last_sync_at: c.last_sync_at,
        next_sync_at: c.next_sync_at,
        last_error: c.last_error,
        accounts: accounts.map((a) => ({ id: a.id, iban: a.iban, name: a.name, currency: a.currency, enabled: !!a.enabled, synced_from: a.synced_from, last_booking_date: a.last_booking_date, balance_cents: a.balance_cents, balance_currency: a.balance_currency, balance_at: a.balance_at, last_sync_at: a.last_sync_at })),
      };
    };

    router.get('/api/accounting/bank/sync', 'location', (ctx) => ({
      ready: !!bankSyncCreds(app),
      can_manage: canManageLocation(ctx.user, ctx.locationId),
      admin: ctx.user?.role === 'admin',
      connections: db.all<ConnRow>(`SELECT * FROM bank_connections WHERE location_id = ? ORDER BY created_at`, ctx.locationId).map(out),
    }));

    router.get('/api/accounting/bank/sync/banks', 'location', async (ctx) => {
      const country = String(ctx.query.get('country') || 'DE').toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw bad('Land: zwei Buchstaben, z. B. DE');
      try {
        const list = await banksOf(app, country);
        return list.map((a) => ({ name: a.name, country: a.country, logo: a.logo ?? '', bic: a.bic ?? '', beta: !!a.beta, psu_types: a.psu_types ?? [], max_days: a.maximum_consent_validity ? Math.floor(a.maximum_consent_validity / 86400) : null }));
      } catch (e) {
        if (e instanceof BankSyncError) throw new HttpError(502, e.message);
        throw e;
      }
    });

    // --- connect: start ------------------------------------------------------------------------------------------------
    const originFor = (ctx: Ctx) => {
      const host = String(ctx.req.headers.host ?? '').toLowerCase();
      return origins(app).find((o) => new URL(o).host === host) ?? app.baseUrl();
    };

    router.post('/api/accounting/bank/sync/start', 'location', async (ctx) => {
      person(ctx);
      manager(ctx);
      requireEnabled(app, ctx.locationId);
      const sid = ctx.cookies[SESSION_COOKIE];
      if (!sid || ctx.via !== 'session') throw new HttpError(403, 'Verbinden geht nur angemeldet im Browser');
      const b = ctx.body ?? {};
      const country = String(b.country || 'DE').toUpperCase();
      const name = String(b.bank ?? '').trim();
      const psuType = b.psu_type === 'personal' ? 'personal' : 'business';
      if (!name) throw bad('Bitte eine Bank wählen');
      let aspsp: EbAspsp | undefined;
      try {
        aspsp = (await banksOf(app, country)).find((a) => a.name === name);
      } catch (e) {
        if (e instanceof BankSyncError) throw new HttpError(502, e.message);
        throw e;
      }
      if (!aspsp) throw bad('Diese Bank kennt Enable Banking nicht – bitte aus der Liste wählen');
      if (aspsp.psu_types?.length && !aspsp.psu_types.includes(psuType)) throw bad(psuType === 'business' ? 'Diese Bank bietet die Anbindung nur für Privatkonten an' : 'Diese Bank bietet die Anbindung nur für Geschäftskonten an');
      const days = Math.max(1, Math.min(MAX_CONSENT_DAYS, aspsp.maximum_consent_validity ? Math.floor(aspsp.maximum_consent_validity / 86400) : 90));
      const redirectUri = bankRedirectUri(originFor(ctx));
      const nonce = token(18);
      db.run('DELETE FROM bank_sync_pending WHERE expires_at < ?', now());
      const payload = { n: nonce, p: 'enablebanking' as unknown as StatePayload['p'], k: 'bank' as unknown as Purpose, u: ctx.user!.id, s: sha256(sid), l: ctx.locationId, e: Date.now() + STATE_TTL_MS };
      let url: string;
      try {
        url = (
          await clientOf(app).startAuth({
            aspsp: { name: aspsp.name, country: aspsp.country },
            validUntil: new Date(Date.now() + days * 86400_000).toISOString(),
            state: signState(app.config.secret, payload),
            redirectUrl: redirectUri,
            psuType,
            language: ctx.user && String(ctx.req.headers['accept-language'] ?? '').toLowerCase().startsWith('en') ? 'en' : 'de',
          })
        ).url;
      } catch (e) {
        if (e instanceof BankSyncError) throw new HttpError(502, e.message);
        throw e;
      }
      if (!/^https:\/\//.test(String(url ?? ''))) throw new HttpError(502, 'Enable Banking hat keine Anmeldeadresse geliefert');
      db.insert('bank_sync_pending', { nonce, user_id: ctx.user!.id, location_id: ctx.locationId, aspsp_name: aspsp.name, aspsp_country: aspsp.country, psu_type: psuType, redirect_uri: redirectUri, expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString() });
      return { url };
    });

    // --- connect: back from the bank -----------------------------------------------------------------------------------------
    const back = (params: Record<string, string>) => redirect(`${RETURN_TO}?${new URLSearchParams(params)}`);

    router.get('/oauth/bank/enablebanking/callback', 'public', async (ctx: Ctx) => {
      const sid = ctx.cookies[SESSION_COOKIE];
      const user = sid ? db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(sid), now()) : undefined;
      if (!user) return html(messagePage('Nicht angemeldet', 'Bitte zuerst anmelden und die Bank dann noch einmal verbinden.'), 401);
      let payload: StatePayload;
      try {
        payload = verifyState(app.config.secret, String(ctx.query.get('state') ?? ''), { sessionHash: sha256(sid!) });
        if ((payload.p as string) !== 'enablebanking' || payload.u !== user.id) throw new Error('Ungültige Anfrage (state passt nicht)');
      } catch (e) {
        return html(messagePage('Verbinden fehlgeschlagen', (e as Error).message), 400);
      }
      const pending = db.get('SELECT * FROM bank_sync_pending WHERE nonce = ?', payload.n);
      db.run('DELETE FROM bank_sync_pending WHERE nonce = ?', payload.n);
      if (!pending || pending.user_id !== user.id || Date.parse(pending.expires_at) < Date.now()) return back({ bank: 'error', msg: 'Die Anmeldung ist abgelaufen oder wurde schon benutzt – bitte noch einmal verbinden' });
      const locationId: string = pending.location_id;
      if (!canManageLocation(fullUser(user), locationId)) return back({ bank: 'error', msg: 'Kein Zugriff auf die Einstellungen dieses Sub-Accounts' });
      if (ctx.query.get('error')) {
        const denied = /denied|cancel/i.test(String(ctx.query.get('error')));
        return back({ bank: 'error', msg: denied ? 'Die Freigabe bei der Bank wurde abgebrochen' : `Bank: ${String(ctx.query.get('error_description') || ctx.query.get('error')).slice(0, 200)}` });
      }
      const code = String(ctx.query.get('code') ?? '');
      if (!code) return back({ bank: 'error', msg: 'Kein Code von der Bank erhalten' });
      let connId: string;
      try {
        const s = await clientOf(app).createSession(code);
        if (!s.session_id || !Array.isArray(s.accounts)) throw new Error('Enable Banking hat keine Sitzung geliefert');
        connId = id();
        const today = isoDay(new Date());
        db.tx(() => {
          db.insert('bank_connections', {
            id: connId,
            location_id: locationId,
            provider: 'enablebanking',
            session: sealSecret(app, s.session_id),
            aspsp_name: s.aspsp?.name || pending.aspsp_name,
            aspsp_country: s.aspsp?.country || pending.aspsp_country,
            psu_type: s.psu_type || pending.psu_type,
            valid_until: s.access?.valid_until ? new Date(s.access.valid_until).toISOString() : new Date(Date.now() + 90 * 86400_000).toISOString(),
            status: 'active',
            created_by: user.id,
            created_at: now(),
            updated_at: now(),
          });
          for (const acc of s.accounts) {
            if (!acc?.uid) continue;
            const iban = accountIban(acc);
            // The sync starts after the last line already imported from a statement file of this account (no doubles),
            // otherwise 90 days back.
            const lastFile = iban ? db.get<{ d: string | null }>('SELECT MAX(booking_date) AS d FROM acc_bank_txns WHERE location_id = ? AND account_iban = ?', locationId, iban)?.d : null;
            const earliest = addDays(today, -FIRST_SYNC_DAYS);
            const from = lastFile && addDays(lastFile, 1) > earliest ? addDays(lastFile, 1) : earliest;
            db.insert('bank_connection_accounts', {
              id: id(),
              connection_id: connId,
              location_id: locationId,
              uid: acc.uid,
              iban,
              name: String(acc.name || acc.product || acc.details || '').slice(0, 120),
              currency: String(acc.currency || 'EUR').toUpperCase().slice(0, 3),
              enabled: 1,
              synced_from: from > today ? today : from,
              created_at: now(),
            });
          }
        });
        audit(ctx, 'bank.connect', `Bank verbunden: ${pending.aspsp_name} (${s.accounts.length} Konto/Konten, Freigabe bis ${String(s.access?.valid_until ?? '').slice(0, 10)})`, locationId, { userId: user.id, actor: user.name });
      } catch (e) {
        return back({ bank: 'error', msg: (e as Error).message.slice(0, 300) });
      }
      // The first sync right away – the person has just confirmed at the bank, so it counts as present.
      const who = { id: user.id as string, name: (user.name || user.email) as string };
      void syncConnection(app, connId, { psu: psuHeaders(ctx.ip, String(ctx.req.headers['user-agent'] ?? '')), who }).catch((e) => console.error('[bank-sync] erster Abruf', (e as Error).message));
      return back({ bank: 'ok' });
    });

    // --- sync, accounts, disconnect -------------------------------------------------------------------------------------------
    router.post('/api/accounting/bank/sync/:id/run', 'location', async (ctx) => {
      const c = getConn(ctx);
      const r = await syncConnection(app, c.id, { psu: isHuman(ctx) ? psuHeaders(ctx.ip, String(ctx.req.headers['user-agent'] ?? '')) : undefined, who: actor(ctx) });
      return { ...r, connection: out(db.get<ConnRow>('SELECT * FROM bank_connections WHERE id = ?', c.id)!) };
    });

    router.patch('/api/accounting/bank/sync/:id/accounts/:acc', 'location', (ctx) => {
      manager(ctx);
      const c = getConn(ctx);
      const a = db.get<AccRow>('SELECT * FROM bank_connection_accounts WHERE id = ? AND connection_id = ?', ctx.params.acc, c.id);
      if (!a) throw notFound('Konto nicht gefunden');
      if (typeof ctx.body?.enabled !== 'boolean') throw bad('enabled: true oder false');
      db.run('UPDATE bank_connection_accounts SET enabled = ? WHERE id = ?', ctx.body.enabled ? 1 : 0, a.id);
      return out(c);
    });

    router.delete('/api/accounting/bank/sync/:id', 'location', async (ctx) => {
      person(ctx);
      manager(ctx);
      const c = getConn(ctx);
      // The consent is ended at the bank too; a failure there (already expired) does not keep the connection here.
      let ended = true;
      try {
        await clientOf(app).deleteSession(openSecret(app, c.session));
      } catch {
        ended = false;
      }
      db.run('DELETE FROM bank_connections WHERE id = ?', c.id);
      audit(ctx, 'bank.disconnect', `Bank getrennt: ${c.aspsp_name}${ended ? '' : ' (Freigabe bei der Bank war schon beendet)'}`, ctx.locationId);
      return { ok: true, ended };
    });

    // --- agency: the Enable Banking application ---------------------------------------------------------------------------
    const agencyOut = () => {
      const s = savedAgency(app);
      const c = bankSyncCreds(app);
      return {
        app_id: s.app_id || process.env.PGHL_ENABLEBANKING_APP_ID || '',
        private_key: c ? MASK : '',
        key_set: !!c?.privateKey,
        ready: !!c,
        redirect_uris: origins(app).map(bankRedirectUri),
      };
    };
    router.get('/api/accounting/bank/sync/agency', 'admin', () => agencyOut());
    router.put('/api/accounting/bank/sync/agency', 'admin', (ctx) => {
      person(ctx);
      const b = ctx.body ?? {};
      const patch: Record<string, string | null> = {};
      if (b.app_id !== undefined) {
        const v = String(b.app_id ?? '').trim();
        if (v && !isAppId(v)) throw bad('App-ID von Enable Banking: eine UUID (z. B. 1a2b3c4d-…)');
        patch.app_id = v || null;
      }
      if (b.private_key === null) patch.private_key = null;
      else if (typeof b.private_key === 'string' && b.private_key.trim() && b.private_key !== MASK) {
        const pem = b.private_key.trim();
        if (pem.length > 10_000) throw bad('Der Schlüssel ist zu lang');
        const err = checkPrivateKey(pem);
        if (err) throw bad(err);
        patch.private_key = pem;
      }
      saveAgency(app, patch);
      clearBankListCache();
      audit(ctx, 'bank.agency.update', `Enable-Banking-Zugang der Agentur geändert (${Object.keys(patch).join(', ') || 'nichts'})`, null);
      return agencyOut();
    });

    // --- background: every connection about every 8 hours ------------------------------------------------------------------
    app.onTick(async () => {
      if (!bankSyncCreds(app)) return;
      const due = db.all<{ id: string }>(`SELECT id FROM bank_connections WHERE status = 'active' AND (next_sync_at IS NULL OR next_sync_at <= ?) ORDER BY next_sync_at LIMIT 5`, now());
      for (const c of due) {
        if (running.has(c.id)) continue;
        await syncConnection(app, c.id).catch((e) => console.error('[bank-sync]', c.id, (e as Error).message));
      }
    });
  },
};
