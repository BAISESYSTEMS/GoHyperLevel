/**
 * XR layouts as data: where a person put the floating panels of a board in their headset, where the canvas plane
 * hangs, and which pages sit side by side on the Arbeitsfläche. Pure code without Node or browser APIs – the server
 * (modules/xr.ts) validates with it and the web app (web/src/xr/*) reads the same shapes, so they cannot drift apart.
 *
 * Coordinates are metres in the viewer's own frame: the origin is where the head was when the session started, x is
 * to the right, y up, and the panels hang in front of the viewer at negative z (WebGL / WebXR convention).
 */

export const XR_LIMITS = {
  /** Panels of one board layout (a board has at most 40 widgets). */
  panels: 60,
  /** Farthest a panel may hang from the origin, in metres. */
  reach: 20,
  scale: { min: 0.25, max: 3 },
  radius: { min: 0.8, max: 8 },
  /** Pages side by side on the Arbeitsfläche. */
  workspacePanels: 4,
  /** Smallest share of the width one workspace panel keeps. */
  minShare: 0.12,
  /** Layouts one person keeps (the oldest go first). */
  perUser: 200,
} as const;

export interface Pose {
  x: number;
  y: number;
  z: number;
  /** Rotation around the vertical axis in radians (0 = facing the viewer's start direction). */
  yaw: number;
  /** 1 = the size derived from the widget's grid cells. */
  scale: number;
}
export interface BoardXrLayout {
  v: 1;
  /** Radius of the arc the panels hang on, in metres. */
  radius: number;
  /** By widget id; widgets without an entry are placed on the arc. */
  panels: Record<string, Pose>;
  /** The control panel (title, microphone, proposals). */
  hud?: Pose;
}
export interface CanvasXrLayout {
  v: 1;
  plane: Pose & { /** 0 = flat, 1 = strongly curved around the viewer. */ curve: number };
}
export interface WorkspacePanel {
  /** The page shown in the panel, as a route below /app: "conversations", "contacts/<id>", "agent" … */
  route: string;
  /** Relative width (a weight, not a percentage). */
  size: number;
}
export interface WorkspaceLayout {
  v: 1;
  panels: WorkspacePanel[];
  /** A click in one panel (an inbox conversation, a deal) updates the contact panel. */
  sync: boolean;
}

const finite = (v: unknown, label: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error(`${label} muss eine Zahl sein`);
  return n;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Wraps an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  let r = a % t;
  if (r > Math.PI) r -= t;
  else if (r <= -Math.PI) r += t;
  return r;
}

export function cleanPose(raw: unknown, label = 'Position'): Pose {
  const o = obj(raw);
  if (!o) throw new Error(`${label}: Objekt mit x, y, z erwartet`);
  const r = XR_LIMITS.reach;
  return {
    x: round(clamp(finite(o.x, `${label}.x`), -r, r)),
    y: round(clamp(finite(o.y, `${label}.y`), -r, r)),
    z: round(clamp(finite(o.z, `${label}.z`), -r, r)),
    yaw: round(wrapAngle(o.yaw === undefined ? 0 : finite(o.yaw, `${label}.yaw`))),
    scale: round(clamp(o.scale === undefined ? 1 : finite(o.scale, `${label}.scale`), XR_LIMITS.scale.min, XR_LIMITS.scale.max)),
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A board layout; entries for widgets that are not on the board are dropped (the board may have changed since). */
export function cleanBoardLayout(raw: unknown, widgetIds: Iterable<string>): BoardXrLayout {
  const o = obj(raw);
  if (!o) throw new Error('Layout: Objekt erwartet');
  const known = new Set(widgetIds);
  const src = obj(o.panels) ?? {};
  const keys = Object.keys(src);
  if (keys.length > XR_LIMITS.panels * 4) throw new Error('Zu viele Panels im Layout');
  const panels: Record<string, Pose> = {};
  for (const id of keys) {
    if (!ID.test(id) || !known.has(id)) continue;
    panels[id] = cleanPose(src[id], `Panel ${id}`);
    if (Object.keys(panels).length >= XR_LIMITS.panels) break;
  }
  const out: BoardXrLayout = {
    v: 1,
    radius: round(clamp(o.radius === undefined ? 2.2 : finite(o.radius, 'Radius'), XR_LIMITS.radius.min, XR_LIMITS.radius.max), 3),
    panels,
  };
  if (o.hud !== undefined && o.hud !== null) out.hud = cleanPose(o.hud, 'Steuerpult');
  return out;
}

export function cleanCanvasLayout(raw: unknown): CanvasXrLayout {
  const o = obj(raw);
  if (!o) throw new Error('Layout: Objekt erwartet');
  const plane = cleanPose(o.plane, 'Fläche');
  const p = obj(o.plane)!;
  return { v: 1, plane: { ...plane, curve: round(clamp(p.curve === undefined ? 0 : finite(p.curve, 'Krümmung'), 0, 1), 3) } };
}

/** A route below /app: lower-case page, up to three more segments, no query, nothing that could leave the app. */
export const ROUTE_RE = /^[a-z0-9][a-z0-9-]{0,40}(?:\/[A-Za-z0-9._~%-]{1,100}){0,3}$/;
export function isWorkspaceRoute(r: unknown): r is string {
  if (typeof r !== 'string' || r.length > 200 || !ROUTE_RE.test(r)) return false;
  // "." and ".." (also percent-encoded) are valid characters but would walk out of the page; so would an encoded slash.
  return r.split('/').every((seg) => {
    try {
      const d = decodeURIComponent(seg);
      return d !== '.' && d !== '..' && !/[/\\]/.test(d);
    } catch {
      return false;
    }
  });
}

/** Equal weights for n panels. */
export const evenSizes = (n: number): number[] => Array.from({ length: n }, () => round(1 / n, 4));

/**
 * Weights → shares that add up to 1, none below the minimum. Every panel keeps at least `minShare`; the rest is
 * divided in proportion to what was asked for.
 */
export function normalizeSizes(sizes: number[], minShare: number = XR_LIMITS.minShare): number[] {
  const n = sizes.length;
  if (!n) return [];
  const floor = Math.min(minShare, 1 / n);
  const pos = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const total = pos.reduce((a, b) => a + b, 0);
  if (total <= 0) return evenSizes(n);
  let shares = pos.map((s) => s / total);
  // Raise the small ones to the floor and take it from the large ones, a few passes settle it.
  for (let pass = 0; pass < 6; pass++) {
    const low = shares.filter((s) => s < floor - 1e-9).length;
    if (!low) break;
    const free = shares.filter((s) => s >= floor - 1e-9).reduce((a, b) => a + b, 0);
    const need = 1 - floor * low;
    shares = shares.map((s) => (s < floor - 1e-9 ? floor : free > 0 ? (s / free) * need : floor));
  }
  const sum = shares.reduce((a, b) => a + b, 0);
  return shares.map((s) => round(s / sum, 4));
}

export function cleanWorkspace(raw: unknown): WorkspaceLayout {
  const o = obj(raw);
  if (!o) throw new Error('Layout: Objekt erwartet');
  if (!Array.isArray(o.panels) || !o.panels.length) throw new Error('Mindestens ein Panel angeben');
  if (o.panels.length > XR_LIMITS.workspacePanels) throw new Error(`Höchstens ${XR_LIMITS.workspacePanels} Panels nebeneinander`);
  const panels = o.panels.map((p, i) => {
    const e = obj(p);
    if (!e || !isWorkspaceRoute(e.route)) throw new Error(`Panel ${i + 1}: ungültige Seite`);
    return { route: e.route, size: e.size === undefined ? 1 : finite(e.size, `Panel ${i + 1}.size`) };
  });
  const shares = normalizeSizes(panels.map((p) => p.size));
  return { v: 1, panels: panels.map((p, i) => ({ route: p.route, size: shares[i] })), sync: o.sync === undefined ? true : o.sync === true };
}

/** The layout a new person starts with: Inbox | Kontakt | Board | Agent (as many as fit). */
export const DEFAULT_WORKSPACE_ROUTES = ['conversations', 'contacts', 'boards', 'agent'] as const;
export function defaultWorkspace(count: number = XR_LIMITS.workspacePanels): WorkspaceLayout {
  const n = clamp(Math.round(count), 1, XR_LIMITS.workspacePanels);
  const sizes = evenSizes(n);
  return { v: 1, panels: DEFAULT_WORKSPACE_ROUTES.slice(0, n).map((route, i) => ({ route, size: sizes[i] })), sync: true };
}
