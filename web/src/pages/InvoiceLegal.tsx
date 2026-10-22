import { useState } from 'react';
import { Icon } from '../icons';
import { api, currentLocation, d, money } from '../api';
import { Badge, Check, Field, Input, Link, Modal, Select, Spinner, Textarea, act, confirmAsk, navigate, toast, useLoad } from '../ui';
import { useT } from '../i18n';

/**
 * The invoicing parts of the invoice screen that come with the GoBD rules: the lock banner, finalising, Storno, credit notes,
 * payments, the legal fields (service date, tax treatment, VAT ID, Leitweg-ID, Skonto, partial/final invoice), the downloads
 * (PDF, XRechnung) and the audit trail. German copy; every dialog is a Modal (✕ and Esc close it).
 */

export const toCents = (v: string) => Math.round(parseFloat(String(v).replace(',', '.')) * 100) || 0;
export const fromCents = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const loc = () => encodeURIComponent(currentLocation());
const ymd = (iso?: string | null) => (iso ? String(iso).slice(0, 10) : '');

export const STATE_LABEL: Record<string, [string, 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'purple']> = {
  draft: ['Entwurf', 'gray'],
  open: ['offen', 'yellow'],
  partially_paid: ['teilweise bezahlt', 'blue'],
  paid: ['bezahlt', 'green'],
  cancelled: ['storniert', 'red'],
  credited: ['gutgeschrieben', 'gray'],
  discarded: ['verworfen', 'gray'],
  accepted: ['angenommen', 'green'],
};

export const TYPE_LABEL: Record<string, string> = { standard: 'Rechnung', partial: 'Abschlagsrechnung', final: 'Schlussrechnung' };

/** Invoice settings and the lists the editor needs (tax modes, units, ranges), loaded once per screen. */
export function useInvoiceSettings() {
  return useLoad(() => api.get<any>('/api/invoice-settings'), []);
}

// --- banner ----------------------------------------------------------------------------------------------------------------------------

export function LockBar({ inv }: { inv: any }) {
  const verify = async () => {
    const r = await act(() => api.get<any>(`/api/invoices/${inv.id}/verify`));
    if (r) toast(r.ok ? 'Unverändert ✓ – die Prüfsumme (SHA-256) stimmt' : `Achtung: ${r.checks.filter((c: any) => !c.ok).map((c: any) => c.name).join(', ')} weicht von der festgeschriebenen Fassung ab`);
  };
  if (inv.status === 'void' && !inv.locked) return <div className="card notice-card" data-tour="invoice-lock">Dieser Entwurf wurde verworfen – es wurde nie eine Nummer vergeben.</div>;
  if (!inv.locked) return null;
  return (
    <div className="card notice-card lockbar" data-tour="invoice-lock">
      <Icon name="lock" />
      <div>
        <strong>{inv.doc_title} {inv.number} festgeschrieben</strong> am {d(inv.finalised_at)}
        {inv.doc_hash && <span className="muted mono"> · SHA-256 {String(inv.doc_hash).slice(0, 12)}…</span>}
        <div className="muted small">
          Positionen, Beträge und Kundendaten sind gesperrt. Änderbar bleiben Hinweistext, Fälligkeit und Zahlungslink.
          {inv.kind === 'invoice' && inv.status !== 'void' ? ' Eine Korrektur geht nur per Stornorechnung oder Gutschrift.' : ''}
          {inv.status === 'void' && inv.storno_id && (
            <>
              {' '}
              Storniert durch <Link to={`invoices/${inv.storno_id}`}>Stornorechnung</Link>.
            </>
          )}
          {inv.state === 'credited' && ' Vollständig gutgeschrieben – die Rechnung ist geschlossen, die Gutschriften stehen daneben.'}
          {inv.ref && (
            <>
              {' '}
              Verweis auf <Link to={`invoices/${inv.ref.id}`}>{inv.ref.number}</Link>.
            </>
          )}
        </div>
      </div>
      <button className="btn small secondary" onClick={verify}>
        Prüfsumme prüfen
      </button>
    </div>
  );
}

// --- finalising --------------------------------------------------------------------------------------------------------------------------

export function FinaliseModal({ inv, onClose, onDone, send, email }: { inv: any; onClose: () => void; onDone: (r: any) => void; send?: boolean; email?: string }) {
  const pre = useLoad(() => api.get<any>(`/api/invoices/${inv.id}/precheck`), [inv.id]);
  const [busy, setBusy] = useState(false);
  const p = pre.data;
  const blocked = !!p && (p.errors.length > 0 || (p.strict && p.warnings.length > 0));
  const go = async () => {
    setBusy(true);
    const r = await act(() => api.post<any>(send ? `/api/invoices/${inv.id}/send` : `/api/invoices/${inv.id}/finalise`, {}), send ? 'Festgeschrieben und gesendet' : 'Rechnung festgeschrieben');
    setBusy(false);
    if (r) {
      if (r.warnings?.length) toast(`Hinweis: ${r.warnings[0]}`);
      onDone(r);
    }
  };
  return (
    <Modal
      title={`${inv.kind === 'credit_note' ? 'Gutschrift' : 'Rechnung'} ${send ? 'festschreiben und senden' : 'festschreiben'}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" data-tour="invoice-finalise-go" disabled={busy || !p || blocked} onClick={go}>
            <Icon name={send ? 'send' : 'lock'} /> {send ? 'Festschreiben und senden' : 'Jetzt festschreiben'}
          </button>
        </>
      }
    >
      {!p ? (
        <Spinner />
      ) : (
        <>
          <p style={{ marginTop: 0 }}>
            Beim Festschreiben bekommt die {inv.kind === 'credit_note' ? 'Gutschrift' : 'Rechnung'} ihre endgültige Nummer
            {p.next_number ? (
              <>
                {' '}
                (<strong>{p.next_number}</strong>)
              </>
            ) : null}{' '}
            – fortlaufend und ohne Lücken. {send && email ? <>Danach geht sie per E-Mail an <strong>{email}</strong>. </>: null}Danach gilt:
          </p>
          <ul className="small" style={{ paddingLeft: 18 }}>
            <li>Positionen, Beträge, Kundendaten und Steuerbehandlung sind gesperrt (nur Hinweistext und Fälligkeit bleiben änderbar).</li>
            <li>Eine Prüfsumme (SHA-256) und eine Momentaufnahme halten den Stand fest.</li>
            <li>Löschen geht nicht mehr – korrigieren kannst du nur mit einer Stornorechnung oder Gutschrift.</li>
          </ul>
          {p.errors.length > 0 && (
            <div className="notice-warn">
              <strong>Das fehlt noch:</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {p.errors.map((e: string) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {p.warnings.length > 0 && (
            <div className="notice-warn">
              <strong>{p.strict ? 'Pflichtangaben fehlen (strenge Prüfung ist an):' : 'Bitte prüfen:'}</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {p.warnings.map((e: string) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
              <div className="small">Anschrift und Steuernummer des Absenders ergänzt du unter Einstellungen → Rechnungen.</div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// --- Storno ------------------------------------------------------------------------------------------------------------------------------

export function StornoModal({ inv, onClose, onDone }: { inv: any; onClose: () => void; onDone: (r: any) => void }) {
  const [reason, setReason] = useState('');
  const [send, setSend] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const r = await act(() => api.post<any>(`/api/invoices/${inv.id}/storno`, { reason, send }), 'Stornorechnung erstellt');
    setBusy(false);
    if (r) {
      if (r.send_error) toast(`Stornorechnung erstellt, Versand fehlgeschlagen: ${r.send_error}`);
      onDone(r);
    }
  };
  return (
    <Modal
      title={`Rechnung ${inv.number} stornieren`}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn danger" disabled={busy} onClick={go}>
            Stornorechnung erstellen
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Es entsteht eine <strong>Stornorechnung</strong> mit eigener Nummer, Verweis auf {inv.number} und den Beträgen mit umgekehrtem Vorzeichen ({money(-inv.total_cents, inv.currency)}). Die Rechnung gilt danach als storniert, die Buchhaltung wird gegengebucht. Das lässt sich nicht rückgängig machen.
      </p>
      <Field label="Grund (steht auf dem Beleg)">
        <Textarea value={reason} onChange={setReason} placeholder="z. B. Falscher Empfänger, Leistung nicht erbracht" />
      </Field>
      <Check checked={send} onChange={setSend} label="Stornorechnung gleich per E-Mail an den Kunden senden" />
      {inv.paid_cents > 0 && <p className="notice-warn">Auf diese Rechnung sind {money(inv.paid_cents, inv.currency)} gezahlt – die Erstattung veranlasst du separat.</p>}
    </Modal>
  );
}

// --- credit note --------------------------------------------------------------------------------------------------------------------------

export function CreditNoteModal({ inv, onClose }: { inv: any; onClose: () => void }) {
  const left = inv.total_cents - (inv.credited_cents ?? 0);
  const [rows, setRows] = useState<any[]>(() => inv.items.map((x: any) => ({ ...x, price: fromCents(x.price_cents), take: false })));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const picked = rows.filter((r) => r.take);
  const net = picked.reduce((a, r) => a + Math.round(Number(r.qty) * toCents(r.price)), 0);
  const gross = picked.reduce((a, r) => a + Math.round(Number(r.qty) * toCents(r.price)) + Math.round((Math.round(Number(r.qty) * toCents(r.price)) * (inv.tax_mode === 'standard' ? Number(r.tax_rate) : 0)) / 100), 0);
  const set = (i: number, patch: any) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const go = async () => {
    setBusy(true);
    const items = picked.map((r) => ({ name: r.name, description: r.description, qty: Number(r.qty), unit: r.unit, price_cents: toCents(r.price), tax_rate: r.tax_rate }));
    const r = await act(() => api.post<any>(`/api/invoices/${inv.id}/credit-note`, { items, reason }), 'Gutschrift als Entwurf angelegt');
    setBusy(false);
    if (r) navigate(`invoices/${r.id}`);
  };
  // with credit notes there is no Storno any more: the rest is credited as one more credit note (the server makes its lines)
  const rest = async () => {
    setBusy(true);
    const r = await act(() => api.post<any>(`/api/invoices/${inv.id}/credit-note`, { remainder: true, reason }), 'Gutschrift als Entwurf angelegt');
    setBusy(false);
    if (r) {
      if (r.warnings?.length) toast(r.warnings[0]);
      navigate(`invoices/${r.id}`);
    }
  };
  return (
    <Modal
      wide
      title={`Gutschrift zu ${inv.number}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          {(inv.credited_cents ?? 0) > 0 && left > 0 && (
            <button className="btn secondary" disabled={busy} onClick={rest}>
              Restbetrag gutschreiben
            </button>
          )}
          <button className="btn" disabled={busy || !picked.length || gross <= 0 || gross > left} onClick={go}>
            Gutschrift als Entwurf anlegen
          </button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        Wähle die Positionen, die du gutschreiben willst, und passe Menge und Preis an (positiv eintragen – die Gutschrift macht daraus den Abzug). Du kannst die Gutschrift noch bearbeiten und schreibst sie dann fest. Noch gutschreibbar: {money(left, inv.currency)}.
      </p>
      <table className="t">
        <thead>
          <tr>
            <th style={{ width: 36 }}></th>
            <th>Position</th>
            <th style={{ width: 90 }}>Menge</th>
            <th style={{ width: 120 }}>Preis netto (€)</th>
            <th style={{ width: 100, textAlign: 'right' }}>Netto</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input type="checkbox" checked={r.take} onChange={(e) => set(i, { take: e.target.checked })} aria-label="gutschreiben" />
              </td>
              <td>{r.name}</td>
              <td>
                <Input type="number" value={r.qty} onChange={(v) => set(i, { qty: v, take: true })} />
              </td>
              <td>
                <Input value={r.price} onChange={(v) => set(i, { price: v, take: true })} inputMode="decimal" />
              </td>
              <td style={{ textAlign: 'right' }}>{money(Math.round(Number(r.qty) * toCents(r.price)), inv.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ textAlign: 'right' }}>
        Gutschrift netto {money(net, inv.currency)} · brutto <strong>{money(gross, inv.currency)}</strong>
        {gross > left && <span className="error"> – mehr als noch gutschreibbar</span>}
      </p>
      <Field label="Grund (steht auf dem Beleg)">
        <Input value={reason} onChange={setReason} placeholder="z. B. Kulanz, Mengenabweichung" />
      </Field>
    </Modal>
  );
}

// --- payments --------------------------------------------------------------------------------------------------------------------------------

export function PaymentModal({ inv, onClose, onDone }: { inv: any; onClose: () => void; onDone: (r: any) => void }) {
  const [amount, setAmount] = useState(fromCents(inv.open_cents));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState('Überweisung');
  const [note, setNote] = useState('');
  const [skonto, setSkonto] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasSkonto = !!inv.skonto_percent && !!inv.skonto_days;
  const go = async () => {
    setBusy(true);
    const r = await act(() => api.post<any>(`/api/invoices/${inv.id}/payments`, { amount_cents: toCents(amount), paid_at: date ? `${date}T12:00:00.000Z` : undefined, method, note, skonto }), 'Zahlung erfasst');
    setBusy(false);
    if (r) onDone(r);
  };
  return (
    <Modal
      title="Zahlung erfassen"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" disabled={busy || toCents(amount) <= 0} onClick={go}>
            ✓ Zahlung speichern
          </button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        Offen: <strong>{money(inv.open_cents, inv.currency)}</strong>. Ein kleinerer Betrag ist eine Teilzahlung – die Rechnung bleibt dann „teilweise bezahlt“.
      </p>
      <div className="grid2">
        <Field label="Betrag (€)">
          <Input value={amount} onChange={setAmount} inputMode="decimal" />
        </Field>
        <Field label="Zahlungsdatum">
          <Input type="date" value={date} onChange={setDate} />
        </Field>
        <Field label="Art">
          <Select value={method} onChange={setMethod} options={['Überweisung', 'Lastschrift', 'Bar', 'PayPal', 'Karte', 'Verrechnung']} />
        </Field>
        <Field label="Notiz">
          <Input value={note} onChange={setNote} />
        </Field>
      </div>
      {hasSkonto && <Check checked={skonto} onChange={setSkonto} label={`Kunde hat Skonto abgezogen (${String(inv.skonto_percent).replace('.', ',')} % bei Zahlung in ${inv.skonto_days} Tagen) – der Rest gilt als Skonto`} />}
    </Modal>
  );
}

export function PaymentsBox({ inv, onChanged }: { inv: any; onChanged: (r: any) => void }) {
  const rows: any[] = inv.payments ?? [];
  if (inv.kind !== 'invoice' || (!rows.length && !inv.paid_cents)) return null;
  const reverted = new Set(rows.filter((r) => r.kind === 'reversal').map((r) => r.reverses_id));
  return (
    <div className="stripe-box" data-tour="invoice-payments">
      <strong>
        <Icon name="card" /> Zahlungen
      </strong>
      {rows.length === 0 && <p>Bezahlt am {d(inv.paid_at)}.</p>}
      <table className="t" style={{ marginTop: 6 }}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={reverted.has(r.id) ? { opacity: 0.55 } : undefined}>
              <td>{d(r.paid_at)}</td>
              <td>
                {r.kind === 'skonto' ? 'Skonto' : r.kind === 'reversal' ? 'zurückgenommen' : r.method || 'Zahlung'}
                {r.note && r.kind !== 'reversal' ? <span className="muted"> · {r.note}</span> : null}
              </td>
              <td style={{ textAlign: 'right' }}>{money(r.amount_cents, inv.currency)}</td>
              <td style={{ width: 30 }}>
                {r.kind === 'payment' && !reverted.has(r.id) && inv.status !== 'void' && (
                  <button
                    className="icon-btn"
                    title="Zahlung zurücknehmen"
                    aria-label="Zahlung zurücknehmen"
                    onClick={async () => confirmAsk('Zahlung zurücknehmen? Die Rechnung ist danach wieder offen (die Zahlung bleibt als Zeile im Protokoll).') && onChanged(await act(() => api.post<any>(`/api/invoices/${inv.id}/payments/${r.id}/revert`, {}), 'Zahlung zurückgenommen'))}
                  >
                    ↺
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {inv.status === 'sent' && inv.open_cents > 0 && <p className="small">Noch offen: {money(inv.open_cents, inv.currency)}</p>}
    </div>
  );
}

// --- legal fields ---------------------------------------------------------------------------------------------------------------------------------

export function LegalFields({ inv, set, frozen, settings }: { inv: any; set: (patch: any) => void; frozen: boolean; settings: any }) {
  const modes: any[] = settings?.tax_modes ?? [];
  const mode = modes.find((m) => m.key === inv.tax_mode);
  const [vat, setVat] = useState<any>(null);
  const isInvoice = inv.kind === 'invoice';
  const candidates: any[] = inv.deduction_candidates ?? [];
  const checkVat = async () => {
    const r = await act(() => api.post<any>('/api/invoices/vat-check', { vat_id: inv.buyer_vat_id }));
    if (r) setVat(r);
  };
  return (
    <div className="card" style={{ marginTop: 12 }} data-tour="invoice-legal">
      <h3 style={{ marginBottom: 8 }}>Rechnungsangaben</h3>
      <fieldset disabled={frozen} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {isInvoice && (
        <Field label="Art">
          <Select value={inv.inv_type ?? 'standard'} onChange={(v) => set({ inv_type: v, ...(v !== 'final' ? { deduct_ids: [] } : {}) })} options={[['standard', 'Rechnung'], ['partial', 'Abschlagsrechnung'], ['final', 'Schlussrechnung (zieht Abschläge ab)']]} />
        </Field>
      )}
      {inv.inv_type === 'final' && !frozen && (
        <Field label="Abschlagsrechnungen abziehen" hint="Nur festgeschriebene Abschlagsrechnungen dieses Kunden, die noch in keiner Schlussrechnung abgezogen wurden.">
          {candidates.length ? (
            candidates.map((c) => (
              <Check
                key={c.id}
                checked={(inv.deduct_ids ?? []).includes(c.id)}
                onChange={(on) => set({ deduct_ids: on ? [...(inv.deduct_ids ?? []), c.id] : (inv.deduct_ids ?? []).filter((x: string) => x !== c.id) })}
                label={`${c.number} vom ${d(c.issued_at)} · ${money(c.total_cents, c.currency)}`}
              />
            ))
          ) : (
            <span className="muted">Keine abziehbaren Abschlagsrechnungen gefunden.</span>
          )}
        </Field>
      )}
      {inv.inv_type === 'final' && frozen && (inv.deductions ?? []).length > 0 && (
        <p className="small">
          Abgezogen: {(inv.deductions as any[]).map((x) => `${x.number} (${money(x.total_cents, inv.currency)})`).join(', ')} · noch zu zahlen {money(inv.total_cents - inv.deducted_cents, inv.currency)}
        </p>
      )}
      <div className="grid2">
        <Field label="Leistungsdatum">
          <Input type="date" value={ymd(inv.supply_from)} onChange={(v) => set({ supply_from: v })} disabled={frozen} />
        </Field>
        <Field label="… bis (Leistungszeitraum, optional)">
          <Input type="date" value={ymd(inv.supply_to)} onChange={(v) => set({ supply_to: v })} disabled={frozen} />
        </Field>
      </div>
      {!frozen && !inv.supply_from && <p className="muted small">Ohne Angabe gilt das Rechnungsdatum als Leistungsdatum (steht so auf der Rechnung).</p>}
      {inv.kind === 'credit_note' ? (
        <p className="small" data-tour="invoice-taxmode">
          Steuerbehandlung: <strong>{mode?.label ?? 'Regelbesteuerung'}</strong> – von der Rechnung übernommen, eine Gutschrift ändert sie nicht.
          {inv.tax_note ? <span className="muted"> {inv.tax_note}</span> : null}
        </p>
      ) : (
        <>
          <Field label="Steuerbehandlung" tour="invoice-taxmode">
            <Select
              value={inv.tax_mode ?? 'standard'}
              onChange={(v) => {
                const m = modes.find((x) => x.key === v);
                set({ tax_mode: v, tax_note: m?.note ?? '', ...(v !== 'standard' ? { items: inv.items.map((x: any) => ({ ...x, tax_rate: 0 })) } : {}) });
              }}
              options={modes.map((m) => [m.key, m.label] as [string, string])}
            />
          </Field>
          {(inv.tax_mode ?? 'standard') !== 'standard' && (
            <Field label="Pflichttext auf der Rechnung" hint={mode?.needs_buyer_vat ? 'Pflicht – dazu die USt-IdNr. von dir und vom Kunden.' : 'Pflicht – ohne diesen Hinweis ist die Rechnung nicht zulässig.'}>
              <Textarea value={inv.tax_note} onChange={(v) => set({ tax_note: v })} disabled={frozen} />
            </Field>
          )}
        </>
      )}
      <div className="grid2">
        <Field label="USt-IdNr. des Kunden" hint={mode?.needs_buyer_vat ? 'Pflicht bei dieser Steuerbehandlung' : undefined}>
          <div style={{ display: 'flex', gap: 6 }}>
            <Input value={inv.buyer_vat_id} onChange={(v) => set({ buyer_vat_id: v })} disabled={frozen} placeholder="DE123456789" />
            {!frozen && inv.buyer_vat_id && (
              <button className="btn small secondary" type="button" onClick={checkVat}>
                Prüfen
              </button>
            )}
          </div>
        </Field>
        <Field label="Leitweg-ID (Behörden, B2G)" hint="Für XRechnung an öffentliche Auftraggeber">
          <Input value={inv.leitweg_id} onChange={(v) => set({ leitweg_id: v })} disabled={frozen} placeholder="04011000-1234512345-35" />
        </Field>
        <Field label="Kundenreferenz / Bestellnummer">
          <Input value={inv.buyer_ref} onChange={(v) => set({ buyer_ref: v })} disabled={frozen} />
        </Field>
        {isInvoice && (
          <Field label="Skonto (Prozent / Tage)">
            <div style={{ display: 'flex', gap: 6 }}>
              <Input value={inv.skonto_percent ?? ''} onChange={(v) => set({ skonto_percent: v === '' ? null : Number(v.replace(',', '.')), skonto_days: v === '' ? null : inv.skonto_days ?? 10 })} disabled={frozen} placeholder="2" />
              <Input value={inv.skonto_days ?? ''} onChange={(v) => set({ skonto_days: v === '' ? null : Number(v) })} disabled={frozen} placeholder="10 Tage" />
            </div>
          </Field>
        )}
      </div>
      {vat && (
        <p className="small" style={{ margin: '0 0 8px' }}>
          {vat.format_ok ? (
            <>
              <Badge tone="green">Format ok</Badge> {vat.vat_id}
              {vat.vies?.checked ? (
                <>
                  {' '}
                  · VIES: {vat.vies.valid ? <Badge tone="green">gültig{vat.vies.name ? ` – ${vat.vies.name}` : ''}</Badge> : <Badge tone="red">unbekannt</Badge>}
                </>
              ) : vat.vies_enabled ? (
                <span className="muted"> · VIES nicht erreichbar</span>
              ) : (
                <span className="muted"> · VIES-Abfrage unter Einstellungen → Rechnungen einschaltbar</span>
              )}
            </>
          ) : (
            <>
              <Badge tone="red">ungültig</Badge> {vat.reason}
            </>
          )}
        </p>
      )}
      </fieldset>
    </div>
  );
}

// --- downloads and the e-invoice ----------------------------------------------------------------------------------------------------------------------

export function DocsBox({ inv }: { inv: any }) {
  const [check, setCheck] = useState<any>(null);
  const isQuote = inv.kind === 'estimate';
  const base = `/api/invoices/${inv.id}`;
  const open = async (syntax: 'cii' | 'ubl') => {
    const r = await act(() => api.get<any>(`${base}/einvoice/check?syntax=${syntax}`));
    if (r) setCheck(r);
  };
  return (
    <div className="stripe-box" data-tour="invoice-docs">
      <strong>
        <Icon name="download" /> Dokumente
      </strong>
      <div className="actions" style={{ marginTop: 8 }}>
        <a className="btn small secondary" href={`${base}/pdf?download=1&locationId=${loc()}`} target="_blank" rel="noreferrer">
          PDF
        </a>
        {!isQuote && inv.locked && (
          <>
            <a className="btn small secondary" href={`${base}/xrechnung?download=1&syntax=cii&locationId=${loc()}`} title="UN/CEFACT CII – das Format von ZUGFeRD und Factur-X">
              XRechnung (CII)
            </a>
            <a className="btn small secondary" href={`${base}/xrechnung?download=1&syntax=ubl&locationId=${loc()}`} title="UBL 2.1">
              XRechnung (UBL)
            </a>
            <a className="btn small secondary" href={`${base}/zugferd?download=1&locationId=${loc()}`} title="ZUGFeRD 2.3 / Factur-X: das PDF mit eingebetteter E-Rechnung (EN 16931)">
              ZUGFeRD-PDF
            </a>
          </>
        )}
        {!isQuote && (
          <button className="btn small ghost" onClick={() => open('cii')}>
            E-Rechnung prüfen
          </button>
        )}
      </div>
      {!isQuote && !inv.locked && <p className="muted small">XRechnung und ZUGFeRD gibt es ab dem Festschreiben.</p>}
      {(inv.archive ?? []).length > 0 && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          Archiviert (unveränderlich, Aufbewahrung bis {d(inv.archive[0].retention_until)}):{' '}
          {(inv.archive as any[]).map((a) => (
            <a key={a.id} href={`${base}/documents/${a.id}/download?locationId=${loc()}`} title={`SHA-256 ${a.sha256}`} style={{ marginRight: 8 }}>
              {a.kind === 'pdf' ? 'PDF' : a.kind === 'zugferd' ? 'ZUGFeRD' : a.kind === 'xrechnung-ubl' ? 'UBL' : 'CII'} {d(a.created_at)}
            </a>
          ))}
        </p>
      )}
      {check && (
        <Modal title="E-Rechnung prüfen" onClose={() => setCheck(null)}>
          {check.ready ? (
            <p>
              <Badge tone="green">bereit</Badge> Alle Pflichtangaben sind da, die Regeln der EN 16931 / XRechnung 3.0 (eigene Prüfung) sind erfüllt.
            </p>
          ) : (
            <p>
              <Badge tone="yellow">noch nicht bereit</Badge> {check.final ? '' : 'Der Entwurf wird zuerst festgeschrieben – diese Vorschau zeigt, was dann fehlen würde.'}
            </p>
          )}
          {check.problems.length > 0 && (
            <>
              <strong>Es fehlt:</strong>
              <ul>
                {check.problems.map((p: string) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </>
          )}
          {check.errors.length > 0 && (
            <>
              <strong>Regelverstöße:</strong>
              <ul>
                {check.errors.map((e: any) => (
                  <li key={e.rule + e.message}>
                    <code>{e.rule}</code> {e.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="muted small">Die Prüfung deckt die wichtigsten Regeln ab (Pflichtfelder, Summen, Steueraufschlüsselung, Codes) – sie ersetzt nicht den offiziellen KoSIT-Validator vor dem ersten produktiven Versand.</p>
        </Modal>
      )}
    </div>
  );
}

export function AuditBox({ inv }: { inv: any }) {
  const [open, setOpen] = useState(false);
  const log = useLoad(() => (open ? api.get<any[]>(`/api/invoices/${inv.id}/audit`) : Promise.resolve([] as any[])), [inv.id, open, inv.updated_at, inv.status]);
  return (
    <div className="stripe-box">
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
      >
        <strong>{open ? '▾' : '▸'} Protokoll</strong>
      </a>
      {open && (
        <table className="t" style={{ marginTop: 6 }}>
          <tbody>
            {(log.data ?? []).map((a: any) => (
              <tr key={a.id}>
                <td className="muted small" style={{ whiteSpace: 'nowrap' }}>
                  {d(a.at)}
                </td>
                <td>
                  <span className="small">{ACTIONS[a.action] ?? a.action}</span>
                  {a.detail && <div className="muted small">{a.detail}</div>}
                </td>
                <td className="muted small">{a.actor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const ACTIONS: Record<string, string> = {
  'invoice.created': 'angelegt',
  'invoice.created_from_quote': 'aus Angebot erstellt',
  'invoice.finalised': 'festgeschrieben',
  'invoice.adopted': 'festgeschrieben (nachträglich übernommen)',
  'invoice.migrated': 'beim Update festgeschrieben',
  'invoice.sent': 'versendet',
  'invoice.send_failed': 'Versand fehlgeschlagen',
  'invoice.amended': 'geändert',
  'invoice.cancelled': 'storniert',
  'credit_note.created': 'Gutschrift angelegt',
  'payment.recorded': 'Teilzahlung',
  'payment.completed': 'bezahlt',
  'payment.reverted': 'Zahlung zurückgenommen',
  'payment.mismatch': 'Zahlung weicht ab',
  'einvoice.generated': 'XRechnung erzeugt und archiviert',
  'einvoice.attach_skipped': 'XRechnung nicht angehängt',
  'draft.deleted': 'Entwurf gelöscht',
  'draft.discarded': 'Entwurf verworfen',
  'quote.converted': 'in Rechnung umgewandelt',
  'quote.accepted': 'angenommen',
  'quote.discarded': 'verworfen',
};

// --- list helpers ------------------------------------------------------------------------------------------------------------------------------------------

export const numberLabel = (i: any) => (i.number ? i.number : 'Entwurf');

export function StateBadge({ i }: { i: any }) {
  // Shown in the invoice list and editor: translated with them (invoices catalog; STATE_LABEL's texts are its message ids).
  const t = useT('invoices');
  // a credit note is not "open" – it is final (its effect is the counter-booking)
  const [text, tone] = i.kind === 'credit_note' && i.state === 'open' ? (['festgeschrieben', 'blue'] as const) : (STATE_LABEL[i.state] ?? [i.state, 'gray']);
  return <Badge tone={tone}>{t(text)}</Badge>;
}
