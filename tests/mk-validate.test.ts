import { beforeEach, describe, expect, it } from 'vitest';
import { checkStatic, distance, forgetDomains, isDisposable, isRole, parseEmail, suggestDomain, validateEmail, validateMany } from '../server/services/mk-validate.js';
import { DnsFailure, type DnsResolver } from '../server/services/umzug-mailcheck.js';

/** A resolver that answers from a table; counts its lookups. */
function fake(mx: Record<string, { exchange: string; priority: number }[]>, a: Record<string, string[]> = {}, fail: string[] = []) {
  const calls: string[] = [];
  const r: DnsResolver = {
    resolveTxt: async () => [],
    resolveCname: async () => [],
    resolveMx: async (n) => {
      calls.push(`mx:${n}`);
      if (fail.includes(n)) throw new DnsFailure('SERVFAIL');
      return mx[n] ?? [];
    },
    resolve4: async (n) => {
      calls.push(`a:${n}`);
      return a[n] ?? [];
    },
  };
  return { r, calls };
}

beforeEach(() => forgetDomains());

describe('address syntax', () => {
  it('accepts normal addresses and normalises them', () => {
    expect(parseEmail('Max.Mustermann@Firma.DE')).toMatchObject({ ok: true, email: 'max.mustermann@firma.de', local: 'max.mustermann', domain: 'firma.de' });
    expect(parseEmail('  anna+news@gmx.de ')).toMatchObject({ ok: true, email: 'anna+news@gmx.de' });
    expect(parseEmail('mailto:info@firma.de')).toMatchObject({ ok: true, email: 'info@firma.de' });
    // Umlaut domains become their ASCII form.
    expect(parseEmail('kontakt@bäckerei-müller.de')).toMatchObject({ ok: true, domain: 'xn--bckerei-mller-bfb28a.de' });
  });

  it('refuses what cannot work, with a German reason', () => {
    const bad = ['', 'max', 'max@', '@firma.de', 'max@@firma.de', 'a@b@firma.de', 'max@firma', 'max@firma..de', 'max@-firma.de', 'max@firma.d', 'max meier@firma.de', '.max@firma.de', 'max.@firma.de', 'ma..x@firma.de', 'max@firma.de.', 'max@fir ma.de', `${'a'.repeat(65)}@firma.de`, `max@${'a'.repeat(64)}.de`, `${'a'.repeat(250)}@firma.de`];
    for (const e of bad) {
      const p = parseEmail(e);
      if (e === 'max@firma.de.') {
        // A trailing dot is a legal way to write the root; it is cleaned away.
        expect(p.ok, e).toBe(true);
        continue;
      }
      expect(p.ok, e).toBe(false);
      if (!p.ok) expect(p.issues[0].text.length, e).toBeGreaterThan(5);
    }
    expect(checkStatic('max@firma').verdict).toBe('invalid');
  });
});

describe('disposable and role addresses', () => {
  it('knows throw-away providers, also their subdomains', () => {
    expect(isDisposable('mailinator.com')).toBe(true);
    expect(isDisposable('abc.mailinator.com')).toBe(true);
    expect(isDisposable('wegwerfmail.de')).toBe(true);
    expect(isDisposable('gmail.com')).toBe(false);
    expect(isDisposable('mailinator.com.firma.de')).toBe(false);
    expect(checkStatic('x@yopmail.com')).toMatchObject({ verdict: 'risky', disposable: true });
  });

  it('knows role addresses', () => {
    for (const l of ['info', 'Info', 'support', 'kontakt', 'noreply', 'buero', 'rechnung', 'postmaster', 'info+shop']) expect(isRole(l), l).toBe(true);
    for (const l of ['max', 'anna.meier', 'informatik', 'sales2']) expect(isRole(l), l).toBe(false);
    expect(checkStatic('info@firma.de')).toMatchObject({ verdict: 'risky', role: true });
    expect(checkStatic('anna@firma.de')).toMatchObject({ verdict: 'ok', role: false, disposable: false });
  });

  it('marks example and test domains', () => {
    expect(checkStatic('max@example.com').issues.map((i) => i.code)).toContain('reserved');
    expect(checkStatic('max@firma.test').issues.map((i) => i.code)).toContain('reserved');
  });
});

describe('typos in popular domains', () => {
  it('measures edit distance', () => {
    expect(distance('gmail.com', 'gmail.com')).toBe(0);
    expect(distance('gmial.com', 'gmail.com')).toBe(2);
    expect(distance('abc', 'xyz', 1)).toBe(2);
  });

  it('suggests the right domain', () => {
    expect(suggestDomain('gmial.com')).toBe('gmail.com');
    expect(suggestDomain('gmail.con')).toBe('gmail.com');
    expect(suggestDomain('hotmial.com')).toBe('hotmail.com');
    expect(suggestDomain('web.dee')).toBe('web.de');
    expect(suggestDomain('t-onlin.de')).toBe('t-online.de');
    expect(suggestDomain('gmx.nte')).toBe('gmx.net');
  });

  it('leaves correct and unknown domains alone', () => {
    for (const d of ['gmail.com', 'gmx.de', 'web.de', 'firma.de', 'meine-firma.at', 'example.org', 'wetter.com']) expect(suggestDomain(d), d).toBeUndefined();
    const c = checkStatic('max@gmial.com');
    expect(c).toMatchObject({ verdict: 'risky', suggestion: 'max@gmail.com' });
    expect(c.issues[0].text).toContain('gmail.com');
  });
});

describe('the domain must be able to receive mail (MX)', () => {
  it('valid MX → ok, no MX and no address → invalid', async () => {
    const { r } = fake({ 'firma.de': [{ exchange: 'mail.firma.de', priority: 10 }] });
    expect(await validateEmail('max@firma.de', r)).toMatchObject({ verdict: 'ok', mx: true });
    const none = await validateEmail('max@keine-mails.de', r);
    expect(none).toMatchObject({ verdict: 'invalid', mx: false });
    expect(none.issues[0]).toMatchObject({ code: 'no_mx', level: 'error' });
  });

  it('falls back to the address record (implicit MX), and honours a "null MX"', async () => {
    const { r } = fake({ 'nomail.de': [{ exchange: '.', priority: 0 }] }, { 'nurweb.de': ['93.184.216.34'] });
    expect(await validateEmail('x@nurweb.de', r)).toMatchObject({ verdict: 'ok', mx: true });
    expect(await validateEmail('x@nomail.de', r)).toMatchObject({ verdict: 'invalid', mx: false });
  });

  it('a DNS outage never makes an address invalid', async () => {
    const { r } = fake({}, {}, ['firma.de']);
    const c = await validateEmail('max@firma.de', r);
    expect(c).toMatchObject({ verdict: 'ok', mx: null });
  });

  it('asks DNS once per domain, and not at all for a broken address', async () => {
    const { r, calls } = fake({ 'gmx.de': [{ exchange: 'mx.gmx.net', priority: 10 }] });
    const list = await validateMany(['a@gmx.de', 'b@gmx.de', 'c@gmx.de', 'kaputt', 'd@gmx.de'], r, 2);
    expect(list.map((c) => c.verdict)).toEqual(['ok', 'ok', 'ok', 'invalid', 'ok']);
    // The first lookups may overlap (two workers), but the cache answers the rest.
    expect(calls.filter((c) => c === 'mx:gmx.de').length).toBeLessThanOrEqual(2);
  });

  it('without a resolver only the offline checks run', async () => {
    expect(await validateEmail('max@irgendwas.de')).toMatchObject({ verdict: 'ok', mx: null });
    expect(await validateEmail('info@irgendwas.de', null)).toMatchObject({ verdict: 'risky', mx: null });
  });
});
