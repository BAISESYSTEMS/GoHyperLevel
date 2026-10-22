import { useState } from 'react';
import { api, money } from '../api';
import { LineChart } from '../charts/LineChart';
import { color, type Shaped } from '../charts/core';
import { Icon } from '../icons';
import { can, useSession } from '../session';
import { Check, Field, Input, Link, Modal, Spinner, Tabs, act, confirmAsk, useLoad } from '../ui';
import { centsToEuros, eurosToCents } from './pm-format';
import './costing.css';
import { getLocale, intlLocale, tr, useT } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';

/**
 * Budget & costs of one project (docs/projects.md#job-costing-and-retainers): the strip in the project head (hours and money used,
 * traffic light in text) and the window with the budget, alert thresholds, burn-down, external costs and the project's retainer.
 * Needs the area "Rechnungen & Produkte"; changing the budget is for the Leitung.
 */

export interface BudgetStatus {
  project_id: string;
  budget: null | {
    hours: number | null;
    amount_cents: number | null;
    include_costs: boolean;
    thresholds: number[];
    notify: string[];
  };
  used?: {
    hours: number;
    amount_cents: number;
    time_fees_cents: number;
    external_cost_cents: number;
  };
  percent?: { hours: number | null; amount: number | null };
  remaining?: { hours: number | null; amount_cents: number | null };
  state?: 'none' | 'ok' | 'warn' | 'over';
}

/** German labels (message ids of the pm catalog), shown through t(). */
export const STATE_TEXT: Record<string, string> = {
  ok: 'Im Rahmen',
  warn: 'Schwelle erreicht',
  over: 'Überschritten',
  none: '',
};
export const hoursText = (h: number | null | undefined) => {
  const t = tr('pm');
  return h === null || h === undefined ? '–' : t('{h} Std.', { h: h.toLocaleString(intlLocale(), { maximumFractionDigits: 2 }) });
};
const pctText = (p: number | null | undefined) => {
  if (p === null || p === undefined) return '';
  const text = p.toLocaleString(intlLocale(), { maximumFractionDigits: 1 });
  return getLocale() === SOURCE_LOCALE ? `${text} %` : `${text}%`;
};
const stateOf = (pct: number | null | undefined, thresholds: number[]) =>
  pct === null || pct === undefined ? 'ok' : pct >= Math.max(100, ...thresholds) ? 'over' : pct >= Math.min(100, ...thresholds) ? 'warn' : 'ok';

export function Meter({ label, used, total, pct, thresholds }: { label: string; used: string; total: string; pct: number | null | undefined; thresholds: number[] }) {
  const t = useT('pm');
  const st = stateOf(pct, thresholds);
  return (
    <div className={`jc-meter ${st}`} role="group" aria-label={t('{label}: {used} von {total}', { label, used, total })}>
      <span>{label}</span>
      <span className="track" aria-hidden="true">
        <i style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
      </span>
      <span>
        {used} / {total} {pct !== null && pct !== undefined && <b className={`jc-state ${st}`}>{pctText(pct)}</b>}
      </span>
    </div>
  );
}

export function BudgetMeters({ s }: { s: BudgetStatus }) {
  const t = useT('pm');
  if (!s.budget || !s.used || !s.percent) return null;
  return (
    <>
      {s.budget.hours !== null && <Meter label={t('Stunden')} used={hoursText(s.used.hours)} total={hoursText(s.budget.hours)} pct={s.percent.hours} thresholds={s.budget.thresholds} />}
      {s.budget.amount_cents !== null && <Meter label={t('Budget')} used={money(s.used.amount_cents)} total={money(s.budget.amount_cents)} pct={s.percent.amount} thresholds={s.budget.thresholds} />}
    </>
  );
}

/** In the project head: the budget at a glance and the button to the window. Nothing for people without the payments area. */
export function PmBudgetStrip({ projectId }: { projectId: string }) {
  const t = useT('pm');
  const session = useSession();
  const payments = can(session, 'payments');
  const st = useLoad(() => (payments ? api.get<BudgetStatus>(`/api/pm/billing/budgets/${projectId}`) : Promise.resolve(null)), [projectId, payments]);
  const [open, setOpen] = useState(false);
  if (!payments) return null;
  const s = st.data;
  return (
    <div className="jc jc-strip" data-tour="pm-budget">
      {s?.budget ? <BudgetMeters s={s} /> : <span className="muted small">{t('Kein Budget festgelegt.')}</span>}
      {s?.state && s.state !== 'none' && s.state !== 'ok' && (
        <span className={`jc-state ${s.state}`}>
          <Icon name="flag" size={13} /> {t(STATE_TEXT[s.state] ?? '')}
        </span>
      )}
      <button type="button" className="btn small secondary" onClick={() => setOpen(true)} data-tour="pm-budget-open">
        <Icon name="price" size={14} /> {t('Budget & Kosten')}
      </button>
      {open && <BudgetModal projectId={projectId} onClose={() => setOpen(false)} onChanged={() => void st.reload()} />}
    </div>
  );
}

interface Burn {
  from: string;
  due: string | null;
  hours: null | {
    points: { day: string; remaining: number }[];
    ideal: { day: string; remaining: number }[];
  };
  amount: null | {
    points: { day: string; remaining: number }[];
    ideal: { day: string; remaining: number }[];
  };
}

const dayLabel = (d: string) => d.split('-').reverse().join('.');

/** Remaining budget per day plus the straight plan line to the due day – one axis, one unit. */
export function burnShape(b: NonNullable<Burn['hours']>, format: 'number' | 'money'): Shaped {
  const t = tr('pm');
  const plan = b.ideal.length === 2 ? b.ideal : null;
  const t0 = plan ? Date.parse(plan[0].day) : 0;
  const t1 = plan ? Date.parse(plan[1].day) : 0;
  return {
    categories: b.points.map((p) => ({ k: p.day, l: dayLabel(p.day) })),
    series: [
      {
        key: 'remaining',
        label: t('Verbleibend'),
        color: color(0),
        values: b.points.map((p) => p.remaining),
      },
      ...(plan
        ? [
            {
              key: 'plan',
              label: t('Plan bis zur Fälligkeit'),
              color: color(1),
              values: b.points.map((p) => Math.max(0, Math.round(plan[0].remaining * (1 - (Date.parse(p.day) - t0) / (t1 - t0)) * 100) / 100)),
            },
          ]
        : []),
    ],
    format,
    measures: [0],
  };
}

export function Burndown({ projectId }: { projectId: string }) {
  const t = useT('pm');
  const b = useLoad(() => api.get<Burn>(`/api/pm/billing/burndown/${projectId}`), [projectId]);
  const [kind, setKind] = useState<'hours' | 'amount'>('hours');
  if (!b.data) return <Spinner />;
  const has = { hours: !!b.data.hours, amount: !!b.data.amount };
  const k = has[kind] ? kind : has.hours ? 'hours' : 'amount';
  const series = b.data[k];
  if (!series) return null;
  return (
    <div data-tour="pm-burndown">
      {has.hours && has.amount && (
        <Tabs
          tabs={[
            ['hours', t('Stunden')],
            ['amount', t('Geld')],
          ]}
          value={k}
          onChange={(v) => setKind(v as 'hours' | 'amount')}
        />
      )}
      <LineChart data={burnShape(series, k === 'amount' ? 'money' : 'number')} height={220} />
      <p className="jc-hint">
        {k === 'amount' ? t('Verbleibendes Geld-Budget in Euro ab {date}.', { date: dayLabel(b.data.from) }) : t('Verbleibende Stunden ab {date}.', { date: dayLabel(b.data.from) })}
      </p>
    </div>
  );
}

interface Person {
  id: string;
  name: string;
}

function BudgetForm({ s, projectId, team, onSaved }: { s: BudgetStatus; projectId: string; team: Person[]; onSaved: () => void }) {
  const t = useT('pm');
  const [f, setF] = useState({
    hours: s.budget?.hours != null ? String(s.budget.hours).replace('.', ',') : '',
    amount: centsToEuros(s.budget?.amount_cents ?? null),
    thresholds: (s.budget?.thresholds ?? [80, 100]).join(', '),
    include_costs: s.budget?.include_costs ?? true,
    notify: s.budget?.notify ?? [],
  });
  const save = async () => {
    const hours = f.hours.trim() ? Number(f.hours.replace(',', '.')) : null;
    const amount = f.amount.trim() ? eurosToCents(f.amount) : null;
    const r = await act(
      () =>
        api.put(`/api/pm/billing/budgets/${projectId}`, {
          hours,
          amount_cents: amount,
          thresholds: f.thresholds,
          include_costs: f.include_costs,
          notify: f.notify,
        }),
      t('Budget gespeichert'),
    );
    if (r) onSaved();
  };
  return (
    <div data-tour="pm-budget-form">
      <div className="grid2">
        <Field label={t('Stunden-Budget')} hint={t('Alle erfassten Stunden des Projekts zählen.')}>
          <Input inputMode="decimal" value={f.hours} onChange={(v) => setF({ ...f, hours: v })} placeholder={t('z. B. 40')} />
        </Field>
        <Field label={t('Geld-Budget (€ netto)')} hint={t('Abrechenbarer Wert der Zeit zum Stundensatz.')}>
          <Input inputMode="decimal" value={f.amount} onChange={(v) => setF({ ...f, amount: v })} placeholder={t('z. B. 5000')} />
        </Field>
      </div>
      <Field label={t('Warnschwellen in %')} hint={t('Jede Schwelle meldet sich einmal: Glocke, Push, Protokoll und der Workflow-Auslöser „Projekt-Budget: Schwelle erreicht“.')}>
        <Input value={f.thresholds} onChange={(v) => setF({ ...f, thresholds: v })} placeholder="80, 100" />
      </Field>
      <Check checked={f.include_costs} onChange={(v) => setF({ ...f, include_costs: v })} label={t('Fremdkosten zählen zum Geld-Budget')} />
      {team.length > 0 && (
        <Field label={t('Benachrichtigen')} hint={t('Niemand gewählt: die verantwortliche Person und die Leitung.')}>
          <div className="jc-lines">
            {team.map((p) => (
              <Check
                key={p.id}
                checked={f.notify.includes(p.id)}
                onChange={(v) =>
                  setF({
                    ...f,
                    notify: v ? [...f.notify, p.id] : f.notify.filter((x) => x !== p.id),
                  })
                }
                label={p.name}
              />
            ))}
          </div>
        </Field>
      )}
      <div className="row" style={{ gap: 8, display: 'flex', flexWrap: 'wrap' }}>
        <button type="button" className="btn" onClick={save} data-tour="pm-budget-save">
          {t('Budget speichern')}
        </button>
        {s.budget && (
          <button
            type="button"
            className="btn secondary"
            onClick={async () => confirmAsk(t('Budget entfernen?')) && (await act(() => api.del(`/api/pm/billing/budgets/${projectId}`), t('Budget entfernt'))) && onSaved()}
          >
            {t('Budget entfernen')}
          </button>
        )}
      </div>
    </div>
  );
}

export interface Cost {
  id: string;
  project_id: string;
  project_name: string;
  day: string;
  description: string;
  category: string;
  amount_cents: number;
  receipt_id: string | null;
  receipt: { supplier: string; invoice_no: string } | null;
}

/** External costs: a form (with a receipt of the bookkeeping, if the person may see them) and the list. */
export function CostsPanel({ projectId, projects, onChanged }: { projectId?: string; projects?: { id: string; name: string }[]; onChanged?: () => void }) {
  const t = useT('pm');
  const session = useSession();
  const accounting = can(session, 'accounting');
  const list = useLoad(() => api.get<{ costs: Cost[] }>(`/api/pm/billing/costs${projectId ? `?project_id=${projectId}` : ''}`), [projectId]);
  const [f, setF] = useState({
    project_id: projectId ?? '',
    description: '',
    amount: '',
    day: '',
    category: '',
    receipt_id: '',
  });
  const [q, setQ] = useState('');
  const receipts = useLoad(() => (accounting ? api.get<{ receipts: any[] }>(`/api/pm/billing/receipts?q=${encodeURIComponent(q)}`) : Promise.resolve({ receipts: [] })), [q, accounting]);
  const add = async () => {
    const body: Record<string, unknown> = {
      project_id: f.project_id,
      description: f.description,
      day: f.day || undefined,
      category: f.category,
    };
    if (f.amount.trim()) body.amount_cents = eurosToCents(f.amount);
    if (f.receipt_id) body.receipt_id = f.receipt_id;
    const r = await act(() => api.post('/api/pm/billing/costs', body), t('Kosten erfasst'));
    if (r) {
      setF({ ...f, description: '', amount: '', category: '', receipt_id: '' });
      void list.reload();
      void receipts.reload();
      onChanged?.();
    }
  };
  return (
    <div data-tour="pm-costs">
      <div className="grid2">
        {!projectId && (
          <Field label={t('Projekt')}>
            <select value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
              <option value="">{t('Projekt wählen…')}</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('Beschreibung')}>
          <Input
            value={f.description}
            onChange={(v) => setF({ ...f, description: v })}
            placeholder={f.receipt_id ? t('Leer = Lieferant und Belegnummer') : t('z. B. Stockfotos, Druck, Hosting')}
            maxLength={300}
          />
        </Field>
        <Field label={t('Betrag (€ netto)')}>
          <Input inputMode="decimal" value={f.amount} onChange={(v) => setF({ ...f, amount: v })} placeholder={f.receipt_id ? t('Leer = Netto des Belegs') : '0,00'} />
        </Field>
        <Field label={t('Datum')}>
          <Input type="date" value={f.day} onChange={(v) => setF({ ...f, day: v })} />
        </Field>
        <Field label={t('Kategorie (optional)')}>
          <Input value={f.category} onChange={(v) => setF({ ...f, category: v })} maxLength={80} />
        </Field>
        {accounting && (
          <Field label={t('Beleg aus der Buchhaltung (optional)')}>
            <Input value={q} onChange={setQ} placeholder={t('Lieferant oder Nummer suchen')} />
            <select value={f.receipt_id} onChange={(e) => setF({ ...f, receipt_id: e.target.value })} aria-label={t('Beleg wählen')}>
              <option value="">{t('Kein Beleg')}</option>
              {(receipts.data?.receipts ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {[r.supplier, r.invoice_no, r.invoice_date ? dayLabel(r.invoice_date.slice(0, 10)) : '', r.net_cents != null ? money(r.net_cents) : ''].filter(Boolean).join(' · ')}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <button type="button" className="btn" onClick={add} data-tour="pm-cost-add">
        {t('+ Kosten erfassen')}
      </button>
      {!list.data ? (
        <Spinner />
      ) : list.data.costs.length === 0 ? (
        <p className="muted small">{t('Noch keine Fremdkosten.')}</p>
      ) : (
        <div className="table-wrap">
          <table className="jc-table">
            <thead>
              <tr>
                <th>{t('Datum')}</th>
                {!projectId && <th>{t('Projekt')}</th>}
                <th>{t('Beschreibung')}</th>
                <th className="r">{t('Betrag')}</th>
                <th aria-label={t('Aktionen')} />
              </tr>
            </thead>
            <tbody>
              {list.data.costs.map((c) => (
                <tr key={c.id}>
                  <td>{dayLabel(c.day)}</td>
                  {!projectId && <td>{c.project_name}</td>}
                  <td>
                    {c.description}
                    {c.category && <span className="muted small"> · {c.category}</span>}
                    {c.receipt && <div className="muted small">{t('Beleg:')} {[c.receipt.supplier, c.receipt.invoice_no].filter(Boolean).join(' ')}</div>}
                  </td>
                  <td className="r">{money(c.amount_cents)}</td>
                  <td className="r">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={t('Kosten „{name}“ löschen', { name: c.description })}
                      onClick={async () => confirmAsk(t('Kosten löschen?')) && (await act(() => api.del(`/api/pm/billing/costs/${c.id}`), t('Gelöscht'))) && (void list.reload(), onChanged?.())}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RetainerInfo({ projectId }: { projectId: string }) {
  const t = useT('pm');
  const r = useLoad(() => api.get<{ retainers: any[] }>(`/api/pm/billing/retainers?project_id=${projectId}`), [projectId]);
  const list = r.data?.retainers ?? [];
  if (!list.length) return <p className="muted small">{t('Kein Retainer für dieses Projekt. Retainer legst du unter „Rentabilität → Retainer“ an.')}</p>;
  return (
    <>
      {list.map((x) => (
        <div key={x.id} className="jc-lines">
          <div>
            <b>{x.name}</b>
            <span>
              {hoursText(x.hours_per_month)} {t('/ Monat ·')} {money(x.price_cents)}
            </span>
          </div>
          {x.current && (
            <div className="muted small">
              <span>{t('Dieser Monat')}</span>
              <span>
                {hoursText(x.current.used_hours)} {t('von')} {hoursText(x.current.available_hours)}
              </span>
            </div>
          )}
        </div>
      ))}
      <Link to="profit/retainer" className="btn small secondary">
        {t('Zu den Retainern')}
      </Link>
    </>
  );
}

export function BudgetModal({ projectId, onClose, onChanged }: { projectId: string; onClose: () => void; onChanged: () => void }) {
  const t = useT('pm');
  const session = useSession();
  const manager = can(session, 'settings');
  const st = useLoad(() => api.get<BudgetStatus>(`/api/pm/billing/budgets/${projectId}`), [projectId]);
  const team = useLoad(() => (manager ? api.get<{ team: Person[] }>('/api/pm/meta').then((m) => m.team) : Promise.resolve([] as Person[])), [manager]);
  const [tab, setTab] = useState('budget');
  const [v, setV] = useState(0);
  const refresh = () => (void st.reload(), setV((x) => x + 1), onChanged());
  return (
    <Modal title={t('Budget & Kosten')} wide className="jc-modal" onClose={onClose}>
      <Tabs
        tabs={[
          ['budget', t('Budget')],
          ['costs', t('Fremdkosten')],
          ['retainer', t('Retainer')],
        ]}
        value={tab}
        onChange={setTab}
      />
      {!st.data ? (
        <Spinner />
      ) : tab === 'budget' ? (
        <>
          {st.data.budget && (
            <div className="jc-sec" style={{ marginTop: 8 }}>
              <BudgetMeters s={st.data} />
              {st.data.state && st.data.state !== 'none' && <p className={`jc-state ${st.data.state}`}>{t(STATE_TEXT[st.data.state] ?? '')}</p>}
              <Burndown key={v} projectId={projectId} />
            </div>
          )}
          {manager ? (
            <div className="jc-sec">
              <h3>{st.data.budget ? t('Budget ändern') : t('Budget festlegen')}</h3>
              <BudgetForm key={JSON.stringify(st.data.budget)} s={st.data} projectId={projectId} team={team.data ?? []} onSaved={refresh} />
            </div>
          ) : (
            !st.data.budget && <p className="muted">{t('Für dieses Projekt ist kein Budget festgelegt. Das macht die Leitung.')}</p>
          )}
        </>
      ) : tab === 'costs' ? (
        <CostsPanel projectId={projectId} onChanged={refresh} />
      ) : (
        <RetainerInfo projectId={projectId} />
      )}
    </Modal>
  );
}
