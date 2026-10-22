import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uninstallOutboundGuard } from '../server/services/outbound-guard.js';
import { startTestApp } from './helpers.js';
import { contrast } from '../web/src/theme/color.js';

/**
 * Regressions found by crawling every page of the built app with a headless browser.
 * Most of them are visual, so the checks read the source or the rendered HTML; scripts/qa-smoke.mjs repeats them in a real browser.
 */
const web = join(__dirname, '..', 'web', 'src');
const read = (p: string) => readFileSync(join(web, p), 'utf8');

describe('touch targets of the dialog ✕', () => {
  it('creator.css sizes .modal .icon-btn with a fallback – --cr-hit only exists inside .cr, elsewhere the rule was invalid and dropped the 44 px of ios.css', () => {
    const css = read('pages/creator.css').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = m[1].split(',').map((s) => s.trim());
      const outsideCr = selectors.filter((s) => !/^\.cr(\b|[\s.:[>])/.test(s));
      if (!outsideCr.length) continue;
      for (const use of m[2].matchAll(/var\(\s*--cr-hit\s*([,)])/g)) {
        expect(use[1], `${outsideCr.join(', ')} uses var(--cr-hit) without a fallback`).toBe(',');
      }
    }
    expect(css).toMatch(/\.modal \.icon-btn[^{]*\{[^}]*var\(--cr-hit, 44px\)/);
  });
});

describe('dark mode contrast', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

  it('text never takes the raw --brand (a button colour, 2.7:1 on --brand-soft in dark): --brand-text is the readable one', () => {
    const offenders: string[] = [];
    for (const f of walk(web)) {
      if (!/\.(css|tsx)$/.test(f)) continue;
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of src.matchAll(/(?<![-\w])color:\s*['"]?var\(--brand\)/g)) offenders.push(`${f.slice(web.length + 1)}: ${src.slice(m.index, m.index! + 40)}`);
    }
    expect(offenders).toEqual([]);
  });

  it('links in the amber notices (fixed light background) inherit the notice text colour', () => {
    const css = read('styles.css');
    expect(css).toMatch(/\.notice-warn a,[^{]*\.voice-warn a,[^{]*\{\s*color:\s*inherit/);
  });
});

describe('deal drawer', () => {
  it('is as tall as the screen at most – an auto grid row let it grow with its content so the Speichern button sat below the screen', () => {
    const css = read('ios/ios.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.modal-bg:has\(> \.modal\.drawer\)\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.modal\.drawer\s*\{[^}]*max-height:\s*100%/);
    expect(css).not.toMatch(/\.modal\.drawer\s*\{[^}]*max-height:\s*none/);
  });
});

describe('new contact dialog', () => {
  it('closes itself after saving – on a wide screen the list stays mounted next to the new contact (MasterDetail), so it used to stay open on top and a second click saved a duplicate', () => {
    const src = read('pages/Contacts.tsx');
    expect(src).toMatch(/<NewContact onClose=\{\(\) => setModal\(''\)\} onSaved=\{\(c\) => \(setModal\(''\), navigate\(`contacts\/\$\{c\.id\}`\)\)\}/);
  });
});

describe('timer chip', () => {
  it('has an accessible name when the label is hidden on a phone (icon only)', () => {
    expect(read('pages/PmGlobal.tsx')).toMatch(/<Link to="time" className="btn secondary small pm-chip-idle"[^>]*label=(?:"Zeiterfassung"|\{t\('Zeiterfassung'\)\})/);
    expect(read('ui.tsx')).toMatch(/aria-label=\{label\}/);
  });
});

describe('public invoice page on a phone', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(() => t.close());

  it('scrolls the items table inside the card and tightens its cells instead of widening the whole page', async () => {
    const contact = (await t.api.post('/api/contacts', { email: 'kunde@kunde.example', first_name: 'Max', last_name: 'Kunde' })).data;
    const d = (await t.api.post('/api/invoices', { contact_id: contact.id, items: [{ name: 'Website-Paket S', qty: 1, price_cents: 249000, tax_rate: 19 }] })).data;
    expect((await t.api.post(`/api/invoices/${d.id}/finalise`)).status).toBe(200);
    const page = await (await t.api.raw(`/i/${d.public_token}`)).text();
    expect(page).toMatch(/<div class="inv-scroll"><table class="inv-items">[\s\S]*<\/table><\/div>/);
    expect(page).toContain('.inv-scroll { overflow-x: auto; }');
    expect(page).toMatch(/@media \(max-width: 560px\) \{ \.inv-items td/);
  });
});

describe('cloud legal pages on a phone', () => {
  it('break long German words (Auftragsverarbeitungsvertrag) instead of widening the page to 564 px', () => {
    const src = readFileSync(join(__dirname, '..', 'server', 'services', 'cloud-pages.ts'), 'utf8');
    expect(src).toMatch(/\.legal\{[^}]*overflow-wrap:anywhere/);
    expect(src).toMatch(/\.legal h1\{font-size:clamp\(/);
  });
});

describe('demo seed', () => {
  it('records lost deals with a reason (without one the PATCH was refused, two deals stayed open and the demo showed none lost)', async () => {
    const t = await startTestApp({ demoMode: true });
    try {
      for (let i = 0; i < 600 && !(await t.api.get('/api/version')).data.demo?.last_reset; i++) await new Promise((r) => setTimeout(r, 50));
      const n = (sql: string) => Number(t.app.db.get(sql)?.n ?? 0);
      expect(n(`SELECT COUNT(*) n FROM opportunities WHERE status = 'lost' AND lost_reason != ''`)).toBeGreaterThan(0);
      expect(n(`SELECT COUNT(*) n FROM opportunities WHERE status = 'lost' AND lost_reason = ''`)).toBe(0);
    } finally {
      await t.close();
      uninstallOutboundGuard();
    }
  }, 60_000);
});

describe('open items of the crawl (fix/polish)', () => {
  const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const coarse = () => noComments(read('ios/ios.css')).match(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/)![1];

  it('touch: inbox channel chips, sortable table headers and the report-table headers on dashboards are at least 44 px', () => {
    const css = coarse();
    expect(css).toMatch(/\.chan-chip \{[^}]*min-width: 44px;[^}]*height: 44px/);
    expect(css).toMatch(/\.th-sort, \.viz-table th button \{[^}]*min-height: 44px;[^}]*min-width: 44px/);
    // ios.css loads after styles.css, so its .chan-chip height wins over the 28 px there.
    const main = read('main.tsx');
    expect(main.indexOf("import './ios/ios.css'")).toBeGreaterThan(main.indexOf("import './styles.css'"));
    expect(read('charts/ReportView.tsx')).toMatch(/<table className="t viz-table">/);
  });

  it('rating stars use --star-text (4.5:1 on the panel in light and dark) instead of #f59e0b (2.15:1 on white)', () => {
    const css = noComments(read('styles.css'));
    const light = /:root \{[^}]*--star-text: (#[0-9a-f]{6})/.exec(css)![1];
    const dark = /:root\[data-theme='dark'\] \{[^}]*--star-text: (#[0-9a-f]{6})/.exec(css)![1];
    expect(contrast(light, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark, '#121a2e')).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(/:root:not\(\[data-theme='light'\]\) \{[^}]*--star-text: #fbbf24/);
    expect(read('pages/Reviews.tsx')).not.toContain('#f59e0b');
    expect(read('pages/Reviews.tsx')).toMatch(/className="g-stars" aria-label=\{`\$\{r\.rating\} von 5 Sternen`\}/);
    for (const [file, sel] of [['styles.css', '.g-stars'], ['styles.css', '.wk-stars'], ['pages/CourseDepth.css', '.cd-stars']] as const) {
      expect(noComments(read(file)), `${file} ${sel}`).toMatch(new RegExp(`${sel.replace('.', '\\.')} \\{ color: var\\(--star-text, #b45309\\)`));
    }
  });

  it('"Leer" on the always-white canvas tile keeps a dark grey in dark mode (2.56:1 with --muted)', () => {
    const css = noComments(read('canvas/canvas.css'));
    const thumb = /\.cv-thumb \.muted \{ color: (#[0-9a-f]{6}); \}/.exec(css)![1];
    expect(contrast(thumb, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(/\.cv-preview \{[^}]*color: (#[0-9a-f]{6})/.exec(css)![1], '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(read('canvas/CanvasPage.tsx')).toContain('<span className="muted">Leer</span>');
  });

  it('community group: channel inputs and the Markdown text areas have accessible names', () => {
    const src = read('pages/Community.tsx');
    for (const what of ['Emoji', 'Name', 'Kategorie', 'Beschreibung']) expect(src).toContain(`aria-label={\`${what} Kanal \${i + 1}\`}`);
    // A <Field> label around the editor names its first toolbar button, not the text area.
    expect(read('pages/ContentKit.tsx')).toMatch(/className="md-area" aria-label=\{label\}/);
    expect(read('pages/ContentKit.tsx')).toMatch(/label = 'Text \(Markdown\)'/);
    expect(read('pages/CommunityJoin.tsx')).toMatch(/<MarkdownEditor value=\{f\.about\}.* label="Über uns \(Markdown\)" \/>/);
  });
});
