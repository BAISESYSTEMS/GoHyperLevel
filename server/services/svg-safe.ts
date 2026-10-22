import { contentMatches } from '../core/files.js';

/**
 * Logo uploads (white-label logo, square mark, favicon): PNG, JPEG, WebP and SVG. Raster files go through the
 * shared content check (the bytes must match the claimed type). An SVG is refused – not "cleaned" – as soon as
 * it contains anything that could run or load something: scripts, event handlers, `javascript:` links,
 * <foreignObject>, <iframe>, animation elements, external references, a DOCTYPE with entities. What passes is a
 * plain graphic that is also served with a locked-down Content-Security-Policy (modules/core.ts /uploads/:file).
 */

export const LOGO_MAX_RASTER = 1024 * 1024;
export const LOGO_MAX_SVG = 256 * 1024;
const MAX_TAGS = 6000;

const ELEMENTS = new Set(
  [
    'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'metadata', 'style',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'textpath',
    'lineargradient', 'radialgradient', 'stop', 'pattern', 'clippath', 'mask', 'marker',
    'image',
    'filter', 'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix', 'fecomposite', 'feflood', 'femerge', 'femergenode',
    'fedropshadow', 'fecomponenttransfer', 'fefunca', 'fefuncr', 'fefuncg', 'fefuncb', 'femorphology', 'feturbulence',
    'fedisplacementmap', 'feimage', 'fetile', 'feconvolvematrix', 'fediffuselighting', 'fespecularlighting', 'fedistantlight', 'fepointlight', 'fespotlight',
  ],
);

const DANGEROUS_VALUE = /(?:java|vb)script:|data:\s*text\/html|data:\s*application|expression\s*\(|-moz-binding|behavior\s*:/i;
const RASTER_DATA = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i;

/** Every `url(...)` in a value may only point inside the file (#id) or at an embedded raster image. */
function badUrls(value: string): boolean {
  for (const m of value.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const target = m[2].trim();
    if (!(target.startsWith('#') || RASTER_DATA.test(target))) return true;
  }
  return false;
}

function badCss(css: string): boolean {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\/g, '');
  return /@import|@namespace/i.test(flat) || DANGEROUS_VALUE.test(flat) || badUrls(flat);
}

/** Why the SVG is refused, or null when it is a plain, self-contained graphic. */
export function svgProblem(source: string): string | null {
  if (source.includes('\u0000')) return 'Die Datei ist keine SVG-Grafik';
  const src = source.replace(/^﻿/, '');
  if (!/<svg[\s>]/i.test(src)) return 'Die Datei ist keine SVG-Grafik';

  const stack: string[] = [];
  let tags = 0;
  let i = 0;
  let sawRoot = false;
  let rootClosed = false;
  let inStyle = false;
  let styleText = '';

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const text = src.slice(i, lt === -1 ? undefined : lt);
    if (inStyle) styleText += text;
    else if (text.trim() && !stack.length) return 'Die Datei ist keine SVG-Grafik';
    if (lt === -1) break;
    i = lt;

    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end === -1) return 'SVG ist kein gültiges XML';
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end === -1) return 'SVG ist kein gültiges XML';
      if (inStyle) styleText += src.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      if (end === -1) return 'SVG ist kein gültiges XML';
      // Only the XML declaration; <?xml-stylesheet …?> could pull in an external style sheet.
      if (!/^<\?xml\s/i.test(src.slice(i, end + 2)) || sawRoot) return 'Nicht erlaubt: Verarbeitungsanweisung in der SVG';
      i = end + 2;
      continue;
    }
    if (src.startsWith('<!', i)) return 'Nicht erlaubt: DOCTYPE oder Entities in der SVG';

    // A tag: scan to the closing ">" while respecting quoted attribute values.
    let j = i + 1;
    let quote = '';
    for (; j < src.length; j++) {
      const ch = src[j];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    if (j >= src.length) return 'SVG ist kein gültiges XML';
    const raw = src.slice(i + 1, j);
    i = j + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase();
      if (!ELEMENTS.has(name.replace(/^svg:/, ''))) return `Nicht erlaubtes SVG-Element „${name.slice(0, 30)}“`;
      if (stack.pop() !== name) return 'SVG ist kein gültiges XML';
      if (name === 'style') {
        inStyle = false;
        if (badCss(styleText)) return 'Nicht erlaubt: <style> mit externen Verweisen oder Skriptwerten';
        styleText = '';
      }
      if (!stack.length) rootClosed = true;
      continue;
    }

    if (rootClosed) return 'Die Datei ist keine SVG-Grafik';
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const nameMatch = body.match(/^([a-zA-Z][\w:.-]*)/);
    if (!nameMatch) return 'SVG ist kein gültiges XML';
    const name = nameMatch[1].toLowerCase();
    const local = name.replace(/^svg:/, '');
    if (++tags > MAX_TAGS) return 'Die SVG-Grafik ist zu komplex';
    if (!ELEMENTS.has(local)) return `Nicht erlaubtes SVG-Element „${name.slice(0, 30)}“`;
    if (!sawRoot) {
      if (local !== 'svg') return 'Die Datei ist keine SVG-Grafik';
      sawRoot = true;
    }

    // Attributes: name="value", name='value' or a bare name.
    const attrs = body.slice(nameMatch[0].length);
    const re = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;
    for (const m of attrs.matchAll(re)) {
      const key = m[1].toLowerCase();
      const value = (m[2] ?? m[3] ?? m[4] ?? '').replace(/&#x?[0-9a-f]+;?/gi, (e) => {
        // Numeric character references can hide "javascript:" – decode them before judging.
        const hex = /^&#x/i.test(e);
        const code = parseInt(e.replace(/^&#x?/i, '').replace(/;$/, ''), hex ? 16 : 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      });
      const flat = value.replace(/[\s\u0000-\u001f]+/g, '');
      if (key.startsWith('on')) return 'Nicht erlaubt: Event-Handler in der SVG';
      if (['src', 'srcdoc', 'formaction', 'action', 'xml:base', 'xlink:actuate', 'xlink:show'].includes(key)) return `Nicht erlaubtes Attribut „${key}“`;
      if (DANGEROUS_VALUE.test(flat) || DANGEROUS_VALUE.test(value)) return 'Nicht erlaubt: Skript-Adresse in der SVG';
      if (key === 'href' || key === 'xlink:href') {
        const v = value.trim();
        const okLocal = v.startsWith('#');
        const okImage = local === 'image' && RASTER_DATA.test(v);
        if (!okLocal && !okImage) return 'Nicht erlaubt: Verweis nach außen in der SVG (nur #id oder eingebettete Bilder)';
      } else if (key === 'style' || /url\(/i.test(value)) {
        if (badCss(value)) return 'Nicht erlaubt: externer Verweis in der SVG';
      }
    }
    if (local === 'style') {
      if (!selfClose) {
        inStyle = true;
        styleText = '';
      }
    }
    if (!selfClose) stack.push(name);
    else if (!stack.length) rootClosed = true;
  }
  if (!sawRoot || stack.length) return 'SVG ist kein gültiges XML';
  return null;
}

export type LogoCheck = { ok: true; mime: string; ext: string; buf: Buffer } | { ok: false; error: string };

const LOGO_TYPES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg' };

/** Checks a logo given as a data: URL; returns the bytes and the extension to store them under. */
export function checkLogoDataUrl(dataUrl: unknown): LogoCheck {
  const m = String(dataUrl ?? '').match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return { ok: false, error: 'Erwarte eine data:-URL' };
  const mime = m[1].toLowerCase();
  if (!LOGO_TYPES[mime]) return { ok: false, error: 'Nur PNG, JPG, WebP oder SVG' };
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return { ok: false, error: 'Die Datei ist leer' };
  if (mime === 'image/svg+xml') {
    if (buf.length > LOGO_MAX_SVG) return { ok: false, error: `SVG größer als ${LOGO_MAX_SVG / 1024} KB` };
    const problem = svgProblem(buf.toString('utf8'));
    if (problem) return { ok: false, error: problem };
  } else {
    if (buf.length > LOGO_MAX_RASTER) return { ok: false, error: 'Bild größer als 1 MB' };
    if (!contentMatches(mime, buf)) return { ok: false, error: 'Dateiinhalt passt nicht zum Dateityp' };
  }
  return { ok: true, mime, ext: LOGO_TYPES[mime], buf };
}
