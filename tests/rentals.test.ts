import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinClock, startTestApp, unpinClock } from './helpers.js';
import { freeOver, freePerDay, priceOf, rangeOf, stayTimes, unitsProblem } from '../server/services/rentals-model.js';
import { getSession, registerPayProvider, settleSession } from '../server/services/pay-registry.js';
import { RENTAL_TOOLS } from '../server/modules/rentals.js';
import { classify } from '../server/services/agent-safety.js';
import { multiDay } from '../web/src/pages/calview-model.js';

/** Vermietung: items with a quantity booked by date range (modules/rentals.ts, services/rentals-*.ts, docs/booking.md#rentals). */

let t: Awaited<ReturnType<typeof startTestApp>>;
const ids: Record<string, string> = {};
const pub = (path: string, body?: unknown) =>
  t.api.raw(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
const person = (n: number | string) => ({ first_name: `Gast${n}`, last_name: 'Test', email: `gast${n}@example.com`, consent: true });
const free = async (rid: string, from: string, days = 7) => (await t.api.get(`/api/rentals/${rid}/availability?from=${from}&days=${days}`)).data.days.map((d: any) => d.free);

beforeAll(async () => {
  pinClock('2027-03-01T08:00:00Z'); // Monday, 09:00 in Berlin
  t = await startTestApp();
  await t.setup();
  // A fake payment provider: the registry is "ready", the money is confirmed by the test (settleSession).
  registerPayProvider(t.app, { id: 'fake', label: 'Testzahlung', methods: () => ['Test'], ready: () => true, create: async (_a, s) => ({ url: `https://pay.example/${s.id}`, ref: s.id }), fetch: async () => ({ status: 'open' }), refund: async () => ({ id: 'refund-1' }) } as any);
  ids.other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
});
afterAll(async () => {
  await t?.close();
  unpinClock();
});

describe('rules (pure)', () => {
  it('turns a request into a half-open range of days', () => {
    expect(rangeOf('night', { from: '2027-03-10', to: '2027-03-13' })).toEqual({ from: '2027-03-10', to: '2027-03-13', units: 3 });
    // day rental: the last day counts
    expect(rangeOf('day', { from: '2027-03-10', to: '2027-03-12' })).toEqual({ from: '2027-03-10', to: '2027-03-13', units: 3 });
    expect(rangeOf('day', { from: '2027-03-10', to: '2027-03-10' }).units).toBe(1);
    expect(rangeOf('night', { from: '2027-03-30', days: 3 })).toEqual({ from: '2027-03-30', to: '2027-04-02', units: 3 });
    expect(() => rangeOf('night', { from: '2027-03-10', to: '2027-03-10' })).toThrow(/Abreise/);
    expect(() => rangeOf('day', { from: '2027-02-30', to: '2027-03-01' })).toThrow();
    expect(() => rangeOf('day', { from: '2027-03-10' })).toThrow(/Anzahl/);
    expect(unitsProblem({ unit: 'night', min_units: 2, max_units: 7 }, 1)).toMatch(/Mindestens 2 Nächte/);
    expect(unitsProblem({ unit: 'day', min_units: 1, max_units: 3 }, 4)).toMatch(/Höchstens 3 Tage/);
    expect(unitsProblem({ unit: 'day', min_units: 1, max_units: 0 }, 300)).toBeNull();
  });

  it('counts free units over the tightest day; check-out and check-in on the same day do not overlap', () => {
    const taken = [
      { from_date: '2027-03-10', to_date: '2027-03-12', qty: 1 },
      { from_date: '2027-03-11', to_date: '2027-03-14', qty: 1 },
    ];
    expect(freeOver(2, taken, '2027-03-10', '2027-03-11')).toBe(1);
    expect(freeOver(2, taken, '2027-03-11', '2027-03-12')).toBe(0);
    // same-day turnover: the stay ending on the 14th does not block a check-in on the 14th
    expect(freeOver(1, taken, '2027-03-14', '2027-03-16')).toBe(1);
    expect(freeOver(1, taken, '2027-03-08', '2027-03-10')).toBe(1);
    expect(freePerDay(2, taken, '2027-03-09', 6).map((d) => d.free)).toEqual([2, 1, 0, 1, 1, 2]);
  });

  it('the calendar view draws stays across days in the all-day row', () => {
    expect(multiDay('2027-03-10T13:00:00.000Z', '2027-03-12T09:00:00.000Z', 'Europe/Berlin')).toBe(true);
    expect(multiDay('2027-03-10T08:00:00.000Z', '2027-03-10T17:00:00.000Z', 'Europe/Berlin')).toBe(false);
    // ends exactly at midnight: still one day
    expect(multiDay('2027-03-10T21:00:00.000Z', '2027-03-10T23:00:00.000Z', 'Europe/Berlin')).toBe(false);
  });

  it('prices per day/night × length × items plus the deposit per item; stays run from check-in to check-out time', () => {
    expect(priceOf({ price_cents: 2500, deposit_cents: 5000 }, 3, 2)).toEqual({ units: 3, qty: 2, rent_cents: 15000, deposit_cents: 10000, total_cents: 25000 });
    expect(priceOf({ price_cents: 0, deposit_cents: 0 }, 5, 1).total_cents).toBe(0);
    expect(stayTimes({ unit: 'night', checkin_time: '', checkout_time: '' }, { from: '2027-03-10', to: '2027-03-12' }, 'Europe/Berlin')).toEqual({ start_at: '2027-03-10T14:00:00.000Z', end_at: '2027-03-12T10:00:00.000Z' });
    expect(stayTimes({ unit: 'day', checkin_time: '08:00', checkout_time: '19:00' }, { from: '2027-03-10', to: '2027-03-11' }, 'Europe/Berlin')).toEqual({ start_at: '2027-03-10T07:00:00.000Z', end_at: '2027-03-10T18:00:00.000Z' });
  });
});

describe('items', () => {
  it('creates an item with its own calendar and booking link; checks the fields', async () => {
    expect((await t.api.post('/api/rentals', { name: 'X', unit: 'week' })).status).toBe(400);
    expect((await t.api.post('/api/rentals', { name: 'X', quantity: 0 })).status).toBe(400);
    expect((await t.api.post('/api/rentals', { name: 'X', min_units: 5, max_units: 2 })).status).toBe(400);
    expect((await t.api.post('/api/rentals', { name: 'X', checkin_time: '25:00' })).status).toBe(400);
    const bikes = await t.api.post('/api/rentals', { name: 'E-Bike', description: 'Trekking-E-Bike mit Helm', quantity: 3, unit: 'day', price_cents: 0, max_units: 14 });
    expect(bikes.status, JSON.stringify(bikes.data)).toBe(200);
    expect(bikes.data).toMatchObject({ name: 'E-Bike', quantity: 3, unit: 'day', slug: 'e-bike', active: true, upcoming: 0 });
    expect(bikes.data.url).toMatch(/\/book\/rent\/e-bike$/);
    ids.bikes = bikes.data.id;
    ids.bikesCal = bikes.data.calendar_id;
    const cal = t.app.db.get<any>('SELECT * FROM calendars WHERE id = ?', ids.bikesCal);
    expect(JSON.parse(cal.settings).rental).toBe(true);
    // never offered as a time slot: the plain slot API has nothing
    const slots = (await pub(`/api/public/calendars/e-bike/slots?days=3`)).data;
    expect(slots.days.every((d: any) => d.slots.length === 0)).toBe(true);
    ids.flat = (await t.api.post('/api/rentals', { name: 'Ferienwohnung Seeblick', quantity: 1, unit: 'night', price_cents: 8000, deposit_cents: 20000, min_units: 2, max_units: 14 })).data.id;
    ids.room = (await t.api.post('/api/rentals', { name: 'Zimmer', quantity: 1, unit: 'night', price_cents: 0 })).data.id;
    const list = (await t.api.get('/api/rentals')).data;
    expect(list.map((r: any) => r.name)).toEqual(['E-Bike', 'Ferienwohnung Seeblick', 'Zimmer']);
    expect((await t.api.patch(`/api/rentals/${ids.room}`, { checkin_time: '14:00', checkout_time: '10:00', name: 'Doppelzimmer' })).data).toMatchObject({ name: 'Doppelzimmer', checkin_time: '14:00' });
  });

  it('serves the public page (also on the calendar link) and the public data', async () => {
    const page = await (await t.api.raw('/book/rent/e-bike')).text();
    expect(page).toContain('E-Bike');
    expect(page).toContain('rg-grid');
    expect(await (await t.api.raw('/book/e-bike')).text()).toContain('rg-grid');
    expect((await t.api.raw('/book/rent/gibtsnicht')).status).toBe(404);
    const info = (await pub('/api/public/rentals/e-bike')).data;
    expect(info).toMatchObject({ name: 'E-Bike', quantity: 3, unit: 'day', today: '2027-03-01' });
    expect(info.upcoming).toBeUndefined();
  });
});

describe('availability and overlap', () => {
  it('books whole days; the units go down per day and come back after the range', async () => {
    const r = await pub('/api/public/rentals/e-bike/book', { from: '2027-03-10', to: '2027-03-12', qty: 2, ...person(1) });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.status).toBe('confirmed');
    expect(r.data.booking).toMatchObject({ from: '2027-03-10', until: '2027-03-12', units: 3, qty: 2, total_cents: 0 });
    expect(await free(ids.bikes, '2027-03-09', 5)).toEqual([3, 1, 1, 1, 3]);
    // the appointment spans the days (shown across them in the calendar view), with the confirmation e-mail of the calendar
    const a = t.app.db.get<any>('SELECT * FROM appointments WHERE id = ?', r.data.booking.appointment_id);
    expect(a).toMatchObject({ calendar_id: ids.bikesCal, start_at: '2027-03-10T08:00:00.000Z', end_at: '2027-03-12T17:00:00.000Z', status: 'confirmed', source: 'Buchungsseite' });
    expect(a.title).toContain('×2');
    const mail = t.app.db.get<any>(`SELECT subject, body FROM messages WHERE contact_id = ? AND source = 'Terminbestätigung'`, a.contact_id);
    expect(mail.subject).toBe('Buchung bestätigt: E-Bike');
    expect(mail.body).toContain('10.03.2027 – 12.03.2027 · 3 Tage · 2 Stück');
    // too many for the free rest, a day after the range is fine
    const over = await pub('/api/public/rentals/e-bike/book', { from: '2027-03-12', to: '2027-03-12', qty: 2, ...person(2) });
    expect(over.status).toBe(409);
    expect(over.data.error).toMatch(/nur noch 1 frei/);
    expect((await pub('/api/public/rentals/e-bike/book', { from: '2027-03-13', days: 1, qty: 3, ...person(3) })).data.status).toBe('confirmed');
  });

  it('nights: same-day turnover works, an overlap does not', async () => {
    const book = (from: string, to: string, n: number) => t.api.post(`/api/rentals/${ids.room}/book`, { from, to, ...person(`n${n}`) });
    expect((await book('2027-03-03', '2027-03-05', 1)).data.status).toBe('confirmed');
    expect((await book('2027-03-05', '2027-03-07', 2)).data.status).toBe('confirmed'); // check-in on the check-out day
    expect((await book('2027-03-01', '2027-03-03', 3)).data.status).toBe('confirmed'); // check-out on the check-in day
    const clash = await book('2027-03-04', '2027-03-06', 4);
    expect(clash.status).toBe(409);
    expect(clash.data.error).toMatch(/nichts mehr frei/);
    expect((await book('2027-03-06', '2027-03-08', 5)).status).toBe(409);
    expect(await free(ids.room, '2027-03-01', 8)).toEqual([0, 0, 0, 0, 0, 0, 1, 1]);
    // the stays as appointments: check-out 10:00 and the next check-in 14:00 on the same day
    const appts = t.app.db.all<any>(`SELECT start_at, end_at FROM appointments a JOIN rentals r ON r.calendar_id = a.calendar_id WHERE r.id = ? ORDER BY start_at`, ids.room);
    expect(appts[1]).toEqual({ start_at: '2027-03-03T13:00:00.000Z', end_at: '2027-03-05T09:00:00.000Z' });
    expect(appts[2].start_at).toBe('2027-03-05T13:00:00.000Z');
  });

  it('checks length, horizon and the past; a quote says why', async () => {
    const qt = (qs: string) => t.api.get(`/api/rentals/${ids.flat}/quote?${qs}`).then((r) => r.data);
    expect(await qt('from=2027-04-01&to=2027-04-02')).toMatchObject({ ok: false, problem: 'Mindestens 2 Nächte' });
    expect(await qt('from=2027-04-01&days=20')).toMatchObject({ ok: false, problem: 'Höchstens 14 Nächte' });
    expect(await qt('from=2027-02-20&to=2027-02-23')).toMatchObject({ ok: false, problem: expect.stringMatching(/Vergangenheit/) });
    expect(await qt('from=2029-01-01&to=2029-01-03')).toMatchObject({ ok: false, problem: expect.stringMatching(/im Voraus/) });
    expect(await qt('from=2027-04-01&to=2027-04-04&qty=2')).toMatchObject({ ok: false, problem: 'Es gibt nur 1 Stück' });
    expect((await t.api.get(`/api/rentals/${ids.flat}/quote?from=kaputt`)).status).toBe(400);
  });

  it('a blocked time in the calendar closes the days it touches', async () => {
    expect((await t.api.post('/api/appointments', { calendar_id: ids.bikesCal, blocked: true, title: 'Wartung', start: '2027-03-20T08:00:00Z', end: '2027-03-20T12:00:00Z' })).status).toBe(200);
    expect(await free(ids.bikes, '2027-03-19', 3)).toEqual([3, 0, 3]);
    expect((await t.api.post(`/api/rentals/${ids.bikes}/book`, { from: '2027-03-19', to: '2027-03-21', ...person('w') })).status).toBe(409);
  });

  it('a cancelled booking gives its units back (link in the confirmation, until the start)', async () => {
    const r = await t.api.post(`/api/rentals/${ids.room}/book`, { from: '2027-03-20', to: '2027-03-22', ...person('c') });
    const token = t.app.db.get<any>('SELECT manage_token FROM appointments WHERE id = ?', r.data.booking.appointment_id).manage_token;
    expect(await (await t.api.raw(`/book/manage/${token}`)).text()).toContain('Buchung absagen');
    expect(await free(ids.room, '2027-03-20', 2)).toEqual([0, 0]);
    expect((await pub(`/api/public/appointments/${token}/cancel`, {})).status).toBe(200);
    expect(await free(ids.room, '2027-03-20', 2)).toEqual([1, 1]);
    expect((await t.api.get(`/api/rentals/${ids.room}/bookings?all=1`)).data.find((b: any) => b.id === r.data.booking.id).status).toBe('cancelled');
  });
});

describe('no overbooking under concurrency', () => {
  it('20 parallel requests for 3 units: exactly 3 get one', async () => {
    const tries = Array.from({ length: 20 }, (_, i) => t.api.post(`/api/rentals/${ids.bikes}/book`, { from: '2027-04-05', to: '2027-04-07', ...person(`p${i}`) }));
    const res = await Promise.all(tries);
    expect(res.filter((r) => r.status === 200 && r.data.status === 'confirmed')).toHaveLength(3);
    expect(res.filter((r) => r.status === 409)).toHaveLength(17);
    expect(await free(ids.bikes, '2027-04-05', 3)).toEqual([0, 0, 0]);
    const n = t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM rental_bookings WHERE rental_id = ? AND from_date = '2027-04-05' AND status = 'confirmed'`, ids.bikes)!.n;
    expect(n).toBe(3);
  });

  it('parallel paid holds for the last unit: one hold, the others are refused', async () => {
    const tries = Array.from({ length: 6 }, (_, i) => t.api.post(`/api/rentals/${ids.flat}/book`, { from: '2027-05-01', to: '2027-05-04', ...person(`h${i}`) }));
    const res = await Promise.all(tries);
    expect(res.filter((r) => r.data.status === 'payment_required')).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(5);
  });
});

describe('price and payment', () => {
  it('a paid item holds the range while the customer pays; the payment confirms with an invoice', async () => {
    const r = await pub('/api/public/rentals/ferienwohnung-seeblick/book', { from: '2027-06-10', to: '2027-06-13', ...person('pay') });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    // 3 nights × 80 € + 200 € Kaution
    expect(r.data).toMatchObject({ status: 'payment_required', due_cents: 44000, currency: 'EUR' });
    expect(r.data.booking).toMatchObject({ rent_cents: 24000, deposit_cents: 20000, total_cents: 44000, status: 'pending' });
    expect(r.data.checkout_url).toMatch(/\/pay\/ps_/);
    // held: nobody else gets it meanwhile
    expect((await pub('/api/public/rentals/ferienwohnung-seeblick/quote?from=2027-06-11&to=2027-06-14')).data.ok).toBe(false);
    const b = t.app.db.get<any>('SELECT * FROM rental_bookings WHERE id = ?', r.data.booking.id);
    const s = getSession(t.app, b.pay_session_id)!;
    expect(s).toMatchObject({ purpose: 'rental', amount_cents: 44000 });
    expect((await t.api.raw(`/book/rent/paid/${b.token}`).then((x) => x.text()))).toContain('Zahlung wird geprüft');
    await settleSession(t.app, s, { status: 'paid', amount_cents: 44000, currency: 'EUR' }, 'fake').pending;
    const done = t.app.db.get<any>('SELECT * FROM rental_bookings WHERE id = ?', b.id);
    expect(done.status).toBe('confirmed');
    expect(done.paid_at).toBeTruthy();
    const a = t.app.db.get<any>('SELECT * FROM appointments WHERE id = ?', done.appointment_id);
    expect(a).toMatchObject({ start_at: '2027-06-10T13:00:00.000Z', end_at: '2027-06-13T09:00:00.000Z' });
    const inv = t.app.db.get<any>('SELECT * FROM invoices WHERE id = ?', done.invoice_id);
    expect(inv).toMatchObject({ status: 'paid', total_cents: 44000, contact_id: a.contact_id });
    const items = JSON.parse(inv.items);
    expect(items.find((x: any) => x.name === 'Kaution')).toMatchObject({ price_cents: 20000, tax_rate: 0 });
    expect((await t.api.raw(`/book/rent/paid/${b.token}`).then((x) => x.text()))).toContain('Bezahlt und gebucht');
    const mail = t.app.db.get<any>(`SELECT body FROM messages WHERE contact_id = ? AND source = 'Terminbestätigung'`, a.contact_id);
    expect(mail.body).toContain('Betrag: 440,00');
    expect(mail.body).toContain('bezahlt');
    // a second settle does nothing
    await settleSession(t.app, getSession(t.app, s.id)!, { status: 'paid' }, 'fake').pending;
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM appointments WHERE calendar_id = ?', a.calendar_id)!.n).toBe(1);
  });

  it('an unpaid hold runs out and frees the range; a late payment for a taken range is refunded', async () => {
    const r = await t.api.post(`/api/rentals/${ids.flat}/book`, { from: '2027-07-01', to: '2027-07-03', ...person('late') });
    expect(r.data.status).toBe('payment_required');
    t.app.db.run('UPDATE rental_bookings SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), r.data.booking.id);
    expect((await t.api.get(`/api/rentals/${ids.flat}/quote?from=2027-07-01&to=2027-07-03`)).data.ok).toBe(true);
    // somebody else books it without online payment (the team waived it)
    expect((await t.api.post(`/api/rentals/${ids.flat}/book`, { from: '2027-07-01', to: '2027-07-03', payment: 'waive', ...person('waive') })).data.status).toBe('confirmed');
    const b = t.app.db.get<any>('SELECT * FROM rental_bookings WHERE id = ?', r.data.booking.id);
    await settleSession(t.app, getSession(t.app, b.pay_session_id)!, { status: 'paid' }, 'fake').pending;
    await new Promise((res) => setTimeout(res, 20));
    expect(t.app.db.get<any>('SELECT status FROM rental_bookings WHERE id = ?', b.id).status).toBe('refunded');
    expect(await free(ids.flat, '2027-07-01', 2)).toEqual([0, 0]);
  });

  it('a team booking may waive the online payment', async () => {
    const w = await t.api.post(`/api/rentals/${ids.flat}/book`, { from: '2027-08-01', days: 2, payment: 'waive', email: 'team@example.com' });
    expect(w.data).toMatchObject({ status: 'confirmed' });
    expect(w.data.booking.total_cents).toBe(44000 - 8000);
    expect(w.data.booking.source).toBe('manuell');
  });
});

describe('isolation', () => {
  it('another sub-account sees none of it and cannot book it', async () => {
    const own = t.api.location;
    t.api.setLocation(ids.other);
    try {
      expect((await t.api.get('/api/rentals')).data).toEqual([]);
      expect((await t.api.get(`/api/rentals/${ids.bikes}`)).status).toBe(404);
      expect((await t.api.get(`/api/rentals/${ids.bikes}/availability`)).status).toBe(404);
      expect((await t.api.post(`/api/rentals/${ids.bikes}/book`, { from: '2027-09-01', days: 1, ...person('x') })).status).toBe(404);
      expect((await t.api.patch(`/api/rentals/${ids.bikes}`, { quantity: 99 })).status).toBe(404);
      expect((await t.api.del(`/api/rentals/${ids.bikes}`)).status).toBe(404);
      // its own item of the same name has its own units
      const mine = (await t.api.post('/api/rentals', { name: 'E-Bike', quantity: 1 })).data;
      expect(mine.slug).toBe('e-bike-2');
      expect((await t.api.get(`/api/rentals/${mine.id}/availability?from=2027-04-05&days=1`)).data.days[0].free).toBe(1);
    } finally {
      t.api.setLocation(own);
    }
    expect((await t.api.get(`/api/rentals/${ids.bikes}`)).data.quantity).toBe(3);
    expect(await free(ids.bikes, '2027-04-05', 1)).toEqual([0]);
  });

  it('deleting an item with bookings ahead needs force', async () => {
    expect((await t.api.del(`/api/rentals/${ids.room}`)).status).toBe(409);
    expect((await t.api.del(`/api/rentals/${ids.room}?force=1`)).status).toBe(200);
    expect(t.app.db.get('SELECT 1 FROM rental_bookings WHERE rental_id = ?', ids.room)).toBeUndefined();
  });
});

describe('agent / MCP', () => {
  const caller = { agency: false, api: async (method: string, path: string, o: { body?: unknown } = {}) => {
    const r = method === 'GET' ? await t.api.get(path) : await t.api.post(path, o.body);
    if (r.status >= 400) throw new Error(r.data.error);
    return r.data;
  } } as any;
  const tool = (name: string) => RENTAL_TOOLS.find((x) => x.name === name)!;

  it('reads freely, books only after a confirmation (like the other booking tools)', () => {
    expect(classify(tool('ghl_rental_availability'))).toBe('read');
    expect(classify(tool('ghl_rental_book'))).toBe('sensitive');
    expect(classify(tool('ghl_rental_save'))).toBe('write');
    expect((t.app.services.mcpTools as any[]).some((x) => x.name === 'ghl_rental_book')).toBe(true);
  });

  it('lists items, gives free days and a quote, and books', async () => {
    const list = await tool('ghl_rental_availability').run(caller, { location_id: t.api.location });
    expect((list as any).rentals.map((r: any) => r.name)).toContain('E-Bike');
    const one = (await tool('ghl_rental_availability').run(caller, { location_id: t.api.location, rental_id: ids.bikes, from: '2027-03-10', to: '2027-03-11', qty: 1 })) as any;
    expect(one.availability.days[0]).toEqual({ date: '2027-03-10', free: 1 });
    expect(one.quote).toMatchObject({ ok: true, units: 2, free: 1 });
    const booked = (await tool('ghl_rental_book').run(caller, { location_id: t.api.location, rental_id: ids.bikes, from: '2027-03-10', days: 1, email: 'agent-kunde@example.com', first_name: 'Agnes' })) as any;
    expect(booked.status).toBe('confirmed');
    expect(booked.manage_url).toContain('/book/manage/');
    await expect(tool('ghl_rental_book').run(caller, { location_id: t.api.location, rental_id: ids.bikes, from: '2027-03-10', days: 1, email: 'agent-kunde2@example.com' })).rejects.toThrow(/nichts mehr frei/);
  });
});
