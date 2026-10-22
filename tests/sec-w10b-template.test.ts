import { describe, expect, it } from 'vitest';
import { render, templatePass } from '../server/core/template.js';
import { applyConditions, testCondition } from '../server/services/template-conditions.js';

/**
 * Security wave 10b: the conditional-content pass (`{{#if …}}`) runs on every template with `{{#` in the single-threaded server,
 * and templates come from sub-account users. A crafted template must never stall the process – the scan has to stay linear.
 */
const ms = (fn: () => unknown) => {
  const s = performance.now();
  fn();
  return performance.now() - s;
};

describe('conditional content stays linear on crafted templates', () => {
  it('an unclosed opener with a long run of whitespace does not backtrack (was cubic)', () => {
    const tpl = `Hallo {{#if${' '.repeat(3000)}x`;
    let out = '';
    expect(ms(() => (out = applyConditions(tpl, {})))).toBeLessThan(1000);
    expect(out).toBe(tpl);
  });

  it('the same through render() with the pass installed', () => {
    const remove = templatePass((tpl, data) => applyConditions(tpl, data));
    try {
      const tpl = `{{#unless ${' '.repeat(3000)}`;
      let out = '';
      expect(ms(() => (out = render(tpl, {})))).toBeLessThan(1000);
      expect(out).toBe(tpl);
    } finally {
      remove();
    }
  });

  it('many unclosed openers are not each scanned to the end (was quadratic)', () => {
    const tpl = '{{#if x}}'.repeat(12000);
    let out = '';
    expect(ms(() => (out = applyConditions(tpl, { x: 1 })))).toBeLessThan(1000);
    expect(out).toBe(tpl);
  });

  it('many openers without a closing brace (was quadratic)', () => {
    const tpl = '{{#if a '.repeat(12000);
    let out = '';
    expect(ms(() => (out = applyConditions(tpl, {})))).toBeLessThan(1000);
    expect(out).toBe(tpl);
  });

  it('a crafted condition does not backtrack in testCondition (was quadratic)', () => {
    const expr = `${'has'.repeat(20000)} x y`;
    expect(ms(() => expect(testCondition(expr, {})).toBe(false))).toBeLessThan(1000);
    const tpl = `{{#if ${expr}}}A{{else}}B{{/if}}`;
    let out = '';
    expect(ms(() => (out = applyConditions(tpl, {})))).toBeLessThan(1000);
    expect(out).toBe('B');
  });

  it('a big template is still resolved quickly, an oversized one is left as it is', () => {
    const block = '{{#if a}}Ja{{else}}Nein{{/if}} ';
    const big = block.repeat(20000);
    let out = '';
    expect(ms(() => (out = applyConditions(big, { a: 'x' })))).toBeLessThan(1000);
    expect(out).toBe('Ja '.repeat(20000));
    const huge = `${'x'.repeat(3_000_000)}${block}`;
    expect(applyConditions(huge, { a: 'x' })).toBe(huge);
  });
});

/** The pre-fix parser (regex based, quadratic/cubic on crafted input) – the reference the linear scanner must agree with. */
function reference(tpl: string, data: Record<string, unknown>, depth = 0): string {
  if (!tpl || !tpl.includes('{{') || depth > 20) return tpl;
  const matchBlock = (from: number, kind: string) => {
    const tag = /\{\{\s*(#(?:if|unless)\s[^}]*|else|\/(?:if|unless))\s*\}\}/g;
    tag.lastIndex = from;
    let d = 0;
    let elseAt = -1;
    let elseLen = 0;
    for (let m = tag.exec(tpl); m; m = tag.exec(tpl)) {
      const t = m[1].trim();
      if (t.startsWith('#')) d++;
      else if (t === 'else') {
        if (d === 0 && elseAt < 0) {
          elseAt = m.index;
          elseLen = m[0].length;
        }
      } else if (d === 0) {
        if (t !== `/${kind}`) return null;
        return { elseAt, elseLen, closeAt: m.index, closeLen: m[0].length };
      } else d--;
    }
    return null;
  };
  let out = '';
  let pos = 0;
  const open = /\{\{\s*#(if|unless)\s+([^}]*?)\s*\}\}/g;
  for (let m = open.exec(tpl); m; m = open.exec(tpl)) {
    const kind = m[1];
    const start = m.index + m[0].length;
    const b = matchBlock(start, kind);
    if (!b) continue;
    const yes = b.elseAt >= 0 ? tpl.slice(start, b.elseAt) : tpl.slice(start, b.closeAt);
    const no = b.elseAt >= 0 ? tpl.slice(b.elseAt + b.elseLen, b.closeAt) : '';
    const ok = testCondition(m[2], data);
    out += tpl.slice(pos, m.index) + reference((kind === 'unless' ? !ok : ok) ? yes : no, data, depth + 1);
    pos = b.closeAt + b.closeLen;
    open.lastIndex = pos;
  }
  return out + tpl.slice(pos);
}

describe('the linear scanner keeps the block semantics', () => {
  const data = { a: 'ja', b: '', n: 7, contact: { tags: ['VIP'], city: 'Köln' } };

  it('resolves the documented forms', () => {
    expect(applyConditions('{{#if contact.tags has "VIP"}}VIP{{else}}Standard{{/if}}', data)).toBe('VIP');
    expect(applyConditions('{{ #if  contact.city == "Köln" }}Köln{{ else }}woanders{{ /if }}', data)).toBe('Köln');
    expect(applyConditions('{{#unless b}}leer{{/unless}}{{#unless a}}voll{{/unless}}', data)).toBe('leer');
    expect(applyConditions('{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}', data)).toBe('AC');
    expect(applyConditions('{{#if n >= 5}}groß{{/if}}', data)).toBe('groß');
    expect(applyConditions('{{#if n>5}}A{{/if}}{{#if contact.tags hat"vip"}}B{{/if}}{{#if !b}}C{{/if}}', data)).toBe('ABC');
    expect(applyConditions('A {{#if x}} B', {})).toBe('A {{#if x}} B');
    // A wrong closing tag leaves the opener as it is; an inner complete block is still resolved.
    expect(applyConditions('{{#if a}}X{{/unless}}', data)).toBe('{{#if a}}X{{/unless}}');
    expect(applyConditions('{{#if a}}{{#if b}}x{{/if}}', data)).toBe('{{#if a}}');
  });

  it('agrees with the old parser on random small templates', () => {
    const parts = [
      '{{#if a}}', '{{#if b}}', '{{#unless a}}', '{{#unless b}}', '{{else}}', '{{/if}}', '{{/unless}}', '{{ #if  a }}', '{{ else }}',
      '{{/if }}', '{{ /unless}}', '{{#if }}', '{{#if}}', '{{#ifa}}', '{{#if a {{/if}}', '{{#if ', '{{a}}', '{{', '}}', '{', '}', ' ',
      'x', '\n', '{{#if not b}}', '{{#if a == "ja"}}', '{{ else', '{{elsewhere}}', '{{/iff}}', '{{#if\ta}}',
    ];
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 5000; i++) {
      const len = 1 + Math.floor(rnd() * 14);
      let tpl = '';
      for (let j = 0; j < len; j++) tpl += parts[Math.floor(rnd() * parts.length)];
      expect(applyConditions(tpl, data), tpl).toBe(reference(tpl, data));
    }
  });
});
