import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requiredPermission } from '../server/core/permissions.js';
import { sha256 } from '../server/core/util.js';
import { PRESENCE_POSTS_PER_MINUTE, PresenceHub } from '../server/services/presence-hub.js';
import { PRESENCE_ROUTES, cleanCursor, cleanPage, cleanPresencePrefs, cursorKind, cursorsOn, maySeePage, presencePrefsOf } from '../server/services/presence-model.js';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';

/**
 * Live-Zusammenarbeit überall (modules/presence.ts, docs/collaboration.md): isolation between sub-accounts, personal
 * logins only, hidden and invisible people, area rights per receiver, page validation, expiry, the sub-account switch and
 * cursors only between two people on the same page who both switched them on.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let other = '';
let admin: Call;
let adminOther: Call;
let chefName = '';
let anna: Call & { cookie: () => string }; // contacts + dashboard
let ben: Call & { cookie: () => string }; // dashboard only
let carl: Call & { cookie: () => string }; // the other sub-account
let hilde: Call & { cookie: () => string }; // hidden (cloud operator)
let nina: Call & { cookie: () => string }; // settings area, but turned invisible
const ids: Record<string, string> = {};
let key = '';
let hub: PresenceHub;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;

/** An open SSE stream with a tiny reader. */
async function openStream(c: { cookie: () => string } | 'chef', clientId: string, location = loc) {
  const cookie = c === 'chef' ? t.api.cookie : c.cookie();
  const ctrl = new AbortController();
  const res = await realFetch(`${t.base}/api/presence/stream?clientId=${clientId}&locationId=${location}`, { headers: { cookie }, signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let pending: Promise<void> | undefined;
  const pump = () => {
    pending ??= reader.read().then(({ value, done }) => {
      pending = undefined;
      if (!done) buf += dec.decode(value);
    });
    return pending;
  };
  return {
    text: () => buf,
    /** Data of every event of a kind so far. */
    events: (kind: string) => [...buf.matchAll(new RegExp(`event: ${kind}\\ndata: (.*)\\n`, 'g'))].map((m) => JSON.parse(m[1])),
    async until(re: RegExp, ms = 3000) {
      const end = Date.now() + ms;
      while (!re.test(buf) && Date.now() < end) await Promise.race([pump(), sleep(50)]);
      return re.test(buf);
    },
    async settle(ms = 250) {
      const end = Date.now() + ms;
      while (Date.now() < end) await Promise.race([pump(), sleep(30)]);
    },
    clear: () => (buf = ''),
    close: async () => {
      ctrl.abort();
      await reader.cancel().catch(() => {});
    },
  };
}

const beat = (c: Call, clientId: string, page: string, extra: Record<string, unknown> = {}) => c('POST', '/api/presence', { clientId, page, ...extra });
const team = async (c: Call) => (await c('GET', '/api/presence/team')).data;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  hub = t.app.services.presenceHub;
  loc = t.api.location;
  other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
  admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': loc });
  adminOther = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': other });
  const mkUser = async (email: string, name: string, permissions: string[] | null, locations = [loc]) => {
    const u = await t.api.post('/api/users', { email, name, password: 'geheim-12345', role: 'member', locations, permissions });
    expect(u.status, JSON.stringify(u.data)).toBe(200);
    const c = client(t.base, { 'x-pghl': '1', 'x-location-id': locations[0] });
    expect((await c('POST', '/api/auth/login', { email, password: 'geheim-12345' })).status).toBe(200);
    ids[name] = u.data.id;
    return c;
  };
  anna = await mkUser('anna@example.com', 'Anna Arndt', ['contacts', 'dashboard']);
  ben = await mkUser('ben@example.com', 'Ben Berg', ['dashboard']);
  carl = await mkUser('carl@example.com', 'Carl Cramer', ['contacts', 'dashboard'], [other]);
  hilde = await mkUser('hilde@example.com', 'Hilde Hidden', null);
  nina = await mkUser('nina@example.com', 'Nina Nebel', ['settings', 'contacts', 'dashboard']);
  const me = (await t.api.get('/api/me')).data.user;
  ids.Chef = me.id;
  chefName = me.name;
  key = (await t.api.post('/api/api-keys', { name: 'Bot' })).data.key;
  // cloud mode hides the operator's logins from customers' sub-accounts (modules/cloud.ts sets this hook)
  t.app.services.hideUser = (u: { id?: string }) => u.id === ids['Hilde Hidden'];
}, 60_000);

afterAll(async () => {
  hub?.closeAll();
  await t?.close();
});

describe('presence model (shared with the browser)', () => {
  it('checks page addresses strictly and cuts off the query', () => {
    expect(cleanPage('/contacts/abc-123?tab=notes#x')).toBe('/contacts/abc-123');
    expect(cleanPage('/settings/team')).toBe('/settings/team');
    expect(cleanPage('/')).toBe('/');
    for (const bad of ['contacts', '', '/a b', '/x<script>', '/../etc', '/a/./b', '//evil.example', `/${'a'.repeat(200)}`, 42, null, '/kontakt/ä'])
      expect(cleanPage(bad), String(bad)).toBeNull();
  });

  it('knows cursors per page kind and preference', () => {
    expect(cursorKind('/boards/b1')).toBe('board');
    expect(cursorKind('/canvas/c1')).toBe('none');
    expect(cursorKind('/contacts')).toBe('page');
    expect(cursorsOn('boards', '/boards/b1')).toBe(true);
    expect(cursorsOn('boards', '/contacts')).toBe(false);
    expect(cursorsOn('all', '/contacts')).toBe(true);
    expect(cursorsOn('off', '/boards/b1')).toBe(false);
    expect(cursorsOn('all', '/canvas/c1')).toBe(false);
    expect(cleanCursor({ pts: [[2, -5], [0.5, 120.4], ['x', 1], [0.1]] })).toEqual([[1, 0], [0.5, 120]]);
    expect(cleanCursor({ x: 0.25, y: 10 })).toEqual([[0.25, 10]]);
    expect(cleanCursor({ pts: Array.from({ length: 50 }, () => [0.1, 1]) })).toHaveLength(10);
  });

  it('validates preferences and falls back to the defaults', () => {
    expect(cleanPresencePrefs({ invisible: true, cursors: 'all', junk: 1 })).toEqual({ invisible: true, cursors: 'all' });
    expect(() => cleanPresencePrefs({ cursors: 'sometimes' })).toThrow();
    expect(() => cleanPresencePrefs({ menu: 'yes' })).toThrow();
    expect(presencePrefsOf({ cursors: 'nope' })).toEqual({ invisible: false, menu: true, cursors: 'boards' });
  });

  it('shows a page only to people who may open its area', () => {
    const member = (permissions: string[] | null) => ({ role: 'member', permissions });
    expect(maySeePage(member(['contacts']), '/contacts/1')).toBe(true);
    expect(maySeePage(member(['dashboard']), '/contacts/1')).toBe(false);
    expect(maySeePage(member(null), '/accounting')).toBe(true);
    expect(maySeePage(member(null), '/agency')).toBe(false);
    expect(maySeePage({ role: 'admin', permissions: null }, '/agency')).toBe(true);
    expect(maySeePage(member([]), '/academy')).toBe(true);
    expect(maySeePage({ role: 'admin', permissions: null }, '/no-such-page')).toBe(false);
  });

  it('has an area for every menu entry, the same as the menu (web/src/main.tsx)', () => {
    const main = readFileSync('web/src/main.tsx', 'utf8');
    const nav = [...main.matchAll(/\[\s*'([\w-]+)',\s*'[\w]+',\s*'[^']+',\s*'([^']*)'\s*\]/g)].map((m) => ({ route: m[1], perm: m[2] }));
    expect(nav.length).toBeGreaterThan(30);
    // "Personal" is in everybody's menu for their own record (perm 'hr'); a colleague's whereabouts there only for HR staff
    for (const { route, perm } of nav) expect(PRESENCE_ROUTES[route]?.area, route).toBe(perm === 'hr' ? 'personal' : perm);
  });

  it('maps only the switch to an area', () => {
    expect(requiredPermission('PUT', '/api/presence/settings')).toBe('settings');
    expect(requiredPermission('POST', '/api/presence')).toBeUndefined();
    expect(requiredPermission('GET', '/api/presence/team')).toBeUndefined();
    expect(requiredPermission('GET', '/api/presence/stream')).toBeUndefined();
  });
});

describe('presence: who may take part', () => {
  it('refuses API keys (stream, heartbeat, team) like the inbox stream', async () => {
    const h = { authorization: `Bearer ${key}`, 'x-location-id': loc, 'content-type': 'application/json' };
    expect((await realFetch(`${t.base}/api/presence/stream?clientId=bot-tab-1&locationId=${loc}`, { headers: h })).status).toBe(403);
    expect((await realFetch(`${t.base}/api/presence`, { method: 'POST', headers: h, body: JSON.stringify({ clientId: 'bot-tab-1', page: '/contacts' }) })).status).toBe(403);
    expect((await realFetch(`${t.base}/api/presence/team`, { headers: h })).status).toBe(403);
    expect((await realFetch(`${t.base}/api/presence/prefs`, { headers: h })).status).toBe(403);
    expect(hub.size()).toBe(0);
  });

  it('validates clientId and page', async () => {
    expect((await beat(anna, 'x', '/contacts')).status).toBe(400);
    expect((await beat(anna, 'anna-tab-0', 'contacts')).status).toBe(400);
    expect((await beat(anna, 'anna-tab-0', '/a"b')).status).toBe(400);
    expect((await beat(anna, 'anna-tab-0', `/${'x'.repeat(250)}`)).status).toBe(400);
    const r = await beat(anna, 'anna-tab-0', '/contacts?secret=1');
    expect(r.status).toBe(200);
    expect(hub.client('anna-tab-0')?.page).toBe('/contacts');
    expect((await anna('POST', '/api/presence', { clientId: 'anna-tab-0', leaving: true })).status).toBe(200);
    expect(hub.client('anna-tab-0')).toBeUndefined();
  });

  it('never lets one person speak for another tab', async () => {
    expect((await beat(anna, 'anna-tab-1', '/dashboard')).status).toBe(200);
    expect((await beat(ben, 'anna-tab-1', '/dashboard')).status).toBe(409);
    expect((await ben('POST', '/api/presence', { clientId: 'anna-tab-1', leaving: true })).status).toBe(409);
    expect((await realFetch(`${t.base}/api/presence/stream?clientId=anna-tab-1&locationId=${loc}`, { headers: { cookie: ben.cookie() } })).status).toBe(409);
    expect(hub.client('anna-tab-1')?.userId).toBe(ids['Anna Arndt']);
    await anna('POST', '/api/presence', { clientId: 'anna-tab-1', leaving: true });
  });

  it('is not written anywhere: no audit line, no journal', async () => {
    await beat(anna, 'anna-tab-2', '/contacts/abc', { editing: true, saved: true });
    const rows = t.app.db.all("SELECT * FROM audit_log WHERE route LIKE '%presence%' OR summary LIKE '%/contacts/abc%'");
    expect(rows).toEqual([]);
    await anna('POST', '/api/presence', { clientId: 'anna-tab-2', leaving: true });
  });
});

describe('presence: what the others see', () => {
  it('keeps sub-accounts apart: a person of another sub-account is never seen, not even by an admin looking at this one', async () => {
    const watch = await openStream('chef', 'chef-tab-1');
    const watchOther = await openStream(carl, 'carl-tab-0', other);
    await watch.settle();
    await beat(carl, 'carl-tab-1', '/contacts/c1');
    await beat(anna, 'anna-tab-3', '/contacts/a1');
    expect(await watch.until(/Anna Arndt/)).toBe(true);
    await watch.settle();
    expect(watch.text()).not.toContain('Carl Cramer');
    expect(watchOther.text()).not.toContain('Anna Arndt');
    expect((await team(admin)).people.map((p: any) => p.name)).toEqual(['Anna Arndt']);
    expect((await team(anna)).people.map((p: any) => p.name)).toEqual([]);
    // the admin in the other sub-account sees Carl there – and only there
    expect((await team(adminOther)).people.map((p: any) => p.name)).toEqual(['Carl Cramer']);
    // Carl may not use this sub-account at all
    expect((await carl('GET', '/api/presence/team', undefined, { 'x-location-id': loc })).status).toBe(403);
    await watch.close();
    await watchOther.close();
  });

  it('shows the page only to people who may open its area – the others see "online"', async () => {
    const forBen = (await team(ben)).people.find((p: any) => p.name === 'Anna Arndt');
    expect(forBen).toEqual({ user_id: ids['Anna Arndt'], name: 'Anna Arndt', color: expect.stringMatching(/^#/), page: null, title: null, editing: false, online: true });
    const forChef = (await team(admin)).people.find((p: any) => p.name === 'Anna Arndt');
    expect(forChef.page).toBe('/contacts/a1');
    // a stream sees the same (the clientId itself never leaves the server)
    const s = await openStream(ben, 'ben-tab-1');
    expect(await s.until(/event: hello/)).toBe(true);
    const peers = s.events('hello')[0].peers;
    expect(peers.find((p: any) => p.name === 'Anna Arndt')).toMatchObject({ page: null, title: null });
    expect(s.text()).not.toContain('anna-tab-3');
    await s.close();
  });

  it('leaves hidden people (cloud operator) out everywhere', async () => {
    const watch = await openStream('chef', 'chef-tab-2');
    await watch.settle();
    expect((await beat(hilde, 'hilde-tab-1', '/contacts', { editing: true })).status).toBe(200);
    await watch.settle(300);
    expect(watch.text()).not.toContain('Hilde');
    expect((await team(anna)).people.map((p: any) => p.name)).not.toContain('Hilde Hidden');
    expect((await team(admin)).people.map((p: any) => p.name)).not.toContain('Hilde Hidden');
    await watch.close();
  });

  it('an invisible person is not announced, sends no cursor and no "saved" – and still sees the others', async () => {
    expect((await nina('PUT', '/api/presence/prefs', { invisible: true })).data).toMatchObject({ invisible: true });
    expect((await nina('PUT', '/api/presence/prefs', { cursors: 'sometimes' })).status).toBe(400);
    const watch = await openStream('chef', 'chef-tab-3');
    await beat(admin, 'chef-tab-3', '/boards/b9');
    await watch.settle();
    await beat(nina, 'nina-tab-1', '/boards/b9', { editing: true, saved: true, x: 0.5, y: 100 });
    await watch.settle(300);
    expect(watch.text()).not.toContain('Nina');
    expect((await team(admin)).people.map((p: any) => p.name)).not.toContain('Nina Nebel');
    // she sees who is there
    expect((await team(nina)).people.map((p: any) => p.name)).toContain(chefName);
    // visible again: her next heartbeat announces her
    await nina('PUT', '/api/presence/prefs', { invisible: false });
    await beat(nina, 'nina-tab-1', '/boards/b9');
    expect(await watch.until(/Nina Nebel/)).toBe(true);
    await nina('POST', '/api/presence', { clientId: 'nina-tab-1', leaving: true });
    expect(await watch.until(/event: gone/)).toBe(true);
    await watch.close();
  });

  it('forgets a tab that stops reporting (TTL) and one whose stream closes', async () => {
    const watch = await openStream('chef', 'chef-tab-4');
    await beat(ben, 'ben-tab-2', '/dashboard');
    expect(await watch.until(/Ben Berg/)).toBe(true);
    const realNow = hub.now;
    hub.now = () => Date.now() + 60_000;
    try {
      expect((await team(admin)).people.map((p: any) => p.name)).not.toContain('Ben Berg');
      watch.clear();
      hub.sweep();
      expect(await watch.until(/event: gone/)).toBe(true);
    } finally {
      hub.now = realNow;
    }
    expect(hub.client('ben-tab-2')).toBeUndefined();
    // a closed tab is gone at once
    const tab = await openStream(ben, 'ben-tab-3');
    await beat(ben, 'ben-tab-3', '/dashboard');
    expect(await watch.until(/Ben Berg/)).toBe(true);
    watch.clear();
    await tab.close();
    expect(await watch.until(/event: gone/)).toBe(true);
    await sleep(50);
    expect(hub.client('ben-tab-3')).toBeUndefined();
    await watch.close();
  });

  it('closes the stream of somebody who was removed from the sub-account – at once, and for good', async () => {
    const s = await openStream(ben, 'ben-tab-4');
    await beat(ben, 'ben-tab-4', '/dashboard');
    expect(hub.sub('ben-tab-4')).toBeTruthy();
    expect((await t.api.patch(`/api/users/${ids['Ben Berg']}`, { locations: [other] })).status).toBe(200);
    // no waiting for the next round: the change of the person closes it, and `bye` stops the browser's reconnects
    expect(hub.sub('ben-tab-4')).toBeUndefined();
    expect(hub.client('ben-tab-4')).toBeUndefined();
    expect(await s.until(/event: bye\ndata: \{"reason":"signed_out"\}/)).toBe(true);
    await t.api.patch(`/api/users/${ids['Ben Berg']}`, { locations: [loc] });
    await s.close();
  });

  it('ends the stream when its login is signed out or revoked (the stream must not outlive the session)', async () => {
    const login = async () => {
      const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
      expect((await c('POST', '/api/auth/login', { email: 'anna@example.com', password: 'geheim-12345' })).status).toBe(200);
      return c;
    };
    // signed out in another tab of the same browser
    const second = await login();
    const s1 = await openStream(second, 'anna-tab-s1');
    expect(await s1.until(/event: hello/)).toBe(true);
    expect((await second('POST', '/api/auth/logout')).status).toBe(200);
    expect(await s1.until(/event: bye/)).toBe(true);
    expect(hub.sub('anna-tab-s1')).toBeUndefined();
    // "sign out the other devices" (a lost laptop): its open stream ends too, the own one stays
    const third = await login();
    const s2 = await openStream(third, 'anna-tab-s2');
    const own = await openStream(anna, 'anna-tab-s3');
    expect(await s2.until(/event: hello/)).toBe(true);
    expect((await anna('POST', '/api/me/sessions/revoke-others')).status).toBe(200);
    expect(await s2.until(/event: bye/)).toBe(true);
    expect(hub.sub('anna-tab-s2')).toBeUndefined();
    expect(hub.sub('anna-tab-s3')).toBeTruthy();
    // a session that just ran out is caught by the next round
    const fourth = await login();
    const s3 = await openStream(fourth, 'anna-tab-s4');
    t.app.db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', new Date(Date.now() - 1000).toISOString(), sha256(decodeURIComponent(fourth.cookie().split('=')[1])));
    hub.sweep();
    expect(hub.sub('anna-tab-s4')).toBeUndefined();
    expect(hub.sub('anna-tab-s3')).toBeTruthy();
    for (const s of [s1, s2, s3, own]) await s.close();
  });

  it('never relays a free-text title from a browser (it could carry a record name)', async () => {
    const watch = await openStream('chef', 'chef-tab-t1');
    await watch.settle();
    await beat(anna, 'anna-tab-t1', '/contacts/k7', { title: 'Max Mustermann – Kündigung' });
    expect(await watch.until(/Anna Arndt/)).toBe(true);
    await watch.settle();
    expect(watch.text()).not.toContain('Mustermann');
    expect(watch.events('presence').every((p: any) => p.title === null)).toBe(true);
    const row = (await team(admin)).people.find((p: any) => p.name === 'Anna Arndt');
    expect(row).toMatchObject({ page: '/contacts/k7', title: null });
    await watch.close();
    await anna('POST', '/api/presence', { clientId: 'anna-tab-t1', leaving: true });
  });

  it("a person's 11th tab replaces the oldest one, which is told not to reconnect", async () => {
    const tabs = [];
    for (let i = 0; i < 11; i++) {
      tabs.push(await openStream(ben, `ben-cap-${i}`));
      expect(await tabs[i].until(/event: hello/)).toBe(true);
    }
    expect(await tabs[0].until(/event: bye\ndata: \{"reason":"tabs"\}/)).toBe(true);
    expect(hub.sub('ben-cap-0')).toBeUndefined();
    expect(hub.sub('ben-cap-10')).toBeTruthy();
    expect(tabs.slice(1).every((s) => !s.text().includes('event: bye'))).toBe(true);
    for (const s of tabs) await s.close();
  });
});

describe('presence: limits of the hub', () => {
  const viewer = { id: 'v', role: 'member', permissions: null };
  const prefs = { invisible: false, menu: true, cursors: 'boards' as const };
  const sub = (h: PresenceHub, userId: string, clientId: string) => h.subscribe({ clientId, userId, locationId: 'L', viewer, prefs }, () => ({}));

  it('refuses a new stream when the server is full (503 instead of a 200 that ends at once and makes the browser retry)', () => {
    const h = new PresenceHub();
    try {
      for (let u = 0; u < 100; u++) for (let i = 0; i < 10; i++) expect(sub(h, `u${u}`, `c-${u}-${i}`)).not.toBeNull();
      expect(h.streams()).toBe(1000);
      expect(sub(h, 'newcomer', 'c-new-0')).toBeNull();
      // somebody at their own limit replaces their oldest tab; a reconnect of the same tab always gets in
      expect(sub(h, 'u0', 'c-0-10')).not.toBeNull();
      expect(h.sub('c-0-0')).toBeUndefined();
      expect(sub(h, 'u1', 'c-1-3')).not.toBeNull();
      expect(h.streams()).toBe(1000);
    } finally {
      h.closeAll();
    }
  });

  it('counts the heartbeats of a person per minute', () => {
    const h = new PresenceHub();
    let at = 1_000_000;
    h.now = () => at;
    for (let i = 0; i < PRESENCE_POSTS_PER_MINUTE; i++) expect(h.allow('u1')).toBe(true);
    expect(h.allow('u1')).toBe(false);
    expect(h.allow('u2')).toBe(true);
    at += 60_000;
    expect(h.allow('u1')).toBe(true);
    h.closeAll();
  });
});

describe('presence: saved, editing and cursors', () => {
  it('"saved here" and "editing" reach the people on the same page only', async () => {
    const chef = await openStream('chef', 'chef-tab-5');
    const benS = await openStream(ben, 'ben-tab-5');
    await beat(admin, 'chef-tab-5', '/contacts/k1');
    await beat(ben, 'ben-tab-5', '/dashboard');
    await chef.settle();
    chef.clear();
    benS.clear();
    await beat(anna, 'anna-tab-5', '/contacts/k1', { editing: true });
    expect(await chef.until(/"editing":true/)).toBe(true);
    await beat(anna, 'anna-tab-5', '/contacts/k1', { saved: true });
    expect(await chef.until(/event: saved/)).toBe(true);
    expect(chef.events('saved')[0]).toMatchObject({ name: 'Anna Arndt', page: '/contacts/k1' });
    await benS.settle(300);
    expect(benS.text()).not.toContain('event: saved');
    // Ben (no contacts right) learns that Anna is online, not where or that she types
    expect(benS.events('presence').every((p: any) => p.page === null && p.editing === false)).toBe(true);
    // throttled: a second "saved" right away is not relayed
    chef.clear();
    await beat(anna, 'anna-tab-5', '/contacts/k1', { saved: true });
    await chef.settle(300);
    expect(chef.text()).not.toContain('event: saved');
    await chef.close();
    await benS.close();
    await anna('POST', '/api/presence', { clientId: 'anna-tab-5', leaving: true });
  });

  it('relays cursors only between two people on the same page who both have them on', async () => {
    const chef = await openStream('chef', 'chef-tab-6');
    const benS = await openStream(ben, 'ben-tab-6');
    await beat(admin, 'chef-tab-6', '/boards/b1');
    await beat(ben, 'ben-tab-6', '/boards/b2');
    await beat(anna, 'anna-tab-6', '/boards/b1');
    await chef.settle();
    chef.clear();
    // Living Boards: on by default
    await beat(anna, 'anna-tab-6', '/boards/b1', { pts: [[0.25, 40], [0.3, 42]] });
    expect(await chef.until(/event: cursor/)).toBe(true);
    expect(chef.events('cursor')[0]).toMatchObject({ name: 'Anna Arndt', pts: [[0.25, 40], [0.3, 42]] });
    await benS.settle(200);
    expect(benS.text()).not.toContain('event: cursor');
    // ordinary pages: off by default for both
    await beat(admin, 'chef-tab-6', '/dashboard');
    await beat(anna, 'anna-tab-6', '/dashboard');
    chef.clear();
    await sleep(60);
    await beat(anna, 'anna-tab-6', '/dashboard', { x: 0.5, y: 10 });
    await chef.settle(250);
    expect(chef.text()).not.toContain('event: cursor');
    // Anna switches them on for every page – still nothing until the receiver does too
    await anna('PUT', '/api/presence/prefs', { cursors: 'all' });
    await beat(anna, 'anna-tab-6', '/dashboard');
    await sleep(60);
    await beat(anna, 'anna-tab-6', '/dashboard', { x: 0.5, y: 10 });
    await chef.settle(250);
    expect(chef.text()).not.toContain('event: cursor');
    await admin('PUT', '/api/presence/prefs', { cursors: 'all' });
    await beat(admin, 'chef-tab-6', '/dashboard');
    await sleep(60);
    await beat(anna, 'anna-tab-6', '/dashboard', { x: 0.5, y: 10 });
    expect(await chef.until(/event: cursor/)).toBe(true);
    // the receiver turns them off: nothing more
    await admin('PUT', '/api/presence/prefs', { cursors: 'off' });
    await beat(admin, 'chef-tab-6', '/dashboard');
    chef.clear();
    await sleep(60);
    await beat(anna, 'anna-tab-6', '/dashboard', { x: 0.6, y: 12 });
    await chef.settle(250);
    expect(chef.text()).not.toContain('event: cursor');
    // the server throttles a tab that sends faster than every 50 ms
    const c = hub.client('anna-tab-6')!;
    c.cursorAt = 0;
    expect(hub.cursor(c, [[0.1, 1]])).toBe(true);
    expect(hub.cursor(c, [[0.2, 1]])).toBe(false);
    await admin('PUT', '/api/presence/prefs', { cursors: 'boards' });
    await anna('PUT', '/api/presence/prefs', { cursors: 'boards' });
    await chef.close();
    await benS.close();
  });

  it('sends no cursor to somebody invisible or hidden (they send none, so nobody watches unseen)', async () => {
    await nina('PUT', '/api/presence/prefs', { invisible: true });
    const chef = await openStream('chef', 'chef-tab-c2');
    const ninaS = await openStream(nina, 'nina-tab-c2');
    const hildeS = await openStream(hilde, 'hilde-tab-c2');
    await beat(admin, 'chef-tab-c2', '/boards/b7');
    await beat(nina, 'nina-tab-c2', '/boards/b7');
    await beat(hilde, 'hilde-tab-c2', '/boards/b7');
    await beat(anna, 'anna-tab-c2', '/boards/b7');
    await chef.settle();
    await beat(anna, 'anna-tab-c2', '/boards/b7', { pts: [[0.4, 30]] });
    expect(await chef.until(/event: cursor/)).toBe(true);
    await ninaS.settle(200);
    await hildeS.settle(50);
    expect(ninaS.text()).not.toContain('event: cursor');
    expect(hildeS.text()).not.toContain('event: cursor');
    // they still see who is there
    expect(ninaS.events('hello')[0].peers.length + ninaS.events('presence').length).toBeGreaterThan(0);
    await nina('PUT', '/api/presence/prefs', { invisible: false });
    for (const s of [chef, ninaS, hildeS]) await s.close();
    await anna('POST', '/api/presence', { clientId: 'anna-tab-c2', leaving: true });
  });

  it('counts only the tab in the stream\'s own sub-account as "on this page"', async () => {
    const chef = await openStream('chef', 'chef-tab-l1');
    await chef.settle();
    // the same tab id reports from the other sub-account, on a page of the same name
    await beat(adminOther, 'chef-tab-l1', '/contacts/k9');
    await beat(anna, 'anna-tab-l1', '/contacts/k9');
    chef.clear();
    await beat(anna, 'anna-tab-l1', '/contacts/k9', { saved: true });
    await chef.settle(250);
    expect(chef.text()).not.toContain('event: saved');
    await chef.close();
    await anna('POST', '/api/presence', { clientId: 'anna-tab-l1', leaving: true });
  });

  it('a choice that concerns nobody else does not make the person flicker away for the others', async () => {
    const chef = await openStream('chef', 'chef-tab-p1');
    await beat(anna, 'anna-tab-p1', '/dashboard');
    expect(await chef.until(/Anna Arndt/)).toBe(true);
    chef.clear();
    await anna('PUT', '/api/presence/prefs', { menu: false });
    await chef.settle(200);
    expect(chef.text()).not.toContain('event: gone');
    // a new cursor choice is told at once (the others' tabs decide by it whether to send their own)
    await anna('PUT', '/api/presence/prefs', { cursors: 'all' });
    expect(await chef.until(/"cursors":true/)).toBe(true);
    expect(chef.text()).not.toContain('event: gone');
    await anna('PUT', '/api/presence/prefs', { menu: true, cursors: 'boards' });
    await chef.close();
    await anna('POST', '/api/presence', { clientId: 'anna-tab-p1', leaving: true });
  });
});

describe('presence: the sub-account switch', () => {
  it('only people with the settings area may switch it', async () => {
    expect((await anna('PUT', '/api/presence/settings', { enabled: false })).status).toBe(403);
    expect((await nina('GET', '/api/presence/settings')).data).toEqual({ enabled: true });
    expect((await nina('PUT', '/api/presence/settings', { enabled: 'nein' })).status).toBe(400);
  });

  it('switched off: nothing is kept or sent, the team list is empty, open tabs are told', async () => {
    const watch = await openStream(anna, 'anna-tab-7');
    await beat(admin, 'chef-tab-7', '/dashboard');
    expect((await team(anna)).people.length).toBeGreaterThan(0);
    expect((await nina('PUT', '/api/presence/settings', { enabled: false })).data).toEqual({ enabled: false });
    expect(await watch.until(/event: settings\ndata: \{"enabled":false\}/)).toBe(true);
    expect(await team(anna)).toMatchObject({ enabled: false, people: [] });
    expect((await beat(admin, 'chef-tab-7', '/dashboard')).data).toEqual({ ok: true, enabled: false });
    expect(hub.clientsIn(loc)).toEqual([]);
    // the other sub-account is untouched
    expect((await team(adminOther)).enabled).toBe(true);
    const late = await openStream(ben, 'ben-tab-7');
    expect(await late.until(/event: hello/)).toBe(true);
    expect(late.events('hello')[0]).toMatchObject({ enabled: false, peers: [] });
    await late.close();
    // and back on
    expect((await nina('PUT', '/api/presence/settings', { enabled: true })).data).toEqual({ enabled: true });
    expect(await watch.until(/"enabled":true/)).toBe(true);
    await watch.close();
  });

  it('the switch is audit-logged like every sub-account setting (one readable line) – the own choices are not', async () => {
    const lines = () => t.app.db.all<any>("SELECT * FROM audit_log WHERE action LIKE 'presence%' ORDER BY at, rowid");
    const before = lines().length;
    expect((await nina('PUT', '/api/presence/settings', { enabled: false })).status).toBe(200);
    expect((await nina('PUT', '/api/presence/settings', { enabled: true })).status).toBe(200);
    expect((await nina('PUT', '/api/presence/prefs', { invisible: true })).status).toBe(200);
    expect((await nina('PUT', '/api/presence/prefs', { invisible: false })).status).toBe(200);
    const added = lines().slice(before);
    expect(added.map((r) => [r.action, r.summary, r.location_id, r.user_id, r.via])).toEqual([
      ['presence.settings.update', 'Live-Zusammenarbeit ausgeschaltet', loc, ids['Nina Nebel'], 'session'],
      ['presence.settings.update', 'Live-Zusammenarbeit eingeschaltet', loc, ids['Nina Nebel'], 'session'],
    ]);
    expect(t.app.db.all("SELECT * FROM audit_log WHERE route LIKE '%/api/presence/prefs%' OR route = 'POST /api/presence'")).toEqual([]);
  });

  it('one person cannot flood the sub-account with heartbeats', async () => {
    let at = Date.now();
    const realNow = hub.now;
    hub.now = () => at;
    try {
      for (let i = 0; i < PRESENCE_POSTS_PER_MINUTE; i++) hub.allow(ids['Carl Cramer']);
      const carlOther = (path: string, body: unknown) => carl('POST', path, body, { 'x-location-id': other });
      expect((await carlOther('/api/presence', { clientId: 'carl-tab-9', page: '/contacts' })).status).toBe(429);
      expect(hub.client('carl-tab-9')).toBeUndefined();
      at += 60_000;
      expect((await carlOther('/api/presence', { clientId: 'carl-tab-9', page: '/contacts' })).status).toBe(200);
      await carlOther('/api/presence', { clientId: 'carl-tab-9', leaving: true });
    } finally {
      hub.now = realNow;
    }
  });
});
