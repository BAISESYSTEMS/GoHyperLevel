import type { Block } from './site-blocks.js';
import { cleanSiteSettings } from './site-settings.js';
import { FUNNEL_TEMPLATES } from './site-templates-funnels.js';
import { SITE_TEMPLATES } from './site-templates-sites.js';
import type { FormKind, SiteTemplate } from './site-templates-kit.js';

/**
 * Template gallery (pure): the list of templates, what the gallery shows about each, and how a template is turned into a site –
 * `settings` (design tokens, header, footer, menus) and blocks with the placeholders filled in (form, calendar, product, collections,
 * the site's name, dates for countdowns, links `page:<path>` → `page:<id>`).
 */

export const TEMPLATES: SiteTemplate[] = [...SITE_TEMPLATES, ...FUNNEL_TEMPLATES];
export const CATEGORIES = ['Dienstleistung', 'Handwerk & Lokal', 'Gesundheit', 'Immobilien', 'Verkauf & Kurse', 'Events & Webinare', 'Lead-Funnel', 'Persönlich'];
export const templateOf = (id: unknown) => TEMPLATES.find((t) => t.id === id);

export function templateMeta(t: SiteTemplate) {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    kind: t.kind,
    description: t.description,
    tags: t.tags,
    color: t.tokens.colors?.brand ?? '#2563eb',
    surface: t.tokens.colors?.surface ?? '#f3f4f6',
    pages: t.pages.map((p) => ({ name: p.name, slug: p.slug, legal: ['impressum', 'datenschutz', 'widerruf'].includes(p.slug) })),
    needs: t.needs,
    legal: t.legal,
    collections: (t.collections ?? []).map((c) => c.preset),
  };
}

export interface FormSpec {
  name: string;
  fields: Record<string, any>[];
  settings: Record<string, any>;
}
const consent = { id: 'f9', type: 'consent', label: 'Ich stimme der Verarbeitung meiner Daten gemäß Datenschutzerklärung zu.', name: 'consent', required: true };
/** Fields of the form the apply step creates when the account has none to use. */
export function formSpec(kind: FormKind | undefined, siteName: string): FormSpec {
  const field = (id: string, type: string, label: string, name: string, required = false, extra: Record<string, any> = {}) => ({ id, type, label, name, required, ...extra });
  switch (kind) {
    case 'optin':
      return { name: `${siteName} – Anmeldung`, fields: [field('f1', 'text', 'Vorname', 'first_name', true), field('f3', 'email', 'E-Mail', 'email', true), consent], settings: { submit_text: 'Jetzt kostenlos sichern', thank_you: 'Danke! Schau in dein Postfach.' } };
    case 'registration':
      return { name: `${siteName} – Anmeldung`, fields: [field('f1', 'text', 'Vorname', 'first_name', true), field('f3', 'email', 'E-Mail', 'email', true), consent], settings: { submit_text: 'Kostenlos anmelden', thank_you: 'Danke! Du bekommst gleich eine E-Mail.' } };
    case 'application':
      return { name: `${siteName} – Bewerbung`, fields: [field('f1', 'text', 'Vorname', 'first_name', true), field('f2', 'text', 'Nachname', 'last_name', true), field('f3', 'email', 'E-Mail', 'email', true), field('f4', 'phone', 'Telefon', 'phone'), field('f5', 'textarea', 'Was ist dein Ziel? Was beschäftigt dich gerade?', 'message', true), consent], settings: { submit_text: 'Bewerbung absenden', thank_you: 'Danke für deine Bewerbung!' } };
    default:
      return {
        name: `${siteName} – Kontakt`,
        fields: [field('f1', 'text', 'Vorname', 'first_name', true), field('f2', 'text', 'Nachname', 'last_name'), field('f3', 'email', 'E-Mail', 'email', true), field('f4', 'phone', 'Telefon', 'phone'), field('f5', 'textarea', 'Ihre Nachricht', 'message', true), consent],
        settings: { submit_text: 'Nachricht senden', thank_you: 'Danke! Wir melden uns in Kürze.' },
      };
  }
}

export interface Wiring {
  firma: string;
  form_id: string;
  calendar_slug: string;
  product_id: string;
  /** collection preset key → id of the collection created for the site */
  collections: Map<string, string>;
  /** page path → page id */
  pages: Map<string, string>;
  now: Date;
}

/** The site's `settings` from the template (tokens, header, footer, menus); menus point at pages by id. */
export function settingsOf(t: SiteTemplate, w: Pick<Wiring, 'firma' | 'pages'>): Record<string, any> {
  const link = (to: string) => (w.pages.has(to) ? `page:${w.pages.get(to)}` : to.startsWith('#') || to.startsWith('http') ? to : '#');
  const items = (list: [string, string][] = []) => list.map(([label, to]) => ({ label, url: link(to) }));
  const brand = t.tokens.colors?.brand;
  const patch: Record<string, any> = {
    tokens: t.tokens,
    site_name: w.firma,
    header: t.header ? { enabled: true, brand: w.firma, cta_text: t.header.cta_text ?? '', cta_url: t.header.cta_url ? link(t.header.cta_url) : '#', sticky: !!t.header.sticky, search: !!t.search || !!t.header.search, menu: 'main', lang_switch: false } : { enabled: false },
    footer: { enabled: true, text: (t.footer?.text ?? '© {{firma}}').replace('{{firma}}', w.firma), columns: (t.footer?.columns ?? []).map((c) => ({ title: c.title, links: items(c.links) })) },
    menus: t.menu ? { main: items(t.menu) } : {},
    search: { enabled: !!t.search },
  };
  const s = cleanSiteSettings(patch, {});
  if (brand) s.color = brand;
  return s;
}

const DAY = 864e5;
const at19 = (d: Date, days: number) => {
  const x = new Date(d.getTime() + days * DAY);
  x.setUTCHours(17, 0, 0, 0); // 19:00 in Germany (summer time)
  return x.toISOString();
};

/** Blocks of a page with all placeholders filled in (deep copy; the template itself is never touched). */
export function wireBlocks(blocks: Block[], w: Wiring): Block[] {
  const text = (s: string) =>
    s
      .replace(/\{\{firma\}\}/g, w.firma)
      .replace(/\{\{in7days\}\}/g, at19(w.now, 7))
      .replace(/\{\{in30days\}\}/g, at19(w.now, 30))
      .replace(/^page:([a-z0-9-]+)$/, (m, slug: string) => (w.pages.has(slug) ? `page:${w.pages.get(slug)}` : m));
  const walk = (v: any): any => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'form_id' && x === '') out[k] = w.form_id;
        else if (k === 'calendar_slug' && x === '') out[k] = w.calendar_slug;
        else if (k === 'product_id' && x === '') out[k] = w.product_id;
        else if (k === 'collection_id' && typeof x === 'string' && x.startsWith('preset:')) out[k] = w.collections.get(x.slice(7)) ?? '';
        else out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(blocks);
}
