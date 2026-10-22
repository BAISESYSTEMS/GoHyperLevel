import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { routeMail, sealSecret, openSecret, type ImapLike } from '../server/modules/mail-sync.js';

const raw = (h: Record<string, string>, body: string) => Buffer.from(Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + body);
const boxes: Record<string, { uid: number; source: Buffer; flags: Set<string> }[]> = {
  INBOX: [
    { uid: 10, flags: new Set(), source: raw({ From: 'Anna Partner <anna@sportbund.example>', To: 'inhaber@me.example', Subject: 'Re: Kooperation laufclub.example', 'Message-ID': '<m1@sportbund.example>', Date: 'Fri, 02 Oct 2026 10:00:00 +0000' }, 'Gern, lass uns telefonieren.') },
    { uid: 11, flags: new Set(['\\Seen']), source: raw({ From: 'news@shop.example', To: 'inhaber@me.example', Subject: 'Rabatt!', 'Message-ID': '<n1@shop>', Date: 'Fri, 02 Oct 2026 11:00:00 +0000' }, 'Newsletter') },
    { uid: 12, flags: new Set(), source: raw({ From: 'kunde@firma.de', To: 'inhaber@me.example', Subject: 'Frage zu hofladen', 'Message-ID': '<k1@firma>', Date: 'Fri, 02 Oct 2026 12:00:00 +0000' }, 'Wie inseriere ich?') },
  ],
  '[Gmail]/Gesendet': [{ uid: 5, flags: new Set(['\\Seen']), source: raw({ From: 'inhaber@me.example', To: 'Anna Partner <anna@sportbund.example>', Subject: 'Kooperation laufclub.example', 'Message-ID': '<s1@me>', Date: 'Thu, 01 Oct 2026 09:00:00 +0000' }, 'Hallo Anna …') }],
  '[Gmail]/Entwürfe': [{ uid: 3, flags: new Set(), source: raw({ From: 'inhaber@me.example', To: 'info@sportbund.example', Subject: 'Entwurf an Verband', 'Message-ID': '<d1@me>', Date: 'Fri, 02 Oct 2026 13:00:00 +0000' }, 'Noch nicht fertig') }],
};
let logins = 0;
const fake = (cfg: any): ImapLike => {
  let open = '';
  const c: any = {
    async connect() {
      if (cfg.auth.pass !== 'app-passwort') throw new Error('Invalid credentials');
      logins++;
    },
    async list() {
      return [{ path: 'INBOX' }, { path: '[Gmail]/Gesendet', specialUse: '\\Sent' }, { path: '[Gmail]/Entwürfe', specialUse: '\\Drafts' }];
    },
    async getMailboxLock(path: string) {
      open = path;
      const list = boxes[path];
      c.mailbox = { uidValidity: 7n, uidNext: (list.at(-1)?.uid ?? 0) + 1, exists: list.length };
      return { release() {} };
    },
    mailbox: false,
    async search() {
      return boxes[open].map((m) => m.uid);
    },
    async *fetch(range: any) {
      const list = boxes[open];
      const sel = Array.isArray(range) ? list.filter((m) => range.includes(m.uid)) : typeof range === 'string' && range !== '1:*' ? list.filter((m) => m.uid >= Number(range.split(':')[0]) || m === list.at(-1)) : list;
      for (const m of sel) yield m;
    },
    async logout() {},
  };
  return c;
};

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  process.env.PGHL_ALLOW_PRIVATE_FETCH = '1';
  t = await startTestApp();
  await t.setup();
  t.app.services.imapFactory = fake;
});
afterAll(async () => {
  delete process.env.PGHL_ALLOW_PRIVATE_FETCH;
  await t.close();
});

describe('mailbox sync', () => {
  it('routes by rules', () => {
    const rules = [
      { field: 'domain' as const, value: 'sportbund.example', location_id: 'A' },
      { field: 'any' as const, value: 'hofladen', location_id: 'B' },
    ];
    expect(routeMail(rules, null, { from: 'x@sub.sportbund.example', to: [], cc: [], subject: '', body: '', direction: 'in' })).toBe('A');
    expect(routeMail(rules, null, { from: 'a@b.de', to: [], cc: [], subject: 'Hallo', body: 'zu hofladen.de', direction: 'in' })).toBe('B');
    expect(routeMail(rules, null, { from: 'a@b.de', to: [], cc: [], subject: 'Hallo', body: '', direction: 'in' })).toBeNull();
    expect(routeMail(rules, 'D', { from: 'a@b.de', to: [], cc: [], subject: '', body: '', direction: 'in' })).toBe('D');
    expect(routeMail(rules, null, { from: 'inhaber@me.example', to: ['Anna <anna@sportbund.example>'], cc: [], subject: '', body: '', direction: 'out' })).toBe('A');
    expect(openSecret(t.app, sealSecret(t.app, 'geheim'))).toBe('geheim');
  });

  it('imports matching inbox, sent and draft mail into the right projects', async () => {
    const hoer = (await t.api.post('/api/locations', { name: 'laufclub.example' })).data.id;
    const da = (await t.api.post('/api/locations', { name: 'hofladen' })).data.id;
    const bad = await t.api.post('/api/agency/mail-accounts', { name: 'Gmail', username: 'inhaber@me.example', password: 'falsch', rules: [] });
    expect((await t.api.post(`/api/agency/mail-accounts/${bad.data.id}/sync`)).status).toBe(502);
    await t.api.del(`/api/agency/mail-accounts/${bad.data.id}`);
    const acc = (await t.api.post('/api/agency/mail-accounts', { name: 'Gmail', username: 'inhaber@me.example', password: 'app-passwort', rules: [{ field: 'domain', value: 'sportbund.example', location_id: hoer }, { field: 'any', value: 'hofladen', location_id: da }] })).data;
    expect(acc.password_set).toBe(true);
    expect(JSON.stringify(acc)).not.toContain('app-passwort');
    const r = (await t.api.post(`/api/agency/mail-accounts/${acc.id}/sync`)).data;
    expect(r).toMatchObject({ created: 4 });
    // laufclub.example: Anna (sent + reply) and the draft to info@sportbund.example
    const convs = (await t.api.get('/api/conversations', { 'x-location-id': hoer })).data;
    expect(convs).toHaveLength(2);
    const anna = convs.find((c: any) => c.email === 'anna@sportbund.example');
    expect(anna.unread).toBe(1);
    const thread = (await t.api.get(`/api/conversations/${anna.id}/messages`, { 'x-location-id': hoer })).data;
    expect(thread.messages.map((m: any) => [m.direction, m.status])).toEqual([['out', 'sent'], ['in', 'received']]);
    expect((await t.api.get('/api/conversations/drafts', { 'x-location-id': hoer })).data).toHaveLength(1);
    expect((await t.api.get('/api/conversations', { 'x-location-id': da })).data).toHaveLength(1);
    // The newsletter matched nothing and stayed out.
    expect((await t.api.get('/api/contacts?q=shop.example', { 'x-location-id': hoer })).data.total ?? 0).toBe(0);

    // Second run: nothing new; a sent draft disappears from the drafts folder → removed here too.
    boxes['[Gmail]/Entwürfe'] = [];
    const r2 = (await t.api.post(`/api/agency/mail-accounts/${acc.id}/sync`)).data;
    expect(r2).toMatchObject({ created: 0, removed: 1 });
    expect((await t.api.get('/api/conversations/drafts', { 'x-location-id': hoer })).data).toHaveLength(0);
    const list = (await t.api.get('/api/agency/mail-accounts')).data[0];
    expect(list.last_result).toMatchObject({ removed: 1 });
    expect(list.last_error).toBeNull();
  });
});
