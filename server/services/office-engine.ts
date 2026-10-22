import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from '../core/http.js';
import { KINDS, type OfficeCommand, type OfficeKind } from './office-model.js';

/**
 * The adapter between HyperLevel and the optional headless Office engines (one command-line program per kind of file, from
 * `PGHL_OFFICE_BIN_DIR` – docs/office.md). Every call works on a temporary copy in its own folder: the program is started
 * directly (never through a shell, arguments as a list), with a minimal environment, a time limit, a cap on what it may print and
 * on the size of what it writes; the folder is removed afterwards. Without the program the call fails with a clear 503 – the rest
 * of the Office area keeps working. Tests point `PGHL_OFFICE_BIN_DIR` at small fake programs (tests/office-fakes.ts).
 */

/** The program per kind (the upstream release's file names, see deploy/office/). */
export const ENGINE_BINARIES: Record<OfficeKind, string> = { docx: 'wordcraft-cli', xlsx: 'gridcraft-cli', pptx: 'deckcraft-cli', pdf: 'pdfcraft-cli' };

export const ENGINE_LIMITS = {
  timeoutMs: 60_000,
  /** What a program may print (JSON structure, text) before it is stopped. */
  maxOutput: 8 * 1024 * 1024,
};

export class EngineMissing extends HttpError {
  constructor(kind: OfficeKind) {
    super(503, `Die Office-Engine für ${KINDS[kind].label} ist nicht installiert (PGHL_OFFICE_BIN_DIR) – Dateien verwalten und im Browser bearbeiten geht trotzdem; Einrichtung: docs/office.md`);
  }
}

export const binDir = () => (process.env.PGHL_OFFICE_BIN_DIR ?? '').trim();

/** Path of the program for a kind, or null when it is not installed (not there or not executable). */
export function enginePath(kind: OfficeKind): string | null {
  const dir = binDir();
  if (!dir) return null;
  const p = join(dir, ENGINE_BINARIES[kind]);
  try {
    if (!statSync(p).isFile()) return null;
    accessSync(p, constants.X_OK);
    return p;
  } catch {
    return null;
  }
}

export const engineStatus = (): Record<OfficeKind, boolean> => ({ docx: !!enginePath('docx'), xlsx: !!enginePath('xlsx'), pptx: !!enginePath('pptx'), pdf: !!enginePath('pdf') });

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the program with `args` in `cwd`. Rejects on timeout or too much output; a non-zero exit is returned, not thrown. */
function runProgram(file: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Only what the programs need: no secrets of HyperLevel's environment go along. HOME points into the temp folder (preferences, logs).
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, TMPDIR: cwd, LANG: 'C.UTF-8', WORDCRAFT_NO_PREFS: '1', GRIDCRAFT_NO_PREFS: '1', DECKCRAFT_NO_PREFS: '1', PDFCRAFT_NO_PREFS: '1', RUST_LOG: 'warn' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new HttpError(504, `Die Office-Engine hat nicht innerhalb von ${Math.round(timeoutMs / 1000)} s geantwortet`)));
    }, timeoutMs);
    timer.unref?.();
    const take = (list: Buffer[]) => (b: Buffer) => {
      size += b.length;
      if (size > ENGINE_LIMITS.maxOutput) {
        child.kill('SIGKILL');
        finish(() => reject(new HttpError(502, 'Die Office-Engine hat zu viel ausgegeben – abgebrochen')));
        return;
      }
      list.push(b);
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    child.on('error', (e) => finish(() => reject(new HttpError(502, `Die Office-Engine ließ sich nicht starten: ${(e as NodeJS.ErrnoException).code ?? e.message}`))));
    child.on('close', (code) => finish(() => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })));
  });
}

/** The program's own error text, shortened and without the temp folder's path. */
function engineError(kind: OfficeKind, r: RunResult, dir: string): HttpError {
  const msg = (r.stderr || r.stdout).split(dir).join('').replace(/\s+/g, ' ').trim().slice(0, 400) || `Exit-Code ${r.code}`;
  return new HttpError(422, `Die Office-Engine (${KINDS[kind].label}) hat abgelehnt: ${msg}`);
}

export interface EngineOptions {
  /** Largest file a call may produce (the Office size limit). */
  maxBytes: number;
  timeoutMs?: number;
}

/** A temporary folder with the input written as `in.<ext>`; removed after `fn`. */
async function withCopy<T>(kind: OfficeKind, input: Buffer, fn: (dir: string, file: string, prog: string) => Promise<T>): Promise<T> {
  const prog = enginePath(kind);
  if (!prog) throw new EngineMissing(kind);
  const dir = mkdtempSync(join(tmpdir(), 'pghl-office-'));
  try {
    const file = join(dir, `in.${KINDS[kind].ext}`);
    writeFileSync(file, input, { mode: 0o600 });
    return await fn(dir, file, prog);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readOut(path: string, maxBytes: number, kind: OfficeKind): Buffer {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new HttpError(502, `Die Office-Engine (${KINDS[kind].label}) hat keine Datei geschrieben`);
  }
  if (st.size > maxBytes) throw new HttpError(413, `Das Ergebnis ist größer als ${Math.round(maxBytes / 1024 / 1024)} MB`);
  return readFileSync(path);
}

const cmdArg = (c: OfficeCommand) => `${c.command}=${JSON.stringify(c.params ?? {})}`;

export interface ReadResult {
  text: string;
  structure: unknown;
}

const parseJson = (s: string): unknown => {
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return s.trim() ? { raw: s.trim().slice(0, 20_000) } : null;
  }
  // the temp copy's path and name are no business of the reader
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const k of ['path', 'file']) if (typeof (v as Record<string, unknown>)[k] === 'string') delete (v as Record<string, unknown>)[k];
  return v;
};

/** Text and structure (JSON) of a file. `range`/`sheet` narrow a spreadsheet's text. */
export function engineRead(kind: OfficeKind, input: Buffer, o: EngineOptions & { range?: string; sheet?: string }): Promise<ReadResult> {
  return withCopy(kind, input, async (dir, file, prog) => {
    const t = o.timeoutMs ?? ENGINE_LIMITS.timeoutMs;
    const call = async (args: string[]) => {
      const r = await runProgram(prog, args, dir, t);
      if (r.code !== 0) throw engineError(kind, r, dir);
      return r.stdout;
    };
    if (kind === 'docx') return { structure: parseJson(await call(['inspect', file])), text: await call(['text', file]) };
    if (kind === 'xlsx') {
      const cat = ['cat', file, '--csv', ...(o.range ? ['--range', o.range] : []), ...(o.sheet ? ['--sheet', o.sheet] : [])];
      return { structure: parseJson(await call(['info', file, '--json'])), text: await call(cat) };
    }
    if (kind === 'pptx') {
      const structure = parseJson(await call(['info', file]));
      // the outline export (.md) carries the slides' texts; the structure only counts shapes
      const outline = join(dir, 'outline.md');
      const r = await runProgram(prog, ['convert', file, outline], dir, t);
      let text = '';
      try {
        if (r.code === 0) text = readFileSync(outline, 'utf8').slice(0, ENGINE_LIMITS.maxOutput);
      } catch {
        text = '';
      }
      return { structure, text: text.trim() ? text : slideText(structure) };
    }
    return { structure: parseJson(await call(['info', file])), text: await call(['text', file]) };
  });
}

/** The texts of a presentation's structure (every string under a "text" key), slide by slide when the structure has slides. */
function slideText(structure: unknown): string {
  const lines: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || lines.length > 5000) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'text' || k === 'title') && typeof x === 'string' && x.trim()) lines.push(x.trim());
        else walk(x, depth + 1);
      }
  };
  const slides = (structure as any)?.slides;
  if (Array.isArray(slides))
    slides.forEach((s: unknown, i: number) => {
      lines.push(`--- Folie ${i + 1} ---`);
      walk(s, 0);
    });
  else walk(structure, 0);
  return lines.join('\n');
}

/** Runs commands on a copy and returns the changed file. */
export function engineEdit(kind: OfficeKind, input: Buffer, commands: OfficeCommand[], o: EngineOptions): Promise<Buffer> {
  return withCopy(kind, input, async (dir, file, prog) => {
    const out = join(dir, `out.${KINDS[kind].ext}`);
    let args: string[];
    if (kind === 'docx') args = ['run', '--file', file, ...commands.flatMap((c) => ['--cmd', cmdArg(c)]), '--save', out];
    else if (kind === 'pptx') args = ['run', '--in', file, ...commands.flatMap((c) => ['--cmd', cmdArg(c)]), '--save', out];
    else if (kind === 'xlsx') {
      // A script file: no limit on the command line's length, one JSON object per line.
      const script = join(dir, 'steps.jsonl');
      writeFileSync(script, commands.map((c) => JSON.stringify({ command: c.command, params: c.params ?? {} })).join('\n') + '\n');
      args = ['run', '--in', file, '--script', script, '--out', out, '--quiet'];
    } else {
      // Every path of a pdf script must stay inside --root (the engine checks that itself, too).
      const steps = [{ tool: 'doc_open', args: { path: 'in.pdf' } }, ...commands.map((c) => ({ tool: c.command, args: { doc: 1, ...(c.params ?? {}) } })), { tool: 'doc_save', args: { doc: 1, path: 'out.pdf', full: true } }];
      const script = join(dir, 'steps.json');
      writeFileSync(script, JSON.stringify(steps));
      args = ['run', '--script', script, '--root', dir];
    }
    const r = await runProgram(prog, args, dir, o.timeoutMs ?? ENGINE_LIMITS.timeoutMs);
    if (r.code !== 0) throw engineError(kind, r, dir);
    return readOut(out, o.maxBytes, kind);
  });
}

/** The presentation editor's native save (.deckcraft) as .pptx. */
export function engineConvertNative(kind: OfficeKind, input: Buffer, fromExt: 'deckcraft', o: EngineOptions): Promise<Buffer> {
  const prog = enginePath(kind);
  if (!prog) throw new EngineMissing(kind);
  const dir = mkdtempSync(join(tmpdir(), 'pghl-office-'));
  return (async () => {
    try {
      const file = join(dir, `in.${fromExt}`);
      writeFileSync(file, input, { mode: 0o600 });
      const out = join(dir, `out.${KINDS[kind].ext}`);
      const r = await runProgram(prog, ['convert', file, out], dir, o.timeoutMs ?? ENGINE_LIMITS.timeoutMs);
      if (r.code !== 0) throw engineError(kind, r, dir);
      return readOut(out, o.maxBytes, kind);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

/** A PDF of a document, spreadsheet or presentation. */
export function engineExportPdf(kind: OfficeKind, input: Buffer, o: EngineOptions): Promise<Buffer> {
  if (kind === 'pdf') return Promise.resolve(input);
  return withCopy(kind, input, async (dir, file, prog) => {
    const out = join(dir, 'out.pdf');
    const args = kind === 'xlsx' ? ['run', '--in', file, '--cmd', cmdArg({ command: 'file.exportPdf', params: { path: out } }), '--quiet'] : ['convert', file, out];
    const r = await runProgram(prog, args, dir, o.timeoutMs ?? ENGINE_LIMITS.timeoutMs);
    if (r.code !== 0) throw engineError(kind, r, dir);
    const pdf = readOut(out, o.maxBytes, kind);
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(502, 'Die Office-Engine hat kein PDF geliefert');
    return pdf;
  });
}
