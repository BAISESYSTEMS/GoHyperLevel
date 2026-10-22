import { useState } from 'react';
import { useAppInfo } from '../demo';
import { Icon } from '../icons';
import { navigate } from '../ui';
import { FIRST_TOUR, learn } from './learn';
import { useAcademy } from './progress';

/**
 * „In 10 Minuten startklar – Academy starten“: the first suggestion on the start page (Dashboard, Agentur) and in the goal setup
 * of new logins (areas/GoalSetup.tsx). Shown until the first tour is done – on a public demo always, since all visitors share
 * one login – and hidden for this browser with ✕.
 */

const KEY = 'pghl.academyWelcome';
const dismissed = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

export function AcademyWelcome({ compact, onStart }: { compact?: boolean; onStart?: () => void }) {
  const academy = useAcademy();
  const demo = !!useAppInfo()?.demo?.enabled;
  const [hidden, setHidden] = useState(dismissed);
  if (!compact && (hidden || !academy || (!demo && academy.tours[FIRST_TOUR]?.done))) return null;
  const start = () => {
    onStart?.();
    learn(FIRST_TOUR);
  };
  return (
    <div className={`academy-welcome${compact ? ' compact' : ''}`} role="region" aria-label="Academy" data-tour="academy-welcome">
      <Icon name="academy" size={compact ? 20 : 26} />
      <div className="grow">
        <strong>In 10 Minuten startklar – Academy starten</strong>
        <p>Die geführte Tour zeigt dir Menü, Suche, Hilfe und die wichtigsten Bereiche – direkt in der echten Oberfläche, Schritt für Schritt. Danach findest du für jeden Bereich eine eigene Tour.</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={start} data-tour="academy-welcome-start">
            Academy starten
          </button>
          {!compact && (
            <button type="button" className="btn secondary" onClick={() => navigate('academy')}>
              Alle Touren ansehen
            </button>
          )}
        </div>
      </div>
      {!compact && (
        <button
          type="button"
          className="icon-btn"
          aria-label="Schließen"
          onClick={() => {
            setHidden(true);
            try {
              localStorage.setItem(KEY, '1');
            } catch {
              /* private window: hidden until the next reload */
            }
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
