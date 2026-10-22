import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALWAYS_VISIBLE, MODULE_IDS, cleanPrefs } from '../server/services/appearance-model';
import { BASE_CORE, CORE_MAX, GOALS, GOAL_IDS, PRO_KEYS, coreForGoals, isSimple, promotedFrom, proOn, splitNav } from '../server/services/areas-model';
import { allAreas, areaOf, quickActions, registerArea, registerNav } from '../web/src/areas/registry';
import { startTestApp } from './helpers';

/** Every menu route of main.tsx's NAV, in order (the same regex the menu tests use). */
const main = readFileSync(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
const ORDER = [...main.matchAll(/\[\s*'([\w-]+)',\s*'[\w]+',\s*'[^']+',\s*'[^']*'\s*\]/g)].map((m) => m[1]);

describe('Einfach-Modus: goals and the core menu', () => {
  it('goals only name real menu areas and keep the core menu at most ten entries', () => {
    expect(GOALS.map((g) => g.id)).toEqual([...GOAL_IDS]);
    for (const g of GOALS) for (const a of [...g.areas, ...BASE_CORE]) expect([...MODULE_IDS, ...ALWAYS_VISIBLE], `${g.id}: ${a}`).toContain(a);
    for (const g of GOAL_IDS.filter((x) => x !== 'all')) expect(coreForGoals([g], ORDER).length, g).toBeLessThanOrEqual(CORE_MAX);
    expect(coreForGoals(['leads', 'courses', 'agency', 'office'], ORDER).length).toBe(CORE_MAX);
  });

  it('no goals or "Alles" = the classic full menu; otherwise base areas plus the goal areas, in menu order', () => {
    expect(isSimple([])).toBe(false);
    expect(isSimple(['all', 'leads'])).toBe(false);
    expect(coreForGoals([], ORDER)).toEqual(ORDER);
    const leads = coreForGoals(['leads'], ORDER);
    expect(leads).toEqual(expect.arrayContaining(['dashboard', 'conversations', 'contacts', 'calendars', 'tasks', 'opportunities', 'forms', 'funnels']));
    expect(leads).not.toContain('accounting');
    expect(leads).toEqual(ORDER.filter((r) => leads.includes(r)));
    // two goals share the cap fairly: each gets its first areas
    expect(coreForGoals(['leads', 'office'], ORDER)).toEqual(expect.arrayContaining(['opportunities', 'invoices']));
  });
});

describe('Einfach-Modus: adaptive menu', () => {
  const base = { order: ORDER, goals: ['office'], pinned: [] as string[], unpinned: [] as string[] };

  it('splits into core and "Mehr", with pinned, unpinned and the current page', () => {
    const s = splitNav({ ...base, promoted: [] });
    expect(s.core).toContain('invoices');
    expect(s.more).toContain('funnels');
    expect(s.core.length + s.more.length).toBe(ORDER.length);
    const p = splitNav({ ...base, pinned: ['funnels'], unpinned: ['tasks'], promoted: [], current: 'webinars' });
    expect(p.core).toContain('funnels');
    expect(p.core).toContain('webinars');
    expect(p.more).toContain('tasks');
    expect(splitNav({ ...base, goals: [], promoted: [] }).more).toEqual([]);
  });

  it('promotes areas used at least three times in the period – never unpinned ones, never in classic mode', () => {
    const usage = { funnels: 3, social: 2, reports: 7 };
    expect(promotedFrom(usage, base).sort()).toEqual(['funnels', 'reports']);
    expect(promotedFrom(usage, { ...base, unpinned: ['reports'] })).toEqual(['funnels']);
    expect(promotedFrom(usage, { ...base, goals: ['all'] })).toEqual([]);
    expect(splitNav({ ...base, promoted: promotedFrom(usage, base) }).core).toEqual(expect.arrayContaining(['funnels', 'reports']));
  });

  it('Profi-Funktionen are hidden in simple mode until switched on, and always on in the classic menu', () => {
    expect(proOn('invoices.legal', ['office'], [])).toBe(false);
    expect(proOn('invoices.legal', ['office'], ['invoices.legal'])).toBe(true);
    expect(proOn('invoices.legal', [], [])).toBe(true);
    expect(PRO_KEYS.length).toBeGreaterThan(3);
  });

  it('validates the new preferences and drops unknown ids', () => {
    expect(cleanPrefs({ goals: ['leads', 'nope'], pinned: ['funnels', 'x'], unpinned: ['tasks'], pro: ['invoices.legal', 'y'], goal_asked: true })).toEqual({ goals: ['leads'], pinned: ['funnels'], unpinned: ['tasks'], pro: ['invoices.legal'], goal_asked: true });
    expect(() => cleanPrefs({ goals: 'leads' })).toThrow();
  });
});

describe('the area registry', () => {
  it('registers the NAV with sections, descriptions and quick actions; modules can extend an area', () => {
    registerNav([['dashboard', 'dashboard', 'Dashboard', 'dashboard'], ['group', 'Umsatz'], ['invoices', 'invoices', 'Rechnungen & Angebote', 'payments']]);
    expect(areaOf('invoices')).toMatchObject({ section: 'Umsatz', perm: 'payments', label: 'Rechnungen & Angebote' });
    expect(areaOf('invoices')!.desc).toBeTruthy();
    expect(quickActions().map((q) => q.id)).toContain('invoice');
    registerArea({ route: 'invoices', quick: [{ id: 'quote', label: 'Angebot', icon: 'invoices', area: 'invoices', to: 'invoices?new=1' }] });
    expect(areaOf('invoices')!.quick.map((q) => q.id)).toEqual(['invoice', 'quote']);
    expect(allAreas().length).toBe(2);
  });
});

describe('API: goal offer and menu use', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(() => t?.close());

  it('offers the goal setup to a new login, and a banner to one that answered the old profiles', async () => {
    const st = await t.api.get('/api/appearance');
    expect(st.data.offer_profiles).toBe(true);
    expect(st.data.offer_goals).toBe(false);
    await t.api.patch('/api/appearance', { asked: true });
    expect((await t.api.get('/api/appearance')).data.offer_goals).toBe(true);
    const r = await t.api.patch('/api/appearance', { goals: ['leads'], goal_asked: true, pinned: ['webinars'] });
    expect(r.data.effective.goals).toEqual(['leads']);
    expect(r.data.offer_goals).toBe(false);
  });

  it('counts visits per area and day, ignores unknown areas and sums the last 14 days', async () => {
    expect((await t.api.post('/api/nav/usage', { visits: { funnels: 2, nope: 5, reports: 99 } })).data.saved).toBe(2);
    await t.api.post('/api/nav/usage', { visits: { funnels: 1 } });
    const u = await t.api.get('/api/nav/usage');
    expect(u.data.usage).toEqual({ funnels: 3, reports: 50 });
    expect((await t.api.post('/api/nav/usage', { visits: [] })).status).toBe(400);
  });
});
