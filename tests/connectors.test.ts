import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTE_DOCS } from '../server/services/openapi.js';
import { HOOK_ACTIONS, HOOK_TRIGGERS } from '../server/services/rest-hooks.js';
import { startTestApp } from './helpers.js';

/** The ready-made connectors under integrations/ (Zapier app, Make custom app, n8n templates). */

const ROOT = join(import.meta.dirname, '..', 'integrations');
const require = createRequire(import.meta.url);
const Zapier = require(join(ROOT, 'zapier', 'index.js'));
const json = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const files = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.json') || f.endsWith('.imljson'));
const serverFields = (key: string) => HOOK_ACTIONS.find((a) => a.key === key)!.fields.map((f) => f.key);
const documented = (path: string) => ROUTE_DOCS.some((d) => new RegExp(`^${d.path.replace(/\{\w+\}/g, '[^/]+')}$`).test(path));

class ZapierError extends Error {
  constructor(
    message: string,
    public code?: string,
    public status?: number,
  ) {
    super(message);
  }
}

/** A tiny stand-in for Zapier's `z` that really calls the test server. */
function liveZ(base: string, bundle: any) {
  const z: any = {
    errors: { Error: ZapierError },
    request: async (opts: any) => {
      let req = { method: 'GET', headers: {}, ...opts };
      for (const fn of Zapier.beforeRequest) req = fn(req, z, bundle);
      const url = new URL(req.url.replace('https://crm.example.com', base));
      for (const [k, v] of Object.entries(req.params ?? {})) url.searchParams.set(k, String(v));
      const r = await fetch(url, { method: req.method, headers: req.headers, body: req.body ? JSON.stringify(req.body) : undefined });
      const content = await r.text();
      let res: any = { status: r.status, content, data: content ? JSON.parse(content) : null, request: req };
      for (const fn of Zapier.afterResponse) res = fn(res, z, bundle);
      return res;
    },
  };
  return z;
}

describe('connectors: Zapier app', () => {
  it('loads without zapier-platform-core and mirrors the server catalogue', () => {
    expect(Zapier.version).toBe('1.0.0');
    expect(Zapier.platformVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(Zapier.authentication.fields.map((f: any) => f.key)).toEqual(['base_url', 'api_key', 'location_id']);
    const hooks = Object.values<any>(Zapier.triggers).filter((t) => !t.display.hidden);
    expect(hooks.map((t) => (t.operation.performSubscribe ? t.key : null)).every(Boolean)).toBe(true);
    const defs = require(join(ROOT, 'zapier', 'lib', 'definitions.js'));
    expect(defs.TRIGGERS.map((x: any) => x.event)).toEqual(HOOK_TRIGGERS.map((x) => x.key));
    expect(hooks).toHaveLength(HOOK_TRIGGERS.length);
    for (const t of hooks) {
      expect(t.key).toMatch(/^[a-z_]+$/);
      expect(t.operation.sample.id).toBeTruthy();
      expect(t.display.label.length).toBeGreaterThan(3);
    }
    expect(Object.keys(Zapier.creates).sort()).toEqual(HOOK_ACTIONS.map((a) => a.key).sort());
    for (const c of Object.values<any>(Zapier.creates)) {
      for (const f of c.operation.inputFields) expect(serverFields(c.key), `${c.key}.${f.key}`).toContain(f.key);
    }
    for (const t of Object.values<any>(Zapier.triggers).filter((x) => x.display.hidden)) expect(typeof t.operation.perform).toBe('function');
    const dynamics = JSON.stringify([...Object.values(Zapier.creates), ...hooks]).match(/"dynamic":"(\w+)\.id\.name"/g) ?? [];
    for (const d of dynamics) expect(Zapier.triggers[d.split('"')[3].split('.')[0]], d).toBeTruthy();
    expect(Zapier.searchOrCreates.find_contact).toMatchObject({ search: 'find_contact', create: 'create_contact' });
  });

  describe('against a live test server', () => {
    let t: Awaited<ReturnType<typeof startTestApp>>;
    let bundle: any;
    beforeAll(async () => {
      t = await startTestApp();
      await t.setup();
      t.app.services.restHookFetch = async () => ({ status: 200, ok: true, headers: {}, text: async () => 'ok' });
      const key = (await t.api.post('/api/api-keys', { name: 'Zapier' })).data.key;
      bundle = { authData: { base_url: 'https://crm.example.com/', api_key: key }, inputData: {}, targetUrl: 'https://hooks.zapier.com/hooks/standard/1/2/' };
    });
    afterAll(async () => t.close());

    it('tests the connection, subscribes, lists samples, runs actions and unsubscribes', async () => {
      const z = liveZ(t.base, bundle);
      expect((await Zapier.authentication.test(z, bundle)).location.name).toBe('Testfirma');
      const op = Zapier.triggers.contact_tagged.operation;
      const sub = await op.performSubscribe(z, { ...bundle, inputData: { tag: 'vip' } });
      expect(sub).toMatchObject({ event: 'contact.tagged', source: 'zapier', filters: { tag: 'vip' } });
      expect((await op.performList(z, bundle))[0].sample).toBe(true);
      const contact = await Zapier.creates.add_tag.operation.perform(z, { ...bundle, inputData: { email: 'zap@example.com', tags: ['vip'], phone: '' } });
      expect(contact.tags).toEqual(['vip']);
      await t.app.events.flush();
      const log = await t.api.get(`/api/hooks/deliveries?hook_id=${sub.id}`);
      expect(log.data.deliveries[0]).toMatchObject({ status: 'success', event: 'contact.tagged' });
      const found = await Zapier.searches.find_contact.operation.perform(z, { ...bundle, inputData: { email: 'zap@example.com' } });
      expect(found[0].id).toBe(contact.id);
      const pipes = await Zapier.triggers.stage_list.operation.perform(z, bundle);
      expect(pipes[0].name).toBe('Vertrieb → Neuer Lead');
      const inv = await Zapier.creates.create_invoice_draft.operation.perform(z, { ...bundle, inputData: { email: 'zap@example.com', items: [{ name: 'Setup', qty: 1, price: 99 }] } });
      expect(inv.status).toBe('draft');
      await op.performUnsubscribe(z, { ...bundle, subscribeData: { id: sub.id } });
      expect(await op.performUnsubscribe(z, { ...bundle, subscribeData: { id: sub.id } })).toEqual({});
      expect((await t.api.get('/api/hooks')).data).toHaveLength(0);
      await expect(Zapier.authentication.test(liveZ(t.base, { authData: { ...bundle.authData, api_key: 'pghl_falsch' } }), bundle)).rejects.toThrow('Ungültiger API-Schlüssel');
    });
  });
});

describe('connectors: Make custom app', () => {
  const modules = Object.fromEntries(files('make/modules').map((f) => [f.replace('.json', ''), json(`make/modules/${f}`)]));
  const rpcs = Object.fromEntries(files('make/rpcs').map((f) => [f.replace('.json', ''), json(`make/rpcs/${f}`)]));

  it('has base, connection and a dedicated webhook that subscribes/unsubscribes REST hooks', () => {
    const base = json('make/base.imljson');
    expect(base.baseUrl).toBe('{{connection.baseUrl}}');
    expect(base.headers.authorization).toBe('Bearer {{connection.apiKey}}');
    const conn = json('make/connections/gohigh.json');
    expect(conn.parameters.map((p: any) => p.name)).toEqual(['baseUrl', 'apiKey', 'locationId']);
    expect(conn.communication.url).toBe('{{parameters.baseUrl}}/api/hooks/me');
    const hook = json('make/webhooks/gohigh_event.json');
    expect(hook.type).toBe('dedicated');
    expect(hook.attach).toMatchObject({ url: '{{connection.baseUrl}}/api/hooks', method: 'POST', body: { target_url: '{{webhook.url}}', source: 'make' }, response: { data: { externalHookId: '{{body.id}}' } } });
    expect(hook.detach).toMatchObject({ url: '{{connection.baseUrl}}/api/hooks/{{webhook.externalHookId}}', method: 'DELETE' });
    expect(hook.parameters[0].options.map((o: any) => o.value)).toEqual(HOOK_TRIGGERS.map((x) => x.key));
  });

  it('modules cover every action, use valid endpoints and existing RPCs', () => {
    for (const [name, m] of Object.entries<any>(modules)) {
      expect(m.name).toBe(name);
      expect([4, 9, 10]).toContain(m.typeId);
      expect(m.label).toBeTruthy();
      if (m.typeId === 10) expect(m.webhook).toBe('gohigh_event');
      else expect(documented(m.communication.url), m.communication.url).toBe(true);
      if (m.typeId === 4) {
        const key = m.communication.url.split('/').pop();
        for (const p of m.expect) expect(serverFields(key), `${name}.${p.name}`).toContain(p.name);
      }
    }
    const actions = Object.values<any>(modules).filter((m) => m.typeId === 4).map((m) => m.communication.url.split('/').pop());
    expect(actions.sort()).toEqual(HOOK_ACTIONS.map((a) => a.key).sort());
    const refs = JSON.stringify([modules, json('make/webhooks/gohigh_event.json')]).match(/rpc:\/\/(\w+)/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(rpcs[r.slice(6)], r).toBeTruthy();
    for (const r of Object.values<any>(rpcs)) expect(documented(r.communication.url)).toBe(true);
    for (const g of json('make/app.json').groups) for (const m of g.modules) expect(modules[m], m).toBeTruthy();
  });
});

describe('connectors: n8n templates', () => {
  const ALLOWED = ['n8n-nodes-base.webhook', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.manualTrigger'];
  it.each(files('n8n'))('%s is an importable workflow', (f) => {
    const wf = json(`n8n/${f}`);
    expect(wf.name).toMatch(/^HyperLevel: /);
    const names = wf.nodes.map((n: any) => n.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of wf.nodes) {
      expect(ALLOWED).toContain(n.type);
      expect(n.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(n.position).toHaveLength(2);
      if (n.type === 'n8n-nodes-base.webhook') expect(n.parameters.path && n.webhookId).toBeTruthy();
      if (n.type === 'n8n-nodes-base.httpRequest') {
        expect(n.parameters.url.startsWith('https://DEINE-DOMAIN/api/')).toBe(true);
        expect(documented(n.parameters.url.replace('https://DEINE-DOMAIN', '')), n.parameters.url).toBe(true);
        expect(n.credentials.httpHeaderAuth.name).toBe('HyperLevel API');
        if (n.parameters.jsonBody && !n.parameters.jsonBody.startsWith('=')) expect(() => JSON.parse(n.parameters.jsonBody)).not.toThrow();
      }
    }
    for (const [from, c] of Object.entries<any>(wf.connections)) {
      expect(names).toContain(from);
      for (const out of c.main.flat()) expect(names).toContain(out.node);
    }
    const sub = wf.nodes.find((n: any) => n.parameters.url?.endsWith('/api/hooks'));
    if (sub) expect(HOOK_TRIGGERS.map((x) => x.key)).toContain(JSON.parse(sub.parameters.jsonBody).event);
  });
});
