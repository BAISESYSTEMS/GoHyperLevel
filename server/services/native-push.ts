import { createSign, sign as edSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:http2';

/**
 * Native push for the apps (FCM for Android, APNs for iOS) – used by the push relay (`PGHL_PUSH_RELAY=1`, modules/push-relay.ts)
 * and by instances that bring their own keys (`PGHL_PUSH_MODE=own`, modules/app-push.ts).
 *
 * Privacy: by default a push carries no content at all – only a generic title such as „Neue Nachricht“ and the app section to
 * open. The app then fetches the details from its own instance. `preview` (an instance's explicit choice) adds a short title/body.
 * Node built-ins only: FCM HTTP v1 with a service-account JWT (RS256), APNs over HTTP/2 with a provider JWT (ES256).
 */

export type PushProvider = 'fcm' | 'apns';
export type ContentMode = 'generic' | 'preview';

/** What goes to a device. Everything is short plain text; `url` is a path inside the web app. */
export interface NativeMessage {
  title: string;
  body: string;
  kind: string;
  url: string;
  badge?: number;
  tag?: string;
}

export interface SendResult {
  ok: boolean;
  /** The token is dead (app uninstalled, token rotated): forget it. */
  gone?: boolean;
  error?: string;
}

export interface NativeTransport {
  send(target: { provider: PushProvider; token: string }, msg: NativeMessage): Promise<SendResult>;
}

/** Titles without any content – what the lock screen shows by default. */
export const GENERIC_TITLES: Record<string, string> = {
  messages: 'Neue Nachricht',
  chat: 'Neue Nachricht',
  tasks: 'Neue Aufgabe',
  uptime: 'Website-Status geändert',
  payments: 'Neue Zahlung',
  feedback: 'Neue Antwort',
  canvas: 'Neue Erwähnung',
  test: 'Test-Benachrichtigung',
};
export const DEFAULT_TITLE = 'Neue Nachricht';

const plain = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/<[^>]*>/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** "/app/conversations/abc?x=1" → "/app/conversations": no record ids leave the instance in generic mode. */
export function sectionOf(url: unknown): string {
  const path = String(url ?? '').split(/[?#]/)[0];
  if (!path.startsWith('/app') || path.startsWith('//')) return '/app';
  const parts = path.split('/').filter(Boolean).slice(0, 2);
  return `/${parts.join('/')}`.replace(/[^\w/-]/g, '') || '/app';
}

/** A push as it may leave the instance (and the relay): minimal unless the instance chose `preview`. */
export function minimalMessage(input: { kind?: unknown; title?: unknown; body?: unknown; url?: unknown; badge?: unknown; tag?: unknown }, mode: ContentMode = 'generic'): NativeMessage {
  const kind = /^[a-z_]{1,20}$/.test(String(input.kind ?? '')) ? String(input.kind) : 'messages';
  const badge = Number(input.badge);
  const base = {
    kind,
    ...(Number.isInteger(badge) && badge >= 0 && badge < 100_000 ? { badge } : {}),
    ...(typeof input.tag === 'string' && /^[\w:.-]{1,64}$/.test(input.tag) ? { tag: mode === 'preview' ? input.tag : kind } : {}),
  };
  if (mode === 'preview') {
    const raw = String(input.url ?? '').split('#')[0];
    const url = raw.startsWith('/app') && !raw.startsWith('//') ? raw.slice(0, 200) : '/app';
    return { ...base, title: plain(input.title, 80) || GENERIC_TITLES[kind] || DEFAULT_TITLE, body: plain(input.body, 160), url };
  }
  return { ...base, title: GENERIC_TITLES[kind] ?? DEFAULT_TITLE, body: '', url: sectionOf(input.url) };
}

/** Sliding one-minute counters (per instance, per device). */
export class RateLimiter {
  private hits = new Map<string, { n: number; at: number }>();
  constructor(private clock: () => number = Date.now) {}
  /** Counts `n` hits for `key`; false when that would pass `limit` within the minute (nothing is counted then). */
  take(key: string, limit: number, n = 1): boolean {
    const t = this.clock();
    const h = this.hits.get(key);
    if (!h || t - h.at >= 60_000) {
      if (n > limit) return false;
      this.hits.set(key, { n, at: t });
      if (this.hits.size > 50_000) this.hits.clear();
      return true;
    }
    if (h.n + n > limit) return false;
    h.n += n;
    return true;
  }
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

// --- FCM HTTP v1 ---------------------------------------------------------------------------------------------------------------

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export function fcmSender(sa: ServiceAccount, fetchFn: FetchLike = fetch as unknown as FetchLike) {
  let cached: { token: string; exp: number } | null = null;
  async function accessToken(): Promise<string> {
    const t = Math.floor(Date.now() / 1000);
    if (cached && cached.exp - 60 > t) return cached.token;
    const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud, iat: t, exp: t + 3600 }));
    const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key).toString('base64url');
    const r = await fetchFn(aud, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const j = JSON.parse((await r.text()) || '{}');
    if (r.status !== 200 || !j.access_token) throw new Error(`FCM-Anmeldung fehlgeschlagen (${r.status})`);
    cached = { token: j.access_token, exp: t + Number(j.expires_in ?? 3600) };
    return cached.token;
  }
  return async (token: string, msg: NativeMessage): Promise<SendResult> => {
    // Data-only: the Android app shows the notification itself (after fetching details from its instance).
    const data: Record<string, string> = { title: msg.title, body: msg.body, kind: msg.kind, url: msg.url, ...(msg.badge !== undefined ? { badge: String(msg.badge) } : {}), ...(msg.tag ? { tag: msg.tag } : {}) };
    const r = await fetchFn(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: '86400s', ...(msg.tag ? { collapse_key: msg.tag } : {}) } } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 200) return { ok: true };
    const body = await r.text();
    const gone = r.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT.*token/i.test(body);
    return { ok: false, gone, error: `FCM ${r.status}` };
  };
}

// --- APNs ----------------------------------------------------------------------------------------------------------------------

export interface ApnsConfig {
  key: string;
  keyId: string;
  teamId: string;
  topic: string;
  sandbox?: boolean;
}

export type Http2Request = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>;

/** One request over HTTP/2 (APNs speaks nothing else). */
export const http2Request: Http2Request = (url, headers, body) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const session = connect(u.origin);
    session.on('error', reject);
    const req = session.request({ ':method': 'POST', ':path': u.pathname, ...headers });
    let status = 0;
    let out = '';
    req.setTimeout(15_000, () => req.close());
    req.on('response', (h) => (status = Number(h[':status'])));
    req.on('data', (c) => (out += c));
    req.on('end', () => {
      session.close();
      resolve({ status, body: out });
    });
    req.on('error', (e) => {
      session.close();
      reject(e);
    });
    req.end(body);
  });

export function apnsSender(cfg: ApnsConfig, request: Http2Request = http2Request) {
  let cached: { jwt: string; at: number } | null = null;
  const jwt = () => {
    const t = Math.floor(Date.now() / 1000);
    // Apple wants a new provider token at most every 20 minutes and at least every 60.
    if (cached && t - cached.at < 40 * 60) return cached.jwt;
    const data = `${b64u(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }))}.${b64u(JSON.stringify({ iss: cfg.teamId, iat: t }))}`;
    const sig = edSign('sha256', Buffer.from(data), { key: cfg.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    cached = { jwt: `${data}.${sig}`, at: t };
    return cached.jwt;
  };
  return async (token: string, msg: NativeMessage): Promise<SendResult> => {
    const host = cfg.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const payload = {
      aps: { alert: { title: msg.title, ...(msg.body ? { body: msg.body } : {}) }, sound: 'default', 'mutable-content': 1, ...(msg.badge !== undefined ? { badge: msg.badge } : {}), ...(msg.tag ? { 'thread-id': msg.tag } : {}) },
      kind: msg.kind,
      url: msg.url,
    };
    const r = await request(`${host}/3/device/${encodeURIComponent(token)}`, {
      authorization: `bearer ${jwt()}`,
      'apns-topic': cfg.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      ...(msg.tag ? { 'apns-collapse-id': msg.tag.slice(0, 64) } : {}),
    }, JSON.stringify(payload));
    if (r.status === 200) return { ok: true };
    const gone = r.status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(r.body);
    return { ok: false, gone, error: `APNs ${r.status}` };
  };
}

// --- configuration -------------------------------------------------------------------------------------------------------------

/** A value that is either the content itself or the path of a file holding it. */
const fileOrValue = (v: string | undefined) => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.startsWith('{') || s.startsWith('-----')) return s;
  return existsSync(s) ? readFileSync(s, 'utf8') : '';
};

/** Which providers the environment has keys for (PGHL_FCM_SERVICE_ACCOUNT, PGHL_APNS_*). */
export function configuredProviders(env: NodeJS.ProcessEnv = process.env): PushProvider[] {
  const out: PushProvider[] = [];
  if (env.PGHL_FCM_SERVICE_ACCOUNT) out.push('fcm');
  if (env.PGHL_APNS_KEY && env.PGHL_APNS_KEY_ID && env.PGHL_APNS_TEAM_ID && env.PGHL_APNS_TOPIC) out.push('apns');
  return out;
}

/** FCM and APNs senders from the environment; a provider without keys answers with an error (never throws). */
export function transportFromEnv(env: NodeJS.ProcessEnv = process.env): NativeTransport {
  let fcm: ((t: string, m: NativeMessage) => Promise<SendResult>) | null | undefined;
  let apns: ((t: string, m: NativeMessage) => Promise<SendResult>) | null | undefined;
  const loadFcm = () => {
    if (fcm !== undefined) return fcm;
    try {
      const sa = JSON.parse(fileOrValue(env.PGHL_FCM_SERVICE_ACCOUNT) || 'null') as ServiceAccount | null;
      fcm = sa?.project_id && sa.client_email && sa.private_key ? fcmSender(sa) : null;
    } catch {
      fcm = null;
    }
    return fcm;
  };
  const loadApns = () => {
    if (apns !== undefined) return apns;
    const key = fileOrValue(env.PGHL_APNS_KEY);
    apns = key && env.PGHL_APNS_KEY_ID && env.PGHL_APNS_TEAM_ID && env.PGHL_APNS_TOPIC
      ? apnsSender({ key, keyId: env.PGHL_APNS_KEY_ID, teamId: env.PGHL_APNS_TEAM_ID, topic: env.PGHL_APNS_TOPIC, sandbox: env.PGHL_APNS_SANDBOX === '1' })
      : null;
    return apns;
  };
  return {
    async send(target, msg) {
      const fn = target.provider === 'fcm' ? loadFcm() : loadApns();
      if (!fn) return { ok: false, error: `${target.provider.toUpperCase()} ist nicht eingerichtet` };
      try {
        return await fn(target.token, msg);
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 200) };
      }
    },
  };
}
