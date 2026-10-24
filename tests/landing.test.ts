import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { CALC_DEFAULT, EUR_USD, HL_PRICES, calculate, parseCalc, shareLinks } from '../server/services/landing-calc.js';
import { OUR_ID, entryPriceEurCents, matrixHtml, mixTools, parseMatrix } from '../server/services/landing-compare.js';
import { COPY } from '../server/services/landing-copy.js';
import { parseStack, stackHtml, sumsText } from '../server/services/landing-stack.js';
import { CSP, SCRIPT, SCRIPT_HASH, pagePath } from '../server/services/landing-page.js';
import { ACADEMY, AGENTIC, type AgenticCopy } from '../server/services/landing-agentic-copy.js';
import { academySection, type AgenticCtx } from '../server/services/landing-agentic.js';
import { LOGOS, logosHtml } from '../server/services/landing-logos.js';
import { imageSize } from '../server/modules/landing.js';
import { CATALOG } from '../server/services/integrations-catalog.js';
import { GROUPS, JOURNEY, MODULE_TOURS } from '../web/src/tour/catalog';
import { checkDocument, checkFragment } from '../server/services/site-a11y.js';
import { escapeHtml as h } from '../server/core/template.js';
import { contrast } from '../server/services/site-style.js';
import { PLAN_INFO } from '../server/services/cloud.js';

const OURS = { solo: PLAN_INFO.solo.price_month_cents, team: PLAN_INFO.team.price_month_cents, agency: PLAN_INFO.agency.price_month_cents };

/** A research file in the agreed schema (the real one: web/public/landing/competitors.json). */
const FIXTURE = {
  as_of: '2026-10-09',
  vendors: [
    { id: 'ghl0', name: 'HyperLevel', url: 'https://gohyperlevel.com', pricing: [{ plan: 'Self-hosted', price_month: 0, currency: 'EUR' }], source: 'https://gohyperlevel.com' },
    { id: 'highlevel', name: 'HighLevel', url: 'https://www.gohighlevel.com', pricing: [{ plan: 'Starter', price_month: 97, currency: 'USD' }, { plan: 'Unlimited', price_month: 297, currency: 'USD' }], source: 'https://www.gohighlevel.com/pricing' },
    { id: 'hubspot', name: 'HubSpot', url: 'https://www.hubspot.com', pricing: [{ plan: 'Free', price_month: 0, currency: 'USD' }, { plan: 'Starter Customer Platform', price_month: 20, currency: 'USD', notes: 'per seat' }, { plan: 'Professional', price_month: 890, currency: 'USD' }], source: 'https://www.hubspot.com/pricing' },
    { id: 'kajabi', name: 'Kajabi', url: 'https://kajabi.com', pricing: [{ plan: 'Kickstarter', price_month: 89, currency: 'USD' }], source: 'https://kajabi.com/pricing' },
    { id: 'evil', name: '<script>', url: 'javascript:alert(1)', pricing: [], source: 'http://insecure.example' },
  ],
  categories: [
    {
      id: 'crm',
      label_de: 'CRM',
      label_en: 'CRM',
      features: [
        { id: 'pipelines', label_de: 'Pipelines', label_en: 'Pipelines', cells: { ghl0: { v: 'yes' }, highlevel: { v: 'yes' }, hubspot: { v: 'partial', note: 'Nur eine Pipeline im Starter', source: 'https://www.hubspot.com/pricing' }, kajabi: { v: 'no' } } },
        { id: 'apps', label_de: 'Mobile Apps', label_en: 'Mobile apps', cells: { ghl0: { v: 'partial', note: 'via PWA-Install (Android zusätzlich als APK), nicht in den App-Stores' }, highlevel: { v: 'yes' }, hubspot: { v: 'bogus' } } },
      ],
    },
    { id: 'bad id!', label_de: 'x', label_en: 'x', features: [{ id: 'x', label_de: 'x', label_en: 'x', cells: { highlevel: { v: 'yes' } } }] },
  ],
};

/** "Replaces your stack" research in the agreed schema (the real one: web/public/landing/replaces.json). */
const STACK = {
  as_of: '2026-10-09',
  rows: [
    { id: 'crm', label_de: 'CRM & Pipelines', label_en: 'CRM & pipelines', coverage: 'full', tools: [{ name: 'HubSpot', plan: 'Starter', price_month: 20, currency: 'USD', billing: 'per seat', source: 'https://www.hubspot.com/pricing' }, { name: 'Pipedrive', plan: 'Lite', price_month: 14, currency: 'USD', billing: 'per user', source: 'https://www.pipedrive.com/pricing' }], min_price: 14, min_currency: 'USD' },
    { id: 'email', label_de: 'E-Mail-Marketing', label_en: 'E-mail marketing', coverage: 'full', tools: [{ name: 'ActiveCampaign', plan: 'Starter', price_month: 19, currency: 'EUR', source: 'https://www.activecampaign.com/pricing' }], min_price: 19, min_currency: 'EUR' },
    { id: 'voice', label_de: 'KI-Telefonagent', label_en: 'AI phone agent', coverage: 'partial', coverage_note_de: 'Voice AI: nur eingehende Anrufe', coverage_note_en: 'Voice AI: inbound calls only', tools: [{ name: 'Bland<b>', plan: 'Build', price_month: 299, currency: 'USD', source: 'javascript:alert(1)' }], min_price: 299, min_currency: 'USD' },
    { id: 'mcp', label_de: 'MCP für Claude/Codex', label_en: 'MCP for Claude/Codex', coverage: 'unique', tools: [], min_price: null },
    { id: 'junk', label_de: '', coverage: 'full', tools: [] },
  ],
  excluded_rows: [],
  totals: { usd: 313, eur: 19 },
};

describe('landing: replaces your stack', () => {
  it('parses the research, sums per currency without converting, and renders chips, partial and unique rows', () => {
    const st = parseStack(STACK)!;
    expect(st.rows.map((r) => r.id)).toEqual(['crm', 'email', 'voice', 'mcp']);
    expect(st.sums).toEqual({ USD: 313, EUR: 19 });
    expect(st.converted).toBeUndefined();
    expect(sumsText(st, 'de-DE').replace(/\u00a0/g, ' ')).toBe('313 $ + 19 €');
    expect(st.rows[2].tools[0].source).toBe('');
    const out = stackHtml(st, COPY.de, 'de', 'HyperLevel').replace(/\u00a0/g, ' ');
    expect(out).toContain('<ul class="tchips"><li title="Starter · 20 $">HubSpot</li><li title="Lite · 14 $">Pipedrive</li></ul>');
    expect(out).toContain('title="Voice AI: nur eingehende Anrufe">◐ Teilweise');
    expect(out).toContain('★ Selbst hostbar nur bei HyperLevel');
    expect(out).toContain('Bland&lt;b&gt;');
    expect(out).toContain('<b>0 € <small>(selbst gehostet)</small></b><em>Cloud ab 49,99 €/Monat</em>');
    expect(out).not.toMatch(/<img/);
    expect(stackHtml(st, COPY.de, 'de', 'X', 2).match(/<tr class=/g)).toHaveLength(2);
    // Converted here, at the rate the research names – only with its source.
    const conv = parseStack({ ...STACK, totals: { fx_rate_usd_per_eur: 1.1206, fx_source: 'https://www.ecb.europa.eu/stats/eurofxref/' } })!;
    expect(conv.converted).toMatchObject({ eur: Math.round((313 / 1.1206 + 19) * 100) / 100, rate: 1.1206 });
    expect(conv.fullOnly).toMatchObject({ rows: 2, eur: Math.round((14 / 1.1206 + 19) * 100) / 100 });
    expect(parseStack({ ...STACK, totals: { fx_rate_usd_per_eur: 1.1206 } })!.converted).toBeUndefined();
    // A row marked in_total: false is shown but not counted.
    expect(parseStack({ ...STACK, rows: STACK.rows.map((r) => (r.id === 'voice' ? { ...r, in_total: false } : r)) })!.sums).toEqual({ USD: 14, EUR: 19 });
    expect(parseStack({ as_of: '2026-10-09', rows: [] })).toBeUndefined();
  });
});

describe('landing: the committed stack research', () => {
  it('parses, has a sourced ECB total, no Office row and the MCP row as unique', async () => {
    const { readFileSync } = await import('node:fs');
    const st = parseStack(JSON.parse(readFileSync('web/public/landing/replaces.json', 'utf8')))!;
    expect(st.rows.length).toBeGreaterThan(20);
    expect(st.rows.find((r) => r.id === 'office')).toBeUndefined();
    expect(st.rows.find((r) => r.id === 'mcp_server')?.coverage).toBe('unique');
    expect(st.rows.find((r) => r.id === 'ai_chat_content')?.tools.map((t) => t.name)).not.toContain('ChatGPT');
    expect(st.converted?.source).toMatch(/^https:\/\/www\.ecb\.europa\.eu\//);
    for (const r of st.rows) for (const t of r.tools) if (t.price !== null) expect(t.source, `${r.id}/${t.name}`).toMatch(/^https:\/\//);
    // the converted total is the per-currency sums at the stated rate, and matches what the file states after the corrections
    const raw = JSON.parse(readFileSync('web/public/landing/replaces.json', 'utf8'));
    expect(st.converted!.eur).toBeCloseTo((st.sums.USD ?? 0) / st.converted!.rate + (st.sums.EUR ?? 0), 1);
    expect(st.converted!.eur).toBeCloseTo(raw.totals.combined_eur_estimate, 1);
    expect(st.fullOnly!.eur).toBeCloseTo(raw.totals.full_coverage_only.combined_eur_estimate, 1);
    expect(st.rows.find((r) => r.id === 'ai_chat_content')?.in_total).toBe(false);
  });
});

describe('landing: the savings calculator', () => {
  it('compares against HighLevel list prices, converted at the ECB rate, and never claims SaaS mode in the cloud', () => {
    const r = calculate(CALC_DEFAULT, OURS);
    expect(r).toMatchObject({ hlPlan: 'unlimited', hlMonthUsd: 297, ourPlan: 'self', ourMonthCents: 0 });
    expect(r.saveYearEur).toBe(Math.round((297 * 12) / EUR_USD));
    // Starter has 3 sub-accounts: more bump the comparison to Unlimited.
    expect(calculate({ plan: 'starter', subs: 4, wlApp: false, hosting: 'self' }, OURS)).toMatchObject({ hlPlan: 'unlimited', hlBumped: true });
    expect(calculate({ plan: 'starter', subs: 3, wlApp: false, hosting: 'self' }, OURS)).toMatchObject({ hlPlan: 'starter', hlBumped: false, hlMonthUsd: 97 });
    // SaaS mode + white-label app = 994 $ a month; the cloud has no SaaS mode, so that falls back to self-hosting.
    const pro = calculate({ plan: 'pro', subs: 5, wlApp: true, hosting: 'cloud' }, OURS);
    expect(pro).toMatchObject({ hlMonthUsd: HL_PRICES.pro + HL_PRICES.wlApp, saasSelfOnly: true, ourPlan: 'self' });
    expect(pro.hlMonthUsd).toBe(994);
    // Several sub-accounts or a branded app in the cloud: the Agentur plan (white-label + client accounts).
    expect(calculate({ plan: 'unlimited', subs: 2, wlApp: false, hosting: 'cloud' }, OURS)).toMatchObject({ ourPlan: 'agency', ourMonthCents: 19900, saveYearEur: Math.round((297 * 12) / EUR_USD) - 2388 });
    expect(calculate({ plan: 'starter', subs: 1, wlApp: false, hosting: 'cloud' }, OURS)).toMatchObject({ ourPlan: 'team' });
  });

  it('reads its input from the shared link and clamps anything odd', () => {
    expect(parseCalc(new URLSearchParams('p=pro&n=7&app=1&h=cloud'))).toEqual({ plan: 'pro', subs: 7, wlApp: true, hosting: 'cloud' });
    expect(parseCalc(new URLSearchParams('p=<x>&n=99999&app=yes&h=moon'))).toEqual({ plan: 'unlimited', subs: 100, wlApp: false, hosting: 'self' });
    expect(parseCalc(new URLSearchParams('n=-3'))).toMatchObject({ subs: 1 });
    const s = shareLinks('https://gohyperlevel.com/?p=pro&n=2#rechner', 'I save €1 & more');
    expect(s.x).toBe('https://x.com/intent/post?text=I%20save%20%E2%82%AC1%20%26%20more&url=https%3A%2F%2Fgohyperlevel.com%2F%3Fp%3Dpro%26n%3D2%23rechner');
    expect(s.linkedin.startsWith('https://www.linkedin.com/sharing/share-offsite/?url=')).toBe(true);
    expect(s.reddit).toContain('https://www.reddit.com/submit?url=');
  });
});

describe('landing: the comparison research', () => {
  it('validates the file: renames our column, drops bad ids, values, links and empty categories', () => {
    const m = parseMatrix(FIXTURE)!;
    expect(m.vendors.map((v) => v.id)).toEqual([OUR_ID, 'highlevel', 'hubspot', 'kajabi', 'evil']);
    expect(m.vendors.find((v) => v.id === 'evil')).toMatchObject({ url: '', source: '' });
    expect(m.categories.map((c) => c.id)).toEqual(['crm']);
    expect(m.categories[0].features[1].cells).not.toHaveProperty('hubspot');
    expect(m.categories[0].features[1].cells[OUR_ID]).toMatchObject({ v: 'partial' });
    expect(parseMatrix({ as_of: 'gestern', vendors: [], categories: [] })).toBeUndefined();
    expect(parseMatrix('x')).toBeUndefined();
  });

  it('builds the tool mix from entry prices (paid plans, the named plan, dollars converted)', () => {
    const m = parseMatrix(FIXTURE)!;
    expect(entryPriceEurCents(m.vendors.find((v) => v.id === 'hubspot')!, /starter/i)).toBe(Math.round((20 / EUR_USD) * 100));
    const mix = mixTools(m);
    expect(mix.map((t) => t.key)).toEqual(['crm', 'courses']);
    expect(mix[0]).toMatchObject({ vendor: 'HubSpot', plan: 'Starter Customer Platform' });
  });

  it('renders the matrix accessibly: escaped, sticky header, a footnote per note, sources, disclaimer', () => {
    const c = COPY.de;
    const out = matrixHtml(parseMatrix(FIXTURE), c, 'de', 'HyperLevel');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('<thead>');
    expect(out).toContain('title="teilweise: Nur eine Pipeline im Starter"');
    expect(out).toContain('nicht in den App-Stores');
    // A competitor "no" without a note is "nicht ausgewiesen", ours stays an honest ✗.
    expect(out).toContain('<td class="v-unlisted"');
    const full = matrixHtml(parseMatrix(FIXTURE), c, 'de', 'HyperLevel', { full: true });
    expect(full).toContain('<small class="cn"><a href="https://www.hubspot.com/pricing" rel="noopener nofollow">Nur eine Pipeline im Starter</a></small>');
    expect(out).toContain('nicht mit HighLevel Inc. oder den anderen genannten Anbietern verbunden');
    expect(checkFragment({ html: out }).filter((i) => i.level !== 'info')).toEqual([]);
    expect(matrixHtml(undefined, c, 'de', 'X')).toContain(c.matrix.empty);
  });
});

describe('landing: the committed research file', () => {
  it('parses, keeps every competitor cell sourced, and says what we do not have', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = JSON.parse(readFileSync('web/public/landing/competitors.json', 'utf8'));
    const m = parseMatrix(raw)!;
    expect(m.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.vendors[0].id).toBe(OUR_ID);
    expect(m.vendors.length).toBeGreaterThanOrEqual(10);
    expect(m.vendors.map((v) => v.id)).toContain('highlevel');
    const features = m.categories.flatMap((c) => c.features);
    expect(features.length).toBeGreaterThan(50);
    for (const f of features) for (const [id, cell] of Object.entries(f.cells)) if (id !== OUR_ID) expect(cell.source, `${f.id}/${id}`).toMatch(/^https:\/\//);
    // Where we lose, the matrix says so; SaaS mode is not part of the cloud.
    const ours = (id: string) => features.find((f) => f.id === id)?.cells[OUR_ID];
    expect(ours('hosted_phone')?.v).toBe('no');
    // …and what exists since the research was made says so too (checked against the code on 2026-10-22)
    expect(ours('office_suite')).toMatchObject({ v: 'partial', note: expect.stringMatching(/optional/) });
    expect(ours('storefront_cart')?.v).toBe('yes');
    expect(ours('payment_gateways')?.note).toMatch(/PayPal.*Mollie/);
    for (const id of ['pipelines', 'funnels_websites', 'workflow_builder', 'calendar_booking']) expect(ours(id)?.note, id).not.toMatch(/in Kürze/);
    expect(ours('saas_mode')?.note).toMatch(/Cloud.*nicht enthalten/);
    expect(ours('ios_app')).toMatchObject({ v: 'partial', note: expect.stringMatching(/PWA.*nicht in den App-Stores/) });
    // USD prices stay USD.
    expect(m.vendors.find((v) => v.id === 'highlevel')!.pricing[0]).toMatchObject({ price_month: 97, currency: 'USD' });
  });
});

describe('landing: copy', () => {
  it('says the same prices, the white-label exception and no SaaS mode in the cloud, in both languages', () => {
    for (const c of Object.values(COPY)) {
      const all = JSON.stringify(c);
      expect(all).toMatch(/49[,.]99/);
      expect(all).toMatch(/99[,.]99/);
      expect(all).toMatch(/199/);
      expect(all).not.toMatch(/\b299\b|\b79 ?€|€79\b/);
      expect(c.pricing.lead).toMatch(/White-Label|white-label/);
      expect(c.wl.saas).toMatch(/SaaS/);
    }
    expect(COPY.en.hero.h1Tail).toBe('for agentic solopreneurs, agencies, small businesses & startups');
    expect(COPY.de.hero.h1Tail).toBe('für agentische Solopreneure, Agenturen, kleine Unternehmen und Startups');
    for (const c of Object.values(COPY)) {
      // one keyframe set for every language: the same number of rotating words, AI agents first
      expect(c.hero.rotate.length, c.lang).toBe(COPY.de.hero.rotate.length);
      expect(c.hero.rotate[0], c.lang).toMatch(/KI-Agenten|AI agents/);
      expect(c.hero.sub, c.lang).toContain('Jarvis');
      expect(c.features.items({ triggers: '1', actions: '2' }).length, c.lang).toBe(COPY.de.features.items({ triggers: '1', actions: '2' }).length);
    }
  });
});

/** A WebP header (VP8X) of the given size – enough for imageSize and the page. */
const webp = (w: number, h: number) => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8X', 8, 'ascii');
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
};

describe('landing: the agentic sections', () => {
  it('states the Academy as it is: chapters exactly, module tours and lessons never more than exist', () => {
    expect(ACADEMY.chapters).toBe(JOURNEY.length);
    const course = MODULE_TOURS.filter((t) => t.group === 'company');
    expect(ACADEMY.lessons).toBe(course.length);
    expect(ACADEMY.tours).toBeLessThanOrEqual(MODULE_TOURS.length - course.length);
    expect(ACADEMY.groups).toBe(GROUPS.filter((g) => g.id !== 'company').length);
    for (const a of Object.values(AGENTIC)) {
      const text = JSON.stringify(a) + a.usp.items({ tools: '1', themes: '2', iconPacks: '3' }).flat().join(' ');
      for (const m of text.matchAll(/(\d+)\+? (?:Kapitel|chapters)\b/g)) expect(Number(m[1])).toBe(JOURNEY.length);
      for (const m of text.matchAll(/(?:Über|more than) (\d+) (?:Modul-Touren|module tours)\b/gi)) expect(Number(m[1])).toBeLessThanOrEqual(MODULE_TOURS.length - course.length);
    }
  });

  it('has the same structure in German and English, and says the honest parts', () => {
    const shape = (a: AgenticCopy) => ({
      agents: a.ssot.agents.length,
      data: a.ssot.data.length,
      guards: a.ssot.guards.length,
      jarvis: a.jarvis.items.length,
      usp: a.usp.items({ tools: '1', themes: '2', iconPacks: '3' }).map(([k]) => k),
      academy: [a.academy.items.length, a.academy.stats.length],
      designs: a.designs.items({ tools: '1', themes: '2', iconPacks: '3' }).length,
      xr: a.xr.items.length,
      shots: Object.keys(a.shots).sort(),
    });
    expect(shape(AGENTIC.en)).toEqual(shape(AGENTIC.de));
    expect(shape(AGENTIC.en).usp).toHaveLength(9);
    // one source of truth, with what keeps it safe
    expect(AGENTIC.en.ssot.h2).toMatch(/single source of truth/);
    expect(AGENTIC.de.ssot.h2).toMatch(/einzige Quelle der Wahrheit/);
    for (const a of Object.values(AGENTIC)) {
      expect(a.ssot.agents).toEqual(expect.arrayContaining(['Claude', 'ChatGPT', 'Codex', 'Hermes']));
      expect(a.ssot.fine).toMatch(/MCP/);
      // own subscription: personal chats only, automations on API keys
      const key = a.usp.items({ tools: '1', themes: '2', iconPacks: '3' }).find(([k]) => k === 'key')![2];
      expect(key).toMatch(/Claude.Code/);
      expect(key).toMatch(/API/);
      // XR: beta, not tested on hardware, only devices the docs name
      expect(a.xr.note).toMatch(/Beta/);
      expect(a.xr.devices).toMatch(/Vision Pro.*Quest.*Android.XR.*Pico.*Wolvic.*Xreal.*Viture/);
      // "Built with Claude" as plain words only
      expect(a.builtWith).toMatch(/Claude$/);
    }
  });

  it('renders a spotlight with its picture only when the screenshot exists, and reads WebP and PNG sizes', () => {
    const x = (shots: AgenticCtx['shots']): AgenticCtx => ({ a: AGENTIC.en, shots, nums: { tools: '354', themes: '19', iconPacks: '6' }, gh: 'https://github.com/BAISESYSTEMS/GoHyperLevel' });
    const without = academySection(x([]));
    expect(without).toContain('class="spot nofig"');
    expect(without).not.toContain('<img');
    expect(without).toContain(`<b>${ACADEMY.chapters}</b>`);
    const withShot = academySection(x([{ key: 'academy', src: '/landing/shot-academy.webp', w: 1600, h: 1000 }]));
    expect(withShot).toContain('<figure class="spot-f" data-fig><img src="/landing/shot-academy.webp" width="1600" height="1000" alt="The Academy with its guided tours" loading="lazy" decoding="async" data-hide>');
    expect(checkFragment({ html: withShot }).filter((i) => i.level !== 'info')).toEqual([]);
    expect(imageSize(webp(1600, 1000))).toEqual({ w: 1600, h: 1000 });
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(1200, 16);
    png.writeUInt32BE(630, 20);
    expect(imageSize(png)).toEqual({ w: 1200, h: 630 });
    expect(imageSize(Buffer.from('not an image at all, really not'))).toBeNull();
    for (const f of readdirSync('web/public/landing').filter((n) => n.endsWith('.webp'))) expect(imageSize(readFileSync(`web/public/landing/${f}`)), f).not.toBeNull();
  });

  it('the page script hides a spotlight whose picture fails to load (also one that failed before the script ran)', () => {
    const early = { hidden: false };
    const late = { hidden: false };
    let onError: (() => void) | undefined;
    const imgs = [
      { complete: true, naturalWidth: 0, closest: () => early, addEventListener() {} },
      { complete: false, naturalWidth: 0, closest: () => late, addEventListener: (_t: string, f: () => void) => (onError = f) },
    ];
    const ctx = vm.createContext({ document: { querySelector: () => null, querySelectorAll: (q: string) => (q === 'img[data-hide]' ? imgs : []), getElementById: () => null }, JSON, navigator: {} });
    vm.runInContext(SCRIPT, ctx);
    expect(early.hidden).toBe(true);
    expect(late.hidden).toBe(false);
    onError!();
    expect(late.hidden).toBe(true);
  });

  it('the integrations row: real integrations only, no compared vendor, no AI lab logo, accessible and still', () => {
    const research = [JSON.parse(readFileSync('web/public/landing/competitors.json', 'utf8')), JSON.parse(readFileSync('web/public/landing/replaces.json', 'utf8'))];
    const compared = new Set<string>([...research[0].vendors.map((v: { name: string }) => v.name), ...research[1].rows.flatMap((r: { tools: { name: string }[] }) => r.tools.map((t) => t.name))].map((n) => n.toLowerCase()));
    expect(LOGOS.length).toBeGreaterThanOrEqual(20);
    for (const l of LOGOS) {
      expect(compared.has(l.name.toLowerCase()), `${l.name} is a vendor the page compares against`).toBe(false);
      expect(l.via).toMatch(/^(catalog:[a-z_]+|file:server\/[\w/.-]+\.ts#[a-z]+)$/);
      if (l.via.startsWith('file:')) {
        const [file, word] = l.via.slice(5).split('#');
        expect(existsSync(file), l.via).toBe(true);
        expect(readFileSync(file, 'utf8').toLowerCase(), l.via).toContain(word);
      }
      if (l.icon) {
        expect(l.icon.path, l.name).toMatch(/^[0-9A-Za-z.,\- ]+$/);
        expect(l.icon.hex).toMatch(/^#[0-9A-F]{6}$/i);
      }
    }
    // AI models are plain words – never a lab's mark
    for (const n of ['Claude', 'OpenAI', 'Gemini']) expect(LOGOS.find((l) => l.name === n)?.icon, n).toBeUndefined();
    expect(LOGOS.map((l) => l.name)).toEqual(expect.arrayContaining(['Claude', 'OpenAI', 'Gemini']));
    expect(LOGOS.some((l) => /anthropic|claude|openai/i.test(l.icon?.id ?? ''))).toBe(false);
    for (const lang of ['de', 'en'] as const) {
      const out = logosHtml(AGENTIC[lang].logos, 'https://github.com/BAISESYSTEMS/GoHyperLevel/blob/main/docs/integrations.md');
      expect(out).toContain(lang === 'de' ? 'Verbindet sich mit deinen Lieblings-Tools' : 'Integrates with your favorite tools');
      expect(out).toContain(lang === 'de' ? 'Marken ihrer Inhaber' : 'trademarks of their owners');
      // the list once for screen readers, its copy for the endless slide hidden from them
      expect(out.match(/<ul class="mq-t">/g)).toHaveLength(1);
      expect(out.match(/<ul class="mq-t" aria-hidden="true">/g)).toHaveLength(1);
      const symbols = [...out.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(symbols).size).toBe(symbols.length);
      for (const id of symbols) expect(out).toContain(`<use href="#${id}"/>`);
      expect(out).not.toMatch(/<img|https?:\/\/(?!github\.com)/);
      expect(checkFragment({ html: out }).filter((i) => i.level !== 'info')).toEqual([]);
    }
  });
});

/** Runs the page's inline script against a tiny DOM and returns what it wrote for a set of form values. */
function runScript(dataJson: string, values: Record<string, string[]>) {
  const els: Record<string, any> = {};
  const handlers: (() => void)[] = [];
  const form = { dataset: {} as Record<string, string>, classList: { add() {} }, addEventListener: (_t: string, fn: () => void) => handlers.push(fn), values };
  const el = (sel: string) => {
    if (sel === '#calc-data') return { textContent: dataJson };
    if (sel === '#calc') return form;
    return (els[sel] ??= { textContent: '', href: '' });
  };
  class FormData {
    constructor(private f: typeof form) {}
    get(k: string) {
      return this.f.values[k]?.[0] ?? null;
    }
    getAll(k: string) {
      return this.f.values[k] ?? [];
    }
  }
  const ctx = vm.createContext({ document: { querySelector: el, querySelectorAll: () => [], getElementById: () => null }, FormData, history: { replaceState() {} }, Intl, URLSearchParams, encodeURIComponent, navigator: {}, setTimeout, JSON, Math });
  vm.runInContext(SCRIPT, ctx);
  handlers[0]();
  return els;
}

describe('landing page (PGHL_LANDING=1)', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const prev = process.env.PGHL_LANDING;
  beforeAll(async () => {
    process.env.PGHL_LANDING = '1';
    t = await startTestApp();
    // Never ask the real GitHub API from a test: the public repository's star count would show up on the page.
    t.app.services.landingFetch = async () => new Response('not found', { status: 404 });
    await t.setup();
    const dir = join(t.app.config.webDir, 'landing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'competitors.json'), JSON.stringify(FIXTURE));
    writeFileSync(join(dir, 'replaces.json'), JSON.stringify(STACK));
  });
  afterAll(async () => {
    await t.close();
    if (prev === undefined) delete process.env.PGHL_LANDING;
    else process.env.PGHL_LANDING = prev;
  });
  const get = (p: string) => t.api.raw(p, { redirect: 'manual' });

  it('serves English at /, German at /de, the comparison pages – strict CSP, no cookie, nothing from third parties', async () => {
    for (const [p, lang] of [['/', 'en'], ['/de', 'de'], ['/vergleich', 'en'], ['/de/vergleich', 'de'], ['/vergleich/highlevel', 'en'], ['/de/vergleich/highlevel', 'de']] as const) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      const body = await r.text();
      expect(r.headers.get('content-security-policy'), p).toBe(CSP);
      expect(r.headers.get('set-cookie'), p).toBeNull();
      expect(body, p).toContain(`<html lang="${lang}">`);
      // No external script, style, font or image; the only script is the inline one the CSP allows by its hash.
      expect(body, p).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet|src="https?:|url\(https?:/i);
      const inline = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      expect(inline).toEqual([SCRIPT]);
      expect(`sha256-${createHash('sha256').update(inline[0]).digest('base64')}`).toBe(SCRIPT_HASH);
      expect(body, p).toContain(lang === 'de' ? 'nicht mit HighLevel Inc.' : 'not affiliated with HighLevel Inc.');
    }
    const home = await (await get('/')).text();
    expect(home).toContain('<h1 aria-label="Your platform for AI agents, sales &amp; CRM, funnels &amp; websites, email marketing, online courses, bookings, invoicing – for agentic solopreneurs, agencies, small businesses &amp; startups"><span aria-hidden="true">Your platform for<br><span class="rot"><span class="rot-in" style="--n:7"><b>AI agents</b>');
    expect(home).toContain('<b>invoicing</b><b>AI agents</b></span></span><span class="tail">for agentic solopreneurs, agencies, small businesses &amp; startups</span></span></h1>');
    expect(home).toMatch(/@keyframes rot\{0\.00%,10\.29%\{transform:translateY\(-0\.0%\)\}.*100%\{transform:translateY\(-87\.5%\)\}\}/);
    // the brand mark wherever the brand shows: header, footer, app downloads, favicon
    expect(home).toContain('<img class="mk" src="/icon.svg"');
    expect(home).toContain('<span class="fbrand"><img src="/icon.svg"');
    expect(home).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">');
    expect(home).toContain('<a class="dl" href="/app"><img class="appic" src="/icon.svg"');
    expect(home).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(home).toMatch(/<meta property="og:image" content="http:\/\/localhost\/landing\/og-en\.png">/);
    expect(home).toContain('<link rel="alternate" hreflang="de" href="http://localhost/de">');
    expect(home).toContain('codex mcp add gohyperlevel --url https://localhost/mcp');
    expect(home).toContain('curl -fsSL https://raw.githubusercontent.com/BAISESYSTEMS/GoHyperLevel/main/scripts/install.sh | bash');
    expect(home).toContain('https://demo.gohyperlevel.com');
    // Prices: list prices without cloud mode, VAT note, white-label headline of the Agentur plan.
    for (const s of ['€49.99', '€99.99', '€199', 'or €479 a year', 'or €959 a year', 'or €1,910 a year', 'Stripe Tax', 'White-label on the Agency plan']) expect(home, s).toContain(s);
    const de = await (await get('/de')).text();
    expect(de).toContain('<span aria-hidden="true">Deine Plattform für<br><span class="rot"><span class="rot-in" style="--n:7"><b>KI-Agenten</b>');
    expect(de).toContain('<span class="tail">für agentische Solopreneure, Agenturen, kleine Unternehmen und Startups</span></span></h1>');
    for (const s of ['49,99 €', '99,99 €', '199 €', 'zzgl. gesetzlicher USt.', 'Gehostet in Deutschland (Frankfurt am Main)']) expect(de.replace(/ /g, ' '), s).toContain(s);
    // The matrix from the research file, with the category chips' CSS in the head.
    expect(home).toContain('.cmpw:has(#cmp-c-crm:checked)');
    expect(home).toContain('<th scope="col" class="ours">HyperLevel</th>');
    // Replaces your stack, with the sources and the disclaimer under it.
    expect(home).toContain('Replaces your stack');
    expect(home).toContain('<a href="https://www.pipedrive.com/pricing" rel="noopener nofollow">Pipedrive</a>');
    expect(home).toContain('USD prices are not converted.');
  });

  it('passes the accessibility check (BFSG) and keeps the colour contrast', async () => {
    for (const p of ['/', '/de', '/vergleich/highlevel']) {
      const body = await (await get(p)).text();
      const issues = [...checkDocument(body), ...checkFragment({ html: body })].filter((i) => i.level !== 'info');
      expect(issues, p).toEqual([]);
    }
    // ink on paper, muted on paper, light on the dark hero, muted on dark, ink on the accent
    for (const [fg, bg] of [['#0b0d12', '#f6f5ef'], ['#545a66', '#f6f5ef'], ['#545a66', '#efede4'], ['#f4f4ef', '#0b0d12'], ['#aeb4c2', '#0b0d12'], ['#aeb4c2', '#151923'], ['#0b0d12', '#c8f031'], ['#c8f031', '#0b0d12'], ['#16794a', '#ffffff'], ['#a23b2a', '#ffffff'], ['#8a5a00', '#ffffff'], ['#ffe3ad', '#0a1430'], ['#f3c983', '#0a1430'], ['#dfe3ec', '#0a1430'], ['#aeb4c2', '#0a1430'], ['#0a1430', '#ffb547'], ['#8a5a00', '#fff1d6'], ['#545a66', '#ffffff']]) {
      expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('puts the result of a shared calculator link into the page and its social title – the live script computes the same', async () => {
    const body = await (await get('/?m=hl&p=pro&n=5&app=1&h=self')).text();
    const save = Math.round((994 * 12) / EUR_USD).toLocaleString('en-GB');
    expect(body).toContain(`<meta property="og:title" content="I save €${save} a year with HyperLevel instead of HighLevel`);
    expect(body).toContain(`You save €${save} a year.`);
    expect(body).toContain('https://x.com/intent/post?text=');
    // The script, fed the page's own data, writes the same number.
    const data = /<script type="application\/json" id="calc-data">([\s\S]*?)<\/script>/.exec(body)![1];
    for (const [q, v] of [
      ['m=hl&p=pro&n=5&app=1&h=self', { m: ['hl'], p: ['pro'], n: ['5'], app: ['1'], h: ['self'] }],
      ['m=hl&p=starter&n=12&app=0&h=cloud', { m: ['hl'], p: ['starter'], n: ['12'], h: ['cloud'] }],
      ['m=hl&p=unlimited&n=1&app=0&h=cloud', { m: ['hl'], p: ['unlimited'], n: ['1'], h: ['cloud'] }],
      ['m=mix&t=crm&t=courses&h=cloud', { m: ['mix'], t: ['crm', 'courses'], h: ['cloud'] }],
    ] as const) {
      const page = await (await get(`/?${q}`)).text();
      const server = /<p class="save" id="calc-save">([^<]*)<\/p>/.exec(page)![1].replace(/&amp;/g, '&');
      const els = runScript(data, v as unknown as Record<string, string[]>);
      expect(els['#calc-save'].textContent, q).toBe(server);
    }
    // Mix mode: the research file's prices.
    const mix = await (await get('/?m=mix&t=crm&t=courses&h=self')).text();
    expect(mix).toContain('Your 2 tools:');
  });

  it('shows live counts, hides the star count until GitHub answers, and the APK once uploaded', async () => {
    const body = await (await get('/')).text();
    const tools = t.app.services.landing.stats().tools;
    expect(tools).toBeGreaterThan(200);
    expect(body).toContain(`<b>${tools.toLocaleString('en-GB')}</b><span>MCP tools</span>`);
    expect(body).not.toMatch(/stars<\/span>/);
    t.app.services.landingFetch = async () => new Response(JSON.stringify({ stargazers_count: 1234 }), { headers: { 'content-type': 'application/json' } });
    await t.app.services.landing.refreshStars(true);
    expect(await (await get('/')).text()).toContain('1,234 stars');
    t.app.services.landingFetch = async () => new Response('rate limited', { status: 403 });
    await t.app.services.landing.refreshStars(true);
    expect(await (await get('/')).text()).toContain('1,234 stars');
    expect(await (await get('/')).text()).toContain('APK · coming soon');
  });

  it('leads with the agentic side: integrations under the hero, one source of truth, Jarvis, reasons, agents, Academy, designs, XR', async () => {
    for (const [p, lang] of [['/', 'en'], ['/de', 'de']] as const) {
      const body = await (await get(p)).text();
      const a = AGENTIC[lang];
      const at = (s: string) => {
        const i = body.indexOf(s);
        expect(i, `${p}: ${s}`).toBeGreaterThan(-1);
        return i;
      };
      // order of the page
      const order = ['<h1 aria-label=', 'class="logos"', 'class="proof"', 'id="agentisch"', 'id="jarvis"', 'id="warum"', 'id="ki-agenten"', 'id="akademie"', 'id="designs"', 'id="xr"', 'id="tool-stack"', 'id="rechner"', 'id="funktionen"', 'id="preise"', 'id="apps"', 'id="open-source"', 'id="installieren"', 'id="faq"'].map(at);
      expect([...order].sort((x, y) => x - y)).toEqual(order);
      expect(body).toContain(a.logos.h2);
      expect(body).toContain(h(a.ssot.h2));
      expect(body).toContain(h(a.jarvis.h2));
      expect(body.match(/<li class="card"><span class="usp-i">/g)).toHaveLength(9);
      expect(body).toContain(`<b>${ACADEMY.chapters}</b>`);
      expect(body).toContain('https://github.com/BAISESYSTEMS/GoHyperLevel/blob/main/CONTRIBUTING.md');
      expect(body).toContain('label%3A%22good+first+issue%22');
      expect(body).toContain(`· ${a.builtWith}</span>`);
      // live numbers: themes and icon packs from the appearance model, workflow counts like the catalogue
      expect(body).toContain(lang === 'de' ? '19 Themes' : '19 themes');
      expect(body).toContain(lang === 'de' ? '6 Icon-Pakete' : '6 icon packs');
    }
    const cat = (await t.api.get('/api/workflow-catalog')).data;
    const stats = t.app.services.landing.stats();
    expect({ triggers: stats.triggers, actions: stats.actions }).toEqual(cat.counts);
    const home = await (await get('/')).text();
    expect(home).toContain(`<b>${stats.triggers.toLocaleString('en-GB')}</b><span>workflow triggers</span>`);
    expect(home).toContain(`${stats.triggers} triggers and ${stats.actions} actions`);
    // the research notes never promise more MCP tools than there are
    for (const f of ['competitors.json', 'replaces.json']) for (const m of readFileSync(`web/public/landing/${f}`, 'utf8').matchAll(/(\d{3})\+ (?:Tools|Werkzeug|tools)/g)) expect(Number(m[1]), f).toBeLessThanOrEqual(stats.tools);
  });

  it('shows every integration logo only for something in the catalogue or the code', async () => {
    const keys = new Set([...CATALOG.map((e) => e.key), ...((t.app.services.catalogExtra as { entry: { key: string } }[]) ?? []).map((e) => e.entry.key)]);
    for (const l of LOGOS) if (l.via.startsWith('catalog:')) expect(keys.has(l.via.slice(8)), l.via).toBe(true);
  });

  it('puts the screenshots that exist into the hero and the spotlights, at their real size', async () => {
    const dir = join(t.app.config.webDir, 'landing');
    writeFileSync(join(dir, 'shot-jarvis.webp'), webp(1440, 900));
    writeFileSync(join(dir, 'shot-xr.webp'), webp(1600, 1000));
    const body = await (await get('/')).text();
    // Jarvis leads the hero's crossfade
    expect(body).toMatch(/<div class="stage"><img src="\/landing\/shot-jarvis\.webp" width="1440" height="900" alt="Focus mode with the Jarvis companion" fetchpriority="high"/);
    expect(body).toContain('<img src="/landing/shot-xr.webp" width="1600" height="1000" alt="HyperLevel in the spatial mode for XR headsets" loading="lazy" decoding="async" data-hide>');
    expect(body).toContain('id="xr" aria-labelledby="xr-h"><div class="wrap"><div class="spot">');
  });

  it('offers the Android app under its HyperLevel name once an APK is uploaded', async () => {
    const prev = t.app.services.mobileAppInfo;
    t.app.services.mobileAppInfo = () => ({ version_name: '1.0.3', size: 5 * 1024 * 1024, sha256: 'ab'.repeat(32) });
    try {
      const body = await (await get('/')).text();
      expect(body).toContain('<a class="dl" href="/downloads/hyperlevel.apk" download><img class="appic" src="/icon.svg"');
      expect(body).toContain('APK · v1.0.3 · 5.0 MB');
      expect(body).toContain('there is no native iOS app yet');
    } finally {
      t.app.services.mobileAppInfo = prev;
    }
  });

  it('stays the app on any other host, and adds the sitemap', async () => {
    const other = await new Promise<{ status: number; location?: string }>((res, rej) => {
      const u = new URL(t.base);
      request({ host: u.hostname, port: u.port, path: '/', headers: { host: 'crm.kunde.example' } }, (r) => {
        r.resume();
        res({ status: r.statusCode!, location: r.headers.location });
      })
        .on('error', rej)
        .end();
    });
    expect(other).toEqual({ status: 302, location: '/app' });
    const sm = await (await get('/sitemap.xml')).text();
    for (const k of ['home', 'compare', 'highlevel'] as const) for (const l of ['en', 'de'] as const) expect(sm).toContain(`<loc>http://localhost${pagePath(k, l)}</loc>`);
    expect(await (await get('/robots.txt')).text()).toContain('Sitemap: http://localhost/sitemap.xml');
    expect((await get('/en')).status).toBe(301);
  });
});

describe('landing page off (default)', () => {
  it('leaves / to the web app and adds no routes', async () => {
    const t = await startTestApp();
    try {
      expect(t.app.router.match('GET', '/')).toBeUndefined();
      expect(t.app.router.match('GET', '/vergleich')).toBeUndefined();
      expect(t.app.router.match('GET', '/sitemap.xml')).toBeUndefined();
      expect(await (await t.api.raw('/robots.txt')).text()).not.toContain('Sitemap:');
    } finally {
      await t.close();
    }
  });
});

describe('pricing: the fold-out feature comparison', () => {
  it('lists the same rows in both languages and matches the plans’ entitlements', async () => {
    const { PLAN_COMPARE_COPY, planCompare } = await import('../server/services/landing-plan-compare.js');
    const rows = (l: 'de' | 'en') => PLAN_COMPARE_COPY[l].groups.flatMap((g) => g.rows);
    expect(rows('en').length).toBe(rows('de').length);
    for (const l of ['de', 'en'] as const) {
      const r = rows(l);
      // white-label, client accounts, custom domains and the branded app: self-hosted and Agentur only
      const wl = r.filter((x) => /white-label|domain|kunden-sub|client sub|app mit|app with/i.test(x[0]));
      expect(wl.length, l).toBe(4);
      for (const x of wl) expect(x.slice(1), x[0]).toEqual(['y', 'n', 'n', 'y']);
      // the SaaS mode stays self-hosted
      const saas = r.find((x) => /SaaS/.test(x[0]))!;
      expect(saas.slice(1)).toEqual(['y', 'n', 'n', 'n']);
      // Solo is one user
      expect(r[0].slice(1)[1]).toBe('1');
    }
    const html = planCompare('en', ['Self-hosted', 'Cloud Solo', 'Cloud Team & Company', 'Cloud Agency']);
    expect(html).toMatch(/^<details class="pc"><summary>Compare every feature<\/summary>/);
    expect(html).toContain('<th scope="col" class="pc-wl">Cloud Agency</th>');
    expect(html).toContain('<span class="sr">not included</span>');
  });
});
