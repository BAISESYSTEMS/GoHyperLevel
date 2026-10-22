import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Config } from './core/app.js';

/** Reads settings from the environment (see .env.example). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.PGHL_DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });
  const port = Number(env.PORT ?? env.PGHL_PORT ?? 4700);
  const secretFile = join(dataDir, 'secret');
  let secret = env.PGHL_SECRET ?? '';
  if (!secret) {
    if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    secret = readFileSync(secretFile, 'utf8').trim();
  }
  // Key for secrets at rest (written by `npm run rotate-secret`); without it a key derived from the secret is used.
  const keyFile = join(dataDir, 'data.key');
  const dataKey = env.PGHL_DATA_KEY?.trim() || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '') || undefined;
  const prevFile = join(dataDir, 'data.key.previous');
  const previousDataKeys = [
    ...(env.PGHL_DATA_KEY_PREVIOUS ?? '').split(','),
    ...(existsSync(prevFile) ? readFileSync(prevFile, 'utf8').split(/\s+/) : []),
    // Left behind by an interrupted rotation (written before the database commit).
    ...(existsSync(join(dataDir, 'data.key.next')) ? readFileSync(join(dataDir, 'data.key.next'), 'utf8').split(/\s+/) : []),
  ]
    .map((k) => k.trim())
    .filter(Boolean);
  const behindProxy = env.PGHL_BEHIND_PROXY === '1';
  return {
    port,
    host: env.PGHL_HOST ?? (behindProxy ? '0.0.0.0' : '127.0.0.1'),
    dataDir,
    dbFile: join(dataDir, 'pghl.db'),
    baseUrl: (env.PGHL_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    webDir: resolve(env.PGHL_WEB_DIR ?? './dist-web'),
    behindProxy,
    proxyHops: Math.max(1, Number(env.PGHL_PROXY_HOPS ?? 1) || 1),
    tickMs: Number(env.PGHL_TICK_MS ?? 15_000),
    secret,
    demoMode: env.PGHL_DEMO_MODE === '1',
    cloudMode: env.PGHL_CLOUD_MODE === '1',
    dataKey,
    previousDataKeys,
  };
}
