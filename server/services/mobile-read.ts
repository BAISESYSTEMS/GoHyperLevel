import type { App } from '../core/app.js';
import { notFound, type Ctx } from '../core/http.js';
import { addDaysYmd, tzOffsetMinutes } from '../core/time.js';
import { now } from '../core/util.js';
import { openCents, paidRevenueSql } from './invoice-model.js';
import { locationStats } from './location-stats.js';
import { bounds, byTz, callRoute, checkArea, clampInt, contactName, deepLink, dueOn, marks, overdue, ownLocation, plain, scope, type Loc } from './mobile.js';
import { maskContactFields, permits, resolve, scopeClauseFor, type Entity, type Resolved } from './record-access.js';

/**
 * Read side of the native app's API: compact, cross-sub-account lists and counters straight from
 * the tables the feature modules own (cheap indexed queries, no external calls except the optional
 * Social-Planner channel names). Every row carries location_id + location_name.
 */

const one = (app: App, sql: string, ...p: any[]) => Number(Object.values(app.db.get(sql, ...p) ?? { n: 0 })[0] ?? 0);
const ids = (locs: Loc[]) => locs.map((l) => l.id);
const names = (locs: Loc[]) => new Map(locs.map((l) => [l.id, l.name]));
const limitOf = (ctx: Ctx, def: number, max = 50) => clampInt(ctx.query.get('limit'), def, 1, max);
/**
 * The record-access rules (docs/sales.md) for what the app lists: " AND <clause>" over one or more sub-accounts (each has its own rules),
 * empty for people who see everything of that type. `alias` is the table's name or alias in the query.
 */
function narrow(app: App, ctx: Ctx, locs: Loc[], entity: Entity, alias: string): { sql: string; params: any[] } {
  const c = scopeClauseFor(app, ctx, ids(locs), entity, alias);
  return c ? { sql: ` AND ${c.sql}`, params: c.params } : { sql: '', params: [] };
}
/** The rules of the person in one sub-account (null = nothing narrowed). */
const rulesIn = (app: App, ctx: Ctx, locationId: string): Resolved | null => resolve(app, { ...ctx, locationId });
/** Ended inbound calls nobody answered (same rule as the call log's "missed"). */
const MISSED = `c.direction = 'in' AND c.answered = 0 AND c.status IN ('completed', 'missed', 'voicemail', 'busy', 'no-answer', 'failed', 'canceled')`;

function has(app: App, table: string): boolean {
  return !!app.db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table);
}

/** Daily series (oldest first, today last) of `valueSql` grouped by local day. */
function series(app: App, locs: Loc[], days: number, table: string, timeCol: string, valueSql: string, where = '1 = 1', whereParams: any[] = []): number[] {
  const out = Array<number>(days).fill(0);
  for (const [tz, group] of byTz(locs)) {
    const b = bounds(tz);
    const off = tzOffsetMinutes(new Date(), tz);
    const rows = app.db.all(
      `SELECT substr(datetime(${timeCol}, '${off >= 0 ? '+' : ''}${off} minutes'), 1, 10) AS day, ${valueSql} AS v FROM ${table}
       WHERE location_id IN (${marks(group.length)}) AND ${timeCol} >= ? AND ${where} GROUP BY day`,
      ...ids(group),
      b.daysAgo(days - 1),
      ...whereParams,
    );
    const start = Date.parse(`${b.today}T00:00:00Z`) - (days - 1) * 864e5;
    for (const r of rows) {
      const i = Math.round((Date.parse(`${r.day}T00:00:00Z`) - start) / 864e5);
      if (i >= 0 && i < days) out[i] += Number(r.v ?? 0);
    }
  }
  return out;
}

/** Stars across sub-accounts: Google (rating × total) where connected, otherwise the internal feedback. */
function rating(app: App, locs: Loc[]): { avg: number; count: number } | null {
  let sum = 0;
  let count = 0;
  for (const l of locs) {
    const g = has(app, 'google_places') ? app.db.get('SELECT rating, total FROM google_places WHERE location_id = ? AND rating IS NOT NULL AND total > 0', l.id) : undefined;
    if (g) {
      sum += Number(g.rating) * Number(g.total);
      count += Number(g.total);
      continue;
    }
    const r = app.db.get('SELECT AVG(rating) a, COUNT(rating) n FROM review_requests WHERE location_id = ? AND rating IS NOT NULL', l.id);
    if (r?.n) {
      sum += Number(r.a) * Number(r.n);
      count += Number(r.n);
    }
  }
  return count ? { avg: Math.round((sum / count) * 10) / 10, count } : null;
}

function websites(app: App, locs: Loc[]) {
  let up = 0;
  let down = 0;
  if (!has(app, 'project_checks')) return { up, down };
  for (const l of locs) {
    const last = app.db.get('SELECT ok FROM project_checks WHERE location_id = ? ORDER BY at DESC LIMIT 1', l.id);
    if (!last) continue;
    if (last.ok) up++;
    else down++;
  }
  return { up, down };
}

export function summary(app: App, ctx: Ctx) {
  const s = (a: Parameters<typeof scope>[2]) => scope(app, ctx, a, { strict: false });
  const contacts = s('contacts');
  const opps = s('opportunities');
  const pay = s('payments');
  const conv = s('conversations');
  const cal = s('calendars');
  const t = now();
  const out = {
    leads_today: 0,
    leads_7d: 0,
    open_deals_count: 0,
    open_deals_value_cents: 0,
    won_month_cents: 0,
    revenue_today_cents: 0,
    revenue_month_cents: 0,
    open_invoices_cents: 0,
    unread_conversations: 0,
    tasks_due_today: 0,
    tasks_overdue: 0,
    appointments_today: 0,
    missed_calls_today: 0,
    rating: rating(app, s('reviews')),
    websites: websites(app, s('project')),
    spark_revenue_30d: series(app, pay, 30, 'invoices', 'paid_at', `COALESCE(SUM(${paidRevenueSql()}), 0)`, `status = 'paid'`),
    spark_leads_14d: series(app, contacts, 14, 'contacts', 'created_at', 'COUNT(*)', `1 = 1${narrow(app, ctx, contacts, 'contacts', 'contacts').sql}`, narrow(app, ctx, contacts, 'contacts', 'contacts').params),
    currency: 'EUR',
    updated_at: t,
  };
  for (const [tz, g] of byTz(contacts)) {
    const b = bounds(tz);
    const q = marks(g.length);
    const cn = narrow(app, ctx, g, 'contacts', 'contacts');
    const tn = narrow(app, ctx, g, 'tasks', 'tasks');
    out.leads_today += one(app, `SELECT COUNT(*) FROM contacts WHERE location_id IN (${q}) AND created_at >= ?${cn.sql}`, ...ids(g), b.dayStart, ...cn.params);
    out.leads_7d += one(app, `SELECT COUNT(*) FROM contacts WHERE location_id IN (${q}) AND created_at >= ?${cn.sql}`, ...ids(g), b.daysAgo(6), ...cn.params);
    // The exact rules (date-only vs timed due dates) stay in dueOn()/overdue(); the extra range on due_at only
    // narrows what the index (location_id, done, due_at) has to read: every match lies inside it.
    const upper = t > `${b.today}T00:00:00.000Z` ? t : `${b.today}T00:00:00.000Z`;
    const dayLow = b.dayStart < `${b.today}T00:00:00` ? b.dayStart : `${b.today}T00:00:00`;
    const dayHigh = b.dayEnd > `${addDaysYmd(b.today, 1)}T00:00:00` ? b.dayEnd : `${addDaysYmd(b.today, 1)}T00:00:00`;
    out.tasks_due_today += one(app, `SELECT COUNT(*) FROM tasks WHERE location_id IN (${q}) AND done = 0 AND due_at >= ? AND due_at < ? AND ${dueOn()}${tn.sql}`, ...ids(g), dayLow, dayHigh, b.today, b.dayStart, b.dayEnd, ...tn.params);
    out.tasks_overdue += one(app, `SELECT COUNT(*) FROM tasks WHERE location_id IN (${q}) AND done = 0 AND due_at < ? AND ${overdue()}${tn.sql}`, ...ids(g), upper, b.today, t, ...tn.params);
  }
  for (const [tz, g] of byTz(opps)) {
    const b = bounds(tz);
    const q = marks(g.length);
    const dn = narrow(app, ctx, g, 'deals', 'opportunities');
    // Locations where the person may not see the amount of deals add nothing to the sums.
    const money = g.filter((l) => !rulesIn(app, ctx, l.id)?.hidden.deals.has('value'));
    const open = app.db.get(`SELECT COUNT(*) n, COALESCE(SUM(value), 0) v FROM opportunities WHERE location_id IN (${q}) AND status = 'open'${dn.sql}`, ...ids(g), ...dn.params)!;
    out.open_deals_count += Number(open.n);
    if (money.length === g.length) out.open_deals_value_cents += Number(open.v) * 100;
    if (money.length === g.length) out.won_month_cents += one(app, `SELECT COALESCE(SUM(value), 0) FROM opportunities WHERE location_id IN (${q}) AND status = 'won' AND COALESCE(closed_at, updated_at) >= ?${dn.sql}`, ...ids(g), b.monthStart, ...dn.params) * 100;
  }
  for (const [tz, g] of byTz(pay)) {
    const b = bounds(tz);
    const q = marks(g.length);
    out.revenue_today_cents += one(app, `SELECT COALESCE(SUM(${paidRevenueSql()}), 0) FROM invoices WHERE location_id IN (${q}) AND status = 'paid' AND paid_at >= ?`, ...ids(g), b.dayStart);
    out.revenue_month_cents += one(app, `SELECT COALESCE(SUM(${paidRevenueSql()}), 0) FROM invoices WHERE location_id IN (${q}) AND status = 'paid' AND paid_at >= ?`, ...ids(g), b.monthStart);
    out.open_invoices_cents += one(app, `SELECT COALESCE(SUM(MAX(0, total_cents - paid_cents - credited_cents - deducted_cents)), 0) FROM invoices WHERE location_id IN (${q}) AND kind = 'invoice' AND status = 'sent'`, ...ids(g));
  }
  for (const [tz, g] of byTz(conv)) {
    const b = bounds(tz);
    const q = marks(g.length);
    const vn = narrow(app, ctx, g, 'conversations', 'conversations');
    out.unread_conversations += one(app, `SELECT COUNT(*) FROM conversations WHERE location_id IN (${q}) AND unread > 0${vn.sql}`, ...ids(g), ...vn.params);
    if (has(app, 'calls')) out.missed_calls_today += one(app, `SELECT COUNT(*) FROM calls c WHERE c.location_id IN (${q}) AND ${MISSED} AND c.started_at >= ?`, ...ids(g), b.dayStart);
  }
  for (const [tz, g] of byTz(cal)) {
    const b = bounds(tz);
    out.appointments_today += one(
      app,
      `SELECT COUNT(*) FROM appointments WHERE location_id IN (${marks(g.length)}) AND status NOT IN ('cancelled', 'blocked') AND start_at >= ? AND start_at < ?`,
      ...ids(g),
      b.dayStart,
      b.dayEnd,
    );
  }
  return out;
}

export function inbox(app: App, ctx: Ctx) {
  const locs = scope(app, ctx, 'conversations');
  if (!locs.length) return [];
  const filter = [ctx.query.get('unread') === '1' ? 'AND unread > 0' : '', ctx.query.get('starred') === '1' ? 'AND starred = 1' : ''].join(' ');
  const limit = limitOf(ctx, 10);
  const n = names(locs);
  // The newest `limit` conversations of each sub-account (one index seek each), merged: with a
  // location IN (…) list SQLite would sort every conversation of every sub-account first.
  const top = locs
    .flatMap((l) => {
      const vn = narrow(app, ctx, [l], 'conversations', 'conversations');
      return app.db.all<{ id: string; last_message_at: string }>(`SELECT id, last_message_at FROM conversations WHERE location_id = ? ${filter}${vn.sql} ORDER BY last_message_at DESC LIMIT ?`, l.id, ...vn.params, limit);
    })
    .sort((a, b) => (a.last_message_at < b.last_message_at ? 1 : a.last_message_at > b.last_message_at ? -1 : 0))
    .slice(0, limit);
  if (!top.length) return [];
  return app.db
    .all(
      `SELECT v.*, c.first_name, c.last_name, c.email, c.phone,
         (SELECT m.channel || '|' || m.direction FROM messages m WHERE m.conversation_id = v.id ORDER BY m.created_at DESC LIMIT 1) AS last
       FROM conversations v JOIN contacts c ON c.id = v.contact_id
       WHERE v.id IN (${marks(top.length)}) ORDER BY v.last_message_at DESC`,
      ...top.map((t) => t.id),
    )
    .map((v) => {
      const [channel, direction] = String(v.last ?? '|').split('|');
      const rules = rulesIn(app, ctx, v.location_id);
      return {
        conversation_id: v.id,
        location_id: v.location_id,
        location_name: n.get(v.location_id) ?? '',
        contact_id: v.contact_id,
        contact_name: contactName(v),
        channel: channel || null,
        last_message: rules?.hidden.conversations.has('preview') ? '' : plain(v.last_message, 300),
        last_direction: direction || null,
        last_at: v.last_message_at,
        unread: Number(v.unread ?? 0),
        starred: !!v.starred,
      };
    });
}

export async function conversation(app: App, ctx: Ctx, conversationId: string) {
  const loc = ownLocation(app, ctx, 'conversations', conversationId, 'Konversation nicht gefunden');
  checkArea(app, ctx, loc.id, 'conversations');
  // Record-access rules: a conversation of somebody else's is "not found" for a person with a limited view.
  const rules = rulesIn(app, ctx, loc.id);
  if (!permits(app, rules, 'conversations', conversationId)) throw notFound('Konversation nicht gefunden');
  const v = app.db.get('SELECT * FROM conversations WHERE id = ?', conversationId)!;
  const c = maskContactFields(rules, app.db.get('SELECT id, first_name, last_name, email, phone FROM contacts WHERE id = ?', v.contact_id)!);
  if (!c) throw notFound('Konversation nicht gefunden');
  const limit = limitOf(ctx, 20, 100);
  const messages = app.db
    .all('SELECT id, direction, channel, subject, body, status, error, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?', v.id, limit)
    .reverse()
    .map(messageOut);
  const used = new Set(app.db.all('SELECT DISTINCT channel FROM messages WHERE conversation_id = ?', v.id).map((r) => r.channel as string));
  const channels: string[] = [];
  if (c.email) channels.push('email');
  if (c.phone) channels.push('sms');
  // WhatsApp, Messenger, Instagram: configured and this contact reachable there (meta-channels module).
  if (app.router.match('GET', '/api/messages/meta/status')) {
    try {
      const st = await callRoute(app, ctx, 'GET', `/api/messages/meta/status?contact_id=${encodeURIComponent(c.id)}`, { locationId: loc.id });
      for (const [ch, s] of Object.entries<any>(st?.channels ?? {})) if (s?.configured && s?.reachable) channels.push(ch);
    } catch {
      /* channel status is a nice-to-have */
    }
  }
  if (used.has('chat')) channels.push('chat');
  return {
    conversation_id: v.id,
    location_id: loc.id,
    location_name: loc.name,
    unread: Number(v.unread ?? 0),
    starred: !!v.starred,
    contact: { id: c.id, name: contactName(c), phone: c.phone || null, email: c.email || null },
    channels,
    messages,
  };
}

export function messageOut(m: any) {
  return { id: m.id, direction: m.direction, channel: m.channel, subject: m.subject || null, body: plain(m.body), at: m.created_at, status: m.status, error: m.error || null };
}

export function taskOut(t: any, n: Map<string, string>) {
  return {
    id: t.id,
    title: t.title,
    description: t.description ?? '',
    due_at: t.due_at ?? null,
    done: !!t.done,
    location_id: t.location_id,
    location_name: n.get(t.location_id) ?? '',
    contact_id: t.contact_id ?? null,
    contact_name: t.contact_id ? contactName(t) : null,
    assigned_to: t.assigned_to ?? null,
  };
}

export function tasks(app: App, ctx: Ctx) {
  const locs = scope(app, ctx, 'tasks');
  const filter = ctx.query.get('filter') ?? 'open';
  const limit = limitOf(ctx, 20, 100);
  const n = names(locs);
  const out: any[] = [];
  const t = now();
  for (const [tz, g] of byTz(locs)) {
    const b = bounds(tz);
    const where = [`t.location_id IN (${marks(g.length)})`, 't.done = 0'];
    const params: any[] = [...ids(g)];
    const tn = narrow(app, ctx, g, 'tasks', 't');
    if (tn.sql) (where.push(tn.sql.replace(/^ AND /, '')), params.push(...tn.params));
    if (filter === 'today') (where.push(`t.due_at IS NOT NULL AND ${dueOn('t.due_at')}`), params.push(b.today, b.dayStart, b.dayEnd));
    else if (filter === 'overdue') (where.push(`t.due_at IS NOT NULL AND ${overdue('t.due_at')}`), params.push(b.today, t));
    else if (filter === 'week') (where.push(`t.due_at IS NOT NULL AND t.due_at < ?`), params.push(b.daysAgo(-7)));
    else if (filter === 'done') where[1] = 't.done = 1';
    out.push(
      ...app.db.all(
        `SELECT t.*, c.first_name, c.last_name, c.email, c.phone FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id
         WHERE ${where.join(' AND ')} ORDER BY ${filter === 'done' ? 't.completed_at DESC' : "COALESCE(t.due_at, '9999'), t.created_at"} LIMIT ?`,
        ...params,
        limit,
      ),
    );
  }
  out.sort((a, b) => (filter === 'done' ? String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? '')) : String(a.due_at ?? '9999').localeCompare(String(b.due_at ?? '9999'))));
  return out.slice(0, limit).map((r) => taskOut(r, n));
}

const URL_RE = /https?:\/\/[^\s<>"']+/i;

export function appointmentOut(a: any, n: Map<string, string>) {
  let settings: any = {};
  try {
    settings = typeof a.calendar_settings === 'string' ? JSON.parse(a.calendar_settings) : (a.calendar_settings ?? {});
  } catch {
    /* ignore */
  }
  const place = String(settings.meeting_location ?? '').trim();
  // The video link made for this appointment (Team-Kalender) comes first, then the calendar's fixed place, then a link in the notes.
  const url = String(a.meeting_url ?? '').match(URL_RE)?.[0] ?? place.match(URL_RE)?.[0] ?? String(a.notes ?? '').match(URL_RE)?.[0] ?? null;
  return {
    id: a.id,
    title: a.title,
    start: a.start_at,
    end: a.end_at,
    status: a.status,
    contact_id: a.contact_id ?? null,
    contact_name: a.contact_id ? contactName(a) : null,
    phone: a.phone || null,
    meeting_url: url,
    host_id: a.assignee_id ?? null,
    address: place && !URL_RE.test(place) ? place : null,
    calendar_name: a.calendar_name ?? '',
    location_id: a.location_id,
    location_name: n.get(a.location_id) ?? '',
  };
}

export const APPOINTMENT_SELECT = `SELECT a.*, c.first_name, c.last_name, c.email, c.phone, k.name AS calendar_name, k.settings AS calendar_settings
  FROM appointments a LEFT JOIN contacts c ON c.id = a.contact_id JOIN calendars k ON k.id = a.calendar_id`;

export function appointments(app: App, ctx: Ctx) {
  const locs = scope(app, ctx, 'calendars');
  const days = clampInt(ctx.query.get('days'), 2, 1, 31);
  const n = names(locs);
  const out: any[] = [];
  for (const [tz, g] of byTz(locs)) {
    const b = bounds(tz);
    out.push(
      ...app.db.all(`${APPOINTMENT_SELECT} WHERE a.location_id IN (${marks(g.length)}) AND a.status != 'blocked' AND a.start_at >= ? AND a.start_at < ? ORDER BY a.start_at LIMIT 200`, ...ids(g), b.dayStart, b.daysAgo(-days)),
    );
  }
  return out.sort((a, b) => a.start_at.localeCompare(b.start_at)).map((a) => appointmentOut(a, n));
}

export function dealOut(o: any, n: Map<string, string>, stages: Map<string, string>) {
  return {
    id: o.id,
    name: o.name,
    value_cents: Number(o.value ?? 0) * 100,
    currency: o.currency || 'EUR',
    expected_close_date: o.expected_close_date ?? null,
    lost_reason: o.lost_reason || null,
    status: o.status,
    stage_id: o.stage_id,
    stage_name: stages.get(`${o.pipeline_id}:${o.stage_id}`) ?? '',
    pipeline_id: o.pipeline_id,
    contact_id: o.contact_id,
    contact_name: contactName(o),
    location_id: o.location_id,
    location_name: n.get(o.location_id) ?? '',
    updated_at: o.updated_at,
  };
}

export function stageNames(app: App, locIds: string[]): Map<string, string> {
  const m = new Map<string, string>();
  if (!locIds.length) return m;
  for (const p of app.db.all(`SELECT id, stages FROM pipelines WHERE location_id IN (${marks(locIds.length)})`, ...locIds)) {
    for (const s of JSON.parse(p.stages || '[]')) m.set(`${p.id}:${s.id}`, s.name);
  }
  return m;
}

export function deals(app: App, ctx: Ctx) {
  const locs = scope(app, ctx, 'opportunities');
  if (!locs.length) return { pipelines: [], top: [] };
  const n = names(locs);
  const q = marks(locs.length);
  const dn = narrow(app, ctx, locs, 'deals', 'opportunities');
  const counts = app.db.all(`SELECT pipeline_id, stage_id, COUNT(*) n, COALESCE(SUM(value), 0) v FROM opportunities WHERE location_id IN (${q}) AND status = 'open'${dn.sql} GROUP BY pipeline_id, stage_id`, ...ids(locs), ...dn.params);
  const cnt = new Map(counts.map((c) => [`${c.pipeline_id}:${c.stage_id}`, c]));
  const pipelines = app.db.all(`SELECT id, name, location_id, stages FROM pipelines WHERE location_id IN (${q}) ORDER BY created_at`, ...ids(locs)).map((p) => ({
    id: p.id,
    name: p.name,
    location_id: p.location_id,
    location_name: n.get(p.location_id) ?? '',
    stages: JSON.parse(p.stages || '[]').map((s: any) => {
      const c = cnt.get(`${p.id}:${s.id}`);
      return { id: s.id, name: s.name, count: Number(c?.n ?? 0), value_cents: rulesIn(app, ctx, p.location_id)?.hidden.deals.has('value') ? 0 : Number(c?.v ?? 0) * 100 };
    }),
  }));
  const stages = stageNames(app, ids(locs));
  // Pick the biggest deals from the index first, then load only those rows with their contacts.
  const topIds = app.db
    .all<{ id: string }>(`SELECT id FROM opportunities WHERE location_id IN (${q}) AND status = 'open'${dn.sql} ORDER BY value DESC, updated_at DESC LIMIT ?`, ...ids(locs), ...dn.params, limitOf(ctx, 10))
    .map((r) => r.id);
  const top = topIds.length
    ? app.db
        .all(
          `SELECT o.*, c.first_name, c.last_name, c.email, c.phone FROM opportunities o JOIN contacts c ON c.id = o.contact_id
           WHERE o.id IN (${marks(topIds.length)}) ORDER BY o.value DESC, o.updated_at DESC`,
          ...topIds,
        )
        .map((o) => {
          const rules = rulesIn(app, ctx, o.location_id);
          const out = dealOut(o, n, stages);
          return rules ? { ...maskContactFields(rules, out), ...(rules.hidden.deals.has('value') ? { value_cents: 0 } : {}) } : out;
        })
    : [];
  return { pipelines, top };
}

export function callOut(c: any, n: Map<string, string>) {
  const missed = c.direction === 'in' && !c.answered && ['completed', 'missed', 'voicemail', 'busy', 'no-answer', 'failed', 'canceled'].includes(c.status);
  return {
    id: c.id,
    direction: c.direction,
    status: c.status,
    missed,
    from: c.from_number || null,
    to: c.to_number || null,
    contact_id: c.contact_id ?? null,
    contact_name: c.contact_id ? contactName(c) : null,
    at: c.started_at,
    duration_s: Number(c.duration ?? 0),
    has_voicemail: c.status === 'voicemail' && !!c.recording_sid,
    summary: c.ai_summary || c.transcription || null,
    location_id: c.location_id,
    location_name: n.get(c.location_id) ?? '',
  };
}

export function calls(app: App, ctx: Ctx) {
  const locs = scope(app, ctx, 'calls');
  if (!locs.length || !has(app, 'calls')) return [];
  const n = names(locs);
  const where = [`c.location_id IN (${marks(locs.length)})`];
  if (ctx.query.get('missed') === '1') where.push(MISSED);
  // Record access: the calls of contacts this person may not open are not theirs to see (a call without a contact is nobody's).
  const kn = scopeClauseFor(app, ctx, ids(locs), 'contacts', 'k', 'c.location_id');
  if (kn) where.push(`(c.contact_id IS NULL OR ${kn.sql})`);
  const ai = has(app, 'voice_ai_sessions') ? `(SELECT s.summary FROM voice_ai_sessions s WHERE s.call_id = c.id AND s.summary != '' LIMIT 1)` : 'NULL';
  return app.db
    .all(
      `SELECT c.*, k.first_name, k.last_name, k.email, k.phone, ${ai} AS ai_summary FROM calls c LEFT JOIN contacts k ON k.id = c.contact_id
       WHERE ${where.join(' AND ')} ORDER BY c.started_at DESC LIMIT ?`,
      ...ids(locs),
      ...(kn?.params ?? []),
      limitOf(ctx, 10),
    )
    .map((c) => {
      const out = callOut(c, n);
      // …and a hidden phone number stays hidden with the call that carries it.
      return rulesIn(app, ctx, c.location_id)?.hidden.contacts.has('phone') ? { ...out, from: null, to: null } : out;
    });
}

export function projects(app: App, ctx: Ctx) {
  const locs = scope(app, ctx, 'project');
  if (!locs.length) return [];
  // Which sub-accounts the user may read tasks / the inbox of: decided once per area, not per project and counter.
  const mayTasks = new Set(scope(app, ctx, 'tasks', { strict: false }).map((l) => l.id));
  const mayInbox = new Set(scope(app, ctx, 'conversations', { strict: false }).map((l) => l.id));
  const stats = locationStats(app, ids(locs), undefined, ['tasks', 'inbox']);
  const q = marks(locs.length);
  const profiles = new Map(app.db.all<{ location_id: string; data: string }>(`SELECT location_id, data FROM project_profiles WHERE location_id IN (${q})`, ...ids(locs)).map((r) => [r.location_id, r.data]));
  const checks = has(app, 'project_checks');
  return locs.map((l) => {
    let data: any = {};
    try {
      data = JSON.parse(profiles.get(l.id) ?? '{}');
    } catch {
      /* ignore */
    }
    const last = checks ? app.db.get('SELECT at, ok, ms FROM project_checks WHERE location_id = ? ORDER BY at DESC LIMIT 1', l.id) : undefined;
    const claude = Array.isArray(data.claude_sessions) ? data.claude_sessions.find((c: any) => c?.url)?.url : undefined;
    const s = stats.get(l.id);
    return {
      location_id: l.id,
      location_name: l.name,
      name: l.name,
      status: data.status ?? 'entwicklung',
      website: data.website || null,
      uptime: { up: last ? !!last.ok : null, checked_at: last?.at ?? null, response_ms: last ? Number(last.ms) : null },
      open_tasks: mayTasks.has(l.id) ? (s?.open_tasks ?? 0) : 0,
      overdue_tasks: mayTasks.has(l.id) ? (s?.overdue_tasks ?? 0) : 0,
      unread: mayInbox.has(l.id) ? (s?.unread ?? 0) : 0,
      claude_url: claude ?? null,
      deep_link: deepLink('/app/project', l.id),
    };
  });
}

export function reviews(app: App, ctx: Ctx) {
  const locs = scope(app, ctx, 'reviews');
  const n = names(locs);
  const stars = rating(app, locs);
  const limit = limitOf(ctx, 5);
  if (!locs.length) return { avg: null, count: 0, delta_30d: null, new_30d: 0, latest: [] };
  const q = marks(locs.length);
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const google = has(app, 'google_reviews');
  const latest = [
    ...(google
      ? app.db
          .all(`SELECT * FROM google_reviews WHERE location_id IN (${q}) ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT ?`, ...ids(locs), limit)
          .map((r) => ({ id: r.id, author: r.author, rating: Number(r.rating), text: r.text ?? '', at: r.published_at ?? r.first_seen_at, source: 'google', replied: !!r.reply_text, location_id: r.location_id, location_name: n.get(r.location_id) ?? '', link: r.link || null }))
      : []),
    ...app.db
      .all(
        `SELECT r.*, c.first_name, c.last_name, c.email, c.phone FROM review_requests r LEFT JOIN contacts c ON c.id = r.contact_id
         WHERE r.location_id IN (${q}) AND r.rating IS NOT NULL ORDER BY r.responded_at DESC LIMIT ?`,
        ...ids(locs),
        limit,
      )
      .map((r) => ({ id: r.id, author: r.contact_id ? contactName(r) : 'Kunde', rating: Number(r.rating), text: r.comment ?? '', at: r.responded_at ?? r.created_at, source: 'intern', replied: false, location_id: r.location_id, location_name: n.get(r.location_id) ?? '', link: null })),
  ]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
  const new30 =
    one(app, `SELECT COUNT(*) FROM review_requests WHERE location_id IN (${q}) AND rating IS NOT NULL AND responded_at >= ?`, ...ids(locs), since) +
    (google ? one(app, `SELECT COUNT(*) FROM google_reviews WHERE location_id IN (${q}) AND COALESCE(published_at, first_seen_at) >= ?`, ...ids(locs), since) : 0);
  // Change of the Google rating over 30 days (rating-weighted across sub-accounts with history).
  let delta: number | null = null;
  if (has(app, 'google_review_stats')) {
    const day = since.slice(0, 10);
    let w = 0;
    let d = 0;
    for (const l of locs) {
      const last = app.db.get('SELECT rating, total FROM google_review_stats WHERE location_id = ? ORDER BY day DESC LIMIT 1', l.id);
      const ref = app.db.get('SELECT rating FROM google_review_stats WHERE location_id = ? AND day <= ? ORDER BY day DESC LIMIT 1', l.id, day) ?? app.db.get('SELECT rating FROM google_review_stats WHERE location_id = ? ORDER BY day LIMIT 1', l.id);
      if (!last || !ref) continue;
      const weight = Math.max(1, Number(last.total ?? 1));
      d += (Number(last.rating) - Number(ref.rating)) * weight;
      w += weight;
    }
    if (w) delta = Math.round((d / w) * 10) / 10;
  }
  return { avg: stars?.avg ?? null, count: stars?.count ?? 0, delta_30d: delta, new_30d: new30, latest };
}

export function payments(app: App, ctx: Ctx) {
  const locs = scope(app, ctx, 'payments');
  const n = names(locs);
  const out = { today_cents: 0, month_cents: 0, open_invoices_cents: 0, overdue_count: 0, latest: [] as any[], currency: 'EUR' };
  if (!locs.length) return out;
  const t = now();
  for (const [tz, g] of byTz(locs)) {
    const b = bounds(tz);
    const q = marks(g.length);
    out.today_cents += one(app, `SELECT COALESCE(SUM(${paidRevenueSql()}), 0) FROM invoices WHERE location_id IN (${q}) AND status = 'paid' AND paid_at >= ?`, ...ids(g), b.dayStart);
    out.month_cents += one(app, `SELECT COALESCE(SUM(${paidRevenueSql()}), 0) FROM invoices WHERE location_id IN (${q}) AND status = 'paid' AND paid_at >= ?`, ...ids(g), b.monthStart);
    // overdue from the day after the due day in each sub-account's zone (calendar days, like dunning and reports)
    out.overdue_count += one(app, `SELECT COUNT(*) FROM invoices WHERE location_id IN (${q}) AND kind = 'invoice' AND status = 'sent' AND total_cents - paid_cents - credited_cents - deducted_cents > 0 AND due_at IS NOT NULL AND due_at < ?`, ...ids(g), b.dayStart);
  }
  const q = marks(locs.length);
  const dayStartOf = new Map(locs.map((l) => [l.id, bounds(l.timezone || 'Europe/Berlin').dayStart]));
  out.open_invoices_cents = one(app, `SELECT COALESCE(SUM(MAX(0, total_cents - paid_cents - credited_cents - deducted_cents)), 0) FROM invoices WHERE location_id IN (${q}) AND kind = 'invoice' AND status = 'sent'`, ...ids(locs));
  out.latest = app.db
    .all(
      `SELECT i.id, i.kind, i.number, i.title, i.total_cents, i.paid_cents, i.credited_cents, i.deducted_cents, i.currency, i.status, i.paid_at, i.due_at, i.issued_at, i.location_id, c.first_name, c.last_name, c.email, c.phone, c.company, i.contact_id
       FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id
       WHERE i.location_id IN (${q}) AND i.status != 'draft' ORDER BY COALESCE(i.paid_at, i.sent_at, i.issued_at) DESC LIMIT ?`,
      ...ids(locs),
      limitOf(ctx, 5),
    )
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      number: i.number,
      title: i.title || `${i.kind === 'estimate' ? 'Angebot' : 'Rechnung'} ${i.number}`,
      contact_name: i.contact_id ? i.company || contactName(i) : null,
      total_cents: Number(i.total_cents ?? 0),
      currency: i.currency || 'EUR',
      status: i.status,
      overdue: i.kind === 'invoice' && i.status === 'sent' && openCents(i as any) > 0 && !!i.due_at && i.due_at < (dayStartOf.get(i.location_id) ?? t),
      paid_at: i.paid_at ?? null,
      location_id: i.location_id,
      location_name: n.get(i.location_id) ?? '',
    }));
  return out;
}

export async function social(app: App, ctx: Ctx) {
  const locs = scope(app, ctx, 'social');
  if (!locs.length || !has(app, 'social_posts')) return [];
  const n = names(locs);
  const t = now();
  const rows = app.db.all(
    `SELECT * FROM social_posts WHERE location_id IN (${marks(locs.length)})
     ORDER BY CASE WHEN publish_at >= ? THEN 0 ELSE 1 END, CASE WHEN publish_at >= ? THEN publish_at END ASC, publish_at DESC LIMIT ?`,
    ...ids(locs),
    t,
    t,
    limitOf(ctx, 5),
  );
  // Channel names come from the Social Planner (Postiz, cached there); without it the list stays empty.
  const kinds = new Map<string, string>();
  for (const locId of new Set(rows.map((r) => r.location_id as string))) {
    try {
      const r: any = await Promise.race([callRoute(app, ctx, 'GET', '/api/social', { locationId: locId }), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 3000).unref())]);
      for (const c of r?.channels ?? []) kinds.set(c.id, c.identifier);
    } catch {
      /* planner not reachable – channels stay unknown */
    }
  }
  return rows.map((p) => {
    const integrations: string[] = JSON.parse(p.integration_ids || '[]');
    return {
      id: p.id,
      text: p.content,
      scheduled_at: p.publish_at,
      status: p.type === 'draft' ? 'draft' : p.publish_at > t ? 'scheduled' : 'published',
      channels: [...new Set(integrations.map((i) => kinds.get(i)).filter(Boolean))] as string[],
      location_id: p.location_id,
      location_name: n.get(p.location_id) ?? '',
    };
  });
}

export function contactOut(c: any, n: Map<string, string>) {
  return { id: c.id, name: contactName(c), first_name: c.first_name ?? '', last_name: c.last_name ?? '', email: c.email || null, phone: c.phone || null, company: c.company || null, location_id: c.location_id, location_name: n.get(c.location_id) ?? '' };
}

export function contacts(app: App, ctx: Ctx) {
  const locs = scope(app, ctx, 'contacts');
  if (!locs.length) return [];
  const n = names(locs);
  const q = String(ctx.query.get('q') ?? '').trim().slice(0, 100);
  const where = [`location_id IN (${marks(locs.length)})`];
  const params: any[] = [...ids(locs)];
  if (q) {
    where.push(`(first_name || ' ' || last_name || ' ' || email || ' ' || phone || ' ' || company) LIKE ?`);
    params.push(`%${q}%`);
  }
  // Record-access rules: only the contacts the person may open, with the fields they may see.
  const cn = narrow(app, ctx, locs, 'contacts', 'contacts');
  if (cn.sql) (where.push(cn.sql.replace(/^ AND /, '')), params.push(...cn.params));
  return app.db
    .all(`SELECT id, location_id, first_name, last_name, email, phone, company FROM contacts WHERE ${where.join(' AND ')} ORDER BY ${q ? 'first_name, last_name' : 'COALESCE(last_activity_at, updated_at) DESC'} LIMIT ?`, ...params, limitOf(ctx, 20))
    .map((c) => contactOut(maskContactFields(rulesIn(app, ctx, c.location_id), c), n));
}

export { names as locationNames };
