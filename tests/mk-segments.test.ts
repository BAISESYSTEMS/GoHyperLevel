import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { id as newId } from '../server/core/util.js';
import { MAX_DEPTH, MAX_NODES, cleanDefinition, describe as describeDef } from '../server/services/mk-segments.js';
import { mcpClient } from './mk-fixtures.js';

const g = (op: 'and' | 'or', ...items: any[]) => ({ type: 'group', op, items });

describe('segment definitions', () => {
  it('turns a bare condition or a list into a group and drops unknown keys', () => {
    expect(cleanDefinition({ type: 'tag', tag: 'lead', evil: 1 })).toEqual({ type: 'group', op: 'and', items: [{ type: 'tag', tag: 'lead', has: true }] });
    expect(cleanDefinition([{ type: 'dnd', value: false }])).toEqual({ type: 'group', op: 'and', items: [{ type: 'dnd', value: false }] });
    expect(cleanDefinition(g('or', { type: 'tag', tag: 'a' }, { type: 'tag', tag: 'b', has: false }))).toMatchObject({ op: 'or', items: [{ has: true }, { has: false }] });
    expect(cleanDefinition({ type: 'group', items: [] })).toEqual({ type: 'group', op: 'and', items: [] });
  });

  it('refuses what makes no sense, in German', () => {
    expect(() => cleanDefinition(null)).toThrow(/Definition fehlt/);
    expect(() => cleanDefinition(g('and', { type: 'unbekannt' }))).toThrow(/unbekannte Bedingung/);
    expect(() => cleanDefinition(g('and', { type: 'tag', tag: '' }))).toThrow(/Tag fehlt/);
    expect(() => cleanDefinition(g('and', { type: 'field', field: 'passwort', op: 'eq', value: 'x' }))).toThrow(/unbekanntes Feld/);
    expect(() => cleanDefinition(g('and', { type: 'field', field: 'custom.budget', op: 'gt', value: 'viel' }))).toThrow(/Zahl/);
    expect(() => cleanDefinition(g('and', { type: 'field', field: 'city', op: 'eq', value: '' }))).toThrow(/Wert/);
    expect(() => cleanDefinition(g('and', { type: 'field', field: 'date_of_birth', op: 'before', value: 'gestern' }))).toThrow(/Datum/);
    expect(() => cleanDefinition(g('and', { type: 'page', url_contains: '' }))).toThrow(/Seitenadresse/);
    expect(() => cleanDefinition(g('and', { type: 'email', event: 'opened', days: -3 }))).toThrow(/Tage/);
    expect(() => cleanDefinition(g('and', { type: 'segment', segment_id: '' }))).toThrow(/Segment/);
  });

  it('limits depth and size', () => {
    let deep: any = { type: 'tag', tag: 'x' };
    for (let i = 0; i < MAX_DEPTH + 1; i++) deep = g('and', deep);
    expect(() => cleanDefinition(deep)).toThrow(/Ebenen/);
    expect(() => cleanDefinition(g('and', ...Array.from({ length: MAX_NODES + 1 }, (_, i) => ({ type: 'tag', tag: `t${i}` }))))).toThrow(/Höchstens/);
    // exactly the limit works
    expect(() => cleanDefinition(g('and', ...Array.from({ length: MAX_NODES - 1 }, (_, i) => ({ type: 'tag', tag: `t${i}` }))))).not.toThrow();
  });

  it('reads a definition aloud', () => {
    const def = cleanDefinition(g('and', { type: 'tag', tag: 'lead' }, g('or', { type: 'email', event: 'not_opened', campaign_id: 'c1' }, { type: 'purchase', bought: false, days: 30 })));
    expect(describeDef(def, { campaign: () => 'Herbst' })).toBe('(hat Tag „lead“ UND (hat Kampagne „Herbst“ nicht geöffnet ODER hat nicht gekauft in den letzten 30 Tagen))');
    expect(describeDef({ type: 'group', op: 'and', items: [] })).toBe('alle Kontakte');
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let other = '';
const C: Record<string, string> = {};
let campaignId = '';
let formId = '';
let productId = '';
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 864e5).toISOString();

/** A mail (a message of a campaign) with what happened to it. */
function mail(contactId: string, o: { campaign?: string; opened?: boolean; clicked?: boolean; daysAgo?: number; status?: string } = {}) {
  const mid = newId();
  const at = iso(o.daysAgo ?? 1);
  const cv = t.app.db.get<{ id: string }>('SELECT id FROM conversations WHERE location_id = ? AND contact_id = ?', loc, contactId)?.id ?? `cv-${mid}`;
  if (cv === `cv-${mid}`) t.app.db.insert('conversations', { id: cv, location_id: loc, contact_id: contactId, unread: 0, last_message_at: at, created_at: at });
  t.app.db.insert('messages', { id: mid, location_id: loc, conversation_id: cv, contact_id: contactId, channel: 'email', direction: 'out', subject: 'x', body: 'x', status: o.status ?? 'sent', error: '', source: 'Kampagne: x', created_at: at, opened_at: o.opened || o.clicked ? at : null, clicked_at: o.clicked ? at : null });
  if (o.campaign) t.app.db.insert('campaign_recipients', { campaign_id: o.campaign, contact_id: contactId, status: 'sent', message_id: mid, sent_at: at, variant: '' });
  return mid;
}

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  other = (await t.api.post('/api/locations', { name: 'Fremdfirma' })).data.id;
  await t.api.post('/api/custom-fields', { label: 'Budget', type: 'number' });
  const mk = async (key: string, body: Record<string, unknown>) => (C[key] = (await t.api.post('/api/contacts', { email: `${key}@kunde.example`, first_name: key, ...body })).data.id);
  await mk('anna', { tags: ['lead'], city: 'Berlin', custom: { budget: '5000' } });
  await mk('ben', { tags: ['kunde'], city: 'Hamburg', custom: { budget: '800' } });
  await mk('carla', { tags: ['lead', 'kunde'], city: 'Berlin' });
  await mk('dirk', { city: 'München', dnd: true });
  await mk('eva', { tags: ['lead'] });
  campaignId = (await t.api.post('/api/campaigns', { name: 'Herbstmail', subject: 'Herbst', body: 'x' })).data.id;
  t.app.db.run(`UPDATE campaigns SET status = 'sent', sent_at = ? WHERE id = ?`, iso(2), campaignId);
  mail(C.anna, { campaign: campaignId, opened: true });
  mail(C.ben, { campaign: campaignId });
  mail(C.carla, { campaign: campaignId, opened: true, clicked: true });
  mail(C.dirk, { campaign: campaignId });
  formId = (await t.api.post('/api/forms', { name: 'Kontakt' })).data.id;
  for (const k of ['anna', 'eva']) t.app.db.insert('form_submissions', { id: newId(), location_id: loc, form_id: formId, contact_id: C[k], data: {}, meta: {}, created_at: iso(3) });
  productId = (await t.api.post('/api/products', { name: 'Kurs', price_cents: 9900 })).data.id;
  t.app.db.insert('stripe_checkouts', { id: `cs_${newId(6)}`, location_id: loc, kind: 'product', product_id: productId, contact_id: C.carla, status: 'paid', amount_cents: 9900, currency: 'EUR', email: 'carla@kunde.example', created_at: iso(5), paid_at: iso(5) });
  t.app.db.insert('invoices', { id: newId(), location_id: loc, kind: 'invoice', number: 'S-1', contact_id: C.ben, title: 'x', items: [], currency: 'EUR', subtotal_cents: 100, tax_cents: 0, total_cents: 100, status: 'paid', public_token: newId(20), issued_at: iso(40), paid_at: iso(40), created_at: iso(40), updated_at: iso(40) });
  t.app.db.insert('attribution_touches', { id: newId(), location_id: loc, contact_id: C.anna, kind: 'visit', channel: 'direct', landing_page: '/p/mein-funnel/preise', created_at: iso(2) });
  t.app.db.insert('attribution_touches', { id: newId(), location_id: loc, contact_id: C.ben, kind: 'visit', channel: 'direct', landing_page: '/p/mein-funnel/preise', created_at: iso(60) });
});
afterAll(async () => t.close());

const count = async (def: unknown) => {
  const r = await t.api.post('/api/segments/count', { definition: def });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const names = async (def: unknown) => {
  const r = await t.api.post('/api/segments/count', { definition: def });
  return r.data.sample.map((s: any) => s.name).sort();
};
const idsOf = (def: unknown) => t.api.post('/api/segments', { name: `tmp-${Math.random()}`, definition: def }).then(async (r) => {
  const contacts = (await t.api.get(`/api/segments/${r.data.id}/contacts?limit=200`)).data;
  await t.api.del(`/api/segments/${r.data.id}`);
  return contacts.contacts.map((c: any) => c.name).sort();
});

describe('segment conditions on real data', () => {
  it('tags', async () => {
    expect((await count(g('and', { type: 'tag', tag: 'lead' }))).count).toBe(3);
    expect((await count(g('and', { type: 'tag', tag: 'lead', has: false }))).count).toBe(2);
    expect(await idsOf(g('and', { type: 'tag', tag: 'lead' }, { type: 'tag', tag: 'kunde' }))).toEqual(['carla']);
  });

  it('fields: text, empty, custom numbers', async () => {
    expect(await idsOf(g('and', { type: 'field', field: 'city', op: 'eq', value: 'berlin' }))).toEqual(['anna', 'carla']);
    expect(await idsOf(g('and', { type: 'field', field: 'city', op: 'contains', value: 'ber' }))).toEqual(['anna', 'carla']);
    expect(await idsOf(g('and', { type: 'field', field: 'city', op: 'starts', value: 'ham' }))).toEqual(['ben']);
    expect(await idsOf(g('and', { type: 'field', field: 'city', op: 'empty' }))).toEqual(['eva']);
    expect((await count(g('and', { type: 'field', field: 'city', op: 'not_empty' }))).count).toBe(4);
    expect(await idsOf(g('and', { type: 'field', field: 'custom.budget', op: 'gt', value: '1000' }))).toEqual(['anna']);
    expect(await idsOf(g('and', { type: 'field', field: 'custom.budget', op: 'lt', value: '1000' }))).toEqual(['ben']);
    expect(await idsOf(g('and', { type: 'field', field: 'custom.budget', op: 'gte', value: '800' }))).toEqual(['anna', 'ben']);
    // a "%" in the search text is not a wildcard
    expect((await count(g('and', { type: 'field', field: 'city', op: 'contains', value: '%' }))).count).toBe(0);
  });

  it('opened, clicked, not opened and received a campaign (people only)', async () => {
    const e = (event: string) => g('and', { type: 'email', event, campaign_id: campaignId });
    expect(await idsOf(e('opened'))).toEqual(['anna', 'carla']);
    expect(await idsOf(e('clicked'))).toEqual(['carla']);
    expect(await idsOf(e('not_opened'))).toEqual(['ben', 'dirk']);
    expect(await idsOf(e('received'))).toEqual(['anna', 'ben', 'carla', 'dirk']);
    // a machine's open (no opened_at) leaves the contact among the non-openers
    t.app.db.run('UPDATE messages SET machine_open_count = 4 WHERE contact_id = ?', C.ben);
    expect(await idsOf(e('not_opened'))).toEqual(['ben', 'dirk']);
  });

  it('opened or clicked "any e-mail" within some days', async () => {
    expect(await idsOf(g('and', { type: 'email', event: 'opened', days: 30 }))).toEqual(['anna', 'carla']);
    expect(await idsOf(g('and', { type: 'email', event: 'clicked', days: 30 }))).toEqual(['carla']);
    expect(await idsOf(g('and', { type: 'email', event: 'received', days: 30 }))).toEqual(['anna', 'ben', 'carla', 'dirk']);
    expect(await idsOf(g('and', { type: 'email', event: 'not_opened', days: 30 }))).toEqual(['ben', 'dirk']);
    expect((await count(g('and', { type: 'email', event: 'received', days: 2 }))).count).toBe(4);
  });

  it('visited a page', async () => {
    expect(await idsOf(g('and', { type: 'page', url_contains: '/PREISE' }))).toEqual(['anna', 'ben']);
    expect(await idsOf(g('and', { type: 'page', url_contains: 'preise', days: 30 }))).toEqual(['anna']);
    expect((await count(g('and', { type: 'page', url_contains: 'nirgends' }))).count).toBe(0);
  });

  it('bought a product, or anything', async () => {
    expect(await idsOf(g('and', { type: 'purchase', product_id: productId }))).toEqual(['carla']);
    expect((await count(g('and', { type: 'purchase', product_id: productId, bought: false }))).count).toBe(4);
    expect(await idsOf(g('and', { type: 'purchase' }))).toEqual(['ben', 'carla']);
    expect(await idsOf(g('and', { type: 'purchase', days: 10 }))).toEqual(['carla']);
    expect(await idsOf(g('and', { type: 'purchase', bought: false }))).toEqual(['anna', 'dirk', 'eva']);
  });

  it('submitted a form', async () => {
    expect(await idsOf(g('and', { type: 'form', form_id: formId }))).toEqual(['anna', 'eva']);
    expect(await idsOf(g('and', { type: 'form' }))).toEqual(['anna', 'eva']);
    expect((await count(g('and', { type: 'form', submitted: false }))).count).toBe(3);
    expect((await count(g('and', { type: 'form', form_id: formId, days: 1 }))).count).toBe(0);
  });

  it('last activity and creation date', async () => {
    t.app.db.run('UPDATE contacts SET last_activity_at = ? WHERE id = ?', iso(100), C.ben);
    t.app.db.run('UPDATE contacts SET last_activity_at = NULL WHERE id = ?', C.eva);
    t.app.db.run('UPDATE contacts SET created_at = ? WHERE id = ?', iso(400), C.dirk);
    expect(await idsOf(g('and', { type: 'activity', op: 'older_than', days: 30 }))).toEqual(['ben', 'eva']);
    expect(await idsOf(g('and', { type: 'activity', op: 'never' }))).toEqual(['eva']);
    expect((await count(g('and', { type: 'activity', op: 'within', days: 30 }))).count).toBe(3);
    expect(await idsOf(g('and', { type: 'created', op: 'older_than', days: 365 }))).toEqual(['dirk']);
    expect((await count(g('and', { type: 'created', op: 'within', days: 365 }))).count).toBe(4);
  });

  it('engagement: active, and inactive (got mail for months, never opened)', async () => {
    // dirk got three mails over the last months and never opened one
    for (const d of [20, 60, 120]) mail(C.dirk, { daysAgo: d });
    expect(await idsOf(g('and', { type: 'engagement', state: 'active', days: 30 }))).toEqual(['anna', 'carla']);
    expect(await idsOf(g('and', { type: 'engagement', state: 'inactive', days: 180 }))).toEqual(['dirk']);
    // with fewer mails required ben (one mail, not opened) joins
    expect(await idsOf(g('and', { type: 'engagement', state: 'inactive', days: 180, min_received: 1 }))).toEqual(['ben', 'dirk']);
  });

  it('do not disturb, and the address check', async () => {
    expect(await idsOf(g('and', { type: 'dnd', value: true }))).toEqual(['dirk']);
    expect((await count(g('and', { type: 'dnd', value: false }))).count).toBe(4);
    t.app.db.insert('mk_email_checks', { contact_id: C.eva, location_id: loc, email: 'eva@kunde.example', verdict: 'invalid', issues: '[]', role: 0, disposable: 0, mx: 0, checked_at: iso(1) });
    expect(await idsOf(g('and', { type: 'email_check', verdict: 'invalid' }))).toEqual(['eva']);
    expect((await count(g('and', { type: 'email_check', verdict: 'unchecked' }))).count).toBe(4);
    // a changed address means the old verdict does not count
    t.app.db.run(`UPDATE contacts SET email = 'eva2@kunde.example' WHERE id = ?`, C.eva);
    expect((await count(g('and', { type: 'email_check', verdict: 'invalid' }))).count).toBe(0);
  });

  it('consent: with the policy "confirmed" only contacts with a proven consent are granted', async () => {
    expect((await count(g('and', { type: 'consent', channel: 'email', state: 'granted' }))).count).toBe(4); // legacy policy: everybody but dirk (DND)
    await t.api.put('/api/consent/settings', { policy: 'confirmed' });
    const yes = (await t.api.post('/api/contacts', { email: 'gina@kunde.example', first_name: 'gina', consent: true })).data;
    expect(await idsOf(g('and', { type: 'consent', channel: 'email', state: 'granted' }))).toEqual(['gina']);
    expect((await count(g('and', { type: 'consent', channel: 'email', state: 'missing' }))).count).toBe(5);
    expect((await count(g('and', { type: 'consent', channel: 'sms', state: 'granted' }))).count).toBe(0);
    await t.api.put('/api/consent/settings', { policy: 'legacy' });
    await t.api.del(`/api/contacts/${yes.id}`);
  });
});

describe('groups: AND, OR, NOT', () => {
  it('combines conditions', async () => {
    const lead = { type: 'tag', tag: 'lead' };
    const berlin = { type: 'field', field: 'city', op: 'eq', value: 'Berlin' };
    const kunde = { type: 'tag', tag: 'kunde' };
    expect(await idsOf(g('and', lead, berlin))).toEqual(['anna', 'carla']);
    expect(await idsOf(g('or', lead, kunde))).toEqual(['anna', 'ben', 'carla', 'eva']);
    expect(await idsOf(g('or', g('and', lead, berlin), kunde))).toEqual(['anna', 'ben', 'carla']);
    expect(await idsOf(g('and', lead, { ...kunde, negate: true }))).toEqual(['anna', 'eva']);
    expect(await idsOf({ ...g('or', lead, kunde), negate: true })).toEqual(['dirk']);
    // the typical case: clicked but did not buy
    expect(await idsOf(g('and', { type: 'email', event: 'clicked', campaign_id: campaignId }, { type: 'purchase', product_id: productId, bought: false }))).toEqual([]);
    expect(await idsOf(g('and', { type: 'email', event: 'opened', campaign_id: campaignId }, { type: 'purchase', product_id: productId, bought: false }))).toEqual(['anna']);
    // an empty group matches everybody; an empty negated one nobody
    expect((await count(g('and'))).count).toBe(5);
    expect((await count({ ...g('and'), negate: true })).count).toBe(0);
  });
});

describe('saved segments', () => {
  it('stores a definition with its count and a plain-language summary', async () => {
    const r = await t.api.post('/api/segments', { name: 'Interessenten ohne Kauf', description: 'Geöffnet, nicht gekauft', definition: g('and', { type: 'email', event: 'opened', campaign_id: campaignId }, { type: 'purchase', product_id: productId, bought: false }) });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ name: 'Interessenten ohne Kauf', count: 1, watch: 0 });
    expect(r.data.summary).toBe('(hat Kampagne „Herbstmail“ geöffnet UND hat nicht gekauft: Kurs)');
    const list = (await t.api.get('/api/segments')).data;
    expect(list.map((s: any) => s.name)).toContain('Interessenten ohne Kauf');
    const detail = (await t.api.get(`/api/segments/${r.data.id}`)).data;
    expect(detail.definition.items).toHaveLength(2);
    const members = (await t.api.get(`/api/segments/${r.data.id}/contacts`)).data;
    expect(members).toMatchObject({ total: 1 });
    expect(members.contacts[0]).toMatchObject({ name: 'anna', email: 'anna@kunde.example' });
    // changing it recounts
    const upd = await t.api.patch(`/api/segments/${r.data.id}`, { definition: g('and', { type: 'tag', tag: 'lead' }), name: 'Leads' });
    expect(upd.data).toMatchObject({ name: 'Leads', count: 3 });
    expect((await t.api.post(`/api/segments/${r.data.id}/count`)).data.count).toBe(3);
  });

  it('refuses bad input and unknown ids', async () => {
    expect((await t.api.post('/api/segments', { definition: g('and') })).status).toBe(400); // no name
    expect((await t.api.post('/api/segments', { name: 'x', definition: g('and', { type: 'nope' }) })).status).toBe(400);
    expect((await t.api.get('/api/segments/gibtsnicht')).status).toBe(404);
    expect((await t.api.patch('/api/segments/gibtsnicht', { name: 'x' })).status).toBe(404);
    expect((await t.api.post('/api/segments/count', {})).status).toBe(400);
  });

  it('a live count shows a few contacts and the summary', async () => {
    const r = await count(g('and', { type: 'tag', tag: 'lead' }));
    expect(r.count).toBe(3);
    expect(r.sample.length).toBeLessThanOrEqual(5);
    expect(r.summary).toBe('hat Tag „lead“');
  });

  it('a segment can contain another one, but not in a circle', async () => {
    const a = (await t.api.post('/api/segments', { name: 'Leads A', definition: g('and', { type: 'tag', tag: 'lead' }) })).data;
    const b = (await t.api.post('/api/segments', { name: 'Berliner Leads', definition: g('and', { type: 'segment', segment_id: a.id }, { type: 'field', field: 'city', op: 'eq', value: 'Berlin' }) })).data;
    expect(b.count).toBe(2);
    expect(b.summary).toContain('ist in Segment „Leads A“');
    // A may not contain itself, and not B (which contains A)
    expect((await t.api.patch(`/api/segments/${a.id}`, { definition: g('and', { type: 'segment', segment_id: a.id }) })).status).toBe(400);
    const cyc = await t.api.patch(`/api/segments/${a.id}`, { definition: g('and', { type: 'segment', segment_id: b.id }) });
    expect(cyc.status).toBe(400);
    expect(cyc.data.error).toContain('im Kreis');
    // a segment that is part of another cannot be deleted
    const del = await t.api.del(`/api/segments/${a.id}`);
    expect(del.status).toBe(400);
    expect(del.data.error).toContain('Berliner Leads');
    expect((await t.api.del(`/api/segments/${b.id}`)).status).toBe(200);
    expect((await t.api.del(`/api/segments/${a.id}`)).status).toBe(200);
  });

  it('the builder meta lists what a condition can point at', async () => {
    const m = (await t.api.get('/api/segments/meta')).data;
    expect(m.types).toContain('purchase');
    expect(m.campaigns.map((c: any) => c.name)).toContain('Herbstmail');
    expect(m.forms.map((f: any) => f.name)).toContain('Kontakt');
    expect(m.products.map((p: any) => p.name)).toContain('Kurs');
    expect(m.tags).toEqual(expect.arrayContaining(['lead', 'kunde']));
    expect(m.custom_fields.map((f: any) => f.key)).toContain('budget');
    expect(m.limits).toEqual({ depth: MAX_DEPTH, nodes: MAX_NODES });
  });

  it('never looks at another sub-account', async () => {
    // Another sub-account has contacts with the same tags and its own segment.
    t.api.setLocation(other);
    await t.api.post('/api/contacts', { email: 'fremd@x.example', first_name: 'fremd', tags: ['lead'], city: 'Berlin' });
    const foreign = (await t.api.post('/api/segments', { name: 'Fremd', definition: g('and', { type: 'tag', tag: 'lead' }) })).data;
    expect(foreign.count).toBe(1);
    t.api.setLocation(loc);
    expect((await count(g('and', { type: 'tag', tag: 'lead' }))).count).toBe(3);
    // A condition cannot point at the other's campaign, form, product or segment.
    expect((await t.api.get(`/api/segments/${foreign.id}`)).status).toBe(404);
    expect((await t.api.post('/api/segments', { name: 'x', definition: g('and', { type: 'segment', segment_id: foreign.id }) })).status).toBe(400);
    expect((await t.api.get(`/api/segments/${foreign.id}/contacts`)).status).toBe(404);
    const names2 = (await t.api.get('/api/segments')).data.map((s: any) => s.name);
    expect(names2).not.toContain('Fremd');
  });
});

describe('segments as the audience of a campaign', () => {
  it('sends to the segment, narrowed by tags, and leaves out a deleted segment', async () => {
    const seg = (await t.api.post('/api/segments', { name: 'Berliner', definition: g('and', { type: 'field', field: 'city', op: 'eq', value: 'Berlin' }) })).data;
    const camp = (await t.api.post('/api/campaigns', { name: 'An Berliner', subject: 'Hallo Berlin', body: 'x', filter: { segment_id: seg.id } })).data;
    expect((await t.api.post(`/api/campaigns/${camp.id}/audience`, { filter: { segment_id: seg.id } })).data).toMatchObject({ total: 2, reachable: 2 });
    // narrowed by a tag as well: Berlin AND tag "kunde" → carla
    expect((await t.api.post(`/api/campaigns/${camp.id}/audience`, { filter: { segment_id: seg.id, tags: ['kunde'] } })).data.total).toBe(1);
    // a segment in use cannot be deleted
    expect((await t.api.del(`/api/segments/${seg.id}`)).status).toBe(400);
    const sent = await t.api.post(`/api/campaigns/${camp.id}/send`, {});
    expect(sent.data.recipients).toBe(2);
    const to = t.app.db.all<{ contact_id: string }>('SELECT contact_id FROM campaign_recipients WHERE campaign_id = ?', camp.id).map((r) => r.contact_id).sort();
    expect(to).toEqual([C.anna, C.carla].sort());
    // after sending, the segment can go – a later campaign with that id reaches nobody (never everybody)
    expect((await t.api.del(`/api/segments/${seg.id}`)).status).toBe(200);
    expect((await t.api.post(`/api/campaigns/${camp.id}/audience`, { filter: { segment_id: seg.id } })).data.total).toBe(0);
  });
});

describe('segments in workflows: entering and leaving', () => {
  it('announces who joins or leaves a watched segment, and starts workflows from it', async () => {
    const seg = (await t.api.post('/api/segments', { name: 'Neue Leads', watch: true, definition: g('and', { type: 'tag', tag: 'wf-lead' }) })).data;
    const events: { type: string; contactId: string }[] = [];
    for (const type of ['segment.entered', 'segment.left']) t.app.events.on(type, (e) => void events.push({ type, contactId: e.data.contactId }));
    const watch = () => t.app.services.mkWatchSegments(loc);
    const wf = (await t.api.post('/api/workflows', { name: 'Segment-Beitritt', trigger: { type: 'segment.entered', config: { segment_id: seg.id } }, steps: [{ type: 'add_tag', tags: ['im-segment'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });

    // First run: the existing members are only remembered.
    const early = (await t.api.post('/api/contacts', { email: 'frueh@kunde.example', first_name: 'frueh', tags: ['wf-lead'] })).data;
    expect(watch()).toEqual({ entered: 0, left: 0 });
    await t.app.events.flush();
    expect(events).toHaveLength(0);

    // Later: a new member is announced once, and the workflow runs for them.
    const fresh = (await t.api.post('/api/contacts', { email: 'neu@kunde.example', first_name: 'neu', tags: ['wf-lead'] })).data;
    expect(watch()).toEqual({ entered: 1, left: 0 });
    expect(watch()).toEqual({ entered: 0, left: 0 });
    await t.app.events.flush();
    expect(events).toEqual([{ type: 'segment.entered', contactId: fresh.id }]);
    expect((await t.api.get(`/api/contacts/${fresh.id}`)).data.tags).toContain('im-segment');
    expect((await t.api.get(`/api/contacts/${early.id}`)).data.tags).not.toContain('im-segment');

    // Leaving is announced as well.
    await t.api.patch(`/api/contacts/${fresh.id}`, { tags: [] });
    expect(watch()).toEqual({ entered: 0, left: 1 });
    await t.app.events.flush();
    expect(events.at(-1)).toEqual({ type: 'segment.left', contactId: fresh.id });
    // The workflow trigger only listens to its own segment.
    const members = t.app.db.all('SELECT contact_id FROM mk_segment_members WHERE segment_id = ?', seg.id);
    expect(members).toHaveLength(1);
  });

  it('offers the triggers in the workflow catalogue', async () => {
    const cat = (await t.api.get('/api/workflow-catalog?kind=triggers&q=segment')).data;
    expect(cat.triggers.map((x: any) => x.type)).toEqual(expect.arrayContaining(['segment.entered', 'segment.left']));
    expect((await t.api.post('/api/workflows', { name: 'x', trigger: { type: 'segment.left', config: {} } })).status).toBe(200);
  });

  it('a segment that starts an active workflow cannot be deleted', async () => {
    const seg = (await t.api.post('/api/segments', { name: 'Mit Workflow', watch: true, definition: g('and', { type: 'tag', tag: 'xyz' }) })).data;
    const wf = (await t.api.post('/api/workflows', { name: 'Hängt dran', trigger: { type: 'segment.entered', config: { segment_id: seg.id } }, steps: [] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const r = await t.api.del(`/api/segments/${seg.id}`);
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('Hängt dran');
  });
});

describe('MCP tools for segments', () => {
  it('lists, counts and saves segments', async () => {
    const m = await mcpClient(t, loc);
    const tools = (await m.tools()).map((x) => x.name);
    expect(tools).toEqual(expect.arrayContaining(['ghl_list_segments', 'ghl_segment_count', 'ghl_save_segment']));
    const saved = await m.rpc('ghl_save_segment', { name: 'Per MCP', definition: g('and', { type: 'tag', tag: 'lead' }), watch: false });
    expect(saved.error).toBe(false);
    expect(saved.json).toMatchObject({ name: 'Per MCP', count: 3 });
    const list = await m.rpc('ghl_list_segments');
    expect(list.json.map((s: any) => s.name)).toContain('Per MCP');
    const live = await m.rpc('ghl_segment_count', { definition: g('and', { type: 'field', field: 'city', op: 'eq', value: 'Berlin' }) });
    expect(live.json.count).toBe(2);
    const byId = await m.rpc('ghl_segment_count', { segment_id: saved.json.id });
    expect(byId.json.count).toBe(3);
    expect(byId.json.sample.length).toBeGreaterThan(0);
    const upd = await m.rpc('ghl_save_segment', { id: saved.json.id, name: 'Umbenannt' });
    expect(upd.json.name).toBe('Umbenannt');
    expect((await m.rpc('ghl_segment_count', {})).error).toBe(true);
    // never another sub-account's segment
    const foreign = t.app.db.get<{ id: string }>('SELECT id FROM mk_segments WHERE location_id = ?', other)!;
    expect((await m.rpc('ghl_segment_count', { segment_id: foreign.id })).error).toBe(true);
  });
});
