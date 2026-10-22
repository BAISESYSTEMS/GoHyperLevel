import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { bad, notFound, str, text, type Ctx } from '../core/http.js';
import { hmInTz, ymdInTz } from '../core/time.js';
import { id, now } from '../core/util.js';
import { appManifest, brandKey, pwaBrand } from '../services/pwa-ios.js';
import { fromB64u, generateVapidKeys, isPushEndpoint, sendWebPush, type VapidKeys } from '../services/webpush.js';
import { effectiveBranding } from './agency.js';
import { openSecret, sealSecret } from './mail-sync.js';
import { hiddenUser } from '../core/permissions.js';

/**
 * Installable app + push notifications. The web app ships a manifest and a service worker; each
 * user turns on notifications per device (Einstellungen → Mein Konto). Pushes go out for new
 * inbound messages, websites going down, tasks assigned / due today and Stripe payments – other
 * modules can send their own through app.services.pushNotify.
 */

export const PUSH_KINDS: Record<string, { label: string; perm: string }> = {
  messages: { label: 'Neue Nachrichten', perm: 'conversations' },
  uptime: { label: 'Website nicht erreichbar / wieder online', perm: 'dashboard' },
  tasks: { label: 'Aufgaben (zugewiesen, heute fällig)', perm: 'contacts' },
  payments: { label: 'Zahlungen und Käufe', perm: 'payments' },
  feedback: { label: 'Meine Meldungen & Wünsche (Antworten, Status)', perm: '' },
  canvas: { label: 'Canvas: Erwähnungen in Kommentaren', perm: 'canvas' },
};

export interface PushInput {
  /** Everyone with access to this sub-account (and the area of `kind`)… */
  locationId?: string;
  /** …or exactly these users. */
  userIds?: string[];
  kind: string;
  title: string;
  body?: string;
  /** Path in the app, e.g. /app/conversations/<id>. */
  url?: string;
  /** Same tag = the newer notification replaces the older one on the device. */
  tag?: string;
  urgency?: 'low' | 'normal' | 'high';
  /** Up to two buttons on the notification; each opens its own path in the app (e.g. "Freigeben" → …?action=approve). */
  actions?: { action: string; title: string; url: string }[];
}

const MAX_DEVICES = 20;
const MAX_LOG = 50;

export const pushModule: Module = {
  name: 'push',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE push_keys (id INTEGER PRIMARY KEY CHECK (id = 1), public_key TEXT NOT NULL, private_key TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE push_subscriptions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        last_ok_at TEXT, last_error TEXT NOT NULL DEFAULT '', fails INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
      CREATE TABLE push_prefs (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, kinds TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE push_log (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '', location_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX push_log_user ON push_log(user_id, created_at);
      CREATE TABLE push_task_seen (task_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (task_id, kind));
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    // --- VAPID keys: created once, private half sealed -----------------------------
    let keys: VapidKeys;
    const row = db.get('SELECT * FROM push_keys WHERE id = 1');
    if (row) keys = { publicKey: row.public_key, privateKey: openSecret(app, row.private_key) };
    else {
      keys = generateVapidKeys();
      db.run('INSERT INTO push_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)', keys.publicKey, sealSecret(app, keys.privateKey), now());
    }
    /** Push services want a way to reach the sender: mailto or https. */
    const subject = () => {
      if (process.env.PGHL_PUSH_CONTACT) return process.env.PGHL_PUSH_CONTACT;
      const admin = db.get(`SELECT email FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`);
      if (admin?.email) return `mailto:${admin.email}`;
      return app.baseUrl().startsWith('https://') ? app.baseUrl() : 'mailto:push@example.com';
    };

    const prefsOf = (userId: string): Record<string, boolean> => {
      const p = parseJson(db.get('SELECT kinds FROM push_prefs WHERE user_id = ?', userId), ['kinds'])?.kinds ?? {};
      return Object.fromEntries(Object.keys(PUSH_KINDS).map((k) => [k, p[k] !== false]));
    };

    /** Users who may see this sub-account (and the area behind `kind`). */
    const audience = (locationId: string, kind: string) => {
      const perm = PUSH_KINDS[kind]?.perm;
      return db
        .all('SELECT id, role, locations, permissions FROM users')
        .filter((u) => u.role === 'admin' || JSON.parse(u.locations || '[]').includes(locationId))
        .filter((u) => !hiddenUser(app, u, locationId))
        .filter((u) => u.role === 'admin' || !perm || !u.permissions || JSON.parse(u.permissions).includes(perm))
        .map((u) => u.id as string);
    };
    const mayAccess = (userId: string, locationId: string) => audience(locationId, '').includes(userId);

    async function pushNotify(input: PushInput) {
      const users = (input.userIds ?? (input.locationId ? audience(input.locationId, input.kind) : [])).filter((u) => input.kind === 'test' || prefsOf(u)[input.kind] !== false);
      const title = str(input.title, 'Titel').slice(0, 120) || 'Benachrichtigung';
      const body = String(input.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const url = String(input.url ?? '/app').startsWith('/') ? String(input.url ?? '/app') : '/app';
      const actions = (input.actions ?? [])
        .filter((a) => /^[a-z]{1,20}$/.test(String(a.action)) && String(a.url).startsWith('/') && !String(a.url).startsWith('//'))
        .slice(0, 2)
        .map((a) => ({ action: String(a.action), title: String(a.title).slice(0, 40), url: String(a.url).slice(0, 300) }));
      const out = { users: users.length, sent: 0, failed: 0, removed: 0 };
      // Other channels to the same people (native app push through FCM/APNs: modules/app-push.ts) – app.services.pushSinks.
      const sinks = Promise.all(
        ((app.services.pushSinks ?? []) as PushSink[]).map((sink) =>
          sink({ userIds: users, kind: input.kind, title, body, url, tag: input.tag, locationId: input.locationId }).catch((e: Error) => console.error('[push] sink', e.message)),
        ),
      );
      for (const userId of users) {
        db.insert('push_log', { id: id(), user_id: userId, kind: input.kind, title, body, url, tag: input.tag ?? '', location_id: input.locationId ?? null, created_at: now() });
        db.run(`DELETE FROM push_log WHERE user_id = ? AND id NOT IN (SELECT id FROM push_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ${MAX_LOG})`, userId, userId);
        // The number for the app icon (Badging API in the service worker) – right even while the app is closed.
        const badge = app.services.pushBadge?.(userId);
        const payload = JSON.stringify({ title, body, url, tag: input.tag, kind: input.kind, location_id: input.locationId ?? null, at: now(), ...(typeof badge === 'number' ? { badge } : {}), ...(actions.length ? { actions } : {}) });
        for (const s of db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId)) {
          const r = await sendWebPush(s as any, payload, keys, subject(), { urgency: input.urgency ?? 'normal', topic: input.tag });
          if (r.gone) {
            db.run('DELETE FROM push_subscriptions WHERE id = ?', s.id);
            out.removed++;
          } else if (r.error) {
            db.run('UPDATE push_subscriptions SET last_error = ?, fails = fails + 1 WHERE id = ?', r.error.slice(0, 300), s.id);
            out.failed++;
          } else {
            db.run(`UPDATE push_subscriptions SET last_ok_at = ?, last_error = '', fails = 0 WHERE id = ?`, now(), s.id);
            out.sent++;
          }
        }
      }
      await sinks;
      return out;
    }
    app.services.pushNotify = pushNotify;
    // Event listeners return the promise, so events.flush() (tests, shutdown) waits for delivery.
    const fire = (input: PushInput): Promise<void> => pushNotify(input).then(
      () => undefined,
      (e) => console.error('[push]', (e as Error).message),
    );

    // --- API (per user) -------------------------------------------------------------
    const devices = (userId: string) => db.all('SELECT id, endpoint, user_agent, created_at, last_ok_at, last_error FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC', userId);
    router.get('/api/push/public-key', 'user', () => ({ key: keys.publicKey }));
    router.get('/api/push', 'user', (ctx) => ({
      key: keys.publicKey,
      devices: devices(ctx.user!.id),
      prefs: prefsOf(ctx.user!.id),
      kinds: Object.fromEntries(Object.entries(PUSH_KINDS).map(([k, v]) => [k, v.label])),
    }));
    router.post('/api/push/subscribe', 'user', (ctx) => {
      const sub = ctx.body?.subscription ?? ctx.body ?? {};
      const endpoint = str(sub.endpoint, 'Endpoint', { required: true, max: 1000 });
      if (!isPushEndpoint(endpoint)) throw bad('Unbekannter Push-Dienst');
      const p256dh = str(sub.keys?.p256dh, 'p256dh', { required: true, max: 200 });
      const auth = str(sub.keys?.auth, 'auth', { required: true, max: 100 });
      const pk = fromB64u(p256dh);
      if (pk.length !== 65 || pk[0] !== 4 || fromB64u(auth).length < 16) throw bad('Ungültige Geräteschlüssel');
      const ua = String(ctx.req.headers['user-agent'] ?? '').slice(0, 300);
      // The same browser signing in as someone else takes the device over.
      db.run(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, fails = 0, last_error = ''`,
        id(), ctx.user!.id, endpoint, p256dh, auth, ua, now(),
      );
      db.run(`DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ${MAX_DEVICES})`, ctx.user!.id, ctx.user!.id);
      return { ok: true, devices: devices(ctx.user!.id) };
    });
    router.delete('/api/push/subscribe', 'user', (ctx) => {
      const endpoint = str(ctx.query.get('endpoint'), 'Endpoint', { required: true, max: 1000 });
      db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, ctx.user!.id);
      return { ok: true, devices: devices(ctx.user!.id) };
    });
    router.delete('/api/push/devices/:id', 'user', (ctx) => {
      if (!db.run('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user!.id).changes) throw notFound();
      return { ok: true, devices: devices(ctx.user!.id) };
    });
    router.put('/api/push/prefs', 'user', (ctx) => {
      const cur = prefsOf(ctx.user!.id);
      for (const k of Object.keys(PUSH_KINDS)) if (ctx.body?.[k] !== undefined) cur[k] = !!ctx.body[k];
      db.run('INSERT INTO push_prefs (user_id, kinds) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET kinds = excluded.kinds', ctx.user!.id, JSON.stringify(cur));
      return cur;
    });
    router.post('/api/push/test', 'user', async (ctx) => {
      if (!db.get('SELECT id FROM push_subscriptions WHERE user_id = ?', ctx.user!.id)) throw bad('Benachrichtigungen sind noch auf keinem Gerät eingeschaltet');
      const r = await pushNotify({ userIds: [ctx.user!.id], kind: 'test', title: 'Test-Benachrichtigung', body: 'So sehen Benachrichtigungen auf diesem Gerät aus.', url: '/app/settings/account', tag: 'test' });
      if (!r.sent) {
        const err = db.get(`SELECT last_error FROM push_subscriptions WHERE user_id = ? AND last_error != '' ORDER BY created_at DESC`, ctx.user!.id)?.last_error;
        throw bad(`Senden fehlgeschlagen${err ? `: ${err}` : ' – bitte Benachrichtigungen auf dem Gerät neu einschalten'}`);
      }
      return r;
    });
    /** The service worker asks here when a push arrived without readable content. */
    router.get('/api/push/latest', 'user', (ctx) => db.get('SELECT title, body, url, tag, kind, location_id, created_at FROM push_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', ctx.user!.id) ?? {});

    // --- what triggers a push ---------------------------------------------------------
    const multi = () => (db.get<{ n: number }>('SELECT COUNT(*) n FROM locations')?.n ?? 1) > 1;
    const projectSuffix = (locationId: string) => (multi() ? ` · ${app.location(locationId)?.name ?? ''}` : '');
    const preview = (s: string) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

    // A busy chat must not buzz for every line: one push per conversation and half minute.
    const lastConv = new Map<string, number>();
    app.events.on('message.inbound', (e) => {
      const m = e.data.message ?? {};
      const c = e.data.contact ?? {};
      const conv = String(m.conversation_id ?? '');
      if (conv) {
        const last = lastConv.get(conv) ?? 0;
        if (Date.now() - last < 30_000) return;
        lastConv.set(conv, Date.now());
        if (lastConv.size > 5000) lastConv.clear();
      }
      const who = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.phone || 'Unbekannt';
      const label = m.channel === 'email' ? 'Neue E-Mail' : m.channel === 'sms' ? 'Neue SMS' : m.channel === 'chat' ? 'Neue Chat-Nachricht' : 'Neue Nachricht';
      // Assigned contacts notify their owner only; everyone else's go to the team.
      // A conversation with an assignee (Team-Posteingang) tells only them; otherwise the contact's owner, otherwise the team.
      const owner = (conv ? (app.services.inboxAudience?.(e.locationId, conv) as string[] | undefined) : undefined) ?? (c.assigned_to && mayAccess(c.assigned_to, e.locationId) ? [c.assigned_to as string] : undefined);
      return fire({
        locationId: e.locationId,
        userIds: owner,
        kind: 'messages',
        title: `${label} von ${who}${projectSuffix(e.locationId)}`,
        body: [m.subject, preview(m.body)].filter(Boolean).join(' – '),
        url: conv ? `/app/conversations/${conv}` : '/app/conversations',
        tag: conv ? `conv-${conv}` : undefined,
      });
    });

    const uptime = (down: boolean) => (e: { locationId: string; data: Record<string, any> }) => {
      const name = app.location(e.locationId)?.name ?? 'Projekt';
      return fire({
        locationId: e.locationId,
        kind: 'uptime',
        title: down ? `⚠️ ${name} ist nicht erreichbar` : `✅ ${name} ist wieder online`,
        body: `${e.data.website ?? ''} – Status ${e.data.status || 'keine Antwort'}${e.data.ms ? ` (${e.data.ms} ms)` : ''}`,
        url: '/app/project',
        tag: `uptime-${e.locationId}`,
        urgency: down ? 'high' : 'normal',
      });
    };
    app.events.on('website.down', uptime(true));
    app.events.on('website.up', uptime(false));

    // Tasks: assigned to someone else (through the app, API or MCP) …
    const seen = (taskId: string, kind: string) => db.run('INSERT OR IGNORE INTO push_task_seen (task_id, kind, at) VALUES (?, ?, ?)', taskId, kind, now()).changes === 0;
    const due = (d: string | null) => (d ? new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '');
    function taskAssigned(locationId: string, task: any, actorId?: string) {
      if (!task?.assigned_to || task.done) return;
      if (seen(task.id, `assigned:${task.assigned_to}`)) return;
      if (task.assigned_to === actorId || !mayAccess(task.assigned_to, locationId)) return;
      void fire({
        locationId,
        userIds: [task.assigned_to],
        kind: 'tasks',
        title: `Neue Aufgabe für dich${projectSuffix(locationId)}`,
        body: `${task.title}${task.due_at ? ` · fällig ${due(task.due_at)}` : ''}`,
        url: '/app/tasks',
        tag: `task-${task.id}`,
      });
    }
    app.afterWrite.push((ctx: Ctx, route, result: any) => {
      const isTask = (route.method === 'POST' && route.pattern === '/api/tasks') || (route.method === 'PATCH' && route.pattern === '/api/tasks/:id');
      if (isTask && result && typeof result === 'object' && result.id) taskAssigned(ctx.locationId || result.location_id, result, ctx.user?.id);
    });

    /** Local calendar day of a due date; date-only values (UTC midnight) keep their date. */
    const dueDay = (dueAt: string, tz: string) => (/T00:00:00(\.000)?Z$/.test(dueAt) ? dueAt.slice(0, 10) : ymdInTz(new Date(dueAt), tz));

    // … created by workflows (no request behind them), and "due today" once a day from 8:00.
    let lastScan = 0;
    async function scanTasks(at = new Date()) {
      const since = new Date(at.getTime() - 3600_000).toISOString();
      for (const t of db.all(`SELECT * FROM tasks WHERE done = 0 AND assigned_to IS NOT NULL AND created_at > ? LIMIT 500`, since)) taskAssigned(t.location_id, t);
      for (const loc of db.all('SELECT id, timezone FROM locations')) {
        const tz = loc.timezone || 'Europe/Berlin';
        if (hmInTz(at, tz) < '08:00') continue;
        const today = ymdInTz(at, tz);
        const rows = db.all(
          `SELECT * FROM tasks WHERE location_id = ? AND done = 0 AND assigned_to IS NOT NULL AND due_at IS NOT NULL AND due_at BETWEEN ? AND ?`,
          loc.id, new Date(at.getTime() - 2 * 864e5).toISOString(), new Date(at.getTime() + 2 * 864e5).toISOString(),
        ).filter((t) => dueDay(t.due_at, tz) === today && !seen(t.id, `due:${today}`));
        const byUser = new Map<string, any[]>();
        for (const t of rows) byUser.set(t.assigned_to, [...(byUser.get(t.assigned_to) ?? []), t]);
        for (const [userId, list] of byUser) {
          if (!mayAccess(userId, loc.id)) continue;
          await pushNotify({
            locationId: loc.id,
            userIds: [userId],
            kind: 'tasks',
            title: list.length === 1 ? `Heute fällig: ${list[0].title}` : `${list.length} Aufgaben heute fällig${projectSuffix(loc.id)}`,
            body: list.length === 1 ? (list[0].description || app.location(loc.id)?.name || '') : list.map((t) => t.title).join(' · '),
            url: '/app/tasks',
            tag: `due-${loc.id}-${today}`,
          }).catch((e) => console.error('[push] fällig', (e as Error).message));
        }
      }
      db.run('DELETE FROM push_task_seen WHERE at < ?', new Date(at.getTime() - 14 * 864e5).toISOString());
    }
    app.services.scanTaskPushes = scanTasks;
    app.onTick(async () => {
      if (Date.now() - lastScan < 2 * 60_000) return;
      lastScan = Date.now();
      await scanTasks();
    });

    // --- installable app ----------------------------------------------------------------
    const locationByHost = (ctx: Ctx) => {
      const host = String(ctx.req.headers.host ?? '').split(':')[0].toLowerCase();
      return host ? db.get(`SELECT id FROM locations WHERE json_extract(settings, '$.branding.app_domain') = ?`, host)?.id : undefined;
    };
    router.get('/manifest.webmanifest', 'public', (ctx) => {
      // Name, colour and icons of the white label; the iPhone/iPad parts (touch icons, launch images): modules/pwa-ios.ts.
      const brand = pwaBrand(effectiveBranding(app, locationByHost(ctx)));
      const manifest = appManifest(brand, brand.custom ? brandKey(brand) : '');
      const r = text(JSON.stringify(manifest), 'application/manifest+json; charset=utf-8');
      r.headers['cache-control'] = 'no-cache';
      return r;
    });
  },
};

/** A further delivery channel for every push (registered in app.services.pushSinks); `userIds` are already filtered by preference. */
export type PushSink = (p: { userIds: string[]; kind: string; title: string; body: string; url: string; tag?: string; locationId?: string }) => Promise<void>;

export type PushNotify = (input: PushInput) => Promise<{ users: number; sent: number; failed: number; removed: number }>;
