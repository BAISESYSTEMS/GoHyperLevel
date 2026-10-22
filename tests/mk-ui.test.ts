import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The e-mail marketing pages (docs/email-marketing.md), checked without a browser: lazy loading, the stylesheet and the hit targets. */

const WEB = join(__dirname, '..', 'web', 'src');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('marketing pages in the web app', () => {
  const campaigns = read('pages/Campaigns.tsx');

  it('the big pages load only when their tab opens (own chunks, not part of the campaigns page)', () => {
    expect(campaigns).toMatch(/lazyPages\(\(\) => import\('\.\/Segments'\), 'Segments'\)/);
    expect(campaigns).toMatch(/lazyPages\(\(\) => import\('\.\/EmailGallery'\), 'EmailGallery', 'GalleryPicker'\)/);
    expect(campaigns).toMatch(/lazyPages\(\(\) => import\('\.\/Deliverability'\), 'Deliverability'\)/);
    for (const page of ['Segments', 'EmailGallery', 'Deliverability', 'DeliverabilityTools']) expect(campaigns, page).not.toMatch(new RegExp(`from '\\./${page}'`));
  });

  it('every tab can be opened by its address (campaigns/segments, /gallery, /deliverability) and is not mistaken for a campaign id', () => {
    const main = read('main.tsx');
    expect(main).toContain("['segments', 'gallery', 'templates', 'deliverability', 'links'].includes(id)");
    for (const key of ['campaigns', 'segments', 'gallery', 'templates', 'deliverability', 'links']) expect(campaigns).toContain(`['${key}', '`);
  });

  it('shows the new campaign states and recipient states in German', () => {
    expect(campaigns).toContain("testing: ['A/B-Test läuft'");
    expect(campaigns).toContain("held: ['wartet auf Gewinner'");
  });
});

describe('marketing.css', () => {
  const css = strip(read('pages/marketing.css'));

  it('has balanced braces (an unclosed @media block silently scopes every later rule)', () => {
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('uses no vh without dvh and keeps buttons, chips and the delete crosses at 44 px', () => {
    expect(css).not.toMatch(/\d\s*vh\b/);
    for (const sel of ['.mk-x', '.mk-chip', '.mk-sub button', '.mk-tpl']) {
      const rule = new RegExp(`${sel.replace(/[.[\]]/g, '\\$&')}[^{]*\\{[^}]*min-(height|width): 44px`);
      expect(css, sel).toMatch(rule);
    }
    expect(css).toMatch(/\.mk-card \.btn[^{]*\{[^}]*min-height: 44px/);
    expect(css).toMatch(/\.mk-cond select[^{]*\{[^}]*min-height: 44px/);
  });

  it('follows the theme: no fixed light colours outside the e-mail preview and the WhatsApp bubble', () => {
    const lines = css.split('\n').filter((l) => /#[0-9a-f]{3,6}\b/i.test(l));
    for (const l of lines) expect(l, l).toMatch(/\.mk-prev-frame|\.mk-wa-prev|\.mk-key|\.mk-tpl|\.mk-rate/);
  });
});
