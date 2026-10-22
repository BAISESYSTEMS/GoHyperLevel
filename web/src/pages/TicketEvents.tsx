import { useState } from 'react';
import { api, money } from '../api';
import { MoreFields } from '../areas/fields';
import { fmtDateTime, useT } from '../i18n';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, useLoad } from '../ui';

/**
 * Kalender → Events & Tickets (modules/ticket-events.ts, docs/booking.md#ticket-types): events with ticket types – name, price,
 * quota, optional sale window and per-order limit (folded in Einfach-Modus). Buyers order on `/book/event/<slug>`, every ticket
 * has its own QR code; the report counts sold and checked-in tickets per type.
 */

type TType = { id?: string; name: string; description: string; price: string; quota: string; sale_start: string; sale_end: string; max_per_order: string; active: boolean };
type Ev = { id?: string; name: string; starts_at: string; ends_at: string; venue: string; description: string; currency: string; tax_rate: string; slug: string; active: boolean; types: TType[] };
type Row = { type_id: string; name: string; sold: number; checked_in: number; held: number; left: number | null; quota: number | null; revenue_cents: number; state: string };
type Report = { currency: string; types: Row[]; totals: { sold: number; checked_in: number; held: number; revenue_cents: number } };

const pad = (n: number) => String(n).padStart(2, '0');
/** ISO → value of a datetime-local input (the browser's time zone). */
const toLocal = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);
const euros = (cents: number) => (cents ? (cents / 100).toFixed(2).replace('.', ',') : '');
/** "12,50", "1.250,00" or "12.50" → cents. */
const cents = (v: string) => {
  const s = String(v).trim();
  return Math.round(Number((s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s) || 0) * 100);
};

const blankType = (name = ''): TType => ({ name, description: '', price: '', quota: '', sale_start: '', sale_end: '', max_per_order: '', active: true });

export function TicketEvents() {
  const t = useT('tickets');
  const list = useLoad(() => api.get<any[]>('/api/ticket-events?report=1'), []);
  const [edit, setEdit] = useState<Ev | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const startEdit = (e: any) =>
    setEdit({
      id: e.id,
      name: e.name,
      starts_at: toLocal(e.starts_at),
      ends_at: toLocal(e.ends_at),
      venue: e.venue,
      description: e.description,
      currency: e.currency,
      tax_rate: e.tax_rate === null ? '' : String(e.tax_rate),
      slug: e.slug,
      active: e.active,
      types: e.types.map((x: any) => ({ id: x.id, name: x.name, description: x.description, price: euros(x.price_cents), quota: x.quota === null ? '' : String(x.quota), sale_start: toLocal(x.sale_start), sale_end: toLocal(x.sale_end), max_per_order: x.max_per_order === null ? '' : String(x.max_per_order), active: x.active })),
    });
  return (
    <div>
      <p className="muted">{t('Events mit Ticketarten: Käufer wählen Ticketart und Anzahl, jedes Ticket hat einen eigenen QR-Code für den Einlass.')}</p>
      <div className="actions">
        <button className="tx-btn primary" onClick={() => setEdit({ name: '', starts_at: '', ends_at: '', venue: '', description: '', currency: 'EUR', tax_rate: '', slug: '', active: true, types: [blankType(t('Standard'))] })}>
          + {t('Event')}
        </button>
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.length === 0 ? (
        <Empty>{t('Noch kein Event mit Tickets.')}</Empty>
      ) : (
        list.data.map((e) => (
          <div key={e.id} className="card">
            <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div>
                <h2 style={{ margin: 0 }}>
                  {e.name} {!e.active && <Badge>{t('inaktiv')}</Badge>}
                </h2>
                <span className="muted">
                  {fmtDateTime(e.starts_at)}
                  {e.venue ? ` · ${e.venue}` : ''} · {t('{sold} verkauft · {checked} eingecheckt', { sold: e.report.totals.sold, checked: e.report.totals.checked_in })}
                </span>
              </div>
              <div className="actions">
                <a className="tx-btn" href={e.url} target="_blank" rel="noreferrer">
                  {t('Öffnen')} ↗
                </a>
                <button className="tx-btn" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                  {t('Bericht')}
                </button>
                <button className="tx-btn" onClick={() => startEdit(e)}>
                  {t('Bearbeiten')}
                </button>
                <button className="tx-btn danger" onClick={async () => (await confirmAsk(t('„{name}“ löschen?', { name: e.name }))) && act(() => api.del(`/api/ticket-events/${e.id}`)).then(list.reload)}>
                  {t('Löschen')}
                </button>
              </div>
            </div>
            {open === e.id && <ReportTable report={e.report} />}
          </div>
        ))
      )}
      {edit && (
        <EventEditor
          ev={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function ReportTable({ report }: { report: Report }) {
  const t = useT('tickets');
  return (
    <table className="t" style={{ marginTop: 12 }}>
      <thead>
        <tr>
          <th>{t('Ticketart')}</th>
          <th>{t('Verkauft')}</th>
          <th>{t('Eingecheckt')}</th>
          <th>{t('Reserviert')}</th>
          <th>{t('Frei')}</th>
          <th>{t('Umsatz')}</th>
        </tr>
      </thead>
      <tbody>
        {report.types.map((r) => (
          <tr key={r.type_id}>
            <td>
              {r.name} {r.state === 'sold_out' && <Badge tone="red">{t('Ausverkauft')}</Badge>}
            </td>
            <td>{r.quota === null ? r.sold : `${r.sold} / ${r.quota}`}</td>
            <td>{r.checked_in}</td>
            <td>{r.held}</td>
            <td>{r.left === null ? '∞' : r.left}</td>
            <td>{money(r.revenue_cents, report.currency)}</td>
          </tr>
        ))}
        <tr>
          <td>
            <strong>{t('Gesamt')}</strong>
          </td>
          <td>{report.totals.sold}</td>
          <td>{report.totals.checked_in}</td>
          <td>{report.totals.held}</td>
          <td />
          <td>{money(report.totals.revenue_cents, report.currency)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function EventEditor({ ev, onClose, onSaved }: { ev: Ev; onClose: () => void; onSaved: () => void }) {
  const t = useT('tickets');
  const [e, setE] = useState<Ev>(ev);
  const setType = (i: number, p: Partial<TType>) => setE({ ...e, types: e.types.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const save = async () => {
    const body = {
      name: e.name,
      starts_at: fromLocal(e.starts_at),
      ends_at: fromLocal(e.ends_at),
      venue: e.venue,
      description: e.description,
      currency: e.currency,
      tax_rate: e.tax_rate === '' ? null : Number(e.tax_rate.replace(',', '.')),
      active: e.active,
      ...(e.slug && e.slug !== ev.slug ? { slug: e.slug } : {}),
      types: e.types.map((x) => ({
        ...(x.id ? { id: x.id } : {}),
        name: x.name,
        description: x.description,
        price_cents: cents(x.price),
        quota: x.quota === '' ? null : Number(x.quota),
        sale_start: fromLocal(x.sale_start),
        sale_end: fromLocal(x.sale_end),
        max_per_order: x.max_per_order === '' ? null : Number(x.max_per_order),
        active: x.active,
      })),
    };
    const r = await act(() => (e.id ? api.patch(`/api/ticket-events/${e.id}`, body) : api.post('/api/ticket-events', body)), t('Gespeichert'));
    if (r) onSaved();
  };
  return (
    <Modal
      title={e.id ? t('Event bearbeiten') : t('Neues Event')}
      onClose={onClose}
      wide
      footer={
        <button className="btn" onClick={save} disabled={!e.name.trim() || !e.starts_at}>
          {t('Speichern')}
        </button>
      }
    >
      <Field label={t('Name')}>
        <Input value={e.name} onChange={(x) => setE({ ...e, name: x })} placeholder={t('z. B. Sommerfest 2027')} />
      </Field>
      <div className="grid2">
        <Field label={t('Beginn')}>
          <Input type="datetime-local" value={e.starts_at} onChange={(x) => setE({ ...e, starts_at: x })} />
        </Field>
        <Field label={t('Ort')}>
          <Input value={e.venue} onChange={(x) => setE({ ...e, venue: x })} />
        </Field>
      </div>
      <MoreFields id="ticket-event-more" values={[e.description, e.ends_at, e.currency !== 'EUR' ? e.currency : '', e.tax_rate, e.active ? '' : 'x']}>
        <Field label={t('Beschreibung')}>
          <Textarea value={e.description} onChange={(x) => setE({ ...e, description: x })} rows={3} />
        </Field>
        <div className="grid2">
          <Field label={t('Ende')}>
            <Input type="datetime-local" value={e.ends_at} onChange={(x) => setE({ ...e, ends_at: x })} />
          </Field>
          <Field label={t('Währung')}>
            <Select value={e.currency} onChange={(x) => setE({ ...e, currency: x })} options={['EUR', 'CHF', 'USD', 'GBP']} />
          </Field>
          <Field label={t('Steuersatz in %')} hint={t('Leer = Standard der Rechnungen')}>
            <Input value={e.tax_rate} inputMode="decimal" onChange={(x) => setE({ ...e, tax_rate: x })} />
          </Field>
          <Field label={t('Kurzname im Link')} hint={t('Leer = aus dem Namen')}>
            <Input value={e.slug} onChange={(x) => setE({ ...e, slug: x })} />
          </Field>
        </div>
        <Check checked={e.active} onChange={(x) => setE({ ...e, active: x })} label={t('Tickets öffentlich verkaufen')} />
      </MoreFields>
      <h3>{t('Ticketarten')}</h3>
      {e.types.map((x, i) => (
        <fieldset key={x.id ?? `new-${i}`} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <legend className="muted">{x.name || t('Ticketart {n}', { n: i + 1 })}</legend>
          <div className="grid2">
            <Field label={t('Name der Ticketart')}>
              <Input value={x.name} onChange={(v) => setType(i, { name: v })} placeholder={t('z. B. Stehplatz, VIP')} />
            </Field>
            <Field label={t('Preis ({cur}, brutto)', { cur: e.currency })} hint={t('Leer oder 0 = kostenlos')}>
              <Input value={x.price} inputMode="decimal" onChange={(v) => setType(i, { price: v })} placeholder="0,00" />
            </Field>
            <Field label={t('Kontingent')} hint={t('Leer = unbegrenzt')}>
              <Input type="number" min={0} value={x.quota} onChange={(v) => setType(i, { quota: v })} />
            </Field>
          </div>
          <MoreFields id="ticket-type-more" values={[x.sale_start, x.sale_end, x.max_per_order, x.description, x.active ? '' : 'x']}>
            <div className="grid2">
              <Field label={t('Verkaufsstart')}>
                <Input type="datetime-local" value={x.sale_start} onChange={(v) => setType(i, { sale_start: v })} />
              </Field>
              <Field label={t('Verkaufsende')} hint={t('Leer = bis zum Beginn')}>
                <Input type="datetime-local" value={x.sale_end} onChange={(v) => setType(i, { sale_end: v })} />
              </Field>
              <Field label={t('Höchstens je Bestellung')} hint={t('Leer = 10')}>
                <Input type="number" min={1} max={20} value={x.max_per_order} onChange={(v) => setType(i, { max_per_order: v })} />
              </Field>
              <Field label={t('Beschreibung der Ticketart')}>
                <Input value={x.description} onChange={(v) => setType(i, { description: v })} />
              </Field>
            </div>
            <Check checked={x.active} onChange={(v) => setType(i, { active: v })} label={t('Im Verkauf')} />
          </MoreFields>
          {e.types.length > 1 && (
            <button className="btn small ghost" onClick={() => setE({ ...e, types: e.types.filter((_, j) => j !== i) })}>
              {t('Ticketart entfernen')}
            </button>
          )}
        </fieldset>
      ))}
      <button className="btn small secondary" disabled={e.types.length >= 20} onClick={() => setE({ ...e, types: [...e.types, blankType()] })}>
        + {t('Ticketart')}
      </button>
    </Modal>
  );
}
