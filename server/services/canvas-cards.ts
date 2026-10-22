/**
 * Live CRM cards on the canvas: resolves {kind, id} references to current data with the viewer's
 * rights. Every kind first runs the app's own guards against the route of its area (member areas,
 * SaaS plan – same rules as the REST API), then reads the record filtered by the sub-account.
 * Records of other sub-accounts or areas the viewer lacks come back as an error card, never as data.
 */

import type { App } from '../core/app.js';
import { HttpError, type Ctx } from '../core/http.js';
import { parseJson } from '../core/db.js';
import type { CardData } from './canvas-render.js';
import type { CardKind } from './canvas-model.js';
import { callRoute } from './route-call.js';
import { isOverdue } from './pm-core.js';

const PROBE: Record<CardKind, string> = {
  contact: '/api/contacts',
  company: '/api/companies',
  deal: '/api/opportunities',
  task: '/api/tasks',
  ticket: '/api/tickets',
  appointment: '/api/appointments',
  project: '/api/dashboard',
  report: '/api/reports/run',
  pipeline: '/api/opportunities',
};

/** May the caller use the area behind a route? (guards of the app: member rights, SaaS plan) */
export function areaAllowed(app: App, ctx: Ctx, path: string, method = 'GET'): boolean {
  const url = new URL(path, 'http://local');
  const sub: Ctx = { ...ctx, method, url, path: url.pathname, query: url.searchParams, params: {}, body: {}, rawBody: '' };
  try {
    for (const g of app.guards) g(sub, 'location');
    return true;
  } catch (e) {
    if (e instanceof HttpError) return false;
    throw e;
  }
}

const euro = (v: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v || 0);
const name = (c: any) => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.email || c?.phone || 'Unbekannt';
const tags = (v: unknown): string[] => {
  try {
    const t = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(t) ? t.map(String) : [];
  } catch {
    return [];
  }
};

function dateIn(iso: string | null | undefined, tz: string, withTime = true): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleString('de-DE', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
}

const TICKET_STATUS: Record<string, [string, NonNullable<CardData['badge']>['tone']]> = {
  new: ['Neu', 'blue'],
  open: ['Offen', 'yellow'],
  waiting: ['Wartet', 'gray'],
  resolved: ['Gelöst', 'green'],
  closed: ['Geschlossen', 'gray'],
};
const PRIORITY: Record<string, string> = { low: 'Niedrig', normal: 'Normal', high: 'Hoch', urgent: 'Dringend' };

async function resolveOne(app: App, ctx: Ctx, kind: CardKind, id: string, tz: string): Promise<CardData> {
  const { db } = app;
  const loc = ctx.locationId;
  const missing = (what: string): CardData => ({ ok: false, error: `${what} nicht gefunden (gelöscht oder in einem anderen Sub-Account)` });
  switch (kind) {
    case 'contact': {
      const c = db.get('SELECT * FROM contacts WHERE id = ? AND location_id = ?', id, loc);
      if (!c) return missing('Kontakt');
      const deals = db.get<{ n: number; v: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM opportunities WHERE contact_id = ? AND location_id = ? AND status = 'open'`, id, loc)!;
      const t = tags(c.tags);
      return {
        ok: true,
        title: name(c),
        subtitle: [c.company, c.city].filter(Boolean).join(' · ') || c.email || '',
        badge: t[0] ? { text: t[0], tone: 'blue' } : c.source ? { text: String(c.source), tone: 'gray' } : undefined,
        fields: [
          ['E-Mail', c.email || '–'],
          ['Telefon', c.phone || '–'],
          ['Offene Deals', deals.n ? `${deals.n} · ${euro(deals.v)}` : 'keine'],
          ['Tags', t.join(', ') || '–'],
          ['Letzte Aktivität', dateIn(c.last_activity_at ?? c.updated_at, tz)],
        ],
        url: `/app/contacts/${c.id}`,
      };
    }
    case 'company': {
      const c = db.get('SELECT * FROM companies WHERE id = ? AND location_id = ?', id, loc);
      if (!c) return missing('Firma');
      let contacts = 0;
      try {
        contacts = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM associations WHERE location_id = ? AND ((a_type = 'company' AND a_id = ?) OR (b_type = 'company' AND b_id = ?))`, loc, id, id)?.n ?? 0);
      } catch {
        contacts = 0;
      }
      return {
        ok: true,
        title: c.name,
        subtitle: [c.industry, c.city].filter(Boolean).join(' · ') || c.domain || '',
        badge: c.lifecycle_stage ? { text: String(c.lifecycle_stage), tone: 'purple' } : undefined,
        fields: [
          ['Domain', c.domain || '–'],
          ['Telefon', c.phone || '–'],
          ['Größe', c.size || '–'],
          ['Verknüpft', contacts ? `${contacts} Datensätze` : '–'],
        ],
        url: `/app/companies/${c.id}`,
      };
    }
    case 'deal': {
      const o = db.get('SELECT o.*, c.first_name, c.last_name, c.email, p.name AS pipeline, p.stages FROM opportunities o JOIN pipelines p ON p.id = o.pipeline_id LEFT JOIN contacts c ON c.id = o.contact_id WHERE o.id = ? AND o.location_id = ?', id, loc);
      if (!o) return missing('Deal');
      const stage = (parseJson(o, ['stages']).stages as any[]).find((s) => s.id === o.stage_id)?.name ?? '';
      const tone = o.status === 'won' ? 'green' : o.status === 'lost' ? 'red' : o.status === 'abandoned' ? 'gray' : 'blue';
      const status = { open: 'Offen', won: 'Gewonnen', lost: 'Verloren', abandoned: 'Aufgegeben' }[o.status as string] ?? o.status;
      return {
        ok: true,
        title: o.name,
        subtitle: `${o.pipeline}${stage ? ` · ${stage}` : ''}`,
        badge: { text: status, tone },
        fields: [
          ['Wert', euro(o.value)],
          ['Kontakt', name(o)],
          ['In Stufe seit', dateIn(o.stage_changed_at ?? o.created_at, tz, false)],
          ['Aktualisiert', dateIn(o.updated_at, tz)],
        ],
        url: `/app/opportunities?pipeline=${o.pipeline_id}`,
      };
    }
    case 'task': {
      const t = db.get('SELECT t.*, c.first_name, c.last_name, c.email, u.name AS assignee FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id LEFT JOIN users u ON u.id = t.assigned_to WHERE t.id = ? AND t.location_id = ?', id, loc);
      if (!t) return missing('Aufgabe');
      const overdue = !t.done && isOverdue(t.due_at, tz);
      return {
        ok: true,
        title: t.title,
        subtitle: t.description ? String(t.description).replace(/\s+/g, ' ').slice(0, 120) : '',
        badge: t.done ? { text: 'Erledigt', tone: 'green' } : overdue ? { text: 'Überfällig', tone: 'red' } : { text: 'Offen', tone: 'yellow' },
        fields: [
          ['Fällig', t.due_at ? dateIn(t.due_at, tz, !String(t.due_at).endsWith('T00:00:00.000Z')) : '–'],
          ['Kontakt', t.contact_id ? name(t) : '–'],
          ['Zuständig', t.assignee || '–'],
        ],
        url: '/app/tasks',
      };
    }
    case 'ticket': {
      const t = db.get('SELECT t.*, c.first_name, c.last_name, c.email, u.name AS owner FROM tickets t LEFT JOIN contacts c ON c.id = t.contact_id LEFT JOIN users u ON u.id = t.owner_id WHERE t.id = ? AND t.location_id = ?', id, loc);
      if (!t) return missing('Ticket');
      const [label, tone] = TICKET_STATUS[t.status_kind] ?? [t.status_kind, 'gray'];
      return {
        ok: true,
        title: `#${t.number} ${t.subject}`,
        subtitle: t.contact_id ? name(t) : t.category || '',
        badge: { text: label, tone },
        fields: [
          ['Priorität', PRIORITY[t.priority] ?? t.priority],
          ['Bearbeiter', t.owner || 'Nicht zugewiesen'],
          ['Fällig', dateIn(t.due_at, tz)],
          ['Erstellt', dateIn(t.created_at, tz)],
        ],
        url: `/app/tickets/${t.id}`,
      };
    }
    case 'appointment': {
      const a = db.get('SELECT a.*, c.first_name, c.last_name, c.email, k.name AS calendar FROM appointments a JOIN calendars k ON k.id = a.calendar_id LEFT JOIN contacts c ON c.id = a.contact_id WHERE a.id = ? AND a.location_id = ?', id, loc);
      if (!a) return missing('Termin');
      const status = { confirmed: ['Bestätigt', 'green'], cancelled: ['Abgesagt', 'red'], canceled: ['Abgesagt', 'red'], showed: ['Erschienen', 'green'], noshow: ['Nicht erschienen', 'red'], pending: ['Offen', 'yellow'] }[a.status as string] ?? [a.status, 'gray'];
      return {
        ok: true,
        title: a.title,
        subtitle: a.calendar,
        badge: { text: status[0], tone: status[1] as any },
        fields: [
          ['Beginn', dateIn(a.start_at, tz)],
          ['Kontakt', a.contact_id ? name(a) : '–'],
          ['Quelle', a.source || '–'],
        ],
        url: '/app/calendars',
      };
    }
    case 'project': {
      const row = db.get('SELECT data FROM project_profiles WHERE location_id = ?', loc);
      const p = row ? (JSON.parse(row.data || '{}') as any) : {};
      const l = app.location(loc);
      const stats = db.get<{ contacts: number; deals: number; value: number; tasks: number }>(
        `SELECT (SELECT COUNT(*) FROM contacts WHERE location_id = ?) AS contacts, (SELECT COUNT(*) FROM opportunities WHERE location_id = ? AND status = 'open') AS deals,
           (SELECT COALESCE(SUM(value), 0) FROM opportunities WHERE location_id = ? AND status = 'open') AS value, (SELECT COUNT(*) FROM tasks WHERE location_id = ? AND done = 0) AS tasks`,
        loc,
        loc,
        loc,
        loc,
      )!;
      const kpis = Array.isArray(p.kpis) ? p.kpis.slice(0, 2).map((k: any) => [String(k.label ?? 'KPI'), `${k.value ?? ''}${k.target ? ` / ${k.target}` : ''}`] as [string, string]) : [];
      return {
        ok: true,
        title: l?.name ?? 'Projekt',
        subtitle: p.tagline || p.website || '',
        badge: p.status ? { text: String(p.status), tone: p.status === 'live' ? 'green' : p.status === 'pausiert' ? 'gray' : 'blue' } : undefined,
        fields: [['Kontakte', String(stats.contacts)], ['Offene Deals', `${stats.deals} · ${euro(stats.value)}`], ['Offene Aufgaben', String(stats.tasks)], ...kpis],
        url: '/app/project',
      };
    }
    case 'pipeline': {
      const p = parseJson(db.get('SELECT * FROM pipelines WHERE id = ? AND location_id = ?', id, loc), ['stages']);
      if (!p) return missing('Pipeline');
      const rows = db.all<{ stage_id: string; name: string; value: number }>(`SELECT stage_id, name, value FROM opportunities WHERE pipeline_id = ? AND location_id = ? AND status = 'open' ORDER BY value DESC, updated_at DESC`, id, loc);
      const stages = (p.stages as { id: string; name: string }[]).map((s) => {
        const deals = rows.filter((r) => r.stage_id === s.id);
        return { name: s.name, count: deals.length, value: euro(deals.reduce((t, d) => t + (d.value || 0), 0)), deals: deals.map((d) => ({ name: d.name, value: euro(d.value) })) };
      });
      return { ok: true, title: p.name, total: `${rows.length} offen · ${euro(rows.reduce((t, d) => t + (d.value || 0), 0))}`, stages, url: `/app/opportunities?pipeline=${p.id}` };
    }
    case 'report': {
      const r = await callRoute(app, ctx, 'GET', `/api/reports/library/${encodeURIComponent(id)}`);
      const result = await callRoute(app, ctx, 'POST', '/api/reports/run', { query: r.config?.query ?? {} });
      const dims = result.dims ?? [];
      const meas = result.measures ?? [];
      const rows = (result.rows ?? []) as { l: string[]; v: (number | null)[] }[];
      const viz = String(r.config?.viz ?? 'bar');
      const kind = viz.includes('line') ? 'line' : viz.includes('area') ? 'area' : viz.includes('pie') ? 'pie' : viz.includes('donut') ? 'donut' : 'bar';
      const chart = dims.length
        ? { kind: kind as any, labels: rows.slice(0, 24).map((row) => row.l[0] ?? ''), series: meas.slice(0, 3).map((m: any, i: number) => ({ name: m.label, values: rows.slice(0, 24).map((row) => Number(row.v[i] ?? 0)) })) }
        : undefined;
      return {
        ok: true,
        title: r.name,
        subtitle: result.range?.label ?? '',
        chart,
        fields: dims.length ? [] : meas.map((m: any, i: number) => [m.label, String(result.totals?.v?.[i] ?? '–')] as [string, string]),
        url: `/app/reports/r/${r.id}`,
      };
    }
  }
}

/** Resolves many card references at once: `{ "kind:id": CardData }`. */
export async function resolveCards(app: App, ctx: Ctx, refs: { kind: string; id: string }[]): Promise<Record<string, CardData>> {
  const out: Record<string, CardData> = {};
  const tz = app.location(ctx.locationId)?.timezone || 'Europe/Berlin';
  const allowed = new Map<string, boolean>();
  for (const ref of refs.slice(0, 200)) {
    const kind = ref.kind as CardKind;
    const key = `${kind}:${ref.id}`;
    if (out[key] || !PROBE[kind]) continue;
    if (!allowed.has(kind)) allowed.set(kind, areaAllowed(app, ctx, PROBE[kind], kind === 'report' ? 'POST' : 'GET'));
    if (!allowed.get(kind)) {
      out[key] = { ok: false, error: 'Kein Zugriff auf diesen Bereich' };
      continue;
    }
    try {
      out[key] = { ...(await resolveOne(app, ctx, kind, String(ref.id), tz)), updatedAt: new Date().toISOString() };
    } catch (e) {
      out[key] = { ok: false, error: e instanceof HttpError ? (e.status === 404 ? 'Nicht gefunden' : e.status === 403 ? 'Kein Zugriff' : e.message) : 'Konnte nicht geladen werden' };
    }
  }
  return out;
}
