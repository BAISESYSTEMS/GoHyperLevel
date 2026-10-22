import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ago } from '../api';
import { act } from '../ui';
import { Icon } from '../icons';
import { useSession } from '../session';
import { elementBox } from '../../../server/services/canvas-model';
import { toScreen } from './geometry';
import type { Comment } from './store';
import type { EditorApi } from './Editor';

/** Comments pinned to elements (or spots), with replies, resolving and @mentions. */

interface Person {
  id: string;
  name: string;
}

function usePeople(boardId: string) {
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    void api
      .get(`/api/canvas/${boardId}/people`)
      .then(setPeople)
      .catch(() => setPeople([]));
  }, [boardId]);
  return people;
}

function Composer({ boardId, people, placeholder, onSend, autoFocus }: { boardId: string; people: Person[]; placeholder: string; onSend: (body: string, mentions: string[]) => Promise<unknown>; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const query = text.slice(0, ref.current?.selectionStart ?? text.length).match(/@([\p{L}\p{N} .-]{0,30})$/u)?.[1];
  const matches = query !== undefined ? people.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6) : [];
  const pick = (p: Person) => {
    const pos = ref.current?.selectionStart ?? text.length;
    const before = text.slice(0, pos).replace(/@([\p{L}\p{N} .-]{0,30})$/u, `@${p.name} `);
    setText(before + text.slice(pos));
    setMentions((m) => [...new Set([...m, p.id])]);
    ref.current?.focus();
  };
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onSend(text.trim(), mentions.filter((id) => text.includes(`@${people.find((p) => p.id === id)?.name ?? '\u0000'}`)));
    setBusy(false);
    if (ok !== undefined) {
      setText('');
      setMentions([]);
    }
  };
  void boardId;
  return (
    <div className="cv-composer">
      <textarea
        ref={ref}
        rows={2}
        value={text}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey && !matches.length) {
            e.preventDefault();
            void send();
          }
          if (e.key === 'Enter' && matches.length) {
            e.preventDefault();
            pick(matches[0]);
          }
        }}
      />
      {matches.length > 0 && (
        <div className="cv-mentions">
          {matches.map((p) => (
            <button key={p.id} onMouseDown={(e) => (e.preventDefault(), pick(p))}>
              @{p.name}
            </button>
          ))}
        </div>
      )}
      <button className="btn small" onClick={() => void send()} disabled={!text.trim() || busy}>
        Senden
      </button>
    </div>
  );
}

export function CommentsPanel({ api: ed, draft, focusId, onDraftDone, onClose }: { api: EditorApi; draft: { x: number; y: number; elementId: string | null } | null; focusId: string | null; onDraftDone: () => void; onClose: () => void }) {
  const session = useSession();
  const people = usePeople(ed.board.id);
  const [filter, setFilter] = useState<'open' | 'done'>('open');
  const comments = ed.store.comments;
  const threads = useMemo(() => comments.filter((c) => !c.parent_id && (filter === 'open' ? !c.resolved_at : !!c.resolved_at)).sort((a, b) => b.created_at.localeCompare(a.created_at)), [comments, filter]);
  const replies = (id: string) => comments.filter((c) => c.parent_id === id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const post = (body: string, mentions: string[], extra: Record<string, unknown>) => act(() => api.post(`/api/canvas/${ed.board.id}/comments`, { body, mentions, ...extra }));
  useEffect(() => {
    if (!focusId) return;
    const c = comments.find((x) => x.id === focusId);
    if (c) {
      if (c.resolved_at) setFilter('done');
      ed.comments.focus(c);
      document.getElementById(`cm-${focusId}`)?.scrollIntoView({ block: 'center' });
    }
  }, [focusId, comments.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const target = (c: Comment) => {
    const el = c.element_id ? ed.store.els.get(c.element_id) : null;
    return el ? (el.text || el.name || 'Element').split('\n')[0].slice(0, 40) : 'Stelle auf dem Board';
  };
  return (
    <aside className="cv-comments cv-panel" data-tour="canvas-comments-panel">
      <div className="cv-insp-head">
        <b>Kommentare</b>
        <div className="cv-seg small">
          <button className={filter === 'open' ? 'on' : ''} onClick={() => setFilter('open')}>
            Offen
          </button>
          <button className={filter === 'done' ? 'on' : ''} onClick={() => setFilter('done')}>
            Erledigt
          </button>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Schließen">
          ✕
        </button>
      </div>
      {draft && (
        <div className="cv-thread new">
          <div className="muted small">Neuer Kommentar · {draft.elementId ? target({ element_id: draft.elementId } as Comment) : 'an dieser Stelle'}</div>
          <Composer boardId={ed.board.id} people={people} autoFocus placeholder="Kommentar … mit @Name erwähnen" onSend={async (body, mentions) => {
            const r = await post(body, mentions, { element_id: draft.elementId, x: Math.round(draft.x), y: Math.round(draft.y) });
            if (r) onDraftDone();
            return r;
          }} />
        </div>
      )}
      <div className="cv-thread-list">
        {!threads.length && !draft && <p className="muted small">{filter === 'open' ? 'Keine offenen Kommentare. Mit dem Kommentar-Werkzeug (C) auf ein Element klicken.' : 'Nichts erledigt.'}</p>}
        {threads.map((c) => (
          <div key={c.id} id={`cm-${c.id}`} className={`cv-thread${focusId === c.id ? ' focus' : ''}`}>
            <button className="cv-thread-target" onClick={() => ed.comments.focus(c)}>
              <Icon name="pin" size={13} /> {target(c)}
            </button>
            {[c, ...replies(c.id)].map((m) => (
              <div key={m.id} className="cv-msg">
                <div className="cv-msg-head">
                  <b>{m.author_name}</b> <span className="muted small">{ago(m.created_at)}</span>
                  {(m.author_id === session.user.id || ed.board.access === 'owner') && (
                    <button className="icon-btn" title="Löschen" onClick={() => void act(() => api.del(`/api/canvas/${ed.board.id}/comments/${m.id}`))}>
                      <Icon name="trash" size={13} />
                    </button>
                  )}
                </div>
                <div className="cv-msg-body">{m.body}</div>
              </div>
            ))}
            <div className="cv-thread-actions">
              <Composer boardId={ed.board.id} people={people} placeholder="Antworten …" onSend={(body, mentions) => post(body, mentions, { parent_id: c.id })} />
              <button className="btn small secondary" onClick={() => void act(() => api.patch(`/api/canvas/${ed.board.id}/comments/${c.id}`, { resolved: !c.resolved_at }))}>
                {c.resolved_at ? 'Wieder öffnen' : '✓ Erledigt'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/** Speech-bubble pins at the commented elements. */
export function CommentPins({ api: ed, onOpen }: { api: EditorApi; onOpen: (c: Comment) => void }) {
  const open = ed.store.comments.filter((c) => !c.parent_id && !c.resolved_at);
  return (
    <>
      {open.map((c, i) => {
        const el = c.element_id ? ed.store.els.get(c.element_id) : null;
        let x: number;
        let y: number;
        if (el) {
          const b = elementBox(el);
          [x, y] = toScreen(ed.view, b.x + b.w, b.y);
        } else if (c.x !== null && c.y !== null) [x, y] = toScreen(ed.view, c.x, c.y);
        else return null;
        if (x < -20 || y < -20 || x > ed.size.w + 20 || y > ed.size.h + 20) return null;
        const n = ed.store.comments.filter((r) => r.parent_id === c.id).length + 1;
        return (
          <button key={c.id} className="cv-pin" style={{ left: x - 4 + (i % 3) * 2, top: y - 26 }} onClick={() => onOpen(c)} title={`${c.author_name}: ${c.body}`}>
            {n}
          </button>
        );
      })}
    </>
  );
}
