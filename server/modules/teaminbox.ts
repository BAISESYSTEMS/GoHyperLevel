import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, type Ctx } from '../core/http.js';
import { contactName } from '../services/contacts.js';
import { PUSH_KINDS } from './push.js';
import { availabilityOf, awayUntil, isAway } from '../services/team-people.js';
import { poolOf } from '../services/teaminbox-assign.js';
import { resolve, scopeClause } from '../services/record-access.js';
import {
  PRIORITIES,
  PRIORITY_LABEL,
  STATUSES,
  STATUS_LABEL,
  VIEWS,
  VIEW_LABEL,
  cleanSettings,
  isView,
  slaStateOf,
  viewOrder,
  viewSql,
} from '../services/teaminbox-model.js';
import {
  addNote,
  agentsOf,
  deleteNote,
  getConv,
  hubOf,
  markMentionsSeen,
  saveSettings,
  setAssignee,
  setPriority,
  setStatus,
  settingsOf,
  timeline,
  whoOf,
  type ConvRow,
} from '../services/teaminbox-store.js';

/**
 * Team-Posteingang: every conversation gets an assignee (a person, or a team that takes turns), a status (open / waiting /
 * done), a snooze, a priority and internal notes with @mentions. Views and filters are served through the hooks of the
 * normal conversation list (conversationFilters / conversationRows) and a compact queue for the app and MCP. This file
 * owns the tables and the routes; rules, SLA timers and realtime live in teaminbox-engine.ts.
 */

const FRESH = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days')`;
const RESPONDED = ['sent', 'logged', 'delivered', 'read'].map((s) => `'${s}'`).join(',');

/** Bookkeeping of the answer timers, in SQL on the messages table: it works for every way a message gets in or out. */
function triggers(): string {
  const respond = (at: string) => `
    INSERT INTO inbox_response_log (id, location_id, conversation_id, contact_id, kind, inbound_at, responded_at, responder_id, assignee_id, due_at, breached, outcome)
      SELECT lower(hex(randomblob(8))), v.location_id, v.id, v.contact_id, CASE WHEN v.awaiting_kind = '' THEN 'first' ELSE v.awaiting_kind END, v.awaiting_since, ${at}, NEW.user_id, v.assignee_id, v.response_due_at,
             CASE WHEN v.response_due_at IS NOT NULL AND ${at} > v.response_due_at THEN 1 ELSE 0 END, 'replied'
      FROM conversations v WHERE v.id = NEW.conversation_id AND v.awaiting_since IS NOT NULL AND ${at} >= v.awaiting_since;
    UPDATE conversations SET
      awaiting_kind = CASE WHEN awaiting_since IS NOT NULL AND ${at} >= awaiting_since THEN '' ELSE awaiting_kind END,
      response_due_at = CASE WHEN awaiting_since IS NOT NULL AND ${at} >= awaiting_since THEN NULL ELSE response_due_at END,
      response_warn_at = CASE WHEN awaiting_since IS NOT NULL AND ${at} >= awaiting_since THEN NULL ELSE response_warn_at END,
      sla_state = CASE WHEN awaiting_since IS NOT NULL AND ${at} >= awaiting_since THEN '' ELSE sla_state END,
      sla_dirty = CASE WHEN awaiting_since IS NOT NULL AND ${at} >= awaiting_since THEN 0 ELSE sla_dirty END,
      awaiting_since = CASE WHEN awaiting_since IS NOT NULL AND ${at} >= awaiting_since THEN NULL ELSE awaiting_since END,
      first_response_at = COALESCE(first_response_at, ${at}),
      last_out_at = MAX(COALESCE(last_out_at, ''), ${at}),
      last_out_user = COALESCE(NEW.user_id, last_out_user),
      out_pending = 1
    WHERE id = NEW.conversation_id;`;
  // A human answer: a person sent it (user_id) or it came through the API/MCP as a manual message. Calls and automated
  // messages (campaigns, workflows, the AI assistant) never stop the timer.
  const human = `NEW.direction = 'out' AND NEW.channel != 'call' AND NEW.status IN (${RESPONDED}) AND (NEW.user_id IS NOT NULL OR NEW.source = 'manuell')`;
  return `
    CREATE TRIGGER teaminbox_in AFTER INSERT ON messages
    WHEN NEW.direction = 'in' AND NEW.channel != 'call'
    BEGIN
      UPDATE conversations SET
        last_in_at = MAX(COALESCE(last_in_at, ''), NEW.created_at),
        awaiting_kind = CASE WHEN awaiting_since IS NULL AND NEW.created_at > ${FRESH} THEN CASE WHEN first_response_at IS NULL THEN 'first' ELSE 'next' END ELSE awaiting_kind END,
        sla_dirty = CASE WHEN awaiting_since IS NULL AND NEW.created_at > ${FRESH} THEN 1 ELSE sla_dirty END,
        awaiting_since = CASE WHEN awaiting_since IS NULL AND NEW.created_at > ${FRESH} THEN NEW.created_at ELSE awaiting_since END
      WHERE id = NEW.conversation_id;
    END;
    CREATE TRIGGER teaminbox_out_ins AFTER INSERT ON messages WHEN ${human}
    BEGIN ${respond('NEW.created_at')} END;
    CREATE TRIGGER teaminbox_out_upd AFTER UPDATE OF status ON messages WHEN ${human} AND OLD.status NOT IN (${RESPONDED})
    BEGIN ${respond(`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)} END;`;
}

export const teamInboxModule: Module = {
  name: 'teaminbox',
  migrations: [
    [
      '001-init',
      `
      ALTER TABLE conversations ADD COLUMN assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE conversations ADD COLUMN team_id TEXT;
      ALTER TABLE conversations ADD COLUMN inbox_status TEXT NOT NULL DEFAULT 'open';
      ALTER TABLE conversations ADD COLUMN snoozed_until TEXT;
      ALTER TABLE conversations ADD COLUMN snoozed_at TEXT;
      ALTER TABLE conversations ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
      ALTER TABLE conversations ADD COLUMN assigned_at TEXT;
      ALTER TABLE conversations ADD COLUMN closed_at TEXT;
      ALTER TABLE conversations ADD COLUMN last_in_at TEXT;
      ALTER TABLE conversations ADD COLUMN last_out_at TEXT;
      ALTER TABLE conversations ADD COLUMN last_out_user TEXT;
      ALTER TABLE conversations ADD COLUMN out_pending INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversations ADD COLUMN awaiting_since TEXT;
      ALTER TABLE conversations ADD COLUMN awaiting_kind TEXT NOT NULL DEFAULT '';
      ALTER TABLE conversations ADD COLUMN response_due_at TEXT;
      ALTER TABLE conversations ADD COLUMN response_warn_at TEXT;
      ALTER TABLE conversations ADD COLUMN sla_state TEXT NOT NULL DEFAULT '';
      ALTER TABLE conversations ADD COLUMN first_response_at TEXT;
      ALTER TABLE conversations ADD COLUMN sla_dirty INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX conv_inbox ON conversations(location_id, inbox_status, assignee_id);
      CREATE INDEX conv_inbox_sla ON conversations(response_due_at) WHERE awaiting_since IS NOT NULL;
      CREATE INDEX conv_inbox_snooze ON conversations(snoozed_until) WHERE snoozed_until IS NOT NULL;
      CREATE INDEX conv_inbox_dirty ON conversations(sla_dirty) WHERE sla_dirty = 1;
      CREATE INDEX conv_inbox_outp ON conversations(out_pending) WHERE out_pending = 1;

      CREATE TABLE inbox_settings (location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
      CREATE TABLE inbox_rr (location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, scope TEXT NOT NULL, last_user_id TEXT, PRIMARY KEY (location_id, scope));
      CREATE TABLE inbox_timeline (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
        type TEXT NOT NULL, user_id TEXT, author_name TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
        mentions TEXT NOT NULL DEFAULT '[]', data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, edited_at TEXT
      );
      CREATE INDEX inbox_timeline_conv ON inbox_timeline(conversation_id, created_at);
      CREATE TABLE inbox_mention_seen (note_id TEXT NOT NULL REFERENCES inbox_timeline(id) ON DELETE CASCADE, user_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (note_id, user_id));
      CREATE TABLE inbox_response_log (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, inbound_at TEXT NOT NULL, responded_at TEXT NOT NULL, responder_id TEXT, assignee_id TEXT,
        due_at TEXT, breached INTEGER NOT NULL DEFAULT 0, business_min REAL, outcome TEXT NOT NULL DEFAULT 'replied'
      );
      CREATE INDEX inbox_response_loc ON inbox_response_log(location_id, responded_at);
      CREATE INDEX inbox_response_open ON inbox_response_log(business_min) WHERE business_min IS NULL;

      -- Adoption: what was read and quiet for a week counts as done; the rest is open.
      UPDATE conversations SET
        last_in_at = (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = conversations.id AND m.direction = 'in' AND m.channel != 'call'),
        last_out_at = (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = conversations.id AND m.direction = 'out' AND m.channel != 'call' AND m.status IN (${RESPONDED})),
        first_response_at = (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = conversations.id AND m.direction = 'out' AND m.channel != 'call' AND m.status IN (${RESPONDED}) AND (m.user_id IS NOT NULL OR m.source = 'manuell'));
      UPDATE conversations SET inbox_status = CASE WHEN unread > 0 OR last_message_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days') THEN 'open' ELSE 'closed' END;
      ${triggers()}
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    Object.assign(PUSH_KINDS, { inbox: { label: 'Team-Posteingang: Zuweisungen, Erwähnungen und überfällige Antworten', perm: 'conversations' } });

    // --- hooks into the normal conversation list ---------------------------------------------------------------
    app.services.conversationFilters = [
      ...(app.services.conversationFilters ?? []),
      (ctx: Ctx, where: string[], params: any[]) => {
        const at = new Date().toISOString();
        const view = ctx.query.get('view');
        if (view && isView(view)) {
          const v = viewSql(view, ctx.user?.id, at);
          if (v) {
            where.push(`(${v.sql})`);
            params.push(...v.params);
          }
        }
        const assignee = ctx.query.get('assignee');
        if (assignee === 'none') where.push('v.assignee_id IS NULL');
        else if (assignee === 'me' && ctx.user) (where.push('v.assignee_id = ?'), params.push(ctx.user.id));
        else if (assignee && /^[A-Za-z0-9_-]{1,64}$/.test(assignee)) (where.push('v.assignee_id = ?'), params.push(assignee));
        const status = ctx.query.get('status');
        if (status && (STATUSES as readonly string[]).includes(status)) (where.push('v.inbox_status = ?'), params.push(status));
        const priority = ctx.query.get('priority');
        if (priority && (PRIORITIES as readonly string[]).includes(priority)) (where.push('v.priority = ?'), params.push(priority));
      },
    ];
    app.services.conversationRows = [
      ...(app.services.conversationRows ?? []),
      (ctx: Ctx, rows: any[]) => decorate(ctx.locationId, rows),
    ];
    /** Who should hear about a new message of this conversation: its assignee (push and Android feed); undefined = the team as before. */
    app.services.inboxAudience = (locationId: string, convId: string): string[] | undefined => {
      const r = db.get<{ assignee_id: string | null }>('SELECT assignee_id FROM conversations WHERE id = ? AND location_id = ?', convId, locationId);
      return r?.assignee_id ? [r.assignee_id] : undefined;
    };

    const names = (locationId: string) => new Map(agentsOf(app, locationId).map((a) => [a.id, a.name]));
    function decorate(locationId: string, rows: any[]): any[] {
      const who = names(locationId);
      const teams = new Map(db.all<{ id: string; name: string }>('SELECT id, name FROM helpdesk_teams WHERE location_id = ?', locationId).map((t) => [t.id, t.name]));
      const at = new Date();
      return rows.map((r) => ({
        ...r,
        assignee_name: r.assignee_id ? (who.get(r.assignee_id) ?? 'Unbekannt') : '',
        team_name: r.team_id ? (teams.get(r.team_id) ?? '') : '',
        snoozed: !!r.snoozed_until && Date.parse(r.snoozed_until) > at.getTime() && r.inbox_status !== 'closed',
        // The scheduler marks a missed deadline for good; before it has looked, the clock decides.
        sla: { state: r.sla_state === 'breached' && r.awaiting_since && r.inbox_status !== 'closed' ? 'breached' : slaStateOf(r, at), kind: r.awaiting_kind || null, due_at: r.response_due_at ?? null, since: r.awaiting_since ?? null },
      }));
    }

    // --- lookups --------------------------------------------------------------------------------------------------
    router.get('/api/inbox/meta', 'location', (ctx) => {
      const s = settingsOf(app, ctx.locationId);
      const tz = app.location(ctx.locationId)?.timezone || 'Europe/Berlin';
      const people = agentsOf(app, ctx.locationId).map((a) => {
        const av = availabilityOf(app, ctx.locationId, a.id);
        return { ...a, away: isAway(app, ctx.locationId, a.id, new Date(), true), paused: av.paused, back_on: awayUntil(av), me: a.id === ctx.user?.id };
      });
      return {
        me: ctx.user?.id ?? null,
        timezone: tz,
        views: VIEWS.map((k) => [k, VIEW_LABEL[k]]),
        statuses: STATUSES.map((k) => [k, STATUS_LABEL[k]]),
        priorities: PRIORITIES.map((k) => [k, PRIORITY_LABEL[k]]),
        people,
        teams: db.all('SELECT id, name, members FROM helpdesk_teams WHERE location_id = ? ORDER BY name', ctx.locationId).map((t: any) => ({ id: t.id, name: t.name, members: JSON.parse(t.members || '[]') })),
        settings: { assignment_mode: s.assignment.mode, sla_enabled: s.sla.enabled, first_response_min: s.sla.first_response_min, next_response_min: s.sla.next_response_min, auto_close_days: s.auto_close_days, reply_sets_waiting: s.reply_sets_waiting },
      };
    });

    /** Numbers for the view list: how many conversations wait in each. */
    router.get('/api/inbox/counts', 'location', (ctx) => {
      const at = new Date().toISOString();
      const out: Record<string, number> = {};
      const scope = scopeClause(resolve(app, ctx), 'conversations', 'v');
      const sc = scope ? ` AND ${scope.sql}` : '';
      for (const view of VIEWS) {
        if (view === 'all') {
          out.all = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM conversations v WHERE v.location_id = ?${sc}`, ctx.locationId, ...(scope?.params ?? []))!.n;
          continue;
        }
        const v = viewSql(view, ctx.user?.id, at)!;
        out[view] = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM conversations v WHERE v.location_id = ? AND (${v.sql})${sc}`, ctx.locationId, ...v.params, ...(scope?.params ?? []))!.n;
      }
      return out;
    });

    /** A compact, sorted list for the app and MCP (the web list uses GET /api/conversations with the same filters). */
    router.get('/api/inbox/queue', 'location', (ctx) => queue(ctx));
    function queue(ctx: Ctx) {
      const at = new Date().toISOString();
      const viewParam = ctx.query.get('view') ?? 'open';
      if (!isView(viewParam)) throw bad(`Unbekannte Ansicht – möglich: ${VIEWS.join(', ')}`);
      const where = ['v.location_id = ?'];
      const params: any[] = [ctx.locationId];
      const v = viewSql(viewParam, ctx.user?.id, at);
      if (v) (where.push(`(${v.sql})`), params.push(...v.params));
      const assignee = ctx.query.get('assignee');
      if (assignee === 'none') where.push('v.assignee_id IS NULL');
      else if (assignee === 'me' && ctx.user) (where.push('v.assignee_id = ?'), params.push(ctx.user.id));
      else if (assignee && /^[A-Za-z0-9_-]{1,64}$/.test(assignee)) (where.push('v.assignee_id = ?'), params.push(assignee));
      const status = ctx.query.get('status');
      if (status && (STATUSES as readonly string[]).includes(status)) (where.push('v.inbox_status = ?'), params.push(status));
      const priority = ctx.query.get('priority');
      if (priority && (PRIORITIES as readonly string[]).includes(priority)) (where.push('v.priority = ?'), params.push(priority));
      const channel = ctx.query.get('channel');
      if (channel && /^[a-z]{2,20}$/.test(channel)) (where.push('EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = v.id AND m.channel = ?)'), params.push(channel));
      const q = ctx.query.get('q');
      if (q) (where.push(`(c.first_name || ' ' || c.last_name || ' ' || c.email || ' ' || c.phone || ' ' || v.last_message) LIKE ?`), params.push(`%${q.slice(0, 100)}%`));
      // Record-access rules (modules/record-access.ts): a person with a limited view queues their own / their team's conversations.
      const access = resolve(app, ctx);
      const scope = scopeClause(access, 'conversations', 'v');
      if (scope) (where.push(scope.sql), params.push(...scope.params));
      const rows = db.all(
        `SELECT v.*, c.first_name, c.last_name, c.email, c.phone,
           (SELECT m.channel FROM messages m WHERE m.conversation_id = v.id ORDER BY m.created_at DESC LIMIT 1) AS last_channel
         FROM conversations v JOIN contacts c ON c.id = v.contact_id WHERE ${where.join(' AND ')}
         ORDER BY ${viewOrder(viewParam, ctx.query.get('sort') === 'priority')} LIMIT ?`,
        ...params,
        clampLimit(ctx.query.get('limit'), 25, 200),
      );
      return {
        view: viewParam,
        conversations: decorate(ctx.locationId, rows).map((r) => ({
          id: r.id,
          contact_id: r.contact_id,
          contact_name: contactName(r),
          channel: r.last_channel,
          last_message: access?.hidden.conversations.has('preview') ? '' : r.last_message,
          last_message_at: r.last_message_at,
          unread: r.unread,
          starred: !!r.starred,
          status: r.inbox_status,
          priority: r.priority,
          assignee_id: r.assignee_id,
          assignee_name: r.assignee_name,
          team_id: r.team_id,
          team_name: r.team_name,
          snoozed_until: r.snoozed ? r.snoozed_until : null,
          sla: r.sla,
          link: `/app/conversations/${r.id}`,
        })),
      };
    }

    // --- one conversation -------------------------------------------------------------------------------------
    const convOf = (ctx: Ctx): ConvRow => getConv(app, ctx.locationId, ctx.params.id);
    const state = (ctx: Ctx, c: ConvRow) => {
      const [row] = decorate(ctx.locationId, [c]);
      const viewers = hubOf(app) ? ((app.services.inboxPresence?.(c.id) as { user_id: string; name: string; typing: boolean }[]) ?? []) : [];
      return {
        conversation_id: c.id,
        contact_id: c.contact_id,
        assignee_id: c.assignee_id,
        assignee_name: row.assignee_name,
        team_id: c.team_id,
        team_name: row.team_name,
        status: c.inbox_status,
        snoozed_until: row.snoozed ? c.snoozed_until : null,
        priority: c.priority,
        sla: row.sla,
        first_response_at: c.first_response_at,
        viewers: viewers.filter((v) => v.user_id !== ctx.user?.id),
        timeline: timeline(app, c),
      };
    };

    router.get('/api/inbox/conversations/:id', 'location', (ctx) => {
      const c = convOf(ctx);
      if (ctx.user) markMentionsSeen(app, c, ctx.user.id);
      return state(ctx, c);
    });

    const resolveUser = (ctx: Ctx, v: unknown): string | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null || v === '' || v === 'none') return null;
      if (v === 'me') {
        if (!ctx.user || ctx.viaApiKey) throw bad('„me“ geht nur mit persönlicher Anmeldung');
        return ctx.user.id;
      }
      return String(v);
    };

    router.post('/api/inbox/conversations/:id/assign', 'location', (ctx) => {
      const c = convOf(ctx);
      const b = ctx.body ?? {};
      if (b.user_id === undefined && b.team_id === undefined) throw bad('user_id oder team_id angeben');
      const next = setAssignee(app, whoOf(ctx), c, { userId: resolveUser(ctx, b.user_id), teamId: b.team_id === undefined ? undefined : b.team_id ? String(b.team_id) : null });
      return state(ctx, next);
    });

    router.post('/api/inbox/conversations/:id/status', 'location', (ctx) => {
      const c = convOf(ctx);
      const b = ctx.body ?? {};
      const next = setStatus(app, whoOf(ctx), c, { status: b.status === undefined ? undefined : b.status, snoozeUntil: b.snooze_until === undefined ? undefined : b.snooze_until || null });
      return state(ctx, next);
    });

    router.post('/api/inbox/conversations/:id/snooze', 'location', (ctx) => {
      const c = convOf(ctx);
      const until = ctx.body?.until ?? null;
      const next = setStatus(app, whoOf(ctx), c, { snoozeUntil: until || null });
      return state(ctx, next);
    });

    router.post('/api/inbox/conversations/:id/priority', 'location', (ctx) => {
      const c = convOf(ctx);
      return state(ctx, setPriority(app, whoOf(ctx), c, ctx.body?.priority));
    });

    router.get('/api/inbox/conversations/:id/notes', 'location', (ctx) => timeline(app, convOf(ctx)).filter((t) => t.type === 'note'));
    router.post('/api/inbox/conversations/:id/notes', 'location', (ctx) => {
      const c = convOf(ctx);
      const r = addNote(app, whoOf(ctx), c, ctx.body?.body);
      return { ...r.note, mentioned: r.mentioned };
    });
    router.delete('/api/inbox/conversations/:id/notes/:noteId', 'location', (ctx) => {
      const c = convOf(ctx);
      const admin = ctx.user?.role === 'admin' || ctx.user?.permissions === null || !!ctx.user?.permissions?.includes('settings');
      deleteNote(app, whoOf(ctx), c, ctx.params.noteId, admin);
      return { ok: true };
    });

    // --- bulk ------------------------------------------------------------------------------------------------
    router.post('/api/inbox/bulk', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const ids: string[] = Array.isArray(b.ids) ? [...new Set<string>(b.ids.map(String))] : [];
      if (!ids.length) throw bad('Keine Konversationen gewählt');
      if (ids.length > 200) throw bad('Höchstens 200 Konversationen auf einmal');
      const action = String(b.action ?? '');
      if (!['assign', 'status', 'priority', 'snooze', 'close'].includes(action)) throw bad('Unbekannte Aktion (assign, status, priority, snooze, close)');
      const who = whoOf(ctx);
      let updated = 0;
      const skipped: { id: string; error: string }[] = [];
      for (const cid of ids) {
        try {
          const c = getConv(app, ctx.locationId, cid);
          if (action === 'assign') setAssignee(app, who, c, { userId: resolveUser(ctx, b.user_id) ?? null, teamId: b.team_id === undefined ? undefined : b.team_id ? String(b.team_id) : null });
          else if (action === 'status') setStatus(app, who, c, { status: b.status });
          else if (action === 'close') setStatus(app, who, c, { status: 'closed' });
          else if (action === 'priority') setPriority(app, who, c, b.priority);
          else setStatus(app, who, c, { snoozeUntil: b.until ?? null });
          updated++;
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          skipped.push({ id: cid, error: e.message });
        }
      }
      return { updated, skipped };
    });

    // --- settings ---------------------------------------------------------------------------------------------
    router.get('/api/inbox/settings', 'location', (ctx) => {
      const s = settingsOf(app, ctx.locationId);
      return { ...s, pool_preview: poolOf(app, ctx.locationId, s).ids, teams: db.all('SELECT id, name FROM helpdesk_teams WHERE location_id = ? ORDER BY name', ctx.locationId), people: agentsOf(app, ctx.locationId) };
    });
    router.put('/api/inbox/settings', 'location', (ctx) => {
      const next = cleanSettings(ctx.body, settingsOf(app, ctx.locationId));
      // Rules and the pool may only name people and teams of this sub-account.
      const people = new Set(agentsOf(app, ctx.locationId).map((a) => a.id));
      const teams = new Set(db.all<{ id: string }>('SELECT id FROM helpdesk_teams WHERE location_id = ?', ctx.locationId).map((t) => t.id));
      if (next.assignment.team_id && !teams.has(next.assignment.team_id)) throw bad('Unbekanntes Team');
      for (const u of next.assignment.user_ids) if (!people.has(u)) throw bad('Eine gewählte Person hat keinen Zugriff auf die Konversationen');
      for (const r of next.assignment.rules) {
        if (r.target.type === 'user' && !people.has(r.target.id)) throw bad(`Regel „${r.name}“: Person hat keinen Zugriff`);
        if (r.target.type === 'team' && !teams.has(r.target.id)) throw bad(`Regel „${r.name}“: unbekanntes Team`);
      }
      saveSettings(app, ctx.locationId, next);
      return settingsOf(app, ctx.locationId);
    });

  },
};
