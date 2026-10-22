import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { startTestApp } from './helpers.js';
import { remapRefs } from '../server/services/snapshots.js';
import { requiredPermission } from '../server/core/permissions.js';
import { domainAlias, normalizeDomain } from '../server/core/domains.js';

let t: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  process.env.PGHL_AGENT_TOKEN = 'agent-secret-123';
  process.env.PGHL_SERVER_IP = '1.2.3.4';
  t = await startTestApp();
  await t.setup();
});
afterAll(async () => {
  await t.close();
  delete process.env.PGHL_AGENT_TOKEN;
  delete process.env.PGHL_SERVER_IP;
});

function getWithHost(path: string, host: string): Promise<string> {
  const u = new URL(t.base);
  return new Promise((resolve, reject) => {
    request({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve(s));
    })
      .on('error', reject)
      .end();
  });
}

describe('helpers', () => {
  it('normalizes domains and pairs www', () => {
    expect(normalizeDomain('https://WWW.Kunde.de/start?x')).toBe('www.kunde.de');
    expect(() => normalizeDomain('kunde.de; rm -rf /')).toThrow();
    expect(() => normalizeDomain('localhost')).toThrow();
    expect(domainAlias('kunde.de')).toBe('www.kunde.de');
    expect(domainAlias('www.kunde.de')).toBe('kunde.de');
    expect(domainAlias('shop.kunde.de')).toBeUndefined();
  });
  it('maps routes to permissions, lookups stay readable', () => {
    expect(requiredPermission('GET', '/api/contacts')).toBe('contacts');
    expect(requiredPermission('GET', '/api/contacts/export.csv')).toBe('contacts');
    expect(requiredPermission('GET', '/api/tags')).toBeUndefined();
    expect(requiredPermission('POST', '/api/tags')).toBe('settings');
    expect(requiredPermission('GET', '/api/forms')).toBeUndefined();
    expect(requiredPermission('GET', '/api/forms/x/submissions')).toBe('forms');
    expect(requiredPermission('PATCH', '/api/funnel-pages/x')).toBe('funnels');
  });
  it('remaps references and clears unknown ones', () => {
    const maps = { forms: new Map([['f1', 'F1']]), calendars: new Map(), pipelines: new Map([['p1', 'P1']]), workflows: new Map(), calendarSlugs: new Map([['old', 'new']]) };
    expect(remapRefs({ a: [{ form_id: 'f1' }, { form_id: 'other' }], calendar_slug: 'old', x: { pipeline_id: 'p1', stage_id: 's1' } }, maps)).toEqual({
      a: [{ form_id: 'F1' }, { form_id: '' }],
      calendar_slug: 'new',
      x: { pipeline_id: 'P1', stage_id: 's1' },
    });
  });
});

describe('white-label branding', () => {
  it('is public to read and admin-only to change', async () => {
    expect((await t.api.get('/api/branding')).data.name).toBe('HyperLevel');
    const r = await t.api.patch('/api/agency/branding', { name: 'Nordlicht Digital', color: '#ff5500', login_title: 'Kundenportal', app_domain: 'https://App.Nordlicht-Digital.example/' });
    expect(r.data).toMatchObject({ name: 'Nordlicht Digital', app_domain: 'app.nordlicht-digital.example' });
    const pub = (await t.api.get('/api/branding')).data;
    expect(pub).toMatchObject({ name: 'Nordlicht Digital', color: '#ff5500', login_title: 'Kundenportal' });
    expect(pub.app_domain).toBeUndefined();
    expect((await t.api.patch('/api/agency/branding', { color: 'red' })).status).toBe(400);
    // Links only switch to the agency domain once its certificate is live.
    expect(t.app.baseUrl()).toBe('http://localhost');
  });

  it('shows the new product name where a saved branding still has the old default "GoHigh"', async () => {
    const row = t.app.db.get('SELECT value FROM agency_settings WHERE key = ?', 'branding');
    const saved = JSON.parse(row.value);
    t.app.db.run('UPDATE agency_settings SET value = ? WHERE key = ?', JSON.stringify({ ...saved, name: 'GoHigh' }), 'branding');
    expect((await t.api.get('/api/branding')).data).toMatchObject({ name: 'HyperLevel', color: '#ff5500' });
    t.app.db.run('UPDATE agency_settings SET value = ? WHERE key = ?', row.value, 'branding');
  });
});

describe('clients, snapshots and copying', () => {
  let templateLoc = '';
  let snapId = '';

  it('builds a template account and snapshots it', async () => {
    templateLoc = t.api.location;
    const [pipe] = (await t.api.get('/api/pipelines')).data;
    const form = (await t.api.post('/api/forms', { name: 'Anfrage', settings: { pipeline_id: pipe.id, stage_id: pipe.stages[1].id } })).data;
    const cal = (await t.api.post('/api/calendars', { name: 'Beratung', settings: { pipeline_id: pipe.id } })).data;
    const site = (await t.api.post('/api/funnels', { name: 'Handwerker-Website', kind: 'website', template: 'website' })).data;
    const home = site.pages[0];
    await t.api.patch(`/api/funnel-pages/${home.id}`, { blocks: [...home.blocks.map((b: any) => (b.type === 'form' ? { ...b, form_id: form.id } : b)), { id: 'c1', type: 'calendar', calendar_slug: cal.slug }] });
    const wf = (await t.api.post('/api/workflows', { name: 'Lead', trigger: { type: 'form.submitted', config: { form_id: form.id } }, steps: [{ type: 'move_opportunity', pipeline_id: pipe.id, stage_id: pipe.stages[2].id }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    await t.api.post('/api/custom-fields', { label: 'Gewerk' });
    await t.api.post('/api/templates', { name: 'Danke', subject: 'Danke', body: 'Hallo' });

    const s = await t.api.post('/api/snapshots', { location_id: templateLoc, name: 'Handwerker-Paket' });
    expect(s.status).toBe(200);
    expect(s.data.summary).toMatchObject({ funnels: 1, forms: 1, calendars: 1, workflows: 1, pipelines: 1, templates: 1, custom_fields: 1 });
    snapId = s.data.id;
  });

  it('creates a client from the snapshot with its own login, everything rewired', async () => {
    const r = await t.api.post('/api/agency/clients', {
      name: 'Malerbetrieb Meier',
      snapshot_id: snapId,
      user: { email: 'meier@kunde.de', password: 'kunde1234', permissions: ['funnels', 'contacts'] },
    });
    expect(r.status).toBe(200);
    const loc = r.data.location.id;
    t.api.setLocation(loc);
    const pipes = (await t.api.get('/api/pipelines')).data;
    expect(pipes).toHaveLength(1); // default pipeline replaced by the snapshot's
    const forms = (await t.api.get('/api/forms')).data;
    const cals = (await t.api.get('/api/calendars')).data;
    expect(forms[0].settings.pipeline_id).toBe(pipes[0].id);
    expect(cals[0].slug).not.toBe('beratung');
    expect(cals[0].settings.pipeline_id).toBe(pipes[0].id);
    const site = (await t.api.get('/api/funnels')).data[0];
    const full = (await t.api.get(`/api/funnels/${site.id}`)).data;
    const blocks = full.pages[0].blocks;
    expect(blocks.find((b: any) => b.type === 'form').form_id).toBe(forms[0].id);
    expect(blocks.find((b: any) => b.type === 'calendar').calendar_slug).toBe(cals[0].slug);
    const wf = (await t.api.get('/api/workflows')).data[0];
    expect(wf.status).toBe('draft');
    expect(wf.trigger.config.form_id).toBe(forms[0].id);
    expect(wf.steps[0].pipeline_id).toBe(pipes[0].id);
    const page = await t.api.get(`/p/${site.slug}`);
    expect(page.data).toContain(`pf_${forms[0].id}`);
    expect((await t.api.get('/api/contacts')).data.total).toBe(0);
    t.api.setLocation(templateLoc);
  });

  it('copies a single funnel with the forms it uses', async () => {
    const target = (await t.api.post('/api/agency/clients', { name: 'Bäckerei Korn' })).data.location.id;
    const site = (await t.api.get('/api/funnels')).data[0];
    const r = await t.api.post(`/api/funnels/${site.id}/copy`, { location_id: target });
    expect(r.data.funnels).toHaveLength(1);
    expect(r.data.forms).toHaveLength(1);
    t.api.setLocation(target);
    expect((await t.api.get('/api/funnels')).data).toHaveLength(1);
    expect((await t.api.get('/api/workflows')).data).toHaveLength(0);
    t.api.setLocation(templateLoc);
  });

  it('downloads and re-imports a snapshot file', async () => {
    const dl = await t.api.get(`/api/snapshots/${snapId}/download`);
    expect(dl.headers.get('content-disposition')).toContain('snapshot-handwerker-paket.json');
    const imp = await t.api.post('/api/snapshots/import', { name: 'Kopie', data: dl.data });
    expect(imp.data.summary.funnels).toBe(1);
    expect((await t.api.post('/api/snapshots/import', { data: '{"nope":1}' })).status).toBe(400);
  });

  it('shows every client in the agency overview', async () => {
    const o = (await t.api.get('/api/agency/overview')).data;
    expect(o.map((l: any) => l.name)).toEqual(expect.arrayContaining(['Malerbetrieb Meier', 'Bäckerei Korn', 'Testfirma']));
    expect(o.find((l: any) => l.name === 'Malerbetrieb Meier').users).toBe(1);
  });
});

describe('client logins with permissions', () => {
  it('only reaches the allowed areas', async () => {
    const own = t.api.location;
    const meier = (await t.api.get('/api/agency/overview')).data.find((l: any) => l.name === 'Malerbetrieb Meier').id;
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'meier@kunde.de', password: 'kunde1234' })).status).toBe(200);
    t.api.setLocation(meier);
    expect((await t.api.get('/api/me')).data.user.permissions).toEqual(['funnels', 'contacts']);
    expect((await t.api.get('/api/funnels')).status).toBe(200);
    expect((await t.api.get('/api/contacts')).status).toBe(200);
    expect((await t.api.get('/api/tags')).status).toBe(200); // lookup
    expect((await t.api.get('/api/invoices')).status).toBe(403);
    expect((await t.api.get('/api/workflows/x/runs')).status).toBe(403);
    expect((await t.api.post('/api/tags', { name: 'x' })).status).toBe(403);
    expect((await t.api.get('/api/agency/overview')).status).toBe(403);
    t.api.setLocation(own);
    expect((await t.api.get('/api/contacts')).status).toBe(403); // not their sub-account
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
  });
});

describe('custom domains and the agent', () => {
  it('serves both halves of a www pair and reports through the agent API', async () => {
    const site = (await t.api.get('/api/funnels')).data[0];
    await t.api.patch(`/api/funnels/${site.id}`, { domain: 'kunde-test.de' });
    expect(await getWithHost('/', 'www.kunde-test.de')).toContain('<html');
    expect(await getWithHost('/impressum', 'kunde-test.de')).toContain('Impressum');
    expect((await t.api.patch(`/api/funnels/${site.id}`, { domain: 'localhost' })).status).toBe(400);

    expect((await t.api.raw('/api/agent/domains')).status).toBe(404);
    const auth = { 'x-agent-token': 'agent-secret-123' };
    const list = await (await t.api.raw('/api/agent/domains', { headers: auth })).json();
    expect(list.domains).toEqual(expect.arrayContaining([expect.objectContaining({ domain: 'kunde-test.de', alias: 'www.kunde-test.de', kind: 'funnel' }), expect.objectContaining({ domain: 'app.nordlicht-digital.example', kind: 'app' })]));
    const rep = await t.api.raw('/api/agent/domains/report', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'app.nordlicht-digital.example', status: 'active', message: 'ok' }) });
    expect(rep.status).toBe(200);
    expect(t.app.baseUrl()).toBe('https://app.nordlicht-digital.example');
    const domsRes = await t.api.get('/api/agency/domains');
    if (domsRes.status !== 200) throw new Error(JSON.stringify(domsRes));
    const doms = domsRes.data;
    expect(doms.server_ip).toBe('1.2.3.4');
    expect(doms.domains.find((d: any) => d.domain === 'app.nordlicht-digital.example').status).toBe('active');
    expect((await t.api.get(`/api/funnels/${site.id}`)).data.domain_status.status).toBe('pending');
  });

  it('never renders another sub-account’s form on a page', async () => {
    const foreignForm = (await t.api.get('/api/forms')).data[0];
    const other = (await t.api.post('/api/agency/clients', { name: 'Fremd' })).data.location.id;
    const own = t.api.location;
    t.api.setLocation(other);
    const f = (await t.api.post('/api/funnels', { name: 'Klau', template: 'blank' })).data;
    await t.api.patch(`/api/funnel-pages/${f.pages[0].id}`, { blocks: [{ id: 'x', type: 'form', form_id: foreignForm.id }] });
    const page = await t.api.get(`/p/${f.slug}`);
    expect(page.data).not.toContain(`pf_${foreignForm.id}`);
    t.api.setLocation(own);
  });
});

describe('client branding', () => {
  it('overlays the agency branding for client logins and on the client login domain', async () => {
    await t.api.patch('/api/agency/branding', { name: 'Meine Agentur', color: '#111111' });
    const loc = (await t.api.post('/api/locations', { name: 'Bäckerei Brandt' })).data.id;
    const r = await t.api.patch(`/api/agency/locations/${loc}/branding`, { name: 'Bäckerei CRM', color: '#ff8800', app_domain: 'https://CRM.baeckerei.de/' });
    expect(r.status).toBe(200);
    expect(r.data.app_domain).toBe('crm.baeckerei.de');
    expect((await t.api.patch(`/api/agency/locations/${loc}/branding`, { color: 'rot' })).status).toBe(400);
    expect((await t.api.patch(`/api/agency/locations/${t.api.location}/branding`, { app_domain: 'crm.baeckerei.de' })).status).toBe(400);

    await t.api.patch('/api/location', { settings: { branding: { app_domain: 'boese.de' } } }, );
    expect(JSON.parse(await getWithHost('/api/branding', 'boese.de')).location_id).toBeUndefined();

    // Admin keeps the agency look; the client's login domain shows the client's.
    expect((await t.api.get('/api/branding/me')).data.name).toBe('Meine Agentur');
    const viaDomain = JSON.parse(await getWithHost('/api/branding', 'crm.baeckerei.de'));
    expect(viaDomain).toMatchObject({ name: 'Bäckerei CRM', color: '#ff8800', location_id: loc });
    expect(viaDomain.app_domain).toBeUndefined();
    expect((await t.api.get('/api/branding')).data.name).toBe('Meine Agentur');

    const agent = await t.api.raw('/api/agent/domains', { headers: { 'x-agent-token': 'agent-secret-123' } });
    expect((await agent.json()).domains.some((d: any) => d.domain === 'crm.baeckerei.de' && d.kind === 'app')).toBe(true);

    // A client login sees its sub-account's branding.
    expect((await t.api.post('/api/users', { email: 'inhaber@baeckerei.de', name: 'Inhaber', password: 'geheim12345', role: 'member', locations: [loc] })).status).toBe(200);
    const admin = t.api.cookie;
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'inhaber@baeckerei.de', password: 'geheim12345' });
    expect((await t.api.get('/api/branding/me', { 'x-location-id': loc })).data).toMatchObject({ name: 'Bäckerei CRM', color: '#ff8800' });
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    expect(t.api.cookie).not.toBe(admin);
  });
});
