import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { expireSweep } from '../server/services/sepa-mandates.js';
import { textHash } from '../server/services/sepa-model.js';
import { allAt, at, parseXml, textAt } from '../server/services/xml-lite.js';

/** SEPA without Stripe: settings, paper and online mandates, collection runs, paid/returned, transfers (docs/sepa.md). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const CREDITOR = 'DE98ZZZ09999999999';
const IBAN = 'DE89370400440532013000';

const contact = async (first: string, extra: Record<string, unknown> = {}) =>
  (await t.api.post('/api/contacts', { first_name: first, last_name: 'Kunde', email: `${first.toLowerCase()}@example.com`, address: 'Hauptstraße 7', postal_code: '80331', city: 'München', ...extra })).data.id as string;

/** A finalised invoice (gross = cents × 1.19). */
async function invoice(contactId: string, cents: number) {
  const r = await t.api.post('/api/invoices', { contact_id: contactId, title: 'Leistung', items: [{ name: 'Beratung', qty: 1, price_cents: cents, tax_rate: 19 }] });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  const f = await t.api.post(`/api/invoices/${r.data.id}/finalise`, {});
  expect(f.status, JSON.stringify(f.data)).toBe(200);
  return (await t.api.get(`/api/invoices/${r.data.id}`)).data;
}

const paper = async (contactId: string, over: Record<string, unknown> = {}) => {
  const r = await t.api.post('/api/sepa/mandates', { contact_id: contactId, holder: 'Max Kunde', iban: IBAN, signed_at: '2026-01-15', ...over });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};

const earliest = async () => (await t.api.get('/api/sepa/candidates')).data.earliest as string;

async function submittedRun(invoiceIds: string[]) {
  const date = await earliest();
  const run = await t.api.post('/api/sepa/runs', { invoice_ids: invoiceIds, collection_date: date });
  expect(run.status, JSON.stringify(run.data)).toBe(200);
  const sub = await t.api.post(`/api/sepa/runs/${run.data.id}/submit`, {});
  expect(sub.status, JSON.stringify(sub.data)).toBe(200);
  return sub.data;
}

const form = (body: Record<string, string>) => ({ method: 'POST', redirect: 'manual' as const, headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'vitest-browser' }, body: new URLSearchParams(body).toString() });

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  const s = await t.api.put('/api/invoice-settings', { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', contact_name: 'Erika Muster', contact_phone: '+49301234567', contact_email: 're@example.com', iban: 'DE02120300000000202051', bic: 'BYLADEM1001' });
  expect(s.status, JSON.stringify(s.data)).toBe(200);
});
afterAll(() => t.close());

describe('settings', () => {
  it('needs a valid creditor identifier and a lead time of at least one day', async () => {
    const before = (await t.api.get('/api/sepa/overview')).data;
    expect(before.ready).toBe(false);
    expect(before.problems.join(' ')).toContain('Gläubiger-ID');
    const bad = await t.api.put('/api/sepa/settings', { creditor_id: 'DE97ZZZ09999999999' });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain('Prüfziffern');
    expect((await t.api.put('/api/sepa/settings', { prenotify_days: 0 })).status).toBe(400);
    const ok = await t.api.put('/api/sepa/settings', { creditor_id: 'de98 zzz0 9999 9999 99' });
    expect(ok.data.settings).toMatchObject({ creditor_id: CREDITOR, prenotify_days: 14, prenotify_email: true });
    const after = (await t.api.get('/api/sepa/overview')).data;
    expect(after).toMatchObject({ ready: true, problems: [], creditor: { creditor_id: CREDITOR, iban_masked: 'DE02 •••• 2051' } });
    const st = (await t.api.get('/api/sepa/settings')).data;
    expect(st.creditor.iban).toBe('DE02120300000000202051');
    expect(st.return_codes.AM04.label).toContain('Deckung');
  });
});

describe('paper mandates', () => {
  it('validates IBAN, BIC rules and the signature date, numbers references and masks the IBAN', async () => {
    const c = await contact('Papier');
    expect((await t.api.post('/api/sepa/mandates', { contact_id: c, holder: 'X', iban: IBAN })).status).toBe(400);
    expect((await t.api.post('/api/sepa/mandates', { contact_id: c, holder: 'X', iban: 'DE89370400440532013001', signed_at: '2026-01-15' })).data.error).toContain('IBAN');
    const ch = await t.api.post('/api/sepa/mandates', { contact_id: c, holder: 'X', iban: 'CH9300762011623852957', signed_at: '2026-01-15' });
    expect(ch.data.error).toContain('BIC');
    expect((await t.api.post('/api/sepa/mandates', { contact_id: c, holder: 'X', iban: IBAN, signed_at: '2099-01-01' })).status).toBe(400);
    const m = await paper(c, { holder: 'Max Papier', iban: 'DE89 3704 0044 0532 0130 00' });
    expect(m).toMatchObject({ status: 'active', scheme: 'CORE', kind: 'RCUR', next_seq: 'FRST', iban: IBAN, source: 'paper' });
    expect(m.reference).toMatch(/^M-\d{4}-000001$/);
    expect(m.text).toContain('Ich ermächtige');
    const second = await paper(c);
    expect(second.reference).toMatch(/-000002$/);
    expect((await t.api.post('/api/sepa/mandates', { contact_id: c, holder: 'X', iban: IBAN, signed_at: '2026-01-15', reference: m.reference })).status).toBe(409);
    expect((await t.api.post('/api/sepa/mandates', { contact_id: c, holder: 'X', iban: IBAN, signed_at: '2026-01-15', reference: 'mit leer' })).status).toBe(400);
    const list = (await t.api.get(`/api/sepa/mandates?contact_id=${c}`)).data;
    expect(list).toHaveLength(2);
    expect(list[0].iban).toBe('DE89 •••• 3000');
    expect(JSON.stringify(list)).not.toContain(IBAN);
    expect((await t.api.get(`/api/sepa/mandates/${m.id}`)).data.iban).toBe(IBAN);
  });
});

describe('online mandate page', () => {
  let m: any;
  let tok = '';
  it('creates a pending mandate with a link scoped to it', async () => {
    const c = await contact('Online', { company: 'Online GmbH' });
    const other = await t.api.post('/api/sepa/mandates/request', { contact_id: await contact('Andere') });
    const r = await t.api.post('/api/sepa/mandates/request', { contact_id: c, send: true });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    m = r.data;
    expect(m).toMatchObject({ status: 'pending', source: 'online', holder: 'Online Kunde' });
    expect(m.mail).toMatchObject({ sent: true });
    tok = m.capture_url.split('/sepa/m/')[1];
    expect(tok.length).toBeGreaterThan(20);
    const page = await (await t.api.raw(`/sepa/m/${tok}`)).text();
    expect(page).toContain(m.reference);
    expect(page).toContain(CREDITOR);
    expect(page).toContain('Ich ermächtige');
    expect(page).toContain('acht Wochen');
    expect(page).not.toContain(other.data.reference);
    const res = await t.api.raw(`/sepa/m/${tok}`);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect((await t.api.raw('/sepa/m/notatokenthatexistsanywhere')).status).toBe(404);
    expect((await t.api.raw('/sepa/m/notatokenthatexistsanywhere', form({ agree: '1' }))).status).toBe(404);
  });

  it('refuses without the tick, with a changed text or a wrong IBAN, then stores the proof', async () => {
    const page = await (await t.api.raw(`/sepa/m/${tok}`)).text();
    const hash = /name="text_hash" value="([0-9a-f]{64})"/.exec(page)![1];
    const base = { text_hash: hash, holder: 'Olga Online', iban: IBAN, bic: '', street: 'Weg 1', postal_code: '10115', city: 'Berlin', country: 'DE', signed_place: 'Berlin' };
    const noTick = await t.api.raw(`/sepa/m/${tok}`, form(base));
    expect(noTick.status).toBe(400);
    expect(await noTick.text()).toContain('Häkchen');
    expect((await t.api.raw(`/sepa/m/${tok}`, form({ ...base, agree: '1', text_hash: 'x' }))).status).toBe(400);
    const wrong = await t.api.raw(`/sepa/m/${tok}`, form({ ...base, agree: '1', iban: 'DE00123' }));
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('IBAN');
    const ok = await t.api.raw(`/sepa/m/${tok}`, form({ ...base, agree: '1' }));
    expect(ok.status).toBe(303);
    const done = await (await t.api.raw(`/sepa/m/${tok}`)).text();
    expect(done).toContain('Mandat erteilt');
    expect(done).toContain('DE89 •••• 3000');
    expect(done).not.toContain(IBAN);
    const full = (await t.api.get(`/api/sepa/mandates/${m.id}`)).data;
    expect(full).toMatchObject({ status: 'active', holder: 'Olga Online', iban: IBAN, city: 'Berlin', signed_place: 'Berlin', capture_url: '' });
    expect(full.proof).toMatchObject({ method: 'online', ip_net: '127.0.0.0/24', text_hash: full.text_hash });
    expect(full.proof.ua_digest).toMatch(/^[0-9a-f]{16}$/);
    expect(full.text_hash).toBe(textHash(full.text));
    expect(full.text_hash).toBe(hash);
    // signing twice changes nothing
    const again = await t.api.raw(`/sepa/m/${tok}`, form({ ...base, agree: '1', holder: 'Jemand anders' }));
    expect(await again.text()).toContain('Mandat erteilt');
    expect((await t.api.get(`/api/sepa/mandates/${m.id}`)).data.holder).toBe('Olga Online');
    const mails = t.app.db.all<{ subject: string }>(`SELECT subject FROM messages WHERE contact_id = ? ORDER BY created_at`, full.contact_id).map((x) => x.subject);
    expect(mails.some((s) => s.includes('Bitte SEPA-Lastschriftmandat erteilen'))).toBe(true);
    expect(mails.some((s) => s.includes(`Dein SEPA-Lastschriftmandat ${m.reference}`))).toBe(true);
  });

  it('a revoked or expired link does not work', async () => {
    const r = await t.api.post('/api/sepa/mandates/request', { contact_id: await contact('Widerruf') });
    const tk = r.data.capture_url.split('/sepa/m/')[1];
    await t.api.post(`/api/sepa/mandates/${r.data.id}/revoke`, { reason: 'Kunde will nicht' });
    expect((await t.api.raw(`/sepa/m/${tk}`)).status).toBe(404);
    const r2 = await t.api.post('/api/sepa/mandates/request', { contact_id: await contact('Abgelaufen') });
    t.app.db.run('UPDATE sepa_mandates SET capture_expires_at = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', r2.data.id);
    expect((await t.api.raw(`/sepa/m/${r2.data.capture_url.split('/sepa/m/')[1]}`)).status).toBe(410);
  });
});

describe('collection runs', () => {
  let cA = '';
  let mA: any;
  let i1: any;
  let i2: any;
  let runId = '';

  it('lists open finalised invoices of contacts with a mandate and previews groups and totals', async () => {
    cA = await contact('Anna');
    mA = await paper(cA, { holder: 'Anna Kunde', bic: 'COBADEFFXXX' });
    i1 = await invoice(cA, 10000);
    i2 = await invoice(cA, 2000);
    const noMandate = await invoice(await contact('Ohne'), 5000);
    const cands = (await t.api.get('/api/sepa/candidates')).data;
    const mine = cands.items.filter((x: any) => x.contact_id === cA);
    expect(mine.map((x: any) => x.number).sort()).toEqual([i1.number, i2.number].sort());
    expect(mine.every((x: any) => x.seq === 'FRST' && x.ok && x.mandate_ref === mA.reference)).toBe(true);
    expect(cands.items.some((x: any) => x.invoice_id === noMandate.id)).toBe(false);
    const early = await t.api.post('/api/sepa/runs/preview', { invoice_ids: [i1.id], collection_date: '2020-01-02' });
    expect(early.data.ok).toBe(false);
    expect(early.data.errors.join(' ')).toContain('frühestens');
    const p = (await t.api.post('/api/sepa/runs/preview', { invoice_ids: [i1.id, i2.id, noMandate.id], collection_date: cands.earliest })).data;
    expect(p.ok).toBe(false);
    const ok = (await t.api.post('/api/sepa/runs/preview', { invoice_ids: [i1.id, i2.id], collection_date: cands.earliest })).data;
    expect(ok).toMatchObject({ ok: true, count: 2, total_cents: 11900 + 2380, groups: [{ seq: 'FRST', scheme: 'CORE', count: 2, total_cents: 14280 }] });
  });

  it('creates the run with pre-notifications, then submits the pain.008 file', async () => {
    const date = await earliest();
    const run = (await t.api.post('/api/sepa/runs', { invoice_ids: [i1.id, i2.id], collection_date: date })).data;
    runId = run.id;
    expect(run).toMatchObject({ status: 'draft', kind: 'debit', exec_date: date, tx_count: 2, total_cents: 14280, has_xml: false });
    expect(run.items.every((x: any) => x.notify_status === 'sent' && x.status === 'draft')).toBe(true);
    const mail = t.app.db.get<{ subject: string; body: string }>(`SELECT subject, body FROM messages WHERE contact_id = ? AND source = 'SEPA-Vorabankündigung'`, cA)!;
    expect(mail.subject).toContain('Vorabankündigung');
    expect(mail.body).toContain(mA.reference);
    expect(mail.body).toContain(CREDITOR);
    expect(mail.body).toContain('DE89 •••• 3000');
    expect(mail.body).toContain('142,80');
    // still a draft: no file yet, invoices are no candidates any more
    expect((await t.api.get(`/api/sepa/runs/${runId}/xml`)).status).toBe(400);
    expect((await t.api.get('/api/sepa/candidates')).data.items.some((x: any) => x.invoice_id === i1.id)).toBe(false);
    const sub = await t.api.post(`/api/sepa/runs/${runId}/submit`, {});
    expect(sub.status, JSON.stringify(sub.data)).toBe(200);
    expect(sub.data).toMatchObject({ status: 'submitted', has_xml: true, dropped: [] });
    const xml = await (await t.api.raw(`/api/sepa/runs/${runId}/xml`, { headers: { cookie: t.api.cookie, 'x-location-id': loc } })).text();
    const root = at(parseXml(xml), 'CstmrDrctDbtInitn');
    expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:pain.008.001.08');
    expect(textAt(root, 'GrpHdr/CtrlSum')).toBe('142.80');
    expect(textAt(root, 'PmtInf/PmtTpInf/SeqTp')).toBe('FRST');
    expect(textAt(root, 'PmtInf/ReqdColltnDt')).toBe(date);
    expect(textAt(root, 'PmtInf/CdtrSchmeId/Id/PrvtId/Othr/Id')).toBe(CREDITOR);
    expect(textAt(root, 'PmtInf/CdtrAcct/Id/IBAN')).toBe('DE02120300000000202051');
    expect(allAt(root, 'PmtInf/DrctDbtTxInf').map((x) => textAt(x, 'PmtId/EndToEndId')).sort()).toEqual([i1.number, i2.number].sort());
    expect(textAt(root, 'PmtInf/DrctDbtTxInf/DrctDbtTx/MndtRltdInf/MndtId')).toBe(mA.reference);
    expect(textAt(root, 'PmtInf/DrctDbtTxInf/DbtrAgt/FinInstnId/BICFI')).toBe('COBADEFFXXX');
    // the invoice's audit trail says "eingereicht"; dunning holds off meanwhile
    const audit = (await t.api.get(`/api/invoices/${i1.id}/audit`)).data;
    expect(JSON.stringify(audit)).toContain('SEPA-Lastschrift eingereicht');
    expect(t.app.db.get<{ reason: string }>('SELECT reason FROM dunning_holds WHERE invoice_id = ?', i1.id)?.reason).toBe('SEPA-Lastschrift eingereicht');
    expect((await t.api.post(`/api/sepa/runs/${runId}/submit`, {})).status).toBe(409);
  });

  it('moves the mandate from FRST to RCUR after the run', async () => {
    const m = (await t.api.get(`/api/sepa/mandates/${mA.id}`)).data;
    expect(m).toMatchObject({ next_seq: 'RCUR', first_used_at: (await t.api.get(`/api/sepa/runs/${runId}`)).data.exec_date });
    const i3 = await invoice(cA, 500);
    const c = (await t.api.get('/api/sepa/candidates')).data.items.find((x: any) => x.invoice_id === i3.id);
    expect(c).toMatchObject({ seq: 'RCUR', seq_label: 'Folgelastschrift' });
  });

  it('marks a collection paid through the invoice flow and a return reopens the invoice', async () => {
    const run = (await t.api.get(`/api/sepa/runs/${runId}`)).data;
    const it1 = run.items.find((x: any) => x.invoice_id === i1.id);
    const paid = await t.api.post(`/api/sepa/items/${it1.id}/paid`, {});
    expect(paid.status, JSON.stringify(paid.data)).toBe(200);
    let inv = (await t.api.get(`/api/invoices/${i1.id}`)).data;
    expect(inv).toMatchObject({ status: 'paid', open_cents: 0 });
    expect(inv.payments.some((p: any) => p.method === 'SEPA-Lastschrift' && p.source === 'sepa' && p.amount_cents === 11900)).toBe(true);
    const ret = await t.api.post(`/api/sepa/items/${it1.id}/return`, { code: 'AM04', fee_cents: 350, fee_invoice: true, note: 'Bank meldet' });
    expect(ret.status, JSON.stringify(ret.data)).toBe(200);
    inv = (await t.api.get(`/api/invoices/${i1.id}`)).data;
    expect(inv).toMatchObject({ state: 'open', open_cents: 11900, paid_cents: 0 });
    expect(inv.payments.some((p: any) => p.kind === 'reversal' && p.amount_cents === -11900 && p.note.includes('AM04'))).toBe(true);
    const item = ret.data.items.find((x: any) => x.id === it1.id);
    expect(item).toMatchObject({ status: 'returned', return_code: 'AM04', return_label: 'Keine ausreichende Deckung', fee_cents: 350 });
    const fee = (await t.api.get(`/api/invoices/${ret.data.fee_invoice_id}`)).data;
    expect(fee).toMatchObject({ status: 'draft', total_cents: 350, contact_id: cA, tax_mode: 'tax_free' });
    expect(t.app.db.get('SELECT 1 AS x FROM dunning_holds WHERE invoice_id = ?', i1.id)).toBeUndefined();
    // AM04 keeps the mandate; the invoice can be collected again (with a new pre-notification)
    expect((await t.api.get(`/api/sepa/mandates/${mA.id}`)).data.status).toBe('active');
    expect((await t.api.get('/api/sepa/candidates')).data.items.some((x: any) => x.invoice_id === i1.id)).toBe(true);
    expect((await t.api.post(`/api/sepa/items/${it1.id}/return`, { code: 'AM04' })).status).toBe(409);
    expect((await t.api.post(`/api/sepa/items/${it1.id}/return`, { code: 'XX99' })).status).toBe(409);
  });

  it('an invoice paid another way settles its collection and closes the run', async () => {
    const run = (await t.api.get(`/api/sepa/runs/${runId}`)).data;
    const it2 = run.items.find((x: any) => x.invoice_id === i2.id);
    expect(it2.status).toBe('submitted');
    await t.api.post(`/api/invoices/${i2.id}/payments`, { method: 'Überweisung' });
    await t.app.events.flush();
    const after = (await t.api.get(`/api/sepa/runs/${runId}`)).data;
    expect(after.items.find((x: any) => x.id === it2.id).status).toBe('paid');
    expect(after.status).toBe('closed');
  });

  it('a returned first collection makes the next one FRST again; MD01 revokes the mandate', async () => {
    const c = await contact('Erst');
    const m = await paper(c);
    const inv = await invoice(c, 3000);
    const run = await submittedRun([inv.id]);
    expect((await t.api.get(`/api/sepa/mandates/${m.id}`)).data.next_seq).toBe('RCUR');
    await t.api.post(`/api/sepa/items/${run.items[0].id}/return`, { code: 'MS02' });
    expect((await t.api.get(`/api/sepa/mandates/${m.id}`)).data.next_seq).toBe('FRST');
    const run2 = await submittedRun([inv.id]);
    await t.api.post(`/api/sepa/items/${run2.items[0].id}/return`, { code: 'MD01' });
    const ended = (await t.api.get(`/api/sepa/mandates/${m.id}`)).data;
    expect(ended).toMatchObject({ status: 'revoked' });
    expect(ended.end_reason).toContain('MD01');
    expect((await t.api.get('/api/sepa/candidates')).data.items.some((x: any) => x.invoice_id === inv.id)).toBe(false);
  });

  it('drafts can be thrown away, a rejected file withdrawn – the sequence state comes back', async () => {
    const c = await contact('Zurueck');
    const m = await paper(c);
    const inv = await invoice(c, 4000);
    const date = await earliest();
    const draft = (await t.api.post('/api/sepa/runs', { invoice_ids: [inv.id], collection_date: date, notify: false })).data;
    expect(draft.items[0].notify_status).toBe('manual');
    expect((await t.api.post(`/api/sepa/runs/${draft.id}/cancel`, { reason: 'Falsches Datum' })).data.status).toBe('cancelled');
    const run = await submittedRun([inv.id]);
    expect((await t.api.get(`/api/sepa/mandates/${m.id}`)).data.next_seq).toBe('RCUR');
    const back = await t.api.post(`/api/sepa/runs/${run.id}/cancel`, { reason: 'Bank hat die Datei abgelehnt' });
    expect(back.data.status).toBe('cancelled');
    const mm = (await t.api.get(`/api/sepa/mandates/${m.id}`)).data;
    expect(mm).toMatchObject({ next_seq: 'FRST', first_used_at: null });
    expect(JSON.stringify((await t.api.get(`/api/invoices/${inv.id}/audit`)).data)).toContain('zurückgezogen');
    expect((await t.api.get('/api/sepa/candidates')).data.items.some((x: any) => x.invoice_id === inv.id)).toBe(true);
  });

  it('a one-off mandate takes one invoice and is used up after the run', async () => {
    const c = await contact('Einmal');
    const m = await paper(c, { kind: 'OOFF' });
    const a = await invoice(c, 1000);
    const b = await invoice(c, 1000);
    const cands = (await t.api.get('/api/sepa/candidates')).data.items.filter((x: any) => x.contact_id === c);
    expect(cands.find((x: any) => x.invoice_id === a.id)).toMatchObject({ ok: true, seq: 'OOFF' });
    expect(cands.find((x: any) => x.invoice_id === b.id).problems.join()).toContain('Einmal-Mandat');
    await submittedRun([a.id]);
    expect((await t.api.get(`/api/sepa/mandates/${m.id}`)).data.status).toBe('used');
  });

  it('expires mandates after 36 months without a collection', async () => {
    const c = await contact('Alt');
    const m = await paper(c, { signed_at: '2020-02-01' });
    expect((await t.api.get(`/api/sepa/mandates/${m.id}`)).data.status).toBe('expired');
    expect(expireSweep(t.app, new Date().toISOString().slice(0, 10))).toBeGreaterThanOrEqual(1);
    expect(t.app.db.get<{ status: string }>('SELECT status FROM sepa_mandates WHERE id = ?', m.id)!.status).toBe('expired');
    await invoice(c, 1000);
    expect((await t.api.get('/api/sepa/candidates')).data.items.some((x: any) => x.contact_id === c)).toBe(false);
  });
});

describe('transfers (pain.001.001.09)', () => {
  it('pays open supplier invoices and a manual payout list', async () => {
    const at0 = new Date().toISOString();
    t.app.db.run(
      `INSERT INTO acc_receipts (id, location_id, status, supplier, invoice_no, invoice_date, due_date, currency, net_cents, vat_cents, gross_cents, vat_rate, iban, payment, created_at, updated_at)
       VALUES ('rcpt1', ?, 'booked', 'Lieferant AG', 'ER-4711', '2026-09-01', '2026-10-01', 'EUR', 10000, 1900, 11900, 19, 'DE89370400440532013000', 'open', ?, ?)`,
      loc, at0, at0,
    );
    const open = (await t.api.get('/api/sepa/payables')).data;
    expect(open.available).toBe(true);
    expect(open.items.find((x: any) => x.receipt_id === 'rcpt1')).toMatchObject({ ok: true, amount_cents: 11900, invoice_no: 'ER-4711' });
    expect((await t.api.post('/api/sepa/transfers', { lines: [{ name: 'X', iban: 'DE00', amount_cents: 100 }] })).status).toBe(400);
    expect((await t.api.post('/api/sepa/transfers', { lines: [{ name: 'X', iban: IBAN, amount_cents: 0 }] })).status).toBe(400);
    const r = await t.api.post('/api/sepa/transfers', { receipt_ids: ['rcpt1'], lines: [{ name: 'Partner Jörg', iban: IBAN, amount_cents: 2500, reference: 'Provision Oktober' }] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ kind: 'transfer', status: 'submitted', tx_count: 2, total_cents: 14400, source: 'mixed' });
    const xml = await (await t.api.raw(`/api/sepa/runs/${r.data.id}/xml`, { headers: { cookie: t.api.cookie, 'x-location-id': loc } })).text();
    const root = at(parseXml(xml), 'CstmrCdtTrfInitn');
    expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:pain.001.001.09');
    expect(textAt(root, 'GrpHdr/CtrlSum')).toBe('144.00');
    expect(textAt(root, 'PmtInf/DbtrAcct/Id/IBAN')).toBe('DE02120300000000202051');
    expect(allAt(root, 'PmtInf/CdtTrfTxInf').map((x) => textAt(x, 'PmtId/EndToEndId'))).toEqual(['ER-4711', 'Provision-Oktober']);
    expect((await t.api.get('/api/sepa/payables')).data.items.some((x: any) => x.receipt_id === 'rcpt1')).toBe(false);
    const runs = (await t.api.get('/api/sepa/runs?kind=transfer')).data;
    expect(runs[0]).toMatchObject({ id: r.data.id, kind_label: 'Überweisung' });
    expect(runs[0].xml).toBeUndefined();
  });
});

describe('isolation and tools', () => {
  it('another sub-account sees none of it', async () => {
    const mine = (await t.api.get('/api/sepa/mandates')).data;
    const B = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
    const other = { 'x-location-id': B };
    expect((await t.api.get('/api/sepa/mandates', other)).data).toEqual([]);
    expect((await t.api.get(`/api/sepa/mandates/${mine[0].id}`, other)).status).toBe(404);
    const run = (await t.api.get('/api/sepa/runs')).data[0];
    expect((await t.api.get(`/api/sepa/runs/${run.id}`, other)).status).toBe(404);
    expect((await t.api.get(`/api/sepa/runs/${run.id}/xml`, other)).status).toBe(404);
    expect((await t.api.post(`/api/sepa/items/x/paid`, {}, other)).status).toBe(404);
  });

  it('registers read-only MCP tools and workflow triggers', () => {
    const tools = (t.app.services.mcpTools as any[]).filter((x) => x.name.startsWith('ghl_sepa_'));
    expect(tools.map((x) => x.name)).toEqual(['ghl_sepa_mandates', 'ghl_sepa_runs']);
    expect(tools.every((x) => x.annotations.readOnlyHint)).toBe(true);
    expect(t.app.services.workflowTriggers).toEqual(expect.arrayContaining(['sepa.mandate_signed', 'sepa.returned']));
  });
});
