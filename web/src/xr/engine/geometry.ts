import type { Pose } from '../../../../server/services/xr-model';
import { invert, transformDir, transformPoint, trs, vec, type Vec3 } from './math';

/**
 * Where panels hang and how a pointer finds them – pure functions (tests/xr-geometry.test.ts), no WebGL, no WebXR.
 *
 * A Living Board is a grid of cells (12 columns on the desktop). In the headset that grid becomes a curved wall around the
 * viewer: a cell's column decides the angle on a circle of `radius` metres, its row the height, and every panel turns to face
 * the viewer – so the board keeps the arrangement the person made in the browser, just wrapped around them.
 */

/** Metres per grid column/row and the gap between cells. */
export const CELL_M = 0.26;
export const CELL_GAP_M = 0.03;
/** Texture resolution: pixels per metre of panel (a 6-column widget is about 1.6 m wide → ~1000 px). */
export const PX_PER_M = 640;
export const TEX_MAX = 2048;
export const TEX_MIN = 192;
/** The wall is scaled down when it would be taller than this (metres), so a tall board still fits the view. */
export const WALL_MAX_HEIGHT = 2.8;
export const DEFAULT_RADIUS = 2.2;
export const DEFAULT_COLS = 12;

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Ray {
  origin: Vec3;
  dir: Vec3;
}
export interface Hit {
  /** Distance along the ray (the ray's direction is a unit vector). */
  t: number;
  /** Position on the panel, 0…1 from the left / from the top. */
  u: number;
  v: number;
  point: Vec3;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The size of a grid cell range in metres (at scale 1). */
export const cellSize = (c: Pick<Cell, 'w' | 'h'>): Size => ({ width: c.w * CELL_M + (c.w - 1) * CELL_GAP_M, height: c.h * CELL_M + (c.h - 1) * CELL_GAP_M });

/** Texture size in pixels for a panel of this size: sharp enough to read, never beyond what a GPU keeps cheaply. */
export function textureSize(s: Size): { w: number; h: number } {
  const k = Math.min(1, TEX_MAX / Math.max(s.width * PX_PER_M, s.height * PX_PER_M));
  return { w: clamp(Math.round(s.width * PX_PER_M * k), TEX_MIN, TEX_MAX), h: clamp(Math.round(s.height * PX_PER_M * k), TEX_MIN, TEX_MAX) };
}

/** The yaw that turns a panel at p to face a viewer at the origin (+z is its front). */
export const facingYaw = (p: Vec3, fallback = 0) => (Math.hypot(p[0], p[2]) < 1e-4 ? fallback : Math.atan2(-p[0], -p[2]));

export interface Placed {
  id: string;
  pose: Pose;
  size: Size;
}

/**
 * The curved wall: every cell → a pose on the arc and its size. `cols` is the grid width of the board; the wall's vertical middle
 * is at eye level (`yOffset` lowers or raises it). Tall boards are scaled down to fit (pose.scale), never cut.
 */
export function arrangeOnArc(cells: (Cell & { id: string })[], o: { radius?: number; cols?: number; yOffset?: number } = {}): Placed[] {
  if (!cells.length) return [];
  const radius = o.radius ?? DEFAULT_RADIUS;
  const cols = o.cols ?? DEFAULT_COLS;
  const rows = Math.max(...cells.map((c) => c.y + c.h));
  const pitch = CELL_M + CELL_GAP_M;
  const wallW = cols * pitch - CELL_GAP_M;
  const wallH = rows * pitch - CELL_GAP_M;
  const fit = clamp(WALL_MAX_HEIGHT / wallH, 0.5, 1);
  return cells.map((c) => {
    const size = cellSize(c);
    const u = (c.x + c.w / 2) * pitch - CELL_GAP_M / 2 - wallW / 2;
    const v = (c.y + c.h / 2) * pitch - CELL_GAP_M / 2;
    const theta = (u * fit) / radius;
    const x = radius * Math.sin(theta);
    const z = -radius * Math.cos(theta);
    const y = ((wallH / 2 - v) * fit) + (o.yOffset ?? 0);
    return { id: c.id, size, pose: { x: round(x), y: round(y), z: round(z), yaw: round(-theta), scale: round(fit) } };
  });
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Saved poses win over the arc (a widget that was added since has no saved pose and takes its place on the arc). */
export function withSavedPoses(placed: Placed[], saved: Record<string, Pose> | undefined): Placed[] {
  return placed.map((p) => (saved?.[p.id] ? { ...p, pose: saved[p.id] } : p));
}

/** The pose of a panel as the model matrix the renderer draws it with. */
export const modelOf = (p: Pose) => trs([p.x, p.y, p.z], p.yaw, p.scale);

/** Where a ray meets a panel (the flat rectangle of its size at its pose), or null. */
export function hitPanel(ray: Ray, pose: Pose, size: Size): Hit | null {
  const inv = invert(modelOf(pose));
  if (!inv) return null;
  const o = transformPoint(inv, ray.origin);
  const d = transformDir(inv, ray.dir);
  if (Math.abs(d[2]) < 1e-9) return null;
  const t = -o[2] / d[2];
  if (t <= 0) return null;
  const lx = o[0] + d[0] * t;
  const ly = o[1] + d[1] * t;
  if (Math.abs(lx) > size.width / 2 || Math.abs(ly) > size.height / 2) return null;
  return { t, u: lx / size.width + 0.5, v: 0.5 - ly / size.height, point: vec.add(ray.origin, vec.scale(ray.dir, t)) };
}

/** The nearest panel the ray hits. */
export function pickNearest(ray: Ray, panels: Placed[]): { id: string; hit: Hit } | null {
  let best: { id: string; hit: Hit } | null = null;
  for (const p of panels) {
    const hit = hitPanel(ray, p.pose, p.size);
    if (hit && (!best || hit.t < best.hit.t)) best = { id: p.id, hit };
  }
  return best;
}

// --- grabbing ----------------------------------------------------------------------------------------------

export interface Grab {
  id: string;
  /** Distance of the hand along its ray, kept while moving (the thumbstick or the wheel changes it). */
  dist: number;
  /** Panel centre minus the grabbed point: the panel does not jump to the hand. */
  offset: Vec3;
  start: Pose;
}

export function startGrab(ray: Ray, hit: Hit, id: string, pose: Pose): Grab {
  return { id, dist: hit.t, offset: vec.sub([pose.x, pose.y, pose.z], hit.point), start: pose };
}

export const REACH = { min: 0.6, max: 8 } as const;
export const SCALE = { min: 0.25, max: 3 } as const;

/** The pose of a grabbed panel for the hand's current ray (and the thumbstick's push/pull and size change). */
export function moveGrab(g: Grab, ray: Ray, change: { dist?: number; scale?: number } = {}): { pose: Pose; grab: Grab } {
  const dist = clamp(g.dist + (change.dist ?? 0), REACH.min, REACH.max);
  const c = vec.add(vec.add(ray.origin, vec.scale(vec.norm(ray.dir), dist)), g.offset);
  const reach = 20;
  const p: Vec3 = [clamp(c[0], -reach, reach), clamp(c[1], -reach, reach), clamp(c[2], -reach, reach)];
  const scale = clamp(g.start.scale * (1 + (change.scale ?? 0)), SCALE.min, SCALE.max);
  const pose: Pose = { x: round(p[0]), y: round(p[1]), z: round(p[2]), yaw: round(facingYaw(p, g.start.yaw)), scale: round(scale) };
  return { pose, grab: { ...g, dist, start: { ...g.start, scale } } };
}

/** Panels back to front for drawing with blending (distance from the eye). */
export function backToFront<T extends { pose: Pose }>(items: T[], eye: Vec3): T[] {
  const d = (p: Pose) => (p.x - eye[0]) ** 2 + (p.y - eye[1]) ** 2 + (p.z - eye[2]) ** 2;
  return items.slice().sort((a, b) => d(b.pose) - d(a.pose));
}

// --- the other panels ------------------------------------------------------------------------------------------

/** The control panel (title, microphone, proposals): below the wall (clear of its lowest row), a little closer. */
export const HUD_POSE: Pose = { x: 0, y: -1.32, z: -1.15, yaw: 0, scale: 1 };
export const HUD_SIZE: Size = { width: 1.5, height: 0.5 };

/** A large plane for an image of this aspect: as wide as `width`, never taller than `maxHeight`. */
export function fitPlane(imgW: number, imgH: number, width = 3.2, maxHeight = 2.1): Size {
  if (imgW <= 0 || imgH <= 0) return { width, height: width * 0.625 };
  const h = (width * imgH) / imgW;
  if (h <= maxHeight) return { width, height: h };
  return { width: (maxHeight * imgW) / imgH, height: maxHeight };
}
export const CANVAS_POSE: Pose = { x: 0, y: 0.1, z: -2.6, yaw: 0, scale: 1 };

/** Points of a floor ring for orientation in VR (pairs for GL_LINES). */
export function ringLines(radius: number, segments = 64, y = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    out.push(Math.sin(a) * radius, y, -Math.cos(a) * radius, Math.sin(b) * radius, y, -Math.cos(b) * radius);
  }
  return out;
}
