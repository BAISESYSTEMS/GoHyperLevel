import { expect } from 'vitest';
import { startTestApp } from './helpers.js';
import { G_CLIENT, MS_CLIENT, createMailFake, type MailFake } from './mailbox-fakes.js';

export type T = Awaited<ReturnType<typeof startTestApp>>;

/** An app with the agency's Google and Microsoft apps set up and every external call going to the fake. */
export async function boot(overrides: Parameters<typeof startTestApp>[0] = {}) {
  const t = await startTestApp(overrides);
  const me = await t.setup();
  const fake = createMailFake();
  t.app.services.oauthFetch = fake.fetch;
  fake.ms.selfUrl = t.base;
  await t.api.put('/api/agency/oauth', { google: G_CLIENT, microsoft: MS_CLIENT });
  return { t, fake, me };
}

/** The whole connect dance: start → consent (fake) → callback. Returns the new mailbox id. */
export async function connect(t: T, fake: MailFake, body: Record<string, any>) {
  const start = await t.api.post('/api/mailboxes/connect', body);
  expect(start.status, JSON.stringify(start.data)).toBe(200);
  const f = fake.authorize(start.data.url);
  const back = await t.api.get(`/oauth/${body.provider}/callback?code=${f.code}&state=${encodeURIComponent(f.state)}`);
  const loc = back.headers.get('location') ?? '';
  const query = new URLSearchParams(loc.split('?')[1] ?? '');
  return { start, f, back, loc, query, id: query.get('mailbox') ?? '' };
}

/** The first import runs in the background after connecting: wait until it has finished. */
export async function settle(t: T, id: string) {
  for (let i = 0; i < 200; i++) {
    const row = t.app.db.get('SELECT last_sync_at, status FROM mailboxes WHERE id = ?', id);
    if (row?.last_sync_at && row.status !== 'importing' && row.status !== 'new') return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('first sync did not finish');
}

export const syncNow = (t: T, id: string, opts?: Record<string, unknown>) => t.app.services.mailbox.sync(id, opts);
export const box = (t: T, id: string) => t.app.services.mailbox.get(id);

export const daysAgo = (d: number) => new Date(Date.now() - d * 864e5).toISOString();

/** Rows of mailbox_messages for a mailbox, newest first, with JSON columns parsed. */
export function maps(t: T, id: string) {
  return t.app.db.all('SELECT * FROM mailbox_messages WHERE mailbox_id = ?', id).map((r: any) => ({ ...r, labels: JSON.parse(r.labels), attachments: JSON.parse(r.attachments), addrs: JSON.parse(r.addrs) }));
}

export const msgs = (t: T, where = '1=1', ...args: any[]) => t.app.db.all(`SELECT * FROM messages WHERE ${where} ORDER BY created_at`, ...args);

/** Logs in as another user and returns a call function with that session (and sub-account). */
export async function login(t: T, email: string, password: string, location?: string) {
  const r = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1' }, body: JSON.stringify({ email, password }) });
  expect(r.status).toBe(200);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(t.base + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie, ...(location ? { 'x-location-id': location } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data: data as any, headers: res.headers };
  };
  return { call, cookie, get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b ?? {}), patch: (p: string, b?: unknown) => call('PATCH', p, b ?? {}), put: (p: string, b?: unknown) => call('PUT', p, b ?? {}), del: (p: string) => call('DELETE', p) };
}

/** Calls with a bearer key (location key or agency key). */
export function withKey(t: T, key: string, location?: string) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(t.base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(location ? { 'x-location-id': location } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data: data as any };
  };
  return { call, get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b ?? {}) };
}
