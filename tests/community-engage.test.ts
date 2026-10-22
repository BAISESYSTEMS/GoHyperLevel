import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { sha256, token } from '../server/core/util.js';
import { zonedToUtc } from '../server/core/time.js';
import { leaderboard } from '../server/services/community.js';
import { archiveMonths, boardOf, cleanBadge, cleanPerk, cleanRule, evaluateBadges, monthKeyOf, monthLabel, shiftMonth, statOf } from '../server/services/community-gamify.js';
import { checkIn, cleanChallenge, cleanTasks, dayStates, sendReminders, todayOf } from '../server/services/community-challenges.js';
import { contributions } from '../server/services/community-activity.js';
import { OPEN_BEFORE_MIN, jitsiBase, jitsiUrl, phaseOf, roomName } from '../server/services/community-live.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const events: { type: string; data: any }[] = [];
let anna: any, ben: any, cara: any;
let annaC = '', benC = '', caraC = '';
let g: any;
let ch = '';
const EV = ['community.badge_earned', 'community.challenge_completed', 'community.event_attended', 'community.level_reached', 'community.challenge_joined'];

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.memberMailer = async () => ({ status: 'sent' });
  t.app.services.communityMailer = async () => ({ status: 'sent' });
  for (const type of EV) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(async () => {
  await t.close();
});

const settle = () => t.app.events.flush();
const base = () => `/portal/${loc}/community`;
function memberCookie(contactId: string) {
  const raw = token(32);
  t.app.db.run('INSERT INTO member_sessions (token_hash, location_id, contact_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(raw), loc, contactId, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
  return `pm_${loc}=${raw}`;
}
const get = (path: string, cookie = '') => t.api.raw(path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const page = async (path: string, cookie: string) => {
  const r = await get(path, cookie);
  return { status: r.status, html: await r.text(), headers: r.headers };
};
const post = (path: string, data: Record<string, string> | [string, string][], cookie: string) =>
  t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams(data as any).toString() });
const csrfOf = (html: string) => html.match(/name="(?:csrf|_t)" value="([^"]+)"/)![1];
async function submit(pagePath: string, action: string, data: Record<string, string> | [string, string][], cookie: string) {
  const { html } = await page(pagePath, cookie);
  const fields: [string, string][] = Array.isArray(data) ? data : Object.entries(data);
  const r = await post(action, [['csrf', csrfOf(html)], ...fields], cookie);
  return { status: r.status, location: r.headers.get('location') ?? '', html: r.status === 200 || r.status >= 400 ? await r.text() : '' };
}
const gUrl = () => `${base()}/g/${g.slug}`;
const points = (c: any) => t.app.db.get<{ n: number }>('SELECT COALESCE(SUM(points), 0) AS n FROM community_points WHERE group_id = ? AND contact_id = ?', g.id, c.id)!.n;
const addPoints = (c: any, n: number, at = new Date(), reason = 'test') => t.app.db.run('INSERT INTO community_points (id, location_id, group_id, contact_id, points, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', token(8), loc, g.id, c.id, n, reason, at.toISOString());
const putExt = (body: any) => t.api.put(`/api/community/groups/${g.id}/ext`, body);
const ymd = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return todayOf(t.app, loc, d);
};

describe('community engagement', () => {
  it('sets up a group with three members', async () => {
    anna = (await t.api.post('/api/contacts', { email: 'anna@example.de', first_name: 'Anna', last_name: 'Muster', tags: ['mitglied'] })).data;
    ben = (await t.api.post('/api/contacts', { email: 'ben@example.de', first_name: 'Ben', tags: ['mitglied'] })).data;
    cara = (await t.api.post('/api/contacts', { email: 'cara@example.de', first_name: 'Cara', tags: ['mitglied'] })).data;
    g = (await t.api.post('/api/community/groups', { name: 'Atelier', access: { mode: 'tags', tags: ['mitglied'] } })).data;
    ch = g.channels[0].id;
    [annaC, benC, caraC] = [anna, ben, cara].map((c) => memberCookie(c.id));
    for (const c of [annaC, benC, caraC]) expect((await page(gUrl(), c)).status).toBe(200);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM community_members WHERE group_id = ?', g.id)!.n).toBe(3);
  });
});

describe('badges', () => {
  it('checks what an admin may define', () => {
    expect(() => cleanBadge({ name: '' })).toThrow();
    expect(() => cleanBadge({ name: 'X', color: 'rot' })).toThrow(/#rrggbb/);
    expect(() => cleanBadge({ name: 'X', rule: { type: 'zauberei', value: 3 } })).toThrow(/Regel/);
    expect(() => cleanBadge({ name: 'X', rule: { type: 'posts', value: 0 } })).toThrow(/mindestens 1/);
    expect(() => cleanBadge({ name: 'X', points: 5000 })).toThrow();
    expect(cleanBadge({ name: 'Fleißig', emoji: '🏅🏅🏅', color: '#ff8800', rule: { type: 'posts', value: 3 } })).toMatchObject({ emoji: '🏅🏅', rule: { type: 'posts', value: 3 } });
  });

  it('awards by hand once, notifies, logs it and starts workflows', async () => {
    const b = (await t.api.post(`/api/community/groups/${g.id}/badges`, { name: 'Gründungsmitglied', emoji: '🌟', color: '#e11d48', description: 'Von Anfang an dabei', points: 7 })).data;
    expect(b).toMatchObject({ name: 'Gründungsmitglied', rule: { type: 'manual' }, awarded: 0 });
    const r = await t.api.post(`/api/community/badges/${b.id}/award`, { contact_id: anna.id, reason: 'Erste Stunde' });
    expect(r.data).toEqual({ awarded: true });
    expect((await t.api.post(`/api/community/badges/${b.id}/award`, { contact_id: anna.id })).data).toEqual({ awarded: false });
    await settle();
    expect(events.find((e) => e.type === 'community.badge_earned')!.data).toMatchObject({ contactId: anna.id, badge: { name: 'Gründungsmitglied' } });
    expect(points(anna)).toBe(7); // bonus points
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM community_notifications WHERE contact_id = ? AND kind = 'badge'`, anna.id)!.n).toBe(1);
    const handle = t.app.db.get<{ handle: string }>('SELECT handle FROM community_profiles WHERE contact_id = ?', anna.id)!.handle;
    const prof = await page(`${base()}/u/${handle}`, benC);
    expect(prof.html).toContain('Gründungsmitglied');
    expect(prof.html).toContain('Von Anfang an dabei');
    expect((await t.api.get(`/api/community/badges/${b.id}/awards`)).data[0]).toMatchObject({ contact_id: anna.id, reason: 'Erste Stunde' });
    // Somebody who is not in the group can't get one.
    const stranger = (await t.api.post('/api/contacts', { email: 'fremd@example.de', first_name: 'Fremd' })).data;
    expect((await t.api.post(`/api/community/badges/${b.id}/award`, { contact_id: stranger.id })).status).toBe(409);
    expect((await t.api.del(`/api/community/badges/${b.id}/award/${anna.id}`)).data).toEqual({ removed: true });
    expect((await t.api.get(`/api/community/groups/${g.id}/badges`)).data.badges[0].awarded).toBe(0);
  });

  it('awards by rule when the counter is reached – on events and on request', async () => {
    const first = (await t.api.post(`/api/community/groups/${g.id}/badges`, { name: 'Erster Beitrag', emoji: '✍️', rule: { type: 'posts', value: 1 } })).data;
    const lvl = (await t.api.post(`/api/community/groups/${g.id}/badges`, { name: 'Level 2', rule: { type: 'level', value: 2 } })).data;
    const pts = (await t.api.post(`/api/community/groups/${g.id}/badges`, { name: 'Punktesammler', rule: { type: 'points', value: 1000 } })).data;
    const r = await submit(gUrl(), `${gUrl()}/posts`, { title: 'Hallo zusammen', body: 'Ich bin Ben', channel_id: ch }, benC);
    expect(r.status).toBe(303);
    await settle();
    expect(t.app.db.get('SELECT 1 FROM community_badge_awards WHERE badge_id = ? AND contact_id = ?', first.id, ben.id)).toBeTruthy();
    expect(t.app.db.get('SELECT 1 FROM community_badge_awards WHERE badge_id = ? AND contact_id = ?', pts.id, ben.id)).toBeUndefined();
    // Anna wrote nothing yet (as a member): the rule applies when we ask for it, not before.
    expect(t.app.db.get('SELECT 1 FROM community_badge_awards WHERE badge_id = ? AND contact_id = ?', first.id, anna.id)).toBeUndefined();
    t.app.db.run(`INSERT INTO community_posts (id, location_id, group_id, channel_id, contact_id, author_name, title, body, created_at, updated_at, last_activity_at) VALUES ('old-post', ?, ?, ?, ?, 'Anna', 'Alt', 'Alt', ?, ?, ?)`, loc, g.id, ch, anna.id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    expect(statOf(t.app, g, anna.id, 'posts')).toBe(1);
    const ev = await t.api.post(`/api/community/groups/${g.id}/badges/evaluate`);
    expect(ev.data.awarded).toBeGreaterThanOrEqual(1);
    expect(t.app.db.get('SELECT 1 FROM community_badge_awards WHERE badge_id = ? AND contact_id = ?', first.id, anna.id)).toBeTruthy();
    // Level rule: reaching level 2 gives the badge.
    addPoints(cara, 6);
    t.app.db.run('UPDATE community_members SET level = 2 WHERE group_id = ? AND contact_id = ?', g.id, cara.id);
    expect(evaluateBadges(t.app, g, cara.id).map((b) => b.id)).toContain(lvl.id);
    expect(evaluateBadges(t.app, g, cara.id)).toHaveLength(0); // nothing twice
    expect((await t.api.get(`/api/community/groups/${g.id}/badges/preview?type=points&value=1`)).data.qualifying).toBeGreaterThanOrEqual(1);
    expect((await t.api.patch(`/api/community/badges/${first.id}`, { rule: { type: 'posts', value: 5 } })).data.rule).toEqual({ type: 'posts', value: 5 });
    expect((await t.api.del(`/api/community/badges/${pts.id}`)).status).toBe(200);
  });
});

describe('levels that open things', () => {
  it('validates perks and files', () => {
    const levels = [{ name: 'L1', points: 0 }, { name: 'L2', points: 5 }, { name: 'L3', points: 20 }];
    expect(() => cleanPerk({ kind: 'coupon', title: 'Rabatt', body: '', level: 2 }, levels)).toThrow(/Gutscheincode/);
    expect(() => cleanPerk({ kind: 'coupon', title: 'Rabatt', body: 'mit Leerzeichen', level: 2 }, levels)).toThrow();
    expect(() => cleanPerk({ kind: 'link', title: 'Seite', body: 'http://unsicher.example', level: 2 }, levels)).toThrow(/https/);
    expect(() => cleanPerk({ kind: 'text', title: 'Tipp', body: 'Text', level: 9 }, levels)).toThrow(/Level/);
    expect(cleanPerk({ kind: 'coupon', title: 'Rabatt', body: 'DANKE20', level: 2 }, levels)).toMatchObject({ kind: 'coupon', body: 'DANKE20', level: 2 });
    expect(() => cleanRule(t.app, g, { min_level: 99 })).toThrow(/Level/);
    expect(() => cleanRule(t.app, g, { min_level: 2, tier_ids: ['fremd'] })).toThrow(/Stufen/);
  });

  it('shows perks only to members at the level, with a coupon code, a link and a download', async () => {
    const coupon = (await t.api.post(`/api/community/groups/${g.id}/perks`, { kind: 'coupon', title: '20 % auf alle Kurse', body: 'DANKE20', level: 2, note: 'Gültig bis Jahresende' })).data;
    const file = (await t.api.post(`/api/community/groups/${g.id}/perks`, { kind: 'file', title: 'Vorlage', level: 2, file: { name: 'vorlage.pdf', data: `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test').toString('base64')}` } })).data;
    expect(file).toMatchObject({ has_file: true, filename: 'vorlage.pdf' });
    expect((await t.api.post(`/api/community/groups/${g.id}/perks`, { kind: 'file', title: 'Skript', level: 2, file: { name: 'evil.html', data: Buffer.from('<script>1</script>').toString('base64') } })).status).toBe(400);
    expect((await t.api.put(`/api/community/perks/${file.id}/file`, { name: 'a.exe', data: 'AAAA' })).status).toBe(400);
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_perks WHERE kind = 'file'`)!.n).toBe(1); // the refused file left no perk behind
    // Level 1: locked, no code in the page.
    const locked = await page(`${gUrl()}/perks`, benC);
    expect(locked.status).toBe(200);
    expect(locked.html).not.toContain('DANKE20');
    expect(locked.html).toContain('Level 2');
    expect((await get(`${gUrl()}/perks/${file.id}/download`, benC)).status).toBe(404);
    // Level 2: open.
    const open = await page(`${gUrl()}/perks`, caraC);
    expect(open.html).toContain('DANKE20');
    expect(open.html).toContain('Gültig bis Jahresende');
    const dl = await get(`${gUrl()}/perks/${file.id}/download`, caraC);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('attachment');
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(dl.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await dl.arrayBuffer()).toString()).toBe('%PDF-1.4 test');
    expect((await get(`${gUrl()}/perks/${file.id}/download`, '')).status).toBe(401);
    // The side column tells Ben what opens next.
    expect((await page(gUrl(), benC)).html).toContain('Bei Level 2 öffnet sich');
    expect((await t.api.patch(`/api/community/perks/${coupon.id}`, { title: '25 % auf alle Kurse' })).data.title).toBe('25 % auf alle Kurse');
    // Level up → a notification that something opened.
    addPoints(ben, 6);
    t.app.events.emit(loc, 'community.level_reached', { contactId: ben.id, groupId: g.id, level: 2 });
    await settle();
    expect(t.app.db.get<{ text: string }>(`SELECT text FROM community_notifications WHERE contact_id = ? AND kind = 'perk'`, ben.id)!.text).toContain('Vorlage');
    expect((await t.api.del(`/api/community/perks/${file.id}`)).status).toBe(200);
  });

  it('opens a channel only from a level on, in feed, post page and posting', async () => {
    const vip = (await t.api.post(`/api/community/groups/${g.id}/channels`, { name: 'Profis' })).data;
    expect((await t.api.put(`/api/community/channels/${vip.id}/rules`, { min_level: 3 })).data).toMatchObject({ min_level: 3, tier_ids: [] });
    const rules = (await t.api.get(`/api/community/groups/${g.id}/channel-rules`)).data;
    expect(rules.find((r: any) => r.channel_id === vip.id).min_level).toBe(3);
    // A team post in the channel exists; the level-1 member can neither see nor write in it.
    const tp = (await t.api.post(`/api/community/groups/${g.id}/posts`, { title: 'Nur für Profis', body: 'geheim', channel_id: vip.id })).data;
    const asBen = await page(`${gUrl()}?ch=${vip.slug}`, annaC);
    expect(asBen.html).not.toContain('Nur für Profis');
    expect(asBen.html).toContain('Level 3');
    expect((await page(`${gUrl()}/p/${tp.id}`, annaC)).status).toBe(404);
    const w = await submit(gUrl(), `${gUrl()}/posts`, { title: 'Ich schleiche mich ein', channel_id: vip.id }, annaC);
    expect(w.status).toBe(403);
    // With the points (level 3 = 20 points) the door opens.
    addPoints(anna, 30);
    t.app.db.run('UPDATE community_members SET level = 3 WHERE group_id = ? AND contact_id = ?', g.id, anna.id);
    expect((await page(`${gUrl()}/p/${tp.id}`, annaC)).status).toBe(200);
    expect((await submit(gUrl(), `${gUrl()}/posts`, { title: 'Jetzt darf ich', channel_id: vip.id }, annaC)).status).toBe(303);
    expect((await t.api.put(`/api/community/channels/${vip.id}/rules`, { min_level: 1 })).status).toBe(200);
    expect((await t.api.get(`/api/community/groups/${g.id}/channel-rules`)).data.find((r: any) => r.channel_id === vip.id).min_level).toBe(1);
  });

  it('gives points once for a finished course', async () => {
    const before = points(ben);
    t.app.events.emit(loc, 'course.completed', { contactId: ben.id, courseId: 'kurs-1' });
    t.app.events.emit(loc, 'course.completed', { contactId: ben.id, courseId: 'kurs-1' });
    await settle();
    expect(points(ben)).toBe(before + 10);
    await putExt({ points: { course: 0 } });
    t.app.events.emit(loc, 'course.completed', { contactId: ben.id, courseId: 'kurs-2' });
    await settle();
    expect(points(ben)).toBe(before + 10);
    await putExt({ points: { course: 10 } });
  });
});

describe('monthly leaderboard', () => {
  it('counts the calendar month with the reset on, keeps the old months in an archive and tells the winners', async () => {
    const tz = 'Europe/Berlin';
    const thisMonth = monthKeyOf(new Date(), tz);
    const lastKey = shiftMonth(thisMonth, -1);
    expect(monthLabel('2026-03')).toBe('März 2026');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    const lastMonth = new Date(`${lastKey}-15T12:00:00Z`);
    const board = (period: any) => leaderboard(t.app, g.id, period, 10).map((r) => r.contact_id);
    const dora = (await t.api.post('/api/contacts', { email: 'dora@example.de', first_name: 'Dora', tags: ['mitglied'] })).data;
    await page(gUrl(), memberCookie(dora.id));
    addPoints(dora, 500, lastMonth, 'alt');
    // Rolling 30 days: Dora's points from mid last month are not in there if older than 30 days, with reset: only this month counts.
    await putExt({ leaderboard: { reset: 'monthly' } });
    expect(board('month')).not.toContain(dora.id);
    expect(boardOf(t.app, g, 'last', 10).map((r) => r.contact_id)).toEqual([dora.id]);
    expect(boardOf(t.app, g, 'all', 10)[0].contact_id).toBe(dora.id);
    const lb = await page(`${gUrl()}/leaderboard?period=last`, caraC);
    expect(lb.html).toContain('Letzter Monat');
    expect(lb.html).toContain('Dora');
    await putExt({ leaderboard: { reset: 'none' } });
    expect((await page(`${gUrl()}/leaderboard?period=last`, caraC)).html).not.toContain('Letzter Monat');
    // Archive: written once per finished month.
    await putExt({ leaderboard: { reset: 'monthly' } });
    expect(archiveMonths(t.app)).toBe(1);
    expect(archiveMonths(t.app)).toBe(0);
    const arch = (await t.api.get(`/api/community/groups/${g.id}/leaderboard/archive`)).data;
    expect(arch[0]).toMatchObject({ month: lastKey, rows: [expect.objectContaining({ rank: 1, contact_id: dora.id, points: 500 })] });
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM community_notifications WHERE contact_id = ? AND text LIKE '%Platz 1%'`, dora.id)!.n).toBe(1);
  });
});

describe('challenges', () => {
  let c: any;
  it('validates and stores a challenge with a task per day', async () => {
    expect(() => cleanChallenge(t.app, g, { title: 'X', starts_on: '2026-02-30', ends_on: '2026-03-02' })).toThrow(/Datum/);
    expect(() => cleanChallenge(t.app, g, { title: 'X', starts_on: '2026-03-05', ends_on: '2026-03-02' })).toThrow(/vor dem Start/);
    expect(() => cleanChallenge(t.app, g, { title: 'X', starts_on: '2026-01-01', ends_on: '2027-06-01' })).toThrow(/höchstens/);
    expect(() => cleanChallenge(t.app, g, { title: 'X', starts_on: '2026-01-01', ends_on: '2026-01-05', badge_id: 'fremd' })).toThrow(/Abzeichen/);
    expect(() => cleanTasks([{ day: 9, title: 'zu spät' }], 5)).toThrow(/Tag 1 bis 5/);
    expect(() => cleanTasks([{ day: 1, title: 'a' }, { day: 1, title: 'b' }], 5)).toThrow(/zwei Aufgaben/);
    const badge = (await t.api.post(`/api/community/groups/${g.id}/badges`, { name: '5-Tage-Held', emoji: '🔥' })).data;
    const r = await t.api.post(`/api/community/groups/${g.id}/challenges`, {
      title: '5 Tage Schreiben',
      description: 'Jeden Tag **ein** Absatz.',
      emoji: '✍️',
      starts_on: ymd(-2),
      ends_on: ymd(2),
      goal_days: 3,
      badge_id: badge.id,
      points_complete: 25,
      tasks: [{ day: 3, title: 'Schreibe über heute', body: 'Drei Sätze reichen.' }, { day: 1, title: 'Tag eins' }],
    });
    expect(r.status).toBe(200);
    c = r.data;
    expect(c).toMatchObject({ status: 'draft', days: 5, goal_days: 3, phase: 'running', members: 0, require_note: false });
    expect(c.tasks.map((x: any) => x.day)).toEqual([1, 3]);
    // A shorter run cuts the tasks that no longer fit.
    const up = await t.api.patch(`/api/community/challenges/${c.id}`, { ends_on: ymd(1) });
    expect(up.data.days).toBe(4);
  });

  it('keeps drafts from members and lists active ones', async () => {
    expect((await page(`${gUrl()}/challenges/${c.id}`, benC)).status).toBe(404);
    expect((await page(`${gUrl()}/challenges`, benC)).html).not.toContain('5 Tage Schreiben');
    await t.api.patch(`/api/community/challenges/${c.id}`, { status: 'active' });
    const list = await page(`${gUrl()}/challenges`, benC);
    expect(list.html).toContain('5 Tage Schreiben');
    expect(list.html).toContain('Mitmachen');
    expect((await page(gUrl(), benC)).html).toContain('Läuft gerade – mach mit!');
  });

  it('checks in once a day, with the task of the day, points and a streak', async () => {
    const detail = await page(`${gUrl()}/challenges/${c.id}`, benC);
    expect(detail.html).toContain('Schreibe über heute');
    expect(detail.html).toContain('<strong>ein</strong>');
    const before = points(ben);
    const r = await submit(`${gUrl()}/challenges/${c.id}`, `${gUrl()}/challenges/${c.id}/checkin`, { note: 'Heute habe ich <b>geschrieben</b>' }, benC);
    expect(r.status).toBe(303);
    expect(r.location).toContain('ok=checkin');
    expect(points(ben)).toBe(before + 2);
    const after = await page(`${gUrl()}/challenges/${c.id}`, benC);
    expect(after.html).toContain('Heute erledigt');
    expect(after.html).toContain('Aus der Gruppe');
    expect(after.html).not.toContain('<b>geschrieben</b>');
    // Twice on one day: friendly refusal, no extra points.
    const again = await post(`${gUrl()}/challenges/${c.id}/checkin`, [['csrf', csrfOf((await page(gUrl(), benC)).html)], ['note', '']], benC);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('heute schon eingecheckt');
    expect(points(ben)).toBe(before + 2);
    expect((await page(gUrl(), benC)).html).not.toContain('Dein Check-in für heute wartet');
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_challenge_checkins WHERE contact_id = ?`, ben.id)!.n).toBe(1);
    // The calendar of the profile counts it.
    expect([...contributions(t.app, loc, ben.id, 'Europe/Berlin').values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2);
  });

  it('completes at the goal: bonus points, badge, notification and workflow event', async () => {
    const g2 = t.app.db.get<any>('SELECT * FROM community_groups WHERE id = ?', g.id);
    const ch2 = t.app.db.get<any>('SELECT * FROM community_challenges WHERE id = ?', c.id);
    const day = (n: number) => new Date(Date.now() - n * 864e5);
    const pBefore = points(cara);
    const r1 = checkIn(t.app, g2, ch2, cara.id, '', day(2));
    expect(r1).toMatchObject({ completed: false, points: 2 });
    const r2 = checkIn(t.app, g2, ch2, cara.id, '', day(1));
    expect(r2.participant).toMatchObject({ checkins: 2, streak: 2 });
    const r3 = checkIn(t.app, g2, ch2, cara.id, '', day(0));
    expect(r3).toMatchObject({ completed: true, points: 2 + 25 });
    expect(r3.participant).toMatchObject({ checkins: 3, streak: 3, best_streak: 3 });
    await settle();
    expect(points(cara)).toBe(pBefore + 2 * 3 + 25);
    expect(events.find((e) => e.type === 'community.challenge_completed')!.data).toMatchObject({ contactId: cara.id, challenge: { title: '5 Tage Schreiben' } });
    expect(t.app.db.get(`SELECT 1 FROM community_badge_awards a JOIN community_badges b ON b.id = a.badge_id WHERE b.name = '5-Tage-Held' AND a.contact_id = ?`, cara.id)).toBeTruthy();
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM community_notifications WHERE contact_id = ? AND kind = 'challenge'`, cara.id)!.n).toBe(1);
    // More check-ins after the goal do not pay the bonus twice.
    expect(() => checkIn(t.app, g2, ch2, cara.id, '', day(0))).toThrow(/heute schon/);
    expect(dayStates(t.app, ch2, cara.id).filter((d) => d.state === 'done')).toHaveLength(3);
    const board = (await t.api.get(`/api/community/challenges/${c.id}`)).data.board;
    expect(board[0]).toMatchObject({ contact_id: cara.id, checkins: 3 });
    expect(board[1]).toMatchObject({ contact_id: ben.id, checkins: 1 });
    expect((await page(`${gUrl()}/challenges/${c.id}`, caraC)).html).toContain('#1');
  });

  it('refuses check-ins before the start, after the end, on drafts and without the required note', async () => {
    const g2 = t.app.db.get<any>('SELECT * FROM community_groups WHERE id = ?', g.id);
    const mk = async (body: any) => t.app.db.get<any>('SELECT * FROM community_challenges WHERE id = ?', (await t.api.post(`/api/community/groups/${g.id}/challenges`, { title: 'Test', ...body })).data.id);
    const future = await mk({ starts_on: ymd(5), ends_on: ymd(9), status: 'active' });
    const over = await mk({ starts_on: ymd(-9), ends_on: ymd(-5), status: 'active' });
    const draft = await mk({ starts_on: ymd(-1), ends_on: ymd(3) });
    const note = await mk({ starts_on: ymd(-1), ends_on: ymd(3), status: 'active', require_note: true });
    expect(() => checkIn(t.app, g2, future, ben.id, '')).toThrow(/noch nicht begonnen/);
    expect(() => checkIn(t.app, g2, over, ben.id, '')).toThrow(/vorbei/);
    expect(() => checkIn(t.app, g2, draft, ben.id, '')).toThrow(/nicht geöffnet/);
    expect(() => checkIn(t.app, g2, note, ben.id, ' ')).toThrow(/gemacht/);
    expect(checkIn(t.app, g2, note, ben.id, 'Zehn Minuten gelesen').checkin.note).toBe('Zehn Minuten gelesen');
    const upcoming = await page(`${gUrl()}/challenges`, benC);
    expect(upcoming.html).toContain('Startet bald');
    expect(upcoming.html).toContain('Beendet');
  });

  it('reminds people who have not checked in yet, once a day', async () => {
    const g2 = t.app.db.get<any>('SELECT * FROM community_groups WHERE id = ?', g.id);
    const ch2 = t.app.db.get<any>('SELECT * FROM community_challenges WHERE id = ?', c.id);
    const anna2 = (await t.api.post('/api/contacts', { email: 'anna2@example.de', first_name: 'Anna', tags: ['mitglied'] })).data;
    await page(gUrl(), memberCookie(anna2.id));
    t.app.db.run('INSERT INTO community_challenge_members (challenge_id, contact_id, location_id, joined_at, checkins, streak, best_streak, last_day) VALUES (?, ?, ?, ?, 0, 0, 0, ?)', ch2.id, anna2.id, loc, new Date().toISOString(), '');
    const today = todayOf(t.app, loc);
    expect(sendReminders(t.app, zonedToUtc(today, '03:00', 'Europe/Berlin'))).toBe(0); // before 18:00 local
    const evening = zonedToUtc(today, '19:00', 'Europe/Berlin');
    const sent = sendReminders(t.app, evening);
    expect(sent).toBeGreaterThanOrEqual(1); // Anna #2 (and everybody else who is in but did not check in today)
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM community_notifications WHERE contact_id = ? AND kind = 'challenge'`, anna2.id)!.n).toBe(1);
    expect(sendReminders(t.app, evening)).toBe(0);
    // Ben already checked in today: no reminder for him.
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM community_notifications WHERE contact_id = ? AND kind = 'challenge' AND text LIKE '%wartet%'`, ben.id)!.n).toBe(0);
    void g2;
  });

  it('is isolated per group and sub-account', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data;
    expect((await t.api.raw(`/portal/${other.id}/community/g/${g.slug}/challenges`, { redirect: 'manual', headers: { cookie: benC } })).status).toBeGreaterThanOrEqual(401);
    const oc = await t.api.get(`/api/community/challenges/${c.id}`, { 'x-location-id': other.id });
    expect(oc.status).toBe(404);
    expect((await t.api.del(`/api/community/challenges/${c.id}`)).status).toBe(200);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM community_challenge_checkins WHERE challenge_id = ?', c.id)!.n).toBe(0);
  });
});

describe('live calls', () => {
  let ev: any;
  const mkEvent = async (startMin: number, lengthMin = 60) => (await t.api.post(`/api/community/groups/${g.id}/events`, { title: 'Fragerunde', description: 'Ihr fragt, ich antworte.', starts_at: new Date(Date.now() + startMin * 60_000).toISOString(), ends_at: new Date(Date.now() + (startMin + lengthMin) * 60_000).toISOString() })).data;

  it('works out the room, the server and the phases', async () => {
    expect(roomName('Fragerunde: Q&A!')).toMatch(/^fragerundeqa-[a-z0-9]{10}$/);
    expect(roomName('Fragerunde')).not.toBe(roomName('Fragerunde'));
    expect(jitsiBase(t.app, g)).toBe('https://meet.jit.si');
    process.env.PGHL_JITSI_URL = 'https://meet.selbst.example/';
    expect(jitsiBase(t.app, g)).toBe('https://meet.selbst.example');
    await putExt({ live: { jitsi_url: 'https://jitsi.firma.example' } });
    expect(jitsiBase(t.app, g)).toBe('https://jitsi.firma.example');
    expect((await putExt({ live: { jitsi_url: 'http://unsicher.example' } })).status).toBe(400);
    await putExt({ live: { jitsi_url: '' } });
    delete process.env.PGHL_JITSI_URL;
    const now = Date.now();
    const e = (s: number, l: number) => ({ starts_at: new Date(now + s * 6e4).toISOString(), ends_at: new Date(now + (s + l) * 6e4).toISOString() });
    expect(phaseOf(e(60, 60))).toBe('before');
    expect(phaseOf(e(OPEN_BEFORE_MIN - 1, 60))).toBe('on');
    expect(phaseOf(e(-30, 60))).toBe('on');
    expect(phaseOf(e(-600, 60))).toBe('after');
    expect(jitsiUrl('https://meet.jit.si', 'raum-1', 'Titel "x"', 'Anna')).toBe('https://meet.jit.si/raum-1#config.subject=%22Titel%20%5C%22x%5C%22%22&userInfo.displayName=%22Anna%22&config.disableDeepLinking=true');
  });

  it('turns an event into a live call and keeps the room private until it opens', async () => {
    ev = await mkEvent(120);
    const on = await t.api.put(`/api/community/events/${ev.id}/live`, { enabled: true });
    expect(on.data).toMatchObject({ live: true, jitsi_server: 'https://meet.jit.si' });
    expect(on.data.join_url).toContain(`/community/g/${g.slug}/live/${ev.id}`);
    expect(t.app.db.get<{ link: string }>('SELECT link FROM community_events WHERE id = ?', ev.id)!.link).toBe(on.data.join_url);
    const room = t.app.db.get<{ room: string }>('SELECT room FROM community_event_ext WHERE event_id = ?', ev.id)!.room;
    const early = await page(`${gUrl()}/live/${ev.id}`, benC);
    expect(early.status).toBe(200);
    expect(early.html).not.toContain(room);
    expect(early.html).not.toContain('<iframe');
    expect(early.html).toContain('Der Raum öffnet');
    // Joining before the time does nothing.
    const r = await submit(gUrl(), `${gUrl()}/live/${ev.id}/join`, {}, benC);
    expect(r.status).toBe(303);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM community_event_attendance WHERE event_id = ?', ev.id)!.n).toBe(0);
    expect((await page(`${gUrl()}/live/${ev.id}?in=1`, benC)).html).not.toContain('<iframe');
    expect((await page(`${gUrl()}/live/unbekannt`, benC)).status).toBe(404);
    expect((await page(`${gUrl()}/live/${ev.id}`, '')).status).toBe(401);
    // Switched off again: the event link is gone and the page too.
    const off = await t.api.put(`/api/community/events/${ev.id}/live`, { enabled: false });
    expect(off.data.live).toBe(false);
    expect(t.app.db.get<{ link: string }>('SELECT link FROM community_events WHERE id = ?', ev.id)!.link).toBe('');
    expect((await page(`${gUrl()}/live/${ev.id}`, benC)).status).toBe(404);
  });

  it('lets members into the room while the call is on and counts attendance once', async () => {
    ev = await mkEvent(-10, 50);
    await t.api.put(`/api/community/events/${ev.id}/live`, { enabled: true });
    const room = t.app.db.get<{ room: string }>('SELECT room FROM community_event_ext WHERE event_id = ?', ev.id)!.room;
    const card = await page(`${gUrl()}/live/${ev.id}`, benC);
    expect(card.html).toContain('Der Call läuft');
    expect(card.html).toContain('Jetzt beitreten');
    expect(card.html).not.toContain(room);
    expect((await page(gUrl(), benC)).html).toContain('Live jetzt: Fragerunde');
    // The room only loads after joining (and a direct ?in=1 without attendance shows the card).
    expect((await page(`${gUrl()}/live/${ev.id}?in=1`, benC)).html).not.toContain('<iframe');
    const before = points(ben);
    const j = await submit(`${gUrl()}/live/${ev.id}`, `${gUrl()}/live/${ev.id}/join`, {}, benC);
    expect(j.status).toBe(303);
    expect(j.location).toContain('?in=1');
    const inside = await page(`${gUrl()}/live/${ev.id}?in=1`, benC);
    expect(inside.html).toContain(`src="https://meet.jit.si/${room}#`);
    expect(inside.html).toContain('allow="camera; microphone');
    expect(inside.headers.get('content-security-policy')).toContain('frame-src https://meet.jit.si');
    expect(inside.headers.get('permissions-policy')).toContain('camera=(self "https://meet.jit.si")');
    expect(inside.html).toContain('Ben'); // display name in the room link
    await submit(`${gUrl()}/live/${ev.id}`, `${gUrl()}/live/${ev.id}/join`, {}, benC);
    expect(points(ben)).toBe(before + 5);
    await settle();
    expect(events.filter((e) => e.type === 'community.event_attended').map((e) => e.data.contactId)).toEqual([ben.id]);
    expect((await t.api.get(`/api/community/events/${ev.id}/attendance`)).data).toEqual([expect.objectContaining({ contact_id: ben.id, name: 'Ben' })]);
    expect((await t.api.get(`/api/community/groups/${g.id}/live`)).data.find((x: any) => x.event_id === ev.id)).toMatchObject({ live: true, attendees: 1 });
    // A badge by rule for attending.
    const badge = (await t.api.post(`/api/community/groups/${g.id}/badges`, { name: 'Live dabei', rule: { type: 'events', value: 1 } })).data;
    await t.api.post(`/api/community/groups/${g.id}/badges/evaluate`);
    expect(t.app.db.get('SELECT 1 FROM community_badge_awards WHERE badge_id = ? AND contact_id = ?', badge.id, ben.id)).toBeTruthy();
    // Another Jitsi server of the group shows up in the frame rules.
    await putExt({ live: { jitsi_url: 'https://jitsi.firma.example' } });
    await submit(`${gUrl()}/live/${ev.id}`, `${gUrl()}/live/${ev.id}/join`, {}, caraC);
    const own = await page(`${gUrl()}/live/${ev.id}?in=1`, caraC);
    expect(own.html).toContain(`src="https://jitsi.firma.example/${room}#`);
    expect(own.headers.get('content-security-policy')).toContain('frame-src https://jitsi.firma.example');
    await putExt({ live: { jitsi_url: '' } });
  });

  it('reminds members shortly before a call and attaches the recording as a post afterwards', async () => {
    const soon = await mkEvent(10, 30);
    await t.api.put(`/api/community/events/${soon.id}/live`, { enabled: true });
    await t.app.tick();
    await settle();
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_notifications WHERE kind = 'event' AND text LIKE '%Gleich geht%' AND contact_id = ?`, ben.id)!.n).toBe(1);
    await t.app.tick();
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_notifications WHERE kind = 'event' AND text LIKE '%Gleich geht%' AND contact_id = ?`, ben.id)!.n).toBe(1);

    expect((await t.api.post(`/api/community/events/${ev.id}/recording`, {})).status).toBe(400);
    expect((await t.api.post(`/api/community/events/${ev.id}/recording`, { video_url: 'https://evil.example/v.mp4x' })).status).toBe(400);
    const rec = await t.api.post(`/api/community/events/${ev.id}/recording`, { video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', notify: false });
    expect(rec.status).toBe(200);
    expect(t.app.db.get<{ title: string }>('SELECT title FROM community_posts WHERE id = ?', rec.data.post_id)!.title).toBe('Aufzeichnung: Fragerunde');
    expect(t.app.db.get<{ video: string }>('SELECT video FROM community_post_ext WHERE post_id = ?', rec.data.post_id)!.video).toContain('dQw4w9WgXcQ');
    // After the call the page leads to the recording.
    t.app.db.run('UPDATE community_events SET starts_at = ?, ends_at = ? WHERE id = ?', new Date(Date.now() - 20 * 36e5).toISOString(), new Date(Date.now() - 19 * 36e5).toISOString(), ev.id);
    const after = await page(`${gUrl()}/live/${ev.id}`, benC);
    expect(after.html).toContain('Aufzeichnung ansehen');
    expect(after.html).toContain(`/p/${rec.data.post_id}`);
    expect((await submit(gUrl(), `${gUrl()}/live/${ev.id}/join`, {}, benC)).status).toBe(303);
  });
});
