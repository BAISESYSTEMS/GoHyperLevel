import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { retry } from '../server/services/anthropic.js';
import { videoType } from '../server/modules/video-testimonials.js';
import { cleanCases, readJson, summarizeResults } from '../server/modules/prompt-lab.js';

const KEY = 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123';
const calls: any[] = [];
let answer: (body: any) => string = () => '';
const fake = (async (_url: string, init: any = {}) => {
  const body = JSON.parse(init.body);
  calls.push(body);
  return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: answer(body) }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  t.app.services.aiFetch = fake;
  await t.setup();
}, 60_000);
afterAll(() => t.close());

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200, 7)]);

describe('video testimonials', () => {
  it('knows video types by their bytes', () => {
    expect(videoType(mp4)).toBe('mp4');
    expect(videoType(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]))).toBe('webm');
    expect(videoType(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(20)]))).toBe('mov');
    expect(videoType(Buffer.from('<html><script>alert(1)</script>'))).toBeUndefined();
  });
  it('collects a video, keeps it off the wall until approved, and lets the team review it', async () => {
    const g = (await t.api.get('/api/video-testimonials')).data;
    expect(g.items).toEqual([]);
    // Off until the team switches the collect page on.
    expect(g.page.active).toBe(false);
    await t.api.put('/api/video-testimonials/page', { active: true });
    const slug = g.page.slug;
    const page = await (await t.api.raw(`/testimonials/${slug}`)).text();
    expect(page).toContain('Video senden');
    expect(page).toContain('capture="user"');
    const start = (b: any) => t.api.raw(`/testimonials/${slug}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    expect((await start({ name: 'Anna', size: 100 })).status).toBe(400);
    expect((await start({ name: 'Anna', consent: true, size: 500 * 1024 * 1024 })).status).toBe(400);
    const begin = async () => (await start({ name: 'Anna Beispiel', email: 'anna@example.com', text: 'Super Team!', consent: true, size: mp4.length })).json();
    let s = await begin();
    const put = (body: Buffer, tok = s.token) => t.api.raw(`/testimonials/${slug}/upload/${s.id}?t=${encodeURIComponent(tok)}`, { method: 'PUT', body });
    expect((await put(mp4, 'falsch')).status).toBe(404);
    expect((await put(Buffer.from('<svg onload=alert(1)>'))).status).toBe(400);
    // A failed upload uses the token up; the page starts again.
    expect((await put(mp4)).status).toBe(404);
    s = await begin();
    expect((await put(mp4)).status).toBe(200);
    // The token is used up.
    expect((await put(mp4)).status).toBe(404);

    const list = (await t.api.get('/api/video-testimonials')).data.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Anna Beispiel', status: 'pending', mime: 'video/mp4' });
    const vid = list[0].id;
    const own = await t.api.raw(`/api/video-testimonials/${vid}/video`, { headers: { cookie: t.api.cookie, 'x-location-id': t.api.location, range: 'bytes=0-9' } });
    expect(own.status).toBe(206);
    expect((await t.api.raw(`/testimonials/${slug}/v/${vid}`)).status).toBe(404);
    expect(await (await t.api.raw(`/testimonials/${slug}/wall`)).text()).not.toContain('Anna Beispiel');

    expect((await t.api.patch(`/api/video-testimonials/${vid}`, { status: 'approved' })).data.status).toBe('approved');
    expect(await (await t.api.raw(`/testimonials/${slug}/wall`)).text()).toContain('Anna Beispiel');
    const pub = await t.api.raw(`/testimonials/${slug}/v/${vid}`);
    expect(pub.status).toBe(200);
    expect(pub.headers.get('content-type')).toBe('video/mp4');

    // Switched off: the collect page answers nothing.
    await t.api.put('/api/video-testimonials/page', { active: false, title: 'Dein Video' });
    expect((await t.api.raw(`/testimonials/${slug}`)).status).toBe(404);
    expect((await t.api.del(`/api/video-testimonials/${vid}`)).status).toBe(200);
    expect((await t.api.raw(`/testimonials/${slug}/v/${vid}`)).status).toBe(404);
    expect((t.app.services.mcpTools as any[]).some((x) => x.name === 'ghl_video_testimonial_review')).toBe(true);
  });
});

describe('prompt optimizer', () => {
  it('cleans cases, reads fenced JSON and sums up', () => {
    expect(cleanCases([{ input: 'Was kostet es?', expect: 'Nennt keinen erfundenen Preis' }, { input: '', expect: 'x' }, 'kaputt'])).toHaveLength(1);
    expect(readJson('```json\n{"pass":true}\n```')).toEqual({ pass: true });
    expect(readJson('Ergebnis: {"a":1} fertig')).toEqual({ a: 1 });
    expect(summarizeResults([{ input: 'a', expect: 'b', answer: '', pass: true, score: 9, reason: '' }, { input: 'a', expect: 'b', answer: '', pass: false, score: 3, reason: '' }])).toEqual({ passed: 1, total: 2, score: 60 });
  });
  it('tests an agent, proposes better instructions and applies them through the agent route', async () => {
    await t.api.put('/api/ai/settings', { api_key: KEY, enabled: true });
    const agent = (await t.api.post('/api/agents', { name: 'Empfang', instructions: 'Du beantwortest Fragen von Kunden.' })).data;
    expect(agent.id).toBeTruthy();
    const suite = (await t.api.post('/api/prompt-lab', { kind: 'agent', target_id: agent.id, name: 'Preise', cases: [{ input: 'Was kostet ein Erstgespräch?', expect: 'Sagt, dass das Erstgespräch kostenlos ist' }, { input: 'Habt ihr sonntags offen?', expect: 'Erfindet keine Öffnungszeiten' }] })).data;
    expect(suite.cases).toHaveLength(2);
    answer = (body) => {
      const sys = JSON.stringify(body.system ?? '');
      if (sys.includes('prüfst streng')) return JSON.stringify(body.messages[0].content.includes('kostenlos') ? { pass: false, score: 2, reason: 'Nennt einen Preis' } : { pass: true, score: 9, reason: 'ok' });
      if (sys.includes('verbesserst')) return JSON.stringify({ instructions: 'Du beantwortest Fragen von Kunden. Das Erstgespräch ist kostenlos.', changes: ['Regel zum Erstgespräch ergänzt'] });
      return 'Das kostet 99 €.';
    };
    calls.length = 0;
    const run = (await t.api.post(`/api/prompt-lab/${suite.id}/run`)).data;
    expect(run).toMatchObject({ passed: 1, total: 2, score: 55 });
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls[0].system)).toContain('Du beantwortest Fragen von Kunden.');
    const imp = (await t.api.post(`/api/prompt-lab/${suite.id}/improve`)).data;
    expect(imp.instructions).toContain('kostenlos');
    expect(imp.changes).toEqual(['Regel zum Erstgespräch ergänzt']);
    // Nothing changed yet.
    expect((await t.api.get(`/api/agents/${agent.id}`)).data.instructions).toBe('Du beantwortest Fragen von Kunden.');
    expect((await t.api.post(`/api/prompt-lab/${suite.id}/apply`, { instructions: imp.instructions })).status).toBe(200);
    expect((await t.api.get(`/api/agents/${agent.id}`)).data.instructions).toContain('kostenlos');
    const listed = (await t.api.get('/api/prompt-lab')).data;
    expect(listed.suites[0].last_run.passed).toBe(1);
    expect((t.app.services.mcpTools as any[]).some((x) => x.name === 'ghl_prompt_test_run')).toBe(true);
  });
  it('a custom prompt can be tested as a draft without saving', async () => {
    const suite = (await t.api.post('/api/prompt-lab', { kind: 'custom', name: 'Eigener', prompt: 'Sei freundlich.', cases: [{ input: 'Hallo', expect: 'Grüßt freundlich' }] })).data;
    answer = (body) => (JSON.stringify(body.system ?? '').includes('prüfst streng') ? '{"pass":true,"score":10,"reason":"gut"}' : 'Hallo! Wie kann ich helfen?');
    const r = (await t.api.post(`/api/prompt-lab/${suite.id}/run`, { prompt: 'Sei sehr freundlich.' })).data;
    expect(r).toMatchObject({ draft: true, passed: 1 });
    expect((await t.api.get('/api/prompt-lab')).data.suites.find((s: any) => s.id === suite.id).last_run).toBeNull();
    expect((await t.api.post(`/api/prompt-lab/${suite.id}/improve`)).status).toBe(400);
  });
});

describe('Google lead forms', () => {
  it('maps columns, imports a lead once via the keyed webhook and fires the lead trigger', async () => {
    const { mapGoogleLead } = await import('../server/modules/ads-google-leads.js');
    expect(mapGoogleLead({ user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Lena Lead' }, { column_id: 'EMAIL', string_value: 'lena@example.com' }, { column_name: 'Wann möchten Sie starten?', string_value: 'Sofort' }] })).toEqual({ input: { name: 'Lena Lead', email: 'lena@example.com' }, custom: { wann_mochten_sie_starten: 'Sofort' } });
    const on = (await t.api.post('/api/ads/google-leads/enable')).data;
    expect(on.enabled).toBe(true);
    expect(on.key).toBeTruthy();
    const events: any[] = [];
    t.app.events.on('ads.lead', (e: any) => void events.push(e));
    const hook = (body: any) => t.api.raw(new URL(on.url).pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const lead = { lead_id: 'L-1', google_key: on.key, form_id: 'F1', campaign_id: 'C9', gcl_id: 'gcl', is_test: true, user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Lena Lead' }, { column_id: 'EMAIL', string_value: 'lena@example.com' }, { column_id: 'PHONE_NUMBER', string_value: '+49 151 2345678' }] };
    expect((await hook({ ...lead, google_key: 'falsch' })).status).toBe(401);
    expect((await hook(lead)).status).toBe(200);
    expect((await hook(lead)).status).toBe(200);
    const st = (await t.api.get('/api/ads/google-leads')).data;
    expect(st.recent).toHaveLength(1);
    expect(st.recent[0]).toMatchObject({ email: 'lena@example.com', is_test: 1 });
    const c = (await t.api.get(`/api/contacts/${st.recent[0].contact_id}`)).data;
    expect(c.tags).toEqual(expect.arrayContaining(['google-lead', 'test-lead']));
    await t.app.events.flush();
    expect(events.filter((e) => e.data?.platform === 'Google')).toHaveLength(1);
    await t.api.post('/api/ads/google-leads/disable');
    expect((await hook({ ...lead, lead_id: 'L-2' })).status).toBe(401);
  });
});

describe('own contact fields in reports', () => {
  it('sums a number field, groups by a select field and scopes fields to their sub-account', async () => {
    const { customFieldReportFields } = await import('../server/modules/report-custom-fields.js');
    expect(customFieldReportFields([{ location_id: 'a', key: 'x; DROP', label: 'Böse', type: 'number', options: '[]' }])).toEqual([]);
    expect((await t.api.post('/api/custom-fields', { label: 'Budget', key: 'budget', type: 'number' })).status).toBe(200);
    expect((await t.api.post('/api/custom-fields', { label: 'Paket', key: 'paket', type: 'select', options: ['Basis', 'Pro'] })).status).toBe(200);
    await t.api.post('/api/contacts', { first_name: 'A', email: 'a-cf@example.com', custom: { budget: '1000', paket: 'Pro' } });
    await t.api.post('/api/contacts', { first_name: 'B', email: 'b-cf@example.com', custom: { budget: 2500, paket: 'Pro' } });
    await t.api.post('/api/contacts', { first_name: 'C', email: 'c-cf@example.com', custom: { paket: 'Basis' } });
    const src = (await t.api.get('/api/reports/sources')).data.sources.find((s: any) => s.key === 'contacts');
    expect(src.fields.find((f: any) => f.key === 'cf_budget')).toMatchObject({ label: 'Budget', type: 'number' });
    const r = (await t.api.post('/api/reports/run', { query: { source: 'contacts', range: 'all', measures: ['sum:cf_budget'], group_by: ['cf_paket'] } })).data;
    expect(r.rows.map((x: any) => [x.l[0], x.v[0]])).toEqual(expect.arrayContaining([['Pro', 3500], ['Basis', 0]]));
  });
});

describe('appointments in the customer portal', () => {
  it('lists the member’s own appointments with the manage link and the booking pages', async () => {
    const { sha256 } = await import('../server/core/util.js');
    const loc = t.api.location;
    const anna = (await t.api.post('/api/contacts', { first_name: 'Anna', email: 'anna-portal@example.com' })).data;
    const otto = (await t.api.post('/api/contacts', { first_name: 'Otto', email: 'otto-portal@example.com' })).data;
    const cal = (await t.api.post('/api/calendars', { name: 'Beratung' })).data;
    const at = (d: number) => new Date(Date.now() + d * 864e5).toISOString();
    const add = (id: string, contact: string, start: string, title: string) =>
      t.app.db.run("INSERT INTO appointments (id, location_id, calendar_id, contact_id, title, start_at, end_at, status, manage_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)", id, loc, cal.id, contact, title, start, new Date(new Date(start).getTime() + 1800_000).toISOString(), `tok-${id}`, new Date().toISOString());
    add('ap1', anna.id, at(2), 'Erstgespräch Anna');
    add('ap2', anna.id, at(-5), 'Alter Termin');
    add('ap3', otto.id, at(3), 'Termin von Otto');
    let n = 0;
    const cookieOf = (cid: string) => {
      const raw = `raw-${cid}-${n++}`;
      t.app.db.run('INSERT INTO member_sessions (token_hash, location_id, contact_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(raw), loc, cid, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
      return `pm_${loc}=${raw}`;
    };
    const page = await t.api.raw(`/portal/${loc}/appointments`, { headers: { cookie: cookieOf(anna.id) } });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Erstgespräch Anna');
    expect(html).toContain('/book/manage/tok-ap1');
    expect(html).toContain('Alter Termin');
    expect(html).not.toContain('Termin von Otto');
    expect(html).toContain(`/book/${cal.slug}`);
    const home = await (await t.api.raw(`/portal/${loc}`, { headers: { cookie: cookieOf(anna.id) } })).text();
    expect(home).toContain('Meine Termine');
    expect((await t.api.raw(`/portal/${loc}/appointments`, { redirect: 'manual' })).status).toBe(401);
  });
});

describe('WordPress plugin', () => {
  it('lists shortcodes and downloads a valid zip with the sub-account baked in', async () => {
    const { pluginPhp } = await import('../server/modules/wordpress-plugin.js');
    expect(pluginPhp({ base: "https://a'b.de", locationId: 'L1', brand: 'X', version: '1' })).toContain("define('HYPERLEVEL_BASE', 'https://a\\'b.de');");
    await t.api.post('/api/forms', { name: 'Kontakt' });
    const info = (await t.api.get('/api/wordpress-plugin')).data;
    expect(info.forms[0].shortcode).toMatch(/^\[hyperlevel_form id="[^"]+"\]$/);
    expect(info.calendars.length).toBeGreaterThan(0);
    const r = await t.api.raw(info.download_url, { headers: { cookie: t.api.cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/zip');
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
    expect(buf.readUInt16LE(buf.length - 22 + 10)).toBe(2);
    const text = buf.toString('utf8');
    expect(text).toContain('hyperlevel/hyperlevel.php');
    expect(text).toContain(`define('HYPERLEVEL_LOCATION', '${t.api.location}');`);
    expect(text).toContain("add_shortcode('hyperlevel_form'");
  });
});

describe('course with AI', () => {
  it('drafts an outline through aiRun and creates a draft course with unpublished lessons', async () => {
    const { cleanOutline } = await import('../server/modules/course-ai.js');
    expect(cleanOutline({ title: 'X', modules: [{ title: 'Leer', lessons: [] }] })).toBeNull();
    answer = () => JSON.stringify({ title: 'Social Media für Handwerker', description: 'In 2 Wochen sichtbar.', modules: [{ title: 'Grundlagen', lessons: [{ title: 'Warum Social Media?', body: '## Ziel\nMehr Anfragen.', duration_min: 8 }, { title: 'Profil einrichten', body: 'Schritt für Schritt.' }] }, { title: 'Inhalte', lessons: [{ title: 'Vorher-Nachher', body: 'Fotos zeigen.' }] }] });
    const o = await t.api.post('/api/course-ai/outline', { topic: 'Social Media für Handwerker', modules: 2, lessons_per_module: 2 });
    expect(o.status).toBe(200);
    expect(o.data.modules).toHaveLength(2);
    expect(JSON.stringify(calls.at(-1).system)).toContain('Kurs-Designer');
    const c = (await t.api.post('/api/course-ai/create', { outline: o.data })).data;
    expect(c).toMatchObject({ title: 'Social Media für Handwerker', modules: 2, lessons: 3 });
    const course = (await t.api.get(`/api/courses/${c.id}`)).data;
    expect(course.status).toBe('draft');
    expect(JSON.stringify(course)).toContain('Vorher-Nachher');
    expect((await t.api.post('/api/course-ai/create', { outline: {} })).status).toBe(400);
  });
});
