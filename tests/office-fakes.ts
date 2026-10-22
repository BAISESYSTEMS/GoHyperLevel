import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_BINARIES } from '../server/services/office-engine.js';

/**
 * Fake Office engines for the tests (no real binaries in CI): one small Node program per engine name in a temp folder, to point
 * `PGHL_OFFICE_BIN_DIR` at. They answer the same command lines the adapter (server/services/office-engine.ts) uses, log every call
 * (argv, cwd, the environment's keys) to `calls.jsonl`, and "edit" a file by copying it and putting the command ids into the ZIP
 * comment (Office files) or a trailing PDF comment – so a test can see which commands reached the engine and that a new version
 * was stored. A command `fake.sleep` hangs (timeouts), `fake.fail` exits with an error, `fake.huge` prints too much.
 */

const PROGRAM = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const NAME = process.argv[1].split('/').pop();
const args = process.argv.slice(2);
fs.appendFileSync(__LOG__, JSON.stringify({ name: NAME, args, cwd: process.cwd(), env: Object.keys(process.env).sort() }) + '\n');
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const cmds = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--cmd') cmds.push(args[i + 1].split('=')[0]);
const script = opt('--script');
let steps = [];
if (script) {
  const text = fs.readFileSync(script, 'utf8');
  steps = script.endsWith('.jsonl') ? text.trim().split('\n').map((l) => JSON.parse(l).command) : JSON.parse(text).map((s) => s.tool);
}
const all = cmds.concat(steps);
if (all.includes('fake.sleep')) { const t = Date.now(); while (Date.now() - t < 10000) {} }
if (all.includes('fake.fail')) { process.stderr.write('Befehl fake.fail: geht nicht in ' + process.cwd() + '\n'); process.exit(3); }
if (all.includes('fake.huge')) { process.stdout.write('x'.repeat(9 * 1024 * 1024)); process.exit(0); }
function edited(input, out) {
  const buf = fs.readFileSync(input);
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') { fs.writeFileSync(out, Buffer.concat([buf, Buffer.from('% fake-edit ' + all.join(',') + '\n')])); return; }
  const note = Buffer.from('fake-edit ' + all.join(','));
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const head = Buffer.from(buf.subarray(0, eocd + 22));
  head.writeUInt16LE(note.length, eocd + 20);
  fs.writeFileSync(out, Buffer.concat([head, note]));
}
const PDF = '%PDF-1.4\n% fake export\n%%EOF\n';
const sub = args[0];
if (sub === 'inspect' || sub === 'info') { process.stdout.write(JSON.stringify({ engine: NAME, file: path.basename(args[1]), bytes: fs.statSync(args[1]).size, slides: NAME === 'deckcraft-cli' ? [{ title: 'Folie eins', shapes: [{ text: 'Hallo Welt' }] }] : undefined })); process.exit(0); }
if (sub === 'text') { process.stdout.write('FAKE TEXT ' + path.basename(args[1])); process.exit(0); }
if (sub === 'cat') { process.stdout.write('A,B\n1,2' + (opt('--range') ? '\nrange ' + opt('--range') : '')); process.exit(0); }
if (sub === 'convert') { if (args[2].endsWith('.md')) fs.writeFileSync(args[2], 'Folie eins\n\tHallo Welt\n'); else if (args[2].endsWith('.pdf')) fs.writeFileSync(args[2], PDF); else { all.push('convert'); edited(args[1], args[2]); } process.exit(0); }
if (sub === 'run') {
  if (NAME === 'pdfcraft-cli') { const root = opt('--root'); edited(path.join(root, 'in.pdf'), path.join(root, 'out.pdf')); process.exit(0); }
  const input = opt('--file') || opt('--in');
  const out = opt('--save') || opt('--out');
  for (let i = 0; i < args.length; i++) if (args[i] === '--cmd' && args[i + 1].startsWith('file.exportPdf=')) fs.writeFileSync(JSON.parse(args[i + 1].slice('file.exportPdf='.length)).path, PDF);
  if (out) edited(input, out);
  process.exit(0);
}
process.stderr.write('unbekannt: ' + args.join(' '));
process.exit(2);
`;

export interface FakeEngines {
  dir: string;
  calls: () => { name: string; args: string[]; cwd: string; env: string[] }[];
}

/** Writes the fake programs (all four, or the given ones) and returns their folder. */
export function fakeEngines(only?: string[]): FakeEngines {
  const dir = mkdtempSync(join(tmpdir(), 'pghl-office-bin-'));
  const log = join(dir, 'calls.jsonl');
  writeFileSync(log, '');
  for (const name of Object.values(ENGINE_BINARIES)) {
    if (only && !only.includes(name)) continue;
    const file = join(dir, name);
    writeFileSync(file, PROGRAM.replace('__LOG__', JSON.stringify(log)));
    chmodSync(file, 0o755);
  }
  return {
    dir,
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}
