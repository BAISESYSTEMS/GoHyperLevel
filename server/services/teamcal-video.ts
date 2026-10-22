import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import type { CalendarRow } from '../modules/calendars.js';
import { googleEventId, toGoogleEvent, toGraphEvent, type EventInput } from './calendar-providers.js';
import type { Video } from './teamcal-model.js';

/**
 * Automatic video links for booked appointments:
 * - Google Meet: the host's connected Google calendar (OAuth, "Mein Konto") gets the event with a Meet room;
 * - Microsoft Teams: the host's connected Outlook calendar gets the event as a Teams meeting (Microsoft Graph);
 * - Zoom: the Zoom connector of the sub-account (Apps → Direkt-Verbindungen) creates the meeting;
 * - fixed place or link: the calendar's "Ort / Meeting-Link".
 * The events are made with the same ids the calendar sync uses, so a calendar that is linked for two-way sync adopts the event
 * instead of creating a second one. Every call has a timeout; a missing connection is a message, never a failed booking.
 */

const GOOGLE = 'https://www.googleapis.com/calendar/v3';
const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface VideoRef {
  provider: 'meet' | 'teams' | 'zoom';
  connection_id?: string;
  calendar_id?: string;
  event_id?: string;
}
export type VideoResult = { url: string; ref?: VideoRef } | { pending: true; ref: VideoRef } | { error: string };

interface Conn {
  id: string;
  provider: 'google' | 'microsoft';
  user_id: string;
  settings: Record<string, any>;
}

/** The first host who connected a calendar of this provider (and still has working access). */
function connectionOf(app: App, hosts: string[], provider: 'google' | 'microsoft'): Conn | undefined {
  for (const uid of hosts) {
    const c = parseJson(app.db.get<any>(`SELECT * FROM oauth_connections WHERE purpose = 'calendar' AND provider = ? AND user_id = ? AND status = 'ok'`, provider, uid), ['settings']) as Conn | undefined;
    if (c) return c;
  }
  return undefined;
}

const sleep = (app: App, ms: number): Promise<void> => (app.services.teamcalSleep ? app.services.teamcalSleep(ms) : new Promise((r) => setTimeout(r, ms)));

async function call(app: App, conn: Conn, url: string, init: { method?: string; body?: unknown } = {}, allow: number[] = []): Promise<{ status: number; json: any }> {
  const fetcher: typeof fetch = app.services.oauth.fetcher();
  for (let attempt = 0; attempt < 2; attempt++) {
    const token: string = await app.services.oauth.token(conn.id, attempt > 0);
    const r = await fetcher(url, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 401 && attempt === 0) continue;
    const json = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (r.ok || allow.includes(r.status)) return { status: r.status, json };
    throw new Error(String(json?.error?.message ?? json?.error_description ?? `Fehler ${r.status}`).slice(0, 200));
  }
  throw new Error('Anmeldung abgelehnt');
}

const meetLink = (ev: any): string => String(ev?.hangoutLink || (ev?.conferenceData?.entryPoints ?? []).find((e: any) => e.entryPointType === 'video')?.uri || '');

function eventInput(app: App, conn: Conn, appt: any, cal: CalendarRow, description: string): EventInput {
  return { title: appt.title, description, location: '', start: appt.start_at, end: appt.end_at, appointmentId: appt.id, key: `${conn.id}:${appt.id}` };
}

async function meet(app: App, appt: any, cal: CalendarRow, hosts: string[], description: string): Promise<VideoResult> {
  const conn = connectionOf(app, hosts, 'google');
  if (!conn) return { error: 'Kein Gastgeber hat einen Google-Kalender verbunden (Einstellungen → Mein Konto)' };
  const calendarId = String(conn.settings.target_calendar || 'primary');
  const input = eventInput(app, conn, appt, cal, description);
  const eventId = googleEventId(input.key);
  const base = `${GOOGLE}/calendars/${encodeURIComponent(calendarId)}/events`;
  const conference = { conferenceData: { createRequest: { requestId: appt.id, conferenceSolutionKey: { type: 'hangoutsMeet' } } } };
  const ref: VideoRef = { provider: 'meet', connection_id: conn.id, calendar_id: calendarId, event_id: eventId };
  let r = await call(app, conn, `${base}?conferenceDataVersion=1&sendUpdates=none`, { method: 'POST', body: { ...toGoogleEvent(input), ...conference } }, [409]);
  // 409: the sync created the event first (same id) – add the room to it.
  if (r.status === 409) r = await call(app, conn, `${base}/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=none`, { method: 'PATCH', body: conference });
  let url = meetLink(r.json);
  // The room is made a moment after the event: ask again a few times.
  for (let i = 0; !url && i < 3; i++) {
    await sleep(app, 700 * (i + 1));
    const g = await call(app, conn, `${base}/${encodeURIComponent(eventId)}?conferenceDataVersion=1`, {}, [404]);
    url = meetLink(g.json);
  }
  return url ? { url, ref } : { pending: true, ref };
}

async function teams(app: App, appt: any, cal: CalendarRow, hosts: string[], description: string): Promise<VideoResult> {
  const conn = connectionOf(app, hosts, 'microsoft');
  if (!conn) return { error: 'Kein Gastgeber hat einen Outlook-Kalender verbunden (Einstellungen → Mein Konto)' };
  const calendarId = String(conn.settings.target_calendar || '');
  const input = eventInput(app, conn, appt, cal, description);
  const url = calendarId ? `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/events` : `${GRAPH}/me/events`;
  const r = await call(app, conn, url, { method: 'POST', body: { ...toGraphEvent(input), isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } });
  const link = String(r.json?.onlineMeeting?.joinUrl || r.json?.onlineMeetingUrl || '');
  const ref: VideoRef = { provider: 'teams', connection_id: conn.id, calendar_id: calendarId, event_id: String(r.json?.id ?? '') };
  return link ? { url: link, ref } : { error: 'Microsoft hat keinen Teams-Link geliefert (Konto ohne Teams-Lizenz?)' };
}

async function zoom(app: App, appt: any, cal: CalendarRow): Promise<VideoResult> {
  const run = app.services.workflowActions?.zoom_create_meeting;
  if (!run || !app.services.connectorConfig?.(cal.location_id, 'zoom')) return { error: 'Zoom ist nicht eingerichtet (Apps → Direkt-Verbindungen → Zoom)' };
  const out: any = await run({ id: `teamcal-${appt.id}`, location_id: cal.location_id, contact_id: appt.contact_id ?? '' }, { topic: cal.name, when: 'at', date: appt.start_at, time: '', duration: cal.duration, waiting_room: true }, {});
  const url = String(out?.vars?.zoom_join_url ?? out?.output?.join_url ?? '');
  return url ? { url, ref: { provider: 'zoom', event_id: String(out?.vars?.zoom_meeting_id ?? '') } } : { error: 'Zoom hat keinen Beitrittslink geliefert' };
}

/** Makes the video link of an appointment by the calendar's setting; `description` is the event text (contact, answers). */
export async function createVideo(app: App, kind: Video, appt: any, cal: CalendarRow, hosts: string[], description: string): Promise<VideoResult> {
  try {
    if (kind === 'static') return cal.settings.meeting_location ? { url: String(cal.settings.meeting_location) } : { error: 'Kein fester Ort / Link eingetragen' };
    if (kind === 'meet') return await meet(app, appt, cal, hosts, description);
    if (kind === 'teams') return await teams(app, appt, cal, hosts, description);
    if (kind === 'zoom') return await zoom(app, appt, cal);
    return { error: '' };
  } catch (e) {
    return { error: `${kind === 'meet' ? 'Google Meet' : kind === 'teams' ? 'Microsoft Teams' : 'Zoom'}: ${(e as Error).message}` };
  }
}

/** A Meet room that was still being made: asks once more. */
export async function resolvePending(app: App, appt: any): Promise<string> {
  const ref: VideoRef | undefined = typeof appt.video_ref === 'string' ? JSON.parse(appt.video_ref || 'null') : appt.video_ref;
  if (!ref || ref.provider !== 'meet' || !ref.connection_id || !ref.event_id) return '';
  const conn = parseJson(app.db.get<any>(`SELECT * FROM oauth_connections WHERE id = ? AND status = 'ok'`, ref.connection_id), ['settings']) as Conn | undefined;
  if (!conn) return '';
  const g = await call(app, conn, `${GOOGLE}/calendars/${encodeURIComponent(ref.calendar_id || 'primary')}/events/${encodeURIComponent(ref.event_id)}?conferenceDataVersion=1`, {}, [404]);
  return meetLink(g.json);
}

/** A moved appointment: the event made here moves with it (events adopted by the sync are moved by the sync). */
export async function moveVideo(app: App, appt: any): Promise<void> {
  const ref: VideoRef | undefined = typeof appt.video_ref === 'string' ? JSON.parse(appt.video_ref || 'null') : appt.video_ref;
  if (!ref?.connection_id || !ref.event_id) return;
  const conn = parseJson(app.db.get<any>(`SELECT * FROM oauth_connections WHERE id = ? AND status = 'ok'`, ref.connection_id), ['settings']) as Conn | undefined;
  if (!conn) return;
  if (ref.provider === 'meet') await call(app, conn, `${GOOGLE}/calendars/${encodeURIComponent(ref.calendar_id || 'primary')}/events/${encodeURIComponent(ref.event_id)}?sendUpdates=none`, { method: 'PATCH', body: { start: { dateTime: appt.start_at }, end: { dateTime: appt.end_at } } }, [404, 410]);
  else if (ref.provider === 'teams') await call(app, conn, `${GRAPH}/me/events/${encodeURIComponent(ref.event_id)}`, { method: 'PATCH', body: { start: { dateTime: appt.start_at.replace(/\.\d{3}Z$/, '').replace(/Z$/, ''), timeZone: 'UTC' }, end: { dateTime: appt.end_at.replace(/\.\d{3}Z$/, '').replace(/Z$/, ''), timeZone: 'UTC' } } }, [404]);
}

/** A cancelled appointment: the event made here is removed. */
export async function removeVideo(app: App, appt: any): Promise<void> {
  const ref: VideoRef | undefined = typeof appt.video_ref === 'string' ? JSON.parse(appt.video_ref || 'null') : appt.video_ref;
  if (!ref?.connection_id || !ref.event_id) return;
  const conn = parseJson(app.db.get<any>(`SELECT * FROM oauth_connections WHERE id = ? AND status = 'ok'`, ref.connection_id), ['settings']) as Conn | undefined;
  if (!conn) return;
  if (ref.provider === 'meet') await call(app, conn, `${GOOGLE}/calendars/${encodeURIComponent(ref.calendar_id || 'primary')}/events/${encodeURIComponent(ref.event_id)}?sendUpdates=none`, { method: 'DELETE' }, [404, 410]);
  else if (ref.provider === 'teams') await call(app, conn, `${GRAPH}/me/events/${encodeURIComponent(ref.event_id)}`, { method: 'DELETE' }, [404]);
}
