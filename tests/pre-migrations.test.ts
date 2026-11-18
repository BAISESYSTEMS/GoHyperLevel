import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type Module } from '../server/core/app.js';

describe('module pre-migration hooks', () => {
  it('runs every hook before any migration on each startup, including when other modules have no hook', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pre-migrations-'));
    const config = { port: 0, host: '127.0.0.1', dataDir: dir, dbFile: join(dir, 'test.db'), baseUrl: 'http://localhost', webDir: dir, behindProxy: false, tickMs: 0, secret: 'test' };
    const calls: string[] = [];
    const modules: Module[] = [
      { name: 'first', migrations: [['001', 'CREATE TABLE example (value TEXT)']], register() { calls.push('register'); } },
      { name: 'repair', beforeMigrations(db) { calls.push('repair'); db.raw.exec('CREATE TABLE IF NOT EXISTS repaired (value TEXT)'); if (calls.length === 1) expect(db.get("SELECT name FROM sqlite_master WHERE name = 'example'")).toBeUndefined(); }, register() {} },
      { name: 'check', beforeMigrations(db) { calls.push('check'); expect(db.get("SELECT name FROM sqlite_master WHERE name = 'repaired'")).toBeTruthy(); }, register() {} },
    ];
    try {
      const first = createApp(config, modules);
      first.app.db.close();
      const second = createApp(config, modules);
      second.app.db.close();
      expect(calls).toEqual(['repair', 'check', 'register', 'repair', 'check', 'register']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
