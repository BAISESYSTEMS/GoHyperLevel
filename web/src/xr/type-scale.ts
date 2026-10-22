/**
 * The type scale of the Raum-Modus for text that sets its own small size.
 *
 * The app's pages declare their text sizes in px (11 px captions, 12.5 px meta lines, 13 px table text …) – fine at a desk,
 * too small at arm's length in a headset. Instead of copying hundreds of rules into a second stylesheet that goes stale with
 * every new page, this reads the style sheets that are loaded (pages bring their own CSS when their chunk loads) and
 * writes, for every rule with a font size of 10–17 px, one override that only applies while `html[data-spatial="1"]`:
 *
 *     .bd-row-sub { font-size: 12px }   →   html[data-spatial='1'] .bd-row-sub { font-size: max(14px, calc(12px * var(--sp-type))) }
 *
 * `--sp-type` comes from spatial.css (1.22; 1.15 / 1.4 for the small / large font setting). New pages are covered without
 * anybody touching this file. Rules in @media blocks keep their condition; other at-rules and rules the browser does not
 * let us read (another origin) are skipped.
 */

export const TYPE_RANGE = { min: 10, max: 17 } as const;
export const TYPE_FLOOR_PX = 14;

// CSSRule.STYLE_RULE / MEDIA_RULE (numbers, so this also runs where there is no DOM)
const STYLE_RULE = 1;
const MEDIA_RULE = 4;

interface RuleLike {
  type: number;
  selectorText?: string;
  conditionText?: string;
  media?: { mediaText: string };
  style?: { getPropertyValue(name: string): string };
  cssRules?: ArrayLike<RuleLike>;
}

/** Splits a selector list at its top-level commas (not the ones inside :is(…), [attr="a,b"] or strings). */
export function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of list) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The override for one rule, or null when its size is not one we scale (or it is not a plain px size). */
export function spatialFontRule(selectorText: string, fontSize: string): string | null {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(fontSize.trim());
  if (!m) return null;
  const px = Number(m[1]);
  if (px < TYPE_RANGE.min || px > TYPE_RANGE.max) return null;
  // The page's own roots (html, body, :root) and keyframe steps keep their size; everything else follows the scale.
  const sels = splitSelectors(selectorText)
    .filter((s) => s && !/^(html|body|:root|from|to|\d+%)\b/i.test(s) && !s.startsWith('@'))
    .map((s) => `html[data-spatial='1'] ${s}`);
  if (!sels.length) return null;
  return `${sels.join(', ')} { font-size: max(${TYPE_FLOOR_PX}px, calc(${px}px * var(--sp-type, 1.22))); }`;
}

/** All overrides for a rule list (a sheet, or the inside of an @media block). */
export function collectFontRules(rules: ArrayLike<RuleLike>, depth = 0): string[] {
  const out: string[] = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.type === STYLE_RULE && r.selectorText && r.style) {
      const css = spatialFontRule(r.selectorText, r.style.getPropertyValue('font-size'));
      if (css) out.push(css);
    } else if (r.type === MEDIA_RULE && r.cssRules && depth < 2) {
      const inner = collectFontRules(r.cssRules, depth + 1);
      const cond = r.conditionText ?? r.media?.mediaText ?? '';
      if (inner.length) out.push(`@media ${cond} { ${inner.join(' ')} }`);
    }
  }
  return out;
}

const STYLE_ID = 'pghl-spatial-type';
const done = new WeakSet<object>();

function readSheet(sheet: CSSStyleSheet): string[] {
  if (done.has(sheet)) return [];
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules; // throws for a sheet of another origin
  } catch {
    return [];
  }
  done.add(sheet);
  return collectFontRules(rules as unknown as ArrayLike<RuleLike>);
}

let installed = false;

/** Scales the text of every style sheet now and of every one that is added later (page chunks bring their own CSS). */
export function installTypeScale(doc: Document = document) {
  if (installed || typeof doc.createElement !== 'function' || !doc.head || typeof doc.styleSheets?.[Symbol.iterator] !== 'function') return;
  installed = true;
  const el = doc.createElement('style');
  el.id = STYLE_ID;
  const sync = () => {
    const add: string[] = [];
    for (const sheet of Array.from(doc.styleSheets)) {
      if (sheet.ownerNode === el) continue;
      add.push(...readSheet(sheet));
    }
    if (add.length) {
      // Last in <head>: equal specificity goes to the override.
      el.textContent = (el.textContent ?? '') + add.join('\n');
      if (el.parentNode !== doc.head || doc.head.lastElementChild !== el) doc.head.appendChild(el);
    }
  };
  doc.head.appendChild(el);
  sync();
  if (typeof MutationObserver === 'undefined') return;
  // New <link>/<style> in the head: read once loaded.
  const mo = new MutationObserver((list) => {
    for (const m of list)
      m.addedNodes.forEach((n) => {
        if (n === el) return;
        if (n instanceof HTMLLinkElement && n.rel === 'stylesheet') n.addEventListener('load', sync, { once: true });
        else if (n instanceof HTMLStyleElement) sync();
      });
  });
  mo.observe(doc.head, { childList: true });
}
