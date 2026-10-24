import { useState } from 'react';
import { api, d, dt, money } from '../api';
import { Icon } from '../icons';
import { act, Badge, Empty, Field, Input, Modal, pressable, Select, Spinner, Stat, Tabs, Textarea, useLoad } from '../ui';
import { useSession } from '../session';
import { PHASE_TONE, REASONS } from './CloudKit';
import { CloudSettingsForm } from './CloudSettings';
import { Slot } from '../slots';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Agentur → Cloud: the operator console of the hosted service. Numbers (MRR, churn, trial conversion), the customer list
 * with the actions the operator has (extend a trial, comp a plan, change a plan, open the account with the customer's
 * consent, delete), the settings of the service, the legal texts and signups that failed; abuse and the waitlist plug in as slots.
 */

const EVENTS: Record<string, string> = {
  provisioned: 'Konto angelegt',
  trial_started: 'Testphase gestartet',
  trial_converted: 'Testphase → Abo',
  trial_expired: 'Testphase abgelaufen',
  trial_extended: 'Testphase verlängert',
  subscribed: 'Abo abgeschlossen',
  checkout_started: 'Bezahlseite geöffnet',
  payment_failed: 'Zahlung fehlgeschlagen',
  payment_recovered: 'Zahlung nachgeholt',
  reactivated: 'Wieder freigeschaltet',
  read_only: 'Schreibgeschützt',
  canceled: 'Abo beendet',
  cancel_scheduled: 'Gekündigt',
  cancel_undone: 'Kündigung zurückgenommen',
  plan_changed: 'Tarif geändert',
  comped: 'Tarif geschenkt',
  comp_ended: 'Geschenk ausgelaufen',
  deletion_scheduled: 'Löschung geplant',
  deletion_undone: 'Löschung zurückgenommen',
  deleted: 'Gelöscht',
  export: 'Daten exportiert',
  support_consent: 'Support-Freigabe',
  support_open: 'Support hat geöffnet',
  member_invited: 'Nutzer eingeladen',
  member_removed: 'Nutzer entfernt',
  client_created: 'Kunden-Account angelegt',
  client_deleted: 'Kunden-Account gelöscht',
  branding_changed: 'White-Label geändert',
  domain_changed: 'Domain geändert',
  legal_accepted: 'Bedingungen bestätigt',
  mail_failed: 'E-Mail fehlgeschlagen',
  provision_failed: 'Einrichtung fehlgeschlagen',
  signup_blocked: 'Anmeldung blockiert',
  b2b_confirmed: 'Unternehmer bestätigt',
  abuse_reported: 'Missbrauch gemeldet',
  abuse_sending_paused: 'Versand pausiert',
  abuse_sending_resumed: 'Versand wieder frei',
  abuse_sites_offline: 'Websites offline',
  abuse_sites_online: 'Websites wieder online',
  abuse_suspended: 'Konto gesperrt',
  abuse_unsuspended: 'Sperre aufgehoben',
};
const PLANS: [string, string][] = [
  ['solo', 'Cloud Solo'],
  ['team', 'Cloud Team & Company'],
  ['agency', 'Cloud Agentur'],
];
const PHASES: [string, string][] = [
  ['', 'Alle Status'],
  ['trial', 'Testphase'],
  ['active', 'Aktiv'],
  ['comped', 'Geschenkt'],
  ['past_due', 'Zahlung offen'],
  ['read_only', 'Schreibgeschützt'],
  ['canceled', 'Gekündigt'],
  ['deletion_scheduled', 'Löschung geplant'],
];

const pct = (n: number | null | undefined) => (n === null || n === undefined ? '–' : `${String(n).replace('.', ',')} %`);

function Overview({ go }: { go: (t: string) => void }) {
  const o = useLoad(() => api.get('/api/cloud/console/overview'), []);
  const x = o.data;
  if (!x) return <Spinner />;
  const h = x.health;
  const checks: [boolean, string, string?][] = [
    [h.stripe_connected, 'Stripe ist verbunden', 'Schlüssel unter Agentur → SaaS → Einstellungen'],
    [h.webhook_set, 'Webhook-Secret ist hinterlegt', 'ohne Webhook entstehen keine Konten nach der Zahlung'],
    [h.signup_open, 'Anmeldung ist offen', 'Einstellungen → Anmeldung'],
    [h.mail_ready, 'System-Mails werden wirklich verschickt (Absender mit SMTP oder Mail-Dienst, nicht „nur speichern“)', 'Einstellungen → Domain & Mail'],
    [!h.legal_open, 'Rechtstexte sind vollständig ausgefüllt', `${h.legal_open} Dokument(e) mit offenen Platzhaltern`],
    [!!h.cloud_domain, 'Cloud-Domain für <name>.domain gesetzt', 'optional – sonst pfadbasiert'],
    [!h.saas_signup_open, 'Die SaaS-Anmeldeseite (/signup) ist aus', 'im Cloud-Modus laufen Anmeldungen über /start'],
    [!!h.sites_domain, 'Eigene Domain für Kunden-Websites gesetzt (PGHL_CLOUD_SITES_DOMAIN)', 'sonst sind Kunden-Websites nur über ihre eigene, bestätigte Domain erreichbar – nie unter der Login-Adresse'],
    [!!h.offsite_backup, 'Off-site-Backup ist eingerichtet', 'PGHL_BACKUP_S3_* und PGHL_BACKUP_KEY – Status unter Agentur → System'],
  ];
  return (
    <>
      <SortableGrid id="cloud-stats" className="stats" data-tour="cloud-stats">
        <Stat label="MRR" value={money(x.mrr_cents, x.currency)} sub={`ARR ${money(x.arr_cents, x.currency)}`} />
        <Stat label="Zahlende Kunden" value={x.paying} sub={`${x.total} Konten gesamt, ${x.new_30d} neu in 30 Tagen`} />
        <Stat label="Testphasen" value={x.counts.trial} sub="noch ohne Umsatz" />
        <Stat label="Testphase → Abo" value={pct(x.trial.conversion_percent)} sub={`${x.trial.converted_90d} umgestiegen, ${x.trial.expired_90d} abgelaufen (90 Tage)`} />
        <Stat label="Churn (30 Tage)" value={pct(x.churn.rate_percent)} sub={`${x.churn.lost_30d} beendet`} />
        <Stat label="Zahlung offen" value={x.counts.past_due + x.counts.read_only} sub={`${x.counts.read_only} davon schreibgeschützt`} />
      </SortableGrid>
      <SortableGrid id="cloud.cards" className="grid2 saas-grid">
        <div className="card" data-tour="cloud-health">
          <h3 style={{ marginTop: 0 }}>Einrichtung</h3>
          <ul className="cloud-checks">
            {checks.map(([ok, label, hint]) => (
              <li key={label} className={ok ? 'ok' : 'todo'}>
                <Icon name={ok ? 'ok' : 'pending'} size={18} />
                <div>
                  {label}
                  {!ok && hint && <div className="muted small">{hint}</div>}
                </div>
              </li>
            ))}
          </ul>
          <button className="btn secondary small" onClick={() => go('settings')}>
            Zu den Einstellungen
          </button>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Kunden je Tarif</h3>
          <div className="table-wrap">
<table className="t">
            <thead>
              <tr>
                <th>Tarif</th>
                <th>Konten</th>
                <th>MRR</th>
              </tr>
            </thead>
            <tbody>
              {x.plans.map((p: any) => (
                <tr key={p.key}>
                  <td>{p.name}</td>
                  <td>
                    {p.count}
                    {p.trialing ? <span className="muted small"> ({p.trialing} Test)</span> : null}
                  </td>
                  <td>{money(p.mrr_cents, x.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
          {x.failed_signups > 0 && (
            <p className="notice-warn" style={{ marginTop: 12 }}>
              {x.failed_signups} Anmeldung(en) mit Zahlung konnten nicht eingerichtet werden.{' '}
              <a href="#" onClick={(e) => (e.preventDefault(), go('signups'))}>
                Ansehen
              </a>
            </p>
          )}
        </div>
      </SortableGrid>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Letzte Ereignisse</h3>
        {x.events.length ? (
          <div className="table-wrap">
<table className="t">
            <tbody>
              {x.events.map((e: any) => (
                <tr key={e.id}>
                  <td className="nowrap muted">{dt(e.at)}</td>
                  <td>{e.tenant_name || <span className="muted">gelöschtes Konto</span>}</td>
                  <td>{EVENTS[e.type] ?? e.type}</td>
                  <td className="muted small">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        ) : (
          <Empty>Noch nichts passiert.</Empty>
        )}
      </div>
    </>
  );
}

function TenantModal({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const session = useSession();
  const t = useLoad(() => api.get(`/api/cloud/console/tenants/${id}`), [id]);
  const [days, setDays] = useState('7');
  const [plan, setPlan] = useState('team');
  const [months, setMonths] = useState('');
  const [confirm, setConfirm] = useState('');
  const [notes, setNotes] = useState<string | null>(null);
  const x = t.data;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    if (await act(fn, ok)) {
      void t.reload();
      onChange();
    }
  };
  return (
    <Modal title={x ? x.name : 'Kunde'} wide onClose={onClose}>
      {!x ? (
        <Spinner />
      ) : (
        <>
          <div className="row">
            <div className="grow">
              <p>
                <Badge tone={PHASE_TONE[x.phase] ?? 'gray'}>{x.phase_label}</Badge> {x.plan.name} · {x.plan.interval === 'year' ? 'jährlich' : 'monatlich'} · {x.billing === 'stripe' ? 'Stripe' : 'ohne Stripe'}
              </p>
              <p className="muted small">
                {x.email} · angelegt {d(x.created_at)}
                {x.trial_end && ` · Testphase bis ${d(x.trial_end)}`}
                {x.current_period_end && ` · Laufzeit bis ${d(x.current_period_end)}`}
                {x.deletion && ` · Löschung ${d(x.deletion.at)}`}
              </p>
              <p className="muted small">
                {x.users} Nutzer{x.entitlements.client_accounts ? `, ${x.clients} Kunden-Accounts` : ''} · E-Mails {x.meters.emails.used.toLocaleString('de-DE')} · Support-Zugriff {x.support.active ? `bis ${d(x.support.until)}` : 'nicht freigegeben'}
              </p>
              {x.cancel_reason && (
                <p className="muted small">
                  Kündigungsgrund: {REASONS.find(([k]) => k === x.cancel_reason)?.[1] ?? x.cancel_reason}
                  {x.cancel_comment ? ` – „${x.cancel_comment}“` : ''}
                </p>
              )}
            </div>
          </div>
          <div className="actions" style={{ margin: '8px 0 14px' }}>
            <button
              className="btn"
              disabled={!x.support.active}
              title={x.support.active ? 'Konto im Support öffnen' : 'Der Kunde hat den Support-Zugriff nicht freigegeben'}
              onClick={async () => {
                const r = await act(() => api.post<{ location_id: string }>(`/api/cloud/console/tenants/${id}/open`, { reason: 'Support' }));
                if (r?.location_id) {
                  onClose();
                  session.switchLocation(r.location_id);
                }
              }}
            >
              <Icon name="eye" /> Konto öffnen
            </button>
          </div>
          <div className="grid2">
            <Field label="Testphase verlängern (Tage)">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <Input value={days} onChange={setDays} />
                <button className="btn secondary" onClick={() => run(() => api.post(`/api/cloud/console/tenants/${id}/extend-trial`, { days: Number(days) }), 'Testphase verlängert')}>
                  Verlängern
                </button>
              </div>
            </Field>
            <Field label="Tarif ändern">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <Select value={plan} onChange={setPlan} options={PLANS} />
                <button className="btn secondary" onClick={() => run(() => api.post(`/api/cloud/console/tenants/${id}/plan`, { plan }), 'Tarif geändert')}>
                  Ändern
                </button>
              </div>
            </Field>
            <Field label="Tarif schenken (Monate, leer = unbefristet)">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <Input value={months} onChange={setMonths} placeholder="z. B. 3" />
                <button className="btn secondary" onClick={() => run(() => api.post(`/api/cloud/console/tenants/${id}/comp`, { plan, ...(months ? { months: Number(months) } : {}) }), 'Tarif geschenkt')}>
                  Schenken
                </button>
              </div>
            </Field>
            <Field label="Notiz (nur für dich)">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <Input value={notes ?? x.notes} onChange={setNotes} />
                <button className="btn secondary" disabled={notes === null} onClick={() => run(() => api.patch(`/api/cloud/console/tenants/${id}`, { notes }), 'Gespeichert')}>
                  Speichern
                </button>
              </div>
            </Field>
          </div>
          <h4>Verlauf</h4>
          <div className="cloud-events">
            <div className="table-wrap">
<table className="t">
              <tbody>
                {x.events.map((e: any) => (
                  <tr key={e.id}>
                    <td className="nowrap muted">{dt(e.at)}</td>
                    <td>{EVENTS[e.type] ?? e.type}</td>
                    <td className="muted small">{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
</div>
          </div>
          <details style={{ marginTop: 14 }}>
            <summary>Konto löschen …</summary>
            <p className="muted small">Löscht alle Daten und Logins sofort und endgültig (der Kunde wird per E-Mail informiert, das Stripe-Abo beendet).</p>
            <Field label={`Zur Bestätigung „${x.name}“ eintippen`}>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <Input value={confirm} onChange={setConfirm} />
                <button
                  className="btn danger"
                  disabled={confirm !== x.name}
                  onClick={async () => {
                    if (await act(() => api.post(`/api/cloud/console/tenants/${id}/delete`, { confirm }), 'Gelöscht')) {
                      onChange();
                      onClose();
                    }
                  }}
                >
                  Löschen
                </button>
              </div>
            </Field>
          </details>
        </>
      )}
    </Modal>
  );
}

function Customers() {
  const [q, setQ] = useState('');
  const [phase, setPhase] = useState('');
  const [plan, setPlan] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const list = useLoad(() => api.get(`/api/cloud/console/tenants?q=${encodeURIComponent(q)}&phase=${phase}&plan=${plan}&limit=200`), [q, phase, plan]);
  const x = list.data;
  return (
    <div className="card" data-tour="cloud-customers">
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="grow">
          <Field label="Suchen">
            <Input value={q} onChange={setQ} placeholder="Firma, E-Mail …" />
          </Field>
        </div>
        <div>
          <Field label="Status">
            <Select value={phase} onChange={setPhase} options={PHASES} />
          </Field>
        </div>
        <div>
          <Field label="Tarif">
            <Select value={plan} onChange={setPlan} options={[['', 'Alle Tarife'], ...PLANS]} />
          </Field>
        </div>
        <a className="btn secondary" style={{ marginBottom: 12 }} href="/api/cloud/console/tenants.csv" download>
          <Icon name="csv" /> CSV
        </a>
      </div>
      {!x ? (
        <Spinner />
      ) : x.items.length ? (
        <div className="table-wrap">
<table className="t">
          <thead>
            <tr>
              <th>Firma</th>
              <th>Tarif</th>
              <th>Status</th>
              <th>MRR</th>
              <th>Testphase / Laufzeit</th>
              <th>Angelegt</th>
            </tr>
          </thead>
          <tbody>
            {x.items.map((r: any) => (
              <tr key={r.id} className="click" {...pressable(() => setOpen(r.id))}>
                <td>
                  {r.name}
                  <div className="muted small">{r.email}</div>
                </td>
                <td>
                  {r.plan_name}
                  <div className="muted small">{r.interval === 'year' ? 'jährlich' : 'monatlich'}</div>
                </td>
                <td>
                  <Badge tone={PHASE_TONE[r.phase] ?? 'gray'}>{r.phase_label}</Badge> {r.cancel_at_period_end && <Badge tone="yellow">gekündigt</Badge>} {r.support && <Badge tone="purple">Support frei</Badge>}
                </td>
                <td className="nowrap">{r.mrr_cents ? money(r.mrr_cents) : '–'}</td>
                <td className="nowrap">{d(r.status === 'trialing' ? r.trial_end : r.current_period_end)}</td>
                <td className="nowrap">{d(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
</div>
      ) : (
        <Empty>Keine Kunden gefunden.</Empty>
      )}
      {open && <TenantModal id={open} onClose={() => setOpen(null)} onChange={() => void list.reload()} />}
    </div>
  );
}

function Legal() {
  const l = useLoad(() => api.get<{ docs: { doc: string; title: string; version: number; body: string; open_placeholders: string[]; accepted: number; created_at: string }[] }>('/api/cloud/console/legal'), []);
  const [edit, setEdit] = useState<Record<string, string>>({});
  if (!l.data) return <Spinner />;
  return (
    <div data-tour="cloud-legal">
      <div className="notice-warn">
        Die Texte sind Vorlagen mit Platzhaltern und <strong>keine Rechtsberatung</strong>. Lass sie prüfen und trage deine Angaben unter Einstellungen → Anbieter ein. Jede Änderung ist eine neue Version; Kunden sehen sie als „bitte bestätigen“. Platzhalter: <code>{'{{operator.name}}'}</code>, <code>{'{{operator.address}}'}</code>, <code>{'{{customer.company}}'}</code>, <code>{'{{service}}'}</code>, <code>{'{{date}}'}</code>, <code>{'{{trial_days}}'}</code> …
      </div>
      {l.data.docs.map((x) => {
        const body = edit[x.doc] ?? x.body;
        return (
          <div className="card" key={x.doc}>
            <div className="saas-subtabs">
              <h3 style={{ marginTop: 0 }}>
                {x.title} <Badge>Version {x.version}</Badge> {x.open_placeholders.length > 0 && <Badge tone="yellow">{x.open_placeholders.length} Platzhalter offen</Badge>}
              </h3>
              <a href={`/cloud/legal/${x.doc}`} target="_blank" rel="noopener noreferrer">
                Seite ansehen
              </a>
            </div>
            {x.open_placeholders.length > 0 && <p className="muted small">Offen: {x.open_placeholders.map((p) => `{{${p}}}`).join(', ')}</p>}
            <Textarea value={body} onChange={(v) => setEdit({ ...edit, [x.doc]: v })} rows={12} className="mono" />
            <div className="actions" style={{ marginTop: 10 }}>
              <button
                className="btn"
                disabled={edit[x.doc] === undefined || edit[x.doc] === x.body}
                onClick={async () => {
                  if (await act(() => api.put(`/api/cloud/console/legal/${x.doc}`, { body: edit[x.doc] }), 'Neue Version veröffentlicht')) {
                    setEdit({ ...edit, [x.doc]: undefined as any });
                    void l.reload();
                  }
                }}
              >
                Als neue Version veröffentlichen
              </button>
              <span className="muted small">{x.accepted} Kunden haben diese Version bestätigt</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Signups() {
  const s = useLoad(() => api.get<any[]>('/api/cloud/console/signups'), []);
  if (!s.data) return <Spinner />;
  return (
    <div className="card">
      <p className="muted small" style={{ marginTop: 0 }}>Offene Anmeldungen löscht das System nach 7 Tage, fehlgeschlagene nach 30 Tagen (Datenschutz).</p>
      {s.data.length ? (
        <div className="table-wrap">
<table className="t">
          <thead>
            <tr>
              <th>Wann</th>
              <th>Firma</th>
              <th>Tarif</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {s.data.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{dt(r.created_at)}</td>
                <td>
                  {r.company}
                  <div className="muted small">{r.email}</div>
                </td>
                <td>{r.plan_key}</td>
                <td>
                  <Badge tone={r.status === 'done' ? 'green' : r.status === 'failed' ? 'red' : 'gray'}>{r.status}</Badge>
                  {r.error && <div className="muted small">{r.error}</div>}
                </td>
                <td>
                  {r.status === 'failed' && (
                    <button className="btn small secondary" onClick={async () => (await act(() => api.post(`/api/cloud/console/signups/${r.id}/retry`, {}), 'Erneut versucht')) && s.reload()}>
                      Erneut einrichten
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
</div>
      ) : (
        <Empty>Keine Anmeldungen.</Empty>
      )}
    </div>
  );
}

export function CloudConsole() {
  // ?tab=waitlist (the admins' push notification about a new waitlist entry links there)
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('tab') || 'overview');
  return (
    <div className="cloud" data-tour="cloud-console">
      <div className="saas-subtabs">
        <Tabs
          tabs={[
            ['overview', 'Übersicht'],
            ['customers', 'Kunden'],
            ['settings', 'Einstellungen'],
            ['legal', 'Rechtliches'],
            ['signups', 'Anmeldungen'],
            ['abuse', 'Missbrauch'],
            ['waitlist', 'Warteliste'],
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="actions">
          <a className="btn small secondary" href="/cloud" target="_blank" rel="noopener noreferrer">
            Preisseite
          </a>
          <a className="btn small secondary" href="/start" target="_blank" rel="noopener noreferrer">
            Anmeldeseite
          </a>
        </div>
      </div>
      {tab === 'overview' && <Overview go={setTab} />}
      {tab === 'customers' && <Customers />}
      {tab === 'settings' && <CloudSettingsForm />}
      {tab === 'legal' && <Legal />}
      {tab === 'signups' && <Signups />}
      {tab === 'abuse' && <Slot name="cloud.abuse" />}
      {tab === 'waitlist' && <Slot name="cloud.waitlist" />}
    </div>
  );
}

