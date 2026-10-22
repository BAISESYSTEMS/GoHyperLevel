import { useState } from 'react';
import { ago, api, dt } from '../api';
import { Icon } from '../icons';
import { useSession } from '../session';
import { Badge, Copy, Empty, Field, Input, MergeHint, Modal, Select, Spinner, Tabs, Textarea, act, confirmAsk, toast, useLoad } from '../ui';
import { AgencyAiProvider } from './AiProvider';
import { SignupLink } from '../referrals';

/**
 * „KI-Werkzeuge verbinden“: Codex, Claude Code, Cursor (key + copy-paste setup), ChatGPT and Claude.ai
 * (OAuth, no key), connection test, keys with „zuletzt benutzt“, connected apps and – per sub-account –
 * GitHub for Codex. The same page exists for the agency (agency keys, admins only).
 */

const TOOLS: [string, string][] = [
  ['codex', 'Codex (CLI, IDE-Erweiterung)'],
  ['claude-code', 'Claude Code'],
  ['cursor', 'Cursor'],
  ['other', 'Anderes KI-Werkzeug'],
];
const TOOL_LABEL: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code', cursor: 'Cursor', other: 'Sonstiges' };
const KEY_PLACEHOLDER = '<DEIN-SCHLÜSSEL>';

/** A copyable multi-line snippet. */
function Snippet({ text, label }: { text: string; label?: string }) {
  return (
    <div className="snippet">
      {label && <div className="snippet-label">{label}</div>}
      <pre>
        <code>{text}</code>
      </pre>
      <div className="snippet-copy">
        <Copy text={text} />
      </div>
    </div>
  );
}

export function codexToml(mcpUrl: string) {
  return `# ~/.codex/config.toml\n[mcp_servers.gohigh]\nurl = "${mcpUrl}"\nbearer_token_env_var = "GOHIGH_API_KEY"`;
}

function agentsMd(o: { brand: string; mcpUrl: string; agency: boolean; locName?: string; locId?: string }) {
  const scope = o.agency
    ? `Die Verbindung gilt für die ganze Agentur: jedes Projekt ist ein Sub-Account – die location_id kommt aus \`ghl_list_projects\`.`
    : `Die Verbindung gilt nur für den Sub-Account „${o.locName ?? ''}“ (location_id \`${o.locId ?? ''}\`); andere Sub-Accounts sind nicht erreichbar.`;
  return `## ${o.brand} (CRM) über MCP

Das CRM zu diesem Projekt läuft in ${o.brand}. Der MCP-Server \`gohigh\` (${o.mcpUrl}) ist verbunden.
${scope}

- Projekt-Steckbrief zuerst lesen: \`ghl_list_projects\`, \`ghl_get_project\` (Ziele, Links, Repos, Kennzahlen).
- Kontakte & Deals: \`ghl_search_contacts\`, \`ghl_get_contact\`, \`ghl_upsert_contact\`, \`ghl_list_opportunities\`, \`ghl_create_opportunity\`, \`ghl_update_opportunity\`.
- Aufgaben: \`ghl_list_tasks\`, \`ghl_create_task\`, \`ghl_complete_task\`.
- Posteingang: \`ghl_list_conversations\`, \`ghl_get_conversation\`; \`ghl_send_message\` verschickt echt – vorher fragen.
- Inhalte: \`ghl_create_social_post\` und \`ghl_create_blog_post\` legen Entwürfe an.
- Arbeit verknüpfen: diese Codex-Aufgabe bzw. Claude-Sitzung mit \`ghl_update_project\` (\`codex_sessions\` / \`claude_sessions\`) am Projekt eintragen.

Regeln: Schreibende Werkzeuge wirken sofort und stehen im Protokoll. Den Schlüssel nie ins Repository schreiben – er liegt in der Umgebungsvariable \`GOHIGH_API_KEY\` (oder die Verbindung läuft per OAuth).`;
}

/** Copy-paste setup for every tool; with a fresh key it is filled in. */
function SetupGuide({ mcpUrl, apiKey, agency, tour }: { mcpUrl: string; apiKey?: string; agency: boolean; tour?: boolean }) {
  const session = useSession();
  const [tab, setTab] = useState('codex');
  const key = apiKey || KEY_PLACEHOLDER;
  const loc = session.locations.find((l) => l.id === session.locationId);
  const brand = session.branding.name || 'HyperLevel';
  return (
    <div data-tour={tour ? 'ai-tools-setup' : undefined}>
      <Tabs
        tabs={[
          ['codex', 'Codex'],
          ['claude-code', 'Claude Code'],
          ['cursor', 'Cursor'],
          ['chatgpt', 'ChatGPT'],
          ['claude-ai', 'Claude.ai'],
          ['agents-md', 'AGENTS.md'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'codex' && (
        <>
          <p className="small">
            Gilt für die <strong>Codex CLI</strong> und die <strong>Codex-Erweiterung</strong> in VS Code, Cursor & Co. – beide lesen <code>~/.codex/config.toml</code>.
          </p>
          <Snippet label="1. In ~/.codex/config.toml eintragen" text={codexToml(mcpUrl)} />
          <Snippet label="2. Schlüssel als Umgebungsvariable setzen (z. B. in ~/.zshrc oder ~/.bashrc)" text={`export GOHIGH_API_KEY="${key}"`} />
          <Snippet label="Oder alles per Befehl" text={`codex mcp add gohigh --url ${mcpUrl} --bearer-token-env-var GOHIGH_API_KEY`} />
          <Snippet label="Ohne Schlüssel (Anmeldung im Browser per OAuth)" text={`codex mcp add gohigh --url ${mcpUrl}\ncodex mcp login gohigh`} />
          <p className="muted small">Prüfen: <code>codex mcp list</code> – in Codex fragt z. B. „Welche Aufgaben sind in {brand} offen?“.</p>
        </>
      )}
      {tab === 'claude-code' && (
        <>
          <Snippet label="Im Terminal" text={`claude mcp add --transport http gohigh ${mcpUrl} --header "Authorization: Bearer ${key}"`} />
          <p className="muted small">
            Mit <code>--scope project</code> landet die Verbindung in <code>.mcp.json</code> des Repos – dann den Schlüssel nicht einchecken. Ohne <code>--header</code> meldet sich Claude Code per OAuth an (<code>/mcp</code> → „Authenticate“).
          </p>
        </>
      )}
      {tab === 'cursor' && (
        <>
          <Snippet label="~/.cursor/mcp.json (oder .cursor/mcp.json im Projekt)" text={JSON.stringify({ mcpServers: { gohigh: { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)} />
          <p className="muted small">Danach in Cursor unter Einstellungen → MCP den Server „gohigh“ einschalten. Projekt-Dateien mit Schlüssel nicht einchecken.</p>
        </>
      )}
      {tab === 'chatgpt' && (
        <ol className="steps small">
          <li>ChatGPT → Einstellungen → <strong>Apps & Konnektoren</strong> → Erweitert → <strong>Entwicklermodus</strong> einschalten.</li>
          <li>
            „Erstellen“ (Konnektor/App): Name <strong>{brand}</strong>, MCP-Server-URL <code>{mcpUrl}</code>, Authentifizierung <strong>OAuth</strong>.
          </li>
          <li>ChatGPT öffnet die {brand}-Anmeldung: einloggen, {agency ? 'Agentur oder Sub-Account' : 'Sub-Account'} wählen, „Zulassen“.</li>
          <li>Im Chat über „+“ → Entwicklermodus den Konnektor auswählen. Getrennt wird hier unter „Verbundene Apps“.</li>
        </ol>
      )}
      {tab === 'claude-ai' && (
        <ol className="steps small">
          <li>Claude.ai (oder Claude Desktop) → Einstellungen → <strong>Konnektoren</strong> → „Benutzerdefinierten Konnektor hinzufügen“.</li>
          <li>
            Name <strong>{brand}</strong>, URL <code>{mcpUrl}</code> – ohne Client-ID/Secret (die App registriert sich selbst).
          </li>
          <li>„Verbinden“ → {brand}-Anmeldung → {agency ? 'Agentur oder Sub-Account' : 'Sub-Account'} wählen → „Zulassen“.</li>
          <li>Im Chat unter „Suchen und Werkzeuge“ den Konnektor einschalten.</li>
        </ol>
      )}
      {tab === 'agents-md' && (
        <>
          <p className="small">In die <code>AGENTS.md</code> (Codex) oder <code>CLAUDE.md</code> (Claude Code) deiner Repos – damit der Agent weiß, was die {brand}-Werkzeuge können:</p>
          <Snippet text={agentsMd({ brand, mcpUrl, agency, locName: loc?.name, locId: loc?.id })} />
        </>
      )}
    </div>
  );
}

function TestResult({ r }: { r: any }) {
  if (!r) return null;
  return r.ok ? (
    <p className="ai-test ok">
      <Icon name="ok" /> Verbunden mit {r.server} · Protokoll {r.protocol} · {r.tools} Werkzeuge ({r.sample.slice(0, 4).join(', ')} …) · {r.ms} ms
    </p>
  ) : (
    <p className="ai-test err">
      Fehler bei {r.step}: {r.error}
    </p>
  );
}

function TestConnection({ agency }: { agency: boolean }) {
  const [key, setKey] = useState('');
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="card" data-tour="ai-tools-test">
      <h2>Verbindung testen</h2>
      <p className="muted small">Schickt mit dem Schlüssel ein echtes MCP-„initialize“ und „tools/list“ an diese Instanz – genau wie Codex oder Claude Code.</p>
      <div className="row">
        <div className="grow">
          <Input type="password" autoComplete="off" value={key} onChange={setKey} placeholder={agency ? 'pghla_… oder pghl_…' : 'pghl_…'} />
        </div>
        <button
          className="btn secondary"
          disabled={!key.trim() || busy}
          onClick={async () => {
            setBusy(true);
            setRes(await act(() => api.post(agency ? '/api/agency/ai-tools/test' : '/api/ai-tools/test', { key: key.trim() })));
            setBusy(false);
          }}
        >
          Testen
        </button>
      </div>
      <TestResult r={res} />
    </div>
  );
}

function NewKeyModal({ created, mcpUrl, agency, onClose }: { created: any; mcpUrl: string; agency: boolean; onClose: () => void }) {
  const [res, setRes] = useState<any>(null);
  return (
    <Modal title={`${created.name} – jetzt einrichten`} onClose={onClose} wide>
      <p>
        Der Schlüssel wird <strong>nur dieses eine Mal</strong> angezeigt – gleich einrichten oder im Passwort-Manager speichern.{' '}
        {agency ? (created.scope === 'read' ? <Badge>Agentur · nur lesen</Badge> : <Badge tone="purple">Agentur · lesen & schreiben</Badge>) : <Badge tone="blue">nur dieser Sub-Account</Badge>}
      </p>
      <Snippet text={created.key} />
      <p>
        <button className="btn secondary" onClick={async () => setRes(await act(() => api.post(agency ? '/api/agency/ai-tools/test' : '/api/ai-tools/test', { key: created.key })))}>
          Verbindung testen
        </button>
      </p>
      <TestResult r={res} />
      <SetupGuide mcpUrl={mcpUrl} apiKey={created.key} agency={agency} />
    </Modal>
  );
}

export function AiTools({ agency = false }: { agency?: boolean }) {
  const session = useSession();
  const base = agency ? '/api/agency/ai-tools' : '/api/ai-tools';
  const data = useLoad(() => api.get<any>(base), [session.locationId, agency]);
  const [tool, setTool] = useState('codex');
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState('write');
  const [created, setCreated] = useState<any>(null);
  if (!data.data) return data.error ? <Empty>{data.error}</Empty> : <Spinner />;
  const d = data.data;
  const loc = session.locations.find((l) => l.id === session.locationId);
  const brand = session.branding.name || 'HyperLevel';
  return (
    <div className="ai-tools">
      <div className="card ai-tools-intro" data-tour="ai-tools-intro">
        <Icon name="aiTools" size={22} />
        <div className="grow">
          <h2>KI-Werkzeuge verbinden</h2>
          <p className="muted small">
            {agency
              ? `Codex, Claude Code, Cursor, ChatGPT oder Claude.ai arbeiten direkt mit ${brand}: alle Projekte, Kontakte, Deals, Aufgaben, Posteingang, Berichte. Agentur-Schlüssel gelten für alle Sub-Accounts.`
              : `Codex, Claude Code, Cursor, ChatGPT oder Claude.ai arbeiten direkt mit „${loc?.name ?? 'diesem Sub-Account'}“: Kontakte, Deals, Aufgaben, Posteingang, Inhalte – nur dieser Sub-Account. Jede Änderung steht im Protokoll.`}
          </p>
          <div className="ai-tools-url">
            <span className="muted small">MCP-Adresse</span>
            <code>{d.mcp_url}</code>
            <Copy text={d.mcp_url} />
          </div>
        </div>
      </div>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="card" style={{ flex: '1 1 340px' }} data-tour="ai-tools-new">
          <h2>
            <Icon name="key" size={18} /> Mit Schlüssel: Codex, Claude Code, Cursor
          </h2>
          <p className="muted small">Ein Klick erzeugt einen eigenen Schlüssel je Werkzeug und Gerät – so siehst du, was wann benutzt wurde, und kannst einzeln widerrufen.</p>
          <div className="grid2">
            <Field label="Werkzeug">
              <Select value={tool} onChange={setTool} options={TOOLS} />
            </Field>
            <Field label="Gerät / Zweck">
              <Input value={label} onChange={setLabel} placeholder="z. B. Laptop" maxLength={60} />
            </Field>
          </div>
          {agency && (
            <Field label="Rechte" hint="Agentur-Schlüssel gelten für alle Sub-Accounts.">
              <Select value={scope} onChange={setScope} options={[['write', 'Lesen & schreiben'], ['read', 'Nur lesen']]} />
            </Field>
          )}
          <button
            className="btn"
            data-tour="ai-tools-create"
            onClick={async () => {
              const r = await act(() => api.post(`${base}/keys`, { tool, label: label.trim() || 'Laptop', ...(agency ? { scope } : {}) }));
              if (r) {
                setCreated(r);
                setLabel('');
                data.reload();
              }
            }}
          >
            {agency ? 'Agentur-Schlüssel erzeugen' : 'Schlüssel erzeugen'}
          </button>
          {!agency && <p className="muted small">Der Schlüssel gilt nur für diesen Sub-Account.{session.user.role === 'admin' ? ' Agentur-Schlüssel für alle Sub-Accounts gibt es unter Agentur → KI-Werkzeuge.' : ''}</p>}
        </div>
        <div className="card" style={{ flex: '1 1 340px' }} data-tour="ai-tools-oauth">
          <h2>
            <Icon name="consent" size={18} /> Ohne Schlüssel: ChatGPT & Claude.ai
          </h2>
          <p className="muted small">
            ChatGPT (Konnektoren im Entwicklermodus), Claude.ai-Konnektoren und <code>codex mcp login</code> melden sich per <strong>OAuth</strong> an: einfach die MCP-Adresse eintragen, dann öffnet sich die {brand}-Anmeldung. Dort wählst du{' '}
            {agency ? 'den Sub-Account oder die ganze Agentur' : 'den Sub-Account'} und ob die App nur lesen darf.
          </p>
          <p className="muted small">Zugänge laufen nach einer Stunde ab und werden von der App erneuert; trennen kannst du jederzeit unten unter „Verbundene Apps“.</p>
        </div>
      </div>

      <div className="card">
        <h2>Einrichtung</h2>
        <SetupGuide mcpUrl={d.mcp_url} agency={agency} tour />
      </div>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="card" style={{ flex: '1 1 380px' }} data-tour="ai-tools-keys">
          <h2>Schlüssel</h2>
          {d.keys.length ? (
            <div className="table-wrap">
              <table className="t">
                <tbody>
                  {d.keys.map((k: any) => (
                    <tr key={k.id}>
                      <td>
                        <strong>{k.name}</strong> {k.tool && <Badge tone="blue">{TOOL_LABEL[k.tool] ?? k.tool}</Badge>} {agency && <Badge tone={k.scope === 'read' ? 'gray' : 'purple'}>{k.scope === 'read' ? 'lesen' : 'schreiben'}</Badge>}
                        <div className="muted small">
                          <span className="mono">{k.prefix}…</span> · angelegt {dt(k.created_at)} · zuletzt benutzt {k.last_used_at ? ago(k.last_used_at) : 'nie'}
                        </div>
                      </td>
                      <td className="actions">
                        <button className="btn small ghost" onClick={async () => confirmAsk(`Schlüssel „${k.name}“ widerrufen? Werkzeuge mit diesem Schlüssel verlieren sofort den Zugang.`) && (await act(() => api.del(`${base}/keys/${k.id}`), 'Widerrufen')) && data.reload()}>
                          Widerrufen
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Noch keine Schlüssel.</Empty>
          )}
        </div>
        <div className="card" style={{ flex: '1 1 380px' }} data-tour="ai-tools-apps">
          <h2>Verbundene Apps (OAuth)</h2>
          {d.apps.length ? (
            <div className="table-wrap">
              <table className="t">
                <tbody>
                  {d.apps.map((a: any) => (
                    <tr key={a.id}>
                      <td>
                        <strong>{a.client_name}</strong> <Badge tone={a.access === 'read' ? 'gray' : 'purple'}>{a.access === 'read' ? 'nur lesen' : 'lesen & schreiben'}</Badge>
                        <div className="muted small">
                          {a.known ?? a.redirect_host} · freigegeben von {a.user_name} {ago(a.created_at)} · zuletzt benutzt {a.last_used_at ? ago(a.last_used_at) : 'nie'}
                        </div>
                      </td>
                      <td className="actions">
                        <button className="btn small ghost" onClick={async () => confirmAsk(`„${a.client_name}“ trennen? Die App verliert sofort den Zugang.`) && (await act(() => api.del(`${base}/apps/${a.id}`), 'Getrennt')) && data.reload()}>
                          Trennen
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Noch keine App per OAuth verbunden.</Empty>
          )}
        </div>
      </div>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 380px' }}>
          <TestConnection agency={agency} />
        </div>
        <div style={{ flex: '1 1 380px' }}>{agency ? <AgencyAiProvider /> : <GithubCodex />}</div>
      </div>

      {created && <NewKeyModal created={created} mcpUrl={d.mcp_url} agency={agency} onClose={() => setCreated(null)} />}
    </div>
  );
}

/** GitHub token + default repository for the workflow action „GitHub-Issue für Codex anlegen“. */
export function GithubCodex() {
  const s = useLoad(() => api.get<any>('/api/github-codex/settings'), []);
  const [token, setToken] = useState('');
  const [repo, setRepo] = useState<string | null>(null);
  if (!s.data) return s.error ? <Empty>{s.error}</Empty> : <Spinner />;
  const save = async (patch: any) => {
    const r = await act(() => api.put('/api/github-codex/settings', patch), 'Gespeichert');
    if (r) (s.setData(r), setToken(''), setRepo(null));
  };
  return (
    <div className="card" data-tour="ai-tools-github">
      <h2>
        <Icon name="github" size={18} /> GitHub für Codex <SignupLink id="github" />
      </h2>
      <p className="muted small">
        Für die Workflow-Aktion „GitHub-Issue für Codex anlegen“: Sie legt ein Issue mit dem Kontext des Kontakts und einer Zeile <code>@codex …</code> an – Codex übernimmt es als Aufgabe. Im Repository muss die Codex-GitHub-Integration eingeschaltet sein.
      </p>
      <Field label="GitHub-Token" hint="Fein granularer Token mit „Issues: lesen & schreiben“ für die gewünschten Repositories. Wird verschlüsselt gespeichert und nie wieder angezeigt.">
        {s.data.token_set && !token ? (
          <div className="row" style={{ alignItems: 'center' }}>
            <Badge tone="green">hinterlegt {s.data.token_hint}</Badge>
            <button className="btn small secondary" onClick={() => setToken(' ')}>
              Ersetzen
            </button>
            <button className="btn small secondary" onClick={() => confirmAsk('Token entfernen?') && save({ token: null })}>
              Entfernen
            </button>
          </div>
        ) : (
          <Input type="password" autoComplete="off" value={token.trim()} onChange={setToken} placeholder="github_pat_…" />
        )}
      </Field>
      <Field label="Standard-Repository">
        <Input value={repo ?? s.data.default_repo} onChange={setRepo} placeholder="besitzer/repository" />
      </Field>
      <div className="row">
        <button className="btn" onClick={() => save({ ...(token.trim() ? { token: token.trim() } : {}), ...(repo !== null ? { default_repo: repo } : {}) })}>
          Speichern
        </button>
        <button
          className="btn secondary"
          disabled={!s.data.token_set}
          onClick={async () => {
            const r = await act(() => api.post('/api/github-codex/test', {}));
            if (r) toast(`Zugriff ok: ${r.repo}`);
          }}
        >
          Zugriff prüfen
        </button>
      </div>
    </div>
  );
}

/** Workflow step „GitHub-Issue für Codex anlegen“. */
export function GithubIssueStep({ step, set }: { step: any; set: (p: any) => void }) {
  const s = useLoad(() => api.get<any>('/api/github-codex/settings'), []);
  return (
    <>
      {s.data && !s.data.token_set && <p className="muted small">Erst unter Einstellungen → KI-Werkzeuge → „GitHub für Codex“ einen Token hinterlegen.</p>}
      <Field label="Repository" hint={`besitzer/name – leer = Standard${s.data?.default_repo ? ` (${s.data.default_repo})` : ''}. Codex muss dort per GitHub-Integration aktiv sein.`}>
        <Input value={step.repo} onChange={(v) => set({ repo: v })} placeholder={s.data?.default_repo || 'acme/website'} />
      </Field>
      <Field label="Titel">
        <Input value={step.title} onChange={(v) => set({ title: v })} placeholder="Fehler gemeldet von {{contact.first_name}}" />
      </Field>
      <Field label="Beschreibung (optional)" hint="Kontakt, E-Mail, Firma und ein Link zum Kontakt werden automatisch angehängt.">
        <Textarea value={step.body} onChange={(v) => set({ body: v })} rows={4} />
      </Field>
      <Field label="Coding-Agent">
        <Select value={step.agent ?? 'codex'} onChange={(v) => set({ agent: v })} options={[['codex', '@codex'], ['claude', '@claude']]} />
      </Field>
      <Field label="Auftrag an den Agenten" hint="Steht im Issue als Zeile „@codex …“ bzw. „@claude …“ – der Agent übernimmt das Issue dann als Aufgabe.">
        <Textarea value={step.prompt} onChange={(v) => set({ prompt: v })} rows={3} placeholder="Bitte den Fehler finden, beheben und einen Pull Request öffnen." />
      </Field>
      <Field label="Labels (optional, mit Komma)">
        <Input value={step.labels} onChange={(v) => set({ labels: v })} placeholder="bug, kunde" />
      </Field>
      <MergeHint />
    </>
  );
}
