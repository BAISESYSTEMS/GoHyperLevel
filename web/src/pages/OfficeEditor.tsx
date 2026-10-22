import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api';
import { useT } from '../i18n';
import { confirmAsk, toast, toastError } from '../ui';
import { MIME, fetchBytes, postBytes, randomChannel, type OfficeDetail, type OfficeStatus } from './office-kit';

/**
 * The browser editor of one file in a sandboxed iframe (/office/app/<kind>/, served by the server with a strict CSP) and HyperLevel's side
 * of the load/save bridge (server/services/office-bridge-js.ts): when the editor reports "ready", the file's bytes go in (the PDF
 * editor fetches its signed link itself); a save inside the editor comes back as bytes and is stored as a new version; an export of
 * another kind (a PDF of a document) is downloaded and offered to be kept in Office too. Messages are only taken from this iframe and
 * this channel. A save in the presentation editor's own format (.deckcraft) is converted to .pptx on the server. Limits of the bridge:
 * docs/office.md#wie-die-editoren-laden-und-speichern.
 */

export interface EditorHandle {
  save: () => void;
  reload: () => void;
}

type Phase = 'starting' | 'loading' | 'ready' | 'error';

export const OfficeEditor = forwardRef<EditorHandle, { file: OfficeDetail; status: OfficeStatus; readonly: boolean; onSaved: () => void; onExported: () => void }>(function OfficeEditor({ file, status, readonly, onSaved, onExported }, ref) {
  const t = useT('office');
  const frame = useRef<HTMLIFrameElement>(null);
  const [key, setKey] = useState(0);
  const channel = useMemo(() => randomChannel(), [file.id, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [phase, setPhase] = useState<Phase>('starting');
  const [problem, setProblem] = useState('');
  const [exported, setExported] = useState<{ name: string; bytes: ArrayBuffer } | null>(null);
  const sent = useRef(false);
  const version = useRef(file.version);
  version.current = file.version;
  const ro = useRef(readonly);
  ro.current = readonly;

  const post = useCallback(
    (msg: Record<string, unknown>, transfer: Transferable[] = []) => {
      // The sandboxed page has an opaque origin ("null"): it cannot be addressed by origin, so the channel id binds the messages.
      frame.current?.contentWindow?.postMessage({ ...msg, channel, source: 'pghl-office-host' }, '*', transfer);
    },
    [channel],
  );

  useImperativeHandle(ref, () => ({ save: () => post({ type: 'save' }), reload: () => (sent.current = false, setPhase('starting'), setKey((k) => k + 1)) }), [post]);

  const store = useCallback(
    async (bytes: ArrayBuffer, ext: string, force = false) => {
      try {
        // the presentation editor saves its own format (.deckcraft): the server turns it into the file's kind
        const native = ext && ext !== file.kind;
        await postBytes(`/api/office/files/${file.id}/versions${native ? '/convert' : ''}`, bytes, { message: t('Im Editor gespeichert'), base_version: String(version.current), ...(native ? { from: ext } : {}), ...(force ? { force: '1' } : {}) });
        toast(t('Als neue Version gespeichert'));
        onSaved();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && !force && confirmAsk(e.message)) return store(bytes, ext, true);
        toastError(e);
      }
    },
    [file.id, file.kind, onSaved, t],
  );

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data;
      if (!d || d.channel !== channel || d.source !== 'pghl-office') return;
      if (d.type === 'ready') {
        if (file.kind === 'pdf' || sent.current) return setPhase('ready');
        sent.current = true;
        setPhase('loading');
        try {
          const bytes = await fetchBytes(file.id, file.version);
          post({ type: 'load', name: file.name, mime: MIME[file.kind], bytes }, [bytes]);
        } catch (err) {
          setPhase('error');
          setProblem((err as Error).message);
        }
      } else if (d.type === 'loaded') setPhase('ready');
      else if (d.type === 'saved' && d.bytes instanceof ArrayBuffer) {
        if (ro.current) toast(t('Schreibgeschützt geöffnet – nicht gespeichert'));
        else await store(d.bytes, String(d.ext || file.kind));
      } else if (d.type === 'exported' && d.bytes instanceof ArrayBuffer) setExported({ name: String(d.name || 'export'), bytes: d.bytes });
      else if (d.type === 'error') setProblem(String(d.message || ''));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [channel, file.id, file.kind, file.name, file.version, post, store, t]);

  const keepExport = async () => {
    if (!exported) return;
    const ext = exported.name.toLowerCase().split('.').pop() ?? '';
    if (!['docx', 'xlsx', 'pptx', 'pdf'].includes(ext)) {
      toastError(new Error(t('Nur .docx, .xlsx, .pptx und .pdf lassen sich in Office ablegen')));
      return;
    }
    try {
      await postBytes('/api/office/files', exported.bytes, { name: exported.name, kind: ext, ...(file.contact_id ? { contact_id: file.contact_id } : {}), ...(file.deal_id ? { deal_id: file.deal_id } : {}) });
      toast(t('In Office abgelegt'));
      setExported(null);
      onExported();
    } catch (e) {
      toastError(e);
    }
  };

  // fixed per channel: a fresh signed PDF link after a save must not reload the editor
  const src = useMemo(() => {
    const base = `/office/app/${file.kind}/`;
    return file.kind === 'pdf' && file.editor_file_url ? `${base}?file=${encodeURIComponent(file.editor_file_url)}#c=${channel}` : `${base}#c=${channel}`;
  }, [channel]); // eslint-disable-line react-hooks/exhaustive-deps
  // strict (default): no allow-same-origin – the editor's code gets an opaque origin and cannot reach HyperLevel's API or cookies
  const sandbox = status.sandbox === 'same-origin' ? 'allow-scripts allow-same-origin allow-downloads' : 'allow-scripts allow-downloads';
  return (
    <div className="of-editor">
      {phase !== 'ready' && (
        <div className="of-editor-state" role="status">
          {phase === 'error' ? t('Die Datei konnte nicht in den Editor geladen werden: {msg}', { msg: problem }) : phase === 'loading' ? t('Datei wird in den Editor geladen …') : t('Editor startet …')}
        </div>
      )}
      {problem && phase === 'ready' && <div className="of-editor-state warn">{t('Meldung des Editors: {msg}', { msg: problem })}</div>}
      {exported && (
        <div className="of-editor-state">
          {t('„{name}“ wurde heruntergeladen.', { name: exported.name })}{' '}
          <button className="btn small" onClick={keepExport}>
            {t('Auch in Office ablegen')}
          </button>{' '}
          <button className="btn small secondary" onClick={() => setExported(null)}>
            {t('Nein, danke')}
          </button>
        </div>
      )}
      <iframe key={key} ref={frame} className="of-frame" src={src} sandbox={sandbox} allow="fullscreen; clipboard-read; clipboard-write" title={t('Editor: {name}', { name: file.name })} />
    </div>
  );
});
