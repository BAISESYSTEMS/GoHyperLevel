#!/usr/bin/env node
/**
 * Writes `<file>.br` and `<file>.gz` next to every text file of the web build (dist-web), so the server
 * sends the smallest version a browser accepts without compressing anything at request time
 * (server/core/static.ts). Runs as part of `npm run build`; node:zlib only, no dependencies.
 *
 *   node scripts/precompress.mjs [dist-web]
 */
import { readdirSync, readFileSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { join, extname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const br = promisify(brotliCompress);
const gz = promisify(gzip);
const root = resolve(process.argv[2] ?? 'dist-web');
const TEXT = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.webmanifest', '.txt', '.xml', '.ico', '.map', '.wasm']);
const MIN = 1024;

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

let files;
try {
  files = walk(root).filter((f) => TEXT.has(extname(f).toLowerCase()) && statSync(f).size > MIN);
} catch {
  console.error(`precompress: ${root} not found – run vite build first`);
  process.exit(1);
}

let raw = 0;
let brTotal = 0;
let gzTotal = 0;
const started = Date.now();
await Promise.all(
  files.map(async (f) => {
    const body = readFileSync(f);
    const st = statSync(f);
    const [b, g] = await Promise.all([
      br(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: body.length, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT } }),
      gz(body, { level: 9 }),
    ]);
    raw += body.length;
    // Only worth it when it saves something; the server falls back to the plain file otherwise.
    for (const [ext, out] of [['.br', b], ['.gz', g]]) {
      if (out.length >= body.length * 0.95) continue;
      writeFileSync(f + ext, out);
      // Same mtime as the original: the server ignores siblings older than their file.
      utimesSync(f + ext, st.atime, st.mtime);
      if (ext === '.br') brTotal += out.length;
      else gzTotal += out.length;
    }
  }),
);
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
console.log(`precompress: ${files.length} files in ${relative(process.cwd(), root) || '.'} – ${kb(raw)} → br ${kb(brTotal)} / gzip ${kb(gzTotal)} (${Date.now() - started} ms)`);
