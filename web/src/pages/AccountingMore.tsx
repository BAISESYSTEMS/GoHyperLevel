import { useEffect, useState } from 'react';
import { api, d, money } from '../api';
import { Icon } from '../icons';
import { act, Badge, Check, CodeBox, confirmAsk, Empty, Field, Input, Modal, pressable, Select, Spinner, Tabs, Textarea, toast, useLoad } from '../ui';
import { FileButton, dlHref, germanDate, signedMoney, ymdLocal } from './boCommon';
import { SortableGrid } from '../sortable/Sortable';

/** Buchhaltung, second half: bank, reports, export & period lock, chart of accounts, settings. */

const thisYear = () => new Date().getFullYear();

// --- bank -------------------------------------------------------------------------------------------------------------------

const T_STATUS: Record<string, [string, 'gray' | 'green' | 'red' | 'blue' | 'yellow']> = { open: ['Offen', 'blue'], matched: ['Vorschlag', 'yellow'], booked: ['Gebucht', 'green'], ignored: ['Ignoriert', 'gray'] };

export function BankTab({ accounts, onChange }: { accounts: any[]; onChange: () => void }) {
  const [filter, setFilter] = useState('todo');
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<any>();
  const [book, setBook] = useState<any>();
  const list = useLoad(() => api.get(`/api/accounting/bank/txns?status=${filter === 'all' ? '' : filter}${q ? `&q=${encodeURIComponent(q)}` : ''}`), [filter, q]);
  const rows: any[] = list.data?.txns ?? [];
  const refresh = () => (void list.reload(), onChange());
  const run = async (fn: () => Promise<unknown>, ok?: string) => (await act(fn, ok)) !== undefined && refresh();
  return (
    <>
      <div className="row" style={{ alignItems: 'center', marginBottom: 10 }}>
        <FileButton
          label="Kontoauszug importieren"
          accept=".csv,.txt,.xml,text/csv,text/xml,application/xml"
          secondary={false}
          tour="acc-bank-import"
          onFile={async (f) => {
            const r = await api.post('/api/accounting/bank/import', { name: f.name, data: f.data });
            toast(`${r.added} neue Umsätze, ${r.duplicates} schon bekannt, ${r.matched} zugeordnet${r.skipped ? `, ${r.skipped} übersprungen` : ''}`);
            refresh();
          }}
        />
        <button className="btn secondary" onClick={() => run(() => api.post('/api/accounting/bank/rematch'), 'Neu zugeordnet')}>
          <Icon name="refresh" /> Neu zuordnen
        </button>
        <div className="tabs" style={{ margin: 0, border: 0 }} data-tour="acc-bank-filter">
          {[['todo', `Zu erledigen${list.data ? ` (${list.data.todo})` : ''}`], ['booked', 'Gebucht'], ['ignored', 'Ignoriert'], ['all', 'Alle']].map(([k, l]) => (
            <button key={k} className={k === filter ? 'on' : ''} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ width: 200, marginLeft: 'auto' }}>
          <Input value={q} onChange={setQ} placeholder="Suchen …" />
        </div>
      </div>
      <p className="muted small">
        CSV-Export der Bank oder CAMT.053 (XML). Es gibt keine Bankanbindung (FinTS) – die Dateien lädst du selbst hoch; dieselbe Datei zweimal importieren erzeugt keine Dubletten. Vorschläge werden erst nach deinem Klick gebucht, auf das <strong>Bankdatum</strong>.
      </p>
      {list.loading && !list.data ? (
        <Spinner />
      ) : rows.length ? (
        <div className="table-wrap" data-tour="acc-bank-list">
          <table className="t">
            <thead>
              <tr>
                <th>Datum</th>
                <th>Gegenpartei und Zweck</th>
                <th className="num">Betrag</th>
                <th>Zuordnung</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{germanDate(t.booking_date)}</td>
                  <td>
                    <strong>{t.counterparty || '–'}</strong>
                    <div className="muted small" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }} title={t.purpose}>
                      {t.purpose}
                    </div>
                  </td>
                  <td className="num">{signedMoney(t.amount_cents)}</td>
                  <td>
                    <Badge tone={T_STATUS[t.status]?.[1]}>{T_STATUS[t.status]?.[0] ?? t.status}</Badge>
                    {t.match && (
                      <div className="small">
                        {t.match.kind === 'invoice' ? 'Rechnung' : 'Beleg'} <strong>{t.match.ref}</strong> {t.match.party ? `· ${t.match.party}` : ''}
                        <div className="muted">{t.match.partial ? 'Teilzahlung · ' : ''}{t.match.score} Punkte</div>
                      </div>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {['open', 'matched'].includes(t.status) && (
                      <>
                        {t.match && (
                          <button className="btn small" onClick={() => run(() => api.post(`/api/accounting/bank/txns/${t.id}/confirm`, {}), 'Gebucht')}>
                            Bestätigen
                          </button>
                        )}{' '}
                        <button className="btn small secondary" onClick={() => setPick(t)}>
                          {t.match ? 'Anderer Beleg' : 'Zuordnen'}
                        </button>{' '}
                        <button className="btn small secondary" onClick={() => setBook(t)}>
                          Buchen
                        </button>{' '}
                        <button className="btn small ghost" onClick={() => run(() => api.post(`/api/accounting/bank/txns/${t.id}/ignore`, {}))}>
                          Ignorieren
                        </button>
                      </>
                    )}
                    {t.status === 'ignored' && (
                      <button className="btn small secondary" onClick={() => run(() => api.post(`/api/accounting/bank/txns/${t.id}/reset`, {}))}>
                        Zurücksetzen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{filter === 'todo' ? 'Alles erledigt – oder noch kein Kontoauszug importiert.' : 'Keine Umsätze.'}</Empty>
      )}
      {pick && <PickModal txn={pick} onClose={() => setPick(undefined)} onDone={() => (setPick(undefined), refresh())} />}
      {book && <BookModal txn={book} accounts={accounts} onClose={() => setBook(undefined)} onDone={() => (setBook(undefined), refresh())} />}
    </>
  );
}

function PickModal({ txn, onClose, onDone }: { txn: any; onClose: () => void; onDone: () => void }) {
  const cands = useLoad(() => api.get(`/api/accounting/bank/candidates?direction=${txn.amount_cents > 0 ? 'in' : 'out'}`), []);
  const [q, setQ] = useState('');
  const list = ((cands.data ?? []) as any[]).filter((c) => !q || `${c.ref} ${c.party}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title={txn.amount_cents > 0 ? 'Rechnung zuordnen' : 'Beleg zuordnen'} onClose={onClose}>
      <p className="muted">
        {germanDate(txn.booking_date)} · {txn.counterparty} · <strong>{money(txn.amount_cents)}</strong>
      </p>
      <Input value={q} onChange={setQ} placeholder="Nummer oder Name suchen" />
      <div style={{ maxHeight: 340, overflowY: 'auto', marginTop: 10 }}>
        {cands.loading ? (
          <Spinner />
        ) : list.length ? (
          <table className="t">
            <tbody>
              {list.map((c) => (
                <tr key={`${c.kind}-${c.id}`}>
                  <td>
                    <strong>{c.ref}</strong>
                    <div className="muted small">{c.party}</div>
                  </td>
                  <td className="num">{money(c.amount_cents)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn small" onClick={async () => (await act(() => api.post(`/api/accounting/bank/txns/${txn.id}/confirm`, { kind: c.kind, id: c.id }), 'Gebucht')) && onDone()}>
                      Zuordnen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Keine offenen {txn.amount_cents > 0 ? 'Rechnungen' : 'Belege'}.</Empty>
        )}
      </div>
    </Modal>
  );
}

function BookModal({ txn, accounts, onClose, onDone }: { txn: any; accounts: any[]; onClose: () => void; onDone: () => void }) {
  const codes = useLoad(() => api.get('/api/accounting/tax-codes'), []);
  const [account, setAccount] = useState('');
  const [tax, setTax] = useState('none');
  const [text, setText] = useState('');
  const name = accounts.find((a) => a.number === account)?.name;
  return (
    <Modal
      title="Umsatz direkt buchen"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>Abbrechen</button>
          <button className="btn" onClick={async () => (await act(() => api.post(`/api/accounting/bank/txns/${txn.id}/book`, { account, tax_code: tax, text }), 'Gebucht')) && onDone()}>
            Buchen
          </button>
        </>
      }
    >
      <p className="muted">
        {germanDate(txn.booking_date)} · {txn.counterparty} · <strong>{money(txn.amount_cents)}</strong>
        <br />
        {txn.purpose}
      </p>
      <Field label={txn.amount_cents > 0 ? 'Ertragskonto / Gegenkonto' : 'Aufwandskonto / Gegenkonto'} hint={name}>
        <Input list="acc-accounts" value={account} onChange={setAccount} placeholder="z. B. 4970 für Bankgebühren" />
      </Field>
      <Field label="Steuer" hint="Bei Umsatz-/Vorsteuer-Schlüsseln ist der Bankbetrag brutto; die Steuer wird herausgerechnet.">
        <Select value={tax} onChange={setTax} options={(codes.data ?? [{ code: 'none', label: 'ohne Steuer' }]).map((c: any) => [c.code, c.label] as [string, string])} />
      </Field>
      <Field label="Buchungstext (optional)">
        <Input value={text} onChange={setText} />
      </Field>
    </Modal>
  );
}

// --- reports --------------------------------------------------------------------------------------------------------------

const REPORTS: [string, string][] = [
  ['euer', 'EÜR'],
  ['ustva', 'USt-Voranmeldung'],
  ['susa', 'SuSa'],
  ['bwa', 'BWA'],
  ['open', 'Offene Posten'],
];

export function ReportsTab() {
  const [rep, setRep] = useState('euer');
  const [from, setFrom] = useState(`${thisYear()}-01-01`);
  const [to, setTo] = useState(`${thisYear()}-12-31`);
  return (
    <>
      <Tabs tabs={REPORTS} value={rep} onChange={setRep} />
      {['euer', 'susa', 'bwa'].includes(rep) && (
        <div className="row" style={{ alignItems: 'flex-end' }} data-tour="acc-range">
          <div style={{ width: 150 }}>
            <Field label="Von">
              <Input type="date" value={from} onChange={setFrom} />
            </Field>
          </div>
          <div style={{ width: 150 }}>
            <Field label="Bis">
              <Input type="date" value={to} onChange={setTo} />
            </Field>
          </div>
        </div>
      )}
      {rep === 'euer' && <Euer from={from} to={to} />}
      {rep === 'ustva' && <Ustva />}
      {rep === 'susa' && <Susa from={from} to={to} />}
      {rep === 'bwa' && <Bwa from={from} to={to} />}
      {rep === 'open' && <OpenItems />}
      <p className="muted small">Übersicht zur Vorbereitung für den Steuerberater – keine Steuererklärung, keine Übermittlung an das Finanzamt.</p>
    </>
  );
}

function Euer({ from, to }: { from: string; to: string }) {
  const r = useLoad(() => api.get(`/api/accounting/reports/euer?from=${from}&to=${to}`), [from, to]);
  const x = r.data;
  if (!x) return r.error ? <p style={{ color: 'var(--red)' }}>{r.error}</p> : <Spinner />;
  const block = (title: string, b: any, extra: [string, number][]) => (
    <div className="card" style={{ marginBottom: 14 }}>
      <h2>{title}</h2>
      <table className="t">
        <tbody>
          {b.groups.map((g: any) => (
            <GroupRows key={g.group} label={g.label} cents={g.net_cents} accounts={g.accounts.map((a: any) => ({ ...a, cents: a.net_cents }))} />
          ))}
          {extra.filter(([, c]) => c).map(([l, c]) => (
            <tr key={l}>
              <td colSpan={2}>{l}</td>
              <td className="num">{money(c)}</td>
            </tr>
          ))}
          <tr className="total">
            <td colSpan={2}>
              <strong>Summe {title.toLowerCase()}</strong>
            </td>
            <td className="num">
              <strong>{money(b.total_cents)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
  return (
    <div data-tour="acc-euer">
      <p className="muted small">{x.method} · {x.vat_mode === 'small' ? 'Kleinunternehmer (ohne Umsatzsteuer)' : 'Regelbesteuerung: Umsatzsteuer und Vorsteuer sind Einnahmen bzw. Ausgaben'}</p>
      {block('Betriebseinnahmen', x.income, [['Vereinnahmte Umsatzsteuer', x.income.vat_collected_cents], ['Erstattete Umsatzsteuer', x.income.vat_refunded_cents]])}
      {block('Betriebsausgaben', x.expenses, [['Gezahlte Vorsteuer', x.expenses.vat_paid_cents], ['An das Finanzamt gezahlte Umsatzsteuer', x.expenses.vat_to_tax_office_cents]])}
      <SortableGrid id="accounting-more.stats" className="stats">
        <div className="card stat">
          <div className="muted">Gewinn / Verlust</div>
          <div className="stat-value">{signedMoney(x.profit_cents)}</div>
          <div className="muted small">ohne Steuerposten {money(x.profit_net_cents)}</div>
        </div>
        <div className="card stat">
          <div className="muted">Anlagekäufe (netto)</div>
          <div className="stat-value">{money(x.investments_cents)}</div>
          <div className="muted small">keine Abschreibungsplanung</div>
        </div>
        <div className="card stat">
          <div className="muted">Privatentnahmen / -einlagen</div>
          <div className="stat-value">{money(x.private_withdrawals_cents)}</div>
          <div className="muted small">Einlagen {money(x.private_deposits_cents)}</div>
        </div>
      </SortableGrid>
    </div>
  );
}

function GroupRows({ label, cents, accounts }: { label: string; cents: number; accounts: { account: string; name: string; cents: number }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="click" {...pressable(() => setOpen(!open))}>
        <td colSpan={2}>
          {open ? '▾' : '▸'} <strong>{label}</strong>
        </td>
        <td className="num">
          <strong>{money(cents)}</strong>
        </td>
      </tr>
      {open &&
        accounts.map((a) => (
          <tr key={a.account}>
            <td className="mono" style={{ paddingLeft: 28 }}>{a.account}</td>
            <td>{a.name}</td>
            <td className="num">{money(a.cents)}</td>
          </tr>
        ))}
    </>
  );
}

function Ustva() {
  const [kind, setKind] = useState('quarter');
  const [year, setYear] = useState(String(thisYear()));
  const [month, setMonth] = useState(String(new Date().getMonth() + 1).padStart(2, '0'));
  const [quarter, setQuarter] = useState(String(Math.floor(new Date().getMonth() / 3) + 1));
  const period = kind === 'month' ? `${year}-${month}` : kind === 'quarter' ? `${year}-Q${quarter}` : year;
  const r = useLoad(() => api.get(`/api/accounting/reports/ustva?period=${period}`), [period]);
  const x = r.data;
  return (
    <div data-tour="acc-ustva">
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ width: 150 }}>
          <Field label="Zeitraum">
            <Select value={kind} onChange={setKind} options={[['month', 'Monat'], ['quarter', 'Quartal'], ['year', 'Jahr']]} />
          </Field>
        </div>
        <div style={{ width: 100 }}>
          <Field label="Jahr">
            <Input type="number" value={year} onChange={setYear} />
          </Field>
        </div>
        {kind === 'month' && (
          <div style={{ width: 150 }}>
            <Field label="Monat">
              <Select value={month} onChange={setMonth} options={Array.from({ length: 12 }, (_, i) => [String(i + 1).padStart(2, '0'), new Date(2000, i, 1).toLocaleDateString('de-DE', { month: 'long' })] as [string, string])} />
            </Field>
          </div>
        )}
        {kind === 'quarter' && (
          <div style={{ width: 120 }}>
            <Field label="Quartal">
              <Select value={quarter} onChange={setQuarter} options={['1', '2', '3', '4'].map((q) => [q, `${q}. Quartal`] as [string, string])} />
            </Field>
          </div>
        )}
      </div>
      {!x ? (
        r.error ? <p style={{ color: 'var(--red)' }}>{r.error}</p> : <Spinner />
      ) : (
        <>
          <p className="muted small">{x.label} · {x.method}{x.small_business ? ' · Kleinunternehmer: keine Umsatzsteuer-Voranmeldung nötig' : ''}</p>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Kz.</th>
                  <th>Bezeichnung</th>
                  <th className="num">Bemessungsgrundlage</th>
                  <th className="num">Steuer</th>
                </tr>
              </thead>
              <tbody>
                {x.lines.map((l: any) => (
                  <tr key={l.kz}>
                    <td className="mono">{l.kz}</td>
                    <td>{l.label}</td>
                    <td className="num">{l.base_cents === undefined ? '' : money(l.base_cents)}</td>
                    <td className="num">{l.tax_cents === undefined ? '' : money(l.tax_cents)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td />
                  <td>
                    <strong>Umsatzsteuer {money(x.output_tax_cents)} − Vorsteuer {money(x.input_tax_cents)}</strong>
                  </td>
                  <td />
                  <td className="num">
                    <strong>{money(x.balance_cents)}</strong>
                    <div className="muted small">{x.balance_cents >= 0 ? 'Zahllast (Kz. 83)' : 'Erstattung (Kz. 83)'}</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted small">{x.note}</p>
        </>
      )}
    </div>
  );
}

function Susa({ from, to }: { from: string; to: string }) {
  const r = useLoad(() => api.get(`/api/accounting/reports/susa?from=${from}&to=${to}`), [from, to]);
  const x = r.data;
  if (!x) return r.error ? <p style={{ color: 'var(--red)' }}>{r.error}</p> : <Spinner />;
  if (!x.rows.length) return <Empty>Keine Buchungen im Zeitraum.</Empty>;
  return (
    <div className="table-wrap" data-tour="acc-susa">
      <table className="t">
        <thead>
          <tr>
            <th>Konto</th>
            <th className="num">Eröffnung</th>
            <th className="num">Soll</th>
            <th className="num">Haben</th>
            <th className="num">Saldo</th>
          </tr>
        </thead>
        <tbody>
          {x.rows.map((a: any) => (
            <tr key={a.account}>
              <td>
                <span className="mono">{a.account}</span> {a.name}
              </td>
              <td className="num">{money(a.opening_cents)}</td>
              <td className="num">{money(a.debit_cents)}</td>
              <td className="num">{money(a.credit_cents)}</td>
              <td className="num">{money(a.closing_cents)}</td>
            </tr>
          ))}
          <tr className="total">
            <td>
              <strong>Summe</strong>
            </td>
            <td className="num">{money(x.totals.opening_cents)}</td>
            <td className="num">
              <strong>{money(x.totals.debit_cents)}</strong>
            </td>
            <td className="num">
              <strong>{money(x.totals.credit_cents)}</strong>
            </td>
            <td className="num">{money(x.totals.closing_cents)}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted small" style={{ padding: '0 12px' }}>Saldo: Soll positiv, Haben negativ. Bestandskonten werden vorgetragen, Erfolgskonten beginnen mit dem Wirtschaftsjahr bei null.</p>
    </div>
  );
}

function Bwa({ from, to }: { from: string; to: string }) {
  const r = useLoad(() => api.get(`/api/accounting/reports/bwa?from=${from}&to=${to}`), [from, to]);
  const x = r.data;
  if (!x) return r.error ? <p style={{ color: 'var(--red)' }}>{r.error}</p> : <Spinner />;
  const t = x.totals;
  return (
    <div className="card" data-tour="acc-bwa">
      <table className="t">
        <tbody>
          {x.groups.map((g: any) => (
            <GroupRows key={g.group} label={g.label} cents={g.type === 'expense' ? -g.cents : g.cents} accounts={g.accounts.map((a: any) => ({ ...a, cents: g.type === 'expense' ? -a.cents : a.cents }))} />
          ))}
          <tr className="total">
            <td colSpan={2}>
              <strong>Rohertrag</strong>
            </td>
            <td className="num">{money(t.gross_profit_cents)}</td>
          </tr>
          <tr className="total">
            <td colSpan={2}>
              <strong>Betriebsergebnis</strong>
            </td>
            <td className="num">
              <strong>{signedMoney(t.result_cents)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">Aufwand wird negativ gezeigt. Einfache BWA nach Kontengruppen – keine Branchen-BWA.</p>
    </div>
  );
}

function OpenItems() {
  const [type, setType] = useState('receivable');
  const [asof, setAsof] = useState(ymdLocal());
  const r = useLoad(() => api.get(`/api/accounting/reports/open-items?type=${type}&asof=${asof}`), [type, asof]);
  const x = r.data;
  return (
    <div data-tour="acc-open-items">
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ width: 200 }}>
          <Field label="Art">
            <Select value={type} onChange={setType} options={[['receivable', 'Forderungen (Kunden)'], ['payable', 'Verbindlichkeiten (Lieferanten)']]} />
          </Field>
        </div>
        <div style={{ width: 150 }}>
          <Field label="Stand">
            <Input type="date" value={asof} onChange={setAsof} />
          </Field>
        </div>
      </div>
      {!x ? (
        r.error ? <p style={{ color: 'var(--red)' }}>{r.error}</p> : <Spinner />
      ) : x.items.length ? (
        <>
          <SortableGrid id="accounting-more.stats-2" className="stats">
            <div className="card stat"><div className="muted">Offen gesamt</div><div className="stat-value">{money(x.total_cents)}</div></div>
            <div className="card stat"><div className="muted">Nicht fällig</div><div className="stat-value">{money(x.aging.current_cents)}</div></div>
            <div className="card stat"><div className="muted">1–30 Tage überfällig</div><div className="stat-value">{money(x.aging.d1_30_cents)}</div></div>
            <div className="card stat"><div className="muted">über 30 Tage</div><div className="stat-value">{money(x.aging.d31_60_cents + x.aging.d61_plus_cents)}</div></div>
          </SortableGrid>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Beleg</th>
                  <th>{type === 'receivable' ? 'Kunde' : 'Lieferant'}</th>
                  <th>Datum</th>
                  <th>Fällig</th>
                  <th className="num">Offen</th>
                  <th className="num">Überfällig</th>
                </tr>
              </thead>
              <tbody>
                {x.items.map((i: any) => (
                  <tr key={`${i.account}-${i.doc_ref}`}>
                    <td>{i.doc_ref || '–'}</td>
                    <td>{i.party || '–'}</td>
                    <td>{germanDate(i.date)}</td>
                    <td>{germanDate(i.due_date)}</td>
                    <td className="num">{money(i.open_cents)}</td>
                    <td className="num">{i.overdue_days ? <Badge tone="red">{i.overdue_days} Tage</Badge> : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <Empty>Keine offenen Posten.</Empty>
      )}
    </div>
  );
}

// --- export and period lock ------------------------------------------------------------------------------------------------

export function ExportTab({ st, onChange }: { st: any; onChange: () => void }) {
  const [from, setFrom] = useState(`${thisYear()}-01-01`);
  const [to, setTo] = useState(`${thisYear()}-12-31`);
  const prev = useLoad(() => api.get(`/api/accounting/datev/preview?from=${from}&to=${to}`), [from, to]);
  const [year, setYear] = useState(thisYear());
  const periods = useLoad(() => api.get(`/api/accounting/periods?year=${year}`), [year]);
  const [through, setThrough] = useState('');
  const p = prev.data;
  const lockedCount = (periods.data?.periods ?? []).filter((x: any) => x.locked).length;
  return (
    <>
      <div className="card" data-tour="acc-datev">
        <h2>DATEV-Export für den Steuerberater</h2>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ width: 150 }}>
            <Field label="Von">
              <Input type="date" value={from} onChange={setFrom} />
            </Field>
          </div>
          <div style={{ width: 150 }}>
            <Field label="Bis">
              <Input type="date" value={to} onChange={setTo} />
            </Field>
          </div>
        </div>
        {p ? (
          <>
            <p>
              <strong>{p.entries}</strong> Buchungen, <strong>{p.rows}</strong> Zeilen · <span className="muted">{p.format}</span>
            </p>
            {(p.warnings ?? []).map((w: string) => (
              <p key={w} className="bo-warn">{w}</p>
            ))}
          </>
        ) : prev.error ? (
          <p style={{ color: 'var(--red)' }}>{prev.error}</p>
        ) : (
          <Spinner />
        )}
        {!st.datev_ready && <p className="bo-warn">Bitte zuerst Berater- und Mandantennummer unter „Einstellungen → DATEV“ eintragen.</p>}
        <div className="row">
          <a className={`btn${!st.datev_ready || !p?.entries ? ' disabled' : ''}`} aria-disabled={!st.datev_ready || !p?.entries} href={st.datev_ready && p?.entries ? dlHref('/api/accounting/datev/export', { from, to }) : undefined} data-tour="acc-datev-export">
            <Icon name="download" /> Buchungsstapel (EXTF, CSV)
          </a>
          <a className="btn secondary" href={dlHref('/api/accounting/datev/documents', { from, to })} data-tour="acc-datev-docs">
            <Icon name="download" /> Belege (ZIP mit document.xml)
          </a>
        </div>
        <p className="muted small">
          Format: EXTF 700, Buchungsstapel (Kategorie 21, Formatversion 13), Windows-1252, Semikolon, Steuer über BU-Schlüssel, Beleglink (BEDI) zu den Belegen. Das Beleg-ZIP enthält die DATEV-<code>document.xml</code> (Belegtransfer / Unternehmen online) mit Rechnungseingang und -ausgang. Keine Kostenstellen. Bitte den Import vorab mit dem Steuerberater testen – der Export ist nicht DATEV-zertifiziert.
        </p>
      </div>
      <div className="card" data-tour="acc-lock">
        <h2>Festschreibung</h2>
        <p className="muted">
          Festgeschriebene Monate sind abgeschlossen: Dort lässt sich nichts mehr buchen, auch kein Storno – Korrekturen kommen in den laufenden Monat. <strong>Das kann nicht rückgängig gemacht werden.</strong>
        </p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ width: 110 }}>
            <Field label="Jahr">
              <Input type="number" value={year} onChange={(v) => setYear(Number(v) || thisYear())} />
            </Field>
          </div>
        </div>
        {periods.data ? (
          <div className="bo-months">
            {periods.data.periods.map((m: any) => (
              <button key={m.period} type="button" className={`bo-month${m.locked ? ' locked' : ''}${through === m.period ? ' picked' : ''}`} disabled={m.locked} onClick={() => setThrough(through === m.period ? '' : m.period)} title={m.locked ? `Festgeschrieben von ${m.locked_by ?? ''} am ${d(m.locked_at)}` : `${m.entries} Buchungen`}>
                {new Date(year, Number(m.period.slice(5)) - 1, 1).toLocaleDateString('de-DE', { month: 'short' })}
                <small>{m.locked ? <Icon name="lock" size={12} /> : `${m.entries}`}</small>
              </button>
            ))}
          </div>
        ) : (
          <Spinner />
        )}
        <div style={{ marginTop: 12 }}>
          <button
            className="btn danger"
            disabled={!through}
            onClick={async () => {
              if (!confirmAsk(`Alle Monate bis einschließlich ${through.slice(5)}/${through.slice(0, 4)} festschreiben? Das lässt sich nicht rückgängig machen.`)) return;
              if (await act(() => api.post('/api/accounting/periods/lock', { through }), 'Festgeschrieben')) (setThrough(''), void periods.reload(), onChange());
            }}
          >
            <Icon name="lock" /> {through ? `Bis ${through.slice(5)}/${through.slice(0, 4)} festschreiben` : 'Monat wählen'}
          </button>
          <span className="muted small" style={{ marginLeft: 10 }}>{lockedCount} von 12 Monaten {year} sind festgeschrieben.</span>
        </div>
      </div>
    </>
  );
}

// --- chart of accounts -------------------------------------------------------------------------------------------------------

const A_TYPE: Record<string, string> = { asset: 'Aktiva', liability: 'Passiva', equity: 'Eigenkapital', income: 'Ertrag', expense: 'Aufwand' };

export function AccountsTab({ onChange }: { onChange: () => void }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [add, setAdd] = useState(false);
  const list = useLoad(() => api.get(`/api/accounting/accounts?${new URLSearchParams({ ...(q ? { q } : {}), ...(type ? { type } : {}) })}`), [q, type]);
  const rows: any[] = list.data ?? [];
  return (
    <>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ width: 220 }}>
          <Field label="Suche">
            <Input value={q} onChange={setQ} placeholder="Nummer oder Name" />
          </Field>
        </div>
        <div style={{ width: 160 }}>
          <Field label="Art">
            <Select value={type} onChange={setType} placeholder="Alle" options={Object.entries(A_TYPE)} />
          </Field>
        </div>
        <div style={{ marginLeft: 'auto', marginBottom: 12 }}>
          <button className="btn" onClick={() => setAdd(true)}>
            Konto anlegen
          </button>
        </div>
      </div>
      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <div className="table-wrap" data-tour="acc-accounts">
          <table className="t">
            <thead>
              <tr>
                <th>Konto</th>
                <th>Name</th>
                <th>Art</th>
                <th>Gruppe</th>
                <th className="num">Buchungen</th>
                <th>Aktiv</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} style={a.active ? undefined : { opacity: 0.55 }}>
                  <td className="mono">{a.number}</td>
                  <td>
                    {a.name} {a.custom ? <Badge tone="blue">eigenes</Badge> : null} {a.kind ? <Badge>{a.kind}</Badge> : null}
                  </td>
                  <td>{A_TYPE[a.type] ?? a.type}</td>
                  <td className="muted small">{a.grp}</td>
                  <td className="num">{a.lines}</td>
                  <td>
                    <input type="checkbox" checked={!!a.active} aria-label={`${a.number} aktiv`} onChange={async (e) => (await act(() => api.patch(`/api/accounting/accounts/${a.id}`, { active: e.target.checked }))) && (void list.reload(), onChange())} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {add && <AddAccount onClose={() => setAdd(false)} onDone={() => (setAdd(false), void list.reload(), onChange())} />}
    </>
  );
}

function AddAccount({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ number: '', name: '', type: 'expense', grp: '' });
  return (
    <Modal
      title="Konto anlegen"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>Abbrechen</button>
          <button className="btn" onClick={async () => (await act(() => api.post('/api/accounting/accounts', f), 'Konto angelegt')) && onDone()}>Anlegen</button>
        </>
      }
    >
      <div className="grid2">
        <Field label="Kontonummer (4–8 Ziffern)">
          <Input value={f.number} onChange={(v) => setF({ ...f, number: v })} />
        </Field>
        <Field label="Art">
          <Select value={f.type} onChange={(v) => setF({ ...f, type: v })} options={Object.entries(A_TYPE)} />
        </Field>
      </div>
      <Field label="Name">
        <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} />
      </Field>
      <Field label="Gruppe in der BWA (optional)">
        <Input value={f.grp} onChange={(v) => setF({ ...f, grp: v })} placeholder="z. B. other_costs" />
      </Field>
    </Modal>
  );
}

// --- settings ----------------------------------------------------------------------------------------------------------------

export function SettingsTab({ onChange }: { onChange: () => void }) {
  const s = useLoad(() => api.get('/api/accounting/settings'), []);
  const inbound = useLoad(() => api.get('/api/accounting/inbound'), []);
  const [f, setF] = useState<any>();
  useEffect(() => {
    const x = s.data;
    if (x && !f) setF({ vat_mode: x.vat_mode, vat_method: x.vat_method, fy_start_month: String(x.fy_start_month), autopost: { ...x.autopost }, mapping: { ...x.mapping }, datev: { ...x.datev }, receipts: { auto_extract: x.receipts.auto_extract, allowed_senders: (x.receipts.allowed_senders ?? []).join('\n') } });
  }, [s.data]);
  if (!f || !s.data) return s.error ? <p style={{ color: 'var(--red)' }}>{s.error}</p> : <Spinner />;
  const labels: Record<string, string> = s.data.mapping_labels ?? {};
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const nest = (k: string, kk: string, v: any) => setF((x: any) => ({ ...x, [k]: { ...x[k], [kk]: v } }));
  const save = async () => {
    const body = { ...f, fy_start_month: Number(f.fy_start_month), datev: { ...f.datev, account_length: Number(f.datev.account_length) }, receipts: { auto_extract: f.receipts.auto_extract, allowed_senders: f.receipts.allowed_senders.split(/[\s,;]+/).filter(Boolean) } };
    if (await act(() => api.put('/api/accounting/settings', body), 'Gespeichert')) (void s.reload(), onChange());
  };
  return (
    <>
      <div className="card">
        <h2>Umsatzsteuer und Wirtschaftsjahr</h2>
        <p className="muted small">Kontenrahmen: <strong>{s.data.standard.toUpperCase()}</strong> (nach der ersten Buchung nicht mehr änderbar).</p>
        <div className="grid3">
          <Field label="Umsatzsteuer">
            <Select value={f.vat_mode} onChange={(v) => set('vat_mode', v)} options={[['regular', 'Regelbesteuerung'], ['small', 'Kleinunternehmer (§ 19)']]} />
          </Field>
          <Field label="Versteuerung" hint="Soll: nach Rechnungsdatum. Ist: erst bei Zahlung.">
            <Select value={f.vat_method} onChange={(v) => set('vat_method', v)} options={[['soll', 'Soll-Versteuerung'], ['ist', 'Ist-Versteuerung']]} />
          </Field>
          <Field label="Wirtschaftsjahr beginnt im">
            <Select value={f.fy_start_month} onChange={(v) => set('fy_start_month', v)} options={Array.from({ length: 12 }, (_, i) => [String(i + 1), new Date(2000, i, 1).toLocaleDateString('de-DE', { month: 'long' })] as [string, string])} />
          </Field>
        </div>
      </div>
      <div className="card" data-tour="acc-autopost">
        <h2>Automatisch buchen</h2>
        <p className="muted small">Was HyperLevel selbst bucht – jede Buchung hat einen eindeutigen Schlüssel und entsteht nie doppelt.</p>
        <Check checked={f.autopost.invoices} onChange={(v) => nest('autopost', 'invoices', v)} label="Rechnungen beim Versand (Forderung, Erlös, Umsatzsteuer; Storno bei stornierten Rechnungen)" />
        <Check checked={f.autopost.payments} onChange={(v) => nest('autopost', 'payments', v)} label="Zahlungen auf Rechnungen (Bank oder Stripe-Verrechnungskonto)" />
        <Check checked={f.autopost.stripe} onChange={(v) => nest('autopost', 'stripe', v)} label="Stripe: Auszahlungen, Gebühren und Rückerstattungen" />
        <Check checked={f.autopost.skip_linked} onChange={(v) => nest('autopost', 'skip_linked', v)} label="Rechnungen überspringen, die mit Norman verknüpft sind (sonst doppelt gebucht)" />
      </div>
      <div className="card" data-tour="acc-mapping">
        <h2>Wichtige Konten</h2>
        <p className="muted small">Diese Konten nutzen die automatischen Buchungen. Die Vorgabe passt zum gewählten Kontenrahmen.</p>
        <div className="grid3">
          {Object.entries(labels).map(([k, label]) => (
            <Field key={k} label={label}>
              <Input list="acc-accounts" value={f.mapping[k] ?? ''} onChange={(v) => nest('mapping', k, v)} />
            </Field>
          ))}
        </div>
      </div>
      <div className="card" data-tour="acc-datev-settings">
        <h2>DATEV</h2>
        <div className="grid2">
          <Field label="Beraternummer">
            <Input value={f.datev.berater} onChange={(v) => nest('datev', 'berater', v)} />
          </Field>
          <Field label="Mandantennummer">
            <Input value={f.datev.mandant} onChange={(v) => nest('datev', 'mandant', v)} />
          </Field>
          <Field label="Sachkontenlänge" hint="Meist 4. Kontonummern werden mit Nullen aufgefüllt.">
            <Input type="number" value={f.datev.account_length} onChange={(v) => nest('datev', 'account_length', v)} />
          </Field>
          <Field label="Bezeichnung des Stapels (max. 30 Zeichen)">
            <Input value={f.datev.name} onChange={(v) => nest('datev', 'name', v)} />
          </Field>
        </div>
      </div>
      <div className="card" data-tour="acc-inbound">
        <h2>Belegeingang</h2>
        <Check checked={f.receipts.auto_extract} onChange={(v) => nest('receipts', 'auto_extract', v)} label="Fotos und PDFs automatisch von der KI auslesen (braucht eine KI-Verbindung mit Bilderkennung)" />
        <Field label="Erlaubte Absender (eine Adresse oder @domain pro Zeile; leer = jeder mit dem Schlüssel)">
          <Textarea value={f.receipts.allowed_senders} onChange={(v) => nest('receipts', 'allowed_senders', v)} rows={3} />
        </Field>
        <p className="muted small">
          Weiterleitung per E-Mail: Ein Weiterleitungsdienst (Cloudflare Email Workers, Make, Zapier, n8n …) sendet Anhänge als JSON an diese Adresse. Der Schlüssel gehört nur dir – bei Verdacht erneuern.
        </p>
        {inbound.data && (
          <div className="row" style={{ alignItems: 'center' }}>
            <div className="grow">
              <CodeBox text={inbound.data.url} />
            </div>
            <button className="btn secondary" onClick={async () => confirmAsk('Neuen Schlüssel erzeugen? Die alte Adresse funktioniert dann nicht mehr.') && (await act(() => api.post('/api/accounting/inbound/rotate'), 'Erneuert')) && void inbound.reload()}>
              Schlüssel erneuern
            </button>
          </div>
        )}
      </div>
      <button className="btn" onClick={save} data-tour="acc-save">
        Speichern
      </button>
    </>
  );
}
