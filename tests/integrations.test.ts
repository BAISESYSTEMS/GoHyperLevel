import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMapping, flattenPaths, getPath, verifyHmac } from '../server/services/inbound-webhooks.js';
import { ROUTE_DOCS } from '../server/services/openapi.js';
import { HOOK_ACTIONS, HOOK_TRIGGERS, buildPayload, detectSource, filtersMatch, invoiceItems, retryDelayMs, shouldRetry, triggersForEvent } from '../server/services/rest-hooks.js';
import { aggregate } from '../server/services/integrations-catalog.js';
import { startTestApp } from './helpers.js';

type Call = { url: string; headers: Record<string, string>; body: string };

describe('integrations: pure helpers', () => {
  it('maps events to triggers incl. won/lost/cancelled and any', () => {
    const keys = (type: string, data: any = {}) => triggersForEvent({ type, data }).map((t) => t.key).sort();
    expect(keys('contact.tag_added', { tag: 'x' })).toEqual(['any', 'contact.tagged']);
    expect(keys('opportunity.status_changed', { status: 'won' })).toEqual(['any', 'opportunity.won']);
    expect(keys('opportunity.status_changed', { status: 'lost' })).toEqual(['any', 'opportunity.lost']);
    expect(keys('opportunity.status_changed', { status: 'abandoned' })).toEqual(['any']);
    expect(keys('appointment.status_changed', { status: 'cancelled' })).toEqual(['any', 'appointment.cancelled']);
    expect(keys('google_review.received', {})).toEqual(['any', 'review.received']);
    expect(keys('task.completed', {})).toEqual(['any', 'task.completed']);
  });
  it('filters, payloads, retry timing and source detection', () => {
    expect(filtersMatch({ tag: 'vip' }, { type: 'contact.tag_added', data: { tag: 'vip' } })).toBe(true);
    expect(filtersMatch({ tag: 'vip' }, { type: 'contact.tag_added', data: { tag: 'x' } })).toBe(false);
    expect(filtersMatch({ events: ['form.submitted'] }, { type: 'contact.created', data: {} })).toBe(false);
    expect(filtersMatch({ stage_id: 's2' }, { type: 'opportunity.stage_changed', data: { stageId: 's2' } })).toBe(true);
    const p = buildPayload('contact.created', { locationId: 'L', type: 'contact.created', at: '2026-01-01T00:00:00.000Z', data: { contactId: 'c1', contact: { id: 'c1' } } }, 'evt_1', { id: 'c1', email: 'a@b.de' });
    expect(p).toMatchObject({ id: 'evt_1', event: 'contact.created', contact_id: 'c1', contact: { email: 'a@b.de' }, data: { contactId: 'c1' } });
    expect((p.data as any).contact).toBeUndefined();
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(5)).toBe(6 * 3600_000);
    expect(retryDelayMs(6)).toBeNull();
    expect([0, 408, 429, 500, 503].every(shouldRetry)).toBe(true);
    expect([400, 401, 404, 410].some(shouldRetry)).toBe(false);
    expect(detectSource('https://hooks.zapier.com/hooks/standard/1/2/')).toBe('zapier');
    expect(detectSource('https://hook.eu1.make.com/abc')).toBe('make');
    expect(detectSource('https://n8n.example.com/webhook/abc')).toBe('n8n');
    expect(detectSource('https://example.com/x', '', 'make')).toBe('make');
    expect(detectSource('https://example.com/x')).toBe('api');
    expect(invoiceItems([{ name: 'Beratung', qty: 2, price: '120,50' }])).toEqual([{ name: 'Beratung', description: '', qty: 2, price_cents: 12050 }]);
    expect(invoiceItems('[{"name":"A","price_cents":500}]')[0].price_cents).toBe(500);
  });
  it('inbound webhook mapping and HMAC', () => {
    const body = { customer: { mail: 'x@y.de', name: 'Max Muster' }, items: [{ sku: 'A' }], labels: ['a', 'b'] };
    expect(getPath(body, 'customer.mail')).toBe('x@y.de');
    expect(getPath(body, 'items[0].sku')).toBe('A');
    expect(getPath(body, 'items.0.sku')).toBe('A');
    expect(getPath(body, 'nope.x')).toBeUndefined();
    expect(flattenPaths(body).map((f) => f.path)).toEqual(['customer.mail', 'customer.name', 'items.0.sku', 'labels']);
    const m = applyMapping(body, [{ from: 'customer.mail', to: 'email' }, { from: 'customer.name', to: 'name' }, { from: 'labels', to: 'tags' }, { from: 'items.0.sku', to: 'custom.sku' }], ['shop']);
    expect(m).toEqual({ input: { email: 'x@y.de', name: 'Max Muster', custom: { sku: 'A' } }, tags: ['shop', 'a', 'b'] });
    expect(applyMapping({ email: 'a@b.de', tags: ['t'] }, []).input.email).toBe('a@b.de');
    const raw = '{"a":1}';
    const sig = createHmac('sha256', 'geheim').update(raw).digest('hex');
    expect(verifyHmac('geheim', raw, `sha256=${sig}`)).toBe(true);
    expect(verifyHmac('geheim', raw, sig)).toBe(true);
    expect(verifyHmac('geheim', raw, createHmac('sha256', 'geheim').update(raw).digest('base64'))).toBe(true);
    expect(verifyHmac('falsch', raw, `sha256=${sig}`)).toBe(false);
    expect(verifyHmac('geheim', raw, undefined)).toBe(false);
  });
  it('aggregates per-sub-account status for the agency', () => {
    expect(aggregate([{ status: 'ok', detail: '' }, { status: 'missing', detail: '' }, { status: 'partial', detail: '' }])).toEqual({ status: 'ok', detail: '1 von 3 Sub-Accounts eingerichtet, 1 unvollständig' });
    expect(aggregate([{ status: 'missing', detail: '' }]).status).toBe('missing');
  });
});

describe('integrations: REST hooks, actions, OpenAPI, inbound webhooks, catalogue', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let key = '';
  let loc = '';
  const calls: Call[] = [];
  let reply: (c: Call) => number = () => 200;
  const withKey = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, cookie: '', 'x-pghl': '', ...extra });
  const keyCall = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await t.api.raw(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, data: type.includes('json') ? await r.json() : await r.text(), headers: r.headers };
  };

  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    loc = t.api.location;
    t.app.services.restHookFetch = async (url: string, init: any) => {
      const c = { url, headers: init.headers, body: init.body };
      calls.push(c);
      const status = reply(c);
      return { status, ok: status < 300, headers: {}, text: async () => (status < 300 ? 'ok' : 'nope') };
    };
    key = (await t.api.post('/api/api-keys', { name: 'Zapier' })).data.key;
  });
  afterAll(async () => t.close());

  it('subscribes with a location key, delivers signed payloads and unsubscribes', async () => {
    expect((await keyCall('GET', '/api/hooks/me')).data).toMatchObject({ ok: true, location: { id: loc, name: 'Testfirma' } });
    const sub = await keyCall('POST', '/api/hooks', { hookUrl: 'https://hooks.zapier.com/hooks/standard/1/abc/', event: 'contact.created' });
    expect(sub.status).toBe(200);
    expect(sub.data).toMatchObject({ event: 'contact.created', source: 'zapier', status: 'active' });
    expect(sub.data.secret).toHaveLength(32);
    expect((await keyCall('POST', '/api/hooks', { target_url: 'ftp://x', event: 'contact.created' })).status).toBe(400);
    expect((await keyCall('POST', '/api/hooks', { target_url: 'https://x.de', event: 'nope' })).status).toBe(400);

    calls.length = 0;
    await keyCall('POST', '/api/contacts', { first_name: 'Anna', email: 'anna@example.com' });
    await t.app.events.flush();
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toBe('https://hooks.zapier.com/hooks/standard/1/abc/');
    expect(c.headers['x-pghl-signature']).toBe(createHash('sha256').update(sub.data.secret + c.body).digest('hex'));
    expect(c.headers['x-pghl-event']).toBe('contact.created');
    const payload = JSON.parse(c.body);
    expect(payload).toMatchObject({ event: 'contact.created', type: 'contact.created', location_id: loc, contact: { email: 'anna@example.com', first_name: 'Anna' } });
    expect(payload.id).toMatch(/^evt_/);

    const log = await keyCall('GET', `/api/hooks/deliveries?hook_id=${sub.data.id}`);
    expect(log.data.total).toBe(1);
    expect(log.data.deliveries[0]).toMatchObject({ status: 'success', attempts: 1, response_status: 200, event: 'contact.created' });
    const detail = await keyCall('GET', `/api/hooks/deliveries/${log.data.deliveries[0].id}`);
    expect(detail.data.payload.contact.email).toBe('anna@example.com');

    expect((await keyCall('DELETE', `/api/hooks/${sub.data.id}`)).status).toBe(200);
    expect((await keyCall('DELETE', `/api/hooks/${sub.data.id}`)).status).toBe(404);
    calls.length = 0;
    await keyCall('POST', '/api/contacts', { email: 'bert@example.com' });
    await t.app.events.flush();
    expect(calls).toHaveLength(0);
  });

  it('applies filters and serves samples (static first, then real events)', async () => {
    const empty = await keyCall('GET', '/api/hooks/triggers/opportunity.won/sample');
    expect(empty.data[0]).toMatchObject({ sample: true, event: 'opportunity.won', contact: { email: 'anna@example.com' } });
    const tagged = await keyCall('POST', '/api/hooks', { target_url: 'https://hook.eu1.make.com/t1', event: 'contact.tagged', tag: 'vip' });
    expect(tagged.data.filters).toEqual({ tag: 'vip' });
    expect(tagged.data.source).toBe('make');
    const won = await keyCall('POST', '/api/hooks', { target_url: 'https://n8n.example.com/webhook/won', event: 'opportunity.won' });
    const contact = (await keyCall('POST', '/api/contacts', { email: 'cora@example.com' })).data;
    await t.app.events.flush();
    calls.length = 0;
    await keyCall('POST', `/api/contacts/${contact.id}/tags`, { add: ['other'] });
    await t.app.events.flush();
    expect(calls).toHaveLength(0);
    await keyCall('POST', `/api/contacts/${contact.id}/tags`, { add: ['vip'] });
    await t.app.events.flush();
    expect(calls.map((c) => c.url)).toEqual(['https://hook.eu1.make.com/t1']);
    expect(JSON.parse(calls[0].body).data.tag).toBe('vip');

    const pipes = (await keyCall('GET', '/api/pipelines')).data;
    const opp = (await keyCall('POST', '/api/opportunities', { pipeline_id: pipes[0].id, contact_id: contact.id, value: 900 })).data;
    await t.app.events.flush();
    calls.length = 0;
    await keyCall('PATCH', `/api/opportunities/${opp.id}`, { status: 'lost', lost_reason: 'Kein Budget' });
    await t.app.events.flush();
    expect(calls).toHaveLength(0);
    await keyCall('PATCH', `/api/opportunities/${opp.id}`, { status: 'won' });
    await t.app.events.flush();
    expect(calls.map((c) => c.url)).toEqual(['https://n8n.example.com/webhook/won']);
    const sample = await keyCall('GET', '/api/hooks/triggers/opportunity.won/sample');
    expect(sample.data[0].sample).toBeUndefined();
    expect(sample.data[0].data.opportunity.id).toBe(opp.id);
    await keyCall('DELETE', `/api/hooks/${tagged.data.id}`);
    await keyCall('DELETE', `/api/hooks/${won.data.id}`);
  });

  it('retries with backoff, gives up on 4xx and switches off after repeated 410', async () => {
    const sub = (await keyCall('POST', '/api/hooks', { target_url: 'https://example.org/in', event: 'contact.created' })).data;
    reply = () => 503;
    calls.length = 0;
    await keyCall('POST', '/api/contacts', { email: 'retry@example.com' });
    await t.app.events.flush();
    let d = (await keyCall('GET', `/api/hooks/deliveries?hook_id=${sub.id}`)).data.deliveries[0];
    expect(d).toMatchObject({ status: 'retrying', attempts: 1, response_status: 503 });
    const wait = Date.parse(d.next_attempt_at) - Date.now();
    expect(wait).toBeGreaterThan(50_000);
    expect(wait).toBeLessThan(61_000);
    // not due yet → nothing happens on a tick
    await t.app.tick();
    expect(calls).toHaveLength(1);
    t.app.db.run('UPDATE rest_hook_deliveries SET next_attempt_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), d.id);
    reply = () => 200;
    await t.app.tick();
    d = (await keyCall('GET', `/api/hooks/deliveries/${d.id}`)).data;
    expect(d).toMatchObject({ status: 'success', attempts: 2 });
    expect(calls[1].headers['x-pghl-attempt']).toBe('2');

    reply = () => 400;
    await keyCall('POST', '/api/contacts', { email: 'bad@example.com' });
    await t.app.events.flush();
    d = (await keyCall('GET', `/api/hooks/deliveries?hook_id=${sub.id}&status=failed`)).data.deliveries[0];
    expect(d).toMatchObject({ status: 'failed', attempts: 1, next_attempt_at: null });
    reply = () => 200;
    const again = await keyCall('POST', `/api/hooks/deliveries/${d.id}/retry`);
    expect(again.data).toMatchObject({ status: 'success', attempts: 2 });

    reply = () => 410;
    for (const n of [1, 2, 3]) {
      await keyCall('POST', '/api/contacts', { email: `gone${n}@example.com` });
      await t.app.events.flush();
    }
    const hook = (await keyCall('GET', `/api/hooks/${sub.id}`)).data;
    expect(hook.status).toBe('disabled');
    expect(hook.disabled_reason).toContain('410');
    calls.length = 0;
    await keyCall('POST', '/api/contacts', { email: 'after@example.com' });
    await t.app.events.flush();
    expect(calls).toHaveLength(0);
    reply = () => 200;
    expect((await keyCall('PATCH', `/api/hooks/${sub.id}`, { status: 'active' })).data).toMatchObject({ status: 'active', gone_count: 0, disabled_reason: null });
    const test = await keyCall('POST', `/api/hooks/${sub.id}/test`);
    expect(test.data).toMatchObject({ status: 'success' });
    expect(test.data.payload.test).toBe(true);
    await keyCall('DELETE', `/api/hooks/${sub.id}`);
  });

  it('works with agency keys and fires task.completed', async () => {
    const ak = (await t.api.post('/api/agency/api-keys', { name: 'Make', scope: 'write' })).data.key;
    const call = (method: string, path: string, body?: unknown) =>
      t.api.raw(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${ak}`, 'x-location-id': loc }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
    const sub = await call('POST', '/api/hooks', { url: 'https://example.net/task', event: 'task.completed' });
    expect(sub.status).toBe(200);
    const contact = (await call('POST', '/api/contacts', { email: 'task@example.com' })).data;
    const task = (await call('POST', '/api/tasks', { title: 'Anrufen', contact_id: contact.id })).data;
    await t.app.events.flush();
    calls.length = 0;
    await call('PATCH', `/api/tasks/${task.id}`, { done: true });
    await call('PATCH', `/api/tasks/${task.id}`, { done: true });
    await t.app.events.flush();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body)).toMatchObject({ event: 'task.completed', contact_id: contact.id, data: { task: { id: task.id, done: 1 } } });
    await call('DELETE', `/api/hooks/${sub.data.id}`);
  });

  it('runs actions and searches through the normal API', async () => {
    const created = await keyCall('POST', '/api/hooks/actions/create_contact', { email: 'Dora@Example.com', first_name: 'Dora', tags: 'kunde, neu', custom: '{"budget":"5000"}' });
    expect(created.data).toMatchObject({ email: 'dora@example.com', first_name: 'Dora', tags: ['kunde', 'neu'], custom: { budget: '5000' }, source: 'API' });
    expect((await keyCall('POST', '/api/hooks/actions/create_contact', {})).status).toBe(400);
    const tagged = await keyCall('POST', '/api/hooks/actions/add_tag', { email: 'emil@example.com', tags: ['lead'] });
    expect(tagged.data).toMatchObject({ email: 'emil@example.com', tags: ['lead'] });
    expect((await keyCall('POST', '/api/hooks/actions/remove_tag', { email: 'emil@example.com', tags: 'lead' })).data.tags).toEqual([]);
    expect((await keyCall('POST', '/api/hooks/actions/remove_tag', { email: 'niemand@example.com', tags: 'lead' })).status).toBe(404);
    const upd = await keyCall('POST', '/api/hooks/actions/update_contact', { email: 'dora@example.com', city: 'Köln', new_email: 'dora@neu.de', tags: ['vip'] });
    expect(upd.data).toMatchObject({ email: 'dora@neu.de', city: 'Köln' });
    expect(upd.data.tags).toContain('vip');

    const opp = await keyCall('POST', '/api/hooks/actions/create_opportunity', { email: 'dora@neu.de', pipeline: 'vertrieb', stage: 'Kontaktiert', value: '1500,5', name: 'Relaunch' });
    expect(opp.status).toBe(200);
    const pipe = (await keyCall('GET', '/api/pipelines')).data[0];
    expect(opp.data).toMatchObject({ pipeline_id: pipe.id, stage_id: pipe.stages.find((s: any) => s.name === 'Kontaktiert').id, name: 'Relaunch', value: 1501, contact_id: created.data.id });
    expect((await keyCall('POST', '/api/hooks/actions/create_opportunity', { email: 'dora@neu.de', stage: 'Gibtsnicht' })).status).toBe(400);
    const moved = await keyCall('POST', '/api/hooks/actions/move_stage', { opportunity_id: opp.data.id, stage: 'gewonnen', status: 'won' });
    expect(moved.data).toMatchObject({ stage_id: pipe.stages.find((s: any) => s.name === 'Gewonnen').id, status: 'won' });

    const task = await keyCall('POST', '/api/hooks/actions/create_task', { email: 'dora@neu.de', title: 'Nachfassen', due_at: '2026-10-10T09:00:00Z' });
    expect(task.data).toMatchObject({ title: 'Nachfassen', contact_id: created.data.id, due_at: '2026-10-10T09:00:00.000Z' });
    const note = await keyCall('POST', '/api/hooks/actions/add_note', { contact_id: created.data.id, body: 'Aus Zapier' });
    expect(note.data).toMatchObject({ body: 'Aus Zapier', contact_id: created.data.id });
    const msg = await keyCall('POST', '/api/hooks/actions/send_message', { email: 'dora@neu.de', subject: 'Hallo', body: 'Test' });
    expect(msg.status).toBe(200);
    const inv = await keyCall('POST', '/api/hooks/actions/create_invoice_draft', { email: 'dora@neu.de', title: 'Projekt', items: [{ name: 'Beratung', qty: 2, price: 100, tax_rate: 19 }] });
    expect(inv.data).toMatchObject({ status: 'draft', contact_id: created.data.id, total_cents: 23800 });
    expect((await keyCall('POST', '/api/hooks/actions/nope', {})).status).toBe(404);

    expect((await keyCall('GET', '/api/hooks/search/contacts?email=DORA@neu.de')).data.map((c: any) => c.id)).toEqual([created.data.id]);
    expect((await keyCall('GET', '/api/hooks/search/contacts')).status).toBe(400);
    expect((await keyCall('GET', `/api/hooks/search/opportunities?contact_id=${created.data.id}`)).data[0].id).toBe(opp.data.id);
    const actions = (await keyCall('GET', '/api/hooks/actions')).data.map((a: any) => a.key);
    expect(actions).toEqual(HOOK_ACTIONS.map((a) => a.key));
    const triggers = (await keyCall('GET', '/api/hooks/triggers')).data.map((x: any) => x.key);
    expect(triggers).toEqual(HOOK_TRIGGERS.map((x) => x.key));
  });

  it('documents only paths that exist in the router (OpenAPI 3.1 + docs page)', async () => {
    const r = await t.api.raw('/api/openapi.json');
    expect(r.status).toBe(200);
    const spec = await r.json();
    expect(spec.openapi).toBe('3.1.0');
    const ops: string[] = [];
    for (const [path, methods] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(methods)) {
        ops.push(op.operationId);
        const concrete = path.replace(/\{(\w+)\}/g, 'x1');
        const found = t.app.router.match(method.toUpperCase(), concrete);
        expect(found, `${method.toUpperCase()} ${path}`).toBeTruthy();
        const docParts = path.split('/').filter(Boolean);
        const routeParts = found!.route.pattern.split('/').filter(Boolean);
        docParts.forEach((p, i) => {
          if (p.startsWith('{')) expect(routeParts[i].startsWith(':'), `${path} segment ${p}`).toBe(true);
          else expect(routeParts[i] === p || routeParts[i].startsWith(':'), `${path} segment ${p}`).toBe(true);
        });
      }
    }
    expect(new Set(ops).size).toBe(ops.length);
    expect(Object.keys(spec.paths).length).toBe(new Set(ROUTE_DOCS.map((d) => d.path)).size);
    for (const a of HOOK_ACTIONS) expect(spec.paths[`/api/hooks/actions/${a.key}`].post.requestBody).toBeTruthy();
    expect(spec.components.schemas.HookSubscriptionInput.properties.event.enum).toEqual(HOOK_TRIGGERS.map((x) => x.key));
    expect(spec.webhooks.restHook.post).toBeTruthy();
    expect(spec.paths['/hooks/in/{token}'].post.security).toEqual([]);

    const page = await t.api.raw('/api/docs.html');
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('API-Referenz');
    expect(html).toContain('/api/hooks/actions/create_contact');
    expect(html).not.toContain('<script');
  });

  it('receives inbound webhooks with field mapping, capture, signature and rate limit', async () => {
    await t.api.post('/api/custom-fields', { label: 'Budget', key: 'budget', type: 'number' });
    const wf = (await t.api.post('/api/workflows', { name: 'Shop', trigger: { type: 'webhook.received', config: {} }, steps: [{ type: 'add_tag', tags: ['webhook'] }] })).data;
    const cfg = (await t.api.get(`/api/inbound-webhooks/${wf.id}`)).data;
    expect(cfg.url).toMatch(/^http:\/\/localhost\/hooks\/in\/[\w-]{20,}$/);
    const path = new URL(cfg.url).pathname;
    const send = (body: unknown, headers: Record<string, string> = {}) => {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      return t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw }).then(async (r) => ({ status: r.status, data: await r.json() }));
    };
    const order = { order: { total: 4999, id: 'A-1' }, customer: { mail: 'Shop@Example.com', name: 'Sven Shop' }, labels: ['shop', 'neu'] };

    // workflow still a draft: payload is kept for the mapping screen, nothing runs
    expect((await send(order)).status).toBe(409);
    let view = (await t.api.get(`/api/inbound-webhooks/${wf.id}`)).data;
    expect(view.captures).toHaveLength(1);
    expect(view.captures[0].fields.map((f: any) => f.path)).toContain('customer.mail');
    expect(view.last_status).toContain('409');

    expect((await t.api.put(`/api/inbound-webhooks/${wf.id}`, { mapping: [{ from: 'x', to: 'custom.gibtsnicht' }] })).status).toBe(400);
    const mapping = [
      { from: 'customer.mail', to: 'email' },
      { from: 'customer.name', to: 'name' },
      { from: 'order.total', to: 'custom.budget' },
      { from: 'labels', to: 'tags' },
    ];
    view = (await t.api.put(`/api/inbound-webhooks/${wf.id}`, { mapping, tags: 'webshop' })).data;
    expect(view.mapping).toEqual(mapping);
    const preview = (await t.api.post(`/api/inbound-webhooks/${wf.id}/preview`, {})).data;
    expect(preview).toEqual({ contact: { email: 'Shop@Example.com', name: 'Sven Shop', custom: { budget: '4999' } }, tags: ['webshop', 'shop', 'neu'], ok: true });

    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const ok = await send(order);
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ ok: true, created: true, enrolled: true });
    const c = (await t.api.get(`/api/contacts/${ok.data.contactId}`)).data;
    expect(c).toMatchObject({ email: 'shop@example.com', first_name: 'Sven', last_name: 'Shop', custom: { budget: '4999' } });
    expect(c.tags).toEqual(expect.arrayContaining(['webshop', 'shop', 'neu', 'webhook']));
    expect((await send({ foo: 'bar' })).status).toBe(400);
    expect((await send('kein json', { 'content-type': 'text/plain' })).status).toBe(400);

    // capture mode: stored, workflow not started
    await t.api.put(`/api/inbound-webhooks/${wf.id}`, { capture: true });
    const cap = await send({ customer: { mail: 'cap@example.com' } });
    expect(cap.data).toEqual({ ok: true, captured: true });
    expect((await t.api.get('/api/contacts?q=cap@example.com')).data.total).toBe(0);
    await t.api.put(`/api/inbound-webhooks/${wf.id}`, { capture: false });

    // signature
    const sec = (await t.api.post(`/api/inbound-webhooks/${wf.id}/secret`, {})).data;
    expect(sec.secret).toMatch(/^whsec_/);
    expect(sec.signature.enabled).toBe(true);
    expect(JSON.stringify((await t.api.get(`/api/inbound-webhooks/${wf.id}`)).data)).not.toContain(sec.secret);
    const body = JSON.stringify({ customer: { mail: 'signed@example.com' } });
    expect((await send(body)).status).toBe(401);
    expect((await send(body, { 'x-signature-256': 'sha256=00' })).status).toBe(401);
    const sig = createHmac('sha256', sec.secret).update(body).digest('hex');
    expect((await send(body, { 'x-signature-256': `sha256=${sig}` })).status).toBe(200);
    expect((await send(body, { 'x-hub-signature-256': `sha256=${sig}` })).status).toBe(200);
    await t.api.post(`/api/inbound-webhooks/${wf.id}/secret`, { enabled: false });

    // rate limit per URL
    await t.api.put(`/api/inbound-webhooks/${wf.id}`, { rate_limit: 1 });
    const rotated = (await t.api.post(`/api/inbound-webhooks/${wf.id}/rotate`, {})).data;
    expect(rotated.url).not.toBe(cfg.url);
    expect((await send(order)).status).toBe(404);
    const path2 = new URL(rotated.url).pathname;
    const s1 = await t.api.raw(path2, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(order) });
    const s2 = await t.api.raw(path2, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(order) });
    expect([s1.status, s2.status]).toEqual([200, 429]);
    expect((await t.api.get('/api/workflows/meta')).data.triggers).toContain('webhook.received');
  });

  it('shows live status in the catalogue (sub-account and agency)', async () => {
    let cat = (await t.api.get('/api/integrations/catalog')).data;
    const item = (k: string) => cat.items.find((i: any) => i.key === k);
    expect(item('stripe')).toMatchObject({ status: 'missing', category: 'Zahlungen', setup: { location: 'settings/stripe' } });
    expect(item('email').status).toBe('missing');
    expect(item('todoist').status).toBe('missing');
    expect(item('postiz').status).toBe('missing');
    expect(item('inbound_webhooks').status).toBe('ok');
    t.app.db.run(`INSERT INTO stripe_accounts (location_id, secret_key, key_hint, account_name, updated_at) VALUES (?, 'v1:x', '…1234', 'Testfirma GmbH', ?)`, loc, new Date().toISOString());
    await t.api.patch('/api/location', { settings: { email: { provider: 'smtp', host: 'smtp.example.com' } } });
    await keyCall('POST', '/api/hooks', { target_url: 'https://hooks.zapier.com/hooks/x', event: 'any', events: 'form.submitted, invoice.paid' });
    cat = (await t.api.get('/api/integrations/catalog')).data;
    expect(item('stripe')).toMatchObject({ status: 'partial' });
    expect(item('stripe').detail).toContain('Webhook-Secret fehlt');
    expect(item('email')).toMatchObject({ status: 'ok', detail: 'Versand über SMTP' });
    expect(item('zapier').status).toBe('ok');
    expect(item('make').status).toBe('info');
    expect(item('mcp').status).toBe('ok');
    expect(cat.items.every((i: any) => ['ok', 'partial', 'missing', 'info', 'unavailable'].includes(i.status))).toBe(true);
    expect(cat.items.filter((i: any) => i.status === 'unavailable').map((i: any) => i.key)).toEqual([]);

    const agency = (await t.api.get('/api/agency/integrations/catalog')).data;
    const a = (k: string) => agency.items.find((i: any) => i.key === k);
    expect(a('stripe').detail).toBe('0 von 1 Sub-Account eingerichtet, 1 unvollständig');
    expect(a('email').detail).toContain('1 von 1 Sub-Account eingerichtet');
    expect(a('mcp')).toMatchObject({ status: 'ok' });

    // a client login only sees agency items as "Agentur"
    await t.api.post('/api/users', { email: 'kunde@example.com', password: 'geheim123', locations: [loc], permissions: ['settings', 'contacts'] });
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'kunde@example.com', password: 'geheim123' });
    const member = (await t.api.get('/api/integrations/catalog')).data;
    expect(member.items.find((i: any) => i.key === 'todoist')).toMatchObject({ status: 'info', detail: 'Wird von der Agentur eingerichtet' });
    expect(member.items.find((i: any) => i.key === 'stripe').status).toBe('partial');
    expect((await t.api.get('/api/agency/integrations/catalog')).status).toBe(403);
  });
});
