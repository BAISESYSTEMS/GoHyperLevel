#!/usr/bin/env node
/**
 * Counts what the landing page (PGHL_LANDING=1, docs/landing.md) shows as "automated tests": every `it(…)` / `test(…)` in
 * tests/**\/*.test.ts (skipped and todo tests not counted). Writes <dir>/landing/stats.json:
 *
 *   node scripts/landing-stats.mjs              # web/public/landing/stats.json (the committed fallback)
 *   node scripts/landing-stats.mjs dist-web     # what `npm run build` does – the build's own, fresh count
 *
 * Without a tests/ folder (the Docker build context leaves it out) nothing is written and the committed file stays.
 * Node built-ins only.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST = /^\s*(?:it|test)(?:\.(?:each\([\s\S]*?\)|concurrent|only))?\s*\(/gm;

/** Number of tests in a folder of *.test.ts files (recursively). */
export function countTests(dir) {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    if (statSync(f).isDirectory()) n += countTests(f);
    else if (name.endsWith('.test.ts')) n += (readFileSync(f, 'utf8').match(TEST) ?? []).length;
  }
  return n;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const testsDir = join(root, 'tests');
  if (!existsSync(testsDir)) {
    console.log('landing-stats: no tests/ folder – keeping the committed web/public/landing/stats.json');
    process.exit(0);
  }
  const out = join(resolve(root, process.argv[2] ?? 'web/public'), 'landing');
  mkdirSync(out, { recursive: true });
  const stats = { tests: countTests(testsDir) };
  writeFileSync(join(out, 'stats.json'), `${JSON.stringify(stats)}\n`);
  console.log(`landing-stats: ${stats.tests} tests → ${join(out, 'stats.json')}`);
}
