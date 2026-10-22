import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { bad, notFound } from '../core/http.js';
import { now } from '../core/util.js';
import { CUSTOM_OBJECT_RE, STANDARD_PROPS, companyDomain, validateProps, ValueError, type PropertyDef } from '../services/objects.js';
import { cleanCloseDate, cleanCurrency, createOpportunity, getPipeline, updateOpportunity } from '../services/opportunities.js';
import type { FormField } from '../services/form-fields.js';
import { createCompany, findCompanyByDomain, findCompanyByName, getCompany, updateCompany } from './companies.js';
import { createRecord, getRecord, objectType, updateRecord } from './custom-objects.js';
import type { AssociationsService } from './associations.js';
import type { ObjectSchema } from './object-schema.js';
import type { Tool } from './mcp.js';
import type { Plan } from './forms.js';

/**
 * Form fields that write to a company, a deal (opportunity) or a custom object – not only to the contact (HighLevel parity,
 * docs/forms.md#field-mapping). The mapping lives with the form in `settings.mapping`:
 *
 *   { fields: { <field id>: { target: 'company' | 'opportunity' | 'object', key, object? } },
 *     deal?: { mode: 'new' | 'open', pipeline_id, stage_id }, objects?: { <object key>: { mode: 'new' | 'linked' } }, overwrite? }
 *
 * `key` is a standard field from a whitelist (COMPANY_KEYS, DEAL_KEYS) or `custom.<key>` of a property (Einstellungen →
 * Eigenschaften); for a custom object it is the property key. Everything else – owner, status, stage, lifecycle phase, ids,
 * external ids – is protected: a form never sets it (refused at save, ignored at submit). The forms module calls three hooks
 * (`app.services.formMapping`): `clean` when a form is saved, `check` before anything of a submission is written (a wrong value is a
 * 400 for the visitor), `apply` once the contact exists. Every write goes through the normal company/deal/record functions, so
 * the created/updated events, the activity log and the unique checks apply unchanged; the sub-account is the form's own and every
 * pipeline, object type and property is looked up in it again at submit time (a copied form cannot reach another sub-account).
 * Existing records keep stored values unless the form says `overwrite` – an anonymous visitor fills gaps, he does not rewrite data.
 */

export type MapTarget = 'company' | 'opportunity' | 'object';
export interface FieldMap {
  target: MapTarget;
  key: string;
  /** Custom object key (p_…), only for target object. */
  object?: string;
}
export interface FormMapping {
  fields: Record<string, FieldMap>;
  deal?: { mode: 'new' | 'open'; pipeline_id: string; stage_id: string };
  objects?: Record<string, { mode: 'new' | 'linked' }>;
  overwrite?: boolean;
}

/** Standard columns a form may write (everything else is protected). */
export const COMPANY_KEYS = ['name', 'domain', 'industry', 'size', 'phone', 'website', 'address', 'postal_code', 'city', 'country', 'description'] as const;
export const DEAL_KEYS = ['name', 'value', 'currency', 'expected_close_date', 'source'] as const;
/**
 * Contact columns a public form may fill through a field's key (`name`). The owner (`assigned_to`) is the team's: a visitor could
 * otherwise hand a lead to anyone (also through a hidden field – its value comes from the page). Refused at save, skipped and noted
 * (meta.mapping.errors) at submit for forms that already have it. The lead source stays allowed: it is attribution like the UTM values,
 * and the landing page and the cloud waitlist set it through a hidden field.
 */
export const CONTACT_FORM_KEYS = ['first_name', 'last_name', 'name', 'email', 'phone', 'company', 'address', 'city', 'postal_code', 'country', 'website', 'date_of_birth', 'source'] as const;
export const PROTECTED_CONTACT_KEYS = ['assigned_to'] as const;
export const isProtectedContactKey = (name: string) => (PROTECTED_CONTACT_KEYS as readonly string[]).includes(name);
/** Save check of the contact targets: throws a German message for a field that writes to a protected contact column. */
export function checkContactFields(fields: FormField[]): void {
  for (const f of fields) if (isProtectedContactKey(f.name)) throw bad(`„${f.label || f.name}“: Kontakt-Feld „${f.name}“ ist geschützt – ein Formular kann es nicht setzen`);
}

/** Named on purpose so a refusal can say why. */
const PROTECTED = ['id', 'location_id', 'owner_id', 'assigned_to', 'lifecycle_stage', 'status', 'stage_id', 'pipeline_id', 'contact_id', 'lost_reason', 'external_id', 'external_source', 'created_at', 'updated_at', 'stage_changed_at', 'closed_at', 'custom', 'properties', 'display', 'type_id'];
/** Property types a visitor cannot fill (a team member, an uploaded file). */
const NO_FORM_TYPES = ['user', 'file'];
/** Field types without an answer that could go anywhere. */
const NO_ANSWER = ['heading', 'page_break', 'payment', 'file', 'signature'];
const TARGET_LABEL: Record<MapTarget, string> = { company: 'Firma', opportunity: 'Deal', object: 'Objekt' };

const schema = (app: App): ObjectSchema => app.services.objectSchema;
const assoc = (app: App): AssociationsService => app.services.associations;
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

/** Who a key belongs to: a standard column, a custom property (with its definition) or nothing a form may write. */
function resolveKey(app: App, loc: string, target: MapTarget, key: string, object?: string): { std?: string; def?: PropertyDef; label: string } | string {
  if (target === 'object') {
    const t = object && CUSTOM_OBJECT_RE.test(object) ? objectType(app, loc, object) : undefined;
    if (!t) return 'das Objekt gibt es in diesem Sub-Account nicht';
    const def = schema(app).defs(loc, t.key).find((d) => d.key === key);
    if (!def) return `die Eigenschaft „${key}“ gibt es bei ${t.singular} nicht`;
    if (NO_FORM_TYPES.includes(def.type)) return `„${def.label}“ (${def.type === 'user' ? 'Nutzer' : 'Datei'}) kann ein Formular nicht setzen`;
    return { def, label: `${t.singular}: ${def.label}` };
  }
  const obj = target;
  if (key.startsWith('custom.')) {
    const def = schema(app).defs(loc, obj).find((d) => d.key === key.slice(7));
    if (!def) return `die Eigenschaft „${key.slice(7)}“ gibt es nicht`;
    if (NO_FORM_TYPES.includes(def.type)) return `„${def.label}“ (${def.type === 'user' ? 'Nutzer' : 'Datei'}) kann ein Formular nicht setzen`;
    return { def, label: `${TARGET_LABEL[target]}: ${def.label}` };
  }
  const allowed: readonly string[] = target === 'company' ? COMPANY_KEYS : DEAL_KEYS;
  if (!allowed.includes(key)) return PROTECTED.includes(key) || STANDARD_PROPS[obj]?.some((p) => p.key === key) ? `„${key}“ ist geschützt – ein Formular kann es nicht setzen` : `das Feld „${key}“ gibt es nicht`;
  return { std: key, label: `${TARGET_LABEL[target]}: ${STANDARD_PROPS[obj]?.find((p) => p.key === key)?.label ?? key}` };
}

/**
 * The editor's mapping → what is stored. Throws a German message for anything that cannot work (strict, when the mapping itself is
 * sent); `lenient` (the fields changed, the mapping was not sent) drops what no longer fits instead. Returns undefined for "none".
 */
export function cleanMapping(app: App, loc: string, input: any, fields: FormField[], opts: { lenient?: boolean; legacyPipeline?: string; legacyStage?: string } = {}): FormMapping | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const fail = (msg: string) => {
    if (!opts.lenient) throw bad(`Zuordnung: ${msg}`);
  };
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: FormMapping = { fields: {} };
  const entries = Object.entries(input.fields && typeof input.fields === 'object' ? input.fields : {}).slice(0, 100);
  for (const [fid, raw] of entries) {
    const m = raw as any;
    if (!m || !m.target) continue;
    const f = byId.get(fid);
    if (!f) continue; // the field was removed
    const label = f.label || f.name;
    if (NO_ANSWER.includes(f.type)) {
      fail(`„${label}“ hat keine Antwort, die gespeichert werden kann`);
      continue;
    }
    const target = String(m.target) as MapTarget;
    if (!['company', 'opportunity', 'object'].includes(target)) {
      fail(`„${label}“: unbekanntes Ziel`);
      continue;
    }
    const key = String(m.key ?? '').trim().slice(0, 70);
    const object = target === 'object' ? String(m.object ?? '').trim().slice(0, 50) : undefined;
    const r = resolveKey(app, loc, target, key, object);
    if (typeof r === 'string') {
      fail(`„${label}“: ${r}`);
      continue;
    }
    out.fields[f.id] = { target, key, ...(object ? { object } : {}) };
  }
  const list = Object.values(out.fields);
  if (!list.length) return undefined;
  // Two fields into the same target field: the second would silently win.
  const seen = new Set<string>();
  for (const [fid, m] of Object.entries(out.fields)) {
    const k = `${m.target}:${m.object ?? ''}:${m.key}`;
    if (seen.has(k)) {
      fail(`zwei Felder schreiben in dasselbe Ziel (${resolveLabel(app, loc, m)})`);
      delete out.fields[fid];
    }
    seen.add(k);
  }
  if (list.some((m) => m.target === 'opportunity')) {
    const d = input.deal ?? {};
    const pid = String(d.pipeline_id || opts.legacyPipeline || '');
    const p = pid ? getPipeline(app, loc, pid) : undefined;
    if (!p) {
      fail('für Deal-Felder bitte eine Pipeline wählen');
      for (const [fid, m] of Object.entries(out.fields)) if (m.target === 'opportunity') delete out.fields[fid];
    } else {
      const sid = String(d.stage_id || (d.pipeline_id ? '' : opts.legacyStage) || '');
      const stage = p.stages.find((s: any) => s.id === sid) ?? p.stages[0];
      if (sid && stage?.id !== sid) fail('die Stufe gehört nicht zur Pipeline');
      out.deal = { mode: d.mode === 'open' ? 'open' : 'new', pipeline_id: p.id, stage_id: stage?.id ?? '' };
    }
  }
  const objs = [...new Set(Object.values(out.fields).filter((m) => m.target === 'object').map((m) => m.object!))];
  if (objs.length) out.objects = Object.fromEntries(objs.map((o) => [o, { mode: input.objects?.[o]?.mode === 'linked' ? ('linked' as const) : ('new' as const) }]));
  // A new record needs every required property: say so at save, not at the first submission.
  if (!opts.lenient) {
    const need = (obj: string, mapped: string[], what: string) => {
      for (const d of schema(app).defs(loc, obj)) if (d.required && !mapped.includes(d.key)) fail(`${what}: die Pflicht-Eigenschaft „${d.label}“ fehlt in der Zuordnung`);
    };
    const keysOf = (target: MapTarget, object?: string) => Object.values(out.fields).filter((m) => m.target === target && m.object === object).map((m) => (target === 'object' ? m.key : m.key.replace(/^custom\./, '')));
    if (list.some((m) => m.target === 'company')) need('company', keysOf('company'), 'Firma');
    if (out.deal) need('opportunity', keysOf('opportunity'), 'Deal');
    for (const o of objs) need(o, keysOf('object', o), objectType(app, loc, o)?.singular ?? o);
  }
  if (!Object.keys(out.fields).length) return undefined;
  if (input.overwrite) out.overwrite = true;
  return out;
}

function resolveLabel(app: App, loc: string, m: FieldMap): string {
  const r = resolveKey(app, loc, m.target, m.key, m.object);
  return typeof r === 'string' ? `${TARGET_LABEL[m.target]}: ${m.key}` : r.label;
}

/** The mapping in words (editor list, agent tools): field → target. */
export function describeMapping(app: App, form: { location_id: string; fields: FormField[]; settings?: any }) {
  const m: FormMapping | undefined = form.settings?.mapping;
  if (!m?.fields) return [];
  return Object.entries(m.fields).flatMap(([fid, x]) => {
    const f = form.fields.find((y) => y.id === fid);
    return f ? [{ field_id: fid, field: f.label || f.name, target: x.target, object: x.object, key: x.key, label: resolveLabel(app, form.location_id, x) }] : [];
  });
}

/** Compact for list tools: how many fields go where. */
export function mappingSummary(settings: any): Record<string, number> | undefined {
  const m: FormMapping | undefined = settings?.mapping;
  if (!m?.fields) return undefined;
  const out: Record<string, number> = {};
  for (const x of Object.values(m.fields)) {
    const k = x.target === 'object' ? x.object! : x.target;
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.keys(out).length ? out : undefined;
}

// --- submissions ----------------------------------------------------------------------------------------------------------------------

interface Bucket {
  std: Record<string, unknown>;
  custom: Record<string, unknown>;
}
interface Prepared {
  company?: Bucket;
  deal?: Bucket;
  objects: Record<string, Record<string, unknown>>;
  skipped: string[];
}
const prepared = new WeakMap<Plan, Prepared>();

const asText = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));
function germanNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[€\s]/g, '');
  // German notation: 1.500,50 and 1.500 (dots group thousands)
  if (s.includes(',') || /^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) throw bad('Bitte eine Zahl angeben');
  return n;
}

/** Answer of a field for a mapping (choices as a list for multi-select properties, text otherwise). */
function answerOf(plan: Plan, f: FormField, def?: PropertyDef): unknown {
  if (f.type === 'calculator') return plan.calculators[f.id];
  const v = f.type === 'hidden' ? plan.raw[f.name] : plan.cleaned.get(f.id);
  if (isEmpty(v)) return undefined;
  if (def?.type === 'multiselect') return Array.isArray(v) ? v : String(v).split(/,\s*/);
  if (def?.type === 'checkbox') return Array.isArray(v) ? v.length > 0 : v;
  return f.type === 'hidden' ? asText(v).slice(0, 2000) : asText(v);
}

/** Before anything is written: every mapped answer is checked against its target (a wrong number is a 400 for the visitor). */
export function checkSubmission(app: App, form: any, plan: Plan): void {
  const m: FormMapping | undefined = form.settings?.mapping;
  if (!m?.fields || !Object.keys(m.fields).length) return;
  const loc = form.location_id;
  const tz = app.location(loc)?.timezone || 'Europe/Berlin';
  const out: Prepared = { objects: {}, skipped: [] };
  const reached = new Map(plan.reached.map((f) => [f.id, f]));
  for (const [fid, x] of Object.entries(m.fields)) {
    const f = reached.get(fid);
    if (!f || NO_ANSWER.includes(f.type)) continue;
    // Looked up again in the form's own sub-account: a copied form or a deleted property is skipped, never written elsewhere.
    const r = resolveKey(app, loc, x.target, x.key, x.object);
    if (typeof r === 'string') {
      out.skipped.push(`${f.label || f.name}: ${r}`);
      continue;
    }
    const v = answerOf(plan, f, r.def);
    if (v === undefined) continue;
    const what = f.label || f.name;
    if (r.def) {
      try {
        const val = validateProps([{ ...r.def, required: false }], { [r.def.key]: v }, { partial: true, tz })[r.def.key];
        if (val === null) continue;
        if (x.target === 'object') (out.objects[x.object!] ??= {})[r.def.key] = val;
        else ((x.target === 'company' ? (out.company ??= { std: {}, custom: {} }) : (out.deal ??= { std: {}, custom: {} })).custom[r.def.key] = val);
      } catch (e) {
        if (e instanceof ValueError) throw bad(`„${what}“: ${e.message.replace(/^„[^“]*“:?\s*/, '')}`);
        throw e;
      }
      continue;
    }
    const key = r.std!;
    let val: unknown = v;
    if (x.target === 'opportunity') {
      try {
        if (key === 'value') val = Math.round(germanNumber(v));
        if (key === 'expected_close_date') val = cleanCloseDate(String(v).slice(0, 10));
        if (key === 'currency') val = cleanCurrency(v);
        if (key === 'name' || key === 'source') val = asText(v).slice(0, 200);
        if (val === null) continue;
      } catch (e) {
        throw bad(`„${what}“: ${(e as Error).message.replace(/^[^:]*:\s*/, '')}`);
      }
      (out.deal ??= { std: {}, custom: {} }).std[key] = val;
    } else (out.company ??= { std: {}, custom: {} }).std[key] = asText(v);
  }
  prepared.set(plan, out);
}

/** Only what fills a gap, unless the form overwrites. */
const fillOnly = (cur: Record<string, unknown>, patch: Record<string, unknown>, overwrite: boolean) =>
  Object.fromEntries(Object.entries(patch).filter(([k, v]) => !isEmpty(v) && (overwrite || isEmpty(cur?.[k]) || (k === 'value' && !Number(cur?.[k])))));

export interface MappingResult {
  company_id?: string;
  opportunity_id?: string;
  records?: { object: string; id: string; created: boolean }[];
  errors?: string[];
  /** A deal was created or updated by the mapping: the form's plain "create opportunity" setting does not add a second one. */
  dealHandled?: boolean;
}

/** Writes the checked values once the contact exists. A failing target is noted (submission meta, server log), never a lost lead. */
export function applySubmission(app: App, form: any, plan: Plan, contactId: string): MappingResult | undefined {
  const p = prepared.get(plan);
  const m: FormMapping | undefined = form.settings?.mapping;
  if (!p || !m) return undefined;
  const loc = form.location_id;
  const overwrite = !!m.overwrite;
  const source = `Formular: ${form.name}`.slice(0, 80);
  const contact = { type: 'contact', id: contactId };
  const res: MappingResult = {};
  const errors = [...p.skipped];
  const attempt = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      errors.push(`${what}: ${(e as Error).message}`);
    }
  };
  if (p.company && (Object.keys(p.company.std).length || Object.keys(p.company.custom).length)) {
    const c = p.company;
    attempt('Firma', () => {
      const prim = assoc(app).primary(loc, contact, 'company');
      let cur = prim ? getCompany(app, loc, prim) : undefined;
      const dom = companyDomain(c.std.domain || c.std.website || '');
      if (!cur && dom) cur = findCompanyByDomain(app, loc, dom);
      if (!cur && c.std.name) cur = findCompanyByName(app, loc, String(c.std.name));
      if (cur) {
        const patch: Record<string, any> = fillOnly(cur, c.std, overwrite);
        const custom = fillOnly(cur.custom ?? {}, c.custom, overwrite);
        if (Object.keys(custom).length) patch.custom = custom;
        if (Object.keys(patch).length) updateCompany(app, loc, cur.id, patch, { source });
      } else cur = createCompany(app, loc, { ...c.std, custom: c.custom }, { source });
      if (!assoc(app).ids(loc, contact, 'company').includes(cur.id)) assoc(app).link(loc, contact, { type: 'company', id: cur.id });
      res.company_id = cur.id;
    });
  }
  if (p.deal && m.deal) {
    const d = p.deal;
    const cfg = m.deal;
    attempt('Deal', () => {
      const pipe = getPipeline(app, loc, cfg.pipeline_id);
      if (!pipe) throw new Error('Pipeline nicht gefunden');
      const open =
        cfg.mode === 'open' ? app.db.get('SELECT * FROM opportunities WHERE location_id = ? AND contact_id = ? AND pipeline_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 1', loc, contactId, pipe.id, 'open') : undefined;
      let opp: any;
      if (open) {
        const patch = fillOnly(open, d.std, overwrite);
        opp = Object.keys(patch).length ? updateOpportunity(app, loc, open.id, patch) : open;
      } else opp = createOpportunity(app, loc, { pipeline_id: pipe.id, stage_id: cfg.stage_id, contact_id: contactId, source, ...(d.std as any) });
      res.opportunity_id = opp.id;
      res.dealHandled = true;
      const changed = Object.keys(open ? fillOnly(open, d.std, overwrite) : {});
      if (Object.keys(d.custom).length) {
        const cur = parseJson(app.db.get('SELECT props FROM record_props WHERE object_key = ? AND record_id = ?', 'opportunity', opp.id), ['props'])?.props ?? {};
        const patch = schema(app).validate(loc, 'opportunity', open ? fillOnly(cur, d.custom, overwrite) : d.custom, { partial: true, current: cur, recordId: opp.id });
        const next = { ...cur, ...patch };
        app.db.run(
          `INSERT INTO record_props (location_id, object_key, record_id, props, updated_at) VALUES (?, 'opportunity', ?, ?, ?)
           ON CONFLICT(object_key, record_id) DO UPDATE SET props = excluded.props, updated_at = excluded.updated_at`,
          loc,
          opp.id,
          JSON.stringify(next),
          now(),
        );
        app.db.run('UPDATE opportunities SET updated_at = ? WHERE id = ?', now(), opp.id);
        changed.push(...Object.keys(patch).map((k) => `custom.${k}`));
      }
      if (open && changed.length) {
        schema(app).log(loc, 'opportunity', opp.id, 'opportunity.updated', `Aus ${source} ergänzt: ${changed.join(', ')}`.slice(0, 480), { changed });
        app.events.emit(loc, 'opportunity.updated', { contactId, opportunity: app.db.get('SELECT * FROM opportunities WHERE id = ?', opp.id), changed, source: 'form' });
      }
    });
  }
  for (const [key, props] of Object.entries(p.objects)) {
    attempt(key, () => {
      const t = objectType(app, loc, key);
      if (!t || t.key !== key) throw new Error('Objekt nicht gefunden');
      const mode = m.objects?.[key]?.mode ?? 'new';
      const linked = new Set(assoc(app).ids(loc, contact, t.key));
      // A unique value that already exists: the record is updated only when it belongs to this contact.
      let target: any;
      for (const d of schema(app).defs(loc, t.key).filter((x) => x.unique)) {
        const v = props[d.key];
        if (isEmpty(v)) continue;
        const hit = app.db.get(`SELECT id FROM object_records WHERE type_id = ? AND lower(CAST(json_extract(properties, '$.${d.key}') AS TEXT)) = lower(?) LIMIT 1`, t.id, String(v).trim());
        if (hit && !linked.has(hit.id)) throw new Error(`„${d.label}“ „${String(v).slice(0, 60)}“ gehört zu einem anderen Datensatz – nicht geändert`);
        if (hit) target = getRecord(app, loc, t.id, hit.id);
      }
      if (!target && mode === 'linked' && linked.size) {
        const last = app.db.get(`SELECT id FROM object_records WHERE type_id = ? AND location_id = ? AND id IN (${[...linked].map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 1`, t.id, loc, ...linked);
        if (last) target = getRecord(app, loc, t.id, last.id);
      }
      let rec: any;
      let created = false;
      if (target) {
        const patch = fillOnly(target.properties ?? {}, props, overwrite);
        rec = Object.keys(patch).length ? updateRecord(app, loc, t, target.id, { properties: patch }) : target;
      } else {
        rec = createRecord(app, loc, t, { properties: props });
        created = true;
      }
      if (!linked.has(rec.id)) assoc(app).link(loc, contact, { type: t.key, id: rec.id });
      (res.records ??= []).push({ object: t.key, id: rec.id, created });
    });
  }
  if (errors.length) {
    res.errors = errors.map((e) => e.slice(0, 300));
    console.warn(`[form-mapping] ${form.id}:`, res.errors.join(' | '));
  }
  return Object.keys(res).length ? res : undefined;
}

// --- editor data, agent tool --------------------------------------------------------------------------------------------------------

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
export const FORM_MAPPING_TOOLS: Tool[] = [
  {
    name: 'ghl_form_mapping',
    title: 'Formular-Zuordnung (Firma, Deal, Objekt)',
    description:
      'Wohin die Felder eines Formulars schreiben, außer in den Kontakt: Firma, Deal (mit Pipeline/Stufe, neu oder offener Deal des Kontakts) oder eigenes Objekt. Nur lesen – ändern im Formular-Editor oder per PATCH /api/forms/:id (settings.mapping).',
    inputSchema: { type: 'object', properties: { ...LOC, form_id: { type: 'string', description: 'Formular-ID (aus ghl_list_forms)' } }, required: ['form_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const r = await call.api('GET', `/api/forms/${encodeURIComponent(a.form_id)}/mapping`, { location: a.location_id });
      return { form_id: a.form_id, fields: r?.fields ?? [], deal: r?.mapping?.deal ?? null, objects: r?.mapping?.objects ?? null, overwrite: !!r?.mapping?.overwrite };
    },
  },
];

export const formMappingModule: Module = {
  name: 'form-mapping',
  register(app) {
    app.services.formMapping = {
      clean: (loc: string, input: unknown, fields: FormField[], opts?: { lenient?: boolean; legacyPipeline?: string; legacyStage?: string }) => cleanMapping(app, loc, input, fields, opts),
      check: (form: any, plan: Plan) => checkSubmission(app, form, plan),
      apply: (form: any, plan: Plan, contactId: string) => applySubmission(app, form, plan, contactId),
    };
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...FORM_MAPPING_TOOLS];

    /** The form's mapping in words plus everything the picker offers in this sub-account (standard fields, properties, objects, pipelines). */
    app.router.get('/api/forms/:id/mapping', 'location', (ctx) => {
      const f = parseJson(app.db.get('SELECT * FROM forms WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['fields', 'settings']);
      if (!f) throw notFound();
      const loc = ctx.locationId;
      const S = schema(app);
      const props = (obj: string) => S.defs(loc, obj).filter((d) => !NO_FORM_TYPES.includes(d.type)).map((d) => ({ key: d.key, label: d.label, type: d.type, required: d.required }));
      const std = (obj: string, keys: readonly string[]) => keys.map((k) => ({ key: k, label: STANDARD_PROPS[obj]?.find((p) => p.key === k)?.label ?? k }));
      return {
        mapping: f.settings?.mapping ?? null,
        fields: describeMapping(app, f as any),
        targets: {
          company: [...std('company', COMPANY_KEYS), ...props('company').map((p) => ({ ...p, key: `custom.${p.key}` }))],
          opportunity: [...std('opportunity', DEAL_KEYS), ...props('opportunity').map((p) => ({ ...p, key: `custom.${p.key}` }))],
          objects: S.objects(loc)
            .filter((o) => !o.builtin && CUSTOM_OBJECT_RE.test(o.key))
            .map((o) => ({ key: o.key, label: o.label, properties: props(o.key) })),
          pipelines: app.db.all('SELECT id, name, stages FROM pipelines WHERE location_id = ? ORDER BY position IS NULL, position, created_at', loc).map((p: any) => ({ id: p.id, name: p.name, stages: (JSON.parse(p.stages || '[]') as any[]).map((s) => ({ id: s.id, name: s.name })) })),
        },
      };
    });
  },
};
