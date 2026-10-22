import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { setPostizFetch } from '../server/services/postiz.js';
import { render } from '../server/core/template.js';
import { applyConditions, testCondition } from '../server/services/template-conditions.js';
import { cleanSlots, nextSlot } from '../server/modules/social-queues.js';

/** A tiny fake Postiz (see tests/social.test.ts). */
const posted: any[] = [];
const fake = (async (input: any, init: any = {}) => {
  const u = new URL(String(input));
  const path = u.pathname.replace('/api/public/v1', '');
  const body = init.body ? JSON.parse(init.body) : undefined;
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (path === '/is-connected') return json({ connected: true });
  if (path === '/integrations') return json([{ id: 'int-x', name: 'Firma X', identifier: 'x', picture: '', disabled: false, profile: 'x' }]);
  if (path === '/posts' && init.method === 'POST') {
    posted.push(body);
    return json(body.posts.map((p: any, i: number) => ({ postId: `p${posted.length}-${i}`, integration: p.integration.id })));
  }
  if (path === '/posts') return json({ posts: [] });
  return json({});
}) as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  setPostizFetch(fake);
  t = await startTestApp();
  await t.setup();
});
afterAll(() => t.close());

const connectPostiz = async () => {
  await t.api.patch('/api/agency/social', { url: 'https://postiz.test', api_key: 'k' });
  await t.api.put('/api/agency/social/channels/int-x', { location_id: t.api.location });
};

describe('client approval of social posts', () => {
  it('one magic link for several posts; approve schedules, changes keep the note; expired/unknown links show nothing', async () => {
    const future = new Date(Date.now() + 3 * 864e5).toISOString();
    const r = await t.api.post('/api/social-approvals', { title: 'Oktober', posts: [{ content: 'Post A <b>', integration_ids: ['int-x'], date: future }, { content: 'Post B', integration_ids: ['int-x'], date: future }] });
    expect(r.status).toBe(200);
    expect(r.data.approvals).toHaveLength(2);
    const token = r.data.url.split('/social-review/')[1];
    const page = await t.api.raw(`/social-review/${token}`);
    const html = await page.text();
    expect(html).toContain('Post A &lt;b&gt;');
    expect(html).toContain('Freigeben');
    expect((await t.api.raw('/social-review/falsch')).status).toBe(404);

    // Without the planner connected: approved, with the reason kept.
    const [a, b] = r.data.approvals;
    const decide = (aid: string, decision: string, note = '') =>
      t.api.raw(`/social-review/${token}/${aid}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ decision, note }).toString() });
    expect(await (await decide(a.id, 'approved')).text()).toContain('freigegeben');
    let list = (await t.api.get('/api/social-approvals')).data;
    const ra = list.find((x: any) => x.id === a.id);
    expect(ra.status).toBe('approved');
    expect(ra.error).not.toBe('');
    // A second decision is refused.
    expect(await (await decide(a.id, 'rejected')).text()).toContain('schon entschieden');

    // With the planner: "Einplanen" hands it over.
    await connectPostiz();
    const s = await t.api.post(`/api/social-approvals/${a.id}/schedule`);
    expect(s.data.status).toBe('scheduled');
    expect(posted.at(-1).type).toBe('schedule');
    expect(posted.at(-1).posts[0].value[0].content).toBe('Post A <b>');

    await decide(b.id, 'changes', 'Bitte mit Emoji');
    list = (await t.api.get('/api/social-approvals')).data;
    expect(list.find((x: any) => x.id === b.id)).toMatchObject({ status: 'changes', note: 'Bitte mit Emoji' });
    // After changes the client may still approve; then it goes straight to the planner.
    await decide(b.id, 'approved');
    expect((await t.api.get('/api/social-approvals')).data.find((x: any) => x.id === b.id).status).toBe('scheduled');
    expect((await t.api.del(`/api/social-approvals/${b.id}`)).status).toBe(200);
    expect((t.app.services.mcpTools as any[]).some((x) => x.name === 'ghl_social_approval_create')).toBe(true);
  });
});

describe('evergreen queues', () => {
  it('computes the next slot in the sub-account zone', () => {
    const slots = cleanSlots([{ day: 'mon', time: '09:00' }, { day: 'thu', time: '18:30' }, { day: 'xx', time: '1' }, { day: 'mon', time: '09:00' }]);
    expect(slots).toEqual([{ day: 'mon', time: '09:00' }, { day: 'thu', time: '18:30' }]);
    // Wed 2026-10-21 12:00 Berlin (10:00 UTC) → Thu 18:30 Berlin = 16:30 UTC.
    expect(nextSlot(slots, new Date('2026-10-21T10:00:00Z'), 'Europe/Berlin')!.toISOString()).toBe('2026-10-22T16:30:00.000Z');
    // Thu after 18:30 → next Monday 09:00 (winter time from 25 Oct: UTC+1).
    expect(nextSlot(slots, new Date('2026-10-22T17:00:00Z'), 'Europe/Berlin')!.toISOString()).toBe('2026-10-26T08:00:00.000Z');
    expect(nextSlot([], new Date(), 'Europe/Berlin')).toBeNull();
  });
  it('rotates the least used post, recycles or pauses, and runs from the scheduler', async () => {
    const q = (await t.api.post('/api/social-queues', { name: 'Tipps', integration_ids: ['int-x'], slots: [{ day: 'mon', time: '09:00' }] })).data;
    expect((await t.api.patch(`/api/social-queues/${q.id}`, { active: true })).status).toBe(400);
    await t.api.post(`/api/social-queues/${q.id}/items`, { items: [{ content: 'Tipp 1' }, { content: 'Tipp 2' }] });
    const on = await t.api.patch(`/api/social-queues/${q.id}`, { active: true, recycle: false });
    expect(on.data.active).toBe(true);
    expect(on.data.next_at).toBeTruthy();
    const preview = (await t.api.get(`/api/social-queues/${q.id}/preview`)).data;
    expect(preview.slice(0, 3).map((p: any) => p.content)).toEqual(['Tipp 1', 'Tipp 2', '']);
    const before = posted.length;
    const r1 = await t.api.post(`/api/social-queues/${q.id}/run`);
    expect(r1.data.ok).toBe(true);
    expect(posted.at(-1).posts[0].value[0].content).toBe('Tipp 1');
    expect(posted.at(-1).type).toBe('now');
    // Due now: the scheduler posts the next one.
    t.app.db.run('UPDATE social_queues SET next_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), q.id);
    await t.app.services.socialQueues.run(q.id);
    expect(posted.at(-1).posts[0].value[0].content).toBe('Tipp 2');
    expect(posted.length).toBe(before + 2);
    // Without recycling and all used: paused.
    const r3 = await t.app.services.socialQueues.run(q.id);
    expect(r3.ok).toBe(false);
    const after = (await t.api.get('/api/social-queues')).data.find((x: any) => x.id === q.id);
    expect(after.active).toBe(false);
    expect(after.runs.length).toBe(3);
    // With recycling it starts over.
    await t.api.patch(`/api/social-queues/${q.id}`, { recycle: true, active: true });
    expect((await t.api.post(`/api/social-queues/${q.id}/run`)).data.ok).toBe(true);
    expect((t.app.services.mcpTools as any[]).some((x) => x.name === 'ghl_social_queue_add')).toBe(true);
  });
});

describe('agency announcements', () => {
  it('shows active banners to the targeted sub-accounts until dismissed', async () => {
    expect((await t.api.post('/api/agency/banners', { title: 'X', link_url: 'javascript:alert(1)' })).status).toBe(400);
    const b = (await t.api.post('/api/agency/banners', { title: 'Wartung heute 22 Uhr', message: 'Kurz nicht erreichbar.', tone: 'warning', link_url: 'https://status.example.de' })).data;
    const other = (await t.api.post('/api/agency/banners', { title: 'Nur für andere', location_ids: ['gibt-es-nicht'] })).data;
    const later = (await t.api.post('/api/agency/banners', { title: 'Später', starts_at: new Date(Date.now() + 864e5).toISOString() })).data;
    const active = (await t.api.get('/api/agency-banners/active')).data;
    expect(active.map((x: any) => x.id)).toEqual([b.id]);
    expect(active[0]).toMatchObject({ tone: 'warning', link_url: 'https://status.example.de', dismissible: true });
    expect((await t.api.post(`/api/agency-banners/${b.id}/dismiss`)).status).toBe(200);
    expect((await t.api.get('/api/agency-banners/active')).data).toEqual([]);
    expect((await t.api.patch(`/api/agency/banners/${b.id}`, { ends_at: new Date(Date.now() - 864e5).toISOString(), starts_at: new Date().toISOString() })).status).toBe(400);
    for (const x of [b, other, later]) expect((await t.api.del(`/api/agency/banners/${x.id}`)).status).toBe(200);
  });
});

describe('own roles', () => {
  it('assigns areas, enforces read-only areas, follows role changes and lets go on manual edits', async () => {
    const tpl = (await t.api.post('/api/role-templates', { preset: 'assistant', name: 'Assistenz' })).data;
    expect(tpl.permissions).toEqual(expect.arrayContaining(['contacts', 'calendars']));
    expect(tpl.readonly).toContain('contacts');
    const user = (await t.api.post('/api/users', { email: 'assi@example.com', password: 'geheim12345', name: 'Assi', locations: [t.api.location] })).data;
    expect((await t.api.post(`/api/role-templates/${tpl.id}/assign`, { user_ids: [user.id] })).data.assigned).toBe(1);
    const rows = (await t.api.get('/api/role-templates')).data;
    expect(rows.assignments[user.id]).toBe(tpl.id);
    expect(rows.templates[0].users).toBe(1);

    // Log in as the member.
    const admin = t.api.cookie;
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'assi@example.com', password: 'geheim12345' })).status).toBe(200);
    expect((await t.api.get('/api/contacts')).status).toBe(200);
    const w = await t.api.post('/api/contacts', { first_name: 'Neu' });
    expect(w.status).toBe(403);
    expect(w.data.error).toContain('Nur Lesezugriff');
    expect((await t.api.get('/api/funnels')).status).toBe(403);
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);

    // Changing the role updates the member; contacts become writable.
    await t.api.patch(`/api/role-templates/${tpl.id}`, { permissions: ['dashboard', 'contacts', 'funnels'], readonly: [] });
    const u1 = (await t.api.get('/api/users')).data.find((u: any) => u.id === user.id);
    expect(u1.permissions.sort()).toEqual(['contacts', 'dashboard', 'funnels']);
    // A manual edit takes the member out of the role.
    await t.api.patch(`/api/users/${user.id}`, { permissions: ['contacts'] });
    expect((await t.api.get('/api/role-templates')).data.assignments[user.id]).toBeUndefined();
    expect((await t.api.del(`/api/role-templates/${tpl.id}`)).status).toBe(200);
    expect(admin).toBeTruthy();
  });
});

describe('conditional content', () => {
  const data = { contact: { first_name: 'Anna', city: 'Köln', tags: ['VIP', 'Kunde'], custom: { budget: '7500' }, phone: '' } };
  it('evaluates conditions', () => {
    expect(testCondition('contact.tags has "vip"', data)).toBe(true);
    expect(testCondition('contact.tags has &quot;Neu&quot;', data)).toBe(false);
    expect(testCondition('contact.city == köln', data)).toBe(true);
    expect(testCondition('contact.city != "Köln"', data)).toBe(false);
    expect(testCondition('contact.custom.budget >= 5000', data)).toBe(true);
    expect(testCondition('contact.custom.budget < 5000', data)).toBe(false);
    expect(testCondition('contact.phone', data)).toBe(false);
    expect(testCondition('not contact.phone', data)).toBe(true);
    expect(testCondition('contact.first_name enthält "nn"', data)).toBe(true);
  });
  it('renders blocks with else, unless and nesting through the merge-field engine', () => {
    const tpl = 'Hallo {{contact.first_name}}! {{#if contact.tags has "VIP"}}VIP{{#if contact.city == "Berlin"}} Berlin{{else}} {{contact.city}}{{/if}}{{else}}Standard{{/if}}.{{#unless contact.phone}} Bitte Telefon nachtragen.{{/unless}}';
    expect(render(tpl, data)).toBe('Hallo Anna! VIP Köln. Bitte Telefon nachtragen.');
    expect(render(tpl, { contact: { first_name: 'Ben', tags: [], phone: '0151' } })).toBe('Hallo Ben! Standard.');
    // Broken markup stays as it is.
    expect(applyConditions('A {{#if x}} B', {})).toBe('A {{#if x}} B');
  });
});

describe('own wording for system mails', () => {
  it('lists the mails, refuses a text without the link and sends the agency version', async () => {
    const list = (await t.api.get('/api/agency/system-mails')).data;
    expect(list.map((m: any) => m.key)).toEqual(['invite', 'magic_login', 'saas_welcome', 'saas_new_account']);
    expect((await t.api.put('/api/agency/system-mails/magic_login', { subject: 'Hi', body: 'Ohne Link' })).status).toBe(400);
    expect((await t.api.put('/api/agency/system-mails/magic_login', { subject: 'Login bei {{brand.name}}', body: 'Moin {{user.name|du}}! Klick: {{link}}' })).status).toBe(200);
    const mails: any[] = [];
    t.app.services.authMailer = async (_loc: unknown, mail: any) => (mails.push(mail), { status: 'sent' });
    await t.api.put('/api/agency/login', { magic_link: true });
    const r = await t.api.raw('/api/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'chef@example.com' }) });
    expect(r.status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toMatch(/^Login bei /);
    expect(mails[0].text).toMatch(/^Moin Chef! Klick: http:\/\/localhost\/app\/\?magic=/);
    // Back to the built-in text.
    await t.api.del('/api/agency/system-mails/magic_login');
    const fallback = t.app.services.systemMail('magic_login', { subject: 'S', text: 'T' }, { link: 'x' });
    expect(fallback).toEqual({ subject: 'S', text: 'T' });
  });
});

describe('review requests in bulk and reminders', () => {
  it('sends to everyone with a tag, skips missing addresses and recent ones, and reminds once', async () => {
    const mk = (b: any) => t.api.post('/api/contacts', { ...b, tags: ['bewerten'] });
    const a = (await mk({ first_name: 'A', email: 'rq-a@example.com' })).data;
    const b = (await mk({ first_name: 'B', phone: '+49 151 1112223' })).data;
    const c = (await mk({ first_name: 'C', email: 'rq-c@example.com' })).data;
    expect((await t.api.post('/api/reviews/request', { contact_id: c.id })).status).toBe(200);
    const r = (await t.api.post('/api/reviews/request/bulk', { tag: 'bewerten', channel: 'email' })).data;
    expect(r.sent).toBe(1);
    expect(r.skipped.map((s: any) => [s.contact_id, s.reason.split(' ')[0]])).toEqual(expect.arrayContaining([[b.id, 'Keine'], [c.id, 'Schon']]));
    expect((await t.api.post('/api/reviews/request/bulk', {})).status).toBe(400);
    // Reminder after 3 days for the unanswered request of A.
    expect((await t.api.put('/api/reviews/request-settings', { followup_days: 3, skip_days: 90 })).data).toEqual({ followup_days: 3, skip_days: 90 });
    t.app.db.run("UPDATE review_requests SET created_at = ? WHERE contact_id = ?", new Date(Date.now() - 4 * 864e5).toISOString(), a.id);
    expect(await t.app.services.reviewFollowups()).toBe(1);
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_requests WHERE contact_id = ?', a.id)!.n).toBe(2);
    // Only once.
    expect(await t.app.services.reviewFollowups()).toBe(0);
  });
});
