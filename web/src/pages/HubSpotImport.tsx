import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { Badge, Check, Field, Input, Spinner, act, confirmAsk, navigate, useLoad } from '../ui';

/** Einstellungen → Import → HubSpot: token, dry run with counts, resumable import with progress. */

const STEP_LABELS: Record<string, string> = {
  owners: 'Owner',
  properties: 'Eigenschaften',
  companies: 'Firmen',
  contacts: 'Kontakte',
  lists: 'Listen',
  pipelines: 'Pipelines',
  deals: 'Deals',
  notes: 'Notizen',
  tasks: 'Aufgaben',
  calls: 'Anrufe',
  emails: 'E-Mails',
  meetings: 'Meetings',
  tickets: 'Tickets',
};
const PART_STEPS: Record<string, string[]> = {
  owners: ['owners'],
  contacts: ['properties', 'contacts'],
  companies: ['companies'],
  lists: ['lists'],
  deals: ['pipelines', 'deals'],
  notes: ['notes'],
  tasks: ['tasks'],
  engagements: ['calls', 'emails', 'meetings'],
  tickets: ['tickets'],
};
const ORDER = ['owners', 'properties', 'companies', 'contacts', 'lists', 'pipelines', 'deals', 'notes', 'tasks', 'calls', 'emails', 'meetings', 'tickets'];
const JOB_STATUS: Record<string, [string, 'blue' | 'green' | 'red' | 'yellow']> = { running: ['läuft', 'blue'], done: ['fertig', 'green'], failed: ['abgebrochen', 'red'], interrupted: ['pausiert', 'yellow'] };

export function HubSpotImport() {
  const st = useLoad(() => api.get<any>('/api/import/hubspot'), []);
  const [token, setToken] = useState('');
  const [parts, setParts] = useState<string[] | null>(null);
  const [busy, setBusy] = useState('');
  const [job, setJob] = useState<any>(null);
  const s = st.data;
  useEffect(() => {
    if (s && !parts) setParts(s.parts.map((p: any) => p.key));
    if (s?.job && !job) setJob(s.job);
  }, [s]);
  useEffect(() => {
    if (job?.status !== 'running') return;
    const timer = setInterval(async () => {
      const next = await api.get(`/api/import/hubspot/jobs/${job.id}`).catch(() => null);
      if (next) setJob(next);
    }, 1500);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  if (!s || !parts) return <Spinner />;
  const run = async (key: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(key);
    const r = await act(fn, ok);
    setBusy('');
    return r;
  };
  const dry = s.dry_run;
  const steps = ORDER.filter((x) => (job?.parts ?? parts).some((p: string) => PART_STEPS[p]?.includes(x)));
  const done: string[] = job?.progress?.done_steps ?? [];
  const pct = job ? Math.round((done.length / Math.max(1, steps.length)) * 100) : 0;
  const totals: Record<string, number> = Object.fromEntries((dry?.result ?? []).map((r: any) => [r.object, r.hubspot ?? 0]));
  return (
    <div className="card hs-import" data-tour="hs-import">
      <h2>Von HubSpot umziehen</h2>
      <p className="muted">
        Holt Owner (als Nutzer per E-Mail), Kontakte mit allen eigenen Eigenschaften, Firmen, Deals mit Pipelines, Notizen, Aufgaben, Anrufe/E-Mails/Meetings als Verlauf, Tickets und Listen (als Tags) in diesen Sub-Account. Mehrfach ausführbar – aktualisiert statt zu verdoppeln; ein
        abgebrochener Import macht an derselben Stelle weiter.
      </p>
      <ol className="muted small">
        <li>
          In HubSpot: <strong>Einstellungen → Integrationen → Private Apps → „Private App erstellen“</strong>.
        </li>
        <li>
          Scopes (lesen): <code>crm.objects.contacts.read</code>, <code>crm.objects.companies.read</code>, <code>crm.objects.deals.read</code>, <code>crm.objects.owners.read</code>, <code>crm.schemas.contacts.read</code>, <code>crm.lists.read</code>, <code>tickets</code>,{' '}
          <code>sales-email-read</code>.
        </li>
        <li>Token (pat-…) hier eintragen – er wird verschlüsselt gespeichert und nie wieder angezeigt.</li>
      </ol>

      {s.connection.connected ? (
        <div className="row hs-conn">
          <Badge tone="green">verbunden</Badge>
          <span>
            HubSpot-Portal <strong>{s.connection.portal_id}</strong> · Token {s.connection.token_hint}
            {s.connection.time_zone ? ` · ${s.connection.time_zone}` : ''}
          </span>
          <button className="btn small ghost" disabled={job?.status === 'running'} onClick={() => confirmAsk('HubSpot-Token entfernen? Importierte Daten bleiben.') && run('disconnect', () => api.del('/api/import/hubspot/connection'), 'Getrennt').then(st.reload)}>
            Trennen
          </button>
        </div>
      ) : (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="grow">
            <Field label="HubSpot Private-App-Token" tour="hs-token">
              <Input type="password" value={token} onChange={setToken} placeholder="pat-eu1-…" autoComplete="off" />
            </Field>
          </div>
          <button className="btn" style={{ marginBottom: 12 }} disabled={!token || !!busy} onClick={() => run('connect', () => api.put('/api/import/hubspot/connection', { token }), 'Verbunden').then((r) => r && (setToken(''), st.reload()))}>
            Verbinden
          </button>
        </div>
      )}

      <h3 className="integ-h">Was soll mit?</h3>
      <div className="hs-parts" data-tour="hs-parts">
        {s.parts.map((p: any) => (
          <Check key={p.key} checked={parts.includes(p.key)} onChange={(on) => setParts(on ? [...parts, p.key] : parts.filter((x) => x !== p.key))} label={p.label} />
        ))}
      </div>
      <p className="muted small">
        {s.modules.companies ? 'Firmen landen im Firmen-Modul und werden mit ihren Kontakten verknüpft.' : 'Kein Firmen-Modul installiert: der Firmenname kommt ins Kontaktfeld „Firma“.'}{' '}
        {s.modules.tickets ? 'Tickets gehen in den Helpdesk.' : 'Tickets werden übersprungen, solange kein Helpdesk-Modul installiert ist.'} Deals, Notizen und Verlauf hängen an importierten Kontakten.
      </p>
      <div className="row" style={{ gap: 8 }} data-tour="hs-run">
        <button className="btn secondary" disabled={!s.connection.connected || !parts.length || !!busy || job?.status === 'running'} onClick={() => run('dry', () => api.post('/api/import/hubspot/dry-run', { parts })).then((r) => r && st.setData({ ...s, dry_run: r }))}>
          {busy === 'dry' ? 'Zählt …' : 'Probelauf'}
        </button>
        <button className="btn" disabled={!s.connection.connected || !parts.length || !!busy || job?.status === 'running'} onClick={() => run('start', () => api.post('/api/import/hubspot/start', { parts }), 'Import gestartet').then((r) => r && setJob(r))}>
          Import starten
        </button>
      </div>

      {dry && (
        <div className="hs-dry">
          <div className="muted small">Probelauf vom {dt(dry.created_at)}</div>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Bereich</th>
                  <th className="num">In HubSpot</th>
                  <th className="num">Schon importiert</th>
                  <th className="num">Neu</th>
                </tr>
              </thead>
              <tbody>
                {dry.result.map((r: any) => (
                  <tr key={r.object}>
                    <td>
                      {r.label}
                      {r.error && <div className="small hs-err">{r.error}</div>}
                    </td>
                    <td className="num">{r.hubspot ?? '–'}</td>
                    <td className="num">{r.imported}</td>
                    <td className="num">
                      <strong>{r.new ?? '–'}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {job && (
        <div className="hs-job" data-tour="hs-job">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>
              Import <Badge tone={JOB_STATUS[job.status]?.[1] ?? 'blue'}>{JOB_STATUS[job.status]?.[0] ?? job.status}</Badge>
            </strong>
            <div className="row" style={{ gap: 6 }}>
              {job.status === 'running' && (
                <button className="btn small secondary" onClick={() => act(() => api.post(`/api/import/hubspot/jobs/${job.id}/pause`, {}), 'Wird nach dieser Seite pausiert')}>
                  Pausieren
                </button>
              )}
              {['failed', 'interrupted'].includes(job.status) && (
                <button className="btn small" onClick={() => run('resume', () => api.post(`/api/import/hubspot/jobs/${job.id}/resume`, {})).then((r) => r && setJob(r))}>
                  Fortsetzen
                </button>
              )}
              {job.status === 'done' && (
                <button className="btn small secondary" onClick={() => navigate('contacts')}>
                  Zu den Kontakten
                </button>
              )}
            </div>
          </div>
          <div className="hs-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${job.status === 'done' ? 100 : pct}%` }} />
          </div>
          <div className="hs-steps">
            {steps.map((x) => {
              const isDone = done.includes(x) || job.status === 'done';
              const current = !isDone && job.progress?.step === x;
              const n = job.progress?.counts?.[x === 'properties' ? 'custom_fields' : x];
              return (
                <span key={x} className={`hs-step${isDone ? ' done' : ''}${current ? ' now' : ''}`}>
                  {isDone ? '✓' : current ? '…' : '·'} {STEP_LABELS[x] ?? x}
                  {n !== undefined ? ` ${n}` : current && job.progress?.processed ? ` ${job.progress.processed}${totals[x] ? `/${totals[x]}` : ''}` : ''}
                </span>
              );
            })}
          </div>
          {job.error && <p className="hs-err small">{job.error}</p>}
          {job.progress?.notes?.length > 0 && (
            <ul className="small muted hs-notes">
              {job.progress.notes.slice(0, 8).map((n: string) => (
                <li key={n}>{n}</li>
              ))}
              {job.progress.notes.length > 8 && <li>… und {job.progress.notes.length - 8} weitere Hinweise</li>}
            </ul>
          )}
          <details>
            <summary className="small">Protokoll</summary>
            <pre className="hook-pre">{(job.log ?? []).join('\n')}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
