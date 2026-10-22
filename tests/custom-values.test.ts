import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { render } from '../server/core/template.js';
import { cleanKey, fillHtml, keyFromName, locationOfData, referencedKeys } from '../server/services/custom-values.js';
import { runWorkflow } from './wfx-helpers.js';

/** Custom Values: global placeholders per sub-account – resolution in the central renderer, isolation, pages, snapshots, form targets, MCP. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let B = '';
const inLoc = async <T>(loc: string, fn: () => Promise<T>): Promise<T> => {
  const before = t.api.location;
  t.api.setLocation(loc);
  try {
    return await fn();
  } finally {
    t.api.setLocation(before);
  }
};

beforeAll(async () => {
  process.env.PGHL_FORMS_PER_MINUTE = '10000';
  t = await startTestApp();
  await t.setup();
  A = t.api.location;
  B = (await t.api.post('/api/locations', { name: 'Firma B' })).data.id;
}, 60_000);
afterAll(async () => {
  delete process.env.PGHL_FORMS_PER_MINUTE;
  await t.close();
});

describe('pure rules', () => {
  it('derives keys from names and checks them', () => {
    expect(keyFromName('Telefon Hotline')).toBe('telefon_hotline');
    expect(keyFromName('Öffnungszeiten (Sa.)')).toBe('oeffnungszeiten_sa');
    expect(keyFromName('24h-Service')).toBe('v_24h_service');
    expect(cleanKey('Firma_Name')).toBe('firma_name');
    expect(cleanKey('1abc')).toBeNull();
    expect(cleanKey('a-b')).toBeNull();
    expect(cleanKey({})).toBeNull();
  });

  it('finds the sub-account in template data and the keys a text uses', () => {
    expect(locationOfData({ location: { id: 'loc_1234' } })).toBe('loc_1234');
    expect(locationOfData({ contact: { location_id: 'loc_5678' } })).toBe('loc_5678');
    expect(locationOfData({ invoice: { location_id: 'loc_9999' } })).toBe('loc_9999');
    expect(locationOfData({ location: { name: 'ohne id' } })).toBe('');
    expect(referencedKeys({ a: 'Ruf an: {{custom_values.telefon}} oder {{ custom_values.mail | info@x.de }}', b: '{{contact.first_name}}' })).toEqual(['telefon', 'mail']);
  });

  it('fills a finished page escaped, with fallbacks', () => {
    const html = '<p>Tel: {{custom_values.tel}}</p><a href="tel:{{custom_values.tel}}">x</a><p>{{custom_values.leer|Standard &amp; mehr}}</p><p>{{custom_values.fehlt}}</p>';
    const out = fillHtml(html, (k) => ({ tel: '0800 <b>1</b>', leer: '' })[k]);
    expect(out).toBe('<p>Tel: 0800 &lt;b&gt;1&lt;/b&gt;</p><a href="tel:0800 &lt;b&gt;1&lt;/b&gt;">x</a><p>Standard &amp; mehr</p><p></p>');
    expect(fillHtml('<p>nichts</p>', () => 'x')).toBe('<p>nichts</p>');
  });
});

describe('managing values', () => {
  it('creates, lists with folders, edits and deletes – keys unique per sub-account', async () => {
    const tel = await t.api.post('/api/custom-values', { name: 'Telefon Hotline', value: '0800 111 222', folder: 'Kontakt' });
    expect(tel.status).toBe(200);
    expect(tel.data).toMatchObject({ key: 'telefon_hotline', placeholder: '{{custom_values.telefon_hotline}}', folder: 'Kontakt', needs_value: false });
    expect((await t.api.post('/api/custom-values', { name: 'Telefon Hotline', value: 'x' })).status).toBe(409);
    expect((await t.api.post('/api/custom-values', { name: 'Kaputt', key: '9-x', value: 'x' })).status).toBe(400);
    expect((await t.api.post('/api/custom-values', { name: 'Zu lang', value: 'x'.repeat(5001) })).status).toBe(400);
    expect((await t.api.post('/api/custom-values', { name: { x: 1 }, value: 'x' })).status).toBe(400);
    await t.api.post('/api/custom-values', { name: 'Firma', key: 'firma', value: 'Muster & Söhne GmbH' });
    const list = (await t.api.get('/api/custom-values')).data;
    expect(list.values.map((v: any) => v.key)).toEqual(['firma', 'telefon_hotline']);
    expect(list.folders).toEqual(['Kontakt']);
    const edited = await t.api.patch(`/api/custom-values/${tel.data.id}`, { value: '0800 333 444', name: 'Hotline' });
    expect(edited.data).toMatchObject({ value: '0800 333 444', name: 'Hotline', key: 'telefon_hotline' });
    const up = await t.api.put('/api/custom-values/by-key/oeffnungszeiten', { value: 'Mo–Fr 8–17 Uhr', folder: 'Kontakt' });
    expect(up.data).toMatchObject({ key: 'oeffnungszeiten', value: 'Mo–Fr 8–17 Uhr' });
    expect((await t.api.put('/api/custom-values/by-key/oeffnungszeiten', { value: 'Mo–Sa 8–18 Uhr' })).data.value).toBe('Mo–Sa 8–18 Uhr');
    const temp = (await t.api.post('/api/custom-values', { name: 'Weg damit', value: '1' })).data;
    expect((await t.api.del(`/api/custom-values/${temp.id}`)).data).toEqual({ ok: true, key: 'weg_damit' });
    expect((await t.api.del(`/api/custom-values/${temp.id}`)).status).toBe(404);
  });

  it('keeps sub-accounts apart: same key, own value, no access to the other one', async () => {
    const own = (await inLoc(B, () => t.api.post('/api/custom-values', { name: 'Telefon Hotline', value: '0900 999 999' }))).data;
    expect(own.key).toBe('telefon_hotline');
    expect((await t.api.get('/api/custom-values')).data.values.find((v: any) => v.key === 'telefon_hotline').value).toBe('0800 333 444');
    // A's session pointed at B's row
    expect((await t.api.patch(`/api/custom-values/${own.id}`, { value: 'gehackt' })).status).toBe(404);
    expect((await t.api.del(`/api/custom-values/${own.id}`)).status).toBe(404);
    expect((await inLoc(B, () => t.api.get('/api/custom-values'))).data.values.map((v: any) => v.value)).toEqual(['0900 999 999']);
    // the renderer answers with the value of the sub-account the data belongs to
    expect(render('Ruf an: {{custom_values.telefon_hotline}}', { location: t.app.location(A)! })).toBe('Ruf an: 0800 333 444');
    expect(render('Ruf an: {{custom_values.telefon_hotline}}', { location: t.app.location(B)! })).toBe('Ruf an: 0900 999 999');
    expect(render('Ruf an: {{custom_values.telefon_hotline}}', { contact: { location_id: B } })).toBe('Ruf an: 0900 999 999');
    // no sub-account in the data, unknown key, fallback
    expect(render('Ruf an: {{custom_values.telefon_hotline|später}}', {})).toBe('Ruf an: später');
    expect(render('Hallo {{custom_values.gibt_es_nicht}}!', { location: t.app.location(A)! })).toBe('Hallo!');
    // data that brings its own custom_values wins
    expect(render('{{custom_values.firma}}', { custom_values: { firma: 'Eigen' }, location: t.app.location(A)! })).toBe('Eigen');
  });

  it('previews a text the way the sub-account sends it', async () => {
    const r = await t.api.post('/api/custom-values/preview', { text: '{{custom_values.firma}} · {{custom_values.oeffnungszeiten}} · {{location.name}}' });
    expect(r.data.text).toMatch(/^Muster & Söhne GmbH · Mo–Sa 8–18 Uhr · /);
    expect(r.data.keys).toEqual(['firma', 'oeffnungszeiten']);
  });
});

describe('everywhere merge fields work', () => {
  it('e-mail and SMS steps of a workflow', async () => {
    const r = await runWorkflow(t, [
      { type: 'send_email', subject: 'Hallo von {{custom_values.firma}}', body: 'Erreichbar unter {{custom_values.telefon_hotline}} ({{custom_values.oeffnungszeiten}}).' },
      { type: 'send_sms', body: 'Fragen? {{custom_values.telefon_hotline}}' },
    ], { contact: { phone: '+4915112345678' } });
    const msgs = t.app.db.all<any>(`SELECT channel, subject, body FROM messages WHERE contact_id = ? AND direction = 'out' ORDER BY created_at`, r.contact.id);
    const mail = msgs.find((m) => m.channel === 'email');
    const sms = msgs.find((m) => m.channel === 'sms');
    expect(mail.subject).toBe('Hallo von Muster & Söhne GmbH');
    expect(mail.body).toContain('Erreichbar unter 0800 333 444 (Mo–Sa 8–18 Uhr).');
    expect(sms.body).toBe('Fragen? 0800 333 444');
  });

  it('the same workflow in another sub-account sends that sub-account’s value', async () => {
    const r = await inLoc(B, () => runWorkflow(t, [{ type: 'send_sms', body: 'Fragen? {{custom_values.telefon_hotline}}' }], { contact: { phone: '+4915187654321' } }));
    const sms = t.app.db.get<any>(`SELECT body FROM messages WHERE contact_id = ? AND direction = 'out'`, r.contact.id);
    expect(sms.body).toBe('Fragen? 0900 999 999');
  });

  it('documents (contracts) freeze the value on send', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'vertrag@kunde.de', first_name: 'Uwe' })).data;
    const k = (await t.api.post('/api/contracts', { kind: 'contract', contact_id: c.id, title: 'Vertrag mit {{custom_values.firma}}', content: 'Hotline: {{custom_values.telefon_hotline}}' })).data;
    const sent = (await t.api.post(`/api/contracts/${k.id}/send`, {})).data;
    expect(sent.title).toBe('Vertrag mit Muster & Söhne GmbH');
    expect(sent.content).toBe('Hotline: 0800 333 444');
  });

  it('published pages, escaped – and each site shows its own sub-account’s value', async () => {
    const site = (await t.api.post('/api/funnels', { name: 'CV-Seite', kind: 'funnel', template: 'blank' })).data;
    await t.api.patch(`/api/funnel-pages/${site.pages[0].id}`, { blocks: [{ id: 'h1', type: 'hero', heading: 'Willkommen bei {{custom_values.firma}}', subheading: 'Hotline {{custom_values.telefon_hotline}}', button_text: 'Anrufen', button_url: 'tel:{{custom_values.telefon_hotline}}' }] });
    const html = String((await t.api.raw(`/p/${site.slug}`).then((r) => r.text())));
    expect(html).toContain('Willkommen bei Muster &amp; Söhne GmbH');
    expect(html).toContain('Hotline 0800 333 444');
    expect(html).not.toContain('custom_values');
    const other = (await inLoc(B, () => t.api.post('/api/funnels', { name: 'CV-Seite B', kind: 'funnel', template: 'blank' }))).data;
    await inLoc(B, () => t.api.patch(`/api/funnel-pages/${other.pages[0].id}`, { blocks: [{ id: 'h1', type: 'hero', heading: 'Hotline {{custom_values.telefon_hotline}}' }] }));
    const htmlB = await t.api.raw(`/p/${other.slug}`).then((r) => r.text());
    expect(htmlB).toContain('Hotline 0900 999 999');
  });
});

describe('form target „Custom Value setzen“', () => {
  it('sets a value from a form field, only for forms of the same sub-account', async () => {
    const form = (await t.api.post('/api/forms', { name: 'Aktion', fields: [{ id: 'f1', type: 'email', label: 'E-Mail', name: 'email', required: true }, { id: 'f2', type: 'text', label: 'Aktionscode', name: 'code' }] })).data;
    await t.api.post('/api/custom-values', { name: 'Aktionscode', value: 'ALT' });
    expect((await t.api.post('/api/custom-values/form-targets', { form_id: form.id, field_id: 'f9', value_key: 'aktionscode' })).status).toBe(400);
    expect((await t.api.post('/api/custom-values/form-targets', { form_id: form.id, field_id: 'f2', value_key: 'unbekannt' })).status).toBe(400);
    expect((await inLoc(B, () => t.api.post('/api/custom-values/form-targets', { form_id: form.id, field_id: 'f2', value_key: 'telefon_hotline' }))).status).toBe(404);
    const target = await t.api.post('/api/custom-values/form-targets', { form_id: form.id, field_id: 'f2', value_key: 'aktionscode' });
    expect(target.data).toMatchObject({ form_name: 'Aktion', field_label: 'Aktionscode', value_key: 'aktionscode' });
    expect((await t.api.post('/api/custom-values/form-targets', { form_id: form.id, field_id: 'f2', value_key: 'aktionscode' })).status).toBe(409);
    expect((await t.api.get('/api/custom-values/form-targets')).data).toHaveLength(1);
    expect((await inLoc(B, () => t.api.get('/api/custom-values/form-targets'))).data).toHaveLength(0);
    const sub = await t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'aktion@example.com', code: 'HERBST26' }) });
    expect(sub.status, await sub.text()).toBe(200);
    await t.app.events.flush();
    expect((await t.api.get('/api/custom-values')).data.values.find((v: any) => v.key === 'aktionscode').value).toBe('HERBST26');
    expect((await inLoc(B, () => t.api.del(`/api/custom-values/form-targets/${target.data.id}`))).status).toBe(404);
    expect((await t.api.del(`/api/custom-values/form-targets/${target.data.id}`)).data).toEqual({ ok: true });
  });
});

describe('snapshots carry placeholders', () => {
  it('exports keys without values (unless marked) and the client fills them after loading', async () => {
    const firma = (await t.api.get('/api/custom-values')).data.values.find((v: any) => v.key === 'firma');
    await t.api.patch(`/api/custom-values/${firma.id}`, { description: 'Name der Firma, wie er in Mails steht' });
    const hours = (await t.api.get('/api/custom-values')).data.values.find((v: any) => v.key === 'oeffnungszeiten');
    await t.api.patch(`/api/custom-values/${hours.id}`, { in_snapshot: true });
    const snap = await t.api.post('/api/snapshots', { location_id: A, name: 'Mit Platzhaltern' });
    expect(snap.status).toBe(200);
    const data = (await t.api.get(`/api/snapshots/${snap.data.id}/download`)).data;
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    const items = parsed.custom_values as any[];
    expect(items.find((x) => x.key === 'firma')).toMatchObject({ value: '', description: 'Name der Firma, wie er in Mails steht', in_snapshot: false });
    expect(items.find((x) => x.key === 'oeffnungszeiten')).toMatchObject({ value: 'Mo–Sa 8–18 Uhr', in_snapshot: true });
    expect(JSON.stringify(items)).not.toContain('0800 333 444');

    const client = (await t.api.post('/api/agency/clients', { name: 'Kunde C', snapshot_id: snap.data.id })).data.location.id;
    const after = (await inLoc(client, () => t.api.get('/api/custom-values'))).data;
    expect(after.values.find((v: any) => v.key === 'firma')).toMatchObject({ value: '', needs_value: true, description: 'Name der Firma, wie er in Mails steht' });
    expect(after.values.find((v: any) => v.key === 'oeffnungszeiten')).toMatchObject({ value: 'Mo–Sa 8–18 Uhr', needs_value: false });
    expect(after.pending).toBeGreaterThanOrEqual(2);
    const id = after.values.find((v: any) => v.key === 'firma').id;
    const filled = (await inLoc(client, () => t.api.patch(`/api/custom-values/${id}`, { value: 'Kunde C GmbH' }))).data;
    expect(filled).toMatchObject({ value: 'Kunde C GmbH', needs_value: false });
    expect(render('{{custom_values.firma}}', { location: t.app.location(client)! })).toBe('Kunde C GmbH');
  });

  it('copying one website takes the values its pages use', async () => {
    const target = (await t.api.post('/api/agency/clients', { name: 'Kunde D' })).data.location.id;
    const site = (await t.api.get('/api/funnels')).data.find((f: any) => f.name === 'CV-Seite');
    const r = await t.api.post(`/api/funnels/${site.id}/copy`, { location_id: target });
    expect(r.status).toBe(200);
    const keys = (await inLoc(target, () => t.api.get('/api/custom-values'))).data.values.map((v: any) => v.key).sort();
    expect(keys).toEqual(['firma', 'telefon_hotline']);
  });
});

describe('MCP', () => {
  it('lists and sets values through the tools', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'CV' })).data.key;
    const rpc = async (name: string, args: unknown) => {
      const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      const j = await r.json();
      return JSON.parse(j.result.content[0].text);
    };
    const set = await rpc('ghl_custom_value_set', { location_id: A, key: 'Rabatt Code', value: 'GOHIGH10', folder: 'Aktionen' });
    expect(set).toMatchObject({ key: 'rabatt_code', value: 'GOHIGH10', folder: 'Aktionen' });
    const listed = await rpc('ghl_custom_values', { location_id: A, folder: 'Aktionen' });
    expect(listed.values.map((v: any) => v.key)).toEqual(['rabatt_code']);
    const other = await rpc('ghl_custom_values', { location_id: B });
    expect(other.values.map((v: any) => v.key)).toEqual(['telefon_hotline']);
  });
});
