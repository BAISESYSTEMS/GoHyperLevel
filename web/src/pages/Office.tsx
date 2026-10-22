import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import './office.css';
import { ago, api } from '../api';
import { useT } from '../i18n';
import { Badge, Empty, Field, Input, Modal, PageHead, Spinner, Tabs, act, navigate, pressable, toastError, useLoad } from '../ui';
import { ACCEPT, MIME, OFFICE_KINDS, postBytes, sizeLabel, type OfficeFileRow, type OfficeKind, type OfficeStatus } from './office-kit';
import { Faces, KindIcon, SetupNote, kindLabels, useOpenBy } from './OfficeParts';
import { OfficeFile } from './OfficeFile';

/**
 * Office: documents, spreadsheets, presentations and PDFs of the sub-account – list with filters, new and upload; one file opens in
 * OfficeFile.tsx (editor, versions, comments, AI). Server contract and setup: docs/office.md.
 */

function NewDialog({ kind, onClose }: { kind: OfficeKind; onClose: () => void }) {
  const t = useT('office');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const title = { docx: t('Neues Dokument'), xlsx: t('Neue Tabelle'), pptx: t('Neue Präsentation'), pdf: t('Neues PDF') }[kind];
  const create = async () => {
    setBusy(true);
    const f = await act(() => api.post<OfficeFileRow>('/api/office/files', { kind, name: name.trim() || undefined }), t('Angelegt'));
    setBusy(false);
    if (f) {
      onClose();
      navigate(`office/${f.id}`);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button className="btn" disabled={busy} onClick={create} data-tour="office-create">
            {t('Anlegen')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Field label={t('Name')}>
          <Input value={name} onChange={setName} autoFocus placeholder={title} maxLength={150} />
        </Field>
      </form>
    </Modal>
  );
}

function OfficeList() {
  const t = useT('office');
  const labels = kindLabels(t);
  const [kind, setKind] = useState<'' | OfficeKind>('');
  const [q, setQ] = useState('');
  const [newKind, setNewKind] = useState<OfficeKind | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const status = useLoad<OfficeStatus>(() => api.get('/api/office/status'), []);
  const list = useLoad<OfficeFileRow[]>(() => api.get(`/api/office/files?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(q.trim() ? { q: q.trim() } : {}), limit: '200' })}`), [kind, q]);
  const open = useOpenBy();

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    let last: OfficeFileRow | undefined;
    for (const f of [...files]) {
      const ext = f.name.toLowerCase().split('.').pop() as OfficeKind;
      if (!OFFICE_KINDS.includes(ext)) {
        toastError(new Error(t('„{name}“: nur .docx, .xlsx, .pptx oder .pdf', { name: f.name })));
        continue;
      }
      try {
        last = await postBytes<OfficeFileRow>('/api/office/files', f, { name: f.name, kind: ext, mime: f.type || MIME[ext] });
      } catch (e) {
        toastError(e);
      }
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
    void list.reload();
    if (last && files.length === 1) navigate(`office/${last.id}`);
  };

  const rows = list.data ?? [];
  return (
    <div className="of-page">
      <PageHead title={t('Office')} sub={t('Dokumente, Tabellen, Präsentationen und PDFs – im Browser bearbeiten, mit Versionen, Kommentaren und dem KI-Agenten.')}>
        <div className="of-new" data-tour="office-new">
          <button className="btn" onClick={() => setNewKind('docx')}>
            <KindIcon kind="docx" size={16} /> {t('Dokument')}
          </button>
          <button className="btn secondary" onClick={() => setNewKind('xlsx')}>
            <KindIcon kind="xlsx" size={16} /> {t('Tabelle')}
          </button>
          <button className="btn secondary" onClick={() => setNewKind('pptx')}>
            <KindIcon kind="pptx" size={16} /> {t('Präsentation')}
          </button>
          <button className="btn secondary" disabled={uploading} onClick={() => fileInput.current?.click()} data-tour="office-upload">
            <Upload size={16} aria-hidden="true" /> {uploading ? t('Lädt hoch …') : t('Hochladen')}
          </button>
          <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => void upload(e.target.files)} aria-label={t('Dateien hochladen')} />
        </div>
      </PageHead>
      {status.data && <SetupNote status={status.data} />}
      <div className="of-filters">
        <Tabs tabs={[['', t('Alle')], ...OFFICE_KINDS.map((k) => [k, labels[k]] as [string, string])]} value={kind} onChange={(v) => setKind(v as '' | OfficeKind)} />
        <input className="of-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Dateien suchen …')} aria-label={t('Dateien suchen')} />
      </div>
      {list.loading && !list.data ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty tour="office-empty" action={<button className="btn" onClick={() => setNewKind('docx')}>{t('Neues Dokument')}</button>}>
          {q || kind ? t('Keine passenden Dateien.') : t('Noch keine Dateien – lege ein Dokument an oder lade eine Datei hoch.')}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="t of-table">
            <thead>
              <tr>
                <th>{t('Name')}</th>
                <th>{t('Verknüpft mit')}</th>
                <th>{t('Version')}</th>
                <th>{t('Geändert')}</th>
                <th>{t('Status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                const here = open.filter((p) => p.page === `/office/${f.id}`);
                return (
                  <tr key={f.id} className="click" {...pressable(() => navigate(`office/${f.id}`))} aria-label={t('{name} öffnen', { name: f.name })}>
                    <td>
                      <span className="of-name">
                        <KindIcon kind={f.kind} /> {f.name}
                      </span>
                    </td>
                    <td className="muted">{[f.contact_name, f.deal_name].filter(Boolean).join(' · ') || '–'}</td>
                    <td>
                      v{f.version} <span className="muted small">{sizeLabel(f.size)}</span>
                    </td>
                    <td>
                      {ago(f.updated_at)} <span className="muted small">{f.updated_by_name}</span>
                    </td>
                    <td>
                      {f.lock && <Badge tone="yellow">{t('{name} bearbeitet', { name: f.lock.user_name })}</Badge>} {!!f.open_comments && <Badge tone="blue">{t.plural(f.open_comments, { one: '{n} Kommentar', other: '{n} Kommentare' })}</Badge>}{' '}
                      <Faces list={here} label={t('Gerade geöffnet von {names}', { names: here.map((p) => p.name).join(', ') })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {status.data && (
        <p className="muted small of-usage">
          {t('Speicher: {used} von {quota}', { used: sizeLabel(status.data.limits.used_bytes), quota: status.data.limits.quota_bytes ? sizeLabel(status.data.limits.quota_bytes) : t('unbegrenzt') })} · {t('höchstens {max} je Datei', { max: sizeLabel(status.data.limits.max_bytes) })}
        </p>
      )}
      {newKind && <NewDialog kind={newKind} onClose={() => setNewKind(null)} />}
    </div>
  );
}

export function Office({ id }: { id?: string }) {
  return id ? <OfficeFile id={id} /> : <OfficeList />;
}
