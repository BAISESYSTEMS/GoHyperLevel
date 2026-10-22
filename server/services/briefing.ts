import type { App } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { addDaysYmd, hmInTz, ymdInTz, zonedToUtc } from '../core/time.js';
import { denial } from './boards-data.js';
import { callRoute } from './route-call.js';

/**
 * Brennpunkte und nächste Schritte – the companion's briefing (Fokus-Modus mit Companion, docs/living-boards.md#fokus-modus-mit-companion).
 * Rules only, so it works without AI: every signal is read through the viewer's own API routes (same guards, rights and SaaS
 * plan as their pages – a route they may not open simply adds nothing), ranked by urgency × impact, the top five kept. Each
 * hotspot carries a widget for the focus view and, where it makes sense, one concrete next step: a prompt for the HyperLevel
 * Agent (which still asks before anything goes out) or a page to open. A prompt never carries third-party text (contact names,
 * subjects, titles – they could hold instructions): it names the record as the agent's selected record (`entity`, read through
 * its ui_context as data), only the label people see names it. Never writes anything.
 */

export type Lang = 'de' | 'en';

export interface NextStep {
  key: string;
  label: string;
  /** what the companion hands to the agent when the person picks this step */
  prompt?: string;
  /** or a page in the app */
  url?: string;
  /** the record the step is about – handed to the agent as the selected record of its UI context (ui_context tool) */
  entity?: { type: string; id: string; label: string };
}

export interface Hotspot {
  key: string;
  title: string;
  detail: string;
  count: number;
  /** urgency × impact, higher first */
  score: number;
  /** the page to check it on (app path without /app/) */
  url: string;
  /** a Living Boards widget for the focus view */
  tile?: { type: string; title: string; config: Record<string, unknown> };
  step?: NextStep;
  /** what makes it this hotspot (ids, counts) – the check-ins' "only when something changed" compares these */
  sig: string;
}

export interface BriefingCore {
  hotspots: Hotspot[];
  next: NextStep[];
  say: string;
  sig: string;
}

export const MAX_HOTSPOTS = 5;
export const MAX_STEPS = 3;

const euro = (v: number, lang: Lang) => new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v || 0);
const nameOf = (c: any) => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.contact_name || c?.name || c?.email || c?.phone || '';
const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "seit 3 Stunden" / "for 2 days". */
function waited(ms: number, lang: Lang): string {
  const h = Math.floor(ms / 3600_000);
  if (h < 1) return lang === 'en' ? 'for less than an hour' : 'seit weniger als einer Stunde';
  if (h < 48) return lang === 'en' ? `for ${h} ${plural(h, 'hour', 'hours')}` : `seit ${h} ${plural(h, 'Stunde', 'Stunden')}`;
  const d = Math.floor(h / 24);
  return lang === 'en' ? `for ${d} days` : `seit ${d} Tagen`;
}

type Collector = (env: Env) => Promise<Hotspot | Hotspot[] | null>;
interface Env {
  app: App;
  ctx: Ctx;
  lang: Lang;
  tz: string;
  now: Date;
  L: (de: string, en: string) => string;
  get: (path: string) => Promise<any>;
}

// --- the signals --------------------------------------------------------------------------------------------------------

const overdueTasks: Collector = async ({ get, L, now }) => {
  const r = await get('/api/pm/tasks?done=open&assignee=me&due=overdue&sort=due&limit=5');
  const total = Number(r?.total) || 0;
  const tasks: any[] = r?.tasks ?? [];
  if (!total || !tasks.length) return null;
  const top = tasks[0];
  const days = top.due_at ? Math.max(1, Math.floor((now.getTime() - new Date(top.due_at).getTime()) / 864e5)) : 1;
  const title = clip(top.title, 80);
  return {
    key: 'overdue_tasks',
    title: L(`${total} überfällige ${plural(total, 'Aufgabe', 'Aufgaben')}`, `${total} overdue ${plural(total, 'task', 'tasks')}`),
    detail: L(`Am längsten offen: „${title}“ (${days} ${plural(days, 'Tag', 'Tage')} drüber)`, `Oldest: “${title}” (${days} ${plural(days, 'day', 'days')} late)`),
    count: total,
    score: 50 + Math.min(total, 10) * 4 + Math.min(days, 10),
    url: 'pm/my',
    tile: { type: 'tasks', title: L('Meine überfälligen Aufgaben', 'My overdue tasks'), config: { due: 'overdue', mine: true, limit: 6 } },
    step: { key: `task:${top.id}`, label: L(`„${clip(top.title, 40)}“ angehen`, `Tackle “${clip(top.title, 40)}”`), prompt: L('Was steht bei der ausgewählten überfälligen Aufgabe an? Fasse sie kurz zusammen und schlag mir den nächsten Schritt vor.', 'What is the selected overdue task about? Summarise it briefly and suggest the next step.'), entity: { type: 'task', id: String(top.id), label: title } },
    sig: `t:${total}:${tasks.map((t) => t.id).join(',')}`,
  };
};

const invoices: Collector = async ({ get, L, lang }) => {
  const list: any[] = (await get('/api/invoices')) ?? [];
  const late = list.filter((i) => Number(i.days_overdue) > 0 && Number(i.open_cents) > 0).sort((a, b) => Number(b.days_overdue) - Number(a.days_overdue));
  if (!late.length) return null;
  const sum = late.reduce((n, i) => n + Number(i.open_cents), 0) / 100;
  const top = late[0];
  const who = clip(nameOf(top) || top.company || L('dem Kunden', 'the customer'), 60);
  const num = top.number || L('ohne Nummer', 'without number');
  const amount = euro(Number(top.open_cents) / 100, lang);
  return {
    key: 'overdue_invoices',
    title: L(`${late.length} überfällige ${plural(late.length, 'Rechnung', 'Rechnungen')} · ${euro(sum, lang)} offen`, `${late.length} overdue ${plural(late.length, 'invoice', 'invoices')} · ${euro(sum, lang)} open`),
    detail: L(`Am längsten offen: ${num} von ${who} (${amount}, ${top.days_overdue} Tage)`, `Longest open: ${num} from ${who} (${amount}, ${top.days_overdue} days)`),
    count: late.length,
    score: 52 + Math.min(late.length, 10) * 3 + (sum >= 1000 ? 10 : 0) + Math.min(Number(top.days_overdue), 30) / 3,
    url: 'invoices',
    tile: { type: 'kpi', title: L('Überfällige Rechnungen', 'Overdue invoices'), config: { preset: 'overdue_invoices' } },
    step: { key: `invoice:${top.id}`, label: L(`Erinnerung an ${clip(who, 30)} senden`, `Send ${clip(who, 30)} a reminder`), prompt: L(`Schick dem Kunden der ausgewählten Rechnung ${num} (${amount}, ${top.days_overdue} Tage überfällig) eine freundliche Zahlungserinnerung.`, `Send the customer of the selected invoice ${num} (${amount}, ${top.days_overdue} days overdue) a friendly payment reminder.`), entity: { type: 'invoice', id: String(top.id), label: String(num) } },
    sig: `i:${late.length}:${late.slice(0, 5).map((i) => i.id).join(',')}`,
  };
};

const dunning: Collector = async ({ get, L }) => {
  const o = await get('/api/dunning/overview');
  const failed = (Number(o?.cases?.failed) || 0) + (Number(o?.cases?.open) || 0);
  const pending = Number(o?.notices?.pending) || 0;
  if (!failed && !pending) return null;
  const parts = [failed ? L(`${failed} fehlgeschlagene ${plural(failed, 'Zahlung', 'Zahlungen')}`, `${failed} failed ${plural(failed, 'payment', 'payments')}`) : '', pending ? L(`${pending} ${plural(pending, 'Mahnung wartet', 'Mahnungen warten')} auf Freigabe`, `${pending} dunning ${plural(pending, 'notice awaits', 'notices await')} approval`) : ''].filter(Boolean);
  return {
    key: 'dunning',
    title: parts.join(' · '),
    detail: L('Im Mahnwesen prüfen und freigeben', 'Check and approve in dunning'),
    count: failed + pending,
    score: 48 + failed * 4 + pending * 3,
    url: 'dunning',
    step: pending ? { key: 'dunning', label: L('Mahnungen freigeben', 'Approve dunning notices'), url: 'dunning' } : undefined,
    sig: `d:${failed}:${pending}`,
  };
};

const inbox: Collector = async ({ get, L, lang, now }) => {
  const list: any[] = (await get('/api/conversations?filter=unread&limit=50')) ?? [];
  if (!list.length) return null;
  const oldest = [...list].sort((a, b) => String(a.last_message_at).localeCompare(String(b.last_message_at)))[0];
  const wait = Math.max(0, now.getTime() - new Date(oldest.last_message_at || now).getTime());
  const who = clip(nameOf(oldest) || L('Kontakt', 'contact'), 60);
  return {
    key: 'inbox',
    title: L(`${list.length}${list.length >= 50 ? '+' : ''} ungelesene ${plural(list.length, 'Konversation', 'Konversationen')}`, `${list.length}${list.length >= 50 ? '+' : ''} unread ${plural(list.length, 'conversation', 'conversations')}`),
    detail: L(`Wartet am längsten: ${who} (${waited(wait, lang)})`, `Waiting longest: ${who} (${waited(wait, lang)})`),
    count: list.length,
    score: 44 + Math.min(list.length, 10) * 3 + (wait > 24 * 3600_000 ? 16 : wait > 4 * 3600_000 ? 8 : 0),
    url: 'conversations',
    tile: { type: 'inbox', title: L('Ungelesene Nachrichten', 'Unread messages'), config: { only_unread: true, limit: 6 } },
    step: { key: `reply:${oldest.id}`, label: L(`${clip(who, 30)} antworten`, `Reply to ${clip(who, 30)}`), prompt: L('Entwirf eine Antwort auf die letzte Nachricht der ausgewählten Konversation – noch nicht senden, erst zeigen.', 'Draft a reply to the last message of the selected conversation – do not send it yet, show it first.'), entity: { type: 'conversation', id: String(oldest.id), label: who } },
    sig: `c:${list.length}:${oldest.id}`,
  };
};

const deals: Collector = async ({ get, L, lang, now, tz }) => {
  const list: any[] = (await get('/api/opportunities?status=open')) ?? [];
  const today = ymdInTz(now, tz);
  const idle = (d: any) => Math.floor((now.getTime() - new Date(d.stage_changed_at ?? d.updated_at ?? now).getTime()) / 864e5);
  const late = list.filter((d) => (d.expected_close_date && String(d.expected_close_date).slice(0, 10) < today) || idle(d) >= 14);
  if (!late.length) return null;
  const hot = [...late].sort((a, b) => Number(b.value) - Number(a.value))[0];
  const value = euro(Number(hot.value), lang);
  const past = hot.expected_close_date && String(hot.expected_close_date).slice(0, 10) < today;
  const name = clip(hot.name, 60);
  return {
    key: 'deals',
    title: L(`${late.length} ${plural(late.length, 'Deal braucht', 'Deals brauchen')} Pflege`, `${late.length} ${plural(late.length, 'deal needs', 'deals need')} attention`),
    detail: past ? L(`Größter: „${name}“ (${value}) – Abschlussdatum überschritten`, `Biggest: “${name}” (${value}) – close date passed`) : L(`Größter: „${name}“ (${value}) – seit ${idle(hot)} Tagen unberührt`, `Biggest: “${name}” (${value}) – untouched for ${idle(hot)} days`),
    count: late.length,
    score: 40 + Math.min(late.length, 10) * 2 + (Number(hot.value) >= 5000 ? 14 : 6),
    url: `opportunities?pipeline=${hot.pipeline_id}`,
    tile: { type: 'list', title: L('Deals seit 14 Tagen unberührt', 'Deals untouched for 14 days'), config: { entity: 'deals', status: 'open', stale_days: 14, sort: 'oldest', limit: 6 } },
    step: { key: `deal:${hot.id}`, label: L(`„${clip(hot.name, 32)}“ nachfassen`, `Follow up “${clip(hot.name, 32)}”`), prompt: L(`Hilf mir, den ausgewählten Deal (${value}) nachzufassen: Fasse den Stand zusammen und entwirf eine kurze Nachricht an den Kontakt – noch nicht senden.`, `Help me follow up the selected deal (${value}): summarise where it stands and draft a short message to the contact – do not send it yet.`), entity: { type: 'opportunity', id: String(hot.id), label: name } },
    sig: `o:${late.length}:${hot.id}`,
  };
};

const appointments: Collector = async ({ get, L, now, tz }) => {
  const today = ymdInTz(now, tz);
  const to = zonedToUtc(addDaysYmd(today, 1), '00:00', tz).toISOString();
  const list: any[] = (await get(`/api/appointments?from=${encodeURIComponent(now.toISOString())}&to=${encodeURIComponent(to)}`)) ?? [];
  const next = list.filter((a) => !['cancelled', 'canceled', 'blocked'].includes(a.status) && new Date(a.start_at).getTime() >= now.getTime()).sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
  if (!next.length) return null;
  const a = next[0];
  const mins = Math.round((new Date(a.start_at).getTime() - now.getTime()) / 60_000);
  const time = hmInTz(new Date(a.start_at), tz);
  const title = clip(a.title || nameOf(a) || L('Termin', 'appointment'), 60);
  return {
    key: 'appointments',
    title: L(`${next.length} ${plural(next.length, 'Termin', 'Termine')} heute noch`, `${next.length} more ${plural(next.length, 'appointment', 'appointments')} today`),
    detail: mins <= 90 ? L(`Gleich: ${time} „${title}“ (in ${mins} Minuten)`, `Soon: ${time} “${title}” (in ${mins} minutes)`) : L(`Nächster: ${time} „${title}“`, `Next: ${time} “${title}”`),
    count: next.length,
    score: mins <= 60 ? 72 : mins <= 180 ? 46 : 24 + next.length * 2,
    url: 'calendars',
    tile: { type: 'agenda', title: L('Heute', 'Today'), config: { days: 1 } },
    step: { key: `meeting:${a.id}`, label: L(`Termin um ${time} vorbereiten`, `Prepare the ${time} meeting`), prompt: L(`Bereite mich auf den ausgewählten Termin um ${time} vor: Wer ist dabei, was ist der Stand, worauf sollte ich achten?`, `Prepare me for the selected appointment at ${time}: who is it, where do things stand, what should I watch out for?`), entity: { type: 'appointment', id: String(a.id), label: title } },
    sig: `a:${next.length}:${a.id}`,
  };
};

const tickets: Collector = async ({ get, L }) => {
  const r = await get('/api/tickets?state=open&sort=priority&limit=50');
  const list: any[] = r?.tickets ?? [];
  const breached = list.filter((t) => t.sla_first_state === 'breached' || t.sla_resolution_state === 'breached');
  const warning = list.filter((t) => !breached.includes(t) && (t.sla_first_state === 'warning' || t.sla_resolution_state === 'warning'));
  const urgent = list.filter((t) => t.priority === 'dringend' && !breached.includes(t) && !warning.includes(t));
  const hot = [...breached, ...warning, ...urgent];
  if (!hot.length) return null;
  const top = hot[0];
  const subject = clip(top.subject, 60);
  return {
    key: 'tickets',
    title: breached.length || warning.length ? L(`${breached.length + warning.length} ${plural(breached.length + warning.length, 'Ticket', 'Tickets')} an oder über der SLA-Frist`, `${breached.length + warning.length} ${plural(breached.length + warning.length, 'ticket', 'tickets')} at or past the SLA`) : L(`${urgent.length} ${plural(urgent.length, 'dringendes Ticket', 'dringende Tickets')}`, `${urgent.length} urgent ${plural(urgent.length, 'ticket', 'tickets')}`),
    detail: L(`Zuerst: #${top.number} „${subject}“`, `First: #${top.number} “${subject}”`),
    count: hot.length,
    score: 50 + breached.length * 6 + warning.length * 3 + urgent.length * 3,
    url: `tickets/${top.id}`,
    tile: { type: 'list', title: L('Offene Tickets nach Priorität', 'Open tickets by priority'), config: { entity: 'tickets', ticket_state: 'open', sort: 'priority', limit: 6 } },
    step: { key: `ticket:${top.id}`, label: L(`Ticket #${top.number} beantworten`, `Answer ticket #${top.number}`), prompt: L(`Fasse das ausgewählte Ticket #${top.number} zusammen und entwirf eine Antwort – noch nicht senden.`, `Summarise the selected ticket #${top.number} and draft a reply – do not send it yet.`), entity: { type: 'ticket', id: String(top.id), label: `#${top.number} ${subject}` } },
    sig: `k:${hot.map((t) => t.id).slice(0, 5).join(',')}:${breached.length}`,
  };
};

const workflowErrors: Collector = async ({ app, ctx, L, now }) => {
  // the automations area decides; the count itself is one small query (there is no list of failed runs across workflows)
  if (denial(app, ctx, '/api/workflows')) return null;
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const rows = app.db.all<{ name: string; n: number; id: string }>(
    `SELECT w.id, w.name, COUNT(*) AS n FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
     WHERE w.location_id = ? AND r.status = 'failed' AND r.updated_at >= ? GROUP BY w.id ORDER BY n DESC LIMIT 5`,
    ctx.locationId,
    since,
  );
  const n = rows.reduce((s, r) => s + Number(r.n), 0);
  if (!n) return null;
  const top = rows[0];
  return {
    key: 'workflow_errors',
    title: L(`${n} fehlgeschlagene ${plural(n, 'Automation', 'Automationen')} in 24 Stunden`, `${n} failed automation ${plural(n, 'run', 'runs')} in 24 hours`),
    detail: L(`Am häufigsten: „${clip(top.name, 60)}“ (${top.n}×)`, `Most often: “${clip(top.name, 60)}” (${top.n}×)`),
    count: n,
    score: 34 + Math.min(n, 10) * 2,
    url: `workflows/${top.id}`,
    step: { key: `wf:${top.id}`, label: L(`Fehler in „${clip(top.name, 28)}“ ansehen`, `Look at “${clip(top.name, 28)}”`), url: `workflows/${top.id}` },
    sig: `w:${n}:${top.id}`,
  };
};

const website: Collector = async ({ get, L, tz }) => {
  const p = await get('/api/project');
  const last = p?.uptime?.last;
  if (!p?.website || p.monitor === false || !last || last.ok) return null;
  const since = last.at ? hmInTz(new Date(last.at), tz) : '';
  return {
    key: 'website_down',
    title: L('Website nicht erreichbar', 'Website unreachable'),
    detail: L(`${clip(p.website, 60)} antwortet nicht${last.status ? ` (Status ${last.status})` : ''}${since ? ` – geprüft ${since}` : ''}`, `${clip(p.website, 60)} does not answer${last.status ? ` (status ${last.status})` : ''}${since ? ` – checked ${since}` : ''}`),
    count: 1,
    score: 85,
    url: 'project',
    step: { key: 'website', label: L('Website prüfen', 'Check the website'), url: 'project' },
    sig: `u:${last.at ?? ''}`,
  };
};

const stock: Collector = async ({ get, L }) => {
  const r = await get('/api/inventory/low-stock');
  const list: any[] = Array.isArray(r) ? r : (r?.items ?? r?.articles ?? []);
  if (!list.length) return null;
  const top = list[0];
  return {
    key: 'low_stock',
    title: L(`${list.length} ${plural(list.length, 'Artikel', 'Artikel')} unter Mindestbestand`, `${list.length} ${plural(list.length, 'item', 'items')} below minimum stock`),
    detail: L(`Zum Beispiel: ${clip(top.name ?? top.sku, 60)}`, `For example: ${clip(top.name ?? top.sku, 60)}`),
    count: list.length,
    score: 30 + Math.min(list.length, 10) * 2,
    url: 'inventory',
    step: { key: 'restock', label: L('Nachbestellung vorbereiten', 'Prepare a reorder'), prompt: L('Welche Artikel liegen unter dem Mindestbestand? Schlag mir eine Nachbestellung je Lieferant vor – noch nichts bestellen.', 'Which items are below minimum stock? Suggest a reorder per supplier – do not order anything yet.') },
    sig: `s:${list.length}:${list.slice(0, 5).map((x) => x.id ?? x.sku).join(',')}`,
  };
};

const approvals: Collector = async ({ get, L }) => {
  const list: any[] = (await get('/api/agent/approvals')) ?? [];
  if (!list.length) return null;
  return {
    key: 'approvals',
    title: L(`${list.length} ${plural(list.length, 'Freigabe wartet', 'Freigaben warten')} auf dich`, `${list.length} ${plural(list.length, 'approval waits', 'approvals wait')} for you`),
    detail: L(`Zuerst: ${clip(list[0].summary || list[0].tool, 80)}`, `First: ${clip(list[0].summary || list[0].tool, 80)}`),
    count: list.length,
    score: 46 + Math.min(list.length, 10) * 3,
    url: 'agents/approvals',
    step: { key: 'approvals', label: L('Freigaben prüfen', 'Review approvals'), url: 'agents/approvals' },
    sig: `p:${list.map((x) => x.id).slice(0, 5).join(',')}`,
  };
};

export const COLLECTORS: Record<string, Collector> = { overdueTasks, invoices, dunning, inbox, deals, appointments, tickets, workflowErrors, website, stock, approvals };

// --- ranking and words ----------------------------------------------------------------------------------------------------

/** Highest score first, the top five; equal scores keep the order of the signals. Pure. */
export function rankHotspots(list: Hotspot[], max = MAX_HOTSPOTS): Hotspot[] {
  return list
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.count > 0)
    .sort((a, b) => b.h.score - a.h.score || a.i - b.i)
    .slice(0, max)
    .map(({ h }) => h);
}

/** One to three steps from the most urgent hotspots. Pure. */
export function nextSteps(hotspots: Hotspot[], max = MAX_STEPS): NextStep[] {
  const out: NextStep[] = [];
  for (const h of hotspots) if (h.step && !out.some((s) => s.key === h.step!.key)) out.push(h.step);
  return out.slice(0, max);
}

/** Stable fingerprint of what burns – the same hotspots give the same signature. */
export const briefingSig = (hotspots: Hotspot[]) => hotspots.map((h) => `${h.key}=${h.sig}`).join('|');

/**
 * The first name to greet with – '' for a caller without a person's name: an API key (sub-account or agency key, whose stand-in user
 * is called "API: <label>"), the "KI-App" actor, an e-mail address or nothing at all. Then the greeting is just "Guten Abend." Pure.
 */
export function greetingName(user: { id?: string; name?: string | null } | null | undefined, viaApiKey = false): string {
  if (!user || viaApiKey || String(user.id ?? '').startsWith('key:')) return '';
  const full = String(user.name ?? '').trim();
  if (!full || /^api\s*:/i.test(full) || full === 'KI-App' || full.includes('@')) return '';
  const first = full.split(/\s+/)[0].replace(/[^\p{L}\p{M}'’.-]/gu, '');
  return /\p{L}/u.test(first) ? first.slice(0, 40) : '';
}

/** The spoken mentor sentence by the rules: greeting, how many things need the person, the top ones, the first step. Pure. */
export function rulesSay(hotspots: Hotspot[], next: NextStep[], o: { lang: Lang; hm: string; name?: string }): string {
  const L = (de: string, en: string) => (o.lang === 'en' ? en : de);
  const h = Number(o.hm.slice(0, 2));
  const hello = h < 11 ? L('Guten Morgen', 'Good morning') : h < 18 ? L('Hallo', 'Hello') : L('Guten Abend', 'Good evening');
  const who = o.name ? `, ${o.name}` : '';
  if (!hotspots.length) return L(`${hello}${who}. Gerade brennt nichts – gute Zeit, um am Wachstum zu arbeiten.`, `${hello}${who}. Nothing is burning right now – a good time to work on growth.`);
  const n = hotspots.length;
  const top = hotspots
    .slice(0, 2)
    .map((x) => x.title)
    .join(L(' und ', ' and '));
  const first = next[0] ? L(` Mein Vorschlag: ${next[0].label}.`, ` My suggestion: ${next[0].label}.`) : '';
  return L(`${hello}${who}. ${n} ${plural(n, 'Sache braucht', 'Sachen brauchen')} dich: ${top}.${first}`, `${hello}${who}. ${n} ${plural(n, 'thing needs', 'things need')} you: ${top}.${first}`);
}

/** All signals for one viewer (each read with their rights; a refused or failing one adds nothing), ranked. */
export async function collectBriefing(app: App, ctx: Ctx, o: { lang: Lang; now?: Date; name?: string }): Promise<BriefingCore> {
  const now = o.now ?? new Date();
  const tz = app.location(ctx.locationId)?.timezone || 'Europe/Berlin';
  const L = (de: string, en: string) => (o.lang === 'en' ? en : de);
  const env: Env = { app, ctx, lang: o.lang, tz, now, L, get: (path) => callRoute(app, ctx, 'GET', path, {}, { quiet: true }) };
  const found = await Promise.all(
    Object.values(COLLECTORS).map((c) =>
      c(env).catch(() => null), // a 403 (area not granted), a missing module or broken data: this signal stays silent
    ),
  );
  const hotspots = rankHotspots(found.flat().filter((x): x is Hotspot => !!x));
  const next = nextSteps(hotspots);
  return { hotspots, next, say: rulesSay(hotspots, next, { lang: o.lang, hm: hmInTz(now, tz), name: o.name }), sig: briefingSig(hotspots) };
}
