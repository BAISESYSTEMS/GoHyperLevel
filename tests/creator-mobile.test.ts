import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';
import { client } from './security-fixtures.js';

vi.setConfig({ hookTimeout: 60_000 });

/** Creator & Commerce on the phone: read-only lists that relay onto the admin routes, so rights and sub-accounts hold. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let loc2 = '';
let contactId = '';
let productId = '';
const tokens: Record<string, string> = {};
const at = new Date().toISOString();

async function app(path: string, tok: string) {
  const r = await t.api.raw(path, { headers: { authorization: `Bearer ${tok}` } });
  return { status: r.status, data: (await r.json().catch(() => null)) as any };
}
async function phone(name: string, permissions: string[] | null, locations = [loc]) {
  const email = `${name}@example.com`;
  const u = await t.api.post('/api/users', { email, name, password: 'geheim-12345', role: 'member', locations, permissions });
  expect(u.status, JSON.stringify(u.data)).toBe(200);
  const c = client(t.base, { 'x-pghl': '1', 'x-location-id': locations[0] });
  expect((await c('POST', '/api/auth/login', { email, password: 'geheim-12345' })).status).toBe(200);
  const p = await c('POST', '/api/mobile/pair', { device_name: `${name}-phone`, platform: 'android', app_version: '1.0.0' });
  tokens[name] = p.data.token;
  return p.data.token as string;
}

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  loc2 = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
  contactId = (await t.api.post('/api/contacts', { email: 'kunde@example.com', first_name: 'Karla', last_name: 'Kunde' })).data.id;
  productId = (await t.api.post('/api/products', { name: 'Kurs im Paket', price_cents: 30000 })).data.id;
  const db = t.app.db;
  db.insert('plan_subscriptions', { id: 'ps1', location_id: loc, plan_id: null, product_id: productId, contact_id: contactId, checkout_id: 'cs1', stripe_subscription: 'sub_1', stripe_customer: 'cus_1', plan_name: '3 Raten', installments: 3, amount_cents: 10000, currency: 'EUR', interval: 'month', interval_count: 1, on_default: 'pause', tag: '', tax_rate: 0, status: 'active', access: 'active', paid_count: 1, paid_cents: 10000, failed_count: 0, started_at: at, created_at: at, updated_at: at });
  db.insert('plan_subscriptions', { id: 'ps2', location_id: loc, plan_id: null, product_id: productId, contact_id: contactId, checkout_id: 'cs2', stripe_subscription: 'sub_2', stripe_customer: 'cus_1', plan_name: '6 Raten', installments: 6, amount_cents: 5000, currency: 'EUR', interval: 'month', interval_count: 1, on_default: 'pause', tag: '', tax_rate: 0, status: 'defaulted', access: 'paused', paid_count: 2, paid_cents: 10000, failed_count: 3, started_at: new Date(Date.now() - 864e5).toISOString(), created_at: at, updated_at: at });
  db.insert('plan_subscriptions', { id: 'psB', location_id: loc2, plan_id: null, product_id: productId, contact_id: null, checkout_id: 'csB', stripe_subscription: 'sub_B', stripe_customer: 'cus_B', plan_name: 'Zweitfirma-Raten', installments: 2, amount_cents: 100, currency: 'EUR', interval: 'month', interval_count: 1, on_default: 'pause', tag: '', tax_rate: 0, status: 'active', access: 'active', paid_count: 0, paid_cents: 0, failed_count: 0, started_at: new Date(Date.now() + 1000).toISOString(), created_at: at, updated_at: at });
  db.insert('dunning_cases', { id: 'dc1', location_id: loc, contact_id: contactId, product_id: productId, product_name: 'Kurs im Paket', stripe_subscription: 'sub_2', stripe_customer: 'cus_1', stripe_invoice: 'in_1', status: 'open', amount_cents: 5000, currency: 'EUR', attempts: 2, first_failed_at: at, last_failed_at: at, created_at: at, updated_at: at });
  db.insert('dunning_cases', { id: 'dc2', location_id: loc, contact_id: contactId, product_id: productId, product_name: 'Kurs im Paket', stripe_subscription: 'sub_3', stripe_customer: 'cus_1', stripe_invoice: 'in_2', status: 'recovered', amount_cents: 700, currency: 'EUR', attempts: 1, first_failed_at: at, last_failed_at: at, recovered_at: at, created_at: at, updated_at: at });
  // a dunning notice that waits for approval
  const inv = (await t.api.post('/api/invoices', { contact_id: contactId, title: 'Beratung', items: [{ name: 'Beratung', qty: 1, price_cents: 11900, tax_rate: 0 }], due_at: new Date(Date.now() - 20 * 864e5).toISOString() })).data;
  await t.api.patch(`/api/invoices/${inv.id}`, { status: 'sent' });
  expect((await t.api.post(`/api/dunning/invoices/${inv.id}/notice`, { send: false })).status).toBe(200);
  // a quiz answer and a hand-in that wait for a review
  const course = (await t.api.post('/api/courses', { title: 'Akademie' })).data;
  const mod = (await t.api.post(`/api/courses/${course.id}/modules`, { title: 'Modul' })).data;
  const l1 = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: mod.id, title: 'Test' })).data;
  const l2 = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: mod.id, title: 'Aufgabe' })).data;
  await t.api.patch(`/api/courses/${course.id}`, { status: 'published' });
  const quiz = (await t.api.post('/api/quizzes', { course_id: course.id, lesson_id: l1.id, title: 'Offene Frage', questions: [{ kind: 'short', text: 'Erkläre es.', accepted: ['x'], review: 'manual' }] })).data;
  const as = (await t.api.post('/api/assignments', { course_id: course.id, lesson_id: l2.id, title: 'Konzept', instructions: 'Lade es hoch', kind: 'text' })).data;
  const enr = (await t.api.post(`/api/courses/${course.id}/enrollments`, { contact_id: contactId })).data;
  const qid = quiz.questions?.[0]?.id ?? Object.keys({}).at(0);
  db.insert('quiz_attempts', { id: 'qa1', location_id: loc, quiz_id: quiz.id, enrollment_id: enr.id, contact_id: contactId, attempt_no: 1, status: 'pending', answers: JSON.stringify({ [qid ?? 'q']: 'Meine Antwort' }), reviews: '{}', score: 0, max_score: 1, percent: 0, passed: 0, comment: '', submitted_at: at, reviewer: '' });
  db.insert('assignment_submissions', { id: 'as1', location_id: loc, assignment_id: as.id, enrollment_id: enr.id, contact_id: contactId, attempt_no: 1, text: 'Mein Konzept', status: 'submitted', feedback: '', reviewer: '', submitted_at: at });
  await phone('inhaber', null, [loc, loc2]);
  await phone('buchhaltung', ['payments']);
  await phone('lehrer', ['courses']);
  await phone('vertrieb', ['contacts']);
  await phone('nurzweit', ['payments', 'courses'], [loc2]);
});
afterAll(() => t.close());

describe('Creator & Commerce on the phone', () => {
  it('shows the owner counters across sub-accounts', async () => {
    const r = await app('/api/mobile/creator/overview', tokens.inhaber);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.payment_plans).toEqual({ active: 2, defaulted: 1, completed: 0 });
    expect(r.data.dunning).toMatchObject({ open_cases: 1, pending_notices: 1, at_risk_cents: 5000 });
    expect(r.data.reviews).toEqual({ quiz_attempts: 1, assignment_submissions: 1 });
    expect(r.data.locations).toEqual({ payments: 2, courses: 2 });
    const one = await app(`/api/mobile/creator/overview?location=${loc2}`, tokens.inhaber);
    expect(one.data.payment_plans).toEqual({ active: 1, defaulted: 0, completed: 0 });
    expect((await app('/api/mobile/creator/overview?location=unbekannt', tokens.inhaber)).status).toBe(403);
  });

  it('lists instalment purchases with progress, newest first, filterable', async () => {
    const r = await app('/api/mobile/creator/payment-plans', tokens.inhaber);
    expect(r.data.map((x: any) => x.id)).toEqual(['psB', 'ps1', 'ps2']);
    expect(r.data.find((x: any) => x.id === 'ps1')).toMatchObject({ location_name: 'Testfirma', contact: { name: 'Karla Kunde' }, plan_name: '3 Raten', installments: 3, paid_count: 1, amount_cents: 10000, status: 'active', product_name: 'Kurs im Paket' });
    expect(JSON.stringify(r.data)).not.toContain('sub_1');
    expect(JSON.stringify(r.data)).not.toContain('cus_1');
    const def = await app('/api/mobile/creator/payment-plans?status=defaulted', tokens.inhaber);
    expect(def.data.map((x: any) => x.id)).toEqual(['ps2']);
    expect(def.data[0]).toMatchObject({ access: 'paused', failed_count: 3 });
  });

  it('lists open payment failures and notices waiting for approval', async () => {
    const r = await app('/api/mobile/creator/dunning', tokens.inhaber);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.cases.map((c: any) => c.id)).toEqual(['dc1']);
    expect(r.data.cases[0]).toMatchObject({ contact: { name: 'Karla Kunde' }, amount_cents: 5000, status: 'open', attempts: 2, location_name: 'Testfirma' });
    expect(r.data.notices).toHaveLength(1);
    expect(r.data.notices[0]).toMatchObject({ contact: { name: 'Karla Kunde' }, level: 1, total_cents: expect.any(Number), location_name: 'Testfirma' });
    expect(JSON.stringify(r.data)).not.toMatch(/\/mahnung\//);
  });

  it('lists quiz answers and hand-ins waiting for a person', async () => {
    const r = await app('/api/mobile/creator/reviews', tokens.inhaber);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.map((x: any) => x.kind).sort()).toEqual(['assignment', 'quiz']);
    expect(r.data.find((x: any) => x.kind === 'quiz')).toMatchObject({ title: 'Offene Frage', course_title: 'Akademie', contact: { name: 'Karla Kunde' }, open_questions: 1 });
    expect(r.data.find((x: any) => x.kind === 'assignment')).toMatchObject({ title: 'Konzept', course_title: 'Akademie', has_file: false });
  });

  it('follows the member rights: payments for money, courses for reviews, nothing without either', async () => {
    const pay = await app('/api/mobile/creator/overview', tokens.buchhaltung);
    expect(pay.status).toBe(200);
    expect(pay.data.payment_plans.active).toBe(1);
    expect(pay.data.locations).toEqual({ payments: 1, courses: 0 });
    expect(pay.data.reviews).toEqual({ quiz_attempts: 0, assignment_submissions: 0 });
    expect((await app('/api/mobile/creator/payment-plans', tokens.buchhaltung)).status).toBe(200);
    expect((await app('/api/mobile/creator/reviews', tokens.buchhaltung)).status).toBe(403);
    const teach = await app('/api/mobile/creator/overview', tokens.lehrer);
    expect(teach.data.reviews).toEqual({ quiz_attempts: 1, assignment_submissions: 1 });
    expect(teach.data.payment_plans).toEqual({ active: 0, defaulted: 0, completed: 0 });
    expect((await app('/api/mobile/creator/dunning', tokens.lehrer)).status).toBe(403);
    expect((await app('/api/mobile/creator/reviews', tokens.lehrer)).status).toBe(200);
    for (const path of ['overview', 'payment-plans', 'dunning', 'reviews']) expect([200, 403]).toContain((await app(`/api/mobile/creator/${path}`, tokens.vertrieb)).status);
    expect((await app('/api/mobile/creator/payment-plans', tokens.vertrieb)).status).toBe(403);
    expect((await app('/api/mobile/creator/reviews', tokens.vertrieb)).status).toBe(403);
  });

  it('keeps sub-accounts apart', async () => {
    // a member of the second sub-account sees only its own rows and cannot ask for the first one
    const r = await app('/api/mobile/creator/payment-plans', tokens.nurzweit);
    expect(r.data.map((x: any) => x.id)).toEqual(['psB']);
    expect((await app(`/api/mobile/creator/payment-plans?location=${loc}`, tokens.nurzweit)).status).toBe(403);
    expect((await app('/api/mobile/creator/dunning', tokens.nurzweit)).data).toEqual({ cases: [], notices: [] });
    expect((await app('/api/mobile/creator/reviews', tokens.nurzweit)).data).toEqual([]);
    // the first sub-account's member never gets rows of the second
    const mine = await app('/api/mobile/creator/payment-plans', tokens.buchhaltung);
    expect(mine.data.every((x: any) => x.location_id === loc)).toBe(true);
  });

  it('is read-only and needs a login', async () => {
    const r = await t.api.raw('/api/mobile/creator/overview');
    expect([401, 403]).toContain(r.status);
    const post = await t.api.raw('/api/mobile/creator/payment-plans', { method: 'POST', headers: { authorization: `Bearer ${tokens.inhaber}`, 'content-type': 'application/json' }, body: '{}' });
    expect(post.status).toBe(404);
  });
});
