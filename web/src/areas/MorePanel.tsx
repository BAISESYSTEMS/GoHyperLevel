import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { Icon, type IconName } from '../icons';
import { navigate, useFocusLayer } from '../ui';
import { useLook } from '../theme/store';
import { setPinned } from './adaptive';
import { AREA_BADGE, AREA_DESC, AREA_KEYWORDS } from './info';
import './simple.css';

/**
 * "Mehr" in the sidebar of the Einfach-Modus: every area that is not in the menu, grouped like the full menu, searchable,
 * each with a one-line description and "Anheften". The entries in the menu can be moved under "Mehr" from here as well.
 * A dialog: ✕ and Esc close it, the focus comes back to the "Mehr" button.
 */

type Row = readonly [string, ...unknown[]];

export function MorePanel({ entries, core, more, promoted, hiddenCount, onClose }: { entries: readonly Row[]; core: string[]; more: string[]; promoted: string[]; hiddenCount: number; onClose: () => void }) {
  const t = useT('simple');
  const look = useLook();
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useFocusLayer(box, onClose, { first: 'input' });
  // [route, icon, label] with its menu heading – labels arrive translated (main.tsx → translateNav)
  const rows = useMemo(() => {
    let section = '';
    const out: { route: string; icon: IconName; label: string; section: string }[] = [];
    for (const n of entries) {
      if (n[0] === 'group') section = String(n[1] ?? '');
      else out.push({ route: n[0], icon: n[1] as IconName, label: String(n[2]), section });
    }
    return out;
  }, [entries]);
  const needle = q.trim().toLowerCase();
  const match = (r: (typeof rows)[number]) => !needle || `${r.label} ${t(AREA_DESC[r.route] ?? '')} ${AREA_KEYWORDS[r.route] ?? ''} ${r.route}`.toLowerCase().includes(needle);
  const others = rows.filter((r) => more.includes(r.route) && r.route !== 'settings' && match(r));
  const mine = rows.filter((r) => core.includes(r.route) && r.route !== 'settings' && match(r));
  const sections = [...new Set(others.map((r) => r.section))];
  const go = (route: string) => (onClose(), navigate(route));
  const item = (r: (typeof rows)[number], pinned: boolean) => (
    <li key={r.route} className="mp-item">
      <button type="button" className="mp-open" onClick={() => go(r.route)} data-tour={`more-${r.route}`}>
        <Icon name={r.icon} size={18} />
        <span className="mp-text">
          <b>
            {r.label}
            {AREA_BADGE[r.route] && <small className="nav-beta">{t(AREA_BADGE[r.route])}</small>}
          </b>
          {AREA_DESC[r.route] && <small className="muted">{t(AREA_DESC[r.route])}</small>}
        </span>
        {promoted.includes(r.route) && <span className="mp-tag">{t('oft genutzt')}</span>}
      </button>
      <button
        type="button"
        className="mp-pin"
        onClick={() => void setPinned(r.route, !pinned, look.prefs)}
        aria-label={pinned ? t('{name} unter „Mehr“ verschieben', { name: r.label }) : t('{name} ins Menü heften', { name: r.label })}
        title={pinned ? t('Unter „Mehr“ verschieben') : t('Ins Menü heften')}
      >
        <Icon name={pinned ? 'eyeOff' : 'pin'} size={15} /> <span>{pinned ? t('Lösen') : t('Anheften')}</span>
      </button>
    </li>
  );
  // a portal: the sidebar scrolls and (on phones) slides, which would clip or move a fixed panel inside it
  return createPortal(
    <div className="mp-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="mp" role="dialog" aria-modal="true" aria-label={t('Alle Bereiche')} tabIndex={-1} data-tour="more-panel">
        <div className="mp-head">
          <h2>{t('Alle Bereiche')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('Schließen')}>
            ✕
          </button>
        </div>
        <input className="mp-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Bereich suchen…')} aria-label={t('Bereich suchen…')} />
        <div className="mp-body">
          {sections.map((s) => (
            <section key={s || 'top'}>
              <h3>{s || t('Allgemein')}</h3>
              <ul>{others.filter((r) => r.section === s).map((r) => item(r, false))}</ul>
            </section>
          ))}
          {!others.length && !needle && <p className="muted small">{t('Alle Bereiche sind schon in deinem Menü.')}</p>}
          {mine.length > 0 && (
            <section>
              <h3>{t('In deinem Menü')}</h3>
              <ul>{mine.map((r) => item(r, true))}</ul>
            </section>
          )}
          {!others.length && !mine.length && needle && <p className="muted small">{t('Kein Bereich gefunden.')}</p>}
        </div>
        <div className="mp-foot muted small">
          <a href="#" onClick={(e) => (e.preventDefault(), go('settings/appearance'))}>
            {t('Ziele und Menü anpassen')}
          </a>
          {hiddenCount > 0 && <span> · {t.plural(hiddenCount, { one: '{n} Bereich ausgeblendet', other: '{n} Bereiche ausgeblendet' })}</span>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
