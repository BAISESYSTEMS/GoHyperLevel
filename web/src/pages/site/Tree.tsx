import { createContext, Fragment, useContext, useState } from 'react';
import { Icon } from '../../icons';
import { BLOCKS } from './blocks';
import { canDrop, childrenOf, contains, kindOf, labelOf, type Block, type Container, type Kind } from './model';
import { useT } from '../../i18n';

/** What is being dragged: a node of the tree, or something from the palette. */
export type Drag = { what: 'node'; id: string; kind: Kind } | { what: 'block'; type: string } | { what: 'section'; spans: number[] } | { what: 'component'; id: string; name: string; section?: boolean };

/** May the dragged thing be dropped into this container? */
export function accepts(tree: Block[], drag: Drag | null, c: Container): boolean {
  if (!drag) return false;
  if (drag.what === 'node') return canDrop(tree, drag.kind, c, drag.id) && !(c.kind !== 'root' && contains(tree, drag.id, c.id));
  if (drag.what === 'section' || (drag.what === 'component' && drag.section)) return c.kind === 'root';
  return c.kind === 'root' || c.kind === 'col';
}

interface Props {
  blocks: Block[];
  selId?: string;
  drag: Drag | null;
  setDrag(d: Drag | null): void;
  onSelect(id: string): void;
  onDrop(c: Container, index: number): void;
  onNudge(id: string, dir: -1 | 1): void;
  onDuplicate(id: string): void;
  onDelete(id: string): void;
}

const KIND_ICON = { section: 'layers', row: 'columns', col: 'column1' } as const;
/** German labels (message ids of the sites catalog), shown through t(). */
const DEVICE = { desktop: 'Desktop', tablet: 'Tablet', phone: 'Handy' } as const;

// The pieces are module-level components (not defined inside Tree): a component that is re-created on every render would be
// unmounted when the drag starts, and the browser would cancel the drag.
const TreeCtx = createContext<{ p: Props; closed: Set<string>; toggle(id: string): void } | null>(null);
const useTree = () => useContext(TreeCtx)!;

function Zone({ c, index }: { c: Container; index: number }) {
  const { p } = useTree();
  const [over, setOver] = useState(false);
  const live = accepts(p.blocks, p.drag, c);
  return (
    <div
      className={`dz${live ? ' live' : ''}${over ? ' over' : ''}`}
      onDragOver={(e) => {
        if (!live) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = p.drag?.what === 'node' ? 'move' : 'copy';
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        if (live) p.onDrop(c, index);
      }}
      aria-hidden="true"
    />
  );
}

function Level({ list, c }: { list: Block[]; c: Container }) {
  const t = useT('sites');
  return (
    <div className="tl">
      <Zone c={c} index={0} />
      {list.map((n, i) => (
        <Fragment key={n.id}>
          <NodeView n={n} c={c} i={i} count={list.length} />
          <Zone c={c} index={i + 1} />
        </Fragment>
      ))}
      {!list.length && <p className="tl-empty muted small">{c.kind === 'col' ? t('Leer – Block hierher ziehen oder links anklicken') : t('Leer')}</p>}
    </div>
  );
}

function NodeView({ n, i, count }: { n: Block; c: Container; i: number; count: number }) {
  const t = useT('sites');
  const { p, closed, toggle } = useTree();
  const kind = kindOf(n);
  const sel = p.selId === n.id;
  const open = !closed.has(n.id);
  const spec = kind === 'block' ? BLOCKS[n.type] : undefined;
  const inner: Container | undefined = kind === 'section' ? { kind: 'section', id: n.id } : kind === 'row' ? { kind: 'row', id: n.id } : kind === 'col' ? { kind: 'col', id: n.id } : undefined;
  const kids = inner ? childrenOf(p.blocks, inner) : [];
  const hidden = n.hide && Object.keys(n.hide).length ? Object.keys(n.hide).map((k) => t(DEVICE[k as keyof typeof DEVICE])).join(', ') : '';
  const onlyCol = kind === 'col' && count <= 1;
  const title = kind === 'block' ? (spec ? t(spec.label) : n.type) : kind === 'section' ? t('Abschnitt') : kind === 'row' ? t('Zeile') : t('Spalte');
  const detail = kind === 'block' ? labelOf(n) : kind === 'section' ? n.name || '' : kind === 'row' ? t('{n} Sp.', { n: (n.cols ?? []).length }) : `${n.span ?? ''}/12`;
  return (
    <div className={`tn k-${kind}`} role="treeitem" aria-selected={sel} aria-expanded={inner ? open : undefined}>
      <div
        className={`tn-head${sel ? ' on' : ''}${p.drag?.what === 'node' && p.drag.id === n.id ? ' dragging' : ''}`}
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData('text/plain', n.id);
          e.dataTransfer.effectAllowed = 'move';
          p.setDrag({ what: 'node', id: n.id, kind });
        }}
        onDragEnd={() => p.setDrag(null)}
        onClick={(e) => (e.stopPropagation(), p.onSelect(n.id))}
      >
        {inner ? (
          <button className="tn-toggle" onClick={(e) => (e.stopPropagation(), toggle(n.id))} aria-label={open ? t('Zuklappen') : t('Aufklappen')}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="tn-toggle" />
        )}
        <span className="tn-grip" aria-hidden="true">
          <Icon name="grip" />
        </span>
        <Icon name={spec?.icon ?? KIND_ICON[kind as 'section']} />
        <button className="tn-label" onClick={(e) => (e.stopPropagation(), p.onSelect(n.id))}>
          <b>{title}</b> <span className="muted small">{detail}</span>
          {hidden && (
            <span className="tn-hide small" title={t('Ausgeblendet auf: {devices}', { devices: hidden })}>
              {' '}
              {t('· aus:')} {hidden}
            </span>
          )}
        </button>
        <span className="tn-act">
          <button className="icon-btn" disabled={i === 0} onClick={(e) => (e.stopPropagation(), p.onNudge(n.id, -1))} aria-label={t('{item} nach oben', { item: title })}>
            ↑
          </button>
          <button className="icon-btn" disabled={i === count - 1} onClick={(e) => (e.stopPropagation(), p.onNudge(n.id, 1))} aria-label={t('{item} nach unten', { item: title })}>
            ↓
          </button>
          {kind !== 'col' && (
            <button className="icon-btn" onClick={(e) => (e.stopPropagation(), p.onDuplicate(n.id))} aria-label={t('{item} duplizieren', { item: title })}>
              <Icon name="copy" />
            </button>
          )}
          <button className="icon-btn" disabled={onlyCol} onClick={(e) => (e.stopPropagation(), p.onDelete(n.id))} aria-label={t('{item} entfernen', { item: title })}>
            ✕
          </button>
        </span>
      </div>
      {inner && open && <Level list={kids} c={inner} />}
    </div>
  );
}

/** The page structure: sections → rows → columns → blocks. Everything can be dragged; the buttons do the same without a mouse. */
export function Tree(p: Props) {
  const t = useT('sites');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <TreeCtx.Provider value={{ p, closed, toggle }}>
      <div className={`tree${p.drag ? ' dragging' : ''}`} data-tour="site-tree" role="tree" aria-label={t('Seitenstruktur')}>
        <Level list={p.blocks} c={{ kind: 'root' }} />
      </div>
    </TreeCtx.Provider>
  );
}
