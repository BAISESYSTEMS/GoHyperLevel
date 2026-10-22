import { describe, expect, it } from 'vitest';
import { companyKey, completeness, emailKey, findGroups, ignoreKey, levenshtein, nameTokens, pairReasons, phoneKey, similarity, type DupRow } from '../server/services/contact-dedupe.js';

let n = 0;
const row = (extra: Partial<DupRow> = {}): DupRow => ({ id: `c${String(++n).padStart(5, '0')}`, first_name: '', last_name: '', email: '', phone: '', company: '', created_at: `2026-01-${String((n % 28) + 1).padStart(2, '0')}T10:00:00Z`, ...extra });

describe('keys', () => {
  it('e-mail: case and spaces do not matter, nonsense is no key', () => {
    expect(emailKey('  Anna.Muster@Firma.DE ')).toBe('anna.muster@firma.de');
    expect(emailKey('keine adresse')).toBe('');
    expect(emailKey(null)).toBe('');
  });

  it('phone: the same number in every notation, short strings are no number', () => {
    const a = phoneKey('+49 151 1234567');
    expect(a).toBe('511234567');
    for (const v of ['0151/1234567', '0049 (0)151 123 45 67'.replace('(0)', ''), '+49-151-1234567', '0151 1234567']) expect(phoneKey(v)).toBe(a);
    expect(phoneKey('+43 660 1234567')).not.toBe(a);
    expect(phoneKey('12345')).toBe('');
    expect(phoneKey('')).toBe('');
  });

  it('company: legal forms and punctuation fall away', () => {
    expect(companyKey('Muster GmbH')).toBe(companyKey('muster'));
    expect(companyKey('Müller & Söhne KG')).toBe(companyKey('Mueller Soehne'));
    expect(companyKey('Muster GmbH & Co. KG')).toBe('muster');
    expect(companyKey('')).toBe('');
  });

  it('names: order, umlauts, case', () => {
    expect(nameTokens('Hans', 'Müller')).toEqual(nameTokens('MUELLER', 'hans'));
    expect(nameTokens('Strauß', 'Eva')).toEqual(nameTokens('Eva', 'Strauss'));
  });

  it('similarity', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(similarity('john smith', 'jon smith')).toBeGreaterThan(0.88);
    expect(similarity('anna muster', 'berta schulz')).toBeLessThan(0.5);
    expect(similarity('', '')).toBe(1);
  });
});

describe('two contacts', () => {
  it('say why they look alike', () => {
    expect(pairReasons(row({ email: 'a@x.de' }), row({ email: 'A@X.de' }))).toEqual(['email']);
    expect(pairReasons(row({ phone: '+49 151 1234567' }), row({ phone: '0151-1234567' }))).toEqual(['phone']);
    expect(pairReasons(row({ first_name: 'Hans', last_name: 'Müller', company: 'Muster GmbH' }), row({ first_name: 'Hans', last_name: 'Mueller', company: 'muster' }))).toEqual(['name_company']);
    expect(pairReasons(row({ first_name: 'John', last_name: 'Smith', company: 'Acme Inc' }), row({ first_name: 'Jon', last_name: 'Smith', company: 'ACME' }))).toEqual(['name_fuzzy']);
    // first and last name swapped
    expect(pairReasons(row({ first_name: 'Müller', last_name: 'Hans', company: 'Muster' }), row({ first_name: 'Hans', last_name: 'Müller', company: 'Muster' }))).toEqual(['name_company']);
  });

  it('are not alike just because of a common name or a common company', () => {
    expect(pairReasons(row({ first_name: 'Thomas', last_name: 'Müller', company: 'Firma A' }), row({ first_name: 'Thomas', last_name: 'Müller', company: 'Firma B' }))).toEqual([]);
    expect(pairReasons(row({ first_name: 'Thomas', last_name: 'Müller', company: 'Firma A' }), row({ first_name: 'Eva', last_name: 'Schulz', company: 'Firma A' }))).toEqual([]);
    expect(pairReasons(row({ first_name: 'Hans' , company: 'Firma A' }), row({ first_name: 'Hans', company: 'Firma A' }))).toEqual([]);
    expect(pairReasons(row({ email: '' }), row({ email: '' }))).toEqual([]);
  });
});

describe('groups', () => {
  it('link over several keys (A~B by e-mail, B~C by phone), suggest the fullest record, sort the sure ones first', () => {
    const a = row({ first_name: 'Anna', email: 'anna@x.de' });
    const b = row({ first_name: 'Anna', last_name: 'Muster', email: 'ANNA@x.de', phone: '0151 1234567', company: 'Muster GmbH', city: 'Berlin', last_activity_at: '2026-05-01T00:00:00Z' });
    const c = row({ phone: '+49 151 1234567' });
    const lonely = row({ email: 'allein@x.de' });
    const fuzzy1 = row({ first_name: 'John', last_name: 'Smith', company: 'Acme' });
    const fuzzy2 = row({ first_name: 'Jon', last_name: 'Smith', company: 'Acme' });
    const groups = findGroups([a, b, c, lonely, fuzzy1, fuzzy2]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ confidence: 'high', reasons: ['email', 'phone'], keep: b.id });
    expect(groups[0].ids.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(groups[0].key).toBe([a.id, b.id, c.id].sort().join('|'));
    expect(groups[1]).toMatchObject({ confidence: 'medium', reasons: ['name_fuzzy'] });
    expect(findGroups([a, b, c, fuzzy1, fuzzy2], { min: 'high' })).toHaveLength(1);
  });

  it('a pair marked as "not the same person" no longer links', () => {
    const a = row({ email: 'team@x.de', first_name: 'Anna' });
    const b = row({ email: 'team@x.de', first_name: 'Bernd' });
    const c = row({ email: 'team@x.de', first_name: 'Carla' });
    expect(findGroups([a, b, c])[0].ids).toHaveLength(3);
    const ignored = new Set([ignoreKey(a.id, b.id), ignoreKey(a.id, c.id), ignoreKey(c.id, a.id)]);
    const g = findGroups([a, b, c], { ignored });
    // a is cut off; b and c still belong together
    expect(g).toHaveLength(1);
    expect(g[0].ids.sort()).toEqual([b.id, c.id].sort());
    expect(findGroups([a, b], { ignored })).toEqual([]);
    expect(ignoreKey('b', 'a')).toBe(ignoreKey('a', 'b'));
  });

  it('keeps the older record when two are equally full', () => {
    const a = row({ email: 'x@x.de', created_at: '2026-03-01T00:00:00Z' });
    const b = row({ email: 'x@x.de', created_at: '2025-03-01T00:00:00Z' });
    expect(findGroups([a, b])[0].keep).toBe(b.id);
    expect(completeness(row({ email: 'a@b.de', phone: '0151 1234567' }))).toBe(4);
  });

  it('copes with a big address book', () => {
    const rows: DupRow[] = [];
    // names that are really different from each other (letters from a scrambled counter), 40 people per company
    const word = (k: number) => {
      let x = (k * 2654435761) % 4294967296;
      let w = '';
      for (let i = 0; i < 6; i++) (w += 'abcdefghijklmnopqrstuvwxyz'[x % 26]), (x = Math.floor(x / 26) + k * 7);
      return w;
    };
    for (let i = 0; i < 20000; i++) rows.push(row({ first_name: word(i * 2 + 1), last_name: word(i * 2 + 7777), email: `person${i}@firma${i % 500}.example`, phone: `+49 30 ${1000000 + i}`, company: `Firma ${word(i % 500 + 99999)}` }));
    // 50 true duplicates scattered about
    for (let i = 0; i < 50; i++) rows.push({ ...rows[i * 300], id: `dup${i}`, email: rows[i * 300].email.toUpperCase() });
    const t0 = Date.now();
    const groups = findGroups(rows);
    expect(groups.length).toBeGreaterThanOrEqual(50);
    expect(groups.filter((g) => g.confidence === 'high' && g.reasons.includes('email')).length).toBeGreaterThanOrEqual(50);
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});
