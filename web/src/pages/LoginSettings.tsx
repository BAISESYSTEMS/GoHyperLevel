import { useEffect, useState } from 'react';
import { api, d } from '../api';
import { ProviderIcon } from '../provider-icon';
import { Badge, Check, Copy, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, toast, useLoad } from '../ui';
import { PermissionPicker } from './PermissionPicker';
import { SignupLink } from '../referrals';
import { MoreFields, ProOnly } from '../areas/fields';

/**
 * Agentur → Anmeldung: which sign-in methods exist (password, passkeys, e-mail link, Google, Microsoft,
 * GitHub, Apple, OpenID Connect), who gets an account on first login, 2FA duty for admins, session
 * lifetime and what each client's own login domain shows. Secrets are only ever sent, never shown.
 */

const MASK = '••••••';

/** Presets for common identity providers: issuer hint and the claim that carries groups. */
const PRESETS: Record<string, { label: string; issuer: string; groups: string; scopes: string; hint: string; trust?: boolean }> = {
  keycloak: { label: 'Keycloak', issuer: 'https://sso.example.com/realms/<realm>', groups: 'groups', scopes: 'openid email profile', hint: 'Client-Typ „OpenID Connect“, Client authentication an; Gruppen über den Mapper „Group Membership“ (Token-Claim „groups“, ohne vollen Pfad).' },
  authentik: { label: 'Authentik', issuer: 'https://auth.example.com/application/o/<slug>/', groups: 'groups', scopes: 'openid email profile', hint: 'Provider „OAuth2/OpenID“, Typ vertraulich; Gruppen stehen standardmäßig im Claim „groups“.' },
  authelia: { label: 'Authelia', issuer: 'https://auth.example.com', groups: 'groups', scopes: 'openid email profile groups', hint: 'In identity_providers.oidc.clients eintragen, Scope „groups“ erlauben, require_pkce: true.' },
  zitadel: { label: 'Zitadel', issuer: 'https://<instanz>.zitadel.cloud', groups: 'urn:zitadel:iam:org:project:roles', scopes: 'openid email profile urn:zitadel:iam:org:project:roles', hint: 'Web-App mit „Code“ + PKCE; Projekt-Rollen im ID-Token aktivieren („Assert Roles on Authentication“).' },
  okta: { label: 'Okta', issuer: 'https://<org>.okta.com/oauth2/default', groups: 'groups', scopes: 'openid email profile groups', hint: 'App-Integration „OIDC – Web Application“; im Authorization Server einen Claim „groups“ anlegen.' },
  azure: { label: 'Microsoft Entra ID (Azure AD)', issuer: 'https://login.microsoftonline.com/<mandanten-id>/v2.0', groups: 'groups', scopes: 'openid email profile', hint: 'Eine App-Registrierung nur für deinen Mandanten. Token-Konfiguration: optionale Claims „email“ und Gruppen-Claim (IDs). Entra liefert kein email_verified – daher „E-Mail vertrauen“.', trust: true },
  google: { label: 'Google Workspace', issuer: 'https://accounts.google.com', groups: '', scopes: 'openid email profile', hint: 'OAuth-Client „Webanwendung“ in der Google Cloud. Unbedingt erlaubte Domains eintragen – sonst käme jedes Google-Konto durch.' },
  generic: { label: 'Anderer OIDC-Anbieter', issuer: 'https://idp.example.com', groups: 'groups', scopes: 'openid email profile', hint: 'Jeder Anbieter mit OpenID Connect Discovery (/.well-known/openid-configuration).' },
};

const emptyProvider = (preset = 'keycloak') => ({
  name: '',
  slug: '',
  preset,
  issuer: '',
  client_id: '',
  client_secret: '',
  scopes: PRESETS[preset].scopes,
  location_id: '',
  enabled: true,
  config: { claims: { email: 'email', name: 'name', groups: PRESETS[preset].groups }, trust_email: !!PRESETS[preset].trust, use_userinfo: false, jit: true, default_role: 'member', default_locations: [] as string[], default_permissions: null as string[] | null, group_rules: [] as any[], require_group: false, sync_roles: false, enforce_domains: [] as string[], allowed_domains: [] as string[], skip_2fa: true },
});

const csv = (v: string[] | undefined) => (v ?? []).join(', ');
const list = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

function LocationPicks({ value, onChange, locations }: { value: string[]; onChange: (v: string[]) => void; locations: any[] }) {
  return (
    <div className="check-list">
      {locations.map((l) => (
        <Check key={l.id} checked={value.includes(l.id)} onChange={(on) => onChange(on ? [...value, l.id] : value.filter((x) => x !== l.id))} label={l.name} />
      ))}
    </div>
  );
}

function ProviderModal({ initial, locations, base, onClose, onSaved }: { initial: any; locations: any[]; base: string[]; onClose: () => void; onSaved: () => void }) {
  const [p, setP] = useState<any>({ ...initial, client_secret: '' });
  const [domains, setDomains] = useState({ enforce: csv(initial.config.enforce_domains), allowed: csv(initial.config.allowed_domains) });
  const c = p.config;
  const set = (patch: any) => setP({ ...p, ...patch });
  const setC = (patch: any) => setP({ ...p, config: { ...c, ...patch } });
  const preset = PRESETS[p.preset] ?? PRESETS.generic;
  const client = !!p.location_id;
  const save = async () => {
    const body = { ...p, location_id: p.location_id || null, config: { ...c, enforce_domains: list(domains.enforce), allowed_domains: list(domains.allowed) } };
    if (!body.client_secret) delete body.client_secret;
    const r = await act(() => (p.id ? api.patch(`/api/agency/sso/${p.id}`, body) : api.post('/api/agency/sso', body)), 'SSO-Anbieter gespeichert');
    if (r) onSaved();
  };
  return (
    <Modal title={p.id ? `SSO: ${p.name}` : 'Neuer SSO-Anbieter'} onClose={onClose} wide footer={<button className="btn" onClick={save}>Speichern</button>}>
      <div className="grid2">
        <Field label="Vorlage">
          <Select
            value={p.preset}
            onChange={(v) => setP({ ...p, preset: v, scopes: PRESETS[v].scopes, config: { ...c, claims: { ...c.claims, groups: PRESETS[v].groups }, trust_email: !!PRESETS[v].trust } })}
            options={Object.entries(PRESETS).map(([k, x]) => [k, x.label])}
          />
        </Field>
        <Field label="Für">
          <Select value={p.location_id} onChange={(v) => setP({ ...p, location_id: v, config: { ...c, default_role: v ? 'member' : c.default_role } })} options={[['', 'Agentur (alle Logins)'], ...locations.map((l) => [l.id, `Kunde: ${l.name}`] as [string, string])]} />
        </Field>
        <Field label="Name auf dem Button">
          <Input value={p.name} onChange={(v) => set({ name: v, slug: p.id ? p.slug : v.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) })} placeholder="Firmen-Login" />
        </Field>
        <Field label="Kurzname (Adresse)" hint={`Weiterleitungs-URI: ${base[0]}/auth/sso/${p.slug || '…'}/callback`}>
          <Input value={p.slug} onChange={(v) => set({ slug: v })} />
        </Field>
      </div>
      <p className="muted small">{preset.hint}</p>
      <Field label="Issuer- oder Discovery-URL">
        <Input value={p.issuer} onChange={(v) => set({ issuer: v })} placeholder={preset.issuer} />
      </Field>
      <div className="grid2">
        <Field label="Client-ID">
          <Input value={p.client_id} onChange={(v) => set({ client_id: v })} />
        </Field>
        <Field label="Client-Secret" hint="leer = öffentlicher Client (nur PKCE)">
          <Input type="password" value={p.client_secret} onChange={(v) => set({ client_secret: v })} placeholder={initial.client_secret ? '•••••• (gespeichert)' : ''} autoComplete="off" />
        </Field>
      </div>
      <Check checked={p.enabled} onChange={(v) => set({ enabled: v })} label="Aktiv" />
      <MoreFields id="login-sso-advanced" values={[domains.enforce, domains.allowed, c.group_rules, c.require_group, c.skip_2fa, c.sync_roles, c.use_userinfo, c.trust_email]}>
      <div className="grid2">
        <Field label="Scopes">
          <Input value={p.scopes} onChange={(v) => set({ scopes: v })} />
        </Field>
        <Field label="Claims: E-Mail · Name · Gruppen">
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <Input value={c.claims.email} onChange={(v) => setC({ claims: { ...c.claims, email: v } })} aria-label="E-Mail-Claim" />
            <Input value={c.claims.name} onChange={(v) => setC({ claims: { ...c.claims, name: v } })} aria-label="Name-Claim" />
            <Input value={c.claims.groups} onChange={(v) => setC({ claims: { ...c.claims, groups: v } })} aria-label="Gruppen-Claim" placeholder="groups" />
          </div>
        </Field>
      </div>
      <div className="grid2">
        <Check checked={c.jit} onChange={(v) => setC({ jit: v })} label="Konten beim ersten Login anlegen (JIT)" />
        <Check checked={c.trust_email} onChange={(v) => setC({ trust_email: v })} label="E-Mail-Adressen vertrauen (ohne email_verified)" />
        <Check checked={c.use_userinfo} onChange={(v) => setC({ use_userinfo: v })} label="Userinfo-Endpunkt zusätzlich abfragen" />
        <Check checked={c.skip_2fa} onChange={(v) => setC({ skip_2fa: v })} label="Anbieter prüft MFA (hier kein zweiter Faktor)" />
        <Check checked={c.sync_roles} onChange={(v) => setC({ sync_roles: v })} label="Rolle & Sub-Accounts bei jedem Login aus Gruppen übernehmen" />
        <Check checked={c.require_group} onChange={(v) => setC({ require_group: v })} label="Nur Mitglieder zugeordneter Gruppen" />
      </div>
      <div className="grid2" style={{ marginTop: 8 }}>
        <Field label="SSO erzwingen für Domains" hint="Diese Adressen können sich nur noch hierüber anmelden (kein Passwort, kein Link, kein Passkey).">
          <Input value={domains.enforce} onChange={(v) => setDomains({ ...domains, enforce: v })} placeholder="firma.de" />
        </Field>
        <Field label="Erlaubte Domains" hint="leer = jede bestätigte Adresse des Anbieters">
          <Input value={domains.allowed} onChange={(v) => setDomains({ ...domains, allowed: v })} placeholder="firma.de, firma.at" />
        </Field>
      </div>
      <h3>Neue Konten</h3>
      <div className="grid2">
        <Field label="Rolle">
          <Select value={client ? 'member' : c.default_role} onChange={(v) => setC({ default_role: v })} options={client ? [['member', 'Kunden-Login']] : [['member', 'Mitglied (Rechte unten)'], ['admin', 'Agentur-Admin']]} />
        </Field>
        <div />
        {!client && (
          <Field label="Sub-Accounts">
            <LocationPicks value={c.default_locations} onChange={(v) => setC({ default_locations: v })} locations={locations} />
          </Field>
        )}
        <Field label="Bereiche">
          <PermissionPicker value={c.default_permissions} onChange={(v) => setC({ default_permissions: v })} />
        </Field>
      </div>
      <h3>Gruppen → Rolle & Sub-Accounts</h3>
      {c.group_rules.map((r: any, i: number) => {
        const upd = (patch: any) => setC({ group_rules: c.group_rules.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
        return (
          <div key={i} className="card login-rule">
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <Field label="Gruppe">
                <Input value={r.group} onChange={(v) => upd({ group: v })} placeholder="crm-admins" />
              </Field>
              <Field label="Rolle">
                <Select value={r.role ?? ''} onChange={(v) => upd({ role: v || undefined })} options={[['', '–'], ['member', 'Mitglied'], ...(client ? [] : [['admin', 'Agentur-Admin'] as [string, string]])]} />
              </Field>
              <button className="btn small ghost" style={{ marginBottom: 12 }} aria-label="Regel entfernen" onClick={() => setC({ group_rules: c.group_rules.filter((_: any, j: number) => j !== i) })}>
                ✕
              </button>
            </div>
            {!client && <LocationPicks value={r.locations ?? []} onChange={(v) => upd({ locations: v })} locations={locations} />}
          </div>
        );
      })}
      <button className="btn small secondary" onClick={() => setC({ group_rules: [...c.group_rules, { group: '', locations: [] }] })}>
        + Regel
      </button>
      </MoreFields>
    </Modal>
  );
}

export function LoginSettings() {
  const data = useLoad(() => api.get<any>('/api/agency/login'), []);
  const sso = useLoad(() => api.get<any>('/api/agency/sso'), []);
  const locs = useLoad(() => api.get<any[]>('/api/locations'), []);
  const [p, setP] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [invite, setInvite] = useState({ email: '', locations: [] as string[], send: true });
  const [domains, setDomains] = useState('');
  useEffect(() => {
    if (data.data) {
      const copy = JSON.parse(JSON.stringify(data.data));
      // Stored secrets stay on the server: empty field + "gespeichert" hint; empty means "keep".
      copy.social.github.client_secret = '';
      copy.social.apple.private_key = '';
      setP(copy);
      setDomains(csv(data.data.signup.domains));
    }
  }, [data.data]);
  if (!p || !sso.data || !locs.data) return <Spinner />;
  const locations = locs.data;
  const providers: any[] = sso.data.providers;
  const allProviders = [...(['google', 'microsoft', 'github', 'apple'] as const).filter((k) => data.data.ready[k]).map((k) => ({ id: k, label: { google: 'Google', microsoft: 'Microsoft', github: 'GitHub', apple: 'Apple' }[k] })), ...providers.filter((x) => !x.location_id).map((x) => ({ id: `oidc:${x.id}`, label: x.name }))];
  const set = (patch: any) => setP({ ...p, ...patch });
  const setSocial = (k: string, patch: any) => setP({ ...p, social: { ...p.social, [k]: { ...p.social[k], ...patch } } });
  const save = async () => {
    const body = { ...p, signup: { ...p.signup, domains: list(domains) } };
    for (const k of ['github', 'apple'])
      for (const f of ['client_secret', 'private_key'])
        if (body.social[k][f] === MASK) delete body.social[k][f];
    delete body.invites;
    const r = await act(() => api.put('/api/agency/login', body), 'Anmelde-Einstellungen gespeichert');
    if (r) data.setData(r);
  };
  const uris = (k: string) => (
    <div className="small muted">
      Weiterleitungs-URI:{' '}
      {p.social[k].redirect_uris.map((u: string) => (
        <span key={u} className="login-uri">
          <code>{u}</code> <Copy text={u} />
        </span>
      ))}
    </div>
  );
  const status = (k: string) => (data.data.ready[k] ? <Badge tone="green">bereit</Badge> : p.social[k].enabled ? <Badge tone="yellow">Angaben fehlen</Badge> : <Badge>aus</Badge>);

  return (
    <div className="login-settings">
      {data.data.break_glass && (
        <div className="card" style={{ borderColor: 'var(--red)', marginBottom: 12 }}>
          <strong>Notfall-Zugang aktiv:</strong> PGHL_AUTH_BREAK_GLASS=1 – Admins dürfen sich trotz SSO-Pflicht mit Passwort anmelden. Nach der Reparatur wieder entfernen.
        </div>
      )}
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="card" style={{ flex: '1 1 340px' }} data-tour="login-methods">
          <h2>Anmeldearten</h2>
          <Check checked={p.password} onChange={(v) => set({ password: v })} label="E-Mail + Passwort" />
          <Check checked={p.passkey} onChange={(v) => set({ passkey: v })} label="Passkeys (Fingerabdruck, Gesicht, Geräte-PIN)" />
          <Check checked={p.magic_link} onChange={(v) => set({ magic_link: v })} label="Link per E-Mail (15 Minuten, einmal nutzbar)" />
          <hr />
          <Check checked={p.require_2fa_admins} onChange={(v) => set({ require_2fa_admins: v })} label="Admins brauchen einen zweiten Faktor (Passkey oder Authenticator)" />
          <MoreFields id="login-methods" values={[p.link_by_email, p.mail_location_id]}>
          <Check checked={p.link_by_email} onChange={(v) => set({ link_by_email: v })} label="Social-Login mit bestehenden Kunden-Logins gleicher E-Mail verbinden" />
          <div className="grid2" style={{ marginTop: 8 }}>
            <Field label="Angemeldet bleiben (Tage)">
              <Input type="number" min={1} max={365} value={p.session_days} onChange={(v) => set({ session_days: Number(v) })} />
            </Field>
            <Field label="E-Mail-Links senden über">
              <Select value={p.mail_location_id} onChange={(v) => set({ mail_location_id: v })} options={[['', 'automatisch'], ...locations.map((l) => [l.id, l.name] as [string, string])]} />
            </Field>
          </div>
          </MoreFields>
        </div>

        <div className="card" style={{ flex: '2 1 460px' }} data-tour="login-social">
          <h2>Anmelden mit Google, Microsoft, GitHub, Apple</h2>
          <div className="login-social">
            <div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Check checked={p.social.google.enabled} onChange={(v) => setSocial('google', { enabled: v })} label={<><ProviderIcon icon="google" size={16} /> Google</>} />
                {status('google')}
              </div>
              <p className="muted small">Nutzt die Google-App unter Integrationen {p.social.google.oauth_configured ? '(eingerichtet)' : '(fehlt noch)'} – dort die URI zusätzlich eintragen.</p>
              {uris('google')}
            </div>
            <div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Check checked={p.social.microsoft.enabled} onChange={(v) => setSocial('microsoft', { enabled: v })} label={<><ProviderIcon icon="microsoft" size={16} /> Microsoft</>} />
                {status('microsoft')}
              </div>
              <p className="muted small">Microsoft-App unter Integrationen {p.social.microsoft.oauth_configured ? `(Mandant ${p.social.microsoft.tenant})` : '(fehlt noch)'}. Geschäftskonten werden nur mit bestätigter Domain per E-Mail verknüpft.</p>
              {uris('microsoft')}
            </div>
            <div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Check checked={p.social.github.enabled} onChange={(v) => setSocial('github', { enabled: v })} label={<><ProviderIcon icon="github" size={16} /> GitHub</>} />
                <SignupLink id="github" />
                {status('github')}
              </div>
              {p.social.github.enabled && (
                <div className="grid2">
                  <Field label="Client-ID">
                    <Input value={p.social.github.client_id} onChange={(v) => setSocial('github', { client_id: v })} />
                  </Field>
                  <Field label="Client-Secret">
                    <Input type="password" value={p.social.github.client_secret} onChange={(v) => setSocial('github', { client_secret: v })} autoComplete="off" placeholder={data.data.social.github.client_secret ? '•••••• (gespeichert)' : ''} />
                  </Field>
                </div>
              )}
              {uris('github')}
            </div>
            <div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Check checked={p.social.apple.enabled} onChange={(v) => setSocial('apple', { enabled: v })} label={<><ProviderIcon icon="apple" size={16} /> Apple</>} />
                {status('apple')}
              </div>
              {p.social.apple.enabled && (
                <>
                  <div className="grid2">
                    <Field label="Services-ID">
                      <Input value={p.social.apple.client_id} onChange={(v) => setSocial('apple', { client_id: v })} placeholder="com.firma.login" />
                    </Field>
                    <Field label="Team-ID">
                      <Input value={p.social.apple.team_id} onChange={(v) => setSocial('apple', { team_id: v })} />
                    </Field>
                    <Field label="Key-ID">
                      <Input value={p.social.apple.key_id} onChange={(v) => setSocial('apple', { key_id: v })} />
                    </Field>
                  </div>
                  <Field label="Schlüssel (.p8-Datei)">
                    <Textarea value={p.social.apple.private_key} onChange={(v) => setSocial('apple', { private_key: v })} rows={3} placeholder={data.data.social.apple.private_key ? '•••••• gespeichert – zum Ersetzen neuen Schlüssel einfügen' : '-----BEGIN PRIVATE KEY-----'} /> {/* oss-check: allow */}
                  </Field>
                </>
              )}
              {uris('apple')}
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }} data-tour="login-oidc">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Single Sign-on (OpenID Connect)</h2>
          <button className="btn" onClick={() => setEdit(emptyProvider())}>
            + SSO-Anbieter
          </button>
        </div>
        <p className="muted small">
          Keycloak, Authentik, Authelia, Zitadel, Okta, Entra ID, Google Workspace … – auch je Kunde für dessen eigene Login-Domain.
          <ProOnly> SAML-Anbieter über einen OIDC-Broker (z. B. Keycloak oder Authentik) anbinden.</ProOnly>
        </p>
        {providers.length > 0 && (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Anbieter</th>
                  <th>Für</th>
                  <th>SSO-Pflicht</th>
                  <th>Logins</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {providers.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <strong>{x.name}</strong> {x.enabled ? <Badge tone="green">aktiv</Badge> : <Badge>aus</Badge>}
                      <div className="muted small">{x.issuer}</div>
                    </td>
                    <td>{x.location_id ? locations.find((l) => l.id === x.location_id)?.name ?? 'Kunde' : 'Agentur'}</td>
                    <td className="small">{x.config.enforce_domains.length ? x.config.enforce_domains.map((dm: string) => `@${dm}`).join(', ') : '–'}</td>
                    <td>{x.users}</td>
                    <td className="actions">
                      <button
                        className="btn small secondary"
                        onClick={async () => {
                          const r = await act(() => api.post(`/api/agency/sso/${x.id}/test`));
                          if (r) r.ok ? toast(`Verbindung ok: ${r.keys} Schlüssel${r.pkce === false ? ' (ohne PKCE-Angabe)' : ''}`) : toast(`Fehler: ${r.error}`);
                        }}
                      >
                        Testen
                      </button>
                      <button className="btn small secondary" onClick={() => setEdit(JSON.parse(JSON.stringify(x)))}>
                        Bearbeiten
                      </button>
                      <button className="btn small ghost" onClick={async () => confirmAsk(`„${x.name}“ löschen? Verknüpfte Logins melden sich danach anders an.`) && (await act(() => api.del(`/api/agency/sso/${x.id}`), 'Gelöscht')) && sso.reload()}>
                        Löschen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="row" style={{ alignItems: 'flex-start', marginTop: 12 }}>
        <div className="card" style={{ flex: '1 1 380px' }} data-tour="login-signup">
          <h2>Neue Konten beim ersten Login</h2>
          <p className="muted small">Gilt für Google & Co. und E-Mail-Links. SSO-Anbieter haben ihre eigene Einstellung (JIT).</p>
          <Field label="Registrierung">
            <Select value={p.signup.mode} onChange={(v) => set({ signup: { ...p.signup, mode: v } })} options={[['closed', 'Geschlossen – nur bestehende Logins'], ['invite', 'Nur mit Einladung'], ['domains', 'Erlaubte E-Mail-Domains']]} />
          </Field>
          {p.signup.mode === 'domains' && (
            <Field label="Domains" hint="Bestätigte Adressen dieser Domains bekommen ein Kunden-Login.">
              <Input value={domains} onChange={setDomains} placeholder="firma.de" />
            </Field>
          )}
          {p.signup.mode !== 'closed' && (
            <>
              <Field label="Sub-Accounts für neue Konten">
                <LocationPicks value={p.signup.locations} onChange={(v) => set({ signup: { ...p.signup, locations: v } })} locations={locations} />
              </Field>
              <Field label="Bereiche">
                <PermissionPicker value={p.signup.permissions} onChange={(v) => set({ signup: { ...p.signup, permissions: v } })} />
              </Field>
            </>
          )}
          {p.signup.mode === 'invite' && (
            <>
              <h3>Einladungen</h3>
              {data.data.invites.map((i: any) => (
                <div key={i.email} className="signin-row">
                  <span style={{ flex: 1 }}>
                    {i.email} <span className="muted small">bis {d(i.expires_at)}</span>
                  </span>
                  <button className="btn small ghost" onClick={async () => (await act(() => api.del(`/api/agency/login/invites/${encodeURIComponent(i.email)}`), 'Entfernt')) && data.reload()}>
                    Entfernen
                  </button>
                </div>
              ))}
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <Field label="E-Mail">
                  <Input type="email" value={invite.email} onChange={(v) => setInvite({ ...invite, email: v })} />
                </Field>
                <Check checked={invite.send} onChange={(v) => setInvite({ ...invite, send: v })} label="Link per E-Mail senden" />
                <button
                  className="btn secondary"
                  style={{ marginBottom: 12 }}
                  onClick={async () => {
                    const r = await act(() => api.post('/api/agency/login/invites', { ...invite, locations: invite.locations.length ? invite.locations : p.signup.locations, permissions: p.signup.permissions }), 'Eingeladen');
                    if (r) (setInvite({ ...invite, email: '' }), data.reload());
                  }}
                >
                  Einladen
                </button>
              </div>
            </>
          )}
        </div>

        <div className="card" style={{ flex: '1 1 420px' }} data-tour="login-clients">
          <h2>Kunden-Logins</h2>
          <p className="muted small">Was die Login-Seite auf der eigenen Domain eines Kunden zeigt (Agentur → Kunden → Branding). Der eigene SSO-Anbieter eines Kunden erscheint dort immer.</p>
          {locations.map((l) => {
            const cfg = p.clients[l.id];
            const upd = (patch: any) => setP({ ...p, clients: { ...p.clients, [l.id]: { password: true, magic_link: true, passkey: true, providers: null, ...cfg, ...patch } } });
            return (
              <details key={l.id} className="login-client">
                <summary>
                  <strong>{l.name}</strong> {cfg ? <Badge tone="blue">eigene Auswahl</Badge> : <span className="muted small">wie Agentur</span>}
                </summary>
                <div className="grid2">
                  <Check checked={cfg?.password ?? true} onChange={(v) => upd({ password: v })} label="Passwort" />
                  <Check checked={cfg?.passkey ?? true} onChange={(v) => upd({ passkey: v })} label="Passkey" />
                  <Check checked={cfg?.magic_link ?? true} onChange={(v) => upd({ magic_link: v })} label="E-Mail-Link" />
                  <Check checked={!cfg?.providers} onChange={(v) => upd({ providers: v ? null : [] })} label="Alle Anbieter wie die Agentur" />
                </div>
                {cfg?.providers && (
                  <div className="check-list">
                    {allProviders.map((x) => (
                      <Check key={x.id} checked={cfg.providers.includes(x.id)} onChange={(on) => upd({ providers: on ? [...cfg.providers, x.id] : cfg.providers.filter((y: string) => y !== x.id) })} label={x.label} />
                    ))}
                  </div>
                )}
                {cfg && (
                  <button className="btn small ghost" onClick={() => setP({ ...p, clients: { ...p.clients, [l.id]: null } })}>
                    Zurücksetzen
                  </button>
                )}
              </details>
            );
          })}
        </div>
      </div>

      <p style={{ marginTop: 12 }}>
        <button className="btn" onClick={save} data-tour="login-save">
          Speichern
        </button>
      </p>

      {edit && (
        <ProviderModal
          initial={edit}
          locations={locations}
          base={sso.data.callback_base}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            sso.reload();
          }}
        />
      )}
    </div>
  );
}
