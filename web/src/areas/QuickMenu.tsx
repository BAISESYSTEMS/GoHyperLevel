import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocale, setLocale, useT } from '../i18n';
import { Icon } from '../icons';
import { navigate, useFocusLayer } from '../ui';
import { update, useLook } from '../theme/store';
import { DEFAULT_GOAL, isSimple } from '../../../server/services/areas-model';

const LAST_GOALS = 'hl.simple-goals';
const readLast = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_GOALS) || '[]');
    return Array.isArray(v) && v.length ? v : [DEFAULT_GOAL];
  } catch {
    return [DEFAULT_GOAL];
  }
};

/**
 * The quick menu behind the logo (top left): Einfach/Profi mode, light/dark/system design and language in one place, plus links to
 * the full design settings and the Academy. "Profi" shows every area (goal "Alles"); "Einfach" restores the goals chosen last.
 * It opens in a portal at the button's position, so the sidebar's scroll box never clips it; a click outside closes it.
 */
export function QuickMenu({ onClose, anchor }: { onClose: () => void; anchor?: DOMRect }) {
  const t = useT('simple');
  const look = useLook();
  const locale = useLocale();
  const box = useRef<HTMLDivElement>(null);
  useFocusLayer(box, onClose, { first: true });
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current && !box.current.contains(t) && !(t instanceof Element && t.closest('.qm-btn'))) onClose();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [onClose]);
  const left = anchor ? Math.max(8, Math.min(anchor.left, window.innerWidth - 296)) : 12;
  const top = anchor ? anchor.bottom + 6 : 56;
  const simple = isSimple(look.prefs.goals);
  const setMode = (pro: boolean) => {
    if (pro === !simple) return;
    if (pro) {
      try { localStorage.setItem(LAST_GOALS, JSON.stringify(look.prefs.goals)); } catch { /* private mode */ }
      void update({ goals: ['all'], goal_asked: true });
    } else void update({ goals: readLast(), goal_asked: true });
  };
  const go = (to: string) => (onClose(), navigate(to));
  const seg = (label: string, on: boolean, click: () => void, disabled = false) => (
    <button type="button" className={`qm-seg${on ? ' on' : ''}`} aria-pressed={on} onClick={click} disabled={disabled}>{label}</button>
  );
  return createPortal(
    <div className="qm-pop" ref={box} role="dialog" aria-modal="true" aria-label={t('Schnelleinstellungen')} style={{ top, left }}>
      <div className="qm-head">
        <strong>{t('Schnelleinstellungen')}</strong>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('Schließen')}>✕</button>
      </div>
      <div className="qm-row">
        <span className="qm-label">{t('Modus')}</span>
        <div className="qm-segs" role="group">
          {seg(t('Einfach'), simple, () => setMode(false), !!look.locks.modules)}
          {seg(t('Profi'), !simple, () => setMode(true), !!look.locks.modules)}
        </div>
      </div>
      <div className="qm-row">
        <span className="qm-label">{t('Design')}</span>
        <div className="qm-segs" role="group">
          {seg(t('Hell'), look.prefs.mode === 'light', () => void update({ mode: 'light' }), look.locks.theme)}
          {seg(t('Dunkel'), look.prefs.mode === 'dark', () => void update({ mode: 'dark' }), look.locks.theme)}
          {seg(t('System'), look.prefs.mode !== 'light' && look.prefs.mode !== 'dark', () => void update({ mode: 'system' }), look.locks.theme)}
        </div>
      </div>
      <div className="qm-row">
        <span className="qm-label">{t('Sprache')}</span>
        <div className="qm-segs" role="group">
          {seg('Deutsch', locale === 'de', () => void setLocale('de'))}
          {seg('English', locale === 'en', () => void setLocale('en'))}
        </div>
      </div>
      <div className="qm-links">
        <button type="button" className="btn secondary" onClick={() => go('settings/appearance')}>{t('Design anpassen …')}</button>
        <button type="button" className="btn secondary" onClick={() => go('academy')}>{t('Academy starten')}</button>
      </div>
    </div>,
    document.body,
  );
}

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
      {anchor && <QuickMenu onClose={close} anchor={anchor} />}
    </span>
  );
}
