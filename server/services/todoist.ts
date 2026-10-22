import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { App } from '../core/app.js';
import { zonedToUtc } from '../core/time.js';

/**
 * Every HTTP call to Todoist lives here (API v1, https://developer.todoist.com/api/v1/).
 * Reads and writes go through the Sync endpoint (`POST /api/v1/sync`, form-encoded `sync_token`,
 * `resource_types`, `commands`); only the token test (`GET /user`) and the project picker
 * (`GET /projects`, cursor-paginated) use REST. Tests replace the transport with
 * `app.services.todoistFetch` and the backoff wait with `app.services.todoistSleep`.
 */

export const TODOIST_API = 'https://api.todoist.com/api/v1';
/** The Sync API accepts at most 100 commands per request. */
export const MAX_COMMANDS = 100;

export interface TodoistResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}
export type TodoistFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<TodoistResponse>;

export interface TodoistDue {
  date: string;
  timezone?: string | null;
  string?: string;
  is_recurring?: boolean;
}
export interface TodoistItem {
  id: string;
  project_id: string;
  section_id?: string | null;
  content: string;
  description?: string;
  due?: TodoistDue | null;
  checked?: boolean;
  is_deleted?: boolean;
  labels?: string[];
  parent_id?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  added_at?: string | null;
}
export interface TodoistProject {
  id: string;
  name: string;
  parent_id?: string | null;
  is_deleted?: boolean;
  is_archived?: boolean;
  inbox_project?: boolean;
}
export interface TodoistSection {
  id: string;
  name: string;
  project_id: string;
  is_deleted?: boolean;
  is_archived?: boolean;
}
export interface TodoistUser {
  id: string;
  email: string;
  full_name: string;
  is_premium?: boolean;
  premium_status?: string;
  tz_info?: { timezone?: string };
}
export interface SyncResult {
  sync_token: string;
  full_sync: boolean;
  /** For full reads: when Todoist generated the data (big accounts may get a slightly older snapshot). */
  full_sync_date_utc?: string;
  items: TodoistItem[];
  projects: TodoistProject[];
  sections: TodoistSection[];
}
export interface Command {
  type: string;
  uuid: string;
  temp_id?: string;
  args: Record<string, unknown>;
}
export type CommandStatus = 'ok' | { error?: string; error_tag?: string; error_code?: number; http_code?: number; error_extra?: Record<string, unknown> };

export class TodoistError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const defaultFetch: TodoistFetch = async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: r.status, headers, text: await r.text() };
};
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long to wait before retrying a 429/503: Retry-After header, `error_extra.retry_after`, else 1, 2, 4, 8 s … (max 60 s). */
export function retryDelayMs(res: TodoistResponse, attempt: number): number {
  const header = Number(res.headers['retry-after']);
  if (Number.isFinite(header) && header > 0) return Math.min(header, 60) * 1000;
  try {
    const extra = Number(JSON.parse(res.text)?.error_extra?.retry_after);
    if (Number.isFinite(extra) && extra > 0) return Math.min(extra, 60) * 1000;
  } catch {
    /* not JSON */
  }
  return Math.min(1000 * 2 ** attempt, 60_000);
}

export function todoistClient(app: App, token: string) {
  const transport: TodoistFetch = app.services.todoistFetch ?? defaultFetch;
  const sleep: (ms: number) => Promise<void> = app.services.todoistSleep ?? defaultSleep;
  const auth = { authorization: `Bearer ${token}` };

  async function request(method: string, path: string, body?: URLSearchParams | Record<string, unknown>): Promise<any> {
    const isForm = body instanceof URLSearchParams;
    const init = {
      method,
      headers: { ...auth, ...(body ? { 'content-type': isForm ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) },
      body: body ? (isForm ? body.toString() : JSON.stringify(body)) : undefined,
    };
    for (let attempt = 0; ; attempt++) {
      let res: TodoistResponse;
      try {
        res = await transport(`${TODOIST_API}${path}`, init);
      } catch (e) {
        throw new TodoistError(`Todoist nicht erreichbar: ${(e as Error).message}`, 0);
      }
      if ((res.status === 429 || res.status === 503) && attempt < 4) {
        await sleep(retryDelayMs(res, attempt));
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new TodoistError('Todoist lehnt den Token ab (401/403) – bitte neuen API-Token eintragen', res.status);
      if (res.status === 429) throw new TodoistError('Todoist: zu viele Anfragen (429) – der nächste Abgleich versucht es erneut', 429);
      if (res.status >= 300) throw new TodoistError(`Todoist ${method} ${path}: HTTP ${res.status} ${res.text.slice(0, 200)}`, res.status);
      try {
        return res.text ? JSON.parse(res.text) : {};
      } catch {
        throw new TodoistError(`Todoist ${path}: ungültige Antwort`, res.status);
      }
    }
  }

  async function paged<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let cursor = '';
    for (let page = 0; page < 50; page++) {
      const r = await request('GET', `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      out.push(...(r.results ?? []));
      if (!r.next_cursor) break;
      cursor = r.next_cursor;
    }
    return out;
  }

  return {
    /** Token test: who is this? */
    user: (): Promise<TodoistUser> => request('GET', '/user'),

    /** Active projects for the picker (cursor pagination, 200 per page). */
    projects: (): Promise<TodoistProject[]> => paged('/projects?limit=200'),

    /** Sections of one project (picker, and finding a section by name). */
    sections: (projectId: string): Promise<TodoistSection[]> => paged(`/sections?project_id=${encodeURIComponent(projectId)}&limit=200`),

    /** Read projects, sections and tasks; `*` = everything active, otherwise only what changed since that token. */
    async read(syncToken: string): Promise<SyncResult> {
      const body = new URLSearchParams({ sync_token: syncToken || '*', resource_types: JSON.stringify(['projects', 'sections', 'items']) });
      const r = await request('POST', '/sync', body);
      if (typeof r.sync_token !== 'string') throw new TodoistError('Todoist /sync: kein sync_token in der Antwort', 200);
      return { sync_token: r.sync_token, full_sync: !!r.full_sync, full_sync_date_utc: r.full_sync_date_utc ?? undefined, items: r.items ?? [], projects: r.projects ?? [], sections: r.sections ?? [] };
    },

    /**
     * Runs commands in batches of 100; returns each command's status by uuid and the temp_id → id
     * map. A failing batch stops the rest: its commands have no status (retry later) and `error` is set.
     */
    async commands(list: Command[]): Promise<{ status: Record<string, CommandStatus>; tempIds: Record<string, string>; error?: Error }> {
      const status: Record<string, CommandStatus> = {};
      const tempIds: Record<string, string> = {};
      for (let i = 0; i < list.length; i += MAX_COMMANDS) {
        try {
          const r = await request('POST', '/sync', new URLSearchParams({ commands: JSON.stringify(list.slice(i, i + MAX_COMMANDS)) }));
          Object.assign(status, r.sync_status ?? {});
          Object.assign(tempIds, r.temp_id_mapping ?? {});
        } catch (e) {
          return { status, tempIds, error: e as Error };
        }
      }
      return { status, tempIds };
    },
  };
}
export type TodoistClient = ReturnType<typeof todoistClient>;

export const command = (type: string, args: Record<string, unknown>, tempId?: string): Command => ({ type, uuid: randomUUID(), ...(tempId ? { temp_id: tempId } : {}), args });

/** A command error that will never succeed on retry because the task/project is gone. */
export function isGone(s: CommandStatus | undefined): boolean {
  if (!s || s === 'ok') return false;
  return s.error_tag === 'ITEM_NOT_FOUND' || s.error_tag === 'PROJECT_NOT_FOUND' || s.http_code === 404 || /not found/i.test(s.error ?? '');
}
/**
 * A plan limit was hit (free plan: 5 projects, 20 sections per project …). The exact error tag is
 * not documented, so match the tag and the message loosely; retrying will not help either way.
 */
export function isLimit(s: CommandStatus | undefined): boolean {
  if (!s || s === 'ok') return false;
  return /LIMIT|MAX_|QUOTA|EXCEED/i.test(String(s.error_tag ?? '')) || /limit|maximum|quota|exceeded|upgrade/i.test(String(s.error ?? ''));
}
export const commandError = (s: CommandStatus | undefined) => (!s ? 'keine Antwort' : s === 'ok' ? '' : `${s.error_tag ?? s.error_code ?? ''} ${s.error ?? ''}`.trim());

// --- due dates ---------------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** HyperLevel stores date-only due dates as UTC midnight (the date picker does `new Date('YYYY-MM-DD')`). */
const UTC_MIDNIGHT = /T00:00:00(\.0+)?Z$/;

/** One canonical form for comparing: ISO to the second, date-only as UTC midnight, invalid → null. */
export function normalizeDue(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (DATE_ONLY.test(s)) return `${s}T00:00:00.000Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(Math.floor(t / 1000) * 1000).toISOString() : null;
}

/** HyperLevel due_at → Todoist `due`: full-day date, or a fixed time in UTC with the location's zone. */
export function toTodoistDue(dueAt: string | null | undefined, tz: string): { date: string; timezone?: string } | null {
  const iso = normalizeDue(dueAt);
  if (!iso) return null;
  if (UTC_MIDNIGHT.test(iso)) return { date: iso.slice(0, 10) };
  return { date: `${iso.slice(0, 19)}Z`, timezone: tz };
}

/** Todoist `due` → HyperLevel due_at. Floating times are read in `tz` (the Todoist user's zone, else the location's). */
export function fromTodoistDue(due: TodoistDue | null | undefined, tz: string): string | null {
  if (!due?.date) return null;
  const d = String(due.date);
  if (DATE_ONLY.test(d)) return `${d}T00:00:00.000Z`;
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(d)) return normalizeDue(d);
  const m = d.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? zonedToUtc(m[1], m[2], tz).toISOString() : null;
}

// --- webhooks ----------------------------------------------------------------------------------

/** `X-Todoist-Hmac-SHA256`: base64 HMAC-SHA256 of the raw body with the app's client secret. */
export function verifyTodoistHmac(rawBody: string, clientSecret: string, header: string | undefined): boolean {
  if (!clientSecret || !header) return false;
  const expected = createHmac('sha256', clientSecret).update(rawBody, 'utf8').digest();
  let given: Buffer;
  try {
    given = Buffer.from(header.trim(), 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
