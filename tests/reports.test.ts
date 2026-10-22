import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import type { Db } from '../server/core/db.js';
import {
  bucketKey,
  bucketLabel,
  bucketsBetween,
  buildSql,
  deltaPercent,
  formatValue,
  isoWeek,
  localParts,
  normalizeQuery,
  resolveRange,
  runReport,
  toCsv,
  type ReportSource,
} from '../server/services/report-engine.js';
import { withLocationField } from '../server/services/report-sources.js';
import { nextRun, renderReportEmail } from '../server/services/report-email.js';
import { packWidgets } from '../server/services/report-templates.js';

const NOW = new Date('2026-04-15T10:00:00Z');
const TZ = 'Europe/Berlin';

describe('report engine: ranges and buckets', () => {
  it('resolves relative ranges in the sub-account time zone, with the previous period', () => {
    const r7 = resolveRange('last_7_days', TZ, NOW);
    expect(r7.current).toMatchObject({ fromYmd: '2026-04-09', toYmd: '2026-04-16', label: 'Letzte 7 Tage' });
    expect(r7.current.from).toBe('2026-04-08T22:00:00.000Z'); // midnight in Berlin (CEST)
    expect(r7.previous).toMatchObject({ fromYmd: '2026-04-02', toYmd: '2026-04-09' });
    // "Dieser Monat" = month to date, compared with the same days of last month.
    const m = resolveRange('this_month', TZ, NOW);
    expect(m.current).toMatchObject({ fromYmd: '2026-04-01', toYmd: '2026-04-16', label: 'Dieser Monat' });
    expect(m.previous).toMatchObject({ fromYmd: '2026-03-01', toYmd: '2026-03-16' });
    expect(resolveRange('last_month', TZ, NOW).current).toMatchObject({ fromYmd: '2026-03-01', toYmd: '2026-04-01' });
    expect(resolveRange('last_month', TZ, NOW).current.from).toBe('2026-02-28T23:00:00.000Z'); // CET
    expect(resolveRange('this_quarter', TZ, NOW).current.fromYmd).toBe('2026-04-01');
    expect(resolveRange('last_quarter', TZ, NOW).previous).toMatchObject({ fromYmd: '2025-10-01', toYmd: '2026-01-01' });
    expect(resolveRange('this_week', TZ, NOW).current.fromYmd).toBe('2026-04-13'); // Monday
    expect(resolveRange('last_12_months', TZ, NOW).current.fromYmd).toBe('2025-05-01');
    expect(resolveRange('all', TZ, NOW)).toEqual({ current: expect.objectContaining({ from: null, to: null }), previous: null });
    const custom = resolveRange({ from: '2026-04-01', to: '2026-04-15' }, TZ, NOW);
    expect(custom.current).toMatchObject({ fromYmd: '2026-04-01', toYmd: '2026-04-16', dates: '01.04.2026 – 15.04.2026' });
    expect(custom.previous).toMatchObject({ fromYmd: '2026-03-17', toYmd: '2026-04-01' });
    expect(() => resolveRange('gestern-irgendwann', TZ, NOW)).toThrow('Unbekannter Zeitraum');
    expect(() => resolveRange({ from: '2026-05-01', to: '2026-04-01' }, TZ, NOW)).toThrow();
  });

  it('buckets timestamps by local day/week/month/quarter/weekday/hour across DST', () => {
    // 23:30 UTC on 28 March is already the 29th in Berlin; 21:30 UTC in April is 23:30 CEST.
    expect(localParts('2026-03-28T23:30:00.000Z', TZ)).toEqual([2026, 3, 29, 0]);
    expect(localParts('2026-04-14T21:30:00.000Z', TZ)).toEqual([2026, 4, 14, 23]);
    expect(localParts('2026-04-14', 'America/New_York')).toEqual([2026, 4, 14, 0]);
    expect(localParts('kaputt', TZ)).toBeNull();
    expect(bucketKey(2026, 4, 15, 9, 'week')).toBe('2026-04-13');
    expect(bucketKey(2026, 4, 15, 9, 'month')).toBe('2026-04');
    expect(bucketKey(2026, 11, 2, 9, 'quarter')).toBe('2026-Q4');
    expect(bucketKey(2026, 4, 19, 9, 'weekday')).toBe('7');
    expect(bucketKey(2026, 4, 19, 9, 'hour')).toBe('09');
    expect(bucketLabel('2026-10', 'month')).toBe('Okt 2026');
    expect(bucketLabel('2026-04-13', 'week')).toBe('KW 16/2026');
    expect(bucketLabel('1', 'weekday')).toBe('Mo');
    expect(bucketLabel('14', 'hour')).toBe('14 Uhr');
    expect(isoWeek('2026-01-01')).toEqual({ week: 1, year: 2026 });
    expect(isoWeek('2027-01-01')).toEqual({ week: 53, year: 2026 });
    expect(bucketsBetween('2026-01-15', '2026-04-02', 'month')).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(bucketsBetween('2026-04-01', '2026-04-16', 'week')).toEqual(['2026-03-30', '2026-04-06', '2026-04-13']);
    expect(bucketsBetween('2025-12-01', '2026-07-01', 'quarter')).toEqual(['2025-Q4', '2026-Q1', '2026-Q2']);
    expect(bucketsBetween('2026-04-01', '2026-04-02', 'hour')).toHaveLength(24);
  });

  it('formats values the German way and computes deltas', () => {
    const sp = (x: string) => x.replace(/\s/g, ' ');
    expect(sp(formatValue(1234.5, 'money'))).toBe('1.235 €');
    expect(sp(formatValue(99.5, 'money'))).toBe('99,50 €');
    expect(formatValue(33.333, 'percent')).toBe('33,3 %');
    expect(formatValue(15, 'days')).toBe('15 Tage');
    expect(formatValue(12345, 'number')).toBe('12.345');
    expect(formatValue(null, 'number')).toBe('–');
    expect(deltaPercent(150, 100)).toBe(50);
    expect(deltaPercent(5, 0)).toBeNull();
  });

  it('packs template widgets into the 12-column grid and computes schedule times', () => {
    expect(packWidgets([{ w: 3, h: 2 }, { w: 3, h: 2 }, { w: 3, h: 2 }, { w: 3, h: 2 }, { w: 6, h: 4 }, { w: 6, h: 4 }])).toEqual([
      { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 6, y: 0 }, { x: 9, y: 0 }, { x: 0, y: 2 }, { x: 6, y: 2 },
    ]);
    // Weekly on Monday 08:00 Berlin, from Wednesday 15 April.
    expect(nextRun({ frequency: 'weekly', weekday: 1, monthday: 1, hour: 8 }, TZ, NOW).toISOString()).toBe('2026-04-20T06:00:00.000Z');
    expect(nextRun({ frequency: 'daily', weekday: 1, monthday: 1, hour: 8 }, TZ, NOW).toISOString()).toBe('2026-04-16T06:00:00.000Z');
    expect(nextRun({ frequency: 'daily', weekday: 1, monthday: 1, hour: 14 }, TZ, NOW).toISOString()).toBe('2026-04-15T12:00:00.000Z');
    expect(nextRun({ frequency: 'monthly', weekday: 1, monthday: 1, hour: 7 }, TZ, NOW).toISOString()).toBe('2026-05-01T05:00:00.000Z');
  });
});

// --- fixtures -------------------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let locA = '';
let locB = '';
let adminId = '';
let db: Db;
let sources: ReportSource[];

const ins = (table: string, row: Record<string, unknown>) => db.insert(table, row);
const ts = (s: string) => new Date(s).toISOString();

function seed(loc: string, p: string) {
  const c = (n: number, source: string, created: string, extra: Record<string, unknown> = {}) =>
    ins('contacts', { id: `${p}c${n}`, location_id: loc, first_name: `Kontakt${n}`, last_name: p, source, created_at: ts(created), updated_at: ts(created), ...extra });
  c(1, 'Google', '2026-03-02T09:00:00Z', { tags: '["vip"]', email: `c1${p}@x.de` });
  c(2, 'Google', '2026-03-28T23:30:00Z');
  c(3, 'Facebook', '2026-04-01T10:00:00Z');
  c(4, '', '2026-04-10T10:00:00Z');
  c(5, 'Google', '2026-04-14T21:30:00Z', { assigned_to: adminId });
  c(6, 'Empfehlung', '2026-01-10T10:00:00Z');

  ins('pipelines', { id: `${p}pipe`, location_id: loc, name: 'Vertrieb', created_at: ts('2026-01-01T00:00:00Z'), stages: JSON.stringify([{ id: `${p}s1`, name: 'Neu', probability: 10 }, { id: `${p}s2`, name: 'Angebot', probability: 60 }, { id: `${p}s3`, name: 'Verhandlung' }]) });
  const o = (n: number, stage: string, status: string, value: number, created: string, closed: string | null, contact: number) =>
    ins('opportunities', { id: `${p}o${n}`, location_id: loc, pipeline_id: `${p}pipe`, stage_id: `${p}${stage}`, contact_id: `${p}c${contact}`, name: `Deal ${n}`, value, status, assigned_to: n % 2 ? adminId : null, created_at: ts(created), updated_at: ts(closed ?? created), closed_at: closed ? ts(closed) : null });
  o(1, 's1', 'open', 1000, '2026-03-05T10:00:00Z', null, 1);
  o(2, 's2', 'open', 2000, '2026-03-10T10:00:00Z', null, 2);
  o(3, 's3', 'open', 4000, '2026-03-15T10:00:00Z', null, 3);
  o(4, 's3', 'won', 5000, '2026-03-01T10:00:00Z', '2026-03-11T10:00:00Z', 4);
  o(5, 's2', 'won', 3000, '2026-03-20T10:00:00Z', '2026-04-09T10:00:00Z', 1);
  o(6, 's1', 'lost', 800, '2026-03-02T10:00:00Z', '2026-03-12T10:00:00Z', 2);

  ins('tasks', { id: `${p}t1`, location_id: loc, title: 'Anrufen', assigned_to: adminId, done: 1, created_at: ts('2026-04-01T08:00:00Z'), completed_at: ts('2026-04-02T08:00:00Z') });
  ins('tasks', { id: `${p}t2`, location_id: loc, title: 'Angebot', assigned_to: adminId, done: 0, due_at: ts('2026-04-10T08:00:00Z'), created_at: ts('2026-04-03T08:00:00Z') });
  ins('tasks', { id: `${p}t3`, location_id: loc, title: 'Später', done: 0, due_at: ts('2099-01-01T08:00:00Z'), created_at: ts('2026-04-04T08:00:00Z') });

  ins('calendars', { id: `${p}cal`, location_id: loc, name: 'Beratung', slug: `beratung-${p}`, created_at: ts('2026-01-01T00:00:00Z') });
  const a = (n: number, status: string, start: string) => ins('appointments', { id: `${p}a${n}`, location_id: loc, calendar_id: `${p}cal`, contact_id: `${p}c1`, title: 'Termin', start_at: ts(start), end_at: new Date(new Date(start).getTime() + 30 * 60000).toISOString(), status, manage_token: `${p}tok${n}`, created_at: ts('2026-03-30T08:00:00Z') });
  a(1, 'showed', '2026-04-02T08:00:00Z');
  a(2, 'noshow', '2026-04-03T08:00:00Z');
  a(3, 'showed', '2026-04-06T12:00:00Z');
  a(4, 'cancelled', '2026-04-07T08:00:00Z');
  a(5, 'blocked', '2026-04-08T08:00:00Z');

  ins('conversations', { id: `${p}conv`, location_id: loc, contact_id: `${p}c1`, last_message_at: ts('2026-04-05T08:00:00Z'), created_at: ts('2026-04-02T08:00:00Z') });
  const m = (n: number, channel: string, direction: string, at: string, extra: Record<string, unknown> = {}) =>
    ins('messages', { id: `${p}m${n}`, location_id: loc, conversation_id: `${p}conv`, contact_id: `${p}c1`, channel, direction, body: 'Hallo', status: direction === 'in' ? 'received' : 'sent', created_at: ts(at), ...extra });
  m(1, 'email', 'out', '2026-04-02T08:00:00Z', { opened_at: ts('2026-04-02T09:00:00Z'), user_id: adminId });
  m(2, 'email', 'out', '2026-04-03T08:00:00Z');
  m(3, 'sms', 'in', '2026-04-03T09:00:00Z');
  m(4, 'whatsapp', 'in', '2026-04-05T08:00:00Z');
  m(5, 'email', 'out', '2026-04-05T09:00:00Z', { status: 'draft' });

  const k = (n: number, direction: string, answered: number, duration: number, at: string) => ins('calls', { id: `${p}k${n}`, location_id: loc, direction, status: answered ? 'completed' : 'missed', answered, duration, user_id: n === 1 ? adminId : null, started_at: ts(at), updated_at: ts(at) });
  k(1, 'in', 1, 120, '2026-04-02T08:00:00Z');
  k(2, 'in', 0, 0, '2026-04-03T08:00:00Z');
  k(3, 'out', 1, 300, '2026-04-04T08:00:00Z');

  const inv = (n: number, status: string, total: number, items: unknown[], extra: Record<string, unknown>) =>
    ins('invoices', { id: `${p}i${n}`, location_id: loc, kind: 'invoice', number: `RE-${n}`, items: JSON.stringify(items), subtotal_cents: Math.round(total / 1.19), tax_cents: total - Math.round(total / 1.19), total_cents: total, status, public_token: `${p}pt${n}`, issued_at: ts('2026-04-01T08:00:00Z'), created_at: ts('2026-04-01T08:00:00Z'), updated_at: ts('2026-04-01T08:00:00Z'), ...extra });
  inv(1, 'paid', 11900, [{ name: 'Website', qty: 1, price_cents: 10000 }], { paid_at: ts('2026-04-03T08:00:00Z') });
  inv(2, 'sent', 5950, [{ name: 'Hosting', qty: 2, price_cents: 2500 }], { issued_at: ts('2026-04-05T08:00:00Z'), due_at: ts('2026-04-20T08:00:00Z') });
  inv(3, 'paid', 23800, [{ name: 'Website', qty: 2, price_cents: 10000 }], { paid_at: ts('2026-04-10T08:00:00Z') });
  inv(4, 'draft', 2000, [{ name: 'Wartung', qty: 1, price_cents: 1681 }], { recurring: JSON.stringify({ interval: 'month', active: true, next_at: ts('2026-05-01T08:00:00Z'), end_at: null }) });
  inv(5, 'draft', 12000, [{ name: 'Lizenz', qty: 1, price_cents: 10084 }], { recurring: JSON.stringify({ interval: 'year', active: true, next_at: ts('2027-01-01T08:00:00Z'), end_at: null }) });
  inv(6, 'draft', 5000, [{ name: 'Alt', qty: 1, price_cents: 4202 }], { recurring: JSON.stringify({ interval: 'month', active: false, next_at: ts('2026-05-01T08:00:00Z'), end_at: null }) });

  ins('campaigns', { id: `${p}cp`, location_id: loc, name: 'Frühling', channel: 'email', status: 'sent', sent_at: ts('2026-04-02T08:00:00Z'), created_at: ts('2026-04-01T08:00:00Z'), updated_at: ts('2026-04-02T08:00:00Z') });
  ins('campaign_recipients', { campaign_id: `${p}cp`, contact_id: `${p}c1`, status: 'sent', message_id: `${p}m1`, sent_at: ts('2026-04-02T08:00:00Z') });
  ins('campaign_recipients', { campaign_id: `${p}cp`, contact_id: `${p}c2`, status: 'sent', message_id: `${p}m2`, sent_at: ts('2026-04-02T08:00:00Z') });
  ins('campaign_recipients', { campaign_id: `${p}cp`, contact_id: `${p}c3`, status: 'failed', sent_at: ts('2026-04-02T08:00:00Z') });

  ins('forms', { id: `${p}f`, location_id: loc, name: 'Kontakt', created_at: ts('2026-01-01T00:00:00Z'), updated_at: ts('2026-01-01T00:00:00Z') });
  for (const [n, cn] of [[1, 1], [2, 3], [3, 6]]) ins('form_submissions', { id: `${p}fs${n}`, location_id: loc, form_id: `${p}f`, contact_id: `${p}c${cn}`, created_at: ts(`2026-04-0${n}T08:00:00Z`) });

  ins('attribution_touches', { id: `${p}at1`, location_id: loc, visitor_id: 'v1', kind: 'visit', channel: 'campaign', source: 'google', created_at: ts('2026-04-01T08:00:00Z') });
  ins('attribution_touches', { id: `${p}at2`, location_id: loc, visitor_id: 'v1', contact_id: `${p}c1`, kind: 'form', channel: 'campaign', source: 'google', created_at: ts('2026-04-01T08:05:00Z') });
  ins('attribution_touches', { id: `${p}at3`, location_id: loc, visitor_id: 'v2', kind: 'visit', channel: 'direct', source: 'direct', created_at: ts('2026-04-02T08:00:00Z') });

  ins('affiliate_programs', { id: `${p}ap`, location_id: loc, name: 'Partner', slug: `partner-${p}`, created_at: ts('2026-01-01T00:00:00Z'), updated_at: ts('2026-01-01T00:00:00Z') });
  ins('affiliates', { id: `${p}af`, location_id: loc, program_id: `${p}ap`, name: 'Anna', email: `anna${p}@x.de`, code: `anna${p}`, created_at: ts('2026-01-01T00:00:00Z'), updated_at: ts('2026-01-01T00:00:00Z') });
  ins('affiliate_commissions', { id: `${p}ac1`, location_id: loc, program_id: `${p}ap`, affiliate_id: `${p}af`, invoice_id: `${p}i1`, amount_cents: 1000, status: 'pending', created_at: ts('2026-04-03T08:00:00Z') });
  ins('affiliate_commissions', { id: `${p}ac2`, location_id: loc, program_id: `${p}ap`, affiliate_id: `${p}af`, invoice_id: `${p}i3`, amount_cents: 2500, status: 'approved', created_at: ts('2026-04-10T08:00:00Z') });

  ins('courses', { id: `${p}co`, location_id: loc, title: 'Kurs', slug: `kurs-${p}`, created_at: ts('2026-01-01T00:00:00Z'), updated_at: ts('2026-01-01T00:00:00Z') });
  ins('course_enrollments', { id: `${p}ce1`, location_id: loc, course_id: `${p}co`, contact_id: `${p}c1`, enrolled_at: ts('2026-04-01T08:00:00Z'), started_at: ts('2026-04-01T09:00:00Z'), completed_at: ts('2026-04-05T09:00:00Z'), created_at: ts('2026-04-01T08:00:00Z') });
  ins('course_enrollments', { id: `${p}ce2`, location_id: loc, course_id: `${p}co`, contact_id: `${p}c2`, enrolled_at: ts('2026-04-02T08:00:00Z'), started_at: ts('2026-04-02T09:00:00Z'), created_at: ts('2026-04-02T08:00:00Z') });
}

/** Runs a report directly on the engine (fixed "now"), only for sub-account A unless told otherwise. */
const rep = (q: Record<string, unknown>, locations = [locA]) => runReport({ db, sources, locations, tz: TZ, now: NOW }, { range: 'all', ...q });
const APRIL = { from: '2026-04-01', to: '2026-04-30' };

beforeAll(async () => {
  t = await startTestApp();
  const me = await t.setup();
  adminId = me.user.id;
  locA = t.api.location;
  locB = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
  db = t.app.db;
  sources = (t.app.services.reportSources as ReportSource[]).map(withLocationField);
  seed(locA, 'A');
  seed(locB, 'B');
});
afterAll(() => t.close());

describe('report sources', () => {
  it('compiles every field, group, filter and measure of every source', () => {
    const sample: Record<string, (f: any) => unknown> = {
      string: () => ({ op: 'eq', value: 'x' }),
      enum: (f) => ({ op: 'in', value: Object.keys(f.options ?? { x: 1 }).slice(0, 2) }),
      number: () => ({ op: 'between', value: [0, 1e9] }),
      date: () => ({ op: 'in_range', value: 'last_90_days' }),
      boolean: () => ({ op: 'is_true' }),
      tags: () => ({ op: 'has', value: 'vip' }),
    };
    let runs = 0;
    for (const s of sources) {
      const base = { source: s.key };
      expect(() => rep(base, [locA, locB]), s.key).not.toThrow();
      for (const f of s.fields) {
        const flt = sample[f.type](f) as any;
        expect(() => rep({ ...base, filters: [{ field: f.key, ...flt }] }), `${s.key}.${f.key} filter`).not.toThrow();
        if (f.type === 'number') for (const agg of ['sum', 'avg', 'min', 'max']) expect(() => rep({ ...base, measures: [`${agg}:${f.key}`] }), `${s.key}.${f.key} ${agg}`).not.toThrow();
        else if (f.type !== 'tags' && !f.noGroup) {
          expect(() => rep({ ...base, group_by: [f.type === 'date' ? `${f.key}:week` : f.key], measures: ['count', `count_distinct:${f.key}`] }), `${s.key}.${f.key} group`).not.toThrow();
        }
        runs++;
      }
      for (const c of s.calcs ?? []) expect(() => rep({ ...base, measures: [`calc:${c.key}`], group_by: ['location'], compare: true, range: 'last_30_days' }), `${s.key} calc:${c.key}`).not.toThrow();
    }
    expect(sources.length).toBeGreaterThanOrEqual(15);
    expect(runs).toBeGreaterThan(100);
  });

  it('counts contacts per source, fills empty days and compares with the previous period', () => {
    const bySource = rep({ source: 'contacts', group_by: ['source'], range: { from: '2026-03-01', to: '2026-04-30' } });
    expect(bySource.rows.map((r) => [r.l[0], r.v[0]])).toEqual([['Google', 3], ['Facebook', 1], ['Unbekannt', 1]]);
    expect(bySource.totals.v).toEqual([5]);

    const days = rep({ source: 'contacts', group_by: ['created_at:day'], range: { from: '2026-03-28', to: '2026-03-30' } });
    expect(days.rows.map((r) => [r.k[0], r.v[0]])).toEqual([['2026-03-28', 0], ['2026-03-29', 1], ['2026-03-30', 0]]);
    expect(days.axis?.map((a) => a.l)).toEqual(['28.03.2026', '29.03.2026', '30.03.2026']);

    const cmp = rep({ source: 'contacts', range: { from: '2026-04-01', to: '2026-04-15' }, compare: true });
    expect(cmp.totals).toEqual({ v: [3], p: [1] });
    expect(cmp.previous?.dates).toBe('17.03.2026 – 31.03.2026');

    const weekly = rep({ source: 'contacts', group_by: ['created_at:week'], range: { from: '2026-04-01', to: '2026-04-15' }, compare: true });
    // KW 16 holds c5 (23:30 local on the 14th); week n is compared with week n of the period before (KW 13 holds c2, local 29.03.).
    expect(weekly.rows.map((r) => [r.l[0], r.v[0], r.p?.[0]])).toEqual([['KW 14/2026', 1, 0], ['KW 15/2026', 1, 1], ['KW 16/2026', 1, 0]]);
  });

  it('reports pipeline value per stage, win rate, weighted forecast and deal velocity', () => {
    const funnel = rep({ source: 'opportunities', measures: ['sum:value'], group_by: ['stage'], filters: [{ field: 'status', op: 'eq', value: 'open' }] });
    expect(funnel.rows.map((r) => [r.l[0], r.v[0]])).toEqual([['Neu', 1000], ['Angebot', 2000], ['Verhandlung', 4000]]);
    const kpis = rep({ source: 'opportunities', measures: ['calc:open_value', 'calc:forecast', 'calc:win_rate', 'calc:velocity', 'calc:won_value'] });
    // 1000×10 % + 2000×60 % + 4000×75 % (default for the 3rd of 3 stages).
    expect(kpis.totals.v[0]).toBe(7000);
    expect(kpis.totals.v[1]).toBeCloseTo(4300);
    expect(kpis.totals.v[2]).toBeCloseTo(66.667, 2);
    expect(kpis.totals.v[3]).toBeCloseTo(15);
    expect(kpis.totals.v[4]).toBe(8000);
    expect(kpis.measures.map((m) => m.format)).toEqual(['money', 'money', 'percent', 'days', 'money']);
    const marchClosed = rep({ source: 'opportunities', measures: ['calc:win_rate'], date_field: 'closed_at', range: { from: '2026-03-01', to: '2026-03-31' } });
    expect(marchClosed.totals.v[0]).toBe(50);
    const byStatus = rep({ source: 'opportunities', group_by: ['status'] });
    expect(byStatus.rows.map((r) => r.l[0])).toEqual(['Offen', 'Gewonnen', 'Verloren']);
    const owner = rep({ source: 'opportunities', group_by: ['assigned_to'], measures: ['count'] });
    expect(owner.rows.map((r) => [r.l[0], r.v[0]])).toEqual([['Chef', 3], ['Nicht zugewiesen', 3]]);
    const stacked = rep({ source: 'opportunities', group_by: ['stage', 'status'], measures: ['count'] });
    expect(stacked.rows.map((r) => r.l.join('/'))).toEqual(['Neu/Offen', 'Neu/Verloren', 'Angebot/Offen', 'Angebot/Gewonnen', 'Verhandlung/Offen', 'Verhandlung/Gewonnen']);
    const contactSource = rep({ source: 'opportunities', group_by: ['contact_source'], measures: ['sum:value'] });
    expect(contactSource.rows[0]).toMatchObject({ l: ['Google'], v: [6800] });
  });

  it('covers tasks, appointments, messages, calls, invoices, products, MRR, campaigns, forms, attribution, affiliates and courses', () => {
    expect(rep({ source: 'tasks', measures: ['calc:completion_rate', 'calc:open_count'] }).totals.v[0]).toBeCloseTo(33.33, 1);
    expect(rep({ source: 'tasks', group_by: ['assigned_to', 'done'] }).rows.map((r) => [...r.l, r.v[0]])).toEqual([['Chef', 'Offen', 1], ['Chef', 'Erledigt', 1], ['Nicht zugewiesen', 'Offen', 1]]);
    expect(rep({ source: 'tasks', filters: [{ field: 'overdue', op: 'is_true' }] }).totals.v[0]).toBe(1);

    const appts = rep({ source: 'appointments', measures: ['count', 'calc:no_show_rate', 'calc:cancel_rate'], range: APRIL });
    expect(appts.totals.v[0]).toBe(4); // the blocked slot is no appointment
    expect(appts.totals.v[1]).toBeCloseTo(33.33, 1);
    expect(appts.totals.v[2]).toBe(25);
    const heat = rep({ source: 'appointments', group_by: ['start_at:weekday', 'start_at:hour'], range: APRIL });
    expect(heat.rows.find((r) => r.k[0] === '4' && r.k[1] === '10')).toMatchObject({ l: ['Do', '10 Uhr'], v: [1] }); // 08:00Z = 10:00 CEST
    expect(heat.axis).toHaveLength(7);

    const msgs = rep({ source: 'messages', group_by: ['channel'], measures: ['count', 'calc:open_rate'], range: APRIL });
    expect(msgs.rows.map((r) => [r.l[0], r.v[0]])).toEqual([['E-Mail', 2], ['SMS', 1], ['WhatsApp', 1]]);
    expect(msgs.totals.v[1]).toBe(50);
    expect(rep({ source: 'messages', group_by: ['direction'] }).rows.map((r) => [r.l[0], r.v[0]])).toEqual([['Eingehend', 2], ['Ausgehend', 2]]);
    expect(rep({ source: 'conversations', measures: ['count'] }).totals.v[0]).toBe(1);

    const calls = rep({ source: 'calls', measures: ['calc:answer_rate', 'calc:minutes', 'calc:missed'] });
    expect(calls.totals.v[0]).toBeCloseTo(66.67, 1);
    expect(calls.totals.v[1]).toBe(7);
    expect(calls.totals.v[2]).toBe(1);

    const inv = rep({ source: 'invoices', measures: ['calc:paid_amount', 'calc:open_amount'], date_field: 'paid_at', range: APRIL });
    expect(inv.totals.v[0]).toBe(357);
    expect(rep({ source: 'invoices', measures: ['calc:open_amount'] }).totals.v[0]).toBe(59.5);
    const products = rep({ source: 'invoice_items', group_by: ['product'], measures: ['calc:paid_revenue', 'sum:qty'], date_field: 'issued_at', range: APRIL });
    expect(products.rows[0]).toMatchObject({ l: ['Website'], v: [300, 3] });
    expect(products.rows.find((r) => r.l[0] === 'Hosting')?.v).toEqual([0, 2]);
    const mrr = rep({ source: 'subscriptions', measures: ['calc:mrr', 'calc:arr', 'calc:active_count'] });
    expect(mrr.totals.v).toEqual([30, 360, 2]);
    expect(rep({ source: 'subscriptions', group_by: ['interval'], measures: ['calc:mrr'] }).rows.map((r) => [r.l[0], r.v[0]])).toEqual([['Monatlich', 20], ['Jährlich', 10]]);

    const camp = rep({ source: 'campaigns', group_by: ['campaign'], measures: ['calc:sent', 'calc:opened', 'calc:open_rate'], range: APRIL });
    expect(camp.rows[0]).toMatchObject({ l: ['Frühling'], v: [2, 1, 50] });
    const forms = rep({ source: 'form_submissions', group_by: ['form'], measures: ['count', 'calc:deal_rate', 'calc:customer_rate'], range: APRIL });
    expect(forms.rows[0].l).toEqual(['Kontakt']);
    expect(forms.rows[0].v[0]).toBe(3);
    expect(forms.rows[0].v[1]).toBeCloseTo(66.67, 1);
    expect(forms.rows[0].v[2]).toBeCloseTo(33.33, 1);
    expect(rep({ source: 'attribution', measures: ['count', 'calc:visitors', 'calc:contacts'] }).totals.v).toEqual([3, 2, 1]);
    expect(rep({ source: 'affiliate_commissions', group_by: ['affiliate'], measures: ['sum:amount'] }).rows[0]).toMatchObject({ l: ['Anna'], v: [35] });
    expect(rep({ source: 'course_enrollments', measures: ['calc:completion_rate'] }).totals.v[0]).toBe(50);
  });

  it('applies filters with bound parameters only', () => {
    const n = (filters: unknown[], extra: Record<string, unknown> = {}) => rep({ source: 'contacts', filters, ...extra }).totals.v[0];
    expect(n([{ field: 'source', op: 'eq', value: 'Google' }])).toBe(3);
    expect(n([{ field: 'source', op: 'neq', value: 'Google' }])).toBe(3);
    expect(n([{ field: 'source', op: 'in', value: ['Google', 'Facebook'] }])).toBe(4);
    expect(n([{ field: 'source', op: 'not_in', value: ['Google'] }])).toBe(3);
    expect(n([{ field: 'source', op: 'contains', value: 'oog' }])).toBe(3);
    expect(n([{ field: 'source', op: 'contains', value: '%' }])).toBe(0);
    expect(n([{ field: 'source', op: 'starts_with', value: 'Fa' }])).toBe(1);
    expect(n([{ field: 'source', op: 'empty' }])).toBe(1);
    expect(n([{ field: 'tags', op: 'has', value: 'vip' }])).toBe(1);
    expect(n([{ field: 'tags', op: 'not_has', value: 'vip' }])).toBe(5);
    expect(n([{ field: 'has_email', op: 'is_true' }])).toBe(1);
    expect(n([{ field: 'has_opportunity', op: 'is_false' }])).toBe(2);
    expect(n([{ field: 'created_at', op: 'before', value: '2026-03-01' }])).toBe(1);
    expect(n([{ field: 'created_at', op: 'after', value: '2026-04-09' }])).toBe(2);
    expect(n([{ field: 'created_at', op: 'in_range', value: { from: '2026-04-01', to: '2026-04-30' } }])).toBe(3);
    expect(n([{ field: 'assigned_to', op: 'eq', value: adminId }])).toBe(1);
    expect(rep({ source: 'opportunities', filters: [{ field: 'value', op: 'gte', value: 3000 }] }).totals.v[0]).toBe(3);
    expect(rep({ source: 'opportunities', filters: [{ field: 'value', op: 'between', value: [900, 2500] }] }).totals.v[0]).toBe(2);
    // Injection attempts stay values.
    expect(n([{ field: 'source', op: 'eq', value: "x' OR '1'='1" }])).toBe(0);
    const { sql, params } = buildSql({ db, sources, locations: [locA], tz: TZ, now: NOW }, normalizeQuery({ source: 'contacts', filters: [{ field: 'source', op: 'eq', value: "x'; DROP TABLE contacts; --" }] }, sources, db), resolveRange('all', TZ).current, { grouped: false });
    expect(sql).not.toContain('DROP');
    expect(params).toContain("x'; DROP TABLE contacts; --");
    expect(() => rep({ source: 'contacts', filters: [{ field: 'c.id) OR (1', op: 'eq', value: 1 }] })).toThrow('Unbekanntes Feld');
    expect(() => rep({ source: 'contacts', group_by: ['source; DROP'] })).toThrow();
    expect(() => rep({ source: 'contacts', measures: ['sum:source'] })).toThrow('keine Zahl');
    expect(() => rep({ source: 'contacts', filters: [{ field: 'source', op: 'gt', value: 1 }] })).toThrow('passt nicht');
    expect(() => rep({ source: 'contacts', group_by: ['created_at:minute'] })).toThrow('Zeiteinheit');
    expect(() => rep({ source: 'nope' })).toThrow('Datenquelle');
    expect(() => rep({ source: 'contacts', measures: ['count', 'count', 'count', 'count', 'count', 'count', 'count'] })).toThrow('Höchstens');
  });

  it('scopes rows to the given sub-accounts, limits rows and exports CSV', () => {
    expect(rep({ source: 'contacts' }, [locA]).totals.v[0]).toBe(6);
    expect(rep({ source: 'contacts' }, [locA, locB]).totals.v[0]).toBe(12);
    expect(rep({ source: 'contacts' }, []).totals.v[0]).toBe(0);
    const perLoc = rep({ source: 'opportunities', group_by: ['location'], measures: ['calc:won_value'] }, [locA, locB]);
    expect(perLoc.rows.map((r) => r.l[0]).sort()).toEqual(['Testfirma', 'Zweitfirma']);
    const top = rep({ source: 'contacts', group_by: ['source'], limit: 2 });
    expect(top.rows).toHaveLength(2);
    expect(top.truncated).toBe(true);
    const csv = toCsv(rep({ source: 'opportunities', group_by: ['stage'], measures: ['sum:value', 'calc:win_rate'] }));
    expect(csv.startsWith('﻿Phase;Wert (Summe);Win-Rate\r\n')).toBe(true);
    expect(csv).toContain('Verhandlung;9000;100\r\n');
    expect(csv).toContain('Neu;1800;0\r\n');
  });

  it('stops queries that run too long', () => {
    for (let i = 0; i < 1200; i++) ins('contacts', { id: `bulk${i}`, location_id: locB, created_at: ts('2026-02-01T00:00:00Z'), updated_at: ts('2026-02-01T00:00:00Z') });
    expect(() => runReport({ db, sources, locations: [locB], tz: TZ, now: NOW, timeoutMs: -1 }, { source: 'contacts', range: 'all' })).toThrow('dauert zu lange');
    expect(runReport({ db, sources, locations: [locB], tz: TZ, now: NOW }, { source: 'contacts', range: 'all' }).totals.v[0]).toBe(1206);
    db.run(`DELETE FROM contacts WHERE id LIKE 'bulk%'`);
  });
});

describe('reports API', () => {
  const run = (body: unknown, h?: Record<string, string>) => t.api.post('/api/reports/run', body, h);

  it('lists sources with fields, operators and calculations', async () => {
    const r = await t.api.get('/api/reports/sources');
    expect(r.status).toBe(200);
    const opp = r.data.sources.find((s: any) => s.key === 'opportunities');
    expect(opp.fields.find((f: any) => f.key === 'stage')).toMatchObject({ label: 'Phase', groupable: true, lookup: true });
    expect(opp.fields.find((f: any) => f.key === 'value')).toMatchObject({ type: 'number', format: 'money', groupable: false });
    expect(opp.fields.find((f: any) => f.key === 'location')).toMatchObject({ label: 'Sub-Account' });
    expect(opp.calcs.map((c: any) => c.key)).toContain('forecast');
    expect(JSON.stringify(r.data)).not.toContain('SELECT');
    expect(r.data.ranges.this_month).toBe('Dieser Monat');
    expect(r.data.canAgency).toBe(true);
  });

  it('runs reports for one sub-account or the whole agency, with CSV and values', async () => {
    const one = await run({ query: { source: 'contacts', range: 'all' } });
    expect(one.status).toBe(200);
    expect(one.data.totals.v[0]).toBe(6);
    const all = await run({ query: { source: 'contacts', range: 'all', group_by: ['location'] }, scope: 'all' });
    expect(all.data.totals.v[0]).toBe(12);
    const only = await run({ query: { source: 'contacts', range: 'all' }, scope: 'all', location_ids: [locB] });
    expect(only.data.totals.v[0]).toBe(6);
    // Flat body (MCP style) works too.
    expect((await run({ source: 'opportunities', measures: ['calc:won_value'], range: 'all' })).data.totals.v[0]).toBe(8000);
    expect((await run({ query: { source: 'contacts', filters: [{ field: 'x', op: 'eq', value: 1 }] } })).status).toBe(400);
    const csv = await t.api.raw('/api/reports/export.csv', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': locA }, body: JSON.stringify({ name: 'Leads je Quelle', query: { source: 'contacts', group_by: ['source'], range: 'all' } }) });
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('Leads-je-Quelle.csv');
    expect(await csv.text()).toContain('Google;3');
    const vals = await t.api.get('/api/reports/values?source=opportunities&field=stage');
    expect(vals.data.map((v: any) => v.label)).toEqual(['Angebot', 'Neu', 'Verhandlung']);
    expect((await t.api.get('/api/reports/values?source=contacts&field=tags')).data).toEqual([{ value: 'vip', label: 'vip' }]);
  });

  it('keeps members inside their sub-accounts and areas; keys inside theirs', async () => {
    await t.api.post('/api/users', { email: 'team@x.de', name: 'Team', password: 'geheim12345', role: 'member', locations: [locA], permissions: ['dashboard', 'contacts', 'opportunities'] });
    const admin = t.api.cookie;
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'team@x.de', password: 'geheim12345' });
    const member = t.api.cookie;
    // Agency scope = only the member's own sub-accounts.
    expect((await run({ query: { source: 'contacts', range: 'all' }, scope: 'all' })).data.totals.v[0]).toBe(6);
    expect((await run({ query: { source: 'contacts', range: 'all' }, scope: 'all', location_ids: [locB] })).data.totals.v[0]).toBe(0);
    expect((await run({ query: { source: 'contacts', range: 'all' } }, { 'x-location-id': locB })).status).toBe(403);
    // Areas: no "Rechnungen" for this login.
    const inv = await run({ query: { source: 'invoices', range: 'all' } });
    expect(inv.status).toBe(403);
    expect(inv.data.error).toContain('Rechnungen');
    const srcs = (await t.api.get('/api/reports/sources')).data;
    expect(srcs.sources.map((s: any) => s.key)).not.toContain('invoices');
    expect(srcs.canAgency).toBe(false);
    // SaaS: a plan without the area blocks the source for customer logins.
    t.app.services.saasAreaBlocked = (loc: string, area: string) => loc === locA && area === 'opportunities';
    expect((await run({ query: { source: 'opportunities', range: 'all' } })).data.error).toContain('Tarif');
    expect((await run({ query: { source: 'contacts', range: 'all' } })).status).toBe(200);
    // …but never for the agency.
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    expect((await run({ query: { source: 'opportunities', range: 'all' } })).status).toBe(200);
    delete t.app.services.saasAreaBlocked;
    // A sub-account key only sees its own sub-account, even with scope "all".
    t.api.setLocation(locB);
    const key = (await t.api.post('/api/api-keys', { name: 'BI' })).data.key;
    t.api.setLocation(locA);
    const viaKey = await t.api.raw('/api/reports/run', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ query: { source: 'contacts', range: 'all' }, scope: 'all' }) });
    expect((await viaKey.json()).totals.v[0]).toBe(6);
    expect(member).not.toBe(admin);
  });

  it('saves reports in the library and shares them', async () => {
    const created = await t.api.post('/api/reports/library', { name: 'Win-Rate', config: { viz: 'kpi', query: { source: 'opportunities', measures: ['calc:win_rate'], range: 'all' } }, visibility: 'team' });
    expect(created.status).toBe(200);
    expect((await t.api.post('/api/reports/library', { name: 'Kaputt', config: { viz: 'kpi', query: { source: 'nope' } } })).status).toBe(400);
    expect((await t.api.post('/api/reports/library', { name: '', config: { viz: 'kpi', query: { source: 'contacts' } } })).status).toBe(400);
    const patched = await t.api.patch(`/api/reports/library/${created.data.id}`, { name: 'Win-Rate gesamt' });
    expect(patched.data.name).toBe('Win-Rate gesamt');
    const list = (await t.api.get('/api/reports/library')).data;
    expect(list.find((r: any) => r.id === created.data.id)).toMatchObject({ can_edit: true, config: { viz: 'kpi' } });
    const priv = (await t.api.post('/api/reports/library', { name: 'Geheim', config: { viz: 'table', query: { source: 'contacts' } } })).data;
    // The team member sees the team report but not the private one, and cannot change it.
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'team@x.de', password: 'geheim12345' });
    const seen = (await t.api.get('/api/reports/library')).data.map((r: any) => r.id);
    expect(seen).toContain(created.data.id);
    expect(seen).not.toContain(priv.id);
    expect((await t.api.patch(`/api/reports/library/${created.data.id}`, { name: 'Meins' })).status).toBe(403);
    expect((await t.api.get(`/api/reports/library/${priv.id}`)).status).toBe(404);
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    expect((await t.api.del(`/api/reports/library/${priv.id}`)).status).toBe(200);
  });

  it('manages dashboards: layout, sharing, default, data and templates', async () => {
    const d = await t.api.post('/api/reports/dashboards', {
      name: 'Chef-Cockpit',
      widgets: [
        { title: 'Neue Leads', config: { viz: 'kpi', query: { source: 'contacts', measures: ['count'] } }, x: 0, y: 0, w: 3, h: 2 },
        { title: 'Pipeline', config: { viz: 'funnel', query: { source: 'opportunities', measures: ['sum:value'], group_by: ['stage'], range: 'all' }, fixed_range: true }, x: 10, y: 0, w: 6, h: 30 },
      ],
      settings: { range: 'all', refresh: 300 },
    });
    expect(d.status).toBe(200);
    // Positions are clamped into the 12-column grid.
    expect(d.data.widgets[1]).toMatchObject({ x: 6, w: 6, h: 12 });
    expect(d.data.settings).toMatchObject({ range: 'all', refresh: 300, scope: 'location' });
    const moved = await t.api.patch(`/api/reports/dashboards/${d.data.id}`, { widgets: [{ ...d.data.widgets[0], x: 3, y: 1, w: 4 }, d.data.widgets[1]], settings: { refresh: 7 } });
    expect(moved.data.widgets[0]).toMatchObject({ id: d.data.widgets[0].id, x: 3, y: 1, w: 4 });
    expect(moved.data.settings.refresh).toBe(0);
    expect((await t.api.patch(`/api/reports/dashboards/${d.data.id}`, { widgets: [{ title: 'x', config: { viz: 'kpi', query: { source: 'contacts', measures: ['sum:nope'] } } }] })).status).toBe(400);

    const data = await t.api.get(`/api/reports/dashboards/${d.data.id}/data`);
    expect(data.data.widgets.map((w: any) => w.result?.totals.v[0])).toEqual([6, 15800]);
    // Dashboard range override applies to widgets without a fixed range.
    const april = await t.api.get(`/api/reports/dashboards/${d.data.id}/data?range=${encodeURIComponent(JSON.stringify(APRIL))}`);
    expect(april.data.widgets.map((w: any) => w.result?.totals.v[0])).toEqual([3, 15800]);
    const agency = await t.api.get(`/api/reports/dashboards/${d.data.id}/data?scope=all`);
    expect(agency.data.widgets[0].result.totals.v[0]).toBe(12);

    expect((await t.api.put('/api/reports/default', { dashboard_id: d.data.id })).data.default_id).toBe(d.data.id);
    expect((await t.api.get('/api/reports/dashboards')).data.default_id).toBe(d.data.id);

    // Private: invisible for the team member; shared with the team: visible, read-only.
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'team@x.de', password: 'geheim12345' });
    expect((await t.api.get(`/api/reports/dashboards/${d.data.id}`)).status).toBe(404);
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    await t.api.patch(`/api/reports/dashboards/${d.data.id}`, { visibility: 'team' });
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'team@x.de', password: 'geheim12345' });
    const shared = await t.api.get(`/api/reports/dashboards/${d.data.id}`);
    expect(shared.data).toMatchObject({ name: 'Chef-Cockpit', can_edit: false });
    expect((await t.api.patch(`/api/reports/dashboards/${d.data.id}`, { name: 'Meins' })).status).toBe(403);
    expect((await t.api.del(`/api/reports/dashboards/${d.data.id}`)).status).toBe(403);
    // The viewer's own rights apply to the numbers (agency scope stays inside the member's sub-accounts).
    expect((await t.api.get(`/api/reports/dashboards/${d.data.id}/data?scope=all`)).data.widgets[0].result.totals.v[0]).toBe(6);
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });

    const tpls = (await t.api.get('/api/reports/templates')).data;
    expect(tpls.map((x: any) => x.name)).toEqual(['Vertrieb', 'Marketing', 'Umsatz', 'Aktivität', 'Termine']);
    for (const tpl of tpls) {
      const made = await t.api.post(`/api/reports/templates/${tpl.key}`, {});
      expect(made.status, tpl.key).toBe(200);
      expect(made.data.widgets.length).toBe(tpl.key === 'sales' ? 10 : 8);
      const res = await t.api.get(`/api/reports/dashboards/${made.data.id}/data`);
      expect(res.data.widgets.filter((w: any) => w.error), tpl.key).toEqual([]);
    }
    expect((await t.api.post('/api/reports/templates/nope', {})).status).toBe(404);
    expect((await t.api.del(`/api/reports/dashboards/${d.data.id}`)).status).toBe(200);
    expect((await t.api.get('/api/reports/dashboards')).data.default_id).toBeNull();
  });

  it('e-mails scheduled summaries with key numbers and tables', async () => {
    const dash = (await t.api.post('/api/reports/templates/sales', { name: 'Vertrieb Wochenbericht' })).data;
    expect((await t.api.post('/api/reports/schedules', { dashboard_id: dash.id, recipients: 'kaputt' })).status).toBe(400);
    const s = await t.api.post('/api/reports/schedules', { dashboard_id: dash.id, frequency: 'weekly', weekday: 1, hour: 8, recipients: 'chef@example.com, vertrieb@example.com', range: 'all' });
    expect(s.status).toBe(200);
    expect(s.data.recipients).toEqual(['chef@example.com', 'vertrieb@example.com']);
    expect(new Date(s.data.next_at).getTime()).toBeGreaterThan(Date.now());
    const preview = await t.api.get(`/api/reports/schedules/${s.data.id}/preview`);
    expect(preview.data.subject).toContain('Vertrieb Wochenbericht');
    expect(preview.data.html).toContain('Offener Pipeline-Wert');
    expect(preview.data.html).toMatch(/7\.000\s€/);
    expect(preview.data.html).toContain('Pipeline-Wert je Phase');
    expect(preview.data.html).not.toContain('<svg');
    expect(preview.data.text.replace(/\u00a0/g, ' ')).toContain('Umsatzprognose (gewichtet): 4.300 €');

    const sent: any[] = [];
    t.app.services.reportMailer = async (_loc: unknown, mail: any) => (sent.push(mail), { status: 'sent' });
    expect(await t.app.services.reportSchedulesRun(new Date())).toBe(0); // not due yet
    expect(await t.app.services.reportSchedulesRun(new Date(Date.now() + 8 * 864e5))).toBe(1);
    expect(sent.map((m) => m.to)).toEqual(['chef@example.com', 'vertrieb@example.com']);
    expect(sent[0].html).toContain('Im Dashboard ansehen');
    const after = (await t.api.get('/api/reports/schedules')).data.find((x: any) => x.id === s.data.id);
    expect(after).toMatchObject({ last_status: 'gesendet an 2', target_name: 'Vertrieb Wochenbericht' });
    expect(new Date(after.next_at).getTime()).toBeGreaterThan(Date.now() + 8 * 864e5);
    expect((await t.api.post(`/api/reports/schedules/${s.data.id}/send`)).data.status).toBe('gesendet an 2');
    expect((await t.api.patch(`/api/reports/schedules/${s.data.id}`, { active: false, frequency: 'monthly', monthday: 3 })).data).toMatchObject({ active: 0, frequency: 'monthly', monthday: 3 });
    expect((await t.api.del(`/api/reports/schedules/${s.data.id}`)).status).toBe(200);
    delete t.app.services.reportMailer;

    const html = renderReportEmail({ title: 'Test <b>', rangeLabel: 'Letzte 7 Tage', link: 'https://x.de/app/reports', brand: 'HyperLevel', widgets: [{ title: 'Fehler', viz: 'table', error: 'kaputt' }] }).html;
    expect(html).toContain('Test &lt;b&gt;');
    expect(html).toContain('kaputt');
  });

  it('records won/lost dates and keeps stage probabilities', async () => {
    const pipe = (await t.api.post('/api/pipelines', { name: 'Neu', stages: [{ name: 'Lead', probability: 20 }, { name: 'Deal', probability: '' }, { name: 'X', probability: 150 }] })).data;
    expect(pipe.stages.map((s: any) => s.probability)).toEqual([20, undefined, 100]);
    const opp = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact: { email: 'neu@x.de' }, value: 100 })).data;
    await t.api.patch(`/api/opportunities/${opp.id}`, { status: 'won' });
    await t.app.events.flush();
    expect(db.get('SELECT closed_at FROM opportunities WHERE id = ?', opp.id)!.closed_at).toBeTruthy();
    await t.api.patch(`/api/opportunities/${opp.id}`, { status: 'open' });
    await t.app.events.flush();
    expect(db.get('SELECT closed_at FROM opportunities WHERE id = ?', opp.id)!.closed_at).toBeNull();
  });

  it('offers MCP tools for reports and dashboards', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data.key;
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      return (await r.json()).result;
    };
    const r = await call('ghl_run_report', { location_id: locA, source: 'opportunities', measures: ['sum:value'], group_by: ['stage'], filters: [{ field: 'status', op: 'eq', value: 'open' }], range: 'all' });
    expect(r.isError).toBe(false);
    // Stages of the first pipeline in order, then the newer pipeline's deal.
    expect(r.structuredContent.rows.map((x: any) => x.v[0])).toEqual([1000, 2000, 4000, 100]);
    const agency = await call('ghl_run_report', { location_id: locA, source: 'contacts', range: 'all', scope: 'all' });
    expect(agency.structuredContent.totals.v[0]).toBe(13); // 6 + 6 + the contact of the deal above
    const list = await call('ghl_list_dashboards', { location_id: locA });
    expect(list.structuredContent.dashboards.length).toBeGreaterThan(0);
    const one = list.structuredContent.dashboards.find((x: any) => x.name === 'Vertrieb');
    const got = await call('ghl_get_dashboard', { location_id: locA, dashboard_id: one.id, range: 'all' });
    expect(got.structuredContent.widgets[0]).toMatchObject({ title: 'Offener Pipeline-Wert', totals: { v: [7100] } });
    const bad = await call('ghl_run_report', { location_id: locA, source: 'contacts', measures: ['sum:nope'] });
    expect(bad.isError).toBe(true);
  });
});
