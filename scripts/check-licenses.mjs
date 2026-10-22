#!/usr/bin/env node
/**
 * License check for the npm dependency tree (reads package-lock.json, no network, no extra packages).
 *
 *   node scripts/check-licenses.mjs            # report; exit 1 if a distributed package is incompatible
 *   node scripts/check-licenses.mjs --notice   # also rewrite the npm section of NOTICE
 *   node scripts/check-licenses.mjs --json     # machine-readable list
 *   node scripts/check-licenses.mjs --texts dist-web/THIRD_PARTY_LICENSES.txt
 *                                              # full license texts of the distributed packages
 *                                              # (read from node_modules – the Docker build runs this)
 *
 * "Distributed" = everything that ships in the Docker image or the browser bundle: the runtime
 * dependencies plus the packages the web app bundles (react, react-dom, lucide-react) and all of
 * their transitive dependencies. Build and test tools are listed separately (not distributed).
 * HyperLevel is AGPL-3.0-only: permissive licenses (MIT, BSD, ISC, Apache-2.0 …) and weak copyleft
 * (MPL-2.0, LGPL) are compatible; GPL-2.0-only, SSPL, BUSL, non-commercial or unknown licenses fail.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

/** Packages the browser bundle includes although package.json lists them as devDependencies. */
export const WEB_BUNDLED = ['react', 'react-dom', 'lucide-react'];

const PERMISSIVE = new Set(['MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0', 'Python-2.0', 'Zlib', 'CC-BY-3.0', 'CC-BY-4.0', 'WTFPL']);
const WEAK_COPYLEFT = new Set(['MPL-2.0', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'EPL-2.0', 'EUPL-1.2', 'EUPL-1.1+']);
const STRONG_COMPATIBLE = new Set(['GPL-3.0-only', 'GPL-3.0-or-later', 'GPL-2.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later']);
const INCOMPATIBLE = [/^GPL-2\.0(-only)?$/, /SSPL/i, /BUSL/i, /Commons-Clause/i, /NC/, /^JSON$/, /UNLICENSED/i, /proprietary/i, /Elastic/i];

/** Verdict for one SPDX expression: "OR" needs one compatible branch, "AND" needs all. */
export function classify(expr) {
  const e = String(expr ?? '').trim().replace(/^\((.*)\)$/, '$1');
  if (!e) return 'unknown';
  if (/\sOR\s/i.test(e)) {
    const parts = e.split(/\s+OR\s+/i).map(classify);
    for (const v of ['permissive', 'weak-copyleft', 'copyleft-compatible']) if (parts.includes(v)) return v;
    return parts.includes('unknown') ? 'unknown' : 'incompatible';
  }
  if (/\sAND\s/i.test(e)) {
    const parts = e.split(/\s+AND\s+/i).map(classify);
    for (const v of ['incompatible', 'unknown', 'copyleft-compatible', 'weak-copyleft']) if (parts.includes(v)) return v;
    return 'permissive';
  }
  if (PERMISSIVE.has(e)) return 'permissive';
  if (WEAK_COPYLEFT.has(e)) return 'weak-copyleft';
  if (STRONG_COMPATIBLE.has(e)) return 'copyleft-compatible';
  if (INCOMPATIBLE.some((re) => re.test(e))) return 'incompatible';
  return 'unknown';
}

/** All packages from the lockfile with name, version, license and whether they are distributed. */
export function collect(lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')), pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))) {
  const packages = lock.packages ?? {};
  const byPath = new Map(Object.entries(packages).filter(([k]) => k.startsWith('node_modules/')));
  const nameOf = (path) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  /** Node's resolution: the closest node_modules folder up the tree. */
  const resolve = (fromPath, dep) => {
    let base = fromPath;
    for (;;) {
      const candidate = `${base ? `${base}/` : ''}node_modules/${dep}`;
      if (byPath.has(candidate)) return candidate;
      if (!base) return undefined;
      const i = base.lastIndexOf('/node_modules/');
      base = i >= 0 ? base.slice(0, i) : '';
    }
  };
  const distributed = new Set();
  const queue = [...Object.keys(pkg.dependencies ?? {}), ...WEB_BUNDLED].map((d) => resolve('', d)).filter(Boolean);
  while (queue.length) {
    const p = queue.pop();
    if (distributed.has(p)) continue;
    distributed.add(p);
    const entry = byPath.get(p);
    for (const d of Object.keys({ ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}), ...(entry.peerDependencies ?? {}) })) {
      const r = resolve(p, d);
      if (r && !distributed.has(r)) queue.push(r);
    }
  }
  return [...byPath.entries()]
    .map(([path, e]) => ({ name: nameOf(path), version: e.version, license: e.license ?? '', distributed: distributed.has(path), verdict: classify(e.license) }))
    .sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
}

function noticeSection(list) {
  const shipped = list.filter((p) => p.distributed);
  const seen = new Set();
  const lines = shipped
    .filter((p) => (seen.has(`${p.name}@${p.version}`) ? false : seen.add(`${p.name}@${p.version}`)))
    .map((p) => `- ${p.name} ${p.version} — ${p.license}`);
  return lines.join('\n');
}

/** Full license texts of the distributed packages (LICENSE/LICENCE/COPYING/NOTICE files from node_modules). */
function licenseTexts(list) {
  const out = ['Third-party software distributed with HyperLevel (Docker image and browser bundle).', 'Generated by scripts/check-licenses.mjs from package-lock.json and node_modules.', ''];
  const seen = new Set();
  for (const p of list.filter((x) => x.distributed)) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    const dir = join(root, 'node_modules', p.name);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)(\.|-|$)/i.test(f)) : [];
    out.push('='.repeat(100), `${p.name} ${p.version} – ${p.license}`, '='.repeat(100));
    if (!files.length) out.push(`(no license file in the package; license per package.json: ${p.license})`);
    for (const f of files) out.push(readFileSync(join(dir, f), 'utf8').trim(), '');
    out.push('');
  }
  return out.join('\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const list = collect();
  if (args.has('--json')) {
    console.log(JSON.stringify(list, null, 2));
  } else {
    const shipped = list.filter((p) => p.distributed);
    const count = (arr) => Object.entries(arr.reduce((m, p) => ((m[p.license || '(none)'] = (m[p.license || '(none)'] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
    console.log(`npm packages: ${list.length} (${shipped.length} distributed in the image/browser bundle, ${list.length - shipped.length} build/test only)`);
    console.log(`Distributed licenses: ${count(shipped).map(([l, n]) => `${l} ×${n}`).join(', ')}`);
    console.log(`Build/test-only licenses: ${count(list.filter((p) => !p.distributed)).map(([l, n]) => `${l} ×${n}`).join(', ')}`);
  }
  const bad = list.filter((p) => p.distributed && (p.verdict === 'incompatible' || p.verdict === 'unknown'));
  const devBad = list.filter((p) => !p.distributed && (p.verdict === 'incompatible' || p.verdict === 'unknown'));
  for (const p of devBad) console.warn(`note (build/test only): ${p.name}@${p.version} – ${p.license || 'no license field'}`);
  for (const p of bad) console.error(`INCOMPATIBLE or unknown license in a distributed package: ${p.name}@${p.version} – ${p.license || 'no license field'}`);
  if (args.has('--notice')) {
    const file = join(root, 'NOTICE');
    const text = readFileSync(file, 'utf8');
    const start = '<!-- npm:start -->';
    const end = '<!-- npm:end -->';
    if (!text.includes(start) || !text.includes(end)) throw new Error('NOTICE: npm markers missing');
    writeFileSync(file, `${text.slice(0, text.indexOf(start) + start.length)}\n${noticeSection(list)}\n${text.slice(text.indexOf(end))}`);
    console.log('NOTICE updated.');
  }
  const textsAt = process.argv.indexOf('--texts');
  if (textsAt >= 0) {
    const target = process.argv[textsAt + 1];
    if (!target) throw new Error('--texts <file>');
    writeFileSync(target, licenseTexts(list));
    console.log(`License texts written to ${target}.`);
  }
  if (bad.length) process.exit(1);
  if (!args.has('--json')) console.log('OK – no incompatible licenses in distributed packages.');
}
