import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, type User } from '../core/http.js';
import { formatInTz } from '../core/time.js';
import { now, sha256 } from '../core/util.js';
import { calendarApi, PreconditionFailed, ProviderError, type CalendarApi, type EventInput, type ExtEvent } from '../services/calendar-providers.js';
import { logActivity } from '../services/contacts.js';
import { OAuthError, PROVIDER_LABEL } from '../services/oauth.js';
import { connectionOut, type OAuthConnection } from './oauth-connect.js';

/**
 * Two-way sync between booking calendars and a user's Google or Outlook calendar (OAuth, see
 * oauth-connect):
 * - busy times of the chosen calendars block booking slots (cached, refreshed every 5 minutes, via
 *   the `externalBusy` hook next to the iCal import);
 * - new, changed and cancelled appointments of the linked booking calendars are written to the
 *   chosen target calendar (create/patch/delete, external id stored, idempotent, retried with backoff);
 * - events moved or deleted over there are synced back (Google syncToken / Graph delta link, polled
 *   every 3 minutes – no public webhooks needed). Both sides changed: the later change wins (logged).
 */

const BUSY_EVERY_MS = 5 * 60_000;
const INBOUND_EVERY_MS = 3 * 60_000;
/** Graph delta windows are fixed when created – start a fresh one weekly. */
const CURSOR_MAX_AGE_MS = 7 * 864e5;
const MAX_OPS_PER_RUN = 25;
const BACKOFF_MAX_MS = 6 * 3600_000;

export const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);

/** What we last wrote for an appointment: a different hash means it changed here. */
export function appointmentHash(a: { title: string; start_at: string; end_at: string; status: string; notes?: string }, location = ''): string {
  return sha256(JSON.stringify([a.title, a.start_at, a.end_at, a.status === 'cancelled' ? 'x' : 'ok', a.notes ?? '', location])).slice(0, 32);
}

export interface SyncResult {
  busy?: number;
  created: number;
  updated: number;
  deleted: number;
  pulled: number;
  conflicts: number;
  errors: string[];
}

export const calendarConnectModule: Module = {
  name: 'calendar-connect',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE oauth_calendar_links (
        connection_id TEXT NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, calendar_id)
      );
      CREATE INDEX oauth_calendar_links_cal ON oauth_calendar_links(calendar_id);
      CREATE TABLE oauth_busy (
        connection_id TEXT NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
        start_at TEXT NOT NULL, end_at TEXT NOT NULL
      );
      CREATE INDEX oauth_busy_conn ON oauth_busy(connection_id, start_at);
      CREATE TABLE oauth_event_map (
        connection_id TEXT NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
        appointment_id TEXT NOT NULL,
        external_calendar_id TEXT NOT NULL DEFAULT '', external_event_id TEXT NOT NULL DEFAULT '', etag TEXT NOT NULL DEFAULT '',
        synced_hash TEXT NOT NULL DEFAULT '', ext_start TEXT, ext_end TEXT, ext_updated TEXT,
        deleted INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT, synced_at TEXT,
        PRIMARY KEY (connection_id, appointment_id)
      );
      CREATE INDEX oauth_event_map_ext ON oauth_event_map(connection_id, external_event_id);
      CREATE TABLE oauth_appt_touch (appointment_id TEXT PRIMARY KEY, changed_at TEXT NOT NULL);
      CREATE TRIGGER oauth_appt_touch_upd AFTER UPDATE OF start_at, end_at, status, title, notes ON appointments
      BEGIN
        INSERT INTO oauth_appt_touch (appointment_id, changed_at) VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(appointment_id) DO UPDATE SET changed_at = excluded.changed_at;
      END;
      CREATE TRIGGER oauth_appt_touch_del AFTER DELETE ON appointments
      BEGIN
        DELETE FROM oauth_appt_touch WHERE appointment_id = OLD.id;
      END;
      CREATE TABLE oauth_sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
        at TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL
      );
      CREATE INDEX oauth_sync_log_conn ON oauth_sync_log(connection_id, id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const oauth = () => app.services.oauth;

    const getConn = (cid: string) => parseJson(db.get(`SELECT * FROM oauth_connections WHERE id = ? AND purpose = 'calendar'`, cid), ['settings', 'state']) as OAuthConnection | undefined;
    const apiFor = (c: OAuthConnection): CalendarApi => calendarApi(c.provider, oauth().fetcher(), (force?: boolean) => oauth().token(c.id, force));
    const links = (cid: string): string[] => db.all('SELECT calendar_id FROM oauth_calendar_links WHERE connection_id = ?', cid).map((r) => r.calendar_id);
    const log = (cid: string, level: 'info' | 'warn' | 'error', message: string) => {
      db.run('INSERT INTO oauth_sync_log (connection_id, at, level, message) VALUES (?, ?, ?, ?)', cid, now(), level, message.slice(0, 500));
      db.run('DELETE FROM oauth_sync_log WHERE connection_id = ? AND id NOT IN (SELECT id FROM oauth_sync_log WHERE connection_id = ? ORDER BY id DESC LIMIT 100)', cid, cid);
      if (level !== 'info') console.warn(`[calendar-connect] ${cid}: ${message}`);
    };
    const patchState = (cid: string, patch: Record<string, any>) => {
      const cur = getConn(cid)?.state ?? {};
      oauth().setState(cid, { ...cur, ...patch });
    };
    const label = (c: OAuthConnection) => (c.provider === 'google' ? 'Google' : 'Outlook');

    // --- busy times -------------------------------------------------------------------
    const prevBusy = app.services.externalBusy;
    app.services.externalBusy = (cal: { id: string }, from: string, to: string) => [
      ...(prevBusy?.(cal, from, to) ?? []),
      ...db.all(
        `SELECT b.start_at, b.end_at FROM oauth_busy b JOIN oauth_calendar_links l ON l.connection_id = b.connection_id
         WHERE l.calendar_id = ? AND b.end_at > ? AND b.start_at < ?`,
        cal.id,
        from,
        to,
      ),
    ];

    async function refreshBusy(c: OAuthConnection): Promise<number> {
      const check: string[] = c.settings.check_calendars ?? [];
      const linked = links(c.id);
      if (!check.length || !linked.length) {
        db.run('DELETE FROM oauth_busy WHERE connection_id = ?', c.id);
        patchState(c.id, { busy_at: now(), busy_count: 0, busy_error: null, busy_due: false });
        return 0;
      }
      const days = Math.min(365, Math.max(...linked.map((id) => Number(db.get('SELECT max_days FROM calendars WHERE id = ?', id)?.max_days ?? 60))));
      const from = new Date(Date.now() - 864e5).toISOString();
      const to = new Date(Date.now() + (days + 2) * 864e5).toISOString();
      const own = new Set(db.all(`SELECT external_event_id FROM oauth_event_map WHERE connection_id = ? AND external_event_id != ''`, c.id).map((r) => r.external_event_id as string));
      try {
        const busy = await apiFor(c).busy(check, from, to, own);
        db.tx(() => {
          db.run('DELETE FROM oauth_busy WHERE connection_id = ?', c.id);
          for (const b of busy.slice(0, 5000)) db.run('INSERT INTO oauth_busy (connection_id, start_at, end_at) VALUES (?, ?, ?)', c.id, b.start_at, b.end_at);
        });
        patchState(c.id, { busy_at: now(), busy_count: busy.length, busy_error: null, busy_due: false });
        return busy.length;
      } catch (e) {
        // Keep the last known busy times: better a blocked slot than a double booking.
        patchState(c.id, { busy_at: now(), busy_error: (e as Error).message, busy_due: false });
        throw e;
      }
    }

    // --- appointments → external calendar ----------------------------------------------
    const apptRows = (cid: string) =>
      db.all(
        // Team calendars: an appointment with hosts goes only to its hosts' calendars (not to everybody who linked the booking calendar),
        // and its own video link is the place.
        `SELECT a.*, k.name AS calendar_name, k.location_id AS cal_location, COALESCE(NULLIF(a.meeting_url, ''), json_extract(k.settings, '$.meeting_location')) AS meeting_location,
                c.first_name, c.last_name, c.email, c.phone
         FROM appointments a JOIN oauth_calendar_links l ON l.calendar_id = a.calendar_id AND l.connection_id = ?
         JOIN calendars k ON k.id = a.calendar_id LEFT JOIN contacts c ON c.id = a.contact_id
         WHERE a.end_at > ? AND a.start_at < ?
           AND (a.assignee_id IS NULL OR a.assignee_id = (SELECT user_id FROM oauth_connections WHERE id = l.connection_id)
                OR EXISTS (SELECT 1 FROM json_each(COALESCE(a.host_ids, '[]')) h WHERE h.value = (SELECT user_id FROM oauth_connections WHERE id = l.connection_id)))`,
        cid,
        new Date(Date.now() - 864e5).toISOString(),
        new Date(Date.now() + 400 * 864e5).toISOString(),
      );
    const hashOf = (a: any) => appointmentHash(a, a.meeting_location ?? '');
    const inputOf = (c: OAuthConnection, a: any): EventInput => {
      const who = [a.first_name, a.last_name].filter(Boolean).join(' ');
      const loc = app.location(a.location_id);
      return {
        title: a.title,
        description: [
          who,
          a.email ? `E-Mail: ${a.email}` : '',
          a.phone ? `Telefon: ${a.phone}` : '',
          a.notes ? `Notizen: ${a.notes}` : '',
          `${a.calendar_name}${loc ? ` · ${loc.name}` : ''}`,
          a.contact_id ? `Im CRM: ${app.baseUrl()}/app/contacts/${a.contact_id}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        location: a.meeting_location ?? '',
        start: a.start_at,
        end: a.end_at,
        appointmentId: a.id,
        key: `${c.id}:${a.id}`,
      };
    };
    const saveMap = (cid: string, apptId: string, patch: Record<string, any>) => {
      const cur = db.get('SELECT appointment_id FROM oauth_event_map WHERE connection_id = ? AND appointment_id = ?', cid, apptId);
      if (!cur) db.insert('oauth_event_map', { connection_id: cid, appointment_id: apptId, ...patch });
      else {
        const keys = Object.keys(patch);
        db.run(`UPDATE oauth_event_map SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE connection_id = ? AND appointment_id = ?`, ...keys.map((k) => patch[k]), cid, apptId);
      }
    };
    const wrote = (cid: string, a: any, calId: string, ev: ExtEvent) =>
      saveMap(cid, a.id, { external_calendar_id: calId, external_event_id: ev.id, etag: ev.etag, synced_hash: hashOf(a), ext_start: ev.start || a.start_at, ext_end: ev.end || a.end_at, ext_updated: ev.updated || now(), deleted: 0, attempts: 0, next_attempt_at: null, last_error: null, synced_at: now() });
    const touchedAt = (apptId: string): string => db.get('SELECT changed_at FROM oauth_appt_touch WHERE appointment_id = ?', apptId)?.changed_at ?? '';

    /** Apply an external move or deletion to the appointment (marks it as in sync). */
    function applyExternal(c: OAuthConnection, a: any, m: any, ev: ExtEvent | null) {
      const loc = a.location_id;
      if (!ev || ev.cancelled) {
        if (a.status !== 'cancelled') {
          db.run(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`, a.id);
          const next = db.get('SELECT * FROM appointments WHERE id = ?', a.id)!;
          if (a.contact_id) logActivity(app, loc, a.contact_id, 'appointment.status_changed', `Termin in ${label(c)} gelöscht – abgesagt`);
          app.events.emit(loc, 'appointment.status_changed', { contactId: a.contact_id, appointment: next, status: 'cancelled', calendarId: a.calendar_id, source: c.provider });
        }
        saveMap(c.id, a.id, { deleted: 1, synced_hash: hashOf({ ...a, status: 'cancelled' }), ext_updated: ev?.updated || now(), attempts: 0, next_attempt_at: null, last_error: null, synced_at: now() });
        log(c.id, 'info', `„${a.title}“ wurde in ${label(c)} gelöscht → hier abgesagt`);
        return;
      }
      db.run('UPDATE appointments SET start_at = ?, end_at = ?, reminder_sent = 0 WHERE id = ?', ev.start, ev.end, a.id);
      const tz = db.get('SELECT timezone FROM calendars WHERE id = ?', a.calendar_id)?.timezone ?? 'Europe/Berlin';
      if (a.contact_id) logActivity(app, loc, a.contact_id, 'appointment.rescheduled', `Termin in ${label(c)} verschoben: ${formatInTz(ev.start, tz)}`);
      saveMap(c.id, a.id, { synced_hash: hashOf({ ...a, start_at: ev.start, end_at: ev.end }), ext_start: ev.start, ext_end: ev.end, ext_updated: ev.updated || now(), etag: ev.etag || m?.etag || '', attempts: 0, next_attempt_at: null, last_error: null, synced_at: now() });
      log(c.id, 'info', `„${a.title}“ in ${label(c)} verschoben auf ${formatInTz(ev.start, tz)}`);
    }

    async function pushChanges(c: OAuthConnection, api: CalendarApi, res: SyncResult) {
      const target: string = c.settings.target_calendar ?? '';
      if (!target) return;
      const maps = new Map(db.all('SELECT * FROM oauth_event_map WHERE connection_id = ?', c.id).map((m) => [m.appointment_id, m]));
      const t = now();
      const ops: { kind: 'create' | 'patch' | 'delete' | 'move' | 'orphan'; a: any; m?: any }[] = [];
      for (const a of apptRows(c.id)) {
        const m = maps.get(a.id);
        const active = a.status !== 'cancelled';
        if (m?.next_attempt_at && m.next_attempt_at > t) continue;
        const exists = m && m.external_event_id && !m.deleted;
        if (!exists) {
          if (active && a.end_at > t) ops.push({ kind: 'create', a, m });
        } else if (!active) ops.push({ kind: 'delete', a, m });
        else if (m.external_calendar_id !== target) ops.push({ kind: 'move', a, m });
        else if (hashOf(a) !== m.synced_hash) ops.push({ kind: 'patch', a, m });
      }
      // Appointments deleted here: remove their events.
      for (const m of db.all(`SELECT * FROM oauth_event_map WHERE connection_id = ? AND deleted = 0 AND external_event_id != '' AND appointment_id NOT IN (SELECT id FROM appointments)`, c.id)) {
        if (!(m.next_attempt_at && m.next_attempt_at > t)) ops.push({ kind: 'orphan', a: { id: m.appointment_id, title: '' }, m });
      }
      for (const op of ops.slice(0, MAX_OPS_PER_RUN)) {
        const { a, m } = op;
        try {
          if (op.kind === 'create') {
            wrote(c.id, a, target, await api.create(target, inputOf(c, a)));
            res.created++;
          } else if (op.kind === 'delete' || op.kind === 'orphan') {
            await api.remove(m.external_calendar_id, m.external_event_id);
            if (op.kind === 'orphan') db.run('DELETE FROM oauth_event_map WHERE connection_id = ? AND appointment_id = ?', c.id, m.appointment_id);
            else saveMap(c.id, a.id, { deleted: 1, synced_hash: hashOf(a), attempts: 0, next_attempt_at: null, last_error: null, synced_at: now() });
            res.deleted++;
          } else if (op.kind === 'move') {
            await api.remove(m.external_calendar_id, m.external_event_id);
            wrote(c.id, a, target, await api.create(target, { ...inputOf(c, a), key: `${c.id}:${a.id}:${target}` }));
            res.updated++;
          } else {
            try {
              wrote(c.id, a, m.external_calendar_id, await api.patch(m.external_calendar_id, m.external_event_id, inputOf(c, a), m.etag || undefined));
              res.updated++;
            } catch (e) {
              const gone = e instanceof ProviderError && (e.status === 404 || e.status === 410);
              if (!(e instanceof PreconditionFailed) && !gone) throw e;
              // Changed (or deleted) on both sides since the last sync: the later change wins.
              res.conflicts++;
              const ev = gone ? null : await api.get(m.external_calendar_id, m.external_event_id);
              const local = touchedAt(a.id);
              const external = ev?.updated || (gone ? '' : now());
              if (local && local > external) {
                if (ev && !ev.cancelled) wrote(c.id, a, m.external_calendar_id, await api.patch(m.external_calendar_id, m.external_event_id, inputOf(c, a)));
                else wrote(c.id, a, target, await api.create(target, inputOf(c, a)));
                log(c.id, 'warn', `Konflikt bei „${a.title}“: hier zuletzt geändert – ${label(c)} überschrieben`);
                res.updated++;
              } else {
                applyExternal(c, a, m, ev);
                log(c.id, 'warn', `Konflikt bei „${a.title}“: in ${label(c)} zuletzt geändert – Termin hier angepasst`);
                res.pulled++;
              }
            }
          }
        } catch (e) {
          if (e instanceof OAuthError) throw e;
          const attempts = Number(m?.attempts ?? 0) + 1;
          const msg = (e as Error).message;
          saveMap(c.id, a.id, { attempts, next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(), last_error: msg.slice(0, 500), ...(m ? {} : { external_calendar_id: target }) });
          if (attempts === 1 || attempts % 5 === 0) log(c.id, 'error', `${a.title || 'Termin'}: ${msg} (Versuch ${attempts})`);
          res.errors.push(msg);
        }
      }
      // Moved or cancelled appointments free their old slot sooner.
      if (res.created || res.updated || res.deleted) patchState(c.id, { busy_due: true });
    }

    // --- external calendar → appointments ------------------------------------------------
    async function pullChanges(c: OAuthConnection, api: CalendarApi, res: SyncResult) {
      const target: string = c.settings.target_calendar ?? '';
      if (!target) return;
      const st = c.state ?? {};
      const fresh = st.cursor_cal === target && st.cursor_at && Date.now() - Date.parse(st.cursor_at) < CURSOR_MAX_AGE_MS;
      const window = { from: new Date(Date.now() - 864e5).toISOString(), to: new Date(Date.now() + 400 * 864e5).toISOString() };
      const cs = await api.changes(target, fresh ? st.cursor : null, window);
      for (const ev of cs.events) {
        if (!ev.id) continue;
        const m = db.get(`SELECT * FROM oauth_event_map WHERE connection_id = ? AND external_event_id = ? AND deleted = 0`, c.id, ev.id);
        if (!m) continue; // not one of ours: its time counts as busy via refreshBusy
        const a = db.get('SELECT * FROM appointments WHERE id = ?', m.appointment_id);
        if (!a) continue; // deleted here: pushChanges removes the event
        const ka = db.get(`SELECT json_extract(settings, '$.meeting_location') AS meeting_location FROM calendars WHERE id = ?`, a.calendar_id);
        a.meeting_location = a.meeting_url || ka?.meeting_location || '';
        if (!ev.cancelled && ev.start === m.ext_start && ev.end === m.ext_end) {
          // Our own write coming back, or a change we don't sync (title, colour…).
          saveMap(c.id, a.id, { etag: ev.etag || m.etag, ext_updated: ev.updated || m.ext_updated });
          continue;
        }
        if (!ev.cancelled && ev.start === a.start_at && ev.end === a.end_at) {
          saveMap(c.id, a.id, { etag: ev.etag || m.etag, ext_start: ev.start, ext_end: ev.end, ext_updated: ev.updated || m.ext_updated });
          continue;
        }
        if (ev.cancelled && a.status === 'cancelled') {
          saveMap(c.id, a.id, { deleted: 1, synced_hash: hashOf(a) });
          continue;
        }
        const localPending = hashOf(a) !== m.synced_hash;
        const local = touchedAt(a.id);
        if (localPending && local && local > (ev.updated || '')) {
          // Changed here after the change over there: ours wins and goes out with the next push.
          res.conflicts++;
          saveMap(c.id, a.id, ev.cancelled ? { deleted: 1, synced_hash: '' } : { etag: '' });
          log(c.id, 'warn', `Konflikt bei „${a.title}“: hier zuletzt geändert – ${label(c)} wird überschrieben`);
          continue;
        }
        if (localPending) {
          res.conflicts++;
          log(c.id, 'warn', `Konflikt bei „${a.title}“: in ${label(c)} zuletzt geändert – Termin hier angepasst`);
        }
        if (!ev.cancelled && a.status === 'cancelled') continue; // cancelled here: the push deletes it
        applyExternal(c, a, m, ev);
        res.pulled++;
      }
      patchState(c.id, { cursor: cs.cursor, cursor_cal: target, ...(cs.reset || !fresh ? { cursor_at: now() } : {}), inbound_at: now(), inbound_error: null });
    }

    /** One sync round for a connection; `force` ignores the intervals. */
    async function syncConnection(cid: string, force = false): Promise<SyncResult> {
      const res: SyncResult = { created: 0, updated: 0, deleted: 0, pulled: 0, conflicts: 0, errors: [] };
      let c = getConn(cid);
      if (!c) throw notFound();
      if (c.status === 'error' && /neu verbinden/.test(c.last_error ?? '') && !force) return res;
      const api = apiFor(c);
      try {
        await pushChanges(c, api, res);
        // Only rounds that talked to the provider update "last sync" and the shown error.
        let talked = res.created + res.updated + res.deleted + res.pulled + res.conflicts + res.errors.length > 0;
        c = getConn(cid)!;
        const st = c.state ?? {};
        if (force || !st.inbound_at || Date.now() - Date.parse(st.inbound_at) >= INBOUND_EVERY_MS) {
          talked = true;
          try {
            await pullChanges(c, api, res);
          } catch (e) {
            if (e instanceof OAuthError) throw e;
            patchState(cid, { inbound_at: now(), inbound_error: (e as Error).message });
            log(cid, 'error', `Abgleich aus ${label(c)}: ${(e as Error).message}`);
            res.errors.push((e as Error).message);
          }
          c = getConn(cid)!;
        }
        const st2 = c.state ?? {};
        if (force || st2.busy_due || !st2.busy_at || Date.now() - Date.parse(st2.busy_at) >= BUSY_EVERY_MS) {
          talked = true;
          try {
            res.busy = await refreshBusy(c);
          } catch (e) {
            if (e instanceof OAuthError) throw e;
            log(cid, 'error', `Belegte Zeiten: ${(e as Error).message}`);
            res.errors.push((e as Error).message);
          }
        }
        if (talked) db.run(`UPDATE oauth_connections SET last_sync_at = ?, status = CASE WHEN last_error LIKE '%neu verbinden%' THEN status ELSE 'ok' END, last_error = CASE WHEN last_error LIKE '%neu verbinden%' THEN last_error ELSE ? END WHERE id = ?`, now(), res.errors[0]?.slice(0, 500) ?? null, cid);
      } catch (e) {
        const msg = (e as Error).message;
        if (!(e instanceof OAuthError && e.needsReconnect)) db.run('UPDATE oauth_connections SET last_error = ?, last_sync_at = ? WHERE id = ?', msg.slice(0, 500), now(), cid);
        log(cid, 'error', msg);
        res.errors.push(msg);
      }
      if (res.created || res.updated || res.deleted || res.pulled) log(cid, 'info', `Abgeglichen: ${res.created} neu, ${res.updated} geändert, ${res.deleted} gelöscht, ${res.pulled} aus ${label(c!)} übernommen`);
      return res;
    }
    app.services.calendarConnectSync = syncConnection;

    let running = false;
    app.onTick(async () => {
      if (running) return;
      running = true;
      try {
        const due = db.all(`SELECT id FROM oauth_connections WHERE purpose = 'calendar' AND EXISTS (SELECT 1 FROM oauth_calendar_links l WHERE l.connection_id = oauth_connections.id)`);
        for (const r of due) await syncConnection(r.id).catch((e) => console.error('[calendar-connect]', e));
      } finally {
        running = false;
      }
    });

    // --- routes (per login: "Mein Konto") ------------------------------------------------
    const mine = (user: User, cid: string) => {
      const c = getConn(cid);
      if (!c || c.user_id !== user.id) throw notFound('Verbindung nicht gefunden');
      return c;
    };
    /** Booking calendars this login may link (sub-accounts with access to "Kalender"). */
    const usableCalendars = (user: User) => {
      if (user.permissions && !user.permissions.includes('calendars') && user.role !== 'admin') return [];
      const rows = db.all(`SELECT k.id, k.name, k.color, k.location_id, l.name AS location_name FROM calendars k JOIN locations l ON l.id = k.location_id ORDER BY l.name, k.name`);
      return user.role === 'admin' ? rows : rows.filter((r) => user.locations.includes(r.location_id));
    };
    const out = (c: OAuthConnection) => {
      const st = c.state ?? {};
      const counts = db.get(`SELECT SUM(CASE WHEN external_event_id != '' AND deleted = 0 THEN 1 ELSE 0 END) AS synced, SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS failing FROM oauth_event_map WHERE connection_id = ?`, c.id);
      return {
        ...connectionOut(c),
        settings: { check_calendars: c.settings.check_calendars ?? [], target_calendar: c.settings.target_calendar ?? '' },
        booking_calendars: links(c.id),
        busy: { count: st.busy_count ?? 0, at: st.busy_at ?? null, error: st.busy_error ?? null },
        inbound: { at: st.inbound_at ?? null, error: st.inbound_error ?? null },
        events: { synced: Number(counts?.synced ?? 0), failing: Number(counts?.failing ?? 0) },
        log: db.all('SELECT at, level, message FROM oauth_sync_log WHERE connection_id = ? ORDER BY id DESC LIMIT 15', c.id),
      };
    };

    router.get('/api/me/calendar-connections', 'user', (ctx) => ({
      providers: { google: oauth().configured('google'), microsoft: oauth().configured('microsoft') },
      connections: db.all(`SELECT id FROM oauth_connections WHERE purpose = 'calendar' AND user_id = ? ORDER BY created_at`, ctx.user!.id).map((r) => out(getConn(r.id)!)),
    }));
    router.get('/api/me/calendar-connections/booking-calendars', 'user', (ctx) => usableCalendars(ctx.user!));
    router.get('/api/me/calendar-connections/:id/calendars', 'user', async (ctx) => {
      const c = mine(ctx.user!, ctx.params.id);
      try {
        return await apiFor(c).listCalendars();
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
    });
    router.put('/api/me/calendar-connections/:id', 'user', (ctx) => {
      const c = mine(ctx.user!, ctx.params.id);
      const b = ctx.body ?? {};
      const ids = (v: unknown, what: string) => {
        if (!Array.isArray(v)) throw bad(`${what} als Liste`);
        return [...new Set(v.map(String).map((s) => s.trim()).filter(Boolean))].slice(0, 20).map((s) => {
          if (s.length > 400) throw bad(`${what}: ID zu lang`);
          return s;
        });
      };
      const settings = { ...c.settings };
      if (b.check_calendars !== undefined) settings.check_calendars = ids(b.check_calendars, 'Kalender für Konflikte');
      if (b.target_calendar !== undefined) {
        const t = String(b.target_calendar ?? '').trim();
        if (t.length > 400) throw bad('Zielkalender: ID zu lang');
        settings.target_calendar = t;
      }
      oauth().setSettings(c.id, settings);
      if (b.booking_calendars !== undefined) {
        const allowed = new Set(usableCalendars(ctx.user!).map((k) => k.id));
        const want = ids(b.booking_calendars, 'Buchungskalender');
        for (const k of want) if (!allowed.has(k)) throw bad('Buchungskalender nicht gefunden oder kein Zugriff');
        db.tx(() => {
          db.run('DELETE FROM oauth_calendar_links WHERE connection_id = ?', c.id);
          for (const k of want) db.run('INSERT INTO oauth_calendar_links (connection_id, calendar_id, created_at) VALUES (?, ?, ?)', c.id, k, now());
        });
      }
      patchState(c.id, { busy_due: true });
      return out(getConn(c.id)!);
    });
    router.post('/api/me/calendar-connections/:id/sync', 'user', async (ctx) => {
      const c = mine(ctx.user!, ctx.params.id);
      const result = await syncConnection(c.id, true);
      return { result, connection: out(getConn(c.id)!) };
    });

    /** Which connected Google/Outlook calendars feed a booking calendar (calendar editor). */
    router.get('/api/calendars/:id/connections', 'location', (ctx) => {
      const cal = db.get('SELECT id FROM calendars WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!cal) throw notFound();
      return db
        .all(
          `SELECT c.id, c.provider, c.account_email, c.status, c.last_error, c.last_sync_at, json_extract(c.settings, '$.target_calendar') AS target, u.name AS user_name
           FROM oauth_calendar_links l JOIN oauth_connections c ON c.id = l.connection_id LEFT JOIN users u ON u.id = c.user_id WHERE l.calendar_id = ?`,
          cal.id,
        )
        .map((r) => ({ ...r, provider_label: PROVIDER_LABEL[r.provider as 'google' | 'microsoft'], writes: !!r.target, target: undefined }));
    });
  },
};
