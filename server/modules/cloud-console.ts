import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, str, text } from '../core/http.js';
import { csvSafe, toCsv } from '../core/csv.js';
import { now } from '../core/util.js';
import { PLAN_INFO, PLAN_KEYS, cleanSettings, deletionTimeline, isPlanKey, planIdOf, planKeyOf, priceFor, type PlanKey } from '../services/cloud.js';
import { LEGAL_DOCS, LEGAL_TITLE, isLegalDoc, openPlaceholders } from '../services/cloud-legal.js';
import { sitesDomain } from '../services/cloud-sites.js';
import { PAYING, churnRate, monthlyValue, transition, type SubStatus, type Subscription } from '../services/saas.js';
import { changePlan, reconcile } from './cloud-billing.js';
import {
  PHASE_LABEL,
  cloudEnabled,
  cloudSettings,
  eraseTenant,
  fmtDay,
  legalCurrent,
  legalText,
  logCloudEvent,
  phaseOf,
  saveCloudSettings,
  setLegal,
  supportActive,
  syncChildren,
  tenantById,
  tenantLocationIds,
  tenantSub,
  tenantSummary,
  type Tenant,
} from './cloud.js';
import { planById, saasSettings, saasStripe, stockCount, stripeKeyOf, upsertSubscription } from './saas.js';

/**
 * The operator console (Agentur → Cloud): customers with plan and status, MRR/ARR, churn, trial conversion, the
 * customer list as CSV, extend a trial, comp a plan, change a plan, open a customer's account (only with the customer's
 * consent, always logged in the customer's own audit log), delete, and the settings of the service – prices, trial, fair use,
 * dunning times, legal texts. Admin routes only; customers get 403 from the router itself.
 */

interface Row extends Tenant {
  plan_id: string | null;
  status: SubStatus | null;
  billing: string | null;
  interval: string | null;
  trial_end: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number | null;
  stripe_customer: string | null;
}

const JOIN = `SELECT t.*, s.plan_id, s.status, s.billing, s.interval, s.trial_end, s.current_period_end, s.cancel_at_period_end, s.stripe_customer
  FROM cloud_tenants t LEFT JOIN saas_subscriptions s ON s.location_id = t.location_id WHERE t.deleted_at IS NULL`;

export const cloudConsoleModule: Module = {
  name: 'cloud-console',
  register(app) {
    if (!cloudEnabled(app)) return;
    const { db, router } = app;

    const mrrOf = (r: Row): number => {
      if (!r.status || !(PAYING as string[]).includes(r.status) || r.comped) return 0;
      const plan = planById(app, r.plan_id);
      return plan && planKeyOf(plan.id) ? monthlyValue(plan, r.interval === 'year' ? 'year' : 'month') : 0;
    };

    const tenantOut = (r: Row) => {
      const key = planKeyOf(r.plan_id) ?? 'team';
      const phase = phaseOf(r, r.status ? ({ status: r.status } as Subscription) : undefined);
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        email: r.email,
        plan: key,
        plan_name: PLAN_INFO[key].name,
        interval: r.interval ?? 'month',
        phase,
        phase_label: PHASE_LABEL[phase],
        status: r.status,
        billing: r.billing,
        stripe: !!r.stripe_customer,
        trial_end: r.trial_end,
        current_period_end: r.current_period_end,
        cancel_at_period_end: !!r.cancel_at_period_end,
        comped: !!r.comped,
        mrr_cents: mrrOf(r),
        support: supportActive(r),
        deletion_at: r.deletion_at,
        created_at: r.created_at,
      };
    };

    const rows = () => db.all<Row>(JOIN);

    router.get('/api/cloud/console/overview', 'admin', () => {
      const all = rows();
      const s = cloudSettings(app);
      const counts: Record<string, number> = { trial: 0, active: 0, comped: 0, past_due: 0, read_only: 0, canceled: 0, deletion_scheduled: 0 };
      const byPlan = Object.fromEntries(PLAN_KEYS.map((k) => [k, { key: k, name: PLAN_INFO[k].name, count: 0, trialing: 0, mrr_cents: 0 }])) as Record<PlanKey, { key: PlanKey; name: string; count: number; trialing: number; mrr_cents: number }>;
      let mrr = 0;
      let paying = 0;
      for (const r of all) {
        const o = tenantOut(r);
        counts[o.phase] = (counts[o.phase] ?? 0) + 1;
        const bp = byPlan[o.plan as PlanKey];
        if (o.phase !== 'canceled') bp.count++;
        if (o.phase === 'trial') bp.trialing++;
        bp.mrr_cents += o.mrr_cents;
        mrr += o.mrr_cents;
        if (o.mrr_cents) paying++;
      }
      const d30 = new Date(Date.now() - 30 * 864e5).toISOString();
      const d90 = new Date(Date.now() - 90 * 864e5).toISOString();
      const ev = (type: string, since: string) => Number(db.get<{ n: number }>('SELECT COUNT(DISTINCT tenant_id) AS n FROM cloud_events WHERE type = ? AND at >= ?', type, since)?.n ?? 0);
      const lost = Number(db.get<{ n: number }>(`SELECT COUNT(DISTINCT tenant_id) AS n FROM cloud_events WHERE type IN ('canceled', 'deleted') AND at >= ?`, d30)?.n ?? 0);
      const converted = ev('trial_converted', d90);
      const expired = ev('trial_expired', d90);
      return {
        currency: 'EUR',
        mrr_cents: mrr,
        arr_cents: mrr * 12,
        paying,
        total: all.length,
        counts,
        new_30d: ev('provisioned', d30),
        churn: { lost_30d: lost, rate_percent: churnRate(lost, paying) },
        trial: { running: counts.trial, converted_90d: converted, expired_90d: expired, conversion_percent: converted + expired ? Math.round((converted / (converted + expired)) * 1000) / 10 : null },
        plans: Object.values(byPlan),
        failed_signups: Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM cloud_signups WHERE status = 'failed'`)?.n ?? 0),
        events: db.all(`SELECT e.id, e.type, e.detail, e.at, e.tenant_id, t.name AS tenant_name FROM cloud_events e LEFT JOIN cloud_tenants t ON t.id = e.tenant_id ORDER BY e.at DESC LIMIT 40`),
        health: {
          stripe_connected: !!stripeKeyOf(app),
          webhook_set: !!saasSettings(app).webhook_secret,
          signup_open: s.signup_open,
          saas_signup_open: !!saasSettings(app).signup_enabled,
          cloud_domain: s.cloud_domain,
          // Customer sites need an origin of their own (modules/cloud-sites.ts); off-site backups (modules/offsite-backup.ts).
          sites_domain: sitesDomain(),
          offsite_backup: !!app.services.offsiteBackup?.configured?.(),
          legal_open: LEGAL_DOCS.filter((d) => openPlaceholders(legalText(app, legalCurrent(app, d))).length).length,
          mail_ready: !!(s.mail_location_id || saasSettings(app).mail_location_id) || !!db.get('SELECT 1 AS x FROM locations WHERE id NOT IN (SELECT location_id FROM cloud_locations) LIMIT 1'),
        },
      };
    });

    router.get('/api/cloud/console/tenants', 'admin', (ctx) => {
      const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
      const phase = ctx.query.get('phase') ?? '';
      const plan = ctx.query.get('plan') ?? '';
      const limit = clampLimit(ctx.query.get('limit'), 100, 500);
      const offset = Math.max(0, Number(ctx.query.get('offset')) || 0);
      let list = rows().map(tenantOut);
      if (q) list = list.filter((r) => `${r.name} ${r.email} ${r.slug}`.toLowerCase().includes(q));
      if (phase) list = list.filter((r) => r.phase === phase);
      if (isPlanKey(plan)) list = list.filter((r) => r.plan === plan);
      list.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { total: list.length, items: list.slice(offset, offset + limit) };
    });

    router.get('/api/cloud/console/tenants.csv', 'admin', () => {
      const list = rows().map(tenantOut);
      const csv = toCsv([
        ['Firma', 'E-Mail', 'Tarif', 'Intervall', 'Status', 'Abrechnung', 'MRR (EUR)', 'Testphase bis', 'Laufzeit bis', 'Geschenkt', 'Angelegt'],
        ...list.map((r) => [csvSafe(r.name), csvSafe(r.email), r.plan_name, r.interval === 'year' ? 'jährlich' : 'monatlich', r.phase_label, r.stripe ? 'Stripe' : 'manuell', (r.mrr_cents / 100).toFixed(2).replace('.', ','), fmtDay(r.trial_end), fmtDay(r.current_period_end), r.comped ? 'ja' : 'nein', fmtDay(r.created_at)]),
      ]);
      const r = text(`﻿${csv}`, 'text/csv; charset=utf-8');
      r.headers['content-disposition'] = `attachment; filename="cloud-kunden-${new Date().toISOString().slice(0, 10)}.csv"`;
      return r;
    });

    const need = (tid: string): Tenant => {
      const t = tenantById(app, tid);
      if (!t) throw notFound('Kunde nicht gefunden');
      return t;
    };

    router.get('/api/cloud/console/tenants/:id', 'admin', (ctx) => {
      const t = need(ctx.params.id);
      const locs = tenantLocationIds(app, t.id);
      return {
        ...tenantSummary(app, t),
        email: t.email,
        notes: t.notes,
        coupon: t.coupon,
        cancel_reason: t.cancel_reason,
        cancel_comment: t.cancel_comment,
        trial_started_at: t.trial_started_at,
        converted_at: t.converted_at,
        timeline: t.read_only_since ? deletionTimeline(t.read_only_since, cloudSettings(app)) : null,
        clients: Math.max(0, locs.length - 1),
        users: stockCount(app, t.location_id, 'users'),
        acceptances: db.all('SELECT doc, version, at FROM cloud_acceptances WHERE tenant_id = ? ORDER BY at DESC LIMIT 30', t.id),
        events: db.all('SELECT id, type, detail, at FROM cloud_events WHERE tenant_id = ? ORDER BY at DESC LIMIT 100', t.id),
      };
    });

    router.patch('/api/cloud/console/tenants/:id', 'admin', (ctx) => {
      const t = need(ctx.params.id);
      db.run('UPDATE cloud_tenants SET notes = ?, updated_at = ? WHERE id = ?', str(ctx.body?.notes, 'Notiz', { max: 2000 }), now(), t.id);
      return { ok: true };
    });

    router.post('/api/cloud/console/tenants/:id/extend-trial', 'admin', async (ctx) => {
      const t = need(ctx.params.id);
      const days = Number(ctx.body?.days);
      if (!Number.isInteger(days) || days < 1 || days > 90) throw bad('Tage: 1 bis 90');
      const sub = tenantSub(app, t)!;
      const base = Math.max(Date.now(), sub.trial_end ? new Date(sub.trial_end).getTime() : 0);
      const end = new Date(base + days * 864e5);
      if (sub.billing === 'stripe' && sub.stripe_subscription && sub.status !== 'canceled') {
        if (sub.status !== 'trialing') throw bad('Das Abo läuft schon – eine Testphase lässt sich nur verlängern, solange sie läuft.');
        await saasStripe(app, 'POST', `/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription)}`, { trial_end: Math.floor(end.getTime() / 1000), proration_behavior: 'none' });
        upsertSubscription(app, { location_id: t.location_id, plan_id: sub.plan_id, trial_end: end.toISOString(), current_period_end: end.toISOString() });
      } else {
        // A trial without payment data (also one that just ran out) starts running again.
        upsertSubscription(app, { location_id: t.location_id, plan_id: sub.plan_id, ...transition(sub, 'trialing', new Date(), cloudSettings(app).grace_days), trial_end: end.toISOString(), current_period_end: end.toISOString(), cancel_at_period_end: 0 });
      }
      db.run(`DELETE FROM cloud_mails WHERE tenant_id = ? AND kind IN ('trial_ending', 'trial_expired')`, t.id);
      db.run('UPDATE cloud_tenants SET read_only_since = NULL, schedule_notified_at = NULL, deletion_at = CASE WHEN deletion_reason = ? THEN deletion_at ELSE NULL END, updated_at = ? WHERE id = ?', 'self', now(), t.id);
      syncChildren(app, t);
      logCloudEvent(app, t.id, 'trial_extended', `+${days} Tage bis ${fmtDay(end.toISOString())}`);
      app.services.audit?.({ ctx, action: 'cloud.trial.extend', summary: `Testphase um ${days} Tage verlängert`, entityId: t.id, locationId: t.location_id });
      return tenantSummary(app, need(t.id));
    });

    router.post('/api/cloud/console/tenants/:id/comp', 'admin', (ctx) => {
      const t = need(ctx.params.id);
      const b = ctx.body ?? {};
      if (!isPlanKey(b.plan)) throw bad('Bitte einen Tarif wählen');
      const sub = tenantSub(app, t)!;
      if (sub.billing === 'stripe' && sub.stripe_subscription && sub.status !== 'canceled') throw bad('Es läuft ein Stripe-Abo – bitte erst das Abo beenden (Kunde: Kündigen, oder im Stripe-Dashboard), dann den Tarif schenken.');
      const months = b.months === undefined || b.months === null || b.months === '' ? 0 : Number(b.months);
      if (!Number.isInteger(months) || months < 0 || months > 60) throw bad('Monate: 0 (unbefristet) bis 60');
      const until = months ? new Date(new Date().setMonth(new Date().getMonth() + months)).toISOString() : null;
      upsertSubscription(app, {
        location_id: t.location_id,
        plan_id: planIdOf(b.plan),
        interval: 'month',
        billing: 'manual',
        stripe_subscription: '',
        stripe_item: '',
        cancel_at_period_end: 0,
        trial_end: null,
        current_period_end: until,
        ...transition({ status: 'canceled', past_due_since: null, grace_until: null, paused_at: null, canceled_at: null }, 'active', new Date(), 0),
      });
      db.run('UPDATE cloud_tenants SET comped = 1, comp_until = ?, read_only_since = NULL, schedule_notified_at = NULL, deletion_at = NULL, deletion_reason = ?, updated_at = ? WHERE id = ?', until, '', now(), t.id);
      syncChildren(app, t);
      logCloudEvent(app, t.id, 'comped', `${PLAN_INFO[b.plan as PlanKey].name}${until ? ` bis ${fmtDay(until)}` : ' unbefristet'}`);
      app.services.audit?.({ ctx, action: 'cloud.comp', summary: `Tarif geschenkt: ${PLAN_INFO[b.plan as PlanKey].name}`, entityId: t.id, locationId: t.location_id });
      return tenantSummary(app, need(t.id));
    });

    router.post('/api/cloud/console/tenants/:id/plan', 'admin', async (ctx) => {
      const t = need(ctx.params.id);
      if (!isPlanKey(ctx.body?.plan)) throw bad('Bitte einen Tarif wählen');
      return changePlan(app, t, ctx.body.plan as PlanKey, ctx.body.interval === 'year' ? 'year' : ctx.body.interval === 'month' ? 'month' : undefined, { ctx, operator: true });
    });

    /** "Konto öffnen": only while the customer allows it; the customer's own audit log shows each opening. */
    router.post('/api/cloud/console/tenants/:id/open', 'admin', (ctx) => {
      const t = need(ctx.params.id);
      if (!supportActive(t)) throw new HttpError(403, 'Der Kunde hat den Support-Zugriff nicht freigegeben (Einstellungen → Cloud-Konto → Support-Zugriff).');
      const why = str(ctx.body?.reason, 'Grund', { max: 300 });
      logCloudEvent(app, t.id, 'support_open', why);
      app.services.audit?.({ ctx, action: 'cloud.support.open', summary: `Support hat das Konto geöffnet${why ? `: ${why}` : ''}`, locationId: t.location_id, entityId: t.id });
      return { location_id: t.location_id, url: `${app.baseUrl()}/app?loc=${t.location_id}`, until: t.support_until };
    });

    router.post('/api/cloud/console/tenants/:id/delete', 'admin', async (ctx) => {
      const t = need(ctx.params.id);
      if (str(ctx.body?.confirm, 'Bestätigung') !== t.name) throw bad('Zur Bestätigung den Firmennamen genau eintippen');
      // No name in the log: the entry outlives the customer.
      app.services.audit?.({ ctx, action: 'cloud.delete.operator', summary: 'Kunden-Konto gelöscht', entityId: t.id });
      return eraseTenant(app, t, 'Löschung durch den Betreiber');
    });

    router.post('/api/cloud/console/reconcile', 'admin', async () => {
      await reconcile(app);
      return { ok: true };
    });

    // --- settings and legal texts -------------------------------------------------------------------------------------------------
    const settingsOut = () => {
      const s = cloudSettings(app);
      return {
        ...s,
        derived: {
          prices: Object.fromEntries(PLAN_KEYS.map((k) => [k, { month: priceFor(s, k, 'month'), year: priceFor(s, k, 'year') }])),
          stripe_connected: !!stripeKeyOf(app),
          webhook_url: `${app.baseUrl()}/hooks/stripe-agency`,
          pricing_url: `${app.baseUrl()}/cloud`,
          signup_url: `${app.baseUrl()}/start`,
          google_redirect_uri: `${app.baseUrl()}/start/google/callback`,
          google_ready: !!app.services.cloudGoogleReady?.(),
          snapshots: db.all('SELECT id, name FROM snapshots ORDER BY name'),
          locations: db.all('SELECT id, name FROM locations WHERE id NOT IN (SELECT location_id FROM cloud_locations) ORDER BY name'),
        },
      };
    };
    router.get('/api/cloud/console/settings', 'admin', () => settingsOut());
    router.put('/api/cloud/console/settings', 'admin', (ctx) => {
      let next;
      try {
        next = cleanSettings(ctx.body ?? {}, cloudSettings(app));
      } catch (e) {
        throw bad((e as Error).message);
      }
      if (next.default_snapshot_id && !db.get('SELECT id FROM snapshots WHERE id = ?', next.default_snapshot_id)) throw bad('Snapshot nicht gefunden');
      if (next.mail_location_id && !app.location(next.mail_location_id)) throw bad('Absender-Sub-Account nicht gefunden');
      saveCloudSettings(app, next);
      app.services.audit?.({ ctx, action: 'cloud.settings', summary: 'Cloud-Einstellungen geändert' });
      return settingsOut();
    });

    const legalOut = (doc: (typeof LEGAL_DOCS)[number]) => {
      const row = legalCurrent(app, doc);
      return { doc, title: LEGAL_TITLE[doc], version: row.version, body: row.body, created_at: row.created_at, open_placeholders: openPlaceholders(legalText(app, row)), accepted: Number(db.get<{ n: number }>('SELECT COUNT(DISTINCT tenant_id) AS n FROM cloud_acceptances WHERE doc = ? AND version = ?', doc, row.version)?.n ?? 0) };
    };
    router.get('/api/cloud/console/legal', 'admin', () => ({ docs: LEGAL_DOCS.map(legalOut) }));
    router.put('/api/cloud/console/legal/:doc', 'admin', (ctx) => {
      if (!isLegalDoc(ctx.params.doc)) throw notFound();
      const body = String(ctx.body?.body ?? '');
      if (body.trim().length < 20) throw bad('Der Text ist zu kurz');
      if (body.length > 100_000) throw bad('Der Text ist zu lang');
      setLegal(app, ctx.params.doc, body, ctx.user?.email ?? '');
      app.services.audit?.({ ctx, action: 'cloud.legal', summary: `${LEGAL_TITLE[ctx.params.doc]} geändert` });
      return legalOut(ctx.params.doc);
    });
  },
};

