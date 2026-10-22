import { useEffect, useState, type ReactNode } from 'react';
import { api, d, money } from '../api';
import { Icon } from '../icons';
import { useSession } from '../session';
import { Badge, Empty, Field, Modal, Select, Spinner, Tabs, Textarea, act, navigate, toast, useLoad } from '../ui';
import { CloudClients, CloudTeam } from './CloudTeam';
import { MeterBar, PHASE_TONE, REASONS, type CloudMe, type Tenant } from './CloudKit';
import { CloudData } from './CloudData';

/**
 * Einstellungen → Cloud-Konto: the customer's side of the hosted service. Overview with the fair-use meters and the
 * start checklist, plan and invoices, team, client accounts and white-label (Agentur), data export, support access and
 * deleting the account. Everything is for the signed-in customer's own tenant (the server never takes a tenant id).
 */

const METERS: [keyof Tenant['meters'], string, string][] = [
  ['emails', 'E-Mails diesen Monat', ''],
  ['sms', 'SMS diesen Monat', ''],
  ['ai', 'KI-Aufrufe diesen Monat', ''],
  ['storage_mb', 'Medien-Speicher', ' MB'],
];

function Checklist() {
  const o = useLoad(() => api.get<{ items: { key: string; label: string; hint: string; to: string; done: boolean }[]; done: number; total: number }>('/api/cloud/onboarding'), []);
  const x = o.data;
  if (!x || x.done === x.total) return null;
  return (
    <div className="card cloud-check" data-tour="cloud-checklist">
      <h3 style={{ marginTop: 0 }}>
        Los geht’s <span className="muted small">{x.done} von {x.total} erledigt</span>
      </h3>
      <ul>
        {x.items.map((i) => (
          <li key={i.key} className={i.done ? 'done' : ''}>
            <Icon name={i.done ? 'ok' : 'pending'} size={18} />
            <div className="grow">
              <strong>{i.label}</strong>
              <div className="muted small">{i.hint}</div>
            </div>
            {!i.done && (
              <button className="btn small secondary" onClick={() => navigate(i.to)}>
                Öffnen
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Overview({ me, owner, onTab }: { me: CloudMe; owner: boolean; onTab: (t: string) => void }) {
  const t = me.tenant;
  const every = t.plan.interval === 'year' ? 'Jahr' : 'Monat';
  return (
    <>
      <div className="card" data-tour="cloud-plan">
        <div className="saas-plan-head">
          <div>
            <div className="muted small">Dein Tarif</div>
            <h2>
              {t.plan.name} <Badge tone={PHASE_TONE[t.phase] ?? 'gray'}>{t.phase_label}</Badge> {t.cancel_at_period_end && <Badge tone="yellow">gekündigt</Badge>}
            </h2>
            <p className="muted">{t.plan.key === 'solo' ? 'Eine Person, alle Funktionen.' : t.plan.key === 'team' ? 'Unbegrenzt Nutzer, alle Funktionen.' : 'Unbegrenzt Nutzer und Kunden-Accounts, White-Label inklusive.'}</p>
          </div>
          <div className="saas-price">
            {t.comped ? 'geschenkt' : money(t.plan.price_cents, t.plan.currency)}
            {!t.comped && <span className="muted"> / {every}</span>}
          </div>
        </div>
        <ul className="saas-facts">
          {t.phase === 'trial' && t.trial_end && <li>Testphase bis {d(t.trial_end)}{t.billing === 'manual' ? ' – danach schreibgeschützt, solange kein Tarif gewählt ist' : ''}</li>}
          {t.current_period_end && t.billing === 'stripe' && <li>{t.cancel_at_period_end ? `Endet am ${d(t.current_period_end)}` : `Nächste Verlängerung: ${d(t.current_period_end)}`}</li>}
          {t.comped && t.comp_until && <li>Geschenkt bis {d(t.comp_until)}</li>}
          {t.phase === 'past_due' && t.grace_until && <li>Bitte Zahlung bis {d(t.grace_until)} erledigen – danach wird das Konto schreibgeschützt.</li>}
          {t.read_only && <li>Das Konto ist schreibgeschützt: alles bleibt les- und exportierbar.</li>}
          {t.deletion && <li>Löschung geplant am {d(t.deletion.at)}.</li>}
          <li>{t.entitlements.users === null ? 'Unbegrenzt Nutzer' : `${t.counts.users} von ${t.entitlements.users} Nutzer`}{t.entitlements.client_accounts ? ` · ${t.counts.clients} Kunden-Accounts` : ''}</li>
          {t.subdomain && <li>Deine Adresse: <span className="mono">{t.subdomain}</span></li>}
        </ul>
        {owner && (
          <div className="actions">
            <button className="btn secondary" onClick={() => onTab('plan')}>
              <Icon name="card" /> Tarif & Rechnungen
            </button>
          </div>
        )}
      </div>
      <Checklist />
      <div className="card" data-tour="cloud-meters">
        <h3 style={{ marginTop: 0 }}>Fair Use – dein Verbrauch</h3>
        <p className="muted small" style={{ marginTop: 0 }}>Alle Funktionen sind in jedem Tarif frei. Nur teure Ressourcen haben Grenzen, pro Sub-Account und Monat.</p>
        <div className="saas-meters">
          {METERS.map(([k, l, u]) => (
            <MeterBar key={k} label={l} m={t.meters[k]} unit={u} />
          ))}
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>Mit eigenem KI-Schlüssel (Einstellungen → KI-Anbieter) rechnest du KI direkt mit deinem Anbieter ab.</p>
      </div>
      {me.support_email && (
        <p className="muted small">
          Fragen zu Tarif oder Rechnung? <a href={`mailto:${me.support_email}`}>{me.support_email}</a>
          {me.status_url && (
            <>
              {' '}
              · <a href={me.status_url} target="_blank" rel="noopener noreferrer">Status</a>
            </>
          )}
        </p>
      )}
    </>
  );
}

// --- plan & invoices --------------------------------------------------------------------------------

interface Card {
  key: 'solo' | 'team' | 'agency';
  name: string;
  tagline: string;
  price_month_cents: number;
  price_year_cents: number;
  users: number | null;
  highlights: string[];
}

function CancelModal({ t, onClose, onDone }: { t: Tenant; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('price');
  const [comment, setComment] = useState('');
  return (
    <Modal
      title="Abo kündigen"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn danger" onClick={async () => (await act(() => api.post('/api/cloud/cancel', { reason, comment }), 'Gekündigt')) && (onDone(), onClose())}>
            Zum Ende des Zeitraums kündigen
          </button>
        </>
      }
    >
      <p>
        Dein Abo „{t.plan.name}“ läuft bis {d(t.current_period_end ?? t.trial_end) || 'zum Ende des Zeitraums'} weiter, danach ist das Konto schreibgeschützt. Du kannst die Kündigung bis dahin zurücknehmen und jederzeit alle Daten exportieren.
      </p>
      <Field label="Warum kündigst du? (hilft uns, besser zu werden)">
        <Select value={reason} onChange={setReason} options={REASONS} />
      </Field>
      <Field label="Möchtest du etwas ergänzen? (optional)">
        <Textarea value={comment} onChange={setComment} maxLength={1000} />
      </Field>
    </Modal>
  );
}

function PlanTab({ me, reload }: { me: CloudMe; reload: () => void }) {
  const t = me.tenant;
  const plans = useLoad(() => api.get<{ plans: Card[]; yearly_discount_percent: number; price_note: string }>('/api/cloud/plans'), []);
  const invoices = useLoad(() => api.get<{ items: { id: string; number: string; status: string; amount_cents: number; currency: string; created: string; hosted_url: string; pdf_url: string }[]; portal: boolean }>('/api/cloud/invoices'), []);
  const [interval, setInterval] = useState<'month' | 'year'>(t.plan.interval);
  const [cancel, setCancel] = useState(false);
  if (!plans.data) return <Spinner />;
  const note = plans.data.price_note === 'net' ? 'zzgl. USt.' : plans.data.price_note === 'gross' ? 'inkl. USt.' : '';
  const choose = async (c: Card) => {
    if (t.billing === 'stripe' && !t.read_only) {
      if (c.key === t.plan.key && interval === t.plan.interval) return;
      if (!window.confirm(`Auf „${c.name}“ (${interval === 'year' ? 'jährlich' : 'monatlich'}) wechseln? Der Preis wird anteilig verrechnet.`)) return;
      if (await act(() => api.post('/api/cloud/plan', { plan: c.key, interval }), 'Tarif geändert')) reload();
    } else if (t.billing === 'manual' && !t.read_only && t.status !== 'canceled' && t.stripe === false && t.phase !== 'comped') {
      // Trial without payment data: switch the plan first, paying is the next step.
      if (c.key !== t.plan.key && (await act(() => api.post('/api/cloud/plan', { plan: c.key, interval }), 'Tarif geändert'))) reload();
    } else if (t.phase === 'comped') {
      toast('Dein Tarif ist geschenkt – Änderungen macht der Anbieter.');
    }
  };
  const subscribe = async (c: Card) => {
    const r = await act(() => api.post<{ url: string }>('/api/cloud/subscribe', { plan: c.key, interval }));
    if (r?.url) window.location.href = r.url;
  };
  const needsSubscribe = (t.billing === 'manual' && t.phase !== 'comped') || (t.phase === 'canceled' && !t.deletion);
  return (
    <>
      <div className="cloud-interval" role="group" aria-label="Abrechnung">
        <button className={interval === 'month' ? 'on' : ''} onClick={() => setInterval('month')}>
          Monatlich
        </button>
        <button className={interval === 'year' ? 'on' : ''} onClick={() => setInterval('year')}>
          Jährlich {plans.data.yearly_discount_percent > 0 && <Badge tone="green">-{plans.data.yearly_discount_percent} %</Badge>}
        </button>
      </div>
      <div className="cloud-plans" data-tour="cloud-plans">
        {plans.data.plans.map((c) => {
          const current = c.key === t.plan.key;
          const price = interval === 'year' ? Math.round(c.price_year_cents / 12) : c.price_month_cents;
          return (
            <div key={c.key} className={`card cloud-plan${current ? ' current' : ''}`}>
              <h3>
                {c.name} {current && <Badge tone="blue">aktuell</Badge>}
              </h3>
              <p className="muted small">{c.tagline}</p>
              <div className="cloud-price">
                {money(price)}
                <span className="muted"> / Monat {note}</span>
              </div>
              {interval === 'year' && <div className="muted small">{money(c.price_year_cents)} pro Jahr</div>}
              <ul>
                {c.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
              {needsSubscribe ? (
                <button className="btn" onClick={() => subscribe(c)}>
                  {current ? 'Jetzt abonnieren' : `${c.name} abonnieren`}
                </button>
              ) : (
                <button className={`btn${current && interval === t.plan.interval ? ' secondary' : ''}`} disabled={(current && interval === t.plan.interval) || t.read_only} onClick={() => choose(c)}>
                  {current && interval === t.plan.interval ? 'Dein Tarif' : current ? 'Intervall ändern' : 'Wechseln'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="actions" style={{ margin: '14px 0' }}>
        {t.stripe && (
          <button
            className="btn secondary"
            onClick={async () => {
              const r = await act(() => api.post<{ url: string }>('/api/cloud/portal', {}));
              if (r?.url) window.location.href = r.url;
            }}
          >
            <Icon name="card" /> Zahlungsmethode & Rechnungsadresse
          </button>
        )}
        {t.cancel_at_period_end ? (
          <button className="btn secondary" onClick={async () => (await act(() => api.post('/api/cloud/cancel', { undo: true }), 'Abo läuft weiter')) && reload()}>
            Kündigung zurücknehmen
          </button>
        ) : (
          t.status !== 'canceled' && (
            <button className="btn ghost" onClick={() => setCancel(true)}>
              Abo kündigen
            </button>
          )
        )}
      </div>
      <div className="card" data-tour="cloud-invoices">
        <h3 style={{ marginTop: 0 }}>Rechnungen</h3>
        {invoices.data?.items.length ? (
          <div className="table-wrap">
<table className="t">
            <thead>
              <tr>
                <th>Nummer</th>
                <th>Datum</th>
                <th>Betrag</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invoices.data.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.number || '–'}</td>
                  <td>{d(i.created)}</td>
                  <td>{money(i.amount_cents, i.currency)}</td>
                  <td>{i.status === 'paid' ? <Badge tone="green">bezahlt</Badge> : i.status === 'open' ? <Badge tone="yellow">offen</Badge> : <Badge>{i.status}</Badge>}</td>
                  <td className="nowrap">
                    {i.hosted_url && (
                      <a href={i.hosted_url} target="_blank" rel="noopener noreferrer">
                        Ansehen
                      </a>
                    )}{' '}
                    {i.pdf_url && (
                      <a href={i.pdf_url} target="_blank" rel="noopener noreferrer">
                        PDF
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        ) : (
          <Empty>{t.stripe ? 'Noch keine Rechnung – die erste kommt nach der Testphase.' : 'Sobald du ein Abo abschließt, erscheinen deine Rechnungen hier.'}</Empty>
        )}
      </div>
      {cancel && <CancelModal t={t} onClose={() => setCancel(false)} onDone={reload} />}
    </>
  );
}

// --- the page -----------------------------------------------------------------------------------------

/** `fallback`: shown to sub-accounts that are no cloud customer (e.g. the operator's own, or a SaaS customer of an agency). */
export function CloudAccount({ fallback }: { fallback?: ReactNode }) {
  const session = useSession();
  const me = useLoad(() => api.get<CloudMe>('/api/cloud/me'), [session.locationId]);
  const q = new URLSearchParams(location.search).get('tab');
  const [tab, setTab] = useState(q ?? 'overview');
  const m = me.data;
  // After paying at Stripe the customer comes back with ?abo=ok&session_id=…: take the subscription over at once.
  useEffect(() => {
    const sid = new URLSearchParams(location.search).get('session_id');
    if (!sid || !m || m.role !== 'owner') return;
    void api.post('/api/cloud/subscribe/confirm', { session_id: sid }).then(() => {
      history.replaceState(null, '', location.pathname);
      void me.reload();
      void session.reload();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!m]);
  if (!m) return me.loading ? <Spinner /> : (fallback ?? <Empty>Dieses Konto gehört zu keinem Cloud-Tarif.</Empty>);
  if (!m.customer) return <>{fallback ?? <Empty>Dieses Konto gehört zu keinem Cloud-Tarif.</Empty>}</>;
  if (m.limited) return <Empty>{m.read_only ? 'Dieser Kunden-Account ist schreibgeschützt.' : 'Die Verwaltung deines Kunden-Accounts liegt bei deiner Agentur.'}</Empty>;
  const t = m.tenant;
  const owner = m.role === 'owner';
  const tabs: [string, string][] = [
    ['overview', 'Übersicht'],
    ...(owner ? ([['plan', 'Tarif & Rechnungen']] as [string, string][]) : []),
    ['team', 'Team'],
    ...(t.entitlements.client_accounts ? ([['clients', 'Kunden & White-Label']] as [string, string][]) : []),
    ...(owner ? ([['data', 'Daten & Konto']] as [string, string][]) : []),
  ];
  const reload = () => {
    void me.reload();
    void session.reload();
  };
  const active = tabs.some(([k]) => k === tab) ? tab : 'overview';
  return (
    <div className="cloud" data-tour="cloud-account">
      {t.deletion && (
        <div className="saas-banner error" role="alert">
          <Icon name="lock" size={18} />
          <span className="grow">
            Dein Konto wird am {d(t.deletion.at)} gelöscht.
            {t.deletion.reason === 'self' ? ' Du hast die Löschung angefordert.' : ' Exportiere vorher deine Daten – oder schließe ein Abo ab.'}
          </span>
          {owner && t.deletion.reason === 'self' && (
            <button className="btn small secondary" onClick={async () => (await act(() => api.post('/api/cloud/delete/undo', {}), 'Löschung zurückgenommen')) && reload()}>
              Löschung zurücknehmen
            </button>
          )}
          {owner && t.deletion.reason !== 'self' && (
            <button className="btn small secondary" onClick={() => setTab('data')}>
              Daten exportieren
            </button>
          )}
        </div>
      )}
      {owner && !!m.legal.pending.length && (
        <div className="saas-banner info" role="status">
          <Icon name="shield" size={18} />
          <span className="grow">Unsere Bedingungen wurden aktualisiert ({m.legal.pending.map((p) => p.doc.toUpperCase()).join(', ')}). Bitte sieh sie dir an und bestätige.</span>
          <a href="/cloud/legal/agb" target="_blank" rel="noopener noreferrer">
            Lesen
          </a>
          <button className="btn small" onClick={async () => (await act(() => api.post('/api/cloud/legal/accept', {}), 'Danke')) && reload()}>
            Bestätigen
          </button>
        </div>
      )}
      <Tabs tabs={tabs} value={active} onChange={setTab} />
      {active === 'overview' && <Overview me={m} owner={owner} onTab={setTab} />}
      {active === 'plan' && owner && <PlanTab me={m} reload={reload} />}
      {active === 'team' && <CloudTeam me={m} owner={owner} reload={reload} />}
      {active === 'clients' && <CloudClients me={m} owner={owner} reload={reload} />}
      {active === 'data' && owner && <CloudData me={m} reload={reload} />}
    </div>
  );
}
