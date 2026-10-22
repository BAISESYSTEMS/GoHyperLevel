import { describe, expect, it } from 'vitest';
import { AGENCY_ESSENTIAL, AGENCY_GROUPS, AGENCY_KEYWORDS, essentialSettings, groupSettings, searchSettings, searchTabs, SETTINGS_ESSENTIAL, SETTINGS_GROUPS, SETTINGS_KEYWORDS, splitAgencyTabs, splitSettingsTabs } from '../web/src/areas/settings-nav';
import { missingSetup, setupSteps, type SetupFacts } from '../web/src/areas/setup-model';
import { GOAL_IDS } from '../server/services/areas-model';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The tab keys of Einstellungen as Settings.tsx declares them (an admin with a SaaS plan sees all of them).
const TABS = [
  'company', 'messaging', 'deliverability', 'channels', 'more-channels', 'telephony', 'billing', 'stripe', 'reviews', 'chat', 'ai', 'ai-tools', 'helpdesk', 'inbox',
  'fields', 'custom-values', 'consent', 'api', 'ai-providers', 'voice', 'memory', 'import', 'umzug', 'team', 'locations', 'subscription', 'appearance', 'account',
];

describe('Einstellungen in Einfach-Modus: which sections are in the tab bar', () => {
  it('shows every tab in Profi and without goals', () => {
    expect(splitSettingsTabs(TABS, { goals: [] })).toEqual({ main: TABS, more: [] });
    expect(splitSettingsTabs(TABS, { goals: ['all'] })).toEqual({ main: TABS, more: [] });
    expect(splitSettingsTabs(TABS, { goals: ['leads', 'all'] }).more).toEqual([]);
    expect(essentialSettings(['all'])).toBeNull();
  });

  it('keeps the essential sections plus the goal extras, in tab order, and folds the rest', () => {
    const { main, more } = splitSettingsTabs(TABS, { goals: ['leads'] });
    expect(main).toEqual(['company', 'messaging', 'channels', 'chat', 'ai-providers', 'team', 'subscription', 'appearance', 'account']);
    expect(more).toContain('api');
    expect(more).toContain('deliverability');
    expect([...main, ...more].sort()).toEqual([...TABS].sort());
    expect(splitSettingsTabs(TABS, { goals: ['office'] }).main).toEqual(expect.arrayContaining(['billing', 'stripe']));
    expect(splitSettingsTabs(TABS, { goals: ['agency'] }).main).toContain('locations');
  });

  it('a busy admin sees at most ten tabs in Einfach-Modus, whatever the goals', () => {
    for (const g of GOAL_IDS.filter((x) => x !== 'all')) expect(splitSettingsTabs(TABS, { goals: [g] }).main.length).toBeLessThanOrEqual(10);
    expect(splitSettingsTabs(TABS, { goals: ['leads', 'office'] }).main.length).toBeLessThanOrEqual(11);
  });

  it('the open section always stays in the bar (links and tours into a folded section keep working)', () => {
    const { main, more } = splitSettingsTabs(TABS, { goals: ['leads'], current: 'api' });
    expect(main).toContain('api');
    expect(more).not.toContain('api');
  });

  it('only offers sections the login has (no Team for members) and never ends up with an empty bar', () => {
    const member = TABS.filter((k) => !['team', 'locations', 'subscription'].includes(k));
    expect(splitSettingsTabs(member, { goals: ['leads'] }).main).not.toContain('team');
    expect(splitSettingsTabs(['voice', 'memory'], { goals: ['leads'] })).toEqual({ main: ['voice', 'memory'], more: [] });
  });

  it('every section has a group and search words; the essential list names real sections', () => {
    const grouped = SETTINGS_GROUPS.flatMap((g) => g.tabs);
    for (const k of TABS) {
      expect(grouped, k).toContain(k);
      expect(SETTINGS_KEYWORDS[k], k).toBeTruthy();
    }
    for (const k of SETTINGS_ESSENTIAL) expect(TABS).toContain(k);
  });

  it('groups the folded sections without duplicates, unknown ones last', () => {
    const groups = groupSettings(['api', 'deliverability', 'billing', 'mystery']);
    expect(groups).toEqual([
      { id: 'messages', tabs: ['deliverability'] },
      { id: 'money', tabs: ['billing'] },
      { id: 'data', tabs: ['api'] },
      { id: 'other', tabs: ['mystery'] },
    ]);
  });

  it('finds a section by label, key or what people type (SMTP, IBAN, Webhook), ignoring case and umlauts', () => {
    const tabs: [string, string][] = [
      ['messaging', 'E-Mail & SMS'],
      ['billing', 'Rechnungen'],
      ['api', 'API & Webhooks'],
      ['consent', 'Einwilligung & Recht'],
      ['ai-providers', 'KI-Anbieter (BYOK)'],
    ];
    expect(searchSettings('smtp', tabs)).toEqual(['messaging']);
    expect(searchSettings('IBAN', tabs)).toEqual(['billing']);
    expect(searchSettings('webhook', tabs)).toEqual(['api']);
    expect(searchSettings('dsgvo', tabs)).toEqual(['consent']);
    expect(searchSettings('Öffnungen', tabs)).toEqual(['messaging']);
    expect(searchSettings('offnungen', tabs)).toEqual(['messaging']);
    expect(searchSettings('anthropic schlüssel', tabs)).toEqual(['ai-providers']);
    expect(searchSettings('  ', tabs)).toEqual(tabs.map(([k]) => k));
  });

  it('Settings.tsx declares exactly the sections the rules know', () => {
    const file = readFileSync(join(__dirname, '../web/src/pages/Settings.tsx'), 'utf8');
    const src = file.slice(file.indexOf('const tabs: [string, string][] = ['), file.indexOf('<PageHead'));
    const declared = [...src.matchAll(/\['([a-z-]+)', (?:cloud \? )?t\('/g)].map((m) => m[1]);
    expect(new Set(declared)).toEqual(new Set(TABS));
  });
});

describe('Agentur in Einfach-Modus', () => {
  const file = readFileSync(join(__dirname, '../web/src/pages/Agency.tsx'), 'utf8');
  const block = file.slice(file.indexOf('<AgencyTabs'), file.indexOf('value={tab}', file.indexOf('<AgencyTabs')));
  const AGENCY = [...block.matchAll(/\['([a-z-]+)', '/g)].map((m) => m[1]);

  it('reads the real tab list of Agency.tsx', () => {
    expect(AGENCY.length).toBeGreaterThan(15);
    expect(AGENCY).toContain('cloud');
  });

  it('shows every tab in Profi, the weekly ones plus the open one in Einfach-Modus', () => {
    expect(splitAgencyTabs(AGENCY, { goals: ['all'] }).more).toEqual([]);
    const { main, more } = splitAgencyTabs(AGENCY, { goals: ['agency'], current: 'audit' });
    expect(main).toEqual(AGENCY.filter((k) => [...AGENCY_ESSENTIAL, 'audit'].includes(k)));
    expect(more).toContain('api');
    expect(more).not.toContain('audit');
  });

  it('every Agentur tab has a group and search words', () => {
    const grouped = AGENCY_GROUPS.flatMap((g) => g.tabs);
    for (const k of AGENCY) {
      expect(grouped, k).toContain(k);
      expect(AGENCY_KEYWORDS[k], k).toBeTruthy();
    }
    expect(searchTabs('sso', [['login', 'Anmeldung'], ['api', 'API & MCP']], AGENCY_KEYWORDS)).toEqual(['login']);
  });
});

describe('"Was muss ich einrichten?"', () => {
  const ready: SetupFacts = {
    goals: ['office'],
    admin: true,
    location: { name: 'Muster GmbH', email: 'info@muster.de', address: 'Hauptstr. 1, 10115 Berlin', settings: { email: { provider: 'smtp' } } },
    ai: true,
    invoice: { street: 'Hauptstr. 1', city: 'Berlin', tax_number: '12/345/67890' },
    payments: true,
    twoFactor: true,
  };

  it('shows nothing when everything is set up', () => {
    expect(missingSetup(ready)).toEqual([]);
    expect(setupSteps(ready).map((s) => s.key)).toEqual(['company', 'email', 'ai', 'invoice', 'payments', 'twofactor']);
  });

  it('lists only what is missing, each with the section that fixes it', () => {
    const fresh: SetupFacts = { ...ready, location: { name: 'Neu', email: '', address: '', settings: {} }, ai: false, twoFactor: false };
    expect(missingSetup(fresh).map((s) => [s.key, s.to])).toEqual([
      ['company', 'settings/company'],
      ['email', 'settings/messaging'],
      ['ai', 'settings/ai-providers'],
      ['twofactor', 'settings/account'],
    ]);
  });

  it('"Nur speichern" (log) does not count as e-mail sending; a connected mailbox does', () => {
    const withProvider = (provider?: string): SetupFacts => ({ ...ready, location: { ...ready.location!, settings: { email: provider ? { provider } : null } } });
    expect(missingSetup(withProvider('log')).map((s) => s.key)).toEqual(['email']);
    expect(missingSetup(withProvider()).map((s) => s.key)).toEqual(['email']);
    expect(missingSetup(withProvider('mailbox'))).toEqual([]);
  });

  it('invoice details and online payment only for goals that sell (Rechnungen & Büro, Kurse)', () => {
    const leads: SetupFacts = { ...ready, goals: ['leads'], invoice: {}, payments: false };
    expect(missingSetup(leads)).toEqual([]);
    expect(missingSetup({ ...leads, goals: ['courses'] }).map((s) => s.key)).toEqual(['invoice', 'payments']);
    // a VAT id instead of a tax number is enough
    expect(missingSetup({ ...ready, invoice: { street: 'X 1', city: 'Y', vat_id: 'DE123456789' } })).toEqual([]);
  });

  it('two-factor login only for admins; facts that could not be loaded never nag', () => {
    expect(missingSetup({ ...ready, admin: false, twoFactor: false })).toEqual([]);
    expect(setupSteps({ goals: ['office'], admin: true })).toEqual([]);
    expect(setupSteps({ goals: ['office'], admin: true, ai: null, payments: null, twoFactor: null, location: null, invoice: null })).toEqual([]);
  });
});
