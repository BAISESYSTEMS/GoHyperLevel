import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvalReasons, DEFAULT_RULE, quoteFigures } from '../server/services/quote-approval.js';
import { getQuote, sendQuote } from '../server/services/quote-engine.js';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';

/**
 * Internal approval of quotes: the rule (amount / discount), requests, approve and reject with comment by the right role only, audit
 * and notifications – and the gate in the send path that no route, key, MCP tool or direct service call gets past. The customer's
 * page and signature stay as they are.
 */

const item = (name: string, price_cents: number, extra: Record<string, unknown> = {}) => ({ id: name.toLowerCase(), name, qty: 1, price_cents, tax_rate: 19, discount_type: 'none', discount_value: 0, optional: false, selected: false, ...extra });

describe('figures and reasons', () => {
  it('takes the most expensive variant with every optional position and the highest discount', () => {
    const doc = {
      items: [item('Basis', 100000), item('Extra', 50000, { optional: true }), item('Rabattiert', 10000, { discount_type: 'percent', discount_value: 25 })],
      options: [
        { id: 'a', name: 'A', description: '', recommended: false, items: [item('Lizenz A', 100000)] },
        { id: 'b', name: 'B', description: '', recommended: true, items: [item('Lizenz B', 300000), item('Gutschrift', -40000)] },
      ],
    };
    const f = quoteFigures(doc as any);
    // B: 100000 + 50000 + 7500 + 300000 − 40000
    expect(f.max_net_cents).toBe(417500);
    // single line 25 %; variant B: (2500 + 40000) / 460000 = 9.2 %
    expect(f.max_discount_percent).toBe(25);
    const rule = { ...DEFAULT_RULE, enabled: true, min_net_cents: 400000, max_discount_percent: 20 };
    expect(approvalReasons(rule, f)).toEqual(['Netto-Summe 4.175,00 € über 4.000,00 €', 'Rabatt 25 % über 20 %']);
    expect(approvalReasons({ ...rule, enabled: false }, f)).toEqual([]);
    expect(approvalReasons({ ...rule, min_net_cents: 500000, max_discount_percent: null }, f)).toEqual([]);
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let pipe: any;
let contactId = '';
let vera: Call;
let lea: Call;
let veraId = '';
let leaId = '';
let key = '';
const mails: any[] = [];

async function newQuote(as: Call | null, items: any[]) {
  const d = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: contactId, name: `Deal ${Math.random().toString(36).slice(2, 6)}`, value: 0 })).data;
  const body = { deal_id: d.id, title: 'Plattform', items };
  const r = as ? await as('POST', '/api/quotes', body) : await t.api.post('/api/quotes', body);
  expect(r.status, JSON.stringify((r as any).data)).toBe(200);
  return (r as any).data;
}
const viaKey = (method: string, path: string, body?: unknown) => t.api.raw(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: (await r.json()) as any }));
const mcp = async (name: string, args: any) => {
  const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()) as any;
};
const statusOf = (id: string) => getQuote(t.app, loc, id)!.status;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: ['Neu', 'Angebot'] })).data;
  contactId = (await t.api.post('/api/contacts', { email: 'kundin@kunde.example', first_name: 'Erika', last_name: 'Kundin' })).data.id;
  t.app.services.emailTransports = { capture: async (_l: any, mail: any) => (mails.push(mail), { status: 'sent', providerId: `m${mails.length}` }) };
  await t.api.patch('/api/location', { settings: { email: { provider: 'capture' } } });
  const mk = async (email: string, name: string, permissions: string[]) => (await t.api.post('/api/users', { email, name, password: 'passwort-1', role: 'member', locations: [loc], permissions })).data.id as string;
  veraId = await mk('vera@example.com', 'Vera Vertrieb', ['opportunities', 'contacts']);
  leaId = await mk('lea@example.com', 'Lea Leitung', ['opportunities', 'contacts', 'settings']);
  const login = async (email: string) => {
    const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
    expect((await c('POST', '/api/auth/login', { email, password: 'passwort-1' })).status).toBe(200);
    return c;
  };
  vera = await login('vera@example.com');
  lea = await login('lea@example.com');
  key = (await t.api.post('/api/api-keys', { name: 'Test' })).data.key;
}, 60_000);
afterAll(() => t.close());

describe('the rule', () => {
  it('only a signed-in Leitung or admin changes it – never a key or a member without settings', async () => {
    const rule = { enabled: true, min_net_cents: 500000, max_discount_percent: 15, approver_role: 'leitung' };
    expect((await viaKey('PUT', '/api/quote-approvals/settings', { enabled: false })).status).toBe(403);
    expect((await vera('PUT', '/api/quote-approvals/settings', rule)).status).toBe(403);
    expect((await t.api.put('/api/quote-approvals/settings', { enabled: true })).status).toBe(400); // no limit given
    const r = await lea('PUT', '/api/quote-approvals/settings', rule);
    expect(r.status, r.text).toBe(200);
    expect(r.data.rule).toMatchObject({ enabled: true, min_net_cents: 500000, max_discount_percent: 15, approver_role: 'leitung' });
    expect(r.data.approvers).toBe(2); // the admin and Lea
    expect((await vera('GET', '/api/quote-approvals/settings')).data).toMatchObject({ can_configure: false, rule: { enabled: true } });
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'quote.approval.rule'`).n).toBe(1);
  });
});

describe('the gate', () => {
  it('lets small quotes through and blocks big ones on every path until approved', async () => {
    const small = await newQuote(vera, [item('Klein', 100000)]);
    expect((await vera('GET', `/api/quote-approvals/quotes/${small.id}`)).data).toMatchObject({ required: false, may_send: true });
    expect((await viaKey('POST', `/api/quotes/${small.id}/send`, { deliver: false })).status).toBe(200);

    const big = await newQuote(vera, [item('Groß', 600000)]);
    const st = (await vera('GET', `/api/quote-approvals/quotes/${big.id}`)).data;
    expect(st).toMatchObject({ required: true, may_send: false, approved: false, reasons: ['Netto-Summe 6.000,00 € über 5.000,00 €'] });
    // web, key, MCP and a direct call of the service – all refused
    const web = await vera('POST', `/api/quotes/${big.id}/send`, { deliver: false });
    expect(web.status).toBe(409);
    expect(web.data).toMatchObject({ approval_required: true });
    expect((await viaKey('POST', `/api/quotes/${big.id}/send`, { deliver: true })).status).toBe(409);
    const tool = await mcp('ghl_quote_send', { quote_id: big.id, deliver: false });
    expect(JSON.stringify(tool)).toContain('Genehmigung');
    await expect(sendQuote(t.app, loc, getQuote(t.app, loc, big.id)!, { deliver: false })).rejects.toThrow(/Genehmigung/);
    expect(statusOf(big.id)).toBe('draft');
    expect(mails).toHaveLength(0);
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'quote.approval.blocked' AND entity_id = ?`, big.id).n).toBeGreaterThanOrEqual(4);

    // request → only the role decides, never the requester, never a key
    const req = await vera('POST', `/api/quote-approvals/quotes/${big.id}/request`, { comment: 'Großkunde, bitte schnell' });
    expect(req.status, req.text).toBe(200);
    expect(req.data.current).toMatchObject({ status: 'pending', requested_by: veraId, request_comment: 'Großkunde, bitte schnell' });
    const aid = req.data.current.id;
    expect((await vera('POST', `/api/quote-approvals/quotes/${big.id}/request`, {})).status).toBe(409);
    const note = t.app.db.get<any>(`SELECT * FROM pm_notifications WHERE user_id = ? AND kind = 'approval'`, leaId);
    expect(note).toMatchObject({ link: `/app/sales/angebote?quote=${big.id}` });
    expect(note.title).toContain('Genehmigung angefragt');
    expect((await vera('POST', `/api/quote-approvals/${aid}/approve`, {})).status).toBe(403);
    expect((await viaKey('POST', `/api/quote-approvals/${aid}/approve`, {})).status).toBe(403);
    expect((await vera('POST', `/api/quotes/${big.id}/send`, { deliver: false })).status).toBe(409);
    expect((await lea('GET', '/api/quote-approvals?status=pending')).data.find((a: any) => a.id === aid)).toMatchObject({ may_decide: true, quote: { title: 'Plattform' } });
    expect((await vera('GET', '/api/quote-approvals?status=pending')).data.find((a: any) => a.id === aid)).toMatchObject({ may_decide: false });

    const ok = await lea('POST', `/api/quote-approvals/${aid}/approve`, { comment: 'Passt so' });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.data).toMatchObject({ status: 'approved', decided_by: leaId, decision_comment: 'Passt so', decided_by_name: 'Lea Leitung' });
    expect((await lea('POST', `/api/quote-approvals/${aid}/reject`, { comment: 'doch nicht' })).status).toBe(409);
    expect(t.app.db.get<any>(`SELECT * FROM audit_log WHERE action = 'quote.approval.approved' AND entity_id = ?`, big.id)).toMatchObject({ user_id: leaId });
    expect(t.app.db.get<any>(`SELECT * FROM pm_notifications WHERE user_id = ? AND kind = 'approval'`, veraId).title).toContain('genehmigt');

    // changed after the approval: the approval no longer covers it
    expect((await vera('PATCH', `/api/quotes/${big.id}`, { items: [item('Groß', 700000)] })).status).toBe(200);
    const stale = (await vera('GET', `/api/quote-approvals/quotes/${big.id}`)).data;
    expect(stale).toMatchObject({ approved: false, may_send: false, current: { status: 'approved', stale: true } });
    const again = await viaKey('POST', `/api/quotes/${big.id}/send`, { deliver: false });
    expect(again.status).toBe(409);
    expect(again.data.error).toContain('nach der Genehmigung geändert');

    // a rejection needs a reason and keeps the gate shut
    const req2 = (await vera('POST', `/api/quote-approvals/quotes/${big.id}/request`, {})).data.current.id;
    expect((await lea('POST', `/api/quote-approvals/${req2}/reject`, {})).status).toBe(400);
    expect((await lea('POST', `/api/quote-approvals/${req2}/reject`, { comment: 'Rabatt zu hoch' })).data).toMatchObject({ status: 'rejected' });
    expect((await viaKey('POST', `/api/quotes/${big.id}/send`, { deliver: false })).status).toBe(409);

    // approved for the current content: now it goes out – also through a key – and the customer page works as before
    const req3 = (await vera('POST', `/api/quote-approvals/quotes/${big.id}/request`, {})).data.current.id;
    expect((await lea('POST', `/api/quote-approvals/${req3}/approve`, {})).status).toBe(200);
    const sent = await viaKey('POST', `/api/quotes/${big.id}/send`, { deliver: true });
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    expect(sent.data).toMatchObject({ status: 'sent' });
    expect(mails).toHaveLength(1);
    const tok = t.app.db.get<any>('SELECT public_token FROM deal_quotes WHERE id = ?', big.id).public_token;
    expect((await t.api.raw(`/q/${tok}`)).status).toBe(200);
    // re-sending a sent quote is not gated again
    expect((await vera('POST', `/api/quotes/${big.id}/send`, { deliver: false })).status).toBe(200);
  });

  it('discounts above the limit need approval; approvers do not approve their own quotes unless allowed', async () => {
    const q = await newQuote(lea, [item('Paket', 100000, { discount_type: 'percent', discount_value: 20 })]);
    expect((await lea('GET', `/api/quote-approvals/quotes/${q.id}`)).data.reasons).toEqual(['Rabatt 20 % über 15 %']);
    const aid = (await lea('POST', `/api/quote-approvals/quotes/${q.id}/request`, {})).data.current.id;
    expect((await lea('POST', `/api/quote-approvals/${aid}/approve`, {})).status).toBe(403);
    expect((await lea('PUT', '/api/quote-approvals/settings', { self_approve: true })).status).toBe(200);
    expect((await lea('POST', `/api/quote-approvals/${aid}/approve`, {})).status).toBe(200);
    expect((await lea('POST', `/api/quotes/${q.id}/send`, { deliver: false })).status).toBe(200);
    await lea('PUT', '/api/quote-approvals/settings', { self_approve: false });
  });

  it('withdrawing, team leads as approvers, and other sub-accounts', async () => {
    const q = await newQuote(vera, [item('Groß', 900000)]);
    const aid = (await vera('POST', `/api/quote-approvals/quotes/${q.id}/request`, {})).data.current.id;
    expect((await vera('POST', `/api/quote-approvals/${aid}/withdraw`, {})).data).toMatchObject({ status: 'withdrawn' });

    // team leads of a sales team approve
    const team = (await t.api.post('/api/sales/teams', { name: 'Team Nord', members: [{ user_id: veraId, role: 'lead' }] })).data;
    expect((await lea('PUT', '/api/quote-approvals/settings', { approver_role: 'team_lead' })).status).toBe(400);
    expect((await lea('PUT', '/api/quote-approvals/settings', { approver_role: 'team_lead', team_id: team.id })).status).toBe(200);
    const aid2 = (await lea('POST', `/api/quote-approvals/quotes/${q.id}/request`, {})).data.current.id;
    expect((await lea('POST', `/api/quote-approvals/${aid2}/approve`, {})).status).toBe(403);
    expect((await vera('POST', `/api/quote-approvals/${aid2}/approve`, {})).status).toBe(200);
    await lea('PUT', '/api/quote-approvals/settings', { approver_role: 'leitung' });

    // another sub-account: nothing of A is found there
    const B = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
    const other = client(t.base, { 'x-pghl': '1', 'x-location-id': B, cookie: t.api.cookie });
    expect((await other('GET', `/api/quote-approvals/quotes/${q.id}`)).status).toBe(404);
    expect((await other('POST', `/api/quote-approvals/${aid2}/withdraw`, {})).status).toBe(404);
    expect((await other('GET', '/api/quote-approvals')).data).toEqual([]);
    expect((await other('GET', '/api/quote-approvals/settings')).data.rule.enabled).toBe(false);
  });
});
