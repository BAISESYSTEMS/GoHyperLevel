import { beforeAll, describe, expect, it } from 'vitest';
import { COLS, bpFor, clampCell, deriveMd, deriveSm, findSpot, hit, placeNew, reorderStack, rowsOf, settle, type Placed } from '../server/services/boards-layout.js';
import { LIMITS, cleanAccent, emptySpec, normalizeSpec, overlaps, parseSpec, cellsAt, type BoardSpec, type BoardState } from '../server/services/boards-model.js';
import { WidgetRegistry, cleanConfig, nonDefault } from '../server/services/boards-widgets.js';
import { CORE_WIDGETS, registerCoreWidgets } from '../server/services/boards-widgets-core.js';
import { DEFAULT_EMBED_HOSTS, checkEmbedUrl, cleanHost } from '../server/services/boards-embed.js';
import { applyPatch } from '../server/services/boards-patch.js';
import { CHART_PRESETS, KPI_PRESETS } from '../server/services/boards-presets.js';

const reg = new WidgetRegistry();
const fakeApp: any = { services: {}, baseUrl: () => 'http://x' };
const env = { app: fakeApp, locationId: 'L1' };
let n = 0;
const newId = () => `w${String(++n).padStart(8, '0')}`;
const base = (spec: BoardSpec = emptySpec()): BoardState => ({ name: 'Mein Board', icon: 'boards', accent: '', spec });
const patch = (state: BoardState, ops: unknown, extra: { strict?: boolean } = {}) => applyPatch(state, ops, { reg, env, newId, ...extra });
const cellsOf = (s: BoardState, bp: 'lg' | 'md' | 'sm' = 'lg') => cellsAt(s.spec, bp, (t) => reg.limits(t));

beforeAll(() => {
  registerCoreWidgets(reg);
});

describe('grid maths', () => {
  const c = (id: string, x: number, y: number, w: number, h: number): Placed => ({ id, x, y, w, h });

  it('settles: the fixed cell stays, the others rise and make room', () => {
    const cells = [c('a', 0, 0, 6, 2), c('b', 6, 0, 6, 2), c('c', 0, 5, 6, 2)];
    const r = settle(cells);
    expect(r.find((x) => x.id === 'c')).toMatchObject({ y: 2 });
    // dropping "a" onto "b": b is pushed down, a stays exactly where it was put
    const moved = settle([c('a', 6, 0, 6, 2), c('b', 6, 0, 6, 2)], 'a');
    expect(moved.find((x) => x.id === 'a')).toMatchObject({ x: 6, y: 0 });
    expect(moved.find((x) => x.id === 'b')).toMatchObject({ x: 6, y: 2 });
    for (const set of [r, moved]) expect(set.some((p, i) => set.some((q, j) => i !== j && hit(p, q)))).toBe(false);
  });

  it('settle is idempotent and keeps the input order', () => {
    const cells = [c('z', 0, 3, 4, 2), c('y', 4, 0, 4, 2), c('x', 0, 0, 4, 3)];
    const once = settle(cells);
    expect(once.map((x) => x.id)).toEqual(['z', 'y', 'x']);
    expect(settle(once)).toEqual(once);
  });

  it('clamps cells into the grid and the widget limits', () => {
    expect(clampCell({ x: 99, y: -3, w: 99, h: 0 }, 'lg', { minW: 2, minH: 2, maxW: 6, maxH: 8 })).toEqual({ x: 6, y: 0, w: 6, h: 2 });
    expect(clampCell({ x: 3, y: 2, w: 5, h: 3 }, 'sm')).toEqual({ x: 0, y: 2, w: 1, h: 3 });
    expect(clampCell({ w: 12 }, 'md').w).toBe(6);
    expect(bpFor(1200)).toBe('lg');
    expect(bpFor(700)).toBe('md');
    expect(bpFor(400)).toBe('sm');
  });

  it('places new cells: top, bottom, beside, below, above, free spot', () => {
    const cells = [c('a', 0, 0, 4, 3), c('b', 8, 0, 4, 3)];
    expect(placeNew(cells, { w: 4, h: 2 }, 'lg', 'top')).toMatchObject({ x: 0, y: 0 });
    expect(placeNew(cells, { w: 4, h: 2 }, 'lg', 'bottom')).toMatchObject({ x: 0, y: 3 });
    expect(placeNew(cells, { w: 4, h: 2 }, 'lg', { beside: 'a' })).toMatchObject({ x: 4, y: 0, w: 4 });
    // no room beside b: it goes below
    expect(placeNew(cells, { w: 4, h: 2 }, 'lg', { beside: 'b' })).toMatchObject({ x: 8, y: 3 });
    expect(placeNew(cells, { w: 4, h: 2 }, 'lg', { below: 'a' })).toMatchObject({ x: 0, y: 3 });
    expect(placeNew(cells, { w: 4, h: 2 }, 'lg', { above: 'b' })).toMatchObject({ x: 8, y: 0 });
    expect(findSpot(cells, 4, 2, 12)).toEqual({ x: 4, y: 0 });
    expect(placeNew(cells, { w: 4, h: 2 }, 'sm', 'bottom')).toEqual({ x: 0, y: 3, w: 1, h: 2 });
    expect(rowsOf(cells)).toBe(3);
  });

  it('derives the tablet and phone layouts from the desktop one', () => {
    const lg = [c('a', 0, 0, 6, 4), c('b', 6, 0, 6, 4), c('k1', 0, 4, 3, 2), c('k2', 3, 4, 3, 2)];
    const md = deriveMd(lg);
    expect(md.find((x) => x.id === 'a')).toMatchObject({ x: 0, w: 3 });
    expect(md.every((x) => x.x + x.w <= COLS.md)).toBe(true);
    expect(md.some((p, i) => md.some((q, j) => i !== j && hit(p, q)))).toBe(false);
    const sm = deriveSm(lg);
    // reading order, one column, no gaps
    expect(sm.map((x) => [x.id, x.y])).toEqual([['a', 0], ['b', 4], ['k1', 8], ['k2', 10]]);
    expect(sm.every((x) => x.x === 0 && x.w === 1)).toBe(true);
  });

  it('reorders a stack for the phone view', () => {
    const stack = deriveSm([c('a', 0, 0, 12, 2), c('b', 0, 2, 12, 3), c('c', 0, 5, 12, 2)]);
    const r = reorderStack(stack, 'c', 0);
    expect(r.map((x) => [x.id, x.y]).sort()).toEqual([['a', 2], ['b', 4], ['c', 0]]);
  });
});

describe('board model', () => {
  it('cleans accents: names, hex and nothing else', () => {
    expect(cleanAccent('blau')).toBe('#2563eb');
    expect(cleanAccent('Grün')).toBe('#16a34a');
    expect(cleanAccent('#ABCDEF')).toBe('#abcdef');
    expect(cleanAccent('')).toBe('');
    expect(cleanAccent('javascript:alert(1)')).toBeNull();
    expect(cleanAccent('#12')).toBeNull();
  });

  it('parses stored specs tolerantly and normalises to a canonical, overlap-free form', () => {
    expect(parseSpec('not json').widgets).toEqual([]);
    const bad = parseSpec(JSON.stringify({ widgets: [{ type: 'kpi', layout: { lg: { x: 99, y: 0, w: 99, h: 99 } } }, { nope: 1 }, { id: 'dup', type: 'notes', layout: { lg: { x: 0, y: 0, w: 4, h: 3 } } }] }));
    expect(bad.widgets).toHaveLength(2);
    const norm = normalizeSpec(bad, (t) => reg.limits(t));
    expect(overlaps(norm.widgets.map((w) => w.layout.lg))).toBe(false);
    expect(norm.widgets[0].layout.lg.w).toBeLessThanOrEqual(6);
    // idempotent
    expect(normalizeSpec(norm, (t) => reg.limits(t))).toEqual(norm);
    expect(norm.widgets.every((w) => w.layout.md && w.layout.sm)).toBe(true);
  });
});

describe('widget registry and config', () => {
  it('has the whole catalogue of the brief', () => {
    expect(reg.list().map((d) => d.type).sort()).toEqual(['actions', 'agenda', 'calc', 'chart', 'embed', 'inbox', 'kpi', 'list', 'notes', 'pipeline', 'plugin', 'tasks', 'wiki']);
    for (const d of CORE_WIDGETS) {
      expect(d.description.length).toBeGreaterThan(20);
      // every default config is valid for its own type
      expect(cleanConfig(d, {}, { strict: true }).errors, d.type).toEqual([]);
    }
  });

  it('rejects bad registrations and keeps the built-in types', () => {
    const r = new WidgetRegistry();
    expect(() => r.register({ type: 'Bad Type', label: 'x', description: 'y', icon: 'x', category: 'zahlen', size: { w: 2, h: 2 }, fields: [] })).toThrow(/ungültig/);
    expect(() => r.register({ type: 'ok_type', label: 'x', description: 'y', icon: 'x', category: 'nope', size: { w: 2, h: 2 }, fields: [] })).toThrow(/Kategorie/);
    expect(() => r.register({ type: 'ok_type', label: 'x', description: 'y', icon: 'x', category: 'zahlen', size: { w: 20, h: 2 }, fields: [] })).toThrow(/size/);
    expect(() => r.register({ type: 'ok_type', label: 'x', description: 'y', icon: 'x', category: 'zahlen', size: { w: 2, h: 2 }, fields: [{ key: 's', label: 'S', type: 'select' }] })).toThrow(/options/);
    r.register({ type: 'mine', label: 'Mein', description: 'Eigenes Widget', icon: 'puzzle', category: 'zahlen', size: { w: 3, h: 2 }, fields: [], source: 'my-module', data: () => ({ kind: 'number', value: 1 }) });
    // another module cannot take the type, the same one may re-register
    expect(() => r.register({ type: 'mine', label: 'Anderes', description: 'Anderes Widget', icon: 'puzzle', category: 'zahlen', size: { w: 3, h: 2 }, fields: [], source: 'other' })).toThrow(/vergeben/);
    r.register({ type: 'mine', label: 'Mein neu', description: 'Eigenes Widget', icon: 'puzzle', category: 'zahlen', size: { w: 3, h: 2 }, fields: [], source: 'my-module' });
    expect(r.get('mine')?.label).toBe('Mein neu');
    registerCoreWidgets(r);
    expect(() => r.register({ type: 'kpi', label: 'Gekapert', description: 'Gekaperte Kennzahl', icon: 'x', category: 'zahlen', size: { w: 2, h: 2 }, fields: [], source: 'my-module' })).toThrow(/vergeben/);
    expect(r.catalogue().find((d) => d.type === 'kpi')?.size).toMatchObject({ w: 3, h: 2, minW: 2, maxW: 6 });
  });

  it('coerces and checks values; strict refuses what lenient repairs', () => {
    const list = reg.get('list')!;
    const ok = cleanConfig(list, { entity: 'deals', min_value: '5000', limit: 8 }, { strict: true });
    expect(ok.errors).toEqual([]);
    expect(ok.config).toMatchObject({ entity: 'deals', min_value: 5000, status: 'open', limit: 8 });
    expect(cleanConfig(list, { entity: 'nope' }, { strict: true }).errors[0]).toMatch(/nicht erlaubt/);
    expect(cleanConfig(list, { limit: 500 }, { strict: true }).errors[0]).toMatch(/zwischen 3 und 30/);
    expect(cleanConfig(list, { limit: 500 }).config.limit).toBe(30);
    expect(cleanConfig(list, { foo: 1 }, { strict: true }).errors[0]).toMatch(/unbekanntes Feld/);
    expect(cleanConfig(list, { foo: 1 }).errors).toEqual([]);
    expect(cleanConfig(list, { pipeline_id: 'x'.repeat(200) }, { strict: true }).errors[0]).toMatch(/keine gültige ID/);
    expect(cleanConfig(reg.get('actions')!, { actions: Array.from({ length: 20 }, () => ({ label: 'x', kind: 'task' })) }, { strict: true }).errors[0]).toMatch(/höchstens 8/);
    expect(nonDefault(list, ok.config)).toEqual({ min_value: 5000 });
  });

  it('every preset points at an existing source and has a label', () => {
    for (const [k, p] of [...Object.entries(KPI_PRESETS), ...Object.entries(CHART_PRESETS)]) {
      expect(p.label.length, k).toBeGreaterThanOrEqual(3);
      expect(p.query.source, k).toBeTruthy();
      expect(p.query.measures.length, k).toBeGreaterThan(0);
    }
  });
});

describe('embed allow-list', () => {
  it('only lets https addresses of allowed hosts through and rewrites share links', () => {
    const ok = (u: string) => checkEmbedUrl(u, DEFAULT_EMBED_HOSTS);
    expect(ok('https://docs.google.com/spreadsheets/d/1/edit').ok).toBe(true);
    expect(ok('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toMatchObject({ ok: true, url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
    expect(ok('https://youtu.be/dQw4w9WgXcQ').url).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(ok('https://vimeo.com/123456789').url).toBe('https://player.vimeo.com/video/123456789');
    for (const bad of ['http://docs.google.com/x', 'https://evil.example.com/x', 'https://user:pw@docs.google.com/', 'https://docs.google.com:8443/', 'https://127.0.0.1/', 'https://localhost/', 'https://10.0.0.5/', 'javascript:alert(1)', '', 'nicht-url', 'https://docs.google.com.evil.com/']) expect(ok(bad).ok, bad).toBe(false);
    // the agency's own host (and its subdomains) is fine once listed
    expect(checkEmbedUrl('https://app.intern.example.org/board', [...DEFAULT_EMBED_HOSTS, 'intern.example.org']).ok).toBe(true);
    expect(cleanHost('https://www.Example.com/pfad')).toBe('example.com');
    expect(cleanHost('kein host')).toBeNull();
    expect(cleanHost('192.168.0.1')).toBeNull();
  });
});

describe('board patch', () => {
  it('adds widgets with placement, keeps the layout free of overlaps and fills md/sm', () => {
    const r = patch(base(), [
      { op: 'add', type: 'kpi', ref: 'k1', config: { preset: 'new_contacts' } },
      { op: 'add', type: 'chart', ref: 'c1', placement: 'beside:k1' },
      { op: 'add', type: 'notes', config: { text: 'Hallo' }, placement: 'top', title: 'Gruß' },
    ]);
    expect(r.ok, r.errors.join('|')).toBe(true);
    expect(r.state.spec.widgets).toHaveLength(3);
    expect(r.created.map((c) => c.ref)).toEqual(['k1', 'c1', '']);
    expect(overlaps(cellsOf(r.state))).toBe(false);
    // "top" went to the top, the others moved down
    const note = r.state.spec.widgets.find((w) => w.type === 'notes')!;
    expect(note.layout.lg.y).toBe(0);
    for (const w of r.state.spec.widgets) expect(w.layout.md && w.layout.sm).toBeTruthy();
    expect(r.changes.map((c) => c.kind)).toEqual(['add', 'add', 'add']);
    expect(r.summary).toContain('Neu: „Kennzahl“');
    expect(r.risk).toBe('normal');
  });

  it('turns the example request into a patch: deals over 5.000 € on top, tasks beside, bigger revenue curve', () => {
    const start = patch(base(), [{ op: 'add', type: 'chart', ref: 'c', config: { preset: 'revenue_by_month' } }]).state;
    const chart = start.spec.widgets[0];
    const r = patch(start, [
      { op: 'add', type: 'list', ref: 'deals', placement: 'top', config: { entity: 'deals', status: 'open', min_value: 5000 } },
      { op: 'add', type: 'tasks', ref: 't', placement: 'beside:deals', config: { due: 'today', mine: true } },
      { op: 'resize', id: chart.id, dw: 2, dh: 1 },
    ]);
    expect(r.ok, r.errors.join('|')).toBe(true);
    const deals = r.state.spec.widgets.find((w) => w.type === 'list')!;
    const tasks = r.state.spec.widgets.find((w) => w.type === 'tasks')!;
    const after = r.state.spec.widgets.find((w) => w.id === chart.id)!;
    expect(deals.layout.lg.y).toBe(0);
    expect(tasks.layout.lg.y).toBe(0);
    expect(tasks.layout.lg.x).toBe(deals.layout.lg.x + deals.layout.lg.w);
    expect(after.layout.lg.w).toBe(chart.layout.lg.w + 2);
    expect(after.layout.lg.h).toBe(chart.layout.lg.h + 1);
    expect(deals.config).toMatchObject({ entity: 'deals', min_value: 5000 });
    expect(r.changes.find((c) => c.kind === 'resize')?.text).toContain('→');
    expect(overlaps(cellsOf(r.state))).toBe(false);
  });

  it('classifies risk: layout only is low, content changes normal, addresses and buttons high', () => {
    const s = patch(base(), [{ op: 'add', type: 'notes', config: { text: 'x' } }, { op: 'add', type: 'kpi' }]).state;
    const [a, b] = s.spec.widgets;
    expect(patch(s, [{ op: 'move', id: a.id, x: 4, y: 0 }, { op: 'resize', id: b.id, w: 4 }, { op: 'rename', name: 'Neu' }, { op: 'theme', accent: 'rot' }]).risk).toBe('low');
    expect(patch(s, [{ op: 'configure', id: b.id, title: 'Nur ein Titel' }]).risk).toBe('low');
    expect(patch(s, [{ op: 'configure', id: b.id, config: { preset: 'mrr' } }]).risk).toBe('normal');
    expect(patch(s, [{ op: 'remove', id: a.id }]).risk).toBe('normal');
    const embed = patch(s, [{ op: 'add', type: 'embed', config: { url: 'https://docs.google.com/document/d/1' } }]);
    expect(embed.ok, embed.errors.join('|')).toBe(true);
    expect(embed.risk).toBe('high');
    expect(patch(s, [{ op: 'add', type: 'actions', config: { actions: [{ label: 'Neu', kind: 'task' }] } }]).risk).toBe('high');
  });

  it('refuses everything it does not understand, with a reason and no partial result', () => {
    const s = patch(base(), [{ op: 'add', type: 'kpi' }]).state;
    const id = s.spec.widgets[0].id;
    const err = (ops: unknown, strict = true) => {
      const r = patch(s, ops, { strict });
      expect(r.ok).toBe(false);
      return r.errors.join(' | ');
    };
    expect(err([])).toMatch(/Keine Änderungen/);
    expect(err('nope')).toMatch(/Keine Änderungen/);
    expect(err(Array.from({ length: 26 }, () => ({ op: 'rename', name: 'x' })))).toMatch(/Höchstens 25/);
    expect(err([{ op: 'explode' }])).toMatch(/Unbekannte Änderung/);
    expect(err([{ op: 'add', type: 'hologramm' }])).toMatch(/Unbekanntes Widget „hologramm“/);
    expect(err([{ op: 'add', type: 'kpi', color: 'red' }])).toMatch(/kennt das Feld „color“ nicht/);
    expect(err([{ op: 'add', type: 'kpi', config: { preset: 'gibt_es_nicht' } }])).toMatch(/nicht erlaubt/);
    expect(err([{ op: 'add', type: 'kpi', config: { magic: 1 } }])).toMatch(/unbekanntes Feld/);
    expect(err([{ op: 'add', type: 'kpi', placement: 'beside:nirgends' }])).toMatch(/gibt es nicht/);
    expect(err([{ op: 'add', type: 'kpi', placement: 'irgendwo' }])).toMatch(/placement/);
    expect(err([{ op: 'add', type: 'embed', config: { url: 'https://evil.example.com/' } }])).toMatch(/nicht freigegeben/);
    expect(err([{ op: 'remove', id: 'wNichtDa123' }])).toMatch(/gibt es nicht/);
    expect(err([{ op: 'move', id }])).toMatch(/x\/y oder placement/);
    expect(err([{ op: 'resize', id }])).toMatch(/w\/h oder dw\/dh/);
    expect(err([{ op: 'resize', id, w: 3, bp: 'xl' }])).toMatch(/bp muss/);
    expect(err([{ op: 'configure', id }])).toMatch(/config oder title/);
    expect(err([{ op: 'configure', id, config: { nope: 1 } }])).toMatch(/kennt das Feld „nope“ nicht/);
    expect(err([{ op: 'rename', name: '   ' }])).toMatch(/nicht leer/);
    expect(err([{ op: 'theme', accent: 'hässlich' }])).toMatch(/Unbekannte Farbe/);
    // one bad step spoils the whole patch: the state it returns is the untouched original
    const mixed = patch(s, [{ op: 'rename', name: 'Gut' }, { op: 'remove', id: 'wNichtDa123' }]);
    expect(mixed.ok).toBe(false);
    expect(mixed.errors[0]).toMatch(/^Schritt 2:/);
    expect(s.name).toBe('Mein Board');
  });

  it('lenient mode (the settings panel) repairs instead of refusing', () => {
    const r = patch(base(), [{ op: 'add', type: 'list', config: { limit: 999, whatever: 1 } }], { strict: false });
    expect(r.ok, r.errors.join('|')).toBe(true);
    expect(r.state.spec.widgets[0].config).toMatchObject({ limit: 30 });
  });

  it('configure merges, null resets a field, and the diff names what changed', () => {
    const s = patch(base(), [{ op: 'add', type: 'list', config: { entity: 'deals', min_value: 1000, mine: true } }]).state;
    const id = s.spec.widgets[0].id;
    const r = patch(s, [{ op: 'configure', id, config: { min_value: 5000, mine: null } }]);
    expect(r.ok, r.errors.join('|')).toBe(true);
    expect(r.state.spec.widgets[0].config).toMatchObject({ min_value: 5000, mine: false, entity: 'deals' });
    expect(r.changes[0].text).toContain('Mindestwert (€): 5.000');
    expect(r.changes[0].text).toContain('Nur meine: Nein');
  });

  it('moves and resizes at the tablet and phone breakpoints and remembers they were arranged by hand', () => {
    const s = patch(base(), [{ op: 'add', type: 'kpi' }, { op: 'add', type: 'kpi' }, { op: 'add', type: 'chart' }]).state;
    const [a, , c] = s.spec.widgets;
    const r = patch(s, [{ op: 'move', id: c.id, bp: 'sm', placement: 'top' }]);
    expect(r.ok, r.errors.join('|')).toBe(true);
    expect(r.state.spec.custom).toEqual({ sm: true });
    const order = cellsOf(r.state, 'sm').sort((x, y) => x.y - y.y).map((x) => x.id);
    expect(order[0]).toBe(c.id);
    // later changes on the desktop layout leave the hand-arranged phone order alone, new widgets join at the bottom
    const r2 = patch(r.state, [{ op: 'resize', id: a.id, w: 6 }, { op: 'add', type: 'notes' }]);
    const order2 = cellsOf(r2.state, 'sm').sort((x, y) => x.y - y.y).map((x) => x.id);
    expect(order2.slice(0, 3)).toEqual(order);
    expect(order2).toHaveLength(4);
    expect(r2.state.spec.custom).toEqual({ sm: true });
  });

  it('removing a widget lets the others rise; the board cap holds', () => {
    const s = patch(base(), [{ op: 'add', type: 'chart' }, { op: 'add', type: 'chart' }, { op: 'add', type: 'chart', placement: 'bottom' }]).state;
    const first = s.spec.widgets.find((w) => w.layout.lg.y === 0)!;
    const r = patch(s, [{ op: 'remove', id: first.id }]);
    expect(r.state.spec.widgets).toHaveLength(2);
    expect(Math.min(...r.state.spec.widgets.map((w) => w.layout.lg.y))).toBe(0);
    const many = patch(base(), Array.from({ length: LIMITS.ops }, () => ({ op: 'add', type: 'notes' })));
    expect(many.ok).toBe(true);
    let big = many.state;
    big = patch(big, Array.from({ length: 15 }, () => ({ op: 'add', type: 'notes' }))).state;
    expect(big.spec.widgets).toHaveLength(LIMITS.widgets);
    expect(patch(big, [{ op: 'add', type: 'notes' }]).errors[0]).toMatch(/höchstens 40/);
  });

  it('renames the board, sets the symbol and the accent', () => {
    const r = patch(base(), [{ op: 'rename', name: '  Vertrieb   heute ', icon: 'deal' }, { op: 'theme', accent: 'Violett' }]);
    expect(r.ok).toBe(true);
    expect(r.state).toMatchObject({ name: 'Vertrieb heute', icon: 'deal', accent: '#7c3aed' });
    expect(patch(base(), [{ op: 'rename', name: 'x', icon: 'bombe' }]).errors[0]).toMatch(/Unbekanntes Symbol/);
    expect(patch(r.state, [{ op: 'theme', accent: '' }]).state.accent).toBe('');
  });
});
