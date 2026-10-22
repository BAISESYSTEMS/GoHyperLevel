import { afterEach, describe, expect, it } from 'vitest';
import { id } from '../server/core/util.js';
import { toolCatalog } from '../server/services/agent-tools.js';
import { cogneeApp, type CogneeApp } from './cognee-helpers.js';
import { client } from './security-fixtures.js';

let c: CogneeApp;
afterEach(async () => c && (await c.close()));

const rows = (sql: string, ...p: any[]) => c.t.app.db.all<any>(sql, ...p);
const audit = (like = 'cognee.%') => rows(`SELECT action, summary, actor, via FROM audit_log WHERE action LIKE ? ORDER BY at`, like);

async function wikiPage(loc: string, title: string, body: string, spaceId?: string) {
  const at = c.at(loc);
  const space = spaceId ? { id: spaceId } : (await at('POST', '/api/wiki/spaces', { name: `Team ${title}` })).data;
  const page = (await at('POST', '/api/wiki/pages', { space_id: space.id, title, body })).data;
  return { page, space };
}
async function member(perms: string[] | null, loc = c.A) {
  const email = `m-${id(6).toLowerCase()}@example.com`;
  expect((await c.admin('POST', '/api/users', { email, password: 'passwort-m1', name: 'Mitglied', locations: [loc], ...(perms ? { permissions: perms } : {}) })).status).toBe(200);
  const m = client(c.t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await m('POST', '/api/auth/login', { email, password: 'passwort-m1' })).status).toBe(200);
  return m;
}

describe('the connection (agency)', () => {
  it('stores the login sealed and never returns it', async () => {
    c = await cogneeApp();
    expect((await c.admin('GET', '/api/agency/cognee')).data).toMatchObject({ configured: false });
    const r = await c.connect();
    expect(r.data).toMatchObject({ configured: true, base_url: 'http://cognee:8000', auth_mode: 'password', email: 'gohigh@example.com', secret_set: true, hint: '…high', allow_private: true, locations_may_enable: true });
    expect(JSON.stringify(r.data)).not.toContain('pw-gohigh');
    expect(JSON.stringify((await c.admin('GET', '/api/agency/cognee')).data)).not.toContain('pw-gohigh');
    const stored = rows(`SELECT value FROM agency_settings WHERE key = 'cognee'`)[0].value as string;
    expect(stored).toMatch(/"secret_sealed":"v[12]:/);
    expect(stored).not.toContain('pw-gohigh');
    // A blank password keeps the stored one; changing the address does not lose it.
    await c.connect({ password: '', base_url: 'http://cognee:8010/' });
    expect((await c.admin('GET', '/api/agency/cognee')).data.base_url).toBe('http://cognee:8010');
    expect((await c.admin('POST', '/api/agency/cognee/test', {})).status).toBe(200);
  });

  it('checks what it is given', async () => {
    c = await cogneeApp();
    const put = (b: Record<string, unknown>) => c.admin('PUT', '/api/agency/cognee', b);
    expect((await put({ base_url: 'not a url', email: 'a@b.de', password: 'x' })).data.error).toMatch(/Adresse ungültig/);
    expect((await put({ base_url: 'http://cognee.example.com', email: 'a@b.de', password: 'x' })).data.error).toMatch(/https/);
    expect((await put({ base_url: 'https://cognee.example.com', email: 'kaputt', password: 'x' })).data.error).toMatch(/E-Mail/);
    expect((await put({ base_url: 'https://cognee.example.com', email: 'a@b.de' })).data.error).toMatch(/Passwort/);
    expect((await put({ base_url: 'https://cognee.example.com', auth_mode: 'api_key' })).data.error).toMatch(/API-Schlüssel/);
    expect((await put({ base_url: 'https://cognee.example.com', auth_mode: 'api_key', api_key: 'abcd1234' })).status).toBe(200);
    expect((await c.admin('GET', '/api/agency/cognee')).data).toMatchObject({ auth_mode: 'api_key', email: '', hint: '…1234' });
  });

  it('tests health, access control, login and datasets – step by step', async () => {
    c = await cogneeApp();
    await c.connect();
    const ok = (await c.admin('POST', '/api/agency/cognee/test', {})).data;
    expect(ok.ok).toBe(true);
    expect(ok.version).toBe('1.6.2');
    expect(ok.steps.map((s: any) => [s.key, s.ok])).toEqual([['health', true], ['access', true], ['login', true], ['datasets', true]]);
    expect((await c.admin('GET', '/api/agency/cognee')).data.last_test).toMatchObject({ ok: true, version: '1.6.2' });
    expect(audit('cognee.test')[0].summary).toBe('Verbindungstest: ok, 0 HyperLevel-Datasets');

    // Unsaved values can be tested without replacing the saved ones.
    const bad = (await c.admin('POST', '/api/agency/cognee/test', { base_url: 'http://cognee:8000', password: 'falsch', allow_private: true })).data;
    expect(bad.ok).toBe(false);
    expect(bad.steps.find((s: any) => s.key === 'login')).toMatchObject({ ok: false, detail: 'E-Mail oder Passwort bei Cognee stimmen nicht.' });
    expect((await c.admin('POST', '/api/agency/cognee/test', {})).data.ok).toBe(true);

    c.fake.setOffline(true);
    const down = (await c.admin('POST', '/api/agency/cognee/test', {})).data;
    expect(down.ok).toBe(false);
    expect(down.steps).toHaveLength(1);
    expect(down.steps[0].detail).toMatch(/nicht erreichbar/);
  });

  it('works with an API key and can use a login of its own per sub-account', async () => {
    c = await cogneeApp({ fake: { users: { 'own@example.com': 'pw-own' } } });
    await c.connect({ auth_mode: 'api_key', api_key: 'key-gohigh', password: undefined });
    expect((await c.admin('POST', '/api/agency/cognee/test', {})).data.ok).toBe(true);
    expect(c.fake.logins()).toBe(0);
    const put = await c.admin('PUT', `/api/agency/cognee/locations/${c.A}/account`, { auth_mode: 'password', email: 'own@example.com', password: 'pw-own' });
    expect(put.data).toMatchObject({ ok: true, account: 'override', email: 'own@example.com' });
    expect(JSON.stringify(put.data)).not.toContain('pw-own');
    expect(rows('SELECT secret_sealed FROM cognee_accounts')[0].secret_sealed).toMatch(/^v[12]:/);
    expect((await c.admin('POST', `/api/agency/cognee/locations/${c.A}/test`, {})).data.ok).toBe(true);
    await wikiPage(c.A, 'Seite', 'Text für den eigenen Zugang');
    await c.share(c.A);
    expect(c.fake.dataset(`gh_${c.A}_wiki`)!.owner).toBe('own@example.com');
    // The data belongs to that Cognee user: the login cannot be swapped while it is there.
    const swap = await c.admin('PUT', `/api/agency/cognee/locations/${c.A}/account`, { auth_mode: 'api_key', api_key: 'key-gohigh' });
    expect(swap.status).toBe(409);
    expect((await c.admin('DELETE', `/api/agency/cognee/locations/${c.A}/account`)).status).toBe(409);
  });

  it('is for signed-in agency admins only (no member, no key), and removal needs the data gone first', async () => {
    c = await cogneeApp();
    await c.connect();
    const m = await member(['settings']);
    for (const [method, path] of [['GET', '/api/agency/cognee'], ['PUT', '/api/agency/cognee'], ['POST', '/api/agency/cognee/test'], ['GET', '/api/agency/cognee/overview'], ['DELETE', '/api/agency/cognee']] as const) expect((await m(method, path, method === 'GET' ? undefined : {})).status, `${method} ${path}`).toBe(403);
    // An agency key reads, but cannot change the login.
    const key = (await c.admin('POST', '/api/agency/api-keys', { name: 'Agentur' })).data.key as string;
    const ak = client(c.t.base, { authorization: `Bearer ${key}` });
    expect((await ak('GET', '/api/agency/cognee')).status).toBe(200);
    expect(JSON.stringify((await ak('GET', '/api/agency/cognee')).data)).not.toContain('pw-gohigh');
    for (const [method, path] of [['PUT', '/api/agency/cognee'], ['POST', '/api/agency/cognee/test'], ['DELETE', '/api/agency/cognee']] as const) expect((await ak(method, path, {})).status, `key ${method} ${path}`).toBe(403);

    await wikiPage(c.A, 'Seite', 'Text');
    await c.share(c.A);
    const del = await c.admin('DELETE', '/api/agency/cognee');
    expect(del.status).toBe(409);
    expect(del.data.error).toMatch(/Daten in Cognee löschen/);
    expect((await c.admin('GET', '/api/agency/cognee')).data.configured).toBe(true);
    expect((await c.admin('DELETE', '/api/agency/cognee?force=1')).status).toBe(200);
    expect((await c.admin('GET', '/api/agency/cognee')).data.configured).toBe(false);
  });

  it('shows every sub-account at a glance and lets the agency switch one off', async () => {
    c = await cogneeApp();
    await c.connect();
    const B = (await c.admin('POST', '/api/locations', { name: 'Zweite Firma' })).data.id as string;
    await wikiPage(c.A, 'Seite A', 'Text A');
    await c.share(c.A);
    const o = (await c.admin('GET', '/api/agency/cognee/overview')).data;
    expect(o.connection.configured).toBe(true);
    const a = o.locations.find((l: any) => l.id === c.A);
    expect(a).toMatchObject({ enabled: true, types: ['wiki'], items: 1, by_type: { wiki: 1 }, account: 'agency', errors: 0, pending_deletions: 0 });
    expect(a.last_sync_at).toBeTruthy();
    expect(o.locations.find((l: any) => l.id === B)).toMatchObject({ enabled: false, types: [], items: 0 });
    const off = await c.admin('PUT', `/api/agency/cognee/locations/${c.A}/settings`, { enabled: false });
    expect(off.data.offer_delete).toEqual(['wiki']);
    expect((await c.admin('GET', '/api/agency/cognee/overview')).data.locations.find((l: any) => l.id === c.A).enabled).toBe(false);
  });
});

describe('asking the memory', () => {
  it('needs the memory to be on and the server to be set up', async () => {
    c = await cogneeApp();
    expect((await c.at(c.A)('GET', '/api/cognee/recall?q=x')).data.error).toMatch(/nicht eingeschaltet/);
    await c.at(c.A)('PUT', '/api/cognee/admin/settings', { enabled: true });
    expect((await c.at(c.A)('GET', '/api/cognee/recall?q=x')).data.error).toMatch(/noch nicht eingerichtet/);
    expect((await c.at(c.A)('GET', '/api/cognee/info')).data).toMatchObject({ enabled: true, connected: false, can_ask: false });
    await c.connect();
    expect((await c.at(c.A)('GET', '/api/cognee/info')).data).toMatchObject({ enabled: true, connected: true, can_ask: true, can_remember: false, types: [{ key: 'wiki', label: 'Wiki & Dokumente' }] });
    expect((await c.at(c.A)('GET', '/api/cognee/recall')).status).toBe(400); // no question
  });

  it('answers with short passages and their sources – a live title and a link', async () => {
    c = await cogneeApp();
    await c.connect();
    const { page } = await wikiPage(c.A, 'Onboarding-Ablauf', 'Beim Onboarding-Call besprechen wir zuerst die Ziele und dann den Zeitplan.');
    await wikiPage(c.A, 'Preisliste', 'Das Basispaket kostet 49 Euro im Monat.');
    await c.share(c.A);
    const r = (await c.at(c.A)('GET', '/api/cognee/recall?q=Onboarding%20Ziele')).data;
    expect(r.searched).toEqual(['wiki']);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ type: 'wiki', type_label: 'Wiki & Dokumente', title: 'Onboarding-Ablauf', link: `/app/wiki/${page.id}` });
    expect(r.results[0].snippet).toContain('besprechen wir zuerst die Ziele');
    expect(r.results[0].snippet).not.toContain('HyperLevel ·');
    expect(r.mode).toBe('snippets');
    // With an answer: the server's own composition on top of the passages.
    const a = (await c.at(c.A)('GET', '/api/cognee/recall?q=Onboarding&mode=answer')).data;
    expect(a).toMatchObject({ mode: 'answer', answer: `Antwort aus gh_${c.A}_wiki` }); // one dataset: no label
    expect(a.results.length).toBeGreaterThan(0);
    // Counts in the audit log, never the question or the passages.
    const log = audit('cognee.search');
    expect(log.map((l) => l.summary)).toEqual(['Gedächtnis befragt: 1 Treffer in Wiki & Dokumente', 'Gedächtnis befragt: 1 Treffer in Wiki & Dokumente, mit Antwort']);
    expect(JSON.stringify(log)).not.toMatch(/Onboarding|Ziele/);
  });

  it('caps the result for tools at 4 KB – few short passages, however much is stored', async () => {
    c = await cogneeApp();
    await c.connect();
    const { space } = await wikiPage(c.A, 'Lang 0', `Kuchenrezept ${'Mehl Zucker Butter Eier '.repeat(120)}`);
    for (let i = 1; i < 14; i++) await wikiPage(c.A, `Lang ${i}`, `Kuchenrezept Nummer ${i}: ${'Mehl Zucker Butter Eier '.repeat(120)}`, space.id);
    await c.share(c.A);
    const full = (await c.at(c.A)('GET', '/api/cognee/recall?q=Kuchenrezept&limit=20')).data;
    expect(full.results.length).toBeGreaterThan(8);
    expect(full.results[0].snippet.length).toBeGreaterThan(500);
    const compact = (await c.at(c.A)('GET', '/api/cognee/recall?q=Kuchenrezept&compact=1&limit=50')).data;
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(4000);
    expect(compact.results.length).toBeGreaterThan(0);
    expect(compact.results.length).toBeLessThanOrEqual(8);
    expect(compact.truncated).toBe(true);
    for (const h of compact.results) expect(h.snippet.length).toBeLessThanOrEqual(500);
    // Compact asks for no answer composition (a tool must stay cheap).
    expect((await c.at(c.A)('GET', '/api/cognee/recall?q=Kuchenrezept&compact=1&mode=answer')).data.mode).toBe('snippets');
  });

  it('never shows a passage of a record that is gone – even while Cognee still holds it', async () => {
    c = await cogneeApp();
    await c.connect();
    const { page } = await wikiPage(c.A, 'Veraltet', 'Das Rezept für Marzipan steht hier.');
    await wikiPage(c.A, 'Aktuell', 'Das Rezept für Nougat steht hier.');
    await c.share(c.A);
    c.fake.failNext(/DELETE /, 503, { detail: 'down' }, 99);
    await c.at(c.A)('DELETE', `/api/wiki/pages/${page.id}`);
    await c.idle();
    expect(c.fake.items(`gh_${c.A}_wiki`)).toHaveLength(2); // still there, deletion queued
    const r = (await c.at(c.A)('GET', '/api/cognee/recall?q=Rezept')).data;
    expect(JSON.stringify(r)).toContain('Nougat');
    expect(JSON.stringify(r)).not.toContain('Marzipan');
    // And no composed answer while deletions are open.
    const a = (await c.at(c.A)('GET', '/api/cognee/recall?q=Rezept&mode=answer')).data;
    expect(a.answer).toBeUndefined();
    expect(a.note).toMatch(/laufende Löschungen/);
    await c.idle(); // the question queued the deletion and started a background cycle that tries it (and meets the 503)
    const st = (await c.at(c.A)('GET', '/api/cognee/admin/status')).data;
    expect(st.pending_deletions).toBe(1);
    expect(st.warnings.some((w: any) => /Löschung/.test(w.text))).toBe(true);
  });

  it('lets a member ask only about what their areas allow – and only if the sub-account lets members ask', async () => {
    c = await cogneeApp();
    await c.connect();
    await wikiPage(c.A, 'Wissen', 'Kuchen gibt es nur sonntags.');
    const ct = (await c.at(c.A)('POST', '/api/contacts', { first_name: 'Erika', last_name: 'Muster' })).data;
    await c.at(c.A)('POST', `/api/contacts/${ct.id}/notes`, { body: 'Kuchen bestellt, Lieferung montags.' });
    await c.share(c.A, { notes: true });
    const wikiOnly = await member(['wiki']);
    const r = (await wikiOnly('GET', '/api/cognee/recall?q=Kuchen')).data;
    expect(r.searched).toEqual(['wiki']);
    expect(JSON.stringify(r)).not.toContain('Lieferung montags');
    expect((await wikiOnly('GET', '/api/cognee/recall?q=Kuchen&types=notes')).status).toBe(403);
    expect((await wikiOnly('GET', '/api/cognee/info')).data).toMatchObject({ can_ask: true, can_remember: false, types: [{ key: 'wiki' }] });
    const contactsOnly = await member(['contacts']);
    expect((await contactsOnly('GET', '/api/cognee/recall?q=Kuchen')).data.searched).toEqual(['notes']);
    expect((await contactsOnly('GET', '/api/cognee/info')).data.can_remember).toBe(false);
    const none = await member([]);
    expect((await none('GET', '/api/cognee/recall?q=Kuchen')).status).toBe(403);
    // Unrestricted members and the agency see everything shared.
    expect((await (await member(null))('GET', '/api/cognee/recall?q=Kuchen')).data.searched).toEqual(['wiki', 'notes']);
    // The switch for members.
    await c.at(c.A)('PUT', '/api/cognee/admin/settings', { members_ask: false });
    const denied = await wikiOnly('GET', '/api/cognee/recall?q=Kuchen');
    expect(denied.status).toBe(403);
    expect(denied.data.error).toMatch(/Mitglieder/);
    expect((await wikiOnly('GET', '/api/cognee/info')).data.can_ask).toBe(false);
    expect((await c.at(c.A)('GET', '/api/cognee/recall?q=Kuchen')).status).toBe(200);
  });

  it('only a member with the area Einstellungen decides what is shared; the status is theirs too', async () => {
    c = await cogneeApp();
    await c.connect();
    const plain = await member(['wiki', 'contacts']);
    for (const [method, path] of [['GET', '/api/cognee/admin/settings'], ['PUT', '/api/cognee/admin/settings'], ['GET', '/api/cognee/admin/status'], ['POST', '/api/cognee/admin/sync'], ['POST', '/api/cognee/admin/purge']] as const) expect((await plain(method, path, method === 'GET' ? undefined : {})).status, `${method} ${path}`).toBe(403);
    const boss = await member(['settings']);
    expect((await boss('GET', '/api/cognee/admin/settings')).status).toBe(200);
    expect((await boss('PUT', '/api/cognee/admin/settings', { enabled: true, types: { notes: true } })).data.settings).toMatchObject({ enabled: true, types: { wiki: true, notes: true } });
    expect((await boss('GET', '/api/cognee/admin/status')).data.types.find((t: any) => t.key === 'notes')).toMatchObject({ active: true, personal: true });
    expect((await boss('PUT', '/api/cognee/admin/settings', { types: { bogus: true } })).status).toBe(400);
    expect((await boss('PUT', '/api/cognee/admin/settings', { enabled: 'ja' })).status).toBe(400);
  });

  it('a key cannot change what is shared – only a person signed in can', async () => {
    c = await cogneeApp();
    await c.connect();
    const k = (await c.at(c.A)('POST', '/api/api-keys', { name: 'Schlüssel' })).data.key as string;
    const key = client(c.t.base, { authorization: `Bearer ${k}`, 'x-location-id': c.A });
    expect((await key('PUT', '/api/cognee/admin/settings', { enabled: true })).status).toBe(403);
    expect((await key('POST', '/api/cognee/admin/purge', { types: 'all', confirm: true })).status).toBe(403);
    expect((await key('GET', '/api/cognee/admin/status')).status).toBe(200);
  });

  it('brakes a flood of questions', async () => {
    c = await cogneeApp();
    await c.connect();
    await wikiPage(c.A, 'Seite', 'Text zum Fragen');
    await c.share(c.A);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await c.at(c.A)('GET', '/api/cognee/recall?q=Text')).status;
    expect(last).toBe(429);
  });
});

describe('remembering a note', () => {
  it('needs the type to be shared and the right to write; the note can be listed and deleted', async () => {
    c = await cogneeApp();
    await c.connect();
    await c.at(c.A)('PUT', '/api/cognee/admin/settings', { enabled: true });
    expect((await c.at(c.A)('POST', '/api/cognee/remember', { text: 'x' })).data.error).toMatch(/nicht freigegeben/);
    await c.share(c.A, { memory: true });
    expect((await c.at(c.A)('POST', '/api/cognee/remember', { text: '' })).status).toBe(400);
    expect((await c.at(c.A)('POST', '/api/cognee/remember', { text: 'y'.repeat(4001) })).status).toBe(400);
    const reader = await member(['contacts']);
    expect((await reader('POST', '/api/cognee/remember', { text: 'x' })).status).toBe(403);
    expect((await reader('GET', '/api/cognee/memories')).status).toBe(403);
    const writer = await member(['wiki']);
    const r = await writer('POST', '/api/cognee/remember', { text: 'Rechnungen immer an die Buchhaltung.' });
    expect(r.data).toMatchObject({ ok: true, queued: true });
    expect((await writer('GET', '/api/cognee/memories')).data).toMatchObject([{ id: r.data.id, text: 'Rechnungen immer an die Buchhaltung.', created_by_name: 'Mitglied' }]);
    await c.idle();
    await c.sync(c.A);
    expect((await writer('GET', '/api/cognee/memories')).data[0].synced).toBe(true);
    expect((await c.at(c.A)('GET', '/api/cognee/recall?q=Rechnungen')).data.results[0]).toMatchObject({ type: 'memory', title: expect.stringContaining('Gemerkter Hinweis') });
    expect(audit('cognee.remember')[0].summary).toBe('Hinweis zum Merken gespeichert (36 Zeichen)');
    expect(JSON.stringify(audit())).not.toContain('Buchhaltung');
  });
});

describe('the tools of the agent and MCP', () => {
  const rpc = (mcp: ReturnType<typeof client>) => {
    let n = 0;
    return async (method: string, params: any) => (await mcp('POST', '/mcp', { jsonrpc: '2.0', id: ++n, method, params })).data;
  };

  it('offers ghl_memory_recall (read only, compact) and ghl_memory_remember over MCP, scoped to the key\'s sub-account', async () => {
    c = await cogneeApp();
    await c.connect();
    const { page } = await wikiPage(c.A, 'Handbuch', 'Der Notfallplan: erst anrufen, dann schreiben.');
    await c.share(c.A, { memory: true });
    const B = (await c.admin('POST', '/api/locations', { name: 'Fremde Firma' })).data.id as string;
    await wikiPage(B, 'Fremdes Handbuch', 'Der Notfallplan der Fremden');
    await c.share(B);
    const k = (await c.at(c.A)('POST', '/api/api-keys', { name: 'MCP' })).data.key as string;
    const call = rpc(client(c.t.base, { authorization: `Bearer ${k}` }));
    const tools = (await call('tools/list', {})).result.tools as any[];
    const recall = tools.find((t) => t.name === 'ghl_memory_recall');
    expect(recall.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'ghl_memory_remember').annotations.readOnlyHint).toBe(false);
    const out = await call('tools/call', { name: 'ghl_memory_recall', arguments: { location_id: c.A, query: 'Notfallplan' } });
    const text = out.result.content[0].text as string;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4000);
    const r = JSON.parse(text);
    expect(r.results[0]).toMatchObject({ title: 'Handbuch', link: `/app/wiki/${page.id}` });
    expect(text).not.toContain('Fremden');
    // The key reaches only its own sub-account, whatever location_id it names.
    const other = await call('tools/call', { name: 'ghl_memory_recall', arguments: { location_id: B, query: 'Notfallplan' } });
    expect(JSON.stringify(other)).not.toContain('Fremden');
    const rem = await call('tools/call', { name: 'ghl_memory_remember', arguments: { location_id: c.A, text: 'Notfallplan gilt auch am Wochenende.' } });
    expect(JSON.parse(rem.result.content[0].text)).toMatchObject({ ok: true });
    // A read-only agency key cannot remember.
    const ro = (await c.admin('POST', '/api/agency/api-keys', { name: 'lesen', scope: 'read' })).data.key as string;
    const roCall = rpc(client(c.t.base, { authorization: `Bearer ${ro}` }));
    expect(JSON.stringify(await roCall('tools/call', { name: 'ghl_memory_remember', arguments: { location_id: c.A, text: 'nein' } }))).toMatch(/error|nur lesen/i);
    expect(JSON.parse((await roCall('tools/call', { name: 'ghl_memory_recall', arguments: { location_id: c.A, query: 'Notfallplan' } })).result.content[0].text).results.length).toBeGreaterThan(0);
  });

  it('gives the in-app agent both tools – recall as a read tool whose output counts as untrusted', async () => {
    c = await cogneeApp();
    const catalog = toolCatalog(c.t.app, { id: 'u1', email: 'x@example.com', name: 'X', role: 'admin', locations: [], permissions: null }, { webFetch: false });
    const recall = catalog.find((t) => t.name === 'ghl_memory_recall')!;
    const remember = catalog.find((t) => t.name === 'ghl_memory_remember')!;
    expect(recall).toMatchObject({ klass: 'read', untrusted: true, source: 'mcp' });
    expect(remember).toMatchObject({ klass: 'write', untrusted: false });
    expect(recall.inputSchema.properties.limit.maximum).toBe(8);
  });
});
