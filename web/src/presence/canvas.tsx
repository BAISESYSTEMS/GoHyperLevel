import { useT } from '../i18n';

/**
 * Canvas: the people on a board in its header (the board's own realtime – services/canvas-hub.ts – draws their cursors).
 * Clicking somebody follows them: the view stays centred on their cursor until you pan or zoom yourself, click again or
 * press ✕. Part of the presence namespace so the texts are translated with the rest of Live-Zusammenarbeit.
 */

export interface CanvasPerson {
  clientId: string;
  name: string;
  color: string;
  kind: 'user' | 'agent';
}

export function CanvasPeople({ people, following, onFollow }: { people: CanvasPerson[]; following: string | null; onFollow: (clientId: string | null) => void }) {
  const t = useT('presence');
  const followed = people.find((p) => p.clientId === following);
  return (
    <div className="cv-people" data-tour="canvas-people" role="group" aria-label={t('Wer ist auf dem Board')}>
      {people.slice(0, 6).map((p) => {
        const mark = p.kind === 'agent' ? '✦' : p.name.slice(0, 1).toUpperCase();
        if (p.clientId === 'me')
          return (
            <span key={p.clientId} className="cv-avatar" style={{ background: p.color }} title={t('{name} (du)', { name: p.name })}>
              {mark}
            </span>
          );
        const on = following === p.clientId;
        const label = on ? t('{name} nicht mehr folgen', { name: p.name }) : t('{name} folgen – deine Ansicht geht mit', { name: p.name });
        return (
          <button key={p.clientId} type="button" className={`cv-avatar cv-avatar-btn${p.kind === 'agent' ? ' agent' : ''}${on ? ' following' : ''}`} style={{ background: p.color, ['--c' as string]: p.color }} onClick={() => onFollow(on ? null : p.clientId)} aria-pressed={on} aria-label={label} title={label}>
            {mark}
          </button>
        );
      })}
      {people.length > 6 && <span className="cv-avatar more">+{people.length - 6}</span>}
      {followed && (
        <span className="cv-follow" style={{ ['--c' as string]: followed.color }} role="status">
          {t('Du folgst {name}', { name: followed.name })}
          <button type="button" onClick={() => onFollow(null)} aria-label={t('Nicht mehr folgen')}>
            ✕
          </button>
        </span>
      )}
    </div>
  );
}
