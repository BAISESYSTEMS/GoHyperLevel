import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { retry } from '../server/services/anthropic.js';
import { fakeModel, json as jsonReply } from './agent-fakes.js';
import { siteBlocks } from '../server/services/site-blocks.js';
import { AI_BLOCKS, blockCatalogText, checkBlock, checkSection, compileSection, decompileSection, h1Count, mergeSection, type BlockEnv } from '../server/services/site-ai-schema.js';
import { checkPages, checkPlan, cleanBrief, diffPage, estimateTokens, type Plan } from '../server/services/site-ai.js';
import { BLOCKS as EDITOR_BLOCKS } from '../web/src/pages/site/blocks.js';

/**
 * Funnel & Website AI: the AI is a script behind the Claude API (no network). Under test: the block schema and its agreement with
 * the site block registry, plan and page checks with retries, cost estimate and monthly limit, BYOK routing, draft-only apply
 * (unpublished site, restore points), section commands, isolation between sub-accounts, the MCP tool and the writer.
 */

const KEY = 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123';
const calls: { body: any }[] = [];
let queue: (string | ((body: any) => string))[] = [];
const claude = (text: string, usage = { input_tokens: 4000, output_tokens: 1500 }) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage });
const fake = (async (_url: string, init: any = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ body });
  const next = queue.shift();
  const text = typeof next === 'function' ? next(body) : (next ?? '{}');
  return new Response(JSON.stringify(claude(text)), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;
const net = fakeModel();

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let B = '';
const inLoc = async <T>(loc: string, fn: () => Promise<T>): Promise<T> => {
  const before = t.api.location;
  t.api.setLocation(loc);
  try {
    return await fn();
  } finally {
    t.api.setLocation(before);
  }
};
const lastUser = () => calls.at(-1)!.body.messages.at(-1).content as string;
const systemText = (i = -1) => (calls.at(i)!.body.system as any[]).map((s) => s.text).join('\n');

const PLAN = { site_name: 'Malerbetrieb Meier', style: 'handwerk', summary: 'Landingpage für Angebotsanfragen', pages: [{ slug: 'start', name: 'Start', purpose: 'Anfragen einsammeln', sections: ['hero', 'benefits', 'faq', 'form'] }, { slug: 'danke', name: 'Danke', purpose: 'Bestätigung', sections: ['thanks'] }] };
const START = {
  slug: 'start',
  seo: { title: 'Malerbetrieb Meier – Innenanstrich in Köln', description: 'Kostenloses Angebot anfordern.' },
  sections: [
    { name: 'Hero', style: 'soft', layout: '7-5', columns: [[{ type: 'hero', heading: 'Frische Wände in Köln', subheading: 'Innenanstrich vom Meisterbetrieb.', button_text: 'Angebot anfordern', button_url: '#formular', align: 'left' }], [{ type: 'features', items: [{ icon: '🖌️', title: 'Sauber', text: 'Wir decken alles ab.' }, { icon: '⏱️', title: 'Pünktlich', text: 'Fester Termin.' }] }]] },
    { name: 'FAQ', style: 'plain', layout: '1', columns: [[{ type: 'faq', heading: 'Häufige Fragen', items: [{ q: 'Was kostet es?', a: '[Preis] je m² – wir machen dir ein Angebot.' }, { q: 'Wie lange dauert es?', a: 'Meist ein bis zwei Tage.' }] }]] },
    { name: 'Kontakt', anchor: 'formular', layout: '1', columns: [[{ type: 'heading', text: 'Jetzt Angebot anfordern', level: 2 }, { type: 'form', heading: 'Deine Anfrage' }]] },
  ],
};
const DANKE = { slug: 'danke', seo: { title: 'Danke' }, sections: [{ name: 'Danke', layout: '1', columns: [[{ type: 'heading', text: 'Danke für deine Anfrage!', level: 1 }, { type: 'button', text: 'Zur Startseite', url: 'page:start' }]] }] };
const PAGES = { pages: [START, DANKE], notes: ['Formularfelder prüfen'] };

beforeAll(async () => {
  retry.ms = 1;
  process.env.PGHL_FORMS_PER_MINUTE = '10000';
  t = await startTestApp();
  t.app.services.aiFetch = fake;
  t.app.services.aiConnectionsFetch = net.fetch;
  await t.setup();
  A = t.api.location;
  B = (await t.api.post('/api/locations', { name: 'Firma B' })).data.id;
}, 60_000);
afterAll(async () => {
  delete process.env.PGHL_FORMS_PER_MINUTE;
  await t.close();
});
beforeEach(() => {
  calls.length = 0;
  queue = [];
  net.reset();
});

// --- the schema ----------------------------------------------------------------------------------------------------------

const env = (over: Partial<BlockEnv> = {}): BlockEnv => ({ registry: new Set(Object.keys(AI_BLOCKS)), refs: { form: [{ id: 'form1', name: 'Kontakt' }], calendar: [{ slug: 'beratung', name: 'Beratung' }], product: [{ id: 'prod1', name: 'Kurs' }] }, pages: new Set(['start', 'danke']), ...over });

describe('block schema', () => {
  it('only offers blocks that exist in the app registry and in the editor catalogue', () => {
    const registry = new Set(siteBlocks(t.app).keys());
    for (const type of Object.keys(AI_BLOCKS)) {
      expect(registry.has(type), `${type} hat keinen Server-Renderer`).toBe(true);
      expect(EDITOR_BLOCKS[type], `${type} fehlt im Editor-Katalog`).toBeTruthy();
      for (const k of Object.keys(AI_BLOCKS[type].fields)) expect(EDITOR_BLOCKS[type].fields.some((f) => f[0] === k) || ['align', 'level'].includes(k), `${type}.${k} gibt es im Editor nicht`).toBe(true);
    }
    // a type missing in the registry is neither offered nor accepted
    const less = new Set([...registry].filter((x) => x !== 'pricing'));
    expect(blockCatalogText(less)).not.toContain('- pricing');
    expect(blockCatalogText(registry)).toMatch(/- hero · Hero – .*heading\*:text≤110/);
    expect(checkBlock({ type: 'pricing', items: [{ name: 'A', price: '1 €' }] }, env({ registry: less }), 'X').errors[0]).toContain('unbekannter Block-Typ „pricing“');
  });

  it('checks fields, lengths, links and account ids – and names every problem', () => {
    const ok = checkBlock({ type: 'hero', heading: 'Hallo', button_text: 'Los', button_url: 'page:danke', foo: 1 }, env(), 'B1');
    expect(ok.errors).toEqual([]);
    expect(ok.warnings[0]).toContain('unbekannte Felder entfernt: foo');
    expect(ok.block).toMatchObject({ type: 'hero', heading: 'Hallo', button_url: 'page:danke' });
    expect(ok.block).not.toHaveProperty('foo');
    const bad = checkBlock({ type: 'hero', subheading: 'x'.repeat(400), button_url: 'javascript:alert(1)' }, env(), 'B2').errors;
    expect(bad.join('\n')).toMatch(/„heading“ fehlt/);
    expect(bad.join('\n')).toMatch(/400 Zeichen lang, höchstens 320/);
    expect(bad.join('\n')).toMatch(/kein erlaubter Link/);
    expect(checkBlock({ type: 'button', text: 'x', url: 'page:preise' }, env(), 'B3').errors[0]).toContain('die es im Plan nicht gibt');
    expect(checkBlock({ type: 'form', form_id: 'erfunden' }, env(), 'B4').errors[0]).toContain('gibt es in diesem Sub-Account nicht');
    expect(checkBlock({ type: 'form', form_id: 'form1' }, env(), 'B5').errors).toEqual([]);
    expect(checkBlock({ type: 'calendar', calendar_slug: 'beratung' }, env(), 'B6').errors).toEqual([]);
    expect(checkBlock({ type: 'text', text: '<script>x</script>' }, env(), 'B7').errors[0]).toContain('enthält HTML');
    expect(checkBlock({ type: 'faq', items: [{ q: 'nur eine', a: 'x' }] }, env(), 'B8').errors[0]).toContain('erlaubt 2–10');
    expect(checkBlock({ type: 'heading', text: 'x', level: 4 }, env(), 'B9').errors[0]).toContain('1 oder 2 oder 3');
    expect(checkBlock({ type: 'image', src: 'https://x.de/a.png' }, env(), 'B10').errors[0]).toContain('unbekannter Block-Typ');
  });

  it('compiles the simple section format into the real layout and back; a rewrite keeps the styling', () => {
    const r = checkSection({ name: 'Hero', style: 'brand', layout: '7-5', columns: [[{ type: 'hero', heading: 'H' }], [{ type: 'text', text: 'T' }]] }, env(), 'S');
    expect(r.errors).toEqual([]);
    expect(checkSection({ layout: '2', columns: [[{ type: 'text', text: 'x' }]] }, env(), 'S').errors[0]).toContain('hat 2 Spalte(n), geliefert wurden 1');
    expect(checkSection({ layout: '9', columns: [[{ type: 'text', text: 'x' }]] }, env(), 'S').errors[0]).toContain('unbekannt');
    const sec = compileSection(r.section!);
    expect(sec).toMatchObject({ type: 'section', name: 'Hero', bg: 'token:brand', pad_y: 88 });
    expect(sec.rows[0].cols.map((c: any) => c.span)).toEqual([7, 5]);
    expect(h1Count([sec])).toBe(1);
    // the owner styled the text block; the AI rewrites the text only
    sec.rows[0].cols[1].blocks[0] = { ...sec.rows[0].cols[1].blocks[0], bg: '#fef3c7', padding: 12, fs: { desktop: 120 } };
    const simple = decompileSection(sec);
    expect(simple).toMatchObject({ name: 'Hero', style: 'brand', rows: [{ layout: '7-5' }] });
    expect(JSON.stringify(simple)).not.toContain('fef3c7');
    const textId = sec.rows[0].cols[1].blocks[0].id;
    const answer = checkSection({ id: sec.id, rows: [{ layout: '7-5', columns: [[{ id: sec.rows[0].cols[0].blocks[0].id, type: 'hero', heading: 'Kürzer' }], [{ id: textId, type: 'text', text: 'Neu' }]] }] }, env(), 'S', new Set([sec.id]));
    expect(answer.errors).toEqual([]);
    const merged = mergeSection(sec, answer.section!);
    expect(merged.rows[0].cols[1].blocks[0]).toMatchObject({ id: textId, text: 'Neu', bg: '#fef3c7', padding: 12, fs: { desktop: 120 } });
    expect(merged.rows[0].cols[0].blocks[0]).toMatchObject({ heading: 'Kürzer' });
    expect(merged.rows[0].cols[0].blocks[0]).not.toHaveProperty('subheading');
    expect(merged.rows[0].cols.map((c: any) => c.id)).toEqual(sec.rows[0].cols.map((c: any) => c.id));
  });
});

describe('plan and pages', () => {
  const brief = cleanBrief({ business: 'Malerbetrieb Meier', offer: 'Innenanstrich', page_type: 'landing' });
  it('checks the plan: page counts per type, slugs, no legal pages', () => {
    expect(checkPlan(PLAN, brief).errors).toEqual([]);
    expect(checkPlan({ ...PLAN, pages: [...PLAN.pages, { slug: 'x', name: 'X', sections: ['hero'] }] }, brief).errors[0]).toContain('3 Seiten');
    expect(checkPlan({ ...PLAN, pages: [PLAN.pages[0], { slug: 'impressum', name: 'Impressum', sections: ['text'] }] }, brief).errors[0]).toContain('Rechtsseite');
    expect(checkPlan({ ...PLAN, pages: [{ slug: 'Start Seite', name: 'S', sections: ['hero'] }] }, brief).errors[0]).toContain('nur Kleinbuchstaben');
    const unknownStyle = checkPlan({ ...PLAN, style: 'barock' }, brief);
    expect(unknownStyle.plan!.style).toBe('leadmagnet');
    expect(unknownStyle.warnings[0]).toContain('barock');
  });

  it('checks the pages: every planned page, one H1 each, links between them', () => {
    const e = { registry: new Set(Object.keys(AI_BLOCKS)), refs: { form: [], calendar: [], product: [] } };
    const ok = checkPages(PAGES, PLAN as Plan, e);
    expect(ok.errors).toEqual([]);
    expect(ok.pages!.map((p) => p.slug)).toEqual(['start', 'danke']);
    expect(ok.pages![0].blocks.find((b) => b.anchor === 'formular')).toBeTruthy();
    expect(checkPages({ pages: [START] }, PLAN as Plan, e).errors).toContain('Seite „danke“ fehlt');
    const twoH1 = { pages: [START, { ...DANKE, sections: [{ layout: '1', columns: [[{ type: 'heading', text: 'A', level: 1 }, { type: 'heading', text: 'B', level: 1 }]] }] }] };
    expect(checkPages(twoH1, PLAN as Plan, e).errors[0]).toContain('2 H1-Überschriften');
  });

  it('diffs a page section by section', () => {
    const e = { registry: new Set(Object.keys(AI_BLOCKS)), refs: { form: [], calendar: [], product: [] } };
    const before = checkPages(PAGES, PLAN as Plan, e).pages![0].blocks;
    const after = [{ ...before[0], name: 'Hero neu', rows: [{ ...before[0].rows[0], cols: [{ ...before[0].rows[0].cols[0], blocks: [{ ...before[0].rows[0].cols[0].blocks[0], heading: 'Anders' }] }, before[0].rows[0].cols[1]] }] }, before[1]];
    const d = diffPage(before, after);
    expect(d.counts).toEqual({ new: 0, changed: 1, removed: 1, same: 1 });
    expect(d.sections.find((s) => s.change === 'removed')!.name).toBe('Kontakt');
  });

  it('estimates more for more pages', () => {
    const one = estimateTokens({ mode: 'site', pages: 1, systemChars: 8000, userChars: 400 });
    const six = estimateTokens({ mode: 'site', pages: 6, systemChars: 8000, userChars: 400 });
    expect(six.output).toBeGreaterThan(one.output * 3);
    expect(six.calls).toBe(3);
  });
});

// --- the API -------------------------------------------------------------------------------------------------------------

describe('generating a site', () => {
  it('says what is missing while the AI is off, and changes nothing', async () => {
    const s = (await t.api.get('/api/site-ai/status')).data;
    expect(s.ready).toBe(false);
    expect(s.reason).toContain('aus');
    expect(s.options.page_types).toEqual(['landing', 'funnel', 'website']);
    expect(s.commands.map((c: any) => c.id)).toEqual(expect.arrayContaining(['shorter', 'faq', 'du']));
    const r = await t.api.post('/api/site-ai/generate', { brief: { business: 'Malerbetrieb Meier', offer: 'Innenanstrich in Köln' } });
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
    expect((await t.api.get('/api/site-ai/runs')).data).toEqual([]);
  });

  it('estimates the cost on the sub-account’s model', async () => {
    expect((await t.api.put('/api/ai/settings', { api_key: KEY, enabled: true, monthly_limit_usd: 20 })).status).toBe(200);
    const s = (await t.api.get('/api/site-ai/status')).data;
    expect(s).toMatchObject({ ready: true, provider: { label: 'Claude', model: 'claude-sonnet-5-5', byok: false } });
    const e = (await t.api.post('/api/site-ai/estimate', { brief: { page_type: 'website', business: 'x' } })).data;
    expect(e.usd).toBeGreaterThan(0.01);
    expect(e.usd).toBeLessThan(1);
    expect(e).toMatchObject({ fits: true, problem: null, model: { model: 'claude-sonnet-5-5' } });
    const small = (await t.api.post('/api/site-ai/estimate', { brief: { page_type: 'landing', business: 'x' } })).data;
    expect(small.usd).toBeLessThan(e.usd);
  });

  it('plans, writes the pages, retries with the errors and stores the run', async () => {
    const broken = { pages: [{ ...START, sections: [{ name: 'Hero', layout: '1', columns: [[{ type: 'hero', heading: 'X', button_url: 'page:preise' }, { type: 'image', src: 'https://x.de/a.png' }]] }] }, DANKE] };
    queue = [JSON.stringify(PLAN), `Hier ist die Seite:\n${JSON.stringify(broken)}`, '```json\n' + JSON.stringify(PAGES) + '\n```'];
    const r = await t.api.post('/api/site-ai/generate', { brief: { business: 'Malerbetrieb Meier, Köln', offer: 'Innenanstrich', audience: 'Eigentümer', tone: 'freundlich', language: 'de', page_type: 'landing', goal: 'leads' } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ mode: 'site', attempts: 3, plan: { site_name: 'Malerbetrieb Meier', style: 'handwerk' } });
    expect(r.data.pages.map((p: any) => p.slug)).toEqual(['start', 'danke']);
    expect(r.data.pages[0].sections).toEqual(['Hero', 'FAQ', 'Kontakt']);
    expect(r.data.notes.join(' ')).toContain('Formular');
    expect(r.data.cost_usd).toBeGreaterThan(0);
    expect(calls).toHaveLength(3);
    // stage 1 gets the brief and the designs, stage 2 the catalogue (only registry blocks), the plan and the account
    expect(systemText(0)).toContain('SEITENPLAN');
    expect(systemText(0)).toContain('handwerk = Handwerksbetrieb');
    expect(systemText(1)).toContain('- faq · FAQ');
    expect(systemText(1)).not.toContain('- image');
    expect(systemText(1)).toContain('Formulare (form_id): keine vorhanden');
    expect(calls[1].body.messages[0].content).toContain('1. start „Start“');
    expect(calls[1].body.messages[0].content).toContain('Sprich Besucher mit „du“ an');
    // the retry names the problems
    expect(lastUser()).toContain('DEINE LETZTE ANTWORT WAR NICHT GÜLTIG');
    expect(lastUser()).toContain('die es im Plan nicht gibt');
    expect(lastUser()).toContain('unbekannter Block-Typ „image“');
    // logged under its own purpose
    const usage = (await t.api.get('/api/ai/usage')).data;
    expect(usage.purposes.site_builder).toBe('Funnel & Website AI');
    expect(usage.recent.filter((x: any) => x.purpose === 'site_builder')).toHaveLength(3);
    const runs = (await t.api.get('/api/site-ai/runs')).data;
    expect(runs[0]).toMatchObject({ id: r.data.run_id, mode: 'site', status: 'ok', name: 'Malerbetrieb Meier' });
  });

  it('gives up after three failed attempts without storing anything', async () => {
    const before = (await t.api.get('/api/site-ai/runs')).data.length;
    queue = [JSON.stringify(PLAN), '{"pages": []}', 'kein json', '{"pages": [{"slug": "start"}]}'];
    const r = await t.api.post('/api/site-ai/generate', { brief: { business: 'Malerbetrieb Meier', offer: 'Innenanstrich', page_type: 'landing' } });
    expect(r.status).toBe(422);
    expect(r.data.error).toContain('nach 3 Versuchen');
    expect((await t.api.get('/api/site-ai/runs')).data.length).toBe(before);
  });

  it('shows the proposal as a preview in the chosen design', async () => {
    const run = (await t.api.get('/api/site-ai/runs')).data[0];
    const res = await t.api.raw(`/api/site-ai/runs/${run.id}/preview?page=start`, { headers: { cookie: t.api.cookie, 'x-location-id': A } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    const h = await res.text();
    expect(h).toContain('Frische Wände in Köln');
    expect(h).toContain('Vorschau – hier erscheint dein Formular.');
    expect(h).toContain('id="formular"');
  });

  it('applies as an unpublished draft with form, legal pages and links wired – then publishes', async () => {
    const run = (await t.api.get('/api/site-ai/runs')).data[0];
    const r = await t.api.post(`/api/site-ai/runs/${run.id}/apply`, {});
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ draft: true, wiring: { form_created: true } });
    expect(r.data.pages.map((p: any) => p.slug)).toEqual(['start', 'danke', 'impressum', 'datenschutz']);
    expect(r.data.notes.join(' ')).toContain('Firmendaten');
    expect((await t.api.post(`/api/site-ai/runs/${run.id}/apply`, {})).status).toBe(409);
    const f = (await t.api.get(`/api/funnels/${r.data.funnel_id}`)).data;
    expect(f.kind).toBe('funnel');
    expect(f.settings.tokens.colors.brand).toBeTruthy();
    const start = f.pages.find((p: any) => p.slug === 'start');
    const danke = f.pages.find((p: any) => p.slug === 'danke');
    const flat = JSON.stringify(start.blocks);
    expect(flat).toContain(`"form_id":"${r.data.wiring.form_id}"`);
    expect(JSON.stringify(danke.blocks)).toContain(`"url":"page:${start.id}"`);
    const form = (await t.api.get(`/api/forms/${r.data.wiring.form_id}`)).data;
    expect(form.settings.redirect_url).toContain('/danke');
    // not public while it is a draft – every path, sitemap included
    expect((await t.api.raw(`/p/${f.slug}`)).status).toBe(404);
    expect((await t.api.raw(`/p/${f.slug}/danke`)).status).toBe(404);
    expect((await t.api.raw(`/p/${f.slug}/sitemap.xml`)).status).toBe(404);
    expect((await t.api.get(`/api/site-ai/drafts/${f.id}`)).data).toMatchObject({ draft: true, ai: true });
    expect((await t.api.get('/api/site-ai/drafts')).data.map((d: any) => d.funnel_id)).toContain(f.id);
    // the editor's preview works for the draft
    expect((await t.api.post(`/api/funnel-pages/${start.id}/preview`, {})).status).toBe(200);
    expect((await inLoc(B, () => t.api.post(`/api/site-ai/drafts/${f.id}/publish`, {}))).status).toBe(404);
    expect((await t.api.post(`/api/site-ai/drafts/${f.id}/publish`, {})).data).toMatchObject({ published: true });
    expect((await t.api.post(`/api/site-ai/drafts/${f.id}/publish`, {})).status).toBe(409);
    const live = await t.api.raw(`/p/${f.slug}`);
    expect(live.status).toBe(200);
    expect(await live.text()).toContain('Frische Wände in Köln');
  });

  it('respects the monthly limit before asking', async () => {
    await t.api.put('/api/ai/settings', { monthly_limit_usd: 0.01 });
    const r = await t.api.post('/api/site-ai/generate', { brief: { business: 'Malerbetrieb Meier', offer: 'Innenanstrich', page_type: 'website' } });
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/Monatslimit/);
    expect(calls).toHaveLength(0);
    await t.api.put('/api/ai/settings', { monthly_limit_usd: 20 });
  });
});

describe('the builder panel: page and section commands with restore points', () => {
  let funnelId = '';
  let pageId = '';
  let blocks: any[] = [];
  beforeAll(async () => {
    const f = (await t.api.post('/api/funnels', { name: 'Panel-Test', kind: 'funnel', template: 'blank' })).data;
    funnelId = f.id;
    pageId = f.pages[0].id;
  });

  it('writes an empty page from a prompt, proposes it with a diff and applies it into the editor after a restore point', async () => {
    queue = [JSON.stringify({ sections: START.sections, summary: 'Landingpage geschrieben' })];
    const r = await t.api.post('/api/site-ai/page', { page_id: pageId, prompt: 'Landingpage für Innenanstrich in Köln', brief: { address: 'du', language: 'de' }, current_blocks: [] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.diff.counts).toMatchObject({ new: 3 });
    expect(lastUser()).toContain('SEITE: start');
    // nothing saved yet
    expect((await t.api.get(`/api/funnels/${funnelId}`)).data.pages[0].blocks[0].type).toBe('hero');
    const editorState = [{ id: 'old1', type: 'hero', heading: 'Überschrift' }];
    const ap = await t.api.post(`/api/site-ai/runs/${r.data.run_id}/apply`, { current_blocks: editorState });
    expect(ap.status, JSON.stringify(ap.data)).toBe(200);
    expect(ap.data.blocks).toHaveLength(3);
    expect(ap.data.restore_point_id).toBeTruthy();
    blocks = ap.data.blocks;
    // still not saved: the editor shows it as unsaved changes
    expect((await t.api.get(`/api/funnels/${funnelId}`)).data.pages[0].blocks[0].heading).toBe('Überschrift');
    const points = (await t.api.get(`/api/site-ai/restore-points?page_id=${pageId}`)).data;
    expect(points[0]).toMatchObject({ id: ap.data.restore_point_id, blocks_count: 1, label: 'Vor KI-Seitenentwurf' });
    const back = (await t.api.post(`/api/site-ai/restore-points/${ap.data.restore_point_id}/restore`, {})).data;
    expect(back.blocks[0]).toMatchObject({ id: 'old1', heading: 'Überschrift' });
    await t.api.patch(`/api/funnel-pages/${pageId}`, { blocks });
  });

  it('section command „kürzer“: merged into the section, styling kept, restore point, undo by restore + save', async () => {
    const faq = blocks.find((b) => b.name === 'FAQ');
    faq.rows[0].cols[0].blocks[0].bg = '#fef3c7';
    await t.api.patch(`/api/funnel-pages/${pageId}`, { blocks });
    const faqBlock = faq.rows[0].cols[0].blocks[0];
    queue = [
      (body) => {
        const sent = body.messages[0].content as string;
        expect(sent).toContain('>> FAQ');
        expect(sent).toContain(faq.id);
        expect(sent).not.toContain('fef3c7');
        return JSON.stringify({ summary: 'Gekürzt', sections: [{ id: faq.id, name: 'FAQ', rows: [{ layout: '1', columns: [[{ id: faqBlock.id, type: 'faq', heading: 'Fragen', items: [{ q: 'Kosten?', a: 'Auf Anfrage.' }, { q: 'Dauer?', a: '1–2 Tage.' }] }]] }] }] });
      },
    ];
    const r = await t.api.post('/api/site-ai/section', { page_id: pageId, section_id: faq.id, command: 'shorter', current_blocks: blocks });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.diff.counts).toMatchObject({ changed: 1, same: 2 });
    const ap = (await t.api.post(`/api/site-ai/runs/${r.data.run_id}/apply`, { current_blocks: blocks })).data;
    const newFaq = ap.blocks.find((b: any) => b.id === faq.id).rows[0].cols[0].blocks[0];
    expect(newFaq).toMatchObject({ id: faqBlock.id, heading: 'Fragen', bg: '#fef3c7' });
    await t.api.patch(`/api/funnel-pages/${pageId}`, { blocks: ap.blocks });
    // the restore point brings the long FAQ back, saved right away on request
    const back = (await t.api.post(`/api/site-ai/restore-points/${ap.restore_point_id}/restore`, { save: true })).data;
    expect(back.saved).toBe(true);
    const saved = (await t.api.get(`/api/funnels/${funnelId}`)).data.pages[0].blocks;
    expect(JSON.stringify(saved)).toContain('Häufige Fragen');
    blocks = saved;
  });

  it('section command „FAQ hinzufügen“ keeps the section and inserts a new one; an invented id is sent back', async () => {
    const hero = blocks[0];
    const faqSection = { name: 'FAQ', style: 'soft', layout: '1', columns: [[{ type: 'faq', heading: 'Noch Fragen?', items: [{ q: 'A?', a: 'B.' }, { q: 'C?', a: 'D.' }] }]] };
    queue = [JSON.stringify({ sections: [{ id: 'erfunden', keep: true }, faqSection] }), JSON.stringify({ sections: [{ id: hero.id, keep: true }, faqSection], summary: 'FAQ ergänzt' })];
    const r = await t.api.post('/api/site-ai/section', { page_id: pageId, section_id: hero.id, command: 'faq', current_blocks: blocks });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.attempts).toBe(2);
    expect(lastUser()).toContain('Abschnitt „erfunden“ gibt es auf der Seite nicht');
    expect(r.data.blocks[0]).toEqual(hero);
    expect(r.data.blocks[1]).toMatchObject({ type: 'section', name: 'FAQ', bg: 'token:surface' });
    expect(r.data.diff.counts).toMatchObject({ new: 1 });
    // a second hero would mean two H1s
    queue = [JSON.stringify({ sections: [{ id: hero.id, keep: true }, { name: 'Hero 2', layout: '1', columns: [[{ type: 'hero', heading: 'Noch ein Hero' }]] }] }), JSON.stringify({ sections: [{ id: hero.id, keep: true }] })];
    const r2 = await t.api.post('/api/site-ai/section', { page_id: pageId, section_id: hero.id, prompt: 'Füge einen zweiten Hero hinzu', current_blocks: blocks });
    expect(r2.status).toBe(200);
    expect(lastUser()).toContain('mehr als eine H1');
    // a section that is gone by the time of applying
    const ap = await t.api.post(`/api/site-ai/runs/${r.data.run_id}/apply`, { current_blocks: blocks.slice(1) });
    expect(ap.status).toBe(409);
  });

  it('refuses commands without a section, and pages of another sub-account', async () => {
    expect((await t.api.post('/api/site-ai/section', { page_id: pageId, section_id: 'nope', command: 'shorter', current_blocks: blocks })).status).toBe(400);
    expect((await inLoc(B, () => t.api.post('/api/site-ai/section', { page_id: pageId, section_id: blocks[0].id, command: 'shorter' }))).status).toBe(404);
    expect((await inLoc(B, () => t.api.post('/api/site-ai/page', { page_id: pageId, prompt: 'Neu schreiben bitte' }))).status).toBe(404);
  });
});

describe('isolation between sub-accounts', () => {
  it('runs, previews, applies and restore points stay in their sub-account', async () => {
    const run = (await t.api.get('/api/site-ai/runs')).data[0];
    const points = (await t.api.get('/api/site-ai/runs?limit=5')).data;
    expect(points.length).toBeGreaterThan(0);
    await inLoc(B, async () => {
      expect((await t.api.get('/api/site-ai/runs')).data).toEqual([]);
      expect((await t.api.get(`/api/site-ai/runs/${run.id}`)).status).toBe(404);
      expect((await t.api.post(`/api/site-ai/runs/${run.id}/apply`, {})).status).toBe(404);
      expect((await t.api.get(`/api/site-ai/runs/${run.id}/preview`)).status).toBe(404);
      expect((await t.api.get('/api/site-ai/drafts')).data).toEqual([]);
    });
    const p = t.app.db.get<{ id: string }>('SELECT id FROM site_ai_restore_points WHERE location_id = ? LIMIT 1', A)!;
    await inLoc(B, async () => {
      expect((await t.api.get(`/api/site-ai/restore-points/${p.id}`)).status).toBe(404);
      expect((await t.api.post(`/api/site-ai/restore-points/${p.id}/restore`, { save: true })).status).toBe(404);
    });
  });
});

describe('BYOK: the use „Funnel & Website AI“', () => {
  it('routes the site AI to its own connection while quick texts keep theirs', async () => {
    const usages = (await t.api.get('/api/ai-connections/presets')).data.usages;
    expect(usages.find((u: any) => u.id === 'sites')).toMatchObject({ label: expect.stringContaining('Website'), capability: 'text' });
    const conn = (await t.api.post('/api/ai-connections', { provider: 'openrouter', label: 'Sites', api_key: 'sk-or-v1-sites-key-abcdef123456', models: { text: 'anthropic/claude-opus-5.5' } })).data;
    await t.api.put('/api/ai-connections/routing', { usage: 'sites', connection_id: conn.id });
    const s = (await t.api.get('/api/site-ai/status')).data;
    expect(s.provider).toMatchObject({ label: 'Sites', model: 'anthropic/claude-opus-5.5', byok: true });
    const reply = (text: string) => jsonReply({ id: 'r', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5000, completion_tokens: 2000 } });
    net.reply(reply(JSON.stringify(PLAN)), reply(JSON.stringify(PAGES)));
    const r = await t.api.post('/api/site-ai/generate', { brief: { business: 'Malerbetrieb Meier', offer: 'Innenanstrich', page_type: 'landing' } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(net.calls).toHaveLength(2);
    expect(net.calls[0].url).toContain('openrouter.ai');
    expect(net.calls[0].body.model).toBe('anthropic/claude-opus-5.5');
    expect(calls).toHaveLength(0);
    expect(r.data.cost_usd).toBeGreaterThan(0);
    await t.api.put('/api/ai-connections/routing', { usage: 'sites', connection_id: '' });
  });
});

describe('MCP tool ghl_site_generate and the HyperLevel Agent', () => {
  it('previews, and only creates a draft when asked', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'Site AI' })).data.key;
    const rpc = async (method: string, params: unknown) => (await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
    const tools = await rpc('tools/list', {});
    const tool = tools.result.tools.find((x: any) => x.name === 'ghl_site_generate');
    expect(tool.inputSchema.required).toEqual(['location_id', 'prompt']);
    expect(t.app.services.mcpTools.find((x: any) => x.name === 'ghl_site_generate').klassFor({})).toBe('write');
    const funnels0 = (await t.api.get('/api/funnels')).data.length;
    queue = [JSON.stringify(PLAN), JSON.stringify(PAGES)];
    const prev = await rpc('tools/call', { name: 'ghl_site_generate', arguments: { location_id: A, prompt: 'Landingpage für meinen Malerbetrieb in Köln', page_type: 'landing', goal: 'leads' } });
    const p = JSON.parse(prev.result.content[0].text);
    expect(p).toMatchObject({ site_name: 'Malerbetrieb Meier', applied: null });
    expect(p.pages.map((x: any) => x.slug)).toEqual(['start', 'danke']);
    expect((await t.api.get('/api/funnels')).data.length).toBe(funnels0);
    queue = [JSON.stringify(PLAN), JSON.stringify(PAGES)];
    const done = JSON.parse((await rpc('tools/call', { name: 'ghl_site_generate', arguments: { location_id: A, prompt: 'Landingpage für meinen Malerbetrieb in Köln', apply: true } })).result.content[0].text);
    expect(done.applied).toMatchObject({ draft: true });
    expect((await t.api.raw(new URL(done.applied.url).pathname)).status).toBe(404);
    // the agent knows when to use it
    const hint = (t.app.services.agentPromptExtras as any[]).map((f) => f({ automatic: false, user: { id: 'u1', role: 'admin', locations: [A] }, locationId: A })).join('\n');
    expect(hint).toContain('ghl_site_generate');
  });
});

describe('AI writer for blog posts and e-mail text blocks', () => {
  it('writes a blog post and an e-mail text through the same service', async () => {
    queue = [JSON.stringify({ title: 'Wände streichen im Herbst', excerpt: 'Worauf du achten solltest.', markdown: '## Warum jetzt?\n\nIm Herbst trocknet Farbe langsamer – plane [Zeitraum] ein.\n\n- Lüften\n- Abdecken' })];
    const blog = await t.api.post('/api/site-ai/write', { kind: 'blog', topic: 'Wände streichen im Herbst', length: 'kurz' });
    expect(blog.status, JSON.stringify(blog.data)).toBe(200);
    expect(blog.data).toMatchObject({ kind: 'blog', title: 'Wände streichen im Herbst' });
    expect(blog.data.text).toContain('## Warum jetzt?');
    expect(systemText()).toContain('Blog-Beitrag');
    queue = [JSON.stringify({ text: 'Hallo {{contact.first_name|du}},\n\ndanke für deine Anfrage. Wir melden uns innerhalb von [Zeitraum].' })];
    const mail = await t.api.post('/api/site-ai/write', { kind: 'email', topic: 'Danke für die Anfrage', address: 'du' });
    expect(mail.data.text).toContain('{{contact.first_name|du}}');
    expect(systemText()).toContain('Textblocks einer E-Mail');
    const usage = (await t.api.get('/api/ai/usage')).data;
    expect(usage.recent[0].purpose).toBe('site_writer');
    queue = ['{"text": "<p>zu kurz</p>"}', '{"text": "<div>x</div>"}', '{}'];
    expect((await t.api.post('/api/site-ai/write', { kind: 'email', topic: 'Test test test' })).status).toBe(422);
    expect((await t.api.post('/api/site-ai/write', { kind: 'blog' })).status).toBe(400);
  });
});
