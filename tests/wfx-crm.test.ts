import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextWeighted } from '../server/modules/wfx-crm.js';
import { contactOf, newApp, readRun, results, runWorkflow, type T } from './wfx-helpers.js';

/** CRM and business steps end to end (no outside services: mail and SMS are "nur speichern" in tests). */

let t: T;
let loc = '';
beforeAll(async () => {
  t = await newApp();
  loc = t.api.location;
});
afterAll(() => t.close());
const set = (name: string, value: string) => ({ type: 'set_variable', rows: [{ name, value }] });

describe('deal, task, appointment', () => {
  it('changes the deal of the contact (value modes, stage, status) or creates one', async () => {
    const pipe = (await t.api.post('/api/pipelines', { name: 'Verkauf', stages: ['Neu', 'Angebot', 'Verhandlung'] })).data;
    const c = (await t.api.post('/api/contacts', { first_name: 'Dana', email: 'dana-upd@example.com' })).data;
    const deal = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: c.id, name: 'Relaunch', value: 1000 })).data;
    const wf = (await t.api.post('/api/workflows', {
      name: 'deal',
      trigger: { type: 'manual', config: {} },
      steps: [
        { type: 'update_opportunity', pipeline_id: pipe.id, value: '500', value_mode: 'add', stage_id: pipe.stages[1].id },
        { type: 'update_opportunity', value: '1,5', value_mode: 'multiply', name: 'Relaunch 2026' },
        { type: 'update_opportunity', status: 'won' },
        { type: 'update_opportunity', if_missing: 'create', pipeline_id: pipe.id, name: 'Folgeauftrag', value: '250' },
        { type: 'update_opportunity', if_missing: 'error', pipeline_id: 'nope-pipe', value: '1' },
      ],
    })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [c.id] });
    const o = t.app.db.get('SELECT * FROM opportunities WHERE id = ?', deal.id)!;
    expect(o).toMatchObject({ value: 2250, name: 'Relaunch 2026', status: 'won', stage_id: pipe.stages[1].id });
    const follow = t.app.db.get(`SELECT * FROM opportunities WHERE contact_id = ? AND name = 'Folgeauftrag'`, c.id)!;
    expect(follow.value).toBe(250);
    expect(results(readRun(t, wf.id).log).at(-1)).toMatch(/Kein Deal gefunden/);
  });

  it('completes, reopens and updates tasks and announces completed ones', async () => {
    const done: any[] = [];
    t.app.events.on('task.completed', (e) => void done.push(e.data));
    const c = (await t.api.post('/api/contacts', { first_name: 'Tom', email: 'tom-task@example.com' })).data;
    await t.api.post('/api/tasks', { contact_id: c.id, title: 'Angebot nachfassen' });
    await t.api.post('/api/tasks', { contact_id: c.id, title: 'Rechnung prüfen' });
    const wf = (await t.api.post('/api/workflows', { name: 'tasks', trigger: { type: 'manual', config: {} }, steps: [{ type: 'update_task', match: 'title', title_contains: 'angebot', action: 'complete' }, { type: 'update_task', match: 'open', action: 'update', new_title: 'Neu: {{contact.first_name}}', due_in_days: 2 }, { type: 'update_task', match: 'title', title_contains: 'nope', action: 'complete' }, { type: 'update_task', match: 'title', title_contains: 'angebot', action: 'reopen' }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [c.id] });
    await t.app.events.flush();
    const tasks = t.app.db.all('SELECT title, done FROM tasks WHERE contact_id = ? ORDER BY created_at', c.id);
    expect(tasks.map((x: any) => [x.title, x.done])).toEqual([['Angebot nachfassen', 0], ['Neu: Tom', 0]]);
    expect(done).toHaveLength(1);
    expect(results(readRun(t, wf.id).log)[2]).toBe('Keine passende Aufgabe');
  });

  it('books, reschedules and cancels appointments', async () => {
    const cal = (await t.api.post('/api/calendars', { name: 'Erstgespräch', duration: 30 })).data;
    const status: string[] = [];
    t.app.events.on('appointment.status_changed', (e) => void status.push(e.data.status));
    const c = (await t.api.post('/api/contacts', { first_name: 'Ada', email: 'ada-appt@example.com' })).data;
    const wf = (await t.api.post('/api/workflows', {
      name: 'termin',
      trigger: { type: 'manual', config: {} },
      steps: [
        { type: 'create_appointment', calendar_id: cal.id, when: 'at', date: '2026-12-01 14:00', notes: 'Von Workflow' },
        { type: 'update_appointment', which: 'next', action: 'reschedule', new_when: 'at', new_date: '2026-12-02 10:30' },
        { type: 'update_appointment', which: 'id', appointment_id: '{{var.appointment_id}}', action: 'confirmed' },
        { type: 'update_appointment', which: 'next', action: 'cancelled' },
        { type: 'update_appointment', which: 'next', action: 'cancelled' },
      ],
    })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [c.id] });
    await t.app.events.flush();
    const a = t.app.db.get('SELECT * FROM appointments WHERE contact_id = ?', c.id)!;
    expect(a.status).toBe('cancelled');
    expect(a.start_at).toBe('2026-12-02T09:30:00.000Z'); // 10:30 Berlin (CET)
    expect(a.notes).toBe('Von Workflow');
    expect(a.source).toBe('Workflow');
    expect(status).toContain('cancelled');
    const log = results(readRun(t, wf.id).log);
    expect(log[0]).toContain('Termin gebucht: 2026-12-01T13:00:00.000Z');
    expect(log[4]).toBe('Kein passender Termin');
  });
});

describe('DND per channel and tags with conditions', () => {
  it('blocks single channels and keeps the others working', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Dora', email: 'dora@example.com', phone: '+4915112345678' })).data;
    const wf = (await t.api.post('/api/workflows', { name: 'dnd', trigger: { type: 'manual', config: {} }, steps: [{ type: 'update_dnd', value: 'on', channels: ['sms'] }, { type: 'send_sms', body: 'hallo' }, { type: 'send_email', subject: 'Hi', body: 'Hallo' }, { type: 'update_dnd', value: 'off', channels: ['sms'] }, { type: 'send_sms', body: 'wieder' }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [c.id] });
    const log = results(readRun(t, wf.id).log);
    expect(log[1]).toContain('„Nicht stören“ für SMS aktiv');
    expect(['sent', 'logged']).toContain(log[2]);
    expect(['sent', 'logged']).toContain(log[4]);
    // all channels
    const all = await runWorkflow(t, [{ type: 'update_dnd', value: 'on', channels: ['all'] }, { type: 'send_email', subject: 'x', body: 'y' }], { contact: { email: 'dnd-all@example.com' } });
    expect(contactOf(t, all.contact.id).dnd).toBe(1);
    expect(results(all.log)[1]).toContain('Nicht stören');
    expect(results((await runWorkflow(t, [{ type: 'update_dnd', channels: ['pigeon'] }])).log)[0]).toMatch(/Kein gültiger Kanal/);
  });

  it('tags depending on a condition or expression', async () => {
    const a = await runWorkflow(t, [{ type: 'tag_if', expression: 'number(contact.custom.budget) > 1000', add: ['vip'], else_add: ['standard'], remove: ['neu'] }], { contact: { tags: ['neu'], custom: { budget: '2000' } } });
    expect(contactOf(t, a.contact.id).tags.sort()).toEqual(['vip']);
    const b = await runWorkflow(t, [{ type: 'tag_if', conditions: [{ field: 'city', op: 'equals', value: 'Köln' }], add: ['köln'], else_add: ['woanders'], else_remove: ['neu'] }], { contact: { tags: ['neu'], city: 'Bonn' } });
    expect(contactOf(t, b.contact.id).tags.sort()).toEqual(['woanders']);
  });
});

describe('assigning users (round robin with weights)', () => {
  it('spreads picks by weight with the smooth algorithm', async () => {
    const a = (await t.api.post('/api/users', { email: 'rr-a@example.com', password: 'passwort-rra', name: 'A', locations: [loc] })).data.id;
    const b = (await t.api.post('/api/users', { email: 'rr-b@example.com', password: 'passwort-rrb', name: 'B', locations: [loc] })).data.id;
    const picks: string[] = [];
    for (let i = 0; i < 12; i++) picks.push(nextWeighted(t.app, loc, 'test-key', [{ id: a, weight: 3 }, { id: b, weight: 1 }])!);
    expect(picks.filter((p) => p === a)).toHaveLength(9);
    expect(picks.filter((p) => p === b)).toHaveLength(3);
    // smooth: never four of the same in a row
    expect(picks.map((p) => (p === a ? 'a' : 'b')).join('').includes('aaaa')).toBe(false);
    expect(nextWeighted(t.app, loc, 'none', [{ id: a, weight: 0 }])).toBeNull();
  });

  it('assigns contacts and deals to team members, honouring weights and existing owners', async () => {
    const m1 = (await t.api.post('/api/users', { email: 'm1@example.com', password: 'passwort-m1', name: 'Mia', locations: [loc] })).data;
    const m2 = (await t.api.post('/api/users', { email: 'm2@example.com', password: 'passwort-m2', name: 'Max', locations: [loc] })).data;
    const steps = [{ id: 'rr', type: 'assign_user', target: 'contact', rows: [{ user_id: m1.id, weight: 2 }, { user_id: m2.id, weight: 1 }] }];
    const wf = (await t.api.post('/api/workflows', { name: 'rr', trigger: { type: 'manual', config: {} }, steps })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const owners: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = (await t.api.post('/api/contacts', { first_name: `L${i}`, email: `rr${i}@example.com` })).data;
      await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [c.id] });
      owners.push(contactOf(t, c.id).assigned_to);
    }
    expect(owners.filter((o) => o === m1.id)).toHaveLength(4);
    expect(owners.filter((o) => o === m2.id)).toHaveLength(2);
    // everyone of the team when no rows are given; skip when assigned
    const pipe = (await t.api.post('/api/pipelines', { name: 'RR', stages: ['Neu'] })).data;
    const c = (await t.api.post('/api/contacts', { first_name: 'Rita', email: 'rita-rr@example.com', assigned_to: m2.id })).data;
    await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: c.id, name: 'Deal', value: 1 });
    const r = await runWorkflow(t, [{ type: 'assign_user', target: 'both', skip_if_assigned: true }]);
    expect(t.app.db.get('SELECT email FROM users WHERE id = ?', contactOf(t, r.contact.id).assigned_to)!.email).toMatch(/^(m[12]|rr-[ab])@example\.com$/);
    const wf2 = (await t.api.post('/api/workflows', { name: 'rr2', trigger: { type: 'manual', config: {} }, steps: [{ type: 'assign_user', target: 'both', skip_if_assigned: true }] })).data;
    await t.api.patch(`/api/workflows/${wf2.id}`, { status: 'active' });
    await t.api.post(`/api/workflows/${wf2.id}/enroll`, { contact_ids: [c.id] });
    expect(results(readRun(t, wf2.id).log)[0]).toContain('Schon zugewiesen');
    expect(contactOf(t, c.id).assigned_to).toBe(m2.id);
    expect(readRun(t, wf.id, (t.app.db.get('SELECT id FROM contacts WHERE email = ?', 'rr0@example.com')!).id).vars.assigned_user).toMatchObject({ id: expect.any(String), name: expect.any(String) });
  });
});

describe('stop everything, notify', () => {
  it('removes a contact from all other workflows', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Rolf', email: 'rolf-all@example.com' })).data;
    const slow = (await t.api.post('/api/workflows', { name: 'slow', trigger: { type: 'manual', config: {} }, steps: [{ type: 'wait', amount: 5, unit: 'days' }, set('x', '1')] })).data;
    await t.api.patch(`/api/workflows/${slow.id}`, { status: 'active' });
    await t.api.post(`/api/workflows/${slow.id}/enroll`, { contact_ids: [c.id] });
    expect(readRun(t, slow.id).run.status).toBe('waiting');
    const stop = (await t.api.post('/api/workflows', { name: 'stop', trigger: { type: 'manual', config: {} }, steps: [{ type: 'remove_all_workflows' }, set('after', 'ja')] })).data;
    await t.api.patch(`/api/workflows/${stop.id}`, { status: 'active' });
    await t.api.post(`/api/workflows/${stop.id}/enroll`, { contact_ids: [c.id] });
    expect(readRun(t, slow.id).run.status).toBe('stopped');
    const own = readRun(t, stop.id);
    expect(own.run.status).toBe('completed');
    expect(own.vars.after).toBe('ja');
    expect(results(own.log)[0]).toBe('1 Durchlauf gestoppt');
  });

  it('notifies users through app, push, e-mail and SMS', async () => {
    const mails: any[] = [];
    const sms: any[] = [];
    const pushes: any[] = [];
    const feed: any[] = [];
    t.app.services.emailTransports = { capture: async (_l: any, m: any) => (mails.push(m), { status: 'sent' }) };
    t.app.services.smsTransports = { capture: async (_l: any, to: string, body: string) => (sms.push({ to, body }), { status: 'sent' }) };
    for (const kind of ['email', 'sms']) t.app.db.run('UPDATE locations SET settings = json_set(settings, ?, json(?)) WHERE id = ?', `$.${kind}`, JSON.stringify({ provider: 'capture' }), loc);
    const old = { push: t.app.services.pushNotify, feed: t.app.services.mobileFeed };
    t.app.services.pushNotify = async (i: any) => (pushes.push(i), { users: i.userIds.length, sent: i.userIds.length });
    t.app.services.mobileFeed = (e: any) => (feed.push(e), 1);
    const m = (await t.api.post('/api/users', { email: 'notify-m@example.com', password: 'passwort-nm1', name: 'Nora', locations: [loc] })).data;
    const r = await runWorkflow(
      t,
      [{ type: 'notify_user', recipients: 'users', user_ids: [m.id, 'nicht-im-team'], channels: ['app', 'push', 'email', 'sms'], sms_to: '+4915100000001, +4915100000002', title: 'Neuer Lead: {{contact.name}}', body: '{{contact.email}} meldet sich' }],
      { contact: { first_name: 'Lena', last_name: 'Neu', email: 'lena-new@example.com', assigned_to: m.id } },
    );
    t.app.services.pushNotify = old.push;
    t.app.services.mobileFeed = old.feed;
    expect(results(r.log)[0]).toBe('Gemeldet über App (1), Push (1), E-Mail (1), SMS (2)');
    expect(feed[0]).toMatchObject({ userId: m.id, title: 'Neuer Lead: Lena Neu', link: `/app/contacts/${r.contact.id}` });
    expect(pushes[0]).toMatchObject({ userIds: [m.id], title: 'Neuer Lead: Lena Neu' });
    expect(mails.find((x) => x.to === 'notify-m@example.com')?.subject).toBe('Neuer Lead: Lena Neu');
    expect(sms.map((s) => s.to)).toEqual(['+4915100000001', '+4915100000002']);
    // the owner of the contact by default
    const owner = await runWorkflow(t, [{ type: 'notify_user', recipients: 'owner', channels: ['email'], title: 'Hallo', body: 'x' }], { contact: { assigned_to: m.id, email: 'owner-c@example.com' } });
    expect(results(owner.log)[0]).toContain('E-Mail (1)');
    delete t.app.services.emailTransports;
    delete t.app.services.smsTransports;
    for (const kind of ['email', 'sms']) t.app.db.run('UPDATE locations SET settings = json_set(settings, ?, json(?)) WHERE id = ?', `$.${kind}`, JSON.stringify({ provider: 'log' }), loc);
  });
});

describe('invoices, payment links, contracts', () => {
  it('creates an invoice with items and sends it', async () => {
    const r = await runWorkflow(t, [{ type: 'invoice_create', kind: 'invoice', title: 'Beratung {{contact.last_name}}', rows: [{ name: 'Erstberatung', qty: 2, price: '149,50', tax: '19' }, { name: 'Anfahrt', qty: 1, price: '30' }], due_days: 7, send: true, channel: 'email' }], { contact: { last_name: 'Berg', email: 'berg-inv@example.com' } });
    expect(results(r.log)[0]).toMatch(/^Rechnung .+ erstellt und gesendet$/);
    const inv = t.app.db.get('SELECT * FROM invoices WHERE id = ?', r.vars.invoice_id)!;
    expect(inv).toMatchObject({ title: 'Beratung Berg', status: 'sent', contact_id: r.contact.id });
    const items = JSON.parse(inv.items);
    expect(items[0]).toMatchObject({ name: 'Erstberatung', qty: 2, price_cents: 14950, tax_rate: 19 });
    expect(r.vars.invoice_url).toBe(`http://localhost/i/${inv.public_token}`);
    expect(r.vars.invoice_number).toBe(inv.number);
    const bad = await runWorkflow(t, [{ type: 'invoice_create', rows: [] }]);
    expect(results(bad.log)[0]).toMatch(/Mindestens eine Position/);
  });

  it('makes an estimate without sending, and a payment link by amount or product', async () => {
    const est = await runWorkflow(t, [{ type: 'invoice_create', kind: 'estimate', rows: [{ name: 'Konzept', qty: 1, price: '1000' }], send: false }]);
    expect(t.app.db.get('SELECT kind, status FROM invoices WHERE id = ?', est.vars.invoice_id)).toMatchObject({ kind: 'estimate', status: 'draft' });
    const prod = (await t.api.post('/api/products', { name: 'Coaching', price_cents: 9900, tax_rate: 19 })).data;
    const r = await runWorkflow(t, [{ type: 'payment_link', mode: 'amount', title: 'Anzahlung', amount: '119' }, { type: 'payment_link', mode: 'product', product_id: prod.id }, { type: 'payment_link', mode: 'amount', amount: '0' }]);
    const inv = t.app.db.get('SELECT * FROM invoices WHERE id = ?', r.vars.invoice_id)!;
    expect(inv.total_cents).toBe(11900);
    expect(inv.status).toBe('sent');
    expect(r.vars.payment_url).toBe(`http://localhost/buy/${prod.id}`); // the last successful one
    expect(results(r.log)[2]).toMatch(/größer als 0/);
    const sent = await runWorkflow(t, [{ type: 'payment_link', mode: 'amount', title: 'Rest', amount: '50', send: true, message: 'Bitte zahlen: {{var.payment_url}}' }], { contact: { email: 'pay-link@example.com' } });
    expect(results(sent.log)[0]).toBe('Zahlungslink erstellt und gesendet');
    expect(t.app.db.get(`SELECT body FROM messages WHERE contact_id = ? AND source = 'Zahlungslink'`, sent.contact.id)!.body).toContain('http://localhost/i/');
  });

  it('turns a contract template into a contract and sends it for signature', async () => {
    const tpl = (await t.api.post('/api/contracts', { kind: 'template', title: 'Dienstleistungsvertrag', content: '# Vertrag\nZwischen {{location.name}} und {{contact.name}} ({{contact.company}}).' })).data;
    const r = await runWorkflow(t, [{ type: 'contract_send', template_id: tpl.id, send: true }, { type: 'contract_send', template_id: 'nope' }], { contact: { first_name: 'Karl', last_name: 'Kunde', company: 'Kunde AG', email: 'karl-contract@example.com' } });
    const c = t.app.db.get('SELECT * FROM contracts WHERE id = ?', r.vars.contract_id)!;
    expect(c).toMatchObject({ kind: 'contract', status: 'sent', contact_id: r.contact.id, title: 'Dienstleistungsvertrag' });
    expect(c.content).toContain('Zwischen Testfirma und Karl Kunde (Kunde AG).');
    expect(r.vars.contract_url).toBe(`http://localhost/s/${c.public_token}`);
    expect(results(r.log)[1]).toMatch(/Vertragsvorlage nicht gefunden/);
    const draft = await runWorkflow(t, [{ type: 'contract_send', template_id: tpl.id, send: false }]);
    expect(t.app.db.get('SELECT status FROM contracts WHERE id = ?', draft.vars.contract_id)!.status).toBe('draft');
  });
});

describe('community and social', () => {
  it('adds and removes members', async () => {
    const g = (await t.api.post('/api/community/groups', { name: 'Mastermind' })).data;
    const joined: string[] = [];
    t.app.events.on('community.member_joined', (e) => void joined.push(e.data.contactId));
    const r = await runWorkflow(t, [{ type: 'community_join', group_id: g.id }, { type: 'community_join', group_id: g.id }, { type: 'community_leave', group_id: g.id }, { type: 'community_leave', group_id: g.id }, { type: 'community_join', group_id: 'nope' }]);
    await t.app.events.flush();
    expect(results(r.log).slice(0, 4)).toEqual(['Aufgenommen in „Mastermind“', 'Schon Mitglied in „Mastermind“', 'Entfernt aus „Mastermind“', 'Nicht Mitglied in „Mastermind“']);
    expect(results(r.log)[4]).toMatch(/nicht gefunden/);
    expect(joined).toEqual([r.contact.id]);
  });

  it('writes a social draft, with the AI when asked', async () => {
    const posts: any[] = [];
    t.app.services.socialPost = async (_loc: string, input: any) => (posts.push(input), { id: 'post-1' });
    t.app.services.aiRun = async (i: any) => ({ text: `Danke für die Bewertung! (${i.purpose})`, model: 'm' });
    const r = await runWorkflow(t, [{ type: 'social_draft', mode: 'ai', prompt: 'Danke für: {{event.comment}}', channels: ['ch1'] }, { type: 'social_draft', mode: 'text', body: 'Hallo {{contact.first_name}}', channels: ['ch1'] }, { type: 'social_draft', mode: 'text', body: '' }], { event: { comment: 'Toller Service' } });
    delete t.app.services.socialPost;
    delete t.app.services.aiRun;
    expect(posts[0]).toMatchObject({ type: 'draft', content: 'Danke für die Bewertung! (workflow)', integrationIds: ['ch1'] });
    expect(posts[1].content).toBe('Hallo Erika');
    expect(results(r.log)[2]).toMatch(/Kein Text/);
  });
});
