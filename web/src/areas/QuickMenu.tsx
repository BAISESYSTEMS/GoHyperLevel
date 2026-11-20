import { useState } from 'react';
import { useT } from '../i18n';
import { Icon } from '../icons';
import { Later, lazyPages } from '../lazy';

// The menu itself (QuickMenuPanel.tsx) is a chunk of its own: only the button is part of the first download.
const { QuickMenu } = lazyPages(() => import('./QuickMenuPanel'), 'QuickMenu');

/** The small button next to the logo that opens the quick menu. */
export function QuickMenuButton() {
  const t = useT('simple');
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = () => setAnchor(null);
  return (
    <span className="qm-wrap">
      <button type="button" className="qm-btn" aria-expanded={!!anchor} aria-label={t('Schnelleinstellungen')} title={t('Modus, Design und Sprache')} onClick={(e) => {
          // measure now: React may run the updater later, when e.currentTarget is already null (tests/updater-events.test.ts)
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor((a) => (a ? null : r));
        }} data-tour="quick-menu">
        <Icon name="settings" size={16} />
      </button>
      {anchor && (
        <Later>
          <QuickMenu onClose={close} anchor={anchor} />
        </Later>
      )}
    </span>
  );
}
