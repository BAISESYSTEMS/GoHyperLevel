import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { callRoute } from '../services/route-call.js';
import type { Tool } from './mcp.js';

/**
 * Prompt-Optimierer – docs/ai-assistant.md#prompt-optimizer. Test cases for an AI agent's instructions (a KI-Agent, the
 * KI-Telefonagent, or any prompt): each case is a customer message and what a good answer must do. "Testen" lets the model
 * answer every case with the instructions and a second, strict call grade the answer (pass/fail, 0–10, reason); "Verbessern"
 * proposes revised instructions from the failures, which the team reviews and applies with one click (through the agent's own
 * route, so undo and the audit log see it). Suites are stored per target, so the same tests run again after every change.
 * Every call goes through `app.services.aiRun` (key, budget, log of the KI-Assistent).
 */

const PURPOSE = 'prompt_lab';
const MAX_CASES = 10;
export interface TestCase {
  input: string;
  expect: string;
}
export interface CaseResult extends TestCase {
  answer: string;
  pass: boolean;
  score: number;
  reason: string;
}

export const cleanCases = (v: unknown): TestCase[] =>
  (Array.isArray(v) ? v : [])
    .map((c: any) => ({ input: String(c?.input ?? '').trim().slice(0, 2000), expect: String(c?.expect ?? '').trim().slice(0, 1000) }))
    .filter((c) => c.input && c.expect)
    .slice(0, MAX_CASES);

const GRADE_SCHEMA = { type: 'object', properties: { pass: { type: 'boolean' }, score: { type: 'integer', minimum: 0, maximum: 10 }, reason: { type: 'string' } }, required: ['pass', 'score', 'reason'], additionalProperties: false };
const IMPROVE_SCHEMA = { type: 'object', properties: { instructions: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } } }, required: ['instructions', 'changes'], additionalProperties: false };

/** Reads a JSON answer, also when the model wrapped it in a code fence. */
export function readJson(text: string): any {
  const s = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

export const summarizeResults = (results: CaseResult[]) => ({
  passed: results.filter((r) => r.pass).length,
  total: results.length,
  score: results.length ? Math.round((results.reduce((n, r) => n + r.score, 0) / results.length) * 10) : 0,
});

export const promptLabModule: Module = {
  name: 'prompt-lab',
  migrations: [
    [
      '001-init',
      `CREATE TABLE prompt_suites (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, target_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
        cases TEXT NOT NULL DEFAULT '[]', last_run TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX prompt_suites_loc ON prompt_suites(location_id, updated_at);`,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const ai = () => {
      if (!app.services.aiRun) throw new HttpError(409, 'Der KI-Assistent ist nicht verfügbar');
      return app.services.aiRun as (input: Record<string, unknown>) => Promise<{ text: string; model?: string }>;
    };
    /**
     * A KI-Agent only when the caller may see it (agent-custom's canSee: a private agent is its owner's alone, not even an admin's).
     * A sub-account key without a person sees the shared agents only, like GET /api/agents.
     */
    const agentOf = (ctx: Ctx, targetId: string): { name: string; instructions: string } | null => {
      if (!ctx.user) return db.get<{ name: string; instructions: string }>(`SELECT name, instructions FROM agents WHERE id = ? AND location_id = ? AND visibility <> 'private'`, targetId, ctx.locationId) ?? null;
      try {
        const c = app.services.agentDefs?.config(targetId, ctx.user, ctx.locationId);
        return c ? { name: c.cfg.name, instructions: c.cfg.instructions } : null;
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    };
    /** A suite on an agent the caller may not see is not there for them (its cases and last answers can repeat the instructions). */
    const hiddenSuite = (ctx: Ctx, s: any) =>
      s.kind === 'agent' && !!db.get('SELECT id FROM agents WHERE id = ? AND location_id = ?', s.target_id, ctx.locationId) && !agentOf(ctx, s.target_id);
    const suiteOr404 = (ctx: Ctx) => {
      const s = parseJson(db.get('SELECT * FROM prompt_suites WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['cases', 'last_run']);
      if (!s || hiddenSuite(ctx, s)) throw notFound('Test nicht gefunden');
      return s;
    };

    /** The instructions under test: a KI-Agent's, the phone agent's (persona + instructions), or the suite's own text. */
    async function promptOf(ctx: Ctx, kind: string, targetId: string, own: string): Promise<string> {
      if (kind === 'agent') {
        const a = agentOf(ctx, targetId);
        if (!a) throw notFound('KI-Agent nicht gefunden');
        return `Du bist der KI-Agent „${a.name}“.\n${a.instructions}`;
      }
      if (kind === 'voice') {
        const s = await callRoute(app, ctx, 'GET', '/api/voice-ai/settings', {}, { quiet: true });
        return [s?.persona, s?.instructions].filter(Boolean).join('\n\n');
      }
      return own;
    }

    async function runCases(ctx: Ctx, prompt: string, cases: TestCase[]): Promise<CaseResult[]> {
      if (!prompt.trim()) throw bad('Die Anweisungen sind leer');
      if (!cases.length) throw bad('Mindestens einen Testfall mit Nachricht und Erwartung anlegen');
      const run = ai();
      const out: CaseResult[] = [];
      for (const c of cases) {
        const r = await run({ locationId: ctx.locationId, purpose: PURPOSE, system: [{ text: `${prompt}\n\nAntworte so, wie du dem Kunden antworten würdest (nur die Antwort).` }], user: c.input, maxTokens: 800, timeoutMs: 60_000, userId: ctx.user?.id ?? null });
        const answer = String(r.text ?? '').trim().slice(0, 4000);
        const g = await run({
          locationId: ctx.locationId,
          purpose: PURPOSE,
          system: [{ text: 'Du prüfst streng die Antwort eines KI-Agenten. Bewerte nur, ob die Antwort die Erwartung erfüllt (Inhalt, Ton, keine erfundenen Fakten). Antworte als JSON nach dem Schema.' }],
          user: `Kundennachricht:\n${c.input}\n\nErwartung:\n${c.expect}\n\nAntwort des Agenten:\n${answer}`,
          schema: GRADE_SCHEMA,
          maxTokens: 400,
          timeoutMs: 60_000,
          userId: ctx.user?.id ?? null,
        });
        const j = readJson(g.text) ?? {};
        const score = Math.max(0, Math.min(10, Math.round(Number(j.score) || 0)));
        out.push({ ...c, answer, pass: j.pass === true, score, reason: String(j.reason ?? '').slice(0, 500) });
      }
      return out;
    }

    // --- suites ------------------------------------------------------------------------------------------------------------------
    router.get('/api/prompt-lab', 'location', (ctx) => ({
      suites: parseRows(db.all('SELECT * FROM prompt_suites WHERE location_id = ? ORDER BY updated_at DESC', ctx.locationId), ['cases', 'last_run']).filter((s: any) => !hiddenSuite(ctx, s)),
      agents: ctx.user
        ? ((app.services.agentDefs?.listFor(ctx.user, ctx.locationId) ?? []) as { id: string; name: string; emoji: string }[]).map((a) => ({ id: a.id, name: a.name, emoji: a.emoji }))
        : db.all(`SELECT id, name, emoji FROM agents WHERE location_id = ? AND visibility <> 'private' ORDER BY name`, ctx.locationId),
    }));
    router.post('/api/prompt-lab', 'location', (ctx) => {
      const kind = ['agent', 'voice', 'custom'].includes(ctx.body?.kind) ? ctx.body.kind : 'custom';
      const targetId = kind === 'agent' ? str(ctx.body?.target_id, 'KI-Agent', { required: true }) : '';
      if (kind === 'agent' && !agentOf(ctx, targetId)) throw notFound('KI-Agent nicht gefunden');
      const row = { id: id(), location_id: ctx.locationId, kind, target_id: targetId, name: str(ctx.body?.name, 'Name', { required: true, max: 80 }), prompt: kind === 'custom' ? str(ctx.body?.prompt, 'Anweisungen', { max: 20_000 }) : '', cases: cleanCases(ctx.body?.cases), created_at: now(), updated_at: now() };
      db.insert('prompt_suites', row);
      return { ...row, last_run: null };
    });
    router.patch('/api/prompt-lab/:id', 'location', (ctx) => {
      const s = suiteOr404(ctx);
      const patch: Record<string, unknown> = { updated_at: now() };
      if (ctx.body?.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 80 });
      if (ctx.body?.cases !== undefined) patch.cases = cleanCases(ctx.body.cases);
      if (ctx.body?.prompt !== undefined && s.kind === 'custom') patch.prompt = str(ctx.body.prompt, 'Anweisungen', { max: 20_000 });
      db.update('prompt_suites', s.id, patch);
      return suiteOr404(ctx);
    });
    router.delete('/api/prompt-lab/:id', 'location', (ctx) => {
      db.run('DELETE FROM prompt_suites WHERE id = ? AND location_id = ?', suiteOr404(ctx).id, ctx.locationId);
      return { ok: true };
    });

    /** Runs the suite against the current instructions (or `prompt` from the body – a draft). */
    router.post('/api/prompt-lab/:id/run', 'location', async (ctx) => {
      const s = suiteOr404(ctx);
      const prompt = typeof ctx.body?.prompt === 'string' && ctx.body.prompt.trim() ? String(ctx.body.prompt).slice(0, 20_000) : await promptOf(ctx, s.kind, s.target_id, s.prompt);
      const results = await runCases(ctx, prompt, s.cases);
      const last = { at: now(), draft: typeof ctx.body?.prompt === 'string' && !!ctx.body.prompt.trim(), ...summarizeResults(results), results };
      if (!last.draft) db.update('prompt_suites', s.id, { last_run: last, updated_at: now() });
      return last;
    });
    /** Revised instructions from the last run's failures – a proposal, nothing is changed. */
    router.post('/api/prompt-lab/:id/improve', 'location', async (ctx) => {
      const s = suiteOr404(ctx);
      const prompt = await promptOf(ctx, s.kind, s.target_id, s.prompt);
      const results: CaseResult[] = Array.isArray(s.last_run?.results) ? s.last_run.results : [];
      if (!results.length) throw bad('Erst testen, dann verbessern');
      const failed = results.filter((r) => !r.pass || r.score < 8);
      if (!failed.length) return { instructions: prompt, changes: [], unchanged: true };
      const r = await ai()({
        locationId: ctx.locationId,
        purpose: PURPOSE,
        system: [{ text: 'Du verbesserst die Anweisungen (System-Prompt) eines KI-Agenten für ein kleines Unternehmen. Behalte alles bei, was funktioniert, ergänze klare Regeln für die fehlgeschlagenen Fälle, erfinde keine Fakten (Preise, Zeiten) – nutze stattdessen Platzhalter wie [PREIS]. Gleiche Sprache wie das Original. Antworte als JSON.' }],
        user: `Aktuelle Anweisungen:\n"""${prompt}"""\n\nFehlgeschlagene Tests:\n${failed.map((f, i) => `${i + 1}. Nachricht: ${f.input}\n   Erwartung: ${f.expect}\n   Antwort: ${f.answer}\n   Grund: ${f.reason}`).join('\n')}`,
        schema: IMPROVE_SCHEMA,
        maxTokens: 3000,
        timeoutMs: 90_000,
        userId: ctx.user?.id ?? null,
      });
      const j = readJson(r.text);
      if (!j?.instructions) throw new HttpError(502, 'Die KI hat keinen Vorschlag geliefert – bitte noch einmal versuchen');
      return { instructions: String(j.instructions).slice(0, 20_000), changes: (Array.isArray(j.changes) ? j.changes : []).map(String).slice(0, 12) };
    });
    /** Applies reviewed instructions to the target through its own route. */
    router.post('/api/prompt-lab/:id/apply', 'location', async (ctx) => {
      const s = suiteOr404(ctx);
      const text = str(ctx.body?.instructions, 'Anweisungen', { required: true, max: 20_000 });
      if (s.kind === 'agent') await callRoute(app, ctx, 'PATCH', `/api/agents/${s.target_id}`, { instructions: text });
      else if (s.kind === 'voice') await callRoute(app, ctx, 'PUT', '/api/voice-ai/settings', { instructions: text });
      else db.update('prompt_suites', s.id, { prompt: text, updated_at: now() });
      return { ok: true };
    });

    // --- MCP ---------------------------------------------------------------------------------------------------------------------
    const TOOLS: Tool[] = [
      {
        name: 'ghl_prompt_tests',
        title: 'Prompt-Tests anzeigen',
        description: 'Listet die Prompt-Tests (Testfälle für KI-Agenten, KI-Telefonagent oder eigene Prompts) mit dem Ergebnis des letzten Laufs (bestanden/gesamt, Punktzahl, Begründungen).',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' } }, required: ['location_id'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        run: (call, a) => call.api('GET', '/api/prompt-lab', { location: a.location_id }),
      },
      {
        name: 'ghl_prompt_test_run',
        title: 'Prompt-Test ausführen',
        description: 'Führt einen Prompt-Test aus: Jeder Testfall wird mit den aktuellen Anweisungen beantwortet und streng bewertet. Kostet KI-Aufrufe (2 je Testfall). Optional prompt = Entwurf testen, ohne zu speichern.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, suite_id: { type: 'string' }, prompt: { type: 'string' } }, required: ['location_id', 'suite_id'], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        run: (call, a) => call.api('POST', `/api/prompt-lab/${encodeURIComponent(a.suite_id)}/run`, { location: a.location_id, body: { prompt: a.prompt } }),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
