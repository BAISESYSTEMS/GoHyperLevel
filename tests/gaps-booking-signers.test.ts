import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import type { AppEvent } from '../server/core/events.js';

/** Several signers with roles and a signing order for contracts (modules/contract-signers.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let contactId = '';
const events: AppEvent[] = [];
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const tokenOf = (contractId: string, position: number) => t.app.db.get<any>('SELECT token FROM contract_signers WHERE contract_id = ? AND position = ?', contractId, position).token;
const pub = (path: string, body: unknown) => t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.events.on('*', (e) => void events.push(e));
  contactId = (await t.api.post('/api/contacts', { first_name: 'Klara', last_name: 'Kundin', email: 'klara@example.com', company: 'Kunde GmbH' })).data.id;
});
afterAll(async () => {
  await t.close();
});

async function draft(title = 'Rahmenvertrag') {
  return (await t.api.post('/api/contracts', { kind: 'contract', contact_id: contactId, title, content: 'Zwischen {{location.name}} und {{contact.company}}.' })).data;
}

describe('contract signers', () => {
  it('validates the list and keeps a contract without signers on the old single-signer flow', async () => {
    const c = await draft();
    expect((await t.api.get(`/api/contracts/${c.id}/signers`)).data).toMatchObject({ mode: null, signers: [], total: 0 });
    expect((await t.api.put(`/api/contracts/${c.id}/signers`, { signers: [{ name: 'A', email: 'kaputt' }] })).status).toBe(400);
    const dup = await t.api.put(`/api/contracts/${c.id}/signers`, { signers: [{ name: 'A', email: 'a@example.com' }, { name: 'B', email: 'A@example.com' }] });
    expect(dup.data.error).toContain('schon in der Liste');
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `P${i}`, email: `p${i}@example.com` }));
    expect((await t.api.put(`/api/contracts/${c.id}/signers`, { signers: many })).status).toBe(400);
    // Without signers "Senden" still sends the contact's single link.
    const sent = await t.api.post(`/api/contracts/${c.id}/send`, {});
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    expect(sent.data.signers).toBeUndefined();
    expect(sent.data.status).toBe('sent');
  });

  it('signs in order: one link per signer, the next one invited after the previous signature, the contract signed at the end', async () => {
    events.length = 0;
    const c = await draft('Kooperationsvertrag');
    const set = await t.api.put(`/api/contracts/${c.id}/signers`, {
      mode: 'sequential',
      signers: [
        { role: 'Kunde', name: 'Klara Kundin', email: 'klara@example.com' },
        { role: 'Geschäftsführung', name: 'Gerd Chef', email: 'gerd@example.com' },
      ],
    });
    expect(set.status, JSON.stringify(set.data)).toBe(200);
    expect(set.data.signers.map((s: any) => [s.position, s.role, s.status])).toEqual([
      [1, 'Kunde', 'waiting'],
      [2, 'Geschäftsführung', 'waiting'],
    ]);
    expect(set.data.signers[0].token).toBeUndefined();

    const sent = await t.api.post(`/api/contracts/${c.id}/send`, { subject: 'Bitte unterschreiben: {{contract.title}}', body: 'Hallo {{contact.first_name|}}, hier: {{contract.url}}' });
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    expect(sent.data.status).toBe('sent');
    expect(sent.data.signers.signers.map((s: any) => s.status)).toEqual(['invited', 'waiting']);
    // Placeholders are filled on the first send, as before.
    const row = t.app.db.get<any>('SELECT content FROM contracts WHERE id = ?', c.id);
    expect(row.content).toBe('Zwischen Testfirma und Kunde GmbH.');
    // The contact's invitation went into its conversation with its own link (not the contract's /s/ link).
    const msg = t.app.db.get<any>(`SELECT body FROM messages WHERE contact_id = ? AND subject = 'Bitte unterschreiben: Kooperationsvertrag'`, contactId);
    expect(msg.body).toContain(`/sign/${tokenOf(c.id, 1)}`);
    expect((await t.api.put(`/api/contracts/${c.id}/signers`, { signers: [] })).status).toBe(400);

    // The single-signer routes refuse; /s/ shows the overview.
    expect((await pub(`/api/public/contracts/${c.public_token}/sign`, { name: 'X', agree: true, signature: SIG })).status).toBe(409);
    const overview = await (await t.api.raw(`/s/${c.public_token}`)).text();
    expect(overview).toContain('Unterzeichner');
    expect(overview).toContain('Gerd Chef');
    expect(overview).not.toContain('id="pad"');

    // Signer 2 is not yet on: page without pad, signing refused.
    const second = tokenOf(c.id, 2);
    const waitPage = await (await t.api.raw(`/sign/${second}`)).text();
    expect(waitPage).toContain('noch nicht an der Reihe');
    expect(waitPage).not.toContain('id="pad"');
    expect((await pub(`/api/public/sign/${second}`, { name: 'Gerd Chef', agree: true, signature: SIG })).status).toBe(409);

    // Signer 1 opens (viewed) and signs.
    const first = tokenOf(c.id, 1);
    const page1 = await (await t.api.raw(`/sign/${first}`)).text();
    expect(page1).toContain('id="pad"');
    expect(t.app.db.get<any>('SELECT status FROM contracts WHERE id = ?', c.id).status).toBe('viewed');
    expect((await pub(`/api/public/sign/${first}`, { name: 'Klara Kundin', agree: false, signature: SIG })).status).toBe(400);
    expect((await pub(`/api/public/sign/${first}`, { name: 'Klara Kundin', agree: true, signature: 'data:text/plain,x' })).status).toBe(400);
    const s1 = await pub(`/api/public/sign/${first}`, { name: 'Klara Kundin', agree: true, signature: SIG });
    expect(s1).toEqual({ status: 200, data: { ok: true, remaining: 1 } });
    expect((await pub(`/api/public/sign/${first}`, { name: 'Klara Kundin', agree: true, signature: SIG })).status).toBe(409);
    expect(events.filter((e) => e.type === 'contract.signer_signed').map((e) => e.data.signer.role)).toEqual(['Kunde']);
    expect(events.some((e) => e.type === 'contract.signed')).toBe(false);
    const after1 = (await t.api.get(`/api/contracts/${c.id}/signers`)).data;
    expect(after1.signers.map((s: any) => s.status)).toEqual(['signed', 'invited']);
    expect(after1.signers[0]).toMatchObject({ signed_name: 'Klara Kundin', has_signature: true });
    expect(after1.signers[0].content_hash).toMatch(/^[0-9a-f]{64}$/);

    // Signer 2 signs: the contract is signed, contract.signed fires once with both signers.
    const s2 = await pub(`/api/public/sign/${second}`, { name: 'Gerd Chef', agree: true, signature: SIG });
    expect(s2.data).toEqual({ ok: true, remaining: 0 });
    const done = (await t.api.get(`/api/contracts/${c.id}`)).data;
    expect(done.status).toBe('signed');
    expect(done.signer_name).toBe('Klara Kundin (Kunde), Gerd Chef (Geschäftsführung)');
    const signed = events.filter((e) => e.type === 'contract.signed');
    expect(signed).toHaveLength(1);
    expect(signed[0].data.signers.map((s: any) => s.role)).toEqual(['Kunde', 'Geschäftsführung']);
    const final = await (await t.api.raw(`/sign/${second}`)).text();
    expect(final).toContain('Dokument-Prüfsumme');
    expect(final.match(/alt="Unterschrift /g)).toHaveLength(2);
  });

  it('parallel: everybody is invited at once; one decline ends the contract', async () => {
    events.length = 0;
    const c = await draft('Gesellschaftervereinbarung');
    await t.api.put(`/api/contracts/${c.id}/signers`, {
      mode: 'parallel',
      signers: [
        { role: 'Gesellschafter A', name: 'Anna A', email: 'anna@example.com' },
        { role: 'Gesellschafter B', name: 'Bernd B', email: 'bernd@example.com' },
        { role: 'Gesellschafter C', name: 'Carla C', email: 'carla@example.com' },
      ],
    });
    const sent = await t.api.post(`/api/contracts/${c.id}/send`, {});
    expect(sent.data.signers.signers.map((s: any) => s.status)).toEqual(['invited', 'invited', 'invited']);
    expect((await t.api.post(`/api/contracts/${c.id}/send`, { channel: 'sms' })).status).toBe(400);
    expect((await pub(`/api/public/sign/${tokenOf(c.id, 3)}`, { name: 'Carla C', agree: true, signature: SIG })).data.remaining).toBe(2);
    const sid = (await t.api.get(`/api/contracts/${c.id}/signers`)).data.signers[0].id;
    expect((await t.api.post(`/api/contracts/${c.id}/signers/${sid}/remind`, {})).status).toBe(200);
    expect((await pub(`/api/public/sign/${tokenOf(c.id, 2)}/decline`, { reason: 'Passt nicht' })).status).toBe(200);
    const k = (await t.api.get(`/api/contracts/${c.id}`)).data;
    expect(k).toMatchObject({ status: 'declined', decline_reason: 'Passt nicht' });
    expect(events.find((e) => e.type === 'contract.declined')?.data.signer.role).toBe('Gesellschafter B');
    expect((await pub(`/api/public/sign/${tokenOf(c.id, 1)}`, { name: 'Anna A', agree: true, signature: SIG })).status).toBe(409);
  });

  it('a voided contract stops the links; signer rows are exported and erased with the person', async () => {
    const c = await draft('Storno-Test');
    await t.api.put(`/api/contracts/${c.id}/signers`, { signers: [{ role: 'Kunde', name: 'Klara Kundin', email: 'klara@example.com' }] });
    await t.api.post(`/api/contracts/${c.id}/send`, {});
    await t.api.patch(`/api/contracts/${c.id}`, { status: 'void' });
    const tok = tokenOf(c.id, 1);
    expect(await (await t.api.raw(`/sign/${tok}`)).text()).toContain('nicht mehr gültig');
    expect((await pub(`/api/public/sign/${tok}`, { name: 'Klara', agree: true, signature: SIG })).status).toBe(409);
    expect((await (await t.api.raw('/sign/unbekannt')).status)).toBe(404);

    const exp = (await t.api.get(`/api/contacts/${contactId}/privacy-export`)).data;
    expect(exp.data['contract_signers (E-Mail)'].length).toBeGreaterThanOrEqual(2);
    const r = await t.api.post(`/api/contacts/${contactId}/erase`, { confirm: contactId });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    // The row of the signed contract stays (business record, like the contract), the void one goes.
    const left = t.app.db.all<any>(`SELECT k.status FROM contract_signers s JOIN contracts k ON k.id = s.contract_id WHERE s.email = 'klara@example.com'`);
    expect(left.map((x) => x.status)).toEqual(['signed']);
  });

  it('MCP tools relay to the routes', async () => {
    const c = await draft('MCP-Vertrag');
    const tools = t.app.services.mcpTools as any[];
    const set = tools.find((x) => x.name === 'ghl_contract_signers_set');
    const read = tools.find((x) => x.name === 'ghl_contract_signers');
    expect(set && read).toBeTruthy();
    expect(read.annotations.readOnlyHint).toBe(true);
    expect(set.inputSchema.required).toEqual(['location_id', 'contract_id', 'signers']);
  });
});
