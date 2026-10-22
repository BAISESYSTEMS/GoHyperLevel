import { useEffect, useRef, useState } from 'react';
import { api, currentLocation } from '../api';
import { Icon } from '../icons';
import { Field, Input, Link, MergeHint, Modal, Select, Spinner, Textarea, act, useLoad } from '../ui';

/**
 * Shared pieces of the KI-Studio (AI media generation with the sub-account's own provider keys):
 * types and API helpers, the „KI-Bild generieren“ button for the e-mail builder, funnel builder,
 * social composer and blog/course editors, and the workflow step editor.
 */

export type Capability = 'image' | 'video' | 'audio_tts' | 'audio_music' | 'stt';
export interface GenResult { url: string; download_url: string; mime: string; kind: 'image' | 'video' | 'audio' | ''; size: number; name: string; upload_id: string | null; library_url: string | null }
export interface GenJob {
  id: string;
  capability: Capability;
  capability_label: string;
  provider: string;
  provider_label: string;
  model: string;
  connection_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  progress: number | null;
  prompt: string;
  input: Record<string, any>;
  results: GenResult[];
  url: string | null;
  text: string | null;
  cost: { amount?: number; unit?: string; note?: string; estimated?: boolean } | null;
  error: string | null;
  source: string;
  parent_id: string | null;
  target_result: string | null;
  created_at: string;
  finished_at: string | null;
}
export interface GenConn { id: string; provider: string; label: string; model?: string; capabilities: Capability[] }
export interface ModelHint { id: string; label: string; ref?: boolean }
export interface GenMeta {
  available: boolean;
  message: string | null;
  connections: GenConn[];
  providers: { id: string; label: string; capabilities: Capability[]; models: Partial<Record<Capability, ModelHint[]>>; voices: boolean }[];
  capabilities?: { id: Capability; label: string }[];
  aspects: string[];
  callbacks: boolean;
  templates: { id: string; name: string; capability: Capability }[];
}

export const BYOK_TEXT = 'Bitte zuerst unter Einstellungen → KI-Anbieter (BYOK) einen Anbieter verbinden';
export const ACTIVE = ['queued', 'running'];
export const STATUS_LABEL: Record<string, string> = { queued: 'Wartet', running: 'Läuft', succeeded: 'Fertig', failed: 'Fehler', canceled: 'Abgebrochen' };
export const STATUS_TONE: Record<string, 'gray' | 'blue' | 'green' | 'red' | 'yellow'> = { queued: 'gray', running: 'blue', succeeded: 'green', failed: 'red', canceled: 'yellow' };

export function costText(c: GenJob['cost']): string {
  if (!c) return '';
  const amount = c.amount !== undefined ? `${c.estimated ? '≈ ' : ''}${String(c.amount).replace('.', ',')} ${c.unit ?? ''}`.trim() : '';
  return [amount, c.note ?? ''].filter(Boolean).join(' · ');
}

export const connsFor = (meta: GenMeta | undefined, cap: Capability) => (meta?.connections ?? []).filter((c) => c.capabilities.includes(cap));
export const modelsFor = (meta: GenMeta | undefined, conn: GenConn | undefined, cap: Capability): ModelHint[] => {
  const p = meta?.providers.find((x) => x.id === conn?.provider);
  const list = [...(p?.models[cap] ?? [])];
  // The connection's default model first – when it belongs to this kind of media (or nothing is suggested).
  const def = conn?.model;
  if (def && !list.length) return [{ id: def, label: 'Standard der Verbindung' }];
  const i = def ? list.findIndex((m) => m.id === def) : -1;
  if (i > 0) list.unshift(...list.splice(i, 1));
  return list;
};

/** Raw upload of a reference or audio file (up to 25 MB, the server checks the type from the bytes). */
export async function uploadInput(file: File): Promise<{ file: string; name: string; mime: string; size: number; url: string } | undefined> {
  if (file.size > 25 * 1024 * 1024) {
    await act(() => Promise.reject(new Error('Datei größer als 25 MB')));
    return undefined;
  }
  return act(async () => {
    const r = await fetch(`/api/genmedia/inputs?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'x-pghl': '1', 'x-location-id': currentLocation(), 'content-type': file.type || 'application/octet-stream' }, body: file, credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Fehler ${r.status}`);
    return data;
  });
}

/** Polls a job until it is done (or the component goes away). */
export function useJob(initial: GenJob | null) {
  const [job, setJob] = useState<GenJob | null>(initial);
  useEffect(() => setJob(initial), [initial?.id]);
  useEffect(() => {
    if (!job || !ACTIVE.includes(job.status)) return;
    const t = setTimeout(async () => {
      const j = await api.get<GenJob>(`/api/genmedia/jobs/${job.id}`).catch(() => null);
      if (j) setJob(j);
    }, 2000);
    return () => clearTimeout(t);
  }, [job]);
  return job;
}

export function ByokNotice({ message }: { message?: string | null }) {
  return (
    <div className="gm-byok" data-tour="gm-byok">
      <Icon name="key" size={18} />
      <div>
        <strong>{message || BYOK_TEXT}</strong>
        <p className="muted small" style={{ margin: '4px 0 0' }}>
          Mit eigenem Schlüssel (BYOK) nutzt du fal.ai, kie.ai, Replicate, OpenAI, Google Gemini, Stability, ElevenLabs, Runway, Luma oder jeden anderen Dienst per HTTP-Vorlage. Abgerechnet wird direkt bei deinem Anbieter. <Link to="settings">Zu den Einstellungen</Link>
        </p>
      </div>
    </div>
  );
}

export function ResultPreview({ r, alt = '' }: { r: GenResult; alt?: string }) {
  if (r.kind === 'image') return <img src={r.url} alt={alt} loading="lazy" />;
  if (r.kind === 'video') return <video src={r.url} controls playsInline preload="metadata" />;
  if (r.kind === 'audio') return <audio src={r.url} controls preload="none" />;
  return null;
}

// --- „KI-Bild generieren“ for the editors -------------------------------------------------------------

export interface PickedUpload { id: string; url: string; name: string; mime: string; size: number }

/** Button + modal: prompt → image → into the media library → `onPick(upload)`. */
export function GenImageButton({ onPick, label = 'KI-Bild generieren', small = true, aspect }: { onPick: (u: PickedUpload) => void; label?: string; small?: boolean; aspect?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn secondary${small ? ' small' : ''} gm-gen-btn`} onClick={() => setOpen(true)} data-tour="gm-gen-button">
        <Icon name="sparkles" size={14} /> {label}
      </button>
      {open && (
        <GenImageModal
          aspect={aspect}
          onClose={() => setOpen(false)}
          onPick={(u) => {
            setOpen(false);
            onPick(u);
          }}
        />
      )}
    </>
  );
}

export function GenImageModal({ onPick, onClose, aspect }: { onPick: (u: PickedUpload) => void; onClose: () => void; aspect?: string }) {
  const meta = useLoad(() => api.get<GenMeta>('/api/genmedia/meta'), []);
  const conns = connsFor(meta.data, 'image');
  const [connId, setConnId] = useState('');
  const conn = conns.find((c) => c.id === connId) ?? conns[0];
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState(aspect ?? '16:9');
  const [started, setStarted] = useState<GenJob | null>(null);
  const job = useJob(started);
  const [busy, setBusy] = useState(false);
  const listId = useRef(`gm-models-${Math.random().toString(36).slice(2)}`).current;
  const models = modelsFor(meta.data, conn, 'image');
  const start = async () => {
    setBusy(true);
    const j = await act(() => api.post<GenJob>('/api/genmedia/jobs', { capability: 'image', connection_id: conn?.id, model: model || undefined, prompt, aspect_ratio: ratio, source: 'builder' }));
    setBusy(false);
    if (j) setStarted(j);
  };
  const take = async (i: number) => {
    if (!job) return;
    setBusy(true);
    const r = await act(() => api.post<{ uploads: PickedUpload[] }>(`/api/genmedia/jobs/${job.id}/library`, { index: i }), 'In der Mediathek gespeichert');
    setBusy(false);
    if (r?.uploads[0]) onPick(r.uploads[0]);
  };
  const running = !!job && ACTIVE.includes(job.status);
  return (
    <Modal
      title="KI-Bild generieren"
      onClose={onClose}
      wide
      footer={
        conns.length ? (
          <button className="btn" disabled={busy || running || !prompt.trim()} onClick={start} data-tour="gm-modal-generate">
            <Icon name="sparkles" size={14} /> {job ? 'Neu generieren' : 'Generieren'}
          </button>
        ) : undefined
      }
    >
      {meta.loading && !meta.data ? (
        <Spinner />
      ) : !conns.length ? (
        <ByokNotice message={meta.data?.message ?? meta.error} />
      ) : (
        <>
          <div className="grid2">
            <Field label="Anbieter">
              <Select value={conn?.id ?? ''} onChange={(v) => (setConnId(v), setModel(''))} options={conns.map((c) => [c.id, `${c.label} (${c.provider})`])} />
            </Field>
            <Field label="Modell" hint="Vorschlag wählen oder beliebige Modell-ID eintragen">
              <input list={listId} value={model} onChange={(e) => setModel(e.target.value)} placeholder={models[0]?.id ?? conn?.model ?? 'Modell-ID'} />
              <datalist id={listId}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </datalist>
            </Field>
          </div>
          <Field label="Was soll auf dem Bild sein?">
            <Textarea value={prompt} onChange={setPrompt} rows={3} placeholder="z. B. Helles Büro mit Pflanzen, freundliches Team, Fotostil, natürliche Farben" autoFocus />
          </Field>
          <Field label="Seitenverhältnis">
            <Select value={ratio} onChange={setRatio} options={(meta.data?.aspects ?? ['1:1', '16:9', '9:16']).map((a) => [a, a])} />
          </Field>
          {job && (
            <div className="gm-modal-result">
              {running && (
                <p className="muted">
                  <span className="gm-dot" /> Wird erzeugt … {job.progress ? `${job.progress} %` : ''}
                </p>
              )}
              {job.status === 'failed' && <p style={{ color: 'var(--red)' }}>{job.error}</p>}
              {job.status === 'succeeded' && (
                <div className="gm-pick">
                  {job.results.map((r, i) => (
                    <button key={r.url} type="button" className="gm-pick-item" onClick={() => take(i)} disabled={busy} title="Übernehmen">
                      <img src={r.url} alt="" />
                      <span className="btn small">Übernehmen</span>
                    </button>
                  ))}
                </div>
              )}
              {costText(job.cost) && <p className="muted small">Kosten laut Anbieter: {costText(job.cost)}</p>}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// --- workflow step editor ---------------------------------------------------------------------------

const STEP_CAP: Record<string, Capability> = { genmedia_image: 'image', genmedia_video: 'video', genmedia_tts: 'audio_tts' };

export function GenMediaStep({ type, step, set, customFields }: { type: string; step: any; set: (p: any) => void; customFields: any[] }) {
  const cap = STEP_CAP[type] ?? 'image';
  const meta = useLoad(() => api.get<GenMeta>('/api/genmedia/meta').catch(() => null), []);
  const social = useLoad(() => (step.target === 'social_draft' ? api.get<any>('/api/social').catch(() => null) : Promise.resolve(null)), [step.target]);
  const conns = connsFor(meta.data ?? undefined, cap);
  const conn = conns.find((c) => c.id === step.connection_id) ?? conns[0];
  const models = modelsFor(meta.data ?? undefined, conn, cap);
  const listId = useRef(`gm-step-${Math.random().toString(36).slice(2)}`).current;
  const fields = (customFields ?? []).map((f: any) => [`custom.${f.key}`, f.label ?? f.name ?? f.key] as [string, string]);
  return (
    <>
      {meta.data && !conns.length && <ByokNotice message={meta.data.message} />}
      <div className="grid2">
        <Field label="KI-Verbindung">
          <Select value={step.connection_id ?? ''} onChange={(v) => set({ connection_id: v || undefined })} options={[['', 'Standard des Sub-Accounts'], ...conns.map((c) => [c.id, `${c.label} (${c.provider})`] as [string, string])]} />
        </Field>
        <Field label="Modell (optional)">
          <input list={listId} value={step.model ?? ''} onChange={(e) => set({ model: e.target.value })} placeholder={models[0]?.id ?? 'Standard'} />
          <datalist id={listId}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
        </Field>
      </div>
      {cap === 'audio_tts' ? (
        <>
          <Field label="Text (Platzhalter erlaubt)">
            <Textarea value={step.text} onChange={(v) => set({ text: v })} rows={4} placeholder="Hallo {{contact.first_name}}, schön, dass du da bist!" />
          </Field>
          <Field label="Stimme (ID)" hint="z. B. nova (OpenAI), Kore (Gemini) oder die Voice-ID von ElevenLabs">
            <Input value={step.voice} onChange={(v) => set({ voice: v })} />
          </Field>
        </>
      ) : (
        <>
          <Field label="Prompt (Platzhalter erlaubt)">
            <Textarea value={step.prompt} onChange={(v) => set({ prompt: v })} rows={4} placeholder={cap === 'video' ? 'Kurzer Clip: {{contact.company}} Produkt auf einem Tisch, sanfte Kamerafahrt' : 'Willkommensbild für {{contact.first_name}}, freundlich, hell'} />
          </Field>
          <div className="grid2">
            <Field label="Seitenverhältnis">
              <Select value={step.aspect_ratio ?? ''} onChange={(v) => set({ aspect_ratio: v || undefined })} options={[['', 'Standard'], ...(cap === 'video' ? ['16:9', '9:16', '1:1'] : ['1:1', '16:9', '9:16', '4:3', '3:4']).map((a) => [a, a] as [string, string])]} />
            </Field>
            {cap === 'video' && (
              <Field label="Dauer (Sekunden)">
                <Input type="number" value={step.duration ?? ''} onChange={(v) => set({ duration: v ? Number(v) : undefined })} min={1} max={60} />
              </Field>
            )}
          </div>
        </>
      )}
      <Field label="Ergebnis">
        <Select value={step.target ?? 'none'} onChange={(v) => set({ target: v })} options={[['none', 'Nur im KI-Studio'], ['field', 'In ein eigenes Feld des Kontakts (Link)'], ['note', 'Als Notiz mit Anhang am Kontakt'], ...(cap !== 'audio_tts' ? [['social_draft', 'Als Social-Post-Entwurf'] as [string, string]] : [])]} />
      </Field>
      {step.target === 'field' && (
        <Field label="Feld">
          <Select value={step.field ?? ''} onChange={(v) => set({ field: v })} placeholder="Feld wählen…" options={fields} />
        </Field>
      )}
      {step.target === 'social_draft' && (
        <>
          <Field label="Kanäle">
            <div className="social-pick">
              {(social.data?.channels ?? []).filter((c: any) => (cap === 'video' ? c.video : c.supported) && !c.disabled).map((c: any) => {
                const on = (step.integration_ids ?? []).includes(c.id);
                return (
                  <button key={c.id} type="button" className={`chip${on ? ' on' : ''}`} onClick={() => set({ integration_ids: on ? step.integration_ids.filter((x: string) => x !== c.id) : [...(step.integration_ids ?? []), c.id] })}>
                    {c.name}
                  </button>
                );
              })}
              {social.data && !social.data.channels?.length && <span className="muted small">Keine Kanäle verbunden (Social Planner)</span>}
            </div>
          </Field>
          <Field label="Post-Text">
            <Textarea value={step.social_text} onChange={(v) => set({ social_text: v })} rows={3} />
          </Field>
        </>
      )}
      <p className="muted small">Läuft im Hintergrund mit dem Schlüssel des Sub-Accounts. Ist das Ergebnis fertig, landet es in der Mediathek und am gewählten Ziel; danach startet der Auslöser „KI-Medium fertig“ für denselben Kontakt.</p>
      <MergeHint />
    </>
  );
}
