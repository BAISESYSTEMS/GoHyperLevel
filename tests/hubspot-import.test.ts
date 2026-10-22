import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HubSpotClient, dealStatus, mapPropertyType, propValue, stepsFor, stripHtml, toDay } from '../server/services/hubspot.js';
import { startTestApp } from './helpers.js';

const TOKEN = 'pat-eu1-11111111-2222-3333-4444-555555555555';

/** In-memory HubSpot API v3 (only what the importer calls). Never talks to the network. */
class FakeHubSpot {
  requests: { method: string; path: string; query: URLSearchParams; body: any }[] = [];
  /** Answer the next N requests for a path prefix with 429 (Retry-After: 2). */
  throttle = new Map<string, number>();
  failing = new Set<string>();
  forbidden = new Set<string>(['/crm/v3/objects/tickets']);
  owners = [
    { id: 'o1', email: 'CHEF@example.com', firstName: 'Chef', lastName: 'Admin' },
    { id: 'o2', email: 'extern@example.com', firstName: 'Ex', lastName: 'Tern' },
  ];
  properties = [
    { name: 'firstname', label: 'Vorname', type: 'string', fieldType: 'text', hubspotDefined: true },
    { name: 'email', label: 'E-Mail', type: 'string', fieldType: 'text', hubspotDefined: true },
    { name: 'lifecyclestage', label: 'Lifecycle stage', type: 'enumeration', fieldType: 'radio', hubspotDefined: true, options: [{ label: 'Kunde', value: 'customer' }, { label: 'Lead', value: 'lead' }] },
    { name: 'budget', label: 'Budget', type: 'number', fieldType: 'number', hubspotDefined: false },
    { name: 'interessen', label: 'Interessen', type: 'enumeration', fieldType: 'checkbox', hubspotDefined: false, options: [{ label: 'SEO', value: 'seo' }, { label: 'Ads', value: 'ads' }] },
    { name: 'hs_calc', label: 'Calc', type: 'number', fieldType: 'calculation_equation', hubspotDefined: false, calculated: true },
  ];
  companies = [{ id: 'c100', properties: { name: 'Muster GmbH', domain: 'muster.de', city: 'Berlin' } }];
  contacts = [
    { id: '101', properties: { firstname: 'Anna', lastname: 'Alt', email: 'anna@example.com', phone: '030 1234567', hubspot_owner_id: 'o1', budget: '5000', interessen: 'seo;ads', lifecyclestage: 'customer', createdate: '2024-01-05T10:00:00.000Z' }, associations: { companies: { results: [{ id: 'c100', type: 'contact_to_company' }] } } },
    { id: '102', properties: { firstname: 'Ben', lastname: 'Bau', email: 'ben@example.com', mobilephone: '+4917612345678', lifecyclestage: 'lead' } },
    { id: '103', properties: { firstname: 'Cleo', email: 'cleo@example.com', company: 'Eigene AG' } },
  ];
  lists = [{ listId: '7', name: 'Newsletter', objectTypeId: '0-1' }, { listId: '8', name: 'Firmenliste', objectTypeId: '0-2' }];
  memberships: Record<string, string[]> = { '7': ['101', '103', '999'] };
  pipelines = [
    {
      id: 'default',
      label: 'Sales Pipeline',
      stages: [
        { id: 'appointmentscheduled', label: 'Termin', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.2' } },
        { id: 'closedwon', label: 'Gewonnen', displayOrder: 2, metadata: { isClosed: 'true', probability: '1.0' } },
        { id: 'closedlost', label: 'Verloren', displayOrder: 3, metadata: { isClosed: 'true', probability: '0.0' } },
      ],
    },
  ];
  deals = [
    { id: 'd1', properties: { dealname: 'Website', amount: '4500.40', dealstage: 'closedwon', pipeline: 'default', hubspot_owner_id: 'o1' }, associations: { contacts: { results: [{ id: '101' }] } } },
    { id: 'd2', properties: { dealname: 'SEO', amount: '900', dealstage: 'appointmentscheduled', pipeline: 'default' }, associations: { contacts: { results: [{ id: '102' }] } } },
    { id: 'd3', properties: { dealname: 'Ohne Kontakt', amount: '1', dealstage: 'closedlost', pipeline: 'default' } },
  ];
  notes = [{ id: 'n1', properties: { hs_note_body: '<p>Erstes <b>Gespräch</b></p><p>gut&nbsp;gelaufen</p>', hs_timestamp: '2024-02-01T09:00:00.000Z' }, associations: { contacts: { results: [{ id: '101' }] } } }];
  tasks = [
    { id: 't1', properties: { hs_task_subject: 'Angebot schicken', hs_task_status: 'COMPLETED', hs_timestamp: '2024-02-02T09:00:00.000Z', hubspot_owner_id: 'o1' }, associations: { contacts: { results: [{ id: '101' }] } } },
    { id: 't2', properties: { hs_task_subject: 'Nachfassen', hs_task_status: 'NOT_STARTED', hs_timestamp: '2024-03-01T09:00:00.000Z' } },
  ];
  calls = [{ id: 'k1', properties: { hs_call_title: 'Erstgespräch', hs_call_body: 'Interesse an SEO', hs_call_direction: 'OUTBOUND', hs_timestamp: '2024-01-20T10:00:00.000Z' }, associations: { contacts: { results: [{ id: '102' }] } } }];
  emails = [{ id: 'e1', properties: { hs_email_subject: 'Angebot', hs_email_text: 'Anbei…', hs_timestamp: '2024-01-21T10:00:00.000Z' }, associations: { contacts: { results: [{ id: '101' }] } } }];
  meetings: any[] = [];
  tickets = [{ id: 'x1', properties: { subject: 'Login geht nicht', content: '<p>Hilfe</p>', hs_pipeline: '0', hs_pipeline_stage: '1', hs_ticket_priority: 'HIGH' }, associations: { contacts: { results: [{ id: '103' }] } } }];

  fetch = async (input: any, init: any = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path: url.pathname, query: url.searchParams, body });
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (init.headers?.authorization !== `Bearer ${TOKEN}`) return json(401, { status: 'error', message: 'Authentication credentials not found' });
    for (const [prefix, n] of this.throttle) {
      if (url.pathname.startsWith(prefix) && n > 0) {
        this.throttle.set(prefix, n - 1);
        return json(429, { status: 'error', message: 'You have reached your secondly limit.', errorType: 'RATE_LIMIT' }, { 'retry-after': '2' });
      }
    }
    for (const p of this.failing) if (url.pathname.startsWith(p)) return json(502, { message: 'Bad gateway' });
    for (const p of this.forbidden) if (url.pathname.startsWith(p)) return json(403, { status: 'error', category: 'MISSING_SCOPES', message: 'This app hasn\'t been granted all required scopes' });
    const page = (list: any[], size = Number(url.searchParams.get('limit') ?? 100)) => {
      const after = Number(url.searchParams.get('after') ?? 0);
      const slice = list.slice(after, after + size);
      return json(200, { results: slice, ...(after + size < list.length ? { paging: { next: { after: String(after + size) } } } : {}) });
    };
    const p = url.pathname;
    if (p === '/account-info/v3/details') return json(200, { portalId: 4711, uiDomain: 'app-eu1.hubspot.com', timeZone: 'Europe/Berlin', companyCurrency: 'EUR' });
    if (p === '/crm/v3/owners') return page(this.owners);
    if (p === '/crm/v3/properties/contacts') return json(200, { results: this.properties });
    if (p === '/crm/v3/pipelines/deals') return json(200, { results: this.pipelines });
    if (p === '/crm/v3/pipelines/tickets') return json(200, { results: [{ id: '0', label: 'Support', stages: [{ id: '1', label: 'Neu' }] }] });
    if (p === '/crm/v3/lists/search') return json(200, { lists: this.lists, hasMore: false, offset: this.lists.length, total: this.lists.length });
    const mem = p.match(/^\/crm\/v3\/lists\/(\w+)\/memberships$/);
    if (mem) return page((this.memberships[mem[1]] ?? []).map((id) => ({ recordId: id })), 2);
    const search = p.match(/^\/crm\/v3\/objects\/(\w+)\/search$/);
    if (search) return json(200, { total: ((this as any)[search[1]] ?? []).length, results: [] });
    const objects = p.match(/^\/crm\/v3\/objects\/(\w+)$/);
    if (objects && Array.isArray((this as any)[objects[1]])) return page((this as any)[objects[1]], objects[1] === 'contacts' ? 2 : 100);
    return json(404, { message: `not found ${p}` });
  };
  hits = (path: string) => this.requests.filter((r) => r.path === path).length;
}

describe('hubspot: pure mapping', () => {
  it('maps property types, values, deal status and html', () => {
    expect(mapPropertyType({ type: 'number' })).toBe('number');
    expect(mapPropertyType({ type: 'enumeration', fieldType: 'checkbox' })).toBe('checkbox');
    expect(mapPropertyType({ type: 'enumeration', fieldType: 'select' })).toBe('select');
    expect(mapPropertyType({ type: 'string', fieldType: 'textarea' })).toBe('textarea');
    expect(mapPropertyType({ type: 'datetime' })).toBe('date');
    expect(propValue({ type: 'enumeration', options: [{ label: 'SEO', value: 'seo' }, { label: 'Ads', value: 'ads' }] }, 'seo;ads')).toBe('SEO, Ads');
    expect(propValue({ type: 'bool' }, 'true')).toBe('ja');
    expect(toDay('1704448800000')).toBe('2024-01-05');
    expect(toDay('2024-03-01')).toBe('2024-03-01');
    expect(dealStatus({ hs_is_closed_won: 'true' })).toBe('won');
    expect(dealStatus({}, { metadata: { isClosed: 'true', probability: '0.0' } })).toBe('lost');
    expect(dealStatus({}, { metadata: { isClosed: 'false', probability: '0.4' } })).toBe('open');
    expect(stripHtml('<p>A&amp;B</p><p>C<br>D</p>')).toBe('A&B\nC\nD');
    expect(stepsFor(['deals', 'contacts'])).toEqual(['properties', 'contacts', 'pipelines', 'deals']);
  });

  it('backs off on 429 using Retry-After, then exponentially on 5xx', async () => {
    const waits: number[] = [];
    let n = 0;
    const client = new HubSpotClient('t', {
      sleep: async (ms) => void waits.push(ms),
      fetch: (async () => {
        n++;
        if (n === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '3' } });
        if (n <= 3) return new Response('{}', { status: 503 });
        return new Response('{"ok":true}', { status: 200 });
      }) as any,
    });
    expect(await client.req('GET', '/x')).toEqual({ ok: true });
    expect(waits).toEqual([3000, 2000, 4000]);
    const dead = new HubSpotClient('t', { sleep: async () => {}, maxRetries: 2, fetch: (async () => new Response('{}', { status: 429 })) as any });
    await expect(dead.req('GET', '/x')).rejects.toThrow('HubSpot-Limit');
  });
});

describe('hubspot: import end to end (mocked HubSpot)', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const hs = new FakeHubSpot();
  const waits: number[] = [];
  let loc = '';
  let adminId = '';
  const settle = async () => {
    await t.app.services.hubspotRunning;
    await new Promise((r) => setTimeout(r, 5));
  };
  const count = (sql: string, ...p: any[]) => Number(t.app.db.get(sql, ...p)?.n ?? 0);
  let helpdeskImport: any;

  beforeAll(async () => {
    t = await startTestApp();
    const me = await t.setup();
    adminId = me.user.id;
    loc = t.api.location;
    // Waiting is recorded, not done (a few ms so a running import is observable).
    Object.assign(t.app.services, { hubspotFetch: hs.fetch, hubspotSleep: (ms: number) => (waits.push(ms), new Promise((r) => setTimeout(r, 15))), hubspotPauseMs: 0 });
    // The first runs describe a setup without a helpdesk; the real tickets importer comes back at the end.
    helpdeskImport = t.app.services.ticketsImport;
    delete t.app.services.ticketsImport;
  });
  afterAll(async () => t.close());

  it('stores the private app token sealed and never returns it', async () => {
    expect((await t.api.post('/api/import/hubspot/dry-run', {})).status).toBe(400);
    expect((await t.api.put('/api/import/hubspot/connection', { token: 'pat-falsch' })).data.error).toContain('ungültig');
    const r = await t.api.put('/api/import/hubspot/connection', { token: TOKEN });
    expect(r.data).toMatchObject({ connected: true, portal_id: '4711', token_hint: '…5555', currency: 'EUR' });
    const row = t.app.db.get('SELECT * FROM hubspot_connections WHERE location_id = ?', loc);
    expect(row.token_sealed).not.toContain(TOKEN);
    expect(row.token_sealed.startsWith('v1:')).toBe(true);
    const view = await t.api.get('/api/import/hubspot');
    expect(JSON.stringify(view.data)).not.toContain(TOKEN);
    expect(view.data.parts.map((p: any) => p.key)).toContain('tickets');
    // The companies module (modules/companies.ts) takes HubSpot companies; no helpdesk yet.
    expect(view.data.modules).toEqual({ companies: true, tickets: false });
    // API keys may not handle the token
    const key = (await t.api.post('/api/api-keys', { name: 'x' })).data.key;
    const viaKey = await t.api.raw('/api/import/hubspot/connection', { method: 'PUT', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    expect(viaKey.status).toBe(403);
  });

  it('checks a token with one short attempt: a dead HubSpot answers 502 quickly, without the import backoff', async () => {
    const before = waits.length;
    let calls = 0;
    const hang = (async (_url: URL, init: RequestInit) => {
      calls++;
      return new Promise<Response>((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)));
    }) as any;
    Object.assign(t.app.services, { hubspotFetch: hang, hubspotCheckTimeoutMs: 60 });
    try {
      const started = Date.now();
      const r = await t.api.put('/api/import/hubspot/connection', { token: 'pat-eu1-00000000-0000-0000-0000-000000009999' });
      expect(r.status).toBe(502);
      expect(r.data.error).toMatch(/HubSpot ist nicht erreichbar.*später/);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(calls).toBe(1);
      t.app.services.hubspotFetch = (async () => (calls++, new Response('{}', { status: 503 }))) as any;
      const down = await t.api.put('/api/import/hubspot/connection', { token: 'pat-eu1-00000000-0000-0000-0000-000000009999' });
      expect(down.status).toBe(502);
      expect(down.data.error).toContain('Fehler 503');
      expect(calls).toBe(2);
      expect(waits.length).toBe(before);
      // The stored connection is untouched.
      expect((await t.api.get('/api/import/hubspot')).data.connection).toMatchObject({ connected: true, token_hint: '…5555' });
    } finally {
      Object.assign(t.app.services, { hubspotFetch: hs.fetch, hubspotCheckTimeoutMs: undefined });
    }
  });

  it('dry run counts what is there and what is new', async () => {
    const r = await t.api.post('/api/import/hubspot/dry-run', { parts: ['owners', 'contacts', 'deals', 'tickets'] });
    expect(r.status).toBe(200);
    const rows = Object.fromEntries(r.data.result.map((x: any) => [x.object, x]));
    expect(rows.contacts).toMatchObject({ hubspot: 3, imported: 0, new: 3 });
    expect(rows.owners).toMatchObject({ hubspot: 2, new: 2 });
    expect(rows.pipelines).toMatchObject({ hubspot: 1 });
    expect(rows.deals).toMatchObject({ hubspot: 3 });
    expect(rows.tickets.label).toContain('kein Helpdesk-Modul');
    expect(rows.tickets.error).toContain('Berechtigung');
    expect((await t.api.get('/api/import/hubspot')).data.dry_run.id).toBe(r.data.id);
  });

  it('imports everything, mapping owners, properties, companies, lists, deals and history', async () => {
    hs.throttle.set('/crm/v3/objects/contacts', 2);
    const start = await t.api.post('/api/import/hubspot/start', {});
    expect(start.data.status).toBe('running');
    expect((await t.api.post('/api/import/hubspot/start', {})).status).toBe(400);
    await settle();
    const job = (await t.api.get(`/api/import/hubspot/jobs/${start.data.id}`)).data;
    expect(job.status).toBe('done');
    expect(job.progress.done_steps).toContain('contacts');
    expect(job.progress.counts).toMatchObject({ owners: 1, contacts: 3, companies: 1, lists: 1, list_members: 2, pipelines: 1, deals: 2, notes: 1, tasks: 2, calls: 1, emails: 1 });
    expect(job.progress.skipped).toMatchObject({ owners: 1, deals_no_contact: 1 });
    expect(job.progress.notes.join(' ')).toContain('Tickets übersprungen');
    expect(job.progress.notes.join(' ')).not.toContain('kein Firmen-Modul');
    expect(waits.filter((w) => w === 2000)).toHaveLength(2);

    const anna = t.app.db.get(`SELECT * FROM contacts WHERE location_id = ? AND email = 'anna@example.com'`, loc);
    expect(anna).toMatchObject({ first_name: 'Anna', last_name: 'Alt', phone: '+49301234567', company: 'Muster GmbH', assigned_to: adminId, source: 'HubSpot' });
    expect(JSON.parse(anna.custom)).toEqual({ budget: '5000', interessen: 'SEO, Ads', lifecyclestage: 'Kunde' });
    expect(JSON.parse(anna.tags)).toEqual(['Newsletter']);
    expect(anna.created_at).toBe('2024-01-05T10:00:00.000Z');
    // Companies land in the companies module, linked (primary) with their contacts; a re-import changes nothing.
    const co = t.app.db.get(`SELECT * FROM companies WHERE location_id = ? AND external_source = 'hubspot' AND external_id = 'c100'`, loc);
    expect(co).toMatchObject({ name: 'Muster GmbH', domain: 'muster.de' });
    const link = t.app.db.get(`SELECT primary_of FROM associations WHERE location_id = ? AND a_type = 'company' AND a_id = ? AND b_type = 'contact' AND b_id = ?`, loc, co.id, anna.id);
    expect(link.primary_of).toBe(anna.id);
    const ben = t.app.db.get(`SELECT * FROM contacts WHERE location_id = ? AND email = 'ben@example.com'`, loc);
    expect(ben.phone).toBe('+4917612345678');
    expect(t.app.db.get(`SELECT company FROM contacts WHERE email = 'cleo@example.com'`).company).toBe('Eigene AG');
    const fields = t.app.db.all('SELECT key, type, label, options FROM custom_fields WHERE location_id = ? ORDER BY key', loc);
    expect(fields.map((f) => f.key)).toEqual(['budget', 'interessen', 'lifecyclestage']);
    expect(fields.find((f) => f.key === 'budget').type).toBe('number');
    expect(JSON.parse(fields.find((f) => f.key === 'interessen').options)).toEqual(['SEO', 'Ads']);
    expect(fields.find((f) => f.key === 'lifecyclestage').label).toBe('Lebenszyklus-Phase');

    const pipe = t.app.db.get(`SELECT * FROM pipelines WHERE location_id = ? AND name = 'Sales Pipeline'`, loc);
    expect(JSON.parse(pipe.stages).map((s: any) => s.name)).toEqual(['Termin', 'Gewonnen', 'Verloren']);
    const opps = t.app.db.all('SELECT * FROM opportunities WHERE location_id = ? ORDER BY name', loc);
    expect(opps.map((o) => [o.name, o.status, o.value])).toEqual([
      ['SEO', 'open', 900],
      ['Website', 'won', 4500],
    ]);
    expect(opps.find((o) => o.name === 'Website')).toMatchObject({ contact_id: anna.id, assigned_to: adminId, pipeline_id: pipe.id });
    expect(t.app.db.get('SELECT body, created_at FROM notes WHERE contact_id = ?', anna.id)).toEqual({ body: 'Erstes Gespräch\ngut gelaufen', created_at: '2024-02-01T09:00:00.000Z' });
    const tasks = t.app.db.all('SELECT title, done, contact_id, assigned_to FROM tasks WHERE location_id = ? ORDER BY title', loc);
    expect(tasks).toEqual([
      { title: 'Angebot schicken', done: 1, contact_id: anna.id, assigned_to: adminId },
      { title: 'Nachfassen', done: 0, contact_id: null, assigned_to: null },
    ]);
    const acts = t.app.db.all(`SELECT type, summary, contact_id, created_at FROM activities WHERE location_id = ? AND type LIKE 'hubspot.%' ORDER BY created_at`, loc);
    expect(acts).toEqual([
      { type: 'hubspot.call', summary: 'Anruf (HubSpot): Erstgespräch', contact_id: ben.id, created_at: '2024-01-20T10:00:00.000Z' },
      { type: 'hubspot.email', summary: 'E-Mail (HubSpot): Angebot', contact_id: anna.id, created_at: '2024-01-21T10:00:00.000Z' },
    ]);
    // quiet import: no workflow/webhook events for imported contacts
    expect(count(`SELECT COUNT(*) n FROM workflow_runs`)).toBe(0);
    expect((await t.api.get('/api/integrations/catalog')).data.items.find((i: any) => i.key === 'hubspot')).toMatchObject({ status: 'ok' });
  });

  it('is idempotent: a second run updates instead of duplicating', async () => {
    const before = { contacts: count('SELECT COUNT(*) n FROM contacts WHERE location_id = ?', loc), opps: count('SELECT COUNT(*) n FROM opportunities WHERE location_id = ?', loc), notes: count('SELECT COUNT(*) n FROM notes'), tasks: count('SELECT COUNT(*) n FROM tasks'), acts: count(`SELECT COUNT(*) n FROM activities WHERE type LIKE 'hubspot.%'`), pipes: count('SELECT COUNT(*) n FROM pipelines WHERE location_id = ?', loc) };
    hs.contacts[0].properties.firstname = 'Anna-Lena';
    hs.deals[1].properties.dealstage = 'closedlost';
    const start = await t.api.post('/api/import/hubspot/start', {});
    await settle();
    expect((await t.api.get(`/api/import/hubspot/jobs/${start.data.id}`)).data.status).toBe('done');
    const after = { contacts: count('SELECT COUNT(*) n FROM contacts WHERE location_id = ?', loc), opps: count('SELECT COUNT(*) n FROM opportunities WHERE location_id = ?', loc), notes: count('SELECT COUNT(*) n FROM notes'), tasks: count('SELECT COUNT(*) n FROM tasks'), acts: count(`SELECT COUNT(*) n FROM activities WHERE type LIKE 'hubspot.%'`), pipes: count('SELECT COUNT(*) n FROM pipelines WHERE location_id = ?', loc) };
    expect(after).toEqual(before);
    expect(t.app.db.get(`SELECT first_name FROM contacts WHERE email = 'anna@example.com'`).first_name).toBe('Anna-Lena');
    expect(t.app.db.get(`SELECT status FROM opportunities WHERE name = 'SEO'`).status).toBe('lost');
    const dry = await t.api.post('/api/import/hubspot/dry-run', { parts: ['contacts', 'deals'] });
    expect(dry.data.result.find((r: any) => r.object === 'contacts')).toMatchObject({ hubspot: 3, imported: 3, new: 0 });
  });

  it('fails on a dead endpoint and resumes where it stopped', async () => {
    const contactCalls = hs.hits('/crm/v3/objects/contacts');
    hs.failing.add('/crm/v3/objects/deals');
    const start = await t.api.post('/api/import/hubspot/start', { parts: ['contacts', 'deals', 'notes'] });
    await settle();
    let job = (await t.api.get(`/api/import/hubspot/jobs/${start.data.id}`)).data;
    expect(job.status).toBe('failed');
    expect(job.error).toContain('502');
    expect(job.progress.done_steps).toEqual(['properties', 'contacts', 'pipelines']);
    expect(job.progress.step).toBe('deals');
    const fetchedContacts = hs.hits('/crm/v3/objects/contacts') - contactCalls;
    hs.failing.clear();
    expect((await t.api.post(`/api/import/hubspot/jobs/${start.data.id}/resume`, {})).data.status).toBe('running');
    await settle();
    job = (await t.api.get(`/api/import/hubspot/jobs/${start.data.id}`)).data;
    expect(job.status).toBe('done');
    expect(job.progress.done_steps).toEqual(['properties', 'contacts', 'pipelines', 'deals', 'notes']);
    expect(hs.hits('/crm/v3/objects/contacts') - contactCalls).toBe(fetchedContacts);
    expect(job.log.join('\n')).toContain('Fortgesetzt bei „deals“');
    expect((await t.api.post(`/api/import/hubspot/jobs/${start.data.id}/resume`, {})).status).toBe(400);
  });

  it('re-imports companies without duplicates (companies module, idempotent by HubSpot id)', async () => {
    const count = (sql: string) => t.app.db.get(sql, loc).n;
    const before = count('SELECT COUNT(*) AS n FROM companies WHERE location_id = ?');
    const start = await t.api.post('/api/import/hubspot/start', { parts: ['companies', 'contacts'] });
    await settle();
    expect((await t.api.get(`/api/import/hubspot/jobs/${start.data.id}`)).data.status).toBe('done');
    expect(count('SELECT COUNT(*) AS n FROM companies WHERE location_id = ?')).toBe(before);
    expect(count(`SELECT COUNT(*) AS n FROM companies WHERE location_id = ? AND external_source = 'hubspot' AND external_id = 'c100'`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM associations WHERE location_id = ? AND a_type = 'company' AND b_type = 'contact'`)).toBeGreaterThan(0);
  });

  it('uses a companies module and a tickets importer when they exist', async () => {
    const companies: any[] = [];
    const links: [string, string][] = [];
    const tickets: any[] = [];
    t.app.services.companies = { upsert: async (_loc: string, input: any) => (companies.push(input), { id: `co_${input.external_id}` }), linkContact: async (_loc: string, co: string, contact: string) => void links.push([co, contact]) };
    t.app.services.ticketsImport = async (_loc: string, input: any) => (tickets.push(input), `tk_${input.external_id}`);
    hs.forbidden.clear();
    const start = await t.api.post('/api/import/hubspot/start', { parts: ['companies', 'contacts', 'tickets'] });
    await settle();
    const job = (await t.api.get(`/api/import/hubspot/jobs/${start.data.id}`)).data;
    expect(job.status).toBe('done');
    expect(companies[0]).toMatchObject({ name: 'Muster GmbH', domain: 'muster.de', external_source: 'hubspot', external_id: 'c100' });
    const anna = t.app.db.get(`SELECT id FROM contacts WHERE email = 'anna@example.com'`);
    expect(links).toEqual([['co_c100', anna.id]]);
    expect(tickets[0]).toMatchObject({ subject: 'Login geht nicht', content: 'Hilfe', pipeline: 'Support', stage: 'Neu', priority: 'high', external_id: 'x1' });
    expect(tickets[0].contact_id).toBe(t.app.db.get(`SELECT id FROM contacts WHERE email = 'cleo@example.com'`).id);
    expect(t.app.db.get(`SELECT local_id FROM hubspot_ids WHERE object = 'ticket' AND hubspot_id = 'x1'`).local_id).toBe('tk_x1');
    delete t.app.services.companies;
    delete t.app.services.ticketsImport;
  });

  it('imports HubSpot tickets into the helpdesk (idempotent, pipeline/stage/priority mapped)', async () => {
    expect(typeof helpdeskImport).toBe('function');
    t.app.services.ticketsImport = helpdeskImport;
    for (let run = 0; run < 2; run++) {
      const start = await t.api.post('/api/import/hubspot/start', { parts: ['contacts', 'tickets'] });
      await settle();
      expect((await t.api.get(`/api/import/hubspot/jobs/${start.data.id}`)).data.status).toBe('done');
    }
    const rows = t.app.db.all(`SELECT * FROM tickets WHERE location_id = ? AND external_source = 'hubspot'`, loc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: 'Login geht nicht', description: 'Hilfe', priority: 'hoch', status_kind: 'new', stage_id: 'neu', external_id: 'x1', source: 'Import' });
    expect(rows[0].contact_id).toBe(t.app.db.get(`SELECT id FROM contacts WHERE email = 'cleo@example.com'`).id);
    expect(t.app.db.get(`SELECT local_id FROM hubspot_ids WHERE object = 'ticket' AND hubspot_id = 'x1'`).local_id).toBe(rows[0].id);
  });

  it('disconnects', async () => {
    expect((await t.api.del('/api/import/hubspot/connection')).data).toEqual({ connected: false });
    expect((await t.api.post('/api/import/hubspot/start', {})).status).toBe(400);
  });
});
