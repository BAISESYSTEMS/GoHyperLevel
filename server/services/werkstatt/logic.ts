import type { App } from '../../core/app.js';
import type { Ctx, User } from '../../core/http.js';
import { id as newId, now } from '../../core/util.js';
import { ymdInTz } from '../../core/time.js';
import { Bridge } from './bridge.js';
import { staticChecks, splitUi, type CheckResult, type PluginFiles } from './checks.js';
import { runSteps, type StepsSpec } from './declarative.js';
import { recordEvent } from './health.js';
import type { Manifest } from './manifest.js';
import { opsFor } from './ops.js';
import { loadPolicy } from './policy.js';
import { probeSandbox, runSandbox } from './sandbox.js';

/**
 * Runs a plugin's server logic (workflow actions, scheduled jobs) as the user it belongs to: a script in the
 * sandbox or declarative steps, both through the scope-checking bridge. Also the self-test that runs every
 * handler with sample data before a version may become active.
 */

export interface LogicTarget {
  plugin: { id: string; name: string };
  manifest: Manifest;
  code: string;
  steps: unknown;
}
export interface LogicRun {
  target: LogicTarget;
  kind: 'action' | 'job';
  id: string;
  input?: Record<string, unknown>;
  user: User;
  locationId: string;
  baseCtx?: Ctx;
  /** Sample data instead of real calls (self-test). */
  dry?: boolean;
  quiet?: boolean;
  timeoutMs?: number;
}
export interface LogicResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  errorType?: string;
  logs: string[];
  calls: number;
  ms: number;
  denials: string[];
  killed?: string;
}

/** Date and place a run sees (`gohigh.context` in scripts, `{{today}}` in steps). */
export function runContext(app: App, locationId: string) {
  const loc = app.location(locationId);
  const tz = loc?.timezone || 'Europe/Berlin';
  const today = ymdInTz(new Date(), tz);
  return { today, today_md: today.slice(5), now: now(), location: { name: loc?.name ?? '', timezone: tz } };
}

export async function runLogic(app: App, r: LogicRun): Promise<LogicResult> {
  const started = Date.now();
  const m = r.target.manifest;
  const policy = loadPolicy(app);
  const bridge = new Bridge({ app, plugin: r.target.plugin, manifest: m, locationId: r.locationId, user: r.user, baseCtx: r.baseCtx, source: r.kind === 'job' ? 'job' : 'action', dry: r.dry, quiet: r.quiet });
  const mode = m.server?.mode;
  const ctx = runContext(app, r.locationId);
  const finish = (x: Omit<LogicResult, 'calls' | 'ms' | 'denials'>): LogicResult => {
    const out: LogicResult = { ...x, calls: bridge.calls, ms: Date.now() - started, denials: bridge.denials };
    if (!r.quiet) {
      app.db.insert('plugin_runs', { id: newId(), plugin_id: r.target.plugin.id, location_id: r.locationId, kind: r.kind, entry_id: r.id, status: out.ok ? 'ok' : 'error', detail: (out.ok ? out.logs.join(' | ') : (out.error ?? '')).slice(0, 500), ms: out.ms, created_at: now() });
      recordEvent(app, r.target.plugin.id, r.locationId, out.ok ? r.kind : 'error', out.ok ? r.id : `${r.id}: ${out.error ?? ''}`, out.ms);
    }
    return out;
  };
  if (policy.server_logic === 'off') return finish({ ok: false, error: 'Server-Logik für Plugins ist ausgeschaltet (Richtlinie).', logs: [] });
  if (mode === 'script') {
    if (policy.server_logic === 'declarative') return finish({ ok: false, error: 'Skripte sind laut Richtlinie aus – nur deklarative Plugins laufen.', logs: [] });
    const status = await probeSandbox();
    if (!status.ok) return finish({ ok: false, error: `Die Skript-Sandbox ist auf diesem Server nicht verfügbar: ${status.reason ?? 'unbekannt'}`, logs: [] });
    const res = await runSandbox({ mode: 'server', code: r.target.code, kind: r.kind, id: r.id, input: r.input ?? {}, ops: opsFor(m.scopes), context: { ...ctx, input: r.input ?? {} }, timeoutMs: r.timeoutMs ?? 10_000, maxCalls: 200, call: (op, args) => bridge.call(op, args) });
    return finish({ ok: res.ok, result: res.result, error: res.error, errorType: res.errorType, logs: res.logs, killed: res.killed });
  }
  if (mode === 'declarative') {
    try {
      const out = await runSteps((r.target.steps ?? {}) as StepsSpec, r.kind === 'job' ? 'jobs' : 'actions', r.id, { ...ctx, input: r.input ?? {}, contact: (r.input as any)?.contact ?? {} }, (op, args) => bridge.call(op, args));
      return finish({ ok: true, result: out.result, logs: out.log });
    } catch (e) {
      return finish({ ok: false, error: (e as Error).message, logs: [] });
    }
  }
  return finish({ ok: false, error: 'Dieses Plugin hat keine Server-Logik.', logs: [] });
}

// --- self-test ---------------------------------------------------------------------------------------------------

export interface SelfTest {
  ok: boolean;
  ui?: { ran: boolean; calls: number; errors: { type: string; message: string }[]; syntax?: string };
  /** One smoke run of the UI per entry point (page, every panel, every widget) – a plugin whose panel crashes fails even if its page works. */
  entries?: { kind: string; id: string; ok: boolean; error?: string }[];
  handlers: { kind: string; id: string; ok: boolean; error?: string; ms: number; calls: number }[];
  issues: { level: 'error' | 'warn'; message: string }[];
}

const SAMPLE_USER: User = { id: 'selftest', email: '', name: 'Selbsttest', role: 'admin', locations: [], permissions: null };

/** Sample input for a workflow action: every declared field filled, plus a contact. */
const sampleInput = (m: Manifest, id: string) => ({
  ...Object.fromEntries((m.entries.actions?.find((a) => a.id === id)?.fields ?? []).map((f) => [f.key, f.type === 'number' ? 1 : 'Beispiel'])),
  contact: { id: 'demo-c1', name: 'Anna Beispiel', email: 'anna@example.com' },
});

/** Runs the UI scripts against a stand-in browser and every handler with sample data; nothing real is read or written. */
export async function selfTest(app: App, files: PluginFiles, locationId: string): Promise<SelfTest> {
  const issues: SelfTest['issues'] = [];
  const out: SelfTest = { ok: true, handlers: [], issues };
  const m = files.manifest;
  const plugin = { id: 'selftest', name: m.name };
  const ctx = runContext(app, locationId);
  const status = await probeSandbox();
  // --- UI: scripts run once against a stub DOM; calls go through the bridge in sample mode ---
  if (files.ui_html.trim()) {
    const { scripts } = splitUi(files.ui_html);
    if (scripts.length && status.ok) {
      // Every entry point gets its own smoke run with the context it will have (a panel knows its contact, a widget no entity).
      const points: { kind: string; id: string; entity: { type: string; id: string } | null }[] = [
        ...(m.entries.page ? [{ kind: 'page', id: 'main', entity: null }] : []),
        ...(m.entries.panels ?? []).map((p) => ({ kind: 'panel', id: p.id, entity: { type: p.on, id: p.on === 'deal' ? 'demo-d1' : 'demo-c1' } })),
        ...(m.entries.widgets ?? []).map((w) => ({ kind: 'widget', id: w.id, entity: null })),
      ];
      if (!points.length) points.push({ kind: 'page', id: 'main', entity: { type: 'contact', id: 'demo-c1' } });
      out.ui = { ran: true, calls: 0, errors: [] };
      out.entries = [];
      for (const pt of points) {
        const bridge = new Bridge({ app, plugin, manifest: m, locationId, user: SAMPLE_USER, source: 'selftest', dry: true, quiet: true });
        const res = await runSandbox({ mode: 'ui', scripts, ops: opsFor(m.scopes), context: { ...ctx, entry: { kind: pt.kind, id: pt.id }, entity: pt.entity, plugin: { name: m.name, version: m.version }, demo: true }, timeoutMs: 6000, maxCalls: 60, call: (op, args) => bridge.call(op, args) });
        const where = `${pt.kind === 'page' ? 'Seite' : pt.kind === 'panel' ? `Panel „${pt.id}“` : `Widget „${pt.id}“`}`;
        out.ui.calls += bridge.calls;
        out.ui.errors.push(...(res.errors ?? []));
        if (res.syntax) out.ui.syntax = res.error;
        out.entries.push({ kind: pt.kind, id: pt.id, ok: !res.syntax && res.ok && !(res.errors ?? []).length && !bridge.denials.length, ...(res.ok ? {} : { error: res.error }) });
        // The same script runs everywhere: a syntax error is reported once, everything else per entry point.
        if (res.syntax) {
          if (pt === points[0]) issues.push({ level: 'error', message: `Selbsttest Oberfläche: ${res.error}` });
        } else if (!res.ok) issues.push({ level: 'warn', message: `Selbsttest ${where}: ${res.error ?? 'abgebrochen'}` });
        for (const e of res.errors ?? []) issues.push({ level: 'warn', message: `Selbsttest ${where} (Beispieldaten): ${e.type}: ${e.message}` });
        for (const d of bridge.denials) issues.push({ level: 'error', message: `Selbsttest ${where}: Aufruf nicht erlaubt – ${d}` });
      }
    } else if (scripts.length) out.ui = { ran: false, calls: 0, errors: [] };
  }
  // --- server handlers ---
  const target: LogicTarget = { plugin, manifest: m, code: files.server_js, steps: files.steps };
  const handlers = [...(m.entries.actions ?? []).map((a) => ['action', a.id] as const), ...(m.entries.jobs ?? []).map((j) => ['job', j.id] as const)];
  for (const [kind, id] of handlers) {
    if (!m.server) break;
    const r = await runLogic(app, { target, kind, id, input: kind === 'action' ? sampleInput(m, id) : {}, user: SAMPLE_USER, locationId, dry: true, quiet: true, timeoutMs: 6000 });
    out.handlers.push({ kind, id, ok: r.ok, error: r.error, ms: r.ms, calls: r.calls });
    for (const d of r.denials) issues.push({ level: 'error', message: `Selbsttest ${kind} „${id}“: Aufruf nicht erlaubt – ${d}` });
    if (!r.ok) {
      // A TypeError on sample data may only mean the sample lacks a field; everything else is a real defect.
      const soft = r.errorType === 'TypeError';
      issues.push({ level: soft ? 'warn' : 'error', message: `Selbsttest ${kind} „${id}“: ${r.error}${soft ? ' (mit Beispieldaten – bitte Fälle ohne Daten prüfen)' : ''}` });
    }
  }
  out.ok = !issues.some((i) => i.level === 'error');
  return out;
}

export interface Verification {
  ok: boolean;
  static: CheckResult;
  selftest?: SelfTest;
  issues: { level: 'error' | 'warn'; message: string; code?: string }[];
  ran_at: string;
}

/** Static checks, then the self-test (only when the static ones passed). The result is stored with the version. */
export async function verify(app: App, files: PluginFiles, locationId: string): Promise<Verification> {
  const policy = loadPolicy(app);
  const status = await probeSandbox();
  const st = staticChecks(files, { allowedHosts: policy.allowed_hosts, serverLogic: policy.server_logic, sandboxOk: status.ok });
  const issues: Verification['issues'] = st.issues.map((i) => ({ level: i.level, message: i.message, code: i.code }));
  let selftest: SelfTest | undefined;
  if (st.ok) {
    selftest = await selfTest(app, files, locationId);
    issues.push(...selftest.issues);
  }
  return { ok: st.ok && (selftest?.ok ?? false), static: st, selftest, issues, ran_at: now() };
}

export const verificationText = (v: Verification) => v.issues.filter((i) => i.level === 'error').map((i) => `- ${i.message}`).join('\n');
