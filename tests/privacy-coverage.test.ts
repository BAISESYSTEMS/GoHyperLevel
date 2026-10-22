import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, seedBooksSyncRows, seedCogneeRows, seedCreatorRows, seedLocation, seedMarketingRows, seedTelephonyRows } from './security-fixtures.js';

/**
 * DSGVO completeness over the whole app: a sub-account is filled through the regular API (every module the security harness
 * knows), then one contact is erased (Art. 17) – the business records the agency must or may keep stay (unlinked), and nothing
 * else about the person is left behind.
 */

const TAG = 'Zorblax';
/** Kept with the person's data on purpose, only unlinked: invoices, contracts, the books, the personnel file, stock documents. */
/** The invoice trail (invoice_audit, unchangeable like the invoice) names the address an invoice was mailed to – the store's order confirmation. */
const RETAINED_WITH_DATA = ['acc_entries', 'contracts', 'hr_employees', 'inv_articles', 'invoice_audit', 'invoices'];
/** Tables whose rows a module exports under its own heading. */
const EXPORT_ALIAS: Record<string, string> = {
  community_dm_threads: 'Community-Direktnachrichten',
  community_blocks: 'Community-Blockierungen',
  community_dm_reports: 'Community-Meldungen (Nachrichten)',
};
let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let c = '';
let ids: Record<string, string> = {};
let erased: any;
/** Files of the person on disk (videos, hand-ins, attachments, the cached certificate PDF). */
let personFiles: string[] = [];

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  const call = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1' });
  const r = await seedLocation(call, loc, TAG);
  expect(r.failed).toEqual([]);
  ids = r.ids;
  c = ids.contact;
  seedCreatorRows(t.app, loc, ids, TAG);
  seedMarketingRows(t.app, loc, ids, TAG);
  seedTelephonyRows(t.app, loc, ids, TAG);
  seedCogneeRows(t.app, loc, ids, TAG);
  seedBooksSyncRows(t.app, loc, ids, TAG);
  // A form tool posts the person to an inbound web hook (every call is kept as a sample for the field mapping).
  const hook = (await t.api.get(`/api/inbound-webhooks/${ids.errworkflow}`)).data;
  await fetch(hook.url.replace(t.app.baseUrl(), t.base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${TAG.toLowerCase()}@example.com`, name: `${TAG} ${TAG}Last` }) });
  // Community: the person and a second member write each other direct messages; the other one blocks and reports.
  const at = new Date().toISOString();
  for (const who of [c, ids.contact2]) t.app.db.insert('community_members', { group_id: ids.group, contact_id: who, location_id: loc, joined_at: at });
  const dm = t.app.services.communityDm;
  const sent = dm.send(loc, c, ids.contact2, `Hallo, hier ${TAG} ${TAG}Last – ruf mich an: 0170 1234567`, { skipLimits: true });
  dm.send(loc, ids.contact2, c, 'Gern, bis morgen!', { skipLimits: true });
  t.app.db.insert('community_blocks', { location_id: loc, blocker_id: c, blocked_id: ids.contact2, created_at: at });
  t.app.db.insert('community_dm_reports', { id: 'zorblaxdmreport', location_id: loc, thread_id: sent.thread.id, message_id: sent.message.id, reporter_id: ids.contact2, reason: 'Spam', created_at: at });
  // Files: a community video, a course hand-in, an attachment on the person's task, the certificate PDF (cached on first download).
  const dir = t.app.config.dataDir;
  const put = (rel: string) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), 'x');
    personFiles.push(join(dir, rel));
  };
  t.app.db.insert('community_videos', { id: 'zorblaxvideo0000000001', location_id: loc, group_id: ids.group, contact_id: c, name: 'ich.mp4', file: 'zorblaxvideofile00001.mp4', size: 1, received: 1, status: 'complete', created_at: at });
  put('community/videos/zorblaxvideofile00001.mp4');
  t.app.db.run(`UPDATE assignment_submissions SET file_path = 'zorblaxabgabe0000001.pdf', file_name = 'abgabe.pdf' WHERE id = 'zorblaxsubmission'`);
  put('assignment-files/zorblaxabgabe0000001.pdf');
  t.app.db.insert('pm_attachments', { id: 'zorblaxattach0000001', location_id: loc, task_id: ids.task, kind: 'file', name: 'vertrag.pdf', file: 'zorblaxattachfile001.pdf', mime: 'application/pdf', size: 1, created_at: at });
  put('pm-files/zorblaxattachfile001.pdf');
  const cert = t.app.db.get<{ id: string }>('SELECT id FROM certificates WHERE contact_id = ?', c)!;
  expect((await fetch(`${t.base}/zertifikat/${cert.id}/pdf`)).status).toBe(200);
  personFiles.push(join(dir, 'certificates', `${cert.id}.pdf`));
  // Office documents of the person (every stored version).
  for (const v of t.app.db.all<{ blob: string }>('SELECT v.blob FROM office_versions v JOIN office_files f ON f.id = v.file_id WHERE f.contact_id = ?', c)) personFiles.push(join(dir, 'office-files', v.blob));
  expect(personFiles.some((f) => f.includes('office-files'))).toBe(true);
  for (const f of personFiles) expect(existsSync(f), f).toBe(true);
  // Contracts: a draft never sent, and one the person signed.
  const draft = await t.api.post('/api/contracts', { kind: 'contract', contact_id: c, title: `Vertrag ${TAG} ${TAG}Last`, content: `Zwischen uns und ${TAG} ${TAG}Last` });
  expect(draft.status, JSON.stringify(draft.data)).toBe(200);
  ids.draftcontract = draft.data.id;
  t.app.db.insert('contracts', { id: 'zorblaxsigned', location_id: loc, kind: 'contract', contact_id: c, title: `Rahmenvertrag ${TAG} ${TAG}Last`, content: 'Text', status: 'signed', public_token: 'zorblaxsignedtoken', signed_at: at, signer_name: `${TAG} ${TAG}Last`, signer_email: `${TAG.toLowerCase()}@example.com`, created_at: at, updated_at: at });
  // Every other table that points at contacts gets one row of the person, written straight into the table – so a new module's
  // table is covered by the checks below without anybody remembering to add it here.
  t.app.db.raw.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const [table, refs] of contactRefs()) if (!refs.some((col) => count(table, `"${col}" = ?`, c))) synthRow(table, refs);
  } finally {
    t.app.db.raw.exec('PRAGMA foreign_keys = ON');
  }
}, 300_000);
afterAll(async () => {
  await t?.app.services.cognee?.idle?.();
  await t?.close();
});

const count = (table: string, where = '1 = 1', ...args: unknown[]) => Number(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`, ...(args as string[]))?.n ?? 0);
const tableNames = () => t.app.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name != '_migrations'`).map((r) => r.name);
/** Every column that points at a contact: a foreign key to contacts, `contact_id`, `…_contact_id`, `contact_a`/`contact_b`. */
function contactRefs(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const name of tableNames()) {
    if (name === 'contacts') continue;
    const cols = t.app.db.all<{ name: string }>(`PRAGMA table_info("${name}")`).map((x) => x.name);
    const fks = t.app.db.all<{ table: string; from: string }>(`PRAGMA foreign_key_list("${name}")`).filter((f) => f.table === 'contacts').map((f) => f.from);
    const refs = [...new Set([...fks, ...cols.filter((x) => x === 'contact_id' || x.endsWith('_contact_id') || x === 'contact_a' || x === 'contact_b')])];
    if (refs.length) out.set(name, refs);
  }
  return out;
}
/** One row of the person in a table: the contact columns point at it, required columns get plain values (names carry the person). */
function synthRow(table: string, refs: string[]) {
  const row: Record<string, unknown> = {};
  for (const col of t.app.db.all<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>(`PRAGMA table_info("${table}")`)) {
    const type = col.type.toUpperCase();
    if (refs.includes(col.name)) row[col.name] = c;
    else if (col.name === 'location_id') row[col.name] = loc;
    else if (col.pk && type === 'INTEGER') continue;
    else if (col.pk || (col.notnull && col.dflt_value === null)) {
      if (/INT|REAL|NUM/.test(type)) row[col.name] = col.pk ? 900001 : 0;
      else if (col.pk) row[col.name] = `syn_${table}_${col.name}`.slice(0, 60);
      else if (/_at$|date$/.test(col.name)) row[col.name] = new Date().toISOString();
      else if (/email/.test(col.name)) row[col.name] = NEEDLES[0];
      else row[col.name] = /name|title|body|text|summary|note/.test(col.name) ? `${TAG} ${TAG}Last` : 'syn';
    }
  }
  t.app.db.insert(table, row);
}
/** What identifies the seeded person: e-mail, full name, last name, phone number. */
const NEEDLES = [`${TAG.toLowerCase()}@example.com`, `${TAG} ${TAG}Last`, `${TAG}Last`, '1701234567'];
/** Tables (all of them, or the ones given) that still mention the person, with a sample row each. */
function mentions(only?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const names = only ?? t.app.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).map((r) => r.name);
  for (const name of names) {
    for (const row of t.app.db.all(`SELECT * FROM "${name}"`)) {
      const j = JSON.stringify(row);
      if (NEEDLES.some((n) => j.toLowerCase().includes(n.toLowerCase()))) {
        out[name] = j.slice(0, 300);
        break;
      }
    }
  }
  return out;
}

describe('DSGVO erasure of a contact used everywhere', () => {
  it('exports the community direct messages and blocks with the rest (Art. 15)', async () => {
    const out = (await t.api.get(`/api/contacts/${c}/privacy-export`)).data;
    const threads = out.data['Community-Direktnachrichten'];
    expect(threads?.length).toBe(2); // with the team (seed) and with the other member
    const withMember = threads.find((x: any) => x.nachrichten.some((m: any) => m.von === 'ich'));
    expect(withMember.nachrichten.map((m: any) => m.text)).toEqual([expect.stringContaining('ruf mich an'), 'Gern, bis morgen!']);
    expect(out.data['Community-Blockierungen']).toHaveLength(1);
  });

  it('the DSGVO-Auskunft covers every table that points at a contact', async () => {
    const keys = Object.keys((await t.api.get(`/api/contacts/${c}/privacy-export`)).data.data);
    const missing = [...contactRefs().keys()].filter((table) => !keys.includes(table) && !keys.some((k) => k.startsWith(`${table} (`)) && !(EXPORT_ALIAS[table] && keys.includes(EXPORT_ALIAS[table])));
    expect(missing).toEqual([]);
  });

  it('erases the contact', async () => {
    // Direct messages are kept by member id (no foreign key): the person's words and the other member's bell entry about them.
    expect(Object.keys(mentions(['community_dm_messages', 'community_notifications']))).toEqual(['community_dm_messages', 'community_notifications']);
    // The audit log and the timeline of the linked company name the person ("Termin … – Zorblax ZorblaxLast", "Kontakt „…“ verknüpft").
    expect(Object.keys(mentions(['audit_log', 'record_activities']))).toEqual(['audit_log', 'record_activities']);
    // Payload samples of REST hooks (Zapier/Make) and of inbound web hooks carry the person's data.
    expect(Object.keys(mentions(['rest_hook_samples', 'inbound_webhook_captures']))).toEqual(['rest_hook_samples', 'inbound_webhook_captures']);
    // What the agency keeps, before: the client's project with its retainer and closed month, the payment plan with its payments, the sent reminder.
    expect(count('pm_projects', 'contact_id = ?', c)).toBeGreaterThan(0);
    expect(count('pm_retainers', 'contact_id = ?', c)).toBeGreaterThan(0);
    expect(count('plan_subscriptions', 'contact_id = ?', c)).toBeGreaterThan(0);
    expect(count('dunning_notices', 'contact_id = ?', c)).toBeGreaterThan(0);
    const r = await t.api.post(`/api/contacts/${c}/erase`, { confirm: c });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    erased = r.data;
    expect(count('contacts', 'id = ?', c)).toBe(0);
  });

  it('keeps business and bookkeeping records (projects, retainers, payment plans, sent reminders) – only the link goes', () => {
    expect(erased.retained).toEqual(expect.arrayContaining(['pm_projects', 'pm_retainers', 'plan_subscriptions', 'dunning_notices']));
    expect(count('pm_projects', `name = ?`, `${TAG} Projekt`)).toBe(1);
    expect(count('pm_retainers', `name = ?`, `${TAG} Retainer`)).toBe(1);
    expect(count('pm_retainer_periods', 'location_id = ?', loc)).toBeGreaterThan(0);
    expect(count('plan_subscriptions', 'id = ?', `${TAG.toLowerCase()}plansub`)).toBe(1);
    expect(count('dunning_notices', 'location_id = ?', loc)).toBeGreaterThan(0);
    for (const table of ['pm_projects', 'pm_retainers', 'plan_subscriptions', 'dunning_notices']) expect(count(table, 'contact_id = ?', c), table).toBe(0);
  });

  it('keeps signed contracts (unlinked) but not drafts that never went out', () => {
    expect(count('contracts', 'id = ?', ids.draftcontract)).toBe(0);
    expect(t.app.db.get('SELECT contact_id, status FROM contracts WHERE id = ?', 'zorblaxsigned')).toEqual({ contact_id: null, status: 'signed' });
  });

  it('leaves no name, e-mail or phone number in the audit log or in the timelines of other records', () => {
    expect(mentions(['audit_log', 'activities', 'record_activities'])).toEqual({});
    // The entries themselves stay – what happened, not who it was about.
    expect(t.app.db.get(`SELECT summary FROM record_activities WHERE object_key = 'company' AND type = 'association.added' AND location_id = ?`, loc)).toEqual({ summary: 'Kontakt „[gelöscht]“ verknüpft' });
    expect(count('audit_log', `action = 'appointments.create' AND summary = '[gelöscht]'`)).toBe(1);
  });

  it('removes the community conversations of the person, and the other side\'s bell entries about them', () => {
    expect(mentions(['community_dm_threads', 'community_dm_messages', 'community_notifications'])).toEqual({});
    expect(count('community_dm_threads', 'contact_a = ? OR contact_b = ?', c, c)).toBe(0);
    expect(count('community_dm_messages', 'sender_id = ?', c)).toBe(0);
    expect(count('community_dm_reports', 'location_id = ?', loc)).toBe(0);
    expect(count('community_blocks', 'blocker_id = ? OR blocked_id = ?', c, c)).toBe(0);
  });

  it('leaves the person only in what the law makes the agency keep', () => {
    expect(Object.keys(mentions()).sort()).toEqual(RETAINED_WITH_DATA);
  });

  it('leaves no row in any table pointing at the erased contact', () => {
    const left: string[] = [];
    for (const [table, refs] of contactRefs()) for (const col of refs) if (count(table, `"${col}" = ?`, c)) left.push(`${table}.${col}`);
    expect(left).toEqual([]);
  });

  it("deletes the person's files on disk: community videos, course hand-ins, task attachments, certificate PDFs, Office documents", () => {
    expect(personFiles.filter((f) => existsSync(f))).toEqual([]);
  });

  it('removes the payload samples and deliveries of web hooks that carry the person', () => {
    expect(mentions(['rest_hook_samples', 'rest_hook_deliveries', 'inbound_webhook_captures'])).toEqual({});
    // Only the event of the erasure itself names the (now meaningless) id.
    expect(count('rest_hook_samples', `instr(payload, ?) > 0 AND instr(payload, '"type":"contact.deleted"') = 0`, c)).toBe(0);
    // Samples of other contacts stay (the hook setup needs one).
    expect(count('rest_hook_samples', 'location_id = ?', loc)).toBeGreaterThan(0);
  });
});
