import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import {
  applyCmp,
  attributionConsent,
  bannerHtml,
  blockEmbeds,
  blockOwnerCode,
  classifyInline,
  classifyUrl,
  cleanCmp,
  cmpCookie,
  consentModeSnippet,
  consentSignals,
  parseChoice,
  DEFAULT_CMP,
  type BannerUrls,
  type BlockOptions,
} from '../server/services/cmp.js';

const none = { statistics: false, marketing: false, external_media: false };
const all = { statistics: true, marketing: true, external_media: true };
const opts = (granted = none, extra: Partial<BlockOptions> = {}): BlockOptions => ({ granted, selfHosts: ['crm.example.com'], unknown: 'block', allowLink: (c) => `/allow/${c}`, ...extra });

describe('what belongs to which category', () => {
  it('knows the common trackers, media and widgets, by host and path', () => {
    const c = (u: string) => classifyUrl(u, ['crm.example.com']);
    expect(c('https://www.googletagmanager.com/gtag/js?id=G-1')).toBe('statistics');
    expect(c('https://www.google-analytics.com/analytics.js')).toBe('statistics');
    expect(c('https://static.hotjar.com/c/hotjar-1.js')).toBe('statistics');
    expect(c('https://connect.facebook.net/en_US/fbevents.js')).toBe('marketing');
    expect(c('https://www.facebook.com/tr?id=1')).toBe('marketing');
    expect(c('https://www.facebook.com/plugins/like.php')).toBe('external_media');
    expect(c('https://analytics.tiktok.com/i18n/pixel/events.js')).toBe('marketing');
    expect(c('https://snap.licdn.com/li.lms-analytics/insight.min.js')).toBe('marketing');
    expect(c('https://www.youtube-nocookie.com/embed/abc')).toBe('external_media');
    expect(c('https://player.vimeo.com/video/1')).toBe('external_media');
    expect(c('https://www.google.com/maps/embed?pb=1')).toBe('external_media');
    expect(c('https://fonts.googleapis.com/css2?family=Inter')).toBe('external_media');
    expect(c('https://www.google.com/recaptcha/api.js')).toBe('external_media');
    expect(c('//connect.facebook.net/x.js')).toBe('marketing');
    expect(c('https://cdn.unknown-tool.example/widget.js')).toBe('unknown');
    // This site itself: never blocked.
    expect(c('https://crm.example.com/chat/widget.js')).toBeNull();
    expect(c('/chat/widget.js')).toBeNull();
    expect(c('data:text/plain,hi')).toBe('unknown');
  });

  it('recognises inline code by what it calls', () => {
    expect(classifyInline(`gtag('config','G-ABC123')`)).toBe('statistics');
    expect(classifyInline(`gtag('config','AW-123456')`)).toBe('marketing');
    expect(classifyInline(`fbq('init','123');fbq('track','PageView')`)).toBe('marketing');
    expect(classifyInline(`window.dataLayer=window.dataLayer||[]`)).toBe('statistics');
    expect(classifyInline(`_paq.push(['trackPageView'])`)).toBe('statistics');
    expect(classifyInline(`document.title='x'`)).toBeNull();
  });
});

describe('blocking the owner\'s code until consent', () => {
  const code = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST123"></script>
<script>window.dataLayer=window.dataLayer||[];gtag('config','G-TEST123');</script>
<script src="https://connect.facebook.net/en_US/fbevents.js"></script>
<script>fbq('init','111')</script>
<script data-category="necessary">window.ok=1</script>
<script src="/chat/widget.js"></script>
<script type="application/ld+json">{"@context":"https://schema.org"}</script>
<script src="https://cdn.unknown-tool.example/w.js"></script>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
<link rel="stylesheet" href="/own.css">
<img src="https://www.facebook.com/tr?id=1&ev=PageView" width="1" height="1" alt="">
<img src="https://cdn.example.org/photo.jpg" width="600" alt="Foto">
<noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=1&noscript=1"></noscript>`;

  it('turns scripts, stylesheets, pixels and no-script pixels inert – with type="text/plain" and data-category', () => {
    const r = blockOwnerCode(code, opts());
    const h = r.html;
    expect(h).toContain('<script async type="text/plain" data-category="statistics" data-src="https://www.googletagmanager.com/gtag/js?id=G-TEST123"></script>');
    expect(h).toMatch(/<script type="text\/plain" data-category="statistics">window\.dataLayer/);
    expect(h).toContain('type="text/plain" data-category="marketing" data-src="https://connect.facebook.net/en_US/fbevents.js"');
    expect(h).toMatch(/<script type="text\/plain" data-category="marketing">fbq\('init'/);
    // Nothing of it can load: no live src for a blocked third party.
    expect(h).not.toMatch(/<script[^>]*\ssrc="https:\/\/(www\.googletagmanager|connect\.facebook)/);
    // Explicitly necessary, first-party, data blocks and plain pictures stay.
    expect(h).toContain('<script data-category="necessary">window.ok=1</script>');
    expect(h).toContain('<script src="/chat/widget.js"></script>');
    expect(h).toContain('application/ld+json');
    expect(h).toContain('<link rel="stylesheet" href="/own.css">');
    expect(h).toContain('src="https://cdn.example.org/photo.jpg"');
    // Unknown third party: blocked as marketing.
    expect(h).toContain('data-category="marketing" data-src="https://cdn.unknown-tool.example/w.js"');
    // Fonts, pixel and the no-script pixel.
    expect(h).toContain('data-href="https://fonts.googleapis.com/css2?family=Inter"');
    expect(h).toContain('data-category="external_media"');
    expect(h).toMatch(/<img[^>]*data-src="https:\/\/www\.facebook\.com\/tr\?id=1&ev=PageView"/);
    expect(h).not.toMatch(/<img[^>]*\ssrc="https:\/\/www\.facebook/);
    expect(h).not.toContain('noscript');
    expect(r.blocked.map((b) => `${b.what}:${b.category}`)).toEqual(expect.arrayContaining(['script:statistics', 'script:marketing', 'link:external_media', 'img:marketing', 'noscript:marketing']));
  });

  it('switches on what the visitor allowed, per category', () => {
    const onlyStats = blockOwnerCode(code, opts({ ...none, statistics: true })).html;
    expect(onlyStats).toContain('<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST123"></script>');
    expect(onlyStats).toMatch(/<script>window\.dataLayer/);
    expect(onlyStats).toContain('type="text/plain" data-category="marketing" data-src="https://connect.facebook.net');
    expect(onlyStats).toContain('data-href="https://fonts.googleapis.com');
    const everything = blockOwnerCode(code, opts(all)).html;
    expect(everything).not.toContain('text/plain');
    expect(everything).not.toContain('data-src=');
    expect(everything).toContain('<script src="https://connect.facebook.net/en_US/fbevents.js"></script>');
    expect(everything).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">');
    expect(everything).toContain('<noscript>');
  });

  it('code the owner wrote as type="text/plain" data-category="…" runs once that category is allowed – and not before', () => {
    const mine = '<script type="text/plain" data-category="marketing" data-src="https://cdn.unknown-tool.example/w.js"></script><script type="text/plain" data-category="statistics">track()</script>';
    expect(blockOwnerCode(mine, opts()).html).toBe(mine);
    const on = blockOwnerCode(mine, opts({ ...none, marketing: true })).html;
    expect(on).toContain('<script src="https://cdn.unknown-tool.example/w.js"></script>');
    expect(on).toContain('type="text/plain" data-category="statistics">track()');
  });

  it('"unknown scripts" can be allowed instead of blocked', () => {
    const h = blockOwnerCode('<script src="https://cdn.unknown-tool.example/w.js"></script><script>doSomething()</script>', opts(none, { unknown: 'allow' })).html;
    expect(h).toBe('<script src="https://cdn.unknown-tool.example/w.js"></script><script>doSomething()</script>');
    const b = blockOwnerCode('<script>doSomething()</script>', opts()).html;
    expect(b).toBe('<script type="text/plain" data-category="marketing">doSomething()</script>');
  });

  it('frames of other sites become a placeholder with the way to allow them; our own frames stay', () => {
    const page = '<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/abc" allowfullscreen></iframe></div><iframe src="/book/termin?embed=1" style="width:100%"></iframe><iframe src="https://crm.example.com/f/x"></iframe>';
    const r = blockEmbeds(page, opts(none, { labels: { external_media: 'Externe Medien' } }));
    expect(r.html).not.toContain('<iframe src="https://www.youtube');
    expect(r.html).toContain('class="pghl-cmp-ph" data-category="external_media" data-src="https://www.youtube-nocookie.com/embed/abc"');
    expect(r.html).toContain('youtube-nocookie.com</strong>');
    expect(r.html).toContain('href="/allow/external_media"');
    expect(r.html).toContain('<iframe src="/book/termin?embed=1" style="width:100%"></iframe>');
    expect(r.html).toContain('<iframe src="https://crm.example.com/f/x"></iframe>');
    expect(r.blocked).toHaveLength(1);
    expect(blockEmbeds(page, opts({ ...none, external_media: true })).html).toBe(page);
  });
});

describe('the visitor\'s choice, Consent Mode and the banner', () => {
  it('reads and writes the cookie; an old version asks again', () => {
    const v = cmpCookie(3, { statistics: true, marketing: false, external_media: true }, 'abcdefghijklmnop');
    expect(v).toBe('v3.101.abcdefghijklmnop');
    expect(parseChoice(v, 3)).toEqual({ decided: true, stale: false, granted: { statistics: true, marketing: false, external_media: true }, cid: 'abcdefghijklmnop' });
    expect(parseChoice(v, 4)).toMatchObject({ decided: false, stale: true, granted: none });
    expect(parseChoice(undefined, 1)).toMatchObject({ decided: false, stale: false });
    for (const bad of ['', 'v1.12.abc', 'v1.101', 'x', 'v1.101.a b c d e f g h', 'v1.101.short']) expect(parseChoice(bad, 1).decided).toBe(false);
    expect(attributionConsent(parseChoice('v1.100.abcdefghijkl', 1))).toBe('granted');
    expect(attributionConsent(parseChoice('v1.010.abcdefghijkl', 1))).toBe('granted');
    expect(attributionConsent(parseChoice('v1.001.abcdefghijkl', 1))).toBe('denied');
    expect(attributionConsent(parseChoice('v1.000.abcdefghijkl', 1))).toBe('denied');
    expect(attributionConsent(parseChoice(undefined, 1))).toBe('unknown');
  });

  it('Consent Mode v2: everything denied first, the choice as an update; security and functionality are "necessary"', () => {
    expect(consentSignals(none)).toEqual({ ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied', functionality_storage: 'granted', personalization_storage: 'denied', security_storage: 'granted' });
    expect(consentSignals({ ...none, statistics: true })).toMatchObject({ analytics_storage: 'granted', ad_storage: 'denied' });
    expect(consentSignals({ ...none, marketing: true })).toMatchObject({ ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', analytics_storage: 'denied' });
    const first = consentModeSnippet(none, false);
    expect(first).toContain(`gtag('consent','default',`);
    expect(first).toContain('"ad_user_data":"denied"');
    expect(first).toContain('"wait_for_update":500');
    expect(first).not.toContain(`'update'`);
    const later = consentModeSnippet({ ...none, statistics: true }, true);
    expect(later).toContain(`gtag('consent','update',`);
    expect(later.indexOf(`'default'`)).toBeLessThan(later.indexOf(`'update'`));
    expect(later).toContain('"analytics_storage":"granted"');
  });

  const urls: BannerUrls = { action: (a, c) => `/x?pghl_cmp=${a}${c ? `&pghl_c=${c}` : ''}`, formAction: '/x', hidden: [['utm_source', 'a&b']] };
  it('shows accept and reject equally prominent, categories unchecked, necessary always on – and escapes the owner\'s words', () => {
    const s = cleanCmp({ ...DEFAULT_CMP, enabled: true, title: '<img src=x onerror=alert(1)>', policy_url: 'https://example.com/datenschutz' });
    const h = bannerHtml(s, parseChoice(undefined, s.version), urls);
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(h).toMatch(/<a class="pghl-cmp-btn" href="\/x\?pghl_cmp=accept"[^>]*>Alle akzeptieren<\/a><a class="pghl-cmp-btn" href="\/x\?pghl_cmp=reject"[^>]*>Nur notwendige<\/a>/);
    expect(h).toContain('href="https://example.com/datenschutz"');
    // Form for the details: GET, keeps the page's own parameters, nothing pre-ticked except "notwendig".
    expect(h).toContain('<form method="get" action="/x">');
    expect(h).toContain('<input type="hidden" name="utm_source" value="a&amp;b">');
    expect(h).toContain('<input type="checkbox" checked disabled>');
    for (const n of ['pghl_s', 'pghl_m', 'pghl_e']) expect(h).toContain(`<input type="checkbox" name="${n}" value="1">`);
    expect(h).not.toMatch(/name="pghl_[sme]" value="1" checked/);
    // Once decided, the details show the current state.
    const again = bannerHtml(s, parseChoice(cmpCookie(s.version, { ...none, marketing: true }, 'abcdefghijkl'), s.version), urls);
    expect(again).toContain('name="pghl_m" value="1" checked');
    expect(again).toContain('<details open>');
  });

  it('clamps settings: colours, addresses, positions, expiry', () => {
    const s = cleanCmp({ enabled: 1, colors: { bg: 'red', accent: '#ABCDEF' }, policy_url: 'javascript:alert(1)', imprint_url: '/impressum', layout: 'zoom', position: 'right', expiry_days: 9999, title: ' ', version: -4 });
    expect(s.enabled).toBe(false);
    expect(s.colors.bg).toBe('#ffffff');
    expect(s.colors.accent).toBe('#abcdef');
    expect(s.policy_url).toBe('');
    expect(s.imprint_url).toBe('/impressum');
    expect(s.layout).toBe('box');
    expect(s.position).toBe('right');
    expect(s.expiry_days).toBe(395);
    expect(s.title).toBe(DEFAULT_CMP.title);
    expect(s.version).toBe(1);
    expect(cleanCmp(undefined).enabled).toBe(false);
  });

  it('applyCmp: only the owner regions are sorted; Consent Mode goes first in <head>; the banner or the re-open tab at the end; "#cookie-settings" links open it', () => {
    const s = cleanCmp({ ...DEFAULT_CMP, enabled: true });
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>x</title><script>window.mine=1</script><!--pghl:owner--><script src="https://connect.facebook.net/en_US/fbevents.js"></script><!--/pghl:owner--></head><body><section class="blk blk-html"><script>fbq('track','Lead')</script></section><a href="#cookie-settings">Cookies</a></body></html>`;
    const base = { settings: s, urls, reopenHref: '?pghl_cmp=open', ...opts() };
    const first = applyCmp(page, { ...base, choice: parseChoice(undefined, s.version), showBanner: true });
    expect(first.html).toContain('<script>window.mine=1</script>');
    expect(first.html).toContain('type="text/plain" data-category="marketing" data-src="https://connect.facebook.net');
    expect(first.html).toMatch(/<script type="text\/plain" data-category="marketing">fbq\('track'/);
    expect(first.html.indexOf(`gtag('consent','default'`)).toBeLessThan(first.html.indexOf('window.mine=1'));
    expect(first.html).toContain('id="pghl-cmp"');
    expect(first.html).not.toContain('pghl-cmp-reopen"');
    expect(first.html).toContain('href="?pghl_cmp=open" rel="nofollow">Cookies');
    expect(first.html.indexOf('id="pghl-cmp"')).toBeLessThan(first.html.indexOf('</body>'));
    const decided = applyCmp(page, { ...base, choice: parseChoice(cmpCookie(s.version, all, 'abcdefghijkl'), s.version), granted: all, showBanner: false });
    expect(decided.html).not.toContain('id="pghl-cmp"');
    expect(decided.html).toContain('class="pghl-cmp-reopen"');
    expect(decided.html).toContain(`gtag('consent','update',`);
    expect(decided.html).toContain('<script src="https://connect.facebook.net/en_US/fbevents.js"></script>');
    expect(decided.html).not.toContain('text/plain');
  });
});

// --- the pages ----------------------------------------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let funnel: any;
const HEAD = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST123"></script><script>gtag('config','G-TEST123');</script><script src="https://connect.facebook.net/en_US/fbevents.js"></script><script data-category="necessary">window.fine=1</script><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=1&noscript=1"></noscript>`;
const UA = 'Mozilla/5.0 (Test)';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  funnel = (await t.api.post('/api/funnels', { name: 'Seite', template: 'website' })).data;
  await t.api.patch(`/api/funnels/${funnel.id}`, { settings: { head_code: HEAD } });
  const home = funnel.pages[0];
  await t.api.patch(`/api/funnel-pages/${home.id}`, { blocks: [{ type: 'hero', heading: 'Hallo', align: 'center' }, { type: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, { type: 'html', html: `<script>fbq('init','1')</script><p>Eigener Block</p>` }] });
});
afterAll(async () => t.close());

const page = (path = `/p/${funnel.slug}`, headers: Record<string, string> = {}) => t.api.raw(path, { headers: { 'user-agent': UA, ...headers }, redirect: 'manual' }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.text() }));
const cmp = async (patch: Record<string, unknown>) => (await t.api.put('/api/cmp/settings', patch)).data.settings;

describe('cookie banner on the pages', () => {
  it('is off until the owner turns it on: the page is as before', async () => {
    const r = await page();
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('pghl-cmp');
    expect(r.body).toContain('src="https://connect.facebook.net/en_US/fbevents.js"');
    expect(r.body).toContain('fbq(\'init\',\'1\')');
    expect((await t.api.get('/api/cmp/settings')).data.settings.enabled).toBe(false);
  });

  it('blocks head code, HTML blocks, fonts, pixels and the video until consent – and shows one banner with equal buttons', async () => {
    const s = await cmp({ enabled: true });
    expect(s.enabled).toBe(true);
    const r = await page();
    const h = r.body;
    expect(h).toMatch(/<script async type="text\/plain" data-category="statistics" data-src="https:\/\/www\.googletagmanager\.com/);
    expect(h).toMatch(/data-category="marketing" data-src="https:\/\/connect\.facebook\.net/);
    expect(h).toMatch(/<script type="text\/plain" data-category="marketing">fbq\('init','1'\)<\/script>/);
    expect(h).toContain('<script data-category="necessary">window.fine=1</script>');
    expect(h).toContain('data-href="https://fonts.googleapis.com');
    expect(h).not.toContain('src="https://www.facebook.com/tr');
    expect(h).not.toContain('<noscript><img');
    // The video: a note instead of the frame.
    expect(h).toContain('pghl-cmp-ph');
    expect(h).not.toMatch(/<iframe[^>]*youtube/);
    // The banner: both buttons, same class, plus the page's own address as the target.
    expect(h).toContain('id="pghl-cmp"');
    expect(h).toContain(`href="/p/${funnel.slug}?pghl_cmp=accept"`);
    expect(h).toContain(`href="/p/${funnel.slug}?pghl_cmp=reject"`);
    // Consent Mode default (denied) comes before any Google tag.
    expect(h).toContain(`gtag('consent','default'`);
    expect(h.indexOf(`gtag('consent','default'`)).toBeLessThan(h.indexOf('googletagmanager.com'));
    expect(h).not.toContain(`gtag('consent','update'`);
    // The page depends on the cookie: not cacheable for others.
    expect(r.headers.get('cache-control')).toMatch(/private|no-store/);
    expect(r.headers.get('vary')).toContain('Cookie');
    // Still sandboxed.
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('there is only one banner: the older attribution banner stays away while this one is on', async () => {
    await t.api.put('/api/attribution/settings', { cookie: 'consent', banner: true });
    const on = (await page()).body;
    expect(on).toContain('id="pghl-cmp"');
    expect(on).not.toContain('id="pghl-consent"');
    await cmp({ enabled: false });
    const off = (await page()).body;
    expect(off).toContain('id="pghl-consent"');
    expect(off).not.toContain('id="pghl-cmp"');
    await cmp({ enabled: true });
    await t.api.put('/api/attribution/settings', { banner: false });
  });

  it('with consent the code runs again, Consent Mode gets the update, the banner is replaced by the re-open tab', async () => {
    const v = (await t.api.get('/api/cmp/settings')).data.settings.version;
    const r = await page(undefined, { cookie: `pghl_cmp=${cmpCookie(v, { statistics: true, marketing: true, external_media: false }, 'abcdefghijkl')}` });
    const h = r.body;
    expect(h).toContain('<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST123"></script>');
    expect(h).toContain('<script src="https://connect.facebook.net/en_US/fbevents.js"></script>');
    expect(h).toContain(`gtag('consent','update',{"ad_storage":"granted"`);
    expect(h).toContain('"analytics_storage":"granted"');
    // External media were not allowed: fonts and video stay blocked.
    expect(h).toContain('data-href="https://fonts.googleapis.com');
    expect(h).toContain('pghl-cmp-ph');
    expect(h).not.toContain('id="pghl-cmp"');
    expect(h).toContain('class="pghl-cmp-reopen"');
    expect(h).toContain(`href="/p/${funnel.slug}?pghl_cmp=open"`);
    // Opened again: the banner with the current choice.
    const open = (await page(`/p/${funnel.slug}?pghl_cmp=open`, { cookie: `pghl_cmp=${cmpCookie(v, { statistics: true, marketing: false, external_media: false }, 'abcdefghijkl')}` })).body;
    expect(open).toContain('id="pghl-cmp"');
    expect(open).toContain('name="pghl_s" value="1" checked');
    // Allowed everything: the video plays.
    const yes = (await page(undefined, { cookie: `pghl_cmp=${cmpCookie(v, { statistics: true, marketing: true, external_media: true }, 'abcdefghijkl')}` })).body;
    expect(yes).toMatch(/<iframe[^>]*src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ"/);
    expect(yes).not.toContain('text/plain');
  });

  it('the buttons set the cookie on the server, log the decision and send the visitor back', async () => {
    const v = (await t.api.get('/api/cmp/settings')).data.settings.version;
    const acc = await page(`/p/${funnel.slug}?utm_source=anzeige&pghl_cmp=accept`, { 'x-forwarded-for': '203.0.113.50' });
    expect(acc.status).toBe(303);
    expect(acc.headers.get('location')).toBe(`/p/${funnel.slug}?utm_source=anzeige`);
    const cookies = acc.headers.getSetCookie();
    const mine = cookies.find((c) => c.startsWith('pghl_cmp='))!;
    expect(mine).toMatch(new RegExp(`^pghl_cmp=v${v}\\.111\\.[A-Za-z0-9]{16}; Path=/; SameSite=Lax; Max-Age=${180 * 86400}`));
    expect(cookies.find((c) => c.startsWith('pghl_consent='))).toMatch(/^pghl_consent=1;/);
    const log = (await t.api.get('/api/cmp/log')).data;
    expect(log.rows[0]).toMatchObject({ choice: 'accept_all', statistics: 1, marketing: 1, external_media: 1, version: v });
    expect(log.rows[0].ip_net).toBe('127.0.0.0/24');
    expect(log.rows[0].cid).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(JSON.stringify(log)).not.toContain(UA);
    expect(log.last_30_days.accept_all).toBeGreaterThanOrEqual(1);

    // Reject: nothing optional, the visitor cookie of the attribution goes, the id of the log stays the same.
    const cid = mine.split(';')[0].split('.')[2];
    const rej = await page(`/p/${funnel.slug}?pghl_cmp=reject`, { cookie: `pghl_cmp=v${v}.111.${cid}; pghl_vid=abc` });
    expect(rej.status).toBe(303);
    const rc = rej.headers.getSetCookie();
    expect(rc.find((c) => c.startsWith('pghl_cmp='))).toContain(`.000.${cid}`);
    expect(rc.find((c) => c.startsWith('pghl_consent='))).toMatch(/^pghl_consent=0;/);
    // The page itself may have set one first (attribution runs before the banner); the last word is the clearing one.
    expect(rc.filter((c) => c.startsWith('pghl_vid=')).pop()).toMatch(/Max-Age=0/);

    // Own selection: statistics and external media.
    const sel = await page(`/p/${funnel.slug}?pghl_cmp=save&pghl_s=1&pghl_e=1`);
    expect(sel.headers.getSetCookie().find((c) => c.startsWith('pghl_cmp='))).toContain('.101.');
    expect((await t.api.get('/api/cmp/log')).data.rows[0].choice).toBe('custom');

    // "Allow this one" next to a blocked embed adds a category and keeps the others.
    const one = await page(`/p/${funnel.slug}?pghl_cmp=allow&pghl_c=marketing`, { cookie: `pghl_cmp=v${v}.101.${cid}` });
    expect(one.headers.getSetCookie().find((c) => c.startsWith('pghl_cmp='))).toContain('.111.');

    // Only the visitor's own navigation counts – not an <img> or <script> of another site pointing here.
    const before = (await t.api.get('/api/cmp/log')).data.rows.length;
    expect((await page(`/p/${funnel.slug}?pghl_cmp=accept`, { 'sec-fetch-dest': 'image' })).status).toBe(403);
    expect((await t.api.get('/api/cmp/log')).data.rows.length).toBe(before);
    // Rubbish in the parameters does nothing.
    expect((await page(`/p/${funnel.slug}?pghl_cmp=allow&pghl_c=necessary`)).status).toBe(200);
  });

  it('a change of the wording asks everybody again', async () => {
    const before = (await t.api.get('/api/cmp/settings')).data.settings.version;
    const old = `pghl_cmp=${cmpCookie(before, all, 'abcdefghijkl')}`;
    expect((await page(undefined, { cookie: old })).body).not.toContain('id="pghl-cmp"');
    // Colours do not count as a change of the wording.
    expect((await cmp({ colors: { accent: '#ff0000' } })).version).toBe(before);
    expect((await cmp({ text: 'Neuer Hinweistext zu Cookies.' })).version).toBe(before + 1);
    const r = await page(undefined, { cookie: old });
    expect(r.body).toContain('id="pghl-cmp"');
    expect(r.body).toContain('Neuer Hinweistext zu Cookies.');
    expect(r.body).toContain('<details open>');
    expect(r.body).toMatch(/type="text\/plain" data-category="marketing" data-src/);
    expect((await t.api.post('/api/cmp/reask')).data.settings.version).toBe(before + 2);
  });

  it('attribution asks the banner: statistics or marketing allowed sets its cookie, a rejection does not', async () => {
    const v = (await t.api.get('/api/cmp/settings')).data.settings.version;
    const q = `/p/${funnel.slug}?utm_source=google&utm_medium=cpc`;
    const yes = await page(q, { cookie: `pghl_cmp=${cmpCookie(v, { statistics: true, marketing: false, external_media: false }, 'abcdefghijkl')}` });
    expect(yes.headers.getSetCookie().some((c) => c.startsWith('pghl_vid='))).toBe(true);
    const no = await page(q, { cookie: `pghl_cmp=${cmpCookie(v, none, 'abcdefghijkl')}` });
    expect(no.headers.getSetCookie().some((c) => c.startsWith('pghl_vid='))).toBe(false);
    expect(no.body).not.toContain('window.pghlAttr');
    const undecided = await page(q);
    expect(undecided.headers.getSetCookie().some((c) => c.startsWith('pghl_vid='))).toBe(false);
    // Global Privacy Control without a decision: denied.
    const gpc = await page(q, { 'sec-gpc': '1' });
    expect(gpc.headers.getSetCookie().some((c) => c.startsWith('pghl_vid='))).toBe(false);
  });

  it('the visitor becomes a contact: the cookie choice goes into the ledger (channel "Tracking")', async () => {
    const v = (await t.api.get('/api/cmp/settings')).data.settings.version;
    const form = (await t.api.post('/api/forms', { name: 'Kontakt' })).data;
    const send = (cookie: string, email: string) =>
      t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, cookie }, body: JSON.stringify({ first_name: 'Vera', email, consent: 'ja' }) }).then((r) => r.json());
    const r = await send(`pghl_cmp=${cmpCookie(v, { statistics: true, marketing: true, external_media: false }, 'abcdefghijkl')}`, 'vera@example.com');
    const c = (await t.api.get(`/api/contacts/${r.contactId}/consent`)).data;
    expect(c.channels.tracking.purposes.statistics.status).toBe('confirmed');
    expect(c.channels.tracking.purposes.marketing.status).toBe('confirmed');
    expect(c.channels.tracking.purposes.external_media.status).toBe('unknown');
    const ev = c.events.find((e: any) => e.channel === 'tracking' && e.purpose === 'statistics');
    expect(ev).toMatchObject({ action: 'granted', source_kind: 'cmp', actor: 'contact' });
    expect(ev.text).toContain('Statistik');
    expect(ev.note).toContain('abcdefghijkl');
    // Later the same person withdraws marketing in the banner: the ledger follows.
    await send(`pghl_cmp=${cmpCookie(v, { statistics: true, marketing: false, external_media: false }, 'abcdefghijkl')}`, 'vera@example.com');
    const after = (await t.api.get(`/api/contacts/${r.contactId}/consent`)).data;
    expect(after.channels.tracking.purposes.marketing.status).toBe('revoked');
    expect(after.channels.tracking.purposes.statistics.status).toBe('confirmed');
    // And an unchanged choice writes nothing new.
    const n = after.events.length;
    await send(`pghl_cmp=${cmpCookie(v, { statistics: true, marketing: false, external_media: false }, 'abcdefghijkl')}`, 'vera@example.com');
    expect((await t.api.get(`/api/contacts/${r.contactId}/consent`)).data.events.length).toBe(n);
    // Tracking consent has nothing to do with sending mail.
    expect(after.channels.email.status).toBe('unknown');
  });

  it('forms, booking pages and buy pages get the banner too – but not inside an iframe', async () => {
    const form = (await t.api.post('/api/forms', { name: 'Seite' })).data;
    const cal = (await t.api.post('/api/calendars', { name: 'Gespräch', duration: 30 })).data;
    for (const path of [`/f/${form.id}`, `/book/${cal.slug}`]) {
      const r = await page(path);
      expect(r.status, path).toBe(200);
      expect(r.body, path).toContain('id="pghl-cmp"');
      expect(r.body, path).toContain(`href="${path}?pghl_cmp=accept"`);
      expect((await page(`${path}?embed=1`)).body, path).not.toContain('pghl-cmp');
      expect((await page(path, { 'sec-fetch-dest': 'iframe' })).body, path).not.toContain('pghl-cmp');
    }
    // Pages that are not a visitor's page (JSON, files) are not touched.
    expect((await t.api.raw('/api/public/forms/nope/submit', { method: 'POST' })).status).toBeGreaterThanOrEqual(400);
  });

  it('the editor previews the banner with the draft settings; settings are validated and stay in the sub-account', async () => {
    const r = await t.api.raw('/api/cmp/preview', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': loc }, body: JSON.stringify({ settings: { title: 'Vorschau-Titel', colors: { accent: '#00aa00' }, layout: 'center' } }) });
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain('Vorschau-Titel');
    expect(html).toContain('id="pghl-cmp"');
    expect(html).toContain('#00aa00');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    // The preview saved nothing.
    expect((await t.api.get('/api/cmp/settings')).data.settings.title).not.toBe('Vorschau-Titel');
    const s = (await t.api.put('/api/cmp/settings', { policy_url: 'javascript:alert(1)', layout: 'zoom', colors: { bg: 'red' } })).data.settings;
    expect(s.policy_url).toBe('');
    expect(s.layout).toBe('box');
    expect(s.colors.bg).toBe('#ffffff');
    const other = (await t.api.post('/api/locations', { name: 'Andere' })).data;
    expect((await t.api.get('/api/cmp/settings', { 'x-location-id': other.id })).data.settings.enabled).toBe(false);
    // A page of this sub-account is never changed by another one's settings.
    expect((await page(`/p/${funnel.slug}`)).body).toContain('pghl-cmp');
  });
});
