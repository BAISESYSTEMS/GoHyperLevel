import { id as newId } from '../core/util.js';
import type { Block } from './site-blocks.js';
import { walkBlocks } from './site-layout.js';

/**
 * Funnel & Website AI (pure): what the AI may write into a page and how its answer is checked – the block schema (a subset of
 * the site block registry, with fields, lengths and choices), the simple section format the AI answers in
 * (`{name, style, layout, columns: [[block, …], …]}`), compiling it into the real layout (section → row → columns → blocks)
 * and back (`decompileSection`, for section commands), and merging a rewritten section into the original without losing its
 * styling. Every block type must also exist in the app's block registry (`siteBlocks(app)`), which the caller passes in.
 * Account things are ids the AI may only pick from the list it got (form, calendar, product) – an invented id is an error.
 */

export type FieldKind = 'text' | 'md' | 'link' | 'int' | 'enum' | 'ref';
export interface FieldSpec {
  kind: FieldKind;
  max?: number;
  required?: boolean;
  options?: readonly (string | number)[];
  min?: number;
  /** ref: which list of the account the id must come from */
  ref?: 'form' | 'calendar' | 'product';
  hint?: string;
}
export interface ItemsSpec {
  min: number;
  max: number;
  fields: Record<string, FieldSpec>;
}
export interface AiBlockSpec {
  label: string;
  fields: Record<string, FieldSpec>;
  items?: ItemsSpec;
  /** what the block is good for (one line for the AI) */
  use: string;
}

const T = (max: number, required = false, hint?: string): FieldSpec => ({ kind: 'text', max, required, hint });
const MD = (max: number, required = false): FieldSpec => ({ kind: 'md', max, required });
const L = (required = false): FieldSpec => ({ kind: 'link', max: 300, required });
const ALIGN: FieldSpec = { kind: 'enum', options: ['left', 'center', 'right'] };

/** The blocks the AI may use – no pictures, videos or custom code (it cannot know real ones). */
export const AI_BLOCKS: Record<string, AiBlockSpec> = {
  hero: { label: 'Hero', use: 'Seitenanfang: H1-Überschrift, Unterzeile, ein Button', fields: { heading: T(110, true, 'die H1 der Seite'), subheading: T(320), button_text: T(40), button_url: L(), align: ALIGN } },
  heading: { label: 'Überschrift', use: 'Zwischenüberschrift', fields: { text: T(120, true), level: { kind: 'int', options: [1, 2, 3], hint: '1 nur, wenn die Seite keinen Hero hat' }, align: ALIGN } },
  text: { label: 'Text', use: 'Absätze und Listen (**fett**, *kursiv*, - Liste)', fields: { text: MD(2400, true), align: ALIGN } },
  button: { label: 'Button', use: 'ein oder zwei Buttons', fields: { text: T(40, true), url: L(true), text2: T(40), url2: L(), align: ALIGN } },
  features: { label: 'Vorteile', use: '2–6 Vorteile mit Emoji-Icon', fields: { heading: T(110), align: ALIGN }, items: { min: 2, max: 6, fields: { icon: T(12, false, 'ein Emoji'), title: T(60, true), text: T(240) } } },
  steps: { label: 'Ablauf', use: '2–6 nummerierte Schritte', fields: { heading: T(110), align: ALIGN }, items: { min: 2, max: 6, fields: { title: T(60, true), text: T(240) } } },
  stats: { label: 'Zahlen', use: '2–4 Kennzahlen – nur Zahlen aus der Beschreibung, sonst Platzhalter wie „[Zahl]“', fields: { heading: T(110) }, items: { min: 2, max: 4, fields: { value: T(16, true), label: T(60, true) } } },
  testimonial: { label: 'Kundenstimme', use: 'ein Zitat – ohne echte Stimme ein klar markierter Platzhalter', fields: { quote: T(400, true), author: T(80, true), align: ALIGN } },
  faq: { label: 'FAQ', use: '2–10 Fragen mit Antworten', fields: { heading: T(110) }, items: { min: 2, max: 10, fields: { q: T(160, true), a: MD(700, true) } } },
  pricing: { label: 'Preise', use: '1–4 Pakete – nur Preise aus der Beschreibung, sonst „auf Anfrage“', fields: { heading: T(110), align: ALIGN }, items: { min: 1, max: 4, fields: { name: T(40, true), price: T(30, true), features: T(600, false, 'eine Leistung pro Zeile'), button_text: T(40), button_url: L() } } },
  cta: { label: 'Aufruf', use: 'Handlungsaufforderung mit Button(s)', fields: { heading: T(110, true), text: T(300), button_text: T(40), button_url: L(), button2_text: T(40), button2_url: L(), style: { kind: 'enum', options: ['', 'dark', 'light'] } } },
  form: { label: 'Formular', use: 'das Formular des Sub-Accounts (Anfrage, Anmeldung)', fields: { heading: T(110), form_id: { kind: 'ref', ref: 'form', hint: 'leer = HyperLevel setzt das passende Formular ein' } } },
  calendar: { label: 'Kalender', use: 'Terminbuchung', fields: { calendar_slug: { kind: 'ref', ref: 'calendar', hint: 'leer = der erste Kalender' } } },
  product: { label: 'Produkt / Kasse', use: 'Produkt mit Preis und Button zur Kaufseite', fields: { product_id: { kind: 'ref', ref: 'product', hint: 'leer = später wählen' }, heading: T(110), text: T(400), button_text: T(40), badge: T(30) } },
  divider: { label: 'Trennlinie', use: 'Linie', fields: {} },
  spacer: { label: 'Abstand', use: 'Leerraum', fields: { height: { kind: 'int', min: 8, max: 160 } } },
};

export const STYLES = ['plain', 'soft', 'brand', 'dark'] as const;
export type SectionStyle = (typeof STYLES)[number];
export const LAYOUTS: Record<string, number[]> = { '1': [12], '2': [6, 6], '3': [4, 4, 4], '4': [3, 3, 3, 3], '7-5': [7, 5], '5-7': [5, 7], '8-4': [8, 4], '4-8': [4, 8] };
export const WIDTHS = ['narrow', 'normal', 'wide'] as const;
const STYLE_BG: Record<SectionStyle, { bg?: string; color?: string }> = { plain: { bg: 'token:bg' }, soft: { bg: 'token:surface' }, brand: { bg: 'token:brand' }, dark: { bg: '#111827', color: '#ffffff' } };
export const SECTION_LIMITS = { sectionsPerPage: 14, blocksPerColumn: 8, rowsPerSection: 4 } as const;

/** Lists of the account the AI may pick from. */
export interface AccountRefs {
  form: { id: string; name: string }[];
  calendar: { slug: string; name: string }[];
  product: { id: string; name: string; price?: string }[];
}
export interface BlockEnv {
  /** block types of the app's registry (`siteBlocks(app)`) */
  registry: Set<string>;
  refs: AccountRefs;
  /** page paths of the plan: `page:<slug>` links must point at one */
  pages: Set<string>;
}

/** The schema as one compact line per block for the prompt: `- hero · Hero: heading*:text≤110, …`. */
export function blockCatalogText(registry: Set<string>): string {
  const f = (k: string, s: FieldSpec) => `${k}${s.required ? '*' : ''}:${s.kind === 'enum' || (s.kind === 'int' && s.options) ? (s.options ?? []).map((o) => JSON.stringify(o)).join('|') : s.kind === 'ref' ? `<${s.ref}-id>` : s.kind === 'int' ? `zahl${s.min !== undefined ? ` ${s.min}–${s.max}` : ''}` : `${s.kind === 'link' ? 'link' : s.kind === 'md' ? 'markdown' : 'text'}≤${s.max}`}${s.hint ? ` (${s.hint})` : ''}`;
  return Object.entries(AI_BLOCKS)
    .filter(([type]) => registry.has(type))
    .map(([type, s]) => `- ${type} · ${s.label} – ${s.use}: ${[...Object.entries(s.fields).map(([k, v]) => f(k, v)), ...(s.items ? [`items*:[${s.items.min}–${s.items.max}× {${Object.entries(s.items.fields).map(([k, v]) => f(k, v)).join(', ')}}]`] : [])].join(', ') || '(keine Felder)'}`)
    .join('\n');
}

const LINK_RE = /^(page:[a-z0-9][a-z0-9-]{0,59}|#[a-z][a-z0-9_-]{0,39}|https:\/\/[^\s"'<>]{3,280}|mailto:[^\s"'<>]{3,120}|tel:\+?[0-9 ()/-]{3,30})$/;

export interface CheckedBlock {
  block?: Block;
  errors: string[];
  warnings: string[];
}

/** One block: type known (schema and registry), fields typed and within limits, ids from the account, links that resolve. */
export function checkBlock(raw: any, env: BlockEnv, where: string): CheckedBlock {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: [`${where}: ein Block muss ein Objekt sein`], warnings };
  const type = String(raw.type ?? '');
  const spec = AI_BLOCKS[type];
  if (!spec || !env.registry.has(type)) return { errors: [`${where}: unbekannter Block-Typ „${type || '(leer)'}“ – erlaubt: ${Object.keys(AI_BLOCKS).filter((t) => env.registry.has(t)).join(', ')}`], warnings };
  const out: Block = { id: typeof raw.id === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(raw.id) ? raw.id : newId(8), type };
  const field = (k: string, s: FieldSpec, v: unknown, at: string, into: Record<string, any>) => {
    if (v === undefined || v === null || v === '') {
      if (s.required) errors.push(`${at}: „${k}“ fehlt`);
      return;
    }
    switch (s.kind) {
      case 'text':
      case 'md': {
        if (typeof v !== 'string' && typeof v !== 'number') return void errors.push(`${at}: „${k}“ muss Text sein`);
        const t = String(v).trim();
        if (s.max && t.length > s.max) return void errors.push(`${at}: „${k}“ ist ${t.length} Zeichen lang, höchstens ${s.max} – kürzen`);
        if (/<\/?[a-z][^>]*>/i.test(t)) return void errors.push(`${at}: „${k}“ enthält HTML – nur reiner Text${s.kind === 'md' ? ' bzw. **fett**, *kursiv*, - Liste' : ''}`);
        if (t) into[k] = t;
        return;
      }
      case 'link': {
        const t = String(v).trim();
        if (!LINK_RE.test(t)) return void errors.push(`${at}: „${k}“ = „${t.slice(0, 60)}“ ist kein erlaubter Link (page:<pfad>, #anker, https://…, mailto:, tel:)`);
        if (t.startsWith('page:') && !env.pages.has(t.slice(5))) return void errors.push(`${at}: „${k}“ zeigt auf die Seite „${t.slice(5)}“, die es im Plan nicht gibt – erlaubt: ${[...env.pages].join(', ')}`);
        into[k] = t;
        return;
      }
      case 'int': {
        const n = Number(v);
        if (!Number.isInteger(n)) return void errors.push(`${at}: „${k}“ muss eine ganze Zahl sein`);
        if (s.options && !s.options.includes(n)) return void errors.push(`${at}: „${k}“ muss ${s.options.join(' oder ')} sein`);
        if (s.min !== undefined && (n < s.min || n > (s.max ?? n))) return void errors.push(`${at}: „${k}“ muss zwischen ${s.min} und ${s.max} liegen`);
        into[k] = n;
        return;
      }
      case 'enum': {
        if (!s.options!.includes(v as string)) return void errors.push(`${at}: „${k}“ muss eines von ${s.options!.map((o) => JSON.stringify(o)).join(', ')} sein`);
        if (v !== '') into[k] = v;
        return;
      }
      case 'ref': {
        const t = String(v);
        const list = env.refs[s.ref!];
        const ok = s.ref === 'calendar' ? (list as AccountRefs['calendar']).some((c) => c.slug === t) : (list as { id: string }[]).some((x) => x.id === t);
        if (!ok) return void errors.push(`${at}: „${k}“ = „${t.slice(0, 40)}“ gibt es in diesem Sub-Account nicht – nimm eine ID aus der Liste oder lass das Feld leer`);
        into[k] = t;
        return;
      }
    }
  };
  for (const [k, s] of Object.entries(spec.fields)) field(k, s, raw[k], `${where} (${type})`, out);
  if (spec.items) {
    const items = raw.items;
    if (!Array.isArray(items)) errors.push(`${where} (${type}): „items“ muss eine Liste sein`);
    else {
      if (items.length < spec.items.min || items.length > spec.items.max) errors.push(`${where} (${type}): ${items.length} Einträge, erlaubt ${spec.items.min}–${spec.items.max}`);
      out.items = items.slice(0, spec.items.max).map((it: any, i: number) => {
        const o: Record<string, any> = {};
        if (!it || typeof it !== 'object' || Array.isArray(it)) {
          errors.push(`${where} (${type}) Eintrag ${i + 1}: muss ein Objekt sein`);
          return o;
        }
        for (const [k, s] of Object.entries(spec.items!.fields)) field(k, s, it[k], `${where} (${type}) Eintrag ${i + 1}`, o);
        const extra = Object.keys(it).filter((k) => !(k in spec.items!.fields));
        if (extra.length) warnings.push(`${where} (${type}) Eintrag ${i + 1}: unbekannte Felder entfernt: ${extra.join(', ')}`);
        return o;
      });
    }
  }
  const extra = Object.keys(raw).filter((k) => !['type', 'id', 'items'].includes(k) && !(k in spec.fields));
  if (extra.length) warnings.push(`${where} (${type}): unbekannte Felder entfernt: ${extra.join(', ')}`);
  return { block: out, errors, warnings };
}

export interface SimpleSection {
  id?: string;
  name?: string;
  style?: SectionStyle;
  width?: (typeof WIDTHS)[number];
  anchor?: string;
  layout?: string;
  columns?: unknown[][];
  rows?: { layout?: string; columns: unknown[][] }[];
  keep?: boolean;
}
export interface CheckedSection {
  /** id of an existing section this one replaces (section commands), else undefined */
  id?: string;
  keep?: boolean;
  name: string;
  style?: SectionStyle;
  width?: string;
  anchor?: string;
  rows: { spans: number[]; columns: Block[][] }[];
}

/** One section of the simple format: its rows and columns with checked blocks. */
export function checkSection(raw: any, env: BlockEnv, where: string, known?: Set<string>): { section?: CheckedSection; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: [`${where}: ein Abschnitt muss ein Objekt sein`], warnings };
  const sid = typeof raw.id === 'string' && raw.id ? raw.id : undefined;
  if (sid && known && !known.has(sid)) errors.push(`${where}: Abschnitt „${sid}“ gibt es auf der Seite nicht – neue Abschnitte ohne id`);
  if (raw.keep === true) {
    if (!sid) errors.push(`${where}: „keep“ nur mit der id eines vorhandenen Abschnitts`);
    return { section: { id: sid, keep: true, name: '', rows: [] }, errors, warnings };
  }
  const name = String(raw.name ?? '').trim().slice(0, 80);
  const style = raw.style === undefined || raw.style === '' ? undefined : STYLES.includes(raw.style) ? (raw.style as SectionStyle) : (errors.push(`${where}: style muss ${STYLES.join(', ')} sein`), undefined);
  const width = raw.width === undefined || raw.width === '' ? undefined : (WIDTHS as readonly string[]).includes(raw.width) ? raw.width : (errors.push(`${where}: width muss ${WIDTHS.join(', ')} sein`), undefined);
  const anchor = raw.anchor === undefined || raw.anchor === '' ? undefined : /^[a-z][a-z0-9_-]{0,39}$/.test(String(raw.anchor)) ? String(raw.anchor) : (errors.push(`${where}: anchor nur Kleinbuchstaben, Ziffern, - und _`), undefined);
  const rawRows: { layout?: string; columns: unknown }[] = Array.isArray(raw.rows) ? raw.rows : [{ layout: raw.layout, columns: raw.columns }];
  if (!rawRows.length) errors.push(`${where}: keine Zeilen`);
  if (rawRows.length > SECTION_LIMITS.rowsPerSection) errors.push(`${where}: höchstens ${SECTION_LIMITS.rowsPerSection} Zeilen`);
  const rows: CheckedSection['rows'] = [];
  rawRows.slice(0, SECTION_LIMITS.rowsPerSection).forEach((r, ri) => {
    const at = rawRows.length > 1 ? `${where} Zeile ${ri + 1}` : where;
    const cols = (r as any)?.columns;
    if (!Array.isArray(cols) || !cols.length || cols.some((c: unknown) => !Array.isArray(c))) return void errors.push(`${at}: „columns“ muss eine Liste von Spalten sein, jede Spalte eine Liste von Blöcken: [[…], […]]`);
    const layout = String((r as any)?.layout ?? (cols.length === 1 ? '1' : cols.length === 2 ? '2' : cols.length === 3 ? '3' : '4'));
    const spans = LAYOUTS[layout];
    if (!spans) return void errors.push(`${at}: layout „${layout}“ unbekannt – erlaubt: ${Object.keys(LAYOUTS).join(', ')}`);
    if (spans.length !== cols.length) return void errors.push(`${at}: layout „${layout}“ hat ${spans.length} Spalte(n), geliefert wurden ${cols.length}`);
    const columns: Block[][] = cols.map((c: unknown[], ci: number) => {
      if (c.length > SECTION_LIMITS.blocksPerColumn) errors.push(`${at} Spalte ${ci + 1}: höchstens ${SECTION_LIMITS.blocksPerColumn} Blöcke`);
      return c.slice(0, SECTION_LIMITS.blocksPerColumn).flatMap((b, bi) => {
        const r2 = checkBlock(b, env, `${at} Spalte ${ci + 1} Block ${bi + 1}`);
        errors.push(...r2.errors);
        warnings.push(...r2.warnings);
        return r2.block ? [r2.block] : [];
      });
    });
    if (columns.every((c) => !c.length)) errors.push(`${at}: leer`);
    rows.push({ spans, columns });
  });
  return { section: { id: sid, name, style, width, anchor, rows }, errors, warnings };
}

/** A checked section as the real layout block the editor stores. */
export function compileSection(s: CheckedSection, o: { first?: boolean } = {}): Block {
  const look = s.style ? STYLE_BG[s.style] : {};
  const hasHero = s.rows.some((r) => r.columns.some((c) => c.some((b) => b.type === 'hero')));
  return {
    id: newId(8),
    type: 'section',
    name: s.name,
    width: s.width ?? 'normal',
    pad_y: hasHero || o.first ? 88 : 64,
    pad_x: 20,
    ...(look.bg ? { bg: look.bg } : {}),
    ...(look.color ? { color: look.color } : {}),
    ...(s.anchor ? { anchor: s.anchor } : {}),
    rows: s.rows.map((r) => ({
      id: newId(8),
      gap: r.spans.length > 1 ? 32 : 24,
      stack: r.spans.length > 2 ? 'tablet' : 'phone',
      ...(r.spans.length > 1 ? { valign: 'center' } : {}),
      cols: r.spans.map((span, i) => ({ id: newId(8), span, blocks: (r.columns[i] ?? []).map((b) => ({ ...b, ...(b.type !== 'section' && r.spans.length === 1 && ['features', 'steps', 'stats', 'pricing', 'faq', 'cta'].includes(b.type) ? { padding: 0 } : {}) })) })),
    })),
  };
}

const CONTENT = (type: string) => new Set([...Object.keys(AI_BLOCKS[type]?.fields ?? {}), ...(AI_BLOCKS[type]?.items ? ['items'] : [])]);
const contentOf = (b: Block) => {
  const keep = CONTENT(b.type);
  const out: Record<string, any> = { id: b.id, type: b.type };
  for (const k of keep) if (b[k] !== undefined && b[k] !== '') out[k] = b[k];
  return out;
};

/** A real section in the simple format (block ids kept, styling left out) – what the AI gets for a section command. */
export function decompileSection(sec: Block): SimpleSection & { id: string } {
  const rows = (Array.isArray(sec.rows) ? sec.rows : []).map((r: any) => {
    const cols = Array.isArray(r?.cols) ? r.cols : [];
    const spans = cols.map((c: any) => Number(c?.span) || 12);
    const layout = Object.entries(LAYOUTS).find(([, v]) => v.length === spans.length && v.every((x, i) => x === spans[i]))?.[0] ?? String(Math.min(4, Math.max(1, cols.length)));
    return { layout, columns: cols.map((c: any) => (Array.isArray(c?.blocks) ? c.blocks : []).filter((b: any) => b && AI_BLOCKS[b.type]).map(contentOf)) };
  });
  const bg = String(sec.bg ?? '');
  const style = bg === 'token:surface' ? 'soft' : bg === 'token:brand' ? 'brand' : bg === '#111827' ? 'dark' : bg === 'token:bg' ? 'plain' : undefined;
  return { id: String(sec.id), name: String(sec.name ?? ''), ...(style ? { style } : {}), ...(sec.anchor ? { anchor: sec.anchor } : {}), rows };
}

/**
 * Puts a rewritten section back into the original: same row/column structure → the columns keep their settings and each block
 * keeps its styling (colours, spacing, devices) with the new content; another structure → rows are rebuilt. Blocks the AI did
 * not return are gone; new blocks get new ids. Section-level settings (background image, padding …) always stay.
 */
export function mergeSection(original: Block, s: CheckedSection): Block {
  const out: Block = { ...original };
  if (s.name) out.name = s.name;
  if (s.style) {
    const look = STYLE_BG[s.style];
    out.bg = look.bg;
    if (look.color) out.color = look.color;
    else delete out.color;
  }
  if (s.anchor) out.anchor = s.anchor;
  const oldBlocks = new Map<string, Block>();
  walkBlocks([original], (b) => {
    if (b.type !== 'section') oldBlocks.set(String(b.id), b);
  });
  const mergeBlock = (b: Block): Block => {
    const old = oldBlocks.get(String(b.id));
    if (!old || old.type !== b.type) return { ...b, id: old ? newId(8) : b.id };
    oldBlocks.delete(String(b.id)); // one use per id
    const merged: Block = { ...old };
    for (const k of CONTENT(b.type)) {
      if (b[k] !== undefined) merged[k] = b[k];
      else delete merged[k];
    }
    return merged;
  };
  const oldRows: any[] = Array.isArray(original.rows) ? original.rows : [];
  const same = oldRows.length === s.rows.length && s.rows.every((r, i) => (oldRows[i]?.cols ?? []).length === r.spans.length);
  out.rows = s.rows.map((r, ri) => {
    const base = same ? oldRows[ri] : { id: newId(8), gap: r.spans.length > 1 ? 32 : 24, stack: r.spans.length > 2 ? 'tablet' : 'phone' };
    return {
      ...base,
      cols: r.spans.map((span, ci) => ({ ...(same ? base.cols[ci] : { id: newId(8), span }), ...(same ? {} : { span }), blocks: (r.columns[ci] ?? []).map(mergeBlock) })),
    };
  });
  return out;
}

/** The H1s of a page (hero headings and level-1 headings): exactly one is right. */
export function h1Count(blocks: Block[]): number {
  let n = 0;
  walkBlocks(blocks, (b) => {
    if (b.type === 'hero' || (b.type === 'heading' && Number(b.level) === 1)) n++;
  });
  return n;
}
