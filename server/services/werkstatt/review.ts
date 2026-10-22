import { REVIEW_CHECKS, type Review } from './generate.js';
import type { CheckResult, PluginFiles } from './checks.js';
import { SCOPES } from './manifest.js';
import type { Verification } from './logic.js';

/**
 * The automatic security review before a plugin may go to the Marktplatz: a checklist an AI agent works
 * through, plus the facts a program can establish by itself (static checks, self-test, declared hosts, scopes
 * that are never used). The program's findings can only make the verdict worse, never better – a plugin that
 * fails the static checks is "fail" whatever the AI says.
 */

type Check = Review['checks'][number];
const CRITICAL = ['no-exfiltration', 'no-external-resources', 'no-dangerous-apis'];

export function autoChecks(files: PluginFiles, v: Pick<Verification, 'ok' | 'static' | 'selftest'>): Check[] {
  const st: CheckResult = v.static;
  const m = files.manifest;
  const unused = m.scopes.filter((s) => !st.stats.scopes_used.includes(s));
  const writes = m.scopes.filter((s) => SCOPES[s]?.write);
  const label = (id: string) => REVIEW_CHECKS.find(([k]) => k === id)![1];
  const c = (id: string, ok: boolean, note: string): Check => ({ id, label: label(id), ok, note, source: 'auto' });
  const hasHosts = (m.externalHosts?.length ?? 0) > 0 || st.stats.external_hosts.length > 0;
  return [
    c('scopes-minimal', unused.length === 0, unused.length ? `Nicht benutzte Berechtigungen: ${unused.join(', ')}.` : `${m.scopes.length} Berechtigung${m.scopes.length === 1 ? '' : 'en'}, alle im Code benutzt.`),
    c('no-exfiltration', st.ok && !hasHosts, !st.ok ? 'Die automatische Prüfung hat verbotene Zugriffe gefunden.' : hasHosts ? 'Das Plugin deklariert externe Hosts.' : 'Kein Netzwerk, keine Navigation, keine externen Adressen im Code.'),
    c('no-external-resources', !hasHosts, hasHosts ? `Externe Hosts: ${[...new Set([...(m.externalHosts ?? []), ...st.stats.external_hosts])].join(', ')}.` : 'Keine externen Ressourcen.'),
    c('no-dangerous-apis', st.ok, st.ok ? 'Keine verbotenen APIs gefunden.' : st.issues.filter((i) => i.level === 'error').slice(0, 3).map((i) => i.message).join(' ')),
    c('writes-justified', writes.length <= 2, writes.length ? `Schreibende Berechtigungen: ${writes.join(', ')}.` : 'Nur lesender Zugriff.'),
    c('ai-injection', !(m.scopes.includes('ai:run') && writes.length > 0), m.scopes.includes('ai:run') && writes.length ? 'Das Plugin nutzt KI und darf schreiben – KI-Antworten dürfen keine Schreibzugriffe auslösen.' : 'Kein Zusammenspiel von KI und Schreibzugriff.'),
    c('robustness', !!v.selftest?.ok, v.selftest?.ok ? 'Der Selbsttest in der Sandbox lief ohne Fehler.' : 'Der Selbsttest hat Fehler gemeldet.'),
  ];
}

const rank = { pass: 0, warn: 1, fail: 2 } as const;

/** AI verdict + program findings → final review. A failed critical check by the program means "fail". */
export function mergeReview(ai: Review, auto: Check[]): Review {
  const byId = new Map(ai.checks.map((c) => [c.id, c]));
  const checks: Check[] = REVIEW_CHECKS.map(([id, label]) => {
    const a = byId.get(id);
    const p = auto.find((x) => x.id === id);
    // Both views are kept: a failing automatic finding wins, otherwise the AI's note is shown.
    if (p && !p.ok) return { ...p, note: `${p.note}${a && a.note ? ` – KI: ${a.note}` : ''}` };
    if (a) return p ? { ...a, note: a.note || p.note } : a;
    return p ?? { id, label, ok: true, note: 'Nicht beurteilt.', source: 'auto' };
  });
  let verdict = ai.verdict;
  if (auto.some((c) => !c.ok && CRITICAL.includes(c.id))) verdict = 'fail';
  else if (verdict === 'pass' && checks.some((c) => !c.ok)) verdict = 'warn';
  if (rank[verdict] < rank[ai.verdict]) verdict = ai.verdict;
  return { verdict, summary: ai.summary, checks };
}
