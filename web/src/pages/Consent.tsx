import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { PageSuspense, lazyPages } from '../lazy';
import { Badge, Check, Empty, Field, Input, Select, Spinner, Tabs, Textarea, act, useLoad } from '../ui';
import { LegalNotice } from './ConsentKit';
import { MoreFields } from '../areas/fields';

const { CmpEditor } = lazyPages(() => import('./ConsentCmp'), 'CmpEditor');
const { LegalWizard } = lazyPages(() => import('./ConsentLegal'), 'LegalWizard');
const { CheckoutLaw } = lazyPages(() => import('./ConsentCheckout'), 'CheckoutLaw');

/**
 * Settings → Einwilligung & Recht: consent ledger settings (send rule, Double-Opt-in), the cookie banner, the legal text
 * generators, the checkout rules and the log. Everything here is German-law oriented and says so – and says "keine Rechtsberatung".
 */

const SOURCES: [string, string, string][] = [
  ['form', 'Formulare', 'Nur Formulare, die eine Einwilligung einholen (Formular → Einstellungen → Einwilligung).'],
  ['funnel', 'Funnels & Websites', 'Formulare, die auf einer Funnel-Seite ausgefüllt werden.'],
  ['webinar', 'Webinar-Anmeldung', 'Die Anmeldeseite des Webinars (Einwilligung zu Erinnerungen).'],
  ['community', 'Community-Anmeldung', 'Beitrittsseite mit Einwilligungstext.'],
  ['import', 'Importe', 'Gilt für Importe, bei denen „Double-Opt-in“ gewählt wird.'],
  ['api', 'API', 'Kontakte, die per API mit Einwilligung angelegt werden.'],
];
const ACTION: Record<string, string> = { granted: 'Einwilligung erteilt', confirmed: 'Bestätigt', revoked: 'Widerrufen', declined: 'Abgelehnt', expired: 'Abgelaufen', reset: 'Zurückgesetzt', legacy: 'Altbestand' };
const CHANNEL: Record<string, string> = { email: 'E-Mail', sms: 'SMS', whatsapp: 'WhatsApp', phone: 'Telefon', tracking: 'Tracking' };
const PURPOSE: Record<string, string> = { newsletter: 'Newsletter', marketing: 'Werbung', webinar: 'Webinar', community: 'Community', transactional: 'Service', statistics: 'Statistik', external_media: 'Externe Medien', '*': 'alle' };

function Overview({ policy }: { policy: string }) {
  const { data } = useLoad(() => api.get('/api/consent/overview'), [policy]);
  if (!data) return null;
  const row = (label: string, n: any) => (
    <div className="stat card" style={{ padding: 12 }}>
      <div className="muted">{label}</div>
      <div className="row small" style={{ gap: 14 }}>
        <span><Badge tone="green">{n.confirmed}</Badge> bestätigt</span>
        <span><Badge tone="yellow">{n.pending}</Badge> offen</span>
        <span><Badge tone="red">{n.revoked}</Badge> widerrufen</span>
        <span><Badge>{n.unknown_legacy}</Badge> Altbestand ohne Nachweis</span>
        <span><Badge>{n.unknown}</Badge> abgelaufen/abgelehnt</span>
      </div>
    </div>
  );
  return (
    <>
      <div className="grid2" data-tour="consent-overview">
        {row(`E-Mail (${data.email.total} Kontakte mit Adresse)`, data.email)}
        {row(`SMS (${data.sms.total} Kontakte mit Nummer)`, data.sms)}
      </div>
      {data.doi_pending > 0 && <p className="muted small">{data.doi_pending} Bestätigungs-Mails warten auf einen Klick.</p>}
    </>
  );
}

function Basics() {
  const { data, reload } = useLoad(() => api.get('/api/consent/settings'), []);
  const [s, setS] = useState<any>();
  useEffect(() => data && setS(data.settings), [data]);
  const log = useLoad(() => api.get('/api/consent/log?limit=60'), []);
  const texts = useLoad(() => api.get('/api/consent/texts'), []);
  const [action, setAction] = useState('');
  if (!s) return <Spinner />;
  const set = (patch: any) => setS({ ...s, ...patch });
  const doi = s.doi;
  const setDoi = (patch: any) => set({ doi: { ...doi, ...patch } });
  const page = (patch: any) => setDoi({ page: { ...doi.page, ...patch } });
  const save = async () => {
    const r = await act(() => api.put('/api/consent/settings', s), 'Gespeichert');
    if (r) (setS(r.settings), void reload());
  };
  const rows = (log.data ?? []).filter((e: any) => !action || e.action === action);
  return (
    <>
      <LegalNotice />
      <Overview policy={s.policy} />
      <div className="card" style={{ marginTop: 14 }} data-tour="consent-policy">
        <h2>Versandregel für Werbung</h2>
        <p className="muted">
          Kampagnen und Automationen prüfen vor jedem Werbe-Versand die Einwilligung; Service-Nachrichten (Rechnung, Termin) sind ausgenommen.
        </p>
        <Field label="Wer bekommt Werbung?">
          <Select
            value={s.policy}
            onChange={(v) => set({ policy: v })}
            options={[
              ['legacy', 'Bestätigte Kontakte und Altbestand ohne Nachweis (Standard – nichts ändert sich für bestehende Listen)'],
              ['confirmed', 'Nur Kontakte mit bestätigter Einwilligung (empfohlen)'],
            ]}
          />
        </Field>
        {s.policy === 'legacy' && <p className="muted small">Hinweis: Für Altbestand ohne Nachweis trägst du das Risiko. Wer neu über ein Formular kommt, sollte per Double-Opt-in bestätigen; stelle auf „nur bestätigt“ um, sobald deine Listen sauber sind.</p>}
        {s.policy_changed_at && <p className="muted small">Zuletzt geändert: {dt(s.policy_changed_at)}</p>}
      </div>

      <div className="card" data-tour="consent-doi">
        <h2>Double-Opt-in</h2>
        <p className="muted">Die Person bekommt eine E-Mail mit einem Bestätigungslink; erst ihr Klick macht die Einwilligung gültig. Der Link zeigt eine Seite mit Button – Mail-Scanner, die Links öffnen, bestätigen nichts.</p>
        <Field label="Double-Opt-in verlangen bei">
          <div>
            {SOURCES.map(([k, l, h]) => (
              <Check key={k} checked={!!doi.sources[k]} onChange={(v) => setDoi({ sources: { ...doi.sources, [k]: v } })} label={<><strong>{l}</strong> <span className="muted small">– {h}</span></>} />
            ))}
          </div>
        </Field>
        <p className="muted small">Pro Formular kannst du das überschreiben (Formulare → Einstellungen → Einwilligung).</p>
        <MoreFields id="consent-doi-texts" label="Bestätigungs-Mail, -Seite und Fristen" values={[doi.page.redirect_url]}>
        <div className="grid2">
          <Field label="Erinnerung nach … Stunden (0 = keine)">
            <Input type="number" value={doi.reminder_hours} onChange={(v) => setDoi({ reminder_hours: Number(v) })} />
          </Field>
          <Field label="Link läuft ab nach … Stunden">
            <Input type="number" value={doi.expiry_hours} onChange={(v) => setDoi({ expiry_hours: Number(v) })} />
          </Field>
        </div>
        <Field label="Betreff der Bestätigungs-Mail">
          <Input value={doi.subject} onChange={(v) => setDoi({ subject: v })} />
        </Field>
        <Field label="Text der Bestätigungs-Mail" hint="Platzhalter: {{contact.first_name}}, {{location.name}}, {{confirm_url}}, {{purpose_text}}, {{expires}}, {{consent_text}}. Der Link {{confirm_url}} muss enthalten sein.">
          <Textarea rows={9} value={doi.body} onChange={(v) => setDoi({ body: v })} />
        </Field>
        <h3>Bestätigungsseite</h3>
        <div className="grid2">
          <Field label="Überschrift"><Input value={doi.page.title} onChange={(v) => page({ title: v })} /></Field>
          <Field label="Button"><Input value={doi.page.button} onChange={(v) => page({ button: v })} /></Field>
        </div>
        <Field label="Text"><Textarea value={doi.page.text} onChange={(v) => page({ text: v })} /></Field>
        <div className="grid2">
          <Field label="Nach der Bestätigung: Überschrift"><Input value={doi.page.success_title} onChange={(v) => page({ success_title: v })} /></Field>
          <Field label="…weiterleiten zu (optional)"><Input value={doi.page.redirect_url} onChange={(v) => page({ redirect_url: v })} placeholder="https://…" /></Field>
        </div>
        <Field label="Nach der Bestätigung: Text"><Textarea value={doi.page.success_text} onChange={(v) => page({ success_text: v })} /></Field>
        <div className="grid2">
          <Field label="Link abgelaufen: Überschrift"><Input value={doi.page.expired_title} onChange={(v) => page({ expired_title: v })} /></Field>
          <Field label="Link abgelaufen: Text"><Input value={doi.page.expired_text} onChange={(v) => page({ expired_text: v })} /></Field>
        </div>
        </MoreFields>
        <Check checked={s.footer_link} onChange={(v) => set({ footer_link: v })} label="Werbe-Mails verlinken die Einstellungsseite (Kanäle und Zwecke einzeln wählen) neben „Abmelden“" />
        <p>
          <button className="btn" onClick={save} data-tour="consent-save">
            Speichern
          </button>
        </p>
      </div>

      <div className="card" data-tour="consent-log">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>Letzte Ereignisse</h2>
          <Select value={action} onChange={setAction} placeholder="Alle Ereignisse" options={Object.entries(ACTION)} />
        </div>
        {!rows.length ? (
          <Empty>Noch keine Einwilligungsereignisse.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Wann</th><th>Kontakt</th><th>Kanal · Zweck</th><th>Ereignis</th><th>Quelle</th></tr></thead>
              <tbody>
                {rows.map((e: any) => (
                  <tr key={e.id}>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>{dt(e.created_at)}</td>
                    <td><a href={`/app/contacts/${e.contact_id}`}>{[e.first_name, e.last_name].filter(Boolean).join(' ') || e.email || e.contact_id}</a></td>
                    <td className="small">{CHANNEL[e.channel] ?? e.channel} · {PURPOSE[e.purpose] ?? e.purpose}</td>
                    <td><Badge tone={e.action === 'revoked' || e.action === 'expired' ? 'red' : e.action === 'granted' && e.doi_required ? 'yellow' : e.action === 'granted' || e.action === 'confirmed' ? 'green' : 'gray'}>{e.action === 'granted' && e.doi_required ? 'Angefragt' : ACTION[e.action] ?? e.action}</Badge></td>
                    <td className="small">{e.source_label || e.source_kind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Einwilligungstexte (Versionen)</h2>
        <p className="muted small">Jeder Wortlaut, den ein Besucher gesehen hat, wird unveränderlich mit Versionsnummer gespeichert und am Ereignis vermerkt. Ändert sich der Text, entsteht eine neue Version.</p>
        {!texts.data?.length ? (
          <Empty>Noch keine Texte gespeichert.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Quelle</th><th>Version</th><th>Seit</th><th>Wortlaut</th></tr></thead>
              <tbody>
                {texts.data.slice(0, 40).map((x: any) => (
                  <tr key={x.id}>
                    <td className="small">{x.key}</td>
                    <td>V{x.version}</td>
                    <td className="small">{dt(x.created_at)}</td>
                    <td className="small muted">{x.text.length > 160 ? `${x.text.slice(0, 160)}…` : x.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

export function ConsentSettings() {
  const [tab, setTab] = useState('basics');
  return (
    <div data-tour="settings-consent">
      <Tabs tabs={[['basics', 'Einwilligung'], ['cmp', 'Cookie-Banner'], ['legal', 'Rechtstexte'], ['checkout', 'Checkout']]} value={tab} onChange={setTab} />
      {tab === 'basics' && <Basics />}
      <PageSuspense>
        {tab === 'cmp' && <CmpEditor />}
        {tab === 'legal' && <LegalWizard />}
        {tab === 'checkout' && <CheckoutLaw />}
      </PageSuspense>
    </div>
  );
}
