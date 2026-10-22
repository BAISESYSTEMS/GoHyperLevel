import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { prefToken } from '../server/services/consent-model.js';
import { unsubscribeToken } from '../server/services/messaging.js';

/**
 * Consent ledger, Double-Opt-in, send gate (campaigns and workflows), unsubscribe and preference centre, proof export,
 * imports and the API. Mails go to the "log" provider: the confirmation link is read from the stored message.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const seen: { type: string; data: any }[] = [];
const UA = 'Mozilla/5.0 (Test) Browser/1.0';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  for (const type of ['consent.confirmed', 'consent.revoked', 'contact.unsubscribed']) t.app.events.on(type, (e) => void seen.push({ type, data: e.data }));
});
afterAll(async () => t.close());

const contact = async (email: string, extra: Record<string, unknown> = {}) => (await t.api.post('/api/contacts', { email, first_name: email.split('@')[0], ...extra })).data;
const consent = async (id: string) => (await t.api.get(`/api/contacts/${id}/consent`)).data;
const flush = () => t.app.events.flush();
/** The mails are sent in the background; wait until the condition holds. */
async function until<T>(fn: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}
const mailTo = (contactId: string, source: string) => t.app.db.all<any>(`SELECT * FROM messages WHERE contact_id = ? AND source = ? ORDER BY created_at`, contactId, source);
const linkIn = (body: string) => body.match(/\/consent\/confirm\/[\w.-]+/)![0];
const submit = (formId: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  t.api.raw(`/api/public/forms/${formId}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));

describe('ledger by hand', () => {
  it('records a yes with its proof, a revoke and a reset; every change is in the timeline and fires the triggers', async () => {
    const c = await contact('hand@example.com');
    const before = await consent(c.id);
    expect(before.channels.email).toMatchObject({ status: 'unknown', legacy: true });
    expect(before.policy).toBe('legacy');

    // A yes without any proof is worthless: refused.
    expect((await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'granted', channel: 'email', purposes: ['newsletter'] })).status).toBe(400);
    const yes = await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'granted', channel: 'email', purposes: ['newsletter'], note: 'Am Telefon am 12.03. zugestimmt', text: 'Ich möchte den Newsletter erhalten.' });
    expect(yes.status).toBe(200);
    expect(yes.data.channels.email).toMatchObject({ status: 'confirmed', legacy: false });
    expect(yes.data.events[0]).toMatchObject({ channel: 'email', purpose: 'newsletter', action: 'granted', source_kind: 'manual', text: 'Ich möchte den Newsletter erhalten.', text_version: 1, actor: expect.any(String) });
    expect(yes.data.events[0].note).toContain('Telefon');

    // Same wording = same text version; new wording = version 2.
    await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'granted', channel: 'email', purposes: ['marketing'], note: 'Mail', text: 'Ich möchte den Newsletter erhalten.' });
    const again = await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'granted', channel: 'sms', purposes: ['marketing'], note: 'Formular', text: 'Ich möchte SMS-Angebote.' });
    expect(again.data.events.find((e: any) => e.channel === 'sms').text_version).toBe(1);
    await t.api.post('/api/consent/texts', { key: 'manual:email', text: 'Ich möchte den Newsletter (neu) erhalten.' });
    const texts = (await t.api.get('/api/consent/texts')).data;
    expect(texts.filter((x: any) => x.key === 'manual:email').map((x: any) => x.version)).toEqual([2, 1]);

    const no = await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'revoked', channel: 'email', note: 'Per E-Mail widerrufen' });
    expect(no.data.channels.email.status).toBe('revoked');
    expect(no.data.channels.sms.status).toBe('confirmed');
    await flush();
    expect(seen.filter((s) => s.data.contactId === c.id).map((s) => s.type)).toEqual(expect.arrayContaining(['consent.confirmed', 'consent.revoked']));

    const detail = (await t.api.get(`/api/contacts/${c.id}`)).data;
    const types = detail.activities.map((a: any) => a.type);
    expect(types).toEqual(expect.arrayContaining(['consent.granted', 'consent.revoked']));
    expect(detail.activities.some((a: any) => a.type === 'consent.granted' && a.summary.includes('E-Mail · Newsletter'))).toBe(true);

    const reset = await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'reset' });
    expect(reset.data.channels.email).toMatchObject({ status: 'unknown', legacy: true });
    expect((await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'nonsense' })).status).toBe(400);
    expect((await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'granted', channel: 'fax', note: 'x' })).status).toBe(400);
  });

  it('DND is revoked for every communication channel, and changing it by hand is recorded', async () => {
    const c = await contact('dnd@example.com', { phone: '+491701111111' });
    await t.api.patch(`/api/contacts/${c.id}`, { dnd: true });
    await flush();
    const v = await consent(c.id);
    expect(v.contact.dnd).toBe(true);
    for (const ch of ['email', 'sms', 'whatsapp', 'phone']) expect(v.channels[ch].status).toBe('revoked');
    expect(v.channels.email.reason).toContain('Nicht stören');
    expect(v.events.some((e: any) => e.action === 'revoked' && e.source_kind === 'manual')).toBe(true);
    await t.api.patch(`/api/contacts/${c.id}`, { dnd: false });
    await flush();
    const after = await consent(c.id);
    expect(after.channels.email).toMatchObject({ status: 'unknown', legacy: true });
    expect(after.events.some((e: any) => e.action === 'reset')).toBe(true);
  });

  it('another sub-account sees nothing of it', async () => {
    const c = await contact('mine@example.com');
    const other = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data;
    const r = await t.api.get(`/api/contacts/${c.id}/consent`, { 'x-location-id': other.id });
    expect(r.status).toBe(404);
    expect((await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'granted', channel: 'email', note: 'x' }, { 'x-location-id': other.id })).status).toBe(404);
    expect((await t.api.get(`/api/contacts/${c.id}/consent/export.pdf`, { 'x-location-id': other.id })).status).toBe(404);
  });
});

describe('forms, Double-Opt-in and the confirmation page', () => {
  let form: any;
  let contactId = '';
  const fields = [
    { id: 'a', type: 'email', label: 'E-Mail', name: 'email', required: true },
    { id: 'b', type: 'text', label: 'Vorname', name: 'first_name' },
    { id: 'c', type: 'consent', label: 'Ich möchte den Newsletter per E-Mail erhalten und kann mich jederzeit abmelden.', name: 'newsletter' },
  ];

  it('a form only counts as an opt-in when the owner says so', async () => {
    form = (await t.api.post('/api/forms', { name: 'Newsletter', fields })).data;
    const plain = await submit(form.id, { email: 'plain@example.com', newsletter: 'ja' });
    expect(plain.status).toBe(200);
    expect((await consent(plain.data.contactId)).events).toEqual([]);
    expect(t.app.db.all('SELECT id FROM consent_doi WHERE contact_id = ?', plain.data.contactId)).toEqual([]);
  });

  it('records the yes with source, text version, IP network and browser fingerprint – and asks for the confirmation', async () => {
    await t.api.patch(`/api/forms/${form.id}`, { settings: { consent: { marketing: true, field: 'newsletter', purposes: ['newsletter'], doi: 'on' } } });
    // Not ticked: nothing.
    const none = await submit(form.id, { email: 'nein@example.com' }, { 'x-forwarded-for': '203.0.113.9' });
    expect((await consent(none.data.contactId)).events).toEqual([]);

    const r = await submit(form.id, { email: 'Anna@Example.com', first_name: 'Anna', newsletter: 'ja', _page: 'https://kunde.example/newsletter?utm_source=x#frag' });
    expect(r.status).toBe(200);
    contactId = r.data.contactId;
    const v = await consent(contactId);
    expect(v.channels.email).toMatchObject({ status: 'pending', legacy: false });
    expect(v.channels.email.purposes.newsletter.status).toBe('pending');
    const ev = v.events[0];
    expect(ev).toMatchObject({ action: 'granted', doi_required: true, source_kind: 'form', source_label: 'Newsletter', text_version: 1 });
    expect(ev.text).toContain('Newsletter per E-Mail');
    expect(ev.proof_url).toBe('https://kunde.example/newsletter');
    // Local test connection: 127.0.0.1 → the /24 network, nothing else.
    expect(ev.ip_net).toBe('127.0.0.0/24');
    const raw = t.app.db.get<any>('SELECT * FROM consent_events WHERE contact_id = ?', contactId)!;
    expect(raw.ua_digest).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(raw)).not.toContain('Mozilla');
    expect(v.doi[0]).toMatchObject({ status: 'pending', channel: 'email', purposes: ['newsletter'] });

    // The mail goes out (background) with a signed link.
    const mail = await until(() => mailTo(contactId, 'Double-Opt-in')[0]);
    expect(mail.subject).toContain('Bitte bestätige');
    expect(mail.body).toContain('unseren Newsletter');
    expect(mail.body).toContain('Newsletter per E-Mail erhalten');
    expect(mail.body).toMatch(/http:\/\/localhost\/consent\/confirm\/[\w.-]+/);
    expect(mail.purpose).toBe('transactional');
    expect(mail.consent_basis).toBe('exempt');
    // The same person signing up again gets one request, not two mails.
    await submit(form.id, { email: 'anna@example.com', newsletter: 'ja' });
    await new Promise((r) => setTimeout(r, 120));
    expect(mailTo(contactId, 'Double-Opt-in')).toHaveLength(1);
    expect(t.app.db.all('SELECT id FROM consent_doi WHERE contact_id = ?', contactId)).toHaveLength(1);
  });

  it('the link opens a page with a button – only the POST confirms (mail scanners open links)', async () => {
    const path = linkIn(mailTo(contactId, 'Double-Opt-in')[0].body);
    const page = await t.api.raw(path);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Anmeldung bestätigen');
    expect(html).toContain('Ja, Anmeldung bestätigen');
    expect(html).toContain('method="post"');
    expect(page.headers.get('x-robots-tag')).toContain('noindex');
    expect((await consent(contactId)).channels.email.status).toBe('pending');
    seen.length = 0;

    // A forged link does nothing.
    expect((await t.api.raw(path.slice(0, -2) + 'xx')).status).toBe(404);
    expect((await t.api.raw(path.slice(0, -2) + 'xx', { method: 'POST' })).status).toBe(404);
    expect((await consent(contactId)).channels.email.status).toBe('pending');

    const done = await t.api.raw(path, { method: 'POST', headers: { 'user-agent': UA } });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Danke, das hat geklappt');
    await flush();
    const v = await consent(contactId);
    expect(v.channels.email).toMatchObject({ status: 'confirmed', legacy: false });
    expect(v.events[0]).toMatchObject({ action: 'confirmed', source_kind: 'doi', actor: 'contact' });
    expect(v.events[0].note).toContain('anna@example.com');
    expect(v.doi[0].status).toBe('confirmed');
    expect(seen.find((s) => s.type === 'consent.confirmed')?.data).toMatchObject({ contactId, channel: 'email', purposes: ['newsletter'], doi: true });
    // Confirming twice is harmless.
    const twice = await t.api.raw(path, { method: 'POST' });
    expect(await twice.text()).toContain('Danke, das hat geklappt');
    expect(t.app.db.all(`SELECT id FROM consent_events WHERE contact_id = ? AND action = 'confirmed'`, contactId)).toHaveLength(1);
    // The timeline has it.
    expect((await t.api.get(`/api/contacts/${contactId}`)).data.activities.some((a: any) => a.type === 'consent.confirmed')).toBe(true);
  });

  it('the confirmation page and the redirect are customisable', async () => {
    await t.api.put('/api/consent/settings', { doi: { page: { success_title: 'Geschafft!', success_text: 'Willkommen an Bord.', redirect_url: 'https://example.com/danke' } } });
    const r = await submit(form.id, { email: 'bernd@example.com', newsletter: 'ja' });
    const mail = await until(() => mailTo(r.data.contactId, 'Double-Opt-in')[0]);
    const done = await t.api.raw(linkIn(mail.body), { method: 'POST', redirect: 'manual' });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('https://example.com/danke');
    await t.api.put('/api/consent/settings', { doi: { page: { redirect_url: '' } } });
    const r2 = await submit(form.id, { email: 'berta@example.com', newsletter: 'ja' });
    const mail2 = await until(() => mailTo(r2.data.contactId, 'Double-Opt-in')[0]);
    expect(await (await t.api.raw(linkIn(mail2.body), { method: 'POST' })).text()).toContain('Willkommen an Bord.');
  });

  it('a form without double opt-in confirms at once; per-form setting beats the sub-account default', async () => {
    const f2 = (await t.api.post('/api/forms', { name: 'Direkt', fields, settings: { consent: { marketing: true, field: 'newsletter', doi: 'off' } } })).data;
    const r = await submit(f2.id, { email: 'direkt@example.com', newsletter: 'ja' });
    expect((await consent(r.data.contactId)).channels.email.status).toBe('confirmed');
    expect(t.app.db.all('SELECT id FROM consent_doi WHERE contact_id = ?', r.data.contactId)).toEqual([]);
    // "Nur laut Einstellung": inherit takes the sub-account default (forms: on).
    const f3 = (await t.api.post('/api/forms', { name: 'Erbt', fields, settings: { consent: { marketing: true, field: 'newsletter' } } })).data;
    expect((await consent((await submit(f3.id, { email: 'erbt@example.com', newsletter: 'ja' })).data.contactId)).channels.email.status).toBe('pending');
    await t.api.put('/api/consent/settings', { doi: { sources: { form: false } } });
    expect((await consent((await submit(f3.id, { email: 'erbt2@example.com', newsletter: 'ja' })).data.contactId)).channels.email.status).toBe('confirmed');
    await t.api.put('/api/consent/settings', { doi: { sources: { form: true } } });
  });

  it('a form on a funnel page is recorded as coming from that funnel', async () => {
    const funnel = (await t.api.post('/api/funnels', { name: 'Lead Funnel', template: 'leadmagnet' })).data;
    const r = await submit(form.id, { email: 'funnel@example.com', newsletter: 'ja', _page: `http://localhost/p/${funnel.slug}/start?utm_source=x` });
    const v = await consent(r.data.contactId);
    expect(v.events[0]).toMatchObject({ source_kind: 'funnel' });
    expect(v.events[0].source_label).toContain('Lead Funnel');
  });

  it('reminds after X hours, expires, and an expired link says so', async () => {
    const r = await submit(form.id, { email: 'spaet@example.com', newsletter: 'ja' });
    const cid = r.data.contactId;
    const mail = await until(() => mailTo(cid, 'Double-Opt-in')[0]);
    const path = linkIn(mail.body);
    await t.api.put('/api/consent/settings', { doi: { reminder_hours: 24, expiry_hours: 72 } });
    const doi = t.app.db.get<any>('SELECT * FROM consent_doi WHERE contact_id = ?', cid)!;
    // 10 hours: nothing yet.
    t.app.db.run('UPDATE consent_doi SET mailed_at = ? WHERE id = ?', new Date(Date.now() - 10 * 3600_000).toISOString(), doi.id);
    await t.app.services.consent.tick();
    expect(mailTo(cid, 'Double-Opt-in Erinnerung')).toHaveLength(0);
    // 25 hours: one reminder, only once.
    t.app.db.run('UPDATE consent_doi SET mailed_at = ? WHERE id = ?', new Date(Date.now() - 25 * 3600_000).toISOString(), doi.id);
    const first = await t.app.services.consent.tick();
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    await t.app.services.consent.tick();
    const rem = mailTo(cid, 'Double-Opt-in Erinnerung');
    expect(rem).toHaveLength(1);
    expect(rem[0].subject).toMatch(/^Erinnerung: /);
    expect(rem[0].body).toContain('Erinnerung');
    expect((await t.api.get(`/api/contacts/${cid}`)).data.activities.some((a: any) => a.type === 'consent.reminded')).toBe(true);

    // The request runs out: events, status, timeline, and a message on the page.
    t.app.db.run('UPDATE consent_doi SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), doi.id);
    const tick = await t.app.services.consent.tick();
    expect(tick.expired).toBeGreaterThanOrEqual(1);
    const v = await consent(cid);
    expect(v.channels.email).toMatchObject({ status: 'unknown', legacy: false });
    expect(v.events[0]).toMatchObject({ action: 'expired', actor: 'system' });
    expect(v.doi[0].status).toBe('expired');
    expect((await t.api.get(`/api/contacts/${cid}`)).data.activities.some((a: any) => a.type === 'consent.expired')).toBe(true);
    const page = await t.api.raw(path);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain('abgelaufen');
    const post = await t.api.raw(path, { method: 'POST' });
    expect(post.status).toBe(410);
    expect((await consent(cid)).channels.email.status).toBe('unknown');
  });

  it('a revoke cancels an open request – the old link cannot bring the consent back', async () => {
    const r = await submit(form.id, { email: 'zurueck@example.com', newsletter: 'ja' });
    const cid = r.data.contactId;
    const path = linkIn((await until(() => mailTo(cid, 'Double-Opt-in')[0])).body);
    await t.api.post(`/api/contacts/${cid}/consent`, { action: 'revoked', channel: 'email' });
    const page = await t.api.raw(path, { method: 'POST' });
    expect(page.status).toBe(410);
    expect((await consent(cid)).channels.email.status).toBe('revoked');
  });
});

describe('send gate: campaigns and workflows', () => {
  const ids: Record<string, string> = {};
  const grant = (id: string, extra: Record<string, unknown> = {}) => t.api.post(`/api/contacts/${id}/consent`, { action: 'granted', channel: 'email', purposes: ['newsletter'], note: 'Test', ...extra });

  it('sets up contacts in every state', async () => {
    for (const n of ['ok', 'weg', 'offen', 'alt', 'abgelaufen', 'dnd']) ids[n] = (await contact(`gate-${n}@example.com`, { tags: ['gate'] })).id;
    await grant(ids.ok);
    await grant(ids.weg);
    await t.api.post(`/api/contacts/${ids.weg}/consent`, { action: 'revoked', channel: 'email' });
    await t.api.post(`/api/contacts/${ids.offen}/consent`, { action: 'granted', channel: 'email', purposes: ['newsletter'], doi: true });
    await t.api.post(`/api/contacts/${ids.abgelaufen}/consent`, { action: 'granted', channel: 'email', purposes: ['newsletter'], doi: true });
    t.app.db.run('UPDATE consent_doi SET expires_at = ? WHERE contact_id = ?', new Date(Date.now() - 1000).toISOString(), ids.abgelaufen);
    await t.app.services.consent.tick();
    await t.api.patch(`/api/contacts/${ids.dnd}`, { dnd: true });
    await grant(ids.dnd);
    // The explicit yes after the DND... the DND still wins until somebody lifts it.
    expect((await consent(ids.offen)).channels.email.status).toBe('pending');
    expect((await consent(ids.abgelaufen)).channels.email).toMatchObject({ status: 'unknown', legacy: false });
  });

  it('a campaign goes only to contacts with a valid consent (policy "legacy": plus the old ones), the rest is listed as skipped with the reason', async () => {
    const camp = (await t.api.post('/api/campaigns', { name: 'Herbst', subject: 'Hallo', body: 'Neuigkeiten', filter: { tags: ['gate'] } })).data;
    const aud = (await t.api.post(`/api/campaigns/${camp.id}/audience`, { filter: { tags: ['gate'] }, channel: 'email' })).data;
    // dnd is dropped before; ok + alt reachable; weg, offen, abgelaufen blocked by the ledger.
    expect(aud).toMatchObject({ total: 6, reachable: 2, no_consent: 3 });
    const sent = (await t.api.post(`/api/campaigns/${camp.id}/send`, {})).data;
    expect(sent.recipients).toBe(2);
    const rec = (await t.api.get(`/api/campaigns/${camp.id}/recipients`)).data;
    const by = Object.fromEntries(rec.map((r: any) => [r.email, r]));
    expect(by['gate-ok@example.com'].status).toBe('sent');
    expect(by['gate-alt@example.com'].status).toBe('sent');
    expect(by['gate-weg@example.com']).toMatchObject({ status: 'skipped', error: 'Einwilligung widerrufen' });
    expect(by['gate-offen@example.com']).toMatchObject({ status: 'skipped' });
    expect(by['gate-offen@example.com'].error).toContain('Double-Opt-in');
    expect(by['gate-abgelaufen@example.com'].error).toContain('abgelaufen');
    expect(by['gate-dnd@example.com']).toBeUndefined();
    // The mails are marked: advertising, on which basis.
    const m = (c: string) => t.app.db.get<any>(`SELECT purpose, consent_basis, status FROM messages WHERE contact_id = ? AND source LIKE 'Kampagne%'`, ids[c])!;
    expect(m('ok')).toMatchObject({ purpose: 'marketing', consent_basis: 'confirmed', status: 'logged' });
    expect(m('alt')).toMatchObject({ purpose: 'marketing', consent_basis: 'legacy' });
  });

  it('policy "confirmed" sends only to proven consent', async () => {
    await t.api.put('/api/consent/settings', { policy: 'confirmed' });
    const camp = (await t.api.post('/api/campaigns', { name: 'Strikt', subject: 'Hallo', body: 'Nur Bestätigte', filter: { tags: ['gate'] } })).data;
    expect((await t.api.post(`/api/campaigns/${camp.id}/audience`, { filter: { tags: ['gate'] }, channel: 'email' })).data).toMatchObject({ reachable: 1, no_consent: 4 });
    await t.api.post(`/api/campaigns/${camp.id}/send`, {});
    const rec = (await t.api.get(`/api/campaigns/${camp.id}/recipients`)).data;
    expect(rec.find((r: any) => r.email === 'gate-alt@example.com')).toMatchObject({ status: 'skipped' });
    expect(rec.find((r: any) => r.email === 'gate-alt@example.com').error).toContain('nachgewiesene Einwilligung');
    expect(rec.find((r: any) => r.email === 'gate-ok@example.com').status).toBe('sent');
  });

  it('workflow e-mail steps respect it too; a service step is exempt but marked', async () => {
    const wf = (
      await t.api.post('/api/workflows', {
        name: 'Gate-Test',
        trigger: { type: 'contact.tag_added', config: { tag: 'gate-wf' } },
        steps: [
          { type: 'send_email', subject: 'Werbung', body: 'Kauf was' },
          { type: 'send_email', subject: 'Service', body: 'Dein Zugang', purpose: 'transactional' },
        ],
      })
    ).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    for (const n of ['ok', 'weg', 'offen']) await t.api.post(`/api/contacts/${ids[n]}/tags`, { add: ['gate-wf'] });
    await flush();
    const subjects = (c: string) => t.app.db.all<any>(`SELECT subject, status, purpose, consent_basis, error FROM messages WHERE contact_id = ? AND source = 'Workflow' ORDER BY created_at`, ids[c]);
    expect(subjects('ok')).toMatchObject([{ subject: 'Werbung', status: 'logged', purpose: 'marketing', consent_basis: 'confirmed' }, { subject: 'Service', purpose: 'transactional', consent_basis: 'exempt' }]);
    const weg = subjects('weg');
    expect(weg[0]).toMatchObject({ subject: 'Werbung', status: 'failed', consent_basis: 'blocked', error: 'Einwilligung widerrufen' });
    // The service mail still reaches somebody who revoked advertising (no DND, only the ledger).
    expect(weg.find((m: any) => m.subject === 'Service')).toMatchObject({ purpose: 'transactional', consent_basis: 'exempt' });
    expect(weg.find((m: any) => m.subject === 'Service')!.status).not.toBe('failed');
    expect(subjects('offen')[0].error).toContain('Double-Opt-in');
    await t.api.put('/api/consent/settings', { policy: 'legacy' });
  });

  it('manual messages are conversation, not advertising, and tests mails to a contact are not gated', async () => {
    const r = await t.api.post('/api/messages', { contact_id: ids.weg, channel: 'email', subject: 'Antwort', body: 'Ihre Frage …' });
    expect(r.status).toBe(200);
    expect(t.app.db.get<any>(`SELECT purpose, consent_basis, status FROM messages WHERE id = ?`, r.data.id)).toMatchObject({ purpose: 'conversation', consent_basis: '' });
    expect(r.data.status).not.toBe('failed');
  });

  it('satisfaction surveys (CSAT) are advertising: no survey after "Nicht stören" or a withdrawal, the others are marked as such', async () => {
    const csat = async (who: string) => {
      const ticket = (await t.api.post('/api/tickets', { subject: `Frage von ${who}`, contact_id: ids[who] })).data;
      return { r: await t.app.services.sendCsat(loc, ticket.id, true), ticket: ticket.id };
    };
    const ok = await csat('ok');
    expect(ok.r.status).toBe('logged');
    const m = t.app.db.get<any>(`SELECT purpose, consent_basis, body FROM messages WHERE contact_id = ? AND source = 'Zufriedenheit (CSAT)'`, ids.ok)!;
    expect(m).toMatchObject({ purpose: 'marketing', consent_basis: 'confirmed' });
    for (const who of ['weg', 'dnd']) {
      const { r, ticket } = await csat(who);
      expect(r, who).toMatchObject({ status: 'skipped', reason: who === 'dnd' ? 'Kontakt hat „Nicht stören“ aktiv' : 'Einwilligung widerrufen' });
      expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND source = 'Zufriedenheit (CSAT)'`, ids[who])!.n).toBe(0);
      // Not counted as asked: a later consent lets it go out by hand.
      expect(t.app.db.get<any>('SELECT csat_sent_at FROM tickets WHERE id = ?', ticket)!.csat_sent_at).toBeNull();
    }
  });

  it('review requests are advertising too – by hand and from a workflow step', async () => {
    const ok = await t.api.post('/api/reviews/request', { contact_id: ids.ok });
    expect(ok.status).toBe(200);
    expect(t.app.db.get<any>(`SELECT purpose, consent_basis FROM messages WHERE contact_id = ? AND source = 'Bewertungsanfrage'`, ids.ok)).toMatchObject({ purpose: 'marketing', consent_basis: 'confirmed' });
    for (const who of ['weg', 'dnd']) {
      const r = await t.api.post('/api/reviews/request', { contact_id: ids[who] });
      expect(r.status, who).toBe(400);
      expect(r.data.error).toMatch(who === 'dnd' ? /Nicht stören/ : /widerrufen/);
      expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM review_requests WHERE contact_id = ?', ids[who])!.n).toBe(0);
    }
    const wf = (await t.api.post('/api/workflows', { name: 'Bewertung', trigger: { type: 'contact.tag_added', config: { tag: 'gate-review' } }, steps: [{ type: 'review_request', channel: 'email' }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    await t.api.post(`/api/contacts/${ids.weg}/tags`, { add: ['gate-review'] });
    await flush();
    const run = await until(() => t.app.db.get<any>(`SELECT status, log FROM workflow_runs WHERE workflow_id = ? AND contact_id = ? AND status != 'active'`, wf.id, ids.weg));
    // The step reports why nothing went out, like an e-mail step.
    expect(run.log).toContain('Einwilligung widerrufen');
    // (the one asked by hand above and the one of the workflow – both stopped)
    expect(t.app.db.all<any>(`SELECT status, consent_basis FROM messages WHERE contact_id = ? AND source = 'Bewertungsanfrage'`, ids.weg)).toEqual([{ status: 'failed', consent_basis: 'blocked' }, { status: 'failed', consent_basis: 'blocked' }]);
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM review_requests WHERE contact_id = ?', ids.weg)!.n).toBe(0);
  });
});

describe('unsubscribe and the preference centre', () => {
  let c: any;
  it('the unsubscribe link records the withdrawal with its proof data and points to the preference centre', async () => {
    c = await contact('abmeld@example.com', { phone: '+491702222222' });
    await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'granted', channel: 'email', purposes: ['newsletter', 'marketing'], note: 'x' });
    await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'granted', channel: 'sms', purposes: ['marketing'], note: 'x' });
    seen.length = 0;
    const r = await t.api.raw(`/u/${c.id}/${unsubscribeToken(t.app, c.id)}`, { method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=1' });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Abgemeldet');
    expect(html).toContain(`/consent/p/${c.id}/${prefToken(t.app.config.secret, c.id)}`);
    await flush();
    const v = await consent(c.id);
    expect(v.contact.dnd).toBe(true);
    expect(v.channels.email.status).toBe('revoked');
    expect(v.channels.sms.status).toBe('revoked');
    const ev = v.events.find((e: any) => e.source_kind === 'unsubscribe');
    expect(ev).toMatchObject({ action: 'revoked', actor: 'contact' });
    expect(ev.ip_net).toBe('127.0.0.0/24');
    expect(seen.map((s) => s.type)).toEqual(expect.arrayContaining(['consent.revoked', 'contact.unsubscribed']));
    // RFC 8058 one-click POST works the same.
    const c2 = await contact('abmeld2@example.com');
    const post = await t.api.raw(`/u/${c2.id}/${unsubscribeToken(t.app, c2.id)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    expect(post.status).toBe(200);
    expect((await consent(c2.id)).channels.email.status).toBe('revoked');
  });

  it('marketing mails carry the link to the preference centre in the footer and the headers', async () => {
    const c3 = await contact('footer@example.com');
    await t.app.services.consent.grant({ locationId: loc, contactId: c3.id, channel: 'email', purposes: ['newsletter'], source: { kind: 'manual' }, note: 'x' });
    const { composeEmail } = await import('../server/services/messaging.js');
    const url = t.app.services.consent.prefsUrl(c3.id);
    expect(url).toBe(`http://localhost/consent/p/${c3.id}/${prefToken(t.app.config.secret, c3.id)}`);
    const mail = composeEmail({ body: 'Hallo', unsubUrl: 'https://crm.de/u/1', prefsUrl: url, company: 'Firma' });
    expect(mail.html).toContain(`<a href="${url}"`);
    expect(mail.html).toMatch(/Einstellungen<\/a> · <a href="https:\/\/crm\.de\/u\/1"[^>]*>Abmelden<\/a>/);
    expect(mail.text).toContain(`Einstellungen: ${url}`);
    // A hand-built footer can use %%preferences_url%%.
    expect(composeEmail({ body: '<html><body><a href="%%preferences_url%%">x</a> <a href="%%unsubscribe_url%%">y</a></body></html>', isHtml: true, unsubUrl: 'https://crm.de/u/1', prefsUrl: url, company: 'F' }).html).toContain(`href="${url}"`);
    // Without the consent module's link the token falls back to the unsubscribe link, plain mails stay as they were.
    expect(composeEmail({ body: '<html><body><a href="%%preferences_url%%">x</a> <a href="%%unsubscribe_url%%">y</a></body></html>', isHtml: true, unsubUrl: 'https://crm.de/u/1', company: 'F' }).html).not.toContain('%%preferences_url%%');
    expect(composeEmail({ body: 'Hallo', unsubUrl: 'https://crm.de/u/1', company: 'Firma' }).text).toBe('Hallo\n\n--\nFirma\nAbmelden: https://crm.de/u/1');
    // The switch in the settings.
    await t.api.put('/api/consent/settings', { footer_link: false });
    expect(t.app.services.consent.footerPrefsUrl(loc, c3.id)).toBe('');
    await t.api.put('/api/consent/settings', { footer_link: true });
  });

  it('the preference centre: opt in and out per channel and purpose, and opt-in lifts the DND', async () => {
    const path = `/consent/p/${c.id}/${prefToken(t.app.config.secret, c.id)}`;
    expect((await t.api.raw(`/consent/p/${c.id}/${'0'.repeat(24)}`)).status).toBe(404);
    const page = await t.api.raw(path);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Deine Einstellungen');
    expect(html).toContain('p__email__newsletter');
    expect(html).toContain('p__sms__marketing');
    expect(html).not.toContain('abmeld@example.com');
    expect(html).toContain('a•••@e•••.com');
    // Opt in to the newsletter only.
    const save = await t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, body: 'do=save&p__email__newsletter=1' });
    expect(save.status).toBe(303);
    const v = await consent(c.id);
    expect(v.contact.dnd).toBe(false);
    expect(v.channels.email.purposes.newsletter.status).toBe('confirmed');
    expect(v.channels.email.purposes.marketing.status).toBe('revoked');
    expect(v.channels.sms.status).toBe('revoked');
    const ev = v.events.find((e: any) => e.source_kind === 'preferences' && e.action === 'granted');
    expect(ev).toMatchObject({ purpose: 'newsletter', actor: 'contact' });
    expect(ev.text).toContain('Newsletter');
    // And out again, then "alles abbestellen".
    await t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'do=save' });
    expect((await consent(c.id)).channels.email.purposes.newsletter.status).toBe('revoked');
    await t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'do=save&p__email__newsletter=1&p__sms__marketing=1' });
    expect((await consent(c.id)).channels.sms.status).toBe('confirmed');
    await t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'do=none' });
    const end = await consent(c.id);
    expect(end.contact.dnd).toBe(true);
    expect(end.channels.email.status).toBe('revoked');
    expect(await (await t.api.raw(`${path}?none=1`)).text()).toContain('keine Werbung mehr');
  });
});

describe('proof export', () => {
  it('CSV, PDF and JSON of one contact, and the privacy export carries it', async () => {
    const c = await contact('proof@example.com', { first_name: 'Paula', last_name: 'Beweis' });
    await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'granted', channel: 'email', purposes: ['newsletter'], note: 'Formular „Newsletter“, Haken gesetzt', text: 'Ich möchte den Newsletter erhalten.', proof_url: 'https://example.com/newsletter' });
    await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'revoked', channel: 'email', purposes: ['newsletter'], note: 'Abmeldelink' });
    const headers = { cookie: t.api.cookie, 'x-location-id': loc };
    const csv = await t.api.raw(`/api/contacts/${c.id}/consent/export.csv`, { headers });
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('attachment');
    const text = await csv.text();
    const lines = text.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('Zeitpunkt,Kanal,Zweck,Ereignis,Quelle,Einwilligungstext,Textversion,Text-Fingerabdruck,IP-Netz,Browser-Fingerabdruck,Nachweis-Link,Notiz,Bestätigungs-ID');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('Einwilligung erteilt');
    expect(lines[1]).toContain('Ich möchte den Newsletter erhalten.');
    expect(lines[1]).toContain('https://example.com/newsletter');
    expect(lines[2]).toContain('Widerrufen');

    const pdf = await t.api.raw(`/api/contacts/${c.id}/consent/export.pdf`, { headers });
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1500);

    const proof = (await t.api.get(`/api/contacts/${c.id}/consent/proof`)).data;
    expect(proof.contact.name).toBe('Paula Beweis');
    expect(proof.events).toHaveLength(2);
    expect(proof.status.email.status).toBe('revoked');
    expect(proof.note).toContain('Art. 7');

    const exp = JSON.parse(await (await t.api.raw(`/api/contacts/${c.id}/privacy-export`, { headers })).text());
    expect(Object.keys(exp.data)).toEqual(expect.arrayContaining(['consent_events', 'Einwilligungsnachweis (Zusammenfassung)']));
    const sum = exp.data['Einwilligungsnachweis (Zusammenfassung)'][0];
    expect(sum.events[0].text).toContain('Newsletter');
    // A spreadsheet must not run a formula from a note.
    await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'granted', channel: 'email', purposes: ['marketing'], note: '=HYPERLINK("http://evil")' });
    const again = await (await t.api.raw(`/api/contacts/${c.id}/consent/export.csv`, { headers })).text();
    expect(again).toContain("'=HYPERLINK");
  });

  it('erasing a contact removes its ledger and confirmation rows', async () => {
    const c = await contact('weg@example.com');
    await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'granted', channel: 'email', purposes: ['newsletter'], doi: true });
    await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'granted', channel: 'sms', purposes: ['marketing'], note: 'x' });
    expect(t.app.db.all('SELECT id FROM consent_events WHERE contact_id = ?', c.id).length).toBeGreaterThan(0);
    const r = await t.api.post(`/api/contacts/${c.id}/erase`, { confirm: 'weg@example.com' });
    expect(r.status).toBe(200);
    expect(r.data.erased.consent_events).toBeGreaterThan(0);
    expect(t.app.db.all('SELECT id FROM consent_events WHERE contact_id = ?', c.id)).toEqual([]);
    expect(t.app.db.all('SELECT id FROM consent_doi WHERE contact_id = ?', c.id)).toEqual([]);
  });
});

describe('imports and the API', () => {
  const csv = 'E-Mail,Vorname\nimp1@example.com,Ida\nimp2@example.com,Ingo\n';
  it('an import without proof is "unbekannt (Altbestand)" with a note about the source', async () => {
    const r = await t.api.post('/api/contacts/import', { csv, source_label: 'Mailchimp-Export 2024' });
    expect(r.data).toMatchObject({ created: 2, consent: { mode: 'legacy', contacts: 2 } });
    const id = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'imp1@example.com'`)!.id;
    const v = await consent(id);
    expect(v.channels.email).toMatchObject({ status: 'unknown', legacy: true });
    expect(v.events[0]).toMatchObject({ action: 'legacy', source_kind: 'import', source_label: 'Mailchimp-Export 2024' });
    expect(v.events[0].note).toContain('ohne Einwilligungsnachweis');
  });

  it('an import can come with proven consent (note says how) or ask everybody to confirm (double opt-in)', async () => {
    const proven = await t.api.post('/api/contacts/import', { csv: 'E-Mail\nprov@example.com\n', consent: 'confirmed', consent_note: 'Einwilligung aus Shopify-Checkout mit Haken, Export vom 01.10.', source_label: 'Shopify' });
    expect(proven.data.consent).toMatchObject({ mode: 'confirmed' });
    const pid = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'prov@example.com'`)!.id;
    expect((await consent(pid)).channels.email.status).toBe('confirmed');

    const doi = await t.api.post('/api/contacts/import', { csv: 'E-Mail,Vorname\nreconf1@example.com,Rita\nreconf2@example.com,Rolf\n', consent: 'doi', source_label: 'Altliste' });
    expect(doi.data.consent).toMatchObject({ mode: 'doi', contacts: 2 });
    const rid = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'reconf1@example.com'`)!.id;
    expect((await consent(rid)).channels.email.status).toBe('pending');
    // The mails are queued and go out with the tick.
    expect(mailTo(rid, 'Double-Opt-in')).toHaveLength(0);
    expect((await t.app.services.consent.tick()).sent).toBeGreaterThanOrEqual(2);
    const rid2 = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'reconf2@example.com'`)!.id;
    expect(mailTo(rid2, 'Double-Opt-in')).toHaveLength(1);
    expect(mailTo(rid, 'Double-Opt-in')).toHaveLength(1);
    expect(await (await t.api.raw(linkIn(mailTo(rid, 'Double-Opt-in')[0].body), { method: 'POST' })).text()).toContain('Willkommen an Bord.');
    expect((await consent(rid)).channels.email.status).toBe('confirmed');
  });

  it('the API records consent given with a contact (and can ask for the confirmation)', async () => {
    const plain = (await t.api.post('/api/contacts', { email: 'api1@example.com' })).data;
    expect((await consent(plain.id)).events).toEqual([]);
    const yes = (await t.api.post('/api/contacts', { email: 'api2@example.com', consent: true })).data;
    const v = await consent(yes.id);
    expect(v.channels.email.status).toBe('confirmed');
    expect(v.events[0]).toMatchObject({ source_kind: 'api', purpose: 'newsletter' });
    const doi = (await t.api.post('/api/contacts', { email: 'api3@example.com', consent: { doi: true, purposes: ['newsletter', 'marketing'], text: 'Ich möchte Neuigkeiten.', proof_url: 'https://shop.example/checkout' } })).data;
    const d = await consent(doi.id);
    expect(d.channels.email.status).toBe('pending');
    expect(d.events.map((e: any) => e.purpose).sort()).toEqual(['marketing', 'newsletter']);
    expect(d.events[0].proof_url).toBe('https://shop.example/checkout');
  });
});

describe('settings and overview', () => {
  it('validates the settings and counts the states', async () => {
    expect((await t.api.put('/api/consent/settings', { policy: 'egal' })).status).toBe(400);
    const s = (await t.api.put('/api/consent/settings', { policy: 'confirmed', doi: { reminder_hours: 12 } })).data.settings;
    expect(s).toMatchObject({ policy: 'confirmed', policy_changed_at: expect.any(String) });
    expect(s.doi.reminder_hours).toBe(12);
    expect(s.doi.expiry_hours).toBe(72);
    const view = (await t.api.get('/api/consent/settings')).data;
    expect(view.channels.map((c: any) => c.key)).toEqual(['email', 'sms', 'whatsapp', 'phone', 'tracking']);
    const o = (await t.api.get('/api/consent/overview')).data;
    expect(o.policy).toBe('confirmed');
    expect(o.email.confirmed).toBeGreaterThan(0);
    expect(o.email.revoked).toBeGreaterThan(0);
    expect(o.email.unknown_legacy).toBeGreaterThan(0);
    expect(o.email.total).toBe(o.email.confirmed + o.email.pending + o.email.revoked + o.email.unknown + o.email.unknown_legacy);
    const log = (await t.api.get('/api/consent/log?limit=5&action=confirmed')).data;
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((e: any) => e.action === 'confirmed')).toBe(true);
    await t.api.put('/api/consent/settings', { policy: 'legacy' });
  });
});
