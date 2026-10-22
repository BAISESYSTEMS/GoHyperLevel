import type { Module } from '../core/app.js';
import { HttpError, bad } from '../core/http.js';
import { now } from '../core/util.js';
import {
  DEFAULT_EFFORT,
  EFFORTS,
  EFFORT_CAPS,
  EFFORT_CAP_IDS,
  EFFORT_COST_NOTE,
  EFFORT_LABELS,
  atLeast,
  capOfPurpose,
  isEffort,
  isEffortCap,
  isStrictCap,
  type Effort,
  type EffortCap,
} from '../services/ai-effort.js';

/**
 * "Denkstufe (Standard)" in the KI-Anbieter registry: how hard the models think. One default for everything
 * (`xhigh`), overridable per capability (agent chat, Werkstatt, review, quick texts, summaries, voice agent),
 * set for the whole agency and – optionally – for one sub-account. The Werkstatt and its reviews never go below
 * "high". The adapters (services/anthropic.ts, openai.ts, agent-llm.ts) lower a level to what the model takes and
 * say so; this module only stores the choice and hands it to `aiRun` and the agent:
 *
 *   app.services.aiEffort.forPurpose(locationId, 'werkstatt_build') → { cap, effort, strict }
 *   app.services.aiEffort.forCap(locationId, 'agent')
 *
 * Resolution, most specific first: the sub-account's own value for the capability, its own default, the
 * agency's value for the capability, the agency's default, `xhigh`.
 */

export interface EffortSettings {
  default?: Effort;
  caps?: Partial<Record<EffortCap, Effort>>;
}
const AGENCY = 'agency';

export interface EffortChoice {
  cap: EffortCap;
  effort: Effort;
  strict: boolean;
  /** Where the value comes from (for the settings screen). */
  source: 'location' | 'agency' | 'builtin';
}
export type AiEffortService = {
  forCap: (locationId: string, cap: EffortCap) => EffortChoice;
  forPurpose: (locationId: string, purpose: string) => EffortChoice;
};

export const aiEffortModule: Module = {
  name: 'ai-effort',
  migrations: [['001-init', `CREATE TABLE ai_effort (scope TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);`]],
  register(app) {
    const { db, router } = app;
    const load = (scope: string): EffortSettings => {
      try {
        const row = db.get<{ data: string }>('SELECT data FROM ai_effort WHERE scope = ?', scope);
        const v = row ? JSON.parse(row.data) : {};
        const caps: Partial<Record<EffortCap, Effort>> = {};
        for (const [k, e] of Object.entries(v.caps ?? {})) if (isEffortCap(k) && isEffort(e)) caps[k] = e;
        return { ...(isEffort(v.default) ? { default: v.default } : {}), caps };
      } catch {
        return { caps: {} };
      }
    };
    const save = (scope: string, s: EffortSettings) =>
      db.run('INSERT INTO ai_effort (scope, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', scope, JSON.stringify(s), now());

    const forCap = (locationId: string, cap: EffortCap): EffortChoice => {
      const own = locationId ? load(locationId) : { caps: {} as EffortSettings['caps'] };
      const ag = load(AGENCY);
      let effort: Effort = DEFAULT_EFFORT;
      let source: EffortChoice['source'] = 'builtin';
      const pick: [Effort | undefined, EffortChoice['source']][] = [
        [own.caps?.[cap], 'location'],
        [own.default, 'location'],
        [ag.caps?.[cap], 'agency'],
        [ag.default, 'agency'],
      ];
      for (const [v, s] of pick)
        if (v) {
          effort = v;
          source = s;
          break;
        }
      const strict = isStrictCap(cap);
      return { cap, effort: strict ? atLeast(effort, 'high') : effort, strict, source };
    };
    const service: AiEffortService = { forCap, forPurpose: (loc, purpose) => forCap(loc, capOfPurpose(purpose)) };
    app.services.aiEffort = service;

    const view = (locationId: string) => {
      const own = load(locationId);
      const ag = load(AGENCY);
      return {
        efforts: EFFORTS.map((id) => ({ id, label: EFFORT_LABELS[id] })),
        builtin_default: DEFAULT_EFFORT,
        default: own.default ?? ag.default ?? DEFAULT_EFFORT,
        own: { default: own.default ?? null },
        agency: { default: ag.default ?? null },
        caps: EFFORT_CAPS.map((c) => {
          const eff = forCap(locationId, c.id);
          return { id: c.id, label: c.label, strict: eff.strict, effective: eff.effort, source: eff.source, own: own.caps?.[c.id] ?? null, agency: ag.caps?.[c.id] ?? null };
        }),
        strict_min: 'high',
        note: EFFORT_COST_NOTE,
      };
    };

    router.get('/api/ai-effort', 'location', (ctx) => view(ctx.locationId));
    router.put('/api/ai-effort', 'location', (ctx) => {
      if (!ctx.user) throw new HttpError(403, 'Nur mit Anmeldung');
      const b = ctx.body ?? {};
      const agency = b.scope === 'agency';
      if (agency && ctx.user.role !== 'admin') throw new HttpError(403, 'Die Denkstufe der Agentur ändert nur ein Admin.');
      const scope = agency ? AGENCY : ctx.locationId;
      const cur = load(scope);
      const next: EffortSettings = { ...(cur.default ? { default: cur.default } : {}), caps: { ...(cur.caps ?? {}) } };
      const level = (v: unknown, what: string): Effort | null => {
        if (v === '' || v === null) return null;
        if (!isEffort(v)) throw bad(`${what}: ${EFFORTS.join(', ')} oder leer (= Standard).`);
        return v;
      };
      if (b.default !== undefined) {
        const e = level(b.default, 'Denkstufe (Standard)');
        if (e) next.default = e;
        else delete next.default;
      }
      if (b.caps !== undefined) {
        if (!b.caps || typeof b.caps !== 'object' || Array.isArray(b.caps)) throw bad('Denkstufen je Bereich als Objekt angeben.');
        for (const [k, v] of Object.entries(b.caps)) {
          if (!isEffortCap(k)) throw bad(`Unbekannter Bereich: ${k} (erlaubt: ${EFFORT_CAP_IDS.join(', ')}).`);
          const e = level(v, EFFORT_CAPS.find((c) => c.id === k)!.label);
          if (e) next.caps![k] = e;
          else delete next.caps![k];
        }
      }
      save(scope, next);
      return view(ctx.locationId);
    });
  },
};
