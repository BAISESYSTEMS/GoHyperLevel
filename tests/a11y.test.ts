import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { contrast } from '../web/src/theme/color';

/**
 * Accessibility rules the code itself can be checked for (the axe sweep in a browser found these; they must not come back):
 * every button has a name, clickable rows and cards open with the keyboard, the shared building blocks name their selects,
 * announce toasts and keep the focus in dialogs, and status colours stay readable.
 */

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith('.tsx') ? [p] : [];
  });
}
const FILES = tsxFiles(join(root, 'web/src')).map((f) => ({ rel: relative(root, f).replace(/\\/g, '/'), sf: ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) }));

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
function eachElement(sf: ts.SourceFile, fn: (open: Opening, children: readonly ts.JsxChild[], node: ts.Node) => void) {
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n)) fn(n.openingElement, n.children, n);
    else if (ts.isJsxSelfClosingElement(n)) fn(n, [], n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
const attrNames = (o: Opening) => o.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText());
const hasSpread = (o: Opening) => o.attributes.properties.some(ts.isJsxSpreadAttribute);
const where = (sf: ts.SourceFile, rel: string, n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

/** What a button shows: words ('text'), only icons and symbols like ✕ › + ('icon'), or nothing. Unknown expressions count as text. */
type Kind = 'text' | 'icon' | 'empty';
function kindOf(children: readonly ts.Node[]): Kind {
  let k: Kind = 'empty';
  for (const c of children) {
    const x = nodeKind(c);
    if (x === 'text') return 'text';
    if (x === 'icon') k = 'icon';
  }
  return k;
}
function textKind(s: string): Kind {
  const t = s.trim();
  return !t ? 'empty' : /[\p{L}\p{N}]/u.test(t) ? 'text' : 'icon';
}
function nodeKind(n: ts.Node): Kind {
  if (ts.isJsxText(n)) return textKind(n.text);
  if (ts.isJsxExpression(n)) return n.expression ? exprKind(n.expression) : 'empty';
  if (ts.isJsxSelfClosingElement(n)) {
    const tag = n.tagName.getText();
    if (tag === 'img') return attrNames(n).includes('alt') ? 'text' : 'icon';
    return /^[A-Z]/.test(tag) || tag === 'svg' ? 'icon' : 'empty';
  }
  if (ts.isJsxElement(n)) return n.openingElement.tagName.getText() === 'svg' ? 'icon' : kindOf(n.children);
  if (ts.isJsxFragment(n)) return kindOf(n.children);
  return 'text';
}
function exprKind(e: ts.Expression): Kind {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return textKind(e.text);
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return nodeKind(e);
  if (ts.isConditionalExpression(e)) {
    const [a, b] = [exprKind(e.whenTrue), exprKind(e.whenFalse)];
    return a === 'text' || b === 'text' ? 'text' : a === 'icon' || b === 'icon' ? 'icon' : 'empty';
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return exprKind(e.right);
  return 'text';
}

describe('accessibility in the code', () => {
  it('every icon-only button has a name (aria-label or title)', () => {
    const bad: string[] = [];
    for (const { rel, sf } of FILES)
      eachElement(sf, (o, children, n) => {
        const names = attrNames(o);
        const role = o.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === 'role');
        const isButton = o.tagName.getText() === 'button' || (role?.initializer && ts.isStringLiteral(role.initializer) && role.initializer.text === 'button');
        if (!isButton || hasSpread(o) || names.some((x) => ['aria-label', 'aria-labelledby', 'title'].includes(x))) return;
        if (kindOf(children) !== 'text') bad.push(`${where(sf, rel, n)} ${o.getText(sf).slice(0, 80)}`);
      });
    expect(bad, 'buttons that show only an icon or a symbol (✕, ›, +) need aria-label').toEqual([]);
  });

  it('clickable rows and cards are reachable with the keyboard (pressable from ui.tsx, or a role with tabIndex and keys)', () => {
    // Places where the keyboard has another way in – each with the reason.
    const ALLOWED: Record<string, string> = {
      'web/src/canvas/CanvasPage.tsx|cv-board-card': 'the card holds a link to the board (cv-thumb)',
      'web/src/pages/PmBoard.tsx|pm-card': 'the card title is a button',
      'web/src/pages/site/Tree.tsx|tn-head': 'the node label is a button',
      'web/src/pages/Workflows.tsx|wf-flow': 'a click on the background picks the trigger, which is pressable itself',
      'web/src/pages/ChatParts.tsx|tc-msg': 'tap to show the tools on touch screens; with a keyboard they show on focus',
      'web/src/pages/CollabKit.tsx|wk-prose': 'catches clicks on links inside the rendered text',
      'web/src/pages/Accounting.tsx|td': 'only stops the row click for the controls in the cell',
    };
    const bad: string[] = [];
    for (const { rel, sf } of FILES)
      eachElement(sf, (o, _children, n) => {
        const tag = o.tagName.getText();
        if (!/^(div|span|li|tr|td|img|section|article|p|header|footer|strong|b|small)$/.test(tag) || hasSpread(o)) return;
        const names = attrNames(o);
        if (!names.includes('onClick') || names.some((x) => ['role', 'tabIndex', 'onKeyDown', 'aria-hidden'].includes(x))) return;
        const text = o.getText(sf);
        if (/onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(text)) return;
        if (Object.keys(ALLOWED).some((k) => k.split('|')[0] === rel && text.includes(k.split('|')[1]))) return;
        bad.push(`${where(sf, rel, n)} ${text.replace(/\s+/g, ' ').slice(0, 100)}`);
      });
    expect(bad, 'use {...pressable(() => …)} from ui.tsx on clickable rows and cards').toEqual([]);
  });

  it('the shared building blocks name selects, announce toasts and keep the keyboard in dialogs', () => {
    const ui = read('web/src/ui.tsx');
    // a select without a visible label gets a name (`aria`, else its placeholder when it is not inside a <label>)
    expect(ui).toMatch(/export function Select\([^)]*aria\b/);
    expect(ui).toMatch(/!el\.labels\?\.length/);
    // toasts are a live region, errors an alert
    expect(ui).toMatch(/className="toasts" role="status" aria-live="polite"/);
    expect(ui).toMatch(/role=\{t\.kind === 'err' \? 'alert' : undefined\}/);
    // the Modal, the command palette and the phone menu share one focus layer: in, Tab trapped, Esc, focus back
    expect(ui).toMatch(/useFocusLayer\(box, onClose\)/);
    expect(read('web/src/nav.tsx')).toMatch(/useFocusLayer\(box, close, \{ active: show \}\)/);
    expect(read('web/src/nav.tsx')).toMatch(/role="combobox"[\s\S]*aria-activedescendant/);
    expect(read('web/src/main.tsx')).toMatch(/useFocusLayer\(side, \(\) => setOpen\(false\), \{ active: open, first: true \}\)/);
    expect(read('web/src/main.tsx')).toMatch(/aria-expanded=\{open\} aria-controls="side-nav"/);
    // rows opened with Enter show a ring
    expect(read('web/src/styles.css')).toMatch(/tr\.click:focus-visible \{ outline: 2px solid/);
  });

  it('status colours with white text on them stay readable, and links in running text are underlined', () => {
    const css = read('web/src/styles.css');
    for (const name of ['--green-fill', '--red-fill', '--yellow-fill']) {
      const value = new RegExp(`${name}: (#[0-9a-f]{6});`).exec(css)?.[1];
      expect(value, name).toBeTruthy();
      expect(contrast('#ffffff', value!), `white on ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    // filled badges and buttons use the -fill colours, never the text ones
    for (const sel of ['.btn.danger', '.toast.err', '.fb-badge', '.btn.phone-accept']) {
      const rule = css.split('\n').find((l) => l.startsWith(`${sel} {`));
      expect(rule, sel).toMatch(/background: var\(--(red|green|yellow)-fill\)/);
    }
    expect(css).toMatch(/a:not\(\[class\]\) \{ text-decoration: underline;/);
    // status text on a tint of the same colour (chips, badges) falls below 4.5:1 – it is mixed towards --text instead
    const tinted = css
      .split('\n')
      .filter((l) => /(^|[ ;{])color: var\(--(red|green|yellow)\)/.test(l) && /background: color-mix\(in srgb, var\(--(red|green|yellow)\)/.test(l));
    expect(tinted, 'use color: color-mix(in srgb, var(--red) 75%, var(--text)) on a red tint').toEqual([]);
  });

  it('the public booking page labels its fields and announces errors', () => {
    const src = read('server/modules/calendars.ts');
    for (const id of ['bk-first', 'bk-last', 'bk-email']) expect(src).toContain(`<label for="${id}">`);
    expect(src).toContain('id="err" role="alert"');
    expect(src).toMatch(/b\.setAttribute\('aria-pressed'/);
  });
});
