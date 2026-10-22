import { useState } from 'react';
import { ago, api, d, money } from '../api';
import { Icon } from '../icons';
import { Badge, Check, CodeBox, Copy, Empty, Field, Input, Modal, Select, Spinner, Stat, Tabs, Textarea, act, confirmAsk, useLoad } from '../ui';
import { MoreFields } from '../areas/fields';
import { SAAS_STATUS } from './SaasBilling';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Agentur → SaaS: sell sub-accounts to your own customers. Overview (MRR, statuses, churn,
 * renewals), plans (areas, limits, prices synced to Stripe), customer accounts (assign/change
 * plans with or without Stripe) and settings (agency Stripe, signup page, rebilling).
 */

const LIMIT_LABELS: [string, string][] = [
  ['contacts', 'Kontakte'],
  ['users', 'Nutzer'],
  ['funnels', 'Funnels & Websites'],
  ['courses', 'Kurse'],
  ['emails', 'E-Mails / Monat'],
  ['sms', 'SMS / Monat'],
  ['ai', 'KI-Aufrufe / Monat'],
];
const USAGE: [string, string][] = [
  ['emails', 'E-Mails'],
  ['sms', 'SMS'],
  ['ai', 'KI-Aufrufe'],
];
const EVENT_LABEL: Record<string, string> = {
  signup: 'Neue Anmeldung',
  subscribed: 'Abo gestartet',
  plan_assigned: 'Tarif vergeben',
  plan_changed: 'Tarif geändert',
  plan_removed: 'Tarif entfernt',
  past_due: 'Zahlung offen',
  paused: 'Pausiert',
  reactivated: 'Wieder aktiv',
  active: 'Aktiv',
  trialing: 'Testphase',
  canceled: 'Beendet',
  cancel_scheduled: 'Gekündigt zum Laufzeitende',
  cancel_undone: 'Kündigung zurückgenommen',
  usage_billed: 'Mehrverbrauch berechnet',
  checkout_link: 'Bezahllink erstellt',
  invite_accepted: 'Login eingerichtet',
  mail_failed: 'E-Mail fehlgeschlagen',
  snapshot_failed: 'Snapshot fehlgeschlagen',
};

export function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return <Badge>kein Tarif</Badge>;
  const [label, tone] = SAAS_STATUS[status] ?? [status, 'gray'];
  return <Badge tone={tone}>{label}</Badge>;
}

const euros = (cents: number) => (cents ? String(cents / 100).replace('.', ',') : '');

// --- overview -------------------------------------------------------------------------

function Overview({ goSettings }: { goSettings: () => void }) {
  const o = useLoad(() => api.get('/api/saas/overview'), []);
  const x = o.data;
  if (!x) return <Spinner />;
  const cur = x.currency;
  const maxMrr = Math.max(1, ...x.plans.map((p: any) => p.mrr_cents));
  return (
    <>
      {!x.stripe_connected && (
        <div className="notice-warn">
          Agentur-Stripe ist noch nicht verbunden – Tarife lassen sich nur ohne Stripe vergeben.{' '}
          <a href="#" onClick={(e) => (e.preventDefault(), goSettings())}>
            Jetzt einrichten
          </a>
        </div>
      )}
      <SortableGrid id="saas.stats" className="stats">
        <Stat label="MRR" value={money(x.mrr_cents, cur)} sub={`ARR ${money(x.arr_cents, cur)}`} />
        <Stat label="Aktive Abos" value={x.counts.active} sub={`${x.new_30d} neu in 30 Tagen`} />
        <Stat label="Testphase" value={x.counts.trialing} sub="noch ohne Umsatz" />
        <Stat label="Zahlung offen" value={x.counts.past_due + x.counts.paused} sub={`${x.counts.paused} davon pausiert`} />
        <Stat label="Churn (30 Tage)" value={`${String(x.churn.rate_percent).replace('.', ',')} %`} sub={`${x.churn.lost_30d} beendet`} />
      </SortableGrid>
      <SortableGrid id="saas.cards" className="grid2 saas-grid">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Abos je Tarif</h3>
          {x.plans.length ? (
            <table className="t saas-plan-table">
              <thead>
                <tr>
                  <th>Tarif</th>
                  <th>Accounts</th>
                  <th>MRR</th>
                </tr>
              </thead>
              <tbody>
                {x.plans.map((p: any) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>
                      {p.count}
                      {p.trialing ? <span className="muted small"> ({p.trialing} Test)</span> : null}
                    </td>
                    <td style={{ width: '45%' }}>
                      <div className="saas-mrr" title={`${p.name}: ${money(p.mrr_cents, cur)} pro Monat`}>
                        <div className="saas-mrr-track">
                          <div className="saas-mrr-bar" style={{ width: `${Math.max(p.mrr_cents ? 3 : 0, Math.round((p.mrr_cents / maxMrr) * 100))}%` }} />
                        </div>
                        <span>{money(p.mrr_cents, cur)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Noch keine Tarife.</Empty>
          )}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Anstehende Verlängerungen (30 Tage)</h3>
          {x.renewals.length ? (
            <table className="t">
              <tbody>
                {x.renewals.map((r: any) => (
                  <tr key={r.location_id}>
                    <td className="nowrap">{d(r.date)}</td>
                    <td>
                      {r.name}
                      <div className="muted small">
                        {r.plan} · {r.interval === 'year' ? 'jährlich' : 'monatlich'}
                      </div>
                    </td>
                    <td className="nowrap">{money(r.amount_cents, r.currency)}</td>
                    <td>{r.ends ? <Badge tone="yellow">endet</Badge> : <StatusBadge status={r.status} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Keine Verlängerungen in den nächsten 30 Tagen.</Empty>
          )}
        </div>
      </SortableGrid>
      <div className="card" style={{ marginTop: 14 }}>
        <h3 style={{ marginTop: 0 }}>Letzte Ereignisse</h3>
        {x.events.length ? (
          <ul className="saas-events">
            {x.events.map((e: any) => (
              <li key={e.id}>
                <span className="muted small nowrap">{ago(e.at)}</span>
                <strong>{EVENT_LABEL[e.type] ?? e.type}</strong>
                <span>{e.location_name ?? '–'}</span>
                <span className="muted small">{e.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Noch nichts passiert.</Empty>
        )}
      </div>
    </>
  );
}

// --- plans ----------------------------------------------------------------------------

function PlanEditor({ plan, settings, onClose, onSaved }: { plan?: any; settings: any; onClose: () => void; onSaved: () => void }) {
  const perms = useLoad(() => api.get<Record<string, string>>('/api/permissions'), []);
  const snaps = useLoad(() => api.get<any[]>('/api/snapshots'), []);
  const [f, setF] = useState<any>(() => ({
    name: plan?.name ?? '',
    description: plan?.description ?? '',
    price_month: euros(plan?.price_month_cents ?? 0),
    price_year: euros(plan?.price_year_cents ?? 0),
    trial_days: String(plan?.trial_days ?? 14),
    snapshot_id: plan?.snapshot_id ?? '',
    public: plan ? !!plan.public : true,
    active: plan ? !!plan.active : true,
    sort: String(plan?.sort ?? 0),
    features: plan?.features ?? ['dashboard', 'conversations', 'calendars', 'contacts', 'opportunities', 'funnels', 'forms', 'settings'],
    limits: Object.fromEntries(LIMIT_LABELS.map(([k]) => [k, plan?.limits?.[k] ?? ''])),
    overage: { emails: 'block', sms: 'block', ai: 'block', ...(plan?.overage ?? {}) },
    markup_percent: plan?.markup_percent ?? '',
  }));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const body = { ...f, trial_days: Number(f.trial_days || 0), sort: Number(f.sort || 0), markup_percent: f.markup_percent === '' ? null : Number(f.markup_percent) };
    const r = await act(() => (plan ? api.patch(`/api/saas/plans/${plan.id}`, body) : api.post('/api/saas/plans', body)), 'Tarif gespeichert');
    setBusy(false);
    if (r) onSaved();
  };
  const markup = f.markup_percent === '' ? settings.markup_percent : Number(f.markup_percent);
  const resale = (k: string) => {
    const c = (settings.unit_cost?.[k] ?? 0) * (1 + markup / 100);
    return c >= 1 ? `${c.toFixed(2).replace('.', ',')} ct` : `${(c * 10).toFixed(2).replace('.', ',')} € je 1.000`;
  };
  return (
    <Modal
      title={plan ? `Tarif „${plan.name}“` : 'Neuer Tarif'}
      onClose={onClose}
      wide
      footer={
        <button className="btn" disabled={busy || !f.name} onClick={save}>
          Speichern{settings.connected ? ' & mit Stripe abgleichen' : ''}
        </button>
      }
    >
      <Field label="Name *">
        <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} autoFocus placeholder="z. B. Starter" />
      </Field>
      <Field label="Beschreibung" hint="Steht auf der Anmeldeseite unter dem Preis">
        <Textarea value={f.description} onChange={(v) => setF({ ...f, description: v })} rows={2} />
      </Field>
      <div className="grid3">
        <Field label="Preis pro Monat (€)" hint="leer = kein Monatspreis">
          <Input value={f.price_month} onChange={(v) => setF({ ...f, price_month: v })} inputMode="decimal" placeholder="49" />
        </Field>
        <Field label="Preis pro Jahr (€)" hint="leer = kein Jahrespreis">
          <Input value={f.price_year} onChange={(v) => setF({ ...f, price_year: v })} inputMode="decimal" placeholder="490" />
        </Field>
        <Field label="Testphase (Tage)" hint="0 = sofort zahlen">
          <Input type="number" min={0} max={365} value={f.trial_days} onChange={(v) => setF({ ...f, trial_days: v })} />
        </Field>
      </div>
      <div className="actions">
        <Check checked={f.public} onChange={(v) => setF({ ...f, public: v })} label="Auf der Anmeldeseite zeigen (sonst nur per Link ?plan=…)" />
        <Check checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Aktiv (buchbar)" />
      </div>

      <h4>Bereiche im Tarif</h4>
      {perms.data ? (
        <div className="grid3">
          {Object.entries(perms.data).map(([k, label]) => (
            <Check key={k} checked={k === 'settings' || f.features.includes(k)} onChange={(on) => k !== 'settings' && setF({ ...f, features: on ? [...f.features, k] : f.features.filter((x: string) => x !== k) })} label={k === 'settings' ? `${label} (immer)` : label} />
          ))}
        </div>
      ) : (
        <Spinner />
      )}

      <MoreFields id="saas-plan-limits" label="Snapshot, Limits und Mehrverbrauch" values={[f.snapshot_id, Object.values(f.limits).some((x) => x !== '' && x != null), Object.values(f.overage).includes('bill'), f.markup_percent]}>
      <Field label="Snapshot für neue Konten" hint="Startpaket (Websites, Formulare, Workflows …); leer = Standard aus den Einstellungen">
        <Select value={f.snapshot_id} onChange={(v) => setF({ ...f, snapshot_id: v })} options={(snaps.data ?? []).map((s) => [s.id, s.name] as [string, string])} placeholder="Standard" />
      </Field>
      <h4>Limits</h4>
      <p className="muted small" style={{ marginTop: 0 }}>
        Leer = unbegrenzt. Kontakte, Nutzer, Funnels und Kurse werden beim Anlegen geprüft; E-Mails, SMS und KI-Aufrufe zählen je Kalendermonat.
      </p>
      <div className="grid3">
        {LIMIT_LABELS.map(([k, label]) => (
          <Field key={k} label={label}>
            <Input type="number" min={0} value={f.limits[k]} onChange={(v) => setF({ ...f, limits: { ...f.limits, [k]: v } })} placeholder="unbegrenzt" />
          </Field>
        ))}
      </div>

      <h4>Mehrverbrauch (E-Mails, SMS, KI)</h4>
      <div className="grid3">
        {USAGE.map(([k, label]) => (
          <Field key={k} label={`${label} über dem Limit`} hint={f.overage[k] === 'bill' ? `Kunde zahlt ${resale(k)} je Stück` : undefined}>
            <Select value={f.overage[k]} onChange={(v) => setF({ ...f, overage: { ...f.overage, [k]: v } })} options={[['block', 'sperren'], ['bill', 'weiterberechnen (Stripe)']]} />
          </Field>
        ))}
      </div>
      <Field label="Aufschlag auf deine Kosten (%)" hint={`leer = Standard (${settings.markup_percent} %). Deine Kosten je Stück stehen unter Einstellungen.`}>
        <Input type="number" min={0} value={f.markup_percent} onChange={(v) => setF({ ...f, markup_percent: v })} placeholder={String(settings.markup_percent)} />
      </Field>
      </MoreFields>
    </Modal>
  );
}

function Plans({ settings }: { settings: any }) {
  const plans = useLoad(() => api.get<any[]>('/api/saas/plans'), []);
  const [edit, setEdit] = useState<any>(null);
  if (!plans.data) return <Spinner />;
  return (
    <>
      <div className="actions" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          Tarife bestimmen, welche Bereiche ein Kunden-Account sieht und wie viel er nutzen darf. Preise landen als Produkt + Preise in deinem Stripe-Konto.
        </p>
        <button className="btn" onClick={() => setEdit({})}>
          + Neuer Tarif
        </button>
      </div>
      {plans.data.length ? (
        <div className="saas-plans">
          {plans.data.map((p) => (
            <div key={p.id} className={`card saas-plan-card${p.active ? '' : ' off'}`}>
              <div className="saas-plan-top">
                <h3>{p.name}</h3>
                <span>
                  {!p.active && <Badge>inaktiv</Badge>} {!p.public && <Badge tone="purple">versteckt</Badge>}
                </span>
              </div>
              <div className="saas-price">
                {p.free ? 'Kostenlos' : p.price_month_cents ? money(p.price_month_cents, p.currency) : money(p.price_year_cents, p.currency)}
                {!p.free && <span className="muted"> / {p.price_month_cents ? 'Monat' : 'Jahr'}</span>}
              </div>
              <div className="muted small">
                {p.price_month_cents && p.price_year_cents ? `oder ${money(p.price_year_cents, p.currency)} / Jahr · ` : ''}
                {p.trial_days ? `${p.trial_days} Tage Test` : 'ohne Testphase'}
              </div>
              <ul className="saas-limits">
                {LIMIT_LABELS.filter(([k]) => p.limits?.[k] !== undefined && p.limits?.[k] !== null).map(([k, label]) => (
                  <li key={k}>
                    {Number(p.limits[k]).toLocaleString('de-DE')} {label}
                    {USAGE.some(([u]) => u === k) && p.overage?.[k] === 'bill' ? ' (+ Mehrverbrauch)' : ''}
                  </li>
                ))}
                <li>{p.features.length - 1} Bereiche</li>
              </ul>
              <div className="saas-plan-foot">
                <span className="muted small">
                  {p.subscribers} {p.subscribers === 1 ? 'Account' : 'Accounts'} ·{' '}
                  {p.sync_error ? (
                    <span title={p.sync_error} style={{ color: 'var(--red)' }}>
                      Stripe-Fehler
                    </span>
                  ) : p.stripe_product_id ? (
                    'mit Stripe abgeglichen'
                  ) : settings.connected ? (
                    'noch nicht abgeglichen'
                  ) : (
                    'ohne Stripe'
                  )}
                </span>
                <span className="actions">
                  {settings.connected && (
                    <button className="btn small ghost" title="Mit Stripe abgleichen" onClick={() => act(() => api.post(`/api/saas/plans/${p.id}/sync`), 'Abgeglichen').then(() => plans.reload())}>
                      <Icon name="refresh" size={14} />
                    </button>
                  )}
                  <button className="btn small secondary" onClick={() => setEdit(p)}>
                    Bearbeiten
                  </button>
                  {!p.subscribers && (
                    <button className="btn small ghost" title="Löschen" onClick={() => confirmAsk(`Tarif „${p.name}“ löschen?`) && act(() => api.del(`/api/saas/plans/${p.id}`), 'Gelöscht').then(() => plans.reload())}>
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty action={<button className="btn" onClick={() => setEdit({})}>Ersten Tarif anlegen</button>}>Noch keine Tarife.</Empty>
      )}
      {edit && (
        <PlanEditor
          plan={edit.id ? edit : undefined}
          settings={settings}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            void plans.reload();
          }}
        />
      )}
    </>
  );
}

// --- accounts ---------------------------------------------------------------------------

function AccountEditor({ row, plans, onClose, onSaved }: { row: any; plans: any[]; onClose: () => void; onSaved: () => void }) {
  const sub = row.subscription;
  const stripeLive = sub?.billing === 'stripe' && sub.stripe_subscription && sub.status !== 'canceled';
  const [f, setF] = useState({ plan_id: sub?.plan_id ?? plans[0]?.id ?? '', interval: sub?.interval ?? 'month', status: sub?.billing === 'manual' ? sub.status : 'active', mode: 'manual', email: '' });
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<any>, ok: string, close = true) => {
    setBusy(true);
    const r = await act(fn, ok);
    setBusy(false);
    if (r && close) onSaved();
    return r;
  };
  const plan = plans.find((p) => p.id === f.plan_id);
  const intervals: string[] = plan?.intervals ?? ['month'];
  const iv = intervals.includes(f.interval) ? f.interval : intervals[0];
  return (
    <Modal title={`Tarif – ${row.name}`} onClose={onClose}>
      {sub && (
        <p>
          Jetzt: <strong>{row.plan?.name}</strong> <StatusBadge status={sub.status} /> {sub.billing === 'stripe' ? <Badge tone="blue">Stripe</Badge> : <Badge>ohne Stripe</Badge>}
          {sub.cancel_at_period_end ? <Badge tone="yellow">endet {d(sub.current_period_end)}</Badge> : null}
        </p>
      )}
      <div className="grid2">
        <Field label="Tarif">
          <Select value={f.plan_id} onChange={(v) => setF({ ...f, plan_id: v })} options={plans.map((p) => [p.id, p.name] as [string, string])} />
        </Field>
        <Field label="Abrechnung">
          <Select value={iv} onChange={(v) => setF({ ...f, interval: v })} options={intervals.map((i) => [i, i === 'year' ? 'jährlich' : 'monatlich'] as [string, string])} />
        </Field>
      </div>
      {stripeLive ? (
        <>
          <p className="muted small">Läuft über Stripe: eine Tarif-Änderung stellt das Abo bei Stripe um (anteilige Verrechnung). Der Status kommt von Stripe.</p>
          <div className="actions">
            <button className="btn" disabled={busy} onClick={() => run(() => api.put(`/api/saas/locations/${row.location_id}`, { plan_id: f.plan_id, interval: iv }), 'Tarif geändert')}>
              Tarif ändern
            </button>
            {sub.cancel_at_period_end ? (
              <button className="btn secondary" disabled={busy} onClick={() => run(() => api.post(`/api/saas/locations/${row.location_id}/cancel`, { undo: true }), 'Kündigung zurückgenommen')}>
                Kündigung zurücknehmen
              </button>
            ) : (
              <button className="btn secondary" disabled={busy} onClick={() => confirmAsk('Zum Ende des Zeitraums kündigen?') && run(() => api.post(`/api/saas/locations/${row.location_id}/cancel`, {}), 'Gekündigt')}>
                Zum Laufzeitende kündigen
              </button>
            )}
            <button className="btn ghost" disabled={busy} onClick={() => confirmAsk('Abo sofort beenden? Das Konto wird nur noch lesbar.') && run(() => api.post(`/api/saas/locations/${row.location_id}/cancel`, { now: true }), 'Beendet')}>
              Sofort beenden
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="actions" style={{ margin: '4px 0 10px' }}>
            <label className="check">
              <input type="radio" checked={f.mode === 'manual'} onChange={() => setF({ ...f, mode: 'manual' })} /> Ohne Stripe vergeben
            </label>
            <label className="check">
              <input type="radio" checked={f.mode === 'stripe'} onChange={() => setF({ ...f, mode: 'stripe' })} /> Stripe-Bezahllink an den Kunden
            </label>
          </div>
          {f.mode === 'manual' ? (
            <>
              <Field label="Status" hint="z. B. „pausiert“ sperrt das Konto auf nur lesen">
                <Select value={f.status} onChange={(v) => setF({ ...f, status: v })} options={Object.entries(SAAS_STATUS).map(([k, [l]]) => [k, l] as [string, string])} />
              </Field>
              <div className="actions">
                <button className="btn" disabled={busy || !f.plan_id} onClick={() => run(() => api.put(`/api/saas/locations/${row.location_id}`, { plan_id: f.plan_id, interval: iv, status: f.status }), 'Tarif gespeichert')}>
                  Speichern
                </button>
                {sub && (
                  <button className="btn ghost" disabled={busy} onClick={() => confirmAsk('Tarif entfernen? Dann gelten keine Limits mehr.') && run(() => api.del(`/api/saas/locations/${row.location_id}`), 'Tarif entfernt')}>
                    Tarif entfernen
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <Field label="E-Mail des Kunden" hint="füllt Stripe Checkout vor">
                <Input type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} placeholder="kunde@firma.de" />
              </Field>
              <button
                className="btn"
                disabled={busy || !f.plan_id}
                onClick={async () => {
                  const r = await run(() => api.post(`/api/saas/locations/${row.location_id}/checkout`, { plan_id: f.plan_id, interval: iv, email: f.email }), 'Link erstellt', false);
                  if (r?.url) setLink(r.url);
                }}
              >
                Bezahllink erstellen
              </button>
              {link && (
                <div style={{ marginTop: 10 }}>
                  <CodeBox text={link} />
                  <p className="muted small">Schick den Link an den Kunden. Sobald er bezahlt hat, läuft das Abo über Stripe und erscheint hier.</p>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function Accounts() {
  const rows = useLoad(() => api.get<any[]>('/api/saas/locations'), []);
  const plans = useLoad(() => api.get<any[]>('/api/saas/plans'), []);
  const signups = useLoad(() => api.get<any[]>('/api/saas/signups'), []);
  const [edit, setEdit] = useState<any>(null);
  const [q, setQ] = useState('');
  if (!rows.data || !plans.data) return <Spinner />;
  const list = rows.data.filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="actions" style={{ marginBottom: 12 }}>
        <Input value={q} onChange={setQ} placeholder="Sub-Account suchen…" style={{ maxWidth: 280 }} />
        <span className="muted small">Verbrauch: aktueller Monat</span>
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Sub-Account</th>
              <th>Tarif</th>
              <th>Status</th>
              <th>Verlängerung</th>
              <th>E-Mails</th>
              <th>SMS</th>
              <th>KI</th>
              <th>MRR</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const lim = (k: string) => (r.limits?.[k] === null || r.limits?.[k] === undefined ? '' : ` / ${Number(r.limits[k]).toLocaleString('de-DE')}`);
              return (
                <tr key={r.location_id}>
                  <td>{r.name}</td>
                  <td>
                    {r.plan?.name ?? <span className="muted">–</span>}
                    {r.subscription && <div className="muted small">{r.subscription.billing === 'stripe' ? 'Stripe' : 'ohne Stripe'} · {r.subscription.interval === 'year' ? 'jährlich' : 'monatlich'}</div>}
                  </td>
                  <td>
                    {r.subscription ? <StatusBadge status={r.subscription.status} /> : <span className="muted">–</span>} {r.subscription?.cancel_at_period_end ? <Badge tone="yellow">gekündigt</Badge> : null}
                  </td>
                  <td className="nowrap">{r.subscription?.current_period_end ? d(r.subscription.current_period_end) : '–'}</td>
                  {['emails', 'sms', 'ai'].map((k) => (
                    <td key={k} className="nowrap small">
                      {(r.usage?.[k] ?? 0).toLocaleString('de-DE')}
                      <span className="muted">{lim(k)}</span>
                    </td>
                  ))}
                  <td className="nowrap">{r.mrr_cents ? money(r.mrr_cents) : '–'}</td>
                  <td>
                    <button className="btn small secondary" disabled={!plans.data!.length} onClick={() => setEdit(r)}>
                      Tarif
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {signups.data && signups.data.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3 style={{ marginTop: 0 }}>Anmeldungen über die Anmeldeseite</h3>
          <table className="t">
            <tbody>
              {signups.data.slice(0, 20).map((s) => (
                <tr key={s.id}>
                  <td className="nowrap muted small">{d(s.created_at)}</td>
                  <td>
                    {s.company}
                    <div className="muted small">{s.email}</div>
                  </td>
                  <td>{s.plan_name}</td>
                  <td>
                    <Badge tone={s.status === 'done' ? 'green' : s.status === 'failed' ? 'red' : 'gray'}>{s.status === 'done' ? 'angelegt' : s.status === 'failed' ? 'Fehler' : 'wartet auf Zahlung'}</Badge>
                    {s.error && <div className="muted small">{s.error}</div>}
                  </td>
                  <td>
                    {s.status === 'done' && (
                      <button
                        className="btn small ghost"
                        onClick={async () => {
                          const r = await act(() => api.post(`/api/saas/signups/${s.id}/invite`), 'Neue Einladung erstellt');
                          if (r?.url) window.prompt('Einladungslink (7 Tage gültig):', r.url);
                        }}
                      >
                        Einladung neu
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <AccountEditor
          row={edit}
          plans={plans.data}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            void rows.reload();
          }}
        />
      )}
    </>
  );
}

// --- settings ---------------------------------------------------------------------------

const HOOK_EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'];

function Settings({ data, onChange }: { data: any; onChange: (s: any) => void }) {
  const snaps = useLoad(() => api.get<any[]>('/api/snapshots'), []);
  const locs = useLoad(() => api.get<any[]>('/api/saas/locations'), []);
  const [keys, setKeys] = useState({ secret_key: '', webhook_secret: '' });
  const [f, setF] = useState<any>(() => ({ ...data, unit_cost: { ...data.unit_cost } }));
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<any>(null);
  const save = async (body: any, ok = 'Gespeichert') => {
    setBusy(true);
    const r = await act(() => api.put('/api/saas/settings', body), ok);
    setBusy(false);
    if (r) {
      onChange(r);
      setF({ ...r, unit_cost: { ...r.unit_cost } });
    }
    return r;
  };
  return (
    <>
      <div className="card" style={{ maxWidth: 820 }}>
        <h2 style={{ marginTop: 0 }}>
          <Icon name="card" /> Agentur-Stripe {data.connected ? <Badge tone="green">verbunden</Badge> : <Badge>nicht verbunden</Badge>} {data.connected && <Badge tone={data.live ? 'blue' : 'yellow'}>{data.live ? 'Live' : 'Testmodus'}</Badge>}
        </h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Dein eigenes Stripe-Konto für die Abos deiner Kunden – getrennt vom Stripe, das ein Sub-Account für seine eigenen Rechnungen nutzt.
        </p>
        {data.account && (
          <p>
            Konto: <strong>{data.account.name}</strong> <span className="muted small">{data.account.id} · {data.key_hint}</span>
          </p>
        )}
        <Field label="Secret Key" hint="Stripe-Dashboard → Entwickler → API-Schlüssel (zum Ausprobieren sk_test_…)">
          <Input type="password" value={keys.secret_key} onChange={(v) => setKeys({ ...keys, secret_key: v.trim() })} placeholder={data.key_set ? `gespeichert (${data.key_hint}) – leer lassen zum Behalten` : 'sk_live_… oder sk_test_…'} autoComplete="off" />
        </Field>
        <h3>Webhook {data.webhook_set ? <Badge tone="green">eingerichtet</Badge> : <Badge tone="yellow">fehlt</Badge>}</h3>
        <MoreFields id="saas-webhook" label="Webhook einrichten" values={[data.key_set && !data.webhook_set]}>
        <ol className="steps small">
          <li>Stripe → Entwickler → Webhooks → „Endpunkt hinzufügen“</li>
          <li>
            URL: <CodeBox text={data.webhook_url} />
          </li>
          <li>
            Ereignisse:{' '}
            {HOOK_EVENTS.map((e, i) => (
              <span key={e}>
                {i ? ', ' : ''}
                <code>{e}</code>
              </span>
            ))}
          </li>
          <li>Signing Secret (whsec_…) hier eintragen</li>
        </ol>
        <Field label="Webhook Signing Secret">
          <Input type="password" value={keys.webhook_secret} onChange={(v) => setKeys({ ...keys, webhook_secret: v.trim() })} placeholder={data.webhook_set ? 'gespeichert – leer lassen zum Behalten' : 'whsec_…'} autoComplete="off" />
        </Field>
        </MoreFields>
        <div className="actions">
          <button className="btn" disabled={busy || (!keys.secret_key && !keys.webhook_secret)} onClick={() => save(keys).then((r) => r && setKeys({ secret_key: '', webhook_secret: '' }))}>
            Speichern
          </button>
          <button className="btn secondary" disabled={busy || (!data.key_set && !keys.secret_key)} onClick={async () => setCheck(await act(() => api.post('/api/saas/settings/test', keys.secret_key ? { secret_key: keys.secret_key } : {})))}>
            Verbindung testen
          </button>
          {data.connected && (
            <button className="btn ghost" onClick={() => confirmAsk('Agentur-Stripe trennen? Neue Abos und Bezahllinks gehen dann nicht mehr.') && act(() => api.del('/api/saas/settings/stripe'), 'Getrennt').then((r) => r && onChange(r))}>
              Trennen
            </button>
          )}
        </div>
        {check && (
          <p className="small">
            <Badge tone="green">✓ Verbindung klappt</Badge> {check.account.name} ({check.live ? 'Live' : 'Testmodus'})
          </p>
        )}
      </div>

      <div className="card" style={{ maxWidth: 820 }}>
        <h2 style={{ marginTop: 0 }}>Anmeldeseite</h2>
        <Check checked={!!f.signup_enabled} onChange={(v) => setF({ ...f, signup_enabled: v })} label="Anmeldeseite aktiv – Kunden buchen selbst einen Tarif" />
        <Field label="Adresse" hint="läuft auch auf deiner App-Domain aus dem White-Label">
          <div className="actions">
            <CodeBox text={data.signup_url} />
            <a className="btn small secondary" href="/signup" target="_blank" rel="noopener">
              Öffnen
            </a>
          </div>
        </Field>
        <Field label="Überschrift">
          <Input value={f.signup_title} onChange={(v) => setF({ ...f, signup_title: v })} placeholder="Name jetzt starten" />
        </Field>
        <Field label="Text unter der Überschrift">
          <Textarea value={f.signup_text} onChange={(v) => setF({ ...f, signup_text: v })} rows={2} />
        </Field>
        <MoreFields id="saas-signup" values={[f.terms_url, f.default_snapshot_id, f.mail_location_id, f.activate_workflows]}>
        <Field label="Link zu deinen AGB" hint="dann muss der Kunde sie anhaken">
          <Input value={f.terms_url} onChange={(v) => setF({ ...f, terms_url: v })} placeholder="https://…" />
        </Field>
        <div className="grid2">
          <Field label="Standard-Snapshot für neue Konten" hint="wenn der Tarif keinen eigenen hat">
            <Select value={f.default_snapshot_id} onChange={(v) => setF({ ...f, default_snapshot_id: v })} options={(snaps.data ?? []).map((s) => [s.id, s.name] as [string, string])} placeholder="keiner (leeres Konto)" />
          </Field>
          <Field label="Einladungs-Mails senden über" hint="dessen E-Mail-Einstellungen (SMTP) werden genutzt">
            <Select value={f.mail_location_id} onChange={(v) => setF({ ...f, mail_location_id: v })} options={(locs.data ?? []).map((l) => [l.location_id, l.name] as [string, string])} placeholder="den neuen Sub-Account" />
          </Field>
        </div>
        <Check checked={!!f.activate_workflows} onChange={(v) => setF({ ...f, activate_workflows: v })} label="Workflows aus dem Snapshot gleich aktivieren (sonst als Entwurf)" />
        </MoreFields>
      </div>

      <div className="card" style={{ maxWidth: 820 }}>
        <h2 style={{ marginTop: 0 }}>Zahlungsverzug & Weiterberechnung</h2>
        <div className="grid2">
          <Field label="Kulanzzeit bei offener Zahlung (Tage)" hint="danach wird das Konto pausiert (nur lesen)">
            <Input type="number" min={0} max={60} value={f.grace_days} onChange={(v) => setF({ ...f, grace_days: v })} />
          </Field>
        </div>
        <MoreFields id="saas-costs" label="Aufschlag und deine Kosten">
        <div className="grid2">
          <Field label="Standard-Aufschlag (%)" hint="auf deine Kosten für Mehrverbrauch">
            <Input type="number" min={0} value={f.markup_percent} onChange={(v) => setF({ ...f, markup_percent: v })} />
          </Field>
        </div>
        <div className="grid3">
          {USAGE.map(([k, label]) => (
            <Field key={k} label={`Deine Kosten je ${label === 'E-Mails' ? 'E-Mail' : label === 'KI-Aufrufe' ? 'KI-Aufruf' : 'SMS'} (Cent)`}>
              <Input value={String(f.unit_cost?.[k] ?? '').replace('.', ',')} onChange={(v) => setF({ ...f, unit_cost: { ...f.unit_cost, [k]: v } })} inputMode="decimal" />
            </Field>
          ))}
        </div>
        <p className="muted small">Mehrverbrauch eines Monats geht nach Monatsende als Rechnungsposten an die nächste Stripe-Rechnung des Kunden.</p>
        </MoreFields>
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            save({
              signup_enabled: f.signup_enabled,
              signup_title: f.signup_title,
              signup_text: f.signup_text,
              terms_url: f.terms_url,
              default_snapshot_id: f.default_snapshot_id,
              mail_location_id: f.mail_location_id,
              activate_workflows: f.activate_workflows,
              grace_days: Number(f.grace_days),
              markup_percent: Number(f.markup_percent),
              unit_cost: Object.fromEntries(USAGE.map(([k]) => [k, String(f.unit_cost?.[k] ?? 0).replace(',', '.')])),
            })
          }
        >
          Einstellungen speichern
        </button>
      </div>
    </>
  );
}

export function SaasAdmin() {
  const [tab, setTab] = useState('overview');
  const settings = useLoad(() => api.get('/api/saas/settings'), []);
  if (!settings.data) return <Spinner />;
  return (
    <>
      <div className="saas-subtabs" data-tour="saas-tabs">
        <Tabs
          tabs={[
            ['overview', 'Übersicht'],
            ['plans', 'Tarife'],
            ['accounts', 'Kunden-Abos'],
            ['settings', 'Einstellungen'],
          ]}
          value={tab}
          onChange={setTab}
        />
        {settings.data.signup_enabled && <Copy text={settings.data.signup_url} label="Anmelde-Link kopieren" />}
      </div>
      {tab === 'overview' && <Overview goSettings={() => setTab('settings')} />}
      {tab === 'plans' && <Plans settings={settings.data} />}
      {tab === 'accounts' && <Accounts />}
      {tab === 'settings' && <Settings data={settings.data} onChange={settings.setData} />}
    </>
  );
}
