import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error – plain .mjs script without type declarations
import { checkText, checkTree, isReportableIp, loadDenylist } from '../scripts/oss-check.mjs';
// @ts-expect-error – plain .mjs script without type declarations
import { classify, collect } from '../scripts/check-licenses.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp: string[] = [];
const mk = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

// Planted values are assembled at runtime, so this file itself stays clean for the checker.
const PRIVATE_KEY = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');
const GITHUB_TOKEN = 'ghp_' + 'Q7w'.repeat(12);
const STRIPE_LIVE = 'sk_' + 'live_' + 'Zr8KpL2'.repeat(4);
const AWS_KEY = 'AKIA' + 'QW3RT7YU1OPL5KJH';
const PUBLIC_IP = ['45', '67', '89', '10'].join('.');

describe('oss-check rules', () => {
  it('finds secrets, but not obvious test fakes', () => {
    for (const s of [PRIVATE_KEY, `token = "${GITHUB_TOKEN}"`, `const k = '${STRIPE_LIVE}'`, `AWS_ACCESS_KEY_ID=${AWS_KEY}`, `PGHL_SECRET=${'f3K9qL2mX8vR1tZ6'.repeat(2)}`]) {
      expect(checkText(s).length, s.slice(0, 20)).toBeGreaterThan(0);
    }
    for (const s of ["const KEY = 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123'", "const WHSEC = 'whsec_testSigningSecret0000000'", "password: 'app-passwort'", "secret_key: 'sk_test_x'", 'PGHL_ADMIN_PASSWORD=', `x = '${'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'}' // oss-check: allow`]) {
      expect(checkText(s), s).toEqual([]);
    }
  });

  it('reports public IP addresses but not private, documentation or version-like ones', () => {
    expect(checkText(`server: ${PUBLIC_IP}`)).toEqual([{ line: 1, rule: 'public IP address', match: PUBLIC_IP }]);
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.5', '172.20.0.1', '169.254.169.254', '100.64.0.1', '203.0.113.10', '198.51.100.7', '192.0.2.1', '8.8.8.8', '3.1.3.7', '0.0.0.0']) expect(isReportableIp(ip), ip).toBe(false);
    expect(checkText('<svg><path d="M12 55.47 98.97 4"/></svg>')).toEqual([]);
  });

  it('applies a private denylist (plain terms and /regex/)', () => {
    const dir = mk('oss-deny-');
    const file = join(dir, 'deny');
    writeFileSync(file, '# private\nacme-intern.example\n/\\bProjektX\\b/\n');
    const deny = loadDenylist(file);
    expect(deny).toHaveLength(2);
    expect(checkText('see https://ACME-intern.example/x', deny)[0]).toMatchObject({ rule: 'denylisted term' });
    expect(checkText('Kunde ProjektX', deny)).toHaveLength(1);
    expect(checkText('ProjektXL', deny)).toEqual([]);
    // The opt-out marker never hides denylisted terms.
    expect(checkText('acme-intern.example // oss-check: allow', deny)).toHaveLength(1);
  });

  it('the community files go into the public export, the internal launch notes stay out', () => {
    const files = ['CLA.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/partner-program.md', '.github/workflows/cla.yml', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml', 'docs/launch-kit.md'];
    const attr = execFileSync('git', ['check-attr', 'export-ignore', '--', ...files], { cwd: ROOT, encoding: 'utf8' });
    for (const f of files) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
      expect(attr, f).toContain(`${f}: export-ignore: ${f === 'docs/launch-kit.md' ? 'set' : 'unspecified'}`);
    }
  });

  it('the repository itself is clean (tracked files, generic rules)', () => {
    const r = checkTree({ denylist: join(ROOT, 'does-not-exist') });
    expect(r.findings).toEqual([]);
    expect(r.files).toBeGreaterThan(300);
  });
});

describe('scripts/oss-export.sh', () => {
  const script = join(ROOT, 'scripts/oss-export.sh');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

  /** A tiny repository with everything a public release needs. */
  function repo(extra: Record<string, string> = {}) {
    const dir = mk('oss-repo-');
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'demo-app', version: '0.0.18' }),
      LICENSE: 'GNU AFFERO GENERAL PUBLIC LICENSE',
      NOTICE: 'notice',
      'README.md': '# Demo\nRuns on https://crm.example.com',
      'CONTRIBUTING.md': 'c',
      'CODE_OF_CONDUCT.md': 'c',
      'SECURITY.md': 's',
      'CLA.md': 'cla',
      'CHANGELOG.md': '## [Unreleased]',
      'src/index.ts': "export const host = '127.0.0.1';",
      ...extra,
    };
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), body);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: gitEnv });
    execFileSync('git', ['add', '-A'], { cwd: dir, env: gitEnv });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'private history'], { cwd: dir, env: gitEnv });
    return dir;
  }
  const run = (cwd: string, ...args: string[]) => spawnSync('bash', [script, ...args], { cwd, env: { ...gitEnv, OSS_DENYLIST: join(cwd, 'no-denylist') }, encoding: 'utf8' });

  it('exports HEAD into a fresh repository with a single commit', () => {
    const dir = repo();
    writeFileSync(join(dir, 'untracked.txt'), 'not exported');
    const out = join(mk('oss-out-'), 'export');
    const r = run(dir, '--out', out, '--init');
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(existsSync(join(out, 'src/index.ts'))).toBe(true);
    expect(existsSync(join(out, 'untracked.txt'))).toBe(false);
    expect(existsSync(`${out}.tar.gz`)).toBe(true);
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: out, encoding: 'utf8' }).trim()).toBe('1');
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: out, encoding: 'utf8' })).toContain('0.0.18');
  });

  it('refuses to export when a secret, a public IP, a forbidden file or a denylisted term is in HEAD', () => {
    const cases: [string, Record<string, string>, string, string?][] = [
      ['secret', { 'src/keys.ts': `export const k = '${STRIPE_LIVE}';` }, 'Stripe live key'],
      ['private key', { 'deploy/id': PRIVATE_KEY }, 'private key'],
      ['ip', { 'deploy/notes.md': `Server: ${PUBLIC_IP}` }, 'public IP address'],
      ['env file', { '.env': 'PGHL_BASE_URL=https://crm.example.com' }, 'file must not be published'],
      ['database', { 'data/pghl.db': 'x' }, 'file must not be published'],
      ['missing license', { LICENSE: '' }, '', 'LICENSE'],
    ];
    for (const [label, extra, rule, removed] of cases) {
      const dir = repo(extra);
      if (removed) {
        execFileSync('git', ['rm', '-q', removed], { cwd: dir, env: gitEnv });
        execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'rm'], { cwd: dir, env: gitEnv });
      }
      const out = join(mk('oss-out-'), 'export');
      const r = run(dir, '--out', out);
      expect(r.status, label).toBe(1);
      expect(r.stderr, label).toContain(rule || 'required file missing');
      expect(existsSync(out), label).toBe(false);
    }
    // Private terms come from a denylist file that is never committed.
    const dir = repo({ 'docs/x.md': 'Läuft auf intern.acme.example' });
    const deny = join(mk('oss-deny-'), 'terms');
    writeFileSync(deny, 'intern.acme.example\n');
    const r = spawnSync('bash', [script, '--out', join(mk('oss-out-'), 'e'), '--denylist', deny], { cwd: dir, env: gitEnv, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('denylisted term');
  });

  it('exports only committed state', () => {
    const dir = repo();
    writeFileSync(join(dir, 'README.md'), `changed ${PUBLIC_IP}`);
    const r = run(dir, '--out', join(mk('oss-out-'), 'e'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Uncommitted changes');
  });
});

describe('license check', () => {
  it('classifies SPDX expressions for AGPL compatibility', () => {
    expect(classify('MIT')).toBe('permissive');
    expect(classify('(MIT OR EUPL-1.1+)')).toBe('permissive');
    expect(classify('Apache-2.0 AND MIT')).toBe('permissive');
    expect(classify('MPL-2.0')).toBe('weak-copyleft');
    expect(classify('GPL-3.0-or-later')).toBe('copyleft-compatible');
    expect(classify('GPL-2.0-only')).toBe('incompatible');
    expect(classify('SSPL-1.0')).toBe('incompatible');
    expect(classify('CC-BY-NC-4.0')).toBe('incompatible');
    expect(classify('MIT AND SSPL-1.0')).toBe('incompatible');
    expect(classify('')).toBe('unknown');
  });

  it('no distributed npm package has an incompatible or unknown license, and NOTICE lists them', () => {
    const list = collect();
    const shipped = list.filter((p: any) => p.distributed);
    expect(shipped.length).toBeGreaterThan(20);
    for (const name of ['nodemailer', 'imapflow', 'react', 'react-dom', 'lucide-react', '@twilio/voice-sdk']) expect(shipped.some((p: any) => p.name === name), name).toBe(true);
    expect(shipped.some((p: any) => p.name === 'vitest' || p.name === 'typescript')).toBe(false);
    expect(shipped.filter((p: any) => p.verdict === 'incompatible' || p.verdict === 'unknown')).toEqual([]);
    const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8');
    for (const p of shipped) expect(notice, p.name).toContain(`- ${p.name} ${p.version} — ${p.license}`);
    expect(notice).toContain('OpenShorts');
  });

  it('ships the AGPL-3.0 text', () => {
    const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
    expect(license).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(license).toContain('Version 3, 19 November 2007');
    expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).license).toBe('AGPL-3.0-only');
  });
});
