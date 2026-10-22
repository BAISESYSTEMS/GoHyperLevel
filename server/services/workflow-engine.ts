import type { App } from '../core/app.js';
import type { AppEvent } from '../core/events.js';
import { parseJson, parseRows } from '../core/db.js';
import { lookup, render } from '../core/template.js';
import { addDaysYmd, weekdayKey, ymdInTz, zonedToUtc } from '../core/time.js';
import { evaluateCondition } from './expr.js';
import { parseDate, safeRegex } from './formatters.js';
import { safeFetch } from './net.js';
import { id, now } from '../core/util.js';
import { CONTACT_FIELDS, addTags, contactVars, getContact, logActivity, removeTags } from './contacts.js';
import { notifyTeam, sendToContact } from './messaging.js';
import { AUTO_LOST_REASON, createOpportunity, getPipeline, updateOpportunity } from './opportunities.js';
import { sendReviewRequest } from './reviews.js';
import { reportStepError } from './workflow-errors.js';

export interface Step {
  id: string;
  type: string;
  then?: Step[];
  else?: Step[];
  [k: string]: any;
}

/** A position in the step tree: step index, branch key, step index … (`[2, 'then', 0]`). */
export type Cursor = (number | string)[];

export interface Condition {
  field: string;
  op: 'has' | 'not_has' | 'equals' | 'not_equals' | 'contains' | 'empty' | 'not_empty' | 'gt' | 'lt' | 'gte' | 'lte' | 'starts_with' | 'ends_with' | 'in' | 'not_in' | 'between' | 'regex' | 'date_before' | 'date_after';
  value?: string;
}

export const TRIGGERS = [
  'contact.created',
  'contact.tag_added',
  'contact.tag_removed',
  'contact.updated',
  'contact.unsubscribed',
  'form.submitted',
  'appointment.booked',
  'appointment.status_changed',
  'opportunity.created',
  'opportunity.stage_changed',
  'opportunity.status_changed',
  'message.inbound',
  'invoice.paid',
  'product.purchased',
  'review.received',
  'email.opened',
  'email.clicked',
  'link.clicked',
  'date.reached',
  'contract.signed',
  'contract.declined',
  'ai.handoff',
  'course.enrolled',
  'course.started',
  'lesson.completed',
  'course.completed',
  'manual',
  'webhook',
] as const;

// --- cursor helpers (pure) ----------------------------------------------------

/**
 * The branches (nested step lists) a step owns: Wenn/Sonst has `then`/`else`, a split test one list per variant
 * (`b0`, `b1` …) and a loop its `each` list. Other modules may add container steps with `registerBranches`.
 */
const BRANCHES: Record<string, (s: Step) => string[]> = {
  if: () => ['then', 'else'],
  split_test: (s) => Array.from({ length: Math.min(Array.isArray(s.variants) ? s.variants.length : 0, 5) }, (_, i) => `b${i}`),
  loop: () => ['each'],
};
/** Container steps whose finished branch returns to the step itself (a loop runs its body again). */
const REENTRANT = new Set<string>(['loop']);

export function registerBranches(type: string, keys: (s: Step) => string[], opts: { reenter?: boolean } = {}) {
  BRANCHES[type] = keys;
  if (opts.reenter) REENTRANT.add(type);
}
export const branchKeys = (s: Step): string[] => BRANCHES[s.type]?.(s) ?? [];

function listAt(steps: Step[], prefix: Cursor): Step[] | undefined {
  let list: Step[] | undefined = steps;
  for (let i = 0; i < prefix.length; i += 2) {
    const step: Step | undefined = list?.[prefix[i] as number];
    const next: unknown = step?.[prefix[i + 1] as string];
    list = Array.isArray(next) ? (next as Step[]) : undefined;
  }
  return list;
}

export function stepAt(steps: Step[], cur: Cursor): Step | undefined {
  return listAt(steps, cur.slice(0, -1))?.[cur[cur.length - 1] as number];
}

/** The position after `cur`, climbing out of finished branches (a loop body returns to its loop); null at the end. */
export function advance(steps: Step[], cur: Cursor): Cursor | null {
  let c = [...cur];
  while (c.length) {
    (c[c.length - 1] as number)++;
    const list = listAt(steps, c.slice(0, -1));
    if (list && (c[c.length - 1] as number) < list.length) return c;
    c = c.slice(0, -2);
    if (c.length && REENTRANT.has(stepAt(steps, c)?.type ?? '')) return c;
  }
  return null;
}

/** Steps flattened with their cursor, for stats and validation. */
export function walk(steps: Step[], prefix: Cursor = []): { step: Step; cursor: Cursor }[] {
  const out: { step: Step; cursor: Cursor }[] = [];
  steps.forEach((s, i) => {
    out.push({ step: s, cursor: [...prefix, i] });
    for (const k of branchKeys(s)) out.push(...walk(s[k] ?? [], [...prefix, i, k]));
  });
  return out;
}

/** Where a step with this id sits in the tree. */
export function locate(steps: Step[], stepId: string): Cursor | null {
  return walk(steps).find((f) => f.step.id === stepId)?.cursor ?? null;
}

// --- conditions & triggers (pure) --------------------------------------------

export function evalCondition(cond: Condition, vars: Record<string, any>): boolean {
  const contact = vars.contact ?? {};
  if (cond.field === 'tag') {
    const has = (contact.tags ?? []).includes(cond.value);
    return cond.op === 'not_has' ? !has : has;
  }
  const raw = lookup(vars, cond.field.includes('.') ? cond.field : `contact.${cond.field}`);
  const v = raw === undefined || raw === null ? '' : String(raw).toLowerCase();
  const want = String(cond.value ?? '').toLowerCase();
  switch (cond.op) {
    case 'equals':
      return v === want;
    case 'not_equals':
      return v !== want;
    case 'contains':
      return v.includes(want);
    case 'empty':
      return v === '';
    case 'not_empty':
      return v !== '';
    case 'gt':
      return Number(raw) > Number(cond.value);
    case 'lt':
      return Number(raw) < Number(cond.value);
    case 'has':
      return v.includes(want);
    case 'not_has':
      return !v.includes(want);
    case 'gte':
      return raw !== undefined && raw !== null && raw !== '' && Number(raw) >= Number(cond.value);
    case 'lte':
      return raw !== undefined && raw !== null && raw !== '' && Number(raw) <= Number(cond.value);
    case 'starts_with':
      return v.startsWith(want);
    case 'ends_with':
      return v.endsWith(want);
    case 'in':
    case 'not_in': {
      const list = String(cond.value ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      const hit = Array.isArray(raw) ? raw.some((x) => list.includes(String(x).toLowerCase())) : list.includes(v);
      return cond.op === 'in' ? hit : !hit;
    }
    case 'between': {
      const [lo, hi] = String(cond.value ?? '').split(/\s*[,;]\s*|\s+[–-]\s+/).map(Number);
      const n = Number(raw);
      return raw !== undefined && raw !== null && raw !== '' && n >= Math.min(lo, hi) && n <= Math.max(lo, hi);
    }
    case 'regex':
      try {
        return safeRegex(String(cond.value ?? ''), 'i').test(String(raw ?? '').slice(0, 10_000));
      } catch {
        return false;
      }
    case 'date_before':
    case 'date_after': {
      const a = parseDate(raw);
      const b = parseDate(cond.value === 'now' || !cond.value ? 'now' : cond.value);
      if (!a || !b) return false;
      return cond.op === 'date_before' ? a < b : a > b;
    }
    default:
      return false;
  }
}

/**
 * Does a step's condition hold? Conditions are a list of field checks (all/any), or – when the step has an
 * `expression` – a line of the expression language (services/expr.ts) such as `contact.custom.budget > 1000 && 'vip' in contact.tags`.
 * An expression that fails to run counts as "no" (the error shows in the run log for steps that use `explainExpression`).
 */
export function evalConditions(step: Step, vars: Record<string, any>): boolean {
  const expr = typeof step.expression === 'string' ? step.expression.trim() : '';
  if (expr) {
    try {
      return evaluateCondition(expr, { contact: vars.contact ?? {}, event: vars.event ?? {}, var: vars.var ?? {}, location: { name: vars.location?.name, timezone: vars.location?.timezone } }, { tz: vars.location?.timezone });
    } catch {
      return false;
    }
  }
  const conds: Condition[] = step.conditions ?? [];
  if (!conds.length) return true;
  return step.match === 'any' ? conds.some((c) => evalCondition(c, vars)) : conds.every((c) => evalCondition(c, vars));
}

/** Extra filters every trigger accepts in its config: `filters` (field checks, `filters_match` all|any) and `filter_expression`. */
export function triggerFiltersPass(app: App, trigger: { type: string; config?: Record<string, any> }, e: AppEvent): boolean {
  const c = trigger.config ?? {};
  const filters = Array.isArray(c.filters) ? c.filters.filter((f: any) => f && f.field) : [];
  const expr = typeof c.filter_expression === 'string' ? c.filter_expression.trim() : '';
  if (!filters.length && !expr) return true;
  const contact = e.data.contactId ? getContact(app, e.locationId, e.data.contactId) : undefined;
  const vars = { contact: contactVars(contact), location: app.location(e.locationId), event: e.data, var: {} };
  return evalConditions({ id: 'filter', type: 'filter', conditions: filters, match: c.filters_match === 'any' ? 'any' : 'all', expression: expr }, vars);
}

/**
 * Does an event satisfy a workflow trigger's filters? Modules add filters for their own triggers
 * via `extra` (app.services.workflowTriggerFilters: { type: (config, data) => boolean }).
 */
export function triggerMatches(trigger: { type: string; config?: Record<string, any> }, e: AppEvent, extra?: Record<string, (config: Record<string, any>, data: Record<string, any>) => boolean>): boolean {
  if (trigger.type !== e.type) return false;
  const c = trigger.config ?? {};
  const d = e.data;
  switch (e.type) {
    case 'contact.tag_added':
    case 'contact.tag_removed':
      return !c.tag || c.tag === d.tag;
    case 'form.submitted':
      return !c.form_id || c.form_id === d.formId;
    case 'appointment.booked':
      return !c.calendar_id || c.calendar_id === d.calendarId;
    case 'appointment.status_changed':
      return (!c.calendar_id || c.calendar_id === d.calendarId) && (!c.status || c.status === d.status);
    case 'opportunity.created':
      return !c.pipeline_id || c.pipeline_id === d.pipelineId;
    case 'opportunity.stage_changed':
      return (!c.pipeline_id || c.pipeline_id === d.pipelineId) && (!c.stage_id || c.stage_id === d.stageId);
    case 'opportunity.status_changed':
      return (!c.pipeline_id || c.pipeline_id === d.pipelineId) && (!c.status || c.status === d.status);
    case 'message.inbound':
      return !c.channel || c.channel === d.message?.channel;
    case 'review.received':
    case 'google_review.received':
      return (!c.max_rating || Number(d.rating) <= Number(c.max_rating)) && (!c.min_rating || Number(d.rating) >= Number(c.min_rating));
    case 'call.completed':
      return !c.direction || c.direction === d.direction;
    case 'voice_ai.completed':
      return !c.outcome || c.outcome === d.outcome || (Array.isArray(d.outcomes) && d.outcomes.includes(c.outcome));
    case 'link.clicked':
      return !c.link_id || c.link_id === d.linkId;
    case 'product.purchased':
      return !c.product_id || c.product_id === d.productId;
    case 'email.clicked':
      return !c.url_contains || String(d.url ?? '').includes(c.url_contains);
    case 'course.enrolled':
    case 'course.started':
    case 'lesson.completed':
    case 'course.completed':
      return !c.course_id || c.course_id === d.courseId;
    case 'community.post_created':
    case 'community.member_joined':
      return !c.group_id || c.group_id === d.groupId;
    case 'community.level_reached':
      return (!c.group_id || c.group_id === d.groupId) && (!c.level || Number(c.level) === Number(d.level));
    case 'ticket.created':
    case 'ticket.status_changed':
    case 'ticket.assigned':
    case 'sla.warning':
    case 'sla.breached':
      return (
        (!c.pipeline_id || c.pipeline_id === d.ticket?.pipeline_id) &&
        (!c.priority || c.priority === d.ticket?.priority) &&
        (!c.category || c.category === d.ticket?.category) &&
        (!c.stage_id || c.stage_id === (d.stageId ?? d.ticket?.stage_id)) &&
        (!c.owner_id || c.owner_id === (d.ownerId ?? d.ticket?.owner_id)) &&
        (!c.sla_kind || c.sla_kind === d.slaKind)
      );
    case 'health_score.dropped':
      return !c.band || c.band === d.band;
    default:
      return extra?.[e.type] ? extra[e.type](c, d) : true;
  }
}

export function waitMs(step: Step): number {
  const n = Math.max(0, Number(step.amount) || 0);
  const unit = step.unit === 'days' ? 864e5 : step.unit === 'hours' ? 36e5 : 6e4;
  return n * unit;
}

/** Reads YYYY-MM-DD or DD.MM.YYYY (also ISO timestamps) into YYYY-MM-DD. */
export function parseDay(v: unknown): string | null {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/** The date's anniversary in the given year (29 Feb → 28 Feb in other years). */
export function inYear(ymd: string, year: number): string {
  const [, m, d] = ymd.split('-').map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return `${year}-${String(m).padStart(2, '0')}-${String(m === 2 && d === 29 && !leap ? 28 : d).padStart(2, '0')}`;
}

export function contactDate(contact: any, field: string): string | null {
  if (!contact || !field) return null;
  return parseDay(field.startsWith('custom.') ? contact.custom?.[field.slice(7)] : contact[field]);
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * When a "wait" step resumes, or null to go on right away. Modes: a delay (default), a fixed date,
 * a date from a contact field (e.g. 3 days before the birthday, optionally every year), or the next
 * allowed weekday at a time (e.g. Mon–Fri 09:00, for business hours).
 */
export function resumeAt(step: Step, vars: Record<string, any>, tz: string, from = new Date()): Date | null {
  const mode = step.mode ?? 'delay';
  if (mode === 'delay') {
    const ms = waitMs(step);
    return ms > 0 ? new Date(from.getTime() + ms) : null;
  }
  const time = HM.test(step.time ?? '') ? step.time : '09:00';
  let target: Date | null = null;
  if (mode === 'date') {
    const d = parseDay(step.date);
    if (d) target = zonedToUtc(d, time, tz);
  } else if (mode === 'field') {
    const d = contactDate(vars.contact, step.field);
    if (d) {
      const offset = Number(step.offset_days) || 0;
      if (step.yearly) {
        const year = Number(ymdInTz(from, tz).slice(0, 4));
        for (const y of [year - 1, year, year + 1]) {
          const t = zonedToUtc(addDaysYmd(inYear(d, y), offset), time, tz);
          if (t > from) return t;
        }
      } else target = zonedToUtc(addDaysYmd(d, offset), time, tz);
    }
  } else if (mode === 'weekday') {
    const days: string[] = Array.isArray(step.days) && step.days.length ? step.days : ['mon', 'tue', 'wed', 'thu', 'fri'];
    const today = ymdInTz(from, tz);
    for (let i = 0; i < 8; i++) {
      const ymd = addDaysYmd(today, i);
      if (!days.includes(weekdayKey(ymd))) continue;
      const t = zonedToUtc(ymd, time, tz);
      if (t > from) return t;
    }
  }
  return target && target > from ? target : null;
}

// --- runtime -----------------------------------------------------------------

const MAX_STEPS_PER_PASS = 250;
/** Steps one run may execute in total (a Go-to or a loop that never ends stops here). Overridable per workflow (`settings.max_steps`, up to 20 000). */
export const MAX_RUN_STEPS = 5000;

/** What a step may hand back instead of a plain text: structured output, variables and where to go on. */
export interface ActionOutcome {
  result: string;
  /** Shown as "Ausgabe" of the step in the run log. */
  output?: unknown;
  /** Run variables to set ({{var.name}}); `null` removes one. */
  vars?: Record<string, unknown>;
  /** Continue at the step with this id (Go-to). */
  goto?: string;
  /** Run the step list `key` of this step next (a loop's `each`, a split test's `b0` …); the step after it follows. */
  enter?: string;
  /** Stop here until this ISO time. With `stay` the same step runs again then (polling), otherwise the next one. */
  wait_until?: string;
  stay?: boolean;
  /** Finish the run (like „Ende“). */
  end?: boolean;
  /** Carry on with another contact (find contact). */
  contact_id?: string;
  /** Contact fields to set (`first_name`, `custom.budget` …). Written by the engine, never in test runs. */
  fields?: Record<string, unknown>;
}
export type ActionResult = string | ActionOutcome;

/** Handed to actions as the 4th argument: where the step is in the tree. */
export interface FlowCtx {
  steps: Step[];
  cursor: Cursor;
  dry: boolean;
  find(stepId: string): Cursor | null;
  /** The steps next to this one (same list) and its index. */
  siblings(): { list: Step[]; index: number };
}

export interface RunState {
  id: string;
  workflow_id: string;
  location_id: string;
  contact_id: string;
  event: Record<string, any>;
  vars: Record<string, any>;
  cursor: Cursor;
  log: any[];
  [k: string]: any;
}

export interface ExecOptions {
  /** Test run: nothing is sent or changed – steps without `pure: true` in the action catalog only show what they would do. */
  dry?: boolean;
  /** The contact for a test run with sample data (instead of the one in the database). */
  contact?: Record<string, any>;
  maxSteps?: number;
  now?: Date;
  /**
   * Called before the next step once an action has run: the run's progress (cursor, variables) is saved there, so a crash
   * repeats at most the step that was running – not every step since the run was picked up.
   */
  checkpoint?: (cursor: Cursor) => void;
}
export interface ExecResult {
  status: 'completed' | 'waiting' | 'active' | 'failed' | 'stopped';
  next_run_at: string | null;
}

function varsFor(app: App, run: RunState, contactOverride?: Record<string, any>) {
  const contact = contactOverride ?? getContact(app, run.location_id, run.contact_id);
  const event = run.event ?? {};
  return {
    contact: contactVars(contact as any),
    location: app.location(run.location_id),
    event,
    appointment: event.appointment,
    opportunity: event.opportunity,
    answers: event.answers,
    message: event.message,
    var: run.vars,
    run: { id: run.id },
  };
}

/**
 * Sets contact fields (standard fields, `custom.<key>`, `dnd`) for a run's contact and announces the change as
 * `contact.updated` (with `changed`, `viaWorkflow`), so "Feld geändert" triggers and webhooks see it. Returns the fields changed.
 */
export function applyContactFields(app: App, run: { location_id: string; contact_id: string; workflow_id?: string; event?: Record<string, any> }, fields: Record<string, unknown>): string[] {
  const loc = run.location_id;
  const c = getContact(app, loc, run.contact_id);
  if (!c) throw new Error('Kontakt nicht gefunden');
  const patch: Record<string, any> = {};
  let custom: Record<string, any> | undefined;
  const changed: string[] = [];
  const asText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  for (const [field, raw] of Object.entries(fields)) {
    if (field.startsWith('custom.') && field.length > 7) {
      const key = field.slice(7);
      if (!/^[\w.-]{1,80}$/.test(key) || /^(__proto__|constructor|prototype)$/.test(key)) throw new Error(`Ungültiges Feld ${field}`);
      custom ??= { ...c.custom };
      const v = asText(raw).slice(0, 10_000);
      if (asText(custom[key]) !== v) changed.push(field);
      if (raw === null || raw === undefined) delete custom[key];
      else custom[key] = v;
    } else if (field === 'dnd') {
      const v = raw === true || raw === 1 || /^(1|true|ja|an)$/i.test(asText(raw)) ? 1 : 0;
      if (Number(c.dnd) !== v) changed.push(field);
      patch.dnd = v;
    } else if ((CONTACT_FIELDS as readonly string[]).includes(field)) {
      const v = asText(raw).slice(0, 500);
      if (asText((c as any)[field]) !== v) changed.push(field);
      patch[field] = field === 'assigned_to' || field === 'date_of_birth' ? v || null : v;
    } else throw new Error(field ? `Unbekanntes Feld ${field}` : 'Kein Feld gewählt');
  }
  if (!changed.length) return [];
  app.db.update('contacts', c.id, { ...patch, ...(custom ? { custom } : {}), updated_at: now() });
  app.events.emit(loc, 'contact.updated', { contactId: c.id, contact: getContact(app, loc, c.id), changed, previous: c, viaWorkflow: run.workflow_id, wfDepth: Number(run.event?.wfDepth ?? 0) + 1 });
  return changed;
}

export function startWorkflow(app: App, wf: any, contactId: string, event: Record<string, any> = {}) {
  if (!getContact(app, wf.location_id, contactId)) return null;
  if (!wf.settings?.allow_reentry) {
    const prior = app.db.get('SELECT id FROM workflow_runs WHERE workflow_id = ? AND contact_id = ?', wf.id, contactId);
    if (prior) return null;
  } else {
    const active = app.db.get(`SELECT id FROM workflow_runs WHERE workflow_id = ? AND contact_id = ? AND status IN ('active','waiting')`, wf.id, contactId);
    if (active) return null;
  }
  const run = {
    id: id(),
    workflow_id: wf.id,
    location_id: wf.location_id,
    contact_id: contactId,
    status: 'active',
    cursor: [0],
    event,
    next_run_at: null,
    log: [],
    created_at: now(),
    updated_at: now(),
  };
  app.db.insert('workflow_runs', run);
  logActivity(app, wf.location_id, contactId, 'workflow.started', `Workflow „${wf.name}“ gestartet`);
  return run.id;
}

/**
 * Runs this process is executing right now. The scheduler's crash recovery (a run left 'running' for five minutes) never takes one
 * of these: a step may legitimately take longer (an AI answer, a slow web hook), and running it again would send twice.
 */
const LIVE = new WeakMap<App, Set<string>>();
const liveRuns = (app: App) => {
  let s = LIVE.get(app);
  if (!s) LIVE.set(app, (s = new Set()));
  return s;
};

/** Runs a workflow run from its cursor until it waits, finishes or fails. */
export async function processRun(app: App, runId: string): Promise<void> {
  const run = parseJson(app.db.get('SELECT * FROM workflow_runs WHERE id = ?', runId), ['cursor', 'event', 'log', 'vars']) as RunState | undefined;
  if (!run || !['active', 'waiting'].includes((run as any).status)) return;
  const wf = parseJson(app.db.get('SELECT * FROM workflows WHERE id = ?', run.workflow_id), ['steps', 'trigger', 'settings']);
  if (!wf || wf.status !== 'active') {
    app.db.update('workflow_runs', run.id, { status: 'stopped', updated_at: now() });
    return;
  }
  // Claim the run so a concurrent tick doesn't process it twice.
  const claimed = app.db.run(`UPDATE workflow_runs SET status = 'running', updated_at = ? WHERE id = ? AND status IN ('active','waiting')`, now(), run.id).changes;
  if (!claimed) return;
  if (!run.vars || typeof run.vars !== 'object') run.vars = {};
  const live = liveRuns(app);
  live.add(run.id);
  let res: ExecResult;
  try {
    // After every action the progress is saved (and the run's heartbeat with it); the log follows at the end of the pass.
    const checkpoint = (cursor: Cursor) =>
      app.db.run(`UPDATE workflow_runs SET cursor = ?, vars = ?, contact_id = ?, updated_at = ? WHERE id = ? AND status = 'running'`, JSON.stringify(cursor), JSON.stringify(run.vars), run.contact_id, now(), run.id);
    res = await execute(app, run, wf, { checkpoint });
  } finally {
    live.delete(run.id);
  }
  app.db.update('workflow_runs', run.id, { status: res.status, cursor: run.cursor, log: run.log.slice(-200), vars: run.vars, next_run_at: res.next_run_at, contact_id: run.contact_id, updated_at: now() });
  // A long run (a loop over hundreds of items) used its pass budget: carry on right away, after other work had its turn.
  if (res.status === 'active') setImmediate(() => void processRun(app, run.id).catch((e) => console.error('[workflow]', (e as Error).message)));
}

/** Inputs of a step for the run log: its settings with merge fields filled in, secrets hidden, long text cut. */
export function stepInput(step: Step, vars: Record<string, any>): Record<string, unknown> {
  const skip = new Set(['id', 'type', 'then', 'else', 'body_html', 'design', 'isHtml', 'text', 'variants', 'conditions', 'match', 'expression', 'name']);
  const secret = /token|secret|password|passwort|api[_-]?key|authorization|webhook_url|cookie/i;
  const walkIn = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      const r = v.includes('{{') ? render(v, vars) : v;
      return r.length > 400 ? `${r.slice(0, 400)}…` : r;
    }
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => walkIn(x, depth + 1));
    if (v && typeof v === 'object') {
      if (depth > 3) return '…';
      // a row such as {name: 'Authorization', value: '…'} hides its value
      const named = typeof (v as any).name === 'string' && secret.test((v as any).name);
      return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, secret.test(k) || (named && k === 'value') ? '••••' : walkIn(x, depth + 1)]));
    }
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step)) {
    if (skip.has(k) || (/^b\d$|^each$/.test(k) && Array.isArray(v))) continue;
    out[k] = secret.test(k) ? '••••' : walkIn(v, 0);
  }
  return out;
}

/** A value for the run log: kept as is when small, otherwise cut to a preview. */
export function clipLog(v: unknown, max = 1500): unknown {
  if (v === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(v) ?? '';
  } catch {
    return String(v).slice(0, max);
  }
  if (text.length <= max) return v;
  return { _truncated: true, preview: text.slice(0, max) };
}

/**
 * Why a step is skipped before it runs, or undefined to run it. Modules add rules with `app.services.workflowStepSkips`
 * (`(step) => reason | undefined`) – e.g. a paused step (modules/workflow-pause.ts). A skipped container skips its lanes too.
 */
function skipReason(app: App, step: Step): string | undefined {
  for (const rule of (app.services.workflowStepSkips ?? []) as ((s: Step) => string | undefined)[]) {
    const why = rule(step);
    if (why) return why;
  }
  return undefined;
}

/** Is the step safe to run in a test run (reads only, no sending, no writes, no outside calls)? */
function isPure(app: App, type: string): boolean {
  if (['wait', 'if', 'goal', 'end'].includes(type)) return true;
  return app.services.workflowActionMeta?.[type]?.pure === true;
}

/**
 * The step loop. It reads and changes `run` in memory (cursor, variables, log) and tells the caller how the run ended;
 * `processRun` saves it, test runs (`opts.dry`) throw it away.
 */
export async function execute(app: App, run: RunState, wf: any, opts: ExecOptions = {}): Promise<ExecResult> {
  const steps: Step[] = wf.steps ?? [];
  const dry = !!opts.dry;
  const cap = Math.min(20_000, Math.max(10, Number(wf.settings?.max_steps) || MAX_RUN_STEPS));
  let cursor: Cursor | null = run.cursor;
  const log = run.log;
  const tz = app.location(run.location_id)?.timezone || 'Europe/Berlin';
  // Tests move the clock with app.services.wfxNow.
  const clock = () => opts.now ?? (app.services.wfxNow ? new Date(Number(app.services.wfxNow())) : new Date());
  const done = (status: ExecResult['status'], next: string | null = null): ExecResult => {
    run.cursor = cursor ?? [];
    return { status, next_run_at: next };
  };

  let acted = false;
  for (let n = 0; n < (opts.maxSteps ?? MAX_STEPS_PER_PASS); n++) {
    if (!cursor) return done('completed');
    const here: Cursor = cursor;
    if (acted && !dry) opts.checkpoint?.(here);
    acted = false;
    const step = stepAt(steps, here);
    if (!step) {
      cursor = null;
      return done('completed');
    }
    const vars = varsFor(app, run, opts.contact);
    if (!vars.contact || !(vars.contact as any).id) return done('stopped');
    const total = Number(run.vars._steps ?? 0) + 1;
    run.vars._steps = total;
    if (total > cap) {
      log.push({ at: now(), step: step.id, type: step.type, error: `Grenze von ${cap} Schritten je Lauf erreicht (Endlosschleife?) – Lauf gestoppt` });
      return done('failed');
    }
    const skipped = skipReason(app, step);
    if (skipped) {
      log.push({ at: now(), step: step.id, type: step.type, result: skipped, skipped: true, ...(dry ? { dry: true } : {}) });
      cursor = advance(steps, here);
      continue;
    }
    const started = Date.now();
    let input: Record<string, unknown> | undefined;
    try {
      if (step.type === 'wait') {
        // The cursor moves past the wait now, so the scheduler resumes with the next step.
        const at = resumeAt(step, vars, tz, clock());
        cursor = advance(steps, cursor);
        if (at) {
          log.push({ at: now(), step: step.id, type: 'wait', result: dry ? `Trockenlauf: würde bis ${at.toISOString()} warten` : `bis ${at.toISOString()}`, ...(dry ? { dry: true } : {}) });
          if (!dry) return done('waiting', at.toISOString());
        }
        continue;
      }
      if (step.type === 'if') {
        const ok = evalConditions(step, vars);
        log.push({ at: now(), step: step.id, type: 'if', result: ok ? 'ja' : 'nein', ...(step.expression ? { input: { expression: String(step.expression).slice(0, 300) } } : {}) });
        const branch = ok ? 'then' : 'else';
        cursor = (step[branch] ?? []).length ? [...cursor, branch, 0] : advance(steps, cursor);
        continue;
      }
      if (step.type === 'end') {
        log.push({ at: now(), step: step.id, type: 'end' });
        cursor = null;
        continue;
      }
      if (step.type === 'goal') {
        // "Goal event": jump out early when the contact already reached it (e.g. booked a call).
        if (evalConditions(step, vars)) {
          log.push({ at: now(), step: step.id, type: 'goal', result: 'erreicht' });
          cursor = null;
          continue;
        }
        cursor = advance(steps, cursor);
        continue;
      }
      input = stepInput(step, vars);
      if (dry && !isPure(app, step.type)) {
        log.push({ at: now(), step: step.id, type: step.type, result: 'Trockenlauf: nicht ausgeführt', input: clipLog(input), dry: true });
        cursor = advance(steps, cursor);
        continue;
      }
      const fc: FlowCtx = {
        steps,
        cursor: here,
        dry,
        find: (sid) => locate(steps, sid),
        siblings: () => ({ list: listAt(steps, here.slice(0, -1)) ?? [], index: here[here.length - 1] as number }),
      };
      acted = true;
      const raw = await runAction(app, run, step, vars, fc);
      const out: ActionOutcome = typeof raw === 'string' ? { result: raw } : raw;
      if (out.vars) for (const [k, v] of Object.entries(out.vars)) (v === null || v === undefined ? delete run.vars[k] : (run.vars[k] = v));
      if (out.fields && !dry) applyContactFields(app, run, out.fields);
      if (out.contact_id && out.contact_id !== run.contact_id) {
        run.contact_id = out.contact_id;
        if (!dry) app.db.run('UPDATE workflow_runs SET contact_id = ? WHERE id = ?', out.contact_id, run.id);
      }
      const set = out.vars || out.fields ? { ...(out.vars ? { vars: out.vars } : {}), ...(out.fields ? { fields: out.fields } : {}) } : undefined;
      log.push({ at: now(), step: step.id, type: step.type, result: out.result, input: clipLog(input), ...(out.output !== undefined ? { output: clipLog(out.output) } : {}), ...(set ? { set: clipLog(set, 800) } : {}), ms: Date.now() - started, ...(dry ? { dry: true } : {}) });
      if (out.end) {
        cursor = null;
        continue;
      }
      if (out.goto) {
        const target = locate(steps, out.goto);
        if (!target) throw new Error('Sprungziel nicht gefunden – bitte den Schritt neu wählen');
        cursor = target;
        continue;
      }
      if (out.enter) {
        cursor = Array.isArray(step[out.enter]) && step[out.enter].length ? [...here, out.enter, 0] : advance(steps, here);
        continue;
      }
      if (out.wait_until) {
        const at = new Date(out.wait_until);
        if (!Number.isNaN(at.getTime()) && at > clock() && !dry) {
          cursor = out.stay ? here : advance(steps, here);
          return done('waiting', at.toISOString());
        }
      }
      cursor = advance(steps, here);
    } catch (e) {
      const ignored = step.continue_on_error === true;
      log.push({ at: now(), step: step.id, type: step.type, error: (e as Error).message, ...(ignored ? { ignored: true } : {}), ...(input ? { input: clipLog(input) } : {}), ms: Date.now() - started, ...(dry ? { dry: true } : {}) });
      // "Fehler ignorieren und weiter" on the step: logged, never reported, and the run goes on even when the workflow stops on errors.
      if (!ignored) {
        if (!dry) reportStepError(app, run, wf, step, (e as Error).message);
        if (wf.settings?.stop_on_error) return done('failed');
      }
      cursor = advance(steps, here);
    }
  }
  return done('active');
}

async function runAction(app: App, run: RunState, step: Step, vars: Record<string, any>, fc: FlowCtx): Promise<ActionResult> {
  const loc = run.location_id;
  const cid = run.contact_id;
  const t = (s: unknown) => render(String(s ?? ''), vars);
  switch (step.type) {
    case 'send_email': {
      // Merge fields inside HTML are escaped (contact data must not inject markup).
      const body = step.isHtml ? render(String(step.body ?? ''), vars, { escape: true }) : t(step.body);
      const subject = t(step.subject);
      // A step saved without content would send a blank mail to the customer.
      if (!subject.trim() && !String(body).trim()) throw new Error('E-Mail ohne Betreff und Text – nichts gesendet');
      const m = await sendToContact(app, loc, { contactId: cid, channel: 'email', subject, body, text: step.text ? t(step.text) : undefined, isHtml: !!step.isHtml, source: 'Workflow', ...(step.purpose === 'transactional' ? { purpose: 'transactional' as const } : {}) });
      if (m.status === 'failed') throw new Error(m.error);
      return m.status;
    }
    case 'send_sms': {
      const smsBody = t(step.body);
      if (!smsBody.trim()) throw new Error('SMS ohne Text – nichts gesendet');
      const m = await sendToContact(app, loc, { contactId: cid, channel: 'sms', body: smsBody, source: 'Workflow', ...(step.purpose === 'transactional' ? { purpose: 'transactional' as const } : {}) });
      if (m.status === 'failed') throw new Error(m.error);
      return m.status;
    }
    case 'add_tag':
      addTags(app, loc, cid, (step.tags ?? []).map(String));
      return (step.tags ?? []).join(', ');
    case 'remove_tag':
      removeTags(app, loc, cid, (step.tags ?? []).map(String));
      return (step.tags ?? []).join(', ');
    case 'update_field': {
      const field = String(step.field ?? '');
      const value = t(step.value);
      applyContactFields(app, run, { [field]: value });
      return `${field} = ${value}`;
    }
    case 'set_dnd':
      app.db.update('contacts', cid, { dnd: step.value ? 1 : 0, updated_at: now() });
      return step.value ? 'DND an' : 'DND aus';
    case 'create_opportunity': {
      const o = createOpportunity(app, loc, { pipeline_id: step.pipeline_id, stage_id: step.stage_id, contact_id: cid, name: t(step.name) || undefined, value: Number(t(step.value)) || 0, expected_close_date: t(step.expected_close_in_days) ? addDaysYmd(ymdInTz(new Date(), app.location(loc)?.timezone ?? 'Europe/Berlin'), Math.round(Number(t(step.expected_close_in_days)) || 0)) : undefined, currency: step.currency || undefined, source: 'Workflow' });
      return o.id;
    }
    case 'move_opportunity': {
      const p = getPipeline(app, loc, step.pipeline_id);
      if (!p) throw new Error('Pipeline nicht gefunden');
      const opp = app.db.get(`SELECT * FROM opportunities WHERE contact_id = ? AND pipeline_id = ? AND status = 'open' ORDER BY updated_at DESC`, cid, p.id);
      if (!opp) {
        if (step.create_if_missing === false) return 'keine Opportunity';
        return createOpportunity(app, loc, { pipeline_id: p.id, stage_id: step.stage_id, contact_id: cid, source: 'Workflow' }).id;
      }
      updateOpportunity(app, loc, opp.id, { stage_id: step.stage_id });
      return opp.id;
    }
    case 'set_opportunity_status': {
      const opp = app.db.get(`SELECT * FROM opportunities WHERE contact_id = ? ${step.pipeline_id ? 'AND pipeline_id = ?' : ''} ORDER BY updated_at DESC`, cid, ...(step.pipeline_id ? [step.pipeline_id] : []));
      if (!opp) return 'keine Opportunity';
      // A lost deal needs a reason: the step's own (it may use variables), otherwise one that says "automation".
      updateOpportunity(app, loc, opp.id, { status: step.status, ...(step.status === 'lost' ? { lost_reason: t(step.lost_reason) || AUTO_LOST_REASON } : {}) });
      return step.status;
    }
    case 'create_task': {
      const due = step.due_in_days !== undefined && step.due_in_days !== '' ? new Date(Date.now() + Number(step.due_in_days) * 864e5).toISOString() : null;
      app.db.insert('tasks', { id: id(), location_id: loc, contact_id: cid, title: t(step.title) || 'Aufgabe', description: t(step.description), due_at: due, assigned_to: step.assigned_to || null, done: 0, created_at: now() });
      return 'Aufgabe angelegt';
    }
    case 'add_note':
      // Modules add columns to the note (notes-plus: title, colour, pinned) through app.services.noteExtras.
      app.db.insert('notes', { id: id(), location_id: loc, contact_id: cid, body: t(step.body), user_id: null, created_at: now(), ...(app.services.noteExtras?.(step, t) ?? {}) });
      return 'Notiz angelegt';
    case 'notify':
      await notifyTeam(app, loc, t(step.subject) || 'Benachrichtigung', t(step.body), t(step.to) || undefined);
      return 'Team benachrichtigt';
    case 'webhook': {
      const url = String(step.url ?? '');
      if (!/^https?:\/\//.test(url)) throw new Error('Webhook-URL fehlt');
      const r = await safeFetch(url, {
        method: step.method === 'GET' ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: step.method === 'GET' ? undefined : JSON.stringify({ contact: vars.contact, event: vars.event, location: { id: loc, name: vars.location?.name } }),
        timeoutMs: 15_000,
      });
      if (!r.ok) throw new Error(`Webhook ${r.status}`);
      return `HTTP ${r.status}`;
    }
    case 'review_request':
      await sendReviewRequest(app, loc, cid, step.channel === 'sms' ? 'sms' : 'email');
      return 'Bewertungsanfrage gesendet';
    case 'add_to_workflow': {
      const other = parseJson(app.db.get('SELECT * FROM workflows WHERE id = ? AND location_id = ?', step.workflow_id, loc), ['steps', 'trigger', 'settings']);
      if (!other || other.status !== 'active') throw new Error('Ziel-Workflow nicht aktiv');
      const rid = startWorkflow(app, other, cid, run.event ?? {});
      if (rid) setImmediate(() => void processRun(app, rid));
      return rid ? 'gestartet' : 'schon drin';
    }
    case 'remove_from_workflow':
      app.db.run(`UPDATE workflow_runs SET status = 'stopped', updated_at = ? WHERE workflow_id = ? AND contact_id = ? AND status IN ('active','waiting')`, now(), step.workflow_id, cid);
      return 'entfernt';
    default: {
      // Actions contributed by other modules (e.g. social_post from the social planner).
      const ext = app.services.workflowActions?.[step.type];
      if (ext) return await ext(run, step, vars, fc);
      throw new Error(`Unbekannte Aktion ${step.type}`);
    }
  }
}

/** Hooks the engine into the event bus and the scheduler. */
export function installWorkflowEngine(app: App) {
  app.events.on('*', async (e) => {
    const contactId = e.data.contactId;
    if (!contactId || e.type === 'manual' || e.type === 'webhook') return;
    // Events a workflow caused itself (a field it set) do not chain on forever.
    if (Number(e.data.wfDepth ?? 0) >= 4) return;
    const flows = parseRows(app.db.all(`SELECT * FROM workflows WHERE location_id = ? AND status = 'active'`, e.locationId), ['steps', 'trigger', 'settings']);
    for (const wf of flows) {
      if (e.data.viaWorkflow && e.data.viaWorkflow === wf.id) continue;
      if (!triggerMatches(wf.trigger ?? { type: '' }, e, app.services.workflowTriggerFilters)) continue;
      if (!triggerFiltersPass(app, wf.trigger ?? { type: '' }, e)) continue;
      const rid = startWorkflow(app, wf, contactId, e.data);
      if (rid) await processRun(app, rid);
    }
  });
  app.onTick(async () => {
    const due = app.db.all(`SELECT id FROM workflow_runs WHERE status = 'waiting' AND next_run_at <= ? ORDER BY next_run_at LIMIT 200`, now());
    for (const r of due) await processRun(app, r.id);
    // Runs left 'running' by a crash get picked up again five minutes after their last step – never one this process is still
    // executing (a step may take longer than that). They go on after the last step that finished (see the checkpoint).
    const live = liveRuns(app);
    for (const r of app.db.all<{ id: string }>(`SELECT id FROM workflow_runs WHERE status = 'running' AND updated_at < ?`, new Date(Date.now() - 5 * 6e4).toISOString())) {
      if (!live.has(r.id)) app.db.run(`UPDATE workflow_runs SET status = 'active' WHERE id = ? AND status = 'running'`, r.id);
    }
    const stale = app.db.all(`SELECT id FROM workflow_runs WHERE status = 'active' AND updated_at < ? LIMIT 50`, new Date(Date.now() - 6e4).toISOString());
    for (const r of stale) await processRun(app, r.id);
  });
}
