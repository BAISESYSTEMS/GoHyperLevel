import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, html, notFound, redirect, str, type Ctx } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { centsToMoney, normalizeEmail, now, slugify } from '../core/util.js';
import { addTags, getContact, logActivity, removeTags, upsertContact } from '../services/contacts.js';
import { invAudit, loadInvoice, recordPayment, type Actor } from '../services/invoice-flow.js';
import { openCents } from '../services/invoice-model.js';
import {
  MIN_AMOUNT_CENTS,
  StripeError,
  dashboardUrl,
  invoiceLineItems,
  isLiveKey,
  isSecretKey,
  isWebhookSecret,
  keyHint,
  lineItemParams,
  stripeRequest,
  verifyStripeSignature,
} from '../services/stripe.js';
import { openSecret, sealSecret } from './mail-sync.js';
import { createInvoice, invoiceSettings, markInvoicePaid, sendInvoice } from './payments.js';

/**
 * Stripe direct payments per sub-account: the sub-account's own Stripe key creates Checkout
 * Sessions for open invoices ("Jetzt bezahlen" on the customer link) and for products
 * (public buy link /buy/<id|slug>). Stripe calls /hooks/stripe/<locationId> when money arrived;
 * the invoice turns paid, invoice.paid / product.purchased start workflows, buyers get the tag
 * `kauf:<produkt>` (course access).
 */

interface Account {
  location_id: string;
  secret_key: string;
  webhook_secret: string;
  key_hint: string;
  account_id: string;
  account_name: string;
  livemode: number;
  options: { auto_send_receipt?: boolean };
  checked_at: string | null;
}

/** Simple per-IP throttle for the public checkout starts (each one is a Stripe API call). */
const starts = new Map<string, number[]>();
function throttled(ip: string, max = 20, windowMs = 60 * 60_000): boolean {
  const t = Date.now();
  const list = (starts.get(ip) ?? []).filter((x) => t - x < windowMs);
  list.push(t);
  starts.set(ip, list);
  if (starts.size > 20_000) starts.clear();
  return list.length > max;
}

const PAID_SESSION = new Set(['paid', 'no_payment_required']);
const STRIPE_ACTOR: Actor = { id: null, name: 'Automatik (Stripe)' };

export const stripeModule: Module = {
  name: 'stripe',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE stripe_accounts (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        secret_key TEXT NOT NULL DEFAULT '', webhook_secret TEXT NOT NULL DEFAULT '', key_hint TEXT NOT NULL DEFAULT '',
        account_id TEXT NOT NULL DEFAULT '', account_name TEXT NOT NULL DEFAULT '', livemode INTEGER NOT NULL DEFAULT 0,
        options TEXT NOT NULL DEFAULT '{}', checked_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE stripe_checkouts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, invoice_id TEXT, product_id TEXT, contact_id TEXT,
        url TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'payment',
        amount_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR',
        status TEXT NOT NULL DEFAULT 'open', email TEXT NOT NULL DEFAULT '', payment_intent TEXT, subscription TEXT,
        meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, paid_at TEXT
      );
      CREATE INDEX stripe_checkouts_invoice ON stripe_checkouts(invoice_id);
      CREATE INDEX stripe_checkouts_location ON stripe_checkouts(location_id, status);
      CREATE TABLE stripe_events (
        location_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY (location_id, id)
      );
      CREATE TABLE stripe_product_links (
        product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE, location_id TEXT NOT NULL,
        slug TEXT UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, redirect_url TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    const account = (locationId: string): Account | undefined => parseJson(db.get<Account>('SELECT * FROM stripe_accounts WHERE location_id = ?', locationId), ['options']);
    const secretOf = (acc: Account | undefined) => (acc?.secret_key ? openSecret(app, acc.secret_key) : '');
    /** For workflow steps (modules/connector-apps-biz.ts): the sub-account's secret key, or '' without one. */
    app.services.stripeKey = (locationId: string) => secretOf(account(locationId));
    const money = (c: number, cur: string) => centsToMoney(c, cur.toUpperCase());
    const defaultTax = (locationId: string) => {
      const s = app.location(locationId)?.settings.invoices ?? {};
      return s.small_business ? 0 : Number(s.tax_rate ?? 19);
    };
    const push = (locationId: string, title: string, body: string, url: string) =>
      void Promise.resolve(app.services.pushNotify?.({ locationId, kind: 'payments', title, body, url, tag: `pay-${url}` })).catch(() => {});

    const status = (locationId: string) => {
      const acc = account(locationId);
      return {
        connected: !!acc?.secret_key,
        key_set: !!acc?.secret_key,
        key_hint: acc?.key_hint ?? '',
        live: !!acc?.livemode,
        webhook_set: !!acc?.webhook_secret,
        webhook_url: `${app.baseUrl()}/hooks/stripe/${locationId}`,
        account: acc?.account_id ? { id: acc.account_id, name: acc.account_name } : null,
        checked_at: acc?.checked_at ?? null,
        options: { auto_send_receipt: acc?.options?.auto_send_receipt !== false },
      };
    };

    /** GET /v1/account – proves the key works and tells whose account it is. */
    async function testKey(key: string) {
      const a = await stripeRequest(key, 'GET', '/v1/account');
      return {
        id: String(a.id ?? ''),
        name: String(a.settings?.dashboard?.display_name || a.business_profile?.name || a.email || a.id || ''),
        country: a.country ?? '',
        currency: a.default_currency ?? '',
        charges_enabled: a.charges_enabled !== false,
      };
    }
    const stripeFail = (e: unknown) => (e instanceof StripeError ? new HttpError(e.status === 401 ? 400 : 502, e.message) : e);

    // --- settings ---------------------------------------------------------------
    router.get('/api/stripe', 'location', (ctx) => status(ctx.locationId));
    router.put('/api/stripe', 'location', async (ctx) => {
      const b = ctx.body ?? {};
      const cur = account(ctx.locationId);
      const row: Record<string, any> = {
        location_id: ctx.locationId,
        secret_key: cur?.secret_key ?? '',
        webhook_secret: cur?.webhook_secret ?? '',
        key_hint: cur?.key_hint ?? '',
        account_id: cur?.account_id ?? '',
        account_name: cur?.account_name ?? '',
        livemode: cur?.livemode ?? 0,
        options: { ...(cur?.options ?? {}) },
        checked_at: cur?.checked_at ?? null,
        updated_at: now(),
      };
      const key = str(b.secret_key, 'Secret Key', { max: 300 });
      if (key && key !== '••••••') {
        if (!isSecretKey(key)) throw bad('Secret Key: beginnt mit sk_live_, sk_test_ oder rk_… (Stripe → Entwickler → API-Schlüssel)');
        const acc = await testKey(key).catch((e) => {
          throw stripeFail(e);
        });
        Object.assign(row, { secret_key: sealSecret(app, key), key_hint: keyHint(key), account_id: acc.id, account_name: acc.name, livemode: isLiveKey(key) ? 1 : 0, checked_at: now() });
      }
      const wh = str(b.webhook_secret, 'Signing Secret', { max: 300 });
      if (wh && wh !== '••••••') {
        if (!isWebhookSecret(wh)) throw bad('Signing Secret: beginnt mit whsec_ (Stripe → Webhooks → Endpunkt → Signing Secret)');
        row.webhook_secret = sealSecret(app, wh);
      }
      if (b.options && typeof b.options === 'object') {
        if (b.options.auto_send_receipt !== undefined) row.options.auto_send_receipt = !!b.options.auto_send_receipt;
      }
      if (!row.secret_key && !cur) throw bad('Bitte zuerst den Secret Key eintragen');
      db.run(
        `INSERT INTO stripe_accounts (location_id, secret_key, webhook_secret, key_hint, account_id, account_name, livemode, options, checked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(location_id) DO UPDATE SET secret_key = excluded.secret_key, webhook_secret = excluded.webhook_secret, key_hint = excluded.key_hint,
           account_id = excluded.account_id, account_name = excluded.account_name, livemode = excluded.livemode, options = excluded.options,
           checked_at = excluded.checked_at, updated_at = excluded.updated_at`,
        row.location_id, row.secret_key, row.webhook_secret, row.key_hint, row.account_id, row.account_name, row.livemode, JSON.stringify(row.options), row.checked_at, row.updated_at,
      );
      return status(ctx.locationId);
    });
    router.post('/api/stripe/test', 'location', async (ctx) => {
      const typed = str(ctx.body?.secret_key, 'Secret Key', { max: 300 });
      const key = typed && typed !== '••••••' ? typed : secretOf(account(ctx.locationId));
      if (!key) throw bad('Noch kein Secret Key gespeichert');
      if (!isSecretKey(key)) throw bad('Secret Key: beginnt mit sk_live_, sk_test_ oder rk_…');
      try {
        const acc = await testKey(key);
        if (!typed) db.run('UPDATE stripe_accounts SET account_id = ?, account_name = ?, checked_at = ? WHERE location_id = ?', acc.id, acc.name, now(), ctx.locationId);
        return { ok: true, live: isLiveKey(key), account: acc };
      } catch (e) {
        throw stripeFail(e);
      }
    });
    router.delete('/api/stripe', 'location', (ctx) => {
      db.run('DELETE FROM stripe_accounts WHERE location_id = ?', ctx.locationId);
      return status(ctx.locationId);
    });

    /** Stripe payments that settled (or are settling) invoices – for badges in the invoice list. */
    router.get('/api/stripe/payments', 'location', (ctx) => {
      const live = !!account(ctx.locationId)?.livemode;
      const invoice = ctx.query.get('invoice_id');
      return db
        .all(
          `SELECT id, kind, invoice_id, product_id, contact_id, amount_cents, currency, status, email, payment_intent, subscription, created_at, paid_at
           FROM stripe_checkouts WHERE location_id = ? AND status IN ('paid', 'pending', 'failed') ${invoice ? 'AND invoice_id = ?' : 'AND invoice_id IS NOT NULL'}
           ORDER BY created_at DESC LIMIT 2000`,
          ctx.locationId,
          ...(invoice ? [invoice] : []),
        )
        .map((p) => ({ ...p, dashboard_url: dashboardUrl(p.payment_intent || p.subscription || p.id, live) }));
    });

    // --- product buy links --------------------------------------------------------
    const linkOf = (productId: string) => db.get('SELECT * FROM stripe_product_links WHERE product_id = ?', productId);
    const buyUrl = (p: any, link: any) => `${app.baseUrl()}/buy/${encodeURIComponent(link?.slug || p.id)}`;
    const tagOf = (p: any, link: any) => link?.tag || `kauf:${link?.slug || slugify(p.name)}`;

    router.get('/api/stripe/products', 'location', (ctx) =>
      db.all('SELECT * FROM products WHERE location_id = ? ORDER BY name', ctx.locationId).map((p) => {
        const l = linkOf(p.id);
        return { product_id: p.id, slug: l?.slug ?? '', enabled: l ? !!l.enabled : true, redirect_url: l?.redirect_url ?? '', tag: tagOf(p, l), custom_tag: l?.tag ?? '', url: buyUrl(p, l) };
      }),
    );
    router.put('/api/stripe/products/:id', 'location', (ctx) => {
      const p = db.get('SELECT * FROM products WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!p) throw notFound();
      const b = ctx.body ?? {};
      const slug = b.slug ? slugify(String(b.slug)) : '';
      if (slug && slug.length < 3) throw bad('Kurzname: mindestens 3 Zeichen');
      if (slug && db.get('SELECT product_id FROM stripe_product_links WHERE slug = ? AND product_id != ?', slug, p.id)) throw bad('Kurzname schon vergeben');
      if (slug && db.get('SELECT id FROM products WHERE id = ?', slug)) throw bad('Kurzname nicht möglich');
      const redirectUrl = str(b.redirect_url, 'Weiterleitung', { max: 500 });
      if (redirectUrl && !/^https:\/\/[^\s]+$/i.test(redirectUrl)) throw bad('Weiterleitung: bitte mit https:// angeben');
      const tag = str(b.tag, 'Tag', { max: 100 });
      db.run(
        `INSERT INTO stripe_product_links (product_id, location_id, slug, enabled, redirect_url, tag, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET slug = excluded.slug, enabled = excluded.enabled, redirect_url = excluded.redirect_url, tag = excluded.tag, updated_at = excluded.updated_at`,
        p.id, ctx.locationId, slug || null, b.enabled === false ? 0 : 1, redirectUrl, tag, now(),
      );
      const l = linkOf(p.id)!;
      return { product_id: p.id, slug: l.slug ?? '', enabled: !!l.enabled, redirect_url: l.redirect_url, tag: tagOf(p, l), custom_tag: l.tag, url: buyUrl(p, l) };
    });

    // --- completing payments --------------------------------------------------------

    /**
     * Money for an invoice arrived through Stripe (Checkout Session or PaymentIntent). One payment is booked once, however often
     * it is reported (webhook retries, the session and its PaymentIntent, the return from Checkout), and never for more than is
     * open: the open amount (or more) pays the invoice, less is booked as a part payment. Any difference – the invoice changed
     * after its Checkout page was made (a transfer or a credit note in between), a different currency, money for an invoice
     * with nothing open – is written to the invoice's trail and the contact's activity, so a refund is not forgotten.
     */
    function completeInvoice(locationId: string, invoiceId: string, ref: { sessionId?: string; paymentIntent?: string; amount?: number; currency?: string; email?: string }) {
      const inv = loadInvoice(app, locationId, invoiceId);
      if (!inv) return { handled: 'unknown_invoice' };
      const refs = [ref.sessionId, ref.paymentIntent].filter((x): x is string => !!x);
      const marks = refs.map(() => '?').join(', ');
      const booked = refs.length > 0 && !!db.get(`SELECT 1 AS x FROM stripe_checkouts WHERE location_id = ? AND status = 'paid' AND (id IN (${marks}) OR payment_intent IN (${marks}))`, locationId, ...refs, ...refs);
      const isInvoice = inv.kind === 'invoice';
      const open = isInvoice && inv.status !== 'paid' && inv.status !== 'void' ? openCents(inv) : 0;
      const at = now();
      if (ref.sessionId) {
        db.run(
          `INSERT INTO stripe_checkouts (id, location_id, kind, invoice_id, contact_id, amount_cents, currency, status, email, payment_intent, created_at, paid_at)
           VALUES (?, ?, 'invoice', ?, ?, ?, ?, 'paid', ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = 'paid', payment_intent = COALESCE(excluded.payment_intent, stripe_checkouts.payment_intent),
             email = CASE WHEN excluded.email != '' THEN excluded.email ELSE stripe_checkouts.email END, paid_at = COALESCE(stripe_checkouts.paid_at, excluded.paid_at)`,
          ref.sessionId, locationId, inv.id, inv.contact_id, ref.amount ?? open, (ref.currency ?? inv.currency).toUpperCase(), ref.email ?? '', ref.paymentIntent ?? null, at, at,
        );
      } else if (ref.paymentIntent) {
        const known = db.get('SELECT id FROM stripe_checkouts WHERE location_id = ? AND (payment_intent = ? OR id = ?)', locationId, ref.paymentIntent, ref.paymentIntent);
        const updated = known
          ? db.run(`UPDATE stripe_checkouts SET status = 'paid', paid_at = COALESCE(paid_at, ?) WHERE id = ?`, at, known.id).changes
          : db.run(`UPDATE stripe_checkouts SET status = 'paid', payment_intent = ?, paid_at = COALESCE(paid_at, ?) WHERE id = (SELECT id FROM stripe_checkouts WHERE location_id = ? AND invoice_id = ? AND status IN ('open', 'pending') ORDER BY created_at DESC LIMIT 1)`, ref.paymentIntent, at, locationId, inv.id).changes;
        if (!updated)
          db.run(
            `INSERT OR IGNORE INTO stripe_checkouts (id, location_id, kind, invoice_id, contact_id, amount_cents, currency, status, payment_intent, created_at, paid_at) VALUES (?, ?, 'invoice', ?, ?, ?, ?, 'paid', ?, ?, ?)`,
            ref.paymentIntent, locationId, inv.id, inv.contact_id, ref.amount ?? open, (ref.currency ?? inv.currency).toUpperCase(), ref.paymentIntent, at, at,
          );
      }
      if (booked) return { handled: 'already_paid', invoiceId: inv.id };
      const currency = String(ref.currency ?? inv.currency).toUpperCase();
      const amount = ref.amount;
      const flag = (text: string) => {
        invAudit(app, locationId, inv.id, 'payment.mismatch', text, STRIPE_ACTOR);
        if (inv.contact_id) logActivity(app, locationId, inv.contact_id, 'invoice.payment_mismatch', text);
      };
      if (isInvoice && amount !== undefined) {
        const got = `Stripe-Zahlung über ${money(amount, currency)}`;
        if (currency !== String(inv.currency).toUpperCase() || !(amount > 0)) {
          flag(`${got} passt nicht zu Rechnung ${inv.number} (${money(open, inv.currency)} offen) – nicht gebucht, bitte prüfen`);
          return { handled: 'amount_mismatch', invoiceId: inv.id };
        }
        if (open <= 0) {
          flag(`${got} für Rechnung ${inv.number}, auf der nichts mehr offen ist – nicht gebucht, bitte erstatten`);
          return { handled: inv.status === 'paid' ? 'already_paid' : 'nothing_open', invoiceId: inv.id };
        }
        if (amount < open) {
          try {
            recordPayment(app, locationId, inv.id, { amount_cents: amount, method: 'Stripe', note: ref.paymentIntent ?? ref.sessionId ?? '' }, STRIPE_ACTOR, { source: 'auto', via: 'Stripe' });
          } catch (e) {
            if (e instanceof HttpError && e.status === 409) return { handled: 'already_paid', invoiceId: inv.id };
            throw e;
          }
          flag(`${got} ist weniger als der offene Betrag ${money(open, inv.currency)} – als Teilzahlung gebucht, ${money(open - amount, inv.currency)} bleiben offen`);
          push(locationId, `Teilzahlung auf Rechnung ${inv.number}`, `${money(amount, currency)} über Stripe`, `/app/invoices/${inv.id}`);
          return { handled: 'invoice_partially_paid', invoiceId: inv.id };
        }
      }
      // the open amount (or more): markInvoicePaid books exactly what is open, never the surplus
      const changed = markInvoicePaid(app, locationId, inv.id, 'Stripe');
      if (changed) {
        if (isInvoice && amount !== undefined && amount > open)
          flag(`Stripe-Zahlung über ${money(amount, currency)} ist mehr als der offene Betrag ${money(open, inv.currency)} – ${money(amount - open, inv.currency)} zu viel gezahlt, bitte erstatten`);
        push(locationId, `Rechnung ${inv.number} bezahlt`, `${money(amount ?? open, currency)} über Stripe`, `/app/invoices/${inv.id}`);
      }
      return { handled: changed ? 'invoice_paid' : 'already_paid', invoiceId: inv.id };
    }

    const findOrCreateContact = (locationId: string, email: string, name: string, phone: string) => {
      if (email) {
        const c = db.get('SELECT id FROM contacts WHERE location_id = ? AND email = ?', locationId, email);
        if (c) return c.id as string;
      }
      if (!email && !phone && !name) return null;
      // Typed by the buyer in Checkout: a known number with another address is a new contact, never a changed one.
      return upsertContact(app, locationId, { email, name, phone }, { source: 'Stripe', publicInput: true }).contact.id;
    };

    /**
     * A product was bought: contact (matched by email), paid invoice, tag, product.purchased.
     * Each step remembers its result on the checkout row, so a retried webhook neither skips
     * nor repeats anything.
     */
    function completeProduct(locationId: string, session: any, via = 'Stripe') {
      const md = session.metadata ?? {};
      let row = parseJson(db.get('SELECT * FROM stripe_checkouts WHERE id = ?', session.id), ['meta']);
      if (row?.status === 'paid') return { handled: 'duplicate' };
      const email = normalizeEmail(session.customer_details?.email || session.customer_email || '');
      const currency = String(session.currency || 'eur').toUpperCase();
      const amount = Number(session.amount_total ?? 0);
      if (!row) {
        db.run(
          `INSERT INTO stripe_checkouts (id, location_id, kind, product_id, mode, amount_cents, currency, status, email, meta, created_at) VALUES (?, ?, 'product', ?, ?, ?, ?, 'processing', ?, ?, ?)`,
          session.id, locationId, md.product_id, session.mode === 'subscription' ? 'subscription' : 'payment', amount, currency, email, JSON.stringify(md), now(),
        );
        row = parseJson(db.get('SELECT * FROM stripe_checkouts WHERE id = ?', session.id), ['meta'])!;
      }
      const product = db.get('SELECT * FROM products WHERE id = ? AND location_id = ?', md.product_id, locationId);
      const name = String(product?.name ?? md.product_name ?? 'Produkt');
      let contactId: string | null = row.contact_id;
      if (!contactId) {
        contactId = findOrCreateContact(locationId, email, String(session.customer_details?.name ?? ''), String(session.customer_details?.phone ?? ''));
        db.run('UPDATE stripe_checkouts SET contact_id = ?, email = ? WHERE id = ?', contactId, email, session.id);
      }
      let invoiceId: string | null = row.invoice_id;
      let created: any;
      if (!invoiceId) {
        const qty = Math.max(1, Number(md.qty) || 1);
        const price = Number.isFinite(Number(md.price_cents)) && md.price_cents !== undefined ? Number(md.price_cents) : Number(product?.price_cents ?? 0);
        const tax = Number.isFinite(Number(md.tax_rate)) && md.tax_rate !== undefined ? Number(md.tax_rate) : defaultTax(locationId);
        let items: any[] = [{ name, description: product?.description ?? '', qty, price_cents: price, tax_rate: tax }];
        // More lines from other modules (order bump, discount code): app.services.buyInvoiceItems = [(locationId, session, items) => items].
        for (const fn of app.services.buyInvoiceItems ?? []) items = fn(locationId, session, items) ?? items;
        created = createInvoice(app, locationId, {
          kind: 'invoice',
          contact_id: contactId,
          title: name,
          items,
          currency,
          notes: `Online bezahlt über ${via}. Vielen Dank für deinen Kauf!`,
        });
        invoiceId = created.id;
        db.run('UPDATE stripe_checkouts SET invoice_id = ? WHERE id = ?', invoiceId, session.id);
      }
      markInvoicePaid(app, locationId, invoiceId!, via);
      const tag = String(md.tag || tagOf(product ?? { name }, product ? linkOf(product.id) : undefined));
      if (contactId) addTags(app, locationId, contactId, [tag]);
      db.run(`UPDATE stripe_checkouts SET status = 'paid', paid_at = ?, payment_intent = ?, subscription = ? WHERE id = ?`, now(), session.payment_intent ?? null, session.subscription ?? null, session.id);
      if (contactId) logActivity(app, locationId, contactId, 'product.purchased', `Gekauft: ${name} (${money(amount, currency)}) über ${via}`);
      app.events.emit(locationId, 'product.purchased', { contactId, productId: md.product_id, product: { id: md.product_id, name }, invoiceId, amount_cents: amount, currency, tag, sessionId: session.id, metadata: md });
      push(locationId, `Neuer Kauf: ${name}`, `${email || 'Unbekannt'} · ${money(amount, currency)}`, `/app/invoices/${invoiceId}`);
      if (contactId && account(locationId)?.options?.auto_send_receipt !== false) {
        const inv = parseJson(db.get('SELECT * FROM invoices WHERE id = ?', invoiceId), ['items']);
        void sendInvoice(app, locationId, inv, {
          subject: 'Deine Rechnung {{invoice.number}} – vielen Dank für deinen Kauf',
          body: `Hallo {{contact.first_name|}},\n\nvielen Dank für deinen Kauf von „${name}“. Die Zahlung ist eingegangen – hier ist deine Rechnung:\n{{invoice.url}}\n\nViele Grüße\n{{location.name}}`,
        }).catch((e) => console.error('[stripe] Rechnung senden', (e as Error).message));
      }
      return { handled: 'product_purchased', invoiceId, contactId };
    }

    /** Subscription renewals (Stripe invoice.paid after the first period). */
    function completeRenewal(locationId: string, sinv: any) {
      const details = sinv.parent?.subscription_details ?? sinv.subscription_details ?? {};
      const md = details.metadata ?? {};
      const subId = details.subscription ?? sinv.subscription ?? '';
      if (md.location_id !== locationId || !md.product_id) return { handled: 'ignored' };
      if (sinv.billing_reason === 'subscription_create') return { handled: 'first_period' };
      const first = db.get(`SELECT * FROM stripe_checkouts WHERE location_id = ? AND subscription = ? AND kind = 'product'`, locationId, subId);
      const fresh = db.run(
        `INSERT OR IGNORE INTO stripe_checkouts (id, location_id, kind, product_id, contact_id, mode, amount_cents, currency, status, email, subscription, created_at) VALUES (?, ?, 'renewal', ?, ?, 'subscription', ?, ?, 'processing', ?, ?, ?)`,
        sinv.id, locationId, md.product_id, first?.contact_id ?? null, Number(sinv.amount_paid ?? 0), String(sinv.currency ?? 'eur').toUpperCase(), normalizeEmail(sinv.customer_email ?? ''), subId, now(),
      ).changes;
      const row = db.get('SELECT * FROM stripe_checkouts WHERE id = ?', sinv.id)!;
      if (!fresh && row.status === 'paid') return { handled: 'duplicate' };
      const product = db.get('SELECT * FROM products WHERE id = ? AND location_id = ?', md.product_id, locationId);
      const name = String(product?.name ?? md.product_name ?? 'Abo');
      const contactId = row.contact_id ?? findOrCreateContact(locationId, normalizeEmail(sinv.customer_email ?? ''), String(sinv.customer_name ?? ''), '');
      let invoiceId = row.invoice_id;
      if (!invoiceId) {
        invoiceId = createInvoice(app, locationId, {
          kind: 'invoice',
          contact_id: contactId,
          title: `${name} (Verlängerung)`,
          items: [{ name, description: product?.description ?? '', qty: 1, price_cents: Number(md.price_cents ?? product?.price_cents ?? 0), tax_rate: Number(md.tax_rate ?? defaultTax(locationId)) }],
          currency: String(sinv.currency ?? 'eur').toUpperCase(),
          notes: 'Abo-Verlängerung, online bezahlt über Stripe.',
        }).id;
      }
      db.run(`UPDATE stripe_checkouts SET contact_id = ?, invoice_id = ?, status = 'paid', paid_at = ? WHERE id = ?`, contactId, invoiceId, now(), sinv.id);
      markInvoicePaid(app, locationId, invoiceId, 'Stripe-Abo');
      return { handled: 'renewal', invoiceId };
    }

    /** Subscription ended: the buyer loses the purchase tag again (course access ends). */
    function endSubscription(locationId: string, sub: any) {
      const md = sub.metadata ?? {};
      if (md.location_id && md.location_id !== locationId) return { handled: 'ignored' };
      const row = parseJson(db.get(`SELECT * FROM stripe_checkouts WHERE location_id = ? AND subscription = ? AND kind = 'product'`, locationId, sub.id), ['meta']);
      if (!row?.contact_id) return { handled: 'ignored' };
      const tag = String(row.meta?.tag ?? md.tag ?? '');
      if (tag) removeTags(app, locationId, row.contact_id, [tag]);
      logActivity(app, locationId, row.contact_id, 'product.subscription_ended', 'Stripe-Abo beendet');
      app.events.emit(locationId, 'product.subscription_ended', { contactId: row.contact_id, productId: row.product_id, subscription: sub.id });
      return { handled: 'subscription_ended' };
    }

    /** Money went back (full or partial): payment.refunded lets others react (e.g. reverse affiliate commissions). */
    function refunded(locationId: string, charge: any) {
      const row = db.get('SELECT * FROM stripe_checkouts WHERE location_id = ? AND ((payment_intent IS NOT NULL AND payment_intent = ?) OR id = ?)', locationId, charge.payment_intent ?? '', charge.invoice ?? '');
      if (!row) return { handled: 'ignored' };
      const amount = Number(charge.amount_refunded ?? 0);
      if (row.contact_id) logActivity(app, locationId, row.contact_id, 'payment.refunded', `Stripe-Erstattung über ${money(amount, String(charge.currency ?? row.currency))}`);
      app.events.emit(locationId, 'payment.refunded', { contactId: row.contact_id, invoiceId: row.invoice_id, productId: row.product_id, amount_cents: amount, currency: String(charge.currency ?? row.currency).toUpperCase(), full: charge.refunded === true, paymentIntent: charge.payment_intent ?? null });
      return { handled: 'refunded', invoiceId: row.invoice_id };
    }

    /** A subscription renewal could not be charged (Stripe invoice.payment_failed): payment.failed lets workflows send a dunning mail. */
    function renewalFailed(locationId: string, sinv: any) {
      const details = sinv.parent?.subscription_details ?? sinv.subscription_details ?? {};
      const md = details.metadata ?? {};
      const subId = details.subscription ?? sinv.subscription ?? '';
      if (md.location_id && md.location_id !== locationId) return { handled: 'ignored' };
      const first = subId ? db.get(`SELECT * FROM stripe_checkouts WHERE location_id = ? AND subscription = ? AND kind = 'product'`, locationId, subId) : undefined;
      if (!first?.contact_id) return { handled: 'ignored' };
      logActivity(app, locationId, first.contact_id, 'payment.failed', `Abo-Zahlung fehlgeschlagen (${money(Number(sinv.amount_due ?? 0), String(sinv.currency ?? first.currency))})`);
      app.events.emit(locationId, 'payment.failed', { contactId: first.contact_id, productId: first.product_id, subscription: subId, amount_cents: Number(sinv.amount_due ?? 0), currency: String(sinv.currency ?? first.currency).toUpperCase(), reason: String(sinv.last_finalization_error?.code ?? 'renewal_failed'), attempt: Number(sinv.attempt_count ?? 1) });
      return { handled: 'payment_failed' };
    }

    function handleSession(locationId: string, session: any, type: string) {
      const md = session?.metadata ?? {};
      if (md.location_id !== locationId) return { handled: 'ignored' };
      // Other modules own sessions of their own (Team-Kalender: booking held for a payment): app.services.stripeSessions = [(locationId, session, type) => result | undefined].
      for (const fn of (app.services.stripeSessions ?? []) as ((locationId: string, session: any, type: string) => { handled: string } | undefined)[]) {
        const r = fn(locationId, session, type);
        if (r) return r;
      }
      const paid = PAID_SESSION.has(session.payment_status);
      if (type === 'checkout.session.async_payment_failed' || (type === 'checkout.session.expired' && !paid)) {
        db.run(`UPDATE stripe_checkouts SET status = ? WHERE id = ? AND status NOT IN ('paid')`, type.endsWith('failed') ? 'failed' : 'expired', session.id);
        if (type.endsWith('failed') && md.invoice_id) {
          const inv = db.get<any>('SELECT contact_id, number, kind, total_cents, paid_cents, credited_cents, deducted_cents, currency FROM invoices WHERE id = ? AND location_id = ?', md.invoice_id, locationId);
          if (inv?.contact_id) {
            logActivity(app, locationId, inv.contact_id, 'invoice.payment_failed', `Zahlung für Rechnung ${inv.number} fehlgeschlagen (Stripe)`);
            // what this payment was for: the session's amount (the open amount when it was made)
            app.events.emit(locationId, 'payment.failed', { contactId: inv.contact_id, invoiceId: md.invoice_id, amount_cents: Number(session.amount_total) || openCents(inv), currency: inv.currency, reason: 'async_payment_failed' });
          }
        }
        return { handled: 'failed' };
      }
      if (!paid) {
        // Delayed methods (SEPA Direct Debit): completed now, money confirmed later.
        db.run(`UPDATE stripe_checkouts SET status = 'pending', payment_intent = COALESCE(?, payment_intent) WHERE id = ? AND status IN ('open', 'processing')`, session.payment_intent ?? null, session.id);
        return { handled: 'pending' };
      }
      const ref = { sessionId: session.id, paymentIntent: session.payment_intent ?? undefined, amount: Number(session.amount_total ?? 0), currency: session.currency, email: normalizeEmail(session.customer_details?.email || session.customer_email || '') };
      if (md.invoice_id) return completeInvoice(locationId, md.invoice_id, ref);
      if (md.product_id) return completeProduct(locationId, session);
      return { handled: 'ignored' };
    }

    function handleEvent(locationId: string, event: any) {
      // Other modules look at every verified, new event first (payment plans, dunning): app.services.stripeTaps =
      // [(locationId, event) => { handled: string } | undefined]. A result ends the processing here, undefined passes it on.
      for (const tap of (app.services.stripeTaps ?? []) as ((locationId: string, event: any) => { handled: string } | undefined)[]) {
        const r = tap(locationId, event);
        if (r) return r;
      }
      const obj = event.data?.object ?? {};
      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
        case 'checkout.session.async_payment_failed':
        case 'checkout.session.expired':
          return handleSession(locationId, obj, event.type);
        case 'payment_intent.succeeded': {
          const md = obj.metadata ?? {};
          if (md.location_id !== locationId || !md.invoice_id) return { handled: 'ignored' };
          return completeInvoice(locationId, md.invoice_id, { paymentIntent: obj.id, amount: Number(obj.amount_received ?? obj.amount ?? 0), currency: obj.currency });
        }
        case 'invoice.paid':
        case 'invoice.payment_succeeded':
          return completeRenewal(locationId, obj);
        case 'invoice.payment_failed':
          return renewalFailed(locationId, obj);
        case 'customer.subscription.deleted':
          return endSubscription(locationId, obj);
        case 'charge.refunded':
          return refunded(locationId, obj);
        default:
          // Other modules take further event types (accounting: payouts): app.services.stripeEvents = [(locationId, event) => result | undefined].
          for (const fn of (app.services.stripeEvents ?? []) as ((locationId: string, event: any) => { handled: string } | undefined)[]) {
            const r = fn(locationId, event);
            if (r) return r;
          }
          return { handled: 'ignored' };
      }
    }

    // --- webhook --------------------------------------------------------------------
    router.post('/hooks/stripe/:locationId', 'public', (ctx) => {
      const locationId = ctx.params.locationId;
      const acc = account(locationId);
      if (!acc?.webhook_secret) throw notFound('Stripe ist für diesen Account nicht eingerichtet');
      const check = verifyStripeSignature(ctx.rawBody, String(ctx.req.headers['stripe-signature'] ?? ''), openSecret(app, acc.webhook_secret));
      if (!check.ok) throw bad(`Ungültige Stripe-Signatur: ${check.reason}`);
      let event: any;
      try {
        event = JSON.parse(ctx.rawBody);
      } catch {
        throw bad('Ungültiges JSON');
      }
      if (typeof event?.id !== 'string' || typeof event?.type !== 'string') throw bad('Kein Stripe-Ereignis');
      if (!db.run('INSERT OR IGNORE INTO stripe_events (location_id, id, type, received_at) VALUES (?, ?, ?, ?)', locationId, event.id, event.type, now()).changes) return { received: true, duplicate: true };
      try {
        return { received: true, ...handleEvent(locationId, event) };
      } catch (e) {
        // Not marked as seen, so Stripe's retry gets another go.
        db.run('DELETE FROM stripe_events WHERE location_id = ? AND id = ?', locationId, event.id);
        throw e;
      }
    });
    // Old events are only needed for de-duplication (Stripe retries for up to three days).
    let cleaned = 0;
    app.onTick(() => {
      if (Date.now() - cleaned < 3600_000) return;
      cleaned = Date.now();
      db.run('DELETE FROM stripe_events WHERE received_at < ?', new Date(Date.now() - 30 * 864e5).toISOString());
    });

    // --- invoices: "Jetzt bezahlen" ---------------------------------------------------
    // Online payment asks for the open amount (services/invoice-model.ts openCents): what a part payment, credit notes and – on a
    // final invoice – the deducted partial invoices left. Never the total again.
    const payable = (inv: any) => inv && inv.kind === 'invoice' && !['draft', 'paid', 'void'].includes(inv.status) && openCents(inv) >= MIN_AMOUNT_CENTS;
    const notPayable = (inv: any) => {
      if (inv.status === 'paid') return 'Diese Rechnung ist schon bezahlt';
      if (inv.kind !== 'invoice' || inv.status !== 'sent') return 'Diese Rechnung kann nicht online bezahlt werden';
      const open = openCents(inv);
      return open <= 0 ? 'Für diese Rechnung ist nichts mehr offen' : `Der offene Betrag (${money(open, inv.currency)}) ist zu klein für eine Online-Zahlung`;
    };

    /**
     * A payment of the invoice Stripe is still processing: a SEPA Direct Debit (and other delayed methods) is "complete" at
     * Checkout but confirmed by the bank days later. Meanwhile the invoice must not invite a second payment (the customer – or a
     * colleague – would pay twice). After three weeks without an answer it is offered again.
     */
    const paymentInProgress = (inv: any) =>
      !!db.get(`SELECT 1 AS x FROM stripe_checkouts WHERE invoice_id = ? AND status = 'pending' AND created_at > ? LIMIT 1`, inv.id, new Date(Date.now() - 21 * 864e5).toISOString());
    const IN_PROGRESS = 'Für diese Rechnung ist schon eine Zahlung in Bearbeitung (z. B. SEPA-Lastschrift) – sobald die Bank sie bestätigt, gilt die Rechnung als bezahlt.';

    app.services.invoicePayHtml = (inv: any) => {
      if (!payable(inv) || !account(inv.location_id)?.secret_key) return '';
      if (paymentInProgress(inv)) return `<p class="noprint muted" style="margin:10px 0 14px">${escapeHtml(IN_PROGRESS)}</p>`;
      const open = openCents(inv);
      return `<form method="post" action="/i/${encodeURIComponent(inv.public_token)}/pay" class="noprint" style="margin:10px 0 14px">
      <button type="submit" style="width:100%;max-width:420px">Jetzt bezahlen (Karte, SEPA, Apple Pay …)</button>
      <div class="muted" style="font-size:12px;margin-top:6px">${open < inv.total_cents ? `Offener Betrag ${escapeHtml(money(open, inv.currency))} · ` : ''}Sichere Zahlung über Stripe</div></form>`;
    };

    /** Checkout pages being made right now, per invoice: a double click waits for the same page instead of making a second one. */
    const making = new Map<string, Promise<string>>();
    function invoiceCheckout(inv: any): Promise<string> {
      let p = making.get(inv.id);
      if (!p) {
        p = newInvoiceCheckout(inv).finally(() => making.delete(inv.id));
        making.set(inv.id, p);
      }
      return p;
    }
    async function newInvoiceCheckout(inv: any): Promise<string> {
      const acc = account(inv.location_id);
      const key = secretOf(acc);
      if (!key) throw bad('Online-Zahlung ist nicht eingerichtet');
      if (!payable(inv)) throw bad(notPayable(inv));
      if (paymentInProgress(inv)) throw new HttpError(409, IN_PROGRESS);
      const open = openCents(inv);
      const lines = invoiceLineItems(inv);
      // the page charges exactly what is open – a line set that adds up to anything else is never sent
      if (lines.reduce((n, l) => n + l.unit_amount * l.quantity, 0) !== open) throw new HttpError(500, 'Der Betrag der Bezahlseite stimmt nicht mit dem offenen Betrag überein');
      // Someone clicking twice gets the same Checkout page instead of a new session (only while the open amount is the same).
      const recent = db.get(
        `SELECT url FROM stripe_checkouts WHERE invoice_id = ? AND status = 'open' AND amount_cents = ? AND currency = ? AND url != '' AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
        inv.id, open, inv.currency, new Date(Date.now() - 30 * 60_000).toISOString(),
      );
      if (recent) return recent.url;
      const contact = inv.contact_id ? getContact(app, inv.location_id, inv.contact_id) : undefined;
      const base = `${app.baseUrl()}/i/${encodeURIComponent(inv.public_token)}`;
      const meta = { invoice_id: inv.id, location_id: inv.location_id, invoice_number: inv.number };
      const session = await stripeRequest(key, 'POST', '/v1/checkout/sessions', {
        mode: 'payment',
        line_items: lineItemParams(lines, inv.currency),
        ...(contact?.email ? { customer_email: contact.email } : {}),
        client_reference_id: inv.id,
        success_url: `${base}/stripe?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: base,
        metadata: meta,
        payment_intent_data: { metadata: meta, description: `${open < inv.total_cents ? 'Restbetrag ' : ''}Rechnung ${inv.number}` },
      }).catch((e) => {
        throw stripeFail(e);
      });
      if (!session?.id || !session?.url) throw new HttpError(502, 'Stripe hat keine Bezahlseite geliefert');
      db.insert('stripe_checkouts', { id: session.id, location_id: inv.location_id, kind: 'invoice', invoice_id: inv.id, contact_id: inv.contact_id, url: session.url, mode: 'payment', amount_cents: open, currency: inv.currency, status: 'open', email: contact?.email ?? '', meta, created_at: now() });
      return session.url;
    }

    const errorPage = (title: string, msg: string, back?: string, status = 400) =>
      html(publicPage({ title, body: `<div class="wrap"><div class="card"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(msg)}</p>${back ? `<p><a class="btn secondary" href="${escapeHtml(back)}">Zurück</a></p>` : ''}</div></div>` }), status);

    const invByToken = (token: string) => parseJson(db.get('SELECT * FROM invoices WHERE public_token = ?', token), ['items']);

    router.post('/i/:token/pay', 'public', async (ctx) => {
      const inv = invByToken(ctx.params.token);
      if (!inv || inv.status === 'draft') return errorPage('Nicht gefunden', 'Dieses Dokument gibt es nicht.', undefined, 404);
      const back = `/i/${encodeURIComponent(inv.public_token)}`;
      if (throttled(ctx.ip)) return errorPage('Bitte kurz warten', 'Zu viele Versuche – bitte in ein paar Minuten noch einmal.', back, 429);
      try {
        return redirect(await invoiceCheckout(inv), 303);
      } catch (e) {
        return errorPage('Online-Zahlung nicht möglich', (e as Error).message, back, e instanceof HttpError && e.status === 409 ? 409 : 400);
      }
    });

    /** Back from Stripe: confirm right away (the webhook may be slower or not set up). */
    router.get('/i/:token/stripe', 'public', async (ctx) => {
      const inv = invByToken(ctx.params.token);
      if (!inv) return errorPage('Nicht gefunden', 'Dieses Dokument gibt es nicht.', undefined, 404);
      const back = `/i/${encodeURIComponent(inv.public_token)}`;
      const sid = String(ctx.query.get('session_id') ?? '');
      const row = /^cs_[A-Za-z0-9_]+$/.test(sid) ? db.get(`SELECT * FROM stripe_checkouts WHERE id = ? AND invoice_id = ?`, sid, inv.id) : undefined;
      if (!row || inv.status === 'paid') return redirect(back);
      const session = await confirmSession(inv.location_id, sid);
      if (session && !PAID_SESSION.has(session.payment_status) && session.status === 'complete') return pendingPage(back);
      return redirect(back);
    });

    async function confirmSession(locationId: string, sessionId: string) {
      const key = secretOf(account(locationId));
      if (!key) return null;
      try {
        const session = await stripeRequest(key, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
        if (session?.id === sessionId) handleSession(locationId, session, 'checkout.session.completed');
        return session;
      } catch (e) {
        console.error('[stripe] Rückkehr prüfen', (e as Error).message);
        return null;
      }
    }

    const pendingPage = (back: string) =>
      html(
        publicPage({
          title: 'Danke!',
          body: `<div class="wrap"><div class="card"><h1>Danke!</h1><p>Deine Zahlung wird bearbeitet (z. B. SEPA-Lastschrift). Sobald sie bestätigt ist, bekommst du Bescheid.</p><p><a class="btn secondary" href="${escapeHtml(back)}">Zurück</a></p></div></div>`,
        }),
      );

    // --- products: public buy page ------------------------------------------------------
    const resolveProduct = (key: string) => {
      const k = String(key ?? '').slice(0, 100);
      const p = db.get('SELECT * FROM products WHERE id = ?', k) ?? db.get('SELECT p.* FROM products p JOIN stripe_product_links l ON l.product_id = p.id WHERE l.slug = ?', k.toLowerCase());
      if (!p || !p.active) return undefined;
      const link = linkOf(p.id);
      if (link && !link.enabled) return undefined;
      return { p, link };
    };
    const grossOf = (p: any) => {
      // The purchase becomes an invoice in the sub-account's tax mode, and only the regular mode charges VAT (createInvoice sets 0 %
      // otherwise): a Kleinunternehmer's product that still has 19 % on it must not be charged 119 when the invoice says 100.
      const regular = invoiceSettings(app, p.location_id).tax_mode === 'standard';
      const tax = !regular ? 0 : p.tax_rate === null || p.tax_rate === undefined ? defaultTax(p.location_id) : Number(p.tax_rate);
      return { tax, gross: p.price_cents + Math.round((p.price_cents * tax) / 100) };
    };

    function buyPage(ctx: Ctx, p: any, key: string, attr = '') {
      const loc = app.location(p.location_id)!;
      const { tax, gross } = grossOf(p);
      const every = p.recurring === 'month' ? ' / Monat' : p.recurring === 'year' ? ' / Jahr' : '';
      const small = !!loc.settings.invoices?.small_business;
      const email = normalizeEmail(ctx.query.get('email') ?? '');
      // Extra fields from other modules (order bump, discount code): app.services.buyPageHtml = [(ctx, product, link, key) => html].
      const extras = (app.services.buyPageHtml ?? []).map((fn: any) => fn(ctx, p, linkOf(p.id), key) ?? '').join('');
      const body = `<div class="wrap" style="max-width:560px"><div class="card">
  ${loc.logo_url ? `<img src="${escapeHtml(loc.logo_url)}" alt="" style="max-height:48px;margin-bottom:12px">` : `<p class="muted" style="margin:0 0 6px">${escapeHtml(loc.name)}</p>`}
  <h1>${escapeHtml(p.name)}</h1>
  ${p.description ? `<p>${escapeHtml(p.description).replace(/\n/g, '<br>')}</p>` : ''}
  <p style="font-size:28px;font-weight:700;margin:18px 0 2px">${escapeHtml(money(gross, p.currency))}<span class="muted" style="font-size:16px;font-weight:400">${every}</span></p>
  <p class="muted" style="font-size:13px;margin-top:0">${small ? 'Gemäß § 19 UStG ohne Umsatzsteuer' : tax ? `inkl. ${String(tax).replace('.', ',')} % USt.` : ''}</p>
  <form method="post" action="/buy/${encodeURIComponent(key)}">
    ${email ? `<input type="hidden" name="email" value="${escapeHtml(email)}">` : ''}
    ${extras}
    ${attr ? `<input type="hidden" name="_a" value="${escapeHtml(attr)}">` : ''}
    <button type="submit" style="width:100%">${escapeHtml(app.services.buyButtonLabel?.(p, loc) ?? (p.recurring ? 'Jetzt abonnieren' : 'Jetzt kaufen'))}</button>
  </form>
  <p class="muted" style="font-size:12px;text-align:center;margin-bottom:0">${escapeHtml(app.services.buyPayNote?.(p) ?? 'Sichere Zahlung über Stripe – Karte, SEPA, Apple Pay, Google Pay …')}</p>
</div></div>`;
      return html(publicPage({ title: `${p.name} – ${loc.name}`, body, color: loc.settings?.branding?.color || undefined, description: String(p.description ?? '').slice(0, 160) }));
    }

    /** For modules that sell on top of a buy link (upsells): key, product lookup, completing a payment. */
    app.services.stripeBuy = {
      secretKey: (locationId: string) => secretOf(account(locationId)),
      resolveProduct,
      grossOf,
      linkOf,
      tagOf,
      /** A paid PaymentIntent or session-like object ({id, metadata, amount_total, currency, customer_details}) → invoice, tag, product.purchased; `via` names the provider (PayPal, Mollie … through modules/pay-registry.ts). */
      completeProduct,
      /** Remembers a Checkout Session started elsewhere, so /buy/<key>/danke can confirm it. */
      recordCheckout: (row: { id: string; location_id: string; product_id: string; url: string; amount_cents: number; currency: string; email?: string; meta: Record<string, any> }) =>
        db.insert('stripe_checkouts', { ...row, kind: 'product', mode: 'payment', status: 'open', email: row.email ?? '', created_at: now() }),
    };

    /** Stripe, or another provider of the registry (modules/pay-registry.ts: PayPal, Mollie) for one-time products. */
    const sellable = (p: any) => !!account(p.location_id)?.secret_key || (!p.recurring && (app.services.payRegistry?.ready(p.location_id) ?? []).some((x: string) => x !== 'stripe'));
    router.get('/buy/:key', 'public', (ctx) => {
      const found = resolveProduct(ctx.params.key);
      if (!found || !sellable(found.p)) return errorPage('Nicht verfügbar', 'Dieses Angebot gibt es (gerade) nicht.', undefined, 404);
      // Visit with UTM / ?ref= (attribution & affiliates); the token rides along to the checkout.
      const r = buyPage(ctx, found.p, ctx.params.key, app.services.attribution?.visit(ctx, found.p.location_id) ?? '');
      r.headers['cache-control'] = 'private, no-cache';
      return r;
    });

    router.post('/buy/:key', 'public', async (ctx) => {
      const found = resolveProduct(ctx.params.key);
      // Another provider chosen on the page (PayPal, Mollie …): the payment registry takes over with the same hooks (modules/pay-registry.ts).
      const provider = String(ctx.body?.provider ?? '');
      if (found && provider && provider !== 'stripe' && app.services.payBuy) {
        if (throttled(ctx.ip)) return errorPage('Bitte kurz warten', 'Zu viele Versuche – bitte in ein paar Minuten noch einmal.', `/buy/${encodeURIComponent(ctx.params.key)}`, 429);
        return app.services.payBuy(ctx, found, ctx.params.key);
      }
      const key = secretOf(found ? account(found.p.location_id) : undefined);
      if (!found || !key) return errorPage('Nicht verfügbar', 'Dieses Angebot gibt es (gerade) nicht.', undefined, 404);
      const { p, link } = found;
      const back = `/buy/${encodeURIComponent(ctx.params.key)}`;
      if (throttled(ctx.ip)) return errorPage('Bitte kurz warten', 'Zu viele Versuche – bitte in ein paar Minuten noch einmal.', back, 429);
      const { tax, gross } = grossOf(p);
      if (gross < MIN_AMOUNT_CENTS) return errorPage('Nicht verfügbar', 'Der Preis ist zu klein für eine Online-Zahlung.', back);
      const recurring = p.recurring === 'month' || p.recurring === 'year' ? (p.recurring as 'month' | 'year') : undefined;
      const email = normalizeEmail(ctx.body?.email ?? '');
      const meta: Record<string, any> = { location_id: p.location_id, product_id: p.id, product_name: String(p.name).slice(0, 200), price_cents: p.price_cents, tax_rate: tax, qty: 1, tag: tagOf(p, link).slice(0, 200) };
      const self = `${app.baseUrl()}/buy/${encodeURIComponent(ctx.params.key)}`;
      try {
        const params: Record<string, any> = {
          mode: recurring ? 'subscription' : 'payment',
          line_items: lineItemParams([{ name: p.name, description: [p.description, tax ? `inkl. ${String(tax).replace('.', ',')} % USt.` : ''].filter(Boolean).join(' · ').slice(0, 500) || undefined, unit_amount: gross, quantity: 1 }], p.currency, recurring),
          ...(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? { customer_email: email } : {}),
          client_reference_id: p.id,
          success_url: `${self}/danke?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: self,
          metadata: meta,
          ...(recurring ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: { location_id: p.location_id, product_id: p.id }, description: String(p.name).slice(0, 200) } }),
        };
        // Other modules extend the session (order bump, discount code, saved card for an upsell): they may change
        // params (line_items[0] is the product) and add to meta; throwing shows the message on an error page.
        for (const fn of app.services.buyCheckout ?? []) await fn(ctx, { product: p, link, params, meta, key: ctx.params.key });
        const amount = (params.line_items as any[]).reduce((sum, l) => sum + Number(l.quantity) * Number(l.price_data?.unit_amount ?? 0), 0);
        const session = await stripeRequest(key, 'POST', '/v1/checkout/sessions', params);
        if (!session?.url) throw new Error('Stripe hat keine Bezahlseite geliefert');
        db.insert('stripe_checkouts', { id: session.id, location_id: p.location_id, kind: 'product', product_id: p.id, url: session.url, mode: recurring ? 'subscription' : 'payment', amount_cents: amount, currency: p.currency, status: 'open', email, meta, created_at: now() });
        app.services.attribution?.checkout(ctx, p.location_id, session.id, ctx.body?._a);
        return redirect(session.url, 303);
      } catch (e) {
        return errorPage('Kauf gerade nicht möglich', (e as Error).message, back);
      }
    });

    router.get('/buy/:key/danke', 'public', async (ctx) => {
      const found = resolveProduct(ctx.params.key);
      const sid = String(ctx.query.get('session_id') ?? '');
      const row = /^cs_[A-Za-z0-9_]+$/.test(sid) ? db.get(`SELECT * FROM stripe_checkouts WHERE id = ? AND kind = 'product'`, sid) : undefined;
      let state = row?.status ?? '';
      if (row && row.status !== 'paid') {
        const session = await confirmSession(row.location_id, sid);
        state = db.get('SELECT status FROM stripe_checkouts WHERE id = ?', sid)?.status ?? state;
        if (session && !PAID_SESSION.has(session.payment_status) && session.status === 'complete') state = 'pending';
      }
      // A module may come in between before the thank-you (one-click upsell): app.services.buyAfterPaid = [(ctx, {checkout, product, link}) => RawResult | undefined].
      if (state === 'paid' && row) {
        const checkout = parseJson(db.get('SELECT * FROM stripe_checkouts WHERE id = ?', sid), ['meta']);
        for (const fn of app.services.buyAfterPaid ?? []) {
          const r = await fn(ctx, { checkout, product: found?.p, link: found?.link });
          if (r) return r;
        }
      }
      if (state === 'paid' && found?.link?.redirect_url) return redirect(found.link.redirect_url, 303);
      const name = found?.p.name ?? 'deinen Kauf';
      const msg =
        state === 'paid' ? 'Die Zahlung ist eingegangen. Du bekommst gleich eine E-Mail mit deiner Rechnung.'
        : state === 'pending' ? 'Deine Zahlung wird bearbeitet (z. B. SEPA-Lastschrift). Sobald sie bestätigt ist, bekommst du eine E-Mail.'
        : 'Wir bestätigen gerade deine Zahlung. Du bekommst eine E-Mail, sobald sie eingegangen ist.';
      return html(publicPage({ title: 'Danke!', body: `<div class="wrap" style="max-width:560px"><div class="card"><h1>Danke für ${escapeHtml(found ? `„${name}“` : name)}!</h1><p>${escapeHtml(msg)}</p></div></div>` }));
    });
  },
};

