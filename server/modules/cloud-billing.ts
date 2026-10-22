import type { App, Module } from '../core/app.js';
import { HttpError, bad, type Ctx } from '../core/http.js';
import { now } from '../core/util.js';
import { CANCEL_REASONS, PLAN_INFO, deletionTimeline, entitlements, isPlanKey, planIdOf, type CloudSettings, type PlanKey } from '../services/cloud.js';
import { transition, type Interval } from '../services/saas.js';
import { resetWhiteLabel } from './cloud-account.js';
import {
  appLink,
  billingLink,
  cloudEnabled,
  cloudSettings,
  eraseTenant,
  fmtDay,
  logCloudEvent,
  requireTenant,
  sendCloudMail,
  syncChildren,
  tenantById,
  tenantPlanKey,
  tenantSub,
  tenantSummary,
  type Tenant,
} from './cloud.js';
import { fromStripeSub, logSaasEvent, planById, saasStripe, stripeKeyOf, stockCount, upsertSubscription } from './saas.js';

/**
 * Cloud billing: what a customer can do about money (choose or change the plan with proration, start paying after a trial
 * without card, the Stripe customer portal, invoices, cancel with a reason), the reactions to Stripe's events (mails,
 * conversion numbers, invoice list) and the dunning clock – payment failed → reminders → read-only → export offered and
 * deletion scheduled → deleted. The subscription itself is the SaaS module's (saas_subscriptions, /hooks/stripe-agency).
 */



const readOnlyNow = (status: string | undefined) => status === 'paused' || status === 'canceled';

export async function reconcileTenant(app: App, t: Tenant, at: Date, s: CloudSettings) {
  const { db } = app;
  let sub = tenantSub(app, t);
  if (!sub) return;
  const iso = at.toISOString();
  const link = billingLink(app);
  const to = t.email;
  const who = { company: t.name };

  // 1. A trial without payment data ran out → read-only, nothing is overdue.
  if (sub.billing === 'manual' && sub.status === 'trialing' && sub.trial_end && sub.trial_end <= iso) {
    sub = upsertSubscription(app, { location_id: t.location_id, plan_id: sub.plan_id, ...transition(sub, 'paused', at, s.grace_days) });
    logCloudEvent(app, t.id, 'trial_expired', `Testphase ohne Abo beendet (${fmtDay(sub.trial_end)})`);
    logSaasEvent(app, t.location_id, 'paused', 'Testphase abgelaufen – Konto schreibgeschützt');
    void sendCloudMail(app, 'trial_expired', to, { ...who, retention_days: s.retention_days, link }, { tenantId: t.id, dedupe: 'trial_expired' });
  }
  // 2. …and a reminder three days before.
  if (sub.billing === 'manual' && sub.status === 'trialing' && sub.trial_end && new Date(sub.trial_end).getTime() - at.getTime() <= 3 * 864e5) {
    void sendCloudMail(app, 'trial_ending', to, { ...who, days: Math.max(1, Math.ceil((new Date(sub.trial_end).getTime() - at.getTime()) / 864e5)), trial_end: fmtDay(sub.trial_end), link, card: '' }, { tenantId: t.id, dedupe: 'trial_ending' });
  }
  // 3. A comped plan with an end date.
  if (t.comped && t.comp_until && t.comp_until <= iso && sub.billing === 'manual' && !readOnlyNow(sub.status)) {
    sub = upsertSubscription(app, { location_id: t.location_id, plan_id: sub.plan_id, ...transition(sub, 'paused', at, s.grace_days) });
    db.run('UPDATE cloud_tenants SET comped = 0, comp_until = NULL, updated_at = ? WHERE id = ?', iso, t.id);
    logCloudEvent(app, t.id, 'comp_ended', 'Geschenkter Tarif ausgelaufen');
    void sendCloudMail(app, 'read_only', to, { ...who, reason: 'Dein geschenkter Tarif ist ausgelaufen.', link }, { tenantId: t.id, dedupe: `comp_ended:${t.comp_until}` });
    t = { ...t, comped: 0, comp_until: null };
  }
  // 4. Reminders while a payment is open.
  if (sub.status === 'past_due' && sub.past_due_since) {
    const days = (at.getTime() - new Date(sub.past_due_since).getTime()) / 864e5;
    const left = sub.grace_until ? (new Date(sub.grace_until).getTime() - at.getTime()) / 864e5 : 99;
    if (left <= 1) void sendCloudMail(app, 'payment_reminder', to, { ...who, last: 1, grace_until: fmtDay(sub.grace_until), link }, { tenantId: t.id, dedupe: `reminder-last:${sub.past_due_since}` });
    else if (days >= 3) void sendCloudMail(app, 'payment_reminder', to, { ...who, grace_until: fmtDay(sub.grace_until), link }, { tenantId: t.id, dedupe: `reminder:${sub.past_due_since}` });
  }
  // 5. Read-only: the clock to the export offer and the deletion.
  if (readOnlyNow(sub.status)) {
    const since = t.read_only_since ?? sub.paused_at ?? sub.canceled_at ?? iso;
    if (!t.read_only_since) {
      db.run('UPDATE cloud_tenants SET read_only_since = ?, updated_at = ? WHERE id = ?', since, iso, t.id);
      t = { ...t, read_only_since: since };
      logCloudEvent(app, t.id, 'read_only', sub.status === 'canceled' ? 'Abo beendet' : 'Konto schreibgeschützt');
      void sendCloudMail(app, 'read_only', to, { ...who, reason: sub.status === 'canceled' ? 'Dein Abo ist beendet.' : 'Dein Konto ist schreibgeschützt, weil keine Zahlung eingegangen ist.', link }, { tenantId: t.id, dedupe: `read_only:${since}` });
    }
    const tl = deletionTimeline(since, s);
    if (!t.deletion_at && iso >= tl.schedule_at) {
      const deleteAt = new Date(at.getTime() + s.deletion_notice_days * 864e5).toISOString();
      db.run(`UPDATE cloud_tenants SET deletion_at = ?, deletion_reason = 'timeline', schedule_notified_at = ?, updated_at = ? WHERE id = ?`, deleteAt, iso, iso, t.id);
      t = { ...t, deletion_at: deleteAt, deletion_reason: 'timeline' };
      logCloudEvent(app, t.id, 'deletion_scheduled', `Löschung am ${fmtDay(deleteAt)} geplant (Export angeboten)`);
      void sendCloudMail(app, 'deletion_scheduled', to, { ...who, delete_at: fmtDay(deleteAt), link }, { tenantId: t.id, dedupe: `deletion:${deleteAt.slice(0, 10)}` });
    }
  } else if (t.read_only_since || (t.deletion_at && t.deletion_reason !== 'self')) {
    // Paid again: the clock stops.
    db.run(`UPDATE cloud_tenants SET read_only_since = NULL, schedule_notified_at = NULL, deletion_at = CASE WHEN deletion_reason = 'self' THEN deletion_at ELSE NULL END, deletion_reason = CASE WHEN deletion_reason = 'self' THEN deletion_reason ELSE '' END, updated_at = ? WHERE id = ?`, iso, t.id);
    logCloudEvent(app, t.id, 'reactivated', 'Konto wieder freigeschaltet');
    t = { ...t, read_only_since: null, schedule_notified_at: null, deletion_at: t.deletion_reason === 'self' ? t.deletion_at : null };
  }
  // 6. The hard delete (scheduled by the clock above or by the customer).
  if (t.deletion_at && t.deletion_at <= iso) {
    await eraseTenant(app, t, t.deletion_reason === 'self' ? 'Löschung auf Wunsch des Kunden' : 'Löschung nach Nur-Lesen-Frist');
    return;
  }
  syncChildren(app, t);
}


/** Plan change (customer or operator): checks what the new plan allows, switches the Stripe subscription with proration. */
export async function changePlan(app: App, t: Tenant, key: PlanKey, intervalIn: Interval | undefined, o: { ctx?: Ctx; operator?: boolean } = {}) {
  const sub = tenantSub(app, t)!;
  const interval: Interval = intervalIn ?? sub.interval;
  if (readOnlyNow(sub.status) && !o.operator) throw new HttpError(409, 'Das Konto ist schreibgeschützt – bitte zuerst ein Abo abschließen oder die Zahlung erledigen.');
  const s = cloudSettings(app);
  const ent = entitlements(key, s);
  const users = stockCount(app, t.location_id, 'users');
  if (ent.users !== null && users > ent.users) throw new HttpError(409, `${PLAN_INFO[key].name} ist für ${ent.users} Nutzer – das Konto hat ${users}. Entferne zuerst Nutzer unter Cloud-Konto → Team.`);
  const clients = Math.max(0, tenantSummary(app, t).counts.clients);
  if (!ent.client_accounts && clients > 0) throw new HttpError(409, `${PLAN_INFO[key].name} hat keine Kunden-Accounts – das Konto hat ${clients}. Lösche sie zuerst unter Cloud-Konto → Kunden.`);
  const before = tenantPlanKey(app, t);
  if (key === before && interval === sub.interval) return tenantSummary(app, t);
  const plan = planById(app, planIdOf(key))!;
  if (sub.billing === 'stripe' && sub.stripe_subscription && sub.status !== 'canceled') {
    const price = (await app.services.saasPriceId(plan, interval)) as string;
    let item = sub.stripe_item;
    if (!item) item = (await saasStripe(app, 'GET', `/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription)}`))?.items?.data?.[0]?.id ?? '';
    if (!item) throw new HttpError(502, 'Stripe-Abo ohne Position – bitte im Stripe-Dashboard prüfen');
    const updated = await saasStripe(app, 'POST', `/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription)}`, {
      items: [{ id: item, price }],
      proration_behavior: 'create_prorations',
      metadata: { saas_location_id: t.location_id, plan_id: plan.id, cloud_tenant_id: t.id },
    });
    upsertSubscription(app, { ...fromStripeSub(app, updated, sub), location_id: t.location_id, plan_id: plan.id, interval });
  } else {
    upsertSubscription(app, { location_id: t.location_id, plan_id: plan.id, interval });
  }
  if (!ent.white_label && PLAN_INFO[before].white_label) resetWhiteLabel(app, t);
  logCloudEvent(app, t.id, 'plan_changed', `${PLAN_INFO[before].name} → ${PLAN_INFO[key].name} (${interval === 'year' ? 'jährlich' : 'monatlich'})${o.operator ? ' durch den Betreiber' : ''}`);
  logSaasEvent(app, t.location_id, 'plan_changed', `${PLAN_INFO[before].name} → ${PLAN_INFO[key].name}`);
  app.services.audit?.({ ctx: o.ctx, action: 'cloud.plan.change', summary: `${PLAN_INFO[before].name} → ${PLAN_INFO[key].name}`, locationId: t.location_id });
  syncChildren(app, t);
  void sendCloudMail(app, 'plan_changed', t.email, { company: t.name, plan: PLAN_INFO[key].name, link: billingLink(app) });
  return tenantSummary(app, t);
}

/** Walks the tenants that need attention (not simply "active"); `at` is injectable for tests. */
export async function reconcile(app: App, at = new Date()) {
  const s = cloudSettings(app);
  const rows = app.db.all<Tenant>(
    `SELECT t.* FROM cloud_tenants t LEFT JOIN saas_subscriptions sb ON sb.location_id = t.location_id
     WHERE t.deleted_at IS NULL AND (sb.status IS NULL OR sb.status != 'active' OR sb.cancel_at_period_end = 1 OR t.read_only_since IS NOT NULL OR t.deletion_at IS NOT NULL OR t.comp_until IS NOT NULL)`,
  );
  for (const t of rows) {
    try {
      await reconcileTenant(app, t, at, s);
    } catch (e) {
      console.error('[cloud] reconcile', t.id, (e as Error).message);
    }
  }
}

export const cloudBillingModule: Module = {
  name: 'cloud-billing',
  register(app) {
    if (!cloudEnabled(app)) return;
    const { db, router } = app;
    Object.assign(app.services.cloud, { reconcile: (at?: Date) => reconcile(app, at) });

    let lastRun = 0;
    app.onTick(async () => {
      if (Date.now() - lastRun < 55_000) return;
      lastRun = Date.now();
      await reconcile(app);
    });

    // --- reactions to Stripe's events (the SaaS module has already updated the subscription row) -------------------------
    const bySub = (subId: unknown): Tenant | undefined =>
      subId ? db.get<Tenant>('SELECT t.* FROM cloud_tenants t JOIN saas_subscriptions s ON s.location_id = t.location_id WHERE s.stripe_subscription = ? AND t.deleted_at IS NULL', String(subId)) : undefined;
    const subOfInvoice = (inv: any) => inv?.subscription ?? inv?.parent?.subscription_details?.subscription;

    function cacheInvoice(t: Tenant, inv: any) {
      if (!inv?.id) return;
      db.run(
        `INSERT INTO cloud_invoices (id, tenant_id, number, status, amount_cents, currency, created, hosted_url, pdf_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET number = excluded.number, status = excluded.status, amount_cents = excluded.amount_cents, hosted_url = excluded.hosted_url, pdf_url = excluded.pdf_url`,
        String(inv.id),
        t.id,
        String(inv.number ?? ''),
        String(inv.status ?? ''),
        Number(inv.total ?? inv.amount_paid ?? inv.amount_due ?? 0),
        String(inv.currency ?? 'eur').toUpperCase(),
        inv.created ? new Date(Number(inv.created) * 1000).toISOString() : now(),
        String(inv.hosted_invoice_url ?? ''),
        String(inv.invoice_pdf ?? ''),
      );
    }

    /** First payment after a trial (or at all): the customer converted. */
    function noteConversion(t: Tenant) {
      const sub = tenantSub(app, t);
      if (!sub || sub.billing !== 'stripe' || sub.status !== 'active' || t.converted_at) return;
      db.run('UPDATE cloud_tenants SET converted_at = ?, updated_at = ? WHERE id = ?', now(), now(), t.id);
      if (t.trial_started_at) logCloudEvent(app, t.id, 'trial_converted', PLAN_INFO[tenantPlanKey(app, t)].name);
      void sendCloudMail(app, 'subscribed', t.email, { company: t.name, plan: PLAN_INFO[tenantPlanKey(app, t)].name, link: appLink(app, '/app') }, { tenantId: t.id, dedupe: 'subscribed' });
    }

    app.services.saasEventTaps = [
      ...(app.services.saasEventTaps ?? []),
      async (event: any) => {
        const o = event.data?.object ?? {};
        let t: Tenant | undefined;
        switch (event.type) {
          case 'checkout.session.completed':
          case 'checkout.session.async_payment_succeeded': {
            const tid = o.metadata?.cloud_tenant_id;
            t = tid ? tenantById(app, String(tid)) : undefined;
            if (t) logCloudEvent(app, t.id, 'subscribed', 'Abo per Stripe abgeschlossen');
            break;
          }
          case 'invoice.payment_failed':
            t = bySub(subOfInvoice(o));
            if (t) {
              cacheInvoice(t, o);
              logCloudEvent(app, t.id, 'payment_failed', `Rechnung ${o.number ?? o.id}`);
              const sub = tenantSub(app, t);
              void sendCloudMail(app, 'payment_failed', t.email, { company: t.name, grace_until: fmtDay(sub?.grace_until), link: billingLink(app) }, { tenantId: t.id, dedupe: `failed:${sub?.past_due_since ?? o.id}` });
            }
            break;
          case 'invoice.paid':
          case 'invoice.payment_succeeded':
          case 'invoice.finalized':
            t = bySub(subOfInvoice(o));
            if (t) {
              cacheInvoice(t, o);
              if (event.type !== 'invoice.finalized' && t.read_only_since) logCloudEvent(app, t.id, 'payment_recovered', `Rechnung ${o.number ?? o.id} bezahlt`);
            }
            break;
          case 'customer.subscription.trial_will_end':
            t = bySub(o.id);
            if (t) void sendCloudMail(app, 'trial_ending', t.email, { company: t.name, days: 3, trial_end: fmtDay(tenantSub(app, t)?.trial_end), card: '1', link: billingLink(app) }, { tenantId: t.id, dedupe: 'trial_ending' });
            break;
          case 'customer.subscription.created':
          case 'customer.subscription.updated':
          case 'customer.subscription.deleted': {
            t = bySub(o.id);
            if (!t) break;
            const sub = tenantSub(app, t);
            if (event.type === 'customer.subscription.deleted' || sub?.status === 'canceled') {
              logCloudEvent(app, t.id, 'canceled', 'Abo bei Stripe beendet');
              void sendCloudMail(app, 'canceled', t.email, { company: t.name, link: billingLink(app) }, { tenantId: t.id, dedupe: `canceled:${sub?.canceled_at ?? ''}` });
            }
            noteConversion(t);
            break;
          }
        }
        if (t) {
          const fresh = tenantById(app, t.id);
          if (fresh) await reconcileTenant(app, fresh, new Date(), cloudSettings(app));
        }
      },
    ];

    // --- plan ---------------------------------------------------------------------------------------------------------------
    async function priceId(key: PlanKey, interval: Interval) {
      const plan = planById(app, planIdOf(key))!;
      return app.services.saasPriceId(plan, interval) as Promise<string>;
    }

    router.post('/api/cloud/plan', 'user', async (ctx) => {
      const t = requireTenant(app, ctx);
      const b = ctx.body ?? {};
      if (!isPlanKey(b.plan)) throw bad('Bitte einen Tarif wählen');
      return changePlan(app, t, b.plan as PlanKey, b.interval === 'year' ? 'year' : b.interval === 'month' ? 'month' : undefined, { ctx });
    });

    // --- start paying (after a trial without card, or after the subscription ended) ----------------------------------------
    router.post('/api/cloud/subscribe', 'user', async (ctx) => {
      const t = requireTenant(app, ctx);
      const b = ctx.body ?? {};
      const sub = tenantSub(app, t)!;
      if (sub.billing === 'stripe' && sub.stripe_subscription && sub.status !== 'canceled') throw bad('Du hast schon ein Abo – ändere den Tarif oder öffne das Kundenportal');
      if (!stripeKeyOf(app)) throw new HttpError(503, 'Die Online-Bezahlung ist gerade nicht eingerichtet – bitte melde dich beim Anbieter.');
      const key: PlanKey = isPlanKey(b.plan) ? b.plan : tenantPlanKey(app, t);
      const interval: Interval = b.interval === 'year' ? 'year' : b.interval === 'month' ? 'month' : sub.interval;
      const s = cloudSettings(app);
      const plan = planById(app, planIdOf(key))!;
      const meta = { saas_location_id: t.location_id, plan_id: plan.id, interval, cloud_tenant_id: t.id };
      const back = `${app.baseUrl()}/app/settings/cloud`;
      // What is left of the trial is kept (Checkout needs more than two days to carry it over).
      const left = sub.status === 'trialing' && sub.trial_end ? new Date(sub.trial_end).getTime() : 0;
      let promo: string | null = null;
      if (t.coupon) promo = (await saasStripe(app, 'GET', '/v1/promotion_codes', { code: t.coupon, active: true, limit: 1 }).catch(() => null))?.data?.[0]?.id ?? null;
      const session = await saasStripe(app, 'POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price: await priceId(key, interval), quantity: 1 }],
        ...(sub.stripe_customer ? { customer: sub.stripe_customer, customer_update: { address: 'auto', name: 'auto' } } : { customer_email: t.email }),
        client_reference_id: t.location_id,
        success_url: `${back}?abo=ok&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: back,
        metadata: meta,
        subscription_data: { metadata: meta, ...(left > Date.now() + 2.2 * 864e5 ? { trial_end: Math.floor(left / 1000) } : {}) },
        billing_address_collection: 'required',
        locale: 'de',
        ...(promo ? { discounts: [{ promotion_code: promo }] } : { allow_promotion_codes: true }),
        ...(s.stripe_tax ? { automatic_tax: { enabled: true } } : {}),
        ...(s.tax_id_collection ? { tax_id_collection: { enabled: true } } : {}),
      });
      if (!session?.url) throw new HttpError(502, 'Stripe hat keine Bezahlseite geliefert');
      logCloudEvent(app, t.id, 'checkout_started', PLAN_INFO[key].name);
      return { url: session.url, id: session.id };
    });

    /** Back from Checkout: take the subscription over right away (the webhook confirms it later, harmlessly). */
    router.post('/api/cloud/subscribe/confirm', 'user', async (ctx) => {
      const t = requireTenant(app, ctx);
      const sid = String(ctx.body?.session_id ?? '');
      if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) throw bad('Ungültige Sitzung');
      const session = await saasStripe(app, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sid)}`, { expand: ['subscription'] });
      if (session?.metadata?.cloud_tenant_id !== t.id || session.status !== 'complete') return tenantSummary(app, t);
      const subObj = session.subscription && typeof session.subscription === 'object' ? session.subscription : null;
      const cur = tenantSub(app, t)!;
      if (subObj && cur.stripe_subscription !== subObj.id) {
        const planId = String(session.metadata.plan_id ?? cur.plan_id);
        upsertSubscription(app, { ...fromStripeSub(app, subObj), location_id: t.location_id, plan_id: planById(app, planId) ? planId : cur.plan_id, interval: session.metadata.interval === 'year' ? 'year' : 'month', email: t.email });
        logCloudEvent(app, t.id, 'subscribed', 'Abo per Stripe abgeschlossen');
        noteConversion(t);
        await reconcileTenant(app, tenantById(app, t.id)!, new Date(), cloudSettings(app));
      }
      return tenantSummary(app, t);
    });

    // --- portal, invoices, cancel --------------------------------------------------------------------------------------------
    router.post('/api/cloud/portal', 'user', async (ctx) => {
      const t = requireTenant(app, ctx);
      const sub = tenantSub(app, t)!;
      if (!sub.stripe_customer) throw bad('Es gibt noch kein Zahlungskonto – schließe zuerst ein Abo ab.');
      const r = await saasStripe(app, 'POST', '/v1/billing_portal/sessions', { customer: sub.stripe_customer, return_url: billingLink(app) });
      if (!r?.url) throw new HttpError(502, 'Stripe hat keinen Portal-Link geliefert');
      return { url: r.url };
    });

    router.get('/api/cloud/invoices', 'user', async (ctx) => {
      const t = requireTenant(app, ctx);
      const sub = tenantSub(app, t)!;
      if (sub.stripe_customer && stripeKeyOf(app)) {
        try {
          const r = await saasStripe(app, 'GET', '/v1/invoices', { customer: sub.stripe_customer, limit: 24 });
          for (const inv of r?.data ?? []) cacheInvoice(t, inv);
        } catch {
          /* the cached list below still works */
        }
      }
      return { items: db.all('SELECT id, number, status, amount_cents, currency, created, hosted_url, pdf_url FROM cloud_invoices WHERE tenant_id = ? ORDER BY created DESC LIMIT 100', t.id), portal: !!sub.stripe_customer };
    });

    router.post('/api/cloud/cancel', 'user', async (ctx) => {
      const t = requireTenant(app, ctx);
      const b = ctx.body ?? {};
      const sub = tenantSub(app, t)!;
      if (sub.status === 'canceled') throw bad('Das Abo ist schon beendet');
      const undo = !!b.undo;
      const reason = typeof b.reason === 'string' && b.reason in CANCEL_REASONS ? b.reason : 'other';
      const comment = String(b.comment ?? '').trim().slice(0, 1000);
      if (sub.billing === 'stripe' && sub.stripe_subscription) {
        const params: Record<string, any> = { cancel_at_period_end: !undo };
        if (!undo) params.cancellation_details = { comment: comment.slice(0, 500) || undefined, feedback: ({ price: 'too_expensive', features: 'missing_features', switched: 'switched_service', not_needed: 'unused', selfhost: 'other', other: 'other' } as Record<string, string>)[reason] };
        const updated = await saasStripe(app, 'POST', `/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription)}`, params);
        upsertSubscription(app, { ...fromStripeSub(app, updated, sub), location_id: t.location_id, plan_id: sub.plan_id });
      } else {
        // No subscription at Stripe (trial without card, comped): the end is the end of the period.
        upsertSubscription(app, { location_id: t.location_id, plan_id: sub.plan_id, cancel_at_period_end: undo ? 0 : 1 });
      }
      if (undo) {
        db.run(`UPDATE cloud_tenants SET cancel_reason = '', cancel_comment = '', updated_at = ? WHERE id = ?`, now(), t.id);
        logCloudEvent(app, t.id, 'cancel_undone', 'Kündigung zurückgenommen');
      } else {
        db.run('UPDATE cloud_tenants SET cancel_reason = ?, cancel_comment = ?, updated_at = ? WHERE id = ?', reason, comment, now(), t.id);
        logCloudEvent(app, t.id, 'cancel_scheduled', `${CANCEL_REASONS[reason]}${comment ? `: ${comment.slice(0, 120)}` : ''}`);
        const end = tenantSub(app, t)?.current_period_end ?? tenantSub(app, t)?.trial_end;
        void sendCloudMail(app, 'cancel_scheduled', t.email, { company: t.name, end: end ? fmtDay(end) : 'dem Ende des Zeitraums', link: billingLink(app) });
      }
      app.services.audit?.({ ctx, action: undo ? 'cloud.cancel.undo' : 'cloud.cancel', summary: undo ? '' : `${CANCEL_REASONS[reason]}`, locationId: t.location_id });
      syncChildren(app, t);
      return tenantSummary(app, t);
    });
  },
};
