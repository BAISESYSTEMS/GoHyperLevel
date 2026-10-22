import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, notFound, text } from '../core/http.js';
import { now, token } from '../core/util.js';
import { icsFeed, parseIcsBusy } from '../services/ical.js';
import { safeFetch } from '../services/net.js';

/**
 * Two-way-ish calendar sync without OAuth apps:
 * - import: the secret iCal address of a Google/Outlook/Apple calendar blocks those times on the booking page;
 * - export: each calendar has a private .ics feed to subscribe to in Google/Outlook/Apple.
 */

const SYNC_EVERY_MS = 10 * 60_000;
const MAX_BYTES = 5 * 1024 * 1024;

export function importUrl(raw: string): string {
  const u = raw.trim().replace(/^webcals?:\/\//i, 'https://');
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new Error(`Keine gültige Adresse: ${raw}`);
  }
  if (url.protocol !== 'https:') throw new Error('Nur https://- oder webcal://-Adressen');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(url.hostname)) throw new Error('Interne Adressen sind nicht erlaubt');
  return url.toString();
}

type IcsFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
/** iCal URLs come from users: fetched with the SSRF guard (resolved IP checked, redirects re-checked, size capped). */
const guardedFetch: IcsFetch = (url, init) => safeFetch(url, { headers: init.headers, timeoutMs: 20_000, maxBytes: MAX_BYTES });

export async function syncCalendar(app: App, calId: string, fetchImpl: IcsFetch = guardedFetch) {
  const cal = parseJson(app.db.get('SELECT * FROM calendars WHERE id = ?', calId), ['settings']);
  if (!cal) throw new Error('Kalender nicht gefunden');
  const urls: string[] = (cal.settings.ical_import ?? []).filter(Boolean);
  const from = new Date(Date.now() - 864e5);
  const to = new Date(Date.now() + (Number(cal.max_days) + 2) * 864e5);
  const rows: any[] = [];
  const errors: string[] = [];
  for (const raw of urls) {
    try {
      const url = importUrl(raw);
      const r = await fetchImpl(url, { headers: { accept: 'text/calendar' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.text();
      if (body.length > MAX_BYTES) throw new Error('Kalender zu groß');
      if (!body.includes('BEGIN:VCALENDAR')) throw new Error('Keine iCal-Datei');
      for (const e of parseIcsBusy(body, from, to, cal.timezone)) rows.push({ ...e, source: url });
    } catch (e) {
      errors.push(`${raw.slice(0, 60)}…: ${(e as Error).message}`);
    }
  }
  const status = { at: now(), ok: !errors.length, events: rows.length, message: errors.join(' · ') };
  app.db.tx(() => {
    // Keep the old busy times of a source that failed this round.
    if (!errors.length || rows.length) app.db.run('DELETE FROM external_busy WHERE calendar_id = ?', cal.id);
    for (const e of rows) app.db.insert('external_busy', { calendar_id: cal.id, start_at: e.start_at, end_at: e.end_at, summary: e.summary.slice(0, 200), source: e.source, fetched_at: now() });
    app.db.run(`UPDATE calendars SET settings = json_set(settings, '$.ical_status', json(?)) WHERE id = ?`, JSON.stringify(status), cal.id);
  });
  return status;
}

export const calendarSyncModule: Module = {
  name: 'calendar-sync',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE external_busy (
        calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
        start_at TEXT NOT NULL, end_at TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, fetched_at TEXT NOT NULL
      );
      CREATE INDEX external_busy_cal ON external_busy(calendar_id, start_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    app.services.externalBusy = (cal: { id: string }, from: string, to: string) =>
      db.all('SELECT start_at, end_at FROM external_busy WHERE calendar_id = ? AND end_at > ? AND start_at < ?', cal.id, from, to);

    const getCal = (loc: string, id: string) => parseJson(db.get('SELECT * FROM calendars WHERE id = ? AND location_id = ?', id, loc), ['settings']);

    router.post('/api/calendars/:id/sync', 'location', async (ctx) => {
      const cal = getCal(ctx.locationId, ctx.params.id);
      if (!cal) throw notFound();
      if (Array.isArray(ctx.body.urls)) {
        const urls = ctx.body.urls.map(String).map((u: string) => u.trim()).filter(Boolean).slice(0, 10);
        for (const u of urls) {
          try {
            importUrl(u);
          } catch (e) {
            throw bad((e as Error).message);
          }
        }
        db.run(`UPDATE calendars SET settings = json_set(settings, '$.ical_import', json(?)) WHERE id = ?`, JSON.stringify(urls), cal.id);
      }
      return syncCalendar(app, cal.id);
    });

    router.get('/api/calendars/:id/busy', 'location', (ctx) => {
      const cal = getCal(ctx.locationId, ctx.params.id);
      if (!cal) throw notFound();
      return db.all('SELECT start_at, end_at, summary FROM external_busy WHERE calendar_id = ? AND end_at > ? ORDER BY start_at LIMIT 200', cal.id, now());
    });

    /** The private feed address (made on first request). */
    router.get('/api/calendars/:id/feed', 'location', (ctx) => {
      const cal = getCal(ctx.locationId, ctx.params.id);
      if (!cal) throw notFound();
      let t = cal.settings.feed_token;
      // A token another calendar also carries (copied by an old snapshot) is replaced, never handed out.
      const shared = !!t && !!db.get(`SELECT 1 AS x FROM calendars WHERE json_extract(settings, '$.feed_token') = ? AND id != ?`, t, cal.id);
      if (!t || shared || ctx.query.get('renew') === '1') {
        t = token(18);
        db.run(`UPDATE calendars SET settings = json_set(settings, '$.feed_token', ?) WHERE id = ?`, t, cal.id);
      }
      const url = `${app.baseUrl()}/cal/${t}.ics`;
      return { url, webcal: url.replace(/^https?:/, 'webcal:') };
    });

    router.get('/cal/:file', 'public', (ctx) => {
      const t = ctx.params.file.replace(/\.ics$/, '');
      const found = parseRows(db.all(`SELECT * FROM calendars WHERE json_extract(settings, '$.feed_token') = ?`, t), ['settings']);
      // Ambiguous (a token copied into another sub-account by an old snapshot): serve nothing rather than the wrong calendar.
      const cal = found.length === 1 ? found[0] : undefined;
      if (!t || !cal) throw notFound();
      const appts = db.all(
        `SELECT a.*, c.first_name, c.last_name, c.email, c.phone FROM appointments a LEFT JOIN contacts c ON c.id = a.contact_id
         WHERE a.calendar_id = ? AND a.start_at > ? AND a.start_at < ? ORDER BY a.start_at`,
        cal.id,
        new Date(Date.now() - 30 * 864e5).toISOString(),
        new Date(Date.now() + 366 * 864e5).toISOString(),
      );
      const feed = icsFeed(
        cal.name,
        appts.map((a) => ({
          id: a.id,
          start_at: a.start_at,
          end_at: a.end_at,
          title: a.title,
          status: a.status,
          description: [a.email, a.phone, a.notes].filter(Boolean).join('\n'),
        })),
      );
      const r = text(feed, 'text/calendar; charset=utf-8');
      r.headers['cache-control'] = 'no-store';
      return r;
    });

    let running = false;
    app.onTick(async () => {
      if (running) return;
      running = true;
      try {
        const due = parseRows(db.all(`SELECT id, settings FROM calendars WHERE active = 1 AND json_array_length(COALESCE(json_extract(settings, '$.ical_import'), '[]')) > 0`), ['settings']);
        for (const c of due) {
          const last = c.settings.ical_status?.at ? new Date(c.settings.ical_status.at).getTime() : 0;
          if (Date.now() - last >= SYNC_EVERY_MS) await syncCalendar(app, c.id).catch((e) => console.error('[calendar-sync]', e));
        }
      } finally {
        running = false;
      }
    });
  },
};
