import { useState } from 'react';
import { api, dt } from '../api';
import { act, Badge, Empty, Input, Spinner, Stat, useLoad } from '../ui';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Agentur → Cloud → Warteliste: whether the waitlist mode is on (and why), where the sign-ups go (the HQ form with Double-Opt-in, or the
 * built-in list), the built-in list with search, CSV export and delete (data protection). Server side: modules/cloud-waitlist.ts,
 * docs/cloud.md#waitlist-mode. German only, like the rest of the operator console.
 */

interface Item {
  id: string;
  email: string;
  name: string;
  plan: string;
  lang: string;
  source: string;
  consent_text: string;
  consent_at: string;
  created_at: string;
  updated_at: string;
}
interface Data {
  enabled: boolean;
  reason: 'env' | 'no_billing' | null;
  cloud: boolean;
  via: 'forms' | 'builtin';
  forms: { location_id: string; location_name: string; form_id: string; doi: boolean } | null;
  privacy_url: string;
  total: number;
  by_plan: Record<string, number>;
  items: Item[];
}

const PLAN: Record<string, string> = { solo: 'Cloud Solo', team: 'Cloud Team & Company', agency: 'Cloud Agentur' };
const REASON: Record<string, string> = {
  env: 'PGHL_CLOUD_WAITLIST=1 ist gesetzt.',
  no_billing: 'Stripe ist nicht eingerichtet – ohne Abrechnung bleibt die Cloud automatisch auf der Warteliste.',
};

export function CloudWaitlist() {
  const [q, setQ] = useState('');
  const d = useLoad(() => api.get<Data>(`/api/cloud/waitlist${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`), [q]);
  const x = d.data;
  if (!x) return <Spinner />;
  const remove = async (it: Item) => {
    if (!window.confirm(`${it.email} von der Warteliste löschen? Das lässt sich nicht rückgängig machen.`)) return;
    if (await act(() => api.del(`/api/cloud/waitlist/${it.id}`), 'Gelöscht')) d.reload();
  };
  return (
    <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>
          Warteliste {x.enabled ? <Badge tone="green">aktiv</Badge> : <Badge tone="gray">aus</Badge>}
        </h3>
        {x.enabled ? (
          <p style={{ margin: 0 }}>
            Neue Anmeldungen, Zahlungen und Testphasen sind gesperrt; Preis- und Startseite zeigen die geplanten Tarife und das Wartelisten-Formular. Bestehende Kunden arbeiten normal weiter.{' '}
            <span className="muted">{x.reason ? REASON[x.reason] : ''}</span>
          </p>
        ) : (
          <p style={{ margin: 0 }}>Die Cloud ist offen: Kunden melden sich unter /start an. Das Formular nimmt keine Einträge an; die Liste unten bleibt erhalten.</p>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>
          {x.forms
            ? `Einträge gehen in das Formular ${x.forms.form_id} des Sub-Accounts „${x.forms.location_name || x.forms.location_id}“ (PGHL_LANDING_LOCATION)${x.forms.doi ? ' mit Double-Opt-in' : ''} – dort stehen sie als Kontakte mit Einwilligungsnachweis. Hier steht nur, was vorher in der eingebauten Liste gelandet ist.`
            : 'Einträge landen in der eingebauten Liste unten: E-Mail, optional Name und Tarif, Sprache, Einwilligungstext mit Zeitpunkt, IP nur als Hash. Die Liste verschickt nie selbst E-Mails.'}
          {x.privacy_url ? ` Datenschutz-Link am Formular: ${x.privacy_url}` : ' Kein Datenschutz-Link gesetzt (PGHL_LANDING_PRIVACY_URL).'}
        </p>
      </div>
      <SortableGrid id="cloud-waitlist.stats" className="stats" style={{ margin: '12px 0' }}>
        <Stat label="Einträge" value={x.total} />
        {Object.entries(PLAN).map(([k, n]) => (
          <Stat key={k} label={n} value={x.by_plan[k] ?? 0} />
        ))}
        <Stat label="Noch unsicher" value={x.by_plan.none ?? 0} />
      </SortableGrid>
      <div className="card">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ flex: '1 1 240px' }}>
            <Input value={q} onChange={setQ} placeholder="Suchen (E-Mail oder Name)" aria-label="Warteliste durchsuchen" />
          </div>
          <a className="btn small secondary" href="/api/cloud/waitlist.csv" download>
            CSV exportieren
          </a>
        </div>
        {x.items.length ? (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Eingetragen</th>
                  <th>E-Mail</th>
                  <th>Tarif</th>
                  <th>Sprache</th>
                  <th>Einwilligung</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {x.items.map((it) => (
                  <tr key={it.id}>
                    <td className="nowrap">{dt(it.created_at)}</td>
                    <td>
                      {it.email}
                      {it.name && <div className="muted small">{it.name}</div>}
                    </td>
                    <td>{PLAN[it.plan] ?? '–'}</td>
                    <td>{it.lang === 'en' ? 'Englisch' : 'Deutsch'}</td>
                    <td className="nowrap" title={it.consent_text}>
                      {dt(it.consent_at)}
                    </td>
                    <td>
                      <button className="btn small secondary" onClick={() => remove(it)}>
                        Löschen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{q ? 'Nichts gefunden.' : 'Noch niemand auf der Warteliste.'}</Empty>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>
          Auskunft und Löschung (DSGVO): Einträge einzeln löschen; der Export und jede Löschung stehen im Protokoll. Die eingebaute Liste sammelt ohne Double-Opt-in und sendet nie selbst – die Nachricht zum Start verschickst du einmal selbst, ohne weitere Werbung.
        </p>
      </div>
    </>
  );
}
