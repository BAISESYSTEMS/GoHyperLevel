import { useState } from 'react';
import { ago, api } from '../api';
import { Badge, Check, CodeBox, Field, Input, Spinner, act, useLoad } from '../ui';
import { SignupLink } from '../referrals';

/** Agency → Integrationen: one-way mirror of the CRM into Supabase. */
export function SupabaseMirror() {
  const s = useLoad(() => api.get<any>('/api/agency/supabase'), []);
  const [url, setUrl] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [showSql, setShowSql] = useState(false);
  if (!s.data) return <Spinner />;
  const v = s.data;
  const st = v.state ?? {};
  const save = async (patch: any) => (await act(() => api.patch('/api/agency/supabase', patch), 'Gespeichert')) && (setKey(''), setUrl(null), s.reload());
  return (
    <div className="card" data-tour="supabase">
      <h2>Supabase-Spiegel <SignupLink id="supabase" /></h2>
      <p className="muted small">
        Projekte, Kontakte, Deals, Aufgaben, Rechnungen und Dokumente laufend in deine Supabase (Tabellen <code>ghl_*</code>), damit andere Projekte und der Supabase-MCP darauf zugreifen. Alle 10 Minuten Änderungen, nachts alles inkl. Löschungen.
      </p>
      <div className="grid2">
        <Field label="Supabase-Adresse">
          <Input value={url ?? v.url} onChange={setUrl} placeholder="https://db.deine-domain.de" />
        </Field>
        <Field label="Service-Role-Key" hint="Supabase → Einstellungen → API (bleibt verschlüsselt hier)">
          <Input type="password" value={key} onChange={setKey} placeholder={v.key_set ? '•••••••• (gespeichert)' : ''} autoComplete="off" />
        </Field>
      </div>
      <Check checked={v.enabled} onChange={(enabled) => save({ enabled })} label="Spiegel aktiv" />
      <p className="actions">
        <button className="btn" onClick={() => save({ url: url ?? v.url, ...(key ? { service_key: key } : {}), enabled: true })}>
          Speichern & testen
        </button>
        <button className="btn secondary" disabled={!v.enabled} onClick={async () => (await act(() => api.post('/api/agency/supabase/sync', { full: true }), 'Synchronisiert')) && s.reload()}>
          Jetzt komplett abgleichen
        </button>
        <button className="btn ghost" onClick={() => setShowSql(!showSql)}>
          {showSql ? 'SQL ausblenden' : 'SQL für die Tabellen'}
        </button>
      </p>
      {st.last_run && (
        <p className="small">
          {st.last_error ? <Badge tone="red">Fehler</Badge> : <Badge tone="green">ok</Badge>} Letzter Abgleich {ago(st.last_run)}
          {st.last_full ? ` · komplett ${ago(st.last_full)}` : ''}
          {st.last_error ? <span style={{ color: 'var(--red)' }}> · {st.last_error}</span> : ''}
          {st.counts && !st.last_error && (
            <span className="muted">
              {' · '}
              {Object.entries(st.counts)
                .map(([k, n]) => `${String(k).replace('ghl_', '')} ${n}`)
                .join(', ')}
            </span>
          )}
        </p>
      )}
      {showSql && (
        <>
          <p className="muted small">Einmal im Supabase-SQL-Editor ausführen (oder per Supabase-MCP „apply_migration“):</p>
          <CodeBox text={v.sql} />
        </>
      )}
    </div>
  );
}
