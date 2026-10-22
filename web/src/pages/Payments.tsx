import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { ShareButton } from '../ios/ShareButton';
import { api, d, money, moneyList, name } from '../api';
import { sumByCurrency } from '../format';
import { act, Badge, Check, CodeBox, confirmAsk, Empty, Field, Input, Link, Modal, navigate, PageHead, pressable, Select, Spinner, Tabs, Textarea, useLoad } from '../ui';
import { MoreFields } from '../areas/fields';
import { ProductBuyLink, StripeInvoiceBox, StripePaidBadge, StripeStatusBadge, useProductLinks, useStripePayments } from './Stripe';
import { fmtNumber, useT } from '../i18n';
import { AuditBox, CreditNoteModal, DocsBox, FinaliseModal, LegalFields, LockBar, PaymentModal, PaymentsBox, StateBadge, StornoModal, TYPE_LABEL, fromCents, numberLabel, toCents, useInvoiceSettings } from './InvoiceLegal';

/** The persisted status of a row that only carries it (children of a subscription template). */
const STATUS: Record<string, [string, any]> = { draft: ['Entwurf', 'gray'], sent: ['offen', 'yellow'], paid: ['bezahlt', 'green'], void: ['storniert', 'red'], accepted: ['angenommen', 'green'] };
/** The server's document titles (Rechnung, Gutschrift …) are German message ids of the invoices catalog too. */

const isOpen = (i: any) => i.state === 'open' || i.state === 'partially_paid';
/** 19 → "19", 7.5 → "7,5" (German) / "7.5" (English). */
const fmtRate = (n: number) => fmtNumber(Number(n) || 0, { maximumFractionDigits: 2 });

export function Invoices() {
  const t = useT('invoices');
  const [kind, setKind] = useState('invoice');
  const list = useLoad(() => (kind === 'subscriptions' ? Promise.resolve([]) : api.get<any[]>(`/api/invoices?kind=${kind}`)), [kind]);
  // Where each invoice lives in the books (Norman, Lexware …), filled in via MCP.
  const links = useLoad(() => api.get<any[]>('/api/invoice-links').catch(() => []), []);
  const linkOf = Object.fromEntries((links.data ?? []).map((l) => [l.invoice_id, l]));
  const stripePaid = useStripePayments();
  const rows = list.data ?? [];
  // per currency – 100 € and 100 $ are not 200 € (no exchange rates); a paid final invoice counts without its deducted partial invoices
  const openSum = moneyList(sumByCurrency(rows.filter(isOpen), (i) => i.open_cents));
  const paidSum = moneyList(sumByCurrency(rows.filter((i) => i.state === 'paid'), (i) => i.total_cents - (i.deducted_cents ?? 0)));
  return (
    <>
      <PageHead title={t('Rechnungen & Angebote')} sub={kind === 'invoice' ? t('Offen: {open} · Bezahlt: {paid}', { open: openSum, paid: paidSum }) : undefined}>
        <StripeStatusBadge />
        {(kind === 'invoice' || kind === 'estimate') && (
          <button
            className="btn"
            data-tour="invoices-new"
            onClick={async () => {
              const r = await act(() => api.post<any>('/api/invoices', { kind: kind === 'estimate' ? 'estimate' : 'invoice', items: [{ name: t('Leistung'), qty: 1, price_cents: 0 }] }));
              if (r) navigate(`invoices/${r.id}`);
            }}
          >
            + {kind === 'estimate' ? t('Angebot') : t('Rechnung')}
          </button>
        )}
      </PageHead>
      <Tabs tabs={[['invoice', t('Rechnungen')], ['credit_note', t('Gutschriften')], ['estimate', t('Angebote')], ['subscriptions', t('Abos')]]} value={kind} onChange={setKind} />
      {kind === 'subscriptions' ? (
        <Subscriptions />
      ) : list.loading && !list.data ? (
        <Spinner />
      ) : rows.length ? (
        <div className="table-wrap" data-tour="invoices-list">
          <table className="t">
            <thead>
              <tr>
                <th>{t('Nr.')}</th>
                <th>{t('Kunde')}</th>
                <th>{t('Betrag')}</th>
                <th>{t('Status')}</th>
                <th>{t('Datum')}</th>
                <th>{t('Fällig')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className="click" {...pressable(() => navigate(`invoices/${i.id}`))}>
                  <td>
                    <strong>{numberLabel(i)}</strong>
                    <div className="muted small">
                      {i.doc_title !== 'Rechnung' && i.doc_title !== 'Angebot' ? `${t(i.doc_title)}${i.title ? ' · ' : ''}` : ''}
                      {i.title}
                    </div>
                    {linkOf[i.id] && (
                      <div className="small" title={t('synchronisiert {date}', { date: d(linkOf[i.id].synced_at) })}>
                        <Badge tone="blue">
                          {linkOf[i.id].provider === 'norman' ? 'Norman' : linkOf[i.id].provider === 'lexware' ? 'Lexware' : linkOf[i.id].provider === 'sevdesk' ? 'sevDesk' : t('Buchhaltung')} {linkOf[i.id].number}
                        </Badge>
                      </div>
                    )}
                  </td>
                  <td>{i.contact_id ? name(i) : '–'}</td>
                  <td>
                    {money(i.total_cents, i.currency)}
                    {i.state === 'partially_paid' && <div className="muted small">{t('offen {amount}', { amount: money(i.open_cents, i.currency) })}</div>}
                  </td>
                  <td>
                    <StateBadge i={i} />
                    {/* calendar days in the sub-account's zone (server): the due day itself is not overdue yet */}
                    {i.days_overdue > 0 && <Badge tone="red">{t('überfällig')}</Badge>}
                    {i.recurring?.active && <Badge tone="purple">{t('Abo')}</Badge>}
                    <StripePaidBadge p={stripePaid[i.id]} />
                  </td>
                  <td className="muted">{d(i.issued_at)}</td>
                  <td className="muted">{i.kind === 'invoice' ? d(i.due_at) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>
          {kind === 'credit_note'
            ? t('Noch keine Gutschriften. Eine Gutschrift oder Stornorechnung entsteht aus einer festgeschriebenen Rechnung (Buttons „Gutschrift“ und „Stornieren“).')
            : kind === 'invoice'
              ? t('Noch keine Rechnungen.')
              : t('Noch keine Angebote.')}
        </Empty>
      )}
    </>
  );
}

/** `qty × price` in cents like the server (services/invoice-model.ts lineNet): integer maths, half away from zero – 1,15 × 29,90 is 34,39, not 34,38. */
const lineCents = (x: { qty: unknown; price_cents: unknown }): number => {
  const prod = Math.round(Number(x.qty) * 10000) * Math.round(Number(x.price_cents) || 0);
  return Math.sign(prod) * Math.floor((Math.abs(prod) + 5000) / 10000);
};
/** `net × rate %` in cents like the server's taxOf. */
const taxCents = (net: number, rate: number) => Math.sign(net) * Math.floor((Math.abs(net) * Math.round(rate * 100) + 5000) / 10000);

/** Net, VAT per rate and total for the screen. Rounded once per VAT rate (EN 16931); the server's numbers win after saving. */
function calc(items: any[], mode: string, how: string) {
  const net = lineCents;
  const groups = new Map<number, number>();
  for (const x of items) groups.set(mode === 'standard' ? Number(x.tax_rate) || 0 : 0, (groups.get(mode === 'standard' ? Number(x.tax_rate) || 0 : 0) ?? 0) + net(x));
  const sub = items.reduce((a, x) => a + net(x), 0);
  const tax =
    how === 'line' && mode === 'standard'
      ? items.reduce((a, x) => a + taxCents(net(x), Number(x.tax_rate) || 0), 0)
      : [...groups].reduce((a, [rate, n]) => a + taxCents(n, rate), 0);
  return { sub, tax, total: sub + tax, groups: [...groups].map(([rate, n]) => ({ rate, net: n, tax: taxCents(n, rate) })) };
}

/** One editor per document: moving on to another one (a credit note, a Storno, a converted quote) starts with fresh state, dialogs closed. */
export function InvoiceEditor({ id }: { id: string }) {
  return <InvoiceEditorFor key={id} id={id} />;
}

function InvoiceEditorFor({ id }: { id: string }) {
  const t = useT('invoices');
  const inv = useLoad(() => api.get<any>(`/api/invoices/${id}`), [id]);
  const cfg = useInvoiceSettings();
  const products = useLoad(() => api.get<any[]>('/api/products'), []);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [contact, setContact] = useState<any>();
  const [modal, setModal] = useState<'finalise' | 'send' | 'storno' | 'credit' | 'pay' | 'convert' | null>(null);
  const i = inv.data;
  useEffect(() => {
    if (i?.contact_id) api.get(`/api/contacts/${i.contact_id}`).then(setContact).catch(() => {});
  }, [i?.contact_id]);
  useEffect(() => {
    if (q.length < 2) return setFound([]);
    const timer = setTimeout(() => api.get(`/api/contacts?q=${encodeURIComponent(q)}&limit=6`).then((r) => setFound(r.contacts)), 200);
    return () => clearTimeout(timer);
  }, [q]);
  if (!i) return <Spinner />;

  const isQuote = i.kind === 'estimate';
  const isCredit = i.kind === 'credit_note';
  const sign = isCredit ? -1 : 1;
  // Content is frozen once the invoice is final (and when a quote was accepted or turned into an invoice, or a draft was discarded);
  // note, due date and payment link stay editable until the invoice is paid or cancelled.
  const frozen = !!i.locked || i.status === 'void' || (isQuote && (i.status === 'accepted' || (i.converted ?? []).length > 0));
  const metaLocked = i.status === 'paid' || i.status === 'void';
  const set = (patch: any) => inv.setData({ ...i, ...patch });
  const setItem = (n: number, patch: any) => set({ items: i.items.map((x: any, j: number) => (j === n ? { ...x, ...patch } : x)) });
  const mode = i.tax_mode ?? 'standard';
  const tot = calc(i.items, mode, i.calc ?? 'group');
  const draft = i.status === 'draft';
  const open = isOpen(i);
  const canMail = !!i.contact_id;

  const save = async () => {
    const meta = { notes: i.notes, due_at: i.due_at, payment_link: i.payment_link ?? '' };
    const body = frozen
      ? meta
      : {
          items: i.items,
          title: i.title,
          contact_id: i.contact_id,
          ...meta,
          ...(i.kind === 'invoice' ? { inv_type: i.inv_type, deduct_ids: i.deduct_ids, skonto_percent: i.skonto_percent ?? null, skonto_days: i.skonto_days ?? null } : {}),
          supply_from: i.supply_from || '',
          supply_to: i.supply_to || '',
          tax_mode: mode,
          tax_note: i.tax_note ?? '',
          buyer_vat_id: i.buyer_vat_id ?? '',
          leitweg_id: i.leitweg_id ?? '',
          buyer_ref: i.buyer_ref ?? '',
        };
    if (metaLocked) return i;
    const r = await act(() => api.patch<any>(`/api/invoices/${id}`, isCredit && !frozen ? { ...body, due_at: undefined } : body), t('Gespeichert'));
    if (r) await inv.reload();
    return r;
  };
  const done = async () => {
    setModal(null);
    await inv.reload();
  };
  const sendDirect = async () => (await save()) && act(() => api.post(`/api/invoices/${id}/send`), t('Per E-Mail gesendet')).then(() => inv.reload());
  const setStatus = (status: string, ok: string) => act(() => api.patch(`/api/invoices/${id}`, { status }), ok).then((r) => r && inv.reload());

  return (
    <>
      <PageHead title={`${t(i.doc_title)} ${i.number}`.trim()} sub={<StateBadge i={i} />}>
        <Link to="invoices" className="btn secondary">
          ← {t('Übersicht')}
        </Link>
        {!metaLocked && (
          <button className="btn secondary" onClick={save}>
            {t('Speichern')}
          </button>
        )}
        {!draft && (
          <a className="btn secondary" href={i.url} target="_blank" rel="noreferrer">
            {t('Ansehen')} ↗
          </a>
        )}
        {!draft && i.url && <ShareButton url={i.url} title={`${isQuote ? t('Angebot') : t('Rechnung')} ${i.number}`} />}
        {draft && !isQuote && (
          <button className="btn secondary" data-tour="invoice-finalise" onClick={async () => (await save()) && setModal('finalise')}>
            <Icon name="lock" /> {t('Festschreiben')}
          </button>
        )}
        {draft && canMail && (
          <button className="btn" data-tour="invoice-send" onClick={async () => (isQuote ? sendDirect() : (await save()) && setModal('send'))}>
            <Icon name="send" /> {t('Senden')}
          </button>
        )}
        {!isQuote && open && !isCredit && (
          <button className="btn" data-tour="invoice-pay" onClick={() => setModal('pay')}>
            ✓ {t('Zahlung erfassen')}
          </button>
        )}
        {!draft && canMail && i.status !== 'void' && !isQuote && (
          <button className="btn secondary" onClick={sendDirect}>
            {t('Erneut senden')}
          </button>
        )}
        {isQuote && i.status === 'sent' && (
          <button className="btn secondary" onClick={() => setStatus('accepted', t('Als angenommen markiert'))}>
            {t('Angenommen')}
          </button>
        )}
        {isQuote && (i.status === 'sent' || i.status === 'accepted') && (
          <button className="btn" onClick={() => setModal('convert')}>
            {t('In Rechnung umwandeln')}
          </button>
        )}
        {i.kind === 'invoice' && i.locked && i.status !== 'void' && (
          <>
            <button className="btn secondary" data-tour="invoice-credit" onClick={() => setModal('credit')}>
              {t('Gutschrift')}
            </button>
            <button className="btn ghost" data-tour="invoice-storno" onClick={() => setModal('storno')}>
              {t('Stornieren')}
            </button>
          </>
        )}
        {draft && (
          <button className="btn danger" onClick={async () => confirmAsk(isQuote ? t('Angebot löschen?') : t('Entwurf löschen?')) && (await act(() => api.del(`/api/invoices/${id}`))) && navigate('invoices')}>
            {t('Löschen')}
          </button>
        )}
        {isQuote && i.status === 'sent' && (
          <button className="btn ghost" onClick={() => confirmAsk(t('Angebot verwerfen?')) && setStatus('void', t('Angebot verworfen'))}>
            {t('Verwerfen')}
          </button>
        )}
      </PageHead>

      <LockBar inv={i} />
      {draft && i.ref && (
        <div className="card notice-card">
          {t('{title} zu', { title: t(i.doc_title) })} <Link to={`invoices/${i.ref.id}`}>{i.ref.number}</Link> – {t('Beträge werden als Abzug (negativ) gebucht.')}
        </div>
      )}

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '2 1 520px', minWidth: 0 }}>
          <div className="card">
            <Field label={t('Kunde')} tour="invoice-customer">
              {contact && i.contact_id ? (
                <div>
                  <Link to={`contacts/${contact.id}`}>{contact.name}</Link> <span className="muted">{contact.email}</span>{' '}
                  {!frozen && (
                    <a href="#" onClick={(e) => (e.preventDefault(), set({ contact_id: null }), setContact(undefined))}>
                      {t('ändern')}
                    </a>
                  )}
                </div>
              ) : (
                <>
                  <Input value={q} onChange={setQ} placeholder={t('Kontakt suchen…')} aria-label={t('Kontakt suchen…')} disabled={frozen} />
                  {found.map((c) => (
                    <a key={c.id} href="#" style={{ display: 'block' }} onClick={(e) => (e.preventDefault(), set({ contact_id: c.id }), setQ(''))}>
                      {name(c)} <span className="muted">{c.email}</span>
                    </a>
                  ))}
                </>
              )}
            </Field>
            <Field label={t('Betreff / Titel')} tour="invoice-title">
              <Input value={i.title} onChange={(v) => set({ title: v })} disabled={frozen} placeholder={t('z. B. Website-Relaunch')} />
            </Field>
            <div className="table-wrap">
              <table className="t" data-tour="invoice-items">
                <thead>
                  <tr>
                    <th>{t('Position')}</th>
                    <th style={{ width: 80 }}>{t('Menge')}</th>
                    <th style={{ width: 96 }}>{t('Einheit')}</th>
                    <th style={{ width: 110 }}>{t('Preis (€)')}</th>
                    {mode === 'standard' && <th style={{ width: 84 }}>{t('USt %')}</th>}
                    <th style={{ width: 110, textAlign: 'right' }}>{t('Summe')}</th>
                    <th style={{ width: 30 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {i.items.map((x: any, n: number) => (
                    <tr key={n}>
                      <td>
                        <Input value={x.name} onChange={(v) => setItem(n, { name: v })} disabled={frozen} aria-label={t('Position')} />
                        <Input value={x.description} onChange={(v) => setItem(n, { description: v })} disabled={frozen} placeholder={t('Beschreibung')} aria-label={t('Beschreibung')} style={{ marginTop: 4, fontSize: 12 }} />
                      </td>
                      <td>
                        <Input type="number" value={Math.abs(x.qty)} onChange={(v) => setItem(n, { qty: sign * Math.abs(Number(v)) })} disabled={frozen} aria-label={t('Menge')} />
                      </td>
                      <td>
                        <Select value={x.unit ?? 'C62'} onChange={(v) => setItem(n, { unit: v })} aria={t('Einheit')} options={(cfg.data?.units ?? [{ code: 'C62', label: 'Stk.' }]).map((u: any) => [u.code, t(u.label)] as [string, string])} />
                      </td>
                      <td>
                        <PriceInput cents={x.price_cents} onChange={(c) => setItem(n, { price_cents: c })} disabled={frozen} />
                      </td>
                      {mode === 'standard' && (
                        <td>
                          <Input type="number" value={x.tax_rate} onChange={(v) => setItem(n, { tax_rate: Number(v) })} disabled={frozen} aria-label={t('USt %')} />
                        </td>
                      )}
                      <td style={{ textAlign: 'right' }}>{money(lineCents(x), i.currency)}</td>
                      <td>
                        {!frozen && i.items.length > 1 && (
                          <button className="icon-btn" onClick={() => set({ items: i.items.filter((_: any, j: number) => j !== n) })} aria-label={t('Position entfernen')}>
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!frozen && (
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn small secondary" onClick={() => set({ items: [...i.items, { name: '', qty: sign, price_cents: 0, tax_rate: mode === 'standard' ? (i.items[0]?.tax_rate ?? 19) : 0 }] })}>
                  + {t('Position')}
                </button>
                {(products.data ?? []).length > 0 && (
                  <div style={{ width: 240 }}>
                    <Select
                      value=""
                      placeholder={`+ ${t('Produkt einfügen…')}`}
                      options={products.data!.map((p) => [p.id, `${p.name} (${money(p.price_cents)})`])}
                      onChange={(v) => {
                        const p = products.data!.find((x) => x.id === v);
                        if (p) set({ items: [...i.items, { name: p.name, description: p.description, qty: sign, price_cents: p.price_cents, tax_rate: mode === 'standard' ? (p.tax_rate ?? i.items[0]?.tax_rate ?? 19) : 0 }], payment_link: i.payment_link || p.payment_link });
                      }}
                    />
                  </div>
                )}
              </div>
            )}
            <table className="totals" style={{ marginLeft: 'auto', marginTop: 12, minWidth: 260 }}>
              <tbody>
                <tr>
                  <td>{mode === 'standard' ? t('Netto') : t('Summe')}</td>
                  <td style={{ textAlign: 'right' }}>{money(tot.sub, i.currency)}</td>
                </tr>
                {mode === 'standard' &&
                  tot.groups
                    .filter((g) => g.rate > 0 || g.tax !== 0)
                    .map((g) => (
                      <tr key={g.rate}>
                        <td>{t('USt. {rate} %', { rate: fmtRate(g.rate) })}</td>
                        <td style={{ textAlign: 'right' }}>{money(g.tax, i.currency)}</td>
                      </tr>
                    ))}
                <tr>
                  <td>
                    <strong>{t('Gesamt')}</strong>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <strong>{money(tot.total, i.currency)}</strong>
                  </td>
                </tr>
                {i.deducted_cents > 0 && (
                  <tr>
                    <td>{t('abzgl. Abschläge')}</td>
                    <td style={{ textAlign: 'right' }}>{money(-i.deducted_cents, i.currency)}</td>
                  </tr>
                )}
                {i.deducted_cents > 0 && (
                  <tr>
                    <td>
                      <strong>{t('Noch zu zahlen')}</strong>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <strong>{money(tot.total - i.deducted_cents, i.currency)}</strong>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {!isQuote && cfg.data && <LegalFields inv={i} set={set} frozen={frozen} settings={cfg.data} />}
          {(i.credit_notes ?? []).length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <h3 style={{ marginBottom: 8 }}>{t('Gutschriften und Stornos')}</h3>
              <table className="t">
                <tbody>
                  {i.credit_notes.map((c: any) => (
                    <tr key={c.id} className="click" {...pressable(() => navigate(`invoices/${c.id}`))}>
                      <td>
                        <strong>{c.number || t('Entwurf')}</strong> <span className="muted small">{c.credit_type === 'storno' ? t('Stornorechnung') : t('Gutschrift')}</span>
                      </td>
                      <td>{d(c.issued_at)}</td>
                      <td style={{ textAlign: 'right' }}>{money(c.total_cents, c.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(i.converted ?? []).length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <h3 style={{ marginBottom: 8 }}>{t('Aus diesem Angebot')}</h3>
              <table className="t">
                <tbody>
                  {i.converted.map((c: any) => (
                    <tr key={c.id} className="click" {...pressable(() => navigate(`invoices/${c.id}`))}>
                      <td>
                        <strong>{c.number || t('Entwurf')}</strong> <span className="muted small">{t(TYPE_LABEL[c.inv_type] ?? 'Rechnung')}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>{money(c.total_cents, c.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <div className="card" data-tour="invoice-side">
            {!isQuote && !isCredit && (
              <Field label={t('Fällig am')} hint={i.skonto ? t('Skonto: {percent} % bei Zahlung innerhalb von {days} Tagen', { percent: fmtRate(i.skonto.percent), days: i.skonto.days }) : undefined}>
                <Input type="date" value={i.due_at?.slice(0, 10)} onChange={(v) => set({ due_at: v ? new Date(v).toISOString() : null })} disabled={metaLocked} />
              </Field>
            )}
            <Field label={t('Hinweise auf dem Dokument')}>
              <Textarea value={i.notes} onChange={(v) => set({ notes: v })} disabled={metaLocked} />
            </Field>
            {!isCredit && (
              <Field label={t('Online-Zahlungslink (optional)')} hint={t('z. B. Stripe Payment Link oder PayPal.me – sonst Überweisung (IBAN in Einstellungen)')}>
                <Input value={i.payment_link} onChange={(v) => set({ payment_link: v })} disabled={metaLocked} />
              </Field>
            )}
            {!draft && (
              <Field label={t('Kunden-Link')}>
                <CodeBox text={i.url} />
              </Field>
            )}
            {i.paid_at && i.status === 'paid' && !isCredit && <p>{t('Bezahlt am {date}', { date: d(i.paid_at) })}</p>}
            <StripeInvoiceBox inv={i} />
            {i.kind === 'invoice' && !i.parent_id && i.status !== 'void' && <RecurringBox inv={i} onSaved={() => inv.reload()} />}
            {i.parent_id && (
              <p className="muted small">
                {t('Automatisch erzeugt aus dem Abo')} <Link to={`invoices/${i.parent_id}`}>{t('öffnen')}</Link>
              </p>
            )}
          </div>
          <PaymentsBox inv={i} onChanged={() => inv.reload()} />
          <DocsBox inv={i} />
          <AuditBox inv={i} />
        </div>
      </div>

      {modal === 'finalise' && <FinaliseModal inv={i} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'send' && <FinaliseModal send email={contact?.email} inv={i} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'storno' && (
        <StornoModal
          inv={i}
          onClose={() => setModal(null)}
          onDone={(r) => {
            setModal(null);
            navigate(`invoices/${r.storno.id}`);
          }}
        />
      )}
      {modal === 'credit' && <CreditNoteModal inv={i} onClose={() => setModal(null)} />}
      {modal === 'pay' && <PaymentModal inv={i} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'convert' && <ConvertModal inv={i} onClose={() => setModal(null)} />}
    </>
  );
}

function ConvertModal({ inv, onClose }: { inv: any; onClose: () => void }) {
  const t = useT('invoices');
  const [type, setType] = useState('standard');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const r = await act(() => api.post<any>(`/api/invoices/${inv.id}/convert`, { inv_type: type }), t('Rechnung als Entwurf angelegt'));
    setBusy(false);
    if (r) navigate(`invoices/${r.id}`);
  };
  return (
    <Modal
      title={t('Angebot {number} in Rechnung umwandeln', { number: inv.number })}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button className="btn" disabled={busy} onClick={go}>
            {t('Rechnung anlegen')}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>{t('Positionen, Kunde und Steuerbehandlung werden aus dem Angebot übernommen; die Rechnung verweist auf das Angebot. Du kannst sie noch bearbeiten, bevor du sie festschreibst. Ein Angebot lässt sich mehrfach umwandeln (z. B. Abschlag und Schluss).')}</p>
      <Field label={t('Art der Rechnung')}>
        <Select value={type} onChange={setType} options={[['standard', t('Rechnung')], ['partial', t('Abschlagsrechnung')], ['final', t('Schlussrechnung (zieht Abschläge ab)')]]} />
      </Field>
    </Modal>
  );
}

/** [interval, German label] – labels are message ids of the invoices catalog. */
const INTERVALS: [string, string][] = [
  ['week', 'wöchentlich'],
  ['month', 'monatlich'],
  ['quarter', 'vierteljährlich'],
  ['year', 'jährlich'],
];

function RecurringBox({ inv, onSaved }: { inv: any; onSaved: (r: any) => void }) {
  const t = useT('invoices');
  const r = inv.recurring;
  const intervalLabel = (k: string) => {
    const l = INTERVALS.find((x) => x[0] === k)?.[1];
    return l ? t(l) : k;
  };
  const [f, setF] = useState<any>(r ?? { interval: 'month', next_at: '', auto_send: true, end_at: '' });
  const save = async (next: any) => {
    const res = await act(() => api.patch(`/api/invoices/${inv.id}`, { recurring: next }), next ? t('Abo gespeichert') : t('Abo beendet'));
    if (res) onSaved(res);
  };
  return (
    <div className="card" style={{ background: 'var(--bg)', marginTop: 12 }} data-tour="invoice-recurring">
      <h3 style={{ marginBottom: 8 }}><Icon name="repeat" /> {t('Wiederkehrend (Abo)')}</h3>
      <p className="muted small" style={{ marginTop: 0 }}>{t('Diese Rechnung wird zur Vorlage: zum Termin entsteht automatisch eine neue Rechnung mit eigener Nummer.')}</p>
      <div className="grid2">
        <Field label={t('Intervall')}>
          <Select value={f.interval} onChange={(v) => setF({ ...f, interval: v })} options={INTERVALS.map(([k, l]) => [k, t(l)] as [string, string])} />
        </Field>
        <Field label={t('Nächste Rechnung am')}>
          <Input type="date" value={f.next_at?.slice(0, 10)} onChange={(v) => setF({ ...f, next_at: v ? new Date(v + 'T08:00:00').toISOString() : '' })} />
        </Field>
        <Field label={t('Endet am (optional)')}>
          <Input type="date" value={f.end_at?.slice(0, 10)} onChange={(v) => setF({ ...f, end_at: v ? new Date(v + 'T23:59:00').toISOString() : '' })} />
        </Field>
      </div>
      <Check checked={f.auto_send !== false} onChange={(v) => setF({ ...f, auto_send: v })} label={t('Automatisch per E-Mail an den Kunden senden')} />
      <div className="actions" style={{ marginTop: 8 }}>
        <button className="btn small" disabled={!f.next_at} onClick={() => save({ ...f, active: true })}>
          {r ? t('Abo speichern') : t('Abo starten')}
        </button>
        {r && (
          <button className="btn small ghost" onClick={() => confirmAsk(t('Abo beenden? Bisherige Rechnungen bleiben.')) && save(null)}>
            {t('Beenden')}
          </button>
        )}
      </div>
      {r && <p className="small">{r.active ? t('Nächste Rechnung: {date} ({interval})', { date: d(r.next_at), interval: intervalLabel(r.interval) }) : t('Abo beendet.')}</p>}
      {inv.children?.length > 0 && (
        <table className="t" style={{ marginTop: 8 }}>
          <tbody>
            {inv.children.map((c: any) => (
              <tr key={c.id}>
                <td>
                  <Link to={`invoices/${c.id}`}>{c.number}</Link>
                </td>
                <td>{d(c.issued_at)}</td>
                <td>{money(c.total_cents, c.currency)}</td>
                <td>
                  <Badge tone={STATUS[c.status]?.[1]}>{STATUS[c.status] ? t(STATUS[c.status][0]) : c.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Subscriptions() {
  const t = useT('invoices');
  const list = useLoad(() => api.get<any[]>('/api/subscriptions'), []);
  const factor: Record<string, number> = { week: 52 / 12, month: 1, quarter: 1 / 3, year: 1 / 12 };
  const mrr = sumByCurrency((list.data ?? []).filter((s) => s.recurring.active), (s) => s.total_cents * (factor[s.recurring.interval] ?? 1));
  return list.data?.length ? (
    <>
      <p>
        {t('Wiederkehrender Umsatz:')} <strong>{t('{amount} / Monat', { amount: moneyList(mrr) })}</strong>
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>{t('Kunde')}</th>
              <th>{t('Leistung')}</th>
              <th>{t('Betrag')}</th>
              <th>{t('Intervall')}</th>
              <th>{t('Nächste')}</th>
              <th>{t('Erzeugt')}</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((s) => (
              <tr key={s.id} className="click" {...pressable(() => navigate(`invoices/${s.id}`))}>
                <td>{s.company || name(s)}</td>
                <td>{s.title || s.number}</td>
                <td>{money(s.total_cents, s.currency)}</td>
                <td>{(() => {
                  const l = INTERVALS.find((x) => x[0] === s.recurring.interval)?.[1];
                  return l ? t(l) : s.recurring.interval;
                })()}</td>
                <td>{s.recurring.active ? d(s.recurring.next_at) : <Badge>{t('beendet')}</Badge>}</td>
                <td>{s.issued}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  ) : (
    <Empty>{t('Noch keine Abos. Öffne eine Rechnung und starte dort „Wiederkehrend“ – z. B. für Website-Wartung oder Hosting deiner Kunden.')}</Empty>
  );
}

function PriceInput({ cents, onChange, disabled }: { cents: number; onChange: (c: number) => void; disabled?: boolean }) {
  const t = useT('invoices');
  const [v, setV] = useState(fromCents(cents));
  useEffect(() => setV(fromCents(cents)), [cents]);
  return <input value={v} disabled={disabled} inputMode="decimal" aria-label={t('Preis (€)')} onChange={(e) => setV(e.target.value)} onBlur={() => onChange(toCents(v))} />;
}

export function Products() {
  const t = useT('invoices');
  const list = useLoad(() => api.get<any[]>('/api/products'), []);
  const buyLinks = useProductLinks();
  const [edit, setEdit] = useState<any>(null);
  const save = async () => {
    const body = { ...edit, price_cents: toCents(edit.price) };
    const r = await act(() => (edit.id ? api.patch(`/api/products/${edit.id}`, body) : api.post('/api/products', body)), t('Gespeichert'));
    if (r) {
      setEdit(null);
      list.reload();
    }
  };
  return (
    <>
      <PageHead title={t('Produkte')} sub={t('Leistungen und Preise für Rechnungen und Angebote')}>
        <button className="btn" data-tour="products-new" onClick={() => setEdit({ name: '', price: '', tax_rate: '' })}>
          + {t('Produkt')}
        </button>
      </PageHead>
      {(list.data ?? []).length ? (
        <div className="table-wrap" data-tour="products-list">
          <table className="t">
            <thead>
              <tr>
                <th>{t('Name')}</th>
                <th>{t('Preis')}</th>
                <th>{t('USt')}</th>
                <th>{t('Intervall')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.data!.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    <div className="muted small">{p.description}</div>
                  </td>
                  <td>{money(p.price_cents, p.currency)}</td>
                  <td>{p.tax_rate ?? t('Standard')}</td>
                  <td>{p.recurring === 'month' ? t('monatlich') : p.recurring === 'year' ? t('jährlich') : t('einmalig')}</td>
                  <td className="actions">
                    <ProductBuyLink product={p} links={buyLinks} />
                    <button className="btn small secondary" onClick={() => setEdit({ ...p, price: fromCents(p.price_cents), tax_rate: p.tax_rate ?? '' })}>
                      {t('Bearbeiten')}
                    </button>
                    <button className="btn small ghost" onClick={() => confirmAsk(t('Löschen?')) && act(() => api.del(`/api/products/${p.id}`)).then(list.reload)}>
                      {t('Löschen')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{t('Noch keine Produkte.')}</Empty>
      )}
      {edit && (
        <Modal title={t('Produkt')} onClose={() => setEdit(null)} footer={<button className="btn" onClick={save}>{t('Speichern')}</button>}>
          <Field label={t('Name')}>
            <Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} />
          </Field>
          <Field label={t('Beschreibung')}>
            <Textarea value={edit.description} onChange={(v) => setEdit({ ...edit, description: v })} />
          </Field>
          <div className="grid2">
            <Field label={t('Preis netto (€)')} tour="product-price">
              <Input value={edit.price} onChange={(v) => setEdit({ ...edit, price: v })} inputMode="decimal" />
            </Field>
            <Field label={t('Intervall')} tour="product-interval">
              <Select value={edit.recurring ?? ''} onChange={(v) => setEdit({ ...edit, recurring: v })} options={[['', t('einmalig')], ['month', t('monatlich')], ['year', t('jährlich')]]} />
            </Field>
          </div>
          <MoreFields id="product-editor" values={[edit.tax_rate, edit.payment_link]}>
            <Field label={t('USt % (leer = Standard)')}>
              <Input value={edit.tax_rate} onChange={(v) => setEdit({ ...edit, tax_rate: v })} />
            </Field>
            <Field label={t('Zahlungslink (Stripe/PayPal, optional)')}>
              <Input value={edit.payment_link} onChange={(v) => setEdit({ ...edit, payment_link: v })} />
            </Field>
          </MoreFields>
        </Modal>
      )}
    </>
  );
}
