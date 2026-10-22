import { useEffect, useState, type ComponentType } from 'react';
import { api } from '../api';
import { VersionTag, leftDemo } from '../demo';
import { Icon, type IconName } from '../icons';
import { Later, lazyPages } from '../lazy';
import { ChatBadge } from '../pages/collab-badge';
import { ProjectSwitcher } from '../nav';
import { useT } from '../i18n';
import { LanguageMenu } from '../i18n/LanguageMenu';
import { peersByRoute, usePresence } from '../presence/store';
import type { Session } from '../session';
import { BASE, act, navigate } from '../ui';
import { useSizeClass } from '../ios/viewport';
import { luminance } from './color';
import { modeTokens } from './css';
import { DEPT_OF_ROUTE } from './depts';
import { resolveDark, setShowAll, toggleSidebar, useLook } from './store';
import { useNavSplit } from '../areas/adaptive';
import { AREA_BADGE } from '../areas/info';
import { QuickMenuButton } from '../areas/QuickMenu';
import { FocusEnter } from '../focus/FocusEnter';
import '../areas/shell.css';

/**
 * The sidebar of the app shell: logo (wide logo or square mark, light/dark variants by the sidebar's own
 * tone), project switcher, menu with department colours, hidden entries ("Alle Bereiche anzeigen"), and the
 * narrow "rail" mode – icons only with tooltips, sub-menus as flyouts, Ctrl/⌘+B to switch, remembered per user.
 * Below 600 px (phones, a foldable folded, iPad Slide Over) the menu is a drawer behind the bottom bar's "Mehr"; from 600 px to
 * 1023 px (iPad portrait, Split View, a foldable unfolded) the rail stays on screen whatever the preference; from 1024 px the full
 * sidebar or the rail the person chose (web/src/ios/platform.ts, docs/ios-web-app.md).
 */

type NavItem = [string, IconName, string, string];
export type NavEntry = ['group', string] | NavItem;

// Live-Zusammenarbeit: colleagues' avatars next to the entry they are on ("Team im Menü zeigen", presence/Presence.tsx),
// and for the keyboard a button right after the link that opens the same details.
const { NavDots, NavPeopleKey } = lazyPages(() => import('../presence/Presence'), 'NavDots', 'NavPeopleKey');
// Einfach-Modus: everything that is not in the menu, searchable, with "Anheften" – a chunk of its own (web/src/areas/MorePanel.tsx).
const { MorePanel } = lazyPages(() => import('../areas/MorePanel'), 'MorePanel');

const WIDE = '(min-width: 600px)';
function useWide() {
  const [wide, setWide] = useState(() => (typeof matchMedia === 'function' ? matchMedia(WIDE).matches : true));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/** A menu link (the shared Link has no data-dept / aria-label). */
function NavLink({ to, className, tour, dept, label, children, ...events }: { to: string; className?: string; tour?: string; dept?: string; label?: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const href = `${BASE}/${to}`;
  return (
    <a
      {...events}
      href={href}
      className={className}
      data-tour={tour}
      data-dept={dept}
      aria-label={label}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

interface Tip {
  label: string;
  x: number;
  y: number;
}
const anchor = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.right + 10, y: r.top + r.height / 2 };
};

export function Sidebar({ session, cur, route, open, entries, childrenOf, preload }: { session: Session; cur: string; route: string[]; open: boolean; entries: NavEntry[]; childrenOf: Record<string, ComponentType<{ cur: string[] }>>; preload: (route: string) => void }) {
  // `entries` arrive translated (main.tsx → translateNav); the sidebar's own words come from the shell catalog too.
  const t = useT('shell');
  const look = useLook();
  const wide = useWide();
  // Tablet widths always get the rail: the full menu would take a third of an iPad in portrait.
  const medium = useSizeClass() === 'medium';
  const rail = (look.prefs.sidebar === 'rail' || medium) && wide;
  const [tip, setTip] = useState<Tip | null>(null);
  const [fly, setFly] = useState<{ route: string; label: string; x: number; y: number } | null>(null);
  const presence = usePresence();
  const around = presence.live && presence.prefs.menu ? peersByRoute(presence.peers) : null;
  const dots = (r: string, label: string) => {
    const peers = around?.get(r);
    return peers ? (
      <Later>
        <NavDots peers={peers} label={label} rail={rail} />
      </Later>
    ) : null;
  };
  const dotsKey = (r: string, label: string) => {
    const peers = around?.get(r);
    return peers ? (
      <Later>
        <NavPeopleKey peers={peers} label={label} rail={rail} />
      </Later>
    ) : null;
  };

  // Ctrl/⌘+B: narrow ↔ wide (not inside rich-text fields, where it means "bold").
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'b' || !wide) return;
      const t = e.target as HTMLElement | null;
      if (t?.isContentEditable || t?.closest?.('[contenteditable="true"]')) return;
      e.preventDefault();
      void toggleSidebar();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [wide]);
  useEffect(() => (setTip(null), setFly(null)), [rail, cur]);

  // Logo variants follow the sidebar's own colour: dark sidebars take the "for dark" logo when there is one.
  const sideDark = luminance(modeTokens(look.prefs.theme, resolveDark(look.prefs.mode)).side) < 0.4;
  const b = session.branding;
  const wideLogo = (sideDark ? b.logo_dark_url : '') || b.logo_url;
  const mark = (sideDark ? b.mark_dark_url : '') || b.mark_url;
  const showName = b.show_name !== 'no' || (!wideLogo && !mark);

  // Menu: entries the person may use, minus the hidden ones (unless "show all"), headings only above a visible entry.
  const hidden = look.prefs.hidden;
  const isShown = (r: string) => look.showAll || !hidden.includes(r) || r === cur;
  // Einfach-Modus (goals chosen): only the core entries, pinned and promoted ones in the list – the rest under "Mehr",
  // Einstellungen pinned at the bottom (web/src/areas/adaptive.ts).
  const split = useNavSplit(entries.filter((n) => n[0] !== 'group' && isShown(n[0])).map((n) => n[0]), cur);
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [cur]);
  const inMenu = (r: string) => !split.simple || (split.core.includes(r) && r !== 'settings');
  const shown = entries.filter((n) => (n[0] === 'group' ? !split.simple : isShown(n[0]) && inMenu(n[0])));
  const items = shown.filter((n, i) => n[0] !== 'group' || (shown[i + 1] && shown[i + 1][0] !== 'group'));
  const moreCount = split.more.filter((r) => r !== 'settings').length;
  const hiddenCount = entries.filter((n) => n[0] !== 'group' && hidden.includes(n[0]) && n[0] !== cur).length;
  const deptOfGroup = (i: number) => {
    const next = items.slice(i + 1).find((n) => n[0] !== 'group');
    return next ? DEPT_OF_ROUTE[next[0]] : undefined;
  };

  const tipFor = (label: string) => ({
    onPointerEnter: (e: React.PointerEvent) => rail && setTip({ label, ...anchor(e.currentTarget) }),
    onPointerLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent) => rail && setTip({ label, ...anchor(e.currentTarget) }),
    onBlur: () => setTip(null),
  });
  // Items with a sub-menu open it as a flyout in the rail instead of a tooltip.
  const flyFor = (r: string, label: string) => ({
    onPointerEnter: (e: React.PointerEvent) => rail && setFly({ route: r, label, ...anchor(e.currentTarget) }),
    onFocus: (e: React.FocusEvent) => rail && setFly({ route: r, label, ...anchor(e.currentTarget) }),
  });
  const logout = async () => {
    await act(() => api.post('/api/auth/logout'));
    leftDemo();
    location.href = BASE;
  };
  const toggleLabel = rail ? t('Seitenleiste erweitern (Strg B)') : t('Seitenleiste verkleinern (Strg B)');
  const initial = (session.user.name || '?').slice(0, 1).toUpperCase();

  return (
    // On phones the open menu is a drawer over the page: a dialog that keeps the keyboard until it closes (main.tsx).
    <aside id="side-nav" className={`side${open ? ' open' : ''}`} role={open ? 'dialog' : undefined} aria-modal={open || undefined} aria-label={open ? t('Menü') : undefined} data-tour="sidebar" onScroll={() => (setTip(null), setFly(null))}>
      <div className="brand" data-tour="brand">
        {rail ? (
          mark || wideLogo ? (
            <img className={mark ? 'brand-mark' : 'brand-wide'} src={mark || wideLogo} alt={b.name} />
          ) : (
            (b.name === 'HyperLevel' ? <img className="brand-mark" src="/icon.svg" alt="" /> : <span className="logo">{b.name.slice(0, 1).toUpperCase()}</span>)
          )
        ) : (
          <>
            {wideLogo ? <img className="brand-wide" src={wideLogo} alt={showName ? '' : b.name} /> : mark ? <img className="brand-mark" src={mark} alt="" /> : (b.name === 'HyperLevel' ? <img className="brand-mark" src="/icon.svg" alt="" /> : <span className="logo">{b.name.slice(0, 1).toUpperCase()}</span>)}
            {showName && <span className="brand-name">{b.name}</span>}
            <QuickMenuButton />
          </>
        )}
        {wide && !medium && !look.locks.sidebar && (
          <button className="side-toggle" onClick={() => void toggleSidebar()} aria-label={toggleLabel} data-tour="sidebar-toggle" {...tipFor(toggleLabel)}>
            <Icon name={rail ? 'panelOpen' : 'panelClose'} size={18} />
          </button>
        )}
      </div>
      <Later>
        <FocusEnter />
      </Later>
      <ProjectSwitcher />
      <nav>
        {session.user.role === 'admin' && (
          <>
            <span className="nav-item">
              <NavLink to="agency" className={cur === 'agency' ? 'on' : ''} tour="nav-agency" dept="agency" label={rail ? t('Agentur') : undefined} {...tipFor(t('Agentur'))}>
                <Icon name="agency" size={18} />
                <span className="nav-label">{t('Agentur')}</span>
                {dots('agency', t('Agentur'))}
              </NavLink>
              {dotsKey('agency', t('Agentur'))}
            </span>
            <div className="group">{t('Sub-Account')}</div>
          </>
        )}
        {items.map((n, i) => {
          if (n[0] === 'group') {
            return (
              <div key={`g${i}`} className="group" data-dept={n[1] ? deptOfGroup(i) : undefined}>
                {n[1]}
              </div>
            );
          }
          const [r, icon, label] = n as NavItem;
          const Children = childrenOf[r];
          const isHidden = hidden.includes(r);
          return (
            <span
              key={r}
              className={`nav-item${isHidden ? ' nav-hidden' : ''}`}
              onPointerEnter={() => preload(r)}
              onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFly(null)}
              onPointerLeave={() => setFly(null)}
            >
              <NavLink to={r} className={cur === r ? 'on' : ''} tour={`nav-${r}`} dept={DEPT_OF_ROUTE[r]} label={rail ? label : undefined} {...(Children ? flyFor(r, label) : tipFor(label))}>
                <Icon name={icon} size={18} />
                <span className="nav-label">{label}</span>
                {AREA_BADGE[r] && !rail && <small className="nav-beta">{t(AREA_BADGE[r])}</small>}
                {r === 'team-chat' && <ChatBadge />}
                {dots(r, label)}
              </NavLink>
              {dotsKey(r, label)}
              {Children && !rail && <Later>{<Children cur={route} />}</Later>}
              {Children && rail && fly?.route === r && (
                <div className="rail-flyout" style={{ left: fly.x - 14, top: fly.y }}>
                  <div className="rail-flyout-box">
                    <div className="rail-flyout-title">{label}</div>
                    <Later>
                      <Children cur={route} />
                    </Later>
                  </div>
                </div>
              )}
            </span>
          );
        })}
      </nav>
      {split.simple && (
        <div className="side-more side-simple" data-tour="nav-more-box">
          <button className={`side-showall side-morebtn${more ? ' on' : ''}`} onClick={() => setMore(!more)} aria-expanded={more} aria-haspopup="dialog" data-tour="nav-more" aria-label={t('Mehr: alle Bereiche ({n})', { n: moreCount })} {...tipFor(t('Mehr: alle Bereiche ({n})', { n: moreCount }))}>
            <Icon name="grid" size={16} />
            {!rail && (
              <span>
                {t('Mehr')} <small className="side-morecount">{moreCount}</small>
              </span>
            )}
          </button>
          {entries.some((n) => n[0] === 'settings') && (
            <NavLink to="settings" className={`side-showall side-settings${cur === 'settings' ? ' on' : ''}`} tour="nav-settings" label={rail ? t('Einstellungen') : undefined} {...tipFor(t('Einstellungen'))}>
              <Icon name="settings" size={16} />
              {!rail && <span>{t('Einstellungen')}</span>}
            </NavLink>
          )}
          {more && (
            <Later>
              <MorePanel entries={entries} core={split.core} more={split.more} promoted={split.promoted} hiddenCount={hiddenCount} onClose={() => setMore(false)} />
            </Later>
          )}
        </div>
      )}
      {!split.simple && (hiddenCount > 0 || look.showAll) ? (
        <div className="side-more">
          <button
            className="side-showall"
            onClick={() => setShowAll(!look.showAll)}
            aria-label={look.showAll ? t('Ausgeblendete Bereiche wieder verbergen') : t('Alle Bereiche anzeigen')}
            data-tour="nav-show-all"
            {...tipFor(look.showAll ? t('Ausgeblendete verbergen') : t('Alle Bereiche anzeigen ({n} ausgeblendet)', { n: hiddenCount }))}
          >
            <Icon name={look.showAll ? 'eyeOff' : 'opened'} size={16} />
            {!rail && <span>{look.showAll ? t('Ausgeblendete verbergen') : t('Alle Bereiche anzeigen ({n})', { n: hiddenCount })}</span>}
          </button>
        </div>
      ) : null}
      <div className="foot" data-tour="account">
        {rail ? (
          <>
            <span className="side-avatar" title={session.user.name} {...tipFor(session.user.name)}>
              {initial}
            </span>
            <button className="side-iconbtn" onClick={() => navigate('settings/appearance')} aria-label={t('Darstellung')} {...tipFor(t('Darstellung'))}>
              <Icon name="palette" size={17} />
            </button>
            <LanguageMenu tip={tipFor} />
            <button className="side-iconbtn" onClick={() => void logout()} aria-label={t('Abmelden')} {...tipFor(t('Abmelden'))}>
              <Icon name="logout" size={17} />
            </button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="side-foot-name" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {session.user.name}
              </span>
              <LanguageMenu />
              <button className="side-iconbtn" onClick={() => navigate('settings/appearance')} aria-label={t('Darstellung anpassen')} title={t('Darstellung anpassen')} data-tour="nav-appearance">
                <Icon name="palette" size={17} />
              </button>
            </div>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void logout();
              }}
            >
              {t('Abmelden')}
            </a>
            <br />
            <VersionTag />
          </>
        )}
      </div>
      {tip && !fly && (
        <div className="rail-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.label}
        </div>
      )}
    </aside>
  );
}
