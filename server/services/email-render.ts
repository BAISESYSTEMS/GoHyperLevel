/**
 * Drag-and-drop email designs → email HTML + text/plain.
 *
 * Pure code without imports: the server renders designs on save (so API, MCP and workflows always
 * send the finished HTML) and the browser uses the same functions for the live preview.
 *
 * Output rules: table layout with inline styles, Outlook (MSO) buttons in VML, columns stack on
 * phones via one small media query, dark-mode hints, escaped user text, only http(s)/mailto/tel
 * links, and merge fields ({{contact.first_name}}) left in place for personalisation at send time.
 */

export type Align = 'left' | 'center' | 'right';
export type BlockType = 'heading' | 'text' | 'image' | 'button' | 'divider' | 'spacer' | 'social' | 'video' | 'html' | 'footer';

export interface BlockStyle {
  paddingY?: number;
  paddingX?: number;
  align?: Align;
  /** Text colour ('' = global text colour). */
  color?: string;
  /** Background of this block ('' = transparent). */
  background?: string;
  fontSize?: number;
}

export interface Block {
  id: string;
  type: BlockType;
  props: Record<string, any>;
  style: BlockStyle;
}

export interface Column {
  id: string;
  blocks: Block[];
}

export interface Section {
  id: string;
  columns: Column[];
  /** Column widths in percent (sum 100), one per column. */
  widths: number[];
  style: { background?: string; paddingY?: number; paddingX?: number };
}

export interface EmailSettings {
  width: number;
  background: string;
  contentBackground: string;
  fontFamily: string;
  textColor: string;
  linkColor: string;
  fontSize: number;
  preheader: string;
}

export interface EmailDesign {
  version: 1;
  settings: EmailSettings;
  sections: Section[];
}

export interface RenderOptions {
  /** <title> of the document (usually the subject). */
  title?: string;
  /** Add a small legal footer (company, address, unsubscribe) when the design has no footer block. Default true. */
  autoFooter?: boolean;
  /** Editor canvas: show grey placeholders for empty images/buttons instead of leaving them out. */
  placeholders?: boolean;
}

/** Stands for the personal unsubscribe link; the mailer swaps it per recipient. */
export const UNSUBSCRIBE_TOKEN = '%%unsubscribe_url%%';
/** Stands for the personal link to the preference centre (Einwilligung → Einstellungsseite); the mailer swaps it per recipient. */
export const PREFERENCES_TOKEN = '%%preferences_url%%';

export const BLOCK_TYPES: BlockType[] = ['heading', 'text', 'image', 'button', 'divider', 'spacer', 'social', 'video', 'html', 'footer'];

export const FONTS: [string, string][] = [
  ['Arial, Helvetica, sans-serif', 'Arial'],
  ['Helvetica, Arial, sans-serif', 'Helvetica'],
  ['Verdana, Geneva, sans-serif', 'Verdana'],
  ['Tahoma, Verdana, sans-serif', 'Tahoma'],
  ["'Trebuchet MS', Arial, sans-serif", 'Trebuchet'],
  ['Georgia, Times, serif', 'Georgia'],
  ["'Times New Roman', Times, serif", 'Times'],
  ["'Courier New', Courier, monospace", 'Courier'],
];

export const SOCIAL_NETWORKS: Record<string, { label: string; short: string; color: string }> = {
  facebook: { label: 'Facebook', short: 'f', color: '#1877f2' },
  instagram: { label: 'Instagram', short: 'IG', color: '#e4405f' },
  linkedin: { label: 'LinkedIn', short: 'in', color: '#0a66c2' },
  x: { label: 'X', short: 'X', color: '#111111' },
  youtube: { label: 'YouTube', short: '▶', color: '#ff0000' },
  tiktok: { label: 'TikTok', short: 'TT', color: '#111111' },
  whatsapp: { label: 'WhatsApp', short: 'WA', color: '#25d366' },
  website: { label: 'Website', short: 'www', color: '#4b5563' },
  email: { label: 'E-Mail', short: '@', color: '#4b5563' },
};

export const LAYOUTS: Record<number, number[][]> = {
  1: [[100]],
  2: [[50, 50], [33, 67], [67, 33]],
  3: [[33, 34, 33]],
};

// --- small helpers ----------------------------------------------------------------------------

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const clamp = (v: unknown, min: number, max: number, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
const text = (v: unknown, max = 2000) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)).slice(0, max);

/** Only plain colours get into style attributes (no CSS injection). */
export function safeColor(v: unknown, fallback = ''): string {
  const s = String(v ?? '').trim();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s)) return s.toLowerCase();
  if (s === 'transparent') return s;
  return fallback;
}

/**
 * Links may only be http(s), mailto or tel (merge fields inside are fine, e.g.
 * https://x.de/?id={{contact.id}}). {{unsubscribe_url}} becomes the per-recipient unsubscribe link.
 */
export function safeUrl(raw: unknown, kind: 'link' | 'image' = 'link'): string {
  const u = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!u) return '';
  if (u === UNSUBSCRIBE_TOKEN || /^\{\{\s*unsubscribe_url\s*\}\}$/.test(u)) return kind === 'link' ? UNSUBSCRIBE_TOKEN : '';
  if (u === PREFERENCES_TOKEN || /^\{\{\s*preferences_url\s*\}\}$/.test(u)) return kind === 'link' ? PREFERENCES_TOKEN : '';
  // The link a workflow trigger brings along (abandoned checkout: back to the buy page) – only these exact fields, never free event data.
  if (/^\{\{\s*event\.(recovery_url|checkout_url)\s*\}\}$/.test(u)) return kind === 'link' ? u : '';
  const ok = kind === 'image' ? /^https?:\/\/[^\s]/i.test(u) : /^(https?:\/\/[^\s]|mailto:[^\s]|tel:[+\d(])/i.test(u);
  if (ok) return u.replace(/ /g, '%20');
  if (kind === 'link' && /^www\.[^\s/]+\.[^\s]+$/i.test(u)) return `https://${u}`;
  return '';
}

const rid = () => Math.random().toString(36).slice(2, 10);
const cleanId = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : rid());

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) return 1;
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// --- defaults ---------------------------------------------------------------------------------

export const DEFAULT_SETTINGS: EmailSettings = {
  width: 600,
  background: '#f3f4f6',
  contentBackground: '#ffffff',
  fontFamily: 'Arial, Helvetica, sans-serif',
  textColor: '#1f2937',
  linkColor: '#2563eb',
  fontSize: 16,
  preheader: '',
};

export function blockDefaults(type: BlockType): { props: Record<string, any>; style: BlockStyle } {
  const style: BlockStyle = { paddingY: 10, paddingX: 24, align: 'left', color: '', background: '' };
  switch (type) {
    case 'heading':
      return { props: { text: 'Überschrift', level: 1 }, style };
    case 'text':
      return { props: { text: 'Hallo {{contact.first_name|du}},\n\nhier steht dein Text. **Fett**, *kursiv* und [Links](https://example.com) gehen über die Werkzeugleiste.' }, style };
    case 'image':
      return { props: { src: '', alt: '', href: '', width: 0 }, style: { ...style, align: 'center' } };
    case 'button':
      return { props: { label: 'Jetzt ansehen', href: 'https://', background: '#2563eb', textColor: '#ffffff', radius: 6, fullWidth: false }, style: { ...style, align: 'center', paddingY: 14 } };
    case 'divider':
      return { props: { color: '#e5e7eb', thickness: 1, width: 100 }, style: { ...style, paddingY: 14 } };
    case 'spacer':
      return { props: { height: 24 }, style: { ...style, paddingY: 0, paddingX: 0 } };
    case 'social':
      return { props: { variant: 'icons', items: [{ network: 'facebook', url: 'https://facebook.com/' }, { network: 'instagram', url: 'https://instagram.com/' }, { network: 'linkedin', url: 'https://linkedin.com/' }] }, style: { ...style, align: 'center' } };
    case 'video':
      return { props: { url: '', thumbnail: '', alt: 'Video ansehen', caption: '▶ Video ansehen' }, style: { ...style, align: 'center' } };
    case 'html':
      return { props: { html: '<p style="margin:0">Eigenes HTML</p>' }, style };
    case 'footer':
      return {
        props: { company: '{{location.name}}', address: '{{location.address}}', text: 'Du erhältst diese E-Mail, weil du dich bei uns angemeldet hast.', unsubscribeLabel: 'Abmelden' },
        style: { ...style, align: 'center', color: '#6b7280', fontSize: 12, paddingY: 20 },
      };
  }
}

export function newBlock(type: BlockType, props: Record<string, any> = {}, style: BlockStyle = {}): Block {
  const d = blockDefaults(type);
  return { id: rid(), type, props: { ...d.props, ...props }, style: { ...d.style, ...style } };
}

export function newSection(columns = 1, blocks: Block[][] = [], widths?: number[]): Section {
  const n = Math.min(3, Math.max(1, columns));
  return {
    id: rid(),
    columns: Array.from({ length: n }, (_, i) => ({ id: rid(), blocks: blocks[i] ?? [] })),
    widths: widths && widths.length === n ? widths : LAYOUTS[n][0],
    style: { background: '', paddingY: 0, paddingX: 0 },
  };
}

export function emptyDesign(): EmailDesign {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, sections: [] };
}

/** Fresh ids for a copied section (reusable sections, duplicate). */
export function cloneSection(s: Section): Section {
  return { ...JSON.parse(JSON.stringify(s)), id: rid(), columns: s.columns.map((c) => ({ id: rid(), blocks: c.blocks.map((b) => ({ ...JSON.parse(JSON.stringify(b)), id: rid() })) })) };
}

// --- validation -------------------------------------------------------------------------------

function cleanStyle(s: any, def: BlockStyle): BlockStyle {
  s = s && typeof s === 'object' ? s : {};
  return {
    paddingY: clamp(s.paddingY, 0, 120, def.paddingY ?? 10),
    paddingX: clamp(s.paddingX, 0, 120, def.paddingX ?? 24),
    align: (['left', 'center', 'right'] as const).includes(s.align) ? s.align : def.align ?? 'left',
    color: safeColor(s.color, def.color ?? ''),
    background: safeColor(s.background, def.background ?? ''),
    ...(s.fontSize !== undefined && s.fontSize !== '' && s.fontSize !== null ? { fontSize: clamp(s.fontSize, 8, 72, 16) } : def.fontSize ? { fontSize: def.fontSize } : {}),
  };
}

function cleanProps(type: BlockType, p: any): Record<string, any> {
  p = p && typeof p === 'object' ? p : {};
  const d = blockDefaults(type).props;
  switch (type) {
    case 'heading':
      return { text: text(p.text ?? d.text, 500), level: [1, 2, 3].includes(Number(p.level)) ? Number(p.level) : 1 };
    case 'text':
      return { text: text(p.text, 20_000) };
    case 'image':
      return { src: text(p.src, 2000), alt: text(p.alt, 300), href: text(p.href, 2000), width: clamp(p.width, 0, 1200, 0) };
    case 'button':
      return {
        label: text(p.label ?? d.label, 120),
        href: text(p.href, 2000),
        background: safeColor(p.background, d.background),
        textColor: safeColor(p.textColor, d.textColor),
        radius: clamp(p.radius, 0, 40, d.radius),
        fullWidth: !!p.fullWidth,
      };
    case 'divider':
      return { color: safeColor(p.color, d.color), thickness: clamp(p.thickness, 1, 10, 1), width: clamp(p.width, 10, 100, 100) };
    case 'spacer':
      return { height: clamp(p.height, 4, 200, 24) };
    case 'social':
      return {
        variant: p.variant === 'text' ? 'text' : 'icons',
        items: (Array.isArray(p.items) ? p.items : [])
          .slice(0, 12)
          .filter((i: any) => i && SOCIAL_NETWORKS[i.network])
          .map((i: any) => ({ network: String(i.network), url: text(i.url, 2000) })),
      };
    case 'video':
      return { url: text(p.url, 2000), thumbnail: text(p.thumbnail, 2000), alt: text(p.alt, 300), caption: text(p.caption, 200) };
    case 'html':
      return { html: text(p.html, 50_000) };
    case 'footer':
      return { company: text(p.company, 300), address: text(p.address, 500), text: text(p.text, 1000), unsubscribeLabel: text(p.unsubscribeLabel, 80) || 'Abmelden', ...(text(p.preferencesLabel, 80).trim() ? { preferencesLabel: text(p.preferencesLabel, 80).trim() } : {}) };
  }
}

/**
 * Checks and cleans a design from the browser or the API. Throws an Error with a German message
 * when it cannot be used; unknown keys are dropped and numbers/colours are clamped.
 */
export function normalizeDesign(input: unknown): EmailDesign {
  let d: any = input;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      throw new Error('Design ist kein gültiges JSON');
    }
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Design fehlt oder ist ungültig');
  const s = d.settings && typeof d.settings === 'object' ? d.settings : {};
  const settings: EmailSettings = {
    width: clamp(s.width, 320, 900, DEFAULT_SETTINGS.width),
    background: safeColor(s.background, DEFAULT_SETTINGS.background),
    contentBackground: safeColor(s.contentBackground, DEFAULT_SETTINGS.contentBackground),
    fontFamily: FONTS.some(([f]) => f === s.fontFamily) ? s.fontFamily : DEFAULT_SETTINGS.fontFamily,
    textColor: safeColor(s.textColor, DEFAULT_SETTINGS.textColor),
    linkColor: safeColor(s.linkColor, DEFAULT_SETTINGS.linkColor),
    fontSize: clamp(s.fontSize, 10, 24, DEFAULT_SETTINGS.fontSize),
    preheader: text(s.preheader, 250),
  };
  const rawSections = Array.isArray(d.sections) ? d.sections : [];
  if (rawSections.length > 100) throw new Error('Höchstens 100 Abschnitte');
  let blockCount = 0;
  const sections: Section[] = rawSections.map((sec: any) => {
    const cols = Array.isArray(sec?.columns) ? sec.columns : [];
    if (cols.length < 1 || cols.length > 3) throw new Error('Ein Abschnitt hat 1 bis 3 Spalten');
    const columns: Column[] = cols.map((col: any) => ({
      id: cleanId(col?.id),
      blocks: (Array.isArray(col?.blocks) ? col.blocks : []).map((b: any) => {
        if (!BLOCK_TYPES.includes(b?.type)) throw new Error(`Unbekannter Block: ${String(b?.type).slice(0, 40)}`);
        if (++blockCount > 400) throw new Error('Höchstens 400 Blöcke');
        const type = b.type as BlockType;
        return { id: cleanId(b.id), type, props: cleanProps(type, b.props), style: cleanStyle(b.style, blockDefaults(type).style) };
      }),
    }));
    let widths: number[] = Array.isArray(sec.widths) && sec.widths.length === columns.length ? sec.widths.map((w: unknown) => clamp(w, 10, 100, 0)) : LAYOUTS[columns.length][0];
    const sum = widths.reduce((a, b) => a + b, 0);
    if (!sum || widths.some((w) => !w)) widths = LAYOUTS[columns.length][0];
    else if (sum !== 100) widths = widths.map((w) => Math.round((w / sum) * 100));
    const st = sec.style && typeof sec.style === 'object' ? sec.style : {};
    return { id: cleanId(sec.id), columns, widths, style: { background: safeColor(st.background, ''), paddingY: clamp(st.paddingY, 0, 120, 0), paddingX: clamp(st.paddingX, 0, 120, 0) } };
  });
  return { version: 1, settings, sections };
}

export const hasFooter = (d: EmailDesign) => d.sections.some((s) => s.columns.some((c) => c.blocks.some((b) => b.type === 'footer')));

export interface DesignIssue {
  /** 'error' blocks sending a campaign, 'warning' is a hint. */
  level: 'error' | 'warning';
  text: string;
}

/** Problems of a design (German, for the editor and the API). */
export function designIssues(d: EmailDesign, opts: { campaign?: boolean } = {}): DesignIssue[] {
  const out: DesignIssue[] = [];
  const err = (text: string) => out.push({ level: 'error', text });
  const warn = (text: string) => out.push({ level: 'warning', text });
  const blocks = d.sections.flatMap((s) => s.columns.flatMap((c) => c.blocks));
  if (!blocks.length) err('Die E-Mail ist leer');
  const footer = blocks.find((b) => b.type === 'footer');
  if (opts.campaign) {
    if (!footer) err('Kampagnen brauchen einen Footer-Block mit Abmeldelink und Firmenadresse');
    else if (!String(footer.props.address ?? '').trim()) err('Im Footer fehlt die Firmenadresse');
  } else if (!footer && blocks.length) warn('Ohne Footer-Block hängen wir automatisch Firmenname, Adresse und Abmeldelink an');
  for (const b of blocks) {
    if (b.type === 'button' && !safeUrl(b.props.href)) err(`Button „${b.props.label}“: Link fehlt oder ist ungültig (https://, mailto: oder tel:)`);
    if (b.type === 'image' && b.props.src && !safeUrl(b.props.src, 'image')) err('Bild: Adresse muss mit https:// beginnen');
    if (b.type === 'image' && b.props.href && !safeUrl(b.props.href)) err('Bild-Link muss mit https://, mailto: oder tel: beginnen');
    if (b.type === 'image' && !b.props.src) warn('Ein Bild-Block hat noch kein Bild (wird nicht mitgesendet)');
    if (b.type === 'image' && b.props.src && !String(b.props.alt ?? '').trim()) warn('Bild ohne Alternativtext (wichtig, wenn Bilder blockiert sind)');
    if (b.type === 'video' && !safeUrl(b.props.url)) err('Video: Link fehlt oder ist ungültig');
    if (b.type === 'social' && (b.props.items as { url: string }[]).some((i) => !safeUrl(i.url))) warn('Social-Links ohne gültige Adresse werden weggelassen');
  }
  if (d.settings.preheader.length === 0) warn('Tipp: Ein Vorschautext (Preheader) erscheint im Posteingang neben dem Betreff');
  return out;
}

// --- inline text: **bold**, *italic*, [label](url), bare links ------------------------------

function emphasis(escaped: string): string {
  return escaped.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
}

/** [label](url) | merge field | bare link (merge fields inside a link are fine). */
const INLINE_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)|(\{\{[^{}\n]*\}\})|((?:https?:\/\/|www\.)(?:\{\{[^{}\s]*\}\}|[^\s<>()"{}])*(?:\{\{[^{}\s]*\}\}|[^\s<>()".,;:!?'{}]))/g;

function inline(raw: string, linkColor: string): string {
  // Links and merge fields become tokens first, so **bold {{contact.first_name}}** still works
  // and nothing is ever linked or formatted inside a merge field.
  const tokens: string[] = [];
  const keep = (html: string) => `\u0000${tokens.push(html) - 1}\u0000`;
  const marked = String(raw ?? '')
    .replace(/\u0000/g, '')
    .replace(INLINE_RE, (_m, label: string | undefined, url: string, field: string | undefined, bare: string | undefined) => {
      if (field) return keep(escapeHtml(field));
      const href = safeUrl(label !== undefined ? url : bare);
      const inner = label !== undefined ? emphasis(escapeHtml(label)) : escapeHtml(bare);
      return keep(href ? `<a href="${escapeHtml(href)}" target="_blank" style="color:${linkColor};text-decoration:underline;">${inner}</a>` : inner);
    });
  return emphasis(escapeHtml(marked)).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => tokens[Number(i)]);
}

function inlinePlain(raw: string): string {
  return raw
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, l: string, u: string) => (safeUrl(u) ? `${l} (${safeUrl(u)})` : l))
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1$2');
}

type Para = { kind: 'p' | 'ul' | 'ol'; lines: string[] };

function paragraphs(src: string): Para[] {
  const out: Para[] = [];
  let cur: Para | null = null;
  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const kind: Para['kind'] | null = !line.trim() ? null : ul ? 'ul' : ol ? 'ol' : 'p';
    if (!kind) {
      cur = null;
      continue;
    }
    const content = ul ? ul[1] : ol ? ol[1] : line;
    if (!cur || cur.kind !== kind) {
      cur = { kind, lines: [] };
      out.push(cur);
    }
    cur.lines.push(content);
  }
  return out;
}

export function richTextHtml(src: string, linkColor: string, pStyle = ''): string {
  const paras = paragraphs(src);
  return paras
    .map((p, i) => {
      const mb = i === paras.length - 1 ? '0' : '12px';
      if (p.kind === 'p') return `<p style="margin:0 0 ${mb};${pStyle}">${p.lines.map((l) => inline(l, linkColor)).join('<br>')}</p>`;
      const tag = p.kind;
      return `<${tag} style="margin:0 0 ${mb};padding-left:24px;${pStyle}">${p.lines.map((l) => `<li style="margin:0 0 4px;">${inline(l, linkColor)}</li>`).join('')}</${tag}>`;
    })
    .join('');
}

function richTextPlain(src: string): string {
  return paragraphs(src)
    .map((p) => (p.kind === 'p' ? p.lines.map(inlinePlain).join('\n') : p.lines.map((l, i) => `${p.kind === 'ul' ? '-' : `${i + 1}.`} ${inlinePlain(l)}`).join('\n')))
    .join('\n\n');
}

// --- HTML block hygiene and HTML → text -----------------------------------------------------

/** The HTML block is the user's own markup, but scripts, frames, forms and handlers never go out. */
export function cleanHtmlBlock(html: string): string {
  return String(html ?? '')
    .replace(/<!--(?!\[if)[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|form|frameset|textarea|select|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|form|frameset|frame|input|button|textarea|select|meta|link|base|svg|math)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\b(href|src|background|action|formaction|xlink:href|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"']+))/gi, (m, attr: string, _q, dq?: string, sq?: string, bare?: string) => {
      const v = decodeEntities(dq ?? sq ?? bare ?? '').replace(/[\s\u0000-\u001f]/g, '');
      const scheme = v.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
      return scheme && !['http', 'https', 'mailto', 'tel', 'cid'].includes(scheme) ? `${attr}="#"` : m;
    });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', ndash: '–', mdash: '—', zwnj: '', shy: '' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (code === 847 || code === 8199 || code === 65279 || code === 8204) return '';
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Readable plain text from (email) HTML: links as "text (url)", lists with dashes, no CSS. */
export function htmlToText(html: string): string {
  let s = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title|xml)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<div[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, '');
  s = s.replace(/<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const label = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim();
    const url = decodeEntities(href).trim();
    if (!url || url === '#' || url.startsWith('javascript')) return label;
    if (!label || label === url || label === url.replace(/^mailto:|^tel:/, '')) return url;
    return `${label} (${url})`;
  });
  s = s
    .replace(/<img\b[^>]*alt\s*=\s*"([^"]+)"[^>]*>/gi, (_m, alt: string) => `[${alt}]`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote)>/gi, '\n\n')
    .replace(/<hr\b[^>]*>/gi, '\n----------\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- rendering --------------------------------------------------------------------------------

interface Ctx {
  s: EmailSettings;
  /** Dark-mode classes only make sense on a light canvas. */
  dark: boolean;
  placeholders: boolean;
}

function youtubeId(url: string): string {
  return url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/)?.[1] ?? '';
}

export function videoThumbnail(url: string, thumbnail = ''): string {
  if (safeUrl(thumbnail, 'image')) return safeUrl(thumbnail, 'image');
  const yt = youtubeId(url);
  return yt ? `https://img.youtube.com/vi/${yt}/hqdefault.jpg` : '';
}

const placeholderBox = (label: string, height = 120) =>
  `<div style="font:14px Arial,sans-serif;background:#e5e7eb;color:#6b7280;border:1px dashed #9ca3af;border-radius:6px;height:${height}px;line-height:${height}px;text-align:center;">${escapeHtml(label)}</div>`;

function imgTag(src: string, alt: string, width: number, align: Align, extra = '') {
  const margin = align === 'center' ? '0 auto' : align === 'right' ? '0 0 0 auto' : '0';
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${width}" class="pg-img" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none;margin:${margin};${extra}">`;
}

/** One block as a table row. `inner` is the usable width in px (for Outlook images/buttons). */
function renderBlock(b: Block, ctx: Ctx, inner: number): string {
  const { s } = ctx;
  const st = b.style;
  const align = st.align ?? 'left';
  const px = st.paddingX ?? 24;
  const py = st.paddingY ?? 10;
  const width = Math.max(40, inner - px * 2);
  const color = st.color || s.textColor;
  const fontSize = st.fontSize ?? s.fontSize;
  const bg = st.background ? `background-color:${st.background};` : '';
  // Dark mode flips default and dark text to light; light custom colours (white on a coloured block) stay.
  const txtClass = ctx.dark && !st.background && (!st.color || luminance(st.color) < 0.5) ? ' class="pg-txt"' : '';
  const td = (content: string, extra = '', cls = txtClass) =>
    `<tr><td${cls} align="${align}" style="padding:${py}px ${px}px;text-align:${align};${bg}${extra}">${content}</td></tr>`;
  const font = `font-family:${s.fontFamily};`;
  const p = b.props;

  switch (b.type) {
    case 'heading': {
      const size = st.fontSize ?? (p.level === 1 ? 28 : p.level === 2 ? 22 : 18);
      return td(`<h${p.level} style="margin:0;${font}font-size:${size}px;line-height:1.25;font-weight:700;color:${color};">${inline(p.text, s.linkColor)}</h${p.level}>`);
    }
    case 'text':
      return td(richTextHtml(p.text, s.linkColor), `${font}font-size:${fontSize}px;line-height:1.6;color:${color};`);
    case 'image': {
      const src = safeUrl(p.src, 'image');
      if (!src) return ctx.placeholders ? td(placeholderBox('Bild wählen'), '', '') : '';
      const w = p.width ? Math.min(p.width, width) : width;
      const img = imgTag(src, p.alt, w, align);
      const href = safeUrl(p.href);
      return td(href ? `<a href="${escapeHtml(href)}" target="_blank" style="text-decoration:none;">${img}</a>` : img, 'font-size:0;line-height:0;', '');
    }
    case 'button': {
      const href = safeUrl(p.href);
      const label = escapeHtml(p.label || 'Button');
      const size = st.fontSize ?? 16;
      const height = Math.round(size * 1.2 + 28);
      const btnWidth = p.fullWidth ? width : Math.min(width, Math.round(String(p.label).length * size * 0.62 + 56));
      const common = `background-color:${p.background};color:${p.textColor};${font}font-size:${size}px;font-weight:700;line-height:1.2;text-decoration:none;border-radius:${p.radius}px;padding:14px 28px;`;
      const shape = p.fullWidth ? 'display:block;text-align:center;' : 'display:inline-block;';
      if (!href) return td(`<span style="${common}${shape}">${label}</span>`, '', '');
      const vml = `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${escapeHtml(href)}" style="height:${height}px;v-text-anchor:middle;width:${btnWidth}px;" arcsize="${Math.min(50, Math.round((p.radius / height) * 100))}%" strokecolor="${p.background}" fillcolor="${p.background}"><w:anchorlock/><center style="color:${p.textColor};${font}font-size:${size}px;font-weight:bold;">${label}</center></v:roundrect><![endif]-->`;
      const a = `<!--[if !mso]><!--><a href="${escapeHtml(href)}" target="_blank" style="${common}${shape}mso-hide:all;">${label}</a><!--<![endif]-->`;
      return td(vml + a, '', '');
    }
    case 'divider':
      return td(
        `<table role="presentation" width="${p.width}%" align="${align}" cellpadding="0" cellspacing="0" border="0" style="width:${p.width}%;"><tr><td class="pg-hr" style="border-top:${p.thickness}px solid ${p.color};font-size:0;line-height:0;height:0;">&nbsp;</td></tr></table>`,
        '',
        '',
      );
    case 'spacer':
      return `<tr><td style="height:${p.height}px;line-height:${p.height}px;font-size:0;${bg}">&nbsp;</td></tr>`;
    case 'social': {
      const items = (p.items as { network: string; url: string }[]).map((i) => ({ ...i, href: safeUrl(i.url), n: SOCIAL_NETWORKS[i.network] })).filter((i) => i.href && i.n);
      if (!items.length) return ctx.placeholders ? td(placeholderBox('Social-Links eintragen', 40), '', '') : '';
      const html =
        p.variant === 'text'
          ? items.map((i) => `<a href="${escapeHtml(i.href)}" target="_blank" style="color:${s.linkColor};text-decoration:underline;${font}font-size:${fontSize}px;">${i.n.label}</a>`).join(' &nbsp;·&nbsp; ')
          : items
              .map(
                (i) =>
                  `<a href="${escapeHtml(i.href)}" target="_blank" title="${i.n.label}" style="display:inline-block;width:34px;height:34px;line-height:34px;border-radius:17px;background-color:${i.n.color};color:#ffffff;font-family:Arial,sans-serif;font-size:${i.n.short.length > 2 ? 10 : 13}px;font-weight:700;text-align:center;text-decoration:none;margin:0 4px;">${escapeHtml(i.n.short)}</a>`,
              )
              .join('');
      return td(html, '', p.variant === 'text' ? txtClass : '');
    }
    case 'video': {
      const href = safeUrl(p.url);
      const thumb = videoThumbnail(p.url, p.thumbnail);
      if (!thumb) return ctx.placeholders ? td(placeholderBox('▶ Video-Link eintragen'), '', '') : href ? td(`<a href="${escapeHtml(href)}" target="_blank" style="color:${s.linkColor};${font}">${escapeHtml(p.caption || p.alt || href)}</a>`) : '';
      const img = imgTag(thumb, p.alt || 'Video ansehen', width, align, 'border-radius:6px;');
      const caption = p.caption ? `<p style="margin:8px 0 0;${font}font-size:14px;font-weight:700;"><a href="${escapeHtml(href)}" target="_blank" style="color:${s.linkColor};text-decoration:none;">${escapeHtml(p.caption)}</a></p>` : '';
      return td(href ? `<a href="${escapeHtml(href)}" target="_blank" style="text-decoration:none;">${img}</a>${caption}` : img, '', '');
    }
    case 'html':
      return td(cleanHtmlBlock(p.html), `${font}font-size:${fontSize}px;line-height:1.5;color:${color};`, '');
    case 'footer': {
      const fc = st.color || '#6b7280';
      const cls = ctx.dark && !st.background ? ' class="pg-muted"' : '';
      const lines = [p.company && `<strong>${escapeHtml(p.company)}</strong>`, p.address && escapeHtml(p.address).replace(/\n/g, '<br>'), p.text && inline(p.text, fc)].filter(Boolean);
      const prefs = p.preferencesLabel ? `<a href="${PREFERENCES_TOKEN}" target="_blank" style="color:${fc};text-decoration:underline;">${escapeHtml(p.preferencesLabel)}</a> · ` : '';
      const unsub = `${prefs}<a href="${UNSUBSCRIBE_TOKEN}" target="_blank" style="color:${fc};text-decoration:underline;">${escapeHtml(p.unsubscribeLabel || 'Abmelden')}</a>`;
      return td(
        [...lines, unsub].map((l, i, all) => `<p style="margin:0 0 ${i === all.length - 1 ? 0 : 6}px;">${l}</p>`).join(''),
        `${font}font-size:${st.fontSize ?? 12}px;line-height:1.5;color:${fc};`,
        cls,
      );
    }
  }
}

function renderSection(sec: Section, ctx: Ctx): string {
  const { s } = ctx;
  const st = sec.style;
  const sectionInner = s.width - (st.paddingX ?? 0) * 2;
  const bg = st.background ? `background-color:${st.background};` : '';
  const multi = sec.columns.length > 1;
  // On a coloured section the text keeps its colours in dark mode too.
  const bctx = st.background ? { ...ctx, dark: false } : ctx;
  const cols = sec.columns
    .map((c, i) => {
      const w = sec.widths[i] ?? Math.round(100 / sec.columns.length);
      const inner = Math.round((sectionInner * w) / 100);
      const rows = c.blocks.map((b) => renderBlock(b, bctx, inner)).join('');
      const body = rows || (ctx.placeholders ? `<tr><td style="padding:10px;">${placeholderBox('Block hierher ziehen', 60)}</td></tr>` : '<tr><td style="font-size:0;line-height:0;">&nbsp;</td></tr>');
      return `<td${multi ? ' class="pg-col"' : ''} width="${w}%" valign="top" style="width:${w}%;vertical-align:top;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table></td>`;
    })
    .join('');
  return `<tr><td style="padding:${st.paddingY ?? 0}px ${st.paddingX ?? 0}px;${bg}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cols}</tr></table></td></tr>`;
}

function contextFor(design: EmailDesign, placeholders = false): Ctx {
  return { s: design.settings, dark: luminance(design.settings.contentBackground) > 0.6, placeholders };
}

/** Px width available to the blocks of column `i` (the editor canvas sizes blocks with it). */
export function columnWidth(design: EmailDesign, sec: Section, i: number): number {
  const w = sec.widths[i] ?? Math.round(100 / sec.columns.length);
  return Math.round(((design.settings.width - (sec.style.paddingX ?? 0) * 2) * w) / 100);
}

/** One block as a standalone table, for the editor canvas (empty images/buttons show a placeholder). */
export function renderBlockHtml(design: EmailDesign, sec: Section, colIndex: number, b: Block): string {
  const ctx = contextFor(design, true);
  const row = renderBlock(b, sec.style.background ? { ...ctx, dark: false } : ctx, columnWidth(design, sec, colIndex));
  const s = design.settings;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${s.fontFamily};color:${s.textColor};">${row || '<tr><td></td></tr>'}</table>`.replace(
    /\{\{\s*unsubscribe_url\s*\}\}/g,
    UNSUBSCRIBE_TOKEN,
  );
}

export function withAutoFooter(design: EmailDesign): EmailDesign {
  if (hasFooter(design)) return design;
  const footer = newBlock('footer', { text: '' });
  footer.id = 'auto-footer';
  return { ...design, sections: [...design.sections, { ...newSection(1, [[footer]]), id: 'auto-footer' }] };
}

export function renderEmailHtml(input: EmailDesign, opts: RenderOptions = {}): string {
  const design = opts.autoFooter === false ? input : withAutoFooter(input);
  const ctx = contextFor(design, !!opts.placeholders);
  const s = design.settings;
  const sections = design.sections.map((sec) => renderSection(sec, ctx)).join('');
  const darkCss = ctx.dark
    ? `@media (prefers-color-scheme: dark) {
  .pg-body { background-color: #0b0f19 !important; }
  .pg-content { background-color: #111827 !important; }
  .pg-txt, .pg-txt p, .pg-txt li, .pg-txt h1, .pg-txt h2, .pg-txt h3 { color: #e5e7eb !important; }
  .pg-muted, .pg-muted p, .pg-muted a { color: #9ca3af !important; }
  .pg-hr { border-color: #374151 !important; }
}
[data-ogsc] .pg-body { background-color: #0b0f19 !important; }
[data-ogsc] .pg-content { background-color: #111827 !important; }
[data-ogsc] .pg-txt, [data-ogsc] .pg-txt p, [data-ogsc] .pg-txt li { color: #e5e7eb !important; }`
    : '';
  const pre = s.preheader
    ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${s.background};opacity:0;">${escapeHtml(s.preheader)}${'&#847;&zwnj;&nbsp;'.repeat(60)}</div>`
    : '';
  const html = `<!doctype html>
<html lang="de" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(opts.title ?? '')}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
  a { color: ${s.linkColor}; }
  @media only screen and (max-width: ${s.width + 20}px) {
    .pg-container { width: 100% !important; max-width: 100% !important; }
    .pg-col { display: block !important; width: 100% !important; max-width: 100% !important; }
    .pg-img { max-width: 100% !important; height: auto !important; }
    .pg-outer { padding: 0 !important; }
  }
  ${darkCss}
</style>
</head>
<body class="pg-body" style="margin:0;padding:0;background-color:${s.background};">
${pre}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="pg-body" style="background-color:${s.background};">
<tr><td align="center" class="pg-outer" style="padding:24px 8px;">
<!--[if mso]><table role="presentation" width="${s.width}" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" class="pg-container pg-content" width="${s.width}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${s.width}px;background-color:${s.contentBackground};${s.fontFamily ? `font-family:${s.fontFamily};` : ''}color:${s.textColor};">
${sections}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
  return html.replace(/\{\{\s*unsubscribe_url\s*\}\}/g, UNSUBSCRIBE_TOKEN);
}

function blockText(b: Block): string {
  const p = b.props;
  switch (b.type) {
    case 'heading':
      return inlinePlain(p.text);
    case 'text':
      return richTextPlain(p.text);
    case 'image': {
      // Unlinked images carry no information in plain text; linked ones keep their target.
      const href = safeUrl(p.href);
      return href && safeUrl(p.src, 'image') ? `${p.alt || 'Bild'}: ${href}` : '';
    }
    case 'button': {
      const href = safeUrl(p.href);
      return href ? `${p.label}: ${href}` : p.label;
    }
    case 'divider':
      return '----------';
    case 'spacer':
      return '';
    case 'social':
      return (p.items as { network: string; url: string }[])
        .filter((i) => safeUrl(i.url) && SOCIAL_NETWORKS[i.network])
        .map((i) => `${SOCIAL_NETWORKS[i.network].label}: ${safeUrl(i.url)}`)
        .join('\n');
    case 'video': {
      const href = safeUrl(p.url);
      return href ? `${(p.caption || 'Video').replace(/^▶\s*/, '')}: ${href}` : '';
    }
    case 'html':
      return htmlToText(cleanHtmlBlock(p.html));
    case 'footer':
      return ['--', p.company, p.address, p.text && inlinePlain(p.text), p.preferencesLabel && `${p.preferencesLabel}: ${PREFERENCES_TOKEN}`, `${p.unsubscribeLabel || 'Abmelden'}: ${UNSUBSCRIBE_TOKEN}`].filter(Boolean).join('\n');
  }
}

/** The text/plain part, built from the design itself (not from the HTML). */
export function renderEmailText(input: EmailDesign, opts: { autoFooter?: boolean } = {}): string {
  const design = opts.autoFooter === false ? input : withAutoFooter(input);
  const parts = design.sections.flatMap((s) => s.columns.flatMap((c) => c.blocks.map(blockText))).filter((t) => t.trim());
  return parts
    .join('\n\n')
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/g, UNSUBSCRIBE_TOKEN)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Clean + render in one go: what the server stores next to the design. */
export function renderEmail(input: unknown, opts: RenderOptions = {}): { design: EmailDesign; html: string; text: string } {
  const design = normalizeDesign(input);
  return { design, html: renderEmailHtml(design, opts), text: renderEmailText(design, opts) };
}

/** True for a complete HTML document (from the builder), which the mailer must not wrap again. */
export const isFullHtmlDocument = (html: string) => /^\s*(<!doctype html|<html[\s>])/i.test(html);
