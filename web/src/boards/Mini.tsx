import type { CSSProperties } from 'react';
import { Icon, ICONS, type IconName } from '../icons';
import { COLS } from './layout';
import type { Catalogue } from './types';

export interface MiniCell {
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A board in miniature: its widgets as tinted tiles on the 12-column grid (cards, template gallery, change preview). */
export function Mini({ cells, accent, catalogue, highlight }: { cells: MiniCell[]; accent?: string; catalogue?: Catalogue | null; highlight?: Set<number> }) {
  const rows = Math.max(4, ...cells.map((c) => c.y + c.h));
  const icon = (t: string): IconName | null => {
    const n = catalogue?.widgets.find((w) => w.type === t)?.icon;
    return n && n in ICONS ? (n as IconName) : null;
  };
  const style = { aspectRatio: `${COLS.lg} / ${rows * 0.78}`, ...(accent && /^#[0-9a-f]{6}$/i.test(accent) ? { '--bd-accent': accent } : {}) } as CSSProperties;
  return (
    <div className="bd-mini" style={style} aria-hidden="true">
      {cells.map((c, i) => {
        const g = icon(c.type);
        return (
          <i key={i} className={highlight?.has(i) ? 'hot' : undefined} style={{ left: `${(c.x / COLS.lg) * 100}%`, top: `${(c.y / rows) * 100}%`, width: `${(c.w / COLS.lg) * 100}%`, height: `${(c.h / rows) * 100}%` }}>
            {g && c.w >= 2 && c.h >= 2 && <Icon name={g} size={12} />}
          </i>
        );
      })}
    </div>
  );
}

export const cellsOfSpec = (widgets: { type: string; layout: { lg: { x: number; y: number; w: number; h: number } } }[]): MiniCell[] => widgets.map((w) => ({ type: w.type, ...w.layout.lg }));
