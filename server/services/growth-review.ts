import type { DraftType } from './companion-initiative.js';

/**
 * Jarvis als Business Developer (docs/living-boards.md#business-developer): the Wachstums-Briefing and the Wochenbilanz, computed
 * from real numbers – pure, so it works without any AI and is tested with seeded data. modules/companion-growth.ts reads the data
 * with the person's own rights (deals, invoices, quotes, contacts, reviews, tasks, the project profile) and hands a GrowthData
 * snapshot in; this file turns it into KPIs (this week vs. the week before), the top three opportunities and risks with their €
 * impact, one growth idea from the data – each with a prepared draft or a one-click hand-off to the agent – and the spoken words.
 *
 * Not repeating itself: every item has a key and a signature (counts, ids, rounded €). `applyMemory` drops what was said in the last
 * days with the same signature and what the person declined; the wording is picked per day and person from several phrasings and
 * never opens like the last briefing. Third-party text (names, titles) only goes into labels and drafts – never into an agent prompt,
 * which names the record as the agent's selected record instead.
 */

export type Lang = 'de' | 'en';
export type GrowthKind = 'daily' | 'weekly';
export type ItemKind = 'opportunity' | 'risk' | 'growth';
export type Area = 'pipeline' | 'leads' | 'customers' | 'marketing' | 'operations' | 'cash';

export interface Deal {
  id: string;
  name: string;
  value: number;
  status: string;
  created_at: string;
  updated_at?: string | null;
  stage_changed_at?: string | null;
  closed_at?: string | null;
  expected_close_date?: string | null;
  source?: string | null;
  contact_id?: string | null;
  contact_name?: string | null;
}
export interface Invoice {
  id: string;
  number: string;
  contact_id: string | null;
  name: string;
  total_cents: number;
  open_cents: number;
  days_overdue: number;
  status: string;
  issued_at?: string | null;
  paid_at?: string | null;
  created_at: string;
}
export interface Quote {
  id: string;
  number: string;
  status: string;
  total_cents: number;
  sent_at?: string | null;
  deal_id?: string | null;
  contact_id?: string | null;
  contact_name?: string | null;
}
export interface Review {
  id: string;
  rating: number | null;
  contact_id: string | null;
  name: string;
  responded_at?: string | null;
  created_at: string;
}
export interface SourceStat {
  source: string;
  leads: number;
  won: number;
}
export interface GrowthData {
  now: number;
  deals: Deal[];
  invoices: Invoice[];
  quotes: Quote[];
  reviews: Review[];
  /** creation times of contacts of the last 28 days (lead flow) */
  leads: { created_at: string; source?: string | null }[];
  /** lead → customer per source over 90 days */
  sources: SourceStat[];
  /** new contacts (≤ 14 days) we never wrote to */
  unanswered: { count: number; top?: { id: string; name: string } | null };
  /** last activity per contact id (dormant customers) */
  activity: Record<string, string | null>;
  /** contacts that got a review request in the last 180 days */
  reviewAsked: string[];
  tasksOverdue: number;
  /** unread conversations waiting longer than 24 hours */
  waiting: number;
  profile: { tagline?: string; description?: string; goals?: string };
}

export interface Kpis {
  revenue: number;
  leads: number;
  won_count: number;
  won_value: number;
  /** won ÷ (won + lost) of the deals closed in the window's last 90 days; null without closed deals */
  win_rate: number | null;
  avg_deal: number;
  pipeline: number;
  overdue: number;
}

export interface GrowthAction {
  label: string;
  /** for the agent – never third-party text, the record is `entity` */
  prompt: string;
  draft_type: DraftType;
  draft: string;
  entity: { type: string; id: string; label: string } | null;
}
export interface GrowthItem {
  key: string;
  kind: ItemKind;
  area: Area;
  title: string;
  detail: string;
  impact_eur: number;
  /** the impact is an expected value (count × average × rate), not money already on an invoice */
  estimate: boolean;
  count: number;
  url: string;
  sig: string;
  action: GrowthAction;
  /** said before with other numbers */
  update?: boolean;
}
export interface GrowthReview {
  kind: GrowthKind;
  at: string;
  kpis: Kpis;
  prev: Kpis;
  deltas: Record<keyof Kpis, number | null>;
  opportunities: GrowthItem[];
  risks: GrowthItem[];
  idea: GrowthItem | null;
  /** 1–3 next actions it can prepare itself (from the top items) */
  actions: GrowthAction[];
  say: string;
  sig: string;
  /** something is new compared with what was said lately */
  fresh: boolean;
  source: 'rules' | 'ai';
  goals: string;
}

export interface MemoryRow {
  key: string;
  sig: string;
  at: string;
  /** declined = the person said no to it */
  status?: string;
}

const DAY = 864e5;
/** The same item with the same numbers again only after this. */
export const REPEAT_MS = 3 * DAY;
/** A declined item only after this. */
export const DECLINED_MS = 14 * DAY;
/** A growth idea of the same kind again only after this (ideas rotate). */
export const IDEA_ROTATE_MS = 7 * DAY;
/** Assumed win rate when there are no closed deals yet (marked as estimate). */
export const DEFAULT_WIN_RATE = 0.25;
/** Share of dormant customers a reactivation brings back (estimate). */
export const REACTIVATION_RATE = 0.15;

const t = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const ageDays = (iso: string | null | undefined, now: number) => {
  const v = t(iso);
  return Number.isFinite(v) ? Math.floor((now - v) / DAY) : Infinity;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const clip = (s: unknown, n: number) => {
  const v = String(s ?? '')
    .replace(/[\u0000-\u001f<>{}`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
export const euro = (v: number, lang: Lang) => new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Math.round(v || 0));
/** Rounded for signatures: 1 240 € and 1 260 € are "the same numbers", 2 000 € is not. */
const bucket = (v: number) => (v < 100 ? Math.round(v / 10) : Math.round(Math.log(v) * 8));

/** Small stable hash (FNV-1a) – picks a phrasing per day, person and item. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const vary = (seed: string, list: string[], skip?: (s: string) => boolean): string => {
  const start = hash(seed) % list.length;
  for (let i = 0; i < list.length; i++) {
    const v = list[(start + i) % list.length];
    if (!skip?.(v)) return v;
  }
  return list[start];
};
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

// --- KPIs ---------------------------------------------------------------------------------------------------------------------

const closedAt = (d: Deal) => d.closed_at || d.updated_at || d.created_at;

/** KPIs for the 7 days before `end`. Pure. */
export function kpisFor(d: GrowthData, end: number): Kpis {
  const start = end - 7 * DAY;
  const inWin = (iso: string | null | undefined) => {
    const v = t(iso);
    return Number.isFinite(v) && v >= start && v < end;
  };
  const won = d.deals.filter((x) => x.status === 'won' && inWin(closedAt(x)));
  const closed90 = d.deals.filter((x) => (x.status === 'won' || x.status === 'lost') && t(closedAt(x)) >= end - 90 * DAY && t(closedAt(x)) < end);
  const won90 = closed90.filter((x) => x.status === 'won');
  const won180 = d.deals.filter((x) => x.status === 'won' && t(closedAt(x)) >= end - 180 * DAY && t(closedAt(x)) < end);
  const open = d.deals.filter((x) => x.status === 'open');
  const paid = d.invoices.filter((i) => i.status === 'paid' && inWin(i.paid_at));
  const avgWon = won180.length ? sum(won180.map((x) => Number(x.value) || 0)) / won180.length : 0;
  const avgOpen = open.length ? sum(open.map((x) => Number(x.value) || 0)) / open.length : 0;
  return {
    revenue: Math.round(sum(paid.map((i) => Number(i.total_cents) || 0)) / 100),
    leads: d.leads.filter((l) => inWin(l.created_at)).length,
    won_count: won.length,
    won_value: Math.round(sum(won.map((x) => Number(x.value) || 0))),
    win_rate: closed90.length ? won90.length / closed90.length : null,
    avg_deal: Math.round(avgWon || avgOpen),
    pipeline: Math.round(sum(open.map((x) => Number(x.value) || 0))),
    overdue: Math.round(sum(d.invoices.filter((i) => Number(i.days_overdue) > 0 && Number(i.open_cents) > 0).map((i) => Number(i.open_cents))) / 100),
  };
}

/** Relative change in percent (rounded), null when there is nothing to compare with. Pure. */
export const delta = (cur: number | null, prev: number | null): number | null => (cur === null || prev === null ? null : prev === 0 ? (cur === 0 ? 0 : null) : Math.round(((cur - prev) / Math.abs(prev)) * 100));

const deltaText = (cur: number, prev: number, lang: Lang) => {
  const p = delta(cur, prev);
  if (p === null) return cur > 0 ? (lang === 'en' ? 'new' : 'neu') : lang === 'en' ? 'none yet' : 'noch keine';
  if (p === 0) return lang === 'en' ? 'same as last week' : 'wie in der Vorwoche';
  return lang === 'en' ? `${p > 0 ? '+' : '−'}${Math.abs(p)} % vs. last week` : `${p > 0 ? '+' : '−'}${Math.abs(p)} % zur Vorwoche`;
};

// --- the items --------------------------------------------------------------------------------------------------------------

interface Env {
  d: GrowthData;
  lang: Lang;
  L: (de: string, en: string) => string;
  wr: number;
  wrKnown: boolean;
  avg: number;
  today: string;
}

const first = (name: string) => clip(name, 60).split(' ')[0] || '';

function staleDeals({ d, L, lang, wr }: Env): GrowthItem | null {
  const idle = (x: Deal) => ageDays(x.stage_changed_at || x.updated_at || x.created_at, d.now);
  const list = d.deals.filter((x) => x.status === 'open' && idle(x) >= 14 && !(x.expected_close_date && x.expected_close_date.slice(0, 10) < new Date(d.now).toISOString().slice(0, 10)));
  if (!list.length) return null;
  const total = sum(list.map((x) => Number(x.value) || 0));
  const top = [...list].sort((a, b) => Number(b.value) - Number(a.value))[0];
  const name = clip(top.name, 50);
  const who = clip(top.contact_name, 60);
  return {
    key: 'opp:stale_deals',
    kind: 'opportunity',
    area: 'pipeline',
    title: L(`${list.length} ${plural(list.length, 'Deal liegt', 'Deals liegen')} seit 14+ Tagen still · ${euro(total, lang)}`, `${list.length} ${plural(list.length, 'deal has', 'deals have')} been idle for 14+ days · ${euro(total, lang)}`),
    detail: L(`Größter: „${name}“ (${euro(Number(top.value), lang)}, seit ${idle(top)} Tagen unberührt)`, `Biggest: “${name}” (${euro(Number(top.value), lang)}, untouched for ${idle(top)} days)`),
    impact_eur: Math.round(total * wr),
    estimate: true,
    count: list.length,
    url: 'opportunities',
    sig: `${list.length}:${top.id}:${bucket(total)}`,
    action: {
      label: L(`„${clip(top.name, 30)}“ nachfassen`, `Follow up “${clip(top.name, 30)}”`),
      prompt: L(`Hilf mir, den ausgewählten Deal (${euro(Number(top.value), lang)}, seit ${idle(top)} Tagen unberührt) nachzufassen: Fasse den Stand zusammen und entwirf eine kurze Nachricht an den Kontakt – noch nicht senden.`, `Help me follow up the selected deal (${euro(Number(top.value), lang)}, untouched for ${idle(top)} days): summarise where it stands and draft a short message to the contact – do not send it yet.`),
      draft_type: top.contact_id ? 'email' : 'none',
      draft: top.contact_id
        ? L(`Hallo ${first(who)},\n\nich wollte kurz nachhaken, wie es bei Ihnen mit „${name}“ aussieht. Wenn noch Fragen offen sind, klären wir sie gern in einem kurzen Gespräch – passt Ihnen ein Termin diese oder nächste Woche?\n\nViele Grüße`, `Hi ${first(who)},\n\nI wanted to check in on “${name}”. If anything is still open, happy to clear it up in a short call – would this or next week work for you?\n\nBest regards`)
        : '',
      entity: top.contact_id ? { type: 'contact', id: String(top.contact_id), label: who || name } : { type: 'opportunity', id: top.id, label: name },
    },
  };
}

function pastClose({ d, L, lang, today }: Env): GrowthItem | null {
  const list = d.deals.filter((x) => x.status === 'open' && x.expected_close_date && x.expected_close_date.slice(0, 10) < today);
  if (!list.length) return null;
  const total = sum(list.map((x) => Number(x.value) || 0));
  const top = [...list].sort((a, b) => Number(b.value) - Number(a.value))[0];
  const name = clip(top.name, 50);
  return {
    key: 'risk:past_close',
    kind: 'risk',
    area: 'pipeline',
    title: L(`${list.length} ${plural(list.length, 'Deal hat', 'Deals haben')} das Abschlussdatum überschritten · ${euro(total, lang)}`, `${list.length} ${plural(list.length, 'deal is', 'deals are')} past the close date · ${euro(total, lang)}`),
    detail: L(`Größter: „${name}“ (${euro(Number(top.value), lang)}, geplant bis ${String(top.expected_close_date).slice(0, 10)})`, `Biggest: “${name}” (${euro(Number(top.value), lang)}, planned for ${String(top.expected_close_date).slice(0, 10)})`),
    impact_eur: Math.round(total),
    estimate: false,
    count: list.length,
    url: 'opportunities',
    sig: `${list.length}:${top.id}:${bucket(total)}`,
    action: {
      label: L(`„${clip(top.name, 30)}“ retten`, `Rescue “${clip(top.name, 30)}”`),
      prompt: L(`Der ausgewählte Deal (${euro(Number(top.value), lang)}) hat sein Abschlussdatum überschritten. Fasse den Stand zusammen, schlag ein realistisches neues Datum vor und entwirf eine Nachricht an den Kontakt – Änderungen nur über die Bestätigungskarte.`, `The selected deal (${euro(Number(top.value), lang)}) is past its close date. Summarise where it stands, suggest a realistic new date and draft a message to the contact – changes only through the confirmation card.`),
      draft_type: 'none',
      draft: '',
      entity: { type: 'opportunity', id: top.id, label: name },
    },
  };
}

function openQuotes({ d, L, lang, wr }: Env): GrowthItem | null {
  const list = d.quotes.filter((q) => (q.status === 'sent' || q.status === 'viewed') && ageDays(q.sent_at, d.now) >= 5);
  if (!list.length) return null;
  const total = sum(list.map((q) => Number(q.total_cents) || 0)) / 100;
  const top = [...list].sort((a, b) => Number(b.total_cents) - Number(a.total_cents))[0];
  const who = clip(top.contact_name, 60);
  return {
    key: 'opp:open_quotes',
    kind: 'opportunity',
    area: 'pipeline',
    title: L(`${list.length} ${plural(list.length, 'Angebot wartet', 'Angebote warten')} auf Antwort · ${euro(total, lang)}`, `${list.length} ${plural(list.length, 'quote awaits', 'quotes await')} an answer · ${euro(total, lang)}`),
    detail: L(`Größtes: ${clip(top.number, 30) || 'ohne Nummer'}${who ? ` an ${who}` : ''} (${euro(Number(top.total_cents) / 100, lang)}, seit ${ageDays(top.sent_at, d.now)} Tagen offen)`, `Biggest: ${clip(top.number, 30) || 'no number'}${who ? ` to ${who}` : ''} (${euro(Number(top.total_cents) / 100, lang)}, open for ${ageDays(top.sent_at, d.now)} days)`),
    impact_eur: Math.round(total * Math.max(wr, 0.4)),
    estimate: true,
    count: list.length,
    url: 'quotes',
    sig: `${list.length}:${top.id}:${bucket(total)}`,
    action: {
      label: L(`Angebote nachfassen (${list.length})`, `Follow up quotes (${list.length})`),
      prompt: L(`Es warten ${list.length} gesendete Angebote seit mindestens 5 Tagen auf Antwort (zusammen ${euro(total, lang)}). Liste sie auf und entwirf je eine kurze, freundliche Nachfass-Nachricht – noch nichts senden.`, `${list.length} sent quotes have been waiting at least 5 days for an answer (${euro(total, lang)} in total). List them and draft a short, friendly follow-up for each – do not send anything yet.`),
      draft_type: top.contact_id ? 'email' : 'none',
      draft: top.contact_id ? L(`Hallo ${first(who)},\n\nhaben Sie unser Angebot ${clip(top.number, 30)} schon ansehen können? Gern beantworte ich offene Fragen oder passe es an – ein kurzer Anruf genügt.\n\nViele Grüße`, `Hi ${first(who)},\n\nhave you had a chance to look at our quote ${clip(top.number, 30)}? Happy to answer questions or adjust it – a short call is enough.\n\nBest regards`) : '',
      entity: top.contact_id ? { type: 'contact', id: String(top.contact_id), label: who } : null,
    },
  };
}

/** Customers (paid invoices) grouped: total paid, number of invoices, last purchase. Pure. */
export function customersOf(d: GrowthData) {
  const m = new Map<string, { id: string; name: string; paid: number; n: number; last: number; paid365: number }>();
  for (const i of d.invoices) {
    if (!i.contact_id || i.status !== 'paid') continue;
    const at = t(i.paid_at || i.issued_at || i.created_at);
    const c = m.get(i.contact_id) ?? { id: i.contact_id, name: clip(i.name, 60), paid: 0, n: 0, last: 0, paid365: 0 };
    c.paid += Number(i.total_cents) / 100;
    c.n++;
    if (Number.isFinite(at)) {
      c.last = Math.max(c.last, at);
      if (d.now - at <= 365 * DAY) c.paid365 += Number(i.total_cents) / 100;
    }
    m.set(i.contact_id, c);
  }
  return [...m.values()];
}

function dormant({ d, L, lang }: Env): GrowthItem | null {
  const list = customersOf(d).filter((c) => c.last && d.now - c.last >= 90 * DAY && ageDays(d.activity[c.id] ?? null, d.now) >= 45);
  if (!list.length) return null;
  const ticket = sum(list.map((c) => c.paid / c.n)) / list.length;
  const top = [...list].sort((a, b) => b.paid - a.paid)[0];
  const impact = Math.round(list.length * ticket * REACTIVATION_RATE);
  return {
    key: 'growth:reactivation',
    kind: 'growth',
    area: 'customers',
    title: L(`Reaktivierung: ${list.length} ${plural(list.length, 'Kunde hat', 'Kunden haben')} seit 90+ Tagen nichts gekauft`, `Reactivation: ${list.length} ${plural(list.length, 'customer has', 'customers have')} not bought for 90+ days`),
    detail: L(`Ø ${euro(ticket, lang)} je Kauf – holt eine Kampagne ${Math.round(REACTIVATION_RATE * 100)} % zurück, sind das rund ${euro(impact, lang)}. Größter: ${top.name || 'ohne Namen'} (${euro(top.paid, lang)} gesamt)`, `Avg. ${euro(ticket, lang)} per purchase – if a campaign wins back ${Math.round(REACTIVATION_RATE * 100)} %, that is about ${euro(impact, lang)}. Biggest: ${top.name || 'unnamed'} (${euro(top.paid, lang)} in total)`),
    impact_eur: impact,
    estimate: true,
    count: list.length,
    url: 'contacts',
    sig: `${list.length}:${bucket(ticket)}`,
    action: {
      label: L(`Reaktivierungs-Kampagne für ${list.length} Kunden entwerfen`, `Draft a reactivation campaign for ${list.length} customers`),
      prompt: L(`Entwirf eine E-Mail-Kampagne zur Reaktivierung für die ${list.length} Kunden, die seit über 90 Tagen nichts gekauft haben (bezahlte Rechnungen, keine Aktivität seit 45 Tagen): Segment, Betreff, Text mit einem konkreten Anlass. Lege sie nur als Entwurf an – nichts senden.`, `Draft a reactivation e-mail campaign for the ${list.length} customers who have not bought for over 90 days (paid invoices, no activity for 45 days): segment, subject, text with a concrete reason. Create it as a draft only – send nothing.`),
      draft_type: 'campaign',
      draft: L(`Betreff: Wir haben an Sie gedacht\n\nHallo {{contact.first_name}},\n\nes ist eine Weile her – deshalb ein kurzer Gruß und ein Dankeschön für Ihr Vertrauen. Für unsere Bestandskunden haben wir gerade etwas Neues${d.profile.tagline ? ` (${clip(d.profile.tagline, 80)})` : ''}. Antworten Sie einfach auf diese E-Mail, dann melden wir uns persönlich.\n\nViele Grüße`, `Subject: We thought of you\n\nHi {{contact.first_name}},\n\nit has been a while – so a short hello and thank you for your trust. We have something new for existing customers${d.profile.tagline ? ` (${clip(d.profile.tagline, 80)})` : ''}. Just reply to this e-mail and we will get back to you personally.\n\nBest regards`),
      entity: null,
    },
  };
}

function upsell({ d, L, lang }: Env): GrowthItem | null {
  const active = customersOf(d).filter((c) => c.last && d.now - c.last < 90 * DAY && c.paid365 > 0);
  if (active.length < 2) return null;
  const sorted = [...active].sort((a, b) => b.paid365 - a.paid365);
  const median = sorted[Math.floor(sorted.length / 2)].paid365;
  const top = sorted.filter((c) => c.paid365 >= Math.max(median * 1.5, 1)).slice(0, 5);
  if (!top.length) return null;
  const ticket = sum(top.map((c) => c.paid / c.n)) / top.length;
  const best = top[0];
  const impact = Math.round(top.length * ticket * 0.25);
  return {
    key: 'opp:upsell',
    kind: 'opportunity',
    area: 'customers',
    title: L(`Upsell: ${top.length} ${plural(top.length, 'Top-Kunde', 'Top-Kunden')} mit hohem Umsatz`, `Upsell: ${top.length} top ${plural(top.length, 'customer', 'customers')} with high revenue`),
    detail: L(`${best.name || 'Bester Kunde'}: ${euro(best.paid365, lang)} in 12 Monaten – ein Folgeangebot bringt geschätzt ${euro(impact, lang)}`, `${best.name || 'Best customer'}: ${euro(best.paid365, lang)} in 12 months – a follow-up offer is worth about ${euro(impact, lang)}`),
    impact_eur: impact,
    estimate: true,
    count: top.length,
    url: `contacts/${best.id}`,
    sig: `${top.length}:${best.id}:${bucket(best.paid365)}`,
    action: {
      label: L(`Folgeangebot für ${clip(best.name, 28) || 'Top-Kunden'} vorbereiten`, `Prepare a follow-up offer for ${clip(best.name, 28) || 'top customer'}`),
      prompt: L(`Der ausgewählte Kontakt ist einer unserer umsatzstärksten Kunden (${euro(best.paid365, lang)} in 12 Monaten). Schau dir seine Käufe an, schlag ein passendes Upsell- oder Cross-Sell-Angebot vor und entwirf eine persönliche E-Mail – noch nicht senden.`, `The selected contact is one of our top customers (${euro(best.paid365, lang)} in 12 months). Look at their purchases, suggest a fitting upsell or cross-sell offer and draft a personal e-mail – do not send it yet.`),
      draft_type: 'email',
      draft: L(`Hallo ${first(best.name)},\n\ndanke für die gute Zusammenarbeit in den letzten Monaten! Weil Sie schon einiges mit uns umgesetzt haben, hätte ich eine Idee für den nächsten Schritt – darf ich sie Ihnen in 15 Minuten vorstellen?\n\nViele Grüße`, `Hi ${first(best.name)},\n\nthank you for the great work together over the last months! Since you have already done quite a bit with us, I have an idea for the next step – may I show it to you in 15 minutes?\n\nBest regards`),
      entity: { type: 'contact', id: best.id, label: best.name },
    },
  };
}

function reviewAsks({ d, L }: Env): GrowthItem | null {
  const asked = new Set(d.reviewAsked);
  const unhappy = new Set(d.reviews.filter((r) => r.rating !== null && Number(r.rating) <= 3 && r.contact_id).map((r) => String(r.contact_id)));
  const happy = customersOf(d).filter((c) => c.last && d.now - c.last <= 60 * DAY && !asked.has(c.id) && !unhappy.has(c.id));
  if (!happy.length) return null;
  const rated = d.reviews.filter((r) => r.rating !== null);
  const avg = rated.length ? sum(rated.map((r) => Number(r.rating))) / rated.length : null;
  return {
    key: 'growth:reviews',
    kind: 'growth',
    area: 'marketing',
    title: L(`${happy.length} zufriedene ${plural(happy.length, 'Kunde', 'Kunden')} um eine Bewertung bitten`, `Ask ${happy.length} happy ${plural(happy.length, 'customer', 'customers')} for a review`),
    detail: L(`Kauf in den letzten 60 Tagen, noch keine Anfrage${avg !== null ? ` · bisher Ø ${avg.toFixed(1)} Sterne aus ${rated.length} Bewertungen` : ''}`, `Bought in the last 60 days, never asked${avg !== null ? ` · so far avg. ${avg.toFixed(1)} stars from ${rated.length} reviews` : ''}`),
    impact_eur: 0,
    estimate: true,
    count: happy.length,
    url: 'reputation',
    sig: `${happy.length}`,
    action: {
      label: L(`Bewertungsanfragen an ${happy.length} Kunden vorbereiten`, `Prepare review requests for ${happy.length} customers`),
      prompt: L(`Bereite Bewertungsanfragen für die ${happy.length} Kunden vor, die in den letzten 60 Tagen gekauft und noch keine Anfrage bekommen haben – über die Bestätigungskarte, nichts ohne meinen Klick senden.`, `Prepare review requests for the ${happy.length} customers who bought in the last 60 days and were never asked – through the confirmation card, send nothing without my click.`),
      draft_type: 'none',
      draft: '',
      entity: null,
    },
  };
}

function bestSource({ d, L, lang, avg }: Env): GrowthItem | null {
  const list = d.sources.filter((s) => s.leads >= 3 && s.source);
  if (list.length < 1) return null;
  const rate = (s: SourceStat) => s.won / s.leads;
  const best = [...list].sort((a, b) => rate(b) - rate(a) || b.leads - a.leads)[0];
  if (!best.won) return null;
  const pct = Math.round(rate(best) * 100);
  const impact = Math.round(5 * rate(best) * avg);
  return {
    key: 'growth:best_source',
    kind: 'growth',
    area: 'leads',
    title: L(`Mehr Leads aus „${clip(best.source, 30)}“ – ${pct} % werden Kunden`, `More leads from “${clip(best.source, 30)}” – ${pct} % become customers`),
    detail: L(`${best.won} von ${best.leads} Leads in 90 Tagen gewonnen – fünf Leads mehr bringen geschätzt ${euro(impact, lang)}`, `${best.won} of ${best.leads} leads won in 90 days – five more leads are worth about ${euro(impact, lang)}`),
    impact_eur: impact,
    estimate: true,
    count: best.leads,
    url: 'reports',
    sig: `${best.source}:${pct}`,
    action: {
      label: L('Kampagne für den besten Kanal entwerfen', 'Draft a campaign for the best channel'),
      prompt: L(`Unser bester Lead-Kanal wandelt ${pct} % der Leads in Kunden um (${best.won} von ${best.leads} in 90 Tagen). Schlag drei konkrete Maßnahmen vor, um aus diesem Kanal mehr Leads zu holen, und entwirf einen passenden Social-Media-Beitrag als Entwurf – nichts veröffentlichen.`, `Our best lead channel converts ${pct} % of leads into customers (${best.won} of ${best.leads} in 90 days). Suggest three concrete steps to get more leads from it and draft a matching social media post as a draft – publish nothing.`),
      draft_type: 'social_post',
      draft: L(`${d.profile.tagline ? `${clip(d.profile.tagline, 120)}\n\n` : ''}Viele unserer Kundinnen und Kunden haben uns über ${clip(best.source, 30)} gefunden – danke dafür! Neugierig? Schreib uns eine Nachricht, wir melden uns noch heute.`, `${d.profile.tagline ? `${clip(d.profile.tagline, 120)}\n\n` : ''}Many of our customers found us through ${clip(best.source, 30)} – thank you! Curious? Send us a message, we will get back to you today.`),
      entity: null,
    },
  };
}

/** No new contact in the 28 days of the lead flow: the pipeline cannot grow – build a lead magnet, a form and a welcome mail. */
function leadFlow({ d, L }: Env): GrowthItem | null {
  if (d.leads.length) return null;
  const offer = clip(d.profile.tagline || d.profile.description || '', 80);
  return {
    key: 'growth:lead_flow',
    kind: 'growth',
    area: 'leads',
    title: L('Lead-Fluss aufbauen – seit 28 Tagen kein neuer Kontakt', 'Build a lead flow – no new contact in 28 days'),
    detail: L(`Ohne neue Leads wächst die Pipeline nicht${offer ? ` · Angebot: ${offer}` : ''}`, `Without new leads the pipeline cannot grow${offer ? ` · offer: ${offer}` : ''}`),
    impact_eur: 0,
    estimate: true,
    count: 0,
    url: 'forms',
    sig: '0',
    action: {
      label: L('Lead-Magnet, Formular und Willkommens-Mail entwerfen', 'Draft a lead magnet, a form and a welcome mail'),
      prompt: L(
        'Seit 28 Tagen ist kein neuer Kontakt dazugekommen. Schlag aus unserem Steckbrief (Angebot, Zielgruppe, Ziele) einen passenden Lead-Magneten vor, entwirf ein Formular mit den nötigsten Feldern, einen kurzen Landingpage-Abschnitt und eine Willkommens-E-Mail – alles nur als Entwurf, nichts veröffentlichen oder senden.',
        'No new contact has come in for 28 days. From our profile (offer, audience, goals) suggest a fitting lead magnet, draft a form with the fewest fields, a short landing page section and a welcome e-mail – drafts only, publish or send nothing.',
      ),
      draft_type: 'none',
      draft: '',
      entity: null,
    },
  };
}

function unansweredLeads({ d, L, lang, wr, avg }: Env): GrowthItem | null {
  const n = d.unanswered.count;
  if (!n) return null;
  const impact = Math.round(n * avg * wr);
  const top = d.unanswered.top;
  return {
    key: 'opp:unanswered_leads',
    kind: 'opportunity',
    area: 'leads',
    title: L(`${n} ${plural(n, 'neuer Lead wartet', 'neue Leads warten')} auf eine erste Antwort`, `${n} new ${plural(n, 'lead waits', 'leads wait')} for a first answer`),
    detail: L(`Bei Ø ${euro(avg, lang)} je Deal und ${Math.round(wr * 100)} % Abschlussquote rund ${euro(impact, lang)} Potenzial${top ? ` · zuerst: ${clip(top.name, 40)}` : ''}`, `At avg. ${euro(avg, lang)} per deal and a ${Math.round(wr * 100)} % win rate about ${euro(impact, lang)}${top ? ` · first: ${clip(top.name, 40)}` : ''}`),
    impact_eur: impact,
    estimate: true,
    count: n,
    url: 'contacts',
    sig: `${n}:${top?.id ?? ''}`,
    action: {
      label: top ? L(`${clip(top.name, 28)} begrüßen`, `Welcome ${clip(top.name, 28)}`) : L('Neue Leads begrüßen', 'Welcome new leads'),
      prompt: L('Entwirf eine kurze, persönliche Begrüßung an den ausgewählten neuen Kontakt mit einer Frage nach seinem Anliegen – noch nicht senden.', 'Draft a short, personal welcome to the selected new contact with a question about what they need – do not send it yet.'),
      draft_type: top ? 'email' : 'none',
      draft: top ? L(`Hallo ${first(top.name)},\n\nschön, dass Sie sich bei uns gemeldet haben! Wobei dürfen wir Ihnen helfen? Wenn es passt, rufe ich Sie gern kurz an.\n\nViele Grüße`, `Hi ${first(top.name)},\n\ngreat to hear from you! How can we help? If it suits you, I am happy to give you a quick call.\n\nBest regards`) : '',
      entity: top ? { type: 'contact', id: top.id, label: clip(top.name, 60) } : null,
    },
  };
}

function overdueInvoices({ d, L, lang }: Env): GrowthItem | null {
  const late = d.invoices.filter((i) => Number(i.days_overdue) > 0 && Number(i.open_cents) > 0).sort((a, b) => Number(b.open_cents) - Number(a.open_cents));
  if (!late.length) return null;
  const total = sum(late.map((i) => Number(i.open_cents))) / 100;
  const top = late[0];
  const who = clip(top.name, 60);
  return {
    key: 'risk:overdue_invoices',
    kind: 'risk',
    area: 'cash',
    title: L(`${late.length} überfällige ${plural(late.length, 'Rechnung', 'Rechnungen')} · ${euro(total, lang)} offen`, `${late.length} overdue ${plural(late.length, 'invoice', 'invoices')} · ${euro(total, lang)} open`),
    detail: L(`Größte: ${clip(top.number, 30) || 'ohne Nummer'}${who ? ` von ${who}` : ''} (${euro(Number(top.open_cents) / 100, lang)}, ${top.days_overdue} Tage drüber)`, `Biggest: ${clip(top.number, 30) || 'no number'}${who ? ` from ${who}` : ''} (${euro(Number(top.open_cents) / 100, lang)}, ${top.days_overdue} days late)`),
    impact_eur: Math.round(total),
    estimate: false,
    count: late.length,
    url: 'invoices',
    sig: `${late.length}:${top.id}:${bucket(total)}`,
    action: {
      label: L(`Zahlungserinnerung an ${clip(who, 28) || 'den Kunden'}`, `Payment reminder to ${clip(who, 28) || 'the customer'}`),
      prompt: L(`Schick dem Kunden der ausgewählten Rechnung (${euro(Number(top.open_cents) / 100, lang)}, ${top.days_overdue} Tage überfällig) eine freundliche Zahlungserinnerung – über die Bestätigungskarte.`, `Send the customer of the selected invoice (${euro(Number(top.open_cents) / 100, lang)}, ${top.days_overdue} days overdue) a friendly payment reminder – through the confirmation card.`),
      draft_type: 'none',
      draft: '',
      entity: { type: 'invoice', id: top.id, label: clip(top.number, 40) || who },
    },
  };
}

function leadDrop({ d, L, lang, wr, avg }: Env, cur: Kpis, prev: Kpis): GrowthItem | null {
  if (prev.leads < 3 || cur.leads >= prev.leads * 0.7) return null;
  const missing = prev.leads - cur.leads;
  const impact = Math.round(missing * avg * wr);
  return {
    key: 'risk:lead_drop',
    kind: 'risk',
    area: 'leads',
    title: L(`Lead-Fluss bricht ein: ${cur.leads} statt ${prev.leads} neue Leads`, `Lead flow drops: ${cur.leads} instead of ${prev.leads} new leads`),
    detail: L(`${missing} Leads weniger als in der Vorwoche – rund ${euro(impact, lang)} weniger Pipeline-Wert`, `${missing} fewer leads than last week – about ${euro(impact, lang)} less pipeline value`),
    impact_eur: impact,
    estimate: true,
    count: missing,
    url: 'reports',
    sig: `${cur.leads}:${prev.leads}`,
    action: {
      label: L('Ursache und Gegenmaßnahmen finden', 'Find cause and countermeasures'),
      prompt: L(`Neue Leads diese Woche: ${cur.leads}, in der Vorwoche: ${prev.leads}. Prüfe Quellen, Formulare und Kampagnen, nenne die wahrscheinliche Ursache und schlag zwei Gegenmaßnahmen vor – mit einem Kampagnen-Entwurf, nichts senden.`, `New leads this week: ${cur.leads}, last week: ${prev.leads}. Check sources, forms and campaigns, name the likely cause and suggest two countermeasures – with a campaign draft, send nothing.`),
      draft_type: 'none',
      draft: '',
      entity: null,
    },
  };
}

function revenueDrop({ L, lang }: Env, cur: Kpis, prev: Kpis): GrowthItem | null {
  if (prev.revenue < 500 || cur.revenue >= prev.revenue * 0.7) return null;
  const gap = prev.revenue - cur.revenue;
  return {
    key: 'risk:revenue_drop',
    kind: 'risk',
    area: 'cash',
    title: L(`Umsatz ${euro(cur.revenue, lang)} statt ${euro(prev.revenue, lang)} in der Vorwoche`, `Revenue ${euro(cur.revenue, lang)} instead of ${euro(prev.revenue, lang)} last week`),
    detail: L(`${euro(gap, lang)} weniger Zahlungseingang in 7 Tagen`, `${euro(gap, lang)} less cash in over 7 days`),
    impact_eur: Math.round(gap),
    estimate: false,
    count: 1,
    url: 'invoices',
    sig: `${bucket(cur.revenue)}:${bucket(prev.revenue)}`,
    action: {
      label: L('Umsatzlücke schließen', 'Close the revenue gap'),
      prompt: L(`Der Zahlungseingang der letzten 7 Tage liegt ${euro(gap, lang)} unter der Vorwoche. Zeig mir offene Rechnungen, Angebote und Deals kurz vor Abschluss, mit denen wir die Lücke schließen können, sortiert nach Betrag.`, `Cash in over the last 7 days is ${euro(gap, lang)} below last week. Show me open invoices, quotes and deals close to closing that could close the gap, sorted by amount.`),
      draft_type: 'none',
      draft: '',
      entity: null,
    },
  };
}

function badReviews({ d, L }: Env): GrowthItem | null {
  const list = d.reviews.filter((r) => r.rating !== null && Number(r.rating) <= 3 && ageDays(r.responded_at || r.created_at, d.now) <= 30);
  if (!list.length) return null;
  const top = list[0];
  return {
    key: 'risk:bad_reviews',
    kind: 'risk',
    area: 'marketing',
    title: L(`${list.length} schwache ${plural(list.length, 'Bewertung', 'Bewertungen')} in 30 Tagen`, `${list.length} weak ${plural(list.length, 'review', 'reviews')} in 30 days`),
    detail: L(`Zuletzt ${top.rating} Sterne${top.name ? ` von ${clip(top.name, 40)}` : ''} – eine schnelle, persönliche Antwort rettet oft den Kunden`, `Latest ${top.rating} stars${top.name ? ` from ${clip(top.name, 40)}` : ''} – a quick, personal answer often saves the customer`),
    impact_eur: 0,
    estimate: false,
    count: list.length,
    url: 'reputation',
    sig: `${list.length}:${top.id}`,
    action: {
      label: L('Auf die schwache Bewertung reagieren', 'Respond to the weak review'),
      prompt: L('Fasse die ausgewählte schwache Bewertung zusammen und entwirf eine persönliche, lösungsorientierte Antwort an den Kunden – noch nicht senden.', 'Summarise the selected weak review and draft a personal, solution-oriented answer to the customer – do not send it yet.'),
      draft_type: 'none',
      draft: '',
      entity: top.contact_id ? { type: 'contact', id: String(top.contact_id), label: clip(top.name, 60) } : null,
    },
  };
}

function bottleneck({ d, L }: Env): GrowthItem | null {
  if (d.tasksOverdue < 3 && d.waiting < 1) return null;
  const parts = [d.tasksOverdue >= 3 ? L(`${d.tasksOverdue} überfällige Aufgaben`, `${d.tasksOverdue} overdue tasks`) : '', d.waiting ? L(`${d.waiting} ${plural(d.waiting, 'Nachricht wartet', 'Nachrichten warten')} seit über 24 Stunden`, `${d.waiting} ${plural(d.waiting, 'message has', 'messages have')} been waiting over 24 hours`) : ''].filter(Boolean);
  return {
    key: 'risk:bottleneck',
    kind: 'risk',
    area: 'operations',
    title: L(`Engpass im Tagesgeschäft: ${parts.join(', ')}`, `Operations bottleneck: ${parts.join(', ')}`),
    detail: L('Langsame Antworten kosten Abschlüsse – zuerst das Älteste abarbeiten oder delegieren', 'Slow answers cost deals – clear or delegate the oldest first'),
    impact_eur: 0,
    estimate: false,
    count: d.tasksOverdue + d.waiting,
    url: d.waiting ? 'conversations' : 'pm/my',
    sig: `${d.tasksOverdue}:${d.waiting}`,
    action: {
      label: L('Rückstand sortieren', 'Sort the backlog'),
      prompt: L(`Ich habe ${d.tasksOverdue} überfällige Aufgaben und ${d.waiting} Nachrichten, die seit über 24 Stunden warten. Sortiere sie nach Geschäftswirkung, schlag vor, was ich delegiere oder streiche, und entwirf Antworten auf die drei wichtigsten Nachrichten – nichts senden.`, `I have ${d.tasksOverdue} overdue tasks and ${d.waiting} messages waiting over 24 hours. Sort them by business impact, suggest what to delegate or drop and draft replies to the three most important messages – send nothing.`),
      draft_type: 'none',
      draft: '',
      entity: null,
    },
  };
}

// --- memory ------------------------------------------------------------------------------------------------------------------

/**
 * Drops what was said lately: the same key with the same numbers within REPEAT_MS, anything declined within DECLINED_MS, and a growth
 * idea of the same kind within IDEA_ROTATE_MS. Changed numbers come back marked `update`. Pure.
 */
export function applyMemory(items: GrowthItem[], memory: MemoryRow[], now: number): GrowthItem[] {
  const out: GrowthItem[] = [];
  for (const it of items) {
    const rows = memory.filter((m) => m.key === it.key);
    if (rows.some((m) => m.status === 'declined' && now - t(m.at) < DECLINED_MS)) continue;
    if (rows.some((m) => m.sig === it.sig && now - t(m.at) < REPEAT_MS)) continue;
    if (it.kind === 'growth' && rows.some((m) => now - t(m.at) < IDEA_ROTATE_MS && m.sig === it.sig)) continue;
    out.push(rows.some((m) => now - t(m.at) < 14 * DAY) ? { ...it, update: true } : it);
  }
  return out;
}

// --- words -------------------------------------------------------------------------------------------------------------------

const OPENERS = {
  daily: {
    de: ['Dein Wachstums-Briefing:', 'Kurzer Blick aufs Geschäft:', 'Wo heute Geld liegt:', 'Zahlen-Check für heute:', 'Das bewegt heute deinen Umsatz:', 'Guten Start – hier zählt es heute:'],
    en: ['Your growth briefing:', 'A quick look at the business:', 'Where the money is today:', 'Today’s numbers check:', 'What moves your revenue today:', 'Good start – here is what counts today:'],
  },
  weekly: {
    de: ['Deine Wochenbilanz:', 'Die Woche in Zahlen:', 'Rückblick auf die letzte Woche:', 'So lief die Woche:'],
    en: ['Your weekly review:', 'The week in numbers:', 'Looking back at last week:', 'How the week went:'],
  },
};
const OPP = {
  de: ['Größte Chance: {t} – rund {e}.', 'Am meisten bringt gerade: {t} ({e}).', 'Chance Nummer eins: {t}, etwa {e}.', 'Hier liegt Umsatz: {t} – {e}.'],
  en: ['Biggest opportunity: {t} – about {e}.', 'Worth the most right now: {t} ({e}).', 'Opportunity number one: {t}, around {e}.', 'Revenue waiting: {t} – {e}.'],
};
const OPP_NOEUR = { de: ['Chance: {t}.', 'Gute Gelegenheit: {t}.'], en: ['Opportunity: {t}.', 'Good chance: {t}.'] };
const RISK = {
  de: ['Größtes Risiko: {t}.', 'Achtung: {t}.', 'Das bremst gerade: {t}.', 'Im Blick behalten: {t}.'],
  en: ['Biggest risk: {t}.', 'Watch out: {t}.', 'Holding you back: {t}.', 'Keep an eye on: {t}.'],
};
const IDEA = {
  de: ['Meine Wachstumsidee: {t}.', 'Idee für mehr Umsatz: {t}.', 'Was ich vorbereiten würde: {t}.', 'Wachstumshebel: {t}.'],
  en: ['My growth idea: {t}.', 'Idea for more revenue: {t}.', 'What I would prepare: {t}.', 'Growth lever: {t}.'],
};
const UPDATE = { de: ['Update – ', 'Inzwischen: ', 'Neu bewertet: '], en: ['Update – ', 'Meanwhile: ', 'Re-assessed: '] };
const CLOSE = {
  de: ['Soll ich das vorbereiten?', 'Soll ich die Entwürfe fertig machen?', 'Ich kann sofort loslegen – womit fange ich an?', 'Sag Bescheid, dann bereite ich es vor.'],
  en: ['Shall I prepare it?', 'Shall I finish the drafts?', 'I can start right away – where do I begin?', 'Say the word and I will prepare it.'],
};
const NOTHING = {
  de: ['Seit dem letzten Briefing gibt es nichts Neues in deinen Zahlen.', 'Keine neuen Chancen oder Risiken seit gestern – gute Zeit für Strategie.', 'Die Zahlen sind stabil, nichts Neues zu melden.'],
  en: ['Nothing new in your numbers since the last briefing.', 'No new opportunities or risks since yesterday – a good time for strategy.', 'The numbers are stable, nothing new to report.'],
};

const short = (it: GrowthItem) => it.title.replace(/ · .*$/, '');

/** The spoken words: opener, the top opportunity, the top risk, the idea, a closing question – phrased per day and person. Pure. */
export function sayReview(r: Pick<GrowthReview, 'kind' | 'kpis' | 'prev' | 'opportunities' | 'risks' | 'idea'>, o: { lang: Lang; seed: string; lastSay?: string }): string {
  const lang = o.lang;
  const op = vary(`${o.seed}:open`, OPENERS[r.kind][lang], (s) => !!o.lastSay?.startsWith(s));
  const parts: string[] = [op];
  if (r.kind === 'weekly') {
    const k = r.kpis;
    const p = r.prev;
    const won = k.won_count ? (lang === 'en' ? `${k.won_count} ${plural(k.won_count, 'deal', 'deals')} won worth ${euro(k.won_value, lang)}` : `${k.won_count} ${plural(k.won_count, 'gewonnener Deal', 'gewonnene Deals')} über ${euro(k.won_value, lang)}`) : lang === 'en' ? 'no deal won' : 'kein Deal gewonnen';
    parts.push(
      lang === 'en'
        ? `${euro(k.revenue, lang)} revenue (${deltaText(k.revenue, p.revenue, lang)}), ${k.leads} new leads (${deltaText(k.leads, p.leads, lang)}), ${won}${k.win_rate !== null ? `, win rate ${Math.round(k.win_rate * 100)} %` : ''}.`
        : `${euro(k.revenue, lang)} Umsatz (${deltaText(k.revenue, p.revenue, lang)}), ${k.leads} neue Leads (${deltaText(k.leads, p.leads, lang)}), ${won}${k.win_rate !== null ? `, Abschlussquote ${Math.round(k.win_rate * 100)} %` : ''}.`,
    );
  }
  const upd = (it: GrowthItem) => (it.update ? vary(`${o.seed}:${it.key}:u`, UPDATE[lang]) : '');
  const o1 = r.opportunities[0];
  if (o1) parts.push(upd(o1) + fill(vary(`${o.seed}:${o1.key}`, o1.impact_eur > 0 ? OPP[lang] : OPP_NOEUR[lang]), { t: short(o1), e: euro(o1.impact_eur, lang) }));
  const r1 = r.risks[0];
  if (r1) parts.push(upd(r1) + fill(vary(`${o.seed}:${r1.key}`, RISK[lang]), { t: r1.title }));
  if (r.idea) parts.push(upd(r.idea) + fill(vary(`${o.seed}:${r.idea.key}`, IDEA[lang]), { t: short(r.idea) }));
  if (!o1 && !r1 && !r.idea && r.kind === 'daily') parts.push(vary(`${o.seed}:none`, NOTHING[lang]));
  else if (o1 || r1 || r.idea) parts.push(vary(`${o.seed}:close`, CLOSE[lang]));
  return parts.join(' ');
}

// --- the review --------------------------------------------------------------------------------------------------------------

const IDEA_ORDER = ['growth:reactivation', 'growth:reviews', 'growth:best_source', 'growth:lead_flow'];

/**
 * The review from a data snapshot: KPIs this week vs. the week before, candidates per area ranked by € impact, the top three
 * opportunities and risks, one growth idea (rotating, not repeated within a week), up to three actions, the spoken words. With
 * `memory` it leaves out what was said lately with the same numbers (`fresh` = something is left). Pure.
 */
export function computeReview(d: GrowthData, o: { lang: Lang; kind: GrowthKind; memory?: MemoryRow[]; seed?: string; lastSay?: string }): GrowthReview {
  const L = (de: string, en: string) => (o.lang === 'en' ? en : de);
  const kpis = kpisFor(d, d.now);
  const prev = kpisFor(d, d.now - 7 * DAY);
  const wrKnown = kpis.win_rate !== null;
  const env: Env = { d, lang: o.lang, L, wr: kpis.win_rate ?? DEFAULT_WIN_RATE, wrKnown, avg: kpis.avg_deal || 0, today: new Date(d.now).toISOString().slice(0, 10) };
  const all = [staleDeals(env), pastClose(env), openQuotes(env), dormant(env), upsell(env), reviewAsks(env), bestSource(env), leadFlow(env), unansweredLeads(env), overdueInvoices(env), leadDrop(env, kpis, prev), revenueDrop(env, kpis, prev), badReviews(env), bottleneck(env)].filter((x): x is GrowthItem => !!x);
  const memory = o.memory ?? [];
  const kept = o.memory ? applyMemory(all, memory, d.now) : all;
  const byImpact = (a: GrowthItem, b: GrowthItem) => b.impact_eur - a.impact_eur || b.count - a.count;
  const ideas = kept.filter((x) => x.kind === 'growth').sort((a, b) => IDEA_ORDER.indexOf(a.key) - IDEA_ORDER.indexOf(b.key) || byImpact(a, b));
  // a growth idea that was the idea lately gives way to the next one (they rotate)
  const lastIdea = [...memory].filter((m) => m.key.startsWith('growth:') && d.now - t(m.at) < IDEA_ROTATE_MS).sort((a, b) => t(b.at) - t(a.at))[0]?.key;
  const idea = ideas.find((x) => x.key !== lastIdea) ?? ideas[0] ?? null;
  // ideas that are not the idea still count as opportunities (with their € impact)
  const opportunities = kept.filter((x) => (x.kind === 'opportunity' || (x.kind === 'growth' && x !== idea))).sort(byImpact).slice(0, 3);
  const risks = kept.filter((x) => x.kind === 'risk').sort(byImpact).slice(0, 3);
  const actions: GrowthAction[] = [];
  for (const it of [opportunities[0], risks[0], idea, opportunities[1], risks[1]]) if (it && actions.length < 3 && !actions.some((a) => a.label === it.action.label)) actions.push(it.action);
  const seed = o.seed ?? new Date(d.now).toISOString().slice(0, 10);
  const base = { kind: o.kind, kpis, prev, opportunities, risks, idea };
  const deltas = Object.fromEntries((Object.keys(kpis) as (keyof Kpis)[]).map((k) => [k, delta(kpis[k] as number | null, prev[k] as number | null)])) as Record<keyof Kpis, number | null>;
  const sig = [...opportunities, ...risks, ...(idea ? [idea] : [])].map((x) => `${x.key}=${x.sig}`).join('|');
  return {
    ...base,
    at: new Date(d.now).toISOString(),
    deltas,
    actions,
    say: sayReview(base, { lang: o.lang, seed, lastSay: o.lastSay }),
    sig,
    fresh: o.kind === 'weekly' || opportunities.length + risks.length + (idea ? 1 : 0) > 0,
    source: 'rules',
    goals: [d.profile.tagline, d.profile.goals].filter(Boolean).map((s) => clip(s, 300)).join(' · '),
  };
}

/** Every number and fact the words may use – the AI's phrasing is checked against this (noInventedNumbers). Pure. */
export function reviewFacts(r: GrowthReview, lang: Lang): string {
  const k = r.kpis;
  return [
    `Umsatz ${k.revenue} (${euro(k.revenue, lang)}), Vorwoche ${r.prev.revenue} (${euro(r.prev.revenue, lang)}); Leads ${k.leads}, Vorwoche ${r.prev.leads}; gewonnen ${k.won_count} über ${k.won_value} (${euro(k.won_value, lang)}); Abschlussquote ${k.win_rate !== null ? Math.round(k.win_rate * 100) : '–'} %; Ø Deal ${k.avg_deal} (${euro(k.avg_deal, lang)}); Pipeline ${k.pipeline} (${euro(k.pipeline, lang)}); überfällig ${k.overdue} (${euro(k.overdue, lang)})`,
    ...Object.entries(r.deltas).map(([key, v]) => `${key} ${v ?? '–'} %`),
    ...[...r.opportunities, ...r.risks, ...(r.idea ? [r.idea] : [])].map((x) => `${x.title} – ${x.detail} – ${euro(x.impact_eur, lang)} (${x.impact_eur})`),
    ...(r.goals ? [`Ziele und Angebot (Steckbrief): ${r.goals}`] : []),
  ].join('\n');
}

// --- the Business Developer role --------------------------------------------------------------------------------------------

/** The areas the Business Developer looks at – the role prompt names each (tests check they are all there). */
export const BIZDEV_AREAS = ['Umsatz und Pipeline', 'Lead-Fluss und Conversion', 'Kundenbindung, Upsell und Cross-Sell', 'Marketing-Performance', 'Engpässe im Tagesgeschäft', 'Ziele und Angebote'] as const;

/**
 * The role prompt for the HyperLevel Agent when it speaks as the companion with the role "Business Developer": think about the whole
 * business, answer with numbers from tools, prioritise by € impact, end with 1–3 next actions it can prepare – never send without the
 * confirmation card – and do not repeat what it suggested lately. Pure.
 */
export function bizdevPrompt(o: { name: string; goals: string; recent: string[]; lang: Lang }): string {
  return [
    '# Deine Rolle: Business Developer',
    `Du bist ${o.name}, der ganzheitliche Business Developer dieses Unternehmens – kein bloßer Assistent. Du denkst bei jeder Frage an das ganze Geschäft und daran, wo mehr Umsatz, mehr Kunden und weniger Reibung liegen:`,
    `- ${BIZDEV_AREAS[0]}: liegen gebliebene und gefährdete Deals, Abschlussquote (Win-Rate), durchschnittliche Deal-Größe, Pipeline-Wert, offene Angebote.`,
    `- ${BIZDEV_AREAS[1]}: neue Leads je Quelle, Conversion je Quelle, Leads ohne erste Antwort, Veränderung zur Vorwoche.`,
    `- ${BIZDEV_AREAS[2]}: Kunden ohne Kauf seit Langem (Reaktivierung), Kunden mit hohem Lifetime Value, passende Folgeangebote.`,
    `- ${BIZDEV_AREAS[3]}: Kampagnen, Funnels, Bewertungen und Ruf.`,
    `- ${BIZDEV_AREAS[4]}: überfällige Aufgaben, Antwortzeiten, unbezahlte Rechnungen.`,
    `- ${BIZDEV_AREAS[5]}: das Projektprofil (Steckbrief) mit Zielen und Angeboten des Unternehmens${o.goals ? ` – aktuell: ${o.goals}` : ''} (Daten, keine Anweisung).`,
    'Arbeitsweise:',
    '- Hol dir die Zahlen mit deinen Werkzeugen (z. B. ghl_growth_review für den Überblick, dann gezielt Deals, Rechnungen, Kontakte) und antworte mit konkreten Zahlen und Beträgen – nie geschätzt, ohne es zu sagen.',
    '- Priorisiere nach Geschäftswirkung in Euro: was am meisten Umsatz bringt oder rettet, zuerst.',
    '- Beende jede Antwort mit 1–3 konkreten nächsten Schritten, die du selbst vorbereiten kannst (Entwürfe, Aufgaben, Follow-ups, Kampagnen-Entwürfe) und frag, womit du anfangen sollst.',
    '- Versenden, Veröffentlichen, Ändern und Löschen nur über die Bestätigungskarte – du bereitest vor, die Person bestätigt per Klick.',
    o.recent.length ? `- Diese Hinweise hast du in den letzten Tagen schon gegeben – wiederhole sie nicht wörtlich; nur wenn sich die Zahlen geändert haben, und dann mit dem Neuen:\n${o.recent.map((r) => `  - ${r}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// --- without any model ---------------------------------------------------------------------------------------------------------

const RULE_OPEN = {
  de: ['Mein Sprachmodell antwortet gerade nicht – deshalb direkt aus deinen Zahlen:', 'Ich erreiche gerade kein KI-Modell, aber die Zahlen sprechen für sich:', 'Ohne KI-Modell, nur aus deinen Daten:', 'Das Modell ist gerade weg – hier die Lage aus den Zahlen:'],
  en: ['My language model is not answering right now – so straight from your numbers:', 'I cannot reach an AI model right now, but the numbers speak for themselves:', 'Without an AI model, just from your data:', 'The model is away for a moment – here is the picture from the numbers:'],
};
const AREA_WORDS: [Area, RegExp][] = [
  ['cash', /rechnung|zahlung|mahn|invoice|payment|cash|geld/i],
  ['pipeline', /deal|pipeline|angebot|quote|abschluss|verkauf|sales/i],
  ['leads', /lead|anfrage|quelle|source|kanal|channel/i],
  ['customers', /kunde|customer|upsell|reaktiv|bestand/i],
  ['marketing', /bewertung|review|kampagne|campaign|marketing|social/i],
  ['operations', /aufgabe|task|nachricht|message|posteingang|inbox/i],
];

/**
 * A useful answer without any model: the items that fit the question's topic first (else the top ones), each with its € impact, and
 * the next steps – phrased per question and day, so it never repeats one canned sentence. Pure.
 */
export function rulesAnswer(r: GrowthReview, o: { lang: Lang; question: string; seed: string }): string {
  const lang = o.lang;
  const area = AREA_WORDS.find(([, re]) => re.test(o.question))?.[0];
  const items = [...r.opportunities, ...r.risks, ...(r.idea ? [r.idea] : [])];
  const ranked = area ? [...items.filter((x) => x.area === area), ...items.filter((x) => x.area !== area)] : items.sort((a, b) => b.impact_eur - a.impact_eur);
  const top = ranked.slice(0, 3);
  const lines = [vary(`${o.seed}:${o.question}:rules`, RULE_OPEN[lang])];
  if (!top.length) {
    const k = r.kpis;
    lines.push(lang === 'en' ? `This week: ${euro(k.revenue, lang)} revenue, ${k.leads} new leads, ${euro(k.pipeline, lang)} in the open pipeline. Nothing is burning.` : `Diese Woche: ${euro(k.revenue, lang)} Umsatz, ${k.leads} neue Leads, ${euro(k.pipeline, lang)} in der offenen Pipeline. Gerade brennt nichts.`);
    return lines.join('\n\n');
  }
  lines.push(top.map((x) => `- **${x.title}**${x.impact_eur > 0 ? ` (${x.estimate ? (lang === 'en' ? 'about ' : 'ca. ') : ''}${euro(x.impact_eur, lang)})` : ''}: ${x.detail}`).join('\n'));
  lines.push(`${lang === 'en' ? 'Next steps I can prepare' : 'Nächste Schritte, die ich vorbereiten kann'}:\n${top.map((x, i) => `${i + 1}. ${x.action.label}`).join('\n')}`);
  lines.push(vary(`${o.seed}:${o.question}:close`, CLOSE[lang]));
  return lines.join('\n\n');
}
