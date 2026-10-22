import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zendeskBase, zendeskContact } from '../server/services/umzug-zendesk.js';
import { FakeZendesk, ZD_EMAIL, ZD_TOKEN } from './umzug2-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeZendesk();
let imported: any;
const ALL = ['contacts', 'companies', 'tickets', 'articles'];
const creds = { subdomain: 'muster', email: ZD_EMAIL, api_token: ZD_TOKEN };

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('Zendesk');
});
afterAll(() => h.t.close());

describe('Zendesk: pure parts', () => {
  it('accepts only a plain subdomain', () => {
    expect(zendeskBase('Muster')).toBe('https://muster.zendesk.com/api/v2');
    expect(zendeskBase('https://muster.zendesk.com/agent/')).toBe('https://muster.zendesk.com/api/v2');
    expect(() => zendeskBase('evil.example.com/x')).toThrow(/ungültig/);
    expect(() => zendeskBase('a b')).toThrow();
    expect(() => zendeskBase('')).toThrow();
  });
  it('turns a Zendesk user into a contact that has given no advertising consent', () => {
    const c = zendeskContact({ id: 1, name: 'Anna Maria Alt', email: 'a@b.de', organization_id: 10, tags: ['vip'], user_fields: { k: 'x', leer: '' } }, new Map([['10', 'Muster']]));
    expect(c.values).toMatchObject({ first_name: 'Anna', last_name: 'Maria Alt', email: 'a@b.de', org_name: 'Muster', 'uf:k': 'x' });
    expect(c.values['uf:leer']).toBeUndefined();
    expect(c.proof).toMatchObject([{ basis: 'none' }]);
    expect(c.consent).toBe('unknown');
    expect(zendeskContact({ id: 2, name: 'Ohne Mail' }, new Map()).proof).toBeUndefined();
  });
});

describe('Zendesk: connect and preview', () => {
  it('refuses a bad subdomain, wrong token and a customer account; connects with the admin token', async () => {
    expect((await h.t.api.put('/api/umzug/connections/zendesk', { ...creds, subdomain: 'evil.example.com/x' })).status).toBe(400);
    expect((await h.t.api.put('/api/umzug/connections/zendesk', { ...creds, api_token: 'falsch' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/zendesk', creds);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ account: 'muster', label: 'muster.zendesk.com' });
    expect(JSON.stringify(r.data)).not.toContain(ZD_TOKEN);
    expect(fake.requests.every((q) => q.url.hostname === 'muster.zendesk.com')).toBe(true);
  });
  it('counts and lists the standard and own user fields', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'zendesk', parts: ALL });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (k: string) => r.data.counts.find((c: any) => c.key === k)?.total;
    expect(total('users')).toBe(4);
    expect(total('organizations')).toBe(1);
    expect(total('tickets')).toBe(4);
    expect(total('articles')).toBe(3);
    const refs = r.data.fields.map((f: any) => f.ref);
    expect(refs).toEqual(expect.arrayContaining(['uf:kundennummer', 'uf:geburtstag']));
    expect(refs).not.toContain('uf:alt');
    expect(r.data.mapping).toMatchObject({ email: 'email', first_name: 'first_name', phone: 'phone', org_name: 'company', tags: 'tag', notes: 'note', 'uf:kundennummer': 'new:text:Kundennummer', 'uf:geburtstag': 'new:date:Geburtstag' });
    expect(r.data.warnings.join(' ')).toContain('Kommentare einzeln');
  });
});

describe('Zendesk: import', () => {
  it('a dry run reads only the first tickets\' comments and writes nothing', async () => {
    const before = fake.seen('/api/v2/tickets/').length;
    const job = await h.run({ source: 'zendesk', parts: ALL }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(h.count('tickets')).toBe(0);
    expect(h.count('kb_articles')).toBe(0);
    expect(h.count('contacts')).toBe(0);
    expect(h.lines(job).tickets.created).toBe(4);
    expect(fake.seen('/api/v2/tickets/').length).toBeGreaterThan(before);
  });

  it('imports customers (not agents) and organizations, linked', async () => {
    imported = await h.run({ source: 'zendesk', parts: ALL });
    expect(imported.status, imported.error).toBe('done');
    expect(h.email('anna@example.com')).toMatchObject({ first_name: 'Anna', last_name: 'Alt', company: 'Muster GmbH', phone: '+49301234567' });
    expect(JSON.parse(h.email('anna@example.com').custom)).toMatchObject({ kundennummer: 'K-1042', geburtstag: '1985-05-05' });
    expect(h.tags('anna@example.com')).toEqual(['vip']);
    expect(h.email('agnes@muster.example.com')).toBeUndefined();
    expect(h.email(ZD_EMAIL)).toBeUndefined();
    const co = h.one("SELECT * FROM companies WHERE location_id = ? AND name = 'Muster GmbH'");
    expect(co).toBeTruthy();
    // the contact who wrote once appears from the ticket
    expect(h.email('fremd@example.com')).toBeTruthy();
    expect(h.count('contacts')).toBe(3);
  });

  it('marks support contacts as having given no advertising consent', () => {
    expect(h.ledger('anna@example.com')).toMatchObject([{ channel: 'email', action: 'declined', source_label: 'Umzug aus Zendesk' }]);
    expect(h.ledger('anna@example.com')[0].note).toContain('keine Werbeeinwilligung');
    const row = h.email('anna@example.com');
    expect(h.t.app.services.consent.allowMarketing(h.loc(), { id: row.id, dnd: row.dnd }, 'email').allow).toBe(false);
    expect(row.dnd).toBe(0);
  });

  it('imports tickets with status, priority, contact and tags – without SLA timers', () => {
    const rows = h.q('SELECT number, subject, status_kind, priority, tags, contact_id, first_response_due_at, resolution_due_at, external_source FROM tickets WHERE location_id = ? ORDER BY number');
    expect(rows).toHaveLength(4);
    const t500 = rows.find((r) => r.subject === 'Rechnung fehlt')!;
    expect(t500).toMatchObject({ status_kind: 'open', priority: 'hoch', first_response_due_at: null, resolution_due_at: null, external_source: 'umzug-zendesk' });
    expect(JSON.parse(t500.tags)).toEqual(['rechnung', 'vip']);
    expect(t500.contact_id).toBe(h.email('anna@example.com').id);
    expect(rows.find((r) => r.subject === 'Passwort vergessen')).toMatchObject({ status_kind: 'resolved', priority: 'normal' });
    expect(rows.find((r) => r.subject === 'Frage zur Lieferung')).toMatchObject({ status_kind: 'waiting', priority: 'dringend', contact_id: h.email('fremd@example.com').id });
    expect(rows.find((r) => r.subject.startsWith('Intern'))).toMatchObject({ status_kind: 'waiting', contact_id: null });
  });

  it('imports every comment into the timeline: customer, agent, internal note – the description is not doubled', () => {
    const t = h.one("SELECT id FROM tickets WHERE location_id = ? AND subject = 'Rechnung fehlt'");
    const ev = h.t.app.db.all<any>('SELECT type, body, created_at, data FROM ticket_events WHERE ticket_id = ? ORDER BY created_at, rowid', t.id);
    expect(ev.map((e) => e.type)).toEqual(['created', 'note', 'reply', 'note', 'customer_reply']);
    expect(ev.filter((e) => e.body.includes('wo ist meine Rechnung')).length).toBe(1); // description once, not as a customer_reply too
    const reply = ev.find((e) => e.type === 'reply')!;
    expect(reply.body).toBe('Agnes Agent:\n\nWir schauen nach.');
    expect(reply.created_at).toBe('2024-03-01T10:00:00.000Z');
    expect(ev.filter((e) => e.type === 'note').map((e) => e.body)).toEqual(expect.arrayContaining([expect.stringContaining('Aus Zendesk übernommen (Ticket #500)'), expect.stringContaining('Agnes Agent:\n\nBuchhaltung fragen')]));
    expect(ev.find((e) => e.type === 'note')!.body).toContain('Bearbeiter dort: Agnes Agent');
    expect(ev[ev.length - 1].body).toContain('Anhänge (liegen bei Zendesk): bestellung.pdf');
    const html = h.t.app.db.all<any>("SELECT body FROM ticket_events WHERE type = 'reply' AND ticket_id = (SELECT id FROM tickets WHERE location_id = ? AND subject = 'Passwort vergessen')", h.loc());
    expect(html[0].body).toContain('Link zum Zurücksetzen ist unterwegs.');
    const tt = h.one("SELECT last_customer_at, last_agent_at FROM tickets WHERE location_id = ? AND subject = 'Rechnung fehlt'");
    expect(tt).toMatchObject({ last_customer_at: '2024-03-02T09:00:00.000Z', last_agent_at: '2024-03-01T10:00:00.000Z' });
  });

  it('imports help-center articles as drafts in categories named after category and section', () => {
    const cats = h.q('SELECT name FROM kb_categories WHERE location_id = ? ORDER BY name').map((c) => c.name);
    expect(cats).toEqual(['Hilfe › Abrechnung', 'Hilfe › Erste Schritte', 'Produkt']);
    const arts = h.q('SELECT a.title, a.status, a.body, a.tags, c.name AS cat FROM kb_articles a LEFT JOIN kb_categories c ON c.id = a.category_id WHERE a.location_id = ? ORDER BY a.title');
    expect(arts.map((a) => a.status)).toEqual(['draft', 'draft', 'draft']);
    const konto = arts.find((a) => a.title === 'Konto anlegen')!;
    expect(konto.cat).toBe('Hilfe › Erste Schritte');
    expect(konto.body).toContain('## Schritt 1');
    expect(konto.body).toContain('[Anmelden](https://muster.example.com/signup)');
    expect(JSON.parse(konto.tags)).toEqual(['konto', 'start']);
    expect(arts.find((a) => a.title === 'Entwurf zur API')!.body).toContain('- eins');
    expect(imported.warnings.join('\n')).toContain('Bilder oder Anhänge liegen noch bei Zendesk');
  });

  it('reports the counts of every kind', () => {
    const l = h.lines(imported);
    expect(l.tickets.created).toBe(4);
    expect(l.ticket_comments.created).toBe(8); // four notes about the origin + four comments; each first comment is the description itself
    expect(l.articles.created).toBe(3);
    expect(l.kb_categories.created).toBe(3);
    expect(l.companies.created).toBe(1);
  });
});

describe('Zendesk: re-run and undo', () => {
  it('a re-run adds no ticket, comment or article twice', async () => {
    const before = { t: h.count('tickets'), e: h.count('ticket_events'), a: h.count('kb_articles'), c: h.count('contacts') };
    const again = await h.run({ source: 'zendesk', parts: ALL });
    expect(again.status, again.error).toBe('done');
    expect({ t: h.count('tickets'), e: h.count('ticket_events'), a: h.count('kb_articles'), c: h.count('contacts') }).toEqual(before);
    expect(h.lines(again).tickets.updated).toBe(4);
  });
  it('a reply written in HyperLevel since keeps that ticket on undo; everything else goes', async () => {
    const t = h.one("SELECT id FROM tickets WHERE location_id = ? AND subject = 'Passwort vergessen'");
    h.t.app.db.run("INSERT INTO ticket_events (id, location_id, ticket_id, type, body, user_id, data, created_at) VALUES ('evtest0000000000001', ?, ?, 'note', 'eigene Notiz', (SELECT id FROM users LIMIT 1), '{}', ?)", h.loc(), t.id, new Date().toISOString());
    const done = await h.undo(imported.id);
    expect(done.status).toBe('undone');
    expect(h.count('tickets')).toBe(1);
    expect(done.undo.kept.tickets).toBe(1);
    expect(h.count('kb_articles')).toBe(0);
    expect(h.count('kb_categories')).toBe(0);
    expect(h.count('contacts')).toBe(0);
    expect(h.count('companies')).toBe(0);
    expect(h.count('consent_events')).toBe(0);
  });
  it('waits on 429 with Retry-After', async () => {
    const f = new FakeZendesk();
    f.throttle.set('/api/v2/users.json', 2);
    h.t.app.services.umzugFetch = f.fetch;
    await h.fresh('Zendesk 429');
    expect((await h.t.api.put('/api/umzug/connections/zendesk', creds)).status).toBe(200);
    const job = await h.run({ source: 'zendesk', parts: ['contacts'] });
    expect(job.status, job.error).toBe('done');
    expect(f.seen('/api/v2/users.json').length).toBe(3); // two answered 429, the third got the page
  });
});
