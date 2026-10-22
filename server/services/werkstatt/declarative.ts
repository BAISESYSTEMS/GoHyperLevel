import { lookup, render } from '../../core/template.js';
import { OPS } from './ops.js';
import type { Manifest } from './manifest.js';

/**
 * Declarative server logic: a plugin's jobs and workflow actions as a list of steps – calls of the same
 * operations a script may use, with `{{merge fields}}`, loops and conditions. No code runs, so there is
 * nothing to escape from: this is also the fallback when the permission-restricted child process is not
 * available on a server (see docs/werkstatt.md → "Why two kinds of server logic").
 *
 *   { "actions": { "<id>": [step…] }, "jobs": { "<id>": [step…] } }
 *   step = { op, args?, as? }                      call an operation, keep the result as `as`
 *        | { foreach: "path", as: "item", do: [step…], limit? }
 *        | { if: { path, op: eq|ne|gt|lt|contains|endswith|empty|notempty, value? }, then: [step…], else?: [step…] }
 *        | { set: "name", value }                  a variable
 *        | { result: any }                         what the run returns
 * Variables: `input` (workflow action input), `contact` (the workflow's contact), `today`, `today_md` (MM-DD), `now`.
 */

export const STEP_LIMITS = { steps: 50, depth: 3, iterations: 200, calls: 200 };
type Step = Record<string, any>;
export interface StepsSpec {
  actions?: Record<string, Step[]>;
  jobs?: Record<string, Step[]>;
}

const COMPARE = ['eq', 'ne', 'gt', 'lt', 'contains', 'endswith', 'empty', 'notempty'];

export function validateSteps(spec: unknown, manifest: Manifest): { errors: string[] } {
  const errors: string[] = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { errors: ['steps: erwartet { actions: {…}, jobs: {…} }.'] };
  const s = spec as StepsSpec;
  const want = [...(manifest.entries.actions ?? []).map((a) => ['actions', a.id] as const), ...(manifest.entries.jobs ?? []).map((j) => ['jobs', j.id] as const)];
  for (const [kind, id] of want) if (!Array.isArray(s[kind]?.[id])) errors.push(`steps.${kind}.${id}: Schritte fehlen (Liste erwartet).`);
  for (const kind of ['actions', 'jobs'] as const) for (const id of Object.keys(s[kind] ?? {})) if (!want.some(([k, i]) => k === kind && i === id)) errors.push(`steps.${kind}.${id}: steht nicht im Manifest.`);
  let count = 0;
  const walk = (steps: unknown, where: string, depth: number) => {
    if (!Array.isArray(steps)) return void errors.push(`${where}: Liste von Schritten erwartet.`);
    if (depth > STEP_LIMITS.depth) return void errors.push(`${where}: zu tief verschachtelt (höchstens ${STEP_LIMITS.depth} Ebenen).`);
    steps.forEach((st: Step, i) => {
      const at = `${where}[${i}]`;
      if (++count > STEP_LIMITS.steps) return;
      if (!st || typeof st !== 'object' || Array.isArray(st)) return void errors.push(`${at}: kein Schritt-Objekt.`);
      if (st.op !== undefined) {
        const def = OPS[String(st.op)];
        if (!def) errors.push(`${at}: unbekannte Funktion „${st.op}“.`);
        else if (def.scope && !manifest.scopes.includes(def.scope)) errors.push(`${at}: ${st.op} braucht die Berechtigung „${def.scope}“ im Manifest.`);
        if (st.as !== undefined && !/^[a-z][a-z0-9_]{0,29}$/i.test(String(st.as))) errors.push(`${at}: „as“ ist kein gültiger Name.`);
      } else if (st.foreach !== undefined) {
        if (typeof st.foreach !== 'string') errors.push(`${at}: foreach erwartet einen Pfad wie "res.contacts".`);
        if (!/^[a-z][a-z0-9_]{0,29}$/i.test(String(st.as ?? ''))) errors.push(`${at}: „as“ (Name der Schleifenvariable) fehlt.`);
        walk(st.do, `${at}.do`, depth + 1);
      } else if (st.if !== undefined) {
        if (!st.if || typeof st.if.path !== 'string' || !COMPARE.includes(String(st.if.op))) errors.push(`${at}: if braucht { path, op (${COMPARE.join('|')}), value }.`);
        walk(st.then ?? [], `${at}.then`, depth + 1);
        if (st.else !== undefined) walk(st.else, `${at}.else`, depth + 1);
      } else if (st.set !== undefined) {
        if (!/^[a-z][a-z0-9_]{0,29}$/i.test(String(st.set))) errors.push(`${at}: set braucht einen Namen.`);
      } else if (st.result === undefined) errors.push(`${at}: unbekannter Schritt (op, foreach, if, set oder result).`);
    });
  };
  for (const [kind, id] of want) if (Array.isArray(s[kind]?.[id])) walk(s[kind]![id], `steps.${kind}.${id}`, 1);
  if (count > STEP_LIMITS.steps) errors.push(`Zu viele Schritte (höchstens ${STEP_LIMITS.steps}).`);
  return { errors };
}

/** A value with merge fields: a lone `{{path}}` keeps the original type (number, list …), anything else becomes text. */
function resolve(v: unknown, vars: Record<string, unknown>): unknown {
  if (typeof v === 'string') {
    const only = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(v);
    return only ? lookup(vars, only[1]) : render(v, vars);
  }
  if (Array.isArray(v)) return v.map((x) => resolve(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, vars)]));
  return v;
}

function holds(cond: Step, vars: Record<string, unknown>): boolean {
  const a = lookup(vars, String(cond.path));
  const b = resolve(cond.value, vars);
  const s = (x: unknown) => (x === undefined || x === null ? '' : String(x));
  switch (cond.op) {
    case 'eq': return s(a) === s(b);
    case 'ne': return s(a) !== s(b);
    case 'gt': return Number(a) > Number(b);
    case 'lt': return Number(a) < Number(b);
    case 'contains': return Array.isArray(a) ? a.map(s).includes(s(b)) : s(a).toLowerCase().includes(s(b).toLowerCase());
    case 'endswith': return s(a).endsWith(s(b));
    case 'empty': return Array.isArray(a) ? a.length === 0 : s(a) === '';
    case 'notempty': return Array.isArray(a) ? a.length > 0 : s(a) !== '';
    default: return false;
  }
}

export interface RunOutcome {
  result: unknown;
  log: string[];
}

/** Runs one action or job. `call` is the bridge (scopes and user rights are checked there). */
export async function runSteps(spec: StepsSpec, kind: 'actions' | 'jobs', id: string, vars: Record<string, unknown>, call: (op: string, args: Record<string, unknown>) => Promise<unknown>): Promise<RunOutcome> {
  const steps = spec[kind]?.[id];
  if (!Array.isArray(steps)) throw new Error(`Keine Schritte für „${id}“.`);
  const log: string[] = [];
  const scope: Record<string, unknown> = { ...vars };
  let result: unknown = null;
  let calls = 0;
  const exec = async (list: Step[]): Promise<void> => {
    for (const st of list) {
      if (st.op !== undefined) {
        if (++calls > STEP_LIMITS.calls) throw new Error(`Zu viele Aufrufe (höchstens ${STEP_LIMITS.calls}).`);
        const out = await call(String(st.op), (resolve(st.args ?? {}, scope) ?? {}) as Record<string, unknown>);
        if (st.as) scope[String(st.as)] = out;
        log.push(`${st.op} ✓`);
      } else if (st.foreach !== undefined) {
        const items = lookup(scope, String(st.foreach));
        const arr = (Array.isArray(items) ? items : []).slice(0, Math.min(STEP_LIMITS.iterations, Number(st.limit) || STEP_LIMITS.iterations));
        for (const item of arr) {
          scope[String(st.as)] = item;
          await exec(st.do);
        }
      } else if (st.if !== undefined) await exec(holds(st.if, scope) ? (st.then ?? []) : (st.else ?? []));
      else if (st.set !== undefined) scope[String(st.set)] = resolve(st.value, scope);
      else if (st.result !== undefined) result = resolve(st.result, scope);
    }
  };
  await exec(steps);
  return { result, log };
}
