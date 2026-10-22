import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { RUNNER_SOURCE } from './runner-source.js';

/**
 * Runs plugin server logic (and the UI/server self-test) in a child process with no ambient authority.
 * See runner-source.ts for the layers. This file is the parent side: spawn with `node --permission` (no
 * --allow-* flag at all: no file system, child process, worker, addon), an empty environment, a memory cap,
 * a hard wall-clock kill, a limit on calls, and an IPC protocol of plain JSON – every call a plugin makes
 * arrives here as a message and is answered by the bridge (scopes, user rights); the child never gets data
 * any other way. Node 22's permission model does not restrict the network, so the runner closes the network
 * modules itself and, where the host allows it, the child is started in a new network namespace.
 */

export interface SandboxRun {
  mode: 'server' | 'ui';
  /** server: the plugin script. */
  code?: string;
  /** ui: the page's inline scripts. */
  scripts?: string[];
  /** server: action | job | check (load only and report registered handlers). */
  kind?: 'action' | 'job' | 'check';
  id?: string;
  input?: unknown;
  /** Operations the plugin may call (what gohigh offers); the bridge checks every call again. */
  ops: string[];
  context: Record<string, unknown>;
  timeoutMs?: number;
  memoryMb?: number;
  maxCalls?: number;
  call: (op: string, args: unknown) => Promise<unknown>;
}

export interface SandboxResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  errorType?: string;
  logs: string[];
  /** Syntax error in UI scripts / runtime errors of the UI smoke test. */
  syntax?: boolean;
  errors?: { type: string; message: string }[];
  registered?: { action: string[]; job: string[] };
  calls: number;
  ms: number;
  killed?: 'timeout' | 'memory' | 'crash' | 'calls';
}

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_MEMORY = 96;
const MAX_CONCURRENT = 2;
let running = 0;
const queue: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

/** Where `unshare` lives, if it works here (a new user + network namespace: no network at all for the child). */
let netns: { bin: string } | null | undefined;
function netnsLauncher(): { bin: string } | null {
  if (netns !== undefined) return netns;
  netns = null;
  if (process.platform !== 'linux' || process.env.PGHL_PLUGIN_NETNS === 'off') return netns;
  const bin = ['/usr/bin/unshare', '/bin/unshare'].find((p) => existsSync(p));
  if (!bin) return netns;
  try {
    const r = spawnSync(bin, ['-rn', '--', process.execPath, '--permission', '-e', 'process.exit(0)'], { env: {}, timeout: 5000, stdio: 'ignore' });
    if (r.status === 0) netns = { bin };
  } catch {
    netns = null;
  }
  return netns;
}

/** Node flags of every sandbox process: permission model without any allowance, memory cap, no string code generation, no warnings. */
export const sandboxFlags = (memoryMb: number) => ['--permission', `--max-old-space-size=${memoryMb}`, '--disallow-code-generation-from-strings', '--no-warnings', '-e', RUNNER_SOURCE];

function launch(memoryMb: number): ChildProcess {
  const flags = sandboxFlags(memoryMb);
  const ns = netnsLauncher();
  const [cmd, args] = ns ? [ns.bin, ['-rn', '--', process.execPath, ...flags]] : [process.execPath, flags];
  return spawn(cmd, args, { env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, cwd: '/' });
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export function runSandbox(run: SandboxRun): Promise<SandboxResult> {
  return slot(
    () =>
      new Promise<SandboxResult>((resolve) => {
        const started = Date.now();
        const timeoutMs = run.timeoutMs ?? DEFAULT_TIMEOUT;
        const maxCalls = run.maxCalls ?? 200;
        let calls = 0;
        let settled = false;
        let killed: SandboxResult['killed'];
        let stderr = '';
        const child = launch(run.memoryMb ?? DEFAULT_MEMORY);
        const done = (r: Partial<SandboxResult>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            child.kill('SIGKILL');
          } catch {
            /* gone */
          }
          resolve({ ok: false, logs: [], calls, ms: Date.now() - started, ...r });
        };
        const kill = (why: NonNullable<SandboxResult['killed']>, message: string) => {
          killed = why;
          done({ ok: false, error: message, killed: why });
        };
        const timer = setTimeout(() => kill('timeout', `Zeitlimit überschritten (${Math.round(timeoutMs / 1000)} Sekunden).`), timeoutMs);
        child.stderr?.on('data', (d: Buffer) => {
          if (stderr.length < 2000) stderr += d.toString('utf8').slice(0, 2000);
        });
        child.on('error', (e) => done({ ok: false, error: `Sandbox konnte nicht starten: ${e.message}`, killed: 'crash' }));
        child.on('exit', (code, signal) => {
          if (settled) return;
          const oom = /heap out of memory|allocation failed|JavaScript heap/i.test(stderr);
          if (oom) return kill('memory', 'Speicherlimit überschritten.');
          done({ ok: false, error: `Die Sandbox wurde unerwartet beendet (${signal ?? code}).${stderr ? ` ${stderr.split('\n').find((l) => l.trim())?.slice(0, 160) ?? ''}` : ''}`, killed: killed ?? 'crash' });
        });
        child.on('message', (m: unknown) => {
          if (settled || !isObj(m)) return;
          if (m.t === 'ready') {
            child.send({ ...(run.mode === 'ui' ? { mode: 'ui', scripts: run.scripts ?? [] } : { mode: 'server', code: run.code ?? '', kind: run.kind ?? 'action', id: run.id ?? '', input: run.input ?? null }), ops: run.ops, context: run.context, timeoutMs });
          } else if (m.t === 'call') {
            if (typeof m.id !== 'number' || typeof m.op !== 'string' || m.op.length > 80) return;
            if (++calls > maxCalls) return kill('calls', `Zu viele Aufrufe (höchstens ${maxCalls}).`);
            const reply = (msg: Record<string, unknown>) => {
              if (settled) return;
              try {
                child.send({ t: 'result', id: m.id, ...msg });
              } catch {
                /* child is gone */
              }
            };
            run
              .call(m.op, m.args)
              .then((data) => reply({ ok: true, data }))
              .catch((e) => reply({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }));
          } else if (m.t === 'done') {
            const logs = Array.isArray(m.logs) ? m.logs.slice(0, 100).map((l: unknown) => String(l).slice(0, 300)) : [];
            done({
              ok: m.ok === true,
              result: m.result,
              error: typeof m.error === 'string' ? m.error : undefined,
              errorType: typeof m.errorType === 'string' ? m.errorType : undefined,
              logs,
              syntax: m.syntax === true,
              errors: Array.isArray(m.errors) ? m.errors.slice(0, 20).map((e: any) => ({ type: String(e?.type ?? 'Error'), message: String(e?.message ?? '') })) : undefined,
              registered: isObj(m.registered) ? (m.registered as any) : undefined,
            });
          }
        });
      }),
  );
}

export interface SandboxStatus {
  ok: boolean;
  reason?: string;
  node: string;
  /** The child runs in its own network namespace (the strongest "no network"; Linux with user namespaces). */
  netns: boolean;
  /** What closes the network: the namespace, or only the runner's own lockdown (Node 22's permission model does not cover it). */
  network?: 'namespace' | 'in-process';
  probe?: Record<string, any>;
}

let probed: Promise<SandboxStatus> | undefined;
/** Starts a child and tries what a plugin that escaped its vm context could still do. Cached for the process. */
export function probeSandbox(force = false): Promise<SandboxStatus> {
  if (probed && !force) return probed;
  probed = slot(
    () =>
      new Promise<SandboxStatus>((resolve) => {
        const node = process.version;
        const finish = (s: Omit<SandboxStatus, 'node' | 'netns'>) => resolve({ node, netns: !!netnsLauncher(), ...s });
        const major = Number(process.versions.node.split('.')[0]);
        if (major < 22) return finish({ ok: false, reason: `Node ${process.versions.node}: das Rechtemodell (--permission) braucht Node 22 oder neuer.` });
        let child: ChildProcess;
        try {
          child = launch(DEFAULT_MEMORY);
        } catch (e) {
          return finish({ ok: false, reason: `Start fehlgeschlagen: ${(e as Error).message}` });
        }
        const timer = setTimeout(() => (child.kill('SIGKILL'), finish({ ok: false, reason: 'Die Sandbox antwortet nicht (Zeitlimit).' })), 8000);
        let got = false;
        child.on('error', (e) => (clearTimeout(timer), finish({ ok: false, reason: e.message })));
        child.on('exit', () => {
          clearTimeout(timer);
          if (!got) finish({ ok: false, reason: 'Die Sandbox hat sich beendet, bevor sie antwortete (Node ohne --permission?).' });
        });
        child.on('message', (m: unknown) => {
          if (!isObj(m)) return;
          if (m.t === 'ready') child.send({ mode: 'probe' });
          if (m.t === 'done') {
            got = true;
            clearTimeout(timer);
            child.kill('SIGKILL');
            const p = m.probe as Record<string, any> | undefined;
            if (!p) return finish({ ok: false, reason: String(m.error ?? 'Keine Antwort') });
            const closed = (v: unknown) => typeof v === 'string' && v.startsWith('gesperrt');
            const ctx = p.context ?? {};
            const problems = [
              !closed(p.fs) && 'Dateien lesen ist möglich',
              !closed(p['fs-write']) && 'Dateien schreiben ist möglich',
              !closed(p.child) && 'Prozesse starten ist möglich',
              !closed(p.worker) && 'Worker starten ist möglich',
              !closed(p.net) && 'Netzwerk (net) ist offen',
              !closed(p.http) && 'Netzwerk (http) ist offen',
              !closed(p.dgram) && 'Netzwerk (UDP) ist offen',
              !closed(p.dns) && 'DNS ist offen',
              (ctx.process !== 'undefined' || ctx.require !== 'undefined' || ctx.fetch !== 'undefined' || ctx.Buffer !== 'undefined') && 'Das Plugin sieht process/require/fetch',
              (ctx.evalStrings !== 'blocked' || ctx.fnCtor !== 'blocked') && 'eval/Function ist im Plugin möglich',
            ].filter(Boolean);
            finish({ ok: problems.length === 0, reason: problems.length ? problems.join('; ') : undefined, probe: p, network: closed(p.net_raw) ? 'namespace' : 'in-process' });
          }
        });
      }),
  );
  return probed;
}
