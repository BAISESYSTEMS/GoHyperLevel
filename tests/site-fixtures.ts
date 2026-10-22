import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';

/** Shared bits of the website-builder tests: a fake Stripe, a paid Checkout, and the seeds of the isolation harness. */

export const KEY = 'sk_test_51FakeKeyForTests000abcd';
export const WHSEC = 'whsec_testSigningSecret0000000';
export const FF = { 'user-agent': 'Mozilla/5.0 (X11; Linux) Firefox/130' };

/** Answers the Stripe calls of the buy page; the sessions it creates are kept so a test can "pay" them. */
export function fakeStripe() {
  let seq = 0;
  const sessions = new Map<string, any>();
  const calls: URLSearchParams[] = [];
  setStripeFetch((async (url: string, init: any) => {
    const u = new URL(url);
    const params = new URLSearchParams(init?.body ?? '');
    const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/v1/account') return json({ id: 'acct_1', settings: { dashboard: { display_name: 'Test' } } });
    if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
      calls.push(params);
      const id = `cs_test_site${++seq}`;
      const metadata: Record<string, string> = {};
      for (const [k, v] of params) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v;
      const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: params.get('mode'), metadata, amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), currency: 'eur', payment_status: 'unpaid', status: 'open', customer_details: null };
      sessions.set(id, s);
      return json(s);
    }
    const m = u.pathname.match(/^\/v1\/checkout\/sessions\/(.+)$/);
    if (m && sessions.has(m[1])) return json(sessions.get(m[1]));
    return json({ error: { message: `not faked: ${u.pathname}` } }, 404);
  }) as any);
  return { sessions, calls };
}

export async function connectStripe(t: { api: { put(p: string, b?: unknown): Promise<any> } }) {
  const r = await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC });
  if (r.status !== 200) throw new Error(JSON.stringify(r.data));
}

/** The buyer pays the session: Stripe's signed webhook arrives and the events run. */
export async function pay(t: { api: { raw(p: string, i?: RequestInit): Promise<Response>; location: string }; app: any }, session: any, email = 'kaeufer@example.com') {
  const raw = JSON.stringify({ id: `evt_${session.id}`, type: 'checkout.session.completed', data: { object: { ...session, status: 'complete', payment_status: 'paid', payment_intent: `pi_${session.id}`, customer_details: { email } } } });
  const r = await t.api.raw(`/hooks/stripe/${t.api.location}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, WHSEC) }, body: raw });
  await t.app.events.flush();
  return r.json();
}

/**
 * Seeds of the isolation harness for the website builder (tests/security-fixtures.ts calls this from seedLocation): a site with a
 * component, a collection with an entry, a redirect, header/menu/404 settings, a layout on the page and a counted page view –
 * every name carries `tag`, so a response that contains B's marker leaked B's data.
 */
export async function seedSites(
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; data: any }>,
  mk: (key: string, method: string, path: string, body: any, pick?: (d: any) => any) => Promise<any>,
  tag: string,
) {
  const low = tag.toLowerCase().replace(/[^a-z0-9]/g, '') || 'x';
  const site = await mk('site', 'POST', '/api/funnels', { name: `${tag} Website`, kind: 'website', template: 'blank' });
  if (!site?.id) return;
  const comp = await mk('sitecomponent', 'POST', '/api/site-components', { name: `${tag} Komponente`, blocks: [{ type: 'heading', text: `${tag} Symbol`, level: 2 }] });
  const col = await mk('sitecollection', 'POST', `/api/funnels/${site.id}/collections`, { preset: 'team', name: `${tag} Team`, with_samples: false });
  if (col?.id) await mk('siteitem', 'POST', `/api/site-collections/${col.id}/items`, { data: { name: `${tag} Mitarbeiter`, role: `${tag} Rolle`, bio: `${tag} Biografie` }, status: 'published' });
  await mk('siteredirect', 'POST', `/api/funnels/${site.id}/redirects`, { source: `/${low}-alt`, target: `/${low}-neu`, code: 301, note: `${tag} Notiz` });
  await mk('sitesettings', 'PATCH', `/api/funnels/${site.id}`, { settings: { header: { enabled: true, brand: `${tag} Marke`, menu: 'main' }, menus: { main: [{ label: `${tag} Menüpunkt`, url: '/kontakt' }] }, footer: { enabled: true, text: `${tag} Fußzeile` }, not_found: { heading: `${tag} Seite fehlt`, text: `${tag} Text` } } }, () => undefined);
  const page = site.pages?.[0];
  if (page?.id) {
    await mk(
      'sitepage',
      'PATCH',
      `/api/funnel-pages/${page.id}`,
      { name: `${tag} Startseite`, blocks: [...(comp?.id ? [{ id: 'k1', type: 'component', component_id: comp.id }] : []), ...(col?.id ? [{ id: 'k2', type: 'collection', collection_id: col.id, heading: `${tag} Team` }] : []), { id: 'k3', type: 'heading', text: `${tag} Überschrift`, level: 1 }], layout: { lang: 'de', group: `${low}-start` } },
      () => undefined,
    );
  }
  // one counted page view (a browser agent: bots are not counted) and a miss on the 404 list
  const ff = { 'user-agent': 'Mozilla/5.0 (X11; Linux) Firefox/130' };
  if (site.slug) {
    await call('GET', `/p/${site.slug}`, undefined, ff);
    await call('GET', `/p/${site.slug}/${low}-unbekannt`, undefined, ff);
  }
}
