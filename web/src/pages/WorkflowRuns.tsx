import { useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from '../icons';
import { api, dt, name } from '../api';
import { Badge, Check, Empty, Field, Input, Modal, Spinner, Textarea, act, confirmAsk, navigate, toast, useLoad } from '../ui';
import { branchKeysOf, type ToolStep } from './WorkflowTools';
import './workflow-tools.css';
import { tr, useT } from '../i18n';

/**
 * Run log with the inputs and outputs of every step, the test run with sample data, versions with draft and publish,
 * split-test results and import/export of workflows as JSON. Docs: docs/workflow-actions.md.
 */

type Info = (type: string) => [IconName, string];

/** Every step of a tree in reading order (containers first, then their lanes). */
export function flatSteps(steps: ToolStep[]): ToolStep[] {
  return (steps ?? []).flatMap((s) => [s, ...branchKeysOf(s).flatMap((k) => flatSteps(s[k]))]);
}

const json = (v: unknown) => {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};
/** Status of a run in plain words (German labels = message ids of the workflows catalog). */
const RUN_STATUS: Record<string, string> = { completed: 'abgeschlossen', failed: 'fehlgeschlagen', waiting: 'wartet', active: 'läuft', running: 'läuft', stopped: 'gestoppt' };
export const runStatusLabel = (status: string) => (RUN_STATUS[status] ? tr('workflows')(RUN_STATUS[status]) : status);
const has = (v: unknown) => v !== undefined && v !== null && !(typeof v === 'object' && !Object.keys(v as object).length);

// --- run log ---------------------------------------------------------------------------------------

export function LogList({ log, steps, info }: { log: any[]; steps: ToolStep[]; info: Info }) {
  const t = useT('workflows');
  const byId = useMemo(() => new Map(flatSteps(steps).map((s) => [s.id, s])), [steps]);
  if (!log.length) return <p className="muted">{t('Noch keine Schritte ausgeführt.')}</p>;
  return (
    <ol className="wt-log" data-tour="wf-run-log">
      {log.map((l, i) => {
        const [icon, label] = info(l.type);
        const step = byId.get(l.step);
        const skipped = l.dry && String(l.result ?? '').startsWith('Trockenlauf: nicht');
        // a paused step (modules/workflow-pause.ts) the engine skipped – in real runs and test runs
        const paused = !!l.skipped;
        return (
          <li key={i} className={l.error ? 'err' : skipped || paused ? 'skip' : ''}>
            <div className="wt-log-head">
              <Icon name={icon} />
              <strong>
                {i + 1}. {label}
              </strong>
              {step?.name && <span className="wt-step-name">{step.name}</span>}
              {skipped && <Badge>{t('nicht ausgeführt')}</Badge>}
              {paused && <Badge tone="yellow">{t('übersprungen (pausiert)')}</Badge>}
              {l.dry && !skipped && !paused && <Badge tone="green">{t('berechnet')}</Badge>}
              <span className="t">
                {/* i18n-ignore – a duration */}
                {l.ms !== undefined ? `${l.ms} ms · ` : ''}
                {l.at ? dt(l.at) : ''}
              </span>
            </div>
            <p className={`wt-log-result${l.error ? ' bad' : ''}`}>{l.error ?? String(l.result ?? '')}</p>
            {(has(l.input) || has(l.output) || has(l.set)) && (
              <details>
                <summary>{t('Eingaben und Ausgaben')}</summary>
                <div className="wt-io">
                  {has(l.input) && (
                    <section>
                      <b>{t('Eingabe')}</b>
                      <pre className="wt-json">{json(l.input)}</pre>
                    </section>
                  )}
                  {has(l.output) && (
                    <section>
                      <b>{t('Ausgabe')}</b>
                      <pre className="wt-json">{json(l.output)}</pre>
                    </section>
                  )}
                  {has(l.set) && (
                    <section>
                      <b>{t('Gesetzt')}</b>
                      <pre className="wt-json">{json(l.set)}</pre>
                    </section>
                  )}
                </div>
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function VarsBox({ vars }: { vars: Record<string, unknown> }) {
  const t = useT('workflows');
  const keys = Object.keys(vars ?? {});
  if (!keys.length) return null;
  return (
    <details open style={{ margin: '12px 0 0' }}>
      <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
        {t('Variablen am Ende ({n})', { n: keys.length })}
      </summary>
      <div className="wt-io" style={{ marginTop: 6 }}>
        {keys.slice(0, 40).map((k) => (
          <section key={k}>
            <b>{`{{var.${k}}}`}</b>
            <pre className="wt-json">{json(vars[k])}</pre>
          </section>
        ))}
      </div>
    </details>
  );
}

export function RunLogModal({ run, steps, info, onClose }: { run: any; steps: ToolStep[]; info: Info; onClose: () => void }) {
  const t = useT('workflows');
  const full = useLoad(() => api.get<any>(`/api/workflow-runs/${run.id}`), [run.id]);
  const d = full.data;
  return (
    <Modal title={t('Protokoll: {name}', { name: name(run) })} onClose={onClose} wide>
      {!d && !full.error && <Spinner />}
      {full.error && <p className="muted">{t('Das Protokoll konnte nicht geladen werden:')} {full.error}</p>}
      {d && (
        <>
          <div className="wt-sum">
            <Badge tone={d.status === 'completed' ? 'green' : d.status === 'failed' ? 'red' : d.status === 'waiting' ? 'yellow' : 'blue'}>{runStatusLabel(d.status)}</Badge>
            <span className="muted small">{t('gestartet {date}', { date: dt(d.created_at) })}</span>
            {d.status === 'waiting' && <span className="muted small">{t('weiter am {date}', { date: dt(d.next_run_at) })}</span>}
          </div>
          <LogList log={d.log ?? []} steps={steps} info={info} />
          <VarsBox vars={d.vars ?? {}} />
        </>
      )}
    </Modal>
  );
}

// --- test run ----------------------------------------------------------------------------------------

const parse = (text: string, label: string): Record<string, any> | undefined => {
  if (!text.trim()) return undefined;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    const t = tr('workflows');
    throw new Error(t('{label}: kein gültiges JSON-Objekt', { label }));
  }
};

export function TestRunModal({ workflowId, draft, dirty, sample, steps, info, onClose }: { workflowId: string; draft: { trigger: any; steps: any[]; settings: any }; dirty: boolean; sample: Record<string, any>; steps: ToolStep[]; info: Info; onClose: () => void }) {
  const t = useT('workflows');
  const { contact: _c, ...eventSample } = sample ?? {};
  void _c;
  const [useDraft, setUseDraft] = useState(true);
  const [mode, setMode] = useState<'sample' | 'contact'>('sample');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [picked, setPicked] = useState<any>(null);
  const [contactJson, setContactJson] = useState('');
  const [eventJson, setEventJson] = useState(JSON.stringify(eventSample, null, 2));
  const [varsJson, setVarsJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  useEffect(() => {
    if (mode !== 'contact' || q.trim().length < 2) return setFound([]);
    const timer = setTimeout(() => api.get(`/api/contacts?q=${encodeURIComponent(q.trim())}&limit=6`).then((r) => setFound(r.contacts ?? []), () => setFound([])), 200);
    return () => clearTimeout(timer);
  }, [q, mode]);
  const run = async () => {
    let body: Record<string, any>;
    try {
      body = { sample: { contact: parse(contactJson, t('Kontakt')), event: parse(eventJson, t('Ereignis')), vars: parse(varsJson, t('Variablen')) } };
    } catch (e) {
      return void act(() => Promise.reject(e));
    }
    if (mode === 'contact') {
      if (!picked) return void act(() => Promise.reject(new Error(t('Bitte einen Kontakt wählen'))));
      body.contact_id = picked.id;
    }
    if (dirty && useDraft) body.workflow = { trigger: draft.trigger, steps: draft.steps, settings: draft.settings };
    setBusy(true);
    const r = await act(() => api.post(`/api/workflows/${workflowId}/test-run`, body));
    setBusy(false);
    if (r) setResult(r);
  };
  return (
    <Modal
      title={t('Testlauf')}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            {t('Schließen')}
          </button>
          <button className="btn" data-tour="wf-test-start" disabled={busy} onClick={run}>
            {busy ? t('Läuft …') : t('▶ Testlauf starten')}
          </button>
        </>
      }
    >
      <div className="wt-split">
        <div data-tour="wf-test-setup">
          <p className="wt-note" style={{ marginTop: 0 }}>
            {t('Spielt den Workflow mit Beispieldaten durch – ohne etwas zu senden oder zu ändern. Rechen-, Format-, Code-, Such- und Ablaufschritte laufen wirklich; Schritte mit Außenwirkung zeigen nur, was sie tun würden.')}
          </p>
          <Field label={t('Kontakt')}>
            <select value={mode} onChange={(e) => setMode(e.target.value as 'sample' | 'contact')}>
              <option value="sample">{t('Beispielkontakt (Erika Muster)')}</option>
              <option value="contact">{t('Echten Kontakt lesen (wird nicht verändert)')}</option>
            </select>
          </Field>
          {mode === 'contact' && (
            <>
              <Input value={q} onChange={(v) => (setQ(v), setPicked(null))} placeholder={t('Kontakt suchen …')} aria-label={t('Kontakt suchen')} />
              {picked ? (
                <p className="wt-note">{t('Gewählt:')} {name(picked)}</p>
              ) : (
                found.map((c) => (
                  <button key={c.id} type="button" className="btn small ghost" style={{ display: 'flex' }} onClick={() => setPicked(c)}>
                    {name(c)} <span className="muted">{c.email}</span>
                  </button>
                ))
              )}
            </>
          )}
          {dirty && <Check checked={useDraft} onChange={setUseDraft} label={t('Mit meinen ungespeicherten Änderungen testen')} />}
          <details style={{ marginTop: 10 }}>
            <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
              {t('Beispieldaten bearbeiten')}
            </summary>
            {mode === 'sample' && (
              <Field label={t('Kontakt überschreiben (JSON, optional)')} hint={t('z. B. {"tags": ["vip"], "custom": {"budget": "2500"}}')}>
                <Textarea className="wt-code" value={contactJson} onChange={setContactJson} rows={3} spellCheck={false} />
              </Field>
            )}
            <Field label={t('Ereignis ({{event.…}}, JSON)')}>
              <Textarea className="wt-code" value={eventJson} onChange={setEventJson} rows={6} spellCheck={false} />
            </Field>
            <Field label={t('Variablen vorbelegen ({{var.…}}, JSON, optional)')}>
              <Textarea className="wt-code" value={varsJson} onChange={setVarsJson} rows={3} spellCheck={false} />
            </Field>
          </details>
        </div>
        <div data-tour="wf-test-result">
          {!result && <Empty>{t('Noch kein Testlauf – links Daten wählen und starten.')}</Empty>}
          {result && (
            <>
              <div className="wt-sum">
                <Badge tone={result.status === 'completed' ? 'green' : result.status === 'failed' ? 'red' : 'yellow'}>{result.status === 'completed' ? t('durchgelaufen') : result.status === 'waiting' ? t('würde warten') : result.status}</Badge>
                <span className="muted small">
                  {[t.plural(result.summary.steps, { other: '{n} Schritte' }), t.plural(result.summary.skipped, { other: '{n} nicht ausgeführt' }), t.plural(result.summary.errors, { other: '{n} Fehler' }), `${result.ms} ms`].join(' · ')}
                </span>
              </div>
              <LogList log={result.log} steps={steps} info={info} />
              <VarsBox vars={result.vars} />
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// --- split test results ---------------------------------------------------------------------------------

export function SplitStats({ workflowId }: { workflowId: string }) {
  const t = useT('workflows');
  const s = useLoad(() => api.get<{ tests: any[] }>(`/api/workflows/${workflowId}/split-stats`), [workflowId]);
  if (!s.data?.tests.length) return null;
  return (
    <div className="card" style={{ marginBottom: 14 }} data-tour="wf-split-stats">
      <h3 style={{ marginTop: 0 }}>{t('Split-Tests')}</h3>
      {s.data.tests.map((test) => {
        const max = Math.max(1, ...test.variants.map((v: any) => v.goal_rate));
        return (
          <div key={test.step_id} style={{ marginBottom: 12 }}>
            <strong>{test.name}</strong>
            <table className="wt-stats">
              <thead>
                <tr>
                  <th>{t('Pfad')}</th>
                  <th>{t('Zugewiesen')}</th>
                  <th>{t('Läuft')}</th>
                  <th>{t('Abgeschlossen')}</th>
                  <th>{t('Ziel erreicht')}</th>
                  <th style={{ width: '30%' }}>{t('Rate')}</th>
                </tr>
              </thead>
              <tbody>
                {test.variants.map((v: any) => (
                  <tr key={v.index}>
                    <td>{v.name}</td>
                    <td>{v.assigned}</td>
                    <td>{v.running}</td>
                    <td>{v.completed}</td>
                    <td>{v.goals}</td>
                    <td>
                      <div className="wt-bar" title={`${v.goal_rate} %`}>
                        <i style={{ width: `${(v.goal_rate / max) * 100}%` }} />
                      </div>
                      <small className="muted">{v.goal_rate} %</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <p className="wt-note">{t('„Ziel erreicht“ zählt Kontakte, die danach einen Schritt „Ziel erreicht?“ oder „Ziel-Sprung“ bestanden haben. Ab etwa 30 Kontakten je Pfad sind die Zahlen aussagekräftig.')}</p>
    </div>
  );
}

// --- versions, draft, publish ------------------------------------------------------------------------------

function Outline({ steps, info, depth = 0 }: { steps: ToolStep[]; info: Info; depth?: number }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 18 + (depth ? 0 : 0), listStyle: depth ? 'circle' : 'none' }}>
      {(steps ?? []).map((s) => (
        <li key={s.id} style={{ margin: '3px 0' }}>
          <Icon name={info(s.type)[0]} /> {info(s.type)[1]}
          {s.name ? <span className="wt-step-name"> – {s.name}</span> : null}
          {branchKeysOf(s).map((k) => (s[k]?.length ? <Outline key={k} steps={s[k]} info={info} depth={depth + 1} /> : null))}
        </li>
      ))}
    </ul>
  );
}

export function VersionsTab({
  id,
  current,
  dirty,
  info,
  triggerLabel,
  onLoadDraft,
  onPublished,
}: {
  id: string;
  /** What the editor holds right now. */
  current: { name: string; trigger: any; steps: any[]; settings: any };
  dirty: boolean;
  info: Info;
  triggerLabel: (type?: string) => string;
  onLoadDraft: (d: any) => void;
  onPublished: (wf: any) => void;
}) {
  const t = useT('workflows');
  const v = useLoad(() => api.get<any>(`/api/workflows/${id}/versions`), [id]);
  const [note, setNote] = useState('');
  const [view, setView] = useState<any>(null);
  const d = v.data;
  const saveDraft = async () => {
    if (await act(() => api.put(`/api/workflows/${id}/draft`, current), t('Als Entwurf gespeichert – live ist noch alles unverändert'))) v.reload();
  };
  const loadDraft = async () => {
    const r = await act(() => api.get<any>(`/api/workflows/${id}/draft`));
    if (r?.draft) {
      onLoadDraft(r.draft);
      toast(t('Entwurf im Editor geladen – speichern oder veröffentlichen'));
    }
  };
  const publish = async () => {
    if (!confirmAsk(t('Entwurf veröffentlichen? Er ersetzt den aktuellen Workflow sofort.'))) return;
    const r = await act(() => api.post(`/api/workflows/${id}/publish`, { note }), t('Veröffentlicht'));
    if (r) {
      setNote('');
      onPublished(r);
      v.reload();
    }
  };
  const open = async (n: number) => {
    const r = await act(() => api.get<any>(`/api/workflows/${id}/versions/${n}`));
    if (r) setView(r);
  };
  const restore = async (n: number) => {
    const r = await act(() => api.post<{ message: string }>(`/api/workflows/${id}/versions/${n}/restore`));
    if (r) {
      toast(r.message);
      v.reload();
    }
  };
  if (!d) return <Spinner />;
  return (
    <div style={{ maxWidth: 820 }} data-tour="wf-versions">
      <div className="card" data-tour="wf-draft">
        <h3 style={{ marginTop: 0 }}>{t('Entwurf')}</h3>
        <p className="wt-note" style={{ marginTop: 0 }}>
          {t('„Speichern“ im Editor ändert den Workflow sofort. Wer größere Umbauten vorbereitet, legt sie als Entwurf ab, testet sie mit dem Testlauf und veröffentlicht erst dann – jede Veröffentlichung wird eine Version mit Notiz.')}
        </p>
        {d.draft ? (
          <p>
            {t('Es gibt einen Entwurf von')} <strong>{d.draft.user_name || t('jemandem')}</strong> ({dt(d.draft.updated_at)}).
          </p>
        ) : (
          <p className="muted">{t('Kein Entwurf vorhanden.')}</p>
        )}
        <div className="row">
          <button className="btn secondary" onClick={saveDraft}>
            {dirty ? t('Meine Änderungen als Entwurf speichern') : t('Aktuellen Stand als Entwurf speichern')}
          </button>
          {d.draft && (
            <>
              <button className="btn secondary" onClick={loadDraft}>
                {t('Entwurf im Editor laden')}
              </button>
              <button className="btn ghost" onClick={async () => confirmAsk(t('Entwurf verwerfen?')) && (await act(() => api.del(`/api/workflows/${id}/draft`))) && v.reload()}>
                {t('Verwerfen')}
              </button>
            </>
          )}
        </div>
        {d.draft && (
          <div className="row" style={{ marginTop: 10, alignItems: 'flex-end' }}>
            <div className="grow">
              <Field label={t('Notiz zur Version (optional)')}>
                <Input value={note} onChange={setNote} placeholder={t('z. B. Split-Test für die Betreffzeile')} maxLength={300} />
              </Field>
            </div>
            <button className="btn" style={{ marginBottom: 12 }} onClick={publish}>
              {t('Entwurf veröffentlichen')}
            </button>
          </div>
        )}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('Versionen ({n})', { n: d.versions.length })}</h3>
        {!d.versions.length && <Empty>{t('Noch keine Version – sie entsteht beim nächsten Speichern.')}</Empty>}
        <ul className="wt-ver">
          {d.versions.map((x: any) => (
            <li key={x.id}>
              <span className="v">v{x.version}</span>
              <span>
                {x.name} {x.hash === d.current_hash && <Badge tone="green">{t('aktuell')}</Badge>} {x.note && <Badge tone="blue">{x.note}</Badge>}
              </span>
              <span className="acts">
                <button className="btn small secondary" onClick={() => open(x.version)}>
                  {t('Ansehen')}
                </button>
                {x.hash !== d.current_hash && (
                  <button className="btn small ghost" onClick={() => restore(x.version)}>
                    {t('Als Entwurf wiederherstellen')}
                  </button>
                )}
              </span>
              <span className="sub">
                {dt(x.created_at)} · {x.user_name || t('System')} · {t.plural(x.steps, { other: '{n} Schritte' })} · {x.summary}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {view && (
        <Modal title={t('Version {n}', { n: view.version })} onClose={() => setView(null)}>
          <p className="muted small">
            {dt(view.created_at)} · {view.user_name || t('System')} · {t('Auslöser: {name}', { name: triggerLabel(view.workflow?.trigger?.type) })}
          </p>
          <Outline steps={view.workflow?.steps ?? []} info={info} />
          <details style={{ marginTop: 10 }}>
            <summary className="small" style={{ cursor: 'pointer' }}>
              JSON
            </summary>
            <pre className="wt-json">{json(view.workflow)}</pre>
          </details>
        </Modal>
      )}
    </div>
  );
}

// --- import / export ---------------------------------------------------------------------------------------------

/** Offers a JSON document as a file download. */
export function downloadJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[^\w.-]+/g, '-').slice(0, 80) || 'workflow.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportWorkflow(id: string, label: string) {
  const data = await act(() => api.get(`/api/workflows/${id}/export`));
  if (data) downloadJson(`workflow-${label}.json`, data);
}
export async function exportAll() {
  const data = await act(() => api.get('/api/workflow-export'));
  if (data) downloadJson('workflows.json', data);
}

export function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT('workflows');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any[] | null>(null);
  const readFile = (f?: File | null) => {
    if (!f) return;
    if (f.size > 2_000_000) return void act(() => Promise.reject(new Error(t('Die Datei ist zu groß (über 2 MB)'))));
    const r = new FileReader();
    r.onload = () => setText(String(r.result ?? ''));
    r.readAsText(f);
  };
  const run = async () => {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return void act(() => Promise.reject(new Error(t('Das ist kein gültiges JSON'))));
    }
    setBusy(true);
    const r = await act(() => api.post<{ imported: any[] }>('/api/workflow-import', { data }));
    setBusy(false);
    if (r) {
      setDone(r.imported);
      onDone();
    }
  };
  return (
    <Modal
      title={t('Workflow importieren')}
      onClose={onClose}
      footer={
        done ? (
          <button className="btn" onClick={onClose}>
            {t('Fertig')}
          </button>
        ) : (
          <>
            <button className="btn secondary" onClick={onClose}>
              {t('Abbrechen')}
            </button>
            <button className="btn" disabled={busy || !text.trim()} onClick={run} data-tour="wf-import-run">
              {busy ? t('Importiert …') : t('Importieren')}
            </button>
          </>
        )
      }
    >
      {!done ? (
        <>
          <p className="wt-note" style={{ marginTop: 0 }}>
            {t('Datei oder Text eines Exports (Format „gohigh-workflow“). Importierte Workflows sind Entwürfe – nie aktiv. Verweise auf Pipelines, Formulare usw. prüfst du danach (Hinweise erscheinen hier).')}
          </p>
          <div className="wt-drop" data-tour="wf-import-file">
            <input type="file" accept=".json,application/json" aria-label={t('Export-Datei wählen')} onChange={(e) => readFile(e.target.files?.[0])} />
          </div>
          <Field label={t('oder JSON einfügen')}>
            <Textarea className="wt-code" value={text} onChange={setText} rows={8} spellCheck={false} placeholder={'{ "format": "gohigh-workflow", … }' /* i18n-ignore */} />
          </Field>
        </>
      ) : (
        <>
          {done.map((w) => (
            <div key={w.id} style={{ marginBottom: 10 }}>
              <strong>{w.name}</strong> <span className="muted small">({t.plural(w.steps, { other: '{n} Schritte' })})</span>{' '}
              <button className="btn small secondary" onClick={() => (onClose(), navigate(`workflows/${w.id}`))}>
                {t('Öffnen')}
              </button>
              {!!w.warnings?.length && (
                <ul className="wt-warn">
                  {w.warnings.map((x: string, i: number) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}
