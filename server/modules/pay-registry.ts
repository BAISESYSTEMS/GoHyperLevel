import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, clampLimit, html, notFound, redirect, str, type Ctx, type RawResult } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { centsToMoney, normalizeEmail, now } from '../core/util.js';
import { getContact } from '../services/contacts.js';
import { openCents } from '../services/invoice-model.js';
import { MOLLIE_METHODS, isMollieKey, mollieApi, mollieProvider, paymentState, testMollie } from '../services/pay-mollie.js';
import { PAYPAL_EVENTS, captureOrder, paypalProvider, testPaypal, verifyPaypalWebhook } from '../services/pay-paypal.js';
import {
  GIFT_PROVIDER,
  MIN_CENTS,
  accountOf,
  applyGift,
  applyState,
  bookInvoicePayment,
  checkoutSession,
  failHttp,
  getSession,
  lapseSession,
  payProviders,
  providerLabel,
  readyProviders,
  refreshSession,
  refundSession,
  registerPayProvider,
  registerPayPurpose,
  saveAccount,
  secretHint,
  sessionByRef,
  sessionOut,
  settleSession,
  startSession,
  type Account,
  type PaySession,
  type StartInput,
} from '../services/pay-registry.js';
import { sessionState, stripeProvider } from '../services/pay-stripe.js';
import { lineItemParams } from '../services/stripe.js';

/**
 * Payment provider registry (docs/payment-providers.md): Stripe, PayPal (Orders v2 incl. Pay Later) and Mollie (iDEAL, SEPA, cards,
 * Klarna) behind one small interface (services/pay-registry.ts). This module keeps the sessions and the sealed credentials per
 * sub-account, takes the PayPal and Mollie webhooks (Stripe's arrive through modules/stripe.ts → app.services.stripeSessions), serves
 * the pay page `/pay/<id>` (choose a provider, redeem a gift card) and plugs the registry into invoices ("Mit PayPal, Mollie oder
 * Gutschein bezahlen"), buy links (provider choice on /buy/<product>) and bookings (app.services.payRegistry, used by
 * services/teamcal-pay.ts). Settings live in Einstellungen → Stripe & Zahlungen; routes /api/pay (area "settings").
 */

const SQL = `
CREATE TABLE pay_accounts (
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, provider TEXT NOT NULL, secrets TEXT NOT NULL DEFAULT '', options TEXT NOT NULL DEFAULT '{}',
  hint TEXT NOT NULL DEFAULT '', checked_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (location_id, provider)
);
CREATE TABLE pay_sessions (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, provider TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL, ref_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, gift_cents INTEGER NOT NULL DEFAULT 0, gift_card_id TEXT, currency TEXT NOT NULL DEFAULT 'EUR', description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', provider_ref TEXT NOT NULL DEFAULT '', capture_ref TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', method TEXT NOT NULL DEFAULT '',
  refunded_cents INTEGER NOT NULL DEFAULT 0, received_cents INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, paid_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX pay_sessions_ref ON pay_sessions(location_id, purpose, ref_id);
CREATE INDEX pay_sessions_status ON pay_sessions(status, updated_at);
CREATE TABLE pay_refs (
  provider TEXT NOT NULL, ref TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES pay_sessions(id) ON DELETE CASCADE, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY (provider, ref)
);
CREATE INDEX pay_refs_session ON pay_refs(session_id);
CREATE INDEX pay_refs_location ON pay_refs(location_id);
CREATE TABLE pay_events (
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, provider TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL DEFAULT '', received_at TEXT NOT NULL,
  PRIMARY KEY (location_id, provider, id)
);
`;

const KEEP = '••••••';
/** Simple per-IP throttle for the public starts and gift-card tries (each start is a provider API call). */
const hits = new Map<string, number[]>();
function throttled(key: string, max = 30, windowMs = 60 * 60_000): boolean {
  const t = Date.now();
  const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
  list.push(t);
  hits.set(key, list);
  if (hits.size > 20_000) hits.clear();
  return list.length > max;
}

export const payRegistryModule: Module = {
  name: 'pay-registry',
  migrations: [['001-init', SQL]],
  register(app: App) {
    const { db, router } = app;
    for (const p of [stripeProvider, paypalProvider, mollieProvider]) registerPayProvider(app, p);
    const money = (c: number, cur: string) => centsToMoney(c, cur.toUpperCase());
    const giftActive = (loc: string) => !!app.services.giftCards?.activeIn(loc);
    const others = (loc: string) => readyProviders(app, loc).filter((p) => p.id !== 'stripe');

    // --- the registry for other modules (bookings, store) ---------------------------------------------------------------
    app.services.payRegistry = {
      ready: (loc: string) => readyProviders(app, loc).map((p) => p.id),
      /** True when the buyer should get the pay page (choose a provider, redeem a gift card) instead of Stripe straight away. */
      choiceNeeded: (loc: string) => others(loc).length > 0 || giftActive(loc),
      start: (input: StartInput) => startSession(app, input),
      checkout: async (id: string, provider: string) => checkoutSession(app, getSession(app, id)!, provider),
      pageUrl: (s: Pick<PaySession, 'id'>) => `${app.baseUrl()}/pay/${s.id}`,
      get: (id: string) => getSession(app, id),
      lapse: (id: string, status: 'failed' | 'expired' | 'cancelled' = 'expired') => {
        const s = getSession(app, id);
        if (s) lapseSession(app, s, status);
      },
      /** Everything back: what the provider charged, and the gift-card part onto the card. */
      refundAll: async (id: string) => {
        const s = getSession(app, id);
        if (!s) throw notFound('Zahlung nicht gefunden');
        const left = s.received_cents - s.refunded_cents;
        const r = left > 0 && s.provider !== GIFT_PROVIDER ? await refundSession(app, s, left) : { id: '', amount_cents: 0 };
        if (s.gift_cents > 0 && s.gift_card_id) app.services.giftCards?.refund(s.location_id, s.gift_card_id, s.gift_cents, s.purpose, s.ref_id);
        return { id: r.id, amount_cents: r.amount_cents, gift_cents: s.gift_cents };
      },
      refund: async (id: string, amount?: number) => {
        const s = getSession(app, id);
        if (!s) throw notFound('Zahlung nicht gefunden');
        return refundSession(app, s, amount);
      },
      label: (id: string) => providerLabel(app, id),
    };

    // --- settings ---------------------------------------------------------------------------------------------------------
    const status = (loc: string) =>
      [...payProviders(app).values()].map((p) => {
        const acc = p.id === 'stripe' ? undefined : accountOf(app, loc, p.id);
        return {
          id: p.id,
          label: p.label,
          ready: p.ready(app, loc),
          methods: p.methods(app, loc),
          // Stripe's key and webhook are set under Einstellungen → Stripe (modules/stripe.ts).
          managed_elsewhere: p.id === 'stripe',
          hint: acc?.hint ?? '',
          options: p.id === 'paypal' ? { mode: acc?.options.mode === 'live' ? 'live' : 'sandbox', pay_later: acc?.options.pay_later !== false } : p.id === 'mollie' ? { methods: acc?.options.methods ?? [] } : {},
          webhook_set: p.id === 'paypal' ? !!acc?.secrets.webhook_id : p.id === 'mollie',
          webhook_url: p.id === 'stripe' ? `${app.baseUrl()}/hooks/stripe/${loc}` : `${app.baseUrl()}/hooks/${p.id}/${loc}`,
          events: p.id === 'paypal' ? PAYPAL_EVENTS : [],
          checked_at: acc?.checked_at ?? null,
        };
      });
    router.get('/api/pay/providers', 'location', (ctx) => ({ providers: status(ctx.locationId), mollie_methods: MOLLIE_METHODS.map(([id, label]) => ({ id, label })) }));

    /** The credentials of a PUT/test body merged over the stored ones ("••••••" or empty keeps a secret). */
    const merged = (loc: string, provider: string, b: any): Account => {
      const cur = accountOf(app, loc, provider) ?? { secrets: {}, options: {}, hint: '', checked_at: null };
      const secrets = { ...cur.secrets };
      const options = { ...cur.options };
      const take = (k: string, label: string) => {
        const v = str(b?.[k], label, { max: 300 });
        if (v && v !== KEEP) secrets[k] = v;
      };
      if (provider === 'paypal') {
        take('client_id', 'Client-ID');
        take('client_secret', 'Secret');
        take('webhook_id', 'Webhook-ID');
        if (b?.mode !== undefined) options.mode = b.mode === 'live' ? 'live' : 'sandbox';
        if (b?.pay_later !== undefined) options.pay_later = b.pay_later !== false;
        if (secrets.client_id && !/^[A-Za-z0-9_-]{20,}$/.test(secrets.client_id)) throw bad('Client-ID: so wie sie in der PayPal-Entwickleransicht steht (Apps & Credentials)');
        if (secrets.webhook_id && !/^[A-Za-z0-9-]{6,40}$/.test(secrets.webhook_id)) throw bad('Webhook-ID: die ID des Webhooks aus der PayPal-Entwickleransicht');
        return { secrets, options, hint: secretHint(secrets.client_id ?? ''), checked_at: cur.checked_at };
      }
      take('api_key', 'API-Schlüssel');
      if (Array.isArray(b?.methods)) options.methods = b.methods.map(String).filter((m: string) => MOLLIE_METHODS.some(([k]) => k === m));
      if (secrets.api_key && !isMollieKey(secrets.api_key)) throw bad('API-Schlüssel: beginnt mit live_ oder test_ (Mollie → Entwickler → API-Schlüssel)');
      return { secrets, options, hint: secretHint(secrets.api_key ?? ''), checked_at: cur.checked_at };
    };
    const known = (id: string) => {
      if (id !== 'paypal' && id !== 'mollie') throw notFound('Diesen Zahlungsanbieter gibt es nicht (Stripe: Einstellungen → Stripe)');
      return id;
    };
    const test = (provider: string, acc: Account) => (provider === 'paypal' ? testPaypal(app, acc) : testMollie(app, acc));
    const complete = (provider: string, acc: Account) => (provider === 'paypal' ? !!(acc.secrets.client_id && acc.secrets.client_secret) : !!acc.secrets.api_key);

    router.put('/api/pay/providers/:id', 'location', async (ctx) => {
      const provider = known(ctx.params.id);
      const acc = merged(ctx.locationId, provider, ctx.body ?? {});
      if (!complete(provider, acc)) throw bad(provider === 'paypal' ? 'Bitte Client-ID und Secret eintragen' : 'Bitte den API-Schlüssel eintragen');
      await test(provider, acc).catch((e) => {
        throw failHttp(e);
      });
      saveAccount(app, ctx.locationId, provider, { ...acc, checked_at: now() });
      return { providers: status(ctx.locationId) };
    });
    router.post('/api/pay/providers/:id/test', 'location', async (ctx) => {
      const provider = known(ctx.params.id);
      const acc = merged(ctx.locationId, provider, ctx.body ?? {});
      if (!complete(provider, acc)) throw bad('Noch keine Zugangsdaten gespeichert');
      try {
        return await test(provider, acc);
      } catch (e) {
        throw failHttp(e);
      }
    });
    router.delete('/api/pay/providers/:id', 'location', (ctx) => {
      db.run('DELETE FROM pay_accounts WHERE location_id = ? AND provider = ?', ctx.locationId, known(ctx.params.id));
      return { providers: status(ctx.locationId) };
    });

    // --- sessions (read, refund) ---------------------------------------------------------------------------------------------
    router.get('/api/pay/sessions', 'location', (ctx) => {
      const where = ['location_id = ?'];
      const args: string[] = [ctx.locationId];
      for (const k of ['purpose', 'ref_id', 'status', 'provider'] as const) {
        const v = ctx.query.get(k);
        if (v) {
          where.push(`${k} = ?`);
          args.push(v.slice(0, 80));
        }
      }
      return db
        .all(`SELECT * FROM pay_sessions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${clampLimit(ctx.query.get('limit'), 50, 500)}`, ...args)
        .map((r) => sessionOut(app, parseJson(r as PaySession, ['meta'])));
    });
    const mine = (ctx: Ctx) => {
      const s = getSession(app, ctx.params.id);
      if (!s || s.location_id !== ctx.locationId) throw notFound('Zahlung nicht gefunden');
      return s;
    };
    router.get('/api/pay/sessions/:id', 'location', (ctx) => sessionOut(app, mine(ctx)));
    router.post('/api/pay/sessions/:id/refund', 'location', async (ctx) => {
      const s = mine(ctx);
      const amount = ctx.body?.amount_cents === undefined || ctx.body?.amount_cents === '' ? undefined : Number(ctx.body.amount_cents);
      const r = await refundSession(app, s, amount);
      app.events.emit(ctx.locationId, 'payment.refunded', { contactId: null, purpose: s.purpose, refId: s.ref_id, amount_cents: r.amount_cents, currency: s.currency, provider: s.provider, full: r.amount_cents >= s.received_cents - s.refunded_cents });
      return { ...sessionOut(app, getSession(app, s.id)!), refund_id: r.id };
    });

    // --- webhooks ------------------------------------------------------------------------------------------------------------
    /** Runs a verified, new event once; a failure forgets it so the provider's retry gets another go. */
    async function once(loc: string, provider: string, eventId: string, type: string, fn: () => Promise<Record<string, unknown>>) {
      if (!db.run('INSERT OR IGNORE INTO pay_events (location_id, provider, id, type, received_at) VALUES (?, ?, ?, ?, ?)', loc, provider, eventId, type, now()).changes) return { received: true, duplicate: true };
      try {
        return { received: true, ...(await fn()) };
      } catch (e) {
        db.run('DELETE FROM pay_events WHERE location_id = ? AND provider = ? AND id = ?', loc, provider, eventId);
        throw e;
      }
    }

    router.post('/hooks/paypal/:locationId', 'public', async (ctx) => {
      const loc = ctx.params.locationId;
      const acc = accountOf(app, loc, 'paypal');
      if (!acc?.secrets.webhook_id) throw notFound('PayPal ist für diesen Account nicht eingerichtet');
      let event: any;
      try {
        event = JSON.parse(ctx.rawBody);
      } catch {
        throw bad('Ungültiges JSON');
      }
      if (typeof event?.id !== 'string' || typeof event?.event_type !== 'string') throw bad('Kein PayPal-Ereignis');
      const ok = await verifyPaypalWebhook(app, acc, ctx.req.headers, event).catch(() => false);
      if (!ok) throw bad('Ungültige PayPal-Signatur');
      return once(loc, 'paypal', event.id, event.event_type, async () => {
        const r = event.resource ?? {};
        if (event.event_type === 'CHECKOUT.ORDER.APPROVED') {
          const s = sessionByRef(app, loc, 'paypal', String(r.id ?? ''));
          if (!s || s.status === 'paid') return { handled: 'ignored' };
          await applyState(app, s, await captureOrder(app, acc, String(r.id)), 'paypal');
          return { handled: 'captured' };
        }
        const orderId = String(r.supplementary_data?.related_ids?.order_id ?? '');
        const s = (orderId && sessionByRef(app, loc, 'paypal', orderId)) || getSession(app, String(r.custom_id ?? ''));
        if (!s || s.location_id !== loc) return { handled: 'ignored' };
        const amount = r.amount?.value !== undefined ? Math.round(Number(r.amount.value) * 100) : undefined;
        if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
          await applyState(app, s, { status: 'paid', amount_cents: amount, currency: r.amount?.currency_code, capture_ref: String(r.id ?? '') }, 'paypal');
          return { handled: 'paid' };
        }
        if (event.event_type === 'PAYMENT.CAPTURE.PENDING') await applyState(app, s, { status: 'pending', capture_ref: String(r.id ?? '') }, 'paypal');
        else if (event.event_type === 'PAYMENT.CAPTURE.DENIED' || event.event_type === 'PAYMENT.CAPTURE.DECLINED') await applyState(app, s, { status: 'failed' }, 'paypal');
        else return { handled: 'ignored' };
        return { handled: event.event_type.split('.').pop()!.toLowerCase() };
      });
    });

    // Mollie's call carries only the payment id: the state is read back from Mollie with the sub-account's key.
    router.post('/hooks/mollie/:locationId', 'public', async (ctx) => {
      const loc = ctx.params.locationId;
      const acc = accountOf(app, loc, 'mollie');
      if (!acc?.secrets.api_key) throw notFound('Mollie ist für diesen Account nicht eingerichtet');
      const pid = String(ctx.body?.id ?? '');
      if (!/^tr_[A-Za-z0-9]{4,40}$/.test(pid)) throw bad('Keine Mollie-Zahlungs-ID');
      const s = sessionByRef(app, loc, 'mollie', pid);
      if (!s || s.status === 'paid') return { received: true, handled: 'ignored' };
      const p = await mollieApi(app, acc, 'GET', `/payments/${encodeURIComponent(pid)}`).catch((e) => {
        throw failHttp(e);
      });
      if (p?.metadata?.pay_session !== s.id) return { received: true, handled: 'ignored' };
      if (p.status === 'authorized') await mollieApi(app, acc, 'POST', `/payments/${encodeURIComponent(pid)}/captures`, {}, `cap-${pid}`).catch((e) => console.error('[mollie] capture', (e as Error).message));
      const state = paymentState(p);
      await applyState(app, s, state, 'mollie');
      return { received: true, handled: state.status };
    });

    // Stripe: Checkout Sessions of the registry come back through the Stripe module's webhook.
    app.services.stripeSessions = [
      ...(app.services.stripeSessions ?? []),
      (loc: string, session: any, type: string) => {
        const sid = session?.metadata?.pay_session;
        if (!sid) return undefined;
        const s = getSession(app, String(sid));
        if (!s || s.location_id !== loc) return { handled: 'ignored' };
        const state = sessionState(session);
        if (type === 'checkout.session.async_payment_failed') lapseSession(app, s, 'failed');
        else if (state.status === 'paid') {
          const r = settleSession(app, s, state, 'stripe');
          if (r.pending) void r.pending;
        } else if (type === 'checkout.session.expired') {
          // only the attempt that is current lapses the session (an older Stripe page of a session paid otherwise does not)
          if (s.provider === 'stripe' && s.provider_ref === session.id) lapseSession(app, s, 'expired');
        } else void applyState(app, s, state, 'stripe');
        return { handled: 'pay_session' };
      },
    ];

    // DSGVO: the buyer's e-mail, name and address in the sessions go (amounts, provider and references stay for the books).
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, loc: string, contact: { email?: string }) => {
        const email = normalizeEmail(contact.email);
        if (email) db.run(`UPDATE pay_sessions SET meta = json_remove(meta, '$.email', '$.name', '$.address') WHERE location_id = ? AND lower(json_extract(meta, '$.email')) = ?`, loc, email);
      },
    ];

    // Open sessions nobody paid lapse after two days (a held gift card is free again), processing ones after 30 days; old events go.
    let swept = 0;
    app.onTick(() => {
      if (Date.now() - swept < 10 * 60_000) return;
      swept = Date.now();
      const stale = db.all<PaySession>(
        `SELECT * FROM pay_sessions WHERE (status = 'open' AND updated_at < ?) OR (status = 'pending' AND updated_at < ?) LIMIT 200`,
        new Date(Date.now() - 2 * 864e5).toISOString(),
        new Date(Date.now() - 30 * 864e5).toISOString(),
      );
      for (const s of stale) lapseSession(app, parseJson(s, ['meta']), 'expired');
      db.run('DELETE FROM pay_events WHERE received_at < ?', new Date(Date.now() - 30 * 864e5).toISOString());
    });

    // --- the pay page ----------------------------------------------------------------------------------------------------------
    const page = (title: string, body: string, color?: string, status = 200) => html(publicPage({ title, body: `<div class="wrap" style="max-width:560px"><div class="card">${body}</div></div>`, color }), status);
    const notThere = () => page('Nicht gefunden', '<h1>Nicht gefunden</h1><p class="muted">Diese Zahlung gibt es nicht (mehr).</p>', undefined, 404);
    const back = (s: PaySession) => String(s.meta.return_url || `/pay/${s.id}`);

    function payPage(s: PaySession, error = ''): RawResult {
      const loc = app.location(s.location_id);
      const color = loc?.settings?.branding?.color || undefined;
      const head = `${loc?.logo_url ? `<img src="${escapeHtml(loc.logo_url)}" alt="" style="max-height:48px;margin-bottom:12px">` : `<p class="muted" style="margin:0 0 6px">${escapeHtml(loc?.name ?? '')}</p>`}`;
      if (s.status === 'paid')
        return page('Bezahlt', `${head}<h1>Danke!</h1><p class="ok">Die Zahlung über ${escapeHtml(money(s.received_cents + s.gift_cents, s.currency))} ist eingegangen.</p><p class="muted">${escapeHtml(s.description)}</p>${s.meta.return_url ? `<p><a class="btn secondary" href="${escapeHtml(String(s.meta.return_url))}">Weiter</a></p>` : ''}`, color);
      if (s.status === 'pending') return page('In Bearbeitung', `${head}<h1>Danke!</h1><p>Deine Zahlung wird bearbeitet (z. B. eine Überweisung oder Lastschrift). Sobald sie bestätigt ist, bekommst du Bescheid.</p>`, color);
      if (s.status !== 'open') return page('Abgelaufen', `${head}<h1>Diese Zahlung ist abgelaufen</h1><p class="muted">Bitte starte den Vorgang noch einmal.</p>`, color, 410);
      const total = s.amount_cents + s.gift_cents;
      const gift = app.services.giftCards && !s.provider_ref;
      const providers = readyProviders(app, s.location_id);
      const buttons =
        s.amount_cents === 0
          ? `<form method="post" action="/pay/${s.id}/go"><input type="hidden" name="provider" value="${GIFT_PROVIDER}"><button type="submit" style="width:100%">Mit Gutschein bezahlen</button></form>`
          : providers.length
            ? providers
                .map(
                  (p) => `<form method="post" action="/pay/${s.id}/go" style="margin:0 0 10px"><input type="hidden" name="provider" value="${escapeHtml(p.id)}"><button type="submit" style="width:100%">Weiter mit ${escapeHtml(p.label)}</button><div class="muted" style="font-size:12px;margin-top:4px;text-align:center">${escapeHtml(p.methods(app, s.location_id).join(' · '))}</div></form>`,
                )
                .join('')
            : '<p class="error">Für diesen Betrag ist gerade keine Online-Zahlung eingerichtet.</p>';
      const body = `${head}<h1>Bezahlen</h1>
<p>${escapeHtml(s.description)}</p>
<table><tr><td>Betrag</td><td style="text-align:right">${escapeHtml(money(total, s.currency))}</td></tr>
${s.gift_cents ? `<tr><td>Gutschein</td><td style="text-align:right">−${escapeHtml(money(s.gift_cents, s.currency))}</td></tr>` : ''}
<tr><td><strong>Noch zu zahlen</strong></td><td style="text-align:right"><strong>${escapeHtml(money(s.amount_cents, s.currency))}</strong></td></tr></table>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
${gift ? `<form method="post" action="/pay/${s.id}/gift" style="margin:16px 0"><label for="gc">Gutscheincode</label><div class="row"><input id="gc" name="code" autocomplete="off" placeholder="XXXX-XXXX-XXXX-XXXX" maxlength="40"><button type="submit" class="btn secondary" style="flex:0 0 auto">Einlösen</button></div></form>` : ''}
<div style="margin-top:18px">${buttons}</div>`;
      return page('Bezahlen', body, color);
    }

    router.get('/pay/:id', 'public', (ctx) => {
      const s = getSession(app, ctx.params.id);
      if (!s) return notThere();
      const r = payPage(s, String(ctx.query.get('e') ?? '').slice(0, 200));
      r.headers['cache-control'] = 'no-store';
      return r;
    });
    router.post('/pay/:id/gift', 'public', (ctx) => {
      const s = getSession(app, ctx.params.id);
      if (!s) return notThere();
      if (throttled(`gift:${ctx.ip}`, 20)) return payPage(s, 'Zu viele Versuche – bitte in einer Stunde noch einmal.');
      try {
        applyGift(app, s, String(ctx.body?.code ?? ''));
      } catch (e) {
        return payPage(s, (e as Error).message);
      }
      return redirect(`/pay/${s.id}`, 303);
    });
    router.post('/pay/:id/go', 'public', async (ctx) => {
      const s = getSession(app, ctx.params.id);
      if (!s) return notThere();
      if (throttled(`go:${ctx.ip}`)) return payPage(s, 'Zu viele Versuche – bitte in ein paar Minuten noch einmal.');
      try {
        const r = await checkoutSession(app, s, String(ctx.body?.provider ?? ''));
        return redirect(r.settled ? back(getSession(app, s.id)!) : r.url, 303);
      } catch (e) {
        return payPage(getSession(app, s.id) ?? s, (e as Error).message);
      }
    });
    /** Back from the provider: ask it right away (the webhook may be slower or not set up), then on to where the payment belongs. */
    router.get('/pay/:id/return', 'public', async (ctx) => {
      let s = getSession(app, ctx.params.id);
      if (!s) return notThere();
      if (!throttled(`ret:${ctx.ip}`, 120)) s = await refreshSession(app, s).catch((e) => (console.error('[pay] return', (e as Error).message), s!));
      return redirect(s.status === 'paid' || s.status === 'pending' ? back(s) : `/pay/${s.id}`, 303);
    });
    router.get('/pay/:id/cancel', 'public', (ctx) => {
      const s = getSession(app, ctx.params.id);
      if (!s) return notThere();
      return redirect(String(s.meta.cancel_url || `/pay/${s.id}`), 303);
    });

    // --- invoices ---------------------------------------------------------------------------------------------------------------
    registerPayPurpose(app, 'invoice', {
      settle: (_a, s, received) => {
        const via = providerLabel(app, s.provider);
        if (s.gift_cents > 0 && s.gift_card_id) app.services.giftCards?.payInvoice(s.location_id, s.ref_id, s.gift_card_id, s.gift_cents, s.id);
        if (received > 0) bookInvoicePayment(app, s.location_id, s.ref_id, { amount: received, currency: s.currency, via, note: s.capture_ref || s.provider_ref });
      },
    });
    const payable = (inv: any) => inv && inv.kind === 'invoice' && inv.status === 'sent' && openCents(inv) >= MIN_CENTS;
    const inProgress = (inv: any) =>
      !!db.get(`SELECT 1 AS x FROM pay_sessions WHERE location_id = ? AND purpose = 'invoice' AND ref_id = ? AND status = 'pending' LIMIT 1`, inv.location_id, inv.id) ||
      !!db.get(`SELECT 1 AS x FROM stripe_checkouts WHERE invoice_id = ? AND status = 'pending' AND created_at > ? LIMIT 1`, inv.id, new Date(Date.now() - 21 * 864e5).toISOString());
    const prevPayHtml = app.services.invoicePayHtml as ((inv: any) => string) | undefined;
    app.services.invoicePayHtml = (inv: any) => {
      const base = prevPayHtml?.(inv) ?? '';
      if (!payable(inv) || inProgress(inv)) return base;
      const extra = others(inv.location_id);
      const gift = giftActive(inv.location_id);
      if (!extra.length && !gift && base) return base;
      if (!extra.length && !gift && !readyProviders(app, inv.location_id).length) return base;
      const what = [...(base ? [] : readyProviders(app, inv.location_id).filter((p) => p.id === 'stripe')), ...extra].map((p) => p.label);
      const label = base ? `Mit ${[...what, ...(gift ? ['Gutschein'] : [])].join(', ').replace(/, ([^,]*)$/, ' oder $1')} bezahlen` : 'Jetzt online bezahlen';
      return `${base}<form method="post" action="/i/${encodeURIComponent(inv.public_token)}/pay-options" class="noprint" style="margin:0 0 14px">
      <button type="submit" class="${base ? 'btn secondary' : ''}" style="width:100%;max-width:420px">${escapeHtml(label)}</button>
      <div class="muted" style="font-size:12px;margin-top:6px">${escapeHtml([...extra.flatMap((p) => p.methods(app, inv.location_id)), ...(gift ? ['Gutschein einlösen'] : [])].join(' · '))}</div></form>`;
    };
    router.post('/i/:token/pay-options', 'public', (ctx) => {
      const inv = parseJson(db.get<any>('SELECT * FROM invoices WHERE public_token = ?', ctx.params.token), ['items']);
      if (!inv || inv.status === 'draft') return page('Nicht gefunden', '<h1>Nicht gefunden</h1><p class="muted">Dieses Dokument gibt es nicht.</p>', undefined, 404);
      const backTo = `/i/${encodeURIComponent(inv.public_token)}`;
      if (!payable(inv)) return page('Online-Zahlung nicht möglich', `<h1>Online-Zahlung nicht möglich</h1><p class="muted">${inv.status === 'paid' ? 'Diese Rechnung ist schon bezahlt.' : 'Für diese Rechnung ist nichts (mehr) online zu bezahlen.'}</p><p><a class="btn secondary" href="${backTo}">Zurück</a></p>`);
      if (throttled(`inv:${ctx.ip}`)) return page('Bitte kurz warten', '<h1>Bitte kurz warten</h1><p class="muted">Zu viele Versuche – bitte in ein paar Minuten noch einmal.</p>', undefined, 429);
      const open = openCents(inv);
      const recent = db.get<{ id: string }>(
        `SELECT id FROM pay_sessions WHERE location_id = ? AND purpose = 'invoice' AND ref_id = ? AND status = 'open' AND amount_cents + gift_cents = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
        inv.location_id, inv.id, open, new Date(Date.now() - 30 * 60_000).toISOString(),
      );
      if (recent) return redirect(`/pay/${recent.id}`, 303);
      const contact = inv.contact_id ? getContact(app, inv.location_id, inv.contact_id) : undefined;
      const s = startSession(app, {
        locationId: inv.location_id,
        purpose: 'invoice',
        refId: inv.id,
        amountCents: open,
        currency: inv.currency,
        description: `${open < inv.total_cents ? 'Restbetrag ' : ''}Rechnung ${inv.number}`,
        email: contact?.email ?? '',
        name: [contact?.first_name, contact?.last_name].filter(Boolean).join(' '),
        returnUrl: `${app.baseUrl()}${backTo}`,
      });
      return redirect(`/pay/${s.id}`, 303);
    });

    // --- buy links: another provider chosen on /buy/<product> ---------------------------------------------------------------------
    app.services.buyPageHtml = [
      ...(app.services.buyPageHtml ?? []),
      (_ctx: Ctx, p: any) => {
        const extra = others(p.location_id);
        if (!extra.length || p.recurring) return '';
        const stripe = stripeProvider.ready(app, p.location_id);
        const opts = [...(stripe ? [stripeProvider] : []), ...extra];
        const radio = (id: string, label: string, sub: string, on: boolean) =>
          `<label class="check" style="margin:6px 0"><input type="radio" name="provider" value="${escapeHtml(id)}"${on ? ' checked' : ''}> <span><strong>${escapeHtml(label)}</strong><br><span class="muted" style="font-size:13px">${escapeHtml(sub)}</span></span></label>`;
        return `<fieldset style="border:0;padding:0;margin:16px 0 0"><legend style="font-weight:600;font-size:14px;margin:0 0 8px">Bezahlen mit</legend>${opts.map((o, i) => radio(o.id, o.id === 'stripe' ? 'Karte, SEPA, Apple Pay' : o.label, o.methods(app, p.location_id).join(' · '), i === 0)).join('')}</fieldset>`;
      },
    ];
    /** The buy page with another provider than Stripe: the same hooks (order bump, discount code) build the lines, the registry takes the money. */
    app.services.payBuy = async (ctx: Ctx, found: { p: any; link: any }, key: string): Promise<RawResult> => {
      const { p, link } = found;
      const self = `/buy/${encodeURIComponent(key)}`;
      const fail = (msg: string) => page('Kauf gerade nicht möglich', `<h1>Kauf gerade nicht möglich</h1><p class="muted">${escapeHtml(msg)}</p><p><a class="btn secondary" href="${escapeHtml(self)}">Zurück</a></p>`);
      const providerId = String(ctx.body?.provider ?? '');
      const prov = payProviders(app).get(providerId);
      if (!prov || !prov.ready(app, p.location_id)) return fail('Diese Zahlungsart ist nicht verfügbar');
      if (p.recurring) return fail('Abos lassen sich nur mit Karte oder SEPA (Stripe) abschließen');
      const sb = app.services.stripeBuy;
      try {
        const { tax, gross } = sb.grossOf(p);
        const email = normalizeEmail(ctx.body?.email ?? '');
        const meta: Record<string, any> = { location_id: p.location_id, product_id: p.id, product_name: String(p.name).slice(0, 200), price_cents: p.price_cents, tax_rate: tax, qty: 1, tag: sb.tagOf(p, link).slice(0, 200) };
        const params: Record<string, any> = { mode: 'payment', line_items: lineItemParams([{ name: p.name, unit_amount: gross, quantity: 1 }], p.currency), metadata: meta };
        for (const fn of app.services.buyCheckout ?? []) await fn(ctx, { product: p, link, params, meta, key });
        if (params.mode !== 'payment') return fail('Ratenzahlung gibt es nur mit Karte oder SEPA (Stripe)');
        const lines = (params.line_items as any[]).map((l) => ({ name: String(l.price_data?.product_data?.name ?? p.name), qty: Number(l.quantity) || 1, unit_cents: Number(l.price_data?.unit_amount ?? 0), tax_rate: Number(tax) || 0 }));
        const amount = lines.reduce((n, l) => n + l.qty * l.unit_cents, 0);
        if (amount < MIN_CENTS) return fail('Der Preis ist zu klein für eine Online-Zahlung');
        const s = startSession(app, { locationId: p.location_id, purpose: 'product', refId: p.id, amountCents: amount, currency: p.currency, description: String(p.name), email, lines, returnUrl: link?.redirect_url || '', cancelUrl: `${app.baseUrl()}${self}`, meta: { md: meta } });
        app.services.attribution?.checkout(ctx, p.location_id, s.id, ctx.body?._a);
        const r = await checkoutSession(app, s, providerId);
        return redirect(r.url, 303);
      } catch (e) {
        return fail(e instanceof HttpError ? e.message : (e as Error).message);
      }
    };
    app.services.buyPayNote = (p: any) => {
      const list = readyProviders(app, p.location_id);
      if (!list.some((x) => x.id !== 'stripe')) return undefined;
      return `Sichere Zahlung – ${[...new Set(list.flatMap((x) => x.methods(app, p.location_id)))].slice(0, 6).join(', ')} …`;
    };
    registerPayPurpose(app, 'product', {
      settle: (_a, s, received) =>
        app.services.stripeBuy?.completeProduct(
          s.location_id,
          { id: s.id, metadata: (s.meta.md as Record<string, unknown>) ?? {}, amount_total: received + s.gift_cents, currency: s.currency.toLowerCase(), customer_details: { email: s.meta.email, name: s.meta.name }, mode: 'payment', payment_intent: s.capture_ref || null },
          providerLabel(app, s.provider),
        ),
    });
  },
};
