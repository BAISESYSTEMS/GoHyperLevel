import type { Module } from '../core/app.js';
import { HttpError, bad, str, type Ctx } from '../core/http.js';
import { openSecret, sealSecret } from '../core/secrets.js';
import { id, now, sha256 } from '../core/util.js';
import { configuredProviders, minimalMessage, transportFromEnv, type ContentMode, type NativeTransport, type PushProvider } from '../services/native-push.js';
import { getBranding } from './agency.js';
import type { PushSink } from './push.js';

/**
 * Native push for the apps on this instance (docs/apps.md#push): the app sends its FCM/APNs token to
 * `POST /api/mobile/push-token`; every push of the instance (modules/push.ts, through app.services.pushSinks) then also goes to
 * the person's phones.
 *
 * `PGHL_PUSH_MODE`:
 * - `relay` (default): the gray-label app's keys belong to the operator, so pushes go through the operator's relay
 *   (`PGHL_PUSH_RELAY_URL`, default https://gohyperlevel.com). The instance registers itself there on first use; it keeps only
 *   opaque handles, never the raw tokens, and sends no content unless the admin chose `preview`.
 * - `own`: an own-brand app with the agency's own Firebase project / APNs key (`PGHL_FCM_SERVICE_ACCOUNT`, `PGHL_APNS_*`):
 *   pushes go straight to Google/Apple.
 * - `off`: no native push (the Android app keeps polling its feed).
 */

export type PushMode = 'relay' | 'own' | 'off';
export const DEFAULT_RELAY = 'https://gohyperlevel.com';

export function pushMode(env: NodeJS.ProcessEnv = process.env): PushMode {
  const m = String(env.PGHL_PUSH_MODE ?? '').trim().toLowerCase();
  return m === 'own' || m === 'off' ? m : 'relay';
}
export const relayUrl = (env: NodeJS.ProcessEnv = process.env) => String(env.PGHL_PUSH_RELAY_URL ?? '').trim().replace(/\/+$/, '') || DEFAULT_RELAY;

interface AppPushSettings {
  content: ContentMode;
  relay_url?: string;
  instance_id?: string;
  token?: string;
  registered_at?: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<any> }>;

export function appPushSettings(app: { db: any }): AppPushSettings {
  const row = app.db.get('SELECT value FROM agency_settings WHERE key = ?', 'app_push');
  const s = row ? JSON.parse(row.value) : {};
  return { ...s, content: s.content === 'preview' ? 'preview' : 'generic' };
}

export const appPushModule: Module = {
  name: 'app-push',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE app_push_tokens (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES mobile_devices(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
        provider TEXT NOT NULL, via TEXT NOT NULL, ref TEXT NOT NULL, token_hash TEXT NOT NULL, app_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, last_ok_at TEXT, last_error TEXT NOT NULL DEFAULT '', UNIQUE (device_id, provider)
      );
      CREATE INDEX app_push_tokens_user ON app_push_tokens(user_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const fetchFn = (): FetchLike => (app.services.pushRelayFetch as FetchLike | undefined) ?? (fetch as unknown as FetchLike);
    let ownTransport: NativeTransport | undefined;
    const transport = (): NativeTransport => (app.services.nativePushTransport as NativeTransport | undefined) ?? (ownTransport ??= transportFromEnv());

    const save = (s: AppPushSettings) =>
      db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'app_push', JSON.stringify(s));

    const relay = async (path: string, method: string, body?: unknown, tok?: string) => {
      const r = await fetchFn()(`${relayUrl()}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status >= 400) throw new HttpError(r.status === 429 ? 429 : 502, `Push-Relay: ${data?.error ?? `HTTP ${r.status}`}`);
      return data;
    };

    /** The relay token, registering this instance on first use (or again when the relay address changed). */
    async function relayToken(force = false): Promise<string> {
      const s = appPushSettings(app);
      if (!force && s.token && s.relay_url === relayUrl()) {
        try {
          return openSecret(app, s.token);
        } catch {
          /* data key rotated away: register again */
        }
      }
      const r = await relay('/api/push-relay/instances', 'POST', { url: app.baseUrl(), name: getBranding(app).name });
      save({ ...s, relay_url: relayUrl(), instance_id: r.instance_id, token: sealSecret(app, String(r.token)), registered_at: now() });
      return String(r.token);
    }

    // --- the app's token -----------------------------------------------------------------------------------------------------
    const deviceIdOf = (ctx: Ctx): string => {
      if (ctx.via !== 'app') throw new HttpError(403, 'Nur aus der App (Geräte-Token)');
      const tok = String(ctx.req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
      const d = db.get('SELECT id FROM mobile_devices WHERE token_hash = ?', sha256(tok));
      if (!d) throw new HttpError(401, 'Gerät unbekannt');
      return d.id;
    };
    router.post('/api/mobile/push-token', 'user', async (ctx) => {
      const deviceId = deviceIdOf(ctx);
      const mode = pushMode();
      if (mode === 'off') return { ok: false, mode, reason: 'Native Mitteilungen sind auf diesem Server ausgeschaltet' };
      const provider = String(ctx.body?.provider ?? '') as PushProvider;
      if (provider !== 'fcm' && provider !== 'apns') throw bad('provider muss fcm oder apns sein');
      const tok = str(ctx.body?.token, 'token', { required: true, max: 4096 });
      if (!/^[\w:.-]{20,4096}$/.test(tok)) throw bad('Ungültiger Geräte-Token');
      const appId = str(ctx.body?.app_id, 'app_id', { max: 200 });
      const hash = sha256(`${provider}:${tok}`);
      const have = db.get('SELECT * FROM app_push_tokens WHERE device_id = ? AND provider = ?', deviceId, provider);
      if (have && have.token_hash === hash && have.via === mode) return { ok: true, mode };
      let ref: string;
      if (mode === 'relay') {
        const r = await relay('/api/push-relay/devices', 'POST', { provider, token: tok }, await relayToken());
        ref = String(r.handle);
      } else {
        if (!configuredProviders().includes(provider) && !app.services.nativePushTransport) throw bad(`${provider.toUpperCase()} ist auf diesem Server nicht eingerichtet`);
        ref = sealSecret(app, tok);
      }
      db.run(
        `INSERT INTO app_push_tokens (id, device_id, user_id, provider, via, ref, token_hash, app_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, provider) DO UPDATE SET via = excluded.via, ref = excluded.ref, token_hash = excluded.token_hash, app_id = excluded.app_id, last_error = ''`,
        id(), deviceId, ctx.user!.id, provider, mode, ref, hash, appId, now(),
      );
      return { ok: true, mode };
    });
    router.delete('/api/mobile/push-token', 'user', (ctx) => {
      db.run('DELETE FROM app_push_tokens WHERE device_id = ?', deviceIdOf(ctx));
      return { ok: true };
    });

    // --- delivery (every push of the instance) -------------------------------------------------------------------------------
    const sink: PushSink = async (p) => {
      const mode = pushMode();
      if (mode === 'off' || !p.userIds.length) return;
      const rows = db.all(`SELECT * FROM app_push_tokens WHERE via = ? AND user_id IN (${p.userIds.map(() => '?').join(',')})`, mode, ...p.userIds);
      if (!rows.length) return;
      const content = appPushSettings(app).content;
      const badgeOf = (userId: string) => app.services.pushBadge?.(userId) as number | undefined;
      const done = (row: any, r: { ok: boolean; gone?: boolean; error?: string }) => {
        if (r.gone) db.run('DELETE FROM app_push_tokens WHERE id = ?', row.id);
        else if (r.ok) db.run(`UPDATE app_push_tokens SET last_ok_at = ?, last_error = '' WHERE id = ?`, now(), row.id);
        else db.run('UPDATE app_push_tokens SET last_error = ? WHERE id = ?', String(r.error ?? 'Fehler').slice(0, 200), row.id);
      };
      if (mode === 'own') {
        for (const row of rows) {
          let tok = '';
          try {
            tok = openSecret(app, row.ref);
          } catch {
            done(row, { ok: false, gone: true });
            continue;
          }
          done(row, await transport().send({ provider: row.provider, token: tok }, minimalMessage({ ...p, badge: badgeOf(row.user_id) }, content)));
        }
        return;
      }
      // Relay: one call per user (the badge differs per person), handles only.
      const byUser = new Map<string, any[]>();
      for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
      const tok = await relayToken();
      for (const [userId, list] of byUser) {
        const msg = minimalMessage({ ...p, badge: badgeOf(userId) }, content);
        const body = { handles: list.map((r) => r.ref), content, ...msg };
        const res = await relay('/api/push-relay/send', 'POST', body, tok);
        const byHandle = new Map<string, any>((res.results ?? []).map((x: any) => [String(x.handle), x]));
        for (const row of list) done(row, byHandle.get(row.ref) ?? { ok: false, error: 'keine Antwort' });
      }
    };
    app.services.pushSinks = [...(app.services.pushSinks ?? []), sink];

    // --- admin ---------------------------------------------------------------------------------------------------------------
    const status = () => {
      const s = appPushSettings(app);
      const mode = pushMode();
      return {
        mode,
        content: s.content,
        relay_url: mode === 'relay' ? relayUrl() : null,
        relay_registered: mode === 'relay' ? !!(s.token && s.relay_url === relayUrl()) : null,
        relay_instance_id: mode === 'relay' ? (s.instance_id ?? null) : null,
        own_providers: configuredProviders(),
        devices: Number(db.get('SELECT COUNT(*) n FROM app_push_tokens WHERE via = ?', mode)?.n ?? 0),
      };
    };
    app.services.appPushStatus = status;
    router.get('/api/agency/app-push', 'admin', status);
    router.patch('/api/agency/app-push', 'admin', (ctx) => {
      const c = ctx.body?.content;
      if (c !== undefined && c !== 'generic' && c !== 'preview') throw bad('content: generic oder preview');
      if (c) save({ ...appPushSettings(app), content: c });
      return status();
    });
    router.post('/api/agency/app-push/relay/register', 'admin', async () => {
      if (pushMode() !== 'relay') throw bad('Nur im Relay-Modus (PGHL_PUSH_MODE=relay)');
      await relayToken(true);
      db.run(`DELETE FROM app_push_tokens WHERE via = 'relay'`); // old handles belong to the old registration; apps re-send their tokens
      return status();
    });
  },
};
