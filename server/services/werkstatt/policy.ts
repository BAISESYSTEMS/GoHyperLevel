import type { App } from '../../core/app.js';
import { bad, type User } from '../../core/http.js';
import { HOST_RE } from './manifest.js';
import { monthStart } from '../ai-context.js';
import { NAMES } from './names.js';
import { isPublicKey } from './signing.js';
import { DEFAULT_GATE, cleanPatterns, loadGate, GATE_FAMILY_IDS, type ModelGate } from './modelgate.js';

/**
 * Admin policy of the Werkstatt (agency-wide, stored in agency_settings): who may start builds, whether
 * they need an admin's approval, the monthly AI budget per sub-account, which external hosts plugins may
 * use, how server logic runs, when the kill switch trips and where core proposals go.
 */

export type Who = 'admins' | 'team' | 'everyone';
export interface Policy {
  who: Who;
  /** Besides `who`: these people may build even when `who` is "admins" (e.g. one tester) … */
  allow_users: string[];
  /** … and so may everyone in these sub-accounts. Grants only – never restricts a wider `who`. */
  allow_locations: string[];
  /** How often the AI may be asked to repair an unusable answer or failed check before a build gives up. */
  repair_rounds: number;
  /** Builds by non-admins wait for an admin's approval. */
  approval: boolean;
  /** AI budget per sub-account and month in US dollars (what builds may cost). */
  budget_usd: number;
  /** Own budget per sub-account (overrides the default). */
  budgets: Record<string, number>;
  /** External hosts plugins may declare (images, fonts, scripts, connections). */
  allowed_hosts: string[];
  /** script = sandboxed code for jobs/actions (if the runtime is safe here), declarative = steps only, off = no server logic. */
  server_logic: 'script' | 'declarative' | 'off';
  /** Kill switch: this many errors within the window and at least this share of all events switch a plugin off. */
  kill: { errors: number; window_min: number; ratio: number; /** Average response time in ms that switches a plugin off (0 = off), judged over at least `min_calls` calls in the window. */ latency_ms: number; min_calls: number };
  /** Stage 3: where "Als Kernfeature vorschlagen" opens its issue. */
  core: { repo: string; agent: 'codex' | 'claude'; location_id: string };
  /** "Mindest-Modell für die Werkstatt": only top models write code and review it (services/werkstatt/modelgate.ts). */
  model_gate: ModelGate;
  /** Public keys (Ed25519) of publishers whose signed plugin bundles count as „signiert“ (besides the built-in HyperLevel keys). */
  trusted_keys: { id: string; label: string; public_key: string }[];
  /** Before publishing: the second opinion of another top model is required (Pro; only when a second model is connected). */
  second_opinion: boolean;
}

export const DEFAULT_POLICY: Policy = {
  who: 'admins',
  allow_users: [],
  allow_locations: [],
  repair_rounds: 2,
  approval: true,
  budget_usd: 5,
  budgets: {},
  allowed_hosts: [],
  server_logic: 'script',
  kill: { errors: 10, window_min: 10, ratio: 0.5, latency_ms: 8000, min_calls: 10 },
  core: { repo: '', agent: 'codex', location_id: '' },
  model_gate: DEFAULT_GATE,
  trusted_keys: [],
  second_opinion: true,
};

const KEY = 'werkstatt';
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function loadPolicy(app: App): Policy {
  const row = app.db.get<{ value: string }>('SELECT value FROM agency_settings WHERE key = ?', KEY);
  let v: any = {};
  try {
    v = row ? JSON.parse(row.value) : {};
  } catch {
    v = {};
  }
  return { ...DEFAULT_POLICY, ...v, allow_users: Array.isArray(v.allow_users) ? v.allow_users : [], allow_locations: Array.isArray(v.allow_locations) ? v.allow_locations : [], budgets: { ...(v.budgets ?? {}) }, kill: { ...DEFAULT_POLICY.kill, ...(v.kill ?? {}) }, core: { ...DEFAULT_POLICY.core, ...(v.core ?? {}) }, model_gate: loadGate(v.model_gate), trusted_keys: Array.isArray(v.trusted_keys) ? v.trusted_keys.filter((k: any) => k && typeof k.id === 'string' && typeof k.public_key === 'string') : [], second_opinion: v.second_opinion === undefined ? true : !!v.second_opinion, allowed_hosts: Array.isArray(v.allowed_hosts) ? v.allowed_hosts : [] };
}

export function savePolicy(app: App, p: Policy) {
  app.db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(p));
}

/** Merges a request body into the policy, checking every field. */
export function cleanPolicy(app: App, cur: Policy, b: Record<string, any>): Policy {
  const next: Policy = { ...cur, allow_users: [...cur.allow_users], allow_locations: [...cur.allow_locations], budgets: { ...cur.budgets }, kill: { ...cur.kill }, core: { ...cur.core }, model_gate: { ...cur.model_gate, families: [...cur.model_gate.families], extra: [...cur.model_gate.extra] }, trusted_keys: cur.trusted_keys.map((k) => ({ ...k })) };
  if (b.who !== undefined) {
    if (!['admins', 'team', 'everyone'].includes(b.who)) throw bad('„Wer darf bauen“: admins, team oder everyone.');
    next.who = b.who;
  }
  for (const [key, what] of [['allow_users', 'Erlaubte Personen'], ['allow_locations', 'Erlaubte Sub-Accounts']] as const) {
    if (b[key] === undefined) continue;
    if (!Array.isArray(b[key])) throw bad(`${what} als Liste angeben.`);
    const ids = [...new Set((b[key] as unknown[]).map((x) => String(x).trim()).filter(Boolean))].slice(0, 300);
    // Unknown ids are dropped (a deleted user or sub-account cannot keep a grant).
    next[key] = ids.filter((id) => (key === 'allow_users' ? !!app.db.get('SELECT 1 FROM users WHERE id = ?', id) : !!app.location(id)));
  }
  if (b.repair_rounds !== undefined) next.repair_rounds = Math.round(num(b.repair_rounds, 0, 4, cur.repair_rounds));
  if (b.approval !== undefined) next.approval = !!b.approval;
  if (b.budget_usd !== undefined) next.budget_usd = Math.round(num(b.budget_usd, 0, 10_000, cur.budget_usd) * 100) / 100;
  if (b.budgets !== undefined) {
    if (!b.budgets || typeof b.budgets !== 'object' || Array.isArray(b.budgets)) throw bad('Budgets je Sub-Account als Objekt angeben.');
    next.budgets = {};
    for (const [loc, v] of Object.entries(b.budgets).slice(0, 500)) {
      if (!app.location(loc)) continue;
      next.budgets[loc] = Math.round(num(v, 0, 10_000, cur.budget_usd) * 100) / 100;
    }
  }
  if (b.allowed_hosts !== undefined) {
    if (!Array.isArray(b.allowed_hosts)) throw bad('Erlaubte Hosts als Liste angeben.');
    const hosts = [...new Set(b.allowed_hosts.map((h: unknown) => String(h).trim().toLowerCase()).filter(Boolean))].slice(0, 50);
    for (const h of hosts) if (!HOST_RE.test(h)) throw bad(`Ungültiger Host: ${h} (nur der Name, z. B. cdn.example.com).`);
    next.allowed_hosts = hosts;
  }
  if (b.server_logic !== undefined) {
    if (!['script', 'declarative', 'off'].includes(b.server_logic)) throw bad('Server-Logik: script, declarative oder off.');
    next.server_logic = b.server_logic;
  }
  if (b.kill && typeof b.kill === 'object') {
    next.kill = { errors: Math.round(num(b.kill.errors, 3, 1000, cur.kill.errors)), window_min: Math.round(num(b.kill.window_min, 1, 1440, cur.kill.window_min)), ratio: Math.round(num(b.kill.ratio, 0.1, 1, cur.kill.ratio) * 100) / 100, latency_ms: Math.round(num(b.kill.latency_ms, 0, 120_000, cur.kill.latency_ms)), min_calls: Math.round(num(b.kill.min_calls, 3, 1000, cur.kill.min_calls)) };
  }
  if (b.second_opinion !== undefined) next.second_opinion = !!b.second_opinion;
  if (b.trusted_keys !== undefined) {
    if (!Array.isArray(b.trusted_keys)) throw bad('Vertrauenswürdige Schlüssel als Liste angeben.');
    const seen = new Set<string>();
    next.trusted_keys = b.trusted_keys.slice(0, 20).map((k: any) => {
      const id = String(k?.id ?? '').trim().toLowerCase();
      const public_key = String(k?.public_key ?? '').trim();
      if (!/^[a-z0-9._-]{2,40}$/.test(id)) throw bad('Schlüssel-ID: 2–40 Zeichen (a-z, 0-9, . _ -).');
      if (seen.has(id)) throw bad(`Die Schlüssel-ID „${id}“ gibt es doppelt.`);
      seen.add(id);
      if (!isPublicKey(public_key)) throw bad(`Der öffentliche Schlüssel „${id}“ ist kein gültiger Ed25519-Schlüssel (base64 oder PEM).`);
      return { id, label: String(k?.label ?? id).trim().slice(0, 60) || id, public_key };
    });
  }
  if (b.model_gate && typeof b.model_gate === 'object') {
    const g = b.model_gate;
    if (g.enabled !== undefined) next.model_gate.enabled = !!g.enabled;
    if (g.newer !== undefined) next.model_gate.newer = !!g.newer;
    if (g.stage1_normal !== undefined) next.model_gate.stage1_normal = !!g.stage1_normal;
    if (g.families !== undefined) {
      if (!Array.isArray(g.families)) throw bad('Modell-Familien als Liste angeben.');
      const ids: string[] = [...new Set<string>(g.families.map((x: unknown) => String(x)))];
      const unknown = ids.find((id) => !GATE_FAMILY_IDS.includes(id));
      if (unknown) throw bad(`Unbekannte Modell-Familie: ${unknown}.`);
      next.model_gate.families = ids;
    }
    if (g.extra !== undefined) next.model_gate.extra = cleanPatterns(g.extra, bad);
  }
  if (b.core && typeof b.core === 'object') {
    if (b.core.repo !== undefined) {
      const repo = String(b.core.repo).trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '');
      if (repo && !REPO_RE.test(repo)) throw bad('Repository bitte als besitzer/name angeben, z. B. acme/gohigh.');
      next.core.repo = repo;
    }
    if (b.core.agent !== undefined) {
      if (!['codex', 'claude'].includes(b.core.agent)) throw bad('Coding-Agent: codex oder claude.');
      next.core.agent = b.core.agent;
    }
    if (b.core.location_id !== undefined) {
      const loc = String(b.core.location_id);
      if (loc && !app.location(loc)) throw bad('Sub-Account für den GitHub-Zugang nicht gefunden.');
      next.core.location_id = loc;
    }
  }
  return next;
}

/** May this user start a build in this sub-account? A message when not. */
export function mayBuild(policy: Policy, user: User | undefined, locationId: string): { ok: true } | { ok: false; reason: string } {
  const granted = policy.allow_locations.includes(locationId);
  // Sub-account API keys have no person behind them: they act like the sub-account's team.
  if (!user) return policy.who === 'admins' && !granted ? { ok: false, reason: `${NAMES.werkstatt}: Bauen ist Admins vorbehalten (Richtlinie).` } : { ok: true };
  if (user.role === 'admin') return { ok: true };
  if (!user.locations.includes(locationId)) return { ok: false, reason: 'Kein Zugriff auf diesen Sub-Account.' };
  // An explicit grant (this person, or this whole sub-account) opens building whatever `who` says.
  if (granted || policy.allow_users.includes(user.id)) return { ok: true };
  if (policy.who === 'admins') return { ok: false, reason: `In der ${NAMES.werkstatt} bauen nur Admins – frag deine Agentur, ob du dafür freigeschaltet werden kannst.` };
  if (policy.who === 'team' && user.permissions && !user.permissions.includes('settings')) return { ok: false, reason: `In der ${NAMES.werkstatt} bauen nur Team-Mitglieder mit Zugriff auf die Einstellungen.` };
  return { ok: true };
}

/** Does a build by this person wait for an admin? */
export const needsApproval = (policy: Policy, user: User | undefined) => policy.approval && !(user && user.role === 'admin');

export const budgetUsd = (policy: Policy, locationId: string) => policy.budgets[locationId] ?? policy.budget_usd;

/** AI cost of builds in this sub-account since the start of the month (micro-dollars). */
export function spentMicros(app: App, locationId: string): number {
  const tz = app.location(locationId)?.timezone || 'Europe/Berlin';
  return Number(app.db.get<{ n: number }>(`SELECT COALESCE(SUM(cost_micros), 0) AS n FROM werkstatt_builds WHERE location_id = ? AND created_at >= ?`, locationId, monthStart(tz))?.n ?? 0);
}

export const usd = (micros: number) => `${(micros / 1e6).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} US-Dollar`;

/** Why the budget does not allow another AI call of about `estimateMicros`, or null. */
export function budgetProblem(app: App, policy: Policy, locationId: string, estimateMicros = 0): string | null {
  const limit = Math.round(budgetUsd(policy, locationId) * 1e6);
  const used = spentMicros(app, locationId);
  if (used + estimateMicros > limit) return `Das Monatsbudget der ${NAMES.werkstatt} ist ${used >= limit ? 'aufgebraucht' : 'zu klein für diesen Auftrag'} (${usd(used)} von ${usd(limit)}${estimateMicros ? `, geschätzt ${usd(estimateMicros)}` : ''}). Ein Admin kann es unter ${NAMES.werkstatt} → Richtlinien erhöhen.`;
  return null;
}
