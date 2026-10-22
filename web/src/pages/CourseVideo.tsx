import { useEffect, useRef, useState } from 'react';
import { api, currentLocation, dt } from '../api';
import { Badge, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, toast, toastError, useLoad } from '../ui';
import './CourseDepth.css';
import { getLocale, tr, useT } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';

/**
 * Kurs-Videos: Bibliothek mit Upload in Teilen (fortsetzbar), Vorschau, Titelbild, Untertitel (Datei oder KI), HLS-Umwandlung,
 * und die Felder in der Lektion (Video wählen, Kapitel, „abgeschlossen ab … % gesehen“). Server: modules/course-video.ts, docs/courses.md.
 */

export type Chapter = { t: number; title: string };
export type VideoRow = {
  id: string;
  name: string;
  size: number;
  received: number;
  status: 'open' | 'complete';
  duration_sec: number;
  has_poster: boolean;
  hls: '' | 'pending' | 'ready' | 'failed';
  hls_note: string;
  ai_status: '' | 'running' | 'done' | 'failed';
  ai_note: string;
  created_at: string;
  /** The list gives counts, the detail gives the rows. */
  lessons?: { id: string; title: string; course_id: string; course_title: string }[] | number;
  captions?: { id: string; lang: string; label: string; source: string; created_at: string }[] | number;
};
type VideoDetailRow = Omit<VideoRow, 'lessons' | 'captions'> & { lessons: Exclude<VideoRow['lessons'], number | undefined>; captions: Exclude<VideoRow['captions'], number | undefined> };
const countOf = (x: unknown[] | number | undefined) => (Array.isArray(x) ? x.length : Number(x) || 0);
type MediaInfo = { ffmpeg: boolean; stt: boolean; max_mb: number; chunk_size: number; url_ttl_min: number; auto_hls: boolean };

const two = (n: number) => String(n).padStart(2, '0');
export const mmss = (sec: number) => {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
};
export const chaptersToText = (list: Chapter[] | undefined) => (list ?? []).map((c) => `${mmss(c.t)} ${c.title}`).join('\n');
const dec = (n: string) => (getLocale() === SOURCE_LOCALE ? n.replace('.', ',') : n);
const mb = (n: number) => (n >= 1024 * 1024 * 1024 ? `${dec((n / 1024 / 1024 / 1024).toFixed(1))} GB` : `${dec(Math.max(0.1, n / 1024 / 1024).toFixed(1))} MB`);

export const useMediaInfo = () => useLoad(() => api.get<MediaInfo>('/api/courses/media/info'), []);

// German labels (message ids of the courses catalog), shown through t()
const LANGS: [string, string][] = [['de', 'Deutsch'], ['en', 'Englisch'], ['fr', 'Französisch'], ['es', 'Spanisch'], ['it', 'Italienisch'], ['tr', 'Türkisch'], ['pl', 'Polnisch'], ['nl', 'Niederländisch'], ['pt', 'Portugiesisch'], ['ru', 'Russisch'], ['uk', 'Ukrainisch'], ['ar', 'Arabisch']];

/** Uploads a file in parts. A running upload with the same name and size is continued where the server stopped. */
export async function uploadVideo(file: File, open: VideoRow[], onProgress: (share: number) => void): Promise<string> {
  const t = tr('courses');
  const headers = { 'x-pghl': '1', 'x-location-id': currentLocation(), 'content-type': 'application/octet-stream' };
  let id = open.find((v) => v.status === 'open' && v.name === file.name && v.size === file.size)?.id ?? '';
  let chunk = 8 * 1024 * 1024;
  let offset = 0;
  if (id) offset = (await api.get<VideoRow>(`/api/courses/videos/${id}`)).received;
  else {
    const start = await api.post<{ id: string; chunk_size: number }>('/api/courses/videos', { name: file.name, size: file.size });
    id = start.id;
    chunk = start.chunk_size;
  }
  let failures = 0;
  while (offset < file.size) {
    try {
      const r = await fetch(`/api/courses/videos/${id}/upload?offset=${offset}`, { method: 'PUT', headers, body: file.slice(offset, offset + chunk), credentials: 'same-origin' });
      const body: any = await r.json().catch(() => ({}));
      if (r.status === 409 && typeof body.received === 'number') {
        offset = body.received; // the server is somewhere else: carry on from there
        continue;
      }
      if (!r.ok) throw Object.assign(new Error(body.error || t('Fehler {status}', { status: r.status })), { fatal: true });
      offset = typeof body.received === 'number' ? body.received : offset + chunk;
      failures = 0;
      onProgress(Math.min(1, offset / file.size));
    } catch (e) {
      if ((e as any).fatal || ++failures > 4) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 * failures));
      offset = (await api.get<VideoRow>(`/api/courses/videos/${id}`).catch(() => ({ received: offset }) as VideoRow)).received;
    }
  }
  return id;
}

function VideoBadges({ v }: { v: VideoRow }) {
  const t = useT('courses');
  return (
    <div className="cd-badges">
      {v.status === 'open' && <Badge tone="yellow">{t('Upload unvollständig')}</Badge>}
      {v.status === 'complete' && v.hls === 'ready' && <Badge tone="green">{t('HLS')}</Badge>}
      {v.hls === 'pending' && <Badge tone="blue">{t('HLS wird erzeugt …')}</Badge>}
      {v.hls === 'failed' && <Badge tone="red">{t('HLS fehlgeschlagen')}</Badge>}
      {v.ai_status === 'running' && <Badge tone="blue">{t('KI-Untertitel laufen …')}</Badge>}
      {countOf(v.captions) > 0 && <Badge tone="purple">{countOf(v.captions)} {t('Untertitel')}</Badge>}
      {countOf(v.lessons) > 0 && <Badge>{countOf(v.lessons)} {t('Lektion')}{countOf(v.lessons) === 1 ? '' : 'en'}</Badge>}
    </div>
  );
}

/** Pictures and the preview player cannot send the sub-account header, so the address carries it. */
const media = (path: string, extra = '') => `${path}?locationId=${encodeURIComponent(currentLocation())}${extra}`;

const Thumb = ({ v }: { v: VideoRow }) => {
  const t = useT('courses');
  return <div className="cd-thumb">{v.has_poster ? <img src={media(`/api/courses/videos/${v.id}/poster`, `&x=${v.size}${v.hls}${v.duration_sec}`)} alt="" loading="lazy" /> : <span>{v.status === 'open' ? t('Wird hochgeladen') : t('Kein Titelbild')}</span>}</div>;
};

// --- one video: preview, poster, captions, HLS --------------------------------------------------------------
function VideoDetail({ id, info, onClose, onChanged }: { id: string; info: MediaInfo | undefined; onClose: () => void; onChanged: () => void }) {
  const t = useT('courses');
  const det = useLoad(() => api.get<VideoDetailRow>(`/api/courses/videos/${id}`), [id]);
  const player = useRef<HTMLVideoElement>(null);
  const [name, setName] = useState('');
  const [lang, setLang] = useState('de');
  const [label, setLabel] = useState('');
  const [aiLang, setAiLang] = useState('de');
  const [busy, setBusy] = useState(false);
  const v = det.data;
  useEffect(() => {
    if (v) setName(v.name);
  }, [v?.id]);
  // while ffmpeg or the speech engine works in the background
  useEffect(() => {
    if (!v || (v.hls !== 'pending' && v.ai_status !== 'running')) return;
    const timer = setInterval(() => void det.reload().then(onChanged), 3000);
    return () => clearInterval(timer);
  }, [v?.hls, v?.ai_status]);
  if (!v) return <Modal title={t('Video')} onClose={onClose}>{det.error ? <Empty>{det.error}</Empty> : <Spinner />}</Modal>;
  const run = async (fn: () => Promise<VideoDetailRow>, ok?: string) => {
    setBusy(true);
    const r = await act(fn, ok);
    setBusy(false);
    if (r) {
      det.setData({ ...v, ...r });
      void det.reload();
      onChanged();
    }
  };
  const readFile = (f: File) =>
    new Promise<string>((ok, no) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = () => no(new Error(t('Datei nicht lesbar')));
      r.readAsText(f);
    });
  const addCaption = async (f: File) => {
    if (f.size > 1024 * 1024) return toastError(new Error(t('Die Untertitel-Datei ist größer als 1 MB')));
    const vtt = await readFile(f);
    await run(() => api.post(`/api/courses/videos/${v.id}/captions`, { vtt, lang, label }), t('Untertitel gespeichert'));
    setLabel('');
  };
  const addPoster = (f: File) => {
    const r = new FileReader();
    r.onload = () => void run(() => api.post(`/api/courses/videos/${v.id}/poster`, { data: String(r.result) }), t('Titelbild gespeichert'));
    r.readAsDataURL(f);
  };
  const ready = v.status === 'complete';
  return (
    <Modal title={v.name} onClose={onClose} wide>
      <div className="cd">
        {ready ? (
          <video ref={player} className="cd-player" controls preload="metadata" src={media(`/api/courses/videos/${v.id}/file`)} poster={v.has_poster ? media(`/api/courses/videos/${v.id}/poster`, `&x=${v.duration_sec}`) : undefined} />
        ) : (
          <div className="cd-note">{t('Der Upload ist nicht abgeschlossen ({done} von {total}). Lade dieselbe Datei erneut hoch – es geht an der Stelle weiter, an der es aufgehört hat.', { done: mb(v.received), total: mb(v.size) })}</div>
        )}
        <div className="cd-bar" style={{ marginTop: 10 }}>
          <VideoBadges v={v} />
          <span className="muted small">{mb(v.size)}{v.duration_sec ? ` · ${mmss(v.duration_sec)}` : ''} · {dt(v.created_at)}</span>
        </div>
        <Field label={t('Name')}>
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <Input value={name} onChange={setName} />
            <button className="btn secondary" disabled={busy || !name.trim() || name === v.name} onClick={() => run(() => api.patch(`/api/courses/videos/${v.id}`, { name }), t('Name gespeichert'))}>
              {t('Speichern')}
            </button>
          </div>
        </Field>

        {ready && (
          <>
            <h3 style={{ marginBottom: 4 }}>{t('Titelbild')}</h3>
            <div className="cd-bar">
              <button
                className="btn secondary"
                disabled={busy || !info?.ffmpeg}
                title={info?.ffmpeg ? '' : t('Dafür braucht der Server ffmpeg')}
                onClick={() => run(() => api.post(`/api/courses/videos/${v.id}/poster`, { at: Math.floor(player.current?.currentTime ?? 0) }), t('Titelbild aus dem Video geholt'))}
              >
                {t('Bild an der aktuellen Stelle übernehmen')}
              </button>
              <label className="btn secondary" style={{ cursor: 'pointer' }}>
                {t('Eigenes Bild hochladen')}
                <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => e.target.files?.[0] && addPoster(e.target.files[0])} />
              </label>
            </div>
            {!info?.ffmpeg && <p className="cd-hint">{t('ffmpeg ist auf diesem Server nicht installiert: Titelbilder kommen dann nur per Upload, und das Video wird als MP4 mit Range-Anfragen ausgeliefert.')}</p>}

            <h3 style={{ marginBottom: 4 }}>{t('Untertitel')}</h3>
            {v.captions?.length ? (
              <div className="cd-chips" style={{ marginBottom: 8 }}>
                {v.captions.map((c) => (
                  <span key={c.id} className="cd-chip">
                    {c.label} <span className="muted small">({c.lang}{c.source === 'ai' ? t(', KI') : ''})</span>
                    <button aria-label={t('Untertitel {label} löschen', { label: c.label })} title={t('Löschen')} onClick={() => confirmAsk(t('Untertitel „{label}“ löschen?', { label: c.label })) && run(() => api.del(`/api/courses/videos/${v.id}/captions/${c.id}`), t('Untertitel gelöscht'))}>
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="cd-hint">{t('Noch keine Untertitel. Mitglieder können sie im Player ein- und ausschalten.')}</p>
            )}
            <div className="grid3">
              <Field label={t('Sprache')}>
                <Select value={lang} onChange={setLang} options={LANGS.map(([k, l]) => [k, t(l)] as [string, string])} />
              </Field>
              <Field label={t('Anzeigename (optional)')}>
                <Input value={label} onChange={setLabel} placeholder={t(LANGS.find((l) => l[0] === lang)?.[1] ?? '')} />
              </Field>
              <Field label={t('WebVTT- oder SRT-Datei')}>
                <input type="file" accept=".vtt,.srt,text/vtt" onChange={(e) => (e.target.files?.[0] && void addCaption(e.target.files[0]), (e.target.value = ''))} />
              </Field>
            </div>
            <div className="cd-bar">
              <div style={{ width: 180 }}>
                <Select value={aiLang} onChange={setAiLang} options={LANGS.map(([k, l]) => [k, t(l)] as [string, string])} />
              </div>
              <button
                className="btn secondary"
                disabled={busy || v.ai_status === 'running' || !info?.stt || !info?.ffmpeg}
                title={!info?.stt ? t('Einstellungen → KI-Anbieter: Spracherkennung einrichten') : !info?.ffmpeg ? t('Dafür braucht der Server ffmpeg') : ''}
                onClick={() => run(() => api.post(`/api/courses/videos/${v.id}/captions/ai`, { language: aiLang }), t('Die Transkription läuft – das dauert ein paar Minuten'))}
              >
                {v.ai_status === 'running' ? t('KI schreibt mit …') : t('Untertitel per KI erzeugen')}
              </button>
              {v.ai_status === 'failed' && <span className="muted small" role="status">{t('Zuletzt fehlgeschlagen:')} {v.ai_note}</span>}
            </div>
            {!info?.stt && <p className="cd-hint">{t('KI-Untertitel nutzen die Spracherkennung aus Einstellungen → KI-Anbieter (Fähigkeit „Spracherkennung“). Ohne sie bleibt der Datei-Upload.')}</p>}

            <h3 style={{ marginBottom: 4 }}>{t('Streaming')}</h3>
            <div className="cd-bar">
              <button className="btn secondary" disabled={busy || v.hls === 'pending' || !info?.ffmpeg} onClick={() => run(() => api.post(`/api/courses/videos/${v.id}/hls`), t('Die Umwandlung läuft'))}>
                {v.hls === 'ready' ? t('HLS neu erzeugen') : t('In HLS umwandeln (360p/720p …)')}
              </button>
              {v.hls === 'failed' && <span className="muted small">{v.hls_note}</span>}
            </div>
            <p className="cd-hint">{t('Mit HLS passt sich die Qualität der Verbindung an. Ohne HLS spielt der Player die MP4-Datei direkt – das reicht für die meisten Kurse.')}</p>
          </>
        )}

        {!!v.lessons?.length && (
          <>
            <h3 style={{ marginBottom: 4 }}>{t('Verwendet in')}</h3>
            <ul className="muted small" style={{ marginTop: 0 }}>
              {v.lessons.map((l) => (
                <li key={l.id}>{l.course_title}: {l.title}</li>
              ))}
            </ul>
          </>
        )}
        <div className="actions" style={{ marginTop: 12 }}>
          <button
            className="btn ghost danger-text"
            onClick={async () => {
              if (!confirmAsk(v.lessons?.length ? t.plural(v.lessons.length, { other: 'Video „{name}“ löschen? Es wird aus {n} Lektion(en) entfernt.' }, { name: v.name }) : t('Video „{name}“ löschen?', { name: v.name }))) return;
              if (await act(() => api.del(`/api/courses/videos/${v.id}`), t('Video gelöscht'))) (onChanged(), onClose());
            }}
          >
            {t('Video löschen')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// --- the library ---------------------------------------------------------------------------------------------
export function VideoLibrary({ onClose, onPick, selected }: { onClose: () => void; onPick?: (v: VideoRow) => void; selected?: string | null }) {
  const t = useT('courses');
  const list = useLoad(() => api.get<VideoRow[]>('/api/courses/videos'), []);
  const info = useMediaInfo();
  const [progress, setProgress] = useState<{ name: string; share: number } | null>(null);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const rows = list.data ?? [];
  const working = rows.some((v) => v.hls === 'pending' || v.ai_status === 'running');
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void list.reload(), 3000);
    return () => clearInterval(timer);
  }, [working]);
  const upload = async (f: File) => {
    if (progress) return;
    if (info.data && f.size > info.data.max_mb * 1024 * 1024) return toastError(new Error(t('Das Video ist größer als {n} MB (Grenze: PGHL_COURSE_VIDEO_MB)', { n: info.data.max_mb })));
    setProgress({ name: f.name, share: 0 });
    try {
      await uploadVideo(f, rows, (share) => setProgress({ name: f.name, share }));
      toast(t('Video hochgeladen'));
    } catch (e) {
      toastError(e);
    } finally {
      setProgress(null);
      if (file.current) file.current.value = '';
      await list.reload();
      // ffmpeg reads length and poster right after the upload
      for (const ms of [1500, 4000, 9000]) setTimeout(() => void list.reload(), ms);
    }
  };
  // The detail replaces the list while it is open (one Esc closes one dialog); the upload state stays here.
  if (open) return <VideoDetail id={open} info={info.data} onClose={() => setOpen('')} onChanged={() => void list.reload()} />;
  return (
    <Modal title={onPick ? t('Video wählen') : t('Video-Bibliothek')} onClose={onClose} wide>
      <div className="cd">
        <div
          className={`cd-drop${over ? ' over' : ''}`}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            if (e.dataTransfer.files[0]) void upload(e.dataTransfer.files[0]);
          }}
        >
          {progress ? (
            <>
              <div style={{ marginBottom: 6 }}>{progress.name} – {Math.round(progress.share * 100)} %</div>
              <div className="cd-meter" role="progressbar" aria-valuenow={Math.round(progress.share * 100)} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${progress.share * 100}%` }} />
              </div>
            </>
          ) : (
            <>
              <label className="btn" style={{ cursor: 'pointer' }}>
                {t('Video hochladen')}
                <input ref={file} type="file" accept="video/*,.mkv" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
              </label>
              <p className="cd-hint" style={{ marginBottom: 0 }}>
                {t('oder hierher ziehen. MP4, MOV, WebM, MKV oder Ogg, bis {max}. Große Dateien gehen in Teilen hoch; bricht die Verbindung ab, setzt derselbe Upload dort fort.', { max: info.data ? `${info.data.max_mb} MB` : '…' })}
              </p>
            </>
          )}
        </div>
        {info.data && !info.data.ffmpeg && <div className="cd-note" style={{ marginTop: 12 }}>{t('ffmpeg ist auf diesem Server nicht installiert. Videos laufen trotzdem (MP4 mit Range-Anfragen); Titelbild aus dem Video, HLS und KI-Untertitel brauchen ffmpeg.')}</div>}
        <p className="cd-hint">{t('Mitglieder bekommen nur kurz gültige, persönliche Links ({h} Std.) – das Video lässt sich nicht von fremden Seiten einbetten.', { h: info.data ? Math.round(info.data.url_ttl_min / 60) : '…' })}</p>
        {list.loading && !list.data ? (
          <Spinner />
        ) : !rows.length ? (
          <Empty>{t('Noch keine Videos hochgeladen.')}</Empty>
        ) : (
          <div className="cd-grid">
            {rows.map((v) => (
              <div
                key={v.id}
                className={`cd-card${onPick && v.status === 'complete' ? ' pick' : ''}${selected === v.id ? ' on' : ''}`}
                role={onPick && v.status === 'complete' ? 'button' : undefined}
                tabIndex={onPick && v.status === 'complete' ? 0 : undefined}
                onClick={() => onPick && v.status === 'complete' && onPick(v)}
                onKeyDown={(e) => onPick && v.status === 'complete' && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(v))}
              >
                <Thumb v={v} />
                <h3>{v.name}</h3>
                <VideoBadges v={v} />
                <div className="muted small">
                  {mb(v.size)}
                  {v.duration_sec ? ` · ${mmss(v.duration_sec)}` : ''}
                  {v.status === 'open' ? t(' · {pct} hochgeladen', { pct: getLocale() === SOURCE_LOCALE ? `${Math.round((v.received / v.size) * 100)} %` : `${Math.round((v.received / v.size) * 100)}%` }) : ''}
                </div>
                <div className="actions" style={{ marginTop: 'auto' }}>
                  {onPick && v.status === 'complete' && (
                    <button className="btn small" onClick={(e) => (e.stopPropagation(), onPick(v))}>
                      {t('Wählen')}
                    </button>
                  )}
                  <button className="btn small secondary" onClick={(e) => (e.stopPropagation(), setOpen(v.id))}>
                    {t('Details')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// --- lesson fields -------------------------------------------------------------------------------------------
type LessonVideo = { video_id?: string | null; chapters?: Chapter[] | string; complete_percent?: number };

/** What the lesson editor adds: the hosted video, chapters, and "finished at … % watched". */
export function LessonVideoFields({ lesson, chaptersText, onChange }: { lesson: LessonVideo; chaptersText: string; onChange: (p: { video_id?: string | null; chapters?: string; complete_percent?: number }) => void }) {
  const t = useT('courses');
  const [pick, setPick] = useState(false);
  const [video, setVideo] = useState<VideoRow | null>(null);
  const id = lesson.video_id ?? null;
  useEffect(() => {
    if (!id) return setVideo(null);
    let live = true;
    api.get<VideoRow>(`/api/courses/videos/${id}`).then((v) => live && setVideo(v)).catch(() => live && setVideo(null));
    return () => {
      live = false;
    };
  }, [id]);
  return (
    <div className="cd" data-tour="lesson-video">
      <Field label={t('Gehostetes Video')} hint={t('Eigene Videodatei mit Wiedergabe-Position, Tempo, Untertiteln und persönlichen Links. Hat Vorrang vor dem Link unten.')}>
        <div className="cd-video-field">
          {video ? <Thumb v={video} /> : null}
          <div className="grow">
            {id ? <b>{video?.name ?? t('Video …')}</b> : <span className="muted">{t('Kein Video gewählt')}</span>}
            {video && <div className="muted small">{video.duration_sec ? mmss(video.duration_sec) : ''} <VideoBadges v={video} /></div>}
          </div>
          <button type="button" className="btn secondary small" onClick={() => setPick(true)}>
            {id ? t('Anderes Video') : t('Video wählen oder hochladen')}
          </button>
          {id && (
            <button type="button" className="btn ghost small" onClick={() => onChange({ video_id: null })}>
              {t('Entfernen')}
            </button>
          )}
        </div>
      </Field>
      {id && (
        <div className="grid2">
          <Field label={t('Kapitel')} hint={t('Eine Zeile pro Kapitel: „0:00 Einleitung“. Mitglieder springen im Player dorthin.')}>
            <Textarea value={chaptersText} onChange={(v) => onChange({ chapters: v })} rows={5} placeholder={t('0:00 Einleitung\n2:30 Das Wichtigste\n7:45 Übung')} />
          </Field>
          <Field label={t('Lektion gilt als erledigt ab … % gesehen')} hint={t('Leer oder 0: nur per Klick auf „Abschließen“. Sinnvoll sind 80–95 %.')}>
            <Input type="number" min={0} max={100} value={lesson.complete_percent || ''} onChange={(v) => onChange({ complete_percent: Number(v) || 0 })} placeholder={t('nur per Klick')} />
          </Field>
        </div>
      )}
      {pick && (
        <VideoLibrary
          selected={id}
          onClose={() => setPick(false)}
          onPick={(v) => {
            setPick(false);
            setVideo(v);
            onChange({ video_id: v.id });
          }}
        />
      )}
    </div>
  );
}

