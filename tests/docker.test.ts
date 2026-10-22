import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Docker packaging. Static checks always run; `docker compose config` needs only the Docker CLI; the full
 * image build + start smoke test needs a running daemon and GOHIGH_DOCKER_SMOKE=1 (CI's docker job does the
 * same with docker/build-push-action) because it takes minutes.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const dockerCli = has('docker', ['compose', 'version']);
const dockerDaemon = dockerCli && has('docker', ['info']);
const smoke = dockerDaemon && process.env.GOHIGH_DOCKER_SMOKE === '1';

describe('Docker packaging', () => {
  it('Dockerfile: multi-stage, unprivileged runtime, health check, docs and licenses included', () => {
    const df = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    expect(df).toMatch(/FROM --platform=\$BUILDPLATFORM node:\$\{NODE_VERSION\}-bookworm-slim AS build/);
    expect(df).toMatch(/FROM node:\$\{NODE_VERSION\}-alpine AS runtime/);
    expect(df).toContain('HEALTHCHECK');
    expect(df).toContain('COPY --from=build /app/docs ./docs');
    expect(df).toMatch(/LICENSE.*NOTICE/);
    expect(df).toContain('docker-start.mjs');
    const start = readFileSync(join(ROOT, 'scripts/docker-start.mjs'), 'utf8');
    expect(start).toContain('process.setuid(UID)');
    expect(start.indexOf('process.setuid(UID)')).toBeLessThan(start.indexOf("await import('./dist-server/server/index.js')"));
    const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n');
    for (const p of ['.env', 'data', 'node_modules', '.git', '.oss-denylist']) expect(ignore, p).toContain(p);
  });

  it('docker-compose.yml: app + optional Caddy and OpenShorts profiles, data on a volume', () => {
    const c = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
    expect(c).toContain('gohigh-data:/data');
    expect(c).toMatch(/caddy:\n\s+image: caddy:2-alpine\n\s+profiles: \[caddy\]/);
    expect(c).toMatch(/openshorts:\n\s+profiles: \[openshorts\]/);
    // optional self-hosted Nango (Elastic License – pulled as the official image, loopback only, no required vars)
    expect(c).toMatch(/nango-server:\n\s+image: \$\{NANGO_IMAGE:-nangohq\/nango-server:hosted\}\n\s+profiles: \[nango\]/);
    expect(c).toContain('Elastic License 2.0');
    expect(c).not.toMatch(/\$\{NANGO_[A-Z_]+:\?/);
    expect(readFileSync(join(ROOT, 'deploy/caddy/Caddyfile'), 'utf8')).toContain('ask http://gohigh:4700/api/tls/ask');
  });

  it.skipIf(!dockerCli)('compose files are valid (docker compose config)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gohigh-compose-'));
    try {
      cpSync(join(ROOT, 'docker-compose.yml'), join(dir, 'docker-compose.yml'));
      cpSync(join(ROOT, '.env.example'), join(dir, '.env'));
      mkdirSync(join(dir, 'deploy/caddy'), { recursive: true });
      cpSync(join(ROOT, 'deploy/caddy/Caddyfile'), join(dir, 'deploy/caddy/Caddyfile'));
      const services = execFileSync('docker', ['compose', '--profile', 'caddy', '--profile', 'openshorts', 'config', '--services'], { cwd: dir, encoding: 'utf8' });
      expect(services.split('\n').filter(Boolean).sort()).toEqual(['caddy', 'gohigh', 'openshorts']);
      for (const f of ['deploy/examples/hostinger/compose.yaml', 'deploy/examples/hostinger/build-from-source.compose.yaml']) {
        execFileSync('docker', ['compose', '-f', join(ROOT, f), '--env-file', join(ROOT, '.env.example'), 'config', '-q'], { cwd: ROOT });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!smoke)(
    'image builds, starts unprivileged and answers /healthz and /api/version',
    async () => {
      const tag = 'gohigh:test-smoke';
      execFileSync('docker', ['build', '--network', 'host', '-t', tag, '.'], { cwd: ROOT, stdio: 'inherit' });
      const name = `gohigh-smoke-${process.pid}`;
      execFileSync('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1::4700', '-e', 'PGHL_BASE_URL=http://localhost', tag]);
      try {
        const port = execFileSync('docker', ['port', name, '4700/tcp'], { encoding: 'utf8' }).trim().split(':').pop();
        let ok = false;
        for (let i = 0; i < 60 && !ok; i++) {
          ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok).catch(() => false);
          if (!ok) await new Promise((r) => setTimeout(r, 1000));
        }
        expect(ok).toBe(true);
        const v = await (await fetch(`http://127.0.0.1:${port}/api/version`)).json();
        expect(v).toMatchObject({ name: 'HyperLevel', version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version, setup_required: true });
        expect(execFileSync('docker', ['exec', name, 'cat', '/proc/1/status'], { encoding: 'utf8' })).toMatch(/^Uid:\s+1000\s/m);
        expect((await fetch(`http://127.0.0.1:${port}/THIRD_PARTY_LICENSES.txt`)).ok).toBe(true);
      } finally {
        spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      }
    },
    20 * 60_000,
  );
});
