import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, html, notFound, type Ctx } from '../core/http.js';
import { messagePage } from '../core/page.js';
import { id, now } from '../core/util.js';
import { auditLog, json, limiter } from '../services/creator-kit.js';
import { callRoute } from '../services/route-call.js';
import { askChecked, estimate } from '../services/site-ai-kit.js';
import { LANGS, TONES, WRITE_KINDS, checkWritten, estimateTokens, writerRules, type WriteKind } from '../services/site-ai.js';
import { cleanBlocks } from '../services/site-layout.js';

/**
 * Funnel & Website AI, the safety net around generation: AI-built sites stay DRAFTS (off the public web – /p/<site>, custom
 * domains, sitemap – until someone clicks „Veröffentlichen“), RESTORE POINTS of a page taken before an AI change is applied in the
 * editor (the last 20 per page, 30 days), and the AI WRITER for blog posts and e-mail text blocks – the same service, model routing,
 * cost estimate and monthly limit (purpose `site_writer`). Hooks: `app.services.siteAiDrafts` (`mark`, `isDraft`, `restorePoint`).
 */

const KEEP_POINTS = 20;

export const siteAiDraftsModule: Module = {
  name: 'site-ai-drafts',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE site_ai_drafts (
        funnel_id TEXT PRIMARY KEY REFERENCES funnels(id) ON DELETE CASCADE, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        run_id TEXT, created_at TEXT NOT NULL, published_at TEXT, published_by TEXT
      );
      CREATE INDEX site_ai_drafts_loc ON site_ai_drafts(location_id);
      CREATE TABLE site_ai_restore_points (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
        page_id TEXT NOT NULL REFERENCES funnel_pages(id) ON DELETE CASCADE, run_id TEXT, label TEXT NOT NULL DEFAULT '', blocks TEXT NOT NULL DEFAULT '[]',
        user_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, restored_at TEXT
      );
      CREATE INDEX site_ai_restore_page ON site_ai_restore_points(page_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const writable = (ctx: Ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
    };
    const isDraft = (fid: string) => !!db.get('SELECT 1 FROM site_ai_drafts WHERE funnel_id = ? AND published_at IS NULL', fid);

    app.services.siteAiDrafts = {
      mark: (locationId: string, funnelId: string, runId: string | null) => db.run('INSERT OR REPLACE INTO site_ai_drafts (funnel_id, location_id, run_id, created_at, published_at, published_by) VALUES (?, ?, ?, ?, NULL, NULL)', funnelId, locationId, runId, now()),
      isDraft,
      restorePoint: (ctx: Ctx, o: { page: any; blocks: unknown[]; runId: string | null; label: string }) => {
        const row = { id: id(), location_id: ctx.locationId, funnel_id: o.page.funnel_id, page_id: o.page.id, run_id: o.runId, label: o.label.slice(0, 120), blocks: JSON.stringify(o.blocks), user_name: ctx.user?.name ?? '', created_at: now(), restored_at: null };
        db.insert('site_ai_restore_points', row);
        const old = db.all<{ id: string }>('SELECT id FROM site_ai_restore_points WHERE page_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?', o.page.id, KEEP_POINTS);
        for (const r of old) db.run('DELETE FROM site_ai_restore_points WHERE id = ?', r.id);
        return { id: row.id, created_at: row.created_at };
      },
    };

    // --- drafts stay off the public web --------------------------------------------------------------------------------
    // The page pipeline asks app.services.siteRedirect first (modules/site-routing.ts) – a draft answers 404 there, for every path.
    const previous = app.services.siteRedirect as ((ctx: Ctx, f: any, segments: string[]) => unknown) | undefined;
    app.services.siteRedirect = (ctx: Ctx, f: any, segments: string[]) => {
      if (f?.id && isDraft(f.id)) {
        const r = html(messagePage('Noch nicht veröffentlicht', 'Diese Seite wird gerade vorbereitet.'), 404);
        r.headers['cache-control'] = 'no-store';
        r.headers['x-robots-tag'] = 'noindex';
        return r;
      }
      return previous?.(ctx, f, segments);
    };

    router.get('/api/site-ai/drafts', 'location', (ctx) => db.all('SELECT funnel_id, run_id, created_at FROM site_ai_drafts WHERE location_id = ? AND published_at IS NULL ORDER BY created_at DESC', ctx.locationId));
    router.get('/api/site-ai/drafts/:funnelId', 'location', (ctx) => {
      const f = db.get('SELECT id FROM funnels WHERE id = ? AND location_id = ?', ctx.params.funnelId, ctx.locationId);
      if (!f) throw notFound('Website/Funnel nicht gefunden');
      const d = db.get<any>('SELECT * FROM site_ai_drafts WHERE funnel_id = ?', f.id);
      return { funnel_id: f.id, draft: !!d && !d.published_at, ai: !!d, run_id: d?.run_id ?? null, created_at: d?.created_at ?? null, published_at: d?.published_at ?? null };
    });
    router.post('/api/site-ai/drafts/:funnelId/publish', 'location', (ctx) => {
      writable(ctx);
      const f = db.get<{ id: string; name: string }>('SELECT id, name FROM funnels WHERE id = ? AND location_id = ?', ctx.params.funnelId, ctx.locationId);
      if (!f) throw notFound('Website/Funnel nicht gefunden');
      const r = db.run('UPDATE site_ai_drafts SET published_at = ?, published_by = ? WHERE funnel_id = ? AND published_at IS NULL', now(), ctx.user?.name ?? '', f.id);
      if (!r.changes) throw new HttpError(409, 'Diese Seite ist schon veröffentlicht.');
      auditLog(app, ctx, ctx.locationId, 'site_ai.publish', `KI-Entwurf „${f.name}“ veröffentlicht`, f.id);
      return { ok: true, funnel_id: f.id, published: true };
    });

    // --- restore points ----------------------------------------------------------------------------------------------------
    const pointOut = (r: any, withBlocks = false) => ({ id: r.id, page_id: r.page_id, label: r.label, user_name: r.user_name, created_at: r.created_at, restored_at: r.restored_at, blocks_count: json<any[]>(r.blocks, []).length, ...(withBlocks ? { blocks: json<any[]>(r.blocks, []) } : {}) });
    router.get('/api/site-ai/restore-points', 'location', (ctx) => {
      const pid = String(ctx.query.get('page_id') ?? '');
      if (!pid) throw bad('page_id fehlt');
      return db.all('SELECT * FROM site_ai_restore_points WHERE location_id = ? AND page_id = ? ORDER BY created_at DESC LIMIT ?', ctx.locationId, pid, KEEP_POINTS).map((r) => pointOut(r));
    });
    router.get('/api/site-ai/restore-points/:id', 'location', (ctx) => {
      const r = db.get('SELECT * FROM site_ai_restore_points WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Wiederherstellungspunkt nicht gefunden');
      return pointOut(r, true);
    });
    /** The page as it was: back into the editor (unsaved), or – with `save: true` – saved right away (the undo journal records that too). */
    router.post('/api/site-ai/restore-points/:id/restore', 'location', async (ctx) => {
      writable(ctx);
      const r = db.get<any>('SELECT * FROM site_ai_restore_points WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Wiederherstellungspunkt nicht gefunden');
      const page = parseJson(db.get('SELECT id FROM funnel_pages WHERE id = ? AND location_id = ?', r.page_id, ctx.locationId), []);
      if (!page) throw new HttpError(409, 'Die Seite gibt es nicht mehr.');
      const blocks = cleanBlocks(json<any[]>(r.blocks, []));
      if (ctx.body?.save === true) {
        await callRoute(app, ctx, 'PATCH', `/api/funnel-pages/${r.page_id}`, { blocks });
      }
      db.run('UPDATE site_ai_restore_points SET restored_at = ? WHERE id = ?', now(), r.id);
      return { ok: true, page_id: r.page_id, blocks, saved: ctx.body?.save === true };
    });

    // --- AI writer: blog posts and e-mail text blocks ------------------------------------------------------------------
    const writeLimit = limiter(40, 3600_000);
    router.post('/api/site-ai/write', 'location', async (ctx) => {
      writable(ctx);
      const b = ctx.body ?? {};
      const kind = (WRITE_KINDS as readonly string[]).includes(b.kind) ? (b.kind as WriteKind) : 'blog';
      const topic = typeof b.topic === 'string' ? b.topic.trim().slice(0, 1000) : '';
      const current = typeof b.current === 'string' ? b.current.trim().slice(0, 12_000) : '';
      const instruction = typeof b.instruction === 'string' ? b.instruction.trim().slice(0, 600) : '';
      if (topic.length + instruction.length < 6 && !current) throw bad('Worum soll es gehen? Ein Thema oder ein Satz genügt.');
      const lang = (LANGS as readonly string[]).includes(b.language) ? b.language : 'de';
      const address = b.address === 'sie' ? 'sie' : 'du';
      const tone = (TONES as readonly string[]).includes(b.tone) ? b.tone : 'freundlich';
      const length = ['kurz', 'mittel', 'lang'].includes(b.length) ? b.length : 'mittel';
      const rules = writerRules(kind, lang, address, tone);
      const user = [`Thema: ${topic || '(siehe Text)'}`, kind === 'blog' ? `Länge: ${length === 'kurz' ? 'etwa 400' : length === 'lang' ? 'etwa 1500' : 'etwa 800'} Wörter` : '', instruction && `Auftrag: ${instruction}`, current && `BISHERIGER TEXT (überarbeiten, nicht neu erfinden)\n${current}`].filter(Boolean).join('\n');
      const est = estimate(app, ctx.locationId, 'site_writer', ctx.user?.id, estimateTokens({ mode: 'write', systemChars: rules.length, userChars: user.length + (kind === 'blog' ? 4000 : 0) }));
      if (writeLimit(ctx.locationId)) throw new HttpError(429, 'Zu viele KI-Texte in kurzer Zeit – bitte in einigen Minuten erneut versuchen.');
      const ready: string | null = app.services.aiReady?.(ctx.locationId) ?? (app.services.aiRun ? null : 'Der KI-Assistent ist nicht verfügbar.');
      if (ready) throw new HttpError(409, ready);
      if (est.problem) throw new HttpError(409, est.problem);
      const r = await askChecked(app, ctx, {
        purpose: 'site_writer',
        what: 'Text',
        system: [{ text: rules, cache: true }],
        user,
        maxTokens: kind === 'blog' ? 5000 : 1500,
        timeoutMs: 150_000,
        check: (raw) => {
          const c = checkWritten(raw, kind);
          return { value: c.out, errors: c.errors, warnings: [] };
        },
      });
      return { kind, ...r.value, attempts: r.attempts, model: r.model, cost_usd: Math.round(r.cost_micros) / 1e6, estimate_usd: est.usd };
    });

    app.onTick(() => {
      db.run('DELETE FROM site_ai_restore_points WHERE created_at < ?', new Date(Date.now() - 30 * 864e5).toISOString());
    });
  },
};
