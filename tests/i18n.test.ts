import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error – plain .mjs script without type declarations
import { checkTranslations, readRegistry, scanSource } from '../scripts/i18n-check.mjs';
import { pickLocale as serverPick } from '../server/modules/language';
import { fmtMoney, getLocale, interpolate, intlLocale, pickLocale, preloadLocale, serverText, setLocale, tr } from '../web/src/i18n';
import { CATALOGS, NAMESPACES } from '../web/src/i18n/registry';
import { startTestApp } from './helpers';

/**
 * The English UI, phase 1 (docs/translating.md): the language layer in the browser, the per-user language on the server and
 * `npm run i18n:check` (scripts/i18n-check.mjs), which keeps the namespaces declared complete complete.
 */

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
function tree(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-check-'));
  tmp.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe('the repository', () => {
  it('every namespace declared complete is translated, nothing German is left in its files, no catalog entry is stale', () => {
    const findings = checkTranslations();
    expect(findings.map((f: any) => `${f.rule} ${f.file}:${f.line} ${f.text}`)).toEqual([]);
  });

  it('the registry the check reads is the one the app loads (languages, namespaces, catalog chunks)', () => {
    const reg = readRegistry();
    expect(reg.source).toBe('de');
    expect(reg.locales).toEqual(['de', 'en']);
    expect(Object.keys(reg.namespaces).sort()).toEqual(Object.keys(NAMESPACES).sort());
    expect(Object.keys(reg.catalogs.en).sort()).toEqual(Object.keys(CATALOGS.en).sort());
    // phase 1: shell, sign-in and the main areas are declared complete
    for (const ns of ['core', 'shell', 'login', 'dashboard', 'contacts', 'deals', 'inbox', 'calendar', 'settings', 'invoices']) expect(reg.namespaces[ns]?.complete, ns).toBe(true);
    // phase 2: workflows, marketing, builders, projects, reports, helpdesk, social, wiki/chat, courses
    for (const ns of ['workflows', 'email', 'campaigns', 'sites', 'forms', 'pm', 'reports', 'helpdesk', 'social', 'collab', 'courses']) expect(reg.namespaces[ns]?.complete, ns).toBe(true);
  });
});

describe('the language layer', () => {
  it('German is the source: texts come back as they are, placeholders filled, merge tags left alone', () => {
    const t = tr('contacts');
    expect(getLocale()).toBe('de');
    expect(t('Neuer Kontakt')).toBe('Neuer Kontakt');
    expect(t('{n} ausgewählt', { n: 3 })).toBe('3 ausgewählt');
    expect(t.plural(1, { one: '{n} Kontakt', other: '{n} Kontakte' })).toBe('1 Kontakt');
    expect(t.plural(4, { one: '{n} Kontakt', other: '{n} Kontakte' })).toBe('4 Kontakte');
    expect(t.plural(0, { zero: 'Keine Kontakte', one: '{n} Kontakt', other: '{n} Kontakte' })).toBe('Keine Kontakte');
    expect(interpolate('Hallo {{contact.first_name}}, {name}', { name: 'Ada' })).toBe('Hallo {{contact.first_name}}, Ada');
    expect(interpolate('{unknown} bleibt', { other: 1 })).toBe('{unknown} bleibt');
    expect(fmtMoney(123456)).toBe('1.234,56 €');
  });

  it('switches to English after loading the catalogs: own namespace, then core, then the German text – never a raw key', async () => {
    const t = tr('contacts');
    await setLocale('en', { remember: false, also: ['contacts', 'inbox'] });
    try {
      expect(getLocale()).toBe('en');
      expect(t('Neuer Kontakt')).toBe('New contact');
      expect(t('Speichern')).toBe('Save'); // from core
      expect(t('Ein Text, den es nicht gibt')).toBe('Ein Text, den es nicht gibt');
      expect(t.plural(1, { one: '{n} Kontakt', other: '{n} Kontakte' })).toBe('1 contact');
      expect(t.plural(2, { one: '{n} Kontakt', other: '{n} Kontakte' })).toBe('2 contacts');
      expect(t('Seite {page} von {pages}', { page: 2, pages: 5 })).toBe('Page 2 of 5');
      // prototype keys are not translations
      expect(t('constructor')).toBe('constructor');
      expect(tr('inbox')('Nicht zugewiesen')).toBe('Unassigned');
      // formatting follows the language
      expect(intlLocale()).toMatch(/^en/);
      expect(fmtMoney(123456)).toMatch(/€1,234\.56/);
      // the server's generic messages are translated where they are shown, the rest stays German
      expect(serverText('Nicht angemeldet')).toBe('Not signed in');
      expect(serverText('Interner Fehler (Request-ID abc-123)')).toBe('Internal error (request ID abc-123)');
      expect(serverText('Fehler 502')).toBe('Error 502');
      expect(serverText('Eine ganz eigene Meldung')).toBe('Eine ganz eigene Meldung');
    } finally {
      await setLocale('de', { remember: false });
    }
    expect(t('Neuer Kontakt')).toBe('Neuer Kontakt');
    expect(serverText('Nicht angemeldet')).toBe('Nicht angemeldet');
  });

  it('every English catalog loads and holds only strings or plural forms with "other"', async () => {
    await preloadLocale('en', Object.keys(CATALOGS.en) as (keyof typeof CATALOGS.en)[]);
    for (const [ns, load] of Object.entries(CATALOGS.en)) {
      const cat = (await load!()).default;
      expect(Object.keys(cat).length, ns).toBeGreaterThan(5);
      for (const [k, v] of Object.entries(cat)) expect(typeof v === 'string' || (typeof v === 'object' && typeof v.other === 'string'), `${ns}: ${k}`).toBe(true);
    }
  });

  it('picks the first supported language of a list, German when none matches', () => {
    expect(pickLocale(['en-US', 'de'])).toBe('en');
    expect(pickLocale(['fr-FR', 'de-AT'])).toBe('de');
    expect(pickLocale(['fr', 'es'])).toBe('de');
    expect(pickLocale(undefined)).toBe('de');
  });
});

describe('the language preference on the server', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(() => t.close());

  it('reads Accept-Language with weights for the login page', async () => {
    expect(serverPick('en-US,en;q=0.9,de;q=0.8')).toBe('en');
    expect(serverPick('de-CH;q=0.5, en;q=0.8')).toBe('en');
    expect(serverPick('fr-FR,fr;q=0.9')).toBe('de');
    expect(serverPick('en;q=0, de')).toBe('de');
    expect(serverPick(undefined)).toBe('de');
    const r = await (await t.api.raw('/api/language', { headers: { 'accept-language': 'en-GB,en;q=0.9' } })).json();
    expect(r).toEqual({ lang: 'en', locales: ['de', 'en'] });
    const de = await (await t.api.raw('/api/language')).json();
    expect(de.lang).toBe('de');
  });

  it('keeps each person’s choice on the user and hands it to the app with /api/me', async () => {
    expect((await t.api.get('/api/me')).data.user.lang).toBeNull();
    expect((await t.api.get('/api/me/language', { 'accept-language': 'en' })).data).toMatchObject({ lang: null, auto: 'en' });
    expect((await t.api.put('/api/me/language', { lang: 'en' })).data).toEqual({ lang: 'en' });
    const me = (await t.api.get('/api/me')).data.user;
    expect(me.lang).toBe('en');
    expect(me.role).toBe('admin'); // the hook adds fields, it never replaces the core ones
    expect((await t.api.put('/api/me/language', { lang: 'fr' })).status).toBe(400);
    expect((await t.api.put('/api/me/language', { lang: { evil: 1 } })).status).toBe(400);
    expect((await t.api.put('/api/me/language', { lang: null })).data).toEqual({ lang: null });
    expect((await t.api.get('/api/me')).data.user.lang).toBeNull();
  });

  it('needs a login to save', async () => {
    const r = await t.api.raw('/api/me/language', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-pghl': '1' }, body: JSON.stringify({ lang: 'en' }) });
    expect(r.status).toBe(401);
  });
});

describe('the check (npm run i18n:check)', () => {
  it('finds t() texts, German UI texts that are not translated, and leaves code, merge tags and ignored lines alone', () => {
    const src = [
      "import { useT } from '../i18n';",
      'export function A() {',
      "  const t = useT('x');",
      "  const timer = setTimeout(() => api.get('/api/contacts?limit=5'), 10);",
      "  if (kind === 'Rechnung') toast(t('Gespeichert'));",
      '  return (',
      '    <div className="card" data-tour="a-card" title="Eigene Ansicht">',
      "      {t('{n} ausgewählt', { n: 2 })} {t.plural(n, { one: '{n} Datei', other: '{n} Dateien' })}",
      '      <p>Noch nichts da.</p>',
      "      <Input placeholder={'{{contact.first_name}}'} />",
      "      <Input placeholder={'import-2026'} />",
      '      {/* i18n-ignore */}',
      '      <code>Bitte nicht übersetzen</code>',
      '      ✕',
      '    </div>',
      '  );',
      '}',
      "const LABELS = { open: 'In Bearbeitung', done: 'erledigt' };",
    ].join('\n');
    const r = scanSource('a.tsx', src);
    expect(r.calls.map((c: any) => c.key)).toEqual(['Gespeichert', '{n} ausgewählt', '{n} Dateien']);
    expect(r.untranslated.map((u: any) => u.text).sort()).toEqual(['Eigene Ansicht', 'In Bearbeitung', 'Noch nichts da.'].sort());
    // a catalog entry makes a dynamically shown text (menu labels, states) count as translated
    expect(scanSource('a.tsx', src, { catalogKeys: new Set(['In Bearbeitung', 'Eigene Ansicht', 'Noch nichts da.']) }).untranslated).toEqual([]);
    // part of a file: only the named components are checked
    expect(scanSource('a.tsx', src, { only: new Set(['B']) }).untranslated.map((u: any) => u.text)).toEqual([]);
  });

  it('reports missing, unused, broken placeholders and unregistered catalogs in a small tree', () => {
    const root = tree({
      'web/src/i18n/registry.ts': [
        "export const LOCALES = { de: { name: 'Deutsch', intl: 'de-DE' }, en: { name: 'English', intl: 'en-GB' } } as const;",
        "export const SOURCE_LOCALE = 'de';",
        "export const NAMESPACES = { core: { complete: true, files: [] }, page: { complete: true, files: ['Page.tsx'] }, later: { complete: false, files: ['Later.tsx'] } } as const;",
        "export const CATALOGS = { en: { core: () => import('./en/core'), page: () => import('./en/page') } };",
      ].join('\n'),
      'web/src/i18n/index.ts': 'export {};\n',
      'web/src/i18n/en/core.ts': "export default { Speichern: 'Save' };\n",
      'web/src/i18n/en/page.ts': "export default { Titel: 'Title', 'Hallo {name}': 'Hello {nam}', Alt: 'Old' };\n",
      'web/src/i18n/en/stray.ts': 'export default {};\n',
      'web/src/Page.tsx': "export function P() { const t = useT('page'); return <h1 title={t('Titel')}>{t('Hallo {name}', { name: 'x' })} {t('Speichern')} {t('Neu hier')}</h1>; }\n",
      'web/src/Later.tsx': "export function L() { const t = useT('later'); return <p>{t('Bald')} Noch Deutsch</p>; }\n",
      'server/x.ts': "export const x = 'nichts';\n",
    });
    const f = checkTranslations(root).map((x: any) => `${x.rule}: ${x.text}`);
    expect(f.sort()).toEqual(
      [
        'missing: Neu hier',
        'placeholders: Hallo {name} → Hello {nam}: {nam} is not in the German text',
        'unused: Alt',
        'registry: catalog file is not registered in CATALOGS.en',
      ].sort(),
    );
    // --todo also lists what is left in namespaces that are not declared complete
    expect(checkTranslations(root, { todo: true }).filter((x: any) => x.rule === 'todo').map((x: any) => x.text)).toEqual(['Bald']);
  });
});
