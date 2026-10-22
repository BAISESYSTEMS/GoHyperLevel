import type { Module } from '../core/app.js';
import { HttpError, bad, type Ctx, type RawResult } from '../core/http.js';
import { ChatHub } from '../services/teamchat-hub.js';
import { businessMinutesBetween, shiftAfterPause } from '../services/helpdesk-sla.js';
import { track, userById } from '../services/collab-actor.js';
import { loginOf, sweepOnLoginChange } from '../services/stream-login.js';
import { notifyTeam } from '../services/messaging.js';
import { isAway } from '../services/team-people.js';
import { autoAssign } from '../services/teaminbox-assign.js';
import { responseDeadline, slaStateOf, type InboxSettings } from '../services/teaminbox-model.js';
import {
  SYSTEM,
  addTimeline,
  agentsOf,
  announceConversation,
  brief,
  calendarFor,
  getConv,
  pushToUsers,
  setAssignee,
  setStatus,
  settingsOf,
  type ConvRow,
  type Who,
} from '../services/teaminbox-store.js';

/**
 * The running parts of the Team-Posteingang:
 * - a new message reopens a finished or snoozed conversation and hands it to somebody (contact owner, rule, round robin);
 * - the answer timers (first and next response, in business hours): warning, breach, "conversation.sla_breached";
 * - snoozed conversations come back, silent ones close themselves (setting), a reply makes the answerer the owner;
 * - realtime over Server-Sent Events: who looks at a conversation, who is typing, "something changed".
 */

const TICK_LIMIT = 200;
const VIEWING_MS = 45_000;
const TYPING_MS = 6_000;

const customer: Who = { userId: null, name: 'Neue Nachricht', via: 'customer' };
const auto: Who = { ...SYSTEM, name: 'Automatik' };

export const teamInboxEngineModule: Module = {
  name: 'teaminbox-engine',
  register(app) {
    const { db, router } = app;
    const hub = new ChatHub();
    app.services.inboxHub = hub;

    // --- answer timers ------------------------------------------------------------------------------------
    /** Deadline of the running timer of a conversation (from the message that started it). */
    function computeSla(conv: ConvRow, s: InboxSettings): ConvRow {
      if (!conv.awaiting_since || conv.inbox_status === 'closed') {
        db.run(`UPDATE conversations SET sla_dirty = 0 WHERE id = ?`, conv.id);
        return conv;
      }
      const d = responseDeadline(s, conv.awaiting_kind === 'next' ? 'next' : 'first', new Date(conv.awaiting_since), calendarFor(app, conv.location_id, s));
      db.run(`UPDATE conversations SET response_due_at = ?, response_warn_at = ?, sla_state = '', sla_dirty = 0 WHERE id = ?`, d?.due ?? null, d?.warn ?? null, conv.id);
      return getConv(app, conv.location_id, conv.id);
    }

    /** A snooze ends (time ran out, or a message came in): the deadline of an unanswered message starts again from now. */
    function wake(conv: ConvRow, who: Who, reason: string, s = settingsOf(app, conv.location_id)): ConvRow {
      const cal = calendarFor(app, conv.location_id, s);
      if (conv.snoozed_until && conv.snoozed_at && conv.awaiting_since && conv.response_due_at) {
        const paused = new Date(conv.snoozed_at);
        const t = new Date();
        const due = shiftAfterPause(conv.response_due_at, paused, t, s.sla.business_hours ? cal : { ...cal, always: true });
        const warn = conv.response_warn_at ? shiftAfterPause(conv.response_warn_at, paused, t, s.sla.business_hours ? cal : { ...cal, always: true }) : null;
        db.run(`UPDATE conversations SET response_due_at = ?, response_warn_at = ?, sla_state = '' WHERE id = ?`, due, warn, conv.id);
        conv = getConv(app, conv.location_id, conv.id);
      }
      return setStatus(app, who, conv, { status: conv.inbox_status === 'closed' || conv.inbox_status === 'waiting' ? 'open' : conv.inbox_status, snoozeUntil: null, reason });
    }

    async function onInbound(locationId: string, messageId: string | undefined, convId: string | undefined) {
      if (!convId) return;
      const row = db.get<ConvRow>('SELECT * FROM conversations WHERE id = ? AND location_id = ?', convId, locationId);
      if (!row) return;
      const msg = messageId ? db.get<{ channel: string }>('SELECT channel FROM messages WHERE id = ?', messageId) : undefined;
      if (msg?.channel === 'call') return;
      const s = settingsOf(app, locationId);
      let conv = row;
      if (conv.inbox_status !== 'open' || conv.snoozed_until) conv = wake(conv, customer, 'Neue Nachricht', s);
      if (s.assignment.mode !== 'manual') {
        const away = !!conv.assignee_id && s.assignment.reassign_when_away && isAway(app, locationId, conv.assignee_id);
        if (!conv.assignee_id || away) {
          const before = conv.assignee_id;
          conv = autoAssign(app, conv.id, locationId, s);
          if (away && conv.assignee_id !== before) addTimeline(app, conv, 'auto', { name: 'Automatik', body: 'Neu zugewiesen, weil die bisherige Person abwesend ist' });
        }
      }
      if (conv.sla_dirty) conv = computeSla(conv, s);
      announceConversation(app, conv, 'inbound');
    }
    app.events.on('message.inbound', (e) => onInbound(e.locationId, e.data.message?.id, e.data.message?.conversation_id));

    function breached(conv: ConvRow, s: InboxSettings) {
      const fresh = getConv(app, conv.location_id, conv.id);
      if (fresh.sla_state === 'breached' || !fresh.awaiting_since) return;
      db.run(`UPDATE conversations SET sla_state = 'breached' WHERE id = ? AND sla_state != 'breached'`, fresh.id);
      const kind = fresh.awaiting_kind === 'next' ? 'next' : 'first';
      addTimeline(app, fresh, 'sla', { name: 'SLA', body: `${kind === 'first' ? 'Erste' : 'Weitere'} Antwort überfällig (fällig ${new Date(fresh.response_due_at ?? Date.now()).toLocaleString('de-DE', { timeZone: app.location(fresh.location_id)?.timezone || 'Europe/Berlin' })})`, data: { kind, due: fresh.response_due_at } });
      app.services.audit?.({ action: 'inbox.sla_breached', actor: 'System', locationId: fresh.location_id, entityId: fresh.id, summary: `${kind === 'first' ? 'Erste' : 'Weitere'} Antwort überfällig` });
      const next = getConv(app, fresh.location_id, fresh.id);
      app.events.emit(next.location_id, 'conversation.sla_breached', { contactId: next.contact_id, conversationId: next.id, slaKind: kind, dueAt: next.response_due_at, assigneeId: next.assignee_id, conversation: brief(app, next) });
      announceConversation(app, next, 'sla');
      if (s.sla.notify_assignee) {
        const label = brief(app, next).contact_name;
        pushToUsers(app, next.assignee_id ? [next.assignee_id] : [], `Antwort überfällig: ${label}`, next.last_message, next, `inbox-sla-${next.id}`, 'high', !next.assignee_id);
      }
      if (s.sla.notify_email) {
        const a = next.assignee_id ? agentsOf(app, next.location_id).find((x) => x.id === next.assignee_id) : undefined;
        track(app, notifyTeam(app, next.location_id, `Antwort überfällig: ${brief(app, next).contact_name}`, `Die Antwort an ${brief(app, next).contact_name} ist überfällig.\n\n${app.baseUrl()}/app/conversations/${next.id}`, a?.email).catch(() => undefined));
      }
    }

    function warned(conv: ConvRow, s: InboxSettings) {
      if (!db.run(`UPDATE conversations SET sla_state = 'warning' WHERE id = ? AND sla_state = ''`, conv.id).changes) return;
      const next = getConv(app, conv.location_id, conv.id);
      announceConversation(app, next, 'sla');
      if (s.sla.notify_assignee && next.assignee_id) pushToUsers(app, [next.assignee_id], `Antwort läuft bald ab: ${brief(app, next).contact_name}`, next.last_message, next, `inbox-sla-warn-${next.id}`);
    }

    // --- scheduler -----------------------------------------------------------------------------------------
    let lastAutoClose = 0;
    let lastPrune = 0;

    /** One pass over everything that waits for a time; exported for tests (app.services.inboxTick). */
    async function tick(at = new Date(), force = false) {
      const iso = at.toISOString();
      const settings = new Map<string, InboxSettings>();
      const sOf = (loc: string) => settings.get(loc) ?? (settings.set(loc, settingsOf(app, loc)), settings.get(loc)!);

      // 1. Deadlines for messages that arrived (the SQL trigger marked them).
      for (const c of db.all<ConvRow>('SELECT * FROM conversations WHERE sla_dirty = 1 LIMIT ?', TICK_LIMIT)) computeSla(c, sOf(c.location_id));

      // 2. Snoozes that ran out.
      for (const c of db.all<ConvRow>(`SELECT * FROM conversations WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? AND inbox_status != 'closed' LIMIT ?`, iso, TICK_LIMIT)) {
        const woke = wake(c, auto, 'Zurückstellen abgelaufen', sOf(c.location_id));
        if (woke.assignee_id) pushToUsers(app, [woke.assignee_id], `Wieder da: ${brief(app, woke).contact_name}`, woke.last_message, woke, `inbox-wake-${woke.id}`);
      }

      // 3. Answer timers: warning, then breach.
      const due = db.all<ConvRow>(
        `SELECT * FROM conversations WHERE awaiting_since IS NOT NULL AND inbox_status != 'closed' AND response_due_at IS NOT NULL AND (snoozed_until IS NULL OR snoozed_until <= ?)
           AND ((sla_state = '' AND response_warn_at <= ?) OR (sla_state != 'breached' AND response_due_at <= ?)) LIMIT ?`,
        iso, iso, iso, TICK_LIMIT,
      );
      for (const c of due) {
        const s = sOf(c.location_id);
        const state = slaStateOf(c, at);
        if (state === 'breached') breached(c, s);
        else if (state === 'warning') warned(c, s);
      }

      // 4. Answers that were sent: the answerer takes an unassigned conversation, "waiting for the contact" when switched on.
      for (const c of db.all<ConvRow>('SELECT * FROM conversations WHERE out_pending = 1 LIMIT ?', TICK_LIMIT)) {
        db.run('UPDATE conversations SET out_pending = 0 WHERE id = ?', c.id);
        const s = sOf(c.location_id);
        let cur = c;
        if (!cur.assignee_id && s.assignment.assign_on_reply && cur.last_out_user && agentsOf(app, cur.location_id).some((a) => a.id === cur.last_out_user)) {
          cur = setAssignee(app, { ...auto, name: 'Antwort', via: 'rule' }, cur, { userId: cur.last_out_user, reason: 'hat geantwortet', quiet: true });
        }
        if (s.reply_sets_waiting && cur.inbox_status === 'open') cur = setStatus(app, auto, cur, { status: 'waiting', reason: 'Antwort gesendet' });
        announceConversation(app, cur, 'outbound');
      }

      // 5. Silent conversations close themselves (setting per sub-account).
      // The slow jobs run every ten minutes of real time (tests pass `force`).
      if (force || Date.now() - lastAutoClose > 10 * 60_000) {
        lastAutoClose = Date.now();
        for (const r of db.all<{ location_id: string; data: string }>('SELECT location_id, data FROM inbox_settings')) {
          const s = sOf(r.location_id);
          if (!s.auto_close_days) continue;
          const cutoff = new Date(at.getTime() - s.auto_close_days * 864e5).toISOString();
          const rows = db.all<ConvRow>(
            `SELECT * FROM conversations WHERE location_id = ? AND inbox_status IN ('open', 'waiting') AND last_out_at IS NOT NULL AND last_out_at < ? AND (last_in_at IS NULL OR last_in_at <= last_out_at)
               AND awaiting_since IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?) LIMIT 100`,
            r.location_id, cutoff, iso,
          );
          for (const c of rows) setStatus(app, auto, c, { status: 'closed', reason: `Keine Antwort seit ${s.auto_close_days} Tagen` });
        }
      }

      // 6. Response times in business hours for the numbers.
      for (const l of db.all<{ id: string; location_id: string; inbound_at: string; responded_at: string }>('SELECT id, location_id, inbound_at, responded_at FROM inbox_response_log WHERE business_min IS NULL LIMIT ?', TICK_LIMIT * 2)) {
        const s = sOf(l.location_id);
        const cal = calendarFor(app, l.location_id, s);
        const minutes = businessMinutesBetween(new Date(l.inbound_at), new Date(l.responded_at), s.sla.business_hours ? cal : { ...cal, always: true });
        db.run('UPDATE inbox_response_log SET business_min = ? WHERE id = ?', minutes, l.id);
      }

      if (force || Date.now() - lastPrune > 6 * 3600_000) {
        lastPrune = Date.now();
        db.run('DELETE FROM inbox_response_log WHERE responded_at < ?', new Date(at.getTime() - 800 * 864e5).toISOString());
      }
      sweepPresence(at.getTime());
    }
    app.services.inboxTick = tick;
    app.onTick(() => tick());

    // --- realtime: who is looking, who is typing ------------------------------------------------------------
    const viewing = new Map<string, Map<string, { at: number; typing: number; name: string; location: string }>>();

    const viewersOf = (convId: string, at = Date.now()) =>
      [...(viewing.get(convId) ?? new Map()).entries()]
        .filter(([, v]) => at - v.at < VIEWING_MS)
        .map(([user_id, v]) => ({ user_id, name: v.name, typing: at - v.typing < TYPING_MS }));
    app.services.inboxPresence = (convId: string) => viewersOf(convId);

    function broadcast(convId: string, locationId: string) {
      hub.publish('presence', { conversation_id: convId, viewers: viewersOf(convId) }, (s) => s.locationId === locationId);
    }
    function sweepPresence(at: number) {
      for (const [convId, map] of viewing) {
        let changed = false;
        let loc = '';
        for (const [uid, v] of map) {
          loc = v.location;
          if (at - v.at >= VIEWING_MS) {
            map.delete(uid);
            changed = true;
          }
        }
        if (!map.size) viewing.delete(convId);
        if (changed && loc) broadcast(convId, loc);
      }
    }

    hub.revalidate = (s) => {
      const u = userById(app, s.userId);
      if (!u) return false;
      if (u.role !== 'admin' && !u.locations.includes(s.locationId)) return false;
      if (!db.get('SELECT 1 AS x FROM locations WHERE id = ?', s.locationId)) return false;
      return u.role === 'admin' || !u.permissions || u.permissions.includes('conversations');
    };
    // the stream ends with the login it was opened with: at once when signing out or revoking, an expired session at the next check
    sweepOnLoginChange(app, hub);

    router.get('/api/inbox/stream', 'location', (ctx: Ctx): RawResult => {
      const u = ctx.user;
      if (!u || ctx.viaApiKey) throw new HttpError(403, 'Der Live-Stream geht nur mit persönlicher Anmeldung');
      const clientId = String(ctx.query.get('clientId') ?? '');
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(clientId)) throw bad('clientId fehlt');
      const mine = new Set(agentsOf(app, ctx.locationId).map((a) => a.id));
      const stream = hub.subscribe({ clientId, userId: u.id, locationId: ctx.locationId, admin: u.role === 'admin', alive: loginOf(app, ctx), onlineIds: (ids) => ids.filter((x) => mine.has(x)) });
      // not a 200 stream that ends at once: the browser's EventSource gives up instead of retrying every few seconds
      if (!stream) throw new HttpError(503, 'Zu viele Live-Verbindungen – bitte später noch einmal');
      return { __raw: true, status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' }, body: stream };
    });

    /** "I look at this conversation" (every ~15 s) and "I am typing" (throttled): the others see "Anna schreibt gerade…". */
    router.post('/api/inbox/conversations/:id/presence', 'location', (ctx) => {
      ctx.skipAfterWrite = true;
      const u = ctx.user;
      if (!u || ctx.viaApiKey) throw new HttpError(403, 'Das geht nur mit persönlicher Anmeldung');
      const conv = getConv(app, ctx.locationId, ctx.params.id);
      const map = viewing.get(conv.id) ?? new Map();
      viewing.set(conv.id, map);
      const before = map.has(u.id) && Date.now() - map.get(u.id).at < VIEWING_MS;
      const cur = map.get(u.id) ?? { at: 0, typing: 0, name: u.name, location: ctx.locationId };
      if (ctx.body?.leaving === true) {
        map.delete(u.id);
        broadcast(conv.id, ctx.locationId);
        return { ok: true };
      }
      cur.at = Date.now();
      cur.name = u.name;
      let typingNow = false;
      if (ctx.body?.typing === true && hub.typing(`conv:${conv.id}`, u.id)) {
        cur.typing = Date.now();
        typingNow = true;
      }
      map.set(u.id, cur);
      if (!before || typingNow) broadcast(conv.id, ctx.locationId);
      return { ok: true, viewers: viewersOf(conv.id).filter((v) => v.user_id !== u.id) };
    });

  },
};
