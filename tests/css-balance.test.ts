import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('web/src/styles.css', () => {
  it('has balanced braces (an unclosed @media block silently scopes every later rule)', () => {
    const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
