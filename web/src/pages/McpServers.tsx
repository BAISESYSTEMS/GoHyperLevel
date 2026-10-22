import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { Icon } from '../icons';
import { SignupLink } from '../referrals';
import { Badge, Check, CodeBox, Empty, Field, Input, Modal, Select, Spinner, act, confirmAsk, navigate, toast, toastError, useLoad } from '../ui';
import { SchemaForm } from './Composio';

/**
 * External MCP servers (docs/mcp-client.md): Agentur → MCP-Server (for every or selected sub-accounts)
 * and Apps → MCP-Server (own servers + the agency's shared ones). Presets with docs links, add/edit,
 * „Verbinden“ (OAuth – a redirect, no popup), test (initialize + tools/list), tool checklist, switches
 * for the AI agent and the /mcp re-exposure, a try-out box, the call log, and the workflow step.
 */

type Json = Record<string, any>;

const AUTH: Record<string, [string, 'green' | 'blue' | 'purple' | 'gray']> = {
  none: ['ohne Anmeldung', 'gray'],
  bearer: ['Token', 'blue'],
  oauth: ['OAuth', 'purple'],
};
const clip = (s: unknown, n: number) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** After the OAuth redirect back (?mcp=ok|error&server=…): toast once, clean the address, open the server. */
function useMcpReturn(open: (id: string) => void) {
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const st = q.get('mcp');
    if (!st) return;
    if (st === 'ok') toast('MCP-Server verbunden');
    else toastError(q.get('msg') || 'Verbinden fehlgeschlagen');
    history.replaceState(null, '', location.pathname);
    const sid = q.get('server');
    if (sid) open(sid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function McpServers({ agency = false }: { agency?: boolean }) {
  const base = agency ? '/api/agency/mcp-servers' : '/api/mcp-servers';
  const list = useLoad(() => api.get<Json>(base), [base]);
  const presets = useLoad(() => api.get<{ presets: Json[]; callback_url: string }>('/api/mcp-presets'), []);
  const [form, setForm] = useState<Json | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  useMcpReturn((id) => setOpenId(id));
  if (list.error) return <Empty>{list.error}</Empty>;
  if (!list.data || !presets.data) return <Spinner />;
  const servers: Json[] = list.data.servers;
  const canInternal = agency || !!list.data.can_internal;
  return (
    <div className="cx" data-tour="mcp-servers">
      <div className="card" data-tour="mcp-servers-list">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>MCP-Server</h2>
          <button className="btn small" data-tour="mcp-add" onClick={() => setForm({ name: '', url: '', auth: 'none', transport: 'auto', expose_agent: true, expose_mcp: false, token_scope: 'server', share: ['*'] })}>
            + Eigener Server
          </button>
        </div>
        <p className="muted small">
          {agency
            ? 'Externe MCP-Server für alle oder ausgewählte Sub-Accounts: HyperLevel liest ihre Werkzeuge, du gibst einzelne frei – nutzbar in Workflows („MCP-Werkzeug ausführen“), im KI-Agenten und optional über HyperLevels eigenes /mcp für Claude & Codex.'
            : 'Werkzeuge aus anderen MCP-Servern für diesen Sub-Account – eigene und die von der Agentur freigegebenen. Nur freigegebene Werkzeuge laufen; HyperLevel ruft sie serverseitig auf und behandelt Antworten als Daten.'}
        </p>
        {servers.length ? (
          <div className="cx-conns">
            {servers.map((s) => (
              <div key={s.id} className="cx-conn">
                <span className="cx-logo cx-logo-fallback" style={{ width: 28, height: 28 }} aria-hidden>
                  <Icon name="bot" size={15} />
                </span>
                <div className="cx-conn-main">
                  <strong>
                    {s.name} {s.scope === 'agency' && !agency && <Badge tone="purple">Agentur</Badge>}
                  </strong>
                  <span className="muted small">
                    {s.url_hint} · {s.enabled_count}/{s.tools_count} Werkzeuge frei{s.expose_mcp ? ' · über /mcp' : ''}
                  </span>
                </div>
                <Badge tone={AUTH[s.auth]?.[1] ?? 'gray'}>{AUTH[s.auth]?.[0] ?? s.auth}</Badge>
                {s.connection.needed && !s.connection.connected ? <Badge tone="yellow">nicht verbunden</Badge> : s.status === 'error' ? <Badge tone="red">Fehler</Badge> : s.changed.length ? <Badge tone="yellow">geändert</Badge> : s.status === 'ok' ? <Badge tone="green">OK</Badge> : <Badge>neu</Badge>}
                <button className="btn small secondary" onClick={() => setOpenId(s.id)}>
                  Öffnen
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Noch kein MCP-Server – unten eine Vorlage wählen oder einen eigenen hinzufügen.</p>
        )}
      </div>
      <div className="card" data-tour="mcp-presets">
        <h2>Vorlagen</h2>
        <p className="muted small">
          Bekannte MCP-Server mit Link zur Anleitung. <Badge tone="purple">OAuth</Badge> = „Verbinden“ mit Anmeldung beim Anbieter (meist mit automatischer Registrierung), <Badge tone="blue">Token</Badge> = Schlüssel des Anbieters eintragen.
        </p>
        <div className="cx-grid">
          {presets.data.presets.map((p) => (
            <div key={p.id} className="card cx-tk mcp-preset">
              <div className="cx-tk-title">
                <strong>{p.name}</strong>
                <span className="small">
                  <Badge tone={AUTH[p.auth][1]}>{AUTH[p.auth][0]}</Badge> {p.alt_auth && <span className="muted">oder {AUTH[p.alt_auth][0]}</span>} {p.license && <Badge>{p.license}</Badge>}
                </span>
              </div>
              <p className="cx-tk-desc small">{clip(p.note, 170)}</p>
              <div className="cx-tk-foot">
                <span className="small">
                  <a href={p.docs} target="_blank" rel="noopener noreferrer">
                    Anleitung ↗
                  </a>{' '}
                  {p.signup && <SignupLink id={p.signup} />}
                </span>
                <button className="btn small" onClick={() => setForm({ name: p.name.replace(/ \(.*\)$/, ''), url: p.url, auth: p.auth, transport: p.transport, header_name: p.header_name ?? 'Authorization', preset: p.id, token_hint: p.token_hint, expose_agent: true, expose_mcp: false, token_scope: 'server', share: ['*'], allow_private: false, self_hosted: p.self_hosted })}>
                  Hinzufügen
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {form && (
        <ServerForm
          agency={agency}
          base={base}
          initial={form}
          canInternal={canInternal}
          locations={list.data.locations ?? []}
          callbackUrl={presets.data.callback_url}
          onClose={() => setForm(null)}
          onSaved={(s) => {
            setForm(null);
            list.reload();
            setOpenId(s.id);
          }}
        />
      )}
      {openId && (
        <ServerDetail
          agency={agency}
          base={base}
          id={openId}
          onClose={() => (setOpenId(null), list.reload())}
          onEdit={(s) => (setOpenId(null), setForm({ ...s, secret: '', oauth_client_id: s.oauth.client?.manual ? s.oauth.client.client_id : '', oauth_scope: s.oauth.scope }))}
        />
      )}
    </div>
  );
}

function ServerForm({ agency, base, initial, canInternal, locations, callbackUrl, onClose, onSaved }: { agency: boolean; base: string; initial: Json; canInternal: boolean; locations: Json[]; callbackUrl: string; onClose: () => void; onSaved: (s: Json) => void }) {
  const [f, setF] = useState<Json>({ secret: '', oauth_client_secret: '', ...initial });
  const set = (p: Json) => setF({ ...f, ...p });
  const editing = !!f.id;
  const save = async () => {
    const body: Json = { name: f.name, url: f.url_new ?? f.url, transport: f.transport, auth: f.auth, expose_agent: !!f.expose_agent, expose_mcp: !!f.expose_mcp, preset: f.preset ?? '' };
    if (editing && !f.url_new) delete body.url;
    if (f.auth === 'bearer') {
      body.header_name = f.header_name || 'Authorization';
      if (f.secret) body.secret = f.secret;
    }
    if (f.auth === 'oauth') {
      body.token_scope = f.token_scope || 'server';
      body.oauth_scope = f.oauth_scope ?? '';
      if (f.oauth_client_id !== undefined) body.oauth_client_id = f.oauth_client_id ?? '';
      if (f.oauth_client_secret) body.oauth_client_secret = f.oauth_client_secret;
    }
    if (canInternal) body.allow_private = !!f.allow_private;
    if (agency) body.share = f.share?.includes('*') ? '*' : (f.share ?? []);
    const r = await act(() => (editing ? api.patch<Json>(`${base}/${f.id}`, body) : api.post<Json>(base, body)), 'Gespeichert');
    if (r) onSaved(r);
  };
  const scopes: [string, string][] = agency
    ? [
        ['server', 'Ein Zugang für alle (die Agentur verbindet)'],
        ['location', 'Je Sub-Account (jeder Sub-Account verbindet selbst)'],
        ['user', 'Je Nutzer (nicht in Workflows)'],
      ]
    : [
        ['server', 'Ein Zugang für diesen Sub-Account'],
        ['user', 'Je Nutzer (nicht in Workflows)'],
      ];
  return (
    <Modal
      title={editing ? `${f.name} bearbeiten` : 'MCP-Server hinzufügen'}
      onClose={onClose}
      wide
      footer={
        <button className="btn" disabled={!f.name || !(f.url_new ?? f.url)} onClick={save}>
          Speichern
        </button>
      }
    >
      <div data-tour="mcp-form">
        <Field label="Name">
          <Input value={f.name} onChange={(v) => set({ name: v })} placeholder="z. B. Notion" />
        </Field>
        <Field label="Server-Adresse" hint={editing ? `Gespeichert: ${f.url_hint} – nur ausfüllen, um sie zu ändern (Verbindungen und Freigaben starten dann neu).` : 'Streamable HTTP (…/mcp) oder älteres SSE (…/sse). Platzhalter wie <zone> ersetzen. Die Adresse wird verschlüsselt gespeichert.'}>
          <Input value={editing ? (f.url_new ?? '') : f.url} onChange={(v) => set(editing ? { url_new: v } : { url: v })} placeholder="https://mcp.example.com/mcp" />
        </Field>
        <div className="row">
          <div className="grow">
            <Field label="Anmeldung">
              <Select value={f.auth} onChange={(v) => set({ auth: v })} options={[['none', 'Ohne Anmeldung'], ['bearer', 'Token / API-Schlüssel'], ['oauth', 'OAuth 2.1 („Verbinden“)']]} />
            </Field>
          </div>
          <div className="grow">
            <Field label="Transport">
              <Select value={f.transport} onChange={(v) => set({ transport: v })} options={[['auto', 'Automatisch (HTTP, sonst SSE)'], ['http', 'Streamable HTTP'], ['sse', 'SSE (alt)']]} />
            </Field>
          </div>
        </div>
        {f.auth === 'bearer' && (
          <div className="row">
            <div style={{ width: 200 }}>
              <Field label="Header">
                <Input value={f.header_name ?? 'Authorization'} onChange={(v) => set({ header_name: v })} />
              </Field>
            </div>
            <div className="grow">
              <Field label="Token" hint={f.token_hint || 'Bei „Authorization“ setzt HyperLevel „Bearer “ davor. Verschlüsselt gespeichert, nie wieder angezeigt.'}>
                <Input type="password" value={f.secret} onChange={(v) => set({ secret: v })} autoComplete="off" placeholder={f.secret_set ? `gespeichert ${f.secret_hint}` : ''} />
              </Field>
            </div>
          </div>
        )}
        {f.auth === 'oauth' && (
          <>
            <Field label="Zugang gilt für">
              <Select value={f.token_scope ?? 'server'} onChange={(v) => set({ token_scope: v })} options={scopes} />
            </Field>
            <Field label="Scopes (optional)" hint="Leer = was der Server vorschlägt.">
              <Input value={f.oauth_scope ?? ''} onChange={(v) => set({ oauth_scope: v })} placeholder="z. B. read write" />
            </Field>
            <p className="muted small">Die meisten Server registrieren HyperLevel automatisch (Dynamic Client Registration). Sonst eine eigene OAuth-App beim Anbieter anlegen – Rückleitungs-Adresse:</p>
            <CodeBox text={callbackUrl} />
            <div className="row">
              <div className="grow">
                <Field label="Client-ID (nur ohne automatische Registrierung)">
                  <Input value={f.oauth_client_id ?? ''} onChange={(v) => set({ oauth_client_id: v })} />
                </Field>
              </div>
              <div className="grow">
                <Field label="Client-Secret">
                  <Input type="password" value={f.oauth_client_secret} onChange={(v) => set({ oauth_client_secret: v })} autoComplete="off" placeholder={f.oauth?.client?.secret_set ? 'gespeichert' : ''} />
                </Field>
              </div>
            </div>
          </>
        )}
        {agency && (
          <Field label="Für welche Sub-Accounts">
            <Check checked={!!f.share?.includes('*')} onChange={(v) => set({ share: v ? ['*'] : [] })} label="Alle Sub-Accounts" />
            {!f.share?.includes('*') && (
              <div className="grid2">
                {locations.map((l) => (
                  <Check key={l.id} checked={!!f.share?.includes(l.id)} onChange={(on) => set({ share: on ? [...(f.share ?? []), l.id] : (f.share ?? []).filter((x: string) => x !== l.id) })} label={l.name} />
                ))}
              </div>
            )}
          </Field>
        )}
        <Check checked={!!f.expose_agent} onChange={(v) => set({ expose_agent: v })} label="Freigegebene Werkzeuge im KI-Agenten anbieten" />
        <Check checked={!!f.expose_mcp} onChange={(v) => set({ expose_mcp: v })} label="Über HyperLevels /mcp an Claude, Codex & Co. weitergeben (als ext_…)" />
        {canInternal && <Check checked={!!f.allow_private} onChange={(v) => set({ allow_private: v })} label={`Internes Netz erlauben (Server im LAN/Docker-Netz${f.self_hosted ? ' – bei selbst gehosteten Servern üblich' : ''}) – nur die Agentur`} />}
      </div>
    </Modal>
  );
}

function ServerDetail({ agency, base, id, onClose, onEdit }: { agency: boolean; base: string; id: string; onClose: () => void; onEdit: (s: Json) => void }) {
  const s = useLoad(() => api.get<Json>(`${base}/${id}`), [id]);
  const [enabled, setEnabled] = useState<string[] | null>(null);
  const [busy, setBusy] = useState('');
  const [test, setTest] = useState<Json | null>(null);
  useEffect(() => {
    if (s.data) setEnabled(s.data.tools.filter((t: Json) => t.enabled).map((t: Json) => t.name));
  }, [s.data]);
  if (s.error)
    return (
      <Modal title="MCP-Server" onClose={onClose}>
        <Empty>{s.error}</Empty>
      </Modal>
    );
  if (!s.data || !enabled) return null;
  const v = s.data;
  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label);
    const r = await act(fn, ok);
    setBusy('');
    return r;
  };
  const conn = v.connection;
  // Who connects here: the agency for "one access for all"; in a sub-account its own servers and shared ones per sub-account/user.
  const ownOAuth = v.auth === 'oauth' && (agency ? v.token_scope === 'server' : v.editable || v.token_scope !== 'server');
  return (
    <Modal title={v.name} onClose={onClose} wide>
      <div data-tour="mcp-detail">
        <p className="small">
          <code>{v.url_hint}</code> · <Badge tone={AUTH[v.auth]?.[1] ?? 'gray'}>{AUTH[v.auth]?.[0]}</Badge> {v.scope === 'agency' && <Badge tone="purple">Agentur-Server</Badge>} {v.allow_private && <Badge tone="yellow">internes Netz</Badge>}
          {v.server_info?.name ? ` · ${v.server_info.name} ${v.server_info.version ?? ''} (${v.server_info.transport ?? ''}${v.server_info.protocol ? `, ${v.server_info.protocol}` : ''})` : ''}
        </p>
        {v.last_error && <p className="small" style={{ color: 'var(--red)' }}>{v.last_error}</p>}
        {v.auth === 'oauth' && (
          <p className="small">
            {conn.connected ? <Badge tone="green">verbunden</Badge> : <Badge tone="yellow">nicht verbunden</Badge>}{' '}
            {conn.per === 'location' ? 'Jeder Sub-Account verbindet selbst.' : conn.per === 'user' ? 'Jeder Nutzer verbindet sein eigenes Konto (nicht in Workflows).' : 'Ein Zugang für alle.'}
            {conn.expires_at ? ` Token bis ${dt(conn.expires_at)} (wird automatisch erneuert).` : ''}
          </p>
        )}
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {ownOAuth && (
            <button
              className="btn small"
              data-tour="mcp-connect"
              disabled={!!busy}
              onClick={async () => {
                const r = (await run('connect', () => api.post<Json>(`${base}/${id}/oauth/start`))) as Json | undefined;
                if (r?.url) location.href = r.url;
              }}
            >
              {conn.connected ? 'Neu verbinden' : 'Verbinden'}
            </button>
          )}
          {ownOAuth && conn.connected && (
            <button className="btn small ghost" onClick={async () => (await run('disc', () => api.del(`${base}/${id}/oauth`), 'Getrennt')) && s.reload()}>
              Trennen
            </button>
          )}
          <button
            className="btn small secondary"
            data-tour="mcp-test"
            disabled={!!busy}
            onClick={async () => {
              setTest(((await run('test', () => api.post<Json>(`${base}/${id}/test`))) as Json | undefined) ?? null);
              s.reload();
            }}
          >
            {busy === 'test' ? 'Teste …' : 'Testen'}
          </button>
          {v.editable && (
            <>
              <button className="btn small ghost" onClick={() => onEdit(v)}>
                Bearbeiten
              </button>
              <button className="btn small ghost" onClick={async () => confirmAsk(`${v.name} löschen? Workflows mit seinen Werkzeugen schlagen dann fehl.`) && (await act(() => api.del(`${base}/${id}`), 'Gelöscht')) && onClose()}>
                Löschen
              </button>
            </>
          )}
        </div>
        {test && (
          <p className="small">
            <Badge tone="green">OK</Badge> {test.server_info?.name} · {test.tools} Werkzeuge{test.changed?.length ? ` · ${test.changed.length} geändert – bitte prüfen` : ''}
          </p>
        )}
        <h4 className="integ-h">
          Werkzeuge {v.tools_at ? <span className="muted small">(Stand {dt(v.tools_at)})</span> : null}
        </h4>
        {v.changed.length > 0 && (
          <div className="small" style={{ marginBottom: 8 }}>
            {v.changed.map((c: Json) => (
              <div key={c.name}>
                <Badge tone="yellow">geändert</Badge> <code>{c.name}</code>: {c.why}
              </div>
            ))}
          </div>
        )}
        {v.tools.length ? (
          <div className="mcp-tools" data-tour="mcp-tools">
            {v.tools.map((t: Json) => (
              <div key={t.name} className="mcp-tool">
                <Check checked={enabled.includes(t.name)} onChange={(on) => setEnabled(on ? [...enabled, t.name] : enabled.filter((x) => x !== t.name))} label={<strong>{t.title || t.name}</strong>} />
                <div className="muted small">
                  {t.annotations?.readOnlyHint ? <Badge tone="green">liest nur</Badge> : <Badge tone="yellow">kann schreiben</Badge>} <code>{t.exposed_as}</code> · {clip(t.description, 220)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted small">Noch keine Werkzeuge geladen – „Testen“ liest sie vom Server.</p>
        )}
        {v.editable && (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn small" disabled={!v.tools.length} onClick={async () => (await act(() => api.put(`${base}/${id}/tools`, { enabled }), 'Freigaben gespeichert')) && s.reload()}>
              Freigaben speichern
            </button>
            <button className="btn small ghost" onClick={async () => (await run('reload', () => api.get(`${base}/${id}/tools?refresh=1`), 'Werkzeuge neu geladen')) && s.reload()}>
              <Icon name="refresh" size={13} /> Neu laden
            </button>
            <button className="btn small ghost" onClick={() => setEnabled(v.tools.filter((t: Json) => t.annotations?.readOnlyHint).map((t: Json) => t.name))}>
              Nur lesende wählen
            </button>
          </div>
        )}
        {v.editable && (
          <div className="row" style={{ gap: 16, marginTop: 8 }}>
            <Check checked={v.expose_agent} onChange={async (x) => (await act(() => api.patch(`${base}/${id}`, { expose_agent: x }))) && s.reload()} label="Im KI-Agenten" />
            <Check checked={v.expose_mcp} onChange={async (x) => (await act(() => api.patch(`${base}/${id}`, { expose_mcp: x }))) && s.reload()} label="Über HyperLevels /mcp (Claude, Codex)" />
          </div>
        )}
        {!agency && v.tools.some((t: Json) => t.enabled) && <TryTool server={v} />}
        <h4 className="integ-h">Letzte Aufrufe</h4>
        {v.calls.length ? (
          <table className="t" data-tour="mcp-calls">
            <tbody>
              {v.calls.slice(0, 20).map((c: Json) => (
                <tr key={c.id}>
                  <td className="muted small">{dt(c.created_at)}</td>
                  <td>
                    <code className="small">{c.tool}</code>
                  </td>
                  <td>{c.ok ? <Badge tone="green">OK</Badge> : <Badge tone="red">Fehler</Badge>}</td>
                  <td className="muted small">
                    {c.source}
                    {c.location_name && agency ? ` · ${c.location_name}` : ''} · {c.ms} ms{c.error ? ` · ${clip(c.error, 80)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted small" data-tour="mcp-calls">
            Noch keine Aufrufe.
          </p>
        )}
      </div>
    </Modal>
  );
}

function TryTool({ server }: { server: Json }) {
  const tools: Json[] = server.tools.filter((t: Json) => t.enabled);
  const [name, setName] = useState(tools[0]?.name ?? '');
  const [args, setArgs] = useState<Json>({});
  const [out, setOut] = useState<Json | null>(null);
  const tool = tools.find((t) => t.name === name);
  return (
    <div className="mcp-try" data-tour="mcp-try">
      <h4 className="integ-h">Ausprobieren</h4>
      <Field label="Werkzeug">
        <Select value={name} onChange={(v) => (setName(v), setArgs({}), setOut(null))} options={tools.map((t) => [t.name, t.title || t.name] as [string, string])} />
      </Field>
      {tool && <SchemaForm schema={tool.input_schema} values={args} onChange={setArgs} merge={false} />}
      <button className="btn small" onClick={async () => setOut((await act(() => api.post<Json>('/api/mcp-servers/call', { server_id: server.id, tool: name, arguments: args }))) ?? null)}>
        Ausführen
      </button>
      {out && (
        <>
          <p className="small">
            {out.ok ? <Badge tone="green">OK</Badge> : <Badge tone="red">Fehler vom Server</Badge>} {out.ms} ms{out.truncated ? ' · gekürzt' : ''} · Antworten sind Daten des fremden Servers.
          </p>
          <pre className="mcp-out">{clip(typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2), 4000)}</pre>
        </>
      )}
    </div>
  );
}

// --- workflow step -------------------------------------------------------------------------------------------------

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

/** Step „MCP-Werkzeug ausführen“: server → enabled tool → form from its input schema → result mapping. */
export function McpToolStep({ step, set, customFields }: { step: Json; set: (p: Json) => void; customFields: Json[] }) {
  const data = useLoad(() => api.get<{ servers: Json[] }>('/api/mcp-servers/tools').catch(() => ({ servers: [] as Json[] })), []);
  const map: { from: string; to: string }[] = step.map ?? [];
  const targets: [string, string][] = [...CONTACT_TARGETS, ...customFields.map((f) => [`custom.${f.key}`, `Feld: ${f.label}`] as [string, string])];
  if (!data.data) return <Spinner />;
  const servers = data.data.servers;
  if (!servers.length && !step.server_id)
    return (
      <p className="muted">
        Noch kein MCP-Server mit freigegebenen Werkzeugen.{' '}
        <a href="/app/apps/mcp" onClick={(e) => (e.preventDefault(), navigate('apps/mcp'))}>
          Apps → MCP-Server
        </a>
      </p>
    );
  const server = servers.find((s) => s.id === step.server_id);
  const tool = server?.tools.find((t: Json) => t.name === step.tool);
  return (
    <div data-tour="mcp-step">
      <div className="row">
        <div className="grow">
          <Field label="MCP-Server">
            <Select value={step.server_id} onChange={(v) => set({ server_id: v, tool: '', arguments: {} })} placeholder="wählen…" options={servers.map((s) => [s.id, `${s.name}${s.scope === 'agency' ? ' (Agentur)' : ''}`] as [string, string])} />
          </Field>
        </div>
        <div className="grow">
          <Field label="Werkzeug">
            <Select value={step.tool} onChange={(v) => set({ tool: v, arguments: {} })} placeholder="wählen…" options={(server?.tools ?? []).map((t: Json) => [t.name, t.title || t.name] as [string, string])} />
          </Field>
        </div>
      </div>
      {step.server_id && !server && <p className="small" style={{ color: 'var(--red)' }}>Der Server ist nicht mehr verfügbar oder hat keine freigegebenen Werkzeuge.</p>}
      {tool && (
        <>
          <p className="muted small">{clip(tool.description, 300)}</p>
          <SchemaForm schema={tool.input_schema} values={step.arguments ?? {}} onChange={(v) => set({ arguments: v })} />
          <h4 className="integ-h">Ergebnis übernehmen (optional)</h4>
          <p className="muted small">
            Pfad im Ergebnis → Kontaktfeld (strukturierte Antwort oder JSON-Text). Spätere Schritte lesen es als <code>{'{{event.mcp_result.data.<pfad>}}'}</code>.
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
        </>
      )}
    </div>
  );
}
