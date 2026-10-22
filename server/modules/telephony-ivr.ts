import type { LocationRow, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { bad, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { contactName, getContact } from '../services/contacts.js';
import {
  MAX_HOPS,
  NODE_LABEL,
  NODE_TYPES,
  STATES,
  cleanFlow,
  cleanSchedule,
  defaultSchedule,
  emptyFlow,
  flowIssues,
  germanHolidays,
  innerOf,
  menuDecision,
  menuTwiml,
  scheduleState,
  simulate,
  speech,
  type FlowRefs,
  type ForwardNode,
  type IvrFlow,
  type IvrNode,
  type MenuNode,
  type Schedule,
} from '../services/ivr.js';
import { dialTwiml, hangup, isOpen, say, twiml } from '../services/twilio.js';
import { recordNotice, telephonyConfig, type CallRouteInput, type Config } from './telephony.js';
import { audioOf, audioUrl, type AudioRow } from './telephony-audio.js';
import { peopleOf } from '../services/team-people.js';
import type { RouteHandler } from './telephony-numbers.js';

/**
 * Telephone menu (IVR): a visual flow of steps – greeting with keys, business-hours and holiday schedules, announcements,
 * forwarding to numbers and people, ring groups and queues, a voicemail per branch, the KI-Telefonagent – assigned to a phone
 * number (Nummern → Ziel). Every key press is one signed webhook: where the caller is lives in the URL (flow, step, attempt),
 * nothing is kept between requests, and the path through the menu is written onto the call ("Hauptmenü › 2 Support").
 */

type CallRow = Record<string, any>;
interface FlowRow {
  id: string;
  location_id: string;
  name: string;
  flow: IvrFlow;
  created_at: string;
  updated_at: string;
}
interface Run {
  loc: LocationRow;
  cfg: Config;
  call: CallRow;
  flowId: string;
  flow: IvrFlow;
  /** Menus visited in this call – a loop that never ends is cut off. */
  depth: number;
}

const DEFAULT_VOICEMAIL_GREETING = 'Bitte hinterlassen Sie nach dem Signalton Ihren Namen, Ihre Nummer und Ihr Anliegen – wir rufen zurück.';

export const telephonyIvrModule: Module = {
  name: 'telephony-ivr',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE ivr_flows (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, flow TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX ivr_flows_loc ON ivr_flows(location_id);
      CREATE TABLE call_schedules (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX call_schedules_loc ON call_schedules(location_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const hook = (name: string, loc: string) => `${app.baseUrl()}/hooks/twilio/${name}/${loc}`;
    const kit = () => app.services.telephonyKit;

    // --- storage -------------------------------------------------------------------------------------------------------
    const flowRow = (locationId: string, key: string): FlowRow | undefined => parseJson(db.get<any>('SELECT * FROM ivr_flows WHERE id = ? AND location_id = ?', key, locationId), ['flow']);
    const schedules = (locationId: string): Record<string, Schedule> =>
      Object.fromEntries(db.all<{ id: string; data: string }>('SELECT id, data FROM call_schedules WHERE location_id = ?', locationId).map((r) => [r.id, { ...defaultSchedule(), ...JSON.parse(r.data) } as Schedule]));
    const refs = (locationId: string): FlowRefs => ({
      groups: new Set(db.all<{ id: string }>('SELECT id FROM call_groups WHERE location_id = ?', locationId).map((r) => r.id)),
      users: new Set(peopleOf(app, locationId, '').map((u) => u.id)),
      audio: new Set(db.all<{ id: string }>('SELECT id FROM call_audio WHERE location_id = ?', locationId).map((r) => r.id)),
      schedules: new Set(db.all<{ id: string }>('SELECT id FROM call_schedules WHERE location_id = ?', locationId).map((r) => r.id)),
    });
    const flowOut = (r: FlowRow) => ({ id: r.id, name: r.name, flow: r.flow, issues: flowIssues(r.flow), numbers: db.all('SELECT id, number, label FROM phone_numbers WHERE location_id = ? AND route_kind = ? AND route_id = ? AND status = ?', r.location_id, 'ivr', r.id, 'active'), created_at: r.created_at, updated_at: r.updated_at });

    // Files that a menu uses cannot be deleted from under it; neither can the schedules, ring groups and numbers.
    app.services.audioUsage ??= [];
    app.services.audioUsage.push((locationId: string, audioId: string): string | undefined => {
      for (const r of db.all<{ name: string; flow: string }>('SELECT name, flow FROM ivr_flows WHERE location_id = ?', locationId)) if (r.flow.includes(`"${audioId}"`)) return `Telefonmenü „${r.name}“`;
      return undefined;
    });

    // --- API: flows ------------------------------------------------------------------------------------------------------
    router.get('/api/telephony/ivr/meta', 'location', (ctx) => ({
      node_types: NODE_TYPES.map((t) => ({ key: t, label: NODE_LABEL[t] })),
      users: peopleOf(app, ctx.locationId, '').map((u) => ({ id: u.id, name: u.name })),
      groups: db.all('SELECT id, name, kind FROM call_groups WHERE location_id = ? ORDER BY name', ctx.locationId),
      schedules: db.all('SELECT id, name FROM call_schedules WHERE location_id = ? ORDER BY name', ctx.locationId),
      audio: db.all<AudioRow>(`SELECT * FROM call_audio WHERE location_id = ? AND kind = 'greeting' ORDER BY created_at DESC`, ctx.locationId).map((a) => ({ id: a.id, name: a.name, duration_s: a.duration_s, url: audioUrl(app, a) })),
      states: STATES.map(([code, name]) => ({ code, name })),
      empty: emptyFlow(),
    }));
    router.get('/api/telephony/ivr', 'location', (ctx) => db.all<any>('SELECT * FROM ivr_flows WHERE location_id = ? ORDER BY name', ctx.locationId).map((r) => flowOut(parseJson(r, ['flow']))));
    router.post('/api/telephony/ivr', 'location', (ctx) => {
      const name = str(ctx.body?.name, 'Name', { required: true, max: 80 });
      const flow = ctx.body?.flow ? cleanFlow(ctx.body.flow, refs(ctx.locationId)) : emptyFlow();
      const row = { id: id(), location_id: ctx.locationId, name, flow, created_at: now(), updated_at: now() };
      db.insert('ivr_flows', row);
      return flowOut(flowRow(ctx.locationId, row.id)!);
    });
    router.get('/api/telephony/ivr/:id', 'location', (ctx) => {
      const r = flowRow(ctx.locationId, ctx.params.id);
      if (!r) throw notFound('Telefonmenü nicht gefunden');
      return flowOut(r);
    });
    router.put('/api/telephony/ivr/:id', 'location', (ctx) => {
      const r = flowRow(ctx.locationId, ctx.params.id);
      if (!r) throw notFound('Telefonmenü nicht gefunden');
      const patch: Record<string, unknown> = { updated_at: now() };
      if (ctx.body?.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 80 });
      if (ctx.body?.flow !== undefined) patch.flow = cleanFlow(ctx.body.flow, refs(ctx.locationId));
      db.update('ivr_flows', r.id, patch, ctx.locationId);
      return flowOut(flowRow(ctx.locationId, r.id)!);
    });
    router.delete('/api/telephony/ivr/:id', 'location', (ctx) => {
      const r = flowRow(ctx.locationId, ctx.params.id);
      if (!r) throw notFound('Telefonmenü nicht gefunden');
      const used = db.get<{ number: string }>(`SELECT number FROM phone_numbers WHERE location_id = ? AND route_kind = 'ivr' AND route_id = ? AND status = 'active'`, ctx.locationId, r.id);
      if (used) throw bad(`Das Menü ist noch der Nummer ${used.number} zugeordnet`);
      db.run('DELETE FROM ivr_flows WHERE id = ?', r.id);
      return { ok: true };
    });

    /** Testlauf: which steps a call takes for the given key presses at the given time – nothing is dialled. */
    router.post('/api/telephony/ivr/:id/simulate', 'location', (ctx) => {
      const r = flowRow(ctx.locationId, ctx.params.id);
      if (!r) throw notFound('Telefonmenü nicht gefunden');
      const loc = app.location(ctx.locationId)!;
      const b = ctx.body ?? {};
      const at = b.at ? new Date(String(b.at)) : new Date();
      if (Number.isNaN(at.getTime())) throw bad('Zeitpunkt ungültig');
      const keys = (Array.isArray(b.keys) ? b.keys : []).slice(0, 30).map((k: unknown) => String(k ?? '').slice(0, 1));
      const cfg = telephonyConfig(app, ctx.locationId);
      return simulate(r.flow, { keys, at, tz: loc.timezone, schedules: schedules(ctx.locationId), defaultOpen: isOpen(cfg.s.hours_mode, cfg.s.hours, loc.timezone, at) });
    });

    // --- API: schedules ----------------------------------------------------------------------------------------------------
    const schedOut = (r: { id: string; name: string; data: string; created_at: string; updated_at: string }, tz: string) => {
      const s = { ...defaultSchedule(), ...JSON.parse(r.data) } as Schedule;
      return { id: r.id, name: r.name, ...s, state_now: scheduleState(s, tz), created_at: r.created_at, updated_at: r.updated_at };
    };
    router.get('/api/telephony/schedules', 'location', (ctx) => {
      const tz = app.location(ctx.locationId)!.timezone;
      return db.all<any>('SELECT * FROM call_schedules WHERE location_id = ? ORDER BY name', ctx.locationId).map((r) => schedOut(r, tz));
    });
    router.get('/api/telephony/schedules/holidays', 'location', (ctx) => {
      const year = Math.min(2100, Math.max(2000, Math.round(Number(ctx.query.get('year') ?? new Date().getFullYear()))));
      const state = String(ctx.query.get('state') ?? '').toUpperCase();
      if (state && !STATES.some(([c]) => c === state)) throw bad('Bundesland unbekannt');
      return { year, state, holidays: [...germanHolidays(year, state)].sort().map(([date, name]) => ({ date, name })) };
    });
    router.post('/api/telephony/schedules', 'location', (ctx) => {
      const name = str(ctx.body?.name, 'Name', { required: true, max: 80 });
      const data = cleanSchedule(ctx.body ?? {});
      const row = { id: id(), location_id: ctx.locationId, name, data, created_at: now(), updated_at: now() };
      db.insert('call_schedules', row);
      return schedOut(db.get<any>('SELECT * FROM call_schedules WHERE id = ?', row.id), app.location(ctx.locationId)!.timezone);
    });
    router.put('/api/telephony/schedules/:id', 'location', (ctx) => {
      const r = db.get<any>('SELECT * FROM call_schedules WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Zeitplan nicht gefunden');
      const patch: Record<string, unknown> = { data: cleanSchedule(ctx.body ?? {}, { ...defaultSchedule(), ...JSON.parse(r.data) }), updated_at: now() };
      if (ctx.body?.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 80 });
      db.update('call_schedules', r.id, patch, ctx.locationId);
      return schedOut(db.get<any>('SELECT * FROM call_schedules WHERE id = ?', r.id), app.location(ctx.locationId)!.timezone);
    });
    router.delete('/api/telephony/schedules/:id', 'location', (ctx) => {
      const r = db.get<any>('SELECT * FROM call_schedules WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Zeitplan nicht gefunden');
      for (const f of db.all<{ name: string; flow: string }>('SELECT name, flow FROM ivr_flows WHERE location_id = ?', ctx.locationId)) if (f.flow.includes(`"schedule_id":"${r.id}"`)) throw bad(`Der Zeitplan wird noch im Telefonmenü „${f.name}“ benutzt`);
      db.run('DELETE FROM call_schedules WHERE id = ?', r.id);
      return { ok: true };
    });

    // --- running a call through a flow ------------------------------------------------------------------------------------
    const audio = (locationId: string, audioId: string) => {
      const a = audioOf(app, locationId, audioId);
      return a ? audioUrl(app, a) : undefined;
    };
    const urlOf = (r: Run, name: string, node: string, extra: Record<string, string | number> = {}) =>
      `${hook(name, r.loc.id)}?${new URLSearchParams({ f: r.flowId, n: node, d: String(r.depth), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) })}`;
    const note = (r: Run, node: IvrNode, text = node.label) => {
      db.run(`UPDATE calls SET route_node = ?, route_path = substr(CASE WHEN route_path = '' THEN ? ELSE route_path || ' › ' || ? END, 1, 400), updated_at = ? WHERE id = ?`, node.id, text, text, now(), r.call.id);
    };

    /** The inner TwiML of a node (so an announcement can stand in front of the next node). */
    const exec = (r: Run, nodeId: string, hops = 0): string => {
      const node = r.flow.nodes[nodeId];
      if (!node || hops > MAX_HOPS) return innerOf(kit().unanswered(r.loc, r.cfg, db.get('SELECT * FROM calls WHERE id = ?', r.call.id)));
      switch (node.type) {
        case 'menu':
          r.depth += 1;
          note(r, node);
          return innerOf(menuXml(r, node, 0));
        case 'say':
          note(r, node);
          return speech(node.say, node.audio_id ? audio(r.loc.id, node.audio_id) : undefined) + (node.next ? exec(r, node.next, hops + 1) : '<Hangup/>');
        case 'schedule': {
          const s = node.schedule_id ? schedules(r.loc.id)[node.schedule_id] : undefined;
          const state = s ? scheduleState(s, r.loc.timezone) : { state: isOpen(r.cfg.s.hours_mode, r.cfg.s.hours, r.loc.timezone) ? ('open' as const) : ('closed' as const), reason: '' };
          note(r, node, `${node.label}: ${state.state === 'open' ? 'geöffnet' : state.reason || 'geschlossen'}`);
          return exec(r, state.state === 'open' ? node.open : state.state === 'holiday' ? node.holiday || node.closed : node.closed, hops + 1);
        }
        case 'forward':
          return forward(r, node, hops);
        case 'group': {
          note(r, node);
          const out: string | undefined = app.services.callGroups?.enter({ loc: r.loc, cfg: r.cfg, call: db.get('SELECT * FROM calls WHERE id = ?', r.call.id), groupId: node.group_id });
          if (out) return innerOf(out);
          return exec(r, node.on_fail || '', hops + 1);
        }
        case 'voicemail': {
          note(r, node, `Voicemail ${node.box}`);
          const prompt = speech(node.say || DEFAULT_VOICEMAIL_GREETING, node.audio_id ? audio(r.loc.id, node.audio_id) : undefined);
          // The greeting is played (or read) here; the recorder itself starts without its own greeting.
          const vm = kit().voicemail(r.loc, r.cfg, db.get('SELECT * FROM calls WHERE id = ?', r.call.id), { greeting: ' ', box: node.box, record: true });
          return prompt + innerOf(vm);
        }
        case 'ai': {
          note(r, node);
          const open = isOpen(r.cfg.s.hours_mode, r.cfg.s.hours, r.loc.timezone);
          const out: string | undefined = app.services.voiceAgent?.({ stage: 'inbound', loc: r.loc, call: db.get('SELECT * FROM calls WHERE id = ?', r.call.id), open, force: true });
          if (out) return innerOf(out);
          return exec(r, node.on_fail || '', hops + 1);
        }
        case 'hangup':
          note(r, node);
          return `${say(node.say)}<Hangup/>`;
      }
    };

    const menuXml = (r: Run, node: MenuNode, attempt: number, before = '') =>
      menuTwiml({
        prompt: speech(node.say, node.audio_id ? audio(r.loc.id, node.audio_id) : undefined),
        action: urlOf(r, 'ivr', node.id, { a: attempt }),
        timeoutUrl: urlOf(r, 'ivr', node.id, { a: attempt, t: 1 }),
        seconds: node.timeout,
        before,
      });

    const forward = (r: Run, node: ForwardNode, hops: number): string => {
      note(r, node);
      const call = db.get<CallRow>('SELECT * FROM calls WHERE id = ?', r.call.id)!;
      const clients = node.users.map((u) => app.services.voiceUserClient?.(r.loc.id, u, call)).filter(Boolean) as { identity: string; params?: Record<string, string> }[];
      if (!node.numbers.length && !clients.length) return exec(r, node.on_fail || '', hops + 1);
      const announce = r.cfg.s.record_inbound && r.cfg.s.record_announce;
      if (announce) db.run('UPDATE calls SET consent_announced = 1 WHERE id = ?', call.id);
      return innerOf(
        dialTwiml({
          numbers: node.numbers,
          clients,
          timeout: node.timeout,
          action: urlOf(r, 'ivr-dial', node.id),
          record: r.cfg.s.record_inbound,
          recordingCallback: `${hook('voice-recording', r.loc.id)}?kind=dial`,
          announce: [node.say, announce ? recordNotice(r.cfg.s) : ''].filter(Boolean).join(' '),
        }),
      );
    };

    /** Entry from the number: a call to a number whose route is a menu. */
    const kinds = (app.services.callRouteKinds ??= {} as Record<string, RouteHandler>) as Record<string, RouteHandler>;
    kinds.ivr = (i: CallRouteInput & { number: { route_id: string } }) => {
      const row = flowRow(i.loc.id, i.number.route_id);
      if (!row) return undefined;
      const run: Run = { loc: i.loc, cfg: i.cfg, call: i.call, flowId: row.id, flow: row.flow, depth: 0 };
      return twiml(exec(run, row.flow.start));
    };

    /** Loads the run of a webhook from the signed URL; null when the flow or step is gone (the caller then gets the normal flow). */
    const runOf = (loc: LocationRow, cfg: Config, call: CallRow, q: URLSearchParams): { run: Run; node: IvrNode } | null => {
      const row = flowRow(loc.id, q.get('f') ?? '');
      const node = row?.flow.nodes[q.get('n') ?? ''];
      if (!row || !node) return null;
      return { run: { loc, cfg, call, flowId: row.id, flow: row.flow, depth: Math.max(0, Math.round(Number(q.get('d') ?? 0))) }, node };
    };

    // Which "hookRoute" to use comes from telephony: signed POST, location from the path, call by CallSid.
    const route = (name: string, fn: (loc: LocationRow, p: Record<string, string>, cfg: Config, q: URLSearchParams) => string) => kit().hookRoute(name, fn);

    /** Key press (or silence) at a menu. */
    route('ivr', (loc, p, cfg, q) => {
      const call: CallRow | undefined = kit().callBySid(loc.id, p.CallSid);
      if (!call) return hangup();
      const found = runOf(loc, cfg, call, q);
      if (!found || found.node.type !== 'menu') return kit().unanswered(loc, cfg, call);
      const { run, node } = found;
      const m = node as MenuNode;
      if (run.depth > MAX_HOPS) return kit().unanswered(loc, cfg, call);
      const digits = q.get('t') === '1' ? '' : String(p.Digits ?? '');
      const d = menuDecision(m, digits, Math.max(0, Math.round(Number(q.get('a') ?? 0))));
      if (d.kind === 'go') {
        note(run, m, `${d.key}${m.option_labels[d.key] ? ` ${m.option_labels[d.key]}` : ''}`);
        return twiml(exec(run, d.node));
      }
      if (d.kind === 'repeat') return menuXml(run, m, d.attempt, d.reason === 'invalid' ? say('Diese Eingabe kenne ich nicht.') : '');
      note(run, m, d.reason === 'invalid' ? 'falsche Eingabe' : 'keine Eingabe');
      return d.node ? twiml(exec(run, d.node)) : kit().unanswered(loc, cfg, call);
    });

    /** After a forward step: somebody answered → done; nobody → the step's "niemand erreichbar" branch. */
    route('ivr-dial', (loc, p, cfg, q) => {
      const call: CallRow | undefined = kit().callBySid(loc.id, p.CallSid);
      if (!call) return hangup();
      if (app.services.voiceDialHeld?.(call)) return twiml('');
      if (kit().settleDial(call, p)) return hangup();
      db.run(`UPDATE calls SET reason = 'no_answer' WHERE id = ?`, call.id);
      const found = runOf(loc, cfg, call, q);
      const fail = found && found.node.type === 'forward' ? found.node.on_fail : '';
      return found && fail ? twiml(exec(found.run, fail)) : kit().unanswered(loc, cfg, db.get('SELECT * FROM calls WHERE id = ?', call.id));
    });

    // A message left in a branch with an owner becomes a callback task for that person.
    app.events.on('call.voicemail', (e) => {
      const call = e.data.callId ? db.get<CallRow>('SELECT * FROM calls WHERE id = ? AND location_id = ?', e.data.callId, e.locationId) : undefined;
      if (!call || call.route_kind !== 'ivr') return;
      const node = flowRow(e.locationId, call.route_id)?.flow.nodes[call.route_node];
      if (node?.type !== 'voicemail' || !node.assign_user) return;
      const contact = call.contact_id ? getContact(app, e.locationId, call.contact_id) : undefined;
      const who = contact ? contactName(contact) : call.from_number || 'Unbekannt';
      db.insert('tasks', {
        id: id(),
        location_id: e.locationId,
        contact_id: call.contact_id ?? null,
        title: `Rückruf (Voicemail ${node.box}): ${who}`.slice(0, 200),
        description: `Voicemail im Telefonmenü, Zweig „${node.box}“.\n${call.route_path ? `Weg: ${call.route_path}\n` : ''}${call.transcription || ''}`.slice(0, 4000),
        due_at: now(),
        assigned_to: node.assign_user,
        done: 0,
        created_at: now(),
      });
    });
  },
};
