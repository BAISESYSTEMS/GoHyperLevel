import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { Badge, Check, Copy, Field, Input, Select, act, confirmAsk, useLoad } from '../ui';
import { MoreFields } from '../areas/fields';
import './shop.css';

/**
 * PayPal and Mollie next to Stripe (docs/payment-providers.md) – the fill of the slot `settings.payments` under Einstellungen → Stripe:
 * credentials per sub-account (checked with the provider on save, stored sealed, never shown again), webhook address, Pay Later,
 * Mollie's methods.
 */

const KEEP = '••••••';

function PayPalCard({ p, onSaved }: { p: any; onSaved: () => void }) {
  const t = useT('store');
  const [f, setF] = useState({ client_id: p.ready ? KEEP : '', client_secret: p.ready ? KEEP : '', webhook_id: p.webhook_set ? KEEP : '', mode: p.options.mode ?? 'sandbox', pay_later: p.options.pay_later !== false });
  const set = (k: keyof typeof f) => (v: string | boolean) => setF({ ...f, [k]: v });
  const save = async () => (await act(() => api.put('/api/pay/providers/paypal', f), t('PayPal gespeichert und geprüft'))) && onSaved();
  return (
    <section className="card pay-card" data-tour="pay-paypal">
      <h3>
        {p.label} {p.ready ? <Badge tone="green">{t('verbunden')}</Badge> : <Badge>{t('nicht eingerichtet')}</Badge>}
      </h3>
      <p className="muted small">{t('Orders API v2: PayPal-Konto, Karte und – für berechtigte Käufer – „Später bezahlen“ und Ratenzahlung. Zugangsdaten aus developer.paypal.com → Apps & Credentials.')}</p>
      <div className="row">
        <Field label={t('Client-ID')}>
          <Input value={f.client_id} onChange={set('client_id')} spellCheck={false} autoComplete="off" />
        </Field>
        <Field label={t('Secret')}>
          <Input value={f.client_secret} onChange={set('client_secret')} type="password" autoComplete="new-password" />
        </Field>
      </div>
      <div className="row">
        <Field label={t('Umgebung')}>
          <Select value={f.mode} onChange={set('mode')} options={[['sandbox', t('Sandbox (Test)')], ['live', t('Live')]]} />
        </Field>
      </div>
      <MoreFields id="pay-paypal" values={[p.ready && !p.webhook_set, p.options.pay_later === false]}>
        <Field label={t('Webhook-ID')} hint={t('Webhook mit dieser Adresse anlegen, Ereignisse: {events}', { events: p.events.join(', ') })}>
          <Input value={f.webhook_id} onChange={set('webhook_id')} spellCheck={false} />
        </Field>
        <Field label={t('Webhook-Adresse')}>
          <Copy text={p.webhook_url} />
        </Field>
        <Check checked={f.pay_later} onChange={set('pay_later')} label={t('„Später bezahlen“ bei PayPal anbieten')} />
      </MoreFields>
      <div className="row shop-actions">
        <button className="btn" onClick={save}>
          {t('Speichern und prüfen')}
        </button>
        {p.ready && (
          <button className="btn ghost" onClick={async () => confirmAsk(t('PayPal trennen? Die Zugangsdaten werden gelöscht.')) && (await act(() => api.del('/api/pay/providers/paypal'), t('Getrennt'))) && onSaved()}>
            {t('Trennen')}
          </button>
        )}
      </div>
    </section>
  );
}

function MollieCard({ p, methods, onSaved }: { p: any; methods: { id: string; label: string }[]; onSaved: () => void }) {
  const t = useT('store');
  const [key, setKey] = useState(p.ready ? KEEP : '');
  const [chosen, setChosen] = useState<string[]>(p.options.methods ?? []);
  const toggle = (id: string) => setChosen(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const save = async () => (await act(() => api.put('/api/pay/providers/mollie', { api_key: key, methods: chosen }), t('Mollie gespeichert und geprüft'))) && onSaved();
  return (
    <section className="card pay-card" data-tour="pay-mollie">
      <h3>
        {p.label} {p.ready ? <Badge tone="green">{t('verbunden')}</Badge> : <Badge>{t('nicht eingerichtet')}</Badge>}
      </h3>
      <p className="muted small">{t('Payments API: iDEAL, SEPA-Überweisung, Karten, Klarna, Bancontact … – beliebt in DACH und den Niederlanden. Den API-Schlüssel (test_… oder live_…) findest du im Mollie-Dashboard unter Entwickler.')}</p>
      <Field label={t('API-Schlüssel')}>
        <Input value={key} onChange={setKey} type="password" autoComplete="new-password" />
      </Field>
      <MoreFields id="pay-mollie" values={[p.options.methods]}>
      <Field label={t('Zahlungsarten (keine gewählt = alle, die im Mollie-Dashboard aktiv sind)')}>
        <div className="opt-toggle">
          {methods.map((m) => (
            <button type="button" key={m.id} className={chosen.includes(m.id) ? 'on' : ''} aria-pressed={chosen.includes(m.id)} onClick={() => toggle(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </Field>
      <p className="muted small">{t('Mollie meldet Zahlungen an {url} – die Adresse schickt HyperLevel bei jeder Zahlung mit, du musst sie nicht eintragen.', { url: p.webhook_url })}</p>
      </MoreFields>
      <div className="row shop-actions">
        <button className="btn" onClick={save} disabled={!key}>
          {t('Speichern und prüfen')}
        </button>
        {p.ready && (
          <button className="btn ghost" onClick={async () => confirmAsk(t('Mollie trennen? Der API-Schlüssel wird gelöscht.')) && (await act(() => api.del('/api/pay/providers/mollie'), t('Getrennt'))) && onSaved()}>
            {t('Trennen')}
          </button>
        )}
      </div>
    </section>
  );
}

export function PayProviders() {
  const t = useT('store');
  const s = useLoad(() => api.get<any>('/api/pay/providers'), []);
  if (!s.data) return null;
  const by = (id: string) => s.data.providers.find((p: any) => p.id === id);
  return (
    <div className="pay-providers">
      <h2>{t('Weitere Zahlungsanbieter')}</h2>
      <p className="muted">{t('Rechnungen, Kauf-Links, Terminbuchungen und der Online-Shop bieten jeden verbundenen Anbieter an. Gutscheine lassen sich auf der Bezahlseite einlösen.')}</p>
      <PayPalCard key={`pp-${by('paypal').ready}`} p={by('paypal')} onSaved={s.reload} />
      <MollieCard key={`mo-${by('mollie').ready}`} p={by('mollie')} methods={s.data.mollie_methods} onSaved={s.reload} />
    </div>
  );
}
