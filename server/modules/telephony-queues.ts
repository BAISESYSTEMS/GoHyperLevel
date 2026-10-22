import type { LocationRow, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { bad, notFound } from '../core/http.js';
import { id, now } from '../core/util.js';
import { parseIdentity } from '../services/browser-phone.js';
import {
  HOLD_SECONDS,
  STRATEGY_LABEL,
  OVERFLOW_LABEL,
  afterAnswer,
  afterNoAnswer,
  cleanGroup,
  defaultGroup,
  holdTwiml,
  memberKey,
  nextAttempt,
  positionText,
  queueStats,
  type GroupDef,
  type GroupRefs,
  type Member,
} from '../services/call-groups.js';
import { isAway, peopleOf } from '../services/team-people.js';
import { dialTwiml, hangup, isOpen, say, twiml } from '../services/twilio.js';
import { recordNotice, twilioRequest, type CallRouteInput, type Config } from './telephony.js';
import { audioOf, audioUrl, defaultHoldUrl } from './telephony-audio.js';

/**
 * Ring groups and queues: a team that rings together. A group tries its members once (all at the same time, one after the
 * other, or "reihum" so the person who took the last call comes last); a queue also keeps the caller on hold – with the
 * built-in melody or an own file, the position announced – and tries again every few seconds until `max_wait`. When nobody
 * answers, the overflow decides: voicemail with its own greeting, another number or group, the KI-Telefonagent or hanging up.
 * People ring through their browser phone (only while it is open, they are not away and not on another call), numbers
 * ring like any phone. The state of every waiting caller lives in `queue_calls`; the report counts offered, answered,
 * abandoned and overflowed calls, the waiting time and the service level.
 */

type CallRow = Record<string, any>;
interface GroupRow {
  id: string;
  location_id: string;
  name: string;
  kind: 'group' | 'queue';
  data: GroupDef;
  created_at: string;
  updated_at: string;
}
interface QueueCall {
  id: string;
  location_id: string;
  group_id: string;
  call_id: string;
  status: 'waiting' | 'ringing' | 'done';
  outcome: string;
  tried: string[];
  attempts: number;
  attempt_member: string;
  chain: number;
  enqueued_at: string;
  answered_at: string | null;
  answered_by: string;
  ended_at: string | null;
  wait_seconds: number;
}
const MAX_CHAIN = 3;
const secondsSince = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));

export const telephonyQueuesModule: Module = {
  name: 'telephony-queues',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE call_groups (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'queue', data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX call_groups_loc ON call_groups(location_id);
      CREATE TABLE queue_calls (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES call_groups(id) ON DELETE CASCADE, call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'waiting', outcome TEXT NOT NULL DEFAULT '', tried TEXT NOT NULL DEFAULT '[]',
        attempts INTEGER NOT NULL DEFAULT 0, attempt_member TEXT NOT NULL DEFAULT '', chain INTEGER NOT NULL DEFAULT 0,
        enqueued_at TEXT NOT NULL, answered_at TEXT, answered_by TEXT NOT NULL DEFAULT '', ended_at TEXT, wait_seconds INTEGER NOT NULL DEFAULT 0,
        UNIQUE(call_id, group_id)
      );
      CREATE INDEX queue_calls_wait ON queue_calls(group_id, status, enqueued_at);
      CREATE INDEX queue_calls_report ON queue_calls(location_id, enqueued_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const hook = (name: string, loc: string) => `${app.baseUrl()}/hooks/twilio/${name}/${loc}`;
    const kit = () => app.services.telephonyKit;

    // --- storage -------------------------------------------------------------------------------------------------------
    const groupRow = (locationId: string, key: string): GroupRow | undefined => parseJson(db.get<any>('SELECT * FROM call_groups WHERE id = ? AND location_id = ?', key, locationId), ['data']);
    const qrow = (key: string): QueueCall | undefined => parseJson(db.get<any>('SELECT * FROM queue_calls WHERE id = ?', key), ['tried']);
    const callRow = (callId: string) => db.get<CallRow>('SELECT * FROM calls WHERE id = ?', callId);
    const refs = (locationId: string, selfId = ''): GroupRefs => ({
      users: new Map(peopleOf(app, locationId, '').map((u) => [u.id, u.name])),
      groups: new Set(db.all<{ id: string }>('SELECT id FROM call_groups WHERE location_id = ? AND id <> ?', locationId, selfId).map((r) => r.id)),
      audio: new Set(db.all<{ id: string }>(`SELECT id FROM call_audio WHERE location_id = ? AND kind = 'hold'`, locationId).map((r) => r.id)),
    });

    app.services.audioUsage ??= [];
    app.services.audioUsage.push((locationId: string, audioId: string): string | undefined => {
      for (const r of db.all<{ name: string; data: string }>('SELECT name, data FROM call_groups WHERE location_id = ?', locationId)) if (r.data.includes(`"${audioId}"`)) return `Ruf-Gruppe „${r.name}“`;
      return undefined;
    });

    // --- who can take a call right now ---------------------------------------------------------------------------------
    const busyUser = (locationId: string, userId: string) => !!db.get('SELECT 1 FROM calls WHERE location_id = ? AND user_id = ? AND answered = 1 AND ended_at IS NULL', locationId, userId);
    const availability = (locationId: string, call: CallRow) => (m: Member): boolean => {
      if (m.type === 'number') return true;
      if (isAway(app, locationId, m.id, new Date(), true) || busyUser(locationId, m.id)) return false;
      return !!app.services.voiceUserClient?.(locationId, m.id, call);
    };
    const targetsOf = (locationId: string, call: CallRow, members: Member[]) => ({
      numbers: members.filter((m) => m.type === 'number').map((m) => m.id),
      clients: members.filter((m) => m.type === 'user').map((m) => app.services.voiceUserClient?.(locationId, m.id, call)).filter(Boolean) as { identity: string; params?: Record<string, string> }[],
    });

    // --- the caller's journey ------------------------------------------------------------------------------------------
    const setQ = (q: QueueCall, patch: Record<string, unknown>) => void db.update('queue_calls', q.id, patch);
    const position = (q: QueueCall) =>
      1 + (db.get<{ n: number }>(`SELECT COUNT(*) n FROM queue_calls WHERE group_id = ? AND status <> 'done' AND (enqueued_at < ? OR (enqueued_at = ? AND rowid < (SELECT rowid FROM queue_calls WHERE id = ?)))`, q.group_id, q.enqueued_at, q.enqueued_at, q.id)?.n ?? 0);
    const isHead = (q: QueueCall) => position(q) === 1;

    const hold = (loc: LocationRow, g: GroupRow, q: QueueCall): string => {
      const music = audioOf(app, loc.id, g.data.hold_audio_id);
      return holdTwiml({
        position: g.data.announce_position ? positionText(position(q)) : '',
        musicUrl: music ? audioUrl(app, music) : defaultHoldUrl(app),
        redirect: `${hook('group-wait', loc.id)}?q=${q.id}`,
      });
    };

    /** The call leaves the queue (answered, overflow, voicemail, abandoned): its waiting time is kept. */
    const finish = (q: QueueCall, outcome: string, by = '') => {
      const waited = secondsSince(q.enqueued_at);
      db.run(`UPDATE queue_calls SET status = 'done', outcome = ?, ended_at = ?, wait_seconds = ?, answered_by = ?, answered_at = CASE WHEN ? = 'answered' THEN ? ELSE answered_at END WHERE id = ? AND status <> 'done'`, outcome, now(), waited, by, outcome, now(), q.id);
      db.run('UPDATE calls SET wait_seconds = ? WHERE id = ? AND wait_seconds = 0', waited, q.call_id);
    };

    const overflow = (loc: LocationRow, cfg: Config, g: GroupRow, q: QueueCall, call: CallRow): string => {
      const o = g.data.overflow;
      const unanswered = () => kit().unanswered(loc, cfg, callRow(call.id));
      switch (o.kind) {
        case 'voicemail': {
          finish(q, 'voicemail');
          return kit().voicemail(loc, cfg, callRow(call.id), { greeting: o.say || 'Leider ist gerade niemand erreichbar. Bitte hinterlassen Sie nach dem Signalton eine Nachricht – wir rufen zurück.', box: o.box || g.name, record: true });
        }
        case 'number': {
          finish(q, 'overflow');
          return dialTwiml({ numbers: [o.number], timeout: cfg.s.ring_timeout, action: hook('voice-dial', loc.id), record: cfg.s.record_inbound, recordingCallback: `${hook('voice-recording', loc.id)}?kind=dial`, announce: [o.say, cfg.s.record_inbound && cfg.s.record_announce ? recordNotice(cfg.s) : ''].filter(Boolean).join(' ') });
        }
        case 'group': {
          finish(q, 'overflow');
          const next = enter({ loc, cfg, call: callRow(call.id)!, groupId: o.group_id, chain: q.chain + 1 });
          return next ?? unanswered();
        }
        case 'ai': {
          finish(q, 'overflow');
          const out: string | undefined = app.services.voiceAgent?.({ stage: 'unanswered', loc, call: callRow(call.id), open: isOpen(cfg.s.hours_mode, cfg.s.hours, loc.timezone), force: true });
          return out ?? unanswered();
        }
        case 'hangup':
          finish(q, 'overflow');
          return hangup(o.say || 'Leider ist gerade niemand erreichbar. Bitte rufen Sie später noch einmal an.');
        default:
          finish(q, 'overflow');
          return unanswered();
      }
    };

    /** One attempt: ring the next members, hold the caller, or give up to the overflow. */
    const attempt = (loc: LocationRow, cfg: Config, g: GroupRow, q: QueueCall, call: CallRow, opening = ''): string => {
      const waited = secondsSince(q.enqueued_at);
      const avail = availability(loc.id, call);
      // Whoever has waited the maximum goes to the overflow, first in line or not.
      if (g.kind === 'queue' && waited >= g.data.max_wait) return overflow(loc, cfg, g, q, call);
      // Earlier callers are served first: this one holds until it is the head of the line.
      if (g.kind === 'queue' && !isHead(q)) return twiml(`${opening}${innerHold(hold(loc, g, q))}`);
      const a = nextAttempt(g.data, q.tried, avail);
      if (!a.members.length) {
        const next = afterNoAnswer(g.data, q.tried, avail, waited);
        if (next === 'overflow') return overflow(loc, cfg, g, q, call);
        setQ(q, { status: 'waiting', tried: [] });
        return twiml(`${opening}${innerHold(hold(loc, g, q))}`);
      }
      const t = targetsOf(loc.id, call, a.members);
      if (!t.numbers.length && !t.clients.length) return overflow(loc, cfg, g, q, call);
      setQ(q, { status: 'ringing', tried: [...q.tried, ...a.members.map(memberKey)], attempts: q.attempts + 1, attempt_member: a.members.length === 1 ? memberKey(a.members[0]) : '' });
      const announce = cfg.s.record_inbound && cfg.s.record_announce;
      if (announce) db.run('UPDATE calls SET consent_announced = 1 WHERE id = ?', call.id);
      return dialTwiml({
        ...t,
        timeout: g.data.ring_timeout,
        action: `${hook('group-dial', loc.id)}?q=${q.id}`,
        record: cfg.s.record_inbound,
        recordingCallback: `${hook('voice-recording', loc.id)}?kind=dial`,
        announce: announce ? recordNotice(cfg.s) : undefined,
      }).replace('<Response>', `<Response>${opening}`);
    };
    const innerHold = (xml: string) => xml.replace(/^<\?xml[^>]*\?>\s*<Response>/, '').replace(/<\/Response>\s*$/, '');

    /** A call comes into a group (from a number or a menu step). Returns the TwiML, or undefined when the group does not exist. */
    function enter(i: { loc: LocationRow; cfg: Config; call: CallRow; groupId: string; chain?: number }): string | undefined {
      const g = groupRow(i.loc.id, i.groupId);
      if (!g || (i.chain ?? 0) > MAX_CHAIN) return undefined;
      db.run('UPDATE calls SET route_kind = ?, route_id = ?, updated_at = ? WHERE id = ? AND route_kind IN (\'\', \'group\', \'ivr\')', 'group', g.id, now(), i.call.id);
      db.run(`UPDATE calls SET route_path = substr(CASE WHEN route_path = '' THEN ? ELSE route_path || ' › ' || ? END, 1, 400) WHERE id = ?`, g.name, g.name, i.call.id);
      let q = db.get<any>('SELECT * FROM queue_calls WHERE call_id = ? AND group_id = ?', i.call.id, g.id);
      if (q) {
        // Back in a group the call already left (a loop of overflows): a fresh pass.
        db.run(`UPDATE queue_calls SET status = 'waiting', outcome = '', tried = '[]', ended_at = NULL, enqueued_at = ? WHERE id = ?`, now(), q.id);
      } else {
        db.insert('queue_calls', { id: id(), location_id: i.loc.id, group_id: g.id, call_id: i.call.id, chain: i.chain ?? 0, enqueued_at: now() });
        q = db.get('SELECT * FROM queue_calls WHERE call_id = ? AND group_id = ?', i.call.id, g.id);
      }
      const row = qrow(q.id)!;
      return attempt(i.loc, i.cfg, g, row, i.call, say(g.data.welcome));
    }
    app.services.callGroups = { enter };

    const kinds = (app.services.callRouteKinds ??= {} as Record<string, unknown>) as Record<string, (i: CallRouteInput & { number: { route_id: string } }) => string | undefined>;
    kinds.group = (i) => enter({ loc: i.loc, cfg: i.cfg, call: i.call, groupId: i.number.route_id });

    // --- webhooks ------------------------------------------------------------------------------------------------------
    const route = (name: string, fn: (loc: LocationRow, p: Record<string, string>, cfg: Config, q: URLSearchParams) => string) => kit().hookRoute(name, fn);
    const ctxOf = (loc: LocationRow, p: Record<string, string>, query: URLSearchParams) => {
      const call: CallRow | undefined = kit().callBySid(loc.id, p.CallSid);
      const q = call ? qrow(query.get('q') ?? '') : undefined;
      if (!call || !q || q.call_id !== call.id || q.location_id !== loc.id) return null;
      const g = groupRow(loc.id, q.group_id);
      return g ? { call, q, g } : null;
    };

    /** Who picked up: the browser's person (calls.user_id), the one member of a single attempt, or – asked at Twilio – the dialled leg. */
    const learnAnswerer = async (loc: LocationRow, cfg: Config, g: GroupRow, q: QueueCall, dialSid: string) => {
      try {
        const j = await twilioRequest(app, cfg, 'GET', `/Calls/${encodeURIComponent(dialSid)}.json`);
        const to = String(j.to ?? '');
        const who = parseIdentity(to);
        const key = who ? `user:${who.userId}` : g.data.members.find((m) => m.type === 'number' && m.id === to) ? `number:${to}` : '';
        if (key) {
          db.run('UPDATE queue_calls SET answered_by = ? WHERE id = ?', key, q.id);
          const m = g.data.members.find((x) => memberKey(x) === key);
          if (m) db.run('UPDATE call_groups SET data = ? WHERE id = ?', JSON.stringify({ ...g.data, rr_next: afterAnswer(g.data, m) }), g.id);
        }
      } catch {
        /* the report just lacks the name */
      }
    };

    /** After a ring: answered → done (and the next call starts after this person); nobody → ring on, hold or overflow. */
    route('group-dial', (loc, p, cfg, query) => {
      const c = ctxOf(loc, p, query);
      if (!c) return hangup();
      const { call, q, g } = c;
      if (app.services.voiceDialHeld?.(call)) return twiml('');
      if (kit().settleDial(call, p)) {
        const single = q.attempt_member ? g.data.members.find((m) => memberKey(m) === q.attempt_member) : undefined;
        const by = q.attempt_member || (callRow(call.id)?.user_id ? `user:${callRow(call.id)!.user_id}` : '');
        finish(q, 'answered', by);
        if (single) db.run('UPDATE call_groups SET data = ? WHERE id = ?', JSON.stringify({ ...g.data, rr_next: afterAnswer(g.data, single) }), g.id);
        else if (!by && p.DialCallSid) void learnAnswerer(loc, cfg, g, q, p.DialCallSid);
        return hangup();
      }
      const waited = secondsSince(q.enqueued_at);
      const avail = availability(loc.id, call);
      setQ(q, { status: 'waiting' });
      const fresh = qrow(q.id)!;
      const next = afterNoAnswer(g.data, fresh.tried, avail, waited);
      if (next === 'overflow') return overflow(loc, cfg, g, fresh, callRow(call.id)!);
      if (next === 'hold') {
        setQ(fresh, { tried: [] });
        return twiml(innerHold(hold(loc, g, qrow(q.id)!)));
      }
      return attempt(loc, cfg, g, fresh, callRow(call.id)!);
    });

    /** The hold segment is over: a new round of attempts (or the overflow when the caller has waited long enough). */
    route('group-wait', (loc, p, cfg, query) => {
      const c = ctxOf(loc, p, query);
      if (!c || c.q.status === 'done') return hangup();
      return attempt(loc, cfg, c.g, { ...c.q, tried: [] }, callRow(c.call.id)!);
    });

    // A caller who hangs up while waiting or ringing is an abandoned call.
    for (const type of ['call.missed', 'call.voicemail', 'call.completed']) {
      app.events.on(type, (e) => {
        const callId = e.data.callId;
        if (!callId) return;
        for (const q of db.all<QueueCall>(`SELECT * FROM queue_calls WHERE call_id = ? AND status <> 'done'`, callId)) finish(q, type === 'call.completed' ? 'answered' : 'abandoned');
      });
    }
    // Rows whose call never reported back are closed after a while.
    let lastSweep = 0;
    app.onTick(() => {
      if (Date.now() - lastSweep < 60_000) return;
      lastSweep = Date.now();
      for (const q of db.all<QueueCall>(`SELECT * FROM queue_calls WHERE status <> 'done' AND enqueued_at < ? LIMIT 100`, new Date(Date.now() - 2 * 3600_000).toISOString())) finish(q, 'abandoned');
    });

    // --- API -----------------------------------------------------------------------------------------------------------
    const waiting = (g: GroupRow) => db.get<{ n: number; oldest: string | null }>(`SELECT COUNT(*) n, MIN(enqueued_at) oldest FROM queue_calls WHERE group_id = ? AND status <> 'done'`, g.id)!;
    const out = (g: GroupRow) => {
      const w = waiting(g);
      return { id: g.id, ...g.data, name: g.name, kind: g.kind, waiting: w.n, longest_wait: w.oldest ? secondsSince(w.oldest) : 0, numbers: db.all('SELECT id, number, label FROM phone_numbers WHERE location_id = ? AND route_kind = ? AND route_id = ? AND status = ?', g.location_id, 'group', g.id, 'active'), created_at: g.created_at, updated_at: g.updated_at };
    };
    router.get('/api/telephony/groups/meta', 'location', (ctx) => ({
      strategies: Object.entries(STRATEGY_LABEL).map(([key, label]) => ({ key, label })),
      overflows: Object.entries(OVERFLOW_LABEL).map(([key, label]) => ({ key, label })),
      users: [...refs(ctx.locationId).users].map(([uid, name]) => ({ id: uid, name })),
      hold_audio: db.all(`SELECT id, name, duration_s FROM call_audio WHERE location_id = ? AND kind = 'hold' ORDER BY created_at DESC`, ctx.locationId),
      hold_seconds: HOLD_SECONDS,
      default: defaultGroup(),
    }));
    router.get('/api/telephony/groups', 'location', (ctx) => db.all<any>('SELECT * FROM call_groups WHERE location_id = ? ORDER BY name', ctx.locationId).map((r) => out(parseJson(r, ['data']))));
    router.post('/api/telephony/groups', 'location', (ctx) => {
      const data = cleanGroup(ctx.body ?? {}, defaultGroup(), refs(ctx.locationId));
      const row = { id: id(), location_id: ctx.locationId, name: data.name, kind: data.kind, data, created_at: now(), updated_at: now() };
      db.insert('call_groups', row);
      return out(groupRow(ctx.locationId, row.id)!);
    });
    router.get('/api/telephony/groups/:id', 'location', (ctx) => {
      const g = groupRow(ctx.locationId, ctx.params.id);
      if (!g) throw notFound('Ruf-Gruppe nicht gefunden');
      return out(g);
    });
    router.put('/api/telephony/groups/:id', 'location', (ctx) => {
      const g = groupRow(ctx.locationId, ctx.params.id);
      if (!g) throw notFound('Ruf-Gruppe nicht gefunden');
      const data = cleanGroup(ctx.body ?? {}, g.data, refs(ctx.locationId, g.id), g.id);
      db.update('call_groups', g.id, { name: data.name, kind: data.kind, data, updated_at: now() }, ctx.locationId);
      return out(groupRow(ctx.locationId, g.id)!);
    });
    router.delete('/api/telephony/groups/:id', 'location', (ctx) => {
      const g = groupRow(ctx.locationId, ctx.params.id);
      if (!g) throw notFound('Ruf-Gruppe nicht gefunden');
      const num = db.get<{ number: string }>(`SELECT number FROM phone_numbers WHERE location_id = ? AND route_kind = 'group' AND route_id = ? AND status = 'active'`, ctx.locationId, g.id);
      if (num) throw bad(`Die Gruppe ist noch der Nummer ${num.number} zugeordnet`);
      for (const f of db.all<{ name: string; flow: string }>('SELECT name, flow FROM ivr_flows WHERE location_id = ?', ctx.locationId)) if (f.flow.includes(`"group_id":"${g.id}"`)) throw bad(`Die Gruppe wird noch im Telefonmenü „${f.name}“ benutzt`);
      for (const o of db.all<{ name: string; data: string }>('SELECT name, data FROM call_groups WHERE location_id = ? AND id <> ?', ctx.locationId, g.id)) if (o.data.includes(`"group_id":"${g.id}"`)) throw bad(`Die Gruppe ist der Überlauf von „${o.name}“`);
      db.run('DELETE FROM call_groups WHERE id = ?', g.id);
      return { ok: true };
    });
    router.get('/api/telephony/groups/:id/stats', 'location', (ctx) => {
      const g = groupRow(ctx.locationId, ctx.params.id);
      if (!g) throw notFound('Ruf-Gruppe nicht gefunden');
      const days = Math.min(Math.max(1, Math.round(Number(ctx.query.get('days') ?? 30))), 365);
      const rows = db.all<{ outcome: string; wait_seconds: number; answered_by: string }>(`SELECT outcome, wait_seconds, answered_by FROM queue_calls WHERE group_id = ? AND location_id = ? AND status = 'done' AND enqueued_at >= ?`, g.id, ctx.locationId, new Date(Date.now() - days * 864e5).toISOString());
      const stats = queueStats(rows);
      const names = new Map(g.data.members.map((m) => [memberKey(m), m.name]));
      return { days, ...stats, by_member: Object.entries(stats.by_member).map(([key, n]) => ({ key, name: names.get(key) ?? key, answered: n })), waiting: waiting(g).n };
    });
  },
};
