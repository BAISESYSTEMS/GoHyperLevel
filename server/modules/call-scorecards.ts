import type { Ctx } from '../core/http.js';
import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, num, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { SCORECARD_TEMPLATES, SCORE_SCHEMA, cleanCriteria, normalise, parseScores, scorePrompt, scoreTotal, type Criterion, type PointScore } from '../services/call-intel.js';

/**
 * Scorecards for conversations: a checklist of weighted criteria (yes/no or 1–5) per kind of conversation. The AI assistant
 * pre-scores a conversation against it with a reason and a quote for every criterion; a manager looks at it, corrects single
 * scores and adds a comment ("Prüfung"). The result of a criterion is the manager's score when there is one, else the AI's; the
 * total is the weighted share of the points in percent. The report shows the average per criterion and per person.
 */

interface CardRow {
  id: string;
  location_id: string;
  name: string;
  description: string;
  criteria: Criterion[];
  active: number;
  created_at: string;
  updated_at: string;
}
interface ScoreRow {
  id: string;
  location_id: string;
  intel_id: string;
  scorecard_id: string;
  status: 'ai' | 'reviewed';
  ai_scores: Record<string, PointScore>;
  review: Record<string, { score: number | null; comment: string }>;
  comment: string;
  ai_total: number | null;
  final_total: number | null;
  reviewer_id: string | null;
  reviewed_at: string | null;
  ai_error: string;
  created_at: string;
  updated_at: string;
}

export const callScorecardsModule: Module = {
  name: 'call-scorecards',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE call_scorecards (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', criteria TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX call_scorecards_loc ON call_scorecards(location_id);
      CREATE TABLE call_scores (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        intel_id TEXT NOT NULL REFERENCES call_intel(id) ON DELETE CASCADE, scorecard_id TEXT NOT NULL REFERENCES call_scorecards(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'ai', ai_scores TEXT NOT NULL DEFAULT '{}', review TEXT NOT NULL DEFAULT '{}', comment TEXT NOT NULL DEFAULT '',
        ai_total REAL, final_total REAL, reviewer_id TEXT, reviewed_at TEXT, ai_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(intel_id, scorecard_id)
      );
      CREATE INDEX call_scores_card ON call_scores(scorecard_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const card = (locationId: string, key: string): CardRow | undefined => parseJson(db.get<any>('SELECT * FROM call_scorecards WHERE id = ? AND location_id = ?', key, locationId), ['criteria']);
    const scoreRow = (locationId: string, key: string): ScoreRow | undefined => parseJson(db.get<any>('SELECT * FROM call_scores WHERE id = ? AND location_id = ?', key, locationId), ['ai_scores', 'review']);
    const cardOut = (c: CardRow) => ({ id: c.id, name: c.name, description: c.description, criteria: c.criteria, active: !!c.active, scored: db.get<{ n: number }>('SELECT COUNT(*) n FROM call_scores WHERE scorecard_id = ?', c.id)!.n, created_at: c.created_at });

    /** What counts per criterion: the manager's score, else the AI's. */
    const finals = (c: Criterion[], s: Pick<ScoreRow, 'ai_scores' | 'review'>) => Object.fromEntries(c.map((k) => [k.id, s.review[k.id] && 'score' in s.review[k.id] ? s.review[k.id].score : (s.ai_scores[k.id]?.score ?? null)]));
    const scoreOut = (s: ScoreRow, c: CardRow) => {
      const final = finals(c.criteria, s);
      return {
        id: s.id,
        intel_id: s.intel_id,
        scorecard_id: s.scorecard_id,
        scorecard_name: c.name,
        status: s.status,
        ai_total: s.ai_total,
        final_total: s.final_total,
        comment: s.comment,
        reviewer_id: s.reviewer_id,
        reviewer_name: s.reviewer_id ? (db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', s.reviewer_id)?.name ?? '') : '',
        reviewed_at: s.reviewed_at,
        ai_error: s.ai_error,
        criteria: c.criteria.map((k) => ({ ...k, ai: s.ai_scores[k.id] ?? null, review: s.review[k.id] ?? null, final: final[k.id] ?? null })),
        updated_at: s.updated_at,
      };
    };

    // --- cards ------------------------------------------------------------------------------------------------------------
    router.get('/api/call-scorecards/templates', 'location', () => SCORECARD_TEMPLATES);
    router.get('/api/call-scorecards', 'location', (ctx) => db.all<any>('SELECT * FROM call_scorecards WHERE location_id = ? ORDER BY name', ctx.locationId).map((r) => cardOut(parseJson(r, ['criteria']))));
    router.post('/api/call-scorecards', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const row = { id: id(), location_id: ctx.locationId, name: str(b.name, 'Name', { required: true, max: 80 }), description: str(b.description, 'Beschreibung', { max: 400 }), criteria: cleanCriteria(b.criteria), active: 1, created_at: now(), updated_at: now() };
      db.insert('call_scorecards', row);
      return cardOut(card(ctx.locationId, row.id)!);
    });
    router.put('/api/call-scorecards/:id', 'location', (ctx) => {
      const c = card(ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Scorecard nicht gefunden');
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = { updated_at: now() };
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true, max: 80 });
      if (b.description !== undefined) patch.description = str(b.description, 'Beschreibung', { max: 400 });
      if (b.active !== undefined) patch.active = b.active ? 1 : 0;
      if (b.criteria !== undefined) {
        const next = cleanCriteria(b.criteria);
        patch.criteria = next;
        // Scored conversations keep their results; criteria that no longer exist drop out of the totals.
        for (const s of db.all<any>('SELECT * FROM call_scores WHERE scorecard_id = ?', c.id).map((r) => parseJson(r, ['ai_scores', 'review']) as ScoreRow)) {
          db.run('UPDATE call_scores SET ai_total = ?, final_total = ?, updated_at = ? WHERE id = ?', scoreTotal(next, Object.fromEntries(next.map((k) => [k.id, s.ai_scores[k.id]?.score ?? null]))), scoreTotal(next, finals(next, s)), now(), s.id);
        }
      }
      db.update('call_scorecards', c.id, patch, ctx.locationId);
      return cardOut(card(ctx.locationId, c.id)!);
    });
    router.delete('/api/call-scorecards/:id', 'location', (ctx) => {
      const c = card(ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Scorecard nicht gefunden');
      db.run('DELETE FROM call_scorecards WHERE id = ?', c.id);
      db.run(`UPDATE call_intel_settings SET data = json_set(data, '$.default_scorecard_id', '') WHERE location_id = ? AND json_extract(data, '$.default_scorecard_id') = ?`, ctx.locationId, c.id);
      return { ok: true };
    });

    // --- scoring ------------------------------------------------------------------------------------------------------------
    /** The AI scores one conversation against a card (again: the manager's review stays and only the AI part changes). */
    async function score(locationId: string, intelId: string, scorecardId: string): Promise<ScoreRow> {
      const c = card(locationId, scorecardId);
      if (!c || !c.active) throw notFound('Scorecard nicht gefunden');
      const intel = db.get<{ id: string; transcript: string; separated: number; status: string; contact_id: string | null }>('SELECT id, transcript, separated, status, contact_id FROM call_intel WHERE id = ? AND location_id = ?', intelId, locationId);
      if (!intel) throw notFound('Auswertung nicht gefunden');
      if (intel.status !== 'done' || !intel.transcript) throw bad('Das Gespräch ist noch nicht ausgewertet');
      const problem: string | null = app.services.aiReady ? app.services.aiReady(locationId) : 'Das Modul KI-Assistent fehlt.';
      if (problem || !app.services.aiRun) throw new HttpError(409, problem || 'Der KI-Assistent fehlt');
      const res = await app.services.aiRun({ locationId, purpose: 'call_intel', user: scorePrompt({ transcript: intel.transcript, criteria: c.criteria, name: c.name, separated: !!intel.separated }), schema: SCORE_SCHEMA, maxTokens: 2500, contactId: intel.contact_id });
      const parsed = parseScores(res.text, c.criteria);
      if (!parsed.ok) throw new HttpError(502, `Die KI-Antwort war nicht brauchbar: ${parsed.error}`);
      const ai = parsed.value;
      const aiTotal = scoreTotal(c.criteria, Object.fromEntries(c.criteria.map((k) => [k.id, ai[k.id]?.score ?? null])));
      const existing = db.get<any>('SELECT * FROM call_scores WHERE intel_id = ? AND scorecard_id = ?', intelId, scorecardId);
      if (existing) {
        const e = parseJson(existing, ['ai_scores', 'review']) as ScoreRow;
        db.run('UPDATE call_scores SET ai_scores = ?, ai_total = ?, final_total = ?, ai_error = \'\', updated_at = ? WHERE id = ?', JSON.stringify(ai), aiTotal, scoreTotal(c.criteria, finals(c.criteria, { ai_scores: ai, review: e.review })), now(), e.id);
        return scoreRow(locationId, e.id)!;
      }
      const row = { id: id(), location_id: locationId, intel_id: intelId, scorecard_id: scorecardId, status: 'ai', ai_scores: ai, review: {}, ai_total: aiTotal, final_total: aiTotal, created_at: now(), updated_at: now() };
      db.insert('call_scores', row);
      return scoreRow(locationId, row.id)!;
    }
    app.services.callScorecards = { score };

    router.post('/api/call-intel/:id/scores', 'location', async (ctx) => {
      const sid = str(ctx.body?.scorecard_id, 'Scorecard', { required: true, max: 64 });
      const s = await score(ctx.locationId, ctx.params.id, sid);
      return scoreOut(s, card(ctx.locationId, sid)!);
    });
    router.get('/api/call-intel/:id/scores', 'location', (ctx) => {
      if (!db.get('SELECT 1 FROM call_intel WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId)) throw notFound('Auswertung nicht gefunden');
      return db
        .all<any>('SELECT * FROM call_scores WHERE intel_id = ? AND location_id = ? ORDER BY created_at', ctx.params.id, ctx.locationId)
        .map((r) => parseJson(r, ['ai_scores', 'review']) as ScoreRow)
        .map((s) => scoreOut(s, card(ctx.locationId, s.scorecard_id)!))
        .filter(Boolean);
    });

    /** Managers: administrators and people with the settings area review scores. */
    const mayReview = (ctx: Ctx) => !!ctx.user && (ctx.user.role === 'admin' || ctx.user.permissions === null || ctx.user.permissions.includes('settings'));
    router.put('/api/call-intel/:id/scores/:sid/review', 'location', (ctx) => {
      if (!mayReview(ctx)) throw new HttpError(403, 'Nur Administratoren und Personen mit Zugriff auf die Einstellungen prüfen Bewertungen');
      const s = scoreRow(ctx.locationId, ctx.params.sid);
      if (!s || s.intel_id !== ctx.params.id) throw notFound('Bewertung nicht gefunden');
      const c = card(ctx.locationId, s.scorecard_id)!;
      const b = ctx.body ?? {};
      const review: ScoreRow['review'] = { ...s.review };
      if (b.scores !== undefined) {
        if (!b.scores || typeof b.scores !== 'object') throw bad('Bewertungen ungültig');
        for (const [cid, v] of Object.entries<any>(b.scores)) {
          const k = c.criteria.find((x) => x.id === cid);
          if (!k) throw bad(`Kriterium „${cid}“ gibt es nicht`);
          if (v === null || v?.score === null) {
            review[cid] = { score: null, comment: String(v?.comment ?? '').slice(0, 400) };
            continue;
          }
          const n = Math.round(Number(v?.score));
          if (!Number.isFinite(n) || (k.scale === 'yesno' ? n < 0 || n > 1 : n < 1 || n > 5)) throw bad(`„${k.label}“: ${k.scale === 'yesno' ? '0 oder 1' : 'eine Zahl von 1 bis 5'}`);
          review[cid] = { score: n, comment: String(v?.comment ?? '').slice(0, 400).trim() };
        }
      }
      const comment = b.comment !== undefined ? str(b.comment, 'Kommentar', { max: 2000 }) : s.comment;
      const total = scoreTotal(c.criteria, finals(c.criteria, { ai_scores: s.ai_scores, review }));
      db.run(`UPDATE call_scores SET review = ?, comment = ?, final_total = ?, status = 'reviewed', reviewer_id = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`, JSON.stringify(review), comment, total, ctx.user!.id, now(), now(), s.id);
      app.events.emit(ctx.locationId, 'call.scored', { intelId: s.intel_id, scorecardId: s.scorecard_id, total, reviewer: ctx.user!.id });
      return scoreOut(scoreRow(ctx.locationId, s.id)!, c);
    });

    /** Average per criterion and per person over a period – who needs coaching on what. */
    router.get('/api/call-scorecards/:id/report', 'location', (ctx) => {
      const c = card(ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Scorecard nicht gefunden');
      const days = Math.min(Math.max(1, num(ctx.query.get('days'), 30)), 365);
      const rows = db
        .all<any>(`SELECT s.*, i.user_id, i.title FROM call_scores s JOIN call_intel i ON i.id = s.intel_id WHERE s.scorecard_id = ? AND s.location_id = ? AND s.created_at >= ?`, c.id, ctx.locationId, new Date(Date.now() - days * 864e5).toISOString())
        .map((r) => ({ ...(parseJson(r, ['ai_scores', 'review']) as ScoreRow), user_id: r.user_id as string | null }));
      const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
      const perCriterion = c.criteria.map((k) => {
        const v = rows.map((s) => finals([k], s)[k.id]).filter((x): x is number => typeof x === 'number');
        return { id: k.id, label: k.label, scale: k.scale, n: v.length, avg_pct: avg(v.map((x) => normalise(k, x) * 100)) };
      });
      const people = new Map<string, number[]>();
      for (const s of rows) if (s.final_total !== null) people.set(s.user_id ?? '', [...(people.get(s.user_id ?? '') ?? []), s.final_total]);
      return {
        days,
        scorecard: { id: c.id, name: c.name },
        scored: rows.length,
        reviewed: rows.filter((s) => s.status === 'reviewed').length,
        avg_total: avg(rows.map((s) => s.final_total).filter((x): x is number => x !== null)),
        criteria: perCriterion,
        people: [...people].map(([uid, v]) => ({ user_id: uid || null, name: uid ? (db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', uid)?.name ?? '') : '(unbekannt)', scored: v.length, avg_total: avg(v) })).sort((a, b) => (b.avg_total ?? 0) - (a.avg_total ?? 0)),
      };
    });
  },
};
