import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { CogneeClient, CogneeError } from '../services/cognee/client.js';
import { accountFor, clearConn, clientOptions, connOut, readConn, readOverride, secretHint, writeConn, writeOverride, type AgencyConn, type AuthMode, type Posture } from '../services/cognee/connection.js';
import { activeTypes, askableTypes, CATALOG, cleanBaseUrl, datasetName, isType, readSettings, TYPES, type CogneeSettings, type CogneeType } from '../services/cognee/model.js';
import { recall } from '../services/cognee/recall.js';
import { getSettings, getState, itemCounts, pendingDeletions, resetCursor, saveSettings } from '../services/cognee/store.js';
import { queuePurge, reconcile } from '../services/cognee/sync.js';

/**
 * Wissensgedächtnis (Cognee): the connection (agency), the opt-ins and the governance status (per sub-account), asking
 * the memory and remembering a note. Syncing is in cognee-sync.ts, the MCP/agent tools in cognee-tools.ts, the
 * rules in services/cognee/*. Details and what is sent: docs/cognee.md.
 *
 * Who may do what: the agency (admins, signed in) sets up the server and the login; whoever has the area Einstellungen
 * in a sub-account decides what is shared; everybody else may ask – limited to the data types their own areas allow.
 */

const MIGRATION = `
  CREATE TABLE cognee_settings (
    location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0, types TEXT NOT NULL DEFAULT '{}', redact TEXT NOT NULL DEFAULT '{}',
    members_ask INTEGER NOT NULL DEFAULT 1, enabled_at TEXT, updated_by TEXT, updated_at TEXT NOT NULL
  );
  -- A login of its own for one sub-account (stronger separation inside Cognee). No foreign key: it outlives the sub-account until its data is deleted there.
  CREATE TABLE cognee_accounts (
    location_id TEXT PRIMARY KEY, auth_mode TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', secret_sealed TEXT NOT NULL, hint TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE cognee_state (
    location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, type TEXT NOT NULL,
    dataset_id TEXT NOT NULL DEFAULT '', cursor TEXT NOT NULL DEFAULT '{}', dirty INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'idle',
    cognify_started_at TEXT, last_sync_at TEXT, last_full_at TEXT, last_error TEXT NOT NULL DEFAULT '', last_error_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, skipped INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY (location_id, type)
  );
  -- HyperLevel record -> Cognee data item. Rows with a contact are removed by the GDPR erase (after their data items were queued for deletion).
  CREATE TABLE cognee_items (
    id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    type TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, parent_id TEXT, contact_id TEXT,
    data_id TEXT NOT NULL, content_hash TEXT NOT NULL, source_rev TEXT NOT NULL DEFAULT '', chars INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL,
    UNIQUE (location_id, type, kind, record_id)
  );
  CREATE INDEX cognee_items_loc ON cognee_items(location_id, type);
  CREATE INDEX cognee_items_data ON cognee_items(location_id, data_id);
  CREATE INDEX cognee_items_contact ON cognee_items(contact_id) WHERE contact_id IS NOT NULL;
  -- Removals still to send to Cognee (no contact column on purpose: the GDPR erase deletes every row that has one). No foreign key: survives a deleted sub-account.
  CREATE TABLE cognee_deletions (
    id TEXT PRIMARY KEY, location_id TEXT NOT NULL, type TEXT NOT NULL, dataset_id TEXT NOT NULL, data_id TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL, after_cognify INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
    last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE INDEX cognee_deletions_loc ON cognee_deletions(location_id, next_attempt_at);
  CREATE TABLE cognee_memories (
    id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, text TEXT NOT NULL,
    created_by TEXT, created_by_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX cognee_memories_loc ON cognee_memories(location_id, updated_at, id);
  -- The cursors of the sync read each source by (sub-account, changed-at).
  CREATE INDEX IF NOT EXISTS ix_cognee_messages ON messages(location_id, created_at);
  CREATE INDEX IF NOT EXISTS ix_cognee_notes ON notes(location_id, created_at, id);
  CREATE INDEX IF NOT EXISTS ix_cognee_tickets ON tickets(location_id, updated_at, id);
  CREATE INDEX IF NOT EXISTS ix_cognee_contacts ON contacts(location_id, updated_at, id);
  CREATE INDEX IF NOT EXISTS ix_cognee_lessons ON course_lessons(location_id, updated_at, id);
  CREATE INDEX IF NOT EXISTS ix_cognee_kb ON kb_articles(location_id, updated_at, id);
  -- Deleting a sub-account deletes its datasets in Cognee as well (queued; the queue outlives the rows).
  CREATE TRIGGER cognee_location_deleted BEFORE DELETE ON locations
  BEGIN
    INSERT INTO cognee_deletions (id, location_id, type, dataset_id, data_id, reason, after_cognify, attempts, next_attempt_at, last_error, created_at)
    SELECT lower(hex(randomblob(10))), location_id, type, dataset_id, '', 'location_deleted', 0, 0, NULL, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM cognee_state WHERE location_id = OLD.id AND dataset_id != '';
  END;
`;

export const ACCESS_CONTROL_HINT = 'Auf dem Cognee-Server muss ENABLE_BACKEND_ACCESS_CONTROL=true gesetzt sein – nur dann liegt jedes Dataset getrennt und jeder Cognee-Nutzer sieht nur seine eigenen.';

const MEMORY_MAX = 4000;
const ASKS_PER_MINUTE = 30;

/** Cognee errors become answers of ours (502, or 429 when Cognee is rate limiting). */
async function upstream<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // Our own refusals (a wrong dataset, a missing question) keep their status; what Cognee did becomes 502 (429 when it rate limits).
    if (e instanceof CogneeError) throw new HttpError(e.upstream === 0 && e.status < 500 ? e.status : e.status === 429 ? 429 : 502, e.message);
    throw e;
  }
}

const sessionOnly = (ctx: Ctx) => {
  if (ctx.viaApiKey) throw new HttpError(403, 'Das geht nur mit Anmeldung in der Oberfläche, nicht mit einem Schlüssel.');
};
const notReadOnly = (ctx: Ctx) => {
  if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
};
const isMember = (ctx: Ctx) => !!ctx.user && ctx.user.role !== 'admin';
/** The areas a member is limited to (null = everything: admins, unrestricted members, keys of the sub-account). */
const areasOf = (ctx: Ctx): string[] | null => (!ctx.user || ctx.user.role === 'admin' || !ctx.user.permissions ? null : ctx.user.permissions);
/** Remembering is writing: admins, keys that may write, unrestricted members, and members who may edit settings or the wiki. */
const canRemember = (ctx: Ctx) => {
  if (ctx.scope === 'read') return false;
  const a = areasOf(ctx);
  return a === null || a.includes('settings') || a.includes('wiki');
};

const boolOf = (v: unknown, name: string): boolean => {
  if (typeof v !== 'boolean') throw bad(`${name}: ja oder nein`);
  return v;
};

export function settingsOut(app: App, loc: string) {
  const s = getSettings(app, loc);
  const conn = readConn(app);
  return {
    enabled: s.enabled,
    types: s.types,
    redact: s.redact,
    members_ask: s.members_ask,
    catalog: TYPES.map((t) => ({ key: t, label: CATALOG[t].label, description: CATALOG[t].description, warning: CATALOG[t].warning ?? '', personal: CATALOG[t].personal, area: CATALOG[t].area, default_on: CATALOG[t].defaultOn, redact_default: CATALOG[t].redactDefault })),
    connection: { configured: !!conn, locations_may_enable: conn ? conn.locations_may_enable : true, account: readOverride(app, loc) ? 'override' : 'agency' },
  };
}

/** Applies a settings change; returns what was switched and which data types now offer "Daten in Cognee löschen". */
export function applySettings(app: App, ctx: Ctx | undefined, loc: string, body: any, admin: boolean) {
  const cur = getSettings(app, loc);
  const next: CogneeSettings = { ...cur, types: { ...cur.types }, redact: { ...cur.redact } };
  const b = body ?? {};
  if (b.enabled !== undefined) next.enabled = boolOf(b.enabled, 'enabled');
  if (b.members_ask !== undefined) next.members_ask = boolOf(b.members_ask, 'members_ask');
  for (const [field, target] of [['types', next.types], ['redact', next.redact]] as const) {
    if (b[field] === undefined) continue;
    if (!b[field] || typeof b[field] !== 'object' || Array.isArray(b[field])) throw bad(`${field}: Objekt erwartet`);
    for (const [k, v] of Object.entries(b[field])) {
      if (!isType(k)) throw bad(`Unbekannter Datentyp: ${str(k, 'Typ', { max: 40 })}`);
      target[k] = boolOf(v, `${field}.${k}`);
    }
  }
  const conn = readConn(app);
  if (next.enabled && !cur.enabled && !admin && conn && !conn.locations_may_enable) throw new HttpError(403, 'Die Agentur schaltet das Wissensgedächtnis selbst ein – bitte dort anfragen.');
  const before = new Set(activeTypes(cur));
  const after = new Set(activeTypes(next));
  const on = TYPES.filter((t) => after.has(t) && !before.has(t));
  const off = TYPES.filter((t) => before.has(t) && !after.has(t));
  const redactChanged = TYPES.filter((t) => cur.redact[t] !== next.redact[t]);
  saveSettings(app, loc, next, ctx?.user?.id ?? null);
  // A changed redaction rule applies to what is already in Cognee too: the records are sent again in their new form.
  for (const t of redactChanged) resetCursor(app, loc, t);
  const parts = [
    next.enabled !== cur.enabled && (next.enabled ? 'Wissensgedächtnis eingeschaltet' : 'Wissensgedächtnis ausgeschaltet'),
    on.length && `Daten freigegeben: ${on.map((t) => CATALOG[t].label).join(', ')}`,
    off.length && `Freigabe beendet: ${off.map((t) => CATALOG[t].label).join(', ')}`,
    redactChanged.length && `Schwärzung geändert: ${redactChanged.map((t) => `${CATALOG[t].label} ${next.redact[t] ? 'an' : 'aus'}`).join(', ')}`,
    next.members_ask !== cur.members_ask && `Fragen für Mitglieder ${next.members_ask ? 'erlaubt' : 'gesperrt'}`,
  ].filter(Boolean);
  if (parts.length) app.services.audit?.({ ctx, action: 'cognee.settings', locationId: loc, summary: parts.join(' · ') });
  // Types that stopped being shared but still have data in Cognee: the UI offers to delete it.
  const counts = itemCounts(app, loc);
  const offer = TYPES.filter((t) => !after.has(t) && (counts[t] > 0 || getState(app, loc, t).dataset_id !== ''));
  return { settings: settingsOut(app, loc), turned_on: on, turned_off: off, offer_delete: offer };
}

export function governanceStatus(app: App, loc: string) {
  const s = getSettings(app, loc);
  const conn = readConn(app);
  const counts = itemCounts(app, loc);
  const failing = app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cognee_deletions WHERE location_id = ? AND attempts > 0', loc)!.n;
  const types = TYPES.map((t) => {
    const st = getState(app, loc, t);
    const c = CATALOG[t];
    return {
      key: t,
      label: c.label,
      description: c.description,
      warning: c.warning ?? '',
      personal: c.personal,
      enabled: s.types[t],
      active: s.enabled && s.types[t],
      redact: s.redact[t],
      items: counts[t],
      dataset: datasetName(loc, t),
      has_data: counts[t] > 0 || st.dataset_id !== '',
      last_sync_at: st.last_sync_at,
      last_error: st.last_error,
      last_error_at: st.last_error_at,
      phase: st.phase,
      retry_at: st.next_attempt_at,
      skipped: st.skipped,
    };
  });
  const posture: Posture | null = conn?.posture ?? null;
  const warnings: { level: 'critical' | 'warning' | 'info'; text: string }[] = [];
  if (conn && posture?.state === 'open') {
    warnings.push({
      level: 'critical',
      text: `Der Cognee-Server antwortet ohne Anmeldung – die Zugriffskontrolle (ENABLE_BACKEND_ACCESS_CONTROL=true) ist aus, die Daten verschiedener Sub-Accounts liegen dort nicht getrennt. ${conn.allow_open_server ? 'Die Agentur hat das Übertragen trotzdem erlaubt.' : 'Es wird nichts übertragen, bis das behoben ist.'}`,
    });
  } else if (conn && (!posture || posture.state === 'unknown')) {
    warnings.push({ level: 'warning', text: `Ob die Zugriffskontrolle auf dem Cognee-Server aktiv ist, konnte nicht geprüft werden. ${ACCESS_CONTROL_HINT}` });
  }
  if (s.enabled && !conn) warnings.push({ level: 'warning', text: 'Der Cognee-Server ist noch nicht eingerichtet – die Agentur trägt ihn unter Agentur → Integrationen → Einrichtung ein. Bis dahin wird nichts übertragen.' });
  const personal = types.filter((t) => t.active && t.personal).map((t) => t.label);
  if (personal.length) warnings.push({ level: 'info', text: `Personenbezogene Daten werden geteilt: ${personal.join(', ')}. Auftragsverarbeitung und Rechtsgrundlage sollten geklärt sein.` });
  if (failing) warnings.push({ level: 'warning', text: `${failing} Löschung(en) in Cognee sind noch nicht durch – sie werden automatisch wiederholt.` });
  // Our own lines carry a summary; the generic "route was called" lines of the audit hook do not and are left out here.
  const audit = app.db.all(`SELECT at, action, actor, summary FROM audit_log WHERE location_id = ? AND action LIKE 'cognee.%' AND summary != '' ORDER BY at DESC LIMIT 12`, loc);
  return {
    enabled: s.enabled,
    members_ask: s.members_ask,
    connection: conn ? { configured: true, account: readOverride(app, loc) ? 'override' : 'agency', last_test_ok: conn.last_test?.ok ?? null } : { configured: false },
    access_control: { state: posture?.state ?? 'unknown', reason: posture?.reason ?? '', checked_at: posture?.at ?? null, hint: ACCESS_CONTROL_HINT },
    types,
    pending_deletions: pendingDeletions(app, loc),
    failing_deletions: failing,
    warnings,
    audit,
  };
}

/** Looks whether the server asks for a login at all and remembers the answer (shown as a warning when it does not). */
export async function refreshPosture(app: App, conn: AgencyConn): Promise<Posture> {
  const probe = await new CogneeClient(clientOptions(app, conn)).probeOpen();
  const posture: Posture = { state: probe.state, reason: probe.reason, at: now() };
  const saved = readConn(app);
  // Only when the saved connection is still the one that was checked.
  if (saved && saved.base_url === conn.base_url) writeConn(app, { ...saved, posture });
  return posture;
}

interface Step {
  key: string;
  label: string;
  ok: boolean;
  warn?: boolean;
  detail: string;
}

/** Health, access control, login, dataset list – each its own step, so the answer says where it fails. */
export async function testConnection(app: App, c: Pick<AgencyConn, 'base_url' | 'allow_private'> & { auth_mode: AuthMode; email: string; secret: string }) {
  const client = new CogneeClient(clientOptions(app, c));
  const steps: Step[] = [];
  let version = '';
  let posture: Posture | null = null;
  let datasets: { total: number; gohigh: number } | null = null;
  const fail = (key: string, label: string, e: unknown) => steps.push({ key, label, ok: false, detail: (e as Error).message });
  try {
    const h = await client.health();
    version = h.version;
    steps.push({ key: 'health', label: 'Server erreichbar', ok: h.ok, detail: h.ok ? `Cognee ${h.version || ''} ist bereit (${h.detail}).`.replace('  ', ' ') : `Cognee meldet sich, ist aber nicht bereit: ${h.detail}` });
  } catch (e) {
    fail('health', 'Server erreichbar', e);
  }
  if (steps[0].ok) {
    const p = await client.probeOpen();
    posture = { state: p.state, reason: p.reason, at: now() };
    steps.push({
      key: 'access',
      label: 'Zugriffskontrolle',
      ok: p.state !== 'open',
      warn: p.state === 'unknown',
      detail: p.state === 'closed' ? 'Der Server verlangt eine Anmeldung (ENABLE_BACKEND_ACCESS_CONTROL ist an).' : p.state === 'open' ? `${p.reason} ENABLE_BACKEND_ACCESS_CONTROL=true setzen – sonst teilen sich alle Sub-Accounts einen Graphen.` : `${p.reason} ${ACCESS_CONTROL_HINT}`,
    });
    try {
      const me = await client.me();
      steps.push({ key: 'login', label: 'Anmeldung', ok: true, detail: `Angemeldet${me.email ? ` als ${me.email}` : ''}.` });
      try {
        const list = await client.listDatasets();
        datasets = { total: list.length, gohigh: list.filter((d) => d.name.startsWith('gh_')).length };
        steps.push({ key: 'datasets', label: 'Datasets lesen', ok: true, detail: `${list.length} Dataset(s) sichtbar, davon ${datasets.gohigh} von HyperLevel.` });
      } catch (e) {
        fail('datasets', 'Datasets lesen', e);
      }
    } catch (e) {
      fail('login', 'Anmeldung', e);
    }
  }
  return { ok: steps.length >= 4 && steps.every((s) => s.ok || s.warn), steps, version, posture, datasets };
}

export const cogneeModule: Module = {
  name: 'cognee',
  migrations: [['001-init', MIGRATION]],
  register(app) {
    const { db, router } = app;
    const asks = new Map<string, { n: number; at: number }>();
    const reconciled = new Map<string, number>();
    const kick = (loc: string, o?: { full?: boolean }) => app.services.cognee?.kick?.(loc, o);
    const locationOr404 = (idv: string) => {
      const l = app.location(idv);
      if (!l) throw notFound('Sub-Account nicht gefunden');
      return l;
    };

    // --- agency: the connection ------------------------------------------------------------------------------------

    router.get('/api/agency/cognee', 'admin', () => ({ ...connOut(readConn(app)), access_control_hint: ACCESS_CONTROL_HINT }));

    const readConnBody = (b: any, cur: AgencyConn | null) => {
      const auth_mode: AuthMode = b.auth_mode === 'api_key' ? 'api_key' : b.auth_mode === 'password' ? 'password' : (cur?.auth_mode ?? 'password');
      let base_url: string;
      try {
        base_url = b.base_url !== undefined ? cleanBaseUrl(b.base_url) : (cur?.base_url ?? cleanBaseUrl(''));
      } catch (e) {
        throw bad((e as Error).message);
      }
      const email = auth_mode === 'password' ? str(b.email ?? cur?.email, 'E-Mail', { max: 200 }).toLowerCase() : '';
      if (auth_mode === 'password' && !/^[^@\s]+@[^@\s]+$/.test(email)) throw bad('E-Mail-Adresse des Cognee-Nutzers fehlt');
      const given = auth_mode === 'password' ? str(b.password, 'Passwort', { max: 300 }) : str(b.api_key, 'API-Schlüssel', { max: 500 });
      // Blank = keep the stored secret (only while the way of logging in stays the same).
      const secret = given || (cur && cur.auth_mode === auth_mode ? cur.secret : '');
      if (!secret) throw bad(auth_mode === 'password' ? 'Passwort des Cognee-Nutzers fehlt' : 'API-Schlüssel fehlt');
      return {
        base_url,
        auth_mode,
        email,
        secret,
        hint: given ? secretHint(given) : (cur?.hint ?? secretHint(secret)),
        allow_private: b.allow_private !== undefined ? !!b.allow_private : (cur?.allow_private ?? false),
        allow_open_server: b.allow_open_server !== undefined ? !!b.allow_open_server : (cur?.allow_open_server ?? false),
        locations_may_enable: b.locations_may_enable !== undefined ? !!b.locations_may_enable : (cur?.locations_may_enable ?? true),
      };
    };

    router.put('/api/agency/cognee', 'admin', async (ctx) => {
      sessionOnly(ctx);
      const cur = readConn(app);
      const c = readConnBody(ctx.body ?? {}, cur);
      const changed = [!cur || cur.base_url !== c.base_url ? 'Adresse' : '', !cur || cur.auth_mode !== c.auth_mode || cur.email !== c.email || cur.secret !== c.secret ? 'Zugang' : '', cur && cur.locations_may_enable !== c.locations_may_enable ? 'Sub-Accounts dürfen einschalten' : '', cur && cur.allow_open_server !== c.allow_open_server ? 'Offener Server erlaubt' : ''].filter(Boolean);
      // A new address or login is a new server: what was learned about the old one does not carry over.
      const same = cur && cur.base_url === c.base_url;
      writeConn(app, { ...c, posture: same ? cur.posture : undefined, last_test: same ? cur.last_test : undefined, updated_at: now() });
      app.services.audit?.({ ctx, action: 'cognee.connection', summary: `Verbindung gespeichert${changed.length ? ` (${changed.join(', ')})` : ''}` });
      try {
        await refreshPosture(app, readConn(app)!);
      } catch {
        /* the status shows "nicht geprüft" */
      }
      return connOut(readConn(app));
    });

    router.delete('/api/agency/cognee', 'admin', (ctx) => {
      sessionOnly(ctx);
      const sharing = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cognee_settings WHERE enabled = 1')!.n;
      const data = db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM cognee_items) + (SELECT COUNT(*) FROM cognee_deletions) AS n')!.n;
      if ((sharing || data) && ctx.query.get('force') !== '1') {
        throw new HttpError(409, `Noch ${sharing} Sub-Account(s) teilen Daten und ${data} Einträge/Löschungen sind offen. Erst dort das Gedächtnis ausschalten und „Daten in Cognee löschen“ wählen – sonst bleiben die Daten auf dem Server und lassen sich nicht mehr löschen.`);
      }
      clearConn(app);
      app.services.audit?.({ ctx, action: 'cognee.connection', summary: 'Verbindung entfernt' });
      return { ok: true };
    });

    router.post('/api/agency/cognee/test', 'admin', async (ctx) => {
      sessionOnly(ctx);
      const cur = readConn(app);
      const body = ctx.body ?? {};
      const given = Object.keys(body).length > 0;
      const c = given ? readConnBody(body, cur) : cur;
      if (!c) throw bad('Erst die Adresse und den Zugang des Cognee-Servers eintragen.');
      const r = await testConnection(app, c);
      const saved = readConn(app);
      // A test of the saved connection is remembered (and its access-control finding is what the status panels show).
      if (!given && saved) writeConn(app, { ...saved, posture: r.posture ?? saved.posture, last_test: { at: now(), ok: r.ok, summary: r.steps.map((s) => `${s.label}: ${s.ok ? 'ok' : 'Fehler'}`).join(', '), version: r.version || undefined } });
      app.services.audit?.({ ctx, action: 'cognee.test', summary: `Verbindungstest: ${r.ok ? 'ok' : 'fehlgeschlagen'}${r.datasets ? `, ${r.datasets.gohigh} HyperLevel-Datasets` : ''}` });
      return r;
    });

    // --- agency: a login of its own for one sub-account ------------------------------------------------------------------

    router.put('/api/agency/cognee/locations/:id/account', 'admin', (ctx) => {
      sessionOnly(ctx);
      locationOr404(ctx.params.id);
      if (!readConn(app)) throw bad('Erst den Cognee-Server der Agentur einrichten.');
      const busy = db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM cognee_items WHERE location_id = ?) + (SELECT COUNT(*) FROM cognee_deletions WHERE location_id = ?) AS n', ctx.params.id, ctx.params.id)!.n;
      if (busy) throw new HttpError(409, 'In Cognee liegen noch Daten dieses Sub-Accounts. Erst „Daten in Cognee löschen“, dann den Zugang wechseln – die Daten gehören dem bisherigen Cognee-Nutzer.');
      const b = ctx.body ?? {};
      const auth_mode: AuthMode = b.auth_mode === 'api_key' ? 'api_key' : 'password';
      const email = auth_mode === 'password' ? str(b.email, 'E-Mail', { required: true, max: 200 }).toLowerCase() : '';
      const secret = auth_mode === 'password' ? str(b.password, 'Passwort', { required: true, max: 300 }) : str(b.api_key, 'API-Schlüssel', { required: true, max: 500 });
      writeOverride(app, { location_id: ctx.params.id, auth_mode, email, secret, hint: secretHint(secret) });
      app.services.audit?.({ ctx, action: 'cognee.account', locationId: ctx.params.id, summary: 'Eigener Cognee-Zugang für diesen Sub-Account gesetzt' });
      return { ok: true, account: 'override', email, hint: secretHint(secret) };
    });

    router.delete('/api/agency/cognee/locations/:id/account', 'admin', (ctx) => {
      sessionOnly(ctx);
      const busy = db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM cognee_items WHERE location_id = ?) + (SELECT COUNT(*) FROM cognee_deletions WHERE location_id = ?) AS n', ctx.params.id, ctx.params.id)!.n;
      if (busy) throw new HttpError(409, 'In Cognee liegen noch Daten dieses Sub-Accounts. Erst „Daten in Cognee löschen“, dann den Zugang entfernen.');
      db.run('DELETE FROM cognee_accounts WHERE location_id = ?', ctx.params.id);
      app.services.audit?.({ ctx, action: 'cognee.account', locationId: ctx.params.id, summary: 'Eigener Cognee-Zugang entfernt' });
      return { ok: true };
    });

    router.post('/api/agency/cognee/locations/:id/test', 'admin', async (ctx) => {
      sessionOnly(ctx);
      locationOr404(ctx.params.id);
      const acct = accountFor(app, ctx.params.id);
      if (!acct) throw bad('Erst den Cognee-Server der Agentur einrichten.');
      const o = readOverride(app, ctx.params.id);
      const conn = readConn(app)!;
      return testConnection(app, o ? { ...conn, auth_mode: o.auth_mode, email: o.email, secret: o.secret } : conn);
    });

    // --- agency: all sub-accounts at a glance -------------------------------------------------------------------------------

    router.get('/api/agency/cognee/overview', 'admin', () => {
      const conn = readConn(app);
      const locs = db.all<{ id: string; name: string }>('SELECT id, name FROM locations ORDER BY name');
      // Grouped queries, one per table – never one per sub-account.
      const settings = new Map(db.all<any>('SELECT * FROM cognee_settings').map((r) => [r.location_id as string, readSettings(r)]));
      const items = new Map<string, Record<string, number>>();
      for (const r of db.all<{ location_id: string; type: string; n: number }>('SELECT location_id, type, COUNT(*) AS n FROM cognee_items GROUP BY location_id, type')) (items.get(r.location_id) ?? items.set(r.location_id, {}).get(r.location_id)!)[r.type] = r.n;
      const states = db.all<any>('SELECT location_id, MAX(last_sync_at) AS last_sync_at, SUM(CASE WHEN last_error != \'\' THEN 1 ELSE 0 END) AS errors FROM cognee_state GROUP BY location_id');
      const state = new Map(states.map((r) => [r.location_id as string, r]));
      const pending = new Map(db.all<{ location_id: string; n: number }>('SELECT location_id, COUNT(*) AS n FROM cognee_deletions GROUP BY location_id').map((r) => [r.location_id, r.n]));
      const own = new Map(db.all<{ location_id: string; email: string; auth_mode: string }>('SELECT location_id, email, auth_mode FROM cognee_accounts').map((r) => [r.location_id, r]));
      return {
        connection: connOut(conn),
        labels: Object.fromEntries(TYPES.map((t) => [t, CATALOG[t].label])),
        locations: locs.map((l) => {
          const s = settings.get(l.id) ?? readSettings(undefined);
          const by = items.get(l.id) ?? {};
          return {
            id: l.id,
            name: l.name,
            enabled: s.enabled,
            types: activeTypes(s),
            items: Object.values(by).reduce((a, b) => a + b, 0),
            by_type: by,
            last_sync_at: state.get(l.id)?.last_sync_at ?? null,
            errors: Number(state.get(l.id)?.errors ?? 0),
            pending_deletions: pending.get(l.id) ?? 0,
            account: own.has(l.id) ? 'override' : 'agency',
            account_label: own.get(l.id) ? (own.get(l.id)!.auth_mode === 'api_key' ? 'API-Schlüssel' : own.get(l.id)!.email) : '',
          };
        }),
      };
    });

    // The agency may switch any sub-account's sharing (e.g. off) from the overview.
    router.put('/api/agency/cognee/locations/:id/settings', 'admin', (ctx) => {
      locationOr404(ctx.params.id);
      sessionOnly(ctx);
      const r = applySettings(app, ctx, ctx.params.id, ctx.body, true);
      kick(ctx.params.id);
      return r;
    });

    // --- sub-account: for everybody -----------------------------------------------------------------------------------------

    router.get('/api/cognee/info', 'location', (ctx) => {
      const s = getSettings(app, ctx.locationId);
      const conn = readConn(app);
      const askable = askableTypes(s, areasOf(ctx));
      return {
        enabled: s.enabled,
        connected: !!conn,
        can_ask: s.enabled && !!conn && askable.length > 0 && (!isMember(ctx) || s.members_ask),
        can_remember: s.enabled && s.types.memory && canRemember(ctx),
        types: askable.map((t) => ({ key: t, label: CATALOG[t].label })),
      };
    });

    router.get('/api/cognee/recall', 'location', async (ctx) => {
      const loc = ctx.locationId;
      const s = getSettings(app, loc);
      if (!s.enabled) throw bad('Das Wissensgedächtnis ist für diesen Sub-Account nicht eingeschaltet (Einstellungen → Gedächtnis).');
      if (isMember(ctx) && !s.members_ask) throw new HttpError(403, 'In diesem Sub-Account dürfen Mitglieder das Gedächtnis nicht befragen.');
      let types = askableTypes(s, areasOf(ctx));
      const asked = (ctx.query.get('types') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      if (asked.length) types = types.filter((t) => asked.includes(t));
      if (!types.length) throw new HttpError(403, 'Für diese Auswahl sind keine Daten im Gedächtnis freigegeben (oder deine Bereiche erlauben sie nicht).');
      const acct = accountFor(app, loc);
      if (!acct) throw bad('Der Cognee-Server ist noch nicht eingerichtet (Agentur → Integrationen → Einrichtung).');
      if (acct.conn.posture?.state === 'open' && !acct.conn.allow_open_server) throw new HttpError(409, 'Der Cognee-Server hat keine Zugriffskontrolle – die Suche ist gesperrt, bis das behoben ist.');
      // A little brake: every question may cost model calls on the memory server.
      const t = Date.now();
      const a = asks.get(loc);
      if (!a || t - a.at > 60_000) asks.set(loc, { n: 1, at: t });
      else if (++a.n > ASKS_PER_MINUTE) throw new HttpError(429, 'Zu viele Fragen an das Gedächtnis – bitte kurz warten.');
      if (!(ctx.query.get('q') ?? '').trim()) throw bad('Bitte eine Frage stellen (q).');
      // What was deleted since the last look is queued for deletion now, so it neither shows up nor feeds an answer (at most every 30 s).
      if (Date.now() - (reconciled.get(loc) ?? 0) > 30_000) {
        reconciled.set(loc, Date.now());
        if (types.reduce((n, t) => n + reconcile(app, loc, t), 0)) kick(loc);
      }
      const compact = ctx.query.get('compact') === '1';
      const limit = Math.floor(Number(ctx.query.get('limit')) || (compact ? 5 : 8));
      const mode = ctx.query.get('mode') === 'answer' && !compact ? 'answer' : 'snippets';
      const out = await upstream(() => recall(app, acct.client, { query: ctx.query.get('q') ?? '', types, limit, mode, compact }));
      // Counts, never the question or the passages.
      app.services.audit?.({ ctx, action: 'cognee.search', route: 'GET /api/cognee/recall', locationId: loc, summary: `Gedächtnis befragt: ${out.results.length} Treffer in ${out.searched.map((x) => CATALOG[x].label).join(', ') || 'nichts durchsucht'}${out.answer ? ', mit Antwort' : ''}` });
      return out;
    });

    router.post('/api/cognee/remember', 'location', (ctx) => {
      notReadOnly(ctx);
      const loc = ctx.locationId;
      const s = getSettings(app, loc);
      if (!s.enabled || !s.types.memory) throw bad('„Gemerkte Hinweise“ sind in diesem Sub-Account nicht freigegeben (Einstellungen → Gedächtnis).');
      if (!canRemember(ctx)) throw new HttpError(403, 'Zum Merken fehlt dir das Recht (Einstellungen oder Wiki).');
      const text = str(ctx.body?.text, 'Text', { required: true, max: MEMORY_MAX });
      const row = { id: id(), location_id: loc, text, created_by: ctx.user?.id ?? null, created_by_name: ctx.user?.name ?? '', created_at: now(), updated_at: now() };
      db.insert('cognee_memories', row);
      app.services.audit?.({ ctx, action: 'cognee.remember', locationId: loc, entityId: row.id, summary: `Hinweis zum Merken gespeichert (${text.length} Zeichen)` });
      kick(loc);
      return { ok: true, id: row.id, queued: true };
    });

    router.get('/api/cognee/memories', 'location', (ctx) => {
      if (!canRemember(ctx)) throw new HttpError(403, 'Kein Zugriff auf die gemerkten Hinweise.');
      const rows = db.all<any>('SELECT m.id, m.text, m.created_by_name, m.created_at, (SELECT 1 FROM cognee_items i WHERE i.location_id = m.location_id AND i.type = \'memory\' AND i.record_id = m.id) AS synced FROM cognee_memories m WHERE m.location_id = ? ORDER BY m.created_at DESC LIMIT 100', ctx.locationId);
      return rows.map((r) => ({ ...r, text: String(r.text).slice(0, 600), synced: !!r.synced }));
    });

    router.delete('/api/cognee/memories/:id', 'location', (ctx) => {
      notReadOnly(ctx);
      if (!canRemember(ctx)) throw new HttpError(403, 'Kein Zugriff auf die gemerkten Hinweise.');
      if (!db.run('DELETE FROM cognee_memories WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Hinweis nicht gefunden');
      app.services.audit?.({ ctx, action: 'cognee.forget', locationId: ctx.locationId, entityId: ctx.params.id, summary: 'Gemerkten Hinweis gelöscht' });
      // The sync notices the missing record and queues the removal in Cognee.
      kick(ctx.locationId);
      return { ok: true };
    });

    // --- sub-account: governance (area Einstellungen, see core/permissions.ts) --------------------------------------------

    router.get('/api/cognee/admin/settings', 'location', (ctx) => settingsOut(app, ctx.locationId));

    router.put('/api/cognee/admin/settings', 'location', (ctx) => {
      sessionOnly(ctx);
      const r = applySettings(app, ctx, ctx.locationId, ctx.body, ctx.user?.role === 'admin');
      kick(ctx.locationId);
      return r;
    });

    router.get('/api/cognee/admin/status', 'location', (ctx) => governanceStatus(app, ctx.locationId));

    router.post('/api/cognee/admin/sync', 'location', (ctx) => {
      sessionOnly(ctx);
      const s = getSettings(app, ctx.locationId);
      if (!s.enabled) throw bad('Das Wissensgedächtnis ist nicht eingeschaltet.');
      if (!accountFor(app, ctx.locationId)) throw bad('Der Cognee-Server ist noch nicht eingerichtet.');
      // "Alles neu abgleichen": every record is looked at again, unchanged ones cost nothing.
      app.services.audit?.({ ctx, action: 'cognee.sync', locationId: ctx.locationId, summary: ctx.body?.full ? 'Vollständigen Abgleich angestoßen' : 'Abgleich angestoßen' });
      kick(ctx.locationId, { full: !!ctx.body?.full });
      return { ok: true, started: true };
    });

    /** "Daten in Cognee löschen" – for the sub-account itself and, from the overview, for the agency. */
    const purge = (ctx: Ctx, loc: string) => {
      sessionOnly(ctx);
      const want = ctx.body?.types === 'all' ? [...TYPES] : Array.isArray(ctx.body?.types) ? (ctx.body.types as unknown[]).map(String) : [];
      if (!want.length || want.some((t) => !isType(t))) throw bad('Datentypen angeben (types: Liste oder „all“)');
      if (ctx.body?.confirm !== true) throw bad('Bitte bestätigen (confirm: true) – die Daten in Cognee werden endgültig gelöscht.');
      const active = new Set(activeTypes(getSettings(app, loc)));
      // Deleting what is still shared would only fill it again.
      const still = (want as CogneeType[]).filter((t) => active.has(t));
      if (still.length) throw bad(`Erst die Freigabe beenden: ${still.map((t) => CATALOG[t].label).join(', ')}`);
      const r = queuePurge(app, loc, want as CogneeType[]);
      app.services.audit?.({ ctx, action: 'cognee.purge', locationId: loc, summary: `Daten in Cognee löschen angestoßen: ${r.types.map((t) => CATALOG[t].label).join(', ')} (${r.items} Einträge)` });
      kick(loc);
      return { ok: true, ...r };
    };
    router.post('/api/cognee/admin/purge', 'location', (ctx) => purge(ctx, ctx.locationId));
    router.post('/api/agency/cognee/locations/:id/purge', 'admin', (ctx) => {
      locationOr404(ctx.params.id);
      return purge(ctx, ctx.params.id);
    });

    app.services.cogneeStatus = (loc: string) => governanceStatus(app, loc);
  },
};
