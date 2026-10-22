import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { applyProps, createElement, fitToPoints, sceneOutline, type CanvasElement } from '../server/services/canvas-model.js';
import { esc, lineGeometry, renderSvg, sceneDisplayList } from '../server/services/canvas-render.js';
import { layoutGraph } from '../server/services/canvas-layout.js';
import { MermaidError, mermaidToElements, parseMermaid } from '../server/services/canvas-mermaid.js';
import { buildTemplate, TEMPLATES } from '../server/services/canvas-templates.js';
import { buildPdf } from '../server/services/canvas-pdf.js';
import { decodePng, encodePng, rasterize } from '../server/services/canvas-png.js';
import { layoutText } from '../server/services/canvas-text.js';
import { glyph } from '../server/services/canvas-font.js';
import { flowchartToWorkflow, workflowGraph } from '../server/modules/canvas-integrations.js';
import { requiredPermission } from '../server/core/permissions.js';
import { BYE, expireSession, loginAgain, openSse } from './sse-fixtures.js';

let n = 0;
const nid = () => `t${++n}`;
const mk = (o: Record<string, any>) => createElement(o, nid, { seed: () => 42 });

// --- scene model ---------------------------------------------------------------------------------------

describe('canvas scene model', () => {
  it('cleans untrusted elements: types, colours, numbers, text, links, images', () => {
    expect(() => mk({ type: 'script' })).toThrow(/Unbekannter Elementtyp/);
    const el = mk({ type: 'rect', x: '12.345', y: 1e12, w: -5, h: 50, fill: 'red" onload="x', stroke: '#ABC', text: 'a\u0000b c', link: 'javascript:alert(1)', angle: 450, extra: 'drop me' });
    expect(el.x).toBe(12.35);
    expect(el.y).toBe(1_000_000);
    expect(el.w).toBe(0);
    expect(el.fill).toBe('transparent'); // invalid colour keeps the default
    expect(el.stroke).toBe('#abc');
    expect(el.text).toBe('abc');
    expect(el.link).toBeUndefined();
    expect(el.angle).toBe(90);
    expect((el as any).extra).toBeUndefined();
    expect(() => mk({ type: 'image', src: 'https://evil.example/x.png' })).toThrow(/Mediathek/);
    expect(mk({ type: 'image', src: '/uploads/abcdefgh1234.png' }).src).toBe('/uploads/abcdefgh1234.png');
    expect(createElement({ type: 'image', src: 'http://localhost/uploads/abcdefgh1234.jpg' }, nid, { base: 'http://localhost' }).src).toBe('/uploads/abcdefgh1234.jpg');
    expect(mk({ type: 'sticky', fill: 'rosa' }).fill).toBe('#ffc9de');
    expect(() => mk({ type: 'card', card: { kind: 'invoice', id: 'x' } })).toThrow(/card/);
    expect(mk({ type: 'card', card: { kind: 'deal', id: 'abc123' } }).w).toBeGreaterThan(200);
  });

  it('keeps line boxes around their points and sizes text to its content', () => {
    const line = fitToPoints({ id: 'l', type: 'line', x: 100, y: 100, w: 0, h: 0, points: [[10, 20], [60, -30]] });
    expect(line).toMatchObject({ x: 110, y: 70, w: 50, h: 50 });
    expect(line.points).toEqual([[0, 50], [50, 0]]);
    const t = mk({ type: 'text', text: 'Hallo Welt', fontSize: 20 });
    expect(t.w).toBeGreaterThan(80);
    expect(t.w).toBeLessThan(140);
    expect(t.h).toBe(25);
    const updated = applyProps(t, { fontSize: 'x' });
    expect(updated.fontSize).toBeUndefined();
    const wrapped = layoutText('Ein ziemlich langer Satz für den Umbruch', 16, { maxWidth: 120 });
    expect(wrapped.lines.length).toBeGreaterThan(1);
    expect(Math.max(...wrapped.widths)).toBeLessThanOrEqual(120);
  });

  it('resolves arrow bindings against the moving shapes', () => {
    const a = mk({ id: 'a', type: 'rect', x: 0, y: 0, w: 100, h: 50 });
    const b = mk({ id: 'b', type: 'rect', x: 300, y: 0, w: 100, h: 50 });
    const arrow = mk({ type: 'arrow', start: { id: 'a' }, end: { id: 'b' }, points: [[0, 0], [1, 1]] });
    const byId = new Map([a, b, arrow].map((e) => [e.id, e]));
    let g = lineGeometry(arrow, { byId });
    expect(g.start[0]).toBeGreaterThan(100);
    expect(g.end[0]).toBeLessThan(300);
    byId.set('b', { ...b, y: 400 });
    g = lineGeometry({ ...arrow, route: 'elbow' }, { byId });
    expect(g.end[1]).toBeLessThan(400); // enters from the top
    expect(g.pts.every((p, i) => i === 0 || p[0] === g.pts[i - 1][0] || p[1] === g.pts[i - 1][1])).toBe(true);
  });

  it('writes a readable outline for agents', () => {
    const f = mk({ id: 'f1', type: 'frame', x: 0, y: 0, w: 400, h: 300, name: 'Startseite' });
    const s = mk({ id: 's1', type: 'sticky', text: 'Idee', frameId: 'f1' });
    const c = mk({ id: 'c1', type: 'ellipse', text: 'Kunde' });
    const out = sceneOutline([f, s, c, mk({ type: 'arrow', start: { id: 's1' }, end: { id: 'c1' }, points: [[0, 0], [1, 1]] })], 'Plan');
    expect(out).toContain('## Rahmen "Startseite" [f1]');
    expect(out).toContain('Notiz "Idee" [s1]');
    expect(out).toMatch(/Pfeil .*Notiz "Idee" \[s1\] → Ellipse "Kunde" \[c1\]/);
  });
});

// --- export safety (XSS) --------------------------------------------------------------------------------------

describe('canvas SVG export escaping', () => {
  it('never emits user text as markup', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
    const els = [
      mk({ type: 'text', text: evil }),
      mk({ type: 'rect', x: 0, y: 100, text: evil, fill: '#fff' }),
      mk({ type: 'frame', x: 400, y: 0, w: 200, h: 200, name: evil }),
      mk({ type: 'table', x: 0, y: 300, cells: [[evil, 'b']] }),
      mk({ type: 'chart', x: 0, y: 500, chart: { kind: 'bar', title: evil, labels: [evil], series: [{ name: evil, values: [1] }] } }),
      mk({ type: 'card', x: 700, y: 0, card: { kind: 'contact', id: 'abc12345' } }),
    ];
    const cards = { 'contact:abc12345': { ok: true, title: evil, subtitle: evil, fields: [[evil, evil]] as [string, string][], badge: { text: evil, tone: 'red' as const } } };
    const { svg } = renderSvg(els, { cards, title: evil, background: '#ffffff' });
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/<img/i);
    expect(svg).not.toMatch(/<[^>]*\son\w+=/i); // no event handler attribute in any tag
    expect(svg).toContain('&lt;script&gt;');
    expect(svg.match(/<[a-z]+/gi)!.every((t) => ['<svg', '<title', '<defs', '<clipPath', '<path', '<g', '<text', '<tspan', '<image'].includes(t))).toBe(true);
    expect(esc('"<>&\'')).toBe('&quot;&lt;&gt;&amp;&#39;');
  });

  it('drops images that are not media-library raster files', () => {
    const img = mk({ type: 'image', src: '/uploads/abcdefgh1234.png' });
    const ok = renderSvg([img], { imageHref: (s) => s }).svg;
    expect(ok).toContain('href="/uploads/abcdefgh1234.png"');
    const bad = renderSvg([img], { imageHref: () => 'javascript:alert(1)' }).svg;
    expect(bad).not.toContain('javascript:');
    const data = renderSvg([img], { imageHref: () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }).svg;
    expect(data).not.toContain('data:image/svg');
  });

  it('hides live card data on public renders', () => {
    const els = [mk({ type: 'card', card: { kind: 'contact', id: 'abc12345' } })];
    const cards = { 'contact:abc12345': { ok: true, title: 'Geheime Person', fields: [['E-Mail', 'secret@example.com']] as [string, string][] } };
    const pub = renderSvg(els, { cards, publicView: true }).svg;
    expect(pub).not.toContain('Geheime Person');
    expect(pub).not.toContain('secret@example.com');
    expect(pub).toContain('nur im CRM');
    expect(renderSvg(els, { cards }).svg).toContain('Geheime Person');
  });

  it('renders the same scene as PDF and PNG', () => {
    const els = buildTemplate('sales', nid)!.map((e) => createElement(e as any, nid));
    const dl = sceneDisplayList(els, { background: '#ffffff' });
    const pdf = Buffer.from(buildPdf([{ width: dl.width, height: dl.height, prims: dl.prims }], { title: 'Ü<x>' }));
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdf.toString('latin1')).toContain('/BaseFont /Helvetica');
    expect(pdf.toString('latin1')).toMatch(/startxref\n\d+\n%%EOF\n$/);
    const bmp = rasterize([{ t: 'group', m: [0.25, 0, 0, 0.25, 0, 0], children: dl.prims }], dl.width / 4, dl.height / 4, { background: '#ffffff' });
    const png = encodePng(bmp);
    const back = decodePng(png)!;
    expect(back.w).toBe(bmp.w);
    // something was drawn: not every pixel is white
    let ink = 0;
    for (let i = 0; i < back.data.length; i += 4) if (back.data[i] < 200) ink++;
    expect(ink).toBeGreaterThan(50);
  });

  it('has stroke glyphs for German text', () => {
    for (const ch of 'AZaz09äöüÄÖÜß€?!.,-') expect(glyph(ch), ch).not.toBeNull();
  });
});

// --- layout & Mermaid ------------------------------------------------------------------------------------------

const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('canvas auto-layout', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id, w: 120, h: 50 }));
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'a', to: 'c' },
    { from: 'b', to: 'd' },
    { from: 'b', to: 'e' },
    { from: 'c', to: 'f' },
    { from: 'c', to: 'g' },
  ];
  const boxes = (pos: Record<string, { x: number; y: number }>) => nodes.map((nd) => ({ ...pos[nd.id], w: nd.w, h: nd.h }));
  const noOverlap = (pos: Record<string, { x: number; y: number }>) => {
    const b = boxes(pos);
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) expect(overlap(b[i], b[j]), `${nodes[i].id}/${nodes[j].id}`).toBe(false);
  };

  it('tree: parents above children, centred, no overlaps', () => {
    const pos = layoutGraph(nodes, edges, { kind: 'tree' });
    noOverlap(pos);
    expect(pos.a.y).toBeLessThan(pos.b.y);
    expect(pos.b.y).toBeLessThan(pos.d.y);
    expect(Math.abs(pos.b.x + 60 - (pos.d.x + pos.e.x + 120) / 2)).toBeLessThan(1);
  });

  it('flow: every edge goes to a later layer (also with a cycle)', () => {
    const pos = layoutGraph(nodes, [...edges, { from: 'g', to: 'a' }], { kind: 'flow', direction: 'right' });
    noOverlap(pos);
    for (const e of edges) expect(pos[e.to].x).toBeGreaterThan(pos[e.from].x);
    const down = layoutGraph(nodes, edges, { kind: 'flow', direction: 'down' });
    for (const e of edges) expect(down[e.to].y).toBeGreaterThan(down[e.from].y);
  });

  it('radial and mind map put the root in the middle; grid makes rows', () => {
    for (const kind of ['radial', 'mindmap'] as const) {
      const pos = layoutGraph(nodes, edges, { kind });
      noOverlap(pos);
      const xs = nodes.map((nd) => pos[nd.id].x + 60);
      const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
      expect(Math.abs(pos.a.x + 60 - mid), kind).toBeLessThan(160);
    }
    const grid = layoutGraph(nodes, [], { kind: 'grid', columns: 3 });
    expect(grid.a.y).toBe(grid.c.y);
    expect(grid.d.y).toBeGreaterThan(grid.a.y);
  });
});

describe('canvas Mermaid parser', () => {
  it('parses flowcharts: shapes, labels, chains, &, subgraphs, styles', () => {
    const r = parseMermaid(`%% Kommentar
flowchart LR
  A([Start]) --> B[Formular prüfen] --> C{OK?}
  C -->|Ja| D((Fertig))
  C -- Nein --> E[Nachfassen]
  E -.-> B
  B & C ==> F[Log]
  subgraph team [Vertrieb]
    G[Anrufen] --- H[Notiz]
  end
  style D fill:#b2f2bb`);
    expect(r.kind).toBe('flowchart');
    if (r.kind !== 'flowchart') return;
    const byId = Object.fromEntries(r.graph.nodes.map((nd) => [nd.id, nd]));
    expect(r.graph.direction).toBe('right');
    expect(byId.A).toMatchObject({ label: 'Start', shape: 'pill' });
    expect(byId.C.shape).toBe('diamond');
    expect(byId.D).toMatchObject({ shape: 'ellipse', fill: '#b2f2bb' });
    expect(byId.G.group).toBe('team');
    expect(r.graph.groups).toEqual([{ id: 'team', title: 'Vertrieb' }]);
    const e = (f: string, t: string) => r.graph.edges.find((x) => x.from === f && x.to === t);
    expect(e('B', 'C')).toBeTruthy();
    expect(e('C', 'D')?.label).toBe('Ja');
    expect(e('C', 'E')?.label).toBe('Nein');
    expect(e('E', 'B')?.dashed).toBe(true);
    expect(e('C', 'F')?.thick).toBe(true);
    expect(e('G', 'H')?.head).toBe('none');
  });

  it('parses mind maps by indentation and sequence diagrams', () => {
    const m = parseMermaid(`mindmap
  root((Launch))
    Marketing
      E-Mail
      Ads
    Vertrieb
      Calls`);
    expect(m.kind).toBe('mindmap');
    if (m.kind === 'mindmap') {
      expect(m.graph.nodes.map((x) => x.label)).toEqual(['Launch', 'Marketing', 'E-Mail', 'Ads', 'Vertrieb', 'Calls']);
      expect(m.graph.edges).toContainEqual({ from: 'm2', to: 'm3' });
      expect(m.graph.edges).toContainEqual({ from: 'm1', to: 'm5' });
    }
    const s = parseMermaid(`sequenceDiagram
  participant K as Kunde
  actor V as Vertrieb
  K->>V: Anfrage
  V-->>K: Angebot
  Note over K,V: Später
  loop Täglich
    V->>K: Follow-up
  end`);
    expect(s.kind).toBe('sequence');
    if (s.kind === 'sequence') {
      expect(s.participants).toEqual([{ id: 'K', label: 'Kunde' }, { id: 'V', label: 'Vertrieb', actor: true }]);
      expect(s.items.filter((i) => i.t === 'msg')).toHaveLength(3);
      expect(s.items.find((i) => i.t === 'msg' && i.dashed)).toBeTruthy();
    }
    const els = mermaidToElements('sequenceDiagram\n A->>B: Hi', nid).elements;
    expect(els.filter((e) => e.type === 'arrow')).toHaveLength(1);
    expect(() => parseMermaid('pie title X')).toThrow(MermaidError);
  });

  it('builds bound arrows and frames from a flowchart', () => {
    const { elements } = mermaidToElements('graph TD\n subgraph S [Bereich]\n A[Eins] --> B[Zwei]\n end', nid);
    const frame = elements.find((e) => e.type === 'frame')!;
    const shapes = elements.filter((e) => e.type === 'rect');
    const arrow = elements.find((e) => e.type === 'arrow')!;
    expect(frame.name).toBe('Bereich');
    expect(shapes.every((s) => s.frameId === frame.id)).toBe(true);
    expect(arrow.start?.id).toBe(shapes[0].id);
    expect(arrow.end?.id).toBe(shapes[1].id);
  });

  it('every template builds valid elements', () => {
    expect(TEMPLATES.map((t) => t.key)).toEqual(['mindmap', 'flowchart', 'journey', 'funnel', 'sales', 'org', 'swot', 'kanban', 'wireframe', 'social']);
    for (const t of TEMPLATES) {
      const els = buildTemplate(t.key, nid)!.map((e) => createElement(e as any, nid));
      expect(els.length, t.key).toBeGreaterThan(3);
    }
  });

  it('turns workflows into diagrams and flowcharts into draft steps', () => {
    const g = workflowGraph({ trigger: { type: 'form.submitted' }, steps: [{ type: 'send_email', subject: 'Willkommen' }, { type: 'if', then: [{ type: 'add_tag', tags: ['heiß'] }], else: [] }, { type: 'wait', amount: 2, unit: 'days' }] });
    expect(g.nodes[0].label).toBe('Auslöser: Formular ausgefüllt');
    expect(g.nodes.map((x) => x.label)).toEqual(expect.arrayContaining(['E-Mail senden: Willkommen', 'Wenn / Sonst', 'Tag hinzufügen: heiß', 'Warten: 2 Tage']));
    expect(g.edges.filter((e) => e.label === 'Nein')).toHaveLength(1);
    const els = mermaidToElements('flowchart LR\n A([Formular ausgefüllt]) --> B[Willkommens-E-Mail senden] --> C[Warte 2 Tage] --> D{Antwort?}\n D -->|Ja| E[Anrufen]\n D -->|Nein| F[SMS senden]', nid).elements;
    const wf = flowchartToWorkflow(els);
    expect(wf.trigger.type).toBe('form.submitted');
    expect(wf.steps.map((s) => s.type)).toEqual(['send_email', 'wait', 'if']);
    expect(wf.steps[1]).toMatchObject({ amount: 2, unit: 'days' });
    expect(wf.steps[2].then[0].type).toBe('create_task');
    expect(wf.steps[2].else[0].type).toBe('send_sms');
  });
});

// --- API --------------------------------------------------------------------------------------------------------

describe('canvas API', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let loc = '';
  let other = '';
  let admin: Call;
  let memberCookie = '';
  let member: Call;
  let viewerMember: Call;
  let noCanvas: Call;
  let memberId = '';
  let key = '';
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`offline in tests: ${url}`);
      return realFetch(input, init);
    }) as typeof fetch;
    t = await startTestApp();
    await t.setup();
    loc = t.api.location;
    other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
    admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': loc });
    const mkUser = async (email: string, permissions: string[] | null) => {
      const u = await t.api.post('/api/users', { email, name: email.split('@')[0], password: 'geheim-12345', role: 'member', locations: [loc], permissions });
      expect(u.status).toBe(200);
      const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
      expect((await c('POST', '/api/auth/login', { email, password: 'geheim-12345' })).status).toBe(200);
      return { c, id: u.data.id };
    };
    const m = await mkUser('maria@example.com', ['canvas', 'contacts']);
    member = m.c;
    memberId = m.id;
    memberCookie = member.cookie();
    viewerMember = (await mkUser('vera@example.com', ['canvas'])).c;
    noCanvas = (await mkUser('nina@example.com', ['contacts'])).c;
    key = (await t.api.post('/api/api-keys', { name: 'Claude' })).data.key;
  }, 60_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await t?.close();
  });

  it('maps its routes to the canvas area', () => {
    expect(requiredPermission('GET', '/api/canvas')).toBe('canvas');
    expect(requiredPermission('POST', '/api/canvas/abc/ops')).toBe('canvas');
  });

  it('creates boards, applies operations with versions and reports conflicts', async () => {
    const b = await admin('POST', '/api/canvas', { name: 'Planung', template: 'flowchart' });
    expect(b.status).toBe(200);
    expect(b.data.element_count).toBeGreaterThan(5);
    const id = b.data.id;
    let r = await admin('POST', `/api/canvas/${id}/ops`, { clientId: 'client-a-1', ops: [{ op: 'add', element: { id: 'n1', type: 'sticky', x: 10, y: 20, text: 'Idee' } }] });
    expect(r.status).toBe(200);
    expect(r.data.results).toEqual([{ id: 'n1', status: 'ok', version: 1 }]);
    const seq1 = r.data.seq;
    // two people change different fields of the same element: both survive (field-level merge)
    r = await admin('POST', `/api/canvas/${id}/ops`, { ops: [{ op: 'update', id: 'n1', props: { x: 100 }, baseVersion: 1 }] });
    expect(r.data.results[0]).toEqual({ id: 'n1', status: 'ok', version: 2 });
    r = await admin('POST', `/api/canvas/${id}/ops`, { ops: [{ op: 'update', id: 'n1', props: { text: 'Neue Idee' }, baseVersion: 1 }] });
    expect(r.data.results[0]).toMatchObject({ status: 'conflict', version: 3 });
    expect(r.data.current[0]).toMatchObject({ id: 'n1', x: 100, text: 'Neue Idee', version: 3 });
    // compare-and-set refuses stale writes
    r = await admin('POST', `/api/canvas/${id}/ops`, { strict: true, ops: [{ op: 'update', id: 'n1', props: { x: 5 }, baseVersion: 2 }] });
    expect(r.data.results[0]).toMatchObject({ status: 'rejected', version: 3 });
    // tombstones: a late update does not bring a deleted element back, an add (undo) does
    r = await admin('POST', `/api/canvas/${id}/ops`, { ops: [{ op: 'delete', id: 'n1' }] });
    expect(r.data.results[0]).toMatchObject({ status: 'ok', version: 4 });
    r = await admin('POST', `/api/canvas/${id}/ops`, { ops: [{ op: 'update', id: 'n1', props: { x: 1 } }, { op: 'update', id: 'nope', props: {} }, { op: 'add', element: { type: 'banana' } }] });
    expect(r.data.results.map((x: any) => x.status)).toEqual(['deleted', 'missing', 'error']);
    r = await admin('POST', `/api/canvas/${id}/ops`, { ops: [{ op: 'add', element: { id: 'n1', type: 'sticky', text: 'zurück' } }] });
    expect(r.data.results[0]).toMatchObject({ status: 'ok', version: 5 });
    // locked elements only change when unlocked
    await admin('POST', `/api/canvas/${id}/ops`, { ops: [{ op: 'update', id: 'n1', props: { locked: true } }] });
    r = await admin('POST', `/api/canvas/${id}/ops`, { ops: [{ op: 'update', id: 'n1', props: { x: 999 } }] });
    expect(r.data.results[0].status).toBe('locked');
    // catch-up after a reconnect
    const ch = await admin('GET', `/api/canvas/${id}/changes?since=${seq1}`);
    expect(ch.data.seq).toBeGreaterThan(seq1);
    expect(ch.data.elements.find((e: any) => e.id === 'n1')).toMatchObject({ text: 'zurück', locked: true });
    const full = await admin('GET', `/api/canvas/${id}?outline=1&svg=1`);
    expect(full.data.outline).toContain('Notiz "zurück" [n1]');
    expect(full.data.svg).toMatch(/^<svg /);
    expect(full.data.access).toBe('owner');
  });

  it('agent helpers place elements by reference, bind arrows and lay them out', async () => {
    const b = (await admin('POST', '/api/canvas', { name: 'Agent' })).data;
    const r = await admin('POST', `/api/canvas/${b.id}/elements`, {
      elements: [
        { ref: 'start', type: 'ellipse', text: 'Start' },
        { ref: 'mid', type: 'rect', text: 'Prüfen' },
        { ref: 'end', type: 'rect', text: 'Fertig' },
        { type: 'arrow', from: 'start', to: 'mid' },
        { type: 'arrow', from: 'mid', to: 'end', text: 'ok' },
        { ref: 'note', type: 'sticky', text: 'Hinweis', at: { below: 'mid', gap: 40 } },
      ],
      layout: { kind: 'flow', direction: 'right' },
    });
    expect(r.status).toBe(200);
    expect(Object.keys(r.data.refs)).toEqual(['start', 'mid', 'end', 'note']);
    const els: CanvasElement[] = (await admin('GET', `/api/canvas/${b.id}`)).data.elements;
    const get = (ref: string) => els.find((e) => e.id === r.data.refs[ref])!;
    expect(get('mid').x).toBeGreaterThan(get('start').x);
    expect(get('end').x).toBeGreaterThan(get('mid').x);
    expect(get('note').y).toBeGreaterThanOrEqual(get('mid').y + get('mid').h);
    const arrows = els.filter((e) => e.type === 'arrow');
    expect(arrows.map((a) => [a.start?.id, a.end?.id])).toEqual(expect.arrayContaining([[get('start').id, get('mid').id]]));
    expect((await admin('POST', `/api/canvas/${b.id}/elements`, { elements: [{ type: 'arrow', from: 'ghost', to: 'start' }] })).status).toBe(400);
    // layout of new nodes/edges and of existing elements
    const lay = await admin('POST', `/api/canvas/${b.id}/layout`, { kind: 'mindmap', nodes: [{ id: 'r', label: 'Thema' }, { id: 'a', label: 'Ast A' }, { id: 'b', label: 'Ast B' }], edges: [{ from: 'r', to: 'a' }, { from: 'r', to: 'b' }] });
    expect(lay.status).toBe(200);
    expect(Object.keys(lay.data.ids)).toEqual(['r', 'a', 'b']);
    const relayout = await admin('POST', `/api/canvas/${b.id}/layout`, { kind: 'tree', ids: [get('start').id, get('mid').id, get('end').id] });
    expect(relayout.data.changed).toBeGreaterThan(2);
    const mm = await admin('POST', `/api/canvas/${b.id}/mermaid`, { source: 'graph LR\n X --> Y' });
    expect(mm.data).toMatchObject({ kind: 'flowchart' });
    expect((await admin('POST', `/api/canvas/${b.id}/mermaid`, { source: 'gantt\n x' })).status).toBe(400);
  });

  it('shares boards: team access, private boards, members, read-only, other areas', async () => {
    const team = (await admin('POST', '/api/canvas', { name: 'Team-Board' })).data;
    const priv = (await admin('POST', '/api/canvas', { name: 'Privat', team_access: 'none' })).data;
    const ro = (await admin('POST', '/api/canvas', { name: 'Nur lesen', team_access: 'view' })).data;
    const list = await member('GET', '/api/canvas');
    expect(list.status).toBe(200);
    const names = list.data.boards.map((x: any) => x.name);
    expect(names).toContain('Team-Board');
    expect(names).not.toContain('Privat');
    expect((await member('GET', `/api/canvas/${priv.id}`)).status).toBe(404);
    expect((await member('POST', `/api/canvas/${priv.id}/ops`, { ops: [] })).status).toBe(404);
    // read-only board
    expect((await member('GET', `/api/canvas/${ro.id}`)).data.access).toBe('view');
    const w = await member('POST', `/api/canvas/${ro.id}/ops`, { ops: [{ op: 'add', element: { type: 'sticky' } }] });
    expect(w.status).toBe(403);
    // the owner adds the member personally
    expect((await member('PUT', `/api/canvas/${priv.id}/members`, { user_id: memberId, role: 'edit' })).status).toBe(404);
    expect((await admin('PUT', `/api/canvas/${priv.id}/members`, { user_id: memberId, role: 'view' })).status).toBe(200);
    expect((await member('GET', `/api/canvas/${priv.id}`)).data.access).toBe('view');
    expect((await viewerMember('GET', `/api/canvas/${priv.id}`)).status).toBe(404);
    // members can't change sharing or delete someone else's board
    expect((await member('PATCH', `/api/canvas/${team.id}`, { team_access: 'none' })).status).toBe(403);
    expect((await member('DELETE', `/api/canvas/${team.id}`)).status).toBe(403);
    // a login without the canvas area sees nothing
    expect((await noCanvas('GET', '/api/canvas')).status).toBe(403);
    // a member's own board: owner rights
    const mine = (await member('POST', '/api/canvas', { name: 'Marias Board', team_access: 'none' })).data;
    expect(mine.access).toBe('owner');
    expect((await viewerMember('GET', `/api/canvas/${mine.id}`)).status).toBe(404);
    expect((await admin('GET', `/api/canvas/${mine.id}`)).data.access).toBe('owner');
  });

  it('isolates sub-accounts (session, API key and MCP)', async () => {
    const foreign = (await admin('POST', '/api/canvas', { name: 'Fremd' }, { 'x-location-id': other })).data;
    expect(foreign.id).toBeTruthy();
    expect((await admin('GET', `/api/canvas/${foreign.id}`)).status).toBe(404);
    expect((await admin('POST', `/api/canvas/${foreign.id}/ops`, { ops: [{ op: 'delete', id: 'x' }] })).status).toBe(404);
    expect((await member('GET', '/api/canvas', undefined, { 'x-location-id': other })).status).toBe(403);
    const k = client(t.base, { authorization: `Bearer ${key}` });
    expect((await k('GET', `/api/canvas/${foreign.id}`)).status).toBe(404);
    expect((await k('GET', `/api/canvas/${foreign.id}`, undefined, { 'x-location-id': other })).status).toBe(404);
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const r = await realFetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      return (await r.json()).result;
    };
    const cross = await rpc('ghl_canvas_get', { location_id: other, board_id: foreign.id });
    expect(cross.isError).toBe(true);
    const own = await rpc('ghl_canvas_get', { location_id: loc, board_id: foreign.id });
    expect(own.isError).toBe(true);
    expect(own.content[0].text).toMatch(/404/);
    // the board of the other sub-account is untouched
    expect((await admin('GET', `/api/canvas/${foreign.id}`, undefined, { 'x-location-id': other })).data.elements).toEqual([]);
  });

  it('public links are read-only, hide CRM data and can be revoked', async () => {
    const c = await admin('POST', '/api/contacts', { first_name: 'Paula', last_name: 'Geheim', email: 'paula@example.com' });
    const contactId = c.data.id ?? c.data.contact?.id;
    const b = (await admin('POST', '/api/canvas', { name: 'Öffentlich <b>', elements: [{ type: 'sticky', text: 'Sichtbar' }, { type: 'card', card: { kind: 'contact', id: contactId } }] })).data;
    expect((await member('POST', `/api/canvas/${b.id}/shares`, {})).status).toBe(403);
    const s = await admin('POST', `/api/canvas/${b.id}/shares`, { label: 'Kunde' });
    expect(s.status).toBe(200);
    const tok = s.data.url.split('/canvas/s/')[1];
    expect(tok.length).toBeGreaterThanOrEqual(32);
    expect(t.app.db.get('SELECT token_hash FROM canvas_shares WHERE id = ?', s.data.id).token_hash).not.toContain(tok);
    const page = await realFetch(`${t.base}/canvas/s/${tok}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Sichtbar');
    expect(html).toContain('Öffentlich &lt;b&gt;');
    expect(html).not.toContain('Paula');
    expect(html).not.toContain('paula@example.com');
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'sha256-/);
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    const json = await realFetch(`${t.base}/api/public/canvas/${tok}`).then((r) => r.json());
    expect(json.svg).toContain('Sichtbar');
    const same = await realFetch(`${t.base}/api/public/canvas/${tok}?seq=${json.seq}`).then((r) => r.json());
    expect(same.unchanged).toBe(true);
    // no writes through the link
    expect((await realFetch(`${t.base}/canvas/s/${tok}`, { method: 'POST' })).status).toBe(404);
    expect((await realFetch(`${t.base}/api/public/canvas/${tok}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    expect((await realFetch(`${t.base}/canvas/s/${tok.slice(0, -2)}xx`)).status).toBe(404);
    // revoke
    expect((await admin('DELETE', `/api/canvas/${b.id}/shares/${s.data.id}`)).status).toBe(200);
    expect((await realFetch(`${t.base}/canvas/s/${tok}`)).status).toBe(404);
    expect((await realFetch(`${t.base}/api/public/canvas/${tok}`)).status).toBe(404);
    const shares = await admin('GET', `/api/canvas/${b.id}/shares`);
    expect(shares.data[0]).toMatchObject({ url: null });
    expect(shares.data[0].revoked_at).toBeTruthy();
  });

  it('resolves live CRM cards with the viewer’s rights', async () => {
    const c = await admin('POST', '/api/contacts', { first_name: 'Karl', last_name: 'Kunde', email: 'karl@example.com', tags: ['vip'] });
    const contactId = c.data.id ?? c.data.contact?.id;
    const foreignContact = await admin('POST', '/api/contacts', { first_name: 'Fritz', email: 'fritz@example.com' }, { 'x-location-id': other });
    const fid = foreignContact.data.id ?? foreignContact.data.contact?.id;
    const pipe = (await admin('GET', '/api/pipelines')).data[0];
    const deal = await admin('POST', '/api/opportunities', { pipeline_id: pipe.id, contact_id: contactId, name: 'Großauftrag', value: 12000 });
    const b = (await admin('POST', '/api/canvas', { name: 'CRM' })).data;
    const refs = [{ kind: 'contact', id: contactId }, { kind: 'deal', id: deal.data.id }, { kind: 'pipeline', id: pipe.id }, { kind: 'contact', id: fid }, { kind: 'project', id: 'current' }];
    const r = await admin('POST', `/api/canvas/${b.id}/cards`, { refs });
    expect(r.data.cards[`contact:${contactId}`]).toMatchObject({ ok: true, title: 'Karl Kunde', url: `/app/contacts/${contactId}` });
    expect(r.data.cards[`deal:${deal.data.id}`]).toMatchObject({ ok: true, title: 'Großauftrag' });
    expect(r.data.cards[`pipeline:${pipe.id}`].stages.some((s: any) => s.deals.some((d: any) => d.name === 'Großauftrag'))).toBe(true);
    expect(r.data.cards[`contact:${fid}`]).toMatchObject({ ok: false });
    expect(JSON.stringify(r.data)).not.toContain('fritz@example.com');
    expect(r.data.cards['project:current'].ok).toBe(true);
    // the member may see contacts but not opportunities
    const m = await member('POST', `/api/canvas/${b.id}/cards`, { refs });
    expect(m.data.cards[`contact:${contactId}`].ok).toBe(true);
    expect(m.data.cards[`deal:${deal.data.id}`]).toEqual({ ok: false, error: 'Kein Zugriff auf diesen Bereich' });
    expect(JSON.stringify(m.data.cards[`pipeline:${pipe.id}`])).not.toContain('Großauftrag');
    // a contacts-less login on the same board gets no contact data either
    const v = await viewerMember('POST', `/api/canvas/${b.id}/cards`, { refs });
    expect(v.data.cards[`contact:${contactId}`].ok).toBe(false);
    expect(JSON.stringify(v.data)).not.toContain('karl@example.com');
  });

  it('turns sticky notes into tasks/deals, workflows into diagrams and frames into funnel pages', async () => {
    const b = (await admin('POST', '/api/canvas', { name: 'Integration', elements: [{ id: 's1', type: 'sticky', text: 'Angebot nachfassen\nbis Freitag' }, { id: 's2', type: 'sticky', text: 'Webshop-Relaunch 8.000 €' }] })).data;
    const task = await admin('POST', `/api/canvas/${b.id}/convert`, { element_ids: ['s1'], to: 'task' });
    expect(task.status).toBe(200);
    expect(task.data.created[0]).toMatchObject({ kind: 'task', title: 'Angebot nachfassen' });
    const tasks = (await admin('GET', '/api/tasks')).data;
    expect((Array.isArray(tasks) ? tasks : tasks.tasks).some((x: any) => x.title === 'Angebot nachfassen')).toBe(true);
    let els: CanvasElement[] = (await admin('GET', `/api/canvas/${b.id}`)).data.elements;
    expect(els.find((e) => e.id === 's1')).toBeUndefined();
    expect(els.find((e) => e.type === 'card' && e.card?.kind === 'task')).toBeTruthy();
    const pipe = (await admin('GET', '/api/pipelines')).data[0];
    expect((await admin('POST', `/api/canvas/${b.id}/convert`, { element_ids: ['s2'], to: 'deal', pipeline_id: pipe.id })).status).toBe(400);
    const deal = await admin('POST', `/api/canvas/${b.id}/convert`, { element_ids: ['s2'], to: 'deal', pipeline_id: pipe.id, create_contact: true });
    expect(deal.status).toBe(200);
    const opps = (await admin('GET', `/api/opportunities?pipeline_id=${pipe.id}`)).data;
    expect((Array.isArray(opps) ? opps : opps.opportunities).find((o: any) => o.name === 'Webshop-Relaunch 8.000 €')?.value).toBe(8000);
    // the member without the opportunities area can't create deals through the canvas
    const own = (await member('POST', '/api/canvas', { name: 'M', elements: [{ id: 'x1', type: 'sticky', text: 'Deal' }] })).data;
    expect((await member('POST', `/api/canvas/${own.id}/convert`, { element_ids: ['x1'], to: 'deal', pipeline_id: pipe.id, create_contact: true })).status).toBe(403);
    // workflow → diagram
    const wf = await admin('POST', '/api/workflows', { name: 'Lead-Pflege', trigger: { type: 'form.submitted', config: {} }, steps: [{ type: 'send_email', subject: 'Hallo', body: 'x' }, { type: 'wait', amount: 1, unit: 'days' }] });
    const dia = await admin('POST', `/api/canvas/${b.id}/workflow-diagram`, { workflow_id: wf.data.id });
    expect(dia.status).toBe(200);
    els = (await admin('GET', `/api/canvas/${b.id}`)).data.elements;
    const frame = els.find((e) => e.id === dia.data.frame_id)!;
    expect(frame).toMatchObject({ type: 'frame', name: 'Workflow: Lead-Pflege', link: `/app/workflows/${wf.data.id}` });
    expect(els.some((e) => e.text === 'E-Mail senden: Hallo' && e.frameId === frame.id)).toBe(true);
    // flowchart → draft workflow
    const fc = (await admin('POST', '/api/canvas', { name: 'Ablauf', mermaid: 'flowchart LR\n A([Termin gebucht]) --> B[Bestätigungs-E-Mail] --> C[Warte 1 Tag] --> D[Anrufen]' })).data;
    const draft = await admin('POST', `/api/canvas/${fc.id}/workflow-draft`, {});
    expect(draft.status).toBe(200);
    const created = (await admin('GET', `/api/workflows/${draft.data.workflow_id}`)).data;
    expect(created).toMatchObject({ status: 'draft', trigger: { type: 'appointment.booked' } });
    expect(created.steps.map((s: any) => s.type)).toEqual(['send_email', 'wait', 'create_task']);
    // frames → funnel pages
    const fb = (await admin('POST', '/api/canvas', { name: 'Funnel', template: 'funnel' })).data;
    const pages = await admin('POST', `/api/canvas/${fb.id}/funnel-pages`, { funnel_name: 'Leadmagnet' });
    expect(pages.status).toBe(200);
    expect(pages.data.pages.map((p: any) => p.name)).toEqual(['Opt-in', 'Danke', 'Angebot', 'Bestätigung']);
    const funnel = (await admin('GET', `/api/funnels/${pages.data.funnel_id}`)).data;
    expect(funnel.pages.map((p: any) => p.name)).toEqual(['Opt-in', 'Danke', 'Angebot', 'Bestätigung']);
    expect(funnel.pages[0].blocks.some((x: any) => x.type === 'button' && x.text === 'Jetzt kostenlos sichern')).toBe(true);
  });

  it('draws with the AI assistant (structured output, mocked)', async () => {
    const b = (await admin('POST', '/api/canvas', { name: 'KI' })).data;
    const calls: any[] = [];
    const prev = t.app.services.aiRun;
    t.app.services.aiRun = async (input: any) => {
      calls.push(input);
      if (input.schema?.properties?.nodes)
        return { text: JSON.stringify({ title: 'Onboarding', kind: 'flowchart', direction: 'right', nodes: [{ id: 'a', label: 'Vertrag', shape: 'ellipse', color: 'green', group: '' }, { id: 'b', label: 'Kick-off', shape: 'rect', color: 'blue', group: '' }, { id: 'c', label: 'Zufrieden?', shape: 'diamond', color: 'yellow', group: '' }], edges: [{ from: 'a', to: 'b', label: '' }, { from: 'b', to: 'c', label: '' }, { from: 'c', to: 'a', label: 'Nein' }], groups: [], screens: [], summary: 'Onboarding-Ablauf' }) };
      if (input.schema?.properties?.bullets) return { text: JSON.stringify({ summary: 'Ein Ablauf in drei Schritten.', bullets: ['Vertrag', 'Kick-off'] }) };
      return { text: JSON.stringify({ tasks: [{ title: 'Kick-off planen', description: 'Termin finden', due_in_days: 2 }, { title: 'Vertrag prüfen', description: '', due_in_days: -1 }] }) };
    };
    try {
      const d = await admin('POST', `/api/canvas/${b.id}/ai`, { mode: 'draw', prompt: 'Onboarding für Neukunden', kind: 'flowchart' });
      expect(d.status).toBe(200);
      expect(calls[0]).toMatchObject({ purpose: 'canvas', locationId: loc });
      expect(calls[0].user).toContain('Onboarding für Neukunden');
      let els: CanvasElement[] = (await admin('GET', `/api/canvas/${b.id}`)).data.elements;
      expect(els.some((e) => e.type === 'diamond' && e.text === 'Zufrieden?')).toBe(true);
      expect(els.filter((e) => e.type === 'arrow')).toHaveLength(3);
      expect(els.some((e) => e.type === 'text' && e.text === 'Onboarding')).toBe(true);
      const ids = els.filter((e) => e.type !== 'arrow').map((e) => e.id);
      const ex = await admin('POST', `/api/canvas/${b.id}/ai`, { mode: 'explain', ids });
      expect(ex.data.text).toContain('• Kick-off');
      expect(calls[1].user).toContain('Zufrieden?');
      const tk = await admin('POST', `/api/canvas/${b.id}/ai`, { mode: 'tasks', ids });
      expect(tk.data.tasks.map((x: any) => x.title)).toEqual(['Kick-off planen', 'Vertrag prüfen']);
      els = (await admin('GET', `/api/canvas/${b.id}`)).data.elements;
      expect(els.filter((e) => e.type === 'card' && e.card?.kind === 'task')).toHaveLength(2);
      const tidy = await admin('POST', `/api/canvas/${b.id}/ai`, { mode: 'tidy' });
      expect(tidy.status).toBe(200);
      expect(calls).toHaveLength(3); // tidy needs no AI call
      // read-only boards can't be drawn on
      const ro = (await admin('POST', '/api/canvas', { name: 'RO', team_access: 'view' })).data;
      expect((await member('POST', `/api/canvas/${ro.id}/ai`, { mode: 'draw', prompt: 'x' })).status).toBe(403);
    } finally {
      t.app.services.aiRun = prev;
    }
  });

  it('broadcasts changes and presence over SSE (with an agent cursor)', async () => {
    const b = (await admin('POST', '/api/canvas', { name: 'Live' })).data;
    const ctrl = new AbortController();
    const res = await realFetch(`${t.base}/api/canvas/${b.id}/stream?clientId=viewer-123&locationId=${loc}`, { headers: { cookie: memberCookie }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = async (re: RegExp) => {
      const end = Date.now() + 5000;
      while (!re.test(buf) && Date.now() < end) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
      return re.test(buf);
    };
    try {
      expect(await until(/event: hello/)).toBe(true);
      await admin('POST', `/api/canvas/${b.id}/ops`, { clientId: 'editor-456', ops: [{ op: 'add', element: { id: 'live1', type: 'rect', text: 'Neu von Chef' } }] });
      expect(await until(/event: ops\ndata: .*"live1"/)).toBe(true);
      expect(buf).toMatch(/"actor":\{"name":"Chef","kind":"user"\}/);
      await admin('POST', `/api/canvas/${b.id}/presence`, { clientId: 'editor-456', x: 10, y: 20, sel: ['live1'] });
      expect(await until(/event: presence\ndata: .*"editor-456"/)).toBe(true);
      // an MCP agent draws: everyone watching sees its cursor
      const r = await realFetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_canvas_add_elements', arguments: { location_id: loc, board_id: b.id, elements: [{ type: 'sticky', text: 'Vom Agenten' }] } } }) });
      expect((await r.json()).result.isError).toBe(false);
      expect(await until(/"kind":"agent"/)).toBe(true);
      expect(buf).toContain('API: Claude');
      // the editor's own changes are not echoed back to it
      expect(buf).not.toMatch(/"clientId":"viewer-123"[^\n]*"elements"/);
    } finally {
      ctrl.abort();
      await reader.cancel().catch(() => {});
    }
  });

  it('ends a person’s stream with their login and their access; a key’s stream keeps its own rules', async () => {
    const hub = t.app.services.canvasHub;
    const b = (await admin('POST', '/api/canvas', { name: 'Live mit Anmeldung' })).data;
    const vera = t.app.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', 'vera@example.com')!.id;
    const again = () => loginAgain(t.base, loc, 'vera@example.com', 'geheim-12345');
    const url = (clientId: string) => `${t.base}/api/canvas/${b.id}/stream?clientId=${clientId}&locationId=${loc}`;
    const open = async (c: { cookie: () => string }, clientId: string) => {
      const s = await openSse(url(clientId), { cookie: c.cookie() });
      expect(await s.until(/event: hello/)).toBe(true);
      return s;
    };
    const bot = await openSse(url('key-stream-1'), { authorization: `Bearer ${key}` });
    expect(await bot.until(/event: hello/)).toBe(true);
    // signed out in another tab of the same browser: the stream ends at once, with `bye` (the browser does not reconnect)
    const second = await again();
    const s1 = await open(second, 'vera-login-1');
    expect((await second('POST', '/api/auth/logout')).status).toBe(200);
    expect(await s1.until(BYE)).toBe(true);
    expect(await s1.ends()).toBe(true);
    // a password set by the admin (lost or leaked) signs the person out everywhere – and ends the stream
    const third = await again();
    const s2 = await open(third, 'vera-login-2');
    expect((await admin('PATCH', `/api/users/${vera}`, { password: 'geheim-12345' })).status).toBe(200);
    expect(await s2.until(BYE)).toBe(true);
    // a session that ran out: the next check (every 20 s) ends its stream
    const fourth = await again();
    const s3 = await open(fourth, 'vera-login-3');
    expireSession(t.app.db, fourth.cookie());
    hub.sweep();
    expect(await s3.until(BYE)).toBe(true);
    // access taken away (the board made private): the next check ends the stream too
    const fifth = await again();
    const s4 = await open(fifth, 'vera-login-4');
    expect((await admin('PATCH', `/api/canvas/${b.id}`, { team_access: 'none' })).status).toBe(200);
    hub.sweep();
    expect(await s4.until(BYE)).toBe(true);
    // a key is not a person's login: its stream stays and still gets the changes; the ended ones get nothing more
    expect(await bot.quiet(/event: bye/)).toBe(true);
    await admin('POST', `/api/canvas/${b.id}/ops`, { clientId: 'editor-789', ops: [{ op: 'add', element: { id: 'after1', type: 'rect', text: 'Danach' } }] });
    expect(await bot.until(/event: ops\ndata: .*"after1"/)).toBe(true);
    for (const s of [s1, s2, s3, s4]) expect(s.text()).not.toContain('after1');
    for (const s of [bot, s1, s2, s3, s4]) await s.close();
  });

  it('MCP tools cover listing, drawing, layout, Mermaid, export and comments', async () => {
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const r = await realFetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return (await r.json()).result;
    };
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await rpc('tools/call', { name, arguments: { location_id: loc, ...args } });
      expect(r.isError, `${name}: ${r.content?.[0]?.text}`).toBe(false);
      return r.structuredContent;
    };
    const tools = (await rpc('tools/list')).tools.map((x: any) => x.name);
    expect(tools).toEqual(expect.arrayContaining(['ghl_canvas_list', 'ghl_canvas_create', 'ghl_canvas_get', 'ghl_canvas_add_elements', 'ghl_canvas_update_elements', 'ghl_canvas_delete_elements', 'ghl_canvas_layout', 'ghl_canvas_from_mermaid', 'ghl_canvas_export', 'ghl_canvas_comment']));
    const created = await call('ghl_canvas_create', { name: 'Von Claude', template: 'swot' });
    expect(created.board_id).toBeTruthy();
    const board = created.board_id;
    const add = await call('ghl_canvas_add_elements', { board_id: board, elements: [{ ref: 'a', type: 'rect', text: 'A' }, { ref: 'b', type: 'rect', text: 'B', at: { right_of: 'a' } }, { type: 'arrow', from: 'a', to: 'b' }] });
    expect(Object.keys(add.refs)).toEqual(['a', 'b']);
    // results link to the board (and to what was just drawn), for the in-app agent's tool cards
    expect(created.link).toBe(`/app/canvas/${board}`);
    expect(add.link).toBe(`/app/canvas/${board}?focus=${add.created.join('%2C')}`);
    const got = await call('ghl_canvas_get', { board_id: board, include: ['json', 'outline', 'svg'] });
    const a = got.elements.find((e: any) => e.id === add.refs.a);
    expect(a.version).toBe(1);
    expect(got.outline).toContain('Stärken');
    expect(got.svg).toMatch(/^<svg/);
    const upd = await call('ghl_canvas_update_elements', { board_id: board, updates: [{ id: add.refs.a, text: 'A2', fill: '#a5d8ff', base_version: 1 }] });
    expect(upd.results[0]).toMatchObject({ status: 'ok', version: 2 });
    const stale = await call('ghl_canvas_update_elements', { board_id: board, strict: true, updates: [{ id: add.refs.a, text: 'alt', base_version: 1 }] });
    expect(stale.results[0].status).toBe('rejected');
    const lay = await call('ghl_canvas_layout', { board_id: board, kind: 'tree', nodes: [{ id: 'chef', label: 'Chef' }, { id: 'x', label: 'X' }], edges: [{ from: 'chef', to: 'x' }] });
    expect(lay.ids.chef).toBeTruthy();
    const mm = await call('ghl_canvas_from_mermaid', { mermaid: 'mindmap\n  root((Q4))\n    Leads\n    Umsatz', name: 'Mindmap' });
    expect(mm.board_id).toBeTruthy();
    const mm2 = await call('ghl_canvas_from_mermaid', { board_id: board, mermaid: 'graph TD\n P --> Q' });
    expect(mm2.kind).toBe('flowchart');
    const del = await call('ghl_canvas_delete_elements', { board_id: board, ids: [add.refs.b] });
    expect(del.results[0].status).toBe('ok');
    for (const format of ['png', 'svg', 'pdf'] as const) {
      const ex = await call('ghl_canvas_export', { board_id: board, format, scale: 1 });
      expect(ex.url).toMatch(new RegExp(`/uploads/[A-Za-z0-9]+\\.${format}$`));
      const file = join(t.app.config.dataDir, 'uploads', ex.src.split('/').pop());
      expect(existsSync(file)).toBe(true);
      const head = readFileSync(file).subarray(0, 8);
      if (format === 'png') expect(head[1]).toBe(0x50);
      if (format === 'pdf') expect(head.toString('latin1')).toBe('%PDF-1.4');
      if (format === 'svg') expect(head.toString('latin1')).toBe('<svg xml');
    }
    const com = await call('ghl_canvas_comment', { board_id: board, element_id: add.refs.a, body: 'Bitte prüfen @maria' });
    expect(com.mentions).toEqual([memberId]);
    expect(com.notified).toBe(1);
    // the member got a notification (push log) and sees the mention
    expect(t.app.db.get(`SELECT kind, title FROM push_log WHERE user_id = ? AND kind = 'canvas'`, memberId)).toMatchObject({ title: expect.stringContaining('erwähnt') });
    expect((await member('GET', '/api/canvas/mentions')).data[0]).toMatchObject({ board_id: board, body: 'Bitte prüfen @maria' });
    const list = await call('ghl_canvas_list', {});
    expect(list.boards.some((x: any) => x.id === board)).toBe(true);
    // the audit log names the key
    expect(t.app.db.get(`SELECT via, action FROM audit_log WHERE entity_id = ? AND via = 'mcp' LIMIT 1`, board)).toBeTruthy();
  });

  it('keeps versions (snapshots) and restores them', async () => {
    const b = (await admin('POST', '/api/canvas', { name: 'Versionen', elements: [{ id: 'v1', type: 'rect', text: 'Original' }] })).data;
    const snap = await admin('POST', `/api/canvas/${b.id}/snapshots`, { name: 'Vorher' });
    expect(snap.data.element_count).toBe(1);
    await admin('POST', `/api/canvas/${b.id}/ops`, { ops: [{ op: 'update', id: 'v1', props: { text: 'Kaputt' } }, { op: 'add', element: { id: 'v2', type: 'sticky' } }] });
    const r = await admin('POST', `/api/canvas/${b.id}/snapshots/${snap.data.id}/restore`, {});
    expect(r.status).toBe(200);
    const els: CanvasElement[] = (await admin('GET', `/api/canvas/${b.id}`)).data.elements;
    expect(els.map((e) => [e.id, e.text])).toEqual([['v1', 'Original']]);
    const list = (await admin('GET', `/api/canvas/${b.id}/snapshots`)).data;
    expect(list.map((s: any) => s.name)).toEqual(expect.arrayContaining(['Vorher', 'Vor Wiederherstellung von „Vorher“']));
    const svg = await admin('GET', `/api/canvas/${b.id}/snapshots/${snap.data.id}/svg`);
    expect(svg.text).toContain('Original');
  });

  it('uploads images with the media checks', async () => {
    const b = (await admin('POST', '/api/canvas', { name: 'Bilder' })).data;
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const up = await admin('POST', `/api/canvas/${b.id}/media`, { name: 'pixel.png', data: png });
    expect(up.status).toBe(200);
    expect(up.data).toMatchObject({ w: 1, h: 1, mime: 'image/png' });
    expect((await admin('POST', `/api/canvas/${b.id}/media`, { name: 'x.svg', data: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).status).toBe(400);
    expect((await admin('POST', `/api/canvas/${b.id}/media`, { name: 'x.png', data: 'data:image/png;base64,PGh0bWw+' })).status).toBe(400);
    const add = await admin('POST', `/api/canvas/${b.id}/ops`, { ops: [{ op: 'add', element: { type: 'image', src: up.data.src, w: 100, h: 100 } }] });
    expect(add.data.results[0].status).toBe('ok');
    const media = await admin('GET', '/api/canvas/media');
    expect(media.data.some((m: any) => m.src === up.data.src)).toBe(true);
    const ex = await t.api.raw(`/api/canvas/${b.id}/export?format=png&scale=1&locationId=${loc}`, { headers: { cookie: t.api.cookie } });
    expect(ex.status).toBe(200);
    expect(ex.headers.get('content-type')).toBe('image/png');
  });

  it('lets members read the Canvas guide in the academy', async () => {
    const doc = await member('GET', '/api/academy/docs/canvas');
    expect(doc.status).toBe(200);
    expect(doc.data.markdown).toContain('infinite boards');
    expect((await member('GET', '/api/academy/docs')).data).toContain('canvas');
  });

  it('serves boards to the Android app', async () => {
    const b = (await member('POST', '/api/canvas', { name: 'Mobil' })).data;
    const priv = (await admin('POST', '/api/canvas', { name: 'Chef privat', team_access: 'none' })).data;
    const tok = (await member('POST', '/api/mobile/pair', { device_name: 'Pixel' })).data.token;
    const app = client(t.base, { authorization: `Bearer ${tok}` });
    const list = await app('GET', '/api/mobile/canvases');
    expect(list.status).toBe(200);
    expect(list.data.some((x: any) => x.id === b.id && x.svg_url === `/api/mobile/canvases/${b.id}/svg`)).toBe(true);
    expect(list.data.some((x: any) => x.id === priv.id)).toBe(false);
    const svg = await app('GET', `/api/mobile/canvases/${b.id}/svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect((await app('GET', `/api/mobile/canvases/${priv.id}/svg`)).status).toBe(404);
    const foreign = (await admin('POST', '/api/canvas', { name: 'Fremd mobil' }, { 'x-location-id': other })).data;
    expect((await app('GET', `/api/mobile/canvases/${foreign.id}/svg`)).status).toBe(404);
  });
});
