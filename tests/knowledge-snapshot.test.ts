import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

let t: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.app.db;
const count = (sql: string, ...args: any[]) => db().get<{ n: number }>(sql, ...args)!.n;

describe('Wissens-Snapshot: agents, memory, wiki, help centre and learnings travel to a new market', () => {
  let src = '';
  let agent: any;

  it('builds a source account with knowledge', async () => {
    src = t.api.location;
    agent = (await t.api.post('/api/agents', { name: 'Vertriebs-Agent', description: 'Qualifiziert Leads', instructions: 'Antworte freundlich und biete ein Erstgespräch an.', starters: ['Neue Leads prüfen'], knowledge: { sources: ['kb'], text: 'Unser Bestseller ist das Gute-Nacht-Buch.' } })).data;
    expect(agent.id).toBeTruthy();
    db().insert('agent_memory', { id: 'm1', location_id: src, agent_key: agent.id, text: 'Betreffzeilen mit Vornamen öffnen besser.', created_by: null, created_at: new Date().toISOString() });
    db().insert('agent_memory', { id: 'm2', location_id: src, agent_key: 'default:someone', text: 'Persönliche Notiz', created_by: null, created_at: new Date().toISOString() });
    db().insert('cognee_memories', { id: 'c1', location_id: src, text: 'Weihnachten verkauft am besten ab Mitte November.', created_by: null, created_by_name: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

    const space = (await t.api.post('/api/wiki/spaces', { name: 'Marketing' })).data;
    const parent = (await t.api.post('/api/wiki/pages', { space_id: space.id, title: 'Kampagnen', body: '# Kampagnen\n\nWas funktioniert.' })).data;
    await t.api.post('/api/wiki/pages', { space_id: space.id, parent_id: parent.id, title: 'Newsletter', body: 'Dienstag 9 Uhr senden.' });

    const cat = (await t.api.post('/api/kb/categories', { name: 'Versand' })).data;
    await t.api.post('/api/kb/articles', { category_id: cat.id, title: 'Lieferzeiten', body: '2–3 Werktage.', status: 'published' });

    const lead = (await t.api.post('/api/contacts', { email: 'lea@example.de', source: 'Instagram' })).data;
    expect(lead.id).toBeTruthy();
  });

  it('leaves knowledge out of a normal snapshot (snapshots are often handed to clients)', async () => {
    const snap = (await t.api.post('/api/snapshots', { location_id: src, name: 'Nur Bausteine' })).data;
    expect(snap.summary).toMatchObject({ agents: 0, memories: 0, wiki_pages: 0, kb_articles: 0, learnings: 0 });
    const data = JSON.parse(db().get('SELECT data FROM snapshots WHERE id = ?', snap.id)!.data);
    expect(data.knowledge_agents).toBeUndefined();
  });

  it('takes the knowledge along with include_knowledge and applies it to another sub-account', async () => {
    const snap = (await t.api.post('/api/snapshots', { location_id: src, name: 'Mit Wissen', include_knowledge: true })).data;
    // the personal note of the default assistant stays behind
    expect(snap.summary).toMatchObject({ agents: 1, memories: 2, wiki_pages: 2, kb_articles: 1, learnings: 1 });
    const data = JSON.parse(db().get('SELECT data FROM snapshots WHERE id = ?', snap.id)!.data);
    expect(data.knowledge_learnings[0].body).toContain('## Lead-Quellen');
    expect(data.knowledge_learnings[0].body).toContain('Instagram');

    const dst = (await t.api.post('/api/agency/clients', { name: 'Goodnight Books UK' })).data.location.id;
    const r = (await t.api.post(`/api/snapshots/${snap.id}/apply`, { location_id: dst })).data;
    expect(r).toMatchObject({ knowledge_agents: 1, knowledge_memory: 2, knowledge_wiki: 2, knowledge_kb: 1, knowledge_learnings: 1, translated: 0 });

    const a = db().get('SELECT * FROM agents WHERE location_id = ?', dst)!;
    expect(a).toMatchObject({ name: 'Vertriebs-Agent', instructions: 'Antworte freundlich und biete ein Erstgespräch an.', visibility: 'location', connection_id: '', schedules: '[]' });
    expect(a.id).not.toBe(agent.id);
    // the agent's memory follows the copied agent
    expect(db().all('SELECT text FROM agent_memory WHERE location_id = ? AND agent_key = ?', dst, a.id).map((m) => m.text)).toEqual(['Betreffzeilen mit Vornamen öffnen besser.']);
    expect(count('SELECT COUNT(*) AS n FROM cognee_memories WHERE location_id = ?', dst)).toBe(1);

    // wiki tree kept, a "Learnings" space added, pages found by search
    const child = db().get("SELECT * FROM wiki_pages WHERE location_id = ? AND title = 'Newsletter'", dst)!;
    const parentRow = db().get('SELECT * FROM wiki_pages WHERE id = ?', child.parent_id)!;
    expect(parentRow.title).toBe('Kampagnen');
    expect(count("SELECT COUNT(*) AS n FROM wiki_spaces WHERE location_id = ? AND name = 'Learnings'", dst)).toBe(1);
    t.api.setLocation(dst);
    const hits = (await t.api.get('/api/wiki/search?q=Dienstag')).data;
    t.api.setLocation(src);
    expect(JSON.stringify(hits)).toContain('Newsletter');

    // help centre copied as a draft under its category
    const art = db().get('SELECT * FROM kb_articles WHERE location_id = ?', dst)!;
    expect(art).toMatchObject({ title: 'Lieferzeiten', status: 'draft' });
    expect(db().get('SELECT name FROM kb_categories WHERE id = ?', art.category_id)!.name).toBe('Versand');
  });

  it('translates the knowledge first with translate_to, and copies nothing when the translation fails', async () => {
    const snap = (await t.api.post('/api/snapshots', { location_id: src, name: 'International', include_knowledge: true })).data;
    const dst = (await t.api.post('/api/agency/clients', { name: 'Goodnight Books US' })).data.location.id;
    const prevRun = t.app.services.aiRun;
    const prevReady = t.app.services.aiReady;
    const calls: any[] = [];
    t.app.services.aiReady = () => null;
    t.app.services.aiRun = async (input: any) => {
      calls.push(input);
      const { texts } = JSON.parse(input.user);
      return { text: JSON.stringify({ texts: texts.map((x: string) => `[EN] ${x}`) }) };
    };
    try {
      const r = (await t.api.post(`/api/snapshots/${snap.id}/apply`, { location_id: dst, translate_to: 'Englisch' })).data;
      expect(r.translated).toBeGreaterThan(5);
      expect(calls[0]).toMatchObject({ purpose: 'snapshot_translate', locationId: dst });
      expect(calls[0].system[0].text).toContain('Englisch');
      expect(db().get('SELECT instructions FROM agents WHERE location_id = ?', dst)!.instructions).toBe('[EN] Antworte freundlich und biete ein Erstgespräch an.');
      expect(db().get("SELECT title FROM kb_articles WHERE location_id = ?", dst)!.title).toBe('[EN] Lieferzeiten');

      const dst2 = (await t.api.post('/api/agency/clients', { name: 'Kaputt' })).data.location.id;
      t.app.services.aiRun = async () => ({ text: '{"texts": ["nur einer"]}' });
      const bad = await t.api.post(`/api/snapshots/${snap.id}/apply`, { location_id: dst2, translate_to: 'Englisch' });
      expect(bad.status).toBe(409);
      expect(count('SELECT COUNT(*) AS n FROM agents WHERE location_id = ?', dst2)).toBe(0);
    } finally {
      t.app.services.aiRun = prevRun;
      t.app.services.aiReady = prevReady;
    }
  });

  it('never puts knowledge into a single website copy', async () => {
    const site = (await t.api.post('/api/funnels', { name: 'Shop', kind: 'website' })).data;
    const dst = (await t.api.post('/api/agency/clients', { name: 'Nur Website' })).data.location.id;
    const r = (await t.api.post(`/api/funnels/${site.id}/copy`, { location_id: dst })).data;
    expect(r.knowledge_agents ?? 0).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM wiki_pages WHERE location_id = ?', dst)).toBe(0);
  });
});
