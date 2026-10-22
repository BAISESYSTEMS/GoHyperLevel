import { describe, expect, it } from 'vitest';
import {
  aggregate,
  cleanConsentSettings,
  deriveAll,
  deriveChannel,
  derivePurpose,
  gateDecision,
  ipNetwork,
  prefToken,
  purposeSentence,
  signDoi,
  textDigest,
  uaHash,
  verifyDoi,
  type LedgerEvent,
} from '../server/services/consent-model.js';

let n = 0;
const ev = (channel: string, purpose: string, action: LedgerEvent['action'], at: string, extra: Partial<LedgerEvent> = {}): LedgerEvent => ({ id: `e${++n}`, channel, purpose, action, doi_required: 0, expires_at: null, created_at: at, ...extra });

describe('consent status derivation', () => {
  it('nothing recorded is unknown and legacy', () => {
    expect(derivePurpose([], 'email', 'newsletter')).toMatchObject({ status: 'unknown', legacy: true });
  });

  it('a yes without double opt-in is confirmed, with it pending until the confirmation', () => {
    expect(derivePurpose([ev('email', 'newsletter', 'granted', '2026-01-01T10:00:00Z')], 'email', 'newsletter').status).toBe('confirmed');
    const pending = [ev('email', 'newsletter', 'granted', '2026-01-01T10:00:00Z', { doi_required: 1, expires_at: '2099-01-01T00:00:00Z' })];
    expect(derivePurpose(pending, 'email', 'newsletter', Date.parse('2026-01-02T00:00:00Z'))).toMatchObject({ status: 'pending', legacy: false });
    const done = [...pending, ev('email', 'newsletter', 'confirmed', '2026-01-01T10:05:00Z')];
    expect(derivePurpose(done, 'email', 'newsletter').status).toBe('confirmed');
  });

  it('an unconfirmed request that ran out is unknown and no longer legacy', () => {
    const e = [ev('email', 'newsletter', 'granted', '2026-01-01T10:00:00Z', { doi_required: 1, expires_at: '2026-01-08T10:00:00Z' })];
    expect(derivePurpose(e, 'email', 'newsletter', Date.parse('2026-01-09T00:00:00Z'))).toMatchObject({ status: 'unknown', legacy: false, reason: 'Bestätigung abgelaufen' });
    // The tick records it as an event too – same result.
    expect(derivePurpose([...e, ev('email', 'newsletter', 'expired', '2026-01-08T10:01:00Z')], 'email', 'newsletter')).toMatchObject({ status: 'unknown', legacy: false });
  });

  it('events are applied in time order; a later revoke wins and a later yes brings it back', () => {
    const a = ev('email', 'newsletter', 'granted', '2026-01-01T10:00:00Z');
    const r = ev('email', 'newsletter', 'revoked', '2026-02-01T10:00:00Z');
    const g = ev('email', 'newsletter', 'granted', '2026-03-01T10:00:00Z');
    expect(derivePurpose([g, a, r], 'email', 'newsletter').status).toBe('confirmed');
    expect(derivePurpose([a, r], 'email', 'newsletter').status).toBe('revoked');
  });

  it('"*" applies to every purpose of the channel, and only to that channel', () => {
    const e = [ev('email', 'newsletter', 'granted', '2026-01-01T10:00:00Z'), ev('email', 'marketing', 'granted', '2026-01-01T10:00:00Z'), ev('sms', 'marketing', 'granted', '2026-01-01T10:00:00Z'), ev('email', '*', 'revoked', '2026-02-01T10:00:00Z')];
    expect(derivePurpose(e, 'email', 'newsletter').status).toBe('revoked');
    expect(derivePurpose(e, 'email', 'marketing').status).toBe('revoked');
    expect(derivePurpose(e, 'sms', 'marketing').status).toBe('confirmed');
  });

  it('reset (DND lifted by hand) and legacy bring back "unknown, without proof"', () => {
    const e = [ev('email', 'newsletter', 'revoked', '2026-01-01T10:00:00Z'), ev('email', '*', 'reset', '2026-02-01T10:00:00Z')];
    expect(derivePurpose(e, 'email', 'newsletter')).toMatchObject({ status: 'unknown', legacy: true });
    expect(derivePurpose([ev('email', '*', 'legacy', '2026-02-01T10:00:00Z')], 'email', 'newsletter')).toMatchObject({ status: 'unknown', legacy: true, reason: 'Altbestand (ohne Nachweis)' });
  });

  it('the channel status takes the best of newsletter and marketing; DND is revoked for every communication channel', () => {
    const e = [ev('email', 'newsletter', 'revoked', '2026-01-01T10:00:00Z'), ev('email', 'marketing', 'granted', '2026-01-02T10:00:00Z')];
    expect(deriveChannel(e, 'email').status).toBe('confirmed');
    expect(deriveChannel(e, 'email', { dnd: true })).toMatchObject({ status: 'revoked', reason: 'Nicht stören (DND) aktiv' });
    expect(deriveChannel(e, 'sms', { dnd: true }).status).toBe('revoked');
    // Tracking is not a communication channel: DND does not touch it.
    expect(deriveChannel([ev('tracking', 'statistics', 'granted', '2026-01-01T10:00:00Z')], 'tracking', { dnd: true }).status).toBe('confirmed');
    const all = deriveAll(e, { dnd: false });
    expect(Object.keys(all).sort()).toEqual(['email', 'phone', 'sms', 'tracking', 'whatsapp']);
    expect(all.email.purposes.newsletter.status).toBe('revoked');
  });

  it('aggregate: confirmed beats pending beats revoked beats unknown; legacy only if all are', () => {
    const s = (status: any, legacy = false) => ({ status, legacy, reason: '', since: null, event_id: null, expires_at: null });
    expect(aggregate([s('revoked'), s('confirmed')]).status).toBe('confirmed');
    expect(aggregate([s('unknown', true), s('pending')]).status).toBe('pending');
    expect(aggregate([s('unknown', true), s('revoked')]).status).toBe('revoked');
    expect(aggregate([s('unknown', true), s('unknown', true)]).legacy).toBe(true);
    expect(aggregate([s('unknown', true), s('unknown', false)]).legacy).toBe(false);
  });
});

describe('send gate', () => {
  const st = (status: any, legacy: boolean, reason = '') => ({ status, legacy, reason });
  it('confirmed always passes, pending and revoked never', () => {
    for (const policy of ['legacy', 'confirmed'] as const) {
      expect(gateDecision(st('confirmed', false), policy)).toMatchObject({ allow: true, basis: 'confirmed' });
      expect(gateDecision(st('pending', false), policy).allow).toBe(false);
      expect(gateDecision(st('revoked', false, 'Widerrufen'), policy)).toMatchObject({ allow: false, reason: 'Einwilligung widerrufen' });
    }
    expect(gateDecision(st('revoked', false, 'Nicht stören (DND) aktiv'), 'legacy').reason).toContain('Nicht stören');
  });
  it('old contacts without proof pass only under the legacy policy; expired or declined ones never', () => {
    expect(gateDecision(st('unknown', true), 'legacy')).toMatchObject({ allow: true, basis: 'legacy' });
    expect(gateDecision(st('unknown', true), 'confirmed')).toMatchObject({ allow: false, reason: expect.stringContaining('nachgewiesene') });
    expect(gateDecision(st('unknown', false, 'Bestätigung abgelaufen'), 'legacy')).toMatchObject({ allow: false, reason: expect.stringContaining('abgelaufen') });
    expect(gateDecision(st('unknown', false, 'Abgelehnt'), 'legacy').allow).toBe(false);
  });
});

describe('minimised proof data', () => {
  it('keeps only the IP network: /24 for IPv4, /48 for IPv6', () => {
    expect(ipNetwork('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipNetwork('::ffff:198.51.100.9')).toBe('198.51.100.0/24');
    expect(ipNetwork('2001:db8:abcd:12:1:2:3:4')).toBe('2001:db8:abcd::/48');
    expect(ipNetwork('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(ipNetwork('::1')).toBe('0:0:0::/48');
    expect(ipNetwork('fe80::1%eth0')).toBe('fe80:0:0::/48');
    expect(ipNetwork('::ffff:10.1.2.3')).toBe('10.1.2.0/24');
    expect(ipNetwork('not an ip')).toBe('');
    expect(ipNetwork('')).toBe('');
    expect(ipNetwork(undefined)).toBe('');
    // Nothing of the last IPv4 octet or the lower IPv6 groups survives.
    expect(ipNetwork('203.0.113.77')).not.toContain('77');
    expect(ipNetwork('2001:db8:abcd:12:1:2:3:4')).not.toContain('12');
  });

  it('hashes the user agent and the consent text (whitespace does not make a new version)', () => {
    expect(uaHash('Mozilla/5.0 Test')).toMatch(/^[0-9a-f]{16}$/);
    expect(uaHash('Mozilla/5.0 Test')).toBe(uaHash('Mozilla/5.0 Test'));
    expect(uaHash('')).toBe('');
    expect(textDigest('Ich willige ein.')).toBe(textDigest('  Ich   willige\nein.  '));
    expect(textDigest('Ich willige ein.')).not.toBe(textDigest('Ich willige nicht ein.'));
  });
});

describe('signed links', () => {
  const secret = 'test-secret';
  it('signs and verifies the double opt-in link; forged, altered and expired links are caught', () => {
    const token = signDoi(secret, 'AbCdEfGhIjKlMnOp', Date.now() + 3600_000);
    expect(verifyDoi(secret, token)).toEqual({ id: 'AbCdEfGhIjKlMnOp', expired: false });
    expect(verifyDoi('other-secret', token)).toBeNull();
    const [id, exp, sig] = token.split('.');
    expect(verifyDoi(secret, `${id}.${exp}x.${sig}`)).toBeNull();
    expect(verifyDoi(secret, `AbCdEfGhIjKlMnOq.${exp}.${sig}`)).toBeNull();
    expect(verifyDoi(secret, `${id}.${exp}.${sig.slice(0, -1)}A`)).toBeNull();
    expect(verifyDoi(secret, 'garbage')).toBeNull();
    expect(verifyDoi(secret, undefined)).toBeNull();
    // Correctly signed but out of time: reported as expired, not as forged.
    const old = signDoi(secret, 'AbCdEfGhIjKlMnOp', Date.now() - 1000);
    expect(verifyDoi(secret, old)).toEqual({ id: 'AbCdEfGhIjKlMnOp', expired: true });
  });

  it('the preference link is bound to the contact', () => {
    expect(prefToken(secret, 'c1')).toMatch(/^[0-9a-f]{24}$/);
    expect(prefToken(secret, 'c1')).not.toBe(prefToken(secret, 'c2'));
    expect(prefToken(secret, 'c1')).not.toBe(prefToken('x', 'c1'));
  });
});

describe('consent settings', () => {
  it('fills in defaults and clamps what a client could have written', () => {
    const d = cleanConsentSettings(undefined);
    expect(d.policy).toBe('legacy');
    expect(d.doi.sources.form).toBe(true);
    expect(d.doi.expiry_hours).toBe(168);
    const s = cleanConsentSettings({ policy: 'confirmed', doi: { reminder_hours: -5, expiry_hours: 99999, subject: '', sources: { api: true, form: 'yes' }, page: { redirect_url: 'javascript:alert(1)', button: 'OK' } }, footer_link: false });
    expect(s.policy).toBe('confirmed');
    expect(s.doi.reminder_hours).toBe(0);
    expect(s.doi.expiry_hours).toBe(24 * 90);
    expect(s.doi.subject).toContain('Bitte bestätige');
    expect(s.doi.sources).toMatchObject({ api: true, form: true });
    expect(s.doi.page.redirect_url).toBe('');
    expect(s.doi.page.button).toBe('OK');
    expect(s.footer_link).toBe(false);
    expect(cleanConsentSettings({ policy: 'weird' }).policy).toBe('legacy');
    expect(cleanConsentSettings({ doi: { page: { redirect_url: 'https://example.com/danke' } } }).doi.page.redirect_url).toBe('https://example.com/danke');
  });

  it('words the purposes for the mail', () => {
    expect(purposeSentence(['newsletter'])).toBe('unseren Newsletter');
    expect(purposeSentence(['newsletter', 'marketing'])).toBe('unseren Newsletter und Angebote und Neuigkeiten');
    expect(purposeSentence([])).toBe('Nachrichten');
  });
});
