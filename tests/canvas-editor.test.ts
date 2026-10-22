import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement, type CanvasElement } from '../server/services/canvas-model.js';
import { bindTarget, hitTest, inLasso, inRect, resizeBox, scaleElement, snapBox, toScreen, toWorld } from '../web/src/canvas/geometry';

/**
 * The editor's pure parts: geometry (hit tests, snapping, resizing), selection commands and the
 * board store (undo, batching, dirty fields, remote merging). No browser – the store only needs
 * `window`, `localStorage` and `fetch`, which are stubbed here.
 */

let ids = 0;
const mk = (o: Record<string, any>): CanvasElement => createElement({ id: `e${++ids}`, ...o }, () => `g${++ids}`, { seed: () => 7 });
const map = (els: CanvasElement[]) => new Map(els.map((e) => [e.id, e]));

describe('canvas geometry', () => {
  it('converts between board and screen coordinates', () => {
    const v = { tx: 100, ty: -50, z: 2 };
    expect(toScreen(v, 10, 20)).toEqual([120, -10]);
    expect(toWorld(v, 120, -10)).toEqual([10, 20]);
  });

  it('hits the top-most element; frames answer only on their label and border', () => {
    const frame = mk({ type: 'frame', x: 0, y: 0, w: 400, h: 300, z: 0 });
    const a = mk({ type: 'rect', x: 20, y: 20, w: 100, h: 60, z: 1, frameId: frame.id });
    const b = mk({ type: 'rect', x: 60, y: 40, w: 100, h: 60, z: 2, frameId: frame.id });
    const ellipse = mk({ type: 'ellipse', x: 200, y: 100, w: 100, h: 100, z: 3 });
    const els = [frame, a, b, ellipse];
    const by = map(els);
    expect(hitTest(els, 70, 50, 4, by)?.id).toBe(b.id); // overlap: b is on top
    expect(hitTest(els, 30, 30, 4, by)?.id).toBe(a.id);
    expect(hitTest(els, 300, 250, 4, by)).toBeNull(); // empty inside of the frame
    expect(hitTest(els, 2, 150, 4, by)?.id).toBe(frame.id); // frame border
    expect(hitTest(els, 10, -10, 4, by)?.id).toBe(frame.id); // frame label
    // ellipse corners are outside
    expect(hitTest(els, 203, 103, 0, by)).toBeNull();
    expect(hitTest(els, 250, 150, 0, by)?.id).toBe(ellipse.id);
    // hidden elements are not hit
    expect(hitTest([{ ...ellipse, hidden: true }], 250, 150, 4, by)).toBeNull();
  });

  it('finds bind targets for arrow ends (never the arrow itself) and selects by marquee and lasso', () => {
    const a = mk({ type: 'rect', x: 0, y: 0, w: 100, h: 60, z: 1 });
    const b = mk({ type: 'rect', x: 300, y: 0, w: 100, h: 60, z: 2 });
    const arrow = mk({ type: 'arrow', x: 100, y: 30, w: 200, h: 0, points: [[0, 0], [200, 0]], start: { id: a.id }, end: { id: b.id }, z: 3 });
    const els = [a, b, arrow];
    const by = map(els);
    expect(bindTarget(els, 350, 30, 4, by)?.id).toBe(b.id);
    expect(bindTarget(els, 200, 30, 4, by, arrow.id)).toBeNull();
    expect(inRect(els, { x: -10, y: -10, w: 130, h: 100 }, by).map((e) => e.id)).toEqual([a.id]);
    expect(inLasso(els, [[-20, -20], [150, -20], [150, 100], [-20, 100]], by).map((e) => e.id)).toEqual([a.id]);
    expect(inLasso(els, [[0, 0], [10, 10]], by)).toEqual([]); // fewer than 3 points
  });

  it('snaps a moving box to edges and centres of others and reports the guides', () => {
    const others = [{ x: 200, y: 0, w: 100, h: 100 }];
    const r = snapBox({ x: 197, y: 61, w: 60, h: 40 }, others, 6);
    expect(r.dx).toBe(3); // left edge to 200
    expect(r.dy).toBe(-1); // bottom edge 101 → 100
    expect(snapBox({ x: 197, y: 61, w: 60, h: 40 }, others, 6).guides.length).toBeGreaterThan(0);
    const far = snapBox({ x: 500, y: 500, w: 10, h: 10 }, others, 6);
    expect(far).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it('resizes by handles: free, proportional and from the centre', () => {
    const box = { x: 100, y: 100, w: 200, h: 100 };
    expect(resizeBox(box, 'se', 400, 300, false, false)).toEqual({ x: 100, y: 100, w: 300, h: 200 });
    expect(resizeBox(box, 'e', 400, 999, false, false)).toEqual({ x: 100, y: 100, w: 300, h: 100 });
    expect(resizeBox(box, 'nw', 50, 50, false, false)).toEqual({ x: 50, y: 50, w: 250, h: 150 });
    const prop = resizeBox(box, 'se', 400, 130, true, false);
    expect(prop.w / prop.h).toBeCloseTo(2);
    const centre = resizeBox(box, 'e', 400, 150, false, true);
    expect(centre).toEqual({ x: 0, y: 100, w: 400, h: 100 });
    // dragging past the opposite side flips instead of going negative
    expect(resizeBox(box, 'e', 50, 150, false, false)).toMatchObject({ x: 50, w: 50 });
  });

  it('scales elements with their points when a selection is resized', () => {
    const line = mk({ type: 'line', x: 100, y: 100, points: [[0, 0], [100, 50]] });
    const r = scaleElement(line, { x: 100, y: 100, w: 100, h: 50 }, { x: 100, y: 100, w: 200, h: 100 });
    expect(r.points).toEqual([[0, 0], [200, 100]]);
    expect(r).toMatchObject({ x: 100, y: 100, w: 200, h: 100 });
  });
});

// --- store & commands -----------------------------------------------------------------------------------------------

type Store = import('../web/src/canvas/store').BoardStore;
let BoardStore: typeof import('../web/src/canvas/store').BoardStore;
let actions: typeof import('../web/src/canvas/actions');
const sent: { url: string; body: any }[] = [];
let respond: (url: string, body: any) => { status: number; data: any } = () => ({ status: 200, data: { seq: 1, results: [] } });
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('dispatchEvent', () => true); // api.ts announces failed calls on window
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    sent.push({ url: String(url), body });
    const r = respond(String(url), body);
    return new Response(JSON.stringify(r.data), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  ({ BoardStore } = await import('../web/src/canvas/store'));
  actions = await import('../web/src/canvas/actions');
});
afterAll(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

const fresh = (els: CanvasElement[] = []): Store => {
  const s = new BoardStore('board1');
  s.load(els, 0);
  sent.length = 0;
  respond = (_u, body) => ({ status: 200, data: { seq: 5, results: (body?.ops ?? []).map((o: any) => ({ id: o.id ?? o.element?.id, status: 'ok', version: 2 })) } });
  return s;
};

describe('board store', () => {
  it('applies edits at once, batches them and undoes/redoes whole gestures', async () => {
    const s = fresh();
    const a = mk({ type: 'rect', x: 0, y: 0, w: 100, h: 50 });
    s.add([a]);
    s.update({ [a.id]: { x: 40 } });
    s.update({ [a.id]: { y: 10 } });
    expect(s.els.get(a.id)).toMatchObject({ x: 40, y: 10 });
    await s.flush();
    // add + two updates became one add with the final state (coalesced)
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('/api/canvas/board1/ops');
    expect(sent[0].body.ops).toHaveLength(1);
    expect(sent[0].body.ops[0]).toMatchObject({ op: 'add', element: { id: a.id, x: 40, y: 10 } });
    expect(sent[0].body.clientId).toMatch(/^c/);
    expect(s.els.get(a.id)?.version).toBe(2);
    // a drag is one undo step
    s.begin();
    s.update({ [a.id]: { x: 100 } }, { send: false });
    s.update({ [a.id]: { x: 200 } }, { send: false });
    s.commit();
    expect(s.els.get(a.id)?.x).toBe(200);
    s.undo();
    expect(s.els.get(a.id)?.x).toBe(40);
    s.redo();
    expect(s.els.get(a.id)?.x).toBe(200);
    s.undo();
    s.undo(); // y
    s.undo(); // x
    s.undo(); // the add itself
    expect(s.els.has(a.id)).toBe(false);
    expect(s.canRedo()).toBe(true);
    s.redo();
    expect(s.els.has(a.id)).toBe(true);
    s.close();
  });

  it('sends only the changed fields of a finished drag, with null for removed ones', async () => {
    const a = mk({ type: 'rect', x: 0, y: 0, w: 100, h: 50 });
    const arrow = mk({ type: 'arrow', x: 100, y: 25, w: 100, h: 0, points: [[0, 0], [100, 0]], start: { id: a.id } });
    const s = fresh([a, arrow]);
    s.begin();
    s.update({ [a.id]: { x: 10, y: 20 }, [arrow.id]: { start: undefined, x: 110 } }, { send: false });
    expect(s.hasUnsent()).toBe(true);
    expect(sent).toHaveLength(0); // nothing goes out mid-gesture
    s.sendDirty([a.id, arrow.id]);
    s.commit();
    await s.flush();
    const ops = sent[0].body.ops;
    expect(ops.find((o: any) => o.id === a.id)).toEqual({ op: 'update', id: a.id, props: { x: 10, y: 20 } });
    expect(ops.find((o: any) => o.id === arrow.id)).toEqual({ op: 'update', id: arrow.id, props: { start: null, x: 110 } });
    expect(s.hasUnsent()).toBe(false);
    s.close();
  });

  it('waits for in-flight batches (flush resolves when everything was sent)', async () => {
    const s = fresh();
    s.add([mk({ type: 'rect', x: 0, y: 0, w: 10, h: 10 })]);
    const first = s.flush();
    s.add([mk({ type: 'rect', x: 20, y: 0, w: 10, h: 10 })]);
    await s.flush();
    await first;
    expect(sent.flatMap((x) => x.body.ops)).toHaveLength(2);
    expect(s.hasUnsent()).toBe(false);
    s.close();
  });

  it('keeps remote changes out of elements with unsent local changes and ignores stale versions', async () => {
    const a = { ...mk({ type: 'rect', x: 0, y: 0, w: 10, h: 10 }), version: 3 };
    const s = fresh([a]);
    s.applyRemote([{ ...a, x: 99, version: 2 }], []);
    expect(s.els.get(a.id)?.x).toBe(0); // older than ours
    s.applyRemote([{ ...a, x: 50, version: 4 }], []);
    expect(s.els.get(a.id)?.x).toBe(50);
    s.update({ [a.id]: { y: 7 } }); // unsent local change pending
    s.applyRemote([{ ...a, x: 70, version: 5 }], []);
    expect(s.els.get(a.id)?.x).toBe(50); // our write follows and wins
    await s.flush();
    s.applyRemote([], [a.id], 9);
    expect(s.els.has(a.id)).toBe(false);
    expect(s.seq).toBe(9);
    s.close();
  });

  it('drops refused writes (403) with an error and retries when the connection fails', async () => {
    const s = fresh();
    const errors: string[] = [];
    s.onError = (e) => errors.push(e.message);
    respond = () => ({ status: 403, data: { error: 'Nur Lesezugriff auf dieses Board' } });
    s.add([mk({ type: 'rect', x: 0, y: 0, w: 10, h: 10 })]);
    await s.flush();
    expect(errors).toEqual(['Nur Lesezugriff auf dieses Board']);
    expect(s.hasUnsent()).toBe(false);
    expect(s.status).toBe('online');
    // server trouble: the batch stays queued, in order, and the status says offline
    respond = () => ({ status: 503, data: { error: 'Dienst nicht erreichbar' } });
    s.add([mk({ type: 'rect', x: 50, y: 0, w: 10, h: 10 })]);
    await s.flush();
    expect(s.status).toBe('offline');
    expect(s.hasUnsent()).toBe(true);
    s.close();
  });

  it('removing a frame takes its content along', () => {
    const f = mk({ type: 'frame', x: 0, y: 0, w: 300, h: 300 });
    const inside = mk({ type: 'rect', x: 10, y: 10, w: 50, h: 50, frameId: f.id });
    const outside = mk({ type: 'rect', x: 400, y: 0, w: 50, h: 50 });
    const s = fresh([f, inside, outside]);
    s.remove([f.id]);
    expect([...s.els.keys()]).toEqual([outside.id]);
    s.undo();
    expect(s.els.size).toBe(3);
    s.close();
  });
});

describe('selection commands', () => {
  const trio = () => [mk({ type: 'rect', x: 0, y: 0, w: 100, h: 50, z: 1 }), mk({ type: 'rect', x: 250, y: 60, w: 100, h: 50, z: 2 }), mk({ type: 'rect', x: 400, y: 20, w: 100, h: 50, z: 3 })];

  it('aligns and distributes', () => {
    const els = trio();
    const s = fresh(els);
    const idsOf = els.map((e) => e.id);
    actions.align(s, idsOf, 'left');
    expect(idsOf.map((id) => s.els.get(id)!.x)).toEqual([0, 0, 0]);
    actions.align(s, idsOf, 'bottom');
    expect(new Set(idsOf.map((id) => s.els.get(id)!.y + s.els.get(id)!.h)).size).toBe(1);
    const s2 = fresh(trio());
    const ids2 = [...s2.els.keys()];
    actions.distribute(s2, ids2, 'h');
    const xs = ids2.map((id) => s2.els.get(id)!).sort((a, b) => a.x - b.x);
    expect(xs[1].x - (xs[0].x + xs[0].w)).toBeCloseTo(xs[2].x - (xs[1].x + xs[1].w));
    s.close();
    s2.close();
  });

  it('changes the stacking order and groups', () => {
    const els = trio();
    const s = fresh(els);
    actions.reorder(s, [els[0].id], 'front');
    expect(s.ordered.at(-1)?.id).toBe(els[0].id);
    actions.reorder(s, [els[0].id], 'back');
    expect(s.ordered[0].id).toBe(els[0].id);
    actions.reorder(s, [els[0].id], 'up');
    expect(s.ordered[1].id).toBe(els[0].id);
    actions.group(s, [els[0].id, els[1].id]);
    const g = s.els.get(els[0].id)!.groupIds!;
    expect(g).toHaveLength(1);
    expect(s.els.get(els[1].id)!.groupIds).toEqual(g);
    expect(actions.groupMembers(s, s.els.get(els[0].id)!).sort()).toEqual([els[0].id, els[1].id].sort());
    actions.ungroup(s, [els[0].id, els[1].id]);
    expect(s.els.get(els[0].id)!.groupIds).toBeUndefined();
    s.close();
  });

  it('duplicates with new ids and keeps arrows between copied shapes bound to the copies', () => {
    const a = mk({ type: 'rect', x: 0, y: 0, w: 100, h: 50 });
    const b = mk({ type: 'rect', x: 200, y: 0, w: 100, h: 50 });
    const arrow = mk({ type: 'arrow', x: 100, y: 25, w: 100, h: 0, points: [[0, 0], [100, 0]], start: { id: a.id }, end: { id: b.id } });
    const lone = mk({ type: 'arrow', x: 0, y: 200, w: 50, h: 0, points: [[0, 0], [50, 0]], start: { id: a.id } });
    const s = fresh([a, b, arrow, lone]);
    const copies = actions.cloneElements([a, b, arrow, lone], 24, 24);
    const idMap = new Map([a, b, arrow, lone].map((e, i) => [e.id, copies[i].id]));
    expect(new Set(copies.map((c) => c.id)).size).toBe(4);
    expect(copies.every((c) => ![a.id, b.id, arrow.id, lone.id].includes(c.id))).toBe(true);
    expect(copies[2].start?.id).toBe(idMap.get(a.id));
    expect(copies[2].end?.id).toBe(idMap.get(b.id));
    expect(copies[3].start?.id).toBe(idMap.get(a.id)); // bound to a copied shape → follows the copy
    expect(copies[0]).toMatchObject({ x: 24, y: 24 });
    // duplicate() brings the arrow between the selected shapes along
    const out = actions.duplicate(s, [a.id, b.id]);
    expect(out).toHaveLength(3); // both shapes and the arrow between them are selected afterwards
    expect(s.els.size).toBe(7);
    s.undo();
    expect(s.els.size).toBe(4); // one undo step for the whole duplicate
    s.close();
  });

  it('copies through the clipboard format and refuses foreign or broken data', () => {
    const a = mk({ type: 'rect', x: 5, y: 6, w: 70, h: 40, text: 'Hallo <b>' });
    const text = actions.serialize([{ ...a, version: 9 }]);
    expect(text).toContain(actions.CLIP_MARK);
    expect(text).not.toContain('"version"');
    const back = actions.parseClipboard(text)!;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ type: 'rect', x: 5, y: 6, text: 'Hallo <b>' });
    expect(actions.parseClipboard('{"hello":"world"}')).toBeNull();
    expect(actions.parseClipboard(`${actions.CLIP_MARK} not json`)).toBeNull();
    // hostile fields are cleaned like on the server
    const hostile = JSON.stringify({ type: actions.CLIP_MARK, elements: [{ type: 'rect', x: 1, y: 1, w: 10, h: 10, fill: 'url(javascript:alert(1))', link: 'javascript:alert(1)' }, { type: 'banana' }, { type: 'image', src: 'https://evil.example/x.png' }] });
    const cleaned = actions.parseClipboard(hostile)!;
    expect(cleaned).toHaveLength(1); // the unknown type and the foreign image are skipped
    expect(cleaned[0].link).toBeUndefined();
    expect(cleaned[0].fill).toBe('transparent');
  });

  it('pastes around a point keeping the arrangement', () => {
    const els = trio();
    const s = fresh();
    const ids = actions.pasteAt(s, els, { x: 1000, y: 1000 });
    expect(ids).toHaveLength(3);
    const placed = ids.map((id) => s.els.get(id)!);
    const left = Math.min(...placed.map((e) => e.x));
    const right = Math.max(...placed.map((e) => e.x + e.w));
    expect((left + right) / 2).toBeCloseTo(1000, 0);
    s.close();
  });
});
