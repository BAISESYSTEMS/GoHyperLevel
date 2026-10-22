import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { joinToken } from '../server/services/webinar-model.js';

/** Webinar registrations, questions and votes belong to the contact: they are in the data export and gone after "Kontakt löschen" (DSGVO). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let slug = '';
let wid = '';
const MONDAY = '2026-11-09T18:00:00.000Z';
const clock = { ms: Date.parse('2026-11-09T18:05:00Z') }; // five minutes into the session
const post = async (path: string, body: unknown) => {
  const r = await t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: (await r.json().catch(() => null)) as any };
};
const count = (table: string, where = '1=1', ...args: unknown[]) => Number(t.app.db.get<any>(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`, ...args)?.n ?? 0);

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.services.webinarNow = () => clock.ms;
  const created = await t.api.post('/api/webinars', { title: 'Datenschutz-Test', presenter_name: 'Erika Muster' });
  wid = created.data.id;
  slug = created.data.slug;
  const set = await t.api.patch(`/api/webinars/${wid}`, {
    video: { type: 'url', url: 'https://cdn.example.com/webinar.mp4' },
    duration_s: 3600,
    schedule: { fixed: { enabled: true, weekdays: ['mon'], times: ['19:00'] }, horizon_days: 21, late_join_min: 30 },
    settings: { room: { questions: true, polls: [{ id: 'poll1abc', at_s: 60, question: 'Wie viele?', options: ['a', 'b'], show_results: false }] } },
    status: 'published',
  });
  expect(set.status, JSON.stringify(set.data)).toBe(200);
});
afterAll(() => t.close());

describe('privacy: export and erase', () => {
  it('exports the registration, question and vote, then erases them with the contact', async () => {
    const email = 'dora.dsgvo@example.com';
    const reg = await post(`/api/public/webinars/${slug}/register`, { first_name: 'Dora', last_name: 'Datenschutz', email, consent: true, session: MONDAY, tz: 'Europe/Berlin' });
    expect(reg.status, JSON.stringify(reg.data)).toBe(200);
    const row = t.app.db.get<any>('SELECT r.* FROM webinar_registrations r JOIN contacts c ON c.id = r.contact_id WHERE c.email = ?', email)!;
    const tok = joinToken('test-secret', row.id);
    expect((await post(`/api/public/webinars/${slug}/question`, { t: tok, text: 'Bekomme ich die Folien?' })).status).toBe(200);
    expect((await post(`/api/public/webinars/${slug}/vote`, { t: tok, poll_id: 'poll1abc', choice: [0] })).status).toBe(200);
    expect(count('webinar_registrations', 'id = ?', row.id)).toBe(1);
    expect(count('webinar_questions', 'registration_id = ?', row.id)).toBe(1);
    expect(count('webinar_votes', 'registration_id = ?', row.id)).toBe(1);

    const exported = (await t.api.get(`/api/contacts/${row.contact_id}/privacy-export`)).data;
    expect(Object.keys(exported.data)).toEqual(expect.arrayContaining(['webinar_registrations', 'webinar_questions']));
    const text = JSON.stringify(exported);
    expect(text).toContain('Bekomme ich die Folien?');
    // the registration row itself holds no secret: the join link is derived from the server secret, never stored
    expect(JSON.stringify(exported.data.webinar_registrations)).not.toContain(tok);

    const er = await t.api.post(`/api/contacts/${row.contact_id}/erase`, { confirm: email });
    expect(er.status, JSON.stringify(er.data)).toBe(200);
    expect(count('webinar_registrations', 'id = ?', row.id)).toBe(0);
    expect(count('webinar_questions', 'registration_id = ?', row.id)).toBe(0);
    expect(count('webinar_votes', 'registration_id = ?', row.id)).toBe(0);
    expect(count('webinar_reminders', 'registration_id = ?', row.id)).toBe(0);
    // the webinar itself stays
    expect(count('webinars', 'id = ?', wid)).toBe(1);
  });
});
