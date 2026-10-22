import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const calls: { method: string; url: string; body: any; headers: Record<string, string> }[] = [];
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.services.supabaseFetch = async (url: string, init: any) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    return { status: init.method === 'GET' ? 200 : 201, text: '[]' };
  };
});
afterAll(async () => {
  await t.close();
});

describe('supabase mirror', () => {
  it('needs https and a key, tests the connection, never returns the key', async () => {
    expect((await t.api.patch('/api/agency/supabase', { url: 'http://db.example.com' })).status).toBe(400);
    const r = await t.api.patch('/api/agency/supabase', { url: 'https://db.example.com/', service_key: 'service-role-secret', enabled: true });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ url: 'https://db.example.com', enabled: true, key_set: true });
    expect(JSON.stringify(r.data)).not.toContain('service-role-secret');
    expect(calls.at(-1)).toMatchObject({ method: 'GET', url: 'https://db.example.com/rest/v1/ghl_projects?select=id&limit=1' });
    expect(calls.at(-1)!.headers.apikey).toBe('service-role-secret');
  });

  it('upserts every table, then only changed rows; a full run deletes stale rows', async () => {
    await t.api.post('/api/contacts', { email: 'spiegel@x.de', first_name: 'Spiegel', tags: ['a'] });
    calls.length = 0;
    const full = await t.api.post('/api/agency/supabase/sync', { full: true });
    expect(full.status).toBe(200);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url.split('/rest/v1/')[1])).toEqual(expect.arrayContaining(['ghl_projects?on_conflict=id', 'ghl_contacts?on_conflict=id']));
    const contact = posts.find((c) => c.url.includes('ghl_contacts'))!.body.find((r: any) => r.email === 'spiegel@x.de');
    expect(contact).toMatchObject({ first_name: 'Spiegel', tags: ['a'], dnd: false });
    expect(contact.synced_at).toBeTruthy();
    expect(posts[0].headers.prefer).toContain('merge-duplicates');
    // One clean-up per table (modules may add tables, e.g. companies and custom objects).
    expect(calls.filter((c) => c.method === 'DELETE').length).toBe((await t.api.get('/api/agency/supabase')).data.tables.length);

    calls.length = 0;
    const inc = await t.api.post('/api/agency/supabase/sync', {});
    expect(inc.data.counts.ghl_contacts).toBe(0);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect((await t.api.get('/api/agency/supabase')).data.state.last_error).toBe('');
  });

  it('records errors from Supabase', async () => {
    t.app.services.supabaseFetch = async () => ({ status: 404, text: 'relation "ghl_projects" does not exist' });
    const r = await t.api.post('/api/agency/supabase/sync', { full: true });
    expect(r.status).toBe(500);
    expect((await t.api.get('/api/agency/supabase')).data.state.last_error).toContain('does not exist');
  });
});
