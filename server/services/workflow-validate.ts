/**
 * Checks the steps of a workflow for settings that are missing, before it runs (docs/workflow-actions.md → Validation).
 * Pure and import-free: the server (modules/workflow-validate.ts – answers of GET/PATCH /api/workflows/:id and
 * POST /api/workflows/:id/validate) and the web editor (list and canvas) use the same rules.
 *
 * Rules: the fields a step's catalogue entry marks `required` (only while they are shown – `showIf`), a few rules for the older
 * steps that have editors of their own (e-mail without subject and text, a webhook without URL …), and jump targets that no
 * longer exist. Paused steps (`disabled: true`) and everything inside a paused container are not checked – they do not run.
 */

export interface RuleField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  default?: unknown;
  showIf?: { field: string; in: string[] };
}
export interface RuleMeta {
  type: string;
  fields?: RuleField[];
  custom?: boolean;
}
export interface StepLike {
  id: string;
  type: string;
  [k: string]: any;
}
export interface Issue {
  step: string;
  code: IssueCode;
  field?: string;
  params?: Record<string, string>;
}
export type IssueCode =
  | 'required'
  | 'email_empty'
  | 'text_missing'
  | 'tags_empty'
  | 'field_missing'
  | 'wait_amount'
  | 'wait_date'
  | 'conditions_empty'
  | 'condition_incomplete'
  | 'pipeline_missing'
  | 'status_missing'
  | 'title_missing'
  | 'url_invalid'
  | 'workflow_missing'
  | 'channels_missing'
  | 'split_paths'
  | 'target_missing';

/** German texts of the issues ({field} = the field's label). The web editor has the same list in web/src/workflow-canvas/issues.ts. */
export const ISSUE_TEXT: Record<IssueCode, string> = {
  required: 'Pflichtfeld fehlt: {field}',
  email_empty: 'Betreff und Text fehlen',
  text_missing: 'Text fehlt',
  tags_empty: 'Mindestens einen Tag angeben',
  field_missing: 'Feld wählen',
  wait_amount: 'Dauer fehlt',
  wait_date: 'Datum fehlt',
  conditions_empty: 'Bedingung fehlt',
  condition_incomplete: 'Bedingung unvollständig (Feld oder Wert fehlt)',
  pipeline_missing: 'Pipeline wählen',
  status_missing: 'Status wählen',
  title_missing: 'Titel fehlt',
  url_invalid: 'URL fehlt oder beginnt nicht mit http(s)://',
  workflow_missing: 'Workflow wählen',
  channels_missing: 'Mindestens einen Kanal wählen',
  split_paths: 'Mindestens zwei Pfade anlegen',
  target_missing: 'Sprungziel gibt es nicht (mehr) – Schritt neu wählen',
};

export const issueText = (i: Issue): string => ISSUE_TEXT[i.code].replace(/\{(\w+)\}/g, (_, k) => i.params?.[k] ?? '');

const BRANCH = /^(then|else|each|b\d)$/;
const lanesOf = (s: StepLike): StepLike[][] => Object.keys(s).filter((k) => BRANCH.test(k) && Array.isArray(s[k])).map((k) => s[k] as StepLike[]);
const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
const NO_VALUE_OPS = new Set(['empty', 'not_empty']);

function conditionIssues(s: StepLike, conds: unknown, add: (code: IssueCode, field?: string) => void, key = 'conditions') {
  if (typeof s.expression === 'string' && s.expression.trim()) return;
  const list = Array.isArray(conds) ? (conds as any[]) : [];
  if (!list.length) return add('conditions_empty', key);
  if (list.some((c) => blank(c?.field) || (!NO_VALUE_OPS.has(String(c?.op ?? '')) && blank(c?.value)))) add('condition_incomplete', key);
}

/** The older steps with editors of their own (their catalogue entries carry no fields). */
const BUILTIN: Record<string, (s: StepLike, add: (code: IssueCode, field?: string) => void) => void> = {
  send_email: (s, add) => blank(s.subject) && blank(s.body) && !s.design && add('email_empty', 'subject'),
  send_sms: (s, add) => blank(s.body) && add('text_missing', 'body'),
  add_note: (s, add) => blank(s.body) && add('text_missing', 'body'),
  notify: (s, add) => blank(s.subject) && blank(s.body) && add('text_missing', 'body'),
  add_tag: (s, add) => !(Array.isArray(s.tags) && s.tags.some((x: unknown) => !blank(x))) && add('tags_empty', 'tags'),
  remove_tag: (s, add) => !(Array.isArray(s.tags) && s.tags.some((x: unknown) => !blank(x))) && add('tags_empty', 'tags'),
  update_field: (s, add) => blank(s.field) && add('field_missing', 'field'),
  wait: (s, add) => {
    const mode = s.mode ?? 'delay';
    if (mode === 'delay' && !(Number(s.amount) > 0)) add('wait_amount', 'amount');
    if (mode === 'date' && blank(s.date)) add('wait_date', 'date');
  },
  if: (s, add) => conditionIssues(s, s.conditions, add),
  goal: (s, add) => conditionIssues(s, s.conditions, add),
  create_opportunity: (s, add) => blank(s.pipeline_id) && add('pipeline_missing', 'pipeline_id'),
  move_opportunity: (s, add) => blank(s.pipeline_id) && add('pipeline_missing', 'pipeline_id'),
  set_opportunity_status: (s, add) => blank(s.status) && add('status_missing', 'status'),
  create_task: (s, add) => blank(s.title) && add('title_missing', 'title'),
  webhook: (s, add) => !/^https?:\/\/\S+/.test(String(s.url ?? '').trim()) && add('url_invalid', 'url'),
  add_to_workflow: (s, add) => blank(s.workflow_id) && add('workflow_missing', 'workflow_id'),
  remove_from_workflow: (s, add) => blank(s.workflow_id) && add('workflow_missing', 'workflow_id'),
  social_post: (s, add) => {
    if (blank(s.integration_ids)) add('channels_missing', 'integration_ids');
    if (blank(s.body)) add('text_missing', 'body');
  },
  split_test: (s, add) => !(Array.isArray(s.variants) && s.variants.length >= 2) && add('split_paths', 'variants'),
};

function shown(f: RuleField, s: StepLike, all: RuleField[]): boolean {
  if (!f.showIf) return true;
  const dep = all.find((x) => x.key === f.showIf!.field);
  return f.showIf.in.includes(String(s[f.showIf.field] ?? dep?.default ?? ''));
}

function fieldEmpty(f: RuleField, v: unknown): boolean {
  switch (f.type) {
    case 'bool':
      return false;
    case 'number':
      return v === undefined || v === null || v === '' || Number.isNaN(Number(v));
    case 'rows':
    case 'tags':
    case 'users':
    case 'social_channels':
    case 'weekdays':
      return !Array.isArray(v) || !v.length;
    default:
      return blank(typeof v === 'number' ? String(v) : v);
  }
}

/**
 * Every issue of a step tree. `metaOf` answers the catalogue entry of a type (fields with `required`, `showIf`, `default`);
 * `ids` are all step ids a jump may point at (defaults to the ids of `steps`).
 */
export function validateSteps(steps: StepLike[], metaOf: (type: string) => RuleMeta | undefined, ids?: Set<string>): Issue[] {
  const all = new Set<string>(ids ?? []);
  if (!ids) {
    const collect = (list: StepLike[]) => list.forEach((s) => (all.add(String(s?.id)), lanesOf(s).forEach(collect)));
    collect(Array.isArray(steps) ? steps : []);
  }
  const out: Issue[] = [];
  const visit = (list: StepLike[]) => {
    for (const s of Array.isArray(list) ? list : []) {
      if (!s || typeof s !== 'object' || s.disabled === true) continue;
      const add = (code: IssueCode, field?: string, params?: Record<string, string>) => void out.push({ step: String(s.id), code, ...(field ? { field } : {}), ...(params ? { params } : {}) });
      BUILTIN[s.type]?.(s, add);
      const meta = metaOf(s.type);
      const fields = meta && !meta.custom ? meta.fields ?? [] : [];
      for (const f of fields) {
        if (!shown(f, s, fields)) continue;
        const v = s[f.key] === undefined ? f.default : s[f.key];
        if (f.type === 'step' && !blank(v) && !all.has(String(v))) add('target_missing', f.key);
        else if (f.type === 'conditions' && f.required) conditionIssues(s, v, add, f.key);
        else if (f.required && fieldEmpty(f, v)) add('required', f.key, { field: f.label });
      }
      lanesOf(s).forEach(visit);
    }
  };
  visit(steps);
  return out;
}

/** Issues grouped by step id (what the editors put on the nodes). */
export function issuesByStep(issues: Issue[]): Record<string, Issue[]> {
  const out: Record<string, Issue[]> = {};
  for (const i of issues) (out[i.step] ??= []).push(i);
  return out;
}
