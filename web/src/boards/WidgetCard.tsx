import { memo, type ReactNode } from 'react';
import { Icon, ICONS, type IconName } from '../icons';
import type { CardPart } from './Grid';
import type { Widget, WidgetData, WidgetType } from './types';
import { Go, Quiet, Skeleton, ViewBody } from './views';

/** The content only redraws when its own data or size changes – not on every pointer move of a drag. */
const Body = memo(ViewBody, (a, b) => a.view === b.view && a.title === b.title && a.height === b.height);

const HEAD = 42;

export const widgetIcon = (t?: WidgetType): IconName => (t && t.icon in ICONS ? (t.icon as IconName) : 'puzzle');

/** The card around one widget: title, the handle and buttons while editing, the widget's view below. */
export function WidgetCard({ w, type, data, loading, part, edit, selected, fresh, onSettings, onRemove, onRefresh, moveMenu }: { w: Widget; type?: WidgetType; data?: WidgetData; loading: boolean; part: CardPart; edit: boolean; selected: boolean; fresh?: boolean; onSettings: () => void; onRemove: () => void; onRefresh: () => void; moveMenu?: ReactNode }) {
  const view = data?.view;
  const title = w.title || view?.title || type?.label || 'Widget';
  const url = view && 'url' in view ? view.url : undefined;
  const bare = view?.kind === 'embed' || view?.kind === 'frame';
  return (
    <article className={`bd-card${part.lifted ? ' lifted' : ''}${selected ? ' selected' : ''}${fresh ? ' fresh' : ''}${bare ? ' bare' : ''}`} aria-label={title} data-type={w.type}>
      <header className="bd-card-head">
        {part.handle}
        <h3 title={title}>{title}</h3>
        <span className="bd-card-tools">
          {!edit && url && (
            <Go url={url} className="bd-iconbtn" label={`${title} öffnen`}>
              <Icon name="external" size={14} />
            </Go>
          )}
          {edit && (
            <>
              {moveMenu}
              <button type="button" className="bd-iconbtn" onClick={onSettings} aria-label={`${title}: Einstellungen`} title="Einstellungen" data-tour="board-widget-settings">
                <Icon name="properties" size={15} />
              </button>
              <button type="button" className="bd-iconbtn danger" onClick={onRemove} aria-label={`${title} entfernen`} title="Entfernen">
                <Icon name="trash" size={15} />
              </button>
            </>
          )}
        </span>
      </header>
      <div className="bd-body" data-kind={view?.kind ?? 'loading'}>
        {!view ? loading ? <Skeleton /> : <Quiet text="Keine Daten." /> : <Body view={view} title={title} height={part.height - HEAD - 22} onChanged={onRefresh} />}
      </div>
      {part.resizer}
      <span className="sr-only">{edit ? part.position : ''}</span>
    </article>
  );
}
