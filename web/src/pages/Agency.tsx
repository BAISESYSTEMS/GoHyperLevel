import { useState } from 'react';
import { ago, api, d, dt, euro } from '../api';
import { useSession, type Branding } from '../session';
import { useAppInfo } from '../demo';
import { LearnLink } from '../tour/learn';
import { AcademyWelcome } from '../tour/welcome';
// The default tab is in this chunk; every other tab loads when opened (web/src/lazy.tsx).
import { PageSuspense, lazyPages } from '../lazy';
const { AllTasks, ApiAndMcp, AuditLog, MailAccounts } = lazyPages(() => import('./AgencyPlatform'), 'AllTasks', 'ApiAndMcp', 'AuditLog', 'MailAccounts');
import { ProjectsOverview } from './Project';
const { AllContacts, AllDeals } = lazyPages(() => import('./AgencyLists'), 'AllContacts', 'AllDeals');
const { AgencyDocs } = lazyPages(() => import('./Docs'), 'AgencyDocs');
const { SupabaseMirror } = lazyPages(() => import('./SupabaseMirror'), 'SupabaseMirror');
const { SaasAdmin } = lazyPages(() => import('./Saas'), 'SaasAdmin');
const { CloudConsole } = lazyPages(() => import('./CloudConsole'), 'CloudConsole');
const { OAuthApps } = lazyPages(() => import('./OAuthConnect'), 'OAuthApps');
const { MailboxAgencyCard } = lazyPages(() => import('./Mailboxes'), 'MailboxAgencyCard');
const { LoginSettings } = lazyPages(() => import('./LoginSettings'), 'LoginSettings');
const { TodoistSync } = lazyPages(() => import('./TodoistSync'), 'TodoistSync');
const { OpenShortsSetup } = lazyPages(() => import('./VideoStudio'), 'OpenShortsSetup');
const { AgencyIntegrationsHub } = lazyPages(() => import('./Integrations'), 'AgencyIntegrationsHub');
const { AiTools } = lazyPages(() => import('./AiTools'), 'AiTools');
const { AiConnections } = lazyPages(() => import('./AiConnections'), 'AiConnections');
const { ComposioAgencySetup } = lazyPages(() => import('./Composio'), 'ComposioAgencySetup');
const { NangoAgencySetup } = lazyPages(() => import('./Nango'), 'NangoAgencySetup');
const { CogneeAgencySetup } = lazyPages(() => import('./CogneeAgency'), 'CogneeAgencySetup');
const { McpServers } = lazyPages(() => import('./McpServers'), 'McpServers');
const { PartnerLinks } = lazyPages(() => import('./PartnerLinks'), 'PartnerLinks');
const { BrandingLook, LogoPreview, LogoSet } = lazyPages(() => import('../theme/BrandingLook'), 'BrandingLook', 'LogoPreview', 'LogoSet');
import { SignupLink } from '../referrals';
import { Badge, Check, CodeBox, Empty, Field, Input, Modal, PageHead, Select, Spinner, Textarea, act, confirmAsk, navigate, toast, useLoad } from '../ui';
import { SnapshotTemplates } from './SnapshotTemplates';
import { Slot } from '../slots';
import { AgencyTabs } from '../areas/SettingsTabs';
import { MoreFields } from '../areas/fields';
import { DEFAULT_CLIENT_PERMS, PermissionPicker } from './PermissionPicker';
const { AgencyFeedback } = lazyPages(() => import('./FeedbackAdmin'), 'AgencyFeedback');
const { SystemHealth } = lazyPages(() => import('./SystemHealth'), 'SystemHealth');
const { UmzugAssistent } = lazyPages(() => import('./UmzugAssistent'), 'UmzugAssistent');


export function DomainBadge({ status }: { status?: { status: string; message?: string } }) {
  if (!status) return null;
  const map: Record<string, [string, any]> = {
    active: ['HTTPS aktiv', 'green'],
    pending_dns: ['wartet auf DNS', 'yellow'],
    pending: ['wird eingerichtet', 'blue'],
    unverified: ['nicht bestätigt', 'yellow'],
    error: ['Fehler', 'red'],
  };
  const [label, tone] = map[status.status] ?? [status.status, 'gray'];
  return (
    <span title={status.message}>
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}

function randomPassword() {
  const a = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint32Array(14)), (n) => a[n % a.length]).join('');
}


function NewClient({ snapshots, onClose, onDone }: { snapshots: any[]; onClose: () => void; onDone: (r: any) => void }) {
  const [f, setF] = useState<any>({ name: '', timezone: 'Europe/Berlin', email: '', phone: '', website: '', snapshot_id: '', activate_workflows: false });
  const [login, setLogin] = useState(false);
  const [u, setU] = useState<any>({ email: '', name: '', password: randomPassword(), permissions: DEFAULT_CLIENT_PERMS });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/agency/clients', { ...f, user: login ? u : undefined }));
    setBusy(false);
    if (r) onDone({ ...r, password: login ? u.password : undefined });
  };
  return (
    <Modal
      title="Neuer Kunde"
      onClose={onClose}
      wide
      footer={
        <button className="btn" disabled={!f.name || busy} onClick={save}>
          Kunde anlegen
        </button>
      }
    >
      <div className="grid2">
        <Field label="Firmenname *">
          <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} autoFocus />
        </Field>
        <Field label="E-Mail der Firma (bekommt Benachrichtigungen)">
          <Input value={f.email} onChange={(v) => setF({ ...f, email: v })} />
        </Field>
      </div>
      <MoreFields id="agency-new-client" values={[f.website, f.timezone !== 'Europe/Berlin' && f.timezone]}>
        <div className="grid2">
          <Field label="Zeitzone">
            <Input value={f.timezone} onChange={(v) => setF({ ...f, timezone: v })} />
          </Field>
          <Field label="Webseite">
            <Input value={f.website} onChange={(v) => setF({ ...f, website: v })} />
          </Field>
        </div>
      </MoreFields>
      <Field label="Startpaket (Snapshot)" hint="Kopiert Websites (mit Blog), Funnels, Formulare, Kalender, Workflows, Pipelines, Vorlagen, Kurse und Community-Gruppen – keine Kontakte, Teilnehmer oder Beiträge.">
        <Select value={f.snapshot_id} onChange={(v) => setF({ ...f, snapshot_id: v })} placeholder="– leer starten –" options={snapshots.map((s) => [s.id, `${s.name} (${s.summary.funnels} Seiten-Projekte, ${s.summary.workflows} Workflows)`])} />
      </Field>
      {f.snapshot_id && <Check checked={f.activate_workflows} onChange={(v) => setF({ ...f, activate_workflows: v })} label="Workflows gleich aktivieren (sonst als Entwurf)" />}
      <hr />
      <Check checked={login} onChange={setLogin} label="Login für den Kunden anlegen" />
      {login && (
        <>
          <div className="grid3">
            <Field label="E-Mail">
              <Input value={u.email} onChange={(v) => setU({ ...u, email: v })} />
            </Field>
            <Field label="Name">
              <Input value={u.name} onChange={(v) => setU({ ...u, name: v })} />
            </Field>
            <Field label="Passwort">
              <Input value={u.password} onChange={(v) => setU({ ...u, password: v })} />
            </Field>
          </div>
          <MoreFields id="agency-new-client-perms" label="Bereiche einschränken">
            <Field label="Darf sehen">
              <PermissionPicker value={u.permissions} onChange={(v) => setU({ ...u, permissions: v })} />
            </Field>
          </MoreFields>
        </>
      )}
    </Modal>
  );
}

function Clients() {
  const session = useSession();
  const overview = useLoad(() => api.get<any[]>('/api/agency/overview'), []);
  const snapshots = useLoad(() => api.get<any[]>('/api/snapshots'), []);
  const [modal, setModal] = useState(false);
  const [done, setDone] = useState<any>(null);
  const [brand, setBrand] = useState<any>(null);
  const open = (id: string) => session.switchLocation(id);
  if (!overview.data) return <Spinner />;
  const list = overview.data;
  return (
    <>
      <div className="row" style={{ marginBottom: 12, justifyContent: 'space-between' }}>
        <span className="muted">
          {list.length} Kunden · {list.reduce((n, l) => n + l.contacts, 0)} Kontakte · {list.reduce((n, l) => n + l.funnels.length, 0)} Websites/Funnels
        </span>
        <button className="btn" data-tour="clients-new" onClick={() => setModal(true)}>
          + Neuer Kunde
        </button>
      </div>
      <div className="table-wrap" data-tour="clients-list">
        <table className="t">
          <thead>
            <tr>
              <th>Kunde</th>
              <th>Kontakte</th>
              <th>Leads (30 T.)</th>
              <th>Pipeline</th>
              <th>Termine</th>
              <th>Websites & Funnels</th>
              <th>Logins</th>
              <th>Aktiv</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((l) => (
              <tr key={l.id}>
                <td>
                  <strong>{l.name}</strong>
                  {l.unread > 0 && (
                    <>
                      {' '}
                      <Badge tone="blue">{l.unread} ungelesen</Badge>
                    </>
                  )}
                  <div className="muted small">seit {d(l.created_at)}</div>
                </td>
                <td>{l.contacts}</td>
                <td>
                  {l.new_contacts} <span className="muted small">· {l.submissions} Formulare</span>
                </td>
                <td>{euro(l.open_value)}</td>
                <td>{l.appointments}</td>
                <td className="small">
                  {l.funnels.map((f: any) => (
                    <div key={f.id}>
                      <a href={f.url} target="_blank" rel="noreferrer">
                        {f.domain || f.name}
                      </a>{' '}
                      {f.domain && <DomainBadge status={f.domain_status} />}
                    </div>
                  ))}
                  {!l.funnels.length && <span className="muted">–</span>}
                </td>
                <td>{l.users}</td>
                <td className="muted small">{l.last_activity ? ago(l.last_activity) : '–'}</td>
                <td className="actions">
                  <button className="btn small" onClick={() => open(l.id)}>
                    Öffnen
                  </button>
                  <button
                    className="btn small secondary"
                    onClick={async () => {
                      const r = await act(() => api.post('/api/snapshots', { location_id: l.id, name: `${l.name} – Vorlage` }), 'Snapshot erstellt');
                      if (r) snapshots.reload();
                    }}
                  >
                    Als Vorlage
                  </button>
                  <button className="btn small secondary" onClick={() => setBrand(l)}>
                    Branding
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {brand && (
        <Modal title={`Branding: ${brand.name}`} onClose={() => setBrand(null)} wide>
          <BrandingSettings locationId={brand.id} onSaved={() => setBrand(null)} />
        </Modal>
      )}
      {modal && (
        <NewClient
          snapshots={snapshots.data ?? []}
          onClose={() => setModal(false)}
          onDone={(r) => {
            setModal(false);
            setDone(r);
            overview.reload();
            session.reload();
          }}
        />
      )}
      {done && (
        <Modal title={`${done.location.name} ist angelegt`} onClose={() => setDone(null)} footer={<button className="btn" onClick={() => (setDone(null), open(done.location.id))}>Zum Kunden wechseln</button>}>
          {done.created && (
            <p>
              Aus dem Snapshot: {done.created.funnels.length} Websites/Funnels, {done.created.forms.length} Formulare, {done.created.calendars.length} Kalender, {done.created.workflows.length} Workflows.
            </p>
          )}
          {done.user && (
            <>
              <p>Zugang für den Kunden (jetzt notieren, das Passwort wird nicht noch mal angezeigt):</p>
              <CodeBox text={`${location.origin}/app  ·  ${done.user.email}  ·  ${done.password}`} />
            </>
          )}
          <p className="muted">Nächster Schritt: beim Kunden unter Funnels & Websites die Domain eintragen.</p>
        </Modal>
      )}
    </>
  );
}

function Snapshots() {
  const session = useSession();
  const list = useLoad(() => api.get<any[]>('/api/snapshots'), []);
  const [src, setSrc] = useState(session.locationId);
  const [nameV, setName] = useState('');
  const [apply, setApply] = useState<any>(null);
  const [target, setTarget] = useState('');
  const [activate, setActivate] = useState(false);
  const importFile = async (file: File) => {
    const text = await file.text();
    let name = file.name.replace(/\.json$/, '');
    try {
      name = JSON.parse(text).name || name;
    } catch {
      /* the server reports bad files */
    }
    const r = await act(() => api.post('/api/snapshots/import', { name, data: text }), 'Snapshot importiert');
    if (r) list.reload();
  };
  return (
    <>
      <SnapshotTemplates />
      <p className="muted">Ein Snapshot ist ein Startpaket: Websites mit Blog-Beiträgen, Funnels, Formulare, Kalender, Workflows, Pipelines, Vorlagen, Produkte, eigene Felder, Kurse (Module & Lektionen) und die Struktur der Community-Gruppen eines Sub-Accounts – ohne Kontakte, Kursteilnehmer oder Community-Beiträge. Damit legst du neue Kunden in Sekunden an.</p>
      <div className="card row" style={{ alignItems: 'flex-end' }} data-tour="snapshots-create">
        <Field label="Aus Sub-Account">
          <Select value={src} onChange={setSrc} options={session.locations.map((l) => [l.id, l.name])} />
        </Field>
        <div className="grow">
          <Field label="Name">
            <Input value={nameV} onChange={setName} placeholder="z. B. Handwerker-Website" />
          </Field>
        </div>
        <button className="btn" style={{ marginBottom: 12 }} onClick={() => act(() => api.post('/api/snapshots', { location_id: src, name: nameV }), 'Snapshot erstellt').then(() => (setName(''), list.reload()))}>
          Snapshot erstellen
        </button>
        <label className="btn secondary" style={{ marginBottom: 12 }}>
          JSON importieren
          <input type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        </label>
      </div>
      {list.data?.length ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="t">
            <thead>
              <tr>
                <th>Name</th>
                <th>Inhalt</th>
                <th>Erstellt</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.name}</strong>
                    {s.description && <div className="muted small">{s.description}</div>}
                  </td>
                  <td className="small">
                    {s.summary.funnels} Websites/Funnels ({s.summary.pages} Seiten) · {s.summary.forms} Formulare · {s.summary.calendars} Kalender · {s.summary.workflows} Workflows · {s.summary.pipelines} Pipelines · {s.summary.templates} Vorlagen
                    {s.summary.blog_posts ? ` · ${s.summary.blog_posts} Blog-Beiträge` : ''}
                    {s.summary.courses ? ` · ${s.summary.courses} Kurse (${s.summary.lessons} Lektionen)` : ''}
                    {s.summary.community_groups ? ` · ${s.summary.community_groups} Community-Gruppen` : ''}
                  </td>
                  <td className="muted">{dt(s.created_at)}</td>
                  <td className="actions">
                    <button className="btn small" onClick={() => (setApply(s), setTarget(''))}>
                      Anwenden
                    </button>
                    <a className="btn small secondary" href={`/api/snapshots/${s.id}/download`}>
                      Download
                    </a>
                    <button className="btn small ghost" onClick={() => confirmAsk('Snapshot löschen?') && act(() => api.del(`/api/snapshots/${s.id}`)).then(list.reload)}>
                      Löschen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Noch keine Snapshots. Bau einen Muster-Kunden mit Website & Workflows auf und speichere ihn als Vorlage.</Empty>
      )}
      {apply && (
        <Modal
          title={`„${apply.name}“ anwenden`}
          onClose={() => setApply(null)}
          footer={
            <button
              className="btn"
              disabled={!target}
              onClick={async () => {
                const r = await act(() => api.post(`/api/snapshots/${apply.id}/apply`, { location_id: target, activate_workflows: activate }));
                if (r) {
                  toast(`Kopiert: ${r.funnels.length} Websites/Funnels, ${r.forms.length} Formulare, ${r.workflows.length} Workflows`);
                  setApply(null);
                }
              }}
            >
              Hinzufügen
            </button>
          }
        >
          <p className="muted">Fügt alles als Kopie zum Sub-Account hinzu. Bestehendes bleibt unverändert.</p>
          <Field label="Ziel-Sub-Account">
            <Select value={target} onChange={setTarget} placeholder="wählen…" options={session.locations.map((l) => [l.id, l.name])} />
          </Field>
          <Check checked={activate} onChange={setActivate} label="Workflows gleich aktivieren" />
        </Modal>
      )}
    </>
  );
}

function Domains() {
  const data = useLoad(() => api.get('/api/agency/domains'), []);
  if (!data.data) return <Spinner />;
  const { server_ip, agent, domains } = data.data;
  return (
    <>
      <div className="card" data-tour="domains-howto">
        <h2>So kommt eine Kundendomain online</h2>
        <ol>
          <li>Beim Kunden unter Funnels & Websites → Einstellungen & Domain die Domain eintragen (z. B. <code>malerbetrieb-meier.de</code>).</li>
          <li>
            Beim Domain-Anbieter einen <strong>A-Record</strong> auf <code>{server_ip || 'die Server-IP'}</code> setzen – für <code>@</code> und <code>www</code>.
          </li>
          <li>Fertig: Innerhalb weniger Minuten richtet der Domain-Agent nginx und das SSL-Zertifikat ein. Der Status steht unten.</li>
        </ol>
        {!agent && <p style={{ color: 'var(--red)' }}>Der Domain-Agent ist auf diesem Server nicht eingerichtet (PGHL_AGENT_TOKEN fehlt) – Domains müssen dann von Hand im Proxy eingetragen werden.</p>}
      </div>
      <div className="table-wrap" style={{ marginTop: 12 }} data-tour="domains-list">
        <table className="t">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Art</th>
              <th>Kunde</th>
              <th>Status</th>
              <th>Geprüft</th>
            </tr>
          </thead>
          <tbody>
            {domains.map((x: any) => (
              <tr key={x.domain}>
                <td>
                  <a href={`https://${x.domain}`} target="_blank" rel="noreferrer">
                    {x.domain}
                  </a>
                  {x.alias && <div className="muted small">+ {x.alias}</div>}
                </td>
                <td>{x.kind === 'app' ? 'Agentur-App' : 'Website/Funnel'}</td>
                <td>{x.location ?? '–'}</td>
                <td>
                  <DomainBadge status={x} />
                  <div className="muted small">{x.message}</div>
                </td>
                <td className="muted">{x.checked_at ? ago(x.checked_at) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!domains.length && <Empty>Noch keine eigenen Domains.</Empty>}
      </div>
      <p>
        <button className="btn small secondary" onClick={() => data.reload()}>
          Aktualisieren
        </button>
      </p>
    </>
  );
}

function BrandingSettings({ locationId, onSaved }: { locationId?: string; onSaved?: () => void }) {
  const session = useSession();
  const url = locationId ? `/api/agency/locations/${locationId}/branding` : '/api/agency/branding';
  const b = useLoad(() => api.get(url), [url]);
  const agency = useLoad(() => (locationId ? api.get('/api/agency/branding') : Promise.resolve(null)), [locationId]);
  const info = useLoad(() => api.get('/api/agency/domains'), []);
  if (!b.data || (locationId && !agency.data)) return <Spinner />;
  const v = b.data;
  const fb = agency.data ?? {};
  const shown = { ...v, name: v.name || fb.name || '', color: v.color || fb.color || '#2563eb', logo_url: v.logo_url || fb.logo_url || '' };
  const set = (p: any) => b.setData({ ...v, ...p });
  // The client's own values over the agency's: what the logins actually see.
  const merged = (locationId ? { ...fb, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x !== undefined && x !== null)) } : v) as Branding;
  return (
    <>
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="card" style={{ flex: '2 1 420px' }} data-tour="branding-form">
        <div className="grid2">
          <Field label={locationId ? 'App-Name für diesen Kunden' : 'Name deiner Agentur / App'}>
            <Input value={v.name} onChange={(x) => set({ name: x })} placeholder={fb.name} />
          </Field>
          <Field label="Markenfarbe">
            <input type="color" value={shown.color} onChange={(e) => set({ color: e.target.value })} />
            {locationId && v.color && (
              <button className="btn small secondary" onClick={() => set({ color: '' })}>
                Agentur-Farbe
              </button>
            )}
          </Field>
        </div>
        <h3 style={{ margin: '4px 0 8px' }}>Logos und Favicon</h3>
        <LogoSet v={v as Branding} fb={fb} set={set} client={!!locationId} />
        <MoreFields id="agency-branding-login" label="Texte der Login-Seite" values={[v.login_title, v.login_text, v.support_email]}>
          <Field label="Login: Überschrift">
            <Input value={v.login_title} onChange={(x) => set({ login_title: x })} placeholder={`Anmelden bei ${shown.name}`} />
          </Field>
          <Field label="Login: Text">
            <Textarea value={v.login_text} onChange={(x) => set({ login_text: x })} rows={2} placeholder="Willkommen in deinem Kundenportal." />
          </Field>
          <Field label="Support-E-Mail (auf der Login-Seite)">
            <Input value={v.support_email} onChange={(x) => set({ support_email: x })} />
          </Field>
        </MoreFields>
        <Field
          tour="branding-domain"
          label={locationId ? 'Login-Domain des Kunden (optional)' : 'Eigene App-Domain'}
          hint={
            locationId ? (
              <>
                z. B. <code>crm.kunde.de</code> – A-Record auf <code>{info.data?.server_ip || 'die Server-IP'}</code>. Die Login-Seite dort zeigt das Branding des Kunden.
              </>
            ) : (
              <>
                z. B. <code>app.deine-agentur.de</code> – A-Record auf <code>{info.data?.server_ip || 'die Server-IP'}</code>. Kunden loggen sich dann dort ein, und Links in Mails (Buchung, Rechnung) nutzen diese Domain, sobald HTTPS aktiv ist.
              </>
            )
          }
        >
          <Input value={v.app_domain} onChange={(x) => set({ app_domain: x })} />
        </Field>
        {v.app_domain && <DomainBadge status={v.app_domain_status} />}
        <p>
          <button
            className="btn"
            onClick={async () => {
              const r = await act(() => api.patch(url, v), 'Branding gespeichert');
              if (r) {
                b.setData(r);
                if (onSaved) onSaved();
                else session.reload();
              }
            }}
          >
            Speichern
          </button>
        </p>
      </div>
      <div className="card" style={{ flex: '1 1 260px' }} data-tour="branding-preview">
        <h2>Vorschau</h2>
        <LogoPreview shown={{ ...merged, name: shown.name, color: shown.color }} />
        <p className="muted small">{locationId ? 'Das sehen die Logins dieses Kunden. Leere Felder = dein Agentur-Branding.' : '„HyperLevel“ taucht danach nirgends mehr auf – auch nicht für Kunden-Logins.'}</p>
      </div>
    </div>
    <BrandingLook locationId={locationId} />
    </>
  );
}

function Integrations() {
  const s = useLoad(() => api.get<any>('/api/agency/social'), []);
  const locs = useLoad(() => api.get<any[]>('/api/agency/overview'), []);
  const [url, setUrl] = useState<string | null>(null);
  const [key, setKey] = useState('');
  if (!s.data || !locs.data) return <Spinner />;
  const v = s.data;
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="card" style={{ flex: '1 1 340px' }} data-tour="integrations-postiz">
        <h2>Postiz (Social Planner) <SignupLink id="postiz" /></h2>
        <p className="muted small">Postiz veröffentlicht die Posts. Deine Kunden planen im Social Planner, ohne Postiz zu sehen.</p>
        <Field label="Adresse">
          <Input value={url ?? v.url} onChange={setUrl} placeholder="https://postiz.deine-domain.de" />
        </Field>
        <Field label="API-Schlüssel" hint="Postiz → Einstellungen → Public API">
          <Input type="password" value={key} onChange={setKey} placeholder={v.key_set ? '•••••••• (gespeichert)' : ''} autoComplete="off" />
        </Field>
        <p>
          <button
            className="btn"
            onClick={async () => {
              const r = await act(() => api.patch('/api/agency/social', { url: url ?? v.url, ...(key ? { api_key: key } : {}) }), 'Verbunden');
              if (r) (setKey(''), setUrl(null), s.reload());
            }}
          >
            Speichern & testen
          </button>{' '}
          {v.key_set && (v.connected ? <Badge tone="green">verbunden</Badge> : <Badge tone="red">{v.error || 'nicht erreichbar'}</Badge>)}
        </p>
      </div>
      {v.connected && (
        <div className="card" style={{ flex: '2 1 480px' }}>
          <h2>Kanäle → Projekte</h2>
          <p className="muted small">Ein Kanal kann mehreren Projekten dienen (z. B. dein X-Account für die Agentur und ein Produkt). Verbindet ein Kunde selbst einen Kanal, wird er automatisch zugeordnet.</p>
          {v.channels.length ? (
            <table className="t">
              <tbody>
                {v.channels.map((c: any) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.name}</strong> <span className="muted small">{c.identifier}{c.profile ? ` · ${c.profile}` : ''}</span>
                      {!c.supported && <div className="muted small">Planen nur in Postiz (Video/Newsletter)</div>}
                    </td>
                    <td style={{ width: 280 }}>
                      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                        {(c.location_ids ?? []).map((id: string) => (
                          <span key={id} className="social-chip" style={{ padding: '2px 8px' }}>
                            {locs.data!.find((l: any) => l.id === id)?.name ?? id}
                            <button
                              className="btn small ghost"
                              style={{ padding: '0 4px' }}
                              aria-label="Zuordnung entfernen"
                              onClick={async () => (await act(() => api.put(`/api/agency/social/channels/${c.id}`, { location_ids: c.location_ids.filter((x: string) => x !== id) }), 'Entfernt')) && s.reload()}
                            >
                              ✕
                            </button>
                          </span>
                        ))}
                      </div>
                      <Select
                        value=""
                        placeholder="+ Projekt zuordnen"
                        onChange={async (loc) => {
                          if (loc && (await act(() => api.put(`/api/agency/social/channels/${c.id}`, { location_ids: [...(c.location_ids ?? []), loc] }), 'Zugeordnet'))) s.reload();
                        }}
                        options={locs.data!.filter((l: any) => !(c.location_ids ?? []).includes(l.id)).map((l: any) => [l.id, l.name])}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>In Postiz sind noch keine Kanäle verbunden.</Empty>
          )}
        </div>
      )}
    </div>
  );
}

export function Agency({ tab = 'projects' }: { tab?: string }) {
  const cloud = !!useAppInfo()?.cloud?.enabled;
  return (
    <>
      <PageHead title="Agentur" sub="Alle Projekte und Kunden, Vorlagen, Domains, White-Label, API und Protokoll an einem Ort">
        <LearnLink label="learn" />
      </PageHead>
      {tab === 'projects' && <AcademyWelcome />}
      <AgencyTabs
        tabs={[
          ['projects', 'Projekte'],
          ['contacts', 'Kontakte'],
          ['deals', 'Deals'],
          ['tasks', 'Aufgaben'],
          ['docs', 'Dokumente'],
          ['clients', 'Kunden'],
          ['saas', 'SaaS'],
          ...(cloud ? ([['cloud', 'Cloud']] as [string, string][]) : []),
          ['snapshots', 'Snapshots'],
          ['umzug', 'Umzug'],
          ['domains', 'Domains'],
          ['branding', 'White-Label'],
          ['login', 'Anmeldung'],
          ['integrations', 'Integrationen'],
          ['partner-links', 'Partner-Links'],
          ['api', 'API & MCP'],
          ['mcp-servers', 'MCP-Server'],
          ['ai-tools', 'KI-Werkzeuge'],
          ['ai-providers', 'KI-Anbieter (BYOK)'],
          ['feedback', 'Fehler & Wünsche'],
          ['audit', 'Protokoll'],
          ['system', 'System'],
        ]}
        value={tab}
        onChange={(t) => navigate(`agency/${t}`)}
      />
      <PageSuspense key={tab}>
      {tab === 'projects' && <ProjectsOverview />}
      {tab === 'contacts' && <AllContacts />}
      {tab === 'deals' && <AllDeals />}
      {tab === 'tasks' && <AllTasks />}
      {tab === 'docs' && <AgencyDocs />}
      {tab === 'clients' && (
        <>
          <Clients />
          <Slot name="agency.clients" />
        </>
      )}
      {tab === 'saas' && <SaasAdmin />}
      {tab === 'cloud' && cloud && <CloudConsole />}
      {tab === 'snapshots' && <Snapshots />}
      {tab === 'umzug' && <UmzugAssistent embedded />}
      {tab === 'domains' && <Domains />}
      {tab === 'branding' && (
        <>
          <BrandingSettings />
          <Slot name="agency.branding" />
        </>
      )}
      {tab === 'login' && <LoginSettings />}
      {tab === 'integrations' && (
        <AgencyIntegrationsHub>
          <Integrations />
          <OAuthApps />
          <MailAccounts />
          <MailboxAgencyCard />
          <SupabaseMirror />
          <TodoistSync />
          <OpenShortsSetup />
          <ComposioAgencySetup />
          <NangoAgencySetup />
          <CogneeAgencySetup />
        </AgencyIntegrationsHub>
      )}
      {tab === 'partner-links' && <PartnerLinks />}
      {tab === 'api' && <ApiAndMcp />}
      {tab === 'mcp-servers' && <McpServers agency />}
      {tab === 'ai-tools' && <AiTools agency />}
      {tab === 'ai-providers' && <AiConnections agency />}
      {tab === 'feedback' && <AgencyFeedback />}
      {tab === 'audit' && <AuditLog />}
      {tab === 'system' && (
        <>
          <SystemHealth />
          <Slot name="agency.system" />
        </>
      )}
      </PageSuspense>
    </>
  );
}
