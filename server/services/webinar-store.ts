import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { formatInTz, isValidTz } from '../core/time.js';
import { DEFAULT_SCHEDULE, zoneOf, type Schedule } from './webinar-schedule.js';
import { defaultSettings, joinToken, type WebinarSettings } from './webinar-model.js';
import { NO_VIDEO, type VideoSource } from './webinar-video.js';

/** Rows of the webinar tables, parsed, with the defaults of settings that were added after a webinar was saved. */

export interface Webinar {
  id: string;
  location_id: string;
  slug: string;
  title: string;
  description: string;
  presenter_name: string;
  presenter_photo: string;
  video: VideoSource;
  duration_s: number;
  status: 'draft' | 'published';
  schedule: Schedule;
  settings: WebinarSettings;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Registration {
  id: string;
  location_id: string;
  webinar_id: string;
  contact_id: string;
  session_start: string;
  session_kind: string;
  tz: string;
  source: string;
  status: 'registered' | 'cancelled';
  consent_at: string | null;
  sms_consent: number;
  attended_at: string | null;
  first_off: number | null;
  last_off: number | null;
  watched_s: number;
  watch_pct: number;
  last_seen_at: string | null;
  left_at: string | null;
  finalized_at: string | null;
  cta_clicked_at: string | null;
  cta_clicks: number;
  purchased_at: string | null;
  purchase_cents: number;
  purchase_count: number;
  replay_at: string | null;
  replay_pos_s: number;
  replay_watched_s: number;
  created_at: string;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Objects merge key by key, everything else (lists, scalars) comes from `over` when it is there. */
function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : (over as T)) as T;
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
  return out as T;
}

export function parseWebinar(row: any): Webinar {
  parseJson(row, ['video', 'schedule', 'settings']);
  return { ...row, video: isObj(row.video) ? row.video : NO_VIDEO, schedule: merge(DEFAULT_SCHEDULE, row.schedule), settings: merge(defaultSettings(), row.settings) } as Webinar;
}

/** A webinar by id or slug; with `locationId` only when it belongs to that sub-account. */
export function getWebinar(app: App, key: { id?: string; slug?: string }, locationId?: string): Webinar | undefined {
  const row = key.id ? app.db.get('SELECT * FROM webinars WHERE id = ?' + (locationId ? ' AND location_id = ?' : ''), key.id, ...(locationId ? [locationId] : [])) : app.db.get('SELECT * FROM webinars WHERE slug = ?' + (locationId ? ' AND location_id = ?' : ''), String(key.slug ?? '').slice(0, 100), ...(locationId ? [locationId] : []));
  return row ? parseWebinar(row) : undefined;
}

export const getRegistration = (app: App, id: string): Registration | undefined => app.db.get<Registration>('SELECT * FROM webinar_registrations WHERE id = ?', id);

export const locationTz = (app: App, locationId: string) => app.location(locationId)?.timezone || 'Europe/Berlin';
/** The zone the webinar's own times are in. */
export const webinarTz = (app: App, w: Webinar) => zoneOf(w.schedule, locationTz(app, w.location_id));

// --- addresses ------------------------------------------------------------------------------------

export interface WebinarUrls {
  page: string;
  embed: string;
}
export const pageUrl = (app: App, w: Pick<Webinar, 'slug'>) => `${app.baseUrl()}/w/${encodeURIComponent(w.slug)}`;
export function urlsOf(app: App, w: Pick<Webinar, 'slug'>): WebinarUrls {
  const page = pageUrl(app, w);
  return { page, embed: `<iframe src="${page}?embed=1" style="width:100%;border:0;min-height:640px" id="pghl-w-${w.slug}" title="Webinar-Anmeldung"></iframe><script>addEventListener('message',function(e){if(e.data&&e.data.pghlHeight&&e.source===document.getElementById('pghl-w-${w.slug}').contentWindow){document.getElementById('pghl-w-${w.slug}').style.height=e.data.pghlHeight+'px'}})</script>` };
}

/** The links of one registration (all carry the signed token). */
export function linksOf(app: App, w: Pick<Webinar, 'slug'>, regId: string) {
  const t = encodeURIComponent(joinToken(app.config.secret, regId));
  const base = pageUrl(app, w);
  return { join_url: `${base}/watch?t=${t}`, replay_url: `${base}/replay?t=${t}`, ics_url: `${base}/ics?t=${t}`, cancel_url: `${base}/cancel?t=${t}` };
}

// --- text -----------------------------------------------------------------------------------------

/** "Donnerstag, 5. November 2026 um 19:00 MEZ" in the viewer's zone. */
export function whenText(startIso: string, tz: string): string {
  const zone = isValidTz(tz) ? tz : 'Europe/Berlin';
  return formatInTz(startIso, zone, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}
export function timeText(startIso: string, tz: string): string {
  const zone = isValidTz(tz) ? tz : 'Europe/Berlin';
  return formatInTz(startIso, zone, { weekday: undefined, day: undefined, month: undefined, year: undefined, hour: '2-digit', minute: '2-digit' });
}
export const clock = (s: number) => {
  const n = Math.max(0, Math.round(s));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const sec = n % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
