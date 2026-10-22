import type { CSSProperties } from 'react';
import { safeKey } from '../../../server/services/tile-order';
import type { CardPart } from '../boards/Grid';
import { rowsPx } from '../boards/layout';
import { Go } from '../boards/views';
import { WidgetCard } from '../boards/WidgetCard';
import { useT } from '../i18n';
import { Icon } from '../icons';
import { SortReset, SortableGrid, useSortable } from '../sortable/Sortable';
import type { FocusTile } from './types';

const noop = () => undefined;
/** A key figure: small enough to stand in the strip of numbers at the top. */
const isFigure = (x: FocusTile) => x.h <= 2 && x.w <= 4;

/**
 * Rows of 12 columns in the order the tiles came: a tile that does not fit starts the next row, and the columns a row leaves free
 * go to its tiles – so every row is full and no card floats next to a hole. All tiles of a row get the height of the tallest.
 */
export function packRows(tiles: FocusTile[]): { tile: FocusTile; w: number }[][] {
  const rows: { tile: FocusTile; w: number }[][] = [];
  let row: { tile: FocusTile; w: number }[] = [];
  let used = 0;
  for (const tile of tiles) {
    const w = Math.max(3, Math.min(12, tile.w));
    if (row.length && used + w > 12) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push({ tile, w });
    used += w;
  }
  if (row.length) rows.push(row);
  for (const r of rows) for (let extra = 12 - r.reduce((s, c) => s + c.w, 0), i = 0; extra > 0; extra--, i++) r[i % r.length].w++;
  return rows;
}

/**
 * A tile's key for the person's own order (web/src/sortable): what it shows (widget type + settings), not its place in this
 * answer – so "Umsatz zuerst" also holds for the next question that shows the revenue tile.
 */
export const focusKey = (x: Pick<FocusTile, 'type' | 'config'>) => safeKey(`${x.type}~${JSON.stringify(x.config ?? {})}`);

function Tile({ x, height, span, sortKey }: { x: FocusTile; height: number; span?: number; sortKey?: string }) {
  const t = useT('focus');
  const part: CardPart = { width: 0, height, handle: null, resizer: null, lifted: false, position: '' };
  const style = { '--w': span ?? 3, '--wm': (span ?? 3) > 6 ? 2 : 1, '--h': `${height}px` } as CSSProperties;
  return (
    <div className="fx-tile" style={style} data-type={x.type} data-sort-key={sortKey}>
      <div className="fx-card">
        <WidgetCard w={{ id: x.id, type: x.type, title: x.title, config: x.config, layout: { lg: { x: 0, y: 0, w: x.w, h: x.h } } }} data={x.data} loading={false} part={part} edit={false} selected={false} onSettings={noop} onRemove={noop} onRefresh={noop} />
      </div>
      <Go url={x.source.url} className="fx-src" label={t('Quelle: {source} – öffnen', { source: x.source.label })}>
        <span className="fx-src-text" title={x.source.hint || undefined}>
          {t('Quelle')}: {x.source.label}
        </span>
        <Icon name="external" size={12} />
      </Go>
    </div>
  );
}

/**
 * The tiles of a focus view: the Living Boards' own widget cards (same views, same look, same states – locked cards included). Key
 * figures stand in a strip at the top, the rest in full rows of 12 columns (two on a tablet, one on a phone); every tile says where
 * its numbers come from and links into the page they are read from.
 */
export function FocusTiles({ tiles }: { tiles: FocusTile[] }) {
  const figures = tiles.filter(isFigure);
  // The cards can be dragged into the person's own order (across rows – the rows are packed again from the new order), the
  // key figures within their strip; both orders hold for every answer that shows those tiles (focusKey).
  const cards = tiles.filter((x) => !isFigure(x));
  const s = useSortable({ id: 'focus.tiles', keys: cards.map(focusKey) });
  const byKey = new Map(cards.map((x) => [focusKey(x), x]));
  const rows = packRows(s.order.map((k) => byKey.get(k)).filter((x): x is FocusTile => !!x));
  return (
    <div className="fx-tiles" ref={s.ref} data-sortable="">
      {figures.length > 0 && (
        <SortableGrid id="focus.figures" className="fx-figures">
          {figures.map((x) => (
            <Tile key={focusKey(x)} x={x} height={rowsPx(2)} />
          ))}
        </SortableGrid>
      )}
      {rows.map((r, i) => {
        const height = rowsPx(Math.max(...r.map((c) => c.tile.h)));
        return (
          <div key={i} className="fx-row">
            {r.map((c) => (
              <Tile key={focusKey(c.tile)} x={c.tile} height={height} span={c.w} sortKey={focusKey(c.tile)} />
            ))}
          </div>
        );
      })}
      <SortReset sortable={s} />
    </div>
  );
}

export function TileSkeleton() {
  return (
    <div className="fx-tiles" aria-hidden="true">
      <div className="fx-figures">
        {[0, 1, 2].map((i) => (
          <div key={i} className="fx-tile fx-skel" style={{ '--h': `${rowsPx(2)}px` } as CSSProperties}>
            <div className="fx-card" />
          </div>
        ))}
      </div>
      <div className="fx-row">
        {[6, 6].map((w, i) => (
          <div key={i} className="fx-tile fx-skel" style={{ '--w': w, '--wm': 1, '--h': `${rowsPx(4)}px` } as CSSProperties}>
            <div className="fx-card" />
          </div>
        ))}
      </div>
    </div>
  );
}
