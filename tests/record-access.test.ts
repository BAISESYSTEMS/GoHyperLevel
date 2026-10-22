import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from './security-fixtures.js';
import { MARK, OWN, rig, setAccess, type Rig } from './record-access-fixtures.js';

let r: Rig;
let phone: ReturnType<typeof client>;

beforeAll(async () => {
  r = await rig();
  const tok = (await r.alice('POST', '/api/mobile/pair', { device_name: 'Alice phone' })).data.token;
  phone = client(r.t.base, { authorization: `Bearer ${tok}`, 'x-location-id': r.loc });
}, 120_000);
afterAll(async () => {
  await r?.t.close();
});

const names = (list: any[], key = 'name') => list.map((x) => x[key] ?? x.first_name ?? x.title ?? x.contact_name).sort();
// Every call starts from a clean slate: the default rule, no rule for a person.
const turnOn = (rules: Record<string, any> = {}, extra: Record<string, unknown> = {}) =>
  setAccess(r, { enabled: true, rules: { default: { levels: OWN }, ...rules, users: { [r.ids.alice]: null, [r.ids.bob]: null, [r.ids.carol]: null, ...(rules.users ?? {}) } }, ...extra });
const turnOff = () => setAccess(r, { enabled: false });

describe('record access – defaults', () => {
  it('is off by default: everybody sees everything', async () => {
    const me = await r.alice('GET', '/api/sales/access/me');
    expect(me.data).toMatchObject({ restricted: false, enabled: false });
    const list = await r.alice('GET', '/api/contacts?limit=100');
    expect(list.data.total).toBe(4);
    expect(list.text).toContain(MARK);
    expect((await r.alice('PATCH', `/api/opportunities/${r.rec.deal_b}`, { name: `${MARK} Deal` })).status).toBe(200);
  });

  it('stays at "alle" until a rule narrows something', async () => {
    expect((await setAccess(r, { enabled: true })).status).toBe(200);
    expect((await r.alice('GET', '/api/sales/access/me')).data.restricted).toBe(false);
    expect((await r.alice('GET', '/api/contacts?limit=100')).data.total).toBe(4);
    await turnOff();
  });

  it('only admins (or unrestricted members with the settings area) change the rules', async () => {
    expect((await r.alice('PUT', '/api/sales/access', { enabled: true })).status).toBe(403);
    expect((await r.alice('POST', '/api/sales/teams', { name: 'X' })).status).toBe(403);
  });
});

describe('record access – own only', () => {
  beforeAll(async () => {
    expect((await turnOn()).status).toBe(200);
  });
  afterAll(async () => void (await turnOff()));

  it('lists only the person’s own records (unassigned ones stay visible: the pool)', async () => {
    const c = await r.alice('GET', '/api/contacts?limit=100');
    expect(names(c.data.contacts, 'first_name')).toEqual(['AlphaKontakt', 'Niemand']);
    expect(c.data.total).toBe(2);
    expect(c.text).not.toContain(MARK);
    const d = await r.alice('GET', '/api/opportunities?status=all');
    expect(names(d.data)).toEqual(['Alpha Deal', 'Pool Deal']);
    const t = await r.alice('GET', '/api/tasks?status=all');
    expect(names(t.data, 'title')).toEqual(['Alpha Aufgabe', 'Pool Aufgabe']);
    const co = await r.alice('GET', '/api/companies');
    expect(co.data.companies.map((x: any) => x.name)).toEqual(['Alpha Firma']);
    const v = await r.alice('GET', '/api/conversations');
    expect(v.data.map((x: any) => x.first_name)).toEqual(['AlphaKontakt']);
    expect((await r.alice('GET', '/api/pipelines')).data.find((p: any) => p.id === r.pipeline).open_count).toBe(2);
  });

  it('hides the pool when the sub-account says so', async () => {
    await setAccess(r, { unassigned: 'hide' });
    expect(names((await r.alice('GET', '/api/contacts?limit=100')).data.contacts, 'first_name')).toEqual(['AlphaKontakt']);
    expect(names((await r.alice('GET', '/api/opportunities?status=all')).data)).toEqual(['Alpha Deal']);
    await setAccess(r, { unassigned: 'show' });
  });

  it('answers 404 for somebody else’s record on every route that names it', async () => {
    const b = r.rec;
    const gone: [string, string, unknown?][] = [
      ['GET', `/api/contacts/${b.contact_b}`],
      ['PATCH', `/api/contacts/${b.contact_b}`, { first_name: 'x' }],
      ['DELETE', `/api/contacts/${b.contact_b}`],
      ['POST', `/api/contacts/${b.contact_b}/notes`, { body: 'x' }],
      ['POST', `/api/contacts/${b.contact_b}/tags`, { add: ['x'] }],
      ['GET', `/api/contacts/${b.contact_b}/messages`],
      ['GET', `/api/contacts/${b.contact_b}/privacy-export`],
      ['PATCH', `/api/opportunities/${b.deal_b}`, { name: 'x' }],
      ['DELETE', `/api/opportunities/${b.deal_b}`],
      ['PATCH', `/api/tasks/${b.task_b}`, { done: true }],
      ['DELETE', `/api/tasks/${b.task_b}`],
      ['GET', `/api/companies/${b.company_b}`],
      ['PATCH', `/api/companies/${b.company_b}`, { name: 'x' }],
      ['DELETE', `/api/companies/${b.company_b}`],
      ['GET', `/api/companies/${b.company_b}/activities`],
      ['GET', `/api/conversations/${b.conversation_b}/messages`],
      ['PATCH', `/api/conversations/${b.conversation_b}`, { starred: true }],
      ['DELETE', `/api/notes/${b.note_b}`],
      ['DELETE', `/api/messages/${b.message_b}`],
      ['POST', '/api/tasks', { title: 'x', contact_id: b.contact_b }],
      ['POST', '/api/messages', { contact_id: b.contact_b, channel: 'email', subject: 'x', body: 'x' }],
      ['POST', '/api/opportunities', { pipeline_id: r.pipeline, contact_id: b.contact_b, name: 'x' }],
      ['GET', `/api/opportunities?contact_id=${b.contact_b}`],
    ];
    const wrong: string[] = [];
    for (const [m, p, body] of gone) {
      const res = await r.alice(m, p, body);
      if (res.status !== 404 || res.text.includes(MARK)) wrong.push(`${m} ${p} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
    // …and nothing of Bob's changed.
    expect(r.t.app.db.get('SELECT first_name, assigned_to FROM contacts WHERE id = ?', b.contact_b)).toMatchObject({ first_name: `${MARK}Kontakt`, assigned_to: r.ids.bob });
    expect(r.t.app.db.get('SELECT done FROM tasks WHERE id = ?', b.task_b)?.done).toBe(0);
  });

  it('opens her own records as before', async () => {
    const b = r.rec;
    expect((await r.alice('GET', `/api/contacts/${b.contact_a}`)).data.first_name).toBe('AlphaKontakt');
    expect((await r.alice('PATCH', `/api/opportunities/${b.deal_a}`, { name: 'Alpha Deal 2' })).status).toBe(200);
    expect((await r.alice('PATCH', `/api/tasks/${b.task_a}`, { done: true })).status).toBe(200);
    expect((await r.alice('GET', `/api/companies/${b.company_a}`)).status).toBe(200);
    expect((await r.alice('GET', `/api/conversations/${b.conversation_a}/messages`)).status).toBe(200);
    // a record without an owner can be opened (and claimed)
    expect((await r.alice('GET', `/api/contacts/${b.contact_u}`)).status).toBe(200);
  });

  it('bulk actions only touch what she may open', async () => {
    const b = r.rec;
    const res = await r.alice('POST', '/api/contacts/bulk', { ids: [b.contact_a, b.contact_b, b.contact_c], action: 'add_tag', tag: 'bulk-test' });
    expect(res.data.count).toBe(1);
    expect(r.t.app.db.get('SELECT tags FROM contacts WHERE id = ?', b.contact_b)?.tags).not.toContain('bulk-test');
  });

  it('search, activity feed, dashboard and reports follow the rules', async () => {
    const s = await r.alice('GET', `/api/search?q=${encodeURIComponent('Kontakt')}`);
    expect(s.data.contacts.map((c: any) => c.first_name)).toEqual(['AlphaKontakt']);
    expect(JSON.stringify((await r.alice('GET', '/api/search?q=Deal')).data)).not.toContain('Vertrieb');
    expect((await r.alice('GET', '/api/search?q=Deal')).data.opportunities.map((o: any) => o.name).sort()).toEqual(['Alpha Deal 2', 'Pool Deal']);
    const feed = await r.alice('GET', '/api/activities?limit=200');
    expect(feed.text).not.toContain(MARK);
    const dash = await r.alice('GET', '/api/dashboard');
    expect(dash.data.contacts.total).toBe(2);
    expect(dash.data.opportunities.open).toBe(2);
    expect(dash.data.opportunities.openValue).toBe(1050);
    expect(dash.data.tasks.open).toBeLessThanOrEqual(2);
    const adminDash = await r.admin('GET', '/api/dashboard');
    expect(adminDash.data.contacts.total).toBe(4);
    expect(adminDash.data.opportunities.openValue).toBe(1000 + 7777 + 1000 + 50);
    const report = await r.alice('POST', '/api/reports/run', { query: { source: 'contacts', measures: ['count'], date_field: 'created_at', range: 'all' } });
    expect(report.status, report.text).toBe(200);
    expect(report.data.totals.v[0]).toBe(2);
    const dealsReport = await r.alice('POST', '/api/reports/run', { query: { source: 'opportunities', measures: ['sum:value'], date_field: 'created_at', range: 'all' } });
    expect(dealsReport.status, dealsReport.text).toBe(200);
    expect(dealsReport.data.totals.v[0]).toBe(1050);
    const adminReport = await r.admin('POST', '/api/reports/run', { query: { source: 'contacts', measures: ['count'], date_field: 'created_at', range: 'all' } });
    expect(adminReport.data.totals.v[0]).toBe(4);
  });

  it('the CSV export contains her contacts only', async () => {
    const csv = await r.alice('GET', '/api/contacts/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('AlphaKontakt');
    expect(csv.text).not.toContain(MARK);
    const companies = await r.alice('GET', '/api/companies/export.csv');
    expect(companies.text).toContain('Alpha Firma');
    expect(companies.text).not.toContain(MARK);
    expect((await r.admin('GET', '/api/contacts/export.csv')).text).toContain(MARK);
  });

  it('the app (device token) sees the same: lists, counters and details', async () => {
    const out = [
      (await phone('GET', '/api/mobile/contacts?limit=50')).text,
      (await phone('GET', '/api/mobile/deals')).text,
      (await phone('GET', '/api/mobile/tasks?limit=50')).text,
      (await phone('GET', '/api/mobile/inbox?limit=50')).text,
      (await phone('GET', `/api/mobile/conversations/${r.rec.conversation_b}`)).text,
    ];
    for (const text of out) expect(text).not.toContain(MARK);
    expect((await phone('GET', `/api/mobile/conversations/${r.rec.conversation_b}`)).status).toBe(404);
    expect(JSON.parse((await phone('GET', '/api/mobile/contacts?limit=50')).text).map((c: any) => c.first_name)).toEqual(expect.arrayContaining(['AlphaKontakt']));
    const summary = (await phone('GET', '/api/mobile/summary')).data;
    expect(summary.open_deals_count).toBe(2);
    expect(summary.open_deals_value_cents).toBe(105_000);
    // the relayed writes go through the same checks
    expect((await phone('POST', `/api/mobile/tasks/${r.rec.task_b}/complete`)).status).toBe(404);
    expect((await phone('POST', `/api/mobile/deals/${r.rec.deal_b}/status`, { status: 'won' })).status).toBe(404);
    expect((await phone('POST', '/api/mobile/notes', { contact_id: r.rec.contact_b, body: 'x' })).status).toBe(404);
  });

  it('keys and the MCP endpoint are the sub-account’s, not a person: they see everything', async () => {
    const key = (await r.admin('POST', '/api/api-keys', { name: 'sync' })).data.key;
    const viaKey = client(r.t.base, { authorization: `Bearer ${key}`, 'x-location-id': r.loc });
    expect((await viaKey('GET', '/api/contacts?limit=100')).data.total).toBe(4);
    const mcp = client(r.t.base, { authorization: `Bearer ${key}` });
    const call = await mcp('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_search_contacts', arguments: { location_id: r.loc, query: MARK } } });
    expect(JSON.stringify(call.data)).toContain(MARK);
  });

  it('a restricted person cannot mint such a key or export around the rules', async () => {
    expect((await r.alice('POST', '/api/api-keys', { name: 'mine' })).status).toBe(403);
    expect((await r.alice('POST', '/api/webhooks', { url: 'https://example.com/x', events: ['contact.created'] })).status).toBe(403);
    expect((await r.alice('POST', '/api/sheets/export', {})).status).toBe(403);
    expect((await r.alice('POST', '/api/contacts/import', { csv: 'email\nx@example.com' })).status).toBe(403);
  });

  it('what she creates belongs to her; a duplicate of somebody else’s contact is refused', async () => {
    const made = await r.alice('POST', '/api/contacts', { first_name: 'Neu', email: 'neu@example.com' });
    expect(made.status).toBe(200);
    expect(made.data.assigned_to).toBe(r.ids.alice);
    expect(r.t.app.db.get('SELECT assigned_to FROM contacts WHERE id = ?', made.data.id)?.assigned_to).toBe(r.ids.alice);
    const dup = await r.alice('POST', '/api/contacts', { first_name: 'Doppelt', email: `${MARK.toLowerCase()}@example.com` });
    expect(dup.status).toBe(409);
    expect(dup.text).not.toContain(MARK);
    const deal = await r.alice('POST', '/api/opportunities', { pipeline_id: r.pipeline, contact_id: made.data.id, name: 'Neuer Deal', value: 5 });
    expect(deal.data.assigned_to).toBe(r.ids.alice);
    const viaDeal = await r.alice('POST', '/api/opportunities', { pipeline_id: r.pipeline, contact: { first_name: 'X', email: `${MARK.toLowerCase()}@example.com` }, name: 'Klau' });
    expect(viaDeal.status).toBe(409);
    const task = await r.alice('POST', '/api/tasks', { title: 'Meine' });
    expect(task.data.assigned_to).toBe(r.ids.alice);
    await r.admin('DELETE', `/api/contacts/${made.data.id}`);
  });
});

describe('record access – teams, rules per person, hidden fields', () => {
  afterAll(async () => void (await turnOff()));

  it('"Team" shows the records of everybody who shares a team', async () => {
    const team = await r.admin('POST', '/api/sales/teams', { name: 'Nord', members: [{ user_id: r.ids.alice, role: 'lead' }, { user_id: r.ids.carol }] });
    expect(team.status, team.text).toBe(200);
    expect(team.data.members.map((m: any) => m.name).sort()).toEqual(['Alice Vertrieb', 'Carol Vertrieb']);
    expect((await turnOn({ default: { levels: Object.fromEntries(Object.keys(OWN).map((e) => [e, 'team'])) } })).status).toBe(200);
    const c = await r.alice('GET', '/api/contacts?limit=100');
    expect(names(c.data.contacts, 'first_name')).toEqual(['AlphaKontakt', 'CharlieKontakt', 'Niemand']);
    expect(c.text).not.toContain(MARK);
    expect((await r.alice('PATCH', `/api/opportunities/${r.rec.deal_c}`, { name: 'Charlie Deal' })).status).toBe(200);
    expect((await r.alice('PATCH', `/api/opportunities/${r.rec.deal_b}`, { name: 'x' })).status).toBe(404);
    // somebody outside every team falls back to "own"
    expect(names((await r.bob('GET', '/api/contacts?limit=100')).data.contacts, 'first_name')).toEqual([`${MARK}Kontakt`, 'Niemand']);
  });

  it('a rule for the person beats the team and the default; the most generous team wins', async () => {
    const teams = (await r.admin('GET', '/api/sales/teams')).data;
    const nord = teams.find((t: any) => t.name === 'Nord').id;
    await turnOn({ default: { levels: OWN }, users: { [r.ids.alice]: { levels: { contacts: 'all' } } } });
    expect((await r.alice('GET', '/api/contacts?limit=100')).data.total).toBe(4);
    expect(names((await r.alice('GET', '/api/opportunities?status=all')).data)).toEqual(['Alpha Deal 2', 'Pool Deal']);
    await turnOn({ default: { levels: OWN }, teams: { [nord]: { levels: { deals: 'all' } } }, users: { [r.ids.alice]: null } });
    expect((await r.alice('GET', '/api/opportunities?status=all')).data.length).toBe(4);
    expect((await r.alice('GET', '/api/contacts?limit=100')).data.total).toBe(2);
  });

  it('a team rule that only sets a level keeps the default’s hidden fields; a team that names its own list decides', async () => {
    const nord = (await r.admin('GET', '/api/sales/teams')).data.find((t: any) => t.name === 'Nord').id;
    const hiddenContacts = async () => [...((await r.alice('GET', '/api/sales/access/me')).data.hidden.contacts ?? [])].sort();
    await turnOn({ default: { levels: OWN, hidden: { contacts: ['email', 'phone'] } }, teams: { [nord]: { levels: { deals: 'all' } } } });
    expect(await hiddenContacts()).toEqual(['email', 'phone']);
    await turnOn({ default: { levels: OWN, hidden: { contacts: ['email', 'phone'] } }, teams: { [nord]: { levels: { deals: 'all' }, hidden: { contacts: ['phone'] } } } });
    expect(await hiddenContacts()).toEqual(['phone']);
    await turnOn({ default: { levels: OWN }, teams: { [nord]: null } });
  });

  it('hides sensitive fields everywhere a person looks – and refuses to write them blind', async () => {
    await turnOn(
      { default: { levels: {}, hidden: { contacts: ['email', 'phone', 'address'], deals: ['value'], tasks: ['description'], companies: ['phone'] } } },
      {},
    );
    const c = await r.alice('GET', '/api/contacts?limit=100');
    const mine = c.data.contacts.find((x: any) => x.first_name === 'AlphaKontakt');
    expect(mine.email).toBe('');
    expect(mine.phone).toBe('');
    expect(mine.city).toBe('');
    expect(mine.hidden_fields).toEqual(expect.arrayContaining(['email', 'phone']));
    expect(mine.first_name).toBe('AlphaKontakt');
    const one = await r.alice('GET', `/api/contacts/${r.rec.contact_a}`);
    expect(one.data.email).toBe('');
    expect((await r.alice('GET', '/api/search?q=Kontakt')).data.contacts[0].email).toBe('');
    expect((await r.alice('GET', '/api/conversations')).data[0].email).toBe('');
    expect((await r.alice('GET', '/api/opportunities?status=all')).data.every((d: any) => d.value === 0 && d.email === '')).toBe(true);
    expect((await r.alice('GET', '/api/tasks?status=all')).data.every((t: any) => t.description === '')).toBe(true);
    expect((await r.alice('PATCH', `/api/contacts/${r.rec.contact_a}`, { email: 'neu@example.com' })).status).toBe(403);
    expect((await r.alice('PATCH', `/api/opportunities/${r.rec.deal_a}`, { value: 1 })).status).toBe(403);
    expect((await r.alice('PATCH', `/api/contacts/${r.rec.contact_a}`, { first_name: 'Anna' })).status).toBe(200);
    expect(r.t.app.db.get('SELECT email FROM contacts WHERE id = ?', r.rec.contact_a)?.email).toBe('alpha@example.com');
    const csv = await r.alice('GET', '/api/contacts/export.csv');
    expect(csv.text).not.toContain('alpha@example.com');
    expect((await phone('GET', '/api/mobile/contacts?limit=50')).text).not.toContain('alpha@example.com');
    expect((await r.alice('POST', '/api/reports/run', { query: { source: 'opportunities', measures: ['sum:value'], date_field: 'created_at', range: 'all' } })).status).toBe(403);
    expect((await r.admin('GET', `/api/contacts/${r.rec.contact_a}`)).data.email).toBe('alpha@example.com');
    await r.admin('PATCH', `/api/contacts/${r.rec.contact_a}`, { first_name: 'AlphaKontakt' });
  });

  it('shows the person their own view', async () => {
    await turnOn({ default: { levels: { contacts: 'own' }, hidden: { contacts: ['email'] } } });
    const me = (await r.alice('GET', '/api/sales/access/me')).data;
    expect(me).toMatchObject({ restricted: true, enabled: true, levels: { contacts: 'own', deals: 'all' }, hidden: { contacts: ['email'] } });
    expect((await r.admin('GET', '/api/sales/access/me')).data.restricted).toBe(false);
  });

  it('a restricted member cannot change the rules, an unrestricted one with the settings area can', async () => {
    await turnOn({ default: { levels: { contacts: 'own' } } });
    expect((await r.alice('PUT', '/api/sales/access', { enabled: false })).status).toBe(403);
    expect((await r.bob('PUT', '/api/sales/access', { enabled: false })).status).toBe(403);
    await r.admin('PATCH', `/api/users/${r.ids.carol}`, { permissions: null });
    await turnOn({ default: { levels: {} }, users: { [r.ids.carol]: { levels: { contacts: 'all' } } } });
    expect((await r.carol('PUT', '/api/sales/access', { unassigned: 'show' })).status).toBe(200);
  });

  it('rules and teams of one sub-account never apply in another', async () => {
    const other = (await r.admin('POST', '/api/locations', { name: 'Zweite Firma' })).data.id as string;
    const res = await r.admin('GET', '/api/sales/access', undefined, { 'x-location-id': other });
    expect(res.data.enabled).toBe(false);
    expect(res.data.teams).toEqual([]);
    expect((await r.admin('PUT', '/api/sales/access', { rules: { users: { [r.ids.alice]: { levels: { contacts: 'own' } } } } }, { 'x-location-id': other })).status).toBe(400);
  });
});
