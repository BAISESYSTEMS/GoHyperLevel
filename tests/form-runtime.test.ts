import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { minifyCss, minifyJs, stripCss, stripJs } from '../server/services/form-assets.js';
import type { FormField } from '../server/services/form-fields.js';
import { CLIENT_LOGIC, buildScreens, clientSpec, computeValues, leanSpec, nextShown } from '../server/services/form-logic.js';
import { renderForm } from '../server/services/form-render.js';
import { CSS_PARTS, JS_PARTS, cssSource, formScript, formStyle, jsSource, partCss, partJs, planRuntime, type PlanInput } from '../server/services/form-runtime.js';

/**
 * The browser side of a public form is split into parts (server/assets/forms, docs/forms.md): a base for a classic form and one part per
 * feature, minified, and a page only gets the parts its form uses. These tests pin that down; the behaviour of the parts in a real browser
 * is checked by tests/form-browser.test.ts (opt in with PGHL_BROWSER_TESTS=1).
 */

const f = (type: FormField['type'], name: string, extra: Partial<FormField> = {}): FormField => ({ id: `id_${name}`, type, label: name, name, ...extra });
const contact = (): FormField[] => [f('text', 'first_name', { required: true }), f('email', 'email', { required: true }), f('textarea', 'message'), f('consent', 'consent', { required: true })];
const input = (fields: FormField[], o: Partial<PlanInput> = {}, settings: Record<string, any> = {}): PlanInput => {
  const mode = settings.mode === 'typeform' ? 'typeform' : 'classic';
  return { fields, settings, mode, screens: buildScreens(fields, mode).length, welcome: false, progress: false, standalone: false, captcha: false, partial: false, ...o };
};
const hasEsbuild = minifyJs('var  a = 1 ;') === 'var a=1;';
const scriptOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.includes('CFG='))[0];
const styleOf = (html: string) => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('');
const form = (fields: FormField[], settings: Record<string, any> = {}, runtime: Record<string, any> = {}) => ({ id: 'frm1', fields, settings, runtime });

describe('which parts a form gets', () => {
  it('gives a classic contact form the base, analytics and the CSS of what it uses', () => {
    const plan = planRuntime(input(contact()));
    expect(plan.js).toEqual(['core', 'track']);
    expect(plan.css).toEqual(['base', 'choice']);
    expect(plan.rules).toBe(false);
  });

  it('adds the abandoned-entry capture only for a form with an e-mail address or phone number while a workflow listens', () => {
    expect(planRuntime(input(contact(), { partial: true })).js).toEqual(['core', 'track', 'partial']);
    expect(planRuntime(input([f('text', 'first_name')], { partial: true })).js).not.toContain('partial');
    expect(planRuntime(input(contact(), { partial: false })).js).not.toContain('partial');
  });

  it('leaves analytics out when the owner switched it off', () => {
    expect(planRuntime(input(contact(), {}, { analytics: false })).js).toEqual(['core']);
  });

  it('adds screens only for several pages, a welcome screen or one question at a time', () => {
    const paged = [f('text', 'a'), f('page_break', 'pb'), f('text', 'b')];
    expect(planRuntime(input(paged)).js).toEqual(['core', 'rules', 'nav', 'track']);
    expect(planRuntime(input(paged)).css).toEqual(['base', 'nav']);
    expect(planRuntime(input(contact(), { welcome: true, progress: true })).js).toContain('nav');
    const tf = planRuntime(input(contact(), { standalone: true }, { mode: 'typeform' }));
    expect(tf.js).toEqual(expect.arrayContaining(['rules', 'nav', 'tf']));
    expect(tf.css).toEqual(expect.arrayContaining(['tf', 'standalone']));
    expect(planRuntime(input(contact(), { standalone: false }, { mode: 'typeform' })).css).not.toContain('standalone');
  });

  it('adds show-if, calculators and the ending where they are used', () => {
    const cond = [f('radio', 'art', { options: ['a', 'b'] }), f('text', 'x', { show_if: { field: 'art', op: 'eq', value: 'a' } })];
    expect(planRuntime(input(cond)).js).toEqual(['core', 'rules', 'cond', 'track']);
    const calc = planRuntime(input([f('number', 'n'), f('calculator', 'c', { formula: 'n*2' })]));
    expect(calc.js).toEqual(['core', 'rules', 'calc', 'track']);
    expect(calc.css).toContain('calc');
    expect(calc.formulas).toBe(true);
    expect(planRuntime(input(contact(), {}, { endings: [{ title: 'x', text: '' }] })).js).toContain('result');
    expect(planRuntime(input(contact(), {}, { show_result: true })).css).toContain('result');
    expect(planRuntime(input(contact())).js).not.toContain('result');
  });

  it('adds a widget part and its CSS per field type', () => {
    const just = (...fields: FormField[]) => planRuntime(input(fields, {}, { analytics: false }));
    expect(just(f('rating', 'r'))).toMatchObject({ js: ['core', 'scale'], css: ['base', 'stars'] });
    expect(just(f('nps', 'n'))).toMatchObject({ js: ['core', 'scale'], css: ['base', 'ends', 'scale'] });
    expect(just(f('scale', 's'))).toMatchObject({ css: ['base', 'ends', 'scale'] });
    expect(just(f('scale', 's', { style: 'slider' }))).toMatchObject({ js: ['core', 'scale'], css: ['base', 'ends', 'slider'] });
    expect(just(f('signature', 's'))).toMatchObject({ js: ['core', 'sig'], css: ['base', 'sig'] });
    expect(just(f('ranking', 'r', { options: ['a', 'b'] }))).toMatchObject({ js: ['core', 'rank'], css: ['base', 'muted', 'rank'] });
    expect(just(f('date_range', 'd'))).toMatchObject({ js: ['core', 'range'], css: ['base', 'range'] });
    expect(just(f('picture_choice', 'p', { options: ['a'] }))).toMatchObject({ js: ['core'], css: ['base', 'pics'] });
    expect(just(f('payment', 'p'))).toMatchObject({ js: ['core'], css: ['base', 'muted', 'pay'] });
    expect(just(f('file', 'p'))).toMatchObject({ js: ['core', 'file'], css: ['base', 'muted'] });
    expect(just(f('text', 'p', { hint: 'Tipp' }), f('heading', 'h'))).toMatchObject({ js: ['core'], css: ['base', 'hint', 'heading'] });
    expect(planRuntime(input([f('text', 'x')], { captcha: true }, { analytics: false }))).toMatchObject({ js: ['core', 'ts'], css: ['base', 'captcha'] });
  });

  it('has a source file for every part and uses every part somewhere', () => {
    const everything = [
      f('radio', 'r', { options: ['a', 'b'], show_if: { field: 'x', op: 'eq', value: 'a' } }), f('rating', 'r2'), f('nps', 'n'), f('scale', 's', { style: 'slider' }), f('scale', 's2'), f('signature', 'sig'),
      f('ranking', 'rk', { options: ['a'] }), f('date_range', 'dr'), f('picture_choice', 'pc', { options: ['a'] }), f('payment', 'pay'), f('calculator', 'c', { formula: '1' }),
      f('file', 'file'), f('heading', 'h'), f('text', 'email', { hint: 'x' }), f('consent', 'consent'),
    ];
    const plan = planRuntime(input(everything, { welcome: true, progress: true, standalone: true, captcha: true, partial: true }, { mode: 'typeform', endings: [{ title: 'a', text: '' }] }));
    expect(plan.js).toEqual([...JS_PARTS]);
    expect(plan.css).toEqual([...CSS_PARTS]);
    for (const p of JS_PARTS) expect(jsSource(p), p).not.toMatch(/@include|\n\s*\/\/ TODO/);
    for (const p of CSS_PARTS) expect(cssSource(p).length, p).toBeGreaterThan(40);
  });
});

describe('what a page carries', () => {
  it('sends a classic contact form with the base only, in one script and one stylesheet', () => {
    const html = renderForm(form(contact()), { standalone: true });
    const js = scriptOf(html);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<style>/g)).toHaveLength(1);
    for (const gone of ['toDataURL', 'window.turnstile', 'Intl.NumberFormat', 'FileReader', '/partial', 'hover:hover', 'pf-stars', 'pf-sig', 'pf-rank', 'pf-slider']) expect(html, gone).not.toContain(gone);
    // markup that nothing uses is not written: no back button, no option letters, no captcha box
    for (const gone of ['pf-back', 'pf-key', 'pf-captcha', 'pf-hintkey', 'pf-progress']) expect(html, gone).not.toContain(gone);
    expect(html).toContain('class="pf-next">Absenden</button>');
    expect(js).toContain('/track');
    expect(() => new Function(js)).not.toThrow();
  });

  it.runIf(hasEsbuild)('keeps that page small: minified script and stylesheet', () => {
    const html = renderForm(form(contact()), { standalone: true });
    expect(scriptOf(html).length).toBeLessThan(6_000);
    expect(styleOf(html).length).toBeLessThan(3_200);
  });

  it('minifies the stylesheet: no comment, blank line or ";}"', () => {
    const css = styleOf(renderForm(form(contact()), { standalone: true }));
    expect(css).not.toMatch(/\/\*|\n\s*\n|;\s*}/);
    expect(css).toContain('.pf [hidden]{display:none!important}');
  });

  it('puts the abandoned-entry capture on the page only while a workflow listens', async () => {
    const t = await startTestApp();
    try {
      await t.setup();
      const fm = (await t.api.post('/api/forms', { name: 'Abbruch', fields: [{ name: 'email', label: 'E-Mail', type: 'email' }, { name: 'first_name', label: 'Vorname', type: 'text' }] })).data;
      const page = async () => await (await t.api.raw(`/f/${fm.id}`)).text();
      expect(await page()).not.toContain('/partial');
      const wf = (await t.api.post('/api/workflows', { name: 'Abbruch', trigger: { type: 'form.abandoned', config: { form_id: fm.id, minutes: 30 } }, steps: [{ type: 'add_tag', tags: ['abbruch'] }] })).data;
      await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
      expect(await page()).toContain('/partial');
      // another form is not meant
      const other = (await t.api.post('/api/forms', { name: 'Anderes', fields: [{ name: 'email', label: 'E-Mail', type: 'email' }] })).data;
      expect(await (await t.api.raw(`/f/${other.id}`)).text()).not.toContain('/partial');
      await t.api.patch(`/api/workflows/${wf.id}`, { status: 'paused' });
      expect(await page()).not.toContain('/partial');
    } finally {
      await t.close();
    }
  }, 30_000);

  it('puts the one-question layout and every field type of a full form on the page', () => {
    const fields = [
      f('text', 'first_name', { required: true }), f('email', 'email'), f('radio', 'kunde', { options: ['Ja', 'Nein'], points: { Ja: 1 }, jumps: [{ op: 'eq', value: 'Nein', goto: 'end' }] }),
      f('rating', 'sterne'), f('scale', 'zufrieden', { style: 'slider', min: 1, max: 10 }), f('nps', 'nps'), f('date_range', 'zeit'), f('ranking', 'rang', { options: ['a', 'b'] }),
      f('picture_choice', 'bild', { options: ['a', 'b'] }), f('calculator', 'preis', { formula: 'sterne * 2 + score' }), f('signature', 'sig'), f('consent', 'consent'),
    ];
    const html = renderForm(form(fields, { mode: 'typeform', welcome: { title: 'Hallo', text: '', button: 'Los' }, endings: [{ min: 0, title: 'Ergebnis', text: '{{score}}' }] }, { captcha: { site_key: 'KEY' }, partial: true }), { standalone: true });
    const js = scriptOf(html);
    for (const need of ['toDataURL', 'window.turnstile', 'Intl.NumberFormat', '/partial', '/track', 'hover:hover', 'Dein Ergebnis', 'insertBefore']) expect(js, need).toContain(need);
    for (const need of ['pf-stars', 'pf-slider', 'pf-scale', 'pf-sig', 'pf-rank', 'pf-pics', 'pf-calc', 'pf-welcome', 'pf-progress', 'pf-captcha', 'pf-key']) expect(html, need).toContain(need);
    expect(html).toContain('min-height:100vh');
    expect(() => new Function(js)).not.toThrow();
    // an embedded form is not full height
    expect(renderForm(form(fields, { mode: 'typeform' }))).not.toContain('min-height:100vh');
  });

  it('writes only what the parts read into the page: settings and rules without defaults', () => {
    const plain = scriptOf(renderForm(form(contact())));
    expect(plain).toMatch(/^\(function\(\)\{var CFG=\{"id":"frm1"\},\$=\{\};/);
    expect(plain).not.toContain('SPEC=');
    const paged = scriptOf(renderForm(form([f('text', 'a'), f('page_break', 'pb'), f('text', 'b')], { submit_text: 'Los' })));
    expect(paged).toContain('"submit":"Los"');
    expect(paged).toContain('SPEC={"S":[[{}],[{}]]}');
    const redirect = scriptOf(renderForm(form(contact(), { redirect_url: 'https://example.com/danke' })));
    expect(redirect).toContain('"redirect":"https://example.com/danke"');
  });
});

describe('the parts as code', () => {
  it('compiles every script part alone and all together, and never closes the page’s script tag', () => {
    for (const p of JS_PARTS) {
      expect(() => new Function(partJs(p)), p).not.toThrow();
      expect(partJs(p), p).not.toMatch(/<\/script|<!--/i);
    }
    expect(() => new Function(JS_PARTS.map((p) => partJs(p)).join(';'))).not.toThrow();
  });

  it('minifies every stylesheet part', () => {
    for (const p of CSS_PARTS) {
      expect(partCss(p), p).not.toMatch(/\/\*|\n\s*\n|;\s*}|<\/style/i);
      expect(partCss(p).length, p).toBeGreaterThan(30);
    }
  });

  it('assembles a script that survives dangerous settings', () => {
    const js = formScript({ id: 'x', redirect: '</script><script>alert(1)</script>' }, { S: [[{}]] }, planRuntime(input(contact())));
    expect(js).not.toContain('</script>');
    expect(() => new Function(js)).not.toThrow();
    expect(formStyle(planRuntime(input(contact())))).toContain('.pf');
  });

  it('still works when esbuild is not there: comments and indentation come out, nothing else changes', () => {
    for (const p of JS_PARTS) {
      const src = jsSource(p);
      const stripped = stripJs(src);
      expect(() => new Function(stripped), p).not.toThrow();
      expect(stripped, p).not.toMatch(/\/\*|^\s*\/\//m);
      expect(stripped.length, p).toBeLessThan(src.length);
    }
    for (const p of CSS_PARTS) {
      const css = stripCss(cssSource(p));
      expect(css, p).not.toMatch(/\/\*|\n\s*\n|;\s*}/);
      expect(css.length, p).toBeGreaterThan(30);
    }
    // the stripped rules still decide the same way
    const L = new Function(`${stripJs(CLIENT_LOGIC)}; return { pfMatch, pfNextShown };`)() as { pfMatch: (r: any, a: unknown) => boolean };
    expect(L.pfMatch({ op: 'gt', value: '3' }, '4,5')).toBe(true);
    expect(L.pfMatch({ op: 'contains', value: 'AU' }, ['Haus'])).toBe(true);
    expect(L.pfMatch({ op: 'neq', value: 'ja' }, 'JA')).toBe(false);
  });

  it.runIf(hasEsbuild)('minifies smaller than the fallback', () => {
    expect(partJs('core').length).toBeLessThan(stripJs(jsSource('core')).length);
    expect(minifyCss('.a {\n  color : red;\n}\n/* x */')).toBe('.a{color:red}');
  });
});

describe('the lean rules the page carries run like the full ones', () => {
  const L = new Function(`${CLIENT_LOGIC}; return { pfCompute, pfNextShown };`)() as {
    pfCompute: (s: any, raw: Record<string, any>) => Record<string, number>;
    pfNextShown: (S: any, raw: Record<string, any>, i: number) => number;
  };
  let seed = 7_000_001;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];

  it('leaves out defaults and variables', () => {
    const fields = [f('text', 'a'), f('text', 'b', { show_if: { field: 'a', op: 'eq', value: 'x' } }), f('radio', 'c', { options: ['1'], jumps: [{ op: 'eq', value: '1', goto: 'end' }] }), f('hidden', 'h')];
    const lean = leanSpec(clientSpec(fields, { variables: [{ name: 'v', formula: '1' }] }, 'classic'), false);
    expect(lean).toEqual({ S: [[{}, { i: 'id_b', s: { field: 'a', op: 'eq', value: 'x' } }, { n: 'c', j: [{ op: 'eq', value: '1', to: 1 }] }, { h: 1 }]] });
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(clientSpec(fields, undefined, 'classic')).length / 2);
  });

  it('finds the next screen identically', () => {
    for (let i = 0; i < 400; i++) {
      const n = 4 + Math.floor(rnd() * 6);
      const fields: FormField[] = [];
      for (let k = 0; k < n; k++) {
        const jumps = rnd() < 0.5 ? [{ op: pick(['eq', 'neq', 'gt', 'filled', 'contains']) as any, value: pick(['ja', '3', 'a']), goto: rnd() < 0.15 ? 'end' : `q${k + 1 + Math.floor(rnd() * (n - k))}` }] : undefined;
        fields.push(f(pick(['text', 'radio', 'heading', 'hidden', 'text']), `n${k}`, { id: `q${k}`, ...(jumps ? { jumps } : {}), ...(rnd() < 0.3 ? { show_if: { field: `n${Math.floor(rnd() * n)}`, op: pick(['eq', 'filled', 'empty']) as any, value: pick(['ja', 'a']) } } : {}) }));
        if (rnd() < 0.2) fields.push(f('page_break', `pb${k}`, { id: `pb${k}` }));
      }
      for (const fd of fields) fd.jumps = fd.jumps?.filter((j) => j.goto === 'end' || fields.some((o) => o.id === j.goto));
      const mode = pick(['classic', 'typeform'] as const);
      const screens = buildScreens(fields, mode);
      const lean = JSON.parse(JSON.stringify(leanSpec(clientSpec(fields, undefined, mode), false)));
      const raw: Record<string, any> = {};
      for (let k = 0; k < n; k++) if (rnd() < 0.6) raw[`n${k}`] = pick(['ja', '3', 'a', '5', 'nein']);
      for (let s = 0; s < screens.length; s++) expect(L.pfNextShown(lean.S, raw, s), `screen ${s} mode ${mode}`).toBe(nextShown(screens, fields, s, raw));
    }
  });

  it('works out calculators identically without the variables', () => {
    for (let i = 0; i < 200; i++) {
      const fields = [
        f('radio', 'r', { options: ['p', 'q'], points: { p: Math.floor(rnd() * 5), q: 3 } }),
        f('rating', 'st', { weight: pick([0, 1, 2]) }),
        f('number', 'n'),
        f('calculator', 'calc1', { formula: 'n * 2 + score + st', show_if: { field: 'r', op: 'neq', value: 'q' } }),
        f('calculator', 'calc2', { formula: 'max(n, 5) / 2' }),
      ];
      const settings = { variables: [{ name: 'doppelt', formula: 'score * 2' }] };
      const raw: Record<string, any> = {};
      if (rnd() < 0.8) raw.r = pick(['p', 'q']);
      if (rnd() < 0.8) raw.st = String(1 + Math.floor(rnd() * 5));
      if (rnd() < 0.8) raw.n = pick(['12', '3,5', 'abc', '0']);
      const lean = JSON.parse(JSON.stringify(leanSpec(clientSpec(fields, settings, 'classic'), true)));
      const client = L.pfCompute(lean, raw);
      const server = computeValues(fields, settings, raw);
      for (const [id, v] of Object.entries(server.calculators)) expect(client[id], `${id} ${JSON.stringify(raw)}`).toBeCloseTo(v, 9);
    }
  });
});
