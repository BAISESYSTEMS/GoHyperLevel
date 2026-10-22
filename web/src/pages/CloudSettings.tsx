import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Check, Field, Input, Select, Spinner, Textarea, act, toast, useLoad } from '../ui';

/**
 * Agentur → Cloud → Einstellungen: everything the operator decides about the hosted service – prices and trial, fair use,
 * what happens after a failed payment, Stripe, signup protection, domain and mail, the provider's own details. One form,
 * one save button; the server checks every value and answers with German messages.
 */

type Metric = 'emails' | 'sms' | 'ai';
const PLANS: [string, string][] = [
  ['solo', 'Solo'],
  ['team', 'Team'],
  ['agency', 'Agentur'],
];
const FAIR: [string, string, string][] = [
  ['emails', 'E-Mails pro Monat', 'je Sub-Account'],
  ['sms', 'SMS pro Monat inklusive', '0 = nur zum Selbstkostenpreis'],
  ['ai', 'KI-Aufrufe pro Monat inklusive', 'mit deinem Schlüssel – eigene Schlüssel sind unbegrenzt'],
  ['storage_mb', 'Medien-Speicher in MB', 'je Sub-Account'],
];
const METRICS: [Metric, string][] = [
  ['emails', 'E-Mail'],
  ['sms', 'SMS'],
  ['ai', 'KI-Aufruf'],
];
const WEBHOOK_EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed'];
const OPERATOR: [string, string][] = [
  ['name', 'Firma / Name'],
  ['representative', 'Vertretungsberechtigt'],
  ['street', 'Straße und Hausnummer'],
  ['zip_city', 'PLZ und Ort'],
  ['country', 'Land'],
  ['email', 'E-Mail'],
  ['phone', 'Telefon'],
  ['vat_id', 'USt-IdNr.'],
  ['register', 'Handelsregister'],
  ['hosting', 'Hosting-Anbieter und Serverstandort'],
];

const euro = (cents: number) => (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const toCents = (v: string) => Math.round(Number(String(v).replace(/\s/g, '').replace(',', '.')) * 100);

/** The form state: every value as the text the person typed, converted on save. */
function toForm(s: any) {
  return {
    signup_open: !!s.signup_open,
    trial_days: String(s.trial_days),
    card_required: !!s.card_required,
    yearly_discount_percent: String(s.yearly_discount_percent),
    price_note: s.price_note as string,
    prices: Object.fromEntries(PLANS.map(([k]) => [k, euro(s.prices[k])])) as Record<string, string>,
    fair_use: Object.fromEntries(PLANS.map(([k]) => [k, Object.fromEntries(FAIR.map(([m]) => [m, s.fair_use[k][m] === null ? '' : String(s.fair_use[k][m])]))])) as Record<string, Record<string, string>>,
    overage: { ...s.overage } as Record<string, string>,
    unit_cost: Object.fromEntries(METRICS.map(([m]) => [m, String(s.unit_cost[m]).replace('.', ',')])) as Record<string, string>,
    markup_percent: String(s.markup_percent),
    grace_days: String(s.grace_days),
    retention_days: String(s.retention_days),
    deletion_notice_days: String(s.deletion_notice_days),
    self_delete_days: String(s.self_delete_days),
    stripe_tax: !!s.stripe_tax,
    tax_id_collection: !!s.tax_id_collection,
    b2b_only: !!s.b2b_only,
    block_disposable: !!s.block_disposable,
    extra_blocked_domains: (s.extra_blocked_domains as string[]).join('\n'),
    signups_per_ip_hour: String(s.signups_per_ip_hour),
    cloud_domain: s.cloud_domain as string,
    mail_location_id: s.mail_location_id as string,
    default_snapshot_id: s.default_snapshot_id as string,
    status_url: s.status_url as string,
    docs_url: s.docs_url as string,
    support_email: s.support_email as string,
    agency_max_clients: String(s.agency_max_clients),
    operator: { ...s.operator } as Record<string, string>,
  };
}
type Form = ReturnType<typeof toForm>;

function body(f: Form) {
  return {
    ...f,
    prices: Object.fromEntries(PLANS.map(([k]) => [k, toCents(f.prices[k])])),
    unit_cost: Object.fromEntries(METRICS.map(([m]) => [m, f.unit_cost[m]])),
    fair_use: f.fair_use,
  };
}

export function CloudSettingsForm() {
  const s = useLoad(() => api.get<any>('/api/cloud/console/settings'), []);
  const [f, setF] = useState<Form | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (s.data && !dirty) setF(toForm(s.data));
  }, [s.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s.data || !f) return <Spinner />;
  const der = s.data.derived;
  const set = (patch: Partial<Form>) => {
    setF({ ...f, ...patch });
    setDirty(true);
  };
  const text = (k: keyof Form) => (v: string) => set({ [k]: v } as Partial<Form>);
  const flag = (k: keyof Form) => (v: boolean) => set({ [k]: v } as Partial<Form>);
  const save = async () => {
    setBusy(true);
    const r = await act(() => api.put<any>('/api/cloud/console/settings', body(f)), 'Gespeichert');
    setBusy(false);
    if (r) {
      setDirty(false);
      setF(toForm(r));
      void s.reload();
    }
  };
  const preview = (k: string) => {
    const m = toCents(f.prices[k]);
    const disc = Number(f.yearly_discount_percent) || 0;
    if (!Number.isFinite(m) || m <= 0) return '–';
    const y = Math.round((m * 12 * (1 - disc / 100)) / 100);
    return `${euro(m)} € im Monat · ${y.toLocaleString('de-DE')} € im Jahr (${euro(Math.round((y * 100) / 12))} € je Monat)`;
  };
  const copy = (t: string) => {
    void navigator.clipboard?.writeText(t).then(() => toast('Kopiert'), () => undefined);
  };

  return (
    <div className="cloud-settings" data-tour="cloud-settings">
      <div className="card" data-tour="cloud-prices">
        <h3 style={{ marginTop: 0 }}>Preise und Testphase</h3>
        <p className="muted small">
          Alle Funktionen sind in jedem Tarif enthalten, es gibt keine Gebühr pro Nutzer. Preise in Euro pro Monat; ändern sie sich, gelten sie nur für neue Abos – laufende bleiben auf ihrem Stripe-Preis, bis der Kunde den Tarif wechselt.
        </p>
        <div className="grid3">
          {PLANS.map(([k, label]) => (
            <Field key={k} label={`Cloud ${label} (€ pro Monat)`} hint={preview(k)}>
              <Input value={f.prices[k]} onChange={(v) => set({ prices: { ...f.prices, [k]: v } })} inputMode="decimal" />
            </Field>
          ))}
        </div>
        <div className="grid3">
          <Field label="Rabatt bei Jahreszahlung (%)">
            <Input value={f.yearly_discount_percent} onChange={text('yearly_discount_percent')} inputMode="numeric" />
          </Field>
          <Field label="Testphase (Tage, 0 = keine)">
            <Input value={f.trial_days} onChange={text('trial_days')} inputMode="numeric" />
          </Field>
          <Field label="Preise auf der Seite">
            <Select
              value={f.price_note}
              onChange={text('price_note')}
              options={[
                ['net', 'zzgl. MwSt.'],
                ['gross', 'inkl. MwSt.'],
                ['none', 'ohne Hinweis'],
              ]}
            />
          </Field>
        </div>
        <Check checked={f.card_required} onChange={flag('card_required')} label="Zahlungsdaten schon beim Start verlangen (sonst beginnt die Testphase ohne Karte und das Konto wird danach schreibgeschützt)" />
        <Check checked={f.signup_open} onChange={flag('signup_open')} label="Neue Anmeldungen zulassen" />
        <Field label="Kunden-Accounts im Tarif Agentur (0 = unbegrenzt)" hint="Fair Use: Kunden-Accounts einer Agentur sind für deren eigene Kunden gedacht, nicht zum Weiterverkauf der Software.">
          <Input value={f.agency_max_clients} onChange={text('agency_max_clients')} inputMode="numeric" />
        </Field>
      </div>

      <div className="card" data-tour="cloud-fairuse">
        <h3 style={{ marginTop: 0 }}>Fair Use</h3>
        <p className="muted small">
          Grenzen gegen Missbrauch, keine Funktionssperren – Kunden sehen ihren Verbrauch offen unter Cloud-Konto. Leer lassen heißt unbegrenzt. Kontakte, Nutzer (außer Solo) und Funktionen werden nicht begrenzt.
        </p>
        <div className="table-wrap">
          <table className="t cloud-fair">
            <thead>
              <tr>
                <th>Grenze</th>
                {PLANS.map(([k, label]) => (
                  <th key={k}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FAIR.map(([m, label, hint]) => (
                <tr key={m}>
                  <td>
                    {label}
                    <div className="muted small">{hint}</div>
                  </td>
                  {PLANS.map(([k, pl]) => (
                    <td key={k}>
                      <Input aria-label={`${label}, ${pl}`} value={f.fair_use[k][m]} onChange={(v) => set({ fair_use: { ...f.fair_use, [k]: { ...f.fair_use[k], [m]: v } } })} inputMode="numeric" placeholder="unbegrenzt" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h4>Wenn die Grenze erreicht ist</h4>
        <div className="grid3">
          {METRICS.map(([m, label]) => (
            <div key={m}>
              <Field label={label}>
                <Select
                  value={f.overage[m]}
                  onChange={(v) => set({ overage: { ...f.overage, [m]: v } })}
                  options={[
                    ['block', 'Sperren und Hinweis zeigen'],
                    ['bill', 'Zum Selbstkostenpreis weiterberechnen'],
                  ]}
                />
              </Field>
              <Field label={`Deine Kosten je ${label} (Cent)`}>
                <Input value={f.unit_cost[m]} onChange={(v) => set({ unit_cost: { ...f.unit_cost, [m]: v } })} inputMode="decimal" />
              </Field>
            </div>
          ))}
        </div>
        <Field label="Aufschlag auf die Weiterberechnung (%)">
          <Input value={f.markup_percent} onChange={text('markup_percent')} inputMode="decimal" />
        </Field>
      </div>

      <div className="card" data-tour="cloud-dunning">
        <h3 style={{ marginTop: 0 }}>Zahlungsausfall und Löschung</h3>
        <p className="muted small">Zahlung fehlgeschlagen → Hinweis und E-Mails → Kulanzzeit → Konto schreibgeschützt → Export angeboten und Löschung angekündigt → endgültig gelöscht. Exportieren geht bis zuletzt.</p>
        <div className="grid2">
          <Field label="Kulanzzeit bis „schreibgeschützt“ (Tage)">
            <Input value={f.grace_days} onChange={text('grace_days')} inputMode="numeric" />
          </Field>
          <Field label="Schreibgeschützt bis zur Ankündigung der Löschung (Tage)">
            <Input value={f.retention_days} onChange={text('retention_days')} inputMode="numeric" />
          </Field>
          <Field label="Von der Ankündigung bis zur Löschung (Tage)">
            <Input value={f.deletion_notice_days} onChange={text('deletion_notice_days')} inputMode="numeric" />
          </Field>
          <Field label="Löschung auf Wunsch des Kunden nach (Tage)">
            <Input value={f.self_delete_days} onChange={text('self_delete_days')} inputMode="numeric" />
          </Field>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Beispiel: Zahlung scheitert → nach {f.grace_days || '0'} Tagen schreibgeschützt → nach weiteren {f.retention_days || '0'} Tagen Löschankündigung → {f.deletion_notice_days || '0'} Tage später gelöscht (insgesamt {(Number(f.grace_days) || 0) + (Number(f.retention_days) || 0) + (Number(f.deletion_notice_days) || 0)} Tage nach dem ersten Fehlschlag).
        </p>
      </div>

      <div className="card" data-tour="cloud-stripe">
        <h3 style={{ marginTop: 0 }}>
          Stripe {der.stripe_connected ? <span className="cloud-ok">verbunden</span> : <span className="cloud-todo">nicht verbunden</span>}
        </h3>
        <p className="muted small">
          Den geheimen Schlüssel und das Webhook-Secret trägst du unter Agentur → SaaS → Einstellungen ein oder setzt sie als Umgebungsvariablen (<code>PGHL_CLOUD_STRIPE_SECRET_KEY</code>, <code>PGHL_CLOUD_STRIPE_WEBHOOK_SECRET</code>). Preise legt HyperLevel bei Stripe selbst an – du musst keine Produkte vorbereiten.
        </p>
        <Field label="Webhook-Adresse in Stripe">
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <code className="cloud-url grow">{der.webhook_url}</code>
            <button className="btn secondary small" onClick={() => copy(der.webhook_url)}>
              <Icon name="copy" /> Kopieren
            </button>
          </div>
        </Field>
        <p className="muted small">
          Ereignisse: {WEBHOOK_EVENTS.map((e, i) => (
            <span key={e}>
              <code>{e}</code>
              {i < WEBHOOK_EVENTS.length - 1 ? ', ' : ''}
            </span>
          ))}
        </p>
        <Check checked={f.stripe_tax} onChange={flag('stripe_tax')} label="Stripe Tax berechnet Umsatzsteuer automatisch (in Stripe unter Tax aktivieren)" />
        <Check checked={f.tax_id_collection} onChange={flag('tax_id_collection')} label="USt-IdNr. abfragen (Reverse-Charge bei Firmenkunden im EU-Ausland)" />
        <Check checked={f.b2b_only} onChange={flag('b2b_only')} label="Nur Unternehmen (B2B): bei der Anmeldung Firmenname und USt-IdNr. oder die Bestätigung „Ich bestelle als Unternehmen“ verlangen – die AGB-Vorlage sagt „nur B2B“" />
      </div>

      <div className="card" data-tour="cloud-protect">
        <h3 style={{ marginTop: 0 }}>Schutz vor Missbrauch</h3>
        <p className="muted small">Ohne Captcha: verstecktes Feld, Mindestzeit fürs Ausfüllen, Begrenzung je Adresse und E-Mail-Bestätigung.</p>
        <div className="grid2">
          <Field label="Anmeldungen pro Stunde und Adresse">
            <Input value={f.signups_per_ip_hour} onChange={text('signups_per_ip_hour')} inputMode="numeric" />
          </Field>
        </div>
        <Check checked={f.block_disposable} onChange={flag('block_disposable')} label="Wegwerf-E-Mail-Adressen ablehnen" />
        <Field label="Weitere gesperrte Domains" hint="Eine pro Zeile, z. B. wegwerf-mail.de">
          <Textarea value={f.extra_blocked_domains} onChange={text('extra_blocked_domains')} rows={3} />
        </Field>
        <Field label="Anmeldung mit Google" hint={der.google_ready ? 'Aktiv. Die Weiterleitungs-URI in der Google-Konsole:' : 'Noch nicht eingerichtet – dafür Google-Anmeldung unter Einstellungen → Anmeldung (SSO) einrichten. Weiterleitungs-URI:'}>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <code className="cloud-url grow">{der.google_redirect_uri}</code>
            <button className="btn secondary small" onClick={() => copy(der.google_redirect_uri)}>
              <Icon name="copy" /> Kopieren
            </button>
          </div>
        </Field>
      </div>

      <div className="card" data-tour="cloud-domain">
        <h3 style={{ marginTop: 0 }}>Domain, Absender und Startinhalte</h3>
        <div className="grid2">
          <Field label="Cloud-Domain" hint="Optional: Kunden bekommen <name>.<domain>. Dafür den DNS-Eintrag *.<domain> auf diesen Server setzen – mit dem Caddy-Profil kommt jedes Zertifikat beim ersten Aufruf von selbst. Leer = alle melden sich unter der Haupt-Adresse an.">
            <Input value={f.cloud_domain} onChange={text('cloud_domain')} placeholder="cloud.example.com" />
          </Field>
          <Field label="Absender der System-Mails" hint="Aus diesem Sub-Account gehen Bestätigungs-, Willkommens- und Zahlungs-Mails raus.">
            <Select value={f.mail_location_id} onChange={text('mail_location_id')} options={[['', 'Automatisch'], ...(der.locations as { id: string; name: string }[]).map((l) => [l.id, l.name] as [string, string])]} />
          </Field>
          <Field label="Startinhalte neuer Konten" hint="Ein Snapshot mit deinen Vorlagen. Leer = Standard-Pipeline und -Vorlagen.">
            <Select value={f.default_snapshot_id} onChange={text('default_snapshot_id')} options={[['', 'Standard'], ...(der.snapshots as { id: string; name: string }[]).map((l) => [l.id, l.name] as [string, string])]} />
          </Field>
          <Field label="Support-E-Mail">
            <Input value={f.support_email} onChange={text('support_email')} type="email" />
          </Field>
          <Field label="Status-Seite">
            <Input value={f.status_url} onChange={text('status_url')} placeholder="https://status.example.com" />
          </Field>
          <Field label="Anleitung zum Selbst-Hosten (0 €)">
            <Input value={f.docs_url} onChange={text('docs_url')} placeholder="https://github.com/…" />
          </Field>
        </div>
      </div>

      <div className="card" data-tour="cloud-operator">
        <h3 style={{ marginTop: 0 }}>Anbieter</h3>
        <p className="muted small">Diese Angaben füllen die Platzhalter in AGB, AVV, Datenschutzerklärung und Impressum (Reiter Rechtliches).</p>
        <div className="grid2">
          {OPERATOR.map(([k, label]) => (
            <Field key={k} label={label}>
              <Input value={f.operator[k]} onChange={(v) => set({ operator: { ...f.operator, [k]: v } })} />
            </Field>
          ))}
        </div>
      </div>

      <div className="cloud-savebar">
        <span className="muted small">{dirty ? 'Ungespeicherte Änderungen' : 'Alles gespeichert'}</span>
        <button className="btn" disabled={!dirty || busy} onClick={save}>
          Speichern
        </button>
      </div>
    </div>
  );
}
