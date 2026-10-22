import { useEffect, useRef, useState } from 'react';
import { Icon, channelIcon } from '../icons';
import { api, ago, dt, msgStatus, name } from '../api';
import { act, Badge, confirmAsk, Empty, Input, Link, PageHead, pressable, Spinner, Tabs, toast, useLoad } from '../ui';
import { useSession, can } from '../session';
import { useT } from '../i18n';
import { lazyPages } from '../lazy';
import { Composer } from './Contacts';
import { AiComposerAddon, AiPanel, isBotMessage } from './AiAssistant';
import { ChannelFilter, ChannelIcon, MessageMedia, useMetaComposer } from './MetaInbox';
import { CallButton, CallInfo } from './Calls';
import { messageText } from './EmailBuilder';
import { MailEngagement } from './MailEngagement';
import { TicketFromConversation } from './Tickets';
import { SpamButton } from './InboxSpam';
import { InboxFilters, inboxFilterQs, type InboxFilterValue } from './InboxFilters';
import { MailBadges, MailMessageExtras, MailThreadPanel, MailboxBar } from './Mailboxes';
import { publishSelection } from '../xr/selection';
import { DRAFT_CHANNELS, DraftBubbleActions, pendingDraft } from './MsgDrafts';
import { Slot } from '../slots';
import { BulkBar, CollisionBanner, type FeedItem, NoteComposer, RowMeta, ShortcutHelp, ThreadBar, TimelineEntry, ViewRail, initialView, mergeFeed, rememberView, useInboxShortcuts, useTeamInbox } from './TeamInboxKit';

const { TeamInboxModal } = lazyPages(() => import('./TeamInboxSettings'), 'TeamInboxModal');

export function Conversations({ initial }: { initial?: string }) {
  const t = useT('inbox');
  const session = useSession();
  const [view, setViewState] = useState(initialView);
  const setView = (v: string) => (setViewState(v), rememberView(v), setChecked(new Set()));
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [help, setHelp] = useState(false);
  const [team, setTeam] = useState<'' | 'rules' | 'me'>('');
  const [noteKey, setNoteKey] = useState(0);
  const [snoozeKey, setSnoozeKey] = useState(0);
  const searchRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('all');
  const [channel, setChannel] = useState('');
  const [q, setQ] = useState('');
  const [mbx, setMbx] = useState({ mailbox: '', folder: '' });
  const [xf, setXf] = useState<InboxFilterValue>({ tag: '', pipeline_id: '', stage_id: '', owner: '' });
  const [sel, setSel] = useState(initial ?? '');
  const list = useLoad(() => api.get<any[]>(`/api/conversations?filter=${filter}&channel=${channel}&q=${encodeURIComponent(q)}${view !== 'all' ? `&view=${view}` : ''}${mbx.mailbox ? `&mailbox=${encodeURIComponent(mbx.mailbox)}&folder=${mbx.folder}` : ''}${inboxFilterQs(xf)}`), [filter, channel, q, mbx.mailbox, mbx.folder, view, inboxFilterQs(xf)]);
  const thread = useLoad(() => (sel ? api.get(`/api/conversations/${sel}/messages`) : Promise.resolve(null)), [sel]);
  const meta = useMetaComposer(thread.data?.contact, thread.data?.messages);
  const draft = pendingDraft(thread.data?.messages);
  // Arbeitsfläche: the contact panel follows the open conversation (no-op elsewhere).
  useEffect(() => void (thread.data?.contact?.id && publishSelection({ contactId: thread.data.contact.id })), [thread.data?.contact?.id]);
  const templates = useLoad(() => api.get<any[]>('/api/templates'), []);
  const inbox = useTeamInbox(sel, list.reload, thread.reload);
  const tx = inbox.enabled && inbox.meta ? inbox.meta : null;
  const rows = list.data ?? [];
  const toggle = (id: string) => setChecked((c) => (c.has(id) ? new Set([...c].filter((x) => x !== id)) : new Set([...c, id])));
  const quick = async (fn: () => Promise<unknown>) => {
    if (await act(fn)) inbox.refresh();
  };
  useInboxShortcuts(!!tx, {
    move: (d) => {
      const i = rows.findIndex((c) => c.id === sel);
      const next = rows[Math.min(rows.length - 1, Math.max(0, i < 0 ? (d > 0 ? 0 : rows.length - 1) : i + d))];
      if (next) setSel(next.id);
    },
    close: () => sel && inbox.state && quick(() => api.post(`/api/inbox/conversations/${sel}/status`, { status: inbox.state!.status === 'closed' ? 'open' : 'closed' })),
    mine: () => sel && quick(() => api.post(`/api/inbox/conversations/${sel}/assign`, { user_id: 'me' })),
    snooze: () => sel && setSnoozeKey((k) => k + 1),
    note: () => sel && setNoteKey((k) => k + 1),
    reply: () => document.querySelector<HTMLTextAreaElement>('.inbox .thread .composer textarea, .inbox .thread textarea:not(.tx-note-input)')?.focus(),
    toggle: () => sel && toggle(sel),
    search: () => searchRef.current?.querySelector('input')?.focus(),
    help: () => setHelp(true),
  });
  const box = useRef<HTMLDivElement>(null);
  // Scroll only the message pane, not the whole page.
  useEffect(() => {
    if (!box.current) return;
    box.current.scrollTop = box.current.scrollHeight;
    // Narrow windows scroll the whole conversation (web/src/ios/ios.css): start at the newest message and the composer.
    const pane = box.current.parentElement;
    if (pane && getComputedStyle(box.current).overflowY === 'visible' && pane.scrollHeight > pane.clientHeight) pane.scrollTop = pane.scrollHeight;
  }, [thread.data]);
  // Poll for new inbound messages.
  useEffect(() => {
    const timer = setInterval(() => {
      void list.reload();
      if (sel) void thread.reload();
    }, 20000);
    return () => clearInterval(timer);
  }, [sel]);

  const feedOf = (messages: any[]): FeedItem[] => (tx && inbox.state ? mergeFeed(messages, inbox.state.timeline) : messages.map((m) => ({ kind: 'message' as const, at: m.created_at as string, m })));
  const renderMessage = (m: any) => (
    <div key={m.id} className={`bubble ${m.direction}${m.status === 'draft' ? ' draft' : ''}${isBotMessage(m) ? ' bot' : ''}${m.channel === 'call' ? ` call ${m.status}` : ''}`}>
      {isBotMessage(m) && (
        <div className="bot-tag">
          <Icon name="bot" size={12} /> {m.status === 'draft' ? t('KI-Entwurf') : t('KI-Assistent')}
        </div>
      )}
      {m.subject && (
        <>
          <strong>{m.subject}</strong>
          <br />
        </>
      )}
      {messageText(m.body)}
      <MessageMedia m={m} />
      {m.comment && <Slot name="inbox.message" message={m} onChanged={() => (thread.reload(), list.reload())} />}
      <MailMessageExtras m={m} contact={thread.data.contact} onChanged={() => (thread.reload(), list.reload())} />
      {m.channel === 'call' && <CallInfo m={m} />}
      <div className="meta">
        <Icon name={channelIcon(m.channel)} size={12} /> {dt(m.created_at)} · {msgStatus(m.status)}
            <MailEngagement m={m} />
        {m.error ? ` – ${m.error}` : ''} {m.source && m.source !== 'manuell' ? `· ${m.source}` : ''}
      </div>
      {m.status === 'draft' && !m.mail && DRAFT_CHANNELS.includes(m.channel) && <DraftBubbleActions m={m} onChanged={() => (thread.reload(), list.reload())} />}
      {m.status === 'draft' && !m.mail && !DRAFT_CHANNELS.includes(m.channel) && (
        <div className="actions" style={{ marginTop: 6 }}>
          <button
            className="btn small"
            onClick={async () => {
              if (!confirmAsk(t('Entwurf jetzt an {to} senden?', { to: thread.data.contact.email || name(thread.data.contact) }))) return;
              const r = await act(() => api.post('/api/messages', { contact_id: thread.data.contact.id, channel: 'email', subject: m.subject, body: m.body }));
              if (r && r.status !== 'failed') {
                await api.del(`/api/messages/${m.id}`);
                toast(r.status === 'logged' ? t('Gespeichert (kein Versand-Anbieter eingerichtet)') : t('Gesendet'));
              } else if (r) toast(t('Nicht gesendet: {error}', { error: r.error }));
              thread.reload();
              list.reload();
            }}
          >
            {t('Senden')}
          </button>
          <button className="btn small secondary" onClick={async () => confirmAsk(t('Entwurf verwerfen?')) && (await act(() => api.del(`/api/messages/${m.id}`))) && (thread.reload(), list.reload())}>
            {t('Verwerfen')}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <PageHead title={t('Konversationen')} sub={t('Alle Kanäle aller Kontakte an einem Ort')}>
        {tx && (
          <>
            <button className="tx-btn" data-tour="inbox-availability" onClick={() => setTeam('me')}>
              <Icon name="vacation" size={16} /> {t('Meine Verfügbarkeit')}
            </button>
            <button className="tx-btn tx-keys-btn" onClick={() => setHelp(true)} aria-label={t('Tastaturkürzel')} title={t('Tastaturkürzel (?)')}>
              <Icon name="keypad" size={16} /> {t('Kürzel')}
            </button>
            {can(session, 'settings') && (
              <button className="tx-btn" data-tour="inbox-settings" onClick={() => setTeam('rules')}>
                <Icon name="settings" size={16} /> {t('Team & Regeln')}
              </button>
            )}
          </>
        )}
      </PageHead>
      <div className={`inbox${tx ? ' tx' : ''}${sel ? ' has-sel' : ''}`} data-tour="inbox">
        {tx && <ViewRail value={view} onChange={setView} counts={inbox.counts} meta={tx} />}
        <div className="list" data-tour="inbox-list">
          <div style={{ padding: 10, borderBottom: '1px solid var(--line)' }} data-tour="inbox-filters" ref={searchRef}>
            <Input value={q} onChange={setQ} placeholder={t('Suchen…')} aria-label={t('Konversationen durchsuchen')} />
            <Tabs tabs={[['all', t('Alle')], ['unread', t('Neu')], ['starred', '★'], ['drafts', t('Entwürfe')], ['spam', t('Spam')]]} value={filter} onChange={setFilter} />
            <ChannelFilter value={channel} onChange={setChannel} />
            <MailboxBar mailbox={mbx.mailbox} folder={mbx.folder} onChange={(mailbox, folder) => setMbx({ mailbox, folder })} />
            <InboxFilters value={xf} onChange={setXf} q={q} onOpen={setSel} />
          </div>
          {list.loading && !list.data ? (
            <Spinner />
          ) : list.data?.length ? (
            list.data.map((c) => (
              <div key={c.id} className={`item${c.id === sel ? ' on' : ''}${tx ? ' tx-item' : ''}`} aria-current={c.id === sel || undefined} {...pressable(() => setSel(c.id))}>
                {tx && (
                  <label className="tx-check" onClick={(e) => e.stopPropagation()} title={t('Für Sammelaktionen markieren (X)')}>
                    <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} aria-label={t('{name} auswählen', { name: name(c) })} />
                  </label>
                )}
                <div className="tx-item-body">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong className="conv-name">
                    {c.last_channel && <ChannelIcon channel={c.last_channel} />}
                    {c.starred ? '★ ' : ''}
                    {name(c)}
                  </strong>
                  <span className="muted small">{ago(c.last_message_at)}</span>
                </div>
                <div className="prev">
                  {c.unread > 0 && <Badge tone="blue">{c.unread}</Badge>} {c.last_message}
                </div>
                <MailBadges row={c} />
                {tx && <RowMeta c={c} />}
                </div>
              </div>
            ))
          ) : (
            <Empty learn>{t('Noch keine Konversationen.')}</Empty>
          )}
          {tx && checked.size > 0 && <BulkBar ids={[...checked]} meta={tx} onClear={() => setChecked(new Set())} onDone={() => (setChecked(new Set()), inbox.refresh())} />}
        </div>
        <div className="thread" data-tour="inbox-thread">
          {!sel || !thread.data ? (
            <Empty>{t('Konversation wählen.')}</Empty>
          ) : (
            <>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }} className="row">
                {/* Narrow windows show the list or the conversation, one at a time (web/src/ios/ios.css). */}
                <button className="btn small secondary inbox-back" onClick={() => setSel('')} aria-label={t('Zurück zur Liste')}>
                  ‹ {t('Liste')}
                </button>
                <div className="grow">
                  <Link to={`contacts/${thread.data.contact.id}`}>
                    <strong>{name(thread.data.contact)}</strong>
                  </Link>
                  <div className="muted small">
                    {thread.data.contact.email} {thread.data.contact.phone} {thread.data.contact.dnd ? <Badge tone="red">DND</Badge> : null}
                  </div>
                </div>
                <CallButton contactId={thread.data.contact.id} phone={thread.data.contact.phone} onStarted={thread.reload} />
                <TicketFromConversation key={sel} conversationId={sel} contact={thread.data.contact} />
                <SpamButton key={`spam-${thread.data.contact.id}`} contactId={thread.data.contact.id} onChanged={() => (thread.reload(), list.reload())} />
                <button
                  className="btn small secondary"
                  onClick={async () => {
                    await api.patch(`/api/conversations/${sel}`, { starred: !thread.data.conversation.starred });
                    thread.reload();
                    list.reload();
                  }}
                >
                  {thread.data.conversation.starred ? `★ ${t('Markiert')}` : `☆ ${t('Markieren')}`}
                </button>
                <button className="btn small secondary" onClick={async () => (await api.patch(`/api/conversations/${sel}`, { unread: true }), setSel(''), list.reload())}>
                  {t('Ungelesen')}
                </button>
              </div>
              {tx && inbox.state && <ThreadBar convId={sel} st={inbox.state} meta={tx} onChanged={inbox.refresh} snoozeKey={snoozeKey} />}
              <div className="msgs" ref={box} tabIndex={0} role="log" aria-label={t('Nachrichtenverlauf')}>
                {feedOf(thread.data.messages).map((item) =>
                  item.kind === 'team' ? (
                    <TimelineEntry key={item.t.id} t={item.t} me={tx?.me ?? null} admin={can(session, 'settings')} convId={sel} onChanged={inbox.refresh} />
                  ) : (
                    renderMessage(item.m)
                  ),
                )}
              </div>
              {tx && inbox.state && <NoteComposer convId={sel} people={tx.people} me={tx.me} focusKey={noteKey} onSaved={inbox.refresh} />}
              <MailThreadPanel conversationId={sel} contact={thread.data.contact} messages={thread.data.messages} onChanged={() => (thread.reload(), list.reload())} />
              {tx && <CollisionBanner viewers={inbox.viewers} />}
              {meta.ready && (
                <div onInput={tx ? inbox.typing : undefined} className="tx-composer-wrap">
                <Composer
                  key={thread.data.contact.id}
                  contact={thread.data.contact}
                  chat={thread.data.messages.some((m: any) => m.channel === 'chat')}
                  templates={templates.data}
                  extra={meta.extra}
                  initial={meta.initial}
                  draft={draft}
                  onSent={() => (thread.reload(), list.reload())}
                  addon={(a) => <AiComposerAddon contactId={thread.data.contact.id} conversationId={sel} {...a} />}
                />
                </div>
              )}
            </>
          )}
        </div>
        {sel && thread.data && <AiPanel conversationId={sel} refreshKey={thread.data.messages.length} />}
      </div>
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {team && <TeamInboxModal tab={team === 'me' ? 'people' : 'assign'} onClose={() => (setTeam(''), inbox.refresh())} />}
    </>
  );
}
