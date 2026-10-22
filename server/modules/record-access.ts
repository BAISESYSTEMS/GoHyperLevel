import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx, type Handler, type Route } from '../core/http.js';
import { id, now } from '../core/util.js';
import { peopleOf } from '../services/team-people.js';
import {
  ENTITIES,
  ENTITY_LABEL,
  HIDEABLE,
  LEVEL_LABEL,
  LEVELS,
  assertContactUpsertAllowed,
  canConfigure,
  cleanRuleSet,
  denyUnless,
  describe,
  hiddenFieldsIn,
  limits,
  maskContactFields,
  maskRow,
  mustConfigure,
  permits,
  permitsContact,
  resolve,
  scopeClause,
  scopeClauseFor,
  settingsOf,
  type Entity,
  type Resolved,
} from '../services/record-access.js';
import type { Tool } from './mcp.js';

/**
 * Datensatz-Zugriff (docs/sales.md): who sees which contacts, companies, deals, tasks and conversations – everything, the team's or
 * only their own – plus fields that stay hidden, and the sales teams the "Team" level refers to. The rules themselves are in
 * services/record-access.ts; this module owns the tables and the routes, and plugs the checks into the router (one wrapper that
 * looks at every request of a person with narrowed rights) so no feature module has to know about them.
 *
 * Off by default. Admins, API keys, MCP connections and automations are not people with a team and see everything; so that a
 * restricted person cannot hand themselves such a key, creating keys, webhooks and bulk exports is refused to them.
 */

/** Routes whose first `:id` is a record of this kind (the pattern as registered). */
const RECORD_ROUTES: { re: RegExp; entity: Entity }[] = [
  { re: /^\/api\/contacts\/:id(\/|$)/, entity: 'contacts' },
  { re: /^\/api\/opportunities\/:id(\/|$)/, entity: 'deals' },
  { re: /^\/api\/companies\/:id(\/|$)/, entity: 'companies' },
  { re: /^\/api\/tasks\/:id(\/|$)/, entity: 'tasks' },
  { re: /^\/api\/(inbox\/|mobile\/|ai\/)?conversations\/:id(\/|$)/, entity: 'conversations' },
  { re: /^\/api\/(mobile\/)?pm\/tasks\/:id(\/|$)/, entity: 'tasks' },
  { re: /^\/api\/mail\/conversations\/:id(\/|$)/, entity: 'conversations' },
  // The record a path param names in other families: the owner of a lead score, a health score, a smart record.
  { re: /^\/api\/lead-scoring\/contacts\/:id(\/|$)/, entity: 'contacts' },
  { re: /^\/api\/health\/contacts\/:id(\/|$)/, entity: 'contacts' },
];
/**
 * Routes whose path names a child row that points at a contact (a note, a call, an analysis, a dialer entry …) or at a conversation
 * (a message, a draft, a media file): `param` is the path parameter, `where` the lookup in `table` (one `?` per use of the parameter –
 * calls are also found by their Twilio sid), `column` the reference. A row without a reference (an uploaded meeting recording that
 * belongs to nobody) stays open to everybody.
 */
const CHILD_ROUTES: { re: RegExp; table: string; entity: Entity; column: string; param?: string; where?: string }[] = [
  { re: /^\/api\/notes\/:id$/, table: 'notes', entity: 'contacts', column: 'contact_id' },
  { re: /^\/api\/messages\/:id$/, table: 'messages', entity: 'conversations', column: 'conversation_id' },
  { re: /^\/api\/meeting-notes\/:id$/, table: 'deal_meeting_notes', entity: 'contacts', column: 'contact_id' },
  // Media of a message (Telegram, Discord, WhatsApp) and the attachments of a mailbox message.
  { re: /^\/api\/messages\/(channels|meta)\/media\/:id$/, table: 'messages', entity: 'conversations', column: 'conversation_id' },
  { re: /^\/api\/mail\/attachments\/:messageId\/:index$/, table: 'messages', entity: 'conversations', column: 'conversation_id', param: 'messageId' },
  // The call log, the browser phone's call controls, conversation intelligence, the power dialer and the AI phone agent.
  { re: /^\/api\/(phone\/)?calls\/:id(\/|$)/, table: 'calls', entity: 'contacts', column: 'contact_id', where: '(id = ? OR sid = ?)' },
  { re: /^\/api\/call-intel\/(by-call|calls)\/:callId(\/|$)/, table: 'calls', entity: 'contacts', column: 'contact_id', param: 'callId', where: '(id = ? OR sid = ?)' },
  { re: /^\/api\/dialer\/calls\/:callId(\/|$)/, table: 'calls', entity: 'contacts', column: 'contact_id', param: 'callId', where: '(id = ? OR sid = ?)' },
  { re: /^\/api\/call-intel\/:id(\/|$)/, table: 'call_intel', entity: 'contacts', column: 'contact_id' },
  { re: /^\/api\/dialer\/items\/:id(\/|$)/, table: 'dialer_items', entity: 'contacts', column: 'contact_id' },
  { re: /^\/api\/voice-ai\/calls\/:id$/, table: 'voice_ai_sessions', entity: 'contacts', column: 'contact_id', where: '(call_id = ? OR id = ?)' },
];
/**
 * Lists in other families whose rows each belong to a contact: the rows of contacts the person may not open are dropped from the
 * answer (`key` = the property that holds the rows, absent = the answer itself; `field` = the property that names the contact).
 */
const CONTACT_LISTS: Record<string, { key?: string; field: string; conversation?: string }> = {
  'GET /api/calls': { key: 'calls', field: 'contact_id' },
  'GET /api/call-intel': { key: 'items', field: 'contact_id' },
  'GET /api/voice-ai/calls': { field: 'contact_id' },
  'GET /api/dialer/lists/:id/items': { field: 'contact_id' },
  'GET /api/dialer/callbacks': { field: 'contact_id' },
  'GET /api/conversations/drafts': { field: 'contact_id', conversation: 'conversation_id' },
  'GET /api/segments/:id/contacts': { key: 'contacts', field: 'id' },
  'GET /api/campaigns/:id/recipients': { field: 'contact_id' },
};
/** What a memory (Cognee) answers about people: not for somebody who sees only part of the contacts and conversations. */
const MEMORY_PERSONAL = ['contacts', 'notes', 'conversations'];
/** Credentials and exports that would hand a restricted person more than they may see. */
const REFUSED: { method?: string; re: RegExp; what: string }[] = [
  { method: 'POST', re: /^\/api\/api-keys$/, what: 'API-Schlüssel anlegen' },
  { re: /^\/api\/(webhooks|hooks)(\/|$)/, what: 'Webhooks und REST-Hooks' },
  { re: /^\/api\/sheets\/export(\/|$)/, what: 'der Export nach Google Sheets' },
  { method: 'POST', re: /^\/api\/(contacts|companies)\/import$/, what: 'der Import (er würde fremde Kontakte und Firmen überschreiben)' },
  { method: 'POST', re: /^\/api\/mcp-oauth(\/|$)/, what: 'KI-Apps verbinden' },
  { method: 'POST', re: /^\/api\/oauth\/consent(\/|$)/, what: 'KI-Apps verbinden' },
];

const TOOLS: Tool[] = [
  {
    name: 'ghl_sales_access',
    title: 'Datensatz-Zugriff und Teams',
    description: 'Zeigt, wie der Datensatz-Zugriff dieses Sub-Accounts eingestellt ist (an/aus, Regel je Datensatzart für alle, Personen und Teams) und die Vertriebsteams mit ihren Mitgliedern. Nur lesen. Schlüssel und MCP sehen unabhängig davon alle Datensätze.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', '/api/sales/access', { location: a.location_id }),
  },
];

export const recordAccessModule: Module = {
  name: 'record-access',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE sales_teams (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX sales_teams_loc ON sales_teams(location_id);
      CREATE TABLE sales_team_members (
        team_id TEXT NOT NULL REFERENCES sales_teams(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL,
        PRIMARY KEY (team_id, user_id)
      );
      CREATE INDEX sales_team_members_user ON sales_team_members(user_id, location_id);
      CREATE TABLE record_access_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0, unassigned TEXT NOT NULL DEFAULT 'show',
        updated_at TEXT NOT NULL, updated_by TEXT
      );
      CREATE TABLE record_access_rules (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        subject_type TEXT NOT NULL, subject_id TEXT NOT NULL DEFAULT '',
        levels TEXT NOT NULL DEFAULT '{}', hidden TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
        PRIMARY KEY (location_id, subject_type, subject_id)
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    const who = (ctx: Ctx): Resolved | null => resolve(app, ctx);
    app.services.recordAccess = {
      resolve: (ctx: Ctx) => who(ctx),
      /** For modules that pick records themselves (the power dialer's next entry): undefined = everybody's, else "may this person open the contact?". */
      contactFilter: (ctx: Ctx): ((contactId: string) => boolean) | undefined => {
        const r = who(ctx);
        if (!limits(r, 'contacts')) return undefined;
        const seen = new Map<string, boolean>();
        return (cid: string) => seen.get(cid) ?? (seen.set(cid, permitsContact(app, r, cid)), seen.get(cid)!);
      },
    };

    // --- the one wrapper: checks before the handler, shaping after it -------------------------------------------------
    const recordRule = (pattern: string) => RECORD_ROUTES.find((r) => r.re.test(pattern));
    const childRule = (pattern: string) => CHILD_ROUTES.find((r) => r.re.test(pattern));

    /** The records a request names in its query or body (only the keys that mean "this contact / company / deal …" – never the whole body). */
    const NAMED: [keys: string[], entity: Entity][] = [
      [['contact_id', 'contactId'], 'contacts'],
      [['company_id', 'companyId'], 'companies'],
      [['opportunity_id', 'opportunityId', 'deal_id', 'dealId'], 'deals'],
      [['task_id', 'taskId'], 'tasks'],
      [['conversation_id', 'conversationId'], 'conversations'],
    ];
    const namedRecords = (ctx: Ctx): { entity: Entity; id: string }[] => {
      const out: { entity: Entity; id: string }[] = [];
      const take = (entity: Entity, v: unknown) => {
        if (typeof v === 'string' && v && !out.some((o) => o.entity === entity && o.id === v)) out.push({ entity, id: v });
      };
      for (const [keys, entity] of NAMED) {
        for (const k of keys) {
          take(entity, ctx.query.get(k));
          take(entity, ctx.body?.[k]);
        }
      }
      for (const k of ['contact_ids', 'contactIds']) if (Array.isArray(ctx.body?.[k])) for (const v of ctx.body[k].slice(0, 500)) take('contacts', v);
      return out;
    };

    /** The record types the associations and record notes can point at that follow these rules. */
    const ASSOC_ENTITY: Record<string, Entity> = { contact: 'contacts', company: 'companies', opportunity: 'deals', deal: 'deals', task: 'tasks' };
    const refOk = (r: Resolved, type: unknown, rid: unknown) => {
      const e = typeof type === 'string' ? ASSOC_ENTITY[type] : undefined;
      return !e || typeof rid !== 'string' || !limits(r, e) || permits(app, r, e, rid);
    };
    const assertAssociationRefs = (r: Resolved, key: string, ctx: Ctx) => {
      if (key === 'GET /api/associations') denyUnless(refOk(r, ctx.query.get('type'), ctx.query.get('id')));
      else if (key === 'POST /api/associations') denyUnless(refOk(r, ctx.body?.from_type, ctx.body?.from_id) && refOk(r, ctx.body?.to_type, ctx.body?.to_id));
      else if (key === 'PATCH /api/associations/:id' || key === 'DELETE /api/associations/:id') {
        const row = db.get<{ a_type: string; a_id: string; b_type: string; b_id: string }>('SELECT a_type, a_id, b_type, b_id FROM associations WHERE id = ? AND location_id = ?', ctx.params.id, r.locationId);
        if (row) denyUnless(refOk(r, row.a_type, row.a_id) && refOk(r, row.b_type, row.b_id));
      } else if (key === 'DELETE /api/record-notes/:id') {
        const row = db.get<{ object_key: string; record_id: string }>('SELECT object_key, record_id FROM record_notes WHERE id = ? AND location_id = ?', ctx.params.id, r.locationId);
        if (row) denyUnless(refOk(r, row.object_key, row.record_id));
      }
    };

    const BULK: Record<string, Entity> = { 'POST /api/contacts/bulk': 'contacts', 'POST /api/pm/tasks/bulk': 'tasks', 'POST /api/inbox/bulk': 'conversations' };

    app.router.wrappers.push((route: Route, next: Handler): Handler => {
      const pattern = route.pattern;
      if (!pattern.startsWith('/api/') || route.auth === 'public') return next;
      const rec = recordRule(pattern);
      const child = childRule(pattern);
      const key = `${route.method} ${pattern}`;
      const refused = REFUSED.find((x) => (!x.method || x.method === route.method) && x.re.test(pattern));
      return async (ctx) => {
        const r = who(ctx);
        if (!r) return next(ctx);
        if (refused) throw new HttpError(403, `Mit eingeschränktem Datensatz-Zugriff nicht erlaubt: ${refused.what}`);
        // 1. the record the path names
        if (rec && limits(r, rec.entity) && ctx.params.id) denyUnless(permits(app, r, rec.entity, ctx.params.id));
        if (child && limits(r, child.entity)) {
          const named = ctx.params[child.param ?? 'id'] ?? '';
          const where = child.where ?? 'id = ?';
          const row = db.get<Record<string, string>>(`SELECT ${child.column} AS ref FROM ${child.table} WHERE ${where} AND location_id = ?`, ...Array<string>(where.split('?').length - 1).fill(named), r.locationId);
          if (row?.ref) denyUnless(child.entity === 'contacts' ? permitsContact(app, r, row.ref) : permits(app, r, 'conversations', row.ref));
        }
        // 1b. records named inside the associations and notes of custom records
        if (pattern.startsWith('/api/associations') || pattern === '/api/record-notes/:id') assertAssociationRefs(r, key, ctx);
        // 2. the records the query or body names (a task, an invoice, a message for somebody else's contact or deal)
        for (const n of namedRecords(ctx)) if (limits(r, n.entity)) denyUnless(permits(app, r, n.entity, n.id));
        // 2b. the memory (Cognee) holds contacts, notes and conversations as text: not for somebody who sees only some of them
        if (key === 'GET /api/cognee/recall' && (limits(r, 'contacts') || limits(r, 'conversations'))) {
          const asked = (ctx.query.get('types') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
          const safe = (asked.length ? asked : ['wiki', 'tickets', 'courses', 'memory']).filter((t) => !MEMORY_PERSONAL.includes(t));
          ctx.query.set('types', safe.length ? safe.join(',') : 'none');
        }
        // 3. bulk routes only touch what the person may see
        const bulk = BULK[key];
        if (bulk && limits(r, bulk) && Array.isArray(ctx.body?.ids)) ctx.body = { ...ctx.body, ids: ctx.body.ids.filter((x: unknown) => typeof x === 'string' && permits(app, r, bulk, x)) };
        // 4. a hidden field cannot be written blind
        const entity = writeEntity(route.method, pattern);
        if (entity) {
          const hidden = hiddenFieldsIn(r, entity, ctx.body);
          if (hidden.length) throw new HttpError(403, `Das Feld „${hidden[0]}“ ist für dich ausgeblendet – du kannst es nicht ändern`);
        }
        // 5. a new contact must not merge into somebody else's (the upsert would show it to the person who typed the address)
        if (key === 'POST /api/contacts') assertContactUpsertAllowed(app, r, ctx.body);
        const out = await next(ctx);
        return shape(r, route, ctx, out);
      };
    });

    /** Which record type a create/change route writes to (for hidden fields). */
    const writeEntity = (method: string, pattern: string): Entity | undefined => {
      if (method !== 'POST' && method !== 'PATCH' && method !== 'PUT') return undefined;
      if (pattern === '/api/contacts' || pattern === '/api/contacts/:id') return 'contacts';
      if (pattern === '/api/companies' || pattern === '/api/companies/:id') return 'companies';
      if (pattern === '/api/opportunities' || pattern === '/api/opportunities/:id') return 'deals';
      if (pattern === '/api/tasks' || pattern === '/api/tasks/:id') return 'tasks';
      return undefined;
    };

    /** The record a restricted person just created belongs to them (otherwise it would vanish from their own list). */
    const claim = (r: Resolved, table: string, column: string, recordId: unknown) => {
      if (typeof recordId !== 'string') return;
      db.run(`UPDATE ${table} SET ${column} = ? WHERE id = ? AND location_id = ? AND (${column} IS NULL OR ${column} = '')`, r.userId, recordId, r.locationId);
    };

    /** Rows that belong to a contact: the ones of contacts this person may not open are dropped, the phone number goes with a hidden phone field. */
    const hideContactRows = (r: Resolved, list: { key?: string; field: string; conversation?: string }, out: any): any => {
      const byContact = r.levels.contacts !== 'all';
      const byConversation = !!list.conversation && r.levels.conversations !== 'all';
      if (!byContact && !byConversation && !r.hidden.contacts.has('phone')) return out;
      const ok = (x: any) => {
        if (!x || typeof x !== 'object') return true;
        if (byContact && x[list.field] && !permitsContact(app, r, String(x[list.field]))) return false;
        if (byConversation && x[list.conversation!] && !permits(app, r, 'conversations', String(x[list.conversation!]))) return false;
        return true;
      };
      const keep = (rows: any[]) => rows.filter(ok).map((x) => (x && typeof x === 'object' ? maskContactFields(r, noNumbers(r, x)) : x));
      if (Array.isArray(out) && !list.key) return keep(out);
      if (list.key && out && Array.isArray(out[list.key])) return { ...out, [list.key]: keep(out[list.key]) };
      return out;
    };
    /** A call row names both numbers; the contact's is one of them. */
    const noNumbers = (r: Resolved, x: any) => (r.hidden.contacts.has('phone') && ('from_number' in x || 'to_number' in x) ? { ...x, from_number: '', to_number: '' } : x);

    const shape = (r: Resolved, route: Route, ctx: Ctx, out: any): any => {
      if (!out || typeof out !== 'object' || (out as any).__raw) return out;
      const key = `${route.method} ${route.pattern}`;
      if (CONTACT_LISTS[key]) return hideContactRows(r, CONTACT_LISTS[key], out);
      switch (key) {
        case 'POST /api/contacts':
          if (limits(r, 'contacts')) claim(r, 'contacts', 'assigned_to', out.id);
          return maskRow(r, 'contacts', limits(r, 'contacts') && out.id && !out.assigned_to ? { ...out, assigned_to: r.userId } : out);
        case 'GET /api/contacts/:id':
        case 'PATCH /api/contacts/:id':
        case 'POST /api/contacts/:id/tags': {
          const c = maskRow(r, 'contacts', out);
          if (Array.isArray(out.tasks) && limits(r, 'tasks')) (c as any).tasks = out.tasks.filter((t: any) => taskVisible(r, t));
          return c;
        }
        case 'POST /api/companies':
          if (limits(r, 'companies')) claim(r, 'companies', 'owner_id', out.id);
          return maskRow(r, 'companies', limits(r, 'companies') && out.id && !out.owner_id ? { ...out, owner_id: r.userId } : out);
        case 'PATCH /api/companies/:id':
        case 'POST /api/companies/:id/merge':
          return maskRow(r, 'companies', out);
        case 'GET /api/companies/:id':
          return companyDetail(r, out);
        case 'POST /api/tasks':
        case 'POST /api/pm/tasks':
          if (limits(r, 'tasks')) claim(r, 'tasks', 'assigned_to', out.id);
          return maskRow(r, 'tasks', limits(r, 'tasks') && out.id && !out.assigned_to ? { ...out, assigned_to: r.userId } : out);
        case 'PATCH /api/tasks/:id':
          return maskRow(r, 'tasks', out);
        case 'GET /api/cognee/info':
          return limits(r, 'contacts') || limits(r, 'conversations') ? { ...out, types: Array.isArray(out.types) ? out.types.filter((t: any) => !MEMORY_PERSONAL.includes(t?.key)) : out.types } : out;
        case 'GET /api/associations':
          return Array.isArray(out) ? out.filter((x: any) => refOk(r, x.type, x.record_id)) : out;
        case 'GET /api/associations/search':
          return Array.isArray(out) ? out.filter((x: any) => refOk(r, ctx.query.get('type'), x.id)) : out;
        case 'GET /api/conversations/:id/messages': {
          const o: any = { ...out };
          if (o.contact) o.contact = maskRow(r, 'contacts', o.contact);
          return o;
        }
        default:
          return out;
      }
    };

    const taskVisible = (r: Resolved, t: any) => {
      const c = scopeClause(r, 'tasks', 'x');
      if (!c) return true;
      const owner = t.assigned_to ?? null;
      return owner === null || owner === '' ? r.unassignedVisible : r.levels.tasks === 'own' ? owner === r.userId : r.teamIds.includes(owner);
    };

    /** The company page lists its contacts, deals and tasks: only those the person may open. */
    const companyDetail = (r: Resolved, out: any) => {
      const o: any = maskRow(r, 'companies', out);
      if (Array.isArray(o.contacts) && limits(r, 'contacts')) o.contacts = o.contacts.filter((x: any) => !x.record_id || permitsContact(app, r, x.record_id));
      if (Array.isArray(o.deals) && limits(r, 'deals')) {
        o.deals = o.deals.filter((x: any) => !x.record_id || permits(app, r, 'deals', x.record_id)).map((x: any) => maskRow(r, 'deals', x));
        o.deals_value = o.deals.filter((d: any) => d.status !== 'lost').reduce((n: number, d: any) => n + (d.value || 0), 0);
      }
      if (Array.isArray(o.tasks) && limits(r, 'tasks')) o.tasks = o.tasks.filter((t: any) => taskVisible(r, t));
      const visibleContacts = new Set<string>((o.contacts ?? []).map((x: any) => x.record_id).filter(Boolean));
      if (Array.isArray(o.contact_tasks)) o.contact_tasks = o.contact_tasks.filter((t: any) => !t.contact_id || visibleContacts.has(t.contact_id) || permitsContact(app, r, t.contact_id));
      if (Array.isArray(o.timeline) && limits(r, 'contacts')) o.timeline = o.timeline.filter((x: any) => !x.contact_id || permitsContact(app, r, x.contact_id));
      if (o.deals_value !== undefined && r.hidden.deals.has('value')) o.deals_value = 0;
      return o;
    };

    // --- the inbox list: conversations of the person only ---------------------------------------------------------------
    app.services.conversationFilters = [
      ...(app.services.conversationFilters ?? []),
      (ctx: Ctx, where: string[], params: unknown[]) => {
        const c = scopeClause(who(ctx), 'conversations', 'v');
        if (c) (where.push(c.sql), params.push(...c.params));
      },
    ];
    app.services.conversationRows = [
      ...(app.services.conversationRows ?? []),
      (ctx: Ctx, rows: any[]) => {
        const r = who(ctx);
        if (!r || (!r.hidden.contacts.size && !r.hidden.conversations.size)) return rows;
        return rows.map((x) => maskRow(r, 'conversations', maskContactFields(r, x)));
      },
    ];

    // --- reports: every row source that is one of the five record types is narrowed the same way ------------------------------
    const SOURCES: Record<string, { entity: Entity; alias: string } | { via: string; entity: Entity } | { contact: string }> = {
      contacts: { entity: 'contacts', alias: 'c' },
      opportunities: { entity: 'deals', alias: 'o' },
      tasks: { entity: 'tasks', alias: 't' },
      conversations: { entity: 'conversations', alias: 'v' },
      companies: { entity: 'companies', alias: 'c' },
      messages: { via: 'm.conversation_id', entity: 'conversations' },
      // The call log belongs to the contact the call was with (a call without a contact is nobody's, so everybody's).
      calls: { contact: 'k.contact_id' },
    };
    type Principal = { user?: Ctx['user']; via?: Ctx['via'] };
    app.services.reportRowScope = (p: Principal, src: { key: string; location: string }, locations: string[]) => {
      const s = SOURCES[src.key];
      if (!s) return undefined;
      if ('alias' in s) return scopeClauseFor(app, p, locations, s.entity, s.alias, src.location);
      if ('contact' in s) {
        const c = scopeClauseFor(app, p, locations, 'contacts', 'rk', 'rk.location_id');
        return c ? { sql: `(${s.contact} IS NULL OR ${s.contact} IN (SELECT rk.id FROM contacts rk WHERE ${c.sql}))`, params: c.params } : undefined;
      }
      // Messages follow their conversation.
      const c = scopeClauseFor(app, p, locations, s.entity, 'rv', 'rv.location_id');
      return c ? { sql: `${s.via} IN (SELECT rv.id FROM conversations rv WHERE ${c.sql})`, params: c.params } : undefined;
    };

    // Amounts hidden from a person: reports whose numbers are deal amounts (deals, companies' deal sums) are closed to them.
    app.services.reportBlocked = (p: Principal, sourceKey: string, locations: string[]) => {
      if (sourceKey !== 'opportunities' && sourceKey !== 'companies') return undefined;
      const hidden = locations.some((l) => resolve(app, { locationId: l, user: p.user, via: p.via })?.hidden.deals.has('value'));
      return hidden ? 'Der Betrag von Deals ist für dich ausgeblendet – dieser Bericht ist nicht verfügbar' : undefined;
    };

    // --- configuration ----------------------------------------------------------------------------------------------------------
    const canConfig = (ctx: Ctx) => canConfigure(app, ctx);
    const mustConfig = (ctx: Ctx) => mustConfigure(app, ctx);

    const teamsOut = (loc: string) => {
      const people = new Map(peopleOf(app, loc, '').map((p) => [p.id, p]));
      const members = db.all<{ team_id: string; user_id: string; role: string }>('SELECT team_id, user_id, role FROM sales_team_members WHERE location_id = ? ORDER BY created_at', loc);
      return db.all<{ id: string; name: string; description: string; created_at: string }>('SELECT * FROM sales_teams WHERE location_id = ? ORDER BY name', loc).map((t) => ({
        ...t,
        members: members
          .filter((m) => m.team_id === t.id)
          .map((m) => ({ user_id: m.user_id, role: m.role, name: people.get(m.user_id)?.name ?? '(entfernt)', email: people.get(m.user_id)?.email ?? '' })),
      }));
    };

    const rulesOut = (loc: string) => {
      const out: { default: any; users: Record<string, any>; teams: Record<string, any> } = { default: { levels: {}, hidden: {} }, users: {}, teams: {} };
      for (const row of db.all<{ subject_type: string; subject_id: string; levels: string; hidden: string }>('SELECT * FROM record_access_rules WHERE location_id = ?', loc)) {
        const set = cleanRuleSet({ levels: JSON.parse(row.levels || '{}'), hidden: JSON.parse(row.hidden || '{}') });
        if (row.subject_type === 'default') out.default = set;
        else if (row.subject_type === 'user') out.users[row.subject_id] = set;
        else if (row.subject_type === 'team') out.teams[row.subject_id] = set;
      }
      return out;
    };

    const customFields = (loc: string) => db.all<{ key: string; label: string }>('SELECT key, label FROM custom_fields WHERE location_id = ? ORDER BY position, label', loc);

    router.get('/api/sales/access', 'location', (ctx) => {
      const s = settingsOf(app, ctx.locationId);
      return {
        enabled: s.enabled,
        unassigned: s.unassigned_visible ? 'show' : 'hide',
        entities: ENTITIES.map((e) => ({ key: e, label: ENTITY_LABEL[e], hideable: HIDEABLE[e] })),
        levels: LEVELS.map((l) => ({ key: l, label: LEVEL_LABEL[l] })),
        custom_fields: customFields(ctx.locationId),
        rules: rulesOut(ctx.locationId),
        people: peopleOf(app, ctx.locationId, '').map((p) => ({ id: p.id, name: p.name, email: p.email, role: p.role })),
        teams: teamsOut(ctx.locationId),
        can_configure: canConfig(ctx),
      };
    });
    router.get('/api/sales/access/me', 'location', (ctx) => ({ ...describe(who(ctx)), enabled: settingsOf(app, ctx.locationId).enabled, can_configure: canConfig(ctx) }));

    router.put('/api/sales/access', 'location', (ctx) => {
      mustConfig(ctx);
      const b = ctx.body ?? {};
      const loc = ctx.locationId;
      const cur = settingsOf(app, loc);
      const enabled = b.enabled === undefined ? cur.enabled : !!b.enabled;
      const unassigned = b.unassigned === undefined ? (cur.unassigned_visible ? 'show' : 'hide') : b.unassigned === 'hide' ? 'hide' : 'show';
      const people = new Set(peopleOf(app, loc, '').map((p) => p.id));
      const teams = new Set(db.all<{ id: string }>('SELECT id FROM sales_teams WHERE location_id = ?', loc).map((t) => t.id));
      const save = (type: string, subject: string, value: unknown) => {
        if (value === null) return void db.run('DELETE FROM record_access_rules WHERE location_id = ? AND subject_type = ? AND subject_id = ?', loc, type, subject);
        const set = cleanRuleSet(value);
        db.run(
          `INSERT INTO record_access_rules (location_id, subject_type, subject_id, levels, hidden, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(location_id, subject_type, subject_id) DO UPDATE SET levels = excluded.levels, hidden = excluded.hidden, updated_at = excluded.updated_at`,
          loc,
          type,
          subject,
          JSON.stringify(set.levels),
          JSON.stringify(set.hidden),
          now(),
        );
      };
      db.tx(() => {
        db.run(
          `INSERT INTO record_access_settings (location_id, enabled, unassigned, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(location_id) DO UPDATE SET enabled = excluded.enabled, unassigned = excluded.unassigned, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          loc,
          enabled ? 1 : 0,
          unassigned,
          now(),
          ctx.user?.id ?? null,
        );
        const rules = b.rules ?? {};
        if (rules.default !== undefined) save('default', '', rules.default ?? {});
        for (const [uid, v] of Object.entries<any>(rules.users ?? {})) {
          if (!people.has(uid)) throw bad('Eine der Personen gehört nicht zu diesem Sub-Account');
          save('user', uid, v);
        }
        for (const [tid, v] of Object.entries<any>(rules.teams ?? {})) {
          if (!teams.has(tid)) throw bad('Eines der Teams gibt es nicht');
          save('team', tid, v);
        }
      });
      return { ok: true, enabled, unassigned, rules: rulesOut(loc) };
    });

    // --- teams ---------------------------------------------------------------------------------------------------------------------
    router.get('/api/sales/teams', 'location', (ctx) => teamsOut(ctx.locationId));

    const setMembers = (loc: string, teamId: string, raw: unknown) => {
      if (!Array.isArray(raw)) throw bad('Mitglieder: Liste erwartet');
      const people = new Set(peopleOf(app, loc, '').map((p) => p.id));
      const rows: { user_id: string; role: string }[] = [];
      for (const m of raw.slice(0, 200)) {
        const uid = typeof m === 'string' ? m : String(m?.user_id ?? '');
        if (!people.has(uid)) throw bad('Eine der Personen gehört nicht zu diesem Sub-Account');
        if (!rows.some((x) => x.user_id === uid)) rows.push({ user_id: uid, role: typeof m === 'object' && m?.role === 'lead' ? 'lead' : 'member' });
      }
      db.run('DELETE FROM sales_team_members WHERE team_id = ?', teamId);
      for (const m of rows) db.insert('sales_team_members', { team_id: teamId, location_id: loc, user_id: m.user_id, role: m.role, created_at: now() });
    };
    const teamOf = (ctx: Ctx) => {
      const t = db.get<{ id: string }>('SELECT id FROM sales_teams WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!t) throw notFound('Team nicht gefunden');
      return t.id;
    };

    router.post('/api/sales/teams', 'location', (ctx) => {
      mustConfig(ctx);
      const name = str(ctx.body?.name, 'Name', { required: true, max: 80 });
      if (db.get('SELECT 1 AS x FROM sales_teams WHERE location_id = ? AND lower(name) = lower(?)', ctx.locationId, name)) throw bad('Ein Team mit diesem Namen gibt es schon');
      const team = { id: id(), location_id: ctx.locationId, name, description: str(ctx.body?.description, 'Beschreibung', { max: 300 }), created_at: now() };
      db.tx(() => {
        db.insert('sales_teams', team);
        if (ctx.body?.members !== undefined) setMembers(ctx.locationId, team.id, ctx.body.members);
      });
      return teamsOut(ctx.locationId).find((t) => t.id === team.id);
    });
    router.patch('/api/sales/teams/:id', 'location', (ctx) => {
      mustConfig(ctx);
      const tid = teamOf(ctx);
      const patch: Record<string, any> = {};
      if (ctx.body?.name !== undefined) {
        patch.name = str(ctx.body.name, 'Name', { required: true, max: 80 });
        if (db.get('SELECT 1 AS x FROM sales_teams WHERE location_id = ? AND lower(name) = lower(?) AND id != ?', ctx.locationId, patch.name, tid)) throw bad('Ein Team mit diesem Namen gibt es schon');
      }
      if (ctx.body?.description !== undefined) patch.description = str(ctx.body.description, 'Beschreibung', { max: 300 });
      db.tx(() => {
        if (Object.keys(patch).length) db.update('sales_teams', tid, patch, ctx.locationId);
        if (ctx.body?.members !== undefined) setMembers(ctx.locationId, tid, ctx.body.members);
      });
      return teamsOut(ctx.locationId).find((t) => t.id === tid);
    });
    router.delete('/api/sales/teams/:id', 'location', (ctx) => {
      mustConfig(ctx);
      const tid = teamOf(ctx);
      db.tx(() => {
        db.run('DELETE FROM record_access_rules WHERE location_id = ? AND subject_type = ? AND subject_id = ?', ctx.locationId, 'team', tid);
        db.run('DELETE FROM sales_teams WHERE id = ? AND location_id = ?', tid, ctx.locationId);
      });
      return { ok: true };
    });

  },
};
