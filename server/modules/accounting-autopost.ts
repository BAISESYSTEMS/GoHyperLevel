import type { Module } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { getSettings } from '../services/acc-ledger.js';
import { bookStripeFees, bookStripePayout, bookStripeRefund, syncInvoices } from '../services/acc-autopost.js';

/**
 * Wires the auto-posting into the rest of the app: an invoice that was sent or paid becomes an entry (after the
 * route that changed it, on `invoice.paid`, and as a safety net on every tick), Stripe payouts and refunds are
 * booked from the webhook of modules/stripe.ts (`app.services.stripeEvents`).
 */
export const accountingAutopostModule: Module = {
  name: 'accounting-autopost',
  register(app) {
    const { db, router } = app;
    const pending: Set<Promise<void>> = app.services.accountingPending;

    const safe = (loc: string, invoiceId?: string) => {
      try {
        return syncInvoices(app, loc, { invoiceId });
      } catch (e) {
        console.error('[accounting] sync', (e as Error).message);
        return undefined;
      }
    };

    // The invoice routes (send, status change, edit) – after they answered the invoice is in its final state.
    app.afterWrite.push((ctx, route) => {
      if (!ctx.locationId || !route.pattern.startsWith('/api/invoices')) return;
      if (ctx.params.id) safe(ctx.locationId, ctx.params.id);
    });
    app.events.on('invoice.paid', (e) => {
      const invoiceId = e.data?.invoice?.id;
      if (invoiceId) safe(e.locationId, invoiceId);
    });
    app.events.on('payment.refunded', (e) => {
      try {
        bookStripeRefund(app, e.locationId, { invoiceId: e.data?.invoiceId, amount_cents: e.data?.amount_cents });
      } catch (err) {
        console.error('[accounting] refund', (err as Error).message);
      }
    });

    // Stripe payouts (modules/stripe.ts hands over event types it does not know).
    app.services.stripeEvents = [
      ...(app.services.stripeEvents ?? []),
      (locationId: string, event: any) => {
        if (event?.type !== 'payout.paid') return undefined;
        const payout = event.data?.object ?? {};
        const r = bookStripePayout(app, locationId, payout);
        if (r.handled === 'payout_booked') {
          const p: Promise<void> = bookStripeFees(app, locationId, payout).then(
            () => undefined,
            (e) => console.error('[accounting] stripe fees', (e as Error).message),
          );
          pending.add(p);
          void p.finally(() => pending.delete(p));
        }
        return r;
      },
    ];

    // Safety net: whatever was missed (invoice sent before accounting was set up, a failed run) is caught up in small slices.
    let last = 0;
    app.onTick(() => {
      if (Date.now() - last < 120_000) return;
      last = Date.now();
      for (const row of db.all<{ location_id: string }>(`SELECT location_id FROM acc_settings WHERE json_extract(data, '$.enabled') = 1`)) safe(row.location_id);
    });

    router.post('/api/accounting/autopost/run', 'location', (ctx) => {
      if (!getSettings(app, ctx.locationId).enabled) throw new HttpError(409, 'Die Buchhaltung ist noch nicht eingerichtet');
      return safe(ctx.locationId) ?? { posted: 0, payments: 0, cancelled: 0, errors: ['Fehler beim Buchen – siehe Protokoll'] };
    });
  },
};
