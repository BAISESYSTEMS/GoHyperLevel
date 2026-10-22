import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { logActivity } from '../services/contacts.js';
import { openToken } from '../services/creator-kit.js';
import { registerTriggers } from '../services/wfx-kit.js';

/**
 * The payment field of a form (docs/forms.md): the form stores its answers, then sends the visitor to the existing buy page of the product
 * (Stripe Checkout, invoice, tag, product.purchased – nothing of that is rebuilt here). The link carries a signed token for the submission, the
 * buy page passes it into the Checkout Session's metadata, and when the purchase is confirmed the submission turns "bezahlt".
 */

export const formPaymentModule: Module = {
  name: 'form-payment',
  register(app) {
    const { db } = app;
    registerTriggers(app, [
      {
        type: 'form.scored',
        label: 'Formular ausgewertet (Punkte / Ergebnis)',
        category: 'marketing',
        summary: 'Jemand hat ein Formular mit Punkten, Variablen oder Ergebnissen abgeschickt.',
        doc: '{{event.values.score}} ist der Punktestand, {{event.ending.title}} das gezeigte Ergebnis, {{event.ending.tag}} der Tag des Ergebnisses. Passend für „Quiz-Ergebnis → Tag setzen → passende E-Mail“.',
        fields: [{ key: 'form_id', label: 'Nur für Formular (ID)', type: 'text' }, { key: 'tag', label: 'Nur bei Ergebnis mit Tag', type: 'text' }],
        sample: { formId: 'f1', submissionId: 's1', values: { score: 18 }, ending: { title: 'Profi', tag: 'quiz:profi' } },
        keywords: 'formular quiz punkte ergebnis score auswertung lead qualifizierung',
      },
      {
        type: 'form.paid',
        label: 'Formular bezahlt',
        category: 'payments',
        summary: 'Die Zahlung zu einem Formular (Zahlungsfeld) ist bei Stripe eingegangen.',
        doc: '{{event.amount_cents}} ist der Betrag in Cent, {{event.productId}} das bezahlte Produkt, {{event.submissionId}} die Einsendung.',
        fields: [{ key: 'form_id', label: 'Nur für Formular (ID)', type: 'text' }, { key: 'product_id', label: 'Nur für Produkt (ID)', type: 'text' }],
        sample: { formId: 'f1', submissionId: 's1', productId: 'p1', invoiceId: 'i1', amount_cents: 4900 },
        keywords: 'formular bezahlt zahlung stripe anmeldung bestellung',
      },
    ]);
    const filters = (app.services.workflowTriggerFilters ?? {}) as Record<string, (c: Record<string, any>, d: Record<string, any>) => boolean>;
    filters['form.scored'] = (c, d) => (!c.form_id || c.form_id === d.formId) && (!c.tag || c.tag === d.ending?.tag);
    filters['form.paid'] = (c, d) => (!c.form_id || c.form_id === d.formId) && (!c.product_id || c.product_id === d.productId);
    app.services.workflowTriggerFilters = filters;

    /** The pending submission a token points at, if it is one of this product's. */
    const pending = (token: unknown, product: { id: string; location_id: string }) => {
      const t = openToken<{ s: string; l: string }>(app, 'fs', token);
      if (!t || t.l !== product.location_id) return undefined;
      const sub = parseJson(db.get<any>('SELECT * FROM form_submissions WHERE id = ? AND location_id = ?', t.s, product.location_id), ['meta', 'data']);
      return sub?.meta?.payment?.status === 'pending' && sub.meta.payment.product_id === product.id ? sub : undefined;
    };

    // The buy page carries the token on in a hidden field …
    app.services.buyPageHtml = [
      ...((app.services.buyPageHtml as unknown[] | undefined) ?? []),
      (ctx: { query: URLSearchParams }, product: { id: string; location_id: string }) => {
        const token = ctx.query.get('fs');
        return token && pending(token, product) ? `<input type="hidden" name="_fs" value="${token.replace(/[^A-Za-z0-9._-]/g, '')}">` : '';
      },
    ];
    // … and the checkout session remembers which submission it is for.
    app.services.buyCheckout = [
      ...((app.services.buyCheckout as unknown[] | undefined) ?? []),
      async (ctx: { body?: any }, o: { product: { id: string; location_id: string }; meta: Record<string, any> }) => {
        const token = ctx.body?._fs;
        const sub = token ? pending(token, o.product) : undefined;
        if (sub) o.meta.form_submission = sub.id;
      },
    ];

    app.events.on('product.purchased', (e) => {
      const { contactId, productId, invoiceId } = e.data;
      let sub = e.data.metadata?.form_submission
        ? parseJson(db.get<any>('SELECT * FROM form_submissions WHERE id = ? AND location_id = ?', String(e.data.metadata.form_submission), e.locationId), ['meta', 'data'])
        : undefined;
      // Without the token (the buyer opened the buy page another way): the newest open submission of this contact for this product.
      if (!sub && contactId && productId) {
        sub = db
          .all<any>(`SELECT * FROM form_submissions WHERE location_id = ? AND contact_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20`, e.locationId, contactId, new Date(Date.now() - 7 * 864e5).toISOString())
          .map((r) => parseJson(r, ['meta', 'data']))
          .find((r) => r.meta?.payment?.status === 'pending' && r.meta.payment.product_id === productId);
      }
      const pay = sub?.meta?.payment;
      if (!sub || !pay || pay.status !== 'pending' || pay.product_id !== productId) return;
      const meta = { ...sub.meta, payment: { ...pay, status: 'paid', paid_at: new Date().toISOString(), invoice_id: invoiceId ?? null } };
      db.run('UPDATE form_submissions SET meta = ? WHERE id = ?', JSON.stringify(meta), sub.id);
      const answers = { ...sub.data };
      for (const [k, v] of Object.entries(answers)) if (typeof v === 'string' && v.endsWith('(Zahlung offen)')) answers[k] = v.replace('(Zahlung offen)', '(bezahlt)');
      db.run('UPDATE form_submissions SET data = ? WHERE id = ?', JSON.stringify(answers), sub.id);
      const cid = sub.contact_id ?? contactId;
      if (cid) logActivity(app, e.locationId, cid, 'form.paid', `Formular-Bestellung bezahlt: ${pay.product}`);
      app.events.emit(e.locationId, 'form.paid', { contactId: cid ?? null, formId: sub.form_id, submissionId: sub.id, productId, invoiceId: invoiceId ?? null, amount_cents: pay.amount_cents });
    });
  },
};
