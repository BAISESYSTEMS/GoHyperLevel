import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import './teamtools.css';
import { Icon, type IconName } from '../icons';
import { api, currentLocation, dt } from '../api';
import { Modal, act, confirmAsk, toast, useLoad } from '../ui';
import { fmtDateTime, tr, useT } from '../i18n';

const tx = tr('inbox');

/**
 * Team-Posteingang in the conversation page: the view rail with numbers, chips for owner / status / deadline, the bar above
 * a thread (assign, status, snooze, priority), internal notes with @mentions, "Anna schreibt gerade…", bulk actions and the
 * keyboard shortcuts. Everything here is a small piece the conversation page plugs in; the settings live in TeamInboxSettings.
 */

export interface InboxPerson {
  id: string;
  name: string;
  email: string;
  away: boolean;
  paused: boolean;
  back_on: string | null;
  me: boolean;
}
export interface InboxMeta {
  me: string | null;
  timezone: string;
  views: [string, string][];
  statuses: [string, string][];
  priorities: [string, string][];
  people: InboxPerson[];
  teams: { id: string; name: string; members: string[] }[];
  settings: { assignment_mode: string; sla_enabled: boolean; first_response_min: number; next_response_min: number; auto_close_days: number; reply_sets_waiting: boolean };
}
export interface Sla {
  state: '' | 'ok' | 'warning' | 'breached';
  kind: 'first' | 'next' | null;
  due_at: string | null;
  since: string | null;
}
export interface ConvState {
  conversation_id: string;
  contact_id: string;
  assignee_id: string | null;
  assignee_name: string;
  team_id: string | null;
  team_name: string;
  status: 'open' | 'waiting' | 'closed';
  snoozed_until: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  sla: Sla;
  first_response_at: string | null;
  viewers: Viewer[];
  timeline: TimelineItem[];
}
export interface Viewer {
  user_id: string;
  name: string;
  typing: boolean;
}
export interface TimelineItem {
  id: string;
  type: string;
  user_id: string | null;
  author_name: string;
  body: string;
  mentions: string[];
  created_at: string;
}

const VIEW_ORDER: [string, IconName][] = [
  ['mine', 'contact'],
  ['unassigned', 'inbox'],
  ['open', 'conversations'],
  ['team', 'contacts'],
  ['waiting', 'wait'],
  ['snoozed', 'schedule'],
  ['sla', 'flag'],
  ['mentions', 'notify'],
  ['done', 'ok'],
  ['all', 'archive'],
];
// German labels below (and the ones the server sends in meta.views/statuses/priorities) are message ids of the inbox catalog.
const FALLBACK_LABEL: Record<string, string> = { all: 'Alle', open: 'Offen', mine: 'Mir zugewiesen', unassigned: 'Nicht zugewiesen', team: 'Team', waiting: 'Wartet auf Kontakt', done: 'Erledigt', snoozed: 'Zurückgestellt', sla: 'SLA gefährdet', mentions: 'Erwähnungen' };
export const PRIORITY_LABEL: Record<string, string> = { low: 'Niedrig', normal: 'Normal', high: 'Hoch', urgent: 'Dringend' };
export const STATUS_LABEL: Record<string, string> = { open: 'Offen', waiting: 'Wartet', closed: 'Erledigt' };

// --- small helpers ------------------------------------------------------------------------------------------------

/** "in 12 Min." / "seit 2 Std." relative to now (in the UI language). */
export function rel(iso: string, now = Date.now()) {
  const m = Math.round((Date.parse(iso) - now) / 60000);
  const a = Math.abs(m);
  if (a < 1) return tx('jetzt');
  const s = a < 60 ? tx('{n} Min.', { n: a }) : a < 1440 ? tx('{n} Std.', { n: Math.round(a / 60) }) : tx('{n} T.', { n: Math.round(a / 1440) });
  return m >= 0 ? tx('in {time}', { time: s }) : tx('seit {time}', { time: s });
}
export const when = (iso: string) => fmtDateTime(iso, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const stored = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
export const rememberView = (v: string) => {
  try {
    localStorage.setItem('pghl.inbox.view', v);
  } catch {
    /* private mode */
  }
};
export const initialView = () => {
  const v = stored('pghl.inbox.view', 'all');
  return VIEW_ORDER.some(([k]) => k === v) ? v : 'all';
};

// --- live connection ----------------------------------------------------------------------------------------------

type Listener = (name: string, data: any) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let sourceLocation = '';
/** The server said `bye` (signed out, session revoked or expired, no access any more): no reconnect until the page is looked at again. */
let parked = false;

function openSource(loc: string, again = false) {
  sourceLocation = loc;
  parked = false;
  const clientId = `web-${Math.random().toString(36).slice(2, 12)}`;
  const es = new EventSource(`/api/inbox/stream?clientId=${clientId}&locationId=${encodeURIComponent(loc)}`);
  for (const name of ['presence', 'conversation']) {
    es.addEventListener(name, (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        listeners.forEach((x) => x(name, data));
      } catch {
        /* a broken frame */
      }
    });
  }
  // opened again after a `bye`: something may have changed in between – the page looks again
  if (again) es.addEventListener('hello', () => listeners.forEach((x) => x('conversation', {})), { once: true });
  // the server ends the stream for good: no reconnect loop
  es.addEventListener('bye', () => {
    es.close();
    if (source === es) parked = true;
  });
  // an error answer (503 when the server is full, 401/403 …) closes it for good too: one new try when the page is looked at again
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED && source === es) parked = true;
  });
  source = es;
}

/** One EventSource for the page: "conversation" (something changed) and "presence" (who looks / types). */
function useInboxStream(fn: Listener, on: boolean) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!on || typeof EventSource === 'undefined') return;
    const l: Listener = (n, d) => ref.current(n, d);
    listeners.add(l);
    const loc = currentLocation();
    if (source && sourceLocation !== loc) (source.close(), (source = null));
    if (!source) openSource(loc);
    const back = () => {
      if (!parked || document.hidden || !listeners.size) return;
      source?.close();
      openSource(sourceLocation, true);
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      document.removeEventListener('visibilitychange', back);
      listeners.delete(l);
      if (!listeners.size && source) (source.close(), (source = null), (parked = false));
    };
  }, [on]);
}

export function useInboxMeta() {
  return useLoad(() => api.get<InboxMeta>('/api/inbox/meta'), [currentLocation()]);
}

/** Everything the conversation page needs from the team inbox for the open conversation. */
export function useTeamInbox(sel: string, reloadList: () => void, reloadThread: () => void) {
  const meta = useInboxMeta();
  const enabled = !!meta.data;
  const counts = useLoad(() => api.get<Record<string, number>>('/api/inbox/counts'), []);
  const state = useLoad(() => (sel ? api.get<ConvState>(`/api/inbox/conversations/${sel}`) : Promise.resolve(null)), [sel]);
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const me = meta.data?.me ?? null;
  const selRef = useRef(sel);
  selRef.current = sel;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(() => {
    void counts.reload();
    void state.reload();
    reloadList();
    reloadThread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadList, reloadThread]);

  useInboxStream((name, d) => {
    if (name === 'presence') {
      if (d.conversation_id === selRef.current) setViewers((d.viewers as Viewer[]).filter((v) => v.user_id !== me));
      return;
    }
    // Something changed: look again in a moment (a burst of changes is one reload).
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void counts.reload();
      reloadList();
      if (d.id === selRef.current) {
        void state.reload();
        reloadThread();
      }
    }, 400);
  }, enabled);

  // The numbers also move without events (snooze ran out, deadline passed).
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => void counts.reload(), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // "I look at this conversation" every 15 s; leaving is announced.
  useEffect(() => {
    setViewers([]);
    if (!sel || !enabled) return;
    let stop = false;
    const url = `/api/inbox/conversations/${sel}/presence`;
    const ping = () =>
      api
        .post<{ viewers?: Viewer[] }>(url, {})
        .then((r) => !stop && setViewers(r.viewers ?? []))
        .catch(() => undefined);
    void ping();
    const t = setInterval(ping, 15_000);
    return () => {
      stop = true;
      clearInterval(t);
      api.post(url, { leaving: true }).catch(() => undefined);
    };
  }, [sel, enabled]);

  const lastTyping = useRef(0);
  /** Call on every keystroke of the reply: tells the others at most every 2.5 s. */
  const typing = useCallback(() => {
    if (!selRef.current || Date.now() - lastTyping.current < 2500) return;
    lastTyping.current = Date.now();
    api.post(`/api/inbox/conversations/${selRef.current}/presence`, { typing: true }).catch(() => undefined);
  }, []);

  return { enabled, meta: meta.data, counts: counts.data ?? {}, state: state.data ?? null, viewers, typing, refresh, reloadState: state.reload, reloadCounts: counts.reload };
}

// --- the view rail ------------------------------------------------------------------------------------------------

export function ViewRail({ value, onChange, counts, meta }: { value: string; onChange: (v: string) => void; counts: Record<string, number>; meta?: InboxMeta }) {
  const t = useT('inbox');
  const label = (k: string) => t(meta?.views.find(([v]) => v === k)?.[1] ?? FALLBACK_LABEL[k] ?? k);
  return (
    <nav className="tx-rail" aria-label={t('Ansichten')} data-tour="inbox-views">
      {VIEW_ORDER.map(([k, icon]) => (
        <button key={k} className={`tx-view${value === k ? ' on' : ''}`} onClick={() => onChange(k)} aria-current={value === k ? 'true' : undefined} data-view={k}>
          <Icon name={icon} size={18} />
          <span className="tx-view-label">{label(k)}</span>
          {k !== 'all' && counts[k] > 0 && <span className={`tx-count${k === 'sla' ? ' hot' : ''}`}>{counts[k]}</span>}
        </button>
      ))}
    </nav>
  );
}

// --- chips in the list --------------------------------------------------------------------------------------------

export function slaChip(sla?: Sla): { text: string; tone: 'late' | 'warn' | 'ok' } | null {
  if (!sla?.state || !sla.due_at) return null;
  const first = sla.kind === 'first';
  const due = rel(sla.due_at);
  if (sla.state === 'breached') return { text: first ? tx('Erste Antwort überfällig {when}', { when: due }) : tx('Antwort überfällig {when}', { when: due }), tone: 'late' };
  return { text: first ? tx('Erste Antwort fällig {when}', { when: due }) : tx('Antwort fällig {when}', { when: due }), tone: sla.state === 'warning' ? 'warn' : 'ok' };
}

export function RowMeta({ c }: { c: any }) {
  const t = useT('inbox');
  if (c.inbox_status === undefined && !c.sla) return null;
  const sla = slaChip(c.sla);
  const who = c.assignee_id ? c.assignee_name : c.team_name ? t('Team {name}', { name: c.team_name }) : t('Nicht zugewiesen');
  return (
    <div className="tx-meta">
      {(c.priority === 'urgent' || c.priority === 'high') && (
        <span className={`tx-chip prio-${c.priority}`}>
          <Icon name="flag" size={12} /> {t(PRIORITY_LABEL[c.priority])}
        </span>
      )}
      <span className={`tx-chip who${c.assignee_id || c.team_name ? '' : ' none'}`} title={t('Zuständig')}>
        <Icon name="contact" size={12} /> {who}
      </span>
      {c.inbox_status === 'waiting' && <span className="tx-chip">{t('Wartet auf Kontakt')}</span>}
      {c.inbox_status === 'closed' && (
        <span className="tx-chip done">
          <Icon name="ok" size={12} /> {t('Erledigt')}
        </span>
      )}
      {c.snoozed && c.snoozed_until && (
        <span className="tx-chip" title={t('Zurückgestellt')}>
          <Icon name="schedule" size={12} /> {t('bis {date}', { date: when(c.snoozed_until) })}
        </span>
      )}
      {sla && sla.tone !== 'ok' && c.inbox_status !== 'closed' && !c.snoozed && <span className={`tx-chip sla-${sla.tone}`}>{sla.text}</span>}
    </div>
  );
}

// --- popover (snooze) ---------------------------------------------------------------------------------------------

/** A menu that opens under its button, closes with Esc or a click outside and gives the focus back. */
function Popover({ label, icon, children, openKey, align = 'left', className = '' }: { label: ReactNode; icon?: IconName; children: (close: () => void) => ReactNode; openKey?: number; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (openKey) setOpen(true);
  }, [openKey]);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', off);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  return (
    <div className={`tx-popwrap ${className}`} ref={box}>
      <button ref={btn} type="button" className="tx-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {icon && <Icon name={icon} size={16} />} {label}
      </button>
      {open && (
        <div className={`tx-pop ${align}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** [German label (message id), time] – shown through t(). */
export function snoozePresets(now = new Date()): [string, Date][] {
  const at = (d: Date, h: number) => {
    const x = new Date(d);
    x.setHours(h, 0, 0, 0);
    return x;
  };
  const out: [string, Date][] = [['In 1 Stunde', new Date(now.getTime() + 3600_000)], ['In 3 Stunden', new Date(now.getTime() + 3 * 3600_000)]];
  if (now.getHours() < 15) out.push(['Heute Abend (17:00)', at(now, 17)]);
  out.push(['Morgen früh (8:00)', at(new Date(now.getTime() + 864e5), 8)]);
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  if (toMonday > 1) out.push(['Nächsten Montag (8:00)', at(new Date(now.getTime() + toMonday * 864e5), 8)]);
  out.push(['In einer Woche', at(new Date(now.getTime() + 7 * 864e5), 8)]);
  return out;
}

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function SnoozeMenu({ onPick, snoozedUntil, openKey, align }: { onPick: (until: string | null) => void; snoozedUntil?: string | null; openKey?: number; align?: 'left' | 'right' }) {
  const t = useT('inbox');
  const [custom, setCustom] = useState('');
  return (
    <Popover label={t('Zurückstellen')} icon="schedule" openKey={openKey} align={align}>
      {(close) => (
        <>
          {snoozedUntil && (
            <button type="button" role="menuitem" className="tx-pop-item" onClick={() => (onPick(null), close())}>
              <Icon name="refresh" size={16} /> {t('Zurückstellung aufheben')}
            </button>
          )}
          {snoozePresets().map(([label, d]) => (
            <button key={label} type="button" role="menuitem" className="tx-pop-item" onClick={() => (onPick(d.toISOString()), close())}>
              {t(label)}
              <span className="muted small">{when(d.toISOString())}</span>
            </button>
          ))}
          <div className="tx-pop-custom">
            <label className="small muted" htmlFor="tx-snooze-custom">
              {t('Eigene Zeit')}
            </label>
            <input id="tx-snooze-custom" type="datetime-local" value={custom} min={localInput(new Date())} onChange={(e) => setCustom(e.target.value)} />
            <button type="button" className="tx-btn primary" disabled={!custom || new Date(custom).getTime() <= Date.now()} onClick={() => (onPick(new Date(custom).toISOString()), close())}>
              {t('Zurückstellen')}
            </button>
          </div>
        </>
      )}
    </Popover>
  );
}

// --- the bar above a thread ---------------------------------------------------------------------------------------

export function ThreadBar({ convId, st, meta, onChanged, snoozeKey }: { convId: string; st: ConvState; meta: InboxMeta; onChanged: () => void; snoozeKey?: number }) {
  const t = useT('inbox');
  const base = `/api/inbox/conversations/${convId}`;
  const run = async (fn: () => Promise<unknown>) => {
    const r = await act(fn);
    if (r) onChanged();
  };
  const people = meta.people;
  const assignee = people.find((p) => p.id === st.assignee_id);
  const value = st.assignee_id ? `user:${st.assignee_id}` : st.team_id ? `team:${st.team_id}` : '';
  const sla = slaChip(st.sla);
  const snoozed = !!st.snoozed_until;
  return (
    <div className="tx-bar" data-tour="inbox-bar">
      <div className="tx-field" data-tour="inbox-assign">
        <label htmlFor="tx-assignee">{t('Zuständig')}</label>
        <select
          id="tx-assignee"
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            void run(() => (v.startsWith('team:') ? api.post(`${base}/assign`, { user_id: null, team_id: v.slice(5) }) : v.startsWith('user:') ? api.post(`${base}/assign`, { user_id: v.slice(5) }) : api.post(`${base}/assign`, { user_id: null, team_id: null })));
          }}
        >
          <option value="">{t('Niemand')}</option>
          <optgroup label={t('Personen')}>
            {people.map((p) => (
              <option key={p.id} value={`user:${p.id}`}>
                {p.name}
                {p.me ? ` (${t('ich')})` : ''}
                {p.away ? ` · ${t('abwesend')}` : ''}
              </option>
            ))}
          </optgroup>
          {meta.teams.length > 0 && (
            <optgroup label={t('Teams')}>
              {meta.teams.map((team) => (
                <option key={team.id} value={`team:${team.id}`}>
                  {team.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {meta.me && st.assignee_id !== meta.me && (
          <button type="button" className="tx-btn" onClick={() => run(() => api.post(`${base}/assign`, { user_id: 'me' }))} title={t('Mir zuweisen (Taste A)')} aria-label={t('Mir zuweisen')}>
            <Icon name="contact" size={16} /> {t('Mir')}
          </button>
        )}
      </div>
      <div className="tx-seg" role="group" aria-label={t('Status')} data-tour="inbox-status">
        {meta.statuses.map(([k, label]) => (
          <button key={k} type="button" className={st.status === k ? 'on' : ''} aria-pressed={st.status === k} onClick={() => st.status !== k && run(() => api.post(`${base}/status`, { status: k }))} title={k === 'closed' ? t('Taste E') : undefined}>
            {k === 'waiting' ? t('Wartet') : t(label)}
          </button>
        ))}
      </div>
      <span data-tour="inbox-snooze">
        <SnoozeMenu snoozedUntil={st.snoozed_until} openKey={snoozeKey} onPick={(until) => run(() => api.post(`${base}/snooze`, { until }))} />
      </span>
      <div className="tx-field">
        <select aria-label={t('Priorität')} value={st.priority} onChange={(e) => run(() => api.post(`${base}/priority`, { priority: e.target.value }))}>
          {meta.priorities.map(([k, l]) => (
            <option key={k} value={k}>
              {t('Priorität: {level}', { level: t(l) })}
            </option>
          ))}
        </select>
      </div>
      <div className="tx-state">
        {snoozed && (
          <span className="tx-chip">
            <Icon name="schedule" size={12} /> {t('zurückgestellt bis {date}', { date: when(st.snoozed_until!) })}
          </span>
        )}
        {sla && st.status !== 'closed' && !snoozed && <span className={`tx-chip sla-${sla.tone}`}>{sla.text}</span>}
        {assignee?.away && (
          <span className="tx-chip warn" title={t('Neue Nachrichten gehen an eine andere Person, wenn das in den Einstellungen so gewählt ist')}>
            {assignee.back_on ? t('{name} ist abwesend bis {date}', { name: assignee.name, date: when(assignee.back_on) }) : t('{name} ist abwesend', { name: assignee.name })}
          </span>
        )}
      </div>
    </div>
  );
}

// --- who else is here ---------------------------------------------------------------------------------------------

export function CollisionBanner({ viewers }: { viewers: Viewer[] }) {
  const t = useT('inbox');
  if (!viewers.length) return null;
  const typing = viewers.filter((v) => v.typing);
  const list = (xs: Viewer[]) => xs.map((v) => v.name).join(` ${t('und')} `);
  return (
    <div className={`tx-collide${typing.length ? ' typing' : ''}`} role="status" aria-live="polite" data-tour="inbox-collision">
      <span className="tx-dot" aria-hidden="true" />
      <span>
        {typing.length ? (
          <>
            <strong>{list(typing)}</strong> {t('schreibt gerade… Antwort vorher abstimmen, damit der Kontakt nicht doppelt Post bekommt.')}
          </>
        ) : (
          <>
            <strong>{list(viewers)}</strong> {t('sieht sich diese Konversation gerade an.')}
          </>
        )}
      </span>
    </div>
  );
}

// --- feed: messages and internal entries in one time line ------------------------------------------------------------

export type FeedItem = { kind: 'message'; at: string; m: any } | { kind: 'team'; at: string; t: TimelineItem };

export function mergeFeed(messages: any[], timeline: TimelineItem[]): FeedItem[] {
  const out: FeedItem[] = [...messages.map((m) => ({ kind: 'message' as const, at: m.created_at as string, m })), ...timeline.map((t) => ({ kind: 'team' as const, at: t.created_at, t }))];
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind === b.kind ? 0 : a.kind === 'message' ? -1 : 1));
}

function Mentions({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /\[@([^\]]{1,80})\]\(user:([A-Za-z0-9_-]{1,64})\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span key={m.index} className="tx-mention">
        @{m[1]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

export function TimelineEntry({ t: item, me, admin, convId, onChanged }: { t: TimelineItem; me: string | null; admin: boolean; convId: string; onChanged: () => void }) {
  const t = useT('inbox');
  if (item.type !== 'note') {
    // The line itself ("Anna hat zugewiesen …") is written by the server and stays German.
    return (
      <div className="tx-sys" data-type={item.type}>
        <Icon name={item.type === 'assigned' ? 'contact' : item.type === 'snooze' ? 'schedule' : item.type === 'priority' || item.type === 'sla' ? 'flag' : 'history'} size={12} />
        <span>{item.body}</span>
        <span className="tx-sys-time">{dt(item.created_at)}</span>
      </div>
    );
  }
  const mine = !!me && item.user_id === me;
  return (
    <div className={`tx-note${me && item.mentions.includes(me) ? ' for-me' : ''}`} data-tour="inbox-note">
      <div className="tx-note-tag">
        <Icon name="lock" size={12} /> {t('Interne Notiz · nur fürs Team sichtbar')}
      </div>
      <div className="tx-note-body">
        <Mentions text={item.body} />
      </div>
      <div className="tx-note-meta">
        <span>
          {item.author_name || t('Unbekannt')} · {dt(item.created_at)}
        </span>
        {(mine || admin) && (
          <button
            type="button"
            className="tx-link"
            onClick={async () => {
              if (!confirmAsk(t('Notiz löschen?'))) return;
              if (await act(() => api.del(`/api/inbox/conversations/${convId}/notes/${item.id}`))) onChanged();
            }}
          >
            {t('Löschen')}
          </button>
        )}
      </div>
    </div>
  );
}

// --- writing a note -----------------------------------------------------------------------------------------------

export function NoteComposer({ convId, people, me, focusKey, onSaved }: { convId: string; people: InboxPerson[]; me: string | null; focusKey: number; onSaved: () => void }) {
  const t = useT('inbox');
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  useEffect(() => {
    if (!focusKey) return;
    setOpen(true);
    setTimeout(() => ref.current?.focus(), 0);
  }, [focusKey]);
  useEffect(() => {
    setText('');
    setOpen(false);
  }, [convId]);
  useEffect(() => {
    if (pendingCaret.current !== null && ref.current) {
      ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      ref.current.focus();
      pendingCaret.current = null;
    }
  });
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  const matches = m ? people.filter((p) => p.id !== me && p.name.toLowerCase().includes(m[2].toLowerCase())).slice(0, 6) : [];
  const insert = (p: InboxPerson) => {
    if (!m) return;
    const start = caret - (m[2].length + 1);
    const next = `${text.slice(0, start)}@${p.name} ${text.slice(caret)}`;
    pendingCaret.current = start + p.name.length + 2;
    setText(next);
    setCaret(pendingCaret.current);
  };
  const addAt = () => {
    const el = ref.current;
    const pos = el?.selectionStart ?? text.length;
    const pad = pos > 0 && !/\s/.test(text[pos - 1]) ? ' ' : '';
    pendingCaret.current = pos + pad.length + 1;
    setText(`${text.slice(0, pos)}${pad}@${text.slice(pos)}`);
    setCaret(pendingCaret.current);
  };
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const r = await act(() => api.post<any>(`/api/inbox/conversations/${convId}/notes`, { body: text }));
    setBusy(false);
    if (!r) return;
    toast(r.mentioned?.length ? t.plural(r.mentioned.length, { one: 'Notiz gespeichert – {n} Person benachrichtigt', other: 'Notiz gespeichert – {n} Personen benachrichtigt' }) : t('Notiz gespeichert'));
    setText('');
    setOpen(false);
    onSaved();
  };
  if (!open)
    return (
      <div className="tx-notebar">
        <button type="button" className="tx-addnote" onClick={() => (setOpen(true), setTimeout(() => ref.current?.focus(), 0))} data-tour="inbox-add-note" title={t('Taste N')}>
          <Icon name="note" size={16} /> {t('Interne Notiz schreiben')}
          <span className="muted small">{t('Nur das Team sieht sie – der Kontakt nie')}</span>
        </button>
      </div>
    );
  return (
    <div className="tx-notebar open">
      <div className="tx-note-edit" data-tour="inbox-note-edit">
        <div className="tx-note-tag">
          <Icon name="lock" size={12} /> {t('Interne Notiz – wird nie an den Kontakt gesendet')}
        </div>
        <textarea
          ref={ref}
          value={text}
          rows={3}
          className="tx-note-input"
          aria-label={t('Interne Notiz')}
          placeholder={t('Notiz fürs Team – mit @Name jemanden benachrichtigen')}
          onChange={(e) => (setText(e.target.value), setCaret(e.target.selectionStart))}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') (e.preventDefault(), void save());
            if (e.key === 'Escape' && !text.trim()) setOpen(false);
          }}
        />
        {matches.length > 0 && (
          <div className="tx-mention-list" role="listbox" aria-label={t('Person erwähnen')}>
            {matches.map((p) => (
              <button key={p.id} type="button" role="option" aria-selected="false" className="tx-pop-item" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(p)}>
                <Icon name="contact" size={16} /> {p.name}
                {p.away && <span className="muted small">{t('abwesend')}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="tx-note-actions">
          <button type="button" className="tx-btn" onClick={addAt}>
            @ {t('Erwähnen')}
          </button>
          <span className="grow" />
          <button type="button" className="tx-btn" onClick={() => setOpen(false)}>
            {t('Schließen')}
          </button>
          <button type="button" className="tx-btn primary" disabled={!text.trim() || busy} onClick={save}>
            {t('Notiz speichern')}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- bulk -------------------------------------------------------------------------------------------------------------

export function BulkBar({ ids, meta, onDone, onClear }: { ids: string[]; meta: InboxMeta; onDone: () => void; onClear: () => void }) {
  const t = useT('inbox');
  const go = async (body: Record<string, unknown>, ok: string) => {
    const r = await act(() => api.post<{ updated: number; skipped: { error: string }[] }>('/api/inbox/bulk', { ids, ...body }));
    if (!r) return;
    toast(r.skipped.length ? t('{updated} aktualisiert, {skipped} übersprungen: {error}', { updated: r.updated, skipped: r.skipped.length, error: r.skipped[0].error }) : `${ok}: ${r.updated}`);
    onDone();
  };
  return (
    <div className="tx-bulk" role="region" aria-label={t('Auswahl')} data-tour="inbox-bulk">
      <strong>{t('{n} gewählt', { n: ids.length })}</strong>
      <button type="button" className="tx-btn" onClick={() => go({ action: 'assign', user_id: 'me' }, t('Mir zugewiesen'))}>
        {t('Mir zuweisen')}
      </button>
      <select
        aria-label={t('Zuweisen an')}
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (v) void go(v.startsWith('team:') ? { action: 'assign', user_id: null, team_id: v.slice(5) } : { action: 'assign', user_id: v === 'none' ? null : v }, t('Zugewiesen'));
        }}
      >
        <option value="">{t('Zuweisen an…')}</option>
        <option value="none">{t('Niemand')}</option>
        {meta.people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {meta.teams.map((team) => (
          <option key={team.id} value={`team:${team.id}`}>
            {t('Team {name}', { name: team.name })}
          </option>
        ))}
      </select>
      <button type="button" className="tx-btn" onClick={() => go({ action: 'close' }, t('Erledigt'))}>
        <Icon name="ok" size={16} /> {t('Erledigt')}
      </button>
      <SnoozeMenu onPick={(until) => go({ action: 'snooze', until }, until ? t('Zurückgestellt') : t('Aufgehoben'))} />
      <button type="button" className="tx-btn" onClick={onClear}>
        {t('Auswahl aufheben')}
      </button>
    </div>
  );
}

// --- keyboard ---------------------------------------------------------------------------------------------------------

/** [keys, German text (message id)]. */
export const SHORTCUTS: [string, string][] = [
  ['J / K', 'Nächste / vorherige Konversation'],
  ['E', 'Erledigt (oder wieder öffnen)'],
  ['A', 'Mir zuweisen'],
  ['S', 'Zurückstellen'],
  ['N', 'Interne Notiz schreiben'],
  ['R', 'Antwort schreiben'],
  ['X', 'Konversation für Sammelaktionen markieren'],
  ['/', 'Suchen'],
  ['?', 'Diese Übersicht'],
];

export interface ShortcutActions {
  move: (d: 1 | -1) => void;
  close: () => void;
  mine: () => void;
  snooze: () => void;
  note: () => void;
  reply: () => void;
  toggle: () => void;
  search: () => void;
  help: () => void;
}

export function useInboxShortcuts(on: boolean, actions: ShortcutActions) {
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (document.querySelector('.modal-bg')) return;
      const a = ref.current;
      const k = e.key.toLowerCase();
      const run = (fn: () => void) => (e.preventDefault(), fn());
      if (k === 'j') run(() => a.move(1));
      else if (k === 'k') run(() => a.move(-1));
      else if (k === 'e') run(a.close);
      else if (k === 'a') run(a.mine);
      else if (k === 's') run(a.snooze);
      else if (k === 'n') run(a.note);
      else if (k === 'r') run(a.reply);
      else if (k === 'x') run(a.toggle);
      else if (k === '/') run(a.search);
      else if (e.key === '?') run(a.help);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [on]);
}

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const t = useT('inbox');
  return (
    <Modal title={t('Tastaturkürzel im Posteingang')} onClose={onClose}>
      <table className="t tx-keys">
        <tbody>
          {SHORTCUTS.map(([k, what]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{t(what)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{t('Die Kürzel gelten, solange kein Eingabefeld aktiv ist.')}</p>
    </Modal>
  );
}
