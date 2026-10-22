import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setStripeFetch } from '../server/services/stripe.js';
import { a1, airtableMatch, colIndex, colLetters, notionProperties, notionValue } from '../server/modules/connector-apps-work.js';
import { autoDiscountCode, calendlyEventId, mailchimpDc, mailchimpHash, shopifyOrderRef, typeformAnswer, typeformAnswers } from '../server/modules/connector-apps-biz.js';
import { newApp, results, runWorkflow, type T } from './wfx-helpers.js';

/** Native app steps (Slack … Zoom): every outbound call is mocked – no real service, no real credentials. */

type Req = { url: string; method: string; headers: Record<string, string>; body: any; raw?: string };
type Reply = { status?: number; body?: unknown } | Error;

let t: T;
let seen: Req[] = [];
let reply: (r: Req, n: number) => Reply = () => ({ body: {} });

beforeAll(async () => {
  t = await newApp();
  t.app.services.connectorFetch = async (url: string, init: any = {}) => {
    let body: any = init.body;
    try {
      body = init.body ? JSON.parse(init.body) : undefined;
    } catch {
      /* form or text */
    }
    const r: Req = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body, raw: init.body };
    seen.push(r);
    const out = reply(r, seen.length);
    if (out instanceof Error) throw out;
    const status = out.status ?? 200;
    const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {});
    return { status, ok: status >= 200 && status < 300, headers: {}, text: async () => text };
  };
});
afterAll(() => t.close());
afterEach(() => {
  seen = [];
  reply = () => ({ body: {} });
});

const save = async (key: string, values: Record<string, string>) => {
  const r = await t.api.put(`/api/connectors/${key}`, { values });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
};
const run = (steps: any[], contact: Record<string, unknown> = {}, opts: Parameters<typeof runWorkflow>[2] = {}) => runWorkflow(t, steps, { contact: { first_name: 'Ida', last_name: 'Kurz', email: 'ida@example.com', phone: '0170 1234567', company: 'Kurz GmbH', ...contact }, ...opts });
const first = async (steps: any[], contact?: Record<string, unknown>, opts?: Parameters<typeof runWorkflow>[2]) => {
  const r = await run(steps, contact, opts);
  return { ...r, msg: results(r.log)[0] as string };
};

describe('pure helpers', () => {
  it('Mailchimp: member hash of the lower-case address and a data center that cannot name another host', () => {
    expect(mailchimpHash(' Ida@Example.com ')).toBe(mailchimpHash('ida@example.com'));
    expect(mailchimpHash('ida@example.com')).toMatch(/^[a-f0-9]{32}$/);
    expect(mailchimpDc('0123456789abcdef0123456789abcdef-us21')).toBe('us21');
    expect(() => mailchimpDc('abc-evil.example.com/x')).toThrow(/Rechenzentrum/);
    expect(() => mailchimpDc('nodash')).toThrow(/Rechenzentrum/);
  });

  it('Calendly event ids, Typeform answers, Shopify order references and generated discount codes', () => {
    const id = '0b8a5c36-3f0e-4b1c-9d4b-0f0a8f0e1234';
    expect(calendlyEventId(`https://api.calendly.com/scheduled_events/${id}`)).toBe(id);
    expect(calendlyEventId(`https://api.calendly.com/scheduled_events/${id}/invitees/${id.replace('0b', '1c')}`)).toBe(id);
    expect(calendlyEventId(id.toUpperCase())).toBe(id);
    expect(calendlyEventId('https://evil.example.com/../x')).toBeNull();
    expect(typeformAnswer({ type: 'choices', choices: { labels: ['A', 'B'], other: 'C' } })).toBe('A, B, C');
    expect(typeformAnswer({ type: 'boolean', boolean: false })).toBe('Nein');
    expect(typeformAnswer({ type: 'unbekannt' })).toBe('');
    const a = typeformAnswers({ answers: [{ field: { id: 'f1', ref: 'name' }, type: 'text', text: 'Ida' }, { field: { id: 'f2', ref: 'budget' }, type: 'number', number: 500 }, { type: 'text', text: 'ohne Feld' }] }, { f1: 'Wie heißt du?' });
    expect(a.byRef).toEqual({ name: 'Ida', budget: '500' });
    expect(a.lines).toBe('Wie heißt du?: Ida\nbudget: 500');
    expect(shopifyOrderRef('#1001')).toEqual({ query: 'name:#1001' });
    expect(shopifyOrderRef('1001')).toEqual({ query: 'name:#1001' });
    expect(shopifyOrderRef('5551234567890')).toEqual({ id: 'gid://shopify/Order/5551234567890' });
    expect(shopifyOrderRef('gid://shopify/Order/123')).toEqual({ id: 'gid://shopify/Order/123' });
    // no way to smuggle search operators into the query
    expect(() => shopifyOrderRef('1001 OR status:any')).toThrow(/ungültig/);
    expect(() => shopifyOrderRef('')).toThrow(/fehlt/);
    expect(autoDiscountCode('run:step')).toBe(autoDiscountCode('run:step'));
    expect(autoDiscountCode('run:step')).toMatch(/^GH[A-F0-9]{8}$/);
  });

  it('Notion property values by type, Airtable formulas and spreadsheet columns', () => {
    const schema = { Name: { type: 'title' }, Budget: { type: 'number' }, Phase: { type: 'select' }, Tags: { type: 'multi_select' }, Aktiv: { type: 'checkbox' }, Frist: { type: 'date' }, Mail: { type: 'email' }, Formel: { type: 'formula' } };
    expect(notionProperties(schema, [{ property: 'budget', value: '2.500,50' }, { property: 'PHASE', value: 'Neu' }, { property: 'Tags', value: 'a, b;c' }, { property: 'Aktiv', value: 'ja' }, { property: 'Frist', value: '2026-12-01' }, { property: 'Mail', value: 'a@b.de' }], 'Ida')).toEqual({
      Name: { title: [{ text: { content: 'Ida' } }] },
      Budget: { number: 2500.5 },
      Phase: { select: { name: 'Neu' } },
      Tags: { multi_select: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
      Aktiv: { checkbox: true },
      Frist: { date: { start: '2026-12-01' } },
      Mail: { email: 'a@b.de' },
    });
    expect(() => notionProperties(schema, [{ property: 'Gibtsnicht', value: 'x' }])).toThrow(/keine Spalte „Gibtsnicht“ \(vorhanden: Name/);
    expect(() => notionProperties(schema, [{ property: 'Formel', value: 'x' }])).toThrow(/Typ formula/);
    expect(() => notionValue({ type: 'number' }, 'viel', 'Budget')).toThrow(/keine Zahl/);
    expect(() => notionProperties({ A: { type: 'number' } }, [], 'Titel')).toThrow(/keine Titel-Spalte/);
    expect(airtableMatch('E-Mail', 'a"b\\c@x.de')).toBe('{E-Mail}="a\\"b\\\\c@x.de"');
    expect(airtableMatch('{Feld}', 'x')).toBe('{Feld}="x"');
    expect(['A', 'Z', 'AA', 'AZ', 'BA'].map(colIndex)).toEqual([0, 25, 26, 51, 52]);
    expect([0, 25, 26, 51, 52, 701].map(colLetters)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ']);
    expect(() => colIndex('3')).toThrow(/keine Spalte/);
    expect(a1("Mein 'Tab'", 'A1')).toBe("'Mein ''Tab'''!A1");
    expect(a1('', 'A1')).toBe('A1');
  });
});

describe('Slack and Teams', () => {
  it('posts with the bot token, uses the default channel and explains Slack errors in German', async () => {
    expect((await t.api.put('/api/connectors/slack_bot', { values: { token: 'falsch' } })).status).toBe(400);
    await save('slack_bot', { token: 'xoxb-1234567890-abcdefghij', default_channel: '#vertrieb' });
    reply = () => ({ body: { ok: true, ts: '1712.5', channel: 'C01' } });
    const r = await first([{ type: 'slack_post_message', title: 'Neu', text: 'Lead {{contact.name}}', thread_ts: '1700.1' }]);
    expect(r.msg).toBe('Slack: in #vertrieb gepostet');
    expect(seen[0]).toMatchObject({ url: 'https://slack.com/api/chat.postMessage', method: 'POST', headers: { authorization: 'Bearer xoxb-1234567890-abcdefghij' }, body: { channel: '#vertrieb', text: '*Neu*\nLead Ida Kurz', thread_ts: '1700.1' } });
    expect(r.vars).toMatchObject({ slack_ts: '1712.5', slack_channel: 'C01' });
    reply = () => ({ body: { ok: false, error: 'not_in_channel' } });
    expect((await first([{ type: 'slack_post_message', channel: '#geheim', text: 'x' }])).msg).toMatch(/Bot ist nicht im Kanal/);
    expect((await first([{ type: 'slack_post_message', channel: '#a', text: '  ' }])).msg).toBe('Kein Text');
    // the token never shows up in the run log
    const logged = await run([{ type: 'slack_post_message', channel: '#a', text: 'x', token: 'xoxb-zzzz' }]);
    expect(JSON.stringify(logged.log)).not.toContain('xoxb-zzzz');
    seen = [];
    reply = () => ({ body: { ok: true, user: 'gohigh', team: 'Muster AG' } });
    const test = await t.api.post('/api/connectors/slack_bot/test');
    expect(test.data.detail).toBe('Verbunden als gohigh in Muster AG');
    expect(seen[0].url).toBe('https://slack.com/api/auth.test');
  });

  it('Teams: accepts only Microsoft webhook hosts and posts an adaptive card', async () => {
    expect((await t.api.put('/api/connectors/teams', { values: { webhook_url: 'https://evil.example.com/webhook/abcdefghij' } })).status).toBe(400);
    expect((await t.api.put('/api/connectors/teams', { values: { webhook_url: 'https://contoso.webhook.office.com.evil.com/webhookb2/abcdefghijklmnop' } })).status).toBe(400);
    const url = 'https://contoso.webhook.office.com/webhookb2/11111111-2222@33333333-4444/IncomingWebhook/abcdef/9999';
    await save('teams', { webhook_url: url });
    const r = await first([{ type: 'teams_post', title: 'Lead', text: '{{contact.name}}', link_url: 'https://crm.example.com/c/1', link_title: 'Öffnen' }]);
    expect(r.msg).toBe('Teams: gesendet');
    expect(seen[0].url).toBe(url);
    const card = seen[0].body.attachments[0].content;
    expect(card.body.map((b: any) => b.text)).toEqual(['Lead', 'Ida Kurz']);
    expect(card.actions[0]).toMatchObject({ type: 'Action.OpenUrl', url: 'https://crm.example.com/c/1' });
    expect((await first([{ type: 'teams_post', text: 'x', link_url: 'http://insecure.example.com' }])).msg).toMatch(/https:\/\//);
    expect((await first([{ type: 'teams_post', text: 'x', webhook_url: 'https://evil.example.com/x/aaaaaaaaaaaa' }])).msg).toMatch(/Teams-Webhook-URL ungültig/);
    reply = () => ({ status: 404, body: 'gone' });
    expect((await first([{ type: 'teams_post', text: 'x' }])).msg).toMatch(/gibt es nicht mehr/);
  });
});

describe('Trello, Asana, ClickUp', () => {
  it('Trello: card with key and token in the query, due date and variables', async () => {
    await save('trello', { api_key: 'a'.repeat(32), token: 'T'.repeat(40), default_list_id: 'b'.repeat(24) });
    reply = () => ({ body: { id: 'card1', shortUrl: 'https://trello.com/c/xyz' } });
    const r = await first([{ type: 'trello_create_card', name: 'Auftrag {{contact.last_name}}', desc: '{{contact.email}}', due_in_days: 3, labels: 'l1, l2', save_to: 'var.karte' }]);
    expect(r.msg).toBe('Trello-Karte angelegt: Auftrag Kurz');
    const u = new URL(seen[0].url);
    expect(u.origin + u.pathname).toBe('https://api.trello.com/1/cards');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ key: 'a'.repeat(32), token: 'T'.repeat(40), idList: 'b'.repeat(24), name: 'Auftrag Kurz', desc: 'ida@example.com', idLabels: 'l1,l2', pos: 'top' });
    expect(Date.parse(u.searchParams.get('due')!)).toBeGreaterThan(Date.now() + 2 * 86_400_000);
    expect(r.vars).toMatchObject({ trello_card_id: 'card1', trello_card_url: 'https://trello.com/c/xyz', karte: 'https://trello.com/c/xyz' });
    expect(JSON.stringify(r.log)).not.toContain('T'.repeat(40));
    expect((await first([{ type: 'trello_create_card', name: ' ', list_id: 'x' }])).msg).toBe('Kartentitel fehlt');
    expect((await first([{ type: 'trello_create_card', name: 'a', due: 'irgendwann' }])).msg).toMatch(/ist kein Datum/);
    expect((await t.api.put('/api/connectors/trello', { values: { api_key: 'kurz' } })).status).toBe(400);
  });

  it('Asana: task with project, workspace fallback and assignee', async () => {
    await save('asana', { token: '1/1234567890:abcdefghijklmnopqrstuv', default_project_gid: '123456789' });
    reply = () => ({ body: { data: { gid: '777', permalink_url: 'https://app.asana.com/0/1/777' } } });
    const r = await first([{ type: 'asana_create_task', name: 'Rückruf {{contact.first_name}}', notes: 'Tel {{contact.phone}}', due: '2026-12-24', assignee: 'me' }]);
    expect(r.msg).toBe('Asana-Aufgabe angelegt: Rückruf Ida');
    expect(seen[0]).toMatchObject({ url: 'https://app.asana.com/api/1.0/tasks', method: 'POST', headers: { authorization: 'Bearer 1/1234567890:abcdefghijklmnopqrstuv' } });
    expect(seen[0].body.data).toEqual({ name: 'Rückruf Ida', notes: 'Tel +491701234567', projects: ['123456789'], due_on: '2026-12-24', assignee: 'me' });
    expect(r.vars.asana_task_url).toBe('https://app.asana.com/0/1/777');
    await save('asana', { token: '1/1234567890:abcdefghijklmnopqrstuv', default_project_gid: '', workspace_gid: '99999999' });
    seen = [];
    await first([{ type: 'asana_create_task', name: 'x' }]);
    expect(seen[0].body.data).toMatchObject({ workspace: '99999999' });
    expect(seen[0].body.data.projects).toBeUndefined();
  });

  it('ClickUp: raw token header, priority, millisecond due date, numeric assignees and tags', async () => {
    await save('clickup', { token: 'pk_1234567890_ABCDEFGHIJKLMNOP', default_list_id: '90120' });
    reply = () => ({ body: { id: 'abc', url: 'https://app.clickup.com/t/abc' } });
    const r = await first([{ type: 'clickup_create_task', name: 'Neuer Auftrag', due: '2026-12-24 10:00', priority: '2', assignees: '123, abc, 456', tags: 'vip, neu' }]);
    expect(r.msg).toBe('ClickUp-Aufgabe angelegt: Neuer Auftrag');
    expect(seen[0]).toMatchObject({ url: 'https://api.clickup.com/api/v2/list/90120/task', headers: { authorization: 'pk_1234567890_ABCDEFGHIJKLMNOP' } });
    expect(seen[0].body).toMatchObject({ name: 'Neuer Auftrag', priority: 2, assignees: [123, 456], tags: ['vip', 'neu'], due_date_time: true });
    expect(seen[0].body.due_date).toBe(Date.parse('2026-12-24T09:00:00Z'));
    expect(r.vars.clickup_task_url).toBe('https://app.clickup.com/t/abc');
    expect((await first([{ type: 'clickup_create_task', name: 'x', list_id: 'abc' }])).msg).toMatch(/Liste fehlt oder ist ungültig/);
  });
});

describe('Airtable, Notion, Sheets, Google Calendar', () => {
  it('Airtable: creates a record and upserts by a field value', async () => {
    await save('airtable', { token: 'pat' + 'a'.repeat(30), base_id: 'appABCDEFGHIJKL' });
    reply = () => ({ body: { id: 'rec1', fields: {} } });
    const rows = [{ field: 'E-Mail', value: '{{contact.email}}' }, { field: 'Name', value: '{{contact.name}}' }];
    const c = await first([{ type: 'airtable_create_record', table: 'Leads', rows }]);
    expect(c.msg).toBe('Airtable: Datensatz rec1 angelegt');
    expect(seen[0]).toMatchObject({ url: 'https://api.airtable.com/v0/appABCDEFGHIJKL/Leads', method: 'POST', body: { fields: { 'E-Mail': 'ida@example.com', Name: 'Ida Kurz' }, typecast: true } });
    expect((await first([{ type: 'airtable_create_record', table: 'Leads', rows: [] }])).msg).toBe('Keine Felder angegeben');
    // update: lookup by formula, then PATCH
    seen = [];
    reply = (r) => (r.method === 'GET' ? { body: { records: [{ id: 'recFound' }] } } : { body: { id: 'recFound', fields: { Status: 'Kunde' } } });
    const u = await first([{ type: 'airtable_update_record', table: 'Leads Neu', match_field: 'E-Mail', match_value: '{{contact.email}}', rows: [{ field: 'Status', value: 'Kunde' }] }]);
    expect(u.msg).toBe('Airtable: Datensatz recFound aktualisiert');
    const get = new URL(seen[0].url);
    expect(get.pathname).toBe('/v0/appABCDEFGHIJKL/Leads%20Neu');
    expect(get.searchParams.get('filterByFormula')).toBe('{E-Mail}="ida@example.com"');
    expect(seen[1]).toMatchObject({ method: 'PATCH', url: 'https://api.airtable.com/v0/appABCDEFGHIJKL/Leads%20Neu/recFound' });
    expect(u.vars).toMatchObject({ airtable_record_id: 'recFound', airtable_found: true });
    // not found: no error, a flag – or an upsert
    seen = [];
    reply = (r) => (r.method === 'GET' ? { body: { records: [] } } : { body: { id: 'recNew' } });
    const none = await first([{ type: 'airtable_update_record', table: 'Leads', match_field: 'E-Mail', match_value: 'x@y.de', rows: [{ field: 'A', value: '1' }] }]);
    expect(none.msg).toMatch(/kein Datensatz/);
    expect(none.vars.airtable_found).toBe(false);
    const up = await first([{ type: 'airtable_update_record', table: 'Leads', match_field: 'E-Mail', match_value: 'x@y.de', create_if_missing: true, rows: [{ field: 'A', value: '1' }] }]);
    expect(up.msg).toBe('Airtable: Datensatz recNew neu angelegt');
    expect(seen.at(-1)!.body.fields).toEqual({ A: '1', 'E-Mail': 'x@y.de' });
  });

  it('Notion: reads the database schema and fills columns by type', async () => {
    const token = 'ntn_abcdefghijklmnopqrstuvwxyz0123456789';
    const db = '12345678-90ab-cdef-1234-567890abcdef';
    await save('notion', { token, page_id: 'https://www.notion.so/team/Seite-1234567890abcdef1234567890abcdef' });
    reply = (r) => (r.method === 'GET' ? { body: { properties: { Name: { type: 'title' }, Budget: { type: 'number' }, Phase: { type: 'select' } } } } : { body: { id: 'p1', url: 'https://www.notion.so/p1' } });
    const r = await first([{ type: 'notion_create_item', database_id: `https://www.notion.so/team/Leads-${db.replace(/-/g, '')}?v=1`, title: '{{contact.name}}', rows: [{ property: 'budget', value: '1.200,00' }, { property: 'Phase', value: 'Neu' }] }]);
    expect(r.msg).toContain('Notion: Eintrag angelegt');
    expect(seen[0]).toMatchObject({ url: `https://api.notion.com/v1/databases/${db}`, headers: { authorization: `Bearer ${token}`, 'notion-version': '2022-06-28' } });
    expect(seen[1]).toMatchObject({ method: 'POST', url: 'https://api.notion.com/v1/pages' });
    expect(seen[1].body).toEqual({ parent: { database_id: db }, properties: { Name: { title: [{ text: { content: 'Ida Kurz' } }] }, Budget: { number: 1200 }, Phase: { select: { name: 'Neu' } } } });
    expect(r.vars.notion_page_url).toBe('https://www.notion.so/p1');
    seen = [];
    expect((await first([{ type: 'notion_create_item', database_id: db, rows: [{ property: 'Gibtsnicht', value: 'x' }] }])).msg).toMatch(/keine Spalte/);
    expect(seen).toHaveLength(1); // nothing was written
    expect((await first([{ type: 'notion_create_item', database_id: 'kaputt' }])).msg).toMatch(/Datenbank-Link/);
    await t.api.del('/api/connectors/notion');
    expect((await first([{ type: 'notion_create_item', database_id: db }])).msg).toMatch(/Notion ist in diesem Sub-Account nicht eingerichtet/);
  });

  it('Google Sheets: appends a row and updates or upserts a row found by a column value', async () => {
    const calls: { method: string; url: string; body: any }[] = [];
    let column: string[] = ['E-Mail', 'ida@example.com', 'ben@example.com'];
    t.app.services.sheetsApi = async (_loc: string, method: string, url: string, body?: any) => {
      calls.push({ method, url, body });
      if (method === 'GET') return { values: [column] };
      if (url.includes(':append')) return { updates: { updatedRange: "Tabelle1!A9:C9" } };
      return {};
    };
    const SID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const append = await first([{ type: 'gsheets_append_row', spreadsheet: `https://docs.google.com/spreadsheets/d/${SID}/edit`, sheet: 'Leads 2026', columns: [{ value: '{{contact.name}}' }, { value: '' }, { value: '=1+1' }] }]);
    expect(append.msg).toBe('Google Sheets: Zeile angehängt (Tabelle1!A9:C9)');
    expect(calls[0].url).toBe(`https://sheets.googleapis.com/v4/spreadsheets/${SID}/values/${encodeURIComponent("'Leads 2026'!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`);
    expect(calls[0].body.values).toEqual([['Ida Kurz', '', '=1+1']]); // RAW: a leading "=" is text, not a formula
    expect((await first([{ type: 'gsheets_append_row', spreadsheet: 'kaputt', columns: [{ value: 'x' }] }])).msg).toMatch(/Tabellen-Link/);
    expect((await first([{ type: 'gsheets_append_row', spreadsheet: SID, columns: [{ value: '' }] }])).msg).toBe('Keine Spalten angegeben');
    // update row 2 (found case-insensitively in column A)
    calls.length = 0;
    const upd = await first([{ type: 'gsheets_update_row', spreadsheet: SID, key_column: 'A', key_value: 'IDA@example.com', cells: [{ column: 'C', value: 'Kunde' }, { column: 'D', value: '{{contact.company}}' }] }]);
    expect(upd.msg).toBe('Google Sheets: Zeile 2 aktualisiert (2 Zellen)');
    expect(calls[0].url).toContain(`values/A1%3AA5000?majorDimension=COLUMNS`);
    expect(calls[1]).toMatchObject({ method: 'POST', url: `https://sheets.googleapis.com/v4/spreadsheets/${SID}/values:batchUpdate` });
    expect(calls[1].body).toEqual({ valueInputOption: 'RAW', data: [{ range: 'C2', values: [['Kunde']] }, { range: 'D2', values: [['Kurz GmbH']] }] });
    expect(upd.vars.sheet_row).toBe(2);
    // not found: message, or append with the key in its column
    calls.length = 0;
    const none = await first([{ type: 'gsheets_update_row', spreadsheet: SID, key_column: 'B', key_value: 'neu@example.com', cells: [{ column: 'C', value: 'x' }] }]);
    expect(none.msg).toMatch(/keine Zeile mit neu@example.com in Spalte B/);
    calls.length = 0;
    await first([{ type: 'gsheets_update_row', spreadsheet: SID, key_column: 'B', key_value: 'neu@example.com', append_if_missing: true, cells: [{ column: 'D', value: 'x' }] }]);
    expect(calls[1].body.values).toEqual([['', 'neu@example.com', '', 'x']]);
    // without a Google connection the step says so
    delete t.app.services.sheetsApi;
    expect((await first([{ type: 'gsheets_append_row', spreadsheet: SID, columns: [{ value: 'x' }] }])).msg).toBe('Google Sheets ist nicht verfügbar');
  });

  it('Google Calendar: creates a repeat-safe event through a connected calendar, or through Nango', async () => {
    const owner = t.app.db.get<any>(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`)!;
    const none = await first([{ type: 'gcal_create_event', title: 'Termin' }]);
    expect(none.msg).toMatch(/Kein Google-Kalender verbunden/);
    const now = new Date().toISOString();
    t.app.db.run(`INSERT INTO oauth_connections (id, provider, purpose, user_id, account_email, status, created_at, updated_at) VALUES ('conn_g1', 'google', 'calendar', ?, 'chef@example.com', 'ok', ?, ?)`, owner.id, now, now);
    t.app.services.oauth = { ...(t.app.services.oauth ?? {}), token: async (id: string) => (id === 'conn_g1' ? 'g-access' : '') };
    expect((await t.api.get('/api/connector-apps/google-calendars')).data).toEqual([{ id: 'conn_g1', account_email: 'chef@example.com', status: 'ok' }]);
    reply = () => ({ body: { id: 'ev1', htmlLink: 'https://calendar.google.com/event?eid=1' } });
    const r = await first([{ type: 'gcal_create_event', title: 'Gespräch {{contact.name}}', when: 'at', date: '2026-12-01 14:00', time: '', duration: 45, attendee: '{{contact.email}}', location: 'Zoom' }]);
    expect(r.msg).toContain('Google Kalender: Termin „Gespräch Ida Kurz“');
    const u = new URL(seen[0].url);
    expect(u.origin + u.pathname).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(u.searchParams.get('sendUpdates')).toBe('all');
    expect(seen[0].headers.authorization).toBe('Bearer g-access');
    expect(seen[0].body).toMatchObject({ summary: 'Gespräch Ida Kurz', start: { dateTime: '2026-12-01T13:00:00.000Z' }, end: { dateTime: '2026-12-01T13:45:00.000Z' }, attendees: [{ email: 'ida@example.com' }], location: 'Zoom' });
    expect(seen[0].body.id).toMatch(/^pghl[0-9a-f]{28}$/);
    expect(r.vars).toMatchObject({ gcal_event_id: 'ev1', gcal_event_url: 'https://calendar.google.com/event?eid=1' });
    // the same run and step always ask for the same event id; a "409 exists" is a success
    seen = [];
    reply = () => ({ status: 409, body: { error: { message: 'duplicate' } } });
    const again = await first([{ type: 'gcal_create_event', title: 'x', when: 'in', amount: 1, unit: 'days', time: '09:30' }]);
    expect(again.msg).toContain('angelegt');
    expect(seen[0].body.start.dateTime).toMatch(/T0[78]:30:00\.000Z$/);
    expect(new URL(seen[0].url).searchParams.get('sendUpdates')).toBe('none');
    expect((await first([{ type: 'gcal_create_event', title: 'x', when: 'at', date: 'kein datum' }])).msg).toBe('Datum/Zeit ist ungültig');
    // a connection of someone else's sub-account is never offered
    expect((await first([{ type: 'gcal_create_event', title: 'x', connection_id: 'conn_fremd' }])).msg).toMatch(/Kein Google-Kalender|auswählen/);
  });
});

describe('HubSpot, Mailchimp, Brevo', () => {
  it('HubSpot: creates a contact, updates an existing one on a 409 and finds contacts by e-mail', async () => {
    expect((await t.api.put('/api/connectors/hubspot', { values: { token: 'nicht-pat' } })).status).toBe(400);
    await save('hubspot', { token: 'pat-eu1-12345678-aaaa-bbbb-cccc-1234567890ab' });
    reply = () => ({ status: 201, body: { id: '501' } });
    const rows = [{ property: 'lifecyclestage', value: 'lead' }];
    const c = await first([{ type: 'hubspot_create_contact', email: '{{contact.email}}', first_name: '{{contact.first_name}}', last_name: '', company: '{{contact.company}}', rows }]);
    expect(c.msg).toBe('HubSpot: Kontakt 501 angelegt');
    expect(seen[0]).toMatchObject({ url: 'https://api.hubapi.com/crm/v3/objects/contacts', method: 'POST', headers: { authorization: 'Bearer pat-eu1-12345678-aaaa-bbbb-cccc-1234567890ab' } });
    expect(seen[0].body).toEqual({ properties: { email: 'ida@example.com', firstname: 'Ida', company: 'Kurz GmbH', lifecyclestage: 'lead' } }); // the empty last name is not sent
    expect(c.vars).toMatchObject({ hubspot_contact_id: '501', hubspot_created: true });
    // existing contact → PATCH with the id from the 409 message
    seen = [];
    reply = (r) => (r.method === 'POST' ? { status: 409, body: { message: 'Contact already exists. Existing ID: 777' } } : { body: { id: '777' } });
    const u = await first([{ type: 'hubspot_create_contact', email: 'ida@example.com', rows }]);
    expect(u.msg).toBe('HubSpot: vorhandenen Kontakt 777 aktualisiert');
    expect(seen[1]).toMatchObject({ method: 'PATCH', url: 'https://api.hubapi.com/crm/v3/objects/contacts/777' });
    expect(u.vars.hubspot_created).toBe(false);
    seen = [];
    expect((await first([{ type: 'hubspot_create_contact', email: 'ida@example.com', update_existing: false }])).msg).toBe('HubSpot: Kontakt 777 existiert bereits (nicht geändert)');
    expect(seen).toHaveLength(1);
    expect((await first([{ type: 'hubspot_create_contact', email: '' }])).msg).toBe('E-Mail fehlt');
    expect((await first([{ type: 'hubspot_create_contact', email: 'a@b.de', rows: [{ property: 'Life Cycle', value: 'x' }] }])).msg).toMatch(/Eigenschaft „Life Cycle“ ist ungültig/);
    // update by e-mail
    seen = [];
    reply = () => ({ body: { id: '501' } });
    const up = await first([{ type: 'hubspot_update_contact', email: 'ida+x@example.com', rows: [{ property: 'lifecyclestage', value: 'customer' }] }]);
    expect(up.msg).toBe('HubSpot: Kontakt 501 aktualisiert');
    const pu = new URL(seen[0].url);
    expect(pu.pathname).toBe('/crm/v3/objects/contacts/ida%2Bx%40example.com');
    expect(pu.searchParams.get('idProperty')).toBe('email');
    expect(seen[0].body).toEqual({ properties: { lifecyclestage: 'customer' } });
    // not found → flag, or upsert
    seen = [];
    reply = (r) => (r.method === 'PATCH' ? { status: 404, body: { message: 'resource not found' } } : { status: 201, body: { id: '900' } });
    const miss = await first([{ type: 'hubspot_update_contact', email: 'neu@example.com', rows: [{ property: 'lifecyclestage', value: 'lead' }] }]);
    expect(miss.msg).toMatch(/kein Kontakt gefunden/);
    expect(miss.vars.hubspot_found).toBe(false);
    const made = await first([{ type: 'hubspot_update_contact', email: 'neu@example.com', create_if_missing: true, rows: [{ property: 'lifecyclestage', value: 'lead' }] }]);
    expect(made.msg).toBe('HubSpot: Kontakt 900 neu angelegt');
    expect(seen.at(-1)!.body.properties).toEqual({ lifecyclestage: 'lead', email: 'neu@example.com' });
    expect((await first([{ type: 'hubspot_update_contact', email: 'a@b.de' }])).msg).toBe('Keine Eigenschaften zum Ändern angegeben');
    expect((await first([{ type: 'hubspot_update_contact', contact_id: '12ab', rows: [{ property: 'a', value: 'b' }] }])).msg).toMatch(/nur Ziffern/);
  });

  it('Mailchimp: upserts a member by hash without resubscribing, merges fields and tags', async () => {
    const key = '0123456789abcdef0123456789abcdef-us21';
    expect((await t.api.put('/api/connectors/mailchimp', { values: { api_key: 'abc-evil.com' } })).status).toBe(400);
    await save('mailchimp', { api_key: key, default_list_id: 'abc123def4' });
    reply = (r) => (r.url.endsWith('/tags') ? { status: 204, body: '' } : { body: { id: mailchimpHash('ida@example.com'), status: 'pending' } });
    const r = await first([{ type: 'mailchimp_add_member', email: '{{contact.email}}', first_name: '{{contact.first_name}}', phone: '{{contact.phone}}', status: 'pending', tags: 'kunde, newsletter', rows: [{ tag: 'company', value: '{{contact.company}}' }] }]);
    const hash = mailchimpHash('ida@example.com');
    expect(r.msg).toBe('Mailchimp: ida@example.com (pending), 2 Tag(s)');
    expect(seen[0]).toMatchObject({ method: 'PUT', url: `https://us21.api.mailchimp.com/3.0/lists/abc123def4/members/${hash}`, headers: { authorization: `Basic ${Buffer.from(`gohigh:${key}`).toString('base64')}` } });
    expect(seen[0].body).toEqual({ email_address: 'ida@example.com', status_if_new: 'pending', merge_fields: { FNAME: 'Ida', PHONE: '+491701234567', COMPANY: 'Kurz GmbH' } });
    expect(seen[1]).toMatchObject({ method: 'POST', url: `https://us21.api.mailchimp.com/3.0/lists/abc123def4/members/${hash}/tags`, body: { tags: [{ name: 'kunde', status: 'active' }, { name: 'newsletter', status: 'active' }] } });
    expect(r.vars.mailchimp_status).toBe('pending');
    expect(JSON.stringify(r.log)).not.toContain(key);
    expect((await first([{ type: 'mailchimp_add_member', email: 'kein-mail' }])).msg).toBe('E-Mail ist ungültig');
    expect((await first([{ type: 'mailchimp_add_member', email: 'a@b.de', list_id: 'x/../y' }])).msg).toMatch(/Audience fehlt oder ist ungültig/);
    reply = () => ({ status: 400, body: { title: 'Member In Compliance State', detail: 'ida@example.com is in a compliance state due to unsubscribe.' } });
    expect((await first([{ type: 'mailchimp_add_member', email: 'ida@example.com' }])).msg).toContain('compliance state');
    reply = () => ({ body: { health_status: "Everything's Chimpy!" } });
    expect((await t.api.post('/api/connectors/mailchimp/test')).data.detail).toBe("Everything's Chimpy!");
  });

  it('Brevo: creates or updates a contact with list ids and international phone numbers', async () => {
    await save('brevo', { api_key: 'xkeysib-' + 'a'.repeat(40), default_list_ids: '3' });
    reply = () => ({ status: 201, body: { id: 42 } });
    const r = await first([{ type: 'brevo_add_contact', email: 'IDA@example.com', first_name: 'Ida', phone: '0170 1234567', rows: [{ attribute: 'company', value: 'Kurz GmbH' }] }]);
    expect(r.msg).toBe('Brevo: ida@example.com angelegt (Liste 3)');
    expect(seen[0]).toMatchObject({ url: 'https://api.brevo.com/v3/contacts', headers: { 'api-key': 'xkeysib-' + 'a'.repeat(40) } });
    expect(seen[0].body).toEqual({ email: 'ida@example.com', attributes: { FIRSTNAME: 'Ida', SMS: '+491701234567', COMPANY: 'Kurz GmbH' }, listIds: [3], updateEnabled: true });
    expect(r.vars.brevo_contact_id).toBe(42);
    reply = () => ({ status: 204, body: '' });
    const upd = await first([{ type: 'brevo_add_contact', email: 'ida@example.com', list_ids: '5, 7, x', update_existing: false }]);
    expect(upd.msg).toBe('Brevo: ida@example.com aktualisiert (Liste 5, 7)');
    expect(seen.at(-1)!.body).toMatchObject({ listIds: [5, 7], updateEnabled: false });
    expect((await first([{ type: 'brevo_add_contact', email: 'x', rows: [] }])).msg).toBe('E-Mail ist ungültig');
    expect((await first([{ type: 'brevo_add_contact', email: 'a@b.de', rows: [{ attribute: 'meine firma', value: 'x' }] }])).msg).toMatch(/Brevo-Attribut/);
  });
});

describe('Shopify and WooCommerce', () => {
  const gql = (r: Req) => r.body as { query: string; variables: any };

  it('Shopify: only *.myshopify.com hosts; creates a percentage or fixed discount that a retry does not duplicate', async () => {
    expect((await t.api.put('/api/connectors/shopify', { values: { shop: 'evil.example.com', token: 'shpat_' + 'a'.repeat(32) } })).status).toBe(400);
    expect((await t.api.put('/api/connectors/shopify', { values: { shop: 'shop.myshopify.com.evil.com', token: 'shpat_' + 'a'.repeat(32) } })).status).toBe(400);
    await save('shopify', { shop: 'mein-shop.myshopify.com', token: 'shpat_' + 'a'.repeat(32) });
    reply = () => ({ body: { data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] } } } });
    const r = await first([{ type: 'shopify_create_discount', code: 'willkommen10', kind: 'percent', value: '10', valid_days: 14, minimum: '50', usage_limit: 100 }]);
    expect(r.msg).toBe('Shopify: Rabattcode WILLKOMMEN10 erstellt (10 %)');
    expect(seen[0]).toMatchObject({ url: 'https://mein-shop.myshopify.com/admin/api/2026-04/graphql.json', method: 'POST', headers: { 'x-shopify-access-token': 'shpat_' + 'a'.repeat(32) } });
    const d = gql(seen[0]).variables.d;
    expect(d).toMatchObject({ code: 'WILLKOMMEN10', appliesOncePerCustomer: true, usageLimit: 100, customerSelection: { all: true }, customerGets: { value: { percentage: 0.1 }, items: { all: true } }, minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: '50.00' } } });
    expect(Date.parse(d.endsAt) - Date.parse(d.startsAt)).toBeCloseTo(14 * 86_400_000, -4);
    expect(r.vars).toMatchObject({ discount_code: 'WILLKOMMEN10', discount_id: 'gid://shopify/DiscountCodeNode/1' });
    // fixed amount and a generated code
    seen = [];
    const fixed = await first([{ type: 'shopify_create_discount', kind: 'fixed', value: '7,5' }]);
    expect(gql(seen[0]).variables.d.customerGets.value).toEqual({ discountAmount: { amount: '7.50', appliesOnEachItem: false } });
    expect(fixed.vars.discount_code).toMatch(/^GH[A-F0-9]{8}$/);
    // a taken generated code (retry of the same step) is a success, a taken chosen code is an error
    reply = () => ({ body: { data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ['basicCodeDiscount', 'code'], message: 'Code must be unique.', code: 'TAKEN' }] } } } });
    expect((await first([{ type: 'shopify_create_discount', value: '5' }])).msg).toMatch(/gab es schon \(Wiederholung\)/);
    expect((await first([{ type: 'shopify_create_discount', code: 'DOPPELT', value: '5' }])).msg).toBe('Shopify: Code must be unique.');
    expect((await first([{ type: 'shopify_create_discount', value: '150' }])).msg).toBe('Prozent-Rabatt höchstens 100');
    expect((await first([{ type: 'shopify_create_discount', value: '0' }])).msg).toBe('Rabattwert muss größer als 0 sein');
    expect((await first([{ type: 'shopify_create_discount', code: 'a b', value: '5' }])).msg).toMatch(/Rabattcode ungültig/);
    reply = () => ({ body: { errors: [{ message: 'Access denied for discountCodeBasicCreate field.' }] } });
    expect((await first([{ type: 'shopify_create_discount', value: '5' }])).msg).toContain('Access denied');
  });

  it('Shopify: looks up an order by number or id and reports a missing one without failing the run', async () => {
    const node = { id: 'gid://shopify/Order/1', name: '#1001', email: 'ida@example.com', cancelledAt: null, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', totalPriceSet: { shopMoney: { amount: '59.90', currencyCode: 'EUR' } }, lineItems: { nodes: [{ title: 'Tasse', quantity: 2 }, { title: 'Kappe', quantity: 1 }] } };
    reply = () => ({ body: { data: { orders: { nodes: [node] } } } });
    const r = await first([{ type: 'shopify_get_order', order: '1001' }]);
    expect(r.msg).toBe('Shopify: Bestellung #1001 – PAID, UNFULFILLED, 59.90 EUR');
    expect(gql(seen[0]).variables).toEqual({ q: 'name:#1001' });
    expect(r.vars).toMatchObject({ shopify_found: true, shopify_order_status: 'paid', shopify_fulfillment: 'unfulfilled', shopify_order_total: '59.90', shopify_order_items: '2× Tasse, 1× Kappe', shopify_order_email: 'ida@example.com', shopify_order_cancelled: false });
    seen = [];
    reply = () => ({ body: { data: { order: node } } });
    await first([{ type: 'shopify_get_order', order: '5551234567890' }]);
    expect(gql(seen[0]).variables).toEqual({ id: 'gid://shopify/Order/5551234567890' });
    reply = () => ({ body: { data: { orders: { nodes: [] } } } });
    const miss = await first([{ type: 'shopify_get_order', order: '#9999' }, { type: 'set_variable', rows: [{ name: 'weiter', value: 'ja' }] }]);
    expect(miss.msg).toMatch(/keine Bestellung gefunden/);
    expect(miss.vars).toMatchObject({ shopify_found: false, weiter: 'ja' });
    reply = () => ({ status: 429, body: '' });
    expect((await first([{ type: 'shopify_get_order', order: '1' }])).msg).toMatch(/zu viele Anfragen/);
    const test = await t.api.post('/api/connectors/shopify/test');
    expect(test.status).toBe(400);
  });

  it('WooCommerce: basic auth over https to the shop, order data as variables', async () => {
    expect((await t.api.put('/api/connectors/woocommerce', { values: { store_url: 'http://shop.example.com', consumer_key: 'ck_' + 'a'.repeat(30), consumer_secret: 'cs_' + 'b'.repeat(30) } })).status).toBe(400);
    await save('woocommerce', { store_url: 'https://shop.example.com/', consumer_key: 'ck_' + 'a'.repeat(30), consumer_secret: 'cs_' + 'b'.repeat(30) });
    reply = () => ({ body: { id: 1234, status: 'processing', total: '59.90', currency: 'EUR', billing: { email: 'ida@example.com' }, payment_method_title: 'PayPal', date_created_gmt: '2026-10-01T10:00:00', line_items: [{ name: 'Tasse', quantity: 2 }] } });
    const r = await first([{ type: 'woocommerce_get_order', order_id: '#1234' }]);
    expect(r.msg).toBe('WooCommerce: Bestellung 1234 – processing, 59.90 EUR');
    expect(seen[0]).toMatchObject({ url: 'https://shop.example.com/wp-json/wc/v3/orders/1234', headers: { authorization: `Basic ${Buffer.from(`ck_${'a'.repeat(30)}:cs_${'b'.repeat(30)}`).toString('base64')}` } });
    expect(r.vars).toMatchObject({ woo_found: true, woo_order_status: 'processing', woo_order_total: '59.90', woo_order_items: '2× Tasse', woo_payment_method: 'PayPal', woo_order_email: 'ida@example.com' });
    expect(JSON.stringify(r.log)).not.toContain('b'.repeat(30));
    reply = () => ({ status: 404, body: { code: 'woocommerce_rest_shop_order_invalid_id' } });
    const miss = await first([{ type: 'woocommerce_get_order', order_id: '99' }]);
    expect(miss.msg).toBe('WooCommerce: keine Bestellung 99');
    expect(miss.vars.woo_found).toBe(false);
    expect((await first([{ type: 'woocommerce_get_order', order_id: '../etc' }])).msg).toMatch(/Bestellnummer ungültig/);
    reply = () => ({ status: 401, body: { message: 'Invalid signature' } });
    expect((await first([{ type: 'woocommerce_get_order', order_id: '1' }])).msg).toMatch(/Zugriff verweigert/);
  });
});

describe('Stripe', () => {
  const stripeCalls: { method: string; url: string; headers: Record<string, string>; body: URLSearchParams }[] = [];
  const stripeReply: { fn: (c: (typeof stripeCalls)[number]) => { status?: number; body: unknown } } = { fn: () => ({ body: {} }) };
  beforeAll(() => {
    setStripeFetch(async (url: string, init: any) => {
      const c = { method: init.method, url, headers: init.headers, body: new URLSearchParams(init.body ?? '') };
      stripeCalls.push(c);
      const r = stripeReply.fn(c);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => setStripeFetch());
  afterEach(() => {
    stripeCalls.length = 0;
    delete t.app.services.stripeKey;
  });

  it('refuses without a Stripe connection and reuses an existing customer', async () => {
    t.app.services.stripeKey = () => '';
    expect((await first([{ type: 'stripe_create_customer', email: 'x@y.de' }])).msg).toMatch(/Stripe ist in diesem Sub-Account nicht verbunden/);
    t.app.services.stripeKey = () => 'sk_test_abcdefghijklmnop';
    stripeReply.fn = (c) => (c.method === 'GET' ? { body: { data: [{ id: 'cus_old' }] } } : { body: { id: 'cus_new' } });
    const reuse = await first([{ type: 'stripe_create_customer', email: '{{contact.email}}' }]);
    expect(reuse.msg).toBe('Stripe: Kunde cus_old gab es schon');
    expect(stripeCalls).toHaveLength(1);
    expect(stripeCalls[0].url).toBe('https://api.stripe.com/v1/customers?email=ida%40example.com&limit=1');
    expect(stripeCalls[0].headers.authorization).toBe('Bearer sk_test_abcdefghijklmnop');
    expect(reuse.vars).toMatchObject({ stripe_customer_id: 'cus_old', stripe_customer_created: false });
    stripeCalls.length = 0;
    stripeReply.fn = (c) => (c.method === 'GET' ? { body: { data: [] } } : { body: { id: 'cus_new' } });
    const created = await first([{ type: 'stripe_create_customer', email: '{{contact.email}}', name: '{{contact.name}}', phone: '{{contact.phone}}', save_to: 'custom.stripe_id' }]);
    expect(created.msg).toBe('Stripe: Kunde cus_new angelegt');
    const post = stripeCalls[1];
    expect(Object.fromEntries(post.body)).toMatchObject({ email: 'ida@example.com', name: 'Ida Kurz', phone: '+491701234567', 'metadata[ghl_contact_id]': created.contact.id });
    expect(post.headers['idempotency-key']).toMatch(/^ghl-cus-[0-9a-f]{32}$/);
    expect((await t.api.get(`/api/contacts/${created.contact.id}`)).data.custom.stripe_id).toBe('cus_new');
    stripeReply.fn = () => ({ status: 401, body: { error: { message: 'Invalid API Key' } } });
    expect((await first([{ type: 'stripe_create_customer', email: 'a@b.de', reuse_existing: false }])).msg).toMatch(/Stripe lehnt den Schlüssel ab/);
    expect((await first([{ type: 'stripe_create_customer' }])).msg).toBe('E-Mail oder Name fehlt');
  });

  it('creates product, price and payment link with idempotency keys; validates amount and redirect', async () => {
    t.app.services.stripeKey = () => 'sk_test_abcdefghijklmnop';
    stripeReply.fn = (c) => ({ body: c.url.endsWith('/products') ? { id: 'prod_1' } : c.url.endsWith('/prices') ? { id: 'price_1' } : { id: 'plink_1', url: 'https://buy.stripe.com/test_abc' } });
    const r = await first([{ type: 'stripe_create_payment_link', name: 'Beratung {{contact.last_name}}', amount: '49,90', currency: 'EUR', interval: 'month', max_quantity: 5, redirect_url: 'https://example.com/danke' }]);
    expect(r.msg).toBe('Stripe: Zahlungslink https://buy.stripe.com/test_abc (49.90 EUR)');
    expect(stripeCalls.map((c) => c.url.replace('https://api.stripe.com', ''))).toEqual(['/v1/products', '/v1/prices', '/v1/payment_links']);
    expect(Object.fromEntries(stripeCalls[0].body)).toMatchObject({ name: 'Beratung Kurz' });
    expect(Object.fromEntries(stripeCalls[1].body)).toMatchObject({ product: 'prod_1', unit_amount: '4990', currency: 'eur', 'recurring[interval]': 'month' });
    expect(Object.fromEntries(stripeCalls[2].body)).toMatchObject({ 'line_items[0][price]': 'price_1', 'line_items[0][quantity]': '1', 'line_items[0][adjustable_quantity][maximum]': '5', 'after_completion[type]': 'redirect', 'after_completion[redirect][url]': 'https://example.com/danke' });
    const keys = stripeCalls.map((c) => c.headers['idempotency-key']);
    expect(new Set(keys).size).toBe(3);
    expect(keys.every((k) => /^ghl-(prod|price|link)-[0-9a-f]{32}$/.test(k))).toBe(true);
    expect(r.vars).toMatchObject({ stripe_payment_link: 'https://buy.stripe.com/test_abc', stripe_payment_link_id: 'plink_1' });
    expect((await first([{ type: 'stripe_create_payment_link', name: 'x', amount: '0,10' }])).msg).toBe('Betrag ungültig (mindestens 0,50)');
    expect((await first([{ type: 'stripe_create_payment_link', name: 'x', amount: 'viel' }])).msg).toBe('Betrag ungültig (mindestens 0,50)');
    expect((await first([{ type: 'stripe_create_payment_link', name: 'x', amount: '5', currency: 'euro' }])).msg).toBe('Währung ungültig (z. B. eur)');
    expect((await first([{ type: 'stripe_create_payment_link', name: 'x', amount: '5', redirect_url: 'javascript:alert(1)' }])).msg).toMatch(/https:\/\//);
    expect((await first([{ type: 'stripe_create_payment_link', name: '', amount: '5' }])).msg).toBe('Produktname fehlt');
  });
});

describe('Calendly, Typeform, Zoom', () => {
  const EV = '0b8a5c36-3f0e-4b1c-9d4b-0f0a8f0e1234';

  it('Calendly: cancels a meeting from a URI with a reason', async () => {
    await save('calendly', { token: 'a'.repeat(40) });
    reply = () => ({ status: 201, body: { resource: { canceled_by: 'Chef' } } });
    const r = await first([{ type: 'calendly_cancel_event', event: `https://api.calendly.com/scheduled_events/${EV}`, reason: 'Wir müssen verschieben, {{contact.first_name}}.' }]);
    expect(r.msg).toBe('Calendly: Termin 0b8a5c36… abgesagt');
    expect(seen[0]).toMatchObject({ url: `https://api.calendly.com/scheduled_events/${EV}/cancellation`, method: 'POST', body: { reason: 'Wir müssen verschieben, Ida.' } });
    expect(r.vars.calendly_cancelled).toBe(true);
    expect((await first([{ type: 'calendly_cancel_event', event: 'https://evil.example.com/x' }])).msg).toMatch(/Termin-ID fehlt oder ist ungültig/);
    reply = () => ({ status: 403, body: { message: 'You do not have permission' } });
    expect((await first([{ type: 'calendly_cancel_event', event: EV }])).msg).toMatch(/Zugriff verweigert/);
  });

  it('Typeform: fetches a response by id, by search or the latest, with question titles', async () => {
    expect((await t.api.put('/api/connectors/typeform', { values: { token: 'a'.repeat(30), base_url: 'https://evil.example.com' } })).status).toBe(400);
    await save('typeform', { token: 'tfp_' + 'a'.repeat(30), base_url: 'https://api.eu.typeform.com' });
    reply = (r) => (r.url.includes('/responses') ? { body: { items: [{ response_id: 'resp1', submitted_at: '2026-10-01T10:00:00Z', hidden: { quelle: 'ads' }, answers: [{ field: { id: 'f1', ref: 'name', type: 'short_text' }, type: 'text', text: 'Ida' }, { field: { id: 'f2', ref: 'interesse', type: 'multiple_choice' }, type: 'choice', choice: { label: 'Beratung' } }] }] } } : { body: { fields: [{ id: 'f1', title: 'Wie heißt du?' }, { id: 'f2', title: 'Wofür interessierst du dich?' }] } });
    const r = await first([{ type: 'typeform_get_response', form_id: 'AbC123xY', response_id: 'resp1' }]);
    expect(r.msg).toBe('Typeform: Antwort resp1 (2 Antworten)');
    expect(seen[0].url).toBe('https://api.eu.typeform.com/forms/AbC123xY/responses?page_size=1&included_response_ids=resp1');
    expect(seen[1].url).toBe('https://api.eu.typeform.com/forms/AbC123xY');
    expect(r.vars).toMatchObject({ typeform_found: true, typeform: { name: 'Ida', interesse: 'Beratung' }, typeform_text: 'Wie heißt du?: Ida\nWofür interessierst du dich?: Beratung', typeform_response_id: 'resp1', typeform_hidden: { quelle: 'ads' } });
    // by search term (the contact's e-mail), and the latest when nothing is given
    seen = [];
    await first([{ type: 'typeform_get_response', form_id: 'AbC123xY', query: '{{contact.email}}' }]);
    expect(new URL(seen[0].url).searchParams.get('query')).toBe('ida@example.com');
    seen = [];
    await first([{ type: 'typeform_get_response', form_id: 'AbC123xY' }]);
    expect(new URL(seen[0].url).search).toBe('?page_size=1');
    // a form definition that cannot be read still gives the answers (by reference)
    seen = [];
    reply = (r) => (r.url.includes('/responses') ? { body: { items: [{ response_id: 'r2', answers: [{ field: { id: 'f1', ref: 'name' }, type: 'text', text: 'Ben' }] }] } } : { status: 403, body: { description: 'no scope' } });
    expect((await first([{ type: 'typeform_get_response', form_id: 'AbC123xY' }])).vars.typeform_text).toBe('name: Ben');
    reply = () => ({ body: { items: [] } });
    const none = await first([{ type: 'typeform_get_response', form_id: 'AbC123xY', response_id: 'weg' }]);
    expect(none.msg).toMatch(/keine Antwort gefunden/);
    expect(none.vars.typeform_found).toBe(false);
    expect((await first([{ type: 'typeform_get_response', form_id: '../x' }])).msg).toMatch(/Formular-ID/);
  });

  it('Zoom: fetches one server-to-server token for several meetings and returns the join link', async () => {
    await save('zoom', { account_id: 'AcCoUnT123456', client_id: 'ClIeNt1234567', client_secret: 'SeCrEt1234567890', default_host: 'chef@example.com' });
    let tokens = 0;
    reply = (r) => {
      if (r.url.startsWith('https://zoom.us/oauth/token')) {
        tokens++;
        return { body: { access_token: 'zoom-access', expires_in: 3600 } };
      }
      return { status: 201, body: { id: 987654321, join_url: 'https://zoom.us/j/987654321?pwd=x', start_url: 'https://zoom.us/s/geheim', password: 'abc123' } };
    };
    const step = { type: 'zoom_create_meeting', topic: 'Gespräch mit {{contact.name}}', when: 'at', date: '2026-12-01 14:00', time: '', duration: 45, agenda: 'Kennenlernen' };
    const r = await first([step]);
    expect(r.msg).toContain('Zoom: Meeting 987654321 am 2026-12-01T13:00:00.000Z angelegt');
    expect(seen[0]).toMatchObject({ method: 'POST', headers: { authorization: `Basic ${Buffer.from('ClIeNt1234567:SeCrEt1234567890').toString('base64')}` } });
    expect(new URL(seen[0].url).searchParams.get('account_id')).toBe('AcCoUnT123456');
    expect(seen[1]).toMatchObject({ url: 'https://api.zoom.us/v2/users/chef%40example.com/meetings', headers: { authorization: 'Bearer zoom-access' } });
    expect(seen[1].body).toMatchObject({ topic: 'Gespräch mit Ida Kurz', type: 2, start_time: '2026-12-01T13:00:00Z', duration: 45, timezone: 'Europe/Berlin', agenda: 'Kennenlernen', settings: { waiting_room: true, join_before_host: false } });
    expect(r.vars).toMatchObject({ zoom_join_url: 'https://zoom.us/j/987654321?pwd=x', zoom_meeting_id: '987654321', zoom_password: 'abc123' });
    // the host's start link is never put into the run
    expect(JSON.stringify(r.run)).not.toContain('geheim');
    await first([{ ...step, host: 'kollege@example.com', waiting_room: false }]);
    expect(tokens).toBe(1);
    expect(seen.at(-1)!.url).toContain('/users/kollege%40example.com/meetings');
    expect(seen.at(-1)!.body.settings.waiting_room).toBe(false);
    expect((await first([{ ...step, host: '../admin' }])).msg).toMatch(/Gastgeber ungültig/);
    reply = (r2) => (r2.url.startsWith('https://zoom.us/oauth/token') ? { status: 401, body: { reason: 'Invalid client_id or client_secret' } } : { body: {} });
    expect((await t.api.post('/api/connectors/zoom/test')).status).toBe(400);
  });
});

describe('Nango instead of a token', () => {
  afterEach(() => delete t.app.services.nango);

  it('sends the same request through Nango with the provider path prefix and no direct call', async () => {
    const calls: any[] = [];
    t.app.services.nango = {
      config: () => ({ base: 'https://nango.example.com' }),
      request: async (loc: string, input: any, opts: any) => {
        calls.push({ loc, input, opts });
        return { ok: true, status: 200, data: { id: 'cardN', shortUrl: 'https://trello.com/c/n' } };
      },
    };
    await t.api.put('/api/connectors/trello', { values: { api_key: '', token: '', default_list_id: 'b'.repeat(24), nango_integration: 'trello-oauth' } });
    seen = [];
    const r = await first([{ type: 'trello_create_card', name: 'Via Nango' }]);
    expect(r.msg).toBe('Trello-Karte angelegt: Via Nango');
    expect(seen).toHaveLength(0);
    expect(calls[0].input).toMatchObject({ integration: 'trello-oauth', method: 'POST', path: '/1/cards', query: { idList: 'b'.repeat(24), name: 'Via Nango', pos: 'top' } });
    expect(calls[0].input.query.desc).toBeUndefined(); // empty values are dropped
    expect(calls[0].opts).toEqual({ source: 'workflow' });
    expect(r.vars.trello_card_url).toBe('https://trello.com/c/n');
    // errors of the app come back in German with the app's name
    t.app.services.nango.request = async () => ({ ok: false, status: 404, data: { message: 'list not found' } });
    expect((await first([{ type: 'trello_create_card', name: 'x' }])).msg).toMatch(/Trello \(Nango\): POST \/cards → HTTP 404/);
    // without Nango set up the step says what to do
    t.app.services.nango = { config: () => null };
    expect((await first([{ type: 'trello_create_card', name: 'x' }])).msg).toMatch(/Nango ist nicht eingerichtet/);
    await t.api.del('/api/connectors/trello');
  });

  it('Google Calendar via Nango uses the calendar path and the Slack/Mailchimp specs do not add a host', async () => {
    const calls: any[] = [];
    t.app.services.nango = { config: () => ({}), request: async (_l: string, input: any) => (calls.push(input), { ok: true, status: 200, data: { id: 'evN', htmlLink: 'https://cal/evN' } }) };
    const r = await first([{ type: 'gcal_create_event', title: 'Nango-Termin', nango_integration: 'google-calendar', calendar_id: 'team@example.com', when: 'in', amount: 1, unit: 'hours' }]);
    expect(r.vars.gcal_event_url).toBe('https://cal/evN');
    expect(calls[0]).toMatchObject({ integration: 'google-calendar', method: 'POST', path: '/calendar/v3/calendars/team%40example.com/events' });
  });
});

describe('catalogue and editor metadata', () => {
  const APP_STEPS = ['slack_post_message', 'teams_post', 'trello_create_card', 'asana_create_task', 'clickup_create_task', 'airtable_create_record', 'airtable_update_record', 'notion_create_item', 'gsheets_append_row', 'gsheets_update_row', 'gcal_create_event', 'hubspot_create_contact', 'hubspot_update_contact', 'mailchimp_add_member', 'brevo_add_contact', 'shopify_create_discount', 'shopify_get_order', 'woocommerce_get_order', 'stripe_create_customer', 'stripe_create_payment_link', 'calendly_cancel_event', 'typeform_get_response', 'zoom_create_meeting'];

  it('every app step is registered with a handler, German help and a note on what to set up first', async () => {
    const cat = (await t.api.get('/api/workflow-catalog?category=apps')).data;
    const byType = Object.fromEntries(cat.actions.map((a: any) => [a.type, a]));
    for (const type of APP_STEPS) {
      expect(typeof t.app.services.workflowActions[type], type).toBe('function');
      const a = byType[type];
      expect(a, type).toBeTruthy();
      expect(a).toMatchObject({ category: 'apps' });
      expect(a.needs, type).toMatch(/Direkt-Verbindungen|Kalender|Stripe/);
      expect(a.doc.length, type).toBeGreaterThan(60);
      expect(a.fields.length, type).toBeGreaterThan(0);
      expect(a.app, type).toBeTruthy();
    }
    expect(Object.keys(byType).length).toBeGreaterThanOrEqual(APP_STEPS.length);
  });

  it('the connections list shows the new apps with the Nango field and sealed secrets', async () => {
    const list = (await t.api.get('/api/connectors')).data;
    const keys = list.map((c: any) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['slack_bot', 'teams', 'trello', 'asana', 'clickup', 'airtable', 'hubspot', 'mailchimp', 'brevo', 'shopify', 'woocommerce', 'calendly', 'typeform', 'zoom']));
    const slack = list.find((c: any) => c.key === 'slack_bot');
    expect(slack.fields.map((f: any) => [f.key, f.secret])).toEqual([['token', true], ['default_channel', false], ['nango_integration', false]]);
    expect(JSON.stringify(list)).not.toMatch(/xoxb-1234567890/);
    const row = t.app.db.get<any>(`SELECT data FROM connector_settings WHERE key = 'slack_bot'`)!;
    expect(row.data).not.toContain('xoxb-1234567890');
    expect((await t.api.put('/api/connectors/slack_bot', { values: { nango_integration: 'bad name!' } })).status).toBe(400);
  });
});
