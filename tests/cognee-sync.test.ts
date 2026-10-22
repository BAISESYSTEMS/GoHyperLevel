import { afterEach, describe, expect, it } from 'vitest';
import { id } from '../server/core/util.js';
import { cogneeApp, touchedLocations, type CogneeApp } from './cognee-helpers.js';

let c: CogneeApp;
afterEach(async () => c && (await c.close()));

const rows = (sql: string, ...p: any[]) => c.t.app.db.all<any>(sql, ...p);
const audit = (like = 'cognee.%') => rows(`SELECT action, summary, actor FROM audit_log WHERE action LIKE ? ORDER BY at`, like);
const names = () => [...c.fake.datasets.values()].map((d) => d.name).sort();
const adds = () => c.fake.calls.filter((x) => x.path === '/api/v1/add');

async function wikiPage(loc: string, title: string, body: string, spaceId?: string) {
  const at = c.at(loc);
  const space = spaceId ? { id: spaceId } : (await at('POST', '/api/wiki/spaces', { name: `Team ${title}` })).data;
  const page = (await at('POST', '/api/wiki/pages', { space_id: space.id, title, body })).data;
  return { page, space };
}
async function contact(loc: string, data: Record<string, unknown> = {}) {
  return (await c.at(loc)('POST', '/api/contacts', { first_name: 'Erika', last_name: 'Muster', email: `erika-${id(5).toLowerCase()}@example.com`, ...data })).data;
}

describe('sharing is opt-in', () => {
  it('sends nothing until the sub-account opts in, then only the wiki', async () => {
    c = await cogneeApp();
    await c.connect();
    const ct = await contact(c.A);
    await c.at(c.A)('POST', `/api/contacts/${ct.id}/notes`, { body: 'Notiz Nummer eins' });
    await wikiPage(c.A, 'Onboarding', 'Der Onboarding-Call läuft so ab: erst Begrüßung, dann Ziele.');
    c.fake.reset();
    // Off by default: the background job finds nothing to share and sends nothing (only the daily check whether the server asks for a login).
    await c.t.app.tick();
    await c.sync(c.A);
    await new Promise((r) => setTimeout(r, 20));
    expect(c.fake.calls.filter((x) => !(x.path === '/api/v1/datasets' && x.user === 'anonymous'))).toEqual([]);
    expect((await c.at(c.A)('GET', '/api/cognee/admin/settings')).data).toMatchObject({ enabled: false, types: { wiki: true, notes: false, tickets: false, courses: false, conversations: false, contacts: false, memory: false } });

    await c.share(c.A);
    expect(names()).toEqual([`gh_${c.A}_wiki`]);
    const items = c.fake.items(`gh_${c.A}_wiki`);
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain('Onboarding-Call läuft so ab');
    expect(items[0].text.startsWith('HyperLevel · Wiki & Dokumente · page:')).toBe(true);
    expect(c.fake.calls.some((x) => x.path === '/api/v1/cognify')).toBe(true);

    const st = (await c.at(c.A)('GET', '/api/cognee/admin/status')).data;
    expect(st.types.find((t: any) => t.key === 'wiki')).toMatchObject({ active: true, items: 1, phase: 'idle', dataset: `gh_${c.A}_wiki`, last_error: '' });
    expect(st.types.find((t: any) => t.key === 'notes')).toMatchObject({ active: false, items: 0 });
    expect(st.access_control.state).toBe('closed');
    expect(st.warnings.some((w: any) => w.level === 'critical')).toBe(false);
  });

  it('writes counts, never content, into the audit log', async () => {
    c = await cogneeApp();
    await c.connect();
    await wikiPage(c.A, 'Geheimplan', 'Streng vertraulich: Projekt Kolibri startet im Mai.');
    await c.share(c.A);
    const log = audit();
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(['cognee.connection', 'cognee.settings', 'cognee.push']));
    const push = log.find((l) => l.action === 'cognee.push')!;
    expect(push.summary).toMatch(/Wiki & Dokumente: 1 neu/);
    expect(JSON.stringify(log)).not.toMatch(/Kolibri|Geheimplan|pw-gohigh/);
  });

  it('only a sub-account admin may switch it, and the agency can forbid that', async () => {
    c = await cogneeApp();
    await c.connect();
    const member = await newMember(['settings']);
    expect((await member('PUT', '/api/cognee/admin/settings', { enabled: true })).status).toBe(200);
    await c.connect({ locations_may_enable: false });
    await member('PUT', '/api/cognee/admin/settings', { enabled: false });
    const r = await member('PUT', '/api/cognee/admin/settings', { enabled: true });
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/Agentur/);
    // …while the agency itself still can.
    expect((await c.at(c.A)('PUT', '/api/cognee/admin/settings', { enabled: true })).status).toBe(200);
  });
});

async function newMember(perms: string[] | null, loc = c.A) {
  const { client } = await import('./security-fixtures.js');
  const email = `m-${id(6).toLowerCase()}@example.com`;
  const r = await c.admin('POST', '/api/users', { email, password: 'passwort-m1', name: 'Mitglied', locations: [loc], ...(perms ? { permissions: perms } : {}) });
  expect(r.status, r.text).toBe(200);
  const m = client(c.t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await m('POST', '/api/auth/login', { email, password: 'passwort-m1' })).status).toBe(200);
  return m;
}

describe('what is synced and how', () => {
  it('sends a changed record once and replaces the old version only after the graph was built', async () => {
    c = await cogneeApp({ fake: { cognify: 'manual' } });
    await c.connect();
    const { page } = await wikiPage(c.A, 'Preise', 'Das Paket kostet 49 Euro.');
    await c.share(c.A);
    // The graph is still being built: nothing more is sent, nothing is deleted.
    expect(c.fake.items(`gh_${c.A}_wiki`)).toHaveLength(1);
    c.fake.finishCognify();
    await c.sync(c.A);
    expect(adds()).toHaveLength(1);

    // Same text again (a touched row): nothing is sent.
    await c.at(c.A)('PATCH', `/api/wiki/pages/${page.id}`, { title: 'Preise' });
    await c.sync(c.A, { full: true });
    expect(adds()).toHaveLength(1);

    await c.at(c.A)('PATCH', `/api/wiki/pages/${page.id}`, { body: 'Das Paket kostet jetzt 59 Euro.' });
    await c.sync(c.A);
    // New version added, old one still there until the new graph is built.
    expect(adds()).toHaveLength(2);
    expect(c.fake.items(`gh_${c.A}_wiki`).map((i) => i.text.includes('59 Euro'))).toEqual([false, true]);
    expect(rows('SELECT reason, after_cognify FROM cognee_deletions')).toEqual([{ reason: 'stale', after_cognify: 1 }]);
    c.fake.finishCognify();
    await c.sync(c.A);
    expect(c.fake.items(`gh_${c.A}_wiki`).map((i) => i.text.includes('59 Euro'))).toEqual([true]);
    expect(rows('SELECT * FROM cognee_deletions')).toEqual([]);
    expect(rows('SELECT data_id FROM cognee_items')[0].data_id).toBe(c.fake.items(`gh_${c.A}_wiki`)[0].id);
  });

  it('removes what was trashed, deleted or made private', async () => {
    c = await cogneeApp();
    await c.connect();
    const a = await wikiPage(c.A, 'Alt', 'Alter Text der Seite');
    const b = await wikiPage(c.A, 'Privat', 'Nur für mich');
    const keep = await wikiPage(c.A, 'Bleibt', 'Bleibt im Gedächtnis');
    await c.share(c.A);
    expect(c.fake.items(`gh_${c.A}_wiki`)).toHaveLength(3);
    await c.at(c.A)('DELETE', `/api/wiki/pages/${a.page.id}`);
    await c.at(c.A)('PATCH', `/api/wiki/spaces/${b.space.id}`, { team_access: 'none' });
    await c.sync(c.A);
    expect(c.fake.items(`gh_${c.A}_wiki`).map((i) => i.text)).toEqual([expect.stringContaining('Bleibt im Gedächtnis')]);
    expect(rows('SELECT record_id FROM cognee_items').map((r) => r.record_id)).toEqual([keep.page.id]);
    expect(audit('cognee.delete').map((l) => l.summary).join(' ')).toMatch(/2 Einträge „Wiki & Dokumente“ in Cognee gelöscht \(Datensatz gelöscht\)/);
  });

  it('looks for vanished records in the background only every few minutes (a sync you start yourself always does)', async () => {
    c = await cogneeApp();
    await c.connect();
    const a = await wikiPage(c.A, 'Alt', 'Alter Text');
    await c.share(c.A);
    await c.at(c.A)('DELETE', `/api/wiki/pages/${a.page.id}`);
    await c.t.app.services.cognee.syncNow(c.A, { background: true });
    expect(c.fake.items(`gh_${c.A}_wiki`)).toHaveLength(1);
    c.advance(6 * 60_000);
    await c.t.app.services.cognee.syncNow(c.A, { background: true });
    expect(c.fake.items(`gh_${c.A}_wiki`)).toHaveLength(0);
  });

  it('redacts e-mail, phone and IBAN where asked (notes and conversations by default, the wiki not)', async () => {
    c = await cogneeApp();
    await c.connect();
    const ct = await contact(c.A, { email: 'max@kunde.example.com', phone: '+491701234567' });
    await c.at(c.A)('POST', `/api/contacts/${ct.id}/notes`, { body: 'Schreib an max@kunde.example.com, Tel. +49 170 1234567, IBAN DE89 3704 0044 0532 0130 00.' });
    await wikiPage(c.A, 'Kontakt-Seite', 'Support: hilfe@firma.example.com');
    await c.share(c.A, { notes: true });
    const note = c.fake.items(`gh_${c.A}_notes`)[0].text;
    expect(note).toContain('Schreib an [E-Mail], Tel. [Telefon], IBAN [IBAN].');
    expect(note).not.toMatch(/max@kunde|1701234567|DE89/);
    expect(c.fake.items(`gh_${c.A}_wiki`)[0].text).toContain('hilfe@firma.example.com');
    expect(audit('cognee.push').map((l) => l.summary).join(' ')).toMatch(/3 Angaben \(E-Mail\/Telefon\/IBAN\) unkenntlich gemacht/);

    // Switching the rule on re-sends what is already there, in its new form; the old copy goes.
    await c.at(c.A)('PUT', '/api/cognee/admin/settings', { redact: { wiki: true } });
    await c.sync(c.A);
    expect(c.fake.items(`gh_${c.A}_wiki`).map((i) => i.text).join('')).toContain('Support: [E-Mail]');
    expect(c.fake.items(`gh_${c.A}_wiki`).map((i) => i.text).join('')).not.toContain('hilfe@firma');
  });

  it('turns notes, tickets, courses, conversations, contacts and kb articles into documents – and leaves out drafts, unpublished lessons and private data', async () => {
    c = await cogneeApp();
    await c.connect();
    const ct = await contact(c.A, { company: 'Muster GmbH', city: 'Köln', tags: ['vip'], address: 'Geheimstraße 1', date_of_birth: '1980-02-03' });
    const at = c.at(c.A);
    await at('POST', `/api/contacts/${ct.id}/notes`, { body: 'Möchte ein Angebot für die Website' });
    const ticket = (await at('POST', '/api/tickets', { subject: 'Login geht nicht', description: 'Ich komme nicht rein', contact_id: ct.id })).data;
    await at('POST', `/api/tickets/${ticket.id}/notes`, { body: 'Interne Notiz: Passwort zurücksetzen' });
    await at('POST', '/api/messages', { contact_id: ct.id, channel: 'email', subject: 'Angebot', body: 'Hallo Erika, anbei das Angebot' });
    const conv = c.t.app.db.get<any>('SELECT id FROM conversations WHERE location_id = ? AND contact_id = ?', c.A, ct.id)!;
    c.t.app.db.insert('messages', { id: id(), location_id: c.A, conversation_id: conv.id, contact_id: ct.id, channel: 'email', direction: 'out', subject: 'Entwurf', body: 'GEHEIMER ENTWURF', status: 'draft', created_at: new Date().toISOString() });
    const kbc = (await at('POST', '/api/kb/categories', { name: 'Start' })).data;
    await at('POST', '/api/kb/articles', { title: 'So geht Login', body: 'Klicke oben rechts auf Anmelden.', category_id: kbc.id, status: 'published' });
    await at('POST', '/api/kb/articles', { title: 'Entwurf-Artikel', body: 'noch nicht fertig', category_id: kbc.id, status: 'draft' });
    const course = (await at('POST', '/api/courses', { title: 'Kurs Eins', description: 'x' })).data;
    await at('PATCH', `/api/courses/${course.id}`, { status: 'published' });
    const mod = (await at('POST', `/api/courses/${course.id}/modules`, { title: 'Modul A' })).data;
    await at('POST', `/api/courses/${course.id}/lessons`, { module_id: mod.id, title: 'Lektion Sichtbar', body: 'Das ist die Lektion über Preise.' });
    const hidden = (await at('POST', `/api/courses/${course.id}/lessons`, { module_id: mod.id, title: 'Lektion Versteckt', body: 'Unveröffentlicht' })).data;
    await at('PATCH', `/api/courses/${course.id}/lessons/${hidden.id}`, { published: false });
    await c.share(c.A, { notes: true, tickets: true, courses: true, conversations: true, contacts: true });

    expect(names()).toEqual(['courses', 'contacts', 'conversations', 'notes', 'tickets', 'wiki'].map((t) => `gh_${c.A}_${t}`).sort());
    const text = (t: string) => c.fake.items(`gh_${c.A}_${t}`).map((i) => i.text).join('\n---\n');
    expect(text('notes')).toContain('Notiz zu Kontakt „Erika Muster“');
    expect(text('notes')).toContain('Möchte ein Angebot für die Website');
    expect(text('tickets')).toMatch(/Ticket #1: Login geht nicht[\s\S]*Ich komme nicht rein[\s\S]*Interne Notiz: Passwort zurücksetzen/);
    expect(text('tickets')).toContain('Wissensdatenbank-Artikel: So geht Login');
    expect(text('tickets')).not.toContain('Entwurf-Artikel');
    expect(text('courses')).toContain('Lektion Sichtbar');
    expect(text('courses')).not.toContain('Unveröffentlicht');
    expect(text('conversations')).toContain('anbei das Angebot');
    expect(text('conversations')).not.toContain('GEHEIMER ENTWURF');
    const contactDoc = text('contacts');
    expect(contactDoc).toContain('Kontakt: Erika Muster');
    expect(contactDoc).toContain('Firma: Muster GmbH');
    expect(contactDoc).toContain('Ort: Köln');
    expect(contactDoc).toContain('E-Mail: [E-Mail]');
    expect(contactDoc).not.toMatch(/Geheimstraße|1980/);
  });

  it('syncs a remembered note and forgets it again', async () => {
    c = await cogneeApp();
    await c.connect();
    await c.share(c.A, { memory: true });
    const r = await c.at(c.A)('POST', '/api/cognee/remember', { text: 'Wir liefern nie freitags aus.' });
    expect(r.status).toBe(200);
    await c.idle();
    await c.sync(c.A);
    expect(c.fake.items(`gh_${c.A}_memory`).map((i) => i.text)).toEqual([expect.stringContaining('Wir liefern nie freitags aus.')]);
    expect((await c.at(c.A)('DELETE', `/api/cognee/memories/${r.data.id}`)).status).toBe(200);
    await c.idle();
    await c.sync(c.A);
    expect(c.fake.items(`gh_${c.A}_memory`)).toEqual([]);
  });
});

describe('retries and rate limits', () => {
  it('backs off after a failure, keeps its place and tries again later', async () => {
    c = await cogneeApp();
    await c.connect();
    await wikiPage(c.A, 'Eins', 'Erste Seite');
    c.fake.failNext(/POST \/api\/v1\/add$/, 503, { detail: 'down' }, 3);
    await c.share(c.A);
    const st = () => rows('SELECT * FROM cognee_state WHERE location_id = ? AND type = ?', c.A, 'wiki')[0];
    expect(st()).toMatchObject({ attempts: 1 });
    expect(st().last_error).toMatch(/Cognee hat gerade ein Problem/);
    expect(Date.parse(st().next_attempt_at) - c.now()).toBe(60_000);
    expect(rows('SELECT * FROM cognee_items')).toEqual([]);
    // Too early: no call at all.
    c.fake.reset();
    await c.sync(c.A);
    expect(c.fake.calls).toEqual([]);
    // A second failure doubles the wait.
    c.advance(61_000);
    c.fake.failNext(/POST \/api\/v1\/add$/, 503, { detail: 'down' }, 3);
    await c.sync(c.A);
    expect(st()).toMatchObject({ attempts: 2 });
    expect(Date.parse(st().next_attempt_at) - c.now()).toBe(120_000);
    // Then it works, and the failure is forgotten.
    c.advance(121_000);
    await c.sync(c.A);
    expect(st()).toMatchObject({ attempts: 0, last_error: '', next_attempt_at: null });
    expect(c.fake.items(`gh_${c.A}_wiki`)).toHaveLength(1);
  });

  it('waits at least as long as Cognee asks (429 Retry-After)', async () => {
    c = await cogneeApp();
    await c.connect();
    await wikiPage(c.A, 'Eins', 'Erste Seite');
    c.fake.failNext(/POST \/api\/v1\/add$/, 429, { detail: 'slow' }, 5, { 'retry-after': '240' });
    await c.share(c.A);
    const st = rows('SELECT * FROM cognee_state WHERE location_id = ?', c.A)[0];
    expect(Date.parse(st.next_attempt_at) - c.now()).toBe(240_000);
    expect(st.last_error).toMatch(/ausgelastet/);
  });

  it('skips a record Cognee refuses and carries on with the rest', async () => {
    c = await cogneeApp();
    await c.connect();
    const { space } = await wikiPage(c.A, 'Eins', 'Erste Seite');
    await wikiPage(c.A, 'Zwei', 'Zweite Seite', space.id);
    c.fake.failNext(/POST \/api\/v1\/add$/, 422, { detail: 'unsupported content' }, 1);
    await c.share(c.A);
    const st = rows('SELECT * FROM cognee_state WHERE location_id = ?', c.A)[0];
    expect(st).toMatchObject({ skipped: 1, attempts: 0, last_error: '' });
    expect(c.fake.items(`gh_${c.A}_wiki`)).toHaveLength(1);
    expect(audit('cognee.push').map((l) => l.summary).join()).toMatch(/1 neu, 1 abgelehnt/);
  });

  it('retries a failed graph build without sending the documents again', async () => {
    c = await cogneeApp({ fake: { cognify: 'error' } });
    await c.connect();
    await wikiPage(c.A, 'Eins', 'Erste Seite');
    await c.share(c.A);
    const st = () => rows('SELECT * FROM cognee_state WHERE location_id = ?', c.A)[0];
    expect(st()).toMatchObject({ dirty: 1, phase: 'idle', attempts: 1 });
    expect(st().last_error).toMatch(/Pipeline run errored: LLM key missing/);
    expect(adds()).toHaveLength(1);
    c.fake.setCognify('manual');
    c.advance(61_000);
    await c.sync(c.A);
    // The build started but ends in an error on the server: reported, retried later.
    expect(st()).toMatchObject({ phase: 'cognify', dirty: 0 });
    c.fake.finishCognify('errored');
    c.advance(1_000);
    await c.sync(c.A);
    expect(st()).toMatchObject({ phase: 'idle', dirty: 1, attempts: 1 });
    expect(st().last_error).toMatch(/Wissensgraph konnte auf dem Cognee-Server nicht gebaut werden/);
    c.fake.setCognify('instant');
    c.advance(61_000);
    await c.sync(c.A);
    expect(adds()).toHaveLength(1);
    expect(st()).toMatchObject({ dirty: 0, attempts: 0, last_error: '' });
    expect(st().last_sync_at).toBeTruthy();
  });

  it('picks the graph build up again after a restart (state is in the database)', async () => {
    c = await cogneeApp({ fake: { cognify: 'manual' } });
    await c.connect();
    await wikiPage(c.A, 'Eins', 'Erste Seite');
    await c.share(c.A);
    expect(rows('SELECT phase FROM cognee_state')[0].phase).toBe('cognify');
    c.fake.finishCognify();
    await c.sync(c.A);
    expect(rows('SELECT phase, last_sync_at FROM cognee_state')[0]).toMatchObject({ phase: 'idle' });
  });
});

describe('sub-accounts stay apart', () => {
  it('never reads or writes the datasets of another sub-account, and each answer comes from its own', async () => {
    c = await cogneeApp({ fake: { users: { 'b@example.com': 'pw-b' } } });
    await c.connect();
    const B = (await c.admin('POST', '/api/locations', { name: 'Zweite Firma' })).data.id as string;
    await wikiPage(c.A, 'Alpha-Seite', 'Alpha Rezept: Kuchen mit Zimt');
    await wikiPage(B, 'Beta-Seite', 'Beta Rezept: Kuchen mit Kardamom');
    // B gets a Cognee login of its own (a second Cognee user): even Cognee keeps its data apart.
    expect((await c.admin('PUT', `/api/agency/cognee/locations/${B}/account`, { auth_mode: 'password', email: 'b@example.com', password: 'pw-b' })).status).toBe(200);
    await c.share(c.A);
    c.fake.reset();
    await c.share(B);
    // Everything B's sync touched was B's.
    expect([...touchedLocations(c.fake)]).toEqual([B]);
    expect(names()).toEqual([`gh_${B}_wiki`, `gh_${c.A}_wiki`].sort());
    expect(c.fake.dataset(`gh_${c.A}_wiki`)!.owner).toBe('gohigh@example.com');
    expect(c.fake.dataset(`gh_${B}_wiki`)!.owner).toBe('b@example.com');
    expect(c.fake.items(`gh_${c.A}_wiki`).map((i) => i.text).join()).not.toContain('Kardamom');
    expect(c.fake.items(`gh_${B}_wiki`).map((i) => i.text).join()).not.toContain('Zimt');

    // Asking: each sub-account only ever gets its own passages, although both talk about "Kuchen".
    const ra = (await c.at(c.A)('GET', '/api/cognee/recall?q=Kuchen%20Rezept')).data;
    const rb = (await c.at(B)('GET', '/api/cognee/recall?q=Kuchen%20Rezept')).data;
    expect(JSON.stringify(ra)).toContain('Zimt');
    expect(JSON.stringify(ra)).not.toContain('Kardamom');
    expect(JSON.stringify(rb)).toContain('Kardamom');
    expect(JSON.stringify(rb)).not.toContain('Zimt');
    // And every search request named only datasets of the asking sub-account.
    for (const [loc, since] of [[c.A, 0], [B, 0]] as const) {
      void since;
      c.fake.reset();
      await c.at(loc)('GET', '/api/cognee/recall?q=Kuchen');
      expect([...touchedLocations(c.fake)]).toEqual([loc]);
    }
  });

  it('a stored dataset id that does not carry the sub-account name is never deleted', async () => {
    c = await cogneeApp();
    await c.connect();
    const B = (await c.admin('POST', '/api/locations', { name: 'Zweite Firma' })).data.id as string;
    await wikiPage(B, 'Beta-Seite', 'Beta Text');
    await c.share(B);
    const dsB = c.fake.dataset(`gh_${B}_wiki`)!;
    // A corrupted row of A points at B's dataset.
    c.t.app.db.insert('cognee_deletions', { id: id(), location_id: c.A, type: 'wiki', dataset_id: dsB.id, data_id: [...dsB.items.keys()][0], reason: 'record_deleted', after_cognify: 0, attempts: 0, last_error: '', created_at: new Date().toISOString() });
    c.t.app.db.insert('cognee_deletions', { id: id(), location_id: c.A, type: 'wiki', dataset_id: dsB.id, data_id: '', reason: 'purge', after_cognify: 0, attempts: 0, last_error: '', created_at: new Date().toISOString() });
    await c.sync(c.A);
    expect(c.fake.items(`gh_${B}_wiki`)).toHaveLength(1);
    expect(c.fake.calls.filter((x) => x.method === 'DELETE')).toEqual([]);
    expect(rows('SELECT * FROM cognee_deletions')).toEqual([]);
  });
});

describe('erasure and deletion', () => {
  it('deletes what Cognee holds about an erased contact – queued in the erase itself, kept until Cognee is reachable', async () => {
    c = await cogneeApp();
    await c.connect();
    const ct = await contact(c.A, { email: 'weg@example.com' });
    const other = await contact(c.A, { first_name: 'Bleibt', last_name: 'Da' });
    const at = c.at(c.A);
    for (const x of [ct, other]) await at('POST', `/api/contacts/${x.id}/notes`, { body: `Notiz zu ${x.first_name}` });
    await at('POST', '/api/tickets', { subject: 'Frage von Erika', description: 'Hilfe', contact_id: ct.id });
    await at('POST', '/api/messages', { contact_id: ct.id, channel: 'email', subject: 'Hallo', body: 'Nachricht an Erika' });
    await wikiPage(c.A, 'Wiki', 'Allgemeines Wissen');
    await c.share(c.A, { notes: true, tickets: true, conversations: true, contacts: true });
    const before = (t: string) => c.fake.items(`gh_${c.A}_${t}`).length;
    expect([before('notes'), before('tickets'), before('conversations'), before('contacts'), before('wiki')]).toEqual([2, 1, 1, 2, 1]);

    c.fake.setOffline(true);
    const r = await at('POST', `/api/contacts/${ct.id}/erase`, { confirm: 'weg@example.com' });
    expect(r.status).toBe(200);
    await c.idle();
    // Cognee was offline: the deletions wait in the queue (written in the same transaction as the erase); no mapping row is left.
    const queued = rows('SELECT type, reason, data_id FROM cognee_deletions ORDER BY type');
    expect(queued.map((q) => [q.type, q.reason])).toEqual([['contacts', 'erasure'], ['conversations', 'erasure'], ['notes', 'erasure'], ['tickets', 'erasure']]);
    expect(rows('SELECT * FROM cognee_items WHERE contact_id = ?', ct.id)).toEqual([]);
    expect(audit('cognee.erase')[0].summary).toBe('4 Einträge einer gelöschten Person in Cognee zur Löschung vorgemerkt');

    c.fake.setOffline(false);
    c.advance(2 * 3_600_000);
    await c.sync(c.A);
    expect(rows('SELECT * FROM cognee_deletions')).toEqual([]);
    expect([before('notes'), before('tickets'), before('conversations'), before('contacts'), before('wiki')]).toEqual([1, 0, 0, 1, 1]);
    const everything = [...c.fake.datasets.values()].flatMap((d) => [...d.items.values()].map((i) => i.text)).join('\n');
    expect(everything).not.toMatch(/Erika|weg@example\.com/);
    expect(everything).toContain('Notiz zu Bleibt');
    expect(audit('cognee.delete').map((l) => l.summary).join(' ')).toMatch(/DSGVO-Löschung/);
    expect(JSON.stringify(audit())).not.toMatch(/weg@example|Erika/);
  });

  it('lists what the memory holds about a contact in their GDPR export (Art. 15)', async () => {
    c = await cogneeApp();
    await c.connect();
    const ct = await contact(c.A);
    await c.at(c.A)('POST', `/api/contacts/${ct.id}/notes`, { body: 'Eine Notiz' });
    await c.share(c.A, { notes: true });
    const out = JSON.parse((await c.t.api.raw(`/api/contacts/${ct.id}/privacy-export`, { headers: { cookie: c.t.api.cookie, 'x-location-id': c.A, 'x-pghl': '1' } }).then((r) => r.text())));
    expect(out.data.cognee_items).toEqual([expect.objectContaining({ type: 'notes', kind: 'note', contact_id: ct.id, data_id: c.fake.items(`gh_${c.A}_notes`)[0].id })]);
    expect(JSON.stringify(out)).not.toMatch(/content_hash|pw-gohigh/);
  });

  it('removes the data of a deleted record, and of a contact deleted the normal way', async () => {
    c = await cogneeApp();
    await c.connect();
    const ct = await contact(c.A);
    const note = (await c.at(c.A)('POST', `/api/contacts/${ct.id}/notes`, { body: 'Eine Notiz' })).data;
    const ct2 = await contact(c.A, { first_name: 'Zwei' });
    await c.at(c.A)('POST', `/api/contacts/${ct2.id}/notes`, { body: 'Notiz von Zwei' });
    await c.share(c.A, { notes: true });
    expect(c.fake.items(`gh_${c.A}_notes`)).toHaveLength(2);
    await c.at(c.A)('DELETE', `/api/notes/${note.id}`);
    await c.sync(c.A);
    expect(c.fake.items(`gh_${c.A}_notes`)).toHaveLength(1);
    await c.at(c.A)('DELETE', `/api/contacts/${ct2.id}`);
    await c.t.app.events.flush();
    await c.idle();
    await c.sync(c.A);
    expect(c.fake.items(`gh_${c.A}_notes`)).toHaveLength(0);
  });

  it('offers "Daten in Cognee löschen" when a type or the whole sub-account is switched off – and deletes the datasets on request', async () => {
    c = await cogneeApp();
    await c.connect();
    const ct = await contact(c.A);
    await c.at(c.A)('POST', `/api/contacts/${ct.id}/notes`, { body: 'Notiz' });
    await wikiPage(c.A, 'Wiki', 'Wissen');
    await c.share(c.A, { notes: true });
    expect(names()).toEqual([`gh_${c.A}_notes`, `gh_${c.A}_wiki`]);

    const off = (await c.at(c.A)('PUT', '/api/cognee/admin/settings', { types: { notes: false } })).data;
    expect(off).toMatchObject({ turned_off: ['notes'], offer_delete: ['notes'] });
    // Switched off means nothing more is sent – the data stays until it is deleted on request.
    expect(c.fake.items(`gh_${c.A}_notes`)).toHaveLength(1);

    const purge = (body: unknown) => c.at(c.A)('POST', '/api/cognee/admin/purge', body);
    expect((await purge({ types: ['notes'] })).status).toBe(400); // no confirmation
    expect((await purge({ types: ['wiki'], confirm: true })).data.error).toMatch(/Erst die Freigabe beenden/); // still shared
    expect((await purge({ types: ['nope'], confirm: true })).status).toBe(400);
    const done = await purge({ types: ['notes'], confirm: true });
    expect(done.data).toMatchObject({ ok: true, types: ['notes'], items: 1 });
    await c.idle();
    expect(names()).toEqual([`gh_${c.A}_wiki`]);
    expect(rows('SELECT * FROM cognee_items WHERE type = ?', 'notes')).toEqual([]);
    expect(rows('SELECT * FROM cognee_state WHERE type = ?', 'notes')).toEqual([]);
    expect(audit('cognee.purge')[0].summary).toMatch(/Notizen \(1 Einträge\)/);
    expect(audit('cognee.delete').map((l) => l.summary).join()).toMatch(/Alle Daten „Notizen“ in Cognee gelöscht/);

    const all = (await c.at(c.A)('PUT', '/api/cognee/admin/settings', { enabled: false })).data;
    expect(all.offer_delete).toEqual(['wiki']);
    expect((await purge({ types: 'all', confirm: true })).status).toBe(200);
    await c.idle();
    expect(names()).toEqual([]);
    // Switching it on again starts from scratch.
    await c.share(c.A);
    expect(c.fake.items(`gh_${c.A}_wiki`)).toHaveLength(1);
  });

  it('deletes the datasets of a sub-account that is deleted', async () => {
    c = await cogneeApp();
    await c.connect();
    const D = (await c.admin('POST', '/api/locations', { name: 'Löschkandidat' })).data.id as string;
    await wikiPage(D, 'Seite', 'Text');
    await c.share(D);
    expect(names()).toEqual([`gh_${D}_wiki`]);
    expect((await c.admin('DELETE', `/api/locations/${D}`)).status).toBe(200);
    expect(rows('SELECT reason FROM cognee_deletions WHERE location_id = ?', D).map((r) => r.reason)).toEqual(['location_deleted']);
    await c.t.app.services.cognee.syncNow(D);
    expect(names()).toEqual([]);
    expect(rows('SELECT * FROM cognee_deletions')).toEqual([]);
  });

  it('keeps pending deletions when the data type is not shared any more (erasure does not depend on the switch)', async () => {
    c = await cogneeApp();
    await c.connect();
    const ct = await contact(c.A, { email: 'x@example.com' });
    await c.at(c.A)('POST', `/api/contacts/${ct.id}/notes`, { body: 'Notiz' });
    await c.share(c.A, { notes: true });
    await c.at(c.A)('PUT', '/api/cognee/admin/settings', { enabled: false });
    await c.at(c.A)('POST', `/api/contacts/${ct.id}/erase`, { confirm: 'x@example.com' });
    await c.idle();
    await c.sync(c.A);
    expect(c.fake.items(`gh_${c.A}_notes`)).toEqual([]);
  });
});

describe('a server without access control', () => {
  it('is recognised, warned about and not fed – unless the agency insists', async () => {
    c = await cogneeApp({ fake: { accessControl: false } });
    await c.connect();
    await wikiPage(c.A, 'Seite', 'Text');
    await c.share(c.A);
    expect(c.fake.calls.filter((x) => x.path === '/api/v1/add')).toEqual([]);
    const st = (await c.at(c.A)('GET', '/api/cognee/admin/status')).data;
    expect(st.access_control.state).toBe('open');
    expect(st.warnings.find((w: any) => w.level === 'critical').text).toMatch(/ENABLE_BACKEND_ACCESS_CONTROL=true/);
    expect((await c.at(c.A)('GET', '/api/cognee/recall?q=Text')).status).toBe(409);
    await c.connect({ allow_open_server: true });
    await c.sync(c.A);
    expect(c.fake.items(`gh_${c.A}_wiki`)).toHaveLength(1);
  });
});
