import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FILTERS, filterPresets, tagsOf } from '../web/src/pages/ai-gallery-filter.js';
import { PRESETS, presetOut } from '../server/services/ai-presets.js';

/** The gallery (search, EU-Hosting / günstig / schnell / lokal / Abo-Anmeldung), modals with ✕ and Esc, big hit targets. */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const presets = PRESETS.map(presetOut);
const ids = (o: Partial<Parameters<typeof filterPresets>[1]> = {}) => filterPresets(presets, { q: '', kind: '', tags: [], ...o }).map((p) => p.id);

describe('provider gallery filters', () => {
  it('offers the filters the task asks for', () => {
    expect(FILTERS.map(([k]) => k)).toEqual(['eu', 'cheap', 'fast', 'local', 'sub']);
    expect(FILTERS.map(([, l]) => l)).toEqual(['EU-Hosting', 'günstig', 'schnell', 'lokal', 'Abo-Anmeldung']);
  });

  it('EU-Hosting shows exactly the providers whose documentation names the place of processing', () => {
    expect(ids({ tags: ['eu'] }).sort()).toEqual(['ionos', 'mistral_eu', 'ovh', 'scaleway', 'stackit']);
  });

  it('günstig, schnell, lokal and Abo-Anmeldung', () => {
    expect(ids({ tags: ['cheap'] })).toEqual(expect.arrayContaining(['novita', 'featherless', 'moonshot', 'scaleway']));
    expect(ids({ tags: ['fast'] })).toEqual(['sambanova']);
    expect(ids({ tags: ['local'] }).sort()).toEqual(['litellm', 'lmstudio', 'ollama', 'speech_local']);
    expect(ids({ tags: ['local'] })).not.toContain('openai');
    expect(ids({ tags: ['sub'] }).sort()).toEqual(['anthropic', 'openai']);
    expect(tagsOf({ id: 'x', tags: ['cheap'], eu: { region: 'EU' }, local: false }).has('eu')).toBe(true);
  });

  it('combines filters (all must match), the kind of provider and the search', () => {
    expect(ids({ tags: ['eu', 'cheap'] }).sort()).toEqual(['ovh', 'scaleway']);
    expect(ids({ tags: ['eu'], kind: 'media' })).toEqual([]);
    expect(ids({ q: 'frankreich' })).toEqual(['ovh']);
    expect(ids({ q: 'DEUTSCHLAND', tags: ['eu'] })).toEqual(['ionos']);
    expect(ids({ q: 'kimi' })).toEqual(['moonshot']);
    expect(ids({ q: 'zzz-nothing' })).toEqual([]);
    expect(ids({ kind: 'media' })).toEqual(expect.arrayContaining(['fal', 'kie', 'replicate']));
  });

  it('keeps OpenRouter first', () => {
    expect(ids()[0]).toBe('openrouter');
    expect(ids({ kind: 'text' })[0]).toBe('openrouter');
  });
});

describe('the new screens', () => {
  const files = ['web/src/pages/AiSubscriptions.tsx', 'web/src/pages/AiGallery.tsx'];

  it('use the shared Modal (top-right ✕, Esc closes) and no home-made overlay', () => {
    for (const f of files) {
      const src = read(f);
      expect(src, f).toContain('<Modal');
      expect(src, f).not.toContain('modal-bg');
    }
    // the shared Modal really has both
    const ui = read('web/src/ui.tsx');
    // Esc closes the topmost dialog (useFocusLayer, which the Modal uses)
    expect(ui).toMatch(/useFocusLayer\(box, onClose\)/);
    expect(ui).toMatch(/e\.key === 'Escape'\)[^;\n]*close\.current\(\)/);
    // the ✕ is named "Schließen" (the German text is the message id of the language layer: aria-label={t('Schließen')})
    expect(ui).toMatch(/className="icon-btn" onClick=\{onClose\} aria-label=(?:"Schließen"|\{t\('Schließen'\)\})/);
  });

  it('keep every control at least 44 px high (60 px in spatial mode)', () => {
    const css = read('web/src/pages/AiGallery.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
    const minHeight = (selector: string, spatial = false) => Math.max(0, ...rules.filter((r) => r.sel.split(',').some((x) => x.trim() === (spatial ? `:root[data-spatial] ${selector}` : selector))).map((r) => Number(/min-height:\s*(\d+)px/.exec(r.body)?.[1] ?? 0)));
    for (const sel of ['.aisub-big', '.aisub-btn', '.aig-chip', '.aisub-tabs button', '.aisub-link', '.aig-main', '.aig-foot a', '.aig-toolbar input.aig-search', '.aisub-device-fields input, .aisub-device-fields select, .aisub textarea'.split(',')[0].trim()]) {
      expect(minHeight(sel), sel).toBeGreaterThanOrEqual(sel === '.aig-main' ? 96 : 44);
    }
    for (const sel of ['.aisub-big', '.aig-chip', '.aisub-btn', '.aisub-link', '.aig-foot a', '.aisub-tabs button']) expect(minHeight(sel, true), `spatial ${sel}`).toBeGreaterThanOrEqual(60);
    // focus states for eye tracking and keyboards
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/\.aig-chip:hover/);
  });

  it('has balanced braces and works in dark mode through the app tokens', () => {
    const css = read('web/src/pages/AiGallery.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect((css.match(/\{/g) ?? []).length).toBe((css.match(/\}/g) ?? []).length);
    expect(css).toContain('var(--panel)');
    expect(css).toContain("[data-theme='dark']");
  });

  it('never offers a working "Mit Claude anmelden" OAuth flow (Anthropic policy) – only the bridge or an API key', () => {
    const all = [...files, 'server/modules/ai-subscriptions.ts', 'server/services/chatgpt-oauth.ts'].map(read).join('\n');
    expect(all).not.toMatch(/claude\.ai\/oauth|console\.anthropic\.com\/oauth|platform\.claude\.com\/oauth/);
    expect(all).not.toMatch(/9d1c250a-e61b-44d9-88ed-5944d1962f5e/); // Claude Code's public OAuth client id must not appear
    expect(read('web/src/pages/AiSubscriptions.tsx')).toContain('Mit Claude verbinden');
    expect(read('web/src/pages/AiSubscriptions.tsx')).not.toMatch(/>\s*Mit Claude anmelden\s*</); // no button with that label
    expect(read('web/src/pages/AiSubscriptions.tsx')).toContain('code.claude.com/docs/en/legal-and-compliance');
    // and the codebase has no Anthropic OAuth token endpoint
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    for (const f of walk(join(ROOT, 'server')).filter((x) => x.endsWith('.ts'))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/console\.anthropic\.com\/v1\/oauth\/token|api\.anthropic\.com\/api\/oauth/);
  });
});
