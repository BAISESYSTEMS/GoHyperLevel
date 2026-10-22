import { useEffect, useState } from 'react';
import { api, currentLocation, dt, money } from '../api';
import { useT, type TFn } from '../i18n';
import { Badge, Check, Copy, Empty, Field, Input, Modal, PageHead, Select, Spinner, Stat, Tabs, Textarea, act, confirmAsk, navigate, useLoad } from '../ui';
import { MoreFields } from '../areas/fields';
import { lazyPages } from '../lazy';
import './shop.css';
import { SortableGrid } from '../sortable/Sortable';

const { ShopAbandoned } = lazyPages(() => import('./ShopAbandoned'), 'ShopAbandoned');

/**
 * Online-Shop (docs/store.md): orders with payment and fulfilment (tracking number, mail to the buyer, refund), the products' store
 * fields (published, kind, images, weight, collections, variant prices – variants and stock come from Lager & Einkauf), collections
 * and the settings (countries, flat-rate and weight-based shipping, order numbers, abandoned cart, gift-card validity).
 */

export const parseCents = (s: string): number | null => {
  const v = String(s ?? '').replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.');
  if (!v) return null;
  const n = Math.round(Number(v) * 100);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
export const euro = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(2).replace('.', ','));

const PAY_TONE: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow'> = { pending: 'yellow', paid: 'green', cancelled: 'gray', refunded: 'red' };
const SHIP_TONE: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow'> = { unfulfilled: 'yellow', processing: 'blue', shipped: 'green', delivered: 'green', cancelled: 'gray' };
const payLabel = (t: TFn, s: string) => ({ pending: t('Zahlung offen'), paid: t('Bezahlt'), cancelled: t('Abgebrochen'), refunded: t('Erstattet') })[s] ?? s;
const shipLabel = (t: TFn, s: string) => ({ unfulfilled: t('Offen'), processing: t('In Bearbeitung'), shipped: t('Versendet'), delivered: t('Zugestellt'), cancelled: t('Storniert') })[s] ?? s;
const kindLabel = (t: TFn, k: string) => ({ physical: t('Ware (mit Versand)'), digital: t('Digital (ohne Versand)'), gift_card: t('Gutschein') })[k] ?? k;

// --- orders -----------------------------------------------------------------------------------------------------------------------

function OrderModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useT('store');
  const o = useLoad(() => api.get<any>(`/api/store/orders/${id}`), [id]);
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [notify, setNotify] = useState(true);
  const carriers = useLoad(() => api.get<any>('/api/store/settings').then((s) => s.carriers as [string, string][]), []);
  useEffect(() => {
    if (o.data) {
      setCarrier(o.data.carrier || 'dhl');
      setTracking(o.data.tracking_number || '');
    }
  }, [o.data?.id]);
  const d = o.data;
  const patch = async (body: Record<string, unknown>, ok: string) => {
    if (await act(() => api.patch(`/api/store/orders/${id}`, body), ok)) {
      o.reload();
      onChanged();
    }
  };
  const refund = async () => {
    if (!confirmAsk(t('Die ganze Bestellung erstatten? Das Geld geht über den Zahlungsanbieter zurück, ein Gutschein-Anteil wieder auf den Gutschein.'))) return;
    if (await act(() => api.post(`/api/store/orders/${id}/refund`, {}), t('Erstattet'))) {
      o.reload();
      onChanged();
    }
  };
  return (
    <Modal title={d ? t('Bestellung {number}', { number: d.number }) : t('Bestellung')} onClose={onClose} wide>
      {!d ? (
        <Spinner />
      ) : (
        <div className="shop-order">
          <p>
            <Badge tone={PAY_TONE[d.status]}>{payLabel(t, d.status)}</Badge> <Badge tone={SHIP_TONE[d.fulfilment]}>{shipLabel(t, d.fulfilment)}</Badge> <span className="muted small">{dt(d.created_at)}</span>
          </p>
          <table className="t">
            <tbody>
              {d.items.map((l: any, i: number) => (
                <tr key={i}>
                  <td>
                    {l.qty} × {l.name}
                    {l.variant && <span className="muted"> ({l.variant})</span>}
                    {l.sku && <span className="muted small"> · {l.sku}</span>}
                  </td>
                  <td className="num">{money(l.total_cents, d.currency)}</td>
                </tr>
              ))}
              {d.shipping?.name && (
                <tr>
                  <td>{t('Versand: {name}', { name: d.shipping.name })}</td>
                  <td className="num">{money(d.shipping_cents, d.currency)}</td>
                </tr>
              )}
              <tr className="total">
                <td>{t('Gesamt')}</td>
                <td className="num">{money(d.total_cents, d.currency)}</td>
              </tr>
              {d.gift_cents > 0 && (
                <tr>
                  <td className="muted">{t('davon mit Gutschein')}</td>
                  <td className="num muted">{money(d.gift_cents, d.currency)}</td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="row shop-facts">
            <div className="grow">
              <h4>{t('Käufer')}</h4>
              <p>
                {d.name || '–'}
                <br />
                {d.email}
                {d.phone && (
                  <>
                    <br />
                    {d.phone}
                  </>
                )}
              </p>
              {d.address?.street && (
                <p className="muted">
                  {d.address.company && (
                    <>
                      {d.address.company}
                      <br />
                    </>
                  )}
                  {d.address.street}
                  <br />
                  {d.address.postal_code} {d.address.city}
                  <br />
                  {d.country_name}
                </p>
              )}
              {d.note && <p className="muted">„{d.note}“</p>}
            </div>
            <div className="grow">
              <h4>{t('Zahlung')}</h4>
              {d.payment ? (
                <p>
                  {d.payment.provider_label || '–'} · {money(d.payment.received_cents + d.payment.gift_cents, d.currency)}
                  {d.payment.refunded_cents > 0 && <span className="muted"> · {t('erstattet {amount}', { amount: money(d.payment.refunded_cents, d.currency) })}</span>}
                  <br />
                  <span className="muted small">{d.payment.provider_ref}</span>
                </p>
              ) : (
                <p className="muted">–</p>
              )}
              {d.invoice && (
                <p>
                  <a href={`/app/invoices/${d.invoice.id}`}>{t('Rechnung {number}', { number: d.invoice.number || t('Entwurf') })}</a>
                </p>
              )}
              {d.meta?.invoice_error && <p className="error small">{t('Rechnung nicht festgeschrieben: {error}', { error: d.meta.invoice_error })}</p>}
              {d.meta?.payment_mismatch && <p className="error small">{t('Betrag passt nicht: {text}', { text: d.meta.payment_mismatch })}</p>}
              {d.gift_cards?.length > 0 && <p className="small">{t('Verkaufte Gutscheine: {codes}', { codes: d.gift_cards.map((c: any) => c.code).join(', ') })}</p>}
            </div>
          </div>
          {d.status === 'paid' && (
            <section className="card">
              <h4>{t('Versand')}</h4>
              <div className="row">
                <Field label={t('Versanddienstleister')}>
                  <Select value={carrier} onChange={setCarrier} options={(carriers.data ?? []).map(([k, l]) => [k, k === 'other' ? t('Andere') : l] as [string, string])} />
                </Field>
                <Field label={t('Sendungsnummer')}>
                  <Input value={tracking} onChange={setTracking} spellCheck={false} />
                </Field>
              </div>
              {d.tracking_url && (
                <p className="small">
                  <a href={d.tracking_url} target="_blank" rel="noopener noreferrer">
                    {t('Sendung verfolgen')}
                  </a>
                </p>
              )}
              <Check checked={notify} onChange={setNotify} label={t('Käufer per E-Mail über den Versand informieren')} />
              <div className="row shop-actions">
                <button className="btn" onClick={() => patch({ fulfilment: 'shipped', carrier, tracking_number: tracking, notify }, t('Als versendet markiert'))} disabled={d.fulfilment === 'shipped'}>
                  {t('Als versendet markieren')}
                </button>
                <button className="btn secondary" onClick={() => patch({ carrier, tracking_number: tracking }, t('Gespeichert'))}>
                  {t('Sendungsnummer speichern')}
                </button>
                <button className="btn secondary" onClick={() => patch({ fulfilment: 'processing' }, t('Gespeichert'))} disabled={d.fulfilment !== 'unfulfilled'}>
                  {t('In Bearbeitung')}
                </button>
                <button className="btn secondary" onClick={() => patch({ fulfilment: 'delivered' }, t('Gespeichert'))} disabled={d.fulfilment !== 'shipped'}>
                  {t('Zugestellt')}
                </button>
              </div>
            </section>
          )}
          <div className="row shop-actions">
            {d.status === 'paid' && d.payment && (
              <button className="btn danger" onClick={refund}>
                {t('Erstatten')}
              </button>
            )}
            {d.status === 'paid' && d.invoice && (
              <button className="btn secondary" onClick={() => act(() => api.post(`/api/store/orders/${id}/resend`, {}), t('Bestätigung gesendet'))}>
                {t('Bestätigung erneut senden')}
              </button>
            )}
            {d.status === 'pending' && (
              <button className="btn secondary" onClick={() => patch({ fulfilment: 'cancelled' }, t('Bestellung abgebrochen'))}>
                {t('Bestellung abbrechen')}
              </button>
            )}
            {d.status === 'paid' && (
              <a className="btn ghost" href={`/api/store/orders/${id}/packing-slip?locationId=${currentLocation()}`} target="_blank" rel="noopener noreferrer">
                {t('Packzettel')}
              </a>
            )}
            <a className="btn ghost" href={d.status_url} target="_blank" rel="noopener noreferrer">
              {t('Seite für den Käufer')}
            </a>
          </div>
        </div>
      )}
    </Modal>
  );
}

function OrdersTab({ onChanged }: { onChanged: () => void }) {
  const t = useT('store');
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState('');
  const qs = new URLSearchParams({ ...(filter === 'open' ? { fulfilment: 'open' } : filter ? { status: filter } : {}), ...(q.trim() ? { q: q.trim() } : {}) }).toString();
  const list = useLoad(() => api.get<any[]>(`/api/store/orders${qs ? `?${qs}` : ''}`), [qs]);
  return (
    <>
      <div className="row shop-filter">
        <Select value={filter} onChange={setFilter} aria={t('Filter')} options={[['', t('Alle Bestellungen')], ['open', t('Zu versenden')], ['pending', t('Zahlung offen')], ['paid', t('Bezahlt')], ['refunded', t('Erstattet')], ['cancelled', t('Abgebrochen')]]} />
        <div className="grow">
          <Input value={q} onChange={setQ} placeholder={t('Suchen: Nummer, E-Mail, Name, Sendungsnummer')} aria-label={t('Bestellungen suchen')} />
        </div>
      </div>
      {list.loading && !list.data ? (
        <Spinner />
      ) : !list.data?.length ? (
        <Empty>{t('Noch keine Bestellungen. Sobald jemand im Shop kauft, steht die Bestellung hier.')}</Empty>
      ) : (
        <div className="card shop-scroll">
          <table className="t">
            <thead>
              <tr>
                <th>{t('Nr.')}</th>
                <th>{t('Datum')}</th>
                <th>{t('Käufer')}</th>
                <th className="num">{t('Summe')}</th>
                <th>{t('Zahlung')}</th>
                <th>{t('Versand')}</th>
                <th>{t('Sendungsnummer')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((o) => (
                <tr key={o.id} className="click" tabIndex={0} onClick={() => setOpen(o.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(o.id)}>
                  <td className="strong">{o.number}</td>
                  <td>{dt(o.created_at)}</td>
                  <td>{o.name || o.email || '–'}</td>
                  <td className="num">{money(o.total_cents, o.currency)}</td>
                  <td>
                    <Badge tone={PAY_TONE[o.status]}>{payLabel(t, o.status)}</Badge>
                  </td>
                  <td>
                    <Badge tone={SHIP_TONE[o.fulfilment]}>{shipLabel(t, o.fulfilment)}</Badge>
                  </td>
                  <td className="small">{o.tracking_number || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <OrderModal id={open} onClose={() => setOpen('')} onChanged={() => (list.reload(), onChanged())} />}
    </>
  );
}

// --- products -------------------------------------------------------------------------------------------------------------------------

function ProductModal({ p, collections, onClose, onSaved }: { p: any; collections: any[]; onClose: () => void; onSaved: () => void }) {
  const t = useT('store');
  const [f, setF] = useState({ published: p.published, slug: p.slug, kind: p.kind, images: (p.images ?? []).join('\n'), weight_g: String(p.weight_g ?? 0), collection_ids: p.collection_ids as string[], position: String(p.position ?? 0), allow_backorder: p.allow_backorder });
  const [prices, setPrices] = useState<Record<string, string>>(Object.fromEntries(Object.entries(p.variant_prices ?? {}).map(([k, v]) => [k, euro(v as number)])));
  const toggle = (id: string) => setF({ ...f, collection_ids: f.collection_ids.includes(id) ? f.collection_ids.filter((x) => x !== id) : [...f.collection_ids, id] });
  const save = async () => {
    const variant_prices = Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, parseCents(v)]).filter(([, v]) => v !== null));
    const body = { ...f, images: f.images.split('\n').map((x: string) => x.trim()).filter(Boolean), weight_g: Number(f.weight_g) || 0, position: Number(f.position) || 0, variant_prices };
    if (await act(() => api.put(`/api/store/products/${p.id}`, body), t('Produkt gespeichert'))) onSaved();
  };
  return (
    <Modal title={p.name} onClose={onClose} wide footer={<button className="btn" onClick={save}>{t('Speichern')}</button>}>
      <Check checked={f.published} onChange={(v) => setF({ ...f, published: v })} label={t('Im Shop veröffentlichen')} />
      <div className="row">
        <Field label={t('Art')}>
          <Select value={f.kind} onChange={(kind) => setF({ ...f, kind })} options={['physical', 'digital', 'gift_card'].map((k) => [k, kindLabel(t, k)] as [string, string])} />
        </Field>
        <Field label={t('Kurzname (Link zur Produktseite)')}>
          <Input value={f.slug} onChange={(slug) => setF({ ...f, slug })} spellCheck={false} />
        </Field>
      </div>
      {f.kind === 'gift_card' && <p className="muted small">{t('Gutscheine werden als Mehrzweck-Gutschein ohne Umsatzsteuer verkauft (§ 3 Abs. 15 UStG); die Steuer entsteht erst beim Einlösen. Je verkauftem Stück entsteht ein Gutschein über den Preis.')}</p>}
      <Field label={t('Bilder (eine Adresse pro Zeile, https:// oder /uploads/…)')}>
        <Textarea value={f.images} onChange={(images) => setF({ ...f, images })} rows={3} />
      </Field>
      <div className="row">
        <Field label={t('Gewicht in Gramm (für Versand nach Gewicht)')}>
          <Input type="number" min={0} value={f.weight_g} onChange={(weight_g) => setF({ ...f, weight_g })} />
        </Field>
        <Field label={t('Reihenfolge')}>
          <Input type="number" value={f.position} onChange={(position) => setF({ ...f, position })} />
        </Field>
      </div>
      <Check checked={f.allow_backorder} onChange={(v) => setF({ ...f, allow_backorder: v })} label={t('Auch ohne Bestand verkaufen')} />
      {collections.length > 0 && (
        <Field label={t('Kollektionen')}>
          <div className="opt-toggle">
            {collections.map((c) => (
              <button type="button" key={c.id} className={f.collection_ids.includes(c.id) ? 'on' : ''} aria-pressed={f.collection_ids.includes(c.id)} onClick={() => toggle(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        </Field>
      )}
      {p.variants.length > 0 ? (
        <Field label={t('Varianten (aus Lager & Einkauf) – Preis netto in €, leer = Produktpreis')}>
          <table className="t">
            <tbody>
              {p.variants.map((v: any) => (
                <tr key={v.article_id}>
                  <td>{v.label}</td>
                  <td className="muted small">{v.sku}</td>
                  <td className="small">{v.stock === null ? t('ohne Bestandsführung') : t('{n} auf Lager', { n: v.stock })}</td>
                  <td style={{ width: 120 }}>
                    <Input value={prices[v.article_id] ?? ''} onChange={(x) => setPrices({ ...prices, [v.article_id]: x })} placeholder={euro(p.net_cents)} aria-label={t('Preis {name}', { name: v.label })} inputMode="decimal" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Field>
      ) : (
        <p className="muted small">{t('Varianten (Größe, Farbe …) und Bestand legst du unter Lager & Einkauf an: einen Artikel mit diesem Produkt verknüpfen und Varianten dazu anlegen.')}</p>
      )}
    </Modal>
  );
}

function ProductsTab() {
  const t = useT('store');
  const list = useLoad(() => api.get<any[]>('/api/store/products'), []);
  const cols = useLoad(() => api.get<any[]>('/api/store/collections'), []);
  const [edit, setEdit] = useState<any>(null);
  const publish = async (p: any, v: boolean) => {
    if (await act(() => api.put(`/api/store/products/${p.id}`, { published: v }), v ? t('Veröffentlicht') : t('Aus dem Shop genommen'))) list.reload();
  };
  if (!list.data) return <Spinner />;
  if (!list.data.length) return <Empty action={<button className="btn" onClick={() => navigate('products')}>{t('Zu den Produkten')}</button>}>{t('Noch keine Produkte. Lege Produkte unter Umsatz → Produkte an und veröffentliche sie hier.')}</Empty>;
  return (
    <>
      <div className="card shop-scroll">
        <table className="t">
          <thead>
            <tr>
              <th>{t('Produkt')}</th>
              <th>{t('Art')}</th>
              <th className="num">{t('Preis netto')}</th>
              <th>{t('Varianten / Bestand')}</th>
              <th>{t('Im Shop')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((p) => (
              <tr key={p.id}>
                <td className="strong">{p.name}</td>
                <td className="small">{kindLabel(t, p.kind)}</td>
                <td className="num">{money(p.net_cents, p.currency)}</td>
                <td className="small">{p.variants.length ? p.variants.map((v: any) => `${v.label}${v.stock === null ? '' : ` (${v.stock})`}`).join(', ') : p.stock === null ? '–' : t('{n} auf Lager', { n: p.stock })}</td>
                <td>{p.recurring ? <span className="muted small">{t('Abo – nur Kauf-Link')}</span> : <Check checked={p.published} onChange={(v) => publish(p, v)} label="" aria={t('{name} veröffentlichen', { name: p.name })} />}</td>
                <td>
                  {!p.recurring && (
                    <button className="btn small secondary" onClick={() => setEdit(p)}>
                      {t('Bearbeiten')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <ProductModal p={edit} collections={cols.data ?? []} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), list.reload())} />}
    </>
  );
}

function CollectionsTab() {
  const t = useT('store');
  const list = useLoad(() => api.get<any[]>('/api/store/collections'), []);
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const add = async () => {
    if (await act(() => api.post('/api/store/collections', { name }), t('Kollektion angelegt'))) {
      setName('');
      list.reload();
    }
  };
  return (
    <>
      <div className="row shop-filter">
        <div className="grow">
          <Input value={name} onChange={setName} placeholder={t('Neue Kollektion, z. B. Geschirr')} aria-label={t('Name der Kollektion')} onKeyDown={(e) => e.key === 'Enter' && name.trim() && add()} />
        </div>
        <button className="btn" onClick={add} disabled={!name.trim()}>
          {t('Anlegen')}
        </button>
      </div>
      {!list.data?.length ? (
        <Empty>{t('Kollektionen gruppieren Produkte – der Block „Produktliste“ zeigt eine Kollektion oder alle Produkte.')}</Empty>
      ) : (
        <div className="card">
          <table className="t">
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id}>
                  <td className="strong">{c.name}</td>
                  <td className="muted small">{c.slug}</td>
                  <td className="num">
                    <button className="btn small secondary" onClick={() => setEdit(c)}>
                      {t('Bearbeiten')}
                    </button>{' '}
                    <button className="btn small ghost" onClick={async () => confirmAsk(t('Kollektion „{name}“ löschen? Die Produkte bleiben.', { name: c.name })) && (await act(() => api.del(`/api/store/collections/${c.id}`), t('Gelöscht'))) && list.reload()}>
                      {t('Löschen')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <Modal title={t('Kollektion bearbeiten')} onClose={() => setEdit(null)} footer={<button className="btn" onClick={async () => (await act(() => api.patch(`/api/store/collections/${edit.id}`, { name: edit.name, slug: edit.slug, description: edit.description }), t('Gespeichert'))) && (setEdit(null), list.reload())}>{t('Speichern')}</button>}>
          <Field label={t('Name')}>
            <Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} />
          </Field>
          <Field label={t('Kurzname (für den Block „Produktliste“)')}>
            <Input value={edit.slug} onChange={(v) => setEdit({ ...edit, slug: v })} spellCheck={false} />
          </Field>
          <Field label={t('Beschreibung')}>
            <Textarea value={edit.description} onChange={(v) => setEdit({ ...edit, description: v })} rows={3} />
          </Field>
        </Modal>
      )}
    </>
  );
}

// --- settings ---------------------------------------------------------------------------------------------------------------------------

interface Rate {
  id: string;
  name: string;
  type: 'flat' | 'weight';
  price: string;
  tiers: { up_to_g: string; price: string }[];
  countries: string;
  free_over: string;
  delivery: string;
}

function SettingsTab({ onSaved }: { onSaved: () => void }) {
  const t = useT('store');
  const s = useLoad(() => api.get<any>('/api/store/settings'), []);
  const [f, setF] = useState<any>(null);
  const [rates, setRates] = useState<Rate[]>([]);
  useEffect(() => {
    if (!s.data) return;
    setF({ ...s.data });
    setRates(s.data.shipping.map((r: any) => ({ id: r.id, name: r.name, type: r.type, price: euro(r.price_cents), tiers: r.tiers.map((x: any) => ({ up_to_g: String(x.up_to_g), price: euro(x.price_cents) })), countries: r.countries.join(', '), free_over: r.free_over_cents ? euro(r.free_over_cents) : '', delivery: r.delivery })));
  }, [s.data]);
  if (!f) return <Spinner />;
  const countries: Record<string, string> = s.data.countries;
  const set = (k: string) => (v: unknown) => setF({ ...f, [k]: v });
  const setRate = (i: number, patch: Partial<Rate>) => setRates(rates.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggleCountry = (c: string) => set('countries')(f.countries.includes(c) ? f.countries.filter((x: string) => x !== c) : [...f.countries, c]);
  const save = async () => {
    const shipping = rates.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      price_cents: parseCents(r.price) ?? 0,
      tiers: r.tiers.map((x) => ({ up_to_g: Number(x.up_to_g) || 0, price_cents: parseCents(x.price) ?? 0 })),
      countries: r.countries.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean),
      free_over_cents: parseCents(r.free_over) ?? 0,
      delivery: r.delivery,
    }));
    const body = { enabled: f.enabled, name: f.name, slug: f.slug, countries: f.countries, shipping, order_prefix: f.order_prefix, terms_required: f.terms_required, abandon_minutes: Number(f.abandon_minutes), gift_valid_months: Number(f.gift_valid_months), notify_email: f.notify_email, checkout_note: f.checkout_note };
    if (await act(() => api.put('/api/store/settings', body), t('Einstellungen gespeichert'))) {
      s.reload();
      onSaved();
    }
  };
  return (
    <div className="shop-settings">
      <section className="card">
        <Check checked={f.enabled} onChange={set('enabled')} label={t('Shop aktiv (Kasse und Produkt-Blöcke sind öffentlich)')} />
        <Field label={t('Name des Shops')}>
          <Input value={f.name} onChange={set('name')} />
        </Field>
        <Field label={t('Lieferländer')}>
          <div className="opt-toggle">
            {Object.entries(countries).map(([c, label]) => (
              <button type="button" key={c} className={f.countries.includes(c) ? 'on' : ''} aria-pressed={f.countries.includes(c)} onClick={() => toggleCountry(c)}>
                {label}
              </button>
            ))}
          </div>
        </Field>
        <MoreFields id="shop-slug" values={[f.slug]}>
          <Field label={t('Kurzname in den Links')} hint={t('/store/<kurzname>/checkout – leer: die ID des Sub-Accounts')}>
            <Input value={f.slug} onChange={set('slug')} spellCheck={false} />
          </Field>
        </MoreFields>
      </section>
      <section className="card">
        <h3>{t('Versandarten')}</h3>
        <p className="muted small">{t('Preise brutto. Pauschal oder nach Gewicht (Staffeln bis … g); ohne Länder gilt eine Versandart für alle Lieferländer. Der Versand trägt die Umsatzsteuer der Waren im Paket.')}</p>
        {rates.map((r, i) => (
          <div key={i} className="shop-rate">
            <div className="row">
              <Field label={t('Name')}>
                <Input value={r.name} onChange={(name) => setRate(i, { name })} />
              </Field>
              <Field label={t('Berechnung')}>
                <Select value={r.type} onChange={(type) => setRate(i, { type: type as Rate['type'] })} options={[['flat', t('Pauschal')], ['weight', t('Nach Gewicht')]]} />
              </Field>
              {r.type === 'flat' && (
                <Field label={t('Preis (€)')}>
                  <Input value={r.price} onChange={(price) => setRate(i, { price })} inputMode="decimal" />
                </Field>
              )}
            </div>
            {r.type === 'weight' && (
              <div className="shop-tiers">
                {r.tiers.map((x, k) => (
                  <div className="row" key={k}>
                    <Field label={t('bis Gramm')}>
                      <Input type="number" value={x.up_to_g} onChange={(v) => setRate(i, { tiers: r.tiers.map((y, z) => (z === k ? { ...y, up_to_g: v } : y)) })} />
                    </Field>
                    <Field label={t('Preis (€)')}>
                      <Input value={x.price} onChange={(v) => setRate(i, { tiers: r.tiers.map((y, z) => (z === k ? { ...y, price: v } : y)) })} inputMode="decimal" />
                    </Field>
                    <button className="btn small ghost" aria-label={t('Staffel entfernen')} onClick={() => setRate(i, { tiers: r.tiers.filter((_, z) => z !== k) })}>
                      ✕
                    </button>
                  </div>
                ))}
                <button className="btn small secondary" onClick={() => setRate(i, { tiers: [...r.tiers, { up_to_g: '', price: '' }] })}>
                  {t('+ Staffel')}
                </button>
              </div>
            )}
            <MoreFields id={`shop-rate-${r.id}`} values={[r.countries, r.free_over, r.delivery]}>
            <div className="row">
              <Field label={t('Länder (z. B. DE, AT – leer = alle)')}>
                <Input value={r.countries} onChange={(countries) => setRate(i, { countries })} spellCheck={false} />
              </Field>
              <Field label={t('Kostenlos ab (€, brutto)')}>
                <Input value={r.free_over} onChange={(free_over) => setRate(i, { free_over })} inputMode="decimal" />
              </Field>
              <Field label={t('Lieferzeit')}>
                <Input value={r.delivery} onChange={(delivery) => setRate(i, { delivery })} placeholder={t('z. B. 2–4 Werktage')} />
              </Field>
            </div>
            </MoreFields>
            <button className="btn small ghost" onClick={() => setRates(rates.filter((_, j) => j !== i))}>
              {t('Versandart entfernen')}
            </button>
          </div>
        ))}
        <button className="btn secondary" onClick={() => setRates([...rates, { id: `rate${Date.now().toString(36)}`, name: '', type: 'flat', price: '', tiers: [], countries: '', free_over: '', delivery: '' }])}>
          {t('+ Versandart')}
        </button>
      </section>
      <section className="card">
        <h3>{t('Bestellungen')}</h3>
        <Field label={t('Benachrichtigung an (E-Mail des Teams, optional)')}>
          <Input value={f.notify_email} onChange={set('notify_email')} type="email" />
        </Field>
        <Check checked={f.terms_required} onChange={set('terms_required')} label={t('AGB bestätigen lassen (Adresse unter Einwilligung & Recht → Kaufseite)')} />
        <MoreFields id="shop-orders" values={[f.checkout_note]}>
        <div className="row">
          <Field label={t('Präfix der Bestellnummer')}>
            <Input value={f.order_prefix} onChange={set('order_prefix')} />
          </Field>
          <Field label={t('Warenkorbabbruch nach (Minuten)')} hint={t('Startet den Auslöser „Checkout abgebrochen“ für Warenkörbe mit E-Mail und ohne Bestellung')}>
            <Input type="number" min={15} value={f.abandon_minutes} onChange={set('abandon_minutes')} />
          </Field>
          <Field label={t('Gutscheine gültig (Monate, 0 = unbegrenzt)')}>
            <Input type="number" min={0} value={f.gift_valid_months} onChange={set('gift_valid_months')} />
          </Field>
        </div>
        <Field label={t('Hinweis über dem Bestell-Button')}>
          <Input value={f.checkout_note} onChange={set('checkout_note')} placeholder={t('z. B. Versand innerhalb von 2 Werktagen')} />
        </Field>
        </MoreFields>
      </section>
      <div className="shop-savebar">
        <button className="btn" onClick={save}>
          {t('Einstellungen speichern')}
        </button>
      </div>
    </div>
  );
}

export function Shop({ tab: tabParam }: { tab?: string }) {
  const t = useT('store');
  const TABS: [string, string][] = [
    ['orders', t('Bestellungen')],
    ['products', t('Produkte')],
    ['collections', t('Kollektionen')],
    ['abandoned', t('Abgebrochene Warenkörbe')],
    ['settings', t('Einstellungen')],
  ];
  const tab = TABS.some(([k]) => k === tabParam) ? tabParam! : 'orders';
  const s = useLoad(() => api.get<any>('/api/store/settings'), []);
  return (
    <div className="shop">
      <PageHead title={t('Online-Shop')} sub={t('Produkte mit Varianten, Warenkorb und Kasse, Versand, Bestellungen mit Rechnung – bezahlt über Stripe, PayPal oder Mollie.')}>
        {s.data?.enabled && <Copy text={s.data.checkout_url} label={t('Link zur Kasse')} />}
      </PageHead>
      {s.data && (
        <SortableGrid id="shop.stats" className="shop-stats">
          <Stat label={t('Zu versenden')} value={s.data.stats.to_ship} />
          <Stat label={t('Bezahlte Bestellungen')} value={s.data.stats.paid} />
          <Stat label={t('Umsatz')} value={money(s.data.stats.revenue_cents, s.data.currency)} />
          <Stat label={t('Zahlungsarten')} value={s.data.providers.length ? s.data.providers.join(', ') : '–'} sub={!s.data.providers.length ? t('Einstellungen → Stripe & Zahlungen') : undefined} />
        </SortableGrid>
      )}
      {s.data && !s.data.enabled && <p className="shop-hint">{t('Der Shop ist noch aus. Unter Einstellungen einschalten, Versandarten festlegen und Produkte veröffentlichen; auf deiner Website zeigen die Blöcke „Produktliste“ und „Produktdetail“ die Produkte.')}</p>}
      <Tabs tabs={TABS} value={tab} onChange={(k) => navigate(`shop/${k}`)} />
      {tab === 'orders' && <OrdersTab onChanged={s.reload} />}
      {tab === 'products' && <ProductsTab />}
      {tab === 'collections' && <CollectionsTab />}
      {tab === 'abandoned' && <ShopAbandoned />}
      {tab === 'settings' && <SettingsTab onSaved={s.reload} />}
    </div>
  );
}
