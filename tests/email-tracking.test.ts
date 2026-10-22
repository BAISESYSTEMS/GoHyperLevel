import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { BURST_WINDOW_MS, CLICK_FAST_MS, OPEN_FAST_MS, classifyHit, ipPrefix, isAppleIp, uaClass, uaHash, type HitSignals } from '../server/services/email-classify.js';
import { HOLD_MS, pruneEvents } from '../server/services/email-events.js';

/**
 * Open/click tracking that tells people from machines: Apple Mail Privacy Protection, Gmail's image proxy and
 * link scanners are recorded (email_events) but only people count and start workflows.
 */

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const HOUR = 3600_000;

describe('classification heuristics', () => {
  const base: HitSignals = { kind: 'open', method: 'GET', userAgent: CHROME, ip: '203.0.113.5', hasAcceptLanguage: true, prefetch: false, sentAtMs: 0, atMs: HOUR };
  const verdict = (o: Partial<HitSignals>) => {
    const r = classifyHit({ ...base, ...o });
    return `${r.verdict}:${r.reason}`;
  };

  it('treats a browser an hour after sending as a person', () => {
    expect(verdict({})).toBe('human:human');
    expect(verdict({ kind: 'click' })).toBe('human:human');
  });

  it('HEAD requests are scanners, for pixel and link alike', () => {
    expect(verdict({ method: 'HEAD' })).toBe('scanner:head-request');
    expect(verdict({ method: 'head', kind: 'click' })).toBe('scanner:head-request');
  });

  it('knows mail-provider image proxies', () => {
    expect(verdict({ userAgent: 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)' })).toBe('proxy:proxy-ua');
    expect(verdict({ userAgent: 'YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html' })).toBe('proxy:proxy-ua');
  });

  it('knows Apple Mail Privacy Protection: a bare "Mozilla/5.0" or Apple\'s address range (opens only)', () => {
    expect(verdict({ userAgent: 'Mozilla/5.0' })).toBe('proxy:apple-mpp');
    expect(verdict({ userAgent: CHROME, ip: '17.58.63.12' })).toBe('proxy:apple-mpp'); // oss-check: allow (fake/Apple test IPs)
    expect(verdict({ userAgent: CHROME, ip: '::ffff:17.253.1.1' })).toBe('proxy:apple-mpp'); // oss-check: allow (fake/Apple test IPs)
    expect(isAppleIp('17.1.2.3')).toBe(true); // oss-check: allow (fake/Apple test IPs)
    expect(isAppleIp('170.1.2.3')).toBe(false); // oss-check: allow (fake/Apple test IPs)
    expect(isAppleIp('118.1.2.3')).toBe(false); // oss-check: allow (fake/Apple test IPs)
    // A click is never Apple's proxy: the bare UA on a click is just a bot without headers.
    expect(verdict({ kind: 'click', userAgent: 'Mozilla/5.0', hasAcceptLanguage: false })).toBe('scanner:no-browser-headers');
  });

  it('knows security gateways and bots by name', () => {
    for (const ua of ['Mozilla/5.0 (compatible; Mimecast Attachment Protect)', 'ProofpointURLDefense/1.0', 'BarracudaCentral', 'Microsoft Defender SafeLinks', 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120', 'python-requests/2.31', 'curl/8.4.0', 'Go-http-client/2.0', 'Slackbot-LinkExpanding 1.0', 'Mozilla/5.0 (compatible; Googlebot/2.1)']) {
      expect(verdict({ userAgent: ua, kind: 'click' }), ua).toMatch(/^scanner:(scanner|bot)-ua$/);
      expect(verdict({ userAgent: ua }), ua).toMatch(/^scanner:(scanner|bot)-ua$/);
    }
    // Real browsers and mail apps are not on the lists.
    for (const ua of [CHROME, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0', 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17628; Pro)']) { // oss-check: allow (fake/Apple test IPs)
      expect(verdict({ userAgent: ua }), ua).toBe('human:human');
    }
  });

  it('a prefetch header marks the hit as machine', () => {
    expect(verdict({ prefetch: true })).toBe('proxy:prefetch');
  });

  it('no User-Agent: an open is a proxy, a click is a scanner', () => {
    expect(verdict({ userAgent: '' })).toBe('proxy:no-user-agent');
    expect(verdict({ userAgent: '', kind: 'click' })).toBe('scanner:no-user-agent');
  });

  it('an open within seconds of sending is a prefetch; a click within ten seconds is a scanner', () => {
    expect(verdict({ atMs: OPEN_FAST_MS - 1 })).toBe('proxy:fast-open');
    expect(verdict({ atMs: OPEN_FAST_MS })).toBe('human:human');
    expect(verdict({ kind: 'click', atMs: CLICK_FAST_MS - 1 })).toBe('scanner:fast-click');
    expect(verdict({ kind: 'click', atMs: CLICK_FAST_MS })).toBe('human:human');
    // Unknown send time (no timing rules) must not turn people into machines.
    expect(verdict({ sentAtMs: undefined, atMs: 1 })).toBe('human:human');
    expect(verdict({ sentAtMs: Number.NaN, atMs: 1, kind: 'click' })).toBe('human:human');
  });

  it('two different links within a moment are a scanner; a person does not do that', () => {
    expect(BURST_WINDOW_MS).toBeLessThanOrEqual(2_000);
    expect(verdict({ kind: 'click', otherLinksInBurst: 1 })).toBe('scanner:link-burst');
    expect(verdict({ kind: 'click', otherLinksInBurst: 0 })).toBe('human:human');
  });

  it('a click without Accept-Language is not a browser', () => {
    expect(verdict({ kind: 'click', hasAcceptLanguage: false })).toBe('scanner:no-browser-headers');
    expect(verdict({ kind: 'open', hasAcceptLanguage: false })).toBe('human:human');
  });

  it('keeps only the network of an address, and a hash instead of the User-Agent', () => {
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('2001:db8:abcd:1234:5678::1')).toBe('2001:db8:abcd::/48');
    expect(ipPrefix('::1')).toBe('0:0:0::/48');
    expect(ipPrefix('fe80::1%eth0')).toBe('fe80:0:0::/48');
    expect(ipPrefix('64:ff9b::192.0.2.33')).toBe('64:ff9b:0::/48');
    for (const bad of ['', 'not-an-ip', '999.1.1.1', '1.2.3', '1:2:3:4:5:6:7:8:9', '1::2::3']) expect(ipPrefix(bad), bad).toBe('');
    expect(uaClass('')).toBe('none');
    expect(uaClass('Mozilla/5.0')).toBe('bare');
    expect(uaClass('GoogleImageProxy')).toBe('proxy');
    expect(uaClass('Mimecast')).toBe('bot');
    expect(uaClass(CHROME)).toBe('windows');
    expect(uaClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)')).toBe('ios');
    expect(uaHash(CHROME)).toMatch(/^[0-9a-f]{12}$/);
    expect(uaHash(CHROME)).toBe(uaHash(` ${CHROME} `));
    expect(uaHash('')).toBe('');
  });
});

describe('pixel and link endpoints', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let seq = 0;
  const person = { 'user-agent': CHROME, 'accept-language': 'de-DE,de;q=0.9' };
  const get = (path: string, headers: Record<string, string> = person, method = 'GET') => t.api.raw(path, { method, headers, redirect: 'manual' });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const commit = async () => {
    t.app.services.trackingCommit({ force: true });
    await t.app.events.flush();
  };

  /** A tracked mail to a new contact with two links; `age` is how long ago it was sent. */
  async function mail(age = HOUR) {
    const email = `leser${++seq}@example.com`;
    const c = (await t.api.post('/api/contacts', { email, first_name: 'Lea' })).data;
    await t.api.post('/api/messages', { contact_id: c.id, channel: 'email', subject: 'Hallo', body: 'Angebot: https://example.com/angebot und Blog: https://example.com/blog' });
    const msg = t.app.db.get('SELECT id FROM messages WHERE contact_id = ? ORDER BY created_at DESC', c.id)!;
    t.app.db.run('UPDATE messages SET created_at = ? WHERE id = ?', new Date(Date.now() - age).toISOString(), msg.id);
    const links = t.app.db.all('SELECT id, url FROM tracked_links WHERE message_id = ? ORDER BY url', msg.id);
    expect(links).toHaveLength(2);
    return { c, id: msg.id as string, links: links as { id: string; url: string }[] };
  }
  const row = (id: string) => t.app.db.get('SELECT * FROM messages WHERE id = ?', id)!;
  const events = (id: string) => t.app.db.all('SELECT * FROM email_events WHERE message_id = ? ORDER BY at, rowid', id);
  const tags = async (cid: string) => (await t.api.get(`/api/contacts/${cid}`)).data.tags as string[];

  beforeAll(async () => {
    t = await startTestApp({ behindProxy: true });
    await t.setup();
    // Workflows that tag whoever opens or clicks: only people may start them.
    for (const [type, tag] of [['email.opened', 'hat-geoeffnet'], ['email.clicked', 'hat-geklickt']]) {
      const wf = (await t.api.post('/api/workflows', { name: type, trigger: { type, config: {} }, steps: [{ type: 'add_tag', tags: [tag] }] })).data;
      await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    }
  });
  afterAll(async () => t.close());

  it('counts a person: opened_at, open_count, activity and the email.opened trigger (once)', async () => {
    const m = await mail();
    const px = await get(`/t/o/${m.id}.gif`);
    expect(px.status).toBe(200);
    expect(px.headers.get('content-type')).toBe('image/gif');
    expect(px.headers.get('cache-control')).toMatch(/no-store/);
    expect(Buffer.from(await px.arrayBuffer()).subarray(0, 3).toString()).toBe('GIF');
    await get(`/t/o/${m.id}.gif`);
    await t.app.events.flush();
    expect(row(m.id)).toMatchObject({ open_count: 2, machine_open_count: 0 });
    expect(row(m.id).opened_at).toBeTruthy();
    expect(await tags(m.c.id)).toContain('hat-geoeffnet');
    expect(t.app.db.all(`SELECT id FROM activities WHERE contact_id = ? AND type = 'email.opened'`, m.c.id)).toHaveLength(1);
    expect(events(m.id).map((e) => [e.kind, e.classification, e.reason, e.applied])).toEqual([['open', 'human', 'human', 1], ['open', 'human', 'human', 1]]);
  });

  it('a mail provider proxy or Apple Mail loading the pixel is recorded but does not count or start anything', async () => {
    const gmail = await mail();
    await get(`/t/o/${gmail.id}.gif`, { 'user-agent': 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)' });
    const apple = await mail();
    await get(`/t/o/${apple.id}.gif`, { 'user-agent': 'Mozilla/5.0' });
    const appleIp = await mail();
    await get(`/t/o/${appleIp.id}.gif`, { ...person, 'x-forwarded-for': '17.58.63.12' }); // oss-check: allow (fake/Apple test IPs)
    await t.app.events.flush();
    for (const [m, reason] of [[gmail, 'proxy-ua'], [apple, 'apple-mpp'], [appleIp, 'apple-mpp']] as const) {
      expect(row(m.id), reason).toMatchObject({ opened_at: null, open_count: 0, machine_open_count: 1 });
      expect(events(m.id).map((e) => [e.classification, e.reason, e.applied]), reason).toEqual([['proxy', reason, 1]]);
      expect(await tags(m.c.id), reason).not.toContain('hat-geoeffnet');
      expect(t.app.db.all(`SELECT id FROM activities WHERE contact_id = ? AND type = 'email.opened'`, m.c.id), reason).toHaveLength(0);
    }
  });

  it('an open right after sending is a prefetch', async () => {
    const m = await mail(1_000);
    await get(`/t/o/${m.id}.gif`);
    expect(row(m.id)).toMatchObject({ opened_at: null, open_count: 0, machine_open_count: 1 });
    expect(events(m.id)[0]).toMatchObject({ classification: 'proxy', reason: 'fast-open' });
  });

  it('HEAD requests: the pixel and the link answer like GET and are scanners', async () => {
    const m = await mail();
    const px = await get(`/t/o/${m.id}.gif`, person, 'HEAD');
    expect(px.status).toBe(200);
    expect(px.headers.get('content-type')).toBe('image/gif');
    expect((await px.text()).length).toBe(0);
    const click = await get(`/t/c/${m.links[0].id}`, person, 'HEAD');
    expect(click.status).toBe(302);
    expect(click.headers.get('location')).toBe(m.links[0].url);
    await commit();
    expect(row(m.id)).toMatchObject({ opened_at: null, clicked_at: null, open_count: 0, click_count: 0, machine_open_count: 1, machine_click_count: 1 });
    expect(events(m.id).map((e) => [e.kind, e.method, e.classification, e.reason])).toEqual([['open', 'HEAD', 'scanner', 'head-request'], ['click', 'HEAD', 'scanner', 'head-request']]);
    expect(await tags(m.c.id)).not.toContain('hat-geklickt');
  });

  it('a click always redirects, even for a scanner, a bot and an unknown mail', async () => {
    const m = await mail(2_000);
    for (const headers of [person, { 'user-agent': 'Mimecast' }, {}]) {
      const r = await get(`/t/c/${m.links[1].id}`, headers);
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(m.links[1].url);
    }
    // The pixel of a mail that does not exist still answers (no way to tell which ids exist); a link that does not exist is a 404.
    expect((await get('/t/o/gibtsnicht.gif')).status).toBe(200);
    expect((await get('/t/c/gibtsnicht')).status).toBe(404);
    expect((await get('/t/c/gibtsnicht', person, 'HEAD')).status).toBe(404);
  });

  it('a click within seconds of sending is a scanner: redirects, counts as machine, starts nothing', async () => {
    const m = await mail(3_000);
    const r = await get(`/t/c/${m.links[0].id}`);
    expect(r.status).toBe(302);
    await commit();
    expect(row(m.id)).toMatchObject({ clicked_at: null, click_count: 0, opened_at: null, machine_click_count: 1 });
    expect(t.app.db.get('SELECT clicks, machine_clicks FROM tracked_links WHERE id = ?', m.links[0].id)).toMatchObject({ clicks: 0, machine_clicks: 1 });
    expect(await tags(m.c.id)).not.toContain('hat-geklickt');
    expect(t.app.db.all(`SELECT id FROM activities WHERE contact_id = ? AND type = 'email.clicked'`, m.c.id)).toHaveLength(0);
  });

  it('counts a person\'s click once the hold is over (without forcing): counters, open implied, activity, trigger', async () => {
    const m = await mail();
    const r = await get(`/t/c/${m.links[0].id}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(m.links[0].url);
    // Waiting: a scanner's second link may still turn this click into a scanner click.
    expect(row(m.id).clicked_at).toBeNull();
    expect(events(m.id)[0]).toMatchObject({ classification: 'human', applied: 0 });
    await sleep(HOLD_MS + 600);
    await t.app.events.flush();
    expect(row(m.id)).toMatchObject({ click_count: 1, machine_click_count: 0 });
    expect(row(m.id).clicked_at).toBeTruthy();
    expect(row(m.id).opened_at).toBeTruthy();
    expect(t.app.db.get('SELECT clicks FROM tracked_links WHERE id = ?', m.links[0].id)!.clicks).toBe(1);
    expect(await tags(m.c.id)).toContain('hat-geklickt');
    expect(events(m.id)[0]).toMatchObject({ classification: 'human', applied: 1 });
    expect(t.app.db.all(`SELECT summary FROM activities WHERE contact_id = ? AND type = 'email.clicked'`, m.c.id)).toMatchObject([{ summary: 'Link geklickt: https://example.com/angebot' }]);
  }, 15_000);

  it('several links within a moment are a scanner – the first click, still waiting, is judged a scanner click too', async () => {
    const m = await mail();
    // A scanner with a browser's User-Agent: the first click looks like a person …
    expect((await get(`/t/c/${m.links[0].id}`)).status).toBe(302);
    expect(events(m.id)[0]).toMatchObject({ classification: 'human', applied: 0 });
    // … until the second link arrives a moment later.
    expect((await get(`/t/c/${m.links[1].id}`)).status).toBe(302);
    await commit();
    expect(events(m.id).map((e) => [e.classification, e.reason, e.applied])).toEqual([['scanner', 'link-burst', 1], ['scanner', 'link-burst', 1]]);
    expect(row(m.id)).toMatchObject({ clicked_at: null, click_count: 0, opened_at: null, machine_click_count: 2 });
    expect(await tags(m.c.id)).not.toContain('hat-geklickt');
    expect(t.app.db.all(`SELECT id FROM activities WHERE contact_id = ? AND type = 'email.clicked'`, m.c.id)).toHaveLength(0);
  });

  it('two clicks on different links minutes apart are a person', async () => {
    const m = await mail();
    await get(`/t/c/${m.links[0].id}`);
    // Move the first click out of the burst window.
    t.app.db.run('UPDATE email_events SET at = ? WHERE message_id = ?', new Date(Date.now() - 60_000).toISOString(), m.id);
    await get(`/t/c/${m.links[1].id}`);
    await commit();
    expect(events(m.id).map((e) => e.classification)).toEqual(['human', 'human']);
    expect(row(m.id)).toMatchObject({ click_count: 2, machine_click_count: 0 });
  });

  it('a click without browser headers (an HTTP library) is a scanner, a machine click does not prove an open', async () => {
    const m = await mail();
    await get(`/t/c/${m.links[0].id}`, { 'user-agent': CHROME, 'accept-language': '' });
    await commit();
    expect(events(m.id)[0]).toMatchObject({ classification: 'scanner', reason: 'no-browser-headers' });
    expect(row(m.id)).toMatchObject({ opened_at: null, clicked_at: null });
  });

  it('stores no address and no User-Agent: only the network, a device class and a short hash', async () => {
    const m = await mail();
    await get(`/t/o/${m.id}.gif`, { ...person, 'x-forwarded-for': '203.0.113.77' });
    await get(`/t/o/${m.id}.gif`, { ...person, 'x-forwarded-for': '2001:db8:abcd:1234::99' });
    const [a, b] = events(m.id);
    expect(a).toMatchObject({ ip_prefix: '203.0.113.0/24', ua_class: 'windows', method: 'GET' });
    expect(b.ip_prefix).toBe('2001:db8:abcd::/48');
    expect(a.ua_hash).toMatch(/^[0-9a-f]{12}$/);
    const dump = JSON.stringify(t.app.db.all('SELECT * FROM email_events'));
    expect(dump).not.toContain('203.0.113.77');
    expect(dump).not.toContain('Chrome/126');
    expect(dump).not.toContain('2001:db8:abcd:1234');
  });

  it('the campaign report shows people and machines side by side', async () => {
    const contacts = [] as { c: any; id: string; links: any[] }[];
    for (let i = 0; i < 3; i++) contacts.push(await mail());
    // Reuse the campaign path: three recipients of one campaign.
    const camp = (await t.api.post('/api/campaigns', { name: 'Auswertung', subject: 'x', body: 'x' })).data;
    for (const m of contacts) t.app.db.insert('campaign_recipients', { campaign_id: camp.id, contact_id: m.c.id, status: 'sent', message_id: m.id, sent_at: new Date().toISOString() });
    t.app.db.run(`UPDATE messages SET status = 'sent' WHERE id IN (?, ?, ?)`, ...contacts.map((m) => m.id));
    // 0: a person opens and clicks; 1: Apple Mail and a scanner; 2: nobody.
    await get(`/t/o/${contacts[0].id}.gif`);
    await get(`/t/c/${contacts[0].links[0].id}`);
    await get(`/t/o/${contacts[1].id}.gif`, { 'user-agent': 'Mozilla/5.0' });
    await get(`/t/c/${contacts[1].links[0].id}`, { 'user-agent': 'Mimecast' });
    await get(`/t/c/${contacts[1].links[1].id}`, { 'user-agent': 'Mimecast' });
    await commit();
    const eng = (await t.api.get(`/api/campaigns/${camp.id}/engagement`)).data;
    expect(eng).toMatchObject({ sent: 3, opened: 1, clicked: 1, open_rate: 33.3, click_rate: 33.3, machine_opened: 1, machine_clicked: 1, machine_open_events: 1, machine_click_events: 2 });
    expect(eng.machine.map((x: any) => [x.reason, x.count]).sort()).toEqual([['apple-mpp', 1], ['scanner-ua', 2]]);
    expect(eng.machine.find((x: any) => x.reason === 'apple-mpp')).toMatchObject({ verdict: 'proxy', label: expect.stringContaining('Apple') });
    const byUrl = Object.fromEntries(eng.links.map((l: any) => [l.url, l]));
    expect(byUrl['https://example.com/angebot']).toMatchObject({ clicks: 1, machine_clicks: 1, people: 1 });
    expect(byUrl['https://example.com/blog']).toMatchObject({ clicks: 0, machine_clicks: 1, people: 0 });
    // Reports and scores read the people-only columns.
    const people = t.app.db.get(`SELECT SUM(opened_at IS NOT NULL) AS o, SUM(clicked_at IS NOT NULL) AS c FROM messages WHERE id IN (?, ?, ?)`, ...contacts.map((m) => m.id))!;
    expect(people).toMatchObject({ o: 1, c: 1 });
  });

  it('is capped per mail: a leaked pixel address cannot fill the table', async () => {
    const m = await mail();
    const at = new Date().toISOString();
    t.app.db.tx(() => {
      for (let i = 0; i < 300; i++) t.app.db.insert('email_events', { id: `cap${m.id}${i}`, location_id: t.api.location, message_id: m.id, contact_id: m.c.id, kind: 'open', at, classification: 'proxy', reason: 'proxy-ua', applied: 1 });
    });
    const px = await get(`/t/o/${m.id}.gif`);
    expect(px.status).toBe(200);
    expect(events(m.id)).toHaveLength(300);
  });

  it('forgets old events and links of mails that were never sent; the counters on the message stay', async () => {
    const m = await mail();
    await get(`/t/o/${m.id}.gif`);
    t.app.db.run('UPDATE email_events SET at = ? WHERE message_id = ?', new Date(Date.now() - 401 * 864e5).toISOString(), m.id);
    t.app.db.insert('tracked_links', { id: 'orphanlink01', location_id: t.api.location, message_id: 'never-sent', contact_id: null, url: 'https://example.com/x', created_at: new Date(Date.now() - 2 * 864e5).toISOString() });
    t.app.db.insert('tracked_links', { id: 'freshorphan1', location_id: t.api.location, message_id: 'being-sent', contact_id: null, url: 'https://example.com/y', created_at: new Date().toISOString() });
    expect(pruneEvents(t.app)).toBeGreaterThanOrEqual(2);
    expect(events(m.id)).toHaveLength(0);
    expect(row(m.id).open_count).toBe(1);
    expect(t.app.db.get(`SELECT id FROM tracked_links WHERE id = 'orphanlink01'`)).toBeUndefined();
    // A link of a mail that is being sent right now stays.
    expect(t.app.db.get(`SELECT id FROM tracked_links WHERE id = 'freshorphan1'`)).toBeTruthy();
  });

  it('erasing a contact removes its events (GDPR), and the export lists them without hashes', async () => {
    const m = await mail();
    await get(`/t/o/${m.id}.gif`);
    const out = t.app.services.privacy;
    const exp = (await t.api.get(`/api/contacts/${m.c.id}/privacy-export`)).data;
    expect(Object.keys(exp.data)).toContain('email_events');
    expect(exp.data.email_events[0]).toMatchObject({ kind: 'open', classification: 'human', ip_prefix: expect.stringMatching(/\/24$/) });
    expect(exp.data.email_events[0]).not.toHaveProperty('ua_hash');
    out.eraseContact(t.api.location, m.c.id);
    expect(t.app.db.all('SELECT id FROM email_events WHERE message_id = ? OR contact_id = ?', m.id, m.c.id)).toHaveLength(0);
    expect(t.app.db.all('SELECT id FROM tracked_links WHERE message_id = ?', m.id)).toHaveLength(0);
  });
});

describe('what goes into the mail', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const html = '<html><body><p><a href="https://example.com/a?x=1&amp;y=2">A</a> <a href="http://localhost/u/c1/tok">Abmelden</a></p></body></html>';
  const inst = (messageId: string) => t.app.services.instrumentEmail({ locationId: t.api.location, messageId, contactId: 'c1', html }) as string;
  const set = (email: Record<string, unknown>) => t.api.patch('/api/location', { settings: { email } });

  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(async () => t.close());

  it('by default: links go through /t/c/ (not the unsubscribe link) and the pixel closes the mail', () => {
    const out = inst('msg-default');
    expect(out).toMatch(/href="http:\/\/localhost\/t\/c\/[A-Za-z0-9]{12}"/);
    expect(out).toContain('href="http://localhost/u/c1/tok"');
    expect(out).toContain('<img src="http://localhost/t/o/msg-default.gif" width="1" height="1" alt="" style="display:none"></body>');
    expect(t.app.db.get(`SELECT url, contact_id FROM tracked_links WHERE message_id = 'msg-default'`)).toMatchObject({ url: 'https://example.com/a?x=1&y=2', contact_id: 'c1' });
  });

  it('track_opens = false: no pixel, clicks are still tracked', async () => {
    await set({ track_opens: false });
    const out = inst('msg-nopixel');
    expect(out).not.toContain('/t/o/');
    expect(out).not.toContain('<img');
    expect(out).toMatch(/href="http:\/\/localhost\/t\/c\/[A-Za-z0-9]{12}"/);
    expect(t.app.db.all(`SELECT id FROM tracked_links WHERE message_id = 'msg-nopixel'`)).toHaveLength(1);
  });

  it('tracking = false: the mail is left alone', async () => {
    await set({ tracking: false, track_opens: true });
    expect(inst('msg-off')).toBe(html);
    expect(t.app.db.all(`SELECT id FROM tracked_links WHERE message_id = 'msg-off'`)).toHaveLength(0);
  });

  it('turning it back on restores the default (opens on unless switched off)', async () => {
    await set({ tracking: true });
    expect(inst('msg-back')).toContain('/t/o/msg-back.gif');
  });

  it('an anonymous contact id is allowed (mail sent before the contact is known)', () => {
    const out = t.app.services.instrumentEmail({ locationId: t.api.location, messageId: 'msg-anon', html });
    expect(out).toContain('/t/c/');
    expect(t.app.db.get(`SELECT contact_id FROM tracked_links WHERE message_id = 'msg-anon'`)!.contact_id).toBeNull();
  });
});
