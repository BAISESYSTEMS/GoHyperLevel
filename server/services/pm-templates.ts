import type { App } from '../core/app.js';
import { bad } from '../core/http.js';
import { id as newId, now } from '../core/util.js';
import { FIELD_TYPES, cleanColor, dayOf, fieldsFor, json, statusesOf, todayIn, tzOf, type Actor, type ProjectRow, type StatusCategory } from './pm-core.js';
import { CALENDAR_DAYS, CALENDAR_WORKDAYS, DEP_TYPES, diffDays, endFromDuration, stepDays, type DepType } from './pm-schedule.js';
import { announceCreated, createTask, getTask } from './pm-tasks.js';

/**
 * Project templates: a recipe of statuses, sections, custom fields, tasks (with subtasks, checklists, estimates,
 * relative dates and dependencies) and automations. Two ship with the app; any project can be saved as one.
 * Dates in a template are offsets from the project's start, so one recipe fits any start date.
 */

export interface TemplateTask {
  ref?: string;
  title: string;
  description?: string;
  section?: string;
  status?: string;
  priority?: number | string;
  tags?: string[];
  estimate_minutes?: number;
  /** Days after the project start the task begins (working days when the project skips weekends). */
  offset?: number;
  /** Length in days (default 1). */
  duration?: number;
  milestone?: boolean;
  internal?: boolean;
  /** No dates at all (otherwise a subtask without its own offset takes its parent's dates). */
  nodate?: boolean;
  /** Assign the person who creates the project. */
  assign_creator?: boolean;
  checklist?: { title: string; items: string[] }[];
  subtasks?: TemplateTask[];
  depends_on?: { ref: string; type?: DepType; lag?: number }[];
}
export interface TemplateAutomation {
  name: string;
  trigger: string;
  conditions?: Record<string, any>;
  actions: Record<string, any>[];
}
export interface TemplateData {
  statuses?: { name: string; category: StatusCategory; color?: string }[];
  sections?: string[];
  fields?: { key: string; label: string; type: string; options?: string[] }[];
  tasks: TemplateTask[];
  automations?: TemplateAutomation[];
  settings?: { skip_weekends?: boolean; billable?: boolean };
  /** Project length in days, for the due date of the project. */
  duration?: number;
}
export interface BuiltinTemplate {
  key: string;
  name: string;
  description: string;
  data: TemplateData;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    key: 'kunden-onboarding',
    name: 'Kunden-Onboarding',
    description: 'Vom unterschriebenen Vertrag bis zur Übergabe: Briefing, Zugänge, Kick-off, Einrichtung, Schulung, Abnahme.',
    data: {
      sections: ['Vorbereitung', 'Kick-off', 'Einrichtung', 'Übergabe'],
      settings: { skip_weekends: true, billable: true },
      duration: 21,
      tasks: [
        { ref: 'vertrag', title: 'Vertrag und Auftragsbestätigung ablegen', section: 'Vorbereitung', offset: 0, duration: 1, priority: 3, estimate_minutes: 30 },
        { ref: 'briefing', title: 'Briefing-Fragebogen an den Kunden senden', section: 'Vorbereitung', offset: 1, duration: 2, estimate_minutes: 45, checklist: [{ title: 'Fragebogen', items: ['Ziele und Zielgruppe', 'Wettbewerber', 'Logo und Farben', 'Ansprechpartner'] }], depends_on: [{ ref: 'vertrag' }] },
        { ref: 'zugaenge', title: 'Zugangsdaten und Freigaben einsammeln', section: 'Vorbereitung', offset: 1, duration: 3, estimate_minutes: 60, depends_on: [{ ref: 'vertrag', type: 'SS', lag: 1 }], subtasks: [{ title: 'Domain und Hosting' }, { title: 'Social-Media-Konten' }, { title: 'Werbekonten und Analytics' }] },
        { ref: 'kickoff-termin', title: 'Kick-off-Termin vereinbaren', section: 'Kick-off', offset: 3, duration: 1, estimate_minutes: 15, depends_on: [{ ref: 'briefing' }] },
        { ref: 'kickoff', title: 'Kick-off durchführen', section: 'Kick-off', offset: 5, duration: 1, milestone: true, priority: 3, estimate_minutes: 90, depends_on: [{ ref: 'kickoff-termin' }, { ref: 'zugaenge' }], checklist: [{ title: 'Agenda', items: ['Ziele klären', 'Zeitplan abstimmen', 'Rollen und Ansprechpartner', 'Nächste Schritte'] }] },
        { ref: 'protokoll', title: 'Protokoll und Zeitplan an den Kunden schicken', section: 'Kick-off', offset: 6, duration: 1, estimate_minutes: 30, depends_on: [{ ref: 'kickoff' }] },
        { ref: 'einrichtung', title: 'Konten und Tools einrichten', section: 'Einrichtung', offset: 6, duration: 5, estimate_minutes: 360, depends_on: [{ ref: 'kickoff' }], subtasks: [{ title: 'Projektordner und Kanäle anlegen', estimate_minutes: 30 }, { title: 'Tracking einrichten', estimate_minutes: 90 }, { title: 'Vorlagen und Texte vorbereiten', estimate_minutes: 120 }] },
        { ref: 'test', title: 'Alles testen und Fehler beheben', section: 'Einrichtung', offset: 11, duration: 2, estimate_minutes: 180, depends_on: [{ ref: 'einrichtung' }] },
        { ref: 'schulung', title: 'Schulung für den Kunden', section: 'Übergabe', offset: 13, duration: 1, estimate_minutes: 120, depends_on: [{ ref: 'test' }] },
        { ref: 'abnahme', title: 'Abnahme durch den Kunden', section: 'Übergabe', offset: 14, duration: 1, milestone: true, priority: 3, depends_on: [{ ref: 'schulung' }] },
        { ref: 'rechnung', title: 'Schlussrechnung stellen', section: 'Übergabe', offset: 15, duration: 1, estimate_minutes: 20, internal: true, depends_on: [{ ref: 'abnahme' }] },
      ],
      automations: [
        { name: 'Nach dem Kick-off: Protokoll-Aufgabe anlegen', trigger: 'task.completed', conditions: { title_contains: 'Kick-off durchführen' }, actions: [{ type: 'create_task', title: 'Kick-off-Notizen ins Projekt übertragen', due_in_days: 1, priority: 2 }] },
      ],
    },
  },
  {
    key: 'website-projekt',
    name: 'Website-Projekt',
    description: 'Konzept, Design, Entwicklung, Inhalte und Go-live – mit Kundenfreigaben und Abhängigkeiten.',
    data: {
      statuses: [
        { name: 'Backlog', category: 'todo', color: '#94a3b8' },
        { name: 'In Arbeit', category: 'active', color: '#3b82f6' },
        { name: 'Review', category: 'active', color: '#f59e0b' },
        { name: 'Freigabe Kunde', category: 'active', color: '#8b5cf6' },
        { name: 'Fertig', category: 'done', color: '#10b981' },
      ],
      sections: ['Konzept', 'Design', 'Entwicklung', 'Inhalte', 'Launch'],
      fields: [{ key: 'seiten', label: 'Seitenzahl', type: 'number' }],
      settings: { skip_weekends: true, billable: true },
      duration: 42,
      tasks: [
        { ref: 'anforderungen', title: 'Anforderungen und Ziele klären', section: 'Konzept', offset: 0, duration: 3, priority: 3, estimate_minutes: 240, subtasks: [{ title: 'Zielgruppe und Wettbewerber' }, { title: 'Funktionen und Seitenstruktur' }] },
        { ref: 'sitemap', title: 'Sitemap und Wireframes', section: 'Konzept', offset: 3, duration: 4, estimate_minutes: 480, depends_on: [{ ref: 'anforderungen' }] },
        { ref: 'konzept-ok', title: 'Konzept-Freigabe durch den Kunden', section: 'Konzept', offset: 7, duration: 1, milestone: true, status: 'Freigabe Kunde', depends_on: [{ ref: 'sitemap' }] },
        { ref: 'design', title: 'Design der Startseite und Vorlagen', section: 'Design', offset: 8, duration: 6, priority: 3, estimate_minutes: 960, depends_on: [{ ref: 'konzept-ok' }], tags: ['Design'] },
        { ref: 'design-ok', title: 'Design-Freigabe durch den Kunden', section: 'Design', offset: 14, duration: 1, milestone: true, status: 'Freigabe Kunde', depends_on: [{ ref: 'design' }] },
        { ref: 'umsetzung', title: 'Umsetzung der Seiten', section: 'Entwicklung', offset: 15, duration: 10, priority: 3, estimate_minutes: 2400, depends_on: [{ ref: 'design-ok' }], tags: ['Entwicklung'], subtasks: [{ title: 'Grundgerüst und Navigation', estimate_minutes: 480 }, { title: 'Seitenvorlagen', estimate_minutes: 960 }, { title: 'Formulare und Tracking', estimate_minutes: 360 }, { title: 'Mobile Ansicht prüfen', estimate_minutes: 240 }] },
        { ref: 'texte', title: 'Texte und Bilder vom Kunden einsammeln', section: 'Inhalte', offset: 8, duration: 10, estimate_minutes: 120, depends_on: [{ ref: 'konzept-ok', type: 'SS' }] },
        { ref: 'inhalte', title: 'Inhalte einpflegen', section: 'Inhalte', offset: 25, duration: 4, estimate_minutes: 600, depends_on: [{ ref: 'umsetzung' }, { ref: 'texte' }] },
        { ref: 'test', title: 'Test und Fehlerbehebung', section: 'Launch', offset: 29, duration: 3, estimate_minutes: 480, depends_on: [{ ref: 'inhalte' }], checklist: [{ title: 'Vor dem Start', items: ['Alle Links und Formulare', 'Browser und Handys', 'Geschwindigkeit', 'Impressum und Datenschutz', 'Suchmaschinen-Grundlagen'] }] },
        { ref: 'abnahme', title: 'Abnahme durch den Kunden', section: 'Launch', offset: 32, duration: 2, milestone: false, status: 'Freigabe Kunde', priority: 3, depends_on: [{ ref: 'test' }] },
        { ref: 'golive', title: 'Go-live', section: 'Launch', offset: 34, duration: 1, milestone: true, priority: 4, depends_on: [{ ref: 'abnahme' }] },
        { ref: 'nachbetreuung', title: 'Nachbetreuung und Schlussrechnung', section: 'Launch', offset: 35, duration: 5, estimate_minutes: 180, depends_on: [{ ref: 'golive' }] },
      ],
    },
  },
];

export const builtinTemplate = (key: string) => BUILTIN_TEMPLATES.find((t) => t.key === key);

// --- validation of stored templates ---------------------------------------------------------------

/** Keeps a template's shape sane (it comes from saved projects or the API). */
export function cleanTemplateData(input: unknown): TemplateData {
  const d: any = input && typeof input === 'object' ? input : {};
  const count = { n: 0 };
  const task = (t: any, depth: number): TemplateTask => {
    if (!t || typeof t !== 'object' || typeof t.title !== 'string' || !t.title.trim()) throw bad('Vorlage: jede Aufgabe braucht einen Titel');
    if (++count.n > 300) throw bad('Vorlage: höchstens 300 Aufgaben');
    if (depth > 4) throw bad('Vorlage: Unteraufgaben zu tief verschachtelt');
    const out: TemplateTask = { title: t.title.trim().slice(0, 300) };
    if (t.ref) out.ref = String(t.ref).slice(0, 40);
    if (t.description) out.description = String(t.description).slice(0, 20_000);
    if (t.section) out.section = String(t.section).slice(0, 120);
    if (t.status) out.status = String(t.status).slice(0, 80);
    if (t.priority !== undefined) out.priority = t.priority;
    if (Array.isArray(t.tags)) out.tags = t.tags.map((x: unknown) => String(x).slice(0, 40)).slice(0, 20);
    for (const k of ['estimate_minutes', 'offset', 'duration'] as const) if (t[k] !== undefined && Number.isFinite(Number(t[k]))) out[k] = Math.max(0, Math.round(Number(t[k])));
    if (t.milestone) out.milestone = true;
    if (t.internal) out.internal = true;
    if (t.nodate) out.nodate = true;
    if (t.assign_creator) out.assign_creator = true;
    if (Array.isArray(t.checklist)) out.checklist = t.checklist.slice(0, 20).map((c: any) => ({ title: String(c?.title ?? 'Checkliste').slice(0, 120), items: (Array.isArray(c?.items) ? c.items : []).map((i: unknown) => String(i).slice(0, 300)).slice(0, 100) }));
    if (Array.isArray(t.depends_on)) out.depends_on = t.depends_on.slice(0, 20).map((x: any) => ({ ref: String(x?.ref ?? ''), type: DEP_TYPES.includes(x?.type) ? x.type : 'FS', lag: Math.max(-365, Math.min(365, Math.round(Number(x?.lag ?? 0)) || 0)) })).filter((x: { ref: string }) => x.ref);
    if (Array.isArray(t.subtasks)) out.subtasks = t.subtasks.map((s: unknown) => task(s, depth + 1));
    return out;
  };
  const out: TemplateData = { tasks: (Array.isArray(d.tasks) ? d.tasks : []).map((t: unknown) => task(t, 0)) };
  if (Array.isArray(d.statuses) && d.statuses.length) {
    const statuses = d.statuses.slice(0, 20).map((s: any) => ({ name: String(s?.name ?? '').trim().slice(0, 60), category: (['todo', 'active', 'done'].includes(s?.category) ? s.category : 'active') as StatusCategory, color: cleanColor(s?.color, '#94a3b8') })).filter((s: { name: string }) => s.name) as NonNullable<TemplateData['statuses']>;
    if (!statuses.some((s) => s.category === 'todo') || !statuses.some((s) => s.category === 'done')) throw bad('Vorlage: braucht mindestens einen Status „zu erledigen“ und einen „erledigt“');
    out.statuses = statuses;
  }
  if (Array.isArray(d.sections)) out.sections = [...new Set(d.sections.map((s: unknown) => String(s).trim().slice(0, 120)).filter(Boolean))].slice(0, 50) as string[];
  if (Array.isArray(d.fields)) out.fields = d.fields.slice(0, 30).map((f: any) => ({ key: String(f?.key ?? '').replace(/[^a-z0-9_]/g, '').slice(0, 40), label: String(f?.label ?? '').slice(0, 80), type: FIELD_TYPES.includes(f?.type) ? f.type : 'text', options: Array.isArray(f?.options) ? f.options.map(String).slice(0, 50) : undefined })).filter((f: { key: string; label: string }) => f.key && f.label);
  if (Array.isArray(d.automations)) out.automations = d.automations.slice(0, 20).filter((a: any) => a && typeof a.trigger === 'string' && Array.isArray(a.actions)).map((a: any) => ({ name: String(a.name ?? 'Automation').slice(0, 120), trigger: String(a.trigger), conditions: a.conditions && typeof a.conditions === 'object' ? a.conditions : {}, actions: a.actions.slice(0, 10) }));
  if (d.settings && typeof d.settings === 'object') out.settings = { skip_weekends: !!d.settings.skip_weekends, billable: d.settings.billable !== false };
  if (Number.isFinite(Number(d.duration)) && Number(d.duration) > 0) out.duration = Math.min(1000, Math.round(Number(d.duration)));
  return out;
}

// --- instantiate ---------------------------------------------------------------------------------

export interface InstantiateInput {
  /** The caller already runs inside a transaction. */
  inTx?: boolean;
  start?: string;
  /** Person the "assign creator" tasks go to. */
  creator?: string | null;
}

/**
 * Fills an (empty) project from a template: statuses, sections, fields, tasks with their dates counted from
 * `start`, dependencies and automations. Everything happens in one transaction; events are announced after.
 */
export function applyTemplate(app: App, project: ProjectRow, data: TemplateData, actor: Actor, input: InstantiateInput = {}): { tasks: number } {
  const { db } = app;
  const locationId = project.location_id;
  const tz = tzOf(app, locationId);
  const cal = project.skip_weekends ? CALENDAR_WORKDAYS : CALENDAR_DAYS;
  const start = input.start && /^\d{4}-\d{2}-\d{2}$/.test(input.start) ? input.start : todayIn(tz);
  const created: string[] = [];
  const refs = new Map<string, string>();
  const links: { task: string; on: string; type: DepType; lag: number }[] = [];
  const nested = { n: 0, created: [] as string[] };

  const run = (fn: () => void) => (input.inTx ? fn() : db.tx(fn));
  run(() => {
    if (data.statuses?.length) {
      // Replace the project's default statuses (no tasks use them yet).
      db.run('DELETE FROM pm_statuses WHERE project_id = ?', project.id);
      data.statuses.forEach((s, i) => db.insert('pm_statuses', { id: newId(), location_id: locationId, project_id: project.id, name: s.name, category: s.category, color: s.color ?? '#94a3b8', position: i }));
    }
    const sectionIds = new Map<string, string>();
    (data.sections ?? []).forEach((name, i) => {
      const id = newId();
      sectionIds.set(name, id);
      db.insert('pm_sections', { id, location_id: locationId, project_id: project.id, name, position: i, created_at: now() });
    });
    for (const f of data.fields ?? []) {
      if (!db.get('SELECT 1 AS x FROM pm_custom_fields WHERE location_id = ? AND project_id = ? AND key = ?', locationId, project.id, f.key)) db.insert('pm_custom_fields', { id: newId(), location_id: locationId, project_id: project.id, key: f.key, label: f.label, type: f.type, options: f.options ?? [], position: 0, created_at: now() });
    }
    const make = (t: TemplateTask, parent: string | null, inherited?: string, span?: { start: string; due: string; milestone: boolean }) => {
      const sectionName = t.section ?? inherited;
      let dates: { start: string; due: string; milestone: boolean } | undefined;
      if (t.offset !== undefined || t.duration !== undefined || t.milestone) {
        const s = stepDays(start, t.offset ?? 0, cal);
        dates = { start: s, due: endFromDuration(s, t.milestone ? 1 : Math.max(1, t.duration ?? 1), cal), milestone: !!t.milestone };
      } else if (!t.nodate && span) dates = span;
      const row = createTask(
        app,
        locationId,
        {
          title: t.title,
          description: t.description,
          project_id: project.id,
          parent_id: parent ?? undefined,
          section_id: sectionName ? (sectionIds.get(sectionName) ?? null) : undefined,
          status: t.status,
          priority: t.priority,
          tags: t.tags,
          estimate_minutes: t.estimate_minutes,
          milestone: t.milestone,
          internal: t.internal,
          start_at: dates && !dates.milestone ? `${dates.start}T00:00:00.000Z` : undefined,
          due_at: dates ? `${dates.due}T00:00:00.000Z` : undefined,
          assignees: t.assign_creator && input.creator ? [input.creator] : undefined,
          checklists: (t.checklist ?? []).map((c) => ({ title: c.title, items: c.items.map((text) => ({ text })) })),
        },
        actor,
        { quiet: true, nested },
      );
      created.push(row.id);
      if (t.ref) refs.set(t.ref, row.id);
      for (const d of t.depends_on ?? []) links.push({ task: row.id, on: d.ref, type: d.type ?? 'FS', lag: d.lag ?? 0 });
      for (const sub of t.subtasks ?? []) make(sub, row.id, sectionName, dates);
    };
    for (const t of data.tasks) make(t, null);
    for (const l of links) {
      const on = refs.get(l.on);
      if (!on) continue;
      db.run('INSERT OR IGNORE INTO pm_dependencies (id, location_id, project_id, task_id, depends_on, type, lag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', newId(), locationId, project.id, l.task, on, l.type, l.lag, now());
    }
    for (const a of data.automations ?? []) {
      db.insert('pm_automations', { id: newId(), location_id: locationId, project_id: project.id, name: a.name, enabled: 1, trigger: a.trigger, conditions: a.conditions ?? {}, actions: a.actions, runs: 0, created_by: actor.id, created_at: now(), updated_at: now() });
    }
    // Project dates: from the start to the template's length (or its last task).
    const last = db.get<{ d: string | null }>('SELECT MAX(due_at) AS d FROM tasks WHERE project_id = ?', project.id)?.d;
    const end = data.duration ? stepDays(start, data.duration - 1, cal) : (dayOf(last, tz) ?? null);
    db.run('UPDATE pm_projects SET start_at = COALESCE(start_at, ?), due_at = COALESCE(due_at, ?), updated_at = ? WHERE id = ?', `${start}T00:00:00.000Z`, end ? `${end}T00:00:00.000Z` : null, now(), project.id);
  });
  // Events and notifications once, for every task of the new project.
  for (const tid of nested.created) announceCreated(app, getTask(app, locationId, tid), actor);
  return { tasks: created.length };
}

// --- save a project as a template ------------------------------------------------------------------

/** Turns a project's structure into a template (dates become offsets from the project's first start). */
export function extractTemplate(app: App, project: ProjectRow): TemplateData {
  const { db } = app;
  const tz = tzOf(app, project.location_id);
  const statuses = statusesOf(app, project.id);
  const sections = db.all<{ id: string; name: string }>('SELECT id, name FROM pm_sections WHERE project_id = ? ORDER BY position', project.id);
  const rows = db.all<any>('SELECT * FROM tasks WHERE project_id = ? ORDER BY position, created_at', project.id);
  const deps = db.all<any>('SELECT task_id, depends_on, type, lag FROM pm_dependencies WHERE project_id = ?', project.id);
  const firstStart = rows.map((r) => dayOf(r.start_at ?? r.due_at, tz)).filter(Boolean).sort()[0] ?? dayOf(project.start_at, tz) ?? todayIn(tz);
  const refOf = new Map(rows.map((r, i) => [r.id as string, `t${i + 1}`]));
  const statusName = new Map(statuses.map((s) => [s.id, s.name]));
  const sectionName = new Map(sections.map((s) => [s.id, s.name]));
  const kids = new Map<string, any[]>();
  for (const r of rows) if (r.parent_id) kids.set(r.parent_id, [...(kids.get(r.parent_id) ?? []), r]);
  const convert = (r: any): TemplateTask => {
    const s = dayOf(r.start_at ?? r.due_at, tz);
    const e = dayOf(r.due_at ?? r.start_at, tz);
    const out: TemplateTask = { ref: refOf.get(r.id), title: r.title };
    if (r.description) out.description = r.description;
    if (r.section_id && sectionName.get(r.section_id)) out.section = sectionName.get(r.section_id);
    const st = r.status_id ? statusName.get(r.status_id) : undefined;
    if (st && statuses.find((x) => x.id === r.status_id)?.category !== 'done' && statuses.find((x) => x.id === r.status_id)?.category !== 'todo') out.status = st;
    if (r.priority) out.priority = r.priority;
    const tags = json<string[]>(r.tags, []);
    if (tags.length) out.tags = tags;
    if (r.estimate_minutes) out.estimate_minutes = r.estimate_minutes;
    if (s && e) {
      out.offset = Math.max(0, diffDaysCal(firstStart, s, !!project.skip_weekends));
      out.duration = Math.max(1, diffDaysCal(s, e, !!project.skip_weekends) + 1);
    } else out.nodate = true;
    if (r.milestone) out.milestone = true;
    if (r.internal) out.internal = true;
    const lists = json<any[]>(r.checklists, []);
    if (lists.length) out.checklist = lists.map((c) => ({ title: c.title, items: (c.items ?? []).map((i: any) => i.text) }));
    const mine = deps.filter((d) => d.task_id === r.id && refOf.has(d.depends_on));
    if (mine.length) out.depends_on = mine.map((d) => ({ ref: refOf.get(d.depends_on)!, type: d.type, lag: d.lag }));
    const sub = kids.get(r.id);
    if (sub?.length) out.subtasks = sub.map(convert);
    return out;
  };
  const data: TemplateData = {
    statuses: statuses.map((s) => ({ name: s.name, category: s.category, color: s.color })),
    sections: sections.map((s) => s.name),
    fields: fieldsFor(app, project.location_id, project.id)
      .filter((f) => f.project_id === project.id)
      .map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options })),
    tasks: rows.filter((r) => !r.parent_id).map(convert),
    automations: db.all<any>('SELECT name, trigger, conditions, actions FROM pm_automations WHERE project_id = ?', project.id).map((a) => ({ name: a.name, trigger: a.trigger, conditions: json(a.conditions, {}), actions: json(a.actions, []) })),
    settings: { skip_weekends: !!project.skip_weekends, billable: !!project.billable },
  };
  return cleanTemplateData(data);
}

/** Days between two dates, counting working days only when the project skips weekends. */
function diffDaysCal(a: string, b: string, skipWeekends: boolean): number {
  if (!skipWeekends) return diffDays(a, b);
  let n = 0;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  for (let d = lo; d < hi; ) {
    d = stepDays(d, 1, CALENDAR_DAYS);
    const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return a <= b ? n : -n;
}
