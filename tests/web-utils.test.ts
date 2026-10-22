import { describe, expect, it } from 'vitest';
import { displayHost } from '../web/src/format';

describe('displayHost', () => {
  it('decodes punycode domains for display', () => {
    expect(displayHost('https://xn--mller-kva.de')).toBe('müller.de');
    expect(displayHost('https://xn--mnchen-3ya.de/x')).toBe('münchen.de');
    expect(displayHost('https://beispiel.de/')).toBe('beispiel.de');
  });
});
