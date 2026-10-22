#!/usr/bin/env node
/**
 * HyperLevel Bridge – runs on YOUR computer and lets the HyperLevel Agent use the official CLI you are
 * already signed in to with your own subscription:
 *   - Codex CLI   (`codex exec --json`, "Sign in with ChatGPT")
 *   - Claude Code (`claude -p --output-format stream-json`, Claude Pro/Max)
 *
 * How it works: pair once with a one-time code from HyperLevel (KI-Agenten → Mit deinem Abo). The bridge
 * then keeps an OUTBOUND long-poll to your HyperLevel server (no open ports), receives the chat prompt,
 * starts the CLI in an empty temporary folder with HyperLevel's MCP endpoint (a per-job token, valid only
 * while the job runs) and streams the answer back into the web chat. File, shell and web tools of the
 * CLI are switched off – it can only use HyperLevel's tools, with your rights and your agent's safety mode.
 * Your subscription login never leaves this computer. Personal use only (your own account, for you).
 *
 *   node gohigh-bridge.mjs pair https://crm.example.com ABCD-EFGH   # once
 *   node gohigh-bridge.mjs                                          # run (Ctrl+C to stop)
 *   node gohigh-bridge.mjs status | unpair
 *
 * It reconnects on its own after network trouble or a restart of the server (waiting 1 s, then longer, up to a minute), and keeps waiting
 * while an agency admin has switched the bridge off. It only works while this computer is on and the bridge is running.
 * The model is chosen in HyperLevel (Einstellungen → KI-Anbieter → your computer) and passed to the CLI as --model / -m.
 *
 * Environment: GOHIGH_BRIDGE_CONFIG (config file, default ~/.gohigh-bridge.json), GOHIGH_CODEX_BIN,
 * GOHIGH_CLAUDE_BIN (paths to the CLIs), GOHIGH_CODEX_ARGS / GOHIGH_CLAUDE_ARGS (extra arguments).
 * Node 18+ and nothing else – no dependencies.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const VERSION = '1.1.0';
/** Model ids as the CLIs write them – the server's choice is only passed on when it looks like one (never free text onto a command line). */
export const MODEL_RE = /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,159}$/;
const modelArgs = (cli, job) => (typeof job.model === 'string' && MODEL_RE.test(job.model) ? (cli === 'codex' ? ['-m', job.model] : ['--model', job.model]) : []);
const CONFIG = process.env.GOHIGH_BRIDGE_CONFIG || join(homedir(), '.gohigh-bridge.json');

// --- config ------------------------------------------------------------------------------------------

export function loadConfig(file = CONFIG) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function saveConfig(cfg, file = CONFIG) {
  writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
}

/** Only https – plain http only for a HyperLevel on this computer (development). */
export function checkServerUrl(raw) {
  const u = new URL(raw);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('Bitte die https://-Adresse deines HyperLevel angeben.');
  return u.origin;
}

// --- CLIs ----------------------------------------------------------------------------------------------

export function binFor(cli, opts = {}) {
  if (opts.bin) return Array.isArray(opts.bin) ? opts.bin[0] : opts.bin;
  if (cli === 'codex') return process.env.GOHIGH_CODEX_BIN || 'codex';
  return process.env.GOHIGH_CLAUDE_BIN || 'claude';
}
/** Arguments before the CLI's own (e.g. a script path when `bin` is node). */
const preArgs = (opts) => (Array.isArray(opts.bin) ? opts.bin.slice(1) : []);

/** Which CLIs are installed (they answer to --version). */
export function detectClis() {
  return ['codex', 'claude'].filter((c) => {
    try {
      return spawnSync(binFor(c), ['--version'], { stdio: 'ignore', timeout: 10_000, shell: process.platform === 'win32' }).status === 0;
    } catch {
      return false;
    }
  });
}

const extraArgs = (name) => (process.env[name] ? process.env[name].split(' ').filter(Boolean) : []);

/** Command line for a job. The prompt goes in via stdin (not visible in the process list). */
export function commandFor(cli, job, dir, opts = {}) {
  if (cli === 'codex') {
    return {
      bin: binFor('codex', opts),
      args: [
        ...preArgs(opts),
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '-C',
        dir,
        ...modelArgs('codex', job),
        '-c',
        `mcp_servers.gohigh.url="${job.mcp_url}"`,
        '-c',
        'mcp_servers.gohigh.bearer_token_env_var="GOHIGH_MCP_TOKEN"',
        ...extraArgs('GOHIGH_CODEX_ARGS'),
        '-',
      ],
      env: { GOHIGH_MCP_TOKEN: job.mcp_token },
    };
  }
  // Claude Code: only HyperLevel's MCP tools; file, shell and web tools off.
  const config = join(dir, 'mcp.json');
  writeFileSync(config, JSON.stringify({ mcpServers: { gohigh: { type: 'http', url: job.mcp_url, headers: { Authorization: `Bearer ${job.mcp_token}` } } } }), { mode: 0o600 });
  return {
    bin: binFor('claude', opts),
    args: [...preArgs(opts), '-p', '--output-format', 'stream-json', '--verbose', ...modelArgs('claude', job), '--mcp-config', config, '--strict-mcp-config', '--allowedTools', 'mcp__gohigh', '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task', ...extraArgs('GOHIGH_CLAUDE_ARGS')],
    env: {},
  };
}

/** One line of CLI output → events for HyperLevel: {kind: 'text'|'status'|'result'|'error', text}. */
export function normalizeLine(cli, line) {
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return [];
  }
  const out = [];
  if (cli === 'claude') {
    if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) {
        if (b.type === 'text' && b.text) out.push({ kind: 'text', text: b.text });
        else if (b.type === 'tool_use') out.push({ kind: 'status', text: `Werkzeug: ${String(b.name).replace(/^mcp__gohigh__/, '')}` });
      }
    } else if (d.type === 'result') {
      if (d.is_error || (d.subtype && d.subtype !== 'success')) out.push({ kind: 'error', text: String(d.result || d.subtype || 'Fehler in Claude Code') });
      else out.push({ kind: 'result', text: String(d.result ?? '') });
    }
    return out;
  }
  // Codex: newer "item.*"/"turn.*" events and the older {msg: {type}} format.
  const item = d.item ?? {};
  if (d.type === 'item.completed' && (item.type === 'agent_message' || item.item_type === 'assistant_message') && (item.text || item.message)) out.push({ kind: 'text', text: String(item.text ?? item.message) });
  else if (d.type === 'item.started' && (item.type === 'mcp_tool_call' || item.item_type === 'mcp_tool_call')) out.push({ kind: 'status', text: `Werkzeug: ${item.tool ?? item.name ?? ''}` });
  else if (d.type === 'turn.failed' || d.type === 'error') out.push({ kind: 'error', text: String(d.error?.message ?? d.message ?? 'Fehler in Codex') });
  else if (d.msg?.type === 'agent_message' && d.msg.message) out.push({ kind: 'text', text: String(d.msg.message) });
  else if (d.msg?.type === 'error') out.push({ kind: 'error', text: String(d.msg.message ?? 'Fehler in Codex') });
  return out;
}

// --- talking to HyperLevel -------------------------------------------------------------------------------------

async function api(cfg, method, path, body, opts = {}) {
  const r = await (opts.fetch ?? fetch)(`${cfg.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', 'user-agent': `gohigh-bridge/${VERSION}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal,
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error(data?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

/** Pairs this computer with a one-time code and stores the device token. */
export async function pair(url, code, opts = {}) {
  const origin = checkServerUrl(url);
  const clis = opts.clis ?? detectClis();
  const r = await (opts.fetch ?? fetch)(`${origin}/api/agent/bridge/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: opts.name || hostname(), clis, version: VERSION }),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error || `Koppeln fehlgeschlagen (HTTP ${r.status})`);
  const cfg = { url: origin, token: data.token, device_id: data.device_id, user: data.user, location: data.location, cli: data.cli || clis[0] || 'claude' };
  if (opts.save !== false) saveConfig(cfg, opts.configFile);
  return cfg;
}

/** Runs one job with the CLI and streams the output back. Resolves with the final text. */
export async function runJob(cfg, jobIn, opts = {}) {
  // The MCP endpoint is always on the HyperLevel this bridge was paired with – never a host the server names.
  const job = { ...jobIn, mcp_url: new URL(new URL(jobIn.mcp_url).pathname, cfg.url).toString() };
  const cli = job.cli === 'codex' || job.cli === 'claude' ? job.cli : cfg.cli || 'claude';
  const dir = mkdtempSync(join(tmpdir(), 'gohigh-bridge-'));
  const { bin, args, env } = commandFor(cli, job, dir, opts);
  const buffer = [];
  let finalText = '';
  let error = '';
  let stop = false;
  const flush = async () => {
    if (!buffer.length) return;
    const events = buffer.splice(0, buffer.length);
    const r = await api(cfg, 'POST', `/api/agent/bridge/jobs/${job.id}/events`, { events }, opts).catch(() => null);
    if (r?.stop) stop = true;
  };
  try {
    await new Promise((resolve) => {
      const child = spawn(bin, args, { cwd: dir, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
      const timer = setTimeout(() => {
        error = 'Zeitlimit erreicht.';
        child.kill('SIGTERM');
      }, Math.min(Number(job.timeout_ms) || 600_000, 900_000));
      const ticker = setInterval(async () => {
        await flush();
        if (stop) child.kill('SIGTERM');
      }, 700);
      let stderr = '';
      child.stderr.on('data', (c) => (stderr = (stderr + c).slice(-2000)));
      createInterface({ input: child.stdout }).on('line', (line) => {
        for (const e of normalizeLine(cli, line)) {
          if (e.kind === 'result') finalText = e.text;
          else if (e.kind === 'error') error = e.text;
          else buffer.push(e);
        }
      });
      child.on('error', (e) => {
        error = e.code === 'ENOENT' ? `${cli === 'codex' ? 'Codex CLI' : 'Claude Code'} ist nicht installiert (Befehl „${bin}“ nicht gefunden).` : e.message;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        clearInterval(ticker);
        if (code && !error && !stop) error = stderr.trim().split('\n').pop() || `Beendet mit Code ${code}`;
        resolve();
      });
      child.stdin.end(job.prompt);
    });
    await flush();
    await api(cfg, 'POST', `/api/agent/bridge/jobs/${job.id}/done`, { text: finalText, ...(error ? { error } : {}) }, opts);
    return { text: finalText, error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One long-poll: waits for a job and runs it. Returns the job result, or null if none came. */
export async function pollOnce(cfg, opts = {}) {
  const r = await api(cfg, 'GET', `/api/agent/bridge/poll${opts.wait !== undefined ? `?wait=${opts.wait}` : ''}`, undefined, opts);
  if (!r?.job) return null;
  opts.log?.(`Auftrag ${r.job.id} (${r.job.cli}) …`);
  const out = await runJob(cfg, r.job, opts);
  opts.log?.(out.error ? `  Fehler: ${out.error}` : '  fertig.');
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (cmd === 'pair') {
    const [url, code] = rest;
    if (!url || !code) throw new Error('Aufruf: gohigh-bridge pair <https://dein-gohigh> <CODE>');
    const cfg = await pair(url, code);
    console.log(`Gekoppelt mit ${cfg.url} (${cfg.user}, ${cfg.location}). CLI: ${cfg.cli}. Jetzt „gohigh-bridge“ starten.`);
    return;
  }
  if (cmd === 'unpair') {
    rmSync(CONFIG, { force: true });
    console.log('Kopplung entfernt (in HyperLevel unter KI-Agenten → Bridge kannst du das Gerät auch löschen).');
    return;
  }
  const cfg = loadConfig();
  if (!cfg) throw new Error('Noch nicht gekoppelt: gohigh-bridge pair <https://dein-gohigh> <CODE>');
  if (cmd === 'status') {
    // A short poll tells HyperLevel this computer is there and shows whether the pairing and the agency switch are fine.
    const connection = await api(cfg, 'GET', '/api/agent/bridge/poll?wait=0').then(() => 'verbunden', (e) => (e.status === 401 ? 'nicht mehr gekoppelt – bitte neu koppeln' : e.status === 403 ? 'von der Agentur ausgeschaltet' : `nicht erreichbar (${e.message})`));
    console.log(JSON.stringify({ url: cfg.url, user: cfg.user, location: cfg.location, cli: cfg.cli, installed: detectClis(), version: VERSION, connection }, null, 2));
    return;
  }
  console.log(`HyperLevel Bridge ${VERSION} – verbunden mit ${cfg.url} als ${cfg.user}. Läuft auf deinem Rechner mit deinem eigenen Abo – nur für dich selbst. Strg+C beendet.`);
  let backoff = 1000;
  for (;;) {
    try {
      await pollOnce(cfg, { log: (s) => console.log(s) });
      backoff = 1000;
    } catch (e) {
      // Unpaired (device removed in HyperLevel): nothing to wait for. Switched off by the agency: keep waiting, it may come back.
      if (e.status === 401) throw new Error('Diese Bridge ist nicht (mehr) gekoppelt – in HyperLevel einen neuen Code erzeugen und „gohigh-bridge pair …“ ausführen.');
      if (e.status === 403) backoff = Math.max(backoff, 30_000);
      console.error(e.status === 403 ? `Die Bridge ist für diese Agentur ausgeschaltet – ich warte (neuer Versuch in ${Math.round(backoff / 1000)} s)` : `Verbindung unterbrochen (${e.message}) – neuer Versuch in ${Math.round(backoff / 1000)} s`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
