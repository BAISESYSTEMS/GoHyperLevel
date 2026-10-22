import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { Icon } from '../icons';
import { SignupLink } from '../referrals';
import { Badge, Check, Empty, Field, Input, MergeHint, Select, Spinner, Textarea, act, confirmAsk, navigate, toast, toastError, useLoad } from '../ui';

/**
 * Nango (docs/nango.md): the agency's Nango access (Agentur → Integrationen → Einrichtung), the
 * sub-account tab Apps → Nango (integrations „via Nango“, „Verbinden“ as a plain redirect, connections,
 * allow-list for AI & MCP, call log), the „via Nango“ block in the catalogue and the workflow step.
 */

type Json = Record<string, any>;
interface Integration {
  key: string;
  name: string;
  provider: string;
  logo: string;
  supported: boolean;
  connection: string | null;
}
interface AllowEntry {
  integration: string;
  methods: string[];
  path: string;
}

const STATUS: Record<string, [string, 'green' | 'yellow' | 'red' | 'gray' | 'blue']> = {
  active: ['verbunden', 'green'],
  error: ['neu verbinden', 'yellow'],
};
const clip = (s: unknown, n: number) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function Logo({ src, name, size = 32 }: { src?: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken)
    return (
      <span className="cx-logo cx-logo-fallback" style={{ width: size, height: size }} aria-hidden>
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  return <img className="cx-logo" src={src} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

/** „Verbinden“: HyperLevel starts a Nango connect session and sends the browser there – a redirect, no popup. */
async function connect(integration: string) {
  const r = await act(() => api.post<{ url: string; attempt_id: string }>('/api/nango/connect', { integration }));
  if (r?.url) location.href = r.url;
}

// --- agency -----------------------------------------------------------------------------------------------

export function NangoAgencySetup() {
  const s = useLoad(() => api.get<Json>('/api/agency/nango'), []);
  const [f, setF] = useState<Json | null>(null);
  const [test, setTest] = useState<Json | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (s.data && !f) setF({ base_url: s.data.base_url || 'https://api.nango.dev', secret_key: '', webhook_key: '', connect_url: s.data.connect_url ?? '', allow_private: !!s.data.allow_private });
  }, [s.data, f]);
  if (!s.data || !f) return <Spinner />;
  const v = s.data;
  const set = (p: Json) => setF({ ...f, ...p });
  const cloud = f.base_url === 'https://api.nango.dev';
  return (
    <div className="card" style={{ flex: '1 1 340px' }} data-tour="nango-agency">
      <h2>
        Nango (eigene OAuth-Apps) <SignupLink id="nango" />
      </h2>
      <p className="muted small">
        Hunderte APIs über <a href="https://nango.dev" target="_blank" rel="noopener">Nango</a> – Cloud oder selbst gehostet. Du legst je Anbieter einmal eine eigene OAuth-App im Nango-Dashboard an; danach klicken Sub-Accounts nur noch „Verbinden“. Nango steht unter der Elastic License 2.0 (quelloffen, nicht OSI); die kostenlose selbst gehostete Version kann Anmeldung + Proxy – genau das, was HyperLevel nutzt.
      </p>
      <Field label="Nango-Adresse" hint="Nango Cloud: https://api.nango.dev · selbst gehostet: die Server-Adresse (z. B. https://nango.example.com oder http://nango-server:3003 im selben Docker-Netz).">
        <Select value={cloud ? 'cloud' : 'self'} onChange={(x) => set({ base_url: x === 'cloud' ? 'https://api.nango.dev' : '' })} options={[['cloud', 'Nango Cloud'], ['self', 'Selbst gehostet']]} />
        {!cloud && <Input value={f.base_url} onChange={(x) => set({ base_url: x })} placeholder="https://nango.example.com" />}
      </Field>
      <Field label="Secret-Key" hint="Nango → Environment Settings → Secret Key (je Umgebung, z. B. prod). Wird verschlüsselt gespeichert und nie wieder angezeigt.">
        <Input type="password" value={f.secret_key} onChange={(x) => set({ secret_key: x })} autoComplete="off" placeholder={v.configured ? `•••••••• ${v.key_hint}${v.source === 'env' ? ' (aus der Umgebung)' : ''}` : ''} />
      </Field>
      <button type="button" className="btn small ghost" onClick={() => setMore(!more)}>
        {more ? '▾' : '▸'} Webhooks, Connect-UI, internes Netz
      </button>
      {more && (
        <>
          <Field label="Webhook-Signaturschlüssel (optional)" hint={<>Nango Cloud/Enterprise: Environment Settings → Webhooks → Signing key. Webhook-URL in Nango: <code>{v.webhook_url}</code>. Ohne Webhooks (kostenlose selbst gehostete Version) gleicht HyperLevel beim Zurückkommen ab.</>}>
            <Input type="password" value={f.webhook_key} onChange={(x) => set({ webhook_key: x })} autoComplete="off" placeholder={v.webhook_key_set ? '•••••••• gespeichert' : ''} />
          </Field>
          <Field label="Connect-UI-Adresse (optional)" hint="Nur nötig, wenn deine Nango-Version keinen connect_link liefert (selbst gehostet: NANGO_PUBLIC_CONNECT_URL, z. B. https://connect.nango.example.com).">
            <Input value={f.connect_url} onChange={(x) => set({ connect_url: x })} placeholder="https://connect.nango.dev" />
          </Field>
          <Check checked={f.allow_private} onChange={(x) => set({ allow_private: x })} label="Internes Netz erlauben (Nango läuft im selben Docker-Netz oder LAN)" />
        </>
      )}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button
          className="btn"
          disabled={!f.base_url || (!v.configured && !f.secret_key)}
          onClick={async () => {
            const body: Json = { base_url: f.base_url, connect_url: f.connect_url, allow_private: f.allow_private };
            if (f.secret_key) body.secret_key = f.secret_key;
            if (f.webhook_key) body.webhook_key = f.webhook_key;
            if (await act(() => api.put('/api/agency/nango', body), 'Gespeichert')) (set({ secret_key: '', webhook_key: '' }), s.reload());
          }}
        >
          Speichern
        </button>
        {v.configured && (
          <button className="btn secondary" onClick={async () => setTest((await act(() => api.post('/api/agency/nango/test'))) ?? null)}>
            Verbindung testen
          </button>
        )}
        {v.configured && v.source !== 'env' && (
          <button className="btn ghost" onClick={async () => confirmAsk('Nango-Zugang der Agentur entfernen? Verbundene Apps der Sub-Accounts funktionieren dann nicht mehr.') && (await act(() => api.del('/api/agency/nango'), 'Entfernt')) && (setF(null), s.reload())}>
            Entfernen
          </button>
        )}
      </div>
      {test && (
        <p className="small">
          <Badge tone="green">verbunden</Badge> {test.integrations} Integration{test.integrations === 1 ? '' : 'en'} in Nango{test.names?.length ? `: ${test.names.join(', ')}` : ' – leg im Nango-Dashboard die erste an'}
        </p>
      )}
      <p className="muted small">
        {v.connections} Verbindungen in {v.locations} Sub-Accounts. Wer was einrichtet (Agentur einmal je Anbieter, Nutzer nur „Verbinden“): <code>docs/nango.md</code>
      </p>
    </div>
  );
}

// --- sub-account: Apps → Nango ------------------------------------------------------------------------------

/** Pending connections: after returning from Nango (or when the tab becomes visible again) HyperLevel asks Nango once. */
function usePendingSync(pending: Json[] | undefined, onDone: () => void) {
  useEffect(() => {
    if (!pending?.length) return;
    let stop = false;
    const check = async () => {
      for (const p of pending) {
        try {
          const r = await api.get<Json>(`/api/nango/attempts/${p.id}`);
          if (stop) return;
          if (r.status === 'done') {
            toast(`${p.integration} verbunden`);
            onDone();
            return;
          }
          if (r.status === 'failed') {
            toastError(`${p.integration}: Verbinden fehlgeschlagen`);
            onDone();
            return;
          }
        } catch {
          /* next time */
        }
      }
    };
    void check();
    const onVis = () => document.visibilityState === 'visible' && void check();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      stop = true;
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(pending?.map((p) => p.id))]);
}

export function NangoApps() {
  const st = useLoad(() => api.get<Json>('/api/nango'), []);
  const list = useLoad(() => (st.data?.configured ? api.get<Integration[]>('/api/nango/integrations') : Promise.resolve([] as Integration[])), [st.data?.configured]);
  const [q, setQ] = useState('');
  const reload = () => (st.reload(), list.reload());
  usePendingSync(st.data?.pending, reload);
  if (st.error) return <Empty>{st.error}</Empty>;
  if (!st.data) return <Spinner />;
  const v = st.data;
  const items = (list.data ?? []).filter((i) => !q.trim() || `${i.name} ${i.key} ${i.provider}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="cx">
      <div className="card" data-tour="apps-nango-status">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Nango</h2>
          {v.configured ? <Badge tone="green">eingerichtet</Badge> : <Badge>nicht eingerichtet</Badge>}
        </div>
        <p className="muted small">
          Apps mit Anmeldung über Nango – mit den eigenen OAuth-Apps der Agentur. Dieser Sub-Account ist bei Nango der Nutzer <code>{v.end_user_id}</code>; seine Verbindungen sind von anderen Sub-Accounts getrennt. „Verbinden“ führt direkt zur Anmeldung der App (kein Popup) – danach mit „Zurück“ oder durch Schließen des Tabs wieder hierher, die Verbindung erscheint automatisch.
        </p>
        {!v.configured && <p className="small">{v.is_admin ? 'Trag Nango einmal unter Agentur → Integrationen → Einrichtung ein.' : 'Die Agentur hat Nango noch nicht eingerichtet.'}</p>}
        {v.pending?.length > 0 && (
          <p className="small">
            <Badge tone="blue">wartet</Badge> Anmeldung läuft: {v.pending.map((p: Json) => p.integration).join(', ')} –{' '}
            <button className="btn small ghost" onClick={async () => (await act(() => api.get('/api/nango/connections?refresh=1'))) && reload()}>
              Status prüfen
            </button>
          </p>
        )}
      </div>
      {v.configured && <NangoConnections conns={v.connections} onChange={reload} />}
      {v.configured && (
        <div className="card" data-tour="apps-nango-integrations">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>Integrationen in Nango</h2>
            <div style={{ width: 240 }}>
              <Input value={q} onChange={setQ} placeholder="Suchen …" />
            </div>
          </div>
          {list.error ? (
            <p className="muted small">{list.error}</p>
          ) : !list.data ? (
            <Spinner />
          ) : items.length ? (
            <div className="cx-grid">
              {items.map((i) => (
                <NangoCard key={i.key} i={i} />
              ))}
            </div>
          ) : (
            <p className="muted">{list.data.length ? 'Nichts gefunden.' : 'In Nango ist noch keine Integration angelegt – das macht die Agentur einmal im Nango-Dashboard (eigene OAuth-App je Anbieter).'}</p>
          )}
        </div>
      )}
      {v.configured && v.connections.length > 0 && <NangoAllow allow={v.allow} conns={v.connections} onChange={reload} />}
      {v.configured && <NangoCalls />}
    </div>
  );
}

function NangoCard({ i }: { i: Integration }) {
  const st = i.connection ? STATUS[i.connection] : null;
  return (
    <div className="card cx-tk">
      <div className="cx-tk-head">
        <Logo src={i.logo} name={i.name} />
        <div className="cx-tk-title">
          <strong>{i.name}</strong>
          <span className="muted small">
            <Badge tone="purple">via Nango</Badge> {i.provider}
          </span>
        </div>
      </div>
      <div className="cx-tk-foot">
        <code className="small">{i.key}</code>
        {!i.supported ? (
          <span className="muted small" title="HyperLevel unterstützt Integrations-IDs mit Buchstaben, Ziffern und . _ - ~ @">ID nicht unterstützt</span>
        ) : st && i.connection === 'active' ? (
          <Badge tone={st[1]}>{st[0]}</Badge>
        ) : (
          <button className="btn small" onClick={() => void connect(i.key)}>
            {i.connection ? 'Neu verbinden' : 'Verbinden'}
          </button>
        )}
      </div>
    </div>
  );
}

function NangoConnections({ conns, onChange }: { conns: Json[]; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card" data-tour="apps-nango-connected">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Verbunden über Nango</h2>
        <button
          className="btn small secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            if (await act(() => api.get('/api/nango/connections?refresh=1'), 'Status aktualisiert')) onChange();
            setBusy(false);
          }}
        >
          <Icon name="refresh" size={13} /> Aktualisieren
        </button>
      </div>
      {conns.length ? (
        <div className="cx-conns">
          {conns.map((c) => {
            const s = STATUS[c.status] ?? [c.status, 'gray'];
            return (
              <div key={c.id} className="cx-conn">
                <Logo name={c.integration} size={28} />
                <div className="cx-conn-main">
                  <strong>{c.integration}</strong>
                  <span className="muted small">
                    {c.provider} · seit {dt(c.created_at)}
                    {c.status_reason ? ` · ${clip(c.status_reason, 80)}` : ''}
                  </span>
                </div>
                <Badge tone={s[1]}>{s[0]}</Badge>
                {c.status !== 'active' && (
                  <button className="btn small" onClick={() => void connect(c.integration)}>
                    Neu verbinden
                  </button>
                )}
                <button className="btn small ghost" onClick={async () => confirmAsk(`${c.integration} trennen? Die Verbindung wird auch in Nango gelöscht; Workflows damit schlagen dann fehl.`) && (await act(() => api.del(`/api/nango/connections/${c.id}`), 'Getrennt')) && onChange()}>
                  Trennen
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted">Noch nichts verbunden – unten eine Integration wählen und „Verbinden“.</p>
      )}
    </div>
  );
}

/** Allow-list for AI and MCP callers: per connected integration all calls, only reads (GET), optionally a path pattern. */
function NangoAllow({ allow, conns, onChange }: { allow: AllowEntry[]; conns: Json[]; onChange: () => void }) {
  const keys = [...new Set(conns.filter((c) => c.status === 'active').map((c) => String(c.integration)))];
  const [list, setList] = useState<AllowEntry[]>(allow);
  const entry = (k: string) => list.find((a) => a.integration === k);
  const put = (k: string, e: AllowEntry | null) => setList([...list.filter((a) => a.integration !== k), ...(e ? [e] : [])]);
  return (
    <div className="card" data-tour="apps-nango-allow">
      <h2>Freigaben für KI & MCP</h2>
      <p className="muted small">
        Der KI-Agent und MCP-Clients (Claude, Codex … über <code>ghl_nango_request</code>) dürfen nur, was hier steht. Workflows brauchen keine Freigabe. „Nur lesen“ erlaubt ausschließlich GET-Aufrufe – der Agent führt sie dann ohne Rückfrage aus.
      </p>
      {keys.length ? (
        <table className="t">
          <tbody>
            {keys.map((k) => {
              const e = entry(k);
              return (
                <tr key={k}>
                  <td style={{ width: 200 }}>
                    <Check checked={!!e} onChange={(on) => put(k, on ? { integration: k, methods: ['GET'], path: '' } : null)} label={<strong>{k}</strong>} />
                  </td>
                  <td style={{ width: 200 }}>{e && <Select value={e.methods.includes('*') ? '*' : 'GET'} onChange={(m) => put(k, { ...e, methods: [m] })} options={[['GET', 'Nur lesen (GET)'], ['*', 'Alles (auch schreiben)']]} />}</td>
                  <td>{e && <Input value={e.path} onChange={(p) => put(k, { ...e, path: p })} placeholder="alle Pfade – oder z. B. /repos/*" />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="muted">Erst eine Integration verbinden.</p>
      )}
      <button className="btn small" onClick={async () => (await act(() => api.put('/api/nango/allow', { allow: list }), 'Gespeichert')) && onChange()}>
        Freigaben speichern
      </button>
    </div>
  );
}

function NangoCalls() {
  const calls = useLoad(() => api.get<Json[]>('/api/nango/calls'), []);
  return (
    <div className="card" data-tour="apps-nango-calls">
      <h2>Letzte Aufrufe</h2>
      {!calls.data ? (
        <Spinner />
      ) : calls.data.length ? (
        <table className="t">
          <tbody>
            {calls.data.slice(0, 25).map((c) => (
              <tr key={c.id}>
                <td className="muted small">{dt(c.created_at)}</td>
                <td>
                  <code className="small">
                    {c.integration} {c.method} {clip(c.path, 60)}
                  </code>
                </td>
                <td>{c.ok ? <Badge tone="green">{c.status}</Badge> : <Badge tone="red">{c.status || 'Fehler'}</Badge>}</td>
                <td className="muted small">
                  {c.source} · {c.ms} ms{c.error ? ` · ${clip(c.error, 80)}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">Noch keine Aufrufe.</p>
      )}
    </div>
  );
}

/** Catalogue tab: integrations configured in Nango, labelled „via Nango“. */
export function NangoSuggestions({ q }: { q: string }) {
  const st = useLoad(() => api.get<Json>('/api/nango').catch(() => null), []);
  const list = useLoad(() => (st.data?.configured ? api.get<Integration[]>('/api/nango/integrations').catch(() => [] as Integration[]) : Promise.resolve([] as Integration[])), [st.data?.configured]);
  if (!st.data?.configured || !list.data?.length) return null;
  const term = q.trim().toLowerCase();
  const items = list.data.filter((i) => term.length < 2 || `${i.name} ${i.key} ${i.provider}`.toLowerCase().includes(term)).slice(0, 12);
  if (!items.length) return null;
  return (
    <div className="cx-suggest" data-tour="apps-nango-suggest">
      <h3 className="integ-h">
        <Icon name="link" size={14} /> {term.length >= 2 ? `„${q.trim()}“ via Nango` : 'Weitere Apps via Nango (eigene OAuth-Apps der Agentur)'}
      </h3>
      <div className="cx-grid">
        {items.map((i) => (
          <NangoCard key={i.key} i={i} />
        ))}
      </div>
      <p className="small">
        <a href="/app/apps/nango" onClick={(e) => (e.preventDefault(), navigate('apps/nango'))}>
          Alle Nango-Integrationen →
        </a>
      </p>
    </div>
  );
}

// --- workflow step ----------------------------------------------------------------------------------------------

const CONTACT_TARGETS: [string, string][] = [
  ['email', 'E-Mail'],
  ['phone', 'Telefon'],
  ['first_name', 'Vorname'],
  ['last_name', 'Nachname'],
  ['company', 'Firma'],
  ['address', 'Adresse'],
  ['city', 'Ort'],
  ['postal_code', 'PLZ'],
  ['country', 'Land'],
  ['website', 'Website'],
];

/** Step „API-Aufruf über Nango“: integration, method, path, query/body with merge fields, result mapping. */
export function NangoRequestStep({ step, set, customFields }: { step: Json; set: (p: Json) => void; customFields: Json[] }) {
  const conns = useLoad(() => api.get<Json[]>('/api/nango/connections').catch(() => [] as Json[]), []);
  const map: { from: string; to: string }[] = step.map ?? [];
  const targets: [string, string][] = [...CONTACT_TARGETS, ...customFields.map((f) => [`custom.${f.key}`, `Feld: ${f.label}`] as [string, string])];
  if (!conns.data) return <Spinner />;
  const keys = [...new Set(conns.data.map((c) => String(c.integration)))];
  if (!keys.length && !step.integration)
    return (
      <p className="muted">
        Noch nichts über Nango verbunden.{' '}
        <a href="/app/apps/nango" onClick={(e) => (e.preventDefault(), navigate('apps/nango'))}>
          Apps → Nango
        </a>
      </p>
    );
  const method = step.method || 'GET';
  return (
    <div data-tour="nango-step">
      <div className="row">
        <div className="grow">
          <Field label="Integration">
            <Select value={step.integration} onChange={(v) => set({ integration: v })} placeholder="wählen…" options={keys} />
          </Field>
        </div>
        <div style={{ width: 130 }}>
          <Field label="Methode">
            <Select value={method} onChange={(v) => set({ method: v })} options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE']} />
          </Field>
        </div>
      </div>
      <Field label="Pfad der API" hint="Beginnt mit /, z. B. /user, /crm/v3/objects/contacts oder /repos/{{event.repo}}/issues – Nango ergänzt die Basis-Adresse und die Anmeldung.">
        <Input value={step.path} onChange={(v) => set({ path: v })} placeholder="/user" />
      </Field>
      <Field label="Query (optional)" hint="a=1&b={{contact.email}} oder JSON-Objekt">
        <Input value={typeof step.query === 'string' ? step.query : step.query ? JSON.stringify(step.query) : ''} onChange={(v) => set({ query: v })} placeholder="per_page=10" />
      </Field>
      {method !== 'GET' && method !== 'DELETE' && (
        <Field label="Body (JSON)" hint="Platzhalter in Texten: {{contact.first_name}} …">
          <Textarea value={step.body} onChange={(v) => set({ body: v })} rows={5} placeholder={'{\n  "title": "Neuer Lead: {{contact.name}}"\n}'} />
        </Field>
      )}
      <MergeHint />
      <h4 className="integ-h">Ergebnis übernehmen (optional)</h4>
      <p className="muted small">
        Pfad in der Antwort → Kontaktfeld, z. B. <code>id</code> oder <code>items.0.name</code>. Spätere Schritte lesen die Antwort als <code>{'{{event.nango_result.data.<pfad>}}'}</code>.
      </p>
      {map.map((m, i) => (
        <div key={i} className="row" style={{ marginBottom: 6 }}>
          <div className="grow">
            <Input value={m.from} onChange={(v) => set({ map: map.map((x, j) => (j === i ? { ...x, from: v } : x)) })} placeholder="z. B. id" />
          </div>
          <div className="grow">
            <Select value={m.to} onChange={(v) => set({ map: map.map((x, j) => (j === i ? { ...x, to: v } : x)) })} placeholder="Kontaktfeld" options={targets} />
          </div>
          <button className="icon-btn" aria-label="Entfernen" onClick={() => set({ map: map.filter((_, j) => j !== i) })}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn small secondary" onClick={() => set({ map: [...map, { from: '', to: '' }] })}>
        + Zuordnung
      </button>
      <Check checked={step.fail_on_error !== false} onChange={(v) => set({ fail_on_error: v })} label="HTTP-Fehler der API (4xx/5xx) als Fehler werten" />
    </div>
  );
}
