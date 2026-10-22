import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { setStripeFetch } from '../server/services/stripe.js';
import { TEMPLATES } from '../server/services/form-templates.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const events: { type: string; data: any }[] = [];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const settle = () => t.app.events.flush();
const submit = (id: string, body: Record<string, unknown>) => t.api.post(`/api/public/forms/${id}/submit`, body);
const subs = async (id: string) => (await t.api.get(`/api/forms/${id}/submissions`)).data as any[];
const mk = async (name: string, fields: any[], settings: Record<string, any> = {}, kind = 'form') => (await t.api.post('/api/forms', { name, fields, settings, kind })).data;

beforeAll(async () => {
  // many submissions from one address: the per-minute limit is tested on its own below
  process.env.PGHL_FORMS_PER_MINUTE = '10000';
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  for (const type of ['form.submitted', 'form.scored', 'form.paid']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
}, 60_000);
afterAll(async () => {
  delete process.env.PGHL_FORMS_PER_MINUTE;
  setStripeFetch();
  await t.close();
});

describe('template gallery', () => {
  it('lists the templates and opens every one as a working form', async () => {
    const list = (await t.api.get('/api/forms/templates')).data;
    expect(list.templates.length).toBeGreaterThanOrEqual(20);
    expect(list.categories).toEqual(expect.arrayContaining(['Vertrieb', 'Umfragen', 'Personal', 'Events', 'Coaching']));
    expect(list.templates.find((x: any) => x.id === 'lead-qualifizierung')).toMatchObject({ name: 'Lead-Qualifizierung', mode: 'typeform', features: expect.arrayContaining(['Sprünge', 'Punkte & Auswertung']) });
    const detail = (await t.api.get('/api/forms/templates/lead-qualifizierung')).data;
    expect(detail.fields.length).toBeGreaterThan(5);
    expect((await t.api.get('/api/forms/templates/gibtsnicht')).status).toBe(404);
    expect((await t.api.post('/api/forms/templates/gibtsnicht/use', {})).status).toBe(404);

    const product = (await t.api.post('/api/products', { name: 'Testprodukt', price_cents: 4900 })).data;
    for (const tpl of TEMPLATES) {
      const r = await t.api.post(`/api/forms/templates/${tpl.id}/use`, tpl.needs_product ? { product_id: product.id } : {});
      expect(r.status, tpl.id).toBe(200);
      const page = await t.api.raw(`/f/${r.data.id}`);
      const body = await page.text();
      expect(page.status, tpl.id).toBe(200);
      expect(body, tpl.id).toContain('class="pghl-form"');
      expect(body, tpl.id).toContain(tpl.mode === 'typeform' ? 'pf-tf' : 'pf-classic');
      // the browser script is valid JavaScript
      const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.includes('CFG='));
      expect(scripts.length, tpl.id).toBe(1);
      expect(() => new Function(scripts[0]), tpl.id).not.toThrow();
    }
    const forms = (await t.api.get('/api/forms')).data;
    expect(forms.length).toBe(TEMPLATES.length);
  });

  it('wants a product for the payment template and fills the payment field with it', async () => {
    const product = (await t.api.post('/api/products', { name: 'Online-Kurs', price_cents: 9900 })).data;
    expect((await t.api.post('/api/forms/templates/bestellung-zahlung/use', {})).status).toBe(400);
    expect((await t.api.post('/api/forms/templates/bestellung-zahlung/use', { product_id: 'fremd' })).status).toBe(400);
    const r = await t.api.post('/api/forms/templates/bestellung-zahlung/use', { product_id: product.id, name: 'Meine Bestellung' });
    expect(r.data.name).toBe('Meine Bestellung');
    const form = (await t.api.get(`/api/forms/${r.data.id}`)).data;
    expect(form.fields.find((f: any) => f.type === 'payment').product_id).toBe(product.id);
    expect(form.settings.mode).toBe('typeform');
    expect(form.theme.preset).toBe('standard');
  });
});

describe('field types and checks at save', () => {
  it('stores and checks answers of every new field type', async () => {
    const form = await mk('Alle Typen', [
      { id: 'f1', type: 'text', label: 'Vorname', name: 'first_name', required: true },
      { id: 'f2', type: 'email', label: 'E-Mail', name: 'email', required: true },
      { id: 'f3', type: 'rating', label: 'Sterne', name: 'sterne', required: true, max: 5 },
      { id: 'f4', type: 'nps', label: 'NPS', name: 'nps', required: true },
      { id: 'f5', type: 'scale', label: 'Skala', name: 'skala', min: 1, max: 7 },
      { id: 'f6', type: 'date_range', label: 'Zeitraum', name: 'zeitraum' },
      { id: 'f7', type: 'ranking', label: 'Reihenfolge', name: 'rang', options: ['A', 'B', 'C'] },
      { id: 'f8', type: 'picture_choice', label: 'Bild', name: 'bild', options: ['Eins', 'Zwei'], images: ['', ''] },
      { id: 'f9', type: 'signature', label: 'Unterschrift', name: 'unterschrift' },
      { id: 'f10', type: 'number', label: 'Anzahl', name: 'anzahl', min: 1, max: 9 },
    ]);
    const ok = { first_name: 'Anna', email: 'anna@example.de', sterne: '4', nps: '9', skala: '5', zeitraum: '2026-10-01/2026-10-05', rang: ['C', 'A', 'B'], bild: 'Zwei', unterschrift: PNG, anzahl: '3' };
    const bad = async (patch: Record<string, unknown>, re: RegExp) => {
      const r = await submit(form.id, { ...ok, ...patch });
      expect(r.status, JSON.stringify(patch).slice(0, 60)).toBe(400);
      expect(r.data.error).toMatch(re);
    };
    await bad({ sterne: '6' }, /Sterne.*1 bis 5/);
    await bad({ nps: '11' }, /NPS.*0 bis 10/);
    await bad({ skala: '9' }, /1 bis 7/);
    await bad({ email: 'kaputt' }, /gültige E-Mail/);
    await bad({ zeitraum: '2026-10-05/2026-10-01' }, /Zeitraum/);
    await bad({ rang: ['A', 'B'] }, /Reihenfolge/);
    await bad({ bild: 'Drei' }, /Auswahl/);
    await bad({ anzahl: '10' }, /höchstens 9/);
    await bad({ unterschrift: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }, /Dateityp nicht erlaubt/);
    await bad({ unterschrift: `data:image/png;base64,${Buffer.from('<html>kein bild</html>').toString('base64')}` }, /Dateiinhalt passt nicht/);
    await bad({ unterschrift: `data:image/png;base64,${Buffer.concat([Buffer.from(PNG.split(',')[1], 'base64'), Buffer.alloc(210 * 1024)]).toString('base64')}` }, /größer als 200 KB/);
    await bad({ sterne: '' }, /„Sterne“ ausfüllen/);
    expect(await subs(form.id)).toHaveLength(0);

    const r = await submit(form.id, ok);
    expect(r.status).toBe(200);
    const [row] = await subs(form.id);
    expect(row.data).toMatchObject({ Vorname: 'Anna', Sterne: '4', NPS: '9', Skala: '5', Zeitraum: '01.10.2026 – 05.10.2026', Reihenfolge: ['C', 'A', 'B'], Bild: 'Zwei', Anzahl: '3' });
    expect(row.data.Unterschrift).toMatch(/\/api\/form-files\/[A-Za-z0-9]+\?locationId=/);
    const link = new URL(row.data.Unterschrift);
    const file = await t.api.raw(link.pathname + link.search, { headers: { cookie: t.api.cookie, 'x-pghl': '1' } });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    // optional fields may stay empty
    const light = await submit(form.id, { first_name: 'Ben', email: 'ben@example.de', sterne: '5', nps: '0' });
    expect(light.status).toBe(200);
  });

  it('refuses logic that cannot work when the form is saved', async () => {
    const base = (fields: any[], settings: any = { mode: 'typeform' }) => t.api.post('/api/forms', { name: 'Logik', fields, settings });
    const text = (id: string, extra: any = {}) => ({ id, type: 'text', label: id, name: id, ...extra });
    expect((await base([text('a', { jumps: [{ op: 'eq', value: 'x', goto: 'gibtsnicht' }] })])).data.error).toMatch(/Sprungziel/);
    expect((await base([text('a'), text('b', { jumps: [{ op: 'filled', goto: 'a' }] })])).data.error).toMatch(/nur vorwärts/);
    expect((await base([{ id: 'p', type: 'calculator', label: 'Preis', name: 'preis', formula: 'menge * 2' }])).data.error).toMatch(/Variable „menge“ gibt es nicht/);
    expect((await base([text('a')], { mode: 'typeform', variables: [{ name: 'x', formula: '1 +' }] })).data.error).toMatch(/endet unerwartet/);
    expect((await base([text('a')], { mode: 'typeform', endings: [{ var: 'unbekannt', title: 'x' }] })).data.error).toMatch(/Variable „unbekannt“/);
    expect((await base([{ id: 'z', type: 'payment', label: 'Z', name: 'z', product_id: 'fremd' }])).data.error).toMatch(/Produkt nicht gefunden/);
    const good = await base([text('a', { jumps: [{ op: 'eq', value: 'x', goto: 'c' }] }), text('b'), text('c')]);
    expect(good.status).toBe(200);
    // changing the layout re-checks the jumps; deleting a field a formula needs is refused too
    const calc = await base([{ id: 'n', type: 'number', label: 'N', name: 'n' }, { id: 'c', type: 'calculator', label: 'C', name: 'c', formula: 'n * 2' }], { mode: 'typeform' });
    expect(calc.status).toBe(200);
    const drop = await t.api.patch(`/api/forms/${calc.data.id}`, { fields: [{ id: 'c', type: 'calculator', label: 'C', name: 'c', formula: 'n * 2' }] });
    expect(drop.status).toBe(400);
    expect(drop.data.error).toMatch(/Variable „n“/);
    const back = await base([text('a'), text('b', { jumps: [{ op: 'filled', goto: 'c' }] }), text('c')], { mode: 'typeform' });
    expect(back.status).toBe(200);
    const mode = await t.api.patch(`/api/forms/${back.data.id}`, { settings: { mode: 'classic' } });
    expect(mode.status).toBe(400);
    expect(mode.data.error).toMatch(/nur vorwärts/);
  });

  it('keeps the honeypot', async () => {
    const form = await mk('Honig', [{ id: 'f1', type: 'text', label: 'Name', name: 'first_name' }]);
    const r = await submit(form.id, { first_name: 'Bot', _hp: 'http://spam' });
    expect(r.data).toEqual({ ok: true, spam: true });
    expect(await subs(form.id)).toHaveLength(0);
  });
});

describe('logic jumps', () => {
  it('counts only the questions on the visitor’s path', async () => {
    const form = await mk(
      'Sprünge',
      [
        { id: 'q1', type: 'radio', label: 'Kunde?', name: 'kunde', options: ['Ja', 'Nein'], required: true, jumps: [{ op: 'eq', value: 'Nein', goto: 'q4' }] },
        { id: 'q2', type: 'text', label: 'Kundennummer', name: 'nummer', required: true },
        { id: 'q3', type: 'text', label: 'Anliegen', name: 'anliegen', required: true, jumps: [{ op: 'eq', value: 'fertig', goto: 'end' }] },
        { id: 'q4', type: 'text', label: 'Wie hast du von uns gehört?', name: 'quelle', required: true },
        { id: 'q5', type: 'email', label: 'E-Mail', name: 'email', required: true },
      ],
      { mode: 'typeform' },
    );
    // a customer must answer 2 and 3
    expect((await submit(form.id, { kunde: 'Ja', quelle: 'x', email: 'a@b.de' })).data.error).toMatch(/Kundennummer/);
    // a non-customer skips them
    const r = await submit(form.id, { kunde: 'Nein', quelle: 'Freunde', email: 'neu@example.de' });
    expect(r.status).toBe(200);
    const [row] = await subs(form.id);
    expect(Object.keys(row.data)).toEqual(['Kunde?', 'Wie hast du von uns gehört?', 'E-Mail']);
    // answers of skipped questions are not taken even if they are sent
    const sneaky = await submit(form.id, { kunde: 'Nein', nummer: '123', quelle: 'Presse', email: 'neu2@example.de' });
    expect(sneaky.status).toBe(200);
    expect(Object.keys((await subs(form.id))[0].data)).not.toContain('Kundennummer');
    // "end" finishes: question 4 and 5 do not count either
    const end = await submit(form.id, { kunde: 'Ja', nummer: '7', anliegen: 'fertig' });
    expect(end.status).toBe(200);
    expect(end.data.contactId).toBeNull();
  });

  it('works per page in classic mode', async () => {
    const form = await mk('Seiten', [
      { id: 'a', type: 'radio', label: 'Schnell?', name: 'schnell', options: ['Ja', 'Nein'], required: true, jumps: [{ op: 'eq', value: 'Ja', goto: 'page:3' }] },
      { id: 'p1', type: 'page_break', label: '', name: 'p1' },
      { id: 'b', type: 'text', label: 'Zweite Seite', name: 'zwei', required: true },
      { id: 'p2', type: 'page_break', label: '', name: 'p2' },
      { id: 'c', type: 'email', label: 'Dritte Seite', name: 'email', required: true },
    ]);
    expect((await submit(form.id, { schnell: 'Ja', email: 'x@example.de' })).status).toBe(200);
    expect((await submit(form.id, { schnell: 'Nein', email: 'x@example.de' })).data.error).toMatch(/Zweite Seite/);
  });
});

describe('scoring, calculators and endings', () => {
  it('scores the lead template and routes by score', async () => {
    const lead = (await t.api.post('/api/forms/templates/lead-qualifizierung/use', {})).data;
    const full = { team: '6 bis 20', budget: '1.000 bis 5.000 €', start: 'Sofort', entscheider: 'Ja, allein', first_name: 'Hanna', email: 'hanna@example.de', consent: 'ja' };
    const r = await submit(lead.id, full);
    expect(r.status).toBe(200);
    expect(r.data.result).toMatchObject({ title: 'Das passt sehr gut!', text: expect.stringContaining('10 von 12 Punkten') });
    await settle();
    const scored = events.filter((e) => e.type === 'form.scored').at(-1)!;
    expect(scored.data).toMatchObject({ formId: lead.id, values: { score: 10 }, ending: { title: 'Das passt sehr gut!', tag: 'lead:heiss' } });
    const contact = (await t.api.get('/api/contacts?q=hanna')).data.contacts[0];
    expect(contact.tags).toEqual(expect.arrayContaining(['lead:heiss']));
    const [row] = await subs(lead.id);
    expect(row.meta.score).toEqual({ values: { score: 10 }, ending: 'Das passt sehr gut!' });
    // no budget: jumps to the contact data, score 0..., ending "kalt"
    const cold = await submit(lead.id, { team: 'Nur ich', budget: 'Kein Budget', first_name: 'Kalle', email: 'kalle@example.de', consent: 'ja' });
    expect(cold.data.result.title).toBe('Danke für dein Interesse');
    await settle();
    expect((await t.api.get('/api/contacts?q=kalle')).data.contacts[0].tags).toContain('lead:kalt');
    // required answers of the path still count
    expect((await submit(lead.id, { budget: 'Bis 1.000 €', first_name: 'X', email: 'x@example.de', consent: 'ja' })).data.error).toMatch(/Bitte „/);
  });

  it('computes calculator fields on the server (a forged value is ignored) and can show the result', async () => {
    const maler = (await t.api.post('/api/forms/templates/preisrechner-maler/use', {})).data;
    const r = await submit(maler.id, { flaeche: '85', fenster: '4', decke: 'Ja', richtpreis: '1', first_name: 'Rita', email: 'rita@example.de', consent: 'ja' });
    expect(r.status).toBe(200);
    const [row] = await subs(maler.id);
    expect(row.data['Dein Richtpreis (netto, ohne Gewähr)']).toBe('1.545,00 €');
    // no points, no ending: nothing extra is returned
    expect(r.data.result).toBeUndefined();
    const f = await mk(
      'Rechner',
      [
        { id: 'a', type: 'number', label: 'A', name: 'a', required: true },
        { id: 'b', type: 'number', label: 'B', name: 'b', required: true },
        { id: 'c', type: 'calculator', label: 'Produkt', name: 'prod', formula: 'a * b', format: 'number' },
      ],
      { mode: 'typeform', show_result: true, variables: [{ name: 'summe', formula: 'a + b' }, { name: 'doppelt', formula: 'summe * 2' }], endings: [{ var: 'doppelt', min: 10, max: null, title: 'Groß', text: 'Doppelte Summe: {{doppelt}}, Produkt: {{prod}}', tag: 'gross' }] },
    );
    const big = await submit(f.id, { a: '3', b: '4', email: 'ignored' });
    expect(big.data.result).toMatchObject({ title: 'Groß', text: 'Doppelte Summe: 14, Produkt: 12', values: { summe: '7', doppelt: '14' } });
    const small = await submit(f.id, { a: '1', b: '1' });
    expect(small.data.result).toMatchObject({ title: 'Dein Ergebnis', text: '', values: { summe: '2', doppelt: '4' } });
  });
});

describe('themes and layout', () => {
  it('keeps a theme, warns about hard-to-read colours and applies it to the page', async () => {
    const f = await mk('Aussehen', [{ id: 'f1', type: 'text', label: 'Name', name: 'first_name' }]);
    const list = (await t.api.get('/api/forms/themes')).data;
    expect(list.presets.map((p: any) => p.key)).toEqual(expect.arrayContaining(['standard', 'dunkel', 'minimal', 'warm', 'kontrast']));
    expect(list.fonts.map((x: any) => x.key)).toEqual(expect.arrayContaining(['system', 'serif', 'rounded', 'mono']));
    const r = await t.api.patch(`/api/forms/${f.id}`, { settings: { theme: { preset: 'dunkel', color: '#ff8800', radius: 20, align: 'center' } } });
    expect(r.status).toBe(200);
    expect(r.data.theme).toMatchObject({ preset: 'dunkel', color: '#ff8800', radius: 20, align: 'center', background: '#0b1020' });
    expect(r.data.theme_warnings).toEqual([]);
    const page = await (await t.api.raw(`/f/${f.id}`)).text();
    expect(page).toContain('--pf-color:#ff8800');
    expect(page).toContain('--pf-radius:20px');
    expect(page).toContain('background:#0b1020');
    // hard to read
    const low = await t.api.patch(`/api/forms/${f.id}`, { settings: { theme: { text: '#cccccc', card: '#ffffff' } } });
    expect(low.data.theme.preset).toBe('dunkel');
    expect(low.data.theme_warnings.length).toBeGreaterThan(0);
    // the picture behind the form
    const img = await t.api.patch(`/api/forms/${f.id}`, { settings: { theme: { bg_image: 'https://example.com/hintergrund.jpg', bg_overlay: 40 } } });
    expect(img.status).toBe(200);
    const withImg = await (await t.api.raw(`/f/${f.id}`)).text();
    expect(withImg).toContain("background-image:url('https://example.com/hintergrund.jpg')");
    expect(withImg).toContain('rgba(0,0,0,0.4)');
    for (const bad of [{ color: 'rot' }, { font: 'Papyrus' }, { preset: 'gibtsnicht' }, { bg_image: 'javascript:alert(1)' }, { bg_image: "https://x.de/a.jpg');}</style><script>alert(1)</script>" }]) {
      expect((await t.api.patch(`/api/forms/${f.id}`, { settings: { theme: bad } })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await (await t.api.raw(`/f/${f.id}`)).text()).not.toContain('<script>alert(1)');
  });

  it('switches to one question at a time with a welcome screen', async () => {
    const f = await mk('Typeform', [{ id: 'f1', type: 'text', label: 'Erste Frage', name: 'first_name', required: true }, { id: 'f2', type: 'email', label: 'Zweite Frage', name: 'email' }]);
    expect(await (await t.api.raw(`/f/${f.id}`)).text()).toContain('pf-classic');
    const r = await t.api.patch(`/api/forms/${f.id}`, { settings: { mode: 'typeform', welcome: { title: 'Willkommen!', text: 'Zwei kurze Fragen.', button: 'Start' }, show_progress: true } });
    expect(r.status).toBe(200);
    const page = await (await t.api.raw(`/f/${f.id}`)).text();
    expect(page).toContain('pf-tf');
    expect(page).toContain('pf-welcome');
    expect(page).toContain('Willkommen!');
    expect(page).toContain('pf-progress');
    expect(page).toContain('data-state="active"');
    expect(page.match(/class="pghl-step"/g)).toHaveLength(2);
    const embedded = await (await t.api.raw(`/f/${f.id}?embed=1`)).text();
    expect(embedded).toContain('pghlHeight');
    expect(embedded).not.toContain('min-height:100vh');
  });
});

describe('submission rate', () => {
  it('limits submissions per address and minute', async () => {
    const f = await mk('Tempo', [{ id: 'f1', type: 'text', label: 'Name', name: 'first_name' }]);
    process.env.PGHL_FORMS_PER_MINUTE = '3';
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await submit(f.id, { first_name: `T${i}` })).status);
      expect(codes.slice(-2)).toEqual([429, 429]);
    } finally {
      process.env.PGHL_FORMS_PER_MINUTE = '10000';
    }
  });
});

describe('captcha (Cloudflare Turnstile, own keys)', () => {
  const SECRET = '0x4AAAAAAAsecretKEYforTESTS12345';
  const SITE = '0x4AAAAAAAsiteKEYforTESTS';
  const asked: { url: string; body: URLSearchParams }[] = [];
  let answer: 'ok' | 'fail' | 'down' = 'ok';
  let formId = '';

  beforeAll(() => {
    t.app.services.turnstileFetch = async (url: string, init: any) => {
      asked.push({ url, body: new URLSearchParams(init.body) });
      if (answer === 'down') throw new Error('offline');
      return { ok: true, status: 200, json: async () => (answer === 'ok' ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }) };
    };
  });

  it('is off by default and needs keys before a form can use it', async () => {
    expect((await t.api.get('/api/forms/captcha')).data).toMatchObject({ configured: false, site_key: '' });
    const f = await mk('Mit Schutz', [{ id: 'f1', type: 'text', label: 'Name', name: 'first_name', required: true }]);
    formId = f.id;
    const early = await t.api.patch(`/api/forms/${formId}`, { settings: { captcha: { enabled: true } } });
    expect(early.status).toBe(400);
    expect(early.data.error).toMatch(/Turnstile-Schlüssel/);
    expect((await t.api.put('/api/forms/captcha', { site_key: 'x' })).status).toBe(400);
    expect((await t.api.put('/api/forms/captcha', { site_key: SITE })).status).toBe(400);
    const saved = await t.api.put('/api/forms/captcha', { site_key: SITE, secret_key: SECRET });
    expect(saved.data).toMatchObject({ configured: true, site_key: SITE, secret_hint: '…2345' });
    // the secret never comes back
    expect(JSON.stringify([saved.data, (await t.api.get('/api/forms/captcha')).data, (await t.api.get(`/api/forms/${formId}`)).data])).not.toContain(SECRET);
    const stored = t.app.db.get<any>('SELECT secret_sealed FROM form_captcha WHERE location_id = ?', loc);
    expect(stored.secret_sealed).not.toContain(SECRET);
    // changing only the site key keeps the secret
    expect((await t.api.put('/api/forms/captcha', { site_key: SITE })).data.configured).toBe(true);
    expect((await t.api.patch(`/api/forms/${formId}`, { settings: { captcha: { enabled: true } } })).data.settings.captcha).toEqual({ enabled: true });
  });

  it('shows the widget and checks the token before anything is stored', async () => {
    const page = await (await t.api.raw(`/f/${formId}`)).text();
    expect(page).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
    expect(page).toContain('data-category="necessary"');
    expect(page).toContain(SITE);
    expect(page).not.toContain(SECRET);
    asked.length = 0;
    // required field missing: refused first, Cloudflare is not asked (the token stays unused)
    expect((await submit(formId, { _ts: 'token' })).data.error).toMatch(/Bitte „Name“ ausfüllen/);
    expect(asked).toHaveLength(0);
    // no token
    const none = await submit(formId, { first_name: 'Max' });
    expect(none.status).toBe(400);
    expect(none.data.error).toMatch(/Sicherheitsprüfung/);
    expect(await subs(formId)).toHaveLength(0);
    // a good token
    const good = await submit(formId, { first_name: 'Max', _ts: 'good-token' });
    expect(good.status).toBe(200);
    expect(asked).toHaveLength(1);
    expect(asked[0].url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(Object.fromEntries(asked[0].body)).toMatchObject({ secret: SECRET, response: 'good-token' });
    expect(await subs(formId)).toHaveLength(1);
    // a bad token, Cloudflare down
    answer = 'fail';
    const failed = await submit(formId, { first_name: 'Bot', _ts: 'bad' });
    expect(failed.status).toBe(400);
    expect(failed.data.error).toMatch(/fehlgeschlagen/);
    answer = 'down';
    const down = await submit(formId, { first_name: 'Max2', _ts: 'x' });
    expect(down.status).toBe(503);
    expect(down.data.error).toMatch(/nicht erreichbar/);
    answer = 'ok';
    expect(await subs(formId)).toHaveLength(1);
    // the honeypot answers without asking Cloudflare
    asked.length = 0;
    expect((await submit(formId, { first_name: 'Bot', _hp: 'x' })).data).toEqual({ ok: true, spam: true });
    expect(asked).toHaveLength(0);
  });

  it('switches the protection off everywhere when the keys go', async () => {
    const r = await t.api.del('/api/forms/captcha');
    expect(r.data).toMatchObject({ configured: false });
    expect((await t.api.get(`/api/forms/${formId}`)).data.settings.captcha).toEqual({ enabled: false });
    expect((await submit(formId, { first_name: 'Ohne' })).status).toBe(200);
    expect(await (await t.api.raw(`/f/${formId}`)).text()).not.toContain('challenges.cloudflare.com');
  });
});

describe('payment field (existing buy flow, mocked Stripe)', () => {
  const KEY = 'sk_test_51FakeKeyForTests000abcd';
  const sessions = new Map<string, any>();
  const created: URLSearchParams[] = [];
  let seq = 0;
  let product: any;
  let formId = '';
  let payUrl = '';
  let sessionId = '';

  beforeAll(async () => {
    setStripeFetch((async (url: string, init: any) => {
      const u = new URL(url);
      const params = new URLSearchParams(init.body ?? u.search.slice(1));
      const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
      if (u.pathname === '/v1/account') return json({ id: 'acct_1', settings: { dashboard: { display_name: 'Muster' } }, country: 'DE', default_currency: 'eur', charges_enabled: true });
      if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
        created.push(params);
        const id = `cs_test_form_${++seq}`;
        const metadata: Record<string, string> = {};
        for (const [k, v] of params) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v;
        const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: 'payment', metadata, amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), currency: 'eur', customer_email: params.get('customer_email'), payment_status: 'unpaid', status: 'open' };
        sessions.set(id, s);
        return json(s);
      }
      return json({ error: { message: 'unknown' } }, 404);
    }) as any);
    expect((await t.api.put('/api/stripe', { secret_key: KEY })).status).toBe(200);
    product = (await t.api.post('/api/products', { name: 'Webinar-Aufzeichnung', price_cents: 5000, tax_rate: 19 })).data;
    const f = await mk(
      'Bestellung',
      [
        { id: 'f1', type: 'text', label: 'Vorname', name: 'first_name', required: true },
        { id: 'f2', type: 'email', label: 'E-Mail', name: 'email', required: true },
        { id: 'f3', type: 'payment', label: 'Bezahlung', name: 'zahlung', product_id: product.id },
      ],
      { mode: 'typeform' },
    );
    formId = f.id;
  });

  it('shows the product and its price on the form', async () => {
    const page = await (await t.api.raw(`/f/${formId}`)).text();
    expect(page).toContain('pf-pay');
    expect(page).toContain('Webinar-Aufzeichnung');
    expect(page).toContain('59,50');
    // a product of someone else cannot be set
    expect((await t.api.patch(`/api/forms/${formId}`, { fields: [{ id: 'f3', type: 'payment', label: 'Z', name: 'z', product_id: 'fremd' }] })).status).toBe(400);
  });

  it('stores the answers, sends the visitor to the buy page and marks the order paid when the purchase is confirmed', async () => {
    const r = await submit(formId, { first_name: 'Paula', email: 'paula@example.de' });
    expect(r.status).toBe(200);
    payUrl = r.data.pay_url;
    expect(payUrl).toMatch(new RegExp(`^http://localhost/buy/${product.id}\\?fs=[A-Za-z0-9_.-]+&email=paula%40example\\.de$`));
    let [row] = await subs(formId);
    expect(row.meta.payment).toMatchObject({ status: 'pending', product_id: product.id, product: 'Webinar-Aufzeichnung', amount_cents: 5950, currency: 'EUR' });
    expect(row.data.Bezahlung).toContain('Zahlung offen');
    // the buy page carries the token on …
    const path = payUrl.replace('http://localhost', '');
    const page = await (await t.api.raw(path)).text();
    expect(page).toMatch(/<input type="hidden" name="_fs" value="[A-Za-z0-9._-]+">/);
    expect(page).toContain('value="paula@example.de"');
    // a wrong token is not carried
    expect(await (await t.api.raw(`${path.split('?')[0]}?fs=kaputt`)).text()).not.toContain('name="_fs"');
    // … into the checkout session
    const token = page.match(/name="_fs" value="([^"]+)"/)![1];
    const go = await t.api.raw(`/buy/${product.id}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'paula@example.de', _fs: token }).toString() });
    expect(go.status).toBe(303);
    expect(created.at(-1)!.get('metadata[form_submission]')).toBe(row.id);
    sessionId = go.headers.get('location')!.split('/').pop()!;
    // not paid yet
    expect((await subs(formId))[0].meta.payment.status).toBe('pending');
    // Stripe confirms: the existing flow makes the invoice and product.purchased, the form follows
    const session = { ...sessions.get(sessionId), payment_status: 'paid', status: 'complete', customer_details: { email: 'paula@example.de', name: 'Paula P' } };
    t.app.services.stripeBuy.completeProduct(loc, session);
    await settle();
    [row] = await subs(formId);
    expect(row.meta.payment).toMatchObject({ status: 'paid' });
    expect(row.meta.payment.invoice_id).toBeTruthy();
    expect(row.meta.payment.paid_at).toBeTruthy();
    expect(row.data.Bezahlung).toContain('(bezahlt)');
    const paid = events.filter((e) => e.type === 'form.paid').at(-1)!;
    expect(paid.data).toMatchObject({ formId, submissionId: row.id, productId: product.id, amount_cents: 5950 });
    // a second purchase confirmation changes nothing
    const before = events.filter((e) => e.type === 'form.paid').length;
    t.app.events.emit(loc, 'product.purchased', { contactId: row.contact_id, productId: product.id, metadata: { form_submission: row.id } });
    await settle();
    expect(events.filter((e) => e.type === 'form.paid').length).toBe(before);
  });

  it('finds the order again when the buyer used the buy page another way', async () => {
    const r = await submit(formId, { first_name: 'Peter', email: 'peter@example.de' });
    const cid = r.data.contactId;
    t.app.events.emit(loc, 'product.purchased', { contactId: cid, productId: product.id, invoiceId: 'inv-x', metadata: {} });
    await settle();
    const row = (await subs(formId)).find((s) => s.id === r.data.id);
    expect(row.meta.payment).toMatchObject({ status: 'paid', invoice_id: 'inv-x' });
    // another product does not
    const r2 = await submit(formId, { first_name: 'Quinn', email: 'quinn@example.de' });
    t.app.events.emit(loc, 'product.purchased', { contactId: r2.data.contactId, productId: 'anderes', metadata: {} });
    await settle();
    expect((await subs(formId)).find((s) => s.id === r2.data.id).meta.payment.status).toBe('pending');
  });

  it('does not stop the form when payment is not set up', async () => {
    t.app.db.run('DELETE FROM stripe_accounts WHERE location_id = ?', loc);
    const page = await (await t.api.raw(`/f/${formId}`)).text();
    expect(page).toContain('Die Zahlung ist gerade nicht eingerichtet');
    const r = await submit(formId, { first_name: 'Rolf', email: 'rolf@example.de' });
    expect(r.status).toBe(200);
    expect(r.data.pay_url).toBeUndefined();
    expect((await subs(formId))[0].data.Bezahlung).toBe('Zahlung nicht eingerichtet');
  });
});

describe('per-field analytics', () => {
  let formId = '';
  const track = (session: string, e: [string, string, number][], id = formId) => t.api.post(`/api/public/forms/${id}/track`, { s: session, e });
  const field = (a: any, id: string) => a.fields.find((f: any) => f.id === id);

  beforeAll(async () => {
    formId = (
      await mk(
        'Messung',
        [
          { id: 'name', type: 'text', label: 'Name', name: 'first_name', required: true },
          { id: 'mail', type: 'email', label: 'E-Mail', name: 'email', required: true },
          { id: 'wunsch', type: 'textarea', label: 'Wunsch', name: 'wunsch' },
        ],
        { mode: 'typeform' },
      )
    ).id;
  });

  it('counts opens, views, answers, time, submits and where visitors leave', async () => {
    // five visitors: 2 finish, 1 leaves at the e-mail, 1 leaves at the name, 1 only looks
    const finish = (s: string, ms: number) => track(s, [['o', '', 0], ['v', 'name', 0], ['a', 'name', 4000], ['v', 'mail', 0], ['a', 'mail', ms], ['v', 'wunsch', 0], ['a', 'wunsch', 20000], ['s', '', 60000]]);
    expect((await finish('aaaaaaaa01', 8000)).status).toBe(200);
    expect((await finish('aaaaaaaa02', 12000)).status).toBe(200);
    await track('aaaaaaaa03', [['o', '', 0], ['v', 'name', 0], ['a', 'name', 6000], ['v', 'mail', 0], ['l', 'mail', 9000]]);
    await track('aaaaaaaa04', [['o', '', 0], ['v', 'name', 0], ['l', 'name', 3000]]);
    await track('aaaaaaaa05', [['o', '', 0]]);
    // a visit whose "leave" report never arrived: the last view counts
    await track('aaaaaaaa06', [['o', '', 0], ['v', 'name', 0], ['a', 'name', 2000], ['v', 'mail', 0]]);
    const a = (await t.api.get(`/api/forms/${formId}/analytics?days=7`)).data;
    expect(a.totals).toMatchObject({ opened: 6, started: 4, submitted: 2, completion_percent: 33, abandon_percent: 67, avg_submit_seconds: 60 });
    expect(field(a, 'name')).toMatchObject({ views: 5, answered: 4, answer_percent: 80, dropoffs: 1, avg_seconds: 4 });
    expect(field(a, 'mail')).toMatchObject({ views: 4, answered: 2, dropoffs: 2, avg_seconds: 10 });
    expect(field(a, 'wunsch')).toMatchObject({ views: 2, answered: 2, dropoffs: 0, avg_seconds: 20 });
    expect(a.worst_dropoff).toMatchObject({ id: 'mail', count: 2 });
    expect(a.funnel.map((x: any) => [x.step, x.count])).toEqual([['Geöffnet', 6], ['Begonnen', 4], ['Name', 5], ['E-Mail', 4], ['Wunsch', 2], ['Abgeschickt', 2]]);
    expect(a.daily[0]).toMatchObject({ opened: 6, submitted: 2 });
    expect(a.days).toBe(7);
  });

  it('ignores what is not a clean report, limits size and rate, and can be switched off', async () => {
    const count = () => t.app.db.get<any>('SELECT COUNT(*) AS n FROM form_events').n;
    const before = count();
    await t.api.post(`/api/public/forms/${formId}/track`, { s: 'kurz', e: [['o', '', 0]] });
    await t.api.post(`/api/public/forms/${formId}/track`, { s: 'bbbbbbbb01', e: [['v', 'gibtsnicht', 0], ['x', '', 0]] });
    await t.api.post(`/api/public/forms/${formId}/track`, 'kein-objekt' as any);
    expect(count()).toBe(before);
    expect((await track('bbbbbbbb02', Array.from({ length: 70 }, () => ['o', '', 0] as [string, string, number]))).status).toBe(200);
    expect(count()).toBe(before + 60);
    const big = await t.api.post(`/api/public/forms/${formId}/track`, { s: 'bbbbbbbb03', e: [['o', '', 0]], pad: 'x'.repeat(9000) });
    expect(big.status).toBe(413);
    expect((await track('bbbbbbbb04', [['o', '', 0]], 'gibtsnicht')).status).toBe(404);
    // the page reports nothing when the owner switched analytics off
    await t.api.patch(`/api/forms/${formId}`, { settings: { analytics: false } });
    const n = count();
    await track('bbbbbbbb05', [['o', '', 0]]);
    expect(count()).toBe(n);
    // (the analytics part of the browser script is not even sent: it holds the address it would report to)
    expect(await (await t.api.raw(`/f/${formId}`)).text()).not.toMatch(/\/track['"]/);
    await t.api.patch(`/api/forms/${formId}`, { settings: { analytics: true } });
    expect(await (await t.api.raw(`/f/${formId}`)).text()).toMatch(/\/track['"]/);
    // statistics can be reset, and are the owner's only
    expect((await t.api.del(`/api/forms/${formId}/analytics`)).status).toBe(200);
    expect((await t.api.get(`/api/forms/${formId}/analytics`)).data.totals.opened).toBe(0);
    expect((await t.api.get('/api/forms/gibtsnicht/analytics')).status).toBe(404);
  });

  it('is rate limited per address', async () => {
    let limited = 0;
    for (let i = 0; i < 260; i++) if ((await track(`cccccccc${String(i).padStart(2, '0')}`, [['o', '', 0]])).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});
