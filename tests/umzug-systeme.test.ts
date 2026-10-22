import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeSysteme, SYS_KEY } from './umzug2-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeSysteme();
let imported: any;
const ALL = ['contacts', 'products', 'courses', 'students', 'templates', 'automations', 'reference'];

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('systeme.io');
});
afterAll(() => h.t.close());

describe('systeme.io: connect', () => {
  it('lists the source with what it cannot move', async () => {
    const r = await h.t.api.get('/api/umzug');
    const s = r.data.sources.find((x: any) => x.key === 'systeme');
    expect(s.label).toBe('systeme.io');
    expect(s.parts.map((p: any) => p.key)).toEqual(['contacts', 'products', 'courses', 'students', 'templates', 'automations', 'reference']);
    expect(s.limits.join(' ')).toContain('Funnel-Seiten');
    expect(s.credentials).toEqual([expect.objectContaining({ key: 'api_key', secret: true })]);
  });
  it('refuses a wrong key and connects with the right one (account = the platform sub-domain)', async () => {
    expect((await h.t.api.put('/api/umzug/connections/systeme', { api_key: 'nope' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/systeme', { api_key: SYS_KEY });
    expect(r.status).toBe(200);
    expect(r.data.account).toBe('meinshop.systeme.io');
    expect(JSON.stringify(r.data)).not.toContain(SYS_KEY);
  });
  it('sends the key only to api.systeme.io and in a header', () => {
    const real = fake.requests.filter((r) => r.headers['x-api-key'] === SYS_KEY);
    expect(real.length).toBeGreaterThan(0);
    expect(fake.requests.every((r) => r.url.hostname === 'api.systeme.io' && !r.url.search.includes(SYS_KEY))).toBe(true);
  });
});

describe('systeme.io: preview and dry run', () => {
  it('counts every part and proposes a mapping (own slugs are standard fields)', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'systeme', parts: ALL });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (key: string) => r.data.counts.find((c: any) => c.key === key)?.total;
    expect(total('contacts')).toBe(5);
    expect(total('tags')).toBe(3);
    expect(total('products')).toBe(2);
    expect(total('courses')).toBe(1);
    expect(total('enrollments')).toBe(3);
    expect(total('memberships')).toBe(1);
    expect(total('newsletters')).toBe(2);
    expect(total('campaigns')).toBe(1);
    expect(total('rules')).toBe(3);
    expect(total('funnels')).toBe(2);
    expect(r.data.mapping['f:first_name']).toBe('first_name');
    expect(r.data.mapping['f:surname']).toBe('last_name');
    expect(r.data.mapping['f:phone_number']).toBe('phone');
    expect(r.data.mapping['f:company_name']).toBe('company');
    expect(r.data.mapping['f:lieblingsfarbe']).toBe('new:text:Lieblingsfarbe');
    expect(r.data.mapping.email).toBe('email');
    expect(r.data.mapping.source_url).toBe('');
  });
  it('walks pages with the cursor (limit + startingAfter) and honours hasMore', () => {
    const calls = fake.seen('/api/contacts');
    expect(calls.some((c) => c.url.searchParams.get('startingAfter'))).toBe(true);
    expect(calls.every((c) => Number(c.url.searchParams.get('limit')) <= 100)).toBe(true);
  });
  it('a dry run writes nothing', async () => {
    const before = h.count('contacts');
    const job = await h.run({ source: 'systeme', parts: ALL }, 'dry-run');
    expect(job.status).toBe('done');
    expect(job.kind).toBe('dry_run');
    expect(h.count('contacts')).toBe(before);
    expect(h.count('courses')).toBe(0);
    expect(h.count('products')).toBe(0);
    expect(h.count('consent_events')).toBe(0);
    expect(h.count('wiki_pages')).toBe(0);
    const l = h.lines(job);
    expect(l.contacts.created).toBe(5);
    expect(l.consent_events.created).toBeGreaterThan(0);
    expect(l.references.created).toBe(1);
  });
});

describe('systeme.io: import', () => {
  it('imports contacts with tags, fields and state', async () => {
    imported = await h.run({ source: 'systeme', parts: ALL, options: { tag: 'Umzug systeme.io' } });
    expect(imported.status, imported.error).toBe('done');
    expect(h.email('anna@example.com')).toMatchObject({ first_name: 'Anna', last_name: 'Alt', company: 'Muster GmbH', city: 'Berlin', dnd: 0 });
    expect(JSON.parse(h.email('anna@example.com').custom)).toMatchObject({ lieblingsfarbe: 'Blau' });
    expect(h.tags('anna@example.com').sort()).toEqual(['Community: Foto-Club', 'Kunde', 'Umzug systeme.io', 'VIP']);
    expect(h.email('anna@example.com').created_at).toBe('2024-01-05T10:00:00.000Z');
    // unsubscribed / bounced / unconfirmed → do not disturb plus a tag naming why
    expect(h.email('ben@example.com').dnd).toBe(1);
    expect(h.tags('ben@example.com')).toContain('systeme.io: abgemeldet');
    expect(h.tags('cleo@example.com')).toContain('systeme.io: unzustellbar');
    expect(h.email('dirk@example.com').dnd).toBe(1);
    expect(h.tags('dirk@example.com')).toContain('systeme.io: unbestätigt');
    expect(h.email('emil@example.com').dnd).toBe(0);
    expect(h.lines(imported).contacts.created).toBe(6); // five + the person only known from a course access
  });

  it('writes the consent ledger: legacy for "subscribed" (with the page as proof), revoked for withdrawals, nothing for unconfirmed', () => {
    const anna = h.ledger('anna@example.com');
    expect(anna).toHaveLength(1);
    expect(anna[0]).toMatchObject({ channel: 'email', action: 'legacy', purpose: '*', source_kind: 'import', source_label: 'Umzug aus systeme.io', proof_url: 'https://meinshop.systeme.io/webinar-anmeldung', created_at: '2024-01-05T10:00:00.000Z' });
    expect(anna[0].note).toContain('ohne eigenen Nachweis');
    expect(anna[0].note).toContain('systeme.io');
    expect(h.ledger('ben@example.com')).toMatchObject([{ channel: 'email', action: 'revoked', purpose: '*' }]);
    expect(h.ledger('cleo@example.com')).toMatchObject([{ action: 'revoked' }]);
    expect(h.ledger('dirk@example.com')).toEqual([]);
    // what the gate sees
    const st = h.t.app.services.consent.status(h.loc(), h.email('anna@example.com').id);
    expect(st.email.status).toBe('unknown');
    expect(st.email.legacy).toBe(true);
    expect(h.t.app.services.consent.status(h.loc(), h.email('ben@example.com').id).email.status).toBe('revoked');
  });

  it('turns price plans into products and warns about what has no equivalent', () => {
    const rows = h.q('SELECT name, price_cents, currency, recurring FROM products WHERE location_id = ? ORDER BY name');
    expect(rows).toEqual([
      { name: 'Coaching', price_cents: 5000, currency: 'EUR', recurring: 'month' },
      { name: 'Kurs-Paket – Einmalzahlung', price_cents: 19900, currency: 'EUR', recurring: null },
      { name: 'Kurs-Paket – Monatlich', price_cents: 2900, currency: 'EUR', recurring: 'month' },
      { name: 'Kurs-Paket – Quartal', price_cents: 7900, currency: 'EUR', recurring: 'month' },
    ]);
    const w = imported.warnings.join('\n');
    expect(w).toContain('alle 3 Monate');
    expect(w).toContain('begrenzt auf 6 Zahlungen');
    expect(w).toContain('Testphase');
    const one = h.one("SELECT description FROM products WHERE location_id = ? AND name = 'Kurs-Paket – Einmalzahlung'");
    expect(one.description).toContain('Kurs „Fotokurs“');
  });

  it('imports the course structure in order, as a draft, with a hint where the content is missing', () => {
    const course = h.one('SELECT * FROM courses WHERE location_id = ?');
    expect(course).toMatchObject({ title: 'Fotokurs', status: 'draft', description: 'Lerne Licht' });
    const mods = h.t.app.db.all<any>('SELECT id, title FROM course_modules WHERE course_id = ? ORDER BY position', course.id);
    expect(mods.map((m) => m.title)).toEqual(['Start', 'Praxis']);
    const lessons = h.t.app.db.all<any>('SELECT title, body, published, module_id FROM course_lessons WHERE course_id = ? ORDER BY position', course.id);
    const start = lessons.filter((l) => l.module_id === mods[0].id);
    expect(start.map((l) => l.title)).toEqual(['Willkommen', 'Blende', 'Entwurf']);
    expect(start[1].body).toContain('liegt bei systeme.io');
    expect(start[1].body).toContain('2 Tage nach der vorigen Lektion');
    expect(start[2].published).toBe(0);
    expect(imported.warnings.join('\n')).toContain('nicht die Inhalte');
  });

  it('gives course access to active enrolments only, creates the unknown person by e-mail, and tags community members', () => {
    expect(h.count('course_enrollments')).toBe(2);
    expect(h.email('fremd@example.com')).toBeTruthy();
    expect(h.t.app.db.get('SELECT 1 FROM course_enrollments e JOIN contacts c ON c.id = e.contact_id WHERE e.location_id = ? AND c.email = ?', h.loc(), 'ben@example.com')).toBeUndefined();
    expect(h.tags('anna@example.com')).toContain('Community: Foto-Club');
  });

  it('keeps newsletters as templates with converted merge tags, and says when the visual editor gave no HTML', () => {
    const rows = h.q('SELECT name, subject, body FROM templates WHERE location_id = ? ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(['Neuigkeiten im Mai', 'Visuell gebaut']);
    expect(rows[0].body).toContain('{{contact.first_name|}}');
    expect(rows[0].body).toContain('{{contact.hobby}}');
    expect(rows[1].body).toBe('');
    const w = imported.warnings.join('\n');
    expect(w).toContain('visuellen Editor');
    expect(w).toContain('Platzhalter ohne Entsprechung');
  });

  it('builds workflow drafts from the e-mail campaign and the automation rules', () => {
    const wfs = h.q('SELECT name, status, trigger, steps FROM workflows WHERE location_id = ? ORDER BY name');
    expect(wfs.every((w) => w.status === 'draft')).toBe(true);
    const folge = wfs.find((w) => w.name.startsWith('Folge: Willkommensfolge'))!;
    const steps = JSON.parse(folge.steps);
    const kinds = steps.map((s: any) => s.type);
    expect(kinds).toEqual(['add_note', 'send_email', 'wait', 'send_email']);
    expect(steps[1].body).toContain('{{contact.first_name|}}');
    expect(steps[2]).toMatchObject({ amount: 2, unit: 'days' });
    expect(steps[3].body).toContain('einfügen');
    const rule = wfs.find((w) => w.name.startsWith('Regel 801'))!;
    expect(JSON.parse(rule.trigger)).toEqual({ type: 'contact.tag_added', config: { tag: 'Kunde' } });
    const rs = JSON.parse(rule.steps);
    expect(rs.some((s: any) => s.type === 'add_tag' && s.tags[0] === 'VIP')).toBe(true);
    expect(rs.some((s: any) => s.type === 'add_note' && /Willkommensfolge/.test(s.body))).toBe(true);
    const sale = wfs.find((w) => w.name.startsWith('Regel 802'))!;
    expect(JSON.parse(sale.trigger).type).toBe('product.purchased');
    expect(JSON.parse(sale.steps).some((s: any) => s.type === 'webhook')).toBe(true);
    const visit = wfs.find((w) => w.name.startsWith('Regel 803'))!;
    expect(JSON.parse(visit.trigger).type).toBe('manual');
    expect(imported.warnings.join('\n')).toContain('page_visited');
  });

  it('keeps the funnels as a reference page in the wiki space "Umzug"', () => {
    const space = h.one("SELECT * FROM wiki_spaces WHERE location_id = ? AND name = 'Umzug'");
    expect(space).toBeTruthy();
    const page = h.one("SELECT * FROM wiki_pages WHERE location_id = ? AND title = 'Funnels aus systeme.io'");
    expect(page.space_id).toBe(space.id);
    expect(page.body).toContain('## Webinar-Funnel');
    expect(page.body).toContain('| 1 | Anmeldung | squeeze | https://meinshop.systeme.io/webinar-anmeldung |');
    expect(page.body).toContain('## Alter Funnel (inaktiv)');
    expect(page.created_by_name).toBe('Umzug (systeme.io)');
  });

  it('reports every kind in the job report', () => {
    const l = h.lines(imported);
    expect(l.products.created).toBe(4);
    expect(l.courses.created).toBe(1);
    expect(l.lessons.created).toBe(4);
    expect(l.enrollments.created).toBe(2);
    expect(l.workflows.created).toBe(4);
    expect(l.templates.created).toBe(2);
    expect(l.references.created).toBe(1);
    expect(l.consent_events.created).toBe(4);
  });
});

describe('systeme.io: re-run and undo', () => {
  it('a second run updates what it knows and creates nothing twice', async () => {
    const before = { contacts: h.count('contacts'), products: h.count('products'), events: h.count('consent_events'), wf: h.count('workflows'), pages: h.count('wiki_pages'), tpl: h.count('templates') };
    const again = await h.run({ source: 'systeme', parts: ALL, options: { tag: 'Umzug systeme.io' } });
    expect(again.status, again.error).toBe('done');
    expect(h.count('contacts')).toBe(before.contacts);
    expect(h.count('products')).toBe(before.products);
    expect(h.count('consent_events')).toBe(before.events);
    expect(h.count('workflows')).toBe(before.wf);
    expect(h.count('wiki_pages')).toBe(before.pages);
    expect(h.count('templates')).toBe(before.tpl);
    const l = h.lines(again);
    expect(l.contacts.created ?? 0).toBe(0);
    expect(l.contacts.updated).toBe(5);
    expect(l.references.updated).toBe(1);
  });

  it('a person-edited reference page stays as it is on the next run', async () => {
    const page = h.one("SELECT id FROM wiki_pages WHERE location_id = ? AND title = 'Funnels aus systeme.io'");
    h.t.app.db.run("UPDATE wiki_pages SET body = 'Meine Notizen', updated_by_name = 'Paul' WHERE id = ?", page.id);
    const again = await h.run({ source: 'systeme', parts: ['reference'] });
    expect(again.status).toBe('done');
    expect(h.raw('SELECT body FROM wiki_pages WHERE id = ?', page.id).body).toBe('Meine Notizen');
  });

  it('undo takes back what the import created, including ledger entries and the wiki page', async () => {
    const jobs = (await h.t.api.get('/api/umzug/jobs')).data;
    const first = jobs.find((j: any) => j.id === imported.id);
    expect(first).toBeTruthy();
    const done = await h.undo(imported.id);
    expect(done.status).toBe('undone');
    expect(h.count('products')).toBe(0);
    expect(h.count('courses')).toBe(0);
    expect(h.count('workflows')).toBe(0);
    expect(h.count('templates')).toBe(0);
    expect(h.count('consent_events')).toBe(0);
    expect(h.count('course_enrollments')).toBe(0);
    expect(h.email('anna@example.com')).toBeUndefined();
    // the edited page was not ours to delete any more
    expect(h.one("SELECT 1 x FROM wiki_pages WHERE location_id = ? AND title = 'Funnels aus systeme.io'")).toBeTruthy();
    expect(done.undo.kept.references).toBe(1);
  });
});

describe('systeme.io: rate limits and errors', () => {
  it('waits for Retry-After on 429 and carries on', async () => {
    const f = new FakeSysteme();
    f.throttle.set('/api/contacts', 2);
    h.t.app.services.umzugFetch = f.fetch;
    const job = await h.run({ source: 'systeme', parts: ['contacts'], options: { merge: 'fill' } });
    expect(job.status, job.error).toBe('done');
    expect(f.seen('/api/contacts').filter((r) => r.path === '/api/contacts').length).toBeGreaterThan(3);
    h.t.app.services.umzugFetch = fake.fetch;
  });
  it('skips a part the plan does not offer and says so', async () => {
    const f = new FakeSysteme();
    f.fail.set('/api/school/courses', 403);
    h.t.app.services.umzugFetch = f.fetch;
    const job = await h.run({ source: 'systeme', parts: ['contacts', 'courses'] });
    expect(job.status, job.error).toBe('done');
    expect(job.notes.join(' ')).toContain('übersprungen');
    h.t.app.services.umzugFetch = fake.fetch;
  });
  it('stops on a revoked key', async () => {
    const f = new FakeSysteme();
    h.t.app.services.umzugFetch = f.fetch;
    f.fail.set('/api/contacts', 401);
    // Without a mapping the job reads the source first (the preview fails with the German message) …
    const early = await h.t.api.post('/api/umzug/jobs', { source: 'systeme', parts: ['contacts'] });
    expect(early.status).toBe(400);
    expect(early.data.error).toContain('ungültig');
    // … with a mapping it starts, and the running job stops at the first 401 instead of going on.
    const job = await h.run({ source: 'systeme', parts: ['contacts'], mapping: { email: 'email' } });
    expect(job.status).toBe('failed');
    expect(job.error).toContain('ungültig');
    h.t.app.services.umzugFetch = fake.fetch;
  });
});
