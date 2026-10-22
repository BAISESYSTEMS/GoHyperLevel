import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { Icon } from '../icons';
import { useSession } from '../session';
import { Badge, Check, Field, Input, Modal, Select, Spinner, act, confirmAsk, toast, useLoad } from '../ui';
import { Note, PostureBadge, PurgeDialog, type Json } from './CogneeKit';
import './cognee.css';

/**
 * Agentur → Integrationen → Einrichtung → „Wissensgedächtnis (Cognee)“ (docs/cognee.md): the address and the login of the
 * self-hosted Cognee server, a test of every step, and all sub-accounts at a glance (what they share, item counts, last sync,
 * errors) with a login of their own per sub-account for stronger separation.
 */

export function CogneeAgencySetup() {
  const s = useLoad(() => api.get<Json>('/api/agency/cognee'), []);
  const [f, setF] = useState<Json | null>(null);
  const [test, setTest] = useState<Json | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const v = s.data;
    if (v && !f) setF({ base_url: v.base_url ?? '', auth_mode: v.auth_mode ?? 'password', email: v.email ?? '', secret: '', allow_private: v.configured ? !!v.allow_private : false, locations_may_enable: v.configured ? v.locations_may_enable !== false : true, allow_open_server: !!v.allow_open_server });
  }, [s.data, f]);
  if (!s.data || !f) return <Spinner />;
  const v = s.data;
  const set = (p: Json) => setF({ ...f, ...p });
  const password = f.auth_mode === 'password';
  const body = () => ({ base_url: f.base_url, auth_mode: f.auth_mode, ...(password ? { email: f.email, ...(f.secret ? { password: f.secret } : {}) } : f.secret ? { api_key: f.secret } : {}), allow_private: f.allow_private, locations_may_enable: f.locations_may_enable, allow_open_server: f.allow_open_server });
  const runTest = async () => setTest((await act(() => api.post<Json>('/api/agency/cognee/test', {}))) ?? null);
  const save = async () => {
    setBusy(true);
    const r = await act(() => api.put<Json>('/api/agency/cognee', body()), 'Gespeichert');
    setBusy(false);
    if (!r) return;
    set({ secret: '' });
    await s.reload();
    await runTest();
  };
  const hostLooksInternal = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[a-z0-9-]+(:\d+)?(\/|$))/i.test(f.base_url);

  return (
    <div className="card" style={{ flex: '1 1 420px' }} data-tour="cognee-agency">
      <h2>Wissensgedächtnis (Cognee)</h2>
      <p className="muted small">
        Verbindet HyperLevel mit einem selbst gehosteten <a href="https://github.com/topoteretes/cognee" target="_blank" rel="noopener">Cognee</a>-Server (Wissensgraph, Apache-2.0) über dessen REST-Schnittstelle. Jeder Sub-Account entscheidet selbst, ob und welche Daten er teilt – Standard: aus. Jeder Sub-Account bekommt eigene Datasets (<code>gh_&lt;ID&gt;_&lt;Typ&gt;</code>), andere Datasets werden nie gelesen oder beschrieben. Einrichtung, Server-Einstellungen und was gesendet wird: <code>docs/cognee.md</code>
      </p>
      <Note level="info">Auf dem Cognee-Server muss <code>ENABLE_BACKEND_ACCESS_CONTROL=true</code> gesetzt sein, und HyperLevel sollte einen eigenen Cognee-Nutzer bekommen – so liegt jedes Dataset getrennt.</Note>
      {v.configured && v.posture?.state === 'open' && (
        <Note level="critical">
          Der Cognee-Server antwortet ohne Anmeldung – die Zugriffskontrolle ist aus. Es wird nichts übertragen, bis <code>ENABLE_BACKEND_ACCESS_CONTROL=true</code> gesetzt ist. {v.posture.reason}
        </Note>
      )}
      <Field label="Adresse des Cognee-Servers" hint="z. B. https://cognee.example.com – oder http://cognee:8000 im selben Docker-Netz. Ohne http:// nur im eigenen Netz.">
        <Input value={f.base_url} onChange={(x) => set({ base_url: x })} placeholder="https://cognee.example.com" autoComplete="off" />
      </Field>
      <Field label="Anmeldung">
        <Select value={f.auth_mode} onChange={(x) => set({ auth_mode: x, secret: '' })} options={[['password', 'E-Mail und Passwort (Cognee-Nutzer für HyperLevel)'], ['api_key', 'API-Schlüssel (Cognee → /api/v1/auth/api-keys)']]} />
      </Field>
      {password && (
        <Field label="E-Mail des Cognee-Nutzers">
          <Input type="email" value={f.email} onChange={(x) => set({ email: x })} placeholder="gohigh@example.com" autoComplete="off" />
        </Field>
      )}
      <Field label={password ? 'Passwort' : 'API-Schlüssel'} hint="Wird verschlüsselt gespeichert und nie wieder angezeigt. Leer lassen = bisherigen Wert behalten.">
        <Input type="password" value={f.secret} onChange={(x) => set({ secret: x })} autoComplete="new-password" placeholder={v.configured && v.secret_set && v.auth_mode === f.auth_mode ? `•••••••• ${v.hint}` : ''} />
      </Field>
      <Check checked={f.allow_private} onChange={(x) => set({ allow_private: x })} label={`Internes Netz erlauben (Cognee läuft im selben Docker-Netz oder LAN)${hostLooksInternal && !f.allow_private ? ' – vermutlich nötig' : ''}`} />
      <Check checked={f.locations_may_enable} onChange={(x) => set({ locations_may_enable: x })} label="Sub-Account-Admins dürfen das Gedächtnis selbst einschalten (aus: nur die Agentur)" />
      <button type="button" className="btn small ghost" onClick={() => setMore(!more)}>
        {more ? '▾' : '▸'} Weitere Einstellungen
      </button>
      {more && <Check checked={f.allow_open_server} onChange={(x) => set({ allow_open_server: x })} label="Auch an einen Server ohne Zugriffskontrolle senden (nicht empfohlen – Sub-Accounts liegen dort nicht getrennt)" />}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button className="btn" disabled={busy || !f.base_url || (password && !f.email) || (!v.configured && !f.secret)} onClick={save} data-tour="cognee-save">
          Speichern &amp; testen
        </button>
        {v.configured && (
          <button className="btn secondary" onClick={runTest} data-tour="cognee-test">
            Verbindung testen
          </button>
        )}
        {v.configured && (
          <button
            className="btn ghost"
            onClick={async () => {
              if (!confirmAsk('Verbindung zu Cognee entfernen? Das geht nur, wenn kein Sub-Account mehr Daten teilt oder in Cognee liegen hat.')) return;
              try {
                await api.del('/api/agency/cognee');
                toast('Entfernt');
                setF(null);
                setTest(null);
                void s.reload();
              } catch (e) {
                if (confirmAsk(`${(e as Error).message}\n\nTrotzdem entfernen? Die Daten bleiben dann auf dem Server und lassen sich über HyperLevel nicht mehr löschen.`)) {
                  await act(() => api.del('/api/agency/cognee?force=1'), 'Entfernt');
                  setF(null);
                  setTest(null);
                  void s.reload();
                }
              }
            }}
          >
            Entfernen
          </button>
        )}
      </div>
      {test && <TestResult r={test} />}
      {v.configured && !test && v.last_test && (
        <p className="muted small">
          Letzter Test {dt(v.last_test.at)}: {v.last_test.ok ? <Badge tone="green">ok</Badge> : <Badge tone="red">fehlgeschlagen</Badge>} <PostureBadge state={v.posture?.state} />
        </p>
      )}
      {v.configured && <CogneeOverview />}
    </div>
  );
}

function TestResult({ r }: { r: Json }) {
  return (
    <div data-tour="cognee-test-result">
      <ul className="cg-steps">
        {r.steps.map((st: Json) => (
          <li key={st.key}>
            <Badge tone={st.ok ? (st.warn ? 'yellow' : 'green') : 'red'}>{st.ok ? (st.warn ? 'unklar' : 'ok') : 'Fehler'}</Badge>
            <span className="cg-step-label">{st.label}</span>
            <span className="muted small">{st.detail}</span>
          </li>
        ))}
      </ul>
      {r.ok && <Note level="ok">Verbunden{r.version ? ` mit Cognee ${r.version}` : ''}. Sub-Accounts können das Gedächtnis jetzt unter Einstellungen → Gedächtnis einschalten.</Note>}
    </div>
  );
}

/** All sub-accounts: what is shared, counts, last sync, errors – and the agency's own switches. */
function CogneeOverview() {
  const o = useLoad(() => api.get<Json>('/api/agency/cognee/overview'), []);
  const [purge, setPurge] = useState<{ id: string; types: string[]; labels: Record<string, string> } | null>(null);
  const [account, setAccount] = useState<Json | null>(null);
  const session = useSession();
  if (!o.data) return <Spinner />;
  const rows: Json[] = o.data.locations;
  const active = rows.filter((r) => r.enabled).length;
  return (
    <div style={{ marginTop: 16 }} data-tour="cognee-overview">
      <h3 style={{ marginBottom: 4 }}>Sub-Accounts im Überblick</h3>
      <p className="muted small">
        {active} von {rows.length} Sub-Accounts teilen Daten. Eingeschaltet wird in den Einstellungen des Sub-Accounts (Reiter „Gedächtnis“); hier siehst du den Stand und kannst ausschalten.
      </p>
      <div className="table-wrap">
        <table className="t cg-status">
          <thead>
            <tr>
              <th>Sub-Account</th>
              <th>Freigabe</th>
              <th>Einträge</th>
              <th>Letzter Abgleich</th>
              <th>Zugang</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>
                  {r.enabled ? <Badge tone="green">an</Badge> : <Badge>aus</Badge>} {r.enabled && <span className="muted small">{r.types.length} Datentyp{r.types.length === 1 ? '' : 'en'}</span>}
                  {r.errors > 0 && (
                    <>
                      {' '}
                      <Badge tone="red">{r.errors} Fehler</Badge>
                    </>
                  )}
                </td>
                <td>
                  {r.items}
                  {r.pending_deletions > 0 && <span className="muted small"> · {r.pending_deletions} Löschung(en) offen</span>}
                </td>
                <td>{r.last_sync_at ? dt(r.last_sync_at) : '–'}</td>
                <td>
                  <button className="btn small ghost" onClick={() => setAccount(r)}>
                    {r.account === 'override' ? <Badge tone="blue">eigener: {r.account_label}</Badge> : 'Agentur-Zugang'}
                  </button>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {r.enabled && (
                    <button
                      className="btn small secondary"
                      onClick={async () => {
                        if (!confirmAsk(`Teilen für „${r.name}“ ausschalten? Es wird nichts mehr übertragen; die vorhandenen Daten in Cognee kannst du danach löschen.`)) return;
                        const res = await act(() => api.put<Json>(`/api/agency/cognee/locations/${r.id}/settings`, { enabled: false }), 'Ausgeschaltet');
                        if (res) {
                          const labels = Object.fromEntries((res.settings.catalog as Json[]).map((c) => [c.key, c.label]));
                          if (res.offer_delete.length) setPurge({ id: r.id, types: res.offer_delete, labels });
                          void o.reload();
                        }
                      }}
                    >
                      Ausschalten
                    </button>
                  )}
                  {!r.enabled && r.items > 0 && (
                    <button
                      className="btn small secondary"
                      onClick={() => setPurge({ id: r.id, types: Object.keys(r.by_type).filter((t) => r.by_type[t] > 0), labels: o.data!.labels })}
                    >
                      Daten löschen …
                    </button>
                  )}{' '}
                  <button className="btn small ghost" onClick={() => session.switchLocation(r.id, 'settings/memory')} title="Einstellungen → Gedächtnis dieses Sub-Accounts">
                    <Icon name="settings" size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {purge && (
        <PurgeDialog
          types={purge.types}
          labels={purge.labels}
          url={`/api/agency/cognee/locations/${purge.id}/purge`}
          onClose={() => {
            setPurge(null);
            void o.reload();
          }}
        />
      )}
      {account && (
        <AccountDialog
          row={account}
          onClose={() => {
            setAccount(null);
            void o.reload();
          }}
        />
      )}
    </div>
  );
}

/** A Cognee login of its own for one sub-account: even Cognee then keeps its data apart from the others. */
function AccountDialog({ row, onClose }: { row: Json; onClose: () => void }) {
  const [mode, setMode] = useState('password');
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [result, setResult] = useState<Json | null>(null);
  const own = row.account === 'override';
  return (
    <Modal
      title={`Cognee-Zugang für ${row.name}`}
      onClose={onClose}
      footer={
        <>
          {own && (
            <button
              className="btn ghost danger-text"
              onClick={async () => {
                if (await act(() => api.del(`/api/agency/cognee/locations/${row.id}/account`), 'Zugang entfernt')) onClose();
              }}
            >
              Eigenen Zugang entfernen
            </button>
          )}
          <button
            className="btn"
            disabled={!secret || (mode === 'password' && !email)}
            onClick={async () => {
              if (await act(() => api.put(`/api/agency/cognee/locations/${row.id}/account`, mode === 'password' ? { auth_mode: 'password', email, password: secret } : { auth_mode: 'api_key', api_key: secret }), 'Gespeichert')) {
                setSecret('');
                setResult((await act(() => api.post<Json>(`/api/agency/cognee/locations/${row.id}/test`, {}))) ?? null);
              }
            }}
          >
            Speichern &amp; testen
          </button>
        </>
      }
    >
      <p className="muted small">
        Standard ist der Zugang der Agentur (ein Cognee-Nutzer für alle). Mit einem eigenen Cognee-Nutzer für diesen Sub-Account gehören seine Datasets diesem Nutzer – die Trennung gilt dann auch in Cognee selbst. Wechseln geht nur, solange in Cognee noch keine Daten dieses Sub-Accounts liegen.
      </p>
      <p>
        Jetzt: {own ? <Badge tone="blue">eigener Zugang ({row.account_label})</Badge> : <Badge>Zugang der Agentur</Badge>}
      </p>
      <Field label="Anmeldung">
        <Select value={mode} onChange={setMode} options={[['password', 'E-Mail und Passwort'], ['api_key', 'API-Schlüssel']]} />
      </Field>
      {mode === 'password' && (
        <Field label="E-Mail des Cognee-Nutzers">
          <Input type="email" value={email} onChange={setEmail} autoComplete="off" />
        </Field>
      )}
      <Field label={mode === 'password' ? 'Passwort' : 'API-Schlüssel'}>
        <Input type="password" value={secret} onChange={setSecret} autoComplete="new-password" />
      </Field>
      {result && <TestResult r={result} />}
    </Modal>
  );
}
