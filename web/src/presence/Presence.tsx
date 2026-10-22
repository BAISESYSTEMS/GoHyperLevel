import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Users } from 'lucide-react';
import { api } from '../api';
import { useT, type TFn } from '../i18n';
import { can, useSession } from '../session';
import { BASE, Check, navigate, toastError } from '../ui';
import { ownPresence, routeOf, type CursorMode, type PresencePrefs } from '../../../server/services/presence-model';
import { onCursors, presenceClient, startPresence, surface, touchOnly } from './client';
import { people, setPresence, usePresence, type Peer } from './store';
import './presence.css';

/**
 * Live-Zusammenarbeit überall – the visible parts (docs/collaboration.md), one lazy chunk a moment after the page:
 *   PresenceLayer  the tab's connection, "Anna hat hier gerade gespeichert" and "bearbeitet das gerade auch" above the
 *                  page, and other people's cursors (relative to the page content or a page's own surface)
 *   PresenceBar    avatars of the people on this page in the top bar + the "Team ist hier" popover with the switches
 *   NavDots        avatars next to a menu entry where colleagues are (sidebar, "Team im Menü zeigen"), with
 *   NavPeopleKey   the same for the keyboard: a button right after the menu link, visible while it has the focus
 * Pages with realtime of their own (inbox conversations, Canvas, Team-Chat, Living Boards) keep only the avatars.
 */

/** The menu as main.tsx hands it over (translated): [route, icon, label, permission] or a group heading. */
export type NavEntry = ['group', string] | [string, string, string, string];

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

const useLabels = (nav: NavEntry[]) => useMemo(() => new Map(nav.filter((n) => n[0] !== 'group').map((n) => [n[0], n[2]] as [string, string])), [nav]);

/** Where somebody is, in the reader's language: the menu entry, else the address (the server relays no labels from other browsers). */
function whereLabel(t: TFn, labels: Map<string, string>, p: { page: string | null }) {
  if (!p.page) return t('online');
  const r = routeOf(p.page);
  return labels.get(r) ?? (r === 'agency' ? t('Agentur') : p.page);
}

const go = (page: string) => navigate(`${BASE}${page === '/' ? '' : page}`);

/** Esc and a click outside close a popover; focus moves in and back to what opened it. */
function usePopover(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), close.current());
    // the button that opened it toggles it itself
    const onDown = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.pz-opener') && close.current();
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [ref]);
}

function Avatar({ p, size = '', children }: { p: { name: string; color: string; editing?: boolean }; size?: string; children?: ReactNode }) {
  return (
    <span className={`pz-av${size ? ` ${size}` : ''}${p.editing ? ' editing' : ''}`} style={{ '--c': p.color } as CSSProperties} aria-hidden="true">
      {children ?? initials(p.name)}
    </span>
  );
}

// --- the layer: connection, banners, cursors ----------------------------------------------------------------------------

export function PresenceLayer() {
  useEffect(() => startPresence(), []);
  return (
    <>
      <Banners />
      <Cursors />
    </>
  );
}

function Banners() {
  const t = useT('presence');
  const s = usePresence();
  const [quiet, setQuiet] = useState('');
  if (!s.live || ownPresence(s.page)) return null;
  const editing = people(s.peers.filter((p) => p.page === s.page && p.editing));
  const saved = s.saved && s.saved.page === s.page ? s.saved : null;
  const collide = s.editing && editing.length > 0 && quiet !== s.page;
  if (!saved && !collide) return null;
  const names = editing.map((p) => p.name).join(` ${t('und')} `);
  const dismissSaved = () => setPresence({ saved: null });
  const esc = (fn: () => void) => (e: React.KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), fn());
  return (
    <div className="pz-banners">
      {saved && (
        <div className="pz-banner saved" role="status" aria-live="polite" onKeyDown={esc(dismissSaved)} data-tour="presence-saved">
          <span className="pz-dot" aria-hidden="true" />
          <span className="pz-banner-text">{t('{name} hat hier gerade gespeichert.', { name: saved.name })}</span>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              dismissSaved();
              // the shell mounts the page again (the same as after an undo or a pull-to-refresh)
              window.dispatchEvent(new Event('pghl:refresh'));
            }}
          >
            {t('Neu laden')}
          </button>
          <button type="button" className="icon-btn" onClick={dismissSaved} aria-label={t('Hinweis schließen')}>
            ✕
          </button>
        </div>
      )}
      {collide && (
        <div className="pz-banner typing" role="status" aria-live="polite" onKeyDown={esc(() => setQuiet(s.page))} data-tour="presence-collision">
          <span className="pz-dot" aria-hidden="true" />
          <span className="pz-banner-text">
            <strong>{names}</strong> {t.plural(editing.length, { one: 'bearbeitet das gerade auch – stimmt euch ab, damit nichts überschrieben wird.', other: 'bearbeiten das gerade auch – stimmt euch ab, damit nichts überschrieben wird.' })}
          </span>
          <button type="button" className="icon-btn" onClick={() => setQuiet(s.page)} aria-label={t('Hinweis schließen')}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function Cursors() {
  const s = usePresence();
  const [, redraw] = useState(0);
  useEffect(() => {
    let raf = 0;
    const again = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => redraw((n) => n + 1));
    };
    const off = onCursors(again);
    const main = document.querySelector('.main');
    main?.addEventListener('scroll', again, { passive: true });
    window.addEventListener('resize', again);
    const fade = window.setInterval(() => presenceClient()?.fadeCursors(), 2000);
    return () => {
      off();
      main?.removeEventListener('scroll', again);
      window.removeEventListener('resize', again);
      window.clearInterval(fade);
      cancelAnimationFrame(raf);
    };
  }, []);
  const c = presenceClient();
  if (!c || !s.live || !c.cursors.size || touchOnly()) return null;
  const el = surface();
  const main = document.querySelector('.main');
  if (!el || !main) return null;
  const r = el.getBoundingClientRect();
  const m = main.getBoundingClientRect();
  const top = m.top + (main.querySelector('.topbar')?.getBoundingClientRect().height ?? 0);
  return (
    <div className="pz-cursors" aria-hidden="true">
      {[...c.cursors.values()].map((k) => {
        const x = r.left + k.x * r.width;
        const y = r.top + k.y;
        if (x < m.left || x > m.right - 4 || y < top || y > m.bottom - 4) return null;
        return (
          <div key={k.id} className="pz-cursor" style={{ transform: `translate(${x}px, ${y}px)`, '--c': k.color } as CSSProperties}>
            <svg width="18" height="18" viewBox="0 0 18 18">
              <path d="M1 1 L1 15 L5 11 L8 17 L10.5 16 L7.5 10 L13 10 Z" fill={k.color} stroke="#fff" strokeWidth="1.2" />
            </svg>
            <span>{k.name}</span>
          </div>
        );
      })}
    </div>
  );
}

// --- the top bar --------------------------------------------------------------------------------------------------------

export function PresenceBar({ nav }: { nav: NavEntry[] }) {
  const t = useT('presence');
  const s = usePresence();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const manage = can(session, 'settings');
  if (!s.enabled && !manage) return null;
  const here = s.live ? people(s.peers.filter((p) => p.page && p.page === s.page)) : [];
  const online = s.live ? people(s.peers) : [];
  const tip = (p: Peer) => (p.editing ? t('{name} – bearbeitet gerade', { name: p.name }) : t('{name} – ist auch auf dieser Seite', { name: p.name }));
  return (
    <div className="pz-bar" data-tour="presence-bar">
      {here.length > 0 && (
        <span className="pz-stack" role="group" aria-label={t('Auch auf dieser Seite')}>
          {here.slice(0, 4).map((p) => (
            <span key={p.user_id} className="pz-stack-item" title={tip(p)} aria-label={tip(p)} role="img">
              <Avatar p={p} />
            </span>
          ))}
          {here.length > 4 && (
            <span className="pz-av more" title={here.slice(4).map((p) => p.name).join(', ')}>
              +{here.length - 4}
            </span>
          )}
        </span>
      )}
      <button
        type="button"
        className={`btn secondary small pz-team-btn pz-opener${s.enabled ? '' : ' off'}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={online.length ? t.plural(online.length, { one: 'Team ist hier: {n} Person online', other: 'Team ist hier: {n} Personen online' }) : t('Team ist hier')}
        title={t('Team ist hier')}
      >
        <Users size={14} />
        {online.length > 0 && <span className="pz-count">{online.length}</span>}
      </button>
      {open && <TeamPopover nav={nav} manage={manage} onClose={() => setOpen(false)} />}
    </div>
  );
}

interface TeamPerson {
  user_id: string;
  name: string;
  color: string;
  page: string | null;
  editing: boolean;
}

function TeamPopover({ nav, manage, onClose }: { nav: NavEntry[]; manage: boolean; onClose: () => void }) {
  const t = useT('presence');
  const s = usePresence();
  const labels = useLabels(nav);
  const ref = useRef<HTMLDivElement>(null);
  const [list, setList] = useState<TeamPerson[] | null>(null);
  usePopover(ref, onClose);
  // the server's list: one entry per person, the page only where this person may look
  useEffect(() => {
    if (!s.enabled) return setList([]);
    let live = true;
    // asked again when somebody comes, goes or moves – bundled, the list need not follow every keystroke
    const timer = window.setTimeout(
      () =>
        void api
          .get<{ people: TeamPerson[] }>('/api/presence/team')
          .then((d) => live && setList(d.people))
          .catch(() => live && setList([])),
      list === null ? 0 : 600,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [s.peers, s.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const savePrefs = async (change: Partial<PresencePrefs>) => {
    try {
      const prefs = await api.put<PresencePrefs>('/api/presence/prefs', change);
      setPresence({ prefs });
      presenceClient()?.beat();
    } catch (e) {
      toastError(e);
    }
  };
  const setEnabled = async (enabled: boolean) => {
    try {
      await api.put('/api/presence/settings', { enabled });
      setPresence({ enabled, live: enabled && !!presenceClient(), ...(enabled ? {} : { peers: [] }) });
      if (enabled) presenceClient()?.beat();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div ref={ref} tabIndex={-1} className="pz-pop" role="dialog" aria-label={t('Team ist hier')} data-tour="presence-team">
      <div className="pz-pop-head">
        <strong>{t('Team ist hier')}</strong>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('Schließen')}>
          ✕
        </button>
      </div>
      {!s.enabled ? (
        <p className="muted small">{t('Live-Zusammenarbeit ist in diesem Sub-Account ausgeschaltet.')}</p>
      ) : list === null ? (
        <p className="muted small">{t('Lädt')}</p>
      ) : list.length === 0 ? (
        <p className="muted small">{t('Gerade ist niemand sonst online.')}</p>
      ) : (
        <ul className="pz-list">
          {list.map((p) => (
            <li key={p.user_id}>
              <Avatar p={p} />
              <span className="pz-who">
                <b>{p.name}</b>
                <span className="muted small">
                  {whereLabel(t, labels, p)}
                  {p.editing ? ` · ${t('bearbeitet gerade')}` : ''}
                </span>
              </span>
              {p.page && p.page !== s.page && (
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => {
                    onClose();
                    go(p.page!);
                  }}
                  aria-label={t('Zu {name} gehen', { name: p.name })}
                >
                  {t('Hingehen')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="pz-prefs">
        <Check checked={s.prefs.menu} onChange={(v) => void savePrefs({ menu: v })} label={t('Team im Menü zeigen')} />
        <label className="pz-field">
          <span>{t('Mauszeiger anderer zeigen')}</span>
          <select value={s.prefs.cursors} onChange={(e) => void savePrefs({ cursors: e.target.value as CursorMode })}>
            <option value="boards">{t('Nur auf Boards und Canvas')}</option>
            <option value="all">{t('Auf allen Seiten')}</option>
            <option value="off">{t('Aus')}</option>
          </select>
        </label>
        <Check checked={s.prefs.invisible} onChange={(v) => void savePrefs({ invisible: v })} label={t('Unsichtbar – die anderen sehen mich nicht')} />
        {manage && <Check checked={s.enabled} onChange={(v) => void setEnabled(v)} label={t('Live-Zusammenarbeit in diesem Sub-Account')} />}
        <p className="muted small">{t('Nur der Live-Zustand: kein Verlauf, keine Protokolle. Dein Mauszeiger geht nur an Leute, die ihre Zeiger auch teilen.')}</p>
      </div>
    </div>
  );
}

// --- the sidebar --------------------------------------------------------------------------------------------------------

/** Where the person popover opens: next to what opened it, inside the window. */
const besides = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: Math.min(r.right + 8, window.innerWidth - 276), y: Math.min(r.top - 8, window.innerHeight - 170) };
};

/**
 * Avatars of the colleagues on a menu entry's pages, inside the menu link (the link stays one element for keyboard and
 * screen reader – it names who is there; NavPeopleKey right after the link opens the same details by keyboard, and
 * everybody is also listed with "Hingehen" in the top bar's "Team ist hier"). A click on an avatar shows who and where
 * instead of following the link.
 */
export function NavDots({ peers, label, rail }: { peers: Peer[]; label: string; rail: boolean }) {
  const t = useT('presence');
  const [open, setOpen] = useState<{ p: Peer; x: number; y: number } | null>(null);
  const max = rail ? 1 : 3;
  const names = peers.map((p) => p.name).join(', ');
  return (
    <span className={`pz-nav${rail ? ' rail' : ''}`} data-tour="presence-nav">
      <span className="pz-sr">{t.plural(peers.length, { one: '{names} ist hier', other: '{names} sind hier' }, { names })}</span>
      {peers.slice(0, max).map((p) => (
        <span
          key={p.user_id}
          className="pz-nav-av pz-opener"
          aria-hidden="true"
          title={t('{name} ist bei {where}', { name: p.name, where: label })}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen(open?.p.user_id === p.user_id ? null : { p, ...besides(e.currentTarget) });
          }}
        >
          <Avatar p={p} size="xs" />
        </span>
      ))}
      {peers.length > max && (
        <span className="pz-av xs more" aria-hidden="true" title={peers.slice(max).map((p) => p.name).join(', ')}>
          +{peers.length - max}
        </span>
      )}
      {open && createPortal(<PeoplePopover people={[open.p]} where={label} x={open.x} y={open.y} onClose={() => setOpen(null)} />, document.body)}
    </span>
  );
}

/**
 * The keyboard's way to the same details: a real button right after the menu link (not inside it – a link may not hold
 * another control), out of sight until it has the focus. Enter or Space opens the people there, Esc closes and gives the
 * focus back to the button.
 */
export function NavPeopleKey({ peers, label, rail }: { peers: Peer[]; label: string; rail: boolean }) {
  const t = useT('presence');
  const id = useId();
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const names = peers.map((p) => p.name).join(', ');
  return (
    <>
      <button
        type="button"
        className={`pz-nav-key pz-opener${rail ? ' rail' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={!!open}
        aria-controls={open ? id : undefined}
        aria-label={t('Wer ist bei {where}: {names}', { where: label, names })}
        onClick={(e) => setOpen(open ? null : besides(e.currentTarget))}
      >
        <span className="pz-nav-key-avs" aria-hidden="true">
          {peers.slice(0, rail ? 1 : 3).map((p) => (
            <Avatar key={p.user_id} p={p} size="xs" />
          ))}
        </span>
        {!rail && <span className="pz-nav-key-names" aria-hidden="true">{names}</span>}
      </button>
      {open && createPortal(<PeoplePopover id={id} people={peers} where={label} x={open.x} y={open.y} onClose={() => setOpen(null)} />, document.body)}
    </>
  );
}

function PeoplePopover({ id, people: list, where, x, y, onClose }: { id?: string; people: Peer[]; where: string; x: number; y: number; onClose: () => void }) {
  const t = useT('presence');
  const here = usePresence().page;
  const ref = useRef<HTMLDivElement>(null);
  usePopover(ref, onClose);
  const one = list.length === 1 ? list[0] : null;
  return (
    // rendered in <body>, but React events still bubble to the menu link: stop them here
    <div id={id} ref={ref} tabIndex={-1} className="pz-pop pz-person" style={{ left: Math.max(8, x), top: Math.max(8, y) }} role="dialog" aria-label={one ? one.name : where} onClick={(e) => e.stopPropagation()}>
      <div className="pz-pop-head">
        {one ? (
          <span className="pz-who-row">
            <Avatar p={one} />
            <strong>{one.name}</strong>
          </span>
        ) : (
          <strong>{where}</strong>
        )}
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('Schließen')}>
          ✕
        </button>
      </div>
      {list.map((p) => (
        <div key={p.user_id} className="pz-person-row">
          {!one && (
            <span className="pz-who-row">
              <Avatar p={p} size="xs" />
              <b>{p.name}</b>
            </span>
          )}
          <p className="small">
            {where}
            {p.page && <span className="muted pz-path"> {p.page}</span>}
          </p>
          {p.editing && <p className="small muted">{t('bearbeitet gerade')}</p>}
          {p.page && p.page !== here && (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                onClose();
                go(p.page!);
              }}
              aria-label={one ? undefined : t('Zu {name} gehen', { name: p.name })}
            >
              {t('Hingehen')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
