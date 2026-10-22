import { DEFAULT_SETTINGS, newBlock, newSection, type Block, type BlockStyle, type EmailDesign, type Section } from './email-render.js';

/**
 * Building blocks for the template gallery (services/mk-gallery.ts): colour themes and small functions that return finished sections
 * in the email builder's own format (hero, steps, facts, coupon …). Every template is a list of these, so they stay consistent,
 * responsive (the builder's columns stack on phones) and editable block by block in the designer.
 */

export interface Theme {
  key: string;
  /** Buttons, links, highlights. */
  accent: string;
  /** Text on the accent colour. */
  accentText: string;
  /** Dark colour for hero areas. */
  deep: string;
  /** Pale tint for panels. */
  soft: string;
  text: string;
  muted: string;
  /** Canvas around the mail. */
  page: string;
  /** The mail itself. */
  card: string;
  font: string;
  line: string;
  dark?: boolean;
}

const SANS = 'Arial, Helvetica, sans-serif';
const SERIF = 'Georgia, Times, serif';
const TREBUCHET = "'Trebuchet MS', Arial, sans-serif";

const light = (key: string, accent: string, deep: string, soft: string, page: string, font = SANS): Theme => ({ key, accent, accentText: '#ffffff', deep, soft, text: '#1f2937', muted: '#5b6472', page, card: '#ffffff', font, line: '#e5e7eb' });

export const THEMES = {
  ocean: light('ocean', '#1d4ed8', '#1e3a8a', '#eff6ff', '#eef2f7'),
  forest: light('forest', '#15803d', '#14532d', '#f0fdf4', '#f1f5f1'),
  ember: light('ember', '#c2410c', '#9a3412', '#fff7ed', '#f7f1ec', TREBUCHET),
  berry: light('berry', '#be185d', '#831843', '#fdf2f8', '#f6eff3'),
  slate: light('slate', '#334155', '#0f172a', '#f1f5f9', '#e9edf2'),
  gold: { ...light('gold', '#b45309', '#1c1917', '#fffbeb', '#f3efe8', SERIF), line: '#e7dfd0' },
  violet: light('violet', '#6d28d9', '#4c1d95', '#f5f3ff', '#f0eef6'),
  teal: light('teal', '#0f766e', '#134e4a', '#f0fdfa', '#edf4f3'),
  festive: light('festive', '#b91c1c', '#14532d', '#fef2f2', '#f4efe9', SERIF),
  night: { key: 'night', accent: '#38bdf8', accentText: '#0b1020', deep: '#0b1020', soft: '#172042', text: '#e5e7eb', muted: '#94a3b8', page: '#070b17', card: '#0f1730', font: SANS, line: '#26335c', dark: true } as Theme,
} satisfies Record<string, Theme>;

export type ThemeKey = keyof typeof THEMES;
export type Tone = 'plain' | 'soft' | 'deep' | 'accent';

/** Colours for a tone: background of the section, text colours on it, and the button that stands out on it. */
export function tone(t: Theme, tn: Tone) {
  if (tn === 'deep') return { bg: t.deep, text: '#ffffff', muted: t.dark ? '#94a3b8' : '#cbd5e1', button: t.dark ? t.accent : '#ffffff', buttonText: t.dark ? t.accentText : t.deep, line: '#64748b' };
  if (tn === 'accent') return { bg: t.accent, text: t.accentText, muted: t.accentText, button: t.accentText, buttonText: t.accent, line: t.accentText };
  if (tn === 'soft') return { bg: t.soft, text: t.text, muted: t.muted, button: t.accent, buttonText: t.accentText, line: t.line };
  return { bg: '', text: t.text, muted: t.muted, button: t.accent, buttonText: t.accentText, line: t.line };
}

type Style = BlockStyle;
const sec = (t: Theme, tn: Tone, cols: Block[][], o: { padY?: number; padX?: number; widths?: number[] } = {}): Section => {
  const s = newSection(cols.length, cols, o.widths);
  s.style = { background: tone(t, tn).bg, paddingY: o.padY ?? (tn === 'plain' ? 0 : 28), paddingX: o.padX ?? 0 };
  return s;
};

// --- blocks -----------------------------------------------------------------------------------------------------

export const h = (t: Theme, tn: Tone, text: string, level: 1 | 2 | 3 = 1, s: Style = {}): Block => newBlock('heading', { text, level }, { align: 'left', color: tone(t, tn).text, paddingY: 8, ...s });
export const p = (t: Theme, tn: Tone, text: string, s: Style = {}): Block => newBlock('text', { text }, { align: 'left', color: tone(t, tn).text, ...s });
export const small = (t: Theme, tn: Tone, text: string, s: Style = {}): Block => newBlock('text', { text }, { align: 'left', color: tone(t, tn).muted, fontSize: 13, ...s });
export const kicker = (t: Theme, tn: Tone, text: string, s: Style = {}): Block => newBlock('text', { text: text.toUpperCase() }, { align: 'left', color: tn === 'plain' || tn === 'soft' ? t.accent : tone(t, tn).muted, fontSize: 12, paddingY: 4, ...s });
export const btn = (t: Theme, tn: Tone, label: string, href: string, s: Style = {}, props: Record<string, unknown> = {}): Block => {
  const c = tone(t, tn);
  return newBlock('button', { label, href, background: c.button, textColor: c.buttonText, radius: 8, ...props }, { align: 'left', paddingY: 12, ...s });
};
export const ghost = (t: Theme, tn: Tone, label: string, href: string, s: Style = {}): Block => {
  const c = tone(t, tn);
  return newBlock('button', { label, href, background: c.bg || t.card, textColor: c.text, radius: 8 }, { align: 'left', paddingY: 6, ...s });
};
export const rule = (t: Theme, tn: Tone = 'plain', s: Style = {}): Block => newBlock('divider', { color: tone(t, tn).line }, { paddingY: 10, ...s });
export const gap = (height = 16): Block => newBlock('spacer', { height });
export const image = (alt: string, s: Style = {}): Block => newBlock('image', { alt }, { paddingX: 0, paddingY: 0, ...s });

/** A dashed coupon box (HTML block: inline styles only). */
export function couponBlock(t: Theme, tn: Tone, code: string, note = ''): Block {
  const c = tone(t, tn);
  const border = tn === 'deep' || tn === 'accent' ? c.text : t.accent;
  const html = `<div style="text-align:center;border:2px dashed ${border};border-radius:10px;padding:16px 12px;"><div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${c.muted};">Dein Code</div><div style="font-size:30px;font-weight:700;letter-spacing:4px;color:${c.text};padding:6px 0;">${code}</div>${note ? `<div style="font-size:13px;color:${c.muted};">${note}</div>` : ''}</div>`;
  return newBlock('html', { html }, { paddingY: 12, paddingX: 40 });
}

/** A quotation with a coloured bar (HTML block). */
export function quoteBlock(t: Theme, tn: Tone, text: string, who: string): Block {
  const c = tone(t, tn);
  const html = `<div style="border-left:4px solid ${t.accent};padding:4px 0 4px 16px;"><div style="font-size:18px;line-height:1.5;font-style:italic;color:${c.text};">„${text}“</div><div style="font-size:13px;color:${c.muted};padding-top:8px;">${who}</div></div>`;
  return newBlock('html', { html }, { paddingY: 12 });
}

/** A row of numbered answer buttons (0–10) that wrap on small screens; each is at least 44 px wide and high (HTML block). */
export function scaleBlock(t: Theme, from: number, to: number, url: (n: number) => string): Block {
  const cells: string[] = [];
  for (let n = from; n <= to; n++) cells.push(`<a href="${url(n)}" style="display:inline-block;width:44px;height:44px;line-height:44px;margin:3px;border-radius:8px;background-color:${t.soft};border:1px solid ${t.accent};color:${t.accent};font-size:16px;font-weight:700;text-align:center;text-decoration:none;">${n}</a>`);
  return newBlock('html', { html: `<div style="text-align:center;">${cells.join('')}</div>` }, { paddingY: 10, align: 'center' });
}

/** A highlighted line (price, date, number) with a small label above (HTML block). */
export function figureBlock(t: Theme, tn: Tone, label: string, value: string, note = '', s: Style = {}): Block {
  const c = tone(t, tn);
  const html = `<div style="text-align:center;"><div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${c.muted};">${label}</div><div style="font-size:40px;line-height:1.15;font-weight:700;color:${tn === 'plain' || tn === 'soft' ? t.accent : c.text};padding:4px 0;">${value}</div>${note ? `<div style="font-size:13px;color:${c.muted};">${note}</div>` : ''}</div>`;
  return newBlock('html', { html }, { paddingY: 10, ...s });
}

// --- sections ---------------------------------------------------------------------------------------------------

/** The company name as a wordmark above the mail. */
export const brand = (t: Theme, tn: Tone = 'plain', align: 'left' | 'center' = 'center'): Section =>
  sec(t, tn, [[newBlock('heading', { text: '{{location.name}}', level: 3 }, { align, color: tn === 'plain' || tn === 'soft' ? t.accent : tone(t, tn).text, paddingY: 22, fontSize: 17 })]], { padY: 0 });

export interface HeroOptions {
  tone?: Tone;
  kicker?: string;
  title: string;
  text?: string;
  button?: [label: string, href: string];
  second?: [label: string, href: string];
  align?: 'left' | 'center';
  padY?: number;
}

/** The first big area: kicker, headline, a few lines, a button. */
export function hero(t: Theme, o: HeroOptions): Section {
  const tn = o.tone ?? 'deep';
  const align = o.align ?? 'center';
  const blocks: Block[] = [];
  if (o.kicker) blocks.push(kicker(t, tn, o.kicker, { align, paddingY: 6 }));
  blocks.push(h(t, tn, o.title, 1, { align, fontSize: 32, paddingY: 8 }));
  if (o.text) blocks.push(p(t, tn, o.text, { align, color: tone(t, tn).text, fontSize: 17, paddingY: 8 }));
  if (o.button) blocks.push(btn(t, tn, o.button[0], o.button[1], { align, paddingY: 16 }));
  if (o.second) blocks.push(ghost(t, tn, o.second[0], o.second[1], { align, paddingY: 0 }));
  return sec(t, tn, [blocks], { padY: o.padY ?? 40 });
}

/** A section of text (and an optional heading). */
export function copy(t: Theme, text: string, o: { tone?: Tone; title?: string; level?: 1 | 2 | 3; align?: 'left' | 'center'; padY?: number } = {}): Section {
  const tn = o.tone ?? 'plain';
  const blocks: Block[] = [];
  if (o.title) blocks.push(h(t, tn, o.title, o.level ?? 2, { align: o.align ?? 'left' }));
  blocks.push(p(t, tn, text, { align: o.align ?? 'left' }));
  return sec(t, tn, [blocks], { padY: o.padY ?? (tn === 'plain' ? 8 : 28) });
}

/** A button on its own. */
export const action = (t: Theme, label: string, href: string, o: { tone?: Tone; align?: 'left' | 'center'; note?: string; padY?: number } = {}): Section => {
  const tn = o.tone ?? 'plain';
  const blocks = [btn(t, tn, label, href, { align: o.align ?? 'center', paddingY: 14 })];
  if (o.note) blocks.push(small(t, tn, o.note, { align: o.align ?? 'center', paddingY: 4 }));
  return sec(t, tn, [blocks], { padY: o.padY ?? (tn === 'plain' ? 8 : 28) });
};

/** Numbered steps, one under the other. */
export function steps(t: Theme, items: [title: string, text: string][], o: { tone?: Tone; title?: string } = {}): Section {
  const tn = o.tone ?? 'plain';
  const blocks: Block[] = [];
  if (o.title) blocks.push(h(t, tn, o.title, 2));
  items.forEach(([title, text], i) => {
    blocks.push(newBlock('heading', { text: `${i + 1}  ${title}`, level: 3 }, { align: 'left', color: tn === 'plain' || tn === 'soft' ? t.accent : tone(t, tn).text, paddingY: 4, fontSize: 18 }));
    blocks.push(p(t, tn, text, { paddingY: 2, fontSize: 15 }));
    if (i < items.length - 1) blocks.push(gap(8));
  });
  return sec(t, tn, [blocks], { padY: tn === 'plain' ? 12 : 28 });
}

/** Three big numbers side by side. */
export function stats(t: Theme, items: [value: string, label: string][], o: { tone?: Tone } = {}): Section {
  const tn = o.tone ?? 'soft';
  const cols = items.slice(0, 3).map(([value, label]) => [
    newBlock('heading', { text: value, level: 1 }, { align: 'center', color: tn === 'plain' || tn === 'soft' ? t.accent : tone(t, tn).text, paddingY: 4, fontSize: 34 }),
    small(t, tn, label, { align: 'center', paddingY: 2 }),
  ]);
  return sec(t, tn, cols, { padY: 26, widths: cols.length === 3 ? [33, 34, 33] : cols.length === 2 ? [50, 50] : [100] });
}

/** Two or three columns with a heading and a few lines each (and an optional link). */
export function cards(t: Theme, items: { title: string; text: string; link?: [string, string] }[], o: { tone?: Tone; cols?: 2 | 3; title?: string } = {}): Section[] {
  const tn = o.tone ?? 'plain';
  const n = o.cols ?? (items.length >= 3 ? 3 : 2);
  const out: Section[] = [];
  if (o.title) out.push(sec(t, tn, [[h(t, tn, o.title, 2)]], { padY: tn === 'plain' ? 8 : 24 }));
  for (let i = 0; i < items.length; i += n) {
    const row = items.slice(i, i + n);
    const cols = row.map((c) => {
      const b = [h(t, tn, c.title, 3, { paddingY: 4 }), p(t, tn, c.text, { fontSize: 15, paddingY: 4 })];
      if (c.link) b.push(newBlock('text', { text: `[${c.link[0]}](${c.link[1]})` }, { fontSize: 15, paddingY: 4, color: tone(t, tn).text }));
      return b;
    });
    out.push(sec(t, tn, cols, { padY: tn === 'plain' ? 6 : 20, widths: n === 3 ? [33, 34, 33] : [50, 50] }));
  }
  return out;
}

/** Label / value rows (when, where, price …) in two columns. */
export function facts(t: Theme, rows: [label: string, value: string][], o: { tone?: Tone; title?: string } = {}): Section[] {
  const tn = o.tone ?? 'soft';
  const out: Section[] = [];
  const colsOf = (list: [string, string][]) =>
    list.map(([label, value]) => [kicker(t, tn, label, { align: 'left', paddingY: 2 }), p(t, tn, value, { fontSize: 16, paddingY: 2 })]);
  if (o.title) out.push(sec(t, tn, [[h(t, tn, o.title, 2)]], { padY: 18 }));
  for (let i = 0; i < rows.length; i += 2) {
    const chunk = rows.slice(i, i + 2);
    out.push(sec(t, tn, colsOf(chunk), { padY: i === 0 && !o.title ? 22 : 8, widths: chunk.length === 2 ? [50, 50] : [100] }));
  }
  return out;
}

/** A checklist or bullet list under a heading. */
export function bullets(t: Theme, items: string[], o: { tone?: Tone; title?: string; mark?: string } = {}): Section {
  const tn = o.tone ?? 'plain';
  const blocks: Block[] = [];
  if (o.title) blocks.push(h(t, tn, o.title, 2));
  // With a mark (✓, •, ☐) the lines stand on their own; without, they form a real list.
  blocks.push(p(t, tn, o.mark ? items.map((x) => `${o.mark} ${x}`).join('\n') : items.map((x) => `- ${x}`).join('\n')));
  return sec(t, tn, [blocks], { padY: tn === 'plain' ? 10 : 26 });
}

/** A panel with a single block (coupon, figure, quote). */
export const panel = (t: Theme, blocks: Block[], tn: Tone = 'soft', padY = 24): Section => sec(t, tn, [blocks], { padY });

export const space = (t: Theme, height = 12): Section => sec(t, 'plain', [[gap(height)]], { padY: 0 });
export const line = (t: Theme): Section => sec(t, 'plain', [[rule(t)]], { padY: 0 });

/** Greeting and closing words as one text section. */
export const letter = (t: Theme, text: string, o: { tone?: Tone; padY?: number } = {}): Section => sec(t, o.tone ?? 'plain', [[p(t, o.tone ?? 'plain', text, { paddingY: 10 })]], { padY: o.padY ?? 16 });

/** Social icons (the sub-account fills the addresses in the designer). */
export const social = (t: Theme, tn: Tone = 'plain'): Section => sec(t, tn, [[newBlock('divider', { color: t.line }, { paddingY: 8 }), newBlock('social', { variant: 'text', items: [{ network: 'website', url: 'https://example.com' }, { network: 'instagram', url: 'https://instagram.com/' }, { network: 'linkedin', url: 'https://linkedin.com/' }] }, { align: 'center', paddingY: 8, fontSize: 14 })]], { padY: 6 });

/** Footer with company, address and unsubscribe link (required for campaigns). */
export const foot = (t: Theme, text = 'Du erhältst diese E-Mail, weil du dich bei uns angemeldet hast.'): Section =>
  sec(t, 'plain', [[newBlock('footer', { company: '{{location.name}}', address: '{{location.address}}', text }, { align: 'center', color: t.muted, fontSize: 12, paddingY: 22 })]], { padY: 0 });

/** The design: settings from the theme and the sections in order. */
export function mail(t: Theme, preheader: string, sections: (Section | Section[])[], o: { width?: number } = {}): EmailDesign {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS, width: o.width ?? 600, background: t.page, contentBackground: t.card, fontFamily: t.font, textColor: t.text, linkColor: t.accent, fontSize: 16, preheader },
    sections: sections.flat(),
  };
}

// --- the catalogue's shape ----------------------------------------------------------------------------------------

export type CategoryKey = 'newsletter' | 'angebot' | 'willkommen' | 'event' | 'webinar' | 'kurs' | 'rechnung' | 'feiertage' | 'b2b' | 'coach' | 'handwerk' | 'ecommerce' | 'feedback';

export interface GalleryTemplate {
  key: string;
  name: string;
  category: CategoryKey;
  description: string;
  subject: string;
  preheader: string;
  /** Search words besides name and description. */
  tags: string;
  /** Anrede: informal (du) or formal (Sie). */
  formal: 'du' | 'sie';
  /** Service mail (invoice, order): for an existing business relationship, not for advertising. */
  service: boolean;
  theme: ThemeKey;
  build: () => EmailDesign;
}

/** One template: its data and the sections (built from its theme). */
export function tpl(d: { key: string; name: string; category: CategoryKey; description: string; subject: string; preheader: string; theme: ThemeKey; tags?: string; formal?: 'du' | 'sie'; service?: boolean }, sections: (t: Theme) => (Section | Section[])[]): GalleryTemplate {
  const t: Theme = THEMES[d.theme];
  return { key: d.key, name: d.name, category: d.category, description: d.description, subject: d.subject, preheader: d.preheader, tags: d.tags ?? '', formal: d.formal ?? 'du', service: !!d.service, theme: d.theme, build: () => mail(t, d.preheader, sections(t)) };
}
