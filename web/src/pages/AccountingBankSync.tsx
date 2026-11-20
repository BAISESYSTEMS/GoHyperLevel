import { useEffect, useMemo, useState } from 'react';
import { api, money } from '../api';
import { Icon } from '../icons';
import { act, Badge, Check, CodeBox, confirmAsk, Field, Input, Modal, Select, Spinner, Textarea, toast, toastError, useLoad } from '../ui';
import { germanDate } from './boCommon';

const PEM_HINT = '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'; // oss-check: allow (placeholder, no key)

/**
 * Buchhaltung → Bank: the bank sync through Enable Banking (PSD2, read only). Connect a business account with the bank's
 * own login; booked transactions then arrive by themselves every 8 hours (or on „Jetzt abrufen“) in the list below and are
 * matched with open invoices and receipts. The agency registers the Enable Banking application once.
 */

const COUNTRIES: [string, string][] = [
  ['DE', 'Deutschland'],
  ['AT', 'Österreich'],
  ['NL', 'Niederlande'],
  ['BE', 'Belgien'],
  ['LU', 'Luxemburg'],
  ['FR', 'Frankreich'],
  ['IT', 'Italien'],
  ['ES', 'Spanien'],
  ['PT', 'Portugal'],
  ['IE', 'Irland'],
  ['PL', 'Polen'],
  ['DK', 'Dänemark'],
  ['SE', 'Schweden'],
  ['NO', 'Norwegen'],
  ['FI', 'Finnland'],
];

const ibanShort = (iban: string) => (iban ? `${iban.slice(0, 4)} ··· ${iban.slice(-4)}` : '');
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–');

export function BankSyncPanel({ onSynced }: { onSynced: () => void }) {
  const st = useLoad(() => api.get('/api/accounting/bank/sync'), []);
  const [connect, setConnect] = useState<{ bank?: string; country?: string; psu_type?: string } | null>(null);
  const [agency, setAgency] = useState(false);
  const [busy, setBusy] = useState('');
  const reload = () => void st.reload();

  // Back from the bank: say how it went, and look again once the first sync (running in the background) is through.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const r = p.get('bank');
    if (!r) return;
    window.history.replaceState(null, '', window.location.pathname);
    if (r !== 'ok') {
      toastError(new Error(p.get('msg') || 'Verbinden fehlgeschlagen'));
      return;
    }
    toast('Bank verbunden – die Umsätze werden abgerufen');
    const timers = [3000, 9000].map((ms) => window.setTimeout(() => (reload(), onSynced()), ms));
    return () => timers.forEach((x) => window.clearTimeout(x));
  }, []);

  const s = st.data;
  if (!s) return st.loading ? <Spinner /> : null;
  const conns: any[] = s.connections ?? [];

  const runSync = async (c: any) => {
    setBusy(c.id);
    const r = await act(() => api.post(`/api/accounting/bank/sync/${c.id}/run`));
    setBusy('');
    if (r) {
      toast(r.added ? `${r.added} neue Umsätze, ${r.matched} zugeordnet` : 'Keine neuen Umsätze');
      onSynced();
    }
    reload();
  };
  const disconnect = async (c: any) => {
    if (!confirmAsk(`${c.bank} trennen? Die Freigabe bei der Bank wird beendet. Schon abgerufene Umsätze bleiben in der Liste.`)) return;
    if ((await act(() => api.del(`/api/accounting/bank/sync/${c.id}`), 'Bank getrennt')) !== undefined) reload();
  };
  const toggle = async (c: any, a: any, enabled: boolean) => {
    if ((await act(() => api.patch(`/api/accounting/bank/sync/${c.id}/accounts/${a.id}`, { enabled }))) !== undefined) reload();
  };

  return (
    <div className="card" style={{ marginBottom: 14 }} data-tour="acc-bank-sync">
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0 }}>
          <Icon name="link" /> Bankkonto verbinden
        </h3>
        <div style={{ marginLeft: 'auto' }} className="row">
          {s.admin && (
            <button className="btn secondary small" onClick={() => setAgency(true)}>
              <Icon name="settings" /> Agentur-Zugang
            </button>
          )}
          {s.ready && s.can_manage && (
            <button className="btn small" onClick={() => setConnect({})} data-tour="acc-bank-connect">
              <Icon name="plus" /> Bank verbinden
            </button>
          )}
        </div>
      </div>
      {!s.ready ? (
        <p className="muted small" style={{ marginBottom: 0 }}>
          Umsätze automatisch abrufen statt Dateien hochladen: über <strong>Enable Banking</strong> (lizenzierter PSD2-Dienst, nur lesend, fast alle deutschen Banken und Sparkassen).{' '}
          {s.admin ? 'Dafür einmal unter „Agentur-Zugang“ die App-ID und den privaten Schlüssel eintragen.' : 'Das richtet die Agentur einmal ein – bitte dort fragen.'}
        </p>
      ) : !conns.length ? (
        <p className="muted small" style={{ marginBottom: 0 }}>
          Verbinde dein Geschäftskonto mit dem Login deiner Bank: Die gebuchten Umsätze kommen dann alle 8 Stunden von selbst und werden mit offenen Rechnungen und Belegen abgeglichen. Nur lesend – Überweisungen sind darüber nicht möglich. Die Freigabe gilt bis zu 180 Tage.
          {!s.can_manage && ' Verbinden dürfen Admins und Personen mit dem Recht „Einstellungen“.'}
        </p>
      ) : (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="t">
            <tbody>
              {conns.map((c) => (
                <tr key={c.id}>
                  <td style={{ verticalAlign: 'top', minWidth: 180 }}>
                    <strong>{c.bank}</strong>
                    <div style={{ marginTop: 4 }}>
                      {c.status === 'expired' ? <Badge tone="red">Freigabe abgelaufen</Badge> : c.renew_soon ? <Badge tone="yellow">Läuft in {c.days_left} Tagen ab</Badge> : <Badge tone="green">Aktiv bis {germanDate(String(c.valid_until).slice(0, 10))}</Badge>}
                    </div>
                    <div className="muted small" style={{ marginTop: 4 }}>
                      Zuletzt abgerufen: {when(c.last_sync_at)}
                    </div>
                    {c.last_error && (
                      <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>
                        {c.last_error}
                      </div>
                    )}
                  </td>
                  <td style={{ verticalAlign: 'top' }}>
                    {(c.accounts ?? []).map((a: any) => (
                      <div key={a.id} className="row" style={{ alignItems: 'center', gap: 10, marginBottom: 4 }}>
                        <Check checked={a.enabled} onChange={(v) => toggle(c, a, v)} label={<span>{a.name || 'Konto'} <span className="muted">{ibanShort(a.iban)}</span></span>} aria={`${a.name || 'Konto'} abrufen`} />
                        {a.balance_cents != null && <span className="muted small">Saldo {money(a.balance_cents, a.balance_currency || a.currency)}</span>}
                      </div>
                    ))}
                  </td>
                  <td style={{ verticalAlign: 'top', whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {c.status !== 'expired' && (
                      <button className="btn secondary small" disabled={busy === c.id} onClick={() => runSync(c)}>
                        <Icon name="refresh" /> {busy === c.id ? 'Ruft ab …' : 'Jetzt abrufen'}
                      </button>
                    )}{' '}
                    {s.can_manage && (c.status === 'expired' || c.renew_soon) && (
                      <button className="btn small" onClick={() => setConnect({ bank: c.bank, country: c.country, psu_type: c.psu_type })}>
                        Neu verbinden
                      </button>
                    )}{' '}
                    {s.can_manage && (
                      <button className="btn ghost small" onClick={() => disconnect(c)} aria-label={`${c.bank} trennen`}>
                        Trennen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {connect && <ConnectDialog preset={connect} onClose={() => setConnect(null)} />}
      {agency && <AgencyDialog onClose={() => (setAgency(false), reload())} />}
    </div>
  );
}

function ConnectDialog({ preset, onClose }: { preset: { bank?: string; country?: string; psu_type?: string }; onClose: () => void }) {
  const [country, setCountry] = useState(preset.country || 'DE');
  const [q, setQ] = useState(preset.bank ?? '');
  const [bank, setBank] = useState(preset.bank ?? '');
  const [psuType, setPsuType] = useState(preset.psu_type || 'business');
  const [going, setGoing] = useState(false);
  const list = useLoad(() => api.get(`/api/accounting/bank/sync/banks?country=${country}`), [country]);
  const banks: any[] = list.data ?? [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return banks.filter((b) => !needle || b.name.toLowerCase().includes(needle) || String(b.bic).toLowerCase().includes(needle)).slice(0, 60);
  }, [banks, q]);
  const chosen = banks.find((b) => b.name === bank);
  const go = async () => {
    setGoing(true);
    const r = await act(() => api.post('/api/accounting/bank/sync/start', { bank, country, psu_type: psuType }));
    if (r?.url) window.location.href = r.url;
    else setGoing(false);
  };
  return (
    <Modal
      title="Bank verbinden"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" disabled={!chosen || going} onClick={go}>
            {going ? 'Weiter zur Bank …' : 'Weiter zur Bank'}
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 10 }}>
        <div style={{ width: 180 }}>
          <Field label="Land">
            <Select value={country} onChange={(v) => (setCountry(v), setBank(''))} options={COUNTRIES} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Bank suchen">
            <Input value={q} onChange={setQ} placeholder="z. B. Sparkasse, Volksbank, Commerzbank …" autoFocus />
          </Field>
        </div>
      </div>
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.error ? (
        <p className="small" style={{ color: 'var(--red)' }}>
          {list.error}
        </p>
      ) : (
        <div role="listbox" aria-label="Banken" style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
          {shown.map((b) => (
            <button
              key={b.name}
              type="button"
              role="option"
              aria-selected={b.name === bank}
              className={`row${b.name === bank ? ' on' : ''}`}
              onClick={() => setBank(b.name)}
              style={{ width: '100%', alignItems: 'center', gap: 10, padding: '6px 10px', border: 0, background: b.name === bank ? 'var(--brand-soft)' : 'transparent', textAlign: 'left', cursor: 'pointer' }}
            >
              {b.logo ? <img src={b.logo} alt="" width={24} height={24} style={{ objectFit: 'contain' }} loading="lazy" /> : <Icon name="bank" />}
              <span>{b.name}</span>
              {b.beta && <Badge>Beta</Badge>}
            </button>
          ))}
          {!shown.length && <p className="muted small" style={{ padding: 10, margin: 0 }}>Keine Bank gefunden.</p>}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <Field label="Kontoart">
          <Select value={psuType} onChange={setPsuType} options={[['business', 'Geschäftskonto'], ['personal', 'Privatkonto']]} />
        </Field>
      </div>
      <p className="muted small">
        Du meldest dich gleich direkt bei deiner Bank an und gibst die Umsätze frei – HyperLevel sieht dein Bank-Passwort nie. Der Zugriff ist nur lesend (Kontostand und gebuchte Umsätze) und endet spätestens nach {chosen?.max_days ? Math.min(180, chosen.max_days) : 180} Tagen.
        Der erste Abruf beginnt nach dem letzten schon importierten Umsatz dieses Kontos (sonst 90 Tage zurück) – so entstehen keine Doppelten.
      </p>
    </Modal>
  );
}

function AgencyDialog({ onClose }: { onClose: () => void }) {
  const cur = useLoad(() => api.get('/api/accounting/bank/sync/agency'), []);
  const [appId, setAppId] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const c = cur.data;
  const save = async (clear = false) => {
    const body: Record<string, unknown> = { app_id: appId ?? c?.app_id ?? '' };
    if (clear) body.private_key = null;
    else if (key.trim()) body.private_key = key.trim();
    if ((await act(() => api.put('/api/accounting/bank/sync/agency', body), 'Gespeichert')) !== undefined) {
      setKey('');
      void cur.reload();
    }
  };
  return (
    <Modal
      title="Enable Banking – Agentur-Zugang"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Schließen
          </button>
          <button className="btn" onClick={() => save()}>
            Speichern
          </button>
        </>
      }
    >
      {!c ? (
        <Spinner />
      ) : (
        <>
          <p className="small">
            Einmal pro Installation: Bei{' '}
            <a href="https://enablebanking.com/cp/applications" target="_blank" rel="noreferrer">
              enablebanking.com
            </a>{' '}
            eine Anwendung anlegen (Umgebung <strong>Production</strong>, für eigene Konten kostenlos „restricted“), als Redirect-URL die Adresse unten eintragen. Enable Banking erzeugt dabei einen privaten Schlüssel (.pem) – den hier einfügen, er wird verschlüsselt gespeichert und nie wieder angezeigt.
          </p>
          <Field label="Redirect-URL (bei Enable Banking eintragen)">
            {(c.redirect_uris as string[]).map((u) => (
              <CodeBox key={u} text={u} />
            ))}
          </Field>
          <Field label="App-ID (Application ID)">
            <Input value={appId ?? c.app_id} onChange={setAppId} placeholder="1a2b3c4d-…" spellCheck={false} />
          </Field>
          <Field label="Privater Schlüssel (.pem)" hint={c.key_set ? 'Hinterlegt – nur ausfüllen, um ihn zu ersetzen.' : undefined}>
            <Textarea value={key} onChange={setKey} rows={6} placeholder={c.key_set ? '•••••••• (hinterlegt)' : PEM_HINT} spellCheck={false} autoComplete="off" style={{ fontFamily: 'monospace', fontSize: 12 }} />
          </Field>
          <div className="row" style={{ alignItems: 'center' }}>
            {c.ready ? <Badge tone="green">Eingerichtet</Badge> : <Badge tone="yellow">Noch nicht eingerichtet</Badge>}
            {c.key_set && (
              <button className="btn ghost small" onClick={() => confirmAsk('Den privaten Schlüssel entfernen? Danach ruft keine Bankverbindung mehr ab.') && save(true)}>
                Schlüssel entfernen
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
