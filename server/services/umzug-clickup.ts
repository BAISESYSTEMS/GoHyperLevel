import type { Account, Batch, CountRow, PartKey, RDoc, RPmComment, RPmTask, RProject, RProjectField, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import type { Json } from './umzug-flow.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { counter, seg, stubCtx } from './umzug-lib.js';
import { clip, fieldKey, toIso } from './umzug-text.js';

/**
 * ClickUp (REST API v2 and the v3 Docs API, https://api.clickup.com, personal API token): every list → a project (the list's statuses
 * become the project's statuses, its custom fields project fields), tasks → tasks, subtasks → subtasks, comments → comments,
 * checklists → checklists, Docs → wiki pages (a doc with its pages below it). The limit is 100 requests a minute per token: calls are
 * paced, and a 429 waits until `X-RateLimit-Reset`. A list's tasks are read in full first (parents before subtasks), then written in
 * batches; a resumed job reads that one list again.
 */

const V2 = 'https://api.clickup.com/api/v2';
const V3 = 'https://api.clickup.com/api/v3';
const BATCH = 100;
/** A dry run reads the comments of this many tasks only (each one is a call). */
const DRY_COMMENTS = 30;

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'ClickUp',
    base: V2,
    headers: () => ({ authorization: String(creds.token ?? '').trim() }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    // 100 requests a minute on the common plans.
    pauseMs: deps.pauseMs ?? 650,
    retryHeaders: ['retry-after', 'x-ratelimit-reset'],
    errorText: (b) => (typeof b?.err === 'string' ? b.err : typeof b?.error === 'string' ? b.error : undefined),
  });

const ms = (v: unknown): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n > 0 ? n : undefined;
};
/** A date-only ClickUp date sits at midnight of somebody's time zone: half a day later is always the right day. */
const dayOf = (v: unknown): string | undefined => {
  const n = ms(v);
  return n ? new Date(n + 12 * 3600_000).toISOString().slice(0, 10) : undefined;
};
const PRIORITY: Record<string, number> = { '1': 4, '2': 3, '3': 2, '4': 1 };

interface Ctxs {
  team: Json;
  space: Json;
  folder?: Json;
  list: Json;
  spaces: number;
}

async function workspaces(h: VendorHttp, creds: Record<string, string>): Promise<Json[]> {
  const j = await h.get('/team');
  const all: Json[] = Array.isArray(j?.teams) ? j.teams : [];
  const only = String(creds.workspace ?? '').trim();
  return only ? all.filter((t) => String(t.id) === only) : all;
}

/** Every list of every (chosen) workspace: folderless lists and the lists in folders. Archived ones are not read. */
async function* lists(h: VendorHttp, ctx: StepCtx): AsyncGenerator<Ctxs> {
  for (const team of await workspaces(h, ctx.creds)) {
    const spaces: Json[] = (await h.get(`/team/${seg(team.id)}/space`, { archived: false }))?.spaces ?? [];
    for (const space of spaces) {
      if (ctx.cancelled()) return;
      for (const list of (await h.get(`/space/${seg(space.id)}/list`, { archived: false }))?.lists ?? []) yield { team, space, list, spaces: spaces.length };
      for (const folder of (await h.get(`/space/${seg(space.id)}/folder`, { archived: false }))?.folders ?? []) for (const list of Array.isArray(folder.lists) ? folder.lists : []) yield { team, space, folder, list, spaces: spaces.length };
    }
  }
}

const projectName = (c: Ctxs) => clip([c.spaces > 1 ? c.space.name : '', c.folder?.name, c.list.name].filter(Boolean).join(' › '), 120) || `Liste ${c.list.id}`;

// --- custom fields ----------------------------------------------------------------------------------------------

interface CField {
  id: string;
  field: RProjectField;
  ctype: string;
  options: Json[];
}
const FIELD_TYPES: Record<string, RProjectField['type']> = { short_text: 'text', text: 'text', email: 'text', phone: 'text', labels: 'text', number: 'number', currency: 'number', rating: 'number', date: 'date', drop_down: 'select', checkbox: 'checkbox', url: 'url' };

export function clickupFields(defs: Json[]): CField[] {
  const out: CField[] = [];
  const keys = new Set<string>();
  for (const f of defs) {
    const type = FIELD_TYPES[String(f.type)];
    if (!type || out.length >= 30) continue;
    const options: Json[] = Array.isArray(f.type_config?.options) ? f.type_config.options : [];
    let key = fieldKey(String(f.name)).slice(0, 36) || 'feld';
    for (let i = 2; keys.has(key); i++) key = `${fieldKey(String(f.name)).slice(0, 32)}_${i}`;
    keys.add(key);
    const names = options.map((o) => String(o.name ?? o.label ?? '')).filter(Boolean);
    out.push({ id: String(f.id), ctype: String(f.type), options, field: { key, label: clip(f.name, 80), type: type === 'select' && !names.length ? 'text' : type, options: type === 'select' ? names : undefined } });
  }
  return out;
}

function fieldValue(f: CField, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const opt = (k: unknown) => f.options.find((o) => String(o.id) === String(k) || (o.orderindex !== undefined && Number(o.orderindex) === Number(k) && /^\d+$/.test(String(k))));
  switch (f.ctype) {
    case 'drop_down': {
      const o = opt(raw);
      return o ? String(o.name ?? o.label) : undefined;
    }
    case 'labels':
      return (Array.isArray(raw) ? raw : [raw]).map((x) => (f.options.find((o) => String(o.id) === String(x))?.label ?? f.options.find((o) => String(o.id) === String(x))?.name ?? String(x))).join(', ');
    case 'date':
      return dayOf(raw);
    case 'checkbox':
      return raw === true || raw === 'true' || raw === 1 || raw === '1' ? true : undefined;
    case 'number':
    case 'currency':
    case 'rating': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    default:
      return typeof raw === 'object' ? undefined : String(raw);
  }
}

async function fieldDefs(h: VendorHttp, listId: string): Promise<CField[]> {
  try {
    const j = await h.get(`/list/${seg(listId)}/field`);
    return clickupFields(Array.isArray(j?.fields) ? j.fields : []);
  } catch (e) {
    if (e instanceof UmzugError && e.skippable) return [];
    throw e;
  }
}

// --- projects ---------------------------------------------------------------------------------------------------

const category = (t: unknown): 'todo' | 'active' | 'done' => (t === 'open' ? 'todo' : t === 'done' || t === 'closed' ? 'done' : 'active');

async function project(h: VendorHttp, c: Ctxs): Promise<{ rec: RProject; fields: CField[] }> {
  const l = await h.get(`/list/${seg(c.list.id)}`).catch((e) => {
    if (e instanceof UmzugError && e.skippable) return c.list;
    throw e;
  });
  const fields = await fieldDefs(h, String(c.list.id));
  const statuses = (Array.isArray(l?.statuses) ? l.statuses : []).sort((a: Json, b: Json) => Number(a.orderindex ?? 0) - Number(b.orderindex ?? 0)).map((s: Json) => ({ name: String(s.status), category: category(s.type), color: typeof s.color === 'string' ? s.color : undefined }));
  const where = [c.space.name ? `Space „${c.space.name}“` : '', c.folder?.name ? `Ordner „${c.folder.name}“` : ''].filter(Boolean).join(' · ');
  return { rec: { kind: 'project', ext: `l:${c.list.id}`, name: projectName(c), description: [l?.content ? String(l.content) : '', where ? `Aus ClickUp: ${where}` : ''].filter(Boolean).join('\n\n') || undefined, statuses, fields: fields.map((f) => f.field) }, fields };
}

// --- tasks ------------------------------------------------------------------------------------------------------

export function clickupTask(t: Json, listId: string, fields: CField[]): RPmTask {
  const custom: Record<string, unknown> = {};
  for (const cf of Array.isArray(t.custom_fields) ? t.custom_fields : []) {
    const def = fields.find((f) => f.id === String(cf.id));
    if (!def) continue;
    const v = fieldValue(def, cf.value);
    if (v !== undefined) custom[def.field.key] = v;
  }
  const checklists = (Array.isArray(t.checklists) ? t.checklists : []).map((c: Json) => ({
    title: String(c.name ?? 'Checkliste'),
    items: (Array.isArray(c.items) ? c.items : []).flatMap((i: Json) => [{ text: String(i.name ?? ''), done: !!i.resolved }, ...(Array.isArray(i.children) ? i.children : []).map((k: Json) => ({ text: `${String(i.name ?? '')} › ${String(k.name ?? '')}`, done: !!k.resolved }))]).filter((i: { text: string }) => i.text.trim()),
  }));
  const status = t.status?.status ? String(t.status.status) : undefined;
  const closed = category(t.status?.type) === 'done';
  const dueTime = t.due_date_time === true || t.due_date_time === 'true';
  const startTime = t.start_date_time === true || t.start_date_time === 'true';
  return {
    kind: 'pm_task',
    ext: `t:${t.id}`,
    project: `l:${listId}`,
    parent: t.parent ? `t:${t.parent}` : undefined,
    title: String(t.name ?? `Aufgabe ${t.id}`),
    description: String(t.markdown_description ?? t.text_content ?? t.description ?? '').trim() || undefined,
    status,
    done: closed,
    priority: PRIORITY[String(t.priority?.id ?? '')],
    start_at: startTime ? toIso(ms(t.start_date)) : dayOf(t.start_date),
    due_at: dueTime ? toIso(ms(t.due_date)) : dayOf(t.due_date),
    tags: (Array.isArray(t.tags) ? t.tags : []).map((x: Json) => String(x.name ?? '')).filter(Boolean),
    estimate_minutes: ms(t.time_estimate) ? Math.round(Number(t.time_estimate) / 60_000) : undefined,
    checklists: checklists.filter((c: { items: unknown[] }) => c.items.length),
    assignees: (Array.isArray(t.assignees) ? t.assignees : []).map((a: Json) => ({ name: a.username, email: a.email })),
    custom,
    created_at: toIso(ms(t.date_created)),
    completed_at: closed ? toIso(ms(t.date_closed) ?? ms(t.date_done)) : undefined,
    url: typeof t.url === 'string' ? t.url : undefined,
  };
}

/** Parents before their subtasks (a task whose parent is not in the list goes to the front, as a top-level task). */
export function parentsFirst(list: RPmTask[]): RPmTask[] {
  const have = new Set(list.map((t) => t.ext));
  const kids = new Map<string, RPmTask[]>();
  const roots: RPmTask[] = [];
  for (const t of list) {
    if (t.parent && have.has(t.parent)) (kids.get(t.parent) ?? kids.set(t.parent, []).get(t.parent)!).push(t);
    else roots.push(t.parent ? { ...t, parent: undefined } : t);
  }
  const out: RPmTask[] = [];
  const walk = (t: RPmTask, depth: number) => {
    out.push(t);
    if (depth < 8) for (const k of kids.get(t.ext) ?? []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

async function comments(h: VendorHttp, taskId: string, ctx: StepCtx): Promise<RPmComment[]> {
  const out: RPmComment[] = [];
  let start: { id: string; date: string } | undefined;
  for (let page = 0; page < 200; page++) {
    if (ctx.cancelled()) break;
    const j = await h.get(`/task/${seg(taskId)}/comment`, start ? { start_id: start.id, start: start.date } : {});
    const list: Json[] = Array.isArray(j?.comments) ? j.comments : [];
    for (const c of list) {
      const body = String(c.comment_text ?? '').trim();
      if (body) out.push({ ext: `c:${c.id}`, author: c.user?.username ? String(c.user.username) : undefined, body, at: toIso(ms(c.date)) });
    }
    const last = list[list.length - 1];
    // 25 per page, newest first; the next page starts after the oldest one of this page.
    if (list.length < 25 || !last || out.length > 5000) break;
    start = { id: String(last.id), date: String(last.date) };
  }
  return out.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
}

async function allTasks(h: VendorHttp, listId: string, fields: CField[], ctx: StepCtx): Promise<RPmTask[]> {
  const out: RPmTask[] = [];
  for (let page = 0; page < 1000; page++) {
    if (ctx.cancelled()) break;
    const j = await h.get(`/list/${seg(listId)}/task`, { page, include_closed: true, subtasks: true, include_markdown_description: true });
    for (const t of Array.isArray(j?.tasks) ? j.tasks : []) out.push(clickupTask(t, listId, fields));
    if (j?.last_page !== false || !Array.isArray(j?.tasks) || !j.tasks.length) break;
    if (out.length >= 200_000) break;
  }
  return out;
}

// --- docs -------------------------------------------------------------------------------------------------------

const md = (v: unknown) => String(v ?? '').trim();

/** A ClickUp doc with its pages: one page → one wiki page; several → the doc as a parent with its pages below. */
export function clickupDocPages(doc: Json, pages: Json[]): RDoc[] {
  const out: RDoc[] = [];
  const root = `d:${doc.id}`;
  const title = String(doc.name ?? `Dokument ${doc.id}`);
  const flat = (list: Json[], parent: string): void => {
    for (const p of list) {
      const ext = `p:${doc.id}:${p.id}`;
      out.push({ kind: 'doc', ext, title: String(p.name || 'Ohne Titel'), body: md(p.content), parent });
      if (Array.isArray(p.pages)) flat(p.pages, ext);
    }
  };
  const single = pages.length === 1 && !(Array.isArray(pages[0].pages) && pages[0].pages.length);
  if (single) {
    const p = pages[0];
    const same = !p.name || String(p.name).trim().toLowerCase() === title.trim().toLowerCase();
    return [{ kind: 'doc', ext: root, title, body: same ? md(p.content) : `# ${p.name}\n\n${md(p.content)}` }];
  }
  out.push({ kind: 'doc', ext: root, title, body: pages.length ? 'Dieses Dokument aus ClickUp besteht aus mehreren Seiten – sie stehen darunter.' : '' });
  flat(pages, root);
  return out;
}

// --- steps ------------------------------------------------------------------------------------------------------

const steps = (): StepDef[] => [
  {
    id: 'lists',
    label: 'Listen → Projekte',
    part: 'projects',
    async *run(ctx): AsyncGenerator<Batch> {
      const after = typeof ctx.cursor === 'string' ? ctx.cursor : undefined;
      let skipping = !!after;
      const records: RProject[] = [];
      for await (const c of lists(ctx.http, ctx)) {
        if (skipping) {
          if (String(c.list.id) === after) skipping = false;
          continue;
        }
        records.push((await project(ctx.http, c)).rec);
        if (records.length >= 10) {
          yield { records: records.splice(0), cursor: String(c.list.id) };
        }
      }
      if (records.length) yield { records, cursor: undefined };
    },
  },
  {
    id: 'tasks',
    label: 'Aufgaben und Unteraufgaben',
    part: 'projects',
    async *run(ctx): AsyncGenerator<Batch> {
      const withComments = ctx.parts.includes('comments');
      let budget = ctx.limit < Infinity ? DRY_COMMENTS : Infinity;
      const resume = ctx.cursor as { list?: string; offset?: number } | undefined;
      let skipping = !!resume?.list;
      for await (const c of lists(ctx.http, ctx)) {
        let offset = 0;
        if (skipping) {
          if (String(c.list.id) !== resume!.list) continue;
          skipping = false;
          if ((resume!.offset ?? 0) < 0) continue;
          offset = resume!.offset ?? 0;
        }
        const fields = await fieldDefs(ctx.http, String(c.list.id));
        const tasks = parentsFirst(await allTasks(ctx.http, String(c.list.id), fields, ctx));
        if (!tasks.length) continue;
        for (let at = offset; at < tasks.length; at += BATCH) {
          if (ctx.cancelled()) return;
          const slice = tasks.slice(at, at + BATCH);
          if (withComments) {
            for (const t of slice) {
              if (budget <= 0) break;
              budget--;
              t.comments = await comments(ctx.http, t.ext.slice(2), ctx);
            }
          }
          const next = at + BATCH;
          yield { records: slice, cursor: { list: String(c.list.id), offset: next < tasks.length ? next : -1 } };
        }
      }
    },
  },
  {
    id: 'docs',
    label: 'Docs → Wiki-Seiten',
    part: 'docs',
    async *run(ctx): AsyncGenerator<Batch> {
      const resume = ctx.cursor as { team?: string; next?: string } | undefined;
      let skipping = !!resume?.team;
      for (const team of await workspaces(ctx.http, ctx.creds)) {
        let cursor: string | undefined;
        if (skipping) {
          if (String(team.id) !== resume!.team) continue;
          skipping = false;
          cursor = resume!.next || undefined;
          if (!cursor && resume!.next === '') continue;
        }
        for (;;) {
          if (ctx.cancelled()) return;
          const j = await ctx.http.get(`${V3}/workspaces/${seg(team.id)}/docs`, { limit: 50, ...(cursor ? { cursor } : {}) });
          const docs: Json[] = Array.isArray(j?.docs) ? j.docs.filter((d: Json) => !d.deleted && !d.archived) : [];
          const records: RDoc[] = [];
          for (const d of docs) {
            try {
              const pages = await ctx.http.get(`${V3}/workspaces/${seg(team.id)}/docs/${seg(d.id)}/pages`, { max_page_depth: -1, content_format: 'text/md' });
              records.push(...clickupDocPages(d, Array.isArray(pages) ? pages : Array.isArray(pages?.pages) ? pages.pages : []));
            } catch (e) {
              if (e instanceof UmzugError && e.skippable) ctx.warn(`Dokument „${clip(d.name, 50)}“ nicht lesbar: ${e.message}`);
              else throw e;
            }
          }
          cursor = typeof j?.next_cursor === 'string' && j.next_cursor ? j.next_cursor : undefined;
          yield { records, cursor: { team: String(team.id), next: cursor ?? '' } };
          if (!cursor) break;
        }
      }
    },
  },
];

// --- describe ---------------------------------------------------------------------------------------------------

async function describe(h: VendorHttp, parts: PartKey[], creds: Record<string, string>) {
  const counts: CountRow[] = [];
  const warnings: string[] = [];
  const count = counter(counts);
  const s = { ...stubCtx(h, parts), creds };
  if (parts.includes('projects')) {
    let tasks = 0;
    await count('projects', 'lists', 'Listen', async () => {
      let n = 0;
      for await (const c of lists(h, s)) {
        n++;
        tasks += Number(c.list.task_count ?? 0);
      }
      return n;
    });
    await count('projects', 'tasks', 'Aufgaben (laut Listen, ohne Unteraufgaben)', async () => tasks);
    warnings.push('ClickUp erlaubt je nach Tarif 100 Anfragen pro Minute. HyperLevel bremst von selbst und wartet bei Bedarf – bei vielen Aufgaben (und besonders mit Kommentaren, eine Anfrage je Aufgabe) dauert der Umzug entsprechend. Er lässt sich jederzeit pausieren und fortsetzen.');
  }
  if (parts.includes('docs')) {
    await count('docs', 'docs', 'Docs', async () => {
      let n = 0;
      for (const team of await workspaces(h, creds)) {
        let cursor: string | undefined;
        for (let i = 0; i < 40; i++) {
          const j = await h.get(`${V3}/workspaces/${seg(team.id)}/docs`, { limit: 100, ...(cursor ? { cursor } : {}) });
          n += (Array.isArray(j?.docs) ? j.docs : []).filter((d: Json) => !d.deleted && !d.archived).length;
          cursor = typeof j?.next_cursor === 'string' && j.next_cursor ? j.next_cursor : undefined;
          if (!cursor) break;
        }
      }
      return n;
    });
  }
  return { counts, fields: [] as SourceField[], warnings };
}

export const CLICKUP: SourceDef = {
  key: 'clickup',
  label: 'ClickUp',
  tagline: 'Listen als Projekte mit Aufgaben, Unteraufgaben, Checklisten, Kommentaren und Docs als Wiki',
  credentials: [
    { key: 'token', label: 'Persönlicher API-Token', secret: true, placeholder: 'pk_12345678_…', hint: 'ClickUp → Avatar → Einstellungen → Apps → „API-Token“ → Generieren' },
    { key: 'workspace', label: 'Workspace-ID (optional)', optional: true, placeholder: '9012345', hint: 'Nur nötig, wenn du nur einen von mehreren Workspaces mitnehmen willst – die Zahl in der Adresse (app.clickup.com/<Zahl>/…)' },
  ],
  howto: [
    'In ClickUp unten links auf deinen Avatar → „Einstellungen“ → „Apps“ → unter „API-Token“ auf „Generieren“ klicken und den Token (beginnt mit pk_) kopieren.',
    'Den Token hier einfügen. Er sieht alles, was du in ClickUp siehst – HyperLevel liest nur und ändert dort nichts.',
    'Nach dem Umzug den Token in ClickUp neu generieren (damit wird der alte ungültig).',
  ],
  limits: [
    'Dateien und Anhänge an Aufgaben und Kommentaren (bleiben bei ClickUp), Bilder in Docs verweisen noch dorthin',
    'Automationen, Ansichten (Board, Gantt, Kalender), Dashboards, Ziele, Formulare und Zeiterfassungs-Einträge',
    'Abhängigkeiten und verknüpfte Aufgaben, Aufgabentypen und Meilensteine, Sprints und Story Points',
    'Zuständige: nur Personen, deren E-Mail in HyperLevel ein Teammitglied hat, werden zugewiesen – alle anderen stehen mit Namen in der Beschreibung',
    'Archivierte Spaces, Ordner, Listen und Docs sowie der Papierkorb',
  ],
  parts: [
    { key: 'projects', label: 'Listen → Projekte, Aufgaben → Aufgaben, Unteraufgaben → Unteraufgaben', on: true, note: 'Die Status der Liste werden die Status des Projekts, Priorität, Termine, Tags, Checklisten und Zeitschätzung kommen mit, benutzerdefinierte Felder werden Projektfelder.' },
    { key: 'comments', label: 'Kommentare zu den Aufgaben', on: false, note: 'Eine Anfrage je Aufgabe – bei 100 Anfragen pro Minute dauert das bei großen Listen. Mit Autor und Zeitpunkt, ohne Benachrichtigung ans Team.' },
    { key: 'docs', label: 'Docs → Wiki-Seiten', on: true, note: 'Im Wiki-Bereich „ClickUp“, ein Doc mit mehreren Seiten wird eine Seite mit Unterseiten.' },
  ],
  exports: [],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const j = await h.get('/user');
    const u = j?.user;
    if (!u?.id) throw new UmzugError(401, 'ClickUp: Zugangsdaten ungültig oder abgelaufen');
    const teams = await workspaces(h, creds);
    if (!teams.length) throw new UmzugError(400, creds.workspace ? 'ClickUp: Diese Workspace-ID gehört nicht zu deinem Zugang' : 'ClickUp: Dein Zugang gehört zu keinem Workspace');
    return { account: `u-${u.id}`, label: `${u.username ?? u.email ?? 'ClickUp'} (${teams.map((t) => t.name).slice(0, 3).join(', ')}${teams.length > 3 ? ' …' : ''})`, meta: {} };
  },
  describe: (h, parts, ctx) => describe(h, parts, ctx.creds),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
