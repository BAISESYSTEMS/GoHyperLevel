import { useEffect, useMemo, useState } from 'react';
import { api, dt, money } from '../api';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, useLoad } from '../ui';
import { Callout, Facts, Item, Panel, euroText, openAuthed, parseEuro } from './CreatorKit';

/**
 * The run builder (open invoices → preview with groups and totals → draft run with pre-notification), the history with
 * submit / download / paid / return, and the transfer files (supplier invoices of the accounting, manual payout list).
 */

export const ymdDe = (s?: string | null) => (s ? s.slice(0, 10).split('-').reverse().join('.') : '–');
export const SeqBadge = ({ seq, label }: { seq?: string | null; label?: string }) => (seq ? <Badge tone={seq === 'FRST' ? 'blue' : seq === 'FNAL' ? 'purple' : 'gray'}>{label ? `${seq} · ${label}` : seq}</Badge> : null);
const RUN_TONE: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow'> = { draft: 'yellow', submitted: 'blue', closed: 'green', cancelled: 'gray' };
const ITEM_TONE: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow'> = { draft: 'yellow', submitted: 'blue', paid: 'green', returned: 'red', dropped: 'gray' };
const download = (run: any) => openAuthed(`/api/sepa/runs/${run.id}/xml`, `SEPA-${run.kind === 'debit' ? 'Lastschrift' : 'Ueberweisung'}-${run.exec_date}.xml`);

// --- run builder -------------------------------------------------------------------------------------------------------------

export function CollectTab({ onCreated }: { onCreated: (runId: string) => void }) {
  const { data } = useLoad(() => api.get('/api/sepa/candidates'), []);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [date, setDate] = useState('');
  const [notify, setNotify] = useState(true);
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data) return;
    setDate((d) => d || data.earliest);
    setPicked(new Set(data.items.filter((c: any) => c.ok).map((c: any) => c.invoice_id)));
  }, [data]);
  const ids = useMemo(() => [...picked], [picked]);
  useEffect(() => {
    if (!date || !ids.length) return setPreview(null);
    const t = setTimeout(() => api.post('/api/sepa/runs/preview', { invoice_ids: ids, collection_date: date }).then(setPreview).catch(() => setPreview(null)), 250);
    return () => clearTimeout(t);
  }, [ids, date]);
  if (!data) return <Spinner />;
  const toggle = (id: string, on: boolean) => setPicked((s) => {
    const n = new Set(s);
    if (on) n.add(id);
    else n.delete(id);
    return n;
  });
  const ok = data.items.filter((c: any) => c.ok);
  const create = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/sepa/runs', { invoice_ids: ids, collection_date: date, notify }), notify ? 'Lauf angelegt, Vorabankündigungen gesendet' : 'Lauf angelegt');
    setBusy(false);
    if (r) onCreated(r.id);
  };
  return (
    <div className="cr-panels">
      <Panel
        title="Offene Rechnungen mit Mandat"
        sub={`Festgeschriebene, offene Rechnungen in Euro von Kontakten mit aktivem Mandat. Vorabankündigung ${data.prenotify_days} ${data.prenotify_days === 1 ? 'Tag' : 'Tage'} vorher.`}
        tour="sepa-collect"
        actions={
          ok.length > 0 && (
            <button className="btn secondary" onClick={() => setPicked(picked.size === ok.length ? new Set() : new Set(ok.map((c: any) => c.invoice_id)))}>
              {picked.size === ok.length ? 'Keine wählen' : 'Alle wählen'}
            </button>
          )
        }
      >
        {!data.items.length ? (
          <Empty>Keine einziehbare Rechnung. Rechnungen erscheinen hier, sobald sie festgeschrieben und offen sind und der Kontakt ein aktives Mandat hat.</Empty>
        ) : (
          <div className="cr-list">
            {data.items.map((c: any) => (
              <Item key={c.invoice_id} tone={c.ok ? undefined : 'warn'} side={<><SeqBadge seq={c.seq} /> <strong>{money(c.open_cents)}</strong></>}>
                {c.ok ? (
                  <Check checked={picked.has(c.invoice_id)} onChange={(v) => toggle(c.invoice_id, v)} label={<><strong>{c.number}</strong> · {c.contact_name}</>} />
                ) : (
                  <span>
                    <strong>{c.number}</strong> · {c.contact_name}
                  </span>
                )}
                <div className="cr-sub">
                  Mandat {c.mandate_ref} · {c.iban_masked}
                  {c.due_at && ` · fällig ${ymdDe(c.due_at)}`}
                  {!c.ok && <span className="sepa-warn"> · {c.problems.join(', ')}</span>}
                </div>
              </Item>
            ))}
          </div>
        )}
      </Panel>
      <Panel title="Vorschau" sub="Je Lastschriftart und Sequenztyp entsteht ein eigener Block in der Datei." tour="sepa-preview">
        <Field label="Fälligkeit (Einzugsdatum)" hint={`Frühestens ${ymdDe(data.earliest)} – ein Bankarbeitstag (TARGET2)`} tour="sepa-date">
          <Input type="date" value={date} min={data.earliest} onChange={setDate} />
        </Field>
        {preview && (
          <>
            <table className="sepa-table">
              <thead>
                <tr>
                  <th>Block</th>
                  <th className="num">Anzahl</th>
                  <th className="num">Summe</th>
                </tr>
              </thead>
              <tbody>
                {preview.groups.map((g: any) => (
                  <tr key={`${g.scheme}${g.seq}`}>
                    <td>
                      {g.scheme} · <SeqBadge seq={g.seq} label={g.seq_label} />
                    </td>
                    <td className="num">{g.count}</td>
                    <td className="num">{money(g.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Gesamt</td>
                  <td className="num">{preview.count}</td>
                  <td className="num">{money(preview.total_cents)}</td>
                </tr>
              </tfoot>
            </table>
            {preview.errors.length > 0 && <Callout tone="bad">{preview.errors.join(' · ')}</Callout>}
            {preview.warnings.length > 0 && <Callout tone="warn">{preview.warnings.join(' · ')}</Callout>}
          </>
        )}
        <Check checked={notify} onChange={setNotify} label="Vorabankündigung jetzt per E-Mail senden (aus: ich kündige selbst an, z. B. auf der Rechnung)" />
        <button className="btn sepa-wide" onClick={create} disabled={busy || !preview?.ok} data-tour="sepa-create">
          Lauf anlegen{notify ? ' & Vorabankündigung senden' : ''}
        </button>
        <p className="muted small">Eingereicht wird erst im nächsten Schritt: Dann entsteht die Datei (pain.008), die du im Online-Banking hochlädst.</p>
      </Panel>
    </div>
  );
}

// --- history and run detail ------------------------------------------------------------------------------------------------------

function ReturnDialog({ item, onClose, onDone }: { item: any; onClose: () => void; onDone: () => void }) {
  const { data } = useLoad(() => api.get('/api/sepa/settings'), []);
  const [code, setCode] = useState('AM04');
  const [fee, setFee] = useState('');
  const [feeInvoice, setFeeInvoice] = useState(true);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (data?.settings.return_fee_cents) setFee(euroText(data.settings.return_fee_cents));
  }, [data]);
  const codes: [string, string][] = Object.entries<any>(data?.return_codes ?? {}).map(([k, v]) => [k, `${k} – ${v.label}`]);
  const effect = data?.return_codes?.[code]?.mandate;
  const save = async () => {
    const cents = fee.trim() ? parseEuro(fee) : 0;
    if (cents === null) return act(() => Promise.reject(new Error('Gebühr: bitte einen Betrag wie 3,50 eingeben')));
    if (await act(() => api.post(`/api/sepa/items/${item.id}/return`, { code, fee_cents: cents, fee_invoice: cents > 0 && feeInvoice, note }), 'Rücklastschrift erfasst – die Rechnung ist wieder offen')) onDone();
  };
  return (
    <Modal
      title={`Rücklastschrift ${item.invoice_number || item.end_to_end}`}
      onClose={onClose}
      footer={
        <button className="btn danger" onClick={save} data-tour="sepa-return-save">
          Rücklastschrift erfassen
        </button>
      }
    >
      <p className="cr-hint">Die Zahlung auf der Rechnung wird zurückgenommen ({money(item.amount_cents)}), die Rechnung ist danach wieder offen und kann erneut eingezogen oder gemahnt werden.</p>
      <Field label="Rückgabegrund (laut Bank)">
        <Select value={code} onChange={setCode} options={codes} />
      </Field>
      {effect && <Callout tone="warn">{effect === 'revoke' ? 'Dieser Grund beendet das Mandat – für weitere Lastschriften braucht es ein neues.' : 'Dieser Grund sperrt das Mandat, bis du die Daten geprüft und es wieder freigegeben hast.'}</Callout>}
      <div className="row">
        <Field label="Gebühr der Bank (€)" hint="optional">
          <Input value={fee} onChange={setFee} placeholder="0,00" inputMode="decimal" />
        </Field>
      </div>
      <Check checked={feeInvoice} onChange={setFeeInvoice} label="Gebühr als Rechnungsentwurf an den Kunden anlegen" />
      <Field label="Notiz">
        <Textarea value={note} onChange={setNote} rows={2} />
      </Field>
    </Modal>
  );
}

function RunDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data: r, reload } = useLoad(() => api.get(`/api/sepa/runs/${id}`), [id]);
  const [ret, setRet] = useState<any>(null);
  if (!r)
    return (
      <Modal title="SEPA-Lauf" onClose={onClose}>
        <Spinner />
      </Modal>
    );
  const after = () => (reload(), onChanged());
  const run = async (fn: () => Promise<any>, ok: string) => {
    const res = await act(fn, ok);
    if (res) after();
    return res;
  };
  const debit = r.kind === 'debit';
  // One dialog at a time: Esc or ✕ on the return dialog leads back to the run, not out of both.
  if (ret) return <ReturnDialog item={ret} onClose={() => setRet(null)} onDone={() => (setRet(null), after())} />;
  const submit = async () => {
    const res = await run(() => api.post(`/api/sepa/runs/${id}/submit`), 'Eingereicht – die Datei steht bereit');
    if (res) {
      if (res.dropped?.length) window.alert(`Nicht in der Datei:\n${res.dropped.join('\n')}`);
      void download(res);
    }
  };
  const cancel = () => {
    const reason = window.prompt(r.status === 'draft' ? 'Lauf verwerfen – Grund (optional):' : 'Lauf zurückziehen (z. B. „Bank hat die Datei abgelehnt“):', '');
    if (reason !== null) void run(() => api.post(`/api/sepa/runs/${id}/cancel`, { reason }), r.status === 'draft' ? 'Lauf verworfen' : 'Lauf zurückgezogen');
  };
  const failed = r.items.filter((x: any) => x.notify_status === 'failed' && x.status === 'draft').length;
  const open = r.counts?.submitted ?? 0;
  return (
    <Modal
      title={`${r.kind_label} ${ymdDe(r.exec_date)}`}
      wide
      onClose={onClose}
      footer={
        <>
          {r.status === 'draft' && (
            <button className="btn" onClick={submit} data-tour="sepa-submit">
              Einreichen & Datei erzeugen
            </button>
          )}
          {r.has_xml && (
            <button className="btn secondary" onClick={() => download(r)} data-tour="sepa-download">
              XML herunterladen
            </button>
          )}
          {r.status === 'submitted' && open > 0 && (
            <button className="btn secondary" onClick={() => confirmAsk(`Alle ${open} eingereichten Posten als bezahlt markieren?`) && run(() => api.post(`/api/sepa/runs/${id}/paid`), 'Als bezahlt markiert')}>
              Alle als bezahlt
            </button>
          )}
          {r.status === 'draft' && failed > 0 && (
            <button className="btn secondary" onClick={() => run(() => api.post(`/api/sepa/runs/${id}/notify`), 'Vorabankündigung erneut gesendet')}>
              Vorabankündigung erneut senden
            </button>
          )}
          {(r.status === 'draft' || (r.status === 'submitted' && !r.counts?.paid && !r.counts?.returned)) && (
            <button className="btn danger" onClick={cancel}>
              {r.status === 'draft' ? 'Verwerfen' : 'Zurückziehen'}
            </button>
          )}
        </>
      }
    >
      <Facts
        rows={[
          ['Status', <Badge key="s" tone={RUN_TONE[r.status] ?? 'gray'}>{r.status_label}</Badge>],
          [debit ? 'Fälligkeit' : 'Ausführung', ymdDe(r.exec_date)],
          ['Posten', `${r.tx_count} · ${money(r.total_cents)}`],
          ['Nachricht (MsgId)', r.msg_id],
          ['Eingereicht', r.submitted_at ? dt(r.submitted_at) : 'noch nicht'],
          ['Datei', r.xml_sha256 ? `${debit ? 'pain.008.001.08' : 'pain.001.001.09'} · SHA-256 ${r.xml_sha256.slice(0, 16)}…` : ''],
          ['Notiz', r.note],
        ]}
      />
      {r.status === 'draft' && <Callout>Die Vorabankündigung ist raus. Reiche den Lauf spätestens einen Bankarbeitstag vor der Fälligkeit ein: Dann entsteht die Datei, die du im Online-Banking hochlädst.</Callout>}
      <div className="sepa-scroll">
        <table className="sepa-table">
          <thead>
            <tr>
              <th>{debit ? 'Rechnung' : 'Empfänger'}</th>
              <th className="num">Betrag</th>
              {debit && <th>Sequenz</th>}
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {r.items.map((x: any) => (
              <tr key={x.id}>
                <td>
                  <strong>{debit ? x.invoice_number || x.end_to_end : x.name}</strong>
                  <div className="muted small">
                    {debit ? `${x.name} · ${x.mandate_ref}` : `${x.iban_masked} · ${x.remittance}`}
                    {debit && x.notify_status === 'failed' && <span className="sepa-warn"> · Vorabankündigung fehlgeschlagen: {x.notify_error}</span>}
                    {debit && x.notify_status === 'manual' && ' · Vorabankündigung selbst zugestellt'}
                    {x.return_code && ` · ${x.return_code} ${x.return_label}`}
                    {x.status === 'dropped' && x.return_note && ` · ${x.return_note}`}
                  </div>
                </td>
                <td className="num">{money(x.amount_cents)}</td>
                {debit && <td>{x.seq}</td>}
                <td>
                  <Badge tone={ITEM_TONE[x.status] ?? 'gray'}>{x.status_label}</Badge>
                </td>
                <td>
                  <div className="sepa-actions">
                    {x.status === 'submitted' && (
                      <button className="btn secondary small" onClick={() => run(() => api.post(`/api/sepa/items/${x.id}/paid`), debit ? 'Als bezahlt markiert' : 'Als ausgeführt markiert')}>
                        {debit ? 'Bezahlt' : 'Ausgeführt'}
                      </button>
                    )}
                    {debit && (x.status === 'submitted' || x.status === 'paid') && (
                      <button className="btn secondary small" onClick={() => setRet(x)}>
                        Rücklastschrift
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

export function RunsTab({ open, setOpen, onChanged }: { open: string; setOpen: (id: string) => void; onChanged: () => void }) {
  const [kind, setKind] = useState('');
  const list = useLoad(() => api.get(`/api/sepa/runs${kind ? `?kind=${kind}` : ''}`), [kind]);
  return (
    <Panel wide title="Läufe" sub="Jeder Lauf ist eine Datei für die Bank. Bezahlte und zurückgegebene Lastschriften trägst du hier ein – die Rechnung folgt automatisch." tour="sepa-runs" actions={<Select value={kind} onChange={setKind} options={[['', 'Alle'], ['debit', 'Lastschriften'], ['transfer', 'Überweisungen']]} />}>
      {!list.data ? (
        <Spinner />
      ) : !list.data.length ? (
        <Empty>Noch keine Läufe.</Empty>
      ) : (
        <div className="cr-list">
          {list.data.map((r: any) => (
            <Item key={r.id} onClick={() => setOpen(r.id)} side={<><strong>{money(r.total_cents)}</strong> <Badge tone={RUN_TONE[r.status] ?? 'gray'}>{r.status_label}</Badge></>}>
              <strong>
                {r.kind_label} {ymdDe(r.exec_date)}
              </strong>{' '}
              <span className="muted small">{r.tx_count} Posten</span>
              <div className="cr-sub">
                angelegt {dt(r.created_at)}
                {r.submitted_at && ` · eingereicht ${dt(r.submitted_at)}`}
                {r.note && ` · ${r.note}`}
              </div>
            </Item>
          ))}
        </div>
      )}
      {open && <RunDialog id={open} onClose={() => setOpen('')} onChanged={() => (list.reload(), onChanged())} />}
    </Panel>
  );
}

// --- transfers ---------------------------------------------------------------------------------------------------------------------

type Line = { name: string; iban: string; bic: string; amount: string; reference: string };
const emptyLine = (): Line => ({ name: '', iban: '', bic: '', amount: '', reference: '' });

export function TransfersTab() {
  const { data, reload } = useLoad(() => api.get('/api/sepa/payables'), []);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [lines, setLines] = useState<Line[]>([]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  if (!data) return <Spinner />;
  const items: any[] = data.items;
  const fromBills = items.filter((p) => picked.has(p.receipt_id)).reduce((n, p) => n + p.amount_cents, 0);
  const fromLines = lines.reduce((n, l) => n + (parseEuro(l.amount) ?? 0), 0);
  const setLine = (i: number, k: keyof Line) => (v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const create = async () => {
    const bad = lines.findIndex((l) => parseEuro(l.amount) === null);
    if (bad >= 0) return act(() => Promise.reject(new Error(`Zeile ${bad + 1}: bitte einen Betrag wie 120,00 eingeben`)));
    const r = await act(() => api.post('/api/sepa/transfers', { execution_date: date, receipt_ids: [...picked], lines: lines.map((l) => ({ name: l.name, iban: l.iban, bic: l.bic, amount_cents: parseEuro(l.amount), reference: l.reference })) }), 'Überweisungsdatei erzeugt');
    if (r) {
      void download(r);
      setPicked(new Set());
      setLines([]);
      reload();
    }
  };
  return (
    <div className="cr-panels">
      <Panel title="Offene Eingangsrechnungen" sub={data.available ? 'Gebuchte, noch nicht bezahlte Belege aus der Buchhaltung. Bezahlt gilt ein Beleg erst, wenn der Bankabgleich die Zahlung findet.' : 'Die Buchhaltung ist hier nicht verfügbar – nutze die Auszahlungsliste.'} tour="sepa-transfers">
        {!items.length ? (
          <Empty>Keine offenen Eingangsrechnungen.</Empty>
        ) : (
          <div className="cr-list">
            {items.map((p) => (
              <Item key={p.receipt_id} tone={p.ok ? undefined : 'warn'} side={<strong>{money(p.amount_cents)}</strong>}>
                {p.ok ? (
                  <Check checked={picked.has(p.receipt_id)} onChange={(v) => setPicked((s) => { const n = new Set(s); if (v) n.add(p.receipt_id); else n.delete(p.receipt_id); return n; })} label={<><strong>{p.supplier || 'Lieferant'}</strong> · {p.invoice_no}</>} />
                ) : (
                  <span>
                    <strong>{p.supplier || 'Lieferant'}</strong> · {p.invoice_no}
                  </span>
                )}
                <div className="cr-sub">
                  {p.iban_masked || 'ohne IBAN'}
                  {p.due_date && ` · fällig ${ymdDe(p.due_date)}`}
                  {!p.ok && <span className="sepa-warn"> · {p.problems.join(', ')}</span>}
                </div>
              </Item>
            ))}
          </div>
        )}
      </Panel>
      <Panel title="Auszahlungsliste" sub="Weitere Empfänger von Hand, z. B. Erstattungen oder Honorare." actions={<button className="btn secondary" onClick={() => setLines((l) => [...l, emptyLine()])}>Zeile hinzufügen</button>}>
        {!lines.length && <p className="muted">Keine Zeilen.</p>}
        {lines.map((l, i) => (
          <div key={i} className="sepa-line">
            <div className="row">
              <Field label="Empfänger">
                <Input value={l.name} onChange={setLine(i, 'name')} maxLength={70} />
              </Field>
              <Field label="Betrag (€)">
                <Input value={l.amount} onChange={setLine(i, 'amount')} inputMode="decimal" placeholder="0,00" />
              </Field>
            </div>
            <div className="row">
              <Field label="IBAN">
                <Input value={l.iban} onChange={setLine(i, 'iban')} spellCheck={false} />
              </Field>
              <Field label="BIC (optional)">
                <Input value={l.bic} onChange={setLine(i, 'bic')} spellCheck={false} maxLength={11} />
              </Field>
            </div>
            <Field label="Verwendungszweck">
              <Input value={l.reference} onChange={setLine(i, 'reference')} maxLength={140} />
            </Field>
            <button className="btn secondary small" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              Zeile entfernen
            </button>
          </div>
        ))}
      </Panel>
      <Panel title="Datei erzeugen" sub="pain.001.001.09 von deinem eigenen Konto (SEPA → Einstellungen).">
        <Field label="Ausführungsdatum">
          <Input type="date" value={date} onChange={setDate} />
        </Field>
        <Facts
          rows={[
            ['Belege', `${picked.size} · ${money(fromBills)}`],
            ['Auszahlungsliste', `${lines.length} · ${money(fromLines)}`],
            ['Gesamt', <strong key="t">{money(fromBills + fromLines)}</strong>],
          ]}
        />
        <button className="btn sepa-wide" disabled={!picked.size && !lines.length} onClick={create} data-tour="sepa-transfer-create">
          Überweisungsdatei erzeugen
        </button>
      </Panel>
    </div>
  );
}
