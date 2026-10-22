import { bad } from '../core/http.js';
import { id as newId } from '../core/util.js';
import { escapeHtml } from '../core/template.js';
import { BG_URL, fsClass, onBg, renderBlocks, safeUrl, type Block, type BlockDef, type BlockEnv, type BlockRegistry } from './site-blocks.js';
import { cid, colorCss, colorHex, hideClasses, isColor, readableOn, type Breakpoint } from './site-style.js';

/**
 * Site builder: nested layout – section → row → columns (1–4) → blocks.
 *
 * ```
 * { type:'section', bg, pad_y, width:'normal', rows:[ { cols:[ { span:6, blocks:[…] }, { span:6, blocks:[…] } ], stack:'phone', gap:24 } ] }
 * ```
 * Rows are 12 twelfths wide (flex with a width per column that accounts for the gap – a grid with tracks would overflow when the gaps are wider than the screen): a column's `span` (1–12) is its width in twelfths; below `stack` ("tablet" ≤ 1024 px, "phone" ≤ 640 px,
 * or "never") the columns stack. Sections, rows and columns can be hidden per device (`hide`), a column can change its width on
 * tablet and phone (`r.tablet.span`, `r.phone.span`), a section can change its padding (`r.tablet.pad_y` …) and any element can scale
 * its font size per device (`fs`). Pure functions: `cleanBlocks` (what may be stored), `walkBlocks` (every block of a page, in
 * order) and the renderer registered for the type `section`.
 */

export const MAX_NODES = 400;
export const MAX_COLS = 4;
const WIDTHS: Record<string, string> = { narrow: '760px', normal: '1100px', wide: '1320px', full: '100%' };
const BORDER_STYLES = ['solid', 'dashed', 'dotted'];

const int = (v: unknown, min: number, max: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const optInt = (v: unknown, min: number, max: number) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? undefined : int(v, min, max, min));
const str = (v: unknown, max: number) => String(v ?? '').slice(0, max);

function cleanHide(h: unknown): Record<string, true> | undefined {
  if (!h || typeof h !== 'object') return undefined;
  const out: Record<string, true> = {};
  for (const k of ['desktop', 'tablet', 'phone']) if ((h as any)[k]) out[k] = true;
  return Object.keys(out).length ? out : undefined;
}
function cleanFs(f: unknown): Record<string, number> | undefined {
  if (!f || typeof f !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const k of ['desktop', 'tablet', 'phone']) {
    const n = Number((f as any)[k]);
    if (Number.isFinite(n) && n >= 50 && n <= 220 && n !== 100) out[k] = Math.round(n);
  }
  return Object.keys(out).length ? out : undefined;
}
function cleanBorder(b: unknown): { w: number; style: string; color: string } | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const w = int((b as any).w, 0, 12, 0);
  if (!w) return undefined;
  const style = BORDER_STYLES.includes((b as any).style) ? (b as any).style : 'solid';
  const color = isColor((b as any).color) ? (b as any).color : 'token:line';
  return { w, style, color };
}

/** Props every block may carry (new ones are only kept when they have a sane value). */
function cleanCommon(src: Record<string, any>, out: Record<string, any>) {
  const hide = cleanHide(src.hide);
  const fs = cleanFs(src.fs);
  if (hide) out.hide = hide;
  else delete out.hide;
  if (fs) out.fs = fs;
  else delete out.fs;
  if (src.anchor !== undefined) {
    const a = String(src.anchor).trim().toLowerCase();
    if (/^[a-z][a-z0-9_-]{0,39}$/.test(a)) out.anchor = a;
    else delete out.anchor;
  }
  for (const k of ['bg', 'color']) if (src[k] !== undefined && src[k] !== '' && !isColor(src[k])) delete out[k];
  if (src.shadow !== undefined && !['none', 'sm', 'md', 'lg'].includes(src.shadow)) delete out.shadow;
}

function cleanCol(c: any, count: { n: number }, n: number): Record<string, any> {
  const out: Record<string, any> = { id: str(c?.id, 40) || newId(8) };
  const given = optInt(c?.span, 1, 12);
  out.span = given ?? Math.max(1, Math.floor(12 / n));
  if (c?.align && ['left', 'center', 'right'].includes(c.align)) out.align = c.align;
  if (c?.valign && ['top', 'center', 'bottom'].includes(c.valign)) out.valign = c.valign;
  if (isColor(c?.bg)) out.bg = c.bg;
  const pad = optInt(c?.pad, 0, 80);
  if (pad !== undefined) out.pad = pad;
  const radius = optInt(c?.radius, 0, 64);
  if (radius !== undefined) out.radius = radius;
  if (['sm', 'md', 'lg'].includes(c?.shadow)) out.shadow = c.shadow;
  const border = cleanBorder(c?.border);
  if (border) out.border = border;
  if (c?.sticky) out.sticky = true;
  const hide = cleanHide(c?.hide);
  if (hide) out.hide = hide;
  const fs = cleanFs(c?.fs);
  if (fs) out.fs = fs;
  const r: Record<string, any> = {};
  for (const bp of ['tablet', 'phone']) {
    const span = optInt(c?.r?.[bp]?.span, 1, 12);
    if (span !== undefined) r[bp] = { span };
  }
  if (Object.keys(r).length) out.r = r;
  out.blocks = (Array.isArray(c?.blocks) ? c.blocks : []).map((b: any) => cleanBlock(b, count, true)).filter(Boolean);
  return out;
}

function cleanRow(r: any, count: { n: number }): Record<string, any> {
  const cols = (Array.isArray(r?.cols) ? r.cols : []).slice(0, MAX_COLS);
  const list = cols.length ? cols : [{}];
  const out: Record<string, any> = { id: str(r?.id, 40) || newId(8), gap: int(r?.gap, 0, 80, 24), stack: ['tablet', 'phone', 'never'].includes(r?.stack) ? r.stack : 'phone' };
  if (r?.valign && ['top', 'center', 'bottom', 'stretch'].includes(r.valign)) out.valign = r.valign;
  if (r?.rev) out.rev = true;
  const hide = cleanHide(r?.hide);
  if (hide) out.hide = hide;
  out.cols = list.map((c: any) => cleanCol(c, count, list.length));
  return out;
}

function cleanSection(s: any, count: { n: number }): Record<string, any> {
  const out: Record<string, any> = { ...s, id: str(s?.id, 40) || newId(8), type: 'section' };
  delete out.padding;
  out.name = str(s?.name, 80);
  out.width = Object.hasOwn(WIDTHS, s?.width) ? s.width : 'normal';
  out.pad_y = int(s?.pad_y, 0, 240, 64);
  out.pad_x = int(s?.pad_x, 0, 120, 20);
  if (isColor(s?.bg)) out.bg = s.bg;
  else delete out.bg;
  if (isColor(s?.color)) out.color = s.color;
  else delete out.color;
  if (s?.bg_image && safeUrl(s.bg_image) !== '#') {
    out.bg_image = str(s.bg_image, 1000);
    out.bg_overlay = int(s?.bg_overlay, 0, 90, 0);
  } else {
    delete out.bg_image;
    delete out.bg_overlay;
  }
  const border = cleanBorder(s?.border);
  if (border) out.border = border;
  else delete out.border;
  const radius = optInt(s?.radius, 0, 64);
  if (radius !== undefined) out.radius = radius;
  else delete out.radius;
  if (s?.align && ['left', 'center', 'right'].includes(s.align)) out.align = s.align;
  else delete out.align;
  cleanCommon(s ?? {}, out);
  const r: Record<string, any> = {};
  for (const bp of ['tablet', 'phone']) {
    const py = optInt(s?.r?.[bp]?.pad_y, 0, 240);
    const px = optInt(s?.r?.[bp]?.pad_x, 0, 120);
    if (py !== undefined || px !== undefined) r[bp] = { ...(py !== undefined ? { pad_y: py } : {}), ...(px !== undefined ? { pad_x: px } : {}) };
  }
  if (Object.keys(r).length) out.r = r;
  else delete out.r;
  out.rows = (Array.isArray(s?.rows) ? s.rows : []).slice(0, 24).map((r: any) => cleanRow(r, count));
  return out;
}

function cleanBlock(b: any, count: { n: number }, inColumn: boolean): Record<string, any> | null {
  if (!b || typeof b !== 'object') return null;
  if (++count.n > MAX_NODES) throw bad(`Die Seite hat zu viele Blöcke (höchstens ${MAX_NODES})`);
  if (b.type === 'section') return inColumn ? null : cleanSection(b, count);
  const out: Record<string, any> = { ...b, id: str(b.id, 40) || newId(8), type: str(b.type, 40) || 'text' };
  cleanCommon(b, out);
  return out;
}

/** Validates and normalises what the editor (or the API) sends as a page's blocks. */
export function cleanBlocks(input: unknown): Block[] {
  if (!Array.isArray(input)) throw bad('Blöcke fehlen');
  const count = { n: 0 };
  const out = input.slice(0, 200).map((b) => cleanBlock(b, count, false)).filter(Boolean) as Block[];
  if (JSON.stringify(out).length > 1_500_000) throw bad('Die Seite ist zu groß');
  return out;
}

/** Every block of a page in document order, with its parent (section → row → column → block). */
export function walkBlocks(blocks: unknown, fn: (b: Block, parent?: Block) => void, parent?: Block): void {
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== 'object') continue;
    fn(b, parent);
    if (b.type === 'section') for (const row of Array.isArray(b.rows) ? b.rows : []) for (const col of Array.isArray(row?.cols) ? row.cols : []) walkBlocks(col?.blocks, fn, b);
  }
}

/** Plain text of a page's blocks (site search, accessibility statement checks). */
export function blockText(b: Block): string {
  const parts: string[] = [];
  const take = (v: unknown) => {
    if (typeof v === 'string') parts.push(v);
  };
  for (const k of ['heading', 'subheading', 'text', 'quote', 'author', 'title', 'button_text']) take(b[k]);
  for (const it of Array.isArray(b.items) ? b.items : []) if (it && typeof it === 'object') for (const k of ['title', 'text', 'q', 'a', 'name', 'price', 'features', 'label', 'value']) take(it[k]);
  return parts.join(' ');
}
export function pageText(blocks: unknown): string {
  const out: string[] = [];
  walkBlocks(blocks, (b) => {
    if (b.type !== 'html') out.push(blockText(b));
  });
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// --- rendering ------------------------------------------------------------------------------------------------------------

export const LAYOUT_CSS = `.sec{position:relative}.sec.ov::before{content:"";position:absolute;inset:0;background:#000;opacity:var(--ov,.4);pointer-events:none}
.sin{position:relative;margin:0 auto;padding:var(--py,64px) var(--px,20px);max-width:var(--mw,1100px)}
.row{display:flex;flex-wrap:wrap;gap:var(--g,24px);align-items:flex-start}.sin>.row+.row{margin-top:var(--g,24px)}
.row.va-c{align-items:center}.row.va-b{align-items:flex-end}.row.va-s{align-items:stretch}
.col{flex:0 0 calc((100% + var(--g,24px)) * var(--s,12) / 12 - var(--g,24px) - .1px);max-width:100%;min-width:0}.col.vs-c{align-self:center}.col.vs-b{align-self:flex-end}.col.stk{position:sticky;top:16px;align-self:flex-start}
.col>.blk+.blk,.col>.blk+div,.col>div+.blk{margin-top:16px}.col>.blk:first-child{margin-top:0}
@media (max-width:1024px){.st-t>.col{--s:12}}@media (max-width:640px){.st-p>.col{--s:12}.col.stk{position:static}}`;

const spanRule = (cls: string, n: number) => `.${cls}{--s:${n}}`;

function renderSection(env: BlockEnv, s: Block): string {
  const c = cid(s.id);
  const st: string[] = [];
  const cls = ['sec', hideClassesOf(s)];
  const vars: Record<string, string> = { '--mw': WIDTHS[Object.hasOwn(WIDTHS, s.width) ? s.width : 'normal'] };
  const py = int(s.pad_y, 0, 240, 64);
  const px = int(s.pad_x, 0, 120, 20);
  const respVars: Breakpoint[] = [];
  for (const bp of ['tablet', 'phone'] as const) if (s.r?.[bp] && (s.r[bp].pad_y !== undefined || s.r[bp].pad_x !== undefined)) respVars.push(bp);
  const bgCss = colorCss(s.bg);
  if (bgCss) st.push(`background-color:${bgCss}`);
  if (s.bg_image && safeUrl(s.bg_image) !== '#') {
    st.push(`background-image:${BG_URL(s.bg_image)};background-size:cover;background-position:center`);
    if (int(s.bg_overlay, 0, 90, 0) > 0) {
      cls.push('ov');
      vars['--ov'] = String(int(s.bg_overlay, 0, 90, 0) / 100);
    }
  }
  // Text colour: the chosen one, else white/near-black by what the background needs (a dark section never has dark text).
  const hex = colorHex(s.bg, env.tokens);
  const textCss = colorCss(s.color) || (hex && !s.bg_image ? readableOn(hex) : s.bg_image && int(s.bg_overlay, 0, 90, 0) >= 40 ? '#ffffff' : '');
  if (textCss) st.push(`color:${textCss}`);
  const btnVars = onBg(env, s.bg);
  if (btnVars) st.push(btnVars);
  const b = s.border;
  if (b && int(b.w, 0, 12, 0) > 0) st.push(`border:${int(b.w, 0, 12, 0)}px ${BORDER_STYLES.includes(b.style) ? b.style : 'solid'} ${colorCss(b.color, 'var(--line)')}`);
  if (s.radius !== undefined && s.radius !== '') st.push(`border-radius:${int(s.radius, 0, 64, 0)}px;overflow:hidden`);
  if (['sm', 'md', 'lg'].includes(s.shadow)) st.push(`box-shadow:var(--sh-${s.shadow})`);
  if (['left', 'center', 'right'].includes(s.align)) st.push(`text-align:${s.align}`);
  // Padding: a variable on the element, or – when tablet/phone differ – rules per device.
  if (respVars.length) {
    env.rules.add('desktop', `.${c}{--py:${py}px;--px:${px}px}`);
    for (const bp of respVars) env.rules.add(bp, `.${c}{${s.r[bp].pad_y !== undefined ? `--py:${int(s.r[bp].pad_y, 0, 240, py)}px;` : ''}${s.r[bp].pad_x !== undefined ? `--px:${int(s.r[bp].pad_x, 0, 120, px)}px` : ''}}`.replace(';}', '}'));
    cls.push(c);
  } else {
    vars['--py'] = `${py}px`;
    vars['--px'] = `${px}px`;
  }
  const fz = fsClass(env, s.id, s.fs);
  if (fz) cls.push(fz);
  const anchor = /^[a-z][a-z0-9_-]{0,39}$/.test(String(s.anchor ?? '')) ? ` id="${s.anchor}"` : '';
  const label = s.name ? ` aria-label="${escapeHtml(String(s.name).slice(0, 80))}"` : '';
  const style = [...Object.entries(vars).map(([k, v]) => `${k}:${v}`), ...st].join(';');
  const rows = (Array.isArray(s.rows) ? s.rows : []).map((r: any) => renderRow(env, r)).join('');
  return `<section class="${cls.filter(Boolean).join(' ')}"${anchor}${label} style="${escapeHtml(style)}"><div class="sin">${rows}</div></section>`;
}

const hideClassesOf = (x: Block) => hideClasses(x.hide);
function renderRow(env: BlockEnv, r: any): string {
  const cols: any[] = (Array.isArray(r?.cols) ? r.cols : []).slice(0, MAX_COLS);
  if (!cols.length) return '';
  const c = cid(r.id);
  const cls = ['row', r.stack === 'tablet' ? 'st-t' : r.stack === 'never' ? '' : 'st-p', hideClassesOf(r)];
  const va = { center: 'va-c', bottom: 'va-b', stretch: 'va-s' }[String(r.valign) as 'center'];
  if (va) cls.push(va);
  const stacked = r.stack === 'tablet' ? 'tablet' : r.stack === 'never' ? null : 'phone';
  if (r.rev && stacked) {
    cls.push(c);
    // Stacked rows can show their columns in reverse order (picture above text on phones, text first on desktop).
    cols.forEach((_x, i) => env.rules.add(stacked, `.${c}.${stacked === 'tablet' ? 'st-t' : 'st-p'}>.col:nth-child(${i + 1}){order:${cols.length - i}}`));
  }
  const html = cols.map((col) => renderCol(env, col, cols.length)).join('');
  return `<div class="${cls.filter(Boolean).join(' ')}" style="--g:${int(r.gap, 0, 80, 24)}px">${html}</div>`;
}

function renderCol(env: BlockEnv, col: any, n: number): string {
  const span = int(col?.span, 1, 12, Math.max(1, Math.floor(12 / n)));
  const cls = ['col', `s${span}`, hideClassesOf(col)];
  env.rules.once(`s${span}`, 'desktop', spanRule(`s${span}`, span));
  for (const bp of ['tablet', 'phone'] as const) {
    const o = optInt(col?.r?.[bp]?.span, 1, 12);
    if (o === undefined) continue;
    const k = `${bp === 'tablet' ? 't' : 'p'}${o}`;
    cls.push(k);
    // Same weight as the stacking rule, printed after it: an explicit width on this device wins.
    env.rules.once(k, bp, `.row .${k}{--s:${o}}`);
  }
  if (col?.valign === 'center') cls.push('vs-c');
  if (col?.valign === 'bottom') cls.push('vs-b');
  if (col?.sticky) cls.push('stk');
  const st: string[] = [];
  const bg = colorCss(col?.bg);
  if (bg) st.push(`background:${bg}`);
  const hex = colorHex(col?.bg, env.tokens);
  if (hex) st.push(`color:${readableOn(hex)}`);
  const colVars = onBg(env, col?.bg);
  if (colVars) st.push(colVars);
  if (col?.pad !== undefined && col?.pad !== '') st.push(`padding:${int(col.pad, 0, 80, 0)}px`);
  if (col?.radius !== undefined && col?.radius !== '') st.push(`border-radius:${int(col.radius, 0, 64, 0)}px`);
  if (['sm', 'md', 'lg'].includes(col?.shadow)) st.push(`box-shadow:var(--sh-${col.shadow})`);
  if (['left', 'center', 'right'].includes(col?.align)) st.push(`text-align:${col.align}`);
  const b = col?.border;
  if (b && int(b.w, 0, 12, 0) > 0) st.push(`border:${int(b.w, 0, 12, 0)}px ${BORDER_STYLES.includes(b.style) ? b.style : 'solid'} ${colorCss(b.color, 'var(--line)')}`);
  const fz = fsClass(env, col?.id, col?.fs);
  if (fz) cls.push(fz);
  return `<div class="${cls.filter(Boolean).join(' ')}"${st.length ? ` style="${escapeHtml(st.join(';'))}"` : ''}>${renderBlocks(env, col?.blocks ?? [], { bare: true })}</div>`;
}

export const SECTION_BLOCK: BlockDef = { type: 'section', css: LAYOUT_CSS, render: (env, b) => renderSection(env, b) };

/** Adds the layout renderer to a registry (done once per app by the page renderer). */
export function registerLayout(reg: BlockRegistry) {
  if (!reg.has('section')) reg.set('section', SECTION_BLOCK);
}

// --- small constructors (templates, tests, the editor's "new section") --------------------------------------------------------

export function newSection(cols: number[], blocks: Block[][] = [], extra: Record<string, any> = {}): Block {
  const spans = cols.length ? cols : [12];
  return {
    id: newId(8),
    type: 'section',
    ...extra,
    rows: [{ id: newId(8), gap: 24, stack: 'phone', cols: spans.map((span, i) => ({ id: newId(8), span, blocks: blocks[i] ?? [] })) }],
  } as Block;
}
