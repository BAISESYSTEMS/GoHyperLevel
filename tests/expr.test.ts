import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, ExprError, checkSyntax, evaluate, evaluateCondition, functionDocs } from '../server/services/expr.js';

/** The safe expression language of the "Code" step: behaviour first, then the sandbox (globals, prototypes, loops, limits). */

const run = (src: string, data: Record<string, unknown> = {}, opts = {}) => evaluate(src, data, opts).value;

describe('expression language: values and operators', () => {
  it('does arithmetic, comparisons and logic', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('2 ** 3 ** 2')).toBe(512);
    expect(run('10 % 4')).toBe(2);
    expect(run('7 / 2')).toBe(3.5);
    expect(run('-3 + +2')).toBe(-1);
    expect(run('1 < 2 && 2 <= 2 && 3 > 2 && 3 >= 3')).toBe(true);
    expect(run('1 == "1" && 1 != 2 && 1 === 1 && 1 !== "1"')).toBe(true);
    expect(run('null ?? "x"')).toBe('x');
    expect(run('0 ?? "x"')).toBe(0);
    expect(run('0 || "x"')).toBe('x');
    expect(run('"a" && "b"')).toBe('b');
    expect(run('!0 && !""')).toBe(true);
    expect(run('1_000 + 0.5')).toBe(1000.5);
    expect(run('2 in [1, 2, 3] && "ab" in "cabd" && "a" in {a: 1}')).toBe(true);
  });

  it('has a ternary and string functions', () => {
    expect(run('contact.age >= 18 ? "adult" : "minor"', { contact: { age: 20 } })).toBe('adult');
    expect(run('contact.age >= 18 ? "adult" : "minor"', { contact: { age: 12 } })).toBe('minor');
    expect(run('upper(trim("  hi  ")) + lower("ABC")')).toBe('HIabc');
    expect(run('replace("a-b-c", "-", "+")')).toBe('a+b+c');
    expect(run('split("a,b,c", ",")')).toEqual(['a', 'b', 'c']);
    expect(run('join(["x","y"], "/")')).toBe('x/y');
    expect(run('"Hallo".toUpperCase().slice(0, 3)')).toBe('HAL');
    expect(run('substr("abcdef", 2, 3)')).toBe('cde');
    expect(run('len("häuser")')).toBe(6);
    expect(run('contains("hello", "ell") && contains([1, 2], 2)')).toBe(true);
    expect(run('`Hallo ${contact.first_name}, du bist ${contact.age + 1}!`', { contact: { first_name: 'Ida', age: 41 } })).toBe('Hallo Ida, du bist 42!');
    expect(run('"a" + 1 + 2')).toBe('a12');
    expect(run('regex_match("Bestellung #4711 ok", "#(\\\\d+)")')).toBe('4711');
    expect(run('regex_test("abc123", "[0-9]+")')).toBe(true);
    expect(run('phone("0171 1234567")')).toBe('+491711234567');
  });

  it('reads nested data safely (missing paths are undefined, not errors)', () => {
    const data = { contact: { custom: { budget: '2.500,50', tags: ['a', 'b'] } }, event: null };
    expect(run('contact.custom.budget', data)).toBe('2.500,50');
    expect(run('number(contact.custom.budget) + 1', data)).toBe(2501.5);
    expect(run('contact.custom.nope.deeper', data)).toBeNull();
    expect(run('event.amount', data)).toBeNull();
    expect(run('contact.custom.tags[1]', data)).toBe('b');
    expect(run('contact.custom.tags[-1]', data)).toBe('b');
    expect(run('contact?.custom?.tags.length', data)).toBe(2);
    expect(run('get(contact, "custom.tags.0", "none")', data)).toBe('a');
    expect(run('get(contact, "custom.zzz", "none")', data)).toBe('none');
  });

  it('works on lists with lambdas', () => {
    expect(run('map([1, 2, 3], x => x * 2)')).toEqual([2, 4, 6]);
    expect(run('filter([1, 2, 3, 4], x => x % 2 == 0)')).toEqual([2, 4]);
    expect(run('reduce([1, 2, 3], (a, b) => a + b, 0)')).toBe(6);
    expect(run('sum([1, 2, 3]) + avg([2, 4]) + max(1, 5, 3) + min([4, 2])')).toBe(6 + 3 + 5 + 2);
    expect(run('[3, 1, 2].map(x => x + 1).join("-")')).toBe('4-2-3');
    expect(run('sort_by([{n: "b", v: 2}, {n: "a", v: 1}], x => x.v)[0].n')).toBe('a');
    expect(run('sort([3, 1, 2])')).toEqual([1, 2, 3]);
    expect(run('unique([1, 1, 2, 2, 3])')).toEqual([1, 2, 3]);
    expect(run('find([1, 2, 3], x => x > 1)')).toBe(2);
    expect(run('range(3)')).toEqual([0, 1, 2]);
    expect(run('group_count(["a", "b", "a"], x => x)')).toEqual({ a: 2, b: 1 });
    expect(run('keys({a: 1, b: 2})')).toEqual(['a', 'b']);
    expect(run('let f = (a, b) => a * b; f(6, 7)')).toBe(42);
  });

  it('runs statements: let, if/else, for, while, break, continue, return', () => {
    expect(run('let total = 0; for (let x of [1, 2, 3]) { total += x } total')).toBe(6);
    expect(run('let n = 0; while (n < 5) { n += 1; if (n == 3) { break } } return n')).toBe(3);
    expect(run('let s = ""; for (let i of range(5)) { if (i % 2) continue; s += i } s')).toBe('024');
    expect(run('let x = 5; if (x > 3) { "big" } else if (x > 1) { "mid" } else { "small" }')).toBe('big');
    expect(run('let a = [1]; a.push(2); a[0] = 9; a')).toEqual([9, 2]);
    expect(run('let o = {}; o.x = 1; o["y"] = 2; o')).toEqual({ x: 1, y: 2 });
    expect(run('return 1; 2')).toBe(1);
    expect(run('')).toBeNull();
    expect(run('// comment\n1 /* inline */ + 1')).toBe(2);
  });

  it('writes workflow variables through var and reports only what changed', () => {
    const res = evaluate('var.score = var.score + 10; var.tier = var.score > 50 ? "gold" : "silver"; var.score', { var: { score: 45, keep: 'x' } });
    expect(res.value).toBe(55);
    expect(res.vars).toEqual({ score: 55, tier: 'gold' });
  });

  it('formats and calculates dates in the sub-account time zone', () => {
    const now = new Date('2026-03-27T12:00:00Z'); // Friday
    expect(run('today()', {}, { now, tz: 'Europe/Berlin' })).toBe('2026-03-27');
    expect(run('format_date("2026-03-27T12:00:00Z", "DD.MM.YYYY HH:mm", "Europe/Berlin")')).toBe('27.03.2026 13:00');
    // +1 calendar day across the 2026-03-29 DST change keeps 12:00 local time
    expect(run('format_date(add_days("2026-03-28T11:00:00Z", 1), "DD.MM. HH:mm")', {}, { tz: 'Europe/Berlin' })).toBe('29.03. 12:00');
    expect(run('add_hours("2026-03-28T11:00:00Z", 24)')).toBe('2026-03-29T11:00:00.000Z');
    expect(run('add_business_days("2026-03-27T09:00:00Z", 1)', {}, { tz: 'UTC' })).toBe('2026-03-30T09:00:00.000Z');
    expect(run('diff_days("2026-03-01", "2026-03-31")', {}, { tz: 'Europe/Berlin' })).toBe(30);
    expect(run('weekday("2026-03-27")', {}, { now })).toBe('Freitag');
  });
});

describe('expression language: errors', () => {
  it('reports syntax and runtime errors in German with a position', () => {
    expect(checkSyntax('1 +')).toMatch(/Unerwartet/);
    expect(checkSyntax('let = 5')).toMatch(/Name der Variable/);
    expect(checkSyntax('(1 + 2')).toMatch(/„\)“ erwartet/);
    expect(checkSyntax('"offen')).toMatch(/nicht geschlossen/);
    expect(checkSyntax('1 + 1')).toBeNull();
    expect(() => run('1 / 0')).toThrow(/Division durch 0/);
    expect(() => run('unbekannt + 1')).toThrow(/„unbekannt“ ist nicht bekannt/);
    expect(() => run('x = 1')).toThrow(/nicht deklariert/);
    expect(() => run('let f = x => x; f')).toThrow(/Funktion/);
    expect(() => run('date("kein datum")')).toThrow(/kein Datum/);
    expect(() => run('1 +* 2')).toThrow(ExprError);
  });
});

describe('expression language: sandbox', () => {
  const blocked = [
    'process',
    'process.env',
    'globalThis',
    'global',
    'window',
    'require("fs")',
    'import("fs")',
    'eval("1")',
    'Function("return 1")()',
    'constructor',
    'this',
    'Object',
    'Object.keys({})',
    '"".constructor',
    '[].constructor',
    '({}).constructor',
    '(() => 1).constructor',
    'fetch("http://example.com")',
    'setTimeout(() => 1, 1)',
  ];
  for (const src of blocked) {
    it(`cannot reach ${src}`, () => {
      let out: unknown;
      try {
        out = run(src);
      } catch (e) {
        expect(e).toBeInstanceOf(ExprError);
        return;
      }
      // a read of a missing member just yields nothing – never a real object or function
      expect(out === null || out === undefined).toBe(true);
    });
  }

  it('does not expose prototypes or constructors through data or members', () => {
    const data = { contact: { name: 'x' }, list: [1, 2], text: 'abc' };
    for (const src of ['contact.__proto__', 'contact["__proto__"]', 'contact.constructor', 'list.constructor', 'text.constructor', 'contact.hasOwnProperty', 'contact.toString', 'text.__proto__', 'list["constructor"]["constructor"]']) {
      expect(run(src, data), src).toBeNull();
    }
    expect(() => run('({__proto__: {x: 1}})')).toThrow(/nicht erlaubt/);
    expect(() => run('let o = {}; o.__proto__ = {x: 1}; o')).toThrow(/nicht beschrieben/);
    expect(() => run('let o = {}; o["constructor"] = 1')).toThrow(/nicht beschrieben/);
    expect(() => run('contact.constructor()', data)).toThrow(/gibt es hier nicht als Funktion/);
    expect(() => run('text.__lookupGetter__("x")', data)).toThrow(ExprError);
    // pollution attempts leave Object.prototype alone
    try {
      run('let o = {}; o["__proto__"]["polluted"] = true; o');
    } catch {
      /* expected */
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('works on copies: the caller\'s data is never changed', () => {
    const contact = { first_name: 'Ida', tags: ['a'] };
    const event = { n: 1 };
    evaluate('contact.first_name = "Evil"; contact.tags.push("b"); event.n = 99; 1', { contact, event });
    expect(contact).toEqual({ first_name: 'Ida', tags: ['a'] });
    expect(event).toEqual({ n: 1 });
  });

  it('ignores __proto__ keys inside the input data', () => {
    const data = JSON.parse('{"contact": {"__proto__": {"admin": true}, "name": "x"}}');
    expect(run('contact.admin', data)).toBeNull();
    expect(run('keys(contact)', data)).toEqual(['name']);
  });

  it('stops endless loops and runaway recursion', () => {
    // (on a busy machine the 150 ms clock can run out before the step budget does)
    expect(() => run('while (true) {}')).toThrow(/Schritt-Grenze|Zeitgrenze/);
    expect(() => run('let i = 0; while (i >= 0) { i += 1 }')).toThrow(/Schritt-Grenze|Zeitgrenze/);
    expect(() => run('for (let a of range(10000)) { for (let b of range(10000)) { 1 } }')).toThrow(/Schritt-Grenze|Zeitgrenze/);
    expect(() => run('let f = n => f(n + 1); f(0)')).toThrow(/Funktionsaufrufe/);
    expect(() => run('let f = n => n < 2 ? n : f(n - 1) + f(n - 2); f(30)')).toThrow(/Schritt-Grenze|Zeitgrenze/);
    expect(() => run('range(1, 1000000)')).toThrow(/zu lang/);
    expect(() => run('range(0, 10, 0)')).toThrow(/Schritt darf nicht 0/);
  });

  it('enforces time and size limits', () => {
    const t = Date.now();
    expect(() => run('let s = "x"; while (true) { s = s + s }')).toThrow(/Text zu lang/);
    expect(() => run('repeat("abcdefghij", 100000)')).toThrow(/zu lang/);
    expect(() => run('let a = [1]; while (true) { a = a + a }')).toThrow(/Liste zu lang|Text zu lang/);
    expect(() => run('let a = [1]; while (true) { a.push(1) }')).toThrow(/Liste zu lang|Schritt-Grenze/);
    expect(() => evaluate('1', {}, { limits: { maxSource: 5 } }).value).not.toThrow();
    expect(() => run('1 + 1 + 1 + 1 + 1 + 1 + 1', {}, { limits: { maxSource: 5 } })).toThrow(/zu lang/);
    expect(() => run('x'.repeat(DEFAULT_LIMITS.maxSource + 1))).toThrow(/zu lang/);
    expect(() => run(`${'['.repeat(200)}${']'.repeat(200)}`)).toThrow(/tief verschachtelt/);
    expect(() => run(`${'('.repeat(500)}1${')'.repeat(500)}`)).toThrow(/tief verschachtelt/);
    expect(() => run(`${'1+'.repeat(3000)}1`)).toThrow(/Programm zu groß|zu lang/);
    expect(() => run('while (true) {}', {}, { limits: { maxSteps: 10_000_000, maxMs: 30 } })).toThrow(/Zeitgrenze/);
    expect(Date.now() - t).toBeLessThan(4000);
  });

  it('refuses regular expressions that could run for very long', () => {
    expect(() => run('regex_test("aaaaaaaaaaaaaaaaaaaaaaaa!", "(a+)+$")')).toThrow(/verschachtelte Wiederholungen/);
    expect(() => run('regex_test("x", "(a|aa)+$")')).toThrow(/verschachtelte Wiederholungen/);
    expect(() => run('regex_test("x", "(a)\\\\1")')).toThrow(/Rückverweise/);
    expect(() => run(`regex_test("x", "${'a'.repeat(300)}")`)).toThrow(/zu lang/);
    expect(() => run('regex_test("x", "[")')).toThrow(/Ungültiger/);
    // long input is cut, so even a plain pattern stays fast
    const t = Date.now();
    run('regex_test(repeat("a", 90000), "a*b")');
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('does not return functions or cyclic values', () => {
    expect(() => run('x => x')).toThrow(/Funktion/);
    expect(() => run('let a = {}; a.self = a; a')).toThrow(/sich selbst/);
    expect(run('[1, [2, {a: [3]}]]')).toEqual([1, [2, { a: [3] }]]);
    expect(run('2 ** 2000')).toBeNull();
  });

  it('documents its functions', () => {
    const docs = functionDocs();
    expect(docs.length).toBeGreaterThan(60);
    expect(docs.find((d) => d.name === 'map')?.sig).toContain('map(liste');
    expect(evaluateCondition('contact.score > 50', { contact: { score: 70 } })).toBe(true);
    expect(evaluateCondition('contact.score > 50', { contact: { score: 10 } })).toBe(false);
  });
});
