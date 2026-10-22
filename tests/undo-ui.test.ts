import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/** The pieces of the undo UI that can be checked without a browser: labels, the kinds the server knows, the wiring in the shell. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let ui: typeof import('../web/src/undo/shared');

beforeAll(async () => {
  (globalThis as any).localStorage = { getItem: () => null, setItem: () => undefined };
  ui = await import('../web/src/undo/shared');
  t = await startTestApp();
});
afterAll(() => t.close());

describe('undo UI', () => {
  it('knows an icon and a name for every kind of record the journal registers', () => {
    const kinds = [...t.app.services.undo.entities.keys()] as string[];
    expect(kinds.length).toBeGreaterThanOrEqual(18);
    for (const k of kinds) expect(ui.ENTITY[k], `Verlauf/Papierkorb kennt „${k}“ nicht (web/src/undo/shared.ts)`).toBeTruthy();
    // the filter lists each name once
    const names = ui.FILTER_TYPES.map(([, n]) => n);
    expect(new Set(names).size).toBe(names.length);
  });

  it('groups by day in German and counts the days left', () => {
    const now = new Date('2026-10-04T15:00:00Z');
    expect(ui.dayLabel('2026-10-04T08:00:00Z', now)).toBe('Heute');
    expect(ui.dayLabel('2026-10-03T08:00:00Z', now)).toBe('Gestern');
    expect(ui.dayLabel('2026-09-28T08:00:00Z', now)).toMatch(/Montag, 28\.09\./);
    expect(ui.daysLeft('2026-10-14T15:00:00Z', now.getTime())).toBe(10);
    expect(ui.daysLeft('2026-10-01T15:00:00Z', now.getTime())).toBe(0);
  });

  it('is wired into the shell: lazy chunks, a menu entry, the palette, the tour and the Erledigt-heute tab', () => {
    const root = join(__dirname, '..', 'web', 'src');
    const main = readFileSync(join(root, 'main.tsx'), 'utf8');
    expect(main).toContain("import('./undo/Undo')");
    expect(main).toContain("import('./pages/Trash')");
    expect(main).toContain("['trash', 'trash', 'Papierkorb', '*']");
    expect(main).toMatch(/<HistoryButton \/>/);
    expect(main).toMatch(/<UndoLayer /);
    expect(readFileSync(join(root, 'nav.tsx'), 'utf8')).toContain("'pghl:verlauf'");
    expect(readFileSync(join(root, 'pages', 'Tasks.tsx'), 'utf8')).toContain("'Erledigt heute'");
    // every write the app makes is announced to the toast (api.ts reads the journal headers)
    expect(readFileSync(join(root, 'api.ts'), 'utf8')).toContain('x-undo-id');
  });

  it('keeps hit targets big and the toast out of the way of reduced motion', () => {
    const css = readFileSync(join(__dirname, '..', 'web', 'src', 'undo', 'undo.css'), 'utf8');
    expect(css).toMatch(/--undo-hit: 48px/);
    expect(css).toMatch(/pointer: coarse[^}]*--undo-hit: 56px/s);
    expect(css).toMatch(/prefers-reduced-motion/);
    // dark mode follows the tokens, both for the system setting and the explicit one
    expect(css).toMatch(/prefers-color-scheme: dark\)[\s\S]*:root:not\(\[data-theme='light'\]\)/);
    expect(css).toMatch(/:root\[data-theme='dark'\]/);
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect([...stripped].filter((c) => c === '{').length).toBe([...stripped].filter((c) => c === '}').length);
  });
});
