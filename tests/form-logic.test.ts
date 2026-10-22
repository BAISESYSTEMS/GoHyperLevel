import { describe, expect, it } from 'vitest';
import { TEMPLATES, templateById, templateCard } from '../server/services/form-templates.js';
import { cleanAnswer, cleanFields, cleanFormSettings, type FormField } from '../server/services/form-fields.js';
import {
  CLIENT_LOGIC,
  FormulaError,
  buildScreens,
  clientSpec,
  computeValues,
  evalAst,
  fieldNumber,
  formatValue,
  formulaVars,
  interpolate,
  isVisible,
  matchRule,
  nextScreen,
  nextShown,
  pageStarts,
  parseFormula,
  pickEnding,
  rangeDays,
  reachedFields,
  resolveTarget,
  RULE_OPS,
  varName,
} from '../server/services/form-logic.js';
import { PRESETS, cleanTheme, contrast, contrastWarnings, themeOf, themeVars } from '../server/services/form-themes.js';
import { assemble, cleanReport } from '../server/services/form-analytics.js';

const f = (type: string, name: string, extra: Record<string, any> = {}): FormField => ({ id: extra.id ?? name, type: type as any, label: extra.label ?? name, name, ...extra });
const ev = (src: string, vars: Record<string, number> = {}) => evalAst(parseFormula(src), vars);

describe('rules', () => {
  it('compares answers the way the editor says', () => {
    expect(matchRule({ op: 'eq', value: 'Ja' }, 'ja ')).toBe(true);
    expect(matchRule({ op: 'eq', value: 'ja' }, ['nein', 'JA'])).toBe(true);
    expect(matchRule({ op: 'neq', value: 'ja' }, 'nein')).toBe(true);
    expect(matchRule({ op: 'contains', value: 'bau' }, 'Hausbau')).toBe(true);
    expect(matchRule({ op: 'filled' }, '  ')).toBe(false);
    expect(matchRule({ op: 'empty' }, undefined)).toBe(true);
    expect(matchRule({ op: 'gt', value: '3' }, '3,5')).toBe(true);
    expect(matchRule({ op: 'gte', value: '3' }, '3')).toBe(true);
    expect(matchRule({ op: 'lt', value: '3' }, '2.9')).toBe(true);
    expect(matchRule({ op: 'lte', value: '3' }, '3.1')).toBe(false);
    // not numbers: never greater, never smaller
    expect(matchRule({ op: 'gt', value: '3' }, 'viel')).toBe(false);
    expect(matchRule({ op: 'lt', value: 'x' }, '1')).toBe(false);
    expect(matchRule({ op: 'gt', value: '3' }, undefined)).toBe(false);
    expect(RULE_OPS).toHaveLength(9);
  });

  it('show_if looks at the answer of the field it names', () => {
    expect(isVisible({ show_if: { field: 'a', op: 'eq', value: 'x' } }, { a: 'X' })).toBe(true);
    expect(isVisible({ show_if: { field: 'a', op: 'eq', value: 'x' } }, {})).toBe(false);
    expect(isVisible({ show_if: null }, {})).toBe(true);
  });
});

describe('screens and jumps', () => {
  const fields = [
    f('heading', 'h', { id: 'h1' }),
    f('text', 'a', { id: 'a', jumps: [{ op: 'eq', value: 'weiter', goto: 'd' }, { op: 'eq', value: 'ende', goto: 'end' }, { op: 'eq', value: 'seite', goto: 'page:3' }] }),
    f('text', 'b', { id: 'b' }),
    f('page_break', 'pb1', { id: 'p1' }),
    f('text', 'c', { id: 'c' }),
    f('text', 'd', { id: 'd' }),
    f('page_break', 'pb2', { id: 'p2' }),
    f('hidden', 'hid', { id: 'hid', value: 'x' }),
    f('text', 'e', { id: 'e' }),
  ];
  it('one screen per page or one per question', () => {
    expect(buildScreens(fields, 'classic').map((s) => s.fields.map((x) => x.id))).toEqual([['h1', 'a', 'b'], ['c', 'd'], ['hid', 'e']]);
    expect(buildScreens(fields, 'typeform').map((s) => s.fields.map((x) => x.id))).toEqual([['hid', 'h1', 'a'], ['b'], ['c'], ['d'], ['e']]);
    expect(buildScreens([f('heading', 'h')], 'typeform')).toHaveLength(1);
    expect(buildScreens([], 'classic')).toEqual([{ fields: [] }]);
    expect(pageStarts(fields)).toEqual(['h1', 'c', 'e']);
  });

  it('finds the target of a jump', () => {
    const tf = buildScreens(fields, 'typeform');
    expect(resolveTarget('d', tf, fields)).toBe(3);
    expect(resolveTarget('end', tf, fields)).toBe(5);
    expect(resolveTarget('page:3', tf, fields)).toBe(4);
    expect(resolveTarget('page:9', tf, fields)).toBeUndefined();
    expect(resolveTarget('gibtsnicht', tf, fields)).toBeUndefined();
    expect(resolveTarget('page:2', buildScreens(fields, 'classic'), fields)).toBe(1);
  });

  it('goes where the first matching rule says – forward only – else on', () => {
    const tf = buildScreens(fields, 'typeform');
    expect(nextScreen(tf, fields, 0, { a: 'weiter' })).toBe(3);
    expect(nextScreen(tf, fields, 0, { a: 'ende' })).toBe(5);
    expect(nextScreen(tf, fields, 0, { a: 'seite' })).toBe(4);
    expect(nextScreen(tf, fields, 0, { a: 'sonst' })).toBe(1);
    // a jump back is ignored
    const back = [f('text', 'x', { id: 'x' }), f('text', 'y', { id: 'y', jumps: [{ op: 'filled', goto: 'x' }] }), f('text', 'z', { id: 'z' })];
    expect(nextScreen(buildScreens(back, 'typeform'), back, 1, { y: 'ja' })).toBe(2);
  });

  it('skips screens whose questions are all hidden by show_if', () => {
    const fs = [f('text', 'a', { id: 'a' }), f('text', 'b', { id: 'b', show_if: { field: 'a', op: 'eq', value: 'zeig' } }), f('text', 'c', { id: 'c' })];
    expect(nextShown(buildScreens(fs, 'typeform'), fs, 0, { a: 'nein' })).toBe(2);
    expect(nextShown(buildScreens(fs, 'typeform'), fs, 0, { a: 'zeig' })).toBe(1);
  });

  it('knows which questions count: the visitor’s path through the form', () => {
    expect(reachedFields(fields, 'typeform', { a: 'weiter' }).map((x) => x.id)).toEqual(['hid', 'h1', 'a', 'd', 'e']);
    expect(reachedFields(fields, 'typeform', { a: 'ende' }).map((x) => x.id)).toEqual(['hid', 'h1', 'a']);
    expect(reachedFields(fields, 'classic', { a: 'seite' }).map((x) => x.id)).toEqual(['h1', 'a', 'b', 'hid', 'e']);
    expect(reachedFields(fields, 'classic', {}).map((x) => x.id)).toEqual(['h1', 'a', 'b', 'c', 'd', 'hid', 'e']);
  });
});

describe('formulas', () => {
  it('calculates with the usual precedence', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('-2 + 5')).toBe(3);
    expect(ev('10 % 4 + 2,5')).toBe(4.5);
    expect(ev('flaeche * 12 + fenster * 25', { flaeche: 85, fenster: 4 })).toBe(1120);
    expect(ev('a / 0', { a: 5 })).toBe(0);
    expect(ev('a % 0', { a: 5 })).toBe(0);
    expect(ev('unbekannt + 1')).toBe(1);
  });

  it('has comparisons, logic, a ternary and if()', () => {
    expect(ev('3 > 2')).toBe(1);
    expect(ev('3 <= 2')).toBe(0);
    expect(ev('2 == 2 && 3 != 3')).toBe(0);
    expect(ev('0 || 4 > 1')).toBe(1);
    expect(ev('!0')).toBe(1);
    expect(ev('a > 5 ? 100 : 50', { a: 6 })).toBe(100);
    expect(ev('a > 5 ? 100 : a > 2 ? 50 : 10', { a: 3 })).toBe(50);
    expect(ev('if(a, 7, 8)', { a: 0 })).toBe(8);
  });

  it('has functions', () => {
    expect(ev('min(4, 2, 9)')).toBe(2);
    expect(ev('max(4, 2, 9)')).toBe(9);
    expect(ev('sum(1, 2, 3)')).toBe(6);
    expect(ev('avg(1, 2, 3, 6)')).toBe(3);
    expect(ev('round(2.5)')).toBe(3);
    expect(ev('round(-2.5)')).toBe(-3);
    expect(ev('round(1.2345, 2)')).toBe(1.23);
    expect(ev('floor(2.9) + ceil(2.1)')).toBe(5);
    expect(ev('abs(-4)')).toBe(4);
    expect(ev('sqrt(16) + sqrt(-4)')).toBe(4);
    expect(ev('pow(2, 10)')).toBe(1024);
    expect(ev('MAX(1, 2)')).toBe(2);
  });

  it('refuses what cannot be calculated, in German', () => {
    const bad = (src: string, msg: RegExp) => expect(() => parseFormula(src), src).toThrow(msg);
    bad('', /leer/);
    bad('1 +', /endet unerwartet/);
    bad('(1 + 2', /„\)“ fehlt/);
    bad('1 + * 2', /Unerwartetes/);
    bad('1 $ 2', /Unerwartetes Zeichen/);
    bad('foo(1)', /Funktion „foo“ gibt es nicht/);
    bad('round()', /braucht 1 bis 2 Werte/);
    bad('pow(1)', /braucht 2 Werte/);
    bad('1 2', /Unerwartetes/);
    bad('x'.repeat(301), /zu lang/);
    bad('('.repeat(50) + '1' + ')'.repeat(50), /verschachtelt/);
    bad(Array.from({ length: 150 }, () => '1').join('+'), /verschachtelt/);
    expect(() => parseFormula('1 +')).toThrow(FormulaError);
    expect([...formulaVars(parseFormula('a * (b + max(c, 1)) > d ? e : 0'))].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps every result a finite number', () => {
    expect(ev('pow(10, 400)')).toBe(0);
    expect(ev('1 / 3')).toBeCloseTo(0.3333, 3);
  });
});

describe('values of answers, variables, endings', () => {
  const fields = [
    f('radio', 'team', { options: ['Allein', 'Zu zweit'], points: { Allein: 1, 'Zu zweit': 4 } }),
    f('checkbox', 'extras', { options: ['A', 'B', 'C'], points: { A: 10, B: 20, C: 30 } }),
    f('rating', 'sterne', { weight: 2 }),
    f('number', 'flaeche'),
    f('date_range', 'zeitraum'),
    f('consent', 'ok'),
    f('calculator', 'preis', { formula: 'flaeche * 2 + extras + score', format: 'currency' }),
    f('text', 'frei'),
    f('checkbox', 'einzeln'),
  ];
  const raw = { team: 'Zu zweit', extras: ['A', 'C'], sterne: '4', flaeche: '12,5', zeitraum: '2026-10-01/2026-10-05', ok: 'ja', frei: '7', einzeln: 'ja' };

  it('turns answers into numbers', () => {
    expect(fieldNumber(fields[0], 'Zu zweit')).toBe(4);
    expect(fieldNumber(fields[1], ['A', 'C'])).toBe(40);
    expect(fieldNumber(fields[1], undefined)).toBe(0);
    expect(fieldNumber(fields[2], '4')).toBe(4);
    expect(fieldNumber(fields[3], '12,5')).toBe(12.5);
    expect(fieldNumber(fields[3], 'abc')).toBe(0);
    expect(fieldNumber(fields[4], '2026-10-01/2026-10-05')).toBe(5);
    expect(fieldNumber(fields[4], '2026-10-05/2026-10-01')).toBe(0);
    expect(rangeDays('kaputt')).toBe(0);
    expect(fieldNumber(fields[5], 'ja')).toBe(1);
    expect(fieldNumber(fields[8], 'ja')).toBe(1);
    expect(varName('custom.budget')).toBe('custom_budget');
    expect(varName('1abc')).toBe('_1abc');
  });

  it('computes score, calculators and variables in order', () => {
    const c = computeValues(fields, { variables: [{ name: 'doppelt', formula: 'score * 2' }, { name: 'rest', formula: 'doppelt + 1' }] }, raw);
    // score: points of the radio (4) and the checkboxes (40) + rating 4 * weight 2
    expect(c.values.score).toBe(52);
    expect(c.calculators.preis).toBe(12.5 * 2 + 40 + 52);
    expect(c.values.doppelt).toBe(104);
    expect(c.values.rest).toBe(105);
    expect(c.values.flaeche).toBe(12.5);
    expect(c.values.frei).toBe(7);
  });

  it('leaves out questions the visitor did not see, and lets a variable called score win', () => {
    const fs = [f('radio', 'a', { options: ['x'], points: { x: 5 } }), f('radio', 'b', { options: ['y'], points: { y: 7 }, show_if: { field: 'a', op: 'eq', value: 'nein' } })];
    expect(computeValues(fs, undefined, { a: 'x', b: 'y' }).values.score).toBe(5);
    expect(computeValues(fs, { variables: [{ name: 'score', formula: 'a + 100' }] }, { a: 'x' }).values.score).toBe(105);
  });

  it('picks the first ending whose range holds', () => {
    const endings = [
      { min: 8, max: null, title: 'hoch', text: '' },
      { min: 4, max: 7, title: 'mittel', text: '' },
      { min: null, max: 3, title: 'niedrig', text: '' },
      { var: 'x', min: 10, max: 10, title: 'x', text: '' },
    ];
    expect(pickEnding(endings, { score: 9 })?.title).toBe('hoch');
    expect(pickEnding(endings, { score: 7 })?.title).toBe('mittel');
    expect(pickEnding(endings, { score: 0 })?.title).toBe('niedrig');
    expect(pickEnding(endings, { score: 3.5 })).toBeUndefined();
    expect(pickEnding(endings.slice(3), { x: 10 })?.title).toBe('x');
    expect(pickEnding(undefined, {})).toBeUndefined();
  });

  it('writes numbers the German way', () => {
    expect(formatValue(1234.5)).toBe('1.234,5');
    expect(formatValue(1234.567, 'currency')).toBe('1.234,57 €');
    expect(formatValue(12, 'percent')).toBe('12 %');
    expect(interpolate('Du hast {{score}} von {{max}} Punkten {{unbekannt}}.', { score: 7.25, max: 12 })).toBe('Du hast 7,25 von 12 Punkten .');
  });
});

describe('the browser runs the same rules', () => {
  // The client copy as a real function set; a seeded random generator drives both sides through many cases.
  const L = new Function(`${CLIENT_LOGIC}; return { pfMatch, pfEval, pfCompute, pfNextShown, pfDays, pfToNum };`)() as {
    pfMatch: (r: any, a: unknown) => boolean;
    pfEval: (n: any, v: Record<string, number>) => number;
    pfCompute: (s: any, raw: Record<string, any>) => Record<string, number>;
    pfNextShown: (S: any, raw: Record<string, any>, i: number) => number;
    pfDays: (v: unknown) => number;
    pfToNum: (v: unknown) => number;
  };
  let seed = 20261005;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const same = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

  const WORDS = ['ja', 'Nein', 'JA', ' ja ', '3', '3,5', '2.5', '0', '-4', 'abc', '', ' ', 'Haus', 'hausbau', '10', '1e3'];
  it('matches rules identically', () => {
    for (let i = 0; i < 4000; i++) {
      const rule = { op: pick([...RULE_OPS]), value: pick(WORDS) };
      const ans = pick<unknown>([pick(WORDS), [pick(WORDS), pick(WORDS)], [], undefined, null, 4, ['Haus']]);
      expect(L.pfMatch(rule, ans), `${JSON.stringify(rule)} vs ${JSON.stringify(ans)}`).toBe(matchRule(rule as any, ans));
    }
  });

  const atom = () => pick(['a', 'b', 'c', 'x1', String(Math.floor(rnd() * 20)), `${Math.floor(rnd() * 9)}.${Math.floor(rnd() * 99)}`, '0', '1']);
  const gen = (d: number): string => {
    if (d <= 0) return atom();
    switch (Math.floor(rnd() * 9)) {
      case 0:
        return `(${gen(d - 1)} ${pick(['+', '-', '*', '/', '%'])} ${gen(d - 1)})`;
      case 1:
        return `${pick(['-', '!'])}${gen(d - 1)}`;
      case 2:
        return `${pick(['min', 'max', 'sum', 'avg'])}(${gen(d - 1)}, ${gen(d - 1)}, ${gen(d - 1)})`;
      case 3:
        return `${pick(['floor', 'ceil', 'abs', 'sqrt'])}(${gen(d - 1)})`;
      case 4:
        return `round(${gen(d - 1)}, ${Math.floor(rnd() * 4)})`;
      case 5:
        return `(${gen(d - 1)} ${pick(['<', '>', '<=', '>=', '==', '!='])} ${gen(d - 1)})`;
      case 6:
        return `(${gen(d - 1)} ${pick(['&&', '||'])} ${gen(d - 1)})`;
      case 7:
        return `(${gen(d - 1)} ? ${gen(d - 1)} : ${gen(d - 1)})`;
      default:
        return `if(${gen(d - 1)}, ${gen(d - 1)}, ${gen(d - 1)})`;
    }
  };
  it('calculates identically', () => {
    for (let i = 0; i < 1500; i++) {
      const src = gen(1 + Math.floor(rnd() * 4));
      if (src.length > 300) continue;
      const ast = parseFormula(src);
      const vars = { a: Math.round(rnd() * 200 - 50) / 4, b: Math.floor(rnd() * 10), c: 0, x1: rnd() * 3 };
      const server = evalAst(ast, vars);
      const client = L.pfEval(JSON.parse(JSON.stringify(ast)), vars);
      expect(same(server, client), `${src} with ${JSON.stringify(vars)}: ${server} vs ${client}`).toBe(true);
    }
  });

  it('computes score, calculators and variables identically', () => {
    for (let i = 0; i < 300; i++) {
      const fields: FormField[] = [
        f('radio', 'r', { options: ['p', 'q', 'r'], points: { p: Math.floor(rnd() * 5), q: -2, r: 7 } }),
        f('checkbox', 'cb', { options: ['x', 'y', 'z'], points: { x: 1, y: 2.5, z: 4 } }),
        f('rating', 'st', { weight: pick([0, 1, 2, -1]) }),
        f('number', 'n'),
        f('scale', 'sc', { weight: 0.5 }),
        f('date_range', 'dr'),
        f('consent', 'co'),
        f('checkbox', 'one'),
        f('text', 'tx', { show_if: { field: 'r', op: 'eq', value: 'q' } }),
        f('calculator', 'calc1', { formula: 'n * 2 + score + dr + tx' }),
        f('calculator', 'calc2', { formula: 'calc1 / (co + 1) + one', show_if: { field: 'r', op: 'neq', value: 'r' } }),
      ];
      const raw: Record<string, any> = {};
      if (rnd() < 0.8) raw.r = pick(['p', 'q', 'r']);
      if (rnd() < 0.7) raw.cb = rnd() < 0.5 ? pick(['x', 'y', 'z']) : [pick(['x', 'y']), 'z'];
      if (rnd() < 0.7) raw.st = String(1 + Math.floor(rnd() * 5));
      if (rnd() < 0.7) raw.n = pick(['12', '3,5', 'abc', '', '0']);
      if (rnd() < 0.5) raw.sc = String(Math.floor(rnd() * 10));
      if (rnd() < 0.5) raw.dr = pick(['2026-10-01/2026-10-04', '2026-10-05/2026-10-01', 'x']);
      if (rnd() < 0.5) raw.co = 'ja';
      if (rnd() < 0.5) raw.one = 'ja';
      if (rnd() < 0.5) raw.tx = pick(['4', 'x', '2,5']);
      const settings = { variables: rnd() < 0.5 ? [{ name: 'gesamt', formula: 'score + calc1 * 2' }, { name: 'spaeter', formula: 'gesamt - 1' }] : rnd() < 0.5 ? [{ name: 'score', formula: 'n + 100' }] : [] };
      const server = computeValues(fields, settings, raw).values;
      const client = L.pfCompute(JSON.parse(JSON.stringify(clientSpec(fields, settings, 'classic'))), raw);
      for (const [k, v] of Object.entries(server)) expect(same(v, client[k] ?? NaN), `${k}: ${v} vs ${client[k]} for ${JSON.stringify(raw)}`).toBe(true);
      for (const k of Object.keys(client)) expect(k in server, `client has extra ${k}`).toBe(true);
    }
  });

  it('finds the next screen identically', () => {
    for (let i = 0; i < 500; i++) {
      const n = 4 + Math.floor(rnd() * 6);
      const fields: FormField[] = [];
      for (let k = 0; k < n; k++) {
        const jumps = rnd() < 0.5 ? [{ op: pick(['eq', 'neq', 'gt', 'filled', 'contains']) as any, value: pick(['ja', '3', 'a']), goto: rnd() < 0.15 ? 'end' : `q${k + 1 + Math.floor(rnd() * (n - k))}` }] : undefined;
        fields.push(f(pick(['text', 'radio', 'heading', 'hidden', 'text']), `n${k}`, { id: `q${k}`, ...(jumps ? { jumps } : {}), ...(rnd() < 0.3 ? { show_if: { field: `n${Math.floor(rnd() * n)}`, op: pick(['eq', 'filled', 'empty']) as any, value: pick(['ja', 'a']) } } : {}) }));
        if (rnd() < 0.2) fields.push(f('page_break', `pb${k}`, { id: `pb${k}` }));
      }
      // keep only forward jump targets that exist
      for (const fd of fields) fd.jumps = fd.jumps?.filter((j) => j.goto === 'end' || fields.some((o) => o.id === j.goto));
      const mode = pick(['classic', 'typeform'] as const);
      const screens = buildScreens(fields, mode);
      const spec = JSON.parse(JSON.stringify(clientSpec(fields, undefined, mode)));
      const raw: Record<string, any> = {};
      for (let k = 0; k < n; k++) if (rnd() < 0.6) raw[`n${k}`] = pick(['ja', '3', 'a', '5', 'nein']);
      for (let s = 0; s < screens.length; s++) expect(L.pfNextShown(spec.S, raw, s), `screen ${s} mode ${mode}`).toBe(nextShown(screens, fields, s, raw));
    }
  });

  it('reads numbers and day ranges identically', () => {
    for (const v of ['3', '3,5', ' 4 ', '', 'x', undefined, null, '1e2', '-2']) expect(L.pfToNum(v)).toBe(fieldNumber(f('number', 'x'), v));
    for (const v of ['2026-10-01/2026-10-05', '2026-10-05/2026-10-01', '2026-02-30/2026-03-02', 'abc', undefined]) expect(L.pfDays(v)).toBe(rangeDays(v));
  });
});

describe('fields as the editor sends them', () => {
  it('cleans types, options and numbers', () => {
    const out = cleanFields([
      { id: 'a', type: 'rating', label: 'Sterne', name: 'sterne', max: 99 },
      { id: 'b', type: 'nps', label: 'NPS', name: 'nps', labels: ['schlecht', 'super'] },
      { id: 'c', type: 'scale', label: 'Skala', name: 'skala', min: 0, max: 20, step: 5, style: 'slider' },
      { id: 'd', type: 'radio', label: 'Wahl', name: 'wahl', options: [' ja ', '', 'nein'], points: { ja: 3, nein: 0, fremd: 9 } },
      { id: 'e', type: 'picture_choice', label: 'Bild', name: 'bild', options: ['A', 'B'], images: ['https://example.com/a.jpg', 'javascript:alert(1)'], multiple: 1 },
      { id: 'f', type: 'number', label: 'Zahl', name: 'zahl', min: 1, max: '9', weight: 2 },
      { id: 'g', type: 'erfunden', label: 'x', name: 'x' },
    ]);
    expect(out[0]).toMatchObject({ type: 'rating', max: 10 });
    expect(out[1]).toMatchObject({ type: 'nps', min: 0, max: 10, labels: ['schlecht', 'super'] });
    expect(out[2]).toMatchObject({ min: 0, max: 20, step: 5, style: 'slider' });
    expect(out[3].options).toEqual(['ja', 'nein']);
    expect(out[3].points).toEqual({ ja: 3 });
    expect(out[4]).toMatchObject({ images: ['https://example.com/a.jpg', ''], multiple: true });
    expect(out[5]).toMatchObject({ min: 1, max: 9, weight: 2 });
    expect(out[6].type).toBe('text');
  });

  it('refuses logic that cannot work', () => {
    const bad = (fields: any[], re: RegExp, mode: 'classic' | 'typeform' = 'typeform', ctx = {}) => expect(() => cleanFields(fields, { mode, ...ctx }), JSON.stringify(fields).slice(0, 80)).toThrow(re);
    bad([{ id: 'a', type: 'text', label: 'A', name: 'a', jumps: [{ op: 'eq', value: 'x', goto: 'gibtsnicht' }] }], /Sprungziel gibt es nicht/);
    bad([{ id: 'a', type: 'text', label: 'A', name: 'a' }, { id: 'b', type: 'text', label: 'B', name: 'b', jumps: [{ op: 'filled', goto: 'a' }] }], /nur vorwärts/);
    bad([{ id: 'a', type: 'text', label: 'A', name: 'a', jumps: [{ op: 'filled', goto: 'a' }] }], /nur vorwärts/);
    bad([{ id: 'a', type: 'text', label: 'A', name: 'a' }, { id: 'a', type: 'text', label: 'B', name: 'b' }], /dieselbe ID/);
    bad([{ id: 'a', type: 'calculator', label: 'Preis', name: 'preis', formula: 'flaeche * 2' }], /Variable „flaeche“ gibt es nicht/);
    bad([{ id: 'a', type: 'calculator', label: 'Preis', name: 'preis', formula: '' }], /Formel fehlt/);
    bad([{ id: 'a', type: 'calculator', label: 'Preis', name: 'preis', formula: '1 +' }], /Preis: Die Formel endet unerwartet/);
    bad([{ id: 'a', type: 'payment', label: 'Z', name: 'z', product_id: 'p1' }, { id: 'b', type: 'payment', label: 'Z2', name: 'z2', product_id: 'p1' }], /nur ein Zahlungsfeld/);
    bad([{ id: 'a', type: 'payment', label: 'Z', name: 'z', product_id: 'fremd' }], /Produkt nicht gefunden/, 'typeform', { productOk: () => false });
    expect(() => cleanFields('kaputt')).toThrow(/Felder fehlen/);
    // page jumps and jumps to the end are fine; a jump in classic mode is checked per page
    expect(() => cleanFields([{ id: 'a', type: 'text', label: 'A', name: 'a', jumps: [{ op: 'filled', goto: 'page:2' }] }, { id: 'p', type: 'page_break', label: '', name: 'p' }, { id: 'b', type: 'text', label: 'B', name: 'b' }], { mode: 'classic' })).not.toThrow();
    expect(() => cleanFields([{ id: 'a', type: 'text', label: 'A', name: 'a' }, { id: 'b', type: 'text', label: 'B', name: 'b', jumps: [{ op: 'filled', goto: 'a' }] }], { mode: 'classic' })).toThrow(/vorwärts/);
    // two questions on one classic page cannot jump to each other
    expect(() => cleanFields([{ id: 'a', type: 'text', label: 'A', name: 'a', jumps: [{ op: 'filled', goto: 'b' }] }, { id: 'b', type: 'text', label: 'B', name: 'b' }], { mode: 'classic' })).toThrow(/vorwärts/);
    expect(() => cleanFields([{ id: 'a', type: 'text', label: 'A', name: 'a', jumps: [{ op: 'filled', goto: 'b' }] }, { id: 'b', type: 'text', label: 'B', name: 'b' }], { mode: 'typeform' })).not.toThrow();
  });

  it('cleans the new settings', () => {
    const fields = cleanFields([{ id: 'q', type: 'number', label: 'Q', name: 'q' }]);
    const ok = cleanFormSettings(
      {
        mode: 'typeform',
        show_progress: 0,
        welcome: { title: 'Hallo', text: 'Los', button: '' },
        variables: [{ name: 'doppelt', formula: 'q * 2' }, { name: 'plus', formula: 'doppelt + 1' }],
        endings: [{ var: 'plus', min: '5', max: '', title: 'Viel', text: '{{plus}}', redirect_url: 'https://example.com', tag: 'viel' }],
        captcha: { enabled: 1 },
        tags: ['a'],
      },
      fields,
    );
    expect(ok).toMatchObject({ mode: 'typeform', show_progress: false, welcome: { title: 'Hallo', button: 'Los geht’s' }, captcha: { enabled: true }, tags: ['a'] });
    expect(ok.endings[0]).toMatchObject({ var: 'plus', min: 5, max: null });
    expect(cleanFormSettings({ mode: 'komisch', welcome: { title: '', text: '' } }, fields)).toMatchObject({ mode: 'classic', welcome: null });
    const bad = (s: any, re: RegExp) => expect(() => cleanFormSettings(s, fields), JSON.stringify(s)).toThrow(re);
    bad({ variables: 'x' }, /Liste erwartet/);
    bad({ variables: [{ name: '1x', formula: '1' }] }, /Variablen-Namen/);
    bad({ variables: [{ name: 'a', formula: '1' }, { name: 'a', formula: '2' }] }, /doppelt/);
    bad({ variables: [{ name: 'a', formula: 'zz + 1' }] }, /Variable „zz“ gibt es nicht/);
    bad({ endings: [{ var: 'nix', title: 't' }] }, /Variable „nix“ gibt es nicht/);
    bad({ endings: [{ min: 5, max: 2, title: 't' }] }, /größer als/);
    bad({ endings: [{ min: 'x', title: 't' }] }, /Zahlen/);
    bad({ endings: [{ redirect_url: 'javascript:alert(1)', title: 't' }] }, /https/);
  });
});

describe('answers per type', () => {
  const a = (type: string, extra: Record<string, any>, v: unknown) => cleanAnswer({ id: 'x', type: type as any, label: 'Frage', name: 'x', ...extra }, v);
  it('accepts only what fits', () => {
    expect(a('email', {}, ' a@b.de ')).toBe('a@b.de');
    expect(() => a('email', {}, 'a@b')).toThrow(/gültige E-Mail/);
    expect(a('number', { min: 1, max: 10 }, '3,5')).toBe('3.5');
    expect(() => a('number', { min: 1 }, '0')).toThrow(/mindestens 1/);
    expect(() => a('number', { max: 10 }, '11')).toThrow(/höchstens 10/);
    expect(() => a('number', {}, 'abc')).toThrow(/Zahl/);
    expect(a('rating', { max: 5 }, '4')).toBe('4');
    expect(() => a('rating', { max: 5 }, '6')).toThrow(/1 bis 5/);
    expect(() => a('rating', { max: 5 }, '2.5')).toThrow();
    expect(a('nps', {}, '0')).toBe('0');
    expect(() => a('nps', {}, '11')).toThrow(/0 bis 10/);
    expect(a('scale', { min: 1, max: 10, step: 3 }, '4')).toBe('4');
    expect(() => a('scale', { min: 1, max: 10, step: 3 }, '5')).toThrow(/ungültig/);
    expect(a('date', {}, '2026-10-05')).toBe('2026-10-05');
    expect(() => a('date', {}, '5.10.2026')).toThrow(/Datum/);
    expect(() => a('date', {}, '2026-02-31')).toThrow(/Datum/);
    expect(a('date_range', {}, '2026-10-01/2026-10-05')).toBe('01.10.2026 – 05.10.2026');
    expect(() => a('date_range', {}, '2026-10-05/2026-10-01')).toThrow(/Zeitraum/);
    expect(() => a('date_range', {}, 'x')).toThrow(/Zeitraum/);
    expect(a('ranking', { options: ['A', 'B', 'C'] }, ['C', 'A', 'B'])).toEqual(['C', 'A', 'B']);
    expect(() => a('ranking', { options: ['A', 'B', 'C'] }, ['A', 'B'])).toThrow(/Reihenfolge/);
    expect(() => a('ranking', { options: ['A', 'B'] }, ['A', 'A'])).toThrow(/Reihenfolge/);
    expect(() => a('ranking', { options: ['A', 'B'] }, ['A', 'X'])).toThrow(/Reihenfolge/);
    expect(a('picture_choice', { options: ['A', 'B'] }, 'B')).toBe('B');
    expect(() => a('picture_choice', { options: ['A', 'B'] }, ['A', 'B'])).toThrow(/Auswahl/);
    expect(a('picture_choice', { options: ['A', 'B'], multiple: true }, ['A', 'B'])).toEqual(['A', 'B']);
    expect(() => a('picture_choice', { options: ['A'] }, 'Z')).toThrow(/Auswahl/);
    expect(a('radio', { options: ['A'] }, 'beliebig')).toBe('beliebig');
    expect(a('textarea', {}, 'x'.repeat(20000)) as string).toHaveLength(10000);
  });
});

describe('themes', () => {
  it('starts from a preset and keeps what was changed on top', () => {
    const dark = cleanTheme({ preset: 'dunkel' });
    expect(dark).toMatchObject({ preset: 'dunkel', background: '#0b1020', font: 'system' });
    const changed = cleanTheme({ color: '#ff0000', radius: 99, bg_overlay: 150, align: 'center', bg_image: 'https://example.com/b.jpg' }, dark);
    expect(changed).toMatchObject({ preset: 'dunkel', color: '#ff0000', background: '#0b1020', radius: 28, bg_overlay: 80, align: 'center', bg_image: 'https://example.com/b.jpg' });
    // switching to another preset starts over
    expect(cleanTheme({ preset: 'warm' }, changed)).toMatchObject({ preset: 'warm', color: '#c2410c', align: 'left', bg_image: '' });
    expect(Object.keys(PRESETS).length).toBeGreaterThanOrEqual(8);
    for (const key of Object.keys(PRESETS)) expect(contrastWarnings(cleanTheme({ preset: key })), key).toEqual([]);
  });

  it('refuses colours, fonts and pictures it does not know', () => {
    expect(() => cleanTheme({ color: 'red' })).toThrow(/Farbe als #rrggbb/);
    expect(() => cleanTheme({ background: '#fff' })).toThrow(/#rrggbb/);
    expect(() => cleanTheme({ font: 'Comic Sans' })).toThrow(/Schriftart/);
    expect(() => cleanTheme({ preset: 'nope' })).toThrow(/Vorlage/);
    expect(() => cleanTheme({ bg_image: 'javascript:alert(1)' })).toThrow(/https/);
    expect(() => cleanTheme({ bg_image: 'https://x.com/a.jpg")}body{display:none' })).toThrow(/https/);
  });

  it('measures contrast and warns about hard-to-read looks', () => {
    expect(contrast('#000000', '#ffffff')).toBe(21);
    expect(contrast('#ffffff', '#ffffff')).toBe(1);
    const bad = cleanTheme({ text: '#bbbbbb', card: '#ffffff', color: '#ffff00' });
    const w = contrastWarnings(bad);
    expect(w.some((x) => x.startsWith('Text auf Karte'))).toBe(true);
    expect(w.some((x) => x.startsWith('Akzentfarbe'))).toBe(true);
    expect(themeOf(undefined).preset).toBe('standard');
    expect(themeOf({ color: '#123456' }).color).toBe('#123456');
    expect(themeOf({ theme: { preset: 'kaputt' } }).preset).toBe('standard');
    expect(themeVars(cleanTheme({ preset: 'elegant' }))).toContain('--pf-font:Georgia');
  });
});

describe('template gallery', () => {
  it('has at least 20 German templates that all open as valid forms', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(TEMPLATES.map((x) => x.id)).size).toBe(TEMPLATES.length);
    for (const name of ['Lead-Qualifizierung', 'Kundenumfrage mit NPS', 'Bewerbung', 'Event-Anmeldung', 'Quiz mit Auswertung', 'Angebotsanfrage Handwerk', 'Coaching-Erstgespräch']) expect(TEMPLATES.map((x) => x.name), name).toContain(name);
    for (const t of TEMPLATES) {
      const where = `${t.id}`;
      const draft = t.fields.map((x) => (x.type === 'payment' ? { ...x, product_id: 'p1' } : x));
      const fields = cleanFields(draft, { mode: t.mode, productOk: () => true });
      expect(fields.length, where).toBe(t.fields.length);
      expect(() => cleanFormSettings({ ...t.settings, mode: t.mode }, fields), where).not.toThrow();
      expect(() => cleanTheme(t.settings.theme), where).not.toThrow();
      expect(t.name.length, where).toBeGreaterThan(3);
      expect(t.description.length, where).toBeGreaterThan(20);
      expect(t.fields.some((x) => x.required), where).toBe(true);
      // every template has a consent or opt-in field when it collects contact data
      if (t.fields.some((x) => x.name === 'email')) expect(t.fields.some((x) => x.type === 'consent' || x.name === 'newsletter') || t.id === 'nps-umfrage' || t.id === 'produkt-feedback', `${where} consent`).toBe(true);
      expect(templateCard(t).fields, where).toBeGreaterThan(2);
    }
    expect(templateById('lead-qualifizierung')?.fields.some((x) => x.jumps?.length)).toBe(true);
    expect(templateById('preisrechner-maler')?.fields.some((x) => x.type === 'calculator')).toBe(true);
    expect(templateById('bestellung-zahlung')?.needs_product).toBe(true);
    expect(templateById('gibtsnicht')).toBeUndefined();
  });

  it('covers every new field type somewhere', () => {
    const used = new Set(TEMPLATES.flatMap((t) => t.fields.map((x) => x.type)));
    for (const type of ['rating', 'nps', 'scale', 'signature', 'date_range', 'ranking', 'picture_choice', 'payment', 'calculator']) expect(used.has(type as any), type).toBe(true);
  });

  it('scores the lead template the way its text promises', () => {
    const t = templateById('lead-qualifizierung')!;
    const { values } = computeValues(t.fields, t.settings, { team: '6 bis 20', budget: '1.000 bis 5.000 €', start: 'Sofort', entscheider: 'Ja, allein' });
    expect(values.score).toBe(10);
    expect(pickEnding(t.settings.endings, values)?.tag).toBe('lead:heiss');
    expect(pickEnding(t.settings.endings, computeValues(t.fields, t.settings, { team: 'Nur ich', budget: 'Kein Budget' }).values)?.tag).toBe('lead:kalt');
    const quiz = templateById('wissensquiz')!;
    const full = Object.fromEntries(quiz.fields.filter((x) => x.points).map((x) => [x.name, Object.keys(x.points!)[0]]));
    expect(computeValues(quiz.fields, quiz.settings, full).values.score).toBe(5);
  });
});

describe('analytics reports', () => {
  const ids = new Set(['a', 'b']);
  it('keeps what is a clean report and drops the rest', () => {
    const r = cleanReport({ s: 'abcdefgh12', e: [['o', '', 0], ['v', 'a', 0], ['a', 'a', 4200.7], ['v', 'zzz', 0], ['x', 'a', 1], ['v', '', 0], ['a', 'b', -5], ['l', 'b', 99999999], 'kaputt'] }, ids);
    expect(r?.events).toEqual([
      { kind: 'o', field: '', ms: 0 },
      { kind: 'v', field: 'a', ms: 0 },
      { kind: 'a', field: 'a', ms: 4201 },
      { kind: 'a', field: 'b', ms: 0 },
      { kind: 'l', field: 'b', ms: 3_600_000 },
    ]);
    expect(cleanReport({ s: 'kurz', e: [['o', '', 0]] }, ids)).toBeNull();
    expect(cleanReport({ s: 'abcdefgh12', e: 'nein' }, ids)).toBeNull();
    expect(cleanReport({ s: 'abcdefgh12', e: [['q', '', 0]] }, ids)).toBeNull();
    expect(cleanReport(null, ids)).toBeNull();
    expect(cleanReport({ s: 'abcdefgh12', e: Array.from({ length: 200 }, () => ['o', '', 0]) }, ids)?.events).toHaveLength(60);
  });

  it('turns counts into rates, funnel and the worst place', () => {
    const fields = [f('heading', 'h', { id: 'h' }), f('text', 'a', { id: 'a', label: 'Name' }), f('email', 'b', { id: 'b', label: 'E-Mail' })];
    const out = assemble(fields, { opened: 10, started: 8, submitted: 4, avg_submit_ms: 61_000, views: { a: 9, b: 6 }, answered: { a: 8, b: 4 }, avg_ms: { a: 3500, b: 400_000 }, dropoffs: { a: 1, b: 2 } });
    expect(out.totals).toEqual({ opened: 10, started: 8, submitted: 4, completion_percent: 40, abandon_percent: 60, avg_submit_seconds: 61 });
    expect(out.fields).toEqual([
      { id: 'a', label: 'Name', type: 'text', position: 1, views: 9, answered: 8, answer_percent: 89, dropoffs: 1, dropoff_percent: 11, avg_seconds: 3.5 },
      { id: 'b', label: 'E-Mail', type: 'email', position: 2, views: 6, answered: 4, answer_percent: 67, dropoffs: 2, dropoff_percent: 33, avg_seconds: 300 },
    ]);
    expect(out.funnel.map((x) => [x.step, x.count, x.percent])).toEqual([['Geöffnet', 10, 100], ['Begonnen', 8, 80], ['Name', 9, 90], ['E-Mail', 6, 60], ['Abgeschickt', 4, 40]]);
    expect(out.worst_dropoff).toEqual({ id: 'b', label: 'E-Mail', count: 2 });
    expect(assemble(fields, { opened: 0, started: 0, submitted: 0, avg_submit_ms: 0, views: {}, answered: {}, avg_ms: {}, dropoffs: {} }).totals.abandon_percent).toBe(0);
  });
});
