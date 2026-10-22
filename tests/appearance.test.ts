import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers';
import { MODULE_IDS, PREF_DEFAULTS, PROFILES, THEME_IDS, cleanPrefs, effectivePrefs, hiddenForProfile } from '../server/services/appearance-model';
import { checkLogoDataUrl, svgProblem } from '../server/services/svg-safe';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const dataUrl = (mime: string, body: Buffer | string) => `data:${mime};base64,${Buffer.from(body).toString('base64')}`;
const GOOD_SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><rect width="24" height="24" rx="6" fill="url(#g)"/><path d="M6 12h12" stroke="#fff" stroke-width="2" style="fill:none"/></svg>';

describe('appearance model', () => {
  it('validates preferences and drops unknown keys', () => {
    expect(cleanPrefs({ theme: 'wald', mode: 'dark', accent: '#AABBCC', dept: 'vibrant', bogus: 1 })).toEqual({ theme: 'wald', mode: 'dark', accent: '#aabbcc', dept: 'vibrant' });
    expect(cleanPrefs({ accent: '' })).toEqual({ accent: '' });
    expect(cleanPrefs({ theme: null })).toEqual({ theme: null });
    for (const bad of [{ theme: 'nope' }, { mode: 'auto' }, { accent: 'red' }, { accent: '#fff' }, { dept_tint: 'yes' }, { hidden: 'contacts' }, { icons: 'comic' }, { density: 'huge' }])
      expect(() => cleanPrefs(bad), JSON.stringify(bad)).toThrow();
    expect(cleanPrefs({ hidden: ['tickets', 'tickets', 'does-not-exist', 'dashboard'] })).toEqual({ hidden: ['tickets'] });
  });

  it('knows every theme once and lets only the unlocked groups through', () => {
    expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length);
    expect(THEME_IDS.length).toBeGreaterThanOrEqual(16);
    expect(THEME_IDS.length).toBeLessThanOrEqual(20);
    const own = { theme: 'wald' as const, accent: '#ff0000', icons: 'duotone' as const };
    expect(effectivePrefs({ theme: 'nordlicht' }, own, {}, false)).toMatchObject({ theme: 'wald', accent: '#ff0000', icons: 'duotone' });
    expect(effectivePrefs({ theme: 'nordlicht' }, own, { theme: true }, false)).toMatchObject({ theme: 'nordlicht', accent: '#ff0000' });
    expect(effectivePrefs({ theme: 'nordlicht' }, own, { theme: true }, true).theme).toBe('wald');
  });

  it('starter profiles only name real modules and hide the rest', () => {
    expect(PROFILES.map((p) => p.id)).toEqual(['agency', 'coach', 'local', 'ecommerce', 'sales', 'all']);
    for (const p of PROFILES) {
      for (const m of p.visible) expect(MODULE_IDS, `${p.id}: ${m}`).toContain(m);
      expect(hiddenForProfile(p.id).length + p.visible.length).toBe(MODULE_IDS.length);
    }
    expect(hiddenForProfile('all')).toEqual([]);
    expect(hiddenForProfile('coach')).toContain('tickets');
    expect(hiddenForProfile('coach')).not.toContain('courses');
    expect(hiddenForProfile('local')).toContain('courses');
    expect(hiddenForProfile('unknown')).toEqual([]);
    expect(PREF_DEFAULTS.hidden).toEqual([]);
  });
});

describe('svg and logo checks', () => {
  it('accepts a plain graphic with gradients and local references', () => {
    expect(svgProblem(GOOD_SVG)).toBeNull();
    expect(svgProblem('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="p" d="M0 0h5"/></defs><use xlink:href="#p"/></svg>')).toBeNull();
  });

  it('refuses scripts, handlers, outside references and other active content', () => {
    const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
    const evil: Record<string, string> = {
      script: wrap('<script>alert(1)</script>'),
      scriptCase: wrap('<SCRIPT >alert(1)</SCRIPT>'),
      handler: wrap('<rect width="1" height="1" onload="alert(1)"/>'),
      handlerQuote: '<svg xmlns="http://www.w3.org/2000/svg" onclick=\'x()\'></svg>',
      jsHref: wrap('<use href="javascript:alert(1)"/>'),
      jsEntity: wrap('<use xlink:href="&#106;avascript:alert(1)"/>'),
      outside: wrap('<image href="https://evil.example/x.png"/>'),
      outsideUse: wrap('<use href="https://evil.example/x.svg#a"/>'),
      foreign: wrap('<foreignObject><div>hi</div></foreignObject>'),
      iframe: wrap('<iframe src="https://evil.example"></iframe>'),
      animate: wrap('<set attributeName="href" to="javascript:alert(1)"/>'),
      doctype: '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"></svg>',
      stylesheet: '<?xml-stylesheet href="https://evil.example/x.css"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
      styleImport: wrap('<style>@import url(https://evil.example/x.css);</style>'),
      styleUrl: wrap('<rect style="fill:url(https://evil.example/x)" width="1" height="1"/>'),
      fillUrl: wrap('<rect fill="url(https://evil.example/x)" width="1" height="1"/>'),
      notSvg: '<html><body>hi</body></html>',
      broken: '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>',
      second: '<svg xmlns="http://www.w3.org/2000/svg"></svg><svg onload="x()"></svg>',
    };
    for (const [name, svg] of Object.entries(evil)) expect(svgProblem(svg), name).toBeTruthy();
  });

  it('checks type, content and size of the data URL', () => {
    expect(checkLogoDataUrl(dataUrl('image/png', PNG))).toMatchObject({ ok: true, ext: '.png' });
    expect(checkLogoDataUrl(dataUrl('image/svg+xml', GOOD_SVG))).toMatchObject({ ok: true, ext: '.svg' });
    for (const bad of [dataUrl('image/gif', 'GIF89a'), dataUrl('application/pdf', '%PDF-1.4'), dataUrl('text/html', '<script>1</script>'), dataUrl('image/png', 'not a png at all'), 'https://x.example/a.png', ''])
      expect(checkLogoDataUrl(bad), bad.slice(0, 40)).toMatchObject({ ok: false });
    expect(checkLogoDataUrl(dataUrl('image/png', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)])))).toMatchObject({ ok: false });
    expect(checkLogoDataUrl(dataUrl('image/svg+xml', GOOD_SVG.replace('</svg>', `<!-- ${'x'.repeat(300 * 1024)} --></svg>`)))).toMatchObject({ ok: false });
  });
});

describe('appearance API', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let loc = '';
  const login = async (email: string) => {
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email, password: 'geheim123' })).status).toBe(200);
  };

  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    loc = t.api.location;
    expect((await t.api.post('/api/users', { email: 'kundin@example.com', name: 'Kundin', password: 'geheim123', role: 'member', locations: [loc] })).status).toBe(200);
  });
  afterAll(() => t.close());

  it('starts with the defaults and keeps what a person chooses', async () => {
    const first = await t.api.get('/api/appearance');
    expect(first.status).toBe(200);
    expect(first.data.prefs).toEqual({});
    // the own tile order travels in `prefs` only (tile-order.test.ts)
    const { tile_order: _order, ...shown } = PREF_DEFAULTS;
    expect(first.data.effective).toEqual(shown);

    const r = await t.api.patch('/api/appearance', { theme: 'wald', mode: 'dark', accent: '#E11D48', sidebar: 'rail', icons: 'duotone', dept: 'vibrant', dept_tint: true });
    expect(r.status).toBe(200);
    expect(r.data.prefs).toMatchObject({ theme: 'wald', mode: 'dark', accent: '#e11d48', sidebar: 'rail' });
    // a second change merges, it does not replace
    await t.api.patch('/api/appearance', { density: 'compact' });
    const again = await t.api.get('/api/appearance');
    expect(again.data.effective).toMatchObject({ theme: 'wald', mode: 'dark', accent: '#e11d48', sidebar: 'rail', icons: 'duotone', dept: 'vibrant', dept_tint: true, density: 'compact' });
    // null resets one key to the default
    const reset = await t.api.patch('/api/appearance', { accent: null });
    expect(reset.data.effective.accent).toBe('');
    expect(reset.data.prefs.accent).toBeUndefined();
  });

  it('rejects invalid values and empty bodies', async () => {
    expect((await t.api.patch('/api/appearance', { theme: 'rainbow-unicorn' })).status).toBe(400);
    expect((await t.api.patch('/api/appearance', { accent: 'blue' })).status).toBe(400);
    expect((await t.api.patch('/api/appearance', {})).status).toBe(400);
    expect((await t.api.patch('/api/appearance', { unknown: 1 })).status).toBe(400);
    const anon = await t.api.raw('/api/appearance');
    expect(anon.status).toBe(401);
  });

  it('keeps preferences per user', async () => {
    await login('kundin@example.com');
    const mine = await t.api.get('/api/appearance');
    expect(mine.data.prefs).toEqual({});
    expect(mine.data.effective.theme).toBe('gohigh');
    await t.api.patch('/api/appearance', { theme: 'sand' });
    await login('chef@example.com');
    expect((await t.api.get('/api/appearance')).data.effective.theme).toBe('wald');
  });

  it('stores hidden menu entries, drops unknown ones and never touches permissions', async () => {
    const r = await t.api.patch('/api/appearance', { hidden: ['tickets', 'courses', 'nonsense'], profile: 'coach' });
    expect(r.data.effective.hidden).toEqual(['tickets', 'courses']);
    expect(r.data.effective.profile).toBe('coach');
    expect((await t.api.get('/api/appearance')).data.effective.hidden).toEqual(['tickets', 'courses']);
    // hidden = view preference only: the API of a hidden area still answers
    expect((await t.api.get('/api/tickets')).status).toBe(200);
    expect((await t.api.patch('/api/appearance', { profile: 'bogus' })).status).toBe(400);
    const clear = await t.api.patch('/api/appearance', { hidden: [], profile: null });
    expect(clear.data.effective.hidden).toEqual([]);
  });

  it('offers the starter profiles once to a new account', async () => {
    const st = await t.api.get('/api/appearance');
    expect(st.data.offer_profiles).toBe(true);
    await t.api.patch('/api/appearance', { asked: true });
    expect((await t.api.get('/api/appearance')).data.offer_profiles).toBe(false);
  });

  it('applies the agency defaults and locks to members, never to admins', async () => {
    const set = await t.api.patch('/api/agency/branding/look', { defaults: { theme: 'nordlicht', accent: '#0ea5e9', hidden: ['affiliates'] }, locks: { theme: true, modules: true } });
    expect(set.status).toBe(200);
    expect(set.data.locks).toEqual({ theme: true, modules: true });

    await login('kundin@example.com');
    const st = await t.api.get('/api/appearance');
    // the member's own "sand" is overridden by the locked default; the unlocked accent is still the default
    expect(st.data.effective).toMatchObject({ theme: 'nordlicht', accent: '#0ea5e9', hidden: ['affiliates'] });
    expect(st.data.locks).toEqual({ theme: true, modules: true });
    expect(st.data.offer_profiles).toBe(false); // locked: nothing to offer

    const refused = await t.api.patch('/api/appearance', { theme: 'wald' });
    expect(refused.status).toBe(403);
    expect(refused.data.error).toContain('Theme und Hell/Dunkel');
    expect((await t.api.patch('/api/appearance', { mode: 'dark' })).status).toBe(403);
    expect((await t.api.patch('/api/appearance', { hidden: ['tickets'] })).status).toBe(403);
    expect((await t.api.patch('/api/appearance', { theme: null })).status).toBe(403);
    // the unlocked groups stay free …
    const free = await t.api.patch('/api/appearance', { accent: '#16a34a', icons: 'square', sidebar: 'rail' });
    expect(free.status).toBe(200);
    expect(free.data.effective).toMatchObject({ accent: '#16a34a', icons: 'square', sidebar: 'rail', theme: 'nordlicht' });
    // … and a whole form with the locked value unchanged is accepted
    expect((await t.api.patch('/api/appearance', { theme: 'nordlicht', density: 'compact' })).status).toBe(200);
    // a member cannot reach the agency settings
    expect((await t.api.patch('/api/agency/branding/look', { locks: { theme: false } })).status).toBe(403);
    expect((await t.api.post('/api/agency/branding/logo', { name: 'x.png', data: dataUrl('image/png', PNG) })).status).toBe(403);

    // the agency admin is never locked
    await login('chef@example.com');
    const admin = await t.api.patch('/api/appearance', { theme: 'mitternacht' });
    expect(admin.status).toBe(200);
    expect(admin.data.effective.theme).toBe('mitternacht');
    // … and the admin's own screen shows nothing as locked, although the agency fixed those groups for its clients
    expect(admin.data.locks).toEqual({});
    expect((await t.api.get('/api/agency/branding/look')).data.locks).toEqual({ theme: true, modules: true });
  });

  it('lets a client override the agency defaults and open a lock', async () => {
    const get = await t.api.get(`/api/agency/locations/${loc}/branding/look`);
    expect(get.status).toBe(200);
    expect(get.data.agency.locks).toEqual({ theme: true, modules: true });
    const put = await t.api.patch(`/api/agency/locations/${loc}/branding/look`, { defaults: { theme: 'sand', dept: 'clear' }, locks: { theme: false, icons: true } });
    // the response holds the client's own overrides; the agency's are alongside
    expect(put.data.locks).toEqual({ theme: false, icons: true });
    expect(put.data.agency.locks).toEqual({ theme: true, modules: true });
    expect((await t.api.patch(`/api/agency/locations/nope/branding/look`, { locks: {} })).status).toBe(404);

    await login('kundin@example.com');
    const st = await t.api.get('/api/appearance');
    expect(st.data.defaults).toMatchObject({ theme: 'sand', dept: 'clear', accent: '#0ea5e9' });
    // the client opened the theme lock again, so the member's own choice ("sand" earlier) counts
    expect(st.data.locks).toEqual({ theme: false, icons: true, modules: true });
    expect((await t.api.patch('/api/appearance', { theme: 'wald' })).status).toBe(200);
    expect((await t.api.patch('/api/appearance', { icons: 'bold' })).status).toBe(403);

    // inheriting again (null) restores the agency lock
    await login('chef@example.com');
    await t.api.patch(`/api/agency/locations/${loc}/branding/look`, { locks: { theme: null, icons: null } });
    await login('kundin@example.com');
    expect((await t.api.patch('/api/appearance', { theme: 'wald' })).status).toBe(403);
    await login('chef@example.com');
  });

  it('serves the defaults to the login page without a session', async () => {
    const r = await t.api.raw('/api/appearance/public');
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.effective.theme).toBe('nordlicht');
    expect(body.effective.asked).toBe(false);
  });

  it('stores branding assets: new fields, address check, logo upload', async () => {
    const ok = await t.api.patch('/api/agency/branding', { logo_dark_url: 'https://cdn.example.com/logo-dark.svg', mark_url: 'https://cdn.example.com/mark.png', show_name: 'no' });
    expect(ok.status).toBe(200);
    const b = (await t.api.get('/api/branding/me')).data;
    expect(b).toMatchObject({ logo_dark_url: 'https://cdn.example.com/logo-dark.svg', mark_url: 'https://cdn.example.com/mark.png', show_name: 'no' });
    expect((await t.api.patch('/api/agency/branding', { logo_url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await t.api.patch('/api/agency/branding', { mark_dark_url: 'data:image/svg+xml;base64,AAAA' })).status).toBe(400);

    const up = await t.api.post('/api/agency/branding/logo', { name: 'logo.svg', data: dataUrl('image/svg+xml', GOOD_SVG) });
    expect(up.status).toBe(200);
    expect(up.data.url).toMatch(/\/uploads\/[\w-]+\.svg$/);
    const served = await t.api.raw(new URL(up.data.url).pathname);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/svg+xml');
    expect(served.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');

    const png = await t.api.post('/api/agency/branding/logo', { name: 'mark.png', data: dataUrl('image/png', PNG) });
    expect(png.status).toBe(200);
    expect(png.data.url).toMatch(/\.png$/);
  });

  it('refuses logos that are scripted, mislabeled, of the wrong type or too large', async () => {
    const send = (name: string, data: string) => t.api.post('/api/agency/branding/logo', { name, data });
    const svgs = ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>'];
    for (const s of svgs) expect((await send('evil.svg', dataUrl('image/svg+xml', s))).status, s).toBe(400);
    expect((await send('a.gif', dataUrl('image/gif', 'GIF89a....'))).status).toBe(400);
    expect((await send('a.pdf', dataUrl('application/pdf', '%PDF-1.4'))).status).toBe(400);
    expect((await send('a.html', dataUrl('text/html', '<script>alert(1)</script>'))).status).toBe(400);
    expect((await send('fake.png', dataUrl('image/png', '<html></html>'))).status).toBe(400);
    expect((await send('fake.png', 'not a data url')).status).toBe(400);
    expect((await send('big.png', dataUrl('image/png', Buffer.concat([PNG, Buffer.alloc(1100 * 1024)])))).status).toBe(400);
  });
});
