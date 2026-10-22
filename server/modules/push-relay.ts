import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now, sha256, token } from '../core/util.js';
import { openSecret, sealSecret } from '../core/secrets.js';
import { RateLimiter, minimalMessage, transportFromEnv, type ContentMode, type NativeTransport, type PushProvider } from '../services/native-push.js';

/**
 * Push relay for the gray-label app (docs/apps.md#push-relay). Only active with `PGHL_PUSH_RELAY=1` – on the operator's cloud
 * instance, which holds the FCM/APNs keys of the app published under the operator's developer accounts.
 *
 * - A self-hosted instance registers once (`POST /api/push-relay/instances`) and gets a token `ghr_…` (stored hashed).
 * - The instance hands the relay the device tokens of its app users and gets opaque handles back; raw tokens stay sealed here,
 *   and a handle only works for the instance that registered it.
 * - `POST /api/push-relay/send` delivers to handles. The relay re-applies the privacy rules (generic title unless the instance
 *   asked for `preview`, short plain text, a path inside /app) and rate limits per instance and per device.
 * - The operator revokes or restores instances and changes their limit (`/api/push-relay/admin/*`); an instance can revoke itself.
 */

const TOKEN_PREFIX = 'ghr_';
const MAX_HANDLES_PER_SEND = 100;
const PER_DEVICE_PER_MIN = 30;
const REGISTRATIONS_PER_IP_HOUR = 10;

export const relayEnabled = (env: NodeJS.ProcessEnv = process.env) => env.PGHL_PUSH_RELAY === '1';
const defaultRate = () => Math.max(1, Math.round(Number(process.env.PGHL_PUSH_RELAY_RATE) || 600));

export const pushRelayModule: Module = {
  name: 'push-relay',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE push_relay_instances (
        id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', revoked_reason TEXT NOT NULL DEFAULT '', rate_per_min INTEGER, sent INTEGER NOT NULL DEFAULT 0,
        rejected INTEGER NOT NULL DEFAULT 0, created_ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_used_at TEXT
      );
      CREATE TABLE push_relay_devices (
        handle TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES push_relay_instances(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, token_hash TEXT NOT NULL, token TEXT NOT NULL, created_at TEXT NOT NULL, last_ok_at TEXT,
        UNIQUE (instance_id, token_hash)
      );
      `,
    ],
  ],
  register(app) {
    if (!relayEnabled()) return;
    const { db, router } = app;
    const limiter = new RateLimiter();
    const registrations = new Map<string, number[]>();
    const transport = (): NativeTransport => (app.services.nativePushTransport as NativeTransport | undefined) ?? (cachedTransport ??= transportFromEnv());
    let cachedTransport: NativeTransport | undefined;

    /** The calling instance from its `ghr_` token; revoked instances get 403 with the reason. */
    const instanceOf = (ctx: Ctx) => {
      const tok = String(ctx.req.headers.authorization ?? '').match(/^Bearer\s+(ghr_[\w-]+)$/i)?.[1];
      if (!tok) throw new HttpError(401, 'Relay-Token fehlt (Authorization: Bearer ghr_…)');
      const row = db.get('SELECT * FROM push_relay_instances WHERE token_hash = ?', sha256(tok));
      if (!row) throw new HttpError(401, 'Unbekannter Relay-Token');
      if (row.status !== 'active') throw new HttpError(403, `Relay-Zugang gesperrt${row.revoked_reason ? `: ${row.revoked_reason}` : ''}`);
      return row;
    };
    const instanceOut = (r: any) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      prefix: r.prefix,
      status: r.status,
      revoked_reason: r.revoked_reason,
      rate_per_min: r.rate_per_min ?? defaultRate(),
      sent: Number(r.sent),
      rejected: Number(r.rejected),
      devices: Number(db.get('SELECT COUNT(*) n FROM push_relay_devices WHERE instance_id = ?', r.id)?.n ?? 0),
      created_at: r.created_at,
      last_used_at: r.last_used_at,
    });

    // --- instances ------------------------------------------------------------------------------------------------------------
    router.post('/api/push-relay/instances', 'public', (ctx) => {
      const t = Date.now();
      const recent = (registrations.get(ctx.ip) ?? []).filter((x) => t - x < 3600_000);
      if (recent.length >= REGISTRATIONS_PER_IP_HOUR) throw new HttpError(429, 'Zu viele Registrierungen von dieser Adresse – bitte später erneut');
      registrations.set(ctx.ip, [...recent, t]);
      if (registrations.size > 10_000) registrations.clear();
      const url = str(ctx.body?.url, 'url', { required: true, max: 300 }).replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s/]+/i.test(url)) throw bad('url muss die Adresse der Instanz sein (https://…)');
      const raw = `${TOKEN_PREFIX}${token(32)}`;
      const row = {
        id: `ri_${id(16)}`,
        name: str(ctx.body?.name, 'name', { max: 100 }),
        url,
        token_hash: sha256(raw),
        prefix: raw.slice(0, 10),
        created_ip: ctx.ip.slice(0, 64),
        created_at: now(),
      };
      db.insert('push_relay_instances', row);
      return { instance_id: row.id, token: raw, rate_per_min: defaultRate() };
    });
    router.get('/api/push-relay/status', 'public', (ctx) => instanceOut(instanceOf(ctx)));
    // An instance withdraws its own access (e.g. it switched to its own keys): the token and all handles die.
    router.delete('/api/push-relay/instances/me', 'public', (ctx) => {
      const inst = instanceOf(ctx);
      db.run('DELETE FROM push_relay_devices WHERE instance_id = ?', inst.id);
      db.run(`UPDATE push_relay_instances SET status = 'revoked', revoked_reason = 'von der Instanz selbst zurückgezogen' WHERE id = ?`, inst.id);
      return { ok: true };
    });

    // --- devices --------------------------------------------------------------------------------------------------------------
    router.post('/api/push-relay/devices', 'public', (ctx) => {
      const inst = instanceOf(ctx);
      const provider = String(ctx.body?.provider ?? '') as PushProvider;
      if (provider !== 'fcm' && provider !== 'apns') throw bad('provider muss fcm oder apns sein');
      const tok = str(ctx.body?.token, 'token', { required: true, max: 4096 });
      if (!/^[\w:.-]{20,4096}$/.test(tok)) throw bad('Ungültiger Geräte-Token');
      const hash = sha256(`${provider}:${tok}`);
      const have = db.get('SELECT handle FROM push_relay_devices WHERE instance_id = ? AND token_hash = ?', inst.id, hash);
      if (have) return { handle: have.handle };
      const handle = `rh_${id(24)}`;
      db.insert('push_relay_devices', { handle, instance_id: inst.id, provider, token_hash: hash, token: sealSecret(app, tok), created_at: now() });
      return { handle };
    });
    router.delete('/api/push-relay/devices/:handle', 'public', (ctx) => {
      const inst = instanceOf(ctx);
      db.run('DELETE FROM push_relay_devices WHERE handle = ? AND instance_id = ?', ctx.params.handle, inst.id);
      return { ok: true };
    });

    // --- send -----------------------------------------------------------------------------------------------------------------
    router.post('/api/push-relay/send', 'public', async (ctx) => {
      const inst = instanceOf(ctx);
      const b = ctx.body ?? {};
      const handles = [...new Set((Array.isArray(b.handles) ? b.handles : []).map(String))].slice(0, MAX_HANDLES_PER_SEND + 1) as string[];
      if (!handles.length) throw bad('handles fehlt');
      if (handles.length > MAX_HANDLES_PER_SEND) throw bad(`Höchstens ${MAX_HANDLES_PER_SEND} Geräte je Aufruf`);
      const limit = Number(inst.rate_per_min ?? defaultRate());
      if (!limiter.take(`i:${inst.id}`, limit, handles.length)) {
        db.run('UPDATE push_relay_instances SET rejected = rejected + ? WHERE id = ?', handles.length, inst.id);
        throw new HttpError(429, `Limit erreicht (${limit} Mitteilungen je Minute) – bitte kurz warten`);
      }
      const mode: ContentMode = b.content === 'preview' ? 'preview' : 'generic';
      const msg = minimalMessage(b, mode);
      const results: { handle: string; ok: boolean; gone?: boolean; error?: string }[] = [];
      for (const handle of handles) {
        const d = db.get('SELECT * FROM push_relay_devices WHERE handle = ? AND instance_id = ?', handle, inst.id);
        if (!d) {
          results.push({ handle, ok: false, gone: true, error: 'unbekannt' });
          continue;
        }
        if (!limiter.take(`d:${handle}`, PER_DEVICE_PER_MIN)) {
          results.push({ handle, ok: false, error: 'Limit je Gerät erreicht' });
          continue;
        }
        let tok = '';
        try {
          tok = openSecret(app, d.token);
        } catch {
          /* key rotated away: treat as gone */
        }
        const r = tok ? await transport().send({ provider: d.provider, token: tok }, msg) : { ok: false, gone: true, error: 'Token nicht lesbar' };
        if (r.gone) db.run('DELETE FROM push_relay_devices WHERE handle = ?', handle);
        else if (r.ok) db.run('UPDATE push_relay_devices SET last_ok_at = ? WHERE handle = ?', now(), handle);
        results.push({ handle, ok: r.ok, ...(r.gone ? { gone: true } : {}), ...(r.error ? { error: r.error } : {}) });
      }
      db.run('UPDATE push_relay_instances SET sent = sent + ?, last_used_at = ? WHERE id = ?', results.filter((r) => r.ok).length, now(), inst.id);
      return { results };
    });

    // --- operator -------------------------------------------------------------------------------------------------------------
    router.get('/api/push-relay/admin/instances', 'admin', () => db.all('SELECT * FROM push_relay_instances ORDER BY created_at DESC LIMIT 1000').map(instanceOut));
    const setStatus = (status: 'active' | 'revoked') => (ctx: Ctx) => {
      const r = db.get('SELECT * FROM push_relay_instances WHERE id = ?', ctx.params.id);
      if (!r) throw notFound('Instanz nicht gefunden');
      db.run('UPDATE push_relay_instances SET status = ?, revoked_reason = ? WHERE id = ?', status, status === 'revoked' ? str(ctx.body?.reason, 'reason', { max: 200 }) : '', r.id);
      return instanceOut(db.get('SELECT * FROM push_relay_instances WHERE id = ?', r.id));
    };
    router.post('/api/push-relay/admin/instances/:id/revoke', 'admin', setStatus('revoked'));
    router.post('/api/push-relay/admin/instances/:id/restore', 'admin', setStatus('active'));
    router.patch('/api/push-relay/admin/instances/:id', 'admin', (ctx) => {
      const r = db.get('SELECT * FROM push_relay_instances WHERE id = ?', ctx.params.id);
      if (!r) throw notFound('Instanz nicht gefunden');
      const rate = ctx.body?.rate_per_min;
      const v = rate === null ? null : Math.round(Number(rate));
      if (v !== null && !(v >= 1 && v <= 100_000)) throw bad('rate_per_min: 1 bis 100000 (oder null für den Standard)');
      db.run('UPDATE push_relay_instances SET rate_per_min = ? WHERE id = ?', v, r.id);
      return instanceOut(db.get('SELECT * FROM push_relay_instances WHERE id = ?', r.id));
    });
  },
};
