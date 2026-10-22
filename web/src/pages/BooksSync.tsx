import { useEffect, useState } from 'react';
import { api, dt, money } from '../api';
import { Icon } from '../icons';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, act, confirmAsk, useLoad } from '../ui';

/**
 * Apps → Buchhaltung: live sync with Lexware Office or sevDesk. Connect with the API key (sealed on the server, never shown
 * again), choose the mapping, test the connection; finalised invoices and credit notes go over by themselves, payments come
 * back every two hours. Queue with retry and the error log below. Server: modules/books-sync.ts, docs/integrations.md.
 */

type Json = Record<string, any>;
type Provider = 'lexware' | 'sevdesk';

const STATUS: Record<string, [string, 'gray' | 'green' | 'red' | 'blue' | 'yellow']> = {
  pending: ['wartet', 'blue'],
  running: ['läuft', 'blue'],
  retry: ['neuer Versuch geplant', 'yellow'],
  done: ['übertragen', 'green'],
  failed: ['Fehler', 'red'],
  skipped: ['übersprungen', 'gray'],
};
const BLURB: Record<Provider, string> = {
  lexware: 'Jede festgeschriebene Rechnung wird in Lexware Office als Beleg gebucht – mit deiner Rechnungsnummer, Kunde, einem Posten je Steuersatz und deinem PDF. Lexware erzeugt keine zweite Rechnung.',
  sevdesk: 'Jede festgeschriebene Rechnung wird in sevDesk mit deiner Nummer, Kunde und allen Positionen angelegt und als versendet markiert (ohne sie zu verschicken). Gutschriften werden zu sevDesk-Gutschriften.',
};

export function BooksSync() {
  const st = useLoad(() => api.get<Json>('/api/books-sync'), []);
  const jobs = useLoad(() => api.get<Json[]>('/api/books-sync/jobs?limit=50'), []);
  const log = useLoad(() => api.get<Json[]>('/api/books-sync/log?limit=50'), []);
  const [edit, setEdit] = useState<Provider | null>(null);
  const [backfill, setBackfill] = useState(false);
  const [busy, setBusy] = useState('');
  const reload = () => (st.reload(), jobs.reload(), log.reload());
  const run = async (key: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(key);
    const r = await act(fn, ok);
    setBusy('');
    reload();
    return r;
  };
  if (st.error) return <Empty>{st.error}</Empty>;
  if (!st.data) return <Spinner />;
  const s = st.data;
  const active: Provider | '' = s.connected ? s.provider : '';
  const counts: Json = s.counts ?? {};
  return (
    <div className="books" data-tour="books-sync">
      <p className="muted">
        Rechnungen bleiben in HyperLevel – deine Buchhaltung bekommt sie automatisch: festgeschriebene Rechnungen und Gutschriften gehen sofort rüber, Zahlungseingänge kommen zurück und werden hier als Zahlung verbucht. Der API-Schlüssel wird verschlüsselt gespeichert und nie wieder angezeigt.
      </p>
      <div className="books-providers">
        {(s.providers as Json[]).map((p) => {
          const on = active === p.key;
          const other = !!active && !on;
          return (
            <div className="card books-provider" key={p.key} data-tour={`books-${p.key}`}>
              <div className="books-head">
                <span className="integ-ico">
                  <Icon name="invoices" size={18} />
                </span>
                <strong>{p.name}</strong>
                {on ? <Badge tone={!s.enabled ? 'gray' : s.last_test_ok === false || counts.failed ? 'red' : 'green'}>{!s.enabled ? 'pausiert' : s.last_test_ok === false ? 'Test fehlgeschlagen' : counts.failed ? `${counts.failed} Fehler` : 'verbunden'}</Badge> : <Badge>nicht verbunden</Badge>}
              </div>
              <p className="small">{BLURB[p.key as Provider]}</p>
              {on && s.last_test_at && (
                <p className="muted small">
                  Letzter Test {dt(s.last_test_at)}: {s.last_test_result}
                </p>
              )}
              {on && s.last_pull_at && <p className="muted small">Zahlungen zuletzt abgeglichen {dt(s.last_pull_at)}</p>}
              <div className="books-actions">
                <button className={on ? 'btn secondary' : 'btn'} disabled={other} title={other ? 'Es ist schon ein anderes Programm verbunden' : undefined} onClick={() => setEdit(p.key)}>
                  {on ? 'Einstellungen' : 'Verbinden'}
                </button>
                {on && (
                  <>
                    <button className="btn secondary" disabled={!!busy} onClick={() => run('test', () => api.post('/api/books-sync/test'), 'Verbindung klappt')}>
                      Verbindung testen
                    </button>
                    <button className="btn secondary" disabled={!!busy || !s.options.pull_payments} onClick={() => run('pull', () => api.post('/api/books-sync/pull'), 'Zahlungen abgeglichen')}>
                      <Icon name="refresh" /> Zahlungen abgleichen
                    </button>
                    <button className="btn secondary" disabled={!!busy} onClick={() => setBackfill(true)}>
                      Ältere Rechnungen übertragen
                    </button>
                    <button className="btn ghost" disabled={!!busy} onClick={() => confirmAsk(`${p.name} trennen? Bereits übertragene Belege bleiben dort, neue gehen nicht mehr rüber.`) && run('del', () => api.del('/api/books-sync'), 'Getrennt')}>
                      Trennen
                    </button>
                  </>
                )}
              </div>
              <p className="muted small">
                {p.key_help}{' '}
                <a href={p.docs} target="_blank" rel="noreferrer noopener">
                  API-Doku ↗
                </a>
              </p>
            </div>
          );
        })}
      </div>

      {active && (
        <div className="card" data-tour="books-queue">
          <div className="books-head">
            <h2 style={{ margin: 0 }}>Übertragungen</h2>
            <span className="muted small">
              {counts.done ?? 0} übertragen · {(counts.pending ?? 0) + (counts.running ?? 0) + (counts.retry ?? 0)} in Arbeit · {counts.failed ?? 0} Fehler
            </span>
          </div>
          {!jobs.data ? (
            <Spinner />
          ) : !jobs.data.length ? (
            <p className="muted">Noch nichts übertragen – die nächste festgeschriebene Rechnung geht automatisch rüber.</p>
          ) : (
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Beleg</th>
                    <th>Betrag</th>
                    <th>Status</th>
                    <th>Hinweis</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {jobs.data.map((j) => (
                    <tr key={j.id}>
                      <td>
                        {j.kind === 'credit_note' ? 'Gutschrift' : 'Rechnung'} {j.number}
                        <div className="muted small">{dt(j.created_at)}</div>
                      </td>
                      <td>{money(j.total_cents, j.currency)}</td>
                      <td>
                        <Badge tone={STATUS[j.status]?.[1] ?? 'gray'}>{STATUS[j.status]?.[0] ?? j.status}</Badge>
                        {j.status === 'retry' && <div className="muted small">nächster Versuch {dt(j.next_at)}</div>}
                      </td>
                      <td className="small">{j.last_error || (j.remote_id ? `ID ${j.remote_id}` : '')}</td>
                      <td>
                        {['failed', 'retry', 'skipped'].includes(j.status) && (
                          <button className="btn secondary" disabled={!!busy} onClick={() => run(`retry-${j.id}`, () => api.post(`/api/books-sync/jobs/${j.id}/retry`), 'Neuer Versuch gestartet')}>
                            Erneut versuchen
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {active && (
        <div className="card" data-tour="books-log">
          <h2>Protokoll</h2>
          {!log.data?.length ? (
            <p className="muted">Noch keine Einträge.</p>
          ) : (
            <ul className="books-log">
              {log.data.map((l) => (
                <li key={l.id} className={l.level === 'error' ? 'err' : ''}>
                  <span className="muted small">{dt(l.created_at)}</span> <Badge tone={l.level === 'error' ? 'red' : 'gray'}>{l.level === 'error' ? 'Fehler' : 'Info'}</Badge> {l.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {edit && <ConnectModal provider={edit} state={s} onClose={() => setEdit(null)} onSaved={reload} />}
      {backfill && <BackfillModal onClose={() => setBackfill(false)} onDone={reload} />}
    </div>
  );
}

function ConnectModal({ provider, state, onClose, onSaved }: { provider: Provider; state: Json; onClose: () => void; onSaved: () => void }) {
  const def = (state.providers as Json[]).find((p) => p.key === provider)!;
  const same = state.provider === provider && state.connected;
  const [key, setKey] = useState('');
  const [o, setO] = useState<Json>(same ? state.options : { ...state.options, contact_match: 'auto' });
  const [enabled, setEnabled] = useState<boolean>(same ? state.enabled : true);
  const [busy, setBusy] = useState(false);
  useEffect(() => setKey(''), [provider]);
  const set = (k: string, v: unknown) => setO({ ...o, [k]: v });
  const save = async (test: boolean) => {
    setBusy(true);
    const r = await act(() => api.put('/api/books-sync', { provider, enabled, options: o, ...(key ? { api_key: key } : {}) }), test ? undefined : 'Gespeichert');
    if (r && test) await act(() => api.post('/api/books-sync/test'), 'Verbindung klappt');
    setBusy(false);
    onSaved();
    if (r) onClose();
  };
  return (
    <Modal
      title={`${def.name} verbinden`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn secondary" disabled={busy || (!same && !key)} onClick={() => save(false)}>
            Speichern
          </button>
          <button className="btn" disabled={busy || (!same && !key)} onClick={() => save(true)}>
            Speichern & testen
          </button>
        </>
      }
    >
      <div className="books-form" data-tour="books-connect">
        <Field label={def.key_label} hint={def.key_help}>
          <Input type="password" autoComplete="off" value={key} onChange={setKey} placeholder={same ? `•••••••• gespeichert (${state.hint})` : 'Schlüssel einfügen'} />
        </Field>
        <Check checked={enabled} onChange={setEnabled} label="Automatisch übertragen (aus = pausiert, nichts geht rüber)" />
        <h4>Zuordnung</h4>
        <div className="grid2">
          <Field label="Kunde in der Buchhaltung" hint="Erst die gespeicherte Verknüpfung, dann Kundennummer, dann E-Mail – sonst wird der Kunde angelegt.">
            <Select value={o.contact_match} onChange={(v) => set('contact_match', v)} options={provider === 'lexware' ? [['auto', 'Kunden abgleichen oder anlegen'], ['collective', 'Sammelkunde (ohne Kundendaten)']] : [['auto', 'Kunden abgleichen oder anlegen']]} />
          </Field>
          <Field label="Eigenes Feld mit der Kundennummer" hint="Schlüssel des eigenen Kontaktfelds (der Umzug füllt customer_number)">
            <Input value={o.customer_number_field} onChange={(v) => set('customer_number_field', v)} placeholder="customer_number" />
          </Field>
          {provider === 'lexware' && (
            <Field label="Buchungskategorie (ID)" hint="Standard: Einnahmen. Andere IDs liefert GET /v1/posting-categories.">
              <Input value={o.category_id} onChange={(v) => set('category_id', v)} />
            </Field>
          )}
          {provider === 'sevdesk' && (
            <>
              <Field label="Ansprechpartner (sevDesk-Benutzer-ID)" hint="Leer = wird beim Test automatisch gesetzt">
                <Input value={o.sev_user_id} onChange={(v) => set('sev_user_id', v)} />
              </Field>
              <Field label="Einheit der Positionen (ID)" hint="1 = Stück">
                <Input value={o.unity_id} onChange={(v) => set('unity_id', v)} />
              </Field>
            </>
          )}
        </div>
        <Check checked={!!o.push_credit_notes} onChange={(v) => set('push_credit_notes', v)} label="Gutschriften und Stornorechnungen übertragen" />
        <Check checked={!!o.pull_payments} onChange={(v) => set('pull_payments', v)} label="Zahlungseingänge zurückholen und hier als Zahlung verbuchen (alle 2 Stunden)" />
        {provider === 'lexware' && <Check checked={!!o.attach_pdf} onChange={(v) => set('attach_pdf', v)} label="PDF der Rechnung an den Beleg hängen" />}
        {provider === 'sevdesk' && <Check checked={!!o.mark_sent} onChange={(v) => set('mark_sent', v)} label="In sevDesk als versendet markieren (es wird nichts verschickt)" />}
        <p className="muted small">Übertragen werden nur festgeschriebene Belege – nie doppelt: jede Rechnung hat genau einen Auftrag, und vor dem Anlegen wird nach der Rechnungsnummer gesucht.</p>
      </div>
    </Modal>
  );
}

function BackfillModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [since, setSince] = useState(`${new Date().getFullYear()}-01-01`);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Ältere Rechnungen übertragen"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn"
            disabled={busy || !/^\d{4}-\d\d-\d\d$/.test(since)}
            onClick={async () => {
              setBusy(true);
              const r = await act(() => api.post<Json>('/api/books-sync/backfill', { since }));
              setBusy(false);
              if (r) {
                onDone();
                onClose();
              }
            }}
          >
            Übertragen
          </button>
        </>
      }
    >
      <Field label="Rechnungsdatum ab" hint="Festgeschriebene Rechnungen ab diesem Datum, die noch nirgends verknüpft sind (höchstens 200 auf einmal).">
        <Input type="date" value={since} onChange={setSince} />
      </Field>
    </Modal>
  );
}
