import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronsUpDown, ExternalLink, Search as SearchIcon } from 'lucide-react';
import { api } from './api';
import { Icon, type IconName } from './icons';
import { useSession, type Session } from './session';
import { useT } from './i18n';
import { navigate, useRoute } from './ui';
import { Later, lazyPages, whenIdle } from './lazy';

/**
 * Getting around: a searchable project switcher in the sidebar, the Ctrl+K palette (favourites, recent pages, pages, settings,
 * contacts and deals, projects, documents, Claude sessions, Codex tasks – ranked by match, the assistant for everything else),
 * favourites (☆, shown at the top of the menu) and one-click buttons into a project's Claude session or Codex task.
 */

export interface ProjectInfo {
  id: string;
  name: string;
  status: string;
  tagline: string;
  claude_sessions: { label: string; url: string }[];
  codex_sessions?: { label: string; url: string }[];
  stats?: { contacts: number; open_opportunities: number; open_tasks: number; unread: number; drafts: number };
}

const STATUS_ORDER = ['live', 'beta', 'entwicklung', 'idee', 'pausiert', 'archiviert'];
/** German labels (message ids of the shell catalog – translate with t(STATUS_LABEL[s]) where shown). */
export const STATUS_LABEL: Record<string, string> = { idee: 'Idee', entwicklung: 'In Entwicklung', beta: 'Beta', live: 'Live', pausiert: 'Pausiert', archiviert: 'Archiviert' };

// One shared copy of the project list; pages announce changes with `refreshProjects()`.
let cache: ProjectInfo[] | null = null;
const listeners = new Set<(p: ProjectInfo[]) => void>();
export async function refreshProjects(session?: Pick<Session, 'user' | 'locations'>) {
  try {
    const list: any[] = await api.get('/api/agency/projects');
    cache = list.map((l) => ({ id: l.id, name: l.name, status: l.profile.status, tagline: l.profile.tagline, claude_sessions: l.profile.claude_sessions ?? [], codex_sessions: l.profile.codex_sessions ?? [], stats: l.stats }));
  } catch {
    // Members cannot see the agency list: fall back to the sub-accounts they may use.
    cache = (session?.locations ?? []).map((l) => ({ id: l.id, name: l.name, status: '', tagline: '', claude_sessions: [] }));
  }
  listeners.forEach((f) => f(cache!));
  return cache;
}
// The switcher and the command palette mount together: one request for both.
let firstLoad: Promise<unknown> | null = null;
export function useProjects(): ProjectInfo[] {
  const session = useSession();
  const [list, setList] = useState<ProjectInfo[]>(cache ?? session.locations.map((l) => ({ id: l.id, name: l.name, status: '', tagline: '', claude_sessions: [] })));
  useEffect(() => {
    listeners.add(setList);
    if (!cache) void (firstLoad ??= refreshProjects(session).finally(() => (firstLoad = null)));
    return () => void listeners.delete(setList);
  }, []);
  return list;
}

const RECENT_KEY = 'pghl_recent_projects';
function recents(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function remember(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recents().filter((x) => x !== id)].slice(0, 5)));
  } catch {}
}

/** Pages that exist in every project; staying on one of them when switching keeps your context. */
const PROJECT_PAGES = ['dashboard', 'project', 'conversations', 'calendars', 'contacts', 'companies', 'objects', 'opportunities', 'tasks', 'campaigns', 'workflows', 'social', 'funnels', 'forms', 'invoices', 'contracts', 'products', 'reviews', 'apps', 'settings'];

export function useOpenProject() {
  const session = useSession();
  const route = useRoute();
  return (id: string, page?: string) => {
    remember(id);
    const here = route[0] && PROJECT_PAGES.includes(route[0]) ? route[0] : 'project';
    session.switchLocation(id, page ?? here);
  };
}

export function sortProjects(list: ProjectInfo[]) {
  const rec = recents();
  return [...list].sort((a, b) => {
    const ra = rec.indexOf(a.id), rb = rec.indexOf(b.id);
    if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
    return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name);
  });
}

export function StatusDot({ status }: { status: string }) {
  const t = useT('shell');
  return <span className={`sdot s-${status || 'none'}`} title={STATUS_LABEL[status] ? t(STATUS_LABEL[status]) : ''} />;
}

const SESSION_KIND = {
  claude: { icon: 'claude', label: 'Claude', one: 'Claude-Sitzung öffnen', many: 'Claude-Sitzungen', cls: 'claude-btn' },
  codex: { icon: 'codex', label: 'Codex', one: 'Codex-Aufgabe öffnen', many: 'Codex-Aufgaben', cls: 'claude-btn codex-btn' },
} as const;

/** One-click jump into the project's Claude session(s). */
export function ClaudeButton(props: { sessions: { label: string; url: string }[]; compact?: boolean }) {
  return <SessionButton kind="claude" {...props} />;
}
/** One-click jump into the project's Codex task(s) on chatgpt.com/codex. */
export function CodexButton(props: { sessions?: { label: string; url: string }[]; compact?: boolean }) {
  return <SessionButton kind="codex" sessions={props.sessions ?? []} compact={props.compact} />;
}

function SessionButton({ kind, sessions, compact }: { kind: keyof typeof SESSION_KIND; sessions: { label: string; url: string }[]; compact?: boolean }) {
  const t = useT('shell');
  const k = SESSION_KIND[kind];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  if (!sessions?.length) return null;
  const cls = compact ? `${k.cls} compact` : `btn secondary ${k.cls}`;
  if (sessions.length === 1)
    return (
      <a className={cls} href={sessions[0].url} target="_blank" rel="noreferrer" title={`${t(k.one)}: ${sessions[0].label}`} onClick={(e) => e.stopPropagation()}>
        <Icon name={k.icon} size={compact ? 15 : 16} />
        {!compact && k.label}
      </a>
    );
  return (
    <span className="claude-wrap" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className={cls} onClick={() => setOpen(!open)} title={t(k.many)} aria-expanded={open}>
        <Icon name={k.icon} size={compact ? 15 : 16} />
        {compact ? <small>{sessions.length}</small> : `${k.label} (${sessions.length})`}
      </button>
      {open && (
        <div className="menu-pop">
          {sessions.map((s, i) => (
            <a key={i} href={s.url} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
              <Icon name={k.icon} size={14} /> {s.label} <ExternalLink size={12} className="ico muted" />
            </a>
          ))}
        </div>
      )}
    </span>
  );
}

export function useListKeys(count: number, onPick: (i: number) => void, onEsc: () => void) {
  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [count]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(s + 1, count - 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
    else if (e.key === 'Enter' && count) (e.preventDefault(), onPick(sel));
    else if (e.key === 'Escape') (e.preventDefault(), onEsc());
  };
  return { sel, setSel, onKeyDown };
}

const matches = (q: string, ...s: string[]) => !q || s.some((x) => x.toLowerCase().includes(q.toLowerCase()));

/** Sidebar: current project, click to search and switch. */
export function ProjectSwitcher() {
  const t = useT('shell');
  const session = useSession();
  const projects = useProjects();
  const open = useOpenProject();
  const [show, setShow] = useState(false);
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>();
  const cur = projects.find((p) => p.id === session.locationId) ?? { id: session.locationId, name: session.locations.find((l) => l.id === session.locationId)?.name ?? '–', status: '', claude_sessions: [] };
  const list = sortProjects(projects).filter((p) => (archived || p.status !== 'archiviert' || p.id === session.locationId) && matches(q, p.name, p.tagline));
  const btn = useRef<HTMLButtonElement>(null);
  // Closing with the keyboard (Esc, Enter on a project) gives the focus back to the switcher button.
  const close = (refocus = true) => (setShow(false), setQ(''), refocus && btn.current?.focus());
  const pick = (i: number) => list[i] && (open(list[i].id), close());
  const keys = useListKeys(list.length, pick, close);
  useEffect(() => {
    if (!show) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close(false);
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [show]);
  return (
    <div className="switcher" ref={ref} data-tour="project-switcher">
      <button
        ref={btn}
        className="switcher-btn"
        onClick={(e) => {
          // Fixed position so the list can be wider than the sidebar.
          const r = e.currentTarget.getBoundingClientRect();
          setPos({ top: r.bottom + 6, left: r.left, width: Math.min(Math.max(r.width, 330), window.innerWidth - r.left - 12) });
          setShow(!show);
        }}
        aria-expanded={show}
        aria-haspopup="listbox"
        aria-label={t('Projekt wechseln')}
        title={cur.name}
      >
        <StatusDot status={cur.status} />
        <span className="switcher-name">{cur.name}</span>
        <ChevronsUpDown size={15} className="ico" />
      </button>
      {show && (
        <div className="switcher-pop" style={pos}>
          <div className="switcher-search">
            <SearchIcon size={15} className="ico" />
            <input
              autoFocus
              placeholder={t('Projekt suchen…')}
              aria-label={t('Projekt suchen…')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={keys.onKeyDown}
              role="combobox"
              aria-expanded="true"
              aria-controls="switcher-list"
              aria-activedescendant={list[keys.sel] ? `switcher-opt-${keys.sel}` : undefined}
            />
          </div>
          <div className="switcher-list" id="switcher-list" role="listbox" aria-label={t('Projekt wechseln')}>
            {list.map((p, i) => (
              <div key={p.id} id={`switcher-opt-${i}`} role="option" aria-selected={i === keys.sel} className={`switcher-row${i === keys.sel ? ' sel' : ''}${p.id === session.locationId ? ' cur' : ''}`} onMouseEnter={() => keys.setSel(i)} onClick={() => pick(i)}>
                <StatusDot status={p.status} />
                <span className="grow">
                  {p.name}
                  {p.stats && (
                    <small>
                      {t('{deals} Deals · {tasks} Aufgaben', { deals: p.stats.open_opportunities, tasks: p.stats.open_tasks })}
                      {p.stats.unread ? ` · ${t('{n} neu', { n: p.stats.unread })}` : ''}
                    </small>
                  )}
                </span>
                <ClaudeButton sessions={p.claude_sessions} compact />
                <CodexButton sessions={p.codex_sessions} compact />
              </div>
            ))}
            {!list.length && <div className="muted small" style={{ padding: 10 }}>{t('Kein Projekt gefunden.')}</div>}
          </div>
          {session.user.role === 'admin' && (
            <div className="switcher-foot">
              <label className="check small" style={{ margin: 0 }}>
                <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {t('Archivierte')}
              </label>
              <a href="#" onClick={(e) => (e.preventDefault(), close(), navigate('agency/projects'))}>
                {t('Alle Projekte →')}
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- favourites and recent pages --------------------------------------------------------------------------------------------

/** A page the person pinned as a favourite: shown at the top of the menu and of Ctrl+K (kept in this browser, per login). */
export interface Fav {
  path: string;
  label: string;
  icon: IconName;
}
const FAV_MAX = 12;
const favKey = (uid: string) => `pghl.nav.favs.${uid}`;
let favCache: { uid: string; list: Fav[] } | null = null;
const favSubs = new Set<() => void>();
function readFavs(uid: string): Fav[] {
  if (favCache?.uid === uid) return favCache.list;
  let list: Fav[] = [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(favKey(uid)) ?? '[]');
    if (Array.isArray(raw)) list = raw.filter((f) => f && typeof f.path === 'string' && typeof f.label === 'string' && typeof f.icon === 'string').slice(0, FAV_MAX);
  } catch {
    /* storage blocked (private mode): no favourites */
  }
  favCache = { uid, list };
  return list;
}
const subscribeFavs = (f: () => void) => (favSubs.add(f), () => void favSubs.delete(f));
/** The person's favourites, kept fresh across the tab. */
export function useFavs(): Fav[] {
  const uid = useSession().user.id;
  return useSyncExternalStore(subscribeFavs, () => readFavs(uid));
}
export const isFav = (uid: string, path: string) => readFavs(uid).some((f) => f.path === path);
/** Pin a page as a favourite, or remove it. */
export function toggleFav(uid: string, fav: Fav) {
  const list = readFavs(uid);
  const next = list.some((f) => f.path === fav.path) ? list.filter((f) => f.path !== fav.path) : [...list, fav].slice(-FAV_MAX);
  favCache = { uid, list: next };
  try {
    localStorage.setItem(favKey(uid), JSON.stringify(next));
  } catch {
    /* storage blocked: only for this tab */
  }
  favSubs.forEach((f) => f());
}

const RECENT_PAGES = 'pghl.nav.recent';
export function recentPages(): string[] {
  try {
    const r: unknown = JSON.parse(localStorage.getItem(RECENT_PAGES) ?? '[]');
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}
function rememberPage(route: string) {
  if (!route) return;
  try {
    localStorage.setItem(RECENT_PAGES, JSON.stringify([route, ...recentPages().filter((x) => x !== route)].slice(0, 6)));
  } catch {
    /* storage blocked */
  }
}

// The dialog itself is a chunk of its own (nav-palette.tsx): fetched when the browser is idle, or on the first Ctrl+K.
const { PaletteDialog } = lazyPages(() => import('./nav-palette'), 'PaletteDialog');

/**
 * Ctrl/⌘+K – one place to get anywhere (favourites, recent pages, pages, settings, contacts and deals, projects, documents,
 * sessions, the assistant for everything else; see nav-palette.tsx). This part only catches the shortcut – on every page, also
 * in text fields – and the "Springen" button (`pghl:palette`), and remembers the pages someone opens for "Zuletzt".
 */
export function CommandPalette({ nav }: { nav: [string, IconName, string, string][] }) {
  const route = useRoute();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') (e.preventDefault(), setShow((s) => !s));
    };
    const onOpen = () => setShow(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pghl:palette', onOpen);
    return () => (window.removeEventListener('keydown', onKey), window.removeEventListener('pghl:palette', onOpen));
  }, []);
  // the pages someone opens, for "Zuletzt" (only areas of the menu, not every record)
  useEffect(() => void (route[0] && nav.some((n) => n[0] === route[0]) && rememberPage(route[0])), [route[0]]); // eslint-disable-line react-hooks/exhaustive-deps
  // fetched once the page is up and the browser is idle, so the first Ctrl+K opens without waiting
  useEffect(() => whenIdle(() => PaletteDialog.preload(), { delay: 8000 }), []);
  if (!show) return null;
  return (
    <Later>
      <PaletteDialog nav={nav} close={() => setShow(false)} />
    </Later>
  );
}
