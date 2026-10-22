import { useEffect, useRef, useState } from 'react';
import { AtSign, Blocks, Check, CornerDownRight, FileText, Link2, MoreHorizontal, Paperclip, Pencil, Pin, PinOff, Send, Smile, SmilePlus, StickyNote, Trash2, X } from 'lucide-react';
import './collab.css';
import { ApiError, api, dt } from '../api';
import { confirmAsk, toast, toastError } from '../ui';
import { can, useSession } from '../session';
import { AutoTextarea, Avatar, EmbedCardView, EmojiMenu, Menu, Prose, RecordPicker, readAsDataUrl, refMarkdown, sizeLabel, timeOf, withLocation, type CardStore, type Person, type SlashItem } from './CollabKit';
import { useT } from '../i18n';

/** Team-Chat building blocks: one message, the composer and the shared types. */

export interface Msg {
  id: string;
  channel_id: string;
  thread_id: string | null;
  kind: 'user' | 'agent' | 'bot' | 'system';
  author: { id: string | null; name: string };
  body: string;
  html: string;
  text: string;
  mentions: string[];
  cards: { kind: string; id: string; label: string }[];
  files: { id: string; name: string; mime: string; size: number; image: boolean; url: string }[];
  reactions: { emoji: string; count: number; users: string[] }[];
  reply_count: number;
  last_reply_at: string | null;
  edited_at: string | null;
  deleted: boolean;
  pinned: boolean;
  pinned_at: string | null;
  via: string;
  meta: any;
  created_at: string;
}
export interface Chan {
  id: string;
  kind: 'public' | 'private' | 'dm' | 'group';
  name: string;
  label: string;
  topic: string;
  scope: 'location' | 'agency';
  members?: { id: string; name: string }[];
  member_count: number;
  role: 'owner' | 'member' | 'reader';
  joined: boolean;
  notify: '' | 'all' | 'mentions' | 'none';
  muted: boolean;
  unread: number;
  mentions: number;
  last_message_at: string | null;
  preview: { text: string; author: string } | null;
  archived: boolean;
  slack_mirror: boolean;
  can: { manage: boolean; post: boolean };
}
export interface Me {
  id: string;
  name: string;
  admin: boolean;
}

export const tombstone = (m: Msg): Msg => ({ ...m, deleted: true, body: '', html: '', text: '', files: [], cards: [], reactions: [], mentions: [] });

/** Puts a message into a list (by id), keeping the order of time. */
export function upsertMsg(list: Msg[], m: Msg): Msg[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = m;
    return next;
  }
  const out = [...list, m];
  out.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
  return out;
}

const touchOnly = () => typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;

// --- one message ------------------------------------------------------------------------------------------------------------------

export function MessageView({ m, cont, ch, me, store, selected, onSelect, onChange, onThread, onNote, mode = 'feed' }: { m: Msg; cont: boolean; ch: Chan; me: Me; store: CardStore; selected?: boolean; onSelect?: () => void; onChange: (m: Msg) => void; onThread?: (m: Msg) => void; onNote?: (m: Msg) => void; mode?: 'feed' | 'thread' | 'pins' }) {
  const t = useT('collab');
  const session = useSession();
  const [editing, setEditing] = useState<string | null>(null);
  const mine = !!m.author.id && m.author.id === me.id && m.kind === 'user';
  const agent = m.kind === 'agent' ? (m.meta?.agent as { status: string; asker_id: string; asker_name: string; pending: { id: string; title: string; summary: string }[] } | undefined) : undefined;
  const canPost = ch.can.post && ch.joined;

  const react = async (emoji: string) => {
    try {
      const r = await api.post(`/api/team-chat/messages/${m.id}/reactions`, { emoji });
      onChange({ ...m, reactions: r.reactions });
    } catch (e) {
      toastError(e);
    }
  };
  const pin = async () => {
    try {
      const r = m.pinned ? await api.del(`/api/team-chat/messages/${m.id}/pin`) : await api.post(`/api/team-chat/messages/${m.id}/pin`, {});
      onChange(r?.id ? r : { ...m, pinned: !m.pinned });
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async () => {
    if (!confirmAsk(t('Diese Nachricht löschen? Das lässt sich nicht rückgängig machen.'))) return;
    try {
      await api.del(`/api/team-chat/messages/${m.id}`);
      onChange(tombstone(m));
    } catch (e) {
      toastError(e);
    }
  };
  const saveEdit = async () => {
    if (editing === null) return;
    if (!editing.trim()) return toastError(new Error(t('Die Nachricht darf nicht leer sein.')));
    try {
      const r = await api.patch(`/api/team-chat/messages/${m.id}`, { body: editing });
      onChange(r);
      setEditing(null);
    } catch (e) {
      toastError(e);
    }
  };
  const decide = async (approve: boolean) => {
    try {
      await api.post(`/api/team-chat/messages/${m.id}/agent`, { approve });
      onChange({ ...m, meta: { ...m.meta, agent: { ...agent, status: 'running', pending: [] } } });
    } catch (e) {
      toastError(e);
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) onChange({ ...m, meta: { ...m.meta, agent: { ...agent, pending: [] } } });
    }
  };

  const link = `${location.origin}/app/team-chat/${m.channel_id}${m.thread_id ? `?thread=${m.thread_id}&m=${m.id}` : `?m=${m.id}`}`;
  const tools = !m.deleted && !editing && (
    <div className="tc-tools" role="toolbar" aria-label={t('Nachricht')}>
      {canPost && (
        <EmojiMenu onPick={react} trigger={<SmilePlus size={15} />} className="" left={false} up={false} />
      )}
      {canPost && mode === 'feed' && onThread && (
        <button type="button" title={t('In einem Thread antworten')} aria-label={t('Im Thread antworten')} onClick={() => onThread(m)}>
          <CornerDownRight size={15} />
        </button>
      )}
      <Menu
        title={t('Mehr')}
        className=""
        trigger={<MoreHorizontal size={15} />}
        items={[
          { label: m.pinned ? t('Pin entfernen') : t('Anpinnen'), icon: m.pinned ? <PinOff size={15} /> : <Pin size={15} />, onClick: () => void pin(), hidden: !canPost || !!m.thread_id },
          { label: t('Bearbeiten'), icon: <Pencil size={15} />, onClick: () => setEditing(m.body), hidden: !mine || !canPost },
          { label: t('Link kopieren'), icon: <Link2 size={15} />, onClick: () => void navigator.clipboard?.writeText(link).then(() => toast(t('Link kopiert'))) },
          { label: t('Als Notiz an einem Kontakt speichern …'), icon: <StickyNote size={15} />, onClick: () => onNote?.(m), hidden: !onNote || !can(session, 'contacts') },
          { sep: true, label: '' },
          { label: t('Löschen'), icon: <Trash2 size={15} />, danger: true, onClick: () => void remove(), hidden: !(mine || ch.can.manage) },
        ]}
      />
    </div>
  );

  return (
    <div
      id={`m-${m.id}`}
      className={`tc-msg${cont ? ' cont' : ''}${selected ? ' sel' : ''}`}
      onClick={(e) => {
        if (touchOnly() && !(e.target as HTMLElement).closest('a,button,input,textarea')) onSelect?.();
      }}
    >
      <div className="tc-gut">{cont ? <span title={dt(m.created_at)}>{timeOf(m.created_at)}</span> : <Avatar name={m.author.name} size={34} agent={m.kind === 'agent'} />}</div>
      <div className="tc-msg-main">
        {!cont && (
          <div className="tc-msg-head">
            <b>{m.author.name}</b>
            {m.kind === 'agent' && <span className="badge purple">{t('Agent')}</span>}
            {m.kind === 'bot' && <span className="badge gray">{m.via ? (m.via === 'mcp' ? t('KI-App') : m.via) : t('Bot')}</span>}
            <span className="tc-time" title={dt(m.created_at)}>
              {timeOf(m.created_at)}
            </span>
            {m.edited_at && !m.deleted && <span className="tc-edited">{t('(bearbeitet)')}</span>}
            {m.pinned && (
              <span className="tc-pin">
                <Pin size={11} /> {t('angepinnt')}
              </span>
            )}
          </div>
        )}
        {m.deleted ? (
          <span className="tc-gone">{t('Diese Nachricht wurde gelöscht.')}</span>
        ) : editing !== null ? (
          <div>
            <AutoTextarea
              value={editing}
              onChange={setEditing}
              autoGrow
              people={undefined}
              className="tc-edit"
              ariaLabel={t('Nachricht bearbeiten')}
              onEnter={() => void saveEdit()}
              onKey={(e) => {
                if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), setEditing(null), true;
              }}
            />
            <div className="ck-row" style={{ marginTop: 4 }}>
              <button className="btn small" onClick={() => void saveEdit()}>
                <Check size={13} /> {t('Speichern')}
              </button>
              <button className="btn small ghost" onClick={() => setEditing(null)}>
                {t('Abbrechen')}
              </button>
              <span className="muted small">{t('Enter speichert · Esc bricht ab')}</span>
            </div>
          </div>
        ) : (
          <>
            {m.kind === 'agent' ? (
              <div className={`tc-agent${agent?.status === 'error' ? ' error' : ''}`}>
                <Prose html={m.html} store={store} chat />
                {agent?.status === 'running' && (
                  <div className="tc-thinking small">
                    <span className="spinner" /> {t('Der Agent arbeitet …')}
                  </div>
                )}
                {agent?.status === 'awaiting' && agent.pending?.length > 0 && (
                  <div className="tc-ask" data-tour="chat-agent-confirm">
                    <b>{t('Der Agent möchte etwas ändern:')}</b>
                    {agent.pending.map((p) => (
                      <div key={p.id}>
                        {p.title}
                        <div className="muted small">{p.summary}</div>
                      </div>
                    ))}
                    {agent.asker_id === me.id ? (
                      <div className="ck-row" style={{ marginTop: 6 }}>
                        <button className="btn small" onClick={() => void decide(true)}>
                          {t('Ausführen')}
                        </button>
                        <button className="btn small secondary" onClick={() => void decide(false)}>
                          {t('Ablehnen')}
                        </button>
                      </div>
                    ) : (
                      <div className="muted small" style={{ marginTop: 4 }}>
                        {t('Wartet auf die Bestätigung von')} {agent.asker_name || t('der fragenden Person')} {t('– nur sie kann das freigeben.')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              m.html && <Prose html={m.html} store={store} chat />
            )}
            {cont && (m.pinned || m.edited_at) && (
              <span className="tc-edited">
                {m.pinned ? t('📌 angepinnt ') : ''}
                {m.edited_at ? t('(bearbeitet)') : ''}
              </span>
            )}
            {m.files.length > 0 && (
              <div className="tc-files">
                {m.files.map((f) =>
                  f.image ? (
                    <a key={f.id} href={withLocation(f.url)} target="_blank" rel="noopener noreferrer" title={f.name}>
                      <img className="tc-img" src={withLocation(f.url)} alt={f.name} loading="lazy" />
                    </a>
                  ) : (
                    <a key={f.id} className="tc-file" href={withLocation(`${f.url}?download=1`)} download={f.name}>
                      <FileText size={16} />
                      <span>{f.name}</span>
                      <span className="muted small">{sizeLabel(f.size)}</span>
                    </a>
                  ),
                )}
              </div>
            )}
            {m.cards.length > 0 && (
              <div className="ck-embeds">
                {m.cards.map((c) => (
                  <EmbedCardView key={`${c.kind}:${c.id}`} store={store} kind={c.kind} id={c.id} />
                ))}
              </div>
            )}
            {m.reactions.length > 0 && (
              <div className="tc-reacts">
                {m.reactions.map((r) => (
                  <button key={r.emoji} className={`tc-react${r.users.includes(me.id) ? ' mine' : ''}`} onClick={() => canPost && void react(r.emoji)} disabled={!canPost} title={r.users.includes(me.id) ? t('Deine Reaktion entfernen') : t('Auch so reagieren')} aria-pressed={r.users.includes(me.id)}>
                    {r.emoji} {r.count}
                  </button>
                ))}
              </div>
            )}
            {mode === 'feed' && m.reply_count > 0 && onThread && (
              <button className="tc-thread-link" onClick={() => onThread(m)}>
                <CornerDownRight size={13} /> {t.plural(m.reply_count, { one: '{n} Antwort', other: '{n} Antworten' })}
              </button>
            )}
          </>
        )}
      </div>
      {tools}
    </div>
  );
}

// --- composer ---------------------------------------------------------------------------------------------------------------------------

const drafts = new Map<string, string>();
interface Pending {
  id: string;
  name: string;
  size: number;
}
const UPLOAD = /^(image\/(png|jpeg|gif|webp)|application\/(pdf|zip)|text\/(plain|csv)|application\/vnd\.(openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|oasis\.opendocument\.(text|spreadsheet|presentation)))$/;

export function Composer({ ch, threadId, people, groupMention, onPosted, onFocusFeed, placeholder, autoFocus }: { ch: Chan; threadId?: string; people: Person[]; groupMention?: boolean; onPosted: (msgs: Msg[]) => void; onFocusFeed?: () => void; placeholder?: string; autoFocus?: boolean }) {
  const t = useT('collab');
  const session = useSession();
  const key = `${ch.id}${threadId ? `:${threadId}` : ''}`;
  const [text, setText] = useState(() => drafts.get(key) ?? '');
  const [files, setFiles] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [choices, setChoices] = useState<{ id: string; label: string; sub?: string }[] | null>(null);
  const [picker, setPicker] = useState(false);
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  useEffect(() => {
    setText(drafts.get(key) ?? '');
    setFiles([]);
    setChoices(null);
  }, [key]);
  useEffect(() => {
    if (autoFocus) ta.current?.focus();
  }, [key, autoFocus]);
  const set = (v: string) => {
    setText(v);
    if (v) drafts.set(key, v);
    else drafts.delete(key);
  };

  const slash: SlashItem[] = [
    ...(can(session, 'contacts') ? [{ key: 'aufgabe', label: '/aufgabe', sub: t('Aufgabe anlegen – „… morgen @Person“'), insert: '/aufgabe ' }] : []),
    ...(can(session, 'contacts') ? [{ key: 'kontakt', label: '/kontakt', sub: t('Kontakt als Karte teilen'), insert: '/kontakt ' }] : []),
    { key: 'agent', label: '/agent', sub: t('HyperLevel Agent fragen'), insert: '/agent ' },
  ];

  const canPost = ch.can.post;
  const typing = () => {
    const now = Date.now();
    if (now - lastTyping.current < 2500 || !ch.joined) return;
    lastTyping.current = now;
    void api.post(`/api/team-chat/channels/${ch.id}/typing`, { thread_id: threadId }).catch(() => {});
  };

  const upload = async (list: File[]) => {
    for (const f of list) {
      if (files.length + uploading >= 10) {
        toastError(new Error(t('Höchstens 10 Dateien je Nachricht.')));
        break;
      }
      if (!UPLOAD.test(f.type)) {
        toastError(new Error(t('„{name}“: Erlaubt sind Bilder (PNG, JPG, GIF, WebP), PDF, Text/CSV, Office-Dokumente und ZIP.', { name: f.name })));
        continue;
      }
      if (f.size > 8 * 1024 * 1024) {
        toastError(new Error(t('„{name}“ ist größer als 8 MB.', { name: f.name })));
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const r = await api.post(`/api/team-chat/channels/${ch.id}/files`, { name: f.name || 'Bild.png', data: await readAsDataUrl(f) });
        setFiles((cur) => [...cur, { id: r.id, name: r.name, size: r.size }]);
      } catch (e) {
        toastError(e);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const send = async (override?: string) => {
    const body = (override ?? text).trim();
    if ((!body && !files.length) || busy || uploading) return;
    setBusy(true);
    try {
      const r = await api.post(`/api/team-chat/channels/${ch.id}/messages`, { body, files: files.map((f) => f.id), thread_id: threadId });
      if (r?.choices) {
        setChoices(r.choices);
        return;
      }
      setChoices(null);
      set('');
      setFiles([]);
      onPosted(r?.messages ?? (r?.message ? [r.message] : r?.id ? [r] : []));
      if (r?.command === 'agent') toast(t('Der Agent antwortet gleich im Kanal.'));
      ta.current?.focus();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!ch.joined && ch.kind === 'public')
    return (
      <div className="tc-compose">
        <div className="ck-banner" style={{ marginBottom: 0 }}>
          <span className="grow">{t('Du liest mit. Tritt dem Kanal bei, um zu schreiben und Benachrichtigungen zu bekommen.')}</span>
          <button
            className="btn small"
            onClick={async () => {
              try {
                await api.post(`/api/team-chat/channels/${ch.id}/join`, {});
                onPosted([]);
              } catch (e) {
                toastError(e);
              }
            }}
          >
            {t('Kanal beitreten')}
          </button>
        </div>
      </div>
    );
  if (!canPost)
    return (
      <div className="tc-compose">
        <p className="muted small" style={{ margin: 0 }}>
          {ch.archived ? t('Dieser Kanal ist archiviert – es kann nichts mehr geschrieben werden.') : t('Du kannst hier nicht schreiben.')}
        </p>
      </div>
    );

  return (
    <div className="tc-compose" data-tour="chat-composer">
      {choices && (
        <div className="tc-choices" role="listbox" aria-label={t('Kontakt wählen')}>
          <h4>{t('Welcher Kontakt?')}</h4>
          {choices.map((c) => (
            <button
              key={c.id}
              role="option"
              aria-selected="false"
              onClick={() => {
                setChoices(null);
                void send(`/kontakt id:${c.id}`);
              }}
            >
              <b>{c.label}</b>
              {c.sub && <span className="muted small">{c.sub}</span>}
            </button>
          ))}
          <button onClick={() => setChoices(null)}>
            <span className="muted">{t('Abbrechen')}</span>
          </button>
        </div>
      )}
      <div
        className="tc-box"
        onDragOver={(e) => [...e.dataTransfer.types].includes('Files') && e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          void upload([...e.dataTransfer.files]);
        }}
      >
        {(files.length > 0 || uploading > 0) && (
          <div className="tc-pending">
            {files.map((f) => (
              <span key={f.id}>
                <Paperclip size={12} /> {f.name} <span className="muted">{sizeLabel(f.size)}</span>
                <button aria-label={t('{name} entfernen', { name: f.name })} onClick={() => setFiles(files.filter((x) => x.id !== f.id))}>
                  <X size={12} />
                </button>
              </span>
            ))}
            {uploading > 0 && <span>{t('Lädt hoch …')}</span>}
          </div>
        )}
        <AutoTextarea
          ref={ta}
          value={text}
          onChange={set}
          people={people}
          groupMention={groupMention}
          slash={slash}
          slashMode="start"
          up
          autoGrow
          rows={1}
          onEnter={() => void send()}
          onType={typing}
          onPasteFiles={(fs) => void upload(fs)}
          placeholder={placeholder ?? (threadId ? t('Im Thread antworten …') : t('Nachricht an {name}', { name: ch.label }))}
          ariaLabel={t('Nachricht')}
          tour="chat-input"
          onKey={(e) => {
            if (e.key === 'Escape' && !text) return onFocusFeed?.(), true;
          }}
        />
        <div className="tc-box-bar">
          <button type="button" className="ic" title={t('Datei anhängen')} aria-label={t('Datei anhängen')} onClick={() => file.current?.click()} data-tour="chat-attach">
            <Paperclip size={17} />
          </button>
          <EmojiMenu onPick={(e) => set(text + e)} trigger={<Smile size={17} />} />
          <button type="button" className="ic" title={t('Person erwähnen')} aria-label={t('Person erwähnen')} onClick={() => (set(`${text}${text && !/\s$/.test(text) ? ' ' : ''}@`), ta.current?.focus())}>
            <AtSign size={17} />
          </button>
          {can(session, 'wiki') && (
            <button type="button" className="ic" title={t('Datensatz, Board oder Wiki-Seite teilen')} aria-label={t('Datensatz teilen')} onClick={() => setPicker(true)} data-tour="chat-share">
              <Blocks size={17} />
            </button>
          )}
          <span className="grow" />
          <span className="tc-hint">{t('Enter sendet · Umschalt+Enter neue Zeile · / Befehle')}</span>
          <button className="btn small" onClick={() => void send()} disabled={busy || !!uploading || (!text.trim() && !files.length)} aria-label={t('Senden')} data-tour="chat-send">
            <Send size={14} /> {t('Senden')}
          </button>
        </div>
      </div>
      <input
        ref={file}
        type="file"
        multiple
        className="ck-sr"
        tabIndex={-1}
        aria-label={t('Dateien anhängen')}
        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,application/zip,text/plain,text/csv,.docx,.xlsx,.pptx,.odt,.ods,.odp"
        onChange={(e) => {
          const fs = [...(e.target.files ?? [])];
          e.target.value = '';
          void upload(fs);
        }}
      />
      {picker && (
        <RecordPicker
          title={t('Teilen')}
          onClose={() => setPicker(false)}
          onPick={(p) => {
            setPicker(false);
            set(`${text}${text && !/\s$/.test(text) ? ' ' : ''}${refMarkdown(p)} `);
            ta.current?.focus();
          }}
        />
      )}
    </div>
  );
}
