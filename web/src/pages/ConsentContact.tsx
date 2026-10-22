import { useState } from 'react';
import { api, currentLocation, dt } from '../api';
import { Badge, Check, Copy, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, toast, useLoad } from '../ui';

/** The consent tab of a contact: status per channel and purpose, the history with its proof, and the actions (record, withdraw, ask again, export). */

const STATUS: Record<string, [string, 'green' | 'yellow' | 'red' | 'gray']> = {
  confirmed: ['Bestätigt', 'green'],
  pending: ['Bestätigung offen', 'yellow'],
  revoked: ['Widerrufen', 'red'],
  unknown: ['Unbekannt', 'gray'],
};
const ACTION: Record<string, string> = { granted: 'Einwilligung erteilt', confirmed: 'Bestätigt (Double-Opt-in)', revoked: 'Widerrufen', declined: 'Abgelehnt', expired: 'Bestätigung abgelaufen', reset: 'Zurückgesetzt', legacy: 'Altbestand (ohne Nachweis)' };
const SOURCE: Record<string, string> = { form: 'Formular', funnel: 'Funnel', webinar: 'Webinar', community: 'Community', import: 'Import', api: 'API', manual: 'Manuell', unsubscribe: 'Abmeldelink', preferences: 'Einstellungsseite', doi: 'Bestätigungslink', checkout: 'Bestellung', cmp: 'Cookie-Banner', system: 'System' };
const PURPOSE: Record<string, string> = { newsletter: 'Newsletter', marketing: 'Werbung & Angebote', webinar: 'Webinar-Hinweise', community: 'Community', transactional: 'Service & Vertrag', statistics: 'Statistik', external_media: 'Externe Medien', '*': 'alle Zwecke' };
const CHANNEL_PURPOSES: Record<string, string[]> = { email: ['newsletter', 'marketing', 'webinar', 'community'], sms: ['marketing', 'webinar'], whatsapp: ['marketing', 'webinar'], phone: ['marketing'], tracking: ['statistics', 'marketing', 'external_media'] };
const CHANNELS: [string, string][] = [['email', 'E-Mail'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp'], ['phone', 'Telefon']];
const CHANNEL: Record<string, string> = { email: 'E-Mail', sms: 'SMS', whatsapp: 'WhatsApp', phone: 'Telefon', tracking: 'Tracking' };

export function StatusBadge({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? STATUS.unknown;
  return <Badge tone={tone}>{label}</Badge>;
}

function RecordDialog({ contact, onClose, onDone, mode }: { contact: any; onClose: () => void; onDone: () => void; mode: 'granted' | 'revoked' }) {
  const [channel, setChannel] = useState('email');
  const [purposes, setPurposes] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  const [proof, setProof] = useState('');
  const [doi, setDoi] = useState(false);
  const options = CHANNEL_PURPOSES[channel];
  const give = mode === 'granted';
  const submit = async () => {
    const r = await act(() => api.post(`/api/contacts/${contact.id}/consent`, { action: mode, channel, purposes, note, text: text || undefined, proof_url: proof || undefined, doi: give ? doi : undefined }), give ? (doi ? 'Bestätigungs-Mail wird gesendet' : 'Einwilligung gespeichert') : 'Widerruf gespeichert');
    if (r) onDone();
  };
  return (
    <Modal
      title={give ? 'Einwilligung erfassen' : 'Widerruf erfassen'}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={submit} disabled={give ? !doi && !note.trim() && !text.trim() : false} data-tour="consent-record-save">
            {give ? (doi ? 'Bestätigungs-Mail senden' : 'Speichern') : 'Widerruf speichern'}
          </button>
        </>
      }
    >
      <div className="grid2">
        <Field label="Kanal">
          <Select value={channel} onChange={(v) => (setChannel(v), setPurposes([]))} options={give ? CHANNELS.map(([k, l]) => [k, l]) : [['all', 'Alle Kanäle'], ...CHANNELS]} />
        </Field>
        <Field label="Zweck" hint={give ? undefined : 'Nichts angehakt = alle Zwecke'}>
          <div>
            {(channel === 'all' ? [] : options).map((p) => (
              <Check key={p} checked={purposes.includes(p)} onChange={(v) => setPurposes(v ? [...purposes, p] : purposes.filter((x) => x !== p))} label={PURPOSE[p]} />
            ))}
          </div>
        </Field>
      </div>
      {give && (
        <>
          <Field label="Nachweis" hint="Wie und wann hat die Person zugestimmt? Ohne Nachweis ist eine Einwilligung vor Gericht wertlos.">
            <Textarea value={note} onChange={setNote} placeholder="z. B. Am 12.03.2026 am Telefon ausdrücklich zugestimmt, Gespräch notiert von …" />
          </Field>
          <Field label="Wortlaut der Einwilligung (optional)">
            <Textarea value={text} onChange={setText} placeholder="Ich möchte den Newsletter per E-Mail erhalten." />
          </Field>
          <Field label="Nachweis-Link (optional)">
            <Input value={proof} onChange={setProof} placeholder="https://…" />
          </Field>
          {channel === 'email' && <Check checked={doi} onChange={setDoi} label="Stattdessen per Double-Opt-in anfragen (die Person bekommt eine Bestätigungs-Mail; erst ihr Klick zählt)" />}
        </>
      )}
      {!give && <Field label="Notiz (optional)"><Textarea value={note} onChange={setNote} placeholder="z. B. Per E-Mail widerrufen am …" /></Field>}
    </Modal>
  );
}

export function ContactConsent({ contactId }: { contactId: string }) {
  const { data, reload } = useLoad(() => api.get(`/api/contacts/${contactId}/consent`), [contactId]);
  const [modal, setModal] = useState<'granted' | 'revoked' | null>(null);
  if (!data) return <Spinner />;
  const loc = encodeURIComponent(currentLocation());
  const base = `/api/contacts/${encodeURIComponent(contactId)}/consent`;
  const email = data.channels.email;
  return (
    <div data-tour="contact-consent">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="grow muted small">
          Versandregel: {data.policy === 'confirmed' ? 'nur bestätigte Einwilligungen' : 'Bestätigte und Altbestand ohne Nachweis'}.
          {email.status === 'unknown' && email.legacy && <> Zu diesem Kontakt gibt es keinen Nachweis (Quelle: {data.contact.source || 'unbekannt'}).</>}
        </div>
        <div className="actions">
          <button className="btn small" onClick={() => setModal('granted')} data-tour="consent-record">
            Einwilligung erfassen
          </button>
          <button className="btn small secondary" onClick={() => setModal('revoked')}>
            Widerruf erfassen
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, alignItems: 'stretch' }} data-tour="consent-channels">
        {Object.entries(data.channels as Record<string, any>).map(([ch, s]) => (
          <div key={ch} className="card" style={{ padding: 12, margin: 0 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{s.channel_label}</strong>
              <StatusBadge status={s.status} />
            </div>
            {(s.reason || s.since) && (
              <div className="muted small">
                {s.reason}
                {s.since ? `${s.reason ? ' · ' : ''}seit ${dt(s.since)}` : ''}
              </div>
            )}
            <div className="small" style={{ marginTop: 6 }}>
              {Object.entries(s.purposes as Record<string, any>)
                .filter(([p, x]) => p !== 'transactional' && (x.status !== 'unknown' || ch === 'email'))
                .map(([p, x]) => (
                  <div key={p}>
                    {PURPOSE[p]}: <StatusBadge status={x.status} />
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>

      {data.contact.dnd && (
        <p className="muted small" style={{ marginTop: 8 }}>
          „Nicht stören“ ist aktiv – das gilt als Widerruf für alle Kanäle.{' '}
          <a href="#" onClick={async (e) => (e.preventDefault(), (await act(() => api.post(base, { action: 'reset', note: 'Sperre vom Team aufgehoben' }), 'Sperre aufgehoben')) && reload())}>
            Sperre aufheben (Status: unbekannt)
          </a>
        </p>
      )}

      {data.doi.filter((x: any) => x.status === 'pending').map((x: any) => (
        <div key={x.id} className="card" style={{ marginTop: 10, padding: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              Bestätigung per E-Mail offen seit {dt(x.requested_at)} <span className="muted small">(läuft ab {dt(x.expires_at)})</span>
            </span>
            <button className="btn small secondary" onClick={async () => (await act(() => api.post(`${base}/doi`, { doi_id: x.id }), 'Mail erneut gesendet')) && reload()}>
              Mail erneut senden
            </button>
          </div>
        </div>
      ))}
      {email.status !== 'confirmed' && email.status !== 'pending' && data.contact.email && (
        <p className="small" style={{ marginTop: 10 }}>
          <a href="#" onClick={async (e) => (e.preventDefault(), (await act(() => api.post(`${base}/doi`, { purposes: ['newsletter'] }), 'Bestätigungs-Mail wird gesendet')) && reload())}>
            Per Double-Opt-in um Einwilligung bitten
          </a>{' '}
          <span className="muted">– nur sinnvoll, wenn die Person vorher danach gefragt hat oder zugestimmt hat, ihre Zustimmung zu bestätigen.</span>
        </p>
      )}

      <div className="row" style={{ margin: '14px 0 6px', justifyContent: 'space-between' }}>
        <strong>Verlauf & Nachweis</strong>
        <div className="actions">
          <a className="btn small secondary" href={`${base}/export.pdf?locationId=${loc}`} data-tour="consent-export">
            Nachweis als PDF
          </a>
          <a className="btn small secondary" href={`${base}/export.csv?locationId=${loc}`}>
            als CSV
          </a>
          <Copy text={data.preferences_url} label="Link zur Einstellungsseite" />
        </div>
      </div>
      {!data.events.length ? (
        <Empty>Noch keine Einwilligungsereignisse. Neue Anmeldungen über Formulare, Webinare, die API oder Importe erscheinen hier mit Quelle, Zeitpunkt und Text.</Empty>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} data-tour="consent-history">
          {data.events.map((e: any) => (
            <li key={e.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <Badge tone={e.action === 'revoked' || e.action === 'expired' ? 'red' : e.action === 'granted' && e.doi_required ? 'yellow' : e.action === 'granted' || e.action === 'confirmed' ? 'green' : 'gray'}>{e.action === 'granted' && e.doi_required ? 'Angefragt (Double-Opt-in)' : ACTION[e.action] ?? e.action}</Badge>
                <span className="muted small">{dt(e.created_at)}</span>
              </div>
              <div className="small" style={{ marginTop: 4 }}>
                {CHANNEL[e.channel] ?? e.channel} · {PURPOSE[e.purpose] ?? e.purpose} – {SOURCE[e.source_kind] ?? e.source_kind}
                {e.source_label ? `: ${e.source_label}` : ''}
              </div>
              <div className="small muted">
                {e.text && (
                  <div title={e.text}>
                    „{e.text.length > 140 ? `${e.text.slice(0, 140)}…` : e.text}“{e.text_version ? ` (Version ${e.text_version})` : ''}
                  </div>
                )}
                {e.note && <div>{e.note}</div>}
                {(e.ip_net || e.proof_url) && (
                  <div>
                    {e.ip_net ? `IP-Netz ${e.ip_net}` : ''}
                    {e.ip_net && e.proof_url ? ' · ' : ''}
                    {e.proof_url && (
                      <a href={e.proof_url} target="_blank" rel="noopener noreferrer">
                        Nachweis-Link
                      </a>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {modal && <RecordDialog contact={data.contact} mode={modal} onClose={() => setModal(null)} onDone={() => (setModal(null), reload(), toast('Aktualisiert'))} />}
    </div>
  );
}
