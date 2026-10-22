import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { anthropicSse, events, fakeModel, json, sse } from './agent-fakes.js';
import { retry } from '../server/services/agent-llm.js';
import { classify, routeProblem } from '../server/services/agent-safety.js';
import { hmInTz } from '../server/core/time.js';
import type { Resolved } from '../server/services/ai-presets.js';
import { DEFAULT_FALLBACKS, chatWithFallback, cleanFallbacks, fallbackChain, fallbackPause, isRetryable } from '../server/services/model-fallback.js';
import { BIZDEV_AREAS, REPEAT_MS, applyMemory, bizdevPrompt, computeReview, reviewFacts, rulesAnswer, sayReview, type GrowthData, type GrowthItem } from '../server/services/growth-review.js';
import { cleanPrefs, defaultPrefs, withPrefDefaults } from '../server/services/companion-prefs.js';
import { rulesSuggestions } from '../server/services/companion-initiative.js';
import { GROWTH_TOOLS } from '../server/modules/companion-growth.js';
import { installOutboundGuard, uninstallOutboundGuard } from '../server/services/outbound-guard.js';
import { client } from './security-fixtures.js';

/**
 * Jarvis als Business Developer: the model fallback chain (5xx → next model, 429 retried, all failing → a rule-based answer from the
 * numbers, never one canned sentence), the role prompt with the business areas, the growth review (opportunities and risks with €
 * from seeded data, KPIs vs. last week), the no-repeat memory, quiet hours of the scheduler, isolation between sub-accounts and the
 * MCP / agent tool ghl_growth_review. Every model is a fake.
 */

const DAY = 864e5;
const iso = (offsetDays: number, base = Date.now()) => new Date(base + offsetDays * DAY).toISOString();

// --- the fallback chain (pure + fake provider) ------------------------------------------------------------------------------

const kie = (model: string, id = 'kie1'): Resolved => ({ connectionId: id, provider: 'kie_llm', baseUrl: 'https://api.kie.ai/anthropic', apiKey: 'k', headers: { authorization: 'Bearer k' }, authStyle: 'bearer', model, label: 'kie.ai', wire: 'anthropic', capabilities: ['text'], options: {} });
const other: Resolved = { ...kie('gpt-5-mini', 'oai1'), provider: 'openai', baseUrl: 'https://api.openai.com/v1', label: 'OpenAI', wire: 'openai' };
const req = { system: 'Du bist ein Test.', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hallo' }] }], tools: [], stream: true, maxTokens: 100, timeoutMs: 5000 };
const err = (status: number, body: unknown = { error: { message: 'Internal error' } }) => json(body, status);

describe('Ersatzmodelle (services/model-fallback.ts)', () => {
  beforeAll(() => {
    retry.ms = 1;
    fallbackPause.ms = 1;
  });

  it('builds the chain: routing list or kie.ai default order, then the other text connections', () => {
    expect(DEFAULT_FALLBACKS.kie_llm).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5']);
    expect(fallbackChain(kie('claude-sonnet-5-5'), { others: [other, kie('x', 'kie1')] }).map((r) => `${r.connectionId}:${r.model}`)).toEqual(['kie1:claude-sonnet-5', 'kie1:claude-haiku-5-5', 'oai1:gpt-5-mini']);
    expect(fallbackChain(kie('claude-opus-5-5'), { models: ['claude-sonnet-5'] }).map((r) => r.model)).toEqual(['claude-sonnet-5']);
    expect(cleanFallbacks('claude-sonnet-5, claude-haiku-5-5', /^[\w.:/-]+$/)).toEqual(['claude-sonnet-5', 'claude-haiku-5-5']);
    expect(() => cleanFallbacks(['ok', 'nicht ok!'], /^[\w.:/-]+$/)).toThrow();
    expect(isRetryable(Object.assign(new Error('x'), { code: 'rate_limit' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('no_available_account'), { code: 'invalid_request' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('Schlüssel ungültig'), { code: 'auth' }))).toBe(false);
  });

  it('5xx → retried once, then the next model of the same connection answers (and says which)', async () => {
    const m = fakeModel();
    m.reply(err(500), err(500), sse(anthropicSse([{ type: 'text', text: 'Hier ist Sonnet 5.' }], undefined, 'claude-sonnet-5')));
    const seen: string[] = [];
    const out = await chatWithFallback(req, [kie('claude-sonnet-5-5'), ...fallbackChain(kie('claude-sonnet-5-5'), {})], () => m.fetch, { onAttempt: (a) => seen.push(`${a.model}:${a.ok ? 'ok' : a.code}`) });
    expect(out.result.text).toBe('Hier ist Sonnet 5.');
    expect(out.target.model).toBe('claude-sonnet-5');
    expect(seen).toEqual(['claude-sonnet-5-5:server', 'claude-sonnet-5:ok']);
    expect(m.calls.map((c) => c.body.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5']);
  });

  it('429 is retried once on the same model before anything else', async () => {
    const m = fakeModel();
    m.reply(err(429, { error: { message: 'rate limited' } }), sse(anthropicSse([{ type: 'text', text: 'Zweiter Versuch.' }])));
    const out = await chatWithFallback(req, [kie('claude-sonnet-5-5'), kie('claude-sonnet-5')], () => m.fetch);
    expect(out.target.model).toBe('claude-sonnet-5-5');
    expect(out.attempts).toHaveLength(1);
    expect(m.calls).toHaveLength(2);
  });

  it('kie.ai’s 200 envelope "no_available_account" counts as a provider failure → next model, then another connection', async () => {
    const m = fakeModel();
    const envelope = json({ code: 500, msg: 'no_available_account' });
    m.reply(envelope, envelope, err(503), err(503), sse(anthropicSse([{ type: 'text', text: 'OpenAI hier.' }])));
    // the OpenAI-compatible answer is read as Anthropic SSE by this fake: give the openai target an anthropic wire for the test
    const out = await chatWithFallback(req, [kie('claude-sonnet-5-5'), kie('claude-sonnet-5'), { ...other, wire: 'anthropic' }], () => m.fetch);
    expect(out.target.connectionId).toBe('oai1');
    expect(out.attempts.filter((a) => !a.ok).map((a) => a.code)).toEqual(['upstream', 'upstream', 'overloaded']);
  });

  it('a bad key ends at once; when all fail the error says which models were tried', async () => {
    const m = fakeModel();
    m.reply(err(401, { error: { message: 'invalid key' } }));
    await expect(chatWithFallback(req, [kie('claude-sonnet-5-5'), kie('claude-sonnet-5')], () => m.fetch)).rejects.toMatchObject({ code: 'auth' });
    expect(m.calls).toHaveLength(1);
    const n = fakeModel();
    await expect(chatWithFallback(req, [kie('claude-sonnet-5-5'), kie('claude-sonnet-5')], () => n.fetch)).rejects.toMatchObject({ code: 'all_failed', message: expect.stringContaining('claude-sonnet-5-5, claude-sonnet-5') });
  });
});

// --- the growth review (pure) --------------------------------------------------------------------------------------------------

const NOW = Date.parse('2026-10-21T09:00:00Z');
function seeded(over: Partial<GrowthData> = {}): GrowthData {
  return {
    now: NOW,
    deals: [
      { id: 'd1', name: 'Website-Relaunch', value: 8000, status: 'open', created_at: iso(-60, NOW), stage_changed_at: iso(-30, NOW), contact_id: 'c1', contact_name: 'Anna Müller' },
      { id: 'd2', name: 'Shop', value: 5000, status: 'open', created_at: iso(-40, NOW), stage_changed_at: iso(-2, NOW), expected_close_date: iso(-10, NOW).slice(0, 10), contact_id: 'c2', contact_name: 'Bernd Bauer' },
      { id: 'd3', name: 'Logo', value: 3000, status: 'won', created_at: iso(-20, NOW), closed_at: iso(-2, NOW) },
      { id: 'd4', name: 'SEO', value: 2000, status: 'won', created_at: iso(-20, NOW), closed_at: iso(-3, NOW) },
      { id: 'd5', name: 'App', value: 9000, status: 'lost', created_at: iso(-30, NOW), closed_at: iso(-20, NOW) },
    ],
    invoices: [
      { id: 'i1', number: 'RE-1001', contact_id: 'c1', name: 'Anna Müller', total_cents: 120000, open_cents: 120000, days_overdue: 12, status: 'sent', created_at: iso(-30, NOW) },
      { id: 'i2', number: 'RE-0900', contact_id: 'c3', name: 'Clara Klein', total_cents: 400000, open_cents: 0, days_overdue: 0, status: 'paid', paid_at: iso(-150, NOW), created_at: iso(-160, NOW) },
      { id: 'i3', number: 'RE-1002', contact_id: 'c4', name: 'Dora Dorn', total_cents: 150000, open_cents: 0, days_overdue: 0, status: 'paid', paid_at: iso(-10, NOW), created_at: iso(-12, NOW) },
    ],
    quotes: [],
    reviews: [],
    leads: [{ created_at: iso(-2, NOW) }, { created_at: iso(-9, NOW) }, { created_at: iso(-10, NOW) }],
    sources: [],
    unanswered: { count: 0, top: null },
    activity: { c3: null, c4: iso(-10, NOW) },
    reviewAsked: [],
    tasksOverdue: 0,
    waiting: 0,
    profile: { tagline: 'Websites für Handwerker', goals: '20 neue Kunden bis Jahresende' },
    ...over,
  };
}

describe('the growth review (services/growth-review.ts)', () => {
  it('computes KPIs vs. last week and the top opportunities and risks with their € impact', () => {
    const r = computeReview(seeded(), { lang: 'de', kind: 'weekly' });
    expect(r.kpis).toMatchObject({ won_count: 2, won_value: 5000, pipeline: 13000, overdue: 1200, leads: 1 });
    expect(r.prev).toMatchObject({ revenue: 1500, leads: 2 });
    expect(r.kpis.win_rate).toBeCloseTo(2 / 3);
    expect(r.deltas.revenue).toBe(-100);
    const keys = (xs: GrowthItem[]) => xs.map((x) => x.key);
    expect(keys(r.risks)).toEqual(['risk:past_close', 'risk:revenue_drop', 'risk:overdue_invoices']);
    expect(r.risks.find((x) => x.key === 'risk:overdue_invoices')).toMatchObject({ impact_eur: 1200, estimate: false });
    expect(r.risks[0]).toMatchObject({ impact_eur: 5000, title: expect.stringContaining('5.000') });
    expect(keys(r.opportunities)).toContain('opp:stale_deals');
    // expected value of the idle deal: 8 000 € × win rate 2/3
    expect(r.opportunities.find((x) => x.key === 'opp:stale_deals')!.impact_eur).toBe(5333);
    expect(r.idea?.key).toBe('growth:reactivation');
    expect(r.idea!.action).toMatchObject({ draft_type: 'campaign', draft: expect.stringContaining('{{contact.first_name}}') });
    expect(r.actions.length).toBeGreaterThanOrEqual(1);
    expect(r.actions.length).toBeLessThanOrEqual(3);
    // an agent prompt never carries a third-party name – the record is the selected entity
    for (const a of r.actions) expect(a.prompt).not.toMatch(/Anna|Bernd|Clara|Dora/);
    expect(r.say).toMatch(/Umsatz.*Vorwoche/);
  });

  it('no new contact for 28 days → the idea is a lead flow (drafts only); the profile’s goals are part of the facts the model may use', () => {
    const empty = computeReview(seeded({ leads: [], deals: [], invoices: [] }), { lang: 'de', kind: 'daily' });
    expect(empty.idea).toMatchObject({ key: 'growth:lead_flow', kind: 'growth', area: 'leads', url: 'forms' });
    expect(empty.idea!.action.prompt).toMatch(/nur als Entwurf/);
    expect(empty.fresh).toBe(true);
    expect(empty.say).toMatch(/Lead-Fluss/);
    const full = computeReview(seeded(), { lang: 'de', kind: 'daily' });
    expect([...full.opportunities, ...full.risks, full.idea].map((x) => x?.key)).not.toContain('growth:lead_flow');
    expect(reviewFacts(empty, 'de')).toContain('20 neue Kunden bis Jahresende');
  });

  it('no repeat: the same numbers within days are left out, changed numbers come back as an update, a decline holds for two weeks', () => {
    const d = seeded();
    const first = computeReview(d, { lang: 'de', kind: 'daily', memory: [] });
    const said = [...first.opportunities, ...first.risks, ...(first.idea ? [first.idea] : [])].map((x) => ({ key: x.key, sig: x.sig, at: new Date(NOW).toISOString() }));
    const next = computeReview({ ...d, now: NOW + DAY }, { lang: 'de', kind: 'daily', memory: said, lastSay: first.say });
    expect(next.fresh).toBe(false);
    expect(next.opportunities.length + next.risks.length).toBe(0);
    // a new overdue invoice changes the numbers: back, marked as update
    const more = { ...d, now: NOW + DAY, invoices: [...d.invoices, { id: 'i9', number: 'RE-1009', contact_id: 'c2', name: 'Bernd Bauer', total_cents: 300000, open_cents: 300000, days_overdue: 3, status: 'sent', created_at: iso(-20, NOW) }] };
    const changed = computeReview(more, { lang: 'de', kind: 'daily', memory: said });
    expect(changed.fresh).toBe(true);
    expect(changed.risks[0]).toMatchObject({ key: 'risk:overdue_invoices', update: true, impact_eur: 4200 });
    expect(changed.say).toMatch(/Update|Inzwischen|Neu bewertet/);
    // after REPEAT_MS the same item may come again; a declined one not
    const item = first.risks[0];
    expect(applyMemory([item], [{ key: item.key, sig: item.sig, at: new Date(NOW - REPEAT_MS - 1000).toISOString() }], NOW)).toHaveLength(1);
    expect(applyMemory([item], [{ key: item.key, sig: 'other', at: new Date(NOW - 5 * DAY).toISOString(), status: 'declined' }], NOW)).toHaveLength(0);
  });

  it('wording varies by day and never opens like the last briefing – without AI no canned sentence', () => {
    const r = computeReview(seeded(), { lang: 'de', kind: 'daily' });
    const days = Array.from({ length: 6 }, (_, i) => sayReview(r, { lang: 'de', seed: `u1:2026-10-${10 + i}:daily` }));
    expect(new Set(days).size).toBeGreaterThan(2);
    const again = sayReview(r, { lang: 'de', seed: 'u1:2026-10-10:daily', lastSay: days[0] });
    expect(again.split(':')[0]).not.toBe(days[0].split(':')[0]);
    // the rules' answer follows the question and the data
    const a = rulesAnswer(r, { lang: 'de', question: 'Was ist mit meinen Rechnungen?', seed: 's1' });
    const b = rulesAnswer(r, { lang: 'de', question: 'Wie läuft die Pipeline?', seed: 's1' });
    expect(a).not.toBe(b);
    expect(a.split('\n\n')[1]).toMatch(/^- \*\*\d+ überfällige Rechnung|^- \*\*Umsatz/);
    expect(b).toMatch(/Nächste Schritte, die ich vorbereiten kann/);
    expect(a).toMatch(/1\.200\s€/);
  });

  it('the initiative’s rules vary their sentence per record and day', () => {
    const says = Array.from({ length: 8 }, (_, i) => rulesSuggestions({ steps: [{ key: 'deal:o1', label: '„Relaunch“ nachfassen', entity: { type: 'opportunity', id: 'o1', label: 'Relaunch' } }], candidates: [{ ref: 'h1', type: 'opportunity', id: 'o1', label: 'Relaunch', facts: 'offener Deal' }], level: 'high', history: [], now: NOW + i * DAY, lang: 'de' })[0].say);
    expect(new Set(says).size).toBeGreaterThan(1);
    for (const s of says) expect(s).toContain('„Relaunch“ nachfassen');
  });

  it('the role prompt names every business area, the € priority, 1–3 next actions and what was said lately', () => {
    const p = bizdevPrompt({ name: 'Jarvis', goals: '20 neue Kunden', recent: ['3 überfällige Rechnungen'], lang: 'de' });
    for (const area of BIZDEV_AREAS) expect(p).toContain(area);
    expect(p).toMatch(/Geschäftswirkung in Euro/);
    expect(p).toMatch(/1–3 konkreten nächsten Schritten/);
    expect(p).toMatch(/Bestätigungskarte/);
    expect(p).toContain('3 überfällige Rechnungen');
    expect(p).toContain('ghl_growth_review');
  });

  it('prefs: Business Developer is the default role, the briefing time is validated', () => {
    // the briefing is opt-in: off by default (also for stored prefs without the field)
    expect(defaultPrefs()).toMatchObject({ role: 'business_developer', growth: { daily: false, time: '08:00', weekly: true } });
    expect(withPrefDefaults({ name: 'Jarvis', checkin: { mode: 'daily' } }).growth.daily).toBe(false);
    expect(cleanPrefs({ role: 'assistant', growth: { daily: true, time: '07:15', weekly: false } }, defaultPrefs())).toMatchObject({ role: 'assistant', growth: { daily: true, time: '07:15', weekly: false } });
    expect(() => cleanPrefs({ role: 'boss' }, defaultPrefs())).toThrow();
    expect(() => cleanPrefs({ growth: { time: '25:00' } }, defaultPrefs())).toThrow();
    expect(withPrefDefaults({ role: 'x', growth: { time: 'y' } })).toMatchObject({ role: 'business_developer', growth: { time: '08:00' } });
  });
});

// --- end to end: the app ----------------------------------------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let B = '';
let me = '';
const model = fakeModel();
const pushes: any[] = [];

beforeAll(async () => {
  installOutboundGuard();
  retry.ms = 1;
  fallbackPause.ms = 1;
  t = await startTestApp();
  await t.setup();
  A = t.api.location;
  me = t.app.db.get<{ id: string }>("SELECT id FROM users WHERE email = 'chef@example.com'")!.id;
  B = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  t.app.services.agentFetch = model.fetch;
  t.app.services.pushNotify = async (p: any) => {
    pushes.push(p);
    return { users: 1, sent: 1, failed: 0, removed: 0 };
  };
  // A: an idle deal, a deal past its close date, an overdue invoice, a dormant customer
  const anna = (await t.api.post('/api/contacts', { first_name: 'Anna', last_name: 'Müller', email: 'anna@example.com' })).data;
  const bernd = (await t.api.post('/api/contacts', { first_name: 'Bernd', last_name: 'Bauer', email: 'bernd@example.com' })).data;
  const pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: [{ name: 'Neu' }] })).data;
  const d1 = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, name: 'Website-Relaunch', value: 8000, contact_id: anna.id })).data;
  t.app.db.run('UPDATE opportunities SET updated_at = ?, stage_changed_at = ? WHERE id = ?', iso(-30), iso(-30), d1.id);
  const d2 = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, name: 'Shop', value: 5000, contact_id: bernd.id })).data;
  t.app.db.run('UPDATE opportunities SET expected_close_date = ? WHERE id = ?', iso(-10).slice(0, 10), d2.id);
  const inv = (await t.api.post('/api/invoices', { contact_id: anna.id, items: [{ name: 'Beratung', qty: 1, price_cents: 120000, tax_rate: 0 }] })).data;
  t.app.db.run("UPDATE invoices SET status = 'sent', number = 'RE-1001', due_at = ? WHERE id = ?", iso(-12).slice(0, 10), inv.id);
  const old = (await t.api.post('/api/invoices', { contact_id: bernd.id, items: [{ name: 'Projekt', qty: 1, price_cents: 400000, tax_rate: 0 }] })).data;
  t.app.db.run("UPDATE invoices SET status = 'paid', number = 'RE-0900', paid_at = ?, issued_at = ? WHERE id = ?", iso(-150), iso(-160), old.id);
  t.app.db.run('UPDATE contacts SET last_activity_at = ? WHERE id = ?', iso(-100), bernd.id);
  // the person replied to both contacts already (no "unanswered lead" item)
  for (const c of [anna, bernd]) {
    t.app.db.insert('conversations', { id: `conv-${c.id}`, location_id: A, contact_id: c.id, unread: 0, last_message: 'Hallo', last_message_at: iso(-1), created_at: iso(-2) });
    t.app.db.insert('messages', { id: `m-${c.id}`, location_id: A, contact_id: c.id, conversation_id: `conv-${c.id}`, direction: 'out', channel: 'email', body: 'Hallo', status: 'sent', created_at: iso(-1) });
  }
});
afterAll(async () => {
  uninstallOutboundGuard();
  await t?.close();
});
beforeEach(() => model.reset());

describe('GET /api/companion/growth and the sub-account wall', () => {
  it('reads the review from the sub-account’s data with € impact', async () => {
    const r = await t.api.get('/api/companion/growth');
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.risks.map((x: any) => x.key)).toEqual(expect.arrayContaining(['risk:past_close', 'risk:overdue_invoices']));
    expect(r.data.risks.find((x: any) => x.key === 'risk:overdue_invoices').impact_eur).toBe(1200);
    expect(r.data.opportunities.map((x: any) => x.key)).toContain('opp:stale_deals');
    expect(r.data.idea?.key).toBe('growth:reactivation');
    expect(r.data.kpis.pipeline).toBe(13000);
    const w = await t.api.get('/api/companion/growth?kind=weekly&lang=en');
    expect(w.data.say).toMatch(/revenue/);
  });

  it('another sub-account sees none of it', async () => {
    t.api.setLocation(B);
    const r = await t.api.get('/api/companion/growth');
    t.api.setLocation(A);
    expect(r.status).toBe(200);
    expect([...r.data.opportunities, ...r.data.risks]).toEqual([]);
    // no contacts at all: only the generic lead-flow idea, nothing from A's data
    expect(r.data.idea?.key).toBe('growth:lead_flow');
    expect(r.data.kpis.pipeline).toBe(0);
  });
});

describe('the scheduler: Wachstums-Briefing and Wochenbilanz', () => {
  const run = (at: Date) => t.app.services.companionGrowth.runGrowth(at) as Promise<number>;
  const checkins = () => t.app.db.all<any>("SELECT * FROM companion_checkins WHERE user_id = ? AND kind IN ('growth', 'weekly') ORDER BY created_at", me);

  it('is opt-in: nothing comes before the person switches it on', async () => {
    expect((await t.api.put('/api/companion/prefs', { tz: 'Europe/Berlin', growth: { time: '00:00' }, checkin: { quiet_from: '00:00', quiet_to: '00:00' } })).status).toBe(200);
    expect((await t.api.get('/api/companion/prefs')).data.prefs.growth.daily).toBe(false);
    expect(await run(new Date())).toBe(0);
    expect(checkins()).toHaveLength(0);
  });

  it('respects the quiet hours, comes once a day, and stays silent when nothing is new', async () => {
    const now = new Date();
    const hm = (ms: number) => hmInTz(new Date(now.getTime() + ms), 'Europe/Berlin');
    // quiet from 30 minutes ago until in an hour (Berlin) – the briefing time has passed (00:00)
    expect((await t.api.put('/api/companion/prefs', { tz: 'Europe/Berlin', growth: { daily: true, weekly: false, time: '00:00' }, checkin: { quiet_from: hm(-30 * 60_000), quiet_to: hm(60 * 60_000) } })).status).toBe(200);
    expect(await run(now)).toBe(0);
    const later = new Date(now.getTime() + 90 * 60_000);
    expect(await run(later)).toBe(1);
    const c = checkins();
    expect(c).toHaveLength(1);
    const data = JSON.parse(c[0].data);
    expect(data.hotspots.map((h: any) => h.key)).toEqual(expect.arrayContaining(['risk_overdue_invoices', 'opp_stale_deals']));
    expect(data.next.length).toBeGreaterThan(0);
    expect(data.next.length).toBeLessThanOrEqual(3);
    expect(data.suggestions.some((s: any) => s.draft_type === 'campaign')).toBe(true);
    expect(pushes.at(-1)).toMatchObject({ kind: 'checkin', title: expect.stringContaining('Wachstums-Briefing') });
    // the check-in route returns the growth block
    const out = await t.api.get(`/api/companion/checkins/${c[0].id}`);
    expect(out.data.growth.kpis.pipeline).toBe(13000);
    // the same day again: nothing
    expect(await run(new Date(later.getTime() + 60_000))).toBe(0);
    // the next day with the same numbers: nothing new → no briefing
    expect(await run(new Date(later.getTime() + DAY))).toBe(0);
    expect(checkins()).toHaveLength(1);
  });

  it('a declined draft is not offered again; the Wochenbilanz comes on Monday with the week’s KPIs', async () => {
    const sugg = t.app.db.get<any>("SELECT id, key FROM companion_suggestions WHERE user_id = ? AND origin = 'growth' LIMIT 1", me);
    expect((await t.api.post(`/api/companion/suggestions/${sugg.id}`, { status: 'declined' })).status).toBe(200);
    expect((await t.api.put('/api/companion/prefs', { growth: { daily: true, weekly: true }, checkin: { quiet_from: '00:00', quiet_to: '00:00' } })).status).toBe(200);
    const monday = new Date();
    while (new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short' }).format(monday) !== 'Mon') monday.setTime(monday.getTime() + DAY);
    expect(await run(monday)).toBe(1);
    const w = checkins().at(-1);
    expect(w.kind).toBe('weekly');
    expect(JSON.parse(w.data).growth).toMatchObject({ kind: 'weekly', kpis: expect.any(Object), prev: expect.any(Object) });
    expect(JSON.parse(w.data).hotspots.map((h: any) => h.step.key)).not.toContain(sugg.key);
  });

  it('runs by hand with the person’s memory (POST /api/companion/growth/run)', async () => {
    const r = await t.api.post('/api/companion/growth/run', { kind: 'daily' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.checkin_id).toBeTruthy();
    expect(typeof r.data.review.say).toBe('string');
  });
});

describe('the agent: role prompt, fallback models, rules when no model answers', () => {
  let kieId = '';
  beforeAll(async () => {
    const c = await t.api.post('/api/ai-connections', { provider: 'kie_llm', api_key: 'kie-test-key-1234567890', models: { text: 'claude-sonnet-5-5' } });
    expect(c.status, JSON.stringify(c.data)).toBe(200);
    kieId = c.data.id;
  });
  const chat = async (message: string) => {
    const r = await t.api.post('/api/agent/chat', { message, source: 'focus' });
    return typeof r.data === 'string' ? events(r.data) : [];
  };

  it('Business Developer: the focus agent gets the role prompt with the business areas – "Assistent" does not', async () => {
    expect((await t.api.put('/api/companion/prefs', { role: 'business_developer' })).status).toBe(200);
    model.reply(sse(anthropicSse([{ type: 'text', text: 'Pipeline: 13.000 €.' }])));
    await chat('Wie läuft das Geschäft?');
    const sys = JSON.stringify(model.calls[0].body.system);
    expect(sys).toContain('Deine Rolle: Business Developer');
    for (const area of BIZDEV_AREAS) expect(sys).toContain(area);
    model.reset();
    expect((await t.api.put('/api/companion/prefs', { role: 'assistant' })).status).toBe(200);
    model.reply(sse(anthropicSse([{ type: 'text', text: 'Okay.' }])));
    await chat('Hallo');
    expect(JSON.stringify(model.calls[0].body.system)).not.toContain('Deine Rolle: Business Developer');
    await t.api.put('/api/companion/prefs', { role: 'business_developer' });
  });

  it('a 5xx on claude-sonnet-5-5 hands over to claude-sonnet-5 – the run ends normally and logs which model answered', async () => {
    model.reply(err(500), err(500), sse(anthropicSse([{ type: 'text', text: 'Antwort vom Ersatzmodell.' }], undefined, 'claude-sonnet-5')));
    const ev = await chat('Was steht an?');
    expect(ev.find((e) => e.type === 'model')).toMatchObject({ model: 'claude-sonnet-5', fallback: true, tried: ['claude-sonnet-5-5'] });
    expect(ev.some((e) => e.type === 'error')).toBe(false);
    expect(ev.filter((e) => e.type === 'text').map((e) => e.delta).join('')).toContain('Antwort vom Ersatzmodell.');
    const calls = t.app.db.all<any>("SELECT model, status FROM ai_calls WHERE purpose = 'agent' ORDER BY created_at DESC LIMIT 2");
    expect(calls.map((c) => `${c.model}:${c.status}`).sort()).toEqual(['kie_llm:claude-sonnet-5-5:error', 'kie_llm:claude-sonnet-5:ok']);
  });

  it('routing fallbacks: stored per usage, validated, used in their order', async () => {
    expect((await t.api.put('/api/ai-connections/routing', { usage: 'agent', connection_id: kieId, fallbacks: 'claude-haiku-5-5' })).status).toBe(200);
    expect((await t.api.put('/api/ai-connections/routing', { usage: 'agent', connection_id: kieId, fallbacks: ['nicht gültig!'] })).status).toBe(400);
    model.reply(err(503), err(503), sse(anthropicSse([{ type: 'text', text: 'Haiku.' }], undefined, 'claude-haiku-5-5')));
    const ev = await chat('Kurz bitte');
    expect(ev.find((e) => e.type === 'model')).toMatchObject({ model: 'claude-haiku-5-5' });
    expect(model.calls.map((c) => c.body.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    await t.api.put('/api/ai-connections/routing', { usage: 'agent', connection_id: kieId, fallbacks: [] });
  });

  it('the KI-Assistent’s quick texts routed to kie.ai use the same chain', async () => {
    expect((await t.api.put('/api/ai-connections/routing', { usage: 'text', connection_id: kieId })).status).toBe(200);
    t.app.services.aiConnectionsFetch = model.fetch;
    model.reply(err(500), err(500), json({ content: [{ type: 'text', text: 'Kurztext.' }], model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } }));
    const p = t.app.services.aiConnections.textProvider(A);
    const out = await p.call({ system: [{ text: 'Test' }], messages: [{ role: 'user', content: 'Hallo' }], maxTokens: 50 });
    expect(out).toMatchObject({ text: 'Kurztext.', model: 'claude-sonnet-5' });
    delete t.app.services.aiConnectionsFetch;
    await t.api.put('/api/ai-connections/routing', { usage: 'text', connection_id: '' });
  });

  it('the briefing by hand and the Wochenbilanz are phrased by the model – even with nothing new; invented numbers fall back to the rules', async () => {
    const before = (await t.api.get('/api/ai/settings')).data.enabled;
    // the sub-account's quick texts go through the kie.ai connection – then the KI-Assistent can be switched on
    expect((await t.api.put('/api/ai-connections/routing', { usage: 'text', connection_id: kieId })).status).toBe(200);
    const on = await t.api.put('/api/ai/settings', { enabled: true });
    expect(on.status, JSON.stringify(on.data)).toBe(200);
    t.app.services.aiConnectionsFetch = model.fetch;
    const says = (say: string) => json({ content: [{ type: 'text', text: JSON.stringify({ say }) }], model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } });
    try {
      model.reply(says('In der Pipeline liegen 13.000 €. Fass den liegen gebliebenen Deal nach – soll ich das vorbereiten?'));
      const w = await t.api.post('/api/companion/growth/run', { kind: 'weekly' });
      expect(w.status, JSON.stringify(w.data)).toBe(200);
      expect(w.data.review).toMatchObject({ source: 'ai', say: expect.stringContaining('13.000 €') });
      const sys = JSON.stringify(model.calls[0].body.system ?? model.calls[0].body);
      expect(sys).toContain('Business Developer');
      // the same day again by hand: nothing new – still phrased by the model
      model.reset();
      model.reply(says('Gerade ist alles ruhig – ich würde die Reaktivierung deiner Bestandskunden vorbereiten. Sollen wir?'));
      const d = await t.api.post('/api/companion/growth/run', { kind: 'daily' });
      expect(d.data.review.source).toBe('ai');
      expect(model.calls).toHaveLength(1);
      // a provider outage does not use up the day's phrasings (only answers count)
      model.reset();
      model.reply(err(500), err(500), err(500), err(500), err(500), err(500), err(500), err(500), err(500));
      for (let i = 0; i < 5; i++) expect((await t.api.post('/api/companion/growth/run', { kind: 'daily' })).data.review.source).toBe('rules');
      model.reset();
      model.reply(says('Gerade ist alles ruhig – ich würde die Reaktivierung vorbereiten. Sollen wir?'));
      expect((await t.api.post('/api/companion/growth/run', { kind: 'daily' })).data.review.source).toBe('ai');
      // a number that is not in the data → the rules' words
      model.reset();
      model.reply(says('Du hast diese Woche 99.999 € verdient!'));
      const x = await t.api.post('/api/companion/growth/run', { kind: 'weekly' });
      expect(x.data.review.source).toBe('rules');
      expect(x.data.review.say).not.toContain('99.999');
    } finally {
      delete t.app.services.aiConnectionsFetch;
      await t.api.put('/api/ai-connections/routing', { usage: 'text', connection_id: '' });
      await t.api.put('/api/ai/settings', { enabled: before });
    }
  });

  it('every model fails → a rule-based answer from the numbers, different per question – not an error, not a canned sentence', async () => {
    const one = await chat('Was ist mit meinen Rechnungen?');
    expect(one.some((e) => e.type === 'error')).toBe(false);
    const text1 = one.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    expect(one.find((e) => e.type === 'model')).toMatchObject({ provider: 'rules' });
    expect(text1).toMatch(/1\.200\s€/);
    expect(text1).toMatch(/Nächste Schritte/);
    model.reset();
    const two = await chat('Welche Deals sollte ich nachfassen?');
    const text2 = two.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    expect(text2).toMatch(/5\.000\s€|8\.000\s€/);
    expect(text2).not.toBe(text1);
  });
});

describe('MCP / agent tool ghl_growth_review', () => {
  let key = '';
  let n = 0;
  const mcp = async (name: string, args: any) => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }) });
    const j: any = await r.json();
    const text = j.result?.content?.[0]?.text ?? '';
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: !!j.result?.isError, text, data };
  };
  beforeAll(async () => {
    key = (await t.api.post('/api/api-keys', { name: 'Growth A' })).data.key;
  });

  it('is read-only, reads through GET and is one of the agent’s tools', () => {
    const tool = GROWTH_TOOLS[0];
    expect(tool.name).toBe('ghl_growth_review');
    expect(classify(tool)).toBe('read');
    expect(routeProblem('GET', '/api/companion/growth?kind=weekly', 'read')).toBeNull();
    expect((t.app.services.mcpTools as any[]).some((x) => x.name === 'ghl_growth_review')).toBe(true);
  });

  it('returns the same review as JSON for the key’s sub-account – and nothing of another', async () => {
    const r = await mcp('ghl_growth_review', { location_id: A });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.risks.find((x: any) => x.key === 'risk:overdue_invoices')).toMatchObject({ impact_eur: 1200, link: '/app/invoices' });
    expect(r.data.kpis.pipeline).toBe(13000);
    expect(r.data.idea.key).toBe('growth:reactivation');
    const w = await mcp('ghl_growth_review', { location_id: A, kind: 'weekly' });
    expect(w.data.kind).toBe('weekly');
    const other = await mcp('ghl_growth_review', { location_id: B });
    expect(other.isError).toBe(true);
  });
});

describe('record access: a member with a limited contact view', () => {
  it('only gets lead and "unanswered" counts over the contacts the rules let them see', async () => {
    const admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': A });
    const u = await admin('POST', '/api/users', { email: 'mia@example.com', password: 'passwort-123', name: 'Mia Vertrieb', locations: [A], permissions: ['contacts', 'opportunities', 'conversations', 'payments', 'dashboard'] });
    expect(u.status, JSON.stringify(u.data)).toBe(200);
    const mia = client(t.base, { 'x-pghl': '1', 'x-location-id': A });
    expect((await mia('POST', '/api/auth/login', { email: 'mia@example.com', password: 'passwort-123' })).status).toBe(200);
    // three new leads from the fair, nobody wrote to them yet: one is Mia's, one the boss's, one nobody's
    const ids: string[] = [];
    for (const [i, owner] of [u.data.id, me, null].entries()) {
      const c = await admin('POST', '/api/contacts', { first_name: `Messe${i}`, last_name: 'Lead', email: `messe${i}@example.com`, source: 'Messe' });
      expect(c.status).toBe(200);
      if (owner) await admin('PATCH', `/api/contacts/${c.data.id}`, { assigned_to: owner });
      ids.push(c.data.id);
    }
    const unanswered = (r: any) => r.data.opportunities.find((x: any) => x.key === 'opp:unanswered_leads')?.count ?? 0;
    const before = await mia('GET', '/api/companion/growth');
    expect(before.status, JSON.stringify(before.data)).toBe(200);
    // rules off: Mia sees all three (like the contact list)
    expect(unanswered(before)).toBe(3);
    // only own contacts, unassigned hidden
    expect((await admin('PUT', '/api/sales/access', { enabled: true, rules: { default: { levels: { contacts: 'own' } } } })).status).toBe(200);
    expect((await admin('PUT', '/api/sales/access', { unassigned: 'hide' })).status).toBe(200);
    const list = await mia('GET', '/api/contacts?limit=100');
    const visible = (list.data.contacts ?? list.data).map((c: any) => c.id);
    expect(visible).toEqual([ids[0]]);
    const after = await mia('GET', '/api/companion/growth?kind=weekly');
    expect(unanswered(after)).toBe(1);
    expect(after.data.kpis.leads).toBe(1);
    expect(JSON.stringify(after.data)).not.toMatch(/Messe1|Messe2/);
    // the boss (admin) still counts every lead
    const boss = await t.api.get('/api/companion/growth?kind=weekly');
    expect(unanswered(boss)).toBe(3);
    expect(boss.data.kpis.leads).toBeGreaterThanOrEqual(5);
    await admin('PUT', '/api/sales/access', { enabled: false });
  });
});
