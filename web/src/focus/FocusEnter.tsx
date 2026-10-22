import { useT } from '../i18n';
import { Icon } from '../icons';
import { useRoute } from '../ui';
import { useCompanion } from '../companion/store';
import { enterFocus, exitFocus } from './store';

/**
 * The way into Fokus-Modus mit Companion at the top left: under the logo in the sidebar (a square button in the narrow rail), next
 * to the menu button in the phone's top bar. It names the companion ("mit Jarvis"). Inside focus mode the same button (in the
 * drawer) leads back to the normal layout.
 */
export function FocusEnter({ place = 'side' }: { place?: 'side' | 'top' }) {
  const t = useT('focus');
  const on = useRoute()[0] === 'focus';
  const { name } = useCompanion();
  const label = on ? t('Fokus beenden') : t('Fokus');
  const hint = on ? t('Zurück zur normalen Ansicht') : t('Fokus-Modus mit {name}: fragen und erledigen lassen', { name });
  if (place === 'top')
    return on ? null : (
      <button type="button" className="btn secondary small fx-enter-top" onClick={enterFocus} title={hint} aria-label={hint} data-tour="focus-enter-top">
        <Icon name="goal" size={15} /> {label}
      </button>
    );
  return (
    <button type="button" className="fx-enter" onClick={on ? exitFocus : enterFocus} title={hint} aria-label={hint} data-tour="focus-enter">
      <Icon name="goal" size={17} />
      <span>{label}</span>
      {!on && <small>{t('mit {name}', { name })}</small>}
    </button>
  );
}
