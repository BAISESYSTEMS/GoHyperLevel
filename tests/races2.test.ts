import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';

/**
 * More concurrency, idempotency and retry regressions (continues tests/races.test.ts): the same thing twice or at the same
 * time – a double click, a status flipped back and forth while a mail is on its way, a crash in the middle of a send, a webhook
 * whose processing failed, a server that was off for a day. Each block names the rule it guards.
 */

vi.setConfig({ hookTimeout: 60_000 });

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A test e-mail transport: records every mail it was handed (`started`) and accepted (`outbox`), each one takes `delayMs`. */
const outbox: { to: string; subject: string }[] = [];
const started: string[] = [];
let delayMs = 0;
const sentTo = (to: string, subject?: RegExp) => outbox.filter((m) => m.to === to && (!subject || subject.test(m.subject))).length;

const SELLER = { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', tax_number: '37/123/45678', contact_name: 'Erika Muster', contact_phone: '+49 30 1234567', contact_email: 'rechnung@muster.example', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', bank: 'DKB' };

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.emailTransports = {
    ...(t.app.services.emailTransports ?? {}),
    racetest: async (_loc: unknown, mail: { to: string; subject: string }) => {
      started.push(mail.to);
      if (delayMs) await sleep(delayMs);
      outbox.push({ to: mail.to, subject: mail.subject });
      return { status: 'sent' };
    },
  };
  t.app.db.run(`UPDATE locations SET settings = json_set(settings, '$.email', json(?)) WHERE id = ?`, JSON.stringify({ provider: 'racetest', fromEmail: 'team@firma.example' }), loc);
  expect((await t.api.put('/api/invoice-settings', SELLER)).status).toBe(200);
});
afterAll(async () => {
  await t.close();
});

const contact = async (email: string, extra: Record<string, unknown> = {}) => (await t.api.post('/api/contacts', { email, first_name: 'Rita', last_name: 'Rennen', address: 'Hauptstraße 7', postal_code: '80331', city: 'München', ...extra })).data;

/** Two requests at the same moment while the mail transport takes a while; returns their status codes, sorted. */
const twice = async (send: () => Promise<{ status: number }>) => {
  delayMs = 60;
  try {
    return (await Promise.all([send(), send()])).map((r) => r.status).sort();
  } finally {
    delayMs = 0;
  }
};

// --- invoices and quotes -----------------------------------------------------------------------------------------------------------

describe('"Senden" on an invoice or a quote mails the customer once', () => {
  it('a double click on "Senden" of an invoice: one mail, the second click is told it is on its way; a resend later works', async () => {
    const email = 'rechnung-doppelt@kunde.example';
    const c = await contact(email);
    const inv = (await t.api.post('/api/invoices', { contact_id: c.id, title: 'Beratung', items: [{ name: 'Beratung', qty: 1, price_cents: 10000, tax_rate: 19 }] })).data;
    expect(await twice(() => t.api.post(`/api/invoices/${inv.id}/send`, {}))).toEqual([200, 409]);
    expect(sentTo(email)).toBe(1);
    // a deliberate resend (the customer lost the mail) still goes out
    expect((await t.api.post(`/api/invoices/${inv.id}/send`, {})).status).toBe(200);
    expect(sentTo(email)).toBe(2);
  });

  it('the same for an estimate (Angebot on the invoicing page)', async () => {
    const email = 'angebot-doppelt@kunde.example';
    const c = await contact(email);
    const est = (await t.api.post('/api/invoices', { kind: 'estimate', contact_id: c.id, title: 'Umbau', items: [{ name: 'Umbau', qty: 1, price_cents: 50000, tax_rate: 19 }] })).data;
    expect(await twice(() => t.api.post(`/api/invoices/${est.id}/send`, {}))).toEqual([200, 409]);
    expect(sentTo(email)).toBe(1);
  });

  it('the same for a quote of a deal (Angebote in Vertrieb)', async () => {
    const email = 'deal-angebot@kunde.example';
    const c = await contact(email);
    const pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: ['Neu', 'Angebot', 'Gewonnen'] })).data;
    const deal = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: c.id, name: 'Website', value: 0 })).data;
    const q = (await t.api.post('/api/quotes', { deal_id: deal.id, title: 'Website', items: [{ name: 'Website', qty: 1, price_cents: 300000, tax_rate: 19 }] })).data;
    expect(await twice(() => t.api.post(`/api/quotes/${q.id}/send`, {}))).toEqual([200, 409]);
    expect(sentTo(email)).toBe(1);
    expect((await t.api.post(`/api/quotes/${q.id}/send`, {})).status).toBe(200);
    expect(sentTo(email)).toBe(2);
  });
});

// --- helpdesk ------------------------------------------------------------------------------------------------------------------------

describe('a satisfaction survey (CSAT) goes out once per solved ticket', () => {
  it('solved, reopened and solved again while the first survey is on its way: one survey', async () => {
    const email = 'csat-race@kunde.example';
    const c = await contact(email);
    const tk = (await t.api.post('/api/tickets', { subject: 'Drucker druckt nicht', contact_id: c.id })).data;
    delayMs = 120;
    try {
      expect((await t.api.patch(`/api/tickets/${tk.id}`, { status: 'resolved' })).status).toBe(200);
      // the survey is being mailed – meanwhile the customer writes back (reopened) and the agent solves it again
      await vi.waitFor(() => expect(started.filter((x) => x === email)).toHaveLength(1), { interval: 5 });
      expect((await t.api.patch(`/api/tickets/${tk.id}`, { status: 'open' })).status).toBe(200);
      expect((await t.api.patch(`/api/tickets/${tk.id}`, { status: 'resolved' })).status).toBe(200);
      await t.app.events.flush();
      await t.app.tick();
      await sleep(150);
    } finally {
      delayMs = 0;
    }
    expect(sentTo(email, /zufrieden/i)).toBe(1);
    expect(t.app.db.get<any>('SELECT csat_sent_at FROM tickets WHERE id = ?', tk.id)!.csat_sent_at).toBeTruthy();
  });

  it('"Umfrage senden" clicked twice: one survey, the second click is told it is on its way', async () => {
    const email = 'csat-klick@kunde.example';
    const c = await contact(email);
    const tk = (await t.api.post('/api/tickets', { subject: 'Frage', contact_id: c.id })).data;
    expect(await twice(() => t.api.post(`/api/surveys/csat/${tk.id}/send`))).toEqual([200, 409]);
    expect(sentTo(email, /zufrieden/i)).toBe(1);
  });
});

// --- community: invites and discount codes with a limit --------------------------------------------------------------------------

describe('a community invite or discount code with a limit is not used more often than allowed', () => {
  let stripe: any;
  let product: any;
  let tier: any;
  let group: any;
  const SLUG = 'race-club';
  beforeAll(async () => {
    const { setStripeFetch } = await import('../server/services/stripe.js');
    const { KEY, WHSEC, fakeStripe } = await import('./creator-fakes.js');
    stripe = fakeStripe();
    // Stripe takes a moment to make a Checkout page: long enough for a second buyer to arrive meanwhile
    setStripeFetch((async (url: string, init: any) => {
      if (String(url).endsWith('/v1/checkout/sessions') && init.method === 'POST') await sleep(60);
      return stripe.handler(url, init);
    }) as any);
    expect((await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC })).status).toBe(200);
    t.app.services.communityLimits = { join: 10_000 };
    t.app.services.communityMailer = async () => ({ status: 'sent' });
    product = (await t.api.post('/api/products', { name: 'Club lebenslang', price_cents: 10000, tax_rate: 0 })).data;
    group = (await t.api.post('/api/community/groups', { name: 'Race Club', access: { mode: 'join' } })).data;
    expect((await t.api.put(`/api/community/groups/${group.id}/join/page`, { slug: SLUG, enabled: true })).status).toBe(200);
    tier = (await t.api.post(`/api/community/groups/${group.id}/tiers`, { name: 'Lifetime', product_id: product.id })).data;
  });
  afterAll(async () => (await import('../server/services/stripe.js')).setStripeFetch());

  const form = (body: Record<string, string>) => ({ method: 'POST', redirect: 'manual' as const, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  /** The public join form like a browser sends it; on success the answer points at the checkout (the buy page with the membership). */
  const join = async (email: string, extra: Record<string, string>) => {
    const page = await (await t.api.raw(`/c/${SLUG}/join`)).text();
    const r = await t.api.raw(`/c/${SLUG}/join`, form({ _t: page.match(/name="_t" value="([^"]+)"/)![1], name: 'Rita Rennen', email, tier: tier.id, ...extra }));
    return { status: r.status, location: r.headers.get('location') ?? '', html: await r.text() };
  };
  /** "Jetzt kaufen" on the buy page the join led to. */
  const checkout = (joined: { location: string }) => {
    const cm = new URL(joined.location).searchParams.get('cm')!;
    return t.api.raw(`/buy/${product.id}`, form({ _cm: cm }));
  };
  const sessionOf = (email: string) => [...stripe.sessions.values()].find((s: any) => s.metadata.community_membership === t.app.db.get<any>(`SELECT m.id FROM community_memberships m JOIN contacts c ON c.id = m.contact_id WHERE c.email = ?`, email)?.id);

  it('a discount code for one: two buyers at once get it once, a third is told it is taken, an abandoned page frees it', async () => {
    const { sendEvent } = await import('./creator-fakes.js');
    expect((await t.api.post(`/api/community/groups/${group.id}/coupons`, { code: 'LAUNCH50', percent_off: 50, duration: 'once', max_uses: 1 })).status).toBe(200);
    const a = await join('code-a@kunde.example', { coupon: 'LAUNCH50' });
    const b = await join('code-b@kunde.example', { coupon: 'LAUNCH50' });
    expect([a.status, b.status]).toEqual([303, 303]);
    // both press "Jetzt kaufen" at the same moment: one Checkout page with the discount, the other is told it is used up
    const [ra, rb] = await Promise.all([checkout(a), checkout(b)]);
    expect([ra.status, rb.status].sort()).toEqual([303, 400]);
    const withCode = () => [...stripe.sessions.values()].filter((s: any) => s.metadata.community_coupon === 'LAUNCH50');
    expect(withCode()).toHaveLength(1);
    const loser = ra.status === 303 ? b : a;
    expect(await (ra.status === 303 ? rb : ra).text()).toContain('aufgebraucht');
    // while the first buyer is on Stripe's page the code is taken for newcomers too
    const c = await join('code-c@kunde.example', { coupon: 'LAUNCH50' });
    expect(c.status).toBe(400);
    expect(c.html).toContain('aufgebraucht');
    // that page expires after 31 minutes; the first buyer gives up: the code is free again
    const made = [...stripe.calls].find((x: any) => x.path === '/v1/checkout/sessions' && x.params.get('metadata[community_coupon]') === 'LAUNCH50')!;
    expect(Number(made.params.get('expires_at'))).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 60);
    const [held] = withCode();
    expect((await sendEvent(t, 'checkout.session.expired', { ...held, status: 'expired' })).status).toBe(200);
    expect((await checkout(loser)).status).toBe(303);
  });

  it('an invite for one: the second person is told it is taken while the first pays; after the payment it is used up', async () => {
    const { sendEvent } = await import('./creator-fakes.js');
    const inv = (await t.api.post(`/api/community/groups/${group.id}/invites`, { label: 'Erster Platz', skip_approval: true, max_uses: 1 })).data;
    const a = await join('invite-a@kunde.example', { invite: inv.code });
    const b = await join('invite-b@kunde.example', { invite: inv.code });
    expect([a.status, b.status]).toEqual([303, 303]);
    const [ra, rb] = await Promise.all([checkout(a), checkout(b)]);
    expect([ra.status, rb.status].sort()).toEqual([303, 400]);
    const [first, second] = ra.status === 303 ? [a, b] : [b, a];
    expect(await (ra.status === 303 ? rb : ra).text()).toContain('Einladungslink');
    // a newcomer with the same invite is told so at once
    const c = await join('invite-c@kunde.example', { invite: inv.code });
    expect(c.status).toBe(400);
    expect(c.html).toContain('gerade vergeben');
    // the first one pays: the invite is used up for good
    const firstEmail = first === a ? 'invite-a@kunde.example' : 'invite-b@kunde.example';
    const s = sessionOf(firstEmail);
    expect((await sendEvent(t, 'checkout.session.completed', { ...s, status: 'complete', payment_status: 'paid', customer_details: { email: firstEmail } })).status).toBe(200);
    expect(t.app.db.get<any>('SELECT uses FROM community_invites WHERE id = ?', inv.id)!.uses).toBe(1);
    expect((await checkout(second)).status).toBe(400);
    expect((await join('invite-d@kunde.example', { invite: inv.code })).status).toBe(400);
    expect(t.app.db.get<any>('SELECT uses FROM community_invites WHERE id = ?', inv.id)!.uses).toBe(1);
  });
});

// --- date triggers after a server outage ---------------------------------------------------------------------------------------------

describe('birthday and date workflows catch up on days the server was off (up to 3 days back, once per contact, date and year)', () => {
  const runs = (wfId: string) => t.app.db.all<any>('SELECT contact_id, event FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at', wfId).map((r) => ({ contact: r.contact_id, late: JSON.parse(r.event).late_days }));
  const flow = async (trigger: { type: string; config: Record<string, unknown> }) => {
    const wf = (await t.api.post('/api/workflows', { name: `Datum ${Math.random()}`, trigger, steps: [{ type: 'set_variable', rows: [{ name: 'x', value: '1' }] }] })).data;
    expect((await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' })).status).toBe(200);
    return wf;
  };
  afterAll(() => {
    delete t.app.services.wfxNow;
  });

  it('Geburtstag (contact.birthday): a missed day is sent late; older days, a new or a paused workflow are not', async () => {
    const scan = async (iso: string) => {
      t.app.services.wfxNow = () => Date.parse(iso);
      await t.app.services.wfxRunScans();
    };
    const c2 = await contact('geb-2nov@kunde.example', { date_of_birth: '1990-11-02' });
    const c5 = await contact('geb-5nov@kunde.example', { date_of_birth: '1985-11-05' });
    const c8 = await contact('geb-8nov@kunde.example', { date_of_birth: '1979-11-08' });
    const c9 = await contact('geb-9nov@kunde.example', { date_of_birth: '09.11.2001' });
    const c13 = await contact('geb-13nov@kunde.example', { date_of_birth: '1995-11-13' });
    const wf = await flow({ type: 'contact.birthday', config: { time: '09:00' } });
    await scan('2026-10-31T10:00:00Z');
    expect(runs(wf.id)).toEqual([]);
    // the server is off on 1 and 2 November: the birthday of the 2nd goes out on the 3rd, one day late – and only once
    await scan('2026-11-03T10:00:00Z');
    await scan('2026-11-03T10:05:00Z');
    expect(runs(wf.id)).toEqual([{ contact: c2.id, late: 1 }]);
    // off for six days: the last three are caught up (8th and 9th), the 5th is too long ago
    await scan('2026-11-10T10:00:00Z');
    expect(runs(wf.id).map((r) => [r.contact, r.late]).sort()).toEqual([[c2.id, 1], [c8.id, 2], [c9.id, 1]].sort());
    expect(runs(wf.id).some((r) => r.contact === c5.id)).toBe(false);
    // a workflow switched on today does not send what fell due before
    const fresh = await flow({ type: 'contact.birthday', config: { time: '09:00' } });
    await scan('2026-11-10T10:30:00Z');
    expect(runs(fresh.id)).toEqual([]);
    // a workflow paused over the 13th and switched on again on the 14th does not send it afterwards
    t.app.db.run('UPDATE workflows SET updated_at = ? WHERE id = ?', '2026-11-14T12:00:00.000Z', wf.id);
    await scan('2026-11-14T13:00:00Z');
    expect(runs(wf.id).some((r) => r.contact === c13.id)).toBe(false);
  });

  it('Datum erreicht (date.reached): the same rule', async () => {
    const { runDateTriggers } = await import('../server/modules/date-triggers.js');
    const c = await contact('datum-2dez@kunde.example', { date_of_birth: '1988-12-02' });
    const wf = await flow({ type: 'date.reached', config: { field: 'date_of_birth', time: '09:00', yearly: true } });
    await runDateTriggers(t.app, new Date('2026-11-30T10:00:00Z'));
    expect(runs(wf.id)).toEqual([]);
    // off on 1 and 2 December
    expect(await runDateTriggers(t.app, new Date('2026-12-03T10:00:00Z'))).toBe(1);
    expect(await runDateTriggers(t.app, new Date('2026-12-03T10:10:00Z'))).toBe(0);
    expect(runs(wf.id)).toEqual([{ contact: c.id, late: 1 }]);
    // next year it comes on the day again
    await runDateTriggers(t.app, new Date('2027-12-02T08:30:00Z'));
    expect(runs(wf.id)).toEqual([{ contact: c.id, late: 1 }, { contact: c.id, late: undefined }]);
  });
});

// --- e-mail provider webhooks ----------------------------------------------------------------------------------------------------------

describe('a mail provider notification whose processing failed is processed when it comes again', () => {
  it('Amazon SES (SNS): a delivery report that failed (database busy) is taken on the retry, a real duplicate is still skipped', async () => {
    const { createSign, generateKeyPairSync } = await import('node:crypto');
    const { snsStringToSign } = await import('../server/services/email-providers.js');
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const CERT = 'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-race.pem';
    const before = t.app.services.channelFetch;
    t.app.services.channelFetch = (async (url: string) => (String(url) === CERT ? new Response(publicKey.export({ type: 'spki', format: 'pem' }) as string) : new Response('{}', { status: 404 }))) as any;
    try {
      const topic = 'arn:aws:sns:eu-central-1:123456789012:ses-race';
      expect((await t.api.put('/api/settings/channels/mail/ses', { access_key_id: 'AKIAIOSFODNN7EXAMPLE', secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'eu-central-1', topic_arn: topic })).status).toBe(200);
      const url = new URL((await t.api.get('/api/settings/channels/mail')).data.providers.ses.webhook_url).pathname;
      const c = await contact('ses-race@kunde.example');
      const m = (await t.api.post('/api/messages', { contact_id: c.id, channel: 'email', subject: 'Hallo', body: 'Hallo' })).data;
      t.app.db.run('UPDATE messages SET provider_id = ? WHERE id = ?', 'ses-race-1', m.id);
      const note: Record<string, any> = { Type: 'Notification', MessageId: 'sns-race-1', TopicArn: topic, Timestamp: new Date().toISOString(), SignatureVersion: '2', SigningCertURL: CERT, Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'ses-race-1' } }) };
      note.Signature = createSign('RSA-SHA256').update(snsStringToSign(note)).sign(privateKey, 'base64');
      const post = () => t.api.raw(url, { method: 'POST', headers: { 'content-type': 'text/plain; charset=UTF-8' }, body: JSON.stringify(note) });
      // the database is busy for a moment: processing fails, SNS will deliver the same notification again
      t.app.db.run(`CREATE TEMP TRIGGER ses_race_busy BEFORE UPDATE OF status ON messages WHEN NEW.provider_id = 'ses-race-1' BEGIN SELECT RAISE(ABORT, 'database is locked'); END`);
      try {
        expect((await post()).status).toBeGreaterThanOrEqual(400);
      } finally {
        t.app.db.run('DROP TRIGGER IF EXISTS ses_race_busy');
      }
      expect(t.app.db.get<any>('SELECT status FROM messages WHERE id = ?', m.id)!.status).toBe('sent');
      // the retry
      const retry = await post();
      expect(retry.status).toBe(200);
      expect(await retry.json()).not.toMatchObject({ duplicate: true });
      expect(t.app.db.get<any>('SELECT status FROM messages WHERE id = ?', m.id)!.status).toBe('delivered');
      // a third delivery of the same notification is a real duplicate
      expect(await (await post()).json()).toMatchObject({ duplicate: true });
    } finally {
      t.app.services.channelFetch = before;
    }
  });
});

// --- planned mails from a connected mailbox ---------------------------------------------------------------------------------------------

describe('a planned mail left "sending" by a crash does not stay there forever', () => {
  let m: Awaited<ReturnType<typeof import('./mailbox-helpers.js').boot>>;
  let mb = '';
  beforeAll(async () => {
    const { boot, connect, settle } = await import('./mailbox-helpers.js');
    m = await boot();
    mb = (await connect(m.t, m.fake, { provider: 'google', scope: 'location', access: 'full', name: 'Info' })).id;
    await settle(m.t, mb);
  });
  afterAll(async () => m?.t.close());

  const plan = async (subject: string) => {
    const r = await m.t.api.post('/api/mail/send', { mailbox_id: mb, to: 'geplant@kunde.example', subject, body: 'Hallo', send_at: new Date(Date.now() + 3600_000).toISOString() });
    expect(r.data.status, JSON.stringify(r.data)).toBe('scheduled');
    return r.data.scheduled_id as string;
  };
  const sent = (subject: string) => m.fake.g.sentRaw.filter((x) => x.parsed.subject === subject).length;
  const row = (id: string) => m.t.app.db.get<any>('SELECT status, error FROM mailbox_scheduled WHERE id = ?', id)!;

  it('after half an hour it is marked failed with a note to look in "Gesendet" – never sent again; a fresh claim is left alone', async () => {
    const stuck = await plan('Hängt fest');
    const old = await plan('Hängt seit dem Update');
    const busy = await plan('Gerade unterwegs');
    // the process died while Gmail had the mail (claimed 40 minutes ago); a row from before claims had a time (only send_at);
    // and one that a send is working on right now
    m.t.app.db.run(`UPDATE mailbox_scheduled SET status = 'sending', send_at = ?, sent_at = ? WHERE id = ?`, new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() - 40 * 60_000).toISOString(), stuck);
    m.t.app.db.run(`UPDATE mailbox_scheduled SET status = 'sending', send_at = ?, sent_at = NULL WHERE id = ?`, new Date(Date.now() - 2 * 3600_000).toISOString(), old);
    m.t.app.db.run(`UPDATE mailbox_scheduled SET status = 'sending', send_at = ?, sent_at = ? WHERE id = ?`, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 30_000).toISOString(), busy);
    await m.t.app.tick();
    for (const id of [stuck, old]) {
      expect(row(id).status).toBe('failed');
      expect(row(id).error).toMatch(/Gesendet/);
    }
    expect(row(busy).status).toBe('sending');
    expect(sent('Hängt fest') + sent('Hängt seit dem Update') + sent('Gerade unterwegs')).toBe(0);
    // shown in the list with its note, and it can be dismissed
    const list = (await m.t.api.get('/api/mail/scheduled')).data;
    expect(list.find((x: any) => x.id === stuck)).toMatchObject({ status: 'failed' });
    expect((await m.t.api.del(`/api/mail/scheduled/${stuck}`)).status).toBe(200);
  });
});

// --- NPS surveys --------------------------------------------------------------------------------------------------------------------

describe('an NPS survey reaches every recipient once', () => {
  it('two sending runs at the same time (the scheduler and a direct call) do not ask anybody twice', async () => {
    const emails = ['nps1@umfrage.example', 'nps2@umfrage.example', 'nps3@umfrage.example'];
    for (const e of emails) await contact(e, { tags: ['nps-race'] });
    const c = (await t.api.post('/api/surveys/nps', { name: 'NPS Race', tags: ['nps-race'] })).data;
    expect((await t.api.post(`/api/surveys/nps/${c.id}/send`)).data).toMatchObject({ queued: 3 });
    delayMs = 40;
    try {
      await Promise.all([t.app.services.npsTick(), t.app.services.npsTick()]);
    } finally {
      delayMs = 0;
    }
    for (const e of emails) expect(sentTo(e, /weiterempfehlen/)).toBe(1);
    expect(t.app.db.all<any>('SELECT status FROM nps_sends WHERE campaign_id = ?', c.id).map((r) => r.status)).toEqual(['sent', 'sent', 'sent']);
    expect(t.app.db.get<any>('SELECT status FROM nps_campaigns WHERE id = ?', c.id)!.status).toBe('sent');
  });

  it('a survey that was on its way when the server stopped is not sent again', async () => {
    const e = 'nps-neustart@umfrage.example';
    await contact(e, { tags: ['nps-neustart'] });
    const c = (await t.api.post('/api/surveys/nps', { name: 'NPS Neustart', tags: ['nps-neustart'] })).data;
    await t.api.post(`/api/surveys/nps/${c.id}/send`);
    // the run claimed the recipient and the process died before the answer of the mail server was written down
    t.app.db.run(`UPDATE nps_sends SET status = 'sending', sent_at = ? WHERE campaign_id = ?`, new Date(Date.now() - 2 * 3600_000).toISOString(), c.id);
    await t.app.services.npsTick();
    expect(sentTo(e)).toBe(0);
    const row = t.app.db.get<any>('SELECT status, error FROM nps_sends WHERE campaign_id = ?', c.id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/unterbrochen/);
    expect(t.app.db.get<any>('SELECT status FROM nps_campaigns WHERE id = ?', c.id)!.status).toBe('sent');
  });
});
