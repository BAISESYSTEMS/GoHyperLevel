import { bad } from '../core/http.js';
import { cleanTokens, tokensOf, isColor } from './site-style.js';

/**
 * Site builder: what may be stored in a site's `settings` besides the older keys (color, font, head_code …):
 * design tokens, the global header/footer with their menus, languages, the custom 404 page, search and analytics options.
 * Pure – `cleanSiteSettings` is the only door, the route hands it the patch and the current settings.
 */

export interface MenuItem {
  label: string;
  url: string;
  children?: MenuItem[];
}

const str = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const bool = (v: unknown) => v === true || v === 'true' || v === 1;
const URL_OK = /^(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]*|#[\w-]*|mailto:[^\s"'<>]+|tel:[+\d\s()-]+|page:[A-Za-z0-9_-]{1,60})$/i;
const MENU_NAME = /^[a-z][a-z0-9_-]{0,19}$/;
const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

const cleanUrl = (v: unknown, fallback = '#') => {
  const s = String(v ?? '').trim();
  return s && s.length <= 500 && URL_OK.test(s) ? s : fallback;
};
const imageUrl = (v: unknown) => {
  const s = String(v ?? '').trim();
  return /^(https?:\/\/|\/)[^\s"'<>]{1,980}$/i.test(s) ? s : '';
};

export function cleanMenuItems(v: unknown, depth = 0): MenuItem[] {
  if (!Array.isArray(v)) return [];
  const out: MenuItem[] = [];
  for (const it of v.slice(0, 12)) {
    if (!it || typeof it !== 'object') continue;
    const label = str((it as any).label, 60);
    if (!label) continue;
    const item: MenuItem = { label, url: cleanUrl((it as any).url) };
    const kids = depth < 1 ? cleanMenuItems((it as any).children, depth + 1) : [];
    if (kids.length) item.children = kids;
    out.push(item);
  }
  return out;
}

export function cleanMenus(v: unknown): Record<string, MenuItem[]> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, MenuItem[]> = {};
  for (const [name, items] of Object.entries(v as Record<string, unknown>).slice(0, 8)) {
    if (!MENU_NAME.test(name)) throw bad(`Menü-Name „${name}“: nur Kleinbuchstaben, Ziffern, - und _`);
    out[name] = cleanMenuItems(items);
  }
  return out;
}

export function cleanHeader(v: any, cur: Record<string, any> = {}) {
  const h = { ...cur, ...(v && typeof v === 'object' ? v : {}) };
  return {
    enabled: bool(h.enabled),
    brand: str(h.brand, 60),
    logo: imageUrl(h.logo),
    menu: MENU_NAME.test(String(h.menu ?? '')) ? String(h.menu) : 'main',
    cta_text: str(h.cta_text, 40),
    cta_url: cleanUrl(h.cta_url),
    sticky: bool(h.sticky),
    search: h.search === false ? false : true,
    lang_switch: bool(h.lang_switch),
  };
}

export function cleanFooter(v: any, cur: Record<string, any> = {}) {
  const f = { ...cur, ...(v && typeof v === 'object' ? v : {}) };
  const columns = (Array.isArray(f.columns) ? f.columns : []).slice(0, 4).map((c: any) => {
    const col: Record<string, any> = { title: str(c?.title, 60) };
    if (MENU_NAME.test(String(c?.menu ?? ''))) col.menu = String(c.menu);
    else col.links = cleanMenuItems(c?.links);
    return col;
  });
  return { enabled: bool(f.enabled), text: str(f.text, 600), columns };
}

export function cleanLanguages(v: any) {
  const def = LANG.test(String(v?.default ?? '')) ? String(v.default) : 'de';
  const seen = new Set<string>();
  const list = (Array.isArray(v?.list) ? v.list : [])
    .slice(0, 8)
    .map((l: any) => ({ code: String(l?.code ?? '').trim(), label: str(l?.label, 30) }))
    .filter((l: any) => LANG.test(l.code) && !seen.has(l.code) && (seen.add(l.code), true));
  if (!list.some((l: any) => l.code === def)) list.unshift({ code: def, label: def === 'de' ? 'Deutsch' : def.toUpperCase() });
  return { default: def, list };
}

/**
 * Validates the new keys of a settings patch; keys it does not know are passed through (the older settings were never validated).
 * Returns the patch to merge into the settings.
 */
export function cleanSiteSettings(patch: Record<string, any>, current: Record<string, any> = {}): Record<string, any> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Einstellungen: ein Objekt erwartet');
  const out: Record<string, any> = { ...patch };
  if ('tokens' in patch) {
    if (patch.tokens === null) out.tokens = undefined;
    else out.tokens = cleanTokens(patch.tokens, tokensOf(current));
  }
  if ('menus' in patch) out.menus = cleanMenus(patch.menus);
  if ('header' in patch) out.header = cleanHeader(patch.header, current.header);
  if ('footer' in patch) out.footer = cleanFooter(patch.footer, current.footer);
  if ('languages' in patch) out.languages = cleanLanguages(patch.languages);
  if ('search' in patch) out.search = { enabled: bool(patch.search?.enabled) };
  if ('not_found' in patch) {
    const n = patch.not_found ?? {};
    out.not_found = { page_id: /^[A-Za-z0-9]{1,40}$/.test(String(n.page_id ?? '')) ? String(n.page_id) : '', heading: str(n.heading, 120), text: str(n.text, 600) };
  }
  if ('analytics' in patch) {
    const a = patch.analytics ?? {};
    const days = Math.round(Number(a.retention_days));
    out.analytics = { enabled: a.enabled !== false && a.enabled !== 'false', respect_dnt: a.respect_dnt !== false, retention_days: Number.isFinite(days) ? Math.min(730, Math.max(30, days)) : 180 };
  }
  if ('color' in patch && patch.color && !isColor(patch.color)) out.color = current.color;
  return out;
}

/** Per-page options: header/footer switched off, the page's language and the key that ties translations of one page together. */
export function cleanPageLayout(v: any, cur: Record<string, any> = {}): Record<string, any> {
  const l = { ...cur, ...(v && typeof v === 'object' ? v : {}) };
  const out: Record<string, any> = {};
  if (l.header === false || l.header === 'false') out.header = false;
  if (l.footer === false || l.footer === 'false') out.footer = false;
  if (LANG.test(String(l.lang ?? ''))) out.lang = String(l.lang);
  if (/^[A-Za-z0-9_-]{1,40}$/.test(String(l.group ?? ''))) out.group = String(l.group);
  return out;
}
