import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { sha256, token } from '../server/core/util.js';
import { requiredPermission } from '../server/core/permissions.js';
import { triggerMatches } from '../server/services/workflow-engine.js';
import { addBusinessMinutes, businessMinutesBetween, defaultHours, shiftAfterPause, slaDeadlines, slaState, type WorkCalendar } from '../server/services/helpdesk-sla.js';
import { bandOf, computeHealth, defaultHealthConfig, healthDropped, signalScores, type HealthInput } from '../server/services/health-score.js';
import { articleScore, cleanHelpdeskSettings, cleanStages, defaultHelpdeskSettings, emailMatchesRule, nextRoundRobin, parseTicketTag, replySubject, searchTerms, sign, verifySig } from '../server/services/helpdesk.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let me = '';
const events: { type: string; data: any }[] = [];
const settle = () => t.app.events.flush();

beforeAll(async () => {
  t = await startTestApp();
  const m = await t.setup();
  loc = t.api.location;
  me = m.user.id;
  for (const type of ['ticket.created', 'ticket.status_changed', 'ticket.assigned', 'sla.warning', 'sla.breached', 'csat.received', 'nps.received', 'health_score.dropped']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(async () => {
  await t.close();
});

const BERLIN: WorkCalendar = { hours: defaultHours(), tz: 'Europe/Berlin', holidays: [] };
const at = (s: string) => new Date(s);

describe('SLA math with business hours', () => {
  it('only counts open hours (evenings, weekends, holidays) in the zone', () => {
    // Fri 16:00 Berlin (CEST) + 2 working hours → Mon 10:00.
    expect(addBusinessMinutes(at('2026-10-09T14:00:00Z'), 120, BERLIN).toISOString()).toBe('2026-10-12T08:00:00.000Z');
    // Saturday → Monday morning.
    expect(addBusinessMinutes(at('2026-10-10T08:00:00Z'), 60, BERLIN).toISOString()).toBe('2026-10-12T08:00:00.000Z');
    // Before opening: starts at 09:00.
    expect(addBusinessMinutes(at('2026-10-12T05:00:00Z'), 30, BERLIN).toISOString()).toBe('2026-10-12T07:30:00.000Z');
    // Holiday on Monday → Tuesday.
    expect(addBusinessMinutes(at('2026-10-09T14:00:00Z'), 120, { ...BERLIN, holidays: ['2026-10-12'] }).toISOString()).toBe('2026-10-13T08:00:00.000Z');
    // Across the DST change (25 Oct): Fri 16:30 CEST + 60 → Mon 09:30 CET.
    expect(addBusinessMinutes(at('2026-10-23T14:30:00Z'), 60, BERLIN).toISOString()).toBe('2026-10-26T08:30:00.000Z');
    // 24/7 policies count wall-clock time.
    expect(addBusinessMinutes(at('2026-10-10T08:00:00Z'), 120, { ...BERLIN, always: true }).toISOString()).toBe('2026-10-10T10:00:00.000Z');
    // Several days: 1 working day = 8 h.
    expect(addBusinessMinutes(at('2026-10-05T07:00:00Z'), 480 * 5, BERLIN).toISOString()).toBe('2026-10-09T15:00:00.000Z');
  });

  it('handles overnight hours and no open day at all', () => {
    const night: WorkCalendar = { ...BERLIN, hours: { ...defaultHours(), mon: { open: true, from: '22:00', to: '06:00' }, tue: { open: false, from: '09:00', to: '17:00' } } };
    // Mon 23:00 Berlin + 60 → Tue 00:00 Berlin.
    expect(addBusinessMinutes(at('2026-10-05T21:00:00Z'), 60, night).toISOString()).toBe('2026-10-05T22:00:00.000Z');
    const closed: WorkCalendar = { ...BERLIN, hours: Object.fromEntries(Object.entries(defaultHours()).map(([k, v]) => [k, { ...v, open: false }])) as any };
    expect(addBusinessMinutes(at('2026-10-05T07:00:00Z'), 30, closed).toISOString()).toBe('2026-10-05T07:30:00.000Z');
  });

  it('measures working minutes between two instants and resumes after a pause', () => {
    expect(businessMinutesBetween(at('2026-10-09T14:00:00Z'), at('2026-10-12T08:00:00Z'), BERLIN)).toBe(120);
    expect(businessMinutesBetween(at('2026-10-10T08:00:00Z'), at('2026-10-11T20:00:00Z'), BERLIN)).toBe(0);
    expect(businessMinutesBetween(at('2026-10-12T08:00:00Z'), at('2026-10-12T07:00:00Z'), BERLIN)).toBe(0);
    // Paused Mon 10:00 with the deadline Mon 14:00 (4 h left), resumed Wed 09:00 → Wed 13:00.
    expect(shiftAfterPause('2026-10-12T12:00:00.000Z', at('2026-10-12T08:00:00Z'), at('2026-10-14T07:00:00Z'), BERLIN)).toBe('2026-10-14T11:00:00.000Z');
    // A deadline that had already passed stays.
    expect(shiftAfterPause('2026-10-12T07:00:00.000Z', at('2026-10-12T08:00:00Z'), at('2026-10-14T07:00:00Z'), BERLIN)).toBe('2026-10-12T07:00:00.000Z');
  });

  it('computes deadlines, warnings and timer states', () => {
    const d = slaDeadlines(at('2026-10-12T07:00:00Z'), { first_response_min: 60, resolution_min: 480, business_hours: true }, BERLIN, 75);
    expect(d.first_response_due_at).toBe('2026-10-12T08:00:00.000Z');
    expect(d.first_response_warn_at).toBe('2026-10-12T07:45:00.000Z');
    expect(d.resolution_due_at).toBe('2026-10-12T15:00:00.000Z');
    expect(slaState(d.first_response_due_at, d.first_response_warn_at, null, at('2026-10-12T07:10:00Z'))).toBe('ok');
    expect(slaState(d.first_response_due_at, d.first_response_warn_at, null, at('2026-10-12T07:50:00Z'))).toBe('warning');
    expect(slaState(d.first_response_due_at, d.first_response_warn_at, null, at('2026-10-12T08:01:00Z'))).toBe('breached');
    expect(slaState(d.first_response_due_at, d.first_response_warn_at, '2026-10-12T07:59:00Z')).toBe('met');
    expect(slaState(d.first_response_due_at, d.first_response_warn_at, '2026-10-12T08:30:00Z')).toBe('missed');
    expect(slaState(null, null, null)).toBe('');
  });
});

describe('helpdesk rules', () => {
  it('round robin, ticket tags, stages, settings and rule matching', () => {
    expect(nextRoundRobin(['a', 'b', 'c'], null)).toBe('a');
    expect(nextRoundRobin(['a', 'b', 'c'], 'a')).toBe('b');
    expect(nextRoundRobin(['a', 'b', 'c'], 'c')).toBe('a');
    expect(nextRoundRobin(['a', 'b'], 'gone')).toBe('a');
    expect(nextRoundRobin([], 'a')).toBeNull();
    expect(parseTicketTag('Re: Drucker kaputt [Ticket #42]')).toBe(42);
    expect(parseTicketTag('kein tag')).toBeNull();
    expect(replySubject('Re: Hilfe [Ticket #3]', 3)).toBe('Re: Hilfe [Ticket #3]');
    expect(replySubject('Hilfe', 7)).toBe('Re: Hilfe [Ticket #7]');
    expect(() => cleanStages([{ name: 'Nur offen', kind: 'open' }])).toThrow(/Gelöst/);
    expect(cleanStages([{ name: 'Offen', kind: 'open' }, { name: 'Erledigt', kind: 'resolved' }]).map((s) => s.id)).toEqual(['offen', 'erledigt']);
    const s = cleanHelpdeskSettings({ sla: { warn_percent: 80, policies: { hoch: { first_response_min: 30 } } }, email_to_ticket: { mode: 'rules', addresses: 'Support@Firma.de', keywords: ['Hilfe'] } }, defaultHelpdeskSettings());
    expect(s.sla.policies.hoch.first_response_min).toBe(30);
    expect(s.sla.policies.hoch.resolution_min).toBe(1440);
    expect(s.email_to_ticket.addresses).toEqual(['support@firma.de']);
    expect(() => cleanHelpdeskSettings({ csat: { body: 'ohne Link' } }, defaultHelpdeskSettings())).toThrow(/csat_link/);
    expect(() => cleanHelpdeskSettings({ health: { green: 30, yellow: 50 } }, defaultHelpdeskSettings())).toThrow(/Gelb/);
    expect(emailMatchesRule(s.email_to_ticket, { to: ['support@firma.de'], from: 'a@b.de', subject: 'x' })).toBe(true);
    expect(emailMatchesRule(s.email_to_ticket, { to: ['info@firma.de'], from: 'a@b.de', subject: 'Brauche Hilfe' })).toBe(true);
    expect(emailMatchesRule(s.email_to_ticket, { to: ['info@firma.de'], from: 'a@b.de', subject: 'Newsletter' })).toBe(false);
    expect(emailMatchesRule({ ...s.email_to_ticket, mode: 'off' }, { to: ['support@firma.de'], from: 'a@b.de', subject: 'x' })).toBe(false);
    const sig = sign('geheim', 'csat:abc');
    expect(verifySig('geheim', 'csat:abc', sig)).toBe(true);
    expect(verifySig('geheim', 'csat:abd', sig)).toBe(false);
    expect(verifySig('anders', 'csat:abc', sig)).toBe(false);
  });

  it('scores knowledge-base articles for search', () => {
    expect(searchTerms('Wie ändere ich mein Passwort?')).toEqual(['andere', 'passwort']);
    const a = { title: 'Passwort ändern', body: 'So änderst du dein Passwort in den Einstellungen.', tags: ['konto'] };
    const b = { title: 'Rechnung herunterladen', body: 'Rechnungen findest du unter Konto.', tags: [] };
    expect(articleScore(a, searchTerms('passwort'))).toBeGreaterThan(articleScore(b, searchTerms('passwort')));
    expect(articleScore(b, searchTerms('passwort'))).toBe(0);
    expect(articleScore(b, searchTerms('konto rechnung'))).toBeGreaterThan(0);
  });

  it('computes the health score from weighted signals', () => {
    const cfg = defaultHealthConfig();
    const perfect: HealthInput = { openTickets: 0, overdueTickets: 0, lastCsat: 5, lastNps: 10, daysSinceActivity: 2, overdueInvoices: 0, dealStatus: 'won', emailsSent: 4, emailsEngaged: 2 };
    expect(computeHealth(perfect, cfg)).toMatchObject({ score: 100, band: 'green' });
    const bad: HealthInput = { openTickets: 3, overdueTickets: 2, lastCsat: 1, lastNps: 2, daysSinceActivity: 120, overdueInvoices: 2, dealStatus: 'lost', emailsSent: 10, emailsEngaged: 0 };
    const r = computeHealth(bad, cfg);
    expect(r.band).toBe('red');
    expect(r.score).toBeLessThan(20);
    // Missing data (no CSAT/NPS/deal/mail) is left out instead of counting as 0.
    const fresh = signalScores({ ...perfect, lastCsat: null, lastNps: null, dealStatus: null, emailsSent: 0 }, cfg);
    expect(fresh.csat).toBeNull();
    expect(fresh.engagement).toBeNull();
    // Exact weighted average: open 1 (75, w15) + overdue 1 (50, w20) + csat 3 (50, w20), everything else off.
    const only = { ...cfg, weights: { ...cfg.weights, nps: 0, activity: 0, overdue_invoices: 0, deals: 0, engagement: 0 } };
    expect(computeHealth({ ...perfect, openTickets: 1, overdueTickets: 1, lastCsat: 3 }, only).score).toBe(Math.round((75 * 15 + 50 * 20 + 50 * 20) / 55));
    expect(signalScores({ ...perfect, daysSinceActivity: 48.5 }, cfg).activity).toBe(50);
    expect(bandOf(70, cfg)).toBe('green');
    expect(bandOf(69, cfg)).toBe('yellow');
    expect(bandOf(39, cfg)).toBe('red');
    expect(healthDropped({ score: 80, band: 'green' }, { score: 72, band: 'green' }, cfg)).toBe(false);
    expect(healthDropped({ score: 80, band: 'green' }, { score: 65, band: 'yellow' }, cfg)).toBe(true);
    expect(healthDropped({ score: 95, band: 'green' }, { score: 79, band: 'green' }, cfg)).toBe(true);
    expect(healthDropped(null, { score: 10, band: 'red' }, cfg)).toBe(false);
  });

  it('maps helpdesk routes to permissions and filters ticket triggers', () => {
    expect(requiredPermission('GET', '/api/tickets')).toBe('helpdesk');
    expect(requiredPermission('POST', '/api/tickets/abc/reply')).toBe('helpdesk');
    expect(requiredPermission('GET', '/api/helpdesk/dashboard')).toBe('helpdesk');
    expect(requiredPermission('PUT', '/api/helpdesk/settings')).toBe('settings');
    expect(requiredPermission('GET', '/api/kb/articles')).toBe('helpdesk');
    expect(requiredPermission('GET', '/api/surveys/nps')).toBe('helpdesk');
    expect(requiredPermission('GET', '/api/health/scores')).toBe('contacts');
    expect(requiredPermission('GET', '/help/firma')).toBeUndefined();
    const e = (type: string, data: any) => ({ locationId: 'l', type, data, at: '' });
    const ticket = { pipeline_id: 'p1', priority: 'hoch', category: 'Technik', stage_id: 'neu' };
    expect(triggerMatches({ type: 'ticket.created', config: { priority: 'hoch' } }, e('ticket.created', { ticket }))).toBe(true);
    expect(triggerMatches({ type: 'ticket.created', config: { priority: 'niedrig' } }, e('ticket.created', { ticket }))).toBe(false);
    expect(triggerMatches({ type: 'ticket.status_changed', config: { stage_id: 'geloest' } }, e('ticket.status_changed', { ticket, stageId: 'geloest' }))).toBe(true);
    expect(triggerMatches({ type: 'sla.breached', config: { sla_kind: 'first_response' } }, e('sla.breached', { ticket, slaKind: 'resolution' }))).toBe(false);
    expect(triggerMatches({ type: 'health_score.dropped', config: { band: 'red' } }, e('health_score.dropped', { band: 'red' }))).toBe(true);
  });
});

async function contact(email: string, extra: Record<string, unknown> = {}) {
  const r = await t.api.post('/api/contacts', { email, first_name: email.split('@')[0], ...extra });
  expect(r.status).toBe(200);
  return r.data.id as string;
}

describe('ticket lifecycle', () => {
  let anna = '';
  let ticketId = '';
  it('creates a ticket with default pipeline, number, SLA and timeline', async () => {
    anna = await contact('anna@kunde.de');
    const meta = await t.api.get('/api/tickets/meta');
    expect(meta.status).toBe(200);
    expect(meta.data.pipelines[0].stages.map((s: any) => s.name)).toEqual(['Neu', 'In Bearbeitung', 'Wartet auf Kunde', 'Gelöst', 'Geschlossen']);
    const r = await t.api.post('/api/tickets', { subject: 'Login geht nicht', description: 'Seit heute komme ich nicht rein.', contact_id: anna, priority: 'hoch', category: 'Technik', tags: ['login'] });
    expect(r.status).toBe(200);
    ticketId = r.data.id;
    expect(r.data).toMatchObject({ number: 1, status: 'Neu', status_kind: 'new', priority: 'hoch', source: 'manuell', channel: 'email' });
    expect(r.data.first_response_due_at).toBeTruthy();
    expect(r.data.resolution_due_at > r.data.first_response_due_at).toBe(true);
    expect(r.data.sla.first).toMatch(/ok|warning|breached/);
    await settle();
    expect(events.some((e) => e.type === 'ticket.created' && e.data.ticketId === ticketId && e.data.contactId === anna)).toBe(true);
    expect((await t.api.post('/api/tickets', { description: '' })).status).toBe(400);
    expect((await t.api.post('/api/tickets', { subject: 'x', priority: 'super' })).status).toBe(400);
  });

  it('replies by email with the ticket number and records the first response', async () => {
    const r = await t.api.post(`/api/tickets/${ticketId}/reply`, { body: 'Hallo Anna, wir schauen uns das an.' });
    expect(r.status).toBe(200);
    expect(r.data.message.channel).toBe('email');
    expect(r.data.message.subject).toBe('Re: Login geht nicht [Ticket #1]');
    expect(r.data.ticket.first_response_at).toBeTruthy();
    expect(r.data.ticket.status).toBe('In Bearbeitung');
    const msgs = await t.api.get(`/api/contacts/${anna}/messages`);
    expect(msgs.data.some((m: any) => m.source === 'Ticket #1')).toBe(true);
  });

  it('changes status, priority and owner with timeline and events; notes stay internal', async () => {
    let r = await t.api.patch('/api/tickets/1', { status: 'Wartet auf Kunde' });
    expect(r.data.status_kind).toBe('waiting');
    expect(r.data.sla_paused_at).toBeTruthy();
    expect(r.data.sla.resolution).toBe('paused');
    r = await t.api.patch(`/api/tickets/${ticketId}`, { priority: 'raise', owner_id: me });
    expect(r.data.priority).toBe('dringend');
    expect(r.data.owner_name).toBe('Chef');
    expect((await t.api.post(`/api/tickets/${ticketId}/notes`, { body: 'Intern: Passwort-Reset prüfen' })).status).toBe(200);
    expect((await t.api.patch(`/api/tickets/${ticketId}`, { status: 'gibt es nicht' })).status).toBe(400);
    expect((await t.api.patch(`/api/tickets/${ticketId}`, { owner_id: 'fremd' })).status).toBe(400);
    const d = await t.api.get(`/api/tickets/${ticketId}`);
    const types = d.data.timeline.map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(['created', 'reply', 'status', 'priority', 'assigned', 'note']));
    await settle();
    expect(events.some((e) => e.type === 'ticket.status_changed' && e.data.kind === 'waiting' && e.data.ticketId === ticketId)).toBe(true);
    expect(events.some((e) => e.type === 'ticket.assigned' && e.data.ownerId === me)).toBe(true);
  });

  it('resolves, sends the CSAT link and accepts a signed rating', async () => {
    const r = await t.api.patch(`/api/tickets/${ticketId}`, { status: 'resolved' });
    expect(r.data.resolved_at).toBeTruthy();
    expect(r.data.sla_paused_at).toBeNull();
    await settle();
    const tk = t.app.db.get('SELECT * FROM tickets WHERE id = ?', ticketId);
    expect(tk.csat_sent_at).toBeTruthy();
    const mail = t.app.db.get(`SELECT * FROM messages WHERE contact_id = ? AND source = 'Zufriedenheit (CSAT)'`, anna);
    expect(mail.subject).toContain('[Ticket #1]');
    const link = String(mail.body).match(/\/survey\/csat\/([\w.-]+)\?s=5/)![1];
    expect((await t.api.raw(`/survey/csat/${ticketId}.falsch`)).status).toBe(404);
    const form = await t.api.raw(`/survey/csat/${link}?s=4`);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('value="4" checked');
    // Opening the link alone doesn't vote.
    expect(t.app.db.get('SELECT csat_score FROM tickets WHERE id = ?', ticketId).csat_score).toBeNull();
    const post = await t.api.raw(`/survey/csat/${link}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'score=5&comment=Super+schnell' });
    expect(post.status).toBe(303);
    expect(t.app.db.get('SELECT csat_score, csat_comment FROM tickets WHERE id = ?', ticketId)).toMatchObject({ csat_score: 5, csat_comment: 'Super schnell' });
    await settle();
    expect(events.some((e) => e.type === 'csat.received' && e.data.score === 5 && e.data.contactId === anna)).toBe(true);
    const summary = await t.api.get('/api/surveys/csat');
    expect(summary.data.summary).toMatchObject({ count: 1, avg: 5 });
  });

  it('merges duplicates and runs bulk actions', async () => {
    const a = (await t.api.post('/api/tickets', { subject: 'Rechnung falsch', contact_id: anna })).data;
    const b = (await t.api.post('/api/tickets', { subject: 'Rechnung falsch (nochmal)', contact_id: anna, tags: ['rechnung'] })).data;
    const m = await t.api.post(`/api/tickets/${a.id}/merge`, { ids: [b.number] });
    expect(m.status).toBe(200);
    expect(m.data.tags).toContain('rechnung');
    const gone = t.app.db.get('SELECT * FROM tickets WHERE id = ?', b.id);
    expect(gone.merged_into).toBe(a.id);
    expect(gone.status_kind).toBe('closed');
    const d = await t.api.get(`/api/tickets/${a.id}`);
    expect(d.data.timeline.some((e: any) => e.type === 'merged')).toBe(true);
    const c = (await t.api.post('/api/tickets', { subject: 'Frage 1', contact_id: anna })).data;
    const bulk = await t.api.post('/api/tickets/bulk', { ids: [a.id, c.id, 'fremd'], action: 'priority', value: 'niedrig' });
    expect(bulk.data.count).toBe(2);
    expect((await t.api.get(`/api/tickets?priority=niedrig`)).data.total).toBe(2);
    expect((await t.api.post('/api/tickets/bulk', { ids: [c.id], action: 'add_tag', value: 'vip' })).data.count).toBe(1);
    expect((await t.api.get('/api/tickets?tag=vip')).data.tickets[0].id).toBe(c.id);
    expect((await t.api.get('/api/tickets?q=%231')).data.total).toBe(0); // #1 is solved (state=open default)
    expect((await t.api.get('/api/tickets?state=all&q=%231')).data.tickets[0].number).toBe(1);
  });

  it('saved views, canned responses with placeholders and a ticket from a conversation', async () => {
    const v = await t.api.post('/api/helpdesk/views', { name: 'Dringend', filters: { priority: 'dringend', evil: 'x' } });
    expect(v.data.filters).toEqual({ priority: 'dringend' });
    expect((await t.api.get('/api/helpdesk/views')).data).toHaveLength(1);
    const c = await t.api.post('/api/helpdesk/canned', { name: 'Danke', body: 'Hallo {{contact.first_name}}, zu Ticket #{{ticket.number}}: {{agent.name}} kümmert sich.' });
    const tk = (await t.api.post('/api/tickets', { subject: 'Hilfe', contact_id: anna })).data;
    const r = await t.api.post(`/api/helpdesk/canned/${c.data.id}/render`, { ticket_id: tk.id });
    expect(r.data.body).toBe(`Hallo anna, zu Ticket #${tk.number}: Chef kümmert sich.`);
    // Konversationen → "Ticket erstellen" links the thread and takes over the last customer message.
    const ben = await contact('ben@kunde.de');
    t.app.db.run('UPDATE tickets SET status_kind = ? WHERE contact_id = ?', 'closed', ben);
    const { receiveMessage } = await import('../server/services/messaging.js');
    receiveMessage(t.app, loc, { channel: 'sms', from: '+491701234567', body: 'Mein Paket ist nicht angekommen' });
    await settle();
    const conv = t.app.db.get(`SELECT c.id FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE k.phone = '+491701234567'`);
    const ft = await t.api.post('/api/tickets/from-conversation', { conversation_id: conv.id });
    expect(ft.status).toBe(200);
    expect(ft.data).toMatchObject({ subject: 'Mein Paket ist nicht angekommen', source: 'SMS', channel: 'sms', conversation_id: conv.id });
  });
});

describe('email to ticket', () => {
  it('turns mail to the support mailbox into a ticket and threads replies', async () => {
    const s = await t.api.get('/api/helpdesk/settings');
    const hook = new URL(s.data.support_hook);
    expect((await t.api.raw(`${hook.pathname}?key=falsch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    const send = (body: any, path = hook.pathname + hook.search) => t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let r = await send({ from: 'Carla <carla@kunde.de>', to: 'support@firma.de', subject: 'Drucker kaputt', text: 'Der Drucker druckt nicht.' });
    expect(r.status).toBe(200);
    const first = (await r.json()).ticket;
    expect(first.created).toBe(true);
    const tk = t.app.db.get('SELECT * FROM tickets WHERE id = ?', first.id);
    expect(tk).toMatchObject({ subject: 'Drucker kaputt', source: 'E-Mail', channel: 'email', description: 'Der Drucker druckt nicht.' });
    await settle();
    // Move to "Wartet auf Kunde", then the customer answers with the ticket number → back to "In Bearbeitung".
    await t.api.patch(`/api/tickets/${first.id}`, { status: 'wartet' });
    const inbound = (await t.api.get('/api/settings/inbound')).data.email;
    r = await send({ from: 'carla@kunde.de', subject: `Re: Drucker kaputt [Ticket #${tk.number}]`, text: 'Immer noch kaputt.' }, new URL(inbound).pathname + new URL(inbound).search);
    expect(r.status).toBe(200);
    await settle();
    const after = t.app.db.get('SELECT * FROM tickets WHERE id = ?', first.id);
    expect(after.status_kind).toBe('open');
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ? AND type = 'customer_reply'`, first.id).n).toBe(2);
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM tickets WHERE contact_id = ?`, tk.contact_id).n).toBe(1);
  });

  it('applies the rule on the normal inbound address (support address, keywords) and ignores the rest', async () => {
    const put = await t.api.put('/api/helpdesk/settings', { email_to_ticket: { mode: 'rules', addresses: ['support@firma.de'], keywords: ['reklamation'], priority: 'hoch', category: 'Reklamation' } });
    expect(put.status).toBe(200);
    const inbound = new URL((await t.api.get('/api/settings/inbound')).data.email);
    const send = (body: any) => t.api.raw(inbound.pathname + inbound.search, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await send({ from: 'dora@kunde.de', to: 'Info <info@firma.de>', subject: 'Newsletter abbestellen', text: 'Bitte austragen' });
    await send({ from: 'emil@kunde.de', to: 'Support <support@firma.de>', subject: 'Frage zum Vertrag', text: 'Wie kündige ich?' });
    await send({ from: 'fritz@kunde.de', to: 'info@firma.de', subject: 'Reklamation Bestellung 123', text: 'Ware beschädigt' });
    await settle();
    const subj = t.app.db.all(`SELECT t.subject, t.priority, t.category FROM tickets t JOIN contacts c ON c.id = t.contact_id WHERE c.email IN ('dora@kunde.de','emil@kunde.de','fritz@kunde.de') ORDER BY t.number`);
    expect(subj).toEqual([
      { subject: 'Frage zum Vertrag', priority: 'hoch', category: 'Reklamation' },
      { subject: 'Reklamation Bestellung 123', priority: 'hoch', category: 'Reklamation' },
    ]);
  });
});

describe('teams, round robin and assignment rules', () => {
  it('assigns new tickets round robin in a team and by category', async () => {
    const u2 = await t.api.post('/api/users', { email: 'sven@firma.de', password: 'geheim1234', name: 'Sven', locations: [loc] });
    const u3 = await t.api.post('/api/users', { email: 'tina@firma.de', password: 'geheim1234', name: 'Tina', locations: [loc] });
    const outsider = await t.api.post('/api/users', { email: 'fremd@firma.de', password: 'geheim1234', name: 'Fremd', locations: [] });
    expect((await t.api.post('/api/helpdesk/teams', { name: 'X', members: [outsider.data.id] })).status).toBe(400);
    const team = (await t.api.post('/api/helpdesk/teams', { name: 'Support', members: [u2.data.id, u3.data.id] })).data;
    const billing = (await t.api.post('/api/helpdesk/teams', { name: 'Buchhaltung', members: [me], round_robin: false })).data;
    await t.api.put('/api/helpdesk/settings', { assignment: { mode: 'category', default_team_id: team.id, rules: [{ category: 'Rechnung', team_id: billing.id, user_id: me }] } });
    const owners: string[] = [];
    for (let i = 0; i < 3; i++) owners.push((await t.api.post('/api/tickets', { subject: `RR ${i}` })).data.owner_id);
    expect(owners).toEqual([u2.data.id, u3.data.id, u2.data.id]);
    const bill = (await t.api.post('/api/tickets', { subject: 'Doppelt abgebucht', category: 'Rechnung' })).data;
    expect(bill).toMatchObject({ owner_id: me, team_id: billing.id });
    const manual = (await t.api.post('/api/tickets', { subject: 'Direkt', owner_id: u3.data.id })).data;
    expect(manual.owner_id).toBe(u3.data.id);
    const wl = await t.api.get('/api/helpdesk/workload');
    expect(wl.data.people.find((p: any) => p.owner_id === u2.data.id)).toMatchObject({ open: 2, teams: ['Support'] });
    await t.api.put('/api/helpdesk/settings', { assignment: { mode: 'manual' } });
    expect((await t.api.post('/api/tickets', { subject: 'Manuell' })).data.owner_id).toBeNull();
  });
});

describe('SLA breach events and escalation', () => {
  it('warns, breaches, escalates and starts workflows', async () => {
    await t.api.put('/api/helpdesk/settings', { sla: { raise_priority_on_breach: true } });
    const wf = (await t.api.post('/api/workflows', { name: 'Eskalation', trigger: { type: 'sla.breached', config: { sla_kind: 'first_response' } }, steps: [{ type: 'ticket_update', note: 'Workflow: eskaliert', tags: ['eskaliert'] }], settings: { allow_reentry: true } })).data;
    expect((await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' })).status).toBe(200);
    const gina = await contact('gina@kunde.de');
    const tk = (await t.api.post('/api/tickets', { subject: 'Server down', contact_id: gina, priority: 'normal' })).data;
    const past = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const future = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
    t.app.db.run('UPDATE tickets SET first_response_warn_at = ?, first_response_due_at = ? WHERE id = ?', past(5), future(30), tk.id);
    let fired = await t.app.services.helpdeskSlaTick();
    expect(fired).toEqual([{ ticketId: tk.id, kind: 'first_response', type: 'warning' }]);
    expect(await t.app.services.helpdeskSlaTick()).toEqual([]);
    expect((await t.api.get(`/api/tickets?sla=warning`)).data.tickets.map((x: any) => x.id)).toContain(tk.id);
    t.app.db.run('UPDATE tickets SET first_response_due_at = ? WHERE id = ?', past(1), tk.id);
    fired = await t.app.services.helpdeskSlaTick();
    expect(fired).toEqual([{ ticketId: tk.id, kind: 'first_response', type: 'breached' }]);
    await settle();
    expect(events.filter((e) => e.data.ticketId === tk.id).map((e) => e.type)).toEqual(expect.arrayContaining(['sla.warning', 'sla.breached']));
    const after = (await t.api.get(`/api/tickets/${tk.id}`)).data;
    expect(after.ticket.priority).toBe('hoch');
    expect(after.ticket.tags).toContain('eskaliert');
    expect(after.timeline.map((e: any) => e.type)).toEqual(expect.arrayContaining(['sla_warning', 'sla_breached', 'note']));
    expect((await t.api.get(`/api/tickets?sla=breached`)).data.tickets.map((x: any) => x.id)).toContain(tk.id);
    const dash = await t.api.get('/api/helpdesk/dashboard?days=7');
    expect(dash.status).toBe(200);
    expect(dash.data.breached_open).toBeGreaterThanOrEqual(1);
    expect(dash.data.trend).toHaveLength(7);
    expect(dash.data.csat.count).toBe(1);
    expect(dash.data.sla.first_response.missed).toBeGreaterThanOrEqual(1);
  });
});

describe('knowledge base and help center', () => {
  let article: any;
  it('keeps the help center private until it is switched on', async () => {
    const cat = (await t.api.post('/api/kb/categories', { name: 'Konto & Login', description: 'Alles rund ums Konto' })).data;
    expect(cat.slug).toBe('konto-login');
    article = (await t.api.post('/api/kb/articles', { title: 'Passwort zurücksetzen', body: '## Schritte\n\n1. Auf **Passwort vergessen** klicken\n2. Link in der E-Mail öffnen\n\n<script>alert(1)</script>', category_id: cat.id, status: 'published', tags: ['login'], seo: { description: 'So setzt du dein Passwort zurück.' } })).data;
    await t.api.post('/api/kb/articles', { title: 'Geheimer Entwurf zum Passwort', body: 'intern', status: 'draft' });
    expect((await t.api.raw(`/help/${loc}`)).status).toBe(404);
    const put = await t.api.put('/api/helpdesk/settings', { help_center: { enabled: true, title: 'Testfirma Hilfe' } });
    expect(put.data.settings.help_center.slug).toBe('testfirma');
    expect(put.data.help_center_url).toBe('http://localhost/help/testfirma');
  });

  it('serves start page, category, article with SEO tags, search and feedback', async () => {
    const home = await t.api.raw('/help/testfirma');
    expect(home.status).toBe(200);
    const h = await home.text();
    expect(h).toContain('Konto &amp; Login');
    expect(h).toContain('Passwort zurücksetzen');
    expect(h).not.toContain('Geheimer Entwurf');
    expect(h).toContain('rel="canonical" href="http://localhost/help/testfirma"');
    const cat = await (await t.api.raw('/help/testfirma/k/konto-login')).text();
    expect(cat).toContain('/help/testfirma/passwort-zurucksetzen');
    const art = await t.api.raw('/help/testfirma/passwort-zurucksetzen');
    expect(art.status).toBe(200);
    const a = await art.text();
    expect(a).toContain('<strong>Passwort vergessen</strong>');
    expect(a).not.toContain('<script>alert');
    expect(a).toContain('<meta name="description" content="So setzt du dein Passwort zurück.">');
    expect(a).toContain('application/ld+json');
    expect(a).toContain('War das hilfreich?');
    expect((await t.api.raw('/help/testfirma/geheimer-entwurf-zum-passwort')).status).toBe(404);
    const search = await (await t.api.raw('/help/testfirma?q=passwort')).text();
    expect(search).toContain('1 Ergebnis');
    expect(search).toContain('noindex');
    const fb = (helpful: string) => t.api.raw('/help/testfirma/passwort-zurucksetzen/feedback', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `helpful=${helpful}` });
    expect((await fb('1')).status).toBe(303);
    await fb('1'); // same visitor, same day: counted once
    const row = t.app.db.get('SELECT helpful_yes, helpful_no, views FROM kb_articles WHERE id = ?', article.id);
    expect(row).toMatchObject({ helpful_yes: 1, helpful_no: 0, views: 1 });
    const map = await (await t.api.raw('/help/testfirma/sitemap.xml')).text();
    expect(map).toContain('/help/testfirma/passwort-zurucksetzen');
    const pub = await t.api.get('/api/public/help/testfirma/search?q=passwort');
    expect(pub.data).toEqual([expect.objectContaining({ title: 'Passwort zurücksetzen', url: 'http://localhost/help/testfirma/passwort-zurucksetzen' })]);
  });

  it('suggests articles to the team, previews drafts and feeds the AI', async () => {
    const s = await t.api.get('/api/kb/search?q=Kunde fragt: Passwort vergessen, was tun?');
    expect(s.data[0]).toMatchObject({ title: 'Passwort zurücksetzen', status: 'published' });
    const all = await t.api.get('/api/kb/search?q=passwort&all=1');
    expect(all.data).toHaveLength(2);
    const draft = all.data.find((x: any) => x.status === 'draft');
    const full = (await t.api.get(`/api/kb/articles/${draft.id}`)).data;
    expect(full.preview_url).toContain('?preview=');
    const prev = await t.api.raw(new URL(full.preview_url).pathname + new URL(full.preview_url).search);
    expect(prev.status).toBe(200);
    expect(await prev.text()).toContain('Vorschau');
    const knowledge = (t.app.services.aiKnowledge as ((l: string) => string)[]).map((fn) => fn(loc)).join('\n');
    expect(knowledge).toContain('# Hilfe-Center-Artikel');
    expect(knowledge).toContain('Passwort zurücksetzen');
    expect(knowledge).not.toContain('Geheimer Entwurf');
  });
});

describe('member portal: Meine Anfragen', () => {
  const cookieFor = (contactId: string) => {
    const raw = token(32);
    t.app.db.run('INSERT INTO member_sessions (token_hash, location_id, contact_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(raw), loc, contactId, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
    return `pm_${loc}=${raw}`;
  };
  const get = async (path: string, cookie: string) => {
    const r = await t.api.raw(path, { redirect: 'manual', headers: { cookie } });
    return { status: r.status, html: await r.text(), location: r.headers.get('location') };
  };
  const post = (path: string, data: Record<string, string>, cookie: string) =>
    t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'http://' + new URL(t.base).host, host: new URL(t.base).host }, body: new URLSearchParams(data).toString() });

  it('lists, creates, shows and answers the member’s own tickets', async () => {
    const hanna = await contact('hanna@kunde.de');
    const other = await contact('otto@kunde.de');
    const otherTicket = (await t.api.post('/api/tickets', { subject: 'Ottos Ticket', contact_id: other })).data;
    const cookie = cookieFor(hanna);
    const list = await get(`/portal/${loc}/tickets`, cookie);
    expect(list.status).toBe(200);
    expect(list.html).toContain('Meine Anfragen');
    expect(list.html).not.toContain('Ottos Ticket');
    const csrf = list.html.match(/name="csrf" value="([^"]+)"/)![1];
    expect((await post(`/portal/${loc}/tickets`, { subject: 'Hilfe', body: 'x', csrf: 'falsch' }, cookie)).status).toBe(403);
    const created = await post(`/portal/${loc}/tickets`, { subject: 'App stürzt ab', body: 'Beim Öffnen der App.', category: 'Technik', csrf }, cookie);
    expect(created.status).toBe(303);
    const tk = t.app.db.get('SELECT * FROM tickets WHERE contact_id = ?', hanna);
    expect(tk).toMatchObject({ subject: 'App stürzt ab', source: 'Portal', category: 'Technik' });
    await t.api.post(`/api/tickets/${tk.id}/notes`, { body: 'GEHEIME NOTIZ' });
    await t.api.post(`/api/tickets/${tk.id}/reply`, { body: 'Welche App-Version hast du?', status: 'wartet' });
    const detail = await get(created.headers.get('location')!, cookie);
    expect(detail.status).toBe(200);
    expect(detail.html).toContain('Welche App-Version hast du?');
    expect(detail.html).toContain('Wartet auf dich');
    expect(detail.html).not.toContain('GEHEIME NOTIZ');
    const reply = await post(`/portal/${loc}/tickets/${tk.number}/reply`, { body: 'Version 2.1', csrf }, cookie);
    expect(reply.status).toBe(303);
    expect(t.app.db.get('SELECT status_kind FROM tickets WHERE id = ?', tk.id).status_kind).toBe('open');
    expect((await get(`/portal/${loc}/tickets/${otherTicket.number}`, cookie)).status).toBe(404);
    // Logged out: back to the login, which remembers the page.
    const anon = await get(`/portal/${loc}/tickets`, '');
    expect(anon.status).toBe(401);
    expect(anon.html).toContain(`name="next" value="/portal/${loc}/tickets"`);
    // The start page shows the card.
    expect((await get(`/portal/${loc}`, cookie)).html).toContain('offene Anfrage');
  });
});

describe('forms, NPS, health score and permissions', () => {
  it('creates a ticket from a form with "als Ticket anlegen"', async () => {
    const f = await t.api.post('/api/forms', { name: 'Support-Formular', fields: [{ name: 'email', label: 'E-Mail', type: 'email' }, { name: 'betreff', label: 'Betreff', type: 'text' }, { name: 'msg', label: 'Nachricht', type: 'textarea' }], settings: { create_ticket: true, ticket_priority: 'hoch', notify_team: false } });
    expect(f.status).toBe(200);
    const r = await t.api.post(`/api/public/forms/${f.data.id}/submit`, { email: 'ida@kunde.de', betreff: 'Lieferung fehlt', msg: 'Seit 2 Wochen' });
    expect(r.status).toBe(200);
    await settle();
    const tk = t.app.db.get(`SELECT * FROM tickets WHERE form_submission_id IS NOT NULL`);
    expect(tk).toMatchObject({ subject: 'Lieferung fehlt', source: 'Formular', priority: 'hoch' });
    expect(tk.description).toContain('Nachricht: Seit 2 Wochen');
  });

  it('sends NPS surveys to a tag and stores the answers', async () => {
    const jan = await contact('jan@kunde.de', { tags: ['kunde'] });
    await contact('kai@kunde.de', { tags: ['lead'] });
    const c = await t.api.post('/api/surveys/nps', { name: 'NPS Q4', tags: ['kunde'] });
    expect(c.status).toBe(200);
    expect((await t.api.post('/api/surveys/nps', { name: 'x', body: 'ohne link', tags: ['kunde'] })).status).toBe(400);
    const s = await t.api.post(`/api/surveys/nps/${c.data.id}/send`);
    expect(s.data).toMatchObject({ queued: 1, audience: 1 });
    await t.app.services.npsTick();
    const msg = t.app.db.get(`SELECT * FROM messages WHERE contact_id = ? AND source = 'NPS: NPS Q4'`, jan);
    const link = String(msg.body).match(/\/survey\/nps\/([\w.-]+)/)![1];
    expect((await t.api.raw(`/survey/nps/${link.slice(0, -2)}xx`)).status).toBe(404);
    const r = await t.api.raw(`/survey/nps/${link}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'score=9&comment=Top' });
    expect(r.status).toBe(200);
    const list = (await t.api.get('/api/surveys/nps')).data;
    expect(list[0]).toMatchObject({ status: 'sent', stats: { count: 1, promoters: 1, score: 100 } });
    await settle();
    expect(events.some((e) => e.type === 'nps.received' && e.data.score === 9)).toBe(true);
  });

  it('computes health scores for contacts, filters the list and fires "gesunken"', async () => {
    const leo = await contact('leo@kunde.de');
    const good = await t.api.get(`/api/contacts/${leo}/service`);
    expect(good.data.health).toMatchObject({ band: 'green' });
    // Three open tickets, two overdue, and a bad rating → red.
    for (let i = 0; i < 3; i++) await t.api.post('/api/tickets', { subject: `Problem ${i}`, contact_id: leo });
    const two = t.app.db.all('SELECT id FROM tickets WHERE contact_id = ? LIMIT 2', leo);
    for (const x of two) t.app.db.run('UPDATE tickets SET first_response_due_at = ?, csat_score = 1, csat_at = ? WHERE id = ?', new Date(Date.now() - 6e4).toISOString(), new Date().toISOString(), x.id);
    await settle();
    const detail = await t.api.get(`/api/health/contacts/${leo}`);
    expect(detail.data.band).toBe('red');
    expect(detail.data.signals.find((s: any) => s.key === 'open_tickets').score).toBe(25);
    await settle();
    expect(events.some((e) => e.type === 'health_score.dropped' && e.data.contactId === leo)).toBe(true);
    const red = await t.api.get('/api/contacts?health=red');
    expect(red.data.contacts.map((c: any) => c.id)).toContain(leo);
    expect((await t.api.get('/api/contacts?health=green')).data.contacts.map((c: any) => c.id)).not.toContain(leo);
    const scores = await t.api.get(`/api/health/scores?ids=${leo}`);
    expect(scores.data[leo].band).toBe('red');
    const svc = await t.api.get(`/api/contacts/${leo}/service`);
    expect(svc.data.open).toBe(3);
  });

  it('lets only members with the Service area use the helpdesk', async () => {
    await t.api.post('/api/users', { email: 'kunde@firma.de', password: 'geheim1234', name: 'Kunde', locations: [loc], permissions: ['contacts'] });
    const owner = t.api.cookie;
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'kunde@firma.de', password: 'geheim1234' })).status).toBe(200);
    expect((await t.api.get('/api/tickets')).status).toBe(403);
    expect((await t.api.get('/api/kb/articles')).status).toBe(403);
    expect((await t.api.get('/api/helpdesk/settings')).status).toBe(403);
    expect((await t.api.get('/api/contacts?health=red')).status).toBe(200);
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);
    expect(t.api.cookie).not.toBe(owner);
    expect((await t.api.get('/api/tickets')).status).toBe(200);
  });

  it('works for API keys and the MCP tools', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'MCP' })).data.key;
    const rpc = async (name: string, args: any) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { location_id: loc, ...args } } }) });
      const j = await r.json();
      if (j.error || j.result?.isError) throw new Error(JSON.stringify(j));
      return JSON.parse(j.result.content[0].text);
    };
    const created = await rpc('ghl_create_ticket', { subject: 'Per MCP', email: 'mcp@kunde.de', priority: 'dringend' });
    expect(created.number).toBeGreaterThan(1);
    const upd = await rpc('ghl_update_ticket', { ticket: String(created.number), status: 'In Bearbeitung', note: 'per MCP' });
    expect(upd.status).toBe('In Bearbeitung');
    const rep = await rpc('ghl_reply_ticket', { ticket: created.id, body: 'Wir sind dran.' });
    expect(rep.status).toBe('logged');
    const list = await rpc('ghl_list_tickets', { q: 'Per MCP' });
    expect(list.tickets[0]).toMatchObject({ number: created.number, priority: 'dringend' });
    const kb = await rpc('ghl_search_kb', { q: 'passwort' });
    expect(kb[0].title).toBe('Passwort zurücksetzen');
  });
});

describe('HubSpot ticket import and reports', () => {
  it('imports tickets idempotently by HubSpot id and maps pipeline, stage and priority', async () => {
    const before = events.length;
    const mona = await contact('mona@kunde.de');
    const imp = t.app.services.ticketsImport as (loc: string, input: any) => { id: string; created: boolean };
    expect(typeof imp).toBe('function');
    const base = { external_source: 'hubspot', external_id: 'hs-1001', subject: 'Altes Ticket aus HubSpot', content: 'Text aus HubSpot', pipeline: 'Support Pipeline', contact_id: mona, assigned_to: me, created_at: '2026-05-01T10:00:00.000Z' };
    const a = imp(loc, { ...base, stage: 'Waiting on contact', priority: 'HIGH' });
    expect(a.created).toBe(true);
    let row = t.app.db.get('SELECT * FROM tickets WHERE id = ?', a.id);
    expect(row).toMatchObject({ subject: 'Altes Ticket aus HubSpot', status_kind: 'waiting', priority: 'hoch', owner_id: me, contact_id: mona, source: 'Import', created_at: '2026-05-01T10:00:00.000Z' });
    expect(row.first_response_due_at).toBeNull();
    // Second run: same HubSpot id updates instead of duplicating.
    const b = imp(loc, { ...base, stage: 'Closed', priority: 'URGENT', subject: 'Altes Ticket (geändert)' });
    expect(b).toEqual({ id: a.id, created: false });
    row = t.app.db.get('SELECT * FROM tickets WHERE id = ?', a.id);
    expect(row).toMatchObject({ status_kind: 'closed', priority: 'dringend', subject: 'Altes Ticket (geändert)' });
    expect(row.closed_at).toBeTruthy();
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM tickets WHERE external_id = 'hs-1001'`).n).toBe(1);
    expect(imp(loc, { external_source: 'hubspot', external_id: 'hs-1002', subject: 'Neu', stage: 'New', priority: 'low' })).toMatchObject({ created: true });
    expect(t.app.db.get(`SELECT status_kind, priority FROM tickets WHERE external_id = 'hs-1002'`)).toEqual({ status_kind: 'new', priority: 'niedrig' });
    // Imports don't start workflows.
    await settle();
    expect(events.slice(before).filter((e) => e.type === 'ticket.created' && e.data.contactId === mona)).toHaveLength(0);
  });

  it('offers tickets, CSAT, NPS and health scores as report sources', async () => {
    const meta = await t.api.get('/api/reports/sources');
    expect(meta.status).toBe(200);
    const keys = (meta.data.sources ?? []).map((s: any) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['tickets', 'csat_responses', 'nps_responses', 'health_scores']));
    const byPriority = await t.api.post('/api/reports/run', { source: 'tickets', group_by: ['priority'], measures: ['count', 'calc:sla_rate', 'avg:first_response_min'], range: 'all' });
    expect(byPriority.status).toBe(200);
    expect(byPriority.data.rows.length).toBeGreaterThan(1);
    const total = t.app.db.get('SELECT COUNT(*) AS n FROM tickets WHERE location_id = ? AND merged_into IS NULL', loc).n;
    expect(byPriority.data.totals.v[0]).toBe(total);
    const status = await t.api.post('/api/reports/run', { source: 'tickets', group_by: ['status'], measures: ['count'], range: 'all' });
    expect(status.data.rows.map((r: any) => r.l[0])).toEqual(expect.arrayContaining(['Neu', 'Geschlossen']));
    const breached = await t.api.post('/api/reports/run', { source: 'tickets', filters: [{ field: 'sla_breached', op: 'is_true' }], measures: ['count'], range: 'all' });
    expect(breached.data.totals.v[0]).toBeGreaterThanOrEqual(1);
    const csat = await t.api.post('/api/reports/run', { source: 'csat_responses', measures: ['calc:avg_score'], range: 'all' });
    expect(csat.data.totals.v[0]).toBeGreaterThan(0);
    const nps = await t.api.post('/api/reports/run', { source: 'nps_responses', measures: ['calc:nps'], range: 'all' });
    expect(nps.data.totals.v[0]).toBe(100);
  });
});
