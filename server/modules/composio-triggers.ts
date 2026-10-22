import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { upsertContact } from '../services/contacts.js';
import { ComposioError, guessContact, normalizeEvent, userIdFor, verifyWebhook, type IncomingEvent } from '../services/composio.js';
import { coerceArgs, schemaPaths } from '../services/composio-schema.js';
import { applyMapping, cleanMapping, flattenPaths } from '../services/inbound-webhooks.js';
import { mapStatus, type ComposioApi } from './composio.js';

/**
 * Workflow trigger "App-Ereignis (Composio)": a sub-account subscribes to a Composio trigger of a
 * connected app (new Shopify order, Typeform response, Calendly booking, Stripe charge, GitHub
 * issue …). Composio posts each event to /hooks/composio/<agency|locationId>, signed with the
 * project's webhook secret. The event creates or updates a contact (by e-mail/phone, optional field
 * mapping) and starts the workflows with the payload as {{event.*}}.
 */

export const APP_EVENT = 'composio.event';
const SLUG_RE = /^[A-Za-z0-9_]{2,150}$/;
const TOOLKIT_RE = /^[a-z0-9_-]{1,80}$/i;
const MAX_EVENT_BYTES = 50_000;

/** Large payloads (a whole Shopify order) are cut to their top-level values for the workflow run. */
export function slimPayload(data: Record<string, any>, max = MAX_EVENT_BYTES): Record<string, any> {
  if (JSON.stringify(data).length <= max) return data;
  const out: Record<string, any> = { truncated: true };
  for (const [k, v] of Object.entries(data)) {
    if (v === null || typeof v !== 'object') out[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
    else if (JSON.stringify(v).length < 4000) out[k] = v;
  }
  return out;
}

export const composioTriggersModule: Module = {
  name: 'composio-triggers',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE composio_triggers (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        toolkit TEXT NOT NULL, toolkit_name TEXT NOT NULL DEFAULT '', trigger_slug TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
        config TEXT NOT NULL DEFAULT '{}', mapping TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]',
        composio_id TEXT, connected_account_id TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', last_error TEXT NOT NULL DEFAULT '',
        events INTEGER NOT NULL DEFAULT 0, last_event_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX composio_triggers_cid ON composio_triggers(composio_id);
      CREATE INDEX composio_triggers_loc ON composio_triggers(location_id);
      CREATE TABLE composio_events (
        id TEXT PRIMARY KEY, msg_id TEXT NOT NULL UNIQUE, location_id TEXT, trigger_id TEXT, type TEXT NOT NULL,
        contact_id TEXT, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE INDEX composio_events_trigger ON composio_events(trigger_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), APP_EVENT];
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      [APP_EVENT]: (c: Record<string, any>, d: Record<string, any>) => (!c.subscription_id || c.subscription_id === d.subscriptionId) && (!c.app || c.app === d.app),
    };
    app.services.composioTriggers = {
      onDisconnect: (loc: string, ca: string) =>
        db.run(`UPDATE composio_triggers SET status = 'error', last_error = 'App wurde getrennt', updated_at = ? WHERE location_id = ? AND connected_account_id = ?`, now(), loc, ca),
    };

    const composio = (): ComposioApi => {
      const c = app.services.composio as ComposioApi | undefined;
      if (!c) throw new HttpError(404, 'Das Composio-Modul ist nicht installiert.');
      return c;
    };
    const out = (r: any) => ({
      id: r.id,
      toolkit: r.toolkit,
      toolkit_name: r.toolkit_name || r.toolkit,
      trigger_slug: r.trigger_slug,
      name: r.name || r.trigger_slug,
      config: JSON.parse(r.config || '{}'),
      mapping: JSON.parse(r.mapping || '[]'),
      tags: JSON.parse(r.tags || '[]'),
      status: r.status,
      last_error: r.last_error,
      events: r.events,
      last_event_at: r.last_event_at,
      created_at: r.created_at,
    });
    const getRow = (loc: string, tid: string) => {
      const r = db.get('SELECT * FROM composio_triggers WHERE id = ? AND location_id = ?', tid, loc);
      if (!r) throw notFound('Auslöser nicht gefunden');
      return r;
    };
    const customKeys = (loc: string) => db.all('SELECT key FROM custom_fields WHERE location_id = ?', loc).map((r) => String(r.key));
    const cleanTags = (v: unknown) => (Array.isArray(v) ? v.map((t) => String(t).trim().slice(0, 60)).filter(Boolean).slice(0, 20) : []);
    const mappingOf = (loc: string, v: unknown) => {
      try {
        return cleanMapping(v, customKeys(loc));
      } catch (e) {
        throw bad((e as Error).message);
      }
    };
    const fail = (e: unknown): never => {
      if (e instanceof ComposioError) throw new HttpError(e.status, e.message);
      throw e;
    };

    router.get('/api/composio/triggers/types', 'location', async (ctx) => {
      const toolkit = str(ctx.query.get('toolkit'), 'App', { required: true, max: 80 }).toLowerCase();
      if (!TOOLKIT_RE.test(toolkit)) throw bad('Unbekannte App');
      const c = composio();
      const info = c.requireKey(ctx.locationId);
      const types = await c.call(() => c.client(info).listTriggerTypes(toolkit));
      return types.map((t) => ({ ...t, payload_paths: schemaPaths(t.payload) }));
    });
    router.get('/api/composio/triggers', 'location', (ctx) => {
      const c = app.services.composio as ComposioApi | undefined;
      const info = c?.keyInfo(ctx.locationId);
      return {
        webhook_url: info && c ? `${app.baseUrl()}/hooks/composio/${c.scopeKey(ctx.locationId, info)}` : null,
        items: db.all('SELECT * FROM composio_triggers WHERE location_id = ? ORDER BY created_at DESC', ctx.locationId).map(out),
      };
    });
    router.post('/api/composio/triggers', 'location', async (ctx) => {
      const loc = ctx.locationId;
      const toolkit = str(ctx.body.toolkit, 'App', { required: true, max: 80 }).toLowerCase();
      const slug = str(ctx.body.trigger_slug, 'Ereignis', { required: true, max: 150 }).toUpperCase();
      if (!TOOLKIT_RE.test(toolkit) || !SLUG_RE.test(slug)) throw bad('Unbekanntes App-Ereignis');
      const c = composio();
      const info = c.requireKey(loc);
      const conn = c.activeConnection(loc, toolkit, info.scope);
      if (!conn) throw new HttpError(409, 'Diese App ist in diesem Sub-Account nicht verbunden (Apps → Composio → Verbinden).');
      const type = await c.call(() => c.client(info).getTriggerType(slug));
      if (type.toolkit && type.toolkit.toLowerCase() !== toolkit) throw bad('Das Ereignis gehört zu einer anderen App.');
      const { args: config, errors } = coerceArgs(type.config, ctx.body.config ?? {});
      if (errors.length) throw bad(`Einstellungen passen nicht: ${errors.slice(0, 6).join('; ')}`);
      const mapping = mappingOf(loc, ctx.body.mapping);
      const hook = await c.ensureWebhook(loc);
      const composioId = await c.client(info).upsertTrigger(slug, { userId: userIdFor(loc), connectedAccountId: conn.connected_account_id, config, egressUrl: hook.egress }).catch(fail);
      const row = {
        id: id(),
        location_id: loc,
        toolkit,
        toolkit_name: conn.toolkit_name || toolkit,
        trigger_slug: slug,
        name: str(ctx.body.name, 'Name', { max: 120 }) || type.name,
        config,
        mapping,
        tags: cleanTags(ctx.body.tags),
        composio_id: composioId,
        connected_account_id: conn.connected_account_id,
        scope: info.scope,
        status: 'active',
        last_error: '',
        events: 0,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('composio_triggers', row);
      return out(db.get('SELECT * FROM composio_triggers WHERE id = ?', row.id));
    });
    router.patch('/api/composio/triggers/:id', 'location', async (ctx) => {
      const r = getRow(ctx.locationId, ctx.params.id);
      const patch: Record<string, unknown> = { updated_at: now() };
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { max: 120 });
      if (ctx.body.mapping !== undefined) patch.mapping = JSON.stringify(mappingOf(ctx.locationId, ctx.body.mapping));
      if (ctx.body.tags !== undefined) patch.tags = JSON.stringify(cleanTags(ctx.body.tags));
      if (ctx.body.status !== undefined) {
        if (!['active', 'paused'].includes(ctx.body.status)) throw bad('Unbekannter Status');
        const c = composio();
        const info = c.requireKey(ctx.locationId);
        if (r.composio_id) await c.client(info).setTriggerStatus(r.composio_id, ctx.body.status === 'active').catch(fail);
        patch.status = ctx.body.status;
        patch.last_error = '';
      }
      db.update('composio_triggers', r.id, patch);
      return out(db.get('SELECT * FROM composio_triggers WHERE id = ?', r.id));
    });
    router.delete('/api/composio/triggers/:id', 'location', async (ctx) => {
      const r = getRow(ctx.locationId, ctx.params.id);
      const c = app.services.composio as ComposioApi | undefined;
      const info = c?.keyInfo(ctx.locationId);
      if (c && info && r.composio_id && info.scope === r.scope) {
        try {
          await c.client(info).deleteTrigger(r.composio_id);
        } catch (e) {
          if (!(e instanceof ComposioError && e.status === 404)) fail(e);
        }
      }
      db.run('DELETE FROM composio_triggers WHERE id = ?', r.id);
      db.run('DELETE FROM composio_events WHERE trigger_id = ?', r.id);
      return { ok: true };
    });
    router.get('/api/composio/triggers/:id/events', 'location', (ctx) => {
      const r = getRow(ctx.locationId, ctx.params.id);
      return db.all('SELECT id, type, contact_id, status, detail, payload, created_at FROM composio_events WHERE trigger_id = ? ORDER BY created_at DESC LIMIT 50', r.id).map((e) => ({ ...e, payload: JSON.parse(e.payload || '{}') }));
    });
    /** Shows which contact an event would create – with a pasted payload or the last one received. */
    router.post('/api/composio/triggers/:id/preview', 'location', (ctx) => {
      const r = getRow(ctx.locationId, ctx.params.id);
      let payload = ctx.body.payload;
      if (payload === undefined) payload = JSON.parse(db.get('SELECT payload FROM composio_events WHERE trigger_id = ? ORDER BY created_at DESC LIMIT 1', r.id)?.payload ?? 'null');
      if (!payload || typeof payload !== 'object') return { contact: null, tags: [], ok: false, paths: [] };
      const mapping = ctx.body.mapping !== undefined ? mappingOf(ctx.locationId, ctx.body.mapping) : JSON.parse(r.mapping);
      const c = contactFrom(payload, mapping, JSON.parse(r.tags));
      return { contact: c.input, tags: c.tags, ok: !!(c.input.email || c.input.phone), paths: flattenPaths(payload) };
    });

    // --- incoming events ---------------------------------------------------------------------------
    const contactFrom = (data: Record<string, any>, mapping: any[], tags: string[]) => {
      const r = mapping.length ? applyMapping(data, mapping, tags) : { input: guessContact(data) as Record<string, any>, tags };
      const input = r.input;
      if (input.name && !input.first_name && !input.last_name) {
        const [a, ...rest] = String(input.name).trim().split(/\s+/);
        input.first_name = a;
        if (rest.length) input.last_name = rest.join(' ');
      }
      delete input.name;
      return { input, tags: r.tags };
    };
    const record = (msgId: string, e: { location_id?: string | null; trigger_id?: string | null; type: string; status: string; detail?: string; contact_id?: string | null; payload?: unknown }) => {
      db.run(
        'UPDATE composio_events SET location_id = ?, trigger_id = ?, type = ?, status = ?, detail = ?, contact_id = ?, payload = ? WHERE msg_id = ?',
        e.location_id ?? null,
        e.trigger_id ?? null,
        e.type,
        e.status,
        (e.detail ?? '').slice(0, 300),
        e.contact_id ?? null,
        JSON.stringify(e.payload ?? {}).slice(0, 20_000),
        msgId,
      );
    };

    /** Contact + workflow start for one event of a subscribed trigger. */
    const handle = (row: any, ev: IncomingEvent, msgId: string) => {
      const data = ev.data ?? {};
      const { input, tags } = contactFrom(data, JSON.parse(row.mapping || '[]'), JSON.parse(row.tags || '[]'));
      db.run('UPDATE composio_triggers SET events = events + 1, last_event_at = ?, last_error = ? WHERE id = ?', now(), '', row.id);
      if (!input.email && !input.phone) {
        record(msgId, { location_id: row.location_id, trigger_id: row.id, type: ev.triggerSlug || ev.type, status: 'no_contact', detail: 'Keine E-Mail oder Telefonnummer im Ereignis – Feldzuordnung prüfen', payload: data });
        return null;
      }
      const { contact } = upsertContact(app, row.location_id, input, { source: `App: ${row.toolkit_name || row.toolkit}`, tags });
      app.events.emit(row.location_id, APP_EVENT, { ...slimPayload(data), contactId: contact.id, subscriptionId: row.id, app: row.toolkit, trigger: row.trigger_slug });
      record(msgId, { location_id: row.location_id, trigger_id: row.id, type: ev.triggerSlug || ev.type, status: 'ok', contact_id: contact.id, payload: data });
      return contact.id;
    };

    router.post('/hooks/composio/:scope', 'public', async (ctx: Ctx) => {
      const sk = ctx.params.scope;
      const c = app.services.composio as ComposioApi | undefined;
      if (!c || (sk !== 'agency' && !app.location(sk))) throw notFound();
      let secret = c.webhookSecret(sk);
      if (!secret && (await c.refreshWebhookSecret(sk))) secret = c.webhookSecret(sk);
      if (!secret) throw notFound();
      const h = { id: String(ctx.req.headers['webhook-id'] ?? ''), timestamp: String(ctx.req.headers['webhook-timestamp'] ?? ''), signature: String(ctx.req.headers['webhook-signature'] ?? '') };
      let ok = verifyWebhook(secret, h, ctx.rawBody);
      if (!ok && h.signature && (await c.refreshWebhookSecret(sk))) ok = verifyWebhook(c.webhookSecret(sk) ?? '', h, ctx.rawBody);
      if (!ok) throw new HttpError(401, 'Signatur ungültig');

      const msgId = `${sk}:${h.id}`.slice(0, 300);
      // Composio retries deliveries: the webhook-id is processed once.
      try {
        db.insert('composio_events', { id: id(), msg_id: msgId, type: 'pending', status: 'processing', created_at: now() });
      } catch {
        return { ok: true, duplicate: true };
      }
      try {
        let payload: unknown;
        try {
          payload = JSON.parse(ctx.rawBody);
        } catch {
          payload = null;
        }
        const ev = normalizeEvent(payload);
        if (!ev) {
          record(msgId, { type: 'unknown', status: 'ignored', detail: 'Unbekanntes Format' });
          return { ok: true, ignored: true };
        }
        const inScope = (scope: string, loc: string) => (sk === 'agency' ? scope === 'agency' : scope === 'location' && loc === sk);
        if (ev.type.startsWith('composio.connected_account.')) {
          const conn = ev.connectedAccountId ? c.connectionByAccount(ev.connectedAccountId) : undefined;
          if (conn && inScope(conn.scope, conn.location_id)) c.setStatus(conn.connected_account_id, ev.type.endsWith('.expired') ? 'expired' : mapStatus(String(ev.data.status ?? '')), String(ev.data.status_reason ?? ''));
          record(msgId, { location_id: conn?.location_id, type: ev.type, status: conn ? 'ok' : 'ignored', payload: ev.data });
          return { ok: true };
        }
        const row = ev.triggerId ? db.get('SELECT * FROM composio_triggers WHERE composio_id = ?', ev.triggerId) : undefined;
        if (!row || !inScope(row.scope, row.location_id)) {
          record(msgId, { type: ev.triggerSlug || ev.type, status: 'ignored', detail: 'Unbekannter Auslöser' });
          return { ok: true, ignored: true };
        }
        if (ev.userId && ev.userId !== userIdFor(row.location_id)) {
          record(msgId, { location_id: row.location_id, trigger_id: row.id, type: ev.triggerSlug, status: 'ignored', detail: 'Ereignis gehört zu einem anderen Sub-Account' });
          return { ok: true, ignored: true };
        }
        if (row.status !== 'active') {
          record(msgId, { location_id: row.location_id, trigger_id: row.id, type: ev.triggerSlug, status: 'ignored', detail: 'Auslöser pausiert', payload: ev.data });
          return { ok: true, ignored: true };
        }
        const contactId = handle(row, ev, msgId);
        return { ok: true, contactId };
      } catch (e) {
        // Let Composio deliver again.
        db.run('DELETE FROM composio_events WHERE msg_id = ?', msgId);
        throw e;
      }
    });

    app.onTick(() => void db.run('DELETE FROM composio_events WHERE created_at < ?', new Date(Date.now() - 30 * 864e5).toISOString()));
    workflowRecipes(app);
  },
};

/** Ready-made workflow: new app event → tag + task (shows how {{event.*}} works). */
function workflowRecipes(app: App) {
  app.services.workflowRecipes = {
    ...(app.services.workflowRecipes ?? {}),
    composio_event: {
      name: 'App-Ereignis: Kontakt taggen + Aufgabe',
      trigger: { type: APP_EVENT, config: {} },
      steps: [
        { type: 'add_tag', tags: ['app-ereignis'] },
        { type: 'create_task', title: 'Neues Ereignis aus {{event.app}} für {{contact.name}} prüfen', due_in_days: 0 },
      ],
    },
  };
}
