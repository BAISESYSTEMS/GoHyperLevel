import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { Icon } from '../icons';
import { useSession } from '../session';
import { Badge, Check, Empty, Field, Link, Spinner, Textarea, act, confirmAsk, useLoad } from '../ui';
import { Note, PostureBadge, PurgeDialog, type Json } from './CogneeKit';
import './cognee.css';

/**
 * Einstellungen → Gedächtnis (docs/cognee.md): ask the memory, decide what the sub-account shares (opt-in, per data type, with
 * redaction), the governance status (what is shared, counts, last sync, errors, access control of the server, the last
 * actions from the audit log) and the notes people asked it to remember.
 */

export function CogneeSettings() {
  const info = useLoad(() => api.get<Json>('/api/cognee/info'), []);
  const cfg = useLoad(() => api.get<Json>('/api/cognee/admin/settings'), []);
  const status = useLoad(() => api.get<Json>('/api/cognee/admin/status'), []);
  const session = useSession();
  const [purge, setPurge] = useState<string[] | null>(null);
  const reload = () => {
    void info.reload();
    void cfg.reload();
    void status.reload();
  };
  // The sync runs in the background: look again every few seconds while the page is open.
  useEffect(() => {
    const t = window.setInterval(() => void status.reload(), 10_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!info.data || !cfg.data || !status.data) return <Spinner />;
  const labels: Record<string, string> = Object.fromEntries((cfg.data.catalog as Json[]).map((c) => [c.key, c.label]));
  return (
    <>
      <div className="card" data-tour="cognee-intro">
        <h2>Wissensgedächtnis (Cognee)</h2>
        <p className="muted small">
          Ein Wissensgraph aus dem, was dieser Sub-Account freigibt – zum Fragen („Wie läuft unser Onboarding ab?“), für den KI-Agenten und für MCP-Clients wie Claude. Es wird nur geteilt, was du unten ausdrücklich einschaltest; Standard ist <strong>aus</strong>. Die Daten liegen auf dem Cognee-Server der Agentur, getrennt in eigenen Datasets dieses Sub-Accounts. Alles, was gesendet, durchsucht oder gelöscht wird, steht im Protokoll (nur Anzahlen, nie Inhalte).
        </p>
        {!cfg.data.connection.configured && (
          <Note level="warning">
            Die Agentur hat den Cognee-Server noch nicht eingerichtet.{' '}
            {session.user.role === 'admin' ? <Link to="agency/integrations/setup">Jetzt einrichten</Link> : 'Bitte dort nachfragen – bis dahin wird nichts übertragen.'}
          </Note>
        )}
      </div>
      {info.data.can_ask && <Ask info={info.data} />}
      <Opt cfg={cfg.data} status={status.data} onSaved={(r) => (r.offer_delete.length ? setPurge(r.offer_delete) : undefined, reload())} />
      <Status status={status.data} labels={labels} onChange={reload} onPurge={(types) => setPurge(types)} />
      {info.data.can_remember && <Memories onChange={reload} />}
      {purge && (
        <PurgeDialog
          types={purge}
          labels={labels}
          url="/api/cognee/admin/purge"
          onClose={() => {
            setPurge(null);
            reload();
          }}
        />
      )}
    </>
  );
}

// --- "Gedächtnis fragen" ------------------------------------------------------------------------------------------------------

function Source({ link, title }: { link: string; title: string }) {
  if (link.startsWith('/app/')) return <Link to={link}>{title}</Link>;
  if (/^https:\/\//.test(link))
    return (
      <a href={link} target="_blank" rel="noopener noreferrer">
        {title}
      </a>
    );
  return <strong>{title}</strong>;
}

function Ask({ info }: { info: Json }) {
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState(false);
  const [r, setR] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!q.trim()) return;
    setBusy(true);
    const out = await act(() => api.get<Json>(`/api/cognee/recall?q=${encodeURIComponent(q.trim())}${answer ? '&mode=answer' : ''}`));
    setBusy(false);
    if (out) setR(out);
  };
  return (
    <div className="card" data-tour="cognee-ask">
      <h2>Gedächtnis fragen</h2>
      <form
        className="cg-ask"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Frage oder Stichworte, z. B. Wie läuft der Onboarding-Call ab?" aria-label="Frage an das Gedächtnis" maxLength={500} />
        <button className="btn" disabled={busy || !q.trim()}>
          <Icon name="search" size={14} /> {busy ? 'Sucht …' : 'Fragen'}
        </button>
      </form>
      <Check checked={answer} onChange={setAnswer} label="Antwort formulieren lassen (nutzt das Sprachmodell des Cognee-Servers und kann dort Kosten verursachen)" />
      <p className="muted small">Durchsucht: {info.types.map((t: Json) => t.label).join(', ')}. Du siehst nur Treffer aus Bereichen, auf die du Zugriff hast.</p>
      {r?.answer && <div className="cg-answer">{r.answer}</div>}
      {r && !r.results.length && <Empty>{r.note ?? 'Keine Treffer.'}</Empty>}
      {r && r.results.length > 0 && (
        <ul className="cg-hits">
          {r.results.map((h: Json, i: number) => (
            <li key={`${h.type}-${i}`} className="cg-hit">
              <div className="cg-hit-head">
                <Badge tone="blue">{h.type_label}</Badge>
                <Source link={h.link} title={h.title} />
              </div>
              <p className="small">{h.snippet}</p>
            </li>
          ))}
        </ul>
      )}
      {r?.note && r.results.length > 0 && <p className="muted small">{r.note}</p>}
    </div>
  );
}

// --- what is shared ---------------------------------------------------------------------------------------------------------------

function Opt({ cfg, status, onSaved }: { cfg: Json; status: Json; onSaved: (r: Json) => void }) {
  const [d, setD] = useState<Json>({ enabled: cfg.enabled, types: cfg.types, redact: cfg.redact, members_ask: cfg.members_ask });
  useEffect(() => setD({ enabled: cfg.enabled, types: cfg.types, redact: cfg.redact, members_ask: cfg.members_ask }), [cfg]);
  const items: Record<string, number> = Object.fromEntries((status.types as Json[]).map((t) => [t.key, t.items]));
  const dirty = JSON.stringify(d) !== JSON.stringify({ enabled: cfg.enabled, types: cfg.types, redact: cfg.redact, members_ask: cfg.members_ask });
  const maySwitchOn = cfg.connection.locations_may_enable;
  const personalOn = (cfg.catalog as Json[]).filter((c) => c.personal && d.types[c.key]);
  return (
    <div className="card" data-tour="cognee-types">
      <h2>Was geteilt wird</h2>
      <Check checked={d.enabled} onChange={(x) => setD({ ...d, enabled: x })} label={<strong>Wissensgedächtnis für diesen Sub-Account einschalten</strong>} tour="cognee-enable" />
      {!maySwitchOn && !cfg.enabled && <p className="muted small">Die Agentur schaltet das Gedächtnis selbst ein – frag dort nach.</p>}
      <div className="cg-types" style={{ opacity: d.enabled ? 1 : 0.55 }}>
        {(cfg.catalog as Json[]).map((c) => (
          <div key={c.key} className={`cg-type${d.enabled && d.types[c.key] ? ' on' : ''}`}>
            <div className="cg-type-head">
              <Check checked={!!d.types[c.key]} onChange={(x) => setD({ ...d, types: { ...d.types, [c.key]: x } })} label={c.label} />
              {c.personal && <Badge tone="yellow">personenbezogen</Badge>}
              {items[c.key] > 0 && <span className="muted small">{items[c.key]} in Cognee</span>}
            </div>
            <p className="muted small" style={{ margin: '2px 0 0 26px' }}>
              {c.description}
              {c.warning && <> <strong>{c.warning}</strong></>}
            </p>
            {d.types[c.key] && (
              <div className="cg-type-sub">
                <Check checked={!!d.redact[c.key]} onChange={(x) => setD({ ...d, redact: { ...d.redact, [c.key]: x } })} label="E-Mail-Adressen, Telefonnummern und IBANs vor dem Senden schwärzen" />
              </div>
            )}
          </div>
        ))}
      </div>
      <Check checked={d.members_ask} onChange={(x) => setD({ ...d, members_ask: x })} label="Mitglieder (Kunden-Logins) dürfen das Gedächtnis befragen – nur zu Bereichen, auf die sie Zugriff haben" />
      {d.enabled && personalOn.length > 0 && <Note level="warning">Personenbezogene Daten werden geteilt: {personalOn.map((c) => c.label).join(', ')}. Auftragsverarbeitung und Rechtsgrundlage sollten geklärt sein. Wird eine Person nach DSGVO gelöscht, löscht HyperLevel ihre Daten auch in Cognee.</Note>}
      <p className="muted small">Das Schwärzen ist eine Sicherung, keine Anonymisierung: Namen und Freitext bleiben. Wer die Schwärzung später ein- oder ausschaltet, schickt alles Betroffene neu und ersetzt die alte Fassung.</p>
      <button
        className="btn"
        disabled={!dirty}
        onClick={async () => {
          const r = await act(() => api.put<Json>('/api/cognee/admin/settings', { enabled: d.enabled, types: d.types, redact: d.redact, members_ask: d.members_ask }), 'Gespeichert');
          if (r) onSaved(r);
        }}
        data-tour="cognee-save"
      >
        Speichern
      </button>
    </div>
  );
}

// --- the governance status ----------------------------------------------------------------------------------------------------------

function phaseBadge(t: Json) {
  if (!t.active) return t.has_data ? <Badge tone="yellow">aus – Daten liegen noch in Cognee</Badge> : <Badge>aus</Badge>;
  if (t.last_error) return <Badge tone="red">Fehler</Badge>;
  if (t.phase === 'cognify') return <Badge tone="blue">Wissensgraph wird gebaut</Badge>;
  if (t.retry_at) return <Badge tone="yellow">wartet</Badge>;
  return t.last_sync_at ? <Badge tone="green">aktuell</Badge> : <Badge tone="blue">wartet auf den ersten Abgleich</Badge>;
}

const ACTIONS: Record<string, string> = {
  'cognee.push': 'Gesendet',
  'cognee.search': 'Befragt',
  'cognee.delete': 'Gelöscht',
  'cognee.erase': 'DSGVO',
  'cognee.purge': 'Löschen angestoßen',
  'cognee.settings': 'Freigaben',
  'cognee.remember': 'Gemerkt',
  'cognee.forget': 'Vergessen',
  'cognee.sync': 'Abgleich',
};

function Status({ status, labels, onChange, onPurge }: { status: Json; labels: Record<string, string>; onChange: () => void; onPurge: (types: string[]) => void }) {
  const leftovers = (status.types as Json[]).filter((t) => !t.active && t.has_data);
  return (
    <div className="card" data-tour="cognee-status">
      <h2>
        Status <PostureBadge state={status.access_control.state} />
      </h2>
      {(status.warnings as Json[]).map((w, i) => (
        <Note key={i} level={w.level}>
          {w.text}
        </Note>
      ))}
      <p className="muted small">
        {status.access_control.hint}
        {status.access_control.checked_at ? ` (geprüft ${dt(status.access_control.checked_at)})` : ''}
      </p>
      <div className="table-wrap">
        <table className="t cg-status">
          <thead>
            <tr>
              <th>Daten</th>
              <th>Zustand</th>
              <th>Einträge</th>
              <th>Letzter Abgleich</th>
              <th>Dataset in Cognee</th>
            </tr>
          </thead>
          <tbody>
            {(status.types as Json[]).map((t) => (
              <tr key={t.key}>
                <td>
                  {t.label}
                  {t.redact && t.active && <div className="muted small">geschwärzt</div>}
                </td>
                <td>
                  {phaseBadge(t)}
                  {t.last_error && <div className="small" style={{ color: 'var(--red)', maxWidth: 360 }}>{t.last_error}</div>}
                  {t.retry_at && <div className="muted small">nächster Versuch {dt(t.retry_at)}</div>}
                  {t.skipped > 0 && <div className="muted small">{t.skipped} Eintrag/Einträge von Cognee abgelehnt</div>}
                </td>
                <td>{t.items}</td>
                <td>{t.last_sync_at ? dt(t.last_sync_at) : '–'}</td>
                <td>
                  <code>{t.dataset}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cg-actions">
        <button
          className="btn secondary"
          disabled={!status.enabled}
          onClick={async () => {
            if (await act(() => api.post('/api/cognee/admin/sync', {}), 'Abgleich gestartet')) window.setTimeout(onChange, 1500);
          }}
        >
          <Icon name="refresh" size={14} /> Jetzt abgleichen
        </button>
        <button
          className="btn secondary"
          disabled={!status.enabled}
          title="Schaut jeden Datensatz noch einmal an – Unverändertes kostet nichts"
          onClick={async () => {
            if (confirmAsk('Alles neu abgleichen? Jeder freigegebene Datensatz wird noch einmal geprüft; nur Geändertes wird gesendet.') && (await act(() => api.post('/api/cognee/admin/sync', { full: true }), 'Voller Abgleich gestartet'))) window.setTimeout(onChange, 1500);
          }}
        >
          Alles neu abgleichen
        </button>
        {leftovers.length > 0 && (
          <button className="btn danger" onClick={() => onPurge(leftovers.map((t) => t.key))} data-tour="cognee-purge">
            <Icon name="trash" size={14} /> Daten in Cognee löschen …
          </button>
        )}
      </div>
      {status.pending_deletions > 0 && <p className="muted small">{status.pending_deletions} Löschung(en) werden an Cognee gesendet (bei Fehlern wiederholt HyperLevel sie automatisch).</p>}
      {leftovers.length > 0 && <p className="muted small">Noch in Cognee, aber nicht mehr freigegeben: {leftovers.map((t) => labels[t.key] ?? t.key).join(', ')}.</p>}
      <h3 style={{ margin: '14px 0 2px' }}>Letzte Vorgänge</h3>
      {(status.audit as Json[]).length === 0 ? (
        <p className="muted small">Noch nichts. Das ganze Protokoll steht unter Einstellungen → API &amp; Webhooks bzw. Agentur → Protokoll (Aktionen „cognee.…“).</p>
      ) : (
        <ul className="cg-log small">
          {(status.audit as Json[]).map((a, i) => (
            <li key={i}>
              <time>{dt(a.at)}</time>
              <span>
                <strong>{ACTIONS[a.action] ?? a.action}:</strong> {a.summary}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- remembered notes --------------------------------------------------------------------------------------------------------------------

function Memories({ onChange }: { onChange: () => void }) {
  const list = useLoad(() => api.get<Json[]>('/api/cognee/memories'), []);
  const [text, setText] = useState('');
  return (
    <div className="card" data-tour="cognee-memories">
      <h2>Gemerkte Hinweise</h2>
      <p className="muted small">Was hier steht, landet im Gedächtnis und kann gefunden werden – auch vom KI-Agenten (Tool „ghl_memory_remember“). Keine Passwörter oder Zugangsdaten eintragen.</p>
      <Field label="Neuer Hinweis">
        <Textarea value={text} onChange={setText} rows={3} maxLength={4000} placeholder="z. B. Rechnungen gehen immer an die Buchhaltung, nie an die Geschäftsleitung." />
      </Field>
      <button
        className="btn"
        disabled={!text.trim()}
        onClick={async () => {
          if (await act(() => api.post('/api/cognee/remember', { text: text.trim() }), 'Gemerkt')) {
            setText('');
            void list.reload();
            onChange();
          }
        }}
      >
        Merken
      </button>
      {!list.data ? (
        <Spinner />
      ) : (
        list.data.map((m) => (
          <div key={m.id} className="cg-mem">
            <div>
              <p>{m.text}</p>
              <span className="muted small">
                {dt(m.created_at)}
                {m.created_by_name ? ` · ${m.created_by_name}` : ''} · {m.synced ? 'im Gedächtnis' : 'wird übertragen'}
              </span>
            </div>
            <button
              className="btn small ghost danger-text"
              onClick={async () => {
                if (!confirmAsk('Diesen Hinweis löschen? Er wird auch in Cognee entfernt.')) return;
                if (await act(() => api.del(`/api/cognee/memories/${m.id}`), 'Gelöscht')) {
                  void list.reload();
                  onChange();
                }
              }}
            >
              <Icon name="trash" size={13} /> Löschen
            </button>
          </div>
        ))
      )}
    </div>
  );
}

