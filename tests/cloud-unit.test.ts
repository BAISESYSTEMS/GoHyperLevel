import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import {
  DISPOSABLE_DOMAINS,
  PLAN_INFO,
  cleanSettings,
  deletionTimeline,
  daysUntil,
  defaultSettings,
  entitlements,
  formTimeOk,
  isDisposableEmail,
  planKeyOf,
  priceFor,
  tenantSlug,
  yearlyCents,
} from '../server/services/cloud.js';
import { composeMail } from '../server/services/cloud-mail.js';
import { DEFAULT_LEGAL, fillLegal, openPlaceholders } from '../server/services/cloud-legal.js';

describe('cloud: prices and plans', () => {
  it('has the three plans of the price list and no per-seat fee', () => {
    expect(PLAN_INFO.solo).toMatchObject({ price_month_cents: 4999, users: 1, white_label: false, client_accounts: false, custom_domain: false });
    expect(PLAN_INFO.team).toMatchObject({ name: 'Cloud Team & Company', price_month_cents: 9999, users: null, white_label: false, client_accounts: false, custom_domain: false });
    expect(PLAN_INFO.agency).toMatchObject({ price_month_cents: 19900, users: null, white_label: true, client_accounts: true, custom_domain: true });
    // White-label is the Agentur plan's headline; the other plans say plainly that they do not have it.
    expect(PLAN_INFO.agency.highlights[0]).toMatch(/^White-Label/);
    for (const k of ['solo', 'team'] as const) expect(PLAN_INFO[k].highlights.join(' ')).toMatch(/außer White-Label und Kunden-Accounts/);
    expect(planKeyOf('cloud-team')).toBe('team');
    expect(planKeyOf('cloud-agency-client')).toBeUndefined();
  });

  it('computes the yearly price from the discount, in whole euros, never below the advertised discount', () => {
    // 49,99 € × 12 = 599,88 €, minus 20 % = 479,90 € → 479 € (rounding up to 480 € would give less than 20 %)
    expect(yearlyCents(4999, 20)).toBe(47900);
    expect(yearlyCents(9999, 20)).toBe(95900);
    expect(yearlyCents(19900, 20)).toBe(191000);
    expect(yearlyCents(4900, 20)).toBe(47000);
    expect(yearlyCents(7900, 20)).toBe(75800);
    expect(yearlyCents(29900, 20)).toBe(287000);
    expect(yearlyCents(4900, 0)).toBe(58800);
    for (const m of [4999, 9999, 19900, 12345]) for (const d of [0, 10, 20, 35]) expect(yearlyCents(m, d)).toBeLessThanOrEqual(m * 12 * (1 - d / 100));
    const s = defaultSettings({});
    expect(s.prices).toEqual({ solo: 4999, team: 9999, agency: 19900 });
    expect(priceFor(s, 'team', 'month')).toBe(9999);
    expect(priceFor(s, 'team', 'year')).toBe(95900);
    expect(priceFor(s, 'solo', 'year')).toBe(47900);
    expect(priceFor(s, 'agency', 'year')).toBe(191000);
  });

  it('gives every plan every feature and limits only users and clients', () => {
    const s = defaultSettings({});
    expect(entitlements('solo', s)).toEqual({ users: 1, white_label: false, client_accounts: false, custom_domain: false, max_clients: null });
    expect(entitlements('agency', { agency_max_clients: 40 })).toMatchObject({ client_accounts: true, max_clients: 40 });
    expect(entitlements('agency', { agency_max_clients: 0 }).max_clients).toBeNull();
  });
});

describe('cloud: settings', () => {
  it('validates input with German messages and keeps what was not sent', () => {
    const cur = defaultSettings({});
    const next = cleanSettings({ trial_days: 21, prices: { team: 8900 }, fair_use: { team: { emails: '', ai: 5000 } }, extra_blocked_domains: 'Wegwerf.example, @Muell.test' }, cur);
    expect(next.trial_days).toBe(21);
    expect(next.prices).toEqual({ solo: 4999, team: 8900, agency: 19900 });
    expect(next.fair_use.team).toMatchObject({ emails: null, ai: 5000, sms: 0 });
    expect(next.extra_blocked_domains).toEqual(['wegwerf.example', 'muell.test']);
    expect(cur.trial_days).toBe(14);
    expect(() => cleanSettings({ retention_days: 0 }, cur)).toThrow(/Aufbewahrung/);
    expect(() => cleanSettings({ extra_blocked_domains: 'kein domain' }, cur)).toThrow(/Domains/);
    expect(() => cleanSettings({ operator: { name: 'x'.repeat(300) } }, cur)).toThrow(/zu lang/);
  });

  it('reads defaults from the environment', () => {
    expect(defaultSettings({ PGHL_CLOUD_TRIAL_DAYS: '30', PGHL_CLOUD_DOMAIN: 'https://Cloud.Example.com/', PGHL_CLOUD_CARD_REQUIRED: '0' })).toMatchObject({ trial_days: 30, cloud_domain: 'cloud.example.com', card_required: false });
    expect(defaultSettings({ PGHL_CLOUD_TRIAL_DAYS: 'abc' }).trial_days).toBe(14);
  });
});

describe('cloud: dunning timeline', () => {
  it('schedules the export offer after the retention time and the deletion after the notice period', () => {
    const tl = deletionTimeline('2026-10-01T00:00:00.000Z', { retention_days: 30, deletion_notice_days: 14 });
    expect(tl).toEqual({ read_only_since: '2026-10-01T00:00:00.000Z', schedule_at: '2026-10-31T00:00:00.000Z', delete_at: '2026-11-14T00:00:00.000Z' });
    expect(daysUntil('2026-10-10T12:00:00.000Z', new Date('2026-10-05T00:00:00.000Z'))).toBe(6);
    expect(daysUntil('2026-10-01T00:00:00.000Z', new Date('2026-10-05T00:00:00.000Z'))).toBe(0);
  });
});

describe('cloud: abuse protection', () => {
  it('recognises throw-away providers and their subdomains', () => {
    expect(DISPOSABLE_DOMAINS.length).toBeGreaterThan(60);
    expect(isDisposableEmail('a@mailinator.com')).toBe(true);
    expect(isDisposableEmail('a@mail.yopmail.com')).toBe(true);
    expect(isDisposableEmail('a@gmail.com')).toBe(false);
    expect(isDisposableEmail('a@firma.de', ['firma.de'])).toBe(true);
    expect(isDisposableEmail('kein-at-zeichen')).toBe(false);
  });

  it('accepts a form time token only when it is genuine and neither too fresh nor too old', () => {
    const ok = () => true;
    const now = 1_800_000_000_000;
    expect(formTimeOk(`${now - 5000}.abc`, ok, now)).toBe(true);
    expect(formTimeOk(`${now - 500}.abc`, ok, now)).toBe(false);
    expect(formTimeOk(`${now - 25 * 3600_000}.abc`, ok, now)).toBe(false);
    expect(formTimeOk(`${now - 5000}.abc`, () => false, now)).toBe(false);
    expect(formTimeOk('', ok, now)).toBe(false);
    expect(formTimeOk('abc.def', ok, now)).toBe(false);
  });
});

describe('cloud: slugs', () => {
  it('makes DNS-safe, unique sub-domain names and avoids reserved words', () => {
    const taken = new Set(['muster-gmbh']);
    expect(tenantSlug('Muster GmbH', (s) => taken.has(s))).toBe('muster-gmbh-2');
    expect(tenantSlug('Müller & Söhne', () => false)).toBe('muller-sohne');
    expect(tenantSlug('www', () => false)).toBe('www-co');
    expect(tenantSlug('API', () => false)).toBe('api-co');
    expect(tenantSlug('A', () => false)).toMatch(/^firma/);
    expect(tenantSlug('!!!', () => false)).toMatch(/^firma/);
    expect(tenantSlug('x'.repeat(100), () => false).length).toBeLessThanOrEqual(30);
    expect(tenantSlug('Muster GmbH', () => true, () => 'ab')).toBe('muster-gmbh-abab');
    for (const name of ['Café Zürich', 'Ärzte-Praxis Dr. Meier', '  spaces  ', 'UPPER']) expect(tenantSlug(name, () => false)).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });
});

describe('cloud: texts', () => {
  it('fills the legal placeholders and keeps the unknown ones visible', () => {
    const vars = { operator: { name: 'Beispiel UG', street: 'Weg 1', zip_city: '12345 Stadt', country: 'Deutschland', email: '', phone: '', vat_id: '', register: '', representative: '' }, service: 'HyperLevel', company: 'Kunde GmbH', trial_days: 14, grace_days: 7, retention_days: 30, deletion_notice_days: 14, version: 3, date: '05.10.2026' };
    const out = fillLegal(DEFAULT_LEGAL.avv, vars);
    expect(out).toContain('Kunde GmbH');
    expect(out).toContain('Beispiel UG**, Weg 1, 12345 Stadt, Deutschland');
    expect(out).toContain('Version 3');
    expect(openPlaceholders(fillLegal(DEFAULT_LEGAL.impressum, vars))).toEqual(expect.arrayContaining(['operator.email', 'operator.vat_id']));
    expect(DEFAULT_LEGAL.agb).toMatch(/keine Rechtsberatung/);
    expect(DEFAULT_LEGAL.agb).toContain('{{grace_days}}');
  });

  it('composes mails with the action as a link and no markup from names', () => {
    const m = composeMail('verify', { brand: 'HyperLevel', name: '<b>Mia</b>', company: 'A & B', link: 'https://x.example/start/verify/abc' });
    expect(m.subject).toContain('bestätige');
    expect(m.text).toContain('https://x.example/start/verify/abc');
    expect(m.html).not.toContain('<b>Mia</b>');
    expect(m.html).toContain('&lt;b&gt;Mia&lt;/b&gt;');
    expect(composeMail('deletion_scheduled', { brand: 'X', company: 'Y', delete_at: '01.12.2026', link: 'https://x.example' }).subject).toContain('01.12.2026');
  });
});

describe('cloud mode is off by default', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(async () => t.close());

  it('registers no route, guard or hook for self-hosters', async () => {
    const routes = (t.app.router as any).routes as { pattern: string }[];
    expect(routes.filter((r) => /^\/(cloud|start)(\/|$)|^\/api\/cloud\/|^\/api\/public\/cloud\//.test(r.pattern))).toEqual([]);
    expect(t.app.services.cloud).toBeUndefined();
    expect((await t.api.get('/api/cloud/me')).status).toBe(404);
    expect((await t.api.get('/api/public/cloud/pricing')).status).toBe(404);
    expect((await t.api.get('/api/version')).data.cloud).toBeNull();
    expect(t.app.db.get(`SELECT 1 AS x FROM saas_plans WHERE id LIKE 'cloud-%'`)).toBeUndefined();
  });
});
