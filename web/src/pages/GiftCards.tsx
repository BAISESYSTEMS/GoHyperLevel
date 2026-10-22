import { useState } from 'react';
import { api, dt, money } from '../api';
import { useT, type TFn } from '../i18n';
import { Badge, Check, Empty, Field, Input, Modal, PageHead, Select, Spinner, Stat, Textarea, act, confirmAsk, useLoad } from '../ui';
import { Slot } from '../slots';
import { parseCents } from './Shop';
import './shop.css';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Gutscheine (docs/store.md#gift-cards): cards with a code and a balance ledger – issue by hand (and mail the code), look up a code,
 * redeem at the counter, correct a balance, switch a card off. Sold cards come from the online store. Redeemed in the store checkout,
 * on invoices and in booking payments.
 */

const TONE: Record<string, 'gray' | 'green' | 'red' | 'yellow'> = { active: 'green', used: 'gray', expired: 'yellow', disabled: 'red' };
const stateLabel = (t: TFn, s: string) => ({ active: t('Aktiv'), used: t('Aufgebraucht'), expired: t('Abgelaufen'), disabled: t('Gesperrt') })[s] ?? s;
const kindLabel = (t: TFn, k: string) => ({ issue: t('Ausgegeben'), redeem: t('Eingelöst'), refund: t('Zurückgebucht'), adjust: t('Korrektur') })[k] ?? k;
const sourceLabel = (t: TFn, s: string) => ({ manual: t('von Hand'), store: t('Online-Shop') })[s] ?? s;

function NewCard({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useT('store');
  const [f, setF] = useState({ amount: '50,00', recipient_name: '', recipient_email: '', message: '', expires_at: '', note: '', send: true });
  const set = (k: keyof typeof f) => (v: string | boolean) => setF({ ...f, [k]: v });
  const cents = parseCents(f.amount);
  const save = async () => {
    const r = await act(() => api.post('/api/gift-cards', { amount_cents: cents, recipient_name: f.recipient_name, recipient_email: f.recipient_email, message: f.message, expires_at: f.expires_at || null, note: f.note, send: f.send && !!f.recipient_email }), t('Gutschein ausgestellt'));
    if (r) onSaved();
  };
  return (
    <Modal title={t('Gutschein ausstellen')} onClose={onClose} footer={<button className="btn" onClick={save} disabled={!cents || cents < 100}>{t('Ausstellen')}</button>}>
      <div className="row">
        <Field label={t('Betrag (€)')}>
          <Input value={f.amount} onChange={set('amount')} inputMode="decimal" autoFocus />
        </Field>
        <Field label={t('Gültig bis (optional)')}>
          <Input type="date" value={f.expires_at} onChange={set('expires_at')} />
        </Field>
      </div>
      <div className="row">
        <Field label={t('Für (Name)')}>
          <Input value={f.recipient_name} onChange={set('recipient_name')} />
        </Field>
        <Field label={t('E-Mail der beschenkten Person')}>
          <Input type="email" value={f.recipient_email} onChange={set('recipient_email')} />
        </Field>
      </div>
      <Field label={t('Nachricht (steht in der E-Mail)')}>
        <Textarea value={f.message} onChange={set('message')} rows={2} />
      </Field>
      <Field label={t('Interne Notiz')}>
        <Input value={f.note} onChange={set('note')} />
      </Field>
      <Check checked={f.send && !!f.recipient_email} onChange={set('send')} label={t('Code per E-Mail schicken')} />
      <p className="muted small">{t('Gutscheine gelten als Mehrzweck-Gutscheine: Die Umsatzsteuer entsteht erst beim Einlösen (§ 3 Abs. 15 UStG).')}</p>
    </Modal>
  );
}

function CardModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useT('store');
  const c = useLoad(() => api.get<any>(`/api/gift-cards/${id}`), [id]);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [sign, setSign] = useState('-');
  const d = c.data;
  const done = () => (c.reload(), onChanged());
  const adjust = async () => {
    const cents = parseCents(amount);
    if (!cents) return;
    if (await act(() => api.post(`/api/gift-cards/${id}/adjust`, { amount_cents: sign === '-' ? -cents : cents, note }), t('Guthaben korrigiert'))) {
      setAmount('');
      setNote('');
      done();
    }
  };
  return (
    <Modal title={d ? d.code : t('Gutschein')} onClose={onClose} wide>
      {!d ? (
        <Spinner />
      ) : (
        <>
          <p>
            <Badge tone={TONE[d.state]}>{stateLabel(t, d.state)}</Badge> <strong>{money(d.balance_cents, d.currency)}</strong> <span className="muted">{t('von {amount}', { amount: money(d.initial_cents, d.currency) })}</span>
            {d.available_cents < d.balance_cents && <span className="muted small"> · {t('{amount} in laufenden Zahlungen reserviert', { amount: money(d.balance_cents - d.available_cents, d.currency) })}</span>}
          </p>
          <p className="muted small">
            {sourceLabel(t, d.source)} · {dt(d.created_at)}
            {d.expires_at ? ` · ${t('gültig bis {date}', { date: new Date(d.expires_at).toLocaleDateString() })}` : ` · ${t('ohne Ablauf')}`}
            {d.contact_name ? ` · ${d.contact_name}` : ''}
            {d.recipient_email ? ` · ${t('für {who}', { who: d.recipient_name || d.recipient_email })}` : ''}
          </p>
          <table className="t">
            <thead>
              <tr>
                <th>{t('Datum')}</th>
                <th>{t('Buchung')}</th>
                <th>{t('Bezug')}</th>
                <th className="num">{t('Betrag')}</th>
              </tr>
            </thead>
            <tbody>
              {d.ledger.map((l: any) => (
                <tr key={l.id}>
                  <td>{dt(l.created_at)}</td>
                  <td>{kindLabel(t, l.kind)}</td>
                  <td className="muted small">{l.note || l.ref_type}</td>
                  <td className="num">{money(l.amount_cents, d.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <section className="card">
            <h4>{t('Guthaben korrigieren')}</h4>
            <div className="row">
              <Field label={t('Richtung')}>
                <Select value={sign} onChange={setSign} options={[['-', t('abziehen')], ['+', t('aufladen')]]} />
              </Field>
              <Field label={t('Betrag (€)')}>
                <Input value={amount} onChange={setAmount} inputMode="decimal" />
              </Field>
              <Field label={t('Grund')}>
                <Input value={note} onChange={setNote} placeholder={t('z. B. im Laden eingelöst')} />
              </Field>
            </div>
            <button className="btn secondary" onClick={adjust} disabled={!parseCents(amount) || !note.trim()}>
              {t('Buchen')}
            </button>
          </section>
          <div className="row shop-actions">
            <button className="btn secondary" onClick={() => act(() => api.post(`/api/gift-cards/${id}/send`, {}), t('E-Mail gesendet'))}>
              {t('Code erneut schicken')}
            </button>
            {d.status === 'active' ? (
              <button className="btn danger" onClick={async () => confirmAsk(t('Gutschein sperren? Er lässt sich dann nicht mehr einlösen.')) && (await act(() => api.patch(`/api/gift-cards/${id}`, { status: 'disabled' }), t('Gesperrt'))) && done()}>
                {t('Sperren')}
              </button>
            ) : (
              <button className="btn secondary" onClick={async () => (await act(() => api.patch(`/api/gift-cards/${id}`, { status: 'active' }), t('Entsperrt'))) && done()}>
                {t('Entsperren')}
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

export function GiftCards() {
  const t = useT('store');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState('');
  const [adding, setAdding] = useState(false);
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}) }).toString();
  const list = useLoad(() => api.get<any>(`/api/gift-cards${qs ? `?${qs}` : ''}`), [qs]);
  return (
    <div className="shop">
      <PageHead title={t('Gutscheine')} sub={t('Gutscheine mit Code und Guthaben – einlösbar im Online-Shop, auf Rechnungen und bei Terminbuchungen.')}>
        <button className="btn" onClick={() => setAdding(true)}>
          {t('Gutschein ausstellen')}
        </button>
      </PageHead>
      {list.data && (
        <SortableGrid id="gift-cards.stats" className="shop-stats">
          <Stat label={t('Gutscheine')} value={list.data.count} />
          <Stat label={t('Offenes Guthaben')} value={money(list.data.outstanding_cents)} sub={t('noch nicht eingelöst – in der Bilanz eine Verbindlichkeit')} />
        </SortableGrid>
      )}
      <div className="row shop-filter">
        <Select value={status} onChange={setStatus} aria={t('Filter')} options={[['', t('Alle')], ['active', t('Aktiv')], ['used', t('Aufgebraucht')], ['disabled', t('Gesperrt')]]} />
        <div className="grow">
          <Input value={q} onChange={setQ} placeholder={t('Suchen: Code, Name, E-Mail')} aria-label={t('Gutscheine suchen')} />
        </div>
      </div>
      {!list.data ? (
        <Spinner />
      ) : !list.data.cards.length ? (
        <Empty>{t('Noch keine Gutscheine. Stelle einen von Hand aus oder verkaufe Gutscheine im Online-Shop (Produktart „Gutschein“).')}</Empty>
      ) : (
        <div className="card shop-scroll">
          <table className="t">
            <thead>
              <tr>
                <th>{t('Code')}</th>
                <th>{t('Status')}</th>
                <th className="num">{t('Guthaben')}</th>
                <th className="num">{t('Wert')}</th>
                <th>{t('Für')}</th>
                <th>{t('Gültig bis')}</th>
                <th>{t('Herkunft')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.cards.map((c: any) => (
                <tr key={c.id} className="click" tabIndex={0} onClick={() => setOpen(c.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(c.id)}>
                  <td className="strong shop-code">{c.code}</td>
                  <td>
                    <Badge tone={TONE[c.state]}>{stateLabel(t, c.state)}</Badge>
                  </td>
                  <td className="num">{money(c.balance_cents, c.currency)}</td>
                  <td className="num">{money(c.initial_cents, c.currency)}</td>
                  <td>{c.recipient_name || c.contact_name || c.recipient_email || '–'}</td>
                  <td>{c.expires_at ? new Date(c.expires_at).toLocaleDateString() : '–'}</td>
                  <td className="small">{sourceLabel(t, c.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Slot name="giftcards.panel" />
      {adding && <NewCard onClose={() => setAdding(false)} onSaved={() => (setAdding(false), list.reload())} />}
      {open && <CardModal id={open} onClose={() => setOpen('')} onChanged={list.reload} />}
    </div>
  );
}
