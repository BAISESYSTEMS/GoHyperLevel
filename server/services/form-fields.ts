import { bad, str } from '../core/http.js';
import { RULE_OPS, buildScreens, formulaVars, parseFormula, FormulaError, resolveTarget, varName, type Ending, type FormMode } from './form-logic.js';

/**
 * The fields of a form: types, what the editor may send (cleaned), what a visitor's answer must look like per type. Pure – the
 * products a payment field points at are checked through a callback.
 */

export const FIELD_TYPES = [
  'text', 'email', 'phone', 'textarea', 'select', 'radio', 'checkbox', 'date', 'number', 'hidden', 'consent', 'file', 'page_break', 'heading',
  'rating', 'nps', 'scale', 'signature', 'date_range', 'ranking', 'picture_choice', 'payment', 'calculator',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface Rule {
  op: (typeof RULE_OPS)[number];
  value?: string;
}
export interface ShowIf extends Rule {
  /** Name of the field whose answer decides. */
  field: string;
}
export interface Jump extends Rule {
  /** A field id, `page:N` or `end`. */
  goto: string;
}

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  /** Where the answer goes: a contact field (email, first_name…), custom.<key>, or just the submission. */
  name: string;
  required?: boolean;
  options?: string[];
  placeholder?: string;
  value?: string;
  /** Only shown (and only required) when another field's answer matches. */
  show_if?: ShowIf | null;
  /** Logic jumps: the first rule that matches sends the visitor to its target instead of the next question (forward only). */
  jumps?: Jump[];
  /** Rating: number of stars; scale: lowest/highest value, step and look. */
  min?: number;
  max?: number;
  step?: number;
  style?: 'buttons' | 'slider';
  /** Texts at both ends of a scale or NPS. */
  labels?: [string, string];
  /** Picture choice: one image address per option; several answers allowed. */
  images?: string[];
  multiple?: boolean;
  /** Scoring: points per option of a choice (label → points); weight of a numeric answer in the score. */
  points?: Record<string, number>;
  weight?: number;
  /** Payment field: the product (Umsatz → Produkte) that is paid for. */
  product_id?: string;
  /** Calculator field: formula over the other fields and variables, and how the result is shown. */
  formula?: string;
  format?: 'number' | 'currency' | 'percent';
  /** Short text under the question. */
  hint?: string;
}

export interface Variable {
  name: string;
  formula: string;
}

export interface FormSettings {
  mode?: FormMode;
  show_progress?: boolean;
  auto_advance?: boolean;
  welcome?: { title: string; text: string; button: string } | null;
  theme?: Record<string, unknown>;
  variables?: Variable[];
  endings?: Ending[];
  show_result?: boolean;
  captcha?: { enabled: boolean };
  [k: string]: any;
}

export const SHOW_OPS = [...RULE_OPS];
const MAX_FIELDS = 100;
export const isChoice = (t: string) => ['select', 'radio', 'checkbox', 'picture_choice', 'ranking'].includes(t);
const cleanUrl = (v: unknown) => {
  const s = String(v ?? '').trim();
  return /^(https:\/\/|\/)[^\s"'<>()\\]{1,500}$/i.test(s) ? s : '';
};
const intIn = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

export interface CleanContext {
  /** Is this a product of the sub-account? (payment fields) */
  productOk?: (id: string) => boolean;
  mode?: FormMode;
}

export function cleanRule(r: any, what: string): Rule | null {
  if (!r || !RULE_OPS.includes(r.op)) return null;
  return { op: r.op, value: str(r.value, what, { max: 200 }) };
}

/** The editor's field list → fields the platform understands. Throws a German message for the first thing that cannot work. */
export function cleanFields(input: unknown, ctx: CleanContext = {}): FormField[] {
  if (!Array.isArray(input)) throw bad('Felder fehlen');
  const fields: FormField[] = input.slice(0, MAX_FIELDS).map((f: any, i) => {
    const type: FieldType = (FIELD_TYPES as readonly string[]).includes(f?.type) ? f.type : 'text';
    const out: FormField = {
      id: String(f?.id || `f${i + 1}`).replace(/[^\w-]/g, '_').slice(0, 40),
      type,
      label: str(f?.label, 'Feldname', { max: 500 }),
      name: String(f?.name || `field_${i + 1}`).replace(/[^\w.]/g, '_').slice(0, 60),
      required: !!f?.required,
      options: Array.isArray(f?.options) ? f.options.map((o: unknown) => String(o).trim().slice(0, 200)).filter(Boolean).slice(0, 100) : [],
      placeholder: str(f?.placeholder, 'Platzhalter', { max: 200 }),
      value: str(f?.value, 'Wert', { max: 500 }),
      show_if: f?.show_if?.field && RULE_OPS.includes(f.show_if.op) ? { field: String(f.show_if.field).slice(0, 60), op: f.show_if.op, value: str(f.show_if.value, 'Bedingung', { max: 200 }) } : null,
    };
    const hint = str(f?.hint, 'Hinweis', { max: 300 });
    if (hint) out.hint = hint;
    const jumps = (Array.isArray(f?.jumps) ? f.jumps : []).slice(0, 20).flatMap((j: any) => {
      const rule = cleanRule(j, 'Sprung-Bedingung');
      const goto = String(j?.goto ?? '').slice(0, 60);
      return rule && goto ? [{ ...rule, goto }] : [];
    });
    if (jumps.length) out.jumps = jumps;
    if (type === 'rating') out.max = intIn(f?.max, 3, 10, 5);
    if (type === 'scale' || type === 'nps') {
      const lo = type === 'nps' ? 0 : intIn(f?.min, -100, 100, 1);
      const hi = type === 'nps' ? 10 : intIn(f?.max, lo + 1, Math.min(lo + 100, 1000), Math.max(lo + 1, 10));
      out.min = lo;
      out.max = hi;
      if (type === 'scale') {
        out.step = intIn(f?.step, 1, Math.max(1, hi - lo), 1);
        out.style = f?.style === 'slider' ? 'slider' : 'buttons';
      }
      const l = Array.isArray(f?.labels) ? f.labels : [];
      const labels: [string, string] = [str(l[0], 'Beschriftung', { max: 60 }), str(l[1], 'Beschriftung', { max: 60 })];
      if (labels[0] || labels[1]) out.labels = labels;
    }
    if (type === 'picture_choice') {
      out.images = (out.options ?? []).map((_o, k) => cleanUrl(f?.images?.[k]));
      out.multiple = !!f?.multiple;
    }
    if (type === 'checkbox' && out.options?.length) out.multiple = true;
    if (isChoice(type) && f?.points && typeof f.points === 'object') {
      const pts: Record<string, number> = {};
      for (const o of out.options ?? []) {
        const n = Number(f.points[o]);
        if (Number.isFinite(n) && n !== 0) pts[o] = Math.min(Math.max(n, -100000), 100000);
      }
      if (Object.keys(pts).length) out.points = pts;
    }
    if (['number', 'rating', 'nps', 'scale'].includes(type) && f?.weight !== undefined && f.weight !== '' && f.weight !== null) {
      const w = Number(f.weight);
      if (Number.isFinite(w) && w !== 0) out.weight = Math.min(Math.max(w, -1000), 1000);
    }
    if (type === 'payment') {
      out.product_id = str(f?.product_id, 'Produkt', { max: 60 });
      if (out.product_id && ctx.productOk && !ctx.productOk(out.product_id)) throw bad('Produkt nicht gefunden');
    }
    if (type === 'calculator') {
      out.formula = str(f?.formula, 'Formel', { max: 300 });
      out.format = ['number', 'currency', 'percent'].includes(f?.format) ? f.format : 'number';
    }
    if (type === 'number') {
      if (f?.min !== undefined && f.min !== '' && Number.isFinite(Number(f.min))) out.min = Number(f.min);
      if (f?.max !== undefined && f.max !== '' && Number.isFinite(Number(f.max))) out.max = Number(f.max);
    }
    return out;
  });
  checkLogic(fields, ctx.mode ?? 'classic');
  return fields;
}

/** Things that only show up across fields: unknown jump targets, backward jumps, formulas with typos, two payment fields. */
export function checkLogic(fields: FormField[], mode: FormMode): void {
  const ids = new Set<string>();
  for (const f of fields) {
    if (ids.has(f.id)) throw bad(`Zwei Felder haben dieselbe ID „${f.id}“`);
    ids.add(f.id);
  }
  if (fields.filter((f) => f.type === 'payment').length > 1) throw bad('Ein Formular kann nur ein Zahlungsfeld haben');
  const screens = buildScreens(fields, mode);
  const screenOf = (id: string) => screens.findIndex((s) => s.fields.some((f) => f.id === id));
  for (const f of fields) {
    for (const j of f.jumps ?? []) {
      const t = resolveTarget(j.goto, screens, fields);
      if (t === undefined) throw bad(`„${f.label || f.name}“: das Sprungziel gibt es nicht`);
      if (t <= screenOf(f.id)) throw bad(`„${f.label || f.name}“: ein Sprung kann nur vorwärts gehen`);
    }
  }
  const known = new Set<string>(['score']);
  for (const f of fields) {
    known.add(varName(f.id));
    known.add(varName(f.name));
  }
  for (const f of fields) {
    if (f.type !== 'calculator') continue;
    if (!f.formula) throw bad(`„${f.label || f.name}“: die Formel fehlt`);
    checkFormula(f.formula, known, f.label || f.name);
  }
}

export function checkFormula(formula: string, known: Set<string>, what: string) {
  try {
    for (const n of formulaVars(parseFormula(formula))) if (!known.has(n)) throw new FormulaError(`Die Variable „${n}“ gibt es nicht`);
  } catch (e) {
    if (e instanceof FormulaError) throw bad(`${what}: ${e.message}`);
    throw e;
  }
}

// --- settings -----------------------------------------------------------------------------------------------------------------------------

/** The new settings keys cleaned; every other key stays as the sender wrote it (older settings are free-form). */
export function cleanFormSettings(input: Record<string, any>, fields: FormField[]): Record<string, any> {
  const out: Record<string, any> = { ...input };
  if (input.mode !== undefined) out.mode = input.mode === 'typeform' ? 'typeform' : 'classic';
  for (const k of ['show_progress', 'auto_advance', 'show_result'] as const) if (input[k] !== undefined) out[k] = !!input[k];
  if (input.welcome !== undefined) {
    const w = input.welcome;
    out.welcome = w && (w.title || w.text) ? { title: str(w.title, 'Titel', { max: 160 }), text: str(w.text, 'Text', { max: 1000 }), button: str(w.button, 'Button', { max: 40 }) || 'Los geht’s' } : null;
  }
  const known = new Set<string>(['score']);
  for (const f of fields) {
    known.add(varName(f.id));
    known.add(varName(f.name));
  }
  if (input.variables !== undefined) {
    if (!Array.isArray(input.variables)) throw bad('Variablen: Liste erwartet');
    const seen = new Set<string>();
    out.variables = input.variables.slice(0, 20).map((v: any) => {
      const name = String(v?.name ?? '').trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(name)) throw bad('Variablen-Namen: Buchstaben, Ziffern und „_“, nicht mit einer Ziffer beginnen');
      if (seen.has(name)) throw bad(`Die Variable „${name}“ gibt es doppelt`);
      seen.add(name);
      checkFormula(String(v?.formula ?? ''), new Set([...known, ...seen]), `Variable „${name}“`);
      known.add(name);
      return { name, formula: String(v.formula).trim().slice(0, 300) };
    });
  }
  if (input.endings !== undefined) {
    if (!Array.isArray(input.endings)) throw bad('Ergebnisse: Liste erwartet');
    const names = new Set<string>([...known, ...((out.variables ?? input.variables ?? []) as Variable[]).map((v) => v.name)]);
    out.endings = input.endings.slice(0, 20).map((e: any): Ending => {
      const bound = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : (() => { throw bad('Ergebnisse: Grenzen müssen Zahlen sein'); })());
      const variable = String(e?.var || 'score').trim();
      if (!names.has(variable) && !names.has(varName(variable))) throw bad(`Ergebnisse: die Variable „${variable}“ gibt es nicht`);
      const min = bound(e?.min);
      const max = bound(e?.max);
      if (min !== null && max !== null && min > max) throw bad('Ergebnisse: „von“ ist größer als „bis“');
      const redirect = String(e?.redirect_url ?? '').trim();
      if (redirect && !/^https?:\/\/[^\s]+$/i.test(redirect)) throw bad('Ergebnisse: Weiterleitung muss mit https:// beginnen');
      return { var: variable, min, max, title: str(e?.title, 'Titel', { max: 160 }), text: str(e?.text, 'Text', { max: 2000 }), redirect_url: redirect, tag: str(e?.tag, 'Tag', { max: 80 }) };
    });
  }
  if (input.captcha !== undefined) out.captcha = { enabled: !!input.captcha?.enabled };
  return out;
}

// --- answers --------------------------------------------------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const deDate = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;

/**
 * One visitor answer per field type → what is stored (a string or a list), or throws a German message. Empty answers are not passed here.
 * Files, signatures, payments and calculators are handled by the caller.
 */
export function cleanAnswer(f: FormField, v: unknown): string | string[] {
  const label = f.label || f.name;
  const one = (x: unknown) => String(Array.isArray(x) ? x[0] : x).trim();
  switch (f.type) {
    case 'email': {
      const s = one(v).slice(0, 320);
      if (!EMAIL.test(s)) throw bad(`„${label}“: bitte eine gültige E-Mail-Adresse angeben`);
      return s;
    }
    case 'number': {
      const n = Number(one(v).replace(',', '.'));
      if (!Number.isFinite(n)) throw bad(`„${label}“: bitte eine Zahl angeben`);
      if (f.min !== undefined && n < f.min) throw bad(`„${label}“: mindestens ${f.min}`);
      if (f.max !== undefined && n > f.max) throw bad(`„${label}“: höchstens ${f.max}`);
      return String(n);
    }
    case 'rating':
    case 'nps':
    case 'scale': {
      const lo = f.type === 'rating' ? 1 : f.min ?? (f.type === 'nps' ? 0 : 1);
      const hi = f.type === 'rating' ? f.max ?? 5 : f.max ?? 10;
      const n = Number(one(v));
      if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`„${label}“: bitte einen Wert von ${lo} bis ${hi} wählen`);
      if (f.type === 'scale' && f.step && f.step > 1 && (n - lo) % f.step !== 0) throw bad(`„${label}“: ungültiger Wert`);
      return String(n);
    }
    case 'date': {
      const s = one(v);
      if (!validDate(s)) throw bad(`„${label}“: bitte ein Datum angeben`);
      return s;
    }
    case 'date_range': {
      const m = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(one(v));
      if (!m || !validDate(m[1]) || !validDate(m[2]) || m[1] > m[2]) throw bad(`„${label}“: bitte einen Zeitraum angeben (Von vor Bis)`);
      return `${deDate(m[1])} – ${deDate(m[2])}`;
    }
    case 'ranking': {
      const list = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim());
      const opts = f.options ?? [];
      if (list.length !== opts.length || new Set(list).size !== list.length || !list.every((x) => opts.includes(x))) throw bad(`„${label}“: bitte alle Punkte in eine Reihenfolge bringen`);
      return list;
    }
    case 'picture_choice':
    case 'radio':
    case 'select': {
      const list = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
      const multi = f.type === 'picture_choice' && f.multiple;
      if (f.type === 'picture_choice') {
        if (!list.length || (!multi && list.length > 1) || !list.every((x) => (f.options ?? []).includes(x))) throw bad(`„${label}“: bitte eine Auswahl treffen`);
        return multi ? list : list[0];
      }
      return list.length > 1 ? list.map((x) => x.slice(0, 1000)) : String(list[0] ?? '').slice(0, 10000);
    }
    default:
      return Array.isArray(v) ? v.map((x) => String(x).slice(0, 1000)) : String(v).slice(0, 10000);
  }
}
