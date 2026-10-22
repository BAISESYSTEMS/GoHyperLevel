import type { IncomingMessage } from 'node:http';
import type { Module } from '../core/app.js';
import { cached } from '../core/cache.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { zonedToUtc } from '../core/time.js';
import { centsToMoney, id, now, sha256, token } from '../core/util.js';
import {
  APPOINTMENT_SELECT,
  appointmentOut,
  appointments,
  callOut,
  calls,
  contactOut,
  contacts,
  conversation,
  dealOut,
  deals,
  inbox,
  locationNames,
  messageOut,
  payments,
  projects,
  reviews,
  social,
  stageNames,
  summary,
  taskOut,
  tasks,
} from '../services/mobile-read.js';
import { PROBE, bodyLocation, callRoute, contactName, deepLink, mayUse, ownLocation, plain, scope, visibleLocations, type Area } from '../services/mobile.js';

/**
 * API for the native Android app (contract: docs/api.md → "Mobile-App").
 * - Pairing: a signed-in browser session (the app's WebView login) trades itself for a device token
 *   `ghm_…` (shown once, stored as SHA-256). The token acts as that user on /api/mobile/* only –
 *   same sub-accounts, member areas and SaaS plan as the web app; writes run the regular routes
 *   in-process (callRoute) so validation, events and the audit log (via "app") are identical.
 * - Feed: own small event table filled by the event bus (messages, missed calls, leads, payments,
 *   websites, reviews) and a tick for due tasks; the app polls it with a cursor for local notifications.
 */

const TOKEN_PREFIX = 'ghm_';
const MAX_DEVICES = 20;
const RATE_PER_MIN = 300;
const FEED_KEEP_DAYS = 14;

const AREAS = Object.keys(PROBE) as Area[];
const deviceOf = new WeakMap<IncomingMessage, string>();
const hits = new Map<string, { n: number; at: number }>();

function rateLimited(deviceId: string): boolean {
  const t = Date.now();
  const h = hits.get(deviceId);
  if (!h || t - h.at > 60_000) {
    hits.set(deviceId, { n: 1, at: t });
    if (hits.size > 20_000) hits.clear();
    return false;
  }
  h.n++;
  return h.n > RATE_PER_MIN;
}

const clip = (v: unknown, max: number) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** "2026-10-04" → UTC midnight like the web app's date picker; ISO with time stays as given. */
function dueAt(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw bad('Fälligkeit ungültig (ISO-Datum erwartet)');
  return new Date(t).toISOString();
}

const CAPTURE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['task', 'note'] },
    title: { type: 'string' },
    description: { type: 'string' },
    due_date: { type: 'string', description: 'YYYY-MM-DD oder leer' },
    due_time: { type: 'string', description: 'HH:MM oder leer' },
    contact_name: { type: 'string', description: 'Name des Kontakts, wenn klar genannt, sonst leer' },
    note: { type: 'string' },
  },
  required: ['kind', 'title', 'description', 'due_date', 'due_time', 'contact_name', 'note'],
  additionalProperties: false,
};

export const mobileModule: Module = {
  name: 'mobile',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE mobile_devices (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '',
        app_version TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_used_at TEXT, last_ip TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX mobile_devices_user ON mobile_devices(user_id);
      CREATE TABLE mobile_feed (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        type TEXT NOT NULL, area TEXT NOT NULL DEFAULT '', user_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
        deep_link TEXT NOT NULL DEFAULT '', ref TEXT UNIQUE, at TEXT NOT NULL
      );
      CREATE INDEX mobile_feed_at ON mobile_feed(at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    // --- device tokens ------------------------------------------------------------------
    app.bearerAuth.push((ctx: Ctx, tok: string, auth) => {
      if (!tok.startsWith(TOKEN_PREFIX)) return false;
      if (!ctx.path.startsWith('/api/mobile/')) throw new HttpError(403, 'Der App-Zugang gilt nur für die App-Schnittstelle');
      const d = db.get('SELECT * FROM mobile_devices WHERE token_hash = ?', sha256(tok));
      const u = d && db.get('SELECT * FROM users WHERE id = ?', d.user_id);
      if (!d || !u) throw new HttpError(401, 'Dieses Gerät ist abgemeldet – bitte in der App neu anmelden');
      if (rateLimited(d.id)) throw new HttpError(429, 'Zu viele Anfragen von diesem Gerät – bitte kurz warten');
      const version = String(ctx.req.headers['x-app-version'] ?? '').trim().slice(0, 40);
      if (!d.last_used_at || Date.now() - Date.parse(d.last_used_at) > 60_000 || d.last_ip !== ctx.ip || (version && version !== d.app_version))
        db.run('UPDATE mobile_devices SET last_used_at = ?, last_ip = ?, app_version = ? WHERE id = ?', now(), ctx.ip.slice(0, 64), version || d.app_version, d.id);
      ctx.user = { id: u.id, email: u.email, name: u.name, role: u.role, locations: JSON.parse(u.locations || '[]'), permissions: u.permissions ? JSON.parse(u.permissions) : null };
      ctx.via = 'app';
      deviceOf.set(ctx.req, d.id);
      if (auth === 'admin' && u.role !== 'admin') throw new HttpError(403, 'Nur für Admins');
      if (auth === 'location') {
        const loc = String(ctx.req.headers['x-location-id'] ?? ctx.query.get('locationId') ?? '');
        if (!loc) throw new HttpError(400, 'Kein Sub-Account gewählt (x-location-id)');
        if (u.role !== 'admin' && !ctx.user.locations.includes(loc)) throw new HttpError(403, 'Kein Zugriff auf diesen Sub-Account');
        if (!app.location(loc)) throw new HttpError(404, 'Sub-Account nicht gefunden');
        ctx.locationId = loc;
      }
      return true;
    });

    const userOut = (ctx: Ctx) => {
      const u = ctx.user!;
      return { id: u.id, name: u.name, email: u.email, role: u.role, permissions: u.permissions };
    };
    const deviceOut = (d: any, current?: string) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      app_version: d.app_version,
      created_at: d.created_at,
      last_used_at: d.last_used_at,
      last_ip: d.last_ip,
      current: d.id === current,
    });

    /** The app's WebView login hands over its session once; the token lives on the device. */
    router.post('/api/mobile/pair', 'user', (ctx) => {
      if (ctx.via !== 'session') throw new HttpError(403, 'Koppeln geht nur mit einer Anmeldung (nicht mit einem Schlüssel oder App-Token)');
      const b = ctx.body ?? {};
      const raw = `${TOKEN_PREFIX}${token(32)}`;
      const row = {
        id: id(),
        user_id: ctx.user!.id,
        token_hash: sha256(raw),
        prefix: raw.slice(0, 10),
        name: clip(b.device_name, 100) || 'Android-Gerät',
        platform: clip(b.platform, 30).toLowerCase() || 'android',
        app_version: clip(b.app_version, 40),
        created_at: now(),
        last_used_at: now(),
        last_ip: ctx.ip.slice(0, 64),
      };
      db.insert('mobile_devices', row);
      db.run(
        `DELETE FROM mobile_devices WHERE user_id = ? AND id NOT IN (SELECT id FROM mobile_devices WHERE user_id = ? ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT ${MAX_DEVICES})`,
        row.user_id,
        row.user_id,
      );
      return { token: raw, device_id: row.id, name: row.name, user: userOut(ctx) };
    });

    /** Devices belong to a person: managed with a login or from the app, not with API keys. */
    const personal = (ctx: Ctx) => {
      if (ctx.via !== 'session' && ctx.via !== 'app') throw new HttpError(403, 'Geräte nur mit Anmeldung oder aus der App verwalten');
    };
    router.get('/api/mobile/devices', 'user', (ctx) => {
      personal(ctx);
      return db.all('SELECT * FROM mobile_devices WHERE user_id = ? ORDER BY COALESCE(last_used_at, created_at) DESC', ctx.user!.id).map((d) => deviceOut(d, deviceOf.get(ctx.req)));
    });
    router.delete('/api/mobile/devices/:id', 'user', (ctx) => {
      personal(ctx);
      const d = db.get('SELECT * FROM mobile_devices WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user!.id);
      if (!d) throw notFound('Gerät nicht gefunden');
      db.run('DELETE FROM mobile_devices WHERE id = ?', d.id);
      return { ok: true, id: d.id, name: d.name };
    });
    // "Sign out everywhere" also signs out the app: new password, admin's revoke, "Alle anderen abmelden".
    app.afterWrite.push((ctx: Ctx, route) => {
      const key = `${route.method} ${route.pattern}`;
      if (key === 'POST /api/me/password' || key === 'POST /api/me/sessions/revoke-others') db.run('DELETE FROM mobile_devices WHERE user_id = ?', ctx.user!.id);
      else if (key === 'POST /api/users/:id/sessions/revoke' || (key === 'PATCH /api/users/:id' && ctx.body?.password)) db.run('DELETE FROM mobile_devices WHERE user_id = ?', ctx.params.id);
    });

    router.post('/api/mobile/logout', 'user', (ctx) => {
      const deviceId = deviceOf.get(ctx.req);
      if (ctx.via !== 'app' || !deviceId) throw bad('Abmelden geht hier nur aus der App – im Browser unter Mein Konto → Geräte (App)');
      db.run('DELETE FROM mobile_devices WHERE id = ?', deviceId);
      return { ok: true, id: deviceId };
    });

    // --- read -------------------------------------------------------------------------
    router.get('/api/mobile/me', 'user', (ctx) => {
      const locs = visibleLocations(app, ctx).map((l) => {
        const row = app.location(l.id);
        let status: string | null = null;
        try {
          status = JSON.parse(db.get('SELECT data FROM project_profiles WHERE location_id = ?', l.id)?.data ?? '{}').status ?? null;
        } catch {
          /* no project module */
        }
        return { id: l.id, name: l.name, timezone: l.timezone, color: row?.settings?.branding?.color || null, status, areas: AREAS.filter((a) => mayUse(app, ctx, l.id, a)) };
      });
      return {
        user: userOut(ctx),
        agency: ctx.user!.role === 'admin',
        locations: locs,
        server_time: now(),
        app: app.services.mobileAppInfo?.() ?? null,
        device_id: deviceOf.get(ctx.req) ?? null,
      };
    });
    // Read-only counters and lists: served from memory until the next write (core/cache.ts).
    router.get('/api/mobile/summary', 'user', (ctx) => cached(app, ctx, 10_000, () => summary(app, ctx)));
    router.get('/api/mobile/inbox', 'user', (ctx) => cached(app, ctx, 10_000, () => inbox(app, ctx)));
    router.get('/api/mobile/conversations/:id', 'user', (ctx) => conversation(app, ctx, ctx.params.id));
    router.get('/api/mobile/tasks', 'user', (ctx) => cached(app, ctx, 10_000, () => tasks(app, ctx)));
    router.get('/api/mobile/appointments', 'user', (ctx) => cached(app, ctx, 10_000, () => appointments(app, ctx)));
    router.get('/api/mobile/deals', 'user', (ctx) => cached(app, ctx, 10_000, () => deals(app, ctx)));
    router.get('/api/mobile/calls', 'user', (ctx) => calls(app, ctx));
    router.get('/api/mobile/projects', 'user', (ctx) => cached(app, ctx, 10_000, () => projects(app, ctx)));
    router.get('/api/mobile/reviews', 'user', (ctx) => reviews(app, ctx));
    router.get('/api/mobile/payments', 'user', (ctx) => cached(app, ctx, 10_000, () => payments(app, ctx)));
    router.get('/api/mobile/social', 'user', (ctx) => social(app, ctx));
    router.get('/api/mobile/contacts', 'user', (ctx) => cached(app, ctx, 10_000, () => contacts(app, ctx)));

    // --- write: thin relays onto the regular routes --------------------------------------
    /** The outer /api/mobile route is not logged itself – the relayed route is (with via "app"). */
    const relay = (ctx: Ctx) => {
      ctx.skipAfterWrite = true;
    };
    const one = (sql: string, ...p: any[]) => db.get(sql, ...p);
    const taskById = (taskId: string) => one('SELECT t.*, c.first_name, c.last_name, c.email, c.phone FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.id = ?', taskId);
    const namesOf = (ctx: Ctx) => locationNames(visibleLocations(app, ctx));

    router.post('/api/mobile/conversations/:id/reply', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLocation(app, ctx, 'conversations', ctx.params.id, 'Konversation nicht gefunden');
      const v = one('SELECT * FROM conversations WHERE id = ?', ctx.params.id)!;
      const contact = one('SELECT id, email, phone FROM contacts WHERE id = ?', v.contact_id);
      const body = str(ctx.body?.body, 'Nachricht', { required: true, max: 10_000 });
      const extras = Object.keys(app.services.messageChannels ?? {});
      const known = ['email', 'sms', 'chat', ...extras];
      const lastIn = one(`SELECT channel FROM messages WHERE conversation_id = ? AND direction = 'in' AND channel != 'call' ORDER BY created_at DESC LIMIT 1`, v.id);
      const last = one(`SELECT channel FROM messages WHERE conversation_id = ? AND channel != 'call' ORDER BY created_at DESC LIMIT 1`, v.id);
      const channel = str(ctx.body?.channel, 'Kanal', { max: 20 }) || lastIn?.channel || last?.channel || (contact?.email ? 'email' : 'sms');
      if (!known.includes(channel)) throw bad(`Unbekannter Kanal: ${channel}`);
      let subject = str(ctx.body?.subject, 'Betreff', { max: 300 });
      if (channel === 'email' && !subject) {
        // An answer to the customer's last e-mail keeps its subject ("Re: …").
        const prev = one(`SELECT subject FROM messages WHERE conversation_id = ? AND channel = 'email' AND direction = 'in' AND subject != '' ORDER BY created_at DESC LIMIT 1`, v.id)?.subject;
        subject = prev ? (/^(re|aw):/i.test(prev) ? prev : `Re: ${prev}`) : `Nachricht von ${loc.name}`;
      }
      const msg = await callRoute(app, ctx, 'POST', '/api/messages', { locationId: loc.id, body: { contact_id: v.contact_id, channel, subject, body } });
      return { ...messageOut(msg), conversation_id: v.id, location_id: loc.id, location_name: loc.name };
    });

    router.post('/api/mobile/conversations/:id/read', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLocation(app, ctx, 'conversations', ctx.params.id, 'Konversation nicht gefunden');
      await callRoute(app, ctx, 'PATCH', `/api/conversations/${encodeURIComponent(ctx.params.id)}`, { locationId: loc.id, body: { unread: false } });
      return { ok: true, conversation_id: ctx.params.id };
    });

    router.post('/api/mobile/tasks', 'user', async (ctx) => {
      relay(ctx);
      const b = ctx.body ?? {};
      const loc = bodyLocation(app, ctx, b.location_id);
      const t = await callRoute(app, ctx, 'POST', '/api/tasks', {
        locationId: loc.id,
        body: { title: str(b.title, 'Titel', { required: true, max: 300 }), description: str(b.description, 'Beschreibung', { max: 5000 }), due_at: dueAt(b.due_at), contact_id: b.contact_id || null },
      });
      return taskOut(taskById(t.id), namesOf(ctx));
    });
    const setDone = (done: boolean) => async (ctx: Ctx) => {
      relay(ctx);
      const loc = ownLocation(app, ctx, 'tasks', ctx.params.id, 'Aufgabe nicht gefunden');
      await callRoute(app, ctx, 'PATCH', `/api/tasks/${encodeURIComponent(ctx.params.id)}`, { locationId: loc.id, body: { done } });
      return taskOut(taskById(ctx.params.id), namesOf(ctx));
    };
    router.post('/api/mobile/tasks/:id/complete', 'user', setDone(true));
    router.post('/api/mobile/tasks/:id/reopen', 'user', setDone(false));

    const dealById = (ctx: Ctx, dealId: string) => {
      const o = one('SELECT o.*, c.first_name, c.last_name, c.email, c.phone FROM opportunities o JOIN contacts c ON c.id = o.contact_id WHERE o.id = ?', dealId);
      if (!o) throw notFound('Deal nicht gefunden');
      return dealOut(o, namesOf(ctx), stageNames(app, [o.location_id]));
    };
    router.post('/api/mobile/deals/:id/stage', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLocation(app, ctx, 'opportunities', ctx.params.id, 'Deal nicht gefunden');
      const stage = str(ctx.body?.stage_id, 'Stufe', { required: true, max: 40 });
      await callRoute(app, ctx, 'PATCH', `/api/opportunities/${encodeURIComponent(ctx.params.id)}`, { locationId: loc.id, body: { stage_id: stage } });
      return dealById(ctx, ctx.params.id);
    });
    router.post('/api/mobile/deals/:id/status', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLocation(app, ctx, 'opportunities', ctx.params.id, 'Deal nicht gefunden');
      const status = String(ctx.body?.status ?? '');
      if (!['won', 'lost', 'open'].includes(status)) throw bad('Status: won, lost oder open');
      // Apps that do not ask for a reason yet (older builds) still work: the deal then says it was closed from the app.
      const lostReason = String(ctx.body?.lost_reason ?? '').trim() || 'Per App';
      await callRoute(app, ctx, 'PATCH', `/api/opportunities/${encodeURIComponent(ctx.params.id)}`, { locationId: loc.id, body: { status, ...(status === 'lost' ? { lost_reason: lostReason } : {}) } });
      return dealById(ctx, ctx.params.id);
    });

    const addNote = (ctx: Ctx, locationId: string, contactId: string, body: string) =>
      callRoute(app, ctx, 'POST', `/api/contacts/${encodeURIComponent(contactId)}/notes`, { locationId, body: { body } });
    const noteOut = (n: any, locId: string, locName: string) => ({ id: n.id, contact_id: n.contact_id, body: n.body, created_at: n.created_at, location_id: locId, location_name: locName });

    router.post('/api/mobile/contacts', 'user', async (ctx) => {
      relay(ctx);
      const b = ctx.body ?? {};
      const loc = bodyLocation(app, ctx, b.location_id);
      const input = {
        first_name: str(b.first_name, 'Vorname', { required: true, max: 100 }),
        last_name: str(b.last_name, 'Nachname', { max: 100 }),
        email: str(b.email, 'E-Mail', { max: 200 }),
        phone: str(b.phone, 'Telefon', { max: 50 }),
        company: str(b.company, 'Firma', { max: 200 }),
        tags: Array.isArray(b.tags) ? b.tags.map((t: unknown) => String(t).trim().slice(0, 80)).filter(Boolean).slice(0, 20) : [],
        source: 'App',
      };
      if (input.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw bad('E-Mail-Adresse ungültig');
      const c = await callRoute(app, ctx, 'POST', '/api/contacts', { locationId: loc.id, body: input });
      const note = str(b.note, 'Notiz', { max: 20_000 });
      const n = note ? await addNote(ctx, loc.id, c.id, note) : null;
      return { ...contactOut(c, namesOf(ctx)), created: !!c.created, note: n ? noteOut(n, loc.id, loc.name) : null };
    });

    router.post('/api/mobile/notes', 'user', async (ctx) => {
      relay(ctx);
      const contactId = str(ctx.body?.contact_id, 'Kontakt', { required: true, max: 40 });
      const loc = ownLocation(app, ctx, 'contacts', contactId, 'Kontakt nicht gefunden');
      const n = await addNote(ctx, loc.id, contactId, str(ctx.body?.body, 'Notiz', { required: true, max: 20_000 }));
      return noteOut(n, loc.id, loc.name);
    });

    router.post('/api/mobile/calls', 'user', async (ctx) => {
      relay(ctx);
      const contactId = str(ctx.body?.contact_id, 'Kontakt', { required: true, max: 40 });
      const loc = ownLocation(app, ctx, 'contacts', contactId, 'Kontakt nicht gefunden');
      if (!app.router.match('POST', '/api/calls')) throw bad('Telefonie ist auf diesem Server nicht verfügbar');
      const r = await callRoute(app, ctx, 'POST', '/api/calls', { locationId: loc.id, body: { contact_id: contactId } });
      const row = one('SELECT c.*, k.first_name, k.last_name, k.email, k.phone FROM calls c LEFT JOIN contacts k ON k.id = c.contact_id WHERE c.id = ?', r.id);
      return { ...callOut(row ?? { ...r, location_id: loc.id }, namesOf(ctx)), message: 'Dein Telefon klingelt gleich – nach dem Abnehmen wird verbunden.' };
    });

    router.post('/api/mobile/appointments/:id/status', 'user', async (ctx) => {
      relay(ctx);
      const status = String(ctx.body?.status ?? '');
      if (!['confirmed', 'cancelled', 'showed', 'noshow'].includes(status)) throw bad('Status: confirmed, cancelled, showed oder noshow');
      const loc = ownLocation(app, ctx, 'appointments', ctx.params.id, 'Termin nicht gefunden');
      await callRoute(app, ctx, 'PATCH', `/api/appointments/${encodeURIComponent(ctx.params.id)}`, { locationId: loc.id, body: { status } });
      return appointmentOut(one(`${APPOINTMENT_SELECT} WHERE a.id = ?`, ctx.params.id), namesOf(ctx));
    });

    /** Voice/quick capture: Claude turns the sentence into a task (title + due date) or a contact note; without AI a plain task. */
    router.post('/api/mobile/capture', 'user', async (ctx) => {
      relay(ctx);
      const loc = bodyLocation(app, ctx, ctx.body?.location_id);
      const text = str(ctx.body?.text, 'Text', { required: true, max: 4000 });
      const tz = loc.timezone || 'Europe/Berlin';
      let ai: any = null;
      if (app.services.aiRun && app.services.aiReady?.(loc.id) === null) {
        try {
          const today = new Intl.DateTimeFormat('de-DE', { timeZone: tz, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());
          const r = await app.services.aiRun({
            locationId: loc.id,
            purpose: 'mobile_capture',
            userId: ctx.user!.id,
            maxTokens: 800,
            schema: CAPTURE_SCHEMA,
            system: [
              {
                text:
                  'Du sortierst kurze Diktate aus einer CRM-App. Antworte nur im verlangten JSON. ' +
                  'kind = "note" nur, wenn der Text klar eine Information über eine namentlich genannte Person/Firma festhält (z. B. "Herr Meier will das Angebot erst im März"); ' +
                  'sonst kind = "task" (etwas ist zu tun). title: kurzer Aufgaben-Titel im Imperativ (max. 80 Zeichen). description: weitere Details oder leer. ' +
                  'due_date/due_time nur, wenn ein Zeitpunkt genannt oder klar gemeint ist ("morgen", "Freitag 10 Uhr"), sonst leer. ' +
                  'contact_name: der genannte Kontakt (Vor- und/oder Nachname, Firma) oder leer. note: bei kind "note" der Notiztext, sonst leer.',
                cache: true,
              },
            ],
            user: `Jetzt ist ${today} (Zeitzone ${tz}).\n\nDiktat:\n${text}`,
          });
          ai = JSON.parse(String(r.text ?? '').replace(/^```(json)?|```$/g, '').trim());
        } catch {
          ai = null; // nothing is lost: fall back to a plain task
        }
      }
      const findContact = (q: string) => {
        const term = q.trim().slice(0, 100);
        if (term.length < 2) return undefined;
        const rows = db.all(
          `SELECT id, first_name, last_name, company FROM contacts WHERE location_id = ? AND ((first_name || ' ' || last_name) LIKE ? OR last_name LIKE ? OR company LIKE ?) ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT 5`,
          loc.id,
          `%${term}%`,
          term,
          `%${term}%`,
        );
        return rows.length === 1 ? rows[0] : rows.find((c) => contactName(c).toLowerCase() === term.toLowerCase());
      };
      const contact = ai?.contact_name ? findContact(String(ai.contact_name)) : undefined;
      if (ai?.kind === 'note' && contact && String(ai.note || text).trim()) {
        const n = await addNote(ctx, loc.id, contact.id, String(ai.note || text).slice(0, 20_000));
        return { kind: 'note', ai: true, item: { ...noteOut(n, loc.id, loc.name), contact_name: contactName(contact) } };
      }
      let due: string | null = null;
      if (ai && /^\d{4}-\d{2}-\d{2}$/.test(String(ai.due_date ?? ''))) {
        due = /^\d{2}:\d{2}$/.test(String(ai.due_time ?? '')) ? zonedToUtc(ai.due_date, ai.due_time, tz).toISOString() : `${ai.due_date}T00:00:00.000Z`;
      }
      const title = (ai?.title ? String(ai.title) : text.split('\n')[0]).trim().slice(0, 300) || 'Notiz aus der App';
      const description = ai ? [String(ai.description ?? '').trim(), ai.title ? `Diktat: ${text}` : ''].filter(Boolean).join('\n\n') : text.length > title.length ? text : '';
      const t = await callRoute(app, ctx, 'POST', '/api/tasks', { locationId: loc.id, body: { title, description: description.slice(0, 5000), due_at: due, contact_id: contact?.id ?? null } });
      return { kind: 'task', ai: !!ai, item: taskOut(taskById(t.id), namesOf(ctx)) };
    });

    // --- feed for local notifications -------------------------------------------------------
    const anyDevice = () => !!db.get('SELECT 1 FROM mobile_devices LIMIT 1');
    const feed = (e: { locationId: string; type: string; area: Area | ''; title: string; body?: string; link: string; ref?: string; userId?: string | null }): number => {
      if (!e.locationId || !anyDevice()) return 0;
      return db.run(
        'INSERT OR IGNORE INTO mobile_feed (location_id, type, area, user_id, title, body, deep_link, ref, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        e.locationId,
        e.type,
        e.area,
        e.userId ?? null,
        e.title.slice(0, 200),
        plain(e.body ?? '', 300).replace(/\s+/g, ' '),
        deepLink(e.link, e.locationId),
        e.ref ?? null,
        now(),
      ).changes;
    };
    app.services.mobileFeed = feed;
    const who = (c: any, fallback = 'Unbekannt') => (c ? contactName(c) : '') || fallback;
    const contactOf = (locationId: string, contactId?: string | null) => (contactId ? db.get('SELECT * FROM contacts WHERE id = ? AND location_id = ?', contactId, locationId) : undefined);

    const lastConv = new Map<string, number>();
    app.events.on('message.inbound', (e) => {
      const m = e.data.message ?? {};
      const conv = String(m.conversation_id ?? '');
      if (conv) {
        if (Date.now() - (lastConv.get(conv) ?? 0) < 30_000) return;
        lastConv.set(conv, Date.now());
        if (lastConv.size > 5000) lastConv.clear();
      }
      const label = m.channel === 'email' ? 'Neue E-Mail' : m.channel === 'sms' ? 'Neue SMS' : m.channel === 'chat' ? 'Neue Chat-Nachricht' : m.channel === 'whatsapp' ? 'Neue WhatsApp' : 'Neue Nachricht';
      // An assigned conversation (Team-Posteingang) goes to its assignee's feed only.
      const audience = conv ? (app.services.inboxAudience?.(e.locationId, conv) as string[] | undefined) : undefined;
      feed({ locationId: e.locationId, type: 'message', area: 'conversations', ...(audience ? { userId: audience[0] } : {}), title: `${label} von ${who(e.data.contact)}`, body: [m.subject, m.body].filter(Boolean).join(' – '), link: conv ? `/app/conversations?c=${conv}` : '/app/conversations', ref: m.id ? `message:${m.id}` : undefined });
    });
    app.events.on('call.missed', (e) => {
      const c = contactOf(e.locationId, e.data.contactId);
      feed({ locationId: e.locationId, type: 'call_missed', area: 'calls', title: `Verpasster Anruf: ${who(c, e.data.from || 'Nummer unterdrückt')}`, body: e.data.from ? `von ${e.data.from}` : '', link: '/app/calls', ref: `call_missed:${e.data.callId}` });
    });
    app.events.on('contact.created', (e) => {
      const c = e.data.contact ?? contactOf(e.locationId, e.data.contactId);
      if (!c) return;
      feed({ locationId: e.locationId, type: 'lead', area: 'contacts', title: `Neuer Lead: ${who(c)}`, body: [c.source, c.email, c.phone].filter(Boolean).join(' · '), link: `/app/contacts/${c.id}`, ref: `lead:${c.id}` });
    });
    app.events.on('invoice.paid', (e) => {
      const i = e.data.invoice ?? {};
      if (!i.id) return;
      const c = contactOf(e.locationId, i.contact_id);
      feed({ locationId: e.locationId, type: 'payment', area: 'payments', title: `Zahlung erhalten: ${centsToMoney(Number(i.total_cents ?? 0), i.currency || 'EUR')}`, body: [i.number ? `Rechnung ${i.number}` : '', c ? who(c) : '', e.data.via ? `via ${e.data.via}` : ''].filter(Boolean).join(' · '), link: `/app/invoices/${i.id}`, ref: `payment:${i.id}` });
    });
    const site = (down: boolean) => (e: { locationId: string; data: Record<string, any> }) => {
      const name = app.location(e.locationId)?.name ?? 'Projekt';
      feed({ locationId: e.locationId, type: down ? 'website_down' : 'website_up', area: 'project', title: down ? `${name} ist nicht erreichbar` : `${name} ist wieder online`, body: `${e.data.website ?? ''} – Status ${e.data.status || 'keine Antwort'}`, link: '/app/project' });
    };
    app.events.on('website.down', site(true));
    app.events.on('website.up', site(false));
    app.events.on('review.received', (e) => {
      const c = contactOf(e.locationId, e.data.contactId);
      const n = Math.max(0, Math.min(5, Number(e.data.rating) || 0));
      feed({ locationId: e.locationId, type: 'review', area: 'reviews', title: `Neue Bewertung: ${'★'.repeat(n)}${c ? ` von ${who(c)}` : ''}`, body: e.data.comment ?? '', link: '/app/reviews' });
    });
    app.events.on('google_review.received', (e) => {
      feed({ locationId: e.locationId, type: 'review', area: 'reviews', title: `Neue Google-Bewertung: ${Number(e.data.rating) || 0}★ von ${e.data.author || 'Google-Nutzer'}`, body: e.data.text ?? '', link: '/app/reviews', ref: e.data.reviewId ? `review:${e.data.reviewId}` : undefined });
    });

    /** Tasks become due: timed ones at their time, date-only ones at 8:00 local time on the day. */
    const scanDue = (at = new Date()) => {
      if (!anyDevice()) return 0;
      const rows = db.all(
        `SELECT t.id, t.location_id, t.title, t.description, t.due_at, t.assigned_to, l.timezone FROM tasks t JOIN locations l ON l.id = t.location_id
         WHERE t.done = 0 AND t.due_at IS NOT NULL AND t.due_at BETWEEN ? AND ? LIMIT 2000`,
        new Date(at.getTime() - 2 * 864e5).toISOString(),
        new Date(at.getTime() + 2 * 864e5).toISOString(),
      );
      let n = 0;
      for (const t of rows) {
        const dateOnly = /T00:00:00(\.000)?Z$/.test(t.due_at);
        const when = dateOnly ? zonedToUtc(t.due_at.slice(0, 10), '08:00', t.timezone || 'Europe/Berlin').getTime() : Date.parse(t.due_at);
        if (!(when <= at.getTime() && when > at.getTime() - 864e5)) continue;
        n += feed({ locationId: t.location_id, type: 'task_due', area: 'tasks', title: `Fällig: ${t.title}`, body: t.description ?? '', link: '/app/tasks', ref: `task_due:${t.id}:${t.due_at}`, userId: t.assigned_to || null });
      }
      return n;
    };
    app.services.mobileScanDue = scanDue;
    let lastScan = 0;
    let lastPrune = 0;
    app.onTick(() => {
      if (Date.now() - lastScan >= 2 * 60_000) {
        lastScan = Date.now();
        scanDue();
      }
      if (Date.now() - lastPrune >= 864e5) {
        lastPrune = Date.now();
        db.run('DELETE FROM mobile_feed WHERE at < ?', new Date(Date.now() - FEED_KEEP_DAYS * 864e5).toISOString());
      }
    });

    router.get('/api/mobile/feed', 'user', (ctx) => {
      const max = Number(db.get('SELECT COALESCE(MAX(seq), 0) m FROM mobile_feed')?.m ?? 0);
      const raw = String(ctx.query.get('since') ?? '');
      const since = /^\d{1,15}$/.test(raw) ? Number(raw) : null;
      // First call (or a cursor from before a reset): only the cursor, no backlog.
      if (since === null || since > max) return { cursor: String(max), events: [] };
      const locs = scope(app, ctx, 'project');
      const visible = new Map(locs.map((l) => [l.id, l.name]));
      const allowed = new Map<string, boolean>();
      const events: any[] = [];
      let cursor = since;
      for (const r of db.all('SELECT * FROM mobile_feed WHERE seq > ? ORDER BY seq LIMIT 500', since)) {
        cursor = r.seq;
        if (!visible.has(r.location_id)) continue;
        if (r.user_id && r.user_id !== ctx.user!.id) continue;
        const key = `${r.location_id}:${r.area}`;
        if (!allowed.has(key)) allowed.set(key, !r.area || mayUse(app, ctx, r.location_id, r.area as Area));
        if (!allowed.get(key)) continue;
        events.push({ id: String(r.seq), type: r.type, title: r.title, body: r.body, location_id: r.location_id, location_name: visible.get(r.location_id) ?? '', deep_link: r.deep_link, at: r.at });
        if (events.length >= 50) break;
      }
      return { cursor: String(cursor), events };
    });
  },
};
