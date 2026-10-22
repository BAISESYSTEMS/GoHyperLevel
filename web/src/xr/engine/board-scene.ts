import type { BoardXrLayout, Pose } from '../../../../server/services/xr-model';
import { api, currentLocation } from '../../api';
import type { BoardFull, ComposeResult, Proposal, WidgetData, WidgetType } from '../../boards/types';
import { HUD_POSE, arrangeOnArc, cellSize, withSavedPoses, DEFAULT_RADIUS } from './geometry';
import type { Scene } from './scene';
import { drawPanel, type HudButton, type HudState } from './textures';
import { PushToTalk, micAvailable, type MicState } from './voice';

/**
 * A Living Board in XR: its widgets as floating panels on a curved wall, kept current by the board's own realtime stream, with the
 * person's own spatial layout (where they hung each panel) saved back, and the control panel with push-to-talk to the board prompt.
 * Everything the browser board does with the viewer's rights happens here too: the data comes from `/api/boards/:id/data` (every
 * widget reads with the viewer's own rights), changes go through the same compose and proposal routes.
 *
 * Simplified on purpose: panels show the widget's *view* drawn by textures.ts, not its DOM (docs/xr.md, "Limits").
 */

const clientId = () => `x${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

export interface BoardXr {
  /** Stops the stream and the timers. */
  close(): void;
  /** Hand the control panel's microphone to the person who holds a controller (immersive or preview). */
  mic: PushToTalk;
  /** For the 2D page around the preview: what is going on in words. */
  status(): string;
}

export interface BoardXrOptions {
  boardId: string;
  scene: Scene;
  onStatus: (text: string) => void;
  onExit: () => void;
  onError: (text: string) => void;
}

export async function openBoardXr(o: BoardXrOptions): Promise<BoardXr> {
  const { scene, boardId } = o;
  const cid = clientId();
  const [board, cat, layoutRes, dataRes, micOk] = await Promise.all([
    api.get<BoardFull>(`/api/boards/${boardId}`),
    api.get<{ widgets: WidgetType[] }>('/api/boards/widgets').catch(() => ({ widgets: [] as WidgetType[] })),
    api.get<{ layout: BoardXrLayout | null }>(`/api/boards/${boardId}/xr-layout`).catch(() => ({ layout: null })),
    api.get<{ data: Record<string, WidgetData> }>(`/api/boards/${boardId}/data`).catch(() => ({ data: {} as Record<string, WidgetData> })),
    micAvailable(),
  ]);
  let spec = board.spec;
  let name = board.name;
  let data: Record<string, WidgetData> = dataRes.data;
  let layout: BoardXrLayout | null = layoutRes.layout;
  const labels = new Map(cat.widgets.map((t) => [t.type, t.label]));
  const canEdit = board.access !== 'view';
  let live = '';
  let message = '';
  let tone: HudState['messageTone'] = 'normal';
  let proposal: Proposal | null = null;
  let mic: MicState = micOk && canEdit ? 'idle' : 'off';
  let closed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => (timers.delete(t), !closed && fn()), ms);
    timers.add(t);
    return t;
  };

  const titleOf = (w: { id: string; title: string; type: string }) => w.title || data[w.id]?.view?.title || labels.get(w.type) || 'Widget';

  // --- panels ---------------------------------------------------------------------------------------------------
  const arc = () => arrangeOnArc(spec.widgets.map((w) => ({ id: w.id, ...w.layout.lg })), { radius: layout?.radius ?? DEFAULT_RADIUS });
  const build = (firstTime = false) => {
    const placed = withSavedPoses(arc(), layout?.panels);
    scene.setPanels(
      spec.widgets.map((w) => {
        const p = placed.find((x) => x.id === w.id)!;
        return {
          id: w.id,
          size: cellSize(w.layout.lg),
          pose: p.pose,
          paint: (ctx, W, H) => drawPanel(ctx, W, H, { title: titleOf(w), view: data[w.id]?.view, loading: !data[w.id], theme: scene.theme }),
        };
      }),
    );
    if (firstTime) scene.setPoses(Object.fromEntries(placed.map((p) => [p.id, p.pose])));
  };
  const hud = () =>
    scene.setHud(
      {
        title: name,
        live: live || (canEdit ? 'Live' : 'Live · nur Ansicht'),
        mic,
        message,
        messageTone: tone,
        proposal: proposal ? { summary: proposal.summary || proposal.message || 'Änderung', risk: proposal.risk } : null,
        buttons: ['mic', 'reset', 'exit'],
        readOnly: !canEdit,
      },
      layout?.hud ?? HUD_POSE,
    );
  const say = (text: string, t: HudState['messageTone'] = 'normal') => {
    message = text;
    tone = t;
    hud();
    o.onStatus(text);
  };

  // --- keeping the layout (per person) ---------------------------------------------------------------------------
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = later(() => {
      const poses = scene.poses();
      const hudPose = scene.movedIds().includes('__hud') ? poses.__hud : layout?.hud;
      // what the person moved (now or before) is kept; the rest stays on the arc
      const panels: Record<string, Pose> = {};
      for (const w of spec.widgets) if (poses[w.id] && (scene.movedIds().includes(w.id) || layout?.panels[w.id])) panels[w.id] = poses[w.id];
      layout = { v: 1, radius: layout?.radius ?? DEFAULT_RADIUS, panels, ...(hudPose ? { hud: hudPose } : {}) };
      api.put(`/api/boards/${boardId}/xr-layout`, { layout }).catch((e: Error) => o.onError(`Anordnung nicht gespeichert: ${e.message}`));
    }, 800);
  };
  scene.onMoved = save;

  // --- data and realtime ---------------------------------------------------------------------------------------------
  const refreshData = async (ids?: string[]) => {
    try {
      const r = await api.get<{ data: Record<string, WidgetData> }>(`/api/boards/${boardId}/data${ids?.length ? `?ids=${ids.join(',')}` : ''}`);
      data = ids?.length ? { ...data, ...r.data } : r.data;
      scene.invalidate();
    } catch {
      /* the numbers on the panels stay as they are */
    }
  };
  let es: EventSource | null = null;
  if (typeof EventSource !== 'undefined') {
    es = new EventSource(`/api/boards/${boardId}/stream?clientId=${cid}&locationId=${encodeURIComponent(currentLocation())}`);
    es.addEventListener('board', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { client_id: string; state: { name: string; spec: BoardFull['spec'] }; summary: string; actor: string; via: string };
      const before = new Map(spec.widgets.map((w) => [w.id, JSON.stringify([w.type, w.config])]));
      spec = d.state.spec;
      name = d.state.name;
      build();
      const changed = spec.widgets.filter((w) => before.get(w.id) !== JSON.stringify([w.type, w.config])).map((w) => w.id);
      void refreshData(changed.length && changed.length < spec.widgets.length ? changed : undefined);
      if (d.client_id !== cid) live = `${d.actor}${d.via === 'agent' ? ' (KI)' : ''}: ${d.summary}`.slice(0, 80);
      hud();
      later(() => ((live = ''), hud()), 8000);
    });
    es.addEventListener('deleted', () => say('Dieses Board wurde gelöscht.', 'error'));
    // the server ended the stream for good (signed out, no access any more): no reconnect loop
    es.addEventListener('bye', () => es?.close());
  }
  const poll = setInterval(() => void refreshData(), 60_000);

  // --- the wish: voice → compose → proposal ---------------------------------------------------------------------------
  const compose = async (prompt: string) => {
    say(`„${prompt}“ – ich überlege …`);
    mic = 'working';
    hud();
    try {
      const r = await api.post<ComposeResult>(`/api/boards/${boardId}/compose`, { prompt, voice: true, client_id: cid });
      if (r.applied) say(r.proposal?.summary || r.message || 'Übernommen', 'good');
      else if (r.proposal) {
        proposal = r.proposal;
        say(r.message || r.proposal.summary || 'Vorschlag bereit', 'normal');
      } else say(r.message || 'Dafür gibt es noch kein passendes Widget.', 'normal');
    } catch (e) {
      say((e as Error).message, 'error');
    } finally {
      mic = micOk && canEdit ? 'idle' : 'off';
      hud();
    }
  };
  const ptt = new PushToTalk(
    (s) => {
      mic = s;
      hud();
    },
    compose,
    (m) => say(m, 'error'),
  );

  const decide = async (apply: boolean) => {
    const p = proposal;
    if (!p) return;
    proposal = null;
    say(apply ? 'Ich übernehme …' : 'Verworfen.');
    try {
      if (apply) {
        const r = await api.post<{ summary: string }>(`/api/boards/${boardId}/proposals/${p.id}/apply`, { client_id: cid });
        say(r.summary || 'Übernommen', 'good');
      } else await api.post(`/api/boards/${boardId}/proposals/${p.id}/reject`, { client_id: cid });
    } catch (e) {
      say((e as Error).message, 'error');
    }
  };

  const resetArrangement = () => {
    layout = null;
    scene.forgetMoves();
    const placed = arc();
    scene.setPoses(Object.fromEntries(placed.map((p) => [p.id, p.pose])));
    scene.setPoses({ __hud: HUD_POSE });
    api.del(`/api/boards/${boardId}/xr-layout`).catch(() => undefined);
    say('Anordnung wie im Browser.', 'good');
  };

  scene.onHud = (b: HudButton, phase) => {
    if (b === 'mic') return void (phase === 'down' ? ptt.down() : ptt.up());
    if (phase !== 'down') return;
    if (b === 'apply') void decide(true);
    else if (b === 'reject') void decide(false);
    else if (b === 'reset') resetArrangement();
    else if (b === 'exit') o.onExit();
  };

  build(true);
  hud();
  o.onStatus(`${name}: ${spec.widgets.length} Widgets`);

  return {
    mic: ptt,
    status: () => message,
    close() {
      closed = true;
      es?.close();
      clearInterval(poll);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      ptt.cancel();
      scene.onMoved = null;
      scene.onHud = null;
    },
  };
}
