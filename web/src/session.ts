import { createContext, useContext } from 'react';
import { setBrandColor } from './theme/store';

export interface Branding {
  name: string;
  logo_url: string;
  /** Logo for dark sidebars, square marks for the narrow sidebar, 'no' = app name hidden next to the logo. */
  logo_dark_url: string;
  mark_url: string;
  mark_dark_url: string;
  show_name: string;
  favicon_url: string;
  color: string;
  login_title: string;
  login_text: string;
  support_email: string;
}

export interface Session {
  user: { id: string; email: string; name: string; role: 'admin' | 'member'; permissions: string[] | null };
  locations: { id: string; name: string; timezone: string }[];
  locationId: string;
  branding: Branding;
  /** SaaS mode: the sub-account's plan state (areas the plan hides, billing banner); null = no plan. */
  saas?: { plan: unknown; blocked: string[]; banner: unknown } | null;
  /** Back-Office HR: what this login is in the sub-account (HR staff, employee, manager) – null while loading. */
  hr?: { is_hr: boolean; employee: boolean; is_manager: boolean } | null;
  reload: () => Promise<void>;
  switchLocation: (id: string, page?: string) => void;
}

export const SessionCtx = createContext<Session | null>(null);
export const useSession = () => useContext(SessionCtx)!;

/** Whether the signed-in user may use an area (admins and unrestricted members: everything, unless the SaaS plan leaves it out). */
export function can(s: Pick<Session, 'user'> & { saas?: Session['saas']; hr?: Session['hr'] }, perm: string): boolean {
  // '*' = open to everyone signed in (e.g. the academy).
  if (perm === '*') return true;
  // 'hr' = the Personal page: HR staff, and everybody who is an employee or manager (own record only). HR needs the area explicitly.
  if (perm === 'hr') return !s.saas?.blocked?.includes('personal') && !!(s.hr && (s.hr.is_hr || s.hr.employee || s.hr.is_manager));
  if (s.saas?.blocked?.includes(perm)) return false;
  return s.user.role === 'admin' || !s.user.permissions || s.user.permissions.includes(perm);
}

export const DEFAULT_BRANDING: Branding = { name: 'HyperLevel', logo_url: '', logo_dark_url: '', mark_url: '', mark_dark_url: '', show_name: '', favicon_url: '', color: '#2563eb', login_title: '', login_text: '', support_email: '' };

/** Puts the agency's name, colour and icon on the page. */
export function applyBranding(b: Branding) {
  document.title = b.name;
  // iOS reads the name for the home-screen icon from here when the app is added.
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', b.name);
  // The agency's colour is the accent of the standard theme (theme/css.ts), not an inline override of everything.
  setBrandColor(/^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '');
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const fav = b.favicon_url || b.mark_url;
  if (icon && fav) {
    icon.href = fav;
    icon.type = /\.svg(\?|$)/i.test(fav) ? 'image/svg+xml' : /\.webp(\?|$)/i.test(fav) ? 'image/webp' : 'image/png';
  }
}

/**
 * Deep links from the Android app (/app/tasks?loc=<id>): the sub-account to open first, if the user
 * may see it. Takes ?loc out of the address either way.
 */
export function takeLocParam(locations: { id: string }[]): string | undefined {
  const q = new URLSearchParams(location.search);
  const want = q.get('loc');
  if (want === null) return undefined;
  q.delete('loc');
  const rest = q.toString();
  history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  return locations.some((l) => l.id === want) ? want : undefined;
}
