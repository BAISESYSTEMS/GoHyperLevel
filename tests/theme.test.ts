import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALWAYS_VISIBLE, DEPT_LEVELS, DEPT_PALETTES, ICON_PACKS, MODULE_IDS, PREF_DEFAULTS, THEME_IDS } from '../server/services/appearance-model';
import { alpha, contrast, deriveAccent, ensureContrast, fromOklch, hexToRgb, luminance, mix, onColor, rgbToHex, toOklch } from '../web/src/theme/color';
import { buildCss, buildVars, modeTokens, resolveAccent } from '../web/src/theme/css';
import { DEPTS, DEPT_OF_ROUTE, deptColors } from '../web/src/theme/depts';
import { THEMES, THEME_LIST } from '../web/src/theme/themes';
import { SOLID } from '../web/src/theme/packs/solid';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** CSS `color-mix(in srgb, fg a%, transparent)` over a background: plain alpha compositing in sRGB. */
const over = (bg: string, fg: string, a: number) => {
  const b = hexToRgb(bg);
  const f = hexToRgb(fg);
  return rgbToHex([0, 1, 2].map((i) => f[i] * a + b[i] * (1 - a)) as [number, number, number]);
};

describe('colour maths', () => {
  it('computes WCAG contrast and OKLCH round trips', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
    expect(luminance('#ffffff')).toBeCloseTo(1, 3);
    for (const hex of ['#2563eb', '#16a34a', '#facc15', '#7c3aed', '#111827', '#ffffff']) {
      const back = fromOklch(toOklch(hex));
      for (let i = 0; i < 3; i++) expect(Math.abs(hexToRgb(back)[i] - hexToRgb(hex)[i])).toBeLessThanOrEqual(2);
    }
    // out-of-gamut chroma is reduced, never producing an invalid colour
    expect(fromOklch({ l: 0.5, c: 0.6, h: 150 })).toMatch(/^#[0-9a-f]{6}$/);
    expect(mix('#000000', '#ffffff', 0.5)).toMatch(/^#[0-9a-f]{6}$/);
    expect(alpha('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
  });

  it('ensureContrast moves the lightness until the colour reads', () => {
    const c = ensureContrast('#facc15', '#ffffff', 4.5);
    expect(contrast(c, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    const d = ensureContrast('#1e3a8a', '#0b1020', 4.5);
    expect(contrast(d, '#0b1020')).toBeGreaterThanOrEqual(4.5);
    expect(ensureContrast('#111111', '#ffffff', 4.5)).toBe('#111111');
  });
});

describe('accent derivation', () => {
  const surfaces = [
    { dark: false, panel: '#ffffff', bg: '#f4f6fa', text: '#111827' },
    { dark: true, panel: '#121a2e', bg: '#0b1020', text: '#e5e7eb' },
    { dark: false, panel: '#fbf8f1', bg: '#fffefb', text: '#141414' },
    { dark: true, panel: '#000000', bg: '#0a0a0a', text: '#ffffff' },
  ];

  it('picks black or white so that text on the accent is readable – for any colour', () => {
    let worst = 21;
    for (let h = 0; h < 360; h += 12)
      for (const l of [0.25, 0.4, 0.55, 0.7, 0.85, 0.95])
        for (const c of [0.03, 0.1, 0.2]) {
          const accent = fromOklch({ l, c, h });
          const on = onColor(accent);
          expect(['#000000', '#ffffff']).toContain(on);
          worst = Math.min(worst, contrast(on, accent));
        }
    expect(worst).toBeGreaterThanOrEqual(4.5);
    // the obvious cases
    expect(onColor('#ffffff')).toBe('#000000');
    expect(onColor('#000000')).toBe('#ffffff');
    expect(onColor('#facc15')).toBe('#000000');
    expect(onColor('#1e3a8a')).toBe('#ffffff');
  });

  it('derives hover, soft tint, link text and focus ring that stay readable on every surface', () => {
    for (const s of surfaces)
      for (let h = 0; h < 360; h += 30)
        for (const l of [0.3, 0.55, 0.8, 0.95]) {
          const accent = fromOklch({ l, c: 0.16, h });
          const a = deriveAccent(accent, s, s.dark);
          const where = `${accent} on ${s.panel}`;
          expect(contrast(a.on, a.brand), `on ${where}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(a.on, a.hover), `hover ${where}`).toBeGreaterThanOrEqual(4.5);
          for (const bg of [s.panel, s.bg, a.soft]) expect(contrast(a.text, bg), `text ${where} on ${bg}`).toBeGreaterThanOrEqual(4.5);
          for (const bg of [s.panel, s.bg]) expect(contrast(a.ring, bg), `ring ${where}`).toBeGreaterThanOrEqual(3);
          expect(contrast(s.text, a.select), `selection ${where}`).toBeGreaterThanOrEqual(4.5);
        }
  });

  it('keeps the accent itself and changes nothing for a readable one', () => {
    const a = deriveAccent('#2563eb', { panel: '#ffffff', bg: '#f4f6fa', text: '#111827' }, false);
    expect(a.brand).toBe('#2563eb');
    expect(a.on).toBe('#ffffff');
    expect(a.text).toBe('#2563eb');
  });
});

describe('theme gallery', () => {
  it('has 16–20 themes with matching ids and own names', () => {
    expect(THEME_LIST.length).toBeGreaterThanOrEqual(16);
    expect(THEME_LIST.length).toBeLessThanOrEqual(20);
    expect(Object.keys(THEMES).sort()).toEqual([...THEME_IDS].sort());
    for (const t of THEME_LIST) {
      expect(THEMES[t.id]).toBe(t);
      expect(t.name.length).toBeGreaterThan(2);
      expect(t.blurb.length).toBeGreaterThan(10);
    }
    expect(new Set(THEME_LIST.map((t) => t.name)).size).toBe(THEME_LIST.length);
    // light and dark are really different, and the dark one is darker
    for (const t of THEME_LIST) {
      expect(luminance(t.dark.bg), t.id).toBeLessThan(luminance(t.light.bg));
      expect(luminance(t.dark.panel), t.id).toBeLessThan(luminance(t.light.panel));
    }
  });

  for (const t of THEME_LIST) {
    for (const dark of [false, true]) {
      it(`${t.id} (${dark ? 'dark' : 'light'}): text ≥ 4.5:1, UI ≥ 3:1`, () => {
        const k = dark ? t.dark : t.light;
        const need = t.id === 'kontrast' ? 7 : 4.5;
        // body text and muted text on the page and on cards
        expect(contrast(k.text, k.bg), 'text on bg').toBeGreaterThanOrEqual(need);
        expect(contrast(k.text, k.panel), 'text on panel').toBeGreaterThanOrEqual(need);
        expect(contrast(k.muted, k.bg), 'muted on bg').toBeGreaterThanOrEqual(need);
        expect(contrast(k.muted, k.panel), 'muted on panel').toBeGreaterThanOrEqual(need);
        const v = buildVars({ theme: t.id, accent: '', palette: 'rainbow' }, dark);
        // sidebar: text, headings, icons
        expect(contrast(k.sideText, k.side), 'sidebar text').toBeGreaterThanOrEqual(4.5);
        expect(contrast(v['--side-muted'], k.side), 'sidebar headings').toBeGreaterThanOrEqual(4.5);
        expect(contrast(v['--side-icon'], k.side), 'sidebar icons').toBeGreaterThanOrEqual(3);
        // the theme's own accent: filled controls, link text, focus ring
        expect(contrast(k.accent, k.panel), 'accent as UI element').toBeGreaterThanOrEqual(3);
        expect(contrast(v['--on-brand'], v['--brand']), 'text on accent').toBeGreaterThanOrEqual(4.5);
        expect(contrast(v['--brand-text'], k.panel), 'link text on panel').toBeGreaterThanOrEqual(4.5);
        expect(contrast(v['--brand-text'], v['--brand-soft']), 'link text on soft tint').toBeGreaterThanOrEqual(4.5);
        expect(contrast(v['--brand-ring'], k.panel), 'focus ring').toBeGreaterThanOrEqual(3);
        // the open page in the sidebar (default: accent pill with its own text colour)
        expect(contrast(v['--on-brand'], v['--brand'])).toBeGreaterThanOrEqual(4.5);
        // status colours as text (overdue dates, "+20" points, "Live", warnings) on cards and on the page
        for (const s of ['--green', '--red', '--yellow']) {
          expect(contrast(v[s], k.panel), `${s} on panel`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(v[s], k.bg), `${s} on bg`).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }

  it('applies an agency colour only to the standard theme, a personal accent to every theme', () => {
    expect(resolveAccent({ theme: 'gohigh', accent: '', palette: 'harmonic', brandColor: '#d946ef' }, false)).toBe('#d946ef');
    expect(resolveAccent({ theme: 'wald', accent: '', palette: 'harmonic', brandColor: '#d946ef' }, false)).toBe(THEMES.wald.light.accent);
    expect(resolveAccent({ theme: 'wald', accent: '#FF0000', palette: 'harmonic', brandColor: '#d946ef' }, true)).toBe('#ff0000');
    expect(resolveAccent({ theme: 'gohigh', accent: '', palette: 'harmonic', brandColor: '#2563eb' }, true)).toBe(THEMES.gohigh.dark.accent);
  });

  it('builds the style sheet: screen only, one mode, every variable', () => {
    const css = buildCss({ theme: 'nordlicht', accent: '', palette: 'harmonic' }, true);
    expect(css.startsWith("@media screen{:root[data-theme-id][data-theme='dark']{")).toBe(true);
    for (const name of ['--bg', '--panel', '--text', '--muted', '--line', '--side', '--brand', '--on-brand', '--brand-text', '--brand-soft', '--d-crm', '--d-system-ink']) expect(css).toContain(`${name}:`);
    expect(css).toContain('color-scheme:dark');
    expect(buildCss({ theme: 'nordlicht', accent: '', palette: 'harmonic' }, false)).toContain("[data-theme='light']");
    // balanced braces
    expect([...css].filter((c) => c === '{').length).toBe([...css].filter((c) => c === '}').length);
  });
});

describe('department colours', () => {
  it('maps every menu route to a department and covers every department', () => {
    const main = read('web/src/main.tsx');
    const routes = [...main.matchAll(/\[\s*'([\w-]+)',\s*'[\w]+',\s*'[^']+',\s*'[^']*'\s*\]/g)].map((m) => m[1]);
    expect(routes.length).toBeGreaterThan(30);
    for (const r of routes) expect(DEPT_OF_ROUTE[r], `Bereich für ${r}`).toBeTruthy();
    const ids = DEPTS.map((d) => d.id) as string[];
    for (const d of Object.values(DEPT_OF_ROUTE)) expect(ids).toContain(d);
    for (const id of ids) expect(Object.values(DEPT_OF_ROUTE), id).toContain(id);
    // theme.css knows each department's variables
    const css = read('web/src/theme/theme.css');
    for (const id of ids) expect(css, id).toContain(`[data-dept='${id}']`);
  });

  it('keeps every department colour readable in every theme, mode and palette', () => {
    for (const t of THEME_LIST)
      for (const dark of [false, true])
        for (const palette of DEPT_PALETTES) {
          const k = modeTokens(t.id, dark);
          const accent = resolveAccent({ theme: t.id, accent: '', palette }, dark);
          const colors = deptColors(palette, dark, accent, k);
          for (const d of DEPTS) {
            const c = colors[d.id];
            const at = `${t.id} ${dark ? 'dark' : 'light'} ${palette} ${d.id}`;
            // icons / dots / stripes on the sidebar, text on the page
            expect(contrast(c.side, k.side), `${at}: sidebar`).toBeGreaterThanOrEqual(3.5);
            for (const bg of [k.panel, k.bg]) expect(contrast(c.text, bg), `${at}: text`).toBeGreaterThanOrEqual(4.5);
            // gradient pill and header band: the ink reads at both ends
            expect(contrast(c.ink, c.base), `${at}: ink`).toBeGreaterThanOrEqual(4.5);
            expect(contrast(c.ink, c.base2), `${at}: ink 2`).toBeGreaterThanOrEqual(4.5);
            // "klar": tinted page header (9% of the colour over the card) keeps text and muted text readable
            const band = over(k.panel, c.base, 0.09);
            expect(contrast(k.text, band), `${at}: band text`).toBeGreaterThanOrEqual(4.5);
            expect(contrast(k.muted, band), `${at}: band muted`).toBeGreaterThanOrEqual(4.5);
            // "klar": the open menu item (28% tint) and the hover (18%) keep the sidebar text readable
            expect(contrast(k.sideText, over(k.side, c.side, 0.28)), `${at}: nav active`).toBeGreaterThanOrEqual(4.5);
          }
        }
  });

  it('spreads the departments: every pair differs clearly, each palette has its own character', () => {
    const k = modeTokens('gohigh', false);
    for (const palette of DEPT_PALETTES) {
      const colors = deptColors(palette, false, '#2563eb', k);
      const bases = DEPTS.filter((d) => !('neutral' in d)).map((d) => toOklch(colors[d.id].base));
      for (let i = 0; i < bases.length; i++)
        for (let j = i + 1; j < bases.length; j++) {
          const dh = Math.min(Math.abs(bases[i].h - bases[j].h), 360 - Math.abs(bases[i].h - bases[j].h));
          expect(dh, `${palette} ${i}/${j}`).toBeGreaterThanOrEqual(14);
        }
    }
    const chroma = (p: (typeof DEPT_PALETTES)[number]) => toOklch(deptColors(p, false, '#2563eb', k).marketing.base).c;
    expect(chroma('rainbow')).toBeGreaterThan(chroma('harmonic'));
    expect(chroma('harmonic')).toBeGreaterThan(chroma('muted'));
    expect(DEPT_LEVELS).toEqual(['off', 'subtle', 'clear', 'vibrant']);
  });
});

describe('menu and icon pack consistency', () => {
  const main = read('web/src/main.tsx');
  const nav = [...main.matchAll(/\[\s*'([\w-]+)',\s*'([\w]+)',\s*'[^']+',\s*'[^']*'\s*\]/g)].map((m) => ({ route: m[1], icon: m[2] }));

  it('lists every menu entry as hideable or always visible', () => {
    for (const { route } of nav) expect([...MODULE_IDS, ...ALWAYS_VISIBLE], route).toContain(route);
    for (const id of MODULE_IDS) expect(nav.map((n) => n.route), id).toContain(id);
  });

  it('the solid pack draws every menu icon, with plain markup only', () => {
    for (const { icon } of nav) expect(SOLID[icon as keyof typeof SOLID], `Symbol ${icon}`).toBeTruthy();
    for (const [name, svg] of Object.entries(SOLID)) {
      expect(svg, name).not.toMatch(/<script|on\w+=|javascript:|href=|<image|<use|<foreignObject/i);
      expect([...svg.matchAll(/<(\w+)[^>]*?(\/?)>/g)].filter((m) => !m[2]).length, `${name}: all tags self-closing`).toBe(0);
    }
    expect(ICON_PACKS).toEqual(['line', 'fine', 'bold', 'square', 'duotone', 'solid']);
  });

  it('theme.css has balanced braces and styles every pack and level it offers', () => {
    const css = read('web/src/theme/theme.css').replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    for (const pack of ICON_PACKS.filter((p) => p !== 'line')) expect(css, pack).toContain(`data-icons='${pack}'`);
    for (const level of DEPT_LEVELS.filter((l) => l !== 'off')) expect(css, level).toContain(`data-dept-mode='${level}'`);
    expect(css).toContain("data-sidebar='rail'");
    // the rail shows from 600 px (phones keep the drawer below); from 600 to 1023 px it is always on (data-size, web/src/ios/viewport.ts)
    expect(css).toContain('(min-width: 600px)');
    expect(css).toContain("[data-size='medium']");
  });
});

describe('boot script', () => {
  const src = read('web/public/theme-boot.js');
  const run = (store: Record<string, string>, dark = false) => {
    const attrs: Record<string, string> = {};
    const styles: { id?: string; textContent?: string }[] = [];
    const meta: Record<string, string> = {};
    runInNewContext(src, {
      document: {
        documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) },
        head: { appendChild: (el: any) => styles.push(el) },
        createElement: () => ({}),
        querySelector: () => ({ setAttribute: (k: string, v: string) => (meta[k] = v) }),
      },
      localStorage: { getItem: (k: string) => store[k] ?? null },
      window: { matchMedia: () => ({ matches: dark }) },
      matchMedia: () => ({ matches: dark }),
    });
    return { attrs, styles, meta };
  };
  const cache = (mode: string) => JSON.stringify({ v: 1, p: { ...PREF_DEFAULTS, theme: 'wald', mode, sidebar: 'rail', dept: 'clear', icons: 'duotone' }, css: { light: '/*light*/', dark: '/*dark*/' }, side: { light: '#111111', dark: '#222222' } });

  it('paints the cached look before React: attributes, generated CSS, meta colour', () => {
    const r = run({ 'pghl.look': cache('light') });
    expect(r.attrs).toMatchObject({ 'data-theme': 'light', 'data-theme-id': 'wald', 'data-sidebar': 'rail', 'data-dept-mode': 'clear', 'data-icons': 'duotone', 'data-density': 'normal' });
    expect(r.styles[0]).toMatchObject({ id: 'pghl-theme', textContent: '/*light*/' });
    expect(r.meta.content).toBe('#111111');
  });

  it('follows the system mode', () => {
    expect(run({ 'pghl.look': cache('system') }, true).attrs['data-theme']).toBe('dark');
    expect(run({ 'pghl.look': cache('system') }, true).styles[0].textContent).toBe('/*dark*/');
    expect(run({ 'pghl.look': cache('system') }, false).attrs['data-theme']).toBe('light');
    expect(run({ 'pghl.look': cache('light') }, true).attrs['data-theme']).toBe('light');
  });

  it('survives an empty or damaged cache and still honours the old light/dark setting', () => {
    expect(run({}).attrs).toEqual({});
    expect(run({ 'pghl.look': '{not json' }).attrs).toEqual({});
    expect(run({ 'pghl.theme': 'dark' }).attrs).toEqual({ 'data-theme': 'dark' });
  });
});

describe('look store: sidebar collapse persists', () => {
  const mem = new Map<string, string>();
  const session = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const style = { textContent: '' };
  const calls: { method: string; url: string; body: any }[] = [];

  const answer = (patch: Record<string, unknown>) => ({ prefs: patch, effective: { ...PREF_DEFAULTS, ...patch }, defaults: {}, locks: {}, offer_profiles: false });

  beforeEach(() => {
    mem.clear();
    session.clear();
    calls.length = 0;
    for (const k of Object.keys(dataset)) delete dataset[k];
    const storage = (m: Map<string, string>) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
    vi.stubGlobal('localStorage', storage(mem));
    vi.stubGlobal('sessionStorage', storage(session));
    vi.stubGlobal('document', {
      documentElement: { dataset },
      head: { appendChild: () => undefined },
      getElementById: () => style,
      createElement: () => style,
      querySelector: () => ({ setAttribute: () => undefined }),
    });
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined }));
    let current: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init.method ?? 'GET', url, body });
      if (init.method === 'PATCH') current = { ...current, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)) };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => answer(current) };
    });
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('applies the choice at once, sends it to the server and restores it on the next visit', async () => {
    const store = await import('../web/src/theme/store');
    expect(store.getPrefs().sidebar).toBe('full');
    await store.toggleSidebar();
    expect(store.getPrefs().sidebar).toBe('rail');
    expect(dataset.sidebar).toBe('rail');
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/appearance', body: { sidebar: 'rail' } });
    expect(JSON.parse(mem.get('pghl.look')!).p.sidebar).toBe('rail');

    // a new page load: the cached look is there before the server answers
    vi.resetModules();
    const next = await import('../web/src/theme/store');
    expect(next.getPrefs().sidebar).toBe('rail');
    expect(dataset.sidebar).toBe('rail');
    await next.toggleSidebar();
    expect(next.getPrefs().sidebar).toBe('full');
    expect(JSON.parse(mem.get('pghl.look')!).p.sidebar).toBe('full');
  });

  it('takes the server state after sign-in and applies theme, accent and hidden entries', async () => {
    const store = await import('../web/src/theme/store');
    await store.update({ theme: 'wald', mode: 'dark', accent: '#e11d48', hidden: ['tickets', 'courses'] });
    expect(dataset).toMatchObject({ theme: 'dark', themeId: 'wald' });
    expect(store.isModuleVisible('tickets')).toBe(false);
    expect(store.isModuleVisible('contacts')).toBe(true);
    store.setShowAll(true);
    expect(store.isModuleVisible('tickets')).toBe(true);
    expect(session.get('pghl.show-all')).toBe('1');
    store.setShowAll(false);
    const cached = JSON.parse(mem.get('pghl.look')!);
    expect(cached.css.dark).toContain('#e11d48');
    expect(cached.p.hidden).toEqual(['tickets', 'courses']);
  });

  it('keeps the own tile order out of the look cache everyone on the browser shares', async () => {
    const { tile_order: _none, ...effective } = PREF_DEFAULTS;
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ prefs: { theme: 'wald', tile_order: { 'dashboard.stats': ['won', 'contacts'] } }, effective: { ...effective, theme: 'wald' }, defaults: {}, locks: {}, offer_profiles: false }),
    }));
    // a cache written by an earlier version, with someone else's order in it
    mem.set('pghl.look', JSON.stringify({ v: 1, p: { theme: 'wald', tile_order: { 'agency.projects': ['loc-of-someone-else'] } } }));
    const store = await import('../web/src/theme/store');
    expect(store.getPrefs().tile_order).toEqual({});
    await store.loadAppearance();
    // the order comes once, in `prefs` (web/src/sortable takes it from here) …
    expect(store.getPrefs().tile_order).toEqual({ 'dashboard.stats': ['won', 'contacts'] });
    // … and never lands in the shared cache
    const cached = JSON.parse(mem.get('pghl.look')!);
    expect(cached.p.theme).toBe('wald');
    expect(cached.p.tile_order).toBeUndefined();
  });

  it('carries the old light/dark choice over and ignores a damaged cache', async () => {
    mem.set('pghl.theme', 'dark');
    let store = await import('../web/src/theme/store');
    expect(store.getPrefs().mode).toBe('dark');
    mem.clear();
    mem.set('pghl.look', '{"p": {"theme": 42, "sidebar": "sideways"}}');
    vi.resetModules();
    store = await import('../web/src/theme/store');
    expect(store.getPrefs()).toEqual(PREF_DEFAULTS);
  });
});
