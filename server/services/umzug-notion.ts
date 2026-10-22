import type { Account, Batch, CountRow, PartKey, RDoc, RObjectLink, RObjectProp, RObjectRecord, RObjectType, RPmComment, RPmTask, RProject, RProjectField, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import type { Json } from './umzug-flow.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { counter, priorityWord, seg, stubCtx } from './umzug-lib.js';
import { clip, fieldKey, toIso } from './umzug-text.js';

/**
 * Notion (REST API, https://api.notion.com/v1, an internal integration's token): databases with a status property → projects with
 * tasks (the page's content becomes the description), all other databases → custom objects with typed properties and records (relations
 * between them as links), the pages that are not database rows → wiki pages with their hierarchy, comments → comments on the tasks.
 * Only what the integration has been shared with is visible (Notion's rule, not ours). The API allows three requests a second on
 * average; a 429 waits for Retry-After. Pinned to the API version 2022-06-28.
 */

const API = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';
const PAGE = 100;
/** Nested blocks are followed this deep, and at most this many block calls are made for one page. */
const DEPTH = 4;
const BLOCK_CALLS = 60;
const DRY_BODIES = 40;

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'Notion',
    base: API,
    headers: () => ({ authorization: `Bearer ${String(creds.token ?? '').trim()}`, 'notion-version': NOTION_VERSION }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 340,
    errorText: (b) => (typeof b?.message === 'string' ? b.message : undefined),
  });

const post = (h: VendorHttp, path: string, body: unknown, query?: Record<string, unknown>) => h.req('POST', path, { body, query });

// --- rich text and values ---------------------------------------------------------------------------------------

/** Rich text as plain text. */
export const plain = (rt: unknown): string => (Array.isArray(rt) ? rt.map((t: Json) => String(t?.plain_text ?? '')).join('') : '');

/** Rich text as Markdown (bold, italic, strike, code, links). */
export function richMd(rt: unknown): string {
  let out = '';
  for (const t of Array.isArray(rt) ? rt : []) {
    const text = String(t?.plain_text ?? '');
    if (!text) continue;
    const a = t.annotations ?? {};
    const lead = /^\s*/.exec(text)![0];
    const tail = /\s*$/.exec(text)![0];
    let core = text.trim();
    if (!core) {
      out += text;
      continue;
    }
    if (a.code) core = `\`${core}\``;
    if (a.bold) core = `**${core}**`;
    if (a.italic) core = `*${core}*`;
    if (a.strikethrough) core = `~~${core}~~`;
    const href = t.href ?? t.text?.link?.url;
    if (typeof href === 'string' && /^https?:\/\//i.test(href)) core = `[${core}](${href})`;
    out += `${lead}${core}${tail}`;
  }
  return out;
}

const day = (v: unknown): string | undefined => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : undefined);
const titleOf = (page: Json): string => {
  for (const p of Object.values((page.properties ?? {}) as Record<string, Json>)) if (p?.type === 'title') return plain(p.title);
  return '';
};
const dbTitle = (db: Json): string => plain(db.title).trim() || 'Ohne Namen';

/** One property value as something simple (strings, numbers, booleans, lists). */
export function propValue(p: Json, users?: Map<string, string>): unknown {
  switch (p?.type) {
    case 'title':
      return plain(p.title);
    case 'rich_text':
      return plain(p.rich_text);
    case 'number':
      return p.number ?? undefined;
    case 'select':
      return p.select?.name;
    case 'status':
      return p.status?.name;
    case 'multi_select':
      return (p.multi_select ?? []).map((o: Json) => String(o.name));
    case 'date':
      return p.date?.start ? String(p.date.start) : undefined;
    case 'checkbox':
      return !!p.checkbox;
    case 'url':
      return p.url ?? undefined;
    case 'email':
      return p.email ?? undefined;
    case 'phone_number':
      return p.phone_number ?? undefined;
    case 'people':
      return (
        (p.people ?? [])
          .map((u: Json) => String(u.name ?? users?.get(String(u.id)) ?? ''))
          .filter(Boolean)
          .join(', ') || undefined
      );
    case 'files':
      return (
        (p.files ?? [])
          .map((f: Json) => String(f.name ?? ''))
          .filter(Boolean)
          .join(', ') || undefined
      );
    case 'formula': {
      const f = p.formula ?? {};
      return f.type === 'date' ? f.date?.start : (f[f.type] ?? undefined);
    }
    case 'rollup': {
      const r = p.rollup ?? {};
      if (r.type === 'number') return r.number ?? undefined;
      if (r.type === 'date') return r.date?.start;
      if (r.type === 'array')
        return (
          (r.array ?? [])
            .map((x: Json) => String(propValue(x, users) ?? ''))
            .filter(Boolean)
            .join(', ') || undefined
        );
      return undefined;
    }
    case 'created_time':
      return p.created_time;
    case 'last_edited_time':
      return p.last_edited_time;
    case 'created_by':
    case 'last_edited_by': {
      const u = p[p.type];
      return u?.name ?? users?.get(String(u?.id)) ?? undefined;
    }
    case 'unique_id':
      return p.unique_id?.number !== undefined ? `${p.unique_id.prefix ? `${p.unique_id.prefix}-` : ''}${p.unique_id.number}` : undefined;
    default:
      return undefined;
  }
}

// --- reading ----------------------------------------------------------------------------------------------------

async function* paged(h: VendorHttp, run: (cursor?: string) => Promise<Json>, ctx: StepCtx, start?: string): AsyncGenerator<{ items: Json[]; next: string | undefined }> {
  let cursor = start;
  for (;;) {
    if (ctx.cancelled()) return;
    const j = await run(cursor);
    const next = j?.has_more && j?.next_cursor ? String(j.next_cursor) : undefined;
    yield { items: Array.isArray(j?.results) ? j.results : [], next };
    if (!next) return;
    cursor = next;
  }
}

const searchOf = (h: VendorHttp, object: 'database' | 'page') => (cursor?: string) =>
  post(h, '/search', { filter: { property: 'object', value: object }, page_size: PAGE, sort: { timestamp: 'last_edited_time', direction: 'ascending' }, ...(cursor ? { start_cursor: cursor } : {}) });

async function databases(h: VendorHttp, ctx: StepCtx): Promise<Json[]> {
  const out: Json[] = [];
  for await (const pg of paged(h, searchOf(h, 'database'), ctx)) out.push(...pg.items.filter((d) => d.object === 'database' && !d.archived && !d.in_trash));
  return out.sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)) || String(a.id).localeCompare(String(b.id)));
}

const rowsOf =
  (h: VendorHttp, db: string, extra: Record<string, unknown> = {}, query?: Record<string, unknown>) =>
  (cursor?: string) =>
    post(h, `/databases/${seg(db)}/query`, { page_size: PAGE, sorts: [{ timestamp: 'created_time', direction: 'ascending' }], ...(cursor ? { start_cursor: cursor } : {}), ...extra }, query);

async function usersOf(h: VendorHttp, ctx: StepCtx): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for await (const pg of paged(h, (c) => h.get('/users', { page_size: PAGE, ...(c ? { start_cursor: c } : {}) }), ctx)) for (const u of pg.items) if (u.name) out.set(String(u.id), String(u.name));
  } catch (e) {
    // Without the "user information" right the names simply stay empty.
    if (e instanceof UmzugError && e.fatal) throw e;
  }
  return out;
}

const isProject = (db: Json): boolean => Object.values((db.properties ?? {}) as Record<string, Json>).some((p) => p?.type === 'status');

// --- blocks → Markdown ------------------------------------------------------------------------------------------

export interface BlockEnv {
  children(id: string): Promise<Json[]>;
  warn(message: string): void;
  budget: { calls: number };
  images: { n: number };
}

const lines = (s: string, prefix: string) =>
  s
    .split('\n')
    .map((l) => `${prefix}${l}`)
    .join('\n');

/** The blocks of a page as Markdown. Children are fetched through `env.children` (a call each, bounded). */
export async function blocksMd(blocks: Json[], env: BlockEnv, depth = 0, indent = ''): Promise<string> {
  const out: string[] = [];
  let num = 0;
  for (const b of blocks) {
    const t = String(b.type);
    const d: Json = b[t] ?? {};
    if (t !== 'numbered_list_item') num = 0;
    const kids = async (more = '  '): Promise<string> => {
      if (!b.has_children || depth >= DEPTH || t === 'child_page' || t === 'child_database' || env.budget.calls <= 0) return '';
      env.budget.calls--;
      return blocksMd(await env.children(String(b.id)), env, depth + 1, indent + more);
    };
    const text = richMd(d.rich_text);
    switch (t) {
      case 'paragraph':
        out.push(`${indent}${text}`.trimEnd() || '');
        if (b.has_children) out.push(await kids(''));
        break;
      case 'heading_1':
        out.push(`${indent}# ${text}`);
        if (b.has_children) out.push(await kids(''));
        break;
      case 'heading_2':
        out.push(`${indent}## ${text}`);
        if (b.has_children) out.push(await kids(''));
        break;
      case 'heading_3':
        out.push(`${indent}### ${text}`);
        if (b.has_children) out.push(await kids(''));
        break;
      case 'bulleted_list_item':
      case 'to_do':
      case 'numbered_list_item': {
        const mark = t === 'bulleted_list_item' ? '-' : t === 'to_do' ? `- [${d.checked ? 'x' : ' '}]` : `${++num}.`;
        const sub = await kids();
        out.push(`${indent}${mark} ${text}${sub ? `\n${sub}` : ''}`);
        break;
      }
      case 'toggle': {
        const sub = await kids();
        out.push(`${indent}- ${text}${sub ? `\n${sub}` : ''}`);
        break;
      }
      case 'quote':
        out.push(lines(`${text}${b.has_children ? `\n${await kids('')}` : ''}`, `${indent}> `));
        break;
      case 'callout':
        out.push(lines(`${d.icon?.emoji ? `${d.icon.emoji} ` : ''}${text}${b.has_children ? `\n${await kids('')}` : ''}`, `${indent}> `));
        break;
      case 'code':
        out.push(`${indent}\`\`\`${d.language && d.language !== 'plain text' ? d.language : ''}\n${plain(d.rich_text)}\n${indent}\`\`\``);
        break;
      case 'divider':
        out.push(`${indent}---`);
        break;
      case 'equation':
        out.push(`${indent}$$${d.expression ?? ''}$$`);
        break;
      case 'image': {
        const url = d.external?.url ?? d.file?.url;
        if (url) {
          out.push(`${indent}![${plain(d.caption) || 'Bild bei Notion'}](${url})`);
          if (d.file?.url) env.images.n++;
        }
        break;
      }
      case 'video':
      case 'file':
      case 'pdf':
      case 'audio':
      case 'embed':
      case 'bookmark':
      case 'link_preview': {
        const url = d.external?.url ?? d.file?.url ?? d.url;
        if (url) {
          out.push(`${indent}[${plain(d.caption) || d.name || url}](${url})`);
          if (d.file?.url) env.images.n++;
        }
        break;
      }
      case 'table': {
        const rows = env.budget.calls > 0 ? (env.budget.calls--, await env.children(String(b.id))) : [];
        const cells = rows.map((r) => (r.table_row?.cells ?? []).map((c: Json) => richMd(c).replace(/\|/g, '/').replace(/\n/g, ' ')));
        if (cells.length) {
          const width = Math.max(...cells.map((r) => r.length));
          const pad = (r: string[]) => `${indent}| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
          out.push([pad(cells[0]), `${indent}| ${Array(width).fill('---').join(' | ')} |`, ...cells.slice(1).map(pad)].join('\n'));
        }
        break;
      }
      case 'column_list':
      case 'column':
      case 'synced_block':
        out.push(await kids(''));
        break;
      case 'child_database':
        out.push(`${indent}Datenbank „${d.title ?? ''}“ (liegt bei Notion bzw. wurde als Projekt / eigenes Objekt übernommen)`);
        break;
      case 'link_to_page':
        out.push(`${indent}Link zu einer anderen Notion-Seite`);
        break;
      default:
        break;
    }
  }
  // List items stay together, everything else is a paragraph of its own.
  const isList = (x: string) => /^\s*(- |\d+\. )/.test(x);
  const parts = out.filter((x) => x.trim() !== '');
  return parts
    .map((x, i) => (i === 0 ? x : `${isList(x) && isList(parts[i - 1]) ? '\n' : '\n\n'}${x}`))
    .join('')
    .replace(/^\n+/, '')
    .trimEnd();
}

async function bodyOf(h: VendorHttp, pageId: string, ctx: StepCtx, images: { n: number }): Promise<string> {
  const env: BlockEnv = {
    budget: { calls: BLOCK_CALLS },
    images,
    warn: ctx.warn,
    children: async (id) => {
      const all: Json[] = [];
      for await (const pg of paged(h, (c) => h.get(`/blocks/${seg(id)}/children`, { page_size: PAGE, ...(c ? { start_cursor: c } : {}) }), ctx)) all.push(...pg.items);
      return all;
    },
  };
  return blocksMd(await env.children(pageId), env);
}

// --- projects ---------------------------------------------------------------------------------------------------

interface Layout {
  titleProp?: string;
  statusProp?: string;
  dueProp?: string;
  startProp?: string;
  priorityProp?: string;
  tagProp?: string;
  peopleProps: string[];
  fields: Map<string, RProjectField & { type0: string }>;
  skipped: string[];
}

const DONE = /complete|done|erledigt|fertig|abgeschlossen|finished/i;
const ACTIVE = /progress|doing|arbeit|läuft|review|prüf/i;
const TODO = /to-?do|not started|backlog|offen|geplant|neu/i;

export function notionLayout(db: Json): Layout {
  const props = Object.entries((db.properties ?? {}) as Record<string, Json>);
  const L: Layout = { peopleProps: [], fields: new Map(), skipped: [] };
  L.titleProp = props.find(([, p]) => p.type === 'title')?.[0];
  L.statusProp = props.find(([, p]) => p.type === 'status')?.[0];
  const dates = props.filter(([, p]) => p.type === 'date').map(([n]) => n);
  L.dueProp = dates.find((n) => /due|fällig|deadline|frist|termin/i.test(n)) ?? dates[0];
  L.startProp = dates.find((n) => n !== L.dueProp && /start|beginn/i.test(n));
  L.priorityProp = props.find(([n, p]) => (p.type === 'select' || p.type === 'status') && n !== L.statusProp && /prior/i.test(n))?.[0];
  L.tagProp = props.find(([n, p]) => p.type === 'multi_select' && /tag|label|schlagwort|kategorie/i.test(n))?.[0];
  for (const [n, p] of props) if (p.type === 'people') L.peopleProps.push(n);
  const used = new Set([L.titleProp, L.statusProp, L.dueProp, L.startProp, L.priorityProp, L.tagProp, ...L.peopleProps]);
  const keys = new Set<string>();
  for (const [name, p] of props) {
    if (used.has(name)) continue;
    let type: RProjectField['type'] | undefined;
    let options: string[] | undefined;
    switch (p.type) {
      case 'rich_text':
      case 'email':
      case 'phone_number':
      case 'multi_select':
      case 'unique_id':
        type = 'text';
        break;
      case 'number':
        type = 'number';
        break;
      case 'select':
        options = (p.select?.options ?? []).map((o: Json) => String(o.name));
        type = options?.length ? 'select' : 'text';
        break;
      case 'date':
        type = 'date';
        break;
      case 'checkbox':
        type = 'checkbox';
        break;
      case 'url':
        type = 'url';
        break;
      case 'formula':
      case 'rollup':
        type = 'text';
        break;
      case 'created_time':
      case 'last_edited_time':
      case 'created_by':
      case 'last_edited_by':
        continue;
      default:
        L.skipped.push(`${name} (${p.type})`);
        continue;
    }
    if (L.fields.size >= 30) {
      L.skipped.push(`${name} (mehr als 30 Eigenschaften)`);
      continue;
    }
    let key = fieldKey(name).slice(0, 36) || 'feld';
    for (let i = 2; keys.has(key); i++) key = `${fieldKey(name).slice(0, 32)}_${i}`;
    keys.add(key);
    L.fields.set(name, { key, label: name.slice(0, 80), type, options, type0: String(p.type) });
  }
  return L;
}

export function notionProject(db: Json, L: Layout): RProject {
  const sp: Json = L.statusProp ? (db.properties[L.statusProp].status ?? {}) : {};
  const groups: Json[] = Array.isArray(sp.groups) ? sp.groups : [];
  const options: Json[] = Array.isArray(sp.options) ? sp.options : [];
  const cat = (o: Json): 'todo' | 'active' | 'done' => {
    const gi = groups.findIndex((g) => Array.isArray(g.option_ids) && g.option_ids.includes(o.id));
    const g = groups[gi];
    const label = String(g?.name ?? o.name);
    if (DONE.test(label)) return 'done';
    if (ACTIVE.test(label)) return 'active';
    if (TODO.test(label)) return 'todo';
    if (gi < 0) return DONE.test(String(o.name)) ? 'done' : ACTIVE.test(String(o.name)) ? 'active' : 'todo';
    return gi === 0 ? 'todo' : gi === groups.length - 1 ? 'done' : 'active';
  };
  return {
    kind: 'project',
    ext: `db:${db.id}`,
    name: dbTitle(db),
    description: plain(db.description) || undefined,
    statuses: options.map((o) => ({ name: String(o.name), category: cat(o) })),
    fields: [...L.fields.values()].map(({ key, label, type, options: opts }) => ({ key, label, type, options: opts })),
  };
}

export function notionTask(page: Json, db: Json, L: Layout, users: Map<string, string>, body?: string, project: RProject = notionProject(db, L)): RPmTask {
  const props: Record<string, Json> = page.properties ?? {};
  const val = (n?: string) => (n ? propValue(props[n] ?? {}, users) : undefined);
  const status = val(L.statusProp);
  const statusCat = L.statusProp ? project.statuses.find((s) => s.name === status)?.category : undefined;
  const due = props[L.dueProp ?? '']?.date;
  const startOnly = props[L.startProp ?? '']?.date;
  let start = day(startOnly?.start);
  let end = day(due?.end) ?? day(due?.start);
  if (due?.end && !start) start = day(due.start);
  if (start && end && start > end) start = undefined;
  const custom: Record<string, unknown> = {};
  for (const [name, f] of L.fields) {
    let v = val(name);
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v = v.join(', ');
    if (f.type === 'date') v = day(v);
    if (f.type === 'number' && typeof v !== 'number') v = Number(v);
    if (f.type === 'checkbox' && v !== true) continue;
    if (v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) custom[f.key] = v;
  }
  const tagVal = val(L.tagProp);
  const people = L.peopleProps.flatMap((n) => (props[n]?.people ?? []).map((u: Json) => ({ name: u.name ?? users.get(String(u.id)), email: u.person?.email })));
  return {
    kind: 'pm_task',
    ext: `pg:${page.id}`,
    project: `db:${db.id}`,
    title: titleOf(page) || 'Ohne Titel',
    description: body || undefined,
    status: typeof status === 'string' ? status : undefined,
    done: statusCat === 'done',
    priority: priorityWord(val(L.priorityProp)),
    start_at: start,
    due_at: end,
    tags: Array.isArray(tagVal) ? tagVal.map(String) : [],
    assignees: people,
    custom,
    created_at: toIso(page.created_time),
    completed_at: statusCat === 'done' ? toIso(page.last_edited_time) : undefined,
    url: typeof page.url === 'string' ? page.url : undefined,
  };
}

// --- objects ----------------------------------------------------------------------------------------------------

const OBJECT_TYPES: Record<string, RObjectProp['type']> = {
  rich_text: 'textarea',
  number: 'number',
  select: 'select',
  status: 'select',
  multi_select: 'multiselect',
  date: 'date',
  checkbox: 'checkbox',
  url: 'url',
  email: 'email',
  phone_number: 'phone',
  people: 'text',
  files: 'text',
  rollup: 'text',
  created_time: 'datetime',
  last_edited_time: 'datetime',
  created_by: 'text',
  last_edited_by: 'text',
  unique_id: 'text',
};

export function notionObject(db: Json): { rec: RObjectType; relations: { prop: string; target: string }[] } {
  const props: RObjectProp[] = [];
  const relations: { prop: string; target: string }[] = [];
  for (const [name, p] of Object.entries((db.properties ?? {}) as Record<string, Json>)) {
    if (p.type === 'title') {
      props.unshift({ ext: name, label: name, type: 'text', primary: true });
      continue;
    }
    if (p.type === 'relation') {
      if (p.relation?.database_id) relations.push({ prop: name, target: String(p.relation.database_id) });
      continue;
    }
    let type = OBJECT_TYPES[String(p.type)];
    if (p.type === 'formula') type = 'text';
    if (!type) continue;
    const options = p.type === 'select' ? p.select?.options : p.type === 'status' ? p.status?.options : p.type === 'multi_select' ? p.multi_select?.options : undefined;
    const names: string[] | undefined = options ? options.map((o: Json) => String(o.name)) : undefined;
    // A choice without choices has nothing to choose from – the values become plain text.
    props.push({ ext: name, label: name, type: (type === 'select' || type === 'multiselect') && !names?.length ? 'text' : type, options: names });
  }
  return { rec: { kind: 'object_type', ext: `db:${db.id}`, singular: dbTitle(db), plural: dbTitle(db), description: plain(db.description) || undefined, properties: props }, relations };
}

export function notionRecord(page: Json, db: Json, users: Map<string, string>, body?: string): RObjectRecord {
  const values: Record<string, unknown> = {};
  const types: Record<string, string> = {};
  for (const [name, p] of Object.entries((db.properties ?? {}) as Record<string, Json>)) types[name] = String(p.type);
  for (const [name, p] of Object.entries((page.properties ?? {}) as Record<string, Json>)) {
    if (p.type === 'relation') continue;
    let v = propValue(p, users);
    if (v === undefined || v === null || v === '') continue;
    if (p.type === 'date' || (p.type === 'formula' && p.formula?.type === 'date')) v = String(v);
    values[name] = v;
  }
  if (body) values.__inhalt = body;
  return { kind: 'object_record', ext: `pg:${page.id}`, type: `db:${db.id}`, values, created_at: toIso(page.created_time) };
}

// --- steps ------------------------------------------------------------------------------------------------------

interface Resume {
  db?: string;
  next?: string;
  done?: boolean;
}

/** The databases of a kind, with resuming: skips what an earlier run finished and carries on inside the one it stopped in. */
async function* eachDatabase(h: VendorHttp, ctx: StepCtx, kind: 'projects' | 'objects') {
  const resume = ctx.cursor as Resume | undefined;
  let skipping = !!resume?.db;
  for (const db of (await databases(h, ctx)).filter((d) => (kind === 'projects' ? isProject(d) : !isProject(d)))) {
    let start: string | undefined;
    if (skipping) {
      if (String(db.id) !== resume!.db) continue;
      skipping = false;
      if (resume!.done) continue;
      start = resume!.next;
    }
    yield { db, start };
  }
}

/** A database the API refuses (several data sources, no access) is skipped with a note; the others carry on. */
const refused = (e: unknown, ctx: StepCtx, db: Json): boolean => {
  if (!(e instanceof UmzugError) || !(e.status === 400 || e.skippable)) return false;
  ctx.warn(`Datenbank „${clip(dbTitle(db), 40)}“ nicht gelesen: ${e.message}`);
  return true;
};

const steps = (): StepDef[] => [
  {
    id: 'projects',
    label: 'Datenbanken mit Status → Projekte',
    part: 'projects',
    async *run(ctx): AsyncGenerator<Batch> {
      const dbs = (await databases(ctx.http, ctx)).filter(isProject);
      const records: RProject[] = [];
      for (const db of dbs) {
        const L = notionLayout(db);
        records.push(notionProject(db, L));
        if (L.skipped.length) ctx.warn(`Datenbank „${clip(dbTitle(db), 40)}“: Eigenschaften ohne Gegenstück (nicht übernommen): ${L.skipped.slice(0, 6).join(', ')}${L.skipped.length > 6 ? ' …' : ''}`);
      }
      if (records.length) yield { records };
    },
  },
  {
    id: 'tasks',
    label: 'Zeilen → Aufgaben',
    part: 'projects',
    async *run(ctx): AsyncGenerator<Batch> {
      const users = await usersOf(ctx.http, ctx);
      const withComments = ctx.parts.includes('comments');
      let budget = ctx.limit < Infinity ? DRY_BODIES : Infinity;
      const images = { n: 0 };
      for await (const { db, start } of eachDatabase(ctx.http, ctx, 'projects')) {
        const L = notionLayout(db);
        const project = notionProject(db, L);
        try {
          for await (const pg of paged(ctx.http, rowsOf(ctx.http, String(db.id)), ctx, start)) {
            const records: RPmTask[] = [];
            for (const page of pg.items.filter((x) => x.object === 'page' && !x.archived && !x.in_trash)) {
              let body: string | undefined;
              if (budget > 0) {
                budget--;
                body = await bodyOf(ctx.http, String(page.id), ctx, images).catch((e) => {
                  if (e instanceof UmzugError && e.skippable) return undefined;
                  throw e;
                });
              }
              const t = notionTask(page, db, L, users, body, project);
              if (withComments && budget >= 0) t.comments = await commentsOf(ctx.http, String(page.id), users, ctx).catch(() => []);
              records.push(t);
            }
            yield { records, cursor: pg.next ? { db: String(db.id), next: pg.next } : { db: String(db.id), done: true } };
          }
        } catch (e) {
          if (!refused(e, ctx, db)) throw e;
          yield { records: [], cursor: { db: String(db.id), done: true } };
        }
      }
      if (images.n) ctx.warn(`${images.n} Bilder und Dateien in Seiteninhalten liegen bei Notion (die Adressen laufen nach einer Stunde ab) – vor dem Kündigen herunterladen`);
    },
  },
  {
    id: 'object_types',
    label: 'Datenbanken → eigene Objekte',
    part: 'objects',
    async *run(ctx): AsyncGenerator<Batch> {
      const records: RObjectType[] = [];
      for (const db of (await databases(ctx.http, ctx)).filter((d) => !isProject(d))) {
        const o = notionObject(db);
        if (ctx.parts.includes('docs')) o.rec.properties.push({ ext: '__inhalt', label: 'Inhalt', type: 'textarea' });
        records.push(o.rec);
        const skipped = Object.entries((db.properties ?? {}) as Record<string, Json>)
          .filter(([, p]) => !OBJECT_TYPES[String(p.type)] && !['title', 'relation', 'formula'].includes(String(p.type)))
          .map(([n, p]) => `${n} (${p.type})`);
        if (skipped.length) ctx.warn(`Datenbank „${clip(dbTitle(db), 40)}“: Eigenschaften ohne Gegenstück (nicht übernommen): ${skipped.slice(0, 6).join(', ')}`);
      }
      if (records.length) yield { records };
    },
  },
  {
    id: 'object_records',
    label: 'Zeilen → Datensätze',
    part: 'objects',
    async *run(ctx): AsyncGenerator<Batch> {
      const users = await usersOf(ctx.http, ctx);
      const withBody = ctx.parts.includes('docs');
      let budget = ctx.limit < Infinity ? DRY_BODIES : Infinity;
      const images = { n: 0 };
      for await (const { db, start } of eachDatabase(ctx.http, ctx, 'objects')) {
        try {
          for await (const pg of paged(ctx.http, rowsOf(ctx.http, String(db.id)), ctx, start)) {
            const records: RObjectRecord[] = [];
            for (const page of pg.items.filter((x) => x.object === 'page' && !x.archived && !x.in_trash)) {
              let body: string | undefined;
              if (withBody && budget > 0) {
                budget--;
                body = await bodyOf(ctx.http, String(page.id), ctx, images).catch((e) => {
                  if (e instanceof UmzugError && e.skippable) return undefined;
                  throw e;
                });
              }
              records.push(notionRecord(page, db, users, body));
            }
            yield { records, cursor: pg.next ? { db: String(db.id), next: pg.next } : { db: String(db.id), done: true } };
          }
        } catch (e) {
          if (!refused(e, ctx, db)) throw e;
          yield { records: [], cursor: { db: String(db.id), done: true } };
        }
      }
    },
  },
  {
    id: 'object_links',
    label: 'Relationen → Verknüpfungen',
    part: 'objects',
    async *run(ctx): AsyncGenerator<Batch> {
      const dbs = (await databases(ctx.http, ctx)).filter((d) => !isProject(d));
      const known = new Set(dbs.map((d) => String(d.id).replace(/-/g, '')));
      for await (const { db, start } of eachDatabase(ctx.http, ctx, 'objects')) {
        const rel = notionObject(db).relations.filter((r) => known.has(r.target.replace(/-/g, '')));
        if (!rel.length) continue;
        const ids = rel.map((r) => String(db.properties[r.prop].id));
        try {
          for await (const pg of paged(
            ctx.http,
            (c) =>
              ctx.http.req('POST', `/databases/${seg(db.id)}/query?${ids.map((i) => `filter_properties=${encodeURIComponent(i)}`).join('&')}`, {
                body: { page_size: PAGE, sorts: [{ timestamp: 'created_time', direction: 'ascending' }], ...(c ? { start_cursor: c } : {}) },
              }),
            ctx,
            start,
          )) {
            const records: RObjectLink[] = [];
            for (const page of pg.items) {
              for (const r of rel) for (const to of page.properties?.[r.prop]?.relation ?? []) records.push({ kind: 'object_link', ext: `${page.id}>${to.id}`, a: `pg:${page.id}`, b: `pg:${to.id}` });
            }
            yield { records, cursor: pg.next ? { db: String(db.id), next: pg.next } : { db: String(db.id), done: true } };
          }
        } catch (e) {
          if (!refused(e, ctx, db)) throw e;
          yield { records: [], cursor: { db: String(db.id), done: true } };
        }
      }
    },
  },
  {
    id: 'docs',
    label: 'Seiten → Wiki-Seiten',
    part: 'docs',
    async *run(ctx): AsyncGenerator<Batch> {
      const all: Json[] = [];
      for await (const pg of paged(ctx.http, searchOf(ctx.http, 'page'), ctx)) all.push(...pg.items.filter((p) => p.object === 'page' && !p.archived && !p.in_trash && p.parent?.type !== 'database_id'));
      const order = pageOrder(all);
      const from = Number(ctx.cursor) || 0;
      const images = { n: 0 };
      for (let at = from; at < order.length; at += 5) {
        if (ctx.cancelled()) return;
        const records: RDoc[] = [];
        for (const { page, parent } of order.slice(at, at + 5)) {
          let body = '';
          try {
            body = await bodyOf(ctx.http, String(page.id), ctx, images);
          } catch (e) {
            if (e instanceof UmzugError && e.skippable) ctx.warn(`Seite „${clip(titleOf(page), 50)}“ nicht lesbar: ${e.message}`);
            else throw e;
          }
          records.push({ kind: 'doc', ext: `pg:${page.id}`, title: titleOf(page) || 'Ohne Titel', body, parent: parent ? `pg:${parent}` : undefined, icon: page.icon?.emoji });
        }
        yield { records, cursor: at + 5 < order.length ? at + 5 : undefined };
      }
      if (images.n) ctx.warn(`${images.n} Bilder und Dateien in Seiten liegen bei Notion (die Adressen laufen nach einer Stunde ab) – vor dem Kündigen herunterladen`);
    },
  },
];

/** Pages in an order where every parent comes before its children (a parent Notion did not show us makes a page a root). */
export function pageOrder(pages: Json[]): { page: Json; parent?: string }[] {
  const byId = new Map(pages.map((p) => [String(p.id), p]));
  const kids = new Map<string, Json[]>();
  const roots: Json[] = [];
  const sorted = [...pages].sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)) || String(a.id).localeCompare(String(b.id)));
  for (const p of sorted) {
    const parent = p.parent?.type === 'page_id' ? String(p.parent.page_id) : undefined;
    if (parent && byId.has(parent) && parent !== String(p.id)) (kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(p);
    else roots.push(p);
  }
  const out: { page: Json; parent?: string }[] = [];
  const seen = new Set<string>();
  const walk = (p: Json, parent: string | undefined, depth: number) => {
    if (seen.has(String(p.id)) || depth > 20) return;
    seen.add(String(p.id));
    out.push({ page: p, parent });
    for (const k of kids.get(String(p.id)) ?? []) walk(k, String(p.id), depth + 1);
  };
  for (const r of roots) walk(r, undefined, 0);
  // Pages in a parent loop are never reached from a root – they come last, as roots.
  for (const p of sorted) if (!seen.has(String(p.id))) walk(p, undefined, 0);
  return out;
}

async function commentsOf(h: VendorHttp, pageId: string, users: Map<string, string>, ctx: StepCtx): Promise<RPmComment[]> {
  const out: RPmComment[] = [];
  try {
    for await (const pg of paged(h, (c) => h.get('/comments', { block_id: pageId, page_size: PAGE, ...(c ? { start_cursor: c } : {}) }), ctx)) {
      for (const c of pg.items) {
        const body = plain(c.rich_text).trim();
        if (body) out.push({ ext: `c:${c.id}`, author: c.created_by?.name ?? users.get(String(c.created_by?.id)), body, at: toIso(c.created_time) });
      }
    }
  } catch (e) {
    // Without the "read comments" right of the integration the comments are simply not there.
    if (e instanceof UmzugError && (e.skippable || e.status === 400)) return [];
    throw e;
  }
  return out.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
}

// --- describe ---------------------------------------------------------------------------------------------------

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const warnings: string[] = [];
  const count = counter(counts);
  const s = stubCtx(h, parts);
  if (parts.includes('projects') || parts.includes('objects')) {
    const dbs = await databases(h, s);
    if (!dbs.length) warnings.push('Notion zeigt HyperLevel keine Datenbank: Öffne in Notion die Seite oder Datenbank → „…“ → „Verbindungen“ → deine Integration hinzufügen. Nur was du freigibst, kann übernommen werden.');
    const rows = async (db: Json) => {
      let n = 0;
      let pages = 0;
      for await (const pg of paged(h, rowsOf(h, String(db.id)), s)) {
        n += pg.items.length;
        if (++pages >= 30 && pg.next) return { n, capped: true };
      }
      return { n, capped: false };
    };
    if (parts.includes('projects')) {
      const list = dbs.filter(isProject);
      await count('projects', 'databases', 'Datenbanken mit Status-Eigenschaft (werden Projekte)', async () => list.length);
      let n = 0;
      let capped = false;
      await count('projects', 'rows', 'Zeilen in diesen Datenbanken (werden Aufgaben)', async () => {
        for (const db of list) {
          const r = await rows(db);
          n += r.n;
          capped = capped || r.capped;
        }
        return { n, capped };
      });
    }
    if (parts.includes('objects')) {
      const list = dbs.filter((d) => !isProject(d));
      await count('objects', 'object_databases', 'Datenbanken ohne Status-Eigenschaft (werden eigene Objekte)', async () => list.length);
      let n = 0;
      let capped = false;
      await count('objects', 'object_rows', 'Zeilen in diesen Datenbanken (werden Datensätze)', async () => {
        for (const db of list) {
          const r = await rows(db);
          n += r.n;
          capped = capped || r.capped;
        }
        return { n, capped };
      });
      if (list.length > 50) warnings.push('HyperLevel legt höchstens 50 eigene Objekte an – die übrigen Datenbanken werden übersprungen.');
    }
  }
  if (parts.includes('docs')) {
    await count('docs', 'pages', 'Seiten (ohne Datenbank-Zeilen)', async () => {
      let n = 0;
      let pages = 0;
      for await (const pg of paged(h, searchOf(h, 'page'), s)) {
        n += pg.items.filter((p) => p.object === 'page' && !p.archived && !p.in_trash && p.parent?.type !== 'database_id').length;
        if (++pages >= 40 && pg.next) return { n, capped: true };
      }
      return { n, capped: false };
    });
    warnings.push('Zu jeder Seite liest HyperLevel die Blöcke einzeln (Notion erlaubt im Schnitt drei Anfragen pro Sekunde) – bei vielen Seiten dauert das. Der Umzug lässt sich jederzeit pausieren und fortsetzen.');
  }
  return { counts, fields: [] as SourceField[], warnings };
}

export const NOTION: SourceDef = {
  key: 'notion',
  label: 'Notion',
  tagline: 'Datenbanken als Projekte oder eigene Objekte, Seiten als Wiki, Kommentare',
  credentials: [{ key: 'token', label: 'Integrations-Token', secret: true, placeholder: 'ntn_… oder secret_…', hint: 'notion.so/profile/integrations → „Neue Integration“ → Typ „Intern“ → Token kopieren' }],
  howto: [
    'In Notion unter notion.so/profile/integrations eine neue Integration vom Typ „Intern“ anlegen (nur Lese-Rechte nötig: „Inhalt lesen“, optional „Kommentare lesen“ und „Nutzerinformationen mit E-Mail-Adressen“) und den Token kopieren.',
    'Die Seiten und Datenbanken, die mitkommen sollen, mit der Integration teilen: Seite öffnen → „…“ → „Verbindungen“ → die Integration hinzufügen (Unterseiten sind damit automatisch dabei).',
    'Den Token hier einfügen. Nach dem Umzug die Integration in Notion löschen.',
  ],
  limits: [
    'Nur was du mit der Integration teilst, ist sichtbar – alles andere kommt nicht mit',
    'Dateien, Bilder und Anhänge (die Adressen laufen bei Notion nach einer Stunde ab): Namen und Verweise stehen im Text, die Dateien bleiben bei Notion',
    'Ansichten, Filter und Sortierungen, Formeln und Rollups (es kommt der aktuelle Wert), Vorlagen, Automationen und verknüpfte Datenbank-Ansichten',
    'Uhrzeiten und Enddaten in Datumsfeldern von eigenen Objekten (es kommt das Anfangsdatum); Relationen zu mehr als 25 Zeilen',
    'Zuständige: nur Personen, deren E-Mail in HyperLevel ein Teammitglied hat, werden zugewiesen – alle anderen stehen mit Namen in der Beschreibung',
    'Datenbanken mit mehreren Datenquellen und der Papierkorb',
  ],
  parts: [
    {
      key: 'projects',
      label: 'Datenbanken mit Status → Projekte und Aufgaben',
      on: true,
      note: 'Der Inhalt der Seite hinter jeder Zeile wird zur Beschreibung; Status, Frist, Zuständige, Priorität und Tags kommen mit, weitere Eigenschaften werden Projektfelder.',
    },
    { key: 'objects', label: 'Andere Datenbanken → eigene Objekte', on: true, note: 'Jede Datenbank wird ein eigenes Objekt mit passenden Eigenschaften; Relationen zwischen den Datenbanken werden Verknüpfungen.' },
    { key: 'docs', label: 'Seiten → Wiki-Seiten', on: true, note: 'Mit der Seitenhierarchie im Wiki-Bereich „Notion“. Zusammen mit den Datenbanken wird auch der Seiteninhalt der Zeilen gelesen (eine Anfrage je Zeile und Block-Ebene).' },
    { key: 'comments', label: 'Kommentare zu den Aufgaben', on: false, note: 'Eine Anfrage je Aufgabe; braucht das Recht „Kommentare lesen“ für die Integration.' },
  ],
  exports: [],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const me = await h.get('/users/me');
    if (!me?.id) throw new UmzugError(401, 'Notion: Zugangsdaten ungültig oder abgelaufen');
    const ws = me.bot?.workspace_name ?? me.name ?? 'Notion';
    return { account: `n-${me.bot?.workspace_id ?? me.id}`, label: String(ws), meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
