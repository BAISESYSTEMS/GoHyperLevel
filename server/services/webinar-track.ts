import type { App } from '../core/app.js';
import { HttpError, bad } from '../core/http.js';
import { sliceTimer } from '../core/perf.js';
import { id as newId } from '../core/util.js';
import { addTags, getContact, logActivity } from './contacts.js';
import { getOrCreateConversation } from './messaging.js';
import { eventData, nowOf } from './webinar-register.js';
import { percentOf, roomClock, sessionEnd, type RoomClock } from './webinar-schedule.js';
import { clock, getRegistration, getWebinar, type Registration, type Webinar } from './webinar-store.js';

/**
 * What happens while people watch: the room's clock, heartbeats (attendance, watch time), the offer button, questions,
 * poll votes, the end-of-session bookkeeping and the link between a purchase and the webinar that led to it.
 *
 * The server is the clock. A viewer cannot make a session shorter or longer by changing what their browser reports:
 * live watch time is measured from the heartbeats' arrival, only replays (which can be skipped through) trust the position.
 */

/** A viewer is "in the room" while the last heartbeat is younger than this. */
export const PRESENCE_MS = 45_000;
/** The end of a session is booked this long after it ended, so the last heartbeats are in. */
const FINALIZE_AFTER_MS = 5 * 60_000;

export const startMs = (reg: Pick<Registration, 'session_start'>) => Date.parse(reg.session_start);

/** The room's clock for one registration: viewers who are already in keep watching even past the "late" limit. */
export function clockFor(w: Webinar, reg: Registration, at: Date): RoomClock {
  const c = roomClock(startMs(reg), w.duration_s, at.getTime(), w.schedule.late_join_min);
  if (c.state === 'late' && reg.attended_at) return { ...c, state: 'running' };
  return c;
}

export interface ReplayWindow {
  available: boolean;
  reason?: 'disabled' | 'not_yet' | 'expired';
  until?: string;
}
/** The recording is there from the end of the session on, for `hours` after it. */
export function replayWindow(w: Webinar, reg: Registration, at: Date): ReplayWindow {
  if (!w.settings.replay.enabled) return { available: false, reason: 'disabled' };
  const end = Date.parse(sessionEnd(reg.session_start, w.duration_s));
  const until = new Date(end + w.settings.replay.hours * 3_600_000).toISOString();
  if (at.getTime() < end) return { available: false, reason: 'not_yet', until };
  if (at.getTime() > Date.parse(until)) return { available: false, reason: 'expired', until };
  return { available: true, until };
}

// --- tags, timeline, events -----------------------------------------------------------------------

function note(app: App, w: Webinar, reg: Registration, type: string, summary: string, tagList: string[], data: Record<string, unknown> = {}) {
  logActivity(app, w.location_id, reg.contact_id, type, summary, { webinar_id: w.id, session: reg.session_start, ...data });
  if (tagList.length) addTags(app, w.location_id, reg.contact_id, tagList);
}
const emit = (app: App, w: Webinar, reg: Registration, type: string, extra: Record<string, unknown> = {}) => app.events.emit(w.location_id, type, eventData(app, w, reg, getContact(app, w.location_id, reg.contact_id), extra));

// --- heartbeat --------------------------------------------------------------------------------------

export interface Ping {
  mode: 'live' | 'replay';
  /** Replay only: the position in the video (seconds) and whether it is playing. */
  pos?: number;
  playing?: boolean;
}

/** Books one heartbeat of a viewer; returns the room's clock (the page uses it to start, to correct itself and to end). */
export function ping(app: App, w: Webinar, reg: Registration, p: Ping, at = nowOf(app)): { clock: RoomClock; counter?: number } {
  const nowIso = at.toISOString();
  if (p.mode === 'replay') {
    if (!replayWindow(w, reg, at).available) throw new HttpError(410, 'Die Aufzeichnung ist nicht (mehr) verfügbar');
    const prev = reg.last_seen_at && reg.replay_at ? Date.parse(reg.last_seen_at) : 0;
    const gap = at.getTime() - prev;
    const add = p.playing && prev && gap <= PRESENCE_MS ? Math.min(gap / 1000, 30) : 0;
    const pos = Math.max(0, Math.min(Number(p.pos) || 0, w.duration_s));
    const first = !reg.replay_at && !!p.playing;
    app.db.run('UPDATE webinar_registrations SET replay_pos_s = ?, replay_watched_s = MIN(replay_watched_s + ?, ?), replay_at = COALESCE(replay_at, ?), last_seen_at = ? WHERE id = ?', pos, add, w.duration_s * 4, first ? nowIso : null, nowIso, reg.id);
    if (first) {
      const percent = percentOf(pos, w.duration_s);
      note(app, w, reg, 'webinar.replay', `Aufzeichnung von „${w.title}“ angesehen`, w.settings.tags.replay);
      emit(app, w, reg, 'webinar.replay_watched', { percent });
    }
    return { clock: clockFor(w, reg, at) };
  }

  const c = clockFor(w, reg, at);
  if (c.state === 'running') {
    const prev = reg.last_seen_at && reg.first_off !== null ? Date.parse(reg.last_seen_at) : 0;
    const gap = at.getTime() - prev;
    const add = prev && gap <= PRESENCE_MS ? Math.min(gap / 1000, 30) : 0;
    const watched = Math.min(reg.watched_s + add, w.duration_s);
    const firstTime = !reg.attended_at;
    app.db.run(
      'UPDATE webinar_registrations SET attended_at = COALESCE(attended_at, ?), first_off = COALESCE(first_off, ?), last_off = MAX(COALESCE(last_off, 0), ?), watched_s = ?, watch_pct = ?, last_seen_at = ? WHERE id = ?',
      nowIso,
      c.offset_s,
      c.offset_s,
      watched,
      percentOf(watched, w.duration_s),
      nowIso,
      reg.id,
    );
    if (firstTime) {
      note(app, w, reg, 'webinar.attended', `Im Webinar „${w.title}“ (ab ${clock(c.offset_s)} Min.)`, w.settings.tags.attended);
      emit(app, w, reg, 'webinar.attended', { offset_s: Math.round(c.offset_s) });
    }
  }
  const counter = w.settings.room.show_counter ? roomCount(app, w, at) : undefined;
  return { clock: c, ...(counter !== undefined ? { counter } : {}) };
}

/** People really in a room of this webinar right now (heartbeat in the last 45 seconds). */
export function roomCount(app: App, w: Webinar, at = nowOf(app)): number {
  return Number(app.db.get<{ n: number }>(`SELECT COUNT(*) n FROM webinar_registrations WHERE webinar_id = ? AND status = 'registered' AND last_seen_at >= ? AND first_off IS NOT NULL AND session_start <= ?`, w.id, new Date(at.getTime() - PRESENCE_MS).toISOString(), at.toISOString())?.n ?? 0);
}

// --- the offer --------------------------------------------------------------------------------------

/** When the offer closes for this registration (ms), or null when it has no deadline. The deadline is real. */
export function offerDeadline(w: Webinar, reg: Registration): number | null {
  const o = w.settings.offer;
  return o.countdown_s > 0 ? startMs(reg) + (o.at_s + o.countdown_s) * 1000 : null;
}

/** The address of the offer for this viewer, or undefined when the offer is off. */
export function offerTarget(app: App, w: Webinar, contactEmail: string): string | undefined {
  const t = w.settings.offer.target;
  if (t.type === 'url') return t.url || undefined;
  if (t.type === 'form') return t.form_id && app.db.get('SELECT id FROM forms WHERE id = ? AND location_id = ?', t.form_id, w.location_id) ? `${app.baseUrl()}/f/${encodeURIComponent(t.form_id)}` : undefined;
  const p = t.product_id ? app.db.get<{ id: string }>('SELECT id FROM products WHERE id = ? AND location_id = ? AND active = 1', t.product_id, w.location_id) : undefined;
  if (!p) return undefined;
  const slug = app.services.stripeBuy?.linkOf?.(p.id)?.slug as string | undefined;
  return `${app.baseUrl()}/buy/${encodeURIComponent(slug || p.id)}${contactEmail ? `?email=${encodeURIComponent(contactEmail)}` : ''}`;
}

/** A click on the offer button: counted, tagged, put on the timeline. Returns where to go, or says why not. */
export function ctaClick(app: App, w: Webinar, reg: Registration, at = nowOf(app)): { url?: string; expired?: boolean } {
  const o = w.settings.offer;
  if (!o.enabled) return {};
  const deadline = offerDeadline(w, reg);
  if (deadline !== null && at.getTime() > deadline) return { expired: true };
  const contact = getContact(app, w.location_id, reg.contact_id);
  const url = offerTarget(app, w, contact?.email ?? '');
  if (!url) return {};
  const first = !reg.cta_clicked_at;
  app.db.run('UPDATE webinar_registrations SET cta_clicked_at = COALESCE(cta_clicked_at, ?), cta_clicks = cta_clicks + 1 WHERE id = ?', at.toISOString(), reg.id);
  if (first) {
    note(app, w, reg, 'webinar.cta_clicked', `Angebot im Webinar „${w.title}“ angeklickt${o.title ? `: ${o.title}` : ''}`, w.settings.tags.cta);
    emit(app, w, reg, 'webinar.cta_clicked', { offer: { title: o.title, url } });
  }
  return { url };
}

/** A purchase of the offer's product by somebody who clicked the button in the last 14 days belongs to that webinar. */
export function attributePurchase(app: App, locationId: string, d: { contactId?: string; productId?: string; amount_cents?: number }): boolean {
  if (!d.contactId || !d.productId) return false;
  const rows = app.db.all<Registration>(
    `SELECT * FROM webinar_registrations WHERE location_id = ? AND contact_id = ? AND cta_clicked_at IS NOT NULL AND cta_clicked_at >= ? ORDER BY cta_clicked_at DESC LIMIT 10`,
    locationId,
    d.contactId,
    new Date(nowOf(app).getTime() - 14 * 86_400_000).toISOString(),
  );
  for (const reg of rows) {
    const w = getWebinar(app, { id: reg.webinar_id }, locationId);
    const t = w?.settings.offer.target;
    if (!w || t?.type !== 'product' || t.product_id !== d.productId) continue;
    const cents = Math.max(0, Math.round(Number(d.amount_cents) || 0));
    app.db.run('UPDATE webinar_registrations SET purchased_at = COALESCE(purchased_at, ?), purchase_cents = purchase_cents + ?, purchase_count = purchase_count + 1 WHERE id = ?', nowOf(app).toISOString(), cents, reg.id);
    note(app, w, reg, 'webinar.purchased', `Nach dem Webinar „${w.title}“ gekauft (${(cents / 100).toFixed(2).replace('.', ',')} €)`, w.settings.tags.purchased, { amount_cents: cents });
    return true;
  }
  return false;
}

// --- questions and polls ----------------------------------------------------------------------------

/** An attendee's question: stored with the webinar and put into the sub-account's conversations (channel Chat). */
export function askQuestion(app: App, w: Webinar, reg: Registration, body: string, at = nowOf(app)): { id: string } {
  if (!w.settings.room.questions) throw new HttpError(403, 'Fragen sind für dieses Webinar ausgeschaltet');
  const text = body.replace(/\s+/g, ' ').trim();
  if (!text) throw bad('Bitte eine Frage eingeben');
  if (text.length > 1000) throw bad('Die Frage ist zu lang (höchstens 1000 Zeichen)');
  const recent = app.db.get<{ n: number; last: string | null }>('SELECT COUNT(*) n, MAX(created_at) last FROM webinar_questions WHERE registration_id = ?', reg.id)!;
  if (Number(recent.n) >= 10) throw new HttpError(429, 'Du hast schon viele Fragen gestellt – das Team meldet sich bei dir');
  if (recent.last && at.getTime() - Date.parse(recent.last) < 4000) throw new HttpError(429, 'Bitte einen Moment warten, bevor du die nächste Frage stellst');
  const contact = getContact(app, w.location_id, reg.contact_id);
  if (!contact) throw new HttpError(404, 'Kontakt nicht gefunden');
  const conversationId = getOrCreateConversation(app, w.location_id, contact.id);
  const msg = { id: newId(), location_id: w.location_id, conversation_id: conversationId, contact_id: contact.id, channel: 'chat', direction: 'in', subject: `Webinar-Frage: ${w.title}`.slice(0, 200), body: text, status: 'received', error: '', source: 'Webinar', created_at: new Date().toISOString() };
  app.db.insert('messages', msg);
  app.db.run('UPDATE conversations SET last_message_at = ?, last_message = ?, unread = unread + 1 WHERE id = ?', msg.created_at, text.slice(0, 140), conversationId);
  const c = clockFor(w, reg, at);
  const q = { id: newId(), location_id: w.location_id, webinar_id: w.id, registration_id: reg.id, contact_id: contact.id, session_start: reg.session_start, offset_s: c.state === 'running' ? c.offset_s : null, body: text, message_id: msg.id, created_at: at.toISOString() };
  app.db.insert('webinar_questions', q);
  logActivity(app, w.location_id, contact.id, 'webinar.question', `Frage im Webinar „${w.title}“: ${text.slice(0, 120)}`, { webinar_id: w.id });
  app.events.emit(w.location_id, 'message.inbound', { contactId: contact.id, contact, message: msg });
  return { id: q.id };
}

/** The viewer's questions and the team's answers (chat messages the team wrote to this contact since the first question). */
export function conversationOf(app: App, w: Webinar, reg: Registration) {
  const questions = app.db.all<{ id: string; body: string; created_at: string }>('SELECT id, body, created_at FROM webinar_questions WHERE registration_id = ? ORDER BY created_at', reg.id);
  if (!questions.length) return { questions: [], answers: [] as { body: string; created_at: string }[] };
  // The time of the first question as the inbox knows it (the messages carry the server's real clock).
  const since = app.db.get<{ created_at: string }>('SELECT m.created_at FROM webinar_questions q JOIN messages m ON m.id = q.message_id WHERE q.registration_id = ? ORDER BY q.created_at LIMIT 1', reg.id)?.created_at ?? questions[0].created_at;
  const answers = app.db.all<{ body: string; created_at: string }>(`SELECT body, created_at FROM messages WHERE location_id = ? AND contact_id = ? AND channel = 'chat' AND direction = 'out' AND created_at >= ? ORDER BY created_at LIMIT 50`, w.location_id, reg.contact_id, since);
  return { questions, answers };
}

/** One answer of a viewer to a poll; changing the mind is not possible (the result would not mean anything). */
export function vote(app: App, w: Webinar, reg: Registration, pollId: string, choice: unknown): { counts: number[]; mine: number[] } {
  const poll = w.settings.room.polls.find((p) => p.id === pollId);
  if (!poll) throw new HttpError(404, 'Umfrage nicht gefunden');
  const picked = [...new Set((Array.isArray(choice) ? choice : [choice]).map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n < poll.options.length);
  if (!picked.length) throw bad('Bitte eine Antwort wählen');
  if (!poll.multiple && picked.length > 1) throw bad('Bei dieser Umfrage ist nur eine Antwort möglich');
  const first = app.db.run('INSERT OR IGNORE INTO webinar_votes (registration_id, poll_id, webinar_id, location_id, choice, created_at) VALUES (?, ?, ?, ?, ?, ?)', reg.id, poll.id, w.id, w.location_id, JSON.stringify(picked), nowOf(app).toISOString()).changes > 0;
  if (first) logActivity(app, w.location_id, reg.contact_id, 'webinar.poll', `Umfrage im Webinar „${w.title}“: ${poll.question.slice(0, 80)} → ${picked.map((i) => poll.options[i]).join(', ')}`, { webinar_id: w.id, poll_id: poll.id });
  return pollCounts(app, w, poll.id, reg.id);
}

export function pollCounts(app: App, w: Webinar, pollId: string, regId?: string): { counts: number[]; mine: number[] } {
  const poll = w.settings.room.polls.find((p) => p.id === pollId);
  const counts = (poll?.options ?? []).map(() => 0);
  let mine: number[] = [];
  for (const r of app.db.all<{ registration_id: string; choice: string }>('SELECT registration_id, choice FROM webinar_votes WHERE webinar_id = ? AND poll_id = ?', w.id, pollId)) {
    let picked: number[] = [];
    try {
      picked = JSON.parse(r.choice);
    } catch {
      /* skip */
    }
    for (const i of picked) if (i >= 0 && i < counts.length) counts[i]++;
    if (r.registration_id === regId) mine = picked;
  }
  return { counts, mine };
}

// --- end of a session ----------------------------------------------------------------------------------

/**
 * Books the sessions that ended: who was there gets their final watch share (and `webinar.watched_percent`), who never came
 * is "missed" (`webinar.missed`, tag). Runs every tick; each registration is booked exactly once.
 */
export async function finalizeDue(app: App, at = nowOf(app)): Promise<number> {
  const rows = app.db.all<Registration>(
    `SELECT r.* FROM webinar_registrations r WHERE r.finalized_at IS NULL AND r.status = 'registered' AND r.session_start <= ? ORDER BY r.session_start LIMIT 300`,
    at.toISOString(),
  );
  let n = 0;
  const pause = sliceTimer(40);
  const cache = new Map<string, Webinar | undefined>();
  for (const reg of rows) {
    await pause();
    if (!cache.has(reg.webinar_id)) cache.set(reg.webinar_id, getWebinar(app, { id: reg.webinar_id }));
    const w = cache.get(reg.webinar_id);
    if (!w || w.location_id !== reg.location_id) continue;
    if (at.getTime() < Date.parse(sessionEnd(reg.session_start, w.duration_s)) + FINALIZE_AFTER_MS) continue;
    // Claim it: a second tick (or process) must not book it again.
    const claimed = app.db.run('UPDATE webinar_registrations SET finalized_at = ?, left_at = COALESCE(last_seen_at, left_at) WHERE id = ? AND finalized_at IS NULL', at.toISOString(), reg.id).changes > 0;
    if (!claimed) continue;
    n++;
    const fresh = getRegistration(app, reg.id)!;
    if (fresh.attended_at) {
      const reached = clock(fresh.last_off ?? 0);
      note(app, w, fresh, 'webinar.watched', `Webinar „${w.title}“: ${fresh.watch_pct} % gesehen (bis ${reached} Min.)`, [], { percent: fresh.watch_pct, watched_s: Math.round(fresh.watched_s), left_at: fresh.left_at });
      emit(app, w, fresh, 'webinar.watched_percent', { percent: fresh.watch_pct, watched_s: Math.round(fresh.watched_s), left_at: fresh.left_at });
    } else {
      note(app, w, fresh, 'webinar.missed', `Webinar „${w.title}“ verpasst`, w.settings.tags.missed);
      emit(app, w, fresh, 'webinar.missed');
    }
  }
  return n;
}

