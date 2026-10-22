import type { App } from '../../core/app.js';
import { bad, type Ctx, type User } from '../../core/http.js';
import { requiredPermission } from '../../core/permissions.js';
import { callRoute } from '../mobile.js';
import { backgroundContext } from './bridge.js';

/**
 * Stage 1 „Einrichtung“: a wish that existing building blocks can fulfil – workflows, custom fields and
 * objects, reports and dashboards, custom AI agents, templates, forms, pipelines – without writing code.
 * The AI proposes steps from this catalogue; nothing outside it can be named. Every step is one regular API
 * route run in-process as the requester (guards, member areas, SaaS plan, audit log), always in the
 * requester's own sub-account. Workflows are created as drafts, agents private and without automation, so a
 * build never starts sending anything by itself.
 */

type P = Record<string, any>;
export interface BlockCall {
  method: 'POST';
  path: string;
  body: P;
}
export interface BlockDef {
  label: string;
  /** Parameter reference for the AI prompt (German, with an example). */
  doc: string;
  build: (p: P) => BlockCall;
  /** What the route returned → one line for the result list. */
  result: (r: any, p: P) => { id: string; name: string; url?: string };
  /** DELETE route that removes what the step created (undo). */
  undo: (id: string) => string;
  /** A hint shown in the plan ("wird als Entwurf angelegt"). */
  note?: string;
}

const str = (v: unknown, field: string, max = 200, required = true): string => {
  const s = String(v ?? '').trim();
  if (required && !s) throw bad(`„${field}“ fehlt.`);
  return s.slice(0, max);
};
const obj = (v: unknown, field: string): P => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`„${field}“ muss ein Objekt sein.`);
  return v as P;
};
const list = (v: unknown, field: string, max: number, required = false): any[] => {
  if (v === undefined || v === null) {
    if (required) throw bad(`„${field}“ fehlt.`);
    return [];
  }
  if (!Array.isArray(v)) throw bad(`„${field}“ muss eine Liste sein.`);
  return v.slice(0, max);
};
const textList = (v: unknown, field: string, max = 50) => list(v, field, max).map((x) => String(x).slice(0, 100));
const idOf = (r: any) => String(r?.id ?? r?.key ?? '');

export const BLOCKS: Record<string, BlockDef> = {
  workflow: {
    label: 'Automation (Workflow)',
    note: 'wird als Entwurf angelegt – du schaltest sie nach dem Prüfen selbst ein',
    doc: 'workflow: { name, trigger:{type, config?}, steps:[{type, …}] } – Auslöser z. B. form.submitted, contact.tag_added (config {tag}), appointment.booked, opportunity.status_changed (config {status}), task.completed. Schritte: add_tag {tags:[]}, remove_tag, create_task {title, due_in_days}, add_note {body}, notify {subject, body}, send_email {subject, body}, send_sms {body}, wait {amount, unit:"minutes|hours|days"}, create_opportunity, update_field {field, value}. Platzhalter: {{contact.first_name|du}}, {{location.name}}. Beispiel: {"name":"Neuer Lead: Aufgabe","trigger":{"type":"form.submitted","config":{}},"steps":[{"type":"add_tag","tags":["lead"]},{"type":"create_task","title":"{{contact.name}} anrufen","due_in_days":1}]}',
    build: (p) => ({ method: 'POST', path: '/api/workflows', body: { name: str(p.name, 'name', 120), trigger: obj(p.trigger, 'trigger'), steps: list(p.steps, 'steps', 100, true), settings: p.settings && typeof p.settings === 'object' ? p.settings : undefined } }),
    result: (r) => ({ id: idOf(r), name: String(r?.name ?? ''), url: `workflows/${idOf(r)}` }),
    undo: (id) => `/api/workflows/${id}`,
  },
  custom_field: {
    label: 'Eigenes Kontaktfeld',
    doc: 'custom_field: { label, key? (a-z0-9_), type: text|textarea|number|date|select|checkbox|email|phone|url, options?:[…] für select } – Beispiel: {"label":"Budget","type":"number"}',
    build: (p) => ({ method: 'POST', path: '/api/custom-fields', body: { label: str(p.label, 'label', 100), ...(p.key ? { key: str(p.key, 'key', 60) } : {}), type: str(p.type || 'text', 'type', 20), options: textList(p.options, 'options') } }),
    result: (r) => ({ id: idOf(r), name: String(r?.label ?? '') }),
    undo: (id) => `/api/custom-fields/${id}`,
  },
  object_type: {
    label: 'Eigenes Objekt',
    doc: 'object_type: { singular, plural?, icon?, description?, properties:[{key (a-z0-9_), label, type: text|textarea|number|date|select|checkbox|email|phone|url, options?:[…]}] } – Beispiel: {"singular":"Projekt","plural":"Projekte","properties":[{"key":"budget","label":"Budget","type":"number"},{"key":"status","label":"Status","type":"select","options":["Geplant","Läuft","Fertig"]}]}',
    build: (p) => ({ method: 'POST', path: '/api/object-types', body: { singular: str(p.singular, 'singular', 60), ...(p.plural ? { plural: str(p.plural, 'plural', 60) } : {}), ...(p.icon ? { icon: str(p.icon, 'icon', 30) } : {}), ...(p.description ? { description: str(p.description, 'description', 500) } : {}), properties: list(p.properties, 'properties', 50).map((x) => obj(x, 'properties[]')) } }),
    result: (r) => ({ id: idOf(r), name: String(r?.plural ?? r?.singular ?? ''), url: `objects/${String(r?.key ?? '')}` }),
    undo: (id) => `/api/object-types/${id}`,
  },
  property: {
    label: 'Eigenschaft an Kontakt/Firma/Objekt',
    doc: 'property: { object: "contact"|"company"|"p_<objekt>", key, label, type, options?:[…] } – Beispiel: {"object":"company","key":"umsatz","label":"Jahresumsatz","type":"number"}',
    build: (p) => ({ method: 'POST', path: '/api/properties', body: { object: str(p.object, 'object', 60), key: str(p.key, 'key', 60), label: str(p.label, 'label', 100), type: str(p.type || 'text', 'type', 20), options: textList(p.options, 'options') } }),
    result: (r) => ({ id: idOf(r), name: String(r?.label ?? '') }),
    undo: (id) => `/api/properties/${id}`,
  },
  report: {
    label: 'Bericht',
    doc: 'report: { name, description?, viz: table|bar|line|pie|kpi, query:{source, measures:["count"|"sum:feld"|"avg:feld"], group_by?:["feld" oder "created_at:month"], filters?:[], range?:"last_30_days"|"last_month"|"this_year"|"all"} } – Quellen z. B. contacts, opportunities, tasks, tickets, invoices (genaue Felder liefert das Werkzeug create_report_from_question). Beispiel: {"name":"Leads je Quelle","viz":"bar","query":{"source":"contacts","measures":["count"],"group_by":["source"],"range":"last_30_days"}}',
    build: (p) => ({ method: 'POST', path: '/api/reports/library', body: { name: str(p.name, 'name', 120), description: str(p.description, 'description', 1000, false), config: { viz: str(p.viz || 'table', 'viz', 20), query: obj(p.query, 'query') }, visibility: 'private' } }),
    result: (r) => ({ id: idOf(r), name: String(r?.name ?? ''), url: `reports/r/${idOf(r)}` }),
    undo: (id) => `/api/reports/library/${id}`,
  },
  dashboard: {
    label: 'Dashboard',
    doc: 'dashboard: { name, widgets:[{title, viz, query, w?(1-12), h?(1-12)}] } – query wie bei report. Beispiel: {"name":"Vertrieb","widgets":[{"title":"Neue Kontakte","viz":"kpi","query":{"source":"contacts","measures":["count"],"range":"last_30_days"},"w":4,"h":2}]}',
    build: (p) => ({
      method: 'POST',
      path: '/api/reports/dashboards',
      body: {
        name: str(p.name, 'name', 120),
        visibility: 'private',
        widgets: list(p.widgets, 'widgets', 20, true).map((w, i) => {
          const o = obj(w, 'widgets[]');
          return { title: str(o.title || `Bericht ${i + 1}`, 'title', 120), config: { viz: str(o.viz || 'table', 'viz', 20), query: obj(o.query, 'query') }, w: Number(o.w) || 6, h: Number(o.h) || 4, x: (i % 2) * 6, y: Math.floor(i / 2) * 4 };
        }),
      },
    }),
    result: (r) => ({ id: idOf(r), name: String(r?.name ?? ''), url: `reports/d/${idOf(r)}` }),
    undo: (id) => `/api/reports/dashboards/${id}`,
  },
  agent: {
    label: 'KI-Agent',
    note: 'wird privat angelegt, ohne Auto-Antwort und Zeitplan',
    doc: 'agent: { name, emoji?, description (Rolle), instructions (Anweisungen), mode?: "read"|"ask" (Standard ask), starters?:[Startfragen] } – Beispiel: {"name":"Angebots-Helfer","emoji":"📝","description":"Hilft beim Formulieren von Angeboten","instructions":"Fasse Kundenwünsche zusammen und schlage Angebotstexte vor.","mode":"ask"}',
    build: (p) => ({
      method: 'POST',
      path: '/api/agents',
      body: { name: str(p.name, 'name', 80), ...(p.emoji ? { emoji: str(p.emoji, 'emoji', 8) } : {}), description: str(p.description, 'description', 500, false), instructions: str(p.instructions, 'instructions', 6000), mode: p.mode === 'read' ? 'read' : 'ask', visibility: 'private', starters: textList(p.starters, 'starters', 8), web_fetch: false },
    }),
    result: (r) => ({ id: idOf(r), name: String(r?.name ?? ''), url: 'agents' }),
    undo: (id) => `/api/agents/${id}`,
  },
  template: {
    label: 'Vorlage (E-Mail/SMS)',
    doc: 'template: { name, channel: "email"|"sms", subject? (E-Mail), body } – Platzhalter {{contact.first_name|du}}. Beispiel: {"name":"Termin-Erinnerung","channel":"sms","body":"Hallo {{contact.first_name|}}, wir sehen uns morgen!"}',
    build: (p) => ({ method: 'POST', path: '/api/templates', body: { name: str(p.name, 'name', 120), channel: p.channel === 'sms' ? 'sms' : 'email', subject: str(p.subject, 'subject', 200, false), body: str(p.body, 'body', 20_000) } }),
    result: (r) => ({ id: idOf(r), name: String(r?.name ?? ''), url: 'campaigns' }),
    undo: (id) => `/api/templates/${id}`,
  },
  form: {
    label: 'Formular',
    doc: 'form: { name, kind?: "form"|"survey", fields:[{type: text|email|phone|textarea|select|checkbox|consent, label, name, required?, options?:[…]}], settings?:{thank_you?} } – name ist der interne Name (first_name, last_name, email, phone, message, company wirken auf den Kontakt). Beispiel: {"name":"Rückruf-Wunsch","fields":[{"type":"text","label":"Vorname","name":"first_name","required":true},{"type":"phone","label":"Telefon","name":"phone","required":true}]}',
    build: (p) => ({ method: 'POST', path: '/api/forms', body: { name: str(p.name, 'name', 120), kind: p.kind === 'survey' ? 'survey' : 'form', fields: list(p.fields, 'fields', 40, true).map((f) => obj(f, 'fields[]')), ...(p.settings && typeof p.settings === 'object' ? { settings: { thank_you: str((p.settings as P).thank_you, 'thank_you', 500, false) || undefined } } : {}) } }),
    result: (r) => ({ id: idOf(r), name: String(r?.name ?? ''), url: `forms/${idOf(r)}` }),
    undo: (id) => `/api/forms/${id}`,
  },
  pipeline: {
    label: 'Pipeline',
    doc: 'pipeline: { name, stages:[Phasen-Namen] } – Beispiel: {"name":"Aufträge","stages":["Anfrage","Angebot","Beauftragt","Erledigt"]}',
    build: (p) => ({ method: 'POST', path: '/api/pipelines', body: { name: str(p.name, 'name', 100), stages: textList(p.stages, 'stages', 20) } }),
    result: (r) => ({ id: idOf(r), name: String(r?.name ?? ''), url: 'opportunities' }),
    undo: (id) => `/api/pipelines/${id}`,
  },
  tag: {
    label: 'Tag',
    doc: 'tag: { name } – Beispiel: {"name":"vip"}',
    build: (p) => ({ method: 'POST', path: '/api/tags', body: { name: str(p.name, 'name', 80) } }),
    result: (r) => ({ id: idOf(r), name: String(r?.name ?? '') }),
    undo: (id) => `/api/tags/${id}`,
  },
};

export const BLOCK_KEYS = Object.keys(BLOCKS);

export interface PlanStep {
  block: string;
  title: string;
  params: P;
  /** Permission area (server/core/permissions.ts) the route needs, e.g. "workflows". */
  area: string | null;
}

/** A step from the AI: the block must exist and its parameters must build a request. */
export function checkStep(raw: { block?: unknown; title?: unknown; params?: unknown }): PlanStep {
  const key = String(raw.block ?? '');
  const def = BLOCKS[key];
  if (!def) throw bad(`Unbekannter Baustein „${key}“ – möglich sind: ${BLOCK_KEYS.join(', ')}.`);
  const params = obj(raw.params, 'params');
  const call = def.build(params);
  return { block: key, title: String(raw.title ?? '').trim().slice(0, 140) || def.label, params, area: requiredPermission(call.method, call.path.split('?')[0]) ?? null };
}

/** Does the user have every area the steps need? Names the first one missing. */
export function missingAreas(user: User | undefined, steps: PlanStep[]): string[] {
  if (!user || user.role === 'admin' || !user.permissions) return [];
  return [...new Set(steps.map((s) => s.area).filter((a): a is string => !!a && !user.permissions!.includes(a)))];
}

export interface Created {
  block: string;
  id: string;
  name: string;
  url?: string;
  undone?: boolean;
}

/** The context stage 1 runs under: the requester's rights, shown in the audit log as the Werkstatt. */
export function buildContext(base: Ctx | undefined, user: User, locationId: string, label: string): Ctx {
  const b = base ?? backgroundContext(user, locationId);
  return { ...b, user: { ...user, name: `${label} (im Auftrag von ${user.name})`.slice(0, 200) }, via: 'werkstatt' as Ctx['via'], viaApiKey: false, scope: undefined, locationId, skipAfterWrite: false };
}

/** Routes stage 1 may call (the catalogue's creates and their undo) – a guard checks this for via "werkstatt". */
export const WERKSTATT_ROUTES = [
  /^POST \/api\/(workflows|custom-fields|object-types|properties|reports\/library|reports\/dashboards|agents|templates|forms|pipelines|tags)$/,
  /^DELETE \/api\/(workflows|custom-fields|object-types|properties|reports\/library|reports\/dashboards|agents|templates|forms|pipelines|tags)\/[A-Za-z0-9_-]{1,64}$/,
];

/** Runs the steps one by one as the requester. Stops at the first failure and reports what exists so far. */
export async function executeSteps(app: App, o: { user: User; locationId: string; baseCtx?: Ctx; steps: PlanStep[]; label: string; log: (text: string, level?: 'info' | 'error') => void; progress?: (step: number, total: number, label: string) => void }): Promise<{ created: Created[]; error?: string }> {
  const created: Created[] = [];
  const ctx = buildContext(o.baseCtx, o.user, o.locationId, o.label);
  for (const [i, step] of o.steps.entries()) {
    const def = BLOCKS[step.block];
    o.progress?.(i + 1, o.steps.length, `Schritt ${i + 1} von ${o.steps.length}: ${step.title || def.label}`);
    try {
      const call = def.build(step.params);
      const r = await callRoute(app, ctx, call.method, call.path, { locationId: o.locationId, body: call.body });
      const res = def.result(r, step.params);
      created.push({ block: step.block, ...res });
      o.log(`Schritt ${i + 1}/${o.steps.length}: ${def.label} „${res.name}“ angelegt.`);
    } catch (e) {
      const msg = (e as Error).message || 'Fehler';
      o.log(`Schritt ${i + 1}/${o.steps.length} (${def.label}) fehlgeschlagen: ${msg}`, 'error');
      return { created, error: `Schritt ${i + 1} (${step.title}): ${msg}` };
    }
  }
  return { created };
}

/** Removes what a build created, newest first, as the user asking. */
export async function undoCreated(app: App, o: { user: User; locationId: string; baseCtx?: Ctx; created: Created[]; label: string }): Promise<{ removed: number; failed: number; created: Created[] }> {
  const ctx = buildContext(o.baseCtx, o.user, o.locationId, o.label);
  let removed = 0;
  let failed = 0;
  const out = o.created.map((c) => ({ ...c }));
  for (const c of [...out].reverse()) {
    if (c.undone || !c.id) continue;
    try {
      await callRoute(app, ctx, 'DELETE', BLOCKS[c.block].undo(c.id), { locationId: o.locationId });
      c.undone = true;
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, failed, created: out };
}

/** The block reference for the AI prompt. */
export const blocksReference = () => BLOCK_KEYS.map((k) => `- ${BLOCKS[k].doc}`).join('\n');
