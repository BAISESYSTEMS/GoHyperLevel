/**
 * A single-stroke vector font for the server's PNG export (no font files, no library). Glyphs are
 * drawn on a grid: baseline y = 0, x-height 7, cap height 10, descender −3 (y grows upwards).
 *
 * Commands: `M x y` starts a stroke, `L x y` continues it, `A cx cy rx ry a0 a1` adds an arc
 * (degrees, counter-clockwise; a1 < a0 runs clockwise), `E cx cy rx ry` is a closed ellipse,
 * `D x y` a dot.
 */

const G: Record<string, string> = {
  A: 'M0 0 L4 10 L8 0 M1.5 3.6 L6.5 3.6',
  B: 'M0 0 L0 10 L4.3 10 A4.3 7.5 2.5 2.5 90 -90 L0 5 M4.3 5 A4.6 2.5 2.9 2.5 90 -90 L0 0',
  C: 'A4.6 5 4.6 5 42 318',
  D: 'M0 0 L0 10 L3.6 10 A3.6 5 4.4 5 90 -90 L0 0',
  E: 'M7 10 L0 10 L0 0 L7 0 M0 5 L5.5 5',
  F: 'M7 10 L0 10 L0 0 M0 5 L5.5 5',
  G: 'A4.6 5 4.6 5 42 360 L5.4 5',
  H: 'M0 0 L0 10 M8 0 L8 10 M0 5 L8 5',
  I: 'M0 0 L0 10',
  J: 'M6 10 L6 3 A3 3 3 3 0 -180',
  K: 'M0 0 L0 10 M7.5 10 L0 3.6 M2.6 5.8 L8 0',
  L: 'M0 10 L0 0 L6.5 0',
  M: 'M0 0 L0 10 L5 1.5 L10 10 L10 0',
  N: 'M0 0 L0 10 L8 0 L8 10',
  O: 'E5 5 5 5',
  P: 'M0 0 L0 10 L4.5 10 A4.5 7.4 2.6 2.6 90 -90 L0 4.8',
  Q: 'E5 5 5 5 M6.2 2.6 L10 -0.6',
  R: 'M0 0 L0 10 L4.5 10 A4.5 7.4 2.6 2.6 90 -90 L0 4.8 M4.2 4.8 L8 0',
  S: 'A4 7.5 3.8 2.5 25 270 A4 2.5 4 2.5 90 -155',
  T: 'M0 10 L8 10 M4 10 L4 0',
  U: 'M0 10 L0 3.6 A4 3.6 4 3.6 180 360 L8 10',
  V: 'M0 10 L4 0 L8 10',
  W: 'M0 10 L2.75 0 L5.5 10 L8.25 0 L11 10',
  X: 'M0 10 L8 0 M0 0 L8 10',
  Y: 'M0 10 L4 5 L8 10 M4 5 L4 0',
  Z: 'M0 10 L8 10 L0 0 L8 0',
  a: 'E3.2 3.5 3.2 3.5 M6.4 7 L6.4 0',
  b: 'M0 10 L0 0 E3.2 3.5 3.2 3.5',
  c: 'A3.3 3.5 3.3 3.5 45 315',
  d: 'M6.4 10 L6.4 0 E3.2 3.5 3.2 3.5',
  e: 'M0 3.5 L6.4 3.5 A3.2 3.5 3.2 3.5 0 320',
  f: 'M4.8 9.6 A3.4 8.5 1.6 1.5 50 180 L1.8 0 M0 7 L4.3 7',
  g: 'E3.2 3.5 3.2 3.5 M6.4 7 L6.4 -1 A3.2 -1 3.2 2 0 -165',
  h: 'M0 10 L0 0 M0 4 A3 4 3 3 180 0 L6 0',
  i: 'M0 0 L0 7 D0 9.3',
  j: 'M2 7 L2 -1.5 A0.5 -1.5 1.5 1.5 0 -160 D2 9.3',
  k: 'M0 10 L0 0 M5.5 7 L0 2.5 M2 4 L6 0',
  l: 'M0 10 L0 0',
  m: 'M0 0 L0 7 M0 4.5 A2.5 4.5 2.5 2.5 180 0 L5 0 M5 4.5 A7.5 4.5 2.5 2.5 180 0 L10 0',
  n: 'M0 0 L0 7 M0 4 A3 4 3 3 180 0 L6 0',
  o: 'E3.3 3.5 3.3 3.5',
  p: 'M0 7 L0 -3 E3.2 3.5 3.2 3.5',
  q: 'M6.4 7 L6.4 -3 E3.2 3.5 3.2 3.5',
  r: 'M0 0 L0 7 M0 4 A3 4 3 3 180 70',
  s: 'A3 5.25 2.9 1.75 25 270 A3 1.75 3 1.75 90 -155',
  t: 'M2 9.5 L2 1.2 A3.6 1.2 1.6 1.2 180 300 M0 7 L4.4 7',
  u: 'M0 7 L0 3 A3 3 3 3 180 360 M6 7 L6 0',
  v: 'M0 7 L3 0 L6 7',
  w: 'M0 7 L2.2 0 L4.5 7 L6.8 0 L9 7',
  x: 'M0 7 L6 0 M0 0 L6 7',
  y: 'M0 7 L3 0 M6 7 L2 -3',
  z: 'M0 7 L6 7 L0 0 L6 0',
  '0': 'E3.5 5 3.5 5',
  '1': 'M1 8 L3.5 10 L3.5 0',
  '2': 'A3.5 6.6 3.4 3.4 160 -40 L0 0 L7 0',
  '3': 'A3.5 7.5 3.3 2.5 150 -90 A3.5 2.6 3.6 2.6 90 -150',
  '4': 'M5.5 0 L5.5 10 L0 3 L7.5 3',
  '5': 'M6.5 10 L1 10 L0.6 5.3 A3.5 3.3 3.5 3.3 140 -150',
  '6': 'E3.5 3.3 3.5 3.3 M0 3.6 A4.6 4 4.6 6 180 62',
  '7': 'M0 10 L7 10 L2.5 0',
  '8': 'E3.5 7.6 2.9 2.4 E3.5 2.7 3.5 2.7',
  '9': 'E3.5 6.7 3.5 3.3 M7 6.4 A2.4 6 4.6 6 0 -118',
  '.': 'D0 0.2',
  ',': 'M0.6 0.6 L0 -1.8',
  ':': 'D0 0.2 D0 5.2',
  ';': 'M0.6 0.6 L0 -1.8 D0.6 5.2',
  '!': 'M0 10 L0 3 D0 0.2',
  '?': 'A3 7.5 3 2.5 160 -60 L3 3.6 L3 3 D3 0.2',
  '-': 'M0 3.6 L4 3.6',
  '+': 'M0 4 L6 4 M3 1 L3 7',
  '=': 'M0 5 L6 5 M0 2.6 L6 2.6',
  _: 'M0 -1.5 L7 -1.5',
  '/': 'M0 -1 L5 11',
  '\\': 'M0 11 L5 -1',
  '(': 'A3.5 4.5 3 6.6 118 242',
  ')': 'A-0.5 4.5 3 6.6 62 -62',
  '[': 'M3 11 L0 11 L0 -1.5 L3 -1.5',
  ']': 'M0 11 L3 11 L3 -1.5 L0 -1.5',
  '{': 'M3 11 L1.5 10 L1.5 6 L0 4.8 L1.5 3.6 L1.5 -0.5 L3 -1.5',
  '}': 'M0 11 L1.5 10 L1.5 6 L3 4.8 L1.5 3.6 L1.5 -0.5 L0 -1.5',
  "'": 'M0 10 L0 7',
  '"': 'M0 10 L0 7 M2 10 L2 7',
  '`': 'M0 10 L1.5 8.5',
  '*': 'M3 10 L3 5 M0.6 8.8 L5.4 6.2 M0.6 6.2 L5.4 8.8',
  '#': 'M2 0 L3 10 M5 0 L6 10 M0 3 L7.5 3 M0.5 7 L8 7',
  '%': 'E1.8 8 1.8 2 E6.2 2 1.8 2 M7 10 L1 0',
  '&': 'M8.5 0 L2 7 A3.3 8.3 1.6 1.6 210 -30 L1.3 3 A3.4 2.4 2.3 2.4 140 -35 L7.8 4.6',
  '@': 'E5 4.6 2 2.2 M7 6.8 L7 3.2 A8.4 3.2 1.4 1.4 180 360 A5 4.6 5 5 0 330',
  '€': 'A5 5 4 5 50 310 M0 6 L6 6 M0 4 L6 4',
  $: 'A4 7.5 3.8 2.5 25 270 A4 2.5 4 2.5 90 -155 M4 11 L4 -1',
  '<': 'M6 8 L0 4 L6 0',
  '>': 'M0 8 L6 4 L0 0',
  '|': 'M0 11 L0 -2',
  '~': 'M0 3.5 L1 4.3 L2 4.5 L3 4 L4 3.5 L5 3.6 L6 4.3',
  '^': 'M0 6 L3 10 L6 6',
  '°': 'E1.5 8.5 1.5 1.5',
  '§': 'A3 8 2.8 2 25 270 A3 4 3 2 90 -155 M5.8 6 A3 4 3 2 -25 90 M0.2 2 A3 0 3 2 205 450',
  '…': 'D0 0.2 D3 0.2 D6 0.2',
  '–': 'M0 3.6 L6 3.6',
  '—': 'M0 3.6 L10 3.6',
  '„': 'M0.6 0.6 L0 -1.8 M2.8 0.6 L2.2 -1.8',
  '“': 'M0.6 7.8 L1.2 10.2 M2.8 7.8 L3.4 10.2',
  '”': 'M0.6 10.2 L0 7.8 M2.8 10.2 L2.2 7.8',
  '‚': 'M0.6 0.6 L0 -1.8',
  '‘': 'M0.6 7.8 L1.2 10.2',
  '’': 'M0.6 10.2 L0 7.8',
  '•': 'E1 4 1 1 E1 4 0.4 0.4',
  '·': 'D0 4',
  '→': 'M0 4 L9 4 M6 6.5 L9 4 L6 1.5',
  '←': 'M9 4 L0 4 M3 6.5 L0 4 L3 1.5',
  '✓': 'M0 4 L3 0.5 L9 9',
  '›': 'M0 6.5 L3 3.5 L0 0.5',
  '‹': 'M3 6.5 L0 3.5 L3 0.5',
  '↗': 'M0 0 L7 7 M2.5 7 L7 7 L7 2.5',
  '↑': 'M3 0 L3 9 M0.5 6.5 L3 9 L5.5 6.5',
  '↓': 'M3 9 L3 0 M0.5 2.5 L3 0 L5.5 2.5',
  '×': 'M0 1 L5 6 M0 6 L5 1',
  ß: 'M0 0 L0 7.5 A3 7.6 3 2.4 180 -50 L3.6 5.2 A3.4 2.6 3 2.6 90 -140',
};

// accented letters: base + mark
const MARKS: Record<string, [string, string]> = {
  ä: ['a', 'D2 9.3 D4.4 9.3'],
  ö: ['o', 'D2.1 9.3 D4.5 9.3'],
  ü: ['u', 'D1.8 9.3 D4.2 9.3'],
  Ä: ['A', 'D2.6 12 D5.4 12'],
  Ö: ['O', 'D3.6 12 D6.4 12'],
  Ü: ['U', 'D2.6 12 D5.4 12'],
  é: ['e', 'M3 8.6 L4.6 10.2'],
  è: ['e', 'M1.8 10.2 L3.4 8.6'],
  ê: ['e', 'M1.6 8.6 L3.2 10 L4.8 8.6'],
  á: ['a', 'M3 8.6 L4.6 10.2'],
  à: ['a', 'M1.8 10.2 L3.4 8.6'],
  â: ['a', 'M1.6 8.6 L3.2 10 L4.8 8.6'],
  ó: ['o', 'M3 8.6 L4.6 10.2'],
  ò: ['o', 'M1.8 10.2 L3.4 8.6'],
  ô: ['o', 'M1.6 8.6 L3.3 10 L5 8.6'],
  ú: ['u', 'M3 8.6 L4.6 10.2'],
  ù: ['u', 'M1.8 10.2 L3.4 8.6'],
  í: ['l', 'M0 8.6 L1.4 10.2'],
  ñ: ['n', 'M0.6 9 L1.6 9.8 L3 9.2 L4.4 9.8 L5.4 9'],
  ç: ['c', 'M3.3 0 L3.3 -1 L2.3 -2.2'],
  É: ['E', 'M3 11 L4.6 12.6'],
};

type Pt = [number, number];
export interface Glyph {
  strokes: Pt[][];
  minX: number;
  maxX: number;
}

function parse(src: string): Pt[][] {
  const t = src.trim().split(/\s+/);
  const strokes: Pt[][] = [];
  let cur: Pt[] | null = null;
  let i = 0;
  const n = () => Number(t[i++]);
  while (i < t.length) {
    const c = t[i];
    if (/^[MLAED]$/.test(c)) i++;
    const cmd = /^[MLAED]$/.test(c) ? c : c.match(/^([MLAED])(.+)$/)?.[1];
    if (!cmd) break;
    if (!/^[MLAED]$/.test(c)) t[i] = c.slice(1);
    switch (cmd) {
      case 'M':
        cur = [[n(), n()]];
        strokes.push(cur);
        break;
      case 'L':
        if (!cur) strokes.push((cur = []));
        cur.push([n(), n()]);
        break;
      case 'D': {
        const x = n();
        const y = n();
        strokes.push([[x, y], [x, y + 0.01]]);
        cur = null;
        break;
      }
      case 'A':
      case 'E': {
        const cx = n();
        const cy = n();
        const rx = n();
        const ry = n();
        const a0 = cmd === 'E' ? 0 : n();
        const a1 = cmd === 'E' ? 360 : n();
        if (cmd === 'E' || !cur) strokes.push((cur = []));
        const steps = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 12));
        for (let k = 0; k <= steps; k++) {
          const a = ((a0 + ((a1 - a0) * k) / steps) * Math.PI) / 180;
          cur!.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
        }
        if (cmd === 'E') cur = null;
        break;
      }
    }
  }
  return strokes.filter((s) => s.length);
}

const cache = new Map<string, Glyph | null>();

/** The glyph for a character (null = unknown → caller draws a box). */
export function glyph(ch: string): Glyph | null {
  if (cache.has(ch)) return cache.get(ch)!;
  let src = G[ch];
  if (!src && MARKS[ch]) src = `${G[MARKS[ch][0]]} ${MARKS[ch][1]}`;
  if (!src) {
    cache.set(ch, null);
    return null;
  }
  const strokes = parse(src);
  let minX = Infinity;
  let maxX = -Infinity;
  for (const s of strokes)
    for (const p of s) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
    }
  const g = { strokes, minX: Number.isFinite(minX) ? minX : 0, maxX: Number.isFinite(maxX) ? maxX : 0 };
  cache.set(ch, g);
  return g;
}
