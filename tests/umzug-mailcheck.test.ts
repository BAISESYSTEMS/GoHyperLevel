import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DnsFailure, checkDomain, cleanDomain, dkimBits, mergeSpf, parentDomain, parseDmarc, spfLookups, type DnsResolver } from '../server/services/umzug-mailcheck.js';
import { sendMail } from '../server/services/email-providers.js';
import { unsubscribeHeaders } from '../server/services/messaging.js';
import { unsubscribeToken } from '../server/services/messaging.js';
import { startTestApp } from './helpers.js';
import { client } from './security-fixtures.js';

/** A zone in memory: name → TXT/CNAME/MX/A records. */
class Zone implements DnsResolver {
  txt: Record<string, string[]> = {};
  cname: Record<string, string[]> = {};
  mx: Record<string, { exchange: string; priority: number }[]> = {};
  a: Record<string, string[]> = {};
  failing = new Set<string>();
  queries: string[] = [];
  private fail(n: string) {
    this.queries.push(n);
    if (this.failing.has(n)) throw new DnsFailure('ETIMEOUT: query timed out');
  }
  async resolveTxt(n: string) {
    this.fail(n);
    return (this.txt[n] ?? []).map((s) => (s.length > 200 ? [s.slice(0, 200), s.slice(200)] : [s]));
  }
  async resolveMx(n: string) {
    this.fail(n);
    return this.mx[n] ?? [];
  }
  async resolveCname(n: string) {
    this.fail(n);
    return this.cname[n] ?? [];
  }
  async resolve4(n: string) {
    this.fail(n);
    return this.a[n] ?? [];
  }
}

const KEY2048 = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' + 'A'.repeat(342) + 'IDAQAB';
const KEY1024 = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ' + 'A'.repeat(180) + 'IDAQAB';

const good = (): Zone => {
  const z = new Zone();
  z.txt['kunde.de'] = ['v=spf1 include:spf.brevo.com ~all'];
  z.txt['spf.brevo.com'] = ['v=spf1 ip4:1.2.3.0/24 ~all'];
  z.cname['brevo1._domainkey.kunde.de'] = ['b1.kunde-de.dkim.brevo.com'];
  z.cname['brevo2._domainkey.kunde.de'] = ['b2.kunde-de.dkim.brevo.com'];
  z.txt['brevo1._domainkey.kunde.de'] = [`v=DKIM1; k=rsa; p=${KEY2048}`];
  z.txt['brevo2._domainkey.kunde.de'] = [`v=DKIM1; k=rsa; p=${KEY2048}`];
  z.txt['_dmarc.kunde.de'] = ['v=DMARC1; p=reject; rua=mailto:dmarc@kunde.de'];
  z.mx['kunde.de'] = [{ exchange: 'mail.kunde.de', priority: 10 }];
  return z;
};
const run = (z: Zone, provider: any = 'brevo', extra: any = {}) => checkDomain(z, { domain: 'kunde.de', provider, ...extra });
const by = (r: Awaited<ReturnType<typeof run>>, k: string) => r.checks.find((c) => c.key === k)!;

describe('helpers', () => {
  it('cleans domains and refuses what cannot be a sending domain', () => {
    expect(cleanDomain('Info@Kunde.DE')).toBe('kunde.de');
    expect(cleanDomain('https://www.kunde.de/seite?x=1')).toBe('www.kunde.de');
    expect(cleanDomain('Bücher.de')).toBe('xn--bcher-kva.de');
    for (const bad of ['localhost', '127.0.0.1', 'kunde', 'example.com', 'x.local', '', 'a b.de', '-x.de']) expect(cleanDomain(bad), bad).toBeUndefined();
  });
  it('finds the parent of a subdomain, also for co.uk', () => {
    expect(parentDomain('mail.kunde.de')).toBe('kunde.de');
    expect(parentDomain('kunde.de')).toBeUndefined();
    expect(parentDomain('mail.firma.co.uk')).toBe('firma.co.uk');
    expect(parentDomain('firma.co.uk')).toBeUndefined();
  });
  it('merges an include in front of the closing all', () => {
    expect(mergeSpf(undefined, 'spf.brevo.com')).toBe('v=spf1 include:spf.brevo.com ~all');
    expect(mergeSpf('v=spf1 include:_spf.google.com -all', 'spf.brevo.com')).toBe('v=spf1 include:_spf.google.com include:spf.brevo.com -all');
    expect(mergeSpf('v=spf1 mx', 'spf.brevo.com')).toBe('v=spf1 mx include:spf.brevo.com ~all');
    expect(mergeSpf('v=spf1 include:spf.brevo.com ~all', 'spf.brevo.com')).toBe('v=spf1 include:spf.brevo.com ~all');
  });
  it('parses DMARC and estimates key sizes', () => {
    expect(parseDmarc('v=DMARC1; p=quarantine; rua=mailto:a@b.de; pct=50')).toMatchObject({ p: 'quarantine', pct: '50' });
    expect(dkimBits(KEY2048)).toBe(2048);
    expect(dkimBits(KEY1024)).toBe(1024);
  });
  it('counts SPF lookups through includes without looping', async () => {
    const z = new Zone();
    z.txt['a.example'] = ['v=spf1 include:b.example mx ~all'];
    z.txt['b.example'] = ['v=spf1 include:a.example a ~all'];
    expect(await spfLookups(z, 'v=spf1 include:a.example ~all')).toBe(5);
  });
});

describe('a domain that is set up correctly', () => {
  it('is ok everywhere', async () => {
    const r = await run(good());
    expect(r.status).toBe('ok');
    expect(r.checks.map((c) => [c.key, c.status])).toEqual([['spf', 'ok'], ['dkim', 'ok'], ['dmarc', 'ok'], ['mx', 'ok']]);
    expect(by(r, 'dkim').summary).toContain('Alle 2');
    expect(r.summary).toContain('Alles in Ordnung');
  });
});

describe('what is missing, in German, with records to copy', () => {
  it('an empty domain fails with a record for every check', async () => {
    const r = await run(new Zone());
    expect(r.status).toBe('fail');
    expect(by(r, 'spf')).toMatchObject({ status: 'fail', summary: 'Kein SPF-Eintrag gefunden' });
    expect(by(r, 'spf').records[0]).toMatchObject({ type: 'TXT', host: '@', value: 'v=spf1 include:spf.brevo.com ~all' });
    expect(by(r, 'dkim').status).toBe('fail');
    expect(by(r, 'dkim').records.map((x) => x.host)).toEqual(['brevo1._domainkey', 'brevo2._domainkey']);
    expect(by(r, 'dmarc').records[0]).toMatchObject({ host: '_dmarc', value: 'v=DMARC1; p=none; rua=mailto:dmarc@kunde.de; fo=1' });
    expect(by(r, 'mx').status).toBe('fail');
    for (const c of r.checks) expect(c.steps.length, c.key).toBeGreaterThanOrEqual(2);
    expect(r.summary).toContain('SPF, DKIM, DMARC, MX (Empfang) müssen repariert werden');
  });
  it('SPF: two records, +all, too many lookups, missing provider include, no ending', async () => {
    let z = good();
    z.txt['kunde.de'] = ['v=spf1 include:spf.brevo.com ~all', 'v=spf1 mx -all'];
    expect(by(await run(z), 'spf')).toMatchObject({ status: 'fail', summary: '2 SPF-Einträge – erlaubt ist genau einer' });
    z = good();
    z.txt['kunde.de'] = ['v=spf1 include:spf.brevo.com +all'];
    expect(by(await run(z), 'spf').status).toBe('fail');
    z = good();
    z.txt['kunde.de'] = ['v=spf1 include:spf.brevo.com include:a.example ~all'];
    z.txt['a.example'] = ['v=spf1 ' + Array.from({ length: 10 }, (_, i) => `include:i${i}.example`).join(' ') + ' ~all'];
    const many = by(await run(z), 'spf');
    expect(many.status).toBe('fail');
    expect(many.problems[0]).toContain('DNS-Abfragen');
    z = good();
    z.txt['kunde.de'] = ['v=spf1 include:_spf.google.com ~all'];
    z.txt['_spf.google.com'] = ['v=spf1 ip4:1.1.1.0/24 ~all'];
    const missing = by(await run(z), 'spf');
    expect(missing.status).toBe('warn');
    expect(missing.records[0].value).toBe('v=spf1 include:_spf.google.com include:spf.brevo.com ~all');
    z = good();
    z.txt['kunde.de'] = ['v=spf1 include:spf.brevo.com'];
    expect(by(await run(z), 'spf').status).toBe('warn');
  });
  it('SPF: SES and Resend send from a subdomain, so the main SPF needs no include', async () => {
    const z = good();
    z.txt['kunde.de'] = ['v=spf1 mx ~all'];
    expect(by(await run(z, 'ses'), 'spf').status).toBe('ok');
    expect(by(await run(z, 'resend'), 'spf').summary).toContain('Unterdomain');
  });
  it('DKIM: partial, revoked, weak and strong keys', async () => {
    let z = good();
    delete z.txt['brevo2._domainkey.kunde.de'];
    delete z.cname['brevo2._domainkey.kunde.de'];
    expect(by(await run(z), 'dkim')).toMatchObject({ status: 'warn', summary: '1 von 2 DKIM-Einträgen vorhanden' });
    z = good();
    z.txt['brevo1._domainkey.kunde.de'] = ['v=DKIM1; k=rsa; p='];
    z.txt['brevo2._domainkey.kunde.de'] = ['v=DKIM1; k=rsa; p='];
    expect(by(await run(z), 'dkim')).toMatchObject({ status: 'fail', summary: 'DKIM-Schlüssel wurde zurückgezogen' });
    z = good();
    z.txt['brevo1._domainkey.kunde.de'] = [`v=DKIM1; k=rsa; p=${KEY1024}`];
    const weak = by(await run(z), 'dkim');
    expect(weak.status).toBe('ok');
    expect(weak.problems.join(' ')).toContain('1024');
  });
  it('DKIM per provider: Resend host, Postmark needs the selector, SMTP probes common selectors', async () => {
    const z = good();
    z.txt['resend._domainkey.kunde.de'] = [`p=${KEY2048}`];
    expect(by(await run(z, 'resend'), 'dkim').status).toBe('ok');
    expect(by(await run(good(), 'postmark'), 'dkim')).toMatchObject({ status: 'unknown', summary: 'Selektor fehlt – bitte aus Postmark eintragen' });
    z.txt['20240101120000pm._domainkey.kunde.de'] = [`k=rsa; p=${KEY2048}`];
    expect(by(await run(z, 'postmark', { selector: '20240101120000pm' }), 'dkim').status).toBe('ok');
    const s = good();
    s.txt['google._domainkey.kunde.de'] = [`v=DKIM1; k=rsa; p=${KEY2048}`];
    expect(by(await run(s, 'smtp', { smtpHost: 'smtp.gmail.com' }), 'dkim')).toMatchObject({ status: 'ok' });
    const none = by(await run(good(), 'smtp'), 'dkim');
    expect(none.status).toBe('warn');
    expect(none.summary).toContain('default');
  });
  it('DKIM from the provider account: the exact records, including SES tokens', async () => {
    const facts = { verified: true, dkim: ['t1', 't2', 't3'].map((t) => ({ fqdn: `${t}._domainkey.kunde.de`, type: 'CNAME' as const, value: `${t}.dkim.amazonses.com` })) };
    const z = good();
    z.txt['t1._domainkey.kunde.de'] = [`p=${KEY2048}`];
    z.cname['t1._domainkey.kunde.de'] = ['t1.dkim.amazonses.com'];
    const r = by(await run(z, 'ses', { facts }), 'dkim');
    expect(r).toMatchObject({ status: 'warn', summary: '1 von 3 DKIM-Einträgen vorhanden' });
    expect(r.records).toHaveLength(3);
    expect(r.records[1]).toMatchObject({ type: 'CNAME', host: 't2._domainkey', value: 't2.dkim.amazonses.com' });
  });
  it('DMARC: monitoring only, no reports, inherited from the parent, duplicates', async () => {
    let z = good();
    z.txt['_dmarc.kunde.de'] = ['v=DMARC1; p=none; rua=mailto:x@kunde.de'];
    expect(by(await run(z), 'dmarc')).toMatchObject({ status: 'warn', summary: 'DMARC im Beobachtungsmodus (p=none)' });
    z = good();
    z.txt['_dmarc.kunde.de'] = ['v=DMARC1; p=quarantine'];
    const norua = by(await run(z), 'dmarc');
    expect(norua.status).toBe('warn');
    expect(norua.records[0].value).toContain('rua=mailto:dmarc@kunde.de');
    z = good();
    delete z.txt['_dmarc.kunde.de'];
    z.txt['_dmarc.kunde.de'] = [];
    z.txt['_dmarc.mail.kunde.de'] = [];
    z.txt['kunde.de'] = z.txt['kunde.de'];
    z.txt['_dmarc.kunde.de'] = ['v=DMARC1; p=reject; rua=mailto:a@kunde.de'];
    const sub = await checkDomain(z, { domain: 'mail.kunde.de', provider: 'brevo' });
    expect(by(sub, 'dmarc')).toMatchObject({ status: 'ok', summary: 'DMARC aktiv: p=reject (geerbt von kunde.de)' });
    z = good();
    z.txt['_dmarc.kunde.de'] = ['v=DMARC1; p=none', 'v=DMARC1; p=reject'];
    expect(by(await run(z), 'dmarc').status).toBe('fail');
  });
  it('MX: only an A record warns, nothing fails, null-MX fails', async () => {
    let z = good();
    delete z.mx['kunde.de'];
    z.a['kunde.de'] = ['203.0.113.7'];
    expect(by(await run(z), 'mx').status).toBe('warn');
    z = good();
    delete z.mx['kunde.de'];
    expect(by(await run(z), 'mx').status).toBe('fail');
    z = good();
    z.mx['kunde.de'] = [{ exchange: '.', priority: 0 }];
    expect(by(await run(z), 'mx').status).toBe('fail');
  });
  it('a failing DNS server gives "unknown", not a false alarm', async () => {
    const z = good();
    z.failing.add('_dmarc.kunde.de');
    const r = await run(z);
    expect(by(r, 'dmarc')).toMatchObject({ status: 'unknown', summary: 'DNS-Abfrage fehlgeschlagen' });
    expect(by(r, 'spf').status).toBe('ok');
    expect(r.status).toBe('unknown');
  });
  it('Postmark and Mailgun return-path records are a recommendation, never a failure', async () => {
    const z = good();
    z.txt['pm._domainkey.kunde.de'] = [`p=${KEY2048}`];
    const r = await run(z, 'postmark', { selector: 'pm' });
    expect(by(r, 'return_path')).toMatchObject({ status: 'warn', optional: true });
    expect(by(r, 'return_path').records[0]).toMatchObject({ type: 'CNAME', host: 'pm-bounces', value: 'pm.mtasv.net' });
    expect(r.status).not.toBe('fail');
    z.cname['pm-bounces.kunde.de'] = ['pm.mtasv.net'];
    expect(by(await run(z, 'postmark', { selector: 'pm' }), 'return_path').status).toBe('ok');
  });
});

describe('one-click unsubscribe headers (RFC 8058)', () => {
  const m = { fromEmail: 'info@kunde.de', to: 'a@b.de', subject: 'Hallo', html: '<p>x</p>', text: 'x', headers: unsubscribeHeaders('https://crm.kunde.de/u/c1/tok') };
  it('every API provider passes the headers on', async () => {
    const seen: any[] = [];
    const f = async (url: any, init: any) => {
      seen.push({ url: String(url), body: init.body });
      return new Response(JSON.stringify({ id: '1', MessageID: '1', ErrorCode: 0, MessageId: '1', messageId: '<1>' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await sendMail('resend', { secrets: { api_key: 're_test_123456789' }, config: {} }, m, f);
    expect(JSON.parse(seen[0].body).headers).toEqual({ 'List-Unsubscribe': '<https://crm.kunde.de/u/c1/tok>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    await sendMail('postmark', { secrets: { server_token: 'a'.repeat(30) }, config: {} }, m, f);
    expect(JSON.parse(seen[1].body).Headers).toEqual([{ Name: 'List-Unsubscribe', Value: '<https://crm.kunde.de/u/c1/tok>' }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }]);
    await sendMail('ses', { secrets: { access_key_id: 'AKIAIOSFODNN7EXAMPLE', secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }, config: { region: 'eu-central-1' } }, m, f);
    expect(JSON.parse(seen[2].body).Content.Simple.Headers).toHaveLength(2);
    await sendMail('brevo', { secrets: { api_key: 'xkeysib-' + 'a'.repeat(30) }, config: {} }, m, f);
    expect(JSON.parse(seen[3].body).headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    await sendMail('mailgun', { secrets: { api_key: 'a'.repeat(30) }, config: { domain: 'mg.kunde.de', region: 'eu' } }, m, f);
    expect(new URLSearchParams(seen[4].body).get('h:List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
    // without headers nothing extra is sent
    await sendMail('resend', { secrets: { api_key: 're_test_123456789' }, config: {} }, { ...m, headers: undefined }, f);
    expect(JSON.parse(seen[5].body)).not.toHaveProperty('headers');
  });
});

describe('API: domains, status, check, send dialog', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let zone: Zone;
  const sent: any[] = [];
  const f = async (input: any, init: any = {}) => {
    const url = String(input);
    if (url === 'https://api.resend.com/emails') {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 're-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://api.resend.com/domains') return new Response(JSON.stringify({ data: [{ id: 'dom1', name: 'kunde.de', status: 'verified' }] }), { status: 200 });
    if (url === 'https://api.resend.com/domains/dom1')
      return new Response(JSON.stringify({ id: 'dom1', name: 'kunde.de', status: 'verified', records: [{ record: 'DKIM', name: 'resend._domainkey', type: 'TXT', ttl: 'Auto', status: 'verified', value: `p=${KEY2048}` }, { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10, status: 'verified' }, { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', status: 'verified' }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    t.app.services.channelFetch = f;
    zone = good();
    zone.txt['kunde.de'] = ['v=spf1 mx ~all'];
    zone.txt['resend._domainkey.kunde.de'] = [`p=${KEY2048}`];
    delete zone.cname['brevo1._domainkey.kunde.de'];
    zone.cname['send.kunde.de'] = [];
    zone.mx['send.kunde.de'] = [{ exchange: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 }];
    t.app.services.mailDns = zone;
  });
  afterAll(() => t.close());

  it('without a sender address there is nothing to check; in test mode nothing is sent', async () => {
    expect((await t.api.get('/api/mail-domains/status')).data.status).toBe('none');
    await t.api.patch('/api/location', { settings: { email: { provider: 'log', fromEmail: 'info@kunde.de' } } });
    expect((await t.api.get('/api/mail-domains/status')).data).toMatchObject({ status: 'log', domain: 'kunde.de' });
    const list = (await t.api.get('/api/mail-domains')).data;
    expect(list.sender).toMatchObject({ domain: 'kunde.de', active: false, added: false });
  });

  it('connects Resend, lists the sender domain and adds it', async () => {
    const r = await t.api.put('/api/settings/channels/mail/resend', { api_key: 're_test_123456789', fromEmail: 'info@kunde.de', fromName: 'Kunde', activate: true });
    expect(r.status).toBe(200);
    const list = (await t.api.get('/api/mail-domains')).data;
    expect(list.sender).toMatchObject({ domain: 'kunde.de', provider: 'resend', active: true });
    expect(list.providers.find((p: any) => p.key === 'resend').configured).toBe(true);
    expect((await t.api.post('/api/mail-domains', { domain: 'localhost' })).status).toBe(400);
    expect((await t.api.post('/api/mail-domains', { domain: 'kunde.de', selector: 'a b' })).status).toBe(400);
    const add = await t.api.post('/api/mail-domains', { domain: 'Kunde.de' });
    expect(add.status).toBe(200);
    expect(add.data).toMatchObject({ domain: 'kunde.de', status: 'new', summary: 'Noch nicht geprüft' });
    expect((await t.api.post('/api/mail-domains', { domain: 'kunde.de' })).status).toBe(400);
  });

  it('checks the domain with the records the provider account names', async () => {
    const id = (await t.api.get('/api/mail-domains')).data.domains[0].id;
    const r = await t.api.post(`/api/mail-domains/${id}/check`, {});
    expect(r.status).toBe(200);
    expect(r.data.status).toBe('ok');
    const dkim = r.data.result.checks.find((c: any) => c.key === 'dkim');
    expect(dkim.status).toBe('ok');
    const dmarc = r.data.result.checks.find((c: any) => c.key === 'dmarc');
    expect(dmarc.status).toBe('ok');
    const spf = r.data.result.checks.find((c: any) => c.key === 'spf');
    expect(spf.status).toBe('ok');
    // a second check right away is held back; a later one works
    expect((await t.api.post(`/api/mail-domains/${id}/check`, {})).status).toBe(429);
  });

  it('the send dialog asks for the verdict: a failing domain is reported with its issues', async () => {
    const list = (await t.api.get('/api/mail-domains')).data;
    t.app.db.run(`UPDATE mail_domains SET checked_at = ? WHERE id = ?`, new Date(Date.now() - 2 * 864e5).toISOString(), list.domains[0].id);
    zone.txt['_dmarc.kunde.de'] = [];
    zone.mx['kunde.de'] = [];
    const s = (await t.api.get('/api/mail-domains/status?refresh=1')).data;
    expect(s.status).toBe('fail');
    expect(s.domain).toBe('kunde.de');
    expect(s.issues.map((i: any) => i.key).sort()).toEqual(['dmarc', 'mx']);
    // without refresh the stored verdict is returned as it is
    const again = (await t.api.get('/api/mail-domains/status')).data;
    expect(again.status).toBe('fail');
  });

  it('campaign mails carry List-Unsubscribe with a link that really unsubscribes', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'anna@example.com', first_name: 'Anna' })).data;
    const camp = (await t.api.post('/api/campaigns', { name: 'Test', subject: 'Hallo', body: 'Hallo {{contact.first_name}}', filter: { tags: [] } })).data;
    const r = await t.api.post(`/api/campaigns/${camp.id}/test`, { contact_id: c.id });
    expect(r.status).toBe(200);
    const mail = sent.at(-1);
    const url = new URL(/<([^>]+)>/.exec(mail.headers['List-Unsubscribe'])![1]);
    expect(url.pathname).toBe(`/u/${c.id}/${unsubscribeToken(t.app, c.id)}`);
    expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // the link stays in the body, too
    expect(mail.html).toContain(url.pathname);
    // one POST by the mail client, no cookie, no CSRF header
    const post = await fetch(t.base + url.pathname, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ ok: true });
    expect(t.app.db.get<any>('SELECT dnd FROM contacts WHERE id = ?', c.id)!.dnd).toBe(1);
    const wrong = await fetch(t.base + `/u/${c.id}/falsch`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    expect(wrong.status).toBe(400);
  });

  it('a one-to-one message by hand has no bulk headers', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'bea@example.com', first_name: 'Bea' })).data;
    await t.api.post('/api/messages', { contact_id: c.id, channel: 'email', subject: 'Hi', body: 'Persönlich' });
    expect(sent.at(-1).headers).toBeUndefined();
  });

  it('is isolated per sub-account and needs the settings area (status: the campaigns area)', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Zweite' })).data.id;
    const mine = (await t.api.get('/api/mail-domains')).data.domains[0].id;
    const admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': other });
    expect((await admin('GET', `/api/mail-domains/${mine}`)).status).toBe(404);
    expect((await admin('POST', `/api/mail-domains/${mine}/check`, {})).status).toBe(404);
    expect((await admin('DELETE', `/api/mail-domains/${mine}`)).status).toBe(404);
    expect((await admin('GET', '/api/mail-domains')).data.domains).toEqual([]);
    await t.api.post('/api/users', { email: 'camp@example.com', password: 'passwort-1', name: 'Camp', locations: [t.api.location], permissions: ['campaigns'] });
    const member = client(t.base, { 'x-pghl': '1', 'x-location-id': t.api.location });
    await member('POST', '/api/auth/login', { email: 'camp@example.com', password: 'passwort-1' });
    expect((await member('GET', '/api/mail-domains/status')).status).toBe(200);
    expect((await member('GET', '/api/mail-domains')).status).toBe(403);
    expect((await member('POST', '/api/mail-domains', { domain: 'x.de' })).status).toBe(403);
  });
});
