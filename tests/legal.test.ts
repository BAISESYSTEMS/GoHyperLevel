import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import {
  BLANK_PROFILE,
  EMPTY_FACTS,
  LEGAL_NOTICE,
  activeServices,
  avv,
  cleanProfile,
  datenschutz,
  docToBlocks,
  docToHtml,
  docToMarkdown,
  docToText,
  impressum,
  splitAddress,
  vvt,
  widerruf,
  type Facts,
  type LegalProfile,
} from '../server/services/legal-texts.js';
import { docPdf } from '../server/services/legal-pdf.js';

const profile = (extra: Partial<LegalProfile> = {}): LegalProfile =>
  cleanProfile({ form: 'gmbh', company: 'Muster Digital GmbH', owner: 'Erika Muster', street: 'Hauptstraße 1', zip: '10115', city: 'Berlin', email: 'info@muster.example', phone: '+49 30 123456', register_court: 'Amtsgericht Berlin (Charlottenburg)', register_no: 'HRB 123456 B', vat_id: 'DE123456789', hosting: 'Hetzner Online GmbH, Industriestr. 25, 91710 Gunzenhausen', supervisory: 'Berliner Beauftragte für Datenschutz und Informationsfreiheit', ...extra });
const facts = (extra: Partial<Facts> = {}): Facts => ({ ...EMPTY_FACTS, ...extra });
const text = (d: { sections: { heading: string; body: string }[] }) => d.sections.map((s) => `${s.heading}\n${s.body}`).join('\n\n');

describe('Impressum', () => {
  it('a GmbH with everything filled in: no gaps, no placeholders, the usual sections', () => {
    const d = impressum(profile());
    expect(d.missing).toEqual([]);
    const t = text(d);
    expect(t).not.toContain('[bitte ergänzen');
    expect(d.sections.map((s) => s.heading)).toEqual(expect.arrayContaining(['Angaben gemäß § 5 DDG', 'Vertretungsberechtigt', 'Kontakt', 'Registereintrag', 'Umsatzsteuer-ID', 'Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV', 'Verbraucherstreitbeilegung']));
    expect(t).toContain('Amtsgericht Berlin (Charlottenburg)');
    expect(t).toContain('HRB 123456 B');
    expect(t).toContain('DE123456789');
    expect(t).toContain('nicht bereit');
    expect(t).not.toContain('OS-Plattform');
    expect(d.notice).toBe(LEGAL_NOTICE);
    expect(d.notice).toContain('keine Rechtsberatung');
  });

  it('marks what is missing and lists it; the form decides which sections appear', () => {
    const d = impressum(cleanProfile({ form: 'freiberuf', company: 'Dr. Paul Beispiel' }));
    expect(d.missing).toEqual(expect.arrayContaining(['E-Mail', 'Inhaber / Vertretung', 'Berufsrecht']));
    expect(text(d)).toContain('[bitte ergänzen: E-Mail-Adresse]');
    expect(d.sections.some((s) => s.heading === 'Registereintrag')).toBe(false);
    expect(d.sections.some((s) => s.heading.startsWith('Berufsbezeichnung'))).toBe(true);
    const willing = impressum(profile({ dispute: 'willing', dispute_body: 'Allgemeine Verbraucherschlichtungsstelle, Straßburger Str. 8, 77694 Kehl' }));
    expect(text(willing)).toContain('bereit, an einem Streitbeilegungsverfahren');
    expect(text(willing)).toContain('Kehl');
    expect(impressum(profile({ dispute: 'willing' })).missing).toContain('Schlichtungsstelle');
  });
});

describe('Datenschutzerklärung knows what is in use', () => {
  const heads = (d: { sections: { heading: string }[] }) => d.sections.map((s) => s.heading);

  it('a bare sub-account gets the basics only: controller, hosting and logs, rights, complaint', () => {
    const d = datenschutz(profile(), facts());
    const h = heads(d).join('|');
    expect(h).toContain('Verantwortlicher');
    expect(h).toContain('Hosting und Server-Logfiles');
    expect(h).toContain('Ihre Rechte');
    expect(h).toContain('Beschwerderecht');
    for (const word of ['Stripe', 'Newsletter', 'YouTube', 'Google Analytics', 'Meta-Pixel', 'Live-Chat', 'Terminbuchung', 'Webinare']) expect(h, word).not.toContain(word);
    expect(text(d)).not.toContain('Stripe');
    expect(text(d)).toContain('Hetzner Online GmbH');
    expect(d.services).toEqual([]);
  });

  it('every module in use brings its own section – and only that', () => {
    const d = datenschutz(
      profile(),
      facts({ forms: true, newsletter: true, doi: true, email_provider: 'resend', stripe: true, invoices: true, calendars: true, calendar_sync: ['google'], webinars: true, video_hosts: ['youtube'], chat: true, cmp: true, attribution: true, trackers: ['ga', 'meta_pixel'], embeds: ['youtube', 'gmaps'], ai_provider: 'claude', tickets: true, email_tracking: true }),
    );
    const h = heads(d).join('|');
    for (const word of ['Kontaktformulare', 'Newsletter', 'E-Mail-Versand', 'Stripe', 'Rechnungen', 'Online-Terminbuchung', 'Kalender-Abgleich', 'Webinare', 'Live-Chat', 'Cookies und Einwilligungsverwaltung', 'Eigene Herkunftsmessung', 'Google Analytics', 'Meta-Pixel', 'YouTube', 'Google Maps', 'KI-Funktionen', 'Support und Tickets']) expect(h, word).toContain(word);
    for (const word of ['TikTok', 'Hotjar', 'Vimeo', 'Telefonie', 'Partnerprogramm', 'Google Fonts']) expect(h, word).not.toContain(word);
    const t = text(d);
    expect(t).toContain('Double-Opt-in');
    expect(t).toContain('Resend');
    expect(t).toContain('Stripe Payments Europe');
    expect(t).toContain('Consent Mode');
    expect(t).toContain('Google Ireland Limited');
    expect(t).toContain('Claude (Anthropic');
    expect(t).toContain('acht Jahre');
    expect(t).toContain('(#cookie-settings)');
    expect(d.services).toEqual(expect.arrayContaining(['stripe', 'ga', 'meta_pixel', 'youtube', 'gmaps', 'chat', 'cmp']));
  });

  it('what the detection cannot see can be switched on, a wrong guess off', () => {
    const f = facts({ stripe: true, trackers: ['ga'] });
    expect(activeServices(f)).toEqual(['stripe', 'ga']);
    expect(new Set(activeServices(f, { stripe: false, tiktok: true }))).toEqual(new Set(['ga', 'tiktok']));
    const d = datenschutz(profile({ overrides: { stripe: false, tiktok: true } }), f);
    expect(heads(d).join('|')).not.toContain('Stripe');
    expect(heads(d).join('|')).toContain('TikTok-Pixel');
  });

  it('gaps are marked and listed; the notice is part of the document', () => {
    const d = datenschutz(cleanProfile({ company: 'Test' }), facts());
    expect(d.missing).toEqual(expect.arrayContaining(['E-Mail', 'Hosting-Anbieter', 'Aufsichtsbehörde']));
    expect(text(d)).toContain('[bitte ergänzen: Hosting-Anbieter mit Anschrift]');
    expect(d.notice).toContain('Rechtsanwalt');
  });
});

describe('AVV, VVT and Widerrufsbelehrung', () => {
  it('the AVV has the parts of Art. 28, the parties and the sub-processors the sub-account uses', () => {
    const d = avv(profile(), { controller: { name: 'Kundin GmbH', address: 'Weg 2, 80331 München', representative: 'Karl Kunde' } }, facts({ email_provider: 'brevo', telephony: true, ai_provider: 'openai' }));
    expect(d.missing).toEqual([]);
    const t = text(d);
    expect(t).toContain('Kundin GmbH');
    expect(t).toContain('Muster Digital GmbH');
    expect(t).toContain('Anlage 1 – Technische und organisatorische Maßnahmen');
    expect(t).toContain('Anlage 2 – Unterauftragsverarbeiter');
    expect(d.title).toContain('Art. 28');
    expect(t).toContain('Art. 32 DSGVO');
    expect(t).toContain('dokumentierter Weisung');
    expect(t).toContain('Hetzner Online GmbH');
    expect(t).toContain('Brevo');
    expect(t).toContain('Twilio');
    expect(t).toContain('OpenAI');
    expect(t).toContain('24 Stunden');
    expect(avv(profile(), {}, facts()).missing).toEqual(expect.arrayContaining(['Auftraggeber', 'Anschrift Auftraggeber']));
    expect(d.title).toContain('Auftragsverarbeitung');
  });

  it('the VVT lists an activity per module in use', () => {
    const d = vvt(profile(), facts({ forms: true, newsletter: true, stripe: true, calendars: true, webinars: true, employees: true }));
    const h = d.sections.map((s) => s.heading).join('|');
    for (const w of ['Kundenverwaltung', 'Kontaktformulare', 'Newsletter', 'Rechnungsstellung', 'Terminbuchung', 'Webinare', 'Personalverwaltung']) expect(h, w).toContain(w);
    expect(h).not.toContain('Telefonie');
    const crm = d.sections.find((s) => s.heading.includes('Kundenverwaltung'))!.body;
    for (const w of ['Zweck', 'Rechtsgrundlage', 'Betroffene Personen', 'Datenkategorien', 'Empfänger', 'Drittlandübermittlung', 'Löschfristen']) expect(crm).toContain(w);
    expect(text(d)).toContain('§ 38 BDSG');
  });

  it('the model withdrawal notice differs by what is sold and carries the company and the form', () => {
    const digital = text(widerruf(profile(), 'digital'));
    expect(digital).toContain('vierzehn Tagen ohne Angabe von Gründen');
    expect(digital).toContain('Muster Digital GmbH, Hauptstraße 1, 10115 Berlin');
    expect(digital).toContain('Vorzeitiges Erlöschen des Widerrufsrechts bei digitalen Inhalten');
    expect(digital).toContain('Muster-Widerrufsformular');
    expect(digital).not.toContain('Rücksendung');
    const service = text(widerruf(profile(), 'service'));
    expect(service).toContain('angemessenen Betrag');
    expect(service).toContain('Dienstleistung');
    const goods = text(widerruf(profile(), 'physical'));
    expect(goods).toContain('Besitz genommen');
    expect(goods).toContain('Kosten der Rücksendung');
    expect(widerruf(cleanProfile({}), 'digital').missing).toEqual(expect.arrayContaining(['Firmenname', 'E-Mail']));
  });

  it('renders HTML (escaped), Markdown, text, funnel blocks and a PDF', () => {
    const d = impressum(profile({ company: 'A & B <script>alert(1)</script> GmbH' }));
    const html = docToHtml(d, { notice: true });
    expect(html).toContain('A &amp; B &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('keine Rechtsberatung');
    expect(docToHtml(d)).not.toContain('Rechtsberatung');
    const dsg = datenschutz(profile(), facts({ cmp: true }));
    expect(docToHtml(dsg)).toContain('<a href="#cookie-settings">Cookie-Einstellungen öffnen</a>');
    expect(docToHtml(dsg)).toContain('<ul>');
    expect(docToMarkdown(d, { notice: true })).toMatch(/^> Entwurf – keine Rechtsberatung/);
    expect(docToMarkdown(d)).toContain('## Angaben gemäß § 5 DDG');
    expect(docToText(d)).toContain('IMPRESSUM');
    const blocks = docToBlocks(d);
    expect(blocks[0]).toEqual({ type: 'heading', text: 'Impressum', level: 1, padding: 32 });
    // tight spacing: a heading sits right above its own text, not 96 px away (the builder's default is 48 px per block)
    expect(blocks.slice(1).every((b) => b.padding === (b.type === 'heading' ? 12 : 0))).toBe(true);
    expect(blocks.filter((b) => b.type === 'heading').length).toBe(d.sections.length + 1);
    const pdf = docPdf(datenschutz(profile(), facts({ forms: true, newsletter: true, stripe: true })));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(3000);
  });

  it('splits the sub-account address into street, ZIP and city; cleans the profile', () => {
    expect(splitAddress('Hauptstraße 1\n10115 Berlin')).toEqual({ street: 'Hauptstraße 1', zip: '10115', city: 'Berlin' });
    expect(splitAddress('Hauptstraße 1, 10115 Berlin')).toEqual({ street: 'Hauptstraße 1', zip: '10115', city: 'Berlin' });
    expect(splitAddress('')).toEqual({ street: '', zip: '', city: '' });
    const p = cleanProfile({ form: 'weird', website: 'javascript:alert(1)', dispute: 'x', overrides: { stripe: true, 'bad key!': true, ga: 'yes' }, company: 'x'.repeat(500) });
    expect(p.form).toBe('einzel');
    expect(p.website).toBe('');
    expect(p.dispute).toBe('unwilling');
    expect(p.overrides).toEqual({ stripe: true });
    expect(p.company).toHaveLength(200);
    expect(BLANK_PROFILE.company).toBe('');
  });
});

// --- through the app --------------------------------------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const realFetch = globalThis.fetch;
const outbound: string[] = [];

beforeAll(async () => {
  // Nothing may leave the machine – the eRecht24 hook is a placeholder.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
      outbound.push(url);
      throw new Error(`offline in tests: ${url}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await t.close();
});

describe('legal pages in the app', () => {
  it('starts from what the sub-account already knows (name, address, e-mail, tax id)', async () => {
    await t.api.patch('/api/location', { address: 'Hauptstraße 1\n10115 Berlin', email: 'info@muster.example', phone: '+49 30 1', website: 'https://muster.example', settings: { invoices: { tax_id: 'DE123456789' } } });
    const p = (await t.api.get('/api/legal/profile')).data;
    expect(p.profile).toMatchObject({ company: 'Testfirma', street: 'Hauptstraße 1', zip: '10115', city: 'Berlin', email: 'info@muster.example', phone: '+49 30 1', website: 'https://muster.example', vat_id: 'DE123456789', form: 'einzel' });
    expect(p.prefilled).toEqual(expect.arrayContaining(['company', 'street', 'email']));
    expect(p.notice).toBe(LEGAL_NOTICE);
    expect(p.forms.map((f: any) => f.key)).toContain('gmbh');
    const saved = (await t.api.put('/api/legal/profile', { form: 'gmbh', company: 'Testfirma GmbH', owner: 'Erika Muster', register_court: 'Amtsgericht Berlin', register_no: 'HRB 1', hosting: 'Hetzner Online GmbH' })).data.profile;
    expect(saved).toMatchObject({ form: 'gmbh', company: 'Testfirma GmbH', street: 'Hauptstraße 1' });
  });

  it('the Datenschutzerklärung follows the modules: nothing at first, then what is set up', async () => {
    let doc = (await t.api.post('/api/legal/generate', { kind: 'datenschutz' })).data;
    const heads = () => doc.doc.sections.map((s: any) => s.heading).join('|');
    expect(doc.notice).toContain('keine Rechtsberatung');
    expect(doc.html).toContain('keine Rechtsberatung');
    expect(heads()).not.toContain('Stripe');
    expect(heads()).not.toContain('Newsletter');

    // Stripe connected, a sender other than SMTP, a form that collects newsletter consent, an invoice, chat, a calendar.
    t.app.db.run(`INSERT INTO stripe_accounts (location_id, secret_key, updated_at) VALUES (?, 'sealed', ?)`, loc, new Date().toISOString());
    await t.api.patch('/api/location', { settings: { email: { provider: 'resend' }, chat: { enabled: true } } });
    await t.api.post('/api/forms', { name: 'News', settings: { consent: { marketing: true } } });
    await t.api.post('/api/calendars', { name: 'Termin', duration: 30 });
    const contact = (await t.api.post('/api/contacts', { email: 'k@example.com' })).data;
    await t.api.post('/api/invoices', { contact_id: contact.id, items: [{ name: 'X', qty: 1, price_cents: 100 }] });
    doc = (await t.api.post('/api/legal/generate', { kind: 'datenschutz' })).data;
    for (const w of ['Stripe', 'Newsletter', 'Kontaktformulare', 'E-Mail-Versand', 'Live-Chat', 'Online-Terminbuchung', 'Rechnungen']) expect(heads(), w).toContain(w);
    expect(heads()).not.toContain('YouTube');
    expect(heads()).not.toContain('Google Analytics');

    // Analytics in the page code and a video block are found; the banner brings its own section.
    const funnel = (await t.api.post('/api/funnels', { name: 'Site', template: 'website' })).data;
    await t.api.patch(`/api/funnels/${funnel.id}`, { settings: { head_code: `<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>` } });
    await t.api.patch(`/api/funnel-pages/${funnel.pages[0].id}`, { blocks: [{ type: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }] });
    await t.api.put('/api/cmp/settings', { enabled: true });
    doc = (await t.api.post('/api/legal/generate', { kind: 'datenschutz' })).data;
    for (const w of ['Google Analytics', 'YouTube', 'Cookies und Einwilligungsverwaltung']) expect(heads(), w).toContain(w);
    const services = (await t.api.get('/api/legal/services')).data;
    expect(services.services.find((s: any) => s.id === 'ga')).toMatchObject({ detected: true, active: true, override: null });
    expect(services.services.find((s: any) => s.id === 'tiktok')).toMatchObject({ detected: false, active: false });

    // Overrides from the wizard.
    await t.api.put('/api/legal/profile', { overrides: { ga: false, tiktok: true } });
    doc = (await t.api.post('/api/legal/generate', { kind: 'datenschutz' })).data;
    expect(heads()).not.toContain('Google Analytics');
    expect(heads()).toContain('TikTok-Pixel');
    expect((await t.api.get('/api/legal/services')).data.services.find((s: any) => s.id === 'ga')).toMatchObject({ detected: true, override: false, active: false });
    await t.api.put('/api/legal/profile', { overrides: {} });
  });

  it('generates every document kind and refuses unknown ones', async () => {
    for (const kind of ['impressum', 'datenschutz', 'widerruf', 'vvt']) {
      const r = (await t.api.post('/api/legal/generate', { kind })).data;
      expect(r.doc.sections.length, kind).toBeGreaterThan(3);
      expect(r.markdown, kind).toContain('keine Rechtsberatung');
    }
    const a = (await t.api.post('/api/legal/generate', { kind: 'avv', controller_name: 'Kundin GmbH', controller_address: 'Weg 2, 80331 München' })).data;
    expect(a.html).toContain('Kundin GmbH');
    expect(a.missing).toEqual([]);
    const w = (await t.api.post('/api/legal/generate', { kind: 'widerruf', type: 'service' })).data;
    expect(JSON.stringify(w.doc)).toContain('Besonderheiten bei Dienstleistungen');
    expect((await t.api.post('/api/legal/generate', { kind: 'agb' })).status).toBe(400);
    expect((await t.api.post('/api/legal/generate', { kind: 'constructor' })).status).toBe(400);
    expect((await t.api.post('/api/legal/generate', {})).status).toBe(400);
  });

  it('exports PDF, HTML, Markdown and text as downloads', async () => {
    const h = { cookie: t.api.cookie, 'x-location-id': loc };
    const pdf = await t.api.raw('/api/legal/export?kind=datenschutz&format=pdf', { headers: h });
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toContain('datenschutz.pdf');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    const md = await t.api.raw('/api/legal/export?kind=impressum&format=md', { headers: h });
    expect(await md.text()).toContain('## Angaben gemäß § 5 DDG');
    expect(await (await t.api.raw('/api/legal/export?kind=impressum&format=html', { headers: h })).text()).toContain('<h1>Impressum</h1>');
    expect(await (await t.api.raw('/api/legal/export?kind=vvt&format=txt', { headers: h })).text()).toContain('VERZEICHNIS VON VERARBEITUNGSTÄTIGKEITEN');
    expect((await t.api.raw('/api/legal/export?kind=impressum&format=docx', { headers: h })).status).toBe(400);
    const avvPdf = await t.api.raw('/api/legal/export?kind=avv&format=pdf&controller_name=X%20GmbH&controller_address=Weg%201', { headers: h });
    expect(Buffer.from(await avvPdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('hosts copies for sub-accounts without a website – only once the company data exists', async () => {
    const blank = (await t.api.post('/api/locations', { name: 'Leer' })).data;
    expect((await t.api.raw(`/legal/${blank.id}/impressum`)).status).toBe(404);
    expect((await t.api.raw(`/legal/${loc}/agb`)).status).toBe(404);
    expect((await t.api.raw(`/legal/nope/impressum`)).status).toBe(404);
    const r = await t.api.raw(`/legal/${loc}/impressum`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Testfirma GmbH');
    expect(html).toContain('Angaben gemäß § 5 DDG');
    expect(html).not.toContain('Entwurf – keine Rechtsberatung');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await (await t.api.raw(`/legal/${loc}/widerruf`)).text()).toContain('Muster-Widerrufsformular');
  });

  it('puts Impressum and Datenschutz into a website funnel instead of "Hier einfügen" – and does not overwrite pages the owner wrote', async () => {
    const funnel = (await t.api.post('/api/funnels', { name: 'Webseite', template: 'website' })).data;
    // The profile exists already: the new website comes with the generated texts.
    const pages = (await t.api.get(`/api/funnels/${funnel.id}`)).data.pages;
    const datenschutz = pages.find((p: any) => p.slug === 'datenschutz');
    const impr = pages.find((p: any) => p.slug === 'impressum');
    expect(JSON.stringify(datenschutz.blocks)).not.toContain('Hier deine Datenschutzerklärung einfügen');
    expect(JSON.stringify(datenschutz.blocks)).toContain('Verantwortlicher');
    expect(JSON.stringify(impr.blocks)).toContain('Testfirma GmbH');
    expect(JSON.stringify(impr.blocks)).not.toContain('Rechtsberatung');
    const shown = await (await t.api.raw(`/p/${funnel.slug}/impressum`)).text();
    expect(shown).toContain('Angaben gemäß § 5 DDG');

    // Own text stays unless asked.
    await t.api.patch(`/api/funnel-pages/${impr.id}`, { blocks: [{ type: 'text', text: 'Mein eigenes Impressum' }] });
    const kept = (await t.api.post(`/api/legal/funnels/${funnel.id}/apply`, {})).data;
    expect(kept.pages.some((p: any) => p.kind === 'impressum')).toBe(false);
    expect(JSON.stringify((await t.api.get(`/api/funnels/${funnel.id}`)).data.pages.find((p: any) => p.slug === 'impressum').blocks)).toContain('Mein eigenes Impressum');
    const forced = (await t.api.post(`/api/legal/funnels/${funnel.id}/apply`, { kinds: ['impressum'], overwrite: true })).data;
    expect(forced.pages[0]).toMatchObject({ kind: 'impressum', updated: true });
    expect(forced.pages[0].url).toBe(`http://localhost/p/${funnel.slug}/impressum`);
    // The footer links them (and the cookie settings, because the banner is on).
    const f = (await t.api.get(`/api/funnels/${funnel.id}`)).data;
    expect(f.settings.footer_text).toContain(`[Impressum](/p/${funnel.slug}/impressum)`);
    expect(f.settings.footer_text).toContain('[Cookie-Einstellungen](#cookie-settings)');
    // A funnel of another sub-account cannot be touched.
    const other = (await t.api.post('/api/locations', { name: 'Fremd' })).data;
    expect((await t.api.post(`/api/legal/funnels/${funnel.id}/apply`, {}, { 'x-location-id': other.id })).status).toBe(404);
  });

  it('a sub-account without company data keeps the placeholder pages (no half-empty legal text goes live)', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Ohne Daten' })).data;
    t.api.setLocation(other.id);
    try {
      const funnel = (await t.api.post('/api/funnels', { name: 'Site', template: 'website' })).data;
      const pages = (await t.api.get(`/api/funnels/${funnel.id}`)).data.pages;
      expect(JSON.stringify(pages.find((p: any) => p.slug === 'datenschutz').blocks)).toContain('Hier deine Datenschutzerklärung einfügen');
      expect((await t.api.post(`/api/legal/funnels/${funnel.id}/apply`, {})).status).toBe(400);
    } finally {
      t.api.setLocation(loc);
    }
  });

  it('eRecht24 is only a placeholder: configurable, never called, the key never comes back', async () => {
    const saved = (await t.api.put('/api/legal/profile', { external: { enabled: true, provider: 'erecht24', apiKey: 'er24-secret-key', project: 'p1' } })).data.profile;
    expect(saved.external).toMatchObject({ enabled: true, provider: 'erecht24', apiKey: '••••••', project: 'p1' });
    expect(JSON.stringify([(await t.api.get('/api/legal/profile')).data, (await t.api.get('/api/location')).data])).not.toContain('er24-secret-key');
    expect(JSON.stringify(t.app.db.get('SELECT settings FROM locations WHERE id = ?', loc))).not.toContain('er24-secret-key');
    const r = (await t.api.post('/api/legal/generate', { kind: 'impressum' })).data;
    expect(r.external).toMatchObject({ used: false });
    expect(r.external.reason).toContain('Platzhalter');
    expect(outbound).toEqual([]);
    // The masked value keeps the stored key.
    await t.api.put('/api/legal/profile', { external: { apiKey: '••••••' } });
    expect(t.app.services.legalTexts.profile(loc).external.apiKey).toBe('er24-secret-key');
    // A module that registers a provider makes it work (this is where the real call would live).
    t.app.services.legalTexts.providers.erecht24 = async (kind: string, p: LegalProfile) => ({ sections: [{ heading: `Extern ${kind}`, body: p.external.project }] });
    const used = (await t.api.post('/api/legal/generate', { kind: 'datenschutz' })).data;
    expect(used.external.used).toBe(true);
    expect(used.doc.sections[0]).toEqual({ heading: 'Extern datenschutz', body: 'p1' });
    delete t.app.services.legalTexts.providers.erecht24;
    await t.api.put('/api/legal/profile', { external: { enabled: false } });
  });

  it('other modules can reuse it: the service and more document kinds', async () => {
    const lt = t.app.services.legalTexts;
    expect(lt.profile(loc).company).toBe('Testfirma GmbH');
    expect(lt.kinds()).toEqual(expect.arrayContaining(['impressum', 'datenschutz', 'avv', 'vvt', 'widerruf']));
    lt.register('agb-cloud', (_l: string, o: any) => ({ kind: 'agb-cloud', title: 'AGB', subtitle: '', sections: [{ heading: '§ 1', body: String(o.x ?? '') }], missing: [], notice: lt.notice, services: [] }));
    const r = (await t.api.post('/api/legal/generate', { kind: 'agb-cloud', x: 'Geltungsbereich' })).data;
    expect(r.doc.sections[0].body).toBe('Geltungsbereich');
    expect(lt.render(lt.generate(loc, 'impressum'), 'md').body).toContain('# Impressum');
    expect(lt.hostedUrl(loc, 'datenschutz')).toBe(`http://localhost/legal/${loc}/datenschutz`);
  });

  it('is part of the sub-account settings area (members need the right)', async () => {
    const { requiredPermission } = await import('../server/core/permissions.js');
    for (const p of ['/api/legal/profile', '/api/legal/generate', '/api/consent/settings', '/api/cmp/settings', '/api/checkout-law/settings']) expect(requiredPermission('PUT', p)).toBe('settings');
    expect(requiredPermission('GET', '/api/contacts/x/consent')).toBe('contacts');
  });
});
