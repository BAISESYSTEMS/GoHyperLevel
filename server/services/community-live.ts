import type { App } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { now, token } from '../core/util.js';
import { logActivity } from './contacts.js';
import { portalUrl } from './courses.js';
import { award } from './community-actions.js';
import { extOf } from './community-ext.js';

/**
 * Live calls: a calendar event with a Jitsi room (the public meet.jit.si or your own server) that opens inside the member area.
 * Joining counts as attendance (points once per call, an event for workflows, a line in the timeline); afterwards the recording
 * can be attached as a post. The room name is random and only shown to members while the call is on.
 */

export interface EventExt {
  event_id: string;
  group_id: string;
  location_id: string;
  live: number;
  room: string;
  recording_post_id: string;
  reminded_at: string | null;
}

export const OPEN_BEFORE_MIN = 15;
export const OPEN_AFTER_MIN = 180;

/** The Jitsi server of a group: its own setting, else PGHL_JITSI_URL, else the public one. */
export function jitsiBase(app: App, g: Record<string, any>): string {
  const own = extOf(app, g.id).live.jitsi_url;
  const env = String(process.env.PGHL_JITSI_URL ?? '').trim().replace(/\/+$/, '');
  const url = own || (/^https:\/\/[^/\s]+$/i.test(env) ? env : '') || 'https://meet.jit.si';
  return new URL(url).origin;
}

export const roomName = (title: string) => `${title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'call'}-${token(8).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 10)}`;

export const extOfEvent = (app: App, eventId: string) => app.db.get<EventExt>('SELECT * FROM community_event_ext WHERE event_id = ?', eventId);

export function livePath(app: App, g: { slug: string; location_id: string }, eventId: string) {
  return `${portalUrl(app, g.location_id)}/community/g/${encodeURIComponent(g.slug)}/live/${encodeURIComponent(eventId)}`;
}

/** Makes an event a live call: random room, and the event's link leads into the member area. */
export function enableLive(app: App, g: any, ev: { id: string; title: string }): EventExt {
  const cur = extOfEvent(app, ev.id);
  const room = cur?.room || roomName(ev.title);
  app.db.run(
    `INSERT INTO community_event_ext (event_id, group_id, location_id, live, room, recording_post_id) VALUES (?, ?, ?, 1, ?, '')
     ON CONFLICT(event_id) DO UPDATE SET live = 1, room = excluded.room`,
    ev.id,
    g.id,
    g.location_id,
    room,
  );
  app.db.run('UPDATE community_events SET link = ?, updated_at = ? WHERE id = ?', livePath(app, g, ev.id), now(), ev.id);
  return extOfEvent(app, ev.id)!;
}

export function disableLive(app: App, g: any, ev: { id: string; link?: string }) {
  app.db.run('UPDATE community_event_ext SET live = 0 WHERE event_id = ?', ev.id);
  if (ev.link && ev.link === livePath(app, g, ev.id)) app.db.run(`UPDATE community_events SET link = '', updated_at = ? WHERE id = ?`, now(), ev.id);
}

export type Phase = 'before' | 'on' | 'after';
export function phaseOf(ev: { starts_at: string; ends_at: string }, at = Date.now()): Phase {
  if (at < Date.parse(ev.starts_at) - OPEN_BEFORE_MIN * 60_000) return 'before';
  if (at > Date.parse(ev.ends_at) + OPEN_AFTER_MIN * 60_000) return 'after';
  return 'on';
}

/** Joining a call: attendance once per person, points once, workflow event. Returns true on the first time. */
export function recordAttendance(app: App, g: any, ev: { id: string; title: string }, contactId: string): boolean {
  const r = app.db.run('INSERT OR IGNORE INTO community_event_attendance (event_id, group_id, contact_id, location_id, joined_at) VALUES (?, ?, ?, ?, ?)', ev.id, g.id, contactId, g.location_id, now());
  if (!r.changes) return false;
  const pts = extOf(app, g.id).points.event;
  if (pts) award(app, g, contactId, pts, 'event', ev.id);
  logActivity(app, g.location_id, contactId, 'community.event_attended', `Live-Call „${ev.title}“ besucht`);
  app.events.emit(g.location_id, 'community.event_attended', { contactId, groupId: g.id, group: { id: g.id, name: g.name }, event: { id: ev.id, title: ev.title } });
  return true;
}

/** The address shown in the iframe: room, subject and the member's name (Jitsi reads JSON values after the #). */
export function jitsiUrl(base: string, room: string, subject: string, name: string): string {
  const j = (v: string) => encodeURIComponent(JSON.stringify(v));
  return `${base}/${encodeURIComponent(room)}#config.subject=${j(subject)}&userInfo.displayName=${j(name)}&config.disableDeepLinking=true`;
}

export function mustEvent(app: App, locationId: string, eventId: string) {
  const e = app.db.get<any>('SELECT * FROM community_events WHERE id = ? AND location_id = ?', eventId, locationId);
  if (!e) throw new HttpError(404, 'Termin nicht gefunden');
  return e as { id: string; location_id: string; group_id: string; title: string; description: string; starts_at: string; ends_at: string; link: string };
}
