import { createHmac } from 'node:crypto';
import { expect } from 'vitest';
import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';

/**
 * A fake Stripe for the cloud tests: products and prices, promotion codes, Checkout (with the trial and discount that
 * were asked for), subscriptions (change, cancel, trial end), the customer portal and invoices. Nothing leaves the process.
 * `complete(sessionId)` is what Stripe does when the customer finishes Checkout; `event()` builds a webhook payload.
 */

export const KEY = 'sk_test_51CloudKeyForTests00abcdwxyz';
export const WHSEC = 'whsec_cloudSigningSecretForTests0000';

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });

export interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  idem?: string;
}

export function createStripe() {
  const calls: Call[] = [];
  const store = {
    products: new Map<string, any>(),
    prices: new Map<string, any>(),
    sessions: new Map<string, any>(),
    subs: new Map<string, any>(),
    invoices: [] as any[],
    promos: new Map<string, string>([['WILLKOMMEN', 'promo_1']]),
  };
  let seq = 0;
  let fail: ((path: string, method: string) => boolean) | undefined;

  const meta = (params: URLSearchParams, prefix: string) => {
    const out: Record<string, string> = {};
    for (const [k, v] of params) if (k.startsWith(`${prefix}[`) && k.endsWith(']') && !k.slice(prefix.length + 1, -1).includes('[')) out[k.slice(prefix.length + 1, -1)] = v;
    return out;
  };

  const fetch = (async (url: string, init: any) => {
    const u = new URL(url);
    const params = new URLSearchParams(init.body ?? u.search.slice(1));
    calls.push({ method: init.method, path: u.pathname, params, idem: init.headers['idempotency-key'] });
    if (init.headers.authorization !== `Bearer ${KEY}`) return json({ error: { message: 'Invalid API Key provided' } }, 401);
    if (fail?.(u.pathname, init.method)) return json({ error: { message: 'Stripe ist gerade kaputt' } }, 500);
    const p = u.pathname;
    const m = init.method;
    if (p === '/v1/account') return json({ id: 'acct_cloud', settings: { dashboard: { display_name: 'Cloud Betreiber' } }, country: 'DE' });
    if (p === '/v1/products' && m === 'POST') {
      const prod = { id: `prod_${++seq}`, name: params.get('name'), active: params.get('active') !== 'false' };
      store.products.set(prod.id, prod);
      return json(prod);
    }
    if (p.startsWith('/v1/products/') && m === 'POST') {
      const prod = store.products.get(p.split('/').pop()!);
      Object.assign(prod, { name: params.get('name') ?? prod.name, active: params.get('active') !== 'false' });
      return json(prod);
    }
    if (p === '/v1/prices' && m === 'POST') {
      const price = { id: `price_${++seq}`, product: params.get('product'), unit_amount: Number(params.get('unit_amount')), currency: params.get('currency'), recurring: { interval: params.get('recurring[interval]') }, active: true, metadata: meta(params, 'metadata') };
      store.prices.set(price.id, price);
      return json(price);
    }
    if (p.startsWith('/v1/prices/') && m === 'POST') {
      const price = store.prices.get(p.split('/').pop()!);
      price.active = params.get('active') !== 'false';
      return json(price);
    }
    if (p === '/v1/promotion_codes') {
      const id = store.promos.get(String(params.get('code')));
      return json({ data: id ? [{ id, code: params.get('code'), active: true }] : [] });
    }
    if (p === '/v1/checkout/sessions' && m === 'POST') {
      const s = {
        id: `cs_test_${++seq}`,
        object: 'checkout.session',
        url: `https://checkout.stripe.com/c/pay/cs_test_${seq}`,
        mode: params.get('mode'),
        status: 'open',
        customer_email: params.get('customer_email'),
        customer_param: params.get('customer'),
        metadata: meta(params, 'metadata'),
        sub_meta: meta(params, 'subscription_data[metadata]'),
        trial: Number(params.get('subscription_data[trial_period_days]') ?? 0),
        trial_end: Number(params.get('subscription_data[trial_end]') ?? 0),
        price: params.get('line_items[0][price]'),
        promo: params.get('discounts[0][promotion_code]'),
        allow_promotion_codes: params.get('allow_promotion_codes'),
        automatic_tax: params.get('automatic_tax[enabled]'),
        tax_id_collection: params.get('tax_id_collection[enabled]'),
        billing_address_collection: params.get('billing_address_collection'),
        success_url: params.get('success_url'),
        cancel_url: params.get('cancel_url'),
        subscription: null as any,
        customer: null as any,
      };
      store.sessions.set(s.id, s);
      return json(s);
    }
    if (p.startsWith('/v1/checkout/sessions/')) {
      const s = store.sessions.get(decodeURIComponent(p.split('/').pop()!));
      if (!s) return json({ error: { message: 'No such checkout.session' } }, 404);
      const expand = params.get('expand[0]') === 'subscription';
      return json({ ...s, subscription: expand && s.subscription ? store.subs.get(s.subscription) : s.subscription });
    }
    if (p.startsWith('/v1/subscriptions/')) {
      const sub = store.subs.get(p.split('/').pop()!);
      if (!sub) return json({ error: { message: 'No such subscription' } }, 404);
      if (m === 'DELETE') sub.status = 'canceled';
      if (m === 'POST') {
        if (params.has('cancel_at_period_end')) sub.cancel_at_period_end = params.get('cancel_at_period_end') === 'true';
        if (params.has('items[0][price]')) {
          const price = store.prices.get(params.get('items[0][price]')!);
          sub.items.data[0].price = { id: price.id, recurring: { interval: price.recurring.interval } };
          sub.last_proration = params.get('proration_behavior');
        }
        if (params.has('trial_end')) sub.trial_end = Number(params.get('trial_end'));
        if (params.has('cancellation_details[comment]') || params.has('cancellation_details[feedback]')) sub.cancellation_details = { comment: params.get('cancellation_details[comment]'), feedback: params.get('cancellation_details[feedback]') };
      }
      return json(sub);
    }
    if (p === '/v1/billing_portal/sessions') return json({ id: 'bps_1', url: `https://billing.stripe.com/p/session/${params.get('customer')}` });
    if (p === '/v1/invoices') return json({ data: store.invoices.filter((i) => i.customer === params.get('customer')) });
    if (p === '/v1/invoiceitems') return json({ id: `ii_${++seq}` });
    return json({ error: { message: `unknown endpoint ${m} ${p}` } }, 404);
  }) as any;

  /** The customer finishes Checkout: subscription (trial or active) + completed session. */
  function complete(sessionId: string, o: { status?: string } = {}) {
    const s = store.sessions.get(sessionId);
    const subId = `sub_${++seq}`;
    const price = store.prices.get(s.price);
    const trialEnd = s.trial_end || (s.trial ? Math.floor(Date.now() / 1000) + s.trial * 86400 : 0);
    const sub = {
      id: subId,
      object: 'subscription',
      status: o.status ?? (trialEnd ? 'trialing' : 'active'),
      customer: s.customer_param || `cus_${seq}`,
      metadata: s.sub_meta,
      cancel_at_period_end: false,
      trial_end: trialEnd || null,
      items: { data: [{ id: `si_${seq}`, price: { id: price.id, recurring: { interval: price.recurring.interval } }, current_period_end: trialEnd || Math.floor(Date.now() / 1000) + 30 * 86400 }] },
    };
    store.subs.set(subId, sub);
    Object.assign(s, { status: 'complete', subscription: subId, customer: sub.customer });
    return { session: { ...s, subscription: sub }, sub };
  }

  const event = (type: string, object: any) => ({ id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type, data: { object } });
  const sign = (e: unknown, secret = WHSEC) => {
    const raw = JSON.stringify(e);
    return { raw, header: signStripePayload(raw, secret) };
  };
  const invoice = (customer: string, o: Partial<{ id: string; number: string; total: number; status: string; subscription: string }> = {}) => {
    const inv = { id: o.id ?? `in_${++seq}`, object: 'invoice', number: o.number ?? `INV-${seq}`, customer, subscription: o.subscription, total: o.total ?? 4900, currency: 'eur', status: o.status ?? 'paid', created: Math.floor(Date.now() / 1000), hosted_invoice_url: `https://invoice.stripe.com/i/${seq}`, invoice_pdf: `https://invoice.stripe.com/i/${seq}/pdf` };
    store.invoices.push(inv);
    return inv;
  };

  return {
    calls,
    store,
    fetch,
    complete,
    event,
    sign,
    invoice,
    install: () => setStripeFetch(fetch),
    uninstall: () => setStripeFetch(),
    failWhen: (fn?: (path: string, method: string) => boolean) => void (fail = fn),
    called: (method: string, path: string | RegExp) => calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path))),
    mac: (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex'),
  };
}

/** A browser with a cookie jar for all cookies (the signup binds to one), no redirects followed, form posts. */
export function browser(base: string, defaults: Record<string, string> = {}) {
  const jar = new Map<string, string>();
  async function req(method: string, path: string, o: { form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...defaults, ...(o.headers ?? {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body: string | undefined;
    if (o.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(o.form).toString();
    } else if (o.json !== undefined) {
      headers['content-type'] = 'application/json';
      headers['x-pghl'] = '1';
      body = JSON.stringify(o.json);
    } else if (method !== 'GET') headers['x-pghl'] = '1';
    const r = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = decodeURIComponent(pair.slice(i + 1));
      if (!value || /Max-Age=0/i.test(c)) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await r.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, text, data, headers: r.headers, location: r.headers.get('location') ?? '' };
  }
  const api = (method: string, path: string, json?: unknown, headers?: Record<string, string>) => req(method, path, { json, headers });
  return {
    jar,
    get: (path: string, headers?: Record<string, string>) => req('GET', path, { headers }),
    form: (path: string, form: Record<string, string>) => req('POST', path, { form }),
    api,
    cookie: (name: string) => jar.get(name),
  };
}

/** Sign-up helpers shared by the cloud tests: the webhook, the whole way in through the form, a paid and logged-in customer. */
export function cloudKit(app: () => { base: string; api: { raw: (p: string, i?: RequestInit) => Promise<Response> }; app: any }, stripe: ReturnType<typeof createStripe>, mails: { to: string; subject: string; text: string; html: string }[]) {
  const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');
  const lastMail = (to: string, re: RegExp) => [...mails].reverse().find((m) => m.to === to && re.test(m.subject));
  const hook = async (e: any) => {
    const { raw, header } = stripe.sign(e);
    const r = await app().api.raw('/hooks/stripe-agency', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: raw });
    return { status: r.status, data: await r.json() };
  };
  async function signUp(o: { plan?: string; interval?: string; company: string; email: string; name?: string; password?: string; coupon?: string }) {
    const b = browser(app().base);
    const page = await b.get(`/start?plan=${o.plan ?? 'team'}`);
    const tok = /name="t" value="([^"]+)"/.exec(page.text)![1];
    const r = await b.form('/start', { plan: o.plan ?? 'team', interval: o.interval ?? 'month', company: o.company, name: o.name ?? 'Mia Muster', email: o.email, password: o.password ?? 'geheim1234', agb: '1', avv: '1', datenschutz: '1', business: '1', t: tok, via: 'email', ...(o.coupon ? { coupon: o.coupon } : {}) });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const mail = lastMail(o.email, /bestätige/i)!;
    expect(mail, 'Bestätigungs-Mail').toBeTruthy();
    const link = path(/(https?:\/\/\S+\/start\/verify\/\S+)/.exec(mail.text)![1]);
    return { b, link };
  }
  /** A customer who signed up, paid (trial) through the fake Stripe and is logged in. */
  async function createCustomer(o: { plan?: string; interval?: string; company: string; email: string; password?: string }) {
    const { b, link } = await signUp(o);
    const go = await b.form(link, {});
    expect(go.status, go.text.slice(0, 200)).toBe(303);
    const sid = go.location.split('/').pop()!;
    const { sub } = stripe.complete(sid);
    const done = await b.get(`/start/done?session_id=${sid}`);
    expect(done.location).toBe('/app');
    const me = (await b.api('GET', '/api/me')).data;
    const cloud = (await b.api('GET', '/api/cloud/me')).data;
    return { b, sub, sid, loc: me.locations[0].id as string, tenantId: cloud.tenant.id as string, userId: me.user.id as string, h: { 'x-location-id': me.locations[0].id as string } };
  }
  return { hook, signUp, createCustomer, path, lastMail };
}

/** A browser as the `Call` the security fixtures use (method, path, body, headers). */
export function asCall(b: ReturnType<typeof browser>) {
  return async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const r = await b.api(method, path, body, headers);
    return { status: r.status, text: r.text, data: r.data, headers: r.headers };
  };
}
