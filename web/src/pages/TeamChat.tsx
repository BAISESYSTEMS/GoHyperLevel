import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, Bell, BellOff, Hash, Lock, MessageSquareText, Pin, Plus, Settings2, Users } from 'lucide-react';
import './collab.css';
import { api, currentLocation } from '../api';
import { Empty, Spinner, navigate, toast, toastError, useLoad } from '../ui';
import { useSession } from '../session';
import { Avatar, Menu, dayLabel, replaceRoute, useCardStore, type CardStore } from './CollabKit';
import { Composer, MessageView, upsertMsg, type Chan, type Me, type Msg } from './ChatParts';
import { ChannelSettingsDialog, ChatSettingsDialog, NewChannelDialog, NewDmDialog, NoteDialog, PinsPanel, SearchPanel, ThreadPanel, type Bus, type PersonRow } from './ChatDialogs';
import { useT } from '../i18n';

/**
 * Team-Chat: channels and direct messages with threads, reactions, files, mentions, pins, search, typing and
 * presence. Realtime is one Server-Sent-Events stream per tab; everything the person does is an ordinary request.
 * Contract: docs/team-chat.md.
 */

const randomId = () => {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
};
function makeBus() {
  const fns = new Set<(event: string, data: any) => void>();
  return {
    on: (fn: (event: string, data: any) => void) => {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
    emit: (event: string, data: any) => fns.forEach((f) => f(event, data)),
  };
}
const watching = () => document.visibilityState === 'visible' && document.hasFocus();
const isPhone = () => matchMedia('(max-width: 860px)').matches;

type Panel = null | { kind: 'thread'; id: string } | { kind: 'pins' } | { kind: 'search'; q: string };
type Typing = Record<string, Record<string, { name: string; at: number }>>;

export function TeamChat({ id }: { id?: string }) {
  const t = useT('collab');
  const session = useSession();
  const loc = session.locationId;
  const [chans, setChans] = useState<Chan[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [slack, setSlack] = useState(false);
  const [err, setErr] = useState('');
  const people = useLoad<PersonRow[]>(() => api.get('/api/team-chat/people'), []);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');
  /** Counts the streams opened after a `bye` (a new one when the tab is looked at again). */
  const [conn, setConn] = useState(0);
  const [typing, setTyping] = useState<Typing>({});
  const store = useCardStore('/api/team-chat/cards');
  const clientId = useMemo(randomId, [loc]);
  const bus = useMemo(makeBus, []);
  const [dlg, setDlg] = useState<null | 'channel' | 'dm' | 'chat'>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [q, setQ] = useState('');
  const [note, setNote] = useState<Msg | null>(null);
  const [jump, setJump] = useState<string | undefined>();
  const chansRef = useRef<Chan[]>([]);
  chansRef.current = chans ?? [];
  const meRef = useRef<Me | null>(null);
  meRef.current = me;
  const activeRef = useRef<string | undefined>(id);
  activeRef.current = id;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // --- channel list ---
  const reload = useCallback(async () => {
    try {
      const r = await api.get('/api/team-chat/channels');
      setChans(r.channels);
      setMe(r.me);
      setSlack(!!r.slack);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  const reloadSoon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void reload(), 300);
  }, [reload]);
  useEffect(() => {
    void reload();
    return () => clearTimeout(timer.current);
  }, [reload, loc]);

  const patchChan = (cid: string, fn: (c: Chan) => Chan) => setChans((cs) => cs && cs.map((c) => (c.id === cid ? fn(c) : c)));
  const markRead = useCallback((cid: string) => {
    patchChan(cid, (c) => (c.unread || c.mentions ? { ...c, unread: 0, mentions: 0 } : c));
    void api.post(`/api/team-chat/channels/${cid}/read`, {}).catch(() => {});
  }, []);

  // the menu's badge follows what is unread (muted channels stay out of the total)
  useEffect(() => {
    if (!chans) return;
    let unread = 0;
    let mentions = 0;
    for (const c of chans) if (c.joined && !c.muted) (unread += c.unread, (mentions += c.mentions));
    window.dispatchEvent(new CustomEvent('pghl:chat-unread', { detail: { unread, mentions } }));
  }, [chans]);

  // --- realtime ---
  useEffect(() => {
    const es = new EventSource(`/api/team-chat/stream?clientId=${clientId}&locationId=${encodeURIComponent(currentLocation())}`);
    // a stream opened again after a `bye` may have missed messages: its hello reloads the list
    let seen = conn > 0;
    let parked = false;
    const on = (name: string, fn: (d: any) => void) => es.addEventListener(name, (e) => fn(JSON.parse((e as MessageEvent).data)));
    es.onopen = () => setStatus('online');
    es.onerror = (e) => {
      setStatus('offline');
      // an error answer (503 when the server is full, 401/403 …) closes the stream for good: one new try when the tab is
      // looked at again, like after `bye` (a dropped line is retried by the browser itself)
      if (es.readyState === EventSource.CLOSED) parked = true;
      const d = (e as MessageEvent).data;
      if (d) {
        try {
          toastError(new Error(JSON.parse(d).error));
        } catch {
          /* a plain connection error */
        }
      }
    };
    on('hello', (d) => {
      setOnline(new Set(d.online));
      setStatus('online');
      if (seen) reloadSoon();
      seen = true;
      bus.emit('hello', d);
    });
    on('presence', (d) =>
      setOnline((s) => {
        const n = new Set(s);
        if (d.online) n.add(d.user_id);
        else n.delete(d.user_id);
        return n;
      }),
    );
    on('typing', (d) => {
      if (d.user_id === meRef.current?.id) return;
      const key = `${d.channel_id}|${d.thread_id ?? ''}`;
      setTyping((cur) => ({ ...cur, [key]: { ...cur[key], [d.user_id]: { name: d.name, at: Date.now() } } }));
    });
    on('channel', (d) => {
      reloadSoon();
      if (d.change === 'deleted' && activeRef.current === d.id) replaceRoute('/app/team-chat');
    });
    on('read', (d) => patchChan(d.channel_id, (c) => (c.unread || c.mentions ? { ...c, unread: 0, mentions: 0 } : c)));
    on('message', (d: Msg) => {
      const known = chansRef.current.find((c) => c.id === d.channel_id);
      if (!known) reloadSoon();
      else if (!d.thread_id) {
        const mine = d.author.id === meRef.current?.id;
        const seeing = d.channel_id === activeRef.current && watching();
        patchChan(d.channel_id, (c) => ({
          ...c,
          last_message_at: d.created_at,
          preview: { text: d.text.slice(0, 100) || '📎', author: d.author.name },
          unread: mine || seeing ? c.unread : c.unread + 1,
          mentions: mine || seeing || !d.mentions.includes(meRef.current?.id ?? '') ? c.mentions : c.mentions + 1,
        }));
      }
      // who typed has finished
      setTyping((cur) => {
        const key = `${d.channel_id}|${d.thread_id ?? ''}`;
        if (!cur[key]?.[d.author.id ?? '']) return cur;
        const { [d.author.id ?? '']: _gone, ...rest } = cur[key];
        return { ...cur, [key]: rest };
      });
      bus.emit('message', d);
    });
    for (const n of ['message-edit', 'message-delete', 'reaction']) on(n, (d) => bus.emit(n, d));
    // the server ended the stream for good (signed out, session revoked or expired, no access any more): no reconnect
    // loop – one new try when the tab is looked at again
    es.addEventListener('bye', () => {
      es.close();
      parked = true;
      setStatus('offline');
    });
    const back = () => {
      if (parked && !document.hidden) setConn((n) => n + 1);
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      document.removeEventListener('visibilitychange', back);
      es.close();
    };
  }, [clientId, bus, reloadSoon, conn]);

  // "this tab is in the foreground": keeps push quiet while you are reading
  useEffect(() => {
    const ping = () => void api.post('/api/team-chat/presence', { client_id: clientId, active: watching() }).catch(() => {});
    ping();
    const timer = setInterval(ping, 30_000);
    document.addEventListener('visibilitychange', ping);
    window.addEventListener('focus', ping);
    window.addEventListener('blur', ping);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', ping);
      window.removeEventListener('focus', ping);
      window.removeEventListener('blur', ping);
    };
  }, [clientId]);
  useEffect(() => {
    const timer = setInterval(() => setTyping((cur) => {
      const now = Date.now();
      let changed = false;
      const next: Typing = {};
      for (const [k, v] of Object.entries(cur)) {
        const keep = Object.fromEntries(Object.entries(v).filter(([, x]) => now - x.at < 5000));
        if (Object.keys(keep).length !== Object.keys(v).length) changed = true;
        if (Object.keys(keep).length) next[k] = keep;
      }
      return changed ? next : cur;
    }), 2000);
    return () => clearInterval(timer);
  }, []);

  // --- routing: landing page picks the first channel, links may carry ?thread= and ?m= ---
  useEffect(() => {
    if (id || !chans || isPhone()) return;
    const first = chans.find((c) => c.kind === 'public' && c.joined) ?? chans.find((c) => c.joined) ?? chans[0];
    if (first) replaceRoute(`/app/team-chat/${first.id}`);
  }, [id, chans]);
  useEffect(() => {
    setPanel(null);
    const p = new URLSearchParams(location.search);
    const th = p.get('thread');
    const m = p.get('m');
    if (th) setPanel({ kind: 'thread', id: th });
    if (m) setJump(m);
    if (th || m) history.replaceState(null, '', location.pathname);
  }, [id]);

  const active = chans?.find((c) => c.id === id);
  const channels = (chans ?? []).filter((c) => c.kind === 'public' || c.kind === 'private');
  const dms = (chans ?? []).filter((c) => c.kind === 'dm' || c.kind === 'group').sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''));

  const openHit = (h: any) => {
    if (h.channel_id === id) {
      if (h.thread_id) setPanel({ kind: 'thread', id: h.thread_id });
      else setJump(h.id);
    } else navigate(`team-chat/${h.channel_id}?${h.thread_id ? `thread=${h.thread_id}&` : ''}m=${h.id}`);
  };
  const doSearch = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (q.trim().length >= 2) setPanel({ kind: 'search', q: q.trim() });
  };

  const row = (c: Chan) => {
    const other = c.kind === 'dm' ? c.members?.find((m) => m.id !== me?.id) : undefined;
    const isOn = c.id === id;
    return (
      <a key={c.id} href={`/app/team-chat/${c.id}`} className={`tc-ch${isOn ? ' on' : ''}${c.unread || c.mentions ? ' unread' : ''}${!c.joined ? ' dim' : ''}`} onClick={(e) => (e.metaKey || e.ctrlKey ? undefined : (e.preventDefault(), navigate(`team-chat/${c.id}`)))} aria-current={isOn ? 'page' : undefined}>
        {c.kind === 'public' ? <Hash size={16} /> : c.kind === 'private' ? <Lock size={15} /> : c.kind === 'dm' ? <Avatar name={other?.name ?? c.label} size={22} online={!!other && online.has(other.id)} /> : <Users size={16} />}
        <span className="tc-name">{c.kind === 'public' || c.kind === 'private' ? c.name : c.label}</span>
        {c.scope === 'agency' && (c.kind === 'public' || c.kind === 'private') && <span className="muted small">{t('Agentur')}</span>}
        {c.muted && <BellOff size={13} aria-label={t('Stumm')} />}
        {c.mentions > 0 ? <span className="tc-count mention" aria-label={t.plural(c.mentions, { other: '{n} Erwähnungen' })}>{c.mentions}</span> : c.unread > 0 ? <span className={`tc-count${c.muted ? ' muted' : ''}`} aria-label={t('{n} ungelesen', { n: c.unread })}>{c.unread > 99 ? '99+' : c.unread}</span> : null}
      </a>
    );
  };

  return (
    <div className={`tc${id ? ' in-chat' : ''}`} data-tour="chat-page">
      <aside className="tc-side" aria-label={t('Kanäle und Direktnachrichten')}>
        <div className="tc-side-head">
          <div className="ck-row">
            <h1>{t('Team-Chat')}</h1>
            <span className={`small ${status === 'online' ? '' : 'muted'}`} title={status === 'online' ? t('Verbunden – Nachrichten kommen sofort an') : status === 'connecting' ? t('Verbindet …') : t('Keine Verbindung – wird neu aufgebaut')} role="status" style={{ color: status === 'online' ? 'var(--green)' : undefined }}>
              ●
            </span>
            <Menu
              title={t('Neu')}
              trigger={<Plus size={16} />}
              tour="chat-new"
              items={[
                { label: t('Neuer Kanal …'), icon: <Hash size={15} />, onClick: () => setDlg('channel') },
                { label: t('Neue Direktnachricht …'), icon: <MessageSquareText size={15} />, onClick: () => setDlg('dm') },
                { sep: true, label: '' },
                { label: t('Chat-Einstellungen …'), icon: <Settings2 size={15} />, onClick: () => setDlg('chat') },
              ]}
            />
          </div>
          <form onSubmit={doSearch} role="search" data-tour="chat-search">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Nachrichten suchen …')} aria-label={t('Nachrichten suchen')} />
          </form>
        </div>
        <div className="tc-scroll" data-tour="chat-channels">
          {err && <p className="muted" style={{ padding: 10 }}>{err}</p>}
          {!chans && !err && <Spinner />}
          {chans && (
            <>
              <div className="tc-sec">
                <span>{t('Kanäle')}</span>
                <button className="icon-btn" aria-label={t('Neuer Kanal')} title={t('Neuer Kanal')} onClick={() => setDlg('channel')}>
                  <Plus size={14} />
                </button>
              </div>
              {channels.map(row)}
              {!channels.length && <p className="muted small" style={{ padding: '2px 10px' }}>{t('Noch keine Kanäle.')}</p>}
              <div className="tc-sec" data-tour="chat-dms">
                <span>{t('Direktnachrichten')}</span>
                <button className="icon-btn" aria-label={t('Neue Direktnachricht')} title={t('Neue Direktnachricht')} onClick={() => setDlg('dm')}>
                  <Plus size={14} />
                </button>
              </div>
              {dms.map(row)}
              {!dms.length && <p className="muted small" style={{ padding: '2px 10px' }}>{t('Schreibe einer Person direkt – mit „+“.')}</p>}
            </>
          )}
        </div>
      </aside>
      <section className="tc-main">
        {active && me ? (
          <Conversation
            key={active.id}
            ch={active}
            me={me}
            people={people.data ?? []}
            online={online}
            store={store}
            bus={bus}
            typing={typing}
            markRead={markRead}
            panel={panel}
            setPanel={setPanel}
            jump={jump}
            onJumped={() => setJump(undefined)}
            onSettings={() => setSettingsFor(active.id)}
            onNote={setNote}
            onChanged={reload}
            openHit={openHit}
            slackOn={slack}
          />
        ) : chans && id ? (
          <div className="tc-empty">
            <Empty action={<button className="btn secondary" onClick={() => navigate('team-chat')}>{t('Zur Übersicht')}</button>}>{t('Diesen Kanal gibt es nicht (mehr) oder du hast keinen Zugriff.')}</Empty>
          </div>
        ) : chans ? (
          <div className="tc-empty">
            <MessageSquareText size={34} />
            <p>{t('Wähle links einen Kanal oder eine Unterhaltung.')}</p>
          </div>
        ) : (
          <Spinner />
        )}
        {panel?.kind === 'search' && !active && <SearchPanel q={panel.q} onClose={() => setPanel(null)} onOpen={openHit} />}
      </section>
      {dlg === 'channel' && me && (
        <NewChannelDialog
          me={me}
          people={people.data ?? []}
          onClose={() => setDlg(null)}
          onCreated={(c) => {
            setDlg(null);
            void reload();
            navigate(`team-chat/${c.id}`);
          }}
        />
      )}
      {dlg === 'dm' && (
        <NewDmDialog
          people={people.data ?? []}
          onClose={() => setDlg(null)}
          onOpened={(c) => {
            setDlg(null);
            void reload();
            navigate(`team-chat/${c.id}`);
          }}
        />
      )}
      {dlg === 'chat' && me && <ChatSettingsDialog me={me} onClose={() => setDlg(null)} />}
      {settingsFor && me && chans?.find((c) => c.id === settingsFor) && (
        <ChannelSettingsDialog
          ch={chans.find((c) => c.id === settingsFor)!}
          me={me}
          people={people.data ?? []}
          slack={slack}
          onClose={() => setSettingsFor(null)}
          onChanged={() => void reload()}
          onLeft={() => {
            setSettingsFor(null);
            void reload();
            navigate('team-chat');
          }}
        />
      )}
      {note && <NoteDialog msg={note} onClose={() => setNote(null)} />}
    </div>
  );
}

// --- one conversation -----------------------------------------------------------------------------------------------------------------

function Conversation({ ch, me, people, online, store, bus, typing, markRead, panel, setPanel, jump, onJumped, onSettings, onNote, onChanged, openHit, slackOn }: { ch: Chan; me: Me; people: PersonRow[]; online: Set<string>; store: CardStore; bus: Bus; typing: Typing; markRead: (id: string) => void; panel: Panel; setPanel: (p: Panel) => void; jump?: string; onJumped: () => void; onSettings: () => void; onNote: (m: Msg) => void; onChanged: () => void; openHit: (h: any) => void; slackOn: boolean }) {
  const t = useT('collab');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [older, setOlder] = useState(false);
  const [lastRead, setLastRead] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [unseen, setUnseen] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<number | null>(null);
  const readTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const first = useRef(true);
  const direct = ch.kind === 'dm' || ch.kind === 'group';
  const other = ch.kind === 'dm' ? ch.members?.find((m) => m.id !== me.id) : undefined;

  const load = useCallback(async () => {
    try {
      const initial = first.current;
      const r = await api.get(`/api/team-chat/channels/${ch.id}/messages?limit=50`);
      setMsgs(r.messages);
      setMore(r.has_more);
      // the "Neu" line stays where it was when the channel was opened
      if (initial) setLastRead(r.last_read_at);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [ch.id]);
  useEffect(() => {
    first.current = true;
    stick.current = true;
    void load().then(() => (first.current = false));
    return () => clearTimeout(readTimer.current);
  }, [load]);

  const scheduleRead = useCallback(() => {
    clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => watching() && ch.joined && markRead(ch.id), 500);
  }, [ch.id, ch.joined, markRead]);
  useEffect(() => {
    if (!loading) scheduleRead();
    const f = () => scheduleRead();
    window.addEventListener('focus', f);
    document.addEventListener('visibilitychange', f);
    return () => {
      window.removeEventListener('focus', f);
      document.removeEventListener('visibilitychange', f);
    };
  }, [loading, scheduleRead]);

  useEffect(
    () =>
      bus.on((ev, d) => {
        if (ev === 'hello') return void load();
        if (ev === 'message' && d.channel_id === ch.id && !d.thread_id) {
          setMsgs((l) => upsertMsg(l, d));
          if (!stick.current && d.author.id !== me.id) setUnseen((n) => n + 1);
          scheduleRead();
        } else if (ev === 'message-edit' && d.channel_id === ch.id) setMsgs((l) => (l.some((x) => x.id === d.id) ? upsertMsg(l, d) : l));
        else if (ev === 'message-delete' && d.channel_id === ch.id && d.message) setMsgs((l) => (l.some((x) => x.id === d.id) ? upsertMsg(l, d.message) : l));
        else if (ev === 'reaction' && d.channel_id === ch.id) setMsgs((l) => l.map((x) => (x.id === d.message_id ? { ...x, reactions: d.reactions } : x)));
      }),
    [bus, ch.id, me.id, load, scheduleRead],
  );

  // --- scrolling: stay at the bottom while reading along, keep the place when older messages arrive ---
  const toBottom = () => {
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  /** Opening a channel: down to the end – or, with more unread than fits, to the "Neu" line. Cards and images grow
   *  after the first paint, so the position is kept for a moment (until the person scrolls). */
  const settleUntil = useRef(0);
  const place = () => {
    const el = feed.current;
    if (!el) return;
    const mark = document.getElementById('tc-new');
    if (!mark || el.scrollHeight - mark.offsetTop <= el.clientHeight) {
      stick.current = true;
      toBottom();
    } else {
      stick.current = false;
      el.scrollTop = Math.max(0, mark.offsetTop - 24);
    }
  };
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (Date.now() < settleUntil.current) place();
      else if (stick.current) toBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = feed.current;
    if (!el) return;
    if (anchor.current !== null) {
      el.scrollTop += el.scrollHeight - anchor.current;
      anchor.current = null;
    } else if (stick.current) toBottom();
  }, [msgs]);
  const firstNew = useMemo(() => (lastRead ? msgs.find((m) => m.created_at > lastRead && m.author.id !== me.id && m.kind !== 'system')?.id : undefined), [msgs, lastRead, me.id]);
  const didInitial = useRef(false);
  useEffect(() => {
    didInitial.current = false;
  }, [ch.id]);
  useLayoutEffect(() => {
    if (loading || didInitial.current) return;
    didInitial.current = true;
    if (jump) return toBottom();
    settleUntil.current = Date.now() + 2500;
    place();
  }, [loading]);
  const loadOlder = useCallback(async () => {
    if (older || !more || !msgs.length) return false;
    setOlder(true);
    try {
      const r = await api.get(`/api/team-chat/channels/${ch.id}/messages?limit=50&before=${msgs[0].id}`);
      anchor.current = feed.current?.scrollHeight ?? 0;
      setMsgs((l) => r.messages.reduce((acc: Msg[], m: Msg) => upsertMsg(acc, m), l));
      setMore(r.has_more);
      return true;
    } catch (e) {
      toastError(e);
      return false;
    } finally {
      setOlder(false);
    }
  }, [older, more, msgs, ch.id]);

  // jump to a message (search hit, link, "Zur Nachricht springen")
  const tries = useRef(0);
  useEffect(() => {
    if (!jump || loading) return;
    const el = document.getElementById(`m-${jump}`);
    if (el) {
      tries.current = 0;
      stick.current = false;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2400);
      onJumped();
    } else if (more && tries.current < 8) {
      tries.current++;
      void loadOlder();
    } else {
      tries.current = 0;
      toast(t('Diese Nachricht ist nicht mehr da oder sehr alt.'));
      onJumped();
    }
  }, [jump, loading, msgs.length, more]);

  const typers = [...Object.values(typing[`${ch.id}|`] ?? {})].map((x) => x.name);
  const typingText = typers.length === 0 ? '' : typers.length === 1 ? t('{name} tippt …', { name: typers[0] }) : typers.length === 2 ? t('{a} und {b} tippen …', { a: typers[0], b: typers[1] }) : t('Mehrere Personen tippen …');
  const setNotify = async (notify: string) => {
    try {
      await api.patch(`/api/team-chat/channels/${ch.id}`, { notify });
      onChanged();
    } catch (e) {
      toastError(e);
    }
  };
  const change = (m: Msg) => setMsgs((l) => upsertMsg(l, m));

  return (
    <>
      <header className="tc-head">
        <button className="btn secondary small tc-back" onClick={() => navigate('team-chat')} aria-label={t('Zurück zur Liste')}>
          <ArrowLeft size={16} />
        </button>
        {ch.kind === 'public' ? <Hash size={18} /> : ch.kind === 'private' ? <Lock size={17} /> : ch.kind === 'dm' ? <Avatar name={other?.name ?? ch.label} size={28} online={!!other && online.has(other.id)} /> : <Users size={18} />}
        <div className="ck-grow">
          <h2>
            {ch.kind === 'public' || ch.kind === 'private' ? ch.name : ch.label}
            {ch.scope === 'agency' && !direct && <span className="badge blue" style={{ marginLeft: 8 }}>{t('Agentur')}</span>}
            {ch.archived && <span className="badge gray" style={{ marginLeft: 8 }}>{t('archiviert')}</span>}
          </h2>
          {(ch.topic || direct) && (
            <span className="tc-topic">
              {ch.topic || (ch.kind === 'dm' ? (other && online.has(other.id) ? t('online') : t('Direktnachricht')) : t.plural(ch.member_count, { other: '{n} Personen' }))}
            </span>
          )}
        </div>
        <button className="btn secondary small" onClick={() => setPanel(panel?.kind === 'pins' ? null : { kind: 'pins' })} title={t('Angepinnte Nachrichten')} aria-label={t('Angepinnte Nachrichten')} aria-pressed={panel?.kind === 'pins'} data-tour="chat-pins">
          <Pin size={15} />
        </button>
        {ch.joined && (
          <Menu
            title={t('Benachrichtigungen')}
            trigger={ch.muted ? <BellOff size={15} /> : <Bell size={15} />}
            items={[
              { label: `${ch.notify === 'all' || (!ch.notify && direct) ? '✓ ' : ''}${t('Alle Nachrichten')}`, onClick: () => void setNotify('all') },
              { label: `${ch.notify === 'mentions' || (!ch.notify && !direct) ? '✓ ' : ''}${t('Nur Erwähnungen')}`, onClick: () => void setNotify('mentions') },
              { label: `${ch.notify === 'none' ? '✓ ' : ''}${t('Stumm')}`, onClick: () => void setNotify('none') },
            ]}
          />
        )}
        <button className="btn secondary small" onClick={onSettings} title={direct ? t('Teilnehmer') : t('Mitglieder und Einstellungen')} aria-label={t('Mitglieder und Einstellungen')} data-tour="chat-settings">
          <Users size={15} /> {ch.member_count}
        </button>
      </header>
      <div
        className="tc-feed"
        ref={feed}
        onWheel={() => (settleUntil.current = 0)}
        onTouchStart={() => (settleUntil.current = 0)}
        onKeyDown={() => (settleUntil.current = 0)}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
          if (stick.current && unseen) setUnseen(0);
          if (el.scrollTop < 60 && more && !older && !loading) void loadOlder();
        }}
        tabIndex={-1}
        data-tour="chat-feed"
      >
        <div ref={inner}>
          {loading && <Spinner />}
          {err && <p className="muted" style={{ textAlign: 'center' }}>{err}</p>}
          {more && !loading && (
            <div className="tc-more">
              <button className="btn secondary small" onClick={() => void loadOlder()} disabled={older}>
                {older ? t('Lädt …') : t('Ältere Nachrichten laden')}
              </button>
            </div>
          )}
          {!loading && !more && !err && (
            <div className="tc-empty" style={{ padding: '24px 10px' }}>
              {msgs.length ? t('Anfang von {name}.', { name: ch.label }) : direct ? t('Schreibe die erste Nachricht an {name}.', { name: ch.label }) : t('Hier ist noch nichts los. Schreibe die erste Nachricht in {name}.', { name: ch.label })}
              <br />
              <span className="small">{t('Tipp: „/aufgabe …“ legt eine Aufgabe an, „/kontakt …“ teilt einen Kontakt, „/agent …“ fragt den KI-Agenten.')}</span>
            </div>
          )}
          {msgs.map((m, i) => {
            const prev = msgs[i - 1];
            const newDay = !prev || dayLabel(prev.created_at) !== dayLabel(m.created_at);
            const cont = !!prev && !newDay && prev.author.id === m.author.id && prev.author.name === m.author.name && prev.kind === m.kind && !prev.deleted && m.kind !== 'agent' && Date.parse(m.created_at) - Date.parse(prev.created_at) < 300_000 && m.id !== firstNew;
            return (
              <div key={m.id}>
                {newDay && <div className="tc-day">{dayLabel(m.created_at)}</div>}
                {m.id === firstNew && (
                  <div className="tc-new" id="tc-new">
                    {t('Neu')}
                  </div>
                )}
                <MessageView m={m} cont={cont} ch={ch} me={me} store={store} selected={sel === m.id} onSelect={() => setSel(sel === m.id ? null : m.id)} onChange={change} onThread={(x) => setPanel({ kind: 'thread', id: x.id })} onNote={onNote} />
              </div>
            );
          })}
        </div>
        {unseen > 0 && (
          <button
            className="btn small"
            style={{ position: 'sticky', bottom: 6, left: '50%', transform: 'translateX(-50%)' }}
            onClick={() => {
              stick.current = true;
              setUnseen(0);
              toBottom();
            }}
          >
            <ArrowDown size={14} /> {unseen} {t('neue')} {unseen === 1 ? t('Nachricht') : t('Nachrichten')}
          </button>
        )}
      </div>
      <div className="tc-typing" aria-live="polite">
        {typingText}
      </div>
      <Composer
        ch={ch}
        people={people}
        groupMention={!direct}
        onPosted={(ms) => {
          stick.current = true;
          setMsgs((l) => ms.reduce((acc, m) => upsertMsg(acc, m), l));
          if (!ms.length) onChanged();
        }}
        onFocusFeed={() => feed.current?.focus()}
        autoFocus={!isPhone()}
      />
      {panel?.kind === 'thread' && (
        <ThreadPanel
          ch={ch}
          me={me}
          parentId={panel.id}
          people={people}
          store={store}
          bus={bus}
          onClose={() => setPanel(null)}
          onNote={onNote}
          onParentChange={change}
        />
      )}
      {panel?.kind === 'pins' && <PinsPanel ch={ch} me={me} store={store} onClose={() => setPanel(null)} onJump={(m) => (setPanel(null), setTimeout(() => onJumpTo(m), 50))} />}
      {panel?.kind === 'search' && <SearchPanel q={panel.q} onClose={() => setPanel(null)} onOpen={(h) => (setPanel(null), openHit(h))} />}
      {slackOn && ch.slack_mirror && <span className="ck-sr">{t('Nachrichten dieses Kanals werden auch nach Slack gespiegelt.')}</span>}
    </>
  );

  function onJumpTo(m: Msg) {
    openHit({ id: m.id, channel_id: m.channel_id, thread_id: m.thread_id });
  }
}

