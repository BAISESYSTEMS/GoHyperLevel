import type { Account, Batch, CountRow, PartKey, RDoc, RPmComment, RPmTask, RProject, RProjectField, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import type { Json } from './umzug-flow.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { counter, priorityWord, stubCtx } from './umzug-lib.js';
import { clip, fieldKey, toIso } from './umzug-text.js';

/**
 * monday.com (GraphQL API, https://api.monday.com/v2, personal API token): boards → projects (groups → sections, the board's status
 * column → project statuses, other columns → custom fields), items → tasks, subitems → subtasks, updates → comments, docs → wiki pages.
 * Items are read with `items_page` (cursor, 50 per page); the complexity budget and the per-minute limit answer with HTTP 200 and an
 * error body, which is treated like a 429 (wait the seconds monday names, then retry). Read only – nothing is changed at monday.
 */

const API = 'https://api.monday.com/v2';
/** Quarterly API version; pinned so the answers keep their shape. */
export const MONDAY_VERSION = '2025-10';
const ITEMS = 50;
const SOFT = /^(COMPLEXITY_BUDGET_EXHAUSTED|RATE_LIMIT_EXCEEDED|IP_RATE_LIMIT_EXCEEDED|CONCURRENCY_LIMIT_EXCEEDED|maxConcurrencyExceeded|ComplexityException|MINUTE_LIMIT_EXCEEDED)$/i;

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'monday.com',
    base: API,
    headers: () => ({ authorization: String(creds.token ?? '').trim(), 'api-version': MONDAY_VERSION }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 250,
    errorText: (b) => (typeof b?.error_message === 'string' ? b.error_message : Array.isArray(b?.errors) && b.errors[0]?.message ? String(b.errors[0].message) : undefined),
    softLimit: (b) => {
      for (const e of Array.isArray(b?.errors) ? b.errors : []) {
        const code = String(e?.extensions?.code ?? '');
        if (/DAILY_LIMIT/i.test(code) || /daily/i.test(String(e?.message ?? ''))) return undefined;
        if (SOFT.test(code) || /complexity budget|rate limit exceeded|concurrency limit/i.test(String(e?.message ?? ''))) return Number(e?.extensions?.retry_in_seconds) || 10;
      }
      if (b?.error_code === 'ComplexityException' || /^(ComplexityException|ConcurrencyLimitExceeded)$/i.test(String(b?.error_code ?? ''))) return Number(b?.error_data?.reset_in_x_seconds) || 10;
      return undefined;
    },
  });

/** One GraphQL call; GraphQL errors come back with HTTP 200 and are turned into the usual errors here. */
async function gql(h: VendorHttp, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const j = await h.req('POST', '', { body: { query, variables } });
  const errs: Json[] = Array.isArray(j?.errors) ? j.errors : [];
  if (errs.length && !j?.data) {
    const e = errs[0];
    const code = String(e?.extensions?.code ?? '');
    const msg = String(e?.message ?? 'Fehler');
    if (/DAILY_LIMIT/i.test(code) || /daily/i.test(msg)) throw new UmzugError(429, 'monday.com: Das Tageslimit für API-Aufrufe ist erreicht – morgen fortsetzen (der Umzug macht dort weiter, wo er stehen geblieben ist)');
    if (/unauthori[sz]ed|not authenticated|invalid token/i.test(`${code} ${msg}`) && !/user_unauthorized/i.test(code)) throw new UmzugError(401, 'monday.com: Zugangsdaten ungültig oder abgelaufen');
    if (/permission|not allowed|unauthori[sz]ed|forbidden|access/i.test(`${code} ${msg}`)) throw new UmzugError(403, `monday.com: fehlende Berechtigung (${msg.slice(0, 120)})`);
    throw new UmzugError(400, `monday.com: ${msg.slice(0, 200)}`);
  }
  return j.data ?? {};
}

// --- boards -----------------------------------------------------------------------------------------------------

const BOARD_FIELDS = 'id name description type items_count groups { id title } columns { id title type settings_str }';

async function* boards(h: VendorHttp, ctx: StepCtx, page = 1, fields = BOARD_FIELDS): AsyncGenerator<{ items: Json[]; next: number | undefined }> {
  for (let p = page; ; p++) {
    if (ctx.cancelled()) return;
    const d = await gql(h, `query ($page: Int!) { boards(limit: 25, page: $page, state: active, order_by: created_at) { ${fields} } }`, { page: p });
    const list: Json[] = (Array.isArray(d.boards) ? d.boards : []).filter((b: Json) => b && (b.type === undefined || b.type === 'board'));
    const raw = Array.isArray(d.boards) ? d.boards.length : 0;
    // A page may hold fewer than asked for: only an empty page is the end.
    if (!raw) return;
    yield { items: list, next: p + 1 };
  }
}

interface Settings {
  labels?: Record<string, string>;
  labels_colors?: Record<string, { color?: string }>;
  done_colors?: number[];
}
const parse = (s: unknown): Json => {
  try {
    return typeof s === 'string' && s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};

const DONE = /done|erledigt|fertig|abgeschlossen|complete|geschlossen|closed|finished/i;
const ACTIVE = /working|progress|stuck|arbeit|review|prüf|pruef|wait|warte|blocked|hängt|läuft|testing/i;
const PRIORITY = /prior/i;

/** Priority column label → 0..4. */
export const mondayPriority = priorityWord;

interface Layout {
  statusCol?: string;
  priorityCol?: string;
  /** label (lower case) → status name */
  labels: { name: string; category: 'todo' | 'active' | 'done'; color?: string }[];
  startCol?: string;
  dueCol?: string;
  timelineCol?: string;
  descCol?: string;
  people: string[];
  /** column id → project field */
  fields: Map<string, RProjectField & { col: string; ctype: string }>;
  skipped: string[];
}

/** Columns that carry nothing to import (the item's name, its subitems, who made it and when). */
const SILENT = new Set(['name', 'subtasks', 'group', 'creation_log', 'last_updated', 'item_id', 'auto_number']);
const TEXTISH = new Set(['text', 'long_text', 'email', 'phone', 'dropdown', 'tags', 'country', 'location', 'hour', 'week', 'world_clock', 'formula', 'mirror', 'board_relation', 'link_to_item', 'rating']);

/** What a board's columns become: the status/priority/date columns the planner has a place for, the rest custom fields. */
export function mondayLayout(board: Json): Layout {
  const cols: Json[] = Array.isArray(board.columns) ? board.columns : [];
  const L: Layout = { labels: [], people: [], fields: new Map(), skipped: [] };
  const used = new Set<string>();
  const statusCols = cols.filter((c) => c.type === 'status' || c.type === 'color');
  L.priorityCol = statusCols.find((c) => PRIORITY.test(String(c.title)))?.id;
  const main = statusCols.find((c) => c.id !== L.priorityCol);
  if (main) {
    L.statusCol = main.id;
    const s: Settings = parse(main.settings_str);
    const done = new Set((s.done_colors ?? []).map(String));
    for (const [idx, label] of Object.entries(s.labels ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      if (!String(label).trim()) continue;
      const category = done.has(idx) || DONE.test(label) ? 'done' : ACTIVE.test(label) ? 'active' : 'todo';
      L.labels.push({ name: String(label), category, color: s.labels_colors?.[idx]?.color });
    }
  }
  L.timelineCol = cols.find((c) => c.type === 'timeline')?.id;
  const dates = cols.filter((c) => c.type === 'date');
  L.dueCol = dates.find((c) => /due|fällig|deadline|frist|termin/i.test(String(c.title)))?.id ?? (L.timelineCol ? undefined : dates[0]?.id);
  L.startCol = dates.find((c) => c.id !== L.dueCol && /start|beginn/i.test(String(c.title)))?.id;
  L.descCol = cols.find((c) => c.type === 'long_text' && /beschreib|descript|notiz|notes|details/i.test(String(c.title)))?.id;
  for (const id of [L.statusCol, L.priorityCol, L.timelineCol, L.dueCol, L.startCol, L.descCol]) if (id) used.add(id);
  for (const c of cols) if (c.type === 'people' || c.type === 'person') (L.people.push(c.id), used.add(c.id));
  const keys = new Set<string>();
  for (const c of cols) {
    if (used.has(c.id) || SILENT.has(c.type)) continue;
    const title = String(c.title ?? c.id);
    let type: RProjectField['type'] | undefined;
    let options: string[] | undefined;
    if (c.type === 'numbers' || c.type === 'rating') type = 'number';
    else if (c.type === 'date') type = 'date';
    else if (c.type === 'checkbox') type = 'checkbox';
    else if (c.type === 'link') type = 'url';
    else if (c.type === 'status' || c.type === 'color') {
      const s: Settings = parse(c.settings_str);
      options = Object.values(s.labels ?? {}).map(String).filter((x) => x.trim());
      type = options.length ? 'select' : 'text';
    } else if (TEXTISH.has(c.type)) type = 'text';
    if (!type) {
      L.skipped.push(`${title} (${c.type})`);
      continue;
    }
    if (L.fields.size >= 30) {
      L.skipped.push(`${title} (mehr als 30 Spalten)`);
      continue;
    }
    let key = fieldKey(title).slice(0, 36) || 'feld';
    for (let i = 2; keys.has(key); i++) key = `${fieldKey(title).slice(0, 32)}_${i}`;
    keys.add(key);
    L.fields.set(c.id, { key, label: title.slice(0, 80), type, options, col: c.id, ctype: c.type });
  }
  return L;
}

export function mondayProject(board: Json, L: Layout): RProject {
  return {
    kind: 'project',
    ext: `b:${board.id}`,
    name: String(board.name ?? `Board ${board.id}`),
    description: board.description ? String(board.description) : undefined,
    statuses: L.labels,
    sections: (Array.isArray(board.groups) ? board.groups : []).map((g: Json) => ({ ext: `g:${g.id}`, name: String(g.title ?? g.id) })),
    fields: [...L.fields.values()].map(({ key, label, type, options }) => ({ key, label, type, options })),
  };
}

// --- items ------------------------------------------------------------------------------------------------------

const cv = (item: Json, id?: string): Json | undefined => (id ? (Array.isArray(item.column_values) ? item.column_values.find((c: Json) => c.id === id) : undefined) : undefined);
const day = (v: unknown): string | undefined => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : undefined);

function fieldValue(c: Json, f: { type: RProjectField['type']; ctype: string }): unknown {
  const text = typeof c.text === 'string' ? c.text.trim() : '';
  const value = parse(c.value);
  switch (f.type) {
    case 'number': {
      const n = Number(String(text).replace(',', '.'));
      return text && Number.isFinite(n) ? n : undefined;
    }
    case 'date':
      return day(text) ?? day(value.date);
    case 'checkbox':
      return value.checked === true || value.checked === 'true' ? true : undefined;
    case 'url':
      return typeof value.url === 'string' && /^https?:\/\//i.test(value.url) ? value.url : /^https?:\/\//i.test(text) ? text : undefined;
    case 'select':
    case 'text':
    default:
      return text || undefined;
  }
}

export function mondayTask(item: Json, board: Json, L: Layout, people: Map<string, { name?: string; email?: string }>, accountSlug: string | undefined, comments: boolean): RPmTask[] {
  const out: RPmTask[] = [];
  const names = (c?: Json): { name?: string; email?: string }[] => {
    if (!c) return [];
    const ids: string[] = (parse(c.value).personsAndTeams ?? []).filter((p: Json) => p.kind === 'person' || p.kind === undefined).map((p: Json) => String(p.id));
    const found = ids.map((id) => people.get(id)).filter(Boolean) as { name?: string; email?: string }[];
    if (found.length) return found;
    return String(c.text ?? '').split(',').map((n) => n.trim()).filter(Boolean).map((name) => ({ name }));
  };
  const assignees = L.people.flatMap((id) => names(cv(item, id)));
  const status = cv(item, L.statusCol)?.text;
  const label = typeof status === 'string' && status.trim() ? status.trim() : undefined;
  const known = label ? L.labels.find((l) => l.name === label) : undefined;
  const timeline = parse(cv(item, L.timelineCol)?.value);
  const due = day(cv(item, L.dueCol)?.text) ?? day(timeline.to);
  const start = day(cv(item, L.startCol)?.text) ?? day(timeline.from);
  const custom: Record<string, unknown> = {};
  for (const f of L.fields.values()) {
    const c = cv(item, f.col);
    if (!c) continue;
    const v = fieldValue(c, f);
    if (v !== undefined) custom[f.key] = v;
  }
  const url = accountSlug ? `https://${accountSlug}.monday.com/boards/${board.id}/pulses/${item.id}` : undefined;
  const cm: RPmComment[] = [];
  if (comments) {
    for (const u of Array.isArray(item.updates) ? item.updates : []) {
      const body = String(u.text_body ?? '').trim();
      if (body) cm.push({ ext: `u:${u.id}`, author: u.creator?.name, body, at: toIso(u.created_at) });
      for (const r of Array.isArray(u.replies) ? u.replies : []) {
        const rb = String(r.text_body ?? '').trim();
        if (rb) cm.push({ ext: `r:${r.id}`, author: r.creator?.name, body: rb, at: toIso(r.created_at) });
      }
    }
    cm.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  }
  const prio = cv(item, L.priorityCol)?.text;
  const top: RPmTask = {
    kind: 'pm_task',
    ext: `i:${item.id}`,
    project: `b:${board.id}`,
    section: item.group?.id ? `g:${item.group.id}` : undefined,
    title: String(item.name ?? `Item ${item.id}`),
    description: cv(item, L.descCol)?.text || undefined,
    status: known?.name,
    done: known?.category === 'done' || (!!label && DONE.test(label)),
    priority: typeof prio === 'string' ? mondayPriority(prio) : undefined,
    start_at: start,
    due_at: due,
    assignees,
    custom,
    comments: cm,
    created_at: toIso(item.created_at),
    url,
  };
  out.push(top);
  for (const s of Array.isArray(item.subitems) ? item.subitems : []) {
    if (!s) continue;
    const cols: Json[] = Array.isArray(s.column_values) ? s.column_values : [];
    const st = cols.find((c) => c.type === 'status' || c.type === 'color')?.text;
    const date = cols.find((c) => c.type === 'date')?.text;
    const tl = parse(cols.find((c) => c.type === 'timeline')?.value);
    const ppl = cols.filter((c) => c.type === 'people').flatMap((c) => names(c));
    out.push({
      kind: 'pm_task',
      ext: `s:${s.id}`,
      project: top.project,
      section: top.section,
      parent: top.ext,
      title: String(s.name ?? `Subitem ${s.id}`),
      done: typeof st === 'string' && DONE.test(st),
      due_at: day(date) ?? day(tl.to),
      start_at: day(tl.from),
      assignees: ppl,
      created_at: toIso(s.created_at),
    });
  }
  return out;
}

const itemFields = (comments: boolean) =>
  `id name created_at group { id } column_values { id type text value } subitems { id name created_at column_values { id type text value } }${comments ? ' updates(limit: 50) { id text_body created_at creator { name } replies { id text_body created_at creator { name } } }' : ''}`;

async function usersOf(h: VendorHttp): Promise<Map<string, { name?: string; email?: string }>> {
  const out = new Map<string, { name?: string; email?: string }>();
  try {
    for (let page = 1; page <= 20; page++) {
      const d = await gql(h, 'query ($page: Int!) { users(limit: 200, page: $page) { id name email } }', { page });
      const list: Json[] = Array.isArray(d.users) ? d.users : [];
      for (const u of list) out.set(String(u.id), { name: u.name, email: u.email });
      if (!list.length) break;
    }
  } catch (e) {
    if (e instanceof UmzugError && e.fatal) throw e;
    /* guests cannot list users: the names in the column text are used */
  }
  return out;
}

// --- docs -------------------------------------------------------------------------------------------------------

/** monday's rich text (a Quill delta) as Markdown. */
export function deltaMd(delta: unknown): string {
  let out = '';
  for (const op of Array.isArray(delta) ? delta : []) {
    let t = String(op?.insert ?? '');
    if (!t) continue;
    const a = op.attributes ?? {};
    const trailing = /\s+$/.exec(t)?.[0] ?? '';
    const lead = /^\s+/.exec(t)?.[0] ?? '';
    let core = t.trim();
    if (!core) {
      out += t;
      continue;
    }
    if (a.code) core = `\`${core}\``;
    if (a.bold) core = `**${core}**`;
    if (a.italic) core = `*${core}*`;
    if (a.strike) core = `~~${core}~~`;
    if (typeof a.link === 'string' && /^https?:\/\//i.test(a.link)) core = `[${core}](${a.link})`;
    t = `${lead}${core}${trailing}`;
    out += t;
  }
  return out.replace(/\n+$/, '');
}

/** The blocks of a monday doc as Markdown (tables and layouts are flattened; images link to the picture at monday). */
export function blocksMd(blocks: Json[]): string {
  const byId = new Map<string, Json>(blocks.map((b) => [String(b.id), b]));
  const content = (b: Json): Json => parse(b.content);
  const cellIds = new Set<string>();
  for (const b of blocks) {
    if (b.type === 'table') for (const row of content(b).cells ?? []) for (const c of row ?? []) if (c?.blockId) cellIds.add(String(c.blockId));
  }
  const inTable = (b: Json): boolean => {
    for (let cur: Json | undefined = b, n = 0; cur && n < 10; cur = cur.parent_block_id ? byId.get(String(cur.parent_block_id)) : undefined, n++) if (cellIds.has(String(cur.id))) return true;
    return false;
  };
  const sorted = [...blocks].sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
  const textOf = (b: Json | undefined): string => (b ? deltaMd(content(b).deltaFormat).replace(/\s*\n\s*/g, ' ').trim() : '');
  const lines: string[] = [];
  let num = 0;
  for (const b of sorted) {
    if (inTable(b) || b.type === 'layout') continue;
    const c = content(b);
    const text = deltaMd(c.deltaFormat);
    const indent = '  '.repeat(Math.max(0, Math.min(6, Number(c.indentation) || 0)));
    if (b.type !== 'numbered list') num = 0;
    switch (b.type) {
      case 'large title':
        lines.push(`# ${text}`);
        break;
      case 'medium title':
        lines.push(`## ${text}`);
        break;
      case 'small title':
        lines.push(`### ${text}`);
        break;
      case 'bulleted list':
        lines.push(`${indent}- ${text}`);
        break;
      case 'numbered list':
        lines.push(`${indent}${++num}. ${text}`);
        break;
      case 'check list':
        lines.push(`${indent}- [${c.checked ? 'x' : ' '}] ${text}`);
        break;
      case 'quote':
        lines.push(text.split('\n').map((l) => `> ${l}`).join('\n'));
        break;
      case 'code':
        lines.push(`\`\`\`\n${text.replace(/`/g, '')}\n\`\`\``);
        break;
      case 'divider':
      case 'page break':
        lines.push('---');
        break;
      case 'image':
      case 'gif':
        if (c.url || c.publicUrl) lines.push(`![Bild bei monday.com](${c.publicUrl ?? c.url})`);
        break;
      case 'video':
        if (c.url) lines.push(`Video: ${c.url}`);
        break;
      case 'notice box':
        break;
      case 'table': {
        const rows: string[][] = (c.cells ?? []).map((row: Json[]) => (row ?? []).map((cell) => textOf(byId.get(String(cell?.blockId))).replace(/\|/g, '/')));
        if (rows.length) {
          const width = Math.max(...rows.map((r) => r.length));
          const pad = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
          lines.push([pad(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(pad)].join('\n'));
        }
        break;
      }
      default:
        if (text.trim()) lines.push(text);
    }
  }
  // List items stay together, everything else is a paragraph of its own.
  const isList = (l: string) => /^\s*(- |\d+\. )/.test(l);
  const out: string[] = [];
  lines.forEach((l, i) => out.push(i === 0 ? l : `${isList(l) && isList(lines[i - 1]) ? '\n' : '\n\n'}${l}`));
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

async function* docs(h: VendorHttp, ctx: StepCtx, page = 1): AsyncGenerator<{ items: Json[]; next: number | undefined }> {
  for (let p = page; ; p++) {
    if (ctx.cancelled()) return;
    const d = await gql(h, 'query ($page: Int!) { docs(limit: 25, page: $page) { id object_id name created_at } }', { page: p });
    const list: Json[] = Array.isArray(d.docs) ? d.docs : [];
    if (!list.length) return;
    yield { items: list, next: p + 1 };
  }
}

async function docBlocks(h: VendorHttp, id: string, ctx: StepCtx): Promise<Json[]> {
  const all: Json[] = [];
  for (let page = 1; page <= 100; page++) {
    if (ctx.cancelled()) break;
    const d = await gql(h, 'query ($id: ID!, $page: Int!) { docs(ids: [$id]) { blocks(limit: 100, page: $page) { id type content position parent_block_id } } }', { id, page });
    const list: Json[] = Array.isArray(d.docs?.[0]?.blocks) ? d.docs[0].blocks : [];
    all.push(...list);
    if (!list.length) break;
  }
  return all;
}

// --- steps ------------------------------------------------------------------------------------------------------

const steps = (): StepDef[] => [
  {
    id: 'boards',
    label: 'Boards → Projekte',
    part: 'projects',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of boards(ctx.http, ctx, Number(ctx.cursor) || 1)) {
        const records: RProject[] = [];
        for (const b of pg.items) {
          const L = mondayLayout(b);
          records.push(mondayProject(b, L));
          if (L.skipped.length) ctx.warn(`Board „${clip(b.name, 40)}“: Spalten ohne Gegenstück (nicht übernommen): ${L.skipped.slice(0, 6).join(', ')}${L.skipped.length > 6 ? ' …' : ''}`);
        }
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'items',
    label: 'Items → Aufgaben',
    part: 'projects',
    async *run(ctx): AsyncGenerator<Batch> {
      const comments = ctx.parts.includes('comments');
      const people = await usersOf(ctx.http);
      const resume = ctx.cursor as { board?: string; cursor?: string | null; next?: boolean } | undefined;
      let skipping = !!resume?.board;
      const slug = ctx.meta.slug || undefined;
      for await (const pg of boards(ctx.http, ctx)) {
        for (const b of pg.items) {
          let cursor: string | null | undefined;
          if (skipping) {
            if (String(b.id) !== resume!.board) continue;
            skipping = false;
            // That board was finished; otherwise carry on with its next page.
            if (resume!.next || !resume!.cursor) continue;
            cursor = resume!.cursor;
          }
          const L = mondayLayout(b);
          let first = cursor === undefined;
          while (first || cursor) {
            if (ctx.cancelled()) return;
            const d: any = first
              ? (await gql(ctx.http, `query ($ids: [ID!], $limit: Int!) { boards(ids: $ids) { items_page(limit: $limit) { cursor items { ${itemFields(comments)} } } } }`, { ids: [String(b.id)], limit: ITEMS })).boards?.[0]?.items_page
              : (await gql(ctx.http, `query ($cursor: String!, $limit: Int!) { next_items_page(limit: $limit, cursor: $cursor) { cursor items { ${itemFields(comments)} } } }`, { cursor, limit: ITEMS })).next_items_page;
            first = false;
            const items: Json[] = Array.isArray(d?.items) ? d.items : [];
            cursor = d?.cursor ?? null;
            const records = items.flatMap((i) => mondayTask(i, b, L, people, slug, comments));
            // Where to continue: the next page of this board, or (when the board is done) the next board.
            yield { records, cursor: cursor ? { board: String(b.id), cursor } : { board: String(b.id), cursor: null, next: true } };
            if (!items.length) break;
          }
        }
      }
    },
  },
  {
    id: 'docs',
    label: 'Docs → Wiki-Seiten',
    part: 'docs',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of docs(ctx.http, ctx, Number(ctx.cursor) || 1)) {
        const records: RDoc[] = [];
        for (const d of pg.items) {
          try {
            const blocks = await docBlocks(ctx.http, String(d.id), ctx);
            if (blocks.some((b) => b.type === 'image' || b.type === 'gif')) ctx.warn(`Doc „${clip(d.name, 50)}“: Bilder bleiben bei monday.com (der Verweis steht im Text) – vor dem Kündigen herunterladen`);
            records.push({ kind: 'doc', ext: `d:${d.id}`, title: String(d.name ?? `Doc ${d.id}`), body: blocksMd(blocks) });
          } catch (e) {
            if (e instanceof UmzugError && e.skippable) ctx.warn(`Doc „${clip(d.name, 50)}“ nicht lesbar: ${e.message}`);
            else throw e;
          }
        }
        yield { records, cursor: pg.next };
      }
    },
  },
];

// --- describe ---------------------------------------------------------------------------------------------------

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const warnings: string[] = [];
  const count = counter(counts);
  const s = stubCtx(h, parts);
  if (parts.includes('projects')) {
    let items = 0;
    await count('projects', 'boards', 'Boards', async () => {
      let n = 0;
      let capped = false;
      let pages = 0;
      for await (const pg of boards(h, s, 1, 'id type items_count')) {
        n += pg.items.length;
        for (const b of pg.items) items += Number(b.items_count ?? 0);
        if (++pages >= 40 && pg.next) {
          capped = true;
          break;
        }
      }
      return { n, capped };
    });
    await count('projects', 'items', 'Items (Aufgaben, ohne Subitems)', async () => items);
    warnings.push('Zu jedem Item liest HyperLevel Spalten, Subitems und Updates in einem Aufruf (50 Items pro Seite). monday.com begrenzt die Komplexität pro Minute – bei großen Boards wartet der Umzug automatisch und macht weiter.');
  }
  if (parts.includes('docs')) {
    await count('docs', 'docs', 'Docs', async () => {
      let n = 0;
      let pages = 0;
      for await (const pg of docs(h, s)) {
        n += pg.items.length;
        if (++pages >= 40 && pg.next) return { n, capped: true };
      }
      return { n, capped: false };
    });
  }
  return { counts, fields: [] as SourceField[], warnings };
}

export const MONDAY: SourceDef = {
  key: 'monday',
  label: 'monday.com',
  tagline: 'Boards als Projekte mit Aufgaben, Unteraufgaben, Kommentaren und Docs als Wiki',
  credentials: [{ key: 'token', label: 'API-Token', secret: true, placeholder: 'eyJhbGciOi…', hint: 'monday.com → Profilbild → Developers → „My access tokens“ → „Show“ und kopieren' }],
  howto: [
    'Bei monday.com oben rechts auf dein Profilbild klicken → „Developers“ → „My access tokens“ → den Token anzeigen und kopieren (Admins finden ihn auch unter Verwaltung → Verbindungen → API).',
    'Den Token hier einfügen. Er sieht alle Boards, die du sehen darfst – HyperLevel liest nur und ändert bei monday.com nichts.',
    'Nach dem Umzug den Token bei monday.com neu erzeugen (das macht den alten ungültig).',
  ],
  limits: [
    'Dateien und Bilder (Datei-Spalten, Bilder in Docs): die Dateien bleiben bei monday.com – Bilder in Docs verweisen noch dorthin',
    'Automationen, Integrationen und Rezepte, Dashboards, Widgets und Ansichten (Gantt, Kalender, Kanban-Einstellungen) – in HyperLevel neu als Aufgabenregeln und Workflows bauen',
    'Spalten ohne Gegenstück: Dateien, Zeiterfassung, Abstimmung, Fortschritt, Abhängigkeiten (Board-Beziehungen und Formeln kommen als Text mit dem aktuellen Wert)',
    'Zuständige: nur Personen, deren E-Mail in HyperLevel ein Teammitglied hat, werden zugewiesen – alle anderen stehen mit Namen in der Beschreibung',
    'Archivierte Boards, gelöschte Items, Aktivitätsprotokoll und Formulare',
  ],
  parts: [
    { key: 'projects', label: 'Boards → Projekte, Items → Aufgaben, Subitems → Unteraufgaben', on: true, note: 'Gruppen werden Abschnitte, die Status-Spalte wird zu den Status des Projekts, Priorität, Zeitplan und Fälligkeit zu den Feldern der Aufgabe, weitere Spalten zu eigenen Projektfeldern.' },
    { key: 'comments', label: 'Updates → Kommentare an den Aufgaben', on: true, note: 'Mit dem Namen des Autors und dem Zeitpunkt; ohne Benachrichtigung ans Team.' },
    { key: 'docs', label: 'Docs → Wiki-Seiten', on: true, note: 'Im Wiki-Bereich „monday.com“; Überschriften, Listen, Tabellen und Code kommen als Text mit.' },
  ],
  exports: [],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const d = await gql(h, '{ me { id name email account { id name slug } } }');
    const me = d.me;
    if (!me?.account?.id) throw new UmzugError(401, 'monday.com: Zugangsdaten ungültig oder abgelaufen');
    return { account: `acc-${me.account.id}`, label: `${me.account.name ?? me.account.slug ?? 'monday.com'} (${me.email ?? me.name ?? 'monday.com'})`, meta: { slug: String(me.account.slug ?? '') } };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
