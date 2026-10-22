import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import './collab.css';
import { ago, api } from '../api';
import { Check as CheckBox, Empty, Field, Input, Select, Spinner, act, confirmAsk, useLoad } from '../ui';
import { Avatar, Dialog, Snippet, useDebounced, useEscape, useFocusReturn, type CardStore, type Person } from './CollabKit';
import { MessageView, Composer, upsertMsg, type Chan, type Me, type Msg } from './ChatParts';
import { useT } from '../i18n';

/** Team-Chat dialogs (channels, direct messages, settings) and the side panels (thread, pins, search). */

export interface Bus {
  on: (fn: (event: string, data: any) => void) => () => void;
}
export interface PersonRow extends Person {
  admin: boolean;
  online: boolean;
  me: boolean;
}

// --- people chips ----------------------------------------------------------------------------------------------------------------

function PeoplePick({ people, value, onChange, max }: { people: PersonRow[]; value: string[]; onChange: (v: string[]) => void; max?: number }) {
  const t = useT('collab');
  return (
    <div className="ck-people" role="group" aria-label={t('Personen')}>
      {people.map((p) => (
        <label key={p.id}>
          <input
            type="checkbox"
            checked={value.includes(p.id)}
            disabled={!value.includes(p.id) && max !== undefined && value.length >= max}
            onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))}
          />
          <Avatar name={p.name} size={20} online={p.online} /> {p.name}
        </label>
      ))}
      {!people.length && <span className="muted small">{t('Keine weiteren Personen in diesem Sub-Account.')}</span>}
    </div>
  );
}

// --- new channel / direct message -------------------------------------------------------------------------------------------------

export function NewChannelDialog({ me, people, onCreated, onClose }: { me: Me; people: PersonRow[]; onCreated: (c: Chan) => void; onClose: () => void }) {
  const t = useT('collab');
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [kind, setKind] = useState<'public' | 'private'>('public');
  const [scope, setScope] = useState<'location' | 'agency'>('location');
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/team-chat/channels', { name, topic, kind, scope, members: kind === 'private' ? members : [] }), t('Kanal angelegt'));
    setBusy(false);
    if (r) onCreated(r);
  };
  return (
    <Dialog
      title={t('Neuer Kanal')}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button className="btn" disabled={busy || name.trim().length < 2} onClick={create}>
            {t('Kanal anlegen')}
          </button>
        </>
      }
    >
      <Field label="Name" hint={t('Kleinbuchstaben, Ziffern und Bindestriche – z. B. vertrieb oder projekt-müller.')}>
        <Input value={name} onChange={setName} maxLength={40} placeholder={t('z. B. vertrieb')} />
      </Field>
      <Field label={t('Thema (optional)')}>
        <Input value={topic} onChange={setTopic} maxLength={250} placeholder={t('Worum geht es hier?')} />
      </Field>
      <Field label={t('Wer darf mitlesen?')}>
        <Select
          value={kind}
          onChange={(v) => setKind(v as 'public' | 'private')}
          options={[
            ['public', t('Öffentlich – alle im Team können beitreten und mitlesen')],
            ['private', t('Privat – nur eingeladene Personen (auch die Agentur sieht ihn nicht)')],
          ]}
        />
      </Field>
      {me.admin && (
        <Field label={t('Gilt für')} hint={t('Ein Agentur-Kanal erscheint in allen Sub-Accounts – für das Agentur-Team und eingeladene Personen, die über Projekte hinweg arbeiten.')}>
          <Select
            value={scope}
            onChange={(v) => setScope(v as 'location' | 'agency')}
            options={[
              ['location', t('Diesen Sub-Account')],
              ['agency', t('Die ganze Agentur')],
            ]}
          />
        </Field>
      )}
      {kind === 'private' && (
        <Field label={t('Mitglieder einladen')}>
          <PeoplePick people={people.filter((p) => !p.me)} value={members} onChange={setMembers} />
        </Field>
      )}
    </Dialog>
  );
}

export function NewDmDialog({ people, onOpened, onClose }: { people: PersonRow[]; onOpened: (c: Chan) => void; onClose: () => void }) {
  const t = useT('collab');
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/team-chat/dms', { user_ids: sel }));
    setBusy(false);
    if (r) onOpened(r);
  };
  return (
    <Dialog
      title={t('Neue Direktnachricht')}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button className="btn" disabled={busy || !sel.length} onClick={open}>
            {sel.length > 1 ? t('Gruppe öffnen') : t('Unterhaltung öffnen')}
          </button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('Wähle eine Person – oder mehrere (bis 8) für eine Gruppe. Direktnachrichten lesen nur die Beteiligten, auch Agentur-Admins nicht.')}
      </p>
      <PeoplePick people={people.filter((p) => !p.me)} value={sel} onChange={setSel} max={7} />
    </Dialog>
  );
}

// --- channel settings -----------------------------------------------------------------------------------------------------------------

export function ChannelSettingsDialog({ ch, me, people, slack, onChanged, onLeft, onClose }: { ch: Chan; me: Me; people: PersonRow[]; slack: boolean; onChanged: () => void; onLeft: () => void; onClose: () => void }) {
  const t = useT('collab');
  const info = useLoad<{ members: { id: string; name: string; role: string }[] }>(() => api.get(`/api/team-chat/channels/${ch.id}`), [ch.id]);
  const direct = ch.kind === 'dm' || ch.kind === 'group';
  const [name, setName] = useState(ch.name);
  const [topic, setTopic] = useState(ch.topic);
  const [archived, setArchived] = useState(ch.archived);
  const [mirror, setMirror] = useState(ch.slack_mirror);
  const [notify, setNotify] = useState<string>(ch.notify || (direct ? 'all' : 'mentions'));
  const [add, setAdd] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const members = info.data?.members ?? [];
  const candidates = people.filter((p) => !members.some((m) => m.id === p.id));
  const manage = ch.can.manage && !direct;
  const save = async () => {
    setBusy(true);
    const body: Record<string, unknown> = { name, topic, archived };
    if (slack && ch.scope === 'location') body.slack_mirror = mirror;
    const r = await act(() => api.patch(`/api/team-chat/channels/${ch.id}`, body), t('Gespeichert'));
    setBusy(false);
    if (r) {
      onChanged();
      onClose();
    }
  };
  return (
    <Dialog
      title={direct ? t('Unterhaltung') : t('Kanal {name}', { name: ch.label })}
      onClose={onClose}
      wide
      footer={
        <>
          {ch.joined && (
            <button
              className="btn secondary small"
              style={{ marginRight: 'auto' }}
              onClick={async () => {
                if (!confirmAsk(direct ? t('Diese Unterhaltung verlassen? Sie verschwindet aus deiner Liste.') : t('„{name}“ verlassen?', { name: ch.label }))) return;
                if (await act(() => api.post(`/api/team-chat/channels/${ch.id}/leave`, {}), t('Verlassen'))) onLeft();
              }}
            >
              {t('Verlassen')}
            </button>
          )}
          <button className="btn secondary" onClick={onClose}>
            {t('Schließen')}
          </button>
          {manage && (
            <button className="btn" disabled={busy} onClick={save}>
              {t('Speichern')}
            </button>
          )}
        </>
      }
    >
      {ch.joined && (
        <Field label={t('Benachrichtigungen für dich')} hint={t('Direktnachrichten und Erwähnungen melden sich immer, wenn nicht „Stumm“ gewählt ist.')}>
          <Select
            value={notify}
            onChange={async (v) => {
              setNotify(v);
              if (await act(() => api.patch(`/api/team-chat/channels/${ch.id}`, { notify: v }), t('Gespeichert'))) onChanged();
            }}
            options={[
              ['all', t('Alle Nachrichten')],
              ['mentions', t('Nur Erwähnungen')],
              ['none', t('Stumm')],
            ]}
          />
        </Field>
      )}
      {manage && (
        <>
          <Field label="Name">
            <Input value={name} onChange={setName} maxLength={40} />
          </Field>
          <Field label={t('Thema')}>
            <Input value={topic} onChange={setTopic} maxLength={250} />
          </Field>
          {slack && ch.scope === 'location' && (
            <CheckBox checked={mirror} onChange={setMirror} label={t('Neue Nachrichten zusätzlich in Slack spiegeln (nur eine Richtung: Chat → Slack)')} />
          )}
          <CheckBox checked={archived} onChange={setArchived} label={t('Kanal archivieren (bleibt lesbar, niemand kann mehr schreiben)')} />
        </>
      )}
      {!manage && !direct && ch.topic && <p className="muted">{ch.topic}</p>}
      <h3 style={{ margin: '14px 0 6px' }}>{t('Mitglieder (')}{members.length || ch.member_count})</h3>
      {info.loading ? (
        <Spinner />
      ) : (
        <div className="ck-list tc-members">
          {members.map((m) => (
            <div key={m.id}>
              <Avatar name={m.name} size={26} online={people.find((p) => p.id === m.id)?.online} />
              <span className="ck-grow">
                {m.name} {m.id === me.id && <span className="muted">{t('(du)')}</span>} {m.role === 'owner' && !direct && <span className="badge blue">{t('Besitzer:in')}</span>}
              </span>
              {ch.kind !== 'dm' && (ch.kind !== 'public' || ch.scope === 'agency') && (ch.can.manage || m.id === me.id) && m.id !== me.id && (
                <button
                  className="icon-btn"
                  aria-label={t('{name} entfernen', { name: m.name })}
                  onClick={async () => {
                    if (!confirmAsk(t('{name} aus dem Kanal entfernen?', { name: m.name }))) return;
                    if (await act(() => api.del(`/api/team-chat/channels/${ch.id}/members/${m.id}`), t('Entfernt'))) {
                      void info.reload();
                      onChanged();
                    }
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {ch.kind !== 'dm' && (ch.kind !== 'public' || ch.scope === 'agency') && (ch.joined || ch.can.manage) && candidates.length > 0 && (
        <>
          <h3 style={{ margin: '14px 0 6px' }}>{t('Personen hinzufügen')}</h3>
          <PeoplePick people={candidates} value={add} onChange={setAdd} />
          <button
            className="btn small"
            style={{ marginTop: 8 }}
            disabled={!add.length}
            onClick={async () => {
              if (await act(() => api.post(`/api/team-chat/channels/${ch.id}/members`, { user_ids: add }), t('Hinzugefügt'))) {
                setAdd([]);
                void info.reload();
                onChanged();
              }
            }}
          >
            {t('Hinzufügen')}
          </button>
        </>
      )}
      {ch.kind === 'public' && ch.scope !== 'agency' && <p className="muted small">{t('Öffentliche Kanäle kann jede Person des Teams betreten – dafür braucht es keine Einladung.')}</p>}
      {ch.kind === 'public' && ch.scope === 'agency' && <p className="muted small">{t('Dieser Agentur-Kanal steht der Agentur offen; andere Personen sehen ihn erst, wenn sie hinzugefügt wurden.')}</p>}
      {manage && ch.role === 'owner' && (
        <div style={{ marginTop: 16 }}>
          <button
            className="btn danger small"
            onClick={async () => {
              if (!confirmAsk(t('Kanal „{name}“ mit allen Nachrichten und Dateien endgültig löschen?', { name: ch.label }))) return;
              if (await act(() => api.del(`/api/team-chat/channels/${ch.id}`), t('Kanal gelöscht'))) onLeft();
            }}
          >
            {t('Kanal löschen')}
          </button>
        </div>
      )}
    </Dialog>
  );
}

// --- chat settings (retention) -----------------------------------------------------------------------------------------------------------

export function ChatSettingsDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const t = useT('collab');
  const [scope, setScope] = useState<'location' | 'agency'>('location');
  const s = useLoad<{ retention_days: number; choices: number[]; can_edit: boolean }>(() => api.get(`/api/team-chat/settings${scope === 'agency' ? '?scope=agency' : ''}`), [scope]);
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => setDays(null), [scope]);
  const value = days ?? s.data?.retention_days ?? 0;
  const label = (n: number) => (n === 0 ? t('Unbegrenzt aufbewahren') : n === 365 ? t('1 Jahr') : t.plural(n, { other: '{n} Tage' }));
  return (
    <Dialog
      title={t('Chat-Einstellungen')}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            {t('Schließen')}
          </button>
          {s.data?.can_edit && (
            <button
              className="btn"
              disabled={days === null}
              onClick={async () => {
                if (value > 0 && !confirmAsk(t('Nachrichten, die älter als {age} sind, werden regelmäßig endgültig gelöscht (angepinnte bleiben). Fortfahren?', { age: label(value) }))) return;
                if (await act(() => api.put(`/api/team-chat/settings${scope === 'agency' ? '?scope=agency' : ''}`, { retention_days: value }), t('Gespeichert'))) onClose();
              }}
            >
              {t('Speichern')}
            </button>
          )}
        </>
      }
    >
      {me.admin && (
        <div className="tabs">
          <button className={scope === 'location' ? 'on' : ''} onClick={() => setScope('location')}>
            {t('Dieser Sub-Account')}
          </button>
          <button className={scope === 'agency' ? 'on' : ''} onClick={() => setScope('agency')}>
            {t('Agentur-Kanäle')}
          </button>
        </div>
      )}
      {s.loading ? (
        <Spinner />
      ) : (
        <Field label={t('Aufbewahrung von Nachrichten')} hint={t('Ältere Nachrichten und ihre Dateien werden automatisch gelöscht. Angepinnte Nachrichten bleiben. Das gilt für alle Kanäle und Direktnachrichten dieses Bereichs.')}>
          <Select value={String(value)} onChange={(v) => setDays(Number(v))} options={(s.data?.choices ?? [0, 30, 90, 180, 365]).map((n) => [String(n), label(n)] as [string, string])} />
        </Field>
      )}
      {s.data && !s.data.can_edit && <p className="muted small">{t('Das ändert, wer die Einstellungen des Sub-Accounts verwalten darf.')}</p>}
    </Dialog>
  );
}

// --- keep a message as a note on a contact --------------------------------------------------------------------------------------------------

export function NoteDialog({ msg, onClose }: { msg: Msg; onClose: () => void }) {
  const t = useT('collab');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 200);
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    if (dq.length < 2) return setRows(null);
    let live = true;
    api
      .get(`/api/contacts?q=${encodeURIComponent(dq)}&limit=8`)
      .then((r) => live && setRows(r.contacts ?? []))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [dq]);
  const nm = (c: any) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.phone || 'Kontakt';
  return (
    <Dialog title={t('Als Notiz an einem Kontakt speichern')} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('Die Nachricht wird als interne Notiz am Kontakt abgelegt – für alle sichtbar, die den Kontakt sehen.')}
      </p>
      <blockquote className="muted" style={{ margin: '0 0 12px', borderLeft: '3px solid var(--line)', paddingLeft: 10 }}>
        {msg.text.slice(0, 240)}
      </blockquote>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Kontakt suchen (Name, E-Mail, Telefon)')} aria-label={t('Kontakt suchen')} />
      <div className="ck-pick-list">
        {rows === null && dq.length >= 2 && <Spinner />}
        {rows?.length === 0 && <p className="muted">{t('Kein Kontakt gefunden.')}</p>}
        {rows?.map((c) => (
          <button
            key={c.id}
            onClick={async () => {
              if (await act(() => api.post(`/api/team-chat/messages/${msg.id}/note`, { contact_id: c.id }), t('Notiz an {name} gespeichert', { name: nm(c) }))) onClose();
            }}
          >
            <b>{nm(c)}</b>
            <span className="muted small">{[c.company, c.email].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

// --- panels -------------------------------------------------------------------------------------------------------------------------------------------

function PanelHead({ title, onClose }: { title: string; onClose: () => void }) {
  const t = useT('collab');
  return (
    <div className="tc-panel-head">
      <h3>{title}</h3>
      <button className="icon-btn" onClick={onClose} aria-label={t('Schließen')}>
        ✕
      </button>
    </div>
  );
}

export function ThreadPanel({ ch, me, parentId, people, store, bus, onClose, onNote, onParentChange }: { ch: Chan; me: Me; parentId: string; people: Person[]; store: CardStore; bus: Bus; onClose: () => void; onNote: (m: Msg) => void; onParentChange: (m: Msg) => void }) {
  const t = useT('collab');
  useFocusReturn();
  useEscape(onClose);
  const [parent, setParent] = useState<Msg | null>(null);
  const [replies, setReplies] = useState<Msg[]>([]);
  const [err, setErr] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const load = async () => {
    try {
      const r = await api.get(`/api/team-chat/messages/${parentId}/thread`);
      setParent(r.parent);
      setReplies(r.replies);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    setParent(null);
    setReplies([]);
    void load();
  }, [parentId]);
  useEffect(
    () =>
      bus.on((ev, d) => {
        if (ev === 'hello') return void load();
        if (ev === 'message' && d.thread_id === parentId) setReplies((l) => upsertMsg(l, d));
        else if (ev === 'message-edit') {
          if (d.id === parentId) setParent(d);
          else setReplies((l) => (l.some((x) => x.id === d.id) ? upsertMsg(l, d) : l));
        } else if (ev === 'message-delete' && d.message) {
          if (d.id === parentId) setParent(d.message);
          else setReplies((l) => (l.some((x) => x.id === d.id) ? upsertMsg(l, d.message) : l));
        } else if (ev === 'reaction') {
          setParent((p) => (p && p.id === d.message_id ? { ...p, reactions: d.reactions } : p));
          setReplies((l) => l.map((x) => (x.id === d.message_id ? { ...x, reactions: d.reactions } : x)));
        }
      }),
    [bus, parentId],
  );
  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies.length]);
  return (
    <aside className="tc-panel" aria-label={t('Thread')} data-tour="chat-thread">
      <PanelHead title={t('Thread')} onClose={onClose} />
      <div className="tc-panel-body" ref={body}>
        {err && <p className="muted">{err}</p>}
        {!parent && !err && <Spinner />}
        {parent && (
          <>
            <MessageView m={parent} cont={false} ch={ch} me={me} store={store} mode="thread" onChange={(m) => (setParent(m), onParentChange(m))} onNote={onNote} />
            <div className="tc-day">
              {t.plural(replies.length, { one: '{n} Antwort', other: '{n} Antworten' })}
            </div>
            {replies.map((m, i) => (
              <MessageView key={m.id} m={m} cont={i > 0 && replies[i - 1].author.id === m.author.id && !replies[i - 1].deleted && Date.parse(m.created_at) - Date.parse(replies[i - 1].created_at) < 300_000} ch={ch} me={me} store={store} mode="thread" onChange={(x) => setReplies((l) => upsertMsg(l, x))} onNote={onNote} />
            ))}
          </>
        )}
      </div>
      {parent && !parent.deleted && <Composer ch={ch} threadId={parentId} people={people} onPosted={(ms) => setReplies((l) => ms.reduce((acc, m) => upsertMsg(acc, m), l))} placeholder={t('Im Thread antworten …')} autoFocus />}
    </aside>
  );
}
export function PinsPanel({ ch, me, store, onClose, onJump }: { ch: Chan; me: Me; store: CardStore; onClose: () => void; onJump: (m: Msg) => void }) {
  const t = useT('collab');
  useFocusReturn();
  useEscape(onClose);
  const list = useLoad<Msg[]>(() => api.get(`/api/team-chat/channels/${ch.id}/pins`), [ch.id]);
  return (
    <aside className="tc-panel" aria-label={t('Angepinnte Nachrichten')}>
      <PanelHead title={t('Angepinnt')} onClose={onClose} />
      <div className="tc-panel-body">
        {list.loading && <Spinner />}
        {!list.loading && !list.data?.length && <Empty>{t('Noch nichts angepinnt. Über „…“ an einer Nachricht lässt sie sich oben festhalten.')}</Empty>}
        {list.data?.map((m) => (
          <div key={m.id} style={{ marginBottom: 8 }}>
            <MessageView m={m} cont={false} ch={ch} me={me} store={store} mode="pins" onChange={(x) => list.setData((l) => (x.pinned ? l?.map((y) => (y.id === x.id ? x : y)) : l?.filter((y) => y.id !== x.id)))} />
            <button className="btn small ghost" onClick={() => onJump(m)}>
              {t('Zur Nachricht springen')}
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function SearchPanel({ q, onClose, onOpen }: { q: string; onClose: () => void; onOpen: (hit: any) => void }) {
  const t = useT('collab');
  useFocusReturn();
  useEscape(onClose);
  const res = useLoad<any[]>(() => api.get(`/api/team-chat/search?q=${encodeURIComponent(q)}`), [q]);
  return (
    <aside className="tc-panel" aria-label={t('Suchergebnisse')} data-tour="chat-search-results">
      <PanelHead title={t('Suche: {q}', { q })} onClose={onClose} />
      <div className="tc-panel-body">
        {res.loading && <Spinner />}
        {res.error && <p className="muted">{res.error}</p>}
        {!res.loading && !res.error && !res.data?.length && <Empty>{t('Keine Nachricht gefunden.')}</Empty>}
        {res.data?.map((h) => (
          <button key={h.id} className="tc-hitrow" onClick={() => onOpen(h)}>
            <b>{h.channel}</b>
            <span className="tc-time">
              {h.author} · {ago(h.created_at)}
            </span>
            <div className="ck-snip">
              <Snippet text={h.snippet} />
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

