import type { App } from '../core/app.js';
import { HttpError, type Ctx, type User } from '../core/http.js';
import type { Param } from '../core/db.js';

/**
 * Record-level access (docs/sales.md): which contacts, companies, deals, tasks and conversations a person may see – everything,
 * only what their team owns, or only what is theirs – and which sensitive fields of them stay hidden.
 *
 * This is the one place that knows the rules. Everything else asks here: `scopeClause()` for lists (a SQL snippet to AND onto a
 * query), `permits()` / `denyUnless()` for one record, `maskRow()` for fields. The module (modules/record-access.ts) wires it
 * into the routes through the router's wrappers; the mobile API, reports, the search and the dashboard call the clause helpers.
 *
 * Default = nothing changes: the rules are off until somebody switches them on, and once on, every record type stays at "alle"
 * until it is set. Admins, API keys and automations are not people with a team – they see everything; the agent and the app act as the person.
 */

export const ENTITIES = ['contacts', 'companies', 'deals', 'tasks', 'conversations'] as const;
export type Entity = (typeof ENTITIES)[number];
export const LEVELS = ['all', 'team', 'own'] as const;
export type Level = (typeof LEVELS)[number];

export const ENTITY_LABEL: Record<Entity, string> = { contacts: 'Kontakte', companies: 'Firmen', deals: 'Deals', tasks: 'Aufgaben', conversations: 'Konversationen' };
export const LEVEL_LABEL: Record<Level, string> = { all: 'Alle sehen', team: 'Nur das Team', own: 'Nur eigene' };

/** Fields that can be hidden per record type; `custom.<key>` hides one custom field, `custom` all of them. */
export const HIDEABLE: Record<Entity, { key: string; label: string }[]> = {
  contacts: [
    { key: 'email', label: 'E-Mail' },
    { key: 'phone', label: 'Telefon' },
    { key: 'address', label: 'Adresse (mit Ort, PLZ, Land)' },
    { key: 'date_of_birth', label: 'Geburtstag' },
    { key: 'website', label: 'Website' },
    { key: 'custom', label: 'Alle eigenen Felder' },
  ],
  companies: [
    { key: 'phone', label: 'Telefon' },
    { key: 'address', label: 'Adresse (mit Ort, PLZ, Land)' },
    { key: 'website', label: 'Website' },
    { key: 'custom', label: 'Alle eigenen Felder' },
  ],
  deals: [
    { key: 'value', label: 'Betrag' },
    { key: 'source', label: 'Quelle' },
  ],
  tasks: [{ key: 'description', label: 'Beschreibung' }],
  conversations: [{ key: 'preview', label: 'Vorschau der letzten Nachricht' }],
};

export interface RuleSet {
  levels: Partial<Record<Entity, Level>>;
  hidden: Partial<Record<Entity, string[]>>;
}
export interface Resolved {
  userId: string;
  locationId: string;
  levels: Record<Entity, Level>;
  hidden: Record<Entity, Set<string>>;
  /** The person and the members of their teams. */
  teamIds: string[];
  /** Records without an owner stay visible to everyone (the pool to claim from). */
  unassignedVisible: boolean;
  /** At least one record type is narrowed. */
  narrowed: boolean;
  /** The project planner's assignees table exists (tasks can have several owners). */
  planner: boolean;
}

export type Who = { locationId: string; user?: User; via?: Ctx['via'] };

const cache = new WeakMap<object, Resolved | null>();

export function settingsOf(app: App, locationId: string): { enabled: boolean; unassigned_visible: boolean } {
  const r = app.db.get<{ enabled: number; unassigned: string }>('SELECT enabled, unassigned FROM record_access_settings WHERE location_id = ?', locationId);
  return { enabled: !!r?.enabled, unassigned_visible: (r?.unassigned ?? 'show') !== 'hide' };
}

const parseJson = <T>(s: unknown, fallback: T): T => {
  try {
    return s ? (JSON.parse(String(s)) as T) : fallback;
  } catch {
    return fallback;
  }
};

export const cleanRuleSet = (v: any): RuleSet => {
  const levels: RuleSet['levels'] = {};
  const hidden: RuleSet['hidden'] = {};
  if (v && typeof v === 'object') {
    for (const e of ENTITIES) {
      const l = v.levels?.[e];
      if ((LEVELS as readonly string[]).includes(l)) levels[e] = l;
      const h = v.hidden?.[e];
      if (Array.isArray(h)) {
        const ok = h.map(String).filter((k) => HIDEABLE[e].some((x) => x.key === k) || (/^custom\.[a-z0-9_]{1,60}$/.test(k) && (e === 'contacts' || e === 'companies')));
        if (ok.length) hidden[e] = [...new Set(ok)];
      }
    }
  }
  return { levels, hidden };
};

/** The ids of the person's teams (in this sub-account). */
export function teamsOf(app: App, locationId: string, userId: string): string[] {
  return app.db
    .all<{ team_id: string }>('SELECT m.team_id FROM sales_team_members m JOIN sales_teams t ON t.id = m.team_id WHERE t.location_id = ? AND m.user_id = ?', locationId, userId)
    .map((r) => r.team_id);
}

/** Everybody who shares a team with the person (including themselves). */
export function teammatesOf(app: App, locationId: string, userId: string): string[] {
  const teams = teamsOf(app, locationId, userId);
  const set = new Set<string>([userId]);
  if (teams.length) for (const r of app.db.all<{ user_id: string }>(`SELECT DISTINCT user_id FROM sales_team_members WHERE team_id IN (${teams.map(() => '?').join(',')})`, ...teams)) set.add(r.user_id);
  return [...set];
}

const rank: Record<Level, number> = { own: 0, team: 1, all: 2 };

/**
 * The rules that apply to a request, or null when nothing is narrowed (rules off, an admin, a key or the MCP endpoint,
 * or a member whose rules all say "alle"). The rule of the person beats the rules of their teams (the most generous
 * one counts), which beat the default.
 */
export function resolve(app: App, who: Who): Resolved | null {
  const key = who as object;
  if (cache.has(key)) return cache.get(key)!;
  const out = resolveUncached(app, who);
  cache.set(key, out);
  return out;
}

function resolveUncached(app: App, who: Who): Resolved | null {
  const u = who.user;
  if (!u || u.role === 'admin' || !who.locationId) return null;
  // Keys act for the sub-account, not for a person. Everything that acts for a member – the browser, the app, the HyperLevel Agent
  // working for them, an AI app they connected – follows their rules.
  if (who.via === 'api_key' || who.via === 'agency_key') return null;
  const s = settingsOf(app, who.locationId);
  if (!s.enabled) return null;
  const teams = teamsOf(app, who.locationId, u.id);
  const rows = app.db.all<{ subject_type: string; subject_id: string; levels: string; hidden: string }>(
    `SELECT subject_type, subject_id, levels, hidden FROM record_access_rules
     WHERE location_id = ? AND (subject_type = 'default' OR (subject_type = 'user' AND subject_id = ?)${teams.length ? ` OR (subject_type = 'team' AND subject_id IN (${teams.map(() => '?').join(',')}))` : ''})`,
    who.locationId,
    u.id,
    ...teams,
  );
  const sets = (type: string) => rows.filter((r) => r.subject_type === type).map((r) => cleanRuleSet({ levels: parseJson(r.levels, {}), hidden: parseJson(r.hidden, {}) }));
  const def = sets('default')[0];
  const own = sets('user')[0];
  const team = sets('team');
  const levels = {} as Record<Entity, Level>;
  const hidden = {} as Record<Entity, Set<string>>;
  for (const e of ENTITIES) {
    let level: Level | undefined = own?.levels[e];
    let hide: string[] | undefined = own?.hidden[e];
    const t = team.filter((x) => x.levels[e]);
    if (!level && t.length) level = t.map((x) => x.levels[e]!).sort((a, b) => rank[b] - rank[a])[0];
    // Of the person's teams only those that say something about this record type count (a team rule that only sets a level leaves the
    // hidden fields of the default alone); a field stays hidden when every one of them hides it – the most generous team wins.
    const said = team.map((x) => x.hidden[e]).filter((l): l is string[] => !!l);
    if (hide === undefined && said.length) hide = said.reduce((a, b) => a.filter((k) => b.includes(k)));
    levels[e] = level ?? def?.levels[e] ?? 'all';
    hidden[e] = new Set(hide ?? def?.hidden[e] ?? []);
  }
  const narrowed = ENTITIES.some((e) => levels[e] !== 'all' || hidden[e].size > 0);
  if (!narrowed) return null;
  const planner = !!app.db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'pm_assignees'`);
  return { userId: u.id, locationId: who.locationId, levels, hidden, teamIds: teammatesOf(app, who.locationId, u.id), unassignedVisible: s.unassigned_visible, narrowed, planner };
}

/** Does this person see only part of the records of this type (or fields of them hidden)? */
export const isNarrowed = (r: Resolved | null, e: Entity): r is Resolved => !!r && (r.levels[e] !== 'all' || r.hidden[e].size > 0);
export const limits = (r: Resolved | null, e: Entity): r is Resolved => !!r && r.levels[e] !== 'all';

/** The tables and aliases the clauses are written for (`alias` is the table's alias in the query that gets the clause). */
export const TABLE: Record<Entity, { table: string; alias: string }> = {
  contacts: { table: 'contacts', alias: 'c' },
  companies: { table: 'companies', alias: 'co' },
  deals: { table: 'opportunities', alias: 'o' },
  tasks: { table: 'tasks', alias: 't' },
  conversations: { table: 'conversations', alias: 'v' },
};

/** SQL of the column that says who a record belongs to. */
export function ownerSql(e: Entity, alias: string): string {
  switch (e) {
    case 'contacts':
      return `${alias}.assigned_to`;
    case 'companies':
      return `${alias}.owner_id`;
    case 'deals':
    case 'tasks':
      return `${alias}.assigned_to`;
    case 'conversations':
      // The person the conversation is assigned to (team inbox), otherwise the owner of the contact.
      return `COALESCE(NULLIF(${alias}.assignee_id, ''), (SELECT k.assigned_to FROM contacts k WHERE k.id = ${alias}.contact_id))`;
  }
}

/**
 * A SQL condition to AND onto a query over `alias` (the record's table), or undefined when this person sees everything of that
 * type. Placeholders: `params` in order.
 */
export function scopeClause(r: Resolved | null, e: Entity, alias: string = TABLE[e].alias): { sql: string; params: Param[] } | undefined {
  if (!limits(r, e)) return undefined;
  const ids = r.levels[e] === 'own' ? [r.userId] : r.teamIds;
  const marks = ids.map(() => '?').join(', ');
  const owner = ownerSql(e, alias);
  // A planner task can have several owners (the assignees of the project planner): it is mine when I am one of them.
  const planner = e === 'tasks' && r.planner;
  const parts = [`${owner} IN (${marks})`];
  const params: Param[] = [...ids];
  if (planner) {
    parts.push(`EXISTS (SELECT 1 FROM pm_assignees pa WHERE pa.task_id = ${alias}.id AND pa.user_id IN (${marks}))`);
    params.push(...ids);
  }
  if (r.unassignedVisible) parts.push(planner ? `(COALESCE(${owner}, '') = '' AND NOT EXISTS (SELECT 1 FROM pm_assignees pq WHERE pq.task_id = ${alias}.id))` : `${owner} IS NULL OR ${owner} = ''`);
  return { sql: `(${parts.join(' OR ')})`, params };
}

/** Rows that carry a `contact_id` (notes, activities, messages …): visible when the contact is – or when they have none. */
export function contactScopeClause(r: Resolved | null, column: string): { sql: string; params: Param[] } | undefined {
  const c = scopeClause(r, 'contacts', 'kc');
  if (!c) return undefined;
  return { sql: `(${column} IS NULL OR ${column} IN (SELECT kc.id FROM contacts kc WHERE ${c.sql}))`, params: c.params };
}

/** Clause for a query across several sub-accounts (the mobile API): each sub-account has its own rules. */
export function scopeClauseFor(app: App, who: Omit<Who, 'locationId'>, locationIds: string[], e: Entity, alias: string = TABLE[e].alias, locationColumn = `${alias}.location_id`): { sql: string; params: Param[] } | undefined {
  const per = locationIds.map((id) => ({ id, clause: scopeClause(resolve(app, { ...who, locationId: id }), e, alias) }));
  const limited = per.filter((p) => p.clause);
  if (!limited.length) return undefined;
  const free = per.filter((p) => !p.clause).map((p) => p.id);
  const parts: string[] = [];
  const params: Param[] = [];
  if (free.length) {
    parts.push(`${locationColumn} IN (${free.map(() => '?').join(', ')})`);
    params.push(...free);
  }
  for (const p of limited) {
    parts.push(`(${locationColumn} = ? AND ${p.clause!.sql})`);
    params.push(p.id, ...p.clause!.params);
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

/** Does the record (by id) pass? A record that does not exist passes – the route answers "not found" itself. */
export function permits(app: App, r: Resolved | null, e: Entity, recordId: string): boolean {
  if (!limits(r, e)) return true;
  const { table, alias } = TABLE[e];
  const exists = app.db.get(`SELECT 1 AS x FROM ${table} ${alias} WHERE ${alias}.id = ? AND ${alias}.location_id = ?`, recordId, r.locationId);
  if (!exists) return true;
  const c = scopeClause(r, e)!;
  return !!app.db.get(`SELECT 1 AS x FROM ${table} ${alias} WHERE ${alias}.id = ? AND ${alias}.location_id = ? AND ${c.sql}`, recordId, r.locationId, ...c.params);
}

export const permitsContact = (app: App, r: Resolved | null, contactId: string) => permits(app, r, 'contacts', contactId);

/** Throws 404 – the same answer as for a record that does not exist – when the person may not open it. */
export function denyUnless(ok: boolean, what = 'Nicht gefunden'): void {
  if (!ok) throw new HttpError(404, what);
}

// --- fields --------------------------------------------------------------------------------------------------------

const ADDRESS = ['address', 'city', 'postal_code', 'country'];

/** Copy of a contact/company/deal/task row without the fields this person may not see. Adds `hidden_fields` when something was removed. */
export function maskRow<T extends Record<string, any>>(r: Resolved | null, e: Entity, row: T): T {
  if (!r || !row || typeof row !== 'object') return row;
  const hide = r.hidden[e];
  if (!hide.size) return row;
  const out: Record<string, any> = { ...row };
  const gone: string[] = [];
  const blank = (k: string, v: any = '') => {
    if (k in out) {
      out[k] = v;
      gone.push(k);
    }
  };
  for (const k of hide) {
    if (k === 'address') for (const f of ADDRESS) blank(f);
    else if (k === 'date_of_birth') blank(k, null);
    else if (k === 'value') blank('value', 0);
    else if (k === 'preview') blank('last_message');
    else if (k === 'custom') {
      if (out.custom && typeof out.custom === 'object') {
        gone.push(...Object.keys(out.custom).map((x) => `custom.${x}`));
        out.custom = {};
      }
    } else if (k.startsWith('custom.')) {
      if (out.custom && typeof out.custom === 'object' && k.slice(7) in out.custom) {
        const { [k.slice(7)]: _x, ...rest } = out.custom;
        out.custom = rest;
        gone.push(k);
      }
    } else blank(k);
  }
  if (gone.length) out.hidden_fields = [...new Set([...(Array.isArray(out.hidden_fields) ? out.hidden_fields : []), ...gone])];
  return out as T;
}

/** Contact fields that appear in the rows of other lists (deals, tasks, conversations: email, phone …). */
export function maskContactFields<T extends Record<string, any>>(r: Resolved | null, row: T): T {
  if (!r || !row || !r.hidden.contacts.size) return row;
  const hide = r.hidden.contacts;
  const out: Record<string, any> = { ...row };
  if (hide.has('email')) for (const k of ['email', 'contact_email']) if (k in out) out[k] = '';
  if (hide.has('phone')) for (const k of ['phone', 'contact_phone']) if (k in out) out[k] = '';
  return out as T;
}

/** Writing a field that is hidden from this person is refused (otherwise a hidden value could be overwritten blind). */
export function hiddenFieldsIn(r: Resolved | null, e: Entity, body: unknown): string[] {
  if (!r || !r.hidden[e].size || !body || typeof body !== 'object') return [];
  const b = body as Record<string, any>;
  const bad: string[] = [];
  for (const k of r.hidden[e]) {
    if (k === 'address') for (const f of ADDRESS) if (b[f] !== undefined) bad.push(f);
    if (k === 'custom' || k.startsWith('custom.')) {
      const c = b.custom;
      if (c && typeof c === 'object') for (const ck of Object.keys(c)) if (k === 'custom' || k === `custom.${ck}`) bad.push(`custom.${ck}`);
    } else if (k !== 'address' && b[k] !== undefined) bad.push(k);
  }
  return [...new Set(bad)];
}

/** What the person sees, as the screens need it (no ids of other people). */
export function describe(r: Resolved | null) {
  return {
    restricted: !!r,
    levels: Object.fromEntries(ENTITIES.map((e) => [e, r?.levels[e] ?? 'all'])),
    hidden: Object.fromEntries(ENTITIES.map((e) => [e, [...(r?.hidden[e] ?? [])]])),
    unassigned_visible: r?.unassignedVisible ?? true,
  };
}

/** The owner a record created by this person starts with: themselves when their view of that type is limited (else it would vanish from their own list). */
export const defaultOwner = (r: Resolved | null, e: Entity): string | undefined => (limits(r, e) ? r.userId : undefined);

/**
 * A new contact (or a deal that creates one) must not merge into a contact the person may not open: the upsert by e-mail or
 * phone would hand that contact's data back. They get a 409 that says an owner exists, not who or what.
 */
export function assertContactUpsertAllowed(app: App, r: Resolved | null, input: { email?: unknown; phone?: unknown } | undefined): void {
  if (!limits(r, 'contacts') || !input) return;
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
  const byEmail = email ? app.db.get<{ id: string }>('SELECT id FROM contacts WHERE location_id = ? AND email = ?', r.locationId, email) : undefined;
  if (byEmail && !permits(app, r, 'contacts', byEmail.id)) throw new HttpError(409, 'Zu dieser E-Mail-Adresse gibt es schon einen Kontakt, der dir nicht zugeordnet ist – bitte beim Team nachfragen');
  const byPhone = !byEmail && phone ? app.db.get<{ id: string }>('SELECT id FROM contacts WHERE location_id = ? AND phone = ?', r.locationId, phone) : undefined;
  if (byPhone && !permits(app, r, 'contacts', byPhone.id)) throw new HttpError(409, 'Zu dieser Telefonnummer gibt es schon einen Kontakt, der dir nicht zugeordnet ist – bitte beim Team nachfragen');
}

/**
 * Who may change sales settings (access rules, teams, quotas, send limits): admins and keys, and members who have the settings
 * area and are not themselves narrowed (a person with a limited view cannot widen it).
 */
export function canConfigure(app: App, ctx: Ctx): boolean {
  const u = ctx.user;
  if (!u) return !!ctx.viaApiKey;
  if (u.role === 'admin') return true;
  if (resolve(app, ctx)) return false;
  return !u.permissions || u.permissions.includes('settings');
}

export function mustConfigure(app: App, ctx: Ctx): void {
  if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
  if (!canConfigure(app, ctx)) throw new HttpError(403, 'Nur Admins (und Mitglieder ohne eingeschränkten Zugriff mit dem Bereich „Einstellungen“) dürfen das ändern');
}
