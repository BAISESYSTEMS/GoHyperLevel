import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { render } from '../core/template.js';
import { id, now, safeEqual, slugify, token, uniq } from '../core/util.js';
import { getContact } from '../services/contacts.js';
import { notifyTeam, receiveMessage } from '../services/messaging.js';
import { firstSeen, inboundMessageId } from '../services/channel-kit.js';
import type { Tool } from './mcp.js';
import { PRIORITIES, PRIORITY_LABELS, SOURCES, STAGE_KINDS, addresses, cleanHelpdeskSettings, cleanStages, defaultStages } from '../services/helpdesk.js';
import {
  addTicketEvent,
  agentsOf,
  createTicket,
  getTicketRow,
  helpdeskState,
  importTicket,
  listTickets,
  loadHelpdeskSettings,
  mergeTickets,
  renderTicketText,
  replyToTicket,
  routeInbound,
  saveHelpdeskSettings,
  sendAutoReply,
  setHelpdeskState,
  ticketOut,
  ticketPipelines,
  ticketTimeline,
  updateTicket,
  type Actor,
} from '../services/tickets.js';

/**
 * Helpdesk tickets (Service): pipelines with stages, priorities, categories, owners and teams,
 * timeline, replies through the messaging path, canned responses, saved views, bulk actions and
 * merging. Tickets come from Konversationen, inbound email (support address / rules), forms,
 * calls, the member portal, the API, MCP and workflows.
 */

const TRIGGERS = ['ticket.created', 'ticket.status_changed', 'ticket.assigned'];

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const qs = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};

const TOOLS: Tool[] = [
  {
    name: 'ghl_list_tickets',
    title: 'Tickets auflisten',
    description: 'Helpdesk-Tickets eines Projekts. state: open (Standard)|resolved|closed|done|all; priority: niedrig|normal|hoch|dringend; owner: me|none|<user-id>; sla: warning|breached|at_risk; q sucht in Betreff, Text, Kontakt und Ticketnummer.',
    inputSchema: obj({ ...LOC, state: { type: 'string' }, priority: { type: 'string' }, owner: { type: 'string' }, category: { type: 'string' }, sla: { type: 'string' }, q: { type: 'string' }, contact_id: { type: 'string' }, limit: { type: 'integer' } }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const r = await call.api('GET', `/api/tickets${qs({ state: a.state, priority: a.priority, owner: a.owner, category: a.category, sla: a.sla, q: a.q, contact_id: a.contact_id, limit: a.limit ?? 50 })}`, { location: a.location_id });
      return { total: r.total, tickets: r.tickets.map((t: any) => ({ id: t.id, number: t.number, subject: t.subject, status: t.status, priority: t.priority, category: t.category, owner: t.owner_name, team: t.team_name, contact: t.contact_name, contact_id: t.contact_id, sla: t.sla, updated_at: t.updated_at })) };
    },
  },
  {
    name: 'ghl_create_ticket',
    title: 'Ticket anlegen',
    description: 'Legt ein Helpdesk-Ticket an. Kontakt per contact_id oder email (wird bei Bedarf angelegt). priority: niedrig|normal|hoch|dringend. Ohne owner_id greifen die Zuweisungsregeln (Kategorie, Round Robin).',
    inputSchema: obj(
      { ...LOC, subject: { type: 'string' }, description: { type: 'string' }, contact_id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, priority: { type: 'string', enum: [...PRIORITIES] }, category: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, owner_id: { type: 'string' }, team_id: { type: 'string' }, source: { type: 'string' } },
      ['location_id', 'subject'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      let contactId = a.contact_id;
      if (!contactId && a.email) contactId = (await call.api('POST', '/api/contacts', { location: a.location_id, body: { email: a.email, name: a.name } })).id;
      const t = await call.api('POST', '/api/tickets', { location: a.location_id, body: { subject: a.subject, description: a.description, contact_id: contactId, priority: a.priority, category: a.category, tags: a.tags, owner_id: a.owner_id, team_id: a.team_id, source: a.source || 'API' } });
      return { id: t.id, number: t.number, status: t.status, owner_id: t.owner_id, team_id: t.team_id, sla: t.sla };
    },
  },
  {
    name: 'ghl_update_ticket',
    title: 'Ticket ändern',
    description: 'Ändert ein Ticket (ticket = ID oder Nummer). status: Name oder ID der Stufe (z. B. „In Bearbeitung“, „Gelöst“) oder new|open|waiting|resolved|closed; priority (auch "raise" = eine Stufe höher); owner_id ("" = niemand, "round_robin"); team_id; category; tags; note = interne Notiz.',
    inputSchema: obj({ ...LOC, ticket: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' }, owner_id: { type: 'string' }, team_id: { type: 'string' }, category: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } }, ['location_id', 'ticket']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (call, a) => {
      const body: Record<string, unknown> = {};
      for (const k of ['status', 'priority', 'owner_id', 'team_id', 'category', 'tags', 'note']) if (a[k] !== undefined) body[k] = a[k];
      const t = await call.api('PATCH', `/api/tickets/${encodeURIComponent(a.ticket)}`, { location: a.location_id, body });
      return { id: t.id, number: t.number, status: t.status, priority: t.priority, owner_id: t.owner_id, team_id: t.team_id, sla: t.sla };
    },
  },
  {
    name: 'ghl_reply_ticket',
    title: 'Auf Ticket antworten',
    description: 'Antwortet dem Kontakt eines Tickets (echter Versand über E-Mail/SMS/Chat/WhatsApp, Standard = Kanal des Tickets). status setzt danach optional die Stufe, z. B. „Wartet auf Kunde“. internal=true legt nur eine interne Notiz an.',
    inputSchema: obj({ ...LOC, ticket: { type: 'string' }, body: { type: 'string' }, channel: { type: 'string', enum: ['email', 'sms', 'chat', 'whatsapp', 'messenger', 'instagram'] }, status: { type: 'string' }, internal: { type: 'boolean' } }, ['location_id', 'ticket', 'body']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (call, a) => {
      const path = `/api/tickets/${encodeURIComponent(a.ticket)}`;
      if (a.internal) return call.api('POST', `${path}/notes`, { location: a.location_id, body: { body: a.body } });
      const r = await call.api('POST', `${path}/reply`, { location: a.location_id, body: { body: a.body, channel: a.channel, status: a.status } });
      return { status: r.message?.status, error: r.message?.error || undefined, ticket: { id: r.ticket.id, number: r.ticket.number, status: r.ticket.status } };
    },
  },
];

const actorOf = (ctx: Ctx): Actor => ({ userId: ctx.user?.id ?? null, via: ctx.via === 'mcp' ? 'mcp' : ctx.viaApiKey ? 'api' : 'user' });

export const ticketsModule: Module = {
  name: 'tickets',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE helpdesk_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE TABLE ticket_pipelines (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, stages TEXT NOT NULL DEFAULT '[]', position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE helpdesk_teams (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, members TEXT NOT NULL DEFAULT '[]', round_robin INTEGER NOT NULL DEFAULT 1,
        last_user_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        number INTEGER NOT NULL, subject TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        pipeline_id TEXT NOT NULL, stage_id TEXT NOT NULL, status_kind TEXT NOT NULL DEFAULT 'new',
        priority TEXT NOT NULL DEFAULT 'normal', category TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
        owner_id TEXT, team_id TEXT, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        company_id TEXT, conversation_id TEXT, source TEXT NOT NULL DEFAULT 'manuell', channel TEXT NOT NULL DEFAULT '',
        due_at TEXT, call_id TEXT, form_submission_id TEXT,
        first_response_due_at TEXT, first_response_warn_at TEXT, first_response_at TEXT,
        resolution_due_at TEXT, resolution_warn_at TEXT, resolved_at TEXT, closed_at TEXT, sla_paused_at TEXT,
        sla_first_state TEXT NOT NULL DEFAULT '', sla_resolution_state TEXT NOT NULL DEFAULT '',
        merged_into TEXT, csat_due_at TEXT, csat_sent_at TEXT, csat_score INTEGER, csat_comment TEXT NOT NULL DEFAULT '', csat_at TEXT,
        created_by TEXT, last_customer_at TEXT, last_agent_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(location_id, number)
      );
      CREATE INDEX tickets_loc_kind ON tickets(location_id, status_kind, updated_at);
      CREATE INDEX tickets_contact ON tickets(contact_id, updated_at);
      CREATE INDEX tickets_owner ON tickets(owner_id, status_kind);
      CREATE TABLE ticket_events (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, type TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '', user_id TEXT, message_id TEXT, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE INDEX ticket_events_ticket ON ticket_events(ticket_id, created_at);
      CREATE INDEX ticket_events_message ON ticket_events(message_id) WHERE message_id IS NOT NULL;
      CREATE TABLE helpdesk_views (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        user_id TEXT, name TEXT NOT NULL, filters TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE TABLE helpdesk_canned (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, shortcut TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      `,
    ],
    [
      '002-external',
      `ALTER TABLE tickets ADD COLUMN external_source TEXT;
       ALTER TABLE tickets ADD COLUMN external_id TEXT;
       CREATE UNIQUE INDEX tickets_external ON tickets(location_id, external_source, external_id) WHERE external_id IS NOT NULL;`,
    ],
  ],
  register(app) {
    // Support mails forwarded by a provider can be larger than the 1 MB public default.
    app.services.bodyLimits = [...(app.services.bodyLimits ?? []), { match: (m: string, p: string) => m === 'POST' && /^\/hooks\/[^/]+\/support-email$/.test(p), bytes: 12 * 1024 * 1024 }];
    const { db, router } = app;

    /** ID or ticket number ("42", "#42"). */
    const ticketIdOf = (loc: string, raw: string): string => {
      const n = String(raw).replace(/^#/, '');
      if (/^\d{1,9}$/.test(n)) {
        const row = db.get('SELECT id FROM tickets WHERE location_id = ? AND number = ?', loc, Number(n));
        if (row) return row.id;
      }
      return raw;
    };
    const mustTicket = (loc: string, raw: string) => {
      const t = getTicketRow(app, loc, ticketIdOf(loc, raw));
      if (!t) throw notFound('Ticket nicht gefunden');
      return t;
    };
    const detail = (loc: string, t: any) => {
      const row = db.get(
        `SELECT (SELECT name FROM users WHERE id = ?) AS owner_name, (SELECT name FROM helpdesk_teams WHERE id = ?) AS team_name`,
        t.owner_id,
        t.team_id,
      );
      return { ...ticketOut(app, t), ...row };
    };

    // --- lookups for the screens ------------------------------------------------------------
    const teamsOf = (loc: string) => parseRows(db.all('SELECT * FROM helpdesk_teams WHERE location_id = ? ORDER BY name', loc), ['members']);
    router.get('/api/tickets/meta', 'location', (ctx) => {
      const s = loadHelpdeskSettings(app, ctx.locationId);
      return {
        pipelines: ticketPipelines(app, ctx.locationId),
        agents: agentsOf(app, ctx.locationId),
        teams: teamsOf(ctx.locationId),
        categories: s.categories,
        priorities: PRIORITIES.map((p) => [p, PRIORITY_LABELS[p]]),
        sources: SOURCES,
        stage_kinds: STAGE_KINDS,
        me: ctx.user?.id ?? null,
        sla_enabled: s.sla.enabled,
      };
    });
    router.get('/api/helpdesk/agents', 'location', (ctx) => agentsOf(app, ctx.locationId));

    // --- tickets ---------------------------------------------------------------------------------
    router.get('/api/tickets', 'location', (ctx) => listTickets(app, ctx.locationId, Object.fromEntries(ctx.query), ctx.user?.id));

    router.post('/api/tickets', 'location', (ctx) => {
      const t = createTicket(app, ctx.locationId, ctx.body ?? {}, actorOf(ctx));
      return detail(ctx.locationId, t);
    });

    router.get('/api/tickets/:id', 'location', (ctx) => {
      const t = mustTicket(ctx.locationId, ctx.params.id);
      const contact = t.contact_id ? getContact(app, ctx.locationId, t.contact_id) : null;
      const others = t.contact_id
        ? db.all(`SELECT id, number, subject, status_kind, stage_id, priority, updated_at FROM tickets WHERE contact_id = ? AND location_id = ? AND id != ? ORDER BY updated_at DESC LIMIT 20`, t.contact_id, ctx.locationId, t.id)
        : [];
      const merged = t.merged_into ? db.get('SELECT id, number, subject FROM tickets WHERE id = ?', t.merged_into) : null;
      return { ticket: detail(ctx.locationId, t), timeline: ticketTimeline(app, t.id), contact, others, merged_into: merged };
    });

    router.patch('/api/tickets/:id', 'location', (ctx) => {
      const t = mustTicket(ctx.locationId, ctx.params.id);
      return detail(ctx.locationId, updateTicket(app, ctx.locationId, t.id, ctx.body ?? {}, actorOf(ctx)));
    });

    router.delete('/api/tickets/:id', 'location', (ctx) => {
      const t = mustTicket(ctx.locationId, ctx.params.id);
      db.run('DELETE FROM tickets WHERE id = ? AND location_id = ?', t.id, ctx.locationId);
      return { ok: true };
    });

    router.post('/api/tickets/:id/reply', 'location', async (ctx) => {
      const t = mustTicket(ctx.locationId, ctx.params.id);
      const r = await replyToTicket(app, ctx.locationId, t.id, { body: ctx.body.body, channel: ctx.body.channel, subject: ctx.body.subject, isHtml: !!ctx.body.isHtml, status: ctx.body.status }, actorOf(ctx));
      return { message: r.message, ticket: detail(ctx.locationId, r.ticket) };
    });

    router.post('/api/tickets/:id/notes', 'location', (ctx) => {
      const t = mustTicket(ctx.locationId, ctx.params.id);
      const ev = addTicketEvent(app, t, 'note', { body: str(ctx.body.body, 'Notiz', { required: true, max: 20_000 }), userId: ctx.user?.id ?? null });
      db.run('UPDATE tickets SET updated_at = ? WHERE id = ?', now(), t.id);
      return ev;
    });

    router.post('/api/tickets/:id/merge', 'location', (ctx) => {
      const t = mustTicket(ctx.locationId, ctx.params.id);
      const ids = (Array.isArray(ctx.body.ids) ? ctx.body.ids : []).map((x: unknown) => ticketIdOf(ctx.locationId, String(x)));
      return detail(ctx.locationId, mergeTickets(app, ctx.locationId, t.id, ids, actorOf(ctx)));
    });

    router.post('/api/tickets/bulk', 'location', (ctx) => {
      const ids: string[] = uniq((Array.isArray(ctx.body.ids) ? ctx.body.ids : []).map(String)).slice(0, 500) as string[];
      if (!ids.length) throw bad('Keine Tickets gewählt');
      const action = String(ctx.body.action ?? '');
      const value = ctx.body.value;
      const actor = actorOf(ctx);
      const mine = ids.filter((x) => db.get('SELECT 1 FROM tickets WHERE id = ? AND location_id = ?', x, ctx.locationId));
      if (action === 'merge') {
        if (mine.length < 2) throw bad('Mindestens zwei Tickets zum Zusammenführen');
        const target = String(value || mine[0]);
        if (!mine.includes(target)) throw bad('Ziel-Ticket gehört nicht zur Auswahl');
        mergeTickets(app, ctx.locationId, target, mine, actor);
        return { count: mine.length, target };
      }
      if (!['delete', 'status', 'priority', 'owner', 'team', 'category', 'add_tag', 'remove_tag'].includes(action)) throw bad('Unbekannte Aktion');
      let count = 0;
      const skipped: { id: string; error: string }[] = [];
      for (const tid of mine) {
        try {
        if (action === 'delete') db.run('DELETE FROM tickets WHERE id = ? AND location_id = ?', tid, ctx.locationId);
        else if (action === 'status') updateTicket(app, ctx.locationId, tid, { status: value }, actor);
        else if (action === 'priority') updateTicket(app, ctx.locationId, tid, { priority: value }, actor);
        else if (action === 'owner') updateTicket(app, ctx.locationId, tid, { owner_id: value ?? '' }, actor);
        else if (action === 'team') updateTicket(app, ctx.locationId, tid, { team_id: value ?? '' }, actor);
        else if (action === 'category') updateTicket(app, ctx.locationId, tid, { category: value ?? '' }, actor);
        else if (action === 'add_tag' || action === 'remove_tag') {
          const tag = str(value, 'Tag', { required: true, max: 40 });
          const t = getTicketRow(app, ctx.locationId, tid);
          const tags: string[] = t.tags ?? [];
          updateTicket(app, ctx.locationId, tid, { tags: action === 'add_tag' ? uniq([...tags, tag]) : tags.filter((x) => x !== tag) }, actor);
        }
        count++;
        } catch (e) {
          // e.g. a stage of another pipeline: skip this ticket, keep going.
          if (!(e instanceof HttpError)) throw e;
          skipped.push({ id: tid, error: e.message });
        }
      }
      return { count, skipped };
    });

    /** "Ticket erstellen" in Konversationen: links the thread and starts with the latest customer message. */
    router.post('/api/tickets/from-conversation', 'location', (ctx) => {
      const conv = db.get('SELECT * FROM conversations WHERE id = ? AND location_id = ?', str(ctx.body.conversation_id, 'Konversation', { required: true }), ctx.locationId);
      if (!conv) throw notFound('Konversation nicht gefunden');
      const last = db.get(`SELECT * FROM messages WHERE conversation_id = ? AND direction = 'in' AND status != 'draft' ORDER BY created_at DESC LIMIT 1`, conv.id);
      const channelSource: Record<string, string> = { email: 'E-Mail', sms: 'SMS', chat: 'Chat', whatsapp: 'WhatsApp', call: 'Telefon' };
      const linked = last && !db.get('SELECT 1 FROM ticket_events WHERE message_id = ?', last.id) ? last : undefined;
      const t = createTicket(
        app,
        ctx.locationId,
        {
          ...ctx.body,
          subject: str(ctx.body.subject, 'Betreff', { max: 300 }) || String(last?.subject ?? '').replace(/^\s*(re|aw):\s*/i, '') || undefined,
          description: ctx.body.description ?? last?.body ?? '',
          contact_id: conv.contact_id,
          conversation_id: conv.id,
          source: ctx.body.source ?? channelSource[last?.channel ?? ''] ?? 'manuell',
          channel: ctx.body.channel ?? (last && ['email', 'sms', 'chat', 'whatsapp', 'messenger', 'instagram'].includes(last.channel) ? last.channel : undefined),
        },
        actorOf(ctx),
        linked ? { messageId: linked.id } : {},
      );
      return detail(ctx.locationId, t);
    });

    /** From a call (Anrufe): contact, transcript/voicemail text and the call are linked. */
    router.post('/api/tickets/from-call', 'location', (ctx) => {
      const call = db.get('SELECT * FROM calls WHERE id = ? AND location_id = ?', str(ctx.body.call_id, 'Anruf', { required: true }), ctx.locationId);
      if (!call) throw notFound('Anruf nicht gefunden');
      if (!call.contact_id) throw bad('Der Anruf hat keinen Kontakt');
      const when = new Date(call.started_at).toLocaleString('de-DE', { timeZone: app.location(ctx.locationId)?.timezone || 'Europe/Berlin' });
      const t = createTicket(
        app,
        ctx.locationId,
        {
          ...ctx.body,
          subject: str(ctx.body.subject, 'Betreff', { max: 300 }) || `${call.direction === 'in' ? 'Anruf' : 'Rückruf'} vom ${when}`,
          description: ctx.body.description ?? (call.transcription ? `Voicemail/Transkript:\n${call.transcription}` : `Anruf (${call.direction === 'in' ? 'eingehend' : 'ausgehend'}, ${call.status}) am ${when}.`),
          contact_id: call.contact_id,
          source: 'Telefon',
          channel: ctx.body.channel ?? 'sms',
          call_id: call.id,
        },
        actorOf(ctx),
      );
      return detail(ctx.locationId, t);
    });

    // --- pipelines ---------------------------------------------------------------------------------
    router.get('/api/helpdesk/pipelines', 'location', (ctx) => ticketPipelines(app, ctx.locationId));
    router.post('/api/helpdesk/pipelines', 'location', (ctx) => {
      ticketPipelines(app, ctx.locationId);
      const pos = db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM ticket_pipelines WHERE location_id = ?', ctx.locationId)!.n;
      const row = { id: id(), location_id: ctx.locationId, name: str(ctx.body.name, 'Name', { required: true, max: 80 }), stages: ctx.body.stages ? cleanStages(ctx.body.stages) : defaultStages(), position: pos, created_at: now(), updated_at: now() };
      db.insert('ticket_pipelines', row);
      return row;
    });
    router.patch('/api/helpdesk/pipelines/:id', 'location', (ctx) => {
      const p = parseJson(db.get('SELECT * FROM ticket_pipelines WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['stages']);
      if (!p) throw notFound();
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 80 });
      if (ctx.body.stages !== undefined) {
        const stages = cleanStages(ctx.body.stages);
        const gone = (p.stages as any[]).filter((s) => !stages.some((x) => x.id === s.id)).map((s) => s.id);
        if (gone.length) {
          const used = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets WHERE pipeline_id = ? AND stage_id IN (${gone.map(() => '?').join(',')})`, p.id, ...gone)!.n;
          if (used) throw bad(`In entfernten Stufen liegen noch ${used} Tickets – bitte erst verschieben`);
        }
        patch.stages = stages;
        // Kind changes (e.g. a stage now counts as "Gelöst") apply to the tickets in it.
        for (const s of stages) db.run('UPDATE tickets SET status_kind = ? WHERE pipeline_id = ? AND stage_id = ? AND status_kind != ?', s.kind, p.id, s.id, s.kind);
      }
      db.update('ticket_pipelines', p.id, patch, ctx.locationId);
      return parseJson(db.get('SELECT * FROM ticket_pipelines WHERE id = ?', p.id), ['stages']);
    });
    router.delete('/api/helpdesk/pipelines/:id', 'location', (ctx) => {
      const all = ticketPipelines(app, ctx.locationId);
      if (all.length < 2) throw bad('Die letzte Pipeline bleibt');
      if (db.get('SELECT 1 FROM tickets WHERE pipeline_id = ? LIMIT 1', ctx.params.id)) throw bad('In der Pipeline liegen noch Tickets');
      db.run('DELETE FROM ticket_pipelines WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    // --- teams ---------------------------------------------------------------------------------------
    const cleanMembers = (loc: string, v: unknown) => {
      const allowed = new Set(agentsOf(app, loc).map((a) => a.id));
      const list = uniq((Array.isArray(v) ? v : []).map(String));
      if (list.some((m) => !allowed.has(m))) throw bad('Mitglied hat keinen Zugriff auf diesen Sub-Account');
      return list;
    };
    router.get('/api/helpdesk/teams', 'location', (ctx) => teamsOf(ctx.locationId));
    router.post('/api/helpdesk/teams', 'location', (ctx) => {
      const row = { id: id(), location_id: ctx.locationId, name: str(ctx.body.name, 'Name', { required: true, max: 80 }), members: cleanMembers(ctx.locationId, ctx.body.members), round_robin: ctx.body.round_robin === false ? 0 : 1, created_at: now() };
      db.insert('helpdesk_teams', row);
      return row;
    });
    router.patch('/api/helpdesk/teams/:id', 'location', (ctx) => {
      const patch: Record<string, any> = {};
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 80 });
      if (ctx.body.members !== undefined) patch.members = cleanMembers(ctx.locationId, ctx.body.members);
      if (ctx.body.round_robin !== undefined) patch.round_robin = ctx.body.round_robin ? 1 : 0;
      if (!db.update('helpdesk_teams', ctx.params.id, patch, ctx.locationId)) throw notFound();
      return parseJson(db.get('SELECT * FROM helpdesk_teams WHERE id = ?', ctx.params.id), ['members']);
    });
    router.delete('/api/helpdesk/teams/:id', 'location', (ctx) => {
      db.run('UPDATE tickets SET team_id = NULL WHERE team_id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      db.run('DELETE FROM helpdesk_teams WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    // --- saved views (own + shared) ----------------------------------------------------------------
    const VIEW_KEYS = ['state', 'pipeline_id', 'stage_id', 'priority', 'owner', 'team_id', 'category', 'tag', 'source', 'sla', 'q', 'sort', 'layout'];
    router.get('/api/helpdesk/views', 'location', (ctx) =>
      parseRows(db.all('SELECT * FROM helpdesk_views WHERE location_id = ? AND (user_id IS NULL OR user_id = ?) ORDER BY name', ctx.locationId, ctx.user?.id ?? ''), ['filters']),
    );
    router.post('/api/helpdesk/views', 'location', (ctx) => {
      const f = ctx.body.filters && typeof ctx.body.filters === 'object' ? ctx.body.filters : {};
      const filters = Object.fromEntries(VIEW_KEYS.filter((k) => f[k] !== undefined && f[k] !== '').map((k) => [k, String(f[k]).slice(0, 200)]));
      const row = { id: id(), location_id: ctx.locationId, user_id: ctx.body.shared ? null : (ctx.user?.id ?? null), name: str(ctx.body.name, 'Name', { required: true, max: 60 }), filters, created_at: now() };
      db.insert('helpdesk_views', row);
      return row;
    });
    router.delete('/api/helpdesk/views/:id', 'location', (ctx) => {
      db.run('DELETE FROM helpdesk_views WHERE id = ? AND location_id = ? AND (user_id IS NULL OR user_id = ?)', ctx.params.id, ctx.locationId, ctx.user?.id ?? '');
      return { ok: true };
    });

    // --- canned responses ------------------------------------------------------------------------------
    const cannedIn = (b: any) => ({
      name: str(b.name, 'Name', { required: true, max: 80 }),
      shortcut: str(b.shortcut, 'Kürzel', { max: 30 }).replace(/^\//, ''),
      subject: str(b.subject, 'Betreff', { max: 300 }),
      body: str(b.body, 'Text', { required: true, max: 20_000 }),
      category: str(b.category, 'Kategorie', { max: 60 }),
    });
    router.get('/api/helpdesk/canned', 'location', (ctx) => db.all('SELECT * FROM helpdesk_canned WHERE location_id = ? ORDER BY name', ctx.locationId));
    router.post('/api/helpdesk/canned', 'location', (ctx) => {
      const row = { id: id(), location_id: ctx.locationId, ...cannedIn(ctx.body), created_at: now(), updated_at: now() };
      db.insert('helpdesk_canned', row);
      return row;
    });
    router.patch('/api/helpdesk/canned/:id', 'location', (ctx) => {
      const cur = db.get('SELECT * FROM helpdesk_canned WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!cur) throw notFound();
      db.update('helpdesk_canned', cur.id, { ...cannedIn({ ...cur, ...ctx.body }), updated_at: now() }, ctx.locationId);
      return db.get('SELECT * FROM helpdesk_canned WHERE id = ?', cur.id);
    });
    router.delete('/api/helpdesk/canned/:id', 'location', (ctx) => {
      db.run('DELETE FROM helpdesk_canned WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });
    /** A canned response with the placeholders filled for one ticket. */
    router.post('/api/helpdesk/canned/:id/render', 'location', (ctx) => {
      const c = db.get('SELECT * FROM helpdesk_canned WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound();
      const t = mustTicket(ctx.locationId, str(ctx.body.ticket_id, 'Ticket', { required: true }));
      return { subject: c.subject ? renderTicketText(app, t, c.subject, ctx.user?.id) : '', body: renderTicketText(app, t, c.body, ctx.user?.id) };
    });

    // --- settings ----------------------------------------------------------------------------------
    const supportHook = (loc: string) => {
      let key = helpdeskState(app, loc).support_key;
      if (!key) {
        key = token(18);
        setHelpdeskState(app, loc, { support_key: key });
      }
      return `${app.baseUrl()}/hooks/${loc}/support-email?key=${key}`;
    };
    const helpBase = (loc: string, slug: string) => `${app.baseUrl()}/help/${encodeURIComponent(slug || loc)}`;
    const settingsOut = (loc: string) => {
      const s = loadHelpdeskSettings(app, loc);
      return { settings: s, support_hook: supportHook(loc), help_center_url: helpBase(loc, s.help_center.slug), timezone: app.location(loc)?.timezone ?? 'Europe/Berlin' };
    };
    router.get('/api/helpdesk/settings', 'location', (ctx) => settingsOut(ctx.locationId));
    router.put('/api/helpdesk/settings', 'location', (ctx) => {
      const cur = loadHelpdeskSettings(app, ctx.locationId);
      const next = cleanHelpdeskSettings(ctx.body ?? {}, cur);
      const hc = next.help_center;
      if (hc.enabled && !hc.slug) hc.slug = slugify(app.location(ctx.locationId)?.name ?? 'hilfe');
      if (hc.slug) {
        let slug = hc.slug;
        const taken = (s: string) => !!db.get(`SELECT 1 FROM helpdesk_settings WHERE location_id != ? AND json_extract(data, '$.help_center.slug') = ?`, ctx.locationId, s);
        if (taken(slug) && ctx.body?.help_center?.slug) throw bad('Diese Adresse ist schon vergeben');
        for (let i = 2; taken(slug); i++) slug = `${hc.slug}-${i}`;
        hc.slug = slug;
      }
      if (hc.domain) {
        if (db.get(`SELECT 1 FROM helpdesk_settings WHERE location_id != ? AND json_extract(data, '$.help_center.domain') = ?`, ctx.locationId, hc.domain)) throw bad('Diese Domain nutzt schon ein anderes Hilfe-Center');
        if (db.get('SELECT 1 FROM funnels WHERE domain = ?', hc.domain)) throw bad('Diese Domain ist schon mit einer Website verbunden – dort erscheint das Hilfe-Center unter /help');
        if (hc.domain !== cur.help_center.domain && app.services.domainTaken?.(hc.domain, { helpCenter: ctx.locationId }, ctx)) throw bad('Diese Domain ist schon vergeben');
      }
      for (const r of next.assignment.rules) {
        if (r.team_id && !db.get('SELECT 1 FROM helpdesk_teams WHERE id = ? AND location_id = ?', r.team_id, ctx.locationId)) throw bad('Unbekanntes Team in einer Regel');
        if (r.user_id && !agentsOf(app, ctx.locationId).some((a) => a.id === r.user_id)) throw bad('Unbekannter Mitarbeiter in einer Regel');
      }
      // Turning on "imported mail" starts after the mail already there (no flood of old tickets).
      if (next.email_to_ticket.include_imported && !cur.email_to_ticket.include_imported) setHelpdeskState(app, ctx.locationId, { mail_cursor: db.get<{ n: number }>('SELECT COALESCE(MAX(rowid), 0) AS n FROM messages')!.n });
      saveHelpdeskSettings(app, ctx.locationId, next);
      return settingsOut(ctx.locationId);
    });
    router.post('/api/helpdesk/settings/rotate-key', 'location', (ctx) => {
      setHelpdeskState(app, ctx.locationId, { support_key: token(18) });
      return settingsOut(ctx.locationId);
    });

    // --- inbound: support mailbox, any inbound message, imported mail, forms -----------------------------
    /** Mail forwarding for the support address (Cloudflare Email Workers, ImprovMX, Mailgun…): every mail becomes or joins a ticket. */
    router.post('/hooks/:loc/support-email', 'public', (ctx) => {
      const key = helpdeskState(app, ctx.params.loc).support_key;
      if (!key || !app.location(ctx.params.loc) || !safeEqual(ctx.query.get('key'), key)) throw new HttpError(401, 'Falscher Schlüssel');
      const b = ctx.body ?? {};
      const rawFrom = String(b.from ?? b.sender ?? b.From ?? '');
      const email = (rawFrom.match(/<([^>]+)>/)?.[1] ?? rawFrom).trim().toLowerCase();
      const name = rawFrom.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim();
      const body = String(b.text ?? b['body-plain'] ?? b.body ?? b.html ?? '').slice(0, 200_000);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !body.trim()) throw bad('from/text fehlen');
      // A forwarding service that missed our answer sends the mail again: the same Message-Id joins the ticket once.
      if (!firstSeen(app, ctx.params.loc, 'support-hook', inboundMessageId(b))) return { ok: true, duplicate: true, ticket: null };
      const to = String(b.to ?? b.recipient ?? b.To ?? '').slice(0, 1000);
      const msg = receiveMessage(app, ctx.params.loc, { channel: 'email', from: email, name, subject: String(b.subject ?? b.Subject ?? '').slice(0, 300), body, to });
      const r = routeInbound(app, ctx.params.loc, msg, { to: addresses(to), forceTicket: true });
      return { ok: true, ticket: r ? { id: r.ticket.id, number: r.ticket.number, created: r.created } : null };
    });

    app.events.on('message.inbound', (e) => {
      const m = e.data.message;
      if (!m?.id) return;
      routeInbound(app, e.locationId, m, { to: addresses(e.data.to) });
    });

    // Mail from the IMAP mailbox sync / import (no inbound event) – only when switched on.
    app.onTick(() => {
      const locs = db.all(`SELECT location_id FROM helpdesk_settings WHERE json_extract(data, '$.email_to_ticket.include_imported') = 1`);
      for (const { location_id: loc } of locs) {
        const s = loadHelpdeskSettings(app, loc);
        if (s.email_to_ticket.mode === 'off') continue;
        const cursor = Number(helpdeskState(app, loc).mail_cursor ?? 0);
        const rows = db.all(
          `SELECT rowid AS rid, * FROM messages WHERE location_id = ? AND rowid > ? AND direction = 'in' AND channel = 'email' AND status = 'received' AND source != 'eingehend' ORDER BY rowid LIMIT 200`,
          loc,
          cursor,
        );
        for (const m of rows) {
          try {
            routeInbound(app, loc, m);
          } catch (err) {
            console.error('[tickets] imported mail', (err as Error).message);
          }
        }
        if (rows.length) setHelpdeskState(app, loc, { mail_cursor: rows[rows.length - 1].rid });
      }
    });

    // Forms with "als Ticket anlegen".
    app.events.on('form.submitted', (e) => {
      const form = parseJson(db.get('SELECT id, name, settings FROM forms WHERE id = ?', e.data.formId), ['settings']);
      const fs = form?.settings ?? {};
      if (!form || !fs.create_ticket || !e.data.contactId) return;
      const answers: Record<string, any> = e.data.answers ?? {};
      const subjectKey = Object.keys(answers).find((k) => /betreff|subject|anliegen|thema/i.test(k));
      const lines = Object.entries(answers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      const t = createTicket(
        app,
        e.locationId,
        {
          subject: (subjectKey ? String(answers[subjectKey]) : '') || `${form.name}`,
          description: lines.join('\n'),
          contact_id: e.data.contactId,
          source: 'Formular',
          priority: fs.ticket_priority || 'normal',
          category: fs.ticket_category || '',
          team_id: fs.ticket_team_id || undefined,
          form_submission_id: e.data.submission?.id,
        },
        { via: 'form' },
      );
      return sendAutoReply(app, e.locationId, t.id).then(() => undefined);
    });

    // --- workflows: triggers, actions, recipe ------------------------------------------------------------
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), ...TRIGGERS];
    const ticketForRun = (run: any): string | null => {
      const fromEvent = run.event?.ticketId;
      if (fromEvent && db.get('SELECT 1 FROM tickets WHERE id = ? AND location_id = ?', fromEvent, run.location_id)) return fromEvent;
      return db.get(`SELECT id FROM tickets WHERE location_id = ? AND contact_id = ? AND status_kind IN ('new','open','waiting') ORDER BY updated_at DESC LIMIT 1`, run.location_id, run.contact_id)?.id ?? null;
    };
    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      ticket_create: async (run: any, step: any, vars: Record<string, any>) => {
        const t = (s: unknown) => render(String(s ?? ''), vars);
        const ticket = createTicket(
          app,
          run.location_id,
          { subject: t(step.subject) || 'Neues Ticket', description: t(step.description), contact_id: run.contact_id, priority: step.priority || 'normal', category: step.category || '', team_id: step.team_id || undefined, owner_id: step.owner_id || undefined, pipeline_id: step.pipeline_id || undefined, source: 'Workflow' },
          { via: 'workflow' },
        );
        return `Ticket #${ticket.number} angelegt`;
      },
      /** Escalation: raise priority, reassign, change status, note – on the ticket from the trigger (else the contact's open ticket). */
      ticket_update: async (run: any, step: any, vars: Record<string, any>) => {
        const tid = ticketForRun(run);
        if (!tid) return 'kein offenes Ticket';
        const patch: Record<string, any> = {};
        if (step.status) patch.status = step.status;
        if (step.priority) patch.priority = step.priority;
        if (step.team_id) patch.team_id = step.team_id === '__none' ? '' : step.team_id;
        if (step.owner_id) patch.owner_id = step.owner_id === '__none' ? '' : step.owner_id;
        if (step.note) patch.note = render(String(step.note), vars);
        const before = getTicketRow(app, run.location_id, tid);
        if (Array.isArray(step.tags) && step.tags.length) patch.tags = uniq([...(before.tags ?? []), ...step.tags.map(String)]);
        const t = updateTicket(app, run.location_id, tid, patch, { via: 'workflow' });
        if (step.notify_owner && t.owner_id) {
          const owner = db.get('SELECT email, name FROM users WHERE id = ?', t.owner_id);
          if (owner?.email) await notifyTeam(app, run.location_id, `Ticket #${t.number} braucht Aufmerksamkeit`, `${t.subject}\n\n${render(String(step.note ?? ''), vars)}\n\n${app.baseUrl()}/app/tickets/${t.id}`, owner.email);
          void Promise.resolve(app.services.pushNotify?.({ userIds: [t.owner_id], kind: 'tasks', title: `Ticket #${t.number} eskaliert`, body: t.subject, url: `/app/tickets/${t.id}`, tag: `ticket-${t.id}` })).catch(() => {});
        }
        return `Ticket #${t.number} geändert`;
      },
    };
    app.services.workflowRecipes = {
      ...(app.services.workflowRecipes ?? {}),
      ticket_breach: {
        name: 'SLA überschritten: Priorität hoch + Team informieren',
        trigger: { type: 'sla.breached', config: {} },
        settings: { allow_reentry: true },
        steps: [
          { type: 'ticket_update', priority: 'raise', note: 'Automatisch eskaliert: SLA überschritten.', notify_owner: true },
          { type: 'notify', subject: 'SLA überschritten: Ticket #{{event.ticket.number}}', body: '{{event.ticket.subject}}\n{{event.ticket.url}}' },
        ],
      },
      ticket_ack: {
        name: 'Neues Ticket: Eingangsbestätigung',
        trigger: { type: 'ticket.created', config: {} },
        settings: { allow_reentry: true },
        steps: [{ type: 'send_email', subject: 'Deine Anfrage #{{event.ticket.number}}: {{event.ticket.subject}}', body: 'Hallo {{contact.first_name|}},\n\nwir haben deine Anfrage erhalten und kümmern uns darum.\n\nViele Grüße\n{{location.name}}' }],
      },
    };

    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    // HubSpot (and other) imports hand their tickets here – see docs/integrations.md.
    app.services.ticketsImport = (locationId: string, input: any) => importTicket(app, locationId, input);
    app.services.helpdesk = { createTicket: (loc: string, input: any, actor?: Actor) => createTicket(app, loc, input, actor), updateTicket: (loc: string, tid: string, patch: any, actor?: Actor) => updateTicket(app, loc, tid, patch, actor) };

  },
};

