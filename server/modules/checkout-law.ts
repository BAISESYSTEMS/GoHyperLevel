import type { App, Module } from '../core/app.js';
import { HttpError, bad, num, str, type Ctx } from '../core/http.js';
import { sealSettings } from '../core/secrets.js';
import { escapeHtml } from '../core/template.js';
import { id, now } from '../core/util.js';
import { logActivity } from '../services/contacts.js';
import { ensureText, metaOf } from '../services/consent.js';
import { sendToContact } from '../services/messaging.js';

/**
 * Checkout rules for sales to consumers in Germany, on the buy page (/buy/<product>) through its hooks (buyPageHtml, buyCheckout):
 *  - Button-Lösung (§ 312j Abs. 3 BGB): the order button says "zahlungspflichtig bestellen";
 *  - the AGB box (only once an AGB address is set – the server refuses an order without it) and the link to the Widerrufsbelehrung;
 *  - for digital content (§ 356 Abs. 5 BGB) or services (§ 356 Abs. 4 BGB) the box that asks for the start before the end of the
 *    withdrawal period and acknowledges the loss of the right of withdrawal;
 *  - what was shown and accepted is kept with the order (text versions, time, IP network, browser fingerprint), put into Stripe's
 *    metadata, and a confirmation mail with the Widerrufsbelehrung follows the purchase (the information on a durable medium).
 * Settings are per sub-account (settings.checkout_law); the page and the wording are in German.
 */

export type ContentType = 'none' | 'digital' | 'service' | 'physical';

export interface LawSettings {
  enabled: boolean;
  button_text: string;
  /** Address of the AGB; empty = no AGB box. */
  terms_url: string;
  /** Sale type for the whole sub-account: decides the waiver box. */
  content_type: ContentType;
  /** Per product (by id) overrides of content_type. */
  products: Record<string, ContentType>;
  /** Address of the Widerrufsbelehrung; empty = the generated one hosted by the app (when the company data exists). */
  withdrawal_url: string;
  /** The "Bestellbestätigung" mail with the Widerrufsbelehrung after a purchase through the buy page. */
  confirmation_mail: boolean;
}

export const DEFAULT_BUTTON = 'zahlungspflichtig bestellen';
export const DEFAULT_LAW: LawSettings = { enabled: true, button_text: DEFAULT_BUTTON, terms_url: '', content_type: 'none', products: {}, withdrawal_url: '', confirmation_mail: true };

const TYPES: ContentType[] = ['none', 'digital', 'service', 'physical'];
const url = (v: unknown) => (/^https?:\/\/[^\s"'<>]{3,500}$/i.test(String(v ?? '').trim()) ? String(v).trim() : '');

/** The button has to name the payment obligation unmistakably (§ 312j Abs. 3 BGB): "zahlungspflichtig/kostenpflichtig" + an order verb. */
export const buttonOk = (t: string) => /(zahlungs|kosten)pflichtig/i.test(t) && /(bestell|kauf|abonnier|buch|abschlie|bezahl)/i.test(t);

export function cleanLaw(raw: unknown): LawSettings {
  const r: any = raw && typeof raw === 'object' ? raw : {};
  const products: Record<string, ContentType> = {};
  if (r.products && typeof r.products === 'object') for (const [k, v] of Object.entries(r.products)) if (/^[\w-]{1,40}$/.test(k) && TYPES.includes(v as ContentType)) products[k] = v as ContentType;
  const button = typeof r.button_text === 'string' ? r.button_text.trim().slice(0, 60) : '';
  return {
    enabled: r.enabled !== false,
    button_text: button && buttonOk(button) ? button : DEFAULT_BUTTON,
    terms_url: url(r.terms_url),
    content_type: TYPES.includes(r.content_type) ? r.content_type : 'none',
    products,
    withdrawal_url: url(r.withdrawal_url),
    confirmation_mail: r.confirmation_mail !== false,
  };
}

export const termsLabel = (href: string) => `Ich habe die <a href="${escapeHtml(href)}" target="_blank" rel="noopener">Allgemeinen Geschäftsbedingungen</a> gelesen und akzeptiere sie.`;
export const termsPlain = 'Ich habe die Allgemeinen Geschäftsbedingungen gelesen und akzeptiere sie.';

/** The wording of the box that asks for the start before the end of the withdrawal period (§ 356 Abs. 4 / 5 BGB). */
export function waiverText(kind: 'digital' | 'service', company: string): string {
  const who = company.trim() || 'der Anbieter';
  return kind === 'digital'
    ? `Ich stimme ausdrücklich zu, dass ${who} vor Ablauf der Widerrufsfrist mit der Ausführung des Vertrags (Bereitstellung der digitalen Inhalte) beginnt. Mir ist bekannt, dass ich mit Beginn der Ausführung des Vertrags mein Widerrufsrecht verliere.`
    : `Ich verlange ausdrücklich, dass ${who} vor Ablauf der Widerrufsfrist mit der Ausführung der Dienstleistung beginnt. Mir ist bekannt, dass mein Widerrufsrecht bei vollständiger Vertragserfüllung erlischt und ich bei einem Widerruf nach Beginn der Ausführung einen angemessenen Wertersatz zahlen muss.`;
}

export const checkoutLawModule: Module = {
  name: 'checkout-law',
  migrations: [
    [
      '001-acceptances',
      `
      CREATE TABLE checkout_acceptances (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        product_id TEXT, session_id TEXT, invoice_id TEXT,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, email TEXT NOT NULL DEFAULT '',
        terms_url TEXT NOT NULL DEFAULT '', terms_text_id TEXT, terms_version INTEGER,
        waiver_kind TEXT NOT NULL DEFAULT '', waiver_text_id TEXT, waiver_version INTEGER,
        withdrawal_url TEXT NOT NULL DEFAULT '', button_text TEXT NOT NULL DEFAULT '',
        ip_net TEXT NOT NULL DEFAULT '', ua_digest TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX checkout_acceptances_loc ON checkout_acceptances(location_id, created_at);
      CREATE INDEX checkout_acceptances_session ON checkout_acceptances(session_id);
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;

    const lawOf = (locationId: string): LawSettings => cleanLaw(app.location(locationId)?.settings.checkout_law);
    const typeOf = (s: LawSettings, productId: string): ContentType => s.products[productId] ?? s.content_type;
    const links = (locationId: string, s: LawSettings) => {
      const profile = app.services.legalTexts?.profile?.(locationId);
      const hosted = !!profile?.company && (!!profile.email || !!profile.street);
      const host = (kind: string) => (hosted ? (app.services.legalTexts.hostedUrl(locationId, kind) as string) : '');
      return { withdrawal: s.withdrawal_url || host('widerruf'), privacy: host('datenschutz'), imprint: host('impressum') };
    };

    // The label of the order button (stripe.ts asks): only the button text, nothing else changes without settings.
    app.services.buyButtonLabel = (p: { location_id: string }) => {
      const s = lawOf(p.location_id);
      return s.enabled ? s.button_text : undefined;
    };

    // --- the boxes and links on the buy page ----------------------------------------------------------------------------
    app.services.buyPageHtml = [
      ...(app.services.buyPageHtml ?? []),
      (_ctx: Ctx, p: any) => {
        const s = lawOf(p.location_id);
        if (!s.enabled) return '';
        const loc = app.location(p.location_id);
        const type = typeOf(s, p.id);
        const l = links(p.location_id, s);
        const rows: string[] = [];
        if (s.terms_url) rows.push(`<label class="check"><input type="checkbox" name="law_terms" value="1" required> <span>${termsLabel(s.terms_url)}</span></label>`);
        if (type === 'digital' || type === 'service') rows.push(`<label class="check" style="margin-top:8px"><input type="checkbox" name="law_waiver" value="1" required> <span>${escapeHtml(waiverText(type, loc?.name ?? ''))}</span></label>`);
        const small = !!loc?.settings.invoices?.small_business;
        const info = [
          l.withdrawal ? `Informationen zum <a href="${escapeHtml(l.withdrawal)}" target="_blank" rel="noopener">Widerrufsrecht</a>` : '',
          l.privacy ? `<a href="${escapeHtml(l.privacy)}" target="_blank" rel="noopener">Datenschutz</a>` : '',
          l.imprint ? `<a href="${escapeHtml(l.imprint)}" target="_blank" rel="noopener">Impressum</a>` : '',
        ].filter(Boolean);
        const vat = small ? 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.' : 'Alle Preise inklusive der gesetzlichen Umsatzsteuer.';
        const ship = type === 'physical' ? ' Zuzüglich etwaiger Versandkosten.' : type === 'digital' || type === 'service' ? ' Keine Versandkosten.' : '';
        return `<div class="pghl-law" style="margin:14px 0;font-size:14px">${rows.join('')}<p class="muted" style="font-size:12px;margin:10px 0 0">${escapeHtml(vat)}${escapeHtml(ship)}${info.length ? ` ${info.join(' · ')}` : ''}</p></div>`;
      },
    ];

    // --- the order: refuse without the boxes, remember what was accepted ----------------------------------------------------
    const ticked = (v: unknown) => v === '1' || v === 'on' || v === 'ja' || v === true;
    app.services.buyCheckout = [
      ...(app.services.buyCheckout ?? []),
      (ctx: Ctx, o: { product: any; params: Record<string, any>; meta: Record<string, any> }) => {
        const s = lawOf(o.product.location_id);
        if (!s.enabled) return;
        const loc = app.location(o.product.location_id);
        const type = typeOf(s, o.product.id);
        const body = ctx.body ?? {};
        if (s.terms_url && !ticked(body.law_terms)) throw new Error('Bitte bestätige, dass du die AGB gelesen hast und akzeptierst.');
        const waiver = type === 'digital' || type === 'service' ? type : '';
        if (waiver && !ticked(body.law_waiver)) throw new Error(waiver === 'digital' ? 'Bitte stimme der sofortigen Bereitstellung der digitalen Inhalte und dem Erlöschen des Widerrufsrechts zu.' : 'Bitte bestätige den Beginn der Dienstleistung vor Ablauf der Widerrufsfrist.');
        if (!s.terms_url && !waiver) return;
        const loc2 = o.product.location_id as string;
        const terms = s.terms_url ? ensureText(app, loc2, 'checkout:terms', termsPlain) : null;
        const w = waiver ? ensureText(app, loc2, `checkout:waiver:${waiver}`, waiverText(waiver, loc?.name ?? '')) : null;
        const meta = metaOf(ctx);
        const row = {
          id: id(),
          location_id: loc2,
          product_id: o.product.id,
          email: String(body.email ?? '').slice(0, 200),
          terms_url: s.terms_url,
          terms_text_id: terms?.id ?? null,
          terms_version: terms?.version ?? null,
          waiver_kind: waiver,
          waiver_text_id: w?.id ?? null,
          waiver_version: w?.version ?? null,
          withdrawal_url: links(loc2, s).withdrawal,
          button_text: s.button_text,
          ip_net: meta.ip_net,
          ua_digest: meta.ua_digest,
          created_at: now(),
        };
        db.insert('checkout_acceptances', row);
        // Into Stripe's metadata (comes back with the webhook) – flags and versions, not personal data.
        Object.assign(o.meta, { law_id: row.id, law_terms: terms ? `v${terms.version}` : '', law_waiver: w ? `${waiver}:v${w.version}` : '' });
      },
    ];

    // --- after the purchase: link the proof to the order and the contact, send the confirmation ---------------------------
    app.events.on('product.purchased', async (e) => {
      const d = e.data ?? {};
      const lawId = String(d.metadata?.law_id ?? '');
      if (!lawId) return;
      const row = db.get<any>('SELECT * FROM checkout_acceptances WHERE id = ? AND location_id = ?', lawId, e.locationId);
      if (!row) return;
      const buyer = d.contactId ? db.get<{ email: string }>('SELECT email FROM contacts WHERE id = ? AND location_id = ?', d.contactId, e.locationId) : undefined;
      db.run('UPDATE checkout_acceptances SET session_id = ?, invoice_id = ?, contact_id = ?, email = ? WHERE id = ?', d.sessionId ?? null, d.invoiceId ?? null, d.contactId ?? null, buyer?.email || row.email, row.id);
      if (!d.contactId) return;
      const parts = [row.terms_version ? `AGB (Version ${row.terms_version})` : '', row.waiver_kind ? `${row.waiver_kind === 'digital' ? 'Zustimmung zur sofortigen Bereitstellung / Verzicht auf das Widerrufsrecht' : 'Beginn der Dienstleistung vor Ablauf der Widerrufsfrist'} (Version ${row.waiver_version})` : ''].filter(Boolean);
      logActivity(app, e.locationId, d.contactId, 'checkout.accepted', `Bei der Bestellung bestätigt: ${parts.join(', ')}`, { acceptance_id: row.id, session_id: d.sessionId });
      const s = lawOf(e.locationId);
      if (!s.confirmation_mail) return;
      const loc = app.location(e.locationId);
      const l = links(e.locationId, s);
      const lines = [
        `Hallo {{contact.first_name|}},`,
        '',
        `vielen Dank für deine Bestellung von „${String(d.product?.name ?? 'deinem Produkt')}“ bei ${loc?.name ?? ''}. Hier die Bestätigung zu deinem Vertrag:`,
        '',
        ...(row.terms_url ? [`- AGB: ${row.terms_url} (bei der Bestellung akzeptiert)`] : []),
        ...(l.withdrawal ? [`- Widerrufsbelehrung und Muster-Widerrufsformular: ${l.withdrawal}`] : []),
        ...(row.waiver_kind ? [`- ${waiverText(row.waiver_kind, loc?.name ?? '')}`, '  (bei der Bestellung ausdrücklich bestätigt)'] : []),
        '',
        'Bitte bewahre diese E-Mail auf.',
        '',
        'Viele Grüße',
        `${loc?.name ?? ''}`,
      ];
      try {
        await sendToContact(app, e.locationId, { contactId: d.contactId, channel: 'email', subject: `Bestätigung deiner Bestellung bei ${loc?.name ?? ''}`.slice(0, 200), body: lines.join('\n').replace('{{contact.first_name|}}', ''), source: 'Bestellbestätigung', ignoreDnd: true, purpose: 'transactional' });
      } catch (err) {
        console.error('[checkout-law] Bestätigung:', (err as Error).message);
      }
    });

    // Erasure: the proof stays with the order (accounting / defence of claims), the person's own traces go.
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_app: App, loc: string, contact: { id: string }) => void db.run(`UPDATE checkout_acceptances SET email = '', ip_net = '', ua_digest = '' WHERE contact_id = ? AND location_id = ?`, contact.id, loc),
    ];

    // --- API -----------------------------------------------------------------------------------------------------------------
    const writable = (ctx: Ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
    };
    router.get('/api/checkout-law/settings', 'location', (ctx) => {
      const s = lawOf(ctx.locationId);
      return { settings: s, defaults: DEFAULT_LAW, links: links(ctx.locationId, s), waiver: { digital: waiverText('digital', app.location(ctx.locationId)?.name ?? ''), service: waiverText('service', app.location(ctx.locationId)?.name ?? '') }, terms_text: termsPlain, products: db.all('SELECT id, name FROM products WHERE location_id = ? AND active = 1 ORDER BY name LIMIT 200', ctx.locationId) };
    });
    router.put('/api/checkout-law/settings', 'location', (ctx) => {
      writable(ctx);
      const b = ctx.body ?? {};
      if (b.button_text !== undefined && String(b.button_text).trim() && !buttonOk(String(b.button_text))) throw bad('Der Button muss die Zahlungspflicht eindeutig nennen, z. B. „zahlungspflichtig bestellen“ (§ 312j BGB)');
      if (b.terms_url !== undefined && String(b.terms_url).trim() && !url(b.terms_url)) throw bad('Adresse der AGB: eine vollständige https-Adresse');
      if (b.withdrawal_url !== undefined && String(b.withdrawal_url).trim() && !url(b.withdrawal_url)) throw bad('Adresse der Widerrufsbelehrung: eine vollständige https-Adresse');
      const loc = app.location(ctx.locationId)!;
      const next = cleanLaw({ ...lawOf(ctx.locationId), ...b, products: b.products !== undefined ? b.products : lawOf(ctx.locationId).products });
      db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify(sealSettings(app, { ...loc.settings, checkout_law: next }).value), ctx.locationId);
      return { settings: next };
    });
    router.get('/api/checkout-law/acceptances', 'location', (ctx) =>
      db.all(
        `SELECT a.id, a.product_id, a.session_id, a.invoice_id, a.contact_id, a.email, a.terms_version, a.waiver_kind, a.waiver_version, a.ip_net, a.created_at, p.name AS product_name
         FROM checkout_acceptances a LEFT JOIN products p ON p.id = a.product_id WHERE a.location_id = ? ORDER BY a.created_at DESC LIMIT ?`,
        ctx.locationId,
        Math.min(Math.max(num(ctx.query.get('limit'), 100), 1), 500),
      ),
    );
    void str;
  },
};
