import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinClock, startTestApp, unpinClock } from './helpers.js';
import { client } from './security-fixtures.js';
import { today } from '../server/services/bo-common.js';

/**
 * "Today" is the sub-account's calendar day, not the UTC date: at 00:30 in Berlin on the 1st of a month the UTC date is still the
 * last day of the previous month. All instants are in the past so sessions created before pinning stay valid.
 */
const SEP_1_0030_BERLIN = '2026-08-31T22:30:00Z';

let t: Awaited<ReturnType<typeof startTestApp>>;
let berlin = '';
let la = '';
const at = async <T>(iso: string, fn: () => Promise<T> | T): Promise<T> => {
  pinClock(iso);
  try {
    return await fn();
  } finally {
    unpinClock();
  }
};
const header = async (path: string, name: string) => (await t.api.raw(`${path}${path.includes('?') ? '&' : '?'}locationId=${berlin}`, { headers: { cookie: t.api.cookie } })).headers.get(name) ?? '';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  berlin = t.api.location;
  la = (await t.api.post('/api/locations', { name: 'Westfirma', timezone: 'America/Los_Angeles' })).data.id;
});
afterAll(async () => {
  unpinClock();
  await t.close();
});

describe('today() of the Back-Office helpers', () => {
  it('is 1 September in Berlin and still 31 August in Los Angeles at 00:30 Berlin time', async () => {
    await at(SEP_1_0030_BERLIN, () => {
      expect(new Date().toISOString().slice(0, 10)).toBe('2026-08-31');
      expect(today(t.app, berlin)).toBe('2026-09-01');
      expect(today(t.app, la)).toBe('2026-08-31');
    });
  });
});

describe('HR uses the sub-account day', () => {
  let emp: any;
  let staff: { id: string; call: ReturnType<typeof client> };

  beforeAll(async () => {
    const u = await t.api.post('/api/users', { email: 'nora@example.com', name: 'nora', password: 'geheim-12345', role: 'member', locations: [berlin], permissions: [] });
    expect(u.status, JSON.stringify(u.data)).toBe(200);
    const call = client(t.base, { 'x-pghl': '1', 'x-location-id': berlin });
    expect((await call('POST', '/api/auth/login', { email: 'nora@example.com', password: 'geheim-12345' })).status).toBe(200);
    staff = { id: u.data.id, call };
    emp = (await t.api.post('/api/hr/employees', { first_name: 'Nora', last_name: 'Nacht', start_date: '2020-01-01', user_id: staff.id })).data;
    expect(emp.id).toBeTruthy();
  });

  it('counts an absence on the 1st as "away today", starts the calendar on the 1st and rejects vacation on the 31st as past', async () => {
    const a = await t.api.post('/api/hr/absences', { employee_id: emp.id, type: 'other', label: 'Arzttermin', start_date: '2026-09-01' });
    expect(a.status, JSON.stringify(a.data)).toBe(200);
    if (a.data.status !== 'approved') expect((await t.api.post(`/api/hr/absences/${a.data.id}/approve`, {})).status).toBe(200);
    await at(SEP_1_0030_BERLIN, async () => {
      expect((await t.api.get('/api/hr/status')).data.away_today).toEqual({ other: 1 });
      expect((await t.api.get('/api/hr/calendar')).data.from).toBe('2026-09-01');
      const past = await staff.call('POST', '/api/me/hr/absences', { type: 'vacation', start_date: '2026-08-31' });
      expect(past.status).toBe(400);
      expect(past.data.error).toMatch(/Vergangenheit/);
    });
  });

  it('forfeits carry-over from 1 April 00:30 Berlin time (UTC still says 31 March)', async () => {
    expect((await t.api.put(`/api/hr/employees/${emp.id}/leave-years/2026`, { carryover_days: 5 })).status).toBe(200);
    await at('2026-03-31T22:30:00Z', async () => {
      const b = (await t.api.get(`/api/hr/employees/${emp.id}/balance?year=2026`)).data.balance;
      expect(b).toMatchObject({ carryover: 5, carryover_expires: '2026-03-31', carryover_forfeited: 5 });
    });
    await at('2026-03-31T21:30:00Z', async () => {
      expect((await t.api.get(`/api/hr/employees/${emp.id}/balance?year=2026`)).data.balance.carryover_forfeited).toBe(0);
    });
  });

  it('takes the default year from the sub-account day on New Year at 00:30', async () => {
    await at('2025-12-31T23:30:00Z', async () => {
      expect((await t.api.get('/api/hr/holidays')).data.year).toBe(2026);
      expect((await t.api.get(`/api/hr/employees/${emp.id}/balance`)).data.year).toBe(2026);
    });
  });
});

describe('affiliate payouts use the sub-account day', () => {
  it('payout reference month, CSV name and SEPA execution date (the next day in Berlin)', async () => {
    const program = (await t.api.post('/api/affiliates/programs', { name: 'Nachtprogramm', commission_type: 'percent', commission_value: 10, payout_threshold_cents: 1000 })).data;
    const aff = (await t.api.post('/api/affiliates', { program_id: program.id, name: 'Nina Nacht', email: 'nina@partner.example', iban: 'DE89 3704 0044 0532 0130 00' })).data;
    expect((await t.api.post('/api/affiliates/commissions', { affiliate_id: aff.id, amount_cents: 5000, note: 'Bonus' })).status).toBe(200);
    const l = t.app.location(berlin)!;
    t.app.db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify({ ...l.settings, invoices: { ...(l.settings.invoices ?? {}), iban: 'AT611904300234573201', bic: 'BKAUATWW' } }), berlin);
    await at(SEP_1_0030_BERLIN, async () => {
      const r = (await t.api.post('/api/affiliates/payouts', {})).data;
      expect(r.created[0].reference).toContain(' 2026-09 ');
      expect(await header('/api/affiliates/payouts/export.csv', 'content-disposition')).toContain('affiliate-auszahlungen-2026-09-01.csv');
      const res = await t.api.raw(`/api/affiliates/payouts/sepa.xml?locationId=${berlin}`, { headers: { cookie: t.api.cookie } });
      expect(res.headers.get('content-disposition')).toContain('sepa-affiliates-2026-09-02.xml');
      expect(await res.text()).toContain('2026-09-02');
    });
  });
});

describe('Back-Office "as of" defaults use the sub-account day', () => {
  it('open items and the stock valuation export default to 1 September', async () => {
    expect((await t.api.post('/api/accounting/setup', { standard: 'skr03' })).status).toBe(200);
    await at(SEP_1_0030_BERLIN, async () => {
      expect((await t.api.get('/api/accounting/reports/open-items?type=receivable')).data.asof).toBe('2026-09-01');
      expect(await header('/api/inventory/valuation?format=csv', 'content-disposition')).toContain('Lagerbewertung_2026-09-01.csv');
    });
  });
});
