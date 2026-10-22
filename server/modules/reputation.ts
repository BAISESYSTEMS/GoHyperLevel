import type { Module } from '../core/app.js';
import { HttpError, bad, html, notFound, num, str } from '../core/http.js';
import { messagePage, noscriptNotice, publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { now } from '../core/util.js';
import { contactName, getContact, logActivity } from '../services/contacts.js';
import { notifyTeam } from '../services/messaging.js';
import { sendReviewRequest } from '../services/reviews.js';

export const reputationModule: Module = {
  name: 'reputation',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE review_requests (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, token TEXT NOT NULL UNIQUE, channel TEXT NOT NULL DEFAULT 'email',
        rating INTEGER, comment TEXT NOT NULL DEFAULT '', public INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, responded_at TEXT
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    router.get('/api/reviews', 'location', (ctx) => {
      const rows = db.all(
        `SELECT r.*, c.first_name, c.last_name, c.email FROM review_requests r LEFT JOIN contacts c ON c.id = r.contact_id
         WHERE r.location_id = ? ORDER BY COALESCE(r.responded_at, r.created_at) DESC LIMIT 1000`,
        ctx.locationId,
      );
      const rated = rows.filter((r) => r.rating);
      return {
        requests: rows,
        stats: {
          sent: rows.length,
          responses: rated.length,
          average: rated.length ? Math.round((rated.reduce((s, r) => s + r.rating, 0) / rated.length) * 10) / 10 : null,
          distribution: [1, 2, 3, 4, 5].map((n) => rated.filter((r) => r.rating === n).length),
        },
        widget: `<iframe src="${app.baseUrl()}/r/widget/${ctx.locationId}" style="width:100%;border:0;min-height:320px"></iframe>`,
      };
    });
    router.post('/api/reviews/request', 'location', async (ctx) => {
      const cid = str(ctx.body.contact_id, 'Kontakt', { required: true });
      if (!getContact(app, ctx.locationId, cid)) throw notFound('Kontakt nicht gefunden');
      try {
        return await sendReviewRequest(app, ctx.locationId, cid, ctx.body.channel === 'sms' ? 'sms' : 'email');
      } catch (e) {
        throw bad((e as Error).message);
      }
    });
    router.patch('/api/reviews/:id', 'location', (ctx) => {
      if (!db.update('review_requests', ctx.params.id, { public: ctx.body.public ? 1 : 0 }, ctx.locationId)) throw notFound();
      return db.get('SELECT * FROM review_requests WHERE id = ?', ctx.params.id);
    });

    router.get('/r/:token', 'public', (ctx) => {
      const r = db.get('SELECT * FROM review_requests WHERE token = ?', ctx.params.token);
      if (!r) return html(messagePage('Nicht gefunden', 'Dieser Link ist nicht gültig.'), 404);
      const loc = app.location(r.location_id)!;
      if (r.rating) return html(messagePage('Danke!', 'Deine Bewertung ist schon bei uns angekommen.'));
      const body = `<div class="wrap" style="max-width:560px"><div class="card" style="text-align:center">
        <h1>Wie war es bei ${escapeHtml(loc.name)}?</h1><p class="muted" id="rv-hint">Tippe auf die Sterne.</p>${noscriptNotice('eine Bewertung abzugeben')}
        <div id="stars" role="group" aria-labelledby="rv-hint" style="user-select:none">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="rv-star" data-n="${n}" aria-pressed="false" aria-label="${n} von 5 Sternen">☆</button>`).join('')}</div>
        <style>.rv-star{background:none;color:inherit;border:0;border-radius:8px;padding:0 2px;font-size:44px;line-height:1;min-width:44px;min-height:44px;cursor:pointer}.rv-star:focus-visible{outline:2px solid var(--brand);outline-offset:2px}</style>
        <form id="f" hidden style="text-align:left"><label for="rv-comment">Was können wir besser machen? (optional)</label><textarea id="rv-comment" name="comment"></textarea>
        <label class="check"><input type="checkbox" name="public" value="1"> Meine Bewertung darf auf der Webseite gezeigt werden</label>
        <p><button type="submit">Absenden</button></p><p class="error" id="rv-err" role="alert"></p></form><div id="done" class="ok" hidden></div></div></div>
        <script>
        let rating = 0; const stars = [...document.querySelectorAll('#stars button')];
        stars.forEach(s => s.onclick = () => { rating = +s.dataset.n; stars.forEach(x => { x.textContent = +x.dataset.n <= rating ? '★' : '☆'; x.setAttribute('aria-pressed', String(+x.dataset.n === rating)); }); document.getElementById('f').hidden = false; });
        document.getElementById('f').onsubmit = async (e) => { e.preventDefault(); const fd = new FormData(e.target); const err = document.getElementById('rv-err'); err.textContent = '';
          const r = await fetch('/api/public/reviews/${escapeHtml(r.token)}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating, comment: fd.get('comment'), public: !!fd.get('public') }) }).catch(() => null);
          const j = r ? await r.json().catch(() => ({})) : {};
          if (!r || !r.ok) { err.textContent = j.error || 'Das hat nicht geklappt – bitte versuch es noch einmal.'; return; }
          if (j.redirect) { location.href = j.redirect; return; }
          e.target.hidden = true; document.getElementById('stars').hidden = true; const d = document.getElementById('done'); d.hidden = false; d.textContent = 'Vielen Dank für dein Feedback!'; };
        </script>`;
      return html(publicPage({ title: `Bewertung – ${loc.name}`, body }));
    });
    router.post('/api/public/reviews/:token', 'public', (ctx) => {
      const r = db.get('SELECT * FROM review_requests WHERE token = ?', ctx.params.token);
      if (!r) throw notFound();
      if (r.rating) throw new HttpError(409, 'Schon bewertet');
      const rating = Math.round(num(ctx.body.rating));
      if (rating < 1 || rating > 5) throw bad('1 bis 5 Sterne');
      const comment = str(ctx.body.comment, 'Kommentar', { max: 5000 });
      db.run('UPDATE review_requests SET rating = ?, comment = ?, public = ?, responded_at = ? WHERE id = ?', rating, comment, ctx.body.public ? 1 : 0, now(), r.id);
      const loc = app.location(r.location_id)!;
      const settings = loc.settings.reviews ?? {};
      if (r.contact_id) logActivity(app, r.location_id, r.contact_id, 'review.received', `Bewertung: ${'★'.repeat(rating)}${comment ? ` – ${comment.slice(0, 80)}` : ''}`);
      const c = r.contact_id ? getContact(app, r.location_id, r.contact_id) : undefined;
      if (rating < Number(settings.threshold ?? 4)) void notifyTeam(app, r.location_id, `Kritisches Feedback (${rating}★)`, `${contactName(c)}: ${comment || '(kein Kommentar)'}`);
      app.events.emit(r.location_id, 'review.received', { contactId: r.contact_id, rating, comment });
      // Happy customers go on to the public profile (Google, Trustpilot…), the rest stays internal.
      const redirect = rating >= Number(settings.threshold ?? 4) && /^https?:\/\//.test(settings.public_url ?? '') ? settings.public_url : undefined;
      return { ok: true, redirect };
    });
    router.get('/r/widget/:loc', 'public', (ctx) => {
      const loc = app.location(ctx.params.loc);
      if (!loc) throw notFound();
      const rows = db.all(
        `SELECT r.rating, r.comment, r.responded_at, c.first_name, c.last_name FROM review_requests r LEFT JOIN contacts c ON c.id = r.contact_id
         WHERE r.location_id = ? AND r.public = 1 AND r.rating >= 4 AND r.comment != '' ORDER BY r.responded_at DESC LIMIT 30`,
        loc.id,
      );
      // Google rating badge and reviews (google-reviews), then every other platform (review-sources: app.services.reviewWidgetParts).
      const parts: { header: string; cards: string[] }[] = [app.services.reviewWidgetGoogle?.(loc.id), ...((app.services.reviewWidgetParts ?? []) as ((l: string) => { header: string; cards: string[] } | undefined)[]).map((fn) => fn(loc.id))].filter(
        (x): x is { header: string; cards: string[] } => !!x,
      );
      const body = `<div class="wrap" style="max-width:none">${parts.map((p) => p.header).join('')}<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px">${rows
        .map((r) => `<div class="card" style="padding:18px"><div style="color:#f59e0b">${'★'.repeat(r.rating)}</div><p>${escapeHtml(r.comment)}</p><p class="muted" style="font-size:13px">${escapeHtml(r.first_name ?? '')} ${escapeHtml((r.last_name ?? '').slice(0, 1))}.</p></div>`)
        .join('')}${parts.flatMap((p) => p.cards).join('')}</div></div>`;
      return html(publicPage({ title: `Bewertungen – ${loc.name}`, body, embed: true }));
    });
  },
};
