import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactOrder } from '../server/services/smart-lists.js';
import { mcpClient } from './mk-fixtures.js';
import { MARK, OWN, rig, setAccess, type Rig } from './record-access-fixtures.js';

/** Smart Lists 2.0 (modules/smart-lists.ts, services/smart-lists.ts): saved contact views with columns, sort and visibility. */

let r: Rig;
beforeAll(async () => {
  r = await rig();
  // Custom fields to sort by: a number and a text.
  expect((await r.admin('POST', '/api/custom-fields', { label: 'Umsatz', key: 'umsatz', type: 'number' })).status).toBe(200);
  expect((await r.admin('POST', '/api/custom-fields', { label: 'Branche', key: 'branche', type: 'text' })).status).toBe(200);
  const put = async (first: string, custom: Record<string, unknown>) => (await r.admin('POST', '/api/contacts', { first_name: first, email: `${first.toLowerCase()}@sort.example`, tags: ['sortierung'], custom })).data.id as string;
  await put('Klein', { umsatz: 5, branche: 'handel' });
  await put('Gross', { umsatz: 100, branche: 'Agentur' });
  await put('Mittel', { umsatz: 20, branche: 'bau' });
  await put('Ohne', {});
}, 120_000);
afterAll(async () => {
  await r?.t.close();
});

const firstNames = (res: any) => (res.data.contacts as any[]).map((c) => (c.first_name ?? c.name).split(' ')[0]);

describe('smart lists – saving views', () => {
  it('keeps lists from before 2.0 working (shared, default columns) and saves columns, sort and visibility', async () => {
    r.t.app.db.run(`INSERT INTO smart_lists (id, location_id, name, filter, created_at) VALUES ('legacy1', ?, 'Alt', '{"tags":["vertrieb"]}', ?)`, r.loc, new Date().toISOString());
    const legacy = (await r.alice('GET', '/api/smart-lists')).data.find((l: any) => l.id === 'legacy1');
    expect(legacy).toMatchObject({ visibility: 'shared', columns: ['name', 'email', 'phone', 'tags'], mine: false, can_edit: true, filter: { tags: ['vertrieb'] } });

    const res = await r.alice('POST', '/api/smart-lists', { name: 'Sortiert', filter: { tags: ['sortierung'], q: '' }, columns: ['name', 'custom.umsatz', 'nope', 'custom.gibtsnicht', 'name', 'city'], sort: 'custom.umsatz', sort_dir: 'desc', visibility: 'shared' });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data).toMatchObject({ name: 'Sortiert', columns: ['name', 'custom.umsatz', 'city'], sort: 'custom.umsatz', sort_dir: 'desc', visibility: 'shared', mine: true, can_edit: true, owner_name: 'Alice Vertrieb' });

    // rename
    const ren = await r.alice('PATCH', `/api/smart-lists/${res.data.id}`, { name: 'Umsatz absteigend' });
    expect(ren.data.name).toBe('Umsatz absteigend');
    expect((await r.alice('PATCH', `/api/smart-lists/${res.data.id}`, { name: '' })).status).toBe(400);
    expect((await r.alice('POST', '/api/smart-lists', { name: 'x', sort: 'gibtsnicht' })).status).toBe(400);
    expect((await r.alice('POST', '/api/smart-lists', { name: 'x', filter: 'tags=a' })).status).toBe(400);
  });

  it('private lists are only visible to their creator; shared lists only change by the creator or an admin', async () => {
    const priv = (await r.alice('POST', '/api/smart-lists', { name: 'Alices Geheimliste', filter: { tags: ['vertrieb'] }, visibility: 'private' })).data;
    expect(priv.visibility).toBe('private');
    const shared = (await r.alice('POST', '/api/smart-lists', { name: 'Fürs Team', filter: { tags: ['vertrieb'] } })).data;

    const ids = async (call: Rig['alice']) => ((await call('GET', '/api/smart-lists')).data as any[]).map((l) => l.id);
    expect(await ids(r.alice)).toEqual(expect.arrayContaining([priv.id, shared.id]));
    expect(await ids(r.bob)).toContain(shared.id);
    expect(await ids(r.bob)).not.toContain(priv.id);
    // Not even an admin sees another person's private list.
    expect(await ids(r.admin)).not.toContain(priv.id);
    expect((await r.bob('GET', `/api/smart-lists/${priv.id}`)).status).toBe(404);
    expect((await r.bob('GET', `/api/smart-lists/${priv.id}/contacts`)).status).toBe(404);
    expect((await r.bob('PATCH', `/api/smart-lists/${priv.id}`, { name: 'gekapert' })).status).toBe(404);
    await r.bob('DELETE', `/api/smart-lists/${priv.id}`);
    expect((await r.alice('GET', `/api/smart-lists/${priv.id}`)).data.name).toBe('Alices Geheimliste');

    // A shared list: others see and use it, but only the creator or an admin change it.
    const bobView = (await r.bob('GET', '/api/smart-lists')).data.find((l: any) => l.id === shared.id);
    expect(bobView).toMatchObject({ mine: false, can_edit: false });
    expect((await r.bob('PATCH', `/api/smart-lists/${shared.id}`, { name: 'Bobs' })).status).toBe(403);
    expect((await r.bob('DELETE', `/api/smart-lists/${shared.id}`)).status).toBe(403);
    expect((await r.admin('PATCH', `/api/smart-lists/${shared.id}`, { name: 'Team (Admin)' })).data.name).toBe('Team (Admin)');
    // Only the creator switches between shared and private.
    expect((await r.admin('PATCH', `/api/smart-lists/${shared.id}`, { visibility: 'private' })).status).toBe(403);
    expect((await r.alice('PATCH', `/api/smart-lists/${shared.id}`, { visibility: 'private' })).data.visibility).toBe('private');
    expect(await ids(r.bob)).not.toContain(shared.id);
    expect((await r.alice('DELETE', `/api/smart-lists/${shared.id}`)).status).toBe(200);
    expect(await ids(r.alice)).not.toContain(shared.id);
  });

  it('keeps sub-accounts apart', async () => {
    const other = (await r.admin('POST', '/api/locations', { name: 'Zweite Firma' })).data.id as string;
    const mine = (await r.admin('POST', '/api/smart-lists', { name: 'Nur hier', filter: {} })).data;
    const there = await r.admin('GET', '/api/smart-lists', undefined, { 'x-location-id': other });
    expect(there.status).toBe(200);
    expect((there.data as any[]).map((l) => l.id)).not.toContain(mine.id);
    expect((await r.admin('GET', `/api/smart-lists/${mine.id}/contacts`, undefined, { 'x-location-id': other })).status).toBe(404);
    expect((await r.admin('PATCH', `/api/smart-lists/${mine.id}`, { name: 'fremd' }, { 'x-location-id': other })).status).toBe(404);
    await r.admin('DELETE', `/api/smart-lists/${mine.id}`, undefined, { 'x-location-id': other });
    expect((await r.admin('GET', `/api/smart-lists/${mine.id}`)).status).toBe(200);
    // A custom field of this sub-account is no sort key in the other one.
    expect((await r.admin('POST', '/api/smart-lists', { name: 'x', sort: 'custom.umsatz' }, { 'x-location-id': other })).status).toBe(400);
  });
});

describe('smart lists – sorting', () => {
  it('sorts by a custom number field both ways, empty values last', async () => {
    const asc = await r.admin('GET', '/api/contacts?tag=sortierung&sort=custom.umsatz&dir=asc');
    expect(firstNames(asc)).toEqual(['Klein', 'Mittel', 'Gross', 'Ohne']);
    const desc = await r.admin('GET', '/api/contacts?tag=sortierung&sort=custom.umsatz&dir=desc');
    expect(firstNames(desc)).toEqual(['Gross', 'Mittel', 'Klein', 'Ohne']);
  });

  it('sorts text custom fields case-insensitively and built-in columns', async () => {
    expect(firstNames(await r.admin('GET', '/api/contacts?tag=sortierung&sort=custom.branche&dir=asc'))).toEqual(['Gross', 'Mittel', 'Klein', 'Ohne']);
    expect(firstNames(await r.admin('GET', '/api/contacts?tag=sortierung&sort=name&dir=desc'))).toEqual(['Ohne', 'Mittel', 'Klein', 'Gross']);
    expect(firstNames(await r.admin('GET', '/api/contacts?tag=sortierung&sort=email'))).toEqual(['Gross', 'Klein', 'Mittel', 'Ohne']);
  });

  it("applies the list's sort to its contacts, and ?sort= overrides it", async () => {
    const l = (await r.admin('POST', '/api/smart-lists', { name: 'Top-Umsatz', filter: { tags: ['sortierung'] }, columns: ['name', 'custom.umsatz'], sort: 'custom.umsatz', sort_dir: 'desc' })).data;
    const res = await r.admin('GET', `/api/smart-lists/${l.id}/contacts`);
    expect(res.data.total).toBe(4);
    expect(res.data.list).toMatchObject({ sort: 'custom.umsatz', sort_dir: 'desc', columns: ['name', 'custom.umsatz'] });
    expect(firstNames(res)).toEqual(['Gross', 'Mittel', 'Klein', 'Ohne']);
    expect(res.data.contacts[0].custom).toEqual({ umsatz: 100 });
    expect(firstNames(await r.admin('GET', `/api/smart-lists/${l.id}/contacts?sort=name&dir=asc`))).toEqual(['Gross', 'Klein', 'Mittel', 'Ohne']);
    expect(firstNames(await r.admin('GET', `/api/smart-lists/${l.id}/contacts?limit=2&offset=2`))).toEqual(['Klein', 'Ohne']);
  });

  it('never puts request text into SQL (injection attempts)', async () => {
    const evil = ["custom.umsatz'); DROP TABLE contacts;--", 'name; DROP TABLE contacts', 'created_at DESC, (SELECT 1)', 'custom.x) --', 'custom.gibtsnicht'];
    for (const s of evil) {
      expect((await r.admin('POST', '/api/smart-lists', { name: 'böse', sort: s })).status, s).toBe(400);
      // The contact list ignores an unknown sort and stays in its default order.
      const res = await r.admin('GET', `/api/contacts?tag=sortierung&sort=${encodeURIComponent(s)}&dir=${encodeURIComponent('asc; DROP TABLE contacts')}`);
      expect(res.status, s).toBe(200);
      expect(res.data.total).toBe(4);
    }
    const l = (await r.admin('POST', '/api/smart-lists', { name: 'Filter mit Anführungszeichen', filter: { tags: ["o'reilly\"); DROP TABLE contacts;--"], q: "' OR 1=1 --", "bad key'); --": 'x' } })).data;
    expect(Object.keys(l.filter)).toEqual(['tags', 'q']);
    const res = await r.admin('GET', `/api/smart-lists/${l.id}/contacts?sort=${encodeURIComponent('custom.umsatz; DROP TABLE contacts')}`);
    expect(res.status).toBe(400);
    expect((await r.admin('GET', `/api/smart-lists/${l.id}/contacts`)).data.total).toBe(0);
    expect(r.t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contacts')!.n).toBe(8);
    // The ORDER BY itself: fixed SQL, the custom field's path as a bound parameter.
    const o = contactOrder(r.t.app, r.loc, 'custom.umsatz', 'desc; DROP')!;
    expect(o.sql).not.toContain('umsatz');
    expect(o.sql).toContain('ASC, CAST(json_extract(custom, ?) AS REAL) ASC');
    expect(o.params).toEqual(['$.umsatz', '$.umsatz', '$.umsatz']);
    expect(contactOrder(r.t.app, r.loc, 'custom.umsatz', 'desc')!.sql).toContain('REAL) DESC');
    expect(contactOrder(r.t.app, r.loc, "custom.a'b", 'asc')).toBeUndefined();
  });
});

describe('smart lists – record access and agents', () => {
  it("narrows a shared list's contacts by the record-access rules", async () => {
    const l = (await r.admin('POST', '/api/smart-lists', { name: 'Vertrieb alle', filter: { tags: ['vertrieb'] } })).data;
    expect((await r.alice('GET', `/api/smart-lists/${l.id}/contacts`)).data.total).toBe(3);
    expect((await setAccess(r, { enabled: true, rules: { default: { levels: OWN } } })).status).toBe(200);
    try {
      const res = await r.alice('GET', `/api/smart-lists/${l.id}/contacts`);
      expect(res.data.total).toBe(1);
      expect(JSON.stringify(res.data)).not.toContain(MARK);
      expect(res.data.contacts[0].name).toContain('Alpha');
    } finally {
      await setAccess(r, { enabled: false });
    }
  });

  it('agent tools list smart lists and fetch contacts as the person (private lists and rules respected)', async () => {
    const priv = (await r.alice('POST', '/api/smart-lists', { name: 'Alice privat (Agent)', filter: { tags: ['vertrieb'] }, visibility: 'private', sort: 'name' })).data;
    const agent = r.t.app.services.agent;
    const alice = agent.userFromRow(r.t.app.db.get('SELECT * FROM users WHERE id = ?', r.ids.alice));
    const bob = agent.userFromRow(r.t.app.db.get('SELECT * FROM users WHERE id = ?', r.ids.bob));
    const run = (user: any, name: string, args: Record<string, unknown>) => agent.runTool({ user, locationId: r.loc, name, args, allow: 'read' });

    const aliceLists: any[] = await run(alice, 'ghl_smart_lists', {});
    expect(aliceLists.map((l) => l.id)).toContain(priv.id);
    const bobLists: any[] = await run(bob, 'ghl_smart_lists', {});
    expect(bobLists.map((l) => l.id)).not.toContain(priv.id);
    await expect(run(bob, 'ghl_smart_list_contacts', { list_id: priv.id })).rejects.toThrow();

    await setAccess(r, { enabled: true, rules: { default: { levels: OWN } } });
    try {
      const got: any = await run(alice, 'ghl_smart_list_contacts', { list_id: priv.id });
      expect(got.total).toBe(1);
      expect(JSON.stringify(got)).not.toContain(MARK);
    } finally {
      await setAccess(r, { enabled: false });
    }

    // MCP with a sub-account key: shared lists only, read tools without confirmation.
    const m = await mcpClient(r.t as any, r.loc);
    const names = (await m.tools()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['ghl_smart_lists', 'ghl_smart_list_contacts']));
    const viaKey = await m.rpc('ghl_smart_lists');
    expect(viaKey.error).toBe(false);
    expect((viaKey.json as any[]).map((l) => l.id)).not.toContain(priv.id);
    const top = (viaKey.json as any[]).find((l) => l.name === 'Top-Umsatz');
    const contacts = await m.rpc('ghl_smart_list_contacts', { list_id: top.id, limit: 2 });
    expect(contacts.json.total).toBe(4);
    expect(contacts.json.contacts.map((c: any) => c.name)).toEqual(['Gross', 'Mittel']);
    expect((await m.rpc('ghl_smart_list_contacts', { list_id: priv.id })).error).toBe(true);
    // A key cannot make a private list (it has nobody to belong to).
    const key = (await r.t.api.post('/api/api-keys', { name: 'Listen' })).data.key;
    const asKey = (body: unknown) => r.t.api.raw('/api/smart-lists', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-location-id': r.loc }, body: JSON.stringify(body) });
    expect((await asKey({ name: 'x', visibility: 'private' })).status).toBe(400);
    const made = await (await asKey({ name: 'Per Schlüssel' })).json();
    expect(made).toMatchObject({ visibility: 'shared', owner_id: null, can_edit: true });
  });
});

describe('smart lists – another person\'s private list is "not found" everywhere', () => {
  it('dialer, campaigns, sequences, surveys, ad audiences and tag references refuse it; the owner may use it', async () => {
    // Bob may use every area (the rig gives the sales areas only).
    expect((await r.admin('PATCH', `/api/users/${r.ids.bob}`, { permissions: null })).status).toBe(200);
    expect((await r.admin('PATCH', `/api/users/${r.ids.alice}`, { permissions: null })).status).toBe(200);
    const priv = (await r.alice('POST', '/api/smart-lists', { name: 'Alice intern', filter: { tags: ['vertrieb'] }, visibility: 'private' })).data.id as string;
    const shared = (await r.alice('POST', '/api/smart-lists', { name: 'Vertrieb geteilt', filter: { tags: ['vertrieb'] } })).data.id as string;

    // Power dialer
    const dial = (call: Rig['alice'], sid: string) => call('POST', '/api/dialer/lists', { name: 'Anrufen', source: 'smart_list', smart_list_id: sid });
    const bobDial = await dial(r.bob, priv);
    expect(bobDial.status).toBe(400);
    expect(JSON.stringify(bobDial.data)).toContain('Smart List nicht gefunden');
    expect((await dial(r.bob, shared)).status).toBe(200);
    const aliceDial = await dial(r.alice, priv);
    expect(aliceDial.status, JSON.stringify(aliceDial.data)).toBe(200);
    expect(aliceDial.data.smart_list_name).toBe('Alice intern');
    // Bob sees Alice's dialer list, but not her private list behind it, and cannot refresh it from there.
    const seen = (await r.bob('GET', '/api/dialer/lists')).data.find((l: any) => l.id === aliceDial.data.id);
    expect(seen.smart_list_name).toBe('(gelöscht)');
    expect((await r.bob('POST', `/api/dialer/lists/${aliceDial.data.id}/sync`)).status).toBe(404);
    expect((await r.alice('POST', `/api/dialer/lists/${aliceDial.data.id}/sync`)).status).toBe(200);

    // Campaigns: create, change, count the audience, send
    const camp = (call: Rig['alice'], sid: string) => call('POST', '/api/campaigns', { name: 'Herbst', channel: 'email', subject: 'Hallo', body: 'Text', filter: { smart_list_id: sid } });
    expect((await camp(r.bob, priv)).status).toBe(400);
    const bobCamp = await camp(r.bob, shared);
    expect(bobCamp.status, JSON.stringify(bobCamp.data)).toBe(200);
    expect((await r.bob('PATCH', `/api/campaigns/${bobCamp.data.id}`, { filter: { smart_list_id: priv } })).status).toBe(400);
    expect((await r.bob('POST', `/api/campaigns/${bobCamp.data.id}/audience`, { filter: { smart_list_id: priv }, channel: 'email' })).status).toBe(400);
    const aliceCamp = await camp(r.alice, priv);
    expect(aliceCamp.status).toBe(200);
    expect((await r.alice('GET', `/api/campaigns/${aliceCamp.data.id}`)).data.audience).toBe(3);
    // Bob opening Alice's draft counts nobody from her private list – and he cannot send it.
    expect((await r.bob('GET', `/api/campaigns/${aliceCamp.data.id}`)).data.audience).toBe(0);
    expect((await r.bob('POST', `/api/campaigns/${aliceCamp.data.id}/send`, {})).status).toBe(400);

    // Sequences, NPS surveys, ad audiences
    const seq = (await r.admin('POST', '/api/sequences', { name: 'Nachfassen', steps: [{ type: 'email', subject: 'Hi', body: 'Hallo', delay_days: 0 }] })).data;
    expect(seq.id, JSON.stringify(seq)).toBeTruthy();
    const enr = await r.bob('POST', `/api/sequences/${seq.id}/enroll`, { smart_list_id: priv });
    expect(enr.status).toBe(404);
    expect(JSON.stringify(enr.data)).toContain('Die Liste gibt es nicht');
    // The shared list gets past the list check (the draft sequence itself may still refuse to start).
    expect(JSON.stringify((await r.bob('POST', `/api/sequences/${seq.id}/enroll`, { smart_list_id: shared })).data)).not.toContain('Die Liste gibt es nicht');
    expect((await r.bob('POST', '/api/surveys/nps', { name: 'NPS', smart_list_id: priv })).status).toBe(400);
    expect((await r.alice('POST', '/api/surveys/nps', { name: 'NPS', smart_list_id: priv })).status).toBe(200);
    expect((await r.bob('GET', `/api/ads/audiences/preview?smart_list_id=${priv}`)).status).toBe(404);
    expect((await r.alice('GET', `/api/ads/audiences/preview?smart_list_id=${priv}`)).status).toBe(200);

    // Tag usage names only the lists the person may load.
    const usage = async (call: Rig['alice']) => ((await call('GET', '/api/tags/usage')).data.tags as any[]).find((t) => t.name === 'vertrieb').smart_lists.map((l: any) => l.id);
    expect(await usage(r.alice)).toContain(priv);
    expect(await usage(r.bob)).not.toContain(priv);
    expect(await usage(r.bob)).toContain(shared);
  });

  it('a deleted list in a campaign selects nobody, never everybody', async () => {
    const l = (await r.admin('POST', '/api/smart-lists', { name: 'Gleich weg', filter: { tags: ['sortierung'] } })).data.id as string;
    const c = (await r.admin('POST', '/api/campaigns', { name: 'Weg', channel: 'email', subject: 'x', body: 'y', filter: { smart_list_id: l } })).data;
    expect((await r.admin('GET', `/api/campaigns/${c.id}`)).data.audience).toBe(4);
    await r.admin('DELETE', `/api/smart-lists/${l}`);
    expect((await r.admin('GET', `/api/campaigns/${c.id}`)).data.audience).toBe(0);
  });
});
