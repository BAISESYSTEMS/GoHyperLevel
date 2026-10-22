import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from './security-fixtures.js';
import { startTestApp } from './helpers.js';

/**
 * Security wave 10 (crm-access): record access in the field history (hidden custom fields, deals the person may not open), the
 * deal forecast and the smart-tags board (hidden deal amount), and "Nur für mich" documents in the DSGVO export.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let mia: ReturnType<typeof client>;
let miaId = '';
let chefId = '';
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  const u = await t.api.post('/api/users', { email: 'mia@example.com', password: 'passwort-123', name: 'Mia', locations: [loc], permissions: ['contacts', 'opportunities'] });
  expect(u.status, JSON.stringify(u.data)).toBe(200);
  miaId = u.data.id;
  mia = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await mia('POST', '/api/auth/login', { email: 'mia@example.com', password: 'passwort-123' })).status).toBe(200);
  chefId = t.app.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', 'chef@example.com')!.id;
});
afterAll(() => t?.close());

const settle = () => new Promise((r) => setTimeout(r, 80));
const access = async (rules: Record<string, unknown> | null) => {
  const r = await t.api.put('/api/sales/access', rules ? { enabled: true, rules: { default: rules } } : { enabled: false });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
};

describe('field history follows the hidden fields and the deal scope', () => {
  let c = '';
  let deal = '';
  beforeAll(async () => {
    await t.api.post('/api/custom-fields', { key: 'budget', label: 'Budget' });
    await t.api.post('/api/custom-fields', { key: 'notiz', label: 'Notiz' });
    c = (await t.api.post('/api/contacts', { email: 'hist@example.com', first_name: 'Hanna' })).data.id;
    await t.api.patch(`/api/contacts/${c}`, { custom: { budget: 'GEHEIM-5000', notiz: 'offen-sichtbar' } });
    const pipe = (await t.api.post('/api/pipelines', { name: 'Historie', stages: [{ name: 'Neu' }, { name: 'Angebot' }] })).data;
    deal = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: c, name: 'Chefsache', value: 1000 })).data.id;
    t.app.db.run('UPDATE opportunities SET assigned_to = ? WHERE id = ?', chefId, deal);
    await t.api.patch(`/api/opportunities/${deal}`, { stage_id: pipe.stages[1].id, name: 'Chefsache GEHEIMNAME' });
    await settle();
  });

  it('masks a single hidden custom field (custom.<key>)', async () => {
    await access({ levels: {}, hidden: { contacts: ['custom.budget'] } });
    const h = (await mia('GET', `/api/contacts/${c}/field-history`)).data;
    expect(Array.isArray(h), JSON.stringify(h)).toBe(true);
    expect(h.find((x: any) => x.field === 'custom.budget')).toMatchObject({ old: '', new: '', hidden: true });
    expect(h.find((x: any) => x.field === 'custom.notiz')).toMatchObject({ new: 'offen-sichtbar' });
    expect(JSON.stringify(h)).not.toContain('GEHEIM-5000');
  });

  it('masks every custom field when all own fields are hidden (custom)', async () => {
    await access({ levels: {}, hidden: { contacts: ['custom'] } });
    const h = (await mia('GET', `/api/contacts/${c}/field-history`)).data;
    expect(h.find((x: any) => x.field === 'custom.budget')).toMatchObject({ old: '', new: '', hidden: true });
    expect(h.find((x: any) => x.field === 'custom.notiz')).toMatchObject({ old: '', new: '', hidden: true });
    expect(JSON.stringify(h)).not.toContain('GEHEIM-5000');
  });

  it('leaves out the changes of a deal the person may not open', async () => {
    await access({ levels: { deals: 'own' }, hidden: {} });
    const h = (await mia('GET', `/api/contacts/${c}/field-history`)).data;
    expect(Array.isArray(h), JSON.stringify(h)).toBe(true);
    expect(h.some((x: any) => x.opportunity_id === deal)).toBe(false);
    expect(JSON.stringify(h)).not.toContain('GEHEIMNAME');
    // The contact's own fields stay.
    expect(h.some((x: any) => x.field === 'custom.notiz')).toBe(true);
    // The admin still sees everything.
    const all = (await t.api.get(`/api/contacts/${c}/field-history`)).data;
    expect(all.some((x: any) => x.opportunity_id === deal && x.field === 'stage_id')).toBe(true);
    expect(all.find((x: any) => x.field === 'custom.budget')).toMatchObject({ new: 'GEHEIM-5000' });
    await access(null);
  });
});

describe('deal forecast and smart-tags board follow record access', () => {
  let pipe: any;
  let mine = '';
  let theirs = '';
  beforeAll(async () => {
    pipe = (await t.api.post('/api/pipelines', { name: 'Prognose', stages: [{ name: 'Neu', probability: 10 }, { name: 'Angebot', probability: 50 }] })).data;
    const c = (await t.api.post('/api/contacts', { email: 'prog@example.com' })).data.id;
    const mk = async (name: string, value: number, owner: string, close: string) => {
      const id = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, stage_id: pipe.stages[1].id, contact_id: c, name, value, expected_close_date: close })).data.id as string;
      t.app.db.run('UPDATE opportunities SET assigned_to = ? WHERE id = ?', owner, id);
      return id;
    };
    mine = await mk('Mias Deal', 777, miaId, '2020-01-01');
    theirs = await mk('Chefs Deal', 50000, chefId, '2020-01-01');
    expect((await t.api.post('/api/deal-smart-tags', { name: 'Großer Fisch', color: '#16a34a', rule: { kind: 'value_min', value: 500 } })).status).toBe(200);
    expect((await t.api.post('/api/deal-smart-tags', { name: 'Überfällig', color: '#dc2626', rule: { kind: 'overdue' } })).status).toBe(200);
  });

  it('forecast: only the deals the person may open', async () => {
    await access({ levels: { deals: 'own' }, hidden: {} });
    const r = await mia('GET', `/api/deal-forecast?pipeline_id=${pipe.id}`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.open).toMatchObject({ count: 1, value: 777 });
    expect(JSON.stringify(r.data)).not.toContain(theirs);
    const board = (await mia('GET', `/api/deal-smart-tags/board?pipeline_id=${pipe.id}`)).data;
    expect(board[theirs]).toBeUndefined();
    expect(board[mine]?.length).toBeGreaterThan(0);
  });

  it('forecast: no amounts when the deal value is hidden', async () => {
    await access({ levels: {}, hidden: { deals: ['value'] } });
    const r = await mia('GET', `/api/deal-forecast?pipeline_id=${pipe.id}`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.open).toMatchObject({ count: 2, value: 0, weighted: 0 });
    expect(r.data.months.every((m: any) => m.value === 0 && m.weighted === 0)).toBe(true);
    expect(r.data.risks.overdue).toMatchObject({ count: 2, value: 0 });
    expect(r.data.risks.overdue.deals.every((d: any) => d.value === 0)).toBe(true);
    expect(JSON.stringify(r.data)).not.toMatch(/50000|777/);
    // The admin keeps the amounts.
    const admin = (await t.api.get(`/api/deal-forecast?pipeline_id=${pipe.id}`)).data;
    expect(admin.open).toMatchObject({ count: 2, value: 50777 });
  });

  it('smart-tags board: a value rule does not mark deals for somebody who may not see the amount', async () => {
    await access({ levels: {}, hidden: { deals: ['value'] } });
    const board = (await mia('GET', `/api/deal-smart-tags/board?pipeline_id=${pipe.id}`)).data;
    const names = (id: string) => (board[id] ?? []).map((x: any) => x.name).sort();
    expect(names(theirs)).toEqual(['Überfällig']);
    expect(names(mine)).toEqual(['Überfällig']);
    const admin = (await t.api.get(`/api/deal-smart-tags/board?pipeline_id=${pipe.id}`)).data;
    expect((admin[theirs] ?? []).map((x: any) => x.name).sort()).toEqual(['Großer Fisch', 'Überfällig']);
    await access(null);
  });
});

describe('DSGVO export and "Nur für mich" documents', () => {
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
  let c = '';
  beforeAll(async () => {
    c = (await t.api.post('/api/contacts', { email: 'dsgvo@example.com', first_name: 'Dora' })).data.id;
    expect((await t.api.post(`/api/contacts/${c}/documents`, { name: 'Chef-Geheimakte.pdf', data: PDF, private: true })).status).toBe(200);
    expect((await t.api.post(`/api/contacts/${c}/documents`, { name: 'Vertrag-offen.pdf', data: PDF })).status).toBe(200);
    expect((await mia('POST', `/api/contacts/${c}/documents`, { name: 'Mia-privat.pdf', data: PDF, private: true })).status).toBe(200);
  });

  it('a member does not get the names of other people\'s private documents', async () => {
    const r = await mia('GET', `/api/contacts/${c}/privacy-export`);
    expect(r.status, r.text).toBe(200);
    const names = (r.data.data.contact_documents ?? []).map((d: any) => d.name).sort();
    expect(names).toEqual(['Mia-privat.pdf', 'Vertrag-offen.pdf']);
    expect(r.text).not.toContain('Chef-Geheimakte');
  });

  it('the admin export stays complete', async () => {
    const r = await t.api.get(`/api/contacts/${c}/privacy-export`);
    expect(r.status).toBe(200);
    const names = (r.data.data.contact_documents ?? []).map((d: any) => d.name).sort();
    expect(names).toEqual(['Chef-Geheimakte.pdf', 'Mia-privat.pdf', 'Vertrag-offen.pdf']);
  });
});
