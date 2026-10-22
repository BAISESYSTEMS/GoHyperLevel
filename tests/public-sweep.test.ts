import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { publicPage } from '../server/core/page.js';
import { render } from '../server/core/template.js';
import { fitLine, latin, textW, type Page } from '../server/services/creator-pdf.js';
import { dunningPage, type LetterInput } from '../server/services/dunning-pdf.js';
import { jsSource } from '../server/services/form-runtime.js';
import { invoicePages } from '../server/services/invoice-pdf.js';
import { unsubscribeToken } from '../server/services/messaging.js';
import { startTestApp } from './helpers.js';
import { BUYER, SELLER, doc } from './invoice-fixtures.js';

/**
 * Third bug sweep (public pages, e-mails, PDFs): what a crawl of every public page at 375 px and 1440 px, every e-mail the system
 * sends rendered with sparse data (no name, no address, zero amounts, long names, umlauts, emoji) and every invoice/dunning PDF
 * with long data turned up. Each test fails on the code before the fix.
 */

vi.setConfig({ hookTimeout: 60_000 });

// --- PDFs: no text off the page or on top of other text -------------------------------------------------------------------

type Box = { s: string; x0: number; x1: number; y0: number; y1: number };
const boxes = (pg: Page): Box[] =>
  pg.prims
    .filter((p: any) => p.t === 'text')
    .map((p: any) => {
      const s = String(p.lines[0]);
      const w = textW(s, p.size, p.bold);
      const x0 = p.anchor === 'end' ? p.x - w : p.anchor === 'middle' ? p.x - w / 2 : p.x;
      // the body of the glyphs, not the whole line box (lines of a paragraph may touch)
      return { s, x0, x1: x0 + w, y0: p.y + p.size * 0.15, y1: p.y + p.size * 1.1 };
    });
function layoutProblems(pg: Page): string[] {
  const b = boxes(pg);
  const out: string[] = [];
  for (const x of b) if (x.x0 < -0.5 || x.x1 > pg.width + 0.5) out.push(`off the page: ${x.s}`);
  for (let i = 0; i < b.length; i++)
    for (let j = i + 1; j < b.length; j++) {
      const [a, c] = [b[i], b[j]];
      if (a.x0 < c.x1 - 0.5 && c.x0 < a.x1 - 0.5 && a.y0 < c.y1 - 0.5 && c.y0 < a.y1 - 0.5) out.push(`"${a.s}" on "${c.s}"`);
    }
  // the GiroCode (white square behind it) is not covered by text either
  for (const q of pg.prims.filter((p: any) => p.t === 'path' && p.fill === '#ffffff')) {
    const xs = (q as any).d.filter((c: any[]) => c.length === 3).map((c: any[]) => c[1]);
    const ys = (q as any).d.filter((c: any[]) => c.length === 3).map((c: any[]) => c[2]);
    const [qx0, qx1, qy0, qy1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    for (const x of b) if (x.x1 > qx0 + 0.5 && x.x0 < qx1 && x.y1 > qy0 && x.y0 < qy1) out.push(`"${x.s}" on the GiroCode`);
  }
  return out;
}

const LONG_COMPANY = 'Großbäckerei Süßwaren & Söhne Donaudampfschifffahrtsgesellschaftskapitänsmützenfabrik mbH & Co. KG 🎉';
const longSeller = {
  ...SELLER,
  name: 'Testfirma mit einem ziemlich langen Firmennamen Ü GmbH & Co. KG',
  street: 'Lange Straße der Republik 1234 Hinterhof Aufgang C',
  city: 'Berlin-Charlottenburg-Wilmersdorf',
  email: 'buchhaltung.rechnungswesen@sehr-lange-firmendomain-beispiel.example',
  contact_name: 'Erika Mustermann-Schnarrenberger',
  footer: 'Geschäftsführerin Erika Muster · Amtsgericht Berlin-Charlottenburg HRB 123456 B · ' + 'Sitz der Gesellschaft Berlin · '.repeat(4),
};
const longBuyer = { ...BUYER, company: LONG_COMPANY, name: 'Ägidius-Maximilian Jöran Friedrich Öztürk-Müller-Lüdenscheidt-Wüstenrot', street: 'Hauptstraße 123a, Hinterhaus, 3. Obergeschoss links, bei Familie Ömer', buyer_ref: 'PO-2026-000123456789-ABCDEFGHIJ' };

describe('PDFs with long names and addresses', () => {
  it('the invoice keeps letterhead, address window, information block, payment box and footer apart and on the page', () => {
    const { pages } = invoicePages(doc({ seller: longSeller as any, buyer: longBuyer as any }));
    expect(pages.flatMap(layoutProblems)).toEqual([]);
    // a normal document is unchanged in that respect
    expect(invoicePages(doc()).pages.flatMap(layoutProblems)).toEqual([]);
  });

  it('the buyer is never cut short: a name too long for the window wraps', () => {
    const { pages } = invoicePages(doc({ buyer: longBuyer as any }));
    const text = boxes(pages[0]).map((b) => b.s).join(' ');
    expect(text).toContain('Donaudampfschifffahrtsgesellschaftskapitänsmützenfabrik');
    expect(text).toContain('Wüstenrot');
  });

  it('the dunning letter keeps the address clear of the date', () => {
    const letter: LetterInput = {
      title: '1. Mahnung',
      brand: { name: longSeller.name, address: `${longSeller.street}, 10115 Berlin`, email: longSeller.email, iban: 'DE02120300000000202051', bic: 'BYLADEM1001', bank: 'DKB' },
      recipient: { name: longBuyer.name, company: `${LONG_COMPANY} Zweigniederlassung München`, address: longBuyer.street, postal_code: '80331', city: 'München' },
      date: '2026-10-05T10:00:00Z',
      tz: 'Europe/Berlin',
      reference: { number: 'RE-1008', issued_at: '2026-09-01T10:00:00Z', due_at: '2026-09-15T10:00:00Z' },
      currency: 'EUR',
      amounts: { principal_cents: 10591, fee_cents: 500, interest_cents: 60, flat_fee_cents: 4000, total_cents: 15151, rate: 10.27, days: 20 },
      levelLabel: '1. Mahnung',
      deadline: '12.10.2026',
      body: 'Hallo,\n\nbitte überweisen Sie den offenen Betrag.',
      invoiceUrl: 'https://crm.example.com/i/abc',
    };
    expect(layoutProblems(dunningPage(letter))).toEqual([]);
  });

  it('drops emoji instead of printing "?" and keeps ©, ® and ™', () => {
    expect(latin('Öztürk 🎉')).toBe('Öztürk');
    expect(latin('🎉 Party-Paket')).toBe('Party-Paket');
    expect(latin('Familie 👨‍👩‍👧 Müller · Daumen 👍🏽!')).toBe('Familie Müller · Daumen!');
    expect(latin('ACME® Brand™ © 2026')).toBe('ACME® Brand™ © 2026');
  });

  it('fits a line into a column: smaller first, cut with "…" only as the last resort', () => {
    expect(fitLine('Kurz', 12, 200)).toEqual({ text: 'Kurz', size: 12 });
    const f = fitLine('Testfirma mit einem ziemlich langen Namen', 12, 180, { min: 9 });
    expect(f.text).toBe('Testfirma mit einem ziemlich langen Namen');
    expect(f.size).toBeLessThan(12);
    const cut = fitLine('x'.repeat(200), 12, 100, { min: 9 });
    expect(cut.text.endsWith('…')).toBe(true);
    expect(textW(cut.text, cut.size)).toBeLessThanOrEqual(100);
  });
});

// --- merge fields with sparse data ------------------------------------------------------------------------------------------

describe('merge fields of a contact without a name', () => {
  it('leave no gap before punctuation', () => {
    const none = { contact: { first_name: '' } };
    expect(render('Hallo {{contact.first_name|}},\n\nText', none)).toBe('Hallo,\n\nText');
    expect(render('Danke für deine Anfrage, {{contact.first_name|}}!', none)).toBe('Danke für deine Anfrage!');
    expect(render('Hi, {{contact.first_name}}, schön', none)).toBe('Hi, schön');
    expect(render('Rechnung {{invoice.number}} ist offen', none)).toBe('Rechnung ist offen');
    expect(render('Du hast etwas vergessen, {{contact.first_name|}}', none)).toBe('Du hast etwas vergessen');
    // with a value, and with a fallback, nothing changes
    expect(render('Hallo {{contact.first_name|}},', { contact: { first_name: 'Anna' } })).toBe('Hallo Anna,');
    expect(render('Hallo {{contact.first_name|du}},', none)).toBe('Hallo du,');
    expect(render('<p>Hallo {{contact.first_name}},</p>', { contact: { first_name: '<b>' } }, { escape: true })).toBe('<p>Hallo &lt;b&gt;,</p>');
  });
});

// --- through the app: mails, unsubscribe, public pages --------------------------------------------------------------------

describe('mails and public pages', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const mails: any[] = [];
  beforeAll(async () => {
    t = await startTestApp({ baseUrl: 'https://crm.example.com' });
    await t.setup();
    t.app.services.emailTransports = { capture: async (_l: any, mail: any) => (mails.push(mail), { status: 'sent', providerId: `m${mails.length}` }) };
    await t.api.patch('/api/location', { settings: { email: { provider: 'capture' } } });
  });
  afterAll(async () => t?.close());

  const invoice = async (contactId: string, cents: number) => {
    const d = (await t.api.post('/api/invoices', { contact_id: contactId, items: [{ name: 'Beratung', qty: 1, price_cents: cents, tax_rate: 19 }] })).data;
    expect((await t.api.post(`/api/invoices/${d.id}/finalise`, {})).status).toBe(200);
    return d;
  };

  it('the invoice mail to a contact without a name says "Hallo," – and a credit note is "über 11,90 €", not "-11,90 €"', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'ohne-name@kunde.example' })).data;
    const inv = await invoice(c.id, 10000);
    mails.length = 0;
    expect((await t.api.post(`/api/invoices/${inv.id}/send`, {})).status).toBe(200);
    expect(mails[0].text).toMatch(/^Hallo,\n/);
    expect(mails[0].text).not.toContain('Hallo ,');
    const cn = (await t.api.post(`/api/invoices/${inv.id}/credit-note`, { items: [{ name: 'Nachlass', qty: 1, price_cents: 1000, tax_rate: 19 }], reason: 'Kulanz' })).data;
    await t.api.post(`/api/invoices/${cn.id}/finalise`, {});
    mails.length = 0;
    expect((await t.api.post(`/api/invoices/${cn.id}/send`, {})).status).toBe(200);
    expect(mails[0].text).toMatch(/über 11,90\s€/);
    expect(mails[0].text).not.toContain('-11,90');
  });

  it('opening the unsubscribe link (a link scanner, an anti-spam filter fetching List-Unsubscribe) unsubscribes nobody – the button does', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'scanner@kunde.example' })).data;
    const link = `/u/${c.id}/${unsubscribeToken(t.app, c.id)}`;
    for (let i = 0; i < 3; i++) {
      const page = await t.api.raw(link);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('Ja, abmelden');
      expect(html).toContain(`action="${link}"`);
      expect(page.headers.get('cache-control')).toBe('no-store');
    }
    expect((await t.api.get(`/api/contacts/${c.id}`)).data.dnd).toBe(0);
    const done = await t.api.raw(link, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=1' });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Abgemeldet');
    expect((await t.api.get(`/api/contacts/${c.id}`)).data.dnd).toBe(1);
    // RFC 8058 one-click from the mail client stays one POST without a page
    const c2 = (await t.api.post('/api/contacts', { email: 'oneclick@kunde.example' })).data;
    const one = await t.api.raw(`/u/${c2.id}/${unsubscribeToken(t.app, c2.id)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    expect(await one.json()).toEqual({ ok: true });
    expect((await t.api.get(`/api/contacts/${c2.id}`)).data.dnd).toBe(1);
    const wrong = await t.api.raw(`/u/${c2.id}/falsch`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=1' });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('nicht gültig');
  });

  it('the review page can be used with the keyboard and says when sending failed', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'bewertung@kunde.example' })).data;
    const req = (await t.api.post('/api/reviews/request', { contact_id: c.id })).data;
    const html = await (await t.api.raw(`/r/${req.token}`)).text();
    expect(html.match(/<button type="button" class="rv-star" data-n="\d" aria-pressed="false" aria-label="\d von 5 Sternen">/g)).toHaveLength(5);
    expect(html).not.toContain('<span data-n=');
    expect(html).toContain('<label for="rv-comment">');
    expect(html).toContain('<textarea id="rv-comment"');
    expect(html).toContain('if (!r || !r.ok)');
  });

  it('the chat window names its fields and the send button', async () => {
    await t.api.patch('/api/location', { settings: { chat: { enabled: true } } });
    const html = await (await t.api.raw(`/chat/${t.api.location}/frame`)).text();
    expect(html).toContain('aria-label="Dein Name"');
    expect(html).toContain('aria-label="E-Mail (für die Antwort)"');
    expect(html).toContain('aria-label="Nachricht"');
    expect(html).toContain('<button aria-label="Senden">');
    expect(html).toContain('role="log"');
    const js = await (await t.api.raw(`/chat/${t.api.location}/widget.js`)).text();
    expect(js).toContain("'Chat schließen'");
    expect(js).toContain('aria-expanded');
  });

  it('long words wrap on a phone: headings of every public page and the positions of a quote', async () => {
    const page = publicPage({ title: 'x', body: '' });
    expect(page).toMatch(/h1, h2, h3 \{ overflow-wrap: anywhere; hyphens: auto; \}/);
    expect(page).toMatch(/body \{[^}]*overflow-wrap: break-word;/);
    const pipes = (await t.api.get('/api/pipelines')).data;
    const c = (await t.api.post('/api/contacts', { email: 'angebot@kunde.example' })).data;
    const deal = (await t.api.post('/api/opportunities', { pipeline_id: (pipes.pipelines ?? pipes)[0].id, contact_id: c.id, name: 'Projekt', value: 0 })).data;
    const q = (await t.api.post('/api/quotes', { deal_id: deal.id, title: 'Plattform', items: [{ name: 'Donaudampfschifffahrtsgesellschaftskapitänsmütze', qty: 1, price_cents: 50000, tax_rate: 19 }] })).data;
    expect((await t.api.post(`/api/quotes/${q.id}/send`, {})).status).toBe(200);
    const tok = t.app.db.get<any>('SELECT public_token FROM deal_quotes WHERE id = ?', q.id).public_token;
    const html = await (await t.api.raw(`/q/${tok}`)).text();
    expect(html).toContain('.q-tbl .n{overflow-wrap:anywhere;hyphens:auto}');
    expect(html).toMatch(/\.q-card h1\{[^}]*overflow-wrap:anywhere/);
  });
});

// --- forms: the keyboard stays in the form ------------------------------------------------------------------------------------

describe('forms with several screens', () => {
  it('move a lost focus to the new screen (one question at a time: choices, stars, scales; classic pages)', () => {
    // tf.js: no field to type into → the screen itself takes the focus, so Enter and the letters keep working
    expect(jsSource('tf')).toMatch(/s\.tabIndex=-1;s\.focus\(\{preventScroll:true\}\)/);
    // nav.js: Enter on the last field of a classic page → the first field of the next page
    expect(jsSource('nav')).toMatch(/if\(!CFG\.tf\)\$\.on\('show'/);
  });
});
