import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, str, type Ctx } from '../core/http.js';
import { callRoute, ownLocation, scope } from '../services/mobile.js';
import { PRIORITIES, STATUSES, VIEWS } from '../services/teaminbox-model.js';
import type { Caller, Tool } from './mcp.js';

/**
 * MCP tools of the Team-Posteingang (HyperLevel Agent, Claude, ChatGPT, Codex) and its endpoints for the native app. Both are thin
 * relays onto the REST routes of modules/teaminbox.ts: the key's sub-account, the member's areas and the audit log apply.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const CONV = { conversation_id: { type: 'string', description: 'Konversations-ID (aus ghl_inbox_queue)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const q = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  return s.toString() ? `?${s}` : '';
};
const link = (id?: string) => `/app/conversations${id ? `/${id}` : ''}`;

const NOTE =
  'Interne Notizen sieht nur das Team – sie werden nie an den Kontakt gesendet. Status: open (offen), waiting (wartet auf den Kontakt), closed (erledigt); eine neue Nachricht des Kontakts öffnet die Konversation wieder.';

/** A person by id, "me", "none" (unassign), e-mail or name – the way an assistant would name them. */
async function person(call: Caller, location: string, who: unknown): Promise<string | null | undefined> {
  if (who === undefined) return undefined;
  const s = String(who ?? '').trim();
  if (!s || /^(none|niemand|unassign)$/i.test(s)) return null;
  if (s === 'me') return 'me';
  const meta = await call.api('GET', '/api/inbox/meta', { location });
  const people: { id: string; name: string; email: string }[] = meta.people ?? [];
  const lower = s.toLowerCase();
  const exact = people.filter((p) => p.id === s || p.email.toLowerCase() === lower || p.name.toLowerCase() === lower);
  const pool = exact.length ? exact : people.filter((p) => p.name.toLowerCase().includes(lower) || p.name.toLowerCase().split(/\s+/)[0] === lower);
  if (pool.length === 1) return pool[0].id;
  throw new HttpError(400, pool.length ? `„${s}“ ist nicht eindeutig – gemeint sein könnten: ${pool.map((p) => `${p.name} (${p.id})`).join(', ')}` : `Keine Person „${s}“ gefunden – möglich: ${people.map((p) => p.name).join(', ')}`);
}

export const INBOX_TOOLS: Tool[] = [
  {
    name: 'ghl_inbox_queue',
    title: 'Posteingang: Warteschlange',
    description: `Die Konversationen des Team-Posteingangs, sortiert wie in der Oberfläche: Kontakt, Kanal, letzte Nachricht, Bearbeiter, Status, Priorität, Antwortfrist (sla.state: ok, warning, breached) und Zurückstellung. view: open (offen), mine (mir zugewiesen), unassigned (nicht zugewiesen), team, waiting, done (erledigt), snoozed (zurückgestellt), sla (Antwortfrist gefährdet oder überschritten), mentions (Erwähnungen von mir), all. ${NOTE}`,
    inputSchema: obj(
      {
        ...LOC,
        view: { type: 'string', enum: [...VIEWS], description: 'Ansicht, Standard open' },
        assignee: { type: 'string', description: 'me, none oder die ID einer Person' },
        status: { type: 'string', enum: [...STATUSES] },
        priority: { type: 'string', enum: [...PRIORITIES] },
        channel: { type: 'string', description: 'email, sms, chat, whatsapp …' },
        query: { type: 'string', description: 'Suche in Name, E-Mail, Telefon und letzter Nachricht' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      ['location_id'],
    ),
    annotations: RO,
    run: async (call, a) => {
      const r = await call.api('GET', `/api/inbox/queue${q({ view: a.view, assignee: a.assignee, status: a.status, priority: a.priority, channel: a.channel, q: a.query, limit: a.limit ?? 25 })}`, { location: a.location_id });
      const counts = await call.api('GET', '/api/inbox/counts', { location: a.location_id }).catch(() => undefined);
      return { ...r, counts, link: link() };
    },
  },
  {
    name: 'ghl_inbox_assign',
    title: 'Posteingang: Konversation zuweisen',
    description: `Weist eine Konversation einer Person zu. assignee: ID, E-Mail oder Name der Person, „me“ (die Person hinter dem Zugang) oder „none“, um die Zuweisung aufzuheben. team_id weist zusätzlich einem Team zu (Service → Teams). Die Person bekommt eine Push-Nachricht, wenn jemand anderes zuweist. ${NOTE}`,
    inputSchema: obj({ ...LOC, ...CONV, assignee: { type: 'string', description: 'Person: ID, E-Mail, Name, „me“ oder „none“' }, team_id: { type: 'string', description: 'Team-ID oder leer' } }, ['location_id', 'conversation_id']),
    annotations: { ...W, idempotentHint: true },
    run: async (call, a) => {
      if (a.assignee === undefined && a.team_id === undefined) throw new HttpError(400, 'assignee oder team_id angeben');
      const uid = await person(call, a.location_id, a.assignee);
      const r = await call.api('POST', `/api/inbox/conversations/${encodeURIComponent(a.conversation_id)}/assign`, { location: a.location_id, body: { ...(uid !== undefined ? { user_id: uid } : {}), ...(a.team_id !== undefined ? { team_id: a.team_id || null } : {}) } });
      return { conversation_id: r.conversation_id, assignee_id: r.assignee_id, assignee_name: r.assignee_name, team_id: r.team_id, status: r.status, link: link(r.conversation_id) };
    },
  },
  {
    name: 'ghl_inbox_set_status',
    title: 'Posteingang: Status, Zurückstellen, Priorität',
    description: `Setzt den Status einer Konversation (open, waiting, closed) und/oder stellt sie bis zu einem Zeitpunkt zurück (snooze_until, ISO-Zeitstempel in der Zukunft; sie kommt dann von selbst wieder, auch bei einer neuen Nachricht des Kontakts) und/oder ändert die Priorität (low, normal, high, urgent). ${NOTE}`,
    inputSchema: obj(
      {
        ...LOC,
        ...CONV,
        status: { type: 'string', enum: [...STATUSES] },
        snooze_until: { type: 'string', description: 'ISO-Zeitpunkt, bis zu dem die Konversation ausgeblendet wird; leer hebt das Zurückstellen auf' },
        priority: { type: 'string', enum: [...PRIORITIES] },
      },
      ['location_id', 'conversation_id'],
    ),
    annotations: { ...W, idempotentHint: true },
    run: async (call, a) => {
      if (a.status === undefined && a.snooze_until === undefined && a.priority === undefined) throw new HttpError(400, 'status, snooze_until oder priority angeben');
      const base = `/api/inbox/conversations/${encodeURIComponent(a.conversation_id)}`;
      let r: any;
      if (a.status !== undefined || a.snooze_until !== undefined) r = await call.api('POST', `${base}/status`, { location: a.location_id, body: { ...(a.status !== undefined ? { status: a.status } : {}), ...(a.snooze_until !== undefined ? { snooze_until: a.snooze_until || null } : {}) } });
      if (a.priority !== undefined) r = await call.api('POST', `${base}/priority`, { location: a.location_id, body: { priority: a.priority } });
      return { conversation_id: r.conversation_id, status: r.status, snoozed_until: r.snoozed_until, priority: r.priority, assignee_name: r.assignee_name, link: link(r.conversation_id) };
    },
  },
  {
    name: 'ghl_inbox_note',
    title: 'Posteingang: Interne Notiz',
    description: `Schreibt eine interne Notiz in eine Konversation. Mit @Name (ganzer Name oder eindeutiger Vorname) werden Kolleginnen und Kollegen erwähnt und per App, Push und – wenn eingeschaltet – E-Mail benachrichtigt. ${NOTE}`,
    inputSchema: obj({ ...LOC, ...CONV, body: { type: 'string', description: 'Text der Notiz, bis 10.000 Zeichen' } }, ['location_id', 'conversation_id', 'body']),
    annotations: W,
    run: async (call, a) => {
      const r = await call.api('POST', `/api/inbox/conversations/${encodeURIComponent(a.conversation_id)}/notes`, { location: a.location_id, body: { body: a.body } });
      return { note_id: r.id, mentioned: r.mentioned, conversation_id: a.conversation_id, link: link(a.conversation_id) };
    },
  },
];

export const teamInboxToolsModule: Module = {
  name: 'teaminbox-tools',
  register(app) {
    const { router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...INBOX_TOOLS];

    /** The outer /api/mobile route is not logged itself – the relayed route is (with via "app"). */
    const relay = (ctx: Ctx) => {
      ctx.skipAfterWrite = true;
    };
    const base = (id: string) => `/api/inbox/conversations/${encodeURIComponent(id)}`;

    // The queue of all sub-accounts the login may read (or one: ?location=).
    router.get('/api/mobile/inbox/queue', 'user', async (ctx) => {
      const locs = scope(app, ctx, 'conversations');
      const limit = clampLimit(ctx.query.get('limit'), 20, 50);
      const view = String(ctx.query.get('view') ?? 'open');
      const rows: any[] = [];
      for (const loc of locs) {
        const r = await callRoute<{ conversations: any[] }>(app, ctx, 'GET', `/api/inbox/queue${q({ view, assignee: ctx.query.get('assignee'), status: ctx.query.get('status'), priority: ctx.query.get('priority'), limit })}`, { locationId: loc.id });
        for (const c of r.conversations) rows.push({ ...c, location_id: loc.id, location_name: loc.name });
      }
      rows.sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)));
      return { view, conversations: rows.slice(0, limit) };
    });

    router.get('/api/mobile/conversations/:id/team', 'user', async (ctx) => {
      const loc = ownLocation(app, ctx, 'conversations', ctx.params.id, 'Konversation nicht gefunden');
      const s = await callRoute<any>(app, ctx, 'GET', base(ctx.params.id), { locationId: loc.id });
      return { ...s, location_id: loc.id, location_name: loc.name };
    });

    router.get('/api/mobile/inbox/people', 'user', async (ctx) => {
      const locs = scope(app, ctx, 'conversations');
      const out: any[] = [];
      for (const loc of locs) {
        const m = await callRoute<any>(app, ctx, 'GET', '/api/inbox/meta', { locationId: loc.id });
        out.push({ location_id: loc.id, location_name: loc.name, people: m.people.map((p: any) => ({ id: p.id, name: p.name, away: p.away, me: p.me })), teams: m.teams.map((t: any) => ({ id: t.id, name: t.name })) });
      }
      return { locations: out };
    });

    router.post('/api/mobile/conversations/:id/assign', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLocation(app, ctx, 'conversations', ctx.params.id, 'Konversation nicht gefunden');
      const b = ctx.body ?? {};
      if (b.user_id === undefined && b.team_id === undefined) throw bad('user_id (oder „me“, null) oder team_id angeben');
      return callRoute(app, ctx, 'POST', `${base(ctx.params.id)}/assign`, { locationId: loc.id, body: { ...(b.user_id !== undefined ? { user_id: b.user_id } : {}), ...(b.team_id !== undefined ? { team_id: b.team_id } : {}) } });
    });

    router.post('/api/mobile/conversations/:id/status', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLocation(app, ctx, 'conversations', ctx.params.id, 'Konversation nicht gefunden');
      const b = ctx.body ?? {};
      if (b.status === undefined && b.snooze_until === undefined && b.priority === undefined) throw bad('status, snooze_until oder priority angeben');
      let r: any;
      if (b.status !== undefined || b.snooze_until !== undefined) r = await callRoute(app, ctx, 'POST', `${base(ctx.params.id)}/status`, { locationId: loc.id, body: { ...(b.status !== undefined ? { status: b.status } : {}), ...(b.snooze_until !== undefined ? { snooze_until: b.snooze_until } : {}) } });
      if (b.priority !== undefined) r = await callRoute(app, ctx, 'POST', `${base(ctx.params.id)}/priority`, { locationId: loc.id, body: { priority: b.priority } });
      return r;
    });

    router.post('/api/mobile/conversations/:id/notes', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLocation(app, ctx, 'conversations', ctx.params.id, 'Konversation nicht gefunden');
      return callRoute(app, ctx, 'POST', `${base(ctx.params.id)}/notes`, { locationId: loc.id, body: { body: str(ctx.body?.body, 'Notiz', { required: true, max: 10_000 }) } });
    });
  },
};
