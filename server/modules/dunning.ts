import type { Module } from '../core/app.js';
import { bad, clampLimit, notFound, type Ctx } from '../core/http.js';
import { render } from '../core/template.js';
import { id, now } from '../core/util.js';
import { contactVars, getContact, logActivity } from '../services/contacts.js';
import { auditLog, clip, json, money, purchaseTag, setPurchaseAccess, signToken, stripeCall, subscriptionOfInvoice } from '../services/creator-kit.js';
import { cleanSettings, defaults, type DunningSettings } from '../services/dunning-model.js';
import { sendToContact } from '../services/messaging.js';
import { registerActions, registerTriggers, requireText, text as fill } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';

/**
 * Mahnwesen for subscriptions and instalments: a failed payment (Stripe `invoice.payment_failed`) opens a case. The buyer gets
 * an e-mail (and optionally an SMS) with a signed link to the hosted billing page (modules/dunning-billing.ts) where the card
 * can be updated; Stripe's Smart Retries (set in the Stripe dashboard) keep trying, or – without them – the app pays the open
 * invoice on its own schedule. When Stripe stops, the access is paused (payment plans use their own setting) and comes back
 * with the next payment. Plugs into stripe.ts through app.services.stripeTaps. Docs: docs/dunning.md.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

const TOOLS: Tool[] = [
  {
    name: 'ghl_dunning_overview',
    title: 'Mahnwesen: Überblick',
    description: 'Fehlgeschlagene Abo-/Raten-Zahlungen (Fälle mit Status open|failed|recovered|closed, Versuche, nächster Versuch, Zugang pausiert) und Mahnungen zu Rechnungen (Entwürfe zur Freigabe, versendete, Stufen) mit Kennzahlen. status filtert die Fälle.',
    inputSchema: obj({ ...LOC, status: { type: 'string', enum: ['open', 'failed', 'recovered', 'closed'] } }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const q = a.status ? `?status=${encodeURIComponent(a.status)}` : '';
      const [overview, cases, notices] = await Promise.all([
        call.api('GET', '/api/dunning/overview', { location: a.location_id }),
        call.api('GET', `/api/dunning/cases${q}`, { location: a.location_id }),
        call.api('GET', '/api/dunning/notices?status=pending', { location: a.location_id }).catch(() => []),
      ]);
      return { overview, cases, pending_notices: notices };
    },
  },
  {
    name: 'ghl_dunning_send_link',
    title: 'Karten-Update-Link senden',
    description: 'Erzeugt für einen Kontakt den signierten Link zur Abo-Verwaltung (Zahlungsmethode ändern, Rechnungen, pausieren/kündigen je nach Produkteinstellung). Mit send=email|sms geht er gleich als Nachricht raus (nutzt den Text des Mahnwesens), sonst wird nur der Link zurückgegeben.',
    inputSchema: obj({ ...LOC, contact_id: { type: 'string' }, send: { type: 'string', enum: ['email', 'sms'] } }, ['location_id', 'contact_id']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) => call.api('POST', '/api/dunning/billing-link', { body: { contact_id: a.contact_id, send: a.send }, location: a.location_id }),
  },
  {
    name: 'ghl_dunning_run',
    title: 'Mahnläufe für Rechnungen',
    description:
      'Prüft die überfälligen Rechnungen und legt fällige Mahnstufen an (Zahlungserinnerung, 1./2. Mahnung): dry_run=true zeigt nur, was fällig wäre. Je nach Einstellung werden die Schreiben gleich versendet (auto) oder als Entwurf zur Freigabe angelegt (approval). Mit invoice_id nur für eine Rechnung (auch wenn das Mahnwesen aus ist).',
    inputSchema: obj({ ...LOC, dry_run: { type: 'boolean' }, invoice_id: { type: 'string' } }, ['location_id']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) => call.api('POST', '/api/dunning/run', { body: { dry_run: !!a.dry_run, invoice_id: a.invoice_id }, location: a.location_id }),
  },
  {
    name: 'ghl_dunning_notice',
    title: 'Mahnung freigeben, senden oder verwerfen',
    description: 'Bearbeitet einen Mahnungs-Entwurf (notice_id aus ghl_dunning_overview): action approve (versenden), dismiss (verwerfen) oder resend (erneut senden). Beim Versenden gehen E-Mail und PDF-Link an den Kontakt.',
    inputSchema: obj({ ...LOC, notice_id: { type: 'string' }, action: { type: 'string', enum: ['approve', 'dismiss', 'resend'] } }, ['location_id', 'notice_id', 'action']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) => call.api('POST', `/api/dunning/notices/${encodeURIComponent(a.notice_id)}/${a.action === 'approve' ? 'send' : a.action}`, { body: {}, location: a.location_id }),
  },
];

interface Case {
  id: string;
  location_id: string;
  contact_id: string | null;
  product_id: string | null;
  product_name: string;
  stripe_subscription: string;
  stripe_customer: string;
  stripe_invoice: string;
  plan_subscription_id: string | null;
  status: 'open' | 'failed' | 'recovered' | 'closed';
  amount_cents: number;
  currency: string;
  attempts: number;
  next_attempt_at: string | null;
  first_failed_at: string;
  last_failed_at: string;
  reminders: any;
  own_retries: any;
  access_paused: number;
  final_at: string | null;
  recovered_at: string | null;
  closed_reason: string;
  cancel_done: number;
  reason: string;
  tag: string;
}

const DAY = 864e5;

export const dunningModule: Module = {
  name: 'dunning',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE dunning_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE TABLE dunning_cases (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, product_id TEXT, product_name TEXT NOT NULL DEFAULT '',
        stripe_subscription TEXT NOT NULL, stripe_customer TEXT NOT NULL DEFAULT '', stripe_invoice TEXT NOT NULL DEFAULT '', plan_subscription_id TEXT,
        status TEXT NOT NULL DEFAULT 'open', amount_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR',
        attempts INTEGER NOT NULL DEFAULT 1, next_attempt_at TEXT, first_failed_at TEXT NOT NULL, last_failed_at TEXT NOT NULL,
        reminders TEXT NOT NULL DEFAULT '[]', own_retries TEXT NOT NULL DEFAULT '[]', access_paused INTEGER NOT NULL DEFAULT 0,
        final_at TEXT, recovered_at TEXT, closed_reason TEXT NOT NULL DEFAULT '', cancel_done INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX dunning_cases_loc ON dunning_cases(location_id, status);
      CREATE INDEX dunning_cases_sub ON dunning_cases(stripe_subscription, status);
      CREATE TABLE dunning_events (
        id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES dunning_cases(id) ON DELETE CASCADE, location_id TEXT NOT NULL,
        at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX dunning_events_case ON dunning_events(case_id, at);
      CREATE TABLE billing_product_settings (
        product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        allow_pause INTEGER NOT NULL DEFAULT 0, allow_cancel INTEGER NOT NULL DEFAULT 1, cancel_mode TEXT NOT NULL DEFAULT 'period_end',
        switch_to TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
      );
      CREATE TABLE dunning_card_updates (session_id TEXT PRIMARY KEY, location_id TEXT NOT NULL, subscription TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    // --- settings ---------------------------------------------------------------------------------------
    const settings = (loc: string): DunningSettings => {
      const row = db.get<{ data: string }>('SELECT data FROM dunning_settings WHERE location_id = ?', loc);
      try {
        return cleanSettings(row ? JSON.parse(row.data) : {}, defaults());
      } catch {
        return defaults();
      }
    };
    const saveSettings = (loc: string, patch: unknown) => {
      const next = cleanSettings(patch, settings(loc));
      db.run('INSERT INTO dunning_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', loc, JSON.stringify(next), now());
      return next;
    };

    router.get('/api/dunning/settings', 'location', (ctx) => ({ settings: settings(ctx.locationId), defaults: defaults() }));
    router.put('/api/dunning/settings', 'location', (ctx) => ({ settings: saveSettings(ctx.locationId, ctx.body ?? {}), defaults: defaults() }));

    // --- links and messages --------------------------------------------------------------------------------
    const billingUrl = (loc: string, contactId: string, days?: number) => {
      const ttl = (days ?? settings(loc).sub.link_days) * DAY;
      return `${app.baseUrl()}/abo/${signToken(app, 'billing', { l: loc, c: contactId }, ttl)}`;
    };
    const caseEvent = (c: Pick<Case, 'id' | 'location_id'>, kind: string, detail = '') => db.insert('dunning_events', { id: id(), case_id: c.id, location_id: c.location_id, at: now(), kind, detail: detail.slice(0, 400) });

    const varsOf = (c: Case, url: string) => {
      const contact = c.contact_id ? getContact(app, c.location_id, c.contact_id) : undefined;
      const firstAt = new Date(c.first_failed_at).getTime();
      const s = settings(c.location_id).sub;
      const left = s.final_after_days ? Math.max(0, Math.ceil((firstAt + s.final_after_days * DAY - Date.now()) / DAY)) : 0;
      return { contact: contactVars(contact), location: app.location(c.location_id), dunning: { url, amount: money(c.amount_cents, c.currency), product: c.product_name || 'dein Abo', days_left: left } };
    };

    /** Sends one of the three messages of a case (first, reminder, final) by e-mail and – if switched on – SMS. */
    async function notify(c: Case, kind: 'first' | 'reminder' | 'final', by = 'auto') {
      if (!c.contact_id) return { sent: false, why: 'Kein Kontakt zugeordnet' };
      const s = settings(c.location_id).sub;
      const url = billingUrl(c.location_id, c.contact_id);
      const vars = varsOf(c, url);
      const contact = getContact(app, c.location_id, c.contact_id);
      if (!contact) return { sent: false, why: 'Kontakt nicht gefunden' };
      const subject = render(kind === 'first' ? s.email_subject : kind === 'reminder' ? s.reminder_subject : s.final_subject, vars as any);
      const body = render(kind === 'first' ? s.email_body : kind === 'reminder' ? s.reminder_body : s.final_body, vars as any);
      // Noted before anything is sent (read fresh, not from the case the caller holds): the sweep or a webhook working on the
      // same case meanwhile counts it and does not send the same message again, and no entry overwrites another one.
      const slot = id();
      const at = now();
      const writeEntry = (entry: Record<string, unknown>) => {
        const list = json<any[]>(db.get<{ reminders: string }>('SELECT reminders FROM dunning_cases WHERE id = ?', c.id)?.reminders, []);
        const i = list.findIndex((r) => r?.slot === slot);
        if (i >= 0) list[i] = entry;
        else list.push(entry);
        db.run('UPDATE dunning_cases SET reminders = ?, updated_at = ? WHERE id = ?', JSON.stringify(list), now(), c.id);
      };
      writeEntry({ kind, at, channels: [], ok: false, by, slot });
      const channels: string[] = [];
      let ok = false;
      let error = '';
      if (contact.email) {
        const m = await sendToContact(app, c.location_id, { contactId: c.contact_id, channel: 'email', subject, body, source: 'Mahnwesen', ignoreDnd: true });
        channels.push('email');
        ok = m.status !== 'failed';
        if (!ok) error = String(m.error ?? '');
      }
      if (s.send_sms && contact.phone) {
        const m = await sendToContact(app, c.location_id, { contactId: c.contact_id, channel: 'sms', body: render(s.sms_body, vars as any), source: 'Mahnwesen', ignoreDnd: true });
        channels.push('sms');
        ok = ok || m.status !== 'failed';
        if (m.status === 'failed' && !error) error = String(m.error ?? '');
      }
      writeEntry({ kind, at, channels, ok, by });
      caseEvent(c, ok ? `message_${kind}` : 'message_failed', ok ? `${channels.join(' + ')}${by === 'auto' ? '' : ` (${by})`}` : error || 'Kein Kanal erreichbar');
      auditLog(app, undefined, c.location_id, 'dunning.message', `${kind === 'final' ? 'Letzte Nachricht' : kind === 'first' ? 'Karten-Update-Mail' : 'Erinnerung'} an ${contact.email || contact.phone} (${channels.join(', ') || 'kein Kanal'})`, c.id, by === 'auto' ? 'System' : by);
      return { sent: ok, channels, why: ok ? '' : error || 'Kein Kanal erreichbar (E-Mail oder Telefon fehlt)' };
    }

    // --- which purchase a failed payment belongs to ---------------------------------------------------------
    function locate(loc: string, subId: string, inv: any) {
      const plan = app.services.creatorPlans?.subscriptionOf(loc, subId);
      const checkout = db.get<any>(`SELECT * FROM stripe_checkouts WHERE location_id = ? AND subscription = ? AND kind = 'product' ORDER BY created_at LIMIT 1`, loc, subId);
      const details = inv?.parent?.subscription_details ?? inv?.subscription_details ?? {};
      const md = details.metadata ?? {};
      if (!plan && !checkout && md.location_id !== loc) return undefined;
      let contactId: string | null = plan?.contact_id ?? checkout?.contact_id ?? null;
      if (!contactId && inv?.customer_email) contactId = db.get<any>('SELECT id FROM contacts WHERE location_id = ? AND email = ?', loc, String(inv.customer_email).toLowerCase())?.id ?? null;
      const productId = String(plan?.product_id ?? checkout?.product_id ?? md.product_id ?? '');
      const product = productId ? db.get<any>('SELECT name FROM products WHERE id = ? AND location_id = ?', productId, loc) : undefined;
      const meta = json<Record<string, any>>(checkout?.meta, {});
      return { contactId, productId, productName: String(product?.name ?? md.product_name ?? plan?.plan_name ?? ''), tag: String(plan?.tag ?? meta.tag ?? md.tag ?? ''), planId: plan?.id as string | undefined };
    }

    const openCase = (loc: string, subId: string) => db.get<Case>(`SELECT * FROM dunning_cases WHERE location_id = ? AND stripe_subscription = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`, loc, subId);
    const recoverable = (loc: string, subId: string) => db.get<Case>(`SELECT * FROM dunning_cases WHERE location_id = ? AND stripe_subscription = ? AND status IN ('open', 'failed') ORDER BY created_at DESC LIMIT 1`, loc, subId);

    const eventData = (c: Case, extra: Record<string, unknown> = {}) => ({
      contactId: c.contact_id,
      caseId: c.id,
      productId: c.product_id,
      product: { id: c.product_id, name: c.product_name },
      subscription: c.stripe_subscription,
      amount_cents: c.amount_cents,
      currency: c.currency,
      attempts: c.attempts,
      billing_url: c.contact_id ? billingUrl(c.location_id, c.contact_id) : '',
      ...extra,
    });

    // --- Stripe events -------------------------------------------------------------------------------------------
    function onFailed(loc: string, inv: any, action: boolean) {
      const subId = subscriptionOfInvoice(inv);
      if (!subId) return;
      const s = settings(loc).sub;
      if (!s.enabled) return;
      const found = locate(loc, subId, inv);
      if (!found) return;
      const amount = Number(inv.amount_due ?? inv.amount_remaining ?? 0);
      const next = inv.next_payment_attempt ? new Date(Number(inv.next_payment_attempt) * 1000).toISOString() : null;
      let c = openCase(loc, subId);
      const created = !c;
      if (!c) {
        db.insert('dunning_cases', {
          id: id(), location_id: loc, contact_id: found.contactId, product_id: found.productId || null, product_name: found.productName, stripe_subscription: subId, stripe_customer: String(inv.customer ?? ''),
          stripe_invoice: String(inv.id ?? ''), plan_subscription_id: found.planId ?? null, status: 'open', amount_cents: amount, currency: String(inv.currency ?? 'eur').toUpperCase(), attempts: Math.max(1, Number(inv.attempt_count) || 1),
          next_attempt_at: next, first_failed_at: now(), last_failed_at: now(), reminders: [], own_retries: [], access_paused: 0, reason: action ? 'action_required' : String(inv.last_finalization_error?.code ?? 'payment_failed'), tag: found.tag, created_at: now(), updated_at: now(),
        });
        c = openCase(loc, subId)!;
        caseEvent(c, 'started', action ? 'Zahlung braucht eine Bestätigung (z. B. 3-D Secure)' : `Versuch ${c.attempts}${next ? `, nächster ${new Date(next).toLocaleDateString('de-DE')}` : ', Stripe versucht es nicht mehr'}`);
        if (found.contactId) logActivity(app, loc, found.contactId, 'dunning.started', `Zahlung für „${found.productName}“ fehlgeschlagen (${money(amount, c.currency)}) – Mahnwesen gestartet`);
        app.events.emit(loc, 'dunning.started', eventData(c, { reason: c.reason }));
        auditLog(app, undefined, loc, 'dunning.started', `Fall eröffnet: ${found.productName} (${money(amount, c.currency)})`, c.id);
      } else {
        db.run('UPDATE dunning_cases SET attempts = ?, next_attempt_at = ?, last_failed_at = ?, amount_cents = ?, stripe_invoice = ?, updated_at = ? WHERE id = ?', Math.max(c.attempts, Number(inv.attempt_count) || c.attempts), next, now(), amount || c.amount_cents, String(inv.id ?? c.stripe_invoice), now(), c.id);
        caseEvent(c, 'failed_again', `Versuch ${inv.attempt_count ?? c.attempts + 1}${next ? `, nächster ${new Date(next).toLocaleDateString('de-DE')}` : ''}`);
      }
      const fresh = db.get<Case>('SELECT * FROM dunning_cases WHERE id = ?', c.id)!;
      if (created && s.reminder_days.includes(0)) void notify(fresh, 'first').catch((e) => console.error('[dunning]', (e as Error).message));
      // Stripe has no further attempt: this was the last one.
      if (!action && !next && Number(inv.attempt_count) >= 1 && s.retry_mode === 'stripe') finalize(fresh, 'Stripe versucht es nicht mehr');
    }

    function finalize(c: Case, why: string) {
      if (c.status !== 'open') return;
      db.run(`UPDATE dunning_cases SET status = 'failed', final_at = ?, closed_reason = ?, updated_at = ? WHERE id = ? AND status = 'open'`, now(), why.slice(0, 200), now(), c.id);
      const s = settings(c.location_id).sub;
      let access = 'active';
      if (c.plan_subscription_id || app.services.creatorPlans?.subscriptionOf(c.location_id, c.stripe_subscription)) {
        // A payment plan has its own rule (pause, revoke, keep).
        app.services.creatorPlans.markDefaulted(c.location_id, c.stripe_subscription, 'payment_failed');
        access = app.services.creatorPlans.subscriptionOf(c.location_id, c.stripe_subscription)?.access ?? 'active';
        if (access !== 'active') db.run('UPDATE dunning_cases SET access_paused = 1 WHERE id = ?', c.id);
      } else if (s.access_on_final === 'pause' && c.contact_id && c.product_id) {
        const done = setPurchaseAccess(app, c.location_id, c.contact_id, c.product_id, c.tag || purchaseTag(app, c.location_id, c.product_id), false, 'Zahlung fehlgeschlagen');
        db.run('UPDATE dunning_cases SET access_paused = 1 WHERE id = ?', c.id);
        access = 'paused';
        logActivity(app, c.location_id, c.contact_id, 'dunning.access_paused', `Zugang pausiert (Zahlung für „${c.product_name}“ fehlgeschlagen)${done.length ? `: ${done.join(', ')}` : ''}`);
      }
      const fresh = db.get<Case>('SELECT * FROM dunning_cases WHERE id = ?', c.id)!;
      caseEvent(fresh, 'final', `${why}; Zugang: ${access}`);
      auditLog(app, undefined, c.location_id, 'dunning.final', `Fall endgültig fehlgeschlagen (${why}), Zugang ${access}`, c.id);
      app.events.emit(c.location_id, 'dunning.final_failed', eventData(fresh, { access, why }));
      void notify(fresh, 'final').catch((e) => console.error('[dunning]', (e as Error).message));
    }

    function recover(c: Case, via: string) {
      if (!db.run(`UPDATE dunning_cases SET status = 'recovered', recovered_at = ?, updated_at = ? WHERE id = ? AND status IN ('open', 'failed')`, now(), now(), c.id).changes) return;
      let restored = false;
      if (c.access_paused) {
        if (app.services.creatorPlans?.subscriptionOf(c.location_id, c.stripe_subscription)) restored = app.services.creatorPlans.recovered(c.location_id, c.stripe_subscription);
        else if (c.contact_id && c.product_id) {
          setPurchaseAccess(app, c.location_id, c.contact_id, c.product_id, c.tag || purchaseTag(app, c.location_id, c.product_id), true, 'Zahlung eingegangen');
          restored = true;
        }
        db.run('UPDATE dunning_cases SET access_paused = 0 WHERE id = ?', c.id);
      }
      const fresh = db.get<Case>('SELECT * FROM dunning_cases WHERE id = ?', c.id)!;
      caseEvent(fresh, 'recovered', `${via}${restored ? ', Zugang wieder aktiv' : ''}`);
      if (c.contact_id) logActivity(app, c.location_id, c.contact_id, 'dunning.recovered', `Zahlung für „${c.product_name}“ ist eingegangen${restored ? ' – Zugang wieder aktiv' : ''}`);
      auditLog(app, undefined, c.location_id, 'dunning.recovered', `Fall gelöst (${via})`, c.id);
      app.events.emit(c.location_id, 'dunning.recovered', eventData(fresh, { access_restored: restored }));
    }

    app.services.stripeTaps = [
      ...(app.services.stripeTaps ?? []),
      (loc: string, event: any) => {
        const o = event.data?.object ?? {};
        switch (event.type) {
          case 'invoice.payment_failed':
            onFailed(loc, o, false);
            break;
          case 'invoice.payment_action_required':
            onFailed(loc, o, true);
            break;
          case 'invoice.paid':
          case 'invoice.payment_succeeded': {
            const subId = subscriptionOfInvoice(o);
            const c = subId ? recoverable(loc, subId) : undefined;
            if (c) recover(c, 'Zahlung eingegangen');
            break;
          }
          case 'customer.subscription.updated': {
            const c = o.id ? openCase(loc, String(o.id)) : undefined;
            if (c && (o.status === 'unpaid' || o.status === 'canceled')) finalize(c, `Abo ${o.status === 'unpaid' ? 'unbezahlt' : 'beendet'}`);
            else if (c && o.status === 'active' && !o.pause_collection) recover(c, 'Abo wieder aktiv');
            break;
          }
          case 'customer.subscription.deleted': {
            const c = o.id ? openCase(loc, String(o.id)) : undefined;
            if (c) {
              if (String(o.cancellation_details?.reason ?? '') === 'payment_failed') finalize(c, 'Stripe hat das Abo beendet');
              else db.run(`UPDATE dunning_cases SET status = 'closed', closed_reason = 'Abo gekündigt', updated_at = ? WHERE id = ?`, now(), c.id);
            }
            break;
          }
          case 'checkout.session.completed':
            if (o.mode === 'setup' && o.metadata?.purpose === 'card_update' && o.metadata.location_id === loc) setImmediate(() => void app.services.billingPage?.applyNewCard(loc, String(o.id)).catch((e: Error) => console.error('[dunning] Karte', e.message)));
            break;
        }
        return undefined; // the Stripe module and the payment plans carry on
      },
    ];
    // A plan that Stripe gave up on closes its dunning case (the plan module decided about the access).
    app.events.on('payment_plan.defaulted', (e) => {
      const subId = db.get<{ stripe_subscription: string }>('SELECT stripe_subscription FROM plan_subscriptions WHERE id = ?', e.data.planSubscriptionId)?.stripe_subscription;
      const c = subId ? openCase(e.locationId, subId) : undefined;
      if (c) finalize(c, 'Ratenplan ausgefallen');
    });

    // --- background work: reminders, own retries, the end of the grace period -----------------------------------
    let lastSweep = 0;
    async function sweep(force = false) {
      if (!force && Date.now() - lastSweep < 60_000) return;
      lastSweep = Date.now();
      const cases = db.all<{ id: string }>(`SELECT id FROM dunning_cases WHERE status = 'open' ORDER BY first_failed_at LIMIT 100`);
      for (const { id: caseId } of cases) {
        // Read again: the messages before this one were awaited, a webhook may have changed the case (or sent its message) meanwhile.
        const c = db.get<Case>(`SELECT * FROM dunning_cases WHERE id = ? AND status = 'open'`, caseId);
        if (!c) continue;
        const s = settings(c.location_id).sub;
        if (!s.enabled) continue;
        const age = (Date.now() - new Date(c.first_failed_at).getTime()) / DAY;
        const reminders = json<any[]>(c.reminders, []);
        // reminders on their days (the day-0 message went out with the failure)
        const sent = reminders.filter((r) => r.kind !== 'final').length;
        const due = s.reminder_days.filter((d) => d > 0 && age >= d);
        const wanted = (s.reminder_days.includes(0) ? 1 : 0) + due.length;
        if (sent < wanted && c.contact_id) await notify(c, sent === 0 ? 'first' : 'reminder');
        // our own retries, when Stripe does not retry for us
        if (s.retry_mode === 'own' && c.stripe_invoice) {
          const tried = json<number[]>(c.own_retries, []);
          const day = s.retry_days.find((d) => age >= d && !tried.includes(d));
          if (day !== undefined) await retryNow(c, day).catch(() => undefined);
        }
        if (s.final_after_days && age >= s.final_after_days) finalize(db.get<Case>('SELECT * FROM dunning_cases WHERE id = ?', c.id)!, `${s.final_after_days} Tage nach dem ersten Fehlschlag`);
      }
      // optional: end the subscription after the final failure
      for (const c of db.all<Case>(`SELECT * FROM dunning_cases WHERE status = 'failed' AND cancel_done = 0 LIMIT 20`)) {
        if (!settings(c.location_id).sub.cancel_on_final) continue;
        db.run('UPDATE dunning_cases SET cancel_done = 1 WHERE id = ?', c.id);
        await stripeCall(app, c.location_id, 'DELETE', `/v1/subscriptions/${encodeURIComponent(c.stripe_subscription)}`).then(
          () => caseEvent(c, 'subscription_canceled', 'Abo bei Stripe beendet'),
          (e) => caseEvent(c, 'cancel_failed', (e as Error).message),
        );
      }
    }
    app.onTick(() => sweep());

    /** Pays the open invoice of a case with the card the customer has now. */
    async function retryNow(c: Case, day?: number) {
      const tried = json<number[]>(c.own_retries, []);
      if (day !== undefined) {
        tried.push(day);
        db.run('UPDATE dunning_cases SET own_retries = ?, updated_at = ? WHERE id = ?', JSON.stringify(tried), now(), c.id);
      }
      try {
        await stripeCall(app, c.location_id, 'POST', `/v1/invoices/${encodeURIComponent(c.stripe_invoice)}/pay`, {}, { idempotencyKey: `dunning-pay-${c.id}-${day ?? Date.now()}` });
        caseEvent(c, 'retry_ok', day === undefined ? 'Von Hand erneut versucht' : `Eigener Versuch an Tag ${day}`);
        return { ok: true };
      } catch (e) {
        caseEvent(c, 'retry_failed', (e as Error).message);
        return { ok: false, error: (e as Error).message };
      }
    }

    // --- admin API ---------------------------------------------------------------------------------------------------
    const caseOut = (c: any) => ({
      ...c,
      reminders: json(c.reminders, []),
      own_retries: json(c.own_retries, []),
      access_paused: !!c.access_paused,
      contact: { id: c.contact_id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || '', email: c.email ?? '' },
      first_name: undefined,
      last_name: undefined,
      email: undefined,
    });
    router.get('/api/dunning/cases', 'location', (ctx) => {
      const st = ctx.query.get('status');
      const rows = db.all<any>(
        `SELECT d.*, c.first_name, c.last_name, c.email FROM dunning_cases d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.location_id = ? ${st ? 'AND d.status = ?' : ''} ORDER BY d.created_at DESC LIMIT ?`,
        ctx.locationId,
        ...(st ? [st] : []),
        clampLimit(ctx.query.get('limit'), 100, 500),
      );
      return rows.map(caseOut);
    });
    const mustCase = (ctx: Ctx) => {
      const c = db.get<Case>('SELECT * FROM dunning_cases WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound('Fall nicht gefunden');
      return c;
    };
    router.get('/api/dunning/cases/:id', 'location', (ctx) => {
      const c = mustCase(ctx);
      const row = db.get<any>('SELECT d.*, c.first_name, c.last_name, c.email FROM dunning_cases d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.id = ?', c.id);
      return { ...caseOut(row), events: db.all('SELECT at, kind, detail FROM dunning_events WHERE case_id = ? ORDER BY at', c.id) };
    });
    router.post('/api/dunning/cases/:id/remind', 'location', async (ctx) => {
      const c = mustCase(ctx);
      if (!['open', 'failed'].includes(c.status)) throw bad('Dieser Fall ist abgeschlossen');
      const r = await notify(c, c.status === 'failed' ? 'final' : 'reminder', ctx.user?.name ?? 'manuell');
      if (!r.sent) throw bad(r.why || 'Nachricht konnte nicht gesendet werden');
      auditLog(app, ctx, c.location_id, 'dunning.remind', `Erinnerung manuell gesendet (${c.product_name})`, c.id);
      return { ok: true, channels: r.channels };
    });
    router.post('/api/dunning/cases/:id/retry', 'location', async (ctx) => {
      const c = mustCase(ctx);
      if (!['open', 'failed'].includes(c.status) || !c.stripe_invoice) throw bad('Dieser Fall lässt sich nicht erneut versuchen');
      const r = await retryNow(c);
      auditLog(app, ctx, c.location_id, 'dunning.retry', `Zahlung erneut versucht (${r.ok ? 'ok' : 'fehlgeschlagen'})`, c.id);
      if (!r.ok) throw bad(`Stripe: ${r.error}`);
      return { ok: true };
    });
    router.post('/api/dunning/cases/:id/close', 'location', (ctx) => {
      const c = mustCase(ctx);
      if (!['open', 'failed'].includes(c.status)) throw bad('Dieser Fall ist schon abgeschlossen');
      db.run(`UPDATE dunning_cases SET status = 'closed', closed_reason = ?, updated_at = ? WHERE id = ?`, clip(ctx.body?.reason, 200) || 'von Hand geschlossen', now(), c.id);
      caseEvent(c, 'closed', clip(ctx.body?.reason, 200) || 'von Hand geschlossen');
      return caseOut(db.get('SELECT d.*, c.first_name, c.last_name, c.email FROM dunning_cases d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.id = ?', c.id));
    });
    router.post('/api/dunning/cases/:id/access', 'location', (ctx) => {
      const c = mustCase(ctx);
      if (!c.contact_id || !c.product_id) throw bad('Dem Fall fehlt Kontakt oder Produkt');
      const on = ctx.body?.on !== false;
      setPurchaseAccess(app, c.location_id, c.contact_id, c.product_id, c.tag || purchaseTag(app, c.location_id, c.product_id), on, on ? 'manuell fortgesetzt' : 'manuell pausiert');
      db.run('UPDATE dunning_cases SET access_paused = ?, updated_at = ? WHERE id = ?', on ? 0 : 1, now(), c.id);
      caseEvent(c, on ? 'access_on' : 'access_off', ctx.user?.name ?? '');
      auditLog(app, ctx, c.location_id, 'dunning.access', `Zugang ${on ? 'fortgesetzt' : 'pausiert'} (${c.product_name})`, c.id);
      return { ok: true, access_paused: !on };
    });

    router.post('/api/dunning/billing-link', 'location', async (ctx) => {
      const contactId = clip(ctx.body?.contact_id, 40);
      const contact = contactId ? getContact(app, ctx.locationId, contactId) : undefined;
      if (!contact) throw notFound('Kontakt nicht gefunden');
      const s = settings(ctx.locationId).sub;
      const url = billingUrl(ctx.locationId, contact.id);
      const out: Record<string, unknown> = { url, expires_at: new Date(Date.now() + s.link_days * DAY).toISOString() };
      const send = ctx.body?.send;
      if (send === 'email' || send === 'sms') {
        const vars = { contact: contactVars(contact), location: app.location(ctx.locationId), dunning: { url, amount: '', product: 'dein Abo', days_left: 0 } };
        const body = send === 'email' ? `Hallo {{contact.first_name|}},\n\nhier kannst du deine Zahlungsmethode ändern, deine Rechnungen ansehen und dein Abo verwalten:\n{{dunning.url}}${'\n\nViele Grüße\n{{location.name}}'}` : 'Dein Abo verwalten: {{dunning.url}}';
        const m = await sendToContact(app, ctx.locationId, { contactId: contact.id, channel: send, subject: send === 'email' ? 'Dein Abo verwalten' : undefined, body: render(body, vars as any), source: 'Mahnwesen', ignoreDnd: true, userId: ctx.user?.id });
        if (m.status === 'failed') throw bad(String(m.error));
        out.sent = send;
      }
      auditLog(app, ctx, ctx.locationId, 'dunning.billing_link', `Link zur Abo-Verwaltung erzeugt${send ? ` und per ${send} gesendet` : ''}`, contact.id);
      return out;
    });

    router.get('/api/dunning/overview', 'location', (ctx) => {
      const cases = db.get<any>(
        `SELECT SUM(status = 'open') AS open, SUM(status = 'failed') AS failed, SUM(status = 'recovered' AND recovered_at > ?) AS recovered_30d, SUM(CASE WHEN status IN ('open','failed') THEN amount_cents ELSE 0 END) AS at_risk_cents,
                SUM(CASE WHEN status = 'recovered' AND recovered_at > ? THEN amount_cents ELSE 0 END) AS recovered_cents FROM dunning_cases WHERE location_id = ?`,
        new Date(Date.now() - 30 * DAY).toISOString(),
        new Date(Date.now() - 30 * DAY).toISOString(),
        ctx.locationId,
      )!;
      const notices = db.get<any>(`SELECT SUM(status = 'pending') AS pending, SUM(status = 'sent' AND sent_at > ?) AS sent_30d FROM dunning_notices WHERE location_id = ?`, new Date(Date.now() - 30 * DAY).toISOString(), ctx.locationId) ?? {};
      return {
        cases: { open: Number(cases.open) || 0, failed: Number(cases.failed) || 0, recovered_30d: Number(cases.recovered_30d) || 0, at_risk_cents: Number(cases.at_risk_cents) || 0, recovered_cents: Number(cases.recovered_cents) || 0 },
        notices: { pending: Number(notices.pending) || 0, sent_30d: Number(notices.sent_30d) || 0 },
        stripe: { connected: !!app.services.stripeKey?.(ctx.locationId), webhook_events: ['invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'customer.subscription.updated', 'customer.subscription.deleted', 'checkout.session.completed'] },
        settings: { sub_enabled: settings(ctx.locationId).sub.enabled, invoice_mode: settings(ctx.locationId).inv.mode },
      };
    });

    // --- per product: what customers may do on the billing page ---------------------------------------------------------
    const productSettings = (loc: string, pid: string) => {
      const r = db.get<any>('SELECT * FROM billing_product_settings WHERE product_id = ? AND location_id = ?', pid, loc);
      return { allow_pause: !!r?.allow_pause, allow_cancel: r ? !!r.allow_cancel : true, cancel_mode: r?.cancel_mode === 'now' ? 'now' : 'period_end', switch_to: json<string[]>(r?.switch_to, []) };
    };
    router.get('/api/dunning/products', 'location', (ctx) =>
      db.all<any>(`SELECT id, name, price_cents, currency, recurring FROM products WHERE location_id = ? AND recurring IS NOT NULL ORDER BY name`, ctx.locationId).map((p) => ({ ...p, ...productSettings(ctx.locationId, p.id) })),
    );
    router.put('/api/dunning/products/:id', 'location', (ctx) => {
      const p = db.get<any>('SELECT * FROM products WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!p) throw notFound('Produkt nicht gefunden');
      if (!p.recurring) throw bad('Nur Abo-Produkte (monatlich/jährlich) lassen sich verwalten');
      const b = ctx.body ?? {};
      const cur = productSettings(ctx.locationId, p.id);
      const switchTo = Array.isArray(b.switch_to) ? [...new Set<string>(b.switch_to.map((x: unknown) => String(x)))].slice(0, 10) : cur.switch_to;
      for (const sid of switchTo) {
        const t = db.get<any>('SELECT * FROM products WHERE id = ? AND location_id = ? AND active = 1', sid, ctx.locationId);
        if (!t || !t.recurring || t.id === p.id) throw bad('Wechsel nur zu anderen aktiven Abo-Produkten dieses Sub-Accounts');
        if (t.currency !== p.currency) throw bad('Wechsel nur zu Produkten in derselben Währung');
      }
      const next = { allow_pause: b.allow_pause === undefined ? cur.allow_pause : !!b.allow_pause, allow_cancel: b.allow_cancel === undefined ? cur.allow_cancel : !!b.allow_cancel, cancel_mode: b.cancel_mode === 'now' ? 'now' : b.cancel_mode === 'period_end' ? 'period_end' : cur.cancel_mode, switch_to: switchTo };
      db.run('DELETE FROM billing_product_settings WHERE product_id = ?', p.id);
      db.insert('billing_product_settings', { product_id: p.id, location_id: ctx.locationId, allow_pause: next.allow_pause ? 1 : 0, allow_cancel: next.allow_cancel ? 1 : 0, cancel_mode: next.cancel_mode, switch_to: next.switch_to, updated_at: now() });
      return { id: p.id, name: p.name, ...next };
    });

    // --- workflows -----------------------------------------------------------------------------------------------------------
    const sample = { caseId: 'c1', productId: 'p1', product: { id: 'p1', name: 'Mitgliedschaft' }, subscription: 'sub_1', amount_cents: 2900, currency: 'EUR', attempts: 1, billing_url: 'https://example.com/abo/…' };
    registerTriggers(app, [
      { type: 'dunning.started', label: 'Zahlung fehlgeschlagen (Abo/Rate)', category: 'payments', summary: 'Eine Abo- oder Raten-Zahlung ging nicht durch – ein Mahnfall wurde eröffnet.', doc: 'Läuft einmal je Fall. {{event.billing_url}} ist der signierte Link zur Abo-Verwaltung (Karte aktualisieren), {{event.product.name}} das Produkt, {{event.amount_cents}} der Betrag. Das Mahnwesen schickt selbst schon eine E-Mail – hier kannst du zusätzlich z. B. eine Aufgabe anlegen oder per WhatsApp erinnern.', fields: [{ key: 'product_id', label: 'Nur für Produkt', type: 'product' }], sample, keywords: 'mahnwesen zahlung fehlgeschlagen abo karte dunning' },
      { type: 'dunning.final_failed', label: 'Mahnwesen: Zahlung endgültig fehlgeschlagen', category: 'payments', summary: 'Stripe versucht es nicht mehr oder die Frist ist um – der Zugang wurde pausiert (je nach Einstellung).', doc: '{{event.access}} sagt, ob der Zugang pausiert wurde (paused, revoked) oder aktiv blieb, {{event.why}} den Grund.', fields: [{ key: 'product_id', label: 'Nur für Produkt', type: 'product' }], sample: { ...sample, access: 'paused', why: 'Stripe versucht es nicht mehr' }, keywords: 'mahnwesen pausiert endgültig dunning zugang' },
      { type: 'dunning.recovered', label: 'Mahnwesen: Zahlung nachträglich eingegangen', category: 'payments', summary: 'Nach einem Fehlschlag ist die Zahlung doch noch durchgegangen.', doc: '{{event.access_restored}} ist wahr, wenn ein pausierter Zugang wieder freigeschaltet wurde. Ein guter Moment für ein „Danke“.', fields: [{ key: 'product_id', label: 'Nur für Produkt', type: 'product' }], sample: { ...sample, access_restored: true }, keywords: 'mahnwesen zahlung eingegangen gelöst dunning' },
    ]);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'dunning.started': (c: any, d: any) => !c.product_id || c.product_id === d.productId,
      'dunning.final_failed': (c: any, d: any) => !c.product_id || c.product_id === d.productId,
      'dunning.recovered': (c: any, d: any) => !c.product_id || c.product_id === d.productId,
    };
    registerActions(app, [
      {
        meta: {
          type: 'dunning_send_link',
          label: 'Karten-Update-Link senden',
          category: 'payments',
          icon: 'card',
          summary: 'Schickt dem Kontakt den signierten Link zur Abo-Verwaltung per E-Mail oder SMS.',
          doc: 'Der Link führt zur gehosteten Seite, auf der der Kontakt Zahlungsmethode ändern, Rechnungen ansehen und (je nach Produkteinstellung) pausieren oder kündigen kann. Im Text steht {{dunning.url}} für den Link. Der Link steht außerdem in {{var.billing_url}}. Gesendet wird auch bei „Nicht stören“ (Zahlungsvorgang).',
          needs: 'Stripe (Einstellungen → Stripe)',
          fields: [
            { key: 'channel', label: 'Kanal', type: 'select', options: [['email', 'E-Mail'], ['sms', 'SMS']], default: 'email' },
            { key: 'subject', label: 'Betreff (E-Mail)', type: 'text', default: 'Bitte aktualisiere deine Zahlungsmethode' },
            { key: 'body', label: 'Text', type: 'textarea', default: 'Hallo {{contact.first_name|}},\n\nbitte prüfe deine Zahlungsmethode:\n{{dunning.url}}\n\nViele Grüße\n{{location.name}}' },
          ],
          provides: ['var.billing_url'],
          sample: { channel: 'email' },
        },
        run: async (run, step, vars) => {
          if (!run.contact_id) throw new Error('Kein Kontakt');
          const url = billingUrl(run.location_id, run.contact_id);
          const channel = step.channel === 'sms' ? 'sms' : 'email';
          const full = { ...vars, dunning: { url, product: vars.event?.product?.name ?? '', amount: vars.event?.amount_cents ? money(Number(vars.event.amount_cents), String(vars.event.currency ?? 'EUR')) : '', days_left: 0 } };
          const m = await sendToContact(app, run.location_id, { contactId: run.contact_id, channel, subject: channel === 'email' ? fill(requireText(step.subject, 'Betreff'), full) : undefined, body: fill(requireText(step.body, 'Text'), full), source: 'Workflow', ignoreDnd: true, purpose: 'transactional' });
          if (m.status === 'failed') throw new Error(String(m.error));
          return { result: `Link per ${channel === 'sms' ? 'SMS' : 'E-Mail'} gesendet`, vars: { billing_url: url } };
        },
      },
    ]);

    app.services.dunning = { settings, saveSettings, billingUrl, productSettings, caseEvent, notify, retryNow, sweep };
  },
};
