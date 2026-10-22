import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decryptFile, encryptFile, parseBackupKey } from '../server/services/backup-crypto.js';
import { offsiteConfig, restoreSnapshot } from '../server/services/backup-offsite.js';
import { parseRetention, plan, stampOf } from '../server/services/backup-retention.js';
import { S3Client, signRequest } from '../server/services/s3-lite.js';
import { ROOT } from './boot-fakes.js';
import { startTestApp } from './helpers.js';
import { S3_CREDS, startFakeS3 } from './s3-fake.js';

const KEY_HEX = '0123456789abcdef'.repeat(4);
const OLD_KEY_HEX = 'fedcba9876543210'.repeat(4);

describe('SigV4 signing', () => {
  // AWS's published examples ("Signature Calculations for the Authorization Header: Transferring Payload in a Single Chunk").
  const aws = { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z') };
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  it('matches the GET Object example', () => {
    const h = signRequest({ ...aws, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { Range: 'bytes=0-9' }, payloadHash: empty });
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
  it('matches the GET Bucket (list objects) example', () => {
    const h = signRequest({ ...aws, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'), headers: {}, payloadHash: empty });
    expect(h.authorization).toMatch(/Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
  });
});

describe('retention (hourly 48 / daily 14 / monthly 6)', () => {
  it('keeps the newest per hour, day and month and prunes the rest', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    const stamps: string[] = [];
    for (let h = 0; h < 24 * 270; h++) stamps.push(stampOf(new Date(now - h * 3600_000)));
    const p = plan(stamps, parseRetention(undefined));
    const hours = new Set(p.keep.map((s) => s.slice(0, 13)));
    const days = new Set(p.keep.map((s) => s.slice(0, 10)));
    const months = new Set(p.keep.map((s) => s.slice(0, 7)));
    expect(p.keep.length).toBeLessThanOrEqual(48 + 14 + 6);
    expect(hours.size).toBeGreaterThanOrEqual(48);
    expect(days.size).toBeGreaterThanOrEqual(14);
    expect([...months].sort()).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(p.keep).toContain(stamps[0]);
    expect(p.prune.length + p.keep.length).toBe(stamps.length);
    // the newest 48 hourly snapshots are all there
    for (const s of stamps.slice(0, 48)) expect(p.keep).toContain(s);
    expect(parseRetention('24, 7, 3')).toEqual({ hourly: 24, daily: 7, monthly: 3 });
    expect(parseRetention('nonsense')).toEqual({ hourly: 48, daily: 14, monthly: 6 });
  });
});

describe('encryption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pghl-enc-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('round-trips with gzip, refuses a wrong key and a changed byte', async () => {
    const src = join(dir, 'plain.txt');
    writeFileSync(src, 'Kundendaten '.repeat(5000));
    const key = parseBackupKey(KEY_HEX);
    const enc = join(dir, 'x.enc');
    const r = await encryptFile(src, enc, key, { gzip: true });
    expect(r.bytes).toBeLessThan(60_000 / 4);
    expect(readFileSync(enc).includes(Buffer.from('Kundendaten'))).toBe(false);
    const out = join(dir, 'out.txt');
    await decryptFile(enc, out, [parseBackupKey(OLD_KEY_HEX), key]);
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(src, 'utf8'));
    await expect(decryptFile(enc, join(dir, 'wrong.txt'), [parseBackupKey(OLD_KEY_HEX)])).rejects.toThrow(/anderen Schlüssel/);
    const bad = readFileSync(enc);
    bad[bad.length - 40] ^= 1;
    writeFileSync(join(dir, 'bad.enc'), bad);
    await expect(decryptFile(join(dir, 'bad.enc'), join(dir, 'bad.txt'), [key])).rejects.toThrow(/beschädigt/);
    expect(existsSync(join(dir, 'bad.txt'))).toBe(false);
    expect(() => parseBackupKey('zu-kurz')).toThrow(/32 Bytes/);
  });
});

describe('off-site backup against a local S3', () => {
  let s3: Awaited<ReturnType<typeof startFakeS3>>;
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const alerts: { url: string; body: string }[] = [];
  const env = () => ({
    PGHL_BACKUP_S3_ENDPOINT: s3.endpoint,
    PGHL_BACKUP_S3_BUCKET: S3_CREDS.bucket,
    PGHL_BACKUP_S3_REGION: S3_CREDS.region,
    PGHL_BACKUP_S3_ACCESS_KEY: S3_CREDS.accessKey,
    PGHL_BACKUP_S3_SECRET_KEY: S3_CREDS.secretKey,
    PGHL_BACKUP_S3_PREFIX: 'gohigh',
    PGHL_BACKUP_KEY: KEY_HEX,
  });
  const svc = () => t.app.services.offsiteBackup;
  const put = (rel: string, data: string) => {
    mkdirSync(join(t.app.config.dataDir, rel, '..'), { recursive: true });
    writeFileSync(join(t.app.config.dataDir, rel), data);
  };

  beforeAll(async () => {
    s3 = await startFakeS3({ pageSize: 25 });
    Object.assign(process.env, env(), { PGHL_ALERT_WEBHOOK: 'https://ntfy.sh/ops-test-topic' });
    t = await startTestApp();
    await t.setup();
    t.app.services.alertFetch = async (url: string, init: { body: string }) => {
      alerts.push({ url, body: init.body });
      return new Response('ok');
    };
    t.app.services.alertMailer = async () => ({ status: 'logged' });
    for (let i = 0; i < 5; i++) await t.api.post('/api/contacts', { first_name: `Kunde${i}`, email: `kunde${i}@example.com` });
    put('uploads/logo-aaaaaaaaaaaaaaaa.png', 'PNG-DATEN-GEHEIM');
    put('form-files/abc/vertrag.pdf', 'PDF-DATEN-GEHEIM');
  }, 60_000);
  afterAll(async () => {
    for (const k of [...Object.keys(env()), 'PGHL_ALERT_WEBHOOK']) delete process.env[k];
    await t?.close();
    await s3?.close();
  });

  it('reads its configuration from the environment and names what is missing', () => {
    expect(offsiteConfig({}).config).toBeUndefined();
    expect(offsiteConfig({ PGHL_BACKUP_S3_BUCKET: 'x' }).error).toMatch(/PGHL_BACKUP_S3_ENDPOINT/);
    expect(offsiteConfig({ ...env(), PGHL_BACKUP_KEY: 'kurz' }).error).toMatch(/32 Bytes/);
    const c = offsiteConfig(env()).config!;
    expect(c).toMatchObject({ prefix: 'gohigh/', intervalMin: 60, files: true, retention: { hourly: 48, daily: 14, monthly: 6 } });
  });

  it('uploads an encrypted database snapshot, the upload folders and a manifest', async () => {
    const run = await svc().run();
    expect(run.status, run.error).toBe('ok');
    expect(run.files_uploaded).toBe(2);
    expect(s3.keys('gohigh/db/')).toHaveLength(1);
    expect(s3.keys('gohigh/manifests/')).toHaveLength(1);
    expect(s3.keys('gohigh/files/')).toHaveLength(2);
    // Nothing readable leaves the server: no SQLite header, no file content, no file names in the keys.
    for (const [k, o] of s3.objects) {
      expect(o.body.subarray(0, 8).toString(), k).toBe('PGHLENC1');
      expect(o.body.includes(Buffer.from('SQLite format 3')), k).toBe(false);
      expect(o.body.includes(Buffer.from('GEHEIM')), k).toBe(false);
      expect(k).not.toMatch(/logo|vertrag/);
    }
    // the local database and keys are never walked as upload files
    const detail = JSON.parse(t.app.db.get<{ detail: string }>('SELECT detail FROM backup_runs WHERE id = ?', run.id)!.detail);
    expect(detail.files).toBe(2);
    expect(detail.rows.contacts).toBe(5);
    const st = (await t.api.get('/api/admin/offsite-backup')).data;
    expect(st).toMatchObject({ configured: true, target: { bucket: 'backups', prefix: 'gohigh/' }, last_ok: { status: 'ok' }, files_tracked: 2 });
  });

  it('uploads only new files the next time', async () => {
    put('uploads/neu-bbbbbbbbbbbbbbbb.webp', 'NEU');
    const run = await svc().run();
    expect(run.status, run.error).toBe('ok');
    expect(run.files_uploaded).toBe(1);
    expect(s3.keys('gohigh/files/')).toHaveLength(3);
    expect(s3.keys('gohigh/db/').length).toBeGreaterThanOrEqual(1);
  });

  it('prunes snapshots outside the retention and file objects no kept snapshot needs', async () => {
    const now = Date.now();
    // A long history in the bucket: one snapshot a day for 250 days and one an hour for the last 60 hours.
    const fake = (stamp: string) => {
      s3.objects.set(`gohigh/db/${stamp}.db.gz.enc`, { body: Buffer.from('PGHLENC1x'), at: new Date().toISOString() });
      s3.objects.set(`gohigh/manifests/${stamp}.json.enc`, { body: Buffer.from('PGHLENC1x'), at: new Date().toISOString() });
    };
    for (let d = 1; d <= 250; d++) fake(stampOf(new Date(now - d * 864e5 - 7 * 3600_000)));
    for (let h = 1; h <= 60; h++) fake(stampOf(new Date(now - h * 3600_000 - 60_000)));
    const before = s3.keys('gohigh/db/').map((k) => /db\/(.+)\.db\.gz\.enc$/.exec(k)![1]);
    // a file that disappeared just now
    unlinkSync(join(t.app.config.dataDir, 'uploads/neu-bbbbbbbbbbbbbbbb.webp'));
    const run = await svc().run();
    expect(run.status, run.error).toBe('ok');
    const after = s3.keys('gohigh/db/').map((k) => /db\/(.+)\.db\.gz\.enc$/.exec(k)![1]);
    const newStamp = after.find((x) => !before.includes(x))!;
    // exactly what the retention plan keeps – and every kept snapshot keeps its manifest
    expect(after).toEqual(plan([...before, newStamp], parseRetention(undefined)).keep.sort());
    expect(after.length).toBeLessThanOrEqual(48 + 14 + 6);
    // the fake lists 25 keys per page – the client followed the continuation tokens
    expect(s3.log.some((l) => l.query.includes('continuation-token'))).toBe(true);
    expect(s3.keys('gohigh/manifests/')).toHaveLength(after.length);
    const det = JSON.parse(t.app.db.get<{ detail: string }>('SELECT detail FROM backup_runs WHERE id = ?', run.id)!.detail);
    expect(det.pruned).toBe(before.length + 1 - after.length);
    // The file object stays while a kept snapshot may need it, and goes once it vanished before the oldest kept one.
    const gone = t.app.db.get<{ hash: string; gone_at: string }>(`SELECT hash, gone_at FROM backup_files WHERE path = 'uploads/neu-bbbbbbbbbbbbbbbb.webp'`)!;
    expect(gone.gone_at).toBeTruthy();
    expect(s3.keys('gohigh/files/')).toContain(`gohigh/files/${gone.hash}.enc`);
    t.app.db.run('UPDATE backup_files SET gone_at = ? WHERE hash = ?', '2001-01-01T00:00:00.000Z', gone.hash);
    expect((await svc().run()).status).toBe('ok');
    expect(s3.keys('gohigh/files/')).not.toContain(`gohigh/files/${gone.hash}.enc`);
    expect(t.app.db.get('SELECT 1 AS x FROM backup_files WHERE hash = ?', gone.hash)).toBeUndefined();
  }, 60_000);

  it('restores the newest snapshot with its files and checks it (library and npm run backup:restore)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pghl-restore-'));
    try {
      const r = await restoreSnapshot(offsiteConfig().config!, { dir, files: true, s3: new S3Client(offsiteConfig().config!.s3) });
      expect(r.problems).toEqual([]);
      expect(r.integrity).toBe('ok');
      expect(r.rowsMatch).toBe(true);
      expect(r.rows.contacts).toBe(5);
      expect(readFileSync(join(dir, 'uploads/logo-aaaaaaaaaaaaaaaa.png'), 'utf8')).toBe('PNG-DATEN-GEHEIM');
      expect(readFileSync(join(dir, 'form-files/abc/vertrag.pdf'), 'utf8')).toBe('PDF-DATEN-GEHEIM');
      const cli = await promisify(execFile)(process.execPath, ['--no-warnings', '--import', 'tsx', 'server/cli/backup-restore.ts', 'latest', '--to', join(dir, 'cli'), '--files'], { cwd: ROOT, env: { ...process.env, PGHL_DATA_DIR: t.app.config.dataDir } });
      expect(cli.stdout).toContain('integrity_check: ok');
      expect(cli.stdout).toContain('Geprüft und bereit');
      expect(existsSync(join(dir, 'cli', 'pghl.db'))).toBe(true);
      expect(readFileSync(join(dir, 'cli', 'uploads/logo-aaaaaaaaaaaaaaaa.png'), 'utf8')).toBe('PNG-DATEN-GEHEIM');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('runs the monthly restore test and alerts when it fails', async () => {
    const ok = await svc().restoreTest();
    expect(ok.status, ok.error).toBe('ok');
    expect(JSON.parse(t.app.db.get<{ detail: string }>('SELECT detail FROM backup_runs WHERE id = ?', ok.id)!.detail)).toMatchObject({ integrity: 'ok', files_checked: 2 });
    // A damaged object in the bucket: the test fails and the operator hears about it.
    const newest = s3.keys('gohigh/db/').at(-1)!;
    const body = Buffer.from(s3.objects.get(newest)!.body);
    body[body.length - 30] ^= 0xff;
    s3.objects.set(newest, { body, at: new Date().toISOString() });
    const bad = await svc().restoreTest();
    expect(bad.status).toBe('failed');
    expect(bad.error).toMatch(/beschädigt/);
    expect(t.app.db.get(`SELECT * FROM ops_alerts WHERE key = 'restore_test_failed'`)).toBeTruthy();
    // the alert goes out in the background (mail, push, then the webhook)
    await vi.waitFor(() => expect(alerts.some((a) => a.url.includes('ntfy.sh') && a.body.includes('beschädigt'))).toBe(true));
  });

  it('records a failed upload and retries; the admin buttons start jobs', async () => {
    s3.refuse((m, k) => m === 'PUT' && k.includes('/db/'));
    const r = await svc().run();
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/HTTP 500/);
    s3.refuse(undefined);
    expect((await t.api.post('/api/admin/offsite-backup/run')).data).toEqual({ started: true });
    await svc().idle();
    expect(t.app.db.get<{ status: string }>(`SELECT status FROM backup_runs WHERE kind = 'backup' ORDER BY started_at DESC LIMIT 1`)!.status).toBe('ok');
    expect((await t.api.get('/api/admin/offsite-backup/snapshots')).data.snapshots.length).toBeGreaterThan(0);
  });
});
