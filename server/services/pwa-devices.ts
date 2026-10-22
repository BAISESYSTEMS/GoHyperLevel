/**
 * iOS device table, launch-image links and home-screen <head> lines (docs/ios-web-app.md). No imports on purpose: the web build
 * (scripts/vite-ios-head.ts) pulls this file into vite.config.ts, the server draws the pictures (pwa-ios.ts).
 */

export const DEFAULT_NAME = 'HyperLevel';
export type Scheme = 'light' | 'dark';
export const SCHEMES: Scheme[] = ['light', 'dark'];
/** Launch image background = the app's own page background, so launch → app has no flash. */
export const SPLASH_BG: Record<Scheme, [number, number, number]> = { light: [0xf4, 0xf6, 0xfa], dark: [0x0b, 0x10, 0x20] };

// --- devices -------------------------------------------------------------------------------------------------------------

export interface IosDevice {
  id: string;
  label: string;
  /** CSS size in portrait (what `device-width` / `device-height` report on iOS, whatever the orientation). */
  w: number;
  h: number;
  dpr: number;
  tablet?: boolean;
  /** Values published by third parties before Apple documented them – treat as estimates. */
  estimate?: boolean;
}

/** One entry per distinct screen (several models share one). Sizes: Apple's published CSS viewports. */
export const IOS_DEVICES: IosDevice[] = [
  { id: 'iphone-se1', label: 'iPhone SE (1. Gen.), 5s', w: 320, h: 568, dpr: 2 },
  { id: 'iphone-8', label: 'iPhone SE (2./3. Gen.), 8, 7, 6s', w: 375, h: 667, dpr: 2 },
  { id: 'iphone-8-plus', label: 'iPhone 8 Plus, 7 Plus, 6s Plus', w: 414, h: 736, dpr: 3 },
  { id: 'iphone-x', label: 'iPhone X, XS, 11 Pro, 12/13 mini', w: 375, h: 812, dpr: 3 },
  { id: 'iphone-11', label: 'iPhone 11, XR', w: 414, h: 896, dpr: 2 },
  { id: 'iphone-11-pro-max', label: 'iPhone 11 Pro Max, XS Max', w: 414, h: 896, dpr: 3 },
  { id: 'iphone-12', label: 'iPhone 12, 13, 14, 16e', w: 390, h: 844, dpr: 3 },
  { id: 'iphone-12-pro-max', label: 'iPhone 12/13 Pro Max, 14 Plus', w: 428, h: 926, dpr: 3 },
  { id: 'iphone-15', label: 'iPhone 14 Pro, 15, 15 Pro, 16', w: 393, h: 852, dpr: 3 },
  { id: 'iphone-15-pro-max', label: 'iPhone 14 Pro Max, 15 Plus/Pro Max, 16 Plus', w: 430, h: 932, dpr: 3 },
  { id: 'iphone-16-pro', label: 'iPhone 16 Pro, 17, 17 Pro', w: 402, h: 874, dpr: 3 },
  { id: 'iphone-16-pro-max', label: 'iPhone 16 Pro Max, 17 Pro Max', w: 440, h: 956, dpr: 3 },
  { id: 'iphone-air', label: 'iPhone Air', w: 420, h: 912, dpr: 3 },
  // iPhone Duo (foldable, 2026). Third-party figures (webmobilefirst.com, screensize.io): folded 466 × 678, unfolded 890 × 626 (landscape
  // as the screen is held open), 3×. Apple had not published browser values yet – the layout never depends on these numbers, only the
  // launch images do, and a missing match just shows iOS's plain launch screen.
  { id: 'iphone-duo-folded', label: 'iPhone Duo (zugeklappt)', w: 466, h: 678, dpr: 3, estimate: true },
  { id: 'iphone-duo-open', label: 'iPhone Duo (aufgeklappt)', w: 626, h: 890, dpr: 3, estimate: true },
  { id: 'ipad-9-7', label: 'iPad 9.7", Air 2, mini 4/5', w: 768, h: 1024, dpr: 2, tablet: true },
  { id: 'ipad-10-2', label: 'iPad 10.2" (7.–9. Gen.)', w: 810, h: 1080, dpr: 2, tablet: true },
  { id: 'ipad-mini-6', label: 'iPad mini 6, 7', w: 744, h: 1133, dpr: 2, tablet: true },
  { id: 'ipad-10-5', label: 'iPad Pro 10.5", Air 3', w: 834, h: 1112, dpr: 2, tablet: true },
  { id: 'ipad-air-10-9', label: 'iPad 10, Air 4/5, Air 11"', w: 820, h: 1180, dpr: 2, tablet: true },
  { id: 'ipad-pro-11', label: 'iPad Pro 11" (1.–4. Gen.)', w: 834, h: 1194, dpr: 2, tablet: true },
  { id: 'ipad-pro-11-m4', label: 'iPad Pro 11" (M4)', w: 834, h: 1210, dpr: 2, tablet: true },
  { id: 'ipad-pro-12-9', label: 'iPad Pro 12.9", Air 13"', w: 1024, h: 1366, dpr: 2, tablet: true },
  { id: 'ipad-pro-13', label: 'iPad Pro 13" (M4)', w: 1032, h: 1376, dpr: 2, tablet: true },
];

export type Orientation = 'portrait' | 'landscape';

export interface SplashSpec {
  /** Pixel size of the picture. */
  px: number;
  py: number;
  device: IosDevice;
  orientation: Orientation;
}

export const splashSpecs = (): SplashSpec[] =>
  IOS_DEVICES.flatMap((device) =>
    (['portrait', 'landscape'] as const).map((orientation) => {
      const a = device.w * device.dpr;
      const b = device.h * device.dpr;
      return { device, orientation, px: orientation === 'portrait' ? a : b, py: orientation === 'portrait' ? b : a };
    }),
  );

export const splashFile = (px: number, py: number, scheme: Scheme) => `${px}x${py}-${scheme}.png`;

/** Sizes the server draws (anything else is refused – the route must not be a way to ask for huge images). */
export const SPLASH_SIZES = new Set(splashSpecs().map((s) => `${s.px}x${s.py}`));

export function parseSplashFile(file: string): { px: number; py: number; scheme: Scheme } | null {
  const m = /^(\d{3,4})x(\d{3,4})-(light|dark)\.png$/.exec(file);
  if (!m || !SPLASH_SIZES.has(`${m[1]}x${m[2]}`)) return null;
  return { px: Number(m[1]), py: Number(m[2]), scheme: m[3] as Scheme };
}

// --- <head> ---------------------------------------------------------------------------------------------------------------

export const TOUCH_SIZES = [120, 152, 167, 180] as const;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const splashMedia = (s: SplashSpec, scheme: Scheme) =>
  `(device-width: ${s.device.w}px) and (device-height: ${s.device.h}px) and (-webkit-device-pixel-ratio: ${s.device.dpr}) and (orientation: ${s.orientation}) and (prefers-color-scheme: ${scheme})`;

/**
 * The lines every page of the installed app needs on iOS: standalone launch, name, touch icons in every size iOS asks for and
 * the launch images for current iPhones, iPads and foldables in light and dark. Lines stay one per tag (diff-friendly).
 */
export function iosHead(opts: { name?: string; statusBar?: 'default' | 'black' | 'black-translucent' } = {}): string {
  const lines = [
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="mobile-web-app-capable" content="yes" />',
    `<meta name="apple-mobile-web-app-title" content="${esc(opts.name ?? DEFAULT_NAME)}" />`,
    // "default": the status bar keeps its own light/dark look. "black-translucent" would draw white text over our light header.
    `<meta name="apple-mobile-web-app-status-bar-style" content="${opts.statusBar ?? 'default'}" />`,
    '<meta name="apple-touch-fullscreen" content="yes" />',
    '<link rel="apple-touch-icon" href="/pwa/icon/icon-180.png" />',
    ...TOUCH_SIZES.map((n) => `<link rel="apple-touch-icon" sizes="${n}x${n}" href="/pwa/icon/icon-${n}.png" />`),
    // Headsets (Vision Pro home view, Quest, Android XR) show launcher icons large: docs/xr.md
    '<link rel="apple-touch-icon" sizes="1024x1024" href="/pwa/icon/icon-1024.png" />',
  ];
  for (const scheme of SCHEMES) {
    for (const s of splashSpecs()) lines.push(`<link rel="apple-touch-startup-image" media="${splashMedia(s, scheme)}" href="/pwa/splash/${splashFile(s.px, s.py, scheme)}" />`);
  }
  return lines.join('\n    ');
}

/** What to replace in web/index.html (the build does it, scripts/vite-ios-head.ts). */
export const IOS_HEAD_MARKER = '<!--ios-head-->';

