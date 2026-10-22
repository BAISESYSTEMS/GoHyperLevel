/**
 * Path primitives for the canvas renderer: absolute commands (M/L/C/Q/Z), an SVG path-data parser
 * (all commands incl. arcs, which become cubic curves), shapes, flattening and transforms – enough
 * for SVG, PDF and the PNG rasterizer to draw the same geometry.
 *
 * Pure code without imports (also used in the browser).
 */

export type Cmd = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Q', number, number, number, number] | ['Z'];
export type Pt = [number, number];
/** 2D affine matrix [a, b, c, d, e, f] like SVG/Canvas: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m: Mat, n: Mat): Mat {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];
export function rotateAround(deg: number, cx: number, cy: number): Mat {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
}
export const apply = (m: Mat, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export function transformCmds(cmds: Cmd[], m: Mat): Cmd[] {
  return cmds.map((c): Cmd => {
    switch (c[0]) {
      case 'M':
      case 'L': {
        const [x, y] = apply(m, c[1], c[2]);
        return [c[0], x, y];
      }
      case 'C': {
        const a = apply(m, c[1], c[2]);
        const b = apply(m, c[3], c[4]);
        const p = apply(m, c[5], c[6]);
        return ['C', a[0], a[1], b[0], b[1], p[0], p[1]];
      }
      case 'Q': {
        const a = apply(m, c[1], c[2]);
        const p = apply(m, c[3], c[4]);
        return ['Q', a[0], a[1], p[0], p[1]];
      }
      default:
        return c;
    }
  });
}

const fmt = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

export function cmdsToD(cmds: Cmd[]): string {
  let d = '';
  for (const c of cmds) {
    if (c[0] === 'Z') d += 'Z';
    else d += c[0] + (c.slice(1) as number[]).map(fmt).join(' ');
  }
  return d;
}

// --- shapes -----------------------------------------------------------------------------------

export function rectCmds(x: number, y: number, w: number, h: number, r = 0): Cmd[] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!rr) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
  const k = 0.5523 * rr;
  return [
    ['M', x + rr, y],
    ['L', x + w - rr, y],
    ['C', x + w - rr + k, y, x + w, y + rr - k, x + w, y + rr],
    ['L', x + w, y + h - rr],
    ['C', x + w, y + h - rr + k, x + w - rr + k, y + h, x + w - rr, y + h],
    ['L', x + rr, y + h],
    ['C', x + rr - k, y + h, x, y + h - rr + k, x, y + h - rr],
    ['L', x, y + rr],
    ['C', x, y + rr - k, x + rr - k, y, x + rr, y],
    ['Z'],
  ];
}

export function ellipseCmds(cx: number, cy: number, rx: number, ry: number): Cmd[] {
  const kx = 0.5523 * rx;
  const ky = 0.5523 * ry;
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ['Z'],
  ];
}

export function polyCmds(pts: Pt[], close = false): Cmd[] {
  if (!pts.length) return [];
  const out: Cmd[] = [['M', pts[0][0], pts[0][1]]];
  for (let i = 1; i < pts.length; i++) out.push(['L', pts[i][0], pts[i][1]]);
  if (close) out.push(['Z']);
  return out;
}

/** Pie / donut slice from angle a0 to a1 (radians, 0 = 3 o'clock, clockwise in screen space). */
export function sliceCmds(cx: number, cy: number, r: number, a0: number, a1: number, inner = 0): Cmd[] {
  const out: Cmd[] = [];
  const arc = (rad: number, from: number, to: number, first: boolean) => {
    const steps = Math.max(1, Math.ceil(Math.abs(to - from) / (Math.PI / 2)));
    const step = (to - from) / steps;
    for (let i = 0; i < steps; i++) {
      const s = from + i * step;
      const e = s + step;
      const k = (4 / 3) * Math.tan((e - s) / 4);
      const p0: Pt = [cx + rad * Math.cos(s), cy + rad * Math.sin(s)];
      const p1: Pt = [cx + rad * Math.cos(e), cy + rad * Math.sin(e)];
      if (first && i === 0) out.push(['M', p0[0], p0[1]]);
      else if (i === 0) out.push(['L', p0[0], p0[1]]);
      out.push(['C', p0[0] - k * rad * Math.sin(s), p0[1] + k * rad * Math.cos(s), p1[0] + k * rad * Math.sin(e), p1[1] - k * rad * Math.cos(e), p1[0], p1[1]]);
    }
  };
  if (Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6) {
    if (inner > 0) {
      // the hole runs the other way round, so non-zero filling leaves it empty
      const k = 0.5523 * inner;
      return [
        ...ellipseCmds(cx, cy, r, r),
        ['M', cx + inner, cy],
        ['C', cx + inner, cy - k, cx + k, cy - inner, cx, cy - inner],
        ['C', cx - k, cy - inner, cx - inner, cy - k, cx - inner, cy],
        ['C', cx - inner, cy + k, cx - k, cy + inner, cx, cy + inner],
        ['C', cx + k, cy + inner, cx + inner, cy + k, cx + inner, cy],
        ['Z'],
      ];
    }
    return ellipseCmds(cx, cy, r, r);
  }
  if (inner > 0) {
    arc(r, a0, a1, true);
    arc(inner, a1, a0, false);
  } else {
    out.push(['M', cx, cy]);
    arc(r, a0, a1, false);
  }
  out.push(['Z']);
  return out;
}

// --- SVG path data parser ------------------------------------------------------------------------

/** Parses SVG path data into absolute M/L/C/Q/Z commands (H/V/S/T/A are converted). */
export function parsePathD(d: string): Cmd[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: Cmd[] = [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lastC: Pt | null = null;
  let lastQ: Pt | null = null;
  const isCmd = (t: string) => /^[a-zA-Z]$/.test(t);
  const n = () => Number(tokens[i++]);
  const flag = () => {
    // arc flags may be written without separators ("a1 1 0 01 1 1")
    const t = tokens[i];
    if (t.length > 1 && (t[0] === '0' || t[0] === '1')) {
      tokens[i] = t.slice(1);
      return Number(t[0]);
    }
    i++;
    return Number(t);
  };
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    else if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const bx = rel ? x : 0;
    const by = rel ? y : 0;
    switch (C) {
      case 'M': {
        x = bx + n();
        y = by + n();
        sx = x;
        sy = y;
        out.push(['M', x, y]);
        cmd = rel ? 'l' : 'L';
        lastC = lastQ = null;
        break;
      }
      case 'L':
        x = bx + n();
        y = by + n();
        out.push(['L', x, y]);
        lastC = lastQ = null;
        break;
      case 'H':
        x = (rel ? x : 0) + n();
        out.push(['L', x, y]);
        lastC = lastQ = null;
        break;
      case 'V':
        y = (rel ? y : 0) + n();
        out.push(['L', x, y]);
        lastC = lastQ = null;
        break;
      case 'C': {
        const x1 = bx + n();
        const y1 = by + n();
        const x2 = bx + n();
        const y2 = by + n();
        x = bx + n();
        y = by + n();
        out.push(['C', x1, y1, x2, y2, x, y]);
        lastC = [x2, y2];
        lastQ = null;
        break;
      }
      case 'S': {
        const x1: number = lastC ? 2 * x - lastC[0] : x;
        const y1: number = lastC ? 2 * y - lastC[1] : y;
        const x2 = bx + n();
        const y2 = by + n();
        x = bx + n();
        y = by + n();
        out.push(['C', x1, y1, x2, y2, x, y]);
        lastC = [x2, y2];
        lastQ = null;
        break;
      }
      case 'Q': {
        const x1 = bx + n();
        const y1 = by + n();
        x = bx + n();
        y = by + n();
        out.push(['Q', x1, y1, x, y]);
        lastQ = [x1, y1];
        lastC = null;
        break;
      }
      case 'T': {
        const x1: number = lastQ ? 2 * x - lastQ[0] : x;
        const y1: number = lastQ ? 2 * y - lastQ[1] : y;
        x = bx + n();
        y = by + n();
        out.push(['Q', x1, y1, x, y]);
        lastQ = [x1, y1];
        lastC = null;
        break;
      }
      case 'A': {
        const rx = n();
        const ry = n();
        const rot = n();
        const large = flag();
        const sweep = flag();
        const x2 = bx + n();
        const y2 = by + n();
        out.push(...arcToCubics(x, y, rx, ry, rot, !!large, !!sweep, x2, y2));
        x = x2;
        y = y2;
        lastC = lastQ = null;
        break;
      }
      case 'Z':
        out.push(['Z']);
        x = sx;
        y = sy;
        lastC = lastQ = null;
        break;
      default:
        return out;
    }
  }
  return out;
}

/** SVG elliptical arc → cubic Béziers (W3C implementation notes, F.6). */
export function arcToCubics(x1: number, y1: number, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): Cmd[] {
  if (rx === 0 || ry === 0) return [['L', x2, y2]];
  if (x1 === x2 && y1 === y2) return [];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const step = dt / segs;
  const out: Cmd[] = [];
  const k = (4 / 3) * Math.tan(step / 4);
  let t = t1;
  for (let s = 0; s < segs; s++) {
    const c1 = Math.cos(t);
    const s1 = Math.sin(t);
    const c2 = Math.cos(t + step);
    const s2 = Math.sin(t + step);
    const ep = (ct: number, st: number): Pt => [cx + rx * ct * cos - ry * st * sin, cy + rx * ct * sin + ry * st * cos];
    const d = (ct: number, st: number): Pt => [-rx * st * cos - ry * ct * sin, -rx * st * sin + ry * ct * cos];
    const p1 = ep(c1, s1);
    const p2 = ep(c2, s2);
    const d1 = d(c1, s1);
    const d2 = d(c2, s2);
    out.push(['C', p1[0] + k * d1[0], p1[1] + k * d1[1], p2[0] - k * d2[0], p2[1] - k * d2[1], p2[0], p2[1]]);
    t += step;
  }
  return out;
}

// --- flattening & measuring ------------------------------------------------------------------------

/** Polylines (one per subpath) approximating the path; `tol` = max deviation in px. */
export function flatten(cmds: Cmd[], tol = 0.35): { pts: Pt[]; closed: boolean }[] {
  const out: { pts: Pt[]; closed: boolean }[] = [];
  let cur: Pt[] = [];
  let x = 0;
  let y = 0;
  const push = () => {
    if (cur.length > 1) out.push({ pts: cur, closed: false });
    cur = [];
  };
  for (const c of cmds) {
    switch (c[0]) {
      case 'M':
        push();
        x = c[1];
        y = c[2];
        cur = [[x, y]];
        break;
      case 'L':
        x = c[1];
        y = c[2];
        cur.push([x, y]);
        break;
      case 'C': {
        const len = Math.hypot(c[1] - x, c[2] - y) + Math.hypot(c[3] - c[1], c[4] - c[2]) + Math.hypot(c[5] - c[3], c[6] - c[4]);
        const n = Math.min(64, Math.max(2, Math.ceil(Math.sqrt(len / tol) / 1.5)));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          cur.push([u * u * u * x + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5], u * u * u * y + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6]]);
        }
        x = c[5];
        y = c[6];
        break;
      }
      case 'Q': {
        const len = Math.hypot(c[1] - x, c[2] - y) + Math.hypot(c[3] - c[1], c[4] - c[2]);
        const n = Math.min(48, Math.max(2, Math.ceil(Math.sqrt(len / tol) / 1.5)));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          cur.push([u * u * x + 2 * u * t * c[1] + t * t * c[3], u * u * y + 2 * u * t * c[2] + t * t * c[4]]);
        }
        x = c[3];
        y = c[4];
        break;
      }
      case 'Z':
        if (cur.length > 1) {
          out.push({ pts: cur, closed: true });
          x = cur[0][0];
          y = cur[0][1];
          cur = [[x, y]];
        }
        break;
    }
  }
  push();
  return out;
}

export function polylineLength(pts: Pt[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

/** Point and direction at a fraction (0..1) of a polyline's length. */
export function pointAlong(pts: Pt[], frac: number): { p: Pt; angle: number } {
  const total = polylineLength(pts);
  let want = total * Math.min(1, Math.max(0, frac));
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (want <= seg || i === pts.length - 1) {
      const t = seg ? Math.min(1, want / seg) : 0;
      return { p: [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t], angle: Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) };
    }
    want -= seg;
  }
  return { p: pts[0] ?? [0, 0], angle: 0 };
}

/** Distance from a point to a segment. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distToPolyline(px: number, py: number, pts: Pt[]): number {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSegment(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  if (pts.length === 1) d = Math.hypot(px - pts[0][0], py - pts[0][1]);
  return d;
}

/** Even-odd point-in-polygon. */
export function pointInPolygon(px: number, py: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Catmull-Rom spline through points → cubic Béziers (open curve). */
export function smoothCmds(pts: Pt[], tension = 0.5): Cmd[] {
  if (pts.length < 2) return pts.length ? [['M', pts[0][0], pts[0][1]]] : [];
  if (pts.length === 2) return [['M', pts[0][0], pts[0][1]], ['L', pts[1][0], pts[1][1]]];
  const out: Cmd[] = [['M', pts[0][0], pts[0][1]]];
  const t = tension / 3;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    out.push(['C', p1[0] + (p2[0] - p0[0]) * t * 2, p1[1] + (p2[1] - p0[1]) * t * 2, p2[0] - (p3[0] - p1[0]) * t * 2, p2[1] - (p3[1] - p1[1]) * t * 2, p2[0], p2[1]]);
  }
  return out;
}
