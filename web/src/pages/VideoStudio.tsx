import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, ago, api, currentLocation } from '../api';
import { Icon, type IconName } from '../icons';
import { useSession } from '../session';
import { Badge, Check, Copy, Empty, Field, Input, Link, MergeHint, Modal, PageHead, Select, Spinner, Tabs, Textarea, act, confirmAsk, navigate, toast, toastError, useLoad } from '../ui';
import { ChannelAvatar } from './Social';
import { Autopilot, Recycling, captureThumb } from './VideoRecycle';
import { SignupLink } from '../referrals';

/**
 * Video-Studio (Marketing): long video → AI-picked 9:16 shorts via OpenShorts → review → Social
 * Planner. Also the agency card (Agentur → Integrationen → Einrichtung) and the workflow step.
 * Content-Recycling and the Autopilot live in VideoRecycle.tsx.
 */

type Tone = 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'purple';
const ACTIVE = ['uploading', 'submitting', 'queued', 'processing', 'finishing'];
const STATUS_TONE: Record<string, Tone> = { uploading: 'blue', submitting: 'blue', confirm: 'yellow', queued: 'gray', processing: 'blue', finishing: 'purple', completed: 'green', failed: 'red' };
// Same keys as the server (services/openshorts.ts); labels for the workflow step, which loads nothing.
const LAYOUTS: [string, string][] = [
  ['auto', 'Automatisch (KI wählt)'],
  ['track', 'Gesicht verfolgen'],
  ['general', 'Ganzes Bild (unscharfer Rand)'],
  ['split', 'Zwei Sprecher übereinander'],
  ['screencast', 'Bildschirm + Sprecher'],
];
const SUBTITLES: [string, string][] = [
  ['default', 'Standard'],
  ['hormozi', 'Wort für Wort'],
  ['pill', 'Lila Box'],
  ['lime', 'Grüne Box'],
  ['oneword', 'Ein großes Wort'],
  ['clean', 'Dezent'],
  ['off', 'Keine'],
];
const FRAMINGS: [string, string][] = [
  ['full', 'Ganzes Bild (unscharfer Hintergrund)'],
  ['track', 'Person verfolgen (Zuschnitt)'],
  ['auto', 'Automatisch'],
];

interface Studio {
  configured: boolean;
  mode: 'hosted' | 'selfhosted' | null;
  features: Record<string, boolean>;
  youtube_urls: boolean;
  retention_hours: number | null;
  dubbing: boolean;
  ai_shorts: boolean;
  languages: Record<string, string>;
  layouts: Record<string, string>;
  subtitle_styles: Record<string, string>;
  hook_styles: Record<string, string>;
  formats: Record<string, string>;
  max_upload_mb: number;
  chunk_size: number;
  public_base: boolean;
  social: boolean;
  error: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const mediaSrc = (url: string, extra = '') => `${url}?locationId=${encodeURIComponent(currentLocation())}${extra}`;
const scoreTone = (s: number | null) => (s === null ? 'none' : s >= 80 ? 'hot' : s >= 60 ? 'good' : 'low');
const hours = (h: number) => (h >= 48 && h % 24 === 0 ? `${h / 24} Tage` : `${h} Std.`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Re-load while something runs on the OpenShorts side. */
function usePoll(active: boolean, reload: () => unknown, ms = 4000) {
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void reload(), ms);
    return () => clearInterval(t);
  }, [active, reload, ms]);
}

/** One part of a chunked upload (XHR for the progress bar). */
function putChunk(uploadId: string, offset: number, part: Blob, onLoaded: (n: number) => void): Promise<{ received: number }> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `/api/video-studio/uploads/${uploadId}?offset=${offset}`);
    x.setRequestHeader('x-pghl', '1');
    x.setRequestHeader('x-location-id', currentLocation());
    x.setRequestHeader('content-type', 'application/octet-stream');
    x.upload.onprogress = (e) => onLoaded(e.loaded);
    x.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(x.responseText);
      } catch {
        /* not JSON */
      }
      if (x.status >= 200 && x.status < 300) resolve(data);
      else reject(new ApiError(x.status, data?.error ?? `Fehler ${x.status}`));
    };
    x.onerror = () => reject(new ApiError(0, 'Verbindung unterbrochen'));
    x.send(part);
  });
}

/** Uploads a video in parts (resumes a part up to 3 times) and returns the upload id. */
export async function uploadVideo(file: File, onProgress: (share: number) => void): Promise<string> {
  const start = await api.post<{ id: string; chunk_size: number }>('/api/video-studio/uploads', { name: file.name, size: file.size, type: file.type });
  let offset = 0;
  while (offset < file.size) {
    const part = file.slice(offset, offset + start.chunk_size);
    for (let tries = 1; ; tries++) {
      try {
        const base = offset;
        const r = await putChunk(start.id, offset, part, (n) => onProgress(Math.min(1, (base + n) / file.size)));
        offset = r.received;
        break;
      } catch (e) {
        const status = (e as ApiError).status;
        if (tries >= 3 || (status >= 400 && status < 500 && status !== 409)) throw e;
        await sleep(1500 * tries);
      }
    }
  }
  onProgress(1);
  return start.id;
}

function DropZone({ file, onFile, maxMb }: { file: File | null; onFile: (f: File | null) => void; maxMb: number }) {
  const [over, setOver] = useState(false);
  const take = (f?: File | null) => {
    if (!f) return;
    if (f.size > maxMb * 1024 * 1024) return toastError(`Datei größer als ${maxMb} MB`);
    onFile(f);
  };
  return (
    <label
      className={`vs-drop${over ? ' over' : ''}${file ? ' has' : ''}`}
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files?.[0]);
      }}
    >
      <input type="file" accept="video/*,.mkv,.mov,.m4v" onChange={(e) => take(e.target.files?.[0])} />
      <Icon name="upload" size={20} />
      {file ? (
        <span>
          <strong>{file.name}</strong> <span className="muted small">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
        </span>
      ) : (
        <span>
          Video hierher ziehen oder <u>auswählen</u>
          <br />
          <span className="muted small">MP4, MOV, WebM, MKV – bis {maxMb >= 1024 ? `${(maxMb / 1024).toFixed(maxMb % 1024 ? 1 : 0)} GB` : `${maxMb} MB`}</span>
        </span>
      )}
    </label>
  );
}

function Progress({ value, label }: { value: number; label?: ReactNode }) {
  return (
    <div className="vs-progress">
      <div className="bar">
        <div style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </div>
      {label && <span className="muted small">{label}</span>}
    </div>
  );
}

// --- page --------------------------------------------------------------------------------------

export function VideoStudio({ path = [] }: { path?: string[] }) {
  const session = useSession();
  const st = useLoad(() => api.get<Studio>('/api/video-studio'), []);
  if (st.error) return <Empty>{st.error}</Empty>;
  if (!st.data) return <Spinner />;
  const s = st.data;
  const head = <PageHead title="Video-Studio" sub="Aus langen Videos werden KI-gewählte Shorts mit Untertiteln – prüfen, anpassen und direkt im Social Planner einplanen." />;
  if (!s.configured)
    return (
      <>
        {head}
        <div className="card vs-setup-hint">
          <Icon name="studio" size={28} />
          <h2>Noch nicht verbunden</h2>
          <p className="muted">Das Video-Studio schneidet über OpenShorts – selbst gehostet neben HyperLevel oder über openshorts.app.</p>
          {session.user.role === 'admin' ? (
            <button className="btn" onClick={() => navigate('agency/integrations/setup')}>
              OpenShorts verbinden
            </button>
          ) : (
            <p className="muted small">Die Agentur richtet das unter Integrationen ein.</p>
          )}
        </div>
      </>
    );
  const [sub] = path;
  const tab = sub === 'youtube' || sub === 'ugc' || sub === 'autopilot' ? sub : 'jobs';
  const jobId = sub && tab === 'jobs' ? sub : undefined;
  // YouTube-Studio also shows the descriptions taken over from Content-Recycling.
  const tabs: [string, string][] = [['jobs', 'Shorts aus Videos'], ['autopilot', 'Autopilot'], ['youtube', 'YouTube-Studio']];
  if (s.features.ai_shorts) tabs.push(['ugc', 'KI-Shorts']);
  return (
    <>
      {head}
      {s.error && <p className="vs-warn">OpenShorts meldet: {s.error}</p>}
      {jobId ? (
        <JobDetail id={jobId} studio={s} />
      ) : (
        <>
          {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={(v) => navigate(v === 'jobs' ? 'video-studio' : `video-studio/${v}`)} />}
          {tab === 'jobs' && <Jobs studio={s} />}
          {tab === 'youtube' && <YoutubeStudio studio={s} />}
          {tab === 'ugc' && <UgcStudio studio={s} />}
          {tab === 'autopilot' && <Autopilot publicBase={s.public_base} layouts={LAYOUTS} subtitles={SUBTITLES} />}
        </>
      )}
    </>
  );
}

// --- jobs ----------------------------------------------------------------------------------------

function Jobs({ studio }: { studio: Studio }) {
  const jobs = useLoad(() => api.get<any[]>('/api/video-studio/jobs'), []);
  const active = !!jobs.data?.some((j) => ACTIVE.includes(j.status));
  usePoll(active, jobs.reload);
  return (
    <div className="vs-layout">
      <NewJob studio={studio} onCreated={jobs.reload} />
      <div className="card vs-jobs" data-tour="vs-jobs">
        <div className="vs-jobs-head">
          <h2>Jobs</h2>
          {active && <span className="muted small">aktualisiert sich selbst</span>}
        </div>
        {!jobs.data ? (
          <Spinner />
        ) : jobs.data.length ? (
          jobs.data.map((j) => <JobRow key={j.id} j={j} />)
        ) : (
          <Empty>Noch keine Shorts. Link einfügen oder Video hochladen – OpenShorts sucht die besten Momente.</Empty>
        )}
      </div>
    </div>
  );
}

function JobRow({ j }: { j: any }) {
  const icon: IconName = j.source_type === 'upload' ? 'upload' : j.source_type === 'ugc' ? 'sparkles' : 'link';
  const running = ACTIVE.includes(j.status);
  return (
    <button type="button" className="vs-job" onClick={() => navigate(`video-studio/${j.id}`)}>
      <span className="vs-job-icon">
        <Icon name={icon} />
      </span>
      <span className="vs-job-main">
        <strong>{j.title}</strong>
        <span className="muted small">
          {ago(j.created_at)}
          {j.origin && j.origin !== 'manuell' ? ` · über ${j.origin}` : ''}
          {j.clips_count ? ` · ${j.clips_count} ${j.clips_count === 1 ? 'Clip' : 'Clips'}` : ''}
          {j.best_score !== null && j.best_score !== undefined ? ` · bester Score ${j.best_score}` : ''}
          {j.planned_count ? ` · ${j.planned_count} eingeplant` : ''}
        </span>
        {running && <Progress value={j.progress} label={j.stage} />}
        {j.status === 'confirm' && <span className="small vs-warn-text">{j.stage}</span>}
        {j.status === 'failed' && j.error && <span className="small vs-error-text">{j.error}</span>}
      </span>
      <Badge tone={STATUS_TONE[j.status] ?? 'gray'}>{j.status_label}</Badge>
    </button>
  );
}

function NewJob({ studio, onCreated }: { studio: Studio; onCreated: () => void }) {
  const [mode, setMode] = useState<'url' | 'file'>('url');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [o, setO] = useState({ clips: '', length: '', layout: 'auto', subtitles: 'default', hook: true, hook_style: 'pill', dub_language: '', format: 'vertical' });
  const [more, setMore] = useState(false);
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const set = (p: Partial<typeof o>) => setO({ ...o, ...p });
  const ready = rights && (mode === 'url' ? /^https?:\/\/\S+$/i.test(url.trim()) : !!file);
  const submit = async () => {
    setBusy(true);
    try {
      let upload_id: string | undefined;
      if (mode === 'file' && file) {
        setProgress(0);
        upload_id = await uploadVideo(file, setProgress);
      }
      const [min_seconds, max_seconds] = o.length ? o.length.split('-').map(Number) : [undefined, undefined];
      const { length: _len, ...rest } = o;
      await api.post('/api/video-studio/jobs', { url: mode === 'url' ? url.trim() : undefined, upload_id, title: title.trim() || undefined, options: { ...rest, min_seconds, max_seconds, clips: o.clips ? Number(o.clips) : undefined, dub_language: o.dub_language || undefined } });
      toast(mode === 'file' ? 'Hochgeladen – OpenShorts legt los' : 'Job gestartet');
      setUrl('');
      setFile(null);
      setTitle('');
      onCreated();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };
  const ytBlocked = mode === 'url' && !studio.youtube_urls && /youtu\.?be/i.test(url);
  return (
    <div className="card vs-new" data-tour="vs-new">
      <h2>Neue Shorts</h2>
      <div className="vs-seg" role="tablist">
        <button type="button" className={mode === 'url' ? 'on' : ''} onClick={() => setMode('url')}>
          <Icon name="link" /> Link
        </button>
        <button type="button" className={mode === 'file' ? 'on' : ''} onClick={() => setMode('file')}>
          <Icon name="upload" /> Datei
        </button>
      </div>
      {mode === 'url' ? (
        <Field label="Video-Link" hint={ytBlocked ? <span className="vs-error-text">Diese OpenShorts-Instanz nimmt keine YouTube-Links an – bitte die Datei hochladen.</span> : 'YouTube-Video oder direkte Videodatei (MP4)'}>
          <Input value={url} onChange={setUrl} placeholder="https://www.youtube.com/watch?v=…" inputMode="url" />
        </Field>
      ) : (
        <DropZone file={file} onFile={setFile} maxMb={studio.max_upload_mb} />
      )}
      <Field label="Titel (optional)">
        <Input value={title} onChange={setTitle} placeholder="z. B. Podcast Folge 12" />
      </Field>
      <div className="grid2">
        <Field label="Anzahl Clips">
          <Select value={o.clips} onChange={(v) => set({ clips: v })} options={[['', 'KI entscheidet'], ...Array.from({ length: 10 }, (_, i) => [String(i + 1), String(i + 1)] as [string, string])]} />
        </Field>
        <Field label="Untertitel">
          <Select value={o.subtitles} onChange={(v) => set({ subtitles: v })} options={Object.entries(studio.subtitle_styles).map(([k, l]) => [k, l])} />
        </Field>
      </div>
      <button type="button" className="btn small ghost vs-more" onClick={() => setMore(!more)} aria-expanded={more}>
        {more ? '▾' : '▸'} Weitere Optionen
      </button>
      {more && (
        <div className="vs-more-box">
          <div className="grid2">
            <Field label="Layout">
              <Select value={o.layout} onChange={(v) => set({ layout: v })} options={Object.entries(studio.layouts).map(([k, l]) => [k, l])} />
            </Field>
            <Field label="Clip-Länge">
              <Select value={o.length} onChange={(v) => set({ length: v })} options={[['', 'Standard (15–60 s)'], ['15-30', '15–30 s'], ['30-60', '30–60 s'], ['45-90', '45–90 s'], ['60-180', '1–3 Min.']]} />
            </Field>
          </div>
          <div className="grid2">
            <Field label="Format">
              <Select value={o.format} onChange={(v) => set({ format: v })} options={Object.entries(studio.formats).map(([k, l]) => [k, l])} />
            </Field>
            <Field label="Hook-Stil">
              <Select value={o.hook_style} onChange={(v) => set({ hook_style: v })} options={Object.entries(studio.hook_styles).map(([k, l]) => [k, l])} />
            </Field>
          </div>
          <Check checked={o.hook} onChange={(v) => set({ hook: v })} label="Hook-Text in den ersten Sekunden einblenden" />
          {studio.dubbing ? (
            <Field label="KI-Vertonung (ElevenLabs)" hint="Die Sprache des Videos erkennt OpenShorts selbst; vertont wird danach in die gewählte Sprache.">
              <Select value={o.dub_language} onChange={(v) => set({ dub_language: v })} options={[['', 'Keine – Originalton'], ...Object.entries(studio.languages).map(([k, l]) => [k, l] as [string, string])]} />
            </Field>
          ) : (
            <p className="muted small">Sprache: erkennt OpenShorts automatisch. KI-Vertonung gibt es mit einem ElevenLabs-Schlüssel (Agentur → Integrationen).</p>
          )}
        </div>
      )}
      <Check checked={rights} onChange={setRights} label="Ich habe die Rechte an diesem Video" tour="vs-rights" />
      {progress !== null && <Progress value={progress * 100} label={`Hochladen … ${Math.round(progress * 100)} %`} />}
      <button className="btn vs-go" disabled={!ready || busy || ytBlocked} onClick={submit}>
        <Icon name="studio" /> {busy ? (progress !== null ? 'Lädt hoch …' : 'Startet …') : 'Shorts erstellen'}
      </button>
      <p className="muted small vs-note">
        {studio.mode === 'hosted' ? 'Läuft auf openshorts.app (GPU, etwa 1 Minute je 8 Minuten Video).' : 'Läuft auf eurem Server: rechnet mit 5–8 Minuten je 8 Minuten Video.'}
        {studio.retention_hours ? ` Clips liegen ${hours(studio.retention_hours)} in OpenShorts – rechtzeitig einplanen oder herunterladen.` : ''}
      </p>
    </div>
  );
}

// --- job detail + clip review -----------------------------------------------------------------------

function JobDetail({ id, studio }: { id: string; studio: Studio }) {
  const job = useLoad(() => api.get<any>(`/api/video-studio/jobs/${id}`), [id]);
  const j = job.data;
  const running = !!j && (ACTIVE.includes(j.status) || j.clips?.some((c: any) => c.pending));
  usePoll(running, job.reload);
  const [edit, setEdit] = useState<any>(null);
  const [plan, setPlan] = useState<any>(null);
  const focus = useMemo(() => new URLSearchParams(location.search).get('clip'), []);
  const [view, setView] = useState(() => (new URLSearchParams(location.search).get('tab') === 'recycling' ? 'recycling' : 'clips'));
  const switchView = (v: string) => {
    setView(v);
    history.replaceState(null, '', v === 'recycling' ? `${location.pathname}?tab=recycling` : location.pathname);
  };
  useEffect(() => {
    if (focus && j) document.getElementById(`clip-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [focus, !!j]);
  if (job.error) return <Empty action={<Link to="video-studio">Zurück zu allen Jobs</Link>}>{job.error}</Empty>;
  if (!j) return <Spinner />;
  const refresh = async () => {
    const r = await act(() => api.post(`/api/video-studio/jobs/${id}/refresh`));
    if (r) job.setData(r);
  };
  const remove = async () => {
    if (!confirmAsk('Job und Clips aus dem Video-Studio entfernen? Eingeplante Posts bleiben im Social Planner.')) return;
    if (await act(() => api.del(`/api/video-studio/jobs/${id}`), 'Gelöscht')) navigate('video-studio');
  };
  const confirmLow = async () => {
    const r = await act(() => api.post(`/api/video-studio/jobs/${id}/confirm`), 'Gestartet');
    if (r) job.setData(r);
  };
  const opts = j.options ?? {};
  return (
    <>
      <div className="card vs-head">
        <Link to="video-studio" className="vs-back">
          ← Alle Jobs
        </Link>
        <div className="vs-head-row">
          <div className="vs-head-main">
            <h2>{j.title}</h2>
            <div className="muted small">
              {j.source_type === 'url' && j.source_url ? (
                <a href={j.source_url} target="_blank" rel="noreferrer noopener">
                  Quelle öffnen <Icon name="external" size={12} />
                </a>
              ) : j.source_type === 'ugc' ? (
                'KI-Short'
              ) : (
                j.source_name
              )}
              {' · '}
              {ago(j.created_at)}
              {j.kind === 'clips' && ` · ${LAYOUTS.find((l) => l[0] === opts.layout)?.[1] ?? 'Automatisch'} · Untertitel: ${SUBTITLES.find((l) => l[0] === opts.subtitles)?.[1] ?? 'Standard'}`}
              {opts.dub_language ? ` · vertont: ${opts.dub_language}` : ''}
            </div>
          </div>
          <Badge tone={STATUS_TONE[j.status] ?? 'gray'}>{j.status_label}</Badge>
        </div>
        {ACTIVE.includes(j.status) && <Progress value={j.progress} label={j.stage} />}
        {j.status === 'confirm' && (
          <p className="vs-warn">
            {j.stage}{' '}
            <button className="btn small" onClick={confirmLow}>
              Trotzdem verarbeiten
            </button>
          </p>
        )}
        {j.status === 'failed' && <p className="vs-error-text">{j.error}</p>}
        <div className="vs-head-actions">
          {['queued', 'processing'].includes(j.status) && (
            <button className="btn small secondary" onClick={refresh}>
              <Icon name="refresh" /> Status abrufen
            </button>
          )}
          <button className="btn small ghost" onClick={remove}>
            <Icon name="trash" /> Löschen
          </button>
        </div>
      </div>
      {j.kind === 'clips' && j.status === 'completed' && <Tabs tabs={[['clips', `Clips (${j.clips?.length ?? 0})`], ['recycling', 'Recycling']]} value={view} onChange={switchView} />}
      {view === 'recycling' && j.kind === 'clips' && j.status === 'completed' ? (
        <Recycling job={j} />
      ) : j.clips?.length ? (
        <div className="vs-grid">
          {j.clips.map((c: any) => (
            <ClipCard key={c.id} c={c} focus={focus === c.id} studio={studio} onEdit={() => setEdit(c)} onPlan={() => setPlan(c)} onChange={job.reload} />
          ))}
        </div>
      ) : (
        <Empty>{running ? 'Die ersten Clips erscheinen hier, sobald OpenShorts sie fertig geschnitten hat.' : j.status === 'failed' ? 'Keine Clips.' : 'Noch keine Clips.'}</Empty>
      )}
      {edit && <EditClip clip={edit} job={j} studio={studio} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), job.reload())} />}
      {plan && <PlanClip clip={plan} studio={studio} onClose={() => setPlan(null)} onDone={() => (setPlan(null), job.reload())} />}
    </>
  );
}

function ClipCard({ c, focus, studio, onEdit, onPlan, onChange }: { c: any; focus: boolean; studio: Studio; onEdit: () => void; onPlan: () => void; onChange: () => void }) {
  const saveDoc = async () => {
    if (await act(() => api.post(`/api/video-studio/clips/${c.id}/doc`), 'Im Projekt unter Dokumente gespeichert')) onChange();
  };
  const remove = async () => {
    if (!confirmAsk(`Clip „${c.title}“ entfernen?`)) return;
    if (await act(() => api.del(`/api/video-studio/clips/${c.id}`), 'Entfernt')) onChange();
  };
  const busy = c.pending > 0;
  // A still frame for newsletters (captured once in the browser, stored by HyperLevel).
  useEffect(() => {
    if (!c.thumb_url && !busy) captureThumb(c.id, mediaSrc(c.video_url, `&v=${encodeURIComponent(c.updated_at)}`));
  }, [c.id, c.thumb_url, busy]);
  return (
    <div className={`card vs-clip${focus ? ' focus' : ''}`} id={`clip-${c.id}`}>
      <div className="vs-player">
        <video src={mediaSrc(c.video_url, `&v=${encodeURIComponent(c.updated_at)}`)} controls preload="metadata" playsInline />
        {c.score !== null && (
          <span className={`vs-score ${scoreTone(c.score)}`} title={`Viralität ${c.score} von 100`}>
            {c.score}
          </span>
        )}
        {busy && <span className="vs-busy">Wird bearbeitet …</span>}
      </div>
      <div className="vs-clip-body">
        <strong className="vs-clip-title">{c.title}</strong>
        {c.reason && <p className="vs-reason">{c.reason}</p>}
        {c.description && <p className="vs-desc">{c.description}</p>}
        {c.hashtags?.length > 0 && (
          <div className="vs-tags">
            {c.hashtags.map((t: string) => (
              <span key={t}>{t}</span>
            ))}
          </div>
        )}
        <div className="muted small vs-meta">
          {c.duration ? `${Math.round(c.duration)} s` : ''}
          {c.planned ? ` · ${c.planned}× eingeplant` : ''}
          {c.doc_saved ? ' · als Dokument gespeichert' : ''}
        </div>
        {c.op_status === 'failed' && c.op_error && <p className="small vs-error-text">Nachbearbeitung: {c.op_error}</p>}
      </div>
      <div className="vs-clip-actions">
        <button className="btn small" onClick={onPlan} disabled={!studio.social || busy} title={studio.social ? 'Im Social Planner einplanen' : 'Social Planner fehlt'}>
          <Icon name="schedule" /> Einplanen
        </button>
        <button className="btn small secondary" onClick={onEdit} disabled={busy}>
          <Icon name="edit" /> Bearbeiten
        </button>
        <a className="btn small secondary" href={mediaSrc(c.video_url, '&download=1')} download title="Herunterladen" aria-label="Herunterladen">
          <Icon name="download" />
        </a>
        <button className="btn small secondary" onClick={saveDoc} title="Als Dokument im Projekt speichern" aria-label="Als Dokument im Projekt speichern">
          <Icon name="doc" />
        </button>
        <button className="btn small ghost" onClick={remove} title="Clip entfernen" aria-label="Clip entfernen">
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}

function EditClip({ clip, job, studio, onClose, onSaved }: { clip: any; job: any; studio: Studio; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(clip.title);
  const [desc, setDesc] = useState(clip.description);
  const [tags, setTags] = useState((clip.hashtags ?? []).join(' '));
  const [preset, setPreset] = useState('hormozi');
  const [lang, setLang] = useState('');
  const [framing, setFraming] = useState('full');
  const canEdit = job.kind === 'clips' && job.status === 'completed';
  const save = async () => {
    if (await act(() => api.patch(`/api/video-studio/clips/${clip.id}`, { title, description: desc, hashtags: tags }), 'Gespeichert')) onSaved();
  };
  const op = async (body: any, ok: string) => {
    if (await act(() => api.post(`/api/video-studio/clips/${clip.id}/edit`, body), ok)) onSaved();
  };
  return (
    <Modal
      title="Clip bearbeiten"
      wide
      onClose={onClose}
      footer={
        <button className="btn" disabled={!title.trim()} onClick={save}>
          Texte speichern
        </button>
      }
    >
      <div className="vs-edit">
        <div className="vs-edit-player">
          <video src={mediaSrc(clip.video_url, `&v=${encodeURIComponent(clip.updated_at)}`)} controls preload="metadata" playsInline />
        </div>
        <div className="vs-edit-form">
          <Field label="Titel" hint={`${title.length}/100 Zeichen für YouTube`}>
            <Input value={title} onChange={setTitle} maxLength={200} />
          </Field>
          <Field label="Beschreibung">
            <Textarea value={desc} onChange={setDesc} rows={4} />
          </Field>
          <Field label="Hashtags" hint="mit Leerzeichen trennen">
            <Input value={tags} onChange={setTags} placeholder="#marketing #tipps" />
          </Field>
          {canEdit && (
            <div className="vs-ops">
              <h3>Nachbearbeiten</h3>
              <p className="muted small">Läuft in OpenShorts; der Clip wird danach ersetzt.</p>
              {studio.features.subtitles && (
                <div className="vs-op">
                  <Icon name="captions" />
                  <Select value={preset} onChange={setPreset} options={SUBTITLES.filter((s) => s[0] !== 'off')} />
                  <button className="btn small secondary" onClick={() => op({ op: 'subtitles', preset }, 'Untertitel werden neu gesetzt')}>
                    Untertitel setzen
                  </button>
                </div>
              )}
              {studio.dubbing && (
                <div className="vs-op">
                  <Icon name="languages" />
                  <Select value={lang} onChange={setLang} placeholder="Sprache wählen" options={Object.entries(studio.languages).map(([k, l]) => [k, l] as [string, string])} />
                  <button className="btn small secondary" disabled={!lang} onClick={() => op({ op: 'dub', language: lang, subtitles: preset }, 'Wird vertont')}>
                    Vertonen
                  </button>
                </div>
              )}
              {studio.features.rerender && (
                <div className="vs-op">
                  <Icon name="crop" />
                  <Select value={framing} onChange={setFraming} options={FRAMINGS} />
                  <button className="btn small secondary" onClick={() => op({ op: 'framing', framing }, 'Bildausschnitt wird geändert')}>
                    Ausschnitt ändern
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function PlanClip({ clip, studio, onClose, onDone }: { clip: any; studio: Studio; onClose: () => void; onDone: () => void }) {
  const social = useLoad(() => api.get<any>('/api/social'), []);
  const channels: any[] = (social.data?.channels ?? []).filter((c: any) => c.video && !c.disabled);
  const [sel, setSel] = useState<string[]>([]);
  const [mode, setMode] = useState<'schedule' | 'now' | 'draft'>('schedule');
  const [when, setWhen] = useState(() => {
    const d = new Date(Date.now() + 864e5);
    d.setHours(10, 0, 0, 0);
    return localInput(d);
  });
  const [caption, setCaption] = useState(() => [clip.description || clip.title, (clip.hashtags ?? []).join(' ')].filter(Boolean).join('\n\n'));
  const [title, setTitle] = useState(String(clip.title).slice(0, 100));
  const [busy, setBusy] = useState(false);
  const chosen = channels.filter((c) => sel.includes(c.id));
  const limit = chosen.reduce((m, c) => (c.limit && c.limit < m.limit ? { limit: c.limit, label: c.label } : m), { limit: Infinity, label: '' });
  const tooLong = caption.length > limit.limit;
  const hasYoutube = chosen.some((c) => c.identifier === 'youtube');
  const submit = async () => {
    if (mode === 'now' && !confirmAsk(`Jetzt auf ${chosen.map((c) => c.name).join(', ')} veröffentlichen?`)) return;
    setBusy(true);
    const r = await act(() => api.post(`/api/video-studio/clips/${clip.id}/schedule`, { integration_ids: sel, type: mode, date: new Date(when).toISOString(), caption, title }));
    setBusy(false);
    if (r) {
      toast(mode === 'now' ? 'Wird veröffentlicht' : mode === 'draft' ? 'Als Entwurf im Social Planner' : 'Eingeplant');
      onDone();
    }
  };
  return (
    <Modal
      title="Im Social Planner einplanen"
      wide
      onClose={onClose}
      footer={
        <button className="btn" disabled={busy || !sel.length || !caption.trim() || tooLong || !studio.public_base} onClick={submit}>
          {mode === 'now' ? 'Jetzt veröffentlichen' : mode === 'draft' ? 'Als Entwurf speichern' : 'Einplanen'}
        </button>
      }
    >
      {!social.data ? (
        <Spinner />
      ) : !social.data.configured ? (
        <Empty>Der Social Planner ist noch nicht verbunden (Agentur → Integrationen → Postiz).</Empty>
      ) : (
        <>
          {!studio.public_base && <p className="vs-warn">Postiz holt das Video bei HyperLevel ab – dafür muss HyperLevel öffentlich per https erreichbar sein (PGHL_BASE_URL).</p>}
          <Field label="Kanäle dieses Sub-Accounts">
            {channels.length ? (
              <div className="social-pick">
                {channels.map((c) => {
                  const on = sel.includes(c.id);
                  return (
                    <button key={c.id} type="button" className={`social-chip pick${on ? ' on' : ''}`} onClick={() => setSel(on ? sel.filter((x) => x !== c.id) : [...sel, c.id])} title={c.label}>
                      <ChannelAvatar c={c} /> {c.name} <span className="muted small">{c.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="muted">Noch keine Kanäle – im Social Planner verbinden (YouTube, TikTok, Instagram …).</p>
            )}
          </Field>
          {hasYoutube && (
            <Field label="YouTube-Titel" hint={`${title.length}/100`}>
              <Input value={title} onChange={setTitle} maxLength={100} />
            </Field>
          )}
          <Field label="Text" hint={<span className={tooLong ? 'vs-error-text' : undefined}>{caption.length}{Number.isFinite(limit.limit) ? ` / ${limit.limit} Zeichen (${limit.label})` : ' Zeichen'}</span>}>
            <Textarea value={caption} onChange={setCaption} rows={5} />
          </Field>
          <div className="grid2">
            <Field label="Wann">
              <Select value={mode} onChange={(v) => setMode(v as any)} options={[['schedule', 'Planen'], ['now', 'Sofort veröffentlichen'], ['draft', 'Als Entwurf (in Postiz freigeben)']]} />
            </Field>
            {mode === 'schedule' && (
              <Field label="Zeitpunkt">
                <input type="datetime-local" value={when} min={localInput(new Date())} onChange={(e) => setWhen(e.target.value)} />
              </Field>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

// --- YouTube-Studio ------------------------------------------------------------------------------------

function SourcePicker({ studio, onStart, label }: { studio: Studio; onStart: (src: { url?: string; upload_id?: string }) => Promise<unknown>; label: string }) {
  const [mode, setMode] = useState<'url' | 'file'>('url');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      if (mode === 'file' && file) {
        setProgress(0);
        const upload_id = await uploadVideo(file, setProgress);
        await onStart({ upload_id });
      } else await onStart({ url: url.trim() });
      setUrl('');
      setFile(null);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };
  return (
    <>
      <div className="vs-seg">
        <button type="button" className={mode === 'url' ? 'on' : ''} onClick={() => setMode('url')}>
          <Icon name="link" /> Link
        </button>
        <button type="button" className={mode === 'file' ? 'on' : ''} onClick={() => setMode('file')}>
          <Icon name="upload" /> Datei
        </button>
      </div>
      {mode === 'url' ? (
        <Field label="Video-Link">
          <Input value={url} onChange={setUrl} placeholder="https://www.youtube.com/watch?v=…" />
        </Field>
      ) : (
        <DropZone file={file} onFile={setFile} maxMb={studio.max_upload_mb} />
      )}
      {progress !== null && <Progress value={progress * 100} label={`Hochladen … ${Math.round(progress * 100)} %`} />}
      <button className="btn" disabled={busy || (mode === 'url' ? !/^https?:\/\/\S+$/i.test(url.trim()) : !file)} onClick={start}>
        {busy ? 'Startet …' : label}
      </button>
    </>
  );
}

function TaskList({ tasks, sel, onSel }: { tasks: any[]; sel?: string; onSel: (id: string) => void }) {
  return (
    <div className="vs-tasks">
      {tasks.map((t) => (
        <button key={t.id} type="button" className={`vs-task${sel === t.id ? ' on' : ''}`} onClick={() => onSel(t.id)}>
          <span className="vs-task-title">{t.title}</span>
          <span className="muted small">
            {ago(t.created_at)} · {t.status === 'analyzing' ? 'analysiert …' : t.status === 'failed' ? 'fehlgeschlagen' : t.busy ? 'arbeitet …' : 'fertig'}
          </span>
        </button>
      ))}
    </div>
  );
}

function YoutubeStudio({ studio }: { studio: Studio }) {
  const tasks = useLoad(() => api.get<any[]>('/api/video-studio/tasks?kind=youtube'), []);
  const [selId, setSel] = useState<string>();
  const list = tasks.data ?? [];
  const cur = list.find((t) => t.id === selId) ?? list[0];
  usePoll(list.some((t) => t.busy), tasks.reload, 3000);
  const start = async (src: { url?: string; upload_id?: string }) => {
    const t = await api.post<any>('/api/video-studio/youtube', src);
    toast('Analyse läuft – OpenShorts transkribiert das Video');
    setSel(t.id);
    await tasks.reload();
  };
  return (
    <div className="vs-layout">
      <div className="card vs-new">
        <h2>Video analysieren</h2>
        <p className="muted small">Titel-Ideen, Beschreibung mit Kapiteln und KI-Thumbnails für ein langes YouTube-Video.</p>
        {studio.features.youtube_studio ? (
          <SourcePicker studio={studio} onStart={start} label="Analysieren" />
        ) : (
          <p className="muted small">Diese OpenShorts-Version analysiert keine YouTube-Videos. Beschreibungen und Titel aus dem Recycling eines Jobs landen trotzdem hier.</p>
        )}
        {list.length > 0 && <TaskList tasks={list} sel={cur?.id} onSel={setSel} />}
      </div>
      <div className="card">{cur ? <YoutubeTask key={cur.id} t={cur} studio={studio} reload={tasks.reload} /> : <Empty>Noch keine Analyse.</Empty>}</div>
    </div>
  );
}

function YoutubeTask({ t, studio, reload }: { t: any; studio: Studio; reload: () => unknown }) {
  const r = t.result ?? {};
  const [title, setTitle] = useState<string>(r.description_title || r.recommended?.[0] || r.titles?.[0] || '');
  const [msg, setMsg] = useState('');
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState('3');
  useEffect(() => {
    if (!title && r.titles?.length) setTitle(r.recommended?.[0] || r.titles[0]);
  }, [r.titles?.length]);
  const run = async (path: string, body: any, ok: string) => {
    if (await act(() => api.post(`/api/video-studio/youtube/${t.id}/${path}`, body), ok)) reload();
  };
  const del = async () => {
    if (confirmAsk('Analyse löschen?') && (await act(() => api.del(`/api/video-studio/tasks/${t.id}`), 'Gelöscht'))) reload();
  };
  if (t.status === 'analyzing') return <Progress value={30} label="OpenShorts lädt und transkribiert das Video – das dauert ein paar Minuten." />;
  if (t.status === 'failed')
    return (
      <>
        <p className="vs-error-text">{t.error || 'Fehlgeschlagen'}</p>
        <button className="btn small ghost" onClick={del}>
          <Icon name="trash" /> Löschen
        </button>
      </>
    );
  const refinable = t.refinable !== false;
  return (
    <div className="vs-yt">
      <div className="vs-head-row">
        <h2>{t.title}</h2>
        <button className="btn small ghost" onClick={del} aria-label="Analyse löschen">
          <Icon name="trash" />
        </button>
      </div>
      {!refinable && (
        <p className="muted small">
          <Badge tone="purple">Aus dem Recycling</Badge> Vom KI-Assistenten aus dem Transkript geschrieben.{' '}
          {t.input?.job_id && <Link to={`video-studio/${t.input.job_id}?tab=recycling`}>Zum Job</Link>}
        </p>
      )}
      {t.error && <p className="vs-error-text">{t.error}</p>}
      {t.busy && <Progress value={60} label={{ titles: 'Neue Titel …', description: 'Beschreibung wird geschrieben …', thumbnails: 'Thumbnails werden gemalt …' }[t.busy as string] ?? 'Arbeitet …'} />}
      <h3>Titel</h3>
      <div className="vs-titles">
        {(r.titles ?? []).map((x: string) => (
          <label key={x} className={`vs-title-opt${title === x ? ' on' : ''}`}>
            <input type="radio" name={`t-${t.id}`} checked={title === x} onChange={() => setTitle(x)} />
            <span className="vs-title-text">{x}</span>
            {r.recommended?.includes(x) && <Badge tone="green">Empfehlung</Badge>}
          </label>
        ))}
      </div>
      {refinable && (
        <div className="vs-inline">
          <Input value={msg} onChange={setMsg} placeholder="Wunsch, z. B. „kürzer und mit Zahl“" />
          <button className="btn small secondary" disabled={!msg.trim() || !!t.busy} onClick={() => (run('titles', { message: msg }, 'Neue Titel kommen'), setMsg(''))}>
            Neue Titel
          </button>
        </div>
      )}
      <Field label="Gewählter Titel">
        <Input value={title} onChange={setTitle} />
      </Field>
      <h3>Beschreibung mit Kapiteln</h3>
      {r.description ? (
        <>
          <Textarea value={r.description} onChange={() => {}} rows={8} readOnly />
          <div className="vs-inline">
            <Copy text={r.description} label="Beschreibung kopieren" />
            {refinable && (
              <button className="btn small secondary" disabled={!title || !!t.busy} onClick={() => run('description', { title }, 'Wird neu geschrieben')}>
                Neu schreiben
              </button>
            )}
          </div>
        </>
      ) : refinable ? (
        <button className="btn small secondary" disabled={!title || !!t.busy} onClick={() => run('description', { title }, 'Wird geschrieben')}>
          Beschreibung erzeugen
        </button>
      ) : null}
      {studio.features.thumbnails && refinable && (
        <>
          <h3>Thumbnails</h3>
          <div className="vs-inline">
            <Input value={prompt} onChange={setPrompt} placeholder="Optional: Stil, Farben, Motiv …" />
            <Select value={count} onChange={setCount} options={['1', '2', '3', '4']} />
            <button className="btn small secondary" disabled={!title || !!t.busy} onClick={() => run('thumbnails', { title, prompt, count: Number(count) }, 'Thumbnails werden gemalt')}>
              Erzeugen
            </button>
          </div>
          {r.thumbnails?.length > 0 && (
            <div className="vs-thumbs">
              {r.thumbnails.map((x: any, i: number) => (
                <figure key={i}>
                  <img src={mediaSrc(x.url)} alt={x.text || `Thumbnail ${i + 1}`} loading="lazy" />
                  <figcaption>
                    <span className="small">{x.why}</span>
                    <a className="btn small secondary" href={mediaSrc(x.url, '&download=1')} download>
                      <Icon name="download" />
                    </a>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- AI Shorts (UGC) ----------------------------------------------------------------------------------

function UgcStudio({ studio }: { studio: Studio }) {
  const tasks = useLoad(() => api.get<any[]>('/api/video-studio/tasks?kind=ugc'), []);
  const [selId, setSel] = useState<string>();
  const [f, setF] = useState({ url: '', description: '', language: 'en', style: 'ugc', actor_gender: 'female', num_scripts: '3' });
  const [busy, setBusy] = useState(false);
  const list = tasks.data ?? [];
  const cur = list.find((t) => t.id === selId) ?? list[0];
  usePoll(list.some((t) => t.busy), tasks.reload, 3000);
  const start = async () => {
    setBusy(true);
    const t = await act(() => api.post<any>('/api/video-studio/ugc', { ...f, num_scripts: Number(f.num_scripts) }), 'Skripte werden geschrieben');
    setBusy(false);
    if (t) (setSel(t.id), tasks.reload());
  };
  return (
    <div className="vs-layout">
      <div className="card vs-new">
        <h2>KI-Short aus Produkt</h2>
        <p className="muted small">OpenShorts schreibt Skripte und erzeugt ein Video mit KI-Darsteller, Stimme, B-Roll und Untertiteln – derzeit auf Englisch oder Spanisch.</p>
        <Field label="Produkt- oder Website-Link">
          <Input value={f.url} onChange={(v) => setF({ ...f, url: v })} placeholder="https://…" />
        </Field>
        <Field label="… oder Beschreibung">
          <Textarea value={f.description} onChange={(v) => setF({ ...f, description: v })} rows={3} placeholder="Was ihr anbietet, für wen, was es besonders macht" />
        </Field>
        <div className="grid2">
          <Field label="Sprache">
            <Select value={f.language} onChange={(v) => setF({ ...f, language: v })} options={[['en', 'Englisch'], ['es', 'Spanisch']]} />
          </Field>
          <Field label="Stil">
            <Select value={f.style} onChange={(v) => setF({ ...f, style: v })} options={[['ugc', 'Echt (UGC)'], ['educational', 'Erklärend'], ['shock', 'Überraschung'], ['story', 'Geschichte'], ['comparison', 'Vorher/Nachher']]} />
          </Field>
          <Field label="Darsteller">
            <Select value={f.actor_gender} onChange={(v) => setF({ ...f, actor_gender: v })} options={[['female', 'Frau'], ['male', 'Mann']]} />
          </Field>
          <Field label="Skripte">
            <Select value={f.num_scripts} onChange={(v) => setF({ ...f, num_scripts: v })} options={['1', '2', '3']} />
          </Field>
        </div>
        <button className="btn" disabled={busy || (!/^https?:\/\/\S+$/i.test(f.url.trim()) && f.description.trim().length < 10)} onClick={start}>
          Skripte schreiben
        </button>
        {!studio.ai_shorts && <p className="vs-warn small">Zum Erzeugen des Videos braucht OpenShorts fal.ai- und ElevenLabs-Schlüssel (Agentur → Integrationen → OpenShorts). Skripte gehen auch ohne.</p>}
        {list.length > 0 && <TaskList tasks={list} sel={cur?.id} onSel={setSel} />}
      </div>
      <div className="card">{cur ? <UgcTask key={cur.id} t={cur} studio={studio} reload={tasks.reload} /> : <Empty>Noch keine Skripte.</Empty>}</div>
    </div>
  );
}

function UgcTask({ t, studio, reload }: { t: any; studio: Studio; reload: () => unknown }) {
  const r = t.result ?? {};
  const [modeOf, setModeOf] = useState<Record<number, string>>({});
  const generate = async (i: number) => {
    const job = await act(() => api.post<any>(`/api/video-studio/ugc/${t.id}/generate`, { script_index: i, video_mode: modeOf[i] ?? 'lowcost' }), 'Video wird erzeugt – erscheint unter „Shorts aus Videos“');
    if (job) reload();
  };
  if (t.status === 'analyzing') return <Progress value={30} label="Skripte werden geschrieben …" />;
  if (t.status === 'failed') return <p className="vs-error-text">{t.error || 'Fehlgeschlagen'}</p>;
  return (
    <div className="vs-ugc">
      <h2>{r.product || t.title}</h2>
      {t.error && <p className="vs-error-text">{t.error}</p>}
      {(r.scripts ?? []).map((s: any, i: number) => (
        <div key={i} className="vs-script">
          <div className="vs-head-row">
            <strong>{s.title || `Skript ${i + 1}`}</strong>
            {s.duration_seconds && <span className="muted small">ca. {s.duration_seconds} s</span>}
          </div>
          {s.hook_text && <p className="vs-hook">„{s.hook_text}“</p>}
          {s.full_narration && <p className="small">{s.full_narration}</p>}
          {s.caption && <p className="muted small">{s.caption}</p>}
          {Array.isArray(s.hashtags) && (
            <div className="vs-tags">
              {s.hashtags.map((h: string) => (
                <span key={h}>{h.startsWith('#') ? h : `#${h}`}</span>
              ))}
            </div>
          )}
          <div className="vs-inline">
            <Select value={modeOf[i] ?? 'lowcost'} onChange={(v) => setModeOf({ ...modeOf, [i]: v })} options={[['lowcost', 'Günstig (ca. 0,65 $)'], ['premium', 'Premium (ca. 2 $)']]} />
            <button className="btn small" disabled={!studio.ai_shorts} onClick={() => generate(i)}>
              <Icon name="sparkles" /> Video erzeugen
            </button>
          </div>
        </div>
      ))}
      {r.jobs?.length > 0 && (
        <p className="small">
          Erzeugte Videos:{' '}
          {r.jobs.map((id: string, i: number) => (
            <Link key={id} to={`video-studio/${id}`}>
              Video {i + 1}
              {i < r.jobs.length - 1 ? ', ' : ''}
            </Link>
          ))}
        </p>
      )}
    </div>
  );
}

// --- agency: connection card ----------------------------------------------------------------------------

export function OpenShortsSetup() {
  const s = useLoad(() => api.get<any>('/api/agency/video-studio'), []);
  const [url, setUrl] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [eleven, setEleven] = useState('');
  const [fal, setFal] = useState('');
  const [maxMb, setMaxMb] = useState<string | null>(null);
  const [maxActive, setMaxActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!s.data) return <Spinner />;
  const v = s.data;
  const save = async (extra: any = {}) => {
    setBusy(true);
    const r = await act(
      () =>
        api.patch('/api/agency/video-studio', {
          url: url ?? v.url,
          ...(key ? { api_key: key } : {}),
          ...(eleven ? { elevenlabs_key: eleven } : {}),
          ...(fal ? { fal_key: fal } : {}),
          ...(maxMb !== null ? { max_upload_mb: Number(maxMb) } : {}),
          ...(maxActive !== null ? { max_active: Number(maxActive) } : {}),
          ...extra,
        }),
      'Gespeichert',
    );
    setBusy(false);
    if (r) {
      s.setData(r);
      setKey('');
      setEleven('');
      setFal('');
      setUrl(null);
    }
  };
  const test = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/agency/video-studio/test'), 'Verbindung steht');
    setBusy(false);
    void r;
    s.reload();
  };
  const i = v.info;
  const FEATURE_LABELS: [string, string][] = [
    ['uploads', 'Datei-Uploads'],
    ['youtube_studio', 'YouTube-Studio'],
    ['thumbnails', 'Thumbnails'],
    ['ai_shorts', 'KI-Shorts'],
    ['translate', 'Vertonung'],
    ['subtitles', 'Untertitel-Stile'],
    ['rerender', 'Bildausschnitt'],
  ];
  const clear = (field: string) => save({ [field]: null });
  return (
    <div className="card vs-setup" data-tour="integrations-openshorts">
      <h2>
        <Icon name="studio" /> OpenShorts (Video-Studio)
      </h2>
      <p className="muted small">Schneidet aus langen Videos Shorts mit Untertiteln. Selbst gehostet neben HyperLevel (Vorlage: deploy/openshorts/docker-compose.yml) oder die gehostete API von openshorts.app.</p>
      <Field label="Adresse" hint="Selbst gehostet: das Backend im Docker-Netz, z. B. http://openshorts:8000 · gehostet: https://api.openshorts.app">
        <Input value={url ?? v.url} onChange={setUrl} placeholder="http://openshorts:8000" />
      </Field>
      <Field label="API-Schlüssel (nur openshorts.app)" hint="openshorts.app → Konto → API keys (osk_…). Selbst gehostet bleibt das leer – dann das Backend nicht öffentlich erreichbar machen.">
        <div className="vs-inline">
          <Input type="password" value={key} onChange={setKey} placeholder={v.key_set ? `•••••••• ${v.key_hint} (gespeichert)` : ''} autoComplete="off" />
          {v.key_set && v.key_hint !== 'Umgebung' && (
            <button className="btn small ghost" onClick={() => clear('api_key')}>
              Entfernen
            </button>
          )}
        </div>
      </Field>
      <details className="vs-details">
        <summary>Eigene Schlüssel für Vertonung und KI-Shorts (optional)</summary>
        <p className="muted small">Gemini (bzw. LLM_BASE_URL) steht in der Umgebung von OpenShorts selbst. ElevenLabs und fal.ai nimmt OpenShorts nur pro Anfrage an – HyperLevel schickt sie verschlüsselt gespeichert mit. <SignupLink id="gemini" label="Gemini-Konto anlegen" /></p>
        <Field label="ElevenLabs-Schlüssel" hint={<>KI-Vertonung in andere Sprachen und Stimmen für KI-Shorts <SignupLink id="elevenlabs" /></>}>
          <div className="vs-inline">
            <Input type="password" value={eleven} onChange={setEleven} placeholder={v.elevenlabs_set ? `•••••••• ${v.elevenlabs_hint} (gespeichert)` : ''} autoComplete="off" />
            {v.elevenlabs_set && (
              <button className="btn small ghost" onClick={() => clear('elevenlabs_key')}>
                Entfernen
              </button>
            )}
          </div>
        </Field>
        <Field label="fal.ai-Schlüssel" hint={<>KI-Darsteller, Lippensynchron-Video und B-Roll für KI-Shorts <SignupLink id="fal" /></>}>
          <div className="vs-inline">
            <Input type="password" value={fal} onChange={setFal} placeholder={v.fal_set ? `•••••••• ${v.fal_hint} (gespeichert)` : ''} autoComplete="off" />
            {v.fal_set && (
              <button className="btn small ghost" onClick={() => clear('fal_key')}>
                Entfernen
              </button>
            )}
          </div>
        </Field>
      </details>
      <div className="grid2">
        <Field label="Max. Dateigröße (MB)" hint="OpenShorts nimmt bis 2048 MB">
          <Input type="number" min={10} max={2048} value={maxMb ?? v.max_upload_mb} onChange={setMaxMb} />
        </Field>
        <Field label="Laufende Jobs je Sub-Account">
          <Input type="number" min={1} max={20} value={maxActive ?? v.max_active} onChange={setMaxActive} />
        </Field>
      </div>
      <div className="vs-inline">
        <button className="btn" disabled={busy} onClick={() => save()}>
          Speichern & testen
        </button>
        {v.configured && (
          <button className="btn secondary" disabled={busy} onClick={test}>
            Verbindung testen
          </button>
        )}
      </div>
      {v.configured && (
        <div className="vs-status">
          {v.error ? (
            <p>
              <Badge tone="red">Fehler</Badge> <span className="small">{v.error}</span>
            </p>
          ) : i ? (
            <>
              <p>
                <Badge tone="green">verbunden</Badge> <span className="small">{i.mode === 'hosted' ? `openshorts.app${i.plan ? ` · Tarif ${i.plan}` : ''}${i.minutes_remaining !== null && i.minutes_remaining !== undefined ? ` · ${i.minutes_remaining} Minuten übrig` : ''}` : `Selbst gehostet${i.local_llm ? ` · eigenes LLM ${i.local_llm}` : ''}`}</span>
              </p>
              <div className="vs-feats">
                {FEATURE_LABELS.map(([k, l]) => (
                  <span key={k} className={i.features?.[k] ? 'on' : ''}>
                    {i.features?.[k] ? '✓' : '–'} {l}
                  </span>
                ))}
              </div>
              <p className="muted small">
                {v.webhooks ? 'Fertig-Meldungen kommen per signiertem Webhook; zusätzlich fragt HyperLevel regelmäßig nach.' : `HyperLevel ist unter ${v.base_url} nicht öffentlich erreichbar – Status kommt per Abfrage (alle 20 s), Postiz kann Clips erst mit https-Adresse abholen.`}
                {i.retention_hours ? ` OpenShorts hebt Jobs ${hours(i.retention_hours)} auf (JOB_RETENTION_SECONDS).` : ''}
                {!i.youtube_urls ? ' YouTube-Links sind in dieser Instanz abgeschaltet.' : ''}
              </p>
            </>
          ) : (
            <p className="muted small">Noch nicht getestet.</p>
          )}
        </div>
      )}
    </div>
  );
}

// --- workflow step ----------------------------------------------------------------------------------------

export function ShortsStep({ step, set }: { step: any; set: (patch: any) => void }) {
  return (
    <>
      <Field label="Video-Link (Platzhalter erlaubt)" hint="YouTube oder direkte MP4-Adresse">
        <Input value={step.url} onChange={(v) => set({ url: v })} placeholder="{{contact.custom.video_url}}" />
      </Field>
      <Field label="Titel (optional)">
        <Input value={step.title} onChange={(v) => set({ title: v })} placeholder="Video von {{contact.first_name}}" />
      </Field>
      <div className="grid2">
        <Field label="Anzahl Clips">
          <Select value={String(step.clips ?? '')} onChange={(v) => set({ clips: v ? Number(v) : undefined })} options={[['', 'KI entscheidet'], ...Array.from({ length: 10 }, (_, i) => [String(i + 1), String(i + 1)] as [string, string])]} />
        </Field>
        <Field label="Layout">
          <Select value={step.layout ?? 'auto'} onChange={(v) => set({ layout: v })} options={LAYOUTS} />
        </Field>
        <Field label="Untertitel">
          <Select value={step.subtitles ?? 'default'} onChange={(v) => set({ subtitles: v })} options={SUBTITLES} />
        </Field>
        <div className="field">
          <span>&nbsp;</span>
          <Check checked={step.hook !== false} onChange={(v) => set({ hook: v })} label="Hook-Text einblenden" />
        </div>
      </div>
      <p className="muted small">Startet einen Job im Video-Studio dieses Sub-Accounts. Ist er fertig, läuft der Auslöser „Shorts fertig“ für denselben Kontakt.</p>
      <MergeHint />
    </>
  );
}
