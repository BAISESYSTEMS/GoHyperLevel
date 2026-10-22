import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { FORM_TOOLS } from '../server/modules/form-pdf.js';

/** PDF of a form submission and the forms' MCP tools (modules/form-pdf.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let formId = '';
let subId = '';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  const f = await t.api.post('/api/forms', {
    name: 'Anfrage Küche',
    fields: [
      { id: 'n', label: 'Name', type: 'text', name: 'first_name', required: true },
      { id: 'e', label: 'E-Mail', type: 'email', name: 'email', required: true },
      { id: 'w', label: 'Wünsche', type: 'textarea', name: 'wuensche' },
      { id: 'c', label: 'Farben', type: 'checkbox', name: 'farben', options: ['Weiß', 'Eiche'] },
    ],
  });
  expect(f.status, JSON.stringify(f.data)).toBe(200);
  formId = f.data.id;
  const r = await t.api.raw(`/api/public/forms/${formId}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ first_name: 'Jörg', email: 'joerg@example.com', wuensche: 'Eine Insel mit Spüle – bitte bis März.', farben: ['Weiß', 'Eiche'] }) });
  expect(r.status, await r.clone().text()).toBe(200);
  subId = t.app.db.get<any>('SELECT id FROM form_submissions WHERE form_id = ?', formId).id;
});
afterAll(async () => {
  await t.close();
});

describe('form submission PDF', () => {
  it('renders the answers as a PDF for the team', async () => {
    const r = await t.api.raw(`/api/forms/${formId}/submissions/${subId}/pdf`, { headers: { cookie: t.api.cookie, 'x-location-id': t.api.location } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toMatch(/einsendung-\d{4}-\d\d-\d\d-/);
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(800);
    // ?locationId= works for a plain link from the app.
    expect((await t.api.raw(`/api/forms/${formId}/submissions/${subId}/pdf?locationId=${t.api.location}`, { headers: { cookie: t.api.cookie } })).status).toBe(200);
  });

  it('one submission as JSON with its pdf_url; other sub-accounts and strangers get nothing', async () => {
    const one = await t.api.get(`/api/forms/${formId}/submissions/${subId}`);
    expect(one.data.data).toMatchObject({ Name: 'Jörg', Farben: ['Weiß', 'Eiche'] });
    expect(one.data.pdf_url).toBe(`/api/forms/${formId}/submissions/${subId}/pdf`);
    expect((await t.api.get(`/api/forms/${formId}/submissions/gibtsnicht/pdf`)).status).toBe(404);
    expect((await t.api.raw(`/api/forms/${formId}/submissions/${subId}/pdf`)).status).toBe(401);
    const other = (await t.api.post('/api/locations', { name: 'Andere' })).data.id;
    const mine = t.api.location;
    t.api.setLocation(other);
    expect((await t.api.get(`/api/forms/${formId}/submissions/${subId}/pdf`)).status).toBe(404);
    t.api.setLocation(mine);
  });

  it('MCP tools list forms and submissions (read only)', async () => {
    expect(FORM_TOOLS.every((x) => x.annotations?.readOnlyHint)).toBe(true);
    const call = { api: (method: string, path: string, o: any) => t.api.get(path, { 'x-location-id': o.location }).then((r) => r.data) } as any;
    const forms = await FORM_TOOLS.find((x) => x.name === 'ghl_forms')!.run(call, { location_id: t.api.location });
    expect(forms).toEqual([expect.objectContaining({ id: formId, name: 'Anfrage Küche', submissions: 1 })]);
    const subs = await FORM_TOOLS.find((x) => x.name === 'ghl_form_submission_pdfs')!.run(call, { location_id: t.api.location, form_id: formId });
    expect(subs[0]).toMatchObject({ id: subId, contact: 'Jörg', pdf_url: `/api/forms/${formId}/submissions/${subId}/pdf` });
  });
});

describe('save progress and continue later', () => {
  const pub = (method: string, path: string, body?: unknown) =>
    t.api.raw(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }));

  it('is off until switched on; then the page carries the script and drafts are stored and mailed', async () => {
    expect(await (await t.api.raw(`/f/${formId}`)).text()).not.toContain('pghl_draft_');
    expect((await pub('POST', `/api/public/forms/${formId}/draft`, { email: 'jo@example.com', data: {} })).status).toBe(404);
    const f = (await t.api.get(`/api/forms/${formId}`)).data;
    expect((await t.api.patch(`/api/forms/${formId}`, { settings: { ...f.settings, save_progress: true } })).status).toBe(200);
    const page = await (await t.api.raw(`/f/${formId}`)).text();
    expect(page).toContain('pghl_draft_');
    expect(page).toContain('Später weitermachen');
    const script = page.split('<script>').pop()!.split('</script>')[0];
    expect(() => new Function(script)).not.toThrow();

    expect((await pub('POST', `/api/public/forms/${formId}/draft`, { email: 'kaputt', data: {} })).status).toBe(400);
    const r = await pub('POST', `/api/public/forms/${formId}/draft`, { email: 'Jo@Example.com', data: { first_name: 'Jo', wuensche: 'Halbe Sachen', farben: ['Eiche'], fremd: 'nicht speichern' } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const mail = t.app.db.get<any>(`SELECT * FROM form_drafts WHERE email = 'jo@example.com'`);
    expect(JSON.parse(mail.data)).toEqual({ first_name: 'Jo', wuensche: 'Halbe Sachen', farben: ['Eiche'] });
    expect(mail.id).toMatch(/^[0-9a-f]{64}$/); // only the hash of the link's token is stored
    expect(Date.parse(mail.expires_at) - Date.now()).toBeGreaterThan(29 * 86_400_000);
  });

  it('restores by token, forgets after deletion or expiry, and goes with the person', async () => {
    const tok = 'tok-' + Math.random().toString(36).slice(2);
    const { sha256 } = await import('../server/core/util.js');
    t.app.db.insert('form_drafts', { id: sha256(tok), location_id: t.api.location, form_id: formId, email: 'ina@example.com', data: JSON.stringify({ first_name: 'Ina' }), created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    expect((await pub('GET', `/api/public/forms/${formId}/draft/${tok}`)).data.data).toEqual({ first_name: 'Ina' });
    expect((await pub('GET', `/api/public/forms/${formId}/draft/falsch`)).status).toBe(404);
    expect((await pub('DELETE', `/api/public/forms/${formId}/draft/${tok}`)).status).toBe(200);
    expect((await pub('GET', `/api/public/forms/${formId}/draft/${tok}`)).status).toBe(404);
    t.app.db.insert('form_drafts', { id: sha256(tok + 'x'), location_id: t.api.location, form_id: formId, email: 'ina@example.com', data: '{}', created_at: new Date().toISOString(), expires_at: new Date(Date.now() - 1000).toISOString() });
    expect((await pub('GET', `/api/public/forms/${formId}/draft/${tok}x`)).status).toBe(404);
    const c = (await t.api.post('/api/contacts', { first_name: 'Jo', email: 'jo@example.com' })).data.id;
    expect((await t.api.get(`/api/contacts/${c}/privacy-export`)).data.data['form_drafts (E-Mail)']).toHaveLength(1);
    await t.api.post(`/api/contacts/${c}/erase`, { confirm: c });
    expect(t.app.db.get(`SELECT 1 AS x FROM form_drafts WHERE email = 'jo@example.com'`)).toBeUndefined();
  });
});
