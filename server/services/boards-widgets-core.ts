/**
 * Living Boards: the built-in widgets. They register through the same `register()` any module uses (see
 * boards-widgets.ts) and read their data through the viewer's own API routes (`w.call`) – so member rights, the SaaS
 * plan and the sub-account filter of those routes apply exactly as on their own pages. Where a route does not offer
 * a filter the widget filters the (already permitted) rows itself.
 */

import type { App } from '../core/app.js';
import { addDaysYmd, hmInTz, ymdInTz, zonedToUtc } from '../core/time.js';
import { DEFAULT_EMBED_HOSTS, checkEmbedUrl } from './boards-embed.js';
import { CHART_PRESETS, KPI_PRESETS, RANGES, presetQuery, type ReportQuery } from './boards-presets.js';
import { loadPage } from './wiki-store.js';
import { WidgetRegistry, type ActionView, type ConfigField, type ListRow, type Tone, type View, type WidgetCtx, type WidgetDef } from './boards-widgets.js';

const euro = (v: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v || 0);
const nameOf = (c: any) => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.contact_name || c?.email || c?.contact_email || c?.phone || 'Unbekannt';
const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const opts = (...pairs: [string, string][]) => pairs;
const msg = (text: string, tone?: Tone): View => ({ kind: 'message', text, tone });

/** Pages a quick action may open, with the API route that decides who may use them. */
export const PAGE_TARGETS: Record<string, { label: string; access: string }> = {
  contacts: { label: 'Kontakte', access: '/api/contacts' },
  opportunities: { label: 'Opportunities', access: '/api/opportunities' },
  tasks: { label: 'Aufgaben', access: '/api/tasks' },
  pm: { label: 'Projektplanung', access: '/api/pm' },
  calendars: { label: 'Kalender', access: '/api/appointments' },
  conversations: { label: 'Konversationen', access: '/api/conversations' },
  tickets: { label: 'Tickets', access: '/api/tickets' },
  reports: { label: 'Berichte', access: '/api/reports' },
  invoices: { label: 'Rechnungen & Angebote', access: '/api/invoices' },
  wiki: { label: 'Wiki', access: '/api/wiki' },
  canvas: { label: 'Canvas', access: '/api/canvas' },
  calc: { label: 'Gewinnrechner', access: '/api/calc' },
  workflows: { label: 'Automationen', access: '/api/workflows' },
  'team-chat': { label: 'Team-Chat', access: '/api/team-chat' },
};

// --- numbers and charts ---------------------------------------------------------------------------------------------

const rangeField = (): ConfigField => ({ key: 'range', label: 'Zeitraum', type: 'select', options: RANGES, default: '' });
const compareField = (): ConfigField => ({ key: 'compare', label: 'Vergleich mit Vorperiode', type: 'select', options: opts(['', 'Wie vorgegeben'], ['yes', 'Mit Vorperiode'], ['no', 'Ohne']), default: '' });

/** The report query a kpi/chart config stands for: saved report, free query or preset, with range and comparison applied. */
async function reportQueryFor(w: WidgetCtx, config: Record<string, unknown>, kind: 'kpi' | 'chart'): Promise<{ query: ReportQuery; viz: string; title: string } | View> {
  let query: ReportQuery | undefined;
  let viz = '';
  let title = '';
  let fixed = false;
  const reportId = String(config.report_id ?? '');
  const free = config.query as ReportQuery | null | undefined;
  if (reportId) {
    const r = await w.call('GET', `/api/reports/library/${encodeURIComponent(reportId)}`).catch(() => null);
    if (!r?.config?.query) return msg('Der gespeicherte Bericht ist nicht mehr verfügbar.', 'yellow');
    query = r.config.query;
    viz = String(r.config.viz ?? '');
    title = String(r.name ?? '');
    fixed = !!r.config.fixed_range;
  } else if (free && typeof free === 'object' && free.source) {
    query = JSON.parse(JSON.stringify(free));
  } else {
    const p = presetQuery(kind, String(config.preset ?? ''));
    if (!p) return msg(kind === 'kpi' ? 'Wähle in den Einstellungen eine Kennzahl.' : 'Wähle in den Einstellungen ein Diagramm.', 'gray');
    query = p.query;
    viz = p.viz ?? '';
    title = p.label;
    fixed = p.fixedRange;
  }
  const range = String(config.range ?? '');
  // The person's own choice of a range wins; a fixed range ("open pipeline value") otherwise stays.
  if (range) query!.range = range;
  else if (!fixed && !query!.range) query!.range = kind === 'kpi' ? 'last_30_days' : 'last_90_days';
  const cmp = String(config.compare ?? '');
  if (cmp === 'yes') query!.compare = true;
  else if (cmp === 'no') query!.compare = false;
  return { query: query!, viz, title };
}

async function reportView(w: WidgetCtx, config: Record<string, unknown>, kind: 'kpi' | 'chart'): Promise<View> {
  const q = await reportQueryFor(w, config, kind);
  if ('kind' in q) return q;
  const result = await w.call('POST', '/api/reports/run', { query: q.query });
  const viz = kind === 'kpi' ? 'kpi' : String(config.viz || q.viz || 'bar');
  return { kind: 'report', viz, result, title: q.title, url: '/app/reports' };
}

// --- lists ------------------------------------------------------------------------------------------------------------

const dayDiff = (iso: string | null | undefined, now: Date) => (iso ? Math.floor((now.getTime() - new Date(iso).getTime()) / 864e5) : 0);

async function contactsList(w: WidgetCtx, c: Record<string, any>): Promise<View> {
  let tags: string[] = c.tag ? [String(c.tag)] : [];
  let q = String(c.q ?? '');
  let notTags: string[] = [];
  if (c.smart_list_id) {
    const lists: any[] = await w.call('GET', '/api/smart-lists').catch(() => []);
    const l = lists.find((x) => x.id === c.smart_list_id);
    if (!l) return msg('Die gespeicherte Liste gibt es nicht mehr.', 'yellow');
    tags = [...tags, ...((l.filter?.tags as string[]) ?? [])];
    notTags = (l.filter?.excludeTags as string[]) ?? [];
    q = q || String(l.filter?.q ?? '');
  }
  const sort = c.sort === 'name' ? 'name' : c.sort === 'activity' ? 'activity' : '';
  const params = new URLSearchParams({ limit: String(c.limit), ...(sort ? { sort } : {}), ...(q ? { q } : {}) });
  for (const t of tags) params.append('tag', t);
  for (const t of notTags) params.append('notTag', t);
  const r = await w.call('GET', `/api/contacts?${params}`);
  const rows: ListRow[] = (r.contacts as any[]).map((x) => ({ id: x.id, title: nameOf(x), subtitle: clip(x.company || x.email || x.phone, 60), at: x.created_at, badge: x.tags?.[0] ? { text: String(x.tags[0]), tone: 'blue' as Tone } : undefined, url: `contacts/${x.id}` }));
  return { kind: 'list', rows, total: r.total, empty: 'Keine Kontakte mit diesem Filter.', url: '/app/contacts' };
}

async function dealsList(w: WidgetCtx, c: Record<string, any>): Promise<View> {
  const status = ['open', 'won', 'lost'].includes(c.status) ? c.status : c.status === 'all' ? 'all' : 'open';
  const [deals, pipes] = await Promise.all([w.call('GET', `/api/opportunities${qs({ status, pipeline_id: c.pipeline_id })}`), w.call('GET', '/api/pipelines').catch(() => [])]);
  const stages = new Map<string, string>();
  for (const p of pipes as any[]) for (const s of p.stages ?? []) stages.set(`${p.id}:${s.id}`, s.name);
  let list = deals as any[];
  if (c.min_value) list = list.filter((d) => Number(d.value) >= Number(c.min_value));
  if (c.max_value) list = list.filter((d) => Number(d.value) <= Number(c.max_value));
  if (c.mine && w.user) list = list.filter((d) => d.assigned_to === w.user!.id);
  if (c.stale_days) list = list.filter((d) => dayDiff(d.stage_changed_at ?? d.updated_at, w.now) >= Number(c.stale_days));
  list = [...list].sort(c.sort === 'oldest' ? (a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) : c.sort === 'recent' ? (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) : (a, b) => Number(b.value) - Number(a.value));
  const tone: Record<string, Tone> = { open: 'blue', won: 'green', lost: 'red', abandoned: 'gray' };
  const label: Record<string, string> = { open: 'Offen', won: 'Gewonnen', lost: 'Verloren', abandoned: 'Aufgegeben' };
  const rows: ListRow[] = list.slice(0, c.limit).map((d) => ({ id: d.id, title: d.name, subtitle: [nameOf(d), stages.get(`${d.pipeline_id}:${d.stage_id}`)].filter(Boolean).join(' · '), meta: euro(d.value), at: d.updated_at, badge: { text: label[d.status] ?? d.status, tone: tone[d.status] ?? 'gray' }, url: `opportunities?pipeline=${d.pipeline_id}` }));
  return { kind: 'list', rows, total: list.length, empty: 'Keine Deals mit diesem Filter.', url: '/app/opportunities' };
}

async function ticketsList(w: WidgetCtx, c: Record<string, any>): Promise<View> {
  const r = await w.call('GET', `/api/tickets${qs({ state: c.ticket_state || 'open', priority: c.ticket_priority, owner: c.mine ? 'me' : '', sort: c.sort === 'priority' ? 'priority' : c.sort === 'oldest' ? 'created' : '', limit: c.limit })}`);
  const tone: Record<string, Tone> = { niedrig: 'gray', normal: 'blue', hoch: 'yellow', dringend: 'red' };
  const rows: ListRow[] = (r.tickets as any[]).map((t) => ({ id: t.id, title: `#${t.number} ${t.subject}`, subtitle: [t.contact_name, t.status].filter(Boolean).join(' · '), at: t.updated_at, badge: { text: String(t.priority), tone: tone[t.priority] ?? 'gray' }, url: `tickets/${t.id}` }));
  return { kind: 'list', rows, total: r.total, empty: 'Keine Tickets mit diesem Filter.', url: '/app/tickets' };
}

/** The planner's tasks (the CRM task list is the same table): due filter, "mine", project. */
async function tasksList(w: WidgetCtx, c: Record<string, any>): Promise<View> {
  if (c.mine && !w.user) return msg('„Meine Aufgaben“ gibt es nur mit persönlicher Anmeldung.', 'gray');
  const due = String(c.due || 'today_overdue');
  const base = { done: c.show_done ? '' : 'open', assignee: c.mine ? 'me' : '', project_id: c.project_id, sort: 'due', limit: c.limit };
  const get = (extra: Record<string, unknown>) => w.call('GET', `/api/pm/tasks${qs({ ...base, ...extra })}`).then((r: any) => r as { tasks: any[]; total: number });
  let tasks: any[];
  let total: number;
  if (due === 'today_overdue') {
    const [late, today] = await Promise.all([get({ due: 'overdue' }), get({ due: 'today' })]);
    tasks = [...late.tasks, ...today.tasks.filter((t) => !late.tasks.some((l) => l.id === t.id))];
    total = late.total + today.total;
  } else {
    const r = await get(due === 'any' ? {} : { due });
    tasks = r.tasks;
    total = r.total;
  }
  const projects: any[] = await w.call('GET', '/api/pm/projects').catch(() => []);
  const pname = new Map(projects.map((p) => [p.id, p.name]));
  const today = ymdInTz(w.now, w.tz);
  const rows: ListRow[] = tasks.slice(0, c.limit).map((t) => {
    const day = t.due_at ? (/^\d{4}-\d{2}-\d{2}$/.test(String(t.due_at).slice(0, 10)) && String(t.due_at).length <= 10 ? String(t.due_at) : ymdInTz(new Date(t.due_at), w.tz)) : '';
    const late = !t.done && day && day < today;
    return {
      id: t.id,
      title: t.title,
      subtitle: [pname.get(t.project_id), t.contact_name].filter(Boolean).join(' · '),
      meta: day ? (day === today ? 'Heute' : new Date(`${day}T12:00:00Z`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })) : '',
      badge: late ? { text: 'Überfällig', tone: 'red' as Tone } : t.priority >= 2 ? { text: String(t.priority_label), tone: 'yellow' as Tone } : undefined,
      check: { task_id: t.id, done: !!t.done },
      url: `pm/task/${t.id}`,
    };
  });
  return { kind: 'list', rows, total, empty: due === 'any' ? 'Keine offenen Aufgaben.' : 'Nichts zu tun – gut so.', url: '/app/pm/my' };
}

const LIST_ACCESS: Record<string, { path: string; label: string }> = {
  contacts: { path: '/api/contacts', label: 'Kontakte & Aufgaben' },
  deals: { path: '/api/opportunities', label: 'Opportunities' },
  tasks: { path: '/api/pm/tasks', label: 'Kontakte & Aufgaben' },
  tickets: { path: '/api/tickets', label: 'Service' },
};

// --- pipeline, agenda, inbox --------------------------------------------------------------------------------------------

async function pipelineView(w: WidgetCtx, c: Record<string, any>): Promise<View> {
  const pipes: any[] = await w.call('GET', '/api/pipelines');
  const pipe = pipes.find((p) => p.id === c.pipeline_id) ?? pipes[0];
  if (!pipe) return msg('Es gibt noch keine Pipeline.', 'gray');
  const status = ['open', 'won', 'lost'].includes(c.status) ? c.status : 'open';
  const deals: any[] = await w.call('GET', `/api/opportunities${qs({ pipeline_id: pipe.id, status })}`);
  const columns = (pipe.stages as any[]).map((s) => {
    const mine = deals.filter((d) => d.stage_id === s.id);
    const sorted = [...mine].sort(c.sort === 'recent' ? (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) : (a, b) => Number(b.value) - Number(a.value));
    return {
      id: s.id,
      title: s.name,
      count: mine.length,
      sum: mine.reduce((n, d) => n + Number(d.value || 0), 0),
      cards: sorted.slice(0, c.cards).map((d) => ({ id: d.id, title: d.name, subtitle: nameOf(d), meta: euro(d.value), url: `opportunities?pipeline=${pipe.id}` })),
    };
  });
  return { kind: 'kanban', columns, title: pipe.name, url: `/app/opportunities?pipeline=${pipe.id}`, empty: 'Keine Deals in dieser Pipeline.' };
}

const dayLabel = (ymd: string, today: string) => {
  if (ymd === today) return 'Heute';
  if (ymd === addDaysYmd(today, 1)) return 'Morgen';
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
};

async function agendaView(w: WidgetCtx, c: Record<string, any>): Promise<View> {
  const today = ymdInTz(w.now, w.tz);
  const from = zonedToUtc(today, '00:00', w.tz).toISOString();
  const to = zonedToUtc(addDaysYmd(today, Number(c.days)), '00:00', w.tz).toISOString();
  const list: any[] = await w.call('GET', `/api/appointments${qs({ from, to, calendar_id: c.calendar_id })}`);
  const days = new Map<string, any[]>();
  for (const a of list) {
    if (['cancelled', 'canceled', 'blocked'].includes(a.status)) continue;
    const day = ymdInTz(new Date(a.start_at), w.tz);
    if (day < today) continue;
    (days.get(day) ?? days.set(day, []).get(day)!).push(a);
  }
  const out = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({
      date,
      label: dayLabel(date, today),
      items: items.slice(0, 8).map((a) => ({ id: a.id, time: hmInTz(new Date(a.start_at), w.tz), title: a.title || nameOf(a), subtitle: [a.calendar_name, a.contact_id ? nameOf(a) : ''].filter(Boolean).join(' · '), url: 'calendars', tone: (a.status === 'confirmed' ? 'blue' : 'gray') as Tone })),
    }));
  return { kind: 'agenda', days: out, empty: `Keine Termine in den nächsten ${c.days} Tagen.`, url: '/app/calendars' };
}

async function inboxView(w: WidgetCtx, c: Record<string, any>): Promise<View> {
  const list: any[] = await w.call('GET', `/api/conversations${qs({ filter: c.only_unread ? 'unread' : '', channel: c.channel, limit: c.limit })}`);
  const rows: ListRow[] = list.slice(0, c.limit).map((v) => ({
    id: v.id,
    title: nameOf(v),
    // Message text is untrusted: the browser shows it as plain text only.
    subtitle: clip(v.last_message, 120),
    at: v.last_message_at,
    badge: v.unread > 0 ? { text: `${v.unread} neu`, tone: 'blue' as Tone } : undefined,
    url: `conversations/${v.id}`,
  }));
  return { kind: 'list', rows, empty: c.only_unread ? 'Alles gelesen.' : 'Noch keine Gespräche.', url: '/app/conversations' };
}

// --- knowledge, notes, embed ---------------------------------------------------------------------------------------------

async function wikiView(w: WidgetCtx, c: Record<string, any>): Promise<View> {
  if (!c.page_id) return msg('Wähle in den Einstellungen eine Wiki-Seite.', 'gray');
  try {
    const { page } = loadPage(w.app, w.ctx, String(c.page_id));
    return { kind: 'markdown', text: page.body.slice(0, 6000), title: page.title, url: `/app/wiki/${page.id}` };
  } catch {
    // Never a hint whether the page exists in another space or sub-account.
    return msg('Diese Seite ist nicht verfügbar (gelöscht oder ohne Zugriff).', 'yellow');
  }
}

/** The hosts the embed widget may show: the built-in list plus the agency's own (the board module provides `app.services.boardsEmbedHosts`). */
const hostsOf = (app: App): string[] => (app.services.boardsEmbedHosts as (() => string[]) | undefined)?.() ?? DEFAULT_EMBED_HOSTS;

// --- actions --------------------------------------------------------------------------------------------------------------

async function actionsView(w: WidgetCtx, c: Record<string, any>): Promise<View> {
  const list = (c.actions as Record<string, any>[]) ?? [];
  let workflows: any[] | null = null;
  let forms: any[] | null = null;
  const out: ActionView[] = [];
  for (const [i, a] of list.entries()) {
    const base = { id: String(i), label: String(a.label), icon: String(a.icon || ''), kind: a.kind as ActionView['kind'] };
    if (a.kind === 'workflow') {
      if (!w.allowed('/api/workflows')) {
        out.push({ ...base, target: '', enabled: false, why: 'Dafür fehlt dir das Recht „Automationen“.' });
        continue;
      }
      workflows ??= await w.call('GET', '/api/workflows').catch(() => []);
      const wf = workflows!.find((x) => x.id === a.workflow_id);
      out.push({ ...base, target: String(a.workflow_id), enabled: !!wf && wf.status === 'active', why: !wf ? 'Die Automation gibt es nicht mehr.' : wf.status !== 'active' ? 'Die Automation ist nicht aktiv.' : undefined });
    } else if (a.kind === 'form') {
      forms ??= await w.call('GET', '/api/forms').catch(() => []);
      const f = forms!.find((x) => x.id === a.form_id);
      out.push({ ...base, target: String(a.form_id), enabled: !!f, why: f ? undefined : 'Das Formular gibt es nicht mehr.', href: f ? `${w.app.baseUrl()}/f/${f.id}` : undefined });
    } else if (a.kind === 'page') {
      const t = PAGE_TARGETS[String(a.page)];
      out.push({ ...base, target: String(a.page), href: t ? `/app/${a.page}` : undefined, enabled: !!t && w.allowed(t.access), why: !t ? 'Unbekannte Seite.' : w.allowed(t.access) ? undefined : `Dafür fehlt dir das Recht „${t.label}“.` });
    } else if (a.kind === 'task') {
      out.push({ ...base, target: '', enabled: w.allowed('/api/tasks'), why: w.allowed('/api/tasks') ? undefined : 'Dafür fehlt dir das Recht „Kontakte & Aufgaben“.' });
    } else if (a.kind === 'contact') {
      out.push({ ...base, target: '', enabled: w.allowed('/api/contacts'), why: w.allowed('/api/contacts') ? undefined : 'Dafür fehlt dir das Recht „Kontakte & Aufgaben“.' });
    }
  }
  return { kind: 'actions', actions: out };
}

// --- calc, plugin ----------------------------------------------------------------------------------------------------------

async function calcView(w: WidgetCtx, c: Record<string, any>): Promise<View> {
  if (!c.scenario_id) return msg('Wähle in den Einstellungen ein Szenario des Gewinnrechners.', 'gray');
  const list: any[] = await w.call('GET', '/api/calc/scenarios').catch(() => []);
  const s = list.find((x) => x.id === c.scenario_id);
  if (!s) return msg('Das Szenario gibt es nicht mehr.', 'yellow');
  const k = s.summary ?? {};
  return {
    kind: 'numbers',
    title: String(s.name),
    items: [
      { label: 'Nettogewinn / Monat', value: k.net_profit_month ?? null, format: 'money', tone: (k.net_profit_month ?? 0) >= 0 ? 'green' : 'red' },
      { label: 'Umsatz netto / Monat', value: k.revenue_net_month ?? null, format: 'money' },
      { label: 'Marge', value: k.margin_pct ?? null, format: 'percent' },
      { label: 'Break-even', value: k.breakeven_customers != null ? `${k.breakeven_customers} Kunden` : '–' },
    ],
    hint: 'Schätzung, keine Steuerberatung',
    url: `/app/calc/${s.id}`,
  };
}

async function pluginView(w: WidgetCtx, c: Record<string, any>): Promise<View> {
  const ref = String(c.ref ?? '');
  const [slug, widgetId] = ref.split(':');
  if (!slug || !widgetId) return msg('Wähle in den Einstellungen ein Plugin-Widget.', 'gray');
  const svc = w.app.services.plugins;
  if (!svc || !w.ctx.user) return msg('Plugin-Widgets gibt es nur mit persönlicher Anmeldung.', 'gray');
  const active: any[] = svc.activeFor(w.ctx.user, w.locationId);
  const a = active.find((x) => x.plugin.slug === slug && (x.manifest.entries.widgets ?? []).some((wd: any) => wd.id === widgetId));
  if (!a) return { kind: 'message', text: 'Dieses Plugin ist hier nicht installiert oder nicht aktiv.', tone: 'yellow', action: { label: 'Zum Marktplatz', url: '/app/marktplatz' } };
  const wd = a.manifest.entries.widgets.find((x: any) => x.id === widgetId);
  return { kind: 'frame', plugin_id: a.plugin.id, entry: `widget:${widgetId}`, title: wd.title };
}

// --- definitions --------------------------------------------------------------------------------------------------------------

const pick = (o: Record<string, { label: string }>): [string, string][] => Object.entries(o).map(([k, v]) => [k, v.label]);
const SORTS = opts(['', 'Wie vorgegeben'], ['value', 'Größter Wert zuerst'], ['recent', 'Zuletzt geändert'], ['oldest', 'Am längsten unberührt'], ['name', 'Name'], ['activity', 'Letzte Aktivität'], ['priority', 'Priorität']);

export const CORE_WIDGETS: WidgetDef[] = [
  {
    type: 'kpi',
    label: 'Kennzahl',
    description: 'Eine Zahl groß dargestellt, mit Vergleich zur Vorperiode – z. B. offener Pipeline-Wert, neue Kontakte, bezahlter Umsatz.',
    icon: 'gauge',
    category: 'zahlen',
    keywords: ['zahl', 'kpi', 'umsatz', 'pipeline', 'kontakte', 'metrik', 'wert'],
    access: '/api/reports',
    accessLabel: 'Dashboard',
    size: { w: 3, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
    fields: [
      { key: 'preset', label: 'Kennzahl', type: 'select', options: pick(KPI_PRESETS), default: 'open_pipeline_value', hint: 'Oder unten einen gespeicherten Bericht wählen.' },
      { key: 'report_id', label: 'Gespeicherter Bericht', type: 'select', optionsFrom: 'reports', local: true, default: '', hint: 'Ersetzt die Kennzahl oben.' },
      rangeField(),
      compareField(),
      { key: 'query', label: 'Eigene Abfrage', type: 'json', hidden: true, default: null, maxLength: 3000 },
    ],
    validate: (c) => (c.preset && !KPI_PRESETS[String(c.preset)] && !c.report_id && !c.query ? [`Unbekannte Kennzahl „${String(c.preset)}“`] : []),
    data: (w, c) => reportView(w, c, 'kpi'),
  },
  {
    type: 'chart',
    label: 'Diagramm',
    description: 'Linie, Säulen, Balken oder Kreis über deine Berichtsdaten – z. B. Umsatz je Monat, Kontakte je Quelle, Pipeline je Phase.',
    icon: 'vizLine',
    category: 'zahlen',
    keywords: ['diagramm', 'chart', 'kurve', 'umsatzkurve', 'linie', 'balken', 'säulen', 'kreis', 'torte', 'verlauf', 'bericht'],
    access: '/api/reports',
    accessLabel: 'Dashboard',
    size: { w: 6, h: 4, minW: 3, minH: 3 },
    fields: [
      { key: 'preset', label: 'Diagramm', type: 'select', options: pick(CHART_PRESETS), default: 'revenue_by_month', hint: 'Oder unten einen gespeicherten Bericht wählen.' },
      { key: 'report_id', label: 'Gespeicherter Bericht', type: 'select', optionsFrom: 'reports', local: true, default: '', hint: 'Ersetzt das Diagramm oben.' },
      { key: 'viz', label: 'Darstellung', type: 'select', options: opts(['', 'Wie vorgegeben'], ['line', 'Linie'], ['area', 'Fläche'], ['bar', 'Säulen'], ['hbar', 'Balken'], ['pie', 'Kreis'], ['donut', 'Ring'], ['funnel', 'Trichter']), default: '', cosmetic: true },
      rangeField(),
      compareField(),
      { key: 'query', label: 'Eigene Abfrage', type: 'json', hidden: true, default: null, maxLength: 3000 },
    ],
    validate: (c) => (c.preset && !CHART_PRESETS[String(c.preset)] && !c.report_id && !c.query ? [`Unbekanntes Diagramm „${String(c.preset)}“`] : []),
    data: (w, c) => reportView(w, c, 'chart'),
  },
  {
    type: 'list',
    label: 'Liste',
    description: 'Kontakte, Deals, Aufgaben oder Tickets als Liste oder Tabelle – mit gespeichertem Filter, z. B. „offene Deals über 5.000 €“.',
    icon: 'list',
    category: 'listen',
    keywords: ['liste', 'tabelle', 'kontakte', 'deals', 'opportunities', 'aufgaben', 'tickets', 'filter', 'offene deals'],
    // Which area applies depends on the entity; the data function checks the one of the chosen entity.
    size: { w: 6, h: 4, minW: 3, minH: 2 },
    fields: [
      { key: 'entity', label: 'Was zeigen?', type: 'select', options: opts(['deals', 'Deals'], ['contacts', 'Kontakte'], ['tasks', 'Aufgaben'], ['tickets', 'Tickets']), default: 'deals' },
      { key: 'limit', label: 'Zeilen', type: 'number', min: 3, max: 30, default: 8, cosmetic: true },
      { key: 'display', label: 'Darstellung', type: 'select', options: opts(['list', 'Liste'], ['table', 'Tabelle']), default: 'list', cosmetic: true },
      { key: 'sort', label: 'Sortierung', type: 'select', options: SORTS, default: '', showIf: { key: 'entity', in: ['deals', 'contacts', 'tickets'] } },
      { key: 'status', label: 'Status', type: 'select', options: opts(['open', 'Offen'], ['won', 'Gewonnen'], ['lost', 'Verloren'], ['all', 'Alle']), default: 'open', showIf: { key: 'entity', in: ['deals'] } },
      { key: 'pipeline_id', label: 'Pipeline', type: 'select', optionsFrom: 'pipelines', local: true, default: '', showIf: { key: 'entity', in: ['deals'] } },
      { key: 'min_value', label: 'Mindestwert (€)', type: 'number', min: 0, max: 1e9, default: null, showIf: { key: 'entity', in: ['deals'] } },
      { key: 'max_value', label: 'Höchstwert (€)', type: 'number', min: 0, max: 1e9, default: null, showIf: { key: 'entity', in: ['deals'] } },
      { key: 'stale_days', label: 'Seit mindestens … Tagen unberührt', type: 'number', min: 1, max: 365, default: null, showIf: { key: 'entity', in: ['deals'] } },
      { key: 'tag', label: 'Tag', type: 'text', maxLength: 60, default: '', showIf: { key: 'entity', in: ['contacts'] } },
      { key: 'q', label: 'Suchtext', type: 'text', maxLength: 80, default: '', showIf: { key: 'entity', in: ['contacts'] } },
      { key: 'smart_list_id', label: 'Gespeicherte Liste', type: 'select', optionsFrom: 'smart_lists', local: true, default: '', showIf: { key: 'entity', in: ['contacts'] } },
      { key: 'due', label: 'Fällig', type: 'select', options: opts(['today_overdue', 'Heute & überfällig'], ['today', 'Heute'], ['overdue', 'Überfällig'], ['week', 'Nächste 7 Tage'], ['any', 'Alle offenen']), default: 'today_overdue', showIf: { key: 'entity', in: ['tasks'] } },
      { key: 'project_id', label: 'Projekt', type: 'select', optionsFrom: 'projects', local: true, default: '', showIf: { key: 'entity', in: ['tasks'] } },
      { key: 'ticket_state', label: 'Status', type: 'select', options: opts(['open', 'Offen'], ['resolved', 'Gelöst'], ['done', 'Gelöst oder geschlossen'], ['all', 'Alle']), default: 'open', showIf: { key: 'entity', in: ['tickets'] } },
      { key: 'ticket_priority', label: 'Priorität', type: 'select', options: opts(['', 'Alle'], ['dringend', 'Dringend'], ['hoch', 'Hoch'], ['normal', 'Normal'], ['niedrig', 'Niedrig']), default: '', showIf: { key: 'entity', in: ['tickets'] } },
      { key: 'mine', label: 'Nur meine', type: 'bool', default: false, showIf: { key: 'entity', in: ['deals', 'tasks', 'tickets'] } },
    ],
    async data(w, c) {
      const a = LIST_ACCESS[String(c.entity)];
      if (!a) return msg('Unbekannte Liste.', 'yellow');
      if (!w.allowed(a.path)) return { kind: 'locked', reason: `Dafür fehlt dir das Recht „${a.label}“.` };
      let v: View;
      if (c.entity === 'contacts') v = await contactsList(w, c);
      else if (c.entity === 'deals') v = await dealsList(w, c);
      else if (c.entity === 'tickets') v = await ticketsList(w, c);
      else v = await tasksList(w, c);
      return { ...v, title: { contacts: 'Kontakte', deals: 'Deals', tasks: 'Aufgaben', tickets: 'Tickets' }[String(c.entity)] } as View;
    },
  },
  {
    type: 'pipeline',
    label: 'Pipeline',
    description: 'Mini-Kanban: Phasen mit Anzahl, Wert und den größten Deals je Phase.',
    icon: 'kanban',
    category: 'listen',
    keywords: ['pipeline', 'kanban', 'phasen', 'deals', 'verkauf', 'trichter'],
    access: '/api/opportunities',
    accessLabel: 'Opportunities',
    size: { w: 12, h: 5, minW: 4, minH: 3 },
    fields: [
      { key: 'pipeline_id', label: 'Pipeline', type: 'select', optionsFrom: 'pipelines', local: true, default: '', hint: 'Leer = die erste Pipeline.' },
      { key: 'status', label: 'Status', type: 'select', options: opts(['open', 'Offen'], ['won', 'Gewonnen'], ['lost', 'Verloren']), default: 'open' },
      { key: 'cards', label: 'Deals je Phase', type: 'number', min: 1, max: 6, default: 3, cosmetic: true },
      { key: 'sort', label: 'Sortierung', type: 'select', options: opts(['value', 'Größter Wert zuerst'], ['recent', 'Zuletzt geändert']), default: 'value' },
    ],
    data: pipelineView,
  },
  {
    type: 'agenda',
    label: 'Termine',
    description: 'Die nächsten Termine, nach Tagen gegliedert.',
    icon: 'calendars',
    category: 'planung',
    keywords: ['termine', 'kalender', 'agenda', 'heute', 'woche'],
    access: '/api/appointments',
    accessLabel: 'Kalender',
    size: { w: 4, h: 4, minW: 3, minH: 3 },
    fields: [
      { key: 'days', label: 'Tage voraus', type: 'number', min: 1, max: 14, default: 7 },
      { key: 'calendar_id', label: 'Kalender', type: 'select', optionsFrom: 'calendars', local: true, default: '', hint: 'Leer = alle Kalender.' },
    ],
    data: agendaView,
  },
  {
    type: 'inbox',
    label: 'Posteingang',
    description: 'Die neuesten Gespräche mit Vorschau – ein Klick öffnet sie in den Konversationen.',
    icon: 'inbox',
    category: 'planung',
    keywords: ['posteingang', 'inbox', 'nachrichten', 'konversationen', 'gespräche', 'ungelesen', 'mails'],
    access: '/api/conversations',
    accessLabel: 'Konversationen',
    size: { w: 4, h: 4, minW: 3, minH: 3 },
    fields: [
      { key: 'limit', label: 'Gespräche', type: 'number', min: 3, max: 15, default: 6, cosmetic: true },
      { key: 'only_unread', label: 'Nur ungelesene', type: 'bool', default: false },
      { key: 'channel', label: 'Kanal', type: 'select', options: opts(['', 'Alle'], ['email', 'E-Mail'], ['sms', 'SMS'], ['chat', 'Website-Chat'], ['whatsapp', 'WhatsApp'], ['messenger', 'Messenger'], ['instagram', 'Instagram']), default: '' },
    ],
    data: inboxView,
  },
  {
    type: 'tasks',
    label: 'Aufgaben',
    description: 'Aufgaben aus der Projektplanung – „meine Aufgaben für heute“, überfällige oder die der nächsten Woche, direkt abhakbar.',
    icon: 'tasks',
    category: 'planung',
    keywords: ['aufgaben', 'to-do', 'todo', 'heute', 'überfällig', 'planer', 'projekte', 'abhaken'],
    access: '/api/pm/tasks',
    accessLabel: 'Kontakte & Aufgaben',
    size: { w: 4, h: 4, minW: 3, minH: 3 },
    fields: [
      { key: 'due', label: 'Fällig', type: 'select', options: opts(['today_overdue', 'Heute & überfällig'], ['today', 'Heute'], ['overdue', 'Überfällig'], ['week', 'Nächste 7 Tage'], ['any', 'Alle offenen']), default: 'today_overdue' },
      { key: 'mine', label: 'Nur meine Aufgaben', type: 'bool', default: true },
      { key: 'project_id', label: 'Projekt', type: 'select', optionsFrom: 'projects', local: true, default: '', hint: 'Leer = alle Projekte.' },
      { key: 'limit', label: 'Aufgaben', type: 'number', min: 3, max: 30, default: 8, cosmetic: true },
      { key: 'show_done', label: 'Erledigte mitzeigen', type: 'bool', default: false },
    ],
    data: tasksList,
  },
  {
    type: 'wiki',
    label: 'Wiki-Seite',
    description: 'Eine Seite aus dem Wiki direkt auf dem Board – z. B. Checkliste, Regeln oder Wochenziele.',
    icon: 'wiki',
    category: 'wissen',
    keywords: ['wiki', 'seite', 'dokument', 'wissen', 'checkliste', 'anleitung'],
    access: '/api/wiki',
    accessLabel: 'Wiki & Dokumente',
    size: { w: 4, h: 4, minW: 3, minH: 2 },
    fields: [{ key: 'page_id', label: 'Wiki-Seite', type: 'select', optionsFrom: 'wiki_pages', local: true, default: '' }],
    data: wikiView,
  },
  {
    type: 'notes',
    label: 'Notiz',
    description: 'Freier Text mit Markdown – Ziele, Hinweise, Links, ein Gruß ans Team.',
    icon: 'note',
    category: 'wissen',
    keywords: ['notiz', 'text', 'markdown', 'hinweis', 'memo', 'ziel'],
    size: { w: 4, h: 3, minW: 2, minH: 2 },
    fields: [{ key: 'text', label: 'Text', type: 'textarea', maxLength: 8000, default: '', placeholder: '**Fett**, *kursiv*, - Listen, [Links](https://…)' }],
    data: (_w, c) => ({ kind: 'markdown', text: String(c.text ?? '') }),
  },
  {
    type: 'embed',
    label: 'Einbettung',
    description: 'Eine Seite einbetten (Video, Dokument, Kalender, Looker Studio …) – nur von Adressen, die ein Admin freigegeben hat.',
    icon: 'monitor',
    category: 'extern',
    keywords: ['einbetten', 'embed', 'iframe', 'video', 'youtube', 'google', 'looker', 'seite', 'url'],
    risk: 'high',
    size: { w: 6, h: 5, minW: 3, minH: 3 },
    fields: [{ key: 'url', label: 'Adresse (https)', type: 'url', default: '', placeholder: 'https://www.youtube.com/watch?v=…' }],
    validate: (c, env) => {
      if (!c.url) return [];
      const r = checkEmbedUrl(c.url, hostsOf(env.app));
      return r.ok ? [] : [`Einbettung: ${r.problem}`];
    },
    data: (w, c) => {
      if (!c.url) return msg('Gib in den Einstellungen eine Adresse an.', 'gray');
      const r = checkEmbedUrl(c.url, hostsOf(w.app));
      return r.ok ? { kind: 'embed', url: r.url!, title: r.host } : { kind: 'locked', reason: r.problem! };
    },
  },
  {
    type: 'actions',
    label: 'Schnellaktionen',
    description: 'Knöpfe, die eine Automation starten, ein Formular öffnen, eine Seite aufrufen oder schnell eine Aufgabe oder einen Kontakt anlegen.',
    icon: 'trigger',
    category: 'aktionen',
    keywords: ['schnellaktion', 'knopf', 'button', 'aktion', 'automation', 'workflow', 'formular', 'neu', 'anlegen'],
    risk: 'high',
    size: { w: 4, h: 2, minW: 2, minH: 2 },
    fields: [
      {
        key: 'actions',
        label: 'Knöpfe',
        type: 'list',
        maxItems: 8,
        default: [],
        item: [
          { key: 'label', label: 'Beschriftung', type: 'text', maxLength: 40, default: '' },
          { key: 'kind', label: 'Aktion', type: 'select', options: opts(['task', 'Aufgabe anlegen'], ['contact', 'Kontakt anlegen'], ['workflow', 'Automation starten'], ['form', 'Formular öffnen'], ['page', 'Seite öffnen']), default: 'task' },
          { key: 'workflow_id', label: 'Automation', type: 'select', optionsFrom: 'workflows', local: true, default: '', showIf: { key: 'kind', in: ['workflow'] } },
          { key: 'form_id', label: 'Formular', type: 'select', optionsFrom: 'forms', local: true, default: '', showIf: { key: 'kind', in: ['form'] } },
          { key: 'page', label: 'Seite', type: 'select', options: pick(PAGE_TARGETS), default: 'contacts', showIf: { key: 'kind', in: ['page'] } },
          { key: 'icon', label: 'Symbol', type: 'text', maxLength: 20, default: '', hidden: true },
        ],
      },
    ],
    validate: (c) => {
      const problems: string[] = [];
      for (const [i, a] of ((c.actions as Record<string, any>[]) ?? []).entries()) {
        if (!String(a.label ?? '').trim()) problems.push(`Knopf ${i + 1}: Beschriftung fehlt`);
        if (a.kind === 'workflow' && !a.workflow_id) problems.push(`Knopf ${i + 1}: Automation wählen`);
        if (a.kind === 'form' && !a.form_id) problems.push(`Knopf ${i + 1}: Formular wählen`);
      }
      return problems;
    },
    data: actionsView,
  },
  {
    type: 'calc',
    label: 'Gewinnrechner',
    description: 'Das Ergebnis eines gespeicherten Gewinnrechner-Szenarios: Nettogewinn, Umsatz, Marge und Break-even.',
    icon: 'calculator',
    category: 'zahlen',
    keywords: ['gewinnrechner', 'gewinn', 'marge', 'break-even', 'szenario', 'kalkulation', 'preis'],
    access: '/api/calc',
    accessLabel: 'Rechnungen & Produkte',
    size: { w: 4, h: 3, minW: 3, minH: 2 },
    fields: [{ key: 'scenario_id', label: 'Szenario', type: 'select', optionsFrom: 'scenarios', local: true, default: '' }],
    data: calcView,
  },
  {
    type: 'plugin',
    label: 'Plugin-Widget',
    description: 'Ein Widget aus einem installierten Plugin der Werkstatt – läuft isoliert in einer Sandbox.',
    icon: 'puzzle',
    category: 'extern',
    keywords: ['plugin', 'werkstatt', 'marktplatz', 'mini-app', 'widget'],
    size: { w: 4, h: 3, minW: 2, minH: 2 },
    fields: [{ key: 'ref', label: 'Plugin-Widget', type: 'select', optionsFrom: 'plugin_widgets', default: '' }],
    data: pluginView,
  },
];

/** Registers the built-in widgets. */
export function registerCoreWidgets(reg: WidgetRegistry) {
  for (const d of CORE_WIDGETS) reg.register({ ...d, source: 'core' });
  reg.lock();
}

