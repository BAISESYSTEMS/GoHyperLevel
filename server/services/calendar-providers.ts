import { createHash } from 'node:crypto';
import { isValidTz, zonedToUtc } from '../core/time.js';
import type { Provider } from './oauth.js';

/**
 * Google Calendar API v3 and Microsoft Graph behind one small interface: list calendars, busy times,
 * create/patch/delete an event, read one, and incremental changes (Google syncToken, Graph delta link).
 * Every call has a timeout; a 401 refreshes the token once and retries.
 */

export interface ExtCalendar {
  id: string;
  name: string;
  primary: boolean;
  can_write: boolean;
  color: string;
}
export interface ExtEvent {
  id: string;
  cancelled: boolean;
  start: string;
  end: string;
  updated: string;
  etag: string;
  /** Appointment id we stored on the event (Google private property / Graph extended property). */
  appointmentId?: string;
}
export interface EventInput {
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  appointmentId: string;
  /** Stable per connection + appointment: makes creating idempotent across retries. */
  key: string;
}
export interface Busy {
  start_at: string;
  end_at: string;
}
export interface ChangeSet {
  events: ExtEvent[];
  cursor: string;
  /** The old cursor was no longer valid and a full listing was done. */
  reset: boolean;
}
export interface CalendarApi {
  listCalendars(): Promise<ExtCalendar[]>;
  busy(calendarIds: string[], from: string, to: string, ownEventIds?: Set<string>): Promise<Busy[]>;
  get(calendarId: string, eventId: string): Promise<ExtEvent | null>;
  create(calendarId: string, input: EventInput): Promise<ExtEvent>;
  patch(calendarId: string, eventId: string, input: EventInput, etag?: string): Promise<ExtEvent>;
  remove(calendarId: string, eventId: string): Promise<void>;
  changes(calendarId: string, cursor: string | null, window: { from: string; to: string }): Promise<ChangeSet>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
/** If-Match failed: the event was changed on the other side since we last wrote it. */
export class PreconditionFailed extends ProviderError {}

type TokenFn = (force?: boolean) => Promise<string>;
type Json = Record<string, any>;

const iso = (s: unknown) => {
  const t = Date.parse(String(s ?? ''));
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
};

async function request(label: string, fetcher: typeof fetch, token: TokenFn, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}, allow: number[] = []) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await token(attempt > 0);
    let r: Response;
    try {
      r = await fetcher(url, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${t}`, accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new ProviderError(`${label} nicht erreichbar: ${(e as Error).message}`, 0);
    }
    if (r.status === 401 && attempt === 0) continue;
    const json: Json = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (r.ok || allow.includes(r.status)) return { status: r.status, json };
    const msg = String(json?.error?.message ?? json?.error_description ?? `Fehler ${r.status}`).slice(0, 300);
    if (r.status === 412) throw new PreconditionFailed(`${label}: Termin wurde dort inzwischen geändert`, 412);
    throw new ProviderError(`${label}: ${msg}`, r.status);
  }
  throw new ProviderError(`${label}: Anmeldung abgelehnt`, 401);
}

// --- Google ------------------------------------------------------------------------

const GOOGLE = 'https://www.googleapis.com/calendar/v3';
const B32HEX = '0123456789abcdefghijklmnopqrstuv';

/** A Google event id (base32hex, 5–1024 chars) derived from `key`, so a retried create can't duplicate. */
export function googleEventId(key: string): string {
  const bytes = createHash('sha256').update(key).digest();
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `pghl${out.slice(0, 40)}`;
}

export function toGoogleEvent(i: EventInput, withId = true): Json {
  return {
    ...(withId ? { id: googleEventId(i.key) } : {}),
    summary: i.title,
    description: i.description,
    location: i.location || undefined,
    start: { dateTime: i.start },
    end: { dateTime: i.end },
    status: 'confirmed',
    transparency: 'opaque',
    extendedProperties: { private: { pghl_appt: i.appointmentId } },
  };
}

export function fromGoogleEvent(ev: Json): ExtEvent {
  const when = (x: Json | undefined) => (x?.dateTime ? iso(x.dateTime) : x?.date ? `${x.date}T00:00:00.000Z` : '');
  return {
    id: String(ev.id ?? ''),
    cancelled: ev.status === 'cancelled',
    start: when(ev.start),
    end: when(ev.end),
    updated: iso(ev.updated),
    etag: String(ev.etag ?? ''),
    appointmentId: ev.extendedProperties?.private?.pghl_appt ? String(ev.extendedProperties.private.pghl_appt) : undefined,
  };
}

const EVENT_FIELDS = 'id,status,start,end,updated,etag,extendedProperties';

export function googleCalendar(fetcher: typeof fetch, token: TokenFn): CalendarApi {
  const req = (url: string, init?: Parameters<typeof request>[4], allow?: number[]) => request('Google Kalender', fetcher, token, url, init, allow);
  const cal = (id: string) => `${GOOGLE}/calendars/${encodeURIComponent(id)}`;
  return {
    async listCalendars() {
      const out: ExtCalendar[] = [];
      let page = '';
      for (let i = 0; i < 5; i++) {
        const q = new URLSearchParams({ minAccessRole: 'freeBusyReader', maxResults: '250', ...(page ? { pageToken: page } : {}) });
        const { json } = await req(`${GOOGLE}/users/me/calendarList?${q}`);
        for (const c of json.items ?? []) out.push({ id: String(c.id), name: String(c.summaryOverride || c.summary || c.id).slice(0, 200), primary: !!c.primary, can_write: ['owner', 'writer'].includes(c.accessRole), color: String(c.backgroundColor ?? '') });
        page = json.nextPageToken ?? '';
        if (!page) break;
      }
      return out;
    },
    async busy(ids, from, to) {
      if (!ids.length) return [];
      const out: Busy[] = [];
      // freeBusy answers best for shorter ranges: ask in 60-day pieces.
      for (let a = Date.parse(from); a < Date.parse(to); a += 60 * 864e5) {
        const b = Math.min(a + 60 * 864e5, Date.parse(to));
        const { json } = await req(`${GOOGLE}/freeBusy`, { method: 'POST', body: { timeMin: new Date(a).toISOString(), timeMax: new Date(b).toISOString(), items: ids.slice(0, 50).map((id) => ({ id })) } });
        const cals = Object.values(json.calendars ?? {}) as Json[];
        if (cals.length && cals.every((c) => c.errors?.length)) throw new ProviderError(`Google Kalender: ${cals[0].errors[0]?.reason ?? 'Kalender nicht lesbar'}`, 400);
        for (const c of cals) for (const x of c.busy ?? []) if (iso(x.start) && iso(x.end)) out.push({ start_at: iso(x.start), end_at: iso(x.end) });
      }
      return out;
    },
    async get(calId, eventId) {
      const { status, json } = await req(`${cal(calId)}/events/${encodeURIComponent(eventId)}?fields=${EVENT_FIELDS}`, {}, [404, 410]);
      return status === 200 ? fromGoogleEvent(json) : null;
    },
    async create(calId, input) {
      const { status, json } = await req(`${cal(calId)}/events?sendUpdates=none`, { method: 'POST', body: toGoogleEvent(input) }, [409]);
      // 409: an earlier attempt already created it (same id) – bring it up to date instead.
      if (status === 409) return this.patch(calId, googleEventId(input.key), input);
      return fromGoogleEvent(json);
    },
    async patch(calId, eventId, input, etag) {
      const { json } = await req(`${cal(calId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: 'PATCH', body: toGoogleEvent(input, false), headers: etag ? { 'if-match': etag } : {} });
      return fromGoogleEvent(json);
    },
    async remove(calId, eventId) {
      await req(`${cal(calId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: 'DELETE' }, [404, 410]);
    },
    async changes(calId, cursor) {
      const events: ExtEvent[] = [];
      let reset = !cursor;
      let page = '';
      let token = cursor ?? '';
      for (let i = 0; i < 60; i++) {
        const q = new URLSearchParams({ showDeleted: 'true', maxResults: token ? '250' : '2500', fields: `nextPageToken,nextSyncToken,items(${EVENT_FIELDS})`, ...(token ? { syncToken: token } : {}), ...(page ? { pageToken: page } : {}) });
        const { status, json } = await req(`${cal(calId)}/events?${q}`, {}, [410]);
        if (status === 410) {
          // The sync token expired: list everything again.
          token = '';
          page = '';
          reset = true;
          events.length = 0;
          continue;
        }
        for (const ev of json.items ?? []) events.push(fromGoogleEvent(ev));
        if (json.nextPageToken) {
          page = json.nextPageToken;
          continue;
        }
        if (json.nextSyncToken) return { events, cursor: String(json.nextSyncToken), reset };
        break;
      }
      throw new ProviderError('Google Kalender: keine Änderungsmarke erhalten', 500);
    },
  };
}

// --- Microsoft Graph ---------------------------------------------------------------

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_PROP = 'String {5b1f6c39-6a3e-4f0e-9a43-2f4c8d7e1a52} Name pghl_appt';
const UTC = { prefer: 'outlook.timezone="UTC"' };

/** A GUID-shaped transaction id from `key`: Graph uses it to avoid duplicate events on retries. */
export function graphTransactionId(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const graphDate = (s: string) => new Date(s).toISOString().replace(/\.\d{3}Z$/, '').replace(/Z$/, '');

export function parseGraphDate(x: Json | undefined): string {
  const raw = String(x?.dateTime ?? '');
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?(\.\d+)?/);
  if (!m) return '';
  const tz = String(x?.timeZone ?? 'UTC');
  if (tz === 'UTC' || tz === 'Etc/UTC' || !isValidTz(tz)) return new Date(`${m[1]}T${m[2]}${m[3] ?? ':00'}Z`).toISOString();
  return zonedToUtc(m[1], m[2], tz).toISOString();
}

export function toGraphEvent(i: EventInput, create = true): Json {
  return {
    subject: i.title,
    body: { contentType: 'text', content: i.description },
    location: { displayName: i.location || '' },
    start: { dateTime: graphDate(i.start), timeZone: 'UTC' },
    end: { dateTime: graphDate(i.end), timeZone: 'UTC' },
    showAs: 'busy',
    ...(create ? { transactionId: graphTransactionId(i.key), singleValueExtendedProperties: [{ id: GRAPH_PROP, value: i.appointmentId }] } : {}),
  };
}

export function fromGraphEvent(ev: Json): ExtEvent {
  if (ev['@removed']) return { id: String(ev.id ?? ''), cancelled: true, start: '', end: '', updated: '', etag: '' };
  const prop = (ev.singleValueExtendedProperties ?? []).find((p: Json) => String(p.id ?? '').toLowerCase() === GRAPH_PROP.toLowerCase());
  return {
    id: String(ev.id ?? ''),
    cancelled: !!ev.isCancelled,
    start: parseGraphDate(ev.start),
    end: parseGraphDate(ev.end),
    updated: iso(ev.lastModifiedDateTime),
    etag: String(ev['@odata.etag'] ?? ev.changeKey ?? ''),
    appointmentId: prop?.value ? String(prop.value) : undefined,
  };
}

/** Only follow paging/delta links that point back to Graph (the bearer token goes with them). */
const graphLink = (u: unknown) => (typeof u === 'string' && u.startsWith(`${GRAPH}/`) ? u : '');

export function graphCalendar(fetcher: typeof fetch, token: TokenFn): CalendarApi {
  const req = (url: string, init?: Parameters<typeof request>[4], allow?: number[]) => request('Outlook-Kalender', fetcher, token, url, { ...init, headers: { ...UTC, ...(init?.headers ?? {}) } }, allow);
  const expand = `$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${GRAPH_PROP}')`)}`;
  return {
    async listCalendars() {
      const { json } = await req(`${GRAPH}/me/calendars?$select=id,name,canEdit,isDefaultCalendar,hexColor&$top=100`);
      return (json.value ?? []).map((c: Json) => ({ id: String(c.id), name: String(c.name ?? '').slice(0, 200), primary: !!c.isDefaultCalendar, can_write: !!c.canEdit, color: String(c.hexColor ?? '') }));
    },
    async busy(ids, from, to, own = new Set()) {
      const out: Busy[] = [];
      for (const id of ids.slice(0, 20)) {
        let url = `${GRAPH}/me/calendars/${encodeURIComponent(id)}/calendarView?${new URLSearchParams({ startDateTime: from, endDateTime: to, $select: 'id,start,end,showAs,isCancelled', $top: '500' })}`;
        for (let i = 0; url && i < 20; i++) {
          const { json } = await req(url);
          for (const ev of json.value ?? []) {
            if (ev.isCancelled || ['free', 'workingElsewhere'].includes(ev.showAs) || own.has(ev.id)) continue;
            const s = parseGraphDate(ev.start);
            const e = parseGraphDate(ev.end);
            if (s && e) out.push({ start_at: s, end_at: e });
          }
          url = graphLink(json['@odata.nextLink']);
        }
      }
      return out;
    },
    async get(_calId, eventId) {
      const { status, json } = await req(`${GRAPH}/me/events/${encodeURIComponent(eventId)}?$select=id,start,end,isCancelled,lastModifiedDateTime&${expand}`, {}, [404]);
      return status === 200 ? fromGraphEvent(json) : null;
    },
    async create(calId, input) {
      const { json } = await req(`${GRAPH}/me/calendars/${encodeURIComponent(calId)}/events`, { method: 'POST', body: toGraphEvent(input) });
      return fromGraphEvent(json);
    },
    async patch(_calId, eventId, input, etag) {
      const { json } = await req(`${GRAPH}/me/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: toGraphEvent(input, false), headers: etag ? { 'if-match': etag } : {} });
      return fromGraphEvent(json);
    },
    async remove(_calId, eventId) {
      await req(`${GRAPH}/me/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' }, [404]);
    },
    async changes(calId, cursor, window) {
      const start = () => `${GRAPH}/me/calendars/${encodeURIComponent(calId)}/calendarView/delta?${new URLSearchParams({ startDateTime: window.from, endDateTime: window.to })}`;
      let url = graphLink(cursor) || start();
      let reset = !graphLink(cursor);
      const events: ExtEvent[] = [];
      for (let i = 0; i < 100; i++) {
        const { status, json } = await req(url, { headers: { prefer: `${UTC.prefer}, odata.maxpagesize=200` } }, [410]);
        if (status === 410) {
          // Delta link expired (or the window was reset by Graph): start over.
          url = start();
          reset = true;
          events.length = 0;
          continue;
        }
        for (const ev of json.value ?? []) events.push(fromGraphEvent(ev));
        const next = graphLink(json['@odata.nextLink']);
        if (next) {
          url = next;
          continue;
        }
        const delta = graphLink(json['@odata.deltaLink']);
        if (delta) return { events, cursor: delta, reset };
        break;
      }
      throw new ProviderError('Outlook-Kalender: kein Delta-Link erhalten', 500);
    },
  };
}

export function calendarApi(provider: Provider, fetcher: typeof fetch, token: TokenFn): CalendarApi {
  return provider === 'google' ? googleCalendar(fetcher, token) : graphCalendar(fetcher, token);
}
