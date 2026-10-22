import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MARK, OWN, rig, setAccess, type Rig } from './record-access-fixtures.js';
import { id as newId, now } from '../server/core/util.js';
import { client } from './security-fixtures.js';
import { pinClock, unpinClock } from './helpers.js';
import { cogneeApp } from './cognee-helpers.js';
import { startVideoUpload } from '../server/services/community-posts-ext.js';

/**
 * Security review 0.0.37–0.0.40, record access: the places where a person who sees only their own records could still read – or
 * change – what belongs to somebody else's contact: call log, call intelligence, power dialer, AI phone sessions, drafts, media files,
 * bulk changes in the inbox, segment and campaign lists, and the Cognee memory. Bob's records carry MARK; Alice (own only) must never
 * get it back, and her own records must still work.
 */

let r: Rig;
let callId = '';
let sid = '';
let intelId = '';
let listId = '';
let itemId = '';
let aliceCall = '';
let draftId = '';
let mediaId = '';
const realFetch = globalThis.fetch;

beforeAll(async () => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`offline in tests: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  r = await rig();
  const { db } = r.t.app;
  const t = now();
  callId = newId();
  sid = `CA${'c'.repeat(32)}`;
  db.insert('calls', { id: callId, location_id: r.loc, contact_id: r.rec.contact_b, direction: 'in', from_number: '+4915100000001', to_number: '+4930123456', status: 'voicemail', answered: 0, duration: 42, transcription: `${MARK} Rückruf wegen Vertrag`, sid, started_at: t, updated_at: t });
  aliceCall = newId();
  db.insert('calls', { id: aliceCall, location_id: r.loc, contact_id: r.rec.contact_a, direction: 'in', from_number: '+4915100000002', to_number: '+4930123456', status: 'missed', started_at: t, updated_at: t });
  intelId = newId();
  db.insert('call_intel', { id: intelId, location_id: r.loc, source: 'call', call_id: callId, contact_id: r.rec.contact_b, title: `${MARK} Gespräch`, status: 'done', transcript: `${MARK} Wir kündigen`, summary: `${MARK} Kündigung`, created_at: t });
  // an uploaded meeting recording that belongs to nobody stays open to everybody
  db.insert('call_intel', { id: newId(), location_id: r.loc, source: 'upload', title: 'Teammeeting', status: 'done', transcript: 'Wochenplanung', summary: 'Plan', created_at: t });
  listId = newId();
  db.insert('dialer_lists', { id: listId, location_id: r.loc, name: 'Liste', source: 'tags', tags: JSON.stringify(['vertrieb']), created_at: t, updated_at: t });
  itemId = newId();
  db.insert('dialer_items', { id: itemId, location_id: r.loc, list_id: listId, contact_id: r.rec.contact_b, status: 'pending', position: 1, created_at: t, updated_at: t });
  db.insert('dialer_items', { id: newId(), location_id: r.loc, list_id: listId, contact_id: r.rec.contact_a, status: 'pending', position: 2, created_at: t, updated_at: t });
  draftId = newId();
  db.run(`INSERT INTO messages (id, location_id, contact_id, conversation_id, channel, direction, subject, body, status, created_at) SELECT ?, location_id, contact_id, conversation_id, channel, direction, ?, ?, 'draft', ? FROM messages WHERE id = ?`, draftId, `${MARK} Entwurf`, `${MARK} Entwurfstext`, t, r.rec.message_b);
  mediaId = newId();
  db.run(`INSERT INTO messages (id, location_id, contact_id, conversation_id, channel, direction, subject, body, status, created_at, channel_media) SELECT ?, location_id, contact_id, conversation_id, 'telegram', 'in', '', 'Bild', 'received', ?, ? FROM messages WHERE id = ?`, mediaId, t, JSON.stringify({ file: 'x' }), r.rec.message_b);
  r.t.app.services.channelMedia = { telegram: () => ({ __raw: true, status: 200, headers: { 'content-type': 'text/plain' }, body: `${MARK} Datei` }) };
  expect((await setAccess(r, { enabled: true, rules: { default: { levels: OWN } } })).status).toBe(200);
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await r?.t.close();
});

const leaks = (text: string) => text.toUpperCase().includes(MARK);

describe('record access: what hangs on a hidden contact', () => {
  it('the call log lists only calls of contacts the person may open, and finds nothing of others by search', async () => {
    const list = await r.alice('GET', '/api/calls?limit=200');
    expect(list.status).toBe(200);
    expect(leaks(list.text), list.text).toBe(false);
    expect(list.data.calls.map((c: any) => c.id)).toEqual([aliceCall]);
    const search = await r.alice('GET', `/api/calls?q=${MARK}`);
    expect(leaks(search.text), search.text).toBe(false);
    expect(search.data.calls).toEqual([]);
    // the admin (and a key) still see both
    expect((await r.admin('GET', '/api/calls')).data.calls.length).toBe(2);
  });

  it('the phone app’s call list follows the same rules', async () => {
    const tok = (await r.alice('POST', '/api/mobile/pair', { device_name: 'Alice phone' })).data.token;
    const phone = client(r.t.base, { authorization: `Bearer ${tok}`, 'x-location-id': r.loc });
    const res = await phone('GET', '/api/mobile/calls?limit=50');
    expect(res.status, res.text).toBe(200);
    expect(leaks(res.text), res.text).toBe(false);
    expect(res.data.map((c: any) => c.id)).toEqual([aliceCall]);
    expect((await r.admin('GET', '/api/mobile/calls?limit=50')).data.length).toBe(2);
  });

  it('reports on the call log are narrowed like the call log itself', async () => {
    const run = (call: typeof r.alice) => call('POST', '/api/reports/run', { query: { source: 'calls', measures: ['count'], group_by: ['contact'], range: 'all' } });
    const mine = await run(r.alice);
    expect(mine.status, mine.text).toBe(200);
    expect(leaks(mine.text), mine.text).toBe(false);
    expect(mine.data.totals.v[0]).toBe(1);
    const all = await run(r.admin);
    expect(all.data.totals.v[0]).toBe(2);
    expect(all.text.toUpperCase()).toContain(MARK);
  });

  it('a call cannot be opened, played, annotated or controlled by id or by Twilio sid', async () => {
    for (const key of [callId, sid]) {
      for (const [method, p] of [
        ['GET', `/api/calls/${key}`],
        ['GET', `/api/calls/${key}/notes`],
        ['POST', `/api/calls/${key}/notes`],
        ['GET', `/api/calls/${key}/recording`],
        ['DELETE', `/api/calls/${key}/recording`],
        ['GET', `/api/phone/calls/${key}`],
        ['POST', `/api/phone/calls/${key}/hangup`],
        ['POST', `/api/phone/calls/${key}/transfer`],
      ] as const) {
        const res = await r.alice(method, p, method === 'POST' ? { body: 'x' } : undefined);
        expect(res.status, `${method} ${p}`).toBe(404);
      }
    }
    expect((await r.alice('GET', `/api/calls/${aliceCall}`)).status).toBe(200);
    expect((await r.admin('GET', `/api/calls/${sid}`)).status).toBe(200);
  });

  it('call intelligence (analyses, transcripts) follows the contact; recordings that belong to nobody stay open', async () => {
    const list = await r.alice('GET', '/api/call-intel');
    expect(leaks(list.text), list.text).toBe(false);
    expect(list.data.items.map((i: any) => i.title)).toEqual(['Teammeeting']);
    for (const [method, p] of [
      ['GET', `/api/call-intel/${intelId}`],
      ['PATCH', `/api/call-intel/${intelId}`],
      ['DELETE', `/api/call-intel/${intelId}`],
      ['POST', `/api/call-intel/${intelId}/retry`],
      ['GET', `/api/call-intel/${intelId}/scores`],
      ['GET', `/api/call-intel/by-call/${callId}`],
      ['GET', `/api/call-intel/by-call/${sid}`],
      ['POST', `/api/call-intel/calls/${callId}/analyze`],
    ] as const) {
      const res = await r.alice(method, p, method === 'GET' ? undefined : {});
      expect(res.status, `${method} ${p}`).toBe(404);
    }
    expect(r.t.app.db.get('SELECT 1 AS x FROM call_intel WHERE id = ?', intelId)).toBeTruthy();
  });

  it('the AI phone agent’s sessions follow the contact too', async () => {
    const t = now();
    const ses = newId();
    r.t.app.db.insert('voice_ai_sessions', { id: ses, location_id: r.loc, call_id: callId, call_sid: sid, contact_id: r.rec.contact_b, transcript: JSON.stringify([{ role: 'caller', text: `${MARK} Hallo` }]), summary: `${MARK} Zusammenfassung`, started_at: t, last_at: t });
    const list = await r.alice('GET', '/api/voice-ai/calls');
    expect(leaks(list.text), list.text).toBe(false);
    expect((await r.alice('GET', `/api/voice-ai/calls/${ses}`)).status).toBe(404);
    expect((await r.alice('GET', `/api/voice-ai/calls/${callId}`)).status).toBe(404);
  });

  it('the power dialer neither lists nor hands out contacts the person may not open', async () => {
    // inside the default calling hours (Wednesday 10:00 Berlin) whatever the real time – otherwise `next` only answers "waiting"
    pinClock('2026-10-07T08:00:00Z');
    try {
      for (const p of [`/api/dialer/lists/${listId}/items`, '/api/dialer/callbacks']) {
        const res = await r.alice('GET', p);
        expect(leaks(res.text), `${p}: ${res.text}`).toBe(false);
      }
      const items = await r.alice('GET', `/api/dialer/lists/${listId}/items`);
      expect(items.data.map((i: any) => i.contact_id)).toEqual([r.rec.contact_a]);
      // the next entry is Alice's own contact – never Bob's, although his entry comes first
      const next = await r.alice('POST', `/api/dialer/lists/${listId}/next`, {});
      expect(next.status, next.text).toBe(200);
      expect(leaks(next.text), next.text).toBe(false);
      expect(next.data.item?.contact?.id).toBe(r.rec.contact_a);
      for (const action of ['dial', 'skip', 'disposition']) expect((await r.alice('POST', `/api/dialer/items/${itemId}/${action}`, { disposition: 'x' })).status, action).toBe(404);
      expect(r.t.app.db.get<any>('SELECT locked_by FROM dialer_items WHERE id = ?', itemId)?.locked_by ?? null).toBeNull();
      // the admin gets Bob's entry first
      const adminNext = await r.admin('POST', `/api/dialer/lists/${listId}/next`, {});
      expect(adminNext.data.item?.contact?.id).toBe(r.rec.contact_b);
    } finally {
      unpinClock();
    }
  });

  it('drafts and media files of somebody else’s conversation stay closed', async () => {
    const drafts = await r.alice('GET', '/api/conversations/drafts');
    expect(drafts.status).toBe(200);
    expect(leaks(drafts.text), drafts.text).toBe(false);
    expect((await r.admin('GET', '/api/conversations/drafts')).text).toContain(MARK);
    expect((await r.alice('GET', `/api/messages/channels/media/${mediaId}`)).status).toBe(404);
    expect((await r.alice('GET', `/api/messages/meta/media/${mediaId}`)).status).toBe(404);
    expect((await r.alice('GET', `/api/mail/attachments/${mediaId}/0`)).status).toBe(404);
    expect((await r.alice('DELETE', `/api/messages/${draftId}`)).status).toBe(404);
    expect(r.t.app.db.get('SELECT 1 AS x FROM messages WHERE id = ?', draftId)).toBeTruthy();
    // control: the admin gets the file
    expect((await r.admin('GET', `/api/messages/channels/media/${mediaId}`)).text).toContain(MARK);
  });

  it('bulk changes in the inbox only touch conversations the person may open', async () => {
    const before = r.t.app.db.get<any>('SELECT inbox_status, assignee_id FROM conversations WHERE id = ?', r.rec.conversation_b);
    const res = await r.alice('POST', '/api/inbox/bulk', { ids: [r.rec.conversation_b, r.rec.conversation_a], action: 'close' });
    expect(res.status, res.text).toBe(200);
    expect(res.data.updated).toBe(1);
    const after = r.t.app.db.get<any>('SELECT inbox_status, assignee_id FROM conversations WHERE id = ?', r.rec.conversation_b);
    expect(after).toEqual(before);
    expect(r.t.app.db.get<any>('SELECT inbox_status FROM conversations WHERE id = ?', r.rec.conversation_a)?.inbox_status).toBe('closed');
  });

  it('segment members and campaign recipients are limited to contacts the person may open', async () => {
    // a person with the campaigns area (Alice has none)
    const dana = client(r.t.base, { 'x-pghl': '1', 'x-location-id': r.loc });
    expect((await r.admin('POST', '/api/users', { email: 'dana@example.com', password: 'passwort-123', name: 'Dana', locations: [r.loc], permissions: ['contacts', 'campaigns'] })).status).toBe(200);
    expect((await dana('POST', '/api/auth/login', { email: 'dana@example.com', password: 'passwort-123' })).status).toBe(200);
    const seg = await r.admin('POST', '/api/segments', { name: 'Alle', definition: { type: 'group', op: 'and', items: [{ type: 'tag', tag: 'vertrieb' }] } });
    expect(seg.status, seg.text).toBe(200);
    const members = await dana('GET', `/api/segments/${seg.data.id}/contacts`);
    expect(members.status, members.text).toBe(200);
    expect(leaks(members.text), members.text).toBe(false);
    expect((await r.admin('GET', `/api/segments/${seg.data.id}/contacts`)).text).toContain(MARK);
    const camp = await r.admin('POST', '/api/campaigns', { name: 'K', subject: 'S', body: 'B' });
    r.t.app.db.insert('campaign_recipients', { campaign_id: camp.data.id, contact_id: r.rec.contact_b, status: 'sent', sent_at: now() });
    const rec = await dana('GET', `/api/campaigns/${camp.data.id}/recipients`);
    expect(rec.status, rec.text).toBe(200);
    expect(leaks(rec.text), rec.text).toBe(false);
  });
});

describe('record access: the Cognee memory', () => {
  it('a person with a narrowed view cannot ask about contacts, notes or conversations – everybody else still can', async () => {
    const c = await cogneeApp();
    try {
      await c.connect();
      const at = c.at(c.A);
      const space = (await at('POST', '/api/wiki/spaces', { name: 'Team' })).data;
      await at('POST', '/api/wiki/pages', { space_id: space.id, title: 'Wissen', body: 'Kuchen gibt es nur sonntags.' });
      const ct = (await at('POST', '/api/contacts', { first_name: 'Erika', last_name: 'Muster' })).data;
      await at('POST', `/api/contacts/${ct.id}/notes`, { body: 'Kuchen bestellt, Lieferung montags.' });
      await c.share(c.A, { notes: true });
      const member = async (email: string) => {
        expect((await c.admin('POST', '/api/users', { email, password: 'passwort-m1', name: email, locations: [c.A], permissions: ['wiki', 'contacts'] })).status).toBe(200);
        const m = client(c.t.base, { 'x-pghl': '1', 'x-location-id': c.A });
        expect((await m('POST', '/api/auth/login', { email, password: 'passwort-m1' })).status).toBe(200);
        return m;
      };
      const sales = await member('vertrieb@example.com');
      // rules off: the member asks about the note
      expect((await sales('GET', '/api/cognee/recall?q=Kuchen')).data.searched).toEqual(['wiki', 'notes']);
      expect((await at('PUT', '/api/sales/access', { enabled: true, rules: { default: { levels: { contacts: 'own' } } } })).status).toBe(200);
      const r = await sales('GET', '/api/cognee/recall?q=Kuchen');
      expect(r.status, r.text).toBe(200);
      expect(r.data.searched).toEqual(['wiki']);
      expect(r.text).not.toContain('Lieferung montags');
      expect((await sales('GET', '/api/cognee/recall?q=Kuchen&types=notes')).status).toBe(403);
      expect((await sales('GET', '/api/cognee/recall?q=Kuchen&types=notes,wiki')).data.searched).toEqual(['wiki']);
      expect((await sales('GET', '/api/cognee/info')).data.types.map((t: any) => t.key)).toEqual(['wiki']);
      // the admin and the rest of the sub-account's rules (records with level "alle") are not affected
      expect((await at('GET', '/api/cognee/recall?q=Kuchen')).data.searched).toEqual(['wiki', 'notes']);
      expect((await at('PUT', '/api/sales/access', { enabled: true, rules: { default: { levels: { contacts: 'all' } } } })).status).toBe(200);
      expect((await sales('GET', '/api/cognee/recall?q=Kuchen')).data.searched).toEqual(['wiki', 'notes']);
    } finally {
      await c.close();
    }
  });
});

describe('community members and their videos', () => {
  it('a member can start only about three videos’ worth of uploads a day; the team and other members are not held back', async () => {
    const MB = 1024 * 1024;
    const group = (await r.admin('POST', '/api/community/groups', { name: 'Video-Gruppe', description: 'x' })).data;
    expect(group.id).toBeTruthy();
    const app = r.t.app;
    const g = { id: group.id as string, location_id: r.loc };
    const finish = (uid: string) => app.db.run(`UPDATE community_videos SET status = 'complete', received = size WHERE id = ?`, uid);
    const start = (who: string | null, size = 500 * MB) => startVideoUpload(app, g, who, 'v.mp4', size);
    for (let i = 0; i < 3; i++) finish(start(r.rec.contact_a).id);
    expect(() => start(r.rec.contact_a, 10 * MB)).toThrow(/heute schon viele Videos/);
    // somebody else, the team, and (after a day) the same member again
    expect(start(r.rec.contact_c).size).toBe(500 * MB);
    expect(start(null).size).toBe(500 * MB);
    app.db.run(`UPDATE community_videos SET created_at = ? WHERE contact_id = ?`, new Date(Date.now() - 2 * 864e5).toISOString(), r.rec.contact_a);
    expect(start(r.rec.contact_a, 10 * MB).size).toBe(10 * MB);
    // a start that is refused leaves no file behind
    const count = (app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_videos')!).n;
    for (let i = 0; i < 2; i++) finish(start(r.rec.contact_c).id);
    expect(() => start(r.rec.contact_c, 100 * MB)).toThrow();
    expect((app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_videos')!).n).toBe(count + 2);
  });
});
