import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { Badge, Check, CodeBox, Field, Input, Link, Select, Spinner, act, confirmAsk, toast, toastError, useLoad } from '../ui';
import { useSession } from '../session';
import { fromCents, toCents } from './AdsKit';

/** Verbindungen: Meta and Google Ads per login, choice of the ad account, the daily budget limit, and the agency's apps. */

export function AdsConnections() {
  const { data, loading, reload } = useLoad(() => api.get<any>('/api/ads/connections'), []);
  const session = useSession();

  // The OAuth round trip comes back here with ?oauth=ok|error.
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const r = p.get('oauth');
    if (!r) return;
    if (r === 'ok') toast(`${p.get('platform') === 'google' ? 'Google Ads' : 'Meta'} verbunden – jetzt Konto wählen`);
    else toastError(new Error(p.get('msg') || 'Verbinden fehlgeschlagen'));
    history.replaceState(null, '', location.pathname);
    void reload();
  }, []);

  if (loading && !data) return <Spinner />;
  if (!data) return <p>Kein Zugriff auf die Verbindungen.</p>;
  return (
    <>
      <MetaCard c={data.meta} reload={reload} />
      <GoogleCard c={data.google} reload={reload} />
      <LimitCard cents={data.settings.max_daily_budget_cents} reload={reload} />
      {session.user.role === 'admin' && <AgencyCard />}
      <p className="muted small">
        Statt der Anmeldung geht auch ein Token von Hand (Systemnutzer bei Meta, Refresh-Token bei Google): <Link to="attribution/settings">Attribution → Tracking & Werbekonten</Link>. Die Verbindung dient auch den Werbeberichten.
      </p>
    </>
  );
}

const expires = (iso: string | null) => {
  if (!iso) return null;
  const days = Math.round((Date.parse(iso) - Date.now()) / 864e5);
  return days < 0 ? 'abgelaufen' : days <= 14 ? `läuft in ${days} Tagen ab (wird automatisch verlängert)` : `gültig bis ${new Date(iso).toLocaleDateString('de-DE')}`;
};

function StatusLine({ c }: { c: any }) {
  return c.connected ? <Badge tone={c.last_error ? 'red' : 'green'}>{c.last_error ? 'Fehler' : 'verbunden'}</Badge> : c.needs_selection ? <Badge tone="yellow">Konto wählen</Badge> : <Badge>nicht verbunden</Badge>;
}

function MetaCard({ c, reload }: { c: any; reload: () => void }) {
  const [leadAds, setLeadAds] = useState(true);
  const [busy, setBusy] = useState(false);
  const [choose, setChoose] = useState(c.needs_selection || (c.connected && !c.page));
  const start = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/ads/connect/meta/start', { lead_ads: leadAds }));
    if (r?.url) location.href = r.url;
    else setBusy(false);
  };
  return (
    <div className="card" data-tour="ads-connect-meta">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Meta Ads (Facebook & Instagram)</h2>
        <StatusLine c={c} />
      </div>
      {c.has_token ? (
        <>
          <p className="small">
            {c.account ? (
              <>
                Werbekonto: <strong>{c.account.name || c.account.id}</strong> ({c.account.currency}) · Seite: <strong>{c.page?.name ?? 'keine gewählt'}</strong>
                {c.pixel_id ? ` · Pixel ${c.pixel_id}` : ''}
              </>
            ) : (
              'Noch kein Werbekonto gewählt.'
            )}
            <span className="muted">
              {' '}
              · {c.via === 'oauth' ? `angemeldet als ${c.account_email || 'Meta-Login'}` : 'Token von Hand'}
              {expires(c.token_expires_at) ? ` · ${expires(c.token_expires_at)}` : ''}
            </span>
          </p>
          {c.last_error && <p style={{ color: 'var(--red)' }}>{c.last_error}</p>}
          {c.connected && !c.can_manage && <p style={{ color: 'var(--yellow)' }}>Der Zugang darf nur lesen. Neu verbinden und „Anzeigen verwalten“ (ads_management) erlauben, damit Kampagnen angelegt werden können.</p>}
          {c.connected && c.via === 'oauth' && !c.lead_ads && <p className="muted small">Für Lead-Anzeigen neu verbinden und „Lead-Formulare“ anhaken.</p>}
          {choose && <MetaSelect c={c} onDone={() => (setChoose(false), reload())} />}
        </>
      ) : (
        <p className="muted">
          Melde dich mit deinem Facebook-Login an – HyperLevel legt Kampagnen in deinem Werbekonto an (pausiert) und liest die Zahlen. Das Passwort sieht HyperLevel nie.
          {!c.agency.ready && <strong> Die Agentur muss zuerst die Meta-App hinterlegen (unten, „Agentur“).</strong>}
        </p>
      )}
      <Check checked={leadAds} onChange={setLeadAds} label="Auch Lead-Formulare (Lead Ads): Sofortformulare anlegen und Leads als Kontakte holen" />
      <div className="actions" style={{ marginTop: 10 }}>
        <button className="btn" disabled={busy || !c.agency.ready} onClick={start}>
          {c.has_token ? 'Neu verbinden' : 'Mit Meta verbinden'}
        </button>
        {c.has_token && !choose && (
          <button className="btn secondary" onClick={() => setChoose(true)}>
            Konto, Seite & Pixel wählen
          </button>
        )}
        {c.has_token && (
          <button className="btn ghost" onClick={async () => confirmAsk('Meta trennen? Gespeicherte Werbezahlen von Meta werden gelöscht.') && (await act(() => api.del('/api/ads/connections/meta'), 'Getrennt'), reload())}>
            Trennen
          </button>
        )}
      </div>
    </div>
  );
}

function MetaSelect({ c, onDone }: { c: any; onDone: () => void }) {
  const [acc, setAcc] = useState<string>(c.account?.id ?? '');
  const opts = useLoad(() => api.get<any>(`/api/ads/connections/meta/options${acc ? `?ad_account_id=${acc}` : ''}`), [acc]);
  const [page, setPage] = useState<string>(c.page?.id ?? '');
  const [pixel, setPixel] = useState<string>(c.pixel_id ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // One choice is taken for the person.
    if (!acc && opts.data?.ad_accounts?.length === 1) setAcc(opts.data.ad_accounts[0].id);
  }, [opts.data]);
  const save = async () => {
    setBusy(true);
    const r = await act(() => api.put('/api/ads/connections/meta/selection', { ad_account_id: acc || undefined, page_id: page, pixel_id: pixel }), 'Gespeichert');
    setBusy(false);
    if (r) onDone();
  };
  if (opts.loading && !opts.data) return <Spinner />;
  if (opts.error) return <p style={{ color: 'var(--red)' }}>{opts.error}</p>;
  const d = opts.data;
  return (
    <div className="ads-select">
      <div className="grid3">
        <Field label="Werbekonto">
          <Select value={acc} onChange={(v) => (setAcc(v), setPixel(''))} placeholder="– wählen –" options={(d?.ad_accounts ?? []).map((a: any) => [a.id, `${a.name || a.id} (${a.currency}${a.status !== 'aktiv' ? `, ${a.status}` : ''})`] as [string, string])} />
        </Field>
        <Field label="Facebook-Seite" hint="Anzeigen erscheinen im Namen dieser Seite; für Lead-Anzeigen nötig">
          <Select value={page} onChange={setPage} placeholder="– keine –" options={(d?.pages ?? []).map((p: any) => [p.id, p.name] as [string, string])} />
        </Field>
        <Field label="Pixel (optional)" hint="Für Website-Leads und Conversions">
          <Select value={pixel} onChange={setPixel} placeholder="– keins –" options={(d?.pixels ?? []).map((p: any) => [p.id, `${p.name} (${p.id})`] as [string, string])} />
        </Field>
      </div>
      <button className="btn" disabled={busy || !acc} onClick={save}>
        Auswahl speichern
      </button>
    </div>
  );
}

function GoogleCard({ c, reload }: { c: any; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [choose, setChoose] = useState(c.needs_selection);
  const start = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/ads/connect/google/start', {}));
    if (r?.url) location.href = r.url;
    else setBusy(false);
  };
  return (
    <div className="card" data-tour="ads-connect-google">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Google Ads</h2>
        <StatusLine c={c} />
      </div>
      {c.has_token ? (
        <>
          <p className="small">
            {c.account ? (
              <>
                Konto: <strong>{c.account.name || c.account.id}</strong> ({c.account.id}, {c.account.currency}){c.test_account ? ' · Testkonto' : ''}
                {c.login_customer_id ? ` · über Verwaltungskonto ${c.login_customer_id}` : ''}
              </>
            ) : (
              'Noch kein Konto gewählt.'
            )}
            <span className="muted"> · {c.via === 'oauth' ? `angemeldet als ${c.account_email}` : 'Zugangsdaten von Hand'}</span>
          </p>
          {c.last_error && <p style={{ color: 'var(--red)' }}>{c.last_error}</p>}
          {choose && <GoogleSelect c={c} onDone={() => (setChoose(false), reload())} />}
        </>
      ) : (
        <p className="muted">
          Melde dich mit dem Google-Konto an, das auf das Google-Ads-Konto zugreifen darf. HyperLevel nutzt dafür die Google-App und den Developer-Token der Agentur.
          {!c.agency.ready && (
            <strong>
              {' '}
              Dafür fehlt noch: {!c.agency.oauth_app && 'die Google-App (Agentur → Integrationen)'}
              {!c.agency.oauth_app && !c.agency.developer_token && ' und '}
              {!c.agency.developer_token && 'der Developer-Token (unten, „Agentur“)'}.
            </strong>
          )}
        </p>
      )}
      <div className="actions" style={{ marginTop: 10 }}>
        <button className="btn" disabled={busy || !c.agency.ready} onClick={start}>
          {c.has_token ? 'Neu verbinden' : 'Mit Google verbinden'}
        </button>
        {c.has_token && !choose && (
          <button className="btn secondary" onClick={() => setChoose(true)}>
            Konto wählen
          </button>
        )}
        {c.has_token && (
          <button className="btn ghost" onClick={async () => confirmAsk('Google Ads trennen? Der Zugriff wird entzogen, gespeicherte Werbezahlen von Google werden gelöscht.') && (await act(() => api.del('/api/ads/connections/google'), 'Getrennt'), reload())}>
            Trennen
          </button>
        )}
      </div>
    </div>
  );
}

function GoogleSelect({ c, onDone }: { c: any; onDone: () => void }) {
  const opts = useLoad(() => api.get<any>('/api/ads/connections/google/options'), []);
  const [cid, setCid] = useState<string>(c.account?.id ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await act(() => api.put('/api/ads/connections/google/selection', { customer_id: cid }), 'Gespeichert');
    setBusy(false);
    if (r) onDone();
  };
  if (opts.loading && !opts.data) return <Spinner />;
  if (opts.error) return <p style={{ color: 'var(--red)' }}>{opts.error}</p>;
  const list = opts.data?.customers ?? [];
  return (
    <div className="ads-select">
      <Field label="Google-Ads-Konto" hint={list.length ? undefined : 'Dieses Login hat keinen Zugriff auf ein Werbekonto (oder der Developer-Token darf nur Testkonten lesen).'}>
        <Select value={cid} onChange={setCid} placeholder="– wählen –" options={list.map((x: any) => [x.id, `${x.name} (${x.id}, ${x.currency})${x.test ? ' – Testkonto' : ''}${x.via_mcc ? ' – Verwaltungskonto' : ''}`] as [string, string])} />
      </Field>
      <button className="btn" disabled={busy || !cid} onClick={save}>
        Auswahl speichern
      </button>
    </div>
  );
}

function LimitCard({ cents, reload }: { cents: number; reload: () => void }) {
  const [v, setV] = useState(fromCents(cents));
  return (
    <div className="card" data-tour="ads-limit">
      <h2>Tageslimit</h2>
      <p className="muted small">Kein Budget darf höher sein – gilt für neue Kampagnen und Budgetänderungen, auch durch den KI-Agenten. Schützt vor Tippfehlern.</p>
      <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
        <div style={{ width: 180 }}>
          <Field label="Höchstes Tagesbudget (€)" hint={`Aktuell ${money(cents)}`}>
            <Input inputMode="decimal" value={v} onChange={setV} />
          </Field>
        </div>
        <button className="btn secondary" style={{ marginBottom: 20 }} disabled={!toCents(v) || toCents(v) === cents} onClick={async () => (await act(() => api.put('/api/ads/settings', { max_daily_budget_cents: toCents(v) }), 'Gespeichert'), reload())}>
          Speichern
        </button>
      </div>
    </div>
  );
}

function AgencyCard() {
  const { data, reload } = useLoad(() => api.get<any>('/api/ads/agency').catch(() => null), []);
  const [f, setF] = useState<Record<string, string>>({});
  if (!data) return null;
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const save = async () => {
    const meta: Record<string, string> = {};
    const google: Record<string, string> = {};
    for (const k of ['app_id', 'app_secret']) if (f[`meta.${k}`] !== undefined) meta[k] = f[`meta.${k}`];
    for (const k of ['developer_token', 'login_customer_id']) if (f[`google.${k}`] !== undefined) google[k] = f[`google.${k}`];
    const r = await act(() => api.put('/api/ads/agency', { meta, google }), 'Gespeichert');
    if (r) (setF({}), reload());
  };
  return (
    <div className="card" data-tour="ads-agency">
      <h2>Agentur: Zugänge für alle Sub-Accounts</h2>
      <p className="muted small">Einmal einrichten, dann verbindet jeder Sub-Account nur noch per Login. Geheimnisse werden verschlüsselt gespeichert und nie angezeigt.</p>
      <h3>Meta-App</h3>
      <div className="grid2">
        <Field label="App-ID" hint="developers.facebook.com → Deine App → Einstellungen → Allgemein">
          <Input value={f['meta.app_id'] ?? data.meta.app_id} onChange={(v) => set('meta.app_id', v)} />
        </Field>
        <Field label="App-Secret">
          <Input type="password" autoComplete="off" value={f['meta.app_secret'] ?? ''} onChange={(v) => set('meta.app_secret', v)} placeholder={data.meta.secret_set ? '•••••• gespeichert' : ''} />
        </Field>
      </div>
      <p className="small muted">Gültige OAuth-Weiterleitungs-URI (Facebook-Login → Einstellungen):</p>
      {data.meta.redirect_uris.map((u: string) => (
        <CodeBox key={u} text={u} />
      ))}
      <p className="small muted" style={{ marginTop: 8 }}>
        Webhook für Lead-Anzeigen (App → Webhooks → Page → <code>leadgen</code>): Callback-URL und Verifizierungs-Token
      </p>
      <CodeBox text={data.meta.webhook_url} />
      <CodeBox text={data.meta.verify_token} />
      <h3>Google Ads</h3>
      <div className="grid2">
        <Field label="Developer-Token" hint="Google Ads (Verwaltungskonto) → Tools → API-Center">
          <Input type="password" autoComplete="off" value={f['google.developer_token'] ?? ''} onChange={(v) => set('google.developer_token', v)} placeholder={data.google.developer_token_set ? '•••••• gespeichert' : ''} />
        </Field>
        <Field label="Verwaltungskonto-ID (MCC, optional)" hint="Nur wenn die Kundenkonten unter einem Verwaltungskonto liegen">
          <Input value={f['google.login_customer_id'] ?? data.google.login_customer_id} onChange={(v) => set('google.login_customer_id', v)} placeholder="123-456-7890" />
        </Field>
      </div>
      <p className="small muted">
        {data.google.oauth_app ? <Badge tone="green">Google-App vorhanden</Badge> : <Badge tone="yellow">Google-App fehlt</Badge>} Die Google-App (OAuth-Client) trägst du unter <Link to="agency/integrations">Agentur → Integrationen</Link> ein; dort muss zusätzlich diese Weiterleitungs-URI stehen und der Bereich „Google Ads API“ aktiviert sein:
      </p>
      {data.google.redirect_uris.map((u: string) => (
        <CodeBox key={u} text={u} />
      ))}
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="btn" onClick={save} disabled={!Object.keys(f).length}>
          Speichern
        </button>
        <button className="btn ghost" onClick={async () => confirmAsk('Neues Verifizierungs-Token erzeugen? Es muss dann auch bei Meta eingetragen werden.') && (await act(() => api.put('/api/ads/agency', { meta: { regenerate_verify_token: true } }), 'Neues Token'), reload())}>
          Verifizierungs-Token erneuern
        </button>
      </div>
    </div>
  );
}
