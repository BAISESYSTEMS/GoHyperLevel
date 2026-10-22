import type { Ctx, RawResult } from '../core/http.js';
import { html, notFound, redirect } from '../core/http.js';
import type { Module } from '../core/app.js';
import { escapeHtml } from '../core/template.js';
import { now } from '../core/util.js';
import { getContact, logActivity } from '../services/contacts.js';
import { auditLog, clip, limiter, money, openToken, purchaseTag, setPurchaseAccess, signToken, stripeCall, stripeKeyOf } from '../services/creator-kit.js';
import { planLabel } from '../services/creator-plans.js';
import { creditClosed, openCents } from '../services/invoice-model.js';

/**
 * The hosted billing page for subscribers (/abo/<signed link>): see the subscriptions and instalment plans, update the card
 * (Stripe Billing Portal or a Checkout session in setup mode – the card then becomes the default and open invoices are paid),
 * see the invoices, and – only where the product's settings allow it – pause, cancel or switch. The link is signed
 * (HMAC, expires), needs no login and never exposes another contact's data. Docs: docs/dunning.md.
 */

const BILLING = 'billing';
const POST_LIMIT = limiter(40, 10 * 60_000);
const GET_LIMIT = limiter(240, 10 * 60_000);

const MESSAGES: Record<string, [string, 'ok' | 'err']> = {
  card_ok: ['Danke! Deine neue Zahlungsmethode ist gespeichert. Offene Beträge werden jetzt eingezogen.', 'ok'],
  card_wait: ['Danke! Wir speichern deine Zahlungsmethode gerade – das dauert einen Moment.', 'ok'],
  paused: ['Dein Abo ist pausiert. Du wirst bis zur Fortsetzung nicht belastet.', 'ok'],
  resumed: ['Dein Abo läuft wieder.', 'ok'],
  canceled: ['Dein Abo ist gekündigt.', 'ok'],
  uncanceled: ['Die Kündigung ist zurückgenommen – dein Abo läuft weiter.', 'ok'],
  switched: ['Dein Tarif wurde gewechselt. Anteilige Beträge werden mit der nächsten Rechnung verrechnet.', 'ok'],
  denied: ['Das ist für dieses Abo nicht vorgesehen.', 'err'],
  failed: ['Das hat gerade nicht geklappt. Bitte versuche es später noch einmal oder melde dich bei uns.', 'err'],
  throttled: ['Zu viele Versuche – bitte in ein paar Minuten noch einmal.', 'err'],
};

const CSS = `
:root{--brand:#2563eb;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f6f7fb;--panel:#fff;--ok:#047857;--err:#b91c1c;--warn:#b45309;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--text:#e5e7eb;--muted:#94a3b8;--line:#1e293b;--bg:#0b1020;--panel:#111a2e;--ok:#34d399;--err:#f87171;--warn:#fbbf24;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--bg)}
.wrap{max-width:860px;margin:0 auto;padding:24px 16px 64px}.brand{display:flex;align-items:center;gap:12px;margin:0 0 20px;font-weight:700}.brand img{max-height:40px;max-width:180px}
h1{font-size:clamp(24px,4vw,32px);margin:0 0 4px}h2{font-size:19px;margin:28px 0 10px}.muted{color:var(--muted)}.small{font-size:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px;margin:0 0 14px}
.alert{border-radius:12px;padding:14px 16px;margin:0 0 16px;font-weight:600}.alert.ok{background:rgba(4,120,87,.12);color:var(--ok)}.alert.err{background:rgba(185,28,28,.12);color:var(--err)}.alert.warn{background:rgba(180,83,9,.14);color:var(--warn)}
.top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start}.pill{display:inline-block;border-radius:99px;padding:3px 11px;font-size:13px;font-weight:600;background:rgba(100,116,139,.15)}.pill.ok{background:rgba(4,120,87,.14);color:var(--ok)}.pill.err{background:rgba(185,28,28,.14);color:var(--err)}.pill.warn{background:rgba(180,83,9,.16);color:var(--warn)}
.acts{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.acts form{margin:0}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 20px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button.primary,.btn.primary{background:var(--brand);border-color:transparent;color:#fff}button.danger{color:var(--err)}button:hover,.btn:hover{filter:brightness(1.06)}button:focus-visible,.btn:focus-visible,select:focus-visible{outline:3px solid var(--brand);outline-offset:2px}
select{min-height:48px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit;padding:0 12px}
table{width:100%;border-collapse:collapse}td,th{padding:12px 8px;border-bottom:1px solid var(--line);text-align:left;font-size:15px}th{color:var(--muted);font-weight:600}.num{text-align:right;white-space:nowrap}
a{color:var(--brand)}@media (max-width:560px){.wrap{padding:16px 12px 48px}.acts>*{flex:1 1 100%}.acts button,.acts select{width:100%}}
`;

interface View {
  id: string;
  name: string;
  plan?: { label: string; paid: number; of: number; access: string; status: string };
  status: string;
  label: string;
  tone: 'ok' | 'warn' | 'err' | '';
  next?: string;
  amount?: string;
  paused: boolean;
  cancelling: string;
  open: boolean;
  allow: { pause: boolean; cancel: boolean; cancelNow: boolean; switch: { id: string; name: string; price: string }[] };
}

export const dunningBillingModule: Module = {
  name: 'dunning-billing',
  register(app) {
    const { db, router } = app;

    const loc = (token: string) => {
      const p = openToken<{ l: string; c: string }>(app, BILLING, token);
      if (!p) return undefined;
      const contact = getContact(app, p.l, p.c);
      const location = app.location(p.l);
      return contact && location ? { p, contact, location } : undefined;
    };

    const sameOrigin = (ctx: Ctx) => {
      const o = ctx.req.headers.origin;
      if (ctx.req.headers['sec-fetch-site'] === 'same-origin' && (!o || o === 'null')) return true;
      if (!o || o === 'null') return !o;
      try {
        return new URL(String(o)).host === String(ctx.req.headers.host ?? '');
      } catch {
        return false;
      }
    };

    const frame = (location: any, body: string, status = 200): RawResult => {
      const brand = location.settings?.branding ?? {};
      const color = /^#[0-9a-f]{6}$/i.test(brand.color ?? '') ? brand.color : '#2563eb';
      const name = brand.name || location.name;
      const logo = brand.logo_url || location.logo_url || '';
      const r = html(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Abo &amp; Rechnungen · ${escapeHtml(name)}</title>
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><style>${CSS}:root{--brand:${color}}</style></head><body><div class="wrap">
<div class="brand">${logo ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(name)}">` : `<span>${escapeHtml(name)}</span>`}</div>${body}</div></body></html>`, status);
      Object.assign(r.headers, { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
      return r;
    };
    const gone = () =>
      html('<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link abgelaufen</title><body style="font-family:system-ui;padding:40px 16px;max-width:520px;margin:0 auto;text-align:center"><h1>Dieser Link ist abgelaufen</h1><p style="color:#64748b">Bitte fordere bei uns einen neuen Link zur Abo-Verwaltung an.</p></body></html>', 410);

    // --- what the person has ----------------------------------------------------------------------------------------
    const subscriptionIds = (l: string, contactId: string) => {
      const plans = db.all<any>('SELECT * FROM plan_subscriptions WHERE location_id = ? AND contact_id = ?', l, contactId);
      const planIds = new Set(plans.map((p) => p.stripe_subscription));
      const subs = db
        .all<any>(`SELECT subscription, product_id, meta FROM stripe_checkouts WHERE location_id = ? AND contact_id = ? AND kind = 'product' AND subscription IS NOT NULL AND subscription != '' ORDER BY created_at DESC`, l, contactId)
        .filter((s) => !planIds.has(s.subscription));
      return { plans, subs };
    };

    async function views(l: string, contactId: string): Promise<View[]> {
      const { plans, subs } = subscriptionIds(l, contactId);
      const connected = !!stripeKeyOf(app, l);
      const live = async (id: string): Promise<any | null> => {
        if (!connected) return null;
        try {
          return await stripeCall(app, l, 'GET', `/v1/subscriptions/${encodeURIComponent(id)}`);
        } catch {
          return null;
        }
      };
      const out: View[] = [];
      const caseOf = (id: string) => db.get<any>(`SELECT id FROM dunning_cases WHERE location_id = ? AND stripe_subscription = ? AND status IN ('open', 'failed') ORDER BY created_at DESC LIMIT 1`, l, id);
      const info = (s: any, base: Partial<View> & { id: string; name: string }): View => {
        const item = s?.items?.data?.[0];
        const end = Number(s?.current_period_end ?? item?.current_period_end ?? 0);
        const unit = Number(item?.price?.unit_amount ?? 0) * Number(item?.quantity ?? 1);
        const cancelAt = s?.cancel_at ? new Date(Number(s.cancel_at) * 1000).toISOString() : s?.cancel_at_period_end && end ? new Date(end * 1000).toISOString() : '';
        const paused = !!s?.pause_collection;
        const status = String(s?.status ?? '');
        const open = !!caseOf(base.id) || status === 'past_due' || status === 'unpaid';
        let label = 'Aktiv';
        let tone: View['tone'] = 'ok';
        if (!s) (label = 'Status nicht abrufbar'), (tone = '');
        else if (status === 'canceled') (label = 'Beendet'), (tone = '');
        else if (open) (label = 'Zahlung offen'), (tone = 'err');
        else if (paused) (label = 'Pausiert'), (tone = 'warn');
        else if (cancelAt) (label = 'Gekündigt'), (tone = 'warn');
        return { status, label, tone, next: end && !cancelAt && !paused && status !== 'canceled' ? new Date(end * 1000).toISOString() : '', amount: unit ? money(unit, String(item?.price?.currency ?? 'EUR')) : '', paused, cancelling: cancelAt, open, allow: { pause: false, cancel: false, cancelNow: false, switch: [] }, ...base } as View;
      };
      for (const p of plans) {
        const s = await live(p.stripe_subscription);
        const name = db.get<any>('SELECT name FROM products WHERE id = ?', p.product_id)?.name ?? p.plan_name;
        const v = info(s, { id: p.stripe_subscription, name, plan: { label: p.plan_name || planLabel(p, p.currency), paid: p.paid_count, of: p.installments, access: p.access, status: p.status } });
        if (p.status === 'completed') Object.assign(v, { label: 'Abbezahlt', tone: 'ok', next: '', open: false, cancelling: '' });
        out.push(v);
      }
      const seen = new Set<string>();
      for (const sub of subs) {
        if (seen.has(sub.subscription)) continue;
        seen.add(sub.subscription);
        const p = db.get<any>('SELECT * FROM products WHERE id = ? AND location_id = ?', sub.product_id, l);
        const s = await live(sub.subscription);
        const v = info(s, { id: sub.subscription, name: p?.name ?? 'Abo' });
        const ps = app.services.dunning.productSettings(l, sub.product_id);
        v.allow = {
          pause: ps.allow_pause && !!s && v.status !== 'canceled',
          cancel: ps.allow_cancel && !!s && v.status !== 'canceled',
          cancelNow: ps.cancel_mode === 'now',
          switch: s && v.status !== 'canceled' ? ps.switch_to.map((id: string) => db.get<any>('SELECT * FROM products WHERE id = ? AND location_id = ? AND active = 1 AND recurring IS NOT NULL', id, l)).filter(Boolean).map((t: any) => ({ id: t.id, name: t.name, price: `${money(app.services.stripeBuy?.grossOf(t).gross ?? t.price_cents, t.currency)} / ${t.recurring === 'year' ? 'Jahr' : 'Monat'}` })) : [],
        };
        out.push(v);
      }
      return out;
    }

    const invoicesOf = (l: string, contactId: string) =>
      db.all<any>(
        `SELECT id, kind, number, title, total_cents, paid_cents, credited_cents, deducted_cents, currency, status, finalised_at, storno_id, issued_at, due_at, public_token
         FROM invoices WHERE location_id = ? AND contact_id = ? AND kind = 'invoice' AND status != 'draft' ORDER BY issued_at DESC LIMIT 50`,
        l,
        contactId,
      );
    /** The amount column: the total, and what is still open when a payment, a credit note or a deducted partial invoice took part of it. */
    const invoiceState = (i: any) => {
      const open = i.status === 'sent' ? openCents(i) : 0;
      const pill =
        i.status === 'paid' ? '<span class="pill ok">bezahlt</span>'
        : i.status === 'void' ? `<span class="pill">${creditClosed(i) ? 'gutgeschrieben' : 'storniert'}</span>`
        : open > 0 ? '<span class="pill warn">offen</span>'
        : '<span class="pill ok">ausgeglichen</span>';
      const amount = `${escapeHtml(money(i.total_cents, i.currency))}${open > 0 && open < i.total_cents ? `<div class="muted small">offen ${escapeHtml(money(open, i.currency))}</div>` : ''}`;
      return { pill, amount };
    };

    const dateDe = (iso: string, tz: string) => (iso ? new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz }).format(new Date(iso)) : '');

    async function page(token: string, msg = ''): Promise<RawResult> {
      const f = loc(token);
      if (!f) return gone();
      const { contact, location, p } = f;
      const tz = location.timezone || 'Europe/Berlin';
      const list = await views(p.l, contact.id);
      const m = MESSAGES[msg];
      const hasOpen = list.some((v) => v.open);
      const base = `/abo/${encodeURIComponent(token)}`;
      const form = (action: string, sub: string, label: string, cls = '', extra = '') => `<form method="post" action="${base}/${action}"><input type="hidden" name="sub" value="${escapeHtml(sub)}">${extra}<button class="${cls}">${escapeHtml(label)}</button></form>`;
      const cards = list
        .map((v) => {
          const acts = [form('card', v.id, v.open ? 'Zahlungsmethode jetzt aktualisieren' : 'Zahlungsmethode ändern', v.open ? 'primary' : '')];
          if (v.status !== 'canceled' && !v.plan) {
            if (v.allow.pause) acts.push(v.paused ? form('resume', v.id, 'Abo fortsetzen') : form('pause', v.id, 'Abo pausieren'));
            if (v.allow.switch.length) acts.push(`<form method="post" action="${base}/switch"><input type="hidden" name="sub" value="${escapeHtml(v.id)}"><select name="product" aria-label="Neuer Tarif">${v.allow.switch.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)} – ${escapeHtml(o.price)}</option>`).join('')}</select> <button>Tarif wechseln</button></form>`);
            if (v.cancelling && v.allow.cancel) acts.push(form('uncancel', v.id, 'Kündigung zurücknehmen'));
            else if (v.allow.cancel) acts.push(form('cancel', v.id, v.allow.cancelNow ? 'Sofort kündigen' : 'Zum Laufzeitende kündigen', 'danger'));
          }
          const meta = [
            v.plan ? `Ratenzahlung: ${v.plan.label} – ${v.plan.paid} von ${v.plan.of} Raten bezahlt` : '',
            v.amount ? `${v.amount} je Abrechnung` : '',
            v.next ? `Nächste Zahlung am ${dateDe(v.next, tz)}` : '',
            v.cancelling ? `Endet am ${dateDe(v.cancelling, tz)}` : '',
          ].filter(Boolean);
          return `<section class="card"><div class="top"><div><h2 style="margin:0">${escapeHtml(v.name)}</h2>${meta.map((x) => `<div class="muted small">${escapeHtml(x)}</div>`).join('')}</div><span class="pill ${v.tone}">${escapeHtml(v.label)}</span></div>${v.status === 'canceled' && !v.plan ? '' : `<div class="acts">${acts.join('')}</div>`}</section>`;
        })
        .join('');
      const inv = invoicesOf(p.l, contact.id);
      const invRows = inv
        .map((i) => {
          const s = invoiceState(i);
          return `<tr><td><a href="${app.baseUrl()}/i/${encodeURIComponent(i.public_token)}" target="_blank" rel="noopener">${escapeHtml(i.number)}</a><div class="muted small">${escapeHtml(i.title ?? '')}</div></td><td>${escapeHtml(dateDe(i.issued_at, tz))}</td><td class="num">${s.amount}</td><td>${s.pill}</td></tr>`;
        })
        .join('');
      const body = `<h1>Abo &amp; Rechnungen</h1><p class="muted">Hallo ${escapeHtml(contact.first_name || contact.email || '')}, hier verwaltest du deine Zahlungen bei ${escapeHtml(location.settings?.branding?.name || location.name)}.</p>
${m ? `<div class="alert ${m[1]}" role="status">${escapeHtml(m[0])}</div>` : ''}${hasOpen && !m ? '<div class="alert err" role="alert">Eine Zahlung ist fehlgeschlagen. Bitte aktualisiere deine Zahlungsmethode – meist ist es eine abgelaufene Karte.</div>' : ''}
${cards || '<div class="card"><p class="muted" style="margin:0">Es gibt kein Abo und keine Ratenzahlung für diese E-Mail-Adresse.</p></div>'}
<h2>Rechnungen</h2>${invRows ? `<div class="card" style="padding:6px 16px"><table><thead><tr><th>Rechnung</th><th>Datum</th><th class="num">Betrag</th><th>Status</th></tr></thead><tbody>${invRows}</tbody></table></div>` : '<p class="muted">Noch keine Rechnungen.</p>'}
${location.email ? `<p class="muted small">Fragen? <a href="mailto:${escapeHtml(location.email)}">${escapeHtml(location.email)}</a></p>` : ''}`;
      return frame(location, body);
    }

    router.get('/abo/:token', 'public', async (ctx) => {
      if (GET_LIMIT(ctx.ip)) return html('Zu viele Anfragen', 429);
      const m = String(ctx.query.get('m') ?? '');
      return page(ctx.params.token, MESSAGES[m] ? m : '');
    });

    // --- card update -------------------------------------------------------------------------------------------------------
    const ownedSub = (l: string, contactId: string, subId: string) => {
      const { plans, subs } = subscriptionIds(l, contactId);
      return plans.some((p) => p.stripe_subscription === subId) || subs.some((s) => s.subscription === subId);
    };
    const back = (token: string, code: string) => redirect(`/abo/${encodeURIComponent(token)}?m=${code}`, 303);

    /** The card from a finished setup session becomes the default of the customer and the subscription; open invoices are paid. */
    async function applyNewCard(l: string, sessionId: string): Promise<boolean> {
      if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return false;
      const claim = db.run('INSERT OR IGNORE INTO dunning_card_updates (session_id, location_id, subscription, at) VALUES (?, ?, ?, ?)', sessionId, l, '', now()).changes;
      if (!claim) return false;
      const s = await stripeCall<any>(app, l, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { 'expand[]': 'setup_intent' });
      if (s.metadata?.location_id !== l || s.metadata?.purpose !== 'card_update' || s.mode !== 'setup') return false;
      const si = typeof s.setup_intent === 'object' ? s.setup_intent : null;
      const pm = String(si?.payment_method ?? '');
      const customer = String(s.customer ?? '');
      const subId = String(s.metadata.subscription_id ?? '');
      if (!pm || !customer || !subId) return false;
      db.run('UPDATE dunning_card_updates SET subscription = ? WHERE session_id = ?', subId, sessionId);
      await stripeCall(app, l, 'POST', `/v1/customers/${encodeURIComponent(customer)}`, { invoice_settings: { default_payment_method: pm } });
      await stripeCall(app, l, 'POST', `/v1/subscriptions/${encodeURIComponent(subId)}`, { default_payment_method: pm });
      const open = await stripeCall<any>(app, l, 'GET', '/v1/invoices', { subscription: subId, status: 'open', limit: 5 }).catch(() => ({ data: [] }));
      for (const inv of open.data ?? []) await stripeCall(app, l, 'POST', `/v1/invoices/${encodeURIComponent(inv.id)}/pay`, {}, { idempotencyKey: `card-update-pay-${sessionId}-${inv.id}` }).catch(() => undefined);
      const contactId = String(s.metadata.contact_id ?? '');
      if (contactId) logActivity(app, l, contactId, 'billing.card_updated', 'Zahlungsmethode über die Abo-Verwaltung aktualisiert');
      const c = db.get<any>(`SELECT id FROM dunning_cases WHERE location_id = ? AND stripe_subscription = ? AND status IN ('open','failed') ORDER BY created_at DESC LIMIT 1`, l, subId);
      if (c) app.services.dunning.caseEvent({ id: c.id, location_id: l }, 'card_updated', 'Neue Zahlungsmethode gespeichert');
      auditLog(app, undefined, l, 'billing.card_updated', 'Zahlungsmethode aktualisiert (Abo-Verwaltung)', subId, 'Kunde');
      return true;
    }
    app.services.billingPage = { applyNewCard };

    const post = (name: string, handler: (f: NonNullable<ReturnType<typeof loc>>, ctx: Ctx, subId: string) => Promise<string>) =>
      router.post(`/abo/:token/${name}`, 'public', async (ctx) => {
        const f = loc(ctx.params.token);
        if (!f) return gone();
        if (!sameOrigin(ctx)) return back(ctx.params.token, 'failed');
        if (POST_LIMIT(ctx.ip)) return back(ctx.params.token, 'throttled');
        const subId = clip(ctx.body?.sub, 80);
        if (!/^sub_[A-Za-z0-9_]+$/.test(subId) || !ownedSub(f.p.l, f.contact.id, subId)) return back(ctx.params.token, 'denied');
        try {
          const r = await handler(f, ctx, subId);
          // Stripe's own pages: go there; otherwise show the page again with a message.
          return /^https:\/\//.test(r) ? redirect(r, 303) : back(ctx.params.token, r);
        } catch (e) {
          console.error(`[billing] ${name}`, (e as Error).message);
          return back(ctx.params.token, 'failed');
        }
      });

    post('card', async ({ p, contact }, ctx, subId) => {
      const l = p.l;
      const sub = await stripeCall<any>(app, l, 'GET', `/v1/subscriptions/${encodeURIComponent(subId)}`);
      const customer = String(typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? '');
      if (!customer) return 'failed';
      const token = ctx.params.token;
      const base = `${app.baseUrl()}/abo/${encodeURIComponent(token)}`;
      const method = app.services.dunning.settings(l).sub.billing_method;
      if (method === 'portal') {
        try {
          const s = await stripeCall<any>(app, l, 'POST', '/v1/billing_portal/sessions', { customer, return_url: base });
          if (s?.url) return String(s.url);
        } catch {
          /* no portal configuration in Stripe: the setup session below does the job */
        }
      }
      const meta = { location_id: l, purpose: 'card_update', subscription_id: subId, contact_id: contact.id };
      const s = await stripeCall<any>(app, l, 'POST', '/v1/checkout/sessions', {
        mode: 'setup',
        customer,
        currency: String(sub.currency ?? sub.items?.data?.[0]?.price?.currency ?? 'eur').toLowerCase(),
        success_url: `${base}/karte?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: base,
        metadata: meta,
        setup_intent_data: { metadata: meta },
      });
      return s?.url ? String(s.url) : 'failed';
    });
    router.get('/abo/:token/karte', 'public', async (ctx) => {
      const f = loc(ctx.params.token);
      if (!f) return gone();
      const sid = String(ctx.query.get('session_id') ?? '');
      let code = 'card_wait';
      try {
        if (await applyNewCard(f.p.l, sid)) code = 'card_ok';
        else if (db.get('SELECT 1 FROM dunning_card_updates WHERE session_id = ?', sid)) code = 'card_ok';
      } catch (e) {
        console.error('[billing] Karte', (e as Error).message);
        code = 'failed';
      }
      return back(ctx.params.token, code);
    });

    // --- pause, resume, cancel, switch (only as far as the product allows) ---------------------------------------------------
    const productOf = (l: string, subId: string) => {
      const row = db.get<any>(`SELECT product_id FROM stripe_checkouts WHERE location_id = ? AND subscription = ? AND kind = 'product' ORDER BY created_at LIMIT 1`, l, subId);
      return row ? { id: String(row.product_id), settings: app.services.dunning.productSettings(l, row.product_id) } : undefined;
    };
    const guarded = (l: string, subId: string, what: 'pause' | 'cancel') => {
      const pr = productOf(l, subId);
      if (!pr) return undefined;
      return (what === 'pause' ? pr.settings.allow_pause : pr.settings.allow_cancel) ? pr : undefined;
    };
    const note = (f: { p: { l: string }; contact: { id: string } }, action: string, summary: string, subId: string) => {
      logActivity(app, f.p.l, f.contact.id, `billing.${action}`, summary);
      auditLog(app, undefined, f.p.l, `billing.${action}`, summary, subId, 'Kunde');
    };

    post('pause', async (f, _ctx, subId) => {
      if (!guarded(f.p.l, subId, 'pause')) return 'denied';
      await stripeCall(app, f.p.l, 'POST', `/v1/subscriptions/${encodeURIComponent(subId)}`, { pause_collection: { behavior: 'void' } });
      note(f, 'paused', 'Abo über die Abo-Verwaltung pausiert', subId);
      return 'paused';
    });
    post('resume', async (f, _ctx, subId) => {
      if (!guarded(f.p.l, subId, 'pause')) return 'denied';
      await stripeCall(app, f.p.l, 'POST', `/v1/subscriptions/${encodeURIComponent(subId)}`, { pause_collection: '' });
      note(f, 'resumed', 'Abo über die Abo-Verwaltung fortgesetzt', subId);
      return 'resumed';
    });
    post('cancel', async (f, _ctx, subId) => {
      const pr = guarded(f.p.l, subId, 'cancel');
      if (!pr) return 'denied';
      if (pr.settings.cancel_mode === 'now') await stripeCall(app, f.p.l, 'DELETE', `/v1/subscriptions/${encodeURIComponent(subId)}`);
      else await stripeCall(app, f.p.l, 'POST', `/v1/subscriptions/${encodeURIComponent(subId)}`, { cancel_at_period_end: true });
      note(f, 'canceled', `Abo über die Abo-Verwaltung gekündigt (${pr.settings.cancel_mode === 'now' ? 'sofort' : 'zum Laufzeitende'})`, subId);
      app.events.emit(f.p.l, 'billing.cancel_requested', { contactId: f.contact.id, subscription: subId, productId: pr.id, immediate: pr.settings.cancel_mode === 'now' });
      return 'canceled';
    });
    post('uncancel', async (f, _ctx, subId) => {
      if (!guarded(f.p.l, subId, 'cancel')) return 'denied';
      await stripeCall(app, f.p.l, 'POST', `/v1/subscriptions/${encodeURIComponent(subId)}`, { cancel_at_period_end: false, cancel_at: '' });
      note(f, 'uncanceled', 'Kündigung über die Abo-Verwaltung zurückgenommen', subId);
      return 'uncanceled';
    });
    post('switch', async (f, ctx, subId) => {
      const pr = productOf(f.p.l, subId);
      const targetId = clip(ctx.body?.product, 40);
      if (!pr || !pr.settings.switch_to.includes(targetId)) return 'denied';
      const target = db.get<any>('SELECT * FROM products WHERE id = ? AND location_id = ? AND active = 1 AND recurring IS NOT NULL', targetId, f.p.l);
      const sb = app.services.stripeBuy;
      if (!target || !sb) return 'denied';
      const sub = await stripeCall<any>(app, f.p.l, 'GET', `/v1/subscriptions/${encodeURIComponent(subId)}`);
      const item = sub.items?.data?.[0];
      if (!item?.id) return 'failed';
      const { tax, gross } = sb.grossOf(target);
      const tag = purchaseTag(app, f.p.l, target.id);
      await stripeCall(
        app,
        f.p.l,
        'POST',
        `/v1/subscriptions/${encodeURIComponent(subId)}`,
        {
          items: [{ id: item.id, price_data: { currency: String(target.currency).toLowerCase(), unit_amount: gross, product_data: { name: String(target.name).slice(0, 250) }, recurring: { interval: target.recurring } } }],
          proration_behavior: 'create_prorations',
          metadata: { product_id: target.id, product_name: String(target.name).slice(0, 200), price_cents: target.price_cents, tax_rate: tax, tag: tag.slice(0, 200) },
        },
        { idempotencyKey: `switch-${subId}-${target.id}-${Math.floor(Date.now() / 60_000)}` },
      );
      // The access follows the product: the old purchase tag goes, the new one comes.
      const oldTag = purchaseTag(app, f.p.l, pr.id);
      if (oldTag && oldTag !== tag) setPurchaseAccess(app, f.p.l, f.contact.id, pr.id, oldTag, false, 'Tarif gewechselt');
      setPurchaseAccess(app, f.p.l, f.contact.id, target.id, tag, true, 'Tarif gewechselt');
      db.run(`UPDATE stripe_checkouts SET product_id = ? WHERE location_id = ? AND subscription = ? AND kind = 'product'`, target.id, f.p.l, subId);
      note(f, 'switched', `Tarif über die Abo-Verwaltung gewechselt zu „${target.name}“`, subId);
      app.events.emit(f.p.l, 'billing.plan_switched', { contactId: f.contact.id, subscription: subId, fromProductId: pr.id, productId: target.id, product: { id: target.id, name: target.name } });
      return 'switched';
    });

    // --- link from the member area ---------------------------------------------------------------------------------------------
    const hasBilling = (l: string, contactId: string) => !!db.get('SELECT 1 FROM plan_subscriptions WHERE location_id = ? AND contact_id = ? UNION SELECT 1 FROM stripe_checkouts WHERE location_id = ? AND contact_id = ? AND kind = \'product\' AND subscription IS NOT NULL AND subscription != \'\' LIMIT 1', l, contactId, l, contactId);
    app.services.portalHeader = [
      ...(app.services.portalHeader ?? []),
      (p: any, m: any) => (hasBilling(p.locationId, m.contact.id) ? `<a href="${p.base}/abo" style="font-size:14px">Abo &amp; Rechnungen</a>` : ''),
    ];
    router.get('/portal/:p/abo', 'public', (ctx) => {
      const kit = app.services.portalKit;
      const p = kit?.resolve(ctx.params.p);
      if (!p) return kit?.unknownPortal() ?? notFound();
      const m = kit.memberOf(ctx, p);
      if (!m) return redirect(p.base, 303);
      return redirect(`/abo/${signToken(app, BILLING, { l: p.locationId, c: m.contact.id }, 60 * 60_000)}`, 303);
    });
  },
};
