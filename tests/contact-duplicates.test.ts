import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkTables } from '../server/services/contact-merge.js';
import { startTestApp } from './helpers.js';

/**
 * The duplicate assistant on a real address book: finding, the side-by-side preview, merging with a field picker (everything that
 * pointed at the second contact moves – found through the schema – the two conversations become one), what cannot move, who may merge,
 * and "Rückgängig" putting every single row back.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let pipe: any;
let model = '';
let n = 0;
const undoId = (r: { headers: Headers }) => r.headers.get('x-undo-id')!;
const row = (sql: string, ...p: any[]) => t.app.db.get<any>(sql, ...p);
const rows = (sql: string, ...p: any[]) => t.app.db.all<any>(sql, ...p);
/** The company links of a contact, whichever way round the association is stored. */
const companyLinks = (cid: string, company?: string) => rows(`SELECT 1 FROM associations WHERE ((a_type = 'contact' AND a_id = ? AND b_type = 'company'${company ? ' AND b_id = ?' : ''}) OR (b_type = 'contact' AND b_id = ? AND a_type = 'company'${company ? ' AND a_id = ?' : ''}))`, ...(company ? [cid, company, cid, company] : [cid, cid])).length;

/** A contact straight into the table: the API merges people with the same e-mail address, which is exactly what we want to avoid here. */
function raw(extra: Record<string, unknown> = {}) {
  const id = `ct${String(++n).padStart(6, '0')}`;
  t.app.db.insert('contacts', { id, location_id: loc, first_name: 'Anna', last_name: 'Muster', email: '', phone: '', company: '', address: '', city: '', postal_code: '', country: '', website: '', source: 'test', tags: [], custom: {}, dnd: 0, created_at: new Date(Date.now() - 864e5 * (100 - n)).toISOString(), updated_at: new Date().toISOString(), ...extra });
  return id;
}

/** Everything that hangs on two contacts, in a form two moments can be compared in. */
function world(ids: string[]) {
  const out: Record<string, unknown> = {};
  const marks = ids.map(() => '?').join(',');
  for (const tb of linkTables(t.app).move) {
    if (!tb.pk.length) continue;
    const cols = [...tb.pk, 'contact_id', ...(tb.cols.includes('conversation_id') ? ['conversation_id'] : [])];
    const found = rows(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${tb.table}" WHERE contact_id IN (${marks}) ORDER BY ${tb.pk.map((c) => `"${c}"`).join(', ')}`, ...ids);
    if (found.length) out[tb.table] = found;
  }
  out.contacts = rows(`SELECT * FROM contacts WHERE id IN (${marks}) ORDER BY id`, ...ids).map(({ updated_at, last_activity_at, ...r }) => r);
  out.conversations = rows(`SELECT * FROM conversations WHERE contact_id IN (${marks}) ORDER BY id`, ...ids);
  out.associations = rows(`SELECT id, a_type, a_id, b_type, b_id, labels, primary_of FROM associations WHERE (a_type = 'contact' AND a_id IN (${marks})) OR (b_type = 'contact' AND b_id IN (${marks})) ORDER BY id`, ...ids, ...ids);
  return out;
}

/** Notes, a task, a deal, a message (own conversation), an invoice draft and consent proof for a contact. */
async function furnish(cid: string, tag: string) {
  await t.api.post(`/api/contacts/${cid}/notes`, { body: `Notiz ${tag}` });
  await t.api.post('/api/tasks', { title: `Aufgabe ${tag}`, contact_id: cid });
  await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: cid, name: `Deal ${tag}`, value: 1000 });
  const m = await t.api.post('/api/messages', { contact_id: cid, channel: 'email', subject: `Betreff ${tag}`, body: `Nachricht ${tag}` });
  expect(m.status, JSON.stringify(m.data)).toBe(200);
  await t.api.post('/api/invoices', { contact_id: cid, items: [{ name: 'Beratung', qty: 1, price_cents: 10000, tax_rate: 19 }] });
  expect((await t.api.post(`/api/contacts/${cid}/consent`, { action: 'granted', channel: 'email', note: `Schriftlich ${tag}` })).status).toBe(200);
}

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: ['Neu', 'Gewonnen'] })).data;
  model = (await t.api.post('/api/lead-scoring/models', { name: 'Modell', active: true, is_primary: true, rules: [{ kind: 'event', event: 'message.inbound', points: 5 }], thresholds: [{ label: 'MQL', min: 1 }] })).data.id;
  expect(model).toBeTruthy();
}, 60_000);
const score = (cid: string, points: number) =>
  t.app.db.run(`INSERT INTO lead_scores (model_id, contact_id, location_id, score, calculated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(model_id, contact_id) DO UPDATE SET score = excluded.score`, model, cid, loc, points, new Date().toISOString());
afterAll(() => t.close());

describe('finding', () => {
  it('groups probable duplicates with the reason, a suggestion and what hangs on each', async () => {
    const a = raw({ email: 'anna@firma.example', company: 'Firma GmbH', city: 'Berlin', phone: '+49 151 1234567' });
    const b = raw({ email: 'ANNA@firma.example', phone: '' });
    const c = raw({ first_name: 'Anne', last_name: 'Muster', phone: '0151-1234567' });
    const other = raw({ first_name: 'Berta', last_name: 'Schulz', email: 'berta@x.example' });
    await furnish(b, 'B');
    const r = (await t.api.get('/api/contact-duplicates')).data;
    expect(r.scanned).toBeGreaterThanOrEqual(4);
    const g = r.groups.find((x: any) => x.contacts.some((c2: any) => c2.id === a));
    expect(g.contacts.map((x: any) => x.id).sort()).toEqual([a, b, c].sort());
    expect(g).toMatchObject({ confidence: 'high', keep: a });
    expect(g.reasons).toEqual(expect.arrayContaining(['email', 'phone']));
    expect(g.contacts.find((x: any) => x.id === b).counts).toMatchObject({ Notizen: 1, Aufgaben: 1, Deals: 1, Nachrichten: 1, Rechnungen: 1 });
    expect(r.groups.some((x: any) => x.contacts.some((c2: any) => c2.id === other))).toBe(false);
    expect(r.reasons.email).toBe('Gleiche E-Mail-Adresse');
    expect((await t.api.get('/api/contact-duplicates?min=high')).data.groups.length).toBeGreaterThan(0);
  });

  it('"not the same person" removes a pair for good; the banner on a contact page shows its duplicates', async () => {
    const a = raw({ first_name: 'Team', last_name: 'Postfach', email: 'info@gemeinsam.example' });
    const b = raw({ first_name: 'Anderer', last_name: 'Mensch', email: 'info@gemeinsam.example' });
    const has = async () => (await t.api.get('/api/contact-duplicates')).data.groups.some((x: any) => x.contacts.some((c: any) => c.id === a));
    expect(await has()).toBe(true);
    const near = (await t.api.get(`/api/contact-duplicates/for?contact_id=${a}`)).data;
    expect(near.map((x: any) => x.id)).toEqual([b]);
    expect(near[0].reason_labels).toEqual(['Gleiche E-Mail-Adresse']);
    expect((await t.api.post('/api/contact-duplicates/ignore', { contact_ids: [a] })).status).toBe(400);
    expect((await t.api.post('/api/contact-duplicates/ignore', { contact_ids: [a, b] })).data).toMatchObject({ ok: true, pairs: 1 });
    expect(await has()).toBe(false);
    expect((await t.api.get(`/api/contact-duplicates/for?contact_id=${a}`)).data).toEqual([]);
    expect((await t.api.post('/api/contact-duplicates/unignore', { contact_ids: [a, b] })).data.pairs).toBe(1);
    expect(await has()).toBe(true);
    expect((await t.api.get('/api/contact-duplicates/for?contact_id=gibtsnicht')).status).toBe(404);
  });
});

describe('merging', () => {
  it('preview: field by field, what moves, what falls away', async () => {
    const keep = raw({ email: 'karl@x.example', first_name: 'Karl', last_name: 'Klein', company: 'Klein AG', city: '', tags: ['kunde'], custom: { branche: 'Bau' }, dnd: 0 });
    const from = raw({ email: 'karl@x.example', first_name: 'Karl', last_name: 'Klein', phone: '+49 160 5550000', city: 'Köln', company: 'Klein AG', tags: ['lead'], custom: { branche: 'Handel', größe: '50' }, dnd: 1 });
    await furnish(from, 'K');
    score(from, 5);
    const p = (await t.api.get(`/api/contact-duplicates/preview?keep_id=${keep}&from_id=${from}`)).data;
    const f = (k: string) => p.fields.find((x: any) => x.key === k);
    expect(f('phone')).toMatchObject({ keep: '', from: '+49 160 5550000', differs: false, pick: 'from' });
    expect(f('city')).toMatchObject({ keep: '', from: 'Köln', pick: 'from' });
    expect(f('company')).toMatchObject({ differs: false, pick: 'keep' });
    expect(p.custom.find((x: any) => x.key === 'custom.branche')).toMatchObject({ keep: 'Bau', from: 'Handel', differs: true, pick: 'keep' });
    expect(p.custom.find((x: any) => x.key === 'custom.größe')).toMatchObject({ keep: '', from: '50', pick: 'from' });
    expect(p.tags.merged.sort()).toEqual(['kunde', 'lead']);
    expect(p.moves).toEqual(expect.arrayContaining([{ label: 'Notizen', from: 1, keep: 0 }, { label: 'Deals', from: 1, keep: 0 }]));
    expect(p.reasons.map((x: any) => x.key)).toContain('email');
    expect(p.notes.join(' ')).toMatch(/Nicht stören/);
    expect(p.frozen_invoices).toBe(0);
    expect((await t.api.get(`/api/contact-duplicates/preview?keep_id=${keep}&from_id=${keep}`)).status).toBe(400);
    expect((await t.api.get(`/api/contact-duplicates/preview?keep_id=${keep}&from_id=gibtsnicht`)).status).toBe(404);
  });

  it('everything moves, the picks decide the fields, the conversations become one – and Rückgängig puts every row back', async () => {
    const keep = raw({ email: 'olga@x.example', first_name: 'Olga', last_name: 'Ost', company: 'Ost GmbH', tags: ['kunde'], custom: { branche: 'Bau' }, assigned_to: null });
    const from = raw({ email: 'olga@x.example', first_name: 'Olga', last_name: 'Ost', phone: '0170 1112222', city: 'Köln', company: 'Ost GmbH', tags: ['lead'], custom: { branche: 'Handel', größe: '50' } });
    await furnish(keep, 'Keep');
    await furnish(from, 'From');
    // links to a company, a running sequence
    const company = (await t.api.post('/api/companies', { name: 'Ost GmbH', domain: 'ost.example' })).data;
    expect((await t.api.post('/api/associations', { from_type: 'contact', from_id: from, to_type: 'company', to_id: company.id })).status).toBeLessThan(300);
    const seq = (await t.api.post('/api/sequences', { name: 'Anrufen', steps: [{ type: 'call', title: 'Anrufen', delay_days: 5 }] })).data;
    await t.api.patch(`/api/sequences/${seq.id}`, { status: 'active' });
    expect((await t.api.post(`/api/sequences/${seq.id}/enroll`, { contact_ids: [from] })).data.enrolled).toBe(1);
    score(from, 9);
    const convOf = (id: string) => row('SELECT * FROM conversations WHERE contact_id = ?', id);
    const keepConv = convOf(keep).id as string;
    const fromConv = convOf(from).id as string;
    t.app.db.run('UPDATE conversations SET unread = 2, starred = 0 WHERE id = ?', keepConv);
    t.app.db.run('UPDATE conversations SET unread = 3, starred = 1 WHERE id = ?', fromConv);
    // "Nicht stören" is set after the enrolment (it would have kept the contact out)
    t.app.db.run('UPDATE contacts SET dnd = 1 WHERE id = ?', from);
    const consentBefore = rows('SELECT id FROM consent_events WHERE contact_id IN (?, ?) ORDER BY id', keep, from).map((x) => x.id);
    expect(consentBefore.length).toBeGreaterThanOrEqual(2);
    const before = world([keep, from]);
    const ownerFrom = (await t.api.get('/api/me')).data.user.id;
    t.app.db.run('UPDATE contacts SET assigned_to = ? WHERE id = ?', ownerFrom, from);
    const before2 = world([keep, from]);

    const r = await t.api.post('/api/contact-duplicates/merge', { keep_id: keep, from_id: from, picks: { phone: 'from', 'custom.branche': 'from', assigned_to: 'from' } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.moved).toMatchObject({ Notizen: 1, Aufgaben: 1, Deals: 1, Nachrichten: 1, Rechnungen: 1 });
    expect(r.data.dropped).toBeGreaterThanOrEqual(1);

    // the second contact is gone, the kept one has everything
    expect(row('SELECT id FROM contacts WHERE id = ?', from)).toBeUndefined();
    const k = row('SELECT * FROM contacts WHERE id = ?', keep);
    expect(k).toMatchObject({ phone: '0170 1112222', city: 'Köln', dnd: 1, assigned_to: ownerFrom });
    expect(JSON.parse(k.tags).sort()).toEqual(['kunde', 'lead']);
    expect(JSON.parse(k.custom)).toEqual({ branche: 'Handel', größe: '50' });
    const count = (tb: string) => rows(`SELECT 1 FROM ${tb} WHERE contact_id = ?`, keep).length;
    expect([count('notes'), count('tasks'), count('opportunities'), count('messages'), count('invoices'), count('consent_events')]).toEqual([2, 2, 2, 2, 2, consentBefore.length]);
    // the proof of both contacts, and nothing new (a "Nicht stören" that came along writes no second revocation)
    expect(rows('SELECT id FROM consent_events WHERE contact_id = ? ORDER BY id', keep).map((x) => x.id)).toEqual(consentBefore);
    expect(rows('SELECT 1 FROM consent_events WHERE contact_id = ?', from)).toHaveLength(0);
    // one conversation with both messages and the sum of what was unread
    expect(rows('SELECT id FROM conversations WHERE contact_id IN (?, ?)', keep, from).map((x) => x.id)).toEqual([keepConv]);
    expect(rows('SELECT conversation_id FROM messages WHERE contact_id = ?', keep).map((x) => x.conversation_id)).toEqual([keepConv, keepConv]);
    expect(convOf(keep)).toMatchObject({ unread: 5, starred: 1 });
    // the link to the company, the running sequence, the activity that names who was merged
    expect(companyLinks(keep, company.id)).toBe(1);
    // the run moved along – and ended, because the second contact had "Nicht stören" (which holds for the merged one)
    expect(row(`SELECT status, stop_reason FROM sequence_enrollments WHERE contact_id = ?`, keep)).toMatchObject({ status: 'stopped', stop_reason: 'unsubscribed' });
    const act = row(`SELECT * FROM activities WHERE contact_id = ? AND type = 'contact.merged'`, keep);
    expect(JSON.parse(act.data).from).toMatchObject({ id: from, phone: '0170 1112222', email: 'olga@x.example' });
    // the lead score keyed by the second contact fell away with it
    expect(rows('SELECT 1 FROM lead_scores WHERE contact_id = ?', from)).toHaveLength(0);
    // the journal has it as one entry with a clear label
    expect(decodeURIComponent(r.headers.get('x-undo-label') ?? '')).toMatch(/^Kontakte zusammengeführt: .*Olga Ost.*\+.*Olga Ost/);

    // Rückgängig: every row is where it was
    const u = await t.api.post(`/api/undo/${undoId(r)}`, {});
    expect(u.status, JSON.stringify(u.data)).toBe(200);
    // (the run that ended because of "Nicht stören" stays ended and keeps its history – the rest is exactly as it was)
    const { sequence_events: _e, ...after } = world([keep, from]) as Record<string, unknown>;
    const { sequence_events: _b, ...expected } = before2 as Record<string, unknown>;
    expect(after).toEqual(expected);
    expect(row(`SELECT status FROM sequence_enrollments WHERE contact_id = ?`, from)).toMatchObject({ status: 'stopped' });
    expect(rows(`SELECT 1 FROM activities WHERE type = 'contact.merged' AND contact_id IN (?, ?)`, keep, from)).toHaveLength(0);
    expect(row('SELECT id FROM contacts WHERE id = ?', from)).toBeTruthy();
    expect(row('SELECT dnd, phone, city FROM contacts WHERE id = ?', keep)).toMatchObject({ dnd: 0, phone: '', city: '' });
    expect(rows('SELECT 1 FROM lead_scores WHERE contact_id = ?', from)).toHaveLength(1);
    expect(companyLinks(keep)).toBe(0);
    expect(companyLinks(from)).toBe(1);
    expect(before2).not.toEqual(before);
  });

  it('a sequence both contacts are in: the second contact’s run is dropped, the kept one’s goes on', async () => {
    const keep = raw({ email: 'pia@x.example', first_name: 'Pia', last_name: 'Nord' });
    const from = raw({ email: 'pia@x.example', first_name: 'Pia', last_name: 'Nord' });
    const seq = (await t.api.post('/api/sequences', { name: 'Doppelt', steps: [{ type: 'task', title: 'Melden', delay_days: 5 }] })).data;
    await t.api.patch(`/api/sequences/${seq.id}`, { status: 'active' });
    await t.api.post(`/api/sequences/${seq.id}/enroll`, { contact_ids: [keep, from] });
    expect((await t.api.post('/api/contact-duplicates/merge', { keep_id: keep, from_id: from })).status).toBe(200);
    expect(rows('SELECT contact_id, status FROM sequence_enrollments WHERE sequence_id = ?', seq.id)).toEqual([{ contact_id: keep, status: 'active' }]);
  });

  it('finalised invoices cannot change their customer: the merge says so, and goes ahead only when confirmed', async () => {
    const keep = raw({ email: 'rita@x.example', first_name: 'Rita', last_name: 'West' });
    const from = raw({ email: 'rita@x.example', first_name: 'Rita', last_name: 'West' });
    const inv = (await t.api.post('/api/invoices', { contact_id: from, items: [{ name: 'Beratung', qty: 1, price_cents: 10000, tax_rate: 19 }] })).data;
    expect((await t.api.post(`/api/invoices/${inv.id}/finalise`, {})).status).toBe(200);
    const draft = (await t.api.post('/api/invoices', { contact_id: from, items: [{ name: 'Später', qty: 1, price_cents: 500, tax_rate: 19 }] })).data;
    const p = (await t.api.get(`/api/contact-duplicates/preview?keep_id=${keep}&from_id=${from}`)).data;
    expect(p.frozen_invoices).toBe(1);
    expect(p.notes.join(' ')).toMatch(/festgeschriebene Rechnung verliert/);
    const refused = await t.api.post('/api/contact-duplicates/merge', { keep_id: keep, from_id: from });
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ code: 'frozen_invoices', count: 1 });
    expect(row('SELECT id FROM contacts WHERE id = ?', from)).toBeTruthy();
    // swapped roles: the contact with the invoice stays – nothing is lost
    const swapped = await t.api.post('/api/contact-duplicates/merge', { keep_id: from, from_id: keep });
    expect(swapped.status).toBe(200);
    expect(swapped.data.detached_invoices).toBe(0);
    expect(row('SELECT contact_id FROM invoices WHERE id = ?', inv.id).contact_id).toBe(from);
    // and the other direction, confirmed: the finalised invoice stays but loses its customer link, the draft moves
    const keep2 = raw({ email: 'sven@x.example', first_name: 'Sven', last_name: 'Süd' });
    const from2 = raw({ email: 'sven@x.example', first_name: 'Sven', last_name: 'Süd' });
    const inv2 = (await t.api.post('/api/invoices', { contact_id: from2, items: [{ name: 'Beratung', qty: 1, price_cents: 10000, tax_rate: 19 }] })).data;
    await t.api.post(`/api/invoices/${inv2.id}/finalise`, {});
    const draft2 = (await t.api.post('/api/invoices', { contact_id: from2, items: [{ name: 'Später', qty: 1, price_cents: 500, tax_rate: 19 }] })).data;
    const ok = await t.api.post('/api/contact-duplicates/merge', { keep_id: keep2, from_id: from2, confirm_detach: true });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.detached_invoices).toBe(1);
    expect(row('SELECT contact_id FROM invoices WHERE id = ?', inv2.id).contact_id).toBeNull();
    expect(row('SELECT contact_id FROM invoices WHERE id = ?', draft2.id).contact_id).toBe(keep2);
    expect(draft.id).toBeTruthy();
  });

  it('refuses nonsense', async () => {
    const a = raw({ email: 'x1@x.example' });
    expect((await t.api.post('/api/contact-duplicates/merge', { keep_id: a, from_id: a })).status).toBe(400);
    expect((await t.api.post('/api/contact-duplicates/merge', { keep_id: a, from_id: 'gibtsnicht' })).status).toBe(404);
    expect((await t.api.post('/api/contact-duplicates/merge', { keep_id: a })).status).toBe(400);
  });
});

describe('who may merge', () => {
  it('a person with limited access only finds and merges the contacts they may see; hidden fields stay hidden', async () => {
    const mk = async (email: string) => {
      const r = await t.api.post('/api/users', { email, password: 'passwort-123', name: email.split('@')[0], locations: [loc], permissions: ['contacts'] });
      expect(r.status).toBe(200);
      const login = await t.api.raw('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1' }, body: JSON.stringify({ email, password: 'passwort-123' }) });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await t.api.raw(path, { method, headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie, 'x-location-id': loc }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, data: (await res.json().catch(() => ({}))) as any, headers: res.headers };
      };
      return { id: r.data.id as string, call };
    };
    const eva = await mk('eva@example.com');
    const mine1 = raw({ first_name: 'Eva', last_name: 'Eigen', email: 'eva@kunde.example', assigned_to: eva.id });
    const mine2 = raw({ first_name: 'Eva', last_name: 'Eigen', email: 'eva@kunde.example', assigned_to: eva.id, city: 'Bonn' });
    const foreign1 = raw({ first_name: 'Fritz', last_name: 'Fremd', email: 'fritz@kunde.example', assigned_to: null });
    const foreign2 = raw({ first_name: 'Fritz', last_name: 'Fremd', email: 'fritz@kunde.example', assigned_to: null });
    const rule = await t.api.put('/api/sales/access', { enabled: true, unassigned: 'hide', rules: { default: { levels: { contacts: 'own', companies: 'all', deals: 'all', tasks: 'all', conversations: 'all' }, hidden: { contacts: ['address'] } } } });
    expect(rule.status, JSON.stringify(rule.data)).toBe(200);
    try {
      const found = (await eva.call('GET', '/api/contact-duplicates')).data.groups.flatMap((g: any) => g.contacts.map((c: any) => c.id));
      expect(found).toEqual(expect.arrayContaining([mine1, mine2]));
      expect(found).not.toContain(foreign1);
      expect((await eva.call('GET', `/api/contact-duplicates/preview?keep_id=${foreign1}&from_id=${foreign2}`)).status).toBe(404);
      expect((await eva.call('POST', '/api/contact-duplicates/merge', { keep_id: foreign1, from_id: foreign2 })).status).toBe(404);
      expect((await eva.call('POST', '/api/contact-duplicates/merge', { keep_id: mine1, from_id: foreign2 })).status).toBe(404);
      expect((await eva.call('POST', '/api/contact-duplicates/ignore', { contact_ids: [foreign1, foreign2] })).status).toBe(404);
      expect((await eva.call('GET', `/api/contact-duplicates/for?contact_id=${foreign1}`)).status).toBe(404);
      const preview = (await eva.call('GET', `/api/contact-duplicates/preview?keep_id=${mine1}&from_id=${mine2}`)).data;
      expect(preview.fields.find((x: any) => x.key === 'city')).toMatchObject({ hidden: true, keep: '', from: '' });
      expect((await eva.call('POST', '/api/contact-duplicates/merge', { keep_id: mine1, from_id: mine2, picks: { city: 'from' } })).status).toBe(403);
      const ok = await eva.call('POST', '/api/contact-duplicates/merge', { keep_id: mine1, from_id: mine2 });
      expect(ok.status, JSON.stringify(ok.data)).toBe(200);
      expect(ok.data.contact.city).toBe('');
      expect(ok.data.contact.hidden_fields).toContain('city');
      expect(row('SELECT id FROM contacts WHERE id = ?', mine2)).toBeUndefined();
      expect(row('SELECT id FROM contacts WHERE id = ?', foreign2)).toBeTruthy();
    } finally {
      await t.api.put('/api/sales/access', { enabled: false });
    }
  });

  it('is offered to AI tools', () => {
    expect((t.app.services.mcpTools as { name: string }[]).map((x) => x.name)).toContain('ghl_contact_duplicates');
  });
});
