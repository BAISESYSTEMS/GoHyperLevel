import type { App } from '../core/app.js';
import { lookup, render } from '../core/template.js';
import type { ActionOutcome, ActionResult, FlowCtx, RunState } from './workflow-engine.js';

/**
 * Building blocks for workflow steps that live in their own modules (services/wfx-*.ts): the description of a step
 * for the editor (label, category, docs, form fields), the signature of a handler, and small helpers for reading
 * templated values and writing results into variables or contact fields.
 */

/** One input of a step's form. The editor builds a generic form from these (steps with their own editor need none). */
export interface FieldDef {
  key: string;
  label: string;
  type:
    | 'text'
    | 'textarea'
    | 'number'
    | 'select'
    | 'bool'
    | 'tags'
    | 'code'
    | 'time'
    | 'date'
    | 'weekdays'
    | 'conditions'
    | 'rows'
    | 'step'
    | 'target'
    | 'contact_field'
    | 'workflow'
    | 'pipeline'
    | 'stage'
    | 'calendar'
    | 'form'
    | 'user'
    | 'users'
    | 'group'
    | 'social_channels'
    | 'tz'
    | 'contract_template'
    | 'product'
    | 'webinar';
  options?: [string, string][];
  placeholder?: string;
  help?: string;
  required?: boolean;
  default?: unknown;
  /** Show only while another field has one of these values. */
  showIf?: { field: string; in: string[] };
  /** For `rows`: the columns of one row. */
  rows?: FieldDef[];
  /** For `rows`: label of the "add" button. */
  addLabel?: string;
}

export type ActionHandler = (run: RunState, step: any, vars: Record<string, any>, fc: FlowCtx) => Promise<ActionResult> | ActionResult;

export interface ActionMeta {
  type: string;
  label: string;
  /** Key of CATEGORIES. */
  category: string;
  /** Icon name of the web app (web/src/icons.tsx). */
  icon?: string;
  /** One line for the picker. */
  summary: string;
  /** Longer help (a few lines, German), shown in the picker and under the step's form. */
  doc: string;
  fields: FieldDef[];
  /** Variables/fields the step sets, e.g. ['var.total']; shown as chips so people know what to use later. */
  provides?: string[];
  /** Needs nothing but the data of the run: allowed in test runs (no sending, no writes, no outside calls). */
  pure?: boolean;
  /** Has its own editor in the web app (older steps); the generic form is skipped. */
  custom?: boolean;
  /** Search words besides label and summary. */
  keywords?: string;
  /** What has to be set up first, e.g. "Slack-Token unter Apps → Direkt-Verbindungen". */
  needs?: string;
  /** Another app/connector provides it (shown as a badge). */
  app?: string;
  /** Sample settings for "Beispiel einfügen" and the docs. */
  sample?: Record<string, unknown>;
  /** Branch keys the step owns (container steps). */
  container?: boolean;
}

export interface ActionDef {
  meta: ActionMeta;
  run: ActionHandler;
}

export interface TriggerMeta {
  type: string;
  label: string;
  category: string;
  summary: string;
  doc: string;
  fields: FieldDef[];
  /** Typical event data (`{{event.…}}`): the test run starts with it and the filter editor suggests its fields. */
  sample: Record<string, unknown>;
  /** Needs no contact (starts for contacts it finds). */
  keywords?: string;
}

export const CATEGORIES: [string, string][] = [
  ['flow', 'Ablauf & Logik'],
  ['data', 'Daten & Formatierung'],
  ['crm', 'Kontakte & CRM'],
  ['sales', 'Vertrieb & Termine'],
  ['messaging', 'Nachrichten & Benachrichtigungen'],
  ['payments', 'Zahlung & Verträge'],
  ['content', 'Inhalte, Kurse & Community'],
  ['ai', 'KI'],
  ['integration', 'Webhooks & APIs'],
  ['apps', 'Apps (direkt)'],
  ['apps_composio', 'Apps (Composio, Nango, MCP)'],
];

export const TRIGGER_CATEGORIES: [string, string][] = [
  ['contact', 'Kontakt'],
  ['messages', 'Nachrichten & Anrufe'],
  ['sales', 'Termine & Vertrieb'],
  ['payments', 'Zahlung'],
  ['marketing', 'Formulare, Seiten & Links'],
  ['time', 'Zeit & Datum'],
  ['content', 'Kurse, Community & Bewertungen'],
  ['service', 'Service & Tickets'],
  ['system', 'System & Integrationen'],
];

// --- reading values -----------------------------------------------------------------------------

const WHOLE = /^\s*\{\{\s*([\w.]+)\s*(?:\|[^}]*)?\}\}\s*$/;

/** Text with merge fields filled in. */
export const text = (v: unknown, vars: Record<string, any>): string => render(String(v ?? ''), vars);

/**
 * A templated value that keeps its type: `{{var.items}}` alone gives the list/object/number itself, anything else
 * is rendered to text (and read as JSON when it looks like JSON and `json` is set).
 */
export function resolve(v: unknown, vars: Record<string, any>, opts: { json?: boolean } = {}): unknown {
  if (typeof v !== 'string') return v;
  const m = WHOLE.exec(v);
  if (m) {
    const raw = lookup(vars, m[1]);
    if (raw !== undefined && raw !== null && raw !== '') return raw;
  }
  const s = render(v, vars);
  if (opts.json && /^\s*[[{]/.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      /* plain text */
    }
  }
  return s;
}

export const toText = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** `custom.x`, `var.x` or `event.x` as an address into the run's data; contact fields work without a prefix. */
export function readPath(vars: Record<string, any>, path: string): unknown {
  const p = String(path ?? '').trim();
  if (!p) return undefined;
  return lookup(vars, /^(contact|event|var|location|appointment|opportunity|message|answers)\./.test(p) ? p : `contact.${p}`);
}

// --- writing results ----------------------------------------------------------------------------

/**
 * Puts a result where the step's "Ergebnis speichern in" says: `var.name` (run variable, default `var.result`), or a contact
 * field (`first_name`, `custom.budget`). Contact fields are written by the engine – not in test runs.
 */
export function assign(out: ActionOutcome, target: unknown, value: unknown, fallback = 'var.result'): ActionOutcome {
  const t = String(target ?? '').trim() || fallback;
  if (t.startsWith('var.')) {
    const name = t.slice(4);
    if (!/^[A-Za-z_][\w]{0,59}$/.test(name) || name.startsWith('_')) throw new Error(`Ungültiger Variablenname „${name}“ (Buchstaben, Ziffern, _)`);
    out.vars = { ...(out.vars ?? {}), [name]: value };
  } else {
    out.fields = { ...(out.fields ?? {}), [t]: value };
  }
  return out;
}

export const describeTarget = (target: unknown, fallback = 'var.result') => {
  const t = String(target ?? '').trim() || fallback;
  return t.startsWith('var.') ? `Variable ${t.slice(4)}` : `Feld ${t}`;
};

/** Short, readable preview of a value for the one-line result of a step. */
export function preview(v: unknown, max = 80): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Rows of a `rows` field: drops empty ones and keeps at most `max`. */
export function rowsOf<T extends Record<string, any>>(v: unknown, keys: string[], max = 50): T[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r) => r && typeof r === 'object' && keys.some((k) => String(r[k] ?? '').trim() !== ''))
    .slice(0, max) as T[];
}

export function requireText(v: unknown, label: string): string {
  const s = String(v ?? '').trim();
  if (!s) throw new Error(`${label} fehlt`);
  return s;
}

/** The sub-account's time zone. */
export const tzOf = (app: App, locationId: string) => app.location(locationId)?.timezone || 'Europe/Berlin';

/** `def`s of one module as the registry shapes the engine and the editor use. */
export function registerActions(app: App, defs: ActionDef[]) {
  app.services.workflowActions = { ...(app.services.workflowActions ?? {}), ...Object.fromEntries(defs.map((d) => [d.meta.type, d.run])) };
  app.services.workflowActionMeta = { ...(app.services.workflowActionMeta ?? {}), ...Object.fromEntries(defs.map((d) => [d.meta.type, d.meta])) };
}

/** Only the descriptions, for steps whose handlers are registered elsewhere (registerConnector wires the handlers of native apps). */
export function registerActionMeta(app: App, metas: ActionMeta[]) {
  app.services.workflowActionMeta = { ...(app.services.workflowActionMeta ?? {}), ...Object.fromEntries(metas.map((m) => [m.type, m])) };
}

export function registerTriggers(app: App, defs: TriggerMeta[]) {
  const have = new Set<string>(app.services.workflowTriggers ?? []);
  app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), ...defs.map((d) => d.type).filter((t) => !have.has(t))];
  app.services.workflowTriggerMeta = { ...(app.services.workflowTriggerMeta ?? {}), ...Object.fromEntries(defs.map((d) => [d.type, d])) };
}
