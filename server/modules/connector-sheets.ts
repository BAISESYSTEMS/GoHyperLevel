import { SESSION_COOKIE, type Module } from '../core/app.js';
import { HttpError, bad, html, redirect, str } from '../core/http.js';
import { messagePage } from '../core/page.js';
import { now, sha256, token } from '../core/util.js';
import { findContacts, upsertContact } from '../services/contacts.js';
import { connectorFetch, contactsToRows, readJson, registerConnector, rowsToContacts, spreadsheetId } from '../services/connectors.js';
import { OAuthError, STATE_TTL_MS, authorizeUrl, exchangeCode, idTokenClaims, pkcePair, refreshTokens, revokeToken, signState, verifyState, type Purpose } from '../services/oauth.js';
import { openSecret, sealSecret } from './mail-sync.js';
import { clientConfig } from './oauth-connect.js';

/**
 * Native connector Google Sheets: export the sub-account's contacts into a spreadsheet and import
 * contacts from one. Uses the agency's Google OAuth app (Agentur → Integrationen); the sub-account
 * connects its own Google account with the "spreadsheets" scope. Its redirect URI
 * (/oauth/google/sheets/callback) has to be added to the OAuth app once.
 */

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/spreadsheets'];
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const MAX_ROWS = 5000;
const PURPOSE = 'sheets' as unknown as Purpose;

export const connectorSheetsModule: Module = {
  name: 'connector-sheets',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE sheets_connections (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        account_email TEXT NOT NULL DEFAULT '', refresh_token TEXT NOT NULL, access_token TEXT, expires_at TEXT,
        last_export TEXT NOT NULL DEFAULT '{}', last_import TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE sheets_pending (
        nonce TEXT PRIMARY KEY, location_id TEXT NOT NULL, user_id TEXT NOT NULL, verifier TEXT NOT NULL,
        redirect_uri TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const oauthFetch = (): typeof fetch => app.services.oauthFetch ?? fetch;
    const redirectUri = () => `${app.baseUrl()}/oauth/google/sheets/callback`;
    const conn = (loc: string) => db.get('SELECT * FROM sheets_connections WHERE location_id = ?', loc);

    registerConnector(app, {
      key: 'google_sheets',
      name: 'Google Sheets',
      category: 'Daten',
      icon: 'csv',
      description: 'Kontakte in eine Google-Tabelle exportieren oder aus einer importieren – über die Google-OAuth-App der Agentur.',
      credentials: 'Mit Google verbinden unter Apps → Direkt-Verbindungen (braucht die Google-OAuth-App der Agentur mit der zusätzlichen Weiterleitungs-URI …/oauth/google/sheets/callback).',
      fields: [],
      custom: true,
      guide: [
        'Agentur: In der Google Cloud Console die Google Sheets API aktivieren und bei der OAuth-App die Weiterleitungs-URI https://<deine-domain>/oauth/google/sheets/callback ergänzen.',
        'Im Sub-Account Apps → Direkt-Verbindungen → Google Sheets → „Mit Google verbinden“.',
        'Exportieren legt eine neue Tabelle (oder einen neuen Reiter) an; Importieren liest die erste Zeile als Spaltennamen (E-Mail, Vorname, Telefon …).',
      ],
      probe: (_a, loc) => {
        const c = conn(loc);
        if (c) return { status: 'ok', detail: `Verbunden: ${c.account_email || 'Google-Konto'}` };
        return clientConfig(app, 'google') ? { status: 'info', detail: 'Bereit – mit Google verbinden' } : { status: 'missing', detail: 'Google-OAuth-App fehlt (Agentur)' };
      },
    });

    /** A valid access token for the sub-account (refreshed when it is about to expire). */
    const accessToken = async (loc: string): Promise<string> => {
      const c = conn(loc);
      if (!c) throw new HttpError(409, 'Google Sheets ist nicht verbunden (Apps → Direkt-Verbindungen).');
      if (c.access_token && c.expires_at && Date.parse(c.expires_at) - Date.now() > 60_000) return openSecret(app, c.access_token);
      const cfg = clientConfig(app, 'google');
      if (!cfg) throw new HttpError(409, 'Die Google-OAuth-App der Agentur fehlt (Agentur → Integrationen).');
      try {
        const t = await refreshTokens(oauthFetch(), 'google', cfg, { refreshToken: openSecret(app, c.refresh_token), scopes: SCOPES });
        db.run(
          'UPDATE sheets_connections SET access_token = ?, expires_at = ?, refresh_token = COALESCE(?, refresh_token), updated_at = ? WHERE location_id = ?',
          sealSecret(app, t.access_token),
          new Date(Date.now() + t.expires_in * 1000).toISOString(),
          t.refresh_token ? sealSecret(app, t.refresh_token) : null,
          now(),
          loc,
        );
        return t.access_token;
      } catch (e) {
        if (e instanceof OAuthError && e.needsReconnect) throw new HttpError(409, 'Google-Zugriff abgelaufen oder entzogen – bitte Google Sheets neu verbinden.');
        throw new HttpError(502, (e as Error).message);
      }
    };
    const sheets = async (loc: string, method: string, url: string, body?: unknown) => {
      const tok = await accessToken(loc);
      const r = await connectorFetch(app)(url, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
      try {
        return await readJson(r, 'Google Sheets');
      } catch (e) {
        throw new HttpError(r.status === 404 ? 404 : 502, (e as Error).message);
      }
    };

    /** For workflow steps (modules/connector-apps-work.ts): one authenticated Sheets call of a sub-account. */
    app.services.sheetsApi = sheets;

    router.get('/api/sheets', 'location', (ctx) => {
      const c = conn(ctx.locationId);
      return {
        oauth_ready: !!clientConfig(app, 'google'),
        connected: !!c,
        account_email: c?.account_email ?? '',
        redirect_uri: redirectUri(),
        last_export: c ? JSON.parse(c.last_export || '{}') : {},
        last_import: c ? JSON.parse(c.last_import || '{}') : {},
      };
    });
    router.post('/api/sheets/connect', 'location', (ctx) => {
      const sid = ctx.cookies[SESSION_COOKIE];
      if (!sid || ctx.via !== 'session') throw new HttpError(403, 'Verbinden geht nur angemeldet im Browser.');
      const cfg = clientConfig(app, 'google');
      if (!cfg) throw new HttpError(409, 'Die Agentur hat noch keine Google-OAuth-App hinterlegt (Agentur → Integrationen).');
      const nonce = token(18);
      const { verifier, challenge } = pkcePair();
      db.run('DELETE FROM sheets_pending WHERE expires_at < ?', now());
      db.insert('sheets_pending', { nonce, location_id: ctx.locationId, user_id: ctx.user!.id, verifier, redirect_uri: redirectUri(), expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString() });
      const state = signState(app.config.secret, { n: nonce, p: 'google', k: PURPOSE, u: ctx.user!.id, s: sha256(sid), l: ctx.locationId, e: Date.now() + STATE_TTL_MS });
      return { url: authorizeUrl('google', cfg, { redirectUri: redirectUri(), scopes: SCOPES, state, challenge }) };
    });

    const back = (params: Record<string, string>) => redirect(`/app/apps/direct?${new URLSearchParams(params)}`);
    router.get('/oauth/google/sheets/callback', 'public', async (ctx) => {
      const sid = ctx.cookies[SESSION_COOKIE];
      const user = sid ? db.get(`SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(sid), now()) : undefined;
      if (!user) return html(messagePage('Nicht angemeldet', 'Bitte zuerst anmelden und dann noch einmal verbinden.'), 401);
      let st;
      try {
        st = verifyState(app.config.secret, String(ctx.query.get('state') ?? ''), { sessionHash: sha256(sid!) });
        if (st.u !== user.id || st.k !== PURPOSE) throw new Error('Ungültige Anfrage (state passt nicht)');
      } catch (e) {
        return html(messagePage('Verbinden fehlgeschlagen', (e as Error).message), 400);
      }
      const pending = db.get('SELECT * FROM sheets_pending WHERE nonce = ?', st.n);
      db.run('DELETE FROM sheets_pending WHERE nonce = ?', st.n);
      if (!pending || pending.user_id !== user.id || pending.location_id !== st.l || Date.parse(pending.expires_at) < Date.now()) return back({ sheets: 'error', msg: 'Die Anmeldung ist abgelaufen – bitte noch einmal verbinden.' });
      if (ctx.query.get('error')) return back({ sheets: 'error', msg: ctx.query.get('error') === 'access_denied' ? 'Zugriff wurde nicht erlaubt.' : String(ctx.query.get('error')).slice(0, 100) });
      const cfg = clientConfig(app, 'google');
      if (!cfg) return back({ sheets: 'error', msg: 'Die Google-OAuth-App der Agentur fehlt.' });
      try {
        const t = await exchangeCode(oauthFetch(), 'google', cfg, { code: String(ctx.query.get('code') ?? ''), verifier: pending.verifier, redirectUri: pending.redirect_uri, scopes: SCOPES });
        if (t.scope && !t.scope.split(/\s+/).includes('https://www.googleapis.com/auth/spreadsheets')) {
          await revokeToken(oauthFetch(), 'google', cfg, t.refresh_token ?? t.access_token);
          return back({ sheets: 'error', msg: 'Bitte beim Verbinden den Zugriff auf Google Tabellen erlauben.' });
        }
        if (!t.refresh_token) return back({ sheets: 'error', msg: 'Google hat keinen dauerhaften Zugriff erteilt – bitte noch einmal verbinden.' });
        const claims = idTokenClaims(t.id_token);
        db.run('DELETE FROM sheets_connections WHERE location_id = ?', pending.location_id);
        db.insert('sheets_connections', {
          location_id: pending.location_id,
          account_email: claims.email,
          refresh_token: sealSecret(app, t.refresh_token),
          access_token: sealSecret(app, t.access_token),
          expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
          created_by: user.id,
          created_at: now(),
          updated_at: now(),
        });
        app.services.audit?.({ ctx, action: 'sheets.connect', summary: `Google Sheets verbunden: ${claims.email}`, userId: user.id, locationId: pending.location_id, entityId: pending.location_id });
        return back({ sheets: 'ok' });
      } catch (e) {
        return back({ sheets: 'error', msg: (e as Error).message.slice(0, 200) });
      }
    });
    router.delete('/api/sheets', 'location', async (ctx) => {
      const c = conn(ctx.locationId);
      const cfg = clientConfig(app, 'google');
      if (c && cfg) await revokeToken(oauthFetch(), 'google', cfg, openSecret(app, c.refresh_token)).catch(() => false);
      db.run('DELETE FROM sheets_connections WHERE location_id = ?', ctx.locationId);
      return { ok: true };
    });

    const customFields = (loc: string) => db.all('SELECT key, label FROM custom_fields WHERE location_id = ? ORDER BY label', loc).map((f) => ({ key: String(f.key), label: String(f.label ?? f.key) }));

    /** Export: a new spreadsheet, or a new tab in an existing one – never overwrites data. */
    router.post('/api/sheets/export', 'location', async (ctx) => {
      const loc = ctx.locationId;
      const tag = str(ctx.body.tag, 'Tag', { max: 100 });
      const target = str(ctx.body.spreadsheet, 'Tabelle', { max: 300 });
      const sheetId = target ? spreadsheetId(target) : null;
      if (target && !sheetId) throw bad('Tabellen-Link oder -ID ungültig');
      const { contacts } = findContacts(app, loc, { tags: tag ? [tag] : undefined, limit: MAX_ROWS, sort: 'name' });
      const rows = contactsToRows(contacts, customFields(loc));
      const stamp = new Date().toLocaleString('de-DE', { timeZone: app.location(loc)?.timezone || 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });
      const tab = `Kontakte ${stamp}`.replace(/[[\]*?:/\\]/g, '-').slice(0, 90);
      let idOut: string;
      let url: string;
      if (sheetId) {
        await sheets(loc, 'POST', `${SHEETS}/${sheetId}:batchUpdate`, { requests: [{ addSheet: { properties: { title: tab } } }] });
        idOut = sheetId;
        url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
      } else {
        const created = await sheets(loc, 'POST', SHEETS, { properties: { title: `${app.location(loc)?.name ?? 'HyperLevel'} – ${tab}` }, sheets: [{ properties: { title: tab } }] });
        idOut = String(created?.spreadsheetId ?? '');
        if (!idOut) throw new HttpError(502, 'Google hat keine Tabelle angelegt.');
        url = String(created?.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${idOut}/edit`);
      }
      const range = `'${tab.replace(/'/g, "''")}'!A1`;
      await sheets(loc, 'PUT', `${SHEETS}/${idOut}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { range, majorDimension: 'ROWS', values: rows });
      const info = { at: now(), rows: rows.length - 1, url, tab };
      db.run('UPDATE sheets_connections SET last_export = ? WHERE location_id = ?', JSON.stringify(info), loc);
      return { ok: true, spreadsheet_id: idOut, ...info };
    });

    /** Import: first row = headers (E-Mail, Vorname, Telefon, Firma, Tags, eigene Felder …). */
    router.post('/api/sheets/import', 'location', async (ctx) => {
      const loc = ctx.locationId;
      const sid = spreadsheetId(str(ctx.body.spreadsheet, 'Tabelle', { required: true, max: 300 }));
      if (!sid) throw bad('Tabellen-Link oder -ID ungültig');
      const sheet = str(ctx.body.sheet, 'Reiter', { max: 100 });
      const range = sheet ? `'${sheet.replace(/'/g, "''")}'!A1:AZ${MAX_ROWS + 1}` : `A1:AZ${MAX_ROWS + 1}`;
      const data = await sheets(loc, 'GET', `${SHEETS}/${sid}/values/${encodeURIComponent(range)}?majorDimension=ROWS`);
      const parsed = rowsToContacts(Array.isArray(data?.values) ? data.values : [], customFields(loc));
      if (!parsed.columns.some((c) => c.field === 'email' || c.field === 'phone')) throw bad('Keine Spalte „E-Mail“ oder „Telefon“ in der ersten Zeile gefunden.');
      const tag = str(ctx.body.tag, 'Tag', { max: 100 });
      if (ctx.body.dry_run) return { dry_run: true, rows: parsed.contacts.length, skipped: parsed.skipped, columns: parsed.columns, sample: parsed.contacts.slice(0, 5) };
      let created = 0;
      let updated = 0;
      for (const input of parsed.contacts) {
        const r = upsertContact(app, loc, input, { source: 'Google Sheets', tags: tag ? [tag] : [], quiet: !ctx.body.trigger_workflows });
        if (r.created) created++;
        else updated++;
      }
      const info = { at: now(), created, updated, skipped: parsed.skipped, spreadsheet_id: sid };
      db.run('UPDATE sheets_connections SET last_import = ? WHERE location_id = ?', JSON.stringify(info), loc);
      return { ok: true, ...info, columns: parsed.columns };
    });

    app.onTick(() => void db.run('DELETE FROM sheets_pending WHERE expires_at < ?', now()));
  },
};

