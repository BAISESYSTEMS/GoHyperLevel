/**
 * Living Boards: the board patch – a short list of JSON operations (add, remove, move, resize, configure a widget,
 * rename the board, set its accent) that the agent, MCP, the API and the editor all use to change a board. A patch is
 * checked strictly (unknown keys, unknown widget types, bad values are errors – nothing is guessed), applied to a copy
 * and answered with the resulting state, a readable list of changes and a risk class. Nothing is saved here: the
 * store turns an accepted patch into a version.
 *
 * Risk: `low` = layout and looks only (move, resize, rename, accent) – may be applied without asking when the person
 * switched that on; `normal` = adds, removes, changes what a widget shows; `high` = touches the outside (embedded
 * addresses, buttons that start things) – an agent's patch with it always waits for a confirmation.
 */

import type { App } from '../core/app.js';
import { clampCell, placeNew, reorderStack, settle, type Bp, type Cell, type Placed, type Placement } from './boards-layout.js';
import { BOARD_ICONS, LIMITS, accentName, cellsAt, cleanAccent, cleanIcon, cleanLine, newWidgetId, normalizeSpec, type BoardSpec, type BoardState, type WidgetInst } from './boards-model.js';
import { cleanConfig, type ConfigField, type WidgetDef, type WidgetRegistry } from './boards-widgets.js';

export type OpName = 'add' | 'remove' | 'move' | 'resize' | 'configure' | 'rename' | 'theme';
export interface Op {
  op: OpName;
  [k: string]: unknown;
}
const OP_KEYS: Record<OpName, string[]> = {
  add: ['op', 'type', 'ref', 'title', 'config', 'w', 'h', 'x', 'y', 'placement'],
  remove: ['op', 'id'],
  move: ['op', 'id', 'x', 'y', 'placement', 'bp'],
  resize: ['op', 'id', 'w', 'h', 'dw', 'dh', 'bp'],
  configure: ['op', 'id', 'config', 'title'],
  rename: ['op', 'name', 'icon'],
  theme: ['op', 'accent'],
};
export const OP_NAMES = Object.keys(OP_KEYS) as OpName[];

export interface Change {
  kind: OpName;
  widget_id?: string;
  text: string;
}
export type Risk = 'low' | 'normal' | 'high';
export interface PatchResult {
  ok: boolean;
  errors: string[];
  state: BoardState;
  /** The accepted operations as they were given (cleaned) – what a proposal stores. */
  ops: Op[];
  changes: Change[];
  risk: Risk;
  summary: string;
  /** Widgets the patch added or touched explicitly. */
  touched: string[];
  /** Ids of widgets created by `add` operations in order (ref → id), for answers to the caller. */
  created: { ref: string; id: string }[];
}

export interface PatchEnv {
  reg: WidgetRegistry;
  env: { app: App; locationId: string };
  /** Strict (default): unknown fields and out-of-range numbers are errors. */
  strict?: boolean;
  /** Test hook: ids of new widgets. */
  newId?: () => string;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const titleOf = (w: WidgetInst, reg: WidgetRegistry) => w.title || reg.get(w.type)?.label || w.type;

/** "beside:w123" / "below:ref1" / "top" / "bottom" → a placement, ids still unresolved. */
type Parsed = { edge: 'top' | 'bottom' } | { rel: 'beside' | 'below' | 'above'; target: string };
function parsePlacement(p: unknown): Parsed | null {
  const s = String(p ?? '').trim();
  if (s === 'top' || s === 'bottom') return { edge: s };
  const m = /^(beside|right-of|below|above|under|over|next-to):(.{1,40})$/.exec(s);
  if (!m) return null;
  const rel = m[1] === 'below' || m[1] === 'under' ? 'below' : m[1] === 'above' || m[1] === 'over' ? 'above' : 'beside';
  return { rel, target: m[2].trim() };
}
const relPlacement = (rel: 'beside' | 'below' | 'above', id: string): Placement => (rel === 'beside' ? { beside: id } : rel === 'below' ? { below: id } : { above: id });

const fmtValue = (f: ConfigField, v: unknown): string => {
  if (v === null || v === undefined || v === '') return '–';
  if (f.type === 'bool') return v ? 'Ja' : 'Nein';
  if (f.type === 'select' && f.options) return f.options.find(([k]) => k === v)?.[1] ?? String(v);
  if (f.type === 'number') return new Intl.NumberFormat('de-DE').format(Number(v));
  if (f.type === 'multi' && Array.isArray(v)) return v.join(', ') || '–';
  if (f.type === 'list') return `${(v as unknown[]).length} Einträge`;
  if (f.type === 'json') return 'eigene Abfrage';
  if (f.type === 'textarea') return 'geändert';
  if (f.type === 'select' && f.optionsFrom) return 'gewählt';
  return String(v).slice(0, 60);
};

/** What changed in a widget's config, in the person's words. */
function configDiff(def: WidgetDef, before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const f of def.fields) {
    if (f.hidden && f.type !== 'json') continue;
    if (JSON.stringify(before[f.key] ?? null) === JSON.stringify(after[f.key] ?? null)) continue;
    out.push(`${f.label}: ${fmtValue(f, after[f.key])}`);
  }
  return out;
}

export function applyPatch(state: BoardState, rawOps: unknown, p: PatchEnv): PatchResult {
  const errors: string[] = [];
  const strict = p.strict !== false;
  const genId = p.newId ?? newWidgetId;
  const after: BoardState = clone(state);
  const spec: BoardSpec = after.spec;
  const created: { ref: string; id: string }[] = [];
  const refs = new Map<string, string>();
  const touched = new Set<string>();
  const changes: Change[] = [];
  const accepted: Op[] = [];
  let risk: Risk = 'low';
  const bump = (r: Risk) => {
    if (r === 'high' || (r === 'normal' && risk === 'low')) risk = r;
  };
  const fail = (i: number, msg: string) => {
    if (errors.length < 12) errors.push(`Schritt ${i + 1}: ${msg}`);
  };

  const result = (ok: boolean): PatchResult => ({ ok, errors, state: after, ops: accepted, changes, risk, summary: summarize(changes), touched: [...touched], created });

  if (!Array.isArray(rawOps) || !rawOps.length) {
    errors.push('Keine Änderungen angegeben (ops fehlt oder ist leer)');
    return result(false);
  }
  if (rawOps.length > LIMITS.ops) {
    errors.push(`Höchstens ${LIMITS.ops} Änderungen auf einmal`);
    return result(false);
  }

  const limits = (type: string) => p.reg.limits(type);
  const widget = (idOrRef: unknown): WidgetInst | undefined => {
    const k = String(idOrRef ?? '');
    return spec.widgets.find((w) => w.id === (refs.get(k) ?? k));
  };
  const resolveId = (v: string) => refs.get(v) ?? v;
  /** Cells of a breakpoint; a derived one becomes "arranged by hand" the moment it is changed. */
  const materialize = (bp: Bp): Placed[] => {
    const cells = cellsAt(spec, bp, limits);
    if (bp !== 'lg') {
      spec.custom = { ...(spec.custom ?? {}), [bp]: true };
      for (const c of cells) {
        const w = spec.widgets.find((x) => x.id === c.id)!;
        w.layout[bp] = { x: c.x, y: c.y, w: c.w, h: c.h };
      }
    }
    return cells;
  };
  const write = (bp: Bp, cells: Placed[]) => {
    for (const c of cells) {
      const w = spec.widgets.find((x) => x.id === c.id);
      if (w) w.layout[bp] = { x: c.x, y: c.y, w: c.w, h: c.h };
    }
  };

  for (const [i, raw] of rawOps.entries()) {
    if (!isObj(raw) || typeof raw.op !== 'string' || !(raw.op in OP_KEYS)) {
      fail(i, `Unbekannte Änderung „${isObj(raw) ? String(raw.op ?? '').slice(0, 30) : '?'}“ (erlaubt: ${OP_NAMES.join(', ')})`);
      continue;
    }
    const name = raw.op as OpName;
    const unknown = Object.keys(raw).filter((k) => !OP_KEYS[name].includes(k));
    if (unknown.length) {
      fail(i, `„${name}“ kennt das Feld „${unknown[0].slice(0, 30)}“ nicht (erlaubt: ${OP_KEYS[name].filter((k) => k !== 'op').join(', ')})`);
      continue;
    }
    const clean: Op = { ...raw, op: name };
    const bp = (['lg', 'md', 'sm'] as const).find((b) => b === raw.bp) ?? 'lg';
    if (raw.bp !== undefined && raw.bp !== bp) {
      fail(i, 'bp muss lg, md oder sm sein');
      continue;
    }

    if (name === 'add') {
      const def = p.reg.get(String(raw.type ?? ''));
      if (!def) {
        fail(i, `Unbekanntes Widget „${String(raw.type ?? '').slice(0, 30)}“ (verfügbar: ${p.reg.list().map((d) => d.type).join(', ')})`);
        continue;
      }
      if (spec.widgets.length >= LIMITS.widgets) {
        fail(i, `Ein Board hat höchstens ${LIMITS.widgets} Widgets`);
        continue;
      }
      if (raw.config !== undefined && !isObj(raw.config)) {
        fail(i, 'config muss ein Objekt sein');
        continue;
      }
      const cfg = cleanConfig(def, raw.config ?? {}, { strict, where: `„${def.label}“` });
      const more = cfg.errors.length ? [] : (def.validate?.(cfg.config, p.env) ?? []);
      if (cfg.errors.length || more.length) {
        for (const e of [...cfg.errors, ...more]) fail(i, e);
        continue;
      }
      const lim = limits(def.type);
      const size = clampCell({ w: num(raw.w) ?? def.size.w, h: num(raw.h) ?? def.size.h }, 'lg', lim);
      const lg = cellsAt(spec, 'lg', limits);
      let at: Placement = 'bottom';
      const pl = raw.placement === undefined ? null : parsePlacement(raw.placement);
      if (raw.placement !== undefined && !pl) {
        fail(i, 'placement: top, bottom, beside:<id>, below:<id> oder above:<id>');
        continue;
      }
      if (pl) {
        if ('edge' in pl) at = pl.edge;
        else {
          const t = widget(pl.target);
          if (!t) {
            fail(i, `placement: das Widget „${pl.target.slice(0, 30)}“ gibt es nicht`);
            continue;
          }
          at = relPlacement(pl.rel, t.id);
        }
      } else if (num(raw.x) !== undefined || num(raw.y) !== undefined) at = { x: num(raw.x), y: num(raw.y) };
      const id = genId();
      const cell = clampCell(placeNew(lg, size, 'lg', at), 'lg', lim);
      const w: WidgetInst = { id, type: def.type, title: cleanLine(raw.title, LIMITS.title), config: cfg.config, layout: { lg: cell } };
      spec.widgets.push(w);
      const all = settle([...lg, { id, ...cell }], id);
      write('lg', all);
      if (typeof raw.ref === 'string' && raw.ref) refs.set(raw.ref, id);
      created.push({ ref: String(raw.ref ?? ''), id });
      touched.add(id);
      bump(def.risk === 'high' ? 'high' : 'normal');
      changes.push({ kind: 'add', widget_id: id, text: `Neu: „${w.title || def.label}“${w.title && w.title !== def.label ? ` (${def.label})` : ''}` });
      accepted.push(clean);
      continue;
    }

    if (name === 'rename') {
      let did = false;
      if (raw.name !== undefined) {
        const n = cleanLine(raw.name, LIMITS.name);
        if (!n) {
          fail(i, 'Der Name darf nicht leer sein');
          continue;
        }
        if (n !== after.name) changes.push({ kind: 'rename', text: `Board umbenannt: „${after.name}“ → „${n}“` });
        after.name = n;
        did = true;
      }
      if (raw.icon !== undefined) {
        if (!(BOARD_ICONS as readonly string[]).includes(String(raw.icon))) {
          fail(i, `Unbekanntes Symbol „${String(raw.icon).slice(0, 20)}“`);
          continue;
        }
        if (raw.icon !== after.icon) changes.push({ kind: 'rename', text: `Symbol: ${String(raw.icon)}` });
        after.icon = cleanIcon(raw.icon);
        did = true;
      }
      if (!did) {
        fail(i, 'rename braucht name oder icon');
        continue;
      }
      accepted.push(clean);
      continue;
    }

    if (name === 'theme') {
      const a = cleanAccent(raw.accent);
      if (a === null) {
        fail(i, `Unbekannte Farbe „${String(raw.accent).slice(0, 20)}“ (erlaubt: ${Object.keys({ blau: 1, grün: 1, violett: 1, orange: 1, rot: 1, türkis: 1, rosa: 1, grau: 1 }).join(', ')} oder #rrggbb)`);
        continue;
      }
      if (a !== after.accent) changes.push({ kind: 'theme', text: a ? `Akzentfarbe: ${accentName(a)}` : 'Akzentfarbe zurückgesetzt' });
      after.accent = a;
      accepted.push(clean);
      continue;
    }

    // everything below works on an existing widget
    const w = widget(raw.id);
    if (!w) {
      fail(i, `Das Widget „${String(raw.id ?? '').slice(0, 30)}“ gibt es nicht`);
      continue;
    }
    const def = p.reg.get(w.type);
    const lim = limits(w.type);
    clean.id = w.id;

    if (name === 'remove') {
      spec.widgets = spec.widgets.filter((x) => x.id !== w.id);
      changes.push({ kind: 'remove', widget_id: w.id, text: `Entfernt: „${titleOf(w, p.reg)}“` });
      bump('normal');
      touched.delete(w.id);
      accepted.push(clean);
      continue;
    }

    if (name === 'configure') {
      if (raw.config === undefined && raw.title === undefined) {
        fail(i, 'configure braucht config oder title');
        continue;
      }
      if (!def) {
        fail(i, `„${w.type}“ ist nicht (mehr) verfügbar und lässt sich nicht ändern`);
        continue;
      }
      let merged = w.config;
      if (raw.config !== undefined) {
        if (!isObj(raw.config)) {
          fail(i, 'config muss ein Objekt sein');
          continue;
        }
        const keys = Object.keys(raw.config);
        const bad = strict ? keys.find((k) => !def.fields.some((f) => f.key === k)) : undefined;
        if (bad) {
          fail(i, `„${def.label}“ kennt das Feld „${bad.slice(0, 30)}“ nicht (erlaubt: ${def.fields.filter((f) => !f.hidden || f.type === 'json').map((f) => f.key).join(', ')})`);
          continue;
        }
        merged = { ...w.config };
        for (const [k, v] of Object.entries(raw.config)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        // Only the fields of the patch are held to the strict rules; the rest was stored before.
        const patchCheck = cleanConfig({ ...def, fields: def.fields.filter((f) => keys.includes(f.key)) }, raw.config, { strict, where: `„${def.label}“` });
        const cfg = cleanConfig(def, merged, { strict: false, where: `„${def.label}“` });
        const more = patchCheck.errors.length ? [] : (def.validate?.(cfg.config, p.env) ?? []);
        if (patchCheck.errors.length || more.length) {
          for (const e of [...patchCheck.errors, ...more]) fail(i, e);
          continue;
        }
        merged = cfg.config;
      }
      const old = w.config;
      const oldTitle = w.title;
      w.config = merged;
      if (raw.title !== undefined) w.title = cleanLine(raw.title, LIMITS.title);
      const diff = configDiff(def, old, merged);
      if (w.title !== oldTitle) diff.unshift(`Titel: ${w.title || def.label}`);
      if (diff.length) {
        changes.push({ kind: 'configure', widget_id: w.id, text: `„${titleOf(w, p.reg)}“: ${diff.join(' · ')}` });
        bump(def.risk === 'high' ? 'high' : diff.every((d) => d.startsWith('Titel:')) ? 'low' : 'normal');
      }
      touched.add(w.id);
      accepted.push(clean);
      continue;
    }

    if (name === 'move') {
      const pl = raw.placement === undefined ? null : parsePlacement(raw.placement);
      if (raw.placement !== undefined && !pl) {
        fail(i, 'placement: top, bottom, beside:<id>, below:<id> oder above:<id>');
        continue;
      }
      if (!pl && num(raw.x) === undefined && num(raw.y) === undefined) {
        fail(i, 'move braucht x/y oder placement');
        continue;
      }
      const cells = materialize(bp);
      const me = cells.find((c) => c.id === w.id)!;
      const others = cells.filter((c) => c.id !== w.id);
      let next: Cell;
      if (bp === 'sm') {
        // one column: only the order matters
        const order = [...others].sort((a, b) => a.y - b.y);
        let index = order.length;
        if (pl && 'edge' in pl) index = pl.edge === 'top' ? 0 : order.length;
        else if (pl) {
          const t = order.findIndex((c) => c.id === resolveId(pl.target));
          if (t < 0) {
            fail(i, `placement: das Widget „${pl.target.slice(0, 30)}“ gibt es nicht`);
            continue;
          }
          index = pl.rel === 'above' ? t : t + 1;
        } else index = Math.max(0, Math.min(order.length, Math.round(num(raw.y) ?? order.length)));
        write('sm', reorderStack(cells, w.id, index));
        touched.add(w.id);
        changes.push({ kind: 'move', widget_id: w.id, text: `„${titleOf(w, p.reg)}“ verschoben` });
        accepted.push(clean);
        continue;
      }
      if (pl && 'rel' in pl) {
        const t = widget(pl.target);
        if (!t || t.id === w.id) {
          fail(i, `placement: das Widget „${pl.target.slice(0, 30)}“ gibt es nicht`);
          continue;
        }
        next = placeNew(others, { w: me.w, h: me.h }, bp, relPlacement(pl.rel, t.id));
      } else if (pl) next = placeNew(others, { w: me.w, h: me.h }, bp, pl.edge);
      else next = { ...me, x: num(raw.x) ?? me.x, y: num(raw.y) ?? me.y };
      next = clampCell(next, bp, lim);
      write(bp, settle(cells.map((c) => (c.id === w.id ? { ...c, ...next } : c)), w.id));
      touched.add(w.id);
      changes.push({ kind: 'move', widget_id: w.id, text: `„${titleOf(w, p.reg)}“ verschoben` });
      accepted.push(clean);
      continue;
    }

    if (name === 'resize') {
      const nw = num(raw.w);
      const nh = num(raw.h);
      const dw = num(raw.dw);
      const dh = num(raw.dh);
      if (nw === undefined && nh === undefined && dw === undefined && dh === undefined) {
        fail(i, 'resize braucht w/h oder dw/dh');
        continue;
      }
      const cells = materialize(bp);
      const me = cells.find((c) => c.id === w.id)!;
      const next = clampCell({ x: me.x, y: me.y, w: nw ?? me.w + (dw ?? 0), h: nh ?? me.h + (dh ?? 0) }, bp, lim);
      write(bp, settle(cells.map((c) => (c.id === w.id ? { ...c, ...next } : c)), w.id));
      touched.add(w.id);
      if (next.w !== me.w || next.h !== me.h) changes.push({ kind: 'resize', widget_id: w.id, text: `„${titleOf(w, p.reg)}“: ${me.w}×${me.h} → ${next.w}×${next.h}` });
      accepted.push(clean);
      continue;
    }
  }

  if (errors.length) return result(false);
  after.spec = normalizeSpec(spec, limits);
  if (JSON.stringify(after.spec).length > LIMITS.specBytes) {
    errors.push('Das Board wird zu groß');
    return result(false);
  }
  return result(true);
}

/** One line for lists and the version history. */
export function summarize(changes: Change[]): string {
  if (!changes.length) return 'Keine Änderung';
  const head = changes.slice(0, 3).map((c) => c.text);
  const rest = changes.length - head.length;
  const text = head.join(' · ') + (rest > 0 ? ` · und ${rest} weitere` : '');
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
