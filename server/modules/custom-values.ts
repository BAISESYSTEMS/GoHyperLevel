import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, type Ctx } from '../core/http.js';
import { render, templateNamespace } from '../core/template.js';
import { id, now } from '../core/util.js';
import { LIMITS, NAMESPACE, cleanKey, fillHtml, keyFromName, locationOfData, placeholderOf, referencedKeys } from '../services/custom-values.js';
import type { SnapshotPart } from '../services/snapshots.js';
import { tableEntity } from '../services/undo-table.js';
import type { Tool } from './mcp.js';

/**
 * Custom Values: global placeholders per sub-account (HighLevel's staple) – „Telefon Hotline“ = „0800 123 456“, used as
 * `{{custom_values.telefon_hotline}}` in every e-mail, SMS, workflow step, document and page. Key/value pairs with optional
 * folders; the central renderer (core/template.ts) asks this module through the `custom_values` namespace, the published pages
 * of the site builder get theirs through `pageServe`. Snapshots carry them as placeholders (name, key, folder, hint – no value
 * unless the value is marked „im Snapshot mitgeben“), so an agency fills them per client after loading a snapshot. A form can
 * set a value from one of its fields (form target). Settings UI, REST, MCP. Docs: docs/custom-values.md.
 */

interface ValueRow {
  id: string;
  location_id: string;
  key: string;
  name: string;
  value: string;
  folder: string;
  description: string;
  in_snapshot: number;
  needs_value: number;
  created_at: string;
  updated_at: string;
}

/** Every app of this process (tests run several): the template namespace is process-wide, the values live in each app's database. */
const APPS = new Set<App>();
let unregister: (() => void) | null = null;

const out = (r: ValueRow) => ({ id: r.id, key: r.key, name: r.name, value: r.value, folder: r.folder, description: r.description, in_snapshot: !!r.in_snapshot, needs_value: !!r.needs_value, placeholder: placeholderOf(r.key), created_at: r.created_at, updated_at: r.updated_at });

function valueIn(app: App, locationId: string, key: string): string | undefined {
  const r = app.db.get<{ value: string }>('SELECT value FROM custom_values WHERE location_id = ? AND key = ?', locationId, key);
  return r ? r.value : undefined;
}

/** The value for template data: the app the location row came from first, then every app of the process. */
function resolve(rest: string, data: Record<string, any>): string | undefined {
  const key = cleanKey(rest);
  const loc = locationOfData(data);
  if (!key || !loc) return undefined;
  const own = data?.location?.app as App | undefined;
  const apps = own && APPS.has(own) ? [own, ...[...APPS].filter((a) => a !== own)] : [...APPS];
  for (const app of apps) {
    try {
      const v = valueIn(app, loc, key);
      if (v !== undefined) return v;
    } catch {
      APPS.delete(app); // closed database (a finished test app)
    }
  }
  return undefined;
}

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

const TOOLS: Tool[] = [
  {
    name: 'ghl_custom_values',
    title: 'Custom Values lesen',
    description: 'Listet die Custom Values (globale Platzhalter) eines Sub-Accounts: Schlüssel, Name, Wert, Ordner und den Platzhalter {{custom_values.schluessel}}, der in E-Mails, SMS, Workflows, Dokumenten und Seiten funktioniert. needs_value = aus einem Snapshot, Wert fehlt noch.',
    inputSchema: obj({ ...LOC, folder: { type: 'string', description: 'Nur dieser Ordner' } }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const r = await call.api('GET', '/api/custom-values', { location: a.location_id });
      return { ...r, values: a.folder ? r.values.filter((v: any) => v.folder === a.folder) : r.values };
    },
  },
  {
    name: 'ghl_custom_value_set',
    title: 'Custom Value setzen',
    description: 'Legt einen Custom Value an oder ändert ihn (über den Schlüssel, z. B. telefon_hotline). Danach ersetzt {{custom_values.<key>}} den Text überall, wo Platzhalter wirken. name und folder sind optional (Standard: Name aus dem Schlüssel, kein Ordner).',
    inputSchema: obj(
      {
        ...LOC,
        key: { type: 'string', description: 'Schlüssel: Kleinbuchstaben, Ziffern, Unterstrich (wird sonst aus dem Text gebildet)' },
        value: { type: 'string', description: 'Der Wert (Text, bis 5000 Zeichen)' },
        name: { type: 'string', description: 'Anzeigename' },
        folder: { type: 'string', description: 'Ordner (optional)' },
      },
      ['location_id', 'key', 'value'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: (call, a) => call.api('PUT', `/api/custom-values/by-key/${encodeURIComponent(keyFromName(String(a.key ?? '')) || 'x')}`, { location: a.location_id, body: { value: a.value, name: a.name, folder: a.folder } }),
  },
];

export const customValuesModule: Module = {
  name: 'custom-values',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE custom_values (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
        in_snapshot INTEGER NOT NULL DEFAULT 0, needs_value INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(location_id, key)
      );
      CREATE TABLE custom_value_form_targets (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE, field_id TEXT NOT NULL, value_key TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(form_id, field_id, value_key)
      );
      CREATE INDEX custom_value_form_targets_form ON custom_value_form_targets(form_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    APPS.add(app);
    unregister ??= templateNamespace(NAMESPACE, resolve);
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    const writable = (ctx: Ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
    };
    const rowOf = (ctx: Ctx, rid: string) => {
      const r = db.get<ValueRow>('SELECT * FROM custom_values WHERE id = ? AND location_id = ?', rid, ctx.locationId);
      if (!r) throw notFound('Custom Value nicht gefunden');
      return r;
    };
    const text = (v: unknown, field: string, max: number) => {
      if (v === undefined || v === null) return '';
      if (typeof v === 'object') throw bad(`${field}: bitte Text angeben`);
      const s = String(v);
      if (s.length > max) throw bad(`${field} ist zu lang (höchstens ${max} Zeichen)`);
      return s;
    };
    const folderOf = (v: unknown) => text(v, 'Ordner', LIMITS.folder).trim().replace(/\s+/g, ' ');
    const list = (loc: string) => db.all<ValueRow>('SELECT * FROM custom_values WHERE location_id = ? ORDER BY folder, name COLLATE NOCASE', loc);

    function create(ctx: Ctx, b: Record<string, any>) {
      const name = text(b.name, 'Name', LIMITS.name).trim() || String(b.key ?? '').trim();
      if (!name) throw bad('Name fehlt');
      const key = b.key !== undefined && b.key !== '' ? cleanKey(b.key) : keyFromName(name);
      if (!key) throw bad('Schlüssel: nur Kleinbuchstaben, Ziffern und Unterstrich, beginnend mit einem Buchstaben (z. B. telefon_hotline)');
      if (db.get('SELECT 1 FROM custom_values WHERE location_id = ? AND key = ?', ctx.locationId, key)) throw new HttpError(409, `Den Schlüssel „${key}“ gibt es schon`);
      const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM custom_values WHERE location_id = ?', ctx.locationId)!.n;
      if (n >= LIMITS.perLocation) throw bad(`Höchstens ${LIMITS.perLocation} Custom Values je Sub-Account`);
      const row: ValueRow = { id: id(), location_id: ctx.locationId, key, name, value: text(b.value, 'Wert', LIMITS.value), folder: folderOf(b.folder), description: text(b.description, 'Hinweis', LIMITS.description).trim(), in_snapshot: b.in_snapshot ? 1 : 0, needs_value: 0, created_at: now(), updated_at: now() };
      db.insert('custom_values', row);
      return row;
    }
    function patch(ctx: Ctx, r: ValueRow, b: Record<string, any>) {
      const p: Partial<ValueRow> = { updated_at: now() };
      if (b.name !== undefined) {
        p.name = text(b.name, 'Name', LIMITS.name).trim();
        if (!p.name) throw bad('Name fehlt');
      }
      if (b.key !== undefined && b.key !== r.key) {
        const key = cleanKey(b.key);
        if (!key) throw bad('Schlüssel: nur Kleinbuchstaben, Ziffern und Unterstrich, beginnend mit einem Buchstaben');
        if (db.get('SELECT 1 FROM custom_values WHERE location_id = ? AND key = ? AND id != ?', ctx.locationId, key, r.id)) throw new HttpError(409, `Den Schlüssel „${key}“ gibt es schon`);
        p.key = key;
      }
      if (b.value !== undefined) {
        p.value = text(b.value, 'Wert', LIMITS.value);
        p.needs_value = 0;
      }
      if (b.folder !== undefined) p.folder = folderOf(b.folder);
      if (b.description !== undefined) p.description = text(b.description, 'Hinweis', LIMITS.description).trim();
      if (b.in_snapshot !== undefined) p.in_snapshot = b.in_snapshot ? 1 : 0;
      db.update('custom_values', r.id, p);
      return db.get<ValueRow>('SELECT * FROM custom_values WHERE id = ?', r.id)!;
    }

    // --- routes ------------------------------------------------------------------------------------------------------
    router.get('/api/custom-values', 'location', (ctx) => {
      const rows = list(ctx.locationId);
      return { values: rows.map(out), folders: [...new Set(rows.map((r) => r.folder).filter(Boolean))], pending: rows.filter((r) => r.needs_value).length, limit: LIMITS.perLocation };
    });
    router.post('/api/custom-values', 'location', (ctx) => {
      writable(ctx);
      return out(create(ctx, ctx.body ?? {}));
    });
    router.patch('/api/custom-values/:id', 'location', (ctx) => {
      writable(ctx);
      return out(patch(ctx, rowOf(ctx, ctx.params.id), ctx.body ?? {}));
    });
    /** Upsert by key – for scripts, Zapier and the MCP tool. */
    router.put('/api/custom-values/by-key/:key', 'location', (ctx) => {
      writable(ctx);
      const key = cleanKey(ctx.params.key);
      if (!key) throw bad('Schlüssel: nur Kleinbuchstaben, Ziffern und Unterstrich, beginnend mit einem Buchstaben');
      const b = ctx.body ?? {};
      if (b.value === undefined) throw bad('Wert fehlt');
      const r = db.get<ValueRow>('SELECT * FROM custom_values WHERE location_id = ? AND key = ?', ctx.locationId, key);
      return out(r ? patch(ctx, r, { value: b.value, ...(b.name ? { name: b.name } : {}), ...(b.folder !== undefined ? { folder: b.folder } : {}) }) : create(ctx, { key, name: b.name || key, value: b.value, folder: b.folder }));
    });
    router.delete('/api/custom-values/:id', 'location', (ctx) => {
      writable(ctx);
      const r = rowOf(ctx, ctx.params.id);
      db.run('DELETE FROM custom_values WHERE id = ? AND location_id = ?', r.id, ctx.locationId);
      return { ok: true, key: r.key };
    });
    /** A text with placeholders as this sub-account would send it (contact fields stay empty). */
    router.post('/api/custom-values/preview', 'location', (ctx) => {
      const tpl = text(ctx.body?.text, 'Text', 20_000);
      const loc = app.location(ctx.locationId);
      return { text: render(tpl, { location: loc ?? { id: ctx.locationId } }), keys: referencedKeys(tpl) };
    });

    // --- form targets: a form field sets a value --------------------------------------------------------------------
    const targetOut = (r: any) => {
      const form = db.get<{ name: string; fields: string }>('SELECT name, fields FROM forms WHERE id = ?', r.form_id);
      const field = (JSON.parse(form?.fields || '[]') as any[]).find((f) => f?.id === r.field_id);
      return { id: r.id, form_id: r.form_id, form_name: form?.name ?? '', field_id: r.field_id, field_label: String(field?.label ?? field?.name ?? r.field_id), value_key: r.value_key, created_at: r.created_at };
    };
    router.get('/api/custom-values/form-targets', 'location', (ctx) => db.all('SELECT * FROM custom_value_form_targets WHERE location_id = ? ORDER BY created_at', ctx.locationId).map(targetOut));
    router.post('/api/custom-values/form-targets', 'location', (ctx) => {
      writable(ctx);
      const b = ctx.body ?? {};
      const form = db.get<{ id: string; fields: string }>('SELECT id, fields FROM forms WHERE id = ? AND location_id = ?', String(b.form_id ?? ''), ctx.locationId);
      if (!form) throw notFound('Formular nicht gefunden');
      const field = (JSON.parse(form.fields || '[]') as any[]).find((f) => f?.id === String(b.field_id ?? ''));
      if (!field) throw bad('Feld nicht gefunden');
      if (['file', 'signature', 'payment', 'heading', 'page_break'].includes(field.type)) throw bad('Dieses Feld liefert keinen Text');
      const key = cleanKey(b.value_key);
      if (!key || !db.get('SELECT 1 FROM custom_values WHERE location_id = ? AND key = ?', ctx.locationId, key)) throw bad('Custom Value nicht gefunden – erst anlegen, dann als Ziel wählen');
      if (db.get('SELECT 1 FROM custom_value_form_targets WHERE form_id = ? AND field_id = ? AND value_key = ?', form.id, field.id, key)) throw new HttpError(409, 'Dieses Ziel gibt es schon');
      const row = { id: id(), location_id: ctx.locationId, form_id: form.id, field_id: field.id, value_key: key, created_at: now() };
      db.insert('custom_value_form_targets', row);
      return targetOut(row);
    });
    router.delete('/api/custom-values/form-targets/:id', 'location', (ctx) => {
      writable(ctx);
      const r = db.run('DELETE FROM custom_value_form_targets WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r.changes) throw notFound('Ziel nicht gefunden');
      return { ok: true };
    });
    app.events.on('form.submitted', (e) => {
      const targets = db.all<{ field_id: string; value_key: string }>('SELECT field_id, value_key FROM custom_value_form_targets WHERE form_id = ? AND location_id = ?', String(e.data?.formId ?? ''), e.locationId);
      if (!targets.length) return;
      const form = db.get<{ fields: string }>('SELECT fields FROM forms WHERE id = ?', e.data.formId);
      const fields = JSON.parse(form?.fields || '[]') as any[];
      const answers: Record<string, unknown> = e.data.answers ?? {};
      for (const t of targets) {
        const f = fields.find((x) => x?.id === t.field_id);
        if (!f) continue;
        const raw = answers[String(f.label || f.name || f.id)];
        if (raw === undefined || raw === null || raw === '') continue;
        const v = (Array.isArray(raw) ? raw.join(', ') : String(raw)).slice(0, LIMITS.value);
        db.run('UPDATE custom_values SET value = ?, needs_value = 0, updated_at = ? WHERE location_id = ? AND key = ?', v, now(), e.locationId, t.value_key);
      }
    });

    // --- published pages: placeholders filled as the page leaves the server -----------------------------------------
    app.services.pageServe = [
      ...(app.services.pageServe ?? []),
      (_ctx: Ctx, funnel: any) => ({ transform: (html: string) => fillHtml(html, (k) => valueIn(app, String(funnel.location_id), k)) }),
    ];

    // --- snapshots: placeholders, values only when marked ----------------------------------------------------------
    const part: SnapshotPart = {
      key: 'custom_values',
      export(_app, locationId, only) {
        let rows = list(locationId);
        if (only) {
          // One website copied to another client: the values its pages use.
          const used = new Set<string>();
          for (const fid of only.funnelIds ?? []) for (const p of db.all<{ blocks: string; seo: string }>('SELECT blocks, seo FROM funnel_pages WHERE funnel_id = ? AND location_id = ?', fid, locationId)) referencedKeys(`${p.blocks}${p.seo}`).forEach((k) => used.add(k));
          rows = rows.filter((r) => used.has(r.key));
        }
        return rows.map((r) => ({ key: r.key, name: r.name, folder: r.folder, description: r.description, in_snapshot: !!r.in_snapshot, value: r.in_snapshot ? r.value : '' }));
      },
      apply(_app, locationId, items, ctx) {
        let n = 0;
        for (const it of items) {
          const key = cleanKey(it.key);
          if (!key) continue;
          const value = it.in_snapshot ? String(it.value ?? '').slice(0, LIMITS.value) : '';
          n += db.run(
            `INSERT OR IGNORE INTO custom_values (id, location_id, key, name, value, folder, description, in_snapshot, needs_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id(),
            locationId,
            key,
            String(it.name || key).slice(0, LIMITS.name),
            value,
            String(it.folder ?? '').slice(0, LIMITS.folder),
            String(it.description ?? '').slice(0, LIMITS.description),
            it.in_snapshot ? 1 : 0,
            value ? 0 : 1,
            now(),
            now(),
          ).changes;
        }
        ctx.created.custom_values = n;
      },
    };
    app.services.snapshotParts = [...(app.services.snapshotParts ?? []), part];

    // --- undo journal: edits and deletes come back ------------------------------------------------------------------
    const undo = app.services.undo;
    if (undo?.register) {
      undo.register(
        'custom_value',
        tableEntity(app, { noun: 'Custom Value', plural: 'Custom Values', area: 'settings', table: 'custom_values', title: (r) => String(r.name), contactCol: null, volatile: ['updated_at'], fields: { name: { label: 'Name' }, key: { label: 'Schlüssel' }, value: { label: 'Wert' }, folder: { label: 'Ordner' } } }),
      );
      undo.track({ method: 'PATCH', pattern: '/api/custom-values/:id', entity: 'custom_value' });
      undo.track({ method: 'DELETE', pattern: '/api/custom-values/:id', entity: 'custom_value' });
    }
  },
};
