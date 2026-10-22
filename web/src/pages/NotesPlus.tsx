import { useState } from 'react';
import { api, dt, name } from '../api';
import { Icon } from '../icons';
import { useT } from '../i18n';
import { act, Check, confirmAsk, Field, Input, Link, Select, Textarea, useLoad } from '../ui';
import { MarkdownEditor } from './ContentKit';
import './notes-plus.css';
import { ContactDocuments, NoteFiles } from './ContactDocuments';

/**
 * Better notes (modules/notes-plus.ts): the notes tab of a contact with title, colour, pinning and Markdown (rendered and
 * sanitised by the server), search in this contact's or in all notes, and the extra fields of the workflow step "Notiz".
 */

const COLORS: [string, string][] = [
  ['', 'Ohne Farbe'],
  ['yellow', 'Gelb'],
  ['green', 'Grün'],
  ['blue', 'Blau'],
  ['red', 'Rot'],
  ['purple', 'Lila'],
  ['gray', 'Grau'],
];

interface Note {
  id: string;
  contact_id: string;
  title: string;
  body: string;
  html: string;
  color: string;
  pinned: boolean;
  user_name?: string | null;
  first_name?: string;
  last_name?: string;
  email?: string;
  created_at: string;
  updated_at?: string | null;
}

function ColorChips({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT('notes');
  return (
    <span className="note-colors" role="group" aria-label={t('Farbe')}>
      {COLORS.map(([k, l]) => (
        <button key={k || 'none'} type="button" className={`note-color note-${k || 'none'}`} aria-pressed={value === k} aria-label={t(l)} title={t(l)} onClick={() => onChange(k)} />
      ))}
    </span>
  );
}

function NoteForm({ note, onSave, onCancel }: { note?: Note; onSave: (v: { title: string; body: string; color: string; pinned: boolean }) => Promise<unknown>; onCancel?: () => void }) {
  const t = useT('notes');
  const [v, setV] = useState({ title: note?.title ?? '', body: note?.body ?? '', color: note?.color ?? '', pinned: note?.pinned ?? false });
  return (
    <div className={`note-form note-${v.color || 'none'}`}>
      <Input value={v.title} onChange={(title) => setV({ ...v, title })} placeholder={t('Titel (optional)')} aria-label={t('Titel')} maxLength={200} />
      <MarkdownEditor value={v.body} onChange={(body) => setV({ ...v, body })} rows={4} placeholder={t('Notiz… (Markdown: **fett**, - Liste, [Link](https://…))')} label={t('Notiz')} />
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="row" style={{ alignItems: 'center', gap: 12 }}>
          <ColorChips value={v.color} onChange={(color) => setV({ ...v, color })} />
          <Check checked={v.pinned} onChange={(pinned) => setV({ ...v, pinned })} label={t('Oben anheften')} />
        </span>
        <span className="row" style={{ gap: 6 }}>
          {onCancel && (
            <button type="button" className="btn small ghost" onClick={onCancel}>
              {t('Abbrechen')}
            </button>
          )}
          <button type="button" className="btn small" disabled={!v.body.trim()} onClick={async () => (await onSave(v)) && !note && setV({ title: '', body: '', color: '', pinned: false })}>
            {note ? t('Speichern') : t('Notiz speichern')}
          </button>
        </span>
      </div>
    </div>
  );
}

export function NotesPanel({ contactId, onChanged }: { contactId: string; onChanged?: () => void }) {
  const t = useT('notes');
  const [q, setQ] = useState('');
  const [everywhere, setEverywhere] = useState(false);
  const [edit, setEdit] = useState('');
  const qs = new URLSearchParams({ ...(everywhere && q ? {} : { contact_id: contactId }), ...(q ? { q } : {}) }).toString();
  const notes = useLoad(() => api.get<Note[]>(`/api/notes?${qs}`), [qs]);
  const done = () => (notes.reload(), onChanged?.());
  const patch = (n: Note, body: Record<string, unknown>) => act(() => api.patch(`/api/notes/${n.id}`, body)).then((r) => (r && done(), r));
  return (
    <div className="notes-plus" data-tour="contact-notes">
      <NoteForm onSave={(v) => act(() => api.post('/api/notes', { contact_id: contactId, ...v }), t('Notiz gespeichert')).then((r) => (r && done(), r))} />
      <ContactDocuments contactId={contactId} notes={notes.data ?? []} />
      <div className="row notes-search" style={{ alignItems: 'center' }}>
        <div className="grow">
          <Input value={q} onChange={setQ} placeholder={t('Notizen durchsuchen…')} aria-label={t('Notizen durchsuchen')} />
        </div>
        <Check checked={everywhere} onChange={setEverywhere} label={t('In allen Kontakten')} />
      </div>
      {notes.data?.length === 0 && <p className="muted">{q ? t('Keine Notiz gefunden.') : t('Noch keine Notizen.')}</p>}
      {(notes.data ?? []).map((n) =>
        edit === n.id ? (
          <NoteForm key={n.id} note={n} onCancel={() => setEdit('')} onSave={(v) => patch(n, v).then((r) => (r && setEdit(''), r))} />
        ) : (
          <article key={n.id} className={`note-card note-${n.color || 'none'}${n.pinned ? ' pinned' : ''}`}>
            <header className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>
                {n.pinned && <Icon name="pin" size={13} />} {n.title || (n.contact_id !== contactId ? name(n) : '')}
              </strong>
              <span className="note-tools">
                <button type="button" className="icon-btn" aria-pressed={n.pinned} aria-label={n.pinned ? t('Lösen') : t('Oben anheften')} title={n.pinned ? t('Lösen') : t('Oben anheften')} onClick={() => patch(n, { pinned: !n.pinned })}>
                  <Icon name="pin" size={14} />
                </button>
                <button type="button" className="icon-btn" aria-label={t('Bearbeiten')} title={t('Bearbeiten')} onClick={() => setEdit(n.id)}>
                  <Icon name="edit" size={14} />
                </button>
                <button type="button" className="icon-btn" aria-label={t('Löschen')} title={t('Löschen')} onClick={() => confirmAsk(t('Notiz löschen?')) && act(() => api.del(`/api/notes/${n.id}`)).then(done)}>
                  ✕
                </button>
              </span>
            </header>
            {/* The server renders the Markdown with the wiki's escaping renderer and allow-list sanitiser. */}
            <div className="note-body md" dangerouslySetInnerHTML={{ __html: n.html }} />
            {n.contact_id === contactId && <NoteFiles contactId={contactId} noteId={n.id} />}
            <div className="muted small">
              {n.contact_id !== contactId && (
                <>
                  <Link to={`contacts/${n.contact_id}`}>{name(n)}</Link> ·{' '}
                </>
              )}
              {n.user_name ?? t('Automation')} · {dt(n.created_at)}
              {n.updated_at && n.updated_at.slice(0, 16) !== n.created_at.slice(0, 16) ? ` · ${t('bearbeitet')}` : ''}
            </div>
          </article>
        ),
      )}
    </div>
  );
}

/** The workflow step "Notiz hinzufügen": text plus title, colour and pinning. */
export function NoteStepFields({ step, set }: { step: any; set: (p: any) => void }) {
  const t = useT('notes');
  return (
    <>
      <Field label={t('Titel (optional)')}>
        <Input value={step.title ?? ''} onChange={(title) => set({ title })} />
      </Field>
      <Field label={t('Notiz')} hint={t('Markdown und Platzhalter wie {{contact.first_name}} sind erlaubt.')}>
        <Textarea value={step.body} onChange={(body) => set({ body })} />
      </Field>
      <Field label={t('Farbe')}>
        <Select value={step.color ?? ''} onChange={(color) => set({ color })} options={COLORS.map(([k, l]) => [k, t(l)] as [string, string])} />
      </Field>
      <Check checked={!!step.pinned} onChange={(pinned) => set({ pinned })} label={t('Oben anheften')} />
    </>
  );
}
