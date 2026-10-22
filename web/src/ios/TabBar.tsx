import { Menu } from 'lucide-react';
import { Icon } from '../icons';
import { BASE, navigate } from '../ui';
import { useT } from '../i18n';
import { useUnread } from './badge';
import { pickTabs } from './tabs';

/**
 * The bottom bar on phones, a foldable folded and iPad Slide Over / narrow Split View (width < 600 px, CSS decides; from 600 px
 * the sidebar rail takes over). Four of the most used areas the person may use, and "Mehr" for the full menu. Big targets (≥ 52 px),
 * the home indicator's safe area, hidden while the keyboard is up. Not shown inside the Android app (it has its own navigation).
 */

export function TabBar({ entries, visible, cur, onMore }: { entries: (readonly unknown[])[]; visible: (route: string) => boolean; cur: string; onMore: () => void }) {
  const t = useT('shell');
  const unread = useUnread();
  const tabs = pickTabs(entries, visible, cur);
  return (
    <nav className="tabbar" aria-label={t('Hauptmenü')} data-tour="tabbar">
      {tabs.map((tab) => (
        <a
          key={tab.route}
          href={`${BASE}/${tab.route}`}
          className={`tab${cur === tab.route ? ' on' : ''}`}
          aria-current={cur === tab.route ? 'page' : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.button !== 0) return;
            e.preventDefault();
            navigate(`${BASE}/${tab.route}`);
          }}
        >
          <span className="tab-ico">
            <Icon name={tab.icon} size={22} />
            {tab.route === 'conversations' && unread > 0 && <span className="tab-badge" aria-label={t('{n} ungelesen', { n: unread })}>{unread > 99 ? '99+' : unread}</span>}
          </span>
          {/* the short labels of ios/tabs.ts are German message ids; menu labels arrive translated */}
          <span className="tab-label">{t(tab.label)}</span>
        </a>
      ))}
      <button type="button" className="tab" onClick={onMore} aria-label={t('Mehr: ganzes Menü')} data-tour="tabbar-more">
        <span className="tab-ico">
          <Menu size={22} />
        </span>
        <span className="tab-label">{t('Mehr')}</span>
      </button>
    </nav>
  );
}
