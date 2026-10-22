import { useState, type ReactNode } from 'react';
import { api, ago, dt } from '../api';
import { Icon } from '../icons';
import { useSession } from '../session';
import { act, Badge, Check, Empty, Field, Input, Link, Modal, pressable, Select, Spinner, Stat, Tabs, Textarea, useLoad } from '../ui';
import { KIND, Shots, StatusPill, Thread } from './Feedback';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Agency side of „Fehler & Wünsche“: the panel on such tickets (diagnostics, screenshots,
 * occurrences, affected users and sub-accounts, votes) with „Als Duplikat von …“, „Behoben in
 * Version …“, public answer and decline – and the agency tab with the support sub-account setting
 * and the triage lists (open reports, top wishes, most frequent errors).
 */

function Section({ title, children, open }: { title: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="fb-sec" open={open}>
      <summary>{title}</summary>
      <div className="fb-sec-body">{children}</div>
    </details>
  );
}

function KV({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!shown.length) return null;
  return (
    <dl className="fb-kv">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Diagnostics({ d, kind }: { d: any; kind: string }) {
  if (!d || !Object.keys(d).length) return <p className="muted small">Keine Diagnosedaten{d?.removed ? ' – vom Melder entfernt' : ''}.</p>;
  const dv = d.device ?? {};
  const stale = d.build && d.server_web_build && d.build !== d.server_web_build && d.build !== 'dev';
  return (
    <>
      <KV
        rows={[
          ['Seite', d.route || d.url],
          ['URL', d.url && d.url !== d.route ? <span className="mono">{d.url}</span> : ''],
          ['Sub-Account', d.location_name],
          ['Rolle', d.role],
          ['Version', [d.app_version ? `App ${d.app_version}` : '', d.build ? `Web-Build ${d.build}` : '', d.server_version ? `Server ${d.server_version}` : ''].filter(Boolean).join(' · ')],
          ['Achtung', stale ? 'Der Browser lief mit einer älteren Web-Version (Seite nicht neu geladen).' : ''],
          ['Browser', [d.browser, d.os].filter(Boolean).join(' · ')],
          ['Gerät', dv.model ? `${dv.manufacturer ? `${dv.manufacturer} ` : ''}${dv.model} · Android ${dv.android ?? '?'}${dv.sdk ? ` (API ${dv.sdk})` : ''}` : ''],
          ['Fenster', [d.viewport, d.screen].filter(Boolean).join(' · Bildschirm ')],
          ['Sprache / Zone', [d.language, d.timezone].filter(Boolean).join(' · ')],
          ['Request-ID', d.request_id ? <span className="mono">{d.request_id}</span> : ''],
          ['User-Agent', d.user_agent ? <span className="mono small">{d.user_agent}</span> : ''],
        ]}
      />
      {d.message && kind === 'auto' && (
        <Section title="Fehlermeldung & Stack" open>
          <pre className="fb-pre">{`${d.message}\n\n${d.stack ?? ''}`.trim()}</pre>
        </Section>
      )}
      {d.errors?.length > 0 && (
        <Section title={`Letzte Fehler im Browser (${d.errors.length})`} open={kind !== 'auto'}>
          {d.errors
            .slice()
            .reverse()
            .map((e: any, i: number) => (
              <div key={i} className="fb-err">
                <strong>{e.message}</strong>
                {e.count > 1 && <Badge>{e.count}×</Badge>} <span className="muted small">{e.at ? dt(e.at) : ''}</span>
                {e.stack && <pre className="fb-pre">{e.stack}</pre>}
              </div>
            ))}
        </Section>
      )}
      {d.api_errors?.length > 0 && (
        <Section title={`Fehlgeschlagene Anfragen (${d.api_errors.length})`} open>
          <table className="t fb-table">
            <tbody>
              {d.api_errors
                .slice()
                .reverse()
                .map((e: any, i: number) => (
                  <tr key={i}>
                    <td>
                      <Badge tone={e.status >= 500 || e.status === 0 ? 'red' : 'yellow'}>{e.status || 'Netz'}</Badge>
                    </td>
                    <td className="mono">
                      {e.method} {e.path}
                    </td>
                    <td>{e.error}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Section>
      )}
      {d.samples?.length > 0 && (
        <Section title={`Letzte Vorkommen (${d.samples.length})`} open={kind === 'auto'}>
          <table className="t fb-table">
            <tbody>
              {d.samples
                .slice()
                .reverse()
                .map((s: any, i: number) => (
                  <tr key={i}>
                    <td className="small">{dt(s.at)}</td>
                    <td className="mono small">{s.route}</td>
                    <td className="small">{[s.role, s.version].filter(Boolean).join(' · ')}</td>
                    <td className="mono small">{s.request_id}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}

const SEVERITY: Record<string, string> = { gering: 'Kleinigkeit', mittel: 'Stört bei der Arbeit', hoch: 'Blockiert', kritisch: 'Kritisch' };

type Dialog = null | 'duplicate' | 'fixed' | 'reply' | 'decline';

/** Panel on a ticket of the pipeline „Fehler & Wünsche“ (nothing for other tickets). */
export function BugTriagePanel({ ticketId, onChanged }: { ticketId: string; onChanged?: () => void }) {
  const session = useSession();
  const { data, reload } = useLoad(() => (session.user.role === 'admin' ? api.get(`/api/feedback/admin/by-ticket/${ticketId}`) : Promise.resolve({ item: null })), [ticketId]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [form, setForm] = useState({ of: '', version: '', note: '', shipped: true, reply: '', reason: '' });
  const [search, setSearch] = useState('');
  const candidates = useLoad(
    () => (dialog === 'duplicate' ? api.get<any[]>(`/api/feedback/admin/items?kind=all&state=all&limit=20&q=${encodeURIComponent(search)}`) : Promise.resolve([])),
    [dialog, search],
  );
  const f = data?.item;
  if (!f) return null;
  const done = () => {
    setDialog(null);
    reload();
    onChanged?.();
  };
  const patch = async (body: any, ok: string) => (await act(() => api.patch(`/api/feedback/admin/items/${f.id}`, body), ok)) && done();
  const set = (k: keyof typeof form) => (v: any) => setForm((x) => ({ ...x, [k]: v }));
  return (
    <div className="card fb-panel" data-tour="ticket-feedback">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>
          <Icon name={KIND[f.kind]?.[1] ?? 'bug'} size={16} /> {f.kind === 'wish' ? 'Wunsch' : 'Fehler & Wünsche'}
        </h2>
        <StatusPill s={f.status} />
      </div>
      <div className="fb-panel-grid">
        <div>
          <div className="fb-panel-stats">
            {f.kind === 'wish' && (
              <span>
                <strong>{f.votes}</strong> Stimmen
              </span>
            )}
            {f.kind === 'auto' && (
              <span>
                <strong>{f.occurrences}×</strong> aufgetreten
              </span>
            )}
            <span>
              <strong>{f.reporters.length}</strong> {f.kind === 'auto' ? 'Nutzer' : 'Melder'}
            </span>
            <span>
              <strong>{f.locations.length}</strong> Sub-Accounts
            </span>
          </div>
          <KV
            rows={[
              ['Art', `${KIND[f.kind]?.[0] ?? f.kind}${f.platform === 'android' ? ' · Android-App' : f.platform === 'server' ? ' · Server' : ''}`],
              ['Schweregrad', SEVERITY[f.severity] ?? f.severity],
              ['Bereich', f.area],
              ['Erstes / letztes Mal', f.kind === 'auto' ? `${dt(f.first_seen_at)} / ${ago(f.last_seen_at)}` : ''],
              ['Version', f.version ? `${f.kind === 'wish' ? 'umgesetzt' : 'behoben'} in ${f.version}${f.public_note ? ` – ${f.public_note}` : ''}` : ''],
              ['Begründung', f.status.key === 'abgelehnt' ? f.public_note : ''],
            ]}
          />
          {f.duplicate_of && (
            <p className="small">
              Duplikat von{' '}
              <Link to={`tickets/${f.duplicate_of.ticket_id}`}>
                #{f.duplicate_of.number} {f.duplicate_of.title}
              </Link>
            </p>
          )}
          {f.duplicates.length > 0 && (
            <p className="small">
              Duplikate:{' '}
              {f.duplicates.map((d: any) => (
                <span key={d.id} style={{ marginRight: 8 }}>
                  <Link to={`tickets/${d.ticket_id}`}>#{d.number}</Link>
                </span>
              ))}
            </p>
          )}
          <div className="actions fb-panel-actions">
            {!f.duplicate_of && (
              <button className="btn small secondary" data-tour="fb-duplicate" onClick={() => setDialog('duplicate')}>
                <Icon name="merge" size={13} /> Als Duplikat von …
              </button>
            )}
            <button className="btn small" data-tour="fb-fixed" onClick={() => (setForm((x) => ({ ...x, version: f.version || '', note: f.public_note || '' })), setDialog('fixed'))}>
              <Icon name="ok" size={13} /> {f.kind === 'wish' ? 'Fertig in Version …' : 'Behoben in Version …'}
            </button>
            {f.kind !== 'auto' && (
              <button className="btn small secondary" onClick={() => setDialog('reply')}>
                <Icon name="send" size={13} /> Öffentlich antworten
              </button>
            )}
            {f.status.key !== 'abgelehnt' && (
              <button className="btn small secondary" onClick={() => setDialog('decline')}>
                <Icon name="stop" size={13} /> Ablehnen
              </button>
            )}
            {f.kind === 'wish' && (
              <button className="btn small ghost" onClick={() => patch({ hidden: !f.hidden }, f.hidden ? 'Wieder sichtbar' : 'Ausgeblendet')}>
                {f.hidden ? 'In Wunschliste zeigen' : 'In Wunschliste ausblenden'}
              </button>
            )}
          </div>
          {f.reporters.length > 0 && (
            <Section title={`${f.kind === 'auto' ? 'Betroffene Nutzer' : 'Melder'} (${f.reporters.length})`} open={f.kind !== 'auto'}>
              {f.reporters.map((r: any) => (
                <div key={r.user_id} className="fb-person">
                  <strong>{r.name}</strong> <span className="muted small">{[r.role, r.location_name, r.link === 'reporter' ? '' : 'betroffen'].filter(Boolean).join(' · ')}</span>
                  <div className="muted small">{r.email}</div>
                </div>
              ))}
            </Section>
          )}
          {f.locations.length > 0 && (
            <Section title={`Betroffene Sub-Accounts (${f.locations.length})`}>
              <div className="chips">
                {f.locations.map((l: any) => (
                  <span key={l.id} className="chip">
                    {l.name} <b>{l.n}</b>
                  </span>
                ))}
              </div>
            </Section>
          )}
          {f.kind === 'wish' && f.voters.length > 0 && (
            <Section title={`Abgestimmt (${f.votes})`}>
              <p className="small" style={{ margin: 0 }}>
                {f.voters.join(', ')}
              </p>
            </Section>
          )}
          {f.files.length > 0 && (
            <Section title={`Screenshots (${f.files.length})`} open>
              <Shots files={f.files} />
            </Section>
          )}
        </div>
        <div>
          {f.kind !== 'wish' && (
            <Section title="Diagnose" open>
              <Diagnostics d={f.diagnostics} kind={f.kind} />
            </Section>
          )}
          <Section title={f.kind === 'wish' ? 'Kommentare & Antworten (öffentlich)' : 'So sieht es der Melder'} open={f.kind === 'wish'}>
            <Thread items={f.thread} />
          </Section>
        </div>
      </div>

      {dialog === 'duplicate' && (
        <Modal
          title="Als Duplikat markieren"
          onClose={() => setDialog(null)}
          footer={
            <button className="btn" disabled={!form.of} onClick={async () => (await act(() => api.post(`/api/feedback/admin/items/${f.id}/duplicate`, { of: form.of }), 'Zusammengeführt')) && done()}>
              Zusammenführen
            </button>
          }
        >
          <p className="muted small" style={{ marginTop: 0 }}>
            Melder{f.kind === 'wish' ? ', Stimmen' : ''} und Vorkommen ziehen zum Original um und werden dort informiert. Dieses Ticket wird „Duplikat“.
          </p>
          <Field label="Original suchen (Titel oder #Nummer)">
            <Input value={search} onChange={setSearch} placeholder="#12 oder Stichwort" autoFocus />
          </Field>
          <div className="fb-pick">
            {(candidates.data ?? [])
              .filter((c) => c.id !== f.id)
              .map((c) => (
                <label key={c.id} className={`fb-pick-row${form.of === c.id ? ' on' : ''}`}>
                  <input type="radio" name="dup" checked={form.of === c.id} onChange={() => set('of')(c.id)} />
                  <span className="grow">
                    #{c.number} {c.title}
                    <small className="muted">
                      {' '}
                      · {KIND[c.kind]?.[0]} · {c.status.label}
                    </small>
                  </span>
                </label>
              ))}
            {candidates.loading && <Spinner />}
          </div>
        </Modal>
      )}
      {dialog === 'fixed' && (
        <Modal
          title={f.kind === 'wish' ? 'Fertig in Version …' : 'Behoben in Version …'}
          onClose={() => setDialog(null)}
          footer={
            <button
              className="btn"
              disabled={!form.version.trim()}
              onClick={async () =>
                (await act(() => api.post(`/api/feedback/admin/items/${f.id}/fixed`, { version: form.version, note: form.note, shipped: form.shipped }), 'Gespeichert – Melder werden informiert')) &&
                done()
              }
            >
              Speichern & informieren
            </button>
          }
        >
          <Field label="Version" hint="z. B. 2.4.1 – erscheint in „Was ist neu“">
            <Input value={form.version} onChange={set('version')} autoFocus />
          </Field>
          <Field
            label="Zeile für „Was ist neu“ (optional)"
            hint={f.kind === 'wish' ? 'Ohne Text steht dort der Titel des Wunsches.' : 'Ohne Text zählt der Fehler nur als „Fehlerbehebung“ – Titel von Meldungen bleiben privat.'}
          >
            <Input value={form.note} onChange={set('note')} maxLength={500} />
          </Field>
          <Check checked={form.shipped} onChange={set('shipped')} label="Schon ausgeliefert (sonst Status „Behoben“)" />
          <p className="muted small">
            {f.kind === 'auto' ? 'Betroffene Nutzer mit Fehlerberichten' : f.kind === 'wish' ? 'Autor und alle Abstimmenden' : `Alle ${f.reporters.length} Melder`} bekommen eine Nachricht in der App,
            per Push und E-Mail.
          </p>
        </Modal>
      )}
      {dialog === 'reply' && (
        <Modal
          title="Öffentlich antworten"
          onClose={() => setDialog(null)}
          footer={
            <button className="btn" disabled={!form.reply.trim()} onClick={() => patch({ reply: form.reply }, 'Antwort gesendet')}>
              Senden
            </button>
          }
        >
          <Field
            label="Antwort"
            hint={f.kind === 'wish' ? 'Für alle sichtbar unter dem Wunsch; der Autor wird benachrichtigt.' : 'Der Melder sieht sie unter „Meine Meldungen“ und bekommt Push + E-Mail.'}
          >
            <Textarea value={form.reply} onChange={set('reply')} rows={4} autoFocus />
          </Field>
        </Modal>
      )}
      {dialog === 'decline' && (
        <Modal
          title="Ablehnen"
          onClose={() => setDialog(null)}
          footer={
            <button className="btn danger" onClick={() => patch({ status: 'abgelehnt', reason: form.reason }, 'Abgelehnt')}>
              Ablehnen
            </button>
          }
        >
          <Field label="Begründung (öffentlich)" hint="Der Melder bzw. alle Abstimmenden sehen sie.">
            <Textarea value={form.reason} onChange={set('reason')} rows={3} autoFocus />
          </Field>
        </Modal>
      )}
    </div>
  );
}

// --- Agentur → Fehler & Wünsche -------------------------------------------------------------------------
function TriageTable({ params, empty }: { params: string; empty: string }) {
  const session = useSession();
  const { data, loading } = useLoad(() => api.get<any[]>(`/api/feedback/admin/items?${params}`), [params]);
  if (loading && !data) return <Spinner />;
  if (!data?.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>#</th>
            <th>Titel</th>
            <th>Status</th>
            <th>Stimmen / Vorkommen</th>
            <th>Von</th>
            <th>Zuletzt</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.id} className="click" {...pressable(() => session.switchLocation(r.location_id, `tickets/${r.ticket_id}`))}>
              <td className="muted">#{r.number}</td>
              <td>
                <Icon name={KIND[r.kind]?.[1] ?? 'bug'} size={14} /> {r.title}
                {r.platform === 'android' && <span className="muted small"> · Android</span>}
              </td>
              <td>
                <StatusPill s={r.status} />
              </td>
              <td>{r.kind === 'wish' ? `${r.votes} Stimmen` : r.kind === 'auto' ? `${r.occurrences}×` : SEVERITY[r.severity] || '–'}</td>
              <td className="small">
                {r.reporter || (r.kind === 'auto' ? 'automatisch' : '–')}
                {r.origin ? <span className="muted"> · {r.origin}</span> : null}
              </td>
              <td className="small muted">{ago(r.last_seen_at || r.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgencyFeedback() {
  const session = useSession();
  const { data, reload, setData } = useLoad(() => api.get('/api/feedback/settings'), []);
  const [tab, setTab] = useState('reports');
  if (!data) return <Spinner />;
  const save = async (p: any) => {
    const r = await act(() => api.put('/api/feedback/settings', p), 'Gespeichert');
    if (r) setData(r);
  };
  return (
    <>
      <div className="card" data-tour="agency-feedback-settings">
        <h2>Support-Bereich für Fehlermeldungen</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Alle Fehlermeldungen, Fragen, Wünsche und automatisch erfassten Fehler deiner Nutzer landen als Tickets in diesem Sub-Account – Pipeline „Fehler &amp; Wünsche“ mit SLA aus dem Helpdesk.
          Melder werden dort Kontakte (per Login-E-Mail), bekommen aber keinen Zugang.
        </p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="grow">
            <Field label="Sub-Account">
              <Select
                value={data.support_location_id}
                onChange={(v) => save({ support_location_id: v })}
                placeholder={`Automatisch: „${session.branding.name} Support“ beim ersten Bericht anlegen`}
                options={data.locations.map((l: any) => [l.id, l.name])}
              />
            </Field>
          </div>
          {data.support_location_id ? (
            <button className="btn secondary" style={{ marginBottom: 12 }} onClick={() => session.switchLocation(data.support_location_id, 'tickets')}>
              <Icon name="ticket" size={14} /> Tickets öffnen
            </button>
          ) : (
            <button className="btn" style={{ marginBottom: 12 }} onClick={async () => (await act(() => api.post('/api/feedback/settings/setup'), 'Eingerichtet')) && reload()}>
              Jetzt einrichten
            </button>
          )}
        </div>
        <Check
          checked={data.capture_server}
          onChange={(v) => save({ capture_server: v })}
          label="Unerwartete Server-Fehler (5xx) automatisch als Ticket erfassen – mit Stack, Route und Request-ID, ohne Anfrage-Inhalte"
        />
        <Check checked={data.capture_client} onChange={(v) => save({ capture_client: v })} label="Browser- und App-Fehler annehmen (jeder Nutzer entscheidet selbst; für Admins standardmäßig an)" />
      </div>
      <SortableGrid id="feedback-admin.stats" className="stats" style={{ marginTop: 14 }}>
        <Stat label="Offene Meldungen" value={data.open.bugs} />
        <Stat label="Offene automatische Fehler" value={data.open.auto} />
        <Stat label="Offene Wünsche" value={data.open.wishes} />
      </SortableGrid>
      <Tabs
        tabs={[
          ['reports', 'Offene Meldungen'],
          ['wishes', 'Top-Wünsche'],
          ['auto', 'Häufigste Fehler'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'reports' && <TriageTable params="kind=bug,question&state=open&sort=priority" empty="Keine offenen Meldungen." />}
      {tab === 'wishes' && <TriageTable params="kind=wish&state=open&sort=votes" empty="Noch keine Wünsche." />}
      {tab === 'auto' && <TriageTable params="kind=auto&state=open&sort=occurrences" empty="Keine offenen automatisch erfassten Fehler." />}
      <p className="muted small">
        Claude/Codex triagieren per MCP: <code>ghl_list_bug_reports</code>, <code>ghl_get_bug_report</code>, <code>ghl_update_bug_report</code>, <code>ghl_list_wishes</code>,{' '}
        <code>ghl_update_wish</code>.
      </p>
    </>
  );
}
