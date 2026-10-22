import { useEffect, useState } from 'react';
import { api, currentLocation, d, money } from '../api';
import { Icon } from '../icons';
import { Badge, Check, CodeBox, Copy, Field, Input, Link, Modal, Select, Spinner, act, confirmAsk, useLoad } from '../ui';
import { MoreFields } from '../areas/fields';
import { useBuyOffers } from './BuyOffers';
import { SignupLink } from '../referrals';
import { useT } from '../i18n';
import { QrButton, ShareLink } from '../QrCode';

/** Stripe status, fetched once per sub-account and shared by the invoice and product screens. */
const statusCache = new Map<string, Promise<any>>();
export function stripeStatus(fresh = false): Promise<any> {
  const loc = currentLocation();
  if (fresh || !statusCache.has(loc)) statusCache.set(loc, api.get('/api/stripe').catch(() => ({ connected: false })));
  return statusCache.get(loc)!;
}
export function useStripe() {
  const [s, setS] = useState<any>();
  useEffect(() => {
    let live = true;
    stripeStatus().then((x) => live && setS(x));
    return () => {
      live = false;
    };
  }, []);
  return s;
}

const EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'];
const SUB_EVENTS = ['invoice.paid', 'customer.subscription.deleted'];
const CodeList = ({ list, last = ', ' }: { list: string[]; last?: string }) => (
  <>
    {list.map((e, i) => (
      <span key={e}>
        {i ? (i === list.length - 1 ? last : ', ') : ''}
        <code>{e}</code>
      </span>
    ))}
  </>
);

/** Einstellungen → Stripe: secret key, webhook signing secret, test, disconnect. */
export function StripeSettings() {
  const st = useLoad(() => stripeStatus(true), []);
  const [f, setF] = useState({ secret_key: '', webhook_secret: '' });
  const [check, setCheck] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const s = st.data;
  if (!s) return <Spinner />;
  const done = (r: any) => {
    if (!r) return;
    statusCache.set(currentLocation(), Promise.resolve(r));
    st.setData(r);
  };
  const save = async () => {
    setBusy(true);
    const r = await act(() => api.put('/api/stripe', f), 'Gespeichert');
    setBusy(false);
    if (r) {
      done(r);
      setF({ secret_key: '', webhook_secret: '' });
    }
  };
  const test = async () => {
    setBusy(true);
    setCheck(await act(() => api.post('/api/stripe/test', f.secret_key ? { secret_key: f.secret_key } : {})));
    setBusy(false);
  };
  return (
    <div className="card stripe-card" style={{ maxWidth: 760 }} data-tour="stripe-settings">
      <h2>
        <Icon name="card" /> Stripe {s.connected ? <Badge tone="green">verbunden</Badge> : <Badge>nicht verbunden</Badge>}{' '}
        {s.connected && <Badge tone={s.live ? 'blue' : 'yellow'}>{s.live ? 'Live' : 'Testmodus'}</Badge>}
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Kunden bezahlen Rechnungen per Karte, SEPA, Apple Pay oder Google Pay mit „Jetzt bezahlen“; Produkte bekommen einen Kauf-Link.
      </p>
      {s.account && (
        <p>
          Konto: <strong>{s.account.name}</strong>{' '}
          <span className="muted small">
            {s.account.id} · {s.key_hint}
            {s.checked_at ? ` · geprüft ${d(s.checked_at)}` : ''}
          </span>
        </p>
      )}
      <Field tour="stripe-key" label="Secret Key" hint={<>Stripe-Dashboard → Entwickler → API-Schlüssel. Zum Ausprobieren erst den Testschlüssel (sk_test_…) nehmen. <SignupLink id="stripe" /></>}>
        <Input type="password" value={f.secret_key} onChange={(v) => setF({ ...f, secret_key: v.trim() })} placeholder={s.key_set ? `gespeichert (${s.key_hint}) – leer lassen zum Behalten` : 'sk_live_… oder sk_test_…'} autoComplete="off" />
      </Field>

      <h3 style={{ marginTop: 18 }} data-tour="stripe-webhook">Webhook {s.webhook_set ? <Badge tone="green">eingerichtet</Badge> : <Badge tone="yellow">fehlt</Badge>}</h3>
      <MoreFields id="stripe-webhook" label="Webhook einrichten" values={[s.key_set && !s.webhook_set]}>
      <ol className="steps small">
        <li>Stripe-Dashboard → Entwickler → Webhooks → „Endpunkt hinzufügen“.</li>
        <li>
          Endpunkt-URL: <CodeBox text={s.webhook_url} />
        </li>
        <li>
          Ereignisse: <CodeList list={EVENTS} />. Für Abo-Produkte zusätzlich <CodeList list={SUB_EVENTS} last=" und " />. Optional <code>charge.refunded</code>: Erstattungen stornieren Affiliate-Provisionen.
        </li>
        <li>Das „Signing Secret“ (whsec_…) des Endpunkts unten eintragen.</li>
      </ol>
      <Field label="Webhook Signing Secret">
        <Input type="password" value={f.webhook_secret} onChange={(v) => setF({ ...f, webhook_secret: v.trim() })} placeholder={s.webhook_set ? 'gespeichert – leer lassen zum Behalten' : 'whsec_…'} autoComplete="off" />
      </Field>
      </MoreFields>
      {s.connected && (
        <Check checked={s.options.auto_send_receipt} onChange={(v) => act(() => api.put('/api/stripe', { options: { auto_send_receipt: v } })).then(done)} label="Nach einem Produktkauf die (bezahlte) Rechnung automatisch per E-Mail senden" />
      )}
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="btn" disabled={busy || (!f.secret_key && !f.webhook_secret)} onClick={save}>
          Speichern
        </button>
        <button className="btn secondary" disabled={busy || (!s.key_set && !f.secret_key)} onClick={test}>
          Verbindung testen
        </button>
        {s.connected && (
          <button className="btn ghost" onClick={() => confirmAsk('Stripe trennen? „Jetzt bezahlen“ und Kauf-Links sind dann aus.') && act(() => api.del('/api/stripe'), 'Getrennt').then(done)}>
            Trennen
          </button>
        )}
      </div>
      {check && (
        <p className="small" style={{ marginBottom: 0 }}>
          <Badge tone="green">✓ Verbindung klappt</Badge> {check.account.name} ({check.account.country || '–'}, {check.live ? 'Live' : 'Testmodus'})
          {!check.account.charges_enabled && <span style={{ color: 'var(--red)' }}> – Zahlungen sind bei Stripe noch nicht freigeschaltet</span>}
        </p>
      )}
    </div>
  );
}

/** Next to the page title of the invoice list. */
export function StripeStatusBadge() {
  // The badges of the invoice list are translated with it (invoices catalog); the Stripe settings are German in phase 1.
  const t = useT('invoices');
  const s = useStripe();
  if (!s) return null;
  return s.connected ? (
    <Link to="settings/stripe" className="stripe-badge on">
      <Icon name="card" size={14} /> {s.live ? t('Stripe verbunden') : t('Stripe verbunden (Test)')}
    </Link>
  ) : (
    <Link to="settings/stripe" className="stripe-badge">
      <Icon name="card" size={14} /> {t('Online-Zahlung einrichten')}
    </Link>
  );
}

/** invoice id → its Stripe payment (paid / pending / failed). */
export function useStripePayments(): Record<string, any> {
  const list = useLoad(() => api.get<any[]>('/api/stripe/payments').catch(() => []), []);
  const out: Record<string, any> = {};
  for (const p of list.data ?? []) if (!out[p.invoice_id] || p.status === 'paid') out[p.invoice_id] = p;
  return out;
}

export function StripePaidBadge({ p }: { p?: any }) {
  const t = useT('invoices');
  if (!p) return null;
  if (p.status === 'paid') return <Badge tone="blue">{t('via Stripe')}</Badge>;
  if (p.status === 'pending') return <Badge tone="yellow">{t('Stripe: in Bearbeitung')}</Badge>;
  return <Badge tone="red">{t('Stripe: fehlgeschlagen')}</Badge>;
}

/** Invoice editor sidebar: Stripe payment status of this invoice. */
export function StripeInvoiceBox({ inv }: { inv: any }) {
  const s = useStripe();
  const pays = useLoad(() => api.get<any[]>(`/api/stripe/payments?invoice_id=${inv.id}`).catch(() => []), [inv.id, inv.status]);
  if (!s || inv.kind !== 'invoice') return null;
  const paid = (pays.data ?? []).find((p) => p.status === 'paid');
  const pending = (pays.data ?? []).find((p) => p.status === 'pending');
  return (
    <div className="stripe-box" data-tour="invoice-stripe">
      <strong>
        <Icon name="card" /> Online-Zahlung
      </strong>
      {paid ? (
        <p>
          Bezahlt via Stripe am {d(paid.paid_at)} ({money(paid.amount_cents, paid.currency)}).
          <br />
          <a href={paid.dashboard_url} target="_blank" rel="noreferrer">
            Referenz {paid.payment_intent || paid.id} ↗
          </a>
        </p>
      ) : pending ? (
        <p>SEPA-Lastschrift eingeleitet – wird bezahlt, sobald Stripe das Geld bestätigt.</p>
      ) : s.connected ? (
        <p className="muted">{inv.status === 'draft' ? 'Nach dem Senden sieht der Kunde auf dem Kunden-Link „Jetzt bezahlen“ (Karte, SEPA, Apple Pay …).' : inv.status === 'paid' || inv.status === 'void' ? 'Keine Stripe-Zahlung.' : 'Der Kunde kann auf dem Kunden-Link mit „Jetzt bezahlen“ sofort zahlen.'}</p>
      ) : (
        <p className="muted">
          Mit Stripe zahlen Kunden direkt online. <Link to="settings/stripe">Einrichten</Link>
        </p>
      )}
    </div>
  );
}

/** Product list: buy link (copy) and its settings. */
export function useProductLinks() {
  const s = useStripe();
  const list = useLoad(() => (s?.connected ? api.get<any[]>('/api/stripe/products') : Promise.resolve([])), [s?.connected]);
  const byId: Record<string, any> = Object.fromEntries((list.data ?? []).map((l) => [l.product_id, l]));
  return { connected: !!s?.connected, byId, reload: list.reload };
}

export function ProductBuyLink({ product, links }: { product: any; links: ReturnType<typeof useProductLinks> }) {
  const [edit, setEdit] = useState<any>(null);
  const offers = useBuyOffers(product, !!edit);
  const l = links.byId[product.id];
  if (!links.connected || !l) return null;
  const save = async () => {
    if (!(await offers.save())) return;
    const r = await act(() => api.put(`/api/stripe/products/${product.id}`, edit), 'Gespeichert');
    if (r) {
      setEdit(null);
      links.reload();
    }
  };
  return (
    <>
      {l.enabled && product.active !== 0 ? (
        <>
          <Copy text={l.url} label="Kauf-Link" />
          <QrButton url={l.url} title={`Kauf-Link ${product.name}`} />
        </>
      ) : (
        <Badge>Kauf-Link aus</Badge>
      )}
      <button className="btn small ghost" data-tour="buy-link" onClick={() => setEdit({ slug: l.slug, tag: l.custom_tag, redirect_url: l.redirect_url, enabled: l.enabled })} title="Kauf-Link einstellen" aria-label="Kauf-Link einstellen">
        <Icon name="settings" size={14} />
      </button>
      {edit && (
        <Modal title={`Kauf-Link: ${product.name}`} wide onClose={() => setEdit(null)} footer={<button className="btn" onClick={save}>Speichern</button>}>
          <p className="muted small" style={{ marginTop: 0 }}>
            Öffentliche Seite mit „Jetzt kaufen“ → Stripe Checkout. Nach der Zahlung: Kontakt (per E-Mail erkannt), bezahlte Rechnung, Tag und der Workflow-Auslöser „Produkt gekauft“.
          </p>
          <Field label="Link">
            <ShareLink url={l.url} title={`Kauf-Link ${product.name}`} />
          </Field>
          <Field label="Kurzname im Link (optional)" hint="z. B. „online-kurs“ → /buy/online-kurs">
            <Input value={edit.slug} onChange={(v) => setEdit({ ...edit, slug: v })} placeholder={product.id} />
          </Field>
          <Field label="Tag für Käufer" hint={`leer = ${l.tag.startsWith('kauf:') && !l.custom_tag ? l.tag : 'kauf:<kurzname>'} – damit schaltest du z. B. Kurse frei`}>
            <Input value={edit.tag} onChange={(v) => setEdit({ ...edit, tag: v })} placeholder={l.custom_tag ? '' : l.tag} />
          </Field>
          <Field label="Weiterleitung nach dem Kauf (optional)" hint="z. B. Kurs- oder Danke-Seite; sonst zeigen wir eine Danke-Seite">
            <Input value={edit.redirect_url} onChange={(v) => setEdit({ ...edit, redirect_url: v })} placeholder="https://…" />
          </Field>
          <Check checked={edit.enabled !== false} onChange={(v) => setEdit({ ...edit, enabled: v })} label="Kauf-Link aktiv" />
          {product.recurring && <p className="small muted">Abo-Produkt: Stripe bucht {product.recurring === 'month' ? 'monatlich' : 'jährlich'} ab; jede Verlängerung erzeugt eine bezahlte Rechnung, bei Kündigung wird der Tag wieder entfernt.</p>}
          {offers.ui}
        </Modal>
      )}
    </>
  );
}

/** Workflow trigger "Produkt gekauft": optional product filter. */
export function ProductTriggerField({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const products = useLoad(() => api.get<any[]>('/api/products').catch(() => []), []);
  return (
    <Field label="Produkt">
      <Select value={value} onChange={onChange} placeholder="jedes Produkt" options={(products.data ?? []).map((p) => [p.id, p.name])} />
    </Field>
  );
}
