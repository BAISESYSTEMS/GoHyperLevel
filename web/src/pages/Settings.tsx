import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { api, dt } from '../api';
import { useSession } from '../session';
import { PermissionPicker } from './PermissionPicker';
import { AiSettings } from './AiAssistant';
import { MetaSettings } from './MetaChannels';
import { MoreChannelSettings } from './ChannelSettings';
import { EMAIL_PROVIDER_OPTIONS, ProviderPanel, SMS_PROVIDER_OPTIONS, isApiProvider } from './ChannelProviders';
import { IosAppCard } from '../ios/IosAppCard';
import { PushSettings } from './PushSettings';
import { AppDevices } from './MobileApp';
import { StripeSettings } from './Stripe';
import { Slot } from '../slots';
import { TelephonySettings } from './Calls';
import { BrowserPhoneSettings } from './Phone';
import { VoiceAiSettings } from './VoiceAi';
import { GoogleReviewSettings } from './GoogleReviews';
import { GoogleBusinessSettings } from './GoogleBusiness';
import { CalendarConnections } from './OAuthConnect';
import { SignInMethods } from './SignInMethods';
import { Badge, Check, CodeBox, Empty, Field, Input, Link, Modal, PageHead, Select, Spinner, Textarea, act, confirmAsk, navigate, toast, useLoad } from '../ui';
import { LearnLink } from '../tour/learn';
import { SubscriptionSettings } from './SaasBilling';
import { InvoiceSettings } from './InvoiceSettings';
import { useAppInfo } from '../demo';
import { HelpdeskSettings } from './HelpdeskSettings';
import { RestHooksPanel } from './RestHooks';
import { HubSpotImport } from './HubSpotImport';
import { AiTools } from './AiTools';
import { AiConnections } from './AiConnections';
import { SignupLink } from '../referrals';
import { TagSettings } from './TagMeta';
import { QrButton } from '../QrCode';
import { MailboxSettings, MailboxTransportPanel } from './Mailboxes';
import { Appearance } from '../theme/Appearance';
import { PageSuspense, lazyPages } from '../lazy';
import { UmzugPointer } from './UmzugPointer';
import { fmtDateTime, tr, useT } from '../i18n';
import { LanguageField } from '../i18n/LanguageMenu';
import { MoreFields, ProOnly, SimpleOnly } from '../areas/fields';
import { SettingsTabs } from '../areas/SettingsTabs';
import { SetupChecklist } from '../areas/SetupChecklist';
import { FieldCleanup } from './FieldCleanup';

const { VoiceSettingsPage } = lazyPages(() => import('./Voice'), 'VoiceSettingsPage');
const { UmzugAssistent } = lazyPages(() => import('./UmzugAssistent'), 'UmzugAssistent');
const { UmzugZustellung } = lazyPages(() => import('./UmzugZustellung'), 'UmzugZustellung');
const { TeamInboxSettings } = lazyPages(() => import('./TeamInboxSettings'), 'TeamInboxSettings');
const { CogneeSettings } = lazyPages(() => import('./CogneeSettings'), 'CogneeSettings');
const { ConsentSettings } = lazyPages(() => import('./Consent'), 'ConsentSettings');
const { CloudAccount } = lazyPages(() => import('./Cloud'), 'CloudAccount');
const { CustomValuesSettings } = lazyPages(() => import('./CustomValues'), 'CustomValuesSettings');

function useLocationSettings() {
  const loc = useLoad(() => api.get('/api/location'), []);
  const save = async (patch: any) => {
    const r = await act(() => api.patch('/api/location', patch), tr('settings')('Gespeichert'));
    if (r) loc.setData(r);
  };
  return { loc, save };
}

function Company() {
  const t = useT('settings');
  const { loc, save } = useLocationSettings();
  const session = useSession();
  const [l, setL] = useState<any>();
  useEffect(() => setL(loc.data), [loc.data]);
  if (!l) return <Spinner />;
  return (
    <div className="card" style={{ maxWidth: 720 }} data-tour="settings-company">
      <div className="grid2">
        <Field label={t('Firmenname')}>
          <Input value={l.name} onChange={(v) => setL({ ...l, name: v })} />
        </Field>
        <Field label={t('Zeitzone')}>
          <Input value={l.timezone} onChange={(v) => setL({ ...l, timezone: v })} />
        </Field>
        <Field label={t('E-Mail (bekommt Team-Benachrichtigungen)')}>
          <Input value={l.email} onChange={(v) => setL({ ...l, email: v })} />
        </Field>
        <Field label={t('Telefon')}>
          <Input value={l.phone} onChange={(v) => setL({ ...l, phone: v })} />
        </Field>
      </div>
      <Field label={t('Adresse (Impressum, Rechnungen, E-Mail-Fuß)')}>
        <Textarea value={l.address} onChange={(v) => setL({ ...l, address: v })} rows={3} />
      </Field>
      <MoreFields id="settings-company" values={[l.website, l.logo_url]}>
        <div className="grid2">
          <Field label={t('Webseite')}>
            <Input value={l.website} onChange={(v) => setL({ ...l, website: v })} />
          </Field>
          <Field label={t('Logo-URL')}>
            <Input value={l.logo_url} onChange={(v) => setL({ ...l, logo_url: v })} />
          </Field>
        </div>
      </MoreFields>
      <button className="btn" onClick={() => save({ name: l.name, timezone: l.timezone, email: l.email, phone: l.phone, website: l.website, logo_url: l.logo_url, address: l.address }).then(session.reload)}>
        {t('Speichern')}
      </button>
    </div>
  );
}

function EmailSms() {
  const t = useT('settings');
  const { loc, save } = useLocationSettings();
  const [s, setS] = useState<any>();
  const [to, setTo] = useState('');
  const inbound = useLoad(() => api.get('/api/settings/inbound'), []);
  useEffect(() => setS(loc.data?.settings), [loc.data]);
  if (!s) return <Spinner />;
  const e = s.email ?? { provider: 'log' };
  const m = s.sms ?? { provider: 'log' };
  const setE = (p: any) => setS({ ...s, email: { ...e, ...p } });
  const setM = (p: any) => setS({ ...s, sms: { ...m, ...p } });
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="card" style={{ flex: '1 1 380px' }} data-tour="settings-email">
        <h2><Icon name="email" size={18} /> {t('E-Mail-Versand')}</h2>
        <Field label={t('Anbieter')}>
          <Select value={e.provider} onChange={(v) => setE({ provider: v })} options={[['log', t('Nur speichern (Test, kein Versand)')], ['smtp', t('SMTP (eigenes Postfach)')], ['mailbox', t('Verbundenes Postfach (Gmail / Outlook)')], ...EMAIL_PROVIDER_OPTIONS]} />
        </Field>
        {e.provider === 'smtp' && (
          <>
            <p className="muted small">{t('Kostenlos mit deinem vorhandenen Postfach: Hostinger-Mail (smtp.hostinger.com:465), Gmail (smtp.gmail.com:587 + App-Passwort), Brevo-Gratis (300/Tag)…')}</p>
            <div className="grid2">
              <Field label={t('SMTP-Server')}>
                <Input value={e.host} onChange={(v) => setE({ host: v })} placeholder="smtp.hostinger.com" />
              </Field>
              <Field label={t('Absender-E-Mail')}>
                <Input value={e.fromEmail} onChange={(v) => setE({ fromEmail: v })} placeholder={t('= Benutzer')} />
              </Field>
              <Field label={t('Benutzer')}>
                <Input value={e.user} onChange={(v) => setE({ user: v })} autoComplete="off" />
              </Field>
              <Field label={t('Passwort')}>
                <Input type="password" value={e.pass} onChange={(v) => setE({ pass: v })} autoComplete="new-password" />
              </Field>
            </div>
            <MoreFields id="settings-smtp" values={[e.port, e.fromName, e.replyTo]}>
              <div className="grid2">
                <Field label={t('Port')} hint={t('leer = 587')}>
                  <Input value={e.port} onChange={(v) => setE({ port: v })} placeholder="465" />
                </Field>
                <Field label={t('Absendername')}>
                  <Input value={e.fromName} onChange={(v) => setE({ fromName: v })} />
                </Field>
              </div>
              <Field label={t('Antwort an (optional)')}>
                <Input value={e.replyTo} onChange={(v) => setE({ replyTo: v })} />
              </Field>
            </MoreFields>
          </>
        )}
        {e.provider === 'mailbox' && <MailboxTransportPanel value={e.mailbox_id ?? ''} onChange={(v) => setE({ mailbox_id: v })} />}
        {isApiProvider('mail', e.provider) && <ProviderPanel kind="mail" provider={e.provider} onSaved={(p) => setE(p)} />}
        <MoreFields id="settings-email-tracking" label={t('Öffnungen und Klicks messen')} values={[e.tracking === false, e.track_opens === false, e.track_business_opens === false]}>
          <Check checked={e.tracking !== false} onChange={(v) => setE({ tracking: v })} label={t('Öffnungen und Klicks messen (Zählpixel + Weiterleitungslinks)')} />
          {e.tracking !== false && (
            <>
              <Check checked={e.track_opens !== false} onChange={(v) => setE({ track_opens: v })} label={t('Öffnungen messen (Zählpixel einfügen)')} />
              {e.track_opens !== false && (
                <Check checked={e.track_business_opens !== false} onChange={(v) => setE({ track_business_opens: v })} label={t('Öffnungen bei Geschäftsmails messen')} />
              )}
              <p className="muted small">{t('Ohne Zählpixel bleiben Klicks messbar. Geschäftsmails: Rechnungen, Angebote, Mahnungen, Termin- und SEPA-Mails; Bot- und Proxy-Aufrufe zählen nie.')}</p>
            </>
          )}
        </MoreFields>
      </div>
      <div className="card" style={{ flex: '1 1 380px' }} data-tour="settings-sms">
        <h2><Icon name="sms" size={18} /> {t('SMS-Versand')}</h2>
        <Field label={t('Anbieter')}>
          <Select
            value={m.provider}
            onChange={(v) => setM({ provider: v })}
            options={[
              ['log', t('Nur speichern (Test, kein Versand)')],
              ['http', t('HTTP-Gateway (z. B. eigenes Android-Handy, gratis)')],
              ['twilio', t('Twilio (bezahlt pro SMS)')],
              ...SMS_PROVIDER_OPTIONS,
            ]}
          />
        </Field>
        {m.provider === 'http' && (
          <>
            <p className="muted small">
              {t('Gratis-Variante: App „SMS Gateway for Android“ (sms-gate.app) auf einem alten Handy – URL z. B. https://api.sms-gate.app/3rdparty/v1/message mit Benutzer/Passwort aus der App.')}
            </p>
            <Field label={t('URL')}>
              <Input value={m.url} onChange={(v) => setM({ url: v })} />
            </Field>
            <div className="grid2">
              <Field label={t('Benutzer (Basic Auth)')}>
                <Input value={m.user} onChange={(v) => setM({ user: v })} />
              </Field>
              <Field label={t('Passwort')}>
                <Input type="password" value={m.pass} onChange={(v) => setM({ pass: v })} />
              </Field>
            </div>
            <MoreFields id="settings-sms-http" values={[m.bodyTemplate]}>
              <Field label={t('JSON-Body ({{to}}, {{body}})')}>
                <Input className="mono" value={m.bodyTemplate} onChange={(v) => setM({ bodyTemplate: v })} placeholder='{"phoneNumbers":["{{to}}"],"message":"{{body}}"}' />
              </Field>
            </MoreFields>
          </>
        )}
        {m.provider === 'twilio' && (
          <>
            <SignupLink id="twilio" />
            <Field label={t('Account SID')}>
              <Input value={m.accountSid} onChange={(v) => setM({ accountSid: v })} />
            </Field>
            <Field label={t('Auth Token')}>
              <Input type="password" value={m.authToken} onChange={(v) => setM({ authToken: v })} />
            </Field>
            <Field label={t('Absender-Nummer')}>
              <Input value={m.from} onChange={(v) => setM({ from: v })} placeholder="+49…" />
            </Field>
          </>
        )}
        {isApiProvider('sms', m.provider) && <ProviderPanel kind="sms" provider={m.provider} onSaved={(p) => setM(p)} />}
      </div>
      <div className="card" style={{ flex: '1 1 100%' }}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <button className="btn" onClick={() => save({ settings: { email: s.email, sms: s.sms } })}>
            {t('Speichern')}
          </button>
          <div style={{ width: 240 }}>
            <Input value={to} onChange={setTo} placeholder={t('Test an E-Mail oder +49…')} aria-label={t('Test an E-Mail oder +49…')} />
          </div>
          <button className="btn secondary" disabled={!to} onClick={() => act(() => api.post('/api/settings/test-message', { to, channel: to.includes('@') ? 'email' : 'sms' })).then((r) => r && toast(r.status === 'logged' ? t('Nur gespeichert – Anbieter „Nur speichern“ aktiv') : t('Test gesendet ✓')))}>
            {t('Test senden')}
          </button>
        </div>
        <hr />
        <h2 data-tour="settings-inbound">{t('Eingehende Nachrichten')}</h2>
        <p className="muted">{t('Für Antworten per SMS-Gateway oder Mail-Weiterleitung (z. B. Cloudflare, ImprovMX) – sie landen in den Konversationen.')}</p>
        {inbound.data && (
          <MoreFields id="settings-inbound" label={t('Adressen anzeigen')}>
            <Field label={t('SMS-Webhook')}>
              <CodeBox text={inbound.data.sms} />
            </Field>
            <Field label={t('E-Mail-Webhook (JSON: from, subject, text)')}>
              <CodeBox text={inbound.data.email} />
            </Field>
          </MoreFields>
        )}
      </div>
    </div>
  );
}

function ReviewSettings() {
  const t = useT('settings');
  const { loc, save } = useLocationSettings();
  const [s, setS] = useState<any>();
  useEffect(() => setS(loc.data?.settings?.reviews ?? {}), [loc.data]);
  if (!s) return <Spinner />;
  return (
    <div className="card" style={{ maxWidth: 720 }} data-tour="review-settings">
      <Field label={t('Öffentliches Bewertungsprofil')} hint={t('Google: Unternehmensprofil → „Nach Rezensionen fragen“ → Link kopieren')}>
        <Input value={s.public_url} onChange={(v) => setS({ ...s, public_url: v })} placeholder="https://g.page/r/…/review" />
      </Field>
      {s.public_url && (
        <p style={{ marginTop: -4 }}>
          <QrButton url={s.public_url} title={t('Bewertungslink')} label={t('QR-Code zum Bewertungslink')} />
        </p>
      )}
      <Field label={t('Ab wie vielen Sternen weiterleiten?')}>
        <Select value={String(s.threshold ?? 4)} onChange={(v) => setS({ ...s, threshold: Number(v) })} options={['3', '4', '5']} />
      </Field>
      <MoreFields id="settings-reviews" label={t('Text der Anfrage')} values={[s.subject, s.message]}>
        <Field label={t('Betreff')}>
          <Input value={s.subject} onChange={(v) => setS({ ...s, subject: v })} placeholder={t('Wie war es bei {{location.name}}?')} />
        </Field>
        <Field label={t('Nachricht ({{review.url}} = Bewertungslink)')}>
          <Textarea value={s.message} onChange={(v) => setS({ ...s, message: v })} rows={6} placeholder={t('Hallo {{contact.first_name|du}}, …{{review.url}}')} />
        </Field>
      </MoreFields>
      <button className="btn" onClick={() => save({ settings: { reviews: s } })}>
        {t('Speichern')}
      </button>
    </div>
  );
}

function LiveChat() {
  const t = useT('settings');
  const { loc, save } = useLocationSettings();
  const info = useLoad(() => api.get<any>('/api/livechat'), []);
  const [s, setS] = useState<any>();
  useEffect(() => setS(loc.data?.settings?.chat ?? {}), [loc.data]);
  if (!s || !info.data) return <Spinner />;
  const d = info.data;
  return (
    <div className="card" style={{ maxWidth: 720 }} data-tour="settings-chat">
      <Check checked={s.enabled ?? false} onChange={(v) => setS({ ...s, enabled: v })} label={t('Live-Chat auf Websites anbieten')} />
      <Field label={t('Titel')}>
        <Input value={s.title ?? d.title} onChange={(v) => setS({ ...s, title: v })} />
      </Field>
      <Field label={t('Begrüßung')}>
        <Input value={s.greeting ?? d.greeting} onChange={(v) => setS({ ...s, greeting: v })} />
      </Field>
      <MoreFields id="settings-chat" values={[s.color, s.ask_email !== undefined && s.ask_email !== d.ask_email]}>
        <Field label={t('Farbe')}>
          <input type="color" value={s.color ?? d.color} onChange={(e) => setS({ ...s, color: e.target.value })} aria-label={t('Farbe')} />
        </Field>
        <Check checked={s.ask_email ?? d.ask_email} onChange={(v) => setS({ ...s, ask_email: v })} label={t('Vor der ersten Nachricht nach Name und E-Mail fragen')} />
      </MoreFields>
      <p>
        <button className="btn" onClick={() => save({ settings: { chat: s } })}>
          {t('Speichern')}
        </button>
      </p>
      <Field tour="settings-chat-embed" label={t('Einbau-Code für jede Website (vor </body>)')} hint={t('Bei eigenen Funnels reicht der Haken „Live-Chat anzeigen“ in den Funnel-Einstellungen. Nachrichten landen in Konversationen.')}>
        <CodeBox text={d.embed} />
      </Field>
    </div>
  );
}

function CustomFields() {
  const t = useT('settings');
  const list = useLoad(() => api.get<any[]>('/api/custom-fields'), []);
  const [f, setF] = useState({ label: '', type: 'text', options: '' });
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="card" style={{ flex: '2 1 420px' }} data-tour="settings-fields">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>{t('Eigene Felder')}</h2>
          <Link to="properties">{t('Alle Eigenschaften (Firmen, Deals, Objekte, Gruppen) →')}</Link>
        </div>
        <div className="row">
          <div className="grow">
            <Input value={f.label} onChange={(v) => setF({ ...f, label: v })} placeholder={t('z. B. Budget')} aria-label={t('Name des Felds')} />
          </div>
          <div style={{ width: 150 }}>
            <Select value={f.type} onChange={(v) => setF({ ...f, type: v })} aria={t('Feldtyp')} options={[['text', t('Text')], ['textarea', t('Mehrzeilig')], ['number', t('Zahl')], ['date', t('Datum')], ['select', t('Auswahl')], ['checkbox', t('Checkbox')], ['url', t('URL')]]} />
          </div>
          <button className="btn" aria-label={t('Feld anlegen')} disabled={!f.label} onClick={() => act(() => api.post('/api/custom-fields', { ...f, options: f.options.split(',').map((o) => o.trim()).filter(Boolean) })).then(() => (setF({ label: '', type: 'text', options: '' }), list.reload()))}>
            +
          </button>
        </div>
        {f.type === 'select' && <Input value={f.options} onChange={(v) => setF({ ...f, options: v })} placeholder={t('Optionen, durch Komma getrennt')} aria-label={t('Optionen, durch Komma getrennt')} />}
        <table className="t" style={{ marginTop: 10 }}>
          <tbody>
            {(list.data ?? []).map((x) => (
              <tr key={x.id}>
                <td>{x.label}</td>
                <td className="mono">{`{{contact.custom.${x.key}}}`}</td>
                <td>{x.type}</td>
                <td>
                  <button className="icon-btn" onClick={() => confirmAsk(t('Feld löschen? Werte bleiben am Kontakt gespeichert.')) && act(() => api.del(`/api/custom-fields/${x.id}`)).then(list.reload)} aria-label={t('Löschen')}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <FieldCleanup onDone={() => void list.reload()} />
      </div>
      <TagSettings />
    </div>
  );
}

function Team() {
  const t = useT('settings');
  const session = useSession();
  const users = useLoad(() => api.get<any[]>('/api/users'), []);
  const [edit, setEdit] = useState<any>(null);
  const save = async () => {
    const r = await act(() => (edit.id ? api.patch(`/api/users/${edit.id}`, edit) : api.post('/api/users', edit)), t('Gespeichert'));
    if (r) {
      setEdit(null);
      users.reload();
    }
  };
  return (
    <>
      <p>
        <button className="btn" data-tour="team-new" onClick={() => setEdit({ email: '', name: '', password: '', role: 'member', locations: [session.locationId] })}>
          + {t('Benutzer')}
        </button>
      </p>
      <div className="table-wrap" data-tour="team-list">
        <table className="t">
          <tbody>
            {(users.data ?? []).map((u) => (
              <tr key={u.id}>
                <td>
                  <strong>{u.name}</strong>
                  <div className="muted small">{u.email}</div>
                </td>
                <td>
                  <Badge tone={u.role === 'admin' ? 'purple' : 'gray'}>{u.role === 'admin' ? t('Admin') : t('Mitarbeiter')}</Badge> {u.totp_enabled && <Badge tone="green">2FA</Badge>}
                </td>
                <td className="muted small">{u.role === 'admin' ? t('alle Sub-Accounts') : session.locations.filter((l) => u.locations.includes(l.id)).map((l) => l.name).join(', ')}</td>
                <td className="actions">
                  <button className="btn small secondary" onClick={() => setEdit({ ...u, password: '' })}>
                    {t('Bearbeiten')}
                  </button>
                  {u.totp_enabled && u.id !== session.user.id && (
                    <button className="btn small ghost" title={t('Falls das Handy weg ist')} onClick={() => confirmAsk(t('2FA für {name} zurücksetzen?', { name: u.name })) && act(() => api.post(`/api/users/${u.id}/2fa/reset`), t('2FA zurückgesetzt')).then(users.reload)}>
                      {t('2FA zurücksetzen')}
                    </button>
                  )}
                  {u.id !== session.user.id && (
                    <button className="btn small ghost" onClick={() => confirmAsk(t('Benutzer löschen?')) && act(() => api.del(`/api/users/${u.id}`)).then(users.reload)}>
                      {t('Löschen')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal title={edit.id ? t('Benutzer bearbeiten') : t('Neuer Benutzer')} onClose={() => setEdit(null)} footer={<button className="btn" onClick={save}>{t('Speichern')}</button>}>
          {!edit.id && (
            <Field label={t('E-Mail')}>
              <Input value={edit.email} onChange={(v) => setEdit({ ...edit, email: v })} />
            </Field>
          )}
          <Field label={t('Name')}>
            <Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} />
          </Field>
          <Field label={edit.id ? t('Neues Passwort (leer = unverändert)') : t('Passwort')}>
            <Input type="password" value={edit.password} onChange={(v) => setEdit({ ...edit, password: v })} autoComplete="new-password" />
          </Field>
          <Field label={t('Rolle')} tour="team-role">
            <Select value={edit.role} onChange={(v) => setEdit({ ...edit, role: v })} options={[['member', t('Mitarbeiter')], ['admin', t('Admin (alles)')]]} />
          </Field>
          {edit.role === 'member' && (
            <Field label={t('Zugriff auf')}>
              {session.locations.map((l) => (
                <Check key={l.id} checked={edit.locations.includes(l.id)} onChange={(v) => setEdit({ ...edit, locations: v ? [...edit.locations, l.id] : edit.locations.filter((x: string) => x !== l.id) })} label={l.name} />
              ))}
            </Field>
          )}
          {edit.role === 'member' && (
            <MoreFields id="settings-team-areas" label={t('Bereiche einschränken')} values={[edit.permissions]}>
              <Field label={t('Bereiche')} tour="team-areas">
                <PermissionPicker value={edit.permissions ?? null} onChange={(v) => setEdit({ ...edit, permissions: v })} />
              </Field>
            </MoreFields>
          )}
        </Modal>
      )}
    </>
  );
}

function Locations() {
  const t = useT('settings');
  const session = useSession();
  const [n, setN] = useState('');
  return (
    <div className="card" style={{ maxWidth: 640 }} data-tour="settings-locations">
      <p className="muted">{t('Sub-Accounts sind getrennte Firmen/Kunden mit eigenen Kontakten, Kalendern und Einstellungen – wie in GHL. Unbegrenzt, kostenlos.')}</p>
      {session.locations.map((l) => (
        <div key={l.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
          <span>
            {l.name} {l.id === session.locationId && <Badge tone="blue">{t('aktiv')}</Badge>}
          </span>
          <span className="actions">
            {l.id !== session.locationId && (
              <button className="btn small secondary" onClick={() => session.switchLocation(l.id)}>
                {t('Wechseln')}
              </button>
            )}
            {session.locations.length > 1 && (
              <button className="btn small ghost" onClick={async () => confirmAsk(t('„{name}“ mit ALLEN Daten löschen?', { name: l.name })) && (await act(() => api.del(`/api/locations/${l.id}`))) && session.reload()}>
                {t('Löschen')}
              </button>
            )}
          </span>
        </div>
      ))}
      <Backups />
      <div className="row" style={{ marginTop: 12 }}>
        <div className="grow">
          <Input value={n} onChange={setN} placeholder={t('Neuer Sub-Account')} aria-label={t('Neuer Sub-Account')} />
        </div>
        <button className="btn" disabled={!n} onClick={() => act(() => api.post('/api/locations', { name: n }), t('Angelegt')).then(() => (setN(''), session.reload()))}>
          {t('Anlegen')}
        </button>
      </div>
    </div>
  );
}

function Backups() {
  const t = useT('settings');
  const list = useLoad(() => api.get('/api/admin/backups'), []);
  return (
    <div style={{ marginTop: 16 }} data-tour="backups">
      <h3>{t('Backups')}</h3>
      <p className="muted small">
        {list.data?.enabled ? t('Jeden Tag automatisch, die letzten 14 bleiben.') : t('Automatische Backups sind aus (PGHL_BACKUPS=0).')} {t('Uploads (Bilder) liegen zusätzlich im Datenordner.')}
      </p>
      <div className="actions">
        <a className="btn secondary small" href="/api/admin/backup">
          ⬇ {t('Jetzt herunterladen')}
        </a>
        <button className="btn secondary small" onClick={() => act(() => api.post('/api/admin/backups'), t('Backup erstellt')).then(list.reload)}>
          {t('Backup auf dem Server anlegen')}
        </button>
      </div>
      {(list.data?.backups ?? []).slice(0, 14).map((b: any) => (
        <div key={b.name} className="row small" style={{ justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
          <span>
            {fmtDateTime(b.at)} · {(b.size / 1024 / 1024).toFixed(1)} MB
          </span>
          <a href={`/api/admin/backups/${b.name}`}>{t('herunterladen')}</a>
        </div>
      ))}
    </div>
  );
}

function ApiAndHooks() {
  const t = useT('settings');
  const keys = useLoad(() => api.get<any[]>('/api/api-keys'), []);
  const hooks = useLoad(() => api.get<any[]>('/api/webhooks'), []);
  const [newKey, setNewKey] = useState('');
  const [url, setUrl] = useState('');
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="card" style={{ flex: '1 1 380px' }} data-tour="settings-apikeys">
        <h2>{t('API-Schlüssel')}</h2>
        <p className="muted small">
          {t('Für Zapier/Make/n8n oder eigene Skripte:')} {/* i18n-ignore (an HTTP header) */}
          <code>Authorization: Bearer pghl_…</code> {t('gegen')} <code>/api/contacts</code>, <code>/api/opportunities</code> {t('usw.')}
        </p>
        <button className="btn" onClick={async () => { const r = await act(() => api.post('/api/api-keys', { name: prompt(t('Name des Schlüssels'), t('Integration')) ?? 'API' })); if (r) { setNewKey(r.key); keys.reload(); } }}>
          + {t('Schlüssel')}
        </button>
        {newKey && (
          <div style={{ marginTop: 10 }}>
            <p>{t('Nur jetzt sichtbar – kopieren:')}</p>
            <CodeBox text={newKey} />
          </div>
        )}
        {(keys.data ?? []).map((k) => (
          <div key={k.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
            <span>
              {k.name} <span className="mono muted">{k.prefix}…</span>
              <div className="muted small">{t('zuletzt: {date}', { date: dt(k.last_used_at) })}</div>
            </span>
            <button className="btn small ghost" onClick={() => confirmAsk(t('Schlüssel widerrufen?')) && act(() => api.del(`/api/api-keys/${k.id}`)).then(keys.reload)}>
              {t('Widerrufen')}
            </button>
          </div>
        ))}
      </div>
      <div className="card" style={{ flex: '1 1 380px' }} data-tour="settings-webhooks">
        <h2>{t('Ausgehende Webhooks')}</h2>
        <p className="muted small">
          {t('Jedes Ereignis (contact.created, form.submitted, appointment.booked …) als JSON-POST an deine Adresse.')}
          <ProOnly> {t('Signatur: Header x-pghl-signature = sha256(secret + body).')}</ProOnly>
        </p>
        <div className="row">
          <div className="grow">
            <Input value={url} onChange={setUrl} placeholder="https://…" aria-label={t('Webhook-URL')} />
          </div>
          <button className="btn" aria-label={t('Webhook anlegen')} disabled={!url} onClick={() => act(() => api.post('/api/webhooks', { url })).then(() => (setUrl(''), hooks.reload()))}>
            +
          </button>
        </div>
        {(hooks.data ?? []).map((h) => (
          <div key={h.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="mono">{h.url}</span>
              <button className="btn small ghost" onClick={() => act(() => api.del(`/api/webhooks/${h.id}`)).then(hooks.reload)}>
                {t('Entfernen')}
              </button>
            </div>
            <div className="muted small">
              {t('Secret:')} <span className="mono">{h.secret}</span> · {h.last_status ?? t('noch nicht aufgerufen')}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GhlImport() {
  const t = useT('settings');
  const [token, setToken] = useState('');
  const [probe, setProbe] = useState<any>();
  const [ghlLoc, setGhlLoc] = useState('');
  const [manualLoc, setManualLoc] = useState('');
  const [job, setJob] = useState<any>();
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const timer = setInterval(async () => setJob(await api.get(`/api/import/jobs/${job.id}`)), 1500);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  const locId = ghlLoc || manualLoc;
  const companyId = probe?.locations.find((l: any) => l.id === locId)?.companyId;
  return (
    <div className="card" style={{ maxWidth: 760 }} data-tour="settings-import">
      <h2>{t('Von GoHighLevel umziehen')}</h2>
      <p className="muted">
        {t('Holt Kontakte (mit Tags & eigenen Feldern), Pipelines, Opportunities, Kalender und Termine aus GHL in den aktuellen Sub-Account. Mehrfach ausführbar – aktualisiert statt zu verdoppeln. Der Token wird nicht gespeichert.')}
      </p>
      <ol className="muted small">
        <li>{t('In GHL im Sub-Account (nicht Agentur): Einstellungen → Private Integrationen → „Neue Integration“.')}</li>
        {/* i18n-ignore (scope names) */}
        <li>{t('Scopes anhaken:')} contacts.readonly, locations.readonly, locations/customFields.readonly, locations/tags.readonly, opportunities.readonly, calendars.readonly, calendars/events.readonly.</li>
        <li>{t('Token (pit-…) hier einfügen.')}</li>
      </ol>
      <Field label={t('GHL Private Integration Token')}>
        <Input type="password" value={token} onChange={setToken} placeholder="pit-…" autoComplete="off" />
      </Field>
      <button className="btn secondary" disabled={!token} onClick={async () => setProbe(await act(() => api.post('/api/import/ghl/probe', { token, ghl_location_id: manualLoc })))}>
        {t('Verbindung prüfen')}
      </button>
      {probe && (
        <div style={{ marginTop: 14 }}>
          {probe.locations.length > 0 ? (
            <Field label={t('GHL-Sub-Account')}>
              <Select value={ghlLoc} onChange={setGhlLoc} placeholder={t('wählen…')} options={probe.locations.map((l: any) => [l.id, `${l.name} (${l.id})`])} />
            </Field>
          ) : (
            <Field label={t('GHL Location-ID (aus der GHL-URL: /location/<ID>/…)')}>
              <Input value={manualLoc} onChange={setManualLoc} />
            </Field>
          )}
          <table className="t">
            <tbody>
              {Object.entries(probe.scopes).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v === true ? <Badge tone="green">OK</Badge> : <span className="small" style={{ color: 'var(--red)' }}>{String(v)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {Object.values(probe.scopes).some((v) => v !== true) && <p className="muted small">{t('Fehlende Scopes → in GHL beim Token ergänzen oder einen Sub-Account-Token nehmen. Fehlende Teile werden übersprungen.')}</p>}
          <p>
            <button className="btn" disabled={!locId || job?.status === 'running'} onClick={async () => setJob(await act(() => api.post('/api/import/ghl', { token, ghl_location_id: locId, company_id: companyId }).then((r) => api.get(`/api/import/jobs/${r.id}`))))}>
              {t('Import starten')}
            </button>
          </p>
        </div>
      )}
      {job && (
        <div className="card" style={{ background: 'var(--bg)' }}>
          <strong>
            {job.status === 'running' ? `${t('Läuft…')} (${job.progress.part}${job.progress.total ? `: ${job.progress.done}/${job.progress.total}` : ''})` : job.status === 'done' ? t('Fertig ✅') : t('Fehler: {error}', { error: job.error })}
          </strong>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{job.progress.log.join('\n')}</pre>
          {job.status === 'done' && (
            <button className="btn small" onClick={() => navigate('contacts')}>
              {t('Zu den Kontakten')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Devices() {
  const t = useT('settings');
  const list = useLoad(() => api.get<any[]>('/api/me/sessions'), []);
  const label = (ua: string) => {
    if (!ua) return t('Unbekanntes Gerät');
    const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : t('Gerät');
    const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : t('Browser');
    return t('{browser} auf {os}', { browser: br, os });
  };
  if (!list.data) return <Spinner />;
  return (
    <>
      <h2 data-tour="account-devices">{t('Angemeldete Geräte')}</h2>
      {list.data.map((s) => (
        <div key={s.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div>
            {label(s.user_agent)} {s.current && <Badge tone="green">{t('dieses Gerät')}</Badge>}
            <div className="muted small">
              {t('seit {date}', { date: dt(s.created_at) })}
              {s.ip ? ` · ${s.ip}` : ''}
            </div>
          </div>
          {!s.current && (
            <button className="btn small ghost" onClick={async () => (await act(() => api.del(`/api/me/sessions/${s.id}`), t('Abgemeldet'))) && list.reload()}>
              {t('Abmelden')}
            </button>
          )}
        </div>
      ))}
      {list.data.length > 1 && (
        <button className="btn small secondary" onClick={async () => (await act(() => api.post('/api/me/sessions/revoke-others'), t('Andere Geräte abgemeldet'))) && list.reload()}>
          {t('Alle anderen abmelden')}
        </button>
      )}
    </>
  );
}

export function TwoFactor({ onChange }: { onChange?: () => void } = {}) {
  const t = useT('settings');
  const st = useLoad(() => api.get<any>('/api/me/2fa'), []);
  const [setup, setSetup] = useState<any>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  if (!st.data) return <Spinner />;
  return (
    <>
      <h2 data-tour="account-2fa">
        {t('Zwei-Faktor-Login')} {st.data.enabled ? <Badge tone="green">{t('aktiv')}</Badge> : <Badge>{t('aus')}</Badge>}
      </h2>
      {codes && (
        <div className="card" style={{ background: 'var(--bg)' }}>
          <strong>{t('Backup-Codes – jetzt sicher aufbewahren!')}</strong>
          <p className="muted small">{t('Jeder Code funktioniert einmal, falls dein Handy weg ist.')}</p>
          <CodeBox text={codes.join('  ')} />
        </div>
      )}
      {!st.data.enabled && !setup && (
        <>
          <p className="muted">{t('Schützt dein Konto mit einem Code aus einer App (Google Authenticator, Authy, 1Password …).')}</p>
          <button className="btn" onClick={async () => setSetup(await act(() => api.post('/api/me/2fa/setup')))}>
            {t('2FA einrichten')}
          </button>
        </>
      )}
      {!st.data.enabled && setup && (
        <>
          <p>{t('1. QR-Code mit der Authenticator-App scannen:')}</p>
          <img src={setup.qr} alt={t('QR-Code')} width={180} height={180} style={{ background: '#fff', borderRadius: 8 }} />
          <p className="muted small">
            {t('Oder manuell eingeben:')} <code>{setup.secret}</code>
          </p>
          <Field label={t('2. Angezeigten 6-stelligen Code eingeben')}>
            <Input value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" />
          </Field>
          <button
            className="btn"
            onClick={async () => {
              const r = await act(() => api.post('/api/me/2fa/enable', { code }), t('2FA ist aktiv'));
              if (r) {
                setCodes(r.backup_codes);
                setSetup(null);
                setCode('');
                st.reload();
                onChange?.();
              }
            }}
          >
            {t('Aktivieren')}
          </button>
        </>
      )}
      {st.data.enabled && (
        <>
          <p className="muted small">{t.plural(st.data.backup_left, { one: '{n} Backup-Code übrig.', other: '{n} Backup-Codes übrig.' })}</p>
          <Field label={t('Aktueller Code (zum Ändern)')}>
            <Input value={code} onChange={setCode} inputMode="numeric" />
          </Field>
          <Field label={t('Passwort (nur zum Ausschalten)')}>
            <Input type="password" value={pw} onChange={setPw} autoComplete="current-password" />
          </Field>
          <div className="actions">
            <button
              className="btn secondary"
              onClick={async () => {
                const r = await act(() => api.post('/api/me/2fa/backup-codes', { code }));
                if (r) (setCodes(r.backup_codes), setCode(''), st.reload());
              }}
            >
              {t('Neue Backup-Codes')}
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                if (!confirmAsk(t('Zwei-Faktor-Login wirklich ausschalten?'))) return;
                const r = await act(() => api.post('/api/me/2fa/disable', { code, password: pw }), t('2FA ausgeschaltet'));
                if (r) (setCode(''), setPw(''), setCodes(null), st.reload());
              }}
            >
              {t('Ausschalten')}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function Account() {
  const t = useT('settings');
  const [p, setP] = useState({ current: '', next: '' });
  return (
    <>
    <div className="card" style={{ maxWidth: 480 }}>
      <LanguageField />
    </div>
    <div className="card" style={{ maxWidth: 900 }} data-tour="calendar-connections">
      <CalendarConnections />
    </div>
    <div className="card" style={{ maxWidth: 480 }} data-tour="account-password">
      <h2>{t('Passwort ändern')}</h2>
      <Field label={t('Aktuelles Passwort')}>
        <Input type="password" value={p.current} onChange={(v) => setP({ ...p, current: v })} autoComplete="current-password" />
      </Field>
      <Field label={t('Neues Passwort')}>
        <Input type="password" value={p.next} onChange={(v) => setP({ ...p, next: v })} autoComplete="new-password" />
      </Field>
      <button className="btn" onClick={() => act(() => api.post('/api/me/password', p), t('Passwort geändert')).then(() => setP({ current: '', next: '' }))}>
        {t('Ändern')}
      </button>
      <hr />
      <SignInMethods />
      <hr />
      <TwoFactor />
      <hr />
      <Devices />
      <hr />
      <MoreFields id="settings-account-apps" label={t('Handy-App und Push-Nachrichten')}>
        <AppDevices />
        <hr />
        <IosAppCard />
        <hr />
        <PushSettings />
      </MoreFields>
    </div>
    </>
  );
}

export function Settings({ tab: rawTab = 'company' }: { tab?: string }) {
  const t = useT('settings');
  const session = useSession();
  const admin = session.user.role === 'admin';
  // Hosted cloud mode: "Abo & Rechnung" becomes the cloud account (plan, team, data, deletion); settings/cloud is its address.
  const cloud = !!useAppInfo()?.cloud?.enabled;
  const tab = cloud && rawTab === 'cloud' ? 'subscription' : rawTab;
  const tabs: [string, string][] = [
    ['company', t('Firma')],
    ['messaging', t('E-Mail & SMS')],
    ['deliverability', t('E-Mail-Zustellung')],
    ['channels', t('Kanäle')],
    ['more-channels', t('Weitere Kanäle')],
    ['telephony', t('Telefonie')],
    ['billing', t('Rechnungen')],
    ['stripe', t('Stripe & Zahlungen')],
    ['reviews', t('Bewertungen')],
    ['chat', t('Live-Chat')],
    ['ai', t('KI-Assistent')],
    ['ai-tools', t('KI-Werkzeuge')],
    ['helpdesk', t('Service')],
    ['inbox', t('Team-Posteingang')],
    ['fields', t('Felder & Tags')],
    ['custom-values', t('Custom Values')],
    ['consent', t('Einwilligung & Recht')],
    ['api', t('API & Webhooks')],
    ['ai-providers', t('KI-Anbieter (BYOK)')],
    ['voice', t('Stimme')],
    ['memory', t('Gedächtnis')],
    ['import', t('Import')],
    ['umzug', t('Umzug')],
    ...(admin ? ([['team', t('Team')], ['locations', t('Sub-Accounts')]] as [string, string][]) : []),
    ...(session.saas?.plan ? ([['subscription', cloud ? t('Cloud-Konto') : t('Abo & Rechnung')]] as [string, string][]) : []),
    ['appearance', t('Darstellung')],
    ['account', t('Mein Konto')],
  ];
  return (
    <>
      <PageHead title={t('Einstellungen')}>
        <LearnLink label="learn" />
      </PageHead>
      <SettingsTabs tabs={tabs} value={tab} onChange={(t) => navigate(`settings/${t}`)} />
      {tab === 'company' && (
        <>
          <SimpleOnly>
            <SetupChecklist />
          </SimpleOnly>
          <Company />
        </>
      )}
      {tab === 'messaging' && (
        <>
          <EmailSms />
          <UmzugPointer kind="deliverability" />
          <MailboxSettings />
        </>
      )}
      {tab === 'channels' && (
        <>
          <MetaSettings />
          <Slot name="channels.meta" />
        </>
      )}
      {tab === 'more-channels' && <MoreChannelSettings />}
      {tab === 'telephony' && (
        <>
          <TelephonySettings />
          <Slot name="telephony.settings" />
          <BrowserPhoneSettings />
          <VoiceAiSettings />
          <Slot name="voiceai.panel" />
        </>
      )}
      {tab === 'billing' && <InvoiceSettings />}
      {tab === 'stripe' && (
        <>
          <StripeSettings />
          <Slot name="settings.payments" />
        </>
      )}
      {tab === 'reviews' && (
        <>
          <ReviewSettings />
          <GoogleBusinessSettings />
          <GoogleReviewSettings />
        </>
      )}
      {tab === 'chat' && <LiveChat />}
      {tab === 'ai' && <AiSettings />}
      {tab === 'ai-tools' && <AiTools />}
      {tab === 'helpdesk' && <HelpdeskSettings />}
      {tab === 'inbox' && <TeamInboxSettings />}
      {tab === 'fields' && <CustomFields />}
      {tab === 'custom-values' && (
        <PageSuspense>
          <CustomValuesSettings />
        </PageSuspense>
      )}
      {tab === 'consent' && (
        <PageSuspense>
          <ConsentSettings />
        </PageSuspense>
      )}
      {tab === 'api' && (
        <>
          <ApiAndHooks />
          <RestHooksPanel />
        </>
      )}
      {tab === 'import' && (
        <>
          <UmzugPointer kind="umzug" />
          <HubSpotImport />
          <GhlImport />
        </>
      )}
      {tab === 'umzug' && (
        <PageSuspense>
          <UmzugAssistent embedded />
        </PageSuspense>
      )}
      {tab === 'deliverability' && (
        <PageSuspense>
          <UmzugZustellung embedded />
        </PageSuspense>
      )}
      {tab === 'team' && admin && (
        <>
          <Team />
          <Slot name="settings.team" />
        </>
      )}
      {tab === 'locations' && admin && <Locations />}
      {tab === 'subscription' &&
        (cloud ? (
          <PageSuspense>
            <CloudAccount fallback={<SubscriptionSettings />} />
          </PageSuspense>
        ) : (
          <SubscriptionSettings />
        ))}
      {tab === 'appearance' && <Appearance />}
      {tab === 'account' && <Account />}
      {tab === 'ai-providers' && <AiConnections />}
      {tab === 'voice' && <VoiceSettingsPage />}
      {tab === 'memory' && (
        <PageSuspense>
          <CogneeSettings />
        </PageSuspense>
      )}
      {!tabs.some(([k]) => k === tab) && <Empty>{t('Unbekannter Bereich.')}</Empty>}
    </>
  );
}
