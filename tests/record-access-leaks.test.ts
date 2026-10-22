import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Route } from '../server/core/http.js';
import { client, diffSnapshots, foreignSnapshot, type Call } from './security-fixtures.js';
import { MARK, OWN, rig, setAccess, type Rig } from './record-access-fixtures.js';
import { id as newId } from '../server/core/util.js';

/**
 * "Own only" leak harness, in the style of the tenant-isolation harness: with record access switched on (every record type: only
 * one's own), Alice tries every route she can reach – with Bob's record ids in every path parameter and in query and body – and
 * no answer may contain Bob's marker, no row of Bob's (or pointing at it) may change. The same for her phone's device token on
 * the app API and for the MCP tools of a key *she* may not even create.
 *
 * Routes that carry no one's records (settings, templates …) cannot leak them, so the harness only needs the data to be seeded:
 * the five record types and what hangs on them (notes, messages, tasks, deals, company links, activities, scores).
 */

let r: Rig;
let phone: Call;
let foreign: { id: string; table: string }[] = [];
const realFetch = globalThis.fetch;

/** Derived data other code recalculates on request (scores): not a change of Bob's records by Alice. */
const DERIVED = [/^POST \/api\/health\/recompute$/, /^POST \/api\/lead-scoring\/(models\/:id|contacts\/:id)\/recalculate$/];
/** Tables the system keeps for itself (the last sample payload of an event for the REST hooks page). */
const SYSTEM_TABLES = ['rest_hook_samples'];
const snapshot = (needles: string[]) => {
  const snap = foreignSnapshot(r.t.app, needles);
  for (const t of SYSTEM_TABLES) snap.delete(t);
  return snap;
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/(ies)$/, 'y')
    .replace(/(es|s)$/, '');

/** Every row that is Bob's: carries the marker, or points at a row that does. */
function bobsRows(): { id: string; table: string }[] {
  const db = r.t.app.db;
  const tables = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).map((x) => x.name);
  const out = new Map<string, string>();
  const cols = new Map(tables.map((t) => [t, db.all<{ name: string }>(`PRAGMA table_info("${t}")`).map((c) => c.name)]));
  for (const [t, cs] of cols) {
    if (!cs.includes('id')) continue;
    for (const row of db.all(`SELECT * FROM "${t}"`)) if (JSON.stringify(row).toUpperCase().includes(MARK)) out.set(String(row.id), t);
  }
  for (const k of Object.values(r.rec)) if (!out.has(k) && /./.test(k)) void 0;
  // the records Bob owns (their texts may not carry the marker, e.g. a task assigned to him)
  for (const [key, table] of [['contact_b', 'contacts'], ['deal_b', 'opportunities'], ['task_b', 'tasks'], ['company_b', 'companies'], ['conversation_b', 'conversations'], ['note_b', 'notes'], ['message_b', 'messages']] as const) out.set(r.rec[key], table);
  for (let pass = 0; pass < 2; pass++) {
    const known = new Set(out.keys());
    for (const [t, cs] of cols) {
      if (!cs.includes('id')) continue;
      const refs = cs.filter((c) => c.endsWith('_id') || c === 'record_id');
      for (const row of db.all(`SELECT * FROM "${t}"`)) if (refs.some((c) => known.has(row[c]))) out.set(String(row.id), t);
    }
  }
  return [...out].map(([id, table]) => ({ id, table }));
}

function candidates(route: Route, i: number): string[] {
  const p = route.parts[i].slice(1);
  const hints = [p.replace(/(Id|_id)$/, ''), route.parts[i - 1] ?? ''];
  const want = hints.map(norm).filter((h) => h.length >= 3 && h !== 'id');
  const matched = foreign.filter((f) => want.some((h) => norm(f.table).includes(h) || h.includes(norm(f.table))));
  if (matched.length) return [...new Set(matched.map((f) => f.id))].slice(0, 12);
  // Unknown parameter: the ids of the five record types, their notes/messages and the planner's default project.
  return [r.rec.contact_b, r.rec.deal_b, r.rec.task_b, r.rec.company_b, r.rec.conversation_b, r.rec.note_b, r.rec.message_b, r.rec.project];
}

function referenceBody(): Record<string, any> {
  const c = r.rec.contact_b;
  return { name: 'harness', title: 'harness', body: 'harness', email: 'harness@example.com', contact_id: c, contactId: c, contact_ids: [c], ids: [c, r.rec.deal_b, r.rec.task_b], deal_id: r.rec.deal_b, opportunity_id: r.rec.deal_b, company_id: r.rec.company_b, task_id: r.rec.task_b, conversation_id: r.rec.conversation_b, from_id: r.rec.company_b, record_id: c, pipeline_id: r.pipeline, assigned_to: r.ids.alice, owner_id: r.ids.alice };
}

async function attack(who: string, call: Call, routes: Route[], opts: { reads?: boolean } = {}) {
  const leaks: string[] = [];
  const needles = foreign.map((f) => f.id).filter((x) => x.length >= 12);
  let snap = snapshot(needles);
  const body = referenceBody();
  const c = body.contact_id as string;
  // Two kinds of questions: naming Bob's contact (the guard answers 404 for any route) and only searching for his texts (the
  // list itself must not return them).
  const named = `?contact_id=${c}&contactId=${c}&company_id=${r.rec.company_b}&deal_id=${r.rec.deal_b}&conversation_id=${r.rec.conversation_b}&q=${MARK}&search=${MARK}`;
  const search = `?q=${MARK}&search=${MARK}&query=${MARK}&limit=200`;
  const { contact_id: _c, contactId: _c2, contact_ids: _c3, ...bodyWithoutContact } = body;
  const verbose = process.env.SECURITY_HARNESS_VERBOSE === '1';
  for (const route of routes) {
    const sig = `${route.method} ${route.pattern}`;
    // The rig's own bookkeeping and routes that end the person's session.
    if (/^POST \/api\/auth\/logout$|^POST \/api\/me\/password$|\/2fa|\/sessions|^POST \/api\/mobile\/logout$|^DELETE \/api\/mobile\/devices/.test(sig)) continue;
    if (route.method === 'GET' && opts.reads === false) continue;
    const slots = route.parts.map((p, i) => (p.startsWith(':') ? candidates(route, i) : null));
    const n = Math.max(1, ...slots.map((s) => s?.length ?? 0));
    for (let v = 0; v < n; v++) {
      const path = '/' + route.parts.map((p, i) => (slots[i] ? encodeURIComponent(slots[i]![v % slots[i]!.length]) : p)).join('/');
      for (const [qs, b] of route.method === 'GET' ? [[named, undefined], [search, undefined]] : [['', body], ['', bodyWithoutContact]]) {
        const res = await call(route.method, path + qs, b);
        if (verbose) console.log(who, route.method, path, res.status);
        const at = res.text.toUpperCase().indexOf(MARK);
        if (at >= 0) leaks.push(`${who} READ ${route.method} ${path}${qs ? ' (query)' : ''} → ${res.status} …${res.text.slice(Math.max(0, at - 70), at + 40)}`);
      }
    }
    if (route.method !== 'GET') {
      const next = snapshot(needles);
      const d = diffSnapshots(snap, next);
      if (d.length && !DERIVED.some((x) => x.test(sig))) leaks.push(`${who} WRITE ${sig}: ${d.slice(0, 3).join(' | ')}`);
      snap = next;
    }
  }
  return leaks;
}

const routes = () => ((r.t.app.router as any).routes as Route[]).filter((x) => x.auth === 'location' || x.auth === 'user');

/** Bob's deal with positions, a sent quote and a meeting note, a sequence he is enrolled in and a consent record: all carry the marker. */
async function seedSales(rig: Rig) {
  const tries: string[] = [];
  const ok = async (what: string, p: ReturnType<Rig['admin']>) => {
    const res = await p;
    if (res.status >= 300) tries.push(`${what}: ${res.status} ${res.text.slice(0, 120)}`);
    return res;
  };
  const deal = rig.rec.deal_b;
  const contact = rig.rec.contact_b;
  await ok('lines', rig.admin('PUT', `/api/opportunities/${deal}/lines`, { lines: [{ name: `${MARK} Position`, qty: 1, price_cents: 100000, tax_rate: 19 }] }));
  const q = await ok('quote', rig.admin('POST', '/api/quotes', { deal_id: deal, title: `${MARK} Angebot`, intro: `${MARK} Einleitung` }));
  if (q.data?.id) await ok('quote send', rig.admin('POST', `/api/quotes/${q.data.id}/send`, { deliver: false }));
  await ok('meeting note', rig.admin('POST', '/api/meeting-notes', { contact_id: contact, deal_id: deal, title: `${MARK} Gespräch`, summary: `${MARK} Zusammenfassung` }));
  // a sequence is a template of the whole account (like a workflow); what hangs on Bob is his enrolment, so the marker rides on the contact
  const seq = await ok('sequence', rig.admin('POST', '/api/sequences', { name: 'Nachfass-Serie', mode: 'marketing', steps: [{ type: 'email', delay_days: 0, subject: 'Betreff', body: 'Text' }] }));
  if (seq.data?.id) {
    await ok('sequence on', rig.admin('PATCH', `/api/sequences/${seq.data.id}`, { status: 'active' }));
    // enrolling over the API needs a connected mailbox; the row is what matters here
    const at = new Date().toISOString();
    const enr = newId();
    rig.t.app.db.insert('sequence_enrollments', { id: enr, location_id: rig.loc, sequence_id: seq.data.id, contact_id: contact, user_id: rig.ids.bob, status: 'active', note: `${MARK} Notiz`, next_at: at, enrolled_at: at, updated_at: at });
    rig.t.app.db.insert('sequence_events', { id: newId(), location_id: rig.loc, sequence_id: seq.data.id, enrollment_id: enr, contact_id: contact, user_id: rig.ids.bob, kind: 'sent', detail: `${MARK} Betreff`, at });
  }
  await ok('consent', rig.admin('POST', `/api/contacts/${contact}/consent`, { action: 'granted', channel: 'email', purpose: 'newsletter', note: `${MARK} Nachweis` }));
  if (process.env.SECURITY_HARNESS_VERBOSE === '1') console.log('seedSales skipped:', tries);
}

/**
 * What hangs on Bob's contact in the conversation area beyond messages: his call log (with a voicemail text), the analysis of a call,
 * a note taken during it, a dialer entry, an AI phone session, a draft and a message with a media file, a quote and a segment
 * member – each carries the marker, so a route that hands them to Alice shows up.
 */
function seedHanging(rig: Rig) {
  const { db } = rig.t.app;
  const at = new Date().toISOString();
  const c = rig.rec.contact_b;
  const call = newId();
  db.insert('calls', { id: call, location_id: rig.loc, contact_id: c, direction: 'in', from_number: '+4915100000001', to_number: '+4930123456', status: 'voicemail', transcription: `${MARK} Rückruf`, sid: `CA${'b'.repeat(32)}`, started_at: at, updated_at: at });
  db.insert('call_notes', { id: newId(), location_id: rig.loc, call_id: call, contact_id: c, user_id: rig.ids.bob, body: `${MARK} Notiz im Gespräch`, created_at: at });
  db.insert('call_intel', { id: newId(), location_id: rig.loc, source: 'call', call_id: call, contact_id: c, title: `${MARK} Gespräch`, status: 'done', transcript: `${MARK} Wir kündigen`, summary: `${MARK} Kündigung`, created_at: at });
  db.insert('voice_ai_sessions', { id: newId(), location_id: rig.loc, call_id: call, call_sid: `CA${'b'.repeat(32)}`, contact_id: c, transcript: JSON.stringify([{ role: 'caller', text: `${MARK} Hallo` }]), summary: `${MARK} Zusammenfassung`, started_at: at, last_at: at });
  const list = newId();
  db.insert('dialer_lists', { id: list, location_id: rig.loc, name: 'Liste', source: 'tags', tags: JSON.stringify(['vertrieb']), created_at: at, updated_at: at });
  db.insert('dialer_items', { id: newId(), location_id: rig.loc, list_id: list, contact_id: c, status: 'pending', position: 1, created_at: at, updated_at: at });
  // a draft in Bob's conversation and a Telegram-style message with a media file
  const draft = rig.rec.message_b;
  const m2 = newId();
  db.run(`INSERT INTO messages (id, location_id, contact_id, conversation_id, channel, direction, subject, body, status, created_at) SELECT ?, location_id, contact_id, conversation_id, channel, direction, ?, ?, 'draft', ? FROM messages WHERE id = ?`, m2, `${MARK} Entwurf`, `${MARK} Entwurfstext`, at, draft);
  const m3 = newId();
  db.run(`INSERT INTO messages (id, location_id, contact_id, conversation_id, channel, direction, subject, body, status, created_at) SELECT ?, location_id, contact_id, conversation_id, channel, direction, '', ?, 'received', ? FROM messages WHERE id = ?`, m3, `${MARK} Bild`, at, draft);
  db.run(`UPDATE messages SET channel_media = ?, meta_media = ? WHERE id = ?`, JSON.stringify({ url: 'https://example.com/x.png' }), JSON.stringify({ url: 'https://example.com/x.png' }), m3);
}

beforeAll(async () => {
  // No outbound network from the app: only our own server answers.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`offline in tests: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  r = await rig();
  // More of Bob's data on the things that hang on a contact: lead scores, an appointment, a form submission, an invoice.
  const c = r.rec.contact_b;
  const scoring = await r.admin('POST', '/api/lead-scoring/models', { name: 'Modell', active: true, is_primary: true, rules: [{ kind: 'event', event: 'message.inbound', points: 5 }], thresholds: [{ label: 'MQL', min: 1 }] });
  expect(scoring.status, JSON.stringify(scoring.data)).toBe(200);
  seedHanging(r);
  await seedSales(r);
  expect((await setAccess(r, { enabled: true, rules: { default: { levels: OWN } } })).status).toBe(200);
  const tok = (await r.alice('POST', '/api/mobile/pair', { device_name: 'Alice phone' })).data.token;
  phone = client(r.t.base, { authorization: `Bearer ${tok}`, 'x-location-id': r.loc });
  foreign = bobsRows();
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await r?.t.close();
});

describe('record access – leak harness (own only)', () => {
  it('has Bob’s records to protect', () => {
    expect(foreign.length).toBeGreaterThan(8);
    expect(routes().length).toBeGreaterThan(500);
  });

  it('Alice (browser session) never reads or changes Bob’s records, whatever route she tries', { timeout: 600_000 }, async () => {
    const leaks = await attack('alice', r.alice, routes());
    expect(leaks).toEqual([]);
  });

  it('control: the same harness does find Bob’s records when the rules are off', async () => {
    await setAccess(r, { enabled: false });
    const some = routes().filter((x) => ['GET /api/contacts', 'GET /api/opportunities', 'GET /api/conversations', 'GET /api/tasks', 'GET /api/companies', 'GET /api/search'].includes(`${x.method} ${x.pattern}`));
    const leaks = await attack('control', r.alice, some);
    expect(leaks.length).toBeGreaterThanOrEqual(5);
    await setAccess(r, { enabled: true });
  });

  it('the same holds at team level (Alice and Carol share a team, Bob is outside)', { timeout: 600_000 }, async () => {
    const team = await r.admin('POST', '/api/sales/teams', { name: 'Nord', members: [{ user_id: r.ids.alice, role: 'lead' }, { user_id: r.ids.carol }] });
    expect(team.status).toBe(200);
    const TEAM = Object.fromEntries(Object.keys(OWN).map((e) => [e, 'team']));
    expect((await setAccess(r, { enabled: true, rules: { default: { levels: TEAM } } })).status).toBe(200);
    expect((await r.alice('GET', '/api/contacts?limit=100')).data.contacts.map((c: any) => c.first_name).sort()).toEqual(['AlphaKontakt', 'CharlieKontakt', 'Niemand']);
    const leaks = await attack('alice-team', r.alice, routes());
    expect(leaks).toEqual([]);
    await setAccess(r, { enabled: true, rules: { default: { levels: OWN } } });
    await r.admin('DELETE', `/api/sales/teams/${team.data.id}`);
  });

  it('and with the pool hidden', { timeout: 600_000 }, async () => {
    expect((await setAccess(r, { enabled: true, unassigned: 'hide' })).status).toBe(200);
    expect((await r.alice('GET', '/api/contacts?limit=100')).data.contacts.map((c: any) => c.first_name)).toEqual(['AlphaKontakt']);
    const leaks = await attack('alice-nopool', r.alice, routes());
    expect(leaks).toEqual([]);
    await setAccess(r, { unassigned: 'show' });
  });

  it('Alice’s phone never reads or changes Bob’s records through the app API', { timeout: 600_000 }, async () => {
    const leaks = await attack('phone', phone, routes().filter((x) => x.pattern.startsWith('/api/mobile/')));
    expect(leaks).toEqual([]);
  });
});
