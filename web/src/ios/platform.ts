/**
 * What the installed app on iPhone, iPad and foldables needs to know about its surroundings – pure functions (the DOM
 * wiring is in viewport.ts), so every rule has a test (tests/ios-logic.test.ts). Layout is chosen by WIDTH only (never by
 * user agent): the same code serves a phone, an iPad in Split View, a Stage Manager window and a foldable that opens.
 */

export interface NavLike {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  /** Safari's own flag for "opened from the home screen". */
  standalone?: boolean;
}

// --- device and browser --------------------------------------------------------------------------------------------------------

/** iPhone, iPod, iPad – and iPadOS 13+, which calls itself a Mac but has a touch screen. */
export function isIosDevice(n: NavLike): boolean {
  return /iPhone|iPad|iPod/.test(n.userAgent) || (n.platform === 'MacIntel' && (n.maxTouchPoints ?? 0) > 1);
}

/** [major, minor] of iOS/iPadOS from "OS 17_4_1" or (iPad posing as a Mac) "Version/17.4"; null when unknown. */
export function iosVersion(n: NavLike): [number, number] | null {
  const m = /\bOS (\d+)[_.](\d+)/.exec(n.userAgent) ?? /\bOS (\d+)\b/.exec(n.userAgent) ?? /Version\/(\d+)\.(\d+)/.exec(n.userAgent) ?? /Version\/(\d+)\b/.exec(n.userAgent);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

export const atLeast = (v: [number, number] | null, major: number, minor = 0) => !!v && (v[0] > major || (v[0] === major && v[1] >= minor));

/** Web Push works from the installed app on iOS/iPadOS 16.4 and later. */
export const IOS_PUSH_MIN: [number, number] = [16, 4];

/** How a person on iOS can add the app: Safari's share menu, another browser's share menu (iOS 16.4+), or not from here at all (in-app browsers). */
export type InstallMethod = 'safari' | 'other-browser' | 'in-app';
export function installMethod(n: NavLike): InstallMethod | null {
  if (!isIosDevice(n)) return null;
  // Browsers inside other apps (Facebook, Instagram, LinkedIn, Gmail …) have no "Add to Home Screen".
  if (/FBAN|FBAV|Instagram|Line\/|LinkedInApp|GSA\/|Snapchat|Twitter|MicroMessenger|TikTok|Pinterest/.test(n.userAgent)) return 'in-app';
  if (/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|Brave/.test(n.userAgent)) return atLeast(iosVersion(n), 16, 4) ? 'other-browser' : 'in-app';
  return /Safari/.test(n.userAgent) ? 'safari' : 'in-app';
}

/** Started from the home screen (iOS flag, or the standard display-mode). */
export function isStandalone(n: Pick<NavLike, 'standalone'>, matches: (query: string) => boolean): boolean {
  return n.standalone === true || matches('(display-mode: standalone)') || matches('(display-mode: fullscreen)');
}

/** Inside the Android app (it has its own navigation; the web bottom bar would double it). */
export const isNativeShell = (n: Pick<NavLike, 'userAgent'>) => /GoHighApp\//.test(n.userAgent);

// --- width classes -------------------------------------------------------------------------------------------------------------------

export type SizeClass = 'compact' | 'medium' | 'expanded';
/** Phones, a foldable folded (466 px), iPad Slide Over and 1/3 Split View (320–507 px): bottom bar and drawer. */
export const COMPACT_MAX = 600;
/** From here the full sidebar fits next to the page (iPad landscape 1024+): below it, from 600 px, a rail of icons stays on screen. */
export const EXPANDED_MIN = 1024;
export const sizeClass = (width: number): SizeClass => (width < COMPACT_MAX ? 'compact' : width < EXPANDED_MIN ? 'medium' : 'expanded');
/** Media queries (fractional widths of zoomed or scaled windows leave no gap between the classes). */
export const COMPACT_QUERY = `(max-width: ${COMPACT_MAX - 0.02}px)`;
export const EXPANDED_QUERY = `(min-width: ${EXPANDED_MIN}px)`;
/** Two panes (list + detail) from here, measured on the whole window: 600 px rail layout minus the rail leaves ~650 px for the page. */
export const TWO_PANE_MIN = 720;

// --- keyboard ---------------------------------------------------------------------------------------------------------------------------

/** The software keyboard shrinks the visual viewport but not the layout viewport on iOS. Smaller changes are the browser's toolbars. */
export const KEYBOARD_MIN = 120;

/** Height the on-screen keyboard covers (0 when none, or while pinch-zoomed, which also shrinks the visual viewport). */
export function keyboardInset(v: { innerHeight: number; vvHeight: number; vvTop?: number; vvScale?: number }): number {
  if ((v.vvScale ?? 1) > 1.05) return 0;
  const covered = v.innerHeight - v.vvHeight - (v.vvTop ?? 0);
  return covered >= KEYBOARD_MIN ? Math.round(covered) : 0;
}

// --- foldables: the hinge, if the browser tells us (it need not) ---------------------------------------------------------------------

export interface Segments {
  count: number;
  /** 'vertical' fold = two panes side by side (a book), 'horizontal' = stacked (a laptop). */
  fold: 'vertical' | 'horizontal' | null;
  /** Gap between the segments in px (0 when unknown). */
  gap: number;
}

interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Reads the CSS Viewport Segments information defensively: `visualViewport.segments` (older drafts) or the media features
 * `horizontal-viewport-segments` / `vertical-viewport-segments`. Safari does not publish any of it yet; the layout never needs it,
 * it only keeps a two-pane view from straddling a hinge where one exists.
 */
export function readSegments(win: { visualViewport?: { segments?: RectLike[] | null } | null; matchMedia?: (q: string) => { matches: boolean } }): Segments {
  const none: Segments = { count: 1, fold: null, gap: 0 };
  try {
    const seg = win.visualViewport?.segments;
    if (Array.isArray(seg) && seg.length > 1) {
      const [a, b] = seg;
      const vertical = b.left >= a.right - 0.5 && Math.abs(a.top - b.top) < 1;
      return { count: seg.length, fold: vertical ? 'vertical' : 'horizontal', gap: Math.max(0, Math.round(vertical ? b.left - a.right : b.top - a.bottom)) };
    }
    const mq = win.matchMedia;
    if (mq?.('(horizontal-viewport-segments: 2)').matches) return { count: 2, fold: 'vertical', gap: 0 };
    if (mq?.('(vertical-viewport-segments: 2)').matches) return { count: 2, fold: 'horizontal', gap: 0 };
  } catch {
    /* an old or unusual browser: one piece of screen */
  }
  return none;
}
