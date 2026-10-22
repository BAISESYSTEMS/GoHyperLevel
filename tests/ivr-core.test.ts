import { describe, expect, it } from 'vitest';
import {
  cleanFlow,
  cleanSchedule,
  defaultSchedule,
  easter,
  flowIssues,
  germanHolidays,
  menuDecision,
  menuTwiml,
  scheduleState,
  simulate,
  type FlowRefs,
  type IvrFlow,
  type MenuNode,
  type Schedule,
} from '../server/services/ivr.js';
import { afterAnswer, afterAttempt, afterNoAnswer, cleanGroup, defaultGroup, nextAttempt, queueStats, rotate, type GroupDef, type Member } from '../server/services/call-groups.js';

const refs: FlowRefs = { groups: new Set(['g1']), users: new Set(['u1', 'u2']), audio: new Set(['a1']), schedules: new Set(['s1']) };

const flow = (): any => ({
  start: 'start',
  nodes: [
    { id: 'start', type: 'schedule', label: 'Zeit', schedule_id: 's1', open: 'menu', closed: 'vm', holiday: 'feiertag' },
    { id: 'menu', type: 'menu', label: 'Hauptmenü', say: 'Eins für Vertrieb, zwei für Support.', options: { '1': 'sales', '2': 'support' }, option_labels: { '1': 'Vertrieb', '2': 'Support' }, on_timeout: 'vm', retries: 1 },
    { id: 'sales', type: 'forward', label: 'Vertrieb', numbers: ['+4930123456'], users: ['u1'], timeout: 15, on_fail: 'vm' },
    { id: 'support', type: 'group', label: 'Support', group_id: 'g1' },
    { id: 'vm', type: 'voicemail', label: 'Voicemail', box: 'Allgemein', say: '' },
    { id: 'feiertag', type: 'say', label: 'Feiertag', say: 'Heute ist Feiertag.', next: 'vm' },
  ],
});

describe('telephone menu: flow definition', () => {
  it('cleans a valid flow and keeps the structure', () => {
    const f = cleanFlow(flow(), refs);
    expect(f.start).toBe('start');
    expect(Object.keys(f.nodes)).toHaveLength(6);
    expect((f.nodes.menu as MenuNode).options).toEqual({ '1': 'sales', '2': 'support' });
    expect((f.nodes.menu as MenuNode).timeout).toBe(6);
    expect(flowIssues(f)).toEqual([]);
  });

  it('refuses dangling targets, unknown keys, unknown people, groups and files', () => {
    const f = flow();
    f.nodes[1].options['3'] = 'nirgendwo';
    expect(() => cleanFlow(f, refs)).toThrow(/Das Ziel „nirgendwo“ gibt es nicht/);
    const k = flow();
    k.nodes[1].options['x'] = 'sales';
    expect(() => cleanFlow(k, refs)).toThrow(/Taste „x“/);
    const u = flow();
    u.nodes[2].users = ['fremd'];
    expect(() => cleanFlow(u, refs)).toThrow(/Person gibt es in diesem Sub-Account nicht/);
    const g = flow();
    g.nodes[3].group_id = 'gx';
    expect(() => cleanFlow(g, refs)).toThrow(/Ruf-Gruppe oder Warteschlange wählen/);
    const a = flow();
    a.nodes[1].audio_id = 'weg';
    expect(() => cleanFlow(a, refs)).toThrow(/Audiodatei/);
    const n = flow();
    n.nodes[2].numbers = ['123'];
    expect(() => cleanFlow(n, refs)).toThrow(/keine gültige Nummer/);
    const dup = flow();
    dup.nodes[5].id = 'vm';
    expect(() => cleanFlow(dup, refs)).toThrow(/doppelt/);
    expect(() => cleanFlow({ start: 'weg', nodes: flow().nodes }, refs)).toThrow(/Startschritt/);
    expect(() => cleanFlow({ start: 'a', nodes: Array.from({ length: 61 }, (_, i) => ({ id: `n${i}`, type: 'hangup' })) }, refs)).toThrow(/Höchstens 60/);
  });

  it('points out unreachable steps and endless announcement loops without refusing them', () => {
    const f = cleanFlow(flow(), refs);
    f.nodes.extra = { id: 'extra', type: 'hangup', label: 'Verwaist', say: '' };
    expect(flowIssues(f).join(' ')).toContain('„Verwaist“ ist von keinem Schritt aus erreichbar');
    const loop = cleanFlow({ start: 'a', nodes: [{ id: 'a', type: 'say', label: 'A', say: 'x', next: 'b' }, { id: 'b', type: 'say', label: 'B', say: 'y', next: 'a' }] }, refs);
    expect(flowIssues(loop).join(' ')).toContain('im Kreis');
  });
});

describe('telephone menu: key presses', () => {
  const menu = cleanFlow(flow(), refs).nodes.menu as MenuNode;

  it('goes to the option of the key, repeats on a wrong key or silence and then falls back', () => {
    expect(menuDecision(menu, '2', 0)).toEqual({ kind: 'go', node: 'support', key: '2' });
    expect(menuDecision(menu, '2xyz', 0)).toMatchObject({ kind: 'go', key: '2' });
    expect(menuDecision(menu, '9', 0)).toEqual({ kind: 'repeat', attempt: 1, reason: 'invalid' });
    expect(menuDecision(menu, '', 0)).toEqual({ kind: 'repeat', attempt: 1, reason: 'timeout' });
    // retries: 1 → the second silence ends in the fallback (timeout target "vm").
    expect(menuDecision(menu, '', 1)).toEqual({ kind: 'fallback', node: 'vm', reason: 'timeout' });
    // A wrong key at the end uses the timeout target when no own one is set.
    expect(menuDecision(menu, '9', 1)).toEqual({ kind: 'fallback', node: 'vm', reason: 'invalid' });
    expect(menuDecision({ ...menu, on_timeout: '', on_invalid: '' }, '', 1)).toEqual({ kind: 'fallback', node: '', reason: 'timeout' });
  });

  it('puts the prompt inside the <Gather> so a key press interrupts it', () => {
    const x = menuTwiml({ prompt: '<Say>Hallo</Say>', action: 'https://x/a?n=1&a=0', timeoutUrl: 'https://x/a?n=1&t=1', seconds: 6 });
    expect(x).toContain('<Gather input="dtmf" numDigits="1" timeout="6" action="https://x/a?n=1&amp;a=0" method="POST"><Say>Hallo</Say></Gather><Redirect method="POST">https://x/a?n=1&amp;t=1</Redirect>');
  });
});

describe('schedules and holidays', () => {
  const tz = 'Europe/Berlin';
  const week = (): Schedule => ({ ...defaultSchedule(), german_holidays: { enabled: true, state: '' } });
  // 2026-10-05 is a Monday.
  const at = (iso: string) => new Date(iso);

  it('is open during the weekly hours in the sub-account timezone', () => {
    const s = week();
    expect(scheduleState(s, tz, at('2026-10-05T08:00:00Z')).state).toBe('open'); // Mo 10:00
    expect(scheduleState(s, tz, at('2026-10-05T16:30:00Z'))).toMatchObject({ state: 'closed', reason: 'außerhalb der Öffnungszeiten' });
    expect(scheduleState(s, tz, at('2026-10-10T09:00:00Z')).state).toBe('closed'); // Sa
  });

  it('supports several intervals a day (lunch break) and overnight intervals', () => {
    const s = cleanSchedule({ hours: { mon: [{ from: '09:00', to: '12:00' }, { from: '13:00', to: '17:00' }], tue: [{ from: '22:00', to: '02:00' }] } }, week());
    expect(scheduleState(s, tz, at('2026-10-05T09:30:00Z')).state).toBe('open'); // 11:30
    expect(scheduleState(s, tz, at('2026-10-05T10:30:00Z')).state).toBe('closed'); // 12:30 lunch
    expect(scheduleState(s, tz, at('2026-10-05T11:30:00Z')).state).toBe('open'); // 13:30
    expect(scheduleState(s, tz, at('2026-10-06T21:30:00Z')).state).toBe('open'); // Di 23:30
    expect(scheduleState(s, tz, at('2026-10-06T23:30:00Z')).state).toBe('open'); // Mi 01:30, the tail of Tuesday night
    expect(scheduleState(s, tz, at('2026-10-07T01:30:00Z')).state).toBe('closed'); // Mi 03:30
  });

  it('closes on the nationwide holidays and on the ones of the chosen state only', () => {
    const s = week();
    const neujahr = scheduleState(s, tz, at('2027-01-01T10:00:00Z')); // Fr
    expect(neujahr).toMatchObject({ state: 'holiday', reason: 'Feiertag: Neujahr' });
    expect(scheduleState(s, tz, at('2026-10-03T10:00:00Z'))).toMatchObject({ state: 'holiday', reason: 'Feiertag: Tag der Deutschen Einheit' });
    // Fronleichnam 2026-06-04 (Thursday) is a holiday in Bayern, not in Berlin.
    expect(scheduleState({ ...s, german_holidays: { enabled: true, state: 'BY' } }, tz, at('2026-06-04T09:00:00Z')).state).toBe('holiday');
    expect(scheduleState({ ...s, german_holidays: { enabled: true, state: 'BE' } }, tz, at('2026-06-04T09:00:00Z')).state).toBe('open');
    // With the German holidays switched off New Year is an ordinary Friday.
    expect(scheduleState({ ...s, german_holidays: { enabled: false, state: '' } }, tz, at('2027-01-01T10:00:00Z')).state).toBe('open');
  });

  it('own holidays: closed days, yearly ones and special hours', () => {
    const s = cleanSchedule(
      {
        holidays: [
          { date: '2026-10-05', name: 'Betriebsausflug', closed: true },
          { date: '12-24', name: 'Heiligabend', closed: false, intervals: [{ from: '09:00', to: '12:00' }] },
        ],
      },
      week(),
    );
    expect(scheduleState(s, tz, at('2026-10-05T08:00:00Z'))).toMatchObject({ state: 'holiday', reason: 'Feiertag: Betriebsausflug' });
    expect(scheduleState(s, tz, at('2026-12-24T09:00:00Z'))).toMatchObject({ state: 'open' }); // 10:00, special hours
    expect(scheduleState(s, tz, at('2026-12-24T12:00:00Z')).state).toBe('closed'); // 13:00, after the special hours
    expect(scheduleState(s, tz, at('2027-12-24T09:00:00Z')).state).toBe('open'); // every year
    expect(() => cleanSchedule({ holidays: [{ date: '24.12.', name: 'x' }] }, week())).toThrow(/Datum/);
    expect(() => cleanSchedule({ hours: { mon: [{ from: '9', to: '17' }] } }, week())).toThrow(/HH:MM/);
    expect(() => cleanSchedule({ german_holidays: { state: 'XX' } }, week())).toThrow(/Bundesland/);
  });

  it('computes Easter and the movable German holidays', () => {
    expect(easter(2026).toISOString().slice(0, 10)).toBe('2026-04-05');
    expect(easter(2027).toISOString().slice(0, 10)).toBe('2027-03-28');
    expect(easter(2038).toISOString().slice(0, 10)).toBe('2038-04-25');
    const h = germanHolidays(2026, 'BY');
    expect(h.get('2026-04-03')).toBe('Karfreitag');
    expect(h.get('2026-04-06')).toBe('Ostermontag');
    expect(h.get('2026-05-14')).toBe('Christi Himmelfahrt');
    expect(h.get('2026-05-25')).toBe('Pfingstmontag');
    expect(h.get('2026-06-04')).toBe('Fronleichnam');
    expect(h.get('2026-01-06')).toBe('Heilige Drei Könige');
    expect(h.get('2026-11-01')).toBe('Allerheiligen');
    expect(germanHolidays(2026, 'SN').get('2026-11-18')).toBe('Buß- und Bettag');
    expect(germanHolidays(2026, '').size).toBe(9);
    expect(germanHolidays(2026, 'NW').has('2026-06-04')).toBe(true);
    expect(germanHolidays(2026, 'HH').has('2026-06-04')).toBe(false);
  });
});

describe('telephone menu: dry run', () => {
  const f: IvrFlow = cleanFlow(flow(), refs);
  const schedules = { s1: week() };
  function week(): Schedule {
    return defaultSchedule();
  }
  const run = (keys: string[], at: string) => simulate(f, { keys, at: new Date(at), tz: 'Europe/Berlin', schedules, defaultOpen: true });

  it('follows schedule and key to the branch', () => {
    const r = run(['1'], '2026-10-05T08:00:00Z'); // Monday 10:00
    expect(r.end).toBe('forward');
    expect(r.steps.map((s) => s.label)).toEqual(['Zeit', 'Hauptmenü', 'Hauptmenü', 'Vertrieb']);
    expect(run(['2'], '2026-10-05T08:00:00Z').end).toBe('group');
  });

  it('sends callers outside the hours to the voicemail and on holidays to the announcement first', () => {
    expect(run([], '2026-10-05T18:00:00Z')).toMatchObject({ end: 'voicemail' });
    const holiday = run([], '2027-01-01T10:00:00Z'); // Neujahr, a Friday
    expect(holiday.end).toBe('voicemail');
    expect(holiday.steps.map((s) => s.label)).toContain('Feiertag');
  });

  it('repeats the menu on wrong keys and ends at the fallback; waits when no key is given', () => {
    expect(run(['7', '8'], '2026-10-05T08:00:00Z').end).toBe('voicemail');
    expect(run([], '2026-10-05T08:00:00Z').end).toBe('waiting');
  });
});

describe('ring groups: who rings next', () => {
  const members: Member[] = [
    { type: 'user', id: 'u1', name: 'Anna' },
    { type: 'user', id: 'u2', name: 'Ben' },
    { type: 'number', id: '+4915111111111', name: 'Chris' },
  ];
  const g = (strategy: GroupDef['strategy'], rr = 0) => ({ strategy, members, rr_next: rr });
  const all = () => true;

  it('rings everybody at once for "gleichzeitig" (only the available ones)', () => {
    expect(nextAttempt(g('simultaneous'), [], all).members).toHaveLength(3);
    const a = nextAttempt(g('simultaneous'), [], (m) => m.id !== 'u2');
    expect(a.members.map((m) => m.id)).toEqual(['u1', '+4915111111111']);
    expect(a.roundDone).toBe(true);
    expect(nextAttempt(g('simultaneous'), [], () => false)).toEqual({ members: [], none: true, roundDone: true });
  });

  it('tries one member after the other and knows when the round is over', () => {
    expect(nextAttempt(g('sequential'), [], all)).toMatchObject({ members: [members[0]], roundDone: false });
    expect(nextAttempt(g('sequential'), ['user:u1'], all)).toMatchObject({ members: [members[1]], roundDone: false });
    expect(nextAttempt(g('sequential'), ['user:u1', 'user:u2'], all)).toMatchObject({ members: [members[2]], roundDone: true });
    expect(nextAttempt(g('sequential'), ['user:u1', 'user:u2', 'number:+4915111111111'], all)).toMatchObject({ members: [], roundDone: true });
    // Somebody offline is skipped, not waited for.
    expect(nextAttempt(g('sequential'), ['user:u1'], (m) => m.id !== 'u2').members).toEqual([members[2]]);
  });

  it('round robin starts after the person who took the last call', () => {
    expect(rotate([1, 2, 3], 1)).toEqual([2, 3, 1]);
    expect(nextAttempt(g('round_robin', 1), [], all).members).toEqual([members[1]]);
    expect(nextAttempt(g('round_robin', 1), ['user:u2'], all).members).toEqual([members[2]]);
    expect(nextAttempt(g('round_robin', 1), ['user:u2', 'number:+4915111111111'], all).members).toEqual([members[0]]);
    expect(afterAnswer(g('round_robin'), members[1])).toBe(2);
    expect(afterAnswer(g('round_robin'), members[2])).toBe(0);
    expect(afterAnswer(g('sequential'), members[1])).toBe(0);
  });

  it('decides between ringing on, holding and the overflow', () => {
    const q = { kind: 'queue' as const, max_wait: 60 };
    expect(afterAttempt(q, { roundDone: false, none: false }, 5)).toBe('ring');
    expect(afterAttempt(q, { roundDone: true, none: false }, 5)).toBe('hold');
    expect(afterAttempt(q, { roundDone: true, none: false }, 60)).toBe('overflow');
    // A plain group has no waiting: after its round it overflows.
    expect(afterAttempt({ kind: 'group', max_wait: 60 }, { roundDone: true, none: false }, 1)).toBe('overflow');
    expect(afterAttempt({ kind: 'group', max_wait: 60 }, { roundDone: false, none: false }, 1)).toBe('ring');
    // After an unanswered attempt: more members to try → ring, else hold / overflow.
    expect(afterNoAnswer({ ...g('sequential'), kind: 'queue', max_wait: 60 }, ['user:u1'], all, 3)).toBe('ring');
    expect(afterNoAnswer({ ...g('sequential'), kind: 'queue', max_wait: 60 }, ['user:u1', 'user:u2', 'number:+4915111111111'], all, 3)).toBe('hold');
    expect(afterNoAnswer({ ...g('simultaneous'), kind: 'queue', max_wait: 60 }, [], all, 3)).toBe('hold');
    expect(afterNoAnswer({ ...g('simultaneous'), kind: 'queue', max_wait: 60 }, [], () => false, 61)).toBe('overflow');
  });

  it('validates a group definition', () => {
    const r = { users: new Map([['u1', 'Anna']]), groups: new Set(['g2']), audio: new Set(['m1']) };
    const ok = cleanGroup({ name: 'Vertrieb', members: [{ type: 'user', id: 'u1' }, { type: 'number', id: '0151 1111 1111', name: 'Chris' }], strategy: 'round_robin', max_wait: 90, overflow: { kind: 'group', group_id: 'g2' }, hold_audio_id: 'm1' }, defaultGroup(), r, 'g1');
    expect(ok).toMatchObject({ name: 'Vertrieb', strategy: 'round_robin', max_wait: 90, hold_audio_id: 'm1', overflow: { kind: 'group', group_id: 'g2' } });
    expect(ok.members.map((m) => `${m.type}:${m.id}:${m.name}`)).toEqual(['user:u1:Anna', 'number:+4915111111111:Chris']);
    expect(() => cleanGroup({ name: 'x', members: [] }, defaultGroup(), r)).toThrow(/mindestens ein Mitglied/);
    expect(() => cleanGroup({ name: 'x', members: [{ type: 'user', id: 'fremd' }] }, defaultGroup(), r)).toThrow(/Person gibt es/);
    expect(() => cleanGroup({ name: 'x', members: [{ type: 'number', id: '123' }] }, defaultGroup(), r)).toThrow(/keine gültige Nummer/);
    expect(() => cleanGroup({ name: 'x', members: [{ type: 'user', id: 'u1' }], overflow: { kind: 'group', group_id: 'g1' } }, defaultGroup(), r, 'g1')).toThrow(/andere Ruf-Gruppe/);
    expect(() => cleanGroup({ name: 'x', members: [{ type: 'user', id: 'u1' }], hold_audio_id: 'weg' }, defaultGroup(), r)).toThrow(/Wartemusik/);
  });

  it('counts the report: offered, answered, abandoned, waiting time and service level', () => {
    const s = queueStats([
      { outcome: 'answered', wait_seconds: 10, answered_by: 'user:u1' },
      { outcome: 'answered', wait_seconds: 30, answered_by: 'user:u2' },
      { outcome: 'answered', wait_seconds: 5, answered_by: 'user:u1' },
      { outcome: 'abandoned', wait_seconds: 40, answered_by: '' },
      { outcome: 'voicemail', wait_seconds: 120, answered_by: '' },
    ]);
    expect(s).toMatchObject({ offered: 5, answered: 3, abandoned: 1, overflowed: 1, max_wait: 120, avg_wait: 41, service_level: 67 });
    expect(s.by_member).toEqual({ 'user:u1': 2, 'user:u2': 1 });
    expect(queueStats([]).service_level).toBeNull();
  });
});
