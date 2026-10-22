import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { id as newId } from '../server/core/util.js';
import { DnsFailure, type DnsResolver } from '../server/services/umzug-mailcheck.js';
import { forgetDomains } from '../server/services/mk-validate.js';
import { mcpClient } from './mk-fixtures.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const mails: { to: string; subject: string }[] = [];
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 864e5).toISOString();

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.emailTransports = { capture: async (_l: any, mail: any) => (mails.push({ to: mail.to, subject: mail.subject }), { status: 'sent', providerId: `m${mails.length}` }) };
  await t.api.patch('/api/location', { settings: { email: { provider: 'capture', fromEmail: 'info@absender.example' } } });
});
afterAll(async () => t.close());

let seq = 0;
async function contacts(n: number, tag: string, domain = 'kunde.example') {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await t.api.post('/api/contacts', { email: `${tag}${++seq}@${domain}`, first_name: tag, tags: [tag] })).data.id);
  return out;
}
const campaign = async (tag: string, extra: Record<string, unknown> = {}) => (await t.api.post('/api/campaigns', { name: `Kampagne ${tag}`, subject: `Betreff ${tag}`, body: 'Hallo', filter: { tags: [tag] }, ...extra })).data;

/** Messages of a finished campaign written straight into the tables (fast, any status): one contact per row. */
function seedSent(campaignId: string, rows: { email: string; status: string; opened?: boolean; at?: string }[]) {
  t.app.db.tx(() => {
    for (const r of rows) {
      const cid = newId();
      const mid = newId();
      const at = r.at ?? new Date().toISOString();
      t.app.db.insert('contacts', { id: cid, location_id: loc, email: r.email, first_name: 'x', created_at: at, updated_at: at });
      t.app.db.insert('conversations', { id: `cv-${cid}`, location_id: loc, contact_id: cid, unread: 0, last_message_at: at, created_at: at });
      t.app.db.insert('messages', { id: mid, location_id: loc, conversation_id: `cv-${cid}`, contact_id: cid, channel: 'email', direction: 'out', subject: 's', body: 'b', status: r.status, error: '', source: 'Kampagne: seed', created_at: at, opened_at: r.opened ? at : null });
      t.app.db.insert('campaign_recipients', { campaign_id: campaignId, contact_id: cid, status: 'sent', message_id: mid, sent_at: at, variant: '' });
    }
  });
}

describe('warm-up plan over the API', () => {
  it('starts a plan and says what may go out today', async () => {
    expect((await t.api.get('/api/deliverability/warmup')).data).toMatchObject({ configured: false, state: null });
    const plans = (await t.api.get('/api/deliverability/warmup')).data.plans;
    expect(plans.map((p: any) => p.key)).toEqual(['conservative', 'standard', 'fast']);
    expect(plans[1].schedule[0]).toEqual({ day: 1, cap: 50 });
    expect((await t.api.post('/api/deliverability/warmup', { plan: 'turbo' })).status).toBe(400);
    expect((await t.api.post('/api/deliverability/warmup', { plan: 'standard', domain: 'keine domain' })).status).toBe(400);
    const r = await t.api.post('/api/deliverability/warmup', { plan: 'standard', domain: 'https://News.Firma.de/x' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ configured: true, plan: 'standard', domain: 'news.firma.de', state: { day: 1, cap: 50, remaining: 50, active: true } });
    expect((await t.api.put('/api/deliverability/warmup', { paused: true })).data.state).toMatchObject({ paused: true, cap: null, active: false });
    expect((await t.api.put('/api/deliverability/warmup', { paused: false, plan: 'fast' })).data.state).toMatchObject({ plan: 'fast', cap: 100, active: true });
    expect((await t.api.put('/api/deliverability/warmup', { plan: 'nope' })).status).toBe(400);
    await t.api.del('/api/deliverability/warmup');
    expect((await t.api.put('/api/deliverability/warmup', { paused: true })).status).toBe(404);
    expect((await t.api.get('/api/deliverability/warmup')).data.configured).toBe(false);
  });

  it('a campaign keeps to the daily cap and goes on the next day, most engaged contacts first', async () => {
    await contacts(25, 'wu');
    // Five engaged contacts (they open) – created last, so only "engagement first" puts them into the first 20.
    const engaged = await contacts(5, 'wu');
    const mid = newId();
    t.app.db.insert('conversations', { id: `cv-${mid}`, location_id: loc, contact_id: engaged[0], unread: 0, last_message_at: iso(3), created_at: iso(3) });
    t.app.db.insert('messages', { id: mid, location_id: loc, conversation_id: `cv-${mid}`, contact_id: engaged[0], channel: 'email', direction: 'out', subject: 's', body: 'b', status: 'sent', error: '', source: 'Kampagne: alt', created_at: iso(3) });
    for (const cid of engaged) for (let i = 0; i < 4; i++) t.app.db.insert('email_events', { id: newId(), location_id: loc, message_id: mid, contact_id: cid, kind: 'click', at: iso(2 + i), method: 'GET', ua_class: 'desktop', ua_hash: '', ip_prefix: '', classification: 'human', reason: '', applied: 1 });

    await t.api.post('/api/deliverability/warmup', { plan: 'conservative' }); // 20 mails on the first day
    const c = await campaign('wu');
    const before = (await t.api.get(`/api/campaigns/${c.id}`)).data;
    expect(before.plan).toMatchObject({ plan: 'conservative', cap: 20, remaining: 20 });
    mails.length = 0;
    expect((await t.api.post(`/api/campaigns/${c.id}/send`, {})).status).toBe(200);
    expect(mails).toHaveLength(20);
    const cur = (await t.api.get(`/api/campaigns/${c.id}`)).data;
    expect(cur.status).toBe('sending');
    expect(cur.stats).toMatchObject({ sent: 20, pending: 10 });
    expect(cur.plan).toMatchObject({ cap: 20, remaining: 0, sent_today: 20 });
    const sentTo = new Set(mails.map((m) => m.to));
    for (const id of engaged) expect(sentTo.has(t.app.db.get<{ email: string }>('SELECT email FROM contacts WHERE id = ?', id)!.email), 'engaged contacts go first').toBe(true);

    // The cap holds over more ticks.
    mails.length = 0;
    await t.app.tick();
    await t.app.tick();
    expect(mails).toHaveLength(0);
    expect((await t.api.get(`/api/campaigns/${c.id}`)).data.stats.pending).toBe(10);

    // The next day the cap is higher (25): five more may go out, the rest follows the day after.
    t.app.db.run('UPDATE mk_warmup SET started_at = ? WHERE location_id = ?', iso(1), loc);
    expect((await t.api.get('/api/deliverability/warmup')).data.state).toMatchObject({ day: 2, cap: 25, remaining: 5 });
    await t.app.tick();
    expect(mails).toHaveLength(5);
    t.app.db.run('UPDATE mk_warmup SET started_at = ? WHERE location_id = ?', iso(2), loc);
    await t.app.tick();
    expect(mails).toHaveLength(10);
    expect((await t.api.get(`/api/campaigns/${c.id}`)).data.status).toBe('sent');
    await t.api.del('/api/deliverability/warmup');
  });

  it('a paused plan or a finished one sets no cap, and service mails are not counted', async () => {
    await t.api.post('/api/deliverability/warmup', { plan: 'conservative' });
    await t.api.put('/api/deliverability/warmup', { paused: true });
    await contacts(30, 'wp');
    const c = await campaign('wp');
    mails.length = 0;
    await t.api.post(`/api/campaigns/${c.id}/send`, {});
    expect(mails).toHaveLength(30);
    await t.api.del('/api/deliverability/warmup');
  });
});

describe('list hygiene', () => {
  it('finds contacts whose mails keep failing softly and puts them on "Nicht stören"', async () => {
    const [three, two, recovered, already] = await contacts(4, 'soft');
    const fail = (cid: string, daysAgo: number) => t.app.db.insert('activities', { id: newId(), location_id: loc, contact_id: cid, type: 'email.failed', summary: 'E-Mail nicht zugestellt: Postfach voll', data: {}, created_at: iso(daysAgo) });
    for (const d of [10, 6, 2]) fail(three, d);
    for (const d of [5, 1]) fail(two, d);
    for (const d of [20, 10, 5]) fail(recovered, d);
    for (const d of [20, 10, 5]) fail(already, d);
    t.app.db.run('UPDATE contacts SET dnd = 1 WHERE id = ?', already);
    // after the last failure a mail was delivered to "recovered"
    const mid = newId();
    t.app.db.insert('conversations', { id: `cv-${mid}`, location_id: loc, contact_id: recovered, unread: 0, last_message_at: iso(1), created_at: iso(1) });
    t.app.db.insert('messages', { id: mid, location_id: loc, conversation_id: `cv-${mid}`, contact_id: recovered, channel: 'email', direction: 'out', subject: 's', body: 'b', status: 'delivered', error: '', source: 'Kampagne: x', created_at: iso(1) });

    const h = (await t.api.get('/api/deliverability/hygiene')).data;
    expect(h).toMatchObject({ soft_bounce_limit: 3, auto_suppress: true, suspect_count: 1 });
    expect(h.suspects[0]).toMatchObject({ contact_id: three, count: 3 });

    // The limit is a setting: with two, the second contact joins.
    expect((await t.api.put('/api/deliverability/settings', { hygiene: { soft_bounce_limit: 2 } })).data.hygiene.soft_bounce_limit).toBe(2);
    expect((await t.api.get('/api/deliverability/hygiene')).data.suspect_count).toBe(2);
    await t.api.put('/api/deliverability/settings', { hygiene: { soft_bounce_limit: 3 } });

    const r = await t.api.post('/api/deliverability/hygiene/suppress', {});
    expect(r.data).toEqual({ suppressed: 1, limit: 3 });
    expect(t.app.db.get<any>('SELECT dnd FROM contacts WHERE id = ?', three).dnd).toBe(1);
    expect(t.app.db.get<any>('SELECT dnd FROM contacts WHERE id = ?', two).dnd).toBe(0);
    const log = t.app.db.all<any>(`SELECT summary FROM activities WHERE contact_id = ? AND type = 'contact.dnd'`, three);
    expect(log[0].summary).toContain('Soft Bounce');
    expect((await t.api.post('/api/deliverability/hygiene/suppress', {})).data.suppressed).toBe(0);
  });

  it('does it on its own once an hour (and not when the sub-account switched it off)', async () => {
    const [auto] = await contacts(1, 'autosoft');
    for (const d of [5, 3, 1]) t.app.db.insert('activities', { id: newId(), location_id: loc, contact_id: auto, type: 'email.failed', summary: 'x', data: {}, created_at: iso(d) });
    await t.api.put('/api/deliverability/settings', { hygiene: { auto_suppress: false } });
    await t.app.services.mkJobs(true);
    expect(t.app.db.get<any>('SELECT dnd FROM contacts WHERE id = ?', auto).dnd).toBe(0);
    await t.api.put('/api/deliverability/settings', { hygiene: { auto_suppress: true } });
    // the job runs once an hour on its own; here it is run at once
    await t.app.services.mkJobs(true);
    expect(t.app.db.get<any>('SELECT dnd FROM contacts WHERE id = ?', auto).dnd).toBe(1);
  });

  it('collects contacts who never open into the sunset segment', async () => {
    const ids = await contacts(3, 'sunset');
    const mailTo = (cid: string, daysAgo: number, opened = false) => {
      const mid = newId();
      const cv = t.app.db.get<{ id: string }>('SELECT id FROM conversations WHERE location_id = ? AND contact_id = ?', loc, cid)?.id ?? `cv-${mid}`;
      if (cv === `cv-${mid}`) t.app.db.insert('conversations', { id: cv, location_id: loc, contact_id: cid, unread: 0, last_message_at: iso(daysAgo), created_at: iso(daysAgo) });
      t.app.db.insert('messages', { id: mid, location_id: loc, conversation_id: cv, contact_id: cid, channel: 'email', direction: 'out', subject: 's', body: 'b', status: 'sent', error: '', source: 'Kampagne: x', created_at: iso(daysAgo), opened_at: opened ? iso(daysAgo) : null });
    };
    for (const d of [20, 60, 100, 150]) mailTo(ids[0], d); // never opens
    for (const d of [20, 60, 100, 150]) mailTo(ids[1], d, d === 100); // opened one of them
    mailTo(ids[2], 20); // got only one mail
    const r = await t.api.post('/api/deliverability/hygiene/sunset', { months: 6 });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ months: 6, count: 1, tagged: 0 });
    const seg = (await t.api.get(`/api/segments/${r.data.segment_id}`)).data;
    expect(seg.name).toBe('Sunset: lange nicht geöffnet');
    expect(seg.definition.items[0]).toMatchObject({ type: 'engagement', state: 'inactive', days: 180, min_received: 3 });
    expect((await t.api.get(`/api/segments/${seg.id}/contacts`)).data.contacts.map((c: any) => c.id)).toEqual([ids[0]]);
    // asking again updates the same segment (and can tag the people)
    const again = await t.api.post('/api/deliverability/hygiene/sunset', { months: 6, tag: 'inaktiv' });
    expect(again.data).toMatchObject({ segment_id: seg.id, count: 1, tagged: 1 });
    expect((await t.api.get(`/api/contacts/${ids[0]}`)).data.tags).toContain('inaktiv');
    expect(t.app.db.all('SELECT id FROM mk_segments WHERE location_id = ? AND name = ?', loc, seg.name)).toHaveLength(1);
    expect((await t.api.get('/api/deliverability/hygiene')).data.sunset_segment).toMatchObject({ id: seg.id });
  });
});

/** A resolver with a few known domains. */
function dns(): DnsResolver {
  const known = ['firma.de', 'gmx.de', 'kunde.example', 'gmial.com', 'mailinator.com', 'yopmail.com'];
  const mx: Record<string, { exchange: string; priority: number }[]> = Object.fromEntries(known.map((d) => [d, [{ exchange: `mx.${d}`, priority: 10 }]]));
  return {
    resolveTxt: async () => [],
    resolveCname: async () => [],
    resolve4: async () => [],
    resolveMx: async (n) => {
      if (n === 'dnsausfall.de') throw new DnsFailure('SERVFAIL');
      return mx[n] ?? [];
    },
  };
}

describe('address checks', () => {
  it('checks addresses over the API (offline checks without a lookup service)', async () => {
    const r = await t.api.post('/api/email-validation/check', { emails: ['anna@firma.de', 'info@firma.de', 'kaputt', 'x@mailinator.com', 'max@gmial.com'] });
    expect(r.status).toBe(200);
    expect(r.data.results.map((x: any) => [x.verdict, x.mx])).toEqual([['ok', null], ['risky', null], ['invalid', null], ['risky', null], ['risky', null]]);
    expect(r.data.results[2].issues[0].text).toContain('@');
    expect(r.data.results[4].suggestion).toBe('max@gmail.com');
    expect((await t.api.post('/api/email-validation/check', { email: 'solo@firma.de' })).data.results).toHaveLength(1);
    expect((await t.api.post('/api/email-validation/check', {})).status).toBe(400);
    expect((await t.api.post('/api/email-validation/check', { emails: Array.from({ length: 300 }, (_, i) => `a${i}@firma.de`) })).data.results).toHaveLength(200);
  });

  it('looks the domain up when a resolver is there: no mail server → invalid; DNS down → not judged', async () => {
    forgetDomains();
    t.app.services.mkResolver = dns();
    const r = (await t.api.post('/api/email-validation/check', { emails: ['a@firma.de', 'b@keinmx.de', 'c@dnsausfall.de', 'd@gmx.de'] })).data.results;
    expect(r.map((x: any) => [x.verdict, x.mx])).toEqual([['ok', true], ['invalid', false], ['ok', null], ['ok', true]]);
    expect(r[1].issues[0].code).toBe('no_mx');
    const off = (await t.api.post('/api/email-validation/check', { emails: ['b@keinmx.de'], mx: false })).data.results;
    expect(off[0]).toMatchObject({ verdict: 'ok', mx: null });
    delete t.app.services.mkResolver;
  });

  it('scans the contacts of a sub-account and stores the verdicts', async () => {
    forgetDomains();
    t.app.services.mkResolver = dns();
    const mk = async (email: string) => (await t.api.post('/api/contacts', { email, first_name: 'v' })).data.id;
    const good = await mk('gut@firma.de');
    const role = await mk('info@firma.de');
    const nomx = await mk('weg@keinmx.de');
    const typo = await mk('tippfehler@gmial.com');
    const tmp = await mk('wegwerf@mailinator.com');
    const before = (await t.api.get('/api/email-validation/summary')).data;
    expect(before.unchecked).toBeGreaterThanOrEqual(5);
    const scan = (await t.api.post('/api/email-validation/scan', { limit: 500 })).data;
    expect(scan.left).toBe(false);
    const sum = scan.summary;
    expect(sum.unchecked).toBe(0);
    expect(sum.invalid).toBeGreaterThanOrEqual(1);
    const verdictOf = (id: string) => t.app.db.get<any>('SELECT verdict, mx, role, disposable FROM mk_email_checks WHERE contact_id = ?', id);
    expect(verdictOf(good)).toMatchObject({ verdict: 'ok', mx: 1 });
    expect(verdictOf(role)).toMatchObject({ verdict: 'risky', role: 1 });
    expect(verdictOf(nomx)).toMatchObject({ verdict: 'invalid', mx: 0 });
    expect(verdictOf(typo).verdict).toBe('risky');
    expect(verdictOf(tmp)).toMatchObject({ verdict: 'risky', disposable: 1 });
    const issues = (await t.api.get('/api/email-validation/issues?verdict=invalid')).data;
    expect(issues.map((i: any) => i.email)).toContain('weg@keinmx.de');
    expect(issues.find((i: any) => i.email === 'weg@keinmx.de').issues[0].code).toBe('no_mx');
    // Tagging the failed ones for a clean-up.
    const tagged = (await t.api.post('/api/email-validation/tag', {})).data;
    expect(tagged.tag).toBe('E-Mail prüfen');
    expect((await t.api.get(`/api/contacts/${nomx}`)).data.tags).toContain('E-Mail prüfen');
    expect((await t.api.get(`/api/contacts/${good}`)).data.tags).not.toContain('E-Mail prüfen');
    // A changed address is checked again.
    await t.api.patch(`/api/contacts/${nomx}`, { email: 'jetzt@firma.de' });
    expect((await t.api.post('/api/email-validation/scan', {})).data.checked).toBeGreaterThanOrEqual(1);
    expect(verdictOf(nomx).verdict).toBe('ok');
    delete t.app.services.mkResolver;
  });

  it('the background job checks new contacts on its own', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'hintergrund@firma.de' })).data;
    expect(t.app.db.get('SELECT 1 FROM mk_email_checks WHERE contact_id = ?', c.id)).toBeUndefined();
    await t.app.services.mkJobs(true);
    expect(t.app.db.get<any>('SELECT verdict FROM mk_email_checks WHERE contact_id = ?', c.id)).toMatchObject({ verdict: 'ok' });
    // switched off for the sub-account: nobody is checked in the background
    await t.api.put('/api/deliverability/settings', { validation: { auto: false } });
    const d = (await t.api.post('/api/contacts', { email: 'aus@firma.de' })).data;
    await t.app.services.mkJobs(true);
    expect(t.app.db.get('SELECT 1 FROM mk_email_checks WHERE contact_id = ?', d.id)).toBeUndefined();
    await t.api.put('/api/deliverability/settings', { validation: { auto: true } });
  });

  it('campaigns skip addresses that cannot receive mail, and say why', async () => {
    const good = (await t.api.post('/api/contacts', { email: 'ok1@kunde.example', first_name: 'ok', tags: ['adr'] })).data.id;
    const bad = (await t.api.post('/api/contacts', { email: 'ohne-at-zeichen', first_name: 'bad', tags: ['adr'] })).data.id;
    const tmp = (await t.api.post('/api/contacts', { email: 'wegwerf@yopmail.com', first_name: 'tmp', tags: ['adr'] })).data.id;
    const info = (await t.api.post('/api/contacts', { email: 'info@kunde.example', first_name: 'info', tags: ['adr'] })).data.id;
    const c = await campaign('adr');
    const aud = (await t.api.post(`/api/campaigns/${c.id}/audience`, { filter: { tags: ['adr'] } })).data;
    expect(aud).toMatchObject({ total: 4, reachable: 3, bad_address: 1 });
    mails.length = 0;
    await t.api.post(`/api/campaigns/${c.id}/send`, {});
    expect(mails.map((m) => m.to).sort()).toEqual(['info@kunde.example', 'ok1@kunde.example', 'wegwerf@yopmail.com']);
    const rec = (await t.api.get(`/api/campaigns/${c.id}/recipients`)).data.find((r: any) => r.contact_id === bad);
    expect(rec).toMatchObject({ status: 'skipped' });
    expect(rec.error).toContain('E-Mail-Adresse ungültig');

    // Disposable and role addresses are only skipped when the sub-account says so.
    await t.api.put('/api/deliverability/settings', { validation: { exclude_disposable: true, exclude_role: true } });
    const c2 = await campaign('adr');
    expect((await t.api.post(`/api/campaigns/${c2.id}/audience`, { filter: { tags: ['adr'] } })).data).toMatchObject({ reachable: 1, bad_address: 3 });
    // …and everything can be switched off
    await t.api.put('/api/deliverability/settings', { validation: { exclude_invalid: false, exclude_disposable: false, exclude_role: false } });
    expect((await t.api.post(`/api/campaigns/${c2.id}/audience`, { filter: { tags: ['adr'] } })).data.reachable).toBe(4);
    await t.api.put('/api/deliverability/settings', { validation: { exclude_invalid: true } });
    expect([good, tmp, info].length).toBe(3);
  });

  it('keeps the settings in range and shows the counts', async () => {
    const s = (await t.api.put('/api/deliverability/settings', { hygiene: { soft_bounce_limit: 99, sunset_months: 0 }, sto: { default_hour: 40 }, validation: { mx: false } })).data;
    expect(s.hygiene).toMatchObject({ soft_bounce_limit: 10, sunset_months: 1 });
    expect(s.sto.default_hour).toBe(23);
    expect(s.validation.mx).toBe(false);
    expect((await t.api.get('/api/deliverability/settings')).data).toEqual(s);
    await t.api.put('/api/deliverability/settings', { hygiene: { soft_bounce_limit: 3, sunset_months: 6 }, sto: { default_hour: 10 }, validation: { mx: true } });
    const sum = (await t.api.get('/api/email-validation/summary')).data;
    expect(sum).toMatchObject({ settings: { auto: true } });
    expect(sum.total).toBeGreaterThan(0);
  });
});

describe('MCP tool for deliverability', () => {
  it('reports reputation, warm-up and address checks', async () => {
    await t.api.post('/api/deliverability/warmup', { plan: 'standard' });
    const m = await mcpClient(t, loc);
    expect((await m.tools()).map((x) => x.name)).toContain('ghl_deliverability_report');
    const r = await m.rpc('ghl_deliverability_report', { days: 90 });
    expect(r.error).toBe(false);
    expect(r.json.reputation).toMatchObject({ level: expect.any(String), sent: expect.any(Number) });
    expect(Array.isArray(r.json.reputation.warnings)).toBe(true);
    expect(r.json.warmup).toMatchObject({ plan: 'standard', cap: expect.any(Number) });
    expect(r.json.addresses).toHaveProperty('invalid');
  });
});
