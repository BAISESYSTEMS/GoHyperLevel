'use strict';

// Runs without installing anything: `npm test` (node --test). Zapier's `zapier test` calls it too.
const test = require('node:test');
const assert = require('node:assert');
const App = require('../index');

class ZapierError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const fakeZ = (reply = () => ({ status: 200, data: {} })) => {
  const calls = [];
  return {
    calls,
    errors: { Error: ZapierError },
    request: async (opts) => {
      const req = App.beforeRequest.reduce((r, fn) => fn(r, fakeZ, bundle), { headers: {}, ...opts });
      calls.push(req);
      const res = { request: req, ...reply(req) };
      return App.afterResponse.reduce((r, fn) => fn(r, { errors: { Error: ZapierError } }), res);
    },
  };
};
const bundle = { authData: { base_url: 'https://crm.example.com/', api_key: 'pghl_test', location_id: '' }, inputData: {}, targetUrl: 'https://hooks.zapier.com/1/2/' };

test('app definition is complete', () => {
  assert.ok(App.version && App.platformVersion);
  assert.strictEqual(App.authentication.type, 'custom');
  for (const t of Object.values(App.triggers)) {
    if (t.display.hidden) continue;
    assert.strictEqual(t.operation.type, 'hook', t.key);
    for (const fn of ['performSubscribe', 'performUnsubscribe', 'perform', 'performList']) assert.strictEqual(typeof t.operation[fn], 'function', `${t.key}.${fn}`);
    assert.ok(t.operation.sample.id, t.key);
  }
  assert.ok(Object.keys(App.creates).length >= 10);
  assert.ok(App.searchOrCreates.find_contact);
});

test('subscribe, unsubscribe and perform', async () => {
  const z = fakeZ((req) => ({ status: 200, data: req.method === 'POST' ? { id: 'hook_1' } : { ok: true } }));
  const t = App.triggers.contact_tagged.operation;
  const sub = await t.performSubscribe(z, { ...bundle, inputData: { tag: 'vip' } });
  assert.deepStrictEqual(sub, { id: 'hook_1' });
  assert.strictEqual(z.calls[0].url, 'https://crm.example.com/api/hooks');
  assert.strictEqual(z.calls[0].headers.Authorization, 'Bearer pghl_test');
  assert.deepStrictEqual(z.calls[0].body.filters, { tag: 'vip' });
  assert.strictEqual(z.calls[0].body.event, 'contact.tagged');
  await t.performUnsubscribe(z, { ...bundle, subscribeData: { id: 'hook_1' } });
  assert.strictEqual(z.calls[1].method, 'DELETE');
  assert.deepStrictEqual(t.perform(z, { ...bundle, cleanedRequest: { id: 'evt_1' } }), [{ id: 'evt_1' }]);
});

test('errors become readable messages', async () => {
  const z = fakeZ(() => ({ status: 401, data: { error: 'Ungültiger API-Schlüssel' } }));
  await assert.rejects(App.authentication.test(z, bundle), /Ungültiger API-Schlüssel/);
});
