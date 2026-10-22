import { jsonForScript } from '../core/page.js';
import { builtRuntime, minifyCss, minifyJs, readAsset } from './form-assets.js';
import type { FormField, FormSettings } from './form-fields.js';
import type { FormMode } from './form-logic.js';

/**
 * What a public form ships to the browser: the base runtime for a classic form (answers, validation, submit) plus only the parts this
 * form needs – screens, show-if, one question at a time, calculators, the ending, signature, ranking, widgets, date range, Turnstile,
 * per-field analytics, the abandoned-form capture – and only the CSS of the field types and layouts it uses. The parts are real files
 * in server/assets/forms (docs/forms.md, "For developers"); they are minified by the build (form-assets.ts).
 *
 * The parts of one form share a closure: CFG (settings of this form), SPEC (rules as data, only when a part reads them) and `$`, an
 * object with a small event bus through which the parts talk to the base part. Order matters (the first listener runs first).
 */

export const JS_PARTS = ['core', 'rules', 'cond', 'nav', 'tf', 'calc', 'result', 'scale', 'sig', 'range', 'rank', 'file', 'ts', 'track', 'partial'] as const;
export const CSS_PARTS = ['base', 'muted', 'hint', 'nav', 'progress', 'welcome', 'result', 'tf', 'standalone', 'choice', 'pics', 'stars', 'ends', 'scale', 'slider', 'sig', 'range', 'rank', 'pay', 'calc', 'captcha', 'heading'] as const;
export type JsPart = (typeof JS_PARTS)[number];
export type CssPart = (typeof CSS_PARTS)[number];

export interface RuntimePlan {
  js: JsPart[];
  css: CssPart[];
  /** A part reads SPEC.S (show-if, screens) / SPEC.f (calculators). */
  rules: boolean;
  formulas: boolean;
}

export interface PlanInput {
  fields: FormField[];
  settings: FormSettings;
  mode: FormMode;
  /** Number of screens (pages, or questions in the one-at-a-time layout). */
  screens: number;
  welcome: boolean;
  progress: boolean;
  standalone: boolean;
  captcha: boolean;
  /** A workflow waits for abandoned entries of this form (the server stores them only then). */
  partial: boolean;
}

/** Which parts a form needs. */
export function planRuntime(i: PlanInput): RuntimePlan {
  const has = (...types: string[]) => i.fields.some((f) => types.includes(f.type));
  const tf = i.mode === 'typeform';
  const nav = tf || i.screens > 1 || i.welcome;
  const cond = i.fields.some((f) => f.show_if?.field);
  const calc = has('calculator');
  const rules = nav || cond || calc;
  const result = !!(i.settings.endings?.length || i.settings.show_result);
  const slider = i.fields.some((f) => f.type === 'scale' && f.style === 'slider');
  const buttons = has('nps') || i.fields.some((f) => f.type === 'scale' && f.style !== 'slider');
  const js: Record<JsPart, boolean> = {
    core: true,
    rules,
    cond,
    nav,
    tf,
    calc,
    result,
    scale: has('rating', 'nps', 'scale'),
    sig: has('signature'),
    range: has('date_range'),
    rank: has('ranking'),
    file: has('file'),
    ts: i.captcha,
    track: i.settings.analytics !== false,
    // only a form with an e-mail address or phone number can report an abandoned entry, and only while a workflow listens
    partial: i.partial && i.fields.some((f) => f.name === 'email' || f.name === 'phone'),
  };
  const css: Record<CssPart, boolean> = {
    base: true,
    muted: has('file', 'ranking', 'payment'),
    hint: i.fields.some((f) => !!f.hint),
    nav,
    progress: i.progress,
    welcome: i.welcome,
    result,
    tf,
    standalone: tf && i.standalone,
    choice: has('radio', 'checkbox', 'consent'),
    pics: has('picture_choice'),
    stars: has('rating'),
    ends: has('nps', 'scale'),
    scale: buttons,
    slider,
    sig: has('signature'),
    range: has('date_range'),
    rank: has('ranking'),
    pay: has('payment'),
    calc: calc,
    captcha: i.captcha,
    heading: has('heading'),
  };
  return { js: JS_PARTS.filter((p) => js[p]), css: CSS_PARTS.filter((p) => css[p]), rules, formulas: calc };
}

/** A part's source: its file with the `/*@include name.js*\/` lines replaced by the named file. */
function source(file: string): string {
  return readAsset(file).replace(/\/\*@include ([\w.-]+)\*\//g, (_m, name: string) => readAsset(name));
}

export const jsSource = (part: JsPart) => source(`${part}.js`);
export const cssSource = (part: CssPart) => readAsset(`${part}.css`);

const memo = new Map<string, string>();
function once(key: string, make: () => string): string {
  let v = memo.get(key);
  if (v === undefined) memo.set(key, (v = make()));
  return v;
}

/** The minified script of a part (from the build output, or minified from the source files on first use). */
export const partJs = (part: JsPart): string => once(`js:${part}`, () => builtRuntime()?.js[part] ?? minifyJs(jsSource(part)));
/** The minified stylesheet of a part. */
export const partCss = (part: CssPart): string => once(`css:${part}`, () => builtRuntime()?.css[part] ?? minifyCss(cssSource(part)));

/** The content of the form's `<style>`. */
export const formStyle = (plan: RuntimePlan): string => plan.css.map(partCss).join('');

/** The content of the form's `<script>`: settings, rules as data, the parts, start. */
export function formScript(cfg: Record<string, unknown>, spec: Record<string, unknown> | null, plan: RuntimePlan): string {
  const parts = plan.js.map((p) => partJs(p).replace(/;?$/, ';')).join('');
  return `(function(){var CFG=${jsonForScript(cfg)}${spec ? `,SPEC=${jsonForScript(spec)}` : ''},$={};${parts}$.run();})();`;
}
