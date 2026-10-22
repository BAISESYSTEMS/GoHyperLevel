#!/usr/bin/env node
/**
 * Pre-publication check: finds secrets, real server IPs, private names and files that must never be
 * published. Uses only Node built-ins.
 *
 *   node scripts/oss-check.mjs                    # the repository's tracked files (git ls-files)
 *   node scripts/oss-check.mjs --dir ./export     # a folder, e.g. the output of scripts/oss-export.sh
 *   node scripts/oss-check.mjs --require-files    # also insist on LICENSE, NOTICE, SECURITY.md …
 *   node scripts/oss-check.mjs --json
 *
 * Exit code 1 when something is found. Generic rules live here; terms that are private to you (your
 * own domains, server IPs, customer or project names) go into a denylist that is NOT committed:
 * `.oss-denylist` in the repository root (gitignored) or the file named by OSS_DENYLIST – one term per
 * line, `#` comments, `/regex/flags` for patterns. A line in a checked file can opt out of the
 * generic secret/IP rules with the marker "oss-check: allow" (never for denylist terms).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Secrets: the match is ignored when it is obviously a fake (test, example, dummy …). */
export const SECRET_RULES = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{20,}\b/],
  ['Stripe live key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9]{32,}\b/],
  ['Anthropic API key', /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}\b/],
  ['OpenAI API key', /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Twilio account SID + token pair', /\bAC[0-9a-f]{32}\b[\s\S]{0,80}\b[0-9a-f]{32}\b/],
  ['SendGrid key', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/],
  ['Meta access token', /\bEAA[A-Za-z0-9]{100,}\b/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}\b/],
  ['credentials in URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]{2,}:[^\s/@'"`$]{6,}@[a-z0-9.-]+\.[a-z]{2,}/i],
  // A random-looking literal assigned to a secret-looking name (code, YAML, JSON, env files). Only values
  // that look generated (long, letters + digits, high entropy) count – "app-passwort" does not.
  ['secret assignment', /\b[A-Za-z0-9_]*(?:password|passwd|secret|token|api_?key)["']?\s*[:=]\s*['"]?([A-Za-z0-9_\-+/=.]{20,})/i, (v) => looksGenerated(v)],
];
/** Shannon entropy per character. */
function entropy(v) {
  const n = new Map();
  for (const ch of v) n.set(ch, (n.get(ch) ?? 0) + 1);
  let e = 0;
  for (const c of n.values()) e -= (c / v.length) * Math.log2(c / v.length);
  return e;
}
export const looksGenerated = (v) => v.length >= 20 && /[0-9]/.test(v) && /[a-zA-Z]/.test(v) && entropy(v) >= 3.8 && !/^(?:https?|[a-z]+\.[a-z]+)/i.test(v);

const FAKE = /test|fake|dummy|example|placeholder|sample|x{4,}|(\d)\1{5,}|1234|abcdef|wrong|leaked|demo|invalid|redacted|change[-_]?me|your|dein|geheim|secret123/i;

/** Files that never belong in a public repository. */
export const FORBIDDEN_FILES = [/(^|\/)\.env(\.[^/]*)?$/, /\.(db|db-wal|db-shm|sqlite3?)$/i, /\.(jks|keystore|p12|pfx|pem|key)$/i, /(^|\/)signing\.properties$/, /(^|\/)id_(rsa|ed25519|ecdsa)$/, /^data\/|(^|\/)node_modules\//, /(^|\/)local\.properties$/];
const ALLOWED_FILES = [/(^|\/)\.env\.example$/];

/** Community files a public release must contain (--require-files). */
export const REQUIRED_FILES = ['LICENSE', 'NOTICE', 'README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'CLA.md', 'CHANGELOG.md'];

const SKIP_CONTENT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|apk|aab|jar|zip|gz|tgz|mp4|mp3|pdf)$|(^|\/)(package-lock\.json|LICENSE|THIRD_PARTY_LICENSES\.txt)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

/** Public IPv4 addresses (not private, loopback, link-local, CGNAT, documentation or well-known resolvers). */
const IPV4 = /(?<![\d.])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?![\d.])/g;
const PUBLIC_IP_ALLOW = new Set(['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9', '1.2.3.4', '93.184.216.34', '93.184.215.14']);
export function isReportableIp(ip) {
  const o = ip.split('.').map(Number);
  if (PUBLIC_IP_ALLOW.has(ip)) return false;
  if (o.every((n) => n < 10)) return false; // version-like "3.1.3.7"
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function loadDenylist(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = l.match(/^\/(.+)\/([a-z]*)$/);
      if (m) return { label: l, re: new RegExp(m[1], m[2].includes('i') ? m[2] : `${m[2]}i`) };
      return { label: l, re: new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
    });
}

/** Checks one file's text; returns findings without the file name. */
export function checkText(text, deny = []) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const d of deny) if (d.re.test(line)) out.push({ line: i + 1, rule: 'denylisted term', match: d.label });
    if (line.includes('oss-check: allow')) continue;
    for (const [rule, re, accept] of SECRET_RULES) {
      const m = line.match(re);
      if (!m || FAKE.test(m[0]) || (accept && !accept(m[1] ?? m[0]))) continue;
      out.push({ line: i + 1, rule, match: `${m[0].slice(0, 12)}…` });
    }
    if (/<svg|\sd="M|viewBox=/.test(line)) continue; // path data looks like IPs
    for (const m of line.matchAll(IPV4)) if (isReportableIp(m[1])) out.push({ line: i + 1, rule: 'public IP address', match: m[1] });
  }
  return out;
}

function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue;
    const full = join(dir, name);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) walk(full, base, acc);
    else acc.push(relative(base, full).split(sep).join('/'));
  }
  return acc;
}

/** Runs every rule over a folder (or the repository's tracked files). */
export function checkTree({ dir, requireFiles = false, denylist } = {}) {
  const base = resolve(dir ?? repoRoot);
  const files = dir ? walk(base) : execFileSync('git', ['ls-files', '-z'], { cwd: base, encoding: 'utf8' }).split('\0').filter(Boolean);
  const deny = loadDenylist(denylist ?? process.env.OSS_DENYLIST ?? join(repoRoot, '.oss-denylist'));
  const findings = [];
  for (const f of files) {
    if (FORBIDDEN_FILES.some((re) => re.test(f)) && !ALLOWED_FILES.some((re) => re.test(f))) findings.push({ file: f, line: 0, rule: 'file must not be published', match: f });
    for (const d of deny) if (d.re.test(f)) findings.push({ file: f, line: 0, rule: 'denylisted term in path', match: d.label });
    if (SKIP_CONTENT.test(f)) continue;
    const full = join(base, f);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st?.isFile()) continue;
    if (st.size > MAX_BYTES) {
      findings.push({ file: f, line: 0, rule: 'large file (> 2 MB) – binary or dump?', match: `${Math.round(st.size / 1024)} KB` });
      continue;
    }
    const buf = readFileSync(full);
    if (buf.includes(0)) continue; // binary
    for (const x of checkText(buf.toString('utf8'), deny)) findings.push({ file: f, ...x });
  }
  if (requireFiles) for (const f of REQUIRED_FILES) if (!files.includes(f)) findings.push({ file: f, line: 0, rule: 'required file missing', match: f });
  return { base, files: files.length, findings, denylist: deny.length };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const val = (k) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : undefined);
  const r = checkTree({ dir: val('--dir'), requireFiles: args.includes('--require-files'), denylist: val('--denylist') });
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    for (const f of r.findings) console.error(`${f.file}${f.line ? `:${f.line}` : ''}  ${f.rule}  (${f.match})`);
    console.log(`${r.files} files checked in ${r.base}${r.denylist ? ` (+${r.denylist} denylisted terms)` : ' (no private denylist – see .oss-denylist)'}: ${r.findings.length ? `${r.findings.length} finding(s)` : 'clean'}`);
  }
  process.exit(r.findings.length ? 1 : 0);
}
