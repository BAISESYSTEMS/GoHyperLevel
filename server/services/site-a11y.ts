import { contrast, colorHex, fixContrast, type Tokens } from './site-style.js';
import type { Block } from './site-blocks.js';
import { walkBlocks } from './site-layout.js';

/**
 * Site builder: the accessibility check (BFSG / EN 301 549 → WCAG 2.1 AA) – automated, pure.
 *
 * It reads the HTML a visitor gets (and the block tree, for colours) and reports what a machine can see: missing alternative texts,
 * heading order, form labels, link and button names, iframes without title, contrast of text and background, focus styles removed,
 * language and page title. It cannot judge everything (is an alt text meaningful? is a video captioned?) – the report says so and
 * turns the rest into hints. `statementDoc` drafts the "Erklärung zur Barrierefreiheit" from the result.
 */

export type Level = 'error' | 'warning' | 'info';

export interface A11yIssue {
  rule: string;
  level: Level;
  /** WCAG success criterion */
  wcag: string;
  message: string;
  hint: string;
  /** Short HTML excerpt or the name of the element */
  excerpt?: string;
  /** Block the problem sits in (editor jumps there) */
  block_id?: string;
  block_type?: string;
}

export const RULES: Record<string, { wcag: string; title: string }> = {
  lang: { wcag: '3.1.1', title: 'Sprache der Seite' },
  title: { wcag: '2.4.2', title: 'Seitentitel' },
  viewport: { wcag: '1.4.4', title: 'Zoom erlaubt' },
  landmark: { wcag: '1.3.1', title: 'Hauptbereich' },
  skip: { wcag: '2.4.1', title: 'Sprunglink' },
  alt_missing: { wcag: '1.1.1', title: 'Alternativtext fehlt' },
  alt_weak: { wcag: '1.1.1', title: 'Alternativtext prüfen' },
  h1: { wcag: '1.3.1', title: 'Hauptüberschrift' },
  heading_order: { wcag: '1.3.1', title: 'Überschriften-Reihenfolge' },
  heading_empty: { wcag: '2.4.6', title: 'Leere Überschrift' },
  link_name: { wcag: '2.4.4', title: 'Link ohne Namen' },
  link_generic: { wcag: '2.4.4', title: 'Unklarer Link-Text' },
  link_href: { wcag: '2.1.1', title: 'Link ohne Ziel' },
  button_name: { wcag: '4.1.2', title: 'Button ohne Namen' },
  label: { wcag: '3.3.2', title: 'Formularfeld ohne Beschriftung' },
  label_placeholder: { wcag: '3.3.2', title: 'Nur Platzhalter als Beschriftung' },
  autocomplete: { wcag: '1.3.5', title: 'Autovervollständigung' },
  iframe_title: { wcag: '4.1.2', title: 'Eingebetteter Inhalt ohne Titel' },
  video_captions: { wcag: '1.2.2', title: 'Video ohne Untertitel' },
  contrast: { wcag: '1.4.3', title: 'Kontrast' },
  focus: { wcag: '2.4.7', title: 'Fokus sichtbar' },
  tabindex: { wcag: '2.4.3', title: 'Tab-Reihenfolge' },
  motion: { wcag: '2.2.2', title: 'Bewegung' },
  table_header: { wcag: '1.3.1', title: 'Tabelle ohne Kopfzeile' },
  duplicate_id: { wcag: '4.1.1', title: 'Doppelte ID' },
  statement: { wcag: 'BFSG §14', title: 'Barrierefreiheitserklärung' },
};

// --- a tolerant little HTML reader ------------------------------------------------------------------------------------

interface Tag {
  name: string;
  attrs: Record<string, string>;
  at: number;
  end: number;
  raw: string;
}

const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&auml;': 'ä', '&ouml;': 'ö', '&uuml;': 'ü', '&szlig;': 'ß' };
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39|nbsp|auml|ouml|uuml|szlig);/g, (m) => ENT[m] ?? m);

/** Scripts, styles and comments out (their text is not page content). */
export const stripNoise = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');

const TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function tagsOf(html: string, names?: string[]): Tag[] {
  const out: Tag[] = [];
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(html))) {
    const name = m[1].toLowerCase();
    if (names && !names.includes(name)) continue;
    const attrs: Record<string, string> = {};
    ATTR.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR.exec(m[2]))) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    out.push({ name, attrs, at: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  return out;
}

const plain = (html: string) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The inner HTML of every `<name …>…</name>` (not nested – a, button, h1…h6, label, summary). */
function elements(html: string, name: string): { tag: Tag; inner: string; at: number; end: number }[] {
  const out: { tag: Tag; inner: string; at: number; end: number }[] = [];
  const lower = html.toLowerCase();
  for (const t of tagsOf(html, [name])) {
    const close = lower.indexOf(`</${name}`, t.end);
    if (close < 0) continue;
    out.push({ tag: t, inner: html.slice(t.end, close), at: t.at, end: close });
  }
  return out;
}

/** Name a screen reader announces: aria-label, aria-labelledby (as text of that id is unknown here → truthy), inner text, image alt, title. */
function accessibleName(inner: string, attrs: Record<string, string>): string {
  if (attrs['aria-label']?.trim()) return attrs['aria-label'].trim();
  if (attrs['aria-labelledby']?.trim()) return attrs['aria-labelledby'];
  const imgAlt = tagsOf(inner, ['img'])
    .map((t) => t.attrs.alt ?? '')
    .join(' ')
    .trim();
  const text = plain(inner);
  return (text || imgAlt || attrs.title || '').trim();
}

const GENERIC = /^(hier|mehr|mehr erfahren|weiter|weiterlesen|klick hier|hier klicken|link|more|read more|click here|details|zum artikel|mehr lesen|lesen)$/i;
const WEAK_ALT = /^(bild|image|foto|photo|grafik|img|picture|bild\s?\d+|image\s?\d+|screenshot|logo)$/i;
const FILE_ALT = /\.(jpe?g|png|gif|webp|svg|avif)$|^(img|dsc|image|foto|bild)[_\- ]?\d+/i;

// --- checks on one piece of HTML ---------------------------------------------------------------------------------------

export interface Piece {
  html: string;
  block_id?: string;
  block_type?: string;
}

/** Element-level rules on a fragment (a block's HTML). */
export function checkFragment(piece: Piece): A11yIssue[] {
  const html = stripNoise(piece.html);
  const issues: A11yIssue[] = [];
  const add = (rule: string, level: Level, message: string, hint: string, excerpt?: string) =>
    issues.push({ rule, level, wcag: RULES[rule].wcag, message, hint, excerpt: excerpt?.slice(0, 140), block_id: piece.block_id, block_type: piece.block_type });

  // images
  for (const t of tagsOf(html, ['img'])) {
    const alt = t.attrs.alt;
    const src = (t.attrs.src ?? '').split('?')[0].split('/').pop() ?? '';
    if (t.attrs.role === 'presentation' || t.attrs['aria-hidden'] === 'true') continue;
    if (alt === undefined) add('alt_missing', 'error', 'Ein Bild hat keinen Alternativtext.', 'Beschreibe in einem Satz, was das Bild zeigt (Feld „Alt-Text“). Rein dekorative Bilder bekommen einen leeren Alt-Text (alt="").', src);
    else if (alt.trim() && (WEAK_ALT.test(alt.trim()) || FILE_ALT.test(alt.trim()))) add('alt_weak', 'warning', `Der Alternativtext „${alt.trim().slice(0, 40)}“ sagt nichts über das Bild.`, 'Schreibe, was zu sehen ist oder was das Bild aussagt – nicht den Dateinamen.', src);
    else if (alt.length > 150) add('alt_weak', 'warning', 'Der Alternativtext ist sehr lang.', 'Fasse dich kurz (unter 150 Zeichen); Längeres gehört in den Text neben dem Bild.', src);
  }

  // links
  for (const e of elements(html, 'a')) {
    const a = e.tag.attrs;
    // A picture link that duplicates the text link next to it is hidden from keyboard and screen readers on purpose.
    if (a['aria-hidden'] === 'true' && a.tabindex === '-1') continue;
    const name = accessibleName(e.inner, a);
    if (a.href === undefined && !a.name && !a.id) add('link_href', 'warning', 'Ein Link hat kein Ziel.', 'Trage eine Adresse ein oder mache aus dem Link einen normalen Text.', plain(e.inner));
    else if (a.href === '#' && !a['aria-label'] && !a.role) add('link_href', 'warning', 'Ein Link zeigt nur auf „#“ – er führt nirgendwohin.', 'Trage das echte Ziel ein (eine Seite, einen Abschnitt wie #kontakt oder eine Adresse).', plain(e.inner) || a.href);
    if (!name) add('link_name', 'error', 'Ein Link hat keinen erkennbaren Namen (kein Text, kein Alt-Text).', 'Gib dem Link einen Text oder – bei einem Bild-Link – dem Bild einen Alt-Text.', a.href);
    else if (GENERIC.test(name)) add('link_generic', 'warning', `Der Link-Text „${name}“ sagt allein nicht, wohin er führt.`, 'Schreibe das Ziel in den Text, z. B. „Preise ansehen“ statt „mehr erfahren“.', a.href);
  }

  // buttons
  for (const e of elements(html, 'button')) {
    if (e.tag.attrs.type === 'hidden') continue;
    if (!accessibleName(e.inner, e.tag.attrs)) add('button_name', 'error', 'Ein Button hat keinen Namen.', 'Gib dem Button einen Text oder ein aria-label.', e.tag.raw);
  }

  // form controls
  const labels = elements(html, 'label');
  const forIds = new Set(labels.map((l) => l.tag.attrs.for).filter(Boolean));
  const inLabel = (pos: number) => labels.some((l) => pos > l.at && pos < l.end);
  for (const t of tagsOf(html, ['input', 'select', 'textarea'])) {
    const type = (t.attrs.type ?? 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type) || t.attrs['aria-hidden'] === 'true' || t.attrs.tabindex === '-1') continue;
    const labelled = !!t.attrs['aria-label']?.trim() || !!t.attrs['aria-labelledby'] || (t.attrs.id && forIds.has(t.attrs.id)) || inLabel(t.at) || !!t.attrs.title;
    if (!labelled) {
      if (t.attrs.placeholder) add('label_placeholder', 'error', 'Ein Feld hat nur einen Platzhalter, aber keine Beschriftung.', 'Platzhalter verschwinden beim Tippen. Gib dem Feld eine sichtbare Beschriftung (Label) oder zumindest ein aria-label.', t.attrs.name || t.attrs.placeholder);
      else add('label', 'error', 'Ein Formularfeld hat keine Beschriftung.', 'Ordne dem Feld ein <label> zu (im Formular-Editor: Feld-Beschriftung ausfüllen).', t.attrs.name || t.raw);
    }
    if (['email', 'tel'].includes(type) && !t.attrs.autocomplete) add('autocomplete', 'info', 'Dem Feld fehlt das Attribut autocomplete.', 'Browser und Hilfsmittel können E-Mail- und Telefonfelder dann automatisch ausfüllen.', t.attrs.name);
  }

  // embedded content
  for (const t of tagsOf(html, ['iframe'])) if (!t.attrs.title?.trim()) add('iframe_title', 'error', 'Ein eingebetteter Inhalt (iframe) hat keinen Titel.', 'Ein title-Attribut sagt Screenreadern, was dort eingebettet ist (z. B. „Terminbuchung“, „Video“).', t.attrs.src);
  for (const e of elements(html, 'video')) {
    if (!/<track\b[^>]*kind=["']?(captions|subtitles)/i.test(e.inner)) add('video_captions', 'warning', 'Ein Video hat keine Untertitel-Spur.', 'Ergänze Untertitel (WebVTT) oder ein Transkript neben dem Video – bei eingebetteten YouTube/Vimeo-Videos in deren Einstellungen.');
  }
  // video embeds (iframe players) cannot be checked for captions: one hint
  if (tagsOf(html, ['iframe']).some((t) => /youtube|vimeo|loom/i.test(t.attrs.src ?? ''))) add('video_captions', 'info', 'Eingebettetes Video: Untertitel lassen sich automatisch nicht prüfen.', 'Schalte beim Anbieter Untertitel ein oder lege ein Transkript daneben (BFSG verlangt Alternativen für Hörbehinderte).');

  // focus, order, motion
  if (/outline\s*:\s*(none|0)\b/i.test(piece.html) && !/:focus-visible|:focus\s*\{[^}]*(outline|box-shadow|border)/i.test(piece.html)) add('focus', 'warning', 'Der eigene Code entfernt den Fokus-Rahmen.', 'Wer mit der Tastatur navigiert, sieht sonst nicht, wo er ist. Lass den Rahmen stehen oder ersetze ihn durch ein sichtbares :focus-visible.');
  for (const t of tagsOf(html)) if (Number(t.attrs.tabindex) > 0) add('tabindex', 'warning', 'tabindex größer als 0 verändert die Tab-Reihenfolge.', 'Nutze tabindex="0" oder keinen Wert; die Reihenfolge ergibt sich aus der Seitenstruktur.', t.raw);
  if (/<(marquee|blink)\b/i.test(html)) add('motion', 'error', 'Blinkender oder laufender Text (marquee/blink).', 'Bewegung, die nicht anzuhalten ist, ist unzulässig. Entferne sie.');
  for (const t of tagsOf(html, ['video', 'audio'])) if ('autoplay' in t.attrs && !('muted' in t.attrs)) add('motion', 'warning', 'Ein Medium startet automatisch mit Ton.', 'Spiele nichts automatisch ab oder starte stumm und gib Bedienelemente.', t.raw);

  // tables
  for (const e of elements(html, 'table')) if (!/<th\b/i.test(e.inner)) add('table_header', 'warning', 'Eine Tabelle hat keine Kopfzeile (<th>).', 'Kennzeichne Überschriften der Spalten/Zeilen mit <th>, damit Screenreader die Zellen zuordnen können.');
  return issues;
}

/** Page-level rules: language, title, zoom, landmarks, heading structure, duplicate ids. */
export function checkDocument(fullHtml: string, o: { skipLink?: boolean } = {}): A11yIssue[] {
  const html = stripNoise(fullHtml);
  const issues: A11yIssue[] = [];
  const add = (rule: string, level: Level, message: string, hint: string, excerpt?: string) => issues.push({ rule, level, wcag: RULES[rule].wcag, message, hint, excerpt });
  const htmlTag = tagsOf(html, ['html'])[0];
  if (!htmlTag?.attrs.lang || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(htmlTag.attrs.lang)) add('lang', 'error', 'Die Seite hat keine (gültige) Sprachangabe.', 'Setze die Sprache der Seite (Seiten-Einstellungen → Sprache); Screenreader sprechen sonst mit falscher Aussprache.');
  const title = elements(html, 'title')[0];
  if (!title || !plain(title.inner)) add('title', 'error', 'Die Seite hat keinen Titel.', 'Trage unter SEO einen aussagekräftigen Seitentitel ein.');
  const viewport = tagsOf(html, ['meta']).find((t) => t.attrs.name === 'viewport');
  if (viewport && /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(viewport.attrs.content ?? '')) add('viewport', 'error', 'Das Zoomen der Seite ist gesperrt.', 'Entferne user-scalable=no / maximum-scale aus dem viewport-Tag (Kopf-Code).');
  const mains = tagsOf(html, ['main']).length;
  if (mains !== 1) add('landmark', mains ? 'warning' : 'error', mains ? 'Die Seite hat mehrere Hauptbereiche (<main>).' : 'Die Seite hat keinen Hauptbereich (<main>).', 'Genau ein <main> pro Seite hilft bei der Navigation per Screenreader.');
  if (o.skipLink !== false && !/<a\b[^>]*class="skip"/i.test(html) && tagsOf(html, ['header']).length) add('skip', 'warning', 'Es fehlt ein Link „Zum Inhalt springen“.', 'Mit Tastatur müssen Besucher sonst bei jeder Seite durchs ganze Menü tabben.');

  // headings
  const hs = [1, 2, 3, 4, 5, 6].flatMap((n) => elements(html, `h${n}`).map((e) => ({ n, at: e.at, text: plain(e.inner), tag: e.tag })));
  hs.sort((a, b) => a.at - b.at);
  const h1 = hs.filter((h) => h.n === 1);
  if (!h1.length) add('h1', 'error', 'Die Seite hat keine Hauptüberschrift (H1).', 'Setze genau eine H1 – meist im Hero- oder Überschrift-Block (Größe „1“).');
  else if (h1.length > 1) add('h1', 'warning', `Die Seite hat ${h1.length} Hauptüberschriften (H1).`, 'Nutze nur eine H1 und gliedere den Rest mit H2/H3.', h1.map((h) => h.text).join(' | '));
  let prev = 0;
  for (const h of hs) {
    if (!h.text && !h.tag.attrs['aria-label']) add('heading_empty', 'error', `Eine Überschrift (H${h.n}) ist leer.`, 'Lösche die leere Überschrift oder schreibe einen Text hinein.');
    if (prev && h.n > prev + 1) add('heading_order', 'warning', `Überschriften springen von H${prev} auf H${h.n}.`, 'Überspringe keine Ebenen: nach H2 folgt H3, nicht H4 (Block „Überschrift“ → Größe).', h.text);
    prev = h.n;
  }

  // ids
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const t of tagsOf(html)) if (t.attrs.id) (seen.has(t.attrs.id) ? dup : seen).add(t.attrs.id);
  for (const d of dup) add('duplicate_id', 'warning', `Die ID „${d}“ kommt mehrfach vor.`, 'Anker und Formularfelder brauchen eindeutige IDs.', d);
  return issues;
}

// --- colours -------------------------------------------------------------------------------------------------------------

/** Contrast of the site's own colour pairs (what every page uses). */
export function tokenContrast(t: Tokens): A11yIssue[] {
  const c = t.colors;
  const out: A11yIssue[] = [];
  const pair = (fg: string, bg: string, what: string, min = 4.5) => {
    const r = contrast(fg, bg);
    if (r >= min) return;
    const fix = fixContrast(fg, bg, min);
    out.push({
      rule: 'contrast',
      level: r < 3 ? 'error' : 'warning',
      wcag: '1.4.3',
      message: `${what}: Kontrast ${r.toFixed(2).replace('.', ',')} : 1 (nötig: ${min} : 1).`,
      hint: `Wähle ${fix === fg ? 'einen dunkleren/helleren Farbton' : `z. B. ${fix}`} (Design → Farben).`,
      excerpt: `${fg} auf ${bg}`,
    });
  };
  pair(c.text, c.bg, 'Text auf Seitenhintergrund');
  pair(c.muted, c.bg, 'Grauer Text auf Seitenhintergrund');
  pair(c.muted, c.surface, 'Grauer Text auf Fläche');
  pair(c.brand, c.bg, 'Markenfarbe (Links, Überschriften-Akzente) auf Seitenhintergrund');
  pair(c.success, c.bg, 'Erfolgsfarbe auf Seitenhintergrund');
  pair(c.danger, c.bg, 'Fehlerfarbe auf Seitenhintergrund');
  return out;
}

/** Explicit text/background colours of blocks, sections and columns (the renderer picks readable text itself when none is set). */
export function blockContrast(blocks: Block[], t: Tokens): A11yIssue[] {
  const out: A11yIssue[] = [];
  const check = (b: Record<string, any>, bgHex: string, type: string) => {
    const fg = colorHex(b.color, t);
    if (!fg || !bgHex) return;
    const r = contrast(fg, bgHex);
    if (r >= 4.5) return;
    const fix = fixContrast(fg, bgHex, 4.5);
    out.push({
      rule: 'contrast',
      level: r < 3 ? 'error' : 'warning',
      wcag: '1.4.3',
      message: `Textfarbe ${fg} auf ${bgHex}: Kontrast ${r.toFixed(2).replace('.', ',')} : 1${r >= 3 ? ' (reicht nur für große Schrift ab 24 px)' : ''}.`,
      hint: `Nimm einen stärkeren Kontrast, z. B. ${fix}, oder lass die Textfarbe leer – dann wählt die Seite automatisch Weiß oder Dunkel.`,
      excerpt: `${fg} auf ${bgHex}`,
      block_id: b.id,
      block_type: type,
    });
  };
  const visit = (list: any[], parentBg: string) => {
    for (const b of Array.isArray(list) ? list : []) {
      if (!b || typeof b !== 'object') continue;
      const own = colorHex(b.bg, t);
      const bg = own || parentBg;
      check(b, bg, b.type);
      if (b.type === 'section') for (const row of b.rows ?? []) for (const col of row.cols ?? []) {
        const colBg = colorHex(col.bg, t) || bg;
        check(col, colBg, 'column');
        visit(col.blocks, colBg);
      }
    }
  };
  visit(blocks, t.colors.bg);
  return out;
}

// --- score and statement -----------------------------------------------------------------------------------------------

export interface Summary {
  errors: number;
  warnings: number;
  info: number;
  /** 0–100, a rough measure (100 = nothing the machine could find) */
  score: number;
}
export function summarize(issues: A11yIssue[]): Summary {
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warning').length;
  const info = issues.filter((i) => i.level === 'info').length;
  return { errors, warnings, info, score: Math.max(0, Math.min(100, 100 - errors * 10 - warnings * 3)) };
}

/** Groups equal findings (same rule and message) so a long page does not drown the report. */
export function group(issues: A11yIssue[]): (A11yIssue & { count: number; blocks: string[] })[] {
  const map = new Map<string, A11yIssue & { count: number; blocks: string[] }>();
  for (const i of issues) {
    const k = `${i.rule}|${i.level}|${i.message}`;
    const g = map.get(k) ?? { ...i, count: 0, blocks: [] };
    g.count++;
    if (i.block_id && !g.blocks.includes(i.block_id)) g.blocks.push(i.block_id);
    map.set(k, g);
  }
  const order = { error: 0, warning: 1, info: 2 };
  return [...map.values()].sort((a, b) => order[a.level] - order[b.level] || b.count - a.count);
}

export function blocksOfPage(blocks: unknown): Block[] {
  const out: Block[] = [];
  walkBlocks(blocks, (b) => out.push(b));
  return out;
}

export interface StatementInput {
  company: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  scope: string;
  date: string;
  issues: A11yIssue[];
  /** Tested pages: names */
  pages: string[];
  notice: string;
}

/** Draft of the "Erklärung zur Barrierefreiheit" (BFSG): scope, conformity status, known gaps, how it was assessed, feedback, enforcement. */
export function statementDoc(i: StatementInput) {
  const errors = i.issues.filter((x) => x.level === 'error');
  const grouped = group(i.issues.filter((x) => x.level !== 'info'));
  const gaps = grouped.length ? grouped.slice(0, 12).map((g) => `- ${RULES[g.rule]?.title ?? g.rule}: ${g.message}${g.count > 1 ? ` (${g.count}×)` : ''}`).join('\n') : '- Bei der automatischen Prüfung wurden keine Mängel festgestellt. Eine manuelle Prüfung steht noch aus.';
  const status = errors.length ? 'teilweise vereinbar' : 'weitgehend vereinbar';
  const miss: string[] = [];
  if (!i.company) miss.push('Name des Anbieters');
  if (!i.email) miss.push('Kontakt-E-Mail für Rückmeldungen');
  return {
    kind: 'barrierefreiheit',
    title: 'Erklärung zur Barrierefreiheit',
    subtitle: `Stand: ${i.date}`,
    sections: [
      { heading: 'Geltungsbereich', body: `${i.company || '[Name des Anbieters]'} ist bemüht, ${i.scope || 'diese Website'} im Einklang mit dem Barrierefreiheitsstärkungsgesetz (BFSG) und der Norm EN 301 549 (Anforderungen der Web Content Accessibility Guidelines WCAG 2.1, Stufe AA) barrierefrei zugänglich zu machen. Diese Erklärung gilt für die Website ${i.website || '[Adresse der Website]'}.` },
      { heading: 'Stand der Vereinbarkeit', body: `Diese Website ist mit den Anforderungen **${status}** vereinbar. Grundlage ist eine Selbstbewertung (siehe „Erstellung dieser Erklärung“).` },
      { heading: 'Nicht barrierefreie Inhalte', body: `Folgende Mängel sind uns bekannt:\n${gaps}\n\nWir arbeiten daran, diese Punkte zu beheben. Eine Befreiung wegen unverhältnismäßiger Belastung nehmen wir nicht in Anspruch, solange wir sie nicht ausdrücklich hier benennen.` },
      { heading: 'Erstellung dieser Erklärung', body: `Diese Erklärung wurde am ${i.date} erstellt. Geprüft wurde ${i.pages.length ? `der Inhalt der Seiten ${i.pages.slice(0, 12).join(', ')}` : 'der Inhalt der Website'} mit einer automatischen Prüfung (Alternativtexte, Überschriften, Formularbeschriftungen, Link- und Button-Namen, Kontraste, Sprache, Fokus-Reihenfolge). Eine automatische Prüfung findet nur einen Teil möglicher Barrieren; [Ergänzen: manuelle Prüfung mit Tastatur und Screenreader am TT.MM.JJJJ].` },
      { heading: 'Rückmeldung und Kontakt', body: `Sind Ihnen Barrieren aufgefallen, die hier nicht genannt sind, oder benötigen Sie Inhalte in einer anderen Form, schreiben Sie uns:\n\n${i.company || '[Name]'}${i.address ? `\n${i.address}` : ''}\nE-Mail: ${i.email || '[E-Mail]'}${i.phone ? `\nTelefon: ${i.phone}` : ''}\n\nWir antworten in der Regel innerhalb von [Frist, z. B. 14 Tagen].` },
      { heading: 'Schlichtungs- und Durchsetzungsverfahren', body: 'Wenn Sie mit unserer Antwort nicht zufrieden sind, können Sie sich an die zuständige Marktüberwachungsbehörde der Länder für die Barrierefreiheit von Produkten und Dienstleistungen wenden. [Kontaktdaten der zuständigen Behörde eintragen – prüfen Sie diese Angabe vor der Veröffentlichung.]' },
      { heading: 'Hinweis für Kleinstunternehmen', body: 'Kleinstunternehmen (weniger als 10 Beschäftigte und höchstens 2 Mio. Euro Jahresumsatz bzw. Bilanzsumme), die **Dienstleistungen** erbringen, sind von den Anforderungen des BFSG ausgenommen. Wer Produkte im Anwendungsbereich anbietet, ist nicht ausgenommen. [Prüfen, ob die Ausnahme zutrifft, und diesen Abschnitt dann entfernen oder anpassen.]' },
    ],
    missing: miss,
    notice: i.notice,
    services: [] as string[],
  };
}
