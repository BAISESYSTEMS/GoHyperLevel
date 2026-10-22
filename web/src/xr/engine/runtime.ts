import { Renderer, type View } from './renderer';
import { Scene } from './scene';
import { invert, lookAt, multiply, perspective, rotationY, screenRay, transformDir, transformPoint, translation, vec, type Mat4, type Vec3 } from './math';
import type { XrTheme } from './textures';

/**
 * Puts the scene on a canvas: the browser preview (a camera you orbit with the mouse – also what runs where there is no WebXR) and
 * the immersive WebXR session (`immersive-vr` or `immersive-ar`, one view per eye, controllers and hands as pointers).
 *
 * The preview and the session share one WebGL context, created `xrCompatible`, so "In XR starten" does not rebuild anything: the
 * scene stays, only the camera and the pointers change. When the session ends the preview continues.
 */

export type XrMode = 'immersive-vr' | 'immersive-ar';

export class Orbit {
  yaw = 0;
  pitch = 0.06;
  dist = 3.9;
  /** The middle of the wall: the default camera stands just behind the viewer's shoulder, looking at it. */
  target: Vec3 = [0, -0.2, -2.2];
  eye(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [this.target[0] + this.dist * Math.sin(this.yaw) * cp, this.target[1] + this.dist * Math.sin(this.pitch), this.target[2] + this.dist * Math.cos(this.yaw) * cp];
  }
  view(): Mat4 {
    return lookAt(this.eye(), this.target);
  }
  drag(dx: number, dy: number) {
    this.yaw -= dx * 0.005;
    this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch + dy * 0.005));
  }
  zoom(delta: number) {
    this.dist = Math.max(1.2, Math.min(14, this.dist * (1 + delta)));
  }
  reset() {
    this.yaw = 0;
    this.pitch = 0.06;
    this.dist = 3.9;
  }
}

export interface RuntimeOptions {
  canvas: HTMLCanvasElement;
  theme: XrTheme;
  onSessionEnd?: () => void;
}

type XrNav = { xr?: { requestSession(mode: string, init?: unknown): Promise<any> } };

export class Runtime {
  readonly gl: WebGL2RenderingContext;
  readonly renderer: Renderer;
  readonly scene: Scene;
  readonly orbit = new Orbit();
  private raf = 0;
  private last = 0;
  private session: any = null;
  private stopped = false;
  private cleanups: (() => void)[] = [];
  /** The pointer of the mouse is this id. */
  static MOUSE = 'mouse';

  constructor(private o: RuntimeOptions) {
    const gl = o.canvas.getContext('webgl2', { xrCompatible: true, alpha: true, antialias: true, powerPreference: 'high-performance' } as WebGLContextAttributes);
    if (!gl) throw new Error('WebGL2 ist in diesem Browser nicht verfügbar.');
    this.gl = gl as WebGL2RenderingContext;
    this.renderer = new Renderer(this.gl);
    this.scene = new Scene(this.renderer, o.theme);
    const lost = (e: Event) => {
      e.preventDefault();
      this.stopped = true;
    };
    o.canvas.addEventListener('webglcontextlost', lost);
    this.cleanups.push(() => o.canvas.removeEventListener('webglcontextlost', lost));
    this.bindMouse();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  get immersive() {
    return !!this.session;
  }

  // --- the preview: mouse and keyboard -----------------------------------------------------------------------------------
  private size(): { w: number; h: number } {
    const c = this.o.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return { w, h };
  }
  private proj(): Mat4 {
    const { w, h } = this.size();
    return perspective((62 * Math.PI) / 180, w / h, 0.05, 60);
  }
  private mouseRay(e: { clientX: number; clientY: number }) {
    const r = this.o.canvas.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
    return screenRay(this.proj(), this.orbit.view(), nx, ny);
  }
  private bindMouse() {
    const c = this.o.canvas;
    let orbiting = false;
    let lx = 0;
    let ly = 0;
    const down = (e: PointerEvent) => {
      if (this.session || e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      const ray = this.mouseRay(e);
      this.scene.pointer(Runtime.MOUSE, ray);
      if (this.scene.press(Runtime.MOUSE) === 'none') {
        orbiting = true;
        lx = e.clientX;
        ly = e.clientY;
        c.style.cursor = 'grabbing';
      }
    };
    const move = (e: PointerEvent) => {
      if (this.session) return;
      if (orbiting) {
        this.orbit.drag(e.clientX - lx, e.clientY - ly);
        lx = e.clientX;
        ly = e.clientY;
      }
      this.scene.pointer(Runtime.MOUSE, this.mouseRay(e));
      c.style.cursor = this.scene.isGrabbing() ? 'grabbing' : this.scene.hoverOf(Runtime.MOUSE) ? 'grab' : 'default';
    };
    const up = () => {
      orbiting = false;
      this.scene.release(Runtime.MOUSE);
      c.style.cursor = 'default';
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const d = Math.sign(e.deltaY) * Math.min(1, Math.abs(e.deltaY) / 100);
      if (!this.scene.nudgeGrab(Runtime.MOUSE, d * 0.35, e.shiftKey ? -d * 0.12 : 0)) this.orbit.zoom(d * 0.12);
    };
    const key = (e: KeyboardEvent) => {
      if (this.session) return;
      const k = e.key;
      if (k === 'ArrowLeft') this.orbit.yaw += 0.08;
      else if (k === 'ArrowRight') this.orbit.yaw -= 0.08;
      else if (k === 'ArrowUp') this.orbit.pitch = Math.min(1.2, this.orbit.pitch + 0.06);
      else if (k === 'ArrowDown') this.orbit.pitch = Math.max(-1.2, this.orbit.pitch - 0.06);
      else if (k === '+' || k === '=') this.orbit.zoom(-0.1);
      else if (k === '-') this.orbit.zoom(0.1);
      else if (k === 'Home') this.orbit.reset();
      else return;
      e.preventDefault();
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', wheel, { passive: false });
    c.addEventListener('keydown', key);
    this.cleanups.push(() => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
      c.removeEventListener('wheel', wheel);
      c.removeEventListener('keydown', key);
    });
  }

  private loop(t: number) {
    if (this.stopped) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.session) return;
    const dt = Math.min(0.1, (t - (this.last || t)) / 1000);
    this.last = t;
    const { w, h } = this.size();
    this.scene.update(dt);
    this.scene.draw([{ viewport: [0, 0, w, h], view: this.orbit.view(), proj: this.proj() }], this.orbit.eye());
  }

  // --- the immersive session ----------------------------------------------------------------------------------------------
  async start(mode: XrMode): Promise<void> {
    const xr = (navigator as unknown as XrNav).xr;
    if (!xr) throw new Error('Dieses Gerät bietet kein WebXR.');
    const gl = this.gl as WebGL2RenderingContext & { makeXRCompatible?: () => Promise<void> };
    await gl.makeXRCompatible?.();
    const session = await xr.requestSession(mode, { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
    this.session = session;
    this.scene.clear = mode === 'immersive-ar' ? [0, 0, 0, 0] : [0.04, 0.06, 0.12, 1];
    const Layer = (globalThis as any).XRWebGLLayer;
    await session.updateRenderState({ baseLayer: new Layer(session, gl, { antialias: true, alpha: true }) });
    let space: any;
    let floor = true;
    try {
      space = await session.requestReferenceSpace('local-floor');
    } catch {
      floor = false;
      space = await session.requestReferenceSpace('local');
    }
    // the home frame: where the head was and which way it looked when the session began – panels hang relative to that
    let home: { m: Mat4; inv: Mat4 } | null = null;
    const ids = new Map<any, string>();
    const idOf = (src: any) => {
      let id = ids.get(src);
      if (!id) ids.set(src, (id = `xr-${src.handedness || 'none'}-${ids.size}`));
      return id;
    };
    const rayOf = (frame: any, src: any) => {
      const tp = frame.getPose(src.targetRaySpace, space);
      if (!home || !tp) return null;
      const m = tp.transform.matrix;
      return { origin: transformPoint(home.inv, [m[12], m[13], m[14]]), dir: vec.norm(transformDir(home.inv, [-m[8], -m[9], -m[10]])) };
    };
    const onStart = (e: any) => {
      const r = rayOf(e.frame, e.inputSource);
      const id = idOf(e.inputSource);
      if (r) this.scene.pointer(id, r, e.inputSource.targetRayMode === 'tracked-pointer');
      this.scene.press(id);
    };
    const onEnd = (e: any) => this.scene.release(idOf(e.inputSource));
    const onSources = (e: any) => {
      for (const s of e.removed ?? []) {
        this.scene.release(idOf(s));
        this.scene.pointer(idOf(s), null);
      }
    };
    session.addEventListener('selectstart', onStart);
    session.addEventListener('selectend', onEnd);
    session.addEventListener('inputsourceschange', onSources);
    let prev = 0;
    const frame = (time: number, f: any) => {
      if (this.session !== session) return;
      session.requestAnimationFrame(frame);
      const pose = f.getViewerPose(space);
      if (!pose) return;
      if (!home) {
        const m = pose.transform.matrix;
        const fwd = transformDir(m, [0, 0, -1]);
        const yaw = Math.atan2(-fwd[0], -fwd[2]);
        const H = multiply(translation(m[12], m[13], m[14]), rotationY(yaw));
        home = { m: H, inv: invert(H)! };
        this.scene.floorY = floor ? -m[13] : -1.6;
      }
      const dt = Math.min(0.1, (time - (prev || time)) / 1000);
      prev = time;
      const axes: Record<string, { x: number; y: number }> = {};
      for (const src of session.inputSources) {
        const id = idOf(src);
        const r = rayOf(f, src);
        this.scene.pointer(id, r, src.targetRayMode === 'tracked-pointer');
        const a = src.gamepad?.axes;
        if (a) axes[id] = { x: a[2] ?? a[0] ?? 0, y: a[3] ?? a[1] ?? 0 };
      }
      this.scene.update(dt, axes);
      const layer = session.renderState.baseLayer;
      const views: View[] = pose.views.map((v: any) => {
        const vp = layer.getViewport(v);
        return { viewport: [vp.x, vp.y, vp.width, vp.height], view: multiply(v.transform.inverse.matrix, home!.m), proj: v.projectionMatrix };
      });
      const eye = transformPoint(home.inv, [pose.transform.position.x, pose.transform.position.y, pose.transform.position.z]);
      this.scene.draw(views, eye, { framebuffer: layer.framebuffer, ring: mode === 'immersive-vr' });
    };
    session.addEventListener('end', () => {
      session.removeEventListener('selectstart', onStart);
      session.removeEventListener('selectend', onEnd);
      session.removeEventListener('inputsourceschange', onSources);
      for (const id of ids.values()) this.scene.pointer(id, null);
      if (this.session === session) this.session = null;
      this.last = 0;
      this.o.onSessionEnd?.();
    });
    session.requestAnimationFrame(frame);
  }

  async end() {
    const s = this.session;
    if (s) await s.end().catch(() => undefined);
  }

  dispose() {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    void this.end();
    for (const f of this.cleanups) f();
    this.scene.dispose();
    this.renderer.dispose();
  }
}
