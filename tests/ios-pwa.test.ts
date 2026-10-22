import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePng } from '../server/services/canvas-png.js';
import {
  DEFAULT_NAME,
  IOS_DEVICES,
  SPLASH_SIZES,
  appManifest,
  badgeTotal,
  brandKey,
  iosHead,
  parseSplashFile,
  pwaBrand,
  splashSpecs,
} from '../server/services/pwa-ios.js';
import { startTestApp } from './helpers.js';

/**
 * The installable app on iPhone, iPad and foldables, server side (docs/ios-web-app.md): the head lines the build writes into
 * index.html (touch icons, launch images in light and dark for every current screen), the manifest with the white label,
 * the pictures drawn per white label, and the number for the app icon.
 */

const ihdr = (png: Buffer) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20), colorType: png[25] });
const decoded = new WeakMap<Buffer, NonNullable<ReturnType<typeof decodePng>>>();
const pixel = (png: Buffer, x: number, y: number) => {
  if (!decoded.has(png)) decoded.set(png, decodePng(png, 40_000_000)!);
  const bmp = decoded.get(png)!;
  const i = (y * bmp.w + x) * 4;
  return [bmp.data[i], bmp.data[i + 1], bmp.data[i + 2]];
};

describe('device table and head lines', () => {
  const head = iosHead();

  it('opens as a standalone app with its name and a status bar that stays readable', () => {
    expect(head).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(head).toContain('<meta name="mobile-web-app-capable" content="yes" />');
    expect(head).toContain(`<meta name="apple-mobile-web-app-title" content="${DEFAULT_NAME}" />`);
    expect(head).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />');
    expect(iosHead({ name: 'Müller & "Söhne" <GmbH>' })).toContain('content="Müller &amp; &quot;Söhne&quot; &lt;GmbH>"');
  });

  it('lists every touch icon size iOS asks for, and the large one for headsets', () => {
    for (const n of [120, 152, 167, 180]) expect(head).toContain(`<link rel="apple-touch-icon" sizes="${n}x${n}" href="/pwa/icon/icon-${n}.png" />`);
    expect(head).toContain('<link rel="apple-touch-icon" href="/pwa/icon/icon-180.png" />');
    expect(head).toContain('sizes="1024x1024" href="/pwa/icon/icon-1024.png"');
  });

  it('has a launch image per screen, orientation and colour scheme – each with the picture of exactly that pixel size', () => {
    const links = head.split('\n').filter((l) => l.includes('apple-touch-startup-image'));
    expect(links).toHaveLength(IOS_DEVICES.length * 2 * 2);
    expect(new Set(links).size).toBe(links.length);
    expect(links.filter((l) => l.includes('prefers-color-scheme: dark'))).toHaveLength(links.length / 2);
    // iPhone 15 (393 × 852 @3): 1179 × 2556 portrait, 2556 × 1179 landscape
    expect(head).toContain('(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: light)" href="/pwa/splash/1179x2556-light.png"');
    expect(head).toContain('(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape) and (prefers-color-scheme: dark)" href="/pwa/splash/2556x1179-dark.png"');
    for (const s of splashSpecs()) {
      expect(s.px).toBe(s.orientation === 'portrait' ? s.device.w * s.device.dpr : s.device.h * s.device.dpr);
      expect(head).toContain(`/pwa/splash/${s.px}x${s.py}-light.png`);
    }
  });

  it('covers the current iPads (12.9"/13" Pro, 11", mini) and the folded and unfolded iPhone Duo', () => {
    // iPad Pro 12.9": 2048 × 2732, iPad Pro 13" M4: 2064 × 2752, iPad mini 6: 1488 × 2266 portrait
    for (const size of ['2048x2732', '2064x2752', '1488x2266', '1668x2420', '2732x2048']) expect(SPLASH_SIZES.has(size), size).toBe(true);
    // iPhone Duo folded 466 × 678 @3 = 1398 × 2034; unfolded 626 × 890 / 890 × 626 @3 = 1878 × 2670
    expect(SPLASH_SIZES.has('1398x2034')).toBe(true);
    expect(SPLASH_SIZES.has('1878x2670')).toBe(true);
    expect(SPLASH_SIZES.has('2670x1878')).toBe(true);
    expect(IOS_DEVICES.filter((d) => d.estimate).map((d) => d.id)).toEqual(['iphone-duo-folded', 'iphone-duo-open']);
  });

  it('keeps the table honest: portrait screens, no two entries with the same media query', () => {
    for (const d of IOS_DEVICES) {
      expect(d.w, d.id).toBeLessThan(d.h);
      expect([2, 3]).toContain(d.dpr);
    }
    const keys = IOS_DEVICES.map((d) => `${d.w}x${d.h}@${d.dpr}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('accepts only sizes of the table as launch image files', () => {
    expect(parseSplashFile('1179x2556-light.png')).toEqual({ px: 1179, py: 2556, scheme: 'light' });
    expect(parseSplashFile('2556x1179-dark.png')).toEqual({ px: 2556, py: 1179, scheme: 'dark' });
    for (const bad of ['9999x9999-light.png', '1179x2556-blue.png', '1179x2556.png', '../1179x2556-light.png', '1179x2556-light.png.exe', '100x100-light.png']) expect(parseSplashFile(bad), bad).toBeNull();
  });
});

describe('manifest and white label', () => {
  it('stock look: standalone window, any orientation, the shipped icons', () => {
    const m = appManifest(pwaBrand({}));
    expect(m).toMatchObject({ id: '/app', scope: '/app', start_url: '/app', display: 'standalone', orientation: 'any', name: DEFAULT_NAME, short_name: DEFAULT_NAME, lang: 'de' });
    expect(m.icons.map((i) => i.src)).toEqual(['/icon-192.png', '/icon-512.png', '/icon-1024.png', '/icon-maskable-512.png', '/icon.svg']);
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    expect(m.shortcuts.every((s) => s.icons[0].src === '/icon-192.png')).toBe(true);
  });

  it('white label: name, colour and the drawn icons (with a version so devices fetch new ones)', () => {
    const b = pwaBrand({ name: 'Müller Marketing Agentur', color: '#E11D48', mark_url: '/uploads/mark.png' });
    expect(b).toMatchObject({ name: 'Müller Marketing Agentur', color: '#e11d48', logo: '/uploads/mark.png', custom: true });
    const key = brandKey(b);
    const m = appManifest(b, key);
    expect(m).toMatchObject({ name: 'Müller Marketing Agentur', short_name: 'Müller', theme_color: '#e11d48' });
    expect(m.icons.map((i) => i.src)).toEqual([`/pwa/icon/icon-192.png?v=${key}`, `/pwa/icon/icon-512.png?v=${key}`, `/pwa/icon/icon-1024.png?v=${key}`, `/pwa/icon/maskable-512.png?v=${key}`]);
    expect(m.shortcuts[0].icons[0].src).toBe(`/pwa/icon/icon-192.png?v=${key}`);
    expect(brandKey(pwaBrand({ ...b, name: 'Anders', color: '#e11d48' }))).not.toBe(key);
  });

  it('treats the stock name and colours as "not customised" and ignores broken input', () => {
    expect(pwaBrand({ name: 'HyperLevel', color: '#2563eb' }).custom).toBe(false);
    expect(pwaBrand({ name: 'HyperLevel', color: '#1d4ed8' }).custom).toBe(false);
    expect(pwaBrand({ name: 'HyperLevel', color: '#ff0000' }).custom).toBe(true);
    expect(pwaBrand({ name: '  ', color: 'javascript:alert(1)' })).toMatchObject({ name: 'HyperLevel', color: '#2563eb', custom: false });
    expect(pwaBrand({ name: 'x'.repeat(100) }).name).toHaveLength(45);
  });
});

describe('the number on the app icon', () => {
  it('is never negative or huge', () => {
    expect(badgeTotal({ unread: 3, tasks: 2 })).toBe(5);
    expect(badgeTotal({ unread: -4 })).toBe(0);
    expect(badgeTotal({ unread: 100000 })).toBe(999);
    expect(badgeTotal({ unread: Number.NaN })).toBe(0);
  });
});

describe('routes', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    // The shipped 1024 px icon, as in a real web build: the stock look is scaled from it.
    mkdirSync(t.app.config.webDir, { recursive: true });
    copyFileSync(join(__dirname, '../web/public/icon-1024.png'), join(t.app.config.webDir, 'icon-1024.png'));
  });
  afterAll(() => t.close());
  const png = async (path: string, init?: RequestInit) => {
    const r = await t.api.raw(path, init);
    return { r, buf: Buffer.from(await r.arrayBuffer()) };
  };

  it('serves the stock touch icons in every size, scaled from the shipped icon', async () => {
    for (const n of [120, 152, 167, 180, 1024]) {
      const { r, buf } = await png(`/pwa/icon/icon-${n}.png`);
      expect(r.status, String(n)).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/png');
      expect(ihdr(buf)).toMatchObject({ w: n, h: n, colorType: 2 }); // opaque: iOS would paint transparent corners black
      // blue gradient of the stock icon, not white
      const [red, , blue] = pixel(buf, 5, 5);
      expect(blue).toBeGreaterThan(red);
    }
    expect(ihdr((await png('/pwa/icon/maskable-512.png')).buf)).toMatchObject({ w: 512, h: 512 });
    expect(ihdr((await png('/pwa/icon/icon-192.png')).buf)).toMatchObject({ w: 192, h: 192, colorType: 6 }); // round: transparent corners
  });

  it('refuses unknown icons and launch image sizes (the route must not draw arbitrary pictures)', async () => {
    expect((await png('/pwa/icon/icon-999.png')).r.status).toBe(404);
    expect((await png('/pwa/icon/..%2Fsecret.png')).r.status).toBe(404);
    expect((await png('/pwa/splash/9000x9000-light.png')).r.status).toBe(404);
    expect((await png('/pwa/splash/1179x2556-pink.png')).r.status).toBe(404);
  });

  it('draws launch images in the page colours of the scheme, with the app icon in the middle', async () => {
    for (const [file, bg] of [['1179x2556-light.png', [0xf4, 0xf6, 0xfa]], ['1179x2556-dark.png', [0x0b, 0x10, 0x20]], ['2556x1179-dark.png', [0x0b, 0x10, 0x20]], ['1398x2034-light.png', [0xf4, 0xf6, 0xfa]]] as const) {
      const { r, buf } = await png(`/pwa/splash/${file}`);
      expect(r.status, file).toBe(200);
      const [w, h] = file.replace(/-.*/, '').split('x').map(Number);
      expect(ihdr(buf)).toMatchObject({ w, h, colorType: 2 });
      expect(pixel(buf, 3, 3)).toEqual([...bg]);
      expect(pixel(buf, w - 4, h - 4)).toEqual([...bg]);
      // the icon in the middle is not the page colour
      expect(pixel(buf, Math.round(w / 2), Math.round(h / 2) - Math.round(Math.min(w, h) * 0.05))).not.toEqual([...bg]);
    }
  });

  it('draws a big iPad launch image quickly enough to be asked for on demand', async () => {
    const t0 = Date.now();
    const { r, buf } = await png('/pwa/splash/2064x2752-dark.png');
    expect(r.status).toBe(200);
    expect(ihdr(buf)).toMatchObject({ w: 2064, h: 2752 });
    expect(buf.length).toBeLessThan(400_000); // flat colour compresses to a few KB
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('follows the white label: colour, name and manifest icons change with the branding', async () => {
    expect((await t.api.patch('/api/agency/branding', { name: 'Agentur Nordlicht', color: '#e11d48' })).status).toBe(200);
    const m = await (await t.api.raw('/manifest.webmanifest')).json();
    expect(m).toMatchObject({ name: 'Agentur Nordlicht', short_name: 'Agentur', theme_color: '#e11d48' });
    expect(m.icons[0].src).toMatch(/^\/pwa\/icon\/icon-192\.png\?v=[0-9a-f]{10}$/);
    const icon = await png('/pwa/icon/icon-180.png');
    const [r, g, b] = pixel(icon.buf, 4, 4);
    expect([r, g, b]).toEqual([0xe1, 0x1d, 0x48]); // the agency's colour fills the corner of the touch icon
    const splash = await png('/pwa/splash/1179x2556-light.png');
    expect(pixel(splash.buf, 3, 3)).toEqual([0xf4, 0xf6, 0xfa]);
    // icon pixels in the middle carry the colour (letter tile "A")
    const cx = Math.round(1179 / 2);
    const cy = Math.round(2556 / 2) - Math.round(1179 * 0.05);
    const seen = new Set<string>();
    for (let dy = -120; dy <= 120; dy += 8) for (let dx = -120; dx <= 120; dx += 8) seen.add(pixel(splash.buf, cx + dx, cy + dy).join(','));
    expect(seen.has('225,29,72')).toBe(true);
    // back to the stock look
    await t.api.patch('/api/agency/branding', { name: 'HyperLevel', color: '#2563eb' });
    expect((await (await t.api.raw('/manifest.webmanifest')).json()).icons[0].src).toBe('/icon-192.png');
  });

  it('counts unread messages for the badge: API, and the number inside push messages', async () => {
    expect((await t.api.get('/api/app-badge')).data).toEqual({ unread: 0, total: 0, here: 0 });
    const c = (await t.api.post('/api/contacts', { email: 'badge@x.de', phone: '+4915112399' })).data;
    await t.api.post('/api/messages', { contact_id: c.id, channel: 'sms', body: 'Hallo!' });
    const urls = (await t.api.get('/api/settings/inbound')).data;
    const u = new URL(urls.sms);
    for (const body of ['Hallo', 'Noch da?']) await t.api.raw(u.pathname + u.search, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `From=%2B4915112399&Body=${encodeURIComponent(body)}` });
    expect((await t.api.get('/api/app-badge')).data).toEqual({ unread: 2, total: 2, here: 2 });
    const me = (await t.api.get('/api/me')).data.user;
    expect(t.app.services.pushBadge(me.id)).toBe(2);
    expect(t.app.services.pushBadge('nobody')).toBe(0);
    // a second sub-account: the icon counts both, the bar the one on screen
    const second = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data;
    t.app.db.insert('contacts', { id: 'c-second', location_id: second.id, first_name: 'Zoe', last_name: 'Zwei', email: 'zoe@x.de', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    t.app.db.insert('conversations', { id: 'conv-second', location_id: second.id, contact_id: 'c-second', unread: 3, last_message: 'Hi', last_message_at: new Date().toISOString(), created_at: new Date().toISOString() });
    expect((await t.api.get('/api/app-badge')).data).toEqual({ unread: 5, total: 5, here: 2 });
    expect((await t.api.get('/api/app-badge', { 'x-location-id': second.id })).data).toEqual({ unread: 5, total: 5, here: 3 });
    t.app.db.run('DELETE FROM conversations WHERE id = ?', 'conv-second');
    // reading the conversation clears it
    const conv = (await t.api.get('/api/conversations')).data.find((x: any) => x.contact_id === c.id);
    await t.api.get(`/api/conversations/${conv.id}/messages`);
    expect((await t.api.get('/api/app-badge')).data.total).toBe(0);
  });

  it('only counts what the login may see (no inbox access, no number)', async () => {
    const loc = t.api.location;
    const member = await t.api.post('/api/users', { email: 'nur-kontakte@example.com', name: 'Nur Kontakte', password: 'geheim123', role: 'member', locations: [loc], permissions: ['contacts'] });
    expect([200, 201]).toContain(member.status);
    const id = member.data.id;
    t.app.db.run('UPDATE conversations SET unread = 4');
    expect(t.app.services.pushBadge(id)).toBe(0);
    const admin = (await t.api.get('/api/me')).data.user;
    expect(t.app.services.pushBadge(admin.id)).toBe(4);
  });
});
