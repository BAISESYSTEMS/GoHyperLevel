import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import {
  Cancelled,
  HUBSPOT_PARTS,
  HubSpotClient,
  HubSpotError,
  PART_LABELS,
  emptyProgress,
  hubspotDryRun,
  runHubSpotImport,
  type HubSpotPart,
  type HubSpotProgress,
} from '../services/hubspot.js';
import { openSecret, sealSecret } from './mail-sync.js';

/**
 * Einstellungen → Import → HubSpot: Private-App token (sealed), dry run with counts, then a
 * resumable background import with progress. Test hooks: app.services.hubspotFetch (replaces
 * fetch), app.services.hubspotSleep (replaces waiting), app.services.hubspotPauseMs,
 * app.services.hubspotCheckTimeoutMs (timeout of the token check, default 8 s).
 */

/** The token check answers the person who just pressed "Verbinden": one attempt, short timeout – no import retry/backoff. */
const CHECK_TIMEOUT_MS = 8_000;

const running = new Map<string, { jobId: string; cancel: boolean }>();

function cleanParts(v: unknown): HubSpotPart[] {
  const list = Array.isArray(v) && v.length ? v.map(String) : [...HUBSPOT_PARTS];
  const parts = list.filter((p): p is HubSpotPart => (HUBSPOT_PARTS as readonly string[]).includes(p));
  if (!parts.length) throw bad('Mindestens einen Teil wählen');
  return parts;
}

export const hubspotImportModule: Module = {
  name: 'hubspot-import',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE hubspot_connections (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        token_sealed TEXT NOT NULL, token_hint TEXT NOT NULL, portal_id TEXT, ui_domain TEXT, time_zone TEXT, currency TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE hubspot_ids (
        location_id TEXT NOT NULL, object TEXT NOT NULL, hubspot_id TEXT NOT NULL, local_id TEXT NOT NULL, extra TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (location_id, object, hubspot_id)
      );
      CREATE TABLE hubspot_jobs (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, status TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]', progress TEXT NOT NULL DEFAULT '{}',
        result TEXT, log TEXT NOT NULL DEFAULT '[]', error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE INDEX hubspot_jobs_loc ON hubspot_jobs(location_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    // A restart stops running imports – they continue with "Fortsetzen".
    db.run(`UPDATE hubspot_jobs SET status = 'interrupted', updated_at = ? WHERE status = 'running'`, now());

    const conn = (loc: string) => db.get('SELECT * FROM hubspot_connections WHERE location_id = ?', loc);
    const connOut = (loc: string) => {
      const c = conn(loc);
      return c ? { connected: true, token_hint: c.token_hint, portal_id: c.portal_id, ui_domain: c.ui_domain, time_zone: c.time_zone, currency: c.currency, updated_at: c.updated_at } : { connected: false };
    };
    const client = (tokenStr: string) =>
      new HubSpotClient(tokenStr, { fetch: app.services.hubspotFetch, sleep: app.services.hubspotSleep, pauseMs: app.services.hubspotPauseMs ?? 110 });
    const clientFor = (loc: string) => {
      const c = conn(loc);
      if (!c) throw bad('Erst den HubSpot-Token eintragen');
      let t = '';
      try {
        t = openSecret(app, c.token_sealed);
      } catch {
        throw bad('Gespeicherter Token ist nicht lesbar – bitte neu eintragen');
      }
      return client(t);
    };
    const jobOut = (j: any) => j && parseJson({ ...j }, ['parts', 'progress', 'result', 'log']);
    const lastJob = (loc: string, kind: string) => jobOut(db.get('SELECT * FROM hubspot_jobs WHERE location_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', loc, kind));
    const uiOnly = (ctx: Ctx) => {
      if (ctx.viaApiKey) throw new HttpError(403, 'Nur in der Oberfläche');
    };

    app.services.hubspotStatus = (loc: string) => {
      const c = conn(loc);
      const last = db.get(`SELECT finished_at FROM hubspot_jobs WHERE location_id = ? AND kind = 'import' AND status = 'done' ORDER BY finished_at DESC LIMIT 1`, loc);
      return { connected: !!c, portal_id: c?.portal_id ?? null, last_import_at: last?.finished_at ?? null };
    };

    router.get('/api/import/hubspot', 'location', (ctx) => ({
      connection: connOut(ctx.locationId),
      parts: HUBSPOT_PARTS.map((k) => ({ key: k, label: PART_LABELS[k] })),
      modules: { companies: typeof app.services.companies?.upsert === 'function', tickets: typeof app.services.ticketsImport === 'function' },
      dry_run: lastJob(ctx.locationId, 'dry_run'),
      job: lastJob(ctx.locationId, 'import'),
    }));

    router.put('/api/import/hubspot/connection', 'location', async (ctx) => {
      uiOnly(ctx);
      const t = str(ctx.body.token, 'HubSpot-Token', { required: true, max: 500 });
      const timeoutMs = app.services.hubspotCheckTimeoutMs ?? CHECK_TIMEOUT_MS;
      const check = new HubSpotClient(t, { fetch: app.services.hubspotFetch, maxRetries: 0, timeoutMs });
      let info: any;
      try {
        info = await check.req('GET', '/account-info/v3/details');
      } catch (e) {
        const status = e instanceof HubSpotError ? e.status : 0;
        // No answer, rate limit or HubSpot error: the token may be fine – a gateway error, not a bad request.
        if (status === 0) throw new HttpError(502, `HubSpot ist nicht erreichbar (keine Antwort innerhalb von ${Math.max(1, Math.round(timeoutMs / 1000))} Sekunden) – bitte später noch einmal versuchen`);
        if (status === 429 || status >= 500) throw new HttpError(502, `HubSpot ist gerade nicht verfügbar (${status === 429 ? 'Limit erreicht' : `Fehler ${status}`}) – bitte später noch einmal versuchen`);
        throw bad(e instanceof HubSpotError ? e.message : `HubSpot-Token konnte nicht geprüft werden: ${(e as Error).message}`);
      }
      const row = { token_sealed: sealSecret(app, t), token_hint: `…${t.slice(-4)}`, portal_id: String(info.portalId ?? ''), ui_domain: String(info.uiDomain ?? ''), time_zone: String(info.timeZone ?? ''), currency: String(info.companyCurrency ?? ''), updated_at: now() };
      if (conn(ctx.locationId)) db.run(`UPDATE hubspot_connections SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE location_id = ?`, ...Object.values(row), ctx.locationId);
      else db.insert('hubspot_connections', { location_id: ctx.locationId, created_at: now(), ...row });
      return connOut(ctx.locationId);
    });
    router.delete('/api/import/hubspot/connection', 'location', (ctx) => {
      uiOnly(ctx);
      if (running.has(ctx.locationId)) throw bad('Es läuft gerade ein Import');
      db.run('DELETE FROM hubspot_connections WHERE location_id = ?', ctx.locationId);
      return connOut(ctx.locationId);
    });

    router.post('/api/import/hubspot/dry-run', 'location', async (ctx) => {
      uiOnly(ctx);
      const parts = cleanParts(ctx.body.parts);
      const c = clientFor(ctx.locationId);
      let rows;
      try {
        rows = await hubspotDryRun(app, ctx.locationId, c, parts);
      } catch (e) {
        throw bad((e as Error).message);
      }
      const job = { id: id(), location_id: ctx.locationId, kind: 'dry_run', status: 'done', parts, result: rows, progress: {}, log: [], created_at: now(), updated_at: now(), finished_at: now() };
      db.insert('hubspot_jobs', job);
      return jobOut(db.get('SELECT * FROM hubspot_jobs WHERE id = ?', job.id));
    });

    function start(app: App, jobId: string) {
      const job = jobOut(db.get('SELECT * FROM hubspot_jobs WHERE id = ?', jobId));
      const loc = job.location_id;
      const c = clientFor(loc);
      const flag = { jobId, cancel: false };
      running.set(loc, flag);
      const progress: HubSpotProgress = { ...emptyProgress(), ...(job.progress ?? {}) };
      const log: string[] = job.log ?? [];
      const save = (p: HubSpotProgress) => db.run('UPDATE hubspot_jobs SET progress = ?, log = ?, updated_at = ? WHERE id = ?', JSON.stringify(p), JSON.stringify(log.slice(-200)), now(), jobId);
      const say = (s: string) => {
        log.push(`${new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })} ${s}`);
        save(progress);
      };
      db.run(`UPDATE hubspot_jobs SET status = 'running', error = NULL, updated_at = ? WHERE id = ?`, now(), jobId);
      say(progress.done_steps.length ? `Fortgesetzt bei „${progress.step}“` : 'Import gestartet');
      const done = runHubSpotImport(app, loc, c, job.parts, progress, { save, log: say, cancelled: () => flag.cancel })
        .then(() => {
          say('Fertig');
          db.run(`UPDATE hubspot_jobs SET status = 'done', finished_at = ?, updated_at = ? WHERE id = ?`, now(), now(), jobId);
        })
        .catch((e) => {
          const paused = e instanceof Cancelled;
          say(paused ? 'Pausiert – mit „Fortsetzen“ geht es an derselben Stelle weiter' : `Abgebrochen: ${(e as Error).message}`);
          db.run(`UPDATE hubspot_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?`, paused ? 'interrupted' : 'failed', paused ? null : (e as Error).message, now(), jobId);
        })
        .finally(() => running.delete(loc));
      app.services.hubspotRunning = done;
      return done;
    }

    router.post('/api/import/hubspot/start', 'location', (ctx) => {
      uiOnly(ctx);
      if (running.has(ctx.locationId)) throw bad('Es läuft schon ein Import');
      const parts = cleanParts(ctx.body.parts);
      clientFor(ctx.locationId);
      const job = { id: id(), location_id: ctx.locationId, kind: 'import', status: 'running', parts, progress: emptyProgress(), log: [], created_at: now(), updated_at: now() };
      db.insert('hubspot_jobs', job);
      void start(app, job.id);
      return jobOut(db.get('SELECT * FROM hubspot_jobs WHERE id = ?', job.id));
    });
    router.get('/api/import/hubspot/jobs', 'location', (ctx) =>
      parseRows(db.all(`SELECT id, kind, status, parts, error, created_at, finished_at FROM hubspot_jobs WHERE location_id = ? ORDER BY created_at DESC LIMIT 20`, ctx.locationId), ['parts']),
    );
    router.get('/api/import/hubspot/jobs/:id', 'location', (ctx) => {
      const j = db.get('SELECT * FROM hubspot_jobs WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!j) throw notFound();
      return jobOut(j);
    });
    router.post('/api/import/hubspot/jobs/:id/resume', 'location', (ctx) => {
      uiOnly(ctx);
      const j = db.get(`SELECT * FROM hubspot_jobs WHERE id = ? AND location_id = ? AND kind = 'import'`, ctx.params.id, ctx.locationId);
      if (!j) throw notFound();
      if (running.has(ctx.locationId)) throw bad('Es läuft schon ein Import');
      if (!['failed', 'interrupted'].includes(j.status)) throw bad('Nur abgebrochene oder pausierte Importe lassen sich fortsetzen');
      void start(app, j.id);
      return jobOut(db.get('SELECT * FROM hubspot_jobs WHERE id = ?', j.id));
    });
    router.post('/api/import/hubspot/jobs/:id/pause', 'location', (ctx) => {
      const r = running.get(ctx.locationId);
      if (!r || r.jobId !== ctx.params.id) throw bad('Dieser Import läuft nicht');
      r.cancel = true;
      return { ok: true };
    });
  },
};
