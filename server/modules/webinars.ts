import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, num, str, type Ctx } from '../core/http.js';
import { id as newId, now, normalizeEmail } from '../core/util.js';
import { getContact } from '../services/contacts.js';
import { cancelRegistration, bookable, nowOf, registerContact, sendDueReminders } from '../services/webinar-register.js';
import { cleanWebinar, previewToken, publishProblems, uniqueSlug, defaultSettings, type WebinarInput } from '../services/webinar-model.js';
import { DEFAULT_SCHEDULE } from '../services/webinar-schedule.js';
import { webinarStats } from '../services/webinar-stats.js';
import { finalizeDue } from '../services/webinar-track.js';
import { getRegistration, getWebinar, linksOf, parseWebinar, pageUrl, urlsOf, webinarTz, type Webinar } from '../services/webinar-store.js';
import { NO_VIDEO, VIDEO_EXT, extOf, looksLikeVideo } from '../services/webinar-video.js';

/**
 * Webinare (Marketing): automated webinars per sub-account – video, schedules, registration page, room, reminders,
 * tracking, analytics. This module holds the tables and the team's routes (`/api/webinars`, area "Funnels & Websites");
 * the public pages are in webinar-public.ts, workflow triggers/actions and the background jobs in webinar-automation.ts,
 * MCP tools and the app's endpoints in webinar-tools.ts. Docs: docs/webinars.md.
 *
 * Every write by the team is a normal authenticated route, so the audit log, member areas and the SaaS plan apply.
 */

const CHUNK = 8 * 1024 * 1024;
const maxUploadMb = () => Math.max(50, Number(process.env.PGHL_WEBINAR_MAX_MB) || 4096);

export const webinarsModule: Module = {
  name: 'webinars',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE webinars (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        presenter_name TEXT NOT NULL DEFAULT '', presenter_photo TEXT NOT NULL DEFAULT '',
        video TEXT NOT NULL DEFAULT '{"type":"none"}', duration_s INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft', schedule TEXT NOT NULL DEFAULT '{}', settings TEXT NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX webinars_loc ON webinars(location_id, updated_at);
      CREATE TABLE webinar_registrations (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        session_start TEXT NOT NULL, session_kind TEXT NOT NULL DEFAULT 'fixed', tz TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'page', status TEXT NOT NULL DEFAULT 'registered',
        consent_at TEXT, sms_consent INTEGER NOT NULL DEFAULT 0,
        attended_at TEXT, first_off REAL, last_off REAL, watched_s REAL NOT NULL DEFAULT 0, watch_pct INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT, left_at TEXT, finalized_at TEXT,
        cta_clicked_at TEXT, cta_clicks INTEGER NOT NULL DEFAULT 0,
        purchased_at TEXT, purchase_cents INTEGER NOT NULL DEFAULT 0, purchase_count INTEGER NOT NULL DEFAULT 0,
        replay_at TEXT, replay_pos_s REAL NOT NULL DEFAULT 0, replay_watched_s REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE (webinar_id, contact_id, session_start)
      );
      CREATE INDEX webinar_reg_webinar ON webinar_registrations(webinar_id, session_start);
      CREATE INDEX webinar_reg_loc ON webinar_registrations(location_id, created_at);
      CREATE INDEX webinar_reg_contact ON webinar_registrations(contact_id);
      CREATE INDEX webinar_reg_open ON webinar_registrations(finalized_at, session_start);
      CREATE INDEX webinar_reg_seen ON webinar_registrations(webinar_id, last_seen_at);
      CREATE TABLE webinar_reminders (
        registration_id TEXT NOT NULL REFERENCES webinar_registrations(id) ON DELETE CASCADE,
        key TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', sent_at TEXT NOT NULL,
        PRIMARY KEY (registration_id, key, channel)
      );
      CREATE TABLE webinar_questions (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
        registration_id TEXT NOT NULL REFERENCES webinar_registrations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        session_start TEXT NOT NULL, offset_s REAL, body TEXT NOT NULL, message_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX webinar_questions_webinar ON webinar_questions(webinar_id, created_at);
      CREATE INDEX webinar_questions_reg ON webinar_questions(registration_id, created_at);
      CREATE TABLE webinar_votes (
        registration_id TEXT NOT NULL REFERENCES webinar_registrations(id) ON DELETE CASCADE,
        poll_id TEXT NOT NULL, webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, choice TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (registration_id, poll_id)
      );
      CREATE INDEX webinar_votes_webinar ON webinar_votes(webinar_id, poll_id);
      CREATE TABLE webinar_uploads (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
        name TEXT NOT NULL, file TEXT NOT NULL, size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX webinar_uploads_webinar ON webinar_uploads(webinar_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const dir = join(app.config.dataDir, 'webinars');
    const actor = (ctx: Ctx) => ctx.user?.name || (ctx.via === 'mcp' ? 'MCP' : ctx.viaApiKey ? 'API-Schlüssel' : '');

    const mine = (ctx: Ctx, wid = ctx.params.id): Webinar => {
      const w = getWebinar(app, { id: wid }, ctx.locationId);
      if (!w) throw notFound('Webinar nicht gefunden');
      return w;
    };
    const asInput = (w: Webinar): WebinarInput => ({ title: w.title, description: w.description, presenter_name: w.presenter_name, presenter_photo: w.presenter_photo, video: w.video, duration_s: w.duration_s, status: w.status, schedule: w.schedule, settings: w.settings });

    /** What the settings point at must exist in this sub-account (a product, a form, a video) – never in another one. */
    const checkRefs = (locationId: string, webinarId: string | undefined, input: WebinarInput) => {
      const o = input.settings.offer;
      if (o.enabled && o.target.type === 'product' && !db.get('SELECT id FROM products WHERE id = ? AND location_id = ?', o.target.product_id, locationId)) throw bad('Angebot: Das Produkt gibt es in diesem Sub-Account nicht');
      if (o.enabled && o.target.type === 'form' && !db.get('SELECT id FROM forms WHERE id = ? AND location_id = ?', o.target.form_id, locationId)) throw bad('Angebot: Das Formular gibt es in diesem Sub-Account nicht');
      input.settings.registration.form_ids = input.settings.registration.form_ids.filter((f) => db.get('SELECT id FROM forms WHERE id = ? AND location_id = ?', f, locationId));
      const v = input.video;
      if (v.type === 'upload' && !db.get(`SELECT id FROM webinar_uploads WHERE id = ? AND location_id = ? AND webinar_id = ? AND status = 'complete'`, v.upload_id, locationId, webinarId ?? '')) throw bad('Video: Der Upload gehört nicht zu diesem Webinar oder ist noch nicht fertig');
      if (v.type === 'studio_clip' && !db.get(`SELECT id FROM video_clips WHERE id = ? AND location_id = ? AND status = 'ready'`, v.clip_id, locationId)) throw bad('Video: Den Clip gibt es im Video-Studio dieses Sub-Accounts nicht');
      if (v.type === 'studio_upload' && !db.get(`SELECT id FROM video_uploads WHERE id = ? AND location_id = ? AND status IN ('complete', 'used')`, v.upload_id, locationId)) throw bad('Video: Das Video gibt es im Video-Studio dieses Sub-Accounts nicht');
    };

    const removeFiles = (webinarId: string, keep?: string) => {
      for (const u of db.all<{ id: string; file: string }>('SELECT id, file FROM webinar_uploads WHERE webinar_id = ?', webinarId)) {
        if (u.id === keep) continue;
        rmSync(join(dir, u.file), { force: true });
        db.run('DELETE FROM webinar_uploads WHERE id = ?', u.id);
      }
    };

    const outList = (w: Webinar, stats: { registrations: number; attended: number; upcoming: number }, next: string | null) => ({
      id: w.id,
      slug: w.slug,
      title: w.title,
      status: w.status,
      presenter_name: w.presenter_name,
      duration_s: w.duration_s,
      video_type: w.video.type,
      registrations: stats.registrations,
      attended: stats.attended,
      upcoming_registrations: stats.upcoming,
      next_session: next,
      url: pageUrl(app, w),
      updated_at: w.updated_at,
    });
    const nextSession = (w: Webinar): string | null => (w.status === 'published' ? (bookable(app, w).find((s) => s.kind !== 'ondemand')?.start ?? null) : null);

    const outFull = (w: Webinar) => ({
      ...w,
      urls: urlsOf(app, w),
      tz: webinarTz(app, w),
      upcoming: w.status === 'published' || w.schedule.fixed.enabled || w.schedule.dates.length || w.schedule.jit.enabled || w.schedule.ondemand.enabled ? bookable(app, w) : [],
      problems: publishProblems(w),
      counts: counts(w.id),
    });
    const counts = (webinarId: string) => {
      const r = db.get<{ n: number; a: number; c: number }>(`SELECT COUNT(*) n, SUM(attended_at IS NOT NULL) a, SUM(status = 'cancelled') c FROM webinar_registrations WHERE webinar_id = ?`, webinarId);
      return { registrations: Number(r?.n ?? 0) - Number(r?.c ?? 0), attended: Number(r?.a ?? 0), cancelled: Number(r?.c ?? 0), questions: Number(db.get<{ n: number }>('SELECT COUNT(*) n FROM webinar_questions WHERE webinar_id = ?', webinarId)?.n ?? 0) };
    };

    // --- lookups for the editor ------------------------------------------------------------------------------------
    /** Video-Studio assets of this sub-account the room can play (clips and uploads) – empty without the Video-Studio. */
    router.get('/api/webinars/studio-assets', 'location', (ctx) => {
      const have = (t: string) => !!db.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, t);
      const clips = have('video_clips') ? db.all<any>(`SELECT id, title, duration, created_at FROM video_clips WHERE location_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 100`, ctx.locationId) : [];
      const uploads = have('video_uploads') ? db.all<any>(`SELECT id, name, size, created_at FROM video_uploads WHERE location_id = ? AND status IN ('complete', 'used') ORDER BY created_at DESC LIMIT 100`, ctx.locationId) : [];
      return { clips: clips.map((c) => ({ id: c.id, title: c.title, duration_s: Math.round(Number(c.duration) || 0), created_at: c.created_at })), uploads };
    });

    // --- webinars ------------------------------------------------------------------------------------------------------
    router.get('/api/webinars', 'location', (ctx) => {
      const rows = db.all(`SELECT * FROM webinars WHERE location_id = ? ORDER BY updated_at DESC LIMIT 500`, ctx.locationId).map(parseWebinar);
      // One grouped query for the numbers of all of them (never one per row).
      const nowIso = nowOf(app).toISOString();
      const agg = new Map(
        db
          .all<{ webinar_id: string; n: number; a: number; up: number }>(
            `SELECT webinar_id, COUNT(*) n, SUM(attended_at IS NOT NULL) a, SUM(CASE WHEN session_start > ? THEN 1 ELSE 0 END) up FROM webinar_registrations WHERE location_id = ? AND status = 'registered' GROUP BY webinar_id`,
            nowIso,
            ctx.locationId,
          )
          .map((r) => [r.webinar_id, r]),
      );
      return rows.map((w) => outList(w, { registrations: Number(agg.get(w.id)?.n ?? 0), attended: Number(agg.get(w.id)?.a ?? 0), upcoming: Number(agg.get(w.id)?.up ?? 0) }, nextSession(w)));
    });

    router.post('/api/webinars', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const input = cleanWebinar({ ...b, status: undefined }, { title: '', description: '', presenter_name: '', presenter_photo: '', video: NO_VIDEO, duration_s: 0, status: 'draft', schedule: DEFAULT_SCHEDULE, settings: defaultSettings() });
      if (b.status === 'published') throw bad('Ein neues Webinar startet als Entwurf – veröffentlichen kannst du es, sobald Video, Dauer und Termine eingerichtet sind');
      if (Number(db.get<{ n: number }>('SELECT COUNT(*) n FROM webinars WHERE location_id = ?', ctx.locationId)?.n ?? 0) >= 200) throw new HttpError(429, 'Höchstens 200 Webinare je Sub-Account');
      checkRefs(ctx.locationId, undefined, input);
      const row = { id: newId(), location_id: ctx.locationId, slug: uniqueSlug(String(b.slug || input.title), (s) => !!db.get('SELECT 1 FROM webinars WHERE slug = ?', s)), ...input, created_by: actor(ctx), created_at: now(), updated_at: now() };
      db.insert('webinars', row);
      return outFull(getWebinar(app, { id: row.id })!);
    });

    router.get('/api/webinars/:id', 'location', (ctx) => outFull(mine(ctx)));

    router.patch('/api/webinars/:id', 'location', (ctx) => {
      const w = mine(ctx);
      const b = ctx.body ?? {};
      const input = cleanWebinar(b, asInput(w));
      let slug = w.slug;
      if (b.slug !== undefined && String(b.slug).trim() && String(b.slug) !== w.slug) slug = uniqueSlug(String(b.slug), (s) => s !== w.slug && !!db.get('SELECT 1 FROM webinars WHERE slug = ?', s));
      if (input.status === 'published') {
        const problems = publishProblems(input);
        if (problems.length) throw bad(`Noch nicht bereit zum Veröffentlichen: ${problems.join('; ')}`);
      }
      checkRefs(ctx.locationId, w.id, input);
      // The video changed away from an upload: the file goes (and with it its disk space).
      if (input.video.type !== 'upload' && w.video.type === 'upload') removeFiles(w.id);
      else if (input.video.type === 'upload') removeFiles(w.id, input.video.upload_id);
      db.update('webinars', w.id, { ...input, slug, updated_at: now() }, ctx.locationId);
      return outFull(getWebinar(app, { id: w.id })!);
    });

    router.delete('/api/webinars/:id', 'location', (ctx) => {
      const w = mine(ctx);
      removeFiles(w.id);
      db.run('DELETE FROM webinars WHERE id = ? AND location_id = ?', w.id, ctx.locationId);
      return { ok: true, id: w.id, title: w.title };
    });

    router.post('/api/webinars/:id/duplicate', 'location', async (ctx) => {
      const w = mine(ctx);
      const copy = { ...asInput(w), title: `${w.title} (Kopie)`.slice(0, 160), status: 'draft' as const };
      const wid = newId();
      const keep = w.video.type === 'upload' ? NO_VIDEO : w.video;
      db.insert('webinars', { id: wid, location_id: ctx.locationId, slug: uniqueSlug(copy.title, (s) => !!db.get('SELECT 1 FROM webinars WHERE slug = ?', s)), ...copy, video: keep, created_by: actor(ctx), created_at: now(), updated_at: now() });
      if (w.video.type === 'upload') {
        const up = db.get<any>(`SELECT * FROM webinar_uploads WHERE id = ? AND webinar_id = ? AND status = 'complete'`, w.video.upload_id, w.id);
        if (up && existsSync(join(dir, up.file))) {
          const file = `${newId(20)}${extOf(up.file)}`;
          await copyFile(join(dir, up.file), join(dir, file));
          const uid = newId();
          db.insert('webinar_uploads', { id: uid, location_id: ctx.locationId, webinar_id: wid, name: up.name, file, size: up.size, received: up.size, status: 'complete', created_by: actor(ctx), created_at: now(), updated_at: now() });
          db.run('UPDATE webinars SET video = ? WHERE id = ?', JSON.stringify({ type: 'upload', upload_id: uid, name: up.name }), wid);
        }
      }
      return outFull(getWebinar(app, { id: wid })!);
    });

    // --- sessions, registrations, numbers -----------------------------------------------------------------------------
    router.get('/api/webinars/:id/sessions', 'location', (ctx) => {
      const w = mine(ctx);
      return { tz: webinarTz(app, w), sessions: bookable(app, w) };
    });

    router.get('/api/webinars/:id/registrations', 'location', (ctx) => {
      const w = mine(ctx);
      const where = ['r.webinar_id = ?', 'r.location_id = ?'];
      const params: (string | number)[] = [w.id, ctx.locationId];
      const session = String(ctx.query.get('session') ?? '').trim();
      if (session === 'ondemand') where.push(`r.session_kind = 'ondemand'`);
      else if (session) (where.push('r.session_start = ?'), params.push(session));
      const status = String(ctx.query.get('status') ?? '').trim();
      if (status === 'registered' || status === 'cancelled') (where.push('r.status = ?'), params.push(status));
      if (ctx.query.get('attended') === '1') where.push('r.attended_at IS NOT NULL');
      if (ctx.query.get('attended') === '0') where.push(`r.attended_at IS NULL AND r.session_start <= ?`), params.push(nowOf(app).toISOString());
      const q = String(ctx.query.get('q') ?? '').trim().slice(0, 80);
      if (q) (where.push(`(c.first_name || ' ' || c.last_name || ' ' || c.email) LIKE ?`), params.push(`%${q}%`));
      const total = Number(db.get<{ n: number }>(`SELECT COUNT(*) n FROM webinar_registrations r JOIN contacts c ON c.id = r.contact_id WHERE ${where.join(' AND ')}`, ...params)?.n ?? 0);
      const rows = db.all<any>(
        `SELECT r.*, c.first_name, c.last_name, c.email, c.phone FROM webinar_registrations r JOIN contacts c ON c.id = r.contact_id WHERE ${where.join(' AND ')} ORDER BY r.session_start DESC, r.created_at DESC LIMIT ? OFFSET ?`,
        ...params,
        clampLimit(ctx.query.get('limit'), 100, 500),
        Math.max(0, num(ctx.query.get('offset'), 0)),
      );
      return {
        total,
        registrations: rows.map((r) => ({
          id: r.id,
          contact_id: r.contact_id,
          name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email,
          email: r.email,
          phone: r.phone,
          session_start: r.session_start,
          session_kind: r.session_kind,
          status: r.status,
          source: r.source,
          attended: !!r.attended_at,
          watch_pct: r.watch_pct,
          watched_s: Math.round(r.watched_s),
          left_at: r.finalized_at ? r.left_at : null,
          cta_clicked: !!r.cta_clicked_at,
          cta_clicks: r.cta_clicks,
          purchased: !!r.purchased_at,
          purchase_cents: r.purchase_cents,
          replay_watched: !!r.replay_at,
          created_at: r.created_at,
        })),
      };
    });

    router.post('/api/webinars/:id/registrations', 'location', (ctx) => {
      const w = mine(ctx);
      const b = ctx.body ?? {};
      if (b.contact_id && !getContact(app, ctx.locationId, String(b.contact_id))) throw notFound('Kontakt nicht gefunden');
      const r = registerContact(app, w, {
        contact_id: b.contact_id ? String(b.contact_id) : undefined,
        email: b.email ? normalizeEmail(b.email) : undefined,
        first_name: str(b.first_name, 'Vorname', { max: 100 }),
        last_name: str(b.last_name, 'Nachname', { max: 100 }),
        phone: str(b.phone, 'Telefon', { max: 40 }),
        session: b.session ? String(b.session) : undefined,
        tz: b.tz ? String(b.tz) : undefined,
        source: ctx.via === 'mcp' ? 'mcp' : ctx.via === 'app' ? 'app' : 'team',
        silent: b.silent === true,
      });
      const links = linksOf(app, w, r.registration.id);
      return { id: r.registration.id, contact_id: r.contact.id, created: r.created, session: r.session, join_url: links.join_url, replay_url: links.replay_url, title: `${w.title}: ${r.contact.email}` };
    });

    router.delete('/api/webinars/:id/registrations/:rid', 'location', (ctx) => {
      const w = mine(ctx);
      const reg = getRegistration(app, ctx.params.rid);
      if (!reg || reg.webinar_id !== w.id || reg.location_id !== ctx.locationId) throw notFound('Anmeldung nicht gefunden');
      cancelRegistration(app, w, reg, actor(ctx) || 'Team');
      return { ok: true, id: reg.id };
    });

    router.get('/api/webinars/:id/stats', 'location', (ctx) => webinarStats(app, mine(ctx)));

    router.get('/api/webinars/:id/questions', 'location', (ctx) => {
      const w = mine(ctx);
      return db
        .all<any>(
          `SELECT q.id, q.contact_id, q.session_start, q.offset_s, q.body, q.created_at, c.first_name, c.last_name, c.email, m.conversation_id
           FROM webinar_questions q JOIN contacts c ON c.id = q.contact_id LEFT JOIN messages m ON m.id = q.message_id
           WHERE q.webinar_id = ? AND q.location_id = ? ORDER BY q.created_at DESC LIMIT ?`,
          w.id,
          ctx.locationId,
          clampLimit(ctx.query.get('limit'), 100, 500),
        )
        .map((q) => ({ id: q.id, contact_id: q.contact_id, name: [q.first_name, q.last_name].filter(Boolean).join(' ') || q.email, email: q.email, session_start: q.session_start, offset_s: q.offset_s === null ? null : Math.round(q.offset_s), body: q.body, conversation_id: q.conversation_id, created_at: q.created_at }));
    });

    /** A link to the room for the team: runs from a chosen second, counts nothing, stores nothing. */
    router.post('/api/webinars/:id/preview-link', 'location', (ctx) => {
      const w = mine(ctx);
      const offset = Math.max(0, Math.min(Math.round(num(ctx.body?.offset_s, 0)), Math.max(0, w.duration_s - 1), 999_999));
      const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
      const url = `${pageUrl(app, w)}/watch?p=${encodeURIComponent(previewToken(app.config.secret, w.id, exp, offset))}`;
      return { url, expires_at: new Date(exp * 1000).toISOString(), offset_s: offset };
    });

    // --- the video file (chunked: robust behind proxies, never the whole file in memory) -------------------------------
    const prevLimit = app.services.rawBodyLimit;
    app.services.rawBodyLimit = (method: string, path: string, req: any, cookies: Record<string, string>): number | undefined =>
      method === 'PUT' && /^\/api\/webinars\/[A-Za-z0-9]{8,32}\/video\/upload\/[A-Za-z0-9]{8,32}$/.test(path) && (cookies.pghl_session || req.headers.authorization) ? CHUNK + 4096 : prevLimit?.(method, path, req, cookies);

    router.post('/api/webinars/:id/video/upload', 'location', (ctx) => {
      const w = mine(ctx);
      const name = str(ctx.body?.name, 'Dateiname', { required: true, max: 200 });
      const size = Math.round(Number(ctx.body?.size));
      if (!VIDEO_EXT.includes(extOf(name))) throw bad(`Nur Videodateien (${VIDEO_EXT.join(', ')})`);
      if (!(size > 0)) throw bad('Dateigröße fehlt');
      if (size > maxUploadMb() * 1024 * 1024) throw bad(`Datei größer als ${maxUploadMb()} MB (Grenze einstellbar mit PGHL_WEBINAR_MAX_MB)`);
      if (Number(db.get<{ n: number }>(`SELECT COUNT(*) n FROM webinar_uploads WHERE location_id = ? AND status = 'open'`, ctx.locationId)?.n ?? 0) >= 3) throw new HttpError(429, 'Es laufen schon 3 Uploads – bitte warten');
      mkdirSync(dir, { recursive: true });
      try {
        const fs = statfsSync(dir);
        if (fs.bavail * fs.bsize < size * 1.1 + 256 * 1024 * 1024) throw new HttpError(507, 'Nicht genug freier Speicher auf dem Server für diese Datei');
      } catch (e) {
        if (e instanceof HttpError) throw e;
      }
      // An unfinished earlier upload of this webinar is dropped.
      for (const o of db.all<{ id: string; file: string }>(`SELECT id, file FROM webinar_uploads WHERE webinar_id = ? AND status = 'open'`, w.id)) {
        rmSync(join(dir, o.file), { force: true });
        db.run('DELETE FROM webinar_uploads WHERE id = ?', o.id);
      }
      const row = { id: newId(), location_id: ctx.locationId, webinar_id: w.id, name, file: `${newId(20)}${extOf(name)}`, size, received: 0, status: 'open', created_by: actor(ctx), created_at: now(), updated_at: now() };
      writeFileSync(join(dir, row.file), '');
      db.insert('webinar_uploads', row);
      return { id: row.id, chunk_size: CHUNK, size, received: 0 };
    });

    router.put('/api/webinars/:id/video/upload/:uid', 'location', (ctx) => {
      const w = mine(ctx);
      const up = db.get<any>('SELECT * FROM webinar_uploads WHERE id = ? AND webinar_id = ? AND location_id = ?', ctx.params.uid, w.id, ctx.locationId);
      if (!up) throw notFound('Upload nicht gefunden');
      if (up.status !== 'open') return { id: up.id, received: up.received, complete: true };
      const buf = ctx.rawBuffer;
      if (!buf?.length) throw bad('Daten fehlen (Teil der Datei als Rohdaten im Body)');
      if (buf.length > CHUNK) throw bad(`Höchstens ${CHUNK / 1024 / 1024} MB pro Teil`);
      const offset = Number(ctx.query.get('offset') ?? up.received);
      if (offset !== up.received) {
        if (offset + buf.length === up.received) return { id: up.id, received: up.received, complete: false };
        throw new HttpError(409, `Erwartet wird der Teil ab Byte ${up.received}`);
      }
      if (offset + buf.length > up.size) throw bad('Mehr Daten als angekündigt');
      if (offset === 0 && !looksLikeVideo(buf)) {
        rmSync(join(dir, up.file), { force: true });
        db.run('DELETE FROM webinar_uploads WHERE id = ?', up.id);
        throw bad('Das ist keine Videodatei (MP4, MOV, WebM, MKV, Ogg)');
      }
      appendFileSync(join(dir, up.file), buf);
      const received = offset + buf.length;
      const complete = received === up.size;
      db.run('UPDATE webinar_uploads SET received = ?, status = ?, updated_at = ? WHERE id = ?', received, complete ? 'complete' : 'open', now(), up.id);
      if (complete) {
        // The finished file becomes the webinar's video; an earlier file is deleted.
        db.run('UPDATE webinars SET video = ?, updated_at = ? WHERE id = ?', JSON.stringify({ type: 'upload', upload_id: up.id, name: up.name }), now(), w.id);
        removeFiles(w.id, up.id);
      }
      return { id: up.id, received, complete };
    });

    // --- background: reminders and end-of-session bookkeeping run in webinar-automation.ts -----------------------------
    app.services.webinars = {
      get: (id: string, locationId?: string) => getWebinar(app, { id }, locationId),
      tick: async (at?: Date) => ({ finalized: await finalizeDue(app, at), reminders: await sendDueReminders(app, at) }),
      uploadDir: dir,
      /** Removes upload files that belong to no row (deleted sub-account, interrupted delete). */
      sweep: () => {
        if (!existsSync(dir)) return 0;
        const known = new Set(db.all<{ file: string }>('SELECT file FROM webinar_uploads').map((r) => r.file));
        let n = 0;
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (known.has(f) || Date.now() - statSync(p).mtimeMs < 86_400_000) continue;
          rmSync(p, { force: true });
          n++;
        }
        return n;
      },
    };
  },
};
