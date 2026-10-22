import type { App, LocationRow } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { id, now, slugify, token } from '../core/util.js';
import { ensureTags } from './contacts.js';
import { designFields } from './email-design.js';

/**
 * Calendar settings that belong to one installation and one calendar, never into a template: the private
 * feed token (two calendars with one token would serve the source calendar's appointments to the copy's
 * owner) and imported private iCal URLs with their status. Also stripped when an old snapshot is applied.
 */
function portableCalendarSettings(settings: unknown): Record<string, any> {
  const { feed_token: _t, ical_import: _i, ical_status: _s, ...rest } = (settings && typeof settings === 'object' ? settings : {}) as Record<string, any>;
  return rest;
}

/**
 * Snapshots, like GHL's: the building blocks of a sub-account (pipelines, calendars, forms, funnels
 * with their pages, workflows, templates, products, custom fields, tags) without any contacts or
 * other customer data. Applying one copies everything into another sub-account with new ids and
 * rewrites every reference (a page's form, a workflow's pipeline…) to the copies.
 *
 * Other modules add their own parts (blog posts, courses, community groups) through
 * `app.services.snapshotParts` – see SnapshotPart.
 */

export interface SnapshotData {
  version: 1;
  custom_fields: { key: string; label: string; type: string; options: string[]; position: number }[];
  tags: string[];
  pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[];
  calendars: Record<string, any>[];
  forms: { id: string; name: string; kind: string; fields: any[]; settings: Record<string, any> }[];
  funnels: { id: string; name: string; slug: string; kind: string; settings: Record<string, any>; pages: { name: string; slug: string; position: number; blocks: any[]; seo: any }[] }[];
  workflows: { id: string; name: string; status: string; trigger: any; steps: any[]; settings: Record<string, any> }[];
  templates: { name: string; channel: string; subject: string; body: string; is_html: number; design?: any; body_text?: string }[];
  products: { id?: string; name: string; description: string; price_cents: number; currency: string; tax_rate: number | null; recurring: string | null }[];
  /** Parts added by other modules (see SnapshotPart); older snapshots simply lack them. */
  blog_posts?: Record<string, any>[];
  courses?: Record<string, any>[];
  community_groups?: Record<string, any>[];
  [part: string]: unknown;
}

const REF_KEYS = {
  form_id: 'forms',
  calendar_id: 'calendars',
  pipeline_id: 'pipelines',
  workflow_id: 'workflows',
  on_error_workflow_id: 'workflows',
  calendar_slug: 'calendarSlugs',
  product_id: 'products',
  course_id: 'courses',
  group_id: 'communityGroups',
} as const;
/** Old id → new id, per kind of item. Parts may add their own maps (funnels, courses…). */
export type Maps = Record<string, Map<string, string>>;

/** What to copy when not everything is wanted: one website (with what its pages use) or one course. */
export interface SnapshotScope {
  funnelIds?: string[];
  courseIds?: string[];
}

export interface SnapshotApplyCtx {
  loc: LocationRow;
  maps: Maps;
  created: Record<string, any>;
}

/**
 * A module's own share of a snapshot, stored under `key`. `prepare` runs before anything is
 * inserted and fills `maps` with new ids (so workflows can point at copied courses); `apply` runs
 * inside the same transaction after the built-in items, in registration order.
 */
export interface SnapshotPart {
  key: string;
  export(app: App, locationId: string, only?: SnapshotScope): Record<string, any>[];
  prepare?(app: App, items: Record<string, any>[], maps: Maps): void;
  apply(app: App, locationId: string, items: Record<string, any>[], ctx: SnapshotApplyCtx): void;
}

const snapshotParts = (app: App): SnapshotPart[] => app.services.snapshotParts ?? [];

/** Rewrites references to copied items; references to anything not in the snapshot are cleared. */
export function remapRefs<T>(value: T, maps: Maps): T {
  if (Array.isArray(value)) return value.map((v) => remapRefs(v, maps)) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    const mapName = REF_KEYS[k as keyof typeof REF_KEYS];
    if (mapName && typeof v === 'string' && v) out[k] = maps[mapName]?.get(v) ?? '';
    else out[k] = remapRefs(v, maps);
  }
  return out as T;
}

/** Ids referenced by funnel blocks, for copying a single funnel with what it needs. */
function blockRefs(funnels: SnapshotData['funnels']) {
  const forms = new Set<string>();
  const calendars = new Set<string>();
  const walk = (v: any) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (typeof v.form_id === 'string' && v.form_id) forms.add(v.form_id);
    if (typeof v.calendar_slug === 'string' && v.calendar_slug) calendars.add(v.calendar_slug);
    Object.values(v).forEach(walk);
  };
  funnels.forEach((f) => f.pages.forEach((p) => walk(p.blocks)));
  return { forms, calendars };
}

export function exportSnapshot(app: App, locationId: string, only?: SnapshotScope): SnapshotData {
  const db = app.db;
  const all = <T = any>(sql: string, json: string[]) => parseRows(db.all(sql, locationId), json) as T[];

  let funnels = all<any>('SELECT * FROM funnels WHERE location_id = ? ORDER BY created_at', ['settings']).map((f) => ({
    id: f.id,
    name: f.name,
    slug: f.slug,
    kind: f.kind,
    settings: f.settings,
    pages: parseRows(db.all('SELECT * FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at', f.id), ['blocks', 'seo']).map((p) => ({
      name: p.name,
      slug: p.slug,
      position: p.position,
      blocks: p.blocks,
      seo: p.seo,
    })),
  }));
  let forms = all<any>('SELECT * FROM forms WHERE location_id = ? ORDER BY created_at', ['fields', 'settings']).map((f) => ({ id: f.id, name: f.name, kind: f.kind, fields: f.fields, settings: f.settings }));
  let calendars = all<any>('SELECT * FROM calendars WHERE location_id = ? ORDER BY created_at', ['availability', 'settings']).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    duration: c.duration,
    interval: c.interval,
    buffer: c.buffer,
    min_notice: c.min_notice,
    max_days: c.max_days,
    availability: c.availability,
    color: c.color,
    active: c.active,
    settings: portableCalendarSettings(c.settings),
  }));

  const extras = () => Object.fromEntries(snapshotParts(app).map((p) => [p.key, p.export(app, locationId, only)]));

  if (only) {
    funnels = funnels.filter((f) => (only.funnelIds ?? []).includes(f.id));
    const refs = blockRefs(funnels);
    forms = forms.filter((f) => refs.forms.has(f.id));
    calendars = calendars.filter((c) => refs.calendars.has(c.slug));
    return { version: 1, custom_fields: [], tags: [], pipelines: [], calendars, forms, funnels, workflows: [], templates: [], products: [], ...extras() };
  }

  return {
    version: 1,
    custom_fields: all<any>('SELECT * FROM custom_fields WHERE location_id = ? ORDER BY position', ['options']).map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, position: f.position })),
    tags: db.all('SELECT name FROM tags WHERE location_id = ? ORDER BY name', locationId).map((t) => t.name),
    pipelines: all<any>('SELECT * FROM pipelines WHERE location_id = ? ORDER BY created_at', ['stages']).map((p) => ({ id: p.id, name: p.name, stages: p.stages })),
    calendars,
    forms,
    funnels,
    workflows: all<any>('SELECT * FROM workflows WHERE location_id = ? ORDER BY created_at', ['trigger', 'steps', 'settings']).map((w) => ({
      id: w.id,
      name: w.name,
      status: w.status,
      trigger: w.trigger,
      steps: w.steps,
      settings: w.settings,
    })),
    templates: db.all('SELECT name, channel, subject, body, is_html, design, body_text FROM templates WHERE location_id = ? ORDER BY name', locationId).map((t) => ({ ...t, design: t.design ? JSON.parse(t.design) : undefined })) as any,
    products: db.all('SELECT id, name, description, price_cents, currency, tax_rate, recurring FROM products WHERE location_id = ? ORDER BY name', locationId) as any,
    ...extras(),
  };
}

export function snapshotSummary(d: SnapshotData) {
  return {
    funnels: d.funnels.length,
    pages: d.funnels.reduce((n, f) => n + f.pages.length, 0),
    forms: d.forms.length,
    calendars: d.calendars.length,
    workflows: d.workflows.length,
    pipelines: d.pipelines.length,
    templates: d.templates.length,
    products: d.products.length,
    custom_fields: d.custom_fields.length,
    tags: d.tags.length,
    blog_posts: d.blog_posts?.length ?? 0,
    courses: d.courses?.length ?? 0,
    lessons: (d.courses ?? []).reduce((n, c) => n + (Array.isArray(c.modules) ? c.modules.reduce((m: number, x: any) => m + (Array.isArray(x.lessons) ? x.lessons.length : 0), 0) : 0), 0),
    community_groups: d.community_groups?.length ?? 0,
  };
}

/** Throws on anything that isn't a snapshot this version can read. */
export function validateSnapshot(d: any): SnapshotData {
  if (!d || typeof d !== 'object' || d.version !== 1) throw new Error('Keine gültige Snapshot-Datei (version 1)');
  for (const k of ['custom_fields', 'tags', 'pipelines', 'calendars', 'forms', 'funnels', 'workflows', 'templates', 'products']) {
    if (d[k] === undefined) d[k] = [];
    if (!Array.isArray(d[k])) throw new Error(`Snapshot: ${k} muss eine Liste sein`);
  }
  for (const k of ['blog_posts', 'courses', 'community_groups']) if (d[k] !== undefined && !Array.isArray(d[k])) throw new Error(`Snapshot: ${k} muss eine Liste sein`);
  for (const f of d.funnels) if (!Array.isArray(f.pages)) f.pages = [];
  return d as SnapshotData;
}

function uniqueSlug(app: App, table: 'calendars' | 'funnels', base: string, prefix: string) {
  const taken = (s: string) => !!app.db.get(`SELECT id FROM ${table} WHERE slug = ?`, s);
  const first = slugify(base);
  if (!taken(first)) return first;
  const withPrefix = slugify(`${prefix}-${base}`);
  let slug = withPrefix;
  for (let i = 2; taken(slug); i++) slug = `${withPrefix}-${i}`;
  return slug;
}

export function applySnapshot(app: App, locationId: string, data: SnapshotData, opts: { activateWorkflows?: boolean } = {}) {
  const db = app.db;
  const loc = app.location(locationId);
  if (!loc) throw new Error('Sub-Account nicht gefunden');
  const maps: Maps = { forms: new Map(), calendars: new Map(), pipelines: new Map(), workflows: new Map(), calendarSlugs: new Map(), products: new Map(), funnels: new Map() };
  const created: Record<string, any> & { funnels: { id: string; slug: string; name: string }[]; calendars: { id: string; slug: string }[]; forms: string[]; workflows: string[] } = { funnels: [], calendars: [], forms: [], workflows: [] };
  const parts = snapshotParts(app).filter((p) => Array.isArray(data[p.key]));
  const items = (p: SnapshotPart) => data[p.key] as Record<string, any>[];

  db.tx(() => {
    for (const f of data.custom_fields) {
      db.run(
        'INSERT OR IGNORE INTO custom_fields (id, location_id, key, label, type, options, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id(),
        locationId,
        String(f.key).replace(/[^a-z0-9_]/g, '_'),
        String(f.label ?? f.key),
        String(f.type ?? 'text'),
        JSON.stringify(f.options ?? []),
        Number(f.position) || 0,
        now(),
      );
    }
    ensureTags(app, locationId, data.tags.map(String).filter(Boolean));

    for (const p of data.pipelines) {
      const nid = id();
      maps.pipelines.set(p.id, nid);
      db.insert('pipelines', { id: nid, location_id: locationId, name: String(p.name), stages: p.stages, created_at: now() });
    }
    for (const c of data.calendars) {
      const nid = id();
      const slug = uniqueSlug(app, 'calendars', c.slug || c.name, loc.name);
      maps.calendars.set(c.id, nid);
      maps.calendarSlugs.set(c.slug, slug);
      created.calendars.push({ id: nid, slug });
    }
    for (const f of data.forms) maps.forms.set(f.id, id());
    for (const w of data.workflows) maps.workflows.set(w.id, id());
    for (const p of data.products) if (p.id) maps.products.set(p.id, id());
    for (const p of parts) p.prepare?.(app, items(p), maps);

    for (const c of data.calendars) {
      db.insert('calendars', {
        id: maps.calendars.get(c.id),
        location_id: locationId,
        name: String(c.name),
        slug: maps.calendarSlugs.get(c.slug),
        description: c.description ?? '',
        duration: Number(c.duration) || 30,
        interval: Number(c.interval) || Number(c.duration) || 30,
        buffer: Number(c.buffer) || 0,
        min_notice: Number(c.min_notice) || 0,
        max_days: Number(c.max_days) || 60,
        availability: c.availability ?? {},
        timezone: loc.timezone,
        color: c.color ?? '#2563eb',
        active: c.active === 0 ? 0 : 1,
        settings: remapRefs(portableCalendarSettings(c.settings), maps),
        created_at: now(),
      });
    }
    for (const f of data.forms) {
      db.insert('forms', { id: maps.forms.get(f.id), location_id: locationId, name: String(f.name), kind: f.kind === 'survey' ? 'survey' : 'form', fields: f.fields ?? [], settings: remapRefs(f.settings ?? {}, maps), created_at: now(), updated_at: now() });
      created.forms.push(maps.forms.get(f.id)!);
    }
    for (const w of data.workflows) {
      db.insert('workflows', {
        id: maps.workflows.get(w.id),
        location_id: locationId,
        name: String(w.name),
        // Copies start as drafts so nothing sends before the new account is set up.
        status: opts.activateWorkflows && w.status === 'active' ? 'active' : 'draft',
        trigger: remapRefs(w.trigger ?? {}, maps),
        steps: remapRefs(w.steps ?? [], maps),
        // The error workflow is one of the copies (or cleared when it was not part of the snapshot).
        settings: remapRefs(w.settings ?? {}, maps),
        webhook_key: token(16),
        created_at: now(),
        updated_at: now(),
      });
      created.workflows.push(maps.workflows.get(w.id)!);
    }
    for (const f of data.funnels) {
      const fid = id();
      const slug = uniqueSlug(app, 'funnels', f.slug || f.name, loc.name);
      if (f.id) maps.funnels.set(f.id, fid);
      db.insert('funnels', { id: fid, location_id: locationId, name: String(f.name), slug, kind: f.kind === 'website' ? 'website' : 'funnel', settings: f.settings ?? {}, created_at: now(), updated_at: now() });
      f.pages.forEach((p, i) =>
        db.insert('funnel_pages', {
          id: id(),
          location_id: locationId,
          funnel_id: fid,
          name: String(p.name),
          slug: slugify(p.slug || p.name),
          position: Number(p.position ?? i),
          blocks: remapRefs(p.blocks ?? [], maps),
          seo: p.seo ?? {},
          created_at: now(),
          updated_at: now(),
        }),
      );
      created.funnels.push({ id: fid, slug, name: f.name });
    }
    for (const t of data.templates) {
      let design = {};
      try {
        // Email-builder designs are rendered again here, so the stored HTML always matches the design.
        if (t.design) design = designFields(t.design);
      } catch {
        /* unusable design: keep the plain body */
      }
      db.insert('templates', { id: id(), location_id: locationId, name: String(t.name), channel: t.channel === 'sms' ? 'sms' : 'email', subject: t.subject ?? '', body: t.body ?? '', is_html: t.is_html ? 1 : 0, created_at: now(), updated_at: now(), ...design });
    }
    for (const p of data.products) {
      db.insert('products', { id: (p.id && maps.products.get(p.id)) || id(), location_id: locationId, name: String(p.name), description: p.description ?? '', price_cents: Number(p.price_cents) || 0, currency: p.currency || 'EUR', tax_rate: p.tax_rate ?? null, recurring: p.recurring ?? null, active: 1, created_at: now() });
    }
    for (const p of parts) p.apply(app, locationId, items(p), { loc, maps, created });
  });
  return created;
}
