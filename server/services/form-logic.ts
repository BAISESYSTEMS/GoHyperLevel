import { readAsset } from './form-assets.js';
import type { FormField, FormSettings, Rule } from './form-fields.js';

/**
 * Form logic (docs/forms.md): who sees which question (show_if), where an answer sends the visitor (logic jumps), the safe formula
 * language of calculator fields and score variables, and the ending a score leads to. Pure functions. The browser runs the same
 * rules – CLIENT_LOGIC below is the same code as plain JavaScript (server/assets/forms), kept in step by tests/form-logic.test.ts (parity run).
 */

export class FormulaError extends Error {}

// --- rules ------------------------------------------------------------------------------------------------------------------------

export const RULE_OPS = ['eq', 'neq', 'contains', 'filled', 'empty', 'gt', 'gte', 'lt', 'lte'] as const;

const valuesOf = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
const numOf = (s: string) => {
  const n = Number(String(s).trim().replace(',', '.'));
  return String(s).trim() === '' || !Number.isFinite(n) ? NaN : n;
};

/** Does an answer fit a rule? (text compares case-insensitively; gt/lt/… compare numbers, a comma counts as the decimal point) */
export function matchRule(rule: Rule, answer: unknown): boolean {
  const vals = valuesOf(answer);
  const want = String(rule.value ?? '').trim().toLowerCase();
  switch (rule.op) {
    case 'filled':
      return vals.length > 0;
    case 'empty':
      return vals.length === 0;
    case 'neq':
      return !vals.includes(want);
    case 'contains':
      return vals.some((x) => x.includes(want));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = numOf(vals[0] ?? '');
      const b = numOf(want);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return rule.op === 'gt' ? a > b : rule.op === 'gte' ? a >= b : rule.op === 'lt' ? a < b : a <= b;
    }
    default:
      return vals.includes(want);
  }
}

/** A field's show_if against the raw answers (answers are keyed by field name). */
export function isVisible(f: Pick<FormField, 'show_if'>, raw: Record<string, any>): boolean {
  const c = f.show_if;
  if (!c?.field) return true;
  return matchRule(c, raw[c.field]);
}

// --- screens and jumps ----------------------------------------------------------------------------------------------------------------

export type FormMode = 'classic' | 'typeform';
export interface Screen {
  fields: FormField[];
}

const isContent = (f: FormField) => f.type === 'heading';
export const isInput = (f: FormField) => !['heading', 'page_break', 'hidden'].includes(f.type);

/**
 * What the visitor sees one after the other. Classic: a screen per page (page breaks split them). One question at a time: a screen per
 * question, a heading belongs to the question after it, hidden fields ride along on the first screen.
 */
export function buildScreens(fields: FormField[], mode: FormMode): Screen[] {
  if (mode === 'classic') {
    const pages: FormField[][] = [[]];
    for (const f of fields) {
      if (f.type === 'page_break') pages.push([]);
      else pages[pages.length - 1].push(f);
    }
    const kept = pages.filter((p) => p.length);
    return (kept.length ? kept : [[]]).map((p) => ({ fields: p }));
  }
  const screens: Screen[] = [];
  let pending: FormField[] = [];
  const hidden: FormField[] = [];
  for (const f of fields) {
    if (f.type === 'page_break') continue;
    if (f.type === 'hidden') {
      hidden.push(f);
      continue;
    }
    if (isContent(f)) {
      pending.push(f);
      continue;
    }
    screens.push({ fields: [...pending, f] });
    pending = [];
  }
  if (pending.length) screens.push({ fields: pending });
  if (!screens.length) screens.push({ fields: [] });
  screens[0].fields = [...hidden, ...screens[0].fields];
  return screens;
}

/** Page numbers (1-based) by the fields that open them – "jump to page 3" means the first field of that page. */
export function pageStarts(fields: FormField[]): string[] {
  const out: string[] = [];
  let first = true;
  for (const f of fields) {
    if (f.type === 'page_break') {
      first = true;
      continue;
    }
    if (first && !['hidden'].includes(f.type)) {
      out.push(f.id);
      first = false;
    }
  }
  return out;
}

/** Screen index a jump target stands for: a field id, `page:N`, or `end` (= past the last screen). undefined for an unknown target. */
export function resolveTarget(goto: string, screens: Screen[], fields: FormField[]): number | undefined {
  if (goto === 'end') return screens.length;
  const page = /^page:(\d{1,3})$/.exec(goto);
  const id = page ? pageStarts(fields)[Number(page[1]) - 1] : goto;
  if (!id) return undefined;
  const i = screens.findIndex((s) => s.fields.some((f) => f.id === id));
  return i < 0 ? undefined : i;
}

/** Where to go from screen `i`: the first rule of a visible question there that matches (forward only), else the next screen. */
export function nextScreen(screens: Screen[], fields: FormField[], i: number, raw: Record<string, any>): number {
  for (const f of screens[i]?.fields ?? []) {
    if (!isVisible(f, raw)) continue;
    for (const j of f.jumps ?? []) {
      if (!matchRule(j, raw[f.name])) continue;
      const t = resolveTarget(j.goto, screens, fields);
      if (t !== undefined && t > i) return t;
    }
  }
  return i + 1;
}

/** Skips screens that have nothing to show (every question hidden by show_if). */
export function nextShown(screens: Screen[], fields: FormField[], i: number, raw: Record<string, any>): number {
  let n = nextScreen(screens, fields, i, raw);
  while (n < screens.length && !screens[n].fields.some((f) => isVisible(f, raw) && f.type !== 'hidden')) n = nextScreen(screens, fields, n, raw);
  return n;
}

/** The fields the visitor's path leads through (jumps and show_if applied) – the only ones that count on the server. Hidden fields always do. */
export function reachedFields(fields: FormField[], mode: FormMode, raw: Record<string, any>): FormField[] {
  const screens = buildScreens(fields, mode);
  const out: FormField[] = [];
  let i = 0;
  for (let guard = 0; i < screens.length && guard < 2000; guard++) {
    out.push(...screens[i].fields);
    i = nextShown(screens, fields, i, raw);
  }
  return out.filter((f) => isVisible(f, raw));
}

// --- formulas ---------------------------------------------------------------------------------------------------------------------------

export type Ast = { t: 'n'; v: number } | { t: 'v'; n: string } | { t: 'u'; op: string; a: Ast } | { t: 'b'; op: string; a: Ast; b: Ast } | { t: 'c'; fn: string; args: Ast[] } | { t: 'q'; c: Ast; a: Ast; b: Ast };

export const FORMULA_FUNCTIONS: Record<string, [number, number]> = { min: [1, 12], max: [1, 12], sum: [1, 12], avg: [1, 12], round: [1, 2], floor: [1, 1], ceil: [1, 1], abs: [1, 1], sqrt: [1, 1], pow: [2, 2], if: [3, 3] };
const MAX_SRC = 300;
const MAX_NODES = 200;
const MAX_DEPTH = 40;

interface Tok {
  k: 'n' | 'id' | 'op' | 'end';
  v: string;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+(?:[.,]\d+)?|[.,]\d+)/.exec(src.slice(i));
    if (num) {
      out.push({ k: 'n', v: num[1].replace(',', '.') });
      i += num[1].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ k: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = /^(==|!=|<=|>=|&&|\|\||[-+*/%<>!?:(),])/.exec(src.slice(i));
    if (!op) throw new FormulaError(`Unerwartetes Zeichen „${c}“ in der Formel`);
    out.push({ k: 'op', v: op[1] });
    i += op[1].length;
  }
  out.push({ k: 'end', v: '' });
  return out;
}

/** Formula text → syntax tree, or a FormulaError with a German message. Numbers use a dot or a comma; `a ? b : c` and `if(a, b, c)` both work. */
export function parseFormula(src: string): Ast {
  const text = String(src ?? '').trim();
  if (!text) throw new FormulaError('Die Formel ist leer');
  if (text.length > MAX_SRC) throw new FormulaError(`Die Formel ist zu lang (höchstens ${MAX_SRC} Zeichen)`);
  const toks = tokenize(text);
  let p = 0;
  let nodes = 0;
  const peek = () => toks[p];
  const take = () => toks[p++];
  const isOp = (v: string) => peek().k === 'op' && peek().v === v;
  const count = (depth: number) => {
    if (++nodes > MAX_NODES) throw new FormulaError('Die Formel ist zu verschachtelt');
    if (depth > MAX_DEPTH) throw new FormulaError('Die Formel ist zu tief verschachtelt');
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`„${v}“ fehlt in der Formel`);
    take();
  };
  const ternary = (d: number): Ast => {
    const c = logic(d);
    if (!isOp('?')) return c;
    take();
    count(d);
    const a = ternary(d);
    expect(':');
    return { t: 'q', c, a, b: ternary(d) };
  };
  const logic = (d: number): Ast => {
    let l = compare(d);
    while (isOp('&&') || isOp('||')) {
      const op = take().v;
      count(d);
      l = { t: 'b', op, a: l, b: compare(d) };
    }
    return l;
  };
  const compare = (d: number): Ast => {
    let l = add(d);
    while (['==', '!=', '<', '>', '<=', '>='].some(isOp)) {
      const op = take().v;
      count(d);
      l = { t: 'b', op, a: l, b: add(d) };
    }
    return l;
  };
  const add = (d: number): Ast => {
    let l = mul(d);
    while (isOp('+') || isOp('-')) {
      const op = take().v;
      count(d);
      l = { t: 'b', op, a: l, b: mul(d) };
    }
    return l;
  };
  const mul = (d: number): Ast => {
    let l = unary(d);
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = take().v;
      count(d);
      l = { t: 'b', op, a: l, b: unary(d) };
    }
    return l;
  };
  const unary = (d: number): Ast => {
    if (isOp('-') || isOp('+') || isOp('!')) {
      const op = take().v;
      count(d);
      const a = unary(d + 1);
      return op === '+' ? a : { t: 'u', op, a };
    }
    return primary(d);
  };
  const primary = (d: number): Ast => {
    count(d);
    const t = take();
    if (t.k === 'n') return { t: 'n', v: Number(t.v) };
    if (t.k === 'id') {
      if (isOp('(')) {
        take();
        const spec = FORMULA_FUNCTIONS[t.v.toLowerCase()];
        if (!spec) throw new FormulaError(`Die Funktion „${t.v}“ gibt es nicht (${Object.keys(FORMULA_FUNCTIONS).join(', ')})`);
        const args: Ast[] = [];
        if (!isOp(')')) {
          do args.push(ternary(d + 1));
          while (isOp(',') && take());
        }
        expect(')');
        if (args.length < spec[0] || args.length > spec[1]) throw new FormulaError(`„${t.v}“ braucht ${spec[0] === spec[1] ? spec[0] : `${spec[0]} bis ${spec[1]}`} Werte`);
        return { t: 'c', fn: t.v.toLowerCase(), args };
      }
      return { t: 'v', n: t.v };
    }
    if (t.k === 'op' && t.v === '(') {
      const e = ternary(d + 1);
      expect(')');
      return e;
    }
    throw new FormulaError(t.k === 'end' ? 'Die Formel endet unerwartet' : `Unerwartetes „${t.v}“ in der Formel`);
  };
  const ast = ternary(0);
  if (peek().k !== 'end') throw new FormulaError(`Unerwartetes „${peek().v}“ in der Formel`);
  return ast;
}

/** Names a formula reads. */
export function formulaVars(ast: Ast, out = new Set<string>()): Set<string> {
  if (ast.t === 'v') out.add(ast.n);
  else if (ast.t === 'u') formulaVars(ast.a, out);
  else if (ast.t === 'b') (formulaVars(ast.a, out), formulaVars(ast.b, out));
  else if (ast.t === 'c') for (const a of ast.args) formulaVars(a, out);
  else if (ast.t === 'q') (formulaVars(ast.c, out), formulaVars(ast.a, out), formulaVars(ast.b, out));
  return out;
}

/** Evaluates a tree. Unknown names are 0, a division by zero is 0, the result is always a finite number. Comparisons give 1 or 0. */
export function evalAst(ast: Ast, vars: Record<string, number>): number {
  const ev = (n: Ast): number => {
    switch (n.t) {
      case 'n':
        return n.v;
      case 'v':
        return Number.isFinite(vars[n.n]) ? vars[n.n] : 0;
      case 'u':
        return n.op === '-' ? -ev(n.a) : ev(n.a) ? 0 : 1;
      case 'q':
        return ev(n.c) ? ev(n.a) : ev(n.b);
      case 'b': {
        if (n.op === '&&') return ev(n.a) && ev(n.b) ? 1 : 0;
        if (n.op === '||') return ev(n.a) || ev(n.b) ? 1 : 0;
        const a = ev(n.a);
        const b = ev(n.b);
        switch (n.op) {
          case '+':
            return a + b;
          case '-':
            return a - b;
          case '*':
            return a * b;
          case '/':
            return b === 0 ? 0 : a / b;
          case '%':
            return b === 0 ? 0 : a % b;
          case '==':
            return a === b ? 1 : 0;
          case '!=':
            return a !== b ? 1 : 0;
          case '<':
            return a < b ? 1 : 0;
          case '>':
            return a > b ? 1 : 0;
          case '<=':
            return a <= b ? 1 : 0;
          default:
            return a >= b ? 1 : 0;
        }
      }
      default: {
        if (n.fn === 'if') return ev(n.args[0]) ? ev(n.args[1]) : ev(n.args[2]);
        const a = n.args.map(ev);
        switch (n.fn) {
          case 'min':
            return Math.min(...a);
          case 'max':
            return Math.max(...a);
          case 'sum':
            return a.reduce((x, y) => x + y, 0);
          case 'avg':
            return a.reduce((x, y) => x + y, 0) / a.length;
          case 'round': {
            const k = Math.pow(10, Math.min(Math.max(Math.round(a[1] ?? 0), 0), 6));
            return (Math.sign(a[0]) * Math.round(Math.abs(a[0]) * k)) / k;
          }
          case 'floor':
            return Math.floor(a[0]);
          case 'ceil':
            return Math.ceil(a[0]);
          case 'abs':
            return Math.abs(a[0]);
          case 'sqrt':
            return a[0] < 0 ? 0 : Math.sqrt(a[0]);
          default:
            return Math.pow(a[0], a[1]);
        }
      }
    }
  };
  const r = ev(ast);
  return Number.isFinite(r) ? r : 0;
}

// --- values of answers, variables, endings -----------------------------------------------------------------------------------------------

const toNum = (v: unknown): number => {
  const n = Number(String(v ?? '').trim().replace(',', '.'));
  return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : 0;
};

/** Days between "YYYY-MM-DD/YYYY-MM-DD", both included. */
export function rangeDays(v: unknown): number {
  const m = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(String(v ?? ''));
  if (!m) return 0;
  const d = (Date.parse(`${m[2]}T00:00:00Z`) - Date.parse(`${m[1]}T00:00:00Z`)) / 864e5;
  return Number.isFinite(d) && d >= 0 ? Math.round(d) + 1 : 0;
}

/** The number a field stands for in formulas: the value of a number, rating, NPS or scale; the points of the chosen options; days of a range. */
export function fieldNumber(f: FormField, answer: unknown): number {
  switch (f.type) {
    case 'number':
    case 'rating':
    case 'nps':
    case 'scale':
    case 'text':
    case 'textarea':
    case 'phone':
      return toNum(Array.isArray(answer) ? answer[0] : answer);
    case 'date_range':
      return rangeDays(answer);
    case 'select':
    case 'radio':
    case 'picture_choice':
    case 'checkbox':
    case 'ranking': {
      const picked = Array.isArray(answer) ? answer : answer === undefined || answer === '' ? [] : [answer];
      if (f.type === 'checkbox' && !f.options?.length) return picked.length ? 1 : 0;
      if (f.type === 'ranking') return 0;
      return picked.reduce<number>((n, o) => n + (Number(f.points?.[String(o)]) || 0), 0);
    }
    case 'consent':
      return answer ? 1 : 0;
    default:
      return 0;
  }
}

/** Identifier of a field in formulas: its name with everything but letters, digits and "_" turned into "_". */
export const varName = (name: string) => {
  const s = String(name ?? '').replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(s) ? `_${s}` : s;
};

export interface Computed {
  /** Every variable (fields by id and name, calculators, the sub-account's variables, `score`). */
  values: Record<string, number>;
  /** Result per calculator field id. */
  calculators: Record<string, number>;
}

/**
 * Fields → numbers (and `score`: the points of every answered choice plus the weighted value of fields with a weight) → calculators → variables,
 * in this order; a variable called score replaces the points. A formula that does not parse counts as 0 (it was checked when saved).
 */
export function computeValues(fields: FormField[], settings: Pick<FormSettings, 'variables'> | undefined, raw: Record<string, any>): Computed {
  const values: Record<string, number> = {};
  const calculators: Record<string, number> = {};
  let score = 0;
  for (const f of fields) {
    if (!isInput(f) && f.type !== 'hidden') continue;
    if (f.type === 'calculator' || f.type === 'payment') continue;
    if (!isVisible(f, raw)) continue;
    const n = fieldNumber(f, raw[f.name]);
    values[varName(f.id)] = n;
    values[varName(f.name)] = n;
    if (f.points && Object.keys(f.points).length) score += n;
    else if (f.weight && ['number', 'rating', 'nps', 'scale'].includes(f.type)) score += n * f.weight;
  }
  values.score = score;
  for (const f of fields) {
    if (f.type !== 'calculator' || !isVisible(f, raw)) continue;
    let v = 0;
    try {
      v = evalAst(parseFormula(f.formula ?? ''), values);
    } catch {
      v = 0;
    }
    calculators[f.id] = v;
    values[varName(f.id)] = v;
    values[varName(f.name)] = v;
  }
  for (const v of settings?.variables ?? []) {
    try {
      values[varName(v.name)] = evalAst(parseFormula(v.formula), values);
    } catch {
      values[varName(v.name)] = 0;
    }
  }
  return { values, calculators };
}

export interface Ending {
  /** Which variable decides (default: score). */
  var?: string;
  min?: number | null;
  max?: number | null;
  title: string;
  text: string;
  redirect_url?: string;
  /** Tag for the contact. */
  tag?: string;
}

/** The first ending whose range holds the value of its variable. */
export function pickEnding(endings: Ending[] | undefined, values: Record<string, number>): Ending | undefined {
  for (const e of endings ?? []) {
    const v = values[varName(e.var || 'score')] ?? 0;
    if ((e.min === null || e.min === undefined || v >= e.min) && (e.max === null || e.max === undefined || v <= e.max)) return e;
  }
  return undefined;
}

/** Number as shown to people: German separators, at most two decimals, optionally euro or percent. */
export function formatValue(v: number, format: 'number' | 'currency' | 'percent' = 'number'): string {
  const n = Math.round(v * 100) / 100;
  const base = new Intl.NumberFormat('de-DE', { minimumFractionDigits: format === 'currency' ? 2 : 0, maximumFractionDigits: 2 }).format(n);
  return format === 'currency' ? `${base} €` : format === 'percent' ? `${base} %` : base;
}

/** "{{score}}" and "{{name}}" in an ending's text become the numbers; unknown names disappear. */
export function interpolate(text: string, values: Record<string, number>): string {
  return String(text ?? '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, n) => (n in values ? formatValue(values[n]) : ''));
}

// --- what the browser needs to run the same rules ------------------------------------------------------------------------------------------

export interface ClientSpec {
  /** Screens → their questions: name, show_if, jumps with the screen index they lead to, "hidden field". */
  S: { i: string; n: string; s: (Rule & { field: string }) | null; j: (Rule & { to: number })[]; h: boolean }[][];
  /** Fields in order: how their answer becomes a number (kind), points, weight, show_if, formula tree. */
  f: { n: string; vi: string; vn: string; k: 'num' | 'pts' | 'days' | 'bool' | 'calc' | ''; p?: Record<string, number>; w?: number; hp?: boolean; s: (Rule & { field: string }) | null; ast?: Ast; id: string }[];
  /** Variables of the sub-account: name and formula tree. */
  v: { n: string; ast: Ast }[];
}

const KIND: Record<string, 'num' | 'pts' | 'days' | 'bool' | ''> = { number: 'num', rating: 'num', nps: 'num', scale: 'num', text: 'num', textarea: 'num', phone: 'num', date_range: 'days', select: 'pts', radio: 'pts', picture_choice: 'pts', checkbox: 'pts', consent: 'bool' };

/** The data the browser's copy of the rules (CLIENT_LOGIC) works on – built from the same fields, so it cannot disagree with the server. */
export function clientSpec(fields: FormField[], settings: Pick<FormSettings, 'variables'> | undefined, mode: FormMode): ClientSpec {
  const screens = buildScreens(fields, mode);
  const S = screens.map((sc) =>
    sc.fields.map((f) => ({
      i: f.id,
      n: f.name,
      s: f.show_if?.field ? f.show_if : null,
      j: (f.jumps ?? []).flatMap((j) => {
        const to = resolveTarget(j.goto, screens, fields);
        return to === undefined ? [] : [{ op: j.op, value: j.value ?? '', to }];
      }),
      h: f.type === 'hidden',
    })),
  );
  const list: ClientSpec['f'] = [];
  for (const f of fields) {
    if (!isInput(f) && f.type !== 'hidden') continue;
    if (f.type === 'payment') continue;
    const calc = f.type === 'calculator';
    let ast: Ast | undefined;
    if (calc) {
      try {
        ast = parseFormula(f.formula ?? '');
      } catch {
        ast = { t: 'n', v: 0 };
      }
    }
    let k: ClientSpec['f'][number]['k'] = calc ? 'calc' : (KIND[f.type] ?? '');
    if (f.type === 'checkbox' && !f.options?.length) k = 'bool';
    list.push({ id: f.id, n: f.name, vi: varName(f.id), vn: varName(f.name), k, ...(f.points && Object.keys(f.points).length ? { p: f.points, hp: true } : {}), ...(f.weight && ['number', 'rating', 'nps', 'scale'].includes(f.type) ? { w: f.weight } : {}), s: f.show_if?.field ? f.show_if : null, ...(ast ? { ast } : {}) });
  }
  const v: ClientSpec['v'] = [];
  for (const x of settings?.variables ?? []) {
    try {
      v.push({ n: varName(x.name), ast: parseFormula(x.formula) });
    } catch {
      v.push({ n: varName(x.name), ast: { t: 'n', v: 0 } });
    }
  }
  return { S, f: list, v };
}

// --- the same rules in the browser ---------------------------------------------------------------------------------------------------------

/**
 * What the page script needs of the spec: defaults left out (`s: null`, `j: []`, `h: false`), the formulas only when the form has a calculator
 * (variables are worked out after the calculators and never read in the browser).
 */
export function leanSpec(spec: ClientSpec, formulas: boolean): { S: Record<string, unknown>[][]; f?: ClientSpec['f'] } {
  const S = spec.S.map((sc) =>
    sc.map((e) => ({
      ...(e.s ? { i: e.i, s: e.s } : {}),
      ...(e.j.length ? { n: e.n, j: e.j } : {}),
      ...(e.h ? { h: 1 } : {}),
    })),
  );
  return formulas ? { S, f: spec.f } : { S };
}

/**
 * `matchRule`, `nextShown`, `evalAst` and `computeValues` as plain ES5 (server/assets/forms/logic-rules.js and logic-formula.js, the
 * same files the public form runs in the browser). tests/form-logic.test.ts runs them against the functions above on many inputs, so the
 * two cannot drift apart unnoticed.
 */
export const CLIENT_LOGIC = `${readAsset('logic-rules.js')}\n${readAsset('logic-formula.js')}`;
