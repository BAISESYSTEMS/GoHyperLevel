import { Icon } from '../icons';

/**
 * „Lernen“ links in empty states, page heads, the demo banner and the start page (docs/academy.md → Einstieg). They start the
 * tour that fits the page (or a given one) and load the tour engine only on click, so this file stays in the first download
 * without pulling the catalog in. Without a tour for the page the link opens the academy.
 */

/** The first tour of the academy: „So findest du dich zurecht“ (+ „Die Akademie“) – about ten minutes. */
export const FIRST_TOUR = 'start-basics';

const curPath = () => location.pathname.replace(/^\/app\/?/, '').replace(/\/+$/, '');

/** Start a tour by id, or the tour of a page (`contacts`, `settings/telephony` …; default: the open page). */
export function learn(tourOrPath?: string) {
  void import('./engine').then((m) => m.learnHere(tourOrPath ?? curPath()));
}

const LABELS = { tour: 'Tour starten', learn: 'Lernen', guided: 'Geführte Tour starten', academy: 'Academy starten' } as const;

export function LearnLink({ tour, label = 'tour', className = 'btn small secondary' }: { tour?: string; label?: keyof typeof LABELS; className?: string }) {
  return (
    <button type="button" className={`${className} learn-link`} data-tour="learn" onClick={() => learn(tour)} title="Geführte Tour zu diesem Bereich – direkt in der echten Oberfläche">
      <Icon name="academy" size={14} /> {LABELS[label]}
    </button>
  );
}
