import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { receiveMessage } from '../server/services/messaging.js';
import { cleanSnippet, ftsQuery } from '../server/modules/inbox-filters.js';
import { startTestApp } from './helpers.js';

/** Inbox filters (tag, pipeline/stage, owner) and full-text search over messages (modules/inbox-filters.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let me = '';
beforeAll(async () => {
  t = await startTestApp();
  me = (await t.setup()).user?.id ?? '';
  loc = t.api.location;
  if (!me) me = t.app.db.get<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
});
afterAll(() => t?.close());

const convOf = (contactId: string) => t.app.db.get<{ id: string }>('SELECT id FROM conversations WHERE contact_id = ?', contactId)!.id;
const listIds = async (qs: string) => ((await t.api.get(`/api/conversations?${qs}`)).data as any[]).map((c) => c.contact_id).sort();

describe('inbox filters and message search', () => {
  const ids: Record<string, string> = {};
  it('builds safe FTS queries and clean snippets', () => {
    expect(ftsQuery('Rechnung  März')).toBe('"Rechnung"* "März"*');
    expect(ftsQuery('a" OR *b')).toBe('"a"* "OR"* "b"*');
    expect(ftsQuery('  ')).toBe('');
    expect(cleanSnippet('<p>Hallo&nbsp;<b>\u0001Welt\u0002</b></p>')).toBe('Hallo \u0001Welt\u0002');
  });

  it('filters conversations by tag, open deal in a pipeline/stage and contact owner', async () => {
    receiveMessage(t.app, loc, { channel: 'email', from: 'anna@example.com', subject: 'Angebot', body: 'Bitte schicken Sie mir das Angebot für die Küchenrenovierung.' });
    receiveMessage(t.app, loc, { channel: 'sms', from: '+491701234567', body: 'Ist die Rechnung 2026-17 schon bezahlt?' });
    receiveMessage(t.app, loc, { channel: 'email', from: 'cem@example.com', subject: 'Termin', body: '<p>Können wir den Termin verschieben? Grüße</p>' });
    for (const [k, v] of Object.entries({ anna: `email = 'anna@example.com'`, ben: `phone = '+491701234567'`, cem: `email = 'cem@example.com'` })) ids[k] = t.app.db.get<{ id: string }>(`SELECT id FROM contacts WHERE location_id = ? AND ${v}`, loc)!.id;
    await t.api.patch(`/api/contacts/${ids.anna}`, { tags: ['vip'] });
    t.app.db.run('UPDATE contacts SET assigned_to = ? WHERE id = ?', me, ids.cem);
    const pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: [{ name: 'Neu' }, { name: 'Angebot' }] })).data;
    const stage = pipe.stages[1].id;
    expect((await t.api.post('/api/opportunities', { pipeline_id: pipe.id, stage_id: stage, contact_id: ids.ben, name: 'Deal Ben' })).status).toBe(200);
    const lost = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, stage_id: stage, contact_id: ids.cem, name: 'Deal Cem' })).data;
    await t.api.patch(`/api/opportunities/${lost.id}`, { status: 'lost', lost_reason: 'Preis' });

    expect(await listIds('')).toEqual([ids.anna, ids.ben, ids.cem].sort());
    expect(await listIds('tag=vip')).toEqual([ids.anna]);
    expect(await listIds(`pipeline_id=${pipe.id}`)).toEqual([ids.ben]);
    expect(await listIds(`pipeline_id=${pipe.id}&stage_id=${pipe.stages[0].id}`)).toEqual([]);
    expect(await listIds(`stage_id=${stage}`)).toEqual([ids.ben]);
    expect(await listIds('owner=me')).toEqual([ids.cem]);
    expect(await listIds(`owner=${me}`)).toEqual([ids.cem]);
    expect(await listIds('owner=none')).toEqual([ids.anna, ids.ben].sort());
    expect(await listIds('tag=vip&owner=me')).toEqual([]);
  });

  it('finds messages by words (prefix, accents, HTML stripped) with a snippet and the conversation', async () => {
    const r = await t.api.get('/api/conversations/search?q=kuchenreno');
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.fts).toBe(true);
    expect(r.data.complete).toBe(true);
    expect(r.data.hits).toHaveLength(1);
    expect(r.data.hits[0]).toMatchObject({ conversation_id: convOf(ids.anna), contact_id: ids.anna, channel: 'email', direction: 'in', subject: 'Angebot' });
    expect(r.data.hits[0].snippet).toContain('\u0001Küchenrenovierung\u0002');
    expect((await t.api.get('/api/conversations/search?q=termin verschieben')).data.hits[0].snippet).not.toContain('<p>');
    expect((await t.api.get('/api/conversations/search?q=rechnung&channel=email')).data.hits).toHaveLength(0);
    expect((await t.api.get('/api/conversations/search?q=rechnung&channel=sms')).data.hits).toHaveLength(1);
    // The list filters apply to the search too.
    expect((await t.api.get('/api/conversations/search?q=angebot&tag=vip')).data.hits).toHaveLength(1);
    expect((await t.api.get('/api/conversations/search?q=angebot&owner=me')).data.hits).toHaveLength(0);
    expect((await t.api.get('/api/conversations/search?q=a')).status).toBe(400);
  });

  it('keeps the index in step with new, edited and deleted messages, and the outbound side too', async () => {
    const sent = await t.api.post('/api/messages', { contact_id: ids.ben, channel: 'sms', body: 'Die Zahlung für Rechnung 2026-17 ist eingegangen, danke!' });
    expect(sent.status).toBe(200);
    const hits = (await t.api.get('/api/conversations/search?q=zahlung eingegangen')).data.hits;
    expect(hits).toEqual([expect.objectContaining({ direction: 'out', message_id: sent.data.id })]);
    t.app.db.run(`UPDATE messages SET body = 'Zahlungseingang bestätigt' WHERE id = ?`, sent.data.id);
    expect((await t.api.get('/api/conversations/search?q=eingegangen')).data.hits).toHaveLength(0);
    expect((await t.api.get('/api/conversations/search?q=zahlungseingang')).data.hits).toHaveLength(1);
    await t.api.del(`/api/contacts/${ids.ben}`);
    expect((await t.api.get('/api/conversations/search?q=zahlungseingang')).data.hits).toHaveLength(0);
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages_fts')!.n).toBe(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n);
  });

  it('hides blocked senders from the search like from the list, and other sub-accounts never match', async () => {
    expect((await t.api.post('/api/blocked-contacts', { contact_id: ids.cem })).status).toBe(200);
    expect((await t.api.get('/api/conversations/search?q=termin')).data.hits).toHaveLength(0);
    expect((await t.api.get('/api/conversations/search?q=termin&filter=spam')).data.hits).toHaveLength(1);
    const other = (await t.api.post('/api/locations', { name: 'Zweiter Kunde' })).data.id;
    receiveMessage(t.app, other, { channel: 'email', from: 'x@example.com', body: 'Küchenrenovierung woanders' });
    expect((await t.api.get('/api/conversations/search?q=kuchenrenovierung')).data.hits).toHaveLength(1);
  });

  it('has a read-only MCP tool for agents (results marked as untrusted)', async () => {
    const tool = (t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_search_messages');
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.untrusted).toBe(true);
    let path = '';
    await tool.run({ agency: false, api: async (_m: string, p: string) => ((path = p), {}) }, { q: 'angebot', tag: 'vip' });
    expect(path).toBe('/api/conversations/search?q=angebot&tag=vip');
  });
});

describe('message index on an existing database', () => {
  it('indexes the messages of a database that had none – large ones in slices, new messages right away', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'pghl-fts-'));
    const dbFile = join(dir, 'keep.db');
    const a = await startTestApp({ dataDir: dir, dbFile });
    await a.setup();
    const l = a.api.location;
    receiveMessage(a.app, l, { channel: 'email', from: 'alt@example.com', body: 'Seit Jahren treuer Kunde' });
    const conv = a.app.db.get<{ id: string; contact_id: string }>('SELECT id, contact_id FROM conversations LIMIT 1')!;
    // A database from before the index: no FTS table, 25 000 old messages.
    a.app.db.raw.exec('DROP TRIGGER messages_fts_ai; DROP TRIGGER messages_fts_ad; DROP TRIGGER messages_fts_au; DROP TABLE messages_fts; DROP TABLE messages_fts_state;');
    a.app.db.raw.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25000)
      INSERT INTO messages (id, location_id, conversation_id, contact_id, channel, direction, subject, body, status, created_at)
      SELECT 'old' || i, '${l}', '${conv.id}', '${conv.contact_id}', 'email', 'in', '', 'Altnachricht Nummer ' || i, 'received', '2020-01-01T00:00:00.000Z' FROM n`);
    const cookie = a.api.cookie;
    await a.close().catch(() => undefined);
    const b = await startTestApp({ dataDir: dir, dbFile });
    try {
      const call = (p: string) => b.api.get(p, { cookie, 'x-location-id': l });
      receiveMessage(b.app, l, { channel: 'email', from: 'neu@example.com', body: 'Brandneue Anfrage zur Wärmepumpe' });
      const early = (await call('/api/conversations/search?q=warmepumpe')).data;
      expect(early.hits).toHaveLength(1);
      expect(early.complete).toBe(false);
      (b.app.services.messageSearchBackfill as () => void)();
      const done = (await call('/api/conversations/search?q=treuer kunde')).data;
      expect(done.complete).toBe(true);
      expect(done.hits).toHaveLength(1);
      expect((await call('/api/conversations/search?q=altnachricht&limit=100')).data.hits).toHaveLength(100);
      expect(b.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages_fts')!.n).toBe(b.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n);
    } finally {
      await b.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
