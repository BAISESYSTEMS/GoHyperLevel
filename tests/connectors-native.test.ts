import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { G_CLIENT, createFake } from './oauth-fakes.js';
import { contactsToRows, discordPayload, headerField, notionBlocks, notionPageId, rowsToContacts, slackPayload, spreadsheetId } from '../server/services/connectors.js';

/** Native connectors (Slack/Discord webhooks, Notion, Google Sheets) with every outbound call mocked. */

type Out = { url: string; method: string; headers: Record<string, string>; body: any };
const SLACK = 'https://hooks.slack.com/services/T0001/B0001/abcdefghijklmnopqrstuvwx';
const DISCORD = 'https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz_ABCDE';
const NOTION_TOKEN = 'ntn_abcdefghijklmnopqrstuvwxyz0123456789';
const PAGE = 'https://www.notion.so/team/Leads-1234567890abcdef1234567890abcdef';

let t: Awaited<ReturnType<typeof startTestApp>>;
let out: Out[] = [];
let reply: (o: Out) => { status: number; body: unknown } = () => ({ status: 200, body: 'ok' });
const oauth = createFake();
const sheet = { values: [] as string[][], read: [] as string[][] };

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.oauthFetch = oauth.fetch;
  // safeFetch-compatible stand-in: records the call and answers like the service would.
  t.app.services.connectorFetch = async (url: string, init: any = {}) => {
    const o: Out = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    out.push(o);
    const r = reply(o);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: {}, text: async () => text };
  };
  await t.setup();
});
afterAll(() => t.close());
beforeEach(() => {
  out = [];
  reply = () => ({ status: 200, body: 'ok' });
});

async function runWorkflow(steps: any[], contact: Record<string, unknown>) {
  const c = (await t.api.post('/api/contacts', contact)).data;
  const wf = (await t.api.post('/api/workflows', { name: `wf ${Math.random()}`, trigger: { type: 'manual', config: {} }, steps })).data;
  await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
  await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [c.id] });
  return { contact: c, log: (await t.api.get(`/api/workflows/${wf.id}/runs`)).data.runs[0].log as any[] };
}

describe('connector helpers (pure)', () => {
  it('builds Slack, Discord and Notion payloads', () => {
    expect(slackPayload('Hallo', 'Neuer Lead')).toEqual({ text: '*Neuer Lead*\nHallo' });
    expect(discordPayload('@everyone hi', undefined, 'HyperLevel')).toEqual({ content: '@everyone hi', allowed_mentions: { parse: [] }, username: 'HyperLevel' });
    expect(discordPayload('x'.repeat(3000)).content).toHaveLength(2000);
    expect(notionPageId(PAGE)).toBe('12345678-90ab-cdef-1234-567890abcdef');
    expect(notionPageId('12345678-90ab-cdef-1234-567890abcdef')).toBe('12345678-90ab-cdef-1234-567890abcdef');
    expect(notionPageId('kein link')).toBeNull();
    expect(notionBlocks('Absatz eins\nzweite Zeile\n\n- a\n- b', 'Titel').map((b) => b.type)).toEqual(['heading_3', 'paragraph', 'bulleted_list_item', 'bulleted_list_item']);
  });

  it('maps sheet columns to contact fields and back', () => {
    const custom = [{ key: 'budget', label: 'Budget' }];
    expect(headerField('E-Mail', custom)).toBe('email');
    expect(headerField('First name', custom)).toBe('first_name');
    expect(headerField('Budget', custom)).toBe('custom.budget');
    expect(headerField('Lieblingsfarbe', custom)).toBeNull();
    const r = rowsToContacts([['Vorname', 'E-Mail', 'Tags', 'Budget', 'Egal'], ['Ida', 'ida@example.com', 'a; b', '500', 'x'], ['Ohne', '', '', '', ''], []], custom);
    expect(r.contacts).toEqual([{ first_name: 'Ida', email: 'ida@example.com', tags: ['a', 'b'], custom: { budget: '500' } }]);
    expect(r.skipped).toBe(1);
    const rows = contactsToRows([{ first_name: 'Ida', email: 'ida@example.com', phone: '+49 1', tags: ['a', 'b'], custom: { budget: '500' } }], custom);
    expect(rows[0].slice(0, 4)).toEqual(['Vorname', 'Nachname', 'E-Mail', 'Telefon']);
    expect(rows[0].at(-1)).toBe('Budget');
    expect(rows[1]).toEqual(expect.arrayContaining(['Ida', 'ida@example.com', '+49 1', 'a, b', '500']));
    expect(spreadsheetId('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0')).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  });
});

describe('Slack & Discord', () => {
  it('stores the webhook sealed, tests it and validates the URL', async () => {
    const list = (await t.api.get('/api/connectors')).data;
    expect(list.map((c: any) => c.key)).toEqual(expect.arrayContaining(['slack', 'discord', 'notion', 'google_sheets']));
    expect((await t.api.put('/api/connectors/slack', { values: { webhook_url: 'https://evil.example.com/hook' } })).status).toBe(400);
    const saved = await t.api.put('/api/connectors/slack', { values: { webhook_url: SLACK } });
    expect(saved.data).toMatchObject({ configured: true, values: { webhook_url: '••••••' } });
    expect(JSON.stringify((await t.api.get('/api/connectors')).data)).not.toContain('hooks.slack.com/services/T0001');
    expect(t.app.db.get(`SELECT data FROM connector_settings WHERE key = 'slack'`)!.data).not.toContain('T0001');
    const test = await t.api.post('/api/connectors/slack/test');
    expect(test.data.ok).toBe(true);
    expect(out[0]).toMatchObject({ url: SLACK, method: 'POST', body: { text: expect.stringContaining('verbunden') } });
    // keeping the masked value keeps the secret
    await t.api.put('/api/connectors/slack', { values: { webhook_url: '••••••' } });
    expect((await t.api.get('/api/connectors')).data.find((c: any) => c.key === 'slack').configured).toBe(true);
    reply = () => ({ status: 404, body: 'no_service' });
    const gone = await t.api.post('/api/connectors/slack/test');
    expect(gone.status).toBe(400);
    expect(gone.data.error).toContain('gibt es nicht mehr');
    const cat = (await t.api.get('/api/integrations/catalog')).data.items.find((i: any) => i.key === 'connector_slack');
    expect(cat).toMatchObject({ status: 'partial', setup: { location: 'apps/direct' } });
  });

  it('workflow action "Benachrichtigung an Slack/Discord" renders merge fields', async () => {
    await t.api.put('/api/connectors/discord', { values: { webhook_url: DISCORD } });
    const { log } = await runWorkflow(
      [
        { type: 'chat_notify', service: 'slack', title: 'Neuer Lead', text: '{{contact.name}} ({{contact.email}})' },
        { type: 'chat_notify', service: 'discord', text: 'Lead aus {{contact.city|?}}' },
        { type: 'chat_notify', service: 'slack', text: 'x', webhook_url: 'https://example.com/x' },
      ],
      { first_name: 'Ben', email: 'ben@example.com', city: 'Köln' },
    );
    expect(out[0]).toMatchObject({ url: SLACK, body: { text: '*Neuer Lead*\nBen (ben@example.com)' } });
    expect(out[1]).toMatchObject({ url: DISCORD, body: { content: 'Lead aus Köln', allowed_mentions: { parse: [] } } });
    expect(log.map((l) => l.result ?? l.error)).toEqual(['Slack: gesendet', 'Discord: gesendet', 'Slack-Webhook-URL ungültig']);
  });
});

describe('Notion', () => {
  it('tests the token and appends blocks from a workflow', async () => {
    expect((await t.api.put('/api/connectors/notion', { values: { token: 'falsch', page_id: PAGE } })).status).toBe(400);
    expect((await t.api.put('/api/connectors/notion', { values: { token: NOTION_TOKEN } })).data.error).toContain('Standard-Seite');
    await t.api.put('/api/connectors/notion', { values: { token: NOTION_TOKEN, page_id: PAGE } });
    reply = (o) => (o.url.endsWith('/users/me') ? { status: 200, body: { object: 'user', name: 'HyperLevel Bot' } } : { status: 200, body: { object: 'page' } });
    const test = await t.api.post('/api/connectors/notion/test');
    expect(test.data.detail).toBe('Verbunden als HyperLevel Bot · Seite erreichbar');
    expect(out[0].headers).toMatchObject({ authorization: `Bearer ${NOTION_TOKEN}`, 'notion-version': '2022-06-28' });
    expect(out[1].url).toBe('https://api.notion.com/v1/pages/12345678-90ab-cdef-1234-567890abcdef');
    out = [];
    const { log } = await runWorkflow([{ type: 'notion_append', heading: 'Lead {{contact.name}}', text: 'E-Mail: {{contact.email}}' }], { first_name: 'Cleo', email: 'cleo@example.com' });
    expect(out[0]).toMatchObject({ method: 'PATCH', url: 'https://api.notion.com/v1/blocks/12345678-90ab-cdef-1234-567890abcdef/children' });
    expect(out[0].body.children.map((b: any) => b.type)).toEqual(['heading_3', 'paragraph']);
    expect(out[0].body.children[1].paragraph.rich_text[0].text.content).toBe('E-Mail: cleo@example.com');
    expect(log[0].result).toBe('Notion: 2 Blöcke angehängt');
    reply = () => ({ status: 401, body: { message: 'API token is invalid.' } });
    const failed = await runWorkflow([{ type: 'notion_append', text: 'x' }], { first_name: 'D', email: 'd@example.com' });
    expect(failed.log[0].error).toContain('Zugriff verweigert');
    // removing it disables the action
    await t.api.del('/api/connectors/notion');
    const off = await runWorkflow([{ type: 'notion_append', text: 'x' }], { first_name: 'E', email: 'e@example.com' });
    expect(off.log[0].error).toContain('nicht eingerichtet');
  });
});

describe('Google Sheets', () => {
  it('connects with the agency Google app, exports and imports contacts', async () => {
    expect((await t.api.post('/api/sheets/connect')).status).toBe(409);
    await t.api.put('/api/agency/oauth', { google: G_CLIENT });
    expect((await t.api.get('/api/sheets')).data).toMatchObject({ oauth_ready: true, connected: false, redirect_uri: 'http://localhost/oauth/google/sheets/callback' });
    const start = await t.api.post('/api/sheets/connect');
    expect(start.data.url).toContain('spreadsheets');
    const { code, state, redirect } = oauth.authorize(start.data.url);
    expect(redirect).toBe('http://localhost/oauth/google/sheets/callback');
    const back = await t.api.get(`/oauth/google/sheets/callback?code=${code}&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/app/apps/direct?sheets=ok');
    expect((await t.api.get('/api/sheets')).data).toMatchObject({ connected: true, account_email: 'owner@example.com' });
    expect(JSON.stringify(t.app.db.get('SELECT * FROM sheets_connections'))).not.toContain(oauth.g.refresh);
    // the state is single-use
    expect((await t.api.get(`/oauth/google/sheets/callback?code=${code}&state=${encodeURIComponent(state)}`)).headers.get('location')).toContain('sheets=error');

    await t.api.post('/api/contacts', { first_name: 'Ida', email: 'ida@example.com', tags: ['export'] });
    reply = (o) => {
      if (o.method === 'POST' && o.url === 'https://sheets.googleapis.com/v4/spreadsheets') return { status: 200, body: { spreadsheetId: 'sheet123', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet123/edit' } };
      if (o.method === 'PUT') {
        sheet.values = o.body.values;
        return { status: 200, body: { updatedRows: o.body.values.length } };
      }
      if (o.method === 'GET') return { status: 200, body: { values: sheet.read } };
      return { status: 200, body: {} };
    };
    const ex = await t.api.post('/api/sheets/export', { tag: 'export' });
    expect(ex.status, JSON.stringify(ex.data)).toBe(200);
    expect(ex.data).toMatchObject({ spreadsheet_id: 'sheet123', rows: 1, url: 'https://docs.google.com/spreadsheets/d/sheet123/edit' });
    expect(out[0].headers.authorization).toBe(`Bearer ${oauth.g.access}`);
    expect(out[1].url).toContain('valueInputOption=RAW');
    expect(sheet.values[1]).toEqual(expect.arrayContaining(['Ida', 'ida@example.com', 'export']));
    // into an existing spreadsheet: a new tab, nothing overwritten
    out = [];
    await t.api.post('/api/sheets/export', { spreadsheet: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit' });
    expect(out[0]).toMatchObject({ method: 'POST', url: 'https://sheets.googleapis.com/v4/spreadsheets/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789:batchUpdate' });
    expect(out[0].body.requests[0].addSheet.properties.title).toMatch(/^Kontakte /);

    sheet.read = [['E-Mail', 'Vorname', 'Telefon'], ['neu@example.com', 'Nora', '0170 111'], ['ida@example.com', 'Ida-Maria', ''], ['', 'Ohne Mail', '']];
    const dry = await t.api.post('/api/sheets/import', { spreadsheet: 'sheet1234567890abcdefghij', dry_run: true });
    expect(dry.data).toMatchObject({ dry_run: true, rows: 2, skipped: 1 });
    const im = await t.api.post('/api/sheets/import', { spreadsheet: 'sheet1234567890abcdefghij', tag: 'aus-sheets' });
    expect(im.data).toMatchObject({ created: 1, updated: 1, skipped: 1 });
    const nora = (await t.api.get('/api/contacts?q=neu@example.com')).data.contacts[0];
    expect(nora).toMatchObject({ first_name: 'Nora', source: 'Google Sheets' });
    expect(nora.tags).toContain('aus-sheets');
    sheet.read = [['Name', 'Notiz'], ['A', 'b']];
    expect((await t.api.post('/api/sheets/import', { spreadsheet: 'sheet1234567890abcdefghij' })).data.error).toContain('E-Mail');

    expect((await t.api.del('/api/sheets')).status).toBe(200);
    expect(oauth.g.revoked).toContain(oauth.g.refresh);
    expect((await t.api.post('/api/sheets/export', {})).status).toBe(409);
  });
});
