import type { SpatialMode } from '../../../server/services/appearance-model';

/**
 * Which XR device is this? Pure code (no DOM) so it can be tested with real user-agent strings; the thin wrapper at the
 * bottom reads the browser. Used by the theme store (Raum-Modus "Automatisch"), the Darstellung page and the XR button.
 *
 * Strong signals switch the Raum-Modus on by themselves; a weak one (the browser offers WebXR, e.g. a desktop with a
 * headset or the WebXR emulator) only shows a hint. User-agent strings of headsets change between releases, so the
 * manual switch (Darstellung → Raum-Modus: An) is always there – docs/xr.md lists what each device sends.
 */

export type XrDevice = 'visionos' | 'quest' | 'pico' | 'android-xr' | 'wolvic';

export interface XrDetection {
  device: XrDevice;
  /** For people ("Apple Vision Pro"). */
  label: string;
  /** What gave it away, for the support page. */
  by: 'user-agent' | 'webxr-safari';
}

export interface XrHints {
  ua: string;
  /** navigator.userAgentData?.platform (Chromium) */
  platform?: string;
  /** `'xr' in navigator` – Safari ships WebXR on visionOS only. */
  xr?: boolean;
}

export const XR_LABELS: Record<XrDevice, string> = {
  visionos: 'Apple Vision Pro',
  quest: 'Meta Quest',
  pico: 'Pico',
  'android-xr': 'Android XR',
  wolvic: 'Wolvic',
};

const found = (device: XrDevice, by: XrDetection['by'] = 'user-agent'): XrDetection => ({ device, label: XR_LABELS[device], by });

export function detectXr(h: XrHints): XrDetection | null {
  const ua = h.ua ?? '';
  // Meta Quest Browser: "… OculusBrowser/33.0 … VR Safari/537.36" (also "Quest 3")
  if (/OculusBrowser|Meta ?Quest|\bQuest ?[123Pp]|\bVR Safari\b/i.test(ua)) return found('quest');
  if (/PicoBrowser|\bPICO ?(?:4|Neo|G)|\bPico ?OS\b/i.test(ua)) return found('pico');
  // Wolvic runs on Quest, Pico and others: "Mozilla/5.0 (Android 12; Mobile VR; rv:…) … Wolvic/1.5"
  if (/Wolvic|FirefoxReality/i.test(ua)) return found('wolvic');
  // Android XR (Chrome on the headset): the platform says so, or the user agent names XR next to Android.
  if (/android xr/i.test(h.platform ?? '') || /Android XR|AndroidXR|Galaxy XR|\bSM-I\d{3}\b|\bXR\b[^)]*\bAndroid|\bAndroid\b[^)]*\bXR\b/i.test(ua)) return found('android-xr');
  // visionOS Safari: some releases name it …
  if (/visionOS|Vision ?Pro|AppleVision|\bxrOS\b/i.test(ua)) return found('visionos');
  // … and the rest look like Safari on a Mac – but only the headset's Safari has WebXR (macOS and iOS Safari do not).
  if (h.xr && /\bSafari\//.test(ua) && /Macintosh|Mac OS X|iPad|iPhone/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\//.test(ua)) return found('visionos', 'webxr-safari');
  return null;
}

/** Does the Raum-Modus apply? "auto" follows the device, "on" and "off" are the person's word. */
export const spatialActive = (mode: SpatialMode, detection: XrDetection | null): boolean => mode === 'on' || (mode === 'auto' && !!detection);

// --- the browser ----------------------------------------------------------------------------------------------

let cached: { value: XrDetection | null } | undefined;

/** Reads this browser once (the answer cannot change during a visit). */
export function currentXr(): XrDetection | null {
  if (cached) return cached.value;
  let value: XrDetection | null = null;
  try {
    if (typeof navigator !== 'undefined') value = detectXr({ ua: navigator.userAgent, platform: (navigator as any).userAgentData?.platform, xr: 'xr' in navigator });
  } catch {
    /* a locked-down browser: no XR */
  }
  cached = { value };
  return value;
}

/** Test hook: forget the cached answer. */
export const resetXrDetection = () => {
  cached = undefined;
};

export interface XrSupport {
  vr: boolean;
  ar: boolean;
}

/** Does this browser offer an immersive session (headset browser, or a desktop with a headset / the WebXR emulator)? */
export async function xrSupport(): Promise<XrSupport> {
  const xr = (typeof navigator !== 'undefined' ? (navigator as any).xr : undefined) as { isSessionSupported?: (m: string) => Promise<boolean> } | undefined;
  if (!xr?.isSessionSupported) return { vr: false, ar: false };
  const ask = (mode: string) => xr.isSessionSupported!(mode).catch(() => false);
  const [vr, ar] = await Promise.all([ask('immersive-vr'), ask('immersive-ar')]);
  return { vr, ar };
}

let webgl2: boolean | undefined;

/** Can the browser draw the 3D preview at all? (WebGL2 is the only requirement of the in-house renderer.) Asked once; the test context is released. */
export function hasWebGL2(): boolean {
  if (webgl2 !== undefined) return webgl2;
  try {
    const gl = typeof document === 'undefined' ? null : (document.createElement('canvas').getContext('webgl2') as WebGL2RenderingContext | null);
    webgl2 = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl2 = false;
  }
  return webgl2;
}
