import { describe, expect, it } from 'vitest';
import { cleanBoardLayout } from '../server/services/xr-model';
import {
  CELL_GAP_M,
  CELL_M,
  HUD_POSE,
  HUD_SIZE,
  PX_PER_M,
  TEX_MAX,
  TEX_MIN,
  WALL_MAX_HEIGHT,
  arrangeOnArc,
  backToFront,
  cellSize,
  facingYaw,
  fitPlane,
  hitPanel,
  modelOf,
  moveGrab,
  pickNearest,
  ringLines,
  startGrab,
  textureSize,
  withSavedPoses,
} from '../web/src/xr/engine/geometry';
import { identity, invert, lookAt, multiply, perspective, rotationY, screenRay, transformDir, transformPoint, translation, trs, vec } from '../web/src/xr/engine/math';

const close = (a: ArrayLike<number>, b: ArrayLike<number>, d = 4) => a.length === b.length && [...a].every((x, i) => Math.abs(x - b[i]) < 10 ** -d);

describe('matrices', () => {
  it('multiplies, inverts and transforms like the maths says', () => {
    const m = trs([1, 2, -3], 0.7, 2);
    const inv = invert(m)!;
    expect(close(multiply(m, inv), identity())).toBe(true);
    expect(close(multiply(inv, m), identity())).toBe(true);
    expect(close(transformPoint(translation(1, 2, 3), [1, 1, 1]), [2, 3, 4])).toBe(true);
    // rotating a quarter turn around y takes +x to -z
    expect(close(transformDir(rotationY(Math.PI / 2), [1, 0, 0]), [0, 0, -1])).toBe(true);
    expect(invert(new Float32Array(16))).toBeNull();
    const p = transformPoint(m, [0.5, -0.25, 0]);
    expect(close(transformPoint(inv, p), [0.5, -0.25, 0])).toBe(true);
  });

  it('looks at a target and unprojects a screen point to a ray', () => {
    const view = lookAt([0, 0, 5], [0, 0, 0]);
    expect(close(transformPoint(view, [0, 0, 0]), [0, 0, -5])).toBe(true);
    const proj = perspective(Math.PI / 2, 1, 0.1, 100);
    const centre = screenRay(proj, view, 0, 0)!;
    expect(close(centre.dir, [0, 0, -1])).toBe(true);
    expect(close(centre.origin, [0, 0, 4.9], 2)).toBe(true);
    // the right edge of a 90° view looks 45° to the right
    const right = screenRay(proj, view, 1, 0)!;
    expect(right.dir[0]).toBeCloseTo(Math.SQRT1_2, 2);
    expect(right.dir[2]).toBeCloseTo(-Math.SQRT1_2, 2);
    expect(vec.len(right.dir)).toBeCloseTo(1, 5);
  });
});

describe('arc placement of a board', () => {
  const cells = [
    { id: 'a', x: 0, y: 0, w: 4, h: 3 },
    { id: 'b', x: 4, y: 0, w: 4, h: 3 },
    { id: 'c', x: 8, y: 0, w: 4, h: 3 },
    { id: 'd', x: 0, y: 3, w: 12, h: 3 },
  ];
  const placed = arrangeOnArc(cells, { radius: 2.2 });
  const by = (id: string) => placed.find((p) => p.id === id)!;

  it('puts the middle column straight ahead, the others to the sides, all on the circle', () => {
    expect(by('b').pose.x).toBeCloseTo(0, 3);
    expect(by('b').pose.z).toBeCloseTo(-2.2, 3);
    expect(by('a').pose.x).toBeLessThan(0);
    expect(by('c').pose.x).toBeGreaterThan(0);
    expect(by('a').pose.x).toBeCloseTo(-by('c').pose.x, 3);
    for (const p of placed) expect(Math.hypot(p.pose.x, p.pose.z)).toBeCloseTo(2.2, 2);
  });

  it('turns every panel to face the viewer, outer ones more', () => {
    for (const p of placed) expect(p.pose.yaw).toBeCloseTo(facingYaw([p.pose.x, 0, p.pose.z]), 3);
    expect(by('b').pose.yaw).toBeCloseTo(0, 4);
    expect(by('c').pose.yaw).toBeLessThan(0);
    expect(by('a').pose.yaw).toBeGreaterThan(0);
    expect(Math.abs(by('a').pose.yaw)).toBeCloseTo(Math.abs(by('c').pose.yaw), 4);
  });

  it('keeps the rows: higher rows hang higher, the wall is centred on eye level', () => {
    expect(by('a').pose.y).toBeGreaterThan(by('d').pose.y);
    const mid = (by('a').pose.y + by('d').pose.y) / 2;
    expect(mid).toBeCloseTo(0, 3);
    expect(arrangeOnArc(cells, { yOffset: -0.3 }).find((p) => p.id === 'a')!.pose.y).toBeCloseTo(by('a').pose.y - 0.3, 3);
  });

  it('sizes panels from their cells and shrinks a tall wall instead of cutting it', () => {
    expect(by('a').size.width).toBeCloseTo(4 * CELL_M + 3 * CELL_GAP_M, 6);
    expect(cellSize({ w: 1, h: 1 })).toEqual({ width: CELL_M, height: CELL_M });
    expect(by('a').pose.scale).toBe(1);
    const tall = arrangeOnArc([{ id: 'x', x: 0, y: 0, w: 12, h: 3 }, { id: 'y', x: 0, y: 3, w: 12, h: 20 }]);
    expect(tall[0].pose.scale).toBeLessThan(1);
    expect(tall[0].pose.scale).toBeGreaterThanOrEqual(0.5);
    const top = tall[0].pose.y + (tall[0].size.height * tall[0].pose.scale) / 2;
    const bottom = tall[1].pose.y - (tall[1].size.height * tall[1].pose.scale) / 2;
    expect(top - bottom).toBeLessThanOrEqual(WALL_MAX_HEIGHT * 1.6);
    expect(tall[0].pose.scale).toBeGreaterThanOrEqual(0.5);
    expect(arrangeOnArc([])).toEqual([]);
  });

  it('a larger radius means smaller angles, and saved poses win over the arc', () => {
    expect(Math.abs(arrangeOnArc(cells, { radius: 4 }).find((p) => p.id === 'a')!.pose.yaw)).toBeLessThan(Math.abs(by('a').pose.yaw));
    const saved = withSavedPoses(placed, { a: { x: 9, y: 1, z: -1, yaw: 0.2, scale: 1.5 } });
    expect(saved.find((p) => p.id === 'a')!.pose).toEqual({ x: 9, y: 1, z: -1, yaw: 0.2, scale: 1.5 });
    expect(saved.find((p) => p.id === 'b')).toEqual(by('b'));
    expect(withSavedPoses(placed, undefined)).toEqual(placed);
  });

  it('what is placed is exactly what the server accepts back (no clamping surprises)', () => {
    const layout = { panels: Object.fromEntries(placed.map((p) => [p.id, p.pose])) };
    const clean = cleanBoardLayout(layout, placed.map((p) => p.id));
    for (const p of placed) expect(clean.panels[p.id]).toEqual(p.pose);
  });

  it('chooses a texture size that is sharp but bounded', () => {
    const t = textureSize(by('a').size);
    expect(t.w).toBeCloseTo(by('a').size.width * PX_PER_M, -1);
    expect(textureSize({ width: 0.05, height: 0.05 })).toEqual({ w: TEX_MIN, h: TEX_MIN });
    const big = textureSize({ width: 9, height: 5 });
    expect(Math.max(big.w, big.h)).toBeLessThanOrEqual(TEX_MAX);
    expect(big.w / big.h).toBeCloseTo(9 / 5, 1);
  });
});

describe('pointing at panels', () => {
  const size = { width: 1, height: 0.5 };
  const front = { x: 0, y: 0, z: -2, yaw: 0, scale: 1 };

  it('finds the point on a panel straight ahead, from the left and from the top', () => {
    const hit = hitPanel({ origin: [0, 0, 0], dir: [0, 0, -1] }, front, size)!;
    expect(hit.t).toBeCloseTo(2, 5);
    expect(hit.u).toBeCloseTo(0.5, 5);
    expect(hit.v).toBeCloseTo(0.5, 5);
    // upper left corner region
    const tl = hitPanel({ origin: [-0.4, 0.2, 0], dir: [0, 0, -1] }, front, size)!;
    expect(tl.u).toBeCloseTo(0.1, 4);
    expect(tl.v).toBeCloseTo(0.1, 4);
    expect(tl.point[2]).toBeCloseTo(-2, 5);
  });

  it('misses beside, behind and parallel to the panel, and sees a rotated and scaled one', () => {
    expect(hitPanel({ origin: [0, 0, 0], dir: [0, 0, -1] }, { ...front, x: 2 }, size)).toBeNull();
    expect(hitPanel({ origin: [0, 0, 0], dir: [0, 0, 1] }, front, size)).toBeNull();
    expect(hitPanel({ origin: [0, 0, 0], dir: [1, 0, 0] }, front, size)).toBeNull();
    expect(hitPanel({ origin: [0, 0, 0], dir: [0, 0.5, -1] }, front, size)).toBeNull();
    // scaled ×2: now 2 × 1 m
    expect(hitPanel({ origin: [0.9, 0, 0], dir: [0, 0, -1] }, { ...front, scale: 2 }, size)).not.toBeNull();
    expect(hitPanel({ origin: [0.9, 0, 0], dir: [0, 0, -1] }, front, size)).toBeNull();
    // a panel to the right, turned to face the viewer, is hit by a ray pointing at its centre
    const right = { x: 1.5, y: 0.2, z: -1.5, yaw: facingYaw([1.5, 0, -1.5]), scale: 1 };
    const dir = vec.norm([1.5, 0.2, -1.5]);
    const h = hitPanel({ origin: [0, 0, 0], dir }, right, size)!;
    expect(h.u).toBeCloseTo(0.5, 3);
    expect(h.v).toBeCloseTo(0.5, 3);
  });

  it('picks the nearest of several, and draws the far ones first', () => {
    const near = { id: 'near', pose: { ...front, z: -1 }, size };
    const far = { id: 'far', pose: front, size };
    expect(pickNearest({ origin: [0, 0, 0], dir: [0, 0, -1] }, [far, near])!.id).toBe('near');
    expect(pickNearest({ origin: [0, 0, 0], dir: [0, 0, 1] }, [far, near])).toBeNull();
    expect(backToFront([near, far], [0, 0, 0]).map((p) => p.id)).toEqual(['far', 'near']);
  });
});

describe('grabbing and moving', () => {
  const size = { width: 1, height: 0.5 };
  const pose = { x: 0, y: 0, z: -2, yaw: 0, scale: 1 };

  it('moves with the hand without jumping, keeps facing the viewer and keeps the distance', () => {
    const ray = { origin: [0, 0, 0] as [number, number, number], dir: [0.2, 0, -1] as [number, number, number] };
    const hit = hitPanel({ origin: [0, 0, 0], dir: [0, 0, -1] }, pose, size)!;
    const g = startGrab({ origin: [0, 0, 0], dir: [0, 0, -1] }, hit, 'p', pose);
    // not moving: the panel stays where it is
    expect(moveGrab(g, { origin: [0, 0, 0], dir: [0, 0, -1] }).pose).toMatchObject({ x: 0, y: 0, z: -2 });
    // turning the hand 0.2 to the right: the panel follows, on the same distance, turned towards the viewer
    const { pose: moved } = moveGrab(g, ray);
    const dir = vec.norm(ray.dir);
    expect(moved.x).toBeCloseTo(dir[0] * 2, 3);
    expect(moved.z).toBeCloseTo(dir[2] * 2, 3);
    expect(moved.yaw).toBeCloseTo(facingYaw([moved.x, moved.y, moved.z]), 3);
    expect(moved.yaw).toBeLessThan(0);
  });

  it('pushes and pulls with the thumbstick within the reach, and scales within its limits', () => {
    const hit = hitPanel({ origin: [0, 0, 0], dir: [0, 0, -1] }, pose, size)!;
    let g = startGrab({ origin: [0, 0, 0], dir: [0, 0, -1] }, hit, 'p', pose);
    const ray = { origin: [0, 0, 0] as [number, number, number], dir: [0, 0, -1] as [number, number, number] };
    let r = moveGrab(g, ray, { dist: 1 });
    expect(r.pose.z).toBeCloseTo(-3, 3);
    g = r.grab;
    r = moveGrab(g, ray, { dist: -99 });
    expect(r.pose.z).toBeCloseTo(-0.6, 3);
    expect(moveGrab(g, ray, { dist: 99 }).pose.z).toBeCloseTo(-8, 3);
    expect(moveGrab(g, ray, { scale: 0.5 }).pose.scale).toBeCloseTo(1.5, 3);
    expect(moveGrab(g, ray, { scale: 99 }).pose.scale).toBe(3);
    expect(moveGrab(g, ray, { scale: -0.99 }).pose.scale).toBe(0.25);
    // growing over several frames accumulates
    let s = startGrab(ray, hit, 'p', pose);
    for (let i = 0; i < 3; i++) s = moveGrab(s, ray, { scale: 0.1 }).grab;
    expect(s.start.scale).toBeCloseTo(1.331, 3);
  });

  it('the moved pose is always something the server accepts', () => {
    const hit = hitPanel({ origin: [0, 0, 0], dir: [0, 0, -1] }, pose, size)!;
    const g = startGrab({ origin: [0, 0, 0], dir: [0, 0, -1] }, hit, 'p', pose);
    const { pose: far } = moveGrab(g, { origin: [100, 100, 100], dir: [1, 0, 0] });
    const clean = cleanBoardLayout({ panels: { p: far } }, ['p']);
    expect(clean.panels.p).toEqual(far);
  });
});

describe('the other panels', () => {
  it('keeps the control panel below the wall and fits a canvas image to its plane', () => {
    expect(HUD_POSE.y).toBeLessThan(0);
    expect(HUD_POSE.z).toBeGreaterThan(-2);
    expect(HUD_SIZE.width / HUD_SIZE.height).toBeGreaterThan(2);
    expect(fitPlane(1600, 800)).toEqual({ width: 3.2, height: 1.6 });
    const tall = fitPlane(800, 1600);
    expect(tall.height).toBe(2.1);
    expect(tall.width).toBeCloseTo(1.05, 3);
    expect(fitPlane(0, 0).width).toBe(3.2);
    expect(modelOf(HUD_POSE)).toHaveLength(16);
  });

  it('draws a floor ring as pairs of points on its circle', () => {
    const l = ringLines(1.5, 16);
    expect(l).toHaveLength(16 * 6);
    for (let i = 0; i < l.length; i += 3) expect(Math.hypot(l[i], l[i + 2])).toBeCloseTo(1.5, 5);
  });
});
