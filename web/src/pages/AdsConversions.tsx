import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { Badge, Check, Field, Input, Link, Modal, Spinner, act, useLoad } from '../ui';

/**
 * Attribution → Tracking & Werbekonten: Google Ads offline conversions – the Google counterpart of the Meta Conversions API card.
 * Which CRM events go to which conversion action, enhanced conversions for leads (hashed e-mail/phone), a dry run with
 * validate_only, and the upload log. Only contacts with marketing consent are uploaded. Server: modules/ads-conversions.ts.
 */

type Json = Record<string, any>;

const STATUS: Record<string, [string, 'gray' | 'green' | 'red' | 'blue' | 'yellow']> = {
  pending: ['wartet', 'blue'],
  retry: ['neuer Versuch geplant', 'yellow'],
  sent: ['hochgeladen', 'green'],
  duplicate: ['war schon da', 'green'],
  failed: ['Fehler', 'red'],
  blocked: ['ohne Einwilligung', 'gray'],
  skipped: ['übersprungen', 'gray'],
};
const HINT: Record<string, string> = {
  deal_won: 'Wert und Währung kommen aus dem Deal.',
  form_submitted: 'Fester Wert je Formular (optional); nur bestimmte Formulare: IDs mit Komma.',
  booking: 'Fester Wert je Termin (optional).',
  invoice_paid: 'Wert und Währung kommen aus der Rechnung.',
};

export function GoogleConversions() {
  const st = useLoad(() => api.get<Json>('/api/ads/conversions'), []);
  const log = useLoad(() => api.get<Json[]>('/api/ads/conversions/log?limit=50'), []);
  const [f, setF] = useState<Json | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState('');
  const [check, setCheck] = useState<Json | null>(null);
  useEffect(() => {
    if (!st.data) return;
    setF(structuredClone(st.data.config));
    setEnabled(!!st.data.enabled);
  }, [st.data]);
  if (!st.data || !f) return <Spinner />;
  const s = st.data;
  const setEvent = (k: string, patch: Json) => setF({ ...f, events: { ...f.events, [k]: { ...f.events[k], ...patch } } });
  const run = async (key: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(key);
    const r = await act(fn, ok);
    setBusy('');
    return r;
  };
  const counts: Json = s.counts ?? {};
  return (
    <div className="card gconv" data-tour="ads-gconv">
      <div className="gconv-head">
        <h2 style={{ margin: 0 }}>Google Ads: Offline-Conversions</h2>
        {!s.google.connected ? <Badge>Google Ads nicht verbunden</Badge> : s.enabled ? <Badge tone={s.last_error ? 'red' : 'green'}>{s.last_error ? 'Fehler' : 'aktiv'}</Badge> : <Badge>aus</Badge>}
      </div>
      <p className="muted small">
        Gewonnene Deals, Formulare, Termine und bezahlte Rechnungen gehen als Conversion an Google zurück – mit der Klick-ID (gclid, gbraid, wbraid) des Kontakts und auf Wunsch als erweiterte Conversions für Leads (E-Mail und Telefon nur als SHA-256-Hash). <strong>Nur Kontakte mit Einwilligung für Marketing</strong> (Einwilligungen → Tracking & Cookies) werden hochgeladen.
      </p>
      {!s.google.connected && (
        <p className="small">
          Zuerst Google Ads verbinden: <Link to="ads/connections">Anzeigen → Verbindungen</Link> (oder oben unter „Google Ads“ die Zugangsdaten eintragen).
        </p>
      )}
      {s.last_error && <p className="small" style={{ color: 'var(--red)' }}>{s.last_error}</p>}
      <Check checked={enabled} onChange={setEnabled} label="Conversions automatisch hochladen" />
      <div className="gconv-events">
        {(s.events as Json[]).map((e) => {
          const ev = f.events[e.key];
          return (
            <div key={e.key} className="gconv-event">
              <Check checked={!!ev.enabled} onChange={(v) => setEvent(e.key, { enabled: v })} label={e.label} />
              <div className="grid2">
                <Field label="Conversion-Aktion" hint={`customers/${s.google.customer_id || '1234567890'}/conversionActions/… oder nur die ID`}>
                  <Input value={ev.action} onChange={(v) => setEvent(e.key, { action: v })} placeholder="z. B. 987654321" />
                </Field>
                {(e.key === 'form_submitted' || e.key === 'booking') && (
                  <Field label="Wert (optional)" hint={HINT[e.key]}>
                    <Input value={ev.value || ''} onChange={(v) => setEvent(e.key, { value: v })} inputMode="decimal" placeholder="0" />
                  </Field>
                )}
                {e.key === 'form_submitted' && (
                  <Field label="Nur diese Formulare (optional)">
                    <Input value={(ev.form_ids ?? []).join(', ')} onChange={(v) => setEvent(e.key, { form_ids: v })} placeholder="alle Formulare" />
                  </Field>
                )}
              </div>
              {(e.key === 'deal_won' || e.key === 'invoice_paid') && <p className="muted small">{HINT[e.key]}</p>}
            </div>
          );
        })}
      </div>
      <Check checked={!!f.enhanced_leads} onChange={(v) => setF({ ...f, enhanced_leads: v })} label="Erweiterte Conversions für Leads: gehashte E-Mail/Telefon mitsenden (auch Leads ohne Klick-ID)" />
      <div className="grid2">
        <Field label="Währung, wenn nichts angegeben ist">
          <Input value={f.currency} onChange={(v) => setF({ ...f, currency: v })} maxLength={3} />
        </Field>
      </div>
      <div className="actions gconv-actions">
        <button className="btn" disabled={!!busy} onClick={async () => (await run('save', () => api.put('/api/ads/conversions', { enabled, config: f }), 'Gespeichert')) && (st.reload(), log.reload())}>
          Speichern
        </button>
        <button className="btn secondary" disabled={!!busy || !s.google.connected} onClick={async () => {
          const r = await run('check', () => api.post<Json>('/api/ads/conversions/validate'));
          if (r) setCheck(r);
        }}>
          Prüflauf (validate_only)
        </button>
        {s.enabled && (
          <button className="btn secondary" disabled={!!busy} onClick={async () => (await run('run', () => api.post('/api/ads/conversions/run'), 'Warteschlange abgearbeitet')) && (st.reload(), log.reload())}>
            Jetzt hochladen
          </button>
        )}
      </div>
      <p className="muted small">
        {counts.sent ?? 0} hochgeladen · {(counts.pending ?? 0) + (counts.retry ?? 0)} wartend · {counts.failed ?? 0} Fehler · {counts.blocked ?? 0} ohne Einwilligung{s.last_run_at ? ` · zuletzt ${dt(s.last_run_at)}` : ''}
      </p>
      {(log.data ?? []).length > 0 && (
        <details className="gconv-log">
          <summary>Protokoll ({log.data!.length})</summary>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Ereignis</th>
                  <th>Kontakt</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {log.data!.map((l) => (
                  <tr key={l.id}>
                    <td className="muted">{dt(l.created_at)}</td>
                    <td>
                      {(s.events as Json[]).find((e) => e.key === l.event)?.label ?? l.event}
                      {l.value ? <span className="muted small"> · {Number(l.value).toLocaleString('de-DE')} {l.currency}</span> : null}
                      {l.click_kind ? <span className="muted small"> · {l.click_kind}</span> : null}
                    </td>
                    <td>{l.contact_name || '–'}</td>
                    <td>
                      <Badge tone={STATUS[l.status]?.[1] ?? 'gray'}>{STATUS[l.status]?.[0] ?? l.status}</Badge> <span className="muted small">{l.error}</span>
                    </td>
                    <td>
                      {['failed', 'retry', 'blocked', 'skipped'].includes(l.status) && (
                        <button className="btn secondary" disabled={!!busy} onClick={async () => (await run(`r${l.id}`, () => api.post(`/api/ads/conversions/${l.id}/retry`), 'Neuer Versuch')) && log.reload()}>
                          Erneut
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {check && (
        <Modal title="Prüflauf bei Google" onClose={() => setCheck(null)}>
          <p>{check.ok ? 'Google hat alles akzeptiert – im Prüflauf wird nichts gespeichert.' : 'Google meldet Probleme (im Prüflauf wird nichts gespeichert):'}</p>
          {check.sample && <p className="muted small">Keine wartenden Conversions – geprüft wurde ein Beispiel mit einer Test-E-Mail.</p>}
          <ul className="gconv-check">
            {(check.results as Json[]).map((r, i) => (
              <li key={i}>
                <Badge tone={r.ok ? 'green' : 'red'}>{r.ok ? 'ok' : r.code || 'Fehler'}</Badge> {r.order_id} {r.message && <span className="muted small">– {r.message}</span>}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}
