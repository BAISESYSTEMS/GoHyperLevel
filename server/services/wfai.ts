import { id as newId } from '../core/util.js';
import { branchKeys, walk, type Step } from './workflow-engine.js';
import type { ActionMeta, FieldDef, TriggerMeta } from './wfx-kit.js';

/**
 * KI-Workflow-Builder – the pure parts: what the AI is told about the workflow catalogue, how its answer is read and checked
 * against that catalogue (trigger and step types, required fields, select options, ids that really exist in the sub-account),
 * and the diff between a workflow and the AI's proposal. No I/O, no database. The module (modules/wfai.ts) runs the AI call with
 * retries and saves the result as a draft – never as a published workflow. Docs: docs/workflow-ai.md.
 */

export type RefKind = 'pipeline' | 'stage' | 'calendar' | 'form' | 'workflow' | 'product' | 'course' | 'group' | 'link' | 'user';
export type AiField = FieldDef & { ref?: RefKind; min?: number };

export interface Refs {
  pipeline?: { id: string; name: string; stages: { id: string; name: string }[] }[];
  calendar?: { id: string; name: string }[];
  form?: { id: string; name: string }[];
  workflow?: { id: string; name: string; status?: string }[];
  product?: { id: string; name: string }[];
  course?: { id: string; name: string }[];
  group?: { id: string; name: string }[];
  link?: { id: string; name: string }[];
  user?: { id: string; name: string }[];
  tags?: string[];
  custom_fields?: { key: string; label: string }[];
}

export interface AiAction {
  type: string;
  label: string;
  category: string;
  summary: string;
  needs?: string;
  fields: AiField[];
  container?: boolean;
}
export interface AiTrigger {
  type: string;
  label: string;
  category: string;
  summary: string;
  fields: AiField[];
  sample: Record<string, unknown>;
}

export interface WorkflowDraft {
  name: string;
  trigger: { type: string; config: Record<string, any> };
  steps: Step[];
  settings: { allow_reentry: boolean; stop_on_error: boolean };
}

export const LIMITS = { prompt: 4000, steps: 80, depth: 6, text: 4000, textarea: 10000, tags: 20 };

// --- shapes of the steps that have their own editor in the web app (the catalogue lists no fields for them) -------------------------

const f = (key: string, type: AiField['type'], label: string, o: Partial<AiField> = {}): AiField => ({ key, type, label, ...o });
const sel = (...options: [string, string][]) => options;
const CONDITION_FIELDS: AiField[] = [f('conditions', 'conditions', 'Bedingungen'), f('match', 'select', 'Verknüpfung', { options: sel(['all', 'alle'], ['any', 'eine']), default: 'all' }), f('expression', 'text', 'Ausdruck (statt Bedingungen)')];

/** Fields of the built-in steps. A built-in step that is not listed here is not offered to the AI (its settings are not described anywhere). */
export const STEP_SHAPES: Record<string, AiField[]> = {
  send_email: [f('subject', 'text', 'Betreff', { required: true }), f('body', 'textarea', 'Text', { required: true })],
  send_sms: [f('body', 'textarea', 'Text', { required: true })],
  whatsapp_send: [f('mode', 'select', 'Modus', { options: sel(['auto', 'automatisch'], ['text', 'Text'], ['template', 'Vorlage']), default: 'auto' }), f('body', 'textarea', 'Text'), f('template', 'text', 'Name der freigegebenen Vorlage'), f('language', 'text', 'Sprache der Vorlage (de)')],
  telegram_send: [f('body', 'textarea', 'Text', { required: true }), f('media_url', 'text', 'Bild-Link (https)')],
  push_contact: [f('title', 'text', 'Titel'), f('body', 'textarea', 'Text', { required: true }), f('url', 'text', 'Link')],
  notify: [f('subject', 'text', 'Betreff', { required: true }), f('body', 'textarea', 'Text', { required: true }), f('to', 'text', 'Empfänger (leer = Firmen-E-Mail)')],
  review_request: [f('channel', 'select', 'Kanal', { options: sel(['email', 'E-Mail'], ['sms', 'SMS']), default: 'email' })],
  wait: [
    f('mode', 'select', 'Art', { options: sel(['delay', 'Dauer'], ['weekday', 'nächster Wochentag'], ['date', 'festes Datum'], ['field', 'Datum aus Kontaktfeld']), default: 'delay' }),
    f('amount', 'number', 'Menge', { required: true, min: 1, showIf: { field: 'mode', in: ['delay'] } }),
    f('unit', 'select', 'Einheit', { options: sel(['minutes', 'Minuten'], ['hours', 'Stunden'], ['days', 'Tage']), default: 'hours', showIf: { field: 'mode', in: ['delay'] } }),
    f('time', 'time', 'Uhrzeit (HH:MM, Zeitzone des Sub-Accounts)', { showIf: { field: 'mode', in: ['weekday', 'date', 'field'] } }),
    f('days', 'weekdays', 'Erlaubte Wochentage', { showIf: { field: 'mode', in: ['weekday'] } }),
    f('date', 'date', 'Datum', { required: true, showIf: { field: 'mode', in: ['date'] } }),
    f('field', 'contact_field', 'Kontaktfeld mit Datum (date_of_birth, custom.xyz)', { required: true, showIf: { field: 'mode', in: ['field'] } }),
    f('offset_days', 'number', 'Tage davor (negativ) oder danach', { showIf: { field: 'mode', in: ['field'] } }),
    f('yearly', 'bool', 'Jedes Jahr', { showIf: { field: 'mode', in: ['field'] } }),
  ],
  if: CONDITION_FIELDS,
  goal: CONDITION_FIELDS,
  end: [],
  add_tag: [f('tags', 'tags', 'Tags', { required: true })],
  remove_tag: [f('tags', 'tags', 'Tags', { required: true })],
  update_field: [f('field', 'contact_field', 'Feld (first_name, company, custom.xyz …)', { required: true }), f('value', 'text', 'Wert')],
  set_dnd: [f('value', 'bool', 'Nicht stören an', { required: true })],
  add_note: [f('body', 'textarea', 'Text', { required: true })],
  create_task: [f('title', 'text', 'Titel', { required: true }), f('description', 'textarea', 'Beschreibung'), f('due_in_days', 'number', 'Fällig in Tagen'), f('assigned_to', 'user', 'Zuständig (Nutzer-ID)', { ref: 'user' })],
  create_opportunity: [f('pipeline_id', 'pipeline', 'Pipeline', { required: true }), f('stage_id', 'stage', 'Stufe', { required: true }), f('name', 'text', 'Name (leer = Kontaktname)'), f('value', 'text', 'Wert'), f('currency', 'text', 'Währung (Standard EUR)'), f('expected_close_in_days', 'text', 'Erwarteter Abschluss in Tagen')],
  move_opportunity: [f('pipeline_id', 'pipeline', 'Pipeline', { required: true }), f('stage_id', 'stage', 'Zielstufe', { required: true }), f('create_if_missing', 'bool', 'Anlegen, wenn noch keine offen ist', { default: true })],
  set_opportunity_status: [f('status', 'select', 'Status', { required: true, options: sel(['open', 'offen'], ['won', 'gewonnen'], ['lost', 'verloren'], ['abandoned', 'aufgegeben']) }), f('pipeline_id', 'pipeline', 'Nur in Pipeline'), f('lost_reason', 'text', 'Verlustgrund (bei verloren)')],
  webhook: [f('url', 'text', 'URL (https)', { required: true }), f('method', 'select', 'Methode', { options: sel(['POST', 'POST'], ['GET', 'GET']), default: 'POST' })],
  add_to_workflow: [f('workflow_id', 'workflow', 'Workflow', { required: true })],
  remove_from_workflow: [f('workflow_id', 'workflow', 'Workflow', { required: true })],
  course_grant: [f('course_id', 'text', 'Kurs-ID', { required: true, ref: 'course' })],
  course_revoke: [f('course_id', 'text', 'Kurs-ID', { required: true, ref: 'course' })],
  ticket_create: [f('subject', 'text', 'Betreff', { required: true }), f('description', 'textarea', 'Beschreibung'), f('priority', 'select', 'Priorität', { options: sel(['low', 'niedrig'], ['normal', 'normal'], ['high', 'hoch'], ['urgent', 'dringend']), default: 'normal' })],
  ai_text: [f('prompt', 'textarea', 'Auftrag an die KI', { required: true }), f('target', 'select', 'Ergebnis speichern in', { options: sel(['field', 'Kontaktfeld'], ['note', 'Notiz'], ['email_draft', 'E-Mail-Entwurf']), default: 'note' }), f('field', 'contact_field', 'Kontaktfeld', { showIf: { field: 'target', in: ['field'] } }), f('subject', 'text', 'Betreff', { showIf: { field: 'target', in: ['email_draft'] } })],
};

/** Config of the built-in triggers (the catalogue lists no fields for them). */
const TRIGGER_COMMON: AiField[] = [f('filters', 'conditions', 'Zusätzliche Filter'), f('filters_match', 'select', 'Filter-Verknüpfung', { options: sel(['all', 'alle'], ['any', 'eine']), default: 'all' }), f('filter_expression', 'text', 'Filter-Ausdruck')];
export const TRIGGER_SHAPES: Record<string, AiField[]> = {
  'contact.tag_added': [f('tag', 'text', 'Nur dieser Tag')],
  'contact.tag_removed': [f('tag', 'text', 'Nur dieser Tag')],
  'form.submitted': [f('form_id', 'form', 'Nur dieses Formular')],
  'appointment.booked': [f('calendar_id', 'calendar', 'Nur dieser Kalender')],
  'appointment.status_changed': [f('calendar_id', 'calendar', 'Nur dieser Kalender'), f('status', 'select', 'Status', { options: sel(['confirmed', 'bestätigt'], ['cancelled', 'abgesagt'], ['showed', 'wahrgenommen'], ['noshow', 'nicht erschienen']) })],
  'opportunity.created': [f('pipeline_id', 'pipeline', 'Nur diese Pipeline')],
  'opportunity.stage_changed': [f('pipeline_id', 'pipeline', 'Nur diese Pipeline'), f('stage_id', 'stage', 'Nur diese Zielstufe')],
  'opportunity.status_changed': [f('pipeline_id', 'pipeline', 'Nur diese Pipeline'), f('status', 'select', 'Status', { options: sel(['won', 'gewonnen'], ['lost', 'verloren'], ['abandoned', 'aufgegeben'], ['open', 'offen']) })],
  'message.inbound': [f('channel', 'select', 'Kanal', { options: sel(['email', 'E-Mail'], ['sms', 'SMS'], ['chat', 'Chat'], ['whatsapp', 'WhatsApp'], ['messenger', 'Messenger'], ['instagram', 'Instagram']) })],
  'review.received': [f('min_rating', 'number', 'Mindestens Sterne'), f('max_rating', 'number', 'Höchstens Sterne')],
  'google_review.received': [f('min_rating', 'number', 'Mindestens Sterne'), f('max_rating', 'number', 'Höchstens Sterne')],
  'call.completed': [f('direction', 'select', 'Richtung', { options: sel(['in', 'eingehend'], ['out', 'ausgehend']) })],
  'link.clicked': [f('link_id', 'text', 'Nur dieser Link', { ref: 'link' })],
  'product.purchased': [f('product_id', 'product', 'Nur dieses Produkt')],
  'email.clicked': [f('url_contains', 'text', 'Link enthält')],
  'course.enrolled': [f('course_id', 'text', 'Nur dieser Kurs', { ref: 'course' })],
  'course.started': [f('course_id', 'text', 'Nur dieser Kurs', { ref: 'course' })],
  'lesson.completed': [f('course_id', 'text', 'Nur dieser Kurs', { ref: 'course' })],
  'course.completed': [f('course_id', 'text', 'Nur dieser Kurs', { ref: 'course' })],
  'date.reached': [f('field', 'contact_field', 'Kontaktfeld mit Datum (date_of_birth oder custom.xyz)'), f('offset_days', 'number', 'Tage davor (negativ) oder danach'), f('time', 'time', 'Uhrzeit'), f('yearly', 'bool', 'Jedes Jahr')],
};

export const CONDITION_OPS = ['has', 'not_has', 'equals', 'not_equals', 'contains', 'empty', 'not_empty', 'gt', 'lt', 'gte', 'lte', 'starts_with', 'ends_with', 'in', 'not_in', 'between', 'regex', 'date_before', 'date_after'];
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const ROOTS = new Set(['contact', 'event', 'var', 'location', 'appointment', 'opportunity', 'message', 'answers']);

// --- catalogue as the AI sees it -----------------------------------------------------------------------------------------------

/** The actions the AI may use: everything with described fields, plus the built-in steps listed in STEP_SHAPES. */
export function usableActions(metas: ActionMeta[]): Map<string, AiAction> {
  const out = new Map<string, AiAction>();
  for (const m of metas) {
    const fields: AiField[] | undefined = m.fields?.length ? m.fields : STEP_SHAPES[m.type] ?? (m.custom ? undefined : []);
    if (!fields) continue;
    out.set(m.type, { type: m.type, label: m.label, category: m.category, summary: m.summary, needs: m.needs, fields, container: !!m.container || m.type === 'if' });
  }
  return out;
}

export function usableTriggers(metas: TriggerMeta[]): Map<string, AiTrigger> {
  const out = new Map<string, AiTrigger>();
  for (const m of metas) out.set(m.type, { type: m.type, label: m.label, category: m.category, summary: m.summary, fields: m.fields?.length ? m.fields : TRIGGER_SHAPES[m.type] ?? [], sample: m.sample ?? {} });
  return out;
}

const valueType = (fl: AiField): string => {
  switch (fl.type) {
    case 'select':
      return `(${(fl.options ?? []).map((o) => o[0]).join('|')})`;
    case 'rows':
      return `[{${(fl.rows ?? []).map((r) => `${r.key}:${valueType(r)}`).join(', ')}}]`;
    case 'tags':
    case 'users':
    case 'social_channels':
      return '[text]';
    case 'number':
      return 'zahl';
    case 'bool':
      return 'true|false';
    case 'conditions':
      return '[Bedingung]';
    case 'weekdays':
      return '[mon..sun]';
    case 'time':
      return 'HH:MM';
    case 'date':
      return 'YYYY-MM-DD';
    case 'step':
      return '<Schritt-id>';
    case 'pipeline':
    case 'stage':
    case 'calendar':
    case 'form':
    case 'workflow':
    case 'product':
    case 'user':
    case 'group':
    case 'webinar':
    case 'contract_template':
      return `<${fl.type}-id>`;
    default:
      return fl.ref ? `<${fl.ref}-id>` : 'text';
  }
};
const fieldSpec = (fl: AiField): string => `${fl.key}${fl.required ? '*' : ''}:${valueType(fl)}${fl.showIf ? `{wenn ${fl.showIf.field}=${fl.showIf.in.join('|')}}` : ''}`;

/** The catalogue as compact text: one line per trigger and step with its settings (`*` = required). */
export function catalogText(actions: Map<string, AiAction>, triggers: Map<string, AiTrigger>): string {
  const t = [...triggers.values()].map((x) => `- ${x.type} · ${x.label} · config: ${[...x.fields, ...TRIGGER_COMMON].map(fieldSpec).join(', ')}`);
  const a = [...actions.values()].map((x) => `- ${x.type} · ${x.label}${x.summary ? ` – ${x.summary}` : ''}${x.needs ? ` (braucht: ${x.needs})` : ''}${x.fields.length ? ` · ${x.fields.map(fieldSpec).join(', ')}` : ''}`);
  return `AUSLÖSER (type · Name · config):\n${t.join('\n')}\n\nSCHRITTE (type · Name – Zweck · Einstellungen):\n${a.join('\n')}`;
}

export const REF_TITLES: Record<string, string> = { pipeline: 'Pipelines (mit Stufen)', calendar: 'Kalender', form: 'Formulare', workflow: 'Workflows', product: 'Produkte', course: 'Kurse', group: 'Community-Gruppen', link: 'Trigger-Links', user: 'Team' };

/** What exists in the sub-account: ids and names, so the AI never invents an id. */
export function contextText(refs: Refs, settings: { timezone?: string; name?: string } = {}): string {
  const lines: string[] = [`Sub-Account: ${settings.name ?? ''} · Zeitzone ${settings.timezone ?? 'Europe/Berlin'}`];
  const list = (title: string, items?: { id: string; name: string; status?: string }[]) => {
    if (items === undefined) return;
    lines.push(items.length ? `${title}: ${items.slice(0, 60).map((i) => `${i.id} = „${i.name.slice(0, 60)}“${i.status ? ` (${i.status})` : ''}`).join('; ')}` : `${title}: keine vorhanden`);
  };
  if (refs.pipeline) lines.push(refs.pipeline.length ? `${REF_TITLES.pipeline}: ${refs.pipeline.slice(0, 20).map((p) => `${p.id} = „${p.name}“ [Stufen: ${p.stages.map((s) => `${s.id} = „${s.name}“`).join('; ')}]`).join(' | ')}` : `${REF_TITLES.pipeline}: keine vorhanden`);
  for (const k of ['calendar', 'form', 'workflow', 'product', 'course', 'group', 'link', 'user'] as const) list(REF_TITLES[k], refs[k]);
  if (refs.tags?.length) lines.push(`Vorhandene Tags: ${refs.tags.slice(0, 80).join(', ')}`);
  if (refs.custom_fields?.length) lines.push(`Eigene Kontaktfelder (als custom.<key>): ${refs.custom_fields.slice(0, 60).map((c) => `${c.key} = ${c.label}`).join('; ')}`);
  return lines.join('\n');
}

export const SYSTEM_RULES = `Du bist der Workflow-Builder von HyperLevel, einem CRM mit Automationen. Du baust aus einem Auftrag in Alltagssprache einen Workflow: ein Auslöser und eine Liste von Schritten, die für einen Kontakt nacheinander ablaufen.

ANTWORT: genau ein JSON-Objekt, kein Markdown, kein Text davor oder danach:
{"name": "kurzer Name", "summary": "2–4 Sätze auf Deutsch: was der Workflow tut und was sich geändert hat", "trigger": {"type": "…", "config": {…}}, "steps": [{"type": "…", …Einstellungen des Schritts}], "settings": {"allow_reentry": false, "stop_on_error": false}, "notes": ["Was die Person vorher einrichten oder prüfen muss"]}

REGELN
- Nimm nur Auslöser und Schritte aus dem KATALOG unten, mit genau diesen Einstellungs-Namen. Erfinde keine Typen und keine Felder. Mit * markierte Einstellungen sind Pflicht.
- IDs (Pipeline, Stufe, Kalender, Formular, Workflow, Produkt, Kurs, Gruppe, Link, Nutzer) nur aus dem KONTEXT. Gibt es das Gewünschte nicht, lass die Einstellung leer und schreibe in "notes", was angelegt werden muss. Erfinde nie eine ID.
- Texte an Kundinnen und Kunden auf Deutsch (Du, freundlich, kurz), mit Platzhaltern wie {{contact.first_name}} (Fallback: {{contact.first_name|du}}), {{contact.name}}, {{location.name}}, {{event.…}} (Daten des Auslösers) und {{var.…}} (Variablen früherer Schritte). Keine erfundenen Preise, Termine, Links oder Zusagen: nimm Platzhalter oder schreibe es in "notes".
- Zwischen Nachrichten gehört ein "wait" (Mails/SMS/WhatsApp nie direkt hintereinander). Prüfe mit "goal" oder "if", ob das Ziel schon erreicht ist, bevor nachgefasst wird. Markiere Fortschritt mit Tags.
- Bedingungen: [{"field": "tag"|"email"|"phone"|"first_name"|"company"|"source"|"custom.<key>"|"event.<feld>"|"var.<name>", "op": "${CONDITION_OPS.join('|')}", "value": "…"}]. Bei field "tag" sind nur has / not_has sinnvoll. Alternativ "expression", z. B. contact.custom.budget > 1000 && "vip" in contact.tags.
- Verzweigungen tragen ihre Unterschritte als Listen: "if" → "then" und "else"; "split_test" → "variants" [{name, weight}] und je Pfad "b0", "b1", …; "loop" → "each". Ein Schritt, auf den "goto" verweist, braucht eine "id" (kurz, Buchstaben/Ziffern).
- Höchstens ${LIMITS.steps} Schritte, einfach und nachvollziehbar. Der Workflow wird NICHT veröffentlicht: Die Person prüft ihn erst als Entwurf.
- settings: allow_reentry = darf derselbe Kontakt den Ablauf mehrfach durchlaufen; stop_on_error = bei einem Fehler abbrechen statt weitermachen.`;

export const EDIT_RULES = `ÄNDERN: Du bekommst den bisherigen Workflow als JSON. Gib den VOLLSTÄNDIGEN geänderten Workflow zurück (nicht nur die Änderung). Behalte die "id" jedes Schritts, den du nicht entfernst, und ändere nur, was der Auftrag verlangt – Reihenfolge, Texte und Einstellungen der übrigen Schritte bleiben unverändert. "summary" beschreibt, was du geändert hast.`;

// --- reading and checking the answer ---------------------------------------------------------------------------------------

/** The JSON object of a reply ("```json {…} ```", "Hier ist der Workflow: {…}"), or null. */
export function parseAnswer(text: string): any | null {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const tries = [t];
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) tries.push(t.slice(start, end + 1));
  for (const s of tries) {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* next */
    }
  }
  return null;
}

export interface CheckEnv {
  actions: Map<string, AiAction>;
  triggers: Map<string, AiTrigger>;
  refs: Refs;
  /** Ids of the steps the workflow had before (kept in edit mode). */
  knownIds?: Set<string>;
}
export interface Checked {
  workflow?: WorkflowDraft;
  summary: string;
  notes: string[];
  errors: string[];
  warnings: string[];
}

const str = (v: unknown, max: number) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const isTemplate = (v: unknown) => typeof v === 'string' && /\{\{[^}]+\}\}/.test(v);

/** Checks one condition list. */
function checkConditions(v: unknown, where: string, errors: string[], warnings: string[]): { field: string; op: string; value?: string }[] {
  if (v === undefined || v === null || v === '') return [];
  if (!Array.isArray(v)) {
    errors.push(`${where}: Bedingungen müssen eine Liste sein [{field, op, value}]`);
    return [];
  }
  const out: { field: string; op: string; value?: string }[] = [];
  v.slice(0, 20).forEach((c: any, i) => {
    const field = str(c?.field, 80);
    const op = str(c?.op, 20);
    if (!field) return void errors.push(`${where}, Bedingung ${i + 1}: „field“ fehlt`);
    if (!CONDITION_OPS.includes(op)) return void errors.push(`${where}, Bedingung ${i + 1}: Vergleich „${op}“ gibt es nicht (erlaubt: ${CONDITION_OPS.join(', ')})`);
    if (field === 'tag' && !['has', 'not_has'].includes(op)) warnings.push(`${where}: Beim Feld „tag“ passen nur has / not_has`);
    const needsValue = !['empty', 'not_empty'].includes(op);
    if (needsValue && (c?.value === undefined || String(c.value) === '')) return void errors.push(`${where}, Bedingung ${i + 1}: „value“ fehlt`);
    const root = field.split('.')[0];
    if (field.includes('.') && !ROOTS.has(root) && root !== 'custom') warnings.push(`${where}: Feld „${field}“ beginnt weder mit contact, custom, event noch var`);
    out.push({ field, op, ...(needsValue ? { value: String(c.value).slice(0, 500) } : {}) });
  });
  return out;
}

function refList(kind: RefKind, refs: Refs): { id: string }[] | undefined {
  if (kind === 'stage') return refs.pipeline?.flatMap((p) => p.stages);
  return refs[kind];
}

/** One field value, cleaned to what the step stores; null = leave out. */
function checkValue(fl: AiField, raw: unknown, where: string, env: CheckEnv, sibling: Record<string, unknown>, errors: string[], warnings: string[]): unknown {
  const label = `${where}, „${fl.label || fl.key}“`;
  const missing = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length);
  const refKind: RefKind | undefined = (['pipeline', 'stage', 'calendar', 'form', 'workflow', 'product', 'group', 'user'] as string[]).includes(fl.type) ? (fl.type as RefKind) : fl.ref;
  if (missing) {
    if (fl.required && fl.default === undefined) {
      // Something that has to be chosen in the editor (the sub-account has none, or the AI could not know) is a hint, not a failure.
      if (refKind) warnings.push(`${label} muss im Editor noch ausgewählt werden`);
      else errors.push(`${label} fehlt (Pflichtfeld)`);
    }
    return fl.required && fl.default !== undefined ? fl.default : null;
  }
  switch (fl.type) {
    case 'text':
    case 'textarea':
    case 'code':
    case 'time':
    case 'date':
    case 'tz':
    case 'contact_field':
    case 'target':
    case 'contract_template':
    case 'webinar':
    case 'calendar':
    case 'form':
    case 'workflow':
    case 'product':
    case 'pipeline':
    case 'stage':
    case 'group':
    case 'user':
    case 'step': {
      if (typeof raw === 'object') {
        errors.push(`${label} muss Text sein`);
        return null;
      }
      const s = str(raw, fl.type === 'textarea' || fl.type === 'code' ? LIMITS.textarea : LIMITS.text);
      if (fl.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) errors.push(`${label}: Uhrzeit als HH:MM (z. B. 09:00)`);
      if (fl.type === 'date' && !isTemplate(s) && !/^\d{4}-\d{2}-\d{2}$/.test(s) && !/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) errors.push(`${label}: Datum als YYYY-MM-DD`);
      if (fl.type === 'contact_field' && !isTemplate(s) && !/^[A-Za-z_][\w.]*$/.test(s)) errors.push(`${label}: kein gültiger Feldname (first_name, company, custom.xyz …)`);
      if (refKind) {
        const known = refList(refKind, env.refs);
        if (known && !isTemplate(s) && !known.some((k) => k.id === s)) {
          if (refKind === 'user') warnings.push(`${label}: Nutzer „${s}“ ist dem Team nicht bekannt`);
          else {
            errors.push(`${label}: ${REF_TITLES[refKind] ?? refKind}-ID „${s}“ gibt es in diesem Sub-Account nicht – nimm eine ID aus dem KONTEXT oder lass das Feld leer`);
            return null;
          }
        }
        if (refKind === 'stage' && env.refs.pipeline && sibling.pipeline_id) {
          const p = env.refs.pipeline.find((x) => x.id === sibling.pipeline_id);
          if (p && !p.stages.some((x) => x.id === s)) errors.push(`${label}: Stufe „${s}“ gehört nicht zur Pipeline „${p.name}“`);
        }
      }
      return s;
    }
    case 'number': {
      if (typeof raw === 'string' && isTemplate(raw)) return raw;
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        errors.push(`${label} muss eine Zahl sein`);
        return null;
      }
      if (fl.min !== undefined && n < fl.min) errors.push(`${label} muss mindestens ${fl.min} sein`);
      return n;
    }
    case 'bool': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).toLowerCase();
      if (['true', '1', 'ja', 'yes'].includes(s)) return true;
      if (['false', '0', 'nein', 'no'].includes(s)) return false;
      errors.push(`${label} muss true oder false sein`);
      return null;
    }
    case 'select': {
      const s = String(raw).trim();
      const hit = (fl.options ?? []).find((o) => o[0] === s) ?? (fl.options ?? []).find((o) => o[1].toLowerCase() === s.toLowerCase() || o[0].toLowerCase() === s.toLowerCase());
      if (!hit && !isTemplate(s)) {
        errors.push(`${label}: „${s}“ ist nicht erlaubt (erlaubt: ${(fl.options ?? []).map((o) => o[0]).join(', ')})`);
        return null;
      }
      return hit ? hit[0] : s;
    }
    case 'tags':
    case 'users':
    case 'social_channels': {
      const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((x) => str(x, 60)).filter(Boolean).slice(0, LIMITS.tags);
      if (!list.length && fl.required) errors.push(`${label} fehlt (Pflichtfeld)`);
      return [...new Set(list)];
    }
    case 'weekdays': {
      const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((x) => String(x).trim().toLowerCase().slice(0, 3));
      const bad = list.filter((d) => !WEEKDAYS.includes(d));
      if (bad.length) errors.push(`${label}: Wochentage als mon, tue, wed, thu, fri, sat, sun`);
      return list.filter((d) => WEEKDAYS.includes(d));
    }
    case 'conditions':
      return checkConditions(raw, label, errors, warnings);
    case 'rows': {
      if (!Array.isArray(raw)) {
        errors.push(`${label} muss eine Liste sein`);
        return null;
      }
      return raw.slice(0, 50).map((row: any, i) => {
        const out: Record<string, unknown> = {};
        for (const col of fl.rows ?? []) {
          const v = checkValue({ ...col, required: false }, row?.[col.key], `${label}, Zeile ${i + 1}`, env, out, errors, warnings);
          if (v !== null) out[col.key] = v;
        }
        return out;
      });
    }
    default:
      return typeof raw === 'object' ? raw : str(raw, LIMITS.text);
  }
}

/** The fields of a step or trigger config: unknown keys are dropped (with a hint), known ones cleaned. */
function checkFields(fields: AiField[], src: Record<string, any>, where: string, env: CheckEnv, errors: string[], warnings: string[], keep: string[] = []): Record<string, any> {
  const out: Record<string, any> = {};
  const effective = (key: string): unknown => src[key] ?? fields.find((x) => x.key === key)?.default;
  for (const fl of fields) {
    if (fl.showIf && !fl.showIf.in.includes(String(effective(fl.showIf.field) ?? ''))) continue;
    // pipeline first, so a stage can be checked against it
    const v = checkValue(fl, src[fl.key], where, env, out, errors, warnings);
    if (v !== null) out[fl.key] = v;
  }
  const known = new Set([...fields.map((x) => x.key), ...keep]);
  const dropped = Object.keys(src).filter((k) => !known.has(k));
  if (dropped.length) warnings.push(`${where}: ${dropped.slice(0, 5).join(', ')} wird nicht verwendet und wurde entfernt`);
  return out;
}

/** Cleans a step list recursively. */
function checkSteps(list: unknown, path: string, depth: number, env: CheckEnv, state: { n: number; ids: Set<string>; gotos: { id: string; key: string; value: string; where: string }[] }, errors: string[], warnings: string[]): Step[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    errors.push(`${path || 'steps'} muss eine Liste sein`);
    return [];
  }
  if (depth > LIMITS.depth) {
    errors.push(`${path}: zu tief verschachtelt (höchstens ${LIMITS.depth} Ebenen)`);
    return [];
  }
  const out: Step[] = [];
  list.forEach((raw: any, i) => {
    const where = `${path ? `${path} › ` : ''}Schritt ${i + 1}`;
    if (++state.n > LIMITS.steps) {
      if (state.n === LIMITS.steps + 1) errors.push(`Zu viele Schritte (höchstens ${LIMITS.steps})`);
      return;
    }
    const type = str(raw?.type, 60);
    if (!type) return void errors.push(`${where}: „type“ fehlt`);
    const action = env.actions.get(type);
    if (!action) return void errors.push(`${where}: Schritt-Typ „${type}“ gibt es im Katalog nicht${type.includes('.') ? ' (das sieht nach einem Auslöser aus)' : ''}`);
    const here = `${where} (${action.label})`;
    // `step.name` is the label the person gave the step
    const body = checkFields(action.fields, raw, here, env, errors, warnings, ['id', 'type', 'name', 'then', 'else', 'each', ...Array.from({ length: 5 }, (_, k) => `b${k}`)]);
    let sid = str(raw.id, 24).replace(/[^\w-]/g, '');
    if (!sid || state.ids.has(sid)) sid = newId(8);
    state.ids.add(sid);
    const step: Step = { ...body, id: sid, type } as Step;
    if (raw.name) step.name = str(raw.name, 120);
    for (const fl of action.fields) if (fl.type === 'step' && step[fl.key]) state.gotos.push({ id: sid, key: fl.key, value: String(step[fl.key]), where: here });
    for (const k of branchKeys(step)) step[k] = checkSteps(raw[k], `${where} › ${k === 'then' ? 'Dann' : k === 'else' ? 'Sonst' : k === 'each' ? 'Je Element' : `Pfad ${Number(k.slice(1)) + 1}`}`, depth + 1, env, state, errors, warnings);
    // a branch list the step does not own is dropped silently (cleanSteps does the same)
    out.push(step);
  });
  return out;
}

/** Checks the AI's answer against the catalogue. `workflow` is set only when there are no errors. */
export function checkWorkflow(raw: any, env: CheckEnv): Checked {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') return { summary: '', notes: [], errors: ['Die Antwort war kein JSON-Objekt'], warnings };
  const name = str(raw.name, 200);
  if (!name) errors.push('„name“ fehlt');
  const tType = str(raw.trigger?.type, 60);
  let trigger: WorkflowDraft['trigger'] | undefined;
  if (!tType) errors.push('„trigger.type“ fehlt');
  else {
    const meta = env.triggers.get(tType);
    if (!meta) errors.push(`Auslöser „${tType}“ gibt es im Katalog nicht${env.actions.has(tType) ? ' (das ist ein Schritt, kein Auslöser)' : ''}`);
    else {
      const cfg = raw.trigger?.config && typeof raw.trigger.config === 'object' && !Array.isArray(raw.trigger.config) ? raw.trigger.config : {};
      trigger = { type: tType, config: checkFields([...meta.fields, ...TRIGGER_COMMON], cfg, `Auslöser (${meta.label})`, env, errors, warnings) };
    }
  }
  const state = { n: 0, ids: new Set<string>(), gotos: [] as { id: string; key: string; value: string; where: string }[] };
  if (!Array.isArray(raw.steps) || !raw.steps.length) errors.push('„steps“ ist leer – ein Workflow braucht mindestens einen Schritt');
  const steps = checkSteps(raw.steps, '', 0, env, state, errors, warnings);
  for (const g of state.gotos) if (!state.ids.has(g.value)) errors.push(`${g.where}: Sprungziel „${g.value}“ ist kein Schritt dieses Workflows (der Zielschritt braucht eine „id“)`);
  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const settings = { allow_reentry: s.allow_reentry === true || s.allow_reentry === 'true', stop_on_error: s.stop_on_error === true || s.stop_on_error === 'true' };
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).map((n: unknown) => str(n, 300)).filter(Boolean).slice(0, 12);
  const summary = str(raw.summary, 1200);
  if (!summary) warnings.push('Die KI hat keine Zusammenfassung geliefert');
  if (errors.length || !trigger) return { summary, notes, errors, warnings };
  return { workflow: { name, trigger, steps, settings }, summary, notes, errors, warnings };
}

// --- diff -------------------------------------------------------------------------------------------------------------------

export interface StepDiff {
  id: string;
  type: string;
  label: string;
  path: string;
  status: 'added' | 'removed' | 'changed' | 'moved' | 'same';
  before?: Step;
  after?: Step;
  changes?: { key: string; before: unknown; after: unknown }[];
}
export interface Diff {
  name: { changed: boolean; before: string; after: string };
  trigger: { changed: boolean; before: unknown; after: unknown };
  settings: { changed: boolean; before: unknown; after: unknown };
  steps: StepDiff[];
  counts: { added: number; removed: number; changed: number; moved: number; same: number };
}

const strip = (s: Step) => {
  const { id: _id, then: _t, else: _e, each: _each, ...rest } = s as Record<string, any>;
  for (const k of Object.keys(rest)) if (/^b\d+$/.test(k)) delete rest[k];
  return rest;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pathKey = (cur: (number | string)[]) => cur.join('/');

/**
 * Gives steps the AI wrote without their old id that id back when type and position agree, so a changed step stays "changed"
 * (and keeps its identity in the version history) instead of showing up as removed + added.
 */
export function reconcileIds(before: Step[], after: Step[]): void {
  const old = walk(before);
  const next = walk(after);
  const oldIds = new Set(old.map((o) => o.step.id));
  const nextIds = new Set(next.map((n) => n.step.id));
  const free = old.filter((o) => !nextIds.has(o.step.id));
  for (const n of next) {
    if (oldIds.has(n.step.id)) continue;
    const m = free.find((o) => o.step.type === n.step.type && pathKey(o.cursor) === pathKey(n.cursor));
    if (!m) continue;
    // goto targets that pointed at the new id follow
    const from = n.step.id;
    for (const x of next) for (const k of Object.keys(x.step)) if (x.step[k] === from && k !== 'id') x.step[k] = m.step.id;
    n.step.id = m.step.id;
    free.splice(free.indexOf(m), 1);
  }
}

export function diffWorkflows(before: WorkflowDraft | null, after: WorkflowDraft, labelOf: (type: string) => string): Diff {
  const old = new Map(walk(before?.steps ?? []).map((o) => [o.step.id, o]));
  const steps: StepDiff[] = [];
  const seen = new Set<string>();
  for (const n of walk(after.steps)) {
    seen.add(n.step.id);
    const o = old.get(n.step.id);
    const base = { id: n.step.id, type: n.step.type, label: String(n.step.name || labelOf(n.step.type)), path: pathKey(n.cursor) };
    if (!o) {
      steps.push({ ...base, status: 'added', after: n.step });
      continue;
    }
    const a = strip(o.step);
    const b = strip(n.step);
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k]));
    const moved = pathKey(o.cursor) !== base.path;
    steps.push({ ...base, status: keys.length ? 'changed' : moved ? 'moved' : 'same', before: o.step, after: n.step, ...(keys.length ? { changes: keys.map((key) => ({ key, before: a[key], after: b[key] })) } : {}) });
  }
  for (const [sid, o] of old) if (!seen.has(sid)) steps.push({ id: sid, type: o.step.type, label: String(o.step.name || labelOf(o.step.type)), path: pathKey(o.cursor), status: 'removed', before: o.step });
  const count = (s: StepDiff['status']) => steps.filter((x) => x.status === s).length;
  return {
    name: { changed: !!before && before.name !== after.name, before: before?.name ?? '', after: after.name },
    trigger: { changed: !!before && !same(before.trigger, after.trigger), before: before?.trigger ?? null, after: after.trigger },
    settings: { changed: !!before && !same(before.settings, after.settings), before: before?.settings ?? null, after: after.settings },
    steps,
    counts: { added: count('added'), removed: count('removed'), changed: count('changed'), moved: count('moved'), same: count('same') },
  };
}

/** The prompt of a retry: what was wrong with the last answer. */
export function retryPrompt(base: string, previous: string, errors: string[]): string {
  return `${base}\n\nDEIN LETZTER ENTWURF WAR NICHT GÜLTIG:\n${previous.slice(0, 14_000)}\n\nFEHLER:\n${errors.slice(0, 15).map((e) => `- ${e}`).join('\n')}\n\nKorrigiere genau diese Punkte und gib den VOLLSTÄNDIGEN Workflow erneut als ein JSON-Objekt aus.`;
}
