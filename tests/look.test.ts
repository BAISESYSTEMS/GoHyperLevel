import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers';
import {
  BACKDROP_IMAGE_RE,
  BACKDROPS,
  BORDERS,
  HEADER_STYLES,
  LOCK_KEYS,
  LOCK_OF,
  PREF_DEFAULTS,
  RADII,
  SHADOWS,
  SIDE_STYLES,
  STYLE_KEYS,
  SURFACES,
  THEME_IDS,
  TYPEFACES,
  cleanPrefs,
  effectivePrefs,
} from '../server/services/appearance-model';
import { contrast, luminance } from '../web/src/theme/color';
import { buildCss, buildVars, modeTokens, resolveAccent } from '../web/src/theme/css';
import { BACKDROP_MAX_TINT, GLASS_ALPHA, STYLE_DEFAULTS, SURFACE_DEFAULTS, TYPEFACE_STACKS, backdropTint, imageVeil, over, resolveStyle, styleOf, styleVars } from '../web/src/theme/look';
import { LOOK_PRESETS, presetOf } from '../web/src/theme/look-presets';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const LISTS: Record<(typeof STYLE_KEYS)[number], readonly string[]> = {
  surface: SURFACES,
  radius: RADII,
  shadow: SHADOWS,
  border: BORDERS,
  typeface: TYPEFACES,
  side_style: SIDE_STYLES,
  header: HEADER_STYLES,
  backdrop: BACKDROPS,
};

describe('Stil & Fenster: the model', () => {
  it('validates every style key and keeps today\'s look as the default', () => {
    expect(cleanPrefs({ surface: 'glass', radius: 'round', shadow: 'strong', border: 'off', typeface: 'serif', side_style: 'floating', header: 'glass', backdrop: 'aurora', font: 'xlarge' })).toEqual({
      surface: 'glass',
      radius: 'round',
      shadow: 'strong',
      border: 'off',
      typeface: 'serif',
      side_style: 'floating',
      header: 'glass',
      backdrop: 'aurora',
      font: 'xlarge',
    });
    for (const bad of [{ surface: 'wood' }, { radius: 3 }, { shadow: 'huge' }, { border: true }, { typeface: 'Comic Sans' }, { side_style: 'left' }, { header: 'red' }, { backdrop: 'https://x/y.png' }])
      expect(() => cleanPrefs(bad), JSON.stringify(bad)).toThrow();
    expect(cleanPrefs({ surface: null })).toEqual({ surface: null });
    expect(STYLE_DEFAULTS).toEqual({ surface: 'standard', radius: 'auto', shadow: 'auto', border: 'auto', typeface: 'system', side_style: 'solid', header: 'solid', backdrop: 'plain' });
    for (const k of STYLE_KEYS) expect(LISTS[k], k).toContain(PREF_DEFAULTS[k]);
  });

  it('is one lock group the agency can fix (admins stay free)', () => {
    expect(LOCK_KEYS).toContain('style');
    for (const k of STYLE_KEYS) expect(LOCK_OF[k], k).toBe('style');
    const own = { surface: 'brutal' as const, typeface: 'mono' as const, theme: 'wald' as const };
    expect(effectivePrefs({ surface: 'glass' }, own, { style: true }, false)).toMatchObject({ surface: 'glass', typeface: 'system', theme: 'wald' });
    expect(effectivePrefs({ surface: 'glass' }, own, { style: true }, true)).toMatchObject({ surface: 'brutal', typeface: 'mono' });
    expect(effectivePrefs({ surface: 'glass' }, own, {}, false).surface).toBe('brutal');
  });
});

describe('Stil & Fenster: presets and variables', () => {
  it('has distinct presets with valid values, and recognises each of them', () => {
    expect(new Set(LOOK_PRESETS.map((p) => p.id)).size).toBe(LOOK_PRESETS.length);
    expect(LOOK_PRESETS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(LOOK_PRESETS.map((p) => JSON.stringify(p.style))).size).toBe(LOOK_PRESETS.length);
    for (const p of LOOK_PRESETS) {
      for (const k of STYLE_KEYS) expect(LISTS[k], `${p.id}.${k}`).toContain(p.style[k]);
      expect(presetOf(p.style)).toBe(p.id);
      expect(cleanPrefs(p.style)).toEqual(p.style);
    }
    expect(presetOf(STYLE_DEFAULTS)).toBe('standard');
    expect(presetOf(styleOf(PREF_DEFAULTS))).toBe('standard');
    expect(presetOf({ ...STYLE_DEFAULTS, radius: 'round' })).toBe('');
  });

  it('the standard style is exactly the look before this feature', () => {
    const v = styleVars(STYLE_DEFAULTS, false);
    expect(v).toMatchObject({ '--r-card': '12px', '--r-ctl': '8px', '--r-btn': '8px', '--r-pop': '14px', '--sh-card': 'none', '--bd-w': '1px', '--bd-c': 'var(--line)', '--surface': 'var(--panel)', '--backdrop': 'none' });
    expect(v['--font-ui']).toContain('system-ui');
  });

  it('"auto" follows the surface style, a fixed value wins', () => {
    for (const s of SURFACES) expect(resolveStyle({ ...STYLE_DEFAULTS, surface: s })).toEqual(SURFACE_DEFAULTS[s]);
    expect(resolveStyle({ ...STYLE_DEFAULTS, surface: 'soft', radius: 'square', shadow: 'none', border: 'on' })).toEqual({ radius: 'square', shadow: 'none', border: 'on' });
    expect(styleVars({ ...STYLE_DEFAULTS, surface: 'flat' }, false)['--bd-w']).toBe('0px');
    expect(styleVars({ ...STYLE_DEFAULTS, radius: 'square' }, false)['--r-card']).toBe('0px');
    expect(styleVars({ ...STYLE_DEFAULTS, radius: 'round' }, false)['--r-btn']).toBe('999px');
    // brutal: hard shadows and borders in the text colour; glass: a translucent panel
    const brutal = styleVars({ ...STYLE_DEFAULTS, surface: 'brutal' }, true);
    expect(brutal['--sh-card']).toBe('4px 4px 0 var(--text)');
    expect(brutal['--bd-c']).toBe('var(--text)');
    expect(styleVars({ ...STYLE_DEFAULTS, surface: 'glass' }, false)['--surface']).toBe(`color-mix(in srgb,var(--panel) ${GLASS_ALPHA * 100}%,transparent)`);
    for (const f of TYPEFACES) expect(styleVars({ ...STYLE_DEFAULTS, typeface: f }, false)['--font-ui']).toBe(TYPEFACE_STACKS[f]);
    for (const b of BACKDROPS.filter((x) => x !== 'image')) expect(styleVars({ ...STYLE_DEFAULTS, backdrop: b }, false)['--backdrop'] !== 'none').toBe(b !== 'plain');
  });

  it('puts the style into the generated theme sheet; fonts are local stacks only', () => {
    const css = buildCss({ theme: 'wald', accent: '', palette: 'harmonic', style: { ...STYLE_DEFAULTS, surface: 'soft', typeface: 'rounded' } }, false);
    for (const name of ['--r-card', '--sh-card', '--bd-w', '--surface', '--font-ui', '--backdrop', '--tint-a']) expect(css).toContain(`${name}:`);
    expect([...css].filter((c) => c === '{').length).toBe([...css].filter((c) => c === '}').length);
    // no web fonts: the app's CSP allows font-src 'self' only
    for (const stack of Object.values(TYPEFACE_STACKS)) expect(stack).not.toMatch(/url\(|https?:/);
    // the old call without a style still works (standard look)
    expect(buildVars({ theme: 'wald', accent: '', palette: 'harmonic' }, false)['--r-card']).toBe('12px');
  });
});

const PIC = '/uploads/AbCdEfGhIjKlMnOpQrSt.jpg';

describe('Stil & Fenster: own background picture', () => {
  it('takes only an uploaded picture of this server, as a relative path', () => {
    expect(cleanPrefs({ backdrop: 'image', backdrop_image: PIC })).toEqual({ backdrop: 'image', backdrop_image: PIC });
    expect(cleanPrefs({ backdrop_image: '' })).toEqual({ backdrop_image: '' });
    for (const bad of ['https://example.com/x.jpg', '/uploads/../secret.jpg', '/uploads/AbCdEfGhIjKlMnOpQrSt.svg', '/uploads/x.jpg', '/uploads/AbCdEfGhIjKlMnOpQrSt.jpg")', 'javascript:alert(1)', 7])
      expect(() => cleanPrefs({ backdrop_image: bad }), String(bad)).toThrow();
    expect(LOCK_OF.backdrop_image).toBe('style');
    // the picture is kept apart from the presets: picking one leaves it stored, and it does not spoil the match
    expect(presetOf({ ...STYLE_DEFAULTS, backdrop_image: PIC })).toBe('standard');
    expect(styleOf({ ...PREF_DEFAULTS, backdrop_image: PIC }).backdrop_image).toBe(PIC);
  });

  it('draws the picture under a blended veil – and nothing without one', () => {
    const v = styleVars({ ...STYLE_DEFAULTS, backdrop: 'image', backdrop_image: PIC }, false);
    expect(v['--backdrop']).toBe(`linear-gradient(var(--img-veil),var(--img-veil)),url("${PIC}")`);
    expect(v['--backdrop-size']).toBe('cover');
    expect(v['--backdrop-blend']).toBe('var(--img-blend),normal');
    expect(styleVars({ ...STYLE_DEFAULTS, backdrop: 'image', backdrop_image: '' }, false)['--backdrop']).toBe('none');
    expect(styleVars({ ...STYLE_DEFAULTS, backdrop: 'image', backdrop_image: 'https://x/y.jpg' }, false)['--backdrop']).toBe('none');
    const css = buildVars({ theme: 'wald', accent: '', palette: 'harmonic', style: { ...STYLE_DEFAULTS, backdrop: 'image', backdrop_image: PIC } }, true);
    expect(css['--img-blend']).toBe('multiply');
    expect(buildVars({ theme: 'wald', accent: '', palette: 'harmonic' }, false)['--img-blend']).toBe('screen');
  });

  it('whatever the photo holds, text and muted text stay ≥ 4.5:1 – every theme and mode', () => {
    for (const theme of THEME_IDS)
      for (const dark of [false, true]) {
        const k = modeTokens(theme, dark);
        const { veil, blend } = imageVeil(k);
        const at = `${theme} ${dark ? 'dark' : 'light'}`;
        // screen: the result lies between the veil and white; multiply: between black and the veil
        const extreme = blend === 'screen' ? '#ffffff' : '#000000';
        expect(blend, at).toBe(luminance(k.text) < luminance(k.bg) ? 'screen' : 'multiply');
        for (const spot of [veil, extreme, over(veil, k.panel, GLASS_ALPHA), over(extreme, k.panel, GLASS_ALPHA)]) {
          expect(contrast(k.text, spot), `${at} ${spot}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(k.muted, spot), `${at} ${spot}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    // the standard theme leaves the picture visible (the veil is darker than the page)
    const k = modeTokens('gohigh', false);
    expect(imageVeil(k).veil).not.toBe(k.bg);
  });
});

describe('Stil & Fenster: picture upload', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const dataUrl = (mime: string, body: Buffer) => `data:${mime};base64,${body.toString('base64')}`;
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(() => t.close());

  it('stores a checked picture, serves it, and the look takes its path', async () => {
    const r = await t.api.post('/api/appearance/backdrop', { name: 'urlaub.jpg', data: dataUrl('image/jpeg', JPEG) });
    expect(r.status).toBe(200);
    expect(r.data.url).toMatch(BACKDROP_IMAGE_RE);
    const file = await fetch(t.base + r.data.url);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/jpeg');
    const p = await t.api.patch('/api/appearance', { backdrop: 'image', backdrop_image: r.data.url });
    expect(p.status).toBe(200);
    expect(p.data.effective).toMatchObject({ backdrop: 'image', backdrop_image: r.data.url });
    // not one of the sub-account's files
    const media = await t.api.get('/api/uploads');
    if (media.status === 200) expect(JSON.stringify(media.data)).not.toContain(r.data.url.slice('/uploads/'.length));
  });

  it('refuses other files and foreign addresses', async () => {
    for (const [mime, body] of [
      ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
      ['image/png', JPEG],
      ['text/html', Buffer.from('<script>1</script>')],
    ] as [string, Buffer][])
      expect((await t.api.post('/api/appearance/backdrop', { data: dataUrl(mime, body) })).status, mime).toBe(400);
    expect((await t.api.post('/api/appearance/backdrop', { data: 'https://example.com/x.jpg' })).status).toBe(400);
    expect((await t.api.patch('/api/appearance', { backdrop_image: 'https://example.com/x.jpg' })).status).toBe(400);
    t.api.clearCookie();
    expect((await t.api.post('/api/appearance/backdrop', { data: dataUrl('image/jpeg', JPEG) })).status).toBe(401);
  });
});

describe('Stil & Fenster: readable in every theme and mode', () => {
  const accents = ['', '#475569', '#ef4444', '#eab308', '#16a34a', '#a855f7', '#111111', '#fafafa'];

  it('the seamless sidebar takes the page colours and stays readable', () => {
    for (const theme of THEME_IDS)
      for (const dark of [false, true]) {
        const k = modeTokens(theme, dark);
        const v = buildVars({ theme, accent: '', palette: 'harmonic', style: { ...STYLE_DEFAULTS, side_style: 'blend' } }, dark);
        expect(v['--side']).toBe(k.bg);
        expect(v['--side-text']).toBe(k.text);
        expect(contrast(v['--side-text'], v['--side']), `${theme} ${dark}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v['--side-muted'], v['--side']), `${theme} ${dark}`).toBeGreaterThanOrEqual(4.45);
      }
  });

  it('background tints and glass cards keep text and muted text ≥ 4.5:1 – for every theme, mode and accent', () => {
    for (const theme of THEME_IDS)
      for (const dark of [false, true])
        for (const accent of accents) {
          const k = modeTokens(theme, dark);
          const v = buildVars({ theme, accent, palette: 'rainbow', style: { ...STYLE_DEFAULTS, surface: 'glass', backdrop: 'aurora' } }, dark);
          const share = parseInt(v['--tint-a'], 10) / 100;
          expect(share).toBeLessThanOrEqual(BACKDROP_MAX_TINT);
          for (const c of [v['--brand'], v['--d-ai'], v['--d-inbox']]) {
            const spot = over(k.bg, c, share);
            const glass = over(spot, k.panel, GLASS_ALPHA);
            const at = `${theme} ${dark ? 'dark' : 'light'} ${accent || 'own'} ${c}`;
            expect(contrast(k.muted, spot), at).toBeGreaterThanOrEqual(4.5);
            expect(contrast(k.text, spot), at).toBeGreaterThanOrEqual(4.5);
            expect(contrast(k.muted, glass), at).toBeGreaterThanOrEqual(4.5);
            expect(contrast(k.text, glass), at).toBeGreaterThanOrEqual(4.5);
          }
        }
    // a theme's own accent keeps a visible tint in the standard theme
    const k = modeTokens('gohigh', false);
    expect(backdropTint(k, [resolveAccent({ theme: 'gohigh', accent: '', palette: 'harmonic' }, false)])).toBeGreaterThanOrEqual(0.08);
  });
});

describe('Stil & Fenster: CSS and first paint', () => {
  it('look.css is loaded by theme.css, has balanced braces and styles every switch it offers', () => {
    expect(read('web/src/theme/theme.css')).toMatch(/@import '\.\/look\.css';/);
    const css = read('web/src/theme/look.css').replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    expect(css).toContain("data-surface='brutal'");
    for (const s of SIDE_STYLES.filter((x) => x !== 'solid')) expect(css, s).toContain(`data-side-style='${s}'`);
    for (const h of HEADER_STYLES.filter((x) => x !== 'solid')) expect(css, h).toContain(`data-header='${h}'`);
    // no filter on cards (dialogs inside them would be trapped) – only the top bar's pseudo element blurs
    expect(css).not.toMatch(/\.card[^{]*\{[^}]*backdrop-filter/);
    expect(read('web/src/theme/theme.css')).toContain("data-font='xlarge'");
  });

  it('the boot script paints the style attributes, and an older cache gets the standard look', () => {
    const src = read('web/public/theme-boot.js');
    const run = (p: Record<string, unknown>) => {
      const attrs: Record<string, string> = {};
      runInNewContext(src, {
        document: { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) }, head: { appendChild: () => undefined }, createElement: () => ({}), querySelector: () => null },
        localStorage: { getItem: (k: string) => (k === 'pghl.look' ? JSON.stringify({ v: 1, p, css: { light: '', dark: '' } }) : null) },
        window: { matchMedia: () => ({ matches: false }) },
        matchMedia: () => ({ matches: false }),
      });
      return attrs;
    };
    expect(run({ ...PREF_DEFAULTS, surface: 'glass', side_style: 'floating', header: 'glass', backdrop: 'aurora' })).toMatchObject({ 'data-surface': 'glass', 'data-side-style': 'floating', 'data-header': 'glass', 'data-backdrop': 'aurora' });
    const { surface: _s, side_style: _d, header: _h, backdrop: _b, ...old } = PREF_DEFAULTS;
    expect(run(old)).toMatchObject({ 'data-surface': 'standard', 'data-side-style': 'solid', 'data-header': 'solid', 'data-backdrop': 'plain' });
  });
});
