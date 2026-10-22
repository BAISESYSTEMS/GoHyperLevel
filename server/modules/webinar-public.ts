import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, redirect, str, type Ctx, type RawResult } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { escapeHtml as esc } from '../core/template.js';
import { isValidTz } from '../core/time.js';
import { normalizeEmail } from '../core/util.js';
import { bookable, cancelRegistration, icsOf, nowOf, registerContact, resendConfirmation } from '../services/webinar-register.js';
import { readJoinToken, readPreviewToken } from '../services/webinar-model.js';
import { noticePage, registrationPage, roomConfig, roomPage } from '../services/webinar-pages.js';
import { clockFor, conversationOf, ctaClick, askQuestion, ping, replayWindow, vote } from '../services/webinar-track.js';
import { getRegistration, getWebinar, linksOf, pageUrl, type Registration, type Webinar } from '../services/webinar-store.js';
import { parseRange } from '../services/webinar-video.js';

/**
 * The public side of a webinar: `/w/<slug>` (registration, also as embed), `/w/<slug>/watch?t=<token>` (the room),
 * `/replay`, the calendar file, the video stream and the offer link – plus the small JSON API the pages use. Every viewer
 * action is bound to a signed token (registration id + signature); nothing here reads another sub-account's data because
 * the token leads to one registration and that one to one webinar.
 */

/** A registration is 20 per minute and address (forms use the same ceiling); the general public-write limit comes on top. */
const recent = new Map<string, number[]>();
function limited(ip: string): boolean {
  const t = Date.now();
  const list = (recent.get(ip) ?? []).filter((x) => t - x < 60_000);
  list.push(t);
  recent.set(ip, list);
  if (recent.size > 20_000) recent.clear();
  return list.length > 20;
}

const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg' };

export const webinarPublicModule: Module = {
  name: 'webinar-public',
  register(app) {
    const { db, router } = app;
    const assets = join(app.config.dataDir, 'webinar-assets');
    // A custom funnel domain keeps serving the webinar pages (its other paths belong to the funnel).
    app.rewrites.unshift((_host, path) => (path.startsWith('/w/') ? path : undefined));

    const published = (slug: string): Webinar => {
      const w = getWebinar(app, { slug });
      if (!w || w.status !== 'published') throw notFound('Dieses Webinar gibt es nicht (oder es ist gerade nicht veröffentlicht)');
      return w;
    };
    /** The registration a token leads to, for this webinar. */
    const viewer = (slug: string, token: unknown): { w: Webinar; reg: Registration } => {
      const w = published(slug);
      const id = readJoinToken(app.config.secret, token);
      const reg = id ? getRegistration(app, id) : undefined;
      if (!reg || reg.webinar_id !== w.id || reg.location_id !== w.location_id) throw new HttpError(404, 'Dieser Link ist ungültig');
      if (reg.status === 'cancelled') throw new HttpError(410, 'Diese Anmeldung wurde abgesagt');
      return { w, reg };
    };
    /** Pages answer a bad link with a page, not JSON. */
    const asPage = (fn: () => RawResult | Promise<RawResult>) => async (): Promise<RawResult> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof HttpError) return noticePage(app, e.status === 410 ? 'Nicht mehr verfügbar' : 'Seite nicht gefunden', e.message, e.status);
        throw e;
      }
    };

    // --- optional hls.js, dropped into data/webinar-assets/ by whoever runs the server --------------------------------
    const hlsFile = () => join(assets, 'hls.min.js');
    router.get('/w/_hls.js', 'public', () => {
      if (!existsSync(hlsFile())) throw notFound();
      return { __raw: true, status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' }, body: readFileSync(hlsFile()) } as RawResult;
    });

    // --- pages ----------------------------------------------------------------------------------------------------------
    router.get('/w/:slug', 'public', (ctx) =>
      asPage(() => {
        const w = published(ctx.params.slug);
        const attr = app.services.attribution?.visit(ctx, w.location_id) ?? '';
        return registrationPage(app, w, { embed: ctx.query.get('embed') === '1', attr });
      })(),
    );

    router.get('/w/:slug/watch', 'public', (ctx) =>
      asPage(() => {
        const at = nowOf(app);
        const hls = existsSync(hlsFile());
        const p = ctx.query.get('p');
        if (p) {
          // The team's preview: allowed for drafts too, valid for a few hours, counts nothing.
          const w = getWebinar(app, { slug: ctx.params.slug });
          const pv = w && readPreviewToken(app.config.secret, w.id, p, Date.now());
          if (!w || !pv) throw new HttpError(404, 'Dieser Vorschau-Link ist ungültig oder abgelaufen');
          return roomPage(app, w, roomConfig(app, w, undefined, 'preview', at, { token: p, previewOffset: pv.offset }), hls);
        }
        const t = String(ctx.query.get('t') ?? '');
        const { w, reg } = viewer(ctx.params.slug, t);
        return roomPage(app, w, roomConfig(app, w, reg, 'live', at, { token: t }), hls);
      })(),
    );

    router.get('/w/:slug/replay', 'public', (ctx) =>
      asPage(() => {
        const t = String(ctx.query.get('t') ?? '');
        const { w, reg } = viewer(ctx.params.slug, t);
        const at = nowOf(app);
        const win = replayWindow(w, reg, at);
        if (!win.available) {
          const why = win.reason === 'expired' ? 'Die Aufzeichnung ist leider nicht mehr verfügbar.' : win.reason === 'not_yet' ? 'Die Aufzeichnung steht nach dem Webinar bereit.' : 'Zu diesem Webinar gibt es keine Aufzeichnung.';
          return noticePage(app, w.title, why, win.reason === 'expired' ? 410 : 200, win.reason === 'not_yet' ? { href: linksOf(app, w, reg.id).join_url, label: 'Zum Webinar-Raum' } : undefined);
        }
        return roomPage(app, w, roomConfig(app, w, reg, 'replay', at, { token: t }), existsSync(hlsFile()));
      })(),
    );

    router.get('/w/:slug/ics', 'public', (ctx) => {
      const { w, reg } = viewer(ctx.params.slug, ctx.query.get('t'));
      return { __raw: true, status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="webinar.ics"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: icsOf(app, w, reg) } as RawResult;
    });

    // The offer button: counted, then on to the product, the form or the link.
    router.get('/w/:slug/go', 'public', (ctx) =>
      asPage(() => {
        const { w, reg } = viewer(ctx.params.slug, ctx.query.get('t'));
        const r = ctaClick(app, w, reg, nowOf(app));
        if (r.url) return redirect(r.url);
        if (r.expired) return noticePage(app, 'Das Angebot ist beendet', 'Die Frist für dieses Angebot ist abgelaufen.', 410);
        return noticePage(app, 'Kein Angebot', 'Zu diesem Webinar gibt es gerade kein Angebot.', 404);
      })(),
    );

    // Cancelling a seat: a page with a button (a mail scanner opening the link must not cancel it).
    router.get('/w/:slug/cancel', 'public', (ctx) =>
      asPage(() => {
        const t = String(ctx.query.get('t') ?? '');
        const { w } = viewer(ctx.params.slug, t);
        const body = `<div class="wrap"><div class="card"><h1>Anmeldung absagen?</h1><p class="muted">Du bekommst dann keine Erinnerungen mehr für „${esc(w.title)}“.</p><form method="post" action="${esc(pageUrl(app, w))}/cancel?t=${encodeURIComponent(t)}"><button type="submit">Ja, absagen</button> <a class="btn secondary" href="${esc(pageUrl(app, w))}/watch?t=${encodeURIComponent(t)}">Nein, zurück</a></form></div></div>`;
        return { __raw: true, status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` }, body: publicPage({ title: 'Anmeldung absagen', body }) };
      })(),
    );
    router.post('/w/:slug/cancel', 'public', (ctx) =>
      asPage(() => {
        const { w, reg } = viewer(ctx.params.slug, ctx.query.get('t'));
        cancelRegistration(app, w, reg, 'über den Link');
        return noticePage(app, 'Anmeldung abgesagt', 'Deine Anmeldung ist abgesagt. Du kannst dich jederzeit neu anmelden.', 200, { href: pageUrl(app, w), label: 'Neu anmelden' });
      })(),
    );

    // --- the video ----------------------------------------------------------------------------------------------------
    const stream = (path: string, ctx: Ctx, mime: string): RawResult => {
      const size = statSync(path).size;
      const head: Record<string, string> = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
      const wanted = ctx.req.headers.range;
      const range = parseRange(wanted, size);
      if (wanted && !range) return { __raw: true, status: 416, headers: { ...head, 'content-range': `bytes */${size}` }, body: '' };
      if (range) return { __raw: true, status: 206, headers: { ...head, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': String(range.end - range.start + 1) }, body: createReadStream(path, range) };
      return { __raw: true, status: 200, headers: { ...head, 'content-length': String(size) }, body: createReadStream(path) };
    };

    router.get('/w/:slug/media', 'public', async (ctx) => {
      const at = nowOf(app);
      let w: Webinar;
      const p = ctx.query.get('p');
      if (p) {
        const found = getWebinar(app, { slug: ctx.params.slug });
        if (!found || !readPreviewToken(app.config.secret, found.id, p, Date.now())) throw new HttpError(404, 'Ungültig');
        w = found;
      } else {
        const v = viewer(ctx.params.slug, ctx.query.get('t'));
        w = v.w;
        // The file is handed out while the session runs (or the recording is open) – not to the waiting room.
        const state = clockFor(w, v.reg, at).state;
        if (!(state === 'running' || replayWindow(w, v.reg, at).available)) throw new HttpError(403, 'Das Video ist gerade nicht freigegeben');
      }
      const v = w.video;
      if (v.type === 'upload') {
        const up = db.get<any>(`SELECT * FROM webinar_uploads WHERE id = ? AND webinar_id = ? AND location_id = ? AND status = 'complete'`, v.upload_id, w.id, w.location_id);
        const path = up && join(app.config.dataDir, 'webinars', up.file);
        if (!up || !existsSync(path)) throw notFound('Video nicht gefunden');
        return stream(path, ctx, MIME[(/\.[a-z0-9]+$/.exec(up.file) ?? [''])[0]] ?? 'video/mp4');
      }
      if (v.type === 'studio_upload') {
        const up = db.get<any>(`SELECT * FROM video_uploads WHERE id = ? AND location_id = ? AND status IN ('complete', 'used')`, v.upload_id, w.location_id);
        const path = up && join(app.config.dataDir, 'video-studio', 'uploads', up.file);
        if (!up || !existsSync(path)) throw notFound('Video nicht gefunden');
        return stream(path, ctx, MIME[(/\.[a-z0-9]+$/.exec(up.file) ?? [''])[0]] ?? 'video/mp4');
      }
      if (v.type === 'studio_clip') {
        const clip = db.get<any>(`SELECT * FROM video_clips WHERE id = ? AND location_id = ? AND status = 'ready'`, v.clip_id, w.location_id);
        const proxy = app.services.videoStudio?.proxy as ((path: string, ctx: Ctx) => Promise<RawResult>) | undefined;
        if (!clip || !proxy) throw notFound('Video nicht gefunden');
        return proxy(clip.video_path, ctx);
      }
      throw notFound('Zu diesem Webinar gibt es keine Datei');
    });

    // --- JSON for the pages ---------------------------------------------------------------------------------------
    router.get('/api/public/webinars/:slug', 'public', (ctx) => {
      const w = published(ctx.params.slug);
      return {
        slug: w.slug,
        title: w.title,
        description: w.description,
        presenter: { name: w.presenter_name, photo: w.presenter_photo },
        label: w.settings.room.label,
        duration_s: w.duration_s,
        sessions: bookable(app, w).map((s) => ({ start: s.start, kind: s.kind, full: s.full })),
        url: pageUrl(app, w),
      };
    });

    router.post('/api/public/webinars/:slug/register', 'public', (ctx) => {
      if (limited(ctx.ip)) throw new HttpError(429, 'Zu viele Anfragen – bitte kurz warten');
      const w = published(ctx.params.slug);
      const b = ctx.body ?? {};
      // Hidden field only bots fill in: a polite "yes" and nothing stored.
      if (b._hp) return { ok: true, spam: true };
      const s = w.settings.registration;
      if (b.consent !== true) throw bad('Bitte stimme der Verarbeitung deiner Angaben zu, um dich anzumelden');
      const phone = str(b.phone, 'Telefon', { max: 40 });
      if (s.phone_required && !phone) throw bad('Bitte gib deine Telefonnummer an');
      const email = normalizeEmail(b.email);
      const r = registerContact(app, w, {
        email,
        first_name: str(b.first_name, 'Vorname', { max: 100 }),
        last_name: str(b.last_name, 'Nachname', { max: 100 }),
        phone,
        session: str(b.session, 'Termin', { max: 40 }),
        tz: isValidTz(String(b.tz ?? '')) ? String(b.tz) : undefined,
        source: 'page',
        consent: true,
        sms_consent: b.sms_consent === true && !!phone,
      });
      if (r.created) app.services.attribution?.capture(ctx, w.location_id, r.contact.id, 'webinar', { attr: b._a, page: b._page, referrer: b._referrer, params: b });
      else void resendConfirmation(app, w, r.registration).catch(() => undefined);
      // The consent of the registration page (and the SMS box) goes into the consent ledger (modules/consent-capture.ts).
      app.services.consent?.captureWebinar?.(ctx, w, r, b);
      const ondemand = r.session.kind === 'ondemand';
      // The personal link goes by e-mail (that proves the address is theirs); only a session that starts right now opens at once.
      return { ok: true, created: r.created, session: r.session, ...(ondemand ? { join_url: linksOf(app, w, r.registration.id).join_url } : {}) };
    });

    router.post('/api/public/webinars/:slug/ping', 'public', (ctx) => {
      const { w, reg } = viewer(ctx.params.slug, ctx.body?.t);
      const at = nowOf(app);
      const replay = ctx.body?.mode === 'replay';
      const r = ping(app, w, reg, { mode: replay ? 'replay' : 'live', pos: Number(ctx.body?.pos), playing: ctx.body?.playing === true }, at);
      const fresh = getRegistration(app, reg.id) ?? reg;
      const win = replayWindow(w, fresh, at);
      return { server_now: at.getTime(), clock: r.clock, ...(r.counter !== undefined ? { counter: r.counter } : {}), replay: { available: win.available, reason: win.reason, until: win.until, url: linksOf(app, w, reg.id).replay_url }, answers: conversationOf(app, w, fresh).answers };
    });

    router.post('/api/public/webinars/:slug/question', 'public', (ctx) => {
      const { w, reg } = viewer(ctx.params.slug, ctx.body?.t);
      return { ok: true, ...askQuestion(app, w, reg, String(ctx.body?.text ?? ''), nowOf(app)) };
    });

    router.post('/api/public/webinars/:slug/vote', 'public', (ctx) => {
      const { w, reg } = viewer(ctx.params.slug, ctx.body?.t);
      const poll = w.settings.room.polls.find((p) => p.id === String(ctx.body?.poll_id ?? ''));
      const r = vote(app, w, reg, String(ctx.body?.poll_id ?? ''), ctx.body?.choice);
      return { ok: true, mine: r.mine, counts: poll?.show_results ? r.counts : null };
    });
  },
};
