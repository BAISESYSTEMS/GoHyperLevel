import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, FileDown, Lock, Pencil, Save, Sparkles, Trash2, Upload } from 'lucide-react';
import './office.css';
import { ApiError, ago, api, currentLocation, dt } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { Badge, Field, Input, Link, Modal, Spinner, Tabs, Textarea, act, confirmAsk, navigate, toast, toastError, useLoad } from '../ui';
import { ACCEPT, MIME, postBytes, sizeLabel, type OfficeComment, type OfficeDetail, type OfficeStatus, type OfficeVersion } from './office-kit';
import { OfficeEditor, type EditorHandle } from './OfficeEditor';
import { Faces, KindIcon, SetupNote, kindOne, useOpenBy } from './OfficeParts';

/**
 * One Office file: open it in the browser editor – to edit (with the edit lock, renewed while open and released on "Fertig") or
 * read-only –, versions with restore, comments with @mentions, links, and "Mit KI bearbeiten", which hands the request to the
 * HyperLevel Agent (its office tools save the result as a new version; confirmations happen in the agent panel).
 */

type Mode = 'closed' | 'edit' | 'read';

function authorText(v: OfficeVersion, t: ReturnType<typeof useT>) {
  if (v.author_kind === 'agent' && !v.author_name.startsWith('KI-Agent') && !v.author_name.endsWith('(KI-App)')) return t('KI-Agent (im Auftrag von {name})', { name: v.author_name });
  return v.author_name || t('Unbekannt');
}

function RenameDialog({ file, onClose, onDone }: { file: OfficeDetail; onClose: () => void; onDone: () => void }) {
  const t = useT('office');
  const [name, setName] = useState(file.name.replace(/\.[a-z]+$/i, ''));
  const save = async () => {
    const r = await act(() => api.patch(`/api/office/files/${file.id}`, { name }), t('Umbenannt'));
    if (r) (onDone(), onClose());
  };
  return (
    <Modal
      title={t('Umbenennen')}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button className="btn" onClick={save} disabled={!name.trim()}>
            {t('Speichern')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={t('Name')}>
          <Input value={name} onChange={setName} autoFocus maxLength={150} />
        </Field>
      </form>
    </Modal>
  );
}

function Versions({ file, onChange }: { file: OfficeDetail; onChange: () => void }) {
  const t = useT('office');
  const restore = async (v: OfficeVersion) => {
    if (!confirmAsk(t('Version {n} wiederherstellen? Sie wird als neue Version {next} gespeichert – nichts geht verloren.', { n: v.version, next: file.version + 1 }))) return;
    if (await act(() => api.post(`/api/office/files/${file.id}/versions/${v.version}/restore`), t('Wiederhergestellt'))) onChange();
  };
  return (
    <ol className="of-versions" data-tour="office-versions">
      {file.versions.map((v) => (
        <li key={v.id} className={v.version === file.version ? 'cur' : ''}>
          <div className="of-v-head">
            <strong>v{v.version}</strong> {v.version === file.version && <Badge tone="green">{t('aktuell')}</Badge>} {v.author_kind === 'agent' && <Badge tone="purple">{t('KI')}</Badge>}
            <span className="muted small">{dt(v.created_at)}</span>
          </div>
          <div className="small">
            {authorText(v, t)} · {sizeLabel(v.size)}
          </div>
          {v.message && <div className="muted small">{v.message}</div>}
          <div className="of-v-actions">
            <a className="btn small secondary" href={`/api/office/files/${file.id}/download?version=${v.version}&locationId=${encodeURIComponent(currentLocation())}`} download>
              <Download size={14} aria-hidden="true" /> {t('Herunterladen')}
            </a>
            {v.version !== file.version && (
              <button className="btn small secondary" onClick={() => restore(v)}>
                {t('Wiederherstellen')}
              </button>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Comments({ file }: { file: OfficeDetail }) {
  const t = useT('office');
  const session = useSession();
  const list = useLoad<OfficeComment[]>(() => api.get(`/api/office/files/${file.id}/comments`), [file.id]);
  const team = useLoad<{ id: string; name: string }[]>(() => api.get('/api/office/people'), []);
  const [body, setBody] = useState('');
  const [toVersion, setToVersion] = useState(false);
  const send = async () => {
    if (!body.trim()) return;
    const r = await act(() => api.post(`/api/office/files/${file.id}/comments`, { body, ...(toVersion ? { version: file.version } : {}) }), t('Kommentar gespeichert'));
    if (r) {
      setBody('');
      void list.reload();
    }
  };
  const all = list.data ?? [];
  return (
    <div className="of-comments" data-tour="office-comments">
      {!all.length && <p className="muted small">{t('Noch keine Kommentare.')}</p>}
      {all.map((c) => (
        <div key={c.id} className={`of-comment${c.resolved_at ? ' done' : ''}${c.parent_id ? ' reply' : ''}`}>
          <div className="of-v-head">
            <strong>{c.author_name}</strong> {c.version && <Badge>{`v${c.version}`}</Badge>} <span className="muted small">{ago(c.created_at)}</span>
          </div>
          <p>{c.body}</p>
          <div className="of-v-actions">
            <button className="btn small secondary" onClick={async () => (await act(() => api.patch(`/api/office/files/${file.id}/comments/${c.id}`, { resolved: !c.resolved_at }))) && list.reload()}>
              {c.resolved_at ? t('Wieder öffnen') : t('Erledigt')}
            </button>
            {(c.author_id === session.user.id || session.user.role === 'admin') && (
              <button className="btn small secondary" aria-label={t('Kommentar löschen')} onClick={async () => confirmAsk(t('Kommentar löschen?')) && (await act(() => api.del(`/api/office/files/${file.id}/comments/${c.id}`))) && list.reload()}>
                <Trash2 size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      ))}
      <Field label={t('Neuer Kommentar')} hint={t('Mit @Name erwähnst du jemanden aus dem Team: {names}', { names: (team.data ?? []).map((u) => u.name).slice(0, 6).join(', ') })}>
        <Textarea value={body} onChange={setBody} rows={3} maxLength={4000} />
      </Field>
      <label className="of-check">
        <input type="checkbox" checked={toVersion} onChange={(e) => setToVersion(e.target.checked)} /> {t('Zu Version {n}', { n: file.version })}
      </label>
      <button className="btn" onClick={send} disabled={!body.trim()}>
        {t('Kommentieren')}
      </button>
    </div>
  );
}

function AiBox({ file, status, lockedByOther }: { file: OfficeDetail; status: OfficeStatus; lockedByOther: string | null }) {
  const t = useT('office');
  const [text, setText] = useState('');
  const one = kindOne(t)[file.kind];
  const send = () => {
    const prompt = t('Bearbeite die Office-Datei „{name}“ ({one}, ID {id}, aktuell Version {v}) mit den Office-Werkzeugen (zuerst ghl_office_read, dann ghl_office_edit mit base_version {v}): {wish}', { name: file.name, one, id: file.id, v: file.version, wish: text.trim() });
    window.dispatchEvent(new CustomEvent('pghl:agent', { detail: { prompt } }));
    setText('');
  };
  return (
    <div className="of-ai" data-tour="office-ai">
      <p className="muted small">{t('Beschreibe, was der KI-Agent an der Datei ändern soll. Er speichert das Ergebnis als neue Version – du kannst jederzeit zurück.')}</p>
      {!status.engines[file.kind] && <p className="of-note small">{t('Ohne Office-Engine kann der Agent die Datei nur lesen, nicht ändern.')}</p>}
      {lockedByOther && <p className="of-note small">{t('{name} bearbeitet die Datei gerade – Änderungen des Agenten werden abgelehnt, bis die Sperre frei ist.', { name: lockedByOther })}</p>}
      <Textarea value={text} onChange={setText} rows={4} placeholder={t('z. B. „Ersetze im Angebot den Preis durch 4.900 € und mache die Überschrift fett“')} aria-label={t('Auftrag an den KI-Agenten')} maxLength={2000} />
      <button className="btn" disabled={!text.trim()} onClick={send}>
        <Sparkles size={16} aria-hidden="true" /> {t('An den KI-Agenten geben')}
      </button>
    </div>
  );
}

function LinksPanel({ file, onChange }: { file: OfficeDetail; onChange: () => void }) {
  const t = useT('office');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ contacts: any[]; opportunities: any[] } | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) return setHits(null);
    const timer = setTimeout(() => api.get(`/api/search?q=${encodeURIComponent(q.trim())}`).then(setHits).catch(() => setHits(null)), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const link = async (patch: Record<string, string | null>) => {
    if (await act(() => api.patch(`/api/office/files/${file.id}`, patch), t('Verknüpfung gespeichert'))) {
      setQ('');
      onChange();
    }
  };
  return (
    <div className="of-links">
      <dl>
        <dt>{t('Kontakt')}</dt>
        <dd>
          {file.contact_id ? (
            <>
              <Link to={`contacts/${file.contact_id}`}>{file.contact_name || t('Kontakt')}</Link>{' '}
              <button className="btn small secondary" onClick={() => link({ contact_id: null })}>
                {t('Lösen')}
              </button>
            </>
          ) : (
            '–'
          )}
        </dd>
        <dt>{t('Deal')}</dt>
        <dd>
          {file.deal_id ? (
            <>
              <Link to={`opportunities/${file.deal_id}`}>{file.deal_name || t('Deal')}</Link>{' '}
              <button className="btn small secondary" onClick={() => link({ deal_id: null })}>
                {t('Lösen')}
              </button>
            </>
          ) : (
            '–'
          )}
        </dd>
        {file.project_id && (
          <>
            <dt>{t('Projekt')}</dt>
            <dd>
              <Link to={`pm/${file.project_id}`}>{file.project_name || t('Projekt')}</Link>
            </dd>
          </>
        )}
        <dt>{t('Angelegt')}</dt>
        <dd>
          {dt(file.created_at)} · {file.created_by_name}
        </dd>
      </dl>
      <Field label={t('Mit Kontakt oder Deal verknüpfen')}>
        <Input value={q} onChange={setQ} placeholder={t('Name oder E-Mail suchen …')} />
      </Field>
      {hits && (
        <div className="of-hits">
          {hits.contacts?.slice(0, 5).map((c) => (
            <button key={c.id} className="btn small secondary" onClick={() => link({ contact_id: c.id })}>
              {[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email}
            </button>
          ))}
          {hits.opportunities?.slice(0, 5).map((o) => (
            <button key={o.id} className="btn small secondary" onClick={() => link({ deal_id: o.id })}>
              {o.name}
            </button>
          ))}
          {!hits.contacts?.length && !hits.opportunities?.length && <span className="muted small">{t('Nichts gefunden.')}</span>}
        </div>
      )}
    </div>
  );
}

export function OfficeFile({ id }: { id: string }) {
  const t = useT('office');
  const session = useSession();
  const file = useLoad<OfficeDetail>(() => api.get(`/api/office/files/${id}`), [id]);
  const status = useLoad<OfficeStatus>(() => api.get('/api/office/status'), []);
  const [mode, setMode] = useState<Mode>('closed');
  const [tab, setTab] = useState('versions');
  const [rename, setRename] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const upload = useRef<HTMLInputElement>(null);
  const openBy = useOpenBy(id);
  const f = file.data;
  const s = status.data;
  const lock = f?.lock ?? null;
  const mine = !!lock && lock.user_id === session.user.id;
  const lockedByOther = lock && !mine ? lock.user_name : null;

  const reload = useCallback(() => void file.reload(), [file.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // While editing: renew the lock, release it when leaving (also when the tab closes).
  useEffect(() => {
    if (mode !== 'edit' || !s) return;
    const renew = setInterval(() => {
      api.post(`/api/office/files/${id}/lock`).catch((e) => {
        if (e instanceof ApiError && e.status === 423) {
          toastError(e);
          setMode('read');
        }
      });
    }, s.lock_renew_ms);
    const release = () => {
      void fetch(`/api/office/files/${id}/lock`, { method: 'DELETE', keepalive: true, headers: { 'x-pghl': '1', 'x-location-id': currentLocation() } });
    };
    window.addEventListener('pagehide', release);
    return () => {
      clearInterval(renew);
      window.removeEventListener('pagehide', release);
      release();
    };
  }, [mode, id, s]);

  if (file.error) return <p className="error">{file.error}</p>;
  if (!f || !s) return <Spinner />;

  const startEdit = async () => {
    try {
      await api.post(`/api/office/files/${id}/lock`);
      setMode('edit');
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 423 && confirmAsk(`${e.message}\n\n${t('Jetzt schreibgeschützt öffnen?')}`)) setMode('read');
      else if (!(e instanceof ApiError && e.status === 423)) toastError(e);
    }
  };
  const done = () => {
    setMode('closed');
    setTimeout(reload, 300);
  };
  const uploadVersion = async (list: FileList | null) => {
    const one = list?.[0];
    if (upload.current) upload.current.value = '';
    if (!one) return;
    try {
      await postBytes(`/api/office/files/${id}/versions`, one, { message: t('Neue Fassung hochgeladen: {name}', { name: one.name }) });
      toast(t('Als neue Version gespeichert'));
      reload();
    } catch (e) {
      toastError(e);
    }
  };
  const exportPdf = async () => {
    const r = await act(() => api.post<{ id: string }>(`/api/office/files/${id}/export-pdf`, {}), t('PDF angelegt'));
    if (r) navigate(`office/${r.id}`);
  };
  const remove = async () => {
    if (!confirmAsk(t('„{name}“ mit allen {n} Versionen löschen?', { name: f.name, n: f.versions.length }))) return;
    if (await act(() => api.del(`/api/office/files/${id}`), t('Gelöscht'))) navigate('office');
  };
  const editorReady = s.editors[f.kind];
  const others = openBy.filter((p) => p.user_id !== session.user.id);

  return (
    <div className={`of-page of-file${mode !== 'closed' ? ' editing' : ''}`}>
      <div className="of-head">
        <Link to="office" className="btn small secondary" label={t('Zurück zu allen Dateien')}>
          <ArrowLeft size={14} aria-hidden="true" /> {t('Alle Dateien')}
        </Link>
        <h1 className="of-title">
          <KindIcon kind={f.kind} size={22} /> {f.name}
          <button className="icon-btn" onClick={() => setRename(true)} aria-label={t('Umbenennen')} title={t('Umbenennen')}>
            <Pencil size={15} aria-hidden="true" />
          </button>
        </h1>
        <span className="of-meta">
          <Badge>{`v${f.version}`}</Badge> {lock && <Badge tone={mine ? 'green' : 'yellow'}>{mine ? t('Von dir ausgecheckt') : t('{name} bearbeitet gerade – schreibgeschützt', { name: lock.user_name })}</Badge>}{' '}
          <Faces list={others} label={t('Gerade geöffnet von {names}', { names: others.map((p) => p.name).join(', ') })} />
        </span>
        <div className="of-actions">
          {mode === 'closed' && editorReady && (
            <>
              <button className="btn" onClick={startEdit} disabled={!!lockedByOther} data-tour="office-edit">
                <Pencil size={16} aria-hidden="true" /> {t('Bearbeiten')}
              </button>
              <button className="btn secondary" onClick={() => setMode('read')}>
                <Lock size={16} aria-hidden="true" /> {t('Schreibgeschützt öffnen')}
              </button>
            </>
          )}
          {mode === 'edit' && (
            <>
              <button className="btn" onClick={() => editor.current?.save()} title={t('Speichert im Editor (wie Strg+S) – als neue Version')}>
                <Save size={16} aria-hidden="true" /> {t('Speichern')}
              </button>
              <button className="btn secondary" onClick={done}>
                {t('Fertig')}
              </button>
            </>
          )}
          {mode === 'read' && (
            <button className="btn secondary" onClick={done}>
              {t('Schließen')}
            </button>
          )}
          <a className="btn secondary" href={`/api/office/files/${id}/download?locationId=${encodeURIComponent(currentLocation())}`} download>
            <Download size={16} aria-hidden="true" /> {t('Herunterladen')}
          </a>
          <button className="btn secondary" onClick={() => upload.current?.click()} disabled={!!lockedByOther}>
            <Upload size={16} aria-hidden="true" /> {t('Neue Version hochladen')}
          </button>
          <input ref={upload} type="file" hidden accept={ACCEPT.split(',').filter((x) => x.includes(f.kind) || x === MIME[f.kind]).join(',')} onChange={(e) => void uploadVersion(e.target.files)} aria-label={t('Neue Version hochladen')} />
          {f.kind !== 'pdf' && s.engines[f.kind] && (
            <button className="btn secondary" onClick={exportPdf}>
              <FileDown size={16} aria-hidden="true" /> {t('Als PDF')}
            </button>
          )}
          <button className="btn secondary danger-text" onClick={remove} disabled={!!lockedByOther} aria-label={t('Datei löschen')}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      {!editorReady && <SetupNote status={s} />}
      {mode === 'edit' && f.kind === 'pptx' && !s.engines.pptx && <p className="of-note small">{t('Zum Speichern im Editor „File → Export → PowerPoint Presentation (.pptx)“ (Menü des Editors) wählen – ohne Office-Engine kann HyperLevel das eigene Format des Editors nicht umwandeln.')}</p>}
      <div className="of-body">
        <div className="of-main">
          {mode !== 'closed' && editorReady ? (
            <OfficeEditor ref={editor} file={f} status={s} readonly={mode === 'read'} onSaved={reload} onExported={() => toast(t('In der Dateiliste zu finden'))} />
          ) : (
            <div className="of-placeholder card">
              <KindIcon kind={f.kind} size={42} />
              <p>
                <strong>{f.name}</strong>
              </p>
              <p className="muted small">
                {t('Version {v} · {size} · zuletzt geändert {when} von {who}', { v: f.version, size: sizeLabel(f.size), when: ago(f.updated_at), who: f.updated_by_name })}
              </p>
              {editorReady ? (
                <p className="muted small">{lockedByOther ? t('{name} bearbeitet die Datei gerade. Du kannst sie schreibgeschützt öffnen.', { name: lockedByOther }) : t('„Bearbeiten“ öffnet den Editor im Browser und sperrt die Datei für andere, bis du auf „Fertig“ klickst.')}</p>
              ) : (
                <p className="muted small">{t('Der Editor ist auf diesem Server nicht installiert – herunterladen, bearbeiten und als neue Version hochladen, oder den KI-Agenten bitten.')}</p>
              )}
            </div>
          )}
        </div>
        <aside className="of-side" aria-label={t('Versionen, Kommentare und KI')}>
          <Tabs
            tabs={[
              ['versions', t('Versionen')],
              ['comments', f.open_comments ? t('Kommentare ({n})', { n: f.open_comments }) : t('Kommentare')],
              ['ai', t('Mit KI bearbeiten')],
              ['links', t('Details')],
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === 'versions' && <Versions file={f} onChange={reload} />}
          {tab === 'comments' && <Comments file={f} />}
          {tab === 'ai' && <AiBox file={f} status={s} lockedByOther={lockedByOther} />}
          {tab === 'links' && <LinksPanel file={f} onChange={reload} />}
        </aside>
      </div>
      {rename && <RenameDialog file={f} onClose={() => setRename(false)} onDone={reload} />}
    </div>
  );
}
