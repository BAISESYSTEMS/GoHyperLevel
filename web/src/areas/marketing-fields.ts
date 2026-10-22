/**
 * Einfach-Modus of the marketing & automation editors (pure – used by the pages and tests/easy-marketing.test.ts).
 *
 * Which fields of a campaign, a workflow step or a catalogue-built form are the everyday ones and which go behind the
 * "Weitere Felder" toggle (web/src/areas/fields.tsx → MoreFields). The `…Values` helpers return what MoreFields needs to
 * open by itself: a section whose fields hold something other than their default never hides it.
 */

/** A field as the workflow catalogue describes it (web/src/pages/WorkflowTools.tsx → FieldDef). */
export interface CatalogField {
  key: string;
  type?: string;
  required?: boolean;
  default?: unknown;
  showIf?: { field: string; in: string[] };
}

/** At most this many optional fields show in a catalogue-built form before the rest folds away (required ones always show). */
export const MAIN_FIELDS = 5;

/** Fine-tuning of a step (retries, timeouts, headers, auth, response mapping …): never the first thing anybody fills in. */
const TUNING = /^(retries|retry_|timeout|check_every|on_timeout|fail_on_error|response_var|map$|headers$|query$|auth|sticky$|var_name$|cooldown|dedupe)/;

/** Is this catalogue field fine-tuning (folds away in Einfach-Modus even when there is room)? */
export function isTuningField(f: CatalogField): boolean {
  return !f.required && TUNING.test(f.key);
}

/**
 * Splits catalogue fields into the main part and the "Weitere Felder" part, keeping their order: required fields always stay,
 * tuning fields fold away, of the rest the first `max` stay. A field shown only for some value of another field (`showIf`)
 * follows that field and does not count.
 */
export function splitCatalogFields<F extends CatalogField>(fields: readonly F[], max = MAIN_FIELDS): { main: F[]; more: F[] } {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const rootOf = (f: F): F => {
    let cur = f;
    const seen = new Set<string>();
    while (cur.showIf && byKey.has(cur.showIf.field) && !seen.has(cur.key)) {
      seen.add(cur.key);
      cur = byKey.get(cur.showIf.field)!;
    }
    return cur;
  };
  const folded = new Set<string>();
  let count = 0;
  for (const f of fields) {
    if (rootOf(f) !== f) continue;
    if (f.required) {
      count++;
      continue;
    }
    if (isTuningField(f) || count >= max) folded.add(f.key);
    else count++;
  }
  const isMore = (f: F) => folded.has(rootOf(f).key);
  return { main: fields.filter((f) => !isMore(f)), more: fields.filter(isMore) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Does the value differ from "not set" and from the field's default? (false counts when the default is true.) */
export function isCustomized(value: unknown, def?: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value) && !value.length) return false;
  if (def !== undefined) return !same(value, def);
  return value !== false;
}

/** For MoreFields `values` of a settings object: one entry per key (default: every key of either), `true` where it differs from `defaults`. */
export function changedAgainst(obj: Record<string, unknown> | undefined, defaults: Record<string, unknown>, keys?: readonly string[]): boolean[] {
  const o = obj ?? {};
  const ks = keys ?? [...new Set([...Object.keys(o), ...Object.keys(defaults)])];
  return ks.map((k) => o[k] !== undefined && isCustomized(o[k], defaults[k]));
}

/** For MoreFields `values`: one entry per field, `true` where someone changed it (defaults filled in by a new step do not count). */
export function changedFieldValues(fields: readonly CatalogField[], values: Record<string, unknown>): boolean[] {
  return fields.map((f) => isCustomized(values[f.key], f.default));
}

// --- workflow steps with their own editor ---------------------------------------------------------------------------------

/**
 * Secondary settings of the steps that have their own editor (web/src/pages/Workflows.tsx → StepMore), with the value that
 * counts as "not changed". Every step also has its name in the flow and "ignore errors" behind the same toggle.
 */
export const STEP_MORE: Record<string, Record<string, unknown>> = {
  send_email: { isHtml: false, purpose: undefined },
  send_sms: { purpose: undefined },
  create_opportunity: { name: undefined, currency: undefined, expected_close_in_days: undefined },
  move_opportunity: { create_if_missing: true },
  set_opportunity_status: { pipeline_id: undefined },
  webhook: { method: 'POST' },
  if: { expression: undefined },
  goal: { expression: undefined },
};
export const STEP_COMMON_MORE: Record<string, unknown> = { name: undefined, continue_on_error: undefined };

/** The step types whose secondary settings StepMore renders. */
export const hasStepMore = (type: string) => type in STEP_MORE;

/** For MoreFields `values` of a step: the secondary settings that were changed (an unset value counts as its default). */
export function stepMoreValues(step: Record<string, unknown>): boolean[] {
  const keys: Record<string, unknown> = { ...(STEP_MORE[String(step.type)] ?? {}), ...STEP_COMMON_MORE };
  // A designed e-mail is HTML by itself – the "Text ist HTML" switch only exists for plain text.
  if (step.design) delete keys.isHtml;
  return Object.entries(keys).map(([k, def]) => step[k] !== undefined && isCustomized(step[k], def));
}

// --- campaigns ---------------------------------------------------------------------------------------------------------------

/**
 * The folded sections of the campaign editor and what keeps each of them open: content extras (sender name, raw HTML),
 * audience extras (segment, any/without tags), A/B test and follow-up, send time and speed. Name, channel, subject, content,
 * smart list, tags, test and send stay in view.
 */
export function campaignMoreValues(c: Record<string, any>): { content: unknown[]; audience: unknown[]; extras: unknown[]; sending: unknown[] } {
  const f = c.filter ?? {};
  return {
    content: [c.sender_name, !c.design && !!c.is_html],
    audience: [f.segment_id, f.anyTags, f.excludeTags],
    extras: [!!c.ab?.enabled, !!c.resend?.enabled],
    sending: [c.send_mode === 'sto', c.speed_per_hour],
  };
}

// --- sales sequences ---------------------------------------------------------------------------------------------------------

/** The settings a new sequence starts with (web/src/pages/SalesSequences.tsx → blankSeq): send window Mon–Fri 9–17, stop on reply, meeting, closed deal. */
export const SEQUENCE_DEFAULTS = {
  window: { enabled: true, days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '17:00', tz: '' },
  stop_on: { reply: true, meeting: true, stage_change: false, deal_closed: true },
  footer: true,
  shared_mailbox: false,
};

/**
 * For MoreFields `values` of the sequence editor: description, send window and stop rules fold away in Einfach-Modus while
 * they are as a new sequence has them; changed ones keep the section open.
 */
export function sequenceMoreValues(seq: Record<string, any>): unknown[] {
  const st = seq.settings ?? {};
  const d = SEQUENCE_DEFAULTS;
  return [
    seq.description,
    st.window !== undefined && !same({ ...d.window, ...st.window }, d.window),
    st.stop_on !== undefined && !same({ ...d.stop_on, ...st.stop_on }, d.stop_on),
    st.footer === false,
    st.shared_mailbox === true,
  ];
}

// --- webinars ------------------------------------------------------------------------------------------------------------------

/** The tags a new webinar sets (server/services/webinar-model.ts → defaultSettings; tests/easy-marketing.test.ts keeps them in sync). */
export const WEBINAR_DEFAULT_TAGS: Record<string, string[]> = { attended: ['webinar-teilgenommen'], missed: ['webinar-verpasst'], cta: ['webinar-angebot-geklickt'], purchased: ['webinar-gekauft'], replay: ['webinar-replay'] };
export const WEBINAR_DEFAULT_BUTTON = 'Kostenlos anmelden';

/**
 * For MoreFields `values` of the webinar editor tabs. Einfach-Modus keeps title, description, presenter, video, fixed times,
 * single dates, consent and thank-you text in view; the rest folds away while it is as a new webinar has it.
 * `schedule` defaults come from server/services/webinar-schedule.ts (DEFAULT_SCHEDULE), passed in to keep this module light.
 */
export function webinarMoreValues(form: Record<string, any>, defaults: { late_join_min: number }): { basics: unknown[]; schedule: unknown[]; registration: unknown[]; tags: unknown[] } {
  const s = form.schedule ?? {};
  const r = form.settings?.registration ?? {};
  const tags = form.settings?.tags ?? {};
  return {
    basics: [form.presenter_photo],
    schedule: [s.tz, !!s.jit?.enabled, !!s.ondemand?.enabled, s.blackout, Number(s.max_per_session) > 0, s.late_join_min !== undefined && s.late_join_min !== defaults.late_join_min],
    registration: [r.headline, r.button_text && r.button_text !== WEBINAR_DEFAULT_BUTTON, r.redirect_url, r.form_ids],
    tags: Object.keys(WEBINAR_DEFAULT_TAGS).map((k) => tags[k] !== undefined && !same(tags[k], WEBINAR_DEFAULT_TAGS[k])),
  };
}

// --- community groups ----------------------------------------------------------------------------------------------------------

/** Moderation and points of a new group (server/services/community.ts → DEFAULT_SETTINGS; tests/easy-marketing.test.ts keeps them in sync). */
export const COMMUNITY_DEFAULTS = {
  word_filter: [] as string[],
  filter_mode: 'mask',
  posts_per_hour: 5,
  comments_per_hour: 30,
  auto_hide_reports: 3,
  points: { post: 2, comment: 1, like: 1 },
  level_points: [0, 5, 20, 65, 155, 515, 2015, 8015, 33015],
  level_unlocks: [] as unknown[],
};

/** For MoreFields `values` of a group's settings: moderation and points & levels fold away while they are the defaults. */
export function communityMoreValues(s: Record<string, any>): { moderation: boolean[]; points: boolean[] } {
  const d = COMMUNITY_DEFAULTS;
  const changed = (k: keyof typeof d) => s[k] !== undefined && isCustomized(s[k], d[k]);
  const levels: any[] = Array.isArray(s.levels) ? s.levels : [];
  const levelsChanged = levels.length > 0 && !same(levels, d.level_points.map((points, i) => ({ name: `Level ${i + 1}`, points })));
  return {
    moderation: [changed('word_filter'), changed('filter_mode'), changed('posts_per_hour'), changed('comments_per_hour'), changed('auto_hide_reports')],
    points: [changed('points'), levelsChanged, changed('level_unlocks')],
  };
}
