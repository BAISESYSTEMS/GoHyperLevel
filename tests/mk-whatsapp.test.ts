import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { cleanWaTemplate, isMarketing } from '../server/services/mk-whatsapp.js';

const WA_TOKEN = 'EAAGwatoken' + 'x'.repeat(40);
const calls: { method: string; path: string; body: any }[] = [];
let outN = 0;
const TEMPLATES = [
  { name: 'angebot_herbst', language: 'de', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hallo {{1}}, unser Herbstangebot: {{2}}', example: { body_text: [['Anna', '20 %']] } }] },
  { name: 'termin_info', language: 'de', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hallo {{1}}, hier sind die Infos zu deinem Termin.' }] },
  { name: 'code_123', language: 'de', status: 'APPROVED', category: 'AUTHENTICATION', components: [{ type: 'BODY', text: 'Dein Code ist {{1}}' }] },
  { name: 'standort', language: 'de', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'HEADER', format: 'LOCATION' }, { type: 'BODY', text: 'Komm vorbei' }] },
  { name: 'abgelehnt', language: 'de', status: 'REJECTED', category: 'MARKETING', components: [{ type: 'BODY', text: 'x' }] },
];
const fake = async (input: string, init: RequestInit = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '');
  calls.push({ method, path, body });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  const auth = (init.headers as any)?.authorization;
  if (auth !== `Bearer ${WA_TOKEN}`) return json({ error: { message: 'Invalid OAuth access token', code: 190 } }, 401);
  if (method === 'GET' && path === '1111') return json({ id: '1111', display_phone_number: '+49 30 123456', verified_name: 'Malerei', quality_rating: 'GREEN' });
  if (method === 'GET' && path === '2222') return json({ id: '2222', name: 'WABA' });
  if (method === 'GET' && path === '2222/message_templates') return json({ data: TEMPLATES });
  if (method === 'POST' && path === '1111/messages') {
    if (body.to === '4915199999999') return json({ error: { message: '(#131026) Message Undeliverable.', code: 131026 } }, 400);
    return json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.OUT${++outN}` }] });
  }
  return json({ error: { message: `unknown ${method} ${path}`, code: 100 } }, 400);
};
const sends = () => calls.filter((c) => c.method === 'POST' && c.path === '1111/messages');

describe('WhatsApp template settings', () => {
  it('cleans the setting from the browser', () => {
    expect(cleanWaTemplate(null)).toBeNull();
    expect(() => cleanWaTemplate({ name: '' })).toThrow(/Name fehlt/);
    expect(cleanWaTemplate({ name: ' angebot ', language: 'de', category: 'AUTHENTICATION', values: { 'body.1': 'Hallo', 'evil key': 'x', 'body.2': 5, 'header.media': 'https://x.de/a.jpg' } })).toEqual({ name: 'angebot', language: 'de', values: { 'body.1': 'Hallo', 'body.2': '5', 'header.media': 'https://x.de/a.jpg' } });
    // the category is never taken from the browser
    expect(cleanWaTemplate({ name: 'a', category: 'UTILITY' })).not.toHaveProperty('category');
    expect(isMarketing({ category: 'MARKETING' })).toBe(true);
    expect(isMarketing({ category: 'utility' })).toBe(false);
    expect(isMarketing(undefined)).toBe(true);
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.metaFetch = fake;
  await t.setup();
  loc = t.api.location;
  expect((await t.api.put('/api/settings/meta', { wa_phone_number_id: '1111', wa_business_account_id: '2222', wa_token: WA_TOKEN })).status).toBe(200);
  await t.api.put('/api/consent/settings', { policy: 'confirmed' });
  const mk = async (key: string, body: Record<string, unknown>) => (ids[key] = (await t.api.post('/api/contacts', { first_name: key, tags: ['wa'], ...body })).data.id);
  await mk('Anna', { phone: '+4915112345601', consent: { channels: ['whatsapp'] } });
  await mk('Ben', { phone: '+4915112345602' }); // no consent
  await mk('Carla', { phone: '+4915112345603', consent: { channels: ['whatsapp'] } });
  await t.api.patch(`/api/contacts/${ids.Carla}`, { dnd: true });
  await mk('Dirk', { email: 'dirk@kunde.example', consent: { channels: ['email'] } }); // no phone
  await mk('Eva', { phone: '+4915199999999', consent: { channels: ['whatsapp'] } }); // Meta refuses this number
});
afterAll(async () => t.close());

const wa = (name: string, values: Record<string, string> = {}, language = 'de') => ({ name, language, values });
const campaign = async (template: unknown, extra: Record<string, unknown> = {}) => {
  const r = await t.api.post('/api/campaigns', { name: 'WhatsApp', channel: 'whatsapp', filter: { tags: ['wa'] }, wa_template: template, ...extra });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const rec = (cid: string) => Object.fromEntries(t.app.db.all<any>('SELECT r.*, c.first_name FROM campaign_recipients r JOIN contacts c ON c.id = r.contact_id WHERE r.campaign_id = ?', cid).map((r) => [r.first_name, r]));

describe('WhatsApp template campaign', () => {
  it('sends a marketing template to contacts with a WhatsApp consent only, and says who was skipped', async () => {
    const c = await campaign(wa('angebot_herbst', { 'body.1': '{{contact.first_name|du}}', 'body.2': '20 % auf alles' }));
    expect(c.channel).toBe('whatsapp');
    expect(c.wa_template.values['body.1']).toBe('{{contact.first_name|du}}');
    // Before sending: 4 contacts have a phone, one is on DND, one has no consent.
    const aud = (await t.api.post(`/api/campaigns/${c.id}/audience`, { filter: { tags: ['wa'] }, channel: 'whatsapp' })).data;
    expect(aud).toMatchObject({ total: 5, reachable: 2, no_consent: 1 }); // Anna and Eva; Ben has none; Carla DND; Dirk no phone
    calls.length = 0;
    const sent = await t.api.post(`/api/campaigns/${c.id}/send`, {});
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    // The template was checked against Meta and its real category stored.
    const cur = (await t.api.get(`/api/campaigns/${c.id}`)).data;
    expect(cur.wa_template).toMatchObject({ name: 'angebot_herbst', language: 'de', category: 'MARKETING' });
    expect(cur.status).toBe('sent');
    const r = rec(c.id);
    expect(r.Anna).toMatchObject({ status: 'sent', error: '' });
    expect(r.Eva.status).toBe('failed');
    expect(r.Eva.error).toContain('nicht zustellbar');
    expect(r.Ben).toMatchObject({ status: 'skipped' });
    expect(r.Ben.error).toContain('Einwilligung');
    expect(r.Carla).toBeUndefined(); // DND: never part of the audience
    expect(r.Dirk).toBeUndefined(); // no phone number
    // The messages that Meta received: the template with this contact's own values.
    const toAnna = sends().find((x) => x.body.to === '4915112345601')!;
    expect(toAnna.body).toMatchObject({ type: 'template', template: { name: 'angebot_herbst', language: { code: 'de' } } });
    expect(toAnna.body.template.components[0]).toEqual({ type: 'body', parameters: [{ type: 'text', text: 'Anna' }, { type: 'text', text: '20 % auf alles' }] });
    expect(sends().some((x) => x.body.to === '4915112345602')).toBe(false);
    // The message is recorded as advertising with its consent basis.
    const msg = t.app.db.get<any>(`SELECT * FROM messages WHERE id = ?`, r.Anna.message_id);
    expect(msg).toMatchObject({ channel: 'whatsapp', subject: 'Vorlage: angebot_herbst', status: 'sent', purpose: 'marketing', consent_basis: 'confirmed', source: 'Kampagne: WhatsApp' });
  });

  it('a utility template is a service message: no advertising consent needed, DND still counts', async () => {
    const c = await campaign(wa('termin_info', { 'body.1': '{{contact.first_name}}' }));
    const aud = (await t.api.post(`/api/campaigns/${c.id}/audience`, { filter: { tags: ['wa'] }, channel: 'whatsapp', wa_category: 'UTILITY' })).data;
    expect(aud.no_consent ?? 0).toBe(0);
    calls.length = 0;
    await t.api.post(`/api/campaigns/${c.id}/send`, {});
    expect((await t.api.get(`/api/campaigns/${c.id}`)).data.wa_template.category).toBe('UTILITY');
    const r = rec(c.id);
    expect(r.Ben.status).toBe('sent'); // no consent, but a service message
    expect(r.Anna.status).toBe('sent');
    expect(r.Carla).toBeUndefined(); // DND
    expect(sends().map((x) => x.body.to).sort()).toEqual(['4915112345601', '4915112345602', '4915199999999']);
    const msg = t.app.db.get<any>('SELECT purpose, consent_basis FROM messages WHERE id = ?', r.Ben.message_id);
    expect(msg.purpose).not.toBe('marketing');
  });

  it('refuses templates that cannot work, with the reason', async () => {
    const send = async (tpl: unknown) => t.api.post(`/api/campaigns/${(await campaign(tpl)).id}/send`, {});
    const auth = await send(wa('code_123', { 'body.1': '123456' }));
    expect(auth.status).toBe(400);
    expect(auth.data.error).toContain('Einmalcodes');
    const unknown = await send(wa('gibt_es_nicht'));
    expect(unknown.status).toBe(400);
    expect(unknown.data.error).toContain('nicht gefunden oder noch nicht freigegeben');
    expect((await send(wa('abgelehnt'))).data.error).toContain('noch nicht freigegeben');
    const unsupported = await send(wa('standort'));
    expect(unsupported.data.error).toContain('wird hier nicht unterstützt');
    const missing = await send(wa('angebot_herbst', { 'body.1': 'Hallo' }));
    expect(missing.status).toBe(400);
    expect(missing.data.error).toContain('ausfüllen');
    const none = await t.api.post('/api/campaigns', { name: 'ohne', channel: 'whatsapp', filter: { tags: ['wa'] } });
    expect((await t.api.post(`/api/campaigns/${none.data.id}/send`, {})).data.error).toContain('WhatsApp-Vorlage fehlt');
    // nothing was sent for any of these
    expect(sends().filter((x) => x.body.template.name !== 'angebot_herbst' && x.body.template.name !== 'termin_info')).toEqual([]);
  });

  it('without a WhatsApp setup the campaign says so', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Ohne WhatsApp' })).data.id;
    t.api.setLocation(other);
    const c = await campaign(wa('angebot_herbst', { 'body.1': 'a', 'body.2': 'b' }));
    const r = await t.api.post(`/api/campaigns/${c.id}/send`, {});
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('nicht eingerichtet');
    t.api.setLocation(loc);
  });

  it('can be scheduled; the template is checked when it is scheduled', async () => {
    const c = await campaign(wa('termin_info', { 'body.1': 'x' }), { filter: { tags: ['wa'] } });
    const at = new Date(Date.now() + 3600_000).toISOString();
    const r = await t.api.post(`/api/campaigns/${c.id}/send`, { scheduled_at: at });
    expect(r.data).toMatchObject({ status: 'scheduled' });
    expect(r.data.wa_template.category).toBe('UTILITY');
    calls.length = 0;
    await t.app.tick();
    expect(sends()).toHaveLength(0);
    t.app.db.run(`UPDATE campaigns SET scheduled_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), c.id);
    await t.app.tick();
    expect(sends().length).toBeGreaterThan(0);
    expect((await t.api.get(`/api/campaigns/${c.id}`)).data.status).toBe('sent');
  });

  it('a test goes to one contact, whatever their consent', async () => {
    const c = await campaign(wa('angebot_herbst', { 'body.1': '{{contact.first_name}}', 'body.2': 'Test' }));
    calls.length = 0;
    const r = await t.api.post(`/api/campaigns/${c.id}/test`, { contact_id: ids.Ben });
    expect(r.status).toBe(200);
    expect(r.data.status).toBe('sent');
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body.to).toBe('4915112345602');
    expect(sends()[0].body.template.components[0].parameters[0].text).toBe('Ben');
  });

  it('is WhatsApp only: changing the channel drops the template, and e-mail features do not apply', async () => {
    const c = await campaign(wa('termin_info', { 'body.1': 'x' }), { send_mode: 'sto', ab: { variants: [{}, { subject: 'B' }] }, resend: { subject: 'x' } });
    expect(c.send_mode).toBe('now');
    expect(c.ab ?? null).toBeNull();
    expect(c.resend ?? null).toBeNull();
    const back = (await t.api.patch(`/api/campaigns/${c.id}`, { channel: 'email' })).data;
    expect(back.wa_template).toBeNull();
    const again = (await t.api.patch(`/api/campaigns/${c.id}`, { channel: 'whatsapp', wa_template: wa('termin_info', { 'body.1': 'y' }) })).data;
    expect(again.wa_template).toMatchObject({ name: 'termin_info', values: { 'body.1': 'y' } });
    // an SMS or e-mail campaign never carries a template
    const sms = (await t.api.post('/api/campaigns', { name: 'SMS', channel: 'sms', body: 'x', wa_template: wa('x') })).data;
    expect(sms.wa_template ?? null).toBeNull();
  });
});

describe('"Nicht stören" for WhatsApp alone', () => {
  it('stops WhatsApp messages like the DND for e-mail and SMS stops those', async () => {
    t.app.db.run(`INSERT INTO wfx_dnd (contact_id, channel, at) VALUES (?, 'whatsapp', ?)`, ids.Anna, new Date().toISOString());
    try {
      const c = await campaign(wa('termin_info', { 'body.1': '{{contact.first_name}}' }));
      calls.length = 0;
      await t.api.post(`/api/campaigns/${c.id}/send`, {});
      const r = rec(c.id);
      expect(r.Anna.status).not.toBe('sent');
      expect(r.Anna.error).toBe('Kontakt hat „Nicht stören“ für WhatsApp aktiv');
      expect(sends().some((x) => x.body.to === '4915112345601')).toBe(false);
      expect(r.Ben.status).toBe('sent');
    } finally {
      t.app.db.run(`DELETE FROM wfx_dnd WHERE contact_id = ?`, ids.Anna);
    }
  });
});
