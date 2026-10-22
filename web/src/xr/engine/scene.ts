import type { Pose } from '../../../../server/services/xr-model';
import { CANVAS_POSE, HUD_POSE, HUD_SIZE, backToFront, facingYaw, modelOf, moveGrab, pickNearest, ringLines, startGrab, textureSize, type Grab, type Hit, type Placed, type Ray, type Size } from './geometry';
import { trs, vec, type Vec3 } from './math';
import { Renderer, type DrawItem, type LineItem, type Tex, type View } from './renderer';
import { drawHud, hudButtonAt, type HudButton, type HudRegion, type HudState, type XrTheme } from './textures';

/**
 * The scene of floating panels: what hangs where, what the pointers are doing to it. It knows nothing about boards or canvases –
 * the content (board-scene.ts, canvas-scene.ts) hands it panels with a painter each. The same scene is driven by the mouse in the
 * browser preview and by controllers or hands (select events) in an immersive session; both only call `pointer`, `press`,
 * `release` and `update`.
 *
 * Panels: any panel can be grabbed anywhere (the control panel everywhere except its buttons) and follows the pointer on the same
 * distance, always turned towards the viewer; the thumbstick (or the wheel) pushes and pulls it and changes its size. Letting go
 * reports the new poses so they can be saved to the person's own spatial layout.
 */

type Ctx = CanvasRenderingContext2D;

export interface PanelInput {
  id: string;
  size: Size;
  /** Used when the panel is new; an existing panel keeps the place the person gave it. */
  pose: Pose;
  paint: (ctx: Ctx, W: number, H: number) => void;
  /** Curvature (1 / radius) of the panel itself. */
  bend?: number;
  /** Texture pixels per metre; the scene scales it down when the textures would use too much memory. */
  density?: number;
}

interface LivePanel {
  id: string;
  kind: 'panel' | 'hud';
  pose: Pose;
  size: Size;
  paint: PanelInput['paint'];
  bend: number;
  canvas: HTMLCanvasElement;
  ctx: Ctx;
  tex: Tex;
  W: number;
  H: number;
  dirty: boolean;
  glow: number;
  grabbed: boolean;
  density: number;
}

interface PointerState {
  ray: Ray | null;
  /** A controller draws its ray; the mouse does not. */
  showRay: boolean;
  hover: { id: string; hit: Hit } | null;
  grab: Grab | null;
  hudButton: HudButton | null;
}

export const HUD_ID = '__hud';
/** All textures together stay below this many pixels (about 64 MB with mipmaps). */
export const TEXTURE_BUDGET = 12_000_000;
const UPLOADS_PER_FRAME = 4;

export class Scene {
  private panels = new Map<string, LivePanel>();
  private pointers = new Map<string, PointerState>();
  private moved = new Set<string>();
  private hud: { state: HudState; regions: HudRegion[]; panel: LivePanel } | null = null;
  private dot: Tex | null = null;
  floorY = -1.6;
  clear: [number, number, number, number] = [0.04, 0.06, 0.12, 1];
  /** Called when a grab ends: the poses of every panel (to be saved). */
  onMoved: ((poses: Record<string, Pose>) => void) | null = null;
  /** Called for the control panel's buttons: pressed ("down") and let go ("up"). */
  onHud: ((button: HudButton, phase: 'down' | 'up') => void) | null = null;

  constructor(
    private r: Renderer,
    public theme: XrTheme,
    private makeCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
  ) {}

  // --- content -----------------------------------------------------------------------------------------------------

  /** The panels of the content. Panels that were there keep their (possibly moved) pose; the ones that are gone are freed. */
  setPanels(inputs: PanelInput[]) {
    const keep = new Set(inputs.map((i) => i.id));
    for (const [id, p] of this.panels) if (p.kind === 'panel' && !keep.has(id)) this.free(p, id);
    const total = inputs.reduce((n, i) => {
      const t = textureSize(i.size);
      return n + t.w * t.h;
    }, 0);
    const k = Math.min(1, Math.sqrt(TEXTURE_BUDGET / Math.max(1, total)));
    for (const i of inputs) {
      const sz = textureSize(i.size);
      const W = Math.max(64, Math.round(sz.w * k));
      const H = Math.max(64, Math.round(sz.h * k));
      let p = this.panels.get(i.id);
      if (!p) {
        const canvas = this.makeCanvas();
        canvas.width = W;
        canvas.height = H;
        p = { id: i.id, kind: 'panel', pose: i.pose, size: i.size, paint: i.paint, bend: i.bend ?? 0, canvas, ctx: canvas.getContext('2d')!, tex: this.r.createTexture(), W, H, dirty: true, glow: 0, grabbed: false, density: i.density ?? 1 };
        this.panels.set(i.id, p);
      } else {
        p.size = i.size;
        p.paint = i.paint;
        p.bend = i.bend ?? 0;
        if (p.W !== W || p.H !== H) {
          p.canvas.width = W;
          p.canvas.height = H;
          p.W = W;
          p.H = H;
        }
        p.dirty = true;
      }
    }
  }

  /** Redraw one panel's picture at the next frame (its data changed). */
  invalidate(id?: string) {
    if (id) {
      const p = this.panels.get(id);
      if (p) p.dirty = true;
    } else for (const p of this.panels.values()) p.dirty = true;
  }

  setHud(state: HudState, pose: Pose = HUD_POSE) {
    if (!this.hud) {
      const canvas = this.makeCanvas();
      const W = 960;
      const H = Math.round((W * HUD_SIZE.height) / HUD_SIZE.width);
      canvas.width = W;
      canvas.height = H;
      const panel: LivePanel = { id: HUD_ID, kind: 'hud', pose, size: HUD_SIZE, paint: () => undefined, bend: 0, canvas, ctx: canvas.getContext('2d')!, tex: this.r.createTexture(), W, H, dirty: true, glow: 0, grabbed: false, density: 1 };
      this.panels.set(HUD_ID, panel);
      this.hud = { state, regions: [], panel };
    }
    this.hud.state = state;
    this.hud.panel.dirty = true;
  }

  /** Puts panels at given poses (a saved layout, or "Anordnung zurücksetzen"). */
  setPoses(poses: Record<string, Pose>) {
    for (const [id, pose] of Object.entries(poses)) {
      const p = this.panels.get(id);
      if (p) p.pose = pose;
    }
  }

  poses(): Record<string, Pose> {
    return Object.fromEntries([...this.panels].map(([id, p]) => [id, p.pose]));
  }
  /** The panels the person has moved themselves (only those are saved: the others stay on the arc, wherever the board puts them). */
  movedIds = () => [...this.moved].filter((id) => this.panels.has(id));
  forgetMoves = () => this.moved.clear();
  hasPanel = (id: string) => this.panels.has(id);
  panelCount = () => [...this.panels.values()].filter((p) => p.kind === 'panel').length;
  /** The panels as placed (size and pose) – for hit tests and for the tests. */
  placed(): Placed[] {
    return [...this.panels.values()].map((p) => ({ id: p.id, pose: p.pose, size: p.size }));
  }

  // --- pointers ----------------------------------------------------------------------------------------------------

  /** A pointer (a controller, a hand, the mouse) now points along `ray` (null = lost). */
  pointer(id: string, ray: Ray | null, showRay = false) {
    const s = this.pointers.get(id) ?? { ray: null, showRay, hover: null, grab: null, hudButton: null };
    s.ray = ray;
    s.showRay = showRay;
    s.hover = ray ? pickNearest(ray, this.placed()) : null;
    this.pointers.set(id, s);
    this.refreshHudHover();
    return s.hover?.id ?? null;
  }

  private hoverButton(): HudButton | null {
    if (!this.hud) return null;
    for (const s of this.pointers.values()) {
      if (s.hover?.id !== HUD_ID) continue;
      const b = hudButtonAt(this.hud.regions, s.hover.hit.u, s.hover.hit.v, this.hud.panel.W, this.hud.panel.H);
      if (b) return b;
    }
    return null;
  }
  private refreshHudHover() {
    if (!this.hud) return;
    const b = this.hoverButton();
    if ((this.hud.state.hover ?? null) !== b) {
      this.hud.state = { ...this.hud.state, hover: b };
      this.hud.panel.dirty = true;
    }
  }

  /** The select button / pinch went down on whatever the pointer points at. Returns what it did. */
  press(id: string): 'hud' | 'grab' | 'none' {
    const s = this.pointers.get(id);
    if (!s?.ray || !s.hover) return 'none';
    const p = this.panels.get(s.hover.id)!;
    if (p.kind === 'hud' && this.hud) {
      const b = hudButtonAt(this.hud.regions, s.hover.hit.u, s.hover.hit.v, p.W, p.H);
      if (b) {
        s.hudButton = b;
        this.onHud?.(b, 'down');
        return 'hud';
      }
    }
    s.grab = startGrab(s.ray, s.hover.hit, p.id, p.pose);
    p.grabbed = true;
    return 'grab';
  }

  release(id: string) {
    const s = this.pointers.get(id);
    if (!s) return;
    if (s.hudButton) {
      this.onHud?.(s.hudButton, 'up');
      s.hudButton = null;
    }
    if (s.grab) {
      const p = this.panels.get(s.grab.id);
      if (p) p.grabbed = false;
      this.moved.add(s.grab.id);
      s.grab = null;
      this.onMoved?.(this.poses());
    }
  }

  isGrabbing = () => [...this.pointers.values()].some((s) => s.grab);

  /** Moves grabbed panels with their pointers; `axes` are the thumbstick values (x: size, y: push/pull) per pointer. */
  update(dt: number, axes: Record<string, { x: number; y: number }> = {}) {
    for (const [id, s] of this.pointers) {
      if (!s.grab || !s.ray) continue;
      const a = axes[id] ?? { x: 0, y: 0 };
      const r = moveGrab(s.grab, s.ray, { dist: -a.y * dt * 1.4, scale: a.x * dt * 0.7 });
      s.grab = r.grab;
      const p = this.panels.get(s.grab.id);
      if (p) p.pose = r.pose;
    }
    for (const p of this.panels.values()) {
      const target = p.grabbed ? 1 : [...this.pointers.values()].some((s) => s.hover?.id === p.id) ? 0.6 : 0;
      p.glow += (target - p.glow) * Math.min(1, dt * 12);
    }
  }

  /** The wheel (preview) pushes or pulls the grabbed panel, Shift makes it bigger or smaller. */
  nudgeGrab(id: string, dist: number, scale = 0) {
    const s = this.pointers.get(id);
    if (!s?.grab || !s.ray) return false;
    const r = moveGrab(s.grab, s.ray, { dist, scale });
    s.grab = r.grab;
    const p = this.panels.get(s.grab.id);
    if (p) p.pose = r.pose;
    return true;
  }

  hoverOf = (id: string) => this.pointers.get(id)?.hover ?? null;

  // --- drawing -----------------------------------------------------------------------------------------------------

  private repaint(p: LivePanel) {
    if (p.kind === 'hud' && this.hud) this.hud.regions = drawHud(p.ctx, p.W, p.H, this.hud.state, this.theme);
    else p.paint(p.ctx, p.W, p.H);
    this.r.upload(p.tex, p.canvas, p.W, p.H);
    p.dirty = false;
  }

  private dotTex(): Tex {
    if (this.dot) return this.dot;
    const c = this.makeCanvas();
    c.width = c.height = 64;
    const x = c.getContext('2d')!;
    x.beginPath();
    x.arc(32, 32, 26, 0, Math.PI * 2);
    x.fillStyle = 'rgba(255,255,255,0.95)';
    x.fill();
    x.beginPath();
    x.arc(32, 32, 16, 0, Math.PI * 2);
    x.fillStyle = '#2563eb';
    x.fill();
    this.dot = this.r.createTexture();
    this.r.upload(this.dot, c, 64, 64);
    return this.dot;
  }

  /** Draws every view. `eye` is where the viewer's head is (panels are drawn back to front from there). */
  draw(views: View[], eye: Vec3 = [0, 0, 0], opts: { framebuffer?: WebGLFramebuffer | null; ring?: boolean } = {}) {
    let uploads = 0;
    for (const p of this.panels.values()) if (p.dirty && uploads++ < UPLOADS_PER_FRAME) this.repaint(p);
    const items: DrawItem[] = backToFront([...this.panels.values()], eye).map((p) => ({
      model: modelOf(p.pose),
      size: [p.size.width, p.size.height],
      tex: p.tex,
      glow: p.glow * 0.7,
      bend: p.bend,
      radius: p.kind === 'hud' ? 0.05 : 0.04 * (p.size.width > 1 ? 1 : 0.7),
    }));
    const lines: LineItem[] = [];
    if (opts.ring) lines.push({ points: ringLines(1.25, 72, this.floorY), color: [0.55, 0.62, 0.8, 0.5] });
    for (const s of this.pointers.values()) {
      if (!s.ray) continue;
      const end = s.hover ? s.hover.hit.point : vec.add(s.ray.origin, vec.scale(s.ray.dir, 3));
      if (s.showRay) lines.push({ points: [...vec.add(s.ray.origin, vec.scale(s.ray.dir, 0.04)), ...end], color: s.grab ? [0.15, 0.45, 1, 1] : [0.85, 0.9, 1, 0.85] });
      if (s.hover) {
        const p = this.panels.get(s.hover.id)!;
        const normal: Vec3 = [Math.sin(p.pose.yaw), 0, Math.cos(p.pose.yaw)];
        const at = vec.add(s.hover.hit.point, vec.scale(normal, 0.008));
        items.push({ model: trs(at, p.pose.yaw, 1), size: [0.03, 0.03], tex: this.dotTex(), radius: 0.015, alpha: s.grab ? 1 : 0.9 });
      }
    }
    this.r.frame(views, items, lines, { clear: this.clear, framebuffer: opts.framebuffer });
  }

  dispose() {
    for (const [id, p] of [...this.panels]) this.free(p, id);
    if (this.dot) this.r.deleteTexture(this.dot);
    this.dot = null;
    this.hud = null;
    this.pointers.clear();
  }

  private free(p: LivePanel, id: string) {
    this.r.deleteTexture(p.tex);
    this.panels.delete(id);
    if (p.kind === 'hud') this.hud = null;
    for (const s of this.pointers.values()) if (s.grab?.id === id) s.grab = null;
  }
}

export { CANVAS_POSE, HUD_POSE, facingYaw };
