import { describe, expect, it } from 'vitest';
import { render } from '../server/core/template.js';

/** Merge fields: the scan stays linear – an unclosed '{{a|…' or a long run of spaces must not stall the server (DoS). */
describe('render() stays fast on hostile templates', () => {
  it('handles many unclosed fallback openers and long space runs quickly', () => {
    for (const tpl of ['{{a|'.repeat(20000), ' '.repeat(200000) + 'x', `${'{{ '.repeat(30000)}`]) {
      const t = performance.now();
      render(tpl, {});
      expect(performance.now() - t).toBeLessThan(1500);
    }
  });
  it('still fills fields, fallbacks and the leading comma rule as before', () => {
    expect(render('Hallo {{contact.first_name|Freund}}!', { contact: { first_name: 'Anna' } })).toBe('Hallo Anna!');
    expect(render('Hallo {{contact.first_name|Freund}}!', { contact: {} })).toBe('Hallo Freund!');
  });
});
