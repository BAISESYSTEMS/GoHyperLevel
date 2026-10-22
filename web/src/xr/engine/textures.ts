import type { ListRow, NumberFormat, Tone, View } from '../../boards/types';
import { PX_PER_M } from './geometry';

/**
 * Widgets as pictures: the simplified 2D-canvas renderer behind the floating panels.
 *
 * A Living Board widget returns a standard *view* (server/services/boards-widgets.ts): a number, a list, a table, a kanban,
 * an agenda, a chart result, a note … This file draws each of those kinds onto a canvas, which the renderer uploads as the texture
 * of the panel. It is deliberately NOT the DOM: no HTML is rendered into a texture (browsers cannot do that inside an immersive
 * session), so what shows is a faithful but simplified picture – numbers, lists, tables, bars and lines, plain text of notes.
 * Embedded pages, plugin frames and quick-action buttons cannot be drawn this way and say so, with a pointer to the browser.
 *
 * Every function takes a CanvasRenderingContext2D-like object, so the tests run it against a recording fake. Sizes are in
 * "design pixels" (about the DOM size of the same widget); `drawPanel` scales them to the texture.
 */

export interface XrTheme {
  dark: boolean;
  bg: string;
  panel: string;
  text: string;
  muted: string;
  line: string;
  brand: string;
  brandText: string;
  onBrand: string;
  soft: string;
  green: string;
  red: string;
  yellow: string;
}

export const LIGHT_THEME: XrTheme = { dark: false, bg: '#f4f6fa', panel: '#ffffff', text: '#111827', muted: '#5d6677', line: '#d9dde5', brand: '#2563eb', brandText: '#1d4ed8', onBrand: '#ffffff', soft: '#eaf1ff', green: '#047857', red: '#b91c1c', yellow: '#b45309' };
export const DARK_THEME: XrTheme = { dark: true, bg: '#0b1020', panel: '#141c33', text: '#e8ebf2', muted: '#a5b0c4', line: '#2c3957', brand: '#3b82f6', brandText: '#8ab4ff', onBrand: '#ffffff', soft: '#1c2b52', green: '#4ade80', red: '#f87171', yellow: '#fbbf24' };

/** A texture pixel is this many design pixels (PX_PER_M texture px per metre; the DOM grid is about 345 px per metre). */
export const DESIGN_SCALE = PX_PER_M / 345;
export const HEAD_H = 46;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
export const font = (size: number, weight: number | string = 400) => `${weight} ${size}px ${FONT}`;

type Ctx = CanvasRenderingContext2D;

export const toneColor = (t: XrTheme, tone?: Tone): string => (tone === 'green' ? t.green : tone === 'red' ? t.red : tone === 'yellow' ? t.yellow : tone === 'blue' ? t.brandText : tone === 'purple' ? (t.dark ? '#c4b5fd' : '#6d28d9') : t.text);

// --- text helpers --------------------------------------------------------------------------------------------

export function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

/** The text cut to fit `maxW` with an ellipsis (the font must already be set on the context). */
export function ellipsize(ctx: Ctx, text: string, maxW: number): string {
  const s = String(text ?? '');
  if (maxW <= 0) return '';
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${s.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${s.slice(0, lo).trimEnd()}…` : '…';
}

/** Word wrap into at most `maxLines` lines (the last one gets the ellipsis when more text follows). */
export function wrapText(ctx: Ctx, text: string, maxW: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const para of String(text ?? '').split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (!line || ctx.measureText(next).width <= maxW) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  if (!out.length) return [''];
  const lines = out.slice(0, Math.max(1, maxLines));
  if (out.length > lines.length) lines[lines.length - 1] = `${lines[lines.length - 1]} …`;
  // a single word wider than the line is cut like any other overflow
  return lines.map((l) => ellipsize(ctx, l, maxW));
}

const nf = (max: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: max });

/** Numbers the way the app shows them (de-DE): 7.180 € · 12,5 % · 3 Tage. */
export function formatValue(v: string | number | null | undefined, format?: NumberFormat): string {
  if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return '–';
  if (typeof v === 'string') return v;
  switch (format) {
    case 'money':
      return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v);
    case 'percent':
      return `${nf(1).format(v)} %`;
    case 'days':
      return `${nf(1).format(v)} Tage`;
    case 'minutes':
      return `${nf(1).format(v)} Min.`;
    default:
      return nf(Number.isInteger(v) ? 0 : 2).format(v);
  }
}

/** Markdown of a note reduced to plain lines: headings stay lines, bullets get a dot, marks and links lose their syntax. */
export function plainLines(md: string): { text: string; bold: boolean; bullet: boolean }[] {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\n/)
    .map((raw) => {
      const h = /^\s*#{1,6}\s+(.*)$/.exec(raw);
      const b = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw);
      const text = (h?.[1] ?? b?.[1] ?? raw)
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~>|]+/g, '')
        .trim();
      return { text, bold: !!h, bullet: !!b };
    })
    .filter((l, i, all) => l.text || (i > 0 && all[i - 1].text));
}

// --- the panel -------------------------------------------------------------------------------------------------

export interface PanelSpec {
  title: string;
  view?: View;
  loading?: boolean;
  theme: XrTheme;
  /** The pointer is on it (a soft ring). */
  hover?: boolean;
  grabbed?: boolean;
  /** Smallest status line under the title ("Live: …"). */
  note?: string;
}

/** The whole panel: card, title bar with the grip, and the view. `W`, `H` are texture pixels. */
export function drawPanel(ctx: Ctx, W: number, H: number, spec: PanelSpec) {
  const t = spec.theme;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.scale(DESIGN_SCALE, DESIGN_SCALE);
  const w = W / DESIGN_SCALE;
  const h = H / DESIGN_SCALE;
  roundRect(ctx, 0, 0, w, h, 20);
  ctx.fillStyle = t.panel;
  ctx.fill();
  ctx.save();
  roundRect(ctx, 0, 0, w, h, 20);
  ctx.clip();
  // title bar: the part you grab
  ctx.fillStyle = spec.grabbed ? t.soft : t.dark ? '#18223f' : '#f1f4f9';
  ctx.fillRect(0, 0, w, HEAD_H);
  ctx.fillStyle = t.line;
  ctx.fillRect(0, HEAD_H - 1, w, 1);
  // grip dots
  ctx.fillStyle = spec.grabbed || spec.hover ? t.brand : t.muted;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(w / 2 - 12 + i * 12, 11, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = t.text;
  ctx.font = font(19, 700);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(ellipsize(ctx, spec.title, w - 32), 16, HEAD_H / 2 + 7);
  drawView(ctx, { x: 0, y: HEAD_H, w, h: h - HEAD_H }, spec.view, !!spec.loading, t);
  ctx.restore();
  roundRect(ctx, 1, 1, w - 2, h - 2, 19);
  ctx.lineWidth = spec.grabbed || spec.hover ? 4 : 2;
  ctx.strokeStyle = spec.grabbed ? t.brand : spec.hover ? t.brandText : t.line;
  ctx.stroke();
  ctx.restore();
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the picture of a widget shows – for the tests and for the screen-reader-less "what is this" line. */
export function viewKind(view: View | undefined, loading: boolean): string {
  return !view ? (loading ? 'loading' : 'empty') : view.kind;
}

export function drawView(ctx: Ctx, r: Rect, view: View | undefined, loading: boolean, t: XrTheme) {
  const pad = 18;
  const inner: Rect = { x: r.x + pad, y: r.y + pad - 4, w: r.w - pad * 2, h: r.h - pad * 2 + 4 };
  if (!view) return loading ? skeleton(ctx, inner, t) : quiet(ctx, inner, t, 'Keine Daten.');
  switch (view.kind) {
    case 'number':
      return bigNumber(ctx, inner, t, view);
    case 'numbers':
      return numberGrid(ctx, inner, t, view.items, view.hint);
    case 'report':
      return report(ctx, inner, t, view.viz, view.result);
    case 'list':
      return list(ctx, inner, t, view.rows, view.total, view.empty);
    case 'table':
      return table(ctx, inner, t, view);
    case 'kanban':
      return kanban(ctx, inner, t, view);
    case 'agenda':
      return agenda(ctx, inner, t, view);
    case 'markdown':
      return notes(ctx, inner, t, view.text);
    case 'message':
      return quiet(ctx, inner, t, view.text, toneColor(t, view.tone));
    case 'locked':
      return quiet(ctx, inner, t, `Gesperrt – ${view.reason}`, t.muted);
    case 'embed':
      return quiet(ctx, inner, t, 'Eingebettete Seite: in XR nicht darstellbar. Im Browser öffnen.');
    case 'frame':
      return quiet(ctx, inner, t, 'Plugin-Ansicht: in XR nicht darstellbar. Im Browser öffnen.');
    case 'actions':
      return quiet(ctx, inner, t, 'Schnellaktionen gibt es im Browser. In XR sprichst du mit dem Board.');
    default:
      return quiet(ctx, inner, t, 'Dieses Widget lässt sich hier nicht darstellen.');
  }
}

// --- the kinds -----------------------------------------------------------------------------------------------------

function skeleton(ctx: Ctx, r: Rect, t: XrTheme) {
  ctx.fillStyle = t.line;
  for (let i = 0; i < 3; i++) {
    roundRect(ctx, r.x, r.y + i * 34, r.w * (i === 1 ? 0.6 : 0.9), 18, 9);
    ctx.fill();
  }
}

function quiet(ctx: Ctx, r: Rect, t: XrTheme, text: string, color = t.muted) {
  ctx.fillStyle = color;
  ctx.font = font(17, 500);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const lines = wrapText(ctx, text, r.w - 20, 5);
  const lh = 24;
  const top = r.y + r.h / 2 - (lines.length * lh) / 2 + 17;
  lines.forEach((l, i) => ctx.fillText(l, r.x + r.w / 2, top + i * lh));
  ctx.textAlign = 'left';
}

function bigNumber(ctx: Ctx, r: Rect, t: XrTheme, v: Extract<View, { kind: 'number' }>) {
  const value = formatValue(v.value, v.format);
  let size = Math.min(72, Math.max(30, r.h * 0.42));
  ctx.font = font(size, 750);
  while (ctx.measureText(value).width > r.w && size > 22) {
    size -= 4;
    ctx.font = font(size, 750);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = toneColor(t, v.tone);
  const midY = r.y + r.h / 2;
  ctx.fillText(value, r.x, midY + size * 0.3);
  ctx.font = font(18, 500);
  ctx.fillStyle = t.muted;
  let y = midY + size * 0.3 + 30;
  if (v.label) ctx.fillText(ellipsize(ctx, v.label, r.w), r.x, y), (y += 26);
  if (v.delta !== null && v.delta !== undefined) {
    ctx.font = font(18, 700);
    ctx.fillStyle = v.delta > 0 ? t.green : v.delta < 0 ? t.red : t.muted;
    ctx.fillText(`${v.delta > 0 ? '▲' : v.delta < 0 ? '▼' : '='} ${nf(1).format(Math.abs(v.delta))} % zur Vorperiode`, r.x, y);
    y += 26;
  }
  if (v.hint) {
    ctx.font = font(15, 400);
    ctx.fillStyle = t.muted;
    ctx.fillText(ellipsize(ctx, v.hint, r.w), r.x, y);
  }
}

function numberGrid(ctx: Ctx, r: Rect, t: XrTheme, items: Extract<View, { kind: 'numbers' }>['items'], hint?: string) {
  const shown = items.slice(0, 6);
  const cols = shown.length <= 2 ? shown.length || 1 : shown.length <= 4 ? 2 : 3;
  const rows = Math.ceil(shown.length / cols);
  const cw = r.w / cols;
  const ch = Math.min(110, (r.h - (hint ? 24 : 0)) / rows);
  shown.forEach((it, i) => {
    const x = r.x + (i % cols) * cw;
    const y = r.y + Math.floor(i / cols) * ch;
    const value = formatValue(it.value, it.format);
    let size = 38;
    ctx.font = font(size, 750);
    while (ctx.measureText(value).width > cw - 14 && size > 20) {
      size -= 3;
      ctx.font = font(size, 750);
    }
    ctx.fillStyle = toneColor(t, it.tone);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(value, x, y + size + 4);
    ctx.font = font(15, 500);
    ctx.fillStyle = t.muted;
    ctx.fillText(ellipsize(ctx, it.label, cw - 14), x, y + size + 28);
  });
  if (hint) {
    ctx.font = font(14, 400);
    ctx.fillStyle = t.muted;
    ctx.fillText(ellipsize(ctx, hint, r.w), r.x, r.y + r.h - 4);
  }
}

function badge(ctx: Ctx, t: XrTheme, text: string, tone: Tone | undefined, xRight: number, yMid: number): number {
  ctx.font = font(14, 700);
  const w = ctx.measureText(text).width + 18;
  const x = xRight - w;
  roundRect(ctx, x, yMid - 12, w, 24, 12);
  ctx.fillStyle = t.dark ? '#26335a' : '#eef1f6';
  ctx.fill();
  ctx.fillStyle = toneColor(t, tone ?? 'gray');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 9, yMid + 1);
  return w;
}

function list(ctx: Ctx, r: Rect, t: XrTheme, rows: ListRow[], total?: number, empty?: string) {
  if (!rows.length) return quiet(ctx, r, t, empty ?? 'Nichts zu zeigen.');
  const rowH = 52;
  const fit = Math.max(1, Math.floor((r.h - (total && total > rows.length ? 24 : 0)) / rowH));
  const shown = rows.slice(0, fit);
  shown.forEach((row, i) => {
    const y = r.y + i * rowH;
    ctx.fillStyle = t.line;
    if (i) ctx.fillRect(r.x, y, r.w, 1);
    let x = r.x;
    if (row.check) {
      roundRect(ctx, x, y + 14, 22, 22, 6);
      ctx.lineWidth = 2;
      ctx.strokeStyle = row.check.done ? t.green : t.muted;
      ctx.stroke();
      if (row.check.done) {
        ctx.fillStyle = t.green;
        ctx.font = font(18, 800);
        ctx.textBaseline = 'middle';
        ctx.fillText('✓', x + 4, y + 26);
      }
      x += 34;
    }
    let right = r.x + r.w;
    if (row.badge) right -= badge(ctx, t, row.badge.text, row.badge.tone, right, y + 17) + 10;
    const side = row.meta ?? (row.at ? row.at.slice(0, 10) : '');
    if (side) {
      ctx.font = font(14, 400);
      ctx.fillStyle = t.muted;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      const s = ellipsize(ctx, side, r.w * 0.28);
      ctx.fillText(s, right, y + 38);
      ctx.textAlign = 'left';
    }
    ctx.fillStyle = row.check?.done ? t.muted : t.text;
    ctx.font = font(18, 600);
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(ellipsize(ctx, row.title, right - x - (side ? r.w * 0.2 : 0)), x, y + (row.subtitle ? 24 : 32));
    if (row.subtitle) {
      ctx.font = font(15, 400);
      ctx.fillStyle = t.muted;
      ctx.fillText(ellipsize(ctx, row.subtitle, right - x - 12), x, y + 44);
    }
  });
  const more = (total ?? rows.length) - shown.length;
  if (more > 0) {
    ctx.font = font(15, 600);
    ctx.fillStyle = t.brandText;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`+ ${more.toLocaleString('de-DE')} weitere im Browser`, r.x, r.y + r.h - 4);
  }
}

function table(ctx: Ctx, r: Rect, t: XrTheme, v: Extract<View, { kind: 'table' }>) {
  if (!v.rows.length) return quiet(ctx, r, t, v.empty ?? 'Nichts zu zeigen.');
  const cols = v.columns.slice(0, 6);
  const cw = r.w / cols.length;
  ctx.font = font(14, 700);
  ctx.fillStyle = t.muted;
  ctx.textBaseline = 'alphabetic';
  cols.forEach((c, i) => {
    ctx.textAlign = c.align === 'right' ? 'right' : 'left';
    ctx.fillText(ellipsize(ctx, c.label.toUpperCase(), cw - 12), c.align === 'right' ? r.x + (i + 1) * cw - 8 : r.x + i * cw, r.y + 16);
  });
  const rowH = 38;
  const fit = Math.max(1, Math.floor((r.h - 28) / rowH));
  v.rows.slice(0, fit).forEach((row, ri) => {
    const y = r.y + 26 + ri * rowH;
    ctx.fillStyle = t.line;
    ctx.fillRect(r.x, y, r.w, 1);
    ctx.font = font(17, 500);
    ctx.fillStyle = t.text;
    cols.forEach((c, i) => {
      ctx.textAlign = c.align === 'right' ? 'right' : 'left';
      ctx.fillText(ellipsize(ctx, String(row[c.key] ?? '–'), cw - 12), c.align === 'right' ? r.x + (i + 1) * cw - 8 : r.x + i * cw, y + 26);
    });
  });
  ctx.textAlign = 'left';
}

function kanban(ctx: Ctx, r: Rect, t: XrTheme, v: Extract<View, { kind: 'kanban' }>) {
  if (!v.columns.length) return quiet(ctx, r, t, v.empty ?? 'Keine Phasen.');
  const cols = v.columns.slice(0, 5);
  const gap = 10;
  const cw = (r.w - gap * (cols.length - 1)) / cols.length;
  cols.forEach((c, i) => {
    const x = r.x + i * (cw + gap);
    roundRect(ctx, x, r.y, cw, r.h, 12);
    ctx.fillStyle = t.dark ? '#18223f' : '#eef2f8';
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = font(15, 700);
    ctx.fillStyle = t.text;
    ctx.fillText(ellipsize(ctx, `${c.title} · ${c.count}`, cw - 18), x + 10, r.y + 24);
    const cardH = 54;
    const fit = Math.max(0, Math.floor((r.h - 40) / (cardH + 8)));
    c.cards.slice(0, fit).forEach((k, ki) => {
      const y = r.y + 36 + ki * (cardH + 8);
      roundRect(ctx, x + 6, y, cw - 12, cardH, 9);
      ctx.fillStyle = t.panel;
      ctx.fill();
      ctx.fillStyle = t.text;
      ctx.font = font(15, 600);
      ctx.fillText(ellipsize(ctx, k.title, cw - 28), x + 14, y + 22);
      ctx.font = font(13, 400);
      ctx.fillStyle = t.muted;
      ctx.fillText(ellipsize(ctx, k.subtitle ?? k.meta ?? '', cw - 28), x + 14, y + 42);
    });
  });
}

function agenda(ctx: Ctx, r: Rect, t: XrTheme, v: Extract<View, { kind: 'agenda' }>) {
  if (!v.days.length) return quiet(ctx, r, t, v.empty ?? 'Keine Termine.');
  let y = r.y;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const d of v.days) {
    if (y > r.y + r.h - 40) break;
    ctx.font = font(14, 700);
    ctx.fillStyle = t.muted;
    ctx.fillText(d.label.toUpperCase(), r.x, y + 14);
    y += 24;
    for (const it of d.items) {
      if (y > r.y + r.h - 28) break;
      ctx.font = font(17, 700);
      ctx.fillStyle = toneColor(t, it.tone ?? 'blue');
      ctx.fillText(it.time, r.x, y + 20);
      ctx.font = font(17, 500);
      ctx.fillStyle = t.text;
      ctx.fillText(ellipsize(ctx, `${it.title}${it.subtitle ? ` · ${it.subtitle}` : ''}`, r.w - 80), r.x + 76, y + 20);
      y += 34;
    }
    y += 8;
  }
}

function notes(ctx: Ctx, r: Rect, t: XrTheme, text: string) {
  const lines = plainLines(text);
  if (!lines.length) return quiet(ctx, r, t, 'Die Notiz ist noch leer.');
  let y = r.y + 20;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const l of lines) {
    if (!l.text) {
      y += 10;
      continue;
    }
    ctx.font = font(l.bold ? 20 : 17, l.bold ? 700 : 400);
    ctx.fillStyle = t.text;
    const indent = l.bullet ? 22 : 0;
    const wrapped = wrapText(ctx, l.text, r.w - indent, 3);
    for (const [i, w] of wrapped.entries()) {
      if (y > r.y + r.h - 4) return;
      if (l.bullet && i === 0) ctx.fillText('•', r.x + 4, y);
      ctx.fillText(w, r.x + indent, y);
      y += l.bold ? 28 : 25;
    }
    y += 4;
  }
}

// --- charts: bars and lines from a report result ------------------------------------------------------------------

interface Point {
  label: string;
  value: number;
}

/** The first measure of a report result as labelled points (a time series or one bar per group). */
export function reportPoints(result: any, limit = 24): { points: Point[]; format: NumberFormat; measure: string } {
  const measure = result?.measures?.[0];
  const format = (measure?.format ?? 'number') as NumberFormat;
  const rows: any[] = Array.isArray(result?.rows) ? result.rows : [];
  let points: Point[] = rows.map((row) => ({ label: Array.isArray(row?.l) ? row.l.join(' ') : '', value: Number(row?.v?.[0] ?? 0) || 0 }));
  if (points.length > limit) {
    // keep the shape: bucket the series down to `limit` points
    const size = points.length / limit;
    points = Array.from({ length: limit }, (_, i) => {
      const slice = points.slice(Math.floor(i * size), Math.floor((i + 1) * size));
      return { label: slice[slice.length - 1]?.label ?? '', value: slice.reduce((a, p) => a + p.value, 0) };
    });
  }
  return { points, format, measure: measure?.label ?? '' };
}

function report(ctx: Ctx, r: Rect, t: XrTheme, viz: string, result: any) {
  if (viz === 'kpi' || viz === 'table') {
    const v = result?.totals?.v?.[0];
    if (viz === 'kpi') return bigNumber(ctx, r, t, { kind: 'number', value: typeof v === 'number' ? v : null, label: result?.measures?.[0]?.label, format: (result?.measures?.[0]?.format ?? 'number') as NumberFormat });
  }
  const { points, format, measure } = reportPoints(result);
  if (!points.length) return quiet(ctx, r, t, 'Keine Daten im Zeitraum.');
  const top = r.y + 24;
  const bottom = r.y + r.h - 34;
  const left = r.x + 6;
  const w = r.w - 12;
  const max = Math.max(1, ...points.map((p) => p.value));
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(14, 500);
  ctx.fillStyle = t.muted;
  ctx.fillText(ellipsize(ctx, `${measure} · höchster Wert ${formatValue(max, format)}`, r.w), r.x, r.y + 14);
  ctx.fillStyle = t.line;
  ctx.fillRect(left, bottom, w, 2);
  const step = w / points.length;
  if (viz === 'line' || viz === 'area') {
    const xy = (i: number, p: Point) => [left + step * (i + 0.5), bottom - (p.value / max) * (bottom - top)] as const;
    ctx.beginPath();
    points.forEach((p, i) => {
      const [x, y] = xy(i, p);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = t.brand;
    ctx.stroke();
    if (viz === 'area') {
      const [lx] = xy(points.length - 1, points[points.length - 1]);
      ctx.lineTo(lx, bottom);
      ctx.lineTo(left + step * 0.5, bottom);
      ctx.closePath();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = t.brand;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  } else {
    const bw = Math.max(4, step * 0.64);
    points.forEach((p, i) => {
      const h = (p.value / max) * (bottom - top);
      ctx.fillStyle = t.brand;
      roundRect(ctx, left + step * i + (step - bw) / 2, bottom - h, bw, Math.max(2, h), Math.min(5, bw / 2));
      ctx.fill();
    });
  }
  // a few labels along the bottom
  ctx.font = font(13, 400);
  ctx.fillStyle = t.muted;
  const widest = Math.max(...points.map((p) => ctx.measureText(p.label.replace(/^(\d{2}\.\d{2})\.\d{4}$/, '$1')).width), 20);
  const every = Math.max(1, Math.ceil((widest + 12) / step));
  ctx.textAlign = 'center';
  points.forEach((p, i) => {
    if (i % every === 0 && (i === points.length - 1 || points.length - 1 - i >= every / 2)) ctx.fillText(ellipsize(ctx, p.label.replace(/^(\d{2}\.\d{2})\.\d{4}$/, '$1'), step * every - 6), left + step * (i + 0.5), bottom + 22);
  });
  ctx.textAlign = 'left';
}

// --- the control panel (HUD) ------------------------------------------------------------------------------------------

export type HudButton = 'mic' | 'apply' | 'reject' | 'reset' | 'exit' | 'refresh' | 'theme';
export interface HudRegion {
  id: HudButton;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface HudState {
  title: string;
  /** "Live" line: who changed the board last. */
  live?: string;
  mic: 'idle' | 'recording' | 'working' | 'off';
  /** What was understood, what happened, an error. */
  message?: string;
  messageTone?: 'normal' | 'error' | 'good';
  /** A proposal that waits for "Übernehmen". */
  proposal?: { summary: string; risk: string } | null;
  /** The buttons this panel shows (the board: mic + reset + exit; the canvas: refresh + exit). */
  buttons: HudButton[];
  readOnly?: boolean;
  hover?: HudButton | null;
}

const BUTTON_LABEL: Record<HudButton, string> = { mic: 'Sprechen', apply: 'Übernehmen', reject: 'Verwerfen', reset: 'Neu anordnen', exit: 'Beenden', refresh: 'Aktualisieren', theme: 'Hell / Dunkel' };

/** Draws the control panel and returns where its buttons are (texture pixels), for pointing at them. */
export function drawHud(ctx: Ctx, W: number, H: number, s: HudState, t: XrTheme): HudRegion[] {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.scale(DESIGN_SCALE, DESIGN_SCALE);
  const w = W / DESIGN_SCALE;
  const h = H / DESIGN_SCALE;
  roundRect(ctx, 0, 0, w, h, 22);
  ctx.fillStyle = t.dark ? 'rgba(20, 28, 51, 0.96)' : 'rgba(255, 255, 255, 0.97)';
  ctx.fill();
  roundRect(ctx, 1, 1, w - 2, h - 2, 21);
  ctx.lineWidth = 2;
  ctx.strokeStyle = t.line;
  ctx.stroke();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = t.text;
  ctx.font = font(21, 750);
  ctx.fillText(ellipsize(ctx, s.title, w * 0.62), 20, 34);
  if (s.live) {
    ctx.font = font(14, 600);
    ctx.fillStyle = t.green;
    ctx.textAlign = 'right';
    ctx.fillText(ellipsize(ctx, `● ${s.live}`, w * 0.34), w - 20, 33);
    ctx.textAlign = 'left';
  }
  // message / proposal
  const msg = s.proposal ? `Vorschlag: ${s.proposal.summary}` : s.message;
  if (msg) {
    ctx.font = font(17, 500);
    ctx.fillStyle = s.messageTone === 'error' ? t.red : s.messageTone === 'good' ? t.green : t.text;
    wrapText(ctx, msg, w - 40, 2).forEach((l, i) => ctx.fillText(l, 20, 66 + i * 23));
  } else {
    ctx.font = font(16, 400);
    ctx.fillStyle = t.muted;
    const hint = s.readOnly ? 'Nur Ansicht: du darfst dieses Board nicht ändern.' : s.mic === 'off' && s.buttons.includes('mic') ? 'Sprachsteuerung: erst unter Einstellungen → Stimme einrichten.' : s.buttons.includes('mic') ? 'Halte „Sprechen“ und sag z. B. „Zeig mir die offenen Angebote“.' : 'Panel greifen und ziehen: verschieben.';
    wrapText(ctx, hint, w - 40, 2).forEach((l, i) => ctx.fillText(l, 20, 66 + i * 23));
  }
  // buttons
  const regions: HudRegion[] = [];
  const ids: HudButton[] = s.proposal ? ['apply', 'reject', ...s.buttons.filter((b) => b === 'mic' || b === 'exit')] : s.buttons.filter((b) => !(b === 'mic' && s.mic === 'off'));
  const bh = 58;
  const gap = 12;
  const y = h - bh - 16;
  const base = ids.map((id) => ({ mic: 190, reset: 175, apply: 170, reject: 140, exit: 120, refresh: 190, theme: 175 })[id]);
  const room = w - 32 - gap * Math.max(0, ids.length - 1);
  const f = Math.min(1, room / Math.max(1, base.reduce((a, b) => a + b, 0)));
  const widths = base.map((b) => b * f);
  const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, ids.length - 1);
  let x = (w - total) / 2;
  ids.forEach((id, i) => {
    const bw = widths[i];
    const primary = id === 'mic' || id === 'apply';
    const hot = s.hover === id;
    const recording = id === 'mic' && s.mic === 'recording';
    roundRect(ctx, x, y, bw, bh, 18);
    ctx.fillStyle = recording ? t.red : primary ? t.brand : t.dark ? '#26335a' : '#eef1f6';
    ctx.fill();
    if (hot || recording) {
      roundRect(ctx, x - 2, y - 2, bw + 4, bh + 4, 20);
      ctx.lineWidth = 4;
      ctx.strokeStyle = recording ? t.red : t.brandText;
      ctx.stroke();
    }
    ctx.fillStyle = recording || primary ? '#ffffff' : t.text;
    ctx.font = font(18, 700);
    ctx.textAlign = 'center';
    const label = id === 'mic' ? (s.mic === 'recording' ? 'Ich höre zu …' : s.mic === 'working' ? 'Ich schreibe mit …' : '🎤 Sprechen') : BUTTON_LABEL[id];
    ctx.fillText(ellipsize(ctx, label, bw - 14), x + bw / 2, y + bh / 2 + 6);
    regions.push({ id, x: x * DESIGN_SCALE, y: y * DESIGN_SCALE, w: bw * DESIGN_SCALE, h: bh * DESIGN_SCALE });
    x += bw + gap;
  });
  ctx.textAlign = 'left';
  ctx.restore();
  return regions;
}

/** The button under a point on the HUD texture (u, v = 0…1 from the top left), or null. */
export function hudButtonAt(regions: HudRegion[], u: number, v: number, W: number, H: number): HudButton | null {
  const px = u * W;
  const py = v * H;
  return regions.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h)?.id ?? null;
}

/** Is the point on the title bar of a widget panel (the part that grabs)? `v` is 0…1 from the top, `texH` the texture height in pixels. */
export const onGrip = (v: number, texH: number) => v * texH <= HEAD_H * DESIGN_SCALE;

/** The canvas image on its plane: fitted, on white (a Canvas is white paper in the browser too). */
export function drawImagePlane(ctx: Ctx, W: number, H: number, img: CanvasImageSource | null, iw: number, ih: number, t: XrTheme, message?: string) {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  if (img && iw > 0 && ih > 0) ctx.drawImage(img, 0, 0, W, H);
  else {
    ctx.fillStyle = t.muted;
    ctx.font = `600 ${Math.round(H / 18)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message ?? 'Canvas wird geladen …', W / 2, H / 2);
  }
  ctx.restore();
}
