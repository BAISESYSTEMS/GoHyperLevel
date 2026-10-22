import { bad } from '../core/http.js';
import { normalizePhone } from '../core/util.js';
import { E164, say, twiml, xml } from './twilio.js';

/**
 * Pure building blocks of ring groups and queues: the definition and its validation, who rings next for the
 * strategies "gleichzeitig", "der Reihe nach" and "Round Robin", what happens when nobody answers (hold, try again,
 * overflow) and the numbers of the report. No database, no network – modules/telephony-queues.ts feeds it.
 */

export const STRATEGIES = ['simultaneous', 'sequential', 'round_robin'] as const;
export type Strategy = (typeof STRATEGIES)[number];
export const STRATEGY_LABEL: Record<Strategy, string> = {
  simultaneous: 'Alle gleichzeitig',
  sequential: 'Der Reihe nach (feste Reihenfolge)',
  round_robin: 'Reihum (wer zuletzt dran war, kommt ans Ende)',
};
export const OVERFLOWS = ['default', 'voicemail', 'number', 'group', 'ai', 'hangup'] as const;
export type OverflowKind = (typeof OVERFLOWS)[number];
export const OVERFLOW_LABEL: Record<OverflowKind, string> = {
  default: 'Wie sonst (KI-Telefonagent oder Voicemail)',
  voicemail: 'Voicemail mit eigener Ansage',
  number: 'An eine Nummer weiterleiten',
  group: 'An eine andere Ruf-Gruppe',
  ai: 'KI-Telefonagent',
  hangup: 'Auflegen',
};

export interface Member {
  type: 'user' | 'number';
  /** The person's id, or the number (+49…). */
  id: string;
  name: string;
}
export interface Overflow {
  kind: OverflowKind;
  number: string;
  group_id: string;
  box: string;
  say: string;
}
export interface GroupDef {
  name: string;
  /** "group": one round of ringing, then overflow. "queue": the caller waits (hold music) and is tried again until `max_wait`. */
  kind: 'group' | 'queue';
  strategy: Strategy;
  members: Member[];
  /** Seconds each attempt rings. */
  ring_timeout: number;
  /** Queue: how long a caller waits before the overflow, in seconds. */
  max_wait: number;
  /** Own hold music (an audio file of the sub-account); '' = the built-in melody. */
  hold_audio_id: string;
  announce_position: boolean;
  welcome: string;
  overflow: Overflow;
  /** Round robin: index of the member who starts the next call. */
  rr_next: number;
}

export const memberKey = (m: Pick<Member, 'type' | 'id'>) => `${m.type}:${m.id}`;
const str = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const clampInt = (v: unknown, min: number, max: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export const defaultGroup = (): GroupDef => ({
  name: '',
  kind: 'queue',
  strategy: 'simultaneous',
  members: [],
  ring_timeout: 20,
  max_wait: 120,
  hold_audio_id: '',
  announce_position: true,
  welcome: '',
  overflow: { kind: 'default', number: '', group_id: '', box: '', say: '' },
  rr_next: 0,
});

export interface GroupRefs {
  users: Map<string, string>;
  /** Other groups of the sub-account (overflow target). */
  groups: Set<string>;
  audio: Set<string>;
}

/** Validates a group from the browser onto the current one. */
export function cleanGroup(raw: any, cur: GroupDef = defaultGroup(), refs: GroupRefs, selfId = ''): GroupDef {
  const g: GroupDef = { ...cur, overflow: { ...cur.overflow }, members: cur.members.map((m) => ({ ...m })) };
  const b = raw ?? {};
  if (b.name !== undefined) g.name = str(b.name, 80);
  if (!g.name) throw bad('Bitte einen Namen eintragen');
  if (b.kind !== undefined) {
    if (b.kind !== 'group' && b.kind !== 'queue') throw bad('Art: Ruf-Gruppe oder Warteschlange');
    g.kind = b.kind;
  }
  if (b.strategy !== undefined) {
    if (!STRATEGIES.includes(b.strategy)) throw bad('Verteilung unbekannt');
    g.strategy = b.strategy;
  }
  if (b.members !== undefined) {
    if (!Array.isArray(b.members)) throw bad('Mitglieder als Liste');
    if (b.members.length > 20) throw bad('Höchstens 20 Mitglieder');
    const seen = new Set<string>();
    g.members = b.members.map((m: any) => {
      if (m?.type === 'user') {
        const uid = str(m.id, 64);
        const name = refs.users.get(uid);
        if (name === undefined) throw bad('Eine Person gibt es in diesem Sub-Account nicht');
        return { type: 'user' as const, id: uid, name };
      }
      const number = normalizePhone(str(m?.id ?? m?.number, 30));
      if (!E164.test(number)) throw bad(`${number || 'Nummer'} ist keine gültige Nummer (Format +49…)`);
      return { type: 'number' as const, id: number, name: str(m?.name, 60) || number };
    }).filter((m: Member) => (seen.has(memberKey(m)) ? false : (seen.add(memberKey(m)), true)));
    g.rr_next = 0;
  }
  if (b.ring_timeout !== undefined) g.ring_timeout = clampInt(b.ring_timeout, 5, 60, 20);
  if (b.max_wait !== undefined) g.max_wait = clampInt(b.max_wait, 10, 900, 120);
  if (b.hold_audio_id !== undefined) {
    const a = str(b.hold_audio_id, 40);
    if (a && !refs.audio.has(a)) throw bad('Die Wartemusik gibt es nicht (mehr)');
    g.hold_audio_id = a;
  }
  if (b.announce_position !== undefined) g.announce_position = !!b.announce_position;
  if (b.welcome !== undefined) g.welcome = str(b.welcome, 500);
  if (b.overflow !== undefined) {
    const o = b.overflow ?? {};
    if (!OVERFLOWS.includes(o.kind)) throw bad('Überlauf unbekannt');
    const next: Overflow = { kind: o.kind, number: '', group_id: '', box: str(o.box, 60), say: str(o.say, 500) };
    if (o.kind === 'number') {
      next.number = normalizePhone(str(o.number, 30));
      if (!E164.test(next.number)) throw bad('Überlauf: keine gültige Nummer (Format +49…)');
    }
    if (o.kind === 'group') {
      next.group_id = str(o.group_id, 40);
      if (!refs.groups.has(next.group_id) || next.group_id === selfId) throw bad('Überlauf: Bitte eine andere Ruf-Gruppe wählen');
    }
    g.overflow = next;
  }
  if (!g.members.length) throw bad('Bitte mindestens ein Mitglied eintragen');
  return g;
}

// --- who rings next ------------------------------------------------------------------------------------------------

/** The members in the order this call tries them: starting at `from` and going around. */
export function rotate<T>(list: T[], from: number): T[] {
  if (!list.length) return [];
  const i = ((from % list.length) + list.length) % list.length;
  return [...list.slice(i), ...list.slice(0, i)];
}

export interface Attempt {
  /** Who rings in this attempt. */
  members: Member[];
  /** Nobody is available at all (everybody offline, away or busy). */
  none: boolean;
  /** After this attempt every available member has been tried: the round is over. */
  roundDone: boolean;
}

/**
 * The next attempt of a call. `tried` holds the member keys already rung in this round; `available` decides who can
 * take a call right now (browser online, not away, not on another call). Simultaneous rings everybody at once; the
 * other strategies one member per attempt – round robin starts at the member after the last one who took a call.
 */
export function nextAttempt(g: Pick<GroupDef, 'strategy' | 'members' | 'rr_next'>, tried: string[], available: (m: Member) => boolean): Attempt {
  const order = g.strategy === 'round_robin' ? rotate(g.members, g.rr_next) : g.members;
  const ready = order.filter(available);
  if (!ready.length) return { members: [], none: true, roundDone: true };
  if (g.strategy === 'simultaneous') return { members: ready, none: false, roundDone: true };
  const untried = ready.filter((m) => !tried.includes(memberKey(m)));
  if (!untried.length) return { members: [], none: false, roundDone: true };
  return { members: [untried[0]], none: false, roundDone: untried.length === 1 };
}

/** After `member` took a call: round robin goes on with the one after them. */
export const afterAnswer = (g: Pick<GroupDef, 'members' | 'strategy'>, member: Pick<Member, 'type' | 'id'>): number => {
  const i = g.members.findIndex((m) => memberKey(m) === memberKey(member));
  return g.strategy === 'round_robin' && i >= 0 ? (i + 1) % g.members.length : 0;
};

export type Next = 'ring' | 'hold' | 'overflow';

/**
 * What comes after an attempt nobody answered: ring the next member right away, hold the caller (queues, until
 * `max_wait`) or give up to the overflow. A plain group has no waiting: after its round it overflows.
 */
export function afterAttempt(g: Pick<GroupDef, 'kind' | 'max_wait'>, a: Pick<Attempt, 'roundDone' | 'none'>, waitedSeconds: number): Next {
  if (g.kind === 'group') return a.roundDone ? 'overflow' : 'ring';
  if (waitedSeconds >= g.max_wait) return 'overflow';
  return a.roundDone ? 'hold' : 'ring';
}

/**
 * What follows an attempt that nobody answered: more members of this round to try (not for "alle gleichzeitig", whose single
 * attempt was the whole round), then hold or overflow. `available` is asked again, so members who went offline are skipped.
 */
export function afterNoAnswer(g: Pick<GroupDef, 'kind' | 'max_wait' | 'strategy' | 'members' | 'rr_next'>, tried: string[], available: (m: Member) => boolean, waitedSeconds: number): Next {
  const order = g.strategy === 'round_robin' ? rotate(g.members, g.rr_next) : g.members;
  const ready = order.filter(available);
  if (g.strategy !== 'simultaneous' && ready.some((m) => !tried.includes(memberKey(m)))) return 'ring';
  return afterAttempt(g, { roundDone: true, none: !ready.length }, waitedSeconds);
}

/** Seconds a caller is held before the next round (a queue keeps trying often, so a free agent is found soon). */
export const HOLD_SECONDS = 15;

export const positionText = (n: number) => (n <= 1 ? 'Sie sind der nächste Anrufer. Bitte bleiben Sie in der Leitung.' : `Sie sind der ${n}. Anrufer in der Warteschlange. Bitte bleiben Sie in der Leitung.`);

/** TwiML of the hold segment: position (if wanted), the music once, then back to the next attempt. */
export function holdTwiml(o: { position?: string; musicUrl: string; redirect: string }): string {
  return twiml(`${say(o.position ?? '')}<Play>${xml(o.musicUrl)}</Play><Redirect method="POST">${xml(o.redirect)}</Redirect>`);
}

// --- report ----------------------------------------------------------------------------------------------------------

export interface QueueRow {
  outcome: string;
  wait_seconds: number;
  answered_by: string;
}
export interface QueueStats {
  offered: number;
  answered: number;
  abandoned: number;
  overflowed: number;
  avg_wait: number;
  max_wait: number;
  /** Share of answered calls picked up within `sl` seconds of waiting, in percent. */
  service_level: number | null;
  by_member: Record<string, number>;
}

/** Numbers for the queue report (`slSeconds`: the target for the service level, 20 s as usual). */
export function queueStats(rows: QueueRow[], slSeconds = 20): QueueStats {
  const answered = rows.filter((r) => r.outcome === 'answered');
  const waits = rows.map((r) => r.wait_seconds);
  const by_member: Record<string, number> = {};
  for (const r of answered) if (r.answered_by) by_member[r.answered_by] = (by_member[r.answered_by] ?? 0) + 1;
  return {
    offered: rows.length,
    answered: answered.length,
    abandoned: rows.filter((r) => r.outcome === 'abandoned').length,
    overflowed: rows.filter((r) => r.outcome === 'overflow' || r.outcome === 'voicemail').length,
    avg_wait: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0,
    max_wait: waits.length ? Math.max(...waits) : 0,
    service_level: answered.length ? Math.round((answered.filter((r) => r.wait_seconds <= slSeconds).length / answered.length) * 100) : null,
    by_member,
  };
}
