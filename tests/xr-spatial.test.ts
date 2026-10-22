import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREF_DEFAULTS, THEME_IDS } from '../server/services/appearance-model';
import { contrast, hexToRgb } from '../web/src/theme/color';
import { buildCss, buildVars } from '../web/src/theme/css';
import { THEMES } from '../web/src/theme/themes';
import { detectXr, spatialActive, XR_LABELS } from '../web/src/xr/detect';
import { hintFor, INSTALL_HINTS } from '../web/src/xr/install';
import { GLASS_BACKDROPS, glassAlpha, glassTarget, over, spatialVars } from '../web/src/xr/tokens';
import { collectFontRules, spatialFontRule, splitSelectors } from '../web/src/xr/type-scale';
import { toggleTarget } from '../web/src/xr/spatial';

const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** What the browsers of the devices really send (or, where the vendor changes it, the documented shape). */
const UA = {
  quest: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.0.0.1.38.680 SamsungBrowser/4.0 Chrome/126.0.6478.122 VR Safari/537.36',
  quest3: 'Mozilla/5.0 (Linux; Android 12; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6723.58 Safari/537.36',
  pico: 'Mozilla/5.0 (Linux; Android 12; PICO 4 Build/SQ3A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.6723.58 Mobile Safari/537.36 PicoBrowser/3.1.5',
  wolvic: 'Mozilla/5.0 (Android 12; Mobile VR; rv:128.0) Gecko/128.0 Firefox/128.0 Wolvic/1.8',
  androidXr: 'Mozilla/5.0 (Linux; Android 14; Galaxy XR) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Safari/537.36',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  safariIpad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  visionNamed: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/2.0 Safari/605.1.15 visionOS/2.0',
  chromeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36',
  firefoxDesktop: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
};

describe('XR user-agent detection', () => {
  it('recognises the headset browsers', () => {
    expect(detectXr({ ua: UA.quest })).toMatchObject({ device: 'quest', label: 'Meta Quest' });
    expect(detectXr({ ua: UA.quest3 })).toMatchObject({ device: 'quest' });
    expect(detectXr({ ua: UA.pico })).toMatchObject({ device: 'pico' });
    expect(detectXr({ ua: UA.wolvic })).toMatchObject({ device: 'wolvic' });
    expect(detectXr({ ua: UA.androidXr })).toMatchObject({ device: 'android-xr' });
    expect(detectXr({ ua: UA.chromeDesktop, platform: 'Android XR' })).toMatchObject({ device: 'android-xr' });
    expect(detectXr({ ua: UA.visionNamed })).toMatchObject({ device: 'visionos', by: 'user-agent' });
  });

  it('knows visionOS Safari by its WebXR (macOS and iOS Safari have none)', () => {
    expect(detectXr({ ua: UA.safariMac, xr: true })).toMatchObject({ device: 'visionos', by: 'webxr-safari', label: 'Apple Vision Pro' });
    expect(detectXr({ ua: UA.safariIpad, xr: true })?.device).toBe('visionos');
    // the same strings on a Mac or an iPad: no XR
    expect(detectXr({ ua: UA.safariMac, xr: false })).toBeNull();
    expect(detectXr({ ua: UA.safariIpad })).toBeNull();
  });

  it('does not take a desktop, a phone or a desktop with WebXR for a headset', () => {
    for (const ua of [UA.chromeDesktop, UA.chromeAndroid, UA.firefoxDesktop]) {
      expect(detectXr({ ua })).toBeNull();
      // WebXR alone (a PC with a headset, the WebXR emulator) is not a strong signal outside Safari
      expect(detectXr({ ua, xr: true })).toBeNull();
    }
    expect(detectXr({ ua: '' })).toBeNull();
    expect(detectXr({ ua: undefined as any })).toBeNull();
    // Chrome on a Mac with an XR flag is still Chrome
    expect(detectXr({ ua: `${UA.safariMac} Chrome/130.0.6723.58`, xr: true })).toBeNull();
  });

  it('has a label for every device and install steps for each', () => {
    for (const d of ['visionos', 'quest', 'pico', 'android-xr', 'wolvic'] as const) expect(XR_LABELS[d]).toBeTruthy();
    expect(INSTALL_HINTS.map((h) => h.id)).toEqual(['visionos', 'quest', 'android-xr', 'glasses']);
    for (const h of INSTALL_HINTS) expect(h.steps.length).toBeGreaterThanOrEqual(2);
    expect(hintFor('pico')?.id).toBe('quest');
    expect(hintFor('visionos')?.id).toBe('visionos');
    expect(hintFor(null)).toBeNull();
  });

  it('turns the Raum-Modus on by the person’s word, or by the device when set to automatic', () => {
    const quest = detectXr({ ua: UA.quest });
    expect(spatialActive('auto', quest)).toBe(true);
    expect(spatialActive('auto', null)).toBe(false);
    expect(spatialActive('on', null)).toBe(true);
    expect(spatialActive('off', quest)).toBe(false);
    expect(PREF_DEFAULTS.spatial).toBe('auto');
  });
});

describe('Raum-Modus tokens: glass, glow and edge stay readable in every theme and mode', () => {
  for (const id of THEME_IDS)
    for (const dark of [false, true])
      it(`${id} (${dark ? 'dark' : 'light'})`, () => {
        const vars = buildVars({ theme: id, accent: '', palette: 'harmonic', spatial: true }, dark);
        const k = dark ? THEMES[id].dark : THEMES[id].light;
        const min = glassTarget(k);
        const a = glassAlpha(k, vars['--brand-text']);
        expect(a).toBeGreaterThanOrEqual(0.8);
        // the text, the muted text and the links read on the glass even over the worst backdrop: pure black or pure white
        for (const b of GLASS_BACKDROPS) {
          const c = over(b, k.panel, a);
          expect(contrast(k.text, c), `text over ${b}`).toBeGreaterThanOrEqual(min);
          expect(contrast(k.muted, c), `muted over ${b}`).toBeGreaterThanOrEqual(Math.min(min, 4.5));
          expect(contrast(vars['--brand-text'], c), `link over ${b}`).toBeGreaterThanOrEqual(4.5);
        }
        // the glass variable really carries that alpha; the strong one is a bit more opaque
        expect(vars['--sp-glass']).toBe(`rgba(${hexToRgb(k.panel).join(', ')}, ${a})`);
        expect(Number(/, ([\d.]+)\)$/.exec(vars['--sp-glass-strong'])![1])).toBeGreaterThanOrEqual(a);
        expect(vars['--sp-glass-solid']).toBe(k.panel);
        // controls keep a visible edge (WCAG 1.4.11) and the hover tint keeps the text readable
        expect(contrast(vars['--sp-edge'], k.panel), 'edge').toBeGreaterThanOrEqual(3);
        expect(contrast(k.text, vars['--sp-hover']), 'text on hover').toBeGreaterThanOrEqual(4.5);
        expect(contrast(vars['--brand-text'], vars['--sp-hover']), 'link on hover').toBeGreaterThanOrEqual(4.5);
        expect(vars['--sp-glow']).toMatch(/^rgba\(/);
        expect(vars['--sp-glow-strong']).toMatch(/^rgba\(/);
      });

  it('only exist while the Raum-Modus is on, and survive a custom accent', () => {
    const off = buildVars({ theme: 'gohigh', accent: '', palette: 'harmonic' }, false);
    expect(Object.keys(off).filter((k) => k.startsWith('--sp-'))).toEqual([]);
    expect(buildCss({ theme: 'gohigh', accent: '', palette: 'harmonic' }, true)).not.toContain('--sp-glass');
    expect(buildCss({ theme: 'gohigh', accent: '', palette: 'harmonic', spatial: true }, true)).toContain('--sp-glass:');
    for (const accent of ['#facc15', '#7c3aed', '#ef4444', '#06b6d4'])
      for (const dark of [false, true]) {
        const v = buildVars({ theme: 'nordlicht', accent, palette: 'harmonic', spatial: true }, dark);
        const k = dark ? THEMES.nordlicht.dark : THEMES.nordlicht.light;
        expect(contrast(v['--brand-text'], over('#000000', k.panel, glassAlpha(k, v['--brand-text']))), `${accent} link on glass`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(k.text, v['--sp-hover'])).toBeGreaterThanOrEqual(4.5);
      }
  });

  it('the Kontrast theme keeps its 7:1 on glass', () => {
    const k = THEMES.kontrast.light;
    expect(glassTarget(k)).toBe(7);
    expect(contrast(k.text, over('#000000', k.panel, glassAlpha(k, '#000000')))).toBeGreaterThanOrEqual(7);
    expect(spatialVars(THEMES.kontrast.dark, { brand: '#fff', hover: '#fff', on: '#000', soft: '#111', text: '#ffffff', ring: '#ffffff', select: '#333' }, true)['--sp-glass-solid']).toBe(THEMES.kontrast.dark.panel);
  });
});

describe('type scale for text that sets its own small size', () => {
  it('splits selector lists at the top level only', () => {
    expect(splitSelectors('.a, .b > .c')).toEqual(['.a', '.b > .c']);
    expect(splitSelectors(".a:is(.b, .c), [x='1,2'], .d")).toEqual([".a:is(.b, .c)", "[x='1,2']", '.d']);
    expect(splitSelectors('')).toEqual([]);
  });

  it('writes one override per small px size and leaves the rest alone', () => {
    expect(spatialFontRule('.bd-row-sub', '12px')).toBe("html[data-spatial='1'] .bd-row-sub { font-size: max(14px, calc(12px * var(--sp-type, 1.22))); }");
    expect(spatialFontRule('.a, .b::before', '13.5px')).toContain("html[data-spatial='1'] .a, html[data-spatial='1'] .b::before");
    for (const size of ['9px', '18px', '24px', '1rem', '90%', 'inherit', '', 'calc(1em + 2px)']) expect(spatialFontRule('.x', size), size).toBeNull();
    // roots and keyframe steps keep their size
    expect(spatialFontRule('body', '14px')).toBeNull();
    expect(spatialFontRule('html, :root', '14px')).toBeNull();
    expect(spatialFontRule('from, to', '12px')).toBeNull();
  });

  it('walks sheets including @media blocks and skips other rules', () => {
    const style = (size: string) => ({ getPropertyValue: (n: string) => (n === 'font-size' ? size : '') });
    const rules: any[] = [
      { type: 1, selectorText: '.a', style: style('11px') },
      { type: 1, selectorText: '.b', style: style('16px') },
      { type: 1, selectorText: '.c', style: style('') },
      { type: 4, conditionText: '(max-width: 700px)', cssRules: [{ type: 1, selectorText: '.d', style: style('12px') }, { type: 1, selectorText: '.e', style: style('22px') }] },
      { type: 4, conditionText: '(min-width: 1px)', cssRules: [{ type: 1, selectorText: '.f', style: style('30px') }] },
      { type: 7, cssText: '@keyframes x {}' },
    ];
    const out = collectFontRules(rules);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('.a');
    expect(out[1]).toContain('.b');
    expect(out[2]).toMatch(/^@media \(max-width: 700px\) \{ .*\.d.* \}$/);
  });

  it('really covers the app’s own small text (nothing is left out by a pattern gap)', () => {
    let total = 0;
    let covered = 0;
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.css') ? [join(dir, f)] : []));
    for (const f of walk(join(root.pathname, 'web/src')).filter((x) => !x.endsWith('spatial.css'))) {
      for (const m of stripComments(readFileSync(f, 'utf8')).matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
        const size = /(?:^|;)\s*font-size:\s*([\d.]+px)/.exec(m[2]);
        if (!size) continue;
        const px = Number(size[1].replace('px', ''));
        if (px < 10 || px > 17) continue;
        total++;
        if (spatialFontRule(m[1].trim(), size[1])) covered++;
      }
    }
    expect(total).toBeGreaterThan(300);
    // the rest are roots/keyframes only
    expect(covered / total).toBeGreaterThan(0.97);
  });
});

describe('a checkbox in a cell: the whole cell toggles it', () => {
  const el = (tag: string, props: Record<string, any> = {}, children: any[] = []) => {
    const e: any = { tagName: tag.toUpperCase(), children, ...props, matches: (sel: string) => sel.split(',').some((s) => s.trim().replace(/\[.*\]/, '') === tag), closest: () => null };
    for (const c of children) c.parentElement = e;
    return e;
  };
  const box = (extra = {}) => el('input', { type: 'checkbox', disabled: false, ...extra });
  it('toggles when the checkbox is the only control, never when anything else is', () => {
    const b = box();
    expect(toggleTarget(el('td', {}, [b]))).toBe(b);
    expect(toggleTarget(el('td', {}, [box(), box()]))).toBeNull();
    expect(toggleTarget(el('td', {}, [b, el('a')]))).toBeNull();
    expect(toggleTarget(el('td', {}, [box({ disabled: true })]))).toBeNull();
    expect(toggleTarget(el('td', {}, [el('span')]))).toBeNull();
    expect(toggleTarget(el('button', {}, [box()]))).toBeNull();
    expect(toggleTarget(null)).toBeNull();
    // a label already does it natively
    expect(toggleTarget({ ...el('td', {}, [box()]), closest: (s: string) => (s === 'label' ? {} : null) } as any)).toBeNull();
  });
});

describe('the look store applies the Raum-Modus', () => {
  const mem = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const style = { textContent: '' };
  const stub = (userAgent: string, xr = false) => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    vi.stubGlobal('navigator', { userAgent, ...(xr ? { xr: {} } : {}) });
    vi.stubGlobal('document', { documentElement: { dataset }, head: { appendChild: () => undefined }, getElementById: () => style, createElement: () => style, querySelector: () => ({ setAttribute: () => undefined }) });
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined }));
    let server: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      // like the real server: what was sent is remembered
      if (init.body) server = { ...server, ...JSON.parse(String(init.body)) };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ prefs: server, effective: { ...PREF_DEFAULTS, ...server }, defaults: {}, locks: {}, offer_profiles: false }) };
    });
  };
  beforeEach(() => {
    mem.clear();
    for (const k of Object.keys(dataset)) delete dataset[k];
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stays off on a desktop, switches on by hand and puts the roomy density, the tokens and the flag in the cache', async () => {
    stub(UA.chromeDesktop);
    const store = await import('../web/src/theme/store');
    expect(dataset.spatial).toBe('0');
    expect(dataset.density).toBe('normal');
    expect(JSON.parse(mem.get('pghl.look') ?? '{}').spatial ?? false).toBe(false);
    await store.update({ spatial: 'on' });
    expect(dataset.spatial).toBe('1');
    expect(dataset.density).toBe('comfortable');
    expect(store.getPrefs().spatial).toBe('on');
    const cached = JSON.parse(mem.get('pghl.look')!);
    expect(cached.spatial).toBe(true);
    expect(cached.p.spatial).toBe('on');
    expect(cached.css.light).toContain('--sp-glass:');
    expect(cached.css.dark).toContain('--sp-edge:');
    await store.update({ spatial: 'off' });
    expect(dataset.spatial).toBe('0');
    expect(dataset.density).toBe('normal');
    expect(JSON.parse(mem.get('pghl.look')!).css.light).not.toContain('--sp-glass');
  });

  it('follows the device when set to automatic and keeps the person’s own density underneath', async () => {
    stub(UA.quest);
    const store = await import('../web/src/theme/store');
    expect(store.getPrefs().spatial).toBe('auto');
    expect(dataset.spatial).toBe('1');
    await store.update({ density: 'compact' });
    // the Raum-Modus wins while it is on …
    expect(dataset.density).toBe('comfortable');
    // … and "Aus" gives the person's compact density back
    await store.update({ spatial: 'off' });
    expect(dataset.spatial).toBe('0');
    expect(dataset.density).toBe('compact');
  });

  it('knows visionOS Safari by its WebXR object', async () => {
    stub(UA.safariMac, true);
    const store = await import('../web/src/theme/store');
    expect(store.spatialOf(store.getPrefs())).toBe(true);
    expect(dataset.spatial).toBe('1');
  });
});

describe('boot script paints the Raum-Modus before React', () => {
  const src = read('web/public/theme-boot.js');
  const run = (cache: Record<string, unknown>) => {
    const attrs: Record<string, string> = {};
    runInNewContext(src, {
      document: { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) }, head: { appendChild: () => undefined }, createElement: () => ({}), querySelector: () => null },
      localStorage: { getItem: (k: string) => (k === 'pghl.look' ? JSON.stringify(cache) : null) },
      window: { matchMedia: () => ({ matches: false }) },
      matchMedia: () => ({ matches: false }),
    });
    return attrs;
  };
  it('sets data-spatial and the roomy density from the cache', () => {
    const p = { ...PREF_DEFAULTS, density: 'compact' };
    expect(run({ v: 1, p, spatial: true, css: { light: '', dark: '' } })).toMatchObject({ 'data-spatial': '1', 'data-density': 'comfortable' });
    expect(run({ v: 1, p, spatial: false, css: { light: '', dark: '' } })).toMatchObject({ 'data-spatial': '0', 'data-density': 'compact' });
    expect(run({ v: 1, p, css: { light: '', dark: '' } })).toMatchObject({ 'data-spatial': '0' });
  });
});

describe('the Raum-Modus stylesheets', () => {
  const spatial = read('web/src/xr/spatial.css');
  const css = stripComments(spatial);

  it('have balanced braces', () => {
    for (const f of ['web/src/xr/spatial.css', 'web/src/xr/workspace.css', 'web/src/xr/card.css']) {
      let depth = 0;
      for (const ch of stripComments(read(f))) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        expect(depth, f).toBeGreaterThanOrEqual(0);
      }
      expect(depth, f).toBe(0);
    }
  });

  it('contain no empty selector (":is(a, b,)" is dropped by the browser, with all its rules)', () => {
    for (const f of ['web/src/xr/spatial.css', 'web/src/xr/workspace.css', 'web/src/xr/card.css', 'web/src/xr/viewer.css']) {
      const c = stripComments(read(f));
      expect(c, f).not.toMatch(/,\s*[)}{]/);
      expect(c, f).not.toMatch(/\(\s*,/);
    }
  });

  it('promise what the mode promises: 60 px targets, gaze glow, focus ring, reduced motion, more contrast, opaque fallback', () => {
    expect(css).toContain('--sp-hit: 60px');
    expect(css).toMatch(/min-height: var\(--sp-hit\)/);
    expect(css).toContain('var(--sp-glow)');
    expect(css).toContain('var(--sp-glow-strong)');
    expect(css).toContain(':focus-visible');
    expect(css).toContain(':hover');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (prefers-contrast: more)');
    expect(css).toContain('var(--sp-glass-solid)');
    expect(css).toContain('@supports not');
    // every rule is scoped to the mode (or is a media/supports wrapper or a token block)
    for (const m of css.matchAll(/(?:^|\})\s*([^{}@]+)\{/g)) {
      for (const sel of splitSelectors(m[1])) {
        expect(sel.startsWith('html') || sel.startsWith('.sp-move') || /^(from|to|\d+%)$/.test(sel), `unscoped selector: ${sel}`).toBe(true);
      }
    }
  });

  it('shows what a pointer would only reveal: every hover-reveal in the app’s CSS is switched on here', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.css') ? [join(dir, f)] : []));
    const revealed = new Set<string>();
    for (const f of walk(join(root.pathname, 'web/src')).filter((x) => !/xr\/(spatial|workspace|card)\.css$/.test(x))) {
      for (const m of stripComments(readFileSync(f, 'utf8')).matchAll(/([^{}]*:hover[^{}]*)\{([^{}]*)\}/g)) {
        if (!/(?:^|;)\s*(?:opacity:\s*1|display:\s*(?:flex|block|inline-flex|grid))\b/.test(m[2])) continue;
        // `.card:hover .tools { opacity: 1 }` reveals ".tools"; a selector without a descendant after :hover (the hovered thing itself) is a hover style, not a reveal
        for (const sel of m[1].split(',')) {
          const after = /:hover\s*(?:>\s*)?(\.[\w-]+)\s*$/.exec(sel.trim());
          if (after) revealed.add(after[1]);
        }
      }
    }
    // the ones this app has today – a new one must be added to spatial.css ("no hover-only actions")
    expect(revealed.size).toBeGreaterThanOrEqual(8);
    const missing = [...revealed].filter((cls) => !new RegExp(`\\${cls}\\b`).test(css));
    expect(missing, `Hover-only controls need a line in web/src/xr/spatial.css ("no hover-only actions"): ${missing.join(', ')}`).toEqual([]);
  });
});
