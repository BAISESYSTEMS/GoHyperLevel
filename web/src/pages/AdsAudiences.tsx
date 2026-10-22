import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { Icon } from '../icons';
import { Badge, Check, Empty, Field, Input, Link, Select, Spinner, TagInput, Textarea, act, confirmAsk, useLoad } from '../ui';
import { AdsModal, PlatformBadge, type Platform } from './AdsKit';
import { MoreFields } from '../areas/fields';
import { GoogleLeadsCard } from './GoogleLeads';

/** Zielgruppen (customer lists from smart lists, lookalikes) and Lead-Formulare (instant forms, lead import). */

// --- audiences ---------------------------------------------------------------------------------------------------

export function AdsAudiences() {
  const { data, loading, reload } = useLoad(() => api.get<any[]>('/api/ads/audiences'), []);
  const [modal, setModal] = useState<null | { kind: 'new' } | { kind: 'sync' | 'lookalike'; a: any }>(null);
  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div>
            <h2 style={{ margin: 0 }}>Zielgruppen aus Smart Lists</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Deine Kontakte als Kundenliste bei Meta (Custom Audience) oder Google (Customer Match) – übertragen werden nur SHA-256-Hashes. Daraus lassen sich bei Meta Lookalikes machen.
            </p>
          </div>
          <button className="btn" data-tour="ads-audience-new" onClick={() => setModal({ kind: 'new' })}>
            + Zielgruppe
          </button>
        </div>
      </div>
      {loading && !data ? (
        <Spinner />
      ) : !data?.length ? (
        <Empty>Noch keine Zielgruppen. Lege eine Smart List an (Kontakte) und mach daraus eine Zielgruppe.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Zielgruppe</th>
                <th>Quelle</th>
                <th>Status</th>
                <th className="num">Übertragen</th>
                <th>Zuletzt</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td>
                    <PlatformBadge platform={a.platform} /> <strong>{a.name}</strong>
                    {a.kind === 'lookalike' && <span className="muted small"> · Lookalike {a.country} {a.ratio ? `${Math.round(a.ratio * 100)} %` : ''}</span>}
                  </td>
                  <td className="muted">{a.kind === 'lookalike' ? 'aus einer Zielgruppe' : a.smart_list_name ? `Smart List „${a.smart_list_name}“` : '–'}</td>
                  <td>
                    <Badge tone={a.status === 'ready' ? 'green' : a.status === 'error' ? 'red' : 'gray'}>{a.status === 'ready' ? 'bereit' : a.status === 'error' ? 'Fehler' : 'läuft'}</Badge>
                    {a.last_error && <div className="small" style={{ color: 'var(--red)' }}>{a.last_error}</div>}
                  </td>
                  <td className="num">{a.kind === 'lookalike' ? '–' : `${a.sent}${a.skipped ? ` (${a.skipped} ausgelassen)` : ''}`}</td>
                  <td className="muted">{dt(a.last_sync_at)}</td>
                  <td className="ads-actions">
                    {a.kind === 'customer_list' && a.smart_list_id && (
                      <button className="btn small secondary" onClick={() => setModal({ kind: 'sync', a })}>
                        Aktualisieren
                      </button>
                    )}
                    {a.platform === 'meta' && a.kind === 'customer_list' && a.status === 'ready' && (
                      <button className="btn small secondary" onClick={() => setModal({ kind: 'lookalike', a })}>
                        Lookalike
                      </button>
                    )}
                    <button className="btn small ghost" onClick={async () => confirmAsk(`Zielgruppe „${a.name}“ löschen${a.platform_id ? ' (auch bei der Plattform)' : ''}?`) && (await act(() => api.del(`/api/ads/audiences/${a.id}`), 'Gelöscht'), reload())}>
                      Löschen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        Meta braucht mindestens 100 passende Personen, Google je nach Liste 1.000 und mehr, bevor eine Liste ausgespielt wird. Neue Listen füllen sich bei Google innerhalb von bis zu 48 Stunden. Abgemeldete Kontakte („Nicht stören“) werden nie übertragen.
      </p>
      {modal?.kind === 'new' && <AudienceModal onClose={() => setModal(null)} onDone={() => (setModal(null), reload())} />}
      {modal?.kind === 'sync' && <AudienceModal sync={modal.a} onClose={() => setModal(null)} onDone={() => (setModal(null), reload())} />}
      {modal?.kind === 'lookalike' && <LookalikeModal a={modal.a} onClose={() => setModal(null)} onDone={() => (setModal(null), reload())} />}
    </>
  );
}

const CONSENT = 'Ich bestätige: Die Kontakte dieser Liste haben der Nutzung ihrer Daten für Werbung zugestimmt. Es werden nur SHA-256-Hashes von E-Mail, Telefon und Name übertragen.';

function AudienceModal({ sync, onClose, onDone }: { sync?: any; onClose: () => void; onDone: () => void }) {
  const lists = useLoad(() => api.get<any[]>('/api/smart-lists').catch(() => []), []);
  const conns = useLoad(() => api.get<any>('/api/ads/overview').catch(() => null), []);
  const [platform, setPlatform] = useState<Platform>(sync?.platform ?? 'meta');
  const [name, setName] = useState('');
  const [list, setList] = useState(sync?.smart_list_id ?? '');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  useEffect(() => {
    if (!list) return setPreview(null);
    api.get(`/api/ads/audiences/preview?platform=${platform}&smart_list_id=${list}`).then(setPreview).catch(() => setPreview(null));
  }, [list, platform]);
  const go = async () => {
    setBusy(true);
    const r = await act(() => (sync ? api.post(`/api/ads/audiences/${sync.id}/sync`, { consent }) : api.post('/api/ads/audiences', { platform, name, smart_list_id: list, consent })), sync ? 'Aktualisiert' : 'Zielgruppe angelegt');
    setBusy(false);
    if (r) onDone();
  };
  return (
    <AdsModal
      title={sync ? `Zielgruppe „${sync.name}“ aktualisieren` : 'Zielgruppe aus Smart List'}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" disabled={busy || !consent || !list || (!sync && !name.trim()) || !preview?.usable} onClick={go}>
            {busy ? 'Überträgt …' : sync ? 'Jetzt übertragen' : 'Anlegen und übertragen'}
          </button>
        </>
      }
    >
      {!sync && (
        <>
          <Field label="Plattform">
            <Select value={platform} onChange={(v) => setPlatform(v as Platform)} options={[['meta', `Meta${conns.data && !conns.data.connected.meta ? ' (nicht verbunden)' : ''}`], ['google', `Google Ads${conns.data && !conns.data.connected.google ? ' (nicht verbunden)' : ''}`]]} />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={setName} placeholder="z. B. Bestandskunden" />
          </Field>
        </>
      )}
      <Field label="Smart List" hint="Die Kontakte, die die Smart List gerade enthält">
        <Select value={list} onChange={setList} placeholder="– wählen –" options={(lists.data ?? []).map((l) => [l.id, l.name] as [string, string])} />
      </Field>
      {preview && (
        <p className="small">
          <strong>{preview.usable}</strong> von {preview.total} Kontakten werden übertragen
          {preview.skipped.opted_out > 0 && ` · ${preview.skipped.opted_out} abgemeldet`}
          {preview.skipped.no_identifier > 0 && ` · ${preview.skipped.no_identifier} ohne E-Mail/Telefon`}.
        </p>
      )}
      <Check checked={consent} onChange={setConsent} label={CONSENT} />
    </AdsModal>
  );
}

function LookalikeModal({ a, onClose, onDone }: { a: any; onClose: () => void; onDone: () => void }) {
  const [country, setCountry] = useState('DE');
  const [ratio, setRatio] = useState('1');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const r = await act(() => api.post(`/api/ads/audiences/${a.id}/lookalike`, { country, ratio: Number(ratio) / 100 }), 'Lookalike angelegt – Meta baut ihn in bis zu 24 Stunden');
    setBusy(false);
    if (r) onDone();
  };
  return (
    <AdsModal
      title="Lookalike erstellen"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" disabled={busy || country.length !== 2} onClick={go}>
            Lookalike anlegen
          </button>
        </>
      }
    >
      <p>
        Meta sucht Menschen, die den Kontakten in <strong>„{a.name}“</strong> ähneln.
      </p>
      <div className="grid2">
        <Field label="Land" hint="Zweistelliger Code, z. B. DE">
          <Input value={country} onChange={(v) => setCountry(v.toUpperCase().slice(0, 2))} />
        </Field>
        <Field label="Größe" hint="1 % = die ähnlichsten, 20 % = breiter">
          <Select value={ratio} onChange={setRatio} options={['1', '2', '3', '5', '10', '15', '20'].map((v) => [v, `${v} %`] as [string, string])} />
        </Field>
      </div>
    </AdsModal>
  );
}

// --- leads ------------------------------------------------------------------------------------------------------------

const QUESTION_LABEL: Record<string, string> = { FULL_NAME: 'Name', FIRST_NAME: 'Vorname', LAST_NAME: 'Nachname', EMAIL: 'E-Mail', PHONE: 'Telefon', CITY: 'Stadt', ZIP: 'PLZ', STREET_ADDRESS: 'Straße', COMPANY_NAME: 'Firma', JOB_TITLE: 'Beruf', STATE: 'Bundesland', COUNTRY: 'Land', DOB: 'Geburtstag', GENDER: 'Geschlecht' };
const STANDARD: [string, string][] = [['FULL_NAME', 'Vollständiger Name'], ['EMAIL', 'E-Mail'], ['PHONE', 'Telefon'], ['CITY', 'Stadt'], ['ZIP', 'PLZ'], ['COMPANY_NAME', 'Firma']];

export function LeadFormModal({ onClose, onCreated }: { onClose: () => void; onCreated: (f: any) => void }) {
  const [f, setF] = useState({ name: '', headline: '', description: '', privacy_url: '', thank_title: 'Danke!', thank_body: 'Wir melden uns bei dir.', thank_url: '' });
  const [std, setStd] = useState<string[]>(['FULL_NAME', 'EMAIL', 'PHONE']);
  const [custom, setCustom] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  const go = async () => {
    setBusy(true);
    const r = await act(
      () =>
        api.post('/api/ads/leadforms', {
          name: f.name,
          headline: f.headline,
          description: f.description,
          questions: [...std, ...custom.filter(Boolean).map((label) => ({ type: 'CUSTOM', label }))],
          privacy_url: f.privacy_url,
          thank_you: { title: f.thank_title, body: f.thank_body, url: f.thank_url },
        }),
      'Sofortformular bei Meta angelegt',
    );
    setBusy(false);
    if (r) onCreated(r);
  };
  return (
    <AdsModal
      title="Neues Sofortformular"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" disabled={busy || !f.name.trim() || !f.privacy_url.trim() || !std.length} onClick={go}>
            {busy ? 'Legt an …' : 'Bei Meta anlegen'}
          </button>
        </>
      }
    >
      <div className="grid2">
        <Field label="Name des Formulars" hint="Nur intern sichtbar">
          <Input value={f.name} onChange={(v) => set('name', v)} placeholder="Probestunde Herbst" />
        </Field>
        <Field label="Link zur Datenschutzerklärung (nötig)" hint="Beginnt mit https://">
          <Input value={f.privacy_url} onChange={(v) => set('privacy_url', v)} placeholder="https://" />
        </Field>
      </div>
      <h3>Fragen</h3>
      <div className="ads-langs">
        {STANDARD.map(([k, label]) => (
          <Check key={k} checked={std.includes(k)} onChange={(v) => setStd(v ? [...std, k] : std.filter((x) => x !== k))} label={label} />
        ))}
      </div>
      {/* Einfach-Modus: headline, short text, own questions and the thank-you page (good defaults) behind one toggle */}
      <MoreFields id="ads-leadform" values={[f.headline, f.description, custom, f.thank_title !== 'Danke!', f.thank_body !== 'Wir melden uns bei dir.', f.thank_url]}>
        <div className="grid2">
          <Field label="Überschrift (optional)">
            <Input value={f.headline} onChange={(v) => set('headline', v)} maxLength={60} />
          </Field>
          <Field label="Kurztext (optional)">
            <Input value={f.description} onChange={(v) => set('description', v)} />
          </Field>
        </div>
        <Field label="Eigene Fragen" hint="Antworten landen als eigenes Feld am Kontakt und in der Notiz">
          <TagInput value={custom} onChange={setCustom} placeholder="Frage + Enter, z. B. Welche Erfahrung hast du?" />
        </Field>
        <h3>Danke-Seite</h3>
        <div className="grid2">
          <Field label="Titel">
            <Input value={f.thank_title} onChange={(v) => set('thank_title', v)} maxLength={60} />
          </Field>
          <Field label="Link (optional)">
            <Input value={f.thank_url} onChange={(v) => set('thank_url', v)} placeholder="https://" />
          </Field>
        </div>
        <Field label="Text">
          <Textarea rows={2} value={f.thank_body} onChange={(v) => set('thank_body', v)} />
        </Field>
      </MoreFields>
    </AdsModal>
  );
}

export function AdsLeads() {
  const status = useLoad(() => api.get<any>('/api/ads/leads/status').catch(() => null), []);
  const forms = useLoad(() => api.get<any[]>('/api/ads/leadforms').catch(() => []), []);
  const leads = useLoad(() => api.get<any[]>('/api/ads/leads').catch(() => []), []);
  const [newForm, setNewForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState<string[] | null>(null);
  const s = status.data;
  const run = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    const r = await act(fn, ok);
    setBusy(false);
    status.reload();
    leads.reload();
    return r;
  };
  if (status.loading && !s) return <Spinner />;
  return (
    <>
      <div className="card" data-tour="ads-leads-enable">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0 }}>Leads aus Meta-Lead-Anzeigen</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Jede Antwort wird zum Kontakt (mit Tags, Antworten als Notiz, Kampagne als Quelle) und startet Automationen mit dem Auslöser „Neuer Lead aus Anzeige“.
            </p>
          </div>
          {s?.enabled ? <Badge tone="green">Import an</Badge> : <Badge>Import aus</Badge>}
        </div>
        {!s?.page ? (
          <p className="muted">
            Dafür braucht es eine verbundene Facebook-Seite – unter <Link to="ads/connections">Verbindungen</Link> mit der Option „Lead-Formulare“ verbinden und die Seite wählen.
          </p>
        ) : (
          <>
            <p className="small">
              Seite: <strong>{s.page.name || s.page.id}</strong>
              {!s.page_token && <span style={{ color: 'var(--red)' }}> · kein Seiten-Zugriff – neu verbinden mit „Lead-Formulare“</span>}
              {s.polled_at && <span className="muted"> · zuletzt abgeholt {dt(s.polled_at)}</span>}
            </p>
            <Field label="Tags für neue Leads" hint="Lösen auch „Tag hinzugefügt“-Automationen aus">
              <TagInput value={tags ?? s.tags} onChange={setTags} placeholder="Tag + Enter" />
            </Field>
            <div className="actions">
              {!s.enabled ? (
                <button className="btn" disabled={busy || !s.page_token} onClick={() => run(async () => { const r = await api.post('/api/ads/leads/enable', { tags: tags ?? s.tags }); if (r.warning) await act(() => Promise.reject(new Error(r.warning))); return r; }, 'Lead-Import ist an')}>
                  Lead-Import einschalten
                </button>
              ) : (
                <>
                  <button className="btn secondary" disabled={busy || !tags} onClick={() => run(() => api.put('/api/ads/leads/settings', { tags }), 'Gespeichert')}>
                    Tags speichern
                  </button>
                  <button className="btn secondary" disabled={busy} onClick={() => run(() => api.post('/api/ads/leads/poll', {}), 'Abgeholt')}>
                    <Icon name="refresh" /> Jetzt abholen
                  </button>
                  <button className="btn ghost" disabled={busy} onClick={() => confirmAsk('Lead-Import ausschalten?') && run(() => api.post('/api/ads/leads/disable', {}), 'Ausgeschaltet')}>
                    Ausschalten
                  </button>
                </>
              )}
            </div>
            <details className="ads-more">
              <summary>Webhook bei Meta einrichten (einmal pro Meta-App)</summary>
              <p className="small">
                Meta-App → Webhooks → Objekt <em>Page</em> → Callback-URL <code>{s.webhook_url}</code>, Verifizierungs-Token <code>{s.verify_token}</code>, Feld <code>leadgen</code> abonnieren. Ohne Webhook holt HyperLevel die Leads alle 10 Minuten ab. Details in docs/ads-manager.md.
              </p>
            </details>
          </>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Sofortformulare</h2>
          <button className="btn" disabled={!s?.page_token} onClick={() => setNewForm(true)}>
            + Formular
          </button>
        </div>
        {(forms.data ?? []).length === 0 ? (
          <p className="muted">Noch keine Formulare von HyperLevel. Lege eines an und wähle es in der Kampagne.</p>
        ) : (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="t">
              <thead>
                <tr>
                  <th>Formular</th>
                  <th>Fragen</th>
                  <th>Angelegt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {forms.data!.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <strong>{f.name}</strong>
                    </td>
                    <td className="muted">{(f.spec?.questions ?? []).map((q: any) => (typeof q === 'string' ? QUESTION_LABEL[q] ?? q : q.label)).join(', ')}</td>
                    <td className="muted">{dt(f.created_at)}</td>
                    <td className="ads-actions">
                      <button className="btn small ghost" onClick={async () => confirmAsk(`Formular „${f.name}“ archivieren?`) && (await act(() => api.del(`/api/ads/leadforms/${f.id}`), 'Archiviert'), forms.reload())}>
                        Archivieren
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(leads.data ?? []).length > 0 && (
        <div className="card">
          <h2>Zuletzt importierte Leads</h2>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Kontakt</th>
                  <th>Kampagne</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {leads.data!.slice(0, 20).map((l) => (
                  <tr key={l.leadgen_id}>
                    <td className="muted">{dt(l.created_at)}</td>
                    <td>{l.contact_id ? <Link to={`contacts/${l.contact_id}`}>{[l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || 'Kontakt'}</Link> : '–'}</td>
                    <td className="muted">{l.campaign_name || '–'}</td>
                    <td>
                      <Badge tone={l.status === 'imported' ? 'green' : l.status === 'failed' ? 'red' : 'gray'}>{l.status === 'imported' ? 'importiert' : l.status === 'failed' ? 'Fehler' : 'übersprungen'}</Badge>
                      {l.error && <span className="muted small"> {l.error}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {newForm && <LeadFormModal onClose={() => setNewForm(false)} onCreated={() => (setNewForm(false), forms.reload())} />}
      <GoogleLeadsCard />
    </>
  );
}
