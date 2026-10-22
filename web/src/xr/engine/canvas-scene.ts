import type { CanvasXrLayout, Pose } from '../../../../server/services/xr-model';
import { api, currentLocation } from '../../api';
import { CANVAS_POSE, fitPlane, HUD_POSE } from './geometry';
import type { Scene } from './scene';
import { drawImagePlane, type HudButton, type HudState } from './textures';

/**
 * A Canvas board in XR: one large plane showing the board as an image the server draws (the same renderer as the PNG export, so
 * every shape, sticky, card and connector looks as in the browser), kept current by the board's realtime stream, hung where the
 * person put it (their own spatial layout). View and move only – drawing and editing stay in the browser.
 */

const PLANE = 'canvas-plane';
const clientId = () => `x${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

export interface CanvasXr {
  close(): void;
}

export interface CanvasXrOptions {
  canvasId: string;
  name: string;
  scene: Scene;
  onStatus: (text: string) => void;
  onExit: () => void;
  onError: (text: string) => void;
}

/** Scales to try: the picture is sharp when the board is small, and still arrives when it is huge (the server refuses > 24 Mpx). */
export const EXPORT_SCALES = [1.5, 0.8, 0.4];

export async function fetchCanvasImage(canvasId: string, dark: boolean, fetcher: typeof fetch = fetch): Promise<{ bitmap: ImageBitmap; w: number; h: number }> {
  let last = 'Das Canvas lässt sich nicht als Bild laden.';
  for (const scale of EXPORT_SCALES) {
    const r = await fetcher(`/api/canvas/${canvasId}/export?format=png&scale=${scale}&theme=${dark ? 'dark' : 'light'}`, { credentials: 'same-origin', headers: { 'x-pghl': '1', ...(currentLocation() ? { 'x-location-id': currentLocation() } : {}) } });
    if (r.ok) {
      const bitmap = await createImageBitmap(await r.blob());
      return { bitmap, w: bitmap.width, h: bitmap.height };
    }
    if (r.status !== 400) {
      last = (await r.json().catch(() => ({})))?.error ?? last;
      break;
    }
    last = (await r.json().catch(() => ({})))?.error ?? last;
  }
  throw new Error(last);
}

export async function openCanvasXr(o: CanvasXrOptions): Promise<CanvasXr> {
  const { scene, canvasId } = o;
  const cid = clientId();
  const saved = (await api.get<{ layout: CanvasXrLayout | null }>(`/api/canvas/${canvasId}/xr-layout`).catch(() => ({ layout: null }))).layout;
  let plane: Pose & { curve: number } = saved?.plane ?? { ...CANVAS_POSE, curve: 0.25 };
  let dark = scene.theme.dark;
  let image: { bitmap: ImageBitmap; w: number; h: number } | null = null;
  let message = '';
  let tone: HudState['messageTone'] = 'normal';
  let closed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => (timers.delete(t), !closed && fn()), ms);
    timers.add(t);
    return t;
  };

  const hud = () =>
    scene.setHud({ title: o.name, live: 'Live', mic: 'off', message: message || 'Ziehen verschiebt das Canvas. Daumenstick: näher, ferner, größer, kleiner.', messageTone: tone, buttons: ['refresh', 'theme', 'exit'] }, HUD_POSE);
  const say = (text: string, t: HudState['messageTone'] = 'normal') => {
    message = text;
    tone = t;
    hud();
    o.onStatus(text);
  };

  const build = () => {
    const size = fitPlane(image?.w ?? 0, image?.h ?? 0);
    scene.setPanels([
      {
        id: PLANE,
        size,
        pose: plane,
        bend: plane.curve * 0.5,
        paint: (ctx, W, H) => drawImagePlane(ctx, W, H, image?.bitmap ?? null, image?.w ?? 0, image?.h ?? 0, scene.theme, message && !image ? message : undefined),
      },
    ]);
  };

  const load = async () => {
    try {
      image = await fetchCanvasImage(canvasId, dark);
      build();
      scene.invalidate(PLANE);
      say('Canvas aktuell.', 'good');
    } catch (e) {
      say((e as Error).message, 'error');
    }
  };

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  scene.onMoved = (poses) => {
    const p = poses[PLANE];
    if (!p) return;
    plane = { ...p, curve: plane.curve };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = later(() => api.put(`/api/canvas/${canvasId}/xr-layout`, { layout: { v: 1, plane } }).catch((e: Error) => o.onError(`Anordnung nicht gespeichert: ${e.message}`)), 800);
  };

  // changes by anybody (or the agent) redraw the picture – at most every 2 s
  let es: EventSource | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;
  if (typeof EventSource !== 'undefined') {
    es = new EventSource(`/api/canvas/${canvasId}/stream?clientId=${cid}&locationId=${encodeURIComponent(currentLocation())}`);
    const changed = () => {
      if (pending) return;
      pending = later(() => ((pending = null), void load()), 2000);
    };
    es.addEventListener('ops', changed);
    es.addEventListener('reload', changed);
    // the server ended the stream for good (signed out, no access any more): no reconnect loop
    es.addEventListener('bye', () => es?.close());
  }

  scene.onHud = (b: HudButton, phase) => {
    if (phase !== 'down') return;
    if (b === 'refresh') void load();
    else if (b === 'theme') {
      dark = !dark;
      void load();
    } else if (b === 'exit') o.onExit();
  };

  build();
  hud();
  await load();
  return {
    close() {
      closed = true;
      es?.close();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      scene.onMoved = null;
      scene.onHud = null;
      image?.bitmap.close?.();
    },
  };
}
