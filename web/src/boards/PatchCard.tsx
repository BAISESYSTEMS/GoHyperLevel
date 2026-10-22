import { useEffect, useMemo, useRef } from 'react';
import { Icon, type IconName } from '../icons';
import { openBuild } from '../werkstatt/shared';
import { Mini, cellsOfSpec } from './Mini';
import type { BoardFull, Catalogue, Change, ComposeResult } from './types';

const KIND: Record<Change['kind'], IconName> = { add: 'plus', remove: 'trash', move: 'move', resize: 'columns', configure: 'toggles', rename: 'edit', theme: 'palette' };

const RISK: Record<string, { text: string; cls: string }> = {
  low: { text: 'Nur das Layout ändert sich', cls: 'low' },
  normal: { text: 'Ändert, was angezeigt wird', cls: 'normal' },
  high: { text: 'Bettet Externes ein oder legt Knöpfe an, die etwas starten – bitte genau prüfen', cls: 'high' },
};

/** What the board would look like and what exactly changes – the person confirms or throws it away. Esc discards. */
export function PatchCard({ result, board, catalogue, busy, onApply, onReject }: { result: ComposeResult; board: BoardFull; catalogue: Catalogue | null; busy: boolean; onApply: () => void; onReject: () => void }) {
  const p = result.proposal;
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef({ busy, onReject });
  live.current = { busy, onReject };
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && !live.current.busy && live.current.onReject();
    window.addEventListener('keydown', k);
    ref.current?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    return () => window.removeEventListener('keydown', k);
  }, []);
  const after = p?.after?.spec.widgets;
  const touched = useMemo(() => new Set((p?.changes ?? []).map((c) => c.widget_id).filter(Boolean) as string[]), [p]);
  const before = new Set(board.spec.widgets.map((w) => w.id));
  const hot = useMemo(() => new Set((after ?? []).flatMap((w, i) => (touched.has(w.id) || !before.has(w.id) ? [i] : []))), [after, touched, board]); // eslint-disable-line react-hooks/exhaustive-deps
  const stale = !!p && p.base_version !== board.version;
  const unsupported = result.unsupported ?? p?.unsupported ?? [];
  const risk = p ? RISK[p.risk] : null;
  return (
    <div ref={ref} className="bd-patch" role="group" aria-label="Vorschlag für dein Board" data-tour="board-patch">
      <button type="button" className="icon-btn bd-patch-x" onClick={onReject} aria-label="Vorschlag verwerfen" disabled={busy}>
        ✕
      </button>
      {result.message && (
        <p className="bd-patch-msg">
          <Icon name="sparkles" size={15} /> {result.message}
        </p>
      )}
      {p?.changes && p.changes.length > 0 && (
        <div className="bd-patch-body">
          <ul className="bd-changes">
            {p.changes.map((c, i) => (
              <li key={i}>
                <Icon name={KIND[c.kind] ?? 'edit'} size={14} />
                <span>{c.text}</span>
              </li>
            ))}
          </ul>
          {after && (
            <div className="bd-diff" aria-hidden="true">
              <figure>
                <Mini cells={cellsOfSpec(board.spec.widgets)} accent={board.accent} catalogue={catalogue} />
                <figcaption>Jetzt</figcaption>
              </figure>
              <span className="bd-diff-arrow">→</span>
              <figure>
                <Mini cells={cellsOfSpec(after)} accent={p?.after?.accent || board.accent} catalogue={catalogue} highlight={hot} />
                <figcaption>Danach</figcaption>
              </figure>
            </div>
          )}
        </div>
      )}
      {risk && <p className={`bd-risk ${risk.cls}`}>{risk.text}</p>}
      {stale && <p className="bd-risk normal">Das Board wurde inzwischen geändert. Die Änderung wird auf den aktuellen Stand angewendet.</p>}
      {unsupported.length > 0 && (
        <div className="bd-callout">
          <b>Dafür gibt es noch kein Widget:</b>
          <ul>
            {unsupported.map((u, i) => (
              <li key={i}>
                {u.need}
                {u.reason ? ` – ${u.reason}` : ''}
              </li>
            ))}
          </ul>
          <button type="button" className="btn secondary small" onClick={() => openBuild({ title: `Board-Widget: ${unsupported[0].need.slice(0, 60)}`, text: `Für Living Boards fehlt mir ein Widget: ${unsupported.map((u) => `${u.need}${u.reason ? ` (${u.reason})` : ''}`).join('; ')}` })}>
            <Icon name="hammer" size={14} /> In der Werkstatt bauen lassen
          </button>
        </div>
      )}
      {result.errors && result.errors.length > 0 && (
        <ul className="bd-errors">
          {result.errors.slice(0, 4).map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {p && p.status === 'pending' && (
        <div className="bd-patch-actions">
          <button type="button" className="btn" onClick={onApply} disabled={busy} data-tour="board-patch-apply">
            <Icon name="check" size={15} /> Übernehmen
          </button>
          <button type="button" className="btn secondary" onClick={onReject} disabled={busy}>
            Verwerfen
          </button>
          <span className="muted small">Jede Änderung wird eine Version – du kannst sie sofort rückgängig machen.</span>
        </div>
      )}
    </div>
  );
}
