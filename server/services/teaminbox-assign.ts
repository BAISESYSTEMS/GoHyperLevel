import type { App } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { getContact } from './contacts.js';
import { isAway } from './team-people.js';
import { nextAvailable, type AssignRule, type AssignTarget, type InboxSettings } from './teaminbox-model.js';
import { agentsOf, brief, getConv, setAssignee, SYSTEM, type ConvRow, type Who } from './teaminbox-store.js';

/**
 * Who gets a conversation: the contact's owner, a rule (channel / tag) or the default pool, taking turns or by the
 * fewest open conversations – always skipping people who are away (out of office, paused, outside their working hours).
 * Round-robin remembers who was last per sub-account and scope, so the turns survive restarts.
 */

export interface Pick {
  userId: string | null;
  teamId: string | null;
  reason: string;
  priority?: string;
}

/** Candidate people of a target, in a stable order. */
export function poolOf(app: App, locationId: string, s: InboxSettings, target?: AssignTarget): { ids: string[]; teamId: string | null; scope: string } {
  const agents = agentsOf(app, locationId).map((a) => a.id);
  const allowed = new Set(agents);
  if (target?.type === 'user') return { ids: allowed.has(target.id) ? [target.id] : [], teamId: null, scope: `user:${target.id}` };
  const teamId = target?.type === 'team' ? target.id : target ? null : s.assignment.pool === 'team' ? s.assignment.team_id : null;
  if (teamId) {
    const team = app.db.get<{ members: string }>('SELECT members FROM helpdesk_teams WHERE id = ? AND location_id = ?', teamId, locationId);
    const members: string[] = team ? (JSON.parse(team.members || '[]') as string[]) : [];
    return { ids: members.filter((m) => allowed.has(m)), teamId: team ? teamId : null, scope: `team:${teamId}` };
  }
  if (!target && s.assignment.pool === 'users') return { ids: s.assignment.user_ids.filter((u) => allowed.has(u)), teamId: null, scope: 'users' };
  return { ids: agents, teamId: null, scope: 'all' };
}

function openLoad(app: App, locationId: string, ids: string[]): Map<string, number> {
  const load = new Map(ids.map((i) => [i, 0]));
  if (!ids.length) return load;
  const rows = app.db.all<{ assignee_id: string; n: number }>(
    `SELECT assignee_id, COUNT(*) AS n FROM conversations WHERE location_id = ? AND inbox_status != 'closed' AND assignee_id IN (${ids.map(() => '?').join(',')}) GROUP BY assignee_id`,
    locationId,
    ...ids,
  );
  for (const r of rows) load.set(r.assignee_id, r.n);
  return load;
}

/** Picks one person from the pool by the sub-account's mode; null when nobody is available. */
export function pickFrom(app: App, locationId: string, s: InboxSettings, pool: { ids: string[]; scope: string }, at = new Date()): string | null {
  if (!pool.ids.length) return null;
  const respect = s.assignment.respect_availability;
  // First everyone who is really around; then everyone who is merely not out of office; never somebody on leave.
  const tiers: ((id: string) => boolean)[] = respect ? [(u) => !isAway(app, locationId, u, at, true), (u) => !isAway(app, locationId, u, at, false)] : [() => true];
  const last = app.db.get<{ last_user_id: string }>('SELECT last_user_id FROM inbox_rr WHERE location_id = ? AND scope = ?', locationId, pool.scope)?.last_user_id;
  for (const ok of tiers) {
    const candidates = pool.ids.filter(ok);
    if (!candidates.length) continue;
    let chosen: string | null;
    if (s.assignment.mode === 'least_busy') {
      const load = openLoad(app, locationId, candidates);
      const min = Math.min(...candidates.map((c) => load.get(c) ?? 0));
      // Among the least busy, the one whose turn it is.
      chosen = nextAvailable(pool.ids, last, (u) => candidates.includes(u) && (load.get(u) ?? 0) === min);
    } else chosen = nextAvailable(pool.ids, last, (u) => candidates.includes(u));
    if (chosen) {
      app.db.run(`INSERT INTO inbox_rr (location_id, scope, last_user_id) VALUES (?, ?, ?) ON CONFLICT(location_id, scope) DO UPDATE SET last_user_id = excluded.last_user_id`, locationId, pool.scope, chosen);
      return chosen;
    }
  }
  return null;
}

export const matchRule = (rules: AssignRule[], o: { channel: string; tags: string[] }): AssignRule | undefined => {
  const tags = o.tags.map((t) => t.toLowerCase());
  return rules.find((r) => r.enabled && (!r.channels.length || r.channels.includes(o.channel.toLowerCase())) && (!r.tags.length || r.tags.some((t) => tags.includes(t.toLowerCase()))));
};

/** Who should get this conversation now? Null = leave it to the team queue. */
export function decide(app: App, conv: ConvRow, s: InboxSettings, at = new Date()): Pick | null {
  if (s.assignment.mode === 'manual') return null;
  const loc = conv.location_id;
  const contact = getContact(app, loc, conv.contact_id);
  const channel = app.db.get<{ channel: string }>(`SELECT channel FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 1`, conv.id)?.channel ?? '';
  const rule = matchRule(s.assignment.rules, { channel, tags: contact?.tags ?? [] });
  const agents = new Set(agentsOf(app, loc).map((a) => a.id));
  // 1. The contact's owner, when they work here and are around.
  const owner = s.assignment.prefer_contact_owner ? ((contact as any)?.assigned_to as string | undefined) : undefined;
  if (owner && agents.has(owner) && (!s.assignment.respect_availability || !isAway(app, loc, owner, at, true))) return { userId: owner, teamId: rule?.target.type === 'team' ? rule.target.id : null, reason: 'Zuständig am Kontakt', priority: rule?.priority || undefined };
  // 2. The first rule that fits, 3. the default pool.
  const target = rule?.target;
  const pool = poolOf(app, loc, s, target?.type === 'pool' ? undefined : target);
  const userId = pickFrom(app, loc, s, pool, at);
  const reason = rule ? `Regel „${rule.name}“` : s.assignment.mode === 'least_busy' ? 'Geringste Auslastung' : 'Reihum';
  if (!userId && !pool.teamId) return rule?.priority ? { userId: null, teamId: null, reason, priority: rule.priority } : null;
  return { userId, teamId: pool.teamId, reason, priority: rule?.priority || undefined };
}

/**
 * Assigns a conversation by the rules (new conversations, and ones whose assignee is away). Returns the updated row, or the
 * unchanged one when there was nothing to do.
 */
export function autoAssign(app: App, convId: string, locationId: string, s: InboxSettings, who: Who = { ...SYSTEM, via: 'rule', name: 'Zuweisungsregel' }, at = new Date()): ConvRow {
  let conv = getConv(app, locationId, convId);
  const pick = decide(app, conv, s, at);
  if (!pick) return conv;
  if (pick.priority && pick.priority !== conv.priority) app.db.run('UPDATE conversations SET priority = ? WHERE id = ?', pick.priority, conv.id);
  if (pick.userId || pick.teamId) conv = setAssignee(app, who, getConv(app, locationId, conv.id), { userId: pick.userId, teamId: pick.teamId, reason: pick.reason, quiet: true });
  return getConv(app, locationId, conv.id);
}

/** Rows of the rules for the settings screen (ids resolved to names). */
export function describeRules(app: App, locationId: string, s: InboxSettings) {
  const agents = new Map(agentsOf(app, locationId).map((a) => [a.id, a.name]));
  const teams = new Map(parseRows(app.db.all('SELECT id, name FROM helpdesk_teams WHERE location_id = ?', locationId), []).map((t: any) => [t.id, t.name]));
  return s.assignment.rules.map((r) => ({ ...r, target_name: r.target.type === 'user' ? (agents.get(r.target.id) ?? '') : r.target.type === 'team' ? (teams.get(r.target.id) ?? '') : 'Alle' }));
}

export { brief };
