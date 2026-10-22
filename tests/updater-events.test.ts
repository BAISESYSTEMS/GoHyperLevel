import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * A state updater must not read the click event: React may run `setX((prev) => …)` later, while rendering, when
 * `e.currentTarget` is already null. That crashed the whole app ("Die App konnte nicht starten",
 * `Cannot read properties of null (reading 'getBoundingClientRect')`) from the quick-settings button. Read what you need
 * from the event first, then pass the value: `const r = e.currentTarget.getBoundingClientRect(); setAnchor((a) => (a ? null : r));`
 */

const root = join(__dirname, '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}

const EVENT_NAMES = new Set(['e', 'ev', 'evt', 'event']);
const isSetter = (n: ts.Expression) => ts.isIdentifier(n) && /^set[A-Z]/.test(n.text);

/** `x.currentTarget` anywhere, or `.target` / `.nativeEvent` on an event-named variable, inside the updater. */
function readsEvent(fn: ts.Node): ts.Node | null {
  let hit: ts.Node | null = null;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (ts.isPropertyAccessExpression(n)) {
      const name = n.name.text;
      if (name === 'currentTarget') hit = n;
      else if ((name === 'target' || name === 'nativeEvent') && ts.isIdentifier(n.expression) && EVENT_NAMES.has(n.expression.text)) hit = n;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return hit;
}

function eventReadsInUpdaters(rel: string, code: string): string[] {
  const sf = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && isSetter(n.expression)) {
      const arg = n.arguments[0];
      if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
        const hit = readsEvent(arg.body);
        if (hit) out.push(`${rel}:${sf.getLineAndCharacterOfPosition(hit.getStart(sf)).line + 1}: ${hit.getText(sf)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('state updaters never read the event', () => {
  it('spots the pattern that crashed the quick menu', () => {
    const bad = `const B = () => <button onClick={(e) => setAnchor((a) => (a ? null : e.currentTarget.getBoundingClientRect()))} />;`;
    const good = `const B = () => <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAnchor((a) => (a ? null : r)); }} />;`;
    expect(eventReadsInUpdaters('x.tsx', bad)).toHaveLength(1);
    expect(eventReadsInUpdaters('x.tsx', good)).toEqual([]);
    expect(eventReadsInUpdaters('x.tsx', `setV((v) => ({ ...v, name: ev.target.value }));`)).toHaveLength(1);
  });

  it('holds for the whole web app', () => {
    const found = files(join(root, 'web/src')).flatMap((f) => eventReadsInUpdaters(relative(root, f).replace(/\\/g, '/'), readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  });
});
