import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseLocations } from '../server/services/cloud-export.js';
import { startTestApp } from './helpers.js';
import { client, seedCreatorRows, seedLocation, seedTelephonyRows, tableColumns } from './security-fixtures.js';

/**
 * Deleting a sub-account – self-hosted (Agentur → Sub-Accounts) or a hosted customer – takes all of it: rows without a foreign key
 * (web hook payloads, tracked links …) and the people's files (HR documents, certificates, imports, recordings …). What has to
 * outlive it stays: the queued deletions in the knowledge memory, and on a self-hosted install the media library and audit log.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
const files = (): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(t.app.config.dataDir, p));
    }
  };
  walk(t.app.config.dataDir);
  return out.filter((f) => !f.startsWith('test.db')).sort();
};
const put = (rel: string) => {
  mkdirSync(join(t.app.config.dataDir, rel, '..'), { recursive: true });
  writeFileSync(join(t.app.config.dataDir, rel), 'x');
};
/** Rows (and audio files) only a real call or an analysis creates, with generated file names. */
function recordings(loc: string, tag: string) {
  const at = new Date().toISOString();
  t.app.db.insert('call_intel', { id: `${tag}upload-intel`, location_id: loc, source: 'upload', contact_id: null, title: 'Gespräch', status: 'done', audio_file: `${tag}intelaudio0001.mp3`, audio_bytes: 1, created_at: at });
  put(`call-intel/${tag}intelaudio0001.mp3`);
  t.app.db.insert('call_audio', { id: `${tag}upload-hold`, location_id: loc, name: 'Wartemusik', kind: 'hold', mime: 'audio/wav', bytes: 1, file: `${tag}holdmusic00001.wav`, text: '', duration_s: 1, created_at: at });
  put(`call-audio/${tag}holdmusic00001.wav`);
  t.app.db.insert('cognee_state', { location_id: loc, type: 'wiki', dataset_id: `ds-${tag}`, updated_at: at });
  t.app.db.insert('cognee_accounts', { location_id: loc, auth_mode: 'password', email: `${tag}@cognee.example`, secret_sealed: 'x', created_at: at, updated_at: at });
}

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
}, 60_000);
afterAll(async () => t?.close());

describe('deleting a sub-account', () => {
  it('self-hosted: removes the rows without a foreign key and the files of the people in it, keeps the media library', async () => {
    const before = files();
    const loc = (await t.api.post('/api/locations', { name: 'Kunde Zorblax' })).data.id as string;
    const r = await seedLocation(client(t.base, { cookie: t.api.cookie, 'x-pghl': '1' }), loc, 'Zorblax');
    expect(r.failed).toEqual([]);
    seedCreatorRows(t.app, loc, r.ids, 'Zorblax');
    seedTelephonyRows(t.app, loc, r.ids, 'Zorblax');
    recordings(loc, 'zorblax');
    const cert = t.app.db.get<{ id: string }>('SELECT id FROM certificates WHERE location_id = ?', loc)!;
    expect((await fetch(`${t.base}/zertifikat/${cert.id}/pdf`)).status).toBe(200);
    const theirs = files().filter((f) => !before.includes(f));
    // HR documents, receipts, the certificate PDF, an import file, call audio, Office documents, the media library …
    for (const dir of ['hr-docs/', 'acc-docs/', 'certificates/', 'umzug/', 'call-intel/', 'call-audio/', 'office-files/', 'uploads/']) expect(theirs.some((f) => f.startsWith(dir)), dir).toBe(true);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM rest_hook_samples WHERE location_id = ?', loc)!.n).toBeGreaterThan(0);

    expect((await t.api.del(`/api/locations/${loc}`)).status).toBe(200);
    const left: string[] = [];
    for (const [table, cols] of tableColumns(t.app)) {
      if (!cols.includes('location_id') || ['uploads', 'audit_log', 'cognee_deletions', 'cognee_accounts'].includes(table)) continue;
      const n = t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}" WHERE location_id = ?`, loc)!.n;
      if (n) left.push(`${table}: ${n}`);
    }
    expect(left).toEqual([]);
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM tracked_links WHERE location_id = ?`, loc)!.n).toBe(0);
    // Only the media library stays (pictures may be shown on pages of other sub-accounts).
    expect(files().filter((f) => !before.includes(f) && !f.startsWith('uploads/'))).toEqual([]);
    expect(theirs.filter((f) => f.startsWith('uploads/')).every((f) => existsSync(join(t.app.config.dataDir, f)))).toBe(true);
    // The knowledge memory still learns that the datasets have to go (and keeps the login it needs for that).
    expect(t.app.db.all('SELECT dataset_id, reason FROM cognee_deletions WHERE location_id = ?', loc)).toEqual([{ dataset_id: 'ds-zorblax', reason: 'location_deleted' }]);
    expect(t.app.db.get('SELECT email FROM cognee_accounts WHERE location_id = ?', loc)).toEqual({ email: 'zorblax@cognee.example' });
  }, 120_000);

  it('hosted customer: also the call recordings, hold music and scaled pictures – and the knowledge memory is still told', async () => {
    const loc = (await t.api.post('/api/locations', { name: 'Kunde Quux' })).data.id as string;
    recordings(loc, 'quuxquux');
    t.app.db.insert('uploads', { id: 'quuxupload00000001', location_id: loc, name: 'bild.png', file: 'quuxuploadfile000001.png', mime: 'image/png', size: 1, created_at: new Date().toISOString() });
    put('uploads/quuxuploadfile000001.png');
    put('uploads-opt/640/quuxuploadfile000001.webp');
    eraseLocations(t.app, [loc]);
    expect(files().filter((f) => f.includes('quux'))).toEqual([]);
    expect(t.app.db.all('SELECT reason FROM cognee_deletions WHERE location_id = ?', loc)).toEqual([{ reason: 'location_deleted' }]);
    expect(t.app.db.get('SELECT 1 AS x FROM cognee_accounts WHERE location_id = ?', loc)).toBeTruthy();
  });
});
