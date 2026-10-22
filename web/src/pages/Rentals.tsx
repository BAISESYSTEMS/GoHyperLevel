import { useState } from 'react';
import { api } from '../api';
import { MoreFields } from '../areas/fields';
import { useT } from '../i18n';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, useLoad } from '../ui';

/**
 * Kalender → Vermietung (modules/rentals.ts, docs/booking.md#rentals): items with a quantity (3 e-bikes, a holiday flat) that customers
 * book by date range on `/book/rent/<slug>` – per day or per night, with a price and an optional deposit. Each item is a calendar of its
 * own, so bookings show across their days in the calendar view and get the calendar's confirmation e-mail.
 */

type Rental = {
  id?: string;
  name: string;
  description: string;
  quantity: number;
  unit: 'day' | 'night';
  price_cents: number;
  deposit_cents: number;
  min_units: number;
  max_units: number;
  checkin_time: string;
  checkout_time: string;
  max_days: number;
  active: boolean;
  currency?: string;
  slug?: string;
  url?: string;
  upcoming?: number;
};

const EMPTY: Rental = { name: '', description: '', quantity: 1, unit: 'day', price_cents: 0, deposit_cents: 0, min_units: 1, max_units: 0, checkin_time: '', checkout_time: '', max_days: 365, active: true };
const toCents = (s: string) => Math.max(0, Math.round(Number(String(s).replace(/\./g, '').replace(',', '.')) * 100) || 0);
const centsText = (c: number) => (c ? (c / 100).toFixed(2).replace('.', ',') : '');
const money = (c: number, cur = 'EUR') => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: cur });

export function Rentals() {
  const t = useT('rentals');
  const list = useLoad(() => api.get<Rental[]>('/api/rentals'), []);
  const [edit, setEdit] = useState<Rental | null>(null);
  const [open, setOpen] = useState<Rental | null>(null);
  const per = (r: Rental) => (r.unit === 'night' ? t('pro Nacht') : t('pro Tag'));
  const remove = async (r: Rental) => {
    if (!(await confirmAsk(t('„{name}“ samt Kalender und Buchungen löschen?', { name: r.name })))) return;
    const ok = await act(() => api.del(`/api/rentals/${r.id}${r.upcoming ? '?force=1' : ''}`), t('Gelöscht'));
    if (ok) list.reload();
  };
  return (
    <div>
      <p className="muted">{t('Dinge mit Stückzahl, die Kunden für einen Zeitraum buchen – z. B. E-Bikes pro Tag oder eine Ferienwohnung pro Nacht.')}</p>
      <div className="actions">
        <button className="tx-btn primary" onClick={() => setEdit({ ...EMPTY })}>
          + {t('Mietangebot')}
        </button>
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.length === 0 ? (
        <Empty>{t('Noch kein Mietangebot.')}</Empty>
      ) : (
        list.data.map((r) => (
          <div key={r.id} className="card">
            <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <h2 style={{ margin: 0 }}>
                  {r.name} {!r.active && <Badge>{t('inaktiv')}</Badge>}
                </h2>
                <span className="muted">
                  {t('{n} Stück', { n: r.quantity })} · {r.price_cents ? `${money(r.price_cents, r.currency)} ${per(r)}` : t('kostenlos')}
                  {r.deposit_cents ? ` · ${t('Kaution {amount}', { amount: money(r.deposit_cents, r.currency) })}` : ''} · {t('{n} anstehend', { n: r.upcoming ?? 0 })}
                </span>
              </div>
              <div className="actions">
                <a className="tx-btn" href={r.url} target="_blank" rel="noreferrer">
                  {t('Öffnen')} ↗
                </a>
                <button className="tx-btn" onClick={() => setOpen(r)}>
                  {t('Buchungen')}
                </button>
                <button className="tx-btn" onClick={() => setEdit(r)}>
                  {t('Bearbeiten')}
                </button>
                <button className="tx-btn danger" onClick={() => remove(r)}>
                  {t('Löschen')}
                </button>
              </div>
            </div>
          </div>
        ))
      )}
      {edit && (
        <RentalEditor
          rental={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            list.reload();
          }}
        />
      )}
      {open && (
        <Bookings
          rental={open}
          onClose={() => {
            setOpen(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function RentalEditor({ rental, onClose, onSaved }: { rental: Rental; onClose: () => void; onSaved: () => void }) {
  const t = useT('rentals');
  const [r, setR] = useState<Rental>(rental);
  const [price, setPrice] = useState(centsText(rental.price_cents));
  const [deposit, setDeposit] = useState(centsText(rental.deposit_cents));
  const set = (p: Partial<Rental>) => setR({ ...r, ...p });
  const night = r.unit === 'night';
  const save = async () => {
    const body = { name: r.name, description: r.description, quantity: Number(r.quantity) || 1, unit: r.unit, price_cents: toCents(price), deposit_cents: toCents(deposit), min_units: Number(r.min_units) || 1, max_units: Number(r.max_units) || 0, checkin_time: r.checkin_time, checkout_time: r.checkout_time, max_days: Number(r.max_days) || 365, active: r.active };
    const ok = await act(() => (r.id ? api.patch(`/api/rentals/${r.id}`, body) : api.post('/api/rentals', body)), t('Gespeichert'));
    if (ok) onSaved();
  };
  return (
    <Modal
      title={r.id ? t('Mietangebot bearbeiten') : t('Neues Mietangebot')}
      onClose={onClose}
      footer={
        <button className="btn" onClick={save}>
          {t('Speichern')}
        </button>
      }
    >
      <Field label={t('Name')}>
        <Input value={r.name} onChange={(x) => set({ name: x })} placeholder={t('z. B. E-Bike oder Ferienwohnung')} />
      </Field>
      <div className="row">
        <Field label={t('Anzahl')} hint={t('Wie viele gleichzeitig vermietet werden können')}>
          <Input type="number" min={1} value={r.quantity} onChange={(x) => set({ quantity: Number(x) })} />
        </Field>
        <Field label={t('Abrechnung')}>
          <Select
            value={r.unit}
            onChange={(x) => set({ unit: x as Rental['unit'] })}
            options={[
              ['day', t('pro Tag')],
              ['night', t('pro Nacht (Anreise/Abreise)')],
            ]}
          />
        </Field>
        <Field label={night ? t('Preis pro Nacht (€)') : t('Preis pro Tag (€)')} hint={t('0 = kostenlos')}>
          <Input inputMode="decimal" value={price} placeholder="0,00" onChange={setPrice} onBlur={() => setPrice(centsText(toCents(price)))} />
        </Field>
      </div>
      <MoreFields id="rental-more" values={[r.description, deposit, r.min_units > 1 ? 'x' : '', r.max_units ? 'x' : '', r.checkin_time, r.checkout_time, r.max_days !== 365 ? 'x' : '', r.active ? '' : 'x']}>
        <Field label={t('Beschreibung')}>
          <Textarea value={r.description} onChange={(x) => set({ description: x })} rows={2} />
        </Field>
        <Field label={t('Kaution je Stück (€)')} hint={t('Wird mit bezahlt und steht ohne Steuer auf der Rechnung')}>
          <Input inputMode="decimal" value={deposit} placeholder="0,00" onChange={setDeposit} onBlur={() => setDeposit(centsText(toCents(deposit)))} />
        </Field>
        <div className="row">
          <Field label={night ? t('Mindestens Nächte') : t('Mindestens Tage')}>
            <Input type="number" min={1} value={r.min_units} onChange={(x) => set({ min_units: Number(x) })} />
          </Field>
          <Field label={night ? t('Höchstens Nächte') : t('Höchstens Tage')} hint={t('0 = ohne Grenze')}>
            <Input type="number" min={0} value={r.max_units} onChange={(x) => set({ max_units: Number(x) })} />
          </Field>
        </div>
        <div className="row">
          <Field label={night ? t('Anreise ab') : t('Abholung ab')} hint={night ? '15:00' : '09:00'}>
            <Input type="time" value={r.checkin_time} onChange={(x) => set({ checkin_time: x })} />
          </Field>
          <Field label={night ? t('Abreise bis') : t('Rückgabe bis')} hint={night ? '11:00' : '18:00'}>
            <Input type="time" value={r.checkout_time} onChange={(x) => set({ checkout_time: x })} />
          </Field>
          <Field label={t('Buchbar bis (Tage im Voraus)')}>
            <Input type="number" min={1} value={r.max_days} onChange={(x) => set({ max_days: Number(x) })} />
          </Field>
        </div>
        <Check checked={r.active} onChange={(x) => set({ active: x })} label={t('Online buchbar')} />
      </MoreFields>
    </Modal>
  );
}

type Booking = { id: string; status: string; text: string; qty: number; total_cents: number; currency: string; source: string; contact: { first_name: string; last_name: string; email: string } };

function Bookings({ rental, onClose }: { rental: Rental; onClose: () => void }) {
  const t = useT('rentals');
  const list = useLoad(() => api.get<Booking[]>(`/api/rentals/${rental.id}/bookings`), [rental.id]);
  const night = rental.unit === 'night';
  const [f, setF] = useState({ from: '', to: '', qty: '1', email: '', first_name: '', last_name: '', waive: false });
  const [link, setLink] = useState('');
  const status: Record<string, string> = { pending: t('wartet auf Zahlung'), confirmed: t('bestätigt'), cancelled: t('abgesagt'), expired: t('abgelaufen'), refunded: t('erstattet') };
  const book = async () => {
    const r = await act(() => api.post<any>(`/api/rentals/${rental.id}/book`, { from: f.from, to: f.to, qty: Number(f.qty) || 1, email: f.email, first_name: f.first_name, last_name: f.last_name, payment: f.waive ? 'waive' : 'require' }), t('Gebucht'));
    if (!r) return;
    setLink(r.status === 'payment_required' ? r.checkout_url : '');
    setF({ ...f, from: '', to: '', email: '', first_name: '', last_name: '' });
    list.reload();
  };
  return (
    <Modal title={t('Buchungen: {name}', { name: rental.name })} onClose={onClose} wide>
      {!list.data ? (
        <Spinner />
      ) : list.data.length === 0 ? (
        <p className="muted">{t('Keine anstehenden Buchungen.')}</p>
      ) : (
        <table className="table">
          <tbody>
            {list.data.map((b) => (
              <tr key={b.id}>
                <td>{b.text}</td>
                <td>{b.qty > 1 ? t('{n} Stück', { n: b.qty }) : ''}</td>
                <td>{[b.contact.first_name, b.contact.last_name].filter(Boolean).join(' ') || b.contact.email}</td>
                <td>{b.total_cents ? money(b.total_cents, b.currency) : ''}</td>
                <td>
                  <Badge tone={b.status === 'confirmed' ? 'green' : b.status === 'pending' ? 'yellow' : 'gray'}>{status[b.status] ?? b.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>{t('Für einen Kunden buchen')}</h3>
      <div className="row">
        <Field label={night ? t('Anreise') : t('Erster Tag')}>
          <Input type="date" value={f.from} onChange={(x) => setF({ ...f, from: x })} />
        </Field>
        <Field label={night ? t('Abreise') : t('Letzter Tag')}>
          <Input type="date" value={f.to} onChange={(x) => setF({ ...f, to: x })} />
        </Field>
        {rental.quantity > 1 && (
          <Field label={t('Anzahl')}>
            <Input type="number" min={1} max={rental.quantity} value={f.qty} onChange={(x) => setF({ ...f, qty: x })} />
          </Field>
        )}
      </div>
      <div className="row">
        <Field label={t('E-Mail')}>
          <Input type="email" value={f.email} onChange={(x) => setF({ ...f, email: x })} />
        </Field>
        <Field label={t('Vorname')}>
          <Input value={f.first_name} onChange={(x) => setF({ ...f, first_name: x })} />
        </Field>
        <Field label={t('Nachname')}>
          <Input value={f.last_name} onChange={(x) => setF({ ...f, last_name: x })} />
        </Field>
      </div>
      {rental.price_cents + rental.deposit_cents > 0 && <Check checked={f.waive} onChange={(x) => setF({ ...f, waive: x })} label={t('Ohne Online-Zahlung buchen (bar oder per Rechnung)')} />}
      <p>
        <button className="btn" disabled={!f.from || !f.to || !f.email} onClick={book}>
          {t('Buchen')}
        </button>
      </p>
      {link && (
        <p className="muted">
          {t('Zahlungslink für den Kunden:')} <a href={link} target="_blank" rel="noreferrer">{link}</a>
        </p>
      )}
    </Modal>
  );
}
