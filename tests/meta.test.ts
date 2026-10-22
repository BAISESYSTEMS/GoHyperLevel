import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { buildTemplate, nextStatus, parseWebhook, signBody, templateInfo, verifySignature, waRecipient } from '../server/services/meta.js';

/** A tiny fake Graph API: records every call, answers like Meta does. */
const APP_SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // oss-check: allow (fake test secret)
const WA_TOKEN = 'EAAGwatoken' + 'x'.repeat(40);
const PAGE_TOKEN = 'EAAGpagetoken' + 'y'.repeat(40);
const calls: { method: string; url: string; body: any; auth: string | null }[] = [];
let outN = 0;
const TEMPLATES = [
  {
    name: 'termin_erinnerung',
    language: 'de',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Termin bei {{1}}', example: { header_text: ['Malerei Paul'] } },
      { type: 'BODY', text: 'Hallo {{1}}, dein Termin ist am {{2}}.', example: { body_text: [['Anna', '12.10.']] } },
      { type: 'FOOTER', text: 'Antworte STOP zum Abmelden' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Termin ansehen', url: 'https://crm.example.com/t/{{1}}' }, { type: 'QUICK_REPLY', text: 'Passt' }] },
    ],
  },
  { name: 'willkommen', language: 'de', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hallo {{first_name}}, willkommen!' }] },
  { name: 'abgelehnt', language: 'de', status: 'REJECTED', category: 'MARKETING', components: [{ type: 'BODY', text: 'x' }] },
];
const fake = async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const auth = (init.headers as any)?.authorization ?? null;
  calls.push({ method, url, body, auth });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://lookaside.fbsbx.com/')) {
    if (auth !== `Bearer ${WA_TOKEN}`) return new Response('no', { status: 401 });
    return new Response(Buffer.from('JPEGDATA'), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '8' } });
  }
  const u = new URL(url);
  const path = u.pathname.replace(/^\/v\d+\.\d+\//, '');
  const token = auth?.replace('Bearer ', '');
  if (token !== WA_TOKEN && token !== PAGE_TOKEN) return json({ error: { message: 'Invalid OAuth access token', code: 190 } }, 401);
  if (method === 'GET' && path === '1111') return json({ id: '1111', display_phone_number: '+49 30 123456', verified_name: 'Malerei Paul', quality_rating: 'GREEN' });
  if (method === 'GET' && path === '2222') return json({ id: '2222', name: 'Malerei WABA' });
  if (method === 'GET' && path === '2222/message_templates') return json({ data: TEMPLATES });
  if (method === 'GET' && path === '3333') return json({ id: '3333', name: 'Malerei Paul Seite' });
  if (method === 'GET' && path === '4444') return json({ id: '4444', username: 'malerei.paul' });
  if (method === 'GET' && path === '5551') return json({ first_name: 'Max', last_name: 'Muster' });
  if (method === 'GET' && path === '6661') return json({ name: 'Lena Lustig', username: 'lena.insta' });
  if (method === 'GET' && path === '777000') return json({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=777000', mime_type: 'image/jpeg', file_size: 8 });
  if (method === 'POST' && path === '1111/messages') {
    if (body.to === '4915000000000') return json({ error: { message: '(#131026) Message Undeliverable.', code: 131026 } }, 400);
    return json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.OUT${++outN}` }] });
  }
  if (method === 'POST' && path === 'me/messages') return json({ recipient_id: body.recipient.id, message_id: `m_out${++outN}` });
  if (method === 'POST' && (path === '2222/subscribed_apps' || path === '3333/subscribed_apps')) return json({ success: true });
  return json({ error: { message: `unknown ${method} ${path}`, code: 100 } }, 400);
};

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const lastCall = (pred: (c: (typeof calls)[number]) => boolean) => [...calls].reverse().find(pred);
const hook = (payload: unknown, opts: { sig?: string; secret?: string; location?: string } = {}) => {
  const raw = JSON.stringify(payload);
  return t.api.raw(`/hooks/meta/${opts.location ?? loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': opts.sig ?? signBody(raw, opts.secret ?? APP_SECRET) }, body: raw });
};
const wa = (value: any) => ({ object: 'whatsapp_business_account', entry: [{ id: '2222', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '4930123456', phone_number_id: '1111' }, ...value } }] }] });
const ts = (msAgo = 0) => String(Math.floor((Date.now() - msAgo) / 1000));
const waText = (id: string, from: string, body: string, name = 'Anna Muster', msAgo = 0) =>
  wa({ contacts: [{ profile: { name }, wa_id: from }], messages: [{ from, id, timestamp: ts(msAgo), type: 'text', text: { body } }] });
const contactByPhone = async (phone: string) => (await t.api.get(`/api/contacts?q=${encodeURIComponent(phone)}`)).data.contacts?.[0];

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.metaFetch = fake;
  await t.setup();
  loc = t.api.location;
});
afterAll(async () => {
  await t.close();
});

describe('Meta channels: pure helpers', () => {
  it('checks X-Hub-Signature-256 in constant time over the raw UTF-8 bytes', () => {
    const raw = JSON.stringify({ text: 'Grüße 👋' });
    const sig = signBody(raw, APP_SECRET);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature(raw, sig, APP_SECRET)).toBe(true);
    expect(verifySignature(Buffer.from(raw, 'utf8'), sig, APP_SECRET)).toBe(true);
    expect(verifySignature(raw + ' ', sig, APP_SECRET)).toBe(false);
    expect(verifySignature(raw, sig, 'other-secret')).toBe(false);
    expect(verifySignature(raw, sig.replace('sha256=', 'sha1='), APP_SECRET)).toBe(false);
    expect(verifySignature(raw, undefined, APP_SECRET)).toBe(false);
    expect(verifySignature(raw, sig, '')).toBe(false);
  });

  it('turns every WhatsApp message type into readable text', () => {
    const ev = parseWebhook(
      wa({
        messages: [
          { from: '491', id: 'w1', timestamp: ts(), type: 'location', location: { latitude: 52.5, longitude: 13.4, name: 'Büro', address: 'Hauptstr. 1' } },
          { from: '491', id: 'w2', timestamp: ts(), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Ja, passt' } } },
          { from: '491', id: 'w3', timestamp: ts(), type: 'document', document: { id: '9', filename: 'Angebot.pdf', mime_type: 'application/pdf' } },
          { from: '491', id: 'w4', timestamp: ts(), type: 'button', button: { text: 'Termin bestätigen', payload: 'ok' } },
          { from: '491', id: 'w5', timestamp: ts(), type: 'audio', audio: { id: '8', mime_type: 'audio/ogg', voice: true } },
          { from: '491', id: 'w6', timestamp: ts(), type: 'reaction', reaction: { message_id: 'x', emoji: '' } },
        ],
        statuses: [{ id: 'wamid.X', status: 'failed', timestamp: ts(), recipient_id: '491', errors: [{ code: 131047, title: 'Re-engagement message' }] }],
      }),
    );
    const bodies = ev.filter((e) => e.kind === 'message').map((e: any) => e.body);
    expect(bodies).toEqual(['📍 Standort: Büro, Hauptstr. 1', 'Ja, passt', '📄 Angebot.pdf', 'Termin bestätigen', '🎤 Sprachnachricht']);
    expect((ev[0] as any).attachment).toEqual({ kind: 'location', lat: 52.5, lng: 13.4 });
    expect((ev[2] as any).attachment).toMatchObject({ kind: 'document', media_id: '9', mime: 'application/pdf', filename: 'Angebot.pdf' });
    expect(ev.at(-1)).toMatchObject({ kind: 'status', status: 'failed', externalId: 'wa:wamid.X', error: 'Außerhalb des 24-Stunden-Fensters – bitte eine Vorlage senden' });
  });

  it('ignores echoes and moves statuses only forward', () => {
    const ev = parseWebhook({ object: 'page', entry: [{ id: '3333', messaging: [{ sender: { id: '3333' }, recipient: { id: '5551' }, timestamp: Date.now(), message: { mid: 'm1', text: 'hi', is_echo: true } }] }] });
    expect(ev).toEqual([]);
    expect(nextStatus('sent', 'delivered')).toBe('delivered');
    expect(nextStatus('read', 'delivered')).toBeNull();
    expect(nextStatus('delivered', 'failed')).toBe('failed');
    expect(nextStatus('read', 'failed')).toBeNull();
    expect(nextStatus('failed', 'read')).toBeNull();
  });

  it('builds template components for positional and named placeholders', () => {
    const t1 = templateInfo(TEMPLATES[0]);
    expect(t1.slots.map((s) => s.key)).toEqual(['header.1', 'body.1', 'body.2', 'button.0.1']);
    expect(() => buildTemplate(t1, { 'header.1': 'X' })).toThrow(/ausfüllen/);
    const b = buildTemplate(t1, { 'header.1': 'Malerei Paul', 'body.1': 'Anna', 'body.2': 'Freitag', 'button.0.1': 'abc' });
    expect(b.components).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: 'Malerei Paul' }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Anna' }, { type: 'text', text: 'Freitag' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'abc' }] },
    ]);
    expect(b.text).toBe('Termin bei Malerei Paul\n\nHallo Anna, dein Termin ist am Freitag.\n\nAntworte STOP zum Abmelden');
    const named = buildTemplate(templateInfo(TEMPLATES[1]), { 'body.first_name': 'Ben' });
    expect(named.components).toEqual([{ type: 'body', parameters: [{ type: 'text', parameter_name: 'first_name', text: 'Ben' }] }]);
    const img = templateInfo({ name: 'bild', language: 'de', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Neu!' }] });
    expect(() => buildTemplate(img, { 'header.media': 'http://x.de/a.png' })).toThrow(/https/);
    expect(buildTemplate(img, { 'header.media': 'https://x.de/a.png' }).components[0]).toEqual({ type: 'header', parameters: [{ type: 'image', image: { link: 'https://x.de/a.png' } }] });
    expect(waRecipient('+49 176 1234567')).toBe('491761234567');
    expect(waRecipient('123')).toBe('');
  });
});

describe('Meta channels: settings and webhook', () => {
  it('stores IDs and sealed secrets, never hands them back', async () => {
    const s0 = (await t.api.get('/api/settings/meta')).data;
    expect(s0.webhook_url).toBe(`http://localhost/hooks/meta/${loc}`);
    expect(s0.verify_token.length).toBeGreaterThanOrEqual(20);
    expect(s0.whatsapp.configured).toBe(false);
    expect((await t.api.put('/api/settings/meta', { wa_phone_number_id: '12a' })).status).toBe(400);
    expect((await t.api.put('/api/settings/meta', { wa_token: 'kurz' })).status).toBe(400);
    const s = (
      await t.api.put('/api/settings/meta', { wa_phone_number_id: '1111', wa_business_account_id: '2222', wa_token: WA_TOKEN, app_secret: APP_SECRET, page_id: '3333', page_token: PAGE_TOKEN, ig_account_id: '4444' })
    ).data;
    expect(s.whatsapp).toMatchObject({ phone_number_id: '1111', business_account_id: '2222', token_set: true, configured: true });
    expect(s.messenger.configured).toBe(true);
    expect(s.instagram.configured).toBe(true);
    expect(s.app_secret_set).toBe(true);
    const all = JSON.stringify([s, (await t.api.get('/api/settings/meta')).data, (await t.api.get('/api/location')).data]);
    for (const secret of [WA_TOKEN, PAGE_TOKEN, APP_SECRET]) expect(all).not.toContain(secret);
    expect(JSON.stringify(t.app.db.get('SELECT * FROM meta_accounts WHERE location_id = ?', loc))).not.toContain(WA_TOKEN);
    // A masked value or an empty field keeps the stored secret.
    expect((await t.api.put('/api/settings/meta', { wa_token: '••••••', app_secret: '' })).data.whatsapp.token_set).toBe(true);
  });

  it('tests the connection and subscribes the webhooks', async () => {
    const r = (await t.api.post('/api/settings/meta/test')).data;
    expect(r.results.whatsapp).toMatchObject({ ok: true });
    expect(r.results.whatsapp.info).toContain('Malerei Paul · +49 30 123456');
    expect(r.results.messenger.info).toBe('Seite „Malerei Paul Seite“');
    expect(r.results.instagram.info).toBe('@malerei.paul');
    expect(r.settings.whatsapp.display_phone).toBe('+49 30 123456');
    expect(lastCall((c) => c.url.includes('/1111?'))!.url).toBe('https://graph.facebook.com/v21.0/1111?fields=display_phone_number,verified_name,quality_rating');
    // Local base URL: WhatsApp needs https, the page subscription works anyway.
    const sub = (await t.api.post('/api/settings/meta/subscribe')).data.results;
    expect(sub.whatsapp.ok).toBe(false);
    expect(sub.messenger.ok).toBe(true);
    expect(lastCall((c) => c.url.includes('3333/subscribed_apps'))!.auth).toBe(`Bearer ${PAGE_TOKEN}`);
  });

  it('answers Meta’s verify handshake only with the right token', async () => {
    const { verify_token } = (await t.api.get('/api/settings/meta')).data;
    const ok = await t.api.raw(`/hooks/meta/${loc}?hub.mode=subscribe&hub.verify_token=${verify_token}&hub.challenge=1158201444`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('1158201444');
    expect((await t.api.raw(`/hooks/meta/${loc}?hub.mode=subscribe&hub.verify_token=falsch&hub.challenge=1`)).status).toBe(403);
    expect((await t.api.raw(`/hooks/meta/${loc}?hub.mode=unsubscribe&hub.verify_token=${verify_token}&hub.challenge=1`)).status).toBe(403);
    expect((await t.api.raw(`/hooks/meta/unbekannt?hub.mode=subscribe&hub.verify_token=${verify_token}&hub.challenge=1`)).status).toBe(403);
  });

  it('refuses webhook posts without a valid signature', async () => {
    const payload = waText('wamid.SIG', '4917600000001', 'Hallo');
    expect((await hook(payload, { sig: 'sha256=' + '0'.repeat(64) })).status).toBe(401);
    expect((await hook(payload, { secret: 'falsches-secret' })).status).toBe(401);
    expect((await t.api.raw(`/hooks/meta/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).status).toBe(401);
    expect(t.app.db.get(`SELECT id FROM messages WHERE external_id = 'wa:wamid.SIG'`)).toBeUndefined();
    expect((await hook(payload, { location: 'unbekannt' })).status).toBe(404);
    // A second sub-account without app secret rejects everything.
    const other = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data;
    await t.api.get('/api/settings/meta', { 'x-location-id': other.id });
    expect((await hook(payload, { location: other.id })).status).toBe(403);
  });
});

describe('Meta channels: WhatsApp inbox', () => {
  let contactId = '';

  it('turns an inbound text into contact, conversation and message – once', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'WA-Eingang', trigger: { type: 'message.inbound', config: { channel: 'whatsapp' } }, steps: [{ type: 'add_tag', tags: ['wa-lead'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const payload = waText('wamid.IN1', '4917612345678', 'Hallo, habt ihr nächste Woche Zeit? 😊');
    const r = await hook(payload);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, messages: 1 });
    expect((await (await hook(payload)).json()).messages).toBe(0);
    await t.app.events.flush();
    const c = await contactByPhone('+4917612345678');
    expect(c).toMatchObject({ first_name: 'Anna', last_name: 'Muster', phone: '+4917612345678', source: 'WhatsApp' });
    expect(c.tags).toEqual(expect.arrayContaining(['whatsapp', 'wa-lead']));
    contactId = c.id;
    const convs = (await t.api.get('/api/conversations?channel=whatsapp')).data;
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ contact_id: c.id, unread: 1, last_channel: 'whatsapp' });
    expect(convs[0].last_message).toContain('nächste Woche');
    expect((await t.api.get('/api/conversations?channel=instagram')).data).toHaveLength(0);
    const msgs = t.app.db.all('SELECT * FROM messages WHERE contact_id = ?', c.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ channel: 'whatsapp', direction: 'in', status: 'received', external_id: 'wa:wamid.IN1' });
  });

  it('reuses an existing contact with the same number without renaming it', async () => {
    const existing = (await t.api.post('/api/contacts', { first_name: 'Bernd', phone: '0176 9999999' })).data;
    await hook(waText('wamid.IN2', '491769999999', 'Moin', 'B.'));
    const rows = t.app.db.all('SELECT contact_id FROM messages WHERE external_id = ?', 'wa:wamid.IN2');
    expect(rows[0].contact_id).toBe(existing.id);
    expect((await t.api.get(`/api/contacts/${existing.id}`)).data.first_name).toBe('Bernd');
  });

  it('sends free text inside the 24-hour window with the right Graph request', async () => {
    const st = (await t.api.get(`/api/messages/meta/status?contact_id=${contactId}`)).data.channels;
    expect(st.whatsapp).toMatchObject({ configured: true, reachable: true, templates: true });
    expect(st.whatsapp.window.open).toBe(true);
    expect(st.messenger).toMatchObject({ configured: true, reachable: false });
    const m = (await t.api.post('/api/messages', { contact_id: contactId, channel: 'whatsapp', body: 'Klar, Dienstag 10 Uhr?' })).data;
    expect(m).toMatchObject({ status: 'sent', channel: 'whatsapp', direction: 'out' });
    const call = lastCall((c) => c.url.endsWith('/1111/messages'))!;
    expect(call.url).toBe('https://graph.facebook.com/v21.0/1111/messages');
    expect(call.method).toBe('POST');
    expect(call.auth).toBe(`Bearer ${WA_TOKEN}`);
    expect(call.body).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '4917612345678', type: 'text', text: { preview_url: false, body: 'Klar, Dienstag 10 Uhr?' } });
    const row = t.app.db.get('SELECT * FROM messages WHERE id = ?', m.id);
    expect(row).toMatchObject({ status: 'sent', provider_id: 'wamid.OUT' + outN, external_id: 'wa:wamid.OUT' + outN });
  });

  it('follows delivery and read receipts, also out of order, and failures', async () => {
    const out = t.app.db.get(`SELECT * FROM messages WHERE contact_id = ? AND direction = 'out' ORDER BY created_at DESC LIMIT 1`, contactId);
    const wamid = out.provider_id;
    const status = (s: string, id = wamid, errors?: any[]) => hook(wa({ statuses: [{ id, status: s, timestamp: ts(), recipient_id: '4917612345678', ...(errors ? { errors } : {}) }] }));
    await status('delivered');
    expect(t.app.db.get('SELECT status FROM messages WHERE id = ?', out.id).status).toBe('delivered');
    await status('read');
    await status('delivered');
    expect(t.app.db.get('SELECT status FROM messages WHERE id = ?', out.id).status).toBe('read');
    // An undeliverable number fails right away (Graph error), another one later via webhook.
    await hook(waText('wamid.NIX', '4915000000000', 'hi', 'Nix'));
    const bad = await contactByPhone('+4915000000000');
    const sent = (await t.api.post('/api/messages/meta', { contact_id: bad.id, channel: 'whatsapp', body: 'Test' })).data;
    expect(sent).toMatchObject({ status: 'failed', error: 'Nachricht nicht zustellbar (hat die Nummer WhatsApp?)' });
    const second = (await t.api.post('/api/messages', { contact_id: contactId, channel: 'whatsapp', body: 'Noch was' })).data;
    const pid = t.app.db.get('SELECT provider_id FROM messages WHERE id = ?', second.id).provider_id;
    await status('failed', pid, [{ code: 131026, title: 'Message undeliverable' }]);
    expect(t.app.db.get('SELECT status, error FROM messages WHERE id = ?', second.id)).toEqual({ status: 'failed', error: 'Nachricht nicht zustellbar (hat die Nummer WhatsApp?)' });
  });

  it('enforces the 24-hour window for free text', async () => {
    const fresh = (await t.api.post('/api/contacts', { first_name: 'Neu', phone: '+4917011112222' })).data;
    const r = await t.api.post('/api/messages', { contact_id: fresh.id, channel: 'whatsapp', body: 'Hallo!' });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('24-Stunden-Fenster');
    // An inbound message from 25 hours ago does not open it either.
    await hook(waText('wamid.OLD', '4917011112222', 'Alt', 'Neu', 25 * 3600_000));
    const st = (await t.api.get(`/api/messages/meta/status?contact_id=${fresh.id}`)).data.channels.whatsapp;
    expect(st.window.open).toBe(false);
    expect(st.window.last_inbound_at).toBeTruthy();
    expect((await t.api.post('/api/messages', { contact_id: fresh.id, channel: 'whatsapp', body: 'Hallo!' })).status).toBe(400);
    const noPhone = (await t.api.post('/api/contacts', { first_name: 'Ohne', email: 'ohne@example.com' })).data;
    expect((await t.api.post('/api/messages', { contact_id: noPhone.id, channel: 'whatsapp', body: 'x' })).data.error).toContain('Telefonnummer');
    expect((await t.api.post('/api/messages', { contact_id: contactId, channel: 'whatsapp', body: 'x'.repeat(4097) })).data.error).toContain('max. 4096');
  });

  it('lists approved templates and sends one outside the window', async () => {
    const list = (await t.api.get('/api/messages/meta/templates')).data;
    expect(list.map((x: any) => x.name)).toEqual(['termin_erinnerung', 'willkommen']);
    expect(lastCall((c) => c.url.includes('message_templates'))!.url).toContain('https://graph.facebook.com/v21.0/2222/message_templates?fields=name,language,status,category,components');
    const fresh = await contactByPhone('+4917011112222');
    const missing = await t.api.post('/api/messages/meta', { contact_id: fresh.id, channel: 'whatsapp', template: { name: 'termin_erinnerung', language: 'de', values: { 'body.1': 'Neu' } } });
    expect(missing.status).toBe(400);
    expect((await t.api.post('/api/messages/meta', { contact_id: fresh.id, channel: 'whatsapp', template: { name: 'gibtsnicht' } })).status).toBe(400);
    const values = { 'header.1': 'Malerei Paul', 'body.1': 'Neu', 'body.2': 'Dienstag', 'button.0.1': 'xyz' };
    const m = (await t.api.post('/api/messages/meta', { contact_id: fresh.id, channel: 'whatsapp', template: { name: 'termin_erinnerung', language: 'de', values } })).data;
    expect(m).toMatchObject({ status: 'sent', subject: 'Vorlage: termin_erinnerung' });
    expect(m.body).toContain('Hallo Neu, dein Termin ist am Dienstag.');
    const call = lastCall((c) => c.url.endsWith('/1111/messages'))!;
    expect(call.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '4917011112222',
      type: 'template',
      template: {
        name: 'termin_erinnerung',
        language: { code: 'de' },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: 'Malerei Paul' }] },
          { type: 'body', parameters: [{ type: 'text', text: 'Neu' }, { type: 'text', text: 'Dienstag' }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'xyz' }] },
        ],
      },
    });
    expect((await t.api.post('/api/messages/meta', { contact_id: fresh.id, channel: 'messenger', template: { name: 'willkommen' } })).status).toBe(400);
  });

  it('sends via workflow: text in the window, otherwise the template', async () => {
    const meta = (await t.api.get('/api/workflows/meta')).data;
    expect(meta.steps).toContain('whatsapp_send');
    const wf = (
      await t.api.post('/api/workflows', {
        name: 'WA-Follow-up',
        trigger: { type: 'contact.tag_added', config: { tag: 'wa-follow' } },
        steps: [{ type: 'whatsapp_send', mode: 'auto', body: 'Hi {{contact.first_name}}!', template: 'willkommen', language: 'de', values: { 'body.first_name': '{{contact.first_name|du}}' } }],
      })
    ).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const before = calls.length;
    await t.api.post(`/api/contacts/${contactId}/tags`, { add: ['wa-follow'] });
    const fresh = await contactByPhone('+4917011112222');
    await t.api.post(`/api/contacts/${fresh.id}/tags`, { add: ['wa-follow'] });
    await t.app.events.flush();
    const sends = calls.slice(before).filter((c) => c.url.endsWith('/1111/messages'));
    expect(sends).toHaveLength(2);
    expect(sends.find((c) => c.body.to === '4917612345678')!.body).toMatchObject({ type: 'text', text: { body: 'Hi Anna!' } });
    expect(sends.find((c) => c.body.to === '4917011112222')!.body.template).toEqual({ name: 'willkommen', language: { code: 'de' }, components: [{ type: 'body', parameters: [{ type: 'text', parameter_name: 'first_name', text: 'Neu' }] }] });
  });

  it('keeps media as a placeholder and fetches it lazily through Graph', async () => {
    await hook(wa({ contacts: [{ profile: { name: 'Anna Muster' }, wa_id: '4917612345678' }], messages: [{ from: '4917612345678', id: 'wamid.IMG', timestamp: ts(), type: 'image', image: { id: '777000', mime_type: 'image/jpeg', caption: 'So sieht die Wand aus' } }] }));
    const m = t.app.db.get(`SELECT * FROM messages WHERE external_id = 'wa:wamid.IMG'`);
    expect(m.body).toBe('📷 Bild\nSo sieht die Wand aus');
    expect(JSON.parse(m.meta_media)).toMatchObject({ kind: 'image', media_id: '777000' });
    const r = await t.api.raw(`/api/messages/meta/media/${m.id}?locationId=${loc}`, { headers: { cookie: t.api.cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('JPEGDATA');
    expect(lastCall((c) => c.url.startsWith('https://lookaside'))!.auth).toBe(`Bearer ${WA_TOKEN}`);
    expect((await t.api.raw(`/api/messages/meta/media/${m.id}?locationId=${loc}`)).status).toBe(401);
  });

  it('marks STOP as do-not-disturb', async () => {
    await hook(waText('wamid.STOP', '4917612345678', 'STOP'));
    expect((await t.api.get(`/api/contacts/${contactId}`)).data.dnd).toBe(1);
    const r = (await t.api.post('/api/messages', { contact_id: contactId, channel: 'whatsapp', body: 'Noch da?' })).data;
    expect(r).toMatchObject({ status: 'failed', error: 'Kontakt hat „Nicht stören“ aktiv' });
    expect((await t.api.post('/api/messages', { contact_id: contactId, channel: 'whatsapp', body: 'Bestätigung', ignoreDnd: true })).data.status).toBe('sent');
    // Only real channel names reach the channel hook (no prototype keys).
    const odd = await t.api.post('/api/messages', { contact_id: contactId, channel: 'constructor', body: 'x' });
    expect(odd.status).toBe(200);
    expect(odd.data.channel).toBe('email');
  });
});

describe('Meta channels: Messenger and Instagram', () => {
  it('creates a Messenger contact from the profile and answers via the Send API', async () => {
    const payload = { object: 'page', entry: [{ id: '3333', time: Date.now(), messaging: [{ sender: { id: '5551' }, recipient: { id: '3333' }, timestamp: Date.now(), message: { mid: 'm_IN1', text: 'Was kostet ein Zimmer?' } }] }] };
    expect((await (await hook(payload)).json()).messages).toBe(1);
    expect((await (await hook(payload)).json()).messages).toBe(0);
    const msg = t.app.db.get(`SELECT * FROM messages WHERE external_id = 'fb:m_IN1'`);
    expect(msg.channel).toBe('messenger');
    const c = (await t.api.get(`/api/contacts/${msg.contact_id}`)).data;
    expect(c).toMatchObject({ first_name: 'Max', last_name: 'Muster', source: 'Messenger' });
    expect(lastCall((x) => x.url.includes('/5551?'))!.auth).toBe(`Bearer ${PAGE_TOKEN}`);
    const sent = (await t.api.post('/api/messages', { contact_id: c.id, channel: 'messenger', body: 'Ab 350 €.' })).data;
    expect(sent.status).toBe('sent');
    const call = lastCall((x) => x.url.endsWith('/me/messages'))!;
    expect(call.url).toBe('https://graph.facebook.com/v21.0/me/messages');
    expect(call.auth).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(call.body).toEqual({ recipient: { id: '5551' }, messaging_type: 'RESPONSE', message: { text: 'Ab 350 €.' } });
    // Read receipt by watermark.
    await hook({ object: 'page', entry: [{ id: '3333', messaging: [{ sender: { id: '5551' }, recipient: { id: '3333' }, timestamp: Date.now(), read: { watermark: Date.now() + 1000 } }] }] });
    expect(t.app.db.get('SELECT status FROM messages WHERE id = ?', sent.id).status).toBe('read');
    // Outside the window Messenger refuses free text.
    t.app.db.run(`UPDATE messages SET created_at = ? WHERE contact_id = ? AND direction = 'in'`, new Date(Date.now() - 30 * 3600_000).toISOString(), c.id);
    expect((await t.api.post('/api/messages', { contact_id: c.id, channel: 'messenger', body: 'Hallo?' })).status).toBe(400);
  });

  it('handles Instagram Direct with username and attachments', async () => {
    const payload = {
      object: 'instagram',
      entry: [{ id: '4444', time: Date.now(), messaging: [{ sender: { id: '6661' }, recipient: { id: '4444' }, timestamp: Date.now(), message: { mid: 'ig_IN1', attachments: [{ type: 'image', payload: { url: 'https://scontent.cdninstagram.com/v/x.jpg' } }] } }] }],
    };
    expect((await (await hook(payload)).json()).messages).toBe(1);
    const msg = t.app.db.get(`SELECT * FROM messages WHERE external_id = 'ig:ig_IN1'`);
    expect(msg).toMatchObject({ channel: 'instagram', body: '📷 Bild' });
    expect(JSON.parse(msg.meta_media)).toEqual({ kind: 'image', url: 'https://scontent.cdninstagram.com/v/x.jpg' });
    const c = (await t.api.get(`/api/contacts/${msg.contact_id}`)).data;
    expect(c).toMatchObject({ first_name: 'Lena', last_name: 'Lustig', source: 'Instagram' });
    expect(c.custom.instagram).toBe('@lena.insta');
    expect(c.tags).toContain('instagram');
    const sent = (await t.api.post('/api/messages/meta', { contact_id: c.id, channel: 'instagram', body: 'Danke für das Foto!' })).data;
    expect(sent.status).toBe('sent');
    expect(lastCall((x) => x.url.endsWith('/me/messages'))!.body.recipient).toEqual({ id: '6661' });
    expect((await t.api.post('/api/messages/meta', { contact_id: c.id, channel: 'instagram', body: 'x'.repeat(1001) })).status).toBe(400);
  });

  it('ignores events for IDs that belong to no sub-account and says so', async () => {
    const r = await (await hook({ object: 'page', entry: [{ id: '999', messaging: [{ sender: { id: '1234' }, recipient: { id: '999' }, timestamp: Date.now(), message: { mid: 'm_X', text: 'hi' } }] }] })).json();
    expect(r).toMatchObject({ messages: 0, skipped: 1 });
    expect((await t.api.get('/api/settings/meta')).data.last_error).toContain('unbekannte ID 999');
  });

  it('keeps Meta’s time only for late deliveries', async () => {
    await hook(waText('wamid.LATE', '4917055566677', 'Von gestern', 'Spät', 10 * 3600_000));
    await hook(waText('wamid.LIVE', '4917055566677', 'Von jetzt', 'Spät', 30_000));
    const late = t.app.db.get(`SELECT created_at FROM messages WHERE external_id = 'wa:wamid.LATE'`).created_at;
    const live = t.app.db.get(`SELECT created_at FROM messages WHERE external_id = 'wa:wamid.LIVE'`).created_at;
    expect(Date.now() - new Date(late).getTime()).toBeGreaterThan(9 * 3600_000);
    expect(Date.now() - new Date(live).getTime()).toBeLessThan(5_000);
  });

  it('offers WhatsApp over MCP: ghl_send_message channels and ghl_send_whatsapp', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data.key;
    const rpc = async (body: any) =>
      (await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify(body) })).json();
    const tools = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
    expect(tools.map((x: any) => x.name)).toEqual(expect.arrayContaining(['ghl_send_whatsapp', 'ghl_list_whatsapp_templates']));
    // every channel a module adds to POST /api/messages (Telegram, Discord, push … come from other modules)
    expect(tools.find((x: any) => x.name === 'ghl_send_message').inputSchema.properties.channel.enum).toEqual(expect.arrayContaining(['email', 'sms', 'whatsapp', 'messenger', 'instagram']));
    const fresh = await contactByPhone('+4917011112222');
    const before = calls.length;
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ghl_send_whatsapp', arguments: { location_id: loc, contact_id: fresh.id, template: { name: 'willkommen', language: 'de', values: { 'body.first_name': 'Neu' } } } } });
    expect(res.result.isError).toBeFalsy();
    expect(JSON.parse(res.result.content[0].text)).toMatchObject({ status: 'sent', channel: 'whatsapp', subject: 'Vorlage: willkommen' });
    expect(calls.slice(before).find((c) => c.url.endsWith('/1111/messages'))!.body).toMatchObject({ to: '4917011112222', template: { name: 'willkommen' } });
  });
});
