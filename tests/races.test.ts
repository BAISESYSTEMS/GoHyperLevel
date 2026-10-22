import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/core/app.js';
import { MODULES } from '../server/modules/index.js';
import { processRun, startWorkflow } from '../server/services/workflow-engine.js';
import { pinClock, startTestApp, unpinClock } from './helpers.js';

/**
 * Concurrency, idempotency and retry regressions: what went wrong when the same thing happened twice or at the same time – a
 * double click, a request and the scheduler working on the same row, a step that outlived a recovery timer, a restart in the
 * middle of a send. Each block names the rule it guards.
 */

vi.setConfig({ hookTimeout: 60_000 });

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A test e-mail transport: records every mail it accepted, each one takes `delayMs`. */
const outbox: { to: string; subject: string }[] = [];
let delayMs = 0;
const sentTo = (to: string, subject?: RegExp) => outbox.filter((m) => m.to === to && (!subject || subject.test(m.subject))).length;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.emailTransports = {
    ...(t.app.services.emailTransports ?? {}),
    racetest: async (_loc: unknown, mail: { to: string; subject: string }) => {
      if (delayMs) await sleep(delayMs);
      outbox.push({ to: mail.to, subject: mail.subject });
      return { status: 'sent' };
    },
  };
  t.app.db.run(`UPDATE locations SET settings = json_set(settings, '$.email', json(?)) WHERE id = ?`, JSON.stringify({ provider: 'racetest', fromEmail: 'team@firma.example' }), loc);
});
afterAll(async () => {
  unpinClock();
  await t.close();
});

const contact = async (email: string, extra: Record<string, unknown> = {}) => (await t.api.post('/api/contacts', { email, first_name: 'Rita', last_name: 'Rennen', ...extra })).data;

// --- workflows -----------------------------------------------------------------------------------------------------------------------

describe('a workflow run is never executed twice', () => {
  let counted = 0;
  let release: () => void = () => undefined;
  let gate = Promise.resolve();
  const closeGate = () => (gate = new Promise<void>((r) => (release = r)));

  beforeAll(() => {
    // two steps of our own: one with a side effect we can count, one that takes as long as the test wants
    t.app.services.workflowActions = { ...t.app.services.workflowActions, race_count: async () => (counted++, 'gezählt'), race_slow: async () => (await gate, 'fertig') };
  });

  const startRun = async (app = t.app) => {
    const c = await contact(`wf${Math.random().toString(36).slice(2, 8)}@kunde.example`);
    const wf = (await t.api.post('/api/workflows', { name: `Race ${Math.random()}`, trigger: { type: 'manual', config: {} }, steps: [{ type: 'race_count' }, { type: 'race_slow' }] })).data;
    expect((await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' })).status).toBe(200);
    const row = app.db.get<any>('SELECT * FROM workflows WHERE id = ?', wf.id)!;
    return startWorkflow(app, { ...row, steps: JSON.parse(row.steps), trigger: JSON.parse(row.trigger), settings: JSON.parse(row.settings) }, c.id, {})!;
  };

  it('a step that runs longer than five minutes is not started a second time by the crash recovery', async () => {
    counted = 0;
    closeGate();
    const rid = await startRun();
    const first = processRun(t.app, rid);
    await vi.waitFor(() => expect(counted).toBe(1));
    // six minutes later the slow step is still running in this process: the scheduler must leave the run alone
    pinClock(new Date(Date.now() + 6 * 60_000).toISOString());
    const tick = t.app.tick();
    await sleep(100);
    unpinClock();
    release();
    await Promise.all([first, tick]);
    expect(counted).toBe(1);
    expect(t.app.db.get<any>('SELECT status FROM workflow_runs WHERE id = ?', rid)!.status).toBe('completed');
  });

  it('after a crash the run goes on after the last finished step instead of repeating it', async () => {
    counted = 0;
    closeGate();
    const rid = await startRun();
    const first = processRun(t.app, rid);
    await vi.waitFor(() => expect(counted).toBe(1));
    // the process "dies" in the slow step: another process opens the same database and recovers the run
    const dir = t.app.config.dataDir;
    const other = createApp({ ...t.app.config, dbFile: join(dir, 'test.db'), tickMs: 0 }, MODULES);
    other.app.services.workflowActions = { ...other.app.services.workflowActions, race_count: t.app.services.workflowActions.race_count, race_slow: async () => 'fertig' };
    try {
      pinClock(new Date(Date.now() + 6 * 60_000).toISOString());
      await other.app.tick();
    } finally {
      unpinClock();
      release();
      await first;
      other.app.db.close();
    }
    expect(counted).toBe(1);
  });
});

// --- campaigns -----------------------------------------------------------------------------------------------------------------------

describe('a campaign reaches every recipient once', () => {
  it('"Senden" and the scheduler working at the same time do not mail anybody twice', async () => {
    const emails = ['k1@kampagne.example', 'k2@kampagne.example', 'k3@kampagne.example'];
    for (const e of emails) await contact(e, { tags: ['race-kampagne'] });
    const c = (await t.api.post('/api/campaigns', { name: 'Race', subject: 'Neuigkeiten', body: 'Hallo {{contact.first_name}}', filter: { tags: ['race-kampagne'] } })).data;
    delayMs = 40;
    try {
      const send = t.api.post(`/api/campaigns/${c.id}/send`, {});
      // the first mail is on its way: now the scheduler's tick comes along
      await vi.waitFor(() => expect(outbox.some((m) => emails.includes(m.to))).toBe(true), { interval: 5 });
      const { runTick } = await import('../server/services/campaign-run.js');
      await Promise.all([send, runTick(t.app)]);
      await runTick(t.app);
    } finally {
      delayMs = 0;
    }
    for (const e of emails) expect(sentTo(e, /Neuigkeiten/)).toBe(1);
    const rows = t.app.db.all<any>('SELECT status FROM campaign_recipients WHERE campaign_id = ?', c.id);
    expect(rows.map((r) => r.status)).toEqual(['sent', 'sent', 'sent']);
    expect(t.app.db.get<any>('SELECT status FROM campaigns WHERE id = ?', c.id)!.status).toBe('sent');
  });

  it('a recipient whose mail was on its way when the server stopped is not mailed again', async () => {
    const e = 'k4@kampagne.example';
    await contact(e, { tags: ['race-neustart'] });
    const c = (await t.api.post('/api/campaigns', { name: 'Neustart', subject: 'Neustart', body: 'Hallo', filter: { tags: ['race-neustart'] } })).data;
    const { runTick, startSending } = await import('../server/services/campaign-run.js');
    startSending(t.app, { ...c, filter: { tags: ['race-neustart'] } });
    // the batch claimed the recipient and the process died before the answer of the mail server was written down
    t.app.db.run(`UPDATE campaign_recipients SET status = 'sending', sent_at = ? WHERE campaign_id = ?`, new Date(Date.now() - 2 * 3600_000).toISOString(), c.id);
    await runTick(t.app);
    expect(sentTo(e)).toBe(0);
    const row = t.app.db.get<any>('SELECT status, error FROM campaign_recipients WHERE campaign_id = ?', c.id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/unterbrochen/);
    expect(t.app.db.get<any>('SELECT status FROM campaigns WHERE id = ?', c.id)!.status).toBe('sent');
  });
});

// --- dunning ---------------------------------------------------------------------------------------------------------------------------

describe('a dunning notice goes out once', () => {
  it('"Jetzt senden" clicked twice (or by two people) sends the Mahnung once', async () => {
    const email = 'mahnung@kunde.example';
    const c = await contact(email);
    const inv = (await t.api.post('/api/invoices', { contact_id: c.id, title: 'Beratung', items: [{ name: 'Beratung', qty: 1, price_cents: 11900, tax_rate: 0 }], due_at: new Date(Date.now() - 10 * 864e5).toISOString() })).data;
    expect((await t.api.patch(`/api/invoices/${inv.id}`, { status: 'sent' })).status).toBe(200);
    await t.api.put('/api/dunning/settings', { inv: { mode: 'approval' } });
    const run = (await t.api.post('/api/dunning/run', {})).data;
    const notice = run.created.find((n: any) => n.invoice_id === inv.id);
    expect(notice).toBeTruthy();
    delayMs = 40;
    let answers: { status: number }[];
    try {
      answers = await Promise.all([t.api.post(`/api/dunning/notices/${notice.id}/send`), t.api.post(`/api/dunning/notices/${notice.id}/send`)]);
    } finally {
      delayMs = 0;
    }
    expect(sentTo(email, /Zahlungserinnerung/)).toBe(1);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(t.app.db.get<any>('SELECT status FROM dunning_notices WHERE id = ?', notice.id)!.status).toBe('sent');
  });
});

describe('the first message of a failed subscription payment goes out once', () => {
  beforeAll(async () => {
    const { setStripeFetch } = await import('../server/services/stripe.js');
    const { KEY, WHSEC, fakeStripe } = await import('./creator-fakes.js');
    setStripeFetch(fakeStripe().handler);
    expect((await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC })).status).toBe(200);
  });
  afterAll(async () => (await import('../server/services/stripe.js')).setStripeFetch());

  it('also when the dunning sweep runs while the card-update mail is on its way', async () => {
    const { sendEvent, stripeInvoice } = await import('./creator-fakes.js');
    const email = 'abo-race@kunde.example';
    await contact(email);
    delayMs = 60;
    try {
      const failed = stripeInvoice({ id: 'in_race1', sub: 'sub_race1', amount: 2900, metadata: { location_id: loc }, email, status: 'open', next: Math.floor(Date.now() / 1000) + 3 * 86400 });
      expect((await sendEvent(t, 'invoice.payment_failed', failed)).status).toBe(200);
      // the webhook answered, the mail is still being delivered – now the scheduler's sweep comes along
      await t.app.services.dunning.sweep(true);
      await vi.waitFor(() => expect(sentTo(email)).toBeGreaterThan(0));
      await sleep(150);
    } finally {
      delayMs = 0;
    }
    expect(sentTo(email)).toBe(1);
    const c = t.app.db.get<any>('SELECT reminders FROM dunning_cases WHERE stripe_subscription = ?', 'sub_race1')!;
    expect(JSON.parse(c.reminders).map((r: any) => r.kind)).toEqual(['first']);
  });
});

// --- recurring invoices ------------------------------------------------------------------------------------------------------------------

describe('recurring invoices follow what was changed while the run was busy', () => {
  it('a subscription stopped while the run is sending the invoice before it gets no invoice and stays stopped', async () => {
    const SELLER = { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', tax_number: '37/123/45678', contact_name: 'Erika Muster', contact_phone: '+49 30 1234567', contact_email: 'rechnung@muster.example', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', bank: 'DKB' };
    expect((await t.api.put('/api/invoice-settings', SELLER)).status).toBe(200);
    const { runRecurringInvoices } = await import('../server/modules/payments.js');
    const c = await contact('abo-rechnung@kunde.example', { address: 'Hauptstraße 7', postal_code: '80331', city: 'München' });
    const due = new Date(Date.now() - 3600_000).toISOString();
    const parents: string[] = [];
    for (const title of ['Wartung A', 'Wartung B']) {
      const inv = (await t.api.post('/api/invoices', { contact_id: c.id, title, items: [{ name: title, qty: 1, price_cents: 4900 }] })).data;
      expect((await t.api.patch(`/api/invoices/${inv.id}`, { recurring: { interval: 'month', next_at: due, auto_send: true } })).status).toBe(200);
      parents.push(inv.id);
    }
    delayMs = 120;
    try {
      const run = runRecurringInvoices(t.app);
      // the invoice of A is being mailed: meanwhile somebody ends subscription B
      await vi.waitFor(() => expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM invoices WHERE parent_id = ?', parents[0])!.n).toBe(1), { interval: 5 });
      expect((await t.api.patch(`/api/invoices/${parents[1]}`, { recurring: null })).status).toBe(200);
      await run;
    } finally {
      delayMs = 0;
    }
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM invoices WHERE parent_id = ?', parents[1])!.n).toBe(0);
    expect(t.app.db.get<any>('SELECT recurring FROM invoices WHERE id = ?', parents[1])!.recurring).toBeNull();
  });
});

// --- live streams ------------------------------------------------------------------------------------------------------------------------

describe('live streams', () => {
  it('a stream opened with an API key or agency key ends when that key is deleted; other keys keep theirs', async () => {
    const { openSse, BYE } = await import('./sse-fixtures.js');
    const board = (await t.api.post('/api/canvas', { name: 'Schlüssel-Stream' })).data;
    const k1 = (await t.api.post('/api/api-keys', { name: 'Bot 1' })).data;
    const k2 = (await t.api.post('/api/api-keys', { name: 'Bot 2' })).data;
    const ak = (await t.api.post('/api/agency/api-keys', { name: 'Agentur-Bot' })).data;
    const url = (cid: string) => `${t.base}/api/canvas/${board.id}/stream?clientId=${cid}&locationId=${loc}`;
    const s1 = await openSse(url('key-stream-one'), { authorization: `Bearer ${k1.key}` });
    const s2 = await openSse(url('key-stream-two'), { authorization: `Bearer ${k2.key}` });
    const s3 = await openSse(url('agency-stream-1'), { authorization: `Bearer ${ak.key}`, 'x-location-id': loc });
    for (const s of [s1, s2, s3]) expect(await s.until(/event: hello/)).toBe(true);
    try {
      expect((await t.api.del(`/api/api-keys/${k1.id}`)).status).toBe(200);
      expect(await s1.until(BYE)).toBe(true);
      expect(await s1.ends()).toBe(true);
      expect((await t.api.del(`/api/agency/api-keys/${ak.id}`)).status).toBe(200);
      expect(await s3.until(BYE)).toBe(true);
      // the key that was not touched keeps its stream (also through the regular check every 20 s)
      t.app.services.canvasHub.sweep();
      expect(await s2.quiet(/event: bye/)).toBe(true);
      expect(s2.ended()).toBe(false);
    } finally {
      for (const s of [s1, s2, s3]) await s.close();
    }
  });

  it('a full server answers 503 instead of a stream that ends at once (the browser retried that every 3 s)', async () => {
    const get = (path: string) => t.api.raw(path, { headers: { cookie: t.api.cookie, 'x-location-id': loc } });
    // Team-Chat and Team-Posteingang: 600 streams
    for (const [hub, path] of [[t.app.services.chatHub, '/api/team-chat/stream'], [t.app.services.inboxHub, '/api/inbox/stream']] as const) {
      for (let i = 0; i < 600; i++) hub.subscribe({ clientId: `fill-${i}`, userId: `filler-${Math.floor(i / 8)}`, locationId: loc, admin: false });
      const r = await get(`${path}?clientId=full-tab-1&locationId=${loc}`);
      expect(r.status, path).toBe(503);
      await r.body?.cancel();
      for (let i = 0; i < 75; i++) hub.closeUser(`filler-${i}`);
    }
    // Living Boards: 100 streams per board
    const b = (await t.api.post('/api/boards', { name: 'Voll' })).data;
    for (let i = 0; i < 100; i++) t.app.services.boardsHub.subscribe({ clientId: `board-fill-${i}`, boardId: b.id, locationId: loc, userId: `bf-${i}`, name: 'X' });
    const rb = await get(`/api/boards/${b.id}/stream?clientId=full-tab-2&locationId=${loc}`);
    expect(rb.status).toBe(503);
    await rb.body?.cancel();
    // Canvas: 200 viewers per board
    const cv = (await t.api.post('/api/canvas', { name: 'Voll' })).data;
    for (let i = 0; i < 200; i++) t.app.services.canvasHub.subscribe(cv.id, { clientId: `canvas-fill-${i}`, name: 'X', color: '#000', kind: 'user', at: Date.now() }, 0);
    const rc = await get(`/api/canvas/${cv.id}/stream?clientId=full-tab-3&locationId=${loc}`);
    expect(rc.status).toBe(503);
    await rc.body?.cancel();
  });
});

// --- appointment reminders -----------------------------------------------------------------------------------------------------------------

describe('appointment reminders follow the appointment as it is now', () => {
  it('an appointment cancelled while the reminder run mails the ones before it gets no reminder', async () => {
    const { sendReminders } = await import('../server/services/booking-messages.js');
    const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));
    const cal = (await t.api.post('/api/calendars', { name: 'Erinnerungs-Race', duration: 30, interval: 30, min_notice: 0, max_days: 90, availability: every, settings: { confirmation_email: false, notify_team: false, reminder_hours: 0, reminders: [{ hours: 24, email: true, sms: false }] } })).data;
    const a = await contact('termin-a@kunde.example');
    const b = await contact('termin-b@kunde.example');
    const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    const first = (await t.api.post('/api/appointments', { calendar_id: cal.id, contact_id: a.id, start: at(30), force: true })).data;
    const second = (await t.api.post('/api/appointments', { calendar_id: cal.id, contact_id: b.id, start: at(31), force: true })).data;
    expect(first.id && second.id).toBeTruthy();
    delayMs = 120;
    try {
      const run = sendReminders(t.app, new Date(Date.now() + 8 * 3600_000));
      // A's reminder is on its way: meanwhile B is cancelled
      await vi.waitFor(() => expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND source = 'Terminerinnerung'`, a.id)!.n).toBe(1), { interval: 5 });
      expect((await t.api.patch(`/api/appointments/${second.id}`, { status: 'cancelled' })).status).toBe(200);
      await run;
    } finally {
      delayMs = 0;
    }
    expect(sentTo('termin-a@kunde.example')).toBe(1);
    expect(sentTo('termin-b@kunde.example')).toBe(0);
  });
});

describe('the classic appointment reminder (reminder_hours) follows the appointment as it is now', () => {
  it('an appointment cancelled while the scheduler mails the reminders before it gets none', async () => {
    const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));
    const cal = (await t.api.post('/api/calendars', { name: 'Klassik-Race', duration: 30, interval: 30, min_notice: 0, max_days: 90, availability: every, settings: { confirmation_email: false, notify_team: false, reminder_hours: 24 } })).data;
    const a = await contact('klassik-a@kunde.example');
    const b = await contact('klassik-b@kunde.example');
    const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    const first = (await t.api.post('/api/appointments', { calendar_id: cal.id, contact_id: a.id, start: at(2), force: true })).data;
    const second = (await t.api.post('/api/appointments', { calendar_id: cal.id, contact_id: b.id, start: at(3), force: true })).data;
    // booked a while ago (the classic reminder waits ten minutes after the booking)
    t.app.db.run(`UPDATE appointments SET created_at = ? WHERE id IN (?, ?)`, new Date(Date.now() - 3600_000).toISOString(), first.id, second.id);
    delayMs = 120;
    try {
      const tick = t.app.tick();
      await vi.waitFor(() => expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND source = 'Terminerinnerung'`, a.id)!.n).toBe(1), { interval: 5 });
      expect((await t.api.patch(`/api/appointments/${second.id}`, { status: 'cancelled' })).status).toBe(200);
      await tick;
    } finally {
      delayMs = 0;
    }
    expect(sentTo('klassik-a@kunde.example')).toBe(1);
    expect(sentTo('klassik-b@kunde.example')).toBe(0);
  });
});

// --- paying an invoice online --------------------------------------------------------------------------------------------------------------

describe('paying an invoice online', () => {
  let stripe: any;
  beforeAll(async () => {
    const { setStripeFetch } = await import('../server/services/stripe.js');
    const { KEY, WHSEC, fakeStripe } = await import('./creator-fakes.js');
    stripe = fakeStripe();
    stripe.state.seq = 500; // session ids of their own (the database keeps the ones of earlier blocks)
    // Stripe takes a moment to answer: long enough for a double click to arrive meanwhile
    setStripeFetch((async (url: string, init: any) => {
      if (String(url).endsWith('/v1/checkout/sessions') && init.method === 'POST') await sleep(60);
      return stripe.handler(url, init);
    }) as any);
    expect((await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC })).status).toBe(200);
  });
  afterAll(async () => (await import('../server/services/stripe.js')).setStripeFetch());

  const openInvoice = async (email: string) => {
    const c = await contact(email);
    const inv = (await t.api.post('/api/invoices', { contact_id: c.id, title: 'Website', items: [{ name: 'Website', qty: 1, price_cents: 50000, tax_rate: 19 }] })).data;
    return (await t.api.patch(`/api/invoices/${inv.id}`, { status: 'sent' })).data;
  };
  const pay = (inv: any) => t.api.raw(`/i/${inv.public_token}/pay`, { method: 'POST', redirect: 'manual' });
  const sessionsOf = (inv: any) => [...stripe.sessions.values()].filter((s: any) => s.metadata.invoice_id === inv.id);

  it('a double click on "Jetzt bezahlen" opens one Checkout page, not two', async () => {
    const inv = await openInvoice('doppelklick@kunde.example');
    const [a, b] = await Promise.all([pay(inv), pay(inv)]);
    expect([a.status, b.status]).toEqual([303, 303]);
    expect(a.headers.get('location')).toBe(b.headers.get('location'));
    expect(sessionsOf(inv)).toHaveLength(1);
  });

  it('while a SEPA debit is being processed the invoice offers no second payment', async () => {
    const { sendEvent } = await import('./creator-fakes.js');
    const inv = await openInvoice('lastschrift@kunde.example');
    expect((await pay(inv)).status).toBe(303);
    const [session] = sessionsOf(inv);
    // Checkout is done, the money is on its way (SEPA Direct Debit: "unpaid" until the bank confirms, days later)
    expect((await sendEvent(t, 'checkout.session.completed', { ...session, status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_sepa_1' })).data.handled).toBe('pending');
    const page = await (await t.api.raw(`/i/${inv.public_token}`)).text();
    expect(page).not.toContain('Jetzt bezahlen');
    expect(page).toContain('in Bearbeitung');
    const again = await pay(inv);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('in Bearbeitung');
    expect(sessionsOf(inv)).toHaveLength(1);
    // the debit failed: paying online is possible again
    expect((await sendEvent(t, 'checkout.session.async_payment_failed', { ...session, status: 'complete', payment_status: 'unpaid' })).status).toBe(200);
    expect((await pay(inv)).status).toBe(303);
    expect(sessionsOf(inv)).toHaveLength(2);
  });
});

// --- planned mails from a connected mailbox ---------------------------------------------------------------------------------------------

describe('a planned mail whose answer got lost is not sent again', () => {
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
    m.t.app.db.run('UPDATE mailbox_scheduled SET send_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), r.data.scheduled_id);
    return r.data.scheduled_id as string;
  };
  const sent = (subject: string) => m.fake.g.sentRaw.filter((x) => x.parsed.subject === subject).length;

  it('Gmail took the mail but the answer timed out: no second send five minutes later, the row says what to check', async () => {
    const id = await plan('Angekommen?');
    const real = m.t.app.services.oauthFetch;
    m.t.app.services.oauthFetch = async (url: string, init: any) => {
      const r = await real(url, init);
      if (/\/messages\/send/.test(String(url))) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return r;
    };
    try {
      await m.t.app.tick();
    } finally {
      m.t.app.services.oauthFetch = real;
    }
    expect(sent('Angekommen?')).toBe(1);
    // the retry time comes …
    m.t.app.db.run('UPDATE mailbox_scheduled SET send_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), id);
    await m.t.app.tick();
    expect(sent('Angekommen?')).toBe(1);
    const row = m.t.app.db.get<any>('SELECT status, error FROM mailbox_scheduled WHERE id = ?', id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/Gesendet/);
  });

  it('a refused send (the provider answered with an error) is still tried again', async () => {
    const id = await plan('Später nochmal');
    m.fake.g.failures.push({ match: /POST \/messages\/send/, status: 503, times: 1 });
    await m.t.app.tick();
    expect(m.t.app.db.get<any>('SELECT status, attempts FROM mailbox_scheduled WHERE id = ?', id)).toMatchObject({ status: 'pending', attempts: 1 });
    m.t.app.db.run('UPDATE mailbox_scheduled SET send_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), id);
    await m.t.app.tick();
    expect(sent('Später nochmal')).toBe(1);
    expect(m.t.app.db.get<any>('SELECT status FROM mailbox_scheduled WHERE id = ?', id)!.status).toBe('sent');
  });
});

// --- discount codes with a limit -----------------------------------------------------------------------------------------------------------

describe('a discount code with a limit is not used more often than allowed', () => {
  let stripe: any;
  beforeAll(async () => {
    const { setStripeFetch } = await import('../server/services/stripe.js');
    const { KEY, WHSEC, fakeStripe } = await import('./creator-fakes.js');
    stripe = fakeStripe();
    stripe.state.seq = 1000; // session ids of their own (the database keeps the ones of earlier blocks)
    setStripeFetch((async (url: string, init: any) => {
      if (String(url).endsWith('/v1/checkout/sessions') && init.method === 'POST') await sleep(60);
      return stripe.handler(url, init);
    }) as any);
    expect((await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC })).status).toBe(200);
  });
  afterAll(async () => (await import('../server/services/stripe.js')).setStripeFetch());

  const form = (body: Record<string, string>) => ({ method: 'POST', redirect: 'manual' as const, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const withCode = (code: string) => [...stripe.sessions.values()].filter((s: any) => s.metadata.coupon_code === code);

  it('two buyers at the same time, or one after the other while the first still pays: the last use goes once', async () => {
    const { sendEvent } = await import('./creator-fakes.js');
    const p = (await t.api.post('/api/products', { name: 'Launch-Kurs', price_cents: 10000, tax_rate: 19 })).data;
    expect((await t.api.post(`/api/buy-offers/${p.id}/coupons`, { code: 'LAUNCH', kind: 'percent', value: 50, max_uses: 1 })).status).toBe(200);
    // a double submit (or two people at once): one Checkout page with the code, the other is told it is used up
    const [a, b] = await Promise.all([t.api.raw(`/buy/${p.id}`, form({ coupon: 'LAUNCH', email: 'eins@kunde.example' })), t.api.raw(`/buy/${p.id}`, form({ coupon: 'LAUNCH', email: 'zwei@kunde.example' }))]);
    expect([a.status, b.status].sort()).toEqual([303, 400]);
    expect(withCode('LAUNCH')).toHaveLength(1);
    // while the first buyer is still on Stripe's page the code is taken
    const c = await t.api.raw(`/buy/${p.id}`, form({ coupon: 'LAUNCH', email: 'drei@kunde.example' }));
    expect(c.status).toBe(400);
    expect(await c.text()).toContain('aufgebraucht');
    expect((await t.api.get(`/api/public/buy/${p.id}/coupon?code=LAUNCH`)).data.ok).toBe(false);
    // the first buyer gives up (the page expires): the code is free again
    const [held] = withCode('LAUNCH');
    expect(Number(stripe.last('/v1/checkout/sessions').params.get('expires_at'))).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 60);
    expect((await sendEvent(t, 'checkout.session.expired', { ...held, status: 'expired' })).status).toBe(200);
    expect((await t.api.raw(`/buy/${p.id}`, form({ coupon: 'LAUNCH', email: 'drei@kunde.example' }))).status).toBe(303);
  });
});
