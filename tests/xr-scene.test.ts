import { afterEach, describe, expect, it, vi } from 'vitest';
import type { View as BoardView } from '../web/src/boards/types';
import { Orbit } from '../web/src/xr/engine/runtime';
import { HUD_POSE, HUD_SIZE, modelOf } from '../web/src/xr/engine/geometry';
import { HUD_ID, Scene, TEXTURE_BUDGET } from '../web/src/xr/engine/scene';
import { DARK_THEME, LIGHT_THEME, ellipsize, formatValue, drawHud, drawPanel, drawView, hudButtonAt, onGrip, plainLines, reportPoints, wrapText, type HudState } from '../web/src/xr/engine/textures';

/** A 2D context that records what is drawn; text is 8 px per character wide. */
function fakeCtx() {
  const calls: any[][] = [];
  const state: Record<string, unknown> = {};
  const ctx: any = new Proxy(state, {
    get(t, p: string) {
      if (p === '__calls') return calls;
      if (p === 'measureText') return (s: string) => ({ width: String(s).length * 8 });
      if (p in t) return t[p];
      return (...a: unknown[]) => void calls.push([p, ...a]);
    },
    set(t, p: string, v) {
      t[p] = v;
      return true;
    },
  });
  const texts = () => calls.filter((c) => c[0] === 'fillText').map((c) => String(c[1]).replace(/ /g, ' '));
  return { ctx: ctx as CanvasRenderingContext2D, calls, texts };
}

describe('text helpers', () => {
  const { ctx } = fakeCtx();
  it('cuts to the width with an ellipsis and wraps by words, never past the line count', () => {
    expect(ellipsize(ctx, 'kurz', 100)).toBe('kurz');
    expect(ellipsize(ctx, 'ein sehr langer Titel', 80)).toMatch(/…$/);
    expect(ellipsize(ctx, 'ein sehr langer Titel', 80).length * 8).toBeLessThanOrEqual(80);
    expect(ellipsize(ctx, 'x', 0)).toBe('');
    expect(wrapText(ctx, 'eins zwei drei vier fünf sechs', 80, 3)).toEqual(['eins zwei', 'drei vier', 'fünf sechs']);
    const cut = wrapText(ctx, 'eins zwei drei vier fünf sechs sieben acht', 80, 2);
    expect(cut).toHaveLength(2);
    expect(cut[1]).toMatch(/…$/);
    expect(wrapText(ctx, '', 80, 2)).toEqual(['']);
    expect(wrapText(ctx, 'Zeile eins\nZeile zwei', 400, 5)).toEqual(['Zeile eins', 'Zeile zwei']);
    // a word wider than the line is cut, not overflowing
    expect(wrapText(ctx, 'Donaudampfschifffahrtsgesellschaft', 80, 2)[0].length * 8).toBeLessThanOrEqual(80);
  });

  it('formats numbers the German way and notes as plain lines', () => {
    expect(formatValue(7180, 'money').replace(/ /g, ' ')).toBe('7.180 €');
    expect(formatValue(12.5, 'percent').replace(/ /g, ' ')).toBe('12,5 %');
    expect(formatValue(3, 'days')).toBe('3 Tage');
    expect(formatValue(1234.5)).toBe('1.234,5');
    expect(formatValue(null)).toBe('–');
    expect(formatValue('fertig')).toBe('fertig');
    expect(formatValue(NaN)).toBe('–');
    expect(plainLines('# Titel\n\n- eins\n- **zwei** [Link](https://x.de)\n\nText').filter((l) => l.text)).toEqual([
      { text: 'Titel', bold: true, bullet: false },
      { text: 'eins', bold: false, bullet: true },
      { text: 'zwei Link', bold: false, bullet: true },
      { text: 'Text', bold: false, bullet: false },
    ].map((l) => expect.objectContaining(l)));
    expect(plainLines('```js\nx\n```').every((l) => !l.text.includes('x'))).toBe(true);
  });
});

describe('widgets as pictures: every kind of view is drawn, simplified', () => {
  const draw = (view: BoardView | undefined, loading = false) => {
    const f = fakeCtx();
    drawPanel(f.ctx, 800, 600, { title: 'Titel', view, loading, theme: LIGHT_THEME });
    return f;
  };
  const views: Record<string, [BoardView, RegExp]> = {
    number: [{ kind: 'number', value: 7180, format: 'money', label: 'Offener Pipeline-Wert', delta: 12.5 }, /7\.180 €/],
    numbers: [{ kind: 'numbers', items: [{ label: 'Leads', value: 14 }, { label: 'Umsatz', value: 900, format: 'money' }] }, /Leads/],
    list: [{ kind: 'list', rows: [{ id: '1', title: 'Angebot nachfassen', subtitle: 'Anna', badge: { text: 'Überfällig', tone: 'red' }, check: { task_id: 't', done: false } }], total: 5 }, /Angebot nachfassen/],
    table: [{ kind: 'table', columns: [{ key: 'a', label: 'Name' }, { key: 'b', label: 'Wert', align: 'right' }], rows: [{ a: 'Alpha', b: 3 }] }, /Alpha/],
    kanban: [{ kind: 'kanban', columns: [{ id: 'c', title: 'Neuer Lead', count: 1, cards: [{ id: 'k', title: 'Jahresabo', subtitle: 'Ben' }] }] }, /Jahresabo/],
    agenda: [{ kind: 'agenda', days: [{ date: '2026-10-05', label: 'Mo 5.10.', items: [{ id: 'a', time: '09:00', title: 'Strategie-Call' }] }] }, /Strategie-Call/],
    markdown: [{ kind: 'markdown', text: '# Wochenplan\n- Retreat-Anfragen' }, /Wochenplan/],
    message: [{ kind: 'message', text: 'Alles ruhig.' }, /Alles ruhig/],
    locked: [{ kind: 'locked', reason: 'Dir fehlt das Recht Kontakte' }, /Gesperrt/],
    embed: [{ kind: 'embed', url: 'https://example.com' }, /nicht darstellbar/],
    frame: [{ kind: 'frame', plugin_id: 'p', entry: 'e' }, /nicht darstellbar/],
    actions: [{ kind: 'actions', actions: [] }, /Schnellaktionen/],
    report: [{ kind: 'report', viz: 'bar', result: { measures: [{ key: 'n', label: 'Umsatz', format: 'money' }], rows: [{ k: ['a'], l: ['Okt'], v: [100] }, { k: ['b'], l: ['Nov'], v: [250] }] } }, /höchster Wert 250/],
  };
  for (const [name, [view, text]] of Object.entries(views))
    it(name, () => {
      const f = draw(view);
      expect(f.texts().join(' | ')).toMatch(text);
      // the card, the title bar and the title are always there
      expect(f.texts()).toContain('Titel');
      expect(f.calls.some((c) => c[0] === 'clip')).toBe(true);
    });

  it('shows a skeleton while loading, a quiet line without data, and says so for a kind it does not know', () => {
    expect(draw(undefined, true).calls.some((c) => c[0] === 'fill')).toBe(true);
    expect(draw(undefined, false).texts().join(' ')).toMatch(/Keine Daten/);
    const unknown = fakeCtx();
    drawView(unknown.ctx, { x: 0, y: 0, w: 400, h: 300 }, { kind: 'future' } as any, false, LIGHT_THEME);
    expect(unknown.texts().join(' ')).toMatch(/lässt sich hier nicht darstellen/);
    // empty lists and tables say so
    expect(draw({ kind: 'list', rows: [], empty: 'Keine Deals.' }).texts().join(' ')).toMatch(/Keine Deals/);
    expect(draw({ kind: 'table', columns: [], rows: [] }).texts().join(' ')).toMatch(/Nichts zu zeigen/);
  });

  it('draws charts from the first measure, keeps the shape of long series and draws lines and areas', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ k: [String(i)], l: [`T${i}`], v: [i] }));
    const { points, format } = reportPoints({ measures: [{ label: 'Leads', format: 'number' }], rows }, 24);
    expect(points).toHaveLength(24);
    expect(format).toBe('number');
    expect(points.reduce((a, p) => a + p.value, 0)).toBe(rows.reduce((a, r) => a + r.v[0], 0));
    expect(reportPoints({}).points).toEqual([]);
    for (const viz of ['line', 'area', 'bar', 'hbar', 'pie']) {
      const f = draw({ kind: 'report', viz, result: { measures: [{ label: 'Leads', format: 'number' }], rows } });
      expect(f.calls.some((c) => c[0] === 'stroke' || c[0] === 'fill')).toBe(true);
    }
    expect(draw({ kind: 'report', viz: 'kpi', result: { measures: [{ label: 'Umsatz', format: 'money' }], totals: { v: [1200] }, rows: [] } }).texts().join(' ')).toMatch(/1\.200 €/);
    expect(draw({ kind: 'report', viz: 'bar', result: { measures: [], rows: [] } }).texts().join(' ')).toMatch(/Keine Daten/);
  });

  it('knows the title bar: the part of a panel you grab', () => {
    expect(onGrip(0.01, 600)).toBe(true);
    expect(onGrip(0.5, 600)).toBe(false);
  });
});

describe('the control panel', () => {
  const state = (extra: Partial<HudState> = {}): HudState => ({ title: 'Vertrieb', mic: 'idle', buttons: ['mic', 'reset', 'exit'], ...extra });
  const hud = (s: HudState, theme = LIGHT_THEME) => {
    const f = fakeCtx();
    return { ...f, regions: drawHud(f.ctx, 960, 320, s, theme) };
  };

  it('has the microphone, reset and exit, and finds them by where you point', () => {
    const h = hud(state());
    expect(h.regions.map((r) => r.id)).toEqual(['mic', 'reset', 'exit']);
    expect(h.texts().join(' ')).toMatch(/Sprechen/);
    for (const r of h.regions) expect(hudButtonAt(h.regions, (r.x + r.w / 2) / 960, (r.y + r.h / 2) / 320, 960, 320)).toBe(r.id);
    expect(hudButtonAt(h.regions, 0.01, 0.01, 960, 320)).toBeNull();
    // every button is on the panel and big enough to hit with a controller (at least 60 px of a 1.5 m wide texture ≈ 9 cm)
    for (const r of h.regions) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(960);
      expect(r.h / 320).toBeGreaterThan(0.15);
    }
  });

  it('shows what is being heard, a proposal with Übernehmen / Verwerfen, and hides the microphone where there is none', () => {
    expect(hud(state({ mic: 'recording' })).texts().join(' ')).toMatch(/Ich höre zu/);
    expect(hud(state({ mic: 'working' })).texts().join(' ')).toMatch(/Ich schreibe mit/);
    const p = hud(state({ proposal: { summary: 'Kalender neben der Pipeline', risk: 'low' } }));
    expect(p.regions.map((r) => r.id)).toEqual(['apply', 'reject', 'mic', 'exit']);
    expect(p.texts().join(' ')).toMatch(/Vorschlag: Kalender/);
    expect(hud(state({ mic: 'off' })).regions.map((r) => r.id)).toEqual(['reset', 'exit']);
    expect(hud(state({ mic: 'off' })).texts().join(' ')).toMatch(/Stimme einrichten/);
    expect(hud(state({ readOnly: true })).texts().join(' ')).toMatch(/Nur Ansicht/);
    expect(hud(state({ buttons: ['refresh', 'theme', 'exit'], mic: 'off' })).regions.map((r) => r.id)).toEqual(['refresh', 'theme', 'exit']);
    expect(hud(state({ message: 'Fehler', messageTone: 'error' }), DARK_THEME).texts()).toContain('Fehler');
  });
});

describe('the scene: pointing, grabbing, saving what moved', () => {
  const frames: any[] = [];
  const renderer: any = {
    createTexture: () => ({ tex: {}, w: 1, h: 1 }),
    upload: vi.fn((t: any, _s: unknown, w: number, h: number) => ((t.w = w), (t.h = h))),
    deleteTexture: vi.fn(),
    frame: (views: any[], items: any[], lines: any[]) => frames.push({ views, items, lines }),
  };
  const makeCanvas = () => {
    const f = fakeCtx();
    return { width: 0, height: 0, getContext: () => f.ctx } as unknown as HTMLCanvasElement;
  };
  const scene = () => new Scene(renderer, LIGHT_THEME, makeCanvas);
  const size = { width: 1, height: 0.6 };
  const panel = (id: string, x: number, z = -2) => ({ id, size, pose: { x, y: 0, z, yaw: 0, scale: 1 }, paint: vi.fn() });
  const ahead = { origin: [0, 0, 0] as [number, number, number], dir: [0, 0, -1] as [number, number, number] };
  afterEach(() => void (frames.length = 0));

  it('keeps the place the person gave a panel when the content refreshes, frees what is gone, and adds new ones on the arc', () => {
    const s = scene();
    s.setPanels([panel('a', -1), panel('b', 1)]);
    s.setPoses({ a: { x: 3, y: 1, z: -3, yaw: 0.2, scale: 1.2 } });
    s.setPanels([panel('a', -1), panel('c', 0)]);
    expect(s.poses().a).toMatchObject({ x: 3, y: 1 });
    expect(s.hasPanel('b')).toBe(false);
    expect(renderer.deleteTexture).toHaveBeenCalled();
    expect(s.hasPanel('c')).toBe(true);
    expect(s.panelCount()).toBe(2);
  });

  it('points: the nearest panel is hovered, nothing when the ray misses or is lost', () => {
    const s = scene();
    s.setPanels([panel('far', 0, -3), panel('near', 0, -1.5)]);
    expect(s.pointer('mouse', ahead)).toBe('near');
    expect(s.pointer('mouse', { origin: [5, 0, 0], dir: [0, 0, -1] })).toBeNull();
    expect(s.pointer('mouse', null)).toBeNull();
    expect(s.press('mouse')).toBe('none');
  });

  it('grabs on press, follows the pointer, and reports the poses on release – only the moved panel is listed', () => {
    const s = scene();
    const moved = vi.fn();
    s.onMoved = moved;
    s.setPanels([panel('a', 0), panel('b', 3)]);
    s.pointer('hand', ahead);
    expect(s.press('hand')).toBe('grab');
    expect(s.isGrabbing()).toBe(true);
    s.pointer('hand', { origin: [0, 0, 0], dir: [0.5, 0, -1] });
    s.update(0.016);
    const p = s.poses().a;
    expect(p.x).toBeGreaterThan(0.5);
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(2, 1);
    expect(p.yaw).toBeLessThan(0);
    s.release('hand');
    expect(s.isGrabbing()).toBe(false);
    expect(moved).toHaveBeenCalledTimes(1);
    expect(s.movedIds()).toEqual(['a']);
    s.forgetMoves();
    expect(s.movedIds()).toEqual([]);
    // the thumbstick pushes the panel away while it is held
    s.pointer('hand', { origin: [0, 0, 0], dir: [Math.sin(0.4), 0, -Math.cos(0.4)] });
    s.press('hand');
    const z0 = s.poses().a.z;
    s.update(0.5, { hand: { x: 0, y: -1 } });
    expect(s.poses().a.z).toBeLessThan(z0);
    // the wheel of the preview does the same, and also makes it bigger
    expect(s.nudgeGrab('hand', 0.3, 0.2)).toBe(true);
    expect(s.poses().a.scale).toBeGreaterThan(1);
    expect(s.nudgeGrab('nobody', 1)).toBe(false);
  });

  it('presses the control panel’s buttons (down and up) and grabs the panel anywhere else', () => {
    const s = scene();
    const hudCalls: string[] = [];
    s.onHud = (b, phase) => hudCalls.push(`${b}:${phase}`);
    s.setPanels([panel('a', 3)]);
    s.setHud({ title: 'T', mic: 'idle', buttons: ['mic', 'reset', 'exit'] });
    // the control panel draws on the next frame; its button positions are known after that
    s.draw([{ viewport: [0, 0, 10, 10], view: new Float32Array(16), proj: new Float32Array(16) }], [0, 0, 0]);
    const hudPose = HUD_POSE;
    const m = modelOf(hudPose);
    expect(m).toHaveLength(16);
    // aim at the middle of the exit button: it is the last of three, at v ≈ 0.78
    const aim = (u: number, v: number) => {
      const x = hudPose.x + (u - 0.5) * HUD_SIZE.width;
      const y = hudPose.y + (0.5 - v) * HUD_SIZE.height;
      const d = [x, y, hudPose.z];
      const len = Math.hypot(...d);
      return { origin: [0, 0, 0] as [number, number, number], dir: d.map((c) => c / len) as [number, number, number] };
    };
    s.pointer('c', aim(0.78, 0.78));
    expect(s.hoverOf('c')?.id).toBe(HUD_ID);
    expect(s.press('c')).toBe('hud');
    s.release('c');
    expect(hudCalls).toEqual(['exit:down', 'exit:up']);
    // beside the buttons the control panel is grabbed like any panel
    s.pointer('c', aim(0.5, 0.12));
    expect(s.press('c')).toBe('grab');
    s.release('c');
    expect(s.movedIds()).toContain(HUD_ID);
  });

  it('draws back to front with the texture budget respected, repaints only what changed and draws a ray for a controller', () => {
    const s = scene();
    const many = Array.from({ length: 40 }, (_, i) => ({ ...panel(`p${i}`, (i % 8) - 4, -2 - i * 0.01), size: { width: 3, height: 3 } }));
    s.setPanels(many);
    s.pointer('hand', ahead, true);
    s.draw([{ viewport: [0, 0, 10, 10], view: new Float32Array(16), proj: new Float32Array(16) }], [0, 0, 0], { ring: true });
    const f = frames[0];
    expect(f.items.length).toBeGreaterThanOrEqual(40);
    // far panels come first
    const dist = f.items.slice(0, 40).map((it: any) => Math.hypot(it.model[12], it.model[13], it.model[14]));
    expect([...dist].sort((a, b) => b - a)).toEqual(dist);
    expect(f.lines.length).toBeGreaterThanOrEqual(2);
    // texture memory stays within the budget even for 40 big panels
    const px = many.reduce((n, _p, i) => n + (renderer.upload.mock.calls[i]?.[2] ?? 0) * (renderer.upload.mock.calls[i]?.[3] ?? 0), 0);
    expect(px).toBeLessThanOrEqual(TEXTURE_BUDGET * 1.05);
    // only a few uploads per frame; after more frames all of them are there, a second pass repaints nothing
    for (let i = 0; i < 12; i++) s.draw([{ viewport: [0, 0, 1, 1], view: new Float32Array(16), proj: new Float32Array(16) }]);
    const uploads = renderer.upload.mock.calls.length;
    s.draw([{ viewport: [0, 0, 1, 1], view: new Float32Array(16), proj: new Float32Array(16) }]);
    expect(renderer.upload.mock.calls.length).toBe(uploads);
    s.invalidate('p3');
    s.draw([{ viewport: [0, 0, 1, 1], view: new Float32Array(16), proj: new Float32Array(16) }]);
    expect(renderer.upload.mock.calls.length).toBe(uploads + 1);
    s.dispose();
    expect(s.panelCount()).toBe(0);
  });
});

describe('the preview camera', () => {
  it('orbits within limits, zooms within limits and starts behind the viewer looking at the wall', () => {
    const o = new Orbit();
    const eye = o.eye();
    expect(eye[2]).toBeGreaterThan(0);
    expect(eye[2] + 2.2).toBeCloseTo(o.dist, 1);
    o.drag(100, 0);
    expect(o.yaw).toBeLessThan(0);
    o.drag(0, 1e6);
    expect(o.pitch).toBeLessThanOrEqual(1.2);
    o.zoom(-5);
    expect(o.dist).toBeGreaterThanOrEqual(1.2);
    o.zoom(1e6);
    expect(o.dist).toBeLessThanOrEqual(14);
    o.reset();
    expect(o.yaw).toBe(0);
    expect(o.view()).toHaveLength(16);
  });
});

describe('the canvas picture', () => {
  // the api client reads the sub-account from localStorage when it loads
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  const png = new Blob([new Uint8Array(8)], { type: 'image/png' });
  vi.stubGlobal('createImageBitmap', async () => ({ width: 1600, height: 900, close: () => undefined }));
  const reply = (status: number, body: unknown = {}) => ({ ok: status < 300, status, blob: async () => png, json: async () => body }) as unknown as Response;

  it('asks for a sharp picture first and a smaller one when the server says it is too big', async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(url);
      return seen.length < 3 ? reply(400, { error: 'Bild zu groß' }) : reply(200);
    }) as unknown as typeof fetch;
    const { fetchCanvasImage, EXPORT_SCALES } = await import('../web/src/xr/engine/canvas-scene');
    const img = await fetchCanvasImage('c1', false, f);
    expect(img).toMatchObject({ w: 1600, h: 900 });
    expect(seen.map((u) => /scale=([\d.]+)/.exec(u)![1])).toEqual(EXPORT_SCALES.map(String));
    expect(seen[0]).toContain('/api/canvas/c1/export?format=png');
    expect(seen[0]).toContain('theme=light');
  });

  it('gives up with the server’s own words, and does not retry on a refusal', async () => {
    const { fetchCanvasImage } = await import('../web/src/xr/engine/canvas-scene');
    await expect(fetchCanvasImage('c1', true, (async () => reply(400, { error: 'Bild zu groß – bitte kleineren Bereich oder Maßstab wählen' })) as unknown as typeof fetch)).rejects.toThrow(/Bild zu groß/);
    let calls = 0;
    await expect(fetchCanvasImage('c1', true, (async () => (calls++, reply(404, { error: 'Board nicht gefunden' }))) as unknown as typeof fetch)).rejects.toThrow(/nicht gefunden/);
    expect(calls).toBe(1);
  });
});
