import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { now } from '../core/util.js';
import { withDefaults as aiDefaults } from '../services/ai-context.js';
import { MAX_REPLY, TONES, brandVoice, cleanReplySettings, finishReply, pickTone, replySystem, replyUser, withReplyDefaults, type ReplySettings } from '../services/review-replies.js';
import { GOOGLE_REVIEW_TRIGGER } from './google-reviews.js';
import type { Tool } from './mcp.js';

/**
 * "KI-Antwort vorschlagen" for Google reviews: the KI-Assistent (app.services.aiRun – counts on the monthly limit and is logged)
 * writes a public reply in the chosen tone and the company's brand voice (the assistant's persona and facts). The suggestion is
 * only ever a DRAFT on the review (`reply_draft`): a person edits it and presses "Öffentlich antworten" – nothing here posts to
 * Google, also not the optional auto-draft for new reviews.
 */

const PURPOSE = 'review_reply';
/** Suggestions per sub-account and hour (manual and automatic) – on top of the assistant's monthly budget. */
const HOURLY_CAP = 60;

const TOOLS: Tool[] = [
  {
    name: 'ghl_suggest_review_reply',
    title: 'KI-Antwort für Google-Bewertung',
    description:
      'Schreibt mit dem KI-Assistenten einen Antwortvorschlag auf eine Google-Rezension (Tonfall und Markenstimme des Projekts) und legt ihn als Entwurf an der Rezension ab. Veröffentlicht NICHTS – dafür ghl_reply_google_review nach Prüfung. review_id kommt aus ghl_google_reviews. Zählt aufs KI-Monatslimit.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
        review_id: { type: 'string', description: 'ID der Rezension (aus ghl_google_reviews)' },
        tone: { type: 'string', enum: Object.keys(TONES), description: 'Tonfall (Standard: Einstellung des Projekts)' },
        instruction: { type: 'string', description: 'Optionaler Hinweis, z. B. „Rückruf anbieten“' },
      },
      required: ['location_id', 'review_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: (call, a) => call.api('POST', `/api/google-reviews/${encodeURIComponent(a.review_id)}/suggest-reply`, { location: a.location_id, body: { tone: a.tone, instruction: a.instruction } }),
  },
];

export const reviewRepliesModule: Module = {
  name: 'review-replies',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE review_reply_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        tone TEXT NOT NULL DEFAULT 'freundlich', formality TEXT NOT NULL DEFAULT 'sie',
        instructions TEXT NOT NULL DEFAULT '', signature TEXT NOT NULL DEFAULT '',
        auto_draft INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    const settingsOf = (loc: string): ReplySettings => withReplyDefaults(db.get('SELECT * FROM review_reply_settings WHERE location_id = ?', loc));
    const aiProblem = (loc: string): string | null => (app.services.aiReady?.(loc) as string | null | undefined) ?? (app.services.aiRun ? null : 'Der KI-Assistent ist nicht verfügbar.');
    const reviewOf = (loc: string, rid: string) => {
      const r = db.get('SELECT * FROM google_reviews WHERE id = ? AND location_id = ?', rid, loc);
      if (!r) throw notFound('Bewertung nicht gefunden');
      return r;
    };
    /** The assistant's persona and facts: the brand voice. */
    const voiceOf = (loc: string) => {
      const row = db.get<{ data: string }>('SELECT data FROM ai_settings WHERE location_id = ?', loc);
      let s;
      try {
        s = aiDefaults(row ? JSON.parse(row.data || '{}') : null);
      } catch {
        s = aiDefaults(null);
      }
      return brandVoice({ persona: s.persona, facts: s.facts });
    };

    /**
     * One suggestion for any review (Google here, the other platforms in modules/review-sources.ts) – the text only, nothing is stored.
     * Throws when the AI is off, over budget or over the hourly cap.
     */
    async function suggest(loc: string, review: { author: string; rating: number | null; text: string; language?: string; published_at?: string | null; platform?: string }, o: { tone?: unknown; instruction?: string; userId?: string | null } = {}) {
      if (!app.services.aiRun) throw new HttpError(409, 'Der KI-Assistent ist nicht verfügbar');
      const used = db.get<{ n: number }>(`SELECT COUNT(*) n FROM ai_calls WHERE location_id = ? AND purpose = ? AND created_at >= ?`, loc, PURPOSE, new Date(Date.now() - 3600_000).toISOString())!.n;
      if (used >= HOURLY_CAP) throw new HttpError(429, 'Zu viele Vorschläge in kurzer Zeit – bitte in einer Stunde noch einmal');
      const s = settingsOf(loc);
      const tone = pickTone(o.tone, s.tone);
      const l = app.location(loc)!;
      const r = await app.services.aiRun({
        locationId: loc,
        purpose: PURPOSE,
        system: replySystem({ locationName: l.name, tone, formality: s.formality, voice: voiceOf(loc), instructions: s.instructions, contact: { phone: l.phone, email: l.email }, platform: review.platform }),
        user: replyUser({ author: review.author, rating: review.rating ?? 0, text: review.text, language: review.language, published_at: review.published_at }, o.instruction ?? ''),
        maxTokens: 700,
        timeoutMs: 60_000,
        userId: o.userId ?? null,
      });
      const text = finishReply(r.text, s.signature);
      if (!text) throw new HttpError(502, 'Die KI hat keinen Text geliefert – bitte noch einmal versuchen');
      return { text, tone, model: String(r.model ?? '') };
    }
    // Other review sources (modules/review-sources.ts) share tone, brand voice, budget and the auto-draft switch.
    app.services.reviewReplies = { suggest, autoDraft: (loc: string) => settingsOf(loc).auto_draft && !aiProblem(loc) };

    /** One suggestion for a Google review, stored as its draft. */
    async function draftFor(loc: string, review: any, o: { tone?: unknown; instruction?: string; source: 'ai' | 'auto'; userId?: string | null }) {
      const out = await suggest(loc, review, o);
      db.run('UPDATE google_reviews SET reply_draft = ?, reply_draft_at = ?, reply_draft_source = ?, updated_at = ? WHERE id = ? AND location_id = ?', out.text, now(), o.source, now(), review.id, loc);
      return out;
    }

    // --- settings -----------------------------------------------------------------------------
    const settingsOut = (loc: string) => ({ ...settingsOf(loc), tones: Object.entries(TONES).map(([id, t]) => ({ id, label: t.label, hint: t.hint })), ai_problem: aiProblem(loc) });
    router.get('/api/google-reviews/reply-settings', 'location', (ctx) => settingsOut(ctx.locationId));
    router.put('/api/google-reviews/reply-settings', 'location', (ctx) => {
      const next = cleanReplySettings(ctx.body ?? {}, settingsOf(ctx.locationId));
      db.run(
        `INSERT INTO review_reply_settings (location_id, tone, formality, instructions, signature, auto_draft, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(location_id) DO UPDATE SET tone = excluded.tone, formality = excluded.formality, instructions = excluded.instructions, signature = excluded.signature, auto_draft = excluded.auto_draft, updated_at = excluded.updated_at`,
        ctx.locationId,
        next.tone,
        next.formality,
        next.instructions,
        next.signature,
        next.auto_draft ? 1 : 0,
        now(),
      );
      return settingsOut(ctx.locationId);
    });

    // --- suggestion and draft ---------------------------------------------------------------------
    router.post('/api/google-reviews/:id/suggest-reply', 'location', async (ctx) => {
      const review = reviewOf(ctx.locationId, ctx.params.id);
      const instruction = str(ctx.body?.instruction, 'Hinweis', { max: 500 });
      const out = await draftFor(ctx.locationId, review, { tone: ctx.body?.tone, instruction, source: 'ai', userId: ctx.user?.id ?? null });
      return { ...out, review: db.get('SELECT * FROM google_reviews WHERE id = ?', review.id) };
    });
    router.put('/api/google-reviews/:id/reply-draft', 'location', (ctx) => {
      const review = reviewOf(ctx.locationId, ctx.params.id);
      const text = str(ctx.body?.text, 'Entwurf', { max: MAX_REPLY });
      if (!text) throw bad('Entwurf ist leer – zum Löschen die Löschen-Funktion nutzen');
      // An edited suggestion is the team's text now; "ai" stays only while nobody touched it.
      db.run('UPDATE google_reviews SET reply_draft = ?, reply_draft_at = ?, reply_draft_source = ?, updated_at = ? WHERE id = ? AND location_id = ?', text, now(), review.reply_draft === text ? review.reply_draft_source : 'edited', now(), review.id, ctx.locationId);
      return db.get('SELECT * FROM google_reviews WHERE id = ?', review.id);
    });
    router.delete('/api/google-reviews/:id/reply-draft', 'location', (ctx) => {
      const review = reviewOf(ctx.locationId, ctx.params.id);
      db.run(`UPDATE google_reviews SET reply_draft = '', reply_draft_at = NULL, reply_draft_source = '', updated_at = ? WHERE id = ? AND location_id = ?`, now(), review.id, ctx.locationId);
      return db.get('SELECT * FROM google_reviews WHERE id = ?', review.id);
    });

    // --- optional auto-draft for new reviews (a draft only – never posted) -----------------------------
    app.events.on(GOOGLE_REVIEW_TRIGGER, async (e) => {
      if (!settingsOf(e.locationId).auto_draft) return;
      const rid = String(e.data.reviewId ?? '');
      const review = rid ? db.get('SELECT * FROM google_reviews WHERE id = ? AND location_id = ?', rid, e.locationId) : undefined;
      if (!review || review.reply_text || review.reply_draft) return;
      if (aiProblem(e.locationId)) return;
      try {
        await draftFor(e.locationId, review, { source: 'auto' });
      } catch (err) {
        console.error(`[review-replies] auto-draft failed: ${(err as Error).message}`);
      }
    });
  },
};
