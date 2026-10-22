import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/**
 * The public form in a real browser (headless Chromium through Playwright): a classic form, several pages with show-if and a jump, one
 * question at a time with scoring, calculator, widgets and a signature, Turnstile (the widget is replaced by a stand-in), file upload.
 * Opt in, it needs Playwright and a Chromium and takes a few seconds:
 *
 *   PGHL_BROWSER_TESTS=1 npx vitest run tests/form-browser.test.ts        (PGHL_CHROME=<path> or PLAYWRIGHT_MODULE=<path> if not found)
 */

function loadPlaywright(): any {
  const global = (() => {
    try {
      return execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();
  const candidates = [process.env.PLAYWRIGHT_MODULE, join(process.cwd(), 'node_modules/playwright'), join(process.cwd(), 'node_modules/playwright-core'), global && join(global, 'playwright'), global && join(global, 'playwright-core')].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      return createRequire(import.meta.url)(c);
    } catch {
      /* next */
    }
  }
  return null;
}
const playwright = process.env.PGHL_BROWSER_TESTS ? loadPlaywright() : null;
const chrome = [process.env.PGHL_CHROME, '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p));

describe.skipIf(!process.env.PGHL_BROWSER_TESTS || !playwright)('public forms in a browser', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let browser: any;
  const mk = async (name: string, fields: any[], settings: Record<string, any> = {}) => (await t.api.post('/api/forms', { name, fields, settings })).data;
  const subs = async (id: string) => (await t.api.get(`/api/forms/${id}/submissions`)).data as any[];
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const TURNSTILE = (auto: boolean) => `window.turnstile={render:function(el,o){${auto ? "setTimeout(function(){o.callback('good-token')},60);" : ''}return 'w'},reset:function(){}};`;

  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    t.app.services.turnstileFetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
    browser = await playwright.chromium.launch({ ...(chrome ? { executablePath: chrome } : {}), args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await t?.close();
  });

  async function open(id: string, o: { turnstile?: boolean | null } = {}) {
    const page = await (await browser.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
    const seen = { errors: [] as string[], posts: [] as { url: string; body: string | null }[] };
    page.on('pageerror', (e: Error) => seen.errors.push(String(e)));
    page.on('console', (m: any) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && seen.errors.push(m.text()));
    page.on('request', (r: any) => r.method() === 'POST' && seen.posts.push({ url: r.url(), body: r.postData() }));
    await page.route('https://challenges.cloudflare.com/**', (r: any) => r.fulfill({ contentType: 'text/javascript', body: o.turnstile === null || o.turnstile === undefined ? '' : TURNSTILE(o.turnstile) }));
    await page.route('https://example.com/**', (r: any) => r.fulfill({ contentType: 'image/png', body: PNG }));
    await page.goto(`${t.base}/f/${id}`);
    return { page, seen };
  }
  const text = async (page: any, sel: string) => (((await page.locator(sel).first().textContent()) ?? '') as string).replace(/\s+/g, ' ').trim();
  const sent = (seen: { posts: { url: string; body: string | null }[] }) => JSON.parse(seen.posts.find((p) => p.url.endsWith('/submit'))!.body!);
  const events = (seen: { posts: { url: string; body: string | null }[] }) => seen.posts.filter((p) => p.url.endsWith('/track')).flatMap((p) => JSON.parse(p.body!).e as string[][]);
  const done = (page: any) => page.waitForSelector('.pf-done:not([hidden])');

  it('runs a classic form: checks, submits, reports analytics and nothing else', async () => {
    const f = await mk('Klassisch', [
      { id: 'f1', type: 'text', label: 'Vorname', name: 'first_name', required: true },
      { id: 'f2', type: 'email', label: 'E-Mail', name: 'email', required: true },
      { id: 'f3', type: 'consent', label: 'Einverstanden', name: 'consent', required: true },
    ]);
    const { page, seen } = await open(f.id);
    expect(await text(page, '.pf-next')).toBe('Absenden');
    expect(await page.locator('.pf-back, .pf-progress, .pf-captcha').count()).toBe(0);
    await page.click('.pf-next');
    expect(await page.locator('.pf-q[data-bad="1"]').count()).toBe(3);
    expect(await text(page, '.pf-q[data-name=email] .pf-err')).toBe('Bitte ausfüllen.');
    await page.fill('[name=first_name]', 'Erika');
    await page.fill('[name=email]', 'kaputt');
    await page.locator('[name=email]').blur();
    await page.click('.pf-next');
    expect(await text(page, '.pf-q[data-name=email] .pf-err')).toBe('Bitte eine gültige E-Mail-Adresse angeben.');
    await page.fill('[name=email]', 'erika@example.de');
    await page.locator('[name=email]').blur();
    await page.locator('.pf-q[data-name=consent] .pf-opt').click();
    await page.click('.pf-next');
    await done(page);
    expect(await text(page, '.pf-done')).toMatch(/^Danke/);
    expect(await page.locator('form.pghl-form').isVisible()).toBe(false);
    expect(sent(seen)).toMatchObject({ first_name: 'Erika', email: 'erika@example.de', consent: 'ja' });
    await page.waitForTimeout(200);
    expect(['o', 'v', 'a', 's'].every((k) => events(seen).some((e) => e[0] === k))).toBe(true);
    expect(seen.posts.some((p) => p.url.endsWith('/partial'))).toBe(false);
    expect((await subs(f.id)).map((s) => s.first_name)).toEqual(['Erika']);
    expect(seen.errors).toEqual([]);
  }, 60_000);

  it('runs a single page with show-if: hidden from the start, required only while shown, calculator live', async () => {
    const f = await mk(
      'Bedingung',
      [
        { id: 'c1', type: 'radio', label: 'Art', name: 'art', options: ['Website', 'Shop'], required: true },
        { id: 'c2', type: 'number', label: 'Produkte', name: 'produkte', required: true, show_if: { field: 'art', op: 'eq', value: 'Shop' } },
        { id: 'c3', type: 'calculator', label: 'Preis', name: 'preis', formula: 'produkte * 10 + 100', format: 'currency' },
      ],
      { show_result: true },
    );
    const { page, seen } = await open(f.id);
    expect(await page.locator('.pf-q[data-name=produkte]').isVisible()).toBe(false);
    expect(await text(page, '.pf-calc-v')).toBe('100,00 €');
    await page.locator('.pf-opt', { hasText: 'Shop' }).click();
    expect(await page.locator('.pf-q[data-name=produkte]').isVisible()).toBe(true);
    await page.fill('[name=produkte]', '4');
    expect(await text(page, '.pf-calc-v')).toBe('140,00 €');
    await page.locator('.pf-opt', { hasText: 'Website' }).click();
    expect(await page.locator('.pf-q[data-name=produkte]').isVisible()).toBe(false);
    await page.click('.pf-next');
    await done(page);
    expect(sent(seen)).toMatchObject({ art: 'Website' });
    expect(sent(seen)).not.toHaveProperty('produkte');
    expect(await text(page, '.pf-done h2')).toBe('Dein Ergebnis');
    expect(seen.errors).toEqual([]);
  }, 60_000);

  it('runs several pages: show-if, jump to a page, back, Alt + arrows', async () => {
    const f = await mk('Seiten', [
      { id: 'm1', type: 'radio', label: 'Kunde?', name: 'kunde', options: ['Ja', 'Nein'], required: true, jumps: [{ op: 'eq', value: 'Nein', goto: 'page:3' }] },
      { id: 'm2', type: 'text', label: 'Nummer', name: 'nummer', required: true, show_if: { field: 'kunde', op: 'eq', value: 'Ja' } },
      { id: 'm3', type: 'page_break', label: '', name: 'pb1' },
      { id: 'm4', type: 'text', label: 'Zweite Seite', name: 'zweite', required: true },
      { id: 'm5', type: 'page_break', label: '', name: 'pb2' },
      { id: 'm6', type: 'email', label: 'E-Mail', name: 'email', required: true },
    ]);
    const { page, seen } = await open(f.id);
    expect(await text(page, '.pf-count')).toBe('Schritt 1 von 3');
    expect(await page.locator('.pf-back').isVisible()).toBe(false);
    expect(await page.locator('.pf-q[data-name=nummer]').isVisible()).toBe(false);
    await page.locator('.pf-opt', { hasText: 'Ja' }).click();
    expect(await page.locator('.pf-q[data-name=nummer]').isVisible()).toBe(true);
    await page.locator('.pf-opt', { hasText: 'Nein' }).click();
    expect(await page.locator('[name=nummer]').evaluate((e: HTMLInputElement) => e.disabled)).toBe(true);
    await page.click('.pf-next');
    expect(await text(page, '.pf-count')).toBe('Schritt 3 von 3');
    expect(await text(page, '.pf-next')).toBe('Absenden');
    await page.click('.pf-back');
    expect(await text(page, '.pf-count')).toBe('Schritt 1 von 3');
    await page.locator('.pf-opt', { hasText: 'Ja' }).click();
    await page.fill('[name=nummer]', '4711');
    await page.keyboard.press('Alt+ArrowDown');
    expect(await text(page, '.pf-count')).toBe('Schritt 2 von 3');
    await page.keyboard.press('Alt+ArrowUp');
    expect(await text(page, '.pf-count')).toBe('Schritt 1 von 3');
    await page.click('.pf-next');
    await page.fill('[name=zweite]', 'Hallo');
    await page.press('[name=zweite]', 'Enter');
    await page.fill('[name=email]', 'm@example.de');
    await page.press('[name=email]', 'Enter');
    await done(page);
    expect((await subs(f.id))[0].data).toMatchObject({ Nummer: '4711', 'Zweite Seite': 'Hallo', 'Kunde?': 'Ja' });
    expect(seen.errors).toEqual([]);
  }, 60_000);

  it('keeps the keyboard in the form: the focus follows to the next screen, also one without a field to type into', async () => {
    const tf = await mk(
      'Tastatur',
      [
        { id: 'k1', type: 'text', label: 'Name', name: 'first_name', required: true },
        { id: 'k2', type: 'rating', label: 'Wie gut?', name: 'rating' },
        { id: 'k3', type: 'radio', label: 'Wie?', name: 'wie', options: ['Gut', 'Schlecht'] },
        { id: 'k4', type: 'email', label: 'E-Mail', name: 'email', required: true },
      ],
      { mode: 'typeform' },
    );
    const { page, seen } = await open(tf.id);
    const active = '.pghl-step[data-state=active]';
    await page.fill('[name=first_name]', 'Max');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    expect(await text(page, `${active} .pf-label`)).toBe('Wie gut?');
    // stars have no field to type into: the screen takes the focus (it used to fall to the page, and Enter did nothing)
    expect(await page.evaluate(() => !!document.activeElement?.matches('.pghl-step[data-state=active]'))).toBe(true);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    expect(await text(page, `${active} .pf-label`)).toBe('Wie?');
    await page.keyboard.press('b'); // the option letters work without clicking into the question first
    await page.waitForTimeout(800);
    expect(await text(page, `${active} .pf-label`)).toMatch(/^E-Mail/);
    await page.keyboard.type('max@example.de');
    await page.keyboard.press('Enter');
    await done(page);
    expect((await subs(tf.id))[0].data).toMatchObject({ Name: 'Max', 'Wie?': 'Schlecht' });
    // classic pages: Enter on the last field of a page puts the cursor into the first field of the next one
    const pages = await mk('Seiten Tastatur', [
      { id: 'p1', type: 'text', label: 'Vorname', name: 'first_name', required: true },
      { id: 'p2', type: 'page_break', label: '', name: 'pb' },
      { id: 'p3', type: 'email', label: 'E-Mail', name: 'email', required: true },
    ]);
    const second = await open(pages.id);
    await second.page.fill('[name=first_name]', 'Erika');
    await second.page.keyboard.press('Enter');
    await second.page.waitForTimeout(200);
    expect(await second.page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name)).toBe('email');
    await second.page.keyboard.type('erika@example.de');
    await second.page.keyboard.press('Enter');
    await done(second.page);
    expect(seen.errors.concat(second.seen.errors)).toEqual([]);
  }, 60_000);

  it('runs one question at a time: welcome, letters, jump, score, calculator, widgets, signature, ending', async () => {
    const f = await mk(
      'Alles',
      [
        { id: 'a1', type: 'text', label: 'Wie heißt du?', name: 'first_name', required: true },
        { id: 'a2', type: 'email', label: 'E-Mail', name: 'email', required: true },
        { id: 'a3', type: 'radio', label: 'Kunde?', name: 'kunde', options: ['Ja', 'Nein', 'Vielleicht'], required: true, points: { Ja: 2, Nein: 5, Vielleicht: 1 }, jumps: [{ op: 'eq', value: 'Nein', goto: 'a6' }] },
        { id: 'a4', type: 'number', label: 'Kundennummer', name: 'nummer', show_if: { field: 'kunde', op: 'eq', value: 'Ja' } },
        { id: 'a5', type: 'textarea', label: 'Anliegen', name: 'anliegen' },
        { id: 'a6', type: 'rating', label: 'Sterne', name: 'sterne', max: 5, weight: 1 },
        { id: 'a7', type: 'scale', label: 'Zufriedenheit', name: 'zufrieden', style: 'slider', min: 1, max: 10, weight: 1 },
        { id: 'a8', type: 'nps', label: 'Weiterempfehlen?', name: 'nps' },
        { id: 'a9', type: 'date_range', label: 'Wann?', name: 'zeitraum' },
        { id: 'a10', type: 'ranking', label: 'Was zählt?', name: 'rang', options: ['Preis', 'Qualität', 'Tempo'] },
        { id: 'a11', type: 'picture_choice', label: 'Bild', name: 'bild', options: ['Eins', 'Zwei'], images: ['https://example.com/a.png', 'https://example.com/b.png'], points: { Eins: 1, Zwei: 3 } },
        { id: 'a12', type: 'number', label: 'Menge', name: 'menge', min: 1, max: 100 },
        { id: 'a13', type: 'calculator', label: 'Richtpreis', name: 'richtpreis', formula: 'menge * 12.5 + score', format: 'currency' },
        { id: 'a14', type: 'signature', label: 'Unterschrift', name: 'unterschrift' },
        { id: 'a16', type: 'consent', label: 'Einverstanden', name: 'consent', required: true },
      ],
      { mode: 'typeform', welcome: { title: 'Willkommen', text: 'Kurz.', button: 'Los' }, endings: [{ min: 10, max: null, title: 'Sehr gut', text: 'Du hast {{score}} Punkte.' }, { min: null, max: 9, title: 'Ok', text: 'Du hast {{score}} Punkte.' }], show_result: true },
    );
    const { page, seen } = await open(f.id);
    const active = '.pghl-step[data-state=active]';
    expect(await page.locator('.pf-welcome').isVisible()).toBe(true);
    expect(await page.locator('form.pghl-form').isVisible()).toBe(false);
    await page.click('.pf-start');
    await page.waitForTimeout(150);
    await page.keyboard.type('Max');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await page.keyboard.type('max@example.de');
    await page.keyboard.press('Enter');
    expect((await page.locator(`${active} .pf-key`).allTextContents()).join('')).toBe('ABC');
    await page.locator(`${active} .pf-opt input`).first().focus();
    await page.keyboard.press('b'); // Nein: jumps over two questions, and a lone choice goes on by itself
    await page.waitForTimeout(700);
    expect(await text(page, `${active} .pf-label`)).toBe('Sterne');
    expect(await text(page, '.pf-count')).toMatch(/^Frage 6 von 15/);
    await page.locator(`${active} .pf-stars button[data-v="4"]`).click();
    await page.waitForTimeout(700);
    await page.locator(`${active} input[type=range]`).fill('7');
    expect(await text(page, `${active} .pf-out`)).toBe('7');
    await page.click('.pf-next');
    await page.locator(`${active} .pf-scale button[data-v="9"]`).click();
    await page.waitForTimeout(700);
    await page.locator(`${active} [data-from]`).fill('2026-10-10');
    await page.locator(`${active} [data-to]`).fill('2026-10-12');
    await page.click('.pf-next');
    await page.locator(`${active} .pf-rank li`).first().locator('[data-down]').click();
    await page.click('.pf-next');
    await page.locator(`${active} .pf-pic`, { hasText: 'Zwei' }).click();
    await page.waitForTimeout(700);
    await page.waitForTimeout(150);
    await page.keyboard.type('4');
    await page.keyboard.press('Enter');
    expect(await text(page, `${active} .pf-calc-v`)).toBe('69,00 €'); // 4 × 12,50 + 19 points
    await page.click('.pf-next');
    const box = await page.locator(`${active} canvas`).boundingBox();
    await page.mouse.move(box.x + 20, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 100, { steps: 6 });
    await page.mouse.up();
    await page.click('.pf-next');
    expect(await text(page, '.pf-next')).toBe('Absenden');
    await page.click('.pf-next');
    expect(await page.locator(`${active} .pf-q[data-bad="1"]`).count()).toBe(1);
    await page.locator(`${active} .pf-opt`).click();
    await page.click('.pf-next');
    await done(page);
    expect(sent(seen)).toMatchObject({ first_name: 'Max', kunde: 'Nein', sterne: '4', zufrieden: '7', nps: '9', zeitraum: '2026-10-10/2026-10-12', rang: ['Qualität', 'Preis', 'Tempo'], bild: 'Zwei', menge: '4', richtpreis: '69', consent: 'ja' });
    expect(sent(seen).unterschrift).toMatch(/^data:image\/png;base64,/);
    expect(sent(seen)).not.toHaveProperty('nummer');
    expect(await text(page, '.pf-done h2')).toBe('Sehr gut');
    expect(await text(page, '.pf-done p')).toBe('Du hast 19 Punkte.');
    expect(await page.locator('.pf-progress').isVisible()).toBe(false);
    expect((await subs(f.id))[0].meta.score).toMatchObject({ values: { score: 19 }, ending: 'Sehr gut' });
    expect(events(seen).filter((e) => e[0] === 'v').length).toBeGreaterThanOrEqual(10);
    expect(seen.errors).toEqual([]);
  }, 90_000);

  it('waits for the Turnstile token, shows the widget on the last page only and sends the token', async () => {
    await t.api.put('/api/forms/captcha', { site_key: '0x4AAAAAAAsiteKEYforTESTS', secret_key: '0x4AAAAAAAsecretKEYforTESTS12345' });
    const one = await mk('Captcha', [{ id: 'k1', type: 'text', label: 'Name', name: 'first_name', required: true }], { captcha: { enabled: true } });
    const two = await mk('Captcha 2', [{ id: 'k1', type: 'text', label: 'Name', name: 'first_name', required: true }, { id: 'k2', type: 'page_break', label: '', name: 'pb' }, { id: 'k3', type: 'email', label: 'E-Mail', name: 'email' }], { captcha: { enabled: true } });
    // the widget never answers: blocked with a hint, no request
    const waiting = await open(one.id, { turnstile: false });
    await waiting.page.fill('[name=first_name]', 'Cap');
    await waiting.page.click('.pf-next');
    expect(await text(waiting.page, '[data-err]')).toBe('Bitte kurz die Sicherheitsprüfung abwarten.');
    expect(waiting.seen.posts.some((p) => p.url.endsWith('/submit'))).toBe(false);
    expect(await waiting.page.locator('.pf-next').isDisabled()).toBe(false);
    // the widget answers
    const { page, seen } = await open(one.id, { turnstile: true });
    await page.fill('[name=first_name]', 'Cap');
    await page.waitForTimeout(250);
    await page.click('.pf-next');
    await done(page);
    expect(sent(seen)._ts).toBe('good-token');
    expect(seen.errors).toEqual([]);
    // two pages: hidden on the first
    const multi = await open(two.id, { turnstile: true });
    expect(await multi.page.locator('.pf-captcha').evaluate((e: HTMLElement) => e.hidden)).toBe(true);
    await multi.page.fill('[name=first_name]', 'Cap');
    await multi.page.click('.pf-next');
    expect(await multi.page.locator('.pf-captcha').evaluate((e: HTMLElement) => e.hidden)).toBe(false);
  }, 60_000);

  it('sends a file along and refuses one over 5 MB', async () => {
    const f = await mk('Datei', [{ id: 'd1', type: 'text', label: 'Name', name: 'first_name', required: true }, { id: 'd2', type: 'file', label: 'Anhang', name: 'anhang' }]);
    const { page, seen } = await open(f.id);
    await page.fill('[name=first_name]', 'Datei');
    await page.setInputFiles('[name=anhang]', { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hallo') });
    await page.click('.pf-next');
    await done(page);
    expect(sent(seen).anhang).toMatchObject({ name: 'a.txt', type: 'text/plain' });
    expect(sent(seen).anhang.data).toMatch(/^data:text\/plain;base64,/);
    const big = await open(f.id);
    await big.page.fill('[name=first_name]', 'Gross');
    await big.page.setInputFiles('[name=anhang]', { name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.alloc(5 * 1024 * 1024 + 10) });
    await big.page.click('.pf-next');
    await big.page.waitForTimeout(400);
    expect(await text(big.page, '[data-err]')).toBe('big.txt ist größer als 5 MB');
    expect(await big.page.locator('.pf-next').isDisabled()).toBe(false);
  }, 60_000);
});
