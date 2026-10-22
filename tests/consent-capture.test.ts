import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/**
 * Where consent comes in besides forms: webinar registration, community sign-up – with and without double opt-in –, a form that
 * says it collects an opt-in but has no consent field, and the inquiry acknowledgment of the "Neuer Lead" recipe (a service message).
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const UA = 'Mozilla/5.0 (Test) Browser/1.0';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(async () => t.close());

const flush = () => t.app.events.flush();
const contactByEmail = (email: string) => t.app.db.get<any>('SELECT * FROM contacts WHERE location_id = ? AND email = ?', loc, email)!;
const consentOf = async (email: string) => (await t.api.get(`/api/contacts/${contactByEmail(email).id}/consent`)).data;
const post = async (path: string, body: unknown) => {
  const r = await t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify(body) });
  return { status: r.status, data: (await r.json().catch(() => null)) as any };
};

describe('webinar registration', () => {
  const MONDAY = '2026-11-09T18:00:00.000Z';
  let slug = '';
  let id = '';

  beforeAll(async () => {
    t.app.services.webinarNow = () => Date.parse('2026-11-06T12:00:00Z');
    const created = await t.api.post('/api/webinars', { title: 'Mehr Kunden', description: 'Text', presenter_name: 'Erika Muster' });
    id = created.data.id;
    slug = created.data.slug;
    const set = await t.api.patch(`/api/webinars/${id}`, {
      video: { type: 'url', url: 'https://cdn.example.com/webinar.mp4' },
      duration_s: 3600,
      schedule: { fixed: { enabled: true, weekdays: ['mon'], times: ['19:00'] }, horizon_days: 21, late_join_min: 30, max_per_session: 10 },
      settings: { registration: { ask_phone: true } },
      status: 'published',
    });
    expect(set.status, JSON.stringify(set.data)).toBe(200);
  });

  const register = (email: string, extra: Record<string, unknown> = {}) => post(`/api/public/webinars/${slug}/register`, { first_name: 'Erika', email, consent: true, session: MONDAY, tz: 'Europe/Berlin', ...extra });

  it('records the ticked consent box with the text of the page (default text included), source and proof link', async () => {
    expect((await register('web1@example.com')).status).toBe(200);
    await flush();
    const c = await consentOf('web1@example.com');
    const e = c.events.find((x: any) => x.purpose === 'webinar' && x.channel === 'email');
    expect(e, JSON.stringify(c.events)).toBeTruthy();
    expect(e).toMatchObject({ action: 'granted', source_kind: 'webinar', source_label: 'Mehr Kunden' });
    expect(e.proof_url).toContain(`/w/${slug}`);
    expect(e.text).toContain('Erinnerungen per E-Mail');
    expect(c.channels.email.purposes.webinar.status).toBe('confirmed');
    // no double opt-in by default for webinars: no extra mail
    expect(t.app.db.all("SELECT id FROM consent_doi WHERE contact_id = ?", contactByEmail('web1@example.com').id)).toEqual([]);
  });

  it('the SMS reminder box is its own consent on the channel SMS', async () => {
    expect((await register('web2@example.com', { phone: '+491701112233', sms_consent: true })).status).toBe(200);
    await flush();
    const c = await consentOf('web2@example.com');
    expect(c.events.some((x: any) => x.channel === 'sms' && x.purpose === 'webinar' && x.action === 'granted')).toBe(true);
    expect((await register('web3@example.com', { phone: '+491701112244' })).status).toBe(200);
    await flush();
    expect((await consentOf('web3@example.com')).events.some((x: any) => x.channel === 'sms')).toBe(false);
  });

  it('with double opt-in for webinars the consent is pending until the link is clicked', async () => {
    await t.api.put('/api/consent/settings', { doi: { sources: { webinar: true } } });
    expect((await register('web4@example.com')).status).toBe(200);
    await flush();
    const row = t.app.db.get<any>('SELECT * FROM consent_doi WHERE contact_id = ?', contactByEmail('web4@example.com').id);
    expect(row).toMatchObject({ status: 'pending', channel: 'email' });
    expect((await consentOf('web4@example.com')).channels.email.purposes.webinar.status).toBe('pending');
    await t.api.put('/api/consent/settings', { doi: { sources: { webinar: false } } });
  });
});

describe('community sign-up', () => {
  const SLUG = 'consent-club';
  let tier: any;

  beforeAll(async () => {
    const group = (await t.api.post('/api/community/groups', { name: 'Consent Club', access: { mode: 'join' } })).data;
    const saved = await t.api.put(`/api/community/groups/${group.id}/join/page`, { slug: SLUG, enabled: true, consent_text: 'Ich möchte Neuigkeiten per E-Mail bekommen.', privacy_url: 'https://example.com/datenschutz' });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    tier = saved.data.tiers[0];
  });

  const join = async (fields: Record<string, string>) => {
    const page = await t.api.raw(`/c/${SLUG}/join`, { redirect: 'manual' });
    const tok = (await page.text()).match(/name="_t" value="([^"]+)"/)![1];
    const r = await t.api.raw(`/c/${SLUG}/join`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, body: new URLSearchParams({ _t: tok, tier: tier.id, ...fields }).toString() });
    await r.text();
    await flush();
    return r.status;
  };

  it('a ticked consent box is recorded for the purpose community – an unticked one is not', async () => {
    expect(await join({ name: 'Anna Beispiel', email: 'club1@example.com', consent: '1', terms: '1' })).toBeLessThan(400);
    const c = await consentOf('club1@example.com');
    const e = c.events.find((x: any) => x.purpose === 'community');
    expect(e, JSON.stringify(c.events)).toMatchObject({ action: 'granted', source_kind: 'community', source_label: 'Consent Club' });
    expect(e.text).toBe('Ich möchte Neuigkeiten per E-Mail bekommen.');
    expect(e.proof_url).toContain(`/c/${SLUG}`);
    // The privacy box is mandatory, the news box is not: joining without it leaves the ledger empty.
    expect(await join({ name: 'Bernd Beispiel', email: 'club2@example.com', terms: '1' })).toBeLessThan(400);
    expect((await consentOf('club2@example.com')).events.filter((x: any) => x.purpose === 'community')).toEqual([]);
  });

  it('asks for the confirmation when double opt-in is on for communities', async () => {
    await t.api.put('/api/consent/settings', { doi: { sources: { community: true } } });
    expect(await join({ name: 'Clara Beispiel', email: 'club3@example.com', consent: '1', terms: '1' })).toBeLessThan(400);
    expect(t.app.db.get<any>('SELECT status FROM consent_doi WHERE contact_id = ?', contactByEmail('club3@example.com').id)).toMatchObject({ status: 'pending' });
    await t.api.put('/api/consent/settings', { doi: { sources: { community: false } } });
  });
});

describe('forms that collect an opt-in', () => {
  it('without a ticked consent field nothing is recorded – the submit button is no opt-in', async () => {
    const noField = (await t.api.post('/api/forms', { name: 'Ohne Feld', fields: [{ id: 'a', type: 'email', label: 'E-Mail', name: 'email', required: true }], settings: { consent: { marketing: true } } })).data;
    const r = await post(`/api/public/forms/${noField.id}/submit`, { email: 'nofield@example.com' });
    expect(r.status).toBe(200);
    await flush();
    expect((await consentOf('nofield@example.com')).events).toEqual([]);
    const withField = (await t.api.post('/api/forms', { name: 'Mit Feld', fields: [{ id: 'a', type: 'email', label: 'E-Mail', name: 'email', required: true }, { id: 'b', type: 'consent', label: 'Newsletter bitte.', name: 'news' }], settings: { consent: { marketing: true } } })).data;
    await post(`/api/public/forms/${withField.id}/submit`, { email: 'field@example.com', news: false });
    await post(`/api/public/forms/${withField.id}/submit`, { email: 'field2@example.com', news: 'ja' });
    await flush();
    expect((await consentOf('field@example.com')).events).toEqual([]);
    expect((await consentOf('field2@example.com')).events.map((e: any) => e.action)).toEqual(['granted']);
  });
});

describe('the inquiry acknowledgment of the "Neuer Lead" recipe', () => {
  it('is a service message: it reaches somebody without advertising consent even under the strict rule', async () => {
    await t.api.put('/api/consent/settings', { policy: 'confirmed' });
    const form = (await t.api.post('/api/forms', { name: 'Anfrage', fields: [{ id: 'a', type: 'email', label: 'E-Mail', name: 'email', required: true }] })).data;
    const wf = (await t.api.post('/api/workflows', { recipe: 'new_lead' })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    expect((await post(`/api/public/forms/${form.id}/submit`, { email: 'anfrage@example.com' })).status).toBe(200);
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    const mails = t.app.db.all<any>(`SELECT subject, status, purpose, consent_basis FROM messages WHERE contact_id = ? AND source = 'Workflow'`, contactByEmail('anfrage@example.com').id);
    expect(mails).toMatchObject([{ subject: expect.stringContaining('Danke für deine Anfrage'), purpose: 'transactional', consent_basis: 'exempt' }]);
    expect(mails[0].status).not.toBe('failed');
    await t.api.put('/api/consent/settings', { policy: 'legacy' });
  });
});
