import type { Module } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { logActivity } from '../services/contacts.js';
import { maskRow, permits, resolve, scopeClause } from '../services/record-access.js';
import { diffContact } from '../services/wfx-triggers.js';
import { id as newId, now as nowIso } from '../core/util.js';
import type { Tool } from './mcp.js';

/**
 * Detailed activity history (docs/api.md#field-history): every real change of a contact field or a deal field becomes an entry in
 * the contact's timeline – "Stadt: Berlin → Hamburg · Anna" – with old and new value and who did it (a person, a workflow, the API,
 * an import). Contacts: from `contact.updated` (every path that changes a contact emits it); the person comes from the request
 * that caused it. Deals: around `PATCH /api/opportunities/:id`, the deal before and after. The values live in `field_changes`;
 * the timeline entry (activity `field.changed` / `deal.field_changed`) names them only for fields record access can never hide –
 * for e-mail, phone, address, birthday, website, own fields, deal value and source it says "geändert" without the values, and
 * `GET /api/contacts/:id/field-history` masks them per viewer.
 */

/** Fields record access may hide (services/record-access.ts HIDEABLE): their values stay out of the timeline text. */
const SENSITIVE_CONTACT = /^(email|phone|address|city|postal_code|country|date_of_birth|website|custom\..+)$/;
const SENSITIVE_DEAL = /^(value|source)$/;
/** The record-access key that hides a built-in field (address covers city/postal code/country; own fields are checked as `custom.<key>`). */
const hideKey = (field: string) => (/^(city|postal_code|country)$/.test(field) ? 'address' : field);

const CONTACT_LABELS: Record<string, string> = {
  first_name: 'Vorname', last_name: 'Nachname', email: 'E-Mail', phone: 'Telefon', company: 'Firma', address: 'Adresse', city: 'Ort',
  postal_code: 'PLZ', country: 'Land', website: 'Website', source: 'Quelle', assigned_to: 'Zuständig', date_of_birth: 'Geburtstag', dnd: 'Nicht stören',
};
const DEAL_FIELDS: Record<string, string> = {
  name: 'Name', value: 'Wert', currency: 'Währung', status: 'Status', stage_id: 'Stufe', pipeline_id: 'Pipeline', assigned_to: 'Zuständig',
  expected_close_date: 'Erwarteter Abschluss', source: 'Quelle', lost_reason: 'Verlustgrund',
};
const MAX_VALUE = 120;
const short = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 1)}…` : s;
};

interface Actor {
  kind: 'user' | 'api' | 'workflow' | 'system';
  id: string | null;
  name: string;
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_field_history',
    title: 'Änderungsverlauf eines Kontakts',
    description: 'Wer hat wann welches Feld eines Kontakts oder seiner Deals geändert – mit altem und neuem Wert und ob es eine Person, ein Workflow oder die API war.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, contact_id: { type: 'string' }, limit: { type: 'number' } }, required: ['contact_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/contacts/${encodeURIComponent(String(a.contact_id))}/field-history${a.limit ? `?limit=${Number(a.limit)}` : ''}`, { location: a.location_id }),
  },
];

export const fieldHistoryModule: Module = {
  name: 'field-history',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE field_changes (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, opportunity_id TEXT,
        field TEXT NOT NULL, label TEXT NOT NULL, old TEXT NOT NULL DEFAULT '', new TEXT NOT NULL DEFAULT '',
        actor_kind TEXT NOT NULL, actor_id TEXT, actor_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX field_changes_contact ON field_changes(contact_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    const userName = (id: string | null | undefined) => (id ? (db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? '') : '');
    const actorOf = (ctx: Ctx): Actor => (ctx.user ? { kind: 'user', id: ctx.user.id, name: ctx.user.name ?? userName(ctx.user.id) } : { kind: 'api', id: null, name: ctx.viaApiKey ? 'API-Schlüssel' : 'API' });
    const record = (loc: string, contactId: string, opportunityId: string | null, field: string, label: string, oldV: unknown, newV: unknown, actor: Actor, summary: string) => {
      db.insert('field_changes', { id: newId(), location_id: loc, contact_id: contactId, opportunity_id: opportunityId, field, label, old: short(oldV), new: short(newV), actor_kind: actor.kind, actor_id: actor.id, actor_name: actor.name, created_at: nowIso() });
      logActivity(app, loc, contactId, opportunityId ? 'deal.field_changed' : 'field.changed', summary, { field, label, actor: actor.name, ...(opportunityId ? { opportunityId } : {}) });
    };
    const customLabels = (loc: string) => new Map(db.all<{ key: string; label: string }>('SELECT key, label FROM custom_fields WHERE location_id = ?', loc).map((r) => [r.key, r.label]));

    // The request that is writing a contact right now: its events come after the response, so the person is remembered briefly.
    const recent = new Map<string, { actor: Actor; at: number }>();
    const remember = (contactId: string, actor: Actor) => {
      recent.set(contactId, { actor, at: Date.now() });
      if (recent.size > 2000) for (const [k, v] of recent) if (Date.now() - v.at > 10_000) recent.delete(k);
    };
    app.afterWrite.push((ctx, route) => {
      if (!ctx.locationId) return;
      if (route.pattern === '/api/contacts/:id' && ctx.method === 'PATCH') remember(ctx.params.id, actorOf(ctx));
      else if ((route.pattern === '/api/contacts/bulk-owner' || route.pattern === '/api/contacts/bulk') && Array.isArray(ctx.body?.ids)) for (const id of ctx.body.ids.slice(0, 1000)) remember(String(id), actorOf(ctx));
    });

    app.events.on('contact.updated', (e) => {
      const { previous: prev, contact: cur, contactId } = e.data ?? {};
      // A merge writes its own entry naming what came from where (services/contact-merge.ts).
      if (!prev || !cur || !contactId || (Array.isArray(e.data.changed) && e.data.changed.includes('merged'))) return;
      const changes = diffContact(prev, cur);
      if (!changes.length) return;
      const r = recent.get(contactId);
      const viaWorkflow = e.data.viaWorkflow ? db.get<{ name: string }>('SELECT name FROM workflows WHERE id = ?', e.data.viaWorkflow)?.name : undefined;
      const actor: Actor = viaWorkflow !== undefined ? { kind: 'workflow', id: e.data.viaWorkflow, name: `Workflow „${viaWorkflow}“` } : r && Date.now() - r.at < 10_000 ? r.actor : { kind: 'system', id: null, name: 'System' };
      const labels = customLabels(e.locationId);
      for (const ch of changes.slice(0, 25)) {
        const key = ch.field.startsWith('custom.') ? ch.field.slice(7) : ch.field;
        const label = ch.field.startsWith('custom.') ? (labels.get(key) ?? key) : (CONTACT_LABELS[ch.field] ?? ch.field);
        const show = (v: string) => (ch.field === 'assigned_to' ? userName(v) || v : ch.field === 'dnd' ? (Number(v) ? 'an' : 'aus') : v);
        const oldV = short(show(ch.old));
        const newV = short(show(ch.new));
        const text = SENSITIVE_CONTACT.test(ch.field) ? `${label} geändert · ${actor.name}` : `${label}: ${oldV || '–'} → ${newV || '–'} · ${actor.name}`;
        record(e.locationId, contactId, null, ch.field, label, oldV, newV, actor, text);
      }
    });

    // --- deals: the row before the request (guard) and after it (afterWrite) ------------------------------------------------
    const before = new WeakMap<Ctx, Record<string, any>>();
    app.guards.push((ctx, auth) => {
      if (auth !== 'location' || ctx.method !== 'PATCH' || !ctx.locationId) return;
      const m = /^\/api\/opportunities\/([^/]+)$/.exec(ctx.path);
      if (!m) return;
      let dealId: string;
      try {
        dealId = decodeURIComponent(m[1]);
      } catch {
        return; // a malformed path: the route answers it itself
      }
      const row = db.get<Record<string, any>>('SELECT * FROM opportunities WHERE id = ? AND location_id = ?', dealId, ctx.locationId);
      if (row) before.set(ctx, row);
    });
    app.afterWrite.push((ctx, route) => {
      if (route.pattern !== '/api/opportunities/:id' || ctx.method !== 'PATCH') return;
      const was = before.get(ctx);
      if (!was) return;
      const now = db.get<Record<string, any>>('SELECT * FROM opportunities WHERE id = ?', was.id);
      if (!now) return;
      const actor = actorOf(ctx);
      const pipes = new Map<string, { name: string; stages: { id: string; name: string }[] }>();
      const pipe = (pid: string) => {
        if (!pipes.has(pid)) {
          const p = db.get<{ name: string; stages: string }>('SELECT name, stages FROM pipelines WHERE id = ?', pid);
          pipes.set(pid, { name: p?.name ?? '', stages: p ? JSON.parse(p.stages || '[]') : [] });
        }
        return pipes.get(pid)!;
      };
      for (const [f, label] of Object.entries(DEAL_FIELDS)) {
        const a = was[f] ?? '';
        const b = now[f] ?? '';
        if (String(a) === String(b)) continue;
        const show = (v: any, row: Record<string, any>) =>
          f === 'stage_id' ? (pipe(row.pipeline_id).stages.find((s) => s.id === v)?.name ?? v) : f === 'pipeline_id' ? pipe(String(v)).name || v : f === 'assigned_to' ? userName(v) || v : v;
        const oldV = short(show(a, was));
        const newV = short(show(b, now));
        const text = SENSITIVE_DEAL.test(f) ? `Deal „${short(now.name)}“ – ${label} geändert · ${actor.name}` : `Deal „${short(now.name)}“ – ${label}: ${oldV || '–'} → ${newV || '–'} · ${actor.name}`;
        record(ctx.locationId, now.contact_id, now.id, f, label, oldV, newV, actor, text);
      }
    });

    router.get('/api/contacts/:id/field-history', 'location', (ctx) => {
      const limit = Math.max(1, Math.min(500, Number(ctx.query.get('limit')) || 100));
      const access = resolve(app, ctx);
      const scope = scopeClause(access, 'contacts', 'c');
      if (!db.get(`SELECT 1 AS x FROM contacts c WHERE c.id = ? AND c.location_id = ?${scope ? ` AND ${scope.sql}` : ''}`, ctx.params.id, ctx.locationId, ...((scope?.params ?? []) as string[]))) return [];
      const rows = db.all<any>('SELECT id, opportunity_id, field, label, old, new, actor_kind, actor_id, actor_name, created_at FROM field_changes WHERE contact_id = ? AND location_id = ? ORDER BY created_at DESC LIMIT ?', ctx.params.id, ctx.locationId, limit);
      // Changes of a deal the person may not open are left out (same scope as the deal list).
      const dealOk = new Map<string, boolean>();
      const mayOpen = (dealId: string) => dealOk.get(dealId) ?? (dealOk.set(dealId, permits(app, access, 'deals', dealId)), dealOk.get(dealId)!);
      // A field the person may not see keeps its entry but loses the values (same rule as the record itself: maskRow on a probe row,
      // own fields as `custom.<key>` inside `custom`, so both "alle eigenen Felder" and a single hidden own field apply).
      const hiddenFor = (entity: 'contacts' | 'deals', field: string) => {
        if (!access) return false;
        if (field.startsWith('custom.')) {
          const key = field.slice(7);
          const masked = maskRow(access, entity, { custom: { [key]: 'x' } });
          return masked.custom?.[key] !== 'x';
        }
        const k = hideKey(field);
        return maskRow(access, entity, { [k]: 'x' })[k] !== 'x';
      };
      return rows
        .filter((r) => !r.opportunity_id || mayOpen(r.opportunity_id))
        .map((r) => (hiddenFor(r.opportunity_id ? 'deals' : 'contacts', r.field) ? { ...r, old: '', new: '', hidden: true } : r));
    });
  },
};
