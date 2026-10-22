import type { App, Module } from '../core/app.js';
import { HttpError } from '../core/http.js';
import type { ReportSource } from '../services/report-engine.js';
import { lookupTable, userLookup } from '../services/report-sources.js';
import type { Caller, Tool } from './mcp.js';

/**
 * MCP tools for the planner (projects, tasks with subtasks, status moves, time, timesheets, billing) – so the
 * HyperLevel Agent, Claude, ChatGPT and Codex can plan and track work. Every tool is a thin relay onto the REST API
 * (rights, validation, audit log apply). "Projekt" here means a planning project inside a sub-account, not the
 * sub-account itself (that is `location_id`). Also registers the report sources "Zeiteinträge" and "Projekte".
 */

type Json = Record<string, any>;
const LOC = { location_id: { type: 'string', description: 'Sub-Account-ID (aus ghl_list_projects)' } };
const obj = (props: Json, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const q = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};

const SUBTASK = {
  type: 'object',
  description: 'Unteraufgabe (kann selbst subtasks enthalten): {title, description?, assignees?, due_at?, priority?, estimate_hours?, subtasks?}',
  additionalProperties: true,
};
const TASK_FIELDS = {
  title: { type: 'string' },
  description: { type: 'string' },
  project_id: { type: 'string', description: 'Planungsprojekt (aus ghl_pm_list_projects); ohne Angabe: „Allgemein“' },
  parent_id: { type: 'string', description: 'Übergeordnete Aufgabe (macht die neue zur Unteraufgabe)' },
  status: { type: 'string', description: 'Statusname des Projekts, z. B. „In Arbeit“ (siehe ghl_pm_get_project)' },
  priority: { type: 'string', enum: ['none', 'low', 'normal', 'high', 'urgent'] },
  assignees: { type: 'array', items: { type: 'string' }, description: 'Zuständige: Nutzer-ID, E-Mail oder Name (siehe ghl_pm_team)' },
  watchers: { type: 'array', items: { type: 'string' } },
  start_at: { type: 'string', description: 'Start, JJJJ-MM-TT oder ISO 8601' },
  due_at: { type: 'string', description: 'Fällig, JJJJ-MM-TT oder ISO 8601' },
  estimate_hours: { type: 'number', description: 'Geschätzter Aufwand in Stunden' },
  tags: { type: 'array', items: { type: 'string' } },
  section_id: { type: 'string' },
  contact_id: { type: 'string' },
  milestone: { type: 'boolean' },
  checklists: { type: 'array', items: { type: 'object' }, description: '[{title, items:[{text, done?}]}]' },
  recurrence: { type: 'object', description: '{freq: daily|weekly|monthly|yearly, interval?, weekdays?, mode?: due|completion, end?}' },
  custom: { type: 'object', description: 'Eigene Felder {schlüssel: wert}' },
};

/** Names, e-mail addresses or ids → user ids (against the sub-account's team). */
async function people(call: Caller, loc: string, list: unknown): Promise<string[] | undefined> {
  if (!Array.isArray(list)) return undefined;
  const team: any[] = await call.api('GET', '/api/pm/team', { location: loc });
  return list.map((x) => {
    const s = String(x).trim().toLowerCase();
    const p = team.find((u) => u.id === x) ?? team.find((u) => u.email.toLowerCase() === s) ?? team.find((u) => u.name.toLowerCase() === s) ?? team.find((u) => u.name.toLowerCase().startsWith(s));
    if (!p) throw new HttpError(400, `Person „${x}“ nicht gefunden – verfügbar: ${team.map((u) => u.name).join(', ')}`);
    return p.id as string;
  });
}

/** A subtask tree: names → ids for every level. */
async function withPeople(call: Caller, loc: string, t: Json): Promise<Json> {
  const out: Json = { ...t };
  if (t.assignees !== undefined) out.assignees = await people(call, loc, t.assignees);
  if (t.watchers !== undefined) out.watchers = await people(call, loc, t.watchers);
  if (Array.isArray(t.subtasks)) out.subtasks = await Promise.all(t.subtasks.map((s: unknown) => (typeof s === 'string' ? { title: s } : withPeople(call, loc, s as Json))));
  return out;
}

const brief = (t: any) => ({
  id: t.id,
  title: t.title,
  project: t.project?.name,
  project_id: t.project_id,
  parent_id: t.parent_id,
  status: t.status?.name,
  done: t.done,
  priority: t.priority_label,
  assignees: t.assignees?.map((a: any) => a.name),
  start_at: t.start_at,
  due_at: t.due_at,
  estimate_hours: t.estimate_minutes ? Math.round((t.estimate_minutes / 60) * 100) / 100 : undefined,
  logged_hours: t.logged_seconds ? Math.round((t.logged_seconds / 3600) * 100) / 100 : undefined,
  tags: t.tags?.length ? t.tags : undefined,
  subtasks: t.subtasks?.total ? `${t.subtasks.done}/${t.subtasks.total}` : undefined,
  blocked: t.blocked || undefined,
  link: `/app/pm/task/${t.id}`,
});

const taskBody = (a: Json) => {
  const { location_id: _l, task_id: _t, estimate_hours, ...rest } = a;
  return { ...rest, ...(estimate_hours !== undefined ? { estimate_hours } : {}) };
};

export const TOOLS: Tool[] = [
  {
    name: 'ghl_pm_team',
    title: 'Planung: Team',
    description: 'Die Personen eines Sub-Accounts, die Aufgaben bekommen können (id, Name, E-Mail) – für Zuständige, Beobachter und Zeiterfassung.',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: RO,
    run: (call, a) => call.api('GET', '/api/pm/team', { location: a.location_id }),
  },
  {
    name: 'ghl_pm_list_projects',
    title: 'Planung: Projekte auflisten',
    description: 'Die Planungsprojekte eines Sub-Accounts (nicht zu verwechseln mit dem Sub-Account selbst) mit Fortschritt, offenen/überfälligen Aufgaben, Kunde und gebuchten Stunden. Das Projekt „Allgemein“ enthält Aufgaben ohne eigenes Projekt.',
    inputSchema: obj({ ...LOC, status: { type: 'string', enum: ['active', 'paused', 'done', 'archived', 'all'] }, contact_id: { type: 'string', description: 'Nur Projekte dieses Kunden' } }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      const list: any[] = await call.api('GET', `/api/pm/projects${q({ status: a.status, contact_id: a.contact_id })}`, { location: a.location_id });
      return list.map((p) => ({ id: p.id, name: p.name, status: p.status, progress_percent: p.progress, tasks: p.stats.tasks, open: p.stats.open, overdue: p.stats.overdue, next_due: p.stats.next_due, logged_hours: Math.round((p.stats.logged_seconds / 3600) * 10) / 10, customer: p.contact_name || p.company_name || undefined, due_at: p.due_at, portal: p.portal_visible || undefined }));
    },
  },
  {
    name: 'ghl_pm_get_project',
    title: 'Planung: Projekt ansehen',
    description: 'Ein Planungsprojekt mit seinen Status (Namen für ghl_pm_move_task), Abschnitten, eigenen Feldern und Kennzahlen.',
    inputSchema: obj({ ...LOC, project_id: { type: 'string' } }, ['location_id', 'project_id']),
    annotations: RO,
    run: (call, a) => call.api('GET', `/api/pm/projects/${encodeURIComponent(a.project_id)}`, { location: a.location_id }),
  },
  {
    name: 'ghl_pm_create_project',
    title: 'Planung: Projekt anlegen',
    description: 'Legt ein Planungsprojekt an – leer oder aus einer Vorlage (template: „kunden-onboarding“, „website-projekt“ oder die ID einer gespeicherten Vorlage; Aufgaben, Abhängigkeiten und Termine werden ab `start` berechnet). Kunde per contact_id/company_id/opportunity_id verknüpfbar.',
    inputSchema: obj(
      { ...LOC, name: { type: 'string' }, description: { type: 'string' }, template: { type: 'string' }, start: { type: 'string', description: 'Starttag JJJJ-MM-TT (für Vorlagen)' }, contact_id: { type: 'string' }, company_id: { type: 'string' }, opportunity_id: { type: 'string' }, hourly_rate_euro: { type: 'number', description: 'Stundensatz des Projekts in Euro' }, billable: { type: 'boolean' }, portal_visible: { type: 'boolean', description: 'Im Kundenportal (nur lesend) zeigen' } },
      ['location_id', 'name'],
    ),
    annotations: W,
    run: (call, a) => {
      const { location_id, hourly_rate_euro, ...body } = a;
      return call.api('POST', '/api/pm/projects', { location: location_id, body: { ...body, ...(hourly_rate_euro !== undefined ? { hourly_rate_cents: Math.round(Number(hourly_rate_euro) * 100) } : {}) } });
    },
  },
  {
    name: 'ghl_pm_list_tasks',
    title: 'Planung: Aufgaben eines Projekts',
    description: 'Aufgaben (mit Unteraufgaben) eines Planungsprojekts oder eines ganzen Sub-Accounts, filterbar nach Status/Kategorie, Zuständigen, Priorität, Tag, Fälligkeit und Suchtext. Ergebnis ist kurz gefasst; Details mit ghl_pm_get_task.',
    inputSchema: obj(
      {
        ...LOC,
        project_id: { type: 'string' },
        status: { type: 'string', description: 'Statusname' },
        category: { type: 'string', enum: ['todo', 'active', 'done'] },
        done: { type: 'string', enum: ['open', 'done', 'all'], description: 'Standard: open' },
        assignee: { type: 'string', description: 'Nutzer-ID, E-Mail, Name, „none“ (niemand) oder „me“' },
        priority: { type: 'string' },
        tag: { type: 'string' },
        due: { type: 'string', enum: ['overdue', 'today', 'week', 'month', 'none'] },
        query: { type: 'string' },
        top_level: { type: 'boolean', description: 'Nur Aufgaben ohne übergeordnete Aufgabe' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      ['location_id'],
    ),
    annotations: RO,
    run: async (call, a) => {
      let status_id: string | undefined;
      if (a.status && a.project_id) {
        const p = await call.api('GET', `/api/pm/projects/${encodeURIComponent(a.project_id)}`, { location: a.location_id });
        status_id = p.statuses.find((s: any) => s.name.toLowerCase() === String(a.status).toLowerCase())?.id;
        if (!status_id) throw new HttpError(400, `Status „${a.status}“ gibt es nicht – verfügbar: ${p.statuses.map((s: any) => s.name).join(', ')}`);
      }
      const assignee = a.assignee && !['none', 'me'].includes(a.assignee) ? (await people(call, a.location_id, [a.assignee]))![0] : a.assignee;
      const r = await call.api('GET', `/api/pm/tasks${q({ project_id: a.project_id, status_id, category: a.category, done: a.done === 'all' ? undefined : a.done === 'done' ? '1' : '0', assignee, priority: a.priority, tag: a.tag, due: a.due, q: a.query, parent: a.top_level ? 'none' : undefined, limit: a.limit ?? 100, sort: 'position' })}`, { location: a.location_id });
      return { total: r.total, tasks: r.tasks.map(brief) };
    },
  },
  {
    name: 'ghl_pm_get_task',
    title: 'Planung: Aufgabe ansehen',
    description: 'Eine Aufgabe mit Unteraufgaben, Checklisten, Abhängigkeiten, Kommentaren, Anhängen, Aktivität und gebuchter Zeit.',
    inputSchema: obj({ ...LOC, task_id: { type: 'string' } }, ['location_id', 'task_id']),
    annotations: RO,
    run: async (call, a) => {
      const r = await call.api('GET', `/api/pm/tasks/${encodeURIComponent(a.task_id)}`, { location: a.location_id });
      return {
        ...brief(r.task),
        description: r.task.description,
        checklists: r.task.checklists,
        recurrence: r.task.recurrence_text || undefined,
        custom: r.task.custom,
        subtasks: r.subtasks.map(brief),
        waits_for: r.dependencies.blocked_by.map((d: any) => ({ task: d.title, type: d.type, lag_days: d.lag, done: d.done })),
        blocks: r.dependencies.blocking.map((d: any) => ({ task: d.title, type: d.type })),
        comments: r.comments.slice(-15).map((c: any) => ({ by: c.author_name, at: c.created_at, text: c.body })),
        attachments: r.attachments.map((x: any) => ({ name: x.name, url: x.url })),
        project_statuses: r.statuses.map((s: any) => s.name),
      };
    },
  },
  {
    name: 'ghl_pm_create_task',
    title: 'Planung: Aufgabe anlegen',
    description: 'Legt eine Aufgabe an – auch mit Unteraufgaben in einem Aufruf (subtasks, beliebig verschachtelt, z. B. für einen ganzen Projektplan), Checkliste, Zuständigen, Terminen, Aufwand und Wiederholung. Zuständige per Name, E-Mail oder ID.',
    inputSchema: obj({ ...LOC, ...TASK_FIELDS, subtasks: { type: 'array', items: { anyOf: [{ type: 'string' }, SUBTASK] }, description: 'Unteraufgaben (Titel oder Objekte, verschachtelbar)' } }, ['location_id', 'title']),
    annotations: W,
    run: async (call, a) => {
      const body = await withPeople(call, a.location_id, taskBody(a));
      const t = await call.api('POST', '/api/pm/tasks', { location: a.location_id, body });
      return brief(t);
    },
  },
  {
    name: 'ghl_pm_update_task',
    title: 'Planung: Aufgabe ändern',
    description: 'Ändert Felder einer Aufgabe (nur übergebene): Titel, Beschreibung, Status, Priorität, Zuständige (assignees ersetzt, add_assignees ergänzt), Termine, Aufwand, Tags, Checklisten, Projekt (verschiebt samt Unteraufgaben). Weitere Unteraufgaben mit ghl_pm_create_task und parent_id.',
    inputSchema: obj({ ...LOC, task_id: { type: 'string' }, ...TASK_FIELDS, title: { type: 'string' }, add_assignees: { type: 'array', items: { type: 'string' } }, remove_assignees: { type: 'array', items: { type: 'string' } } }, ['location_id', 'task_id']),
    annotations: { ...W, idempotentHint: true },
    run: async (call, a) => {
      const body: Json = await withPeople(call, a.location_id, taskBody(a));
      if (a.add_assignees) body.add_assignees = await people(call, a.location_id, a.add_assignees);
      if (a.remove_assignees) body.remove_assignees = await people(call, a.location_id, a.remove_assignees);
      return brief(await call.api('PATCH', `/api/pm/tasks/${encodeURIComponent(a.task_id)}`, { location: a.location_id, body }));
    },
  },
  {
    name: 'ghl_pm_move_task',
    title: 'Planung: Status setzen',
    description: 'Setzt den Status einer Aufgabe (Name aus dem Projekt, z. B. „In Prüfung“) oder nur die Kategorie (todo|active|done). „Erledigt“ schließt die Aufgabe ab (wiederkehrende Aufgaben legen die nächste an).',
    inputSchema: obj({ ...LOC, task_id: { type: 'string' }, status: { type: 'string', description: 'Statusname' }, category: { type: 'string', enum: ['todo', 'active', 'done'] } }, ['location_id', 'task_id']),
    annotations: { ...W, idempotentHint: true },
    run: async (call, a) => {
      if (!a.status && !a.category) throw new HttpError(400, 'status oder category angeben');
      return brief(await call.api('POST', `/api/pm/tasks/${encodeURIComponent(a.task_id)}/move`, { location: a.location_id, body: { status: a.status, category: a.category } }));
    },
  },
  {
    name: 'ghl_pm_comment',
    title: 'Planung: Kommentar',
    description: 'Kommentiert eine Aufgabe. @Name im Text (oder mentions: [Nutzer-IDs]) benachrichtigt die Person.',
    inputSchema: obj({ ...LOC, task_id: { type: 'string' }, body: { type: 'string' }, mentions: { type: 'array', items: { type: 'string' } } }, ['location_id', 'task_id', 'body']),
    annotations: W,
    run: async (call, a) => {
      const mentions = await people(call, a.location_id, a.mentions);
      const c = await call.api('POST', `/api/pm/tasks/${encodeURIComponent(a.task_id)}/comments`, { location: a.location_id, body: { body: a.body, mentions } });
      return { id: c.id, mentioned: c.mentions.map((m: any) => m.name) };
    },
  },
  {
    name: 'ghl_pm_add_dependency',
    title: 'Planung: Abhängigkeit',
    description: 'Lässt eine Aufgabe auf eine andere warten (task_id wartet auf depends_on). type: FS Ende→Start (Standard), SS Start→Start, FF Ende→Ende, SF Start→Ende; lag_days = Versatz in Tagen (negativ = Überlappung). Zirkelbezüge werden abgelehnt. Mit adjust_dates=true werden Termine nachgezogen.',
    inputSchema: obj({ ...LOC, task_id: { type: 'string' }, depends_on: { type: 'string' }, type: { type: 'string', enum: ['FS', 'SS', 'FF', 'SF'] }, lag_days: { type: 'integer' }, adjust_dates: { type: 'boolean' } }, ['location_id', 'task_id', 'depends_on']),
    annotations: W,
    run: async (call, a) => {
      const r = await call.api('POST', `/api/pm/tasks/${encodeURIComponent(a.task_id)}/dependencies`, { location: a.location_id, body: { depends_on: a.depends_on, type: a.type, lag: a.lag_days } });
      if (a.adjust_dates) {
        const t = await call.api('GET', `/api/pm/tasks/${encodeURIComponent(a.depends_on)}`, { location: a.location_id });
        await call.api('PATCH', `/api/pm/tasks/${encodeURIComponent(a.depends_on)}/dates`, { location: a.location_id, body: { start: t.task.start_at?.slice(0, 10), due: t.task.due_at?.slice(0, 10), cascade: true } });
      }
      return { waits_for: r.blocked_by.map((d: any) => ({ task: d.title, type: d.type, lag_days: d.lag })) };
    },
  },
  {
    name: 'ghl_pm_gantt',
    title: 'Planung: Zeitplan und kritischer Pfad',
    description: 'Der Zeitplan eines Projekts (Start/Ende je Aufgabe, Abhängigkeiten, Puffer) mit kritischem Pfad und verletzten Abhängigkeiten.',
    inputSchema: obj({ ...LOC, project_id: { type: 'string' } }, ['location_id', 'project_id']),
    annotations: RO,
    run: async (call, a) => {
      const g = await call.api('GET', `/api/pm/projects/${encodeURIComponent(a.project_id)}/gantt`, { location: a.location_id });
      const title = new Map<string, string>(g.tasks.map((t: any) => [t.id, t.title]));
      return {
        project: g.project.name,
        ends: g.critical_end,
        tasks: g.tasks.map((t: any) => ({ id: t.id, title: t.title, start: t.start, end: t.end, done: t.done || undefined, critical: t.critical || undefined, float_days: t.float ?? undefined, depth: t.depth || undefined })),
        dependencies: g.deps.map((d: any) => ({ task: title.get(d.task), waits_for: title.get(d.on), type: d.type, lag_days: d.lag, critical: d.critical || undefined, violated: d.violated || undefined })),
      };
    },
  },
  {
    name: 'ghl_pm_log_time',
    title: 'Zeit buchen',
    description: 'Bucht Arbeitszeit auf eine Aufgabe oder ein Projekt: minutes/hours am Tag `date` (Standard heute) oder start_at + end_at. Überschneidungen mit anderen Einträgen derselben Person werden abgelehnt. user_id: wessen Zeit (Standard: der angemeldete Nutzer).',
    inputSchema: obj(
      { ...LOC, task_id: { type: 'string' }, project_id: { type: 'string' }, minutes: { type: 'number' }, hours: { type: 'number' }, date: { type: 'string', description: 'JJJJ-MM-TT' }, start_at: { type: 'string' }, end_at: { type: 'string' }, note: { type: 'string' }, billable: { type: 'boolean' }, user_id: { type: 'string', description: 'Nutzer-ID, E-Mail oder Name' } },
      ['location_id'],
    ),
    annotations: W,
    run: async (call, a) => {
      const user_id = a.user_id ? (await people(call, a.location_id, [a.user_id]))![0] : undefined;
      const { location_id, ...rest } = a;
      const e = await call.api('POST', '/api/pm/time', { location: location_id, body: { ...rest, user_id } });
      return { id: e.id, hours: Math.round((e.seconds / 3600) * 100) / 100, day: e.day, task: e.task_title || undefined, project: e.project_name, billable: e.billable };
    },
  },
  {
    name: 'ghl_pm_timer',
    title: 'Zeit: Timer starten/stoppen',
    description: 'Startet den Timer einer Person auf einer Aufgabe/einem Projekt (ein laufender Timer wird dabei gestoppt – es läuft immer nur einer) oder stoppt ihn. action: start | stop | status.',
    inputSchema: obj({ ...LOC, action: { type: 'string', enum: ['start', 'stop', 'status'] }, task_id: { type: 'string' }, project_id: { type: 'string' }, note: { type: 'string' }, user_id: { type: 'string' } }, ['location_id', 'action']),
    annotations: W,
    run: async (call, a) => {
      const user_id = a.user_id ? (await people(call, a.location_id, [a.user_id]))![0] : undefined;
      if (a.action === 'status') return call.api('GET', `/api/pm/timer${q({ user_id })}`, { location: a.location_id });
      if (a.action === 'stop') {
        const r = await call.api('POST', '/api/pm/timer/stop', { location: a.location_id, body: { user_id, note: a.note } });
        return { stopped: r.entry ? { hours: Math.round((r.entry.seconds / 3600) * 100) / 100, task: r.entry.task_title } : null, discarded: r.discarded };
      }
      const r = await call.api('POST', '/api/pm/timer/start', { location: a.location_id, body: { task_id: a.task_id, project_id: a.project_id, note: a.note, user_id } });
      return { running: { task: r.entry.task_title || r.entry.project_name, since: r.entry.started_at }, stopped_previous: r.stopped ? { task: r.stopped.task_title, hours: Math.round((r.stopped.seconds / 3600) * 100) / 100 } : undefined, already_running: r.already_running };
    },
  },
  {
    name: 'ghl_pm_timesheet_summary',
    title: 'Zeit: Auswertung',
    description: 'Stunden im Zeitraum gruppiert nach Projekt, Person, Kunde, Aufgabe, Tag oder Woche (gesamt und abrechenbar). Ohne Zeitraum: die laufende Woche. Mit week + user_id: der Wochenzettel einer Person (Tage × Aufgaben, Freigabestatus).',
    inputSchema: obj({ ...LOC, from: { type: 'string' }, to: { type: 'string' }, group: { type: 'string', enum: ['project', 'user', 'client', 'task', 'day', 'week'] }, project_id: { type: 'string' }, user_id: { type: 'string' }, week: { type: 'string', description: 'Ein Tag der Woche (JJJJ-MM-TT) – liefert den Wochenzettel von user_id' } }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      const user_id = a.user_id ? (await people(call, a.location_id, [a.user_id]))![0] : undefined;
      if (a.week) {
        const s = await call.api('GET', `/api/pm/timesheet${q({ week: a.week, user_id })}`, { location: a.location_id });
        return { week: s.week, status: s.status, total_hours: Math.round((s.total / 3600) * 100) / 100, billable_hours: Math.round((s.billable_total / 3600) * 100) / 100, days: Object.fromEntries(Object.entries(s.totals).map(([d, v]) => [d, Math.round((Number(v) / 3600) * 100) / 100])), rows: s.rows.map((r: any) => ({ task: r.title, project: r.project_name, hours: Math.round((r.total / 3600) * 100) / 100 })) };
      }
      const r = await call.api('GET', `/api/pm/time/report${q({ from: a.from, to: a.to, group: a.group ?? 'project', project_id: a.project_id, user_id })}`, { location: a.location_id });
      const h = (s: number) => Math.round((s / 3600) * 100) / 100;
      return { group: r.group, total_hours: h(r.total_seconds), billable_hours: h(r.billable_seconds), rows: r.rows.map((x: any) => ({ name: x.label, hours: h(x.seconds), billable_hours: h(x.billable_seconds), entries: x.entries })) };
    },
  },
  {
    name: 'ghl_pm_invoice_time',
    title: 'Zeit: In Rechnung stellen',
    description: 'Erstellt aus den abrechenbaren, noch nicht abgerechneten Zeiten eines Projekts einen Rechnungsentwurf (Rechnungsmodul): Stunden × Stundensatz (Person im Projekt → Projekt → Person → Standard), Zeilen je Aufgabe/Person/Projekt/Eintrag. Die Einträge gelten danach als abgerechnet; verschickt wird nichts.',
    inputSchema: obj({ ...LOC, project_id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, group_by: { type: 'string', enum: ['task', 'user', 'project', 'entry'] }, title: { type: 'string' }, notes: { type: 'string' }, contact_id: { type: 'string', description: 'Rechnungsempfänger, falls das Projekt keinen Kunden hat' } }, ['location_id', 'project_id']),
    annotations: W,
    run: async (call, a) => {
      const { location_id, ...body } = a;
      const r = await call.api('POST', '/api/pm/billing/invoice', { location: location_id, body });
      return { invoice_number: r.invoice.number || null, invoice_id: r.invoice.id, status: r.invoice.status, entries: r.entries, hours: r.hours, net_euro: r.amount_cents / 100, link: `/app/invoices/${r.invoice.id}` };
    },
  },
  {
    name: 'ghl_pm_my_tasks',
    title: 'Planung: Meine Aufgaben',
    description: 'Offene Aufgaben einer Person über alle Projekte, nach Fälligkeit gruppiert (überfällig, heute, diese Woche, später, ohne Datum).',
    inputSchema: obj({ ...LOC, user_id: { type: 'string', description: 'Nutzer-ID, E-Mail oder Name (Standard: der angemeldete Nutzer)' } }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      const user_id = a.user_id ? (await people(call, a.location_id, [a.user_id]))![0] : undefined;
      const r = await call.api('GET', `/api/pm/my-tasks${q({ user_id })}`, { location: a.location_id });
      return { counts: r.counts, ...Object.fromEntries(Object.entries(r.buckets).map(([k, v]) => [k, (v as any[]).map(brief)])) };
    },
  },
];

// --- report sources -----------------------------------------------------------------------------

const PROJECT_LOOKUP = lookupTable('pm_projects', 'name');

const TIME_ENTRIES: ReportSource = {
  key: 'time_entries',
  label: 'Zeiteinträge',
  description: 'Gebuchte Arbeitszeit je Projekt, Person, Aufgabe und Tag – gesamt und abrechenbar.',
  area: 'contacts',
  from: 'pm_time_entries e',
  location: 'e.location_id',
  where: 'e.ended_at IS NOT NULL',
  dateField: 'started_at',
  requires: ['pm_time_entries'],
  countLabel: 'Anzahl Einträge',
  fields: [
    { key: 'started_at', label: 'Datum', type: 'date', sql: 'e.started_at' },
    { key: 'user', label: 'Person', type: 'string', sql: 'e.user_id', lookup: userLookup, empty: 'Unbekannt' },
    { key: 'project', label: 'Projekt', type: 'string', sql: 'e.project_id', lookup: PROJECT_LOOKUP, empty: 'Ohne Projekt' },
    { key: 'task', label: 'Aufgabe', type: 'string', sql: `NULLIF(e.task_title, '')`, empty: 'Ohne Aufgabe' },
    { key: 'billable', label: 'Abrechenbar', type: 'boolean', sql: 'e.billable', options: { '1': 'Abrechenbar', '0': 'Nicht abrechenbar' } },
    { key: 'billed', label: 'Abgerechnet', type: 'boolean', sql: 'CASE WHEN e.invoice_id IS NULL THEN 0 ELSE 1 END', options: { '1': 'Abgerechnet', '0': 'Offen' } },
    { key: 'approval', label: 'Freigabe', type: 'enum', sql: 'e.approval', options: { open: 'Offen', submitted: 'Abgegeben', approved: 'Freigegeben', rejected: 'Abgelehnt' } },
    { key: 'source', label: 'Herkunft', type: 'enum', sql: 'e.source', options: { timer: 'Timer', manual: 'Manuell', api: 'API / KI' } },
    { key: 'hours', label: 'Stunden', type: 'number', sql: '(e.seconds / 3600.0)', format: 'number' },
  ],
  calcs: [
    { key: 'hours_total', label: 'Stunden gesamt', sql: 'COALESCE(SUM(e.seconds), 0) / 3600.0', format: 'number' },
    { key: 'hours_billable', label: 'Stunden abrechenbar', sql: 'COALESCE(SUM(CASE WHEN e.billable = 1 THEN e.seconds END), 0) / 3600.0', format: 'number' },
    { key: 'billable_share', label: 'Anteil abrechenbar', sql: '100.0 * SUM(CASE WHEN e.billable = 1 THEN e.seconds END) / NULLIF(SUM(e.seconds), 0)', format: 'percent' },
  ],
};

const PM_PROJECTS: ReportSource = {
  key: 'pm_projects',
  label: 'Planungsprojekte',
  description: 'Projekte mit Status, Kunde und Aufgabenzahlen.',
  area: 'contacts',
  from: 'pm_projects p',
  location: 'p.location_id',
  where: 'p.is_default = 0',
  dateField: 'created_at',
  requires: ['pm_projects'],
  countLabel: 'Anzahl Projekte',
  fields: [
    { key: 'created_at', label: 'Angelegt am', type: 'date', sql: 'p.created_at' },
    { key: 'due_at', label: 'Zieltermin', type: 'date', sql: 'p.due_at' },
    { key: 'status', label: 'Status', type: 'enum', sql: 'p.status', options: { active: 'Aktiv', paused: 'Pausiert', done: 'Abgeschlossen', archived: 'Archiviert' } },
    { key: 'name', label: 'Name', type: 'string', sql: 'p.name', noGroup: true },
    { key: 'owner', label: 'Verantwortlich', type: 'string', sql: 'p.owner_id', lookup: userLookup, empty: 'Niemand' },
    { key: 'open_tasks', label: 'Offene Aufgaben', type: 'number', sql: '(SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.done = 0)', format: 'number' },
    { key: 'done_tasks', label: 'Erledigte Aufgaben', type: 'number', sql: '(SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.done = 1)', format: 'number' },
    { key: 'hours', label: 'Gebuchte Stunden', type: 'number', sql: '(SELECT COALESCE(SUM(e.seconds), 0) / 3600.0 FROM pm_time_entries e WHERE e.project_id = p.id AND e.ended_at IS NOT NULL)', format: 'number' },
  ],
};

export const pmToolsModule: Module = {
  name: 'pm-tools',
  register(app: App) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.reportSources = [...(app.services.reportSources ?? []), TIME_ENTRIES, PM_PROJECTS];
  },
};
