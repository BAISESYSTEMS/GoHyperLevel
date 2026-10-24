import { advanceDate } from '../modules/payments.js';
import { CUSTOMER_POOL, DEAL_KINDS, DEAL_RATE, REVENUE, SUBSCRIPTIONS } from './demo-seed-content.js';
import type { Kit } from './demo-seed-extras.js';
import { STAGE, TAG } from './hq-template.js';
import { DEFAULT_LOST_REASONS } from './opportunities.js';

/**
 * Twelve months of business for the demo (services/demo-seed.ts): paid invoices that grow month by month, subscriptions
 * (the SaaS start-up's book with real MRR, a few cancellations and trials), and deals won, lost and open over the year.
 * Everything is created through the app's own routes; only the dates are set afterwards (the way backdate() does), because
 * a route stamps "now". The ids of dated deals go into `k.dated`, so the final backdating leaves them as they are.
 */

const DAY = 864e5;
/** An invoice to create at a point in time: all of them are sorted and run oldest first, so the invoice numbers follow the dates. */
export interface Job {
  at: string;
  run: () => Promise<unknown>;
}
export async function runJobs(jobs: Job[]) {
  for (const j of [...jobs].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) await j.run();
  jobs.length = 0;
}
export interface DealRef {
  id: string;
  name: string;
  value: number;
  status: string;
}

const int = (k: Kit, a: number, b: number) => a + Math.floor(k.rand() * (b - a + 1));
const pickOf = <T>(k: Kit, list: readonly T[]): T => list[Math.floor(k.rand() * list.length)];
const whoOf = (c: any) => (c.company ? String(c.company) : `${c.first_name} ${c.last_name}`.trim());
const plusDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * DAY).toISOString();
/** Today at 9 o'clock – or now, when that is earlier (the nightly reset runs at 3): nothing the history creates lies in the future. */
const todayAt = (k: Kit) => Math.min(Date.parse(k.inDays(0, 9)), k.nowMs - 60_000);

/** Paid invoices over the last twelve months, a few more every month (the dashboard's revenue and the revenue reports). */
export function seedRevenueHistory(k: Kit, products: any[], jobs: Job[]) {
  const spec = REVENUE[k.plan.key];
  if (!spec) return;
  // one-off work only: the subscription products have their own invoices
  products = products.filter((p) => !/((Monat|monatlich|Jahr))/.test(p.name));
  // The line items rotate through the price list (not at random), so every month gets a comparable mix and no month is up to luck.
  const line = (m: number, j: number, second = false) => {
    const turn = m * 2 + j * 3 + (second ? 1 : 0);
    if (spec.custom && (!products.length || turn % 10 < 7)) {
      const [name, cents] = spec.custom[turn % spec.custom.length];
      return { name, qty: 1, price_cents: cents, tax_rate: 19 };
    }
    const p = products[turn % products.length];
    return { name: p.name, qty: 1 + Math.floor(k.rand() * spec.qtyMax), price_cents: p.price_cents, tax_rate: 19 };
  };
  for (let m = 11; m >= 0; m--) {
    const n = Math.round(spec.perMonth * 1.075 ** (11 - m));
    for (let j = 0; j < n; j++) {
      const back = m * 30 + 2 + Math.floor(((j + k.rand() * 0.7) / n) * 27);
      const items = [line(m, j), ...(k.rand() < 0.25 ? [line(m, j, true)] : [])];
      const c = k.contact(Math.floor(k.rand() * 1000));
      const issued = k.inDays(-back, 9);
      jobs.push({
        at: issued,
        run: async () => {
          const inv = await k.call('POST', '/api/invoices', { contact_id: c.id, title: items[0].name, items, issued_at: issued, due_at: k.inDays(-back + 14, 12) });
          if (inv?.id) await k.call('PATCH', `/api/invoices/${inv.id}`, { status: 'paid' });
        },
      });
    }
  }
}

/**
 * One subscription: a recurring invoice (the "template") plus – when `children` – the invoice of every past period, all paid.
 * The next invoice lies in the future (so nothing is generated at the first tick); an ended one carries an end date.
 */
export function subscription(k: Kit, jobs: Job[], product: { name: string; price_cents: number }, contact: any, startBack: number, o: { interval?: 'month' | 'year'; qty?: number; endBack?: number; children?: boolean } = {}) {
  const interval = o.interval ?? 'month';
  const startIso = k.inDays(-startBack, 9);
  const day = new Date(startIso).getUTCDate();
  const endIso = o.endBack !== undefined ? k.inDays(-o.endBack, 12) : null;
  const dates: string[] = [];
  let d = startIso;
  while (Date.parse(d) <= todayAt(k) && (!endIso || d <= endIso)) {
    dates.push(d);
    d = advanceDate(d, interval, day);
  }
  let next = d;
  while (Date.parse(next) <= Math.max(todayAt(k), Date.now())) next = advanceDate(next, interval, day);
  const items = [{ name: product.name, qty: o.qty ?? 1, price_cents: product.price_cents, tax_rate: 19 }];
  let parentId = '';
  jobs.push({
    at: startIso,
    run: async () => {
      const parent = await k.call('POST', '/api/invoices', {
        contact_id: contact.id,
        title: product.name,
        items,
        issued_at: startIso,
        due_at: plusDays(startIso, 14),
        recurring: { interval, next_at: next, auto_send: true, active: !endIso, end_at: endIso },
      });
      if (!parent?.id) return;
      parentId = parent.id;
      await k.call('PATCH', `/api/invoices/${parent.id}`, { status: 'paid' });
    },
  });
  if (o.children === false) return;
  for (const at of dates.slice(1)) {
    jobs.push({
      at,
      run: async () => {
        if (!parentId) return;
        const child = await k.call('POST', '/api/invoices', { contact_id: contact.id, title: product.name, items, issued_at: at, due_at: plusDays(at, 14), parent_id: parentId });
        if (child?.id) await k.call('PATCH', `/api/invoices/${child.id}`, { status: 'paid' });
      },
    });
  }
}

/** Maintenance contracts, coaching memberships, coffee subscriptions: a handful of monthly subscriptions per business. */
export function seedSubscriptions(k: Kit, products: any[], jobs: Job[]) {
  const spec = SUBSCRIPTIONS[k.plan.key];
  const p = spec && products.find((x) => x.name === spec.product);
  if (!spec || !p) return;
  for (let i = 0; i < spec.n; i++) {
    const startBack = 20 + Math.round(300 * (1 - (i / spec.n) ** 0.7));
    // one ended contract, so MRR does not only ever grow
    subscription(k, jobs, p, k.contact(i * 5 + 1), startBack, { qty: spec.qty, ...(i === 2 ? { endBack: 40 } : {}) });
  }
}

/** Sets the dates of a deal the way a lived-in pipeline has them (and remembers it for the final backdating). */
function dateDeal(k: Kit, dealId: string, created: string, closed: string | null, stageChanged: string) {
  k.app.db.run('UPDATE opportunities SET created_at = ?, updated_at = ?, stage_changed_at = ?, closed_at = ? WHERE id = ?', created, closed ?? stageChanged, stageChanged, closed, dealId);
  k.dated.add(dealId);
}

/** Deals over twelve months: more every month, most of the old ones won or lost, the recent ones still open. */
export async function seedDealHistory(k: Kit, pipe: any, deals: DealRef[]) {
  const kinds = DEAL_KINDS[k.plan.key];
  const rate = DEAL_RATE[k.plan.key];
  if (!pipe || !rate || !kinds?.length) return;
  const stages: { id: string }[] = pipe.stages;
  const last = stages[stages.length - 1];
  const limit = todayAt(k);
  for (let m = 11; m >= 0; m--) {
    const n = Math.round(rate * 1.08 ** (11 - m));
    const [pWon, pLost] = m >= 2 ? [0.6, 0.28] : m === 1 ? [0.45, 0.2] : [0.2, 0.08];
    for (let j = 0; j < n; j++) {
      const back = m * 30 + 1 + Math.floor(((j + k.rand() * 0.7) / n) * 28);
      const [kind, min, max] = pickOf(k, kinds);
      const value = Math.round((min + k.rand() * (max - min)) / 10) * 10;
      const c = k.contact(Math.floor(k.rand() * 1000));
      const name = `${kind} – ${whoOf(c)}`;
      const roll = k.rand();
      const status = roll < pWon ? 'won' : roll < pWon + pLost ? 'lost' : 'open';
      const stage = status === 'won' ? last : stages[Math.floor(k.rand() * (stages.length - 1))];
      const created = k.inDays(-back, int(k, 8, 16));
      const closed = status === 'open' ? null : new Date(Math.min(Date.parse(created) + int(k, 5, 40) * DAY, limit)).toISOString();
      const o = await k.call('POST', '/api/opportunities', {
        contact_id: c.id,
        pipeline_id: pipe.id,
        stage_id: stage.id,
        name,
        value,
        source: pickOf(k, k.plan.sources),
        status,
        ...(status === 'lost' ? { lost_reason: DEFAULT_LOST_REASONS[(m + j) % DEFAULT_LOST_REASONS.length] } : {}),
        ...(status === 'open' ? { expected_close_date: k.ymd(int(k, 3, 60)) } : {}),
      });
      if (!o?.id) continue;
      dateDeal(k, o.id, created, closed, closed ?? new Date(Math.min(Date.parse(created) + int(k, 0, back) * DAY, limit)).toISOString());
      deals.push({ id: o.id, name, value, status });
    }
  }
}

/**
 * The start-up's customer book: about forty subscriptions (monthly and yearly, three tariffs) that started over eleven months
 * at a growing pace, five cancellations, eight running trials and a waiting list – as contacts with the lifecycle tags, deals
 * in the lifecycle pipeline and paid invoices per month. The CEO cockpit (hq-template) reads exactly these.
 */
export async function seedSaasBook(k: Kit, products: any[], pipe: any, jobs: Job[]): Promise<DealRef[]> {
  const refs: DealRef[] = [];
  const by = (prefix: string) => products.find((p) => p.name.startsWith(prefix));
  const tiers = { starter: by('Taktwerk Starter'), team: by('Taktwerk Team (Monat)'), business: by('Taktwerk Business (Monat)'), teamY: by('Taktwerk Team (Jahr)'), businessY: by('Taktwerk Business (Jahr)') };
  if (!pipe || Object.values(tiers).some((t) => !t)) return refs;
  const stage = (id: string) => pipe.stages.find((s: any) => s.id === id)?.id ?? pipe.stages[0].id;
  const tagsOf = (c: any, extra: string[]) => [...new Set([...(Array.isArray(c.tags) ? c.tags : []), ...extra])];
  const ENDED: Record<number, number> = { 3: 205, 9: 140, 15: 26, 22: 12, 31: 3 };
  const N = 40;
  const company = (i: number) => CUSTOMER_POOL[(i * 7 + 3) % CUSTOMER_POOL.length];
  const planTag = { starter: 'plan:solo', team: 'plan:team', business: 'plan:agency' } as const;
  const today = todayAt(k);

  for (let s = 0; s < N; s++) {
    const tier = s % 5 === 4 ? 'business' : s % 3 === 0 ? 'starter' : 'team';
    const yearly = s % 9 === 8 && tier !== 'starter';
    const product = yearly ? (tier === 'business' ? tiers.businessY : tiers.teamY) : tiers[tier];
    const startBack = Math.max(3, Math.round(335 * (1 - (s / (N - 1)) ** 0.7)));
    const endBack = ENDED[s];
    const c = k.contact(s);
    const ended = endBack !== undefined;
    await k.call('PATCH', `/api/contacts/${c.id}`, { tags: tagsOf(c, [ended ? TAG.churn : TAG.customer, planTag[tier], 'betrieb:cloud']) });
    subscription(k, jobs, product, c, startBack, { interval: yearly ? 'year' : 'month', endBack });
    const name = `${company(s)} – ${tier === 'business' ? 'Business' : tier === 'team' ? 'Team' : 'Starter'}`;
    const value = Math.round((product.price_cents / 100) * (yearly ? 1 : 12));
    const startIso = k.inDays(-startBack, 9);
    // a customer: won when the subscription started (after a trial of one to three weeks); a cancelled one lands in "Gekündigt"
    const lostForGood = s === 3 || s === 9;
    const o = await k.call('POST', '/api/opportunities', {
      contact_id: c.id,
      pipeline_id: pipe.id,
      stage_id: stage(ended ? STAGE.churn : STAGE.customer),
      name,
      value,
      source: pickOf(k, k.plan.sources),
      status: ended ? (lostForGood ? 'lost' : 'open') : 'won',
      ...(lostForGood ? { lost_reason: DEFAULT_LOST_REASONS[s % DEFAULT_LOST_REASONS.length] } : {}),
    });
    if (!o?.id) continue;
    const created = plusDays(startIso, -int(k, 7, 21));
    const endIso = ended ? k.inDays(-endBack, 12) : null;
    dateDeal(k, o.id, created, ended && lostForGood ? endIso : ended ? null : startIso, endIso ?? startIso);
    refs.push({ id: o.id, name, value, status: ended ? (lostForGood ? 'lost' : 'open') : 'won' });
  }

  // running trials (tag + deal in "Testphase"), the waiting list and trials that never converted
  const extra: [number, number, string, string][] = []; // contact index, count, tag, stage
  extra.push([N, 8, TAG.trial, STAGE.trial], [N + 8, 6, TAG.wait, STAGE.wait]);
  for (const [from, count, tag, st] of extra) {
    for (let i = 0; i < count; i++) {
      const c = k.contact(from + i);
      await k.call('PATCH', `/api/contacts/${c.id}`, { tags: tagsOf(c, [tag]) });
      // the plan's own ten deals (demo-seed-data.ts) are the open trials and the first waiting-list entries
      const planned = k.plan.deals[tag === TAG.trial ? i : 8 + i];
      const name = planned ? planned[0] : `${company(from + i + 11)} – ${tag === TAG.trial ? 'Testphase' : 'Warteliste'}`;
      const value = planned ? planned[1] : tag === TAG.trial ? [1188, 4788, 1188, 588, 4788][i % 5] : [588, 1188, 2388][i % 3];
      const o = await k.call('POST', '/api/opportunities', { contact_id: c.id, pipeline_id: pipe.id, stage_id: stage(st), name, value, source: pickOf(k, k.plan.sources) });
      if (!o?.id) continue;
      const back = tag === TAG.trial ? int(k, 1, 12) : int(k, 3, 70);
      const created = k.inDays(-back, 10);
      dateDeal(k, o.id, created, null, created);
      refs.push({ id: o.id, name, value, status: 'open' });
    }
  }
  for (let i = 0; i < 7; i++) {
    const c = k.contact(N + 14 + i);
    const name = `${company(N + i + 20)} – Testphase beendet`;
    const o = await k.call('POST', '/api/opportunities', { contact_id: c.id, pipeline_id: pipe.id, stage_id: stage(STAGE.trial), name, value: [588, 1188, 1188, 4788][i % 4], status: 'lost', lost_reason: DEFAULT_LOST_REASONS[(i + 2) % DEFAULT_LOST_REASONS.length] });
    if (!o?.id) continue;
    const back = 20 + i * 41;
    const created = k.inDays(-back, 10);
    dateDeal(k, o.id, created, new Date(Math.min(Date.parse(created) + 16 * DAY, today)).toISOString(), plusDays(created, 16));
    refs.push({ id: o.id, name, value: 0, status: 'lost' });
  }
  // one-off revenue besides the subscriptions (onboarding, training) is part of seedRevenueHistory
  return refs;
}
