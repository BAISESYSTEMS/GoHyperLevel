/**
 * Finding people who are in the address book twice – pure, no database. Two contacts are the same person when they share an e-mail
 * address or a phone number (different notations of the same number count), or have the same name at the same company (typos and a
 * swapped first/last name count too). Groups are formed over these links; each group suggests the fullest record to keep.
 * The merge itself (what moves where, undo) is in contact-merge.ts.
 */

export interface DupRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company: string;
  address?: string;
  city?: string;
  postal_code?: string;
  created_at: string;
  last_activity_at?: string | null;
  assigned_to?: string | null;
}

export type Reason = 'email' | 'phone' | 'name_company' | 'name_fuzzy';
export const REASON_LABEL: Record<Reason, string> = { email: 'Gleiche E-Mail-Adresse', phone: 'Gleiche Telefonnummer', name_company: 'Gleicher Name und gleiche Firma', name_fuzzy: 'Sehr ähnlicher Name bei derselben Firma' };

export interface DupGroup {
  /** Stable key of the group (its sorted ids), for ignoring and for links. */
  key: string;
  confidence: 'high' | 'medium';
  reasons: Reason[];
  ids: string[];
  /** The record that holds the most (a suggestion; the person decides). */
  keep: string;
}

export const emailKey = (e: unknown): string => {
  const s = typeof e === 'string' ? e.trim().toLowerCase() : '';
  return /^[^@\s]+@[^@\s]+$/.test(s) ? s : '';
};

/** The last nine digits of a number without its national or international prefix: "+49 151 1234567" and "0151/1234567" are one number. */
export const phoneKey = (p: unknown): string => {
  let d = typeof p === 'string' ? p.replace(/\D/g, '') : '';
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  return d.length >= 7 ? d.slice(-9) : '';
};

/** Lower case, German umlauts spelled out (ü = ue, the way people write it without the key), other accents dropped. */
const fold = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Words a company name often carries that say nothing about who it is. */
const LEGAL = new Set(['gmbh', 'ag', 'kg', 'ug', 'ohg', 'gbr', 'mbh', 'co', 'und', 'inc', 'ltd', 'llc', 'e', 'k', 'ev', 'se', 'the']);
export const companyKey = (c: unknown): string =>
  fold(c)
    .split(' ')
    .filter((w) => w && !LEGAL.has(w))
    .join(' ');

/** First and last name as sorted tokens, so "Hans Müller" and "Müller, Hans" are the same. */
export const nameTokens = (first: unknown, last: unknown): string[] => fold(`${first ?? ''} ${last ?? ''}`).split(' ').filter(Boolean).sort();

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** 1 = the same, 0 = nothing in common. */
export const similarity = (a: string, b: string): number => (a || b ? 1 - levenshtein(a, b) / Math.max(a.length, b.length) : 1);

let rowA = new Int32Array(64);
let rowB = new Int32Array(64);
/** The edit distance, or `max + 1` as soon as it is certain to be larger – fast for names that have little in common. */
export function levenshteinWithin(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  if (b.length + 1 > rowA.length) (rowA = new Int32Array(b.length + 1)), (rowB = new Int32Array(b.length + 1));
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let min = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
      cur[j] = v;
      if (v < min) min = v;
    }
    if (min > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** The keys of a record, worked out once (a pair is compared thousands of times in a big address book). */
interface Keys {
  email: string;
  phone: string;
  company: string;
  name: string;
}
const keyCache = new WeakMap<DupRow, Keys>();
const keysOf = (r: DupRow): Keys => {
  let k = keyCache.get(r);
  if (!k) keyCache.set(r, (k = { email: emailKey(r.email), phone: phoneKey(r.phone), company: companyKey(r.company), name: nameTokens(r.first_name, r.last_name).join(' ') }));
  return k;
};

// --- links between two records -------------------------------------------------------------------------------------------------------

/** Why two contacts look like the same person (empty = not). */
export function pairReasons(a: DupRow, b: DupRow): Reason[] {
  const out: Reason[] = [];
  const x = keysOf(a);
  const y = keysOf(b);
  if (x.email && x.email === y.email) out.push('email');
  if (x.phone && x.phone === y.phone) out.push('phone');
  if (x.company && x.company === y.company && x.name.includes(' ') && y.name.includes(' ')) {
    // a single word ("Hans") is no name to go by
    if (x.name === y.name) out.push('name_company');
    else {
      // similarity >= 0.88, i.e. at most 12 % of the longer name has to change
      const longest = Math.max(x.name.length, y.name.length);
      const room = Math.floor(0.12 * longest + 1e-9);
      if (levenshteinWithin(x.name, y.name, room) <= room) out.push('name_fuzzy');
    }
  }
  return out;
}

/** How full a record is: what the person would rather keep. */
export function completeness(r: DupRow): number {
  let n = 0;
  for (const k of ['first_name', 'last_name', 'email', 'phone', 'company', 'address', 'city', 'postal_code'] as const) if (String(r[k] ?? '').trim()) n += k === 'email' || k === 'phone' ? 2 : 1;
  if (r.last_activity_at) n += 1;
  if (r.assigned_to) n += 1;
  return n;
}

const MAX_BLOCK = 300;

/**
 * The groups of probable duplicates among `rows`. Candidates are found through shared keys (e-mail, phone, company) instead of
 * comparing every pair, so a large address book is no problem; `ignored` pairs ("not the same person") never link.
 */
export function findGroups(rows: DupRow[], o: { ignored?: Set<string>; min?: 'high' | 'medium' } = {}): DupGroup[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    parent.set(x, p);
    return p;
  };
  const reasons = new Map<string, Set<Reason>>(); // by group root, filled at the end
  const edges: { a: string; b: string; r: Reason[] }[] = [];
  const seen = new Set<string>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const consider = (a: DupRow, b: DupRow) => {
    if (a.id === b.id) return;
    const k = pairKey(a.id, b.id);
    if (seen.has(k)) return;
    seen.add(k);
    if (o.ignored?.has(k)) return;
    const r = pairReasons(a, b);
    if (r.length) edges.push({ a: a.id, b: b.id, r });
  };
  const blocks = (key: (r: DupRow) => string) => {
    const m = new Map<string, DupRow[]>();
    for (const r of rows) {
      const k = key(r);
      if (k) (m.get(k) ?? m.set(k, []).get(k)!).push(r);
    }
    for (const list of m.values()) {
      if (list.length < 2) continue;
      const cap = list.slice(0, MAX_BLOCK);
      for (let i = 0; i < cap.length; i++) for (let j = i + 1; j < cap.length; j++) consider(cap[i], cap[j]);
    }
  };
  blocks((r) => emailKey(r.email));
  blocks((r) => phoneKey(r.phone));
  // The same company: only people with a full name are compared, and only when their names are about as long (nobody pairs "Anna Berg" with "Maximilian Hohenzollern").
  const byCompany = new Map<string, DupRow[]>();
  for (const r of rows) {
    const k = keysOf(r);
    if (k.company && k.name.includes(' ')) (byCompany.get(k.company) ?? byCompany.set(k.company, []).get(k.company)!).push(r);
  }
  for (const list of byCompany.values()) {
    const cap = list.slice(0, MAX_BLOCK);
    const names = cap.map((r) => keysOf(r).name);
    for (let i = 0; i < cap.length; i++)
      for (let j = i + 1; j < cap.length; j++) {
        if (names[i] !== names[j] && Math.abs(names[i].length - names[j].length) > 0.12 * Math.max(names[i].length, names[j].length)) continue;
        consider(cap[i], cap[j]);
      }
  }
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const e of edges) {
    const root = find(e.a);
    const set = reasons.get(root) ?? reasons.set(root, new Set()).get(root)!;
    for (const x of e.r) set.add(x);
  }
  const members = new Map<string, string[]>();
  for (const e of edges) for (const id of [e.a, e.b]) {
    const root = find(id);
    const list = members.get(root) ?? members.set(root, []).get(root)!;
    if (!list.includes(id)) list.push(id);
  }
  const out: DupGroup[] = [];
  for (const [root, ids] of members) {
    const rs = [...(reasons.get(root) ?? [])];
    const confidence: DupGroup['confidence'] = rs.some((x) => x === 'email' || x === 'phone' || x === 'name_company') ? 'high' : 'medium';
    if (o.min === 'high' && confidence !== 'high') continue;
    const sorted = ids
      .map((id) => byId.get(id)!)
      .sort((x, y) => completeness(y) - completeness(x) || (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0) || (x.id < y.id ? -1 : 1));
    const keyIds = [...ids].sort();
    out.push({ key: keyIds.join('|'), confidence, reasons: (['email', 'phone', 'name_company', 'name_fuzzy'] as Reason[]).filter((x) => rs.includes(x)), ids: sorted.map((x) => x.id), keep: sorted[0].id });
  }
  return out.sort((a, b) => (a.confidence === b.confidence ? b.ids.length - a.ids.length : a.confidence === 'high' ? -1 : 1) || (a.key < b.key ? -1 : 1));
}

/** The key under which "not the same person" is stored for two contacts. */
export const ignoreKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
