import type { App, Module } from '../core/app.js';
import { normalizeEmail } from '../core/util.js';
import { addTags, getContact, logActivity, removeTags, upsertContact } from '../services/contacts.js';
import { ABANDONED_STEPS } from '../services/mk-gallery.js';
import { getSettings } from '../services/mk-settings.js';
import { registerTriggers, type TriggerMeta } from '../services/wfx-kit.js';

/**
 * "Warenkorbabbruch": when a Stripe Checkout Session of a product expires without payment (`checkout.session.expired`, Stripe
 * closes an unpaid session after 24 hours), the workflow trigger `checkout.abandoned` fires for the contact – with the product and
 * the link to the buy page – plus the recipe "Warenkorbabbruch-Serie" (three e-mails, the series ends when the product is bought).
 * It listens through the Stripe module's tap (app.services.stripeTaps) and never changes how Stripe events are processed.
 */

export const ABANDONED_TAG = 'warenkorbabbruch';

const TRIGGER: TriggerMeta = {
  type: 'checkout.abandoned',
  label: 'Checkout abgebrochen (Warenkorbabbruch)',
  category: 'payments',
  summary: 'Jemand hat die Stripe-Bezahlseite eines Produkts geöffnet, aber nicht bezahlt – die Sitzung ist abgelaufen.',
  doc: 'Stripe schließt eine unbezahlte Bezahlseite nach 24 Stunden und meldet „checkout.session.expired“ (das Ereignis muss im Stripe-Webhook aktiviert sein). Der Kontakt wird an seiner E-Mail-Adresse erkannt – bekannt ist sie, wenn er sie auf der Bezahlseite eingegeben hat oder der Kauf-Link zu einem Kontakt gehört. Unbekannte Adressen legen nur dann einen Kontakt an, wenn das unter Kampagnen → Zustellbarkeit → Einstellungen erlaubt ist. Der Kontakt bekommt den Tag „warenkorbabbruch“ (er wird beim Kauf wieder entfernt). Werbe-Mails brauchen auch hier eine gültige Einwilligung. {{event.product_name}}, {{event.recovery_url}} (Link zur Kaufseite), {{event.amount_cents}} und {{event.currency}} stehen im Ereignis.',
  fields: [{ key: 'product_id', label: 'Produkt', type: 'text', help: 'Produkt-ID, leer = jedes' }],
  sample: { productId: 'p1', product_name: 'Online-Kurs', amount_cents: 19700, currency: 'EUR', recovery_url: 'https://example.com/buy/online-kurs', checkoutId: 'cs_test_1' },
  keywords: 'warenkorbabbruch abandoned cart checkout abgebrochen stripe kauf',
};

const PAID = new Set(['paid', 'no_payment_required']);

export const mkAbandonedModule: Module = {
  name: 'mk-abandoned',
  register(app: App) {
    const { db } = app;
    registerTriggers(app, [TRIGGER]);
    app.services.workflowTriggerFilters = { ...(app.services.workflowTriggerFilters ?? {}), 'checkout.abandoned': (c: Record<string, any>, d: Record<string, any>) => !c.product_id || c.product_id === d.productId };
    app.services.workflowRecipes = {
      ...(app.services.workflowRecipes ?? {}),
      abandoned_checkout: {
        name: 'Warenkorbabbruch-Serie',
        trigger: { type: 'checkout.abandoned', config: {} },
        settings: { allow_reentry: true },
        steps: ABANDONED_STEPS(),
      },
    };

    /** The buy page of a product: its short link, or its id. */
    const buyUrl = (locationId: string, productId: string) => {
      const link = db.get<{ slug: string | null; enabled: number }>('SELECT slug, enabled FROM stripe_product_links WHERE product_id = ? AND location_id = ?', productId, locationId);
      return `${app.baseUrl()}/buy/${encodeURIComponent(link?.slug || productId)}`;
    };

    function abandoned(locationId: string, session: any) {
      const md = session?.metadata ?? {};
      // Only product checkouts of this sub-account (an unpaid invoice link that expires is not a shopping cart).
      if (md.location_id !== locationId || !md.product_id || PAID.has(session.payment_status)) return;
      const row = db.get<{ contact_id: string | null; email: string; amount_cents: number; currency: string; created_at: string }>('SELECT contact_id, email, amount_cents, currency, created_at FROM stripe_checkouts WHERE id = ? AND location_id = ?', session.id, locationId);
      const email = normalizeEmail(session.customer_details?.email || session.customer_email || row?.email || '');
      let contactId = row?.contact_id ?? null;
      if (contactId && !getContact(app, locationId, contactId)) contactId = null;
      if (!contactId && email) {
        const known = db.get<{ id: string }>('SELECT id FROM contacts WHERE location_id = ? AND email = ?', locationId, email);
        contactId = known?.id ?? null;
        if (!contactId && getSettings(app, locationId).abandoned.create_contacts) contactId = upsertContact(app, locationId, { email, name: session.customer_details?.name }, { source: 'Stripe: Checkout abgebrochen' }).contact.id;
      }
      if (!contactId) return;
      // Bought in the meantime (another session, a payment link): nothing to remind.
      const bought = db.get('SELECT 1 FROM stripe_checkouts WHERE location_id = ? AND contact_id = ? AND product_id = ? AND status = ? AND paid_at >= ? LIMIT 1', locationId, contactId, md.product_id, 'paid', row?.created_at ?? '');
      if (bought) return;
      const product = db.get<{ name: string }>('SELECT name FROM products WHERE id = ? AND location_id = ?', md.product_id, locationId);
      const name = String(product?.name ?? md.product_name ?? 'Produkt');
      const amount = Number(session.amount_total ?? row?.amount_cents ?? 0);
      const currency = String(session.currency ?? row?.currency ?? 'eur').toUpperCase();
      addTags(app, locationId, contactId, [ABANDONED_TAG]);
      logActivity(app, locationId, contactId, 'checkout.abandoned', `Checkout abgebrochen: ${name}`);
      app.events.emit(locationId, 'checkout.abandoned', {
        contactId,
        productId: md.product_id,
        product: { id: md.product_id, name },
        product_name: name,
        amount_cents: amount,
        currency,
        checkoutId: session.id,
        recovery_url: buyUrl(locationId, md.product_id),
      });
    }

    // The tap looks at the verified, new event and always passes it on (undefined): the Stripe module still marks the checkout expired.
    app.services.stripeTaps = [
      ...(app.services.stripeTaps ?? []),
      (locationId: string, event: any) => {
        if (event?.type === 'checkout.session.expired') {
          try {
            abandoned(locationId, event.data?.object);
          } catch (e) {
            console.error('[abandoned]', (e as Error).message);
          }
        }
        return undefined;
      },
    ];

    // Whoever buys leaves the series: the tag goes, the workflow's goal step ends the run.
    app.events.on('product.purchased', (e) => {
      if (e.data.contactId) removeTags(app, e.locationId, e.data.contactId, [ABANDONED_TAG]);
    });
  },
};
