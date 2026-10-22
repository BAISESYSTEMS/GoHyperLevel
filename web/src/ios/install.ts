import { type NavLike, installMethod, isNativeShell, isStandalone, type InstallMethod } from './platform';

/**
 * When to offer "Zum Home-Bildschirm hinzufügen" on iPhone and iPad (pure logic, tests: tests/ios-logic.test.ts).
 * Never inside the installed app, in the Android app or on other systems; after "Später" it stays away for 2 weeks, then
 * for 2 months; "Nicht mehr zeigen" (or a third "Später") ends it for good. Remembered per person on this device.
 */

export interface InstallState {
  /** How often it was closed. */
  closed: number;
  /** Stay away until (ms since 1970). */
  until: number;
  never: boolean;
}

const DAY = 864e5;
/** Pauses after the first, second … "Später". */
export const SNOOZE_DAYS = [14, 60];
export const MAX_CLOSES = 3;
export const EMPTY_STATE: InstallState = { closed: 0, until: 0, never: false };

export const installKey = (userId: string) => `pghl.ios.install.${userId}`;

export function parseState(raw: string | null | undefined): InstallState {
  try {
    const v = JSON.parse(raw ?? 'null');
    if (v && typeof v === 'object') return { closed: Math.max(0, Number(v.closed) || 0), until: Math.max(0, Number(v.until) || 0), never: v.never === true };
  } catch {
    /* damaged: start over */
  }
  return { ...EMPTY_STATE };
}

export function closeSheet(s: InstallState, now: number, forever = false): InstallState {
  const closed = s.closed + 1;
  const never = forever || s.never || closed >= MAX_CLOSES;
  return { closed, never, until: now + SNOOZE_DAYS[Math.min(closed - 1, SNOOZE_DAYS.length - 1)] * DAY };
}

export interface InstallEnv {
  nav: NavLike;
  matches: (query: string) => boolean;
}

/** Which way to show it, or null when it should not be offered at all (not iOS, already installed, in the Android app …). */
export function installOffer(env: InstallEnv, state: InstallState, now: number): InstallMethod | null {
  if (isStandalone(env.nav, env.matches) || isNativeShell(env.nav)) return null;
  if (state.never || state.until > now) return null;
  return installMethod(env.nav);
}

/** The steps, as words (the sheet draws the share icon next to the first). `ipad`: the share button sits at the top there. */
export function installSteps(method: InstallMethod, ipad: boolean): string[] {
  if (method === 'in-app') return ['Öffne diese Seite in Safari (Link kopieren oder „In Safari öffnen“ im Menü dieser App).', 'Danach: Teilen → „Zum Home-Bildschirm“.'];
  const share = method === 'safari' ? (ipad ? 'Tippe oben rechts auf Teilen (Quadrat mit Pfeil nach oben).' : 'Tippe unten auf Teilen (Quadrat mit Pfeil nach oben). Fehlt es, steht es unter ⋯.') : 'Tippe im Browser auf Teilen (Quadrat mit Pfeil nach oben) oder ⋯.';
  return [share, 'Wische nach unten und wähle „Zum Home-Bildschirm“.', 'Lass „Als Web-App öffnen“ eingeschaltet und tippe auf „Hinzufügen“.', 'Öffne die App künftig vom Home-Bildschirm – nur dort gibt es Mitteilungen und Badge.'];
}
