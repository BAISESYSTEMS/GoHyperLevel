import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../session';
import { Badge, Check, Field, Input, Modal, PageHead, Select, Spinner, act, useLoad } from '../ui';
import { UmzugConnect } from './UmzugConnect';
import { UmzugMapping, type CustomField, type SourceField } from './UmzugMapping';
import { UmzugHistory, UmzugRun, isLive } from './UmzugRun';
import { EXISTING_LABELS, PART_NAMES, targetLabel, umzugApi, type Conn, type Job, type PartDef, type SourceInfo, type UFile } from './umzug-format';
import './umzug.css';

/**
 * Umzug zu HyperLevel: vom bisherigen Tool (Mailchimp bis sevDesk, die Liste kommt aus der Registry des Servers) hierher –
 * Quelle wählen → verbinden oder Datei hochladen → Vorschau mit Zuordnung → Probelauf → Import als Hintergrundjob → Bericht und Rückgängig.
 */

type Step = 'source' | 'connect' | 'preview' | 'run';
interface Overview {
  sources: SourceInfo[];
  file_kinds: { key: string; label: string }[];
  connections: Record<string, Conn>;
  jobs: Job[];
  files: UFile[];
  max_upload_mb: number;
}
interface Preview {
  label: string;
  origin: 'api' | 'file';
  counts: { part: string; key: string; label: string; total: number | null; error?: string }[];
  fields: SourceField[];
  mapping: Record<string, string>;
  custom_fields: CustomField[];
  existing: Record<string, number>;
  warnings: string[];
  parts: string[];
}

const STEPS: [Step, string][] = [
  ['source', 'Quelle'],
  ['connect', 'Verbinden'],
  ['preview', 'Vorschau'],
  ['run', 'Umzug'],
];

export function UmzugAssistent({ embedded }: { embedded?: boolean }) {
  const session = useSession();
  const [target, setTarget] = useState(session.locationId);
  const targetName = session.locations.find((l) => l.id === target)?.name ?? '';
  const brand = session.branding?.name || 'HyperLevel';
  return (
    <div className="um-page" data-tour="um-page">
      {embedded ? (
        <p className="muted um-intro">Hol deine Kontakte, Listen, Deals und Kurse aus dem bisherigen Tool nach {brand} – mit Vorschau, Probelauf und einem Knopf zum Rückgängigmachen.</p>
      ) : (
        <PageHead title={`Umzug zu ${brand}`} sub={`Hol deine Kontakte, Listen, Deals und Kurse aus dem bisherigen Tool nach ${brand} – mit Vorschau, Probelauf und einem Knopf zum Rückgängigmachen.`} />
      )}
      {session.locations.length > 1 && (
        <div className="card um-target" data-tour="um-target">
          <Field label="Ziel: in diesen Sub-Account importieren" hint="Jeder Sub-Account bekommt seine eigenen Verbindungen und Umzüge.">
            <Select value={target} onChange={setTarget} options={session.locations.map((l) => [l.id, l.name] as [string, string])} />
          </Field>
        </div>
      )}
      <Wizard key={target} target={target} targetName={targetName} />
    </div>
  );
}

function Wizard({ target, targetName }: { target: string; targetName: string }) {
  const api = useMemo(() => umzugApi(target), [target]);
  const ov = useLoad(() => api.get<Overview>('/api/umzug'), [target]);
  const [step, setStep] = useState<Step>('source');
  const [source, setSource] = useState('');
  const [mode, setMode] = useState<'api' | 'file'>('api');
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [parts, setParts] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [options, setOptions] = useState({ merge: 'fill', tag: '', keep_files: false });
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [adopted, setAdopted] = useState(false);
  const d = ov.data;
  const src = d?.sources.find((s) => s.key === source);
  const files = (d?.files ?? []).filter((f) => f.source === source);

  const open = (j: Job) => {
    setSource(j.source);
    setJob(j);
    setStep('run');
  };
  // An import that is still running (page reloaded, other tab): show it.
  useEffect(() => {
    if (!d || adopted) return;
    setAdopted(true);
    const live = d.jobs.find(isLive);
    if (live) open(live);
  }, [d]);

  const pick = (key: string) => {
    const conn = d?.connections[key];
    const there = (d?.files ?? []).filter((f) => f.source === key);
    setSource(key);
    setPreview(null);
    setMapping({});
    setSelected(there.map((f) => f.id));
    setMode(!conn?.connected && there.length ? 'file' : 'api');
    setStep('connect');
  };

  const goPreview = async () => {
    if (!src) return;
    setBusy('preview');
    const ids = selected.filter((id) => files.some((f) => f.id === id));
    const r = await act(() => api.post<Preview>('/api/umzug/preview', mode === 'file' ? { source, origin: 'file', file_ids: ids } : { source, origin: 'api', parts: src.parts.map((p) => p.key) }));
    setBusy('');
    if (!r) return;
    setPreview(r);
    setMapping(r.mapping);
    setParts(mode === 'file' ? r.parts : src.parts.filter((p) => p.on !== false).map((p) => p.key));
    setStep('preview');
  };

  const payload = () => ({
    source,
    origin: mode,
    file_ids: mode === 'file' ? selected.filter((id) => files.some((f) => f.id === id)) : [],
    parts,
    mapping,
    options: { merge: options.merge, tag: options.tag.trim() || undefined, keep_files: mode === 'file' && options.keep_files },
  });
  const launch = async (kind: 'dry-run' | 'jobs') => {
    setBusy(kind);
    const j = await act(() => api.post<Job>(kind === 'dry-run' ? '/api/umzug/dry-run' : '/api/umzug/jobs', payload()));
    setBusy('');
    setConfirm(false);
    if (j) {
      setJob(j);
      setStep('run');
      void ov.reload();
    }
  };
  // "Jetzt importieren" after a dry run: the same choices, once more confirmed.
  const importAfterDry = (j: Job) => {
    if (preview && source === j.source) setConfirm(true);
    else {
      pick(j.source);
    }
  };

  if (ov.error) return <div className="card um-err">{ov.error}</div>;
  if (!d) return <Spinner />;

  const reachable: Record<Step, boolean> = { source: true, connect: !!src, preview: !!preview, run: !!job };
  const partDefs: PartDef[] = !preview ? [] : preview.origin === 'api' && src ? src.parts : preview.parts.map((p) => ({ key: p, label: PART_NAMES[p] ?? p }));
  const counts = (preview?.counts ?? []).filter((c) => parts.includes(c.part));
  const existing = Object.entries(preview?.existing ?? {}).filter(([k, n]) => n > 0 && EXISTING_LABELS[k] !== '');

  return (
    <>
      <ol className="um-steps" data-tour="um-steps">
        {STEPS.map(([k, l], i) => (
          <li key={k} className={k === step ? 'on' : reachable[k] && STEPS.findIndex(([s]) => s === step) > i ? 'done' : ''}>
            <button disabled={!reachable[k] || k === step} onClick={() => setStep(k)}>
              <span className="um-n">{i + 1}</span> {l}
            </button>
          </li>
        ))}
      </ol>

      {step === 'source' && (
        <>
          <div className="um-sources" data-tour="um-sources">
            {d.sources.map((s) => {
              const c = d.connections[s.key];
              const n = d.files.filter((f) => f.source === s.key).length;
              return (
                <button key={s.key} className="um-source card" onClick={() => pick(s.key)} data-source={s.key}>
                  <strong>{s.label}</strong>
                  <span className="muted small">{s.tagline}</span>
                  <span className="um-source-meta">
                    {c?.connected && <Badge tone="green">verbunden</Badge>}
                    {n > 0 && <Badge tone="blue">{n} Datei{n === 1 ? '' : 'en'}</Badge>}
                  </span>
                </button>
              );
            })}
          </div>
          <UmzugHistory jobs={d.jobs} onOpen={open} />
        </>
      )}

      {step === 'connect' && src && (
        <UmzugConnect
          api={api}
          src={src}
          conn={d.connections[src.key]}
          files={files}
          fileKinds={d.file_kinds}
          maxMb={d.max_upload_mb}
          mode={mode}
          onMode={setMode}
          selected={selected}
          onSelected={setSelected}
          onChanged={() => void ov.reload()}
          onNext={() => void goPreview()}
        />
      )}
      {step === 'connect' && busy === 'preview' && (
        <div className="um-reading muted">
          <Spinner />
          <span>Lese {src?.label} …</span>
        </div>
      )}

      {step === 'preview' && preview && src && (
        <div className="um-preview">
          <div className="card">
            <h3>
              {preview.label} → {targetName}
            </h3>
            <p className="muted small">Noch wurde nichts übernommen. Prüfe, was mitkommen soll, und starte erst einen Probelauf, wenn du magst.</p>
          </div>

          <div className="card" data-tour="um-parts">
            <h3>Was soll mitkommen?</h3>
            {partDefs.map((p) => (
              <div key={p.key} className="um-part">
                <Check checked={parts.includes(p.key)} onChange={(on) => setParts(on ? [...parts, p.key] : parts.filter((x) => x !== p.key))} label={p.label} />
                {p.note && <div className="muted small um-note">{p.note}</div>}
              </div>
            ))}
          </div>

          <div className="card" data-tour="um-counts">
            <h3>Das liegt bei {preview.label}</h3>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Was</th>
                    <th className="num">Anzahl</th>
                  </tr>
                </thead>
                <tbody>
                  {counts.length === 0 && (
                    <tr>
                      <td colSpan={2} className="muted">
                        Nichts ausgewählt.
                      </td>
                    </tr>
                  )}
                  {counts.map((c) => (
                    <tr key={`${c.part}-${c.key}`}>
                      <td>
                        {c.label}
                        {c.error && <span className="um-bad small"> · {c.error}</span>}
                      </td>
                      <td className="num">{c.total ?? '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {existing.length > 0 && (
              <p className="muted small um-existing">
                Aus früheren Umzügen kennt HyperLevel schon: {existing.map(([k, n]) => `${n} ${EXISTING_LABELS[k] ?? k}`).join(', ')}. Die werden aktualisiert – nichts wird doppelt angelegt.
              </p>
            )}
          </div>

          {preview.warnings.length > 0 && (
            <div className="card um-warn">
              <h3>Bitte beachten</h3>
              <ul>
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {parts.includes('contacts') && preview.fields.length > 0 && (
            <div className="card">
              <h3>Felder zuordnen</h3>
              <UmzugMapping fields={preview.fields} mapping={mapping} custom={preview.custom_fields} onChange={setMapping} />
              <details className="um-sum">
                <summary>Zusammenfassung der Zuordnung</summary>
                <ul>
                  {preview.fields
                    .filter((f) => mapping[f.ref])
                    .map((f) => (
                      <li key={f.ref}>
                        {f.label} → {targetLabel(mapping[f.ref], preview.custom_fields)}
                      </li>
                    ))}
                </ul>
              </details>
            </div>
          )}

          <div className="card" data-tour="um-options">
            <h3>Einstellungen</h3>
            <Field label="Gibt es den Kontakt schon (gleiche E-Mail oder Telefonnummer)?">
              <Select
                value={options.merge}
                onChange={(merge) => setOptions({ ...options, merge })}
                options={[
                  ['fill', 'Nur leere Felder auffüllen (empfohlen)'],
                  ['overwrite', 'Vorhandene Werte überschreiben'],
                ]}
              />
            </Field>
            <Field label="Alle übernommenen Kontakte zusätzlich taggen (optional)" hint="Zum Beispiel „Umzug Mailchimp“ – so findest du sie später wieder.">
              <Input value={options.tag} maxLength={80} onChange={(tag) => setOptions({ ...options, tag })} />
            </Field>
            {mode === 'file' && <Check checked={options.keep_files} onChange={(keep_files) => setOptions({ ...options, keep_files })} label="Hochgeladene Dateien nach dem Import behalten (sie enthalten Personendaten, Standard: löschen)" />}
          </div>

          <div className="um-actions um-sticky">
            <button className="btn ghost" onClick={() => setStep('connect')}>
              Zurück
            </button>
            <button className="btn secondary" disabled={!parts.length || !!busy} onClick={() => void launch('dry-run')} data-tour="um-dryrun">
              {busy === 'dry-run' ? 'Startet …' : 'Probelauf starten'}
            </button>
            <button className="btn" disabled={!parts.length || !!busy} onClick={() => setConfirm(true)} data-tour="um-start-import">
              Jetzt importieren
            </button>
          </div>
        </div>
      )}

      {step === 'run' && job && (
        <UmzugRun
          key={job.id}
          api={api}
          jobId={job.id}
          first={job}
          onJob={() => void ov.reload()}
          onImport={importAfterDry}
          onNew={() => {
            setJob(null);
            setPreview(null);
            setSource('');
            setStep('source');
          }}
        />
      )}

      {confirm && preview && (
        <Modal
          title="Umzug starten?"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button className="btn secondary" onClick={() => setConfirm(false)}>
                Abbrechen
              </button>
              <button className="btn" disabled={!!busy} onClick={() => void launch('jobs')} data-tour="um-confirm-start">
                {busy === 'jobs' ? 'Startet …' : 'Umzug starten'}
              </button>
            </>
          }
        >
          <p>
            <strong>{preview.label}</strong> → Sub-Account <strong>{targetName}</strong>
          </p>
          <p>Es kommt mit: {parts.map((p) => PART_NAMES[p] ?? p).join(', ')}.</p>
          <p className="muted small">
            Der Umzug läuft im Hintergrund, du kannst ihn pausieren und später fortsetzen. Schon vorhandene Kontakte werden {options.merge === 'fill' ? 'nur ergänzt' : 'überschrieben'}. Automationen kommen immer als Entwurf. Du kannst den ganzen Umzug danach rückgängig machen.
          </p>
        </Modal>
      )}
    </>
  );
}
