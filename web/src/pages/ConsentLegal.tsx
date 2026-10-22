import { useEffect, useState } from 'react';
import { api, currentLocation } from '../api';
import { Badge, Check, Copy, Empty, Field, Input, Modal, Select, Spinner, act, toast, useLoad } from '../ui';
import { LegalNotice } from './ConsentKit';

/** Settings → Einwilligung & Recht → Rechtstexte: company data, detected services, and the generators (drafts, never legal advice). */

const DOCS: { kind: string; label: string; hint: string; hosted: boolean; funnel: boolean }[] = [
  { kind: 'impressum', label: 'Impressum', hint: 'Anbieterkennzeichnung nach § 5 DDG.', hosted: true, funnel: true },
  { kind: 'datenschutz', label: 'Datenschutzerklärung', hint: 'Passt sich an die genutzten Module an (Formulare, Webinare, E-Mail-Tracking, Zahlungen, Einbettungen …).', hosted: true, funnel: true },
  { kind: 'widerruf', label: 'Widerrufsbelehrung', hint: 'Mit Muster-Widerrufsformular, für digitale Inhalte, Dienstleistungen oder Waren.', hosted: true, funnel: false },
  { kind: 'avv', label: 'Auftragsverarbeitungsvertrag (AVV)', hint: 'Entwurf nach Art. 28 DSGVO für Kunden, deren Daten du verarbeitest.', hosted: false, funnel: false },
  { kind: 'vvt', label: 'Verzeichnis von Verarbeitungstätigkeiten (VVT)', hint: 'Entwurf nach Art. 30 DSGVO – interne Dokumentation.', hosted: false, funnel: false },
];

const BASE = '/api/legal/export';

function DocDialog({ doc, onClose }: { doc: (typeof DOCS)[number]; onClose: () => void }) {
  const [opts, setOpts] = useState<Record<string, string>>({ type: 'digital' });
  const [out, setOut] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [funnel, setFunnel] = useState('');
  const funnels = useLoad(() => (doc.funnel ? api.get<any[]>('/api/funnels').catch(() => []) : Promise.resolve([])), []);
  const loc = encodeURIComponent(currentLocation());
  const set = (k: string, v: string) => setOpts({ ...opts, [k]: v });
  const make = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/legal/generate', { kind: doc.kind, ...opts }));
    setBusy(false);
    if (r) setOut(r);
  };
  useEffect(() => void make(), []);
  const query = new URLSearchParams({ kind: doc.kind, ...opts }).toString();
  const hostedUrl = `${location.origin}/legal/${currentLocation()}/${doc.kind}`;
  const srcDoc = out ? `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font:15px/1.55 system-ui,sans-serif;margin:16px;color:#111827}h1{font-size:22px}h2{font-size:17px;margin-top:22px}</style>${out.html}` : '';
  return (
    <Modal title={doc.label} onClose={onClose} wide>
      <div data-tour="legal-doc">
        <LegalNotice />
        {doc.kind === 'widerruf' && (
          <Field label="Was verkaufst du?">
            <Select value={opts.type} onChange={(v) => set('type', v)} options={[['digital', 'Digitale Inhalte (Downloads, Kurse, Software)'], ['service', 'Dienstleistungen'], ['physical', 'Waren (Versand)']]} />
          </Field>
        )}
        {doc.kind === 'avv' && (
          <div className="grid2" data-tour="legal-avv">
            <Field label="Auftraggeber (dein Kunde) – Name"><Input value={opts.controller_name ?? ''} onChange={(v) => set('controller_name', v)} /></Field>
            <Field label="Auftraggeber – Anschrift"><Input value={opts.controller_address ?? ''} onChange={(v) => set('controller_address', v)} /></Field>
            <Field label="Auftraggeber – vertreten durch"><Input value={opts.controller_representative ?? ''} onChange={(v) => set('controller_representative', v)} /></Field>
            <Field label="Leistung (Kurzbeschreibung)"><Input value={opts.service ?? ''} onChange={(v) => set('service', v)} placeholder="z. B. Bereitstellung und Betrieb der CRM-Software" /></Field>
          </div>
        )}
        {(doc.kind === 'widerruf' || doc.kind === 'avv') && (
          <p>
            <button className="btn secondary" disabled={busy} onClick={make}>Entwurf aktualisieren</button>
          </p>
        )}
        {!out ? (
          <Spinner />
        ) : (
          <>
            {out.missing?.length > 0 && (
              <p className="card" style={{ marginBottom: 8 }} data-tour="legal-missing">
                <strong>Noch zu ergänzen:</strong> {out.missing.join(', ')}. Im Text stehen diese Stellen als „[bitte ergänzen: …]“.
              </p>
            )}
            {out.external && !out.external.used && out.external.reason !== 'Keine externe Quelle eingerichtet' && <p className="muted small">{out.external.reason}</p>}
            <iframe title={doc.label} sandbox="" srcDoc={srcDoc} style={{ width: '100%', height: 420, border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }} />
            <p className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }} data-tour="legal-downloads">
              {(['pdf', 'html', 'md', 'txt'] as const).map((f) => (
                <a key={f} className="btn secondary small" href={`${BASE}?${query}&format=${f}&locationId=${loc}`}>
                  {f === 'md' ? 'Markdown' : f.toUpperCase()}
                </a>
              ))}
              <Copy text={out.markdown} label="Text kopieren" />
            </p>
            {doc.hosted && (
              <p className="muted small">
                Gehostete Kopie (für Formulare, Kaufseiten und Checkout): <a href={hostedUrl} target="_blank" rel="noopener noreferrer">{hostedUrl}</a> – sie wird erst veröffentlicht, sobald Firmenname und eine Kontaktmöglichkeit eingetragen sind.
              </p>
            )}
            {doc.funnel && (
              <div className="card" data-tour="legal-apply">
                <strong>In eine Website übernehmen</strong>
                <p className="muted small">Legt die Seite „{doc.label}“ an bzw. ersetzt sie, wenn dort noch der Platzhalter „Hier einfügen“ steht, und verlinkt sie im Footer.</p>
                <div className="row" style={{ gap: 8 }}>
                  <Select value={funnel} onChange={setFunnel} placeholder="Funnel / Website wählen …" options={(funnels.data ?? []).map((f: any) => [f.id, f.name] as [string, string])} />
                  <button
                    className="btn"
                    disabled={!funnel}
                    onClick={async () => {
                      const r = await act(() => api.post(`/api/legal/funnels/${funnel}/apply`, { kinds: [doc.kind] }));
                      if (r) toast(r.pages.length ? `Übernommen: ${r.pages.map((p: any) => (p.created ? 'angelegt' : 'aktualisiert')).join(', ')}` : 'Nichts geändert – die Seite hat bereits eigenen Text');
                    }}
                  >
                    Übernehmen
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

export function LegalWizard() {
  const { data, reload } = useLoad(() => api.get('/api/legal/profile'), []);
  const services = useLoad(() => api.get('/api/legal/services'), []);
  const [p, setP] = useState<any>();
  const [open, setOpen] = useState<(typeof DOCS)[number] | null>(null);
  useEffect(() => data && setP(data.profile), [data]);
  if (!p) return <Spinner />;
  const set = (patch: any) => setP({ ...p, ...patch });
  const registered = ['ek', 'ug', 'gmbh', 'ag', 'verein'].includes(p.form);
  const save = async () => {
    const r = await act(() => api.put('/api/legal/profile', p), 'Gespeichert');
    if (r) (setP(r.profile), void reload(), void services.reload());
  };
  const setOverride = async (id: string, v: string) => {
    const next = { ...p.overrides };
    if (v === '') delete next[id];
    else next[id] = v === 'on';
    const r = await act(() => api.put('/api/legal/profile', { overrides: next }));
    if (r) (setP(r.profile), void services.reload());
  };
  const ready = !!p.company.trim() && (!!p.email.trim() || !!p.street.trim());
  return (
    <>
      <LegalNotice />
      <div className="card" data-tour="legal-profile">
        <h2>Firmendaten</h2>
        <p className="muted">
          Daraus entstehen Impressum, Datenschutzerklärung, Widerrufsbelehrung und AVV. Felder, die du leer lässt, erscheinen im Text als „[bitte ergänzen: …]“ – es wird nichts erfunden.
          {data?.prefilled && ' Die Felder wurden aus den Firmendaten des Sub-Accounts vorbelegt.'}
        </p>
        <div className="grid2">
          <Field label="Rechtsform"><Select value={p.form} onChange={(v) => set({ form: v })} options={(data.forms as { key: string; label: string }[]).map((f) => [f.key, f.label] as [string, string])} /></Field>
          <Field label="Firma / Name"><Input value={p.company} onChange={(v) => set({ company: v })} /></Field>
          <Field label={registered ? 'Vertretungsberechtigt (Geschäftsführung / Vorstand)' : 'Inhaber/in'}><Input value={p.owner} onChange={(v) => set({ owner: v })} /></Field>
          <Field label="Straße und Hausnummer"><Input value={p.street} onChange={(v) => set({ street: v })} /></Field>
          <Field label="PLZ"><Input value={p.zip} onChange={(v) => set({ zip: v })} /></Field>
          <Field label="Ort"><Input value={p.city} onChange={(v) => set({ city: v })} /></Field>
          <Field label="Land"><Input value={p.country} onChange={(v) => set({ country: v })} /></Field>
          <Field label="E-Mail"><Input value={p.email} onChange={(v) => set({ email: v })} /></Field>
          <Field label="Telefon"><Input value={p.phone} onChange={(v) => set({ phone: v })} /></Field>
          <Field label="Website"><Input value={p.website} onChange={(v) => set({ website: v })} placeholder="https://…" /></Field>
          {registered && <Field label="Registergericht"><Input value={p.register_court} onChange={(v) => set({ register_court: v })} placeholder="z. B. Amtsgericht München" /></Field>}
          {registered && <Field label="Registernummer"><Input value={p.register_no} onChange={(v) => set({ register_no: v })} placeholder="HRB 123456" /></Field>}
          <Field label="Umsatzsteuer-ID" hint="Nur eintragen, wenn vorhanden (Kleinunternehmer: leer lassen)."><Input value={p.vat_id} onChange={(v) => set({ vat_id: v })} placeholder="DE123456789" /></Field>
          <Field label="Inhaltlich verantwortlich (§ 18 MStV)" hint="Nur bei redaktionellen Inhalten (Blog, Newsletter mit Inhalten)."><Input value={p.responsible} onChange={(v) => set({ responsible: v })} /></Field>
          {p.form === 'freiberuf' && <Field label="Berufsbezeichnung und Kammer"><Input value={p.profession} onChange={(v) => set({ profession: v })} /></Field>}
          {p.form === 'freiberuf' && <Field label="Aufsichtsbehörde"><Input value={p.authority} onChange={(v) => set({ authority: v })} /></Field>}
        </div>
        <h3>Datenschutz</h3>
        <div className="grid2">
          <Field label="Datenschutzbeauftragte/r (Name)" hint="Nur wenn benannt."><Input value={p.dpo_name} onChange={(v) => set({ dpo_name: v })} /></Field>
          <Field label="Kontakt Datenschutz (E-Mail)"><Input value={p.dpo_email} onChange={(v) => set({ dpo_email: v })} /></Field>
          <Field label="Hosting / Serverstandort"><Input value={p.hosting} onChange={(v) => set({ hosting: v })} placeholder="z. B. Hosting-Anbieter, Rechenzentrum in Deutschland" /></Field>
          <Field label="Zuständige Aufsichtsbehörde"><Input value={p.supervisory} onChange={(v) => set({ supervisory: v })} placeholder="z. B. Landesbeauftragte/r für Datenschutz …" /></Field>
        </div>
        <h3>Verbraucherstreitbeilegung</h3>
        <div className="grid2">
          <Field label="Teilnahme">
            <Select value={p.dispute} onChange={(v) => set({ dispute: v })} options={[['unwilling', 'Nicht bereit und nicht verpflichtet'], ['willing', 'Bereit, an einem Verfahren teilzunehmen'], ['none', 'Keine Verbraucher-Geschäfte (nicht angeben)']]} />
          </Field>
          {p.dispute === 'willing' && <Field label="Schlichtungsstelle (Name, Anschrift, Website)"><Input value={p.dispute_body} onChange={(v) => set({ dispute_body: v })} /></Field>}
        </div>
        <p>
          <button className="btn" onClick={save} data-tour="legal-save">Speichern</button>
        </p>
      </div>

      <div className="card" data-tour="legal-services">
        <h2>Genutzte Dienste</h2>
        <p className="muted">
          Die Datenschutzerklärung nennt nur, was du wirklich nutzt. Erkannt wird aus deinen Einstellungen und Daten; Dienste außerhalb von HyperLevel (z. B. ein Tool in deinem Website-Code, das nicht erkannt wurde) kannst du hier von Hand einschalten – oder Erkanntes abschalten.
        </p>
        {!services.data ? (
          <Spinner />
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Dienst</th><th>Erkannt</th><th>Im Text</th><th>Überschreiben</th></tr></thead>
              <tbody>
                {services.data.services.map((s: any) => (
                  <tr key={s.id}>
                    <td>{s.label}</td>
                    <td>{s.detected ? <Badge tone="green">ja</Badge> : <Badge>nein</Badge>}</td>
                    <td>{s.active ? <Badge tone="blue">ja</Badge> : <Badge>nein</Badge>}</td>
                    <td>
                      <Select value={s.override === null ? '' : s.override ? 'on' : 'off'} onChange={(v) => setOverride(s.id, v)} options={[['', 'Automatisch'], ['on', 'Immer nennen'], ['off', 'Nie nennen']]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {services.data?.facts?.trackers?.length > 0 && <p className="muted small">Im Website-Code erkannte Tracker: {services.data.facts.trackers.join(', ')}</p>}
        {services.data?.facts?.embeds?.length > 0 && <p className="muted small">Erkannte Einbettungen: {services.data.facts.embeds.join(', ')}</p>}
      </div>

      <div className="card" data-tour="legal-docs">
        <h2>Dokumente</h2>
        {!ready && <Empty>Trage oben mindestens Firmenname und E-Mail oder Anschrift ein und speichere – dann sind die gehosteten Seiten und die Übernahme in Websites freigeschaltet. Entwürfe kannst du jederzeit ansehen.</Empty>}
        <div className="grid2">
          {DOCS.map((d) => (
            <div className="card" key={d.kind} style={{ margin: 0 }}>
              <strong>{d.label}</strong>
              <p className="muted small">{d.hint}</p>
              <button className="btn secondary" onClick={() => setOpen(d)} data-tour={`legal-open-${d.kind}`}>Entwurf ansehen</button>
            </div>
          ))}
        </div>
      </div>

      <div className="card" data-tour="legal-external">
        <h2>Externe Textquelle (optional)</h2>
        <p className="muted small">Platzhalter für Dienste wie eRecht24. Solange keine Schnittstelle eingerichtet ist, wird nichts abgerufen und die Vorlagen von HyperLevel werden verwendet.</p>
        <Check checked={p.external.enabled} onChange={(v) => set({ external: { ...p.external, enabled: v } })} label="Externe Quelle für Impressum und Datenschutz verwenden, sobald verfügbar" />
        {p.external.enabled && (
          <div className="grid2">
            <Field label="Anbieter"><Select value={p.external.provider} onChange={(v) => set({ external: { ...p.external, provider: v } })} options={[['erecht24', 'eRecht24']]} /></Field>
            <Field label="Projekt-ID"><Input value={p.external.project} onChange={(v) => set({ external: { ...p.external, project: v } })} /></Field>
            <Field label="API-Schlüssel" hint="Wird verschlüsselt gespeichert und nie wieder angezeigt."><Input type="password" value={p.external.apiKey} onChange={(v) => set({ external: { ...p.external, apiKey: v } })} /></Field>
          </div>
        )}
        <p><button className="btn secondary" onClick={save}>Speichern</button></p>
      </div>
      {open && <DocDialog doc={open} onClose={() => setOpen(null)} />}
    </>
  );
}
