import { useState } from 'react';
import { api, dt } from '../api';
import { useSession } from '../session';
import { Badge, CodeBox, Empty, Field, Input, Modal, Select, Spinner, act, confirmAsk, navigate, useLoad } from '../ui';
import { MoreFields } from '../areas/fields';
import { SignupLink } from '../referrals';

const VIA: Record<string, [string, any]> = { session: ['Anmeldung', 'gray'], api_key: ['API-Schlüssel', 'blue'], agency_key: ['Agentur-Schlüssel', 'purple'], mcp: ['MCP / KI', 'purple'], app: ['App', 'green'], public: ['öffentlich', 'gray'], system: ['System', 'gray'] };

export function ApiAndMcp() {
  const keys = useLoad(() => api.get<any[]>('/api/agency/api-keys'), []);
  const [name, setName] = useState('Claude');
  const [scope, setScope] = useState('write');
  const [created, setCreated] = useState<any>(null);
  const base = location.origin;
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="card" style={{ flex: '1 1 380px' }} data-tour="agency-keys">
        <h2>Agentur-Schlüssel</h2>
        <p className="muted small">Gelten für alle Projekte (Sub-Account per <code>x-location-id</code>). Für REST-API und den MCP-Server. Nutzer und Schlüssel lassen sich damit nicht verwalten.</p>
        <div className="grid2">
          <Field label="Name">
            <Input value={name} onChange={setName} />
          </Field>
          <Field label="Rechte">
            <Select value={scope} onChange={setScope} options={[['write', 'Lesen & schreiben'], ['read', 'Nur lesen']]} />
          </Field>
        </div>
        <button
          className="btn"
          onClick={async () => {
            const r = await act(() => api.post('/api/agency/api-keys', { name, scope }));
            if (r) (setCreated(r), keys.reload());
          }}
        >
          Schlüssel erzeugen
        </button>
        {!keys.data ? (
          <Spinner />
        ) : keys.data.length ? (
          <table className="t" style={{ marginTop: 14 }}>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id}>
                  <td>
                    <strong>{k.name}</strong> <Badge tone={k.scope === 'read' ? 'gray' : 'purple'}>{k.scope === 'read' ? 'lesen' : 'schreiben'}</Badge>
                    <div className="muted small">
                      {k.prefix}… · zuletzt {k.last_used_at ? dt(k.last_used_at) : 'nie'}
                    </div>
                  </td>
                  <td className="actions">
                    <button className="btn small ghost" onClick={async () => confirmAsk(`Schlüssel „${k.name}“ widerrufen?`) && (await act(() => api.del(`/api/agency/api-keys/${k.id}`))) && keys.reload()}>
                      Widerrufen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Noch keine Schlüssel.</Empty>
        )}
      </div>
      <div className="card" style={{ flex: '2 1 480px' }} data-tour="agency-mcp">
        <h2>MCP-Server (für Claude & andere KI-Assistenten)</h2>
        <p className="muted small">27 Werkzeuge: Projekte, Steckbriefe, Kontakte, Pipelines, Deals, Aufgaben, Posteingang, E-Mail-Import, Social-Posts, Protokoll. Jede Änderung landet im Protokoll („MCP / KI“).</p>
        <Field label="Adresse">
          <CodeBox text={`${base}/mcp`} />
        </Field>
        <Field label="Claude Code (Terminal)">
          <CodeBox text={`claude mcp add --transport http ghl ${base}/mcp --header "Authorization: Bearer pghla_…"`} />
        </Field>
        <MoreFields id="agency-mcp-clients" label="Claude Desktop (JSON) und REST-API">
          <Field label="Claude Desktop / andere (claude_desktop_config.json)">
            <CodeBox text={JSON.stringify({ mcpServers: { ghl: { command: 'npx', args: ['-y', 'mcp-remote', `${base}/mcp`, '--header', 'Authorization: Bearer pghla_…'] } } }, null, 2)} />
          </Field>
          <Field label="REST-API">
            <CodeBox text={`curl -H "Authorization: Bearer pghla_…" -H "x-location-id: <projekt-id>" ${base}/api/contacts`} />
          </Field>
        </MoreFields>
      </div>
      {created && (
        <Modal title="Neuer Schlüssel – jetzt kopieren" onClose={() => setCreated(null)}>
          <p>Der Schlüssel wird nur dieses eine Mal angezeigt.</p>
          <CodeBox text={created.key} />
          <Field label="Claude Code">
            <CodeBox text={`claude mcp add --transport http ghl ${created.mcp_url} --header "Authorization: Bearer ${created.key}"`} />
          </Field>
        </Modal>
      )}
    </div>
  );
}

export function AuditLog() {
  const [q, setQ] = useState('');
  const [via, setVia] = useState('');
  const log = useLoad(() => api.get<any[]>(`/api/admin/audit?limit=200&q=${encodeURIComponent(q)}&via=${via}`), [q, via]);
  return (
    <>
      <div className="row" style={{ marginBottom: 12, maxWidth: 640 }} data-tour="audit-filter">
        <Input value={q} onChange={setQ} placeholder="Suchen (Aktion, Person, Text)…" />
        <Select value={via} onChange={setVia} placeholder="Alle Wege" options={Object.entries(VIA).map(([k, [l]]) => [k, l])} />
      </div>
      {!log.data ? (
        <Spinner />
      ) : !log.data.length ? (
        <Empty>Keine Einträge.</Empty>
      ) : (
        <div className="table-wrap" data-tour="audit-list">
          <table className="t audit">
            <thead>
              <tr>
                <th>Wann</th>
                <th>Wer</th>
                <th>Was</th>
                <th>Projekt</th>
                <th>Wie</th>
              </tr>
            </thead>
            <tbody>
              {log.data.map((e) => (
                <tr key={e.id}>
                  <td className="muted">{dt(e.at)}</td>
                  <td>
                    {e.actor || '–'}
                    <div className="muted small">{e.ip}</div>
                  </td>
                  <td>
                    <code>{e.action}</code>
                    {e.summary && <div className="small">{e.summary}</div>}
                  </td>
                  <td className="small">{e.location ?? '–'}</td>
                  <td>
                    <Badge tone={VIA[e.via]?.[1]}>{VIA[e.via]?.[0] ?? e.via}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function AllTasks() {
  const session = useSession();
  const [project, setProject] = useState('');
  const tasks = useLoad(() => api.get<any[]>('/api/agency/tasks'), []);
  if (!tasks.data) return <Spinner />;
  const projects = [...new Map(tasks.data.map((t) => [t.location_id, t.project])).entries()];
  const shown = tasks.data.filter((t) => !project || t.location_id === project);
  const now = new Date().toISOString();
  const toggle = async (t: any) => {
    const r = await fetch(`/api/tasks/${t.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-pghl': '1', 'x-location-id': t.location_id }, body: JSON.stringify({ done: true }) });
    if (r.ok) tasks.reload();
  };
  return (
    <>
      <div className="row" style={{ marginBottom: 12, maxWidth: 420 }}>
        <Select value={project} onChange={setProject} placeholder={`Alle Projekte (${tasks.data.length})`} options={projects.map(([id, name]) => [id, name])} />
      </div>
      {!shown.length ? (
        <Empty>Keine offenen Aufgaben – alles erledigt.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 40 }}></th>
                <th>Aufgabe</th>
                <th>Projekt</th>
                <th>Fällig</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id}>
                  <td>
                    <input type="checkbox" aria-label="Erledigt" onChange={() => toggle(t)} />
                  </td>
                  <td>
                    <strong>{t.title}</strong>
                    {t.description && <div className="muted small">{String(t.description).slice(0, 140)}</div>}
                  </td>
                  <td>
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        session.switchLocation(t.location_id);
                        navigate('tasks');
                      }}
                    >
                      {t.project}
                    </a>
                  </td>
                  <td>{t.due_at ? <Badge tone={t.due_at < now ? 'red' : 'gray'}>{dt(t.due_at)}</Badge> : <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const RULE_FIELDS: [string, string][] = [
  ['domain', 'Domain ist'],
  ['address', 'Adresse ist'],
  ['subject', 'Betreff enthält'],
  ['any', 'Text enthält'],
];

export function MailAccounts() {
  const list = useLoad(() => api.get<any[]>('/api/agency/mail-accounts'), []);
  const locs = useLoad(() => api.get<any[]>('/api/agency/projects'), []);
  const [edit, setEdit] = useState<any>(null);
  if (!list.data || !locs.data) return <Spinner />;
  const options = locs.data.map((l: any) => [l.id, l.name] as [string, string]);
  const save = async () => {
    const body = { ...edit };
    const r = await act(() => (edit.id ? api.patch(`/api/agency/mail-accounts/${edit.id}`, body) : api.post('/api/agency/mail-accounts', body)), 'Gespeichert');
    if (r) (setEdit(null), list.reload());
  };
  return (
    <div className="card" data-tour="mail-accounts">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>E-Mail-Postfächer</h2>
        <button className="btn small" onClick={() => setEdit({ name: 'Gmail', host: 'imap.gmail.com', port: 993, secure: true, username: '', password: '', rules: [], default_location_id: '' })}>
          + Postfach
        </button>
      </div>
      <p className="muted small">Liest Posteingang, Gesendet und Entwürfe alle 5 Minuten (IMAP) und ordnet Mails per Regel einem Projekt zu. Mails ohne passende Regel werden ignoriert, außer du wählst ein Standard-Projekt. Gmail: App-Passwort unter myaccount.google.com → Sicherheit → App-Passwörter. <SignupLink id="google_workspace" /></p>
      {!list.data.length ? (
        <Empty>Noch kein Postfach verbunden.</Empty>
      ) : (
        <table className="t">
          <tbody>
            {list.data.map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.name}</strong> <span className="muted small">{a.username}</span>
                  <div className="muted small">
                    {a.rules.length} Regeln · {a.last_sync_at ? `zuletzt ${dt(a.last_sync_at)}` : 'noch nie synchronisiert'}
                    {a.last_result ? ` · ${a.last_result.created} neu` : ''}
                  </div>
                  {a.last_error && <div className="small" style={{ color: 'var(--red)' }}>{a.last_error}</div>}
                </td>
                <td className="actions">
                  <button className="btn small secondary" onClick={async () => (await act(() => api.post(`/api/agency/mail-accounts/${a.id}/sync`), 'Synchronisiert')) && list.reload()}>
                    Jetzt abrufen
                  </button>
                  <button className="btn small secondary" onClick={() => setEdit({ ...a, password: '' })}>
                    Bearbeiten
                  </button>
                  <button className="btn small ghost" onClick={async () => confirmAsk(`Postfach „${a.name}“ entfernen? Importierte Mails bleiben.`) && (await act(() => api.del(`/api/agency/mail-accounts/${a.id}`))) && list.reload()}>
                    Entfernen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && (
        <Modal title={edit.id ? `Postfach: ${edit.name}` : 'Postfach verbinden'} onClose={() => setEdit(null)} wide footer={<button className="btn" onClick={save}>Speichern</button>}>
          <div className="grid2">
            <Field label="Name">
              <Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} />
            </Field>
            <Field label="IMAP-Server">
              <Input value={edit.host} onChange={(v) => setEdit({ ...edit, host: v })} />
            </Field>
            <Field label="Benutzer / E-Mail">
              <Input value={edit.username} onChange={(v) => setEdit({ ...edit, username: v })} autoComplete="off" />
            </Field>
            <Field label={edit.id ? 'Passwort (leer = unverändert)' : 'Passwort / App-Passwort'}>
              <Input type="password" value={edit.password} onChange={(v) => setEdit({ ...edit, password: v })} autoComplete="new-password" />
            </Field>
          </div>
          <Field label="Standard-Projekt (für Mails ohne Regel)" hint="Leer lassen, damit Newsletter & Co. draußen bleiben.">
            <Select value={edit.default_location_id ?? ''} onChange={(v) => setEdit({ ...edit, default_location_id: v })} placeholder="– keins (nur Regeln) –" options={options} />
          </Field>
          <Field label="Regeln (erste passende gewinnt)">
            {edit.rules.map((r: any, i: number) => (
              <div key={i} className="list-row" style={{ gridTemplateColumns: '160px minmax(0,1fr) minmax(0,1fr) auto' }}>
                <Select value={r.field} onChange={(v) => setEdit({ ...edit, rules: edit.rules.map((x: any, j: number) => (j === i ? { ...x, field: v } : x)) })} options={RULE_FIELDS} />
                <Input value={r.value} onChange={(v) => setEdit({ ...edit, rules: edit.rules.map((x: any, j: number) => (j === i ? { ...x, value: v } : x)) })} placeholder="z. B. partner-firma.de" />
                <Select value={r.location_id} onChange={(v) => setEdit({ ...edit, rules: edit.rules.map((x: any, j: number) => (j === i ? { ...x, location_id: v } : x)) })} placeholder="→ Projekt" options={options} />
                <button className="btn small ghost" aria-label="Regel entfernen" onClick={() => setEdit({ ...edit, rules: edit.rules.filter((_: any, j: number) => j !== i) })}>
                  ✕
                </button>
              </div>
            ))}
            <button className="btn small secondary" onClick={() => setEdit({ ...edit, rules: [...edit.rules, { field: 'domain', value: '', location_id: options[0]?.[0] ?? '' }] })}>
              + Regel
            </button>
          </Field>
        </Modal>
      )}
    </div>
  );
}
