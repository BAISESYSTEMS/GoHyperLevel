import type { Module } from '../core/app.js';
import { HttpError, bad, str, type Ctx } from '../core/http.js';
import { id as newId, now } from '../core/util.js';
import { ymdInTz } from '../core/time.js';
import { LIMITS } from '../services/boards-model.js';
import { applyPatch, type Op, type PatchResult, type Risk } from '../services/boards-patch.js';
import { PATCH_SCHEMA, SYSTEM, opsFromAi, parseAnswer, userPrompt, type Context } from '../services/boards-compose.js';
import { stateOf, type BoardRow } from '../services/boards-store.js';
import { callRoute } from '../services/route-call.js';

/**
 * Living Boards, agentic: "Sag einfach, was du sehen willst" (text or push-to-talk). The request becomes a validated
 * board patch (services/boards-compose.ts) that the person sees as a preview card – what is added, moved, changed –
 * and applies with one click; it is a version like every other change, so undo is instant. Layout-only changes may be
 * applied at once when the person switched that on (never anything that adds addresses or buttons). What no widget can
 * do is offered to the Werkstatt. Voice never confirms: speech only becomes the request text.
 */

const HOURLY = 40;
const week = (d: Date) => ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'][d.getDay()];

export const boardsComposeModule: Module = {
  name: 'boards-compose',
  register(app) {
    const { db, router } = app;
    const B = () => app.services.boards as any;

    /** The ids of the viewer's own data the model may use – each read through the viewer's rights, an area they lack is simply left out. */
    const viewerContext = async (ctx: Ctx): Promise<Context> => {
      const get = async <T = any>(path: string): Promise<T[]> => {
        try {
          const r = await callRoute(app, ctx, 'GET', path, {}, { quiet: true });
          return (Array.isArray(r) ? r : (r?.reports ?? r?.projects ?? [])) as T[];
        } catch {
          return [];
        }
      };
      const [pipelines, reports, workflows, forms, projects, calendars, scenarios, smart] = await Promise.all([get('/api/pipelines'), get('/api/reports/library'), get('/api/workflows'), get('/api/forms'), get('/api/pm/projects'), get('/api/calendars'), get('/api/calc/scenarios'), get('/api/smart-lists')]);
      const slim = (l: any[]) => l.map((x) => ({ id: String(x.id), name: String(x.name ?? '') }));
      return {
        pipelines: pipelines.map((p: any) => ({ id: p.id, name: p.name, stages: (p.stages ?? []).map((s: any) => s.name) })),
        reports: slim(reports),
        workflows: slim(workflows.filter((w: any) => w.status === 'active')),
        forms: slim(forms),
        projects: slim(projects),
        calendars: slim(calendars),
        scenarios: slim(scenarios),
        smart_lists: slim(smart),
      };
    };

    const prefs = (ctx: Ctx) => (ctx.user ? (db.get<{ auto_apply: string }>('SELECT auto_apply FROM board_prefs WHERE user_id = ?', ctx.user.id)?.auto_apply ?? 'layout') : 'off');

    interface ProposalRow {
      id: string;
      board_id: string;
      location_id: string;
      user_id: string | null;
      prompt: string;
      message: string;
      ops: string;
      base_n: number;
      risk: Risk;
      status: 'pending' | 'applied' | 'rejected' | 'expired';
      unsupported: string;
      via: string;
      created_at: string;
      expires_at: string;
    }
    const out = (p: ProposalRow, r?: PatchResult) => ({
      id: p.id,
      status: p.status,
      prompt: p.prompt,
      message: p.message,
      risk: p.risk,
      base_version: p.base_n,
      expires_at: p.expires_at,
      via: p.via,
      unsupported: JSON.parse(p.unsupported || '[]') as { need: string; reason: string }[],
      ...(r ? { changes: r.changes, summary: r.summary, after: r.state } : {}),
    });

    /** Asks the model; one repair round when the patch does not validate. */
    const ask = async (ctx: Ctx, board: BoardRow, request: string) => {
      if (!app.services.aiRun) throw new HttpError(409, 'Der KI-Assistent ist nicht verfügbar');
      const reg = B().registry;
      const tz = app.location(ctx.locationId)?.timezone || 'Europe/Berlin';
      const state = stateOf(board);
      const context = await viewerContext(ctx);
      const system = SYSTEM.replace('{brand}', String(app.services.brandName?.() ?? 'HyperLevel'));
      const today = `${ymdInTz(new Date(), tz)}, ${week(new Date())}`;
      const base = { today, tz, person: ctx.user?.name ?? 'Unbekannt', catalogue: reg.catalogue(), context, state, version: board.head, reg, request };
      let previous: string | undefined;
      let errors: string[] = [];
      let answer = null as ReturnType<typeof parseAnswer>;
      let result: PatchResult | null = null;
      for (let round = 0; round < 2; round++) {
        const r = await app.services.aiRun({ locationId: ctx.locationId, purpose: 'boards', user: userPrompt({ ...base, ...(previous ? { previous, errors } : {}) }), system: [{ text: system }], schema: PATCH_SCHEMA, maxTokens: 3500, timeoutMs: 90_000, userId: ctx.user?.id ?? null });
        answer = parseAnswer(String(r.text ?? ''));
        if (!answer) {
          previous = 'Die Antwort war kein gültiges JSON nach dem Schema.';
          errors = [];
          continue;
        }
        if (!answer.ops.length) return { answer, result: null as PatchResult | null, errors: [] as string[] };
        const conv = opsFromAi(answer.ops);
        result = conv.errors.length ? null : applyPatch(state, conv.ops, { ...B().env(ctx.locationId), strict: true });
        errors = conv.errors.length ? conv.errors : result!.ok ? [] : result!.errors;
        if (!errors.length) return { answer, result, errors };
        previous = JSON.stringify({ message: answer.message, ops: answer.ops });
      }
      return { answer, result: null as PatchResult | null, errors: errors.length ? errors : ['Die KI hat keinen gültigen Vorschlag geliefert.'] };
    };

    const insertProposal = (ctx: Ctx, board: BoardRow, p: { prompt: string; message: string; ops: Op[]; risk: Risk; unsupported: unknown[]; via: string }): ProposalRow => {
      // old proposals of this person on this board are replaced by the new one
      db.run("UPDATE board_proposals SET status = 'expired' WHERE board_id = ? AND user_id IS ? AND status = 'pending'", board.id, ctx.user?.id ?? null);
      const row: ProposalRow = { id: newId(), board_id: board.id, location_id: board.location_id, user_id: ctx.user?.id ?? null, prompt: p.prompt, message: p.message, ops: JSON.stringify(p.ops), base_n: board.head, risk: p.risk, status: 'pending', unsupported: JSON.stringify(p.unsupported), via: p.via, created_at: now(), expires_at: new Date(Date.now() + LIMITS.proposalMinutes * 60_000).toISOString() };
      db.insert('board_proposals', row);
      return row;
    };

    /** Applies a stored proposal to the board as it is now. */
    const applyProposal = (ctx: Ctx, board: BoardRow, p: ProposalRow) => {
      const r = B().apply(ctx, board, JSON.parse(p.ops), { strict: true, kind: 'agent', prompt: p.prompt, clientId: String(ctx.body?.client_id ?? '') }) as { result: PatchResult; saved: { board: BoardRow } | null };
      if (!r.result.ok) throw new HttpError(409, 'Das Board hat sich seit dem Vorschlag geändert und der Vorschlag passt nicht mehr – bitte formuliere den Wunsch noch einmal.');
      db.run("UPDATE board_proposals SET status = 'applied', decided_at = ? WHERE id = ?", now(), p.id);
      return r;
    };

    router.post('/api/boards/:id/compose', 'location', async (ctx) => {
      const { board, access } = B().load(ctx, ctx.params.id, 'edit') as { board: BoardRow; access: string };
      const request = str(ctx.body?.prompt, 'Wunsch', { required: true, max: LIMITS.prompt });
      if (request.length < 3) throw bad('Bitte beschreibe kurz, was du sehen möchtest.');
      const used = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_calls WHERE location_id = ? AND purpose = 'boards' AND user_id IS ? AND created_at > ?", ctx.locationId, ctx.user?.id ?? null, new Date(Date.now() - 3600_000).toISOString())!.n;
      if (used >= HOURLY) throw new HttpError(429, `Du hast in der letzten Stunde schon ${HOURLY} Board-Wünsche gestellt – bitte warte etwas.`);
      const voice = ctx.body?.voice === true;
      // The wish itself is worth a line in the log (who asked for what); the change, if it is made, has its own.
      ctx.skipAfterWrite = true;
      app.services.audit?.({ ctx, action: 'boards.compose', route: 'POST /api/boards/:id/compose', entityId: board.id, summary: `${board.name}: Wunsch${voice ? ' (gesprochen)' : ''} „${request.slice(0, 160)}“` });
      const { answer, result, errors } = await ask(ctx, board, request);
      if (!answer) throw new HttpError(502, 'Die KI hat keine verwertbare Antwort geliefert – bitte versuche es noch einmal.');
      const unsupported = answer.unsupported;
      if (!answer.ops.length) {
        // nothing to change: a question the board cannot answer, or a wish no widget fulfils
        return { ok: true, proposal: null, applied: false, message: answer.message || (unsupported.length ? 'Dafür gibt es noch kein Widget.' : 'Dazu muss ich nichts ändern.'), unsupported };
      }
      if (!result) return { ok: false, proposal: null, applied: false, message: answer.message || 'Das konnte ich nicht in eine gültige Änderung übersetzen.', errors, unsupported };
      const row = insertProposal(ctx, board, { prompt: request, message: answer.message, ops: result.ops, risk: result.risk, unsupported, via: voice ? 'voice' : 'text' });
      // Low-risk layout changes can go straight through when the person wants that – never anything with addresses or buttons.
      if (prefs(ctx) === 'layout' && result.risk === 'low' && access !== 'view' && ctx.body?.preview !== true) {
        const r = applyProposal(ctx, board, row);
        const current = r.saved?.board ?? board;
        return { ok: true, applied: true, proposal: out({ ...row, status: 'applied' }, result), message: answer.message, unsupported, board: B().full(ctx, current, access), version: current.head };
      }
      return { ok: true, applied: false, proposal: out(row, result), message: answer.message, unsupported };
    });

    const mine = (ctx: Ctx, board: BoardRow, pid: string): ProposalRow => {
      const p = db.get<ProposalRow>('SELECT * FROM board_proposals WHERE id = ? AND board_id = ? AND location_id = ?', pid, board.id, ctx.locationId);
      if (!p) throw new HttpError(404, 'Vorschlag nicht gefunden');
      // Only the person who asked confirms – never somebody else, never a key.
      if (!ctx.user || p.user_id !== ctx.user.id) throw new HttpError(403, 'Nur die Person, die den Wunsch gestellt hat, kann den Vorschlag bestätigen');
      return p;
    };
    const live = (p: ProposalRow) => {
      if (p.status !== 'pending') throw new HttpError(409, p.status === 'applied' ? 'Der Vorschlag wurde schon übernommen.' : 'Der Vorschlag ist nicht mehr aktuell.');
      if (p.expires_at < now()) {
        db.run("UPDATE board_proposals SET status = 'expired' WHERE id = ?", p.id);
        throw new HttpError(409, 'Der Vorschlag ist abgelaufen – bitte stelle den Wunsch noch einmal.');
      }
    };

    router.get('/api/boards/:id/proposals', 'location', (ctx) => {
      const { board } = B().load(ctx, ctx.params.id, 'edit') as { board: BoardRow };
      const rows = db.all<ProposalRow>("SELECT * FROM board_proposals WHERE board_id = ? AND location_id = ? AND user_id IS ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 5", board.id, ctx.locationId, ctx.user?.id ?? null, now());
      return {
        proposals: rows.map((p) => {
          const r = applyPatch(stateOf(board), JSON.parse(p.ops), { ...B().env(ctx.locationId), strict: true });
          return out(p, r.ok ? r : undefined);
        }),
      };
    });

    router.post('/api/boards/:id/proposals/:pid/apply', 'location', (ctx) => {
      const { board, access } = B().load(ctx, ctx.params.id, 'edit') as { board: BoardRow; access: string };
      const p = mine(ctx, board, ctx.params.pid);
      live(p);
      const r = applyProposal(ctx, board, p);
      const current = r.saved?.board ?? board;
      return { ok: true, version: current.head, unchanged: !r.saved, summary: r.result.summary, board: B().full(ctx, current, access) };
    });
    router.post('/api/boards/:id/proposals/:pid/reject', 'location', (ctx) => {
      const { board } = B().load(ctx, ctx.params.id, 'edit') as { board: BoardRow };
      const p = mine(ctx, board, ctx.params.pid);
      if (p.status === 'pending') db.run("UPDATE board_proposals SET status = 'rejected', decided_at = ? WHERE id = ?", now(), p.id);
      return { ok: true };
    });

    // Decided and old proposals are not kept forever.
    let lastPrune = 0;
    app.onTick(() => {
      if (Date.now() - lastPrune < 3600_000) return;
      lastPrune = Date.now();
      db.run('DELETE FROM board_proposals WHERE created_at < ?', new Date(Date.now() - 7 * 864e5).toISOString());
    });
  },
};
