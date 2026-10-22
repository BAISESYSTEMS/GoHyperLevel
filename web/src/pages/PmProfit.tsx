import { useState } from 'react';
import { api, currentLocation, money } from '../api';
import { Icon } from '../icons';
import { can, useSession } from '../session';
import { Check, Empty, Field, Input, Link, Modal, PageHead, Spinner, act, confirmAsk, navigate, useLoad } from '../ui';
import { BudgetMeters, CostsPanel, STATE_TEXT, hoursText, type BudgetStatus } from './PmBudget';
import { centsToEuros, eurosToCents, fmtMonth } from './pm-format';
import './costing.css';
import { getLocale, intlLocale, useT } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';
import { SortableGrid } from '../sortable/Sortable';

/**
 * „Rentabilität“ (docs/projects.md#job-costing-and-retainers): revenue, cost and margin per project or client with CSV, the budgets
 * of all projects, retainers with the month close, and the internal cost rates and external costs. Area "Rechnungen & Produkte";
 * margins and cost rates only for the Leitung.
 */

const TABS = ['', 'budgets', 'retainer', 'kosten'];

export function PmProfit({ tab = '' }: { tab?: string }) {
  const t = useT('pm');
  const cur = TABS.includes(tab) ? tab : '';
  const on = (k: string) => (cur === k ? 'on' : '');
  return (
    <div className="jc">
      <PageHead title={t('Rentabilität')} sub={t('Umsatz, Kosten und Marge je Projekt und Kunde – mit Budgets, Retainern und Fremdkosten.')}>
        <Link to="time/billing" className="btn secondary">
          <Icon name="schedule" size={14} /> {t('Abrechnung')}
        </Link>
      </PageHead>
      <nav className="tabs jc-tabs" aria-label={t('Rentabilität')}>
        <Link to="profit" className={on('')} tour="jc-tab-overview">
          {t('Übersicht')}
        </Link>
        <Link to="profit/budgets" className={on('budgets')} tour="jc-tab-budgets">
          {t('Budgets')}
        </Link>
        <Link to="profit/retainer" className={on('retainer')} tour="jc-tab-retainer">
          {t('Retainer')}
        </Link>
        <Link to="profit/kosten" className={on('kosten')} tour="jc-tab-costs">
          {t('Kosten')}
        </Link>
      </nav>
      {cur === '' ? <Overview /> : cur === 'budgets' ? <Budgets /> : cur === 'retainer' ? <Retainers /> : <Costs />}
    </div>
  );
}

// --- overview ---------------------------------------------------------------------------------------------------------------------

interface Row {
  key: string;
  label: string;
  color?: string;
  project_id?: string | null;
  hours: number;
  billable_hours: number;
  revenue_invoiced_cents: number;
  revenue_unbilled_cents: number;
  revenue_retainer_open_hours: number;
  revenue_cents: number;
  time_cost_cents: number;
  external_cost_cents: number;
  cost_cents: number;
  margin_cents: number;
  margin_percent: number | null;
  missing_cost_rate: boolean;
  budget_state?: string;
}

const pct = (p: number | null) => {
  if (p === null) return '–';
  const text = p.toLocaleString(intlLocale(), { maximumFractionDigits: 1 });
  return getLocale() === SOURCE_LOCALE ? `${text} %` : `${text}%`;
};
const firstOfYear = () => `${new Date().getFullYear()}-01-01`;

function Overview() {
  const t = useT('pm');
  const session = useSession();
  const manager = can(session, 'settings');
  const [f, setF] = useState({ group: 'project', from: firstOfYear(), to: '' });
  const qs = new URLSearchParams({
    group: f.group,
    ...(f.from ? { from: f.from } : {}),
    ...(f.to ? { to: f.to } : {}),
  }).toString();
  const r = useLoad(() => (manager ? api.get<{ rows: Row[]; totals: Omit<Row, 'key' | 'label'> }>(`/api/pm/billing/profitability?${qs}`) : Promise.resolve(null)), [qs, manager]);
  if (!manager) return <Empty>{t('Umsatz, Kosten und Marge sieht die Leitung (Bereich „Einstellungen“). Budgets, Retainer und Fremdkosten findest du in den anderen Reitern.')}</Empty>;
  const tot = r.data?.totals;
  return (
    <div data-tour="jc-profit">
      <div className="jc-bar">
        <Field label={t('Gruppieren')}>
          <select value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })}>
            <option value="project">{t('nach Projekt')}</option>
            <option value="client">{t('nach Kunde')}</option>
          </select>
        </Field>
        <Field label={t('Von')}>
          <Input type="date" value={f.from} onChange={(v) => setF({ ...f, from: v })} />
        </Field>
        <Field label={t('Bis')}>
          <Input type="date" value={f.to} onChange={(v) => setF({ ...f, to: v })} />
        </Field>
        <span className="grow" />
        <a className="btn secondary" href={`/api/pm/billing/profitability/export.csv?${qs}&locationId=${encodeURIComponent(currentLocation())}`} data-tour="jc-profit-csv">
          <Icon name="csv" size={14} /> CSV
        </a>
      </div>
      {!r.data || !tot ? (
        <Spinner />
      ) : (
        <>
          <SortableGrid id="pm-profit.kpis" className="jc-kpis">
            <div>
              <b>{money(tot.revenue_cents)}</b>
              <span>{t('Umsatz (')}{money(tot.revenue_invoiced_cents)} {t('abgerechnet)')}</span>
            </div>
            <div>
              <b>{money(tot.cost_cents)}</b>
              <span>{t('Kosten (Zeit + Fremdkosten)')}</span>
            </div>
            <div>
              <b className={tot.margin_cents < 0 ? 'jc-neg' : ''}>{money(tot.margin_cents)}</b>
              <span>{t('Marge')}</span>
            </div>
            <div>
              <b className={(tot.margin_percent ?? 0) < 0 ? 'jc-neg' : ''}>{pct(tot.margin_percent)}</b>
              <span>{t('Marge in % vom Umsatz')}</span>
            </div>
          </SortableGrid>
          {tot.missing_cost_rate && (
            <p className="note-box warn">
              {t('Für manche Personen fehlt ein interner Kostensatz – ihre Zeit zählt mit 0 € Kosten.')} <Link to="profit/kosten">{t('Kostensätze festlegen')}</Link>
            </p>
          )}
          {r.data.rows.length === 0 ? (
            <Empty>{t('Im Zeitraum gibt es keine Zeiten, Kosten oder Retainer-Rechnungen.')}</Empty>
          ) : (
            <div className="table-wrap">
              <table className="jc-table stack">
                <thead>
                  <tr>
                    <th>{f.group === 'client' ? t('Kunde') : t('Projekt')}</th>
                    <th className="r">{t('Stunden')}</th>
                    <th className="r">{t('Umsatz abgerechnet')}</th>
                    <th className="r">{t('Umsatz offen')}</th>
                    <th className="r">{t('Kosten')}</th>
                    <th className="r">{t('Marge')}</th>
                    <th className="r">{t('Marge %')}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.data.rows.map((x) => (
                    <tr
                      key={x.key}
                      className={x.project_id ? 'click' : ''}
                      tabIndex={x.project_id ? 0 : undefined}
                      onClick={() => x.project_id && navigate(`pm/${x.project_id}`)}
                      onKeyDown={(e) => e.key === 'Enter' && x.project_id && navigate(`pm/${x.project_id}`)}
                    >
                      <td data-label={f.group === 'client' ? 'Kunde' : 'Projekt'}>
                        <b>{x.label}</b>
                        {x.budget_state && x.budget_state !== 'none' && x.budget_state !== 'ok' && <span className={`jc-state ${x.budget_state}`} style={{ marginLeft: 8 }}>{t('Budget:')} {t(STATE_TEXT[x.budget_state] ?? '')}</span>}
                        {x.revenue_retainer_open_hours > 0 && <div className="jc-hint">{hoursText(x.revenue_retainer_open_hours)} {t('im laufenden Retainer')}</div>}
                        {x.missing_cost_rate && <div className="jc-hint">{t('Kostensatz fehlt')}</div>}
                      </td>
                      <td className="r" data-label="Stunden">
                        {hoursText(x.hours)}
                      </td>
                      <td className="r" data-label="Umsatz abgerechnet">
                        {money(x.revenue_invoiced_cents)}
                      </td>
                      <td className="r" data-label="Umsatz offen">
                        {money(x.revenue_unbilled_cents)}
                      </td>
                      <td className="r" data-label="Kosten">
                        {money(x.cost_cents)}
                        {x.external_cost_cents > 0 && <div className="jc-hint">{t('davon Fremdkosten')} {money(x.external_cost_cents)}</div>}
                      </td>
                      <td className={`r${x.margin_cents < 0 ? ' jc-neg' : ''}`} data-label="Marge">
                        {money(x.margin_cents)}
                      </td>
                      <td className={`r${(x.margin_percent ?? 0) < 0 ? ' jc-neg' : ''}`} data-label="Marge %">
                        {pct(x.margin_percent)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="jc-hint">
            {t('Umsatz = abgerechnete Zeit (zum berechneten Satz) + Retainer-Rechnungen + abrechenbare, noch offene Zeit zum aktuellen Stundensatz. Kosten = Stunden × interner Kostensatz + Fremdkosten. Stornierte Rechnungen zählen nicht.')}
          </p>
        </>
      )}
    </div>
  );
}

// --- budgets ------------------------------------------------------------------------------------------------------------------------

function Budgets() {
  const t = useT('pm');
  const r = useLoad(() => api.get<{ budgets: (BudgetStatus & { name: string; color: string })[] }>('/api/pm/billing/budgets'), []);
  if (!r.data) return <Spinner />;
  if (!r.data.budgets.length) return <Empty>{t('Noch kein Projekt hat ein Budget. Ein Budget legst du im Projekt über „Budget & Kosten“ fest.')}</Empty>;
  return (
    <SortableGrid id="jc-budgets" className="jc-cards" data-tour="jc-budgets">
      {r.data.budgets.map((b) => (
        <button type="button" key={b.project_id} className="jc-card" onClick={() => navigate(`pm/${b.project_id}`)}>
          <h4>
            <i
              className="pm-dot"
              style={{
                background: b.color,
                width: 10,
                height: 10,
                display: 'inline-block',
                borderRadius: 99,
                marginRight: 6,
              }}
              aria-hidden="true"
            />
            {b.name}
          </h4>
          <BudgetMeters s={b} />
          {b.state && b.state !== 'none' && <span className={`jc-state ${b.state}`}>{t(STATE_TEXT[b.state] ?? '')}</span>}
        </button>
      ))}
    </SortableGrid>
  );
}

// --- retainers ----------------------------------------------------------------------------------------------------------------------

interface Retainer {
  id: string;
  name: string;
  contact_id: string | null;
  contact_name: string;
  project_id: string | null;
  project_name: string;
  hours_per_month: number;
  price_cents: number;
  overage_rate_cents: number;
  rollover: 'none' | 'capped' | 'unlimited';
  rollover_max_hours: number;
  start_month: string;
  end_month: string | null;
  status: 'active' | 'ended';
  auto_close: boolean;
  tax_rate: number | null;
  notes: string;
  next_month: string | null;
  next_due: boolean;
  current: null | {
    month: string;
    used_hours: number;
    available_hours: number;
    carry_in_hours: number;
    overage_hours: number;
  };
  periods?: any[];
}

// German labels (message ids of the pm catalog), shown through t()
const ROLLOVER: Record<string, string> = {
  none: 'Reststunden verfallen',
  capped: 'Übertrag bis zu N Stunden',
  unlimited: 'Unbegrenzter Übertrag',
};
// i18n-ignore – German month names; other languages use Intl (monthText)
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const monthText = (ym: string | null) => (ym ? (getLocale() === SOURCE_LOCALE ? `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : fmtMonth(`${ym.slice(0, 7)}-01`)) : '–');

function Retainers() {
  const t = useT('pm');
  const session = useSession();
  const manager = can(session, 'settings');
  const list = useLoad(() => api.get<{ retainers: Retainer[] }>('/api/pm/billing/retainers'), []);
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<Retainer | 'new' | null>(null);
  return (
    <div data-tour="jc-retainers">
      <div className="jc-bar">
        <p className="muted" style={{ margin: 0, flex: '1 1 300px' }}>
          {t('Ein Retainer ist ein monatliches Stundenkontingent zum Festpreis. Der Monatsabschluss erstellt einen Rechnungsentwurf mit Pauschale und Mehrstunden und trägt Reststunden nach deiner Regel weiter.')}
        </p>
        {manager && (
          <button type="button" className="btn" onClick={() => setEdit('new')} data-tour="jc-retainer-new">
            {t('+ Neuer Retainer')}
          </button>
        )}
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.retainers.length === 0 ? (
        <Empty>{t('Noch keine Retainer.')}</Empty>
      ) : (
        <SortableGrid id="pm-profit.retainers" className="jc-cards">
          {list.data.retainers.map((x) => (
            <button type="button" key={x.id} className="jc-card" onClick={() => setOpen(x.id)}>
              <h4>{x.name}</h4>
              <span className="muted small">{[x.contact_name, x.project_name].filter(Boolean).join(' · ') || '–'}</span>
              <span>
                {hoursText(x.hours_per_month)} {t('/ Monat ·')} {money(x.price_cents)}
                {x.status === 'ended' && <b className="jc-state" style={{ marginLeft: 8 }}>{t('beendet')}</b>}
              </span>
              {x.current && (
                <span className="small">
                  {monthText(x.current.month)}: {hoursText(x.current.used_hours)} {t('von')} {hoursText(x.current.available_hours)}
                  {x.current.overage_hours > 0 && <b className="jc-state over" style={{ marginLeft: 8 }}>{hoursText(x.current.overage_hours)} {t('drüber')}</b>}
                </span>
              )}
              {x.next_due && <b className="jc-state warn">{monthText(x.next_month)} {t('abschließen')}</b>}
            </button>
          ))}
        </SortableGrid>
      )}
      {open && <RetainerModal id={open} manager={manager} onClose={() => setOpen(null)} onEdit={(r) => (setOpen(null), setEdit(r))} onChanged={() => void list.reload()} />}
      {edit && <RetainerForm initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), void list.reload())} />}
    </div>
  );
}

function RetainerModal({ id, manager, onClose, onEdit, onChanged }: { id: string; manager: boolean; onClose: () => void; onEdit: (r: Retainer) => void; onChanged: () => void }) {
  const t = useT('pm');
  const r = useLoad(() => api.get<Retainer>(`/api/pm/billing/retainers/${id}`), [id]);
  const pre = useLoad(() => (r.data?.next_due ? api.get<any>(`/api/pm/billing/retainers/${id}/preview`) : Promise.resolve(null)), [id, r.data?.next_month, r.data?.next_due]);
  const [withUnapproved, setWithUnapproved] = useState(false);
  const x = r.data;
  const close = async () => {
    const res = await act(
      () =>
        api.post<any>(`/api/pm/billing/retainers/${id}/close`, {
          include_unapproved: withUnapproved,
        }),
      t('Monat abgeschlossen – Rechnungsentwurf angelegt'),
    );
    if (res) (void r.reload(), onChanged());
  };
  return (
    <Modal title={x ? t('Retainer „{name}“', { name: x.name }) : t('Retainer')} wide className="jc-modal" onClose={onClose}>
      {!x ? (
        <Spinner />
      ) : (
        <div data-tour="jc-retainer">
          <div className="jc-lines">
            <div>
              <span>{t('Kunde')}</span>
              <b>{x.contact_name || '–'}</b>
            </div>
            {x.project_name && (
              <div>
                <span>{t('Projekt')}</span>
                <Link to={`pm/${x.project_id}`}>{x.project_name}</Link>
              </div>
            )}
            <div>
              <span>{t('Kontingent')}</span>
              <b>
                {hoursText(x.hours_per_month)} {t('für')} {money(x.price_cents)} {t('im Monat')}
              </b>
            </div>
            <div>
              <span>{t('Mehrstunden')}</span>
              <b>{x.overage_rate_cents ? t('{amount} / Std.', { amount: money(x.overage_rate_cents) }) : t('nicht berechnet')}</b>
            </div>
            <div>
              <span>{t('Reststunden')}</span>
              <b>{x.rollover === 'capped' ? t('Übertrag bis zu {hours}', { hours: hoursText(x.rollover_max_hours) }) : t(ROLLOVER[x.rollover] ?? '')}</b>
            </div>
            <div>
              <span>{t('Laufzeit')}</span>
              <b>
                {t('ab {month}', { month: monthText(x.start_month) })}
                {x.end_month ? t(' bis {month}', { month: monthText(x.end_month) }) : ''}
                {x.auto_close ? t(' · schließt automatisch ab') : ''}
              </b>
            </div>
          </div>
          {x.current && (
            <p>
              <b>{monthText(x.current.month)}</b> {t('bisher:')} {hoursText(x.current.used_hours)} {t('von')} {hoursText(x.current.available_hours)}
              {x.current.carry_in_hours > 0 && t(' (inkl. {hours} Übertrag)', { hours: hoursText(x.current.carry_in_hours) })}
            </p>
          )}
          {x.next_due && pre.data && (
            <div className="jc-approval need" data-tour="jc-retainer-close">
              <b>{pre.data.label} {t('abschließen')}</b>
              <div className="jc-lines">
                <div>
                  <span>{t('Verfügbar (Kontingent + Übertrag)')}</span>
                  <span>{hoursText(pre.data.available_hours)}</span>
                </div>
                <div>
                  <span>{t('Genutzt')}</span>
                  <span>{hoursText(pre.data.used_hours)}</span>
                </div>
                <div>
                  <span>{t('Mehrstunden')}</span>
                  <span>{hoursText(pre.data.overage_hours)}</span>
                </div>
                <div>
                  <span>{t('Übertrag in den Folgemonat')}</span>
                  <span>{hoursText(pre.data.carry_out_hours)}</span>
                </div>
              </div>
              <b>{t('Rechnungsentwurf:')} {money(pre.data.net_cents)} {t('netto')}</b>
              <ul>
                {pre.data.lines.map((l: any, i: number) => (
                  <li key={i}>
                    {l.name}: {l.qty.toLocaleString(intlLocale())} × {money(l.price_cents)}
                  </li>
                ))}
              </ul>
              {pre.data.unapproved_hours > 0 && (
                <Check checked={withUnapproved} onChange={setWithUnapproved} label={t('{hours} noch nicht freigegeben – trotzdem mitnehmen', { hours: hoursText(pre.data.unapproved_hours) })} />
              )}
              <button type="button" className="btn" onClick={close}>
                {t('Monat abschließen')}
              </button>
            </div>
          )}
          <h3>{t('Abgeschlossene Monate')}</h3>
          {!x.periods?.length ? (
            <p className="muted small">{t('Noch kein Monat abgeschlossen.')}</p>
          ) : (
            <div className="table-wrap">
              <table className="jc-table stack">
                <thead>
                  <tr>
                    <th>{t('Monat')}</th>
                    <th className="r">{t('Verfügbar')}</th>
                    <th className="r">{t('Genutzt')}</th>
                    <th className="r">{t('Mehrstunden')}</th>
                    <th className="r">{t('Übertrag')}</th>
                    <th>{t('Rechnung')}</th>
                  </tr>
                </thead>
                <tbody>
                  {x.periods.map((p: any) => (
                    <tr key={p.id}>
                      <td data-label="Monat">{p.label}</td>
                      <td className="r" data-label="Verfügbar">
                        {hoursText(p.available_hours)}
                      </td>
                      <td className="r" data-label="Genutzt">
                        {hoursText(p.used_hours)}
                      </td>
                      <td className="r" data-label="Mehrstunden">
                        {hoursText(p.overage_hours)}
                      </td>
                      <td className="r" data-label="Übertrag">
                        {hoursText(p.carry_out_hours)}
                      </td>
                      <td data-label="Rechnung">
                        {p.void ? (
                          <span className="jc-state over">{t('storniert – erneut abschließbar')}</span>
                        ) : p.invoice ? (
                          <a href={`/app/invoices/${p.invoice.id}`}>
                            {p.invoice.number || t('Entwurf')} · {money(p.invoice.subtotal_cents)}
                          </a>
                        ) : (
                          '–'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {manager && (
            <div
              className="row"
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                marginTop: 12,
              }}
            >
              <button type="button" className="btn secondary" onClick={() => onEdit(x)}>
                {t('Bearbeiten')}
              </button>
              {x.status === 'active' && (
                <button
                  type="button"
                  className="btn secondary"
                  onClick={async () =>
                    confirmAsk(t('Retainer beenden? Offene Monate bleiben abschließbar bis zum letzten Monat.')) &&
                    (await act(
                      () =>
                        api.patch(`/api/pm/billing/retainers/${id}`, {
                          status: 'ended',
                        }),
                      t('Retainer beendet'),
                    )) &&
                    (void r.reload(), onChanged())
                  }
                >
                  {t('Beenden')}
                </button>
              )}
              {!x.periods?.length && (
                <button
                  type="button"
                  className="btn danger"
                  onClick={async () => confirmAsk(t('Retainer löschen?')) && (await act(() => api.del(`/api/pm/billing/retainers/${id}`), t('Gelöscht'))) && (onChanged(), onClose())}
                >
                  {t('Löschen')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function RetainerForm({ initial, onClose, onSaved }: { initial: Retainer | null; onClose: () => void; onSaved: () => void }) {
  const t = useT('pm');
  const projects = useLoad(() => api.get<{ id: string; name: string; contact_name: string }[]>('/api/pm/projects').catch(() => []), []);
  const [q, setQ] = useState('');
  const contacts = useLoad(
    () => (q.trim().length > 1 ? api.get<any>(`/api/contacts?q=${encodeURIComponent(q.trim())}&limit=8`).then((r) => (r.contacts ?? r) as any[]) : Promise.resolve([] as any[])),
    [q],
  );
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [f, setF] = useState({
    name: initial?.name ?? '',
    project_id: initial?.project_id ?? '',
    contact_id: initial?.contact_id ?? '',
    contact_name: initial?.contact_name ?? '',
    hours: initial ? String(initial.hours_per_month).replace('.', ',') : '',
    price: centsToEuros(initial?.price_cents ?? null),
    overage: centsToEuros(initial?.overage_rate_cents ?? null),
    rollover: initial?.rollover ?? 'none',
    max: initial ? String(initial.rollover_max_hours).replace('.', ',') : '',
    start: initial?.start_month ?? thisMonth,
    end: initial?.end_month ?? '',
    auto: initial?.auto_close ?? false,
    notes: initial?.notes ?? '',
  });
  const save = async () => {
    const body = {
      name: f.name,
      project_id: f.project_id || null,
      contact_id: f.contact_id || null,
      hours_per_month: Number(f.hours.replace(',', '.')),
      price_cents: eurosToCents(f.price) ?? 0,
      overage_rate_cents: f.overage ? (eurosToCents(f.overage) ?? 0) : 0,
      rollover: f.rollover,
      rollover_max_hours: f.rollover === 'capped' ? Number(f.max.replace(',', '.')) || 0 : 0,
      start_month: f.start,
      end_month: f.end || null,
      auto_close: f.auto,
      notes: f.notes,
    };
    const r = await act(() => (initial ? api.patch(`/api/pm/billing/retainers/${initial.id}`, body) : api.post('/api/pm/billing/retainers', body)), t('Retainer gespeichert'));
    if (r) onSaved();
  };
  return (
    <Modal
      title={initial ? t('Retainer bearbeiten') : t('Neuer Retainer')}
      className="jc-modal"
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={save} data-tour="jc-retainer-save">
          {t('Speichern')}
        </button>
      }
    >
      <Field label="Name">
        <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder={t('z. B. Website-Wartung')} maxLength={120} />
      </Field>
      <Field label={t('Projekt (optional)')} hint={t('Ohne Projekt zählt die Zeit aller Projekte des Kunden.')}>
        <select value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
          <option value="">{t('Alle Projekte des Kunden')}</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.contact_name ? ` (${p.contact_name})` : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('Kunde')} hint={f.project_id ? t('Leer = der Kunde des Projekts.') : t('Wer die Rechnung bekommt.')}>
        {f.contact_id ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <b className="grow">{f.contact_name || t('Gewählter Kontakt')}</b>
            <button type="button" className="btn small secondary" onClick={() => setF({ ...f, contact_id: '', contact_name: '' })}>
              {t('Ändern')}
            </button>
          </div>
        ) : (
          <>
            <Input value={q} onChange={setQ} placeholder={t('Kontakt suchen…')} />
            {(contacts.data ?? []).map((c) => (
              <button
                type="button"
                key={c.id}
                className="btn small secondary"
                style={{ margin: '4px 4px 0 0' }}
                onClick={() => (
                  setF({
                    ...f,
                    contact_id: c.id,
                    contact_name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email,
                  }),
                  setQ('')
                )}
              >
                {[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email}
              </button>
            ))}
          </>
        )}
      </Field>
      <div className="grid2">
        <Field label={t('Stunden pro Monat')}>
          <Input inputMode="decimal" value={f.hours} onChange={(v) => setF({ ...f, hours: v })} placeholder="20" />
        </Field>
        <Field label={t('Preis pro Monat (€ netto)')}>
          <Input inputMode="decimal" value={f.price} onChange={(v) => setF({ ...f, price: v })} placeholder="1500" />
        </Field>
        <Field label={t('Satz für Mehrstunden (€ / Std.)')} hint={t('Leer = Mehrstunden werden nicht berechnet.')}>
          <Input inputMode="decimal" value={f.overage} onChange={(v) => setF({ ...f, overage: v })} placeholder="90" />
        </Field>
        <Field label={t('Reststunden')}>
          <select value={f.rollover} onChange={(e) => setF({ ...f, rollover: e.target.value as Retainer['rollover'] })}>
            {Object.entries(ROLLOVER).map(([k, l]) => (
              <option key={k} value={k}>
                {t(l)}
              </option>
            ))}
          </select>
        </Field>
        {f.rollover === 'capped' && (
          <Field label={t('Höchstens übertragen (Std.)')}>
            <Input inputMode="decimal" value={f.max} onChange={(v) => setF({ ...f, max: v })} placeholder="5" />
          </Field>
        )}
        <Field label={t('Erster Monat')}>
          <Input type="month" value={f.start} onChange={(v) => setF({ ...f, start: v })} />
        </Field>
        <Field label={t('Letzter Monat (optional)')}>
          <Input type="month" value={f.end} onChange={(v) => setF({ ...f, end: v })} />
        </Field>
      </div>
      <Check checked={f.auto} onChange={(v) => setF({ ...f, auto: v })} label={t('Vergangene Monate automatisch abschließen (Rechnungsentwurf am Monatsanfang)')} />
      <Field label={t('Hinweis auf der Rechnung (optional)')}>
        <Input value={f.notes} onChange={(v) => setF({ ...f, notes: v })} maxLength={2000} />
      </Field>
    </Modal>
  );
}

// --- costs ---------------------------------------------------------------------------------------------------------------------------

function CostRates() {
  const t = useT('pm');
  const r = useLoad(
    () =>
      api.get<{
        default_cost_cents: number;
        people: { user_id: string; name: string; cost_cents: number | null }[];
      }>('/api/pm/billing/cost-rates'),
    [],
  );
  const [def, setDef] = useState<string | null>(null);
  if (!r.data) return <Spinner />;
  const save = async (body: Record<string, unknown>) => (await act(() => api.put('/api/pm/billing/cost-rates', body), t('Kostensatz gespeichert'))) && void r.reload();
  return (
    <div data-tour="jc-cost-rates">
      <p className="muted small">{t('Was eine Stunde dich intern kostet (Gehalt, Nebenkosten, Büro) – getrennt vom Stundensatz, den du berechnest. Nur die Leitung sieht und ändert das.')}</p>
      <div className="jc-bar">
        <Field label={t('Standard-Kostensatz (€ / Std.)')}>
          <Input inputMode="decimal" value={def ?? centsToEuros(r.data.default_cost_cents)} onChange={setDef} />
        </Field>
        <button type="button" className="btn secondary" onClick={() => def !== null && save({ default_cost_cents: eurosToCents(def) ?? 0 })}>
          {t('Speichern')}
        </button>
      </div>
      <div className="table-wrap">
        <table className="jc-table">
          <thead>
            <tr>
              <th>{t('Person')}</th>
              <th className="r">{t('Kostensatz (€ / Std.)')}</th>
            </tr>
          </thead>
          <tbody>
            {r.data.people.map((p) => (
              <tr key={p.user_id}>
                <td>{p.name}</td>
                <td className="r">
                  <input
                    aria-label={t('Kostensatz {name}', { name: p.name })}
                    inputMode="decimal"
                    defaultValue={centsToEuros(p.cost_cents)}
                    placeholder={t('Standard ({amount})', { amount: centsToEuros(r.data!.default_cost_cents) || '0' })}
                    style={{ maxWidth: 160, textAlign: 'right' }}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      const cents = v ? eurosToCents(v) : null;
                      if (cents !== p.cost_cents) void save({ user_id: p.user_id, cost_cents: cents });
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Costs() {
  const t = useT('pm');
  const session = useSession();
  const manager = can(session, 'settings');
  const projects = useLoad(() => api.get<{ id: string; name: string }[]>('/api/pm/projects').catch(() => []), []);
  return (
    <>
      {manager && (
        <section className="jc-sec">
          <h3>{t('Interne Kostensätze')}</h3>
          <CostRates />
        </section>
      )}
      <section className="jc-sec">
        <h3>{t('Fremdkosten')}</h3>
        <CostsPanel projects={projects.data ?? []} />
      </section>
    </>
  );
}
