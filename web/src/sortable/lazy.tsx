import { Suspense, type ComponentProps } from 'react';
import { lazyPages, preload } from '../lazy';

/**
 * SortableGrid for code that is part of the first download (the dashboard and its plugin widgets): the drag & drop engine
 * is a chunk of its own (tests/bundle-budget.test.ts). It starts loading with the app, so it is normally there before the
 * dashboard's numbers are; until then the tiles show in their natural order inside the same element. A grid with live
 * embeds (keepDom: plugin iframes) shows nothing until then instead – the swap to the engine would mount every iframe a
 * second time, and load it twice.
 */
const { SortableGrid: Engine } = lazyPages(() => import('./Sortable'), 'SortableGrid');
if (typeof window !== 'undefined') preload(Engine);

type Props = ComponentProps<typeof Engine>;

export function SortableGrid(props: Props) {
  const { id: _id, pinned: _p, noReset: _n, disabled: _d, keepDom, as: Tag = 'div', ...plain } = props;
  return (
    <Suspense fallback={keepDom ? null : <Tag {...plain} />}>
      <Engine {...props} />
    </Suspense>
  );
}
