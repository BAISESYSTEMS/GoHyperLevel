import type { Tokens } from './site-style.js';

/**
 * Site builder: the little kit the template gallery is written with. Templates are plain data (pages of blocks in the same
 * format the editor stores), assembled from a few patterns – hero, benefits, steps, testimonials, pricing, FAQ, call-to-action, contact –
 * so that they stay consistent and short. Links between the pages of a template use `page:<path>`; things that belong to the user's
 * account are placeholders filled in when the template is applied: `form_id: ''`, `calendar_slug: ''`, `product_id: ''`,
 * `collection_id: 'preset:<key>'` and the text `{{firma}}` (the name of the new site).
 */

export type B = Record<string, any>;

export interface TemplatePage {
  name: string;
  slug: string;
  blocks: B[];
  seo?: { title?: string; description?: string; noindex?: boolean };
  layout?: { header?: false; footer?: false };
}
export type FormKind = 'contact' | 'optin' | 'application' | 'registration';
export interface SiteTemplate {
  id: string;
  name: string;
  category: string;
  kind: 'website' | 'funnel';
  description: string;
  tags: string[];
  /** the page to show first in the preview, defaults to the first */
  tokens: { colors?: Partial<Tokens['colors']>; fonts?: Partial<Tokens['fonts']>; scale?: Partial<Tokens['scale']>; radius?: Partial<Tokens['radius']>; space?: number };
  header?: { brand?: string; cta_text?: string; cta_url?: string; sticky?: boolean; search?: boolean };
  /** main menu: label → page path */
  menu?: [label: string, to: string][];
  footer?: { text?: string; columns?: { title: string; links: [label: string, to: string][] }[] };
  pages: TemplatePage[];
  /** collections created with the site: preset key plus optional overrides */
  collections?: { preset: string; name?: string; slug?: string; singular?: string; samples?: boolean }[];
  /** what the template needs from the account – the apply step creates or asks for it */
  needs: ('form' | 'calendar' | 'product')[];
  form?: FormKind;
  /** path of the page the form sends people to after submitting */
  thanks?: string;
  /** legal pages that are in the template (filled from the company data when it is known) */
  legal: ('impressum' | 'datenschutz' | 'widerruf')[];
  search?: boolean;
}

// --- blocks ----------------------------------------------------------------------------------------------------------

export const h = (text: string, level = 2, o: B = {}): B => ({ type: 'heading', text, level, ...o });
export const p = (text: string, o: B = {}): B => ({ type: 'text', text, ...o });
export const btn = (text: string, url: string, o: B = {}): B => ({ type: 'button', text, url, ...o });
export const lead = (text: string, o: B = {}): B => p(text, { fs: { desktop: 118, phone: 108 }, ...o });
export const eyebrow = (text: string, o: B = {}): B => p(`**${text.toUpperCase()}**`, { color: 'token:brand', fs: { desktop: 82 }, ...o });
/** One or two buttons side by side (the second one quieter). */
export const buttons = (primary?: [string, string], secondary?: [string, string]): B[] => (primary ? [btn(primary[0], primary[1], secondary ? { text2: secondary[0], url2: secondary[1] } : {})] : []);

export const col = (span: number, blocks: B[], o: B = {}): B => ({ span, blocks, ...o });
export const row = (cols: B[], o: B = {}): B => ({ gap: 28, stack: 'phone', ...o, cols });
export const section = (rows: B | B[], o: B = {}): B => ({ type: 'section', pad_y: 72, ...o, rows: Array.isArray(rows) ? rows : [rows] });

/** The form of the account (placeholder), as a card in a column. */
export const formBlock = (heading: string, o: B = {}): B => ({ type: 'form', form_id: '', heading, ...o });
export const calendarBlock = (o: B = {}): B => ({ type: 'calendar', calendar_slug: '', ...o });
export const productBlock = (o: B = {}): B => ({ type: 'product', product_id: '', ...o });
export const collectionBlock = (preset: string, o: B = {}): B => ({ type: 'collection', collection_id: `preset:${preset}`, ...o });

// --- patterns ------------------------------------------------------------------------------------------------------------

export interface HeroOpts {
  eyebrow?: string;
  title: string;
  lead: string;
  primary?: [string, string];
  secondary?: [string, string];
  /** right-hand side: a form card, a stats card … */
  aside?: B[];
  bg?: string;
  color?: string;
  pad?: number;
  /** note below the buttons (guarantee, trust line) */
  note?: string;
}

/** Text on the left, something to act on (form, price card, facts) on the right; stacks on phones. */
export function heroSplit(o: HeroOpts): B {
  const left = [o.eyebrow && eyebrow(o.eyebrow, o.bg?.startsWith('#') ? { color: undefined } : {}), h(o.title, 1), lead(o.lead), ...buttons(o.primary, o.secondary), o.note && p(o.note, { fs: { desktop: 88 }, color: 'token:muted' })].filter(Boolean) as B[];
  return section(row([col(o.aside ? 7 : 12, left), ...(o.aside ? [col(5, o.aside, { valign: 'center' })] : [])], { valign: 'center', gap: 40 }), { bg: o.bg, color: o.color, pad_y: o.pad ?? 88 });
}

/** One centred column: eyebrow, big headline, lead, buttons. */
export function heroCenter(o: Omit<HeroOpts, 'aside'> & { width?: string }): B {
  const blocks = [o.eyebrow && eyebrow(o.eyebrow, { align: 'center', ...(o.bg?.startsWith('#') ? { color: undefined } : {}) }), h(o.title, 1, { align: 'center' }), lead(o.lead, { align: 'center' }), ...buttons(o.primary, o.secondary).map((b) => ({ ...b, align: 'center' })), o.note && p(o.note, { align: 'center', color: 'token:muted', fs: { desktop: 88 } })].filter(Boolean) as B[];
  return section(row([col(12, blocks)]), { bg: o.bg, color: o.color, pad_y: o.pad ?? 96, width: o.width ?? 'narrow', align: 'center' });
}

export type Item = [icon: string, title: string, text: string];
/** A grid of benefits (icon, title, text). */
export const benefits = (title: string, items: Item[], o: B = {}): B =>
  section(row([col(12, [{ type: 'features', heading: title, align: 'center', padding: 0, items: items.map(([icon, t, text]) => ({ icon, title: t, text })) }])]), { bg: o.bg ?? 'token:bg', ...o });

/** Numbered steps. */
export const steps = (title: string, items: [string, string][], o: B = {}): B =>
  section(row([col(12, [{ type: 'steps', heading: title, align: 'center', padding: 0, items: items.map(([t, text]) => ({ title: t, text })) }])]), { bg: o.bg ?? 'token:surface', ...o });

export const stats = (items: [string, string][], o: B = {}): B => section(row([col(12, [{ type: 'stats', padding: 0, items: items.map(([value, label]) => ({ value, label })) }])]), { pad_y: 48, ...o });

export const logos = (title: string, names: string[]): B => section(row([col(12, [p(`**${title}**`, { align: 'center', color: 'token:muted', fs: { desktop: 88 } }), p(names.join('   ·   '), { align: 'center', color: 'token:muted', fs: { desktop: 110 } })])]), { pad_y: 36 });

/** Quotes in columns (one to three). */
export function testimonials(title: string, items: [quote: string, author: string][], o: B = {}): B {
  const n = Math.min(3, items.length);
  const head = row([col(12, [h(title, 2, { align: 'center' })])]);
  const cards = row(
    items.slice(0, 3).map(([quote, author]) => col(Math.floor(12 / n), [{ type: 'testimonial', quote, author, align: 'left', padding: 0 }], { bg: 'token:bg', pad: 24, radius: 16, shadow: 'sm' })),
    { stack: 'tablet', valign: 'stretch' },
  );
  return section([head, cards], { bg: o.bg ?? 'token:surface', ...o });
}

export const pricing = (title: string, plans: { name: string; price: string; features: string; button: string; to: string }[], o: B = {}): B =>
  section(row([col(12, [{ type: 'pricing', heading: title, align: 'center', padding: 0, items: plans.map((x) => ({ name: x.name, price: x.price, features: x.features, button_text: x.button, button_url: x.to })) }])]), { bg: o.bg ?? 'token:bg', ...o });

export const faq = (items: [string, string][], title = 'Häufige Fragen', o: B = {}): B =>
  section(row([col(12, [{ type: 'faq', heading: title, padding: 0, items: items.map(([q, a]) => ({ q, a })) }])]), { width: 'narrow', bg: o.bg ?? 'token:bg', ...o });

export const ctaBand = (title: string, text: string, button: [string, string], o: B = {}): B =>
  section(row([col(12, [{ type: 'cta', heading: title, text, button_text: button[0], button_url: button[1], style: o.style, padding: 0 }])]), { pad_y: 56, ...o, style: undefined });

/** Text with a heading, optionally next to a second column. */
export const textSection = (title: string, md: string, o: B = {}): B => section(row([col(12, [h(title, 2), p(md)])]), { width: 'narrow', ...o });

/** Left: heading and contact lines; right: the form (or any block). */
export const contact = (title: string, md: string, right: B, o: B = {}): B => {
  const { level, ...rest } = o;
  return section(row([col(5, [h(title, level ?? 1, { fs: { desktop: 76, phone: 90 } }), p(md)]), col(7, [right])], { gap: 48 }), { bg: rest.bg ?? 'token:surface', ...rest });
};

export const twoCols = (left: B[], right: B[], o: B = {}, spans: [number, number] = [6, 6]): B => section(row([col(spans[0], left), col(spans[1], right)], { valign: 'center', gap: 40, rev: o.rev }), o);

/** A card in a column: price list line, opening hours … */
export const card = (blocks: B[], o: B = {}): B => ({ bg: 'token:surface', pad: 24, radius: 16, ...o, blocks });

// --- legal pages ---------------------------------------------------------------------------------------------------------

/** Placeholder pages the legal generator recognises and fills from the company data (modules/legal-pages.ts). */
export const IMPRESSUM: TemplatePage = { name: 'Impressum', slug: 'impressum', seo: { title: 'Impressum', noindex: false }, blocks: [h('Impressum', 1), p('Angaben gemäß § 5 DDG\n\nName\nStraße\nPLZ Ort')] };
export const DATENSCHUTZ: TemplatePage = { name: 'Datenschutz', slug: 'datenschutz', seo: { title: 'Datenschutzerklärung' }, blocks: [h('Datenschutzerklärung', 1), p('Hier deine Datenschutzerklärung einfügen.')] };
export const WIDERRUF: TemplatePage = { name: 'Widerruf', slug: 'widerruf', seo: { title: 'Widerrufsbelehrung' }, blocks: [h('Widerrufsbelehrung', 1), p('Hier deine Widerrufsbelehrung einfügen.')] };
export const legalPages = (withdrawal = false): TemplatePage[] => [IMPRESSUM, DATENSCHUTZ, ...(withdrawal ? [WIDERRUF] : [])];
