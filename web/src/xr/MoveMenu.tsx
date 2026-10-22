import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons';
import { useSpatial } from '../theme/store';
import { Modal } from '../ui';

/**
 * "Verschieben nach …": the way to move a card, a task or a widget without dragging it. Dragging needs a steady hand and a
 * pointer that stays pressed – with eyes and a pinch, or a controller in the air, that is the wrong tool. In the Raum-Modus
 * every draggable thing gets this button: it opens a list of places, each a large target; one pinch moves the card.
 * Outside the Raum-Modus it renders nothing (the drag handles stay as they are).
 */

export interface MoveTarget {
  id: string;
  label: string;
  hint?: string;
  icon?: string;
}

export function MoveMenu({ what, targets, current, onMove, title = 'Verschieben nach …' }: { what: string; targets: MoveTarget[]; current?: string; onMove: (id: string) => void | Promise<unknown>; title?: string }) {
  const spatial = useSpatial();
  const [open, setOpen] = useState(false);
  if (!spatial) return null;
  return (
    <>
      <button
        type="button"
        className="btn secondary small sp-move-btn"
        aria-label={`${what} verschieben`}
        aria-haspopup="dialog"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        draggable={false}
      >
        <Icon name="move" size={16} /> Verschieben
      </button>
      {/* In a portal: the card is transformed on hover (a fixed dialog inside it would be placed and clipped by the card), and the
          wrapper keeps clicks in the dialog from reaching the card's own click handler (React events bubble through portals). */}
      {open &&
        createPortal(
          <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            <Modal title={title} onClose={() => setOpen(false)}>
              <p className="muted small" style={{ marginTop: 0 }}>{what}</p>
              <div className="sp-move-list" role="list">
                {targets.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="listitem"
                    className={`sp-move-item${t.id === current ? ' current' : ''}`}
                    disabled={t.id === current}
                    onClick={async () => {
                      setOpen(false);
                      await onMove(t.id);
                    }}
                  >
                    <span className="sp-move-name">{t.label}</span>
                    {t.hint && <span className="muted small">{t.hint}</span>}
                    {t.id === current && <span className="small">aktuell</span>}
                  </button>
                ))}
              </div>
            </Modal>
          </div>,
          document.body,
        )}
    </>
  );
}
