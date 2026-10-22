import type { Module } from '../core/app.js';
import type { AppEvent } from '../core/events.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, notFound, num, str, type Ctx } from '../core/http.js';
import { id, normalizeEmail, normalizePhone, now, token } from '../core/util.js';
import { getContact } from '../services/contacts.js';
import { safeFetch, type SafeResponse } from '../services/net.js';
import { callRoute } from '../services/route-call.js';
import {
  FILTER_LABELS,
  GONE_LIMIT,
  HOOK_ACTIONS,
  HOOK_TRIGGERS,
  buildPayload,
  cleanFilters,
  detectSource,
  filtersMatch,
  invoiceItems,
  retryDelayMs,
  shouldRetry,
  signBody,
  hmacSignature,
  staticSample,
  toList,
  triggerByKey,
  triggersForEvent,
} from '../services/rest-hooks.js';
import { APP_VERSION } from '../version.js';
import { openIfSealed, sealSecret } from '../core/secrets.js';

/**
 * REST hooks for Zapier, Make and n8n: subscribe/unsubscribe a target URL to a trigger, signed
 * deliveries with retries and backoff, a delivery log, auto-off after repeated 410 Gone, sample
 * data for setup screens and action endpoints that relay onto the normal REST API.
 * Test hook: app.services.restHookFetch replaces the outbound HTTP call.
 */

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; timeoutMs: number; maxBytes: number }) => Promise<SafeResponse>;

const MAX_HOOKS = 200;
const KEEP_SAMPLES = 3;
const KEEP_DAYS = 30;

const CONTACT_KEYS = ['first_name', 'last_name', 'email', 'phone', 'company', 'address', 'city', 'postal_code', 'country', 'website', 'source', 'date_of_birth'];

function parseObj(v: unknown): Record<string, any> | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, any>;
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      return JSON.parse(v);
    } catch {
      throw bad('custom: ungültiges JSON');
    }
  }
  return undefined;
}

/** Contact fields of an action body (Zapier/Make send flat fields). */
function contactInput(b: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const k of CONTACT_KEYS) if (b[k] !== undefined && b[k] !== null && b[k] !== '') out[k] = String(b[k]);
  if (b.name && !out.first_name && !out.last_name) out.name = String(b.name);
  const tags = toList(b.tags);
  if (tags.length) out.tags = tags;
  const custom = parseObj(b.custom);
  if (custom) out.custom = custom;
  return out;
}

export const restHooksModule: Module = {
  name: 'rest-hooks',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE rest_hooks (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        event TEXT NOT NULL, target_url TEXT NOT NULL, filters TEXT NOT NULL DEFAULT '{}', secret TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'api', label TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
        gone_count INTEGER NOT NULL DEFAULT 0, fail_streak INTEGER NOT NULL DEFAULT 0, disabled_reason TEXT,
        created_via TEXT, last_delivery_at TEXT, last_status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX rest_hooks_loc ON rest_hooks(location_id, event, status);
      CREATE TABLE rest_hook_deliveries (
        id TEXT PRIMARY KEY, hook_id TEXT NOT NULL, location_id TEXT NOT NULL, target_url TEXT NOT NULL,
        event_id TEXT NOT NULL, event TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
        response_status INTEGER, response_body TEXT, error TEXT, duration_ms INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX rest_hook_deliveries_loc ON rest_hook_deliveries(location_id, created_at);
      CREATE INDEX rest_hook_deliveries_hook ON rest_hook_deliveries(hook_id, created_at);
      CREATE INDEX rest_hook_deliveries_due ON rest_hook_deliveries(status, next_attempt_at);
      CREATE TABLE rest_hook_samples (
        location_id TEXT NOT NULL, event TEXT NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (location_id, event, event_id)
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const fetcher = (): Fetcher => app.services.restHookFetch ?? safeFetch;

    // Tasks finished in the app become an event (workflows + REST hooks).
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), 'task.completed'];

    // GDPR erasure: the stored sample payloads and the delivery log carry the whole contact – the ones about the person go
    // (deliveries still waiting are not sent any more).
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: unknown, loc: string, contact: { id: string; email?: string }) => {
        for (const needle of [contact.id, normalizeEmail(contact.email)].filter((s) => s.length >= 5)) {
          for (const table of ['rest_hook_samples', 'rest_hook_deliveries']) db.run(`DELETE FROM ${table} WHERE location_id = ? AND instr(lower(payload), lower(?)) > 0`, loc, needle);
        }
      },
    ];

    // The signing secret is stored sealed; the owner sees it in plain text to verify deliveries.
    const hookOut = (h: any) => {
      const r = parseJson({ ...h }, ['filters']);
      return { ...r, secret: openIfSealed(app, r.secret), trigger_label: triggerByKey(r.event)?.label ?? r.event };
    };
    const getHook = (loc: string, hid: string) => db.get('SELECT * FROM rest_hooks WHERE id = ? AND location_id = ?', hid, loc);

    // --- delivery -----------------------------------------------------------------------
    async function attempt(deliveryId: string): Promise<any> {
      const d = db.get('SELECT * FROM rest_hook_deliveries WHERE id = ?', deliveryId);
      if (!d) return undefined;
      const hook = db.get('SELECT * FROM rest_hooks WHERE id = ?', d.hook_id);
      if (!hook) {
        db.run(`UPDATE rest_hook_deliveries SET status = 'cancelled', error = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?`, 'Abo gelöscht', now(), d.id);
        return db.get('SELECT * FROM rest_hook_deliveries WHERE id = ?', d.id);
      }
      db.run(`UPDATE rest_hook_deliveries SET status = 'pending', updated_at = ? WHERE id = ?`, now(), d.id);
      const attempts = Number(d.attempts) + 1;
      const headers = {
        'content-type': 'application/json',
        'user-agent': `HyperLevel-RestHooks/${APP_VERSION}`,
        'x-pghl-signature': signBody(openIfSealed(app, hook.secret), d.payload),
        'x-pghl-signature-256': hmacSignature(openIfSealed(app, hook.secret), d.payload),
        'x-pghl-event': d.event,
        'x-pghl-delivery': d.id,
        'x-pghl-hook': hook.id,
        'x-pghl-attempt': String(attempts),
      };
      const started = Date.now();
      let status = 0;
      let body = '';
      let error = '';
      try {
        const r = await fetcher()(hook.target_url, { method: 'POST', headers, body: d.payload, timeoutMs: 10_000, maxBytes: 64_000 });
        status = r.status;
        body = (await r.text().catch(() => '')).slice(0, 2000);
      } catch (e) {
        error = (e as Error).message.slice(0, 500);
      }
      const ms = Date.now() - started;
      const at = now();
      let next: string | null = null;
      let state: string;
      if (status >= 200 && status < 300) {
        state = 'success';
        db.run(`UPDATE rest_hooks SET gone_count = 0, fail_streak = 0, last_delivery_at = ?, last_status = ?, updated_at = ? WHERE id = ?`, at, `${status} ${d.event}`, at, hook.id);
      } else if (status === 410) {
        state = 'gone';
        const gone = Number(hook.gone_count) + 1;
        const off = gone >= GONE_LIMIT;
        db.run(
          `UPDATE rest_hooks SET gone_count = ?, last_delivery_at = ?, last_status = ?, status = ?, disabled_reason = ?, updated_at = ? WHERE id = ?`,
          gone,
          at,
          `410 ${d.event}`,
          off ? 'disabled' : hook.status,
          off ? `Ziel antwortet ${GONE_LIMIT}× mit 410 Gone – automatisch deaktiviert` : hook.disabled_reason,
          at,
          hook.id,
        );
        if (off) db.run(`UPDATE rest_hook_deliveries SET status = 'cancelled', next_attempt_at = NULL, error = 'Abo deaktiviert', updated_at = ? WHERE hook_id = ? AND status = 'retrying'`, at, hook.id);
      } else {
        const delay = shouldRetry(status) ? retryDelayMs(attempts) : null;
        state = delay === null ? 'failed' : 'retrying';
        if (delay !== null) next = new Date(Date.now() + delay).toISOString();
        db.run(`UPDATE rest_hooks SET fail_streak = fail_streak + 1, last_delivery_at = ?, last_status = ?, updated_at = ? WHERE id = ?`, at, error ? `Fehler: ${error}` : `${status} ${d.event}`, at, hook.id);
      }
      db.run(
        `UPDATE rest_hook_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, response_status = ?, response_body = ?, error = ?, duration_ms = ?, updated_at = ? WHERE id = ?`,
        state,
        attempts,
        next,
        status || null,
        body,
        error || null,
        ms,
        at,
        d.id,
      );
      return db.get('SELECT * FROM rest_hook_deliveries WHERE id = ?', d.id);
    }

    function queue(hook: any, eventKey: string, type: string, eventId: string, payload: Record<string, any>) {
      const row = {
        id: `dlv_${id(18)}`,
        hook_id: hook.id,
        location_id: hook.location_id,
        target_url: hook.target_url,
        event_id: eventId,
        event: eventKey,
        type,
        payload: JSON.stringify(payload),
        status: 'pending',
        attempts: 0,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('rest_hook_deliveries', row);
      return row.id;
    }

    function storeSample(loc: string, key: string, eventId: string, payload: unknown) {
      db.run('INSERT OR REPLACE INTO rest_hook_samples (location_id, event, event_id, payload, created_at) VALUES (?, ?, ?, ?, ?)', loc, key, eventId, JSON.stringify(payload), now());
      db.run(
        `DELETE FROM rest_hook_samples WHERE location_id = ? AND event = ? AND event_id NOT IN (SELECT event_id FROM rest_hook_samples WHERE location_id = ? AND event = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
        loc,
        key,
        loc,
        key,
        KEEP_SAMPLES,
      );
    }

    app.events.on('*', async (e: AppEvent) => {
      if (!e.locationId) return;
      const triggers = triggersForEvent(e);
      if (!triggers.length) return;
      const eventId = `evt_${id(20)}`;
      const contact = e.data?.contactId ? (getContact(app, e.locationId, String(e.data.contactId)) ?? null) : null;
      const due: string[] = [];
      for (const t of triggers) {
        const payload = buildPayload(t.key, e, eventId, contact);
        storeSample(e.locationId, t.key, eventId, payload);
        const hooks = db.all(`SELECT * FROM rest_hooks WHERE location_id = ? AND event = ? AND status = 'active'`, e.locationId, t.key);
        for (const h of hooks) if (filtersMatch(JSON.parse(h.filters || '{}'), e)) due.push(queue(h, t.key, e.type, eventId, payload));
      }
      for (const d of due) await attempt(d);
    });

    let lastPrune = 0;
    app.onTick(async () => {
      const due = db.all(`SELECT id FROM rest_hook_deliveries WHERE status = 'retrying' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 100`, now());
      for (const d of due) {
        const hook = db.get('SELECT h.status FROM rest_hooks h JOIN rest_hook_deliveries d ON d.hook_id = h.id WHERE d.id = ?', d.id);
        if (hook && hook.status !== 'active') {
          db.run(`UPDATE rest_hook_deliveries SET status = 'cancelled', next_attempt_at = NULL, error = 'Abo pausiert oder deaktiviert', updated_at = ? WHERE id = ?`, now(), d.id);
          continue;
        }
        await attempt(d.id);
      }
      // Deliveries left 'pending' by a crash get another try.
      db.run(`UPDATE rest_hook_deliveries SET status = 'retrying', next_attempt_at = ? WHERE status = 'pending' AND updated_at < ?`, now(), new Date(Date.now() - 10 * 6e4).toISOString());
      if (Date.now() - lastPrune > 3600_000) {
        lastPrune = Date.now();
        db.run('DELETE FROM rest_hook_deliveries WHERE created_at < ?', new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
        // Samples carry a whole contact: an event type that went quiet keeps them no longer than the delivery log (then the
        // sample endpoint answers with the made-up example again).
        db.run('DELETE FROM rest_hook_samples WHERE created_at < ?', new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
      }
    });

    // --- catalogue & auth test ------------------------------------------------------------
    router.get('/api/hooks/me', 'location', (ctx) => {
      const loc = app.location(ctx.locationId)!;
      return { ok: true, location: { id: loc.id, name: loc.name, timezone: loc.timezone }, via: ctx.via, label: `${loc.name}` };
    });
    router.get('/api/hooks/triggers', 'location', () =>
      HOOK_TRIGGERS.map((t) => ({ key: t.key, label: t.label, description: t.description, events: t.events, filters: t.filters.map((f) => ({ key: f, label: FILTER_LABELS[f] })) })),
    );
    router.get('/api/hooks/actions', 'location', () => HOOK_ACTIONS);
    router.get('/api/hooks/triggers/:key/sample', 'location', (ctx) => {
      const t = triggerByKey(ctx.params.key);
      if (!t) throw notFound('Unbekannter Auslöser');
      const rows = db.all('SELECT payload FROM rest_hook_samples WHERE location_id = ? AND event = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', ctx.locationId, t.key, KEEP_SAMPLES);
      return rows.length ? rows.map((r) => JSON.parse(r.payload)) : [staticSample(t, ctx.locationId)];
    });

    // --- delivery log ----------------------------------------------------------------------
    router.get('/api/hooks/deliveries', 'location', (ctx) => {
      const where = ['location_id = ?'];
      const params: any[] = [ctx.locationId];
      for (const [q, col] of [['hook_id', 'hook_id'], ['status', 'status'], ['event', 'event']] as const) {
        const v = ctx.query.get(q);
        if (v) (where.push(`${col} = ?`), params.push(v));
      }
      const limit = Math.min(Math.max(num(ctx.query.get('limit'), 50), 1), 200);
      const offset = Math.max(num(ctx.query.get('offset'), 0), 0);
      const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM rest_hook_deliveries WHERE ${where.join(' AND ')}`, ...params)!.n;
      const deliveries = db.all(
        `SELECT id, hook_id, target_url, event_id, event, type, status, attempts, next_attempt_at, response_status, error, duration_ms, created_at, updated_at
         FROM rest_hook_deliveries WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      );
      const counts = Object.fromEntries(db.all(`SELECT status, COUNT(*) n FROM rest_hook_deliveries WHERE location_id = ? AND created_at >= ? GROUP BY status`, ctx.locationId, new Date(Date.now() - 7 * 864e5).toISOString()).map((r) => [r.status, r.n]));
      return { total, deliveries, counts_7d: counts };
    });
    router.get('/api/hooks/deliveries/:id', 'location', (ctx) => {
      const d = db.get('SELECT * FROM rest_hook_deliveries WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!d) throw notFound();
      return parseJson(d, ['payload']);
    });
    router.post('/api/hooks/deliveries/:id/retry', 'location', async (ctx) => {
      const d = db.get('SELECT * FROM rest_hook_deliveries WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!d) throw notFound();
      if (d.status === 'pending') throw bad('Wird gerade zugestellt');
      return parseJson(await attempt(d.id), ['payload']);
    });

    // --- searches (Zapier "Find …", Make search modules) -------------------------------------
    router.get('/api/hooks/search/contacts', 'location', (ctx) => {
      const q = ctx.query;
      const where = ['location_id = ?'];
      const params: any[] = [ctx.locationId];
      if (q.get('id')) (where.push('id = ?'), params.push(q.get('id')));
      if (q.get('email')) (where.push('email = ?'), params.push(normalizeEmail(q.get('email'))));
      if (q.get('phone')) (where.push('phone = ?'), params.push(normalizePhone(q.get('phone'))));
      if (q.get('q')) (where.push(`(first_name || ' ' || last_name || ' ' || email || ' ' || phone || ' ' || company) LIKE ?`), params.push(`%${q.get('q')}%`));
      if (where.length === 1) throw bad('id, email, phone oder q angeben');
      return parseRows(db.all(`SELECT * FROM contacts WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 10`, ...params), ['tags', 'custom']);
    });
    router.get('/api/hooks/search/opportunities', 'location', (ctx) => {
      const q = ctx.query;
      const where = ['o.location_id = ?'];
      const params: any[] = [ctx.locationId];
      if (q.get('id')) (where.push('o.id = ?'), params.push(q.get('id')));
      if (q.get('contact_id')) (where.push('o.contact_id = ?'), params.push(q.get('contact_id')));
      if (q.get('email')) (where.push('c.email = ?'), params.push(normalizeEmail(q.get('email'))));
      if (q.get('status')) (where.push('o.status = ?'), params.push(q.get('status')));
      if (q.get('q')) (where.push('o.name LIKE ?'), params.push(`%${q.get('q')}%`));
      if (where.length === 1) throw bad('id, contact_id, email, status oder q angeben');
      return db.all(
        `SELECT o.*, c.first_name, c.last_name, c.email FROM opportunities o LEFT JOIN contacts c ON c.id = o.contact_id WHERE ${where.join(' AND ')} ORDER BY o.updated_at DESC LIMIT 10`,
        ...params,
      );
    });

    // --- actions -------------------------------------------------------------------------------
    const findContact = (loc: string, b: Record<string, any>) => {
      if (b.contact_id) return getContact(app, loc, String(b.contact_id));
      const email = normalizeEmail(b.email);
      const phone = normalizePhone(b.phone);
      const row = (email && db.get('SELECT id FROM contacts WHERE location_id = ? AND email = ?', loc, email)) || (phone && db.get('SELECT id FROM contacts WHERE location_id = ? AND phone = ?', loc, phone));
      return row ? getContact(app, loc, row.id) : undefined;
    };
    const resolveContact = async (ctx: Ctx, b: Record<string, any>, create: boolean) => {
      const found = findContact(ctx.locationId, b);
      if (found) return found;
      if (b.contact_id) throw notFound('Kontakt nicht gefunden');
      if (create && (b.email || b.phone)) return callRoute(app, ctx, 'POST', '/api/contacts', { ...contactInput(b), source: b.source || sourceLabel(ctx) });
      throw notFound('Kontakt nicht gefunden – contact_id, email oder phone angeben');
    };
    const sourceLabel = (ctx: Ctx) => {
      const ua = String(ctx.req.headers['user-agent'] ?? '').toLowerCase();
      return ua.includes('zapier') ? 'Zapier' : ua.includes('make') || ua.includes('integromat') ? 'Make' : ua.includes('n8n') ? 'n8n' : 'API';
    };
    const pipelines = (loc: string) => parseRows(db.all('SELECT * FROM pipelines WHERE location_id = ? ORDER BY created_at', loc), ['stages']);
    const pickStage = (p: any, stage: unknown) => {
      if (!stage) return undefined;
      const s = String(stage).trim().toLowerCase();
      const hit = p.stages.find((x: any) => x.id === stage || String(x.name).toLowerCase() === s);
      if (!hit) throw bad(`Stufe „${stage}“ nicht gefunden – verfügbar: ${p.stages.map((x: any) => x.name).join(', ')}`);
      return hit.id;
    };

    const ACTIONS: Record<string, (ctx: Ctx, b: Record<string, any>) => Promise<any>> = {
      create_contact: async (ctx, b) => {
        const input = contactInput(b);
        if (!input.email && !input.phone && !input.first_name && !input.last_name && !input.name) throw bad('Name, E-Mail oder Telefon angeben');
        return callRoute(app, ctx, 'POST', '/api/contacts', { ...input, source: input.source || sourceLabel(ctx) });
      },
      update_contact: async (ctx, b) => {
        const c = await resolveContact(ctx, b, false);
        const { tags, email: _e, ...fields } = contactInput(b);
        if (b.new_email) fields.email = String(b.new_email);
        let out = await callRoute(app, ctx, 'PATCH', `/api/contacts/${c.id}`, fields);
        if (tags?.length) out = await callRoute(app, ctx, 'POST', `/api/contacts/${c.id}/tags`, { add: tags });
        return out;
      },
      add_tag: async (ctx, b) => {
        const tags = toList(b.tags ?? b.tag);
        if (!tags.length) throw bad('tags fehlt');
        const c = await resolveContact(ctx, b, true);
        return callRoute(app, ctx, 'POST', `/api/contacts/${c.id}/tags`, { add: tags });
      },
      remove_tag: async (ctx, b) => {
        const tags = toList(b.tags ?? b.tag);
        if (!tags.length) throw bad('tags fehlt');
        const c = await resolveContact(ctx, b, false);
        return callRoute(app, ctx, 'POST', `/api/contacts/${c.id}/tags`, { remove: tags });
      },
      create_opportunity: async (ctx, b) => {
        const list = pipelines(ctx.locationId);
        const want = b.pipeline ?? b.pipeline_id;
        const p = want ? list.find((x) => x.id === want || String(x.name).toLowerCase() === String(want).trim().toLowerCase()) : list[0];
        if (!p) throw bad(want ? `Pipeline „${want}“ nicht gefunden` : 'Keine Pipeline vorhanden');
        const c = await resolveContact(ctx, b, true);
        return callRoute(app, ctx, 'POST', '/api/opportunities', {
          pipeline_id: p.id,
          stage_id: pickStage(p, b.stage ?? b.stage_id),
          contact_id: c.id,
          name: b.name ? String(b.name) : undefined,
          value: b.value !== undefined && b.value !== '' ? Number(String(b.value).replace(',', '.')) : undefined,
          status: b.status || undefined,
          lost_reason: b.lost_reason || undefined,
          expected_close_date: b.expected_close_date || undefined,
          currency: b.currency || undefined,
          source: b.source || sourceLabel(ctx),
        });
      },
      move_stage: async (ctx, b) => {
        const oid = str(b.opportunity_id ?? b.id, 'opportunity_id', { required: true });
        const o = db.get('SELECT * FROM opportunities WHERE id = ? AND location_id = ?', oid, ctx.locationId);
        if (!o) throw notFound('Opportunity nicht gefunden');
        const p = pipelines(ctx.locationId).find((x) => x.id === o.pipeline_id);
        const patch: Record<string, any> = {};
        const stageId = p ? pickStage(p, b.stage ?? b.stage_id) : undefined;
        if (stageId) patch.stage_id = stageId;
        if (b.status) patch.status = String(b.status);
        if (b.lost_reason !== undefined) patch.lost_reason = String(b.lost_reason);
        if (b.expected_close_date !== undefined) patch.expected_close_date = b.expected_close_date;
        if (!Object.keys(patch).length) throw bad('stage oder status angeben');
        return callRoute(app, ctx, 'PATCH', `/api/opportunities/${o.id}`, patch);
      },
      create_task: async (ctx, b) => {
        const who = b.contact_id || b.email || b.phone ? await resolveContact(ctx, b, true) : undefined;
        return callRoute(app, ctx, 'POST', '/api/tasks', { contact_id: who?.id ?? null, title: b.title, description: b.description ?? '', due_at: b.due_at ? new Date(b.due_at).toISOString() : null });
      },
      add_note: async (ctx, b) => {
        const c = await resolveContact(ctx, b, true);
        return callRoute(app, ctx, 'POST', `/api/contacts/${c.id}/notes`, { body: b.body ?? b.note });
      },
      send_message: async (ctx, b) => {
        const c = await resolveContact(ctx, b, true);
        return callRoute(app, ctx, 'POST', '/api/messages', { contact_id: c.id, channel: b.channel || 'email', subject: b.subject ?? '', body: b.body ?? b.message });
      },
      create_invoice_draft: async (ctx, b) => {
        const who = b.contact_id || b.email || b.phone ? await resolveContact(ctx, b, true) : undefined;
        const items = invoiceItems(b.items);
        if (!items.length) throw bad('items fehlt (mindestens eine Position)');
        return callRoute(app, ctx, 'POST', '/api/invoices', { contact_id: who?.id ?? null, title: b.title ?? '', items, due_at: b.due_at || undefined, notes: b.notes ?? '', currency: b.currency || undefined });
      },
    };
    router.post('/api/hooks/actions/:key', 'location', async (ctx) => {
      const run = ACTIONS[ctx.params.key];
      if (!run) throw notFound('Unbekannte Aktion');
      const b = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
      return run(ctx, b);
    });

    // --- subscriptions ------------------------------------------------------------------------
    router.get('/api/hooks', 'location', (ctx) => {
      const where = ['location_id = ?'];
      const params: any[] = [ctx.locationId];
      if (ctx.query.get('event')) (where.push('event = ?'), params.push(ctx.query.get('event')));
      if (ctx.query.get('source')) (where.push('source = ?'), params.push(ctx.query.get('source')));
      return db.all(`SELECT * FROM rest_hooks WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, ...params).map(hookOut);
    });
    router.post('/api/hooks', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const url = str(b.target_url ?? b.targetUrl ?? b.hookUrl ?? b.url, 'target_url', { required: true, max: 2000 });
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw bad('target_url ist keine gültige Adresse');
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('target_url muss mit http(s):// beginnen');
      const key = str(b.event ?? b.trigger, 'event', { required: true });
      const t = triggerByKey(key);
      if (!t) throw bad(`Unbekannter Auslöser „${key}“ – siehe GET /api/hooks/triggers`);
      const n = db.get<{ n: number }>(`SELECT COUNT(*) n FROM rest_hooks WHERE location_id = ? AND status != 'disabled'`, ctx.locationId)!.n;
      if (n >= MAX_HOOKS) throw bad(`Höchstens ${MAX_HOOKS} Abos je Sub-Account`);
      const row = {
        id: `hook_${id(18)}`,
        location_id: ctx.locationId,
        event: t.key,
        target_url: u.toString(),
        filters: cleanFilters(t, { ...b, ...(parseObj(b.filters) ?? {}) }),
        secret: sealSecret(app, token(24)),
        source: detectSource(url, String(ctx.req.headers['user-agent'] ?? ''), b.source),
        label: str(b.label ?? b.name, 'label', { max: 200 }),
        status: 'active',
        created_via: ctx.via ?? null,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('rest_hooks', row);
      return hookOut(db.get('SELECT * FROM rest_hooks WHERE id = ?', row.id));
    });
    router.get('/api/hooks/:id', 'location', (ctx) => {
      const h = getHook(ctx.locationId, ctx.params.id);
      if (!h) throw notFound('Abo nicht gefunden');
      return hookOut(h);
    });
    router.patch('/api/hooks/:id', 'location', (ctx) => {
      const h = getHook(ctx.locationId, ctx.params.id);
      if (!h) throw notFound('Abo nicht gefunden');
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body.status !== undefined) {
        if (!['active', 'paused'].includes(ctx.body.status)) throw bad('status: active oder paused');
        patch.status = ctx.body.status;
        if (ctx.body.status === 'active') Object.assign(patch, { gone_count: 0, fail_streak: 0, disabled_reason: null });
      }
      if (ctx.body.label !== undefined) patch.label = str(ctx.body.label, 'label', { max: 200 });
      if (ctx.body.filters !== undefined) patch.filters = cleanFilters(triggerByKey(h.event)!, parseObj(ctx.body.filters) ?? {});
      db.update('rest_hooks', h.id, patch, ctx.locationId);
      return hookOut(getHook(ctx.locationId, h.id));
    });
    router.delete('/api/hooks/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM rest_hooks WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Abo nicht gefunden');
      db.run(`UPDATE rest_hook_deliveries SET status = 'cancelled', next_attempt_at = NULL, error = 'Abo gelöscht', updated_at = ? WHERE hook_id = ? AND status = 'retrying'`, now(), ctx.params.id);
      return { ok: true };
    });
    router.post('/api/hooks/:id/test', 'location', async (ctx) => {
      const h = getHook(ctx.locationId, ctx.params.id);
      if (!h) throw notFound('Abo nicht gefunden');
      const t = triggerByKey(h.event);
      if (!t) throw new HttpError(500, 'Auslöser fehlt');
      const real = db.get('SELECT payload FROM rest_hook_samples WHERE location_id = ? AND event = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', ctx.locationId, t.key);
      const payload = { ...(real ? JSON.parse(real.payload) : staticSample(t, ctx.locationId)), test: true };
      const dId = queue(h, t.key, payload.type, String(payload.id), payload);
      return parseJson(await attempt(dId), ['payload']);
    });
  },
};
