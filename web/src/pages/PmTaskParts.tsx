import { useEffect, useRef, useState } from 'react';
import { api, ago, currentLocation, dt } from '../api';
import type { Recurrence } from '../../../server/services/pm-recur';
import { Icon } from '../icons';
import { Avatar, DueChip, Pop, dayOf, fmtFull, fmtHM, fmtShort, parseDuration, todayIn, useDebounced, type Checklist, type Meta, type Person, type Task } from './PmKit';
import { act, confirmAsk, toast, useLoad } from '../ui';
import { getLocale, tr, useT } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';

/** The sections of the task window: checklists, dependencies, attachments, comments, activity, time. */

const uid = () => Math.random().toString(36).slice(2, 10);

// --- checklists -----------------------------------------------------------------------------------------------

export function ChecklistsPanel({ value, onSave }: { value: Checklist[]; onSave: (next: Checklist[]) => Promise<unknown> }) {
  const t = useT('pm');
  const [lists, setLists] = useState(value);
  const sig = JSON.stringify(value);
  useEffect(() => setLists(value), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (next: Checklist[]) => {
    setLists(next);
    void onSave(next);
  };
  const edit = (i: number, patch: Partial<Checklist>) => lists.map((l, k) => (k === i ? { ...l, ...patch } : l));
  if (!lists.length) return null;
  return (
    <section className="pm-sec" data-tour="pm-checklists">
      <h4>{t('Checklisten')}</h4>
      {lists.map((l, i) => {
        const done = l.items.filter((x) => x.done).length;
        return (
          <div key={l.id} className="pm-check-list">
            <div className="pm-check-head">
              <input
                className="pm-plain"
                value={l.title}
                aria-label={t('Titel der Checkliste')}
                onChange={(e) => setLists(edit(i, { title: e.target.value }))}
                onBlur={() => commit(lists)}
              />
              <span className="muted small">
                {done}/{l.items.length}
              </span>
              <button type="button" className="icon-btn" aria-label={t('Checkliste löschen')} onClick={() => confirmAsk(t('Checkliste löschen?')) && commit(lists.filter((_, k) => k !== i))}>
                ✕
              </button>
            </div>
            {l.items.length > 0 && (
              <div className="pm-bar-track" aria-hidden="true">
                <i style={{ width: `${(done / l.items.length) * 100}%` }} />
              </div>
            )}
            {l.items.map((it, j) => (
              <div key={it.id} className="pm-check-item">
                <input type="checkbox" checked={it.done} aria-label={it.text} onChange={(e) => commit(edit(i, { items: l.items.map((x, k) => (k === j ? { ...x, done: e.target.checked } : x)) }))} />
                <input
                  className={`pm-plain${it.done ? ' done' : ''}`}
                  value={it.text}
                  aria-label={t('Punkt')}
                  onChange={(e) => setLists(edit(i, { items: l.items.map((x, k) => (k === j ? { ...x, text: e.target.value } : x)) }))}
                  onBlur={() => commit(lists)}
                />
                <button type="button" className="icon-btn" aria-label={t('Punkt entfernen')} onClick={() => commit(edit(i, { items: l.items.filter((_, k) => k !== j) }))}>
                  ✕
                </button>
              </div>
            ))}
            <AddLine placeholder={t('Punkt hinzufügen…')} onAdd={(text) => commit(edit(i, { items: [...l.items, { id: uid(), text, done: false }] }))} />
          </div>
        );
      })}
    </section>
  );
}

function AddLine({ placeholder, onAdd }: { placeholder: string; onAdd: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <input
      className="pm-addline"
      value={text}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && text.trim()) (onAdd(text.trim()), setText(''));
      }}
    />
  );
}

export const newChecklist = (): Checklist => {
  const t = tr('pm');
  return { id: uid(), title: t('Checkliste'), items: [] };
};

// --- dependencies -----------------------------------------------------------------------------------------------

interface DepRow {
  id: string;
  task_id: string;
  title: string;
  done: boolean;
  type: string;
  lag: number;
  start_at: string | null;
  due_at: string | null;
}
export interface Deps {
  blocked_by: DepRow[];
  blocking: DepRow[];
}

export function DependenciesPanel({ task, deps, meta, tz, onChange, openTask }: { task: Task; deps: Deps; meta: Meta; tz: string; onChange: () => void; openTask: (id: string) => void }) {
  const t = useT('pm');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const [type, setType] = useState('FS');
  const [lag, setLag] = useState('0');
  const hits = useLoad(
    () => (dq.trim().length >= 1 ? api.get<{ tasks: Task[] }>(`/api/pm/tasks?project_id=${task.project_id}&q=${encodeURIComponent(dq.trim())}&limit=8`) : Promise.resolve({ tasks: [] as Task[] })),
    [dq, task.project_id],
  );
  const taken = new Set([task.id, ...deps.blocked_by.map((d) => d.task_id)]);
  const today = todayIn(tz);
  const label = (tk: string) => meta.dependency_types.find((x) => x.type === tk)?.label ?? tk;
  const row = (d: DepRow, mine: boolean) => (
    <div key={d.id} className="pm-dep-row">
      <button type="button" className="pm-link" onClick={() => openTask(d.task_id)}>
        <span className={d.done ? 'done' : ''}>{d.title}</span>
      </button>
      <DueChip task={{ due_at: d.due_at, start_at: d.start_at, done: d.done, milestone: false }} tz={tz} today={today} />
      <select
        aria-label={t('Art der Abhängigkeit')}
        value={d.type}
        onChange={async (e) => {
          await act(() => api.patch(`/api/pm/dependencies/${d.id}`, { type: e.target.value }));
          onChange();
        }}
      >
        {meta.dependency_types.map((tk) => (
          <option key={tk.type} value={tk.type}>
            {tk.label}
          </option>
        ))}
      </select>
      <input
        type="number"
        className="pm-lag"
        value={d.lag}
        aria-label={t('Versatz in Tagen')}
        title={t('Versatz in Tagen (negativ = Überlappung)')}
        onChange={async (e) => {
          await act(() => api.patch(`/api/pm/dependencies/${d.id}`, { lag: Number(e.target.value) || 0 }));
          onChange();
        }}
      />
      <span className="muted small">{t('Tage')}</span>
      <button
        type="button"
        className="icon-btn"
        aria-label={mine ? t('Abhängigkeit lösen') : t('Abhängigkeit lösen')}
        onClick={async () => {
          await act(() => api.del(`/api/pm/dependencies/${d.id}`));
          onChange();
        }}
      >
        ✕
      </button>
    </div>
  );
  return (
    <section className="pm-sec" data-tour="pm-deps">
      <h4>{t('Abhängigkeiten')}</h4>
      {deps.blocked_by.length > 0 && <div className="pm-sub">{t('Wartet auf')}</div>}
      {deps.blocked_by.map((d) => row(d, true))}
      {deps.blocking.length > 0 && <div className="pm-sub">{t('Blockiert')}</div>}
      {deps.blocking.map((d) => row(d, false))}
      <div className="pm-dep-add">
        <input type="search" value={q} placeholder={t('Aufgabe suchen, auf die diese wartet…')} aria-label={t('Vorgänger suchen')} onChange={(e) => setQ(e.target.value)} />
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label={t('Art')}>
          {meta.dependency_types.map((tk) => (
            <option key={tk.type} value={tk.type}>
              {tk.label}
            </option>
          ))}
        </select>
        <input type="number" className="pm-lag" value={lag} onChange={(e) => setLag(e.target.value)} aria-label={t('Versatz in Tagen')} title={t('Versatz in Tagen')} />
      </div>
      {q.trim() && (hits.data?.tasks ?? []).filter((tk) => !taken.has(tk.id)).length > 0 && (
        <div className="pm-hits">
          {(hits.data?.tasks ?? [])
            .filter((tk) => !taken.has(tk.id))
            .map((tk) => (
              <button
                type="button"
                key={tk.id}
                onClick={async () => {
                  const r = await act(() => api.post(`/api/pm/tasks/${task.id}/dependencies`, { depends_on: tk.id, type, lag: Number(lag) || 0 }), t('Abhängigkeit angelegt'));
                  if (r) (setQ(''), onChange());
                }}
              >
                {tk.title} <span className="muted small">{label(type)}</span>
              </button>
            ))}
        </div>
      )}
      {!deps.blocked_by.length && !deps.blocking.length && !q && <p className="muted small">{t('Keine Abhängigkeiten. „')}{label('FS')}{t('“ heißt: diese Aufgabe beginnt erst, wenn die andere fertig ist.')}</p>}
    </section>
  );
}

// --- attachments ------------------------------------------------------------------------------------------------------

export interface Attachment {
  id: string;
  kind: 'file' | 'link';
  name: string;
  url: string | null;
  mime: string | null;
  size: number;
  created_at: string;
}

const size = (n: number) => (n > 1048576 ? `${getLocale() === SOURCE_LOCALE ? (n / 1048576).toFixed(1).replace('.', ',') : (n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function AttachmentsPanel({ task, items, maxBytes, onChange }: { task: Task; items: Attachment[]; maxBytes: number; onChange: () => void }) {
  const t = useT('pm');
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const loc = currentLocation();
  const upload = async (f: File) => {
    if (f.size > maxBytes) return toast(t('Datei ist zu groß (höchstens {size})', { size: size(maxBytes) })), undefined;
    const data = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(new Error(t('Datei konnte nicht gelesen werden')));
      r.readAsDataURL(f);
    }).catch((e) => (toast(String(e.message)), ''));
    if (!data) return;
    const r = await act(() => api.post(`/api/pm/tasks/${task.id}/attachments/file`, { name: f.name, mime: f.type, data }), t('Datei angehängt'));
    if (r) onChange();
  };
  return (
    <section className="pm-sec" data-tour="pm-attachments">
      <h4>{t('Anhänge')}</h4>
      {items.map((a) => (
        <div key={a.id} className="pm-attach">
          <Icon name={a.kind === 'link' ? 'link' : 'file'} size={14} />
          <a href={a.kind === 'link' ? a.url! : `${a.url}?locationId=${encodeURIComponent(loc)}`} target="_blank" rel="noopener noreferrer">
            {a.name}
          </a>
          {a.kind === 'file' && <span className="muted small">{size(a.size)}</span>}
          <span className="grow" />
          <button
            type="button"
            className="icon-btn"
            aria-label={t('{name} entfernen', { name: a.name })}
            onClick={async () => {
              await act(() => api.del(`/api/pm/attachments/${a.id}`));
              onChange();
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="pm-attach-add">
        <button type="button" className="btn small secondary" onClick={() => file.current?.click()}>
          <Icon name="upload" size={13} /> {t('Datei hochladen')}
        </button>
        <input
          ref={file}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
        <button type="button" className="btn small secondary" onClick={() => setAdding(!adding)} aria-expanded={adding}>
          <Icon name="link" size={13} /> {t('Link')}
        </button>
      </div>
      {adding && (
        <div className="pm-link-form">
          <input type="url" value={url} placeholder="https://…" aria-label={t('Link')} onChange={(e) => setUrl(e.target.value)} />
          <input value={name} placeholder={t('Name (optional)')} aria-label={t('Name des Links')} onChange={(e) => setName(e.target.value)} />
          <button
            type="button"
            className="btn small"
            disabled={!url.trim()}
            onClick={async () => {
              const r = await act(() => api.post(`/api/pm/tasks/${task.id}/attachments`, { url: url.trim(), name: name.trim() }), t('Link angehängt'));
              if (r) (setUrl(''), setName(''), setAdding(false), onChange());
            }}
          >
            {t('Anhängen')}
          </button>
        </div>
      )}
    </section>
  );
}

// --- comments with @mentions ---------------------------------------------------------------------------------------------

export interface Comment {
  id: string;
  user_id: string | null;
  author_name: string;
  body: string;
  mentions: { id: string; name: string }[];
  created_at: string;
  edited_at: string | null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function Body({ text, mentions }: { text: string; mentions: { id: string; name: string }[] }) {
  if (!mentions.length) return <>{text}</>;
  const re = new RegExp(`(@(?:${mentions.map((m) => esc(m.name)).join('|')}))`, 'gi');
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="pm-mention">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** A text box that offers the team when you type "@". */
function MentionBox({ team, value, onChange, onSubmit, placeholder, onPick }: { team: Person[]; value: string; onChange: (v: string) => void; onSubmit: () => void; placeholder: string; onPick: (p: Person) => void }) {
  const t = useT('pm');
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [closed, setClosed] = useState(false);
  const m = /(^|\s)@([^\s@]*(?: [^\s@]*)?)$/.exec(value.slice(0, caret));
  const query = m?.[2] ?? '';
  const hits = m && !closed ? team.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6) : [];
  const pick = (p: Person) => {
    const start = caret - query.length - 1;
    const next = `${value.slice(0, start)}@${p.name} ${value.slice(caret)}`;
    onChange(next);
    onPick(p);
    setClosed(false);
    requestAnimationFrame(() => {
      const pos = start + p.name.length + 2;
      ref.current?.setSelectionRange(pos, pos);
      ref.current?.focus();
    });
  };
  return (
    <div className="pm-mention-box">
      <textarea
        ref={ref}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={3}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setClosed(false);
          setSel(0);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        onKeyDown={(e) => {
          if (hits.length) {
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel((sel + 1) % hits.length));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((sel - 1 + hits.length) % hits.length));
            else if (e.key === 'Enter' || e.key === 'Tab') (e.preventDefault(), pick(hits[sel] ?? hits[0]));
            else if (e.key === 'Escape') (e.stopPropagation(), setClosed(true));
            return;
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), onSubmit());
        }}
      />
      {hits.length > 0 && (
        <div className="pm-mention-list" role="listbox" aria-label={t('Personen erwähnen')}>
          {hits.map((p, i) => (
            <button type="button" role="option" aria-selected={i === sel} key={p.id} className={i === sel ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), pick(p))}>
              <Avatar person={p} size={20} /> {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CommentsPanel({ task, comments, team, me, manager, onChange }: { task: Task; comments: Comment[]; team: Person[]; me: string | null; manager: boolean; onChange: () => void }) {
  const t = useT('pm');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const r = await act(() => api.post(`/api/pm/tasks/${task.id}/comments`, { body: text.trim(), mentions: picked }));
    setBusy(false);
    if (r) (setText(''), setPicked([]), onChange());
  };
  return (
    <div className="pm-comments" data-tour="pm-comments">
      {comments.map((c) => (
        <div key={c.id} className="pm-comment">
          <Avatar person={{ id: c.user_id ?? c.author_name, name: c.author_name }} size={28} />
          <div className="grow">
            <div className="pm-comment-head">
              <strong>{c.author_name}</strong> <span className="muted small" title={dt(c.created_at)}>{ago(c.created_at)}</span>
              {c.edited_at && <span className="muted small">{t('(bearbeitet)')}</span>}
              {(c.user_id === me || manager) && !editing && (
                <span className="pm-comment-actions">
                  <button type="button" className="btn small ghost" onClick={() => setEditing({ id: c.id, body: c.body })}>
                    {t('Bearbeiten')}
                  </button>
                  <button
                    type="button"
                    className="btn small ghost"
                    onClick={async () => {
                      if (!confirmAsk(t('Kommentar löschen?'))) return;
                      await act(() => api.del(`/api/pm/comments/${c.id}`));
                      onChange();
                    }}
                  >
                    {t('Löschen')}
                  </button>
                </span>
              )}
            </div>
            {editing?.id === c.id ? (
              <div>
                <MentionBox team={team} value={editing.body} onChange={(v) => setEditing({ id: c.id, body: v })} onSubmit={() => undefined} placeholder={t('Kommentar bearbeiten')} onPick={() => undefined} />
                <div className="actions">
                  <button
                    type="button"
                    className="btn small"
                    onClick={async () => {
                      const r = await act(() => api.patch(`/api/pm/comments/${c.id}`, { body: editing.body }));
                      if (r) (setEditing(null), onChange());
                    }}
                  >
                    {t('Speichern')}
                  </button>
                  <button type="button" className="btn small secondary" onClick={() => setEditing(null)}>
                    {t('Abbrechen')}
                  </button>
                </div>
              </div>
            ) : (
              <p className="pm-comment-body">
                <Body text={c.body} mentions={c.mentions} />
              </p>
            )}
          </div>
        </div>
      ))}
      {!comments.length && <p className="muted small">{t('Noch keine Kommentare. Mit @ erwähnst du Kolleginnen und Kollegen – sie bekommen eine Benachrichtigung.')}</p>}
      <div className="pm-comment-new">
        <MentionBox team={team} value={text} onChange={setText} onSubmit={send} placeholder={t('Kommentar schreiben… @ erwähnt jemanden')} onPick={(p) => setPicked((x) => [...new Set([...x, p.id])])} />
        <div className="actions">
          <button type="button" className="btn small" disabled={!text.trim() || busy} onClick={send}>
            {t('Kommentieren')}
          </button>
          <span className="muted small">{t('Strg + Enter sendet')}</span>
        </div>
      </div>
    </div>
  );
}

// --- activity -------------------------------------------------------------------------------------------------------------

export interface Activity {
  id: number;
  user_name: string;
  kind: string;
  data: any;
  created_at: string;
}

const dayText = (iso: string | null | undefined, tz: string) => {
  const d = dayOf(iso ?? null, tz);
  const t = tr('pm');
  return d ? fmtShort(d) : t('leer');
};

export function describeActivity(a: Activity, tz: string): string {
  const t = tr('pm');
  const d = a.data ?? {};
  const val = (v: unknown) => (Array.isArray(v) ? v.join(', ') || t('niemand') : v === null || v === undefined || v === '' ? t('leer') : String(v));
  switch (a.kind) {
    case 'created':
      return t('hat die Aufgabe angelegt');
    case 'title':
      return t('hat den Titel geändert: „{from}“ → „{to}“', { from: val(d.from), to: val(d.to) });
    case 'status':
      return t('hat den Status geändert: {from} → {to}', { from: val(d.from), to: val(d.to) });
    case 'completed':
      return t('hat die Aufgabe erledigt ({status})', { status: val(d.to) });
    case 'priority':
      return t('hat die Priorität geändert: {from} → {to}', { from: val(d.from), to: val(d.to) });
    case 'start_at':
      return t('hat den Start geändert: {from} → {to}', { from: dayText(d.from, tz), to: dayText(d.to, tz) });
    case 'due_at':
      return t('hat die Fälligkeit geändert: {from} → {to}', { from: dayText(d.from, tz), to: dayText(d.to, tz) });
    case 'dates': {
      const f = d.from ?? [];
      const to = d.to ?? [];
      return t('hat den Zeitraum geändert: {from} → {to}', { from: `${dayText(f[0], tz)} – ${dayText(f[1], tz)}`, to: `${dayText(to[0], tz)} – ${dayText(to[1], tz)}` }) + (d.cause ? t(' (wegen „{cause}“)', { cause: d.cause }) : '');
    }
    case 'assignees':
      return t('hat die Zuständigen geändert: {from} → {to}', { from: val(d.from), to: val(d.to) });
    case 'project':
      return t('hat die Aufgabe verschoben: {from} → {to}', { from: val(d.from), to: val(d.to) });
    case 'recurrence':
      return t('hat die Wiederholung geändert: {from} → {to}', { from: val(d.from), to: val(d.to) });
    case 'recurred':
      return t('hat die nächste Wiederholung angelegt');
    case 'comment':
      return t('hat kommentiert');
    case 'attachment':
      return t('hat „{name}“ angehängt', { name: val(d.name) });
    case 'dependency':
      return t('hat eine Abhängigkeit zu „{name}“ angelegt', { name: val(d.on) });
    case 'billed':
      return t('Zeit wurde abgerechnet (Rechnung {number})', { number: val(d.invoice) });
    default:
      return t('hat „{kind}“ geändert', { kind: a.kind });
  }
}

export function ActivityList({ items, tz }: { items: Activity[]; tz: string }) {
  const t = useT('pm');
  if (!items.length) return <p className="muted small">{t('Noch keine Aktivität.')}</p>;
  return (
    <ul className="pm-activity">
      {items.map((a) => (
        <li key={a.id}>
          <strong>{a.user_name || t('System')}</strong> {describeActivity(a, tz)} <span className="muted small" title={dt(a.created_at)}>{ago(a.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}

// --- time on a task ------------------------------------------------------------------------------------------------------

interface TimeEntry {
  id: string;
  user_name: string;
  day: string;
  seconds: number;
  note: string;
  billable: boolean;
  running: boolean;
  approval: string;
  invoice_number: string | null;
  has_clock: boolean;
}

export function TimePanel({ task, billable, tz, onChange }: { task: Task; billable: boolean; tz: string; onChange: () => void }) {
  const t = useT('pm');
  const list = useLoad(() => api.get<{ entries: TimeEntry[] }>(`/api/pm/time?task_id=${task.id}&limit=200`), [task.id]);
  const timer = useLoad(() => api.get<{ running: { task_id: string | null } | null }>('/api/pm/timer'), [task.id]);
  const [day, setDay] = useState(todayIn(tz));
  const [dur, setDur] = useState('');
  const [note, setNote] = useState('');
  const [bill, setBill] = useState(billable);
  const entries = list.data?.entries ?? [];
  const mine = timer.data?.running?.task_id === task.id;
  const refresh = () => (list.reload(), timer.reload(), onChange(), window.dispatchEvent(new Event('pm:timer')));
  const minutes = parseDuration(dur);
  return (
    <div className="pm-time-panel" data-tour="pm-task-time">
      <div className="pm-time-actions">
        {mine ? (
          <button
            type="button"
            className="btn small danger"
            onClick={async () => {
              const r = await act(() => api.post('/api/pm/timer/stop', {}));
              if (r) refresh();
            }}
          >
            <Icon name="end" size={13} /> {t('Timer stoppen')}
          </button>
        ) : (
          <button
            type="button"
            className="btn small"
            onClick={async () => {
              const r = await act(() => api.post('/api/pm/timer/start', { task_id: task.id }));
              if (r) refresh();
            }}
          >
            <Icon name="play" size={13} /> {t('Timer starten')}
          </button>
        )}
        <span className="muted small">{t('Gesamt erfasst:')} {fmtHM(task.logged_seconds)} {t('Std.')}</span>
      </div>
      <div className="pm-time-form">
        <input type="date" value={day} max={todayIn(tz)} onChange={(e) => setDay(e.target.value)} aria-label={t('Datum')} />
        <input value={dur} placeholder={t('Dauer, z. B. 1:30 oder 45m')} aria-label={t('Dauer')} onChange={(e) => setDur(e.target.value)} />
        <input value={note} placeholder={t('Notiz (optional)')} aria-label={t('Notiz')} onChange={(e) => setNote(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={bill} onChange={(e) => setBill(e.target.checked)} /> {t('abrechenbar')}
        </label>
        <button
          type="button"
          className="btn small"
          disabled={!minutes}
          onClick={async () => {
            const r = await act(() => api.post('/api/pm/time', { task_id: task.id, date: day, minutes, note, billable: bill }), t('Zeit eingetragen'));
            if (r) (setDur(''), setNote(''), refresh());
          }}
        >
          {t('Eintragen')}
        </button>
      </div>
      {entries.map((e) => (
        <div key={e.id} className="pm-entry">
          <span className="pm-entry-day">{fmtShort(e.day)}</span>
          <strong>{e.running ? t('läuft …') : t('{h} Std.', { h: fmtHM(e.seconds) })}</strong>
          <span className="grow muted small">
            {e.user_name}
            {e.note ? ` · ${e.note}` : ''}
          </span>
          {!e.billable && <span className="badge gray">{t('nicht abrechenbar')}</span>}
          {e.invoice_number && <span className="badge green">{e.invoice_number}</span>}
          {e.approval !== 'open' && !e.invoice_number && <span className="badge blue">{e.approval === 'submitted' ? t('abgegeben') : e.approval === 'approved' ? t('freigegeben') : t('abgelehnt')}</span>}
          {!e.running && !e.invoice_number && (
            <button
              type="button"
              className="icon-btn"
              aria-label={t('Eintrag löschen')}
              onClick={async () => {
                if (!confirmAsk(t('Zeiteintrag löschen?'))) return;
                await act(() => api.del(`/api/pm/time/${e.id}`));
                refresh();
              }}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {!entries.length && !list.loading && <p className="muted small">{t('Noch keine Zeit erfasst.')}</p>}
    </div>
  );
}

// --- recurrence ---------------------------------------------------------------------------------------------------------

// German labels (message ids of the pm catalog), shown through t()
const WEEKDAYS: [number, string][] = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [0, 'So']];
const DAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** A rule in words, in the UI language – the same text as describeRecurrence() of server/services/pm-recur.ts in German. */
function recurText(rule: Recurrence): string {
  const t = tr('pm');
  const n = rule.interval;
  let s = '';
  switch (rule.freq) {
    case 'daily':
      s = t.plural(n, { one: 'Täglich', other: 'Alle {n} Tage' });
      break;
    case 'weekly':
      s = t.plural(n, { one: 'Wöchentlich', other: 'Alle {n} Wochen' });
      if (rule.weekdays?.length) s += ` (${rule.weekdays.map((w) => t(DAY_SHORT[w] ?? '')).join(', ')})`;
      break;
    case 'monthly':
      s = t.plural(n, { one: 'Monatlich', other: 'Alle {n} Monate' });
      if (rule.day_of_month) s += t(' am {day}.', { day: rule.day_of_month });
      break;
    case 'yearly':
      s = t.plural(n, { one: 'Jährlich', other: 'Alle {n} Jahre' });
      break;
  }
  if (rule.mode === 'completion') s += t(', ab Erledigung');
  if (rule.end.type === 'count') s += `, ${rule.end.count}×`;
  if (rule.end.type === 'date') s += t(', bis {date}', { date: fmtFull(rule.end.date) });
  return s;
}

export function RecurrenceEditor({ value, onChange }: { value: Recurrence | null; onChange: (r: Recurrence | null) => void }) {
  const t = useT('pm');
  const base: Recurrence = value ?? { freq: 'weekly', interval: 1, mode: 'due', end: { type: 'never' } };
  const set = (patch: Partial<Recurrence>) => onChange({ ...base, ...patch });
  return (
    <Pop label={t('Wiederholung')} width={300} className="pm-recur-btn" button={value ? <span>{recurText(value)}</span> : <span className="muted">{t('Keine')}</span>}>
      {(close) => (
        <div className="pm-recur">
          <label className="field">
            <span>{t('Wiederholen')}</span>
            <select value={value?.freq ?? ''} onChange={(e) => (e.target.value ? set({ freq: e.target.value as Recurrence['freq'] }) : onChange(null))}>
              <option value="">{t('Nie')}</option>
              <option value="daily">{t('Täglich')}</option>
              <option value="weekly">{t('Wöchentlich')}</option>
              <option value="monthly">{t('Monatlich')}</option>
              <option value="yearly">{t('Jährlich')}</option>
            </select>
          </label>
          {value && (
            <>
              <label className="field">
                <span>{t('Alle')}</span>
                <input type="number" min={1} max={99} value={value.interval} onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })} />
              </label>
              {value.freq === 'weekly' && (
                <div className="pm-weekdays" role="group" aria-label={t('Wochentage')}>
                  {WEEKDAYS.map(([n, l]) => {
                    const on = (value.weekdays ?? []).includes(n);
                    return (
                      <button type="button" key={n} className={on ? 'on' : ''} aria-pressed={on} onClick={() => set({ weekdays: on ? (value.weekdays ?? []).filter((x) => x !== n) : [...(value.weekdays ?? []), n] })}>
                        {t(l)}
                      </button>
                    );
                  })}
                </div>
              )}
              <label className="field">
                <span>{t('Zählt ab')}</span>
                <select value={value.mode} onChange={(e) => set({ mode: e.target.value as Recurrence['mode'] })}>
                  <option value="due">{t('Fälligkeit (fester Rhythmus)')}</option>
                  <option value="completion">{t('Erledigung')}</option>
                </select>
              </label>
              <label className="field">
                <span>{t('Ende')}</span>
                <select value={value.end.type} onChange={(e) => set({ end: e.target.value === 'count' ? { type: 'count', count: 5 } : e.target.value === 'date' ? { type: 'date', date: '' } : { type: 'never' } })}>
                  <option value="never">{t('Nie')}</option>
                  <option value="count">{t('Nach Anzahl')}</option>
                  <option value="date">{t('An einem Datum')}</option>
                </select>
              </label>
              {value.end.type === 'count' && <input type="number" min={1} value={value.end.count} aria-label={t('Anzahl')} onChange={(e) => set({ end: { type: 'count', count: Math.max(1, Number(e.target.value) || 1) } })} />}
              {value.end.type === 'date' && <input type="date" value={value.end.date} aria-label={t('Enddatum')} onChange={(e) => set({ end: { type: 'date', date: e.target.value } })} />}
            </>
          )}
          <button type="button" className="btn small" onClick={close}>
            {t('Fertig')}
          </button>
        </div>
      )}
    </Pop>
  );
}

