import { useState } from 'react';
import { Icon } from '../icons';
import { api, d, dt, money } from '../api';
import { Check, Empty, Field, Input, Link, Modal, PageHead, Select, Spinner, Stat, Tabs, act, confirmAsk, useLoad } from '../ui';
import { ACCESS_LABEL, Callout, Facts, Item, Panel, Progress, StatusBadge, euroText, parseEuro } from './CreatorKit';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Ratenzahlung: payment plans on one-time products (the buyer picks "3 × 99 €" on the buy page; Stripe collects the instalments
 * and stops by itself) and the purchases with their progress. Docs: docs/payment-plans.md.
 */

const ON_DEFAULT: [string, string][] = [
  ['pause', 'Zugang pausieren (kommt zurück, sobald bezahlt wird)'],
  ['revoke', 'Zugang entziehen'],
  ['keep', 'Zugang behalten (nur benachrichtigen)'],
];
const FILTERS: [string, string][] = [
  ['', 'Alle Käufe'],
  ['active', 'Laufend'],
  ['defaulted', 'Ausgefallen'],
  ['completed', 'Abgeschlossen'],
  ['canceled', 'Beendet'],
];

const every = (interval: string, n: number) => (interval === 'week' ? (n === 1 ? 'wöchentlich' : `alle ${n} Wochen`) : n === 1 ? 'monatlich' : n === 12 ? 'jährlich' : `alle ${n} Monate`);

function PlanDialog({ plan, products, productId, onClose, onSaved }: { plan?: any; products: any[]; productId?: string; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    product_id: plan?.product_id ?? productId ?? products[0]?.id ?? '',
    name: plan?.name ?? '',
    installments: String(plan?.installments ?? 3),
    interval: plan?.interval ?? 'month',
    interval_count: String(plan?.interval_count ?? 1),
    amount: euroText(plan?.amount_cents),
    first: euroText(plan?.first_amount_cents),
    on_default: plan?.on_default ?? 'pause',
    active: plan ? !!plan.active : true,
  });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const amount = parseEuro(f.amount);
  const first = f.first.trim() ? parseEuro(f.first) : null;
  const n = Math.round(Number(f.installments));
  const count = Math.round(Number(f.interval_count));
  const prod = products.find((p) => p.id === f.product_id);
  const problem = !prod
    ? 'Bitte ein Produkt wählen.'
    : !(n >= 2 && n <= 60)
      ? 'Raten: 2 bis 60.'
      : !(count >= 1 && count <= (f.interval === 'week' ? 52 : 12))
        ? f.interval === 'week' ? 'Abstand: 1 bis 52 Wochen.' : 'Abstand: 1 bis 12 Monate.'
        : amount === null || amount < 50
          ? 'Rate: mindestens 0,50 €.'
          : f.first.trim() && (first === null || first < 50)
            ? 'Erste Rate: mindestens 0,50 € – oder leer lassen.'
            : '';
  const total = amount === null || !(n >= 2) ? null : (first ?? amount) + (n - 1) * amount;
  const price = prod ? Math.round(prod.price_cents * (1 + (Number(prod.tax_rate) || 0) / 100)) : null;
  const save = async () => {
    const body = { product_id: f.product_id, name: f.name, installments: n, interval: f.interval, interval_count: count, amount_cents: amount, first_amount_cents: first, on_default: f.on_default, active: f.active };
    const r = await act(() => (plan ? api.patch(`/api/payment-plans/${plan.id}`, body) : api.post('/api/payment-plans', body)), 'Plan gespeichert');
    if (r) {
      onSaved();
      onClose();
    }
  };
  return (
    <Modal
      title={plan ? 'Ratenplan bearbeiten' : 'Neuer Ratenplan'}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" disabled={!!problem} onClick={save} data-tour="plan-save">
            Speichern
          </button>
        </>
      }
    >
      {plan && <Callout tone="info">Bestehende Käufe behalten die Bedingungen, zu denen sie gekauft wurden. Die Änderung gilt für neue Käufe.</Callout>}
      <Field label="Produkt *" hint="Ratenzahlung gibt es für Einmal-Produkte, nicht für Abos.">
        <Select value={f.product_id} onChange={(v) => set({ product_id: v })} options={products.map((p) => [p.id, `${p.name} · ${money(p.price_cents, p.currency)}`] as [string, string])} />
      </Field>
      <Field label="Name (optional)" hint="Erscheint auf der Kaufseite statt der Standard-Beschreibung, z. B. „Bequem in 3 Raten“.">
        <Input value={f.name} onChange={(v) => set({ name: v })} maxLength={120} />
      </Field>
      <div className="cr-form-row">
        <Field label="Anzahl Raten *">
          <Input type="number" min={2} max={60} value={f.installments} onChange={(v) => set({ installments: v })} />
        </Field>
        <Field label="Betrag je Rate (brutto) *">
          <Input inputMode="decimal" value={f.amount} onChange={(v) => set({ amount: v })} placeholder="99,00" />
        </Field>
      </div>
      <div className="cr-form-row">
        <Field label="Abstand">
          <Input type="number" min={1} max={f.interval === 'week' ? 52 : 12} value={f.interval_count} onChange={(v) => set({ interval_count: v })} />
        </Field>
        <Field label="Einheit">
          <Select value={f.interval} onChange={(v) => set({ interval: v })} options={[['month', 'Monat(e)'], ['week', 'Woche(n)']]} />
        </Field>
      </div>
      <Field label="Erste Rate abweichend (optional)" hint="Zum Beispiel eine höhere Anzahlung. Leer = alle Raten gleich.">
        <Input inputMode="decimal" value={f.first} onChange={(v) => set({ first: v })} placeholder="150,00" />
      </Field>
      <Field label="Wenn eine Rate nicht eingezogen werden kann">
        <Select value={f.on_default} onChange={(v) => set({ on_default: v })} options={ON_DEFAULT} />
      </Field>
      <Check checked={f.active} onChange={(v) => set({ active: v })} label="Auf der Kaufseite anbieten" />
      {problem ? (
        <p className="cr-err">{problem}</p>
      ) : (
        <Callout tone="info">
          <strong>
            {first && first !== amount ? `${money(first)} + ${n - 1} × ${money(amount!)}` : `${n} × ${money(amount!)}`} {every(f.interval, count)}
          </strong>{' '}
          · insgesamt {money(total!)}
          {price !== null && total !== null && total < price && <p className="small">Achtung: Die Summe liegt unter dem Preis des Produkts ({money(price)}).</p>}
          {price !== null && total !== null && total > price && <p className="small">Die Summe liegt über dem Einmalpreis ({money(price)}) – ein Ratenaufschlag. Das ist erlaubt, muss aber auf der Kaufseite klar erkennbar sein.</p>}
        </Callout>
      )}
    </Modal>
  );
}

function PurchaseDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data, reload } = useLoad(() => api.get(`/api/payment-plans/subscriptions/${id}`), [id]);
  if (!data)
    return (
      <Modal title="Ratenkauf" onClose={onClose}>
        <Spinner />
      </Modal>
    );
  const s = data;
  const toggle = async (on: boolean) => {
    if (await act(() => api.post(`/api/payment-plans/subscriptions/${id}/access`, { on }), on ? 'Zugang fortgesetzt' : 'Zugang pausiert')) {
      reload();
      onChanged();
    }
  };
  const cancel = async () => {
    if (!confirmAsk(`Den Ratenplan beenden? Stripe bucht dann keine weiteren Raten ab (bisher bezahlt: ${s.paid_count} von ${s.installments}).`)) return;
    if (await act(() => api.post(`/api/payment-plans/subscriptions/${id}/cancel`), 'Ratenplan beendet')) {
      reload();
      onChanged();
    }
  };
  const ended = s.status === 'completed' || s.status === 'canceled';
  return (
    <Modal
      title="Ratenkauf"
      wide
      onClose={onClose}
      footer={
        <>
          {s.contact_id && s.access === 'active' && s.status !== 'completed' && (
            <button className="btn secondary" onClick={() => toggle(false)}>
              Zugang pausieren
            </button>
          )}
          {s.contact_id && s.access !== 'active' && (
            <button className="btn secondary" onClick={() => toggle(true)}>
              Zugang fortsetzen
            </button>
          )}
          {!ended && (
            <button className="btn danger" onClick={cancel}>
              Plan beenden
            </button>
          )}
        </>
      }
    >
      <Facts
        rows={[
          ['Kontakt', s.contact_id ? <Link to={`contacts/${s.contact_id}`}>{s.contact?.name || 'Kontakt öffnen'}</Link> : 'noch nicht zugeordnet'],
          ['Produkt', s.product_name],
          ['Plan', s.label],
          ['Status', <StatusBadge key="s" status={s.status} />],
          ['Zugang', ACCESS_LABEL[s.access] ?? s.access],
          ['Bezahlt', `${s.paid_count} von ${s.installments} Raten · ${money(s.paid_cents, s.currency)} von ${money(s.total_cents, s.currency)}`],
          ['Offen', money(s.open_cents, s.currency)],
          ['Gestartet', d(s.started_at)],
          ['Abgeschlossen', s.completed_at ? d(s.completed_at) : ''],
          ['Fehlversuche', s.failed_count ? `${s.failed_count} (zuletzt ${dt(s.last_failed_at)})` : ''],
          ['Grund', s.default_reason],
        ]}
      />
      <Progress value={s.paid_count} max={s.installments} label="Bezahlte Raten" />
      <h4 style={{ margin: '18px 0 8px' }}>Bezahlte Raten</h4>
      {s.payments.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Rate</th>
                <th>Betrag</th>
                <th>Bezahlt am</th>
                <th>Rechnung</th>
              </tr>
            </thead>
            <tbody>
              {s.payments.map((p: any) => (
                <tr key={p.id}>
                  <td>{p.number}</td>
                  <td>{money(p.amount_cents, s.currency)}</td>
                  <td>{dt(p.paid_at)}</td>
                  <td>{p.invoice_id ? <Link to={`invoices/${p.invoice_id}`}>Beleg öffnen</Link> : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">Noch keine Rate bezahlt.</p>
      )}
      {s.jobs.some((j: any) => j.status !== 'done') && (
        <Callout tone="warn">
          <strong>Offene Aufgaben im Hintergrund</strong>
          <ul>
            {s.jobs
              .filter((j: any) => j.status !== 'done')
              .map((j: any, i: number) => (
                <li key={i}>
                  {j.kind === 'cancel_at' ? 'Ende nach der letzten Rate bei Stripe setzen' : j.kind} – Versuch {j.attempts}, nächster {dt(j.next_at)}
                  {j.error ? ` (${j.error})` : ''}
                </li>
              ))}
          </ul>
        </Callout>
      )}
    </Modal>
  );
}

export function PaymentPlans({ tab: tabParam }: { tab?: string }) {
  const [tab, setTab] = useState(tabParam === 'plans' ? 'plans' : 'purchases');
  const stripe = useLoad(() => api.get('/api/stripe'), []);
  const products = useLoad(() => api.get<any[]>('/api/products'), []);
  const plans = useLoad(() => api.get<any[]>('/api/payment-plans'), []);
  const [status, setStatus] = useState('');
  const subs = useLoad(() => api.get<any[]>(`/api/payment-plans/subscriptions${status ? `?status=${status}` : ''}`), [status]);
  const all = useLoad(() => api.get<any[]>('/api/payment-plans/subscriptions?limit=500'), []);
  const [editing, setEditing] = useState<{ plan?: any; productId?: string } | null>(null);
  const [open, setOpen] = useState('');
  const oneTime = (products.data ?? []).filter((p) => !p.recurring);
  const count = (s: string) => (all.data ?? []).filter((x) => x.status === s).length;
  const openCents = (all.data ?? []).filter((x) => x.status === 'active' || x.status === 'defaulted').reduce((a, x) => a + (x.open_cents || 0), 0);
  const refresh = () => {
    plans.reload();
    subs.reload();
    all.reload();
  };
  const remove = async (p: any) => {
    if (!confirmAsk(`Den Plan „${p.name || p.label}“ löschen? Bestehende Käufe laufen mit ihren Bedingungen weiter.`)) return;
    if (await act(() => api.del(`/api/payment-plans/${p.id}`), 'Plan gelöscht')) refresh();
  };
  const byProduct = oneTime.map((p) => ({ product: p, plans: (plans.data ?? []).filter((x) => x.product_id === p.id) }));

  return (
    <div className="cr cr-plans">
      <PageHead title="Ratenzahlung" sub="Kunden zahlen in Raten – Stripe zieht ein und hört nach der letzten Rate von selbst auf. Der Zugang folgt der Zahlung.">
        <button className="btn" data-tour="plans-new" disabled={!oneTime.length} onClick={() => setEditing({})}>
          <Icon name="repeat" /> Neuer Ratenplan
        </button>
      </PageHead>
      {stripe.data && !stripe.data.connected && (
        <Callout tone="warn" tour="plans-stripe">
          <strong>Stripe ist noch nicht verbunden.</strong> Ratenzahlung läuft über Stripe-Abos – trage unter <Link to="settings/stripe">Einstellungen → Stripe</Link> deinen Schlüssel ein und richte den Webhook ein (siehe Anleitung).
        </Callout>
      )}
      <SortableGrid id="plans-stats" className="stats" data-tour="plans-stats">
        <Stat label="Laufende Käufe" value={count('active')} />
        <Stat label="Ausgefallen" value={count('defaulted')} sub={count('defaulted') ? 'Zahlung klären' : undefined} />
        <Stat label="Abgeschlossen" value={count('completed')} />
        <Stat label="Noch offen (laufend + ausgefallen)" value={money(openCents)} />
      </SortableGrid>
      <Tabs
        tabs={[
          ['purchases', `Käufe${all.data ? ` (${all.data.length})` : ''}`],
          ['plans', 'Pläne'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'purchases' && (
        <Panel title="Ratenkäufe" sub="Wer zahlt wie weit? Ein Klick zeigt die bezahlten Raten." wide tour="plans-purchases" actions={<Select value={status} onChange={setStatus} aria="Status" options={FILTERS} />}>
          {subs.loading && !subs.data ? (
            <Spinner />
          ) : subs.data?.length ? (
            <div className="cr-list">
              {subs.data.map((s) => (
                <Item
                  key={s.id}
                  tone={s.status === 'defaulted' ? 'bad' : s.status === 'completed' ? 'ok' : undefined}
                  onClick={() => setOpen(s.id)}
                  side={
                    <>
                      <StatusBadge status={s.status} />
                      {s.access !== 'active' && <span className="badge yellow">{ACCESS_LABEL[s.access]}</span>}
                    </>
                  }
                >
                  <strong>{s.contact?.name || 'Kontakt noch offen'}</strong> · {s.product_name}
                  <div className="cr-sub">
                    {s.label} · {s.paid_count} von {s.installments} Raten bezahlt ({money(s.paid_cents, s.currency)}) · seit {d(s.started_at)}
                  </div>
                  <Progress value={s.paid_count} max={s.installments} label="Bezahlte Raten" />
                </Item>
              ))}
            </div>
          ) : (
            <Empty>{status ? 'Keine Käufe mit diesem Status.' : 'Noch kein Kauf mit Ratenzahlung. Lege einen Plan an – er erscheint dann auf der Kaufseite des Produkts.'}</Empty>
          )}
        </Panel>
      )}
      {tab === 'plans' && (
        <div className="cr-panels" data-tour="plans-list">
          {!oneTime.length && !products.loading && (
            <Panel title="Noch kein Einmal-Produkt" wide>
              <Empty action={<Link to="products" className="btn">Zu den Produkten</Link>}>Ratenzahlung gibt es für Produkte mit Einmalpreis. Lege zuerst eines an.</Empty>
            </Panel>
          )}
          {byProduct.map(({ product, plans: list }) => (
            <Panel
              key={product.id}
              title={product.name}
              sub={`Einmalpreis ${money(product.price_cents, product.currency)}${product.tax_rate ? ` + ${String(product.tax_rate).replace('.', ',')} % USt.` : ''}`}
              actions={
                <button className="btn small secondary" onClick={() => setEditing({ productId: product.id })}>
                  + Plan
                </button>
              }
            >
              {list.length ? (
                <div className="cr-list">
                  {list.map((p) => (
                    <Item
                      key={p.id}
                      onClick={() => setEditing({ plan: p })}
                      side={
                        <>
                          {!p.active && <span className="badge gray">aus</span>}
                          <button
                            className="btn small ghost danger-text"
                            onClick={(e) => {
                              e.stopPropagation();
                              void remove(p);
                            }}
                          >
                            Löschen
                          </button>
                        </>
                      }
                    >
                      <strong>{p.name || p.label}</strong>
                      <div className="cr-sub">
                        {p.name ? `${p.label} · ` : ''}insgesamt {money(p.total_cents, p.currency)} · {p.running} laufend · {p.completed} abgeschlossen · {p.defaulted} ausgefallen
                      </div>
                    </Item>
                  ))}
                </div>
              ) : (
                <p className="muted">Noch kein Plan – Kunden zahlen einmalig.</p>
              )}
            </Panel>
          ))}
        </div>
      )}
      {editing && <PlanDialog plan={editing.plan} productId={editing.productId} products={oneTime} onClose={() => setEditing(null)} onSaved={refresh} />}
      {open && <PurchaseDialog id={open} onClose={() => setOpen('')} onChanged={refresh} />}
    </div>
  );
}
