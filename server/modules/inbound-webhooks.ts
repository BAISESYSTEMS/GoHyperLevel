import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, num, type Ctx } from '../core/http.js';
import { id, now, token } from '../core/util.js';
import { upsertContact } from '../services/contacts.js';
import { processRun, startWorkflow } from '../services/workflow-engine.js';
import { RateLimiter, SIGNATURE_HEADERS, applyMapping, cleanMapping, flattenPaths, hasIdentity, verifyHmac } from '../services/inbound-webhooks.js';
import { openSecret, sealSecret } from './mail-sync.js';
import { deliveryIdOf, firstSeen } from '../services/channel-kit.js';

/**
 * Workflow trigger "Webhook empfangen": every workflow with this trigger gets a secret URL
 * (/hooks/in/<token>). Incoming JSON is mapped onto contact fields, custom fields and tags,
 * optionally checked against an HMAC signature, rate-limited per URL, and enrolls the contact.
 * Capture mode stores test payloads for the mapping screen without running the workflow.
 */

export const INBOUND_TRIGGER = 'webhook.received';
const KEEP_CAPTURES = 5;
/** How long a kept request body (test data) stays at most. */
const CAPTURE_DAYS = 30;
const MAX_CAPTURE = 20_000;

export const inboundWebhooksModule: Module = {
  name: 'inbound-webhooks',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE inbound_webhooks (
        workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE, secret_sealed TEXT, secret_hint TEXT, mapping TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]',
        capture INTEGER NOT NULL DEFAULT 0, rate_limit INTEGER NOT NULL DEFAULT 60,
        hits INTEGER NOT NULL DEFAULT 0, last_at TEXT, last_status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE inbound_webhook_captures (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        payload TEXT NOT NULL, signed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX inbound_webhook_captures_wf ON inbound_webhook_captures(workflow_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const limiter = new RateLimiter();
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), INBOUND_TRIGGER];

    // The kept payloads are test data for the mapping: a web hook that went quiet keeps them 30 days, not for ever.
    let pruned = 0;
    app.onTick(() => {
      if (Date.now() - pruned < 3600_000) return;
      pruned = Date.now();
      db.run('DELETE FROM inbound_webhook_captures WHERE created_at < ?', new Date(Date.now() - CAPTURE_DAYS * 864e5).toISOString());
    });

    // GDPR erasure: the kept payloads (samples for the mapping) that carry the person's e-mail address or phone number go.
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: unknown, loc: string, contact: { email?: string; phone?: string }) => {
        for (const needle of [String(contact.email ?? '').trim(), String(contact.phone ?? '').trim()].filter((s) => s.length >= 5)) {
          db.run('DELETE FROM inbound_webhook_captures WHERE workflow_id IN (SELECT id FROM workflows WHERE location_id = ?) AND instr(lower(payload), lower(?)) > 0', loc, needle);
        }
      },
    ];

    const workflow = (loc: string, wid: string) => parseJson(db.get('SELECT * FROM workflows WHERE id = ? AND location_id = ?', wid, loc), ['trigger', 'steps', 'settings']);
    const customKeys = (loc: string) => db.all('SELECT key FROM custom_fields WHERE location_id = ?', loc).map((r) => String(r.key));
    const urlOf = (t: string) => `${app.baseUrl()}/hooks/in/${t}`;

    const ensure = (loc: string, wid: string) => {
      const w = workflow(loc, wid);
      if (!w) throw notFound('Workflow nicht gefunden');
      let row = db.get('SELECT * FROM inbound_webhooks WHERE workflow_id = ?', w.id);
      if (!row) {
        db.insert('inbound_webhooks', { workflow_id: w.id, location_id: loc, token: token(24), created_at: now(), updated_at: now() });
        row = db.get('SELECT * FROM inbound_webhooks WHERE workflow_id = ?', w.id);
      }
      return { w, row: row! };
    };
    const view = (loc: string, wid: string) => {
      const { w, row } = ensure(loc, wid);
      const captures = db.all('SELECT * FROM inbound_webhook_captures WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', w.id, KEEP_CAPTURES).map((c) => {
        const payload = JSON.parse(c.payload);
        return { id: c.id, created_at: c.created_at, signed: !!c.signed, payload, fields: flattenPaths(payload) };
      });
      return {
        workflow_id: w.id,
        active: w.status === 'active' && w.trigger?.type === INBOUND_TRIGGER,
        url: urlOf(row.token),
        signature: { enabled: !!row.secret_sealed, hint: row.secret_hint ?? '', headers: SIGNATURE_HEADERS },
        mapping: JSON.parse(row.mapping),
        tags: JSON.parse(row.tags),
        capture: !!row.capture,
        rate_limit: row.rate_limit,
        hits: row.hits,
        last_at: row.last_at,
        last_status: row.last_status,
        custom_fields: db.all('SELECT key, label FROM custom_fields WHERE location_id = ? ORDER BY position, label', loc),
        captures,
      };
    };

    router.get('/api/inbound-webhooks/:workflowId', 'location', (ctx) => view(ctx.locationId, ctx.params.workflowId));
    router.put('/api/inbound-webhooks/:workflowId', 'location', (ctx) => {
      const { w } = ensure(ctx.locationId, ctx.params.workflowId);
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { updated_at: now() };
      if (b.mapping !== undefined) {
        try {
          patch.mapping = cleanMapping(b.mapping, customKeys(ctx.locationId));
        } catch (e) {
          throw bad((e as Error).message);
        }
      }
      if (b.tags !== undefined) patch.tags = (Array.isArray(b.tags) ? b.tags : String(b.tags).split(',')).map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 50);
      if (b.capture !== undefined) patch.capture = b.capture ? 1 : 0;
      if (b.rate_limit !== undefined) patch.rate_limit = Math.min(600, Math.max(1, Math.round(num(b.rate_limit, 60))));
      db.run(
        `UPDATE inbound_webhooks SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')} WHERE workflow_id = ?`,
        ...Object.values(patch).map((v) => (typeof v === 'object' ? JSON.stringify(v) : v)),
        w.id,
      );
      return view(ctx.locationId, w.id);
    });
    /** Turns the HMAC check on (new secret, shown once) or off. */
    router.post('/api/inbound-webhooks/:workflowId/secret', 'location', (ctx) => {
      const { w } = ensure(ctx.locationId, ctx.params.workflowId);
      if (ctx.body?.enabled === false) {
        db.run('UPDATE inbound_webhooks SET secret_sealed = NULL, secret_hint = NULL, updated_at = ? WHERE workflow_id = ?', now(), w.id);
        return { ...view(ctx.locationId, w.id), secret: null };
      }
      const secret = `whsec_${token(24)}`;
      db.run('UPDATE inbound_webhooks SET secret_sealed = ?, secret_hint = ?, updated_at = ? WHERE workflow_id = ?', sealSecret(app, secret), `…${secret.slice(-4)}`, now(), w.id);
      return { ...view(ctx.locationId, w.id), secret };
    });
    router.post('/api/inbound-webhooks/:workflowId/rotate', 'location', (ctx) => {
      const { w } = ensure(ctx.locationId, ctx.params.workflowId);
      db.run('UPDATE inbound_webhooks SET token = ?, updated_at = ? WHERE workflow_id = ?', token(24), now(), w.id);
      return view(ctx.locationId, w.id);
    });
    router.delete('/api/inbound-webhooks/:workflowId/captures', 'location', (ctx) => {
      const { w } = ensure(ctx.locationId, ctx.params.workflowId);
      db.run('DELETE FROM inbound_webhook_captures WHERE workflow_id = ?', w.id);
      return view(ctx.locationId, w.id);
    });
    /** Dry run: what a captured (or given) payload would turn into – nothing is saved. */
    router.post('/api/inbound-webhooks/:workflowId/preview', 'location', (ctx) => {
      const { w, row } = ensure(ctx.locationId, ctx.params.workflowId);
      let payload = ctx.body?.payload;
      if (payload === undefined) {
        const c = ctx.body?.capture_id
          ? db.get('SELECT payload FROM inbound_webhook_captures WHERE id = ? AND workflow_id = ?', ctx.body.capture_id, w.id)
          : db.get('SELECT payload FROM inbound_webhook_captures WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', w.id);
        if (!c) throw bad('Noch keine Test-Daten empfangen');
        payload = JSON.parse(c.payload);
      }
      let mapping;
      try {
        mapping = ctx.body?.mapping !== undefined ? cleanMapping(ctx.body.mapping, customKeys(ctx.locationId)) : JSON.parse(row.mapping);
      } catch (e) {
        throw bad((e as Error).message);
      }
      const { input, tags } = applyMapping(payload, mapping, JSON.parse(row.tags));
      return { contact: input, tags, ok: hasIdentity(input) };
    });

    // --- the public URL --------------------------------------------------------------------
    router.get('/hooks/in/:token', 'public', (ctx) => {
      if (!db.get('SELECT workflow_id FROM inbound_webhooks WHERE token = ?', ctx.params.token)) throw notFound();
      return { ok: true, hint: 'POST mit JSON-Body senden' };
    });
    router.post('/hooks/in/:token', 'public', async (ctx: Ctx) => {
      const row = db.get('SELECT * FROM inbound_webhooks WHERE token = ?', ctx.params.token);
      if (!row) throw notFound();
      const stamp = (status: string) => db.run('UPDATE inbound_webhooks SET hits = hits + 1, last_at = ?, last_status = ? WHERE workflow_id = ?', now(), status.slice(0, 200), row.workflow_id);
      if (!limiter.allow(row.token, row.rate_limit)) {
        stamp('429 zu viele Anfragen');
        throw new HttpError(429, 'Zu viele Anfragen – bitte kurz warten');
      }
      let signed = false;
      if (row.secret_sealed) {
        const header = SIGNATURE_HEADERS.map((h) => ctx.req.headers[h]).find((v) => typeof v === 'string') as string | undefined;
        let secret = '';
        try {
          secret = openSecret(app, row.secret_sealed);
        } catch {
          /* unreadable secret = refuse */
        }
        if (!secret || !verifyHmac(secret, ctx.rawBody, header)) {
          stamp('401 Signatur ungültig');
          throw new HttpError(401, 'Signatur fehlt oder ist ungültig');
        }
        signed = true;
      }
      const payload = ctx.body;
      if (!payload || typeof payload !== 'object' || (Object.keys(payload).length === 1 && 'raw' in payload)) {
        stamp('400 kein JSON');
        throw bad('JSON-Body erwartet');
      }
      const body = JSON.stringify(payload);
      db.insert('inbound_webhook_captures', { id: id(), workflow_id: row.workflow_id, payload: body.length > MAX_CAPTURE ? JSON.stringify({ _gekuerzt: true, vorschau: body.slice(0, MAX_CAPTURE) }) : body, signed, created_at: now() });
      db.run(
        `DELETE FROM inbound_webhook_captures WHERE workflow_id = ? AND id NOT IN (SELECT id FROM inbound_webhook_captures WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
        row.workflow_id,
        row.workflow_id,
        KEEP_CAPTURES,
      );
      if (row.capture) {
        stamp('200 als Test-Daten gespeichert');
        return { ok: true, captured: true };
      }
      const w = parseJson(db.get('SELECT * FROM workflows WHERE id = ?', row.workflow_id), ['trigger', 'steps', 'settings']);
      if (!w || w.status !== 'active' || w.trigger?.type !== INBOUND_TRIGGER) {
        stamp('409 Workflow nicht aktiv');
        throw new HttpError(409, 'Workflow ist nicht aktiv');
      }
      const { input, tags } = applyMapping(payload, JSON.parse(row.mapping), JSON.parse(row.tags));
      if (!hasIdentity(input)) {
        stamp('400 keine Kontaktdaten');
        throw bad('Keine Kontaktdaten gefunden (E-Mail, Telefon oder Name) – Feldzuordnung prüfen');
      }
      // A sender that retries keeps its delivery id (webhook-id, Idempotency-Key …): the same delivery starts the workflow once.
      if (!firstSeen(app, w.location_id, `webhook:${w.id}`, deliveryIdOf(ctx.req.headers))) {
        stamp('200 schon empfangen (gleiche Zustell-ID)');
        return { ok: true, duplicate: true };
      }
      const { contact, created } = upsertContact(app, w.location_id, input, { source: `Webhook: ${w.name}`, tags });
      const rid = startWorkflow(app, w, contact.id, { webhook: payload });
      if (rid) await processRun(app, rid);
      stamp(`200 ${created ? 'Kontakt angelegt' : 'Kontakt aktualisiert'}${rid ? ', gestartet' : ''}`);
      return { ok: true, contactId: contact.id, created, enrolled: !!rid };
    });
  },
};
