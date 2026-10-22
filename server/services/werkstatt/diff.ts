import type { Manifest } from './manifest.js';

/**
 * What a new version changed against the one before it, in words ("Ändern lassen" → v2): permissions, entry
 * points, size of the UI and server code. Shown in the chat, in the version list and in the build log.
 */

export interface VersionLike {
  version: string;
  manifest: Manifest;
  ui_html: string;
  server_js: string;
  steps: unknown;
}

export interface VersionDiff {
  from: string;
  to: string;
  scopes_added: string[];
  scopes_removed: string[];
  entries_added: string[];
  entries_removed: string[];
  ui: { added: number; removed: number };
  server: { added: number; removed: number };
  steps_changed: boolean;
  /** Plain German, one line each, for the chat card. */
  summary: string[];
}

const lines = (s: string) => (s ? s.split('\n').map((l) => l.trim()).filter(Boolean) : []);

/** Added and removed lines (LCS on trimmed non-empty lines; very large inputs fall back to a set comparison). */
export function lineDiff(a: string, b: string): { added: number; removed: number } {
  const x = lines(a);
  const y = lines(b);
  if (x.length * y.length > 4_000_000) {
    const sx = new Set(x);
    const sy = new Set(y);
    return { added: y.filter((l) => !sx.has(l)).length, removed: x.filter((l) => !sy.has(l)).length };
  }
  const dp: number[] = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    let prev = 0;
    for (let j = 1; j <= y.length; j++) {
      const tmp = dp[j];
      dp[j] = x[i - 1] === y[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const common = dp[y.length];
  return { added: y.length - common, removed: x.length - common };
}

const entryNames = (m: Manifest): string[] => [
  ...(m.entries.page ? ['Seite'] : []),
  ...(m.entries.panels ?? []).map((p) => `Panel „${p.title}“`),
  ...(m.entries.widgets ?? []).map((w) => `Widget „${w.title}“`),
  ...(m.entries.actions ?? []).map((a) => `Workflow-Aktion „${a.label}“`),
  ...(m.entries.jobs ?? []).map((j) => `Job „${j.label}“`),
];

export function diffVersions(prev: VersionLike, next: VersionLike): VersionDiff {
  const ps = new Set(prev.manifest.scopes);
  const ns = new Set(next.manifest.scopes);
  const pe = entryNames(prev.manifest);
  const ne = entryNames(next.manifest);
  const ui = lineDiff(prev.ui_html, next.ui_html);
  const server = lineDiff(prev.server_js, next.server_js);
  const steps_changed = JSON.stringify(prev.steps ?? null) !== JSON.stringify(next.steps ?? null);
  const d: VersionDiff = {
    from: prev.version,
    to: next.version,
    scopes_added: [...ns].filter((s) => !ps.has(s)),
    scopes_removed: [...ps].filter((s) => !ns.has(s)),
    entries_added: ne.filter((e) => !pe.includes(e)),
    entries_removed: pe.filter((e) => !ne.includes(e)),
    ui,
    server,
    steps_changed,
    summary: [],
  };
  const s = d.summary;
  if (d.scopes_added.length) s.push(`Neue Berechtigung${d.scopes_added.length === 1 ? '' : 'en'}: ${d.scopes_added.join(', ')} – braucht deine Bestätigung.`);
  if (d.scopes_removed.length) s.push(`Weniger Berechtigungen: ${d.scopes_removed.join(', ')}.`);
  if (d.entries_added.length) s.push(`Neu: ${d.entries_added.join(', ')}.`);
  if (d.entries_removed.length) s.push(`Entfernt: ${d.entries_removed.join(', ')}.`);
  if (ui.added || ui.removed) s.push(`Oberfläche: ${ui.added} Zeilen neu, ${ui.removed} entfernt.`);
  if (server.added || server.removed) s.push(`Server-Logik: ${server.added} Zeilen neu, ${server.removed} entfernt.`);
  if (steps_changed) s.push('Die deklarativen Schritte wurden angepasst.');
  if (!s.length) s.push('Keine inhaltliche Änderung gegenüber der Vorversion.');
  return d;
}
