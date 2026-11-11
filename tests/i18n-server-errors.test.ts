import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { ERRORS_EN, errorText } from '../server/i18n/errors-en.js';

/** Error answers ({ error: … }) follow the web app's language (header x-pghl-lang); every other client keeps German. */

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(async () => {
  await t.close();
});

describe('error messages', () => {
  it('stay German by default and turn English with x-pghl-lang: en, field names included', async () => {
    const de = await t.api.get('/api/contacts/nope');
    expect(de.status).toBe(404);
    expect(de.data.error).toBe('Kontakt nicht gefunden');
    const en = await t.api.get('/api/contacts/nope', { 'x-pghl-lang': 'en' });
    expect(en.data.error).toBe('Contact not found');
    const missing = await t.api.post('/api/tags', {}, { 'x-pghl-lang': 'en' });
    expect(missing.status).toBe(400);
    expect(missing.data.error).not.toMatch(/fehlt|[äöüß]/);
  });

  it('a request without sign-in gets “Not signed in” in English', async () => {
    const r = await fetch(t.base + '/api/me', { headers: { 'x-pghl': '1', 'x-pghl-lang': 'en' } });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe('Not signed in');
  });

  it('translates exact texts, templates and field names, and never mixes the two languages', () => {
    expect(errorText('Betreff fehlt')).toBe('Subject is missing');
    expect(errorText('„Telefon“ muss eine Zahl sein')).toBe('“Phone” must be a number');
    expect(errorText('Nicht angemeldet')).toBe('Not signed in');
    expect(errorText('Zu viele Anfragen')).toBe('Too many requests');
    expect(errorText('Tage: 1 bis 90')).toBe('Days: 1 to 90');
    // a value that stays German keeps the whole message German
    expect(errorText('Die Hausnummer der Firma fehlt')).toBe('Die Hausnummer der Firma fehlt');
    expect(errorText('Etwas völlig Unbekanntes')).toBe('Etwas völlig Unbekanntes');
  });

  it('the catalogue keeps placeholders and has no long dashes', () => {
    for (const [de, en] of Object.entries(ERRORS_EN)) {
      expect(en.match(/\{v\d\}/g)?.sort(), de).toEqual(de.match(/\{v\d\}/g)?.sort());
      expect(en, de).not.toMatch(/—/);
    }
  });
});
