import { bareModel } from '../ai-effort.js';

/**
 * "Mindest-Modell für die Werkstatt": writing code and security reviews are only as good as the model behind
 * them, so the Werkstatt only works with a top model. The agency decides which: four families are built in
 * (GPT-6 Sol, Astra, Claude Opus 5.5, Claude Fable 5.5), "newer versions of these families" can be allowed too,
 * and an admin can add patterns of his own. Patterns are case-insensitive globs (`*`) and also match behind a
 * vendor prefix ("anthropic/claude-opus-5.5" on OpenRouter). Pure logic – the policy stores the settings.
 */

export interface GateFamily {
  id: string;
  label: string;
  /** Glob patterns of the model ids that belong to the family (also matched without a vendor prefix). */
  patterns: string[];
  /** Does a model id belong to a *newer* version of the family? (Versions are compared, not guessed.) */
  newer: (bare: string) => boolean;
}

/** "5-5" → [5, 5]; a build date such as 20250514 is not a minor version. */
const ver = (bare: string, re: RegExp): [number, number] | null => {
  const x = re.exec(bare);
  return x ? [Number(x[1]), x[2] === undefined ? 0 : Number(x[2])] : null;
};
const atLeast = (v: [number, number] | null, major: number, minor: number) => !!v && (v[0] > major || (v[0] === major && v[1] >= minor));
const CLAUDE = (family: string) => (bare: string) => atLeast(ver(bare, new RegExp(`${family}-(\\d+)(?:-(\\d{1,2})(?!\\d))?`)), 5, 5);

export const GATE_FAMILIES: GateFamily[] = [
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', patterns: ['gpt-6*sol*'], newer: (b) => /^gpt-(\d+)/.test(b) && /(^|-)sol(-|$)/.test(b) && Number(/^gpt-(\d+)/.exec(b)![1]) >= 6 },
  { id: 'astra', label: 'Astra', patterns: ['*astra*'], newer: (b) => /astra/.test(b) },
  { id: 'opus-5-5', label: 'Claude Opus 5.5', patterns: ['*opus-5-5*', '*opus-5.5*'], newer: CLAUDE('opus') },
  { id: 'fable-5-5', label: 'Claude Fable 5.5', patterns: ['*fable-5-5*', '*fable-5.5*'], newer: CLAUDE('fable') },
];
export const GATE_FAMILY_IDS = GATE_FAMILIES.map((f) => f.id);

export interface ModelGate {
  /** false = every model is accepted (the Werkstatt works with whatever is connected). */
  enabled: boolean;
  /** Which built-in families count (all by default). */
  families: string[];
  /** Newer versions of these families count too (GPT-7 Sol, Opus 5.6, Fable 6 …). */
  newer: boolean;
  /** The admin's own patterns. */
  extra: string[];
  /** Stufe 1 (Einrichtung: no code) may be planned with the everyday model. */
  stage1_normal: boolean;
}

export const DEFAULT_GATE: ModelGate = { enabled: true, families: GATE_FAMILY_IDS, newer: true, extra: [], stage1_normal: true };

/** The words the German message uses for the built-in choice. */
export const GATE_EXAMPLES = 'GPT-6 Sol, Astra, Claude Opus 5.5 oder Fable 5.5';

const PATTERN_RE = /^[a-z0-9*._:/@+-]{1,80}$/;

/** Validated and normalised custom patterns; throws a German message for a bad one. */
export function cleanPatterns(list: unknown, fail: (msg: string) => Error): string[] {
  if (!Array.isArray(list)) throw fail('Eigene Muster als Liste angeben.');
  const out: string[] = [];
  for (const raw of list.slice(0, 40)) {
    const p = String(raw).trim().toLowerCase();
    if (!p) continue;
    if (!PATTERN_RE.test(p)) throw fail(`Ungültiges Muster „${p}“ (erlaubt: Buchstaben, Ziffern, . - _ : / und * als Platzhalter).`);
    if (p.replace(/\*/g, '').length < 3) throw fail(`Das Muster „${p}“ ist zu allgemein – mindestens drei feste Zeichen, z. B. *mein-modell*.`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

const regexOf = (glob: string) => new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

/** Does a model id match a glob – as written, without its vendor prefix, and with dots read as dashes? */
export function matchesGlob(model: string, glob: string): boolean {
  const re = regexOf(glob.toLowerCase());
  const lower = String(model ?? '').toLowerCase();
  return [lower, lower.replace(/^[a-z0-9._-]+\//, ''), bareModel(lower)].some((m) => re.test(m));
}

export interface GateVerdict {
  ok: boolean;
  /** Which rule let the model through (family label or pattern), for the status screen. */
  matched?: string;
}

export function checkModel(model: string, gate: ModelGate): GateVerdict {
  if (!gate.enabled) return { ok: true, matched: 'Prüfung ausgeschaltet' };
  const m = String(model ?? '').trim();
  if (!m) return { ok: false };
  const bare = bareModel(m);
  for (const f of GATE_FAMILIES) {
    if (!gate.families.includes(f.id)) continue;
    if (f.patterns.some((p) => matchesGlob(m, p))) return { ok: true, matched: f.label };
    if (gate.newer && f.newer(bare)) return { ok: true, matched: `${f.label} (neuere Version)` };
  }
  for (const p of gate.extra) if (matchesGlob(m, p)) return { ok: true, matched: p };
  return { ok: false };
}

/** Where people fix it (the web route of the routing table). */
export const GATE_LINK = '/app/settings/ai-providers';

/** The German refusal. `admin` decides whether the person can fix it themselves. */
export function gateMessage(model: string, admin: boolean): string {
  const now = model ? `aktuell ist „${model}“ eingestellt` : 'aktuell ist kein Modell eingestellt';
  return `Für die Werkstatt brauchst du ein Spitzenmodell (z. B. ${GATE_EXAMPLES}) – ${now}. ${admin ? `Wähle unter Einstellungen → KI-Anbieter bei „Werkstatt“ ein passendes Modell (${GATE_LINK}).` : `Bitte einen Admin, unter Einstellungen → KI-Anbieter (${GATE_LINK}) bei „Werkstatt“ ein passendes Modell zu hinterlegen.`}`;
}

/** Merges stored settings with the defaults (unknown family ids and junk are dropped). */
export function loadGate(v: any): ModelGate {
  if (!v || typeof v !== 'object') return { ...DEFAULT_GATE, families: [...DEFAULT_GATE.families], extra: [] };
  return {
    enabled: v.enabled === undefined ? DEFAULT_GATE.enabled : !!v.enabled,
    families: Array.isArray(v.families) ? v.families.map(String).filter((id: string) => GATE_FAMILY_IDS.includes(id)) : [...DEFAULT_GATE.families],
    newer: v.newer === undefined ? DEFAULT_GATE.newer : !!v.newer,
    extra: Array.isArray(v.extra) ? v.extra.map(String).filter((p: string) => PATTERN_RE.test(p)).slice(0, 40) : [],
    stage1_normal: v.stage1_normal === undefined ? DEFAULT_GATE.stage1_normal : !!v.stage1_normal,
  };
}

/** Purposes that write code or judge it: always need a top model. Planning needs one only when Stufe 1 may not use the normal one. */
export const GATED_PURPOSES = ['werkstatt_build', 'werkstatt_spec', 'werkstatt_review', 'werkstatt_review2'];
export const needsTopModel = (purpose: string, gate: ModelGate) => gate.enabled && (GATED_PURPOSES.includes(purpose) || (purpose === 'werkstatt_plan' && !gate.stage1_normal));
