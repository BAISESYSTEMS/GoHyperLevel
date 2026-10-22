import { useRef, useState } from 'react';
import { Icon } from '../icons';
import { api } from '../api';
import { Empty, Input, Modal, Spinner, act, useLoad } from '../ui';
import { GenImageButton } from './GenMediaKit';
import { tr, useT } from '../i18n';

/** Building blocks shared by the blog and course editors: uploads, images, Markdown, downloads. */

export type Upload = { id: string; name: string; url: string; mime: string; size: number; created_at: string };

const IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp';
const FILE_TYPES = `${IMAGE_TYPES},application/pdf`;

export async function uploadFile(file: File): Promise<Upload | undefined> {
  const t = tr('core');
  if (file.size > 8 * 1024 * 1024) {
    await act(() => Promise.reject(new Error(t('Datei größer als 8 MB'))));
    return undefined;
  }
  const data = await new Promise<string>((r) => {
    const fr = new FileReader();
    fr.onload = () => r(String(fr.result));
    fr.readAsDataURL(file);
  });
  return act(() => api.post<Upload>('/api/uploads', { name: file.name, data }));
}

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Browse the sub-account's uploads (images only or all files). */
export function UploadsModal({ images, onPick, onClose }: { images?: boolean; onPick: (u: Upload) => void; onClose: () => void }) {
  const t = useT('core');
  const list = useLoad(() => api.get<Upload[]>('/api/uploads'), []);
  const [q, setQ] = useState('');
  const items = (list.data ?? []).filter((u) => (!images || u.mime.startsWith('image/')) && u.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title={images ? t('Bild aus Uploads wählen') : t('Datei aus Uploads wählen')} onClose={onClose} wide>
      <Input value={q} onChange={setQ} placeholder={t('Suchen…')} autoFocus />
      {list.loading && !list.data ? (
        <Spinner />
      ) : items.length ? (
        <div className="upload-grid">
          {items.map((u) => (
            <button key={u.id} type="button" className="upload-tile" onClick={() => (onPick(u), onClose())} title={u.name}>
              {u.mime.startsWith('image/') ? <img src={u.url} alt="" loading="lazy" /> : <span className="upload-doc"><Icon name="doc" size={28} /></span>}
              <span className="upload-name">{u.name}</span>
              <span className="muted small">{kb(u.size)}</span>
            </button>
          ))}
        </div>
      ) : (
        <Empty>{q ? t('Nichts gefunden.') : t('Noch keine Uploads.')}</Empty>
      )}
    </Modal>
  );
}

/** Image URL with preview, upload and "choose from uploads". */
export function ImagePicker({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  const t = useT('core');
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="image-picker">
      {value ? <img src={value} alt="" className="image-preview" /> : <div className="image-preview empty"><Icon name="image" size={22} /></div>}
      <div className="grow">
        <Input value={value} onChange={onChange} placeholder={t('https://… oder hochladen')} />
        <div className="actions" style={{ marginTop: 6 }}>
          <button type="button" className="btn small secondary" disabled={busy} onClick={() => file.current?.click()}>
            {busy ? t('Lädt…') : t('Hochladen')}
          </button>
          <button type="button" className="btn small secondary" onClick={() => setPick(true)}>
            {t('Aus Uploads')}
          </button>
          <GenImageButton label={t('KI-Bild')} onPick={(u) => onChange(u.url)} />
          {value && (
            <button type="button" className="btn small ghost" onClick={() => onChange('')}>
              {t('Entfernen')}
            </button>
          )}
        </div>
        <input
          ref={file}
          type="file"
          accept={IMAGE_TYPES}
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setBusy(true);
            const u = await uploadFile(f);
            setBusy(false);
            if (u) onChange(u.url);
          }}
        />
      </div>
      {pick && <UploadsModal images onPick={(u) => onChange(u.url)} onClose={() => setPick(false)} />}
    </div>
  );
}

/** Markdown textarea with a small toolbar (bold, heading, list, link, image, video…). */
/** `label` names the text area: a surrounding <Field> label would name the first toolbar button instead. */
export function MarkdownEditor({ value, onChange, rows = 16, placeholder, label = 'Text (Markdown)' }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; label?: string }) {
  const t = useT('core');
  const ref = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [pick, setPick] = useState(false);
  const select = (start: number, end: number) =>
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(start, end);
    });
  const wrap = (before: string, after = before, fallback = t('Text')) => {
    const ta = ref.current;
    const s = ta?.selectionStart ?? value.length;
    const e = ta?.selectionEnd ?? value.length;
    const sel = value.slice(s, e) || fallback;
    onChange(value.slice(0, s) + before + sel + after + value.slice(e));
    select(s + before.length, s + before.length + sel.length);
  };
  const prefix = (p: string | ((i: number) => string)) => {
    const ta = ref.current;
    const s = ta?.selectionStart ?? value.length;
    const e = ta?.selectionEnd ?? value.length;
    const start = value.lastIndexOf('\n', s - 1) + 1;
    const lines = value.slice(start, e).split('\n');
    const next = lines.map((l, i) => (typeof p === 'function' ? p(i) : p) + l).join('\n');
    onChange(value.slice(0, start) + next + value.slice(e));
    select(start, start + next.length);
  };
  const insertBlock = (text: string) => {
    const ta = ref.current;
    const at = ta?.selectionEnd ?? value.length;
    const before = value.slice(0, at);
    const pad = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
    const out = `${pad}${text}\n\n`;
    onChange(before + out + value.slice(at));
    select(at + out.length, at + out.length);
  };
  const tools: [string, string, () => void][] = [
    ['B', t('Fett'), () => wrap('**')],
    ['I', t('Kursiv'), () => wrap('*')],
    ['H2', t('Zwischenüberschrift'), () => prefix('## ')],
    ['H3', t('Kleine Überschrift'), () => prefix('### ')],
    ['•', t('Liste'), () => prefix('- ')],
    ['1.', t('Nummerierte Liste'), () => prefix((i) => `${i + 1}. `)],
    ['❝', t('Zitat'), () => prefix('> ')],
    ['🔗', t('Link'), () => {
      const url = window.prompt(t('Link-Adresse (https://…)'));
      if (url) wrap('[', `](${url.trim()})`, t('Linktext'));
    }],
    ['▶', t('Video (YouTube, Vimeo, Loom, MP4)'), () => {
      const url = window.prompt(t('Video-Link (YouTube, Vimeo, Loom oder https://….mp4)'));
      if (url) insertBlock(url.trim());
    }],
    ['—', t('Trennlinie'), () => insertBlock('---')],
  ];
  return (
    <div className="md-editor">
      <div className="md-toolbar">
        {tools.map(([label, title, fn]) => (
          <button key={title} type="button" title={title} aria-label={title} onClick={fn}>
            {label}
          </button>
        ))}
        <button type="button" title={t('Bild hochladen')} aria-label={t('Bild hochladen')} onClick={() => file.current?.click()}>
          <Icon name="image" size={14} />
        </button>
        <button type="button" title={t('Bild aus Uploads')} aria-label={t('Bild aus Uploads')} onClick={() => setPick(true)}>
          <Icon name="file" size={14} />
        </button>
        <input
          ref={file}
          type="file"
          accept={IMAGE_TYPES}
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            const u = f && (await uploadFile(f));
            if (u) insertBlock(`![${u.name.replace(/\.[a-z0-9]+$/i, '')}](${u.url})`);
          }}
        />
      </div>
      <textarea ref={ref} value={value} onChange={(e) => onChange(e.target.value)} rows={rows} placeholder={placeholder} className="md-area" aria-label={label} />
      <small className="muted">
        {t('Markdown: **fett**, *kursiv*, ## Überschrift, - Liste, [Link](https://…), ![Bild](https://…) – eine Zeile nur mit einem YouTube-/Vimeo-Link wird zum Video.')}
      </small>
      {pick && <UploadsModal images onPick={(u) => insertBlock(`![${u.name.replace(/\.[a-z0-9]+$/i, '')}](${u.url})`)} onClose={() => setPick(false)} />}
    </div>
  );
}

export type Download = { upload_id: string; name: string };

/** Files attached to a lesson (PDF, images) – from the uploads. */
export function DownloadsField({ value, onChange }: { value: Download[]; onChange: (v: Download[]) => void }) {
  const t = useT('core');
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const add = (u: Upload) => !value.some((d) => d.upload_id === u.id) && onChange([...value, { upload_id: u.id, name: u.name }]);
  return (
    <div className="downloads">
      {value.map((d, i) => (
        <div key={d.upload_id} className="download-row">
          <Icon name="download" />
          <input value={d.name} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label={t('Anzeigename')} />
          <button type="button" className="icon-btn" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t('Entfernen')}>
            ✕
          </button>
        </div>
      ))}
      <div className="actions">
        <button type="button" className="btn small secondary" disabled={busy} onClick={() => file.current?.click()}>
          {busy ? t('Lädt…') : t('+ Datei hochladen')}
        </button>
        <button type="button" className="btn small secondary" onClick={() => setPick(true)}>
          {t('Aus Uploads')}
        </button>
        <span className="muted small">{t('PDF oder Bild, max. 8 MB – nur für Mitglieder mit Zugang abrufbar.')}</span>
      </div>
      <input
        ref={file}
        type="file"
        accept={FILE_TYPES}
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setBusy(true);
          const u = await uploadFile(f);
          setBusy(false);
          if (u) add(u);
        }}
      />
      {pick && <UploadsModal onPick={add} onClose={() => setPick(false)} />}
    </div>
  );
}

/** ISO ↔ value of <input type="datetime-local"> in the browser's time zone. */
export const toLocalInput = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
