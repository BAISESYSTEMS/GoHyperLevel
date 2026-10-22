import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { cached } from '../core/cache.js';
import { visibleLocations } from '../core/permissions.js';
import { bad, str } from '../core/http.js';
import { now } from '../core/util.js';
import { notifyTeam } from '../services/messaging.js';
import { safeFetch } from '../services/net.js';
import { locationStats } from '../services/location-stats.js';

/**
 * Projects hub: every sub-account can carry a project profile (status, website, repos, servers,
 * goals, KPIs, links). The agency sees all projects side by side, with a website uptime check.
 */

export const PROJECT_STATUSES = ['idee', 'entwicklung', 'beta', 'live', 'pausiert', 'archiviert'];

const cleanList = (v: unknown, max = 30) => (Array.isArray(v) ? v.slice(0, max) : []);
const url = (v: unknown, label: string) => {
  const s = str(v, label, { max: 500 });
  if (s && !/^https?:\/\/[^\s]+$/i.test(s)) throw bad(`${label}: bitte mit https:// angeben`);
  return s;
};

/** Claude sessions are linked by their claude.ai URL (or a bare session id). */
const claudeUrl = (v: unknown) => {
  const s = str(v, 'Claude-Sitzung', { max: 300 });
  if (!s) return '';
  if (/^session_[A-Za-z0-9]+$/.test(s)) return `https://claude.ai/code/${s}`;
  if (!/^https:\/\/(www\.)?claude\.ai\/[^\s]*$/i.test(s)) throw bad('Claude-Sitzung: bitte den Link von claude.ai einfügen');
  return s;
};

/** Codex tasks/environments are linked by their chatgpt.com/codex URL (or a bare task id). */
export const codexUrl = (v: unknown) => {
  const s = str(v, 'Codex-Aufgabe', { max: 300 });
  if (!s) return '';
  if (/^task_[a-z]_[A-Za-z0-9]+$/.test(s)) return `https://chatgpt.com/codex/tasks/${s}`;
  if (!/^https:\/\/(www\.)?chatgpt\.com\/codex(\/[^\s]*)?$/i.test(s)) throw bad('Codex: bitte einen Link von chatgpt.com/codex einfügen');
  return s;
};

function cleanProfile(b: any, cur: any = {}) {
  const out: Record<string, any> = { ...cur };
  if (b.status !== undefined) {
    if (!PROJECT_STATUSES.includes(b.status)) throw bad('Unbekannter Status');
    out.status = b.status;
  }
  for (const [k, max] of [['category', 100], ['tagline', 300], ['description', 20_000], ['goals', 20_000], ['notes', 50_000]] as const) if (b[k] !== undefined) out[k] = str(b[k], k, { max });
  if (b.website !== undefined) out.website = url(b.website, 'Website');
  if (b.priority !== undefined) out.priority = Math.max(0, Math.min(5, Math.round(Number(b.priority) || 0)));
  if (b.links !== undefined) out.links = cleanList(b.links).map((l: any) => ({ label: str(l?.label, 'Link-Name', { max: 100 }) || 'Link', url: url(l?.url, 'Link') })).filter((l: any) => l.url);
  if (b.repos !== undefined) out.repos = cleanList(b.repos).map((r: any) => str(r, 'Repository', { max: 300 })).filter(Boolean);
  if (b.servers !== undefined) out.servers = cleanList(b.servers).map((s: any) => ({ name: str(s?.name, 'Server', { max: 100 }), detail: str(s?.detail, 'Details', { max: 500 }) })).filter((s: any) => s.name);
  if (b.kpis !== undefined) out.kpis = cleanList(b.kpis, 20).map((k: any) => ({ label: str(k?.label, 'Kennzahl', { max: 100 }), value: str(k?.value, 'Wert', { max: 100 }), target: str(k?.target, 'Ziel', { max: 100 }) })).filter((k: any) => k.label);
  if (b.claude_sessions !== undefined)
    out.claude_sessions = cleanList(b.claude_sessions, 20)
      .map((c: any) => ({ label: str(c?.label, 'Sitzung', { max: 100 }) || 'Claude', url: claudeUrl(c?.url) }))
      .filter((c: any) => c.url);
  if (b.codex_sessions !== undefined)
    out.codex_sessions = cleanList(b.codex_sessions, 20)
      .map((c: any) => ({ label: str(c?.label, 'Aufgabe', { max: 100 }) || 'Codex', url: codexUrl(c?.url) }))
      .filter((c: any) => c.url);
  if (b.monitor !== undefined) out.monitor = !!b.monitor;
  return out;
}

export function projectStats(app: App, locationId: string) {
  const s = locationStats(app, [locationId]).get(locationId)!;
  return {
    contacts: s.contacts,
    open_opportunities: s.open_opportunities,
    open_value: s.open_value,
    won_value: s.won_value,
    open_tasks: s.open_tasks,
    overdue_tasks: s.overdue_tasks,
    unread: s.unread,
    drafts: s.drafts,
    last_activity: s.last_activity,
  };
}

export function getProfile(app: App, locationId: string) {
  const row = parseJson(app.db.get('SELECT * FROM project_profiles WHERE location_id = ?', locationId), ['data']);
  const data = row?.data ?? {};
  const last = app.db.get('SELECT at, ok, status, ms FROM project_checks WHERE location_id = ? ORDER BY at DESC LIMIT 1', locationId);
  const week = app.db.get<{ n: number; up: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(ok), 0) AS up FROM project_checks WHERE location_id = ? AND at > ?', locationId, new Date(Date.now() - 7 * 864e5).toISOString())!;
  return {
    status: 'entwicklung',
    category: '',
    tagline: '',
    description: '',
    website: '',
    goals: '',
    notes: '',
    priority: 0,
    links: [],
    repos: [],
    servers: [],
    kpis: [],
    claude_sessions: [],
    codex_sessions: [],
    monitor: true,
    ...data,
    updated_at: row?.updated_at ?? null,
    uptime: {
      last: last ?? null,
      week_pct: week.n ? Math.round((Number(week.up) / Number(week.n)) * 1000) / 10 : null,
    },
  };
}

export async function checkWebsite(app: App, locationId: string) {
  const p = getProfile(app, locationId);
  if (!p.website) return null;
  const t = Date.now();
  let status = 0;
  let ok = false;
  try {
    const r = await safeFetch(p.website, { timeoutMs: 15_000, maxBytes: 512 * 1024 });
    status = r.status;
    ok = r.status >= 200 && r.status < 400;
  } catch {
    status = 0;
  }
  const row = { location_id: locationId, at: now(), ok: ok ? 1 : 0, status, ms: Date.now() - t };
  const prev = app.db.get('SELECT ok FROM project_checks WHERE location_id = ? ORDER BY at DESC LIMIT 1', locationId);
  app.db.insert('project_checks', row);
  // Tell the team when the site goes down or comes back.
  if (prev && prev.ok !== row.ok) {
    const name = app.location(locationId)?.name ?? 'Projekt';
    void notifyTeam(app, locationId, row.ok ? `✅ ${name} ist wieder online` : `⚠️ ${name} ist nicht erreichbar`, `${p.website}\nStatus: ${status || 'keine Antwort'} (${row.ms} ms)\n\n${app.baseUrl()}/app/project`);
    app.events.emit(locationId, row.ok ? 'website.up' : 'website.down', { website: p.website, status, ms: row.ms });
  }
  app.db.run(`DELETE FROM project_checks WHERE location_id = ? AND at < ?`, locationId, new Date(Date.now() - 30 * 864e5).toISOString());
  return row;
}

export const projectsModule: Module = {
  name: 'projects',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE project_profiles (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE TABLE project_checks (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, at TEXT NOT NULL, ok INTEGER NOT NULL, status INTEGER NOT NULL, ms INTEGER NOT NULL
      );
      CREATE INDEX project_checks_loc ON project_checks(location_id, at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const save = (locationId: string, body: any) => {
      const cur = parseJson(db.get('SELECT * FROM project_profiles WHERE location_id = ?', locationId), ['data'])?.data ?? {};
      const data = cleanProfile(body ?? {}, cur);
      db.run('INSERT INTO project_profiles (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', locationId, JSON.stringify(data), now());
      return getProfile(app, locationId);
    };
    app.services.saveProjectProfile = save;

    router.get('/api/project', 'location', (ctx) => ({ ...getProfile(app, ctx.locationId), stats: projectStats(app, ctx.locationId) }));
    router.put('/api/project', 'location', (ctx) => save(ctx.locationId, ctx.body));
    router.post('/api/project/check', 'location', async (ctx) => ({ check: await checkWebsite(app, ctx.locationId) }));
    router.get('/api/agency/projects', 'admin', (ctx) =>
      // One grouped query per table for all sub-accounts (was nine per account); cached until the next write.
      visibleLocations(app, ctx.user, db.memo('agency:projects', 20_000, () => {
        const stats = locationStats(app);
        return db.all('SELECT id, name, timezone, created_at FROM locations ORDER BY name').map((l) => {
          const { new_contacts: _new, ...s } = stats.get(l.id) ?? locationStats(app, [l.id]).get(l.id)!;
          return { ...l, profile: getProfile(app, l.id), stats: s };
        });
      })),
    );

    // Open tasks of every project in one list (overdue first, then by due date).
    router.get('/api/agency/tasks', 'admin', (ctx) => cached(app, ctx, 10_000, () => {
      const status = ctx.query.get('status') === 'done' ? 1 : 0;
      return db.all(
        `SELECT t.id, t.title, t.description, t.due_at, t.done, t.created_at, t.location_id, l.name AS project, t.contact_id, c.first_name, c.last_name, c.email
         FROM tasks t JOIN locations l ON l.id = t.location_id LEFT JOIN contacts c ON c.id = t.contact_id
         WHERE t.done = ? ORDER BY COALESCE(t.due_at, '9999'), t.created_at LIMIT 1000`,
        status,
      );
    }));

    // Websites are checked every 10 minutes.
    let last = 0;
    app.onTick(async () => {
      if (Date.now() - last < 10 * 60_000) return;
      last = Date.now();
      for (const l of db.all('SELECT location_id FROM project_profiles')) {
        const p = getProfile(app, l.location_id);
        if (p.website && p.monitor !== false) await checkWebsite(app, l.location_id);
      }
    });
  },
};
