import { useEffect, useState } from 'react';
import { api, d, name } from '../api';
import { Badge, Check, Copy, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, useLoad } from '../ui';
import { Choice, LinesEditor, Section, StatusBadge, eur, fromCents, fromDraft, sumNet, toCents, toDraft, type LineDraft } from './SalesKit';
import { Later, lazyPages } from '../lazy';
import { SortableGrid } from '../sortable/Sortable';

// Internal approval (docs/sales.md#internal-approval): its own chunk, shown only where a rule or a request exists.
const { QuoteApprovalPanel, QuoteApprovalInbox } = lazyPages(() => import('./QuoteApproval'), 'QuoteApprovalPanel', 'QuoteApprovalInbox');

/**
 * Angebote aus dem Deal: Positionen, Varianten zur Auswahl, optionale Positionen, Anzahlung, Gültigkeit. Der Kunde bekommt eine
 * eigene Seite, wählt, nimmt an und unterschreibt dort; danach entstehen Angebot mit Nummer und – auf Wunsch – Anzahlungs- oder Rechnung.
 */

const PAYMENT: { value: string; label: string; text: string }[] = [
  { value: 'none', label: 'Nichts bei Annahme', text: 'Die Rechnung schreibst du später (aus dem angenommenen Angebot).' },
  { value: 'deposit', label: 'Anzahlung', text: 'Bei Annahme geht sofort eine Anzahlungsrechnung mit Zahlungslink an den Kunden.' },
  { value: 'full', label: 'Voller Betrag', text: 'Bei Annahme geht sofort die Rechnung über alles mit Zahlungslink raus.' },
];

interface OptionDraft {
  id?: string;
  name: string;
  description: string;
  recommended: boolean;
  items: LineDraft[];
}

function Totals({ t, currency }: { t: any; currency: string }) {
  if (!t) return null;
  return (
    <div className="totals" data-tour="quote-totals">
      {t.discount_cents > 0 && (
        <div className="muted">
          <span>Rabatte</span>
          <span>– {eur(t.discount_cents, currency)}</span>
        </div>
      )}
      <div>
        <span>Summe netto</span>
        <span>{eur(t.net_cents, currency)}</span>
      </div>
      {t.groups.filter((g: any) => g.rate > 0).map((g: any) => (
        <div className="muted" key={g.rate}>
          <span>USt {String(g.rate).replace('.', ',')} %</span>
          <span>{eur(g.tax_cents, currency)}</span>
        </div>
      ))}
      <div className="big">
        <span>Gesamt</span>
        <span>{eur(t.total_cents, currency)}</span>
      </div>
    </div>
  );
}

function SendDialog({ quote, onClose, onSent }: { quote: any; onClose: () => void; onSent: () => void }) {
  const [deliver, setDeliver] = useState(!!quote.contact?.email);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const go = async () => {
    const r = await act(() => api.post(`/api/quotes/${quote.id}/send`, { deliver, subject, body }), deliver ? 'Angebot gesendet' : 'Angebot freigegeben');
    if (r) onSent();
  };
  return (
    <Modal title={`Angebot ${quote.number || ''} senden`.trim()} className="sales-modal" onClose={onClose} footer={<button className="btn" onClick={go} data-tour="quote-send-go">{deliver ? 'Senden' : 'Freigeben'}</button>}>
      <p className="muted">
        An <b>{quote.contact ? quote.contact.name : '–'}</b>
        {quote.contact?.email ? ` (${quote.contact.email})` : ''}. Der Kunde bekommt einen Link zur Angebotsseite, wählt dort und unterschreibt. Mit dem Senden bekommt das Angebot seine Nummer – danach lässt es sich nicht mehr ändern (nur eine neue Version anlegen).
      </p>
      <Check checked={deliver} onChange={setDeliver} label="Per E-Mail senden" />
      {!deliver && <p className="muted small">Das Angebot wird nur freigegeben – den Link gibst du selbst weiter (Chat, Telefon, eigene Mail).</p>}
      {deliver && (
        <>
          <Field label="Betreff (optional)">
            <Input value={subject} onChange={setSubject} placeholder="Ihr Angebot {{quote.number}} von {{location.name}}" />
          </Field>
          <Field label="Text (optional)" hint="Platzhalter: {{contact.first_name}}, {{quote.number}}, {{quote.title}}, {{quote.url}}, {{quote.total}}, {{quote.valid_until}}">
            <Textarea value={body} onChange={setBody} rows={6} placeholder="Leer = Standardtext mit dem Link" />
          </Field>
        </>
      )}
    </Modal>
  );
}

export function QuoteEditor({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const q = useLoad(() => api.get<any>(`/api/quotes/${id}`), [id]);
  const products = useLoad(() => api.get<any[]>('/api/products'), []);
  const [f, setF] = useState<any>();
  const [send, setSend] = useState(false);
  const data = q.data;
  useEffect(() => {
    if (!data) return;
    setF({
      title: data.title,
      intro: data.intro,
      terms: data.terms,
      valid_until: data.valid_until ?? '',
      deal_on_accept: data.deal_on_accept === 'won',
      payment: { mode: data.payment.mode, type: data.payment.type, value: data.payment.type === 'amount' ? fromCents(data.payment.value) : String(data.payment.value) },
      items: data.doc.items.map(toDraft),
      options: data.doc.options.map((o: any): OptionDraft => ({ id: o.id, name: o.name, description: o.description, recommended: o.recommended, items: o.items.map(toDraft) })),
    });
  }, [data]);
  if (!data || !f) return <Modal title="Angebot" className="sales-modal" wide onClose={onClose}>{q.error ? <p className="error">{q.error}</p> : <Spinner />}</Modal>;
  const draft = data.status === 'draft';
  const cur = data.currency;
  const setP = (p: any) => setF({ ...f, payment: { ...f.payment, ...p } });
  const body = () => ({
    title: f.title,
    intro: f.intro,
    terms: f.terms,
    valid_until: f.valid_until || null,
    deal_on_accept: f.deal_on_accept ? 'won' : 'none',
    payment: { mode: f.payment.mode, type: f.payment.type, value: f.payment.type === 'amount' ? toCents(f.payment.value) : Number(String(f.payment.value).replace(',', '.')) || 0 },
    items: f.items.map((l: LineDraft) => fromDraft(l, true)),
    options: f.options.map((o: OptionDraft) => ({ ...(o.id ? { id: o.id } : {}), name: o.name, description: o.description, recommended: o.recommended, items: o.items.map((l) => fromDraft(l, true)) })),
  });
  const save = async (quiet = false) => {
    const r = await act(() => api.patch(`/api/quotes/${id}`, body()), quiet ? undefined : 'Angebot gespeichert');
    if (r) (q.setData(r), onChanged());
    return r;
  };
  const refresh = () => (q.reload(), onChanged());
  const link = data.url as string;
  const setOpt = (i: number, patch: Partial<OptionDraft>) => setF({ ...f, options: f.options.map((o: OptionDraft, j: number) => (j === i ? { ...o, ...patch } : o)) });
  return (
    <Modal
      title={`${data.number ? `Angebot ${data.number}` : 'Angebot'}: ${data.title}`}
      wide
      className="sales-modal"
      onClose={onClose}
      footer={
        draft ? (
          <>
            <button className="btn danger" onClick={async () => confirmAsk('Entwurf löschen?') && (await act(() => api.del(`/api/quotes/${id}`), 'Gelöscht')) && (onChanged(), onClose())}>
              Löschen
            </button>
            <button className="btn secondary" onClick={() => save()} data-tour="quote-save">
              Speichern
            </button>
            <button className="btn" onClick={async () => (await save(true)) && setSend(true)} data-tour="quote-send">
              Speichern &amp; senden…
            </button>
          </>
        ) : (
          <>
            <button className="btn secondary" onClick={async () => (await act(() => api.post(`/api/quotes/${id}/duplicate`, {}), 'Neue Version angelegt')) && (onChanged(), onClose())}>
              Neue Version
            </button>
            {['sent', 'viewed', 'expired'].includes(data.status) && (
              <>
                <button className="btn secondary" onClick={() => setSend(true)}>
                  Erneut senden
                </button>
                <button className="btn danger" onClick={async () => confirmAsk('Angebot zurückziehen? Der Link zeigt dann „zurückgezogen“.') && (await act(() => api.post(`/api/quotes/${id}/void`, {}), 'Zurückgezogen')) && refresh()}>
                  Zurückziehen
                </button>
              </>
            )}
            {data.status === 'accepted' && data.estimate_id && !data.final_invoice_id && data.invoice_kind !== 'standard' && (
              <button className="btn" onClick={async () => (await act(() => api.post(`/api/quotes/${id}/invoice`, {}), data.invoice_kind === 'partial' ? 'Schlussrechnung (Entwurf) angelegt' : 'Rechnung (Entwurf) angelegt')) && refresh()} data-tour="quote-invoice">
                {data.invoice_kind === 'partial' ? 'Schlussrechnung erstellen' : 'Rechnung erstellen'}
              </button>
            )}
          </>
        )
      }
    >
      <div className="sales-bar">
        <StatusBadge status={data.status} label={data.expired && data.status !== 'expired' ? 'Abgelaufen' : data.status_label} />
        <span className="muted">
          {data.contact?.name ?? ''} · Deal „{data.deal?.name}“ · Version {data.revision}
        </span>
        {data.valid_until && <span className="muted">gültig bis {d(`${data.valid_until}T12:00:00`)}</span>}
      </div>
      <Later>
        <QuoteApprovalPanel quoteId={id} version={data.updated_at} />
      </Later>
      {data.note && <p className="note-box warn">{data.note}</p>}
      {!draft && (
        <div className="quote-links">
          <Copy text={link} label="Link kopieren" />
          <a className="btn secondary" href={link} target="_blank" rel="noreferrer">
            Kundenseite öffnen
          </a>
          {data.contract_id && <span className="badge green">Unterschrieben: {data.signer_name}</span>}
          {data.estimate && <a className="btn secondary" href={`/app/invoices/${data.estimate.id}`}>Angebot {data.estimate.number}</a>}
          {data.invoice && <a className="btn secondary" href={`/app/invoices/${data.invoice.id}`}>{data.invoice_kind === 'partial' ? 'Anzahlungsrechnung' : 'Rechnung'} {data.invoice.number || '(Entwurf)'} · {data.invoice.status}</a>}
          {data.final_invoice && <a className="btn secondary" href={`/app/invoices/${data.final_invoice.id}`}>Schlussrechnung (Entwurf)</a>}
          {data.paid_at && <Badge tone="green">Bezahlt</Badge>}
        </div>
      )}

      <fieldset disabled={!draft} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="grid2">
          <Field label="Titel">
            <Input value={f.title} onChange={(v) => setF({ ...f, title: v })} maxLength={200} />
          </Field>
          <Field label="Gültig bis">
            <Input type="date" value={f.valid_until} onChange={(v) => setF({ ...f, valid_until: v })} />
          </Field>
        </div>
        <Field label="Einleitung (Text vor den Positionen)" hint="Einfaches Format: **fett**, - Aufzählung, # Überschrift">
          <Textarea value={f.intro} onChange={(v) => setF({ ...f, intro: v })} rows={3} />
        </Field>

        <Section title="Positionen (für alle Varianten)" tour="quote-items">
          <LinesEditor lines={f.items} onChange={(items) => setF({ ...f, items })} products={products.data ?? []} currency={cur} optional tour="quote-lines" />
          {f.options.length === 0 && <div className="lines-total">Summe netto der festen Positionen: <b>{eur(sumNet(f.items), cur)}</b></div>}
        </Section>

        <Section
          title="Varianten zur Auswahl"
          tour="quote-options"
          actions={
            draft && f.options.length < 6 ? (
              <button type="button" className="btn secondary" onClick={() => setF({ ...f, options: [...f.options, { name: `Variante ${f.options.length + 1}`, description: '', recommended: false, items: [] }] })}>
                + Variante
              </button>
            ) : undefined
          }
        >
          {f.options.length === 0 && <p className="muted small">Mit mehreren Varianten (z. B. „Basis“, „Plus“) wählt der Kunde genau eine; mit einer einzigen gehört sie einfach zum Angebot.</p>}
          {f.options.map((o: OptionDraft, i: number) => (
            <div className="opt-box" key={o.id ?? `o${i}`}>
              <div className="row">
                <div className="grow">
                  <Field label="Name der Variante">
                    <Input value={o.name} onChange={(v) => setOpt(i, { name: v })} maxLength={120} />
                  </Field>
                </div>
                <div className="grow">
                  <Field label="Beschreibung">
                    <Input value={o.description} onChange={(v) => setOpt(i, { description: v })} maxLength={1000} />
                  </Field>
                </div>
                <Check checked={o.recommended} onChange={(v) => setF({ ...f, options: f.options.map((x: OptionDraft, j: number) => ({ ...x, recommended: j === i ? v : v ? false : x.recommended })) })} label="Empfohlen" />
                {draft && (
                  <button type="button" className="btn small secondary" onClick={() => setF({ ...f, options: f.options.filter((_: unknown, j: number) => j !== i) })}>
                    Entfernen
                  </button>
                )}
              </div>
              <LinesEditor lines={o.items} onChange={(items) => setOpt(i, { items })} products={products.data ?? []} currency={cur} optional />
              {data.options[i] && <div className="lines-total">Preis dieser Variante (gespeicherter Stand): <b>{eur(data.options[i].totals.net_cents, cur)}</b> netto</div>}
            </div>
          ))}
        </Section>

        <Section title="Was bei Annahme fällig wird" tour="quote-payment">
          <Choice name="pay" value={f.payment.mode} onChange={(v) => setP({ mode: v })} options={PAYMENT.map((p) => ({ value: p.value, label: p.label, text: p.text }))} />
          {f.payment.mode === 'deposit' && (
            <div className="grid2">
              <Field label="Anzahlung als">
                <Select value={f.payment.type} onChange={(v) => setP({ type: v, value: v === 'amount' ? '0.00' : '30' })} options={[['percent', 'Prozent vom Gesamtbetrag'], ['amount', 'Festbetrag netto']]} />
              </Field>
              <Field label={f.payment.type === 'percent' ? 'Prozent' : `Betrag netto (${cur})`}>
                <Input inputMode="decimal" value={f.payment.value} onChange={(v) => setP({ value: v })} />
              </Field>
            </div>
          )}
          {data.due_on_accept && <p className="muted small">Fällig bei Annahme (gespeicherter Stand): <b>{eur(data.due_on_accept.total_cents, cur)}</b> brutto ({data.due_on_accept.label}).</p>}
          <Check checked={f.deal_on_accept} onChange={(v) => setF({ ...f, deal_on_accept: v })} label="Deal bei Annahme auf „Gewonnen“ setzen" />
        </Section>

        <Section title="Bedingungen">
          <Textarea value={f.terms} onChange={(v) => setF({ ...f, terms: v })} rows={4} placeholder="Zahlungsziel, Lieferzeit, Hinweise …" />
        </Section>
      </fieldset>

      <Totals t={data.totals} currency={cur} />
      {draft && <p className="muted small" style={{ textAlign: 'right' }}>Die Summen rechnet der Server beim Speichern (Rundung wie auf der Rechnung).</p>}
      {send && <SendDialog quote={data} onClose={() => setSend(false)} onSent={() => (setSend(false), refresh())} />}
    </Modal>
  );
}

/** Pick one of the open deals to quote for. */
export function DealPicker({ onClose, onPicked }: { onClose: () => void; onPicked: (quoteId: string) => void }) {
  const deals = useLoad(() => api.get<any[]>('/api/opportunities?status=open'), []);
  const [text, setText] = useState('');
  const list = (deals.data ?? []).filter((o) => `${o.name} ${name(o)}`.toLowerCase().includes(text.toLowerCase())).slice(0, 30);
  const pick = async (dealId: string) => {
    const r = await act(() => api.post('/api/quotes', { deal_id: dealId }), 'Angebot angelegt');
    if (r) onPicked(r.id);
  };
  return (
    <Modal title="Angebot für welchen Deal?" className="sales-modal" onClose={onClose}>
      <Input value={text} onChange={setText} placeholder="Deal oder Kontakt suchen…" autoFocus />
      {!deals.data ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty>Keine offenen Deals gefunden. Lege zuerst unter Opportunities einen Deal an.</Empty>
      ) : (
        list.map((o) => (
          <div className="deal-row" key={o.id}>
            <div className="grow">
              <b>{o.name}</b>
              <div className="muted small">{name(o)}</div>
            </div>
            <span>{eur((o.value || 0) * 100, o.currency)}</span>
            <button className="btn small" onClick={() => pick(o.id)}>
              Angebot erstellen
            </button>
          </div>
        ))
      )}
    </Modal>
  );
}

export function SalesQuotes() {
  const [status, setStatus] = useState('');
  const list = useLoad(() => api.get<any[]>(`/api/quotes${status ? `?status=${status}` : ''}`), [status]);
  const stats = useLoad(() => api.get<any>('/api/quotes/stats'), []);
  const [open, setOpen] = useState<string | null>(new URLSearchParams(location.search).get('quote'));
  const [pick, setPick] = useState(false);
  const reload = () => (list.reload(), stats.reload());
  const s = stats.data;
  return (
    <div data-tour="quote-list">
      <Later>
        <QuoteApprovalInbox onOpen={setOpen} />
      </Later>
      {s && (
        <SortableGrid id="quotes.stats" className="sales-stats">
          <div><b>{s.sent}</b><span>Gesendet</span></div>
          <div><b>{s.open}</b><span>Warten auf Antwort</span></div>
          <div><b>{s.accepted}</b><span>Angenommen</span></div>
          <div><b>{eur(s.accepted_cents)}</b><span>Auftragswert (brutto)</span></div>
          <div><b>{s.win_rate.toLocaleString('de-DE')} %</b><span>Annahmequote</span></div>
        </SortableGrid>
      )}
      <div className="sales-bar">
        <div style={{ width: 220 }}>
          <Select value={status} onChange={setStatus} placeholder="Alle Status" options={Object.entries<string>(s?.labels ?? { draft: 'Entwurf', sent: 'Gesendet', accepted: 'Angenommen' })} />
        </div>
        <span className="grow" />
        <button className="btn" onClick={() => setPick(true)} data-tour="quote-new">
          + Neues Angebot
        </button>
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.length === 0 ? (
        <Empty action={<button className="btn" onClick={() => setPick(true)}>Erstes Angebot erstellen</button>}>Angebote entstehen aus einem Deal – mit Varianten, optionalen Positionen, Anzahlung und Unterschrift auf einer eigenen Seite.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="sales-table stack">
            <thead>
              <tr>
                <th>Angebot</th>
                <th>Status</th>
                <th>Kontakt</th>
                <th className="r">Summe</th>
                <th>Gültig bis</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((x) => (
                <tr key={x.id} className="click" tabIndex={0} onClick={() => setOpen(x.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(x.id)}>
                  <td data-label="Angebot">
                    <b>{x.number || 'Entwurf'}</b> {x.title}
                    <div className="muted small">Deal „{x.deal?.name}“{x.revision > 1 ? ` · Version ${x.revision}` : ''}</div>
                  </td>
                  <td data-label="Status">
                    <StatusBadge status={x.status} label={x.expired && x.status !== 'expired' ? 'Abgelaufen' : x.status_label} />
                    {x.paid_at && <Badge tone="green">bezahlt</Badge>}
                  </td>
                  <td data-label="Kontakt">{x.contact?.name ?? '–'}</td>
                  <td className="r" data-label="Summe">{eur(x.total_cents, x.currency)}</td>
                  <td data-label="Gültig bis">{x.valid_until ? d(`${x.valid_until}T12:00:00`) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pick && <DealPicker onClose={() => setPick(false)} onPicked={(id) => (setPick(false), reload(), setOpen(id))} />}
      {open && <QuoteEditor id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

