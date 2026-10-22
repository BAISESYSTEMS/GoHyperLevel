import type { App } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad } from '../core/http.js';
import { CONTACT_FIELDS, type Contact } from './contacts.js';

/**
 * Behaviour segments: groups of contacts defined by what they did – opened, clicked or did not open a campaign, visited a
 * page, bought a product, submitted a form – and by what they are: tags, fields, consent, last activity. Conditions combine
 * with AND / OR in nested groups. A definition compiles to one SQL WHERE on `contacts` (alias `c`), so the live count while
 * editing and the audience of a campaign use the same code. Everything is scoped to the sub-account in the SQL itself.
 */

export type GroupOp = 'and' | 'or';
export interface Group {
  type: 'group';
  op: GroupOp;
  negate?: boolean;
  items: Node[];
}
export interface Condition {
  type: ConditionType;
  negate?: boolean;
  [k: string]: any;
}
export type Node = Group | Condition;

export const CONDITION_TYPES = ['tag', 'field', 'email', 'page', 'purchase', 'form', 'consent', 'activity', 'created', 'engagement', 'email_check', 'dnd', 'segment'] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export const MAX_DEPTH = 4;
export const MAX_NODES = 60;
const MAX_DAYS = 3650;

/** Contact columns a "field" condition may read (besides custom.<key>). */
export const FIELD_COLUMNS: string[] = [...CONTACT_FIELDS];
const FIELD_OPS = ['eq', 'neq', 'contains', 'not_contains', 'starts', 'empty', 'not_empty', 'gt', 'lt', 'gte', 'lte', 'before', 'after'] as const;
const NUMERIC_OPS = new Set(['gt', 'lt', 'gte', 'lte']);
const EMAIL_EVENTS = ['opened', 'clicked', 'not_opened', 'received'] as const;
const CHANNELS = ['email', 'sms', 'whatsapp'] as const;
const VERDICTS = ['ok', 'risky', 'invalid', 'unchecked'] as const;

const str = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);
const days = (v: unknown, def: number | null): number | null => {
  if (v === undefined || v === null || v === '') return def;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1) throw bad('Tage: eine ganze Zahl ab 1 angeben');
  return Math.min(MAX_DAYS, n);
};

/** Normalises a definition from the browser or API (unknown keys are dropped). Throws German errors. */
export function cleanDefinition(input: unknown): Group {
  let count = 0;
  const walk = (raw: any, depth: number): Node => {
    if (++count > MAX_NODES) throw bad(`Höchstens ${MAX_NODES} Bedingungen je Segment`);
    if (!raw || typeof raw !== 'object') throw bad('Segment: ungültige Bedingung');
    if (raw.type === 'group' || Array.isArray(raw.items)) {
      if (depth >= MAX_DEPTH) throw bad(`Segment: höchstens ${MAX_DEPTH} Ebenen verschachteln`);
      const items = (Array.isArray(raw.items) ? raw.items : []).map((x: any) => walk(x, depth + 1));
      return { type: 'group', op: raw.op === 'or' ? 'or' : 'and', ...(raw.negate ? { negate: true } : {}), items };
    }
    const type = raw.type as ConditionType;
    if (!CONDITION_TYPES.includes(type)) throw bad(`Segment: unbekannte Bedingung „${str(raw.type, 40)}“`);
    const out: Condition = { type };
    if (raw.negate) out.negate = true;
    switch (type) {
      case 'tag':
        out.tag = str(raw.tag, 120);
        if (!out.tag) throw bad('Segment: Tag fehlt');
        out.has = raw.has !== false;
        break;
      case 'field': {
        const field = str(raw.field, 80);
        if (!(FIELD_COLUMNS.includes(field) || /^custom\.[A-Za-z0-9_]{1,60}$/.test(field))) throw bad(`Segment: unbekanntes Feld „${field}“`);
        const op = FIELD_OPS.includes(raw.op) ? raw.op : 'eq';
        out.field = field;
        out.op = op;
        out.value = str(raw.value, 300);
        if (NUMERIC_OPS.has(op) && !Number.isFinite(Number(out.value))) throw bad(`Segment: für „${field}“ ist eine Zahl nötig`);
        if ((op === 'before' || op === 'after') && !/^\d{4}-\d{2}-\d{2}$/.test(out.value)) throw bad(`Segment: für „${field}“ ein Datum (JJJJ-MM-TT) angeben`);
        if (!['empty', 'not_empty'].includes(op) && !NUMERIC_OPS.has(op) && op !== 'before' && op !== 'after' && out.value === '') throw bad(`Segment: Wert für „${field}“ fehlt`);
        break;
      }
      case 'email': {
        out.event = EMAIL_EVENTS.includes(raw.event) ? raw.event : 'opened';
        out.campaign_id = str(raw.campaign_id, 64);
        const d = days(raw.days, out.campaign_id ? null : 90);
        if (d !== null) out.days = d;
        break;
      }
      case 'page': {
        out.url_contains = str(raw.url_contains, 300);
        if (!out.url_contains) throw bad('Segment: der Teil der Seitenadresse fehlt');
        const d = days(raw.days, null);
        if (d !== null) out.days = d;
        break;
      }
      case 'purchase': {
        out.product_id = str(raw.product_id, 64);
        out.bought = raw.bought !== false;
        const d = days(raw.days, null);
        if (d !== null) out.days = d;
        break;
      }
      case 'form': {
        out.form_id = str(raw.form_id, 64);
        out.submitted = raw.submitted !== false;
        const d = days(raw.days, null);
        if (d !== null) out.days = d;
        break;
      }
      case 'consent':
        out.channel = CHANNELS.includes(raw.channel) ? raw.channel : 'email';
        out.state = raw.state === 'missing' ? 'missing' : 'granted';
        break;
      case 'activity':
        out.op = ['within', 'older_than', 'never'].includes(raw.op) ? raw.op : 'within';
        if (out.op !== 'never') out.days = days(raw.days, 30);
        break;
      case 'created':
        out.op = raw.op === 'older_than' ? 'older_than' : 'within';
        out.days = days(raw.days, 30);
        break;
      case 'engagement':
        out.state = raw.state === 'active' ? 'active' : 'inactive';
        out.days = days(raw.days, 180);
        if (out.state === 'inactive') out.min_received = Math.min(100, Math.max(1, Math.round(Number(raw.min_received) || 3)));
        break;
      case 'email_check':
        out.verdict = VERDICTS.includes(raw.verdict) ? raw.verdict : 'invalid';
        break;
      case 'dnd':
        out.value = raw.value !== false;
        break;
      case 'segment':
        out.segment_id = str(raw.segment_id, 64);
        if (!out.segment_id) throw bad('Segment: das verknüpfte Segment fehlt');
        break;
    }
    return out;
  };
  // A bare condition or list becomes the root group.
  const raw: any = Array.isArray(input) ? { type: 'group', op: 'and', items: input } : input && typeof input === 'object' && (input as any).type && (input as any).type !== 'group' ? { type: 'group', op: 'and', items: [input] } : input;
  if (!raw || typeof raw !== 'object') throw bad('Segment: Definition fehlt');
  return walk({ ...raw, type: 'group' }, 0) as Group;
}

// --- compiling ----------------------------------------------------------------------------------------------

export interface Frag {
  sql: string;
  params: (string | number)[];
}

const like = (v: string, where: 'any' | 'start' = 'any') => `${where === 'any' ? '%' : ''}${v.replace(/[\\%_]/g, '\\$&').toLowerCase()}%`;
const iso = (d: Date, n: number) => new Date(d.getTime() - n * 864e5).toISOString();

interface Ctx {
  app: App;
  locationId: string;
  now: Date;
  depth: number;
  seen: string[];
  /** Consent verdicts are read once per channel (they take the whole ledger of the sub-account). */
  consent: Map<string, Set<string>>;
}

/** Contacts of the sub-account with a valid marketing consent for the channel (the send gate's verdict). */
function consentSet(ctx: Ctx, channel: string): Set<string> {
  const have = ctx.consent.get(channel);
  if (have) return have;
  const { app, locationId } = ctx;
  const rows = app.db.all<Contact>('SELECT id, dnd FROM contacts WHERE location_id = ?', locationId);
  const verdicts: Map<string, { allow: boolean }> | undefined = app.services.consent?.allowMarketingMany?.(locationId, rows, channel);
  const out = new Set<string>();
  for (const r of rows) if (verdicts ? verdicts.get(r.id)?.allow : !r.dnd) out.add(r.id);
  ctx.consent.set(channel, out);
  return out;
}

const OPEN_MSG = `m.contact_id = c.id AND m.channel = 'email' AND m.direction = 'out'`;

function leaf(c: Condition, ctx: Ctx): Frag {
  const p: (string | number)[] = [];
  const since = (n: number) => iso(ctx.now, n);
  switch (c.type) {
    case 'tag': {
      p.push(c.tag);
      return { sql: `${c.has === false ? 'NOT ' : ''}EXISTS (SELECT 1 FROM json_each(c.tags) WHERE value = ?)`, params: p };
    }
    case 'field': {
      const custom = String(c.field).startsWith('custom.');
      const x = custom ? `json_extract(c.custom, ?)` : `c.${c.field}`;
      const pre: (string | number)[] = custom ? [`$.${String(c.field).slice(7)}`] : [];
      const text = `lower(COALESCE(CAST(${x} AS TEXT), ''))`;
      switch (c.op) {
        case 'eq': return { sql: `${text} = ?`, params: [...pre, String(c.value).toLowerCase()] };
        case 'neq': return { sql: `${text} != ?`, params: [...pre, String(c.value).toLowerCase()] };
        case 'contains': return { sql: `${text} LIKE ? ESCAPE '\\'`, params: [...pre, like(String(c.value))] };
        case 'not_contains': return { sql: `${text} NOT LIKE ? ESCAPE '\\'`, params: [...pre, like(String(c.value))] };
        case 'starts': return { sql: `${text} LIKE ? ESCAPE '\\'`, params: [...pre, like(String(c.value), 'start')] };
        case 'empty': return { sql: `${text} = ''`, params: pre };
        case 'not_empty': return { sql: `${text} != ''`, params: pre };
        case 'gt': return { sql: `CAST(${x} AS REAL) > ?`, params: [...pre, Number(c.value)] };
        case 'lt': return { sql: `(${x} IS NOT NULL AND CAST(${x} AS REAL) < ?)`, params: [...pre, ...pre, Number(c.value)] };
        case 'gte': return { sql: `CAST(${x} AS REAL) >= ?`, params: [...pre, Number(c.value)] };
        case 'lte': return { sql: `(${x} IS NOT NULL AND CAST(${x} AS REAL) <= ?)`, params: [...pre, ...pre, Number(c.value)] };
        case 'before': return { sql: `(${text} != '' AND substr(${text}, 1, 10) < ?)`, params: [...pre, ...pre, String(c.value)] };
        case 'after': return { sql: `(${text} != '' AND substr(${text}, 1, 10) > ?)`, params: [...pre, ...pre, String(c.value)] };
      }
      return { sql: '0', params: [] };
    }
    case 'email': {
      const d = c.days as number | undefined;
      if (c.campaign_id) {
        // One campaign: its recipient row (a mail that went out) and what happened to that mail.
        const rec = `SELECT 1 FROM campaign_recipients r JOIN campaigns k ON k.id = r.campaign_id JOIN messages m ON m.id = r.message_id WHERE r.contact_id = c.id AND k.location_id = c.location_id AND r.campaign_id = ? AND r.status = 'sent'`;
        const w = c.event === 'opened' ? ' AND m.opened_at IS NOT NULL' : c.event === 'clicked' ? ' AND m.clicked_at IS NOT NULL' : c.event === 'not_opened' ? ' AND m.opened_at IS NULL AND m.clicked_at IS NULL' : '';
        return { sql: `EXISTS (${rec}${w})`, params: [c.campaign_id] };
      }
      const t = since(d ?? 90);
      const sent = `SELECT 1 FROM messages m WHERE ${OPEN_MSG} AND m.created_at >= ?`;
      if (c.event === 'received') return { sql: `EXISTS (${sent})`, params: [t] };
      if (c.event === 'opened') return { sql: `EXISTS (SELECT 1 FROM messages m WHERE ${OPEN_MSG} AND m.opened_at >= ?)`, params: [t] };
      if (c.event === 'clicked') return { sql: `EXISTS (SELECT 1 FROM messages m WHERE ${OPEN_MSG} AND m.clicked_at >= ?)`, params: [t] };
      // Got mail in the period, and nothing of it (or earlier) was opened or clicked in that period.
      return { sql: `(EXISTS (${sent}) AND NOT EXISTS (SELECT 1 FROM messages m WHERE ${OPEN_MSG} AND (m.opened_at >= ? OR m.clicked_at >= ?)))`, params: [t, t, t] };
    }
    case 'page': {
      p.push(like(c.url_contains));
      let w = '';
      if (c.days) (w = ' AND t.created_at >= ?'), p.push(since(c.days));
      return { sql: `EXISTS (SELECT 1 FROM attribution_touches t WHERE t.contact_id = c.id AND t.location_id = c.location_id AND lower(t.landing_page) LIKE ? ESCAPE '\\'${w})`, params: p };
    }
    case 'purchase': {
      const sc: string[] = [`s.contact_id = c.id`, `s.location_id = c.location_id`, `s.status = 'paid'`, `s.kind IN ('product', 'renewal')`];
      const ic: string[] = [`i.contact_id = c.id`, `i.location_id = c.location_id`, `i.kind = 'invoice'`, `i.status = 'paid'`];
      const sp: (string | number)[] = [];
      const ip: (string | number)[] = [];
      if (c.product_id) (sc.push('s.product_id = ?'), sp.push(c.product_id));
      if (c.days) {
        sc.push('s.paid_at >= ?'), sp.push(since(c.days));
        ic.push('i.paid_at >= ?'), ip.push(since(c.days));
      }
      // A product is only known to Stripe purchases; "any purchase" also counts paid invoices written by hand.
      const sql = c.product_id ? `EXISTS (SELECT 1 FROM stripe_checkouts s WHERE ${sc.join(' AND ')})` : `(EXISTS (SELECT 1 FROM stripe_checkouts s WHERE ${sc.join(' AND ')}) OR EXISTS (SELECT 1 FROM invoices i WHERE ${ic.join(' AND ')}))`;
      return { sql: `${c.bought === false ? 'NOT ' : ''}${sql}`, params: c.product_id ? sp : [...sp, ...ip] };
    }
    case 'form': {
      let w = '';
      if (c.form_id) (w += ' AND f.form_id = ?'), p.push(c.form_id);
      if (c.days) (w += ' AND f.created_at >= ?'), p.push(since(c.days));
      return { sql: `${c.submitted === false ? 'NOT ' : ''}EXISTS (SELECT 1 FROM form_submissions f WHERE f.contact_id = c.id AND f.location_id = c.location_id${w})`, params: p };
    }
    case 'consent': {
      const ids = consentSet(ctx, c.channel);
      return { sql: `c.id ${c.state === 'missing' ? 'NOT ' : ''}IN (SELECT value FROM json_each(?))`, params: [JSON.stringify([...ids])] };
    }
    case 'activity':
      if (c.op === 'never') return { sql: 'c.last_activity_at IS NULL', params: [] };
      return c.op === 'within' ? { sql: 'c.last_activity_at >= ?', params: [since(c.days)] } : { sql: '(c.last_activity_at IS NULL OR c.last_activity_at < ?)', params: [since(c.days)] };
    case 'created':
      return { sql: `c.created_at ${c.op === 'within' ? '>=' : '<'} ?`, params: [since(c.days)] };
    case 'engagement': {
      const t = since(c.days);
      const engaged = `EXISTS (SELECT 1 FROM messages m WHERE ${OPEN_MSG} AND (m.opened_at >= ? OR m.clicked_at >= ?))`;
      if (c.state === 'active') return { sql: engaged, params: [t, t] };
      // Inactive: got at least `min_received` mails in the period and no person opened or clicked any.
      return {
        sql: `((SELECT COUNT(*) FROM messages m WHERE ${OPEN_MSG} AND m.status IN ('sent', 'delivered', 'logged') AND m.created_at >= ?) >= ? AND NOT ${engaged})`,
        params: [t, c.min_received ?? 3, t, t],
      };
    }
    case 'email_check':
      if (c.verdict === 'unchecked') return { sql: `NOT EXISTS (SELECT 1 FROM mk_email_checks k WHERE k.contact_id = c.id AND k.email = c.email)`, params: [] };
      return { sql: `EXISTS (SELECT 1 FROM mk_email_checks k WHERE k.contact_id = c.id AND k.email = c.email AND k.verdict = ?)`, params: [c.verdict] };
    case 'dnd':
      return { sql: c.value === false ? 'c.dnd = 0' : 'c.dnd = 1', params: [] };
    case 'segment': {
      if (ctx.depth >= 3 || ctx.seen.includes(c.segment_id)) throw bad('Segment: verschachtelte Segmente verweisen im Kreis oder sind zu tief');
      const row = ctx.app.db.get<{ definition: string }>('SELECT definition FROM mk_segments WHERE id = ? AND location_id = ?', c.segment_id, ctx.locationId);
      if (!row) throw bad('Segment: das verknüpfte Segment gibt es nicht mehr');
      return node(cleanDefinition(JSON.parse(row.definition)), { ...ctx, depth: ctx.depth + 1, seen: [...ctx.seen, c.segment_id] });
    }
  }
  return { sql: '0', params: [] };
}

function node(n: Node, ctx: Ctx): Frag {
  if (n.type === 'group') {
    const parts = (n as Group).items.map((x) => node(x, ctx));
    if (!parts.length) return { sql: n.negate ? '0' : '1', params: [] };
    const sql = `(${parts.map((x) => x.sql).join((n as Group).op === 'or' ? ' OR ' : ' AND ')})`;
    return { sql: n.negate ? `NOT ${sql}` : sql, params: parts.flatMap((x) => x.params) };
  }
  const f = leaf(n as Condition, ctx);
  return n.negate ? { sql: `NOT (${f.sql})`, params: f.params } : f;
}

/** The WHERE for a definition (contacts alias `c`, sub-account condition included). */
export function compile(app: App, locationId: string, def: Group, now = new Date(), seen: string[] = []): Frag {
  const f = node(def, { app, locationId, now, depth: 0, seen, consent: new Map() });
  return { sql: `c.location_id = ? AND ${f.sql}`, params: [locationId, ...f.params] };
}

/** How many contacts match. */
export function countMembers(app: App, locationId: string, def: Group, now = new Date(), seen: string[] = []): number {
  const f = compile(app, locationId, def, now, seen);
  return Number(app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts c WHERE ${f.sql}`, ...f.params)?.n ?? 0);
}

/** The contacts that match (newest first). */
export function listMembers(app: App, locationId: string, def: Group, opts: { limit?: number; offset?: number } = {}): Contact[] {
  const f = compile(app, locationId, def);
  const rows = app.db.all<Contact>(`SELECT c.* FROM contacts c WHERE ${f.sql} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`, ...f.params, Math.min(opts.limit ?? 50, 100_000), opts.offset ?? 0);
  return rows.map((r) => parseJson(r, ['tags', 'custom']));
}

/** Only the ids (campaign audiences and the membership watcher). */
export function memberIds(app: App, locationId: string, def: Group, seen: string[] = []): string[] {
  const f = compile(app, locationId, def, new Date(), seen);
  return app.db.all<{ id: string }>(`SELECT c.id FROM contacts c WHERE ${f.sql}`, ...f.params).map((r) => r.id);
}

// --- saved segments -------------------------------------------------------------------------------------------

export interface SegmentRow {
  id: string;
  location_id: string;
  name: string;
  description: string;
  definition: Group;
  watch: number;
  watched_at: string | null;
  count: number | null;
  counted_at: string | null;
  created_at: string;
  updated_at: string;
}

export const getSegment = (app: App, locationId: string, id: string): SegmentRow | undefined => parseJson(app.db.get<SegmentRow>('SELECT * FROM mk_segments WHERE id = ? AND location_id = ?', id, locationId), ['definition']);
export const listSegments = (app: App, locationId: string): SegmentRow[] => parseRows(app.db.all<SegmentRow>('SELECT * FROM mk_segments WHERE location_id = ? ORDER BY name', locationId), ['definition']);

/** The ids of a saved segment's members; undefined when it does not exist in this sub-account. */
export function segmentMemberIds(app: App, locationId: string, segmentId: string): string[] | undefined {
  const s = getSegment(app, locationId, segmentId);
  return s ? memberIds(app, locationId, cleanDefinition(s.definition), [s.id]) : undefined;
}

// --- reading a definition aloud ----------------------------------------------------------------------------------

const FIELD_LABEL: Record<string, string> = { first_name: 'Vorname', last_name: 'Nachname', email: 'E-Mail', phone: 'Telefon', company: 'Firma', address: 'Adresse', city: 'Ort', postal_code: 'PLZ', country: 'Land', website: 'Website', source: 'Quelle', assigned_to: 'Zuständig', date_of_birth: 'Geburtstag' };
const OP_LABEL: Record<string, string> = { eq: 'ist', neq: 'ist nicht', contains: 'enthält', not_contains: 'enthält nicht', starts: 'beginnt mit', empty: 'ist leer', not_empty: 'ist nicht leer', gt: '>', lt: '<', gte: '≥', lte: '≤', before: 'vor', after: 'nach' };

/** A German one-liner for a definition ("hat Tag „lead“ UND hat Kampagne „Herbst“ nicht geöffnet"). Names come from `names`. */
export function describe(n: Node, names: { campaign?: (id: string) => string; form?: (id: string) => string; product?: (id: string) => string; segment?: (id: string) => string } = {}): string {
  const wrap = (s: string, neg?: boolean) => (neg ? `NICHT (${s})` : s);
  if (n.type === 'group') {
    const g = n as Group;
    if (!g.items.length) return 'alle Kontakte';
    const parts = g.items.map((x) => describe(x, names));
    return wrap(parts.length > 1 ? `(${parts.join(g.op === 'or' ? ' ODER ' : ' UND ')})` : parts[0], g.negate);
  }
  const c = n as Condition;
  const dz = c.days ? ` in den letzten ${c.days} Tagen` : '';
  const camp = c.campaign_id ? `Kampagne „${names.campaign?.(c.campaign_id) ?? c.campaign_id}“` : 'eine E-Mail';
  let s = '';
  switch (c.type) {
    case 'tag': s = c.has === false ? `hat Tag „${c.tag}“ nicht` : `hat Tag „${c.tag}“`; break;
    case 'field': s = `${FIELD_LABEL[c.field] ?? String(c.field).replace(/^custom\./, '')} ${OP_LABEL[c.op] ?? c.op}${['empty', 'not_empty'].includes(c.op) ? '' : ` „${c.value}“`}`; break;
    case 'email': s = c.event === 'opened' ? `hat ${camp} geöffnet${dz}` : c.event === 'clicked' ? `hat ${camp} angeklickt${dz}` : c.event === 'not_opened' ? `hat ${camp} nicht geöffnet${dz}` : `hat ${camp} erhalten${dz}`; break;
    case 'page': s = `hat eine Seite mit „${c.url_contains}“ besucht${dz}`; break;
    case 'purchase': s = `${c.bought === false ? 'hat nicht gekauft' : 'hat gekauft'}${c.product_id ? `: ${names.product?.(c.product_id) ?? c.product_id}` : ''}${dz}`; break;
    case 'form': s = `${c.submitted === false ? 'hat kein Formular abgeschickt' : 'hat ein Formular abgeschickt'}${c.form_id ? `: ${names.form?.(c.form_id) ?? c.form_id}` : ''}${dz}`; break;
    case 'consent': s = `${c.state === 'missing' ? 'ohne' : 'mit'} Einwilligung (${c.channel === 'email' ? 'E-Mail' : c.channel === 'sms' ? 'SMS' : 'WhatsApp'})`; break;
    case 'activity': s = c.op === 'never' ? 'noch nie aktiv' : c.op === 'within' ? `aktiv in den letzten ${c.days} Tagen` : `seit ${c.days} Tagen inaktiv`; break;
    case 'created': s = c.op === 'within' ? `angelegt in den letzten ${c.days} Tagen` : `angelegt vor mehr als ${c.days} Tagen`; break;
    case 'engagement': s = c.state === 'active' ? `hat in den letzten ${c.days} Tagen geöffnet oder geklickt` : `hat in ${c.days} Tagen ${c.min_received ?? 3}+ Mails bekommen, aber nie geöffnet oder geklickt`; break;
    case 'email_check': s = c.verdict === 'unchecked' ? 'E-Mail-Adresse noch nicht geprüft' : `E-Mail-Adresse ${c.verdict === 'ok' ? 'in Ordnung' : c.verdict === 'risky' ? 'riskant' : 'ungültig'}`; break;
    case 'dnd': s = c.value === false ? 'ohne „Nicht stören“' : 'mit „Nicht stören“'; break;
    case 'segment': s = `ist in Segment „${names.segment?.(c.segment_id) ?? c.segment_id}“`; break;
  }
  return wrap(s, c.negate);
}
