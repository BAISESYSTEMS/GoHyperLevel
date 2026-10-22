import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestApp } from './helpers.js';
import { exportTenant } from '../server/services/cloud-export.js';

/** GDPR: what the course depth keeps about people is exported with them and erased with them. */
let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let course: any;
let lesson: any;
const stamp = new Date().toISOString();

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  course = (await t.api.post('/api/courses', { title: 'Datenschutz-Kurs', empty: true })).data;
  const mod = (await t.api.post(`/api/courses/${course.id}/modules`, { title: 'Modul' })).data;
  lesson = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: mod.id, title: 'Lektion' })).data;
}, 60_000);
afterAll(() => t.close());

async function person(email: string) {
  const r = await t.api.post(`/api/courses/${course.id}/enrollments`, { email, name: email.split('@')[0] });
  expect(r.status).toBe(200);
  const contactId = r.data.contact_id as string;
  const enrollment = t.app.db.get<any>('SELECT id FROM course_enrollments WHERE contact_id = ? AND course_id = ?', contactId, course.id);
  return { contactId, enrollmentId: enrollment.id as string };
}
const comment = (id: string, contactId: string | null, name: string, body: string, parent: string | null = null) =>
  t.app.db.run(
    `INSERT INTO course_comments (id, location_id, course_id, lesson_id, parent_id, contact_id, author_name, staff, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'visible', ?)`,
    id,
    loc,
    course.id,
    lesson.id,
    parent,
    contactId,
    name,
    body,
    stamp,
  );
const playback = (enrollmentId: string, position: number, speed = 1) =>
  t.app.db.run(
    `INSERT INTO course_playback (enrollment_id, lesson_id, position_sec, duration_sec, furthest_sec, watched_sec, speed, updated_at) VALUES (?, ?, ?, 600, ?, ?, ?, ?)`,
    enrollmentId,
    lesson.id,
    position,
    position,
    position,
    speed,
    stamp,
  );

describe('course data and the right to be forgotten', () => {
  it('exports watch progress with the contact data', async () => {
    const p = await person('export.me@example.de');
    playback(p.enrollmentId, 61, 1.5);
    const out = (await t.api.get(`/api/contacts/${p.contactId}/privacy-export`)).data;
    expect(out.data.course_playback).toEqual([expect.objectContaining({ lesson_id: lesson.id, position_sec: 61, speed: 1.5 })]);
    expect(out.data.course_enrollments).toHaveLength(1);
  });

  it('erases comments, reviews and watch progress; answered comments stay as a neutral stub', async () => {
    const p = await person('forget.me@example.de');
    const other = await person('stays@example.de');
    comment('cm-forget-1', p.contactId, 'Forget', 'Meine Frage mit privaten Angaben');
    comment('cm-forget-2', p.contactId, 'Forget', 'Eine Frage ohne Antwort');
    comment('cm-reply', other.contactId, 'Stays', 'Antwort einer anderen Person', 'cm-forget-1');
    comment('cm-stays', other.contactId, 'Stays', 'Bleibt stehen');
    t.app.db.run(
      `INSERT INTO course_reviews (id, location_id, course_id, contact_id, author_name, rating, title, body, status, created_at, updated_at) VALUES ('rv-forget', ?, ?, ?, 'Forget', 5, 'Super', 'Sehr gut', 'published', ?, ?)`,
      loc,
      course.id,
      p.contactId,
      stamp,
      stamp,
    );
    playback(p.enrollmentId, 5);

    const r = await t.api.post(`/api/contacts/${p.contactId}/erase`, { confirm: 'forget.me@example.de' });
    expect(r.status).toBe(200);

    const rows = t.app.db.all<any>(`SELECT id, contact_id, author_name, body FROM course_comments WHERE id LIKE 'cm-%' ORDER BY id`);
    expect(rows.map((x) => x.id)).toEqual(['cm-forget-1', 'cm-reply', 'cm-stays']);
    const stub = rows[0];
    expect(stub.contact_id).toBeNull();
    expect(stub.author_name).toBe('Gelöscht (DSGVO)');
    expect(stub.body).toBe('[Kommentar gelöscht]');
    expect(JSON.stringify(rows)).not.toMatch(/privaten Angaben|Forget/);
    expect(rows[1].body).toBe('Antwort einer anderen Person');
    expect(t.app.db.get('SELECT 1 AS x FROM course_reviews WHERE id = ?', 'rv-forget')).toBeUndefined();
    expect(t.app.db.get('SELECT 1 AS x FROM course_playback WHERE enrollment_id = ?', p.enrollmentId)).toBeUndefined();
  });

  it('puts the video folder into the customer data export', async () => {
    const before = exportTenant(t.app, { id: 'x', name: 'x' }, [loc]).files;
    const vid = 'vidprivacy0123456789abcdef';
    t.app.db.run(
      `INSERT INTO course_videos (id, location_id, name, file, size, received, status, mime, duration_sec, poster, hls, hls_note, ai_status, ai_note, created_at) VALUES (?, ?, 'v.mp4', ?, 10, 10, 'complete', 'video/mp4', 0, '', 'ready', '', '', '', ?)`,
      vid,
      loc,
      `${vid}.mp4`,
      stamp,
    );
    const dir = join(t.app.config.dataDir, 'course-videos');
    mkdirSync(join(dir, vid, 'hls'), { recursive: true });
    writeFileSync(join(dir, `${vid}.mp4`), 'x');
    writeFileSync(join(dir, vid, 'hls', 'master.m3u8'), '#EXTM3U');
    writeFileSync(join(dir, vid, 'hls', 'v0_000.ts'), 'ts');
    expect(exportTenant(t.app, { id: 'x', name: 'x' }, [loc]).files).toBe(before + 3);
  });
});
