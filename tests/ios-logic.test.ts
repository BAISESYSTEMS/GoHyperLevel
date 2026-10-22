import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { iosHeadPlugin } from '../scripts/vite-ios-head';
import { IOS_HEAD_MARKER } from '../server/services/pwa-devices';
import { EMPTY_STATE, MAX_CLOSES, SNOOZE_DAYS, closeSheet, installKey, installOffer, installSteps, parseState } from '../web/src/ios/install';
import { atLeast, installMethod, iosVersion, isIosDevice, isNativeShell, isStandalone, keyboardInset, readSegments, sizeClass, COMPACT_QUERY, TWO_PANE_MIN } from '../web/src/ios/platform';
import { pushCopy, pushStep, type PushEnv } from '../web/src/ios/push-flow';
import { canShareFile, canShareLink, saveBlob, shareLink } from '../web/src/ios/share';
import { HOLD_HINT_MS, matchShortcut, modKey, shortcutRows } from '../web/src/ios/shortcuts';
import { pickTabs } from '../web/src/ios/tabs';

/**
 * The installed app on iPhone, iPad and foldables, client side (docs/ios-web-app.md): detection, the install hint (iOS, standalone,
 * dismissal), where a person is on the way to push messages, the badge, the share sheet, the keyboard, width classes and the fold,
 * and the guards in the CSS (dvh, no zoom-on-focus, balanced braces). The layout itself is checked in a real browser:
 * `npm run ios:shots` (screenshots and the fold/unfold continuity check).
 */

const ROOT = resolve(__dirname, '..');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
/** iPadOS 13+ in "desktop website" mode, which is the default: it says Macintosh. */
const IPAD_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const MAC = IPAD_AS_MAC;
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/121.0.6167.138 Mobile/15E148 Safari/604.1';
const CHROME_IOS_OLD = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/110.0.5481.83 Mobile/15E148 Safari/604.1';
const INSTAGRAM = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E219 Instagram 330.0.0.20.113';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Mobile Safari/537.36 GoHighApp/1.0.12';

describe('device and browser', () => {
  it('knows iPhones and iPads – also the iPad that calls itself a Mac', () => {
    expect(isIosDevice({ userAgent: IPHONE })).toBe(true);
    expect(isIosDevice({ userAgent: IPAD })).toBe(true);
    expect(isIosDevice({ userAgent: IPAD_AS_MAC, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isIosDevice({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
    expect(isIosDevice({ userAgent: ANDROID })).toBe(false);
  });

  it('reads the iOS version, also from an iPad posing as a Mac', () => {
    expect(iosVersion({ userAgent: IPHONE })).toEqual([17, 4]);
    expect(iosVersion({ userAgent: IPAD })).toEqual([16, 6]);
    expect(iosVersion({ userAgent: IPAD_AS_MAC })).toEqual([17, 4]);
    expect(iosVersion({ userAgent: 'nonsense' })).toBeNull();
    expect(atLeast([16, 4], 16, 4)).toBe(true);
    expect(atLeast([16, 3], 16, 4)).toBe(false);
    expect(atLeast([17, 0], 16, 4)).toBe(true);
    expect(atLeast(null, 16, 4)).toBe(false);
  });

  it('tells how the app can be added: Safari, another browser (iOS 16.4+), or not from here', () => {
    expect(installMethod({ userAgent: IPHONE })).toBe('safari');
    expect(installMethod({ userAgent: IPAD })).toBe('safari');
    expect(installMethod({ userAgent: CHROME_IOS })).toBe('other-browser');
    expect(installMethod({ userAgent: CHROME_IOS_OLD })).toBe('in-app');
    expect(installMethod({ userAgent: INSTAGRAM })).toBe('in-app');
    expect(installMethod({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 })).toBeNull();
    expect(installMethod({ userAgent: ANDROID })).toBeNull();
  });

  it('knows the installed app (iOS flag or display-mode) and the Android shell', () => {
    const no = () => false;
    expect(isStandalone({ standalone: true }, no)).toBe(true);
    expect(isStandalone({}, (q) => q === '(display-mode: standalone)')).toBe(true);
    expect(isStandalone({}, (q) => q === '(display-mode: fullscreen)')).toBe(true);
    expect(isStandalone({ standalone: false }, no)).toBe(false);
    expect(isNativeShell({ userAgent: ANDROID })).toBe(true);
    expect(isNativeShell({ userAgent: IPHONE })).toBe(false);
  });
});

describe('width classes – the layout follows the width, never the user agent', () => {
  it('draws the lines at 600 and 1024 px, through every real screen', () => {
    const at = (w: number) => sizeClass(w);
    // phones, iPad Slide Over and 1/3 Split View, iPhone Duo folded (466 px) -> bottom bar
    for (const w of [320, 375, 390, 393, 430, 466, 507, 599, 599.5]) expect(at(w), String(w)).toBe('compact');
    // iPhone Duo unfolded (626 px upright, 890 px held wide), iPad mini/Air/Pro portrait, 1/2–2/3 Split View -> rail
    for (const w of [600, 626, 678, 744, 768, 820, 834, 890, 1023]) expect(at(w), String(w)).toBe('medium');
    // iPad landscape and desktop -> sidebar
    for (const w of [1024, 1133, 1180, 1194, 1366, 1920, 3440]) expect(at(w), String(w)).toBe('expanded');
    expect(COMPACT_QUERY).toBe('(max-width: 599.98px)');
    // two panes (list + record) from 720 px: the unfolded Duo held upright (626) stays one pane, held wide (890) gets two
    expect(626 < TWO_PANE_MIN && 890 >= TWO_PANE_MIN && 678 < TWO_PANE_MIN && 744 >= TWO_PANE_MIN).toBe(true);
  });
});

describe('keyboard', () => {
  it('counts what the on-screen keyboard covers – not the toolbars of Safari, not pinch zoom', () => {
    expect(keyboardInset({ innerHeight: 852, vvHeight: 852 })).toBe(0);
    expect(keyboardInset({ innerHeight: 852, vvHeight: 516 })).toBe(336);
    // the visual viewport is scrolled by iOS to show the field: the covered part is what is left below it
    expect(keyboardInset({ innerHeight: 852, vvHeight: 400, vvTop: 100 })).toBe(352);
    // Safari's own bars change the height by 50–100 px
    expect(keyboardInset({ innerHeight: 852, vvHeight: 790 })).toBe(0);
    // zoomed in with two fingers: the visual viewport is smaller too
    expect(keyboardInset({ innerHeight: 852, vvHeight: 300, vvScale: 2.8 })).toBe(0);
  });
});

describe('foldables: the hinge, only where a browser reports it', () => {
  it('is one piece of screen when nothing is reported (Safari today) or the browser throws', () => {
    expect(readSegments({})).toEqual({ count: 1, fold: null, gap: 0 });
    expect(readSegments({ visualViewport: null, matchMedia: () => ({ matches: false }) })).toEqual({ count: 1, fold: null, gap: 0 });
    expect(readSegments({ matchMedia: () => { throw new Error('unknown media feature'); } })).toEqual({ count: 1, fold: null, gap: 0 });
  });

  it('reads two segments from visualViewport.segments (side by side = a vertical fold, with the gap)', () => {
    const a = { left: 0, right: 445, top: 0, bottom: 626 };
    const b = { left: 465, right: 890, top: 0, bottom: 626 };
    expect(readSegments({ visualViewport: { segments: [a, b] } })).toEqual({ count: 2, fold: 'vertical', gap: 20 });
    const top = { left: 0, right: 626, top: 0, bottom: 400 };
    const bottom = { left: 0, right: 626, top: 420, bottom: 890 };
    expect(readSegments({ visualViewport: { segments: [top, bottom] } })).toEqual({ count: 2, fold: 'horizontal', gap: 20 });
  });

  it('reads the media features horizontal-/vertical-viewport-segments', () => {
    const has = (q: string) => (x: string) => ({ matches: x.includes(q) });
    expect(readSegments({ matchMedia: has('horizontal-viewport-segments: 2') })).toMatchObject({ count: 2, fold: 'vertical' });
    expect(readSegments({ matchMedia: has('vertical-viewport-segments: 2') })).toMatchObject({ count: 2, fold: 'horizontal' });
  });
});

describe('install hint', () => {
  const env = (ua: string, standalone = false, platform = '', touch = 0) => ({ nav: { userAgent: ua, platform, maxTouchPoints: touch, standalone }, matches: () => false });
  const DAY = 864e5;
  const now = Date.UTC(2026, 9, 5, 9, 0, 0);

  it('is offered in Safari on iPhone and iPad – and never in the installed app, the Android app or on other systems', () => {
    expect(installOffer(env(IPHONE), EMPTY_STATE, now)).toBe('safari');
    expect(installOffer(env(IPAD), EMPTY_STATE, now)).toBe('safari');
    expect(installOffer(env(IPAD_AS_MAC, false, 'MacIntel', 5), EMPTY_STATE, now)).toBe('safari');
    expect(installOffer(env(CHROME_IOS), EMPTY_STATE, now)).toBe('other-browser');
    expect(installOffer(env(IPHONE, true), EMPTY_STATE, now)).toBeNull(); // opened from the home screen
    expect(installOffer({ nav: { userAgent: IPHONE }, matches: (q) => q.includes('standalone') }, EMPTY_STATE, now)).toBeNull();
    expect(installOffer(env(ANDROID), EMPTY_STATE, now)).toBeNull();
    expect(installOffer(env(MAC, false, 'MacIntel', 0), EMPTY_STATE, now)).toBeNull();
  });

  it('stays away for 2 weeks after "Später", then 2 months, and for good after the third time or "Nicht mehr zeigen"', () => {
    let s = EMPTY_STATE;
    s = closeSheet(s, now);
    expect(s).toEqual({ closed: 1, never: false, until: now + SNOOZE_DAYS[0] * DAY });
    expect(installOffer(env(IPHONE), s, now + 13 * DAY)).toBeNull();
    expect(installOffer(env(IPHONE), s, now + 15 * DAY)).toBe('safari');
    s = closeSheet(s, now + 15 * DAY);
    expect(s.until).toBe(now + 15 * DAY + SNOOZE_DAYS[1] * DAY);
    expect(installOffer(env(IPHONE), s, now + 40 * DAY)).toBeNull();
    s = closeSheet(s, now + 80 * DAY);
    expect(s.closed).toBe(MAX_CLOSES);
    expect(s.never).toBe(true);
    expect(installOffer(env(IPHONE), s, now + 999 * DAY)).toBeNull();
    expect(closeSheet(EMPTY_STATE, now, true)).toMatchObject({ never: true, closed: 1 });
  });

  it('remembers per person on this device and survives damaged storage', () => {
    expect(installKey('u1')).not.toBe(installKey('u2'));
    expect(parseState(JSON.stringify({ closed: 2, until: 5, never: false }))).toEqual({ closed: 2, until: 5, never: false });
    for (const bad of [null, undefined, '', 'not json', '"x"', '[]', '{"closed":"many","until":-5}']) expect(parseState(bad as string | null), String(bad)).toMatchObject({ never: false });
    expect(parseState('{"closed":-3,"until":-9}')).toEqual({ closed: 0, until: 0, never: false });
  });

  it('says where the Share button is on an iPad (top) and on an iPhone (bottom), and what to do in an in-app browser', () => {
    expect(installSteps('safari', false)[0]).toMatch(/unten auf Teilen/);
    expect(installSteps('safari', true)[0]).toMatch(/oben rechts auf Teilen/);
    expect(installSteps('safari', false).join(' ')).toMatch(/Zum Home-Bildschirm/);
    expect(installSteps('safari', false).join(' ')).toMatch(/Mitteilungen/); // only from the installed app
    expect(installSteps('in-app', false)[0]).toMatch(/Safari/);
  });
});

describe('push on iPhone and iPad: the explicit steps', () => {
  const base: PushEnv = { nav: { userAgent: IPHONE }, standalone: true, hasPushApi: true, permission: 'default', subscribed: false };
  it('needs the app on the home screen first – a Safari tab has no PushManager at all', () => {
    expect(pushStep({ ...base, standalone: false, hasPushApi: false })).toBe('needs-install');
    expect(pushStep({ ...base, standalone: false })).toBe('needs-install');
  });
  it('needs iOS 16.4', () => {
    expect(pushStep({ ...base, nav: { userAgent: CHROME_IOS_OLD } })).toBe('ios-too-old'); // iOS 15.7
    expect(pushStep({ ...base, nav: { userAgent: IPHONE.replace('17_4_1', '16_3') } })).toBe('ios-too-old');
    expect(pushStep({ ...base, nav: { userAgent: IPHONE.replace('17_4_1', '16_4') } })).toBe('ready');
    expect(pushStep({ ...base, nav: { userAgent: IPAD } })).toBe('ready'); // iPadOS 16.6
  });
  it('walks permission → subscription: button, button, done – and explains a block', () => {
    expect(pushStep(base)).toBe('ready');
    expect(pushStep({ ...base, permission: 'granted' })).toBe('reconnect');
    expect(pushStep({ ...base, permission: 'granted', subscribed: true })).toBe('on');
    expect(pushStep({ ...base, permission: 'denied' })).toBe('blocked');
    expect(pushStep({ ...base, hasPushApi: false })).toBe('unsupported');
  });
  it('is not iOS-specific for other systems', () => {
    const chrome = { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/121' };
    expect(pushStep({ ...base, nav: chrome, standalone: false })).toBe('ready');
    expect(pushStep({ ...base, nav: chrome, standalone: false, hasPushApi: false })).toBe('unsupported');
  });
  it('has words for every step, a button only where a tap helps, and tells iOS users where the setting is', () => {
    for (const step of ['needs-install', 'ios-too-old', 'unsupported', 'blocked', 'ready', 'reconnect', 'on'] as const) {
      const c = pushCopy(step, true);
      expect(c.title.length, step).toBeGreaterThan(5);
      expect(c.text.length, step).toBeGreaterThan(20);
    }
    expect(pushCopy('ready', true).button).toBe('Mitteilungen aktivieren');
    expect(pushCopy('reconnect', true).button).toBe('Gerät verbinden');
    expect(pushCopy('needs-install', true).button).toBe('');
    expect(pushCopy('blocked', true).text).toMatch(/iOS-Einstellungen → Mitteilungen/);
    expect(pushCopy('blocked', false).text).toMatch(/Website-Einstellungen/);
    expect(pushCopy('ios-too-old', true).text).toMatch(/16\.4/);
  });
});

describe('badge', () => {
  it('sets a number, clears at 0, caps, and never throws', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const { badgeAction, applyBadge } = await import('../web/src/ios/badge');
    expect(badgeAction(3)).toEqual({ kind: 'set', n: 3 });
    expect(badgeAction(0)).toEqual({ kind: 'clear' });
    expect(badgeAction(-4)).toEqual({ kind: 'clear' });
    expect(badgeAction(Number.NaN)).toEqual({ kind: 'clear' });
    expect(badgeAction(12345)).toEqual({ kind: 'set', n: 999 });
    expect(badgeAction(2.6)).toEqual({ kind: 'set', n: 3 });
    const nav = { setAppBadge: vi.fn(async () => undefined), clearAppBadge: vi.fn(async () => undefined) };
    expect(await applyBadge(7, nav)).toBe(true);
    expect(nav.setAppBadge).toHaveBeenCalledWith(7);
    expect(await applyBadge(0, nav)).toBe(true);
    expect(nav.clearAppBadge).toHaveBeenCalled();
    expect(await applyBadge(5, {})).toBe(false); // no Badging API
    expect(await applyBadge(5, { setAppBadge: async () => { throw new Error('NotAllowedError'); } })).toBe(false); // iOS: before notifications are allowed
    vi.unstubAllGlobals();
  });
});

describe('share sheet', () => {
  const file = () => new Blob(['a;b\n1;2'], { type: 'text/csv' });
  it('shares a link, and a cancel is not an error', async () => {
    const share = vi.fn(async () => undefined);
    expect(canShareLink({ share })).toBe(true);
    expect(canShareLink({})).toBe(false);
    expect(await shareLink({ title: 'Rechnung R-1', url: 'https://crm.example.com/i/abc' }, { share })).toBe(true);
    expect(share).toHaveBeenCalledWith({ title: 'Rechnung R-1', url: 'https://crm.example.com/i/abc' });
    expect(await shareLink({ title: 'x', url: 'y' }, {})).toBe(false);
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    expect(await shareLink({ title: 'x', url: 'y' }, { share: async () => { throw abort; } })).toBe(false);
    await expect(shareLink({ title: 'x', url: 'y' }, { share: async () => { throw new Error('boom'); } })).rejects.toThrow('boom');
  });

  it('saves a file through the share sheet in the installed app, as a download elsewhere', async () => {
    const file1 = new File(['x'], 'a.csv', { type: 'text/csv' });
    const canShare = vi.fn(() => true);
    expect(canShareFile(file1, { share: async () => undefined, canShare })).toBe(true);
    expect(canShareFile(file1, { share: async () => undefined })).toBe(false);
    expect(canShareFile(file1, { share: async () => undefined, canShare: () => false })).toBe(false);

    const share = vi.fn(async () => undefined);
    const clicked: string[] = [];
    const doc = {
      documentElement: { dataset: {} as Record<string, string> },
      body: { appendChild: () => undefined },
      createElement: () => ({ href: '', download: '', click() { clicked.push(this.download); }, remove: () => undefined }),
    } as unknown as Document;
    expect(await saveBlob(file(), 'bericht.csv', { standalone: true, nav: { share, canShare }, doc })).toBe('shared');
    expect(share.mock.calls[0][0]).toMatchObject({ title: 'bericht.csv' });
    expect(clicked).toEqual([]);
    expect(await saveBlob(file(), 'bericht.csv', { standalone: true, nav: { share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }, canShare }, doc })).toBe('cancelled');
    expect(await saveBlob(file(), 'bericht.csv', { standalone: false, nav: { share, canShare }, doc })).toBe('downloaded');
    expect(clicked).toEqual(['bericht.csv']);
    // no share sheet in the installed app: download
    expect(await saveBlob(file(), 'b2.csv', { standalone: true, nav: {}, doc })).toBe('downloaded');
    expect(clicked).toEqual(['bericht.csv', 'b2.csv']);
  });
});

describe('hardware keyboard', () => {
  it('Cmd/Ctrl+N is "Neu", Cmd/Ctrl+/ is the overview – and nothing else, nothing while composing', () => {
    expect(matchShortcut({ key: 'n', metaKey: true })).toBe('new');
    expect(matchShortcut({ key: 'N', ctrlKey: true })).toBe('new');
    expect(matchShortcut({ key: '/', metaKey: true })).toBe('help');
    expect(matchShortcut({ key: '?', ctrlKey: true, shiftKey: true })).toBe('help');
    expect(matchShortcut({ key: 'n' })).toBeNull();
    expect(matchShortcut({ key: 'n', metaKey: true, shiftKey: true })).toBeNull(); // Cmd+Shift+N is the browser's
    expect(matchShortcut({ key: 'n', metaKey: true, altKey: true })).toBeNull();
    expect(matchShortcut({ key: 'k', metaKey: true })).toBeNull(); // the palette owns it
    expect(matchShortcut({ key: 'n', metaKey: true, defaultPrevented: true })).toBeNull();
    expect(matchShortcut({ key: 'n', metaKey: true, isComposing: true })).toBeNull();
  });
  it('says ⌘ on Apple devices and Strg elsewhere, and lists what the app knows', () => {
    expect(modKey('MacIntel', '')).toBe('⌘');
    expect(modKey('iPad', '')).toBe('⌘');
    expect(modKey('', IPAD_AS_MAC)).toBe('⌘');
    expect(modKey('Win32', 'Windows')).toBe('Strg');
    const keys = shortcutRows('⌘').flatMap((g) => g.rows.map((r) => r.keys));
    for (const k of ['⌘ K', '⌘ N', '⌘ B', '⌘ Z', '⌘ /', 'Esc']) expect(keys).toContain(k);
    expect(HOLD_HINT_MS).toBeGreaterThanOrEqual(500);
  });
});

describe('bottom bar', () => {
  // [route, icon, label, permission] like main.tsx's menu; headings are skipped
  const menu = [
    ['dashboard', 'dashboard', 'Dashboard', 'dashboard'],
    ['group', 'Service'],
    ['conversations', 'conversations', 'Konversationen', 'conversations'],
    ['contacts', 'contacts', 'Kontakte', 'contacts'],
    ['tasks', 'tasks', 'Aufgaben', 'contacts'],
    ['calendars', 'calendars', 'Kalender', 'calendars'],
    ['invoices', 'invoices', 'Rechnungen', 'payments'],
    ['settings', 'settings', 'Einstellungen', 'settings'],
  ] as const;
  const all = () => true;
  it('shows the four most used areas with short names', () => {
    expect(pickTabs(menu as never, all, 'dashboard').map((t) => [t.route, t.label])).toEqual([['dashboard', 'Start'], ['conversations', 'Nachrichten'], ['contacts', 'Kontakte'], ['tasks', 'Aufgaben']]);
  });
  it('skips what the person may not use or has hidden, and fills up from the rest of the menu', () => {
    const noInbox = pickTabs(menu as never, (r) => r !== 'conversations', 'dashboard').map((t) => t.route);
    expect(noInbox).toEqual(['dashboard', 'contacts', 'tasks', 'calendars']);
    const onlyInvoices = pickTabs([menu[6], menu[7]] as never, all, 'invoices').map((t) => t.route);
    expect(onlyInvoices).toEqual(['invoices']); // settings is not a tab
    expect(pickTabs([] as never, all, 'x')).toEqual([]);
  });
  it('keeps the page you are on in the bar even if it is hidden in the menu', () => {
    expect(pickTabs(menu as never, (r) => r !== 'tasks', 'tasks').map((t) => t.route)).toContain('tasks');
  });
});

describe('index.html and the build', () => {
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  it('draws behind the notch and the home indicator, and leaves pinch zoom on (accessibility)', () => {
    const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html)![1];
    expect(viewport).toContain('viewport-fit=cover');
    expect(viewport).toContain('width=device-width');
    expect(viewport).not.toMatch(/maximum-scale|user-scalable\s*=\s*(no|0)/);
  });
  it('gets its iOS head lines from the device table at build time (one marker, replaced by the plugin)', async () => {
    expect(html.split(IOS_HEAD_MARKER)).toHaveLength(2);
    const plugin = iosHeadPlugin();
    const hook = plugin.transformIndexHtml as { handler: (h: string) => string };
    const out = hook.handler(html);
    expect(out).not.toContain(IOS_HEAD_MARKER);
    expect(out.match(/apple-touch-startup-image/g)!.length).toBeGreaterThanOrEqual(96);
    expect(out).toContain('apple-mobile-web-app-capable');
    expect(out).toContain('rel="manifest" href="/manifest.webmanifest"');
    // the boot guard stays the first script
    expect(out.indexOf('boot-guard.js')).toBeLessThan(out.indexOf('theme-boot.js'));
    expect(out.indexOf('apple-touch-icon')).toBeLessThan(out.indexOf('boot-guard.js'));
  });
});

describe('CSS guards for touch screens', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.css') ? [join(dir, f)] : []));
  const files = walk(join(ROOT, 'web/src'));
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('has balanced braces in every iOS stylesheet (an unclosed @media block silently scopes every later rule)', () => {
    for (const f of files.filter((x) => x.includes('/ios/'))) {
      let depth = 0;
      for (const ch of strip(readFileSync(f, 'utf8'))) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        expect(depth, f).toBeGreaterThanOrEqual(0);
      }
      expect(depth, f).toBe(0);
    }
  });

  it('never uses vh for a size without the dvh twin next to it (the address bar and home indicator move; 100vh is too tall on iOS)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const m of strip(readFileSync(f, 'utf8')).matchAll(/([a-z-]+)\s*:\s*([^;{}]*\b\d+(?:\.\d+)?vh\b[^;{}]*)\s*(?=;|\})/g)) {
        const twin = `${m[1]}: ${m[2].replace(/\b(\d+(?:\.\d+)?)vh\b/g, '$1dvh')}`;
        if (!readFileSync(f, 'utf8').includes(twin)) offenders.push(`${f.replace(ROOT, '')}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps fields at 16 px on touch screens (iOS zooms into smaller ones) and targets at 44 px', () => {
    const css = readFileSync(join(ROOT, 'web/src/ios/ios.css'), 'utf8');
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(coarse).toContain('font-size: max(16px, 1em)');
    expect(coarse).toMatch(/\.btn[^{]*\{[^}]*min-height: 44px/);
    expect(css).toContain('touch-action: manipulation');
    expect(css).toContain('env(safe-area-inset-bottom');
    expect(css).toContain('overscroll-behavior');
  });
});
