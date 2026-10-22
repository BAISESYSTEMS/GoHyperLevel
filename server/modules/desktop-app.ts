import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { mayUploadRaw } from './mobile-app.js';

/**
 * Updates for the desktop app (Tauri shell in `desktop/`, docs/apps.md#desktop-app) – served by the instance itself, like the
 * signed APK: the admin uploads the signed update bundle of each platform (`PUT /api/desktop/app`, raw bytes plus the Tauri
 * signature), the app asks `GET /api/desktop/update/<target>/<arch>/<version>` and Tauri checks the signature against the
 * public key built into the app before installing.
 */

const TARGETS = new Set(['windows', 'darwin', 'linux']);
const ARCHS = new Set(['x86_64', 'aarch64', 'i686', 'armv7']);
const MAX_BUNDLE = 250 * 1024 * 1024;
const KEEP_PER_PLATFORM = 2;
const VERSION = /^\d{1,4}\.\d{1,5}\.\d{1,6}(-[\w.]{1,20})?$/;

/** "1.10.0" > "1.9.3"; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const [ma, pa = ''] = a.split('-');
  const [mb, pb = ''] = b.split('-');
  const x = ma.split('.').map(Number);
  const y = mb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  if (pa === pb) return 0;
  return !pa ? 1 : !pb ? -1 : pa < pb ? -1 : 1;
}

export const desktopAppModule: Module = {
  name: 'desktop-app',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE desktop_app_releases (
        id TEXT PRIMARY KEY, version TEXT NOT NULL, target TEXT NOT NULL, arch TEXT NOT NULL, file TEXT NOT NULL, name TEXT NOT NULL,
        sha256 TEXT NOT NULL, size INTEGER NOT NULL, signature TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX desktop_app_releases_platform ON desktop_app_releases(target, arch);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const dir = join(app.config.dataDir, 'desktop-app');
    const prevLimit = app.services.rawBodyLimit;
    app.services.rawBodyLimit = (method: string, path: string, req: any, cookies: Record<string, string>): number | undefined =>
      method === 'PUT' && path === '/api/desktop/app' && mayUploadRaw(app, req, cookies) ? MAX_BUNDLE : prevLimit?.(method, path, req, cookies);

    const newest = (target: string, arch: string) =>
      db.all('SELECT * FROM desktop_app_releases WHERE target = ? AND arch = ? AND file != \'\'', target, arch).sort((a, b) => compareVersions(b.version, a.version))[0];
    const download = (r: any) => `${app.baseUrl()}/downloads/desktop/${r.id}/${encodeURIComponent(r.name)}`;

    router.put('/api/desktop/app', 'admin', (ctx: Ctx) => {
      if (ctx.via === 'app') throw new HttpError(403, 'Hochladen nur im Browser oder mit einem Agentur-Schlüssel');
      const buf = ctx.rawBuffer;
      if (!buf?.length) throw bad('Datei fehlt (Update-Paket als Rohdaten im Body)');
      const h = ctx.req.headers;
      const version = String(h['x-version'] ?? '').trim();
      if (!VERSION.test(version)) throw bad('x-version fehlt (z. B. 1.2.0)');
      const target = String(h['x-target'] ?? '');
      const arch = String(h['x-arch'] ?? 'x86_64');
      if (!TARGETS.has(target)) throw bad('x-target: windows, darwin oder linux');
      if (!ARCHS.has(arch)) throw bad('x-arch: x86_64, aarch64, i686 oder armv7');
      // The content of the .sig file Tauri writes next to the bundle (base64 minisign signature).
      const signature = str(h['x-signature'], 'x-signature', { required: true, max: 2000 });
      if (!/^[A-Za-z0-9+/=]{40,2000}$/.test(signature)) throw bad('x-signature: Inhalt der .sig-Datei (Base64)');
      const name = str(h['x-file-name'], 'x-file-name', { max: 120 }).replace(/[^\w.-]/g, '_') || `app-${version}-${target}-${arch}`;
      let notes = '';
      try {
        notes = decodeURIComponent(String(h['x-notes'] ?? '').replace(/\+/g, ' ')).trim().slice(0, 5000);
      } catch {
        throw bad('x-notes bitte URL-kodiert senden');
      }
      mkdirSync(dir, { recursive: true });
      const file = `${id(12)}.bin`;
      writeFileSync(join(dir, file), buf);
      const row = { id: id(), version, target, arch, file, name, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length, signature, notes, created_at: now() };
      db.tx(() => {
        for (const old of db.all('SELECT id, file FROM desktop_app_releases WHERE target = ? AND arch = ? AND version = ?', target, arch, version)) {
          rmSync(join(dir, old.file), { force: true });
          db.run('DELETE FROM desktop_app_releases WHERE id = ?', old.id);
        }
        db.insert('desktop_app_releases', row);
        const all = db.all('SELECT id, file, version FROM desktop_app_releases WHERE target = ? AND arch = ? AND file != \'\'', target, arch).sort((a, b) => compareVersions(b.version, a.version));
        for (const old of all.slice(KEEP_PER_PLATFORM)) {
          rmSync(join(dir, old.file), { force: true });
          db.run(`UPDATE desktop_app_releases SET file = '' WHERE id = ?`, old.id);
        }
      });
      return { id: row.id, version, target, arch, sha256: row.sha256, size: row.size, url: download(row) };
    });

    // Tauri's updater: 204 = nothing newer, 200 = the update with its signature.
    router.get('/api/desktop/update/:target/:arch/:current', 'public', (ctx) => {
      const { target, arch, current } = ctx.params;
      if (!TARGETS.has(target) || !ARCHS.has(arch)) throw notFound();
      const r = newest(target, arch);
      if (!r || (VERSION.test(current) && compareVersions(r.version, current) <= 0)) return { __raw: true, status: 204, headers: { 'cache-control': 'no-cache' }, body: '' };
      return { version: r.version, notes: r.notes, pub_date: r.created_at, url: download(r), signature: r.signature };
    });

    router.get('/api/desktop/app', 'public', () =>
      [...TARGETS].flatMap((t) => [...ARCHS].map((a) => newest(t, a)).filter(Boolean)).map((r) => ({ version: r.version, target: r.target, arch: r.arch, size: Number(r.size), sha256: r.sha256, url: download(r), uploaded_at: r.created_at })),
    );

    router.get('/downloads/desktop/:id/:name', 'public', (ctx) => {
      const r = db.get('SELECT * FROM desktop_app_releases WHERE id = ?', ctx.params.id);
      const path = r?.file ? join(dir, r.file) : '';
      if (!r || !path || !existsSync(path)) throw notFound();
      return {
        __raw: true,
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${r.name}"`,
          'content-length': String(statSync(path).size),
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
        },
        body: readFileSync(path),
      };
    });
  },
};
