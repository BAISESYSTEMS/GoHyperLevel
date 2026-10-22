import type { App } from '../core/app.js';
import { bad, str } from '../core/http.js';
import { addDaysYmd, ymdInTz, zonedToUtc } from '../core/time.js';
import { id, now } from '../core/util.js';
import { renderMarkdown } from './markdown.js';
import { getContact, logActivity } from './contacts.js';
import { createPost, notify, type Author } from './community-actions.js';
import { extOf, type ChecklistItem } from './community-ext.js';
import { TEAM, sendDm } from './community-dm.js';
import { monthlyValue, tierPrices, tiersOf, type Tier } from './community-tiers.js';

/**
 * Growth tools: the numbers (members over time, MRR, churn, trial conversion, DAU, posts, top contributors, engagement), the
 * welcome of new members (DM, post, onboarding checklist), segments of members and broadcasts to them.
 */

const tzOf = (app: App, locationId: string) => app.location(locationId)?.timezone || 'Europe/Berlin';

// --- segments ----------------------------------------------------------------------------------------------------------------

export interface Segment {
  tier_ids?: string[];
  min_level?: number;
  /** Members who were active on at least one day in the last N days. */
  active_days?: number;
  /** Members who were NOT active in the last N days (re-engagement). */
  inactive_days?: number;
  tags?: string[];
}

export function cleanSegment(app: App, g: { id: string; location_id: string }, input: any): Segment {
  const s = input && typeof input === 'object' ? input : {};
  const out: Segment = {};
  if (Array.isArray(s.tier_ids) && s.tier_ids.length) {
    const ok = new Set(tiersOf(app, g.id).map((t) => t.id));
    out.tier_ids = [...new Set<string>(s.tier_ids.map(String))];
    if (out.tier_ids.some((t) => !ok.has(t))) throw bad('Eine der Stufen gehört nicht zu dieser Gruppe');
  }
  const n = (v: unknown, what: string, max: number) => {
    if (v === undefined || v === null || v === '') return undefined;
    const x = Math.round(Number(v));
    if (!Number.isFinite(x) || x < 1 || x > max) throw bad(`${what}: 1 bis ${max}`);
    return x;
  };
  out.min_level = n(s.min_level, 'Mindest-Level', 50);
  out.active_days = n(s.active_days, 'Aktiv in den letzten Tagen', 365);
  out.inactive_days = n(s.inactive_days, 'Nicht aktiv seit Tagen', 365);
  if (Array.isArray(s.tags) && s.tags.length) out.tags = [...new Set<string>(s.tags.map((t: unknown) => String(t).trim().slice(0, 60)).filter(Boolean))].slice(0, 10);
  for (const k of Object.keys(out) as (keyof Segment)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** SQL for contacts of a group (not banned) who match a segment – `contacts` is the table the caller selects from. */
export function segmentSql(app: App, groupId: string, segment: Segment = {}, tz = 'Europe/Berlin', at = new Date()): { sql: string; params: any[] } {
  const conds = ['m.group_id = ?', 'm.contact_id = contacts.id', 'm.location_id = contacts.location_id', 'm.banned_at IS NULL'];
  const params: any[] = [groupId];
  if (segment.min_level && segment.min_level > 1) (conds.push('m.level >= ?'), params.push(segment.min_level));
  if (segment.tier_ids?.length) {
    conds.push(`EXISTS (SELECT 1 FROM community_memberships ms WHERE ms.group_id = m.group_id AND ms.contact_id = m.contact_id AND ms.tier_id IN (${segment.tier_ids.map(() => '?').join(',')}))`);
    params.push(...segment.tier_ids);
  }
  const day = (n: number) => addDaysYmd(ymdInTz(at, tz), -n);
  if (segment.active_days) (conds.push('EXISTS (SELECT 1 FROM community_active_days d WHERE d.group_id = m.group_id AND d.contact_id = m.contact_id AND d.day >= ?)'), params.push(day(segment.active_days)));
  if (segment.inactive_days) (conds.push('NOT EXISTS (SELECT 1 FROM community_active_days d WHERE d.group_id = m.group_id AND d.contact_id = m.contact_id AND d.day >= ?)'), params.push(day(segment.inactive_days)));
  let sql = `EXISTS (SELECT 1 FROM community_members m WHERE ${conds.join(' AND ')})`;
  for (const t of segment.tags ?? []) {
    sql += ' AND EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)';
    params.push(t);
  }
  return { sql, params };
}

export function segmentContacts(app: App, g: { id: string; location_id: string }, segment: Segment = {}, limit = 100_000) {
  const { sql, params } = segmentSql(app, g.id, segment, tzOf(app, g.location_id));
  return app.db.all<{ id: string; email: string; dnd: number }>(`SELECT id, email, dnd FROM contacts WHERE location_id = ? AND ${sql} LIMIT ?`, g.location_id, ...params, limit);
}

// --- analytics ---------------------------------------------------------------------------------------------------------------

export interface Analytics {
  range: { days: number; from: string; to: string; tz: string };
  totals: Record<string, number>;
  members: { day: string; total: number; joined: number; left: number }[];
  dau: { day: string; n: number }[];
  activity: { day: string; posts: number; comments: number }[];
  top_contributors: { contact_id: string; name: string; handle: string; points: number; posts: number; comments: number }[];
  revenue: { currency: string; mrr_cents: number; arr_cents: number; trial_mrr_cents: number; one_time_cents: number; paying: number; trialing: number; past_due: number; by_tier: { tier_id: string; name: string; members: number; mrr_cents: number }[] };
  churn: { left: number; paying_left: number; members_rate: number; paying_rate: number };
  trials: { started: number; active: number; converted: number; lost: number; conversion_rate: number | null };
  requests: { pending: number; approved: number; rejected: number };
}

export function analytics(app: App, g: { id: string; location_id: string; name: string }, days = 30, at = new Date()): Analytics {
  const { db } = app;
  days = Math.min(Math.max(Math.round(days) || 30, 7), 366);
  const tz = tzOf(app, g.location_id);
  const today = ymdInTz(at, tz);
  const from = addDaysYmd(today, -(days - 1));
  const fromIso = zonedToUtc(from, '00:00', tz).toISOString();
  const nowIso = at.toISOString();
  const dayOf = (iso: string) => ymdInTz(new Date(iso), tz);
  const dayList = Array.from({ length: days }, (_x, i) => addDaysYmd(from, i));
  const bucket = (rows: { t: string }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.t) m.set(dayOf(r.t), (m.get(dayOf(r.t)) ?? 0) + 1);
    return m;
  };

  // Members over time: from today's number backwards through joins and leaves.
  const current = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_members WHERE group_id = ? AND banned_at IS NULL', g.id)!.n;
  const joinsRaw = db.all<{ t: string }>(
    `SELECT joined_at AS t FROM community_members WHERE group_id = ? AND banned_at IS NULL AND joined_at >= ?
     UNION ALL SELECT joined_at FROM community_memberships WHERE group_id = ? AND status = 'canceled' AND joined_at >= ?`,
    g.id,
    fromIso,
    g.id,
    fromIso,
  );
  const leavesRaw = db.all<{ t: string }>(`SELECT canceled_at AS t FROM community_memberships WHERE group_id = ? AND status = 'canceled' AND canceled_at >= ?`, g.id, fromIso);
  const joins = bucket(joinsRaw);
  const leaves = bucket(leavesRaw);
  const members: Analytics['members'] = [];
  let total = current;
  for (const d of [...dayList].reverse()) {
    members.push({ day: d, total, joined: joins.get(d) ?? 0, left: leaves.get(d) ?? 0 });
    total = total - (joins.get(d) ?? 0) + (leaves.get(d) ?? 0);
  }
  members.reverse();

  const dauMap = new Map(db.all<{ day: string; n: number }>('SELECT day, COUNT(*) AS n FROM community_active_days WHERE group_id = ? AND day >= ? GROUP BY day', g.id, from).map((r) => [r.day, r.n]));
  const dau = dayList.map((d) => ({ day: d, n: dauMap.get(d) ?? 0 }));
  const distinctSince = (n: number) => db.get<{ n: number }>('SELECT COUNT(DISTINCT contact_id) AS n FROM community_active_days WHERE group_id = ? AND day >= ?', g.id, addDaysYmd(today, -(n - 1)))!.n;
  const wau = distinctSince(7);
  const mau = distinctSince(30);

  const postsMap = bucket(db.all<{ t: string }>(`SELECT created_at AS t FROM community_posts WHERE group_id = ? AND created_at >= ? AND status != 'deleted' LIMIT 200000`, g.id, fromIso));
  const commentsMap = bucket(db.all<{ t: string }>(`SELECT created_at AS t FROM community_comments WHERE group_id = ? AND created_at >= ? AND status != 'deleted' LIMIT 200000`, g.id, fromIso));
  const activity = dayList.map((d) => ({ day: d, posts: postsMap.get(d) ?? 0, comments: commentsMap.get(d) ?? 0 }));

  const top = db
    .all<{ contact_id: string; pts: number }>('SELECT contact_id, COALESCE(SUM(points), 0) AS pts FROM community_points WHERE group_id = ? AND created_at >= ? GROUP BY contact_id HAVING pts > 0 ORDER BY pts DESC LIMIT 10', g.id, fromIso)
    .map((r) => {
      const pr = db.get<{ display_name: string; handle: string }>('SELECT display_name, handle FROM community_profiles WHERE location_id = ? AND contact_id = ?', g.location_id, r.contact_id);
      return {
        contact_id: r.contact_id,
        name: pr?.display_name ?? 'Mitglied',
        handle: pr?.handle ?? '',
        points: r.pts,
        posts: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_posts WHERE group_id = ? AND contact_id = ? AND created_at >= ? AND status = 'visible'`, g.id, r.contact_id, fromIso)!.n,
        comments: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_comments WHERE group_id = ? AND contact_id = ? AND created_at >= ? AND status = 'visible'`, g.id, r.contact_id, fromIso)!.n,
      };
    });

  // Money: monthly recurring revenue (net) of paying memberships; trials are listed apart.
  const tiers = new Map<string, Tier>(tiersOf(app, g.id).map((t) => [t.id, t]));
  const live = db.all<{ tier_id: string | null; status: string; billing: string; joined_at: string | null }>(`SELECT tier_id, status, billing, joined_at FROM community_memberships WHERE group_id = ? AND status IN ('active','trialing','past_due')`, g.id);
  let currency = 'EUR';
  let mrr = 0;
  let trialMrr = 0;
  let oneTime = 0;
  const byTier = new Map<string, { tier_id: string; name: string; members: number; mrr_cents: number }>();
  for (const m of live) {
    const t = m.tier_id ? tiers.get(m.tier_id) : undefined;
    if (!t) continue;
    const prices = tierPrices(app, t);
    const p = prices.month ?? prices.year ?? prices.once;
    if (p) currency = p.currency;
    const row = byTier.get(t.id) ?? { tier_id: t.id, name: t.name, members: 0, mrr_cents: 0 };
    row.members++;
    if (m.billing === 'month' || m.billing === 'year') {
      const v = monthlyValue(app, t, m.billing as 'month' | 'year');
      if (m.status === 'trialing') trialMrr += v;
      else (mrr += v, (row.mrr_cents += v));
    } else if (m.billing === 'once' && m.joined_at && m.joined_at >= fromIso) oneTime += prices.once?.price_cents ?? 0;
    byTier.set(t.id, row);
  }
  const count = (status: string) => live.filter((m) => m.status === status).length;
  const paying = live.filter((m) => (m.billing === 'month' || m.billing === 'year') && m.status !== 'trialing').length;

  // Churn: those who left during the range against those there at its start.
  const leftRows = db.all<{ billing: string }>(`SELECT billing FROM community_memberships WHERE group_id = ? AND status = 'canceled' AND canceled_at >= ?`, g.id, fromIso);
  const joinedInRange = joinsRaw.length;
  const atStart = Math.max(0, current - joinedInRange + leftRows.length);
  const payingLeft = leftRows.filter((r) => r.billing === 'month' || r.billing === 'year').length;
  const payingJoined = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_memberships WHERE group_id = ? AND billing IN ('month','year') AND status IN ('active','past_due') AND COALESCE(converted_at, joined_at) >= ?`, g.id, fromIso)!.n;
  const payingAtStart = Math.max(0, paying - payingJoined + payingLeft);
  const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

  const trialsStarted = db.all<{ converted_at: string | null; trial_ends_at: string | null; status: string }>('SELECT converted_at, trial_ends_at, status FROM community_memberships WHERE group_id = ? AND trial_started_at >= ?', g.id, fromIso);
  const finished = trialsStarted.filter((x) => x.converted_at || (x.trial_ends_at && x.trial_ends_at <= nowIso) || x.status === 'canceled');
  const converted = trialsStarted.filter((x) => x.converted_at).length;

  const reqs = Object.fromEntries(db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM community_memberships WHERE group_id = ? GROUP BY status', g.id).map((r) => [r.status, r.n]));
  const posts = activity.reduce((a, r) => a + r.posts, 0);
  const comments = activity.reduce((a, r) => a + r.comments, 0);

  return {
    range: { days, from, to: today, tz },
    totals: {
      members: current,
      new_in_range: joinedInRange,
      left_in_range: leftRows.length,
      dau_today: dauMap.get(today) ?? 0,
      dau_avg: Math.round((dau.reduce((a, r) => a + r.n, 0) / days) * 10) / 10,
      wau,
      mau,
      engagement_rate: rate(mau, current),
      posts,
      comments,
      posts_per_day: Math.round((posts / days) * 10) / 10,
      comments_per_day: Math.round((comments / days) * 10) / 10,
    },
    members,
    dau,
    activity,
    top_contributors: top,
    revenue: { currency, mrr_cents: mrr, arr_cents: mrr * 12, trial_mrr_cents: trialMrr, one_time_cents: oneTime, paying, trialing: count('trialing'), past_due: count('past_due'), by_tier: [...byTier.values()].sort((a, b) => b.mrr_cents - a.mrr_cents) },
    churn: { left: leftRows.length, paying_left: payingLeft, members_rate: rate(leftRows.length, atStart), paying_rate: rate(payingLeft, payingAtStart) },
    trials: { started: trialsStarted.length, active: trialsStarted.filter((x) => !x.converted_at && x.status === 'trialing').length, converted, lost: finished.length - converted, conversion_rate: finished.length ? rate(converted, finished.length) : null },
    requests: { pending: reqs.pending ?? 0, approved: (reqs.active ?? 0) + (reqs.trialing ?? 0), rejected: reqs.rejected ?? 0 },
  };
}

// --- welcome -----------------------------------------------------------------------------------------------------------------

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{\s*(name|first_name|group|mention)\s*\}\}/g, (_m, k) => vars[k] ?? '');

/** The welcome message and post of a group for a new member – once per person and group. */
export function welcomeMember(app: App, g: any, contactId: string): { dm: boolean; post: boolean } {
  const out = { dm: false, post: false };
  const ext = extOf(app, g.id).welcome;
  if (!ext.dm.enabled && !ext.post.enabled) return out;
  if (!app.db.run('INSERT OR IGNORE INTO community_welcome (group_id, contact_id, sent_at) VALUES (?, ?, ?)', g.id, contactId, now()).changes) return out;
  const c = getContact(app, g.location_id, contactId);
  if (!c) return out;
  const pr = app.db.get<{ display_name: string; handle: string }>('SELECT display_name, handle FROM community_profiles WHERE location_id = ? AND contact_id = ?', g.location_id, contactId);
  const vars = { name: pr?.display_name || c.first_name || 'neues Mitglied', first_name: c.first_name || pr?.display_name || '', group: g.name, mention: pr?.handle ? `@${pr.handle}` : '' };
  const sender = ext.dm.sender.trim() || 'Team';
  if (ext.dm.enabled && ext.dm.text.trim()) {
    try {
      sendDm(app, g.location_id, TEAM, contactId, fill(ext.dm.text, vars), { fromName: sender, skipLimits: true });
      out.dm = true;
    } catch (e) {
      console.error('[community] welcome dm', (e as Error).message);
    }
  }
  if (ext.post.enabled) {
    const ch = (ext.post.channel_id && app.db.get<any>('SELECT * FROM community_channels WHERE id = ? AND group_id = ?', ext.post.channel_id, g.id)) || app.db.get<any>('SELECT * FROM community_channels WHERE group_id = ? AND admin_only = 0 ORDER BY position, created_at', g.id);
    if (ch) {
      try {
        const author: Author = { kind: 'team', userId: 'welcome', name: sender };
        createPost(app, g, ch, author, { title: fill(ext.post.title, vars), body: `${fill(ext.post.body, vars)}${vars.mention && !ext.post.body.includes('{{mention}}') ? `\n\n${vars.mention}` : ''}` }, { bypassLock: true });
        out.post = true;
      } catch (e) {
        console.error('[community] welcome post', (e as Error).message);
      }
    }
  }
  if (out.dm || out.post) logActivity(app, g.location_id, contactId, 'community.welcomed', `Willkommen in „${g.name}“ (${[out.dm && 'Nachricht', out.post && 'Beitrag'].filter(Boolean).join(' und ')})`);
  return out;
}

// --- onboarding checklist ------------------------------------------------------------------------------------------------------

export interface CheckState extends ChecklistItem {
  done: boolean;
  href: string;
}

/** What a member has done so far on the checklist (kinds are detected, "custom" items are ticked by hand). */
export function checklistOf(app: App, g: any, contactId: string, hrefs: { profile: string; compose: string; start: string; challenges: string; feed: string }): { items: CheckState[]; done: number; total: number; dismissed: boolean; window_open: boolean } | undefined {
  const ext = extOf(app, g.id);
  const cl = ext.welcome.checklist;
  if (!cl.enabled || !cl.items.length) return undefined;
  const member = app.db.get<{ joined_at: string }>('SELECT joined_at FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, contactId);
  if (!member) return undefined;
  const marks = new Map(app.db.all<{ item_id: string }>('SELECT item_id FROM community_checklist WHERE group_id = ? AND contact_id = ?', g.id, contactId).map((r) => [r.item_id, true]));
  const n = (sql: string, ...p: any[]) => (app.db.get<{ n: number }>(sql, ...p)?.n ?? 0) > 0;
  const profile = app.db.get<{ bio: string; avatar_file_id: string | null }>('SELECT bio, avatar_file_id FROM community_profiles WHERE location_id = ? AND contact_id = ?', g.location_id, contactId);
  const detect: Record<ChecklistItem['kind'], () => boolean> = {
    profile: () => !!profile && (!!profile.avatar_file_id || profile.bio.trim().length >= 10),
    intro: () => n(`SELECT COUNT(*) AS n FROM community_posts p JOIN community_channels c ON c.id = p.channel_id WHERE p.group_id = ? AND p.contact_id = ? AND p.status = 'visible' AND (c.slug LIKE '%vorstell%' OR c.slug LIKE '%intro%' OR c.slug LIKE '%hallo%' OR c.slug LIKE '%welcome%')`, g.id, contactId) || n(`SELECT COUNT(*) AS n FROM community_posts WHERE group_id = ? AND contact_id = ? AND status = 'visible'`, g.id, contactId),
    post: () => n(`SELECT COUNT(*) AS n FROM community_posts WHERE group_id = ? AND contact_id = ? AND status = 'visible'`, g.id, contactId),
    comment: () => n(`SELECT COUNT(*) AS n FROM community_comments WHERE group_id = ? AND contact_id = ? AND status = 'visible'`, g.id, contactId),
    like: () => n('SELECT COUNT(*) AS n FROM community_likes WHERE group_id = ? AND contact_id = ?', g.id, contactId),
    challenge: () => n('SELECT COUNT(*) AS n FROM community_challenge_members m JOIN community_challenges c ON c.id = m.challenge_id WHERE c.group_id = ? AND m.contact_id = ?', g.id, contactId),
    start_here: () => !!ext.start_here.post_id && n('SELECT COUNT(*) AS n FROM community_reads WHERE post_id = ? AND contact_id = ?', ext.start_here.post_id, contactId),
    custom: () => false,
  };
  const href: Record<ChecklistItem['kind'], string> = { profile: hrefs.profile, intro: hrefs.compose, post: hrefs.compose, comment: hrefs.feed, like: hrefs.feed, challenge: hrefs.challenges, start_here: hrefs.start, custom: '' };
  const items = cl.items.map((it) => ({ ...it, done: it.kind === 'custom' ? marks.has(it.id) : detect[it.kind]() || marks.has(it.id), href: href[it.kind] }));
  const window_open = Date.now() - Date.parse(member.joined_at) <= cl.days * 864e5;
  return { items, done: items.filter((i) => i.done).length, total: items.length, dismissed: marks.has('_dismiss'), window_open };
}

export function markChecklist(app: App, g: { id: string }, contactId: string, itemId: string, on = true) {
  if (on) app.db.run('INSERT OR IGNORE INTO community_checklist (group_id, contact_id, item_id, done_at) VALUES (?, ?, ?, ?)', g.id, contactId, itemId, now());
  else app.db.run('DELETE FROM community_checklist WHERE group_id = ? AND contact_id = ? AND item_id = ?', g.id, contactId, itemId);
}

// --- broadcasts --------------------------------------------------------------------------------------------------------------------

export const BROADCAST_CHANNELS = { email: 'E-Mail', push: 'Push aufs Gerät', bell: 'Glocke in der Community' } as const;
export type BroadcastChannel = keyof typeof BROADCAST_CHANNELS;

export function cleanBroadcast(app: App, g: { id: string; location_id: string }, input: any) {
  const b = input ?? {};
  const channels = [...new Set<string>(Array.isArray(b.channels) && b.channels.length ? b.channels.map(String) : ['email', 'bell'])] as BroadcastChannel[];
  if (channels.some((c) => !(c in BROADCAST_CHANNELS))) throw bad(`Kanäle: ${Object.keys(BROADCAST_CHANNELS).join(', ')}`);
  const subject = str(b.subject, 'Betreff', { required: true, max: 140 });
  const body = str(b.body, 'Text', { required: true, max: 20_000 });
  let scheduled_at: string | null = null;
  if (b.scheduled_at) {
    const t = Date.parse(String(b.scheduled_at));
    if (Number.isNaN(t)) throw bad('Zeitpunkt: ungültig');
    if (t > Date.now() + 60_000) scheduled_at = new Date(t).toISOString();
  }
  return { channels, subject, body, segment: cleanSegment(app, g, b.segment), scheduled_at };
}

/** Pushes a broadcast to the devices of the segment (no inbox entries); returns how many devices got it. */
async function pushOut(app: App, g: any, ids: string[], title: string, body: string, url: string): Promise<number> {
  const kit = app.services.contactPushRaw as { send(loc: string, contactId: string, p: { title: string; body: string; url?: string; tag?: string }): Promise<number> } | undefined;
  if (!kit) return 0;
  let n = 0;
  for (const cid of ids.slice(0, 5000)) n += await kit.send(g.location_id, cid, { title, body, url, tag: `bc-${g.id}` }).catch(() => 0);
  return n;
}

export interface BroadcastResult {
  id: string;
  recipients: number;
  email: { campaign_id: string; reachable: number } | null;
  push: number | null;
  bell: number;
  scheduled: boolean;
}

/** Sends (or schedules) a broadcast: e-mail through a campaign, push straight to devices, and an entry in the bell. */
export async function sendBroadcast(app: App, g: any, input: ReturnType<typeof cleanBroadcast>, by = ''): Promise<BroadcastResult> {
  const { db } = app;
  const people = segmentContacts(app, g, input.segment);
  const ids = people.map((p) => p.id);
  const bid = id();
  const url = `${app.baseUrl()}/portal/${encodeURIComponent(g.location_id)}/community/g/${encodeURIComponent(g.slug)}`;
  const res: BroadcastResult = { id: bid, recipients: ids.length, email: null, push: null, bell: 0, scheduled: !!input.scheduled_at };
  if (!ids.length) throw bad('Dieses Segment enthält niemanden');
  let campaignId = '';
  if (input.channels.includes('email')) {
    campaignId = id();
    const html = `${renderMarkdown(input.body)}<hr><p style="color:#6b7280;font-size:13px">Du bekommst diese Nachricht, weil du Mitglied von „${g.name.replace(/[<>&"]/g, '')}“ bist. <a href="${url}">Zur Community</a></p>`;
    db.insert('campaigns', { id: campaignId, location_id: g.location_id, name: `Community: ${input.subject}`.slice(0, 200), channel: 'email', subject: input.subject, body: html, is_html: 1, filter: { community_group: g.id, community_segment: input.segment }, status: 'scheduled', scheduled_at: input.scheduled_at ?? now(), created_at: now(), updated_at: now() });
    res.email = { campaign_id: campaignId, reachable: people.filter((p) => p.email && !p.dnd).length };
  }
  const deliver = async () => {
    if (input.channels.includes('bell')) {
      notify(app, g, ids, { kind: 'announcement', text: input.subject, actor: by || 'Team', quiet: input.channels.includes('push') });
      res.bell = ids.length;
    }
    if (input.channels.includes('push')) res.push = await pushOut(app, g, ids, input.subject, input.body.replace(/[#*_`>\[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160), url);
  };
  const row = { id: bid, location_id: g.location_id, group_id: g.id, subject: input.subject, body: input.body, channels: input.channels, segment: input.segment, recipients: ids.length, campaign_id: campaignId || null, push_devices: res.push ?? 0, status: input.scheduled_at ? 'scheduled' : 'sent', scheduled_at: input.scheduled_at, created_by: by, created_at: now(), sent_at: input.scheduled_at ? null : now() };
  if (input.scheduled_at) {
    db.insert('community_broadcasts', row);
    db.run('INSERT INTO community_broadcast_queue (broadcast_id, due_at) VALUES (?, ?)', bid, input.scheduled_at);
  } else {
    await deliver();
    row.push_devices = res.push ?? 0;
    db.insert('community_broadcasts', row);
  }
  return res;
}

/** Due scheduled broadcasts: bell and push go out now (the campaign of the e-mail was scheduled with them). */
export async function runDueBroadcasts(app: App, at = new Date()): Promise<number> {
  let n = 0;
  for (const q of app.db.all<{ broadcast_id: string }>('SELECT broadcast_id FROM community_broadcast_queue WHERE due_at <= ?', at.toISOString())) {
    app.db.run('DELETE FROM community_broadcast_queue WHERE broadcast_id = ?', q.broadcast_id);
    const b = app.db.get<any>('SELECT * FROM community_broadcasts WHERE id = ?', q.broadcast_id);
    const g = b && app.db.get<any>('SELECT * FROM community_groups WHERE id = ?', b.group_id);
    if (!b || !g) continue;
    const channels: string[] = JSON.parse(b.channels || '[]');
    const segment: Segment = JSON.parse(b.segment || '{}');
    const ids = segmentContacts(app, g, segment).map((p) => p.id);
    let push = 0;
    if (channels.includes('bell')) notify(app, g, ids, { kind: 'announcement', text: b.subject, actor: b.created_by || 'Team' });
    if (channels.includes('push')) push = await pushOut(app, g, ids, b.subject, String(b.body).replace(/[#*_`>\[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160), `${app.baseUrl()}/portal/${encodeURIComponent(g.location_id)}/community/g/${encodeURIComponent(g.slug)}`);
    app.db.run(`UPDATE community_broadcasts SET status = 'sent', sent_at = ?, push_devices = ?, recipients = ? WHERE id = ?`, now(), push, ids.length, b.id);
    n++;
  }
  return n;
}
