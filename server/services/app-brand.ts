/**
 * The gray-label app's view of an instance (docs/apps.md#discovery): what `/.well-known/gohyperlevel-app.json` answers, plus
 * the small parsers the directory uses. Pure – no database, no network.
 */

export const APP_CONFIG_SCHEMA = 1;

const HEX = /^#[0-9a-f]{6}$/i;

/** Relative luminance (WCAG) of #rrggbb. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Black or white, whichever reads better on `hex`. */
export function onColor(hex: string): string {
  const l = luminance(hex);
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000000' : '#ffffff';
}

/** "/uploads/x.png" → "https://crm.example.com/uploads/x.png"; only http(s) addresses survive. */
export function absoluteUrl(base: string, v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/') && !s.startsWith('//')) return `${base}${s}`;
  return null;
}

export interface BrandInput {
  name?: string;
  logo_url?: string;
  logo_dark_url?: string;
  mark_url?: string;
  mark_dark_url?: string;
  color?: string;
  support_email?: string;
}

export interface PushInfo {
  mode: 'relay' | 'own' | 'off';
  content: 'generic' | 'preview';
  providers: string[];
}

/** The document the apps read (Android, iOS, desktop): name, images, colours, where the API is, how push works. */
export function appConfig(b: BrandInput, base: string, push: PushInfo, iconKey = '') {
  const name = String(b.name ?? '').trim().slice(0, 60) || 'HyperLevel';
  const primary = HEX.test(b.color ?? '') ? String(b.color).toLowerCase() : '#2563eb';
  const v = iconKey ? `?v=${iconKey}` : '';
  return {
    schema: APP_CONFIG_SCHEMA,
    name,
    short_name: name.length <= 12 ? name : name.split(/\s+/)[0].slice(0, 12),
    logo: absoluteUrl(base, b.logo_url),
    logo_dark: absoluteUrl(base, b.logo_dark_url) ?? absoluteUrl(base, b.logo_url),
    mark: absoluteUrl(base, b.mark_url),
    icon: `${base}/pwa/icon/icon-512.png${v}`,
    colors: {
      primary,
      on_primary: onColor(primary),
      background: '#ffffff',
      background_dark: '#0b1220',
    },
    api_base: base,
    web_url: `${base}/app`,
    support_email: String(b.support_email ?? '').trim() || null,
    push,
  };
}

/** "Max@Agentur.de" → "agentur.de"; '' when it is no e-mail address. */
export function emailDomain(v: unknown): string {
  const m = String(v ?? '').trim().toLowerCase().match(/^[^@\s]+@([a-z0-9-]+(\.[a-z0-9-]+)+)$/);
  return m ? m[1] : '';
}

/** A bare domain ("agentur.de"), lower-case; '' when invalid. */
export function cleanDomain(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  return /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}

/** Agency code as people type it ("muster-agentur " → "MUSTER-AGENTUR"); '' when invalid. */
export function cleanCode(v: unknown): string {
  const s = String(v ?? '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{2,31}$/.test(s) ? s : '';
}

/** An instance address: https (http only for localhost), no path; '' when invalid. */
export function cleanInstanceUrl(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(s);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return '';
    if (u.username || u.password || (u.pathname && u.pathname !== '/') || u.search || u.hash) return '';
    return u.origin;
  } catch {
    return '';
  }
}
