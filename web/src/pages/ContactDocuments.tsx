import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, currentLocation, dt } from '../api';
import { MoreFields } from '../areas/fields';
import { Icon } from '../icons';
import { useT } from '../i18n';
import { Slot } from '../slots';
import { act, Check, confirmAsk, Select, toast } from '../ui';
import './crm-gaps.css';

/**
 * Documents on a contact and attachments on its notes (modules/contact-documents.ts): the files row on top of the notes tab
 * (upload, list, "nur für mich") and the chips on each note card. Both read one small store per contact, so the list loads once.
 */

export interface ContactDoc {
  id: string;
  contact_id: string;
  note_id: string | null;
  note_title?: string;
  name: string;
  mime: string;
  size: number;
  private: boolean;
  user_name?: string | null;
  created_at: string;
  url: string;
}

const MAX = 8 * 1024 * 1024;
const store = new Map<string, { docs: ContactDoc[]; loaded: boolean; subs: Set<() => void> }>();
const entry = (contactId: string) => {
  let e = store.get(contactId);
  if (!e) store.set(contactId, (e = { docs: [], loaded: false, subs: new Set() }));
  return e;
};
async function reload(contactId: string) {
  const e = entry(contactId);
  e.docs = await api.get<ContactDoc[]>(`/api/contacts/${encodeURIComponent(contactId)}/documents`).catch(() => e.docs);
  e.loaded = true;
  e.subs.forEach((f) => f());
}
function useDocs(contactId: string): ContactDoc[] {
  const e = entry(contactId);
  const docs = useSyncExternalStore(
    (f) => (e.subs.add(f), () => void e.subs.delete(f)),
    () => e.docs,
  );
  useEffect(() => {
    if (!e.loaded) void reload(contactId);
  }, [contactId]);
  return docs;
}

const href = (d: ContactDoc, inline = false) => `${d.url}?locationId=${encodeURIComponent(currentLocation())}${inline ? '&inline=1' : ''}`;
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function DocChip({ d, onRemove }: { d: ContactDoc; onRemove: () => void }) {
  const t = useT('crmgaps');
  return (
    <span className="doc-chip">
      <Icon name={d.private ? 'lock' : 'file'} size={12} />
      <a href={href(d, /^image\/|pdf$/.test(d.mime))} target="_blank" rel="noopener noreferrer" title={`${d.user_name ?? ''} · ${dt(d.created_at)}`}>
        {d.name}
      </a>
      <span className="muted small">{size(d.size)}</span>
      <Slot name="contact.document" doc={d} />
      <button type="button" className="icon-btn" aria-label={t('{name} löschen', { name: d.name })} onClick={() => confirmAsk(t('Datei „{name}“ löschen?', { name: d.name })) && onRemove()}>
        ✕
      </button>
    </span>
  );
}

const remove = (d: ContactDoc) => act(() => api.del(`/api/contacts/${encodeURIComponent(d.contact_id)}/documents/${d.id}`)).then(() => reload(d.contact_id));

/** The files row of the notes tab: upload (optionally onto a note, optionally "nur für mich") and the contact's own documents. */
export function ContactDocuments({ contactId, notes }: { contactId: string; notes: { id: string; title?: string; body: string; contact_id: string }[] }) {
  const t = useT('crmgaps');
  const docs = useDocs(contactId);
  const [priv, setPriv] = useState(false);
  const [noteId, setNoteId] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const own = docs.filter((d) => !d.note_id);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    let ok = 0;
    for (const f of [...files].slice(0, 10)) {
      if (f.size > MAX) {
        toast(t('„{name}“ ist größer als 8 MB', { name: f.name }));
        continue;
      }
      const data = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(r.error);
        r.readAsDataURL(f);
      });
      if (await act(() => api.post(`/api/contacts/${encodeURIComponent(contactId)}/documents`, { name: f.name, mime: f.type || undefined, data, private: priv, note_id: noteId || undefined }))) ok++;
    }
    setBusy(false);
    if (input.current) input.current.value = '';
    if (ok) toast(t.plural(ok, { one: '{n} Datei hochgeladen', other: '{n} Dateien hochgeladen' }));
    await reload(contactId);
  };

  return (
    <div className="contact-docs" data-tour="contact-documents">
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <strong className="small">{t('Dateien ({n})', { n: docs.length })}</strong>
        <label className="btn small secondary" aria-disabled={busy}>
          <Icon name="file" size={14} /> {busy ? t('Lädt hoch…') : t('Datei anhängen')}
          <input ref={input} type="file" multiple hidden disabled={busy} accept="image/*,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.pptx,.odt,.ods" onChange={(e) => void upload(e.target.files)} />
        </label>
      </div>
      <MoreFields id="contact-docs-upload" values={[priv || '', noteId]} label={t('Optionen')}>
        <div className="row" style={{ alignItems: 'center' }}>
          <Check checked={priv} onChange={setPriv} label={t('Nur für mich sichtbar')} />
          {notes.length > 0 && (
            <div style={{ width: 220 }}>
              <Select value={noteId} onChange={setNoteId} placeholder={t('Am Kontakt (keine Notiz)')} aria={t('An Notiz hängen')} options={notes.filter((n) => n.contact_id === contactId).map((n) => [n.id, (n.title || n.body).slice(0, 40)] as [string, string])} />
            </div>
          )}
        </div>
      </MoreFields>
      {own.length > 0 && (
        <div className="doc-chips">
          {own.map((d) => (
            <DocChip key={d.id} d={d} onRemove={() => void remove(d)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The attachments of one note (chips under the note text). */
export function NoteFiles({ contactId, noteId }: { contactId: string; noteId: string }) {
  const docs = useDocs(contactId).filter((d) => d.note_id === noteId);
  if (!docs.length) return null;
  return (
    <div className="doc-chips">
      {docs.map((d) => (
        <DocChip key={d.id} d={d} onRemove={() => void remove(d)} />
      ))}
    </div>
  );
}
