import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { parseBrevo, parseMailgun, parseMultipart, parsePostmark, parseResend, parseSesMessage, sigV4, signMailgun, signSvix, snsStringToSign, verifyMailgun, verifySvix } from '../server/services/email-providers.js';

const RESEND_SECRET = `whsec_${Buffer.from('resend-signing-secret-1234').toString('base64')}`;
const MAILGUN_KEY = 'key-mailgun-signing-0123456789abcdef';
const { publicKey: snsPublic, privateKey: snsPrivate } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SNS_CERT_URL = 'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-abc.pem';
const calls: { url: string; method: string; body: any; headers: Record<string, string> }[] = [];
let n = 0;

const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const fake = async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const raw = init.body ? String(init.body) : '';
  let body: any = raw;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = Object.fromEntries(new URLSearchParams(raw));
  }
  calls.push({ url, method: init.method ?? 'GET', body, headers });
  if (url === SNS_CERT_URL) return new Response(snsPublic.export({ type: 'spki', format: 'pem' }) as string, { status: 200 });
  if (url.startsWith('https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription')) return new Response('<ok/>', { status: 200 });
  if (url === 'https://api.resend.com/emails') return headers.authorization === 'Bearer re_test_123456789' ? json({ id: `re-${++n}` }) : json({ message: 'API key is invalid' }, 401);
  if (url === 'https://api.resend.com/domains') return json({ data: [{ name: 'example.com', status: 'verified' }] });
  if (url === 'https://api.postmarkapp.com/email') return json({ ErrorCode: 0, Message: 'OK', MessageID: `pm-${++n}` });
  if (url === 'https://api.postmarkapp.com/server') return json({ Name: 'Malerei' });
  if (url === 'https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails') {
    if (!headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/')) return json({ message: 'unsigned' }, 403);
    return json({ MessageId: `0102018c-ses-${++n}` });
  }
  if (url === 'https://email.eu-central-1.amazonaws.com/v2/email/account') return json({ ProductionAccessEnabled: false, SendQuota: { Max24HourSend: 200 } });
  if (url === 'https://api.brevo.com/v3/smtp/email') return json({ messageId: `<brevo-${++n}@smtp-relay.mailin.fr>` });
  if (url === 'https://api.brevo.com/v3/account') return json({ email: 'chef@example.com', companyName: 'Malerei' });
  if (url === 'https://api.eu.mailgun.net/v3/mg.example.com/messages') return json({ id: `<mg-${++n}@mg.example.com>`, message: 'Queued. Thank you.' });
  if (url === 'https://api.eu.mailgun.net/v3/domains/mg.example.com') return json({ domain: { name: 'mg.example.com', state: 'active' } });
  return json({ message: `unexpected ${url}` }, 500);
};

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let contactId = '';
const snsMessage = (m: Record<string, any>, version: '1' | '2' = '2') => {
  const msg: Record<string, any> = { Type: 'Notification', MessageId: `sns-${Math.random()}`, TopicArn: 'arn:aws:sns:eu-central-1:123456789012:ses-events', Timestamp: new Date().toISOString(), SignatureVersion: version, SigningCertURL: SNS_CERT_URL, ...m };
  msg.Signature = createSign(version === '2' ? 'RSA-SHA256' : 'RSA-SHA1').update(snsStringToSign(msg)).sign(snsPrivate, 'base64');
  return msg;
};
const settings = async () => (await t.api.get('/api/settings/channels/mail')).data;
const send = async (body = 'Hallo Anna') => (await t.api.post('/api/messages', { contact_id: contactId, channel: 'email', subject: 'Test', body })).data;
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return t.api.raw(new URL(url).pathname, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });
};

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.channelFetch = fake;
  await t.setup();
  loc = t.api.location;
  contactId = (await t.api.post('/api/contacts', { first_name: 'Anna', email: 'anna@example.com' })).data.id;
});
afterAll(() => t.close());

describe('email providers: pure helpers', () => {
  it('SigV4 matches the AWS documentation example', () => {
    const h = sigV4({
      method: 'GET',
      url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      body: '',
      region: 'us-east-1',
      service: 'iam',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      amzDate: '20150830T123600Z',
    });
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });

  it('Svix (Resend) and Mailgun signatures', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const raw = '{"type":"email.delivered"}';
    const sig = signSvix(raw, 'msg_1', ts, RESEND_SECRET);
    expect(verifySvix(raw, 'msg_1', ts, `v1,bogus ${sig}`, RESEND_SECRET)).toBe(true);
    expect(verifySvix(raw, 'msg_2', ts, sig, RESEND_SECRET)).toBe(false);
    expect(verifySvix(raw, 'msg_1', String(Number(ts) - 900), signSvix(raw, 'msg_1', String(Number(ts) - 900), RESEND_SECRET), RESEND_SECRET)).toBe(false);
    const mg = { timestamp: ts, token: 'tok123', signature: signMailgun(ts, 'tok123', MAILGUN_KEY) };
    expect(verifyMailgun(mg, MAILGUN_KEY)).toBe(true);
    expect(verifyMailgun({ ...mg, token: 'other' }, MAILGUN_KEY)).toBe(false);
  });

  it('parses delivery reports and inbound mail of every provider', async () => {
    expect(parseResend({ type: 'email.bounced', data: { email_id: 'r1', bounce: { type: 'Permanent', message: 'mailbox full' } } }).events[0]).toMatchObject({ providerId: 'r1', status: 'bounced', permanent: true });
    expect(parseResend({ type: 'email.bounced', data: { email_id: 'r1', bounce: { type: 'Transient' } } }).events[0].status).toBe('deferred');
    expect(parsePostmark({ RecordType: 'Bounce', Type: 'SoftBounce', MessageID: 'p1' }).events[0].status).toBe('deferred');
    expect(parsePostmark({ RecordType: 'Bounce', Type: 'HardBounce', MessageID: 'p1' }).events[0]).toMatchObject({ status: 'bounced', permanent: true });
    expect(parsePostmark({ FromFull: { Email: 'Kim@Example.com', Name: 'Kim' }, To: 'in@x.de', Subject: 'Hi', TextBody: 'Text', StrippedTextReply: 'Nur Antwort' }).inbound[0]).toMatchObject({ from: 'kim@example.com', text: 'Nur Antwort' });
    expect(parseBrevo({ event: 'hard_bounce', 'message-id': '<b1@relay>', reason: 'unknown user' }).events[0]).toMatchObject({ providerId: 'b1@relay', status: 'bounced', permanent: true });
    expect(parseBrevo({ items: [{ From: { Address: 'lea@example.com', Name: 'Lea' }, To: [{ Address: 'in@x.de' }], Subject: 'Frage', RawTextBody: 'Hallo' }] }).inbound[0]).toMatchObject({ from: 'lea@example.com', subject: 'Frage', text: 'Hallo' });
    expect(parseMailgun({ 'event-data': { id: 'e1', event: 'failed', severity: 'temporary', message: { headers: { 'message-id': 'm1@mg' } } } }).events[0].status).toBe('deferred');
    expect(parseMailgun({ sender: 'ben@example.com', from: 'Ben <ben@example.com>', subject: 'Re', 'stripped-text': 'Danke' }).inbound[0]).toMatchObject({ from: 'ben@example.com', name: 'Ben', text: 'Danke' });
    const mime = ['From: "Olga" <olga@example.com>', 'To: inbox@x.de', 'Subject: Termin', 'Message-ID: <abc@mail>', 'Content-Type: text/plain; charset=utf-8', '', 'Geht Freitag?'].join('\r\n');
    const ses = await parseSesMessage(JSON.stringify({ notificationType: 'Received', mail: { messageId: 'x' }, receipt: { action: { type: 'SNS', encoding: 'BASE64' } }, content: Buffer.from(mime).toString('base64') }));
    expect(ses.inbound[0]).toMatchObject({ from: 'olga@example.com', name: 'Olga', subject: 'Termin', text: 'Geht Freitag?', messageId: 'abc@mail' });
    expect((await parseSesMessage(JSON.stringify({ eventType: 'Complaint', mail: { messageId: 's1' } }))).events[0]).toMatchObject({ providerId: 's1', status: 'complained' });
    const form = parseMultipart('--XX\r\nContent-Disposition: form-data; name="sender"\r\n\r\nx@y.de\r\n--XX\r\nContent-Disposition: form-data; name="attachment-1"; filename="a.pdf"\r\n\r\n%PDF\r\n--XX--\r\n', 'multipart/form-data; boundary=XX');
    expect(form).toEqual({ sender: 'x@y.de' });
  });
});

describe('email providers: settings, sending, delivery reports, inbound', () => {
  it('validates credentials and activates a provider (secrets are never returned)', async () => {
    let r = await t.api.put('/api/settings/channels/mail/resend', { api_key: 'nope' });
    expect(r.status).toBe(400);
    r = await t.api.put('/api/settings/channels/mail/resend', { api_key: 're_test_123456789', activate: true });
    expect(r.status).toBe(400); // sender address missing
    r = await t.api.put('/api/settings/channels/mail/resend', { api_key: 're_test_123456789', webhook_secret: RESEND_SECRET, fromName: 'Malerei Paul', fromEmail: 'info@example.com', activate: true });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ configured: true, secrets_set: { api_key: true, webhook_secret: true } });
    expect(JSON.stringify(r.data)).not.toContain('re_test');
    expect(r.data.webhook_url).toMatch(new RegExp(`/hooks/mail/resend/${loc}/[\\w-]{20,}$`));
    const s = await settings();
    expect(s.active).toBe('resend');
    expect((await t.api.post('/api/settings/channels/mail/resend/test')).data.info).toContain('example.com (bestätigt)');
    expect((await t.api.put('/api/settings/channels/mail/unknown', {})).status).toBe(404);
  });

  it('Resend: sends, then signed webhooks move the status; a hard bounce sets DND', async () => {
    const m = await send();
    expect(m.status).toBe('sent');
    const out = calls.find((c) => c.url === 'https://api.resend.com/emails')!;
    expect(out.body).toMatchObject({ from: '"Malerei Paul" <info@example.com>', to: ['anna@example.com'], subject: 'Test' });
    expect(out.body.html).toContain('Hallo Anna');
    const row = t.app.db.get('SELECT provider_id FROM messages WHERE id = ?', m.id);
    const url = (await settings()).providers.resend.webhook_url;
    const signed = (payload: unknown, id: string) => {
      const raw = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      return post(url, raw, { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': signSvix(raw, id, ts, RESEND_SECRET) });
    };
    expect((await post(url, { type: 'email.delivered', data: { email_id: row.provider_id } }, { 'svix-id': 'a', 'svix-timestamp': '1', 'svix-signature': 'v1,x' })).status).toBe(401);
    expect((await post(url.replace(/\/[\w-]+$/, '/wrongkey'), {})).status).toBe(404);
    expect((await signed({ type: 'email.delivered', data: { email_id: row.provider_id } }, 'msg_a')).status).toBe(200);
    expect(t.app.db.get('SELECT status FROM messages WHERE id = ?', m.id).status).toBe('delivered');
    let bounced: any = null;
    t.app.events.on('email.bounced', (e) => void (bounced = e.data));
    await signed({ type: 'email.bounced', data: { email_id: row.provider_id, bounce: { type: 'Permanent', message: 'Mailbox does not exist' } } }, 'msg_b');
    await t.app.events.flush();
    expect(t.app.db.get('SELECT status, error FROM messages WHERE id = ?', m.id)).toEqual({ status: 'bounced', error: 'Mailbox does not exist' });
    expect(t.app.db.get('SELECT dnd FROM contacts WHERE id = ?', contactId).dnd).toBe(1);
    expect(bounced).toMatchObject({ contactId, messageId: m.id });
    t.app.db.run('UPDATE contacts SET dnd = 0 WHERE id = ?', contactId);
  });

  it('Postmark: sends, delivery + spam complaint, inbound mail', async () => {
    await t.api.put('/api/settings/channels/mail/postmark', { server_token: 'pm-server-token-0000000000', activate: true });
    const m = await send();
    expect(calls.at(-1)).toMatchObject({ url: 'https://api.postmarkapp.com/email', headers: { 'x-postmark-server-token': 'pm-server-token-0000000000' }, body: { To: 'anna@example.com', MessageStream: 'outbound' } });
    const id = t.app.db.get('SELECT provider_id FROM messages WHERE id = ?', m.id).provider_id;
    const url = (await settings()).providers.postmark.webhook_url;
    await post(url, { RecordType: 'Delivery', MessageID: id, ID: 1 });
    expect(t.app.db.get('SELECT status FROM messages WHERE id = ?', m.id).status).toBe('delivered');
    await post(url, { RecordType: 'SpamComplaint', MessageID: id, ID: 2 });
    expect(t.app.db.get('SELECT status FROM messages WHERE id = ?', m.id).status).toBe('complained');
    expect(t.app.db.get('SELECT dnd FROM contacts WHERE id = ?', contactId).dnd).toBe(1);
    t.app.db.run('UPDATE contacts SET dnd = 0 WHERE id = ?', contactId);
    const r = await post(url, { FromFull: { Email: 'neu@example.com', Name: 'Nele Neu' }, To: 'support@example.com', Subject: 'Anfrage', TextBody: 'Ich brauche ein Angebot', MessageID: 'pm-in-1' });
    expect(await r.json()).toMatchObject({ inbound: 1 });
    await post(url, { FromFull: { Email: 'neu@example.com', Name: 'Nele Neu' }, To: 'support@example.com', Subject: 'Anfrage', TextBody: 'Ich brauche ein Angebot', MessageID: 'pm-in-1' });
    const msgs = t.app.db.all(`SELECT m.* FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.email = 'neu@example.com'`);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ channel: 'email', direction: 'in', subject: 'Anfrage' });
  });

  it('Amazon SES: SigV4-signed send, SNS-signed events and subscription confirmation', async () => {
    let r = await t.api.put('/api/settings/channels/mail/ses', { access_key_id: 'AKIAIOSFODNN7EXAMPLE', secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'eu-central-1', configuration_set: 'gohigh', topic_arn: 'arn:aws:sns:eu-central-1:123456789012:ses-events', activate: true });
    expect(r.status).toBe(200);
    const m = await send();
    expect(m.status).toBe('sent');
    const out = calls.at(-1)!;
    expect(out.body).toMatchObject({ FromEmailAddress: '"Malerei Paul" <info@example.com>', Destination: { ToAddresses: ['anna@example.com'] }, ConfigurationSetName: 'gohigh' });
    expect(out.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect((await t.api.post('/api/settings/channels/mail/ses/test')).data.info).toContain('Sandbox');
    const id = t.app.db.get('SELECT provider_id FROM messages WHERE id = ?', m.id).provider_id;
    const url = (await settings()).providers.ses.webhook_url;
    // forged signature
    const forged = snsMessage({ Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: id } }) });
    forged.Message = JSON.stringify({ eventType: 'Bounce', bounce: { bounceType: 'Permanent' }, mail: { messageId: id } });
    expect((await post(url, forged, { 'content-type': 'text/plain; charset=UTF-8' })).status).toBe(401);
    // other topic
    expect((await post(url, snsMessage({ TopicArn: 'arn:aws:sns:eu-central-1:999999999999:other', Message: '{}' }), { 'content-type': 'text/plain' })).status).toBe(403);
    r = { status: 0, data: null } as any;
    const ok = await post(url, snsMessage({ Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: id } }) }, '1'), { 'content-type': 'text/plain; charset=UTF-8' });
    expect(ok.status).toBe(200);
    expect(t.app.db.get('SELECT status FROM messages WHERE id = ?', m.id).status).toBe('delivered');
    const conf = await post(url, snsMessage({ Type: 'SubscriptionConfirmation', Token: 'tok', SubscribeURL: 'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok', Message: 'You have chosen to subscribe' }), { 'content-type': 'text/plain' });
    expect(await conf.json()).toMatchObject({ confirmed: true });
    expect(calls.at(-1)!.url).toContain('Action=ConfirmSubscription');
  });

  it('Brevo and Mailgun: send, signed Mailgun events and inbound route', async () => {
    await t.api.put('/api/settings/channels/mail/brevo', { api_key: 'xkeysib-0123456789abcdef0123456789', activate: true });
    let m = await send();
    expect(calls.at(-1)).toMatchObject({ url: 'https://api.brevo.com/v3/smtp/email', body: { sender: { email: 'info@example.com', name: 'Malerei Paul' }, to: [{ email: 'anna@example.com' }] } });
    const bUrl = (await settings()).providers.brevo.webhook_url;
    await post(bUrl, { event: 'delivered', 'message-id': `<${t.app.db.get('SELECT provider_id FROM messages WHERE id = ?', m.id).provider_id}>`, id: 1 });
    expect(t.app.db.get('SELECT status FROM messages WHERE id = ?', m.id).status).toBe('delivered');

    await t.api.put('/api/settings/channels/mail/mailgun', { api_key: 'key-0123456789abcdef0123', webhook_signing_key: MAILGUN_KEY, domain: 'mg.example.com', region: 'eu', activate: true });
    m = await send();
    expect(calls.at(-1)).toMatchObject({ url: 'https://api.eu.mailgun.net/v3/mg.example.com/messages', body: { to: 'anna@example.com', from: '"Malerei Paul" <info@example.com>' } });
    const id = t.app.db.get('SELECT provider_id FROM messages WHERE id = ?', m.id).provider_id;
    expect(id).toMatch(/^mg-\d+@mg\.example\.com$/);
    const mUrl = (await settings()).providers.mailgun.webhook_url;
    const ts = String(Math.floor(Date.now() / 1000));
    const ev = (event: string, token: string, extra = {}) => ({ signature: { timestamp: ts, token, signature: signMailgun(ts, token, MAILGUN_KEY) }, 'event-data': { id: token, event, message: { headers: { 'message-id': id } }, ...extra } });
    expect((await post(mUrl, { ...ev('delivered', 't1'), signature: { timestamp: ts, token: 't1', signature: 'bad' } })).status).toBe(401);
    await post(mUrl, ev('delivered', 't2'));
    expect(t.app.db.get('SELECT status FROM messages WHERE id = ?', m.id).status).toBe('delivered');
    await post(mUrl, ev('failed', 't3', { severity: 'permanent', 'delivery-status': { description: 'No such user' } }));
    expect(t.app.db.get('SELECT status, error FROM messages WHERE id = ?', m.id)).toEqual({ status: 'bounced', error: 'No such user' });
    // inbound route as multipart/form-data
    const boundary = 'BOUNDARY42';
    const field = (k: string, v: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    const tok = 'inbound-token-1';
    const raw = field('sender', 'otto@example.com') + field('from', 'Otto <otto@example.com>') + field('recipient', 'in@mg.example.com') + field('subject', 'Rückfrage') + field('body-plain', 'Passt Montag?') + field('timestamp', ts) + field('token', tok) + field('signature', signMailgun(ts, tok, MAILGUN_KEY)) + `--${boundary}--\r\n`;
    const r = await t.api.raw(new URL(mUrl).pathname, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: raw });
    expect(await r.json()).toMatchObject({ inbound: 1 });
    const c = t.app.db.get(`SELECT * FROM contacts WHERE email = 'otto@example.com'`);
    expect(c.first_name).toBe('Otto');
  });

  it('switching off falls back to „nur speichern“; the catalogue shows the provider', async () => {
    const cat = await t.api.get('/api/integrations/catalog');
    expect(cat.data.items.find((x: any) => x.key === 'mail_providers')).toMatchObject({ status: 'ok', detail: expect.stringContaining('Mailgun') });
    await t.api.del('/api/settings/channels/mail/mailgun');
    expect((await settings()).active).toBe('log');
    // the hard bounce above switched Anna to „Nicht stören“
    expect(t.app.db.get('SELECT dnd FROM contacts WHERE id = ?', contactId).dnd).toBe(1);
    t.app.db.run('UPDATE contacts SET dnd = 0 WHERE id = ?', contactId);
    expect((await send()).status).toBe('logged');
  });
});
