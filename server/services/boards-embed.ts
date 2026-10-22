/**
 * Living Boards: which addresses the embed widget may show. Only https, no credentials, no port, no IP addresses,
 * and the host must be on the allow-list: a built-in list of common embeddable services plus whatever the agency adds
 * (Boards → Einbettungen). The check runs when a config is saved AND every time the widget's data is read, so
 * removing a host takes effect at once. Pure – the module reads the list from agency_settings.
 */

export const DEFAULT_EMBED_HOSTS = [
  'youtube.com',
  'youtube-nocookie.com',
  'player.vimeo.com',
  'loom.com',
  'docs.google.com',
  'calendar.google.com',
  'lookerstudio.google.com',
  'drive.google.com',
  'miro.com',
  'embed.figma.com',
  'calendly.com',
  'cal.com',
  'airtable.com',
  'notion.site',
];

const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** A host name as people type it ("https://Docs.Example.com/x", "example.com") → "docs.example.com", or null. */
export function cleanHost(v: unknown): string | null {
  let s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  // "www." adds nothing: a listed domain covers its subdomains anyway.
  s = s.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');
  return HOST.test(s) ? s : null;
}

export const hostAllowed = (host: string, allowed: string[]) => allowed.some((d) => host === d || host.endsWith(`.${d}`));

export interface EmbedCheck {
  ok: boolean;
  url?: string;
  host?: string;
  problem?: string;
}

/** Share links people paste are rewritten to the address the service allows in a frame. */
function embeddable(u: URL): string {
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const v = u.pathname === '/watch' ? u.searchParams.get('v') : /^\/(embed|shorts)\/([\w-]{6,20})/.exec(u.pathname)?.[2];
    if (v && /^[\w-]{6,20}$/.test(v)) return `https://www.youtube-nocookie.com/embed/${v}`;
  }
  if (host === 'youtu.be') {
    const v = u.pathname.slice(1);
    if (/^[\w-]{6,20}$/.test(v)) return `https://www.youtube-nocookie.com/embed/${v}`;
  }
  if (host === 'vimeo.com') {
    const v = /^\/(\d{5,12})/.exec(u.pathname)?.[1];
    if (v) return `https://player.vimeo.com/video/${v}`;
  }
  if (host === 'loom.com') {
    const v = /^\/share\/([a-f0-9]{20,40})/.exec(u.pathname)?.[1];
    if (v) return `https://www.loom.com/embed/${v}`;
  }
  return u.toString();
}

/** Is this address fine to show in a frame, and what exactly is shown? */
export function checkEmbedUrl(input: unknown, allowed: string[]): EmbedCheck {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, problem: 'Adresse fehlt' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, problem: 'Das ist keine gültige Adresse' };
  }
  if (u.protocol !== 'https:') return { ok: false, problem: 'Es sind nur https-Adressen erlaubt' };
  if (u.username || u.password) return { ok: false, problem: 'Adressen mit Zugangsdaten sind nicht erlaubt' };
  if (u.port) return { ok: false, problem: 'Adressen mit eigenem Port sind nicht erlaubt' };
  const host = u.hostname.toLowerCase();
  if (!HOST.test(host) || /^\d+(\.\d+)*$/.test(host)) return { ok: false, problem: 'IP-Adressen und interne Namen sind nicht erlaubt' };
  // What is shown is the rewritten address (a share link becomes the service's embed address), so that host must be allowed.
  const out = embeddable(u);
  const shown = new URL(out).hostname.toLowerCase();
  if (!hostAllowed(shown, allowed)) return { ok: false, host: shown, problem: `${shown} ist nicht freigegeben – ein Admin kann die Adresse unter Boards → Einbettungen erlauben` };
  if (out.length > 600) return { ok: false, problem: 'Die Adresse ist zu lang' };
  return { ok: true, url: out, host: shown };
}
