import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, type Ctx } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { id, now } from '../core/util.js';
import { logActivity } from '../services/contacts.js';
import { MAX_INSTALLMENTS, cancelAtFor, cleanPlan, intervalLabel, lumpLabel, planLabel, recurringOf, totalCents } from '../services/creator-plans.js';
import { auditLog, clip, money, netForGross, purchaseTag, setPurchaseAccess, stripeCall, subscriptionOfInvoice } from '../services/creator-kit.js';
import { MIN_AMOUNT_CENTS, stripeRequest } from '../services/stripe.js';
import { registerTriggers } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';
import { createInvoice, markInvoicePaid } from './payments.js';

/**
 * Ratenzahlung (payment plans) on products: "3 × 99 € monatlich" next to "297 € einmalig" on the buy page, run as a Stripe
 * subscription that ends by itself after the last payment (the app counts the paid invoices and ends the subscription right
 * after the last one; `cancel_at` is the safety net). Access comes with the first payment (the usual purchase tag); on a
 * default it is paused (comes back with the next payment), revoked or kept – per plan. Workflow triggers
 * `payment_plan.completed` and `payment_plan.defaulted`. Plugs into stripe.ts through its hooks (buyPageHtml, buyCheckout,
 * buyInvoiceItems, stripeTaps) – nothing of it lives in the Stripe module. Docs: docs/payment-plans.md.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

const TOOLS: Tool[] = [
  {
    name: 'ghl_payment_plan_list',
    title: 'Ratenzahlungspläne',
    description: 'Ratenzahlungspläne der Produkte (optional nur eines Produkts): Raten, Abstand, Betrag je Rate (brutto, in Cent), abweichende erste Rate, Verhalten bei Zahlungsausfall und Anzahl der laufenden/abgeschlossenen/ausgefallenen Käufe.',
    inputSchema: obj({ ...LOC, product_id: { type: 'string' } }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/payment-plans${a.product_id ? `?product_id=${encodeURIComponent(a.product_id)}` : ''}`, { location: a.location_id }),
  },
  {
    name: 'ghl_payment_plan_save',
    title: 'Ratenzahlungsplan speichern',
    description:
      'Legt einen Ratenzahlungsplan für ein Einmal-Produkt an (ohne plan_id) oder ändert ihn (mit plan_id). installments 2–60, interval week|month, interval_count (Abstand), amount_cents = Betrag je Rate brutto in Cent, first_amount_cents = abweichende erste Rate (optional), on_default pause|revoke|keep (Zugang bei Zahlungsausfall), active. Bestehende Käufe behalten die Bedingungen, zu denen sie gekauft wurden.',
    inputSchema: obj(
      {
        ...LOC,
        plan_id: { type: 'string' },
        product_id: { type: 'string' },
        name: { type: 'string' },
        installments: { type: 'integer', minimum: 2, maximum: MAX_INSTALLMENTS },
        interval: { type: 'string', enum: ['week', 'month'] },
        interval_count: { type: 'integer', minimum: 1 },
        amount_cents: { type: 'integer', minimum: MIN_AMOUNT_CENTS },
        first_amount_cents: { type: 'integer' },
        on_default: { type: 'string', enum: ['pause', 'revoke', 'keep'] },
        active: { type: 'boolean' },
      },
      ['location_id'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: (call, a) => {
      const { location_id, plan_id, ...body } = a;
      return plan_id ? call.api('PATCH', `/api/payment-plans/${encodeURIComponent(plan_id)}`, { body, location: location_id }) : call.api('POST', '/api/payment-plans', { body, location: location_id });
    },
  },
  {
    name: 'ghl_payment_plan_purchases',
    title: 'Ratenkäufe',
    description: 'Käufe mit Ratenzahlung: Kontakt, Plan, gezahlte/offene Raten, Status (active|completed|defaulted|canceled) und Zugang (active|paused|revoked). Filter status, contact_id.',
    inputSchema: obj({ ...LOC, status: { type: 'string', enum: ['active', 'completed', 'defaulted', 'canceled'] }, contact_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => {
      const q = new URLSearchParams();
      for (const k of ['status', 'contact_id', 'limit']) if (a[k]) q.set(k, String(a[k]));
      return call.api('GET', `/api/payment-plans/subscriptions?${q}`, { location: a.location_id });
    },
  },
];

interface PlanSub {
  id: string;
  location_id: string;
  plan_id: string | null;
  product_id: string;
  contact_id: string | null;
  checkout_id: string;
  stripe_subscription: string;
  stripe_customer: string;
  plan_name: string;
  installments: number;
  amount_cents: number;
  first_amount_cents: number | null;
  currency: string;
  interval: 'week' | 'month';
  interval_count: number;
  on_default: 'pause' | 'revoke' | 'keep';
  tag: string;
  tax_rate: number;
  status: 'active' | 'completed' | 'defaulted' | 'canceled';
  access: 'active' | 'paused' | 'revoked';
  paid_count: number;
  paid_cents: number;
  failed_count: number;
  last_failed_at: string | null;
  cancel_at: string | null;
  started_at: string;
  completed_at: string | null;
  defaulted_at: string | null;
  default_reason: string;
}

export const creatorPlansModule: Module = {
  name: 'creator-plans',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE payment_plans (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '', installments INTEGER NOT NULL, interval TEXT NOT NULL DEFAULT 'month', interval_count INTEGER NOT NULL DEFAULT 1,
        amount_cents INTEGER NOT NULL, first_amount_cents INTEGER, on_default TEXT NOT NULL DEFAULT 'pause',
        active INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX payment_plans_product ON payment_plans(product_id, active);
      CREATE INDEX payment_plans_loc ON payment_plans(location_id);
      CREATE TABLE plan_subscriptions (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        plan_id TEXT, product_id TEXT NOT NULL, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        checkout_id TEXT NOT NULL DEFAULT '', stripe_subscription TEXT NOT NULL, stripe_customer TEXT NOT NULL DEFAULT '',
        plan_name TEXT NOT NULL DEFAULT '', installments INTEGER NOT NULL, amount_cents INTEGER NOT NULL, first_amount_cents INTEGER,
        currency TEXT NOT NULL DEFAULT 'EUR', interval TEXT NOT NULL, interval_count INTEGER NOT NULL DEFAULT 1,
        on_default TEXT NOT NULL DEFAULT 'pause', tag TEXT NOT NULL DEFAULT '', tax_rate REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active', access TEXT NOT NULL DEFAULT 'active',
        paid_count INTEGER NOT NULL DEFAULT 0, paid_cents INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0, last_failed_at TEXT,
        cancel_at TEXT, started_at TEXT NOT NULL, completed_at TEXT, defaulted_at TEXT, default_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(stripe_subscription)
      );
      CREATE INDEX plan_subscriptions_loc ON plan_subscriptions(location_id, status);
      CREATE INDEX plan_subscriptions_contact ON plan_subscriptions(contact_id);
      CREATE TABLE plan_payments (
        id TEXT PRIMARY KEY, plan_subscription_id TEXT NOT NULL REFERENCES plan_subscriptions(id) ON DELETE CASCADE, location_id TEXT NOT NULL,
        number INTEGER NOT NULL, amount_cents INTEGER NOT NULL, needs_invoice INTEGER NOT NULL DEFAULT 0, invoice_id TEXT, paid_at TEXT NOT NULL
      );
      CREATE INDEX plan_payments_sub ON plan_payments(plan_subscription_id);
      CREATE TABLE plan_jobs (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL, plan_subscription_id TEXT NOT NULL REFERENCES plan_subscriptions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, done_at TEXT
      );
      CREATE INDEX plan_jobs_due ON plan_jobs(status, next_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    registerTriggers(app, [
      {
        type: 'payment_plan.completed',
        label: 'Ratenzahlung abgeschlossen',
        category: 'payments',
        summary: 'Die letzte Rate eines Ratenzahlungsplans ist bezahlt.',
        doc: 'Läuft einmal je Kauf, sobald alle Raten bezahlt sind. {{event.plan.name}}, {{event.paid_cents}}, {{event.installments}} und {{event.product.name}} stehen bereit. Der Zugang bleibt dauerhaft – ein guter Moment für eine Dankes-Mail oder ein Upsell.',
        fields: [{ key: 'product_id', label: 'Nur für Produkt', type: 'product' }],
        sample: { planSubscriptionId: 'ps1', productId: 'p1', product: { id: 'p1', name: 'Online-Kurs' }, plan: { name: '3 × 99,00 € monatlich', installments: 3, amount_cents: 9900 }, paid_count: 3, installments: 3, paid_cents: 29700, open_cents: 0, currency: 'EUR' },
        keywords: 'raten ratenzahlung zahlungsplan abbezahlt fertig',
      },
      {
        type: 'payment_plan.defaulted',
        label: 'Ratenzahlung ausgefallen',
        category: 'payments',
        summary: 'Eine Rate konnte nicht eingezogen werden und der Plan ist ausgefallen oder wurde gekündigt.',
        doc: 'Läuft, wenn Stripe die Rate nach allen Versuchen nicht einziehen konnte (oder der Kunde den Plan beendet). {{event.reason}} nennt den Grund (payment_failed, unpaid, canceled), {{event.access}} was mit dem Zugang passiert ist (paused, revoked, active), {{event.open_cents}} den offenen Rest.',
        fields: [{ key: 'product_id', label: 'Nur für Produkt', type: 'product' }],
        sample: { planSubscriptionId: 'ps1', productId: 'p1', product: { id: 'p1', name: 'Online-Kurs' }, plan: { name: '3 × 99,00 € monatlich', installments: 3, amount_cents: 9900 }, paid_count: 1, installments: 3, paid_cents: 9900, open_cents: 19800, reason: 'payment_failed', access: 'paused', currency: 'EUR' },
        keywords: 'raten ratenzahlung zahlungsausfall mahnung offen',
      },
    ]);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'payment_plan.completed': (c: any, d: any) => !c.product_id || c.product_id === d.productId,
      'payment_plan.defaulted': (c: any, d: any) => !c.product_id || c.product_id === d.productId,
    };

    const sb = () => app.services.stripeBuy as { grossOf(p: any): { tax: number; gross: number }; secretKey(l: string): string } | undefined;
    const taxOf = (p: any) => sb()!.grossOf(p).tax;
    const planOut = (r: any, currency = 'EUR') => {
      const stats = db.get<any>(
        `SELECT COUNT(*) AS purchases, SUM(status = 'active') AS active, SUM(status = 'completed') AS completed, SUM(status IN ('defaulted','canceled')) AS defaulted FROM plan_subscriptions WHERE plan_id = ?`,
        r.id,
      )!;
      return {
        ...r,
        active: !!r.active,
        label: planLabel(r, currency),
        every: intervalLabel(r),
        total_cents: totalCents(r),
        currency,
        purchases: Number(stats.purchases) || 0,
        running: Number(stats.active) || 0,
        completed: Number(stats.completed) || 0,
        defaulted: Number(stats.defaulted) || 0,
      };
    };
    const mustProduct = (loc: string, pid: unknown) => {
      const p = db.get<any>('SELECT * FROM products WHERE id = ? AND location_id = ?', String(pid ?? ''), loc);
      if (!p) throw notFound('Produkt nicht gefunden');
      return p;
    };

    // --- admin API ------------------------------------------------------------------------------------
    router.get('/api/payment-plans', 'location', (ctx) => {
      const pid = ctx.query.get('product_id');
      const rows = db.all<any>(`SELECT pl.*, p.currency FROM payment_plans pl JOIN products p ON p.id = pl.product_id WHERE pl.location_id = ? ${pid ? 'AND pl.product_id = ?' : ''} ORDER BY pl.product_id, pl.position, pl.created_at`, ctx.locationId, ...(pid ? [pid] : []));
      return rows.map((r) => planOut(r, r.currency));
    });
    router.post('/api/payment-plans', 'location', (ctx) => {
      const p = mustProduct(ctx.locationId, ctx.body?.product_id);
      if (p.recurring) throw bad('Ratenzahlung gibt es nur für Einmal-Produkte (kein Abo)');
      const f = cleanPlan(ctx.body);
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM payment_plans WHERE product_id = ?', p.id)!.n >= 6) throw bad('Höchstens 6 Pläne je Produkt');
      const row = { id: id(), location_id: ctx.locationId, product_id: p.id, ...f, active: ctx.body?.active === false ? 0 : 1, position: db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM payment_plans WHERE product_id = ?', p.id)!.n, created_at: now(), updated_at: now() };
      db.insert('payment_plans', row);
      return planOut(row, p.currency);
    });
    router.patch('/api/payment-plans/:id', 'location', (ctx) => {
      const cur = db.get<any>('SELECT * FROM payment_plans WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!cur) throw notFound('Plan nicht gefunden');
      const f = cleanPlan(ctx.body, cur);
      db.update('payment_plans', cur.id, { ...f, active: ctx.body?.active === undefined ? cur.active : ctx.body.active ? 1 : 0, updated_at: now() }, ctx.locationId);
      const p = db.get<any>('SELECT currency FROM products WHERE id = ?', cur.product_id);
      return planOut(db.get('SELECT * FROM payment_plans WHERE id = ?', cur.id)!, p?.currency);
    });
    router.delete('/api/payment-plans/:id', 'location', (ctx) => {
      // Purchases keep the terms they were bought with (a snapshot in plan_subscriptions).
      if (!db.run('DELETE FROM payment_plans WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Plan nicht gefunden');
      return { ok: true };
    });

    const subOut = (s: PlanSub, names?: Map<string, string>) => ({
      ...s,
      label: planLabel(s, s.currency),
      total_cents: totalCents(s),
      open_cents: Math.max(0, totalCents(s) - s.paid_cents),
      product_name: names?.get(s.product_id) ?? db.get<any>('SELECT name FROM products WHERE id = ?', s.product_id)?.name ?? '',
    });
    router.get('/api/payment-plans/subscriptions', 'location', (ctx) => {
      const where = ['s.location_id = ?'];
      const args: any[] = [ctx.locationId];
      const st = ctx.query.get('status');
      if (st) (where.push('s.status = ?'), args.push(st));
      const cid = ctx.query.get('contact_id');
      if (cid) (where.push('s.contact_id = ?'), args.push(cid));
      const rows = db.all<any>(
        `SELECT s.*, c.first_name, c.last_name, c.email, p.name AS product_name FROM plan_subscriptions s LEFT JOIN contacts c ON c.id = s.contact_id LEFT JOIN products p ON p.id = s.product_id
         WHERE ${where.join(' AND ')} ORDER BY s.started_at DESC LIMIT ?`,
        ...args,
        clampLimit(ctx.query.get('limit'), 100, 500),
      );
      return rows.map((r) => ({ ...subOut(r), contact: { id: r.contact_id, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || '', email: r.email ?? '' } }));
    });
    const mustSub = (ctx: Ctx) => {
      const s = db.get<PlanSub>('SELECT * FROM plan_subscriptions WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!s) throw notFound('Kauf nicht gefunden');
      return s;
    };
    router.get('/api/payment-plans/subscriptions/:id', 'location', (ctx) => {
      const s = mustSub(ctx);
      const c = s.contact_id ? db.get<any>('SELECT first_name, last_name, email FROM contacts WHERE id = ? AND location_id = ?', s.contact_id, s.location_id) : undefined;
      return { ...subOut(s), contact: { id: s.contact_id, name: [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.email || '', email: c?.email ?? '' }, payments: db.all('SELECT id, number, amount_cents, invoice_id, paid_at FROM plan_payments WHERE plan_subscription_id = ? ORDER BY number', s.id), jobs: db.all('SELECT kind, status, attempts, error, next_at FROM plan_jobs WHERE plan_subscription_id = ? ORDER BY created_at', s.id) };
    });
    router.post('/api/payment-plans/subscriptions/:id/access', 'location', (ctx) => {
      const s = mustSub(ctx);
      if (!s.contact_id) throw bad('Dem Kauf ist noch kein Kontakt zugeordnet');
      const on = ctx.body?.on !== false;
      setAccess(s, on, on ? 'manuell fortgesetzt' : 'manuell pausiert');
      auditLog(app, ctx, s.location_id, 'payment_plan.access', `Zugang ${on ? 'fortgesetzt' : 'pausiert'} (${s.plan_name})`, s.id);
      return subOut(db.get<PlanSub>('SELECT * FROM plan_subscriptions WHERE id = ?', s.id)!);
    });
    router.post('/api/payment-plans/subscriptions/:id/cancel', 'location', async (ctx) => {
      const s = mustSub(ctx);
      if (s.status === 'completed' || s.status === 'canceled') throw bad('Dieser Plan ist schon beendet');
      db.run(`UPDATE plan_subscriptions SET status = 'canceled', default_reason = 'by_admin', defaulted_at = ?, updated_at = ? WHERE id = ?`, now(), now(), s.id);
      await stripeCall(app, s.location_id, 'DELETE', `/v1/subscriptions/${encodeURIComponent(s.stripe_subscription)}`).catch((e) => {
        // Stripe no longer knows it (already ended): the plan is canceled here all the same.
        if (!/No such subscription|resource_missing/i.test((e as Error).message)) throw e;
      });
      auditLog(app, ctx, s.location_id, 'payment_plan.cancel', `Ratenplan beendet (${s.plan_name}, ${s.paid_count}/${s.installments} bezahlt)`, s.id);
      return subOut(db.get<PlanSub>('SELECT * FROM plan_subscriptions WHERE id = ?', s.id)!);
    });

    // --- buy page: the choice between lump sum and plan ---------------------------------------------------------
    const plansOf = (p: any) => (p.recurring || !sb() ? [] : db.all<any>('SELECT * FROM payment_plans WHERE product_id = ? AND location_id = ? AND active = 1 ORDER BY position, created_at', p.id, p.location_id));
    app.services.buyPageHtml = [
      ...(app.services.buyPageHtml ?? []),
      (ctx: Ctx, p: any) => {
        const plans = plansOf(p);
        if (!plans.length) return '';
        const want = clip(ctx.query.get('plan'), 40);
        const gross = sb()!.grossOf(p).gross;
        const radio = (value: string, title: string, sub: string, checked: boolean) =>
          `<label class="check plan-opt" style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 8px;align-items:center"><input type="radio" name="plan" value="${escapeHtml(value)}"${checked ? ' checked' : ''}> <span><strong>${escapeHtml(title)}</strong>${sub ? `<br><span class="muted" style="font-size:13px;font-weight:400">${escapeHtml(sub)}</span>` : ''}</span></label>`;
        const hit = plans.find((x) => x.id === want);
        return `<fieldset style="border:0;padding:0;margin:16px 0 0" data-plan-choice><legend style="font-weight:600;font-size:14px;margin:0 0 8px">Zahlungsweise</legend>
${radio('', lumpLabel(gross, p.currency), '', !hit)}
${plans.map((x) => radio(x.id, x.name || planLabel(x, p.currency), `${x.name ? `${planLabel(x, p.currency)} · ` : ''}insgesamt ${money(totalCents(x), p.currency)}`, hit?.id === x.id)).join('\n')}
</fieldset>`;
      },
    ];

    // --- Checkout: lump sum becomes a subscription that ends by itself ---------------------------------------------
    app.services.buyCheckout = [
      ...(app.services.buyCheckout ?? []),
      async (ctx: Ctx, { product: p, params, meta }: { product: any; params: Record<string, any>; meta: Record<string, any> }) => {
        const planId = clip(ctx.body?.plan, 40);
        if (!planId) return;
        const plan = db.get<any>('SELECT * FROM payment_plans WHERE id = ? AND product_id = ? AND location_id = ? AND active = 1', planId, p.id, p.location_id);
        if (!plan || !sb()) throw bad('Diesen Zahlungsplan gibt es nicht (mehr)');
        if (p.recurring) throw bad('Ratenzahlung gibt es nur für Einmal-Produkte');
        if (meta.coupon_code) throw bad('Rabattcodes gelten nicht bei Ratenzahlung – bitte „einmalig“ wählen oder den Code weglassen');
        const currency = String(p.currency).toLowerCase();
        const tax = taxOf(p);
        const label = planLabel(plan, p.currency);
        const first = plan.first_amount_cents as number | null;
        const lines: any[] = [
          {
            quantity: 1,
            price_data: { currency, unit_amount: plan.amount_cents, recurring: recurringOf(plan), product_data: { name: String(p.name).slice(0, 250), description: `Ratenzahlung: ${label}${tax ? ` · inkl. ${String(tax).replace('.', ',')} % USt.` : ''}`.slice(0, 500) } },
          },
        ];
        // More lines other hooks added (order bump): one-time items go on the first invoice of a subscription.
        const extra = params.line_items.slice(1);
        if (first && first > plan.amount_cents) {
          extra.unshift({ quantity: 1, price_data: { currency, unit_amount: first - plan.amount_cents, product_data: { name: `${String(p.name).slice(0, 200)} – Aufpreis erste Rate`.slice(0, 250) } } });
        }
        params.line_items = [...lines, ...extra];
        params.mode = 'subscription';
        // Valid only for one-time payments: the saved card for an upsell, the PaymentIntent settings.
        delete params.payment_intent_data;
        delete params.customer_creation;
        delete meta.upsell;
        if (first && first < plan.amount_cents) {
          const key = sb()!.secretKey(p.location_id);
          const c = await stripeRequest(key, 'POST', '/v1/coupons', { amount_off: plan.amount_cents - first, currency, duration: 'once', max_redemptions: 1, name: `Erste Rate ${money(first, p.currency)}`.slice(0, 40) }, { idempotencyKey: `plan-first-${plan.id}-${Math.round(Date.now() / 60_000)}-${ctx.ip}` }).catch((e) => {
            throw new HttpError(502, `Stripe: ${(e as Error).message}`);
          });
          params.discounts = [{ coupon: c.id }];
          delete params.allow_promotion_codes;
        }
        Object.assign(meta, {
          plan_id: plan.id,
          plan_name: String(plan.name || label).slice(0, 120),
          plan_n: plan.installments,
          plan_amount: plan.amount_cents,
          plan_first: first ?? '',
          plan_interval: plan.interval,
          plan_interval_count: plan.interval_count,
          price_cents: netForGross(plan.amount_cents, tax),
          tax_rate: tax,
        });
        params.subscription_data = { ...(params.subscription_data ?? {}), metadata: meta, description: `${String(p.name).slice(0, 100)} – ${label}`.slice(0, 500) };
      },
    ];

    // The first invoice shows the first payment and which instalment it is.
    app.services.buyInvoiceItems = [
      ...(app.services.buyInvoiceItems ?? []),
      (_loc: string, session: any, items: any[]) => {
        const md = session.metadata ?? {};
        if (!md.plan_id) return items;
        const n = Number(md.plan_n) || 0;
        const tax = Number(md.tax_rate) || 0;
        const firstGross = Number(md.plan_first) || Number(md.plan_amount) || 0;
        // The discount Stripe took off the first invoice is already in the first-payment amount.
        const out = items.filter((it) => it.name !== 'Gutschein (Stripe)');
        out[0] = { ...out[0], name: `${out[0].name} – Rate 1/${n}`, description: `Ratenzahlung: ${md.plan_name ?? ''}`.trim(), price_cents: netForGross(firstGross, tax), tax_rate: tax };
        return out;
      },
    ];

    // --- purchases ------------------------------------------------------------------------------------------------------
    const subOf = (loc: string, subId: string) => db.get<PlanSub>('SELECT * FROM plan_subscriptions WHERE location_id = ? AND stripe_subscription = ?', loc, subId);
    const enqueue = (s: PlanSub, kind: 'set_cancel_at' | 'end_after_period') => {
      if (db.get('SELECT 1 FROM plan_jobs WHERE plan_subscription_id = ? AND kind = ? AND status = ?', s.id, kind, 'open')) return;
      db.insert('plan_jobs', { id: id(), location_id: s.location_id, plan_subscription_id: s.id, kind, attempts: 0, next_at: now(), status: 'open', error: '', created_at: now() });
    };

    /** The plan purchase behind a Stripe subscription – created by whichever event arrives first (checkout, invoice). */
    function ensureSub(locationId: string, subId: string, md: Record<string, any>, extra: { checkoutId?: string; customer?: string; currency?: string } = {}): PlanSub | undefined {
      if (!subId || !md.plan_id || md.location_id !== locationId) return undefined;
      let s = subOf(locationId, subId);
      if (!s) {
        const plan = db.get<any>('SELECT * FROM payment_plans WHERE id = ? AND location_id = ?', md.plan_id, locationId);
        const product = db.get<any>('SELECT currency FROM products WHERE id = ? AND location_id = ?', md.product_id, locationId);
        const n = Math.round(Number(md.plan_n) || plan?.installments || 0);
        if (!n || n < 2) return undefined;
        db.run(
          `INSERT OR IGNORE INTO plan_subscriptions (id, location_id, plan_id, product_id, checkout_id, stripe_subscription, stripe_customer, plan_name, installments, amount_cents, first_amount_cents, currency, interval, interval_count, on_default, tag, tax_rate, status, access, started_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'active', ?, ?, ?)`,
          id(), locationId, plan?.id ?? String(md.plan_id), String(md.product_id), extra.checkoutId ?? '', subId, extra.customer ?? '', String(md.plan_name ?? plan?.name ?? ''), n,
          Math.round(Number(md.plan_amount) || plan?.amount_cents || 0), md.plan_first ? Math.round(Number(md.plan_first)) : null, String(extra.currency ?? product?.currency ?? 'EUR').toUpperCase(),
          md.plan_interval === 'week' ? 'week' : 'month', Math.round(Number(md.plan_interval_count) || 1), plan?.on_default ?? 'pause', String(md.tag ?? ''), Number(md.tax_rate) || 0, now(), now(), now(),
        );
        s = subOf(locationId, subId);
        if (s) enqueue(s, 'set_cancel_at');
      }
      if (s) {
        const patch: Record<string, any> = {};
        if (extra.checkoutId && !s.checkout_id) patch.checkout_id = extra.checkoutId;
        if (extra.customer && !s.stripe_customer) patch.stripe_customer = extra.customer;
        if (!s.tag && md.tag) patch.tag = String(md.tag);
        if (Object.keys(patch).length) {
          db.update('plan_subscriptions', s.id, { ...patch, updated_at: now() });
          s = subOf(locationId, subId)!;
        }
      }
      return s;
    }

    /** The buyer exists once the purchase is processed: link the contact, then create invoices that were waiting. */
    app.events.on('product.purchased', (e) => {
      const md = e.data.metadata ?? {};
      if (!md.plan_id || e.data.via) return;
      const checkout = db.get<any>('SELECT subscription, contact_id FROM stripe_checkouts WHERE id = ? AND location_id = ?', e.data.sessionId, e.locationId);
      if (!checkout?.subscription) return;
      const s = ensureSub(e.locationId, checkout.subscription, { ...md, location_id: e.locationId, product_id: e.data.productId, tag: md.tag ?? e.data.tag }, { checkoutId: e.data.sessionId });
      if (!s) return;
      const contactId = e.data.contactId ?? checkout.contact_id;
      if (contactId && !s.contact_id) db.update('plan_subscriptions', s.id, { contact_id: contactId, updated_at: now() });
      void reconcile(s.id);
    });

    // --- Stripe events ------------------------------------------------------------------------------------------------------
    app.services.stripeTaps = [
      ...(app.services.stripeTaps ?? []),
      (locationId: string, event: any) => {
        const o = event.data?.object ?? {};
        switch (event.type) {
          case 'checkout.session.completed': {
            if (o.mode !== 'subscription' || !o.metadata?.plan_id || o.metadata.location_id !== locationId) return undefined;
            ensureSub(locationId, String(o.subscription ?? ''), o.metadata, { checkoutId: o.id, customer: String(o.customer ?? ''), currency: String(o.currency ?? '').toUpperCase() || undefined });
            return undefined; // the purchase itself (contact, invoice, tag) is the Stripe module's
          }
          case 'invoice.paid':
          case 'invoice.payment_succeeded':
            return onInvoicePaid(locationId, o);
          case 'invoice.payment_failed': {
            const s = planOfInvoice(locationId, o);
            if (s && s.status === 'active') db.run('UPDATE plan_subscriptions SET failed_count = failed_count + 1, last_failed_at = ?, updated_at = ? WHERE id = ?', now(), now(), s.id);
            return undefined; // payment.failed and the dunning module carry on
          }
          case 'customer.subscription.deleted':
            return onSubscriptionEnded(locationId, o);
          case 'customer.subscription.updated':
            return onSubscriptionUpdated(locationId, o);
          default:
            return undefined;
        }
      },
    ];

    const planOfInvoice = (locationId: string, inv: any): PlanSub | undefined => {
      const details = inv?.parent?.subscription_details ?? inv?.subscription_details ?? {};
      const subId = subscriptionOfInvoice(inv);
      if (!subId) return undefined;
      return subOf(locationId, subId) ?? ensureSub(locationId, subId, details.metadata ?? {}, { customer: String(inv.customer ?? ''), currency: String(inv.currency ?? '').toUpperCase() || undefined });
    };

    function onInvoicePaid(locationId: string, inv: any) {
      const s = planOfInvoice(locationId, inv);
      if (!s) return undefined;
      const amount = Number(inv.amount_paid ?? 0);
      const first = inv.billing_reason === 'subscription_create';
      // An instalment is capped by what the plan still asks for: at most the agreed instalment, and nothing once every instalment
      // is paid (Stripe charged once more than agreed – the end of the subscription did not get through). What is above that is
      // not booked as an instalment (no invoice "Rate 4 von 3"); it is noted for a refund and the subscription is told to end.
      // The first payment counts as charged: it also carries the order bump and the first-instalment surcharge or discount.
      const beyond = !first && s.paid_count >= s.installments;
      const counted = first ? amount : beyond ? 0 : Math.min(amount, s.amount_cents);
      const surplus = amount - counted;
      const fresh = db.run('INSERT OR IGNORE INTO plan_payments (id, plan_subscription_id, location_id, number, amount_cents, needs_invoice, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?)', String(inv.id), s.id, locationId, s.paid_count + 1, counted, first || !counted ? 0 : 1, now()).changes;
      if (!fresh) return { handled: 'duplicate' };
      if (surplus > 0) {
        const name = s.plan_name || planLabel(s, s.currency);
        const text = `Ratenzahlung ${name}: Stripe hat ${money(amount, s.currency)} eingezogen, ${beyond ? `obwohl alle ${s.installments} Raten bezahlt sind` : `die Rate beträgt ${money(s.amount_cents, s.currency)}`} – ${money(surplus, s.currency)} nicht als Rate gebucht, bitte erstatten`;
        if (s.contact_id) logActivity(app, locationId, s.contact_id, 'payment_plan.overpaid', text);
        auditLog(app, undefined, locationId, 'payment_plan.overpaid', text, s.id);
        if (beyond) {
          enqueue(s, 'end_after_period');
          void runJobs(5);
          return { handled: 'plan_overpaid', planSubscriptionId: s.id, surplus_cents: surplus };
        }
      }
      db.run('UPDATE plan_subscriptions SET paid_count = paid_count + 1, paid_cents = paid_cents + ?, updated_at = ? WHERE id = ?', counted, now(), s.id);
      const cur = db.get<PlanSub>('SELECT * FROM plan_subscriptions WHERE id = ?', s.id)!;
      void reconcile(s.id);
      // A payment after a default brings the access back (and the plan with it).
      if (cur.status === 'defaulted' && cur.access !== 'revoked') {
        db.run(`UPDATE plan_subscriptions SET status = 'active', defaulted_at = NULL, default_reason = '' WHERE id = ?`, s.id);
        if (cur.contact_id) setAccess(cur, true, 'Rate bezahlt');
      }
      if (cur.paid_count >= cur.installments && cur.status !== 'completed' && cur.status !== 'canceled') complete(cur);
      return { handled: 'plan_payment', planSubscriptionId: s.id, paid: cur.paid_count, of: cur.installments };
    }

    function complete(s: PlanSub) {
      if (!db.run(`UPDATE plan_subscriptions SET status = 'completed', completed_at = ?, access = 'active', updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'canceled')`, now(), now(), s.id).changes) return;
      if (s.access !== 'active' && s.contact_id) setAccess(s, true, 'Plan abgeschlossen');
      enqueue(s, 'end_after_period');
      if (s.contact_id) logActivity(app, s.location_id, s.contact_id, 'payment_plan.completed', `Ratenzahlung abgeschlossen: ${s.plan_name || planLabel(s, s.currency)} (${money(totalCents(s), s.currency)})`);
      auditLog(app, undefined, s.location_id, 'payment_plan.completed', `Ratenplan abgeschlossen (${s.paid_count}/${s.installments})`, s.id);
      app.events.emit(s.location_id, 'payment_plan.completed', eventData(db.get<PlanSub>('SELECT * FROM plan_subscriptions WHERE id = ?', s.id)!));
      void runJobs(5);
    }

    const eventData = (s: PlanSub, extra: Record<string, unknown> = {}) => ({
      contactId: s.contact_id,
      planSubscriptionId: s.id,
      productId: s.product_id,
      product: { id: s.product_id, name: db.get<any>('SELECT name FROM products WHERE id = ?', s.product_id)?.name ?? '' },
      plan: { id: s.plan_id, name: s.plan_name || planLabel(s, s.currency), installments: s.installments, amount_cents: s.amount_cents, first_amount_cents: s.first_amount_cents, interval: s.interval, interval_count: s.interval_count },
      paid_count: s.paid_count,
      installments: s.installments,
      paid_cents: s.paid_cents,
      total_cents: totalCents(s),
      open_cents: Math.max(0, totalCents(s) - s.paid_cents),
      currency: s.currency,
      access: s.access,
      ...extra,
    });

    /** Access on/off for a purchase, remembered on the row. */
    function setAccess(s: PlanSub, on: boolean, why: string) {
      if (!s.contact_id) return;
      const tag = s.tag || purchaseTag(app, s.location_id, s.product_id);
      const done = setPurchaseAccess(app, s.location_id, s.contact_id, s.product_id, tag, on, why);
      const state = on ? 'active' : s.on_default === 'revoke' ? 'revoked' : 'paused';
      db.run('UPDATE plan_subscriptions SET access = ?, updated_at = ? WHERE id = ?', state, now(), s.id);
      logActivity(app, s.location_id, s.contact_id, on ? 'payment_plan.access_on' : 'payment_plan.access_off', `Zugang ${on ? 'fortgesetzt' : state === 'revoked' ? 'entzogen' : 'pausiert'} (${why})${done.length ? `: ${done.join(', ')}` : ''}`);
    }

    /** A plan that Stripe gave up on (or the buyer ended): the setting decides what happens to the access. */
    function declareDefault(s: PlanSub, reason: string) {
      if (['completed', 'defaulted', 'canceled'].includes(s.status)) return false;
      const status = reason === 'canceled' ? 'canceled' : 'defaulted';
      db.run('UPDATE plan_subscriptions SET status = ?, defaulted_at = ?, default_reason = ?, updated_at = ? WHERE id = ?', status, now(), reason, now(), s.id);
      const cur = db.get<PlanSub>('SELECT * FROM plan_subscriptions WHERE id = ?', s.id)!;
      if (cur.on_default !== 'keep' && cur.contact_id) setAccess(cur, false, `Ratenplan ${reason === 'canceled' ? 'beendet' : 'ausgefallen'}`);
      const after = db.get<PlanSub>('SELECT * FROM plan_subscriptions WHERE id = ?', s.id)!;
      if (after.contact_id) logActivity(app, s.location_id, after.contact_id, 'payment_plan.defaulted', `Ratenzahlung ${reason === 'canceled' ? 'beendet' : 'ausgefallen'}: ${after.paid_count}/${after.installments} Raten bezahlt, ${money(Math.max(0, totalCents(after) - after.paid_cents), after.currency)} offen`);
      auditLog(app, undefined, s.location_id, 'payment_plan.defaulted', `Ratenplan ${status} (${reason}, ${after.paid_count}/${after.installments}, Zugang ${after.access})`, s.id);
      app.events.emit(s.location_id, 'payment_plan.defaulted', eventData(after, { reason }));
      return true;
    }

    function onSubscriptionEnded(locationId: string, sub: any) {
      const s = subOf(locationId, String(sub.id ?? ''));
      if (!s) return undefined;
      if (s.status === 'completed' || s.status === 'canceled' || s.status === 'defaulted') return { handled: 'plan_subscription_ended' };
      if (s.paid_count >= s.installments) {
        complete(s);
        return { handled: 'plan_subscription_ended' };
      }
      const why = String(sub.cancellation_details?.reason ?? '');
      declareDefault(s, why === 'payment_failed' || why === 'payment_disputed' ? 'payment_failed' : 'canceled');
      return { handled: 'plan_defaulted' };
    }

    function onSubscriptionUpdated(locationId: string, sub: any) {
      const s = subOf(locationId, String(sub.id ?? ''));
      if (!s) return undefined;
      const patch: Record<string, any> = {};
      if (sub.cancel_at && !s.cancel_at) patch.cancel_at = new Date(Number(sub.cancel_at) * 1000).toISOString();
      if (Object.keys(patch).length) db.update('plan_subscriptions', s.id, patch);
      if (sub.status === 'unpaid' && s.status === 'active') declareDefault(s, 'unpaid');
      else if (sub.status === 'active' && s.status === 'defaulted' && s.access !== 'revoked' && s.contact_id) {
        db.run(`UPDATE plan_subscriptions SET status = 'active', defaulted_at = NULL, default_reason = '' WHERE id = ?`, s.id);
        setAccess(s, true, 'Abo wieder aktiv');
      }
      return undefined;
    }

    // --- invoices for the instalments after the first (the first one comes with the purchase) ----------------------------------
    async function reconcile(subscriptionRowId: string) {
      const s = db.get<PlanSub>('SELECT * FROM plan_subscriptions WHERE id = ?', subscriptionRowId);
      if (!s?.contact_id) return;
      for (const p of db.all<any>('SELECT * FROM plan_payments WHERE plan_subscription_id = ? AND needs_invoice = 1 AND invoice_id IS NULL ORDER BY number', s.id)) {
        try {
          const tax = s.tax_rate;
          const created = createInvoice(app, s.location_id, {
            kind: 'invoice',
            contact_id: s.contact_id,
            title: `${db.get<any>('SELECT name FROM products WHERE id = ?', s.product_id)?.name ?? s.plan_name} – Rate ${p.number}/${s.installments}`,
            items: [{ name: `Rate ${p.number} von ${s.installments}`, description: `Ratenzahlung: ${s.plan_name || planLabel(s, s.currency)}`, qty: 1, price_cents: netForGross(p.amount_cents, tax), tax_rate: tax }],
            currency: s.currency,
            notes: 'Ratenzahlung, online bezahlt über Stripe.',
          });
          db.run('UPDATE plan_payments SET invoice_id = ?, needs_invoice = 0 WHERE id = ?', created.id, p.id);
          db.run(
            `INSERT OR IGNORE INTO stripe_checkouts (id, location_id, kind, product_id, contact_id, invoice_id, mode, amount_cents, currency, status, subscription, created_at, paid_at) VALUES (?, ?, 'renewal', ?, ?, ?, 'subscription', ?, ?, 'paid', ?, ?, ?)`,
            p.id, s.location_id, s.product_id, s.contact_id, created.id, p.amount_cents, s.currency, s.stripe_subscription, now(), now(),
          );
          markInvoicePaid(app, s.location_id, created.id, 'Stripe-Ratenzahlung');
        } catch (e) {
          console.error('[payment-plans] Rechnung', (e as Error).message);
        }
      }
    }

    // --- Stripe jobs with retries ---------------------------------------------------------------------------------------------------
    async function doJob(job: any) {
      const s = db.get<PlanSub>('SELECT * FROM plan_subscriptions WHERE id = ?', job.plan_subscription_id);
      if (!s) return;
      const path = `/v1/subscriptions/${encodeURIComponent(s.stripe_subscription)}`;
      if (job.kind === 'set_cancel_at') {
        const sub = await stripeCall<any>(app, s.location_id, 'GET', path);
        if (sub.status === 'canceled') return;
        const start = Number(sub.start_date ?? sub.created ?? Math.floor(Date.now() / 1000));
        const at = cancelAtFor(s, start);
        await stripeCall(app, s.location_id, 'POST', path, { cancel_at: at, proration_behavior: 'none' }, { idempotencyKey: `plan-cancel-at-${s.id}` });
        db.run('UPDATE plan_subscriptions SET cancel_at = ?, stripe_customer = COALESCE(NULLIF(stripe_customer, \'\'), ?), updated_at = ? WHERE id = ?', new Date(at * 1000).toISOString(), String(sub.customer ?? ''), now(), s.id);
      } else if (job.kind === 'end_after_period') {
        const sub = await stripeCall<any>(app, s.location_id, 'GET', path).catch((e) => {
          if (/No such subscription/i.test((e as Error).message)) return { status: 'canceled' };
          throw e;
        });
        if (sub.status === 'canceled') return;
        await stripeCall(app, s.location_id, 'POST', path, { cancel_at_period_end: true }, { idempotencyKey: `plan-end-${s.id}` });
      }
    }
    async function runJobs(limit = 20) {
      for (const job of db.all<any>(`SELECT * FROM plan_jobs WHERE status = 'open' AND next_at <= ? ORDER BY next_at LIMIT ?`, now(), limit)) {
        if (!db.run(`UPDATE plan_jobs SET next_at = ? WHERE id = ? AND status = 'open' AND next_at = ?`, new Date(Date.now() + 60_000).toISOString(), job.id, job.next_at).changes) continue;
        try {
          await doJob(job);
          db.run(`UPDATE plan_jobs SET status = 'done', done_at = ?, error = '' WHERE id = ?`, now(), job.id);
        } catch (e) {
          const attempts = job.attempts + 1;
          const msg = (e as Error).message.slice(0, 300);
          if (attempts >= 8) {
            db.run(`UPDATE plan_jobs SET status = 'failed', attempts = ?, error = ?, done_at = ? WHERE id = ?`, attempts, msg, now(), job.id);
            auditLog(app, undefined, job.location_id, 'payment_plan.job_failed', `${job.kind} fehlgeschlagen: ${msg}`, job.plan_subscription_id);
          } else db.run('UPDATE plan_jobs SET attempts = ?, error = ?, next_at = ? WHERE id = ?', attempts, msg, new Date(Date.now() + 2 ** attempts * 60_000).toISOString(), job.id);
        }
      }
    }
    let lastCleanup = 0;
    app.onTick(async () => {
      await runJobs();
      // Invoices that waited for the contact, and old finished jobs.
      for (const r of db.all<{ plan_subscription_id: string }>(`SELECT DISTINCT plan_subscription_id FROM plan_payments WHERE needs_invoice = 1 AND invoice_id IS NULL LIMIT 20`)) await reconcile(r.plan_subscription_id);
      if (Date.now() - lastCleanup > 6 * 3600_000) {
        lastCleanup = Date.now();
        db.run(`DELETE FROM plan_jobs WHERE status != 'open' AND done_at < ?`, new Date(Date.now() - 30 * 864e5).toISOString());
      }
    });

    /** For the dunning module and tests. */
    app.services.creatorPlans = {
      runJobs,
      subscriptionOf: (loc: string, subId: string) => subOf(loc, subId),
      /** Stripe gave up on the subscription (dunning's last step): the plan's own setting decides about the access. */
      markDefaulted: (loc: string, subId: string, reason = 'payment_failed') => {
        const s = subOf(loc, subId);
        return s ? declareDefault(s, reason) : false;
      },
      /** The buyer paid again: access and status come back. */
      recovered: (loc: string, subId: string) => {
        const s = subOf(loc, subId);
        if (!s || s.status !== 'defaulted' || s.access === 'revoked') return false;
        db.run(`UPDATE plan_subscriptions SET status = 'active', defaulted_at = NULL, default_reason = '' WHERE id = ?`, s.id);
        if (s.contact_id) setAccess(s, true, 'Zahlung eingegangen');
        return true;
      },
      reconcile,
    };
  },
};
