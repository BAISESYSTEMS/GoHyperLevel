import { useState } from 'react';
import { api, currentLocation, d as day, money } from '../api';
import { Icon } from '../icons';
import { act, Badge, Check, CodeBox, confirmAsk, Copy, Empty, Field, Input, Modal, navigate, PageHead, pressable, Select, Spinner, Stat, Tabs, Textarea, toast, useLoad } from '../ui';
import { SortableGrid } from '../sortable/Sortable';

/** Affiliate manager: programs, affiliates, commissions (pending → approved → paid) and payouts. */

const STATUS: Record<string, [string, 'green' | 'yellow' | 'red' | 'gray' | 'blue']> = {
  active: ['aktiv', 'green'],
  pending: ['wartet auf Freigabe', 'yellow'],
  blocked: ['gesperrt', 'red'],
};
const C_STATUS: Record<string, [string, 'green' | 'yellow' | 'red' | 'gray' | 'blue']> = {
  pending: ['offen', 'yellow'],
  approved: ['freigegeben', 'blue'],
  paid: ['ausgezahlt', 'green'],
  reversed: ['storniert', 'gray'],
  open: ['offen', 'yellow'],
};
const KIND: Record<string, string> = { sale: 'Verkauf', recurring: 'Abo-Verlängerung', clawback: 'Rückbuchung', manual: 'Gutschrift' };
const euroIn = (cents: number) => String((cents || 0) / 100).replace('.', ',');
const toCents = (v: string) => Math.round(Number(String(v).replace(/\./g, '').replace(',', '.')) * 100) || 0;
const terms = (p: any) =>
  `${p.commission_type === 'fixed' ? money(p.commission_value) : `${String(p.commission_value).replace('.', ',')} %`} · ${p.attribution === 'first' ? 'erster' : 'letzter'} Klick · ${p.cookie_days} Tage${p.recurring ? ' · auch Abo-Verlängerungen' : ''} · Auszahlung ab ${money(p.payout_threshold_cents)}`;

export function Affiliates({ tab }: { tab?: string }) {
  const t = ['affiliates', 'programs', 'commissions', 'payouts'].includes(tab ?? '') ? tab! : 'affiliates';
  const programs = useLoad(() => api.get<any[]>('/api/affiliates/programs'), []);
  if (!programs.data) return <Spinner />;
  return (
    <>
      <PageHead title="Affiliates" sub="Partner empfehlen dich mit eigenem Link (?ref=…), du zahlst Provision auf Verkäufe." />
      <Tabs
        tabs={[
          ['affiliates', 'Affiliates'],
          ['programs', `Programme (${programs.data.length})`],
          ['commissions', 'Provisionen'],
          ['payouts', 'Auszahlungen'],
        ]}
        value={t}
        onChange={(v) => navigate(`affiliates/${v}`)}
      />
      {t === 'affiliates' && <AffiliateList programs={programs.data} />}
      {t === 'programs' && <Programs list={programs.data} reload={programs.reload} />}
      {t === 'commissions' && <Commissions />}
      {t === 'payouts' && <Payouts />}
    </>
  );
}

function AffiliateList({ programs }: { programs: any[] }) {
  const ov = useLoad(() => api.get('/api/affiliates/overview'), []);
  const list = useLoad(() => api.get<any[]>('/api/affiliates'), []);
  const [edit, setEdit] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const o = ov.data;
  const reload = () => (list.reload(), ov.reload());
  if (!programs.length)
    return (
      <Empty action={<button className="btn" onClick={() => navigate('affiliates/programs')}>Erstes Programm anlegen</button>}>
        Lege zuerst ein Partnerprogramm an: Provision, Cookie-Laufzeit und Auszahlungsgrenze.
      </Empty>
    );
  return (
    <>
      {o && (
        <SortableGrid id="affiliates.stats" className="stats">
          <Stat label="Aktive Affiliates" value={o.affiliates} sub={o.pending_affiliates ? `${o.pending_affiliates} warten auf Freigabe` : 'alle freigeschaltet'} />
          <Stat label="Klicks" value={o.clicks.toLocaleString('de-DE')} sub={`${o.leads} Leads`} />
          <Stat label="Verkäufe" value={o.sales} sub={`Umsatz ${money(o.revenue_cents)} netto`} />
          <Stat label="Provision offen" value={money(o.pending_cents)} sub={`freigegeben ${money(o.approved_cents)}`} />
          <Stat label="Ausgezahlt" value={money(o.paid_cents)} />
        </SortableGrid>
      )}
      <div className="actions" style={{ marginBottom: 12 }}>
        <button className="btn" data-tour="affiliates-new" onClick={() => setAdding(true)}>
          + Affiliate
        </button>
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Affiliate</th>
                <th>Programm / Code</th>
                <th>Status</th>
                <th className="num">Klicks</th>
                <th className="num">Leads</th>
                <th className="num">Verkäufe</th>
                <th className="num">Umsatz</th>
                <th className="num">Offen</th>
                <th className="num">Freigegeben</th>
                <th className="num">Ausgezahlt</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((a) => (
                <tr key={a.id} className="click" {...pressable(() => setEdit(a))}>
                  <td>
                    <strong>{a.name || a.email}</strong>
                    <div className="muted small">{a.email}</div>
                  </td>
                  <td>
                    {a.program_name}
                    <div className="muted small">
                      <code>{a.code}</code>
                    </div>
                  </td>
                  <td>
                    <Badge tone={STATUS[a.status]?.[1]}>{STATUS[a.status]?.[0] ?? a.status}</Badge>
                  </td>
                  <td className="num">{a.clicks}</td>
                  <td className="num">{a.leads}</td>
                  <td className="num">{a.sales}</td>
                  <td className="num">{money(a.revenue_cents)}</td>
                  <td className="num">{money(a.pending_cents)}</td>
                  <td className="num">{money(a.approved_cents)}</td>
                  <td className="num">{money(a.paid_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Noch keine Affiliates. Teile den Anmelde-Link deines Programms oder lege Partner von Hand an.</Empty>
      )}
      {adding && <AffiliateModal programs={programs} onClose={() => setAdding(false)} onSaved={() => (setAdding(false), reload())} />}
      {edit && <AffiliateModal programs={programs} affiliate={edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), reload())} />}
    </>
  );
}

function AffiliateModal({ programs, affiliate, onClose, onSaved }: { programs: any[]; affiliate?: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>(affiliate ? { ...affiliate } : { program_id: programs[0]?.id ?? '', name: '', email: '', code: '', status: 'active', payout_method: 'sepa', iban: '', bic: '', paypal_email: '', notes: '' });
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const save = async () => {
    const body = { name: f.name, code: f.code, status: f.status, payout_method: f.payout_method, iban: f.iban, bic: f.bic, paypal_email: f.paypal_email, notes: f.notes };
    const r = affiliate ? await act(() => api.patch(`/api/affiliates/${affiliate.id}`, body), 'Gespeichert') : await act(() => api.post('/api/affiliates', { ...body, program_id: f.program_id, email: f.email }), 'Angelegt');
    if (r) onSaved();
  };
  return (
    <Modal
      title={affiliate ? affiliate.name || affiliate.email : 'Affiliate anlegen'}
      onClose={onClose}
      footer={
        <>
          {affiliate && (
            <button
              className="btn ghost"
              onClick={async () => {
                if (confirmAsk('Affiliate löschen? Klicks und Provisionen werden mit gelöscht.') && (await act(() => api.del(`/api/affiliates/${affiliate.id}`), 'Gelöscht'))) onSaved();
              }}
            >
              Löschen
            </button>
          )}
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      {affiliate ? (
        <>
          <Field label="Partner-Link">
            <CodeBox text={affiliate.link} />
          </Field>
          <div className="actions" style={{ marginBottom: 12 }}>
            {affiliate.status === 'pending' && (
              <button className="btn small" onClick={async () => (await act(() => api.patch(`/api/affiliates/${affiliate.id}`, { status: 'active' }), 'Freigeschaltet')) && onSaved()}>
                Freischalten
              </button>
            )}
            <button
              className="btn small secondary"
              onClick={async () => {
                const r = await act(() => api.post(`/api/affiliates/${affiliate.id}/login-link`, {}));
                if (r?.link) window.prompt('E-Mail-Versand ist nicht eingerichtet. Login-Link zum Testen:', r.link);
                else if (r) toast(r.status === 'sent' ? 'Login-Link per E-Mail gesendet' : 'E-Mail-Versand ist nicht eingerichtet – Link wurde nur protokolliert');
              }}
            >
              <Icon name="email" /> Login-Link senden
            </button>
            <a className="btn small secondary" href={affiliate.portal_url} target="_blank" rel="noreferrer">
              <Icon name="external" /> Partnerbereich
            </a>
          </div>
        </>
      ) : (
        <>
          <Field label="Programm">
            <Select value={f.program_id} onChange={(v) => set('program_id', v)} options={programs.map((p) => [p.id, p.name] as [string, string])} />
          </Field>
          <Field label="E-Mail">
            <Input type="email" value={f.email} onChange={(v) => set('email', v)} />
          </Field>
        </>
      )}
      <div className="grid2">
        <Field label="Name">
          <Input value={f.name} onChange={(v) => set('name', v)} />
        </Field>
        <Field label="Code" hint={affiliate ? undefined : 'leer = aus dem Namen'}>
          <Input value={f.code} onChange={(v) => set('code', v.toLowerCase())} />
        </Field>
        <Field label="Status">
          <Select value={f.status} onChange={(v) => set('status', v)} options={Object.entries(STATUS).map(([k, [l]]) => [k, l] as [string, string])} />
        </Field>
        <Field label="Auszahlung per">
          <Select
            value={f.payout_method}
            onChange={(v) => set('payout_method', v)}
            options={[
              ['sepa', 'Überweisung (SEPA)'],
              ['paypal', 'PayPal'],
            ]}
          />
        </Field>
        {f.payout_method === 'paypal' ? (
          <Field label="PayPal-E-Mail">
            <Input value={f.paypal_email} onChange={(v) => set('paypal_email', v)} />
          </Field>
        ) : (
          <>
            <Field label="IBAN">
              <Input value={f.iban} onChange={(v) => set('iban', v)} />
            </Field>
            <Field label="BIC (optional)">
              <Input value={f.bic} onChange={(v) => set('bic', v)} />
            </Field>
          </>
        )}
      </div>
      <Field label="Notiz">
        <Textarea value={f.notes} onChange={(v) => set('notes', v)} />
      </Field>
    </Modal>
  );
}

function Programs({ list, reload }: { list: any[]; reload: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  return (
    <>
      <div className="actions" style={{ marginBottom: 12 }}>
        <button className="btn" data-tour="affiliates-new-program" onClick={() => setEdit({})}>
          + Programm
        </button>
      </div>
      {list.length ? (
        list.map((p) => (
          <div className="card" key={p.id}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2 style={{ marginBottom: 2 }}>
                  {p.name} {!p.active && <Badge>pausiert</Badge>}
                </h2>
                <div className="muted small">
                  {terms(p)} · {p.affiliates} Affiliates
                </div>
              </div>
              <button className="btn small secondary" onClick={() => setEdit(p)}>
                Bearbeiten
              </button>
            </div>
            <div className="grid2" style={{ marginTop: 12 }}>
              <Field label="Partnerbereich (Login per E-Mail-Link)">
                <CodeBox text={p.portal_url} />
              </Field>
              {p.public_signup ? (
                <Field label="Öffentliche Anmeldung">
                  <CodeBox text={p.signup_url} />
                </Field>
              ) : (
                <p className="muted small">Anmeldung nur über dich (öffentliche Anmeldung aus).</p>
              )}
            </div>
          </div>
        ))
      ) : (
        <Empty action={<button className="btn" onClick={() => setEdit({})}>Programm anlegen</button>}>Noch kein Partnerprogramm.</Empty>
      )}
      {edit && <ProgramModal p={edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), reload())} />}
    </>
  );
}

function ProgramModal({ p, onClose, onSaved }: { p: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>({
    name: p.name ?? '',
    commission_type: p.commission_type ?? 'percent',
    value: p.id ? (p.commission_type === 'fixed' ? euroIn(p.commission_value) : String(p.commission_value)) : '20',
    attribution: p.attribution ?? 'last',
    cookie_days: p.cookie_days ?? 30,
    recurring: !!p.recurring,
    threshold: euroIn(p.payout_threshold_cents ?? 5000),
    hold_days: p.hold_days ?? 0,
    landing_url: p.landing_url ?? '',
    public_signup: p.id ? !!p.public_signup : true,
    auto_approve: !!p.auto_approve,
    active: p.id ? !!p.active : true,
    terms: p.terms ?? '',
  });
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const save = async () => {
    const body = {
      name: f.name,
      commission_type: f.commission_type,
      commission_value: f.commission_type === 'fixed' ? toCents(f.value) : Number(String(f.value).replace(',', '.')),
      attribution: f.attribution,
      cookie_days: Number(f.cookie_days),
      recurring: f.recurring,
      payout_threshold_cents: toCents(f.threshold),
      hold_days: Number(f.hold_days),
      landing_url: f.landing_url,
      public_signup: f.public_signup,
      auto_approve: f.auto_approve,
      active: f.active,
      terms: f.terms,
    };
    const r = p.id ? await act(() => api.patch(`/api/affiliates/programs/${p.id}`, body), 'Gespeichert') : await act(() => api.post('/api/affiliates/programs', body), 'Angelegt');
    if (r) onSaved();
  };
  return (
    <Modal
      wide
      title={p.id ? 'Programm bearbeiten' : 'Neues Partnerprogramm'}
      onClose={onClose}
      footer={
        <>
          {p.id && (
            <button className="btn ghost" onClick={async () => confirmAsk('Programm mit allen Affiliates und Provisionen löschen?') && (await act(() => api.del(`/api/affiliates/programs/${p.id}`), 'Gelöscht')) && onSaved()}>
              Löschen
            </button>
          )}
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      <Field label="Name">
        <Input value={f.name} onChange={(v) => set('name', v)} placeholder="z. B. Partnerprogramm 2026" />
      </Field>
      <div className="grid3">
        <Field label="Provision">
          <Select
            value={f.commission_type}
            onChange={(v) => set('commission_type', v)}
            options={[
              ['percent', 'Prozent vom Nettoumsatz'],
              ['fixed', 'Festbetrag je Verkauf'],
            ]}
          />
        </Field>
        <Field label={f.commission_type === 'fixed' ? 'Betrag (€)' : 'Prozent'}>
          <Input value={f.value} onChange={(v) => set('value', v)} inputMode="decimal" />
        </Field>
        <Field label="Es zählt der">
          <Select
            value={f.attribution}
            onChange={(v) => set('attribution', v)}
            options={[
              ['last', 'letzte Klick'],
              ['first', 'erste Klick'],
            ]}
          />
        </Field>
        <Field label="Cookie-Laufzeit (Tage)" hint="So alt darf der Klick beim Lead sein">
          <Input type="number" min={1} max={365} value={f.cookie_days} onChange={(v) => set('cookie_days', v)} />
        </Field>
        <Field label="Auszahlung ab (€)">
          <Input value={f.threshold} onChange={(v) => set('threshold', v)} inputMode="decimal" />
        </Field>
        <Field label="Haltefrist (Tage)" hint="0 = Provisionen von Hand freigeben">
          <Input type="number" min={0} max={365} value={f.hold_days} onChange={(v) => set('hold_days', v)} />
        </Field>
      </div>
      <Field label="Ziel-Link der Partner-Links" hint="leer = dein erster Funnel; ?ref=<code> wird angehängt">
        <Input value={f.landing_url} onChange={(v) => set('landing_url', v)} placeholder="https://…" />
      </Field>
      <Check checked={f.recurring} onChange={(v) => set('recurring', v)} label="Provision auch auf Abo-Verlängerungen (wiederkehrend)" />
      <Check checked={f.public_signup} onChange={(v) => set('public_signup', v)} label="Öffentliche Anmeldung erlauben" />
      <Check checked={f.auto_approve} onChange={(v) => set('auto_approve', v)} label="Neue Anmeldungen sofort freischalten" />
      <Check checked={f.active} onChange={(v) => set('active', v)} label="Programm aktiv" />
      <Field label="Bedingungen (auf der Anmeldeseite)">
        <Textarea value={f.terms} onChange={(v) => set('terms', v)} />
      </Field>
    </Modal>
  );
}

function Commissions() {
  const [status, setStatus] = useState('pending');
  const [sel, setSel] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const list = useLoad(() => api.get<any[]>(`/api/affiliates/commissions${status ? `?status=${status}` : ''}`), [status]);
  const affiliates = useLoad(() => api.get<any[]>('/api/affiliates'), []);
  const rows = list.data ?? [];
  const reload = () => (setSel([]), list.reload());
  return (
    <>
      <div className="row" style={{ marginBottom: 12, alignItems: 'center' }} data-tour="affiliates-commissions">
        <div style={{ width: 200 }}>
          <Select
            value={status}
            onChange={(v) => (setStatus(v), setSel([]))}
            options={[
              ['pending', 'Offen'],
              ['approved', 'Freigegeben'],
              ['paid', 'Ausgezahlt'],
              ['reversed', 'Storniert'],
              ['', 'Alle'],
            ]}
          />
        </div>
        {sel.length > 0 && (
          <button className="btn" onClick={async () => (await act(() => api.post('/api/affiliates/commissions/approve', { ids: sel }), `${sel.length} freigegeben`)) && reload()}>
            {sel.length} freigeben
          </button>
        )}
        <button className="btn secondary" onClick={() => setAdding(true)}>
          + Gutschrift / Korrektur
        </button>
      </div>
      {!list.data ? (
        <Spinner />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 30 }}>
                  {status === 'pending' && <input type="checkbox" aria-label="Alle wählen" checked={sel.length === rows.length} onChange={(e) => setSel(e.target.checked ? rows.map((r) => r.id) : [])} />}
                </th>
                <th>Datum</th>
                <th>Affiliate</th>
                <th>Kunde / Beleg</th>
                <th>Art</th>
                <th className="num">Umsatz netto</th>
                <th className="num">Provision</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{c.status === 'pending' && <input type="checkbox" aria-label="Wählen" checked={sel.includes(c.id)} onChange={(e) => setSel(e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id))} />}</td>
                  <td className="muted">{day(c.created_at)}</td>
                  <td>
                    {c.affiliate_name} <span className="muted small">({c.code})</span>
                  </td>
                  <td>
                    {[c.first_name, c.last_name].filter(Boolean).join(' ') || c.customer_email || '–'}
                    <div className="muted small">{c.note}</div>
                  </td>
                  <td>{KIND[c.kind] ?? c.kind}</td>
                  <td className="num">{c.base_cents ? money(c.base_cents, c.currency) : '–'}</td>
                  <td className="num">
                    <strong>{money(c.amount_cents, c.currency)}</strong>
                  </td>
                  <td>
                    <Badge tone={C_STATUS[c.status]?.[1]}>{C_STATUS[c.status]?.[0] ?? c.status}</Badge>
                    {c.payout_id && c.status === 'approved' ? <span className="muted small"> in Auszahlung</span> : null}
                  </td>
                  <td>
                    {['pending', 'approved'].includes(c.status) && !c.payout_id && (
                      <button className="btn small ghost" onClick={async () => confirmAsk('Provision stornieren?') && (await act(() => api.post(`/api/affiliates/commissions/${c.id}/reverse`, {}), 'Storniert')) && reload()}>
                        Stornieren
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Keine Provisionen in dieser Ansicht.</Empty>
      )}
      <p className="muted small">Provisionen entstehen automatisch, wenn ein geworbener Kunde eine Rechnung bezahlt (auch über Stripe). Erstattungen und stornierte Rechnungen buchen sie zurück.</p>
      {adding && <ManualCommission affiliates={affiliates.data ?? []} onClose={() => setAdding(false)} onSaved={() => (setAdding(false), reload())} />}
    </>
  );
}

function ManualCommission({ affiliates, onClose, onSaved }: { affiliates: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ affiliate_id: affiliates[0]?.id ?? '', amount: '', note: '' });
  return (
    <Modal
      title="Gutschrift oder Korrektur"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={async () => (await act(() => api.post('/api/affiliates/commissions', { affiliate_id: f.affiliate_id, amount_cents: toCents(f.amount), note: f.note }), 'Gebucht')) && onSaved()}>
            Buchen
          </button>
        </>
      }
    >
      <Field label="Affiliate">
        <Select value={f.affiliate_id} onChange={(v) => setF({ ...f, affiliate_id: v })} options={affiliates.map((a) => [a.id, `${a.name || a.email} (${a.code})`] as [string, string])} />
      </Field>
      <Field label="Betrag (€)" hint="negativ für eine Belastung, z. B. -25">
        <Input value={f.amount} onChange={(v) => setF({ ...f, amount: v })} inputMode="decimal" />
      </Field>
      <Field label="Grund">
        <Input value={f.note} onChange={(v) => setF({ ...f, note: v })} />
      </Field>
    </Modal>
  );
}

function Payouts() {
  const list = useLoad(() => api.get<any[]>('/api/affiliates/payouts'), []);
  const [busy, setBusy] = useState(false);
  const rows = list.data ?? [];
  const open = rows.filter((o) => o.status === 'open');
  const loc = encodeURIComponent(currentLocation());
  return (
    <>
      <div className="actions" style={{ marginBottom: 12 }} data-tour="affiliates-payouts">
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await act(() => api.post('/api/affiliates/payouts', {}));
            setBusy(false);
            if (!r) return;
            toast(r.created.length ? `${r.created.length} Auszahlung(en) erstellt` : r.skipped.length ? `Noch niemand über der Auszahlungsgrenze (${r.skipped.length} darunter)` : 'Keine freigegebenen Provisionen');
            list.reload();
          }}
        >
          <Icon name="price" /> Auszahlungen erstellen
        </button>
        {open.length > 0 && (
          <>
            <a className="btn secondary" href={`/api/affiliates/payouts/export.csv?locationId=${loc}`}>
              <Icon name="download" /> CSV (offen)
            </a>
            <a className="btn secondary" href={`/api/affiliates/payouts/sepa.xml?locationId=${loc}`}>
              <Icon name="download" /> SEPA-Datei (offen)
            </a>
          </>
        )}
      </div>
      {!list.data ? (
        <Spinner />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Erstellt</th>
                <th>Affiliate</th>
                <th>Verwendungszweck</th>
                <th>Methode</th>
                <th className="num">Betrag</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td className="muted">{day(o.created_at)}</td>
                  <td>
                    {o.affiliate_name || o.email}
                    <div className="muted small">{o.commissions} Provisionen</div>
                  </td>
                  <td className="small">
                    {o.reference} <Copy text={o.reference} label="Kopieren" />
                  </td>
                  <td>
                    {o.method === 'paypal' ? 'PayPal' : 'SEPA'} {(o.method === 'paypal' ? !o.has_paypal : !o.has_iban) && <Badge tone="red">Daten fehlen</Badge>}
                  </td>
                  <td className="num">
                    <strong>{money(o.amount_cents, o.currency)}</strong>
                  </td>
                  <td>
                    <Badge tone={C_STATUS[o.status]?.[1]}>{o.status === 'paid' ? `ausgezahlt ${day(o.paid_at)}` : 'offen'}</Badge>
                  </td>
                  <td>
                    {o.status === 'open' && (
                      <div className="actions">
                        <button className="btn small" onClick={async () => (await act(() => api.post(`/api/affiliates/payouts/${o.id}/paid`, {}), 'Als ausgezahlt markiert')) && list.reload()}>
                          Ausgezahlt
                        </button>
                        <button className="btn small ghost" onClick={async () => confirmAsk('Auszahlung löschen? Die Provisionen bleiben freigegeben.') && (await act(() => api.del(`/api/affiliates/payouts/${o.id}`), 'Gelöscht')) && list.reload()}>
                          Löschen
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Noch keine Auszahlungen. „Auszahlungen erstellen“ bündelt freigegebene Provisionen je Affiliate ab der Auszahlungsgrenze.</Empty>
      )}
      <p className="muted small">Die SEPA-Datei (pain.001) lädst du im Online-Banking hoch; sie nutzt deine IBAN aus Einstellungen → Rechnungen. Danach die Auszahlungen als „Ausgezahlt“ markieren.</p>
    </>
  );
}
