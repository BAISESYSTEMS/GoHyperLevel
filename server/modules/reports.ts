import type { App, Module } from '../core/app.js';
import { cached } from '../core/cache.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, str, type Ctx, type User } from '../core/http.js';
import { PERMISSIONS, visibleLocations, type Permission } from '../core/permissions.js';
import { id, now } from '../core/util.js';
import { deliverEmail, type OutMail } from '../services/messaging.js';
import {
  OPS,
  RANGE_PRESETS,
  ReportError,
  fieldValues,
  hasTables,
  normalizeQuery,
  resolveRange,
  runReport,
  scopeSources,
  toCsv,
  usableFields,
  type ReportResult,
  type ReportSource,
} from '../services/report-engine.js';
import { BUILTIN_SOURCES, withLocationField } from '../services/report-sources.js';
import { DEFAULT_SCHEDULE_RANGE, FREQUENCIES, nextRun, renderReportEmail, type Frequency } from '../services/report-email.js';
import { TEMPLATES, VIZ, packWidgets, type ReportConfig, type Widget } from '../services/report-templates.js';
import { effectiveBranding } from './agency.js';
import type { Tool } from './mcp.js';

/**
 * Berichte & Dashboards (HubSpot-style reporting): free reports over every registered source
 * (app.services.reportSources), a library of saved reports, dashboards with a drag & resize grid,
 * sharing, templates, scheduled e-mails and MCP tools. Every query runs through the report engine,
 * scoped to the sub-accounts (and areas) the caller may see.
 */

type Visibility = 'private' | 'team' | 'admins';
const VISIBILITY: Visibility[] = ['private', 'team', 'admins'];

/** Who is asking: a login, an agency key (synthetic admin) or a sub-account key (no user). */
interface Principal {
  user?: User;
  locationId: string;
  /** How the caller signed in (the record-access rules apply to people in the browser or the app, not to keys). */
  via?: Ctx['via'];
}

const principal = (ctx: Ctx): Principal => ({ user: ctx.user, locationId: ctx.locationId, via: ctx.via });

const asHttp = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ReportError) throw bad(e.message);
    throw e;
  }
};

function cleanVisibility(v: unknown, fallback: Visibility = 'private'): Visibility {
  return VISIBILITY.includes(v as Visibility) ? (v as Visibility) : fallback;
}

/** Report config from the builder/API (validated against the sources). */
function cleanConfig(app: App, v: any): ReportConfig {
  if (!v || typeof v !== 'object') throw bad('Bericht fehlt');
  const viz = VIZ.includes(v.viz) ? v.viz : 'table';
  const query = v.query && typeof v.query === 'object' ? v.query : null;
  if (!query) throw bad('Bericht ohne Abfrage');
  asHttp(() => normalizeQuery(query, sources(app), app.db));
  const keep = ['source', 'measures', 'group_by', 'filters', 'date_field', 'range', 'compare', 'sort', 'limit'];
  const q = Object.fromEntries(keep.filter((k) => query[k] !== undefined).map((k) => [k, query[k]]));
  return { viz, query: q, ...(v.title ? { title: str(v.title, 'Titel', { max: 120 }) } : {}), ...(v.fixed_range ? { fixed_range: true } : {}) };
}

/** Every registered source the database can serve (+ the "Sub-Account" group). */
function sources(app: App): ReportSource[] {
  const list: ReportSource[] = app.services.reportSources ?? [];
  return list.filter((s) => hasTables(app.db, s.requires)).map(withLocationField);
}

/** The sources one caller may see: custom objects/properties of other sub-accounts stay hidden. */
function sourcesFor(app: App, p: Principal): ReportSource[] {
  const u = p.user;
  return scopeSources(sources(app), u?.role === 'admin' ? 'all' : u ? [...new Set([p.locationId, ...u.locations])] : [p.locationId]);
}

// --- scoping ------------------------------------------------------------------------------------

const isAdmin = (p: Principal) => p.user?.role === 'admin';

/** Sub-accounts a report may read for this caller, checked against member areas and SaaS plans. */
function allowedLocations(app: App, p: Principal, src: ReportSource, scope: string, wanted?: unknown): string[] {
  const u = p.user;
  if (u && u.role !== 'admin' && u.permissions && !u.permissions.includes(src.area as Permission)) {
    throw new HttpError(403, `Kein Zugriff auf „${PERMISSIONS[src.area as Permission] ?? src.area}“`);
  }
  let locs: string[];
  if (scope !== 'all') locs = [p.locationId];
  else if (!u) locs = [p.locationId];
  else if (u.role === 'admin') {
    // Cloud mode: customers' sub-accounts that are not open for support stay out of the operator's reports (app.services.hiddenLocations).
    const hidden = app.services.hiddenLocations?.(u) as Set<string> | undefined;
    locs = app.db.all<{ id: string }>('SELECT id FROM locations ORDER BY created_at').map((r) => r.id).filter((id) => !hidden?.has(id));
  }
  else locs = u.locations.filter((l) => app.db.get('SELECT id FROM locations WHERE id = ?', l));
  if (Array.isArray(wanted) && wanted.length) {
    const set = new Set(wanted.map(String));
    locs = locs.filter((l) => set.has(l));
  }
  // SaaS plans: customer logins and sub-account keys never read areas their plan leaves out.
  const blocked = app.services.saasAreaBlocked as ((loc: string, area: string) => boolean) | undefined;
  if (!isAdmin(p) && blocked) {
    const before = locs.length;
    locs = locs.filter((l) => !blocked(l, src.area) && !blocked(l, 'dashboard'));
    if (before && !locs.length) throw new HttpError(403, `„${PERMISSIONS[src.area as Permission] ?? src.area}“ ist in deinem Tarif nicht enthalten`);
  }
  return locs;
}

/** Record-access rules (modules/record-access.ts): a person with a limited view reports on their own records only. */
function rowScope(app: App, p: Principal, locations: string[]) {
  const hook = app.services.reportRowScope as ((p: Principal, src: ReportSource, locations: string[]) => { sql: string; params: any[] } | undefined) | undefined;
  return hook ? { rowScope: (src: ReportSource) => hook(p, src, locations) } : {};
}

function tzOf(app: App, locationId: string) {
  return app.location(locationId)?.timezone || 'Europe/Berlin';
}

/** Runs one report for a caller. `overrides` come from a dashboard (its range and scope). */
function run(app: App, p: Principal, input: any, opts: { scope?: string; locationIds?: unknown; range?: unknown; compare?: boolean } = {}): ReportResult {
  return asHttp(() => {
    const list = sourcesFor(app, p);
    const q = { ...input };
    if (opts.range !== undefined) q.range = opts.range;
    if (opts.compare !== undefined) q.compare = opts.compare;
    const norm = normalizeQuery(q, list, app.db);
    const src = list.find((s) => s.key === norm.source)!;
    const locations = allowedLocations(app, p, src, opts.scope ?? 'location', opts.locationIds);
    // Record-access rules: a source whose numbers would show a field hidden from this person is closed to them.
    const why = (app.services.reportBlocked as ((p: Principal, sourceKey: string, locations: string[]) => string | undefined) | undefined)?.(p, src.key, locations);
    if (why) throw new HttpError(403, why);
    return runReport({ db: app.db, sources: list, locations, tz: tzOf(app, p.locationId), timeoutMs: app.services.reportTimeoutMs ?? 8000, maxRows: 1000, ...rowScope(app, p, locations) }, q);
  });
}

// --- access to saved things ---------------------------------------------------------------------

interface Owned {
  owner_id: string | null;
  location_id: string;
  visibility: Visibility;
}

function canSee(p: Principal, row: Owned): boolean {
  const u = p.user;
  if (!u) return row.visibility === 'team' && row.location_id === p.locationId;
  if (row.owner_id === u.id) return true;
  if (row.visibility === 'admins') return u.role === 'admin';
  if (row.visibility === 'team') return u.role === 'admin' || u.locations.includes(row.location_id);
  return false;
}

const canEdit = (p: Principal, row: Owned) => !!p.user && (row.owner_id === p.user.id || (p.user.role === 'admin' && row.visibility !== 'private'));

function needUser(p: Principal): User {
  if (!p.user) throw new HttpError(403, 'Dafür braucht es eine Anmeldung oder einen Agentur-Schlüssel');
  return p.user;
}

const DASH_JSON = ['widgets', 'settings'];

function cleanSettings(v: any, cur: Record<string, any> = {}) {
  const s = { ...cur };
  if (!v || typeof v !== 'object') return s;
  if (v.range !== undefined) s.range = typeof v.range === 'object' && v.range ? { from: String(v.range.from ?? ''), to: String(v.range.to ?? '') } : RANGE_PRESETS[v.range] ? v.range : 'last_30_days';
  if (v.scope !== undefined) s.scope = v.scope === 'all' ? 'all' : 'location';
  if (v.location_ids !== undefined) s.location_ids = Array.isArray(v.location_ids) ? v.location_ids.map(String).slice(0, 200) : [];
  if (v.refresh !== undefined) s.refresh = [0, 60, 300, 900, 3600].includes(Number(v.refresh)) ? Number(v.refresh) : 0;
  if (v.compare !== undefined) s.compare = !!v.compare;
  return s;
}

function cleanWidgets(app: App, list: unknown): Widget[] {
  if (!Array.isArray(list)) throw bad('Widgets fehlen');
  if (list.length > 40) throw bad('Höchstens 40 Widgets je Dashboard');
  const clamp = (v: unknown, lo: number, hi: number, d: number) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(Number(v)) ? Number(v) : d)));
  return list.map((w: any) => {
    const reportId = w?.report_id ? String(w.report_id) : undefined;
    if (reportId && !app.db.get('SELECT id FROM report_definitions WHERE id = ?', reportId)) throw bad('Gespeicherter Bericht nicht gefunden');
    const width = clamp(w?.w, 1, 12, 6);
    return {
      id: w?.id && /^[\w-]{1,40}$/.test(String(w.id)) ? String(w.id) : id(10),
      title: str(w?.title, 'Titel', { max: 120 }) || 'Bericht',
      ...(reportId ? { report_id: reportId } : { config: cleanConfig(app, w?.config) }),
      w: width,
      h: clamp(w?.h, 1, 12, 4),
      x: clamp(w?.x, 0, 12 - width, 0),
      y: clamp(w?.y, 0, 1000, 0),
    };
  });
}

/** Widget configs with library reports resolved (a report the viewer may not see becomes an error). */
function resolveWidget(app: App, p: Principal, w: Widget): { config?: ReportConfig; error?: string } {
  if (!w.report_id) return { config: w.config };
  const r = parseJson(app.db.get('SELECT * FROM report_definitions WHERE id = ?', w.report_id), ['config']);
  if (!r) return { error: 'Bericht wurde gelöscht' };
  if (!canSee(p, r as Owned)) return { error: 'Kein Zugriff auf diesen Bericht' };
  return { config: r.config };
}

function dashboardData(app: App, p: Principal, dash: any, overrides: { range?: unknown; scope?: string; locationIds?: unknown; compare?: boolean } = {}) {
  const s = dash.settings ?? {};
  const range = overrides.range ?? s.range ?? 'last_30_days';
  const scope = overrides.scope ?? s.scope ?? 'location';
  const locationIds = overrides.locationIds ?? s.location_ids;
  const widgets = (dash.widgets as Widget[]).map((w) => {
    const { config, error } = resolveWidget(app, p, w);
    if (!config) return { id: w.id, error };
    try {
      const result = run(app, p, config.query, { scope, locationIds, ...(config.fixed_range ? {} : { range }), ...(overrides.compare ? { compare: true } : {}) });
      return { id: w.id, viz: config.viz, result };
    } catch (e) {
      return { id: w.id, viz: config.viz, error: (e as Error).message };
    }
  });
  return { widgets, range, scope };
}

// --- MCP ----------------------------------------------------------------------------------------

const RO = { readOnlyHint: true, openWorldHint: false };
const queryProps = {
  location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (bei Agentur-Schlüsseln; sonst der des Schlüssels)' },
  source: { type: 'string', description: 'Datenquelle, z. B. contacts, opportunities, tasks, appointments, messages, conversations, calls, invoices, invoice_items, subscriptions, campaigns, form_submissions, attribution, affiliate_commissions, course_enrollments (Liste: GET /api/reports/sources)' },
  measures: { type: 'array', items: { type: 'string' }, description: 'Kennzahlen: "count", "sum:<feld>", "avg:<feld>", "min:<feld>", "max:<feld>", "count_distinct:<feld>", "calc:<kennzahl>" (z. B. calc:win_rate, calc:forecast, calc:mrr, calc:no_show_rate)' },
  group_by: { type: 'array', items: { type: 'string' }, description: 'Bis zu 2 Gruppierungen, Datumsfelder mit Einheit: "stage", "created_at:month" (day|week|month|quarter|year|weekday|hour), "location" = Sub-Account' },
  filters: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, op: { type: 'string' }, value: { description: 'Vergleichswert: Text, Zahl, Liste oder Zeitraum – je nach Operator' } }, required: ['field', 'op'] }, description: 'z. B. {"field":"status","op":"eq","value":"won"}; Operatoren: eq, neq, in, not_in, contains, gt, gte, lt, lte, between, empty, not_empty, is_true, is_false, has (Tags), in_range (Datum, Wert = Zeitraum)' },
  range: { description: 'Zeitraum: today, yesterday, this_week, last_week, last_7_days, last_30_days, last_90_days, last_365_days, this_month, last_month, this_quarter, last_quarter, this_year, last_year, last_12_months, all – oder {"from":"2026-01-01","to":"2026-03-31"}' },
  date_field: { type: 'string', description: 'Datumsfeld für den Zeitraum (Standard je Quelle, z. B. created_at, won_at, paid_at)' },
  compare: { type: 'boolean', description: 'Mit Vorperiode vergleichen' },
  scope: { type: 'string', enum: ['location', 'all'], description: 'all = alle erlaubten Sub-Accounts (Agentur)' },
  limit: { type: 'integer', description: 'Höchstens so viele Gruppen (Top N)' },
};

async function toolLocation(call: { agency: boolean; locationId?: string; api: (m: string, p: string, o?: any) => Promise<any> }, loc?: string) {
  if (!call.agency) return undefined;
  if (loc) return loc;
  const list: any[] = await call.api('GET', '/api/agency/projects');
  if (!list.length) throw new HttpError(400, 'Kein Sub-Account vorhanden');
  return list[0].id as string;
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_run_report',
    title: 'Bericht ausführen',
    description: 'Freier Bericht über jede Datenquelle: Kennzahlen (Anzahl, Summe, Ø, Win-Rate, Prognose, MRR …) gruppiert nach bis zu 2 Feldern, mit Filtern, Zeitraum und Vergleich zur Vorperiode. Antwort: Spalten, Zeilen (k = Schlüssel, l = Beschriftung, v = Werte, p = Vorperiode) und Summen.',
    inputSchema: { type: 'object', properties: queryProps, required: ['source'], additionalProperties: false },
    annotations: RO,
    run: async (call, a) => {
      const { location_id, scope, ...query } = a;
      const location = await toolLocation(call, location_id);
      if (!call.agency && location_id && location_id !== call.locationId) throw new HttpError(403, 'Dieser Schlüssel gilt nur für einen Sub-Account');
      return call.api('POST', '/api/reports/run', { location, body: { query, scope } });
    },
  },
  {
    name: 'ghl_list_dashboards',
    title: 'Dashboards auflisten',
    description: 'Eigene und geteilte Dashboards (Name, Freigabe, Widgets, Zeitraum).',
    inputSchema: { type: 'object', properties: { location_id: queryProps.location_id }, additionalProperties: false },
    annotations: RO,
    run: async (call, a) => {
      const location = await toolLocation(call, a.location_id);
      const r = await call.api('GET', '/api/reports/dashboards', { location });
      return { default_id: r.default_id, dashboards: r.dashboards.map((d: any) => ({ id: d.id, name: d.name, visibility: d.visibility, location_id: d.location_id, widgets: d.widgets.map((w: any) => w.title), range: d.settings?.range ?? 'last_30_days' })) };
    },
  },
  {
    name: 'ghl_get_dashboard',
    title: 'Dashboard mit Zahlen',
    description: 'Ein Dashboard samt Ergebnissen aller Widgets (optional anderer Zeitraum).',
    inputSchema: { type: 'object', properties: { location_id: queryProps.location_id, dashboard_id: { type: 'string' }, range: queryProps.range }, required: ['dashboard_id'], additionalProperties: false },
    annotations: RO,
    run: async (call, a) => {
      const location = await toolLocation(call, a.location_id);
      const dash = await call.api('GET', `/api/reports/dashboards/${encodeURIComponent(a.dashboard_id)}`, { location });
      const qs = a.range ? `?range=${encodeURIComponent(typeof a.range === 'string' ? a.range : JSON.stringify(a.range))}` : '';
      const data = await call.api('GET', `/api/reports/dashboards/${encodeURIComponent(a.dashboard_id)}/data${qs}`, { location });
      return {
        id: dash.id,
        name: dash.name,
        range: data.range,
        widgets: dash.widgets.map((w: any) => {
          const d = data.widgets.find((x: any) => x.id === w.id);
          const r = d?.result;
          return r ? { title: w.title, viz: d.viz, range: r.range.label, measures: r.measures, dims: r.dims, totals: r.totals, rows: r.rows.slice(0, 50) } : { title: w.title, error: d?.error };
        }),
      };
    },
  },
];

// --- module -------------------------------------------------------------------------------------

export const reportsModule: Module = {
  name: 'reports',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE report_definitions (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, owner_id TEXT,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', config TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE report_dashboards (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, owner_id TEXT,
        name TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', widgets TEXT NOT NULL DEFAULT '[]',
        settings TEXT NOT NULL DEFAULT '{}', template TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE report_user_prefs (user_id TEXT PRIMARY KEY, default_dashboard_id TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE report_schedules (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
        dashboard_id TEXT REFERENCES report_dashboards(id) ON DELETE CASCADE, report_id TEXT REFERENCES report_definitions(id) ON DELETE CASCADE,
        frequency TEXT NOT NULL DEFAULT 'weekly', weekday INTEGER NOT NULL DEFAULT 1, monthday INTEGER NOT NULL DEFAULT 1, hour INTEGER NOT NULL DEFAULT 8,
        recipients TEXT NOT NULL DEFAULT '[]', range TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
        next_at TEXT, last_sent_at TEXT, last_status TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX report_schedules_due ON report_schedules(active, next_at);
      `,
    ],
    // Won/lost dates for reports (win rate per period, deal velocity); older deals use their last change.
    ['002-opportunity-closed-at', `ALTER TABLE opportunities ADD COLUMN closed_at TEXT; UPDATE opportunities SET closed_at = updated_at WHERE status != 'open';`],
  ],
  register(app) {
    const { db, router } = app;
    app.services.reportSources = [...BUILTIN_SOURCES, ...(app.services.reportSources ?? [])];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    // Keep closed_at in step with the deal status.
    app.events.on('opportunity.status_changed', (e) => {
      const o = e.data.opportunity;
      if (o?.id) db.run(`UPDATE opportunities SET closed_at = CASE WHEN status = 'open' THEN NULL ELSE COALESCE(?, closed_at) END WHERE id = ?`, e.at, o.id);
    });
    app.events.on('opportunity.created', (e) => {
      const o = e.data.opportunity;
      if (o?.id && o.status && o.status !== 'open') db.run('UPDATE opportunities SET closed_at = COALESCE(closed_at, created_at) WHERE id = ?', o.id);
    });

    // --- metadata & running -------------------------------------------------------------------
    router.get('/api/reports/sources', 'location', (ctx) => {
      const p = principal(ctx);
      const u = p.user;
      const blocked = app.services.saasAreaBlocked as ((loc: string, area: string) => boolean) | undefined;
      return {
        sources: sourcesFor(app, p)
          .filter((s) => !u || u.role === 'admin' || !u.permissions || u.permissions.includes(s.area as Permission))
          .filter((s) => isAdmin(p) || !blocked?.(p.locationId, s.area))
          .map((s) => ({
            key: s.key,
            label: s.label,
            description: s.description ?? '',
            dateField: s.dateField,
            countLabel: s.countLabel ?? 'Anzahl',
            fields: usableFields(db, s).map((f) => ({
              key: f.key,
              label: f.label,
              type: f.type,
              format: f.format,
              group: f.group,
              options: f.options,
              lookup: !!f.lookup,
              groupable: !f.noGroup && f.type !== 'number' && f.type !== 'tags',
              ops: OPS[f.type],
            })),
            calcs: (s.calcs ?? []).filter((c) => !c.join || s.joins?.[c.join]).map((c) => ({ key: c.key, label: c.label, format: c.format ?? 'number', description: c.description ?? '' })),
          })),
        ranges: RANGE_PRESETS,
        canAgency: isAdmin(p) || (u?.locations.length ?? 0) > 1,
        locations: (isAdmin(p) ? visibleLocations(app, u, db.all('SELECT id, name FROM locations ORDER BY name')) : db.all(`SELECT id, name FROM locations WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name`, JSON.stringify(u ? u.locations : [p.locationId]))),
      };
    });

    const body = (ctx: Ctx) => (ctx.body?.query && typeof ctx.body.query === 'object' ? ctx.body.query : ctx.body);
    router.post('/api/reports/run', 'location', (ctx) => run(app, principal(ctx), body(ctx), { scope: ctx.body?.scope, locationIds: ctx.body?.location_ids }));
    router.post('/api/reports/export.csv', 'location', (ctx) => {
      const r = run(app, principal(ctx), body(ctx), { scope: ctx.body?.scope, locationIds: ctx.body?.location_ids });
      const file = `${(str(ctx.body?.name, 'Name', { max: 80 }) || r.source.label).replace(/[^\wäöüÄÖÜß-]+/g, '-')}.csv`;
      return { __raw: true as const, status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${encodeURIComponent(file)}"` }, body: toCsv(r) };
    });
    router.get('/api/reports/values', 'location', (ctx) =>
      asHttp(() => {
        const list = sourcesFor(app, principal(ctx));
        const src = list.find((s) => s.key === ctx.query.get('source'));
        if (!src) throw bad('Unbekannte Datenquelle');
        const locations = allowedLocations(app, principal(ctx), src, ctx.query.get('scope') ?? 'location');
        return fieldValues({ db, sources: list, locations, tz: tzOf(app, ctx.locationId), timeoutMs: 4000, ...rowScope(app, principal(ctx), locations) }, src.key, String(ctx.query.get('field') ?? ''));
      }),
    );

    // --- library ------------------------------------------------------------------------------
    const getReport = (rid: string) => parseJson(db.get('SELECT * FROM report_definitions WHERE id = ?', rid), ['config']);
    const visibleReport = (ctx: Ctx, rid: string) => {
      const r = getReport(rid);
      if (!r || !canSee(principal(ctx), r as Owned)) throw notFound('Bericht nicht gefunden');
      return r;
    };
    router.get('/api/reports/library', 'location', (ctx) => {
      const p = principal(ctx);
      return db
        .all('SELECT * FROM report_definitions ORDER BY updated_at DESC LIMIT 1000')
        .map((r) => parseJson(r, ['config']))
        .filter((r) => canSee(p, r as Owned))
        .map((r) => ({ ...r, can_edit: canEdit(p, r as Owned) }));
    });
    router.get('/api/reports/library/:id', 'location', (ctx) => {
      const r = visibleReport(ctx, ctx.params.id);
      return { ...r, can_edit: canEdit(principal(ctx), r as Owned) };
    });
    router.post('/api/reports/library', 'location', (ctx) => {
      const u = needUser(principal(ctx));
      const row = {
        id: id(),
        location_id: ctx.locationId,
        owner_id: u.id,
        name: str(ctx.body.name, 'Name', { required: true, max: 120 }),
        description: str(ctx.body.description, 'Beschreibung', { max: 1000 }),
        config: cleanConfig(app, ctx.body.config),
        visibility: cleanVisibility(ctx.body.visibility),
        created_at: now(),
        updated_at: now(),
      };
      db.insert('report_definitions', row);
      return row;
    });
    router.patch('/api/reports/library/:id', 'location', (ctx) => {
      const r = visibleReport(ctx, ctx.params.id);
      if (!canEdit(principal(ctx), r as Owned)) throw new HttpError(403, 'Nur die Person, die den Bericht angelegt hat, kann ihn ändern');
      const patch: Record<string, unknown> = { updated_at: now() };
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 120 });
      if (ctx.body.description !== undefined) patch.description = str(ctx.body.description, 'Beschreibung', { max: 1000 });
      if (ctx.body.config !== undefined) patch.config = cleanConfig(app, ctx.body.config);
      if (ctx.body.visibility !== undefined) patch.visibility = cleanVisibility(ctx.body.visibility);
      db.update('report_definitions', r.id, patch);
      return getReport(r.id);
    });
    router.delete('/api/reports/library/:id', 'location', (ctx) => {
      const r = visibleReport(ctx, ctx.params.id);
      if (!canEdit(principal(ctx), r as Owned)) throw new HttpError(403, 'Nur die Person, die den Bericht angelegt hat, kann ihn löschen');
      db.run('DELETE FROM report_definitions WHERE id = ?', r.id);
      return { ok: true };
    });

    // --- dashboards ---------------------------------------------------------------------------
    const getDash = (did: string) => parseJson(db.get('SELECT * FROM report_dashboards WHERE id = ?', did), DASH_JSON);
    const visibleDash = (ctx: Ctx, did: string) => {
      const d = getDash(did);
      if (!d || !canSee(principal(ctx), d as Owned)) throw notFound('Dashboard nicht gefunden');
      return d;
    };
    const withMeta = (p: Principal, d: any) => ({ ...d, can_edit: canEdit(p, d as Owned), is_owner: !!p.user && d.owner_id === p.user.id });
    const defaultOf = (u?: User) => (u ? db.get('SELECT default_dashboard_id d FROM report_user_prefs WHERE user_id = ?', u.id)?.d ?? null : null);

    router.get('/api/reports/dashboards', 'location', (ctx) => {
      const p = principal(ctx);
      const list = db
        .all('SELECT * FROM report_dashboards ORDER BY name COLLATE NOCASE LIMIT 1000')
        .map((d) => parseJson(d, DASH_JSON))
        .filter((d) => canSee(p, d as Owned))
        .map((d) => withMeta(p, d));
      return { dashboards: list, default_id: defaultOf(p.user) };
    });
    router.get('/api/reports/dashboards/:id', 'location', (ctx) => withMeta(principal(ctx), visibleDash(ctx, ctx.params.id)));
    router.get('/api/reports/dashboards/:id/data', 'location', (ctx) => cached(app, ctx, 15_000, () => {
      const d = visibleDash(ctx, ctx.params.id);
      const q = ctx.query;
      let range: unknown;
      const r = q.get('range');
      if (r) {
        try {
          range = r.startsWith('{') ? JSON.parse(r) : r;
        } catch {
          throw bad('Ungültiger Zeitraum');
        }
      }
      return dashboardData(app, principal(ctx), d, {
        range,
        scope: q.get('scope') ?? undefined,
        locationIds: q.getAll('location_id').length ? q.getAll('location_id') : undefined,
        compare: q.get('compare') === '1' ? true : undefined,
      });
    }));
    router.post('/api/reports/dashboards', 'location', (ctx) => {
      const u = needUser(principal(ctx));
      const row = {
        id: id(),
        location_id: ctx.locationId,
        owner_id: u.id,
        name: str(ctx.body.name, 'Name', { required: true, max: 120 }),
        visibility: cleanVisibility(ctx.body.visibility),
        widgets: cleanWidgets(app, ctx.body.widgets ?? []),
        settings: cleanSettings(ctx.body.settings, { range: 'last_30_days', scope: 'location', refresh: 0 }),
        template: null,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('report_dashboards', row);
      return withMeta(principal(ctx), row);
    });
    router.patch('/api/reports/dashboards/:id', 'location', (ctx) => {
      const p = principal(ctx);
      const d = visibleDash(ctx, ctx.params.id);
      if (!canEdit(p, d as Owned)) throw new HttpError(403, 'Dieses Dashboard kannst du nur ansehen');
      const patch: Record<string, unknown> = { updated_at: now() };
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 120 });
      // Only the owner decides who else sees it.
      if (ctx.body.visibility !== undefined && d.owner_id === p.user!.id) patch.visibility = cleanVisibility(ctx.body.visibility);
      if (ctx.body.widgets !== undefined) patch.widgets = cleanWidgets(app, ctx.body.widgets);
      if (ctx.body.settings !== undefined) patch.settings = cleanSettings(ctx.body.settings, d.settings);
      db.update('report_dashboards', d.id, patch);
      return withMeta(p, getDash(d.id));
    });
    router.delete('/api/reports/dashboards/:id', 'location', (ctx) => {
      const p = principal(ctx);
      const d = visibleDash(ctx, ctx.params.id);
      if (!p.user || (d.owner_id !== p.user.id && p.user.role !== 'admin')) throw new HttpError(403, 'Nur die Person, die das Dashboard angelegt hat, kann es löschen');
      db.run('DELETE FROM report_dashboards WHERE id = ?', d.id);
      db.run('UPDATE report_user_prefs SET default_dashboard_id = NULL WHERE default_dashboard_id = ?', d.id);
      return { ok: true };
    });
    router.put('/api/reports/default', 'location', (ctx) => {
      const u = needUser(principal(ctx));
      const did = ctx.body.dashboard_id ? String(ctx.body.dashboard_id) : null;
      if (did) visibleDash(ctx, did);
      db.run(
        `INSERT INTO report_user_prefs (user_id, default_dashboard_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET default_dashboard_id = excluded.default_dashboard_id, updated_at = excluded.updated_at`,
        u.id, did, now(),
      );
      return { default_id: did };
    });

    // --- templates ----------------------------------------------------------------------------
    router.get('/api/reports/templates', 'location', () => TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description, widgets: t.widgets.map((w) => w.title) })));
    router.post('/api/reports/templates/:key', 'location', (ctx) => {
      const u = needUser(principal(ctx));
      const t = TEMPLATES.find((x) => x.key === ctx.params.key);
      if (!t) throw notFound('Vorlage nicht gefunden');
      const available = new Set(sources(app).map((s) => s.key));
      const parts = t.widgets.filter((w) => available.has(String(w.config.query.source)));
      const pos = packWidgets(parts);
      const widgets: Widget[] = parts.map((w, i) => ({ id: id(10), title: w.title, config: w.config, w: w.w, h: w.h, ...pos[i] }));
      const row = {
        id: id(),
        location_id: ctx.locationId,
        owner_id: u.id,
        name: str(ctx.body?.name, 'Name', { max: 120 }) || t.name,
        visibility: cleanVisibility(ctx.body?.visibility),
        widgets,
        settings: { range: t.range, scope: 'location', refresh: 0 },
        template: t.key,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('report_dashboards', row);
      return withMeta(principal(ctx), row);
    });

    // --- scheduled e-mails --------------------------------------------------------------------
    const mailer = (loc: any, mail: OutMail): Promise<{ status: string }> => (app.services.reportMailer ?? deliverEmail)(loc, mail);
    const getSchedule = (sid: string) => parseJson(db.get('SELECT * FROM report_schedules WHERE id = ?', sid), ['recipients']);
    const mySchedule = (ctx: Ctx, sid: string) => {
      const u = needUser(principal(ctx));
      const s = getSchedule(sid);
      if (!s || (s.owner_id !== u.id && u.role !== 'admin')) throw notFound('Zeitplan nicht gefunden');
      return s;
    };
    const cleanRecipients = (v: unknown) => {
      const list = (Array.isArray(v) ? v : String(v ?? '').split(/[,;\s]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      if (!list.length) throw bad('Mindestens eine E-Mail-Adresse');
      if (list.length > 20) throw bad('Höchstens 20 Empfänger');
      for (const e of list) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw bad(`Ungültige E-Mail-Adresse: ${e}`);
      return [...new Set(list)];
    };
    const timing = (b: any, cur: any = {}) => {
      const frequency: Frequency = (b.frequency ?? cur.frequency) in FREQUENCIES ? (b.frequency ?? cur.frequency) : 'weekly';
      const int = (v: unknown, lo: number, hi: number, d: number) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
      };
      return { frequency, weekday: int(b.weekday ?? cur.weekday, 1, 7, 1), monthday: int(b.monthday ?? cur.monthday, 1, 28, 1), hour: int(b.hour ?? cur.hour, 0, 23, 8) };
    };

    /** Builds the e-mail of a schedule with the owner's rights at send time. */
    const buildEmail = (s: any) => {
      const owner = db.get('SELECT * FROM users WHERE id = ?', s.owner_id);
      if (!owner) throw new Error('Die Person, die den Zeitplan angelegt hat, gibt es nicht mehr');
      const p: Principal = {
        user: { id: owner.id, email: owner.email, name: owner.name, role: owner.role, locations: JSON.parse(owner.locations || '[]'), permissions: owner.permissions ? JSON.parse(owner.permissions) : null },
        locationId: s.location_id,
        // The owner's rights at send time: a person with a limited view gets a report of their own records.
        via: 'session',
      };
      const range = s.range || DEFAULT_SCHEDULE_RANGE[s.frequency as Frequency] || 'last_7_days';
      let title = '';
      let link = `${app.baseUrl()}/app/reports`;
      let widgets: { title: string; viz: string; result?: ReportResult; error?: string }[] = [];
      if (s.dashboard_id) {
        const d = getDash(s.dashboard_id);
        if (!d || !canSee(p, d as Owned)) throw new Error('Dashboard nicht gefunden');
        title = d.name;
        link = `${app.baseUrl()}/app/reports/d/${d.id}`;
        const data = dashboardData(app, p, d, { range, compare: true });
        widgets = (d.widgets as Widget[]).map((w) => {
          const x = data.widgets.find((y) => y.id === w.id)!;
          return { title: w.title, viz: x.viz ?? 'table', result: (x as any).result, error: x.error };
        });
      } else {
        const r = getReport(s.report_id);
        if (!r || !canSee(p, r as Owned)) throw new Error('Bericht nicht gefunden');
        title = r.name;
        link = `${app.baseUrl()}/app/reports/r/${r.id}`;
        try {
          widgets = [{ title: r.name, viz: r.config.viz, result: run(app, p, r.config.query, { ...(r.config.fixed_range ? {} : { range }), compare: true }) }];
        } catch (e) {
          widgets = [{ title: r.name, viz: r.config.viz, error: (e as Error).message }];
        }
      }
      // The period the schedule reports on (fixed-range widgets keep theirs, e.g. "open invoices").
      const period = s.report_id ? (widgets[0]?.result?.range ?? resolveRange(range, tzOf(app, s.location_id)).current) : resolveRange(range, tzOf(app, s.location_id)).current;
      const brand = effectiveBranding(app, s.location_id).name || 'HyperLevel';
      const mail = renderReportEmail({ title, rangeLabel: `${period.label} · ${period.dates}`, link, brand, widgets });
      return { subject: s.subject || `${title} – ${period.label}`, ...mail };
    };

    const sendSchedule = async (s: any) => {
      const loc = app.location(s.location_id);
      if (!loc) return 'Sub-Account fehlt';
      let status = '';
      try {
        const mail = buildEmail(s);
        const results: string[] = [];
        for (const to of s.recipients as string[]) results.push((await mailer(loc, { to, subject: mail.subject, html: mail.html, text: mail.text })).status);
        status = results.includes('sent') ? `gesendet an ${results.length}` : results.includes('logged') ? 'nur protokolliert (kein E-Mail-Versand eingerichtet)' : results.join(', ');
      } catch (e) {
        status = `Fehler: ${(e as Error).message}`;
      }
      db.run('UPDATE report_schedules SET last_sent_at = ?, last_status = ? WHERE id = ?', now(), status.slice(0, 300), s.id);
      return status;
    };

    /** Sends every due schedule once and moves it to its next date (also used by tests). */
    const runDue = async (at = new Date()) => {
      const due = db.all('SELECT * FROM report_schedules WHERE active = 1 AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT 50', at.toISOString());
      for (const raw of due) {
        const s = parseJson(raw, ['recipients']);
        db.run('UPDATE report_schedules SET next_at = ? WHERE id = ?', nextRun(s as any, tzOf(app, s.location_id), at).toISOString(), s.id);
        await sendSchedule(s);
      }
      return due.length;
    };
    app.services.reportSchedulesRun = runDue;
    app.onTick(() => runDue().then(() => undefined));

    router.get('/api/reports/schedules', 'location', (ctx) => {
      const u = needUser(principal(ctx));
      const rows = u.role === 'admin' ? db.all('SELECT * FROM report_schedules ORDER BY created_at DESC') : db.all('SELECT * FROM report_schedules WHERE owner_id = ? ORDER BY created_at DESC', u.id);
      return rows.map((r) => {
        const s = parseJson(r, ['recipients']);
        const target = s.dashboard_id ? db.get('SELECT name FROM report_dashboards WHERE id = ?', s.dashboard_id) : db.get('SELECT name FROM report_definitions WHERE id = ?', s.report_id);
        return { ...s, target_name: target?.name ?? '–' };
      });
    });
    router.post('/api/reports/schedules', 'location', (ctx) => {
      const p = principal(ctx);
      const u = needUser(p);
      const b = ctx.body ?? {};
      const dashboardId = b.dashboard_id ? String(b.dashboard_id) : null;
      const reportId = !dashboardId && b.report_id ? String(b.report_id) : null;
      if (dashboardId) visibleDash(ctx, dashboardId);
      else if (reportId) visibleReport(ctx, reportId);
      else throw bad('Dashboard oder Bericht wählen');
      const t = timing(b);
      const row = {
        id: id(),
        location_id: ctx.locationId,
        owner_id: u.id,
        dashboard_id: dashboardId,
        report_id: reportId,
        ...t,
        recipients: cleanRecipients(b.recipients),
        range: b.range && RANGE_PRESETS[b.range] ? String(b.range) : '',
        subject: str(b.subject, 'Betreff', { max: 200 }),
        active: b.active === false ? 0 : 1,
        next_at: nextRun(t, tzOf(app, ctx.locationId), new Date()).toISOString(),
        last_status: '',
        created_at: now(),
      };
      db.insert('report_schedules', row);
      return getSchedule(row.id);
    });
    router.patch('/api/reports/schedules/:id', 'location', (ctx) => {
      const s = mySchedule(ctx, ctx.params.id);
      const b = ctx.body ?? {};
      const t = timing(b, s);
      const patch: Record<string, unknown> = { ...t, next_at: nextRun(t, tzOf(app, s.location_id), new Date()).toISOString() };
      if (b.recipients !== undefined) patch.recipients = cleanRecipients(b.recipients);
      if (b.range !== undefined) patch.range = RANGE_PRESETS[b.range] ? String(b.range) : '';
      if (b.subject !== undefined) patch.subject = str(b.subject, 'Betreff', { max: 200 });
      if (b.active !== undefined) patch.active = b.active ? 1 : 0;
      db.update('report_schedules', s.id, patch);
      return getSchedule(s.id);
    });
    router.delete('/api/reports/schedules/:id', 'location', (ctx) => {
      const s = mySchedule(ctx, ctx.params.id);
      db.run('DELETE FROM report_schedules WHERE id = ?', s.id);
      return { ok: true };
    });
    router.post('/api/reports/schedules/:id/send', 'location', async (ctx) => ({ status: await sendSchedule(mySchedule(ctx, ctx.params.id)) }));
    router.get('/api/reports/schedules/:id/preview', 'location', (ctx) => {
      const s = mySchedule(ctx, ctx.params.id);
      try {
        const mail = buildEmail(s);
        return { subject: mail.subject, html: mail.html, text: mail.text };
      } catch (e) {
        throw bad((e as Error).message);
      }
    });
  },
};
