import type { App, Module } from '../core/app.js';
import { bad, str } from '../core/http.js';
import { now } from '../core/util.js';
import { safeFetch } from '../services/net.js';
import { openSecret, sealSecret } from './mail-sync.js';

/**
 * One-way mirror of the CRM into a Supabase project (PostgREST), so other projects and the Supabase
 * MCP can query projects, contacts, deals, tasks, invoices and documents. Rows go to public.ghl_*
 * tables (RLS on, no policies: only the service role reads them). Every 10 minutes changed rows
 * are upserted; once a night everything is re-sent and rows deleted here are removed there.
 */

interface MirrorConfig {
  url: string;
  key_sealed?: string;
  enabled: boolean;
}
interface MirrorState {
  last_run?: string;
  last_full?: string;
  last_error?: string;
  counts?: Record<string, number>;
  cursors?: Record<string, string>;
}

const json = (v: unknown) => (typeof v === 'string' ? (v ? JSON.parse(v) : null) : v ?? null);
const bool = (v: unknown) => !!v;

/** What goes where: one entry per Supabase table. `since` filters changed rows for incremental runs. */
export const TABLES: { table: string; rows: (app: App, since?: string) => Record<string, unknown>[] }[] = [
  {
    table: 'ghl_projects',
    rows: (app) =>
      app.db.all('SELECT l.id, l.name, l.timezone, l.created_at, p.data FROM locations l LEFT JOIN project_profiles p ON p.location_id = l.id').map((l) => {
        const d = json(l.data) ?? {};
        return { id: l.id, name: l.name, timezone: l.timezone, status: d.status ?? 'entwicklung', tagline: d.tagline ?? '', website: d.website ?? '', category: d.category ?? '', priority: d.priority ?? 0, profile: d, created_at: l.created_at };
      }),
  },
  {
    table: 'ghl_contacts',
    rows: (app, since) =>
      app.db
        .all(
          `SELECT c.id, c.location_id, l.name AS project, c.first_name, c.last_name, c.email, c.phone, c.company, c.city, c.country, c.source, c.tags, c.custom, c.dnd, c.last_activity_at, c.created_at, c.updated_at
           FROM contacts c JOIN locations l ON l.id = c.location_id ${since ? 'WHERE c.updated_at > ?' : ''}`,
          ...(since ? [since] : []),
        )
        .map((c) => ({ ...c, tags: json(c.tags) ?? [], custom: json(c.custom) ?? {}, dnd: bool(c.dnd) })),
  },
  {
    table: 'ghl_opportunities',
    rows: (app, since) =>
      app.db
        .all(
          `SELECT o.id, o.location_id, o.pipeline_id, p.name AS pipeline, p.stages, o.stage_id, o.name, o.value, o.status, o.contact_id, o.source, o.created_at, o.updated_at
           FROM opportunities o JOIN pipelines p ON p.id = o.pipeline_id ${since ? 'WHERE o.updated_at > ?' : ''}`,
          ...(since ? [since] : []),
        )
        .map(({ stages, ...o }) => ({ ...o, stage: ((json(stages) ?? []) as any[]).find((s) => s.id === o.stage_id)?.name ?? '' })),
  },
  {
    // tasks have no updated_at: they are small, always sent in full
    table: 'ghl_tasks',
    rows: (app) =>
      app.db.all('SELECT id, location_id, contact_id, title, description, due_at, done, created_at, completed_at FROM tasks').map((t) => ({ ...t, done: bool(t.done) })),
  },
  {
    table: 'ghl_invoices',
    rows: (app, since) =>
      app.db.all(
        `SELECT id, location_id, kind, number, title, contact_id, currency, subtotal_cents, tax_cents, total_cents, status, issued_at, due_at, sent_at, paid_at, created_at, updated_at
         FROM invoices ${since ? 'WHERE updated_at > ?' : ''}`,
        ...(since ? [since] : []),
      ),
  },
  {
    table: 'ghl_docs',
    rows: (app, since) =>
      app.db.all(`SELECT id, location_id, title, url, kind, source, session_url, summary, pinned, updated_at, created_at FROM docs ${since ? 'WHERE updated_at > ?' : ''}`, ...(since ? [since] : [])).map((d) => ({ ...d, pinned: bool(d.pinned) })),
  },
];

/** SQL to create the target tables in Supabase (also shown in the UI and the docs). */
export const SUPABASE_SQL = `
create table if not exists public.ghl_projects (id text primary key, name text, timezone text, status text, tagline text, website text, category text, priority int, profile jsonb, created_at timestamptz, synced_at timestamptz);
create table if not exists public.ghl_contacts (id text primary key, location_id text, project text, first_name text, last_name text, email text, phone text, company text, city text, country text, source text, tags jsonb, custom jsonb, dnd boolean, last_activity_at timestamptz, created_at timestamptz, updated_at timestamptz, synced_at timestamptz);
create table if not exists public.ghl_opportunities (id text primary key, location_id text, pipeline_id text, pipeline text, stage_id text, stage text, name text, value numeric, status text, contact_id text, source text, created_at timestamptz, updated_at timestamptz, synced_at timestamptz);
create table if not exists public.ghl_tasks (id text primary key, location_id text, contact_id text, title text, description text, due_at timestamptz, done boolean, created_at timestamptz, completed_at timestamptz, synced_at timestamptz);
create table if not exists public.ghl_invoices (id text primary key, location_id text, kind text, number text, title text, contact_id text, currency text, subtotal_cents bigint, tax_cents bigint, total_cents bigint, status text, issued_at timestamptz, due_at timestamptz, sent_at timestamptz, paid_at timestamptz, created_at timestamptz, updated_at timestamptz, synced_at timestamptz);
create table if not exists public.ghl_docs (id text primary key, location_id text, title text, url text, kind text, source text, session_url text, summary text, pinned boolean, updated_at timestamptz, created_at timestamptz, synced_at timestamptz);
alter table public.ghl_projects enable row level security;
alter table public.ghl_contacts enable row level security;
alter table public.ghl_opportunities enable row level security;
alter table public.ghl_tasks enable row level security;
alter table public.ghl_invoices enable row level security;
alter table public.ghl_docs enable row level security;
`.trim();

/** A table another module adds (app.services.supabaseTables), with its own create SQL. */
export interface MirrorTable {
  table: string;
  sql?: string;
  rows: (app: App, since?: string) => Record<string, unknown>[];
}
const allTables = (app: App): MirrorTable[] => [...TABLES, ...((app.services.supabaseTables ?? []) as MirrorTable[])];
export const mirrorSql = (app: App) => [SUPABASE_SQL, ...((app.services.supabaseTables ?? []) as MirrorTable[]).map((t) => t.sql).filter(Boolean)].join('\n');

function getConfig(app: App): MirrorConfig | null {
  const row = app.db.get('SELECT value FROM agency_settings WHERE key = ?', 'supabase_mirror');
  return row ? JSON.parse(row.value) : null;
}
function getState(app: App): MirrorState {
  const row = app.db.get('SELECT value FROM agency_settings WHERE key = ?', 'supabase_mirror_state');
  return row ? JSON.parse(row.value) : {};
}
function put(app: App, key: string, value: unknown) {
  app.db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text: string }>;
const defaultFetcher: Fetcher = async (url, init) => {
  const r = await safeFetch(url, { ...init, timeoutMs: 30_000, maxBytes: 256 * 1024 });
  return { status: r.status, text: await r.text() };
};

function client(app: App, cfg: MirrorConfig) {
  const key = cfg.key_sealed ? openSecret(app, cfg.key_sealed) : '';
  const base = cfg.url.replace(/\/+$/, '');
  const fetcher: Fetcher = app.services.supabaseFetch ?? defaultFetcher;
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const call = async (method: string, path: string, body?: unknown, prefer?: string) => {
    const r = await fetcher(`${base}/rest/v1/${path}`, { method, headers: { ...headers, ...(prefer ? { prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status >= 300) throw new Error(`Supabase ${method} ${path.split('?')[0]}: ${r.status} ${r.text.slice(0, 200)}`);
    return r.text;
  };
  return { call };
}

/** Sends changed (or, with full=true, all) rows; a full run also deletes rows that no longer exist here. */
export async function runMirror(app: App, opts: { full?: boolean } = {}) {
  const cfg = getConfig(app);
  if (!cfg?.enabled || !cfg.url || !cfg.key_sealed) throw bad('Supabase-Spiegel ist nicht eingerichtet');
  const sb = client(app, cfg);
  const state = getState(app);
  const started = now();
  const counts: Record<string, number> = {};
  const cursors = { ...(state.cursors ?? {}) };
  try {
    for (const t of allTables(app)) {
      const since = opts.full ? undefined : cursors[t.table];
      const rows = t.rows(app, since).map((r) => ({ ...r, synced_at: started }));
      for (let i = 0; i < rows.length; i += 500) await sb.call('POST', `${t.table}?on_conflict=id`, rows.slice(i, i + 500), 'resolution=merge-duplicates,return=minimal');
      if (opts.full) await sb.call('DELETE', `${t.table}?synced_at=lt.${encodeURIComponent(started)}`, undefined, 'return=minimal');
      counts[t.table] = rows.length;
      cursors[t.table] = started;
    }
    put(app, 'supabase_mirror_state', { ...state, last_run: started, ...(opts.full ? { last_full: started } : {}), last_error: '', counts, cursors });
    return { ok: true, full: !!opts.full, counts };
  } catch (e) {
    put(app, 'supabase_mirror_state', { ...state, last_run: started, last_error: (e as Error).message, cursors: state.cursors });
    throw e;
  }
}

export const supabaseMirrorModule: Module = {
  name: 'supabase-mirror',
  register(app) {
    const { router } = app;
    const view = () => {
      const cfg = getConfig(app);
      return { url: cfg?.url ?? '', enabled: !!cfg?.enabled, key_set: !!cfg?.key_sealed, state: getState(app), sql: mirrorSql(app), tables: allTables(app).map((t) => t.table) };
    };
    router.get('/api/agency/supabase', 'admin', () => view());
    router.patch('/api/agency/supabase', 'admin', async (ctx) => {
      const cur = getConfig(app) ?? { url: '', enabled: false };
      const next: MirrorConfig = { ...cur };
      if (ctx.body.url !== undefined) {
        const url = str(ctx.body.url, 'Adresse', { max: 300 }).replace(/\/+$/, '');
        if (url && !/^https:\/\/[^\s/]+/i.test(url)) throw bad('Adresse: bitte mit https:// angeben');
        next.url = url;
      }
      if (ctx.body.service_key) next.key_sealed = sealSecret(app, str(ctx.body.service_key, 'Service-Key', { max: 2000 }));
      if (ctx.body.enabled !== undefined) next.enabled = !!ctx.body.enabled;
      put(app, 'supabase_mirror', next);
      // test right away so the user sees whether the tables exist
      if (next.enabled && next.url && next.key_sealed) {
        try {
          await client(app, next).call('GET', 'ghl_projects?select=id&limit=1');
        } catch (e) {
          throw bad(`Gespeichert, aber Supabase antwortet nicht wie erwartet: ${(e as Error).message}. Wurden die Tabellen angelegt (SQL unten)?`);
        }
      }
      return view();
    });
    router.post('/api/agency/supabase/sync', 'admin', async (ctx) => ({ ...(await runMirror(app, { full: !!ctx.body?.full })), state: getState(app) }));

    // every 10 minutes changed rows, once a night everything (and deletions)
    let lastIncremental = 0;
    app.onTick(async () => {
      const cfg = getConfig(app);
      if (!cfg?.enabled || !cfg.key_sealed) return;
      if (Date.now() - lastIncremental < 10 * 60_000) return;
      lastIncremental = Date.now();
      const st = getState(app);
      const full = !st.last_full || Date.now() - Date.parse(st.last_full) > 23 * 3600_000;
      await runMirror(app, { full }).catch(() => {});
    });
  },
};
