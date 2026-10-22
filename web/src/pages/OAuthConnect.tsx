import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { Icon } from '../icons';
import { useSession } from '../session';
import { Badge, Check, CodeBox, Field, Input, Link, Select, Spinner, act, confirmAsk, toast, toastError, useLoad } from '../ui';
import { SignupLink } from '../referrals';
import { useT } from '../i18n';

/**
 * Google & Microsoft via OAuth: the agency's apps (Agentur → Integrationen), the calendar
 * connection of each login (Einstellungen → Mein Konto) and a hint in the calendar editor.
 */

const LABEL: Record<string, string> = { google: 'Google', microsoft: 'Microsoft' };
const CAL_LABEL: Record<string, string> = { google: 'Google Kalender', microsoft: 'Outlook-Kalender' };

/** After the provider sends the browser back (?oauth=ok|error&msg=…): toast once and clean the address. */
export function useOAuthReturn(onOk?: () => void) {
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const state = q.get('oauth');
    if (!state) return;
    if (state === 'ok') {
      toast(`${LABEL[q.get('provider') ?? ''] ?? 'Konto'} verbunden`);
      onOk?.();
    } else toastError(q.get('msg') || 'Verbinden fehlgeschlagen');
    history.replaceState(null, '', location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Starts the authorization: the server returns the provider's consent URL. */
export async function startOAuth(provider: string, purpose: 'calendar' | 'business', locationId?: string) {
  const r = await act(() => api.post<{ url: string }>('/api/oauth/start', { provider, purpose, location_id: locationId }));
  if (r?.url) location.href = r.url;
}

// --- Agentur → Integrationen -----------------------------------------------------------------

export function OAuthApps() {
  const s = useLoad(() => api.get<any>('/api/agency/oauth'), []);
  const [f, setF] = useState<any>(null);
  useEffect(() => {
    if (s.data) setF({ google: { client_id: s.data.google.client_id, client_secret: '' }, microsoft: { client_id: s.data.microsoft.client_id, client_secret: '', tenant: s.data.microsoft.tenant } });
  }, [s.data]);
  if (!s.data || !f) return <Spinner />;
  const set = (p: string, patch: any) => setF({ ...f, [p]: { ...f[p], ...patch } });
  const save = async () => {
    const body = { google: { ...f.google, client_secret: f.google.client_secret || undefined }, microsoft: { ...f.microsoft, client_secret: f.microsoft.client_secret || undefined } };
    const r = await act(() => api.put('/api/agency/oauth', body), 'Gespeichert');
    if (r) s.setData(r);
  };
  const count = (p: string, purpose: string) => s.data.connections.find((c: any) => c.provider === p && c.purpose === purpose)?.n ?? 0;
  const status = (p: string) =>
    s.data[p].configured ? (
      <Badge tone="green">eingerichtet{s.data[p].from_env ? ' (Umgebung)' : ''}</Badge>
    ) : (
      <Badge>nicht eingerichtet</Badge>
    );
  return (
    <div className="card oauth-apps" data-tour="oauth-apps">
      <h2>Google & Microsoft (OAuth)</h2>
      <p className="muted small">
        Einmal für die Agentur: Damit verbindet jeder Login seinen Google- oder Outlook-Kalender (<em>Einstellungen → Mein Konto</em>) und jeder Sub-Account sein Google-Unternehmensprofil (
        <em>Einstellungen → Bewertungen</em>). Anleitung: <code>docs/self-hosting.md</code>, Abschnitt „Google & Microsoft verbinden“.
      </p>
      <div className="grid2">
        <div>
          <h3>
            Google {status('google')} <SignupLink id="google_cloud" />
          </h3>
          <Field label="Client-ID" hint="Google Cloud Console → APIs & Dienste → Anmeldedaten → OAuth-Client-ID (Webanwendung)">
            <Input value={f.google.client_id} onChange={(v) => set('google', { client_id: v })} placeholder="…apps.googleusercontent.com" />
          </Field>
          <Field label="Clientschlüssel" hint="Wird verschlüsselt gespeichert und nie wieder angezeigt.">
            <Input type="password" value={f.google.client_secret} onChange={(v) => set('google', { client_secret: v })} placeholder={s.data.google.secret_set ? '•••••••• (gespeichert)' : 'GOCSPX-…'} autoComplete="new-password" />
          </Field>
          <Field label="Autorisierte Weiterleitungs-URI (bei Google eintragen)">
            {s.data.google.redirect_uris.map((u: string) => (
              <CodeBox key={u} text={u} />
            ))}
          </Field>
          <p className="muted small">
            APIs aktivieren: Google Calendar API; für Bewertungen/Beiträge die Business Profile APIs (Freischaltung durch Google nötig); für den Postfach-Sync die Gmail API (Bereiche gmail.modify und gmail.send sind bei Google „eingeschränkt“ – <code>docs/mailbox-sync.md</code>). Verbunden: Kalender {count('google', 'calendar')} · Unternehmensprofile {count('google', 'business')} · Postfächer {count('google', 'mail')}.
          </p>
        </div>
        <div>
          <h3>
            Microsoft {status('microsoft')} <SignupLink id="microsoft365" />
          </h3>
          <Field label="Anwendungs-ID (Client-ID)" hint="Microsoft Entra Admin Center → App-Registrierungen → Neue Registrierung">
            <Input value={f.microsoft.client_id} onChange={(v) => set('microsoft', { client_id: v })} placeholder="00000000-0000-0000-0000-000000000000" />
          </Field>
          <Field label="Geheimer Clientschlüssel (Wert)" hint="Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel. Verschlüsselt gespeichert.">
            <Input type="password" value={f.microsoft.client_secret} onChange={(v) => set('microsoft', { client_secret: v })} placeholder={s.data.microsoft.secret_set ? '•••••••• (gespeichert)' : ''} autoComplete="new-password" />
          </Field>
          <Field label="Mandant" hint="common = Geschäfts- und private Konten; organizations = nur Geschäftskonten; oder die Mandanten-ID">
            <Input value={f.microsoft.tenant} onChange={(v) => set('microsoft', { tenant: v })} placeholder="common" />
          </Field>
          <Field label="Umleitungs-URI (Plattform „Web“)">
            {s.data.microsoft.redirect_uris.map((u: string) => (
              <CodeBox key={u} text={u} />
            ))}
          </Field>
          <p className="muted small">
            API-Berechtigungen (delegiert): Calendars.ReadWrite, offline_access, openid, email; für Postfächer Mail.ReadWrite, Mail.Send (gemeinsame Postfächer: .Shared) – in manchen Mandanten braucht es die Zustimmung eines Administrators. Verbunden: Kalender {count('microsoft', 'calendar')} · Postfächer {count('microsoft', 'mail')}.
          </p>
        </div>
      </div>
      <button className="btn" onClick={save}>
        Speichern
      </button>
    </div>
  );
}

// --- Einstellungen → Mein Konto ---------------------------------------------------------------

function ConnectionCard({ c, bookingCals, onChange }: { c: any; bookingCals: any[]; onChange: (next?: any) => void }) {
  // Part of Mein Konto: translated with it (settings catalog; CAL_LABEL's names are its message ids).
  const t = useT('settings');
  const ext = useLoad(() => (c.needs_reconnect ? Promise.resolve([]) : api.get<any[]>(`/api/me/calendar-connections/${c.id}/calendars`)), [c.id, c.needs_reconnect]);
  const [check, setCheck] = useState<string[]>(c.settings.check_calendars);
  const [target, setTarget] = useState<string>(c.settings.target_calendar);
  const [links, setLinks] = useState<string[]>(c.booking_calendars);
  const [busy, setBusy] = useState(false);
  const fresh = !c.settings.check_calendars.length && !c.settings.target_calendar;
  // A fresh connection starts with the primary calendar for both.
  useEffect(() => {
    const primary = ext.data?.find((x) => x.primary);
    if (fresh && primary) {
      setCheck([primary.id]);
      if (primary.can_write) setTarget(primary.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ext.data]);
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));
  const save = async () => {
    setBusy(true);
    const saved = await act(() => api.put(`/api/me/calendar-connections/${c.id}`, { check_calendars: check, target_calendar: target, booking_calendars: links }));
    if (saved) {
      const r = await act(() => api.post(`/api/me/calendar-connections/${c.id}/sync`));
      if (r) {
        toast(r.result.errors.length ? t('Gespeichert – Abgleich mit Fehler: {error}', { error: r.result.errors[0] }) : t('Gespeichert und abgeglichen'));
        onChange(r.connection);
      } else onChange(saved);
    }
    setBusy(false);
  };
  const syncNow = async () => {
    setBusy(true);
    const r = await act(() => api.post(`/api/me/calendar-connections/${c.id}/sync`));
    setBusy(false);
    if (!r) return;
    const x = r.result;
    toast(x.errors.length ? t('Abgleich mit Fehler: {error}', { error: x.errors[0] }) : t('Abgeglichen: {created} neu, {updated} geändert, {deleted} gelöscht, {pulled} übernommen', { created: x.created, updated: x.updated, deleted: x.deleted, pulled: x.pulled }));
    onChange(r.connection);
  };
  const disconnect = async () => {
    if (!confirmAsk(t('{calendar} trennen? Bereits eingetragene Termine bleiben dort stehen, werden aber nicht mehr abgeglichen.', { calendar: t(CAL_LABEL[c.provider]) }))) return;
    if (await act(() => api.del(`/api/oauth/connections/${c.id}`), t('Getrennt'))) onChange();
  };
  const groups = new Map<string, any[]>();
  for (const b of bookingCals) groups.set(b.location_name, [...(groups.get(b.location_name) ?? []), b]);
  return (
    <div className="card oauth-conn">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <strong>{t(CAL_LABEL[c.provider])}</strong> <span className="muted">{c.account_email}</span>{' '}
          {c.status === 'ok' ? <Badge tone="green">{t('verbunden')}</Badge> : <Badge tone="red">{c.needs_reconnect ? t('neu verbinden') : t('Fehler')}</Badge>}
          <div className="muted small">
            {c.last_sync_at ? t('Letzter Abgleich {date}', { date: dt(c.last_sync_at) }) : t('Noch nicht abgeglichen')} · {t.plural(c.events.synced, { one: '{n} Termin eingetragen', other: '{n} Termine eingetragen' })} ·{' '}
            {t.plural(c.busy.count, { one: '{n} belegte Zeit', other: '{n} belegte Zeiten' })}
            {c.events.failing ? ` · ${t('{n} warten auf erneuten Versuch', { n: c.events.failing })}` : ''}
          </div>
          {c.last_error && <div className="small" style={{ color: 'var(--red)' }}>{c.last_error}</div>}
        </div>
        <div className="actions">
          {c.needs_reconnect && (
            <button className="btn small" onClick={() => startOAuth(c.provider, 'calendar')}>
              {t('Neu verbinden')}
            </button>
          )}
          <button className="btn small secondary" disabled={busy || c.needs_reconnect} onClick={syncNow}>
            <Icon name="refresh" size={14} /> {t('Jetzt abgleichen')}
          </button>
          <button className="btn small danger" onClick={disconnect}>
            {t('Trennen')}
          </button>
        </div>
      </div>
      {!c.needs_reconnect && (
        <>
          {ext.error && <p style={{ color: 'var(--red)' }}>{ext.error}</p>}
          {!ext.data && !ext.error ? (
            <Spinner />
          ) : (
            <div className="grid2" style={{ marginTop: 10 }}>
              <Field label={t('Belegte Zeiten aus diesen Kalendern blockieren')}>
                <div className="check-list">
                  {(ext.data ?? []).map((x) => (
                    <Check key={x.id} checked={check.includes(x.id)} onChange={(on) => setCheck(toggle(check, x.id, on))} label={x.primary ? `${x.name} (${t('Haupt')})` : x.name} />
                  ))}
                </div>
              </Field>
              <Field label={t('Gebuchte Termine eintragen in')} hint={t('Verschieben oder Löschen dort wird hier übernommen.')}>
                <Select value={target} onChange={setTarget} placeholder={t('– nicht eintragen –')} options={(ext.data ?? []).filter((x) => x.can_write).map((x) => [x.id, x.name])} />
              </Field>
            </div>
          )}
          <Field label={t('Für diese Buchungskalender')} hint={t('Belegte Zeiten blockieren ihre Buchungsseiten, ihre Termine landen in deinem Kalender.')}>
            {bookingCals.length ? (
              <div className="check-list">
                {[...groups].map(([locName, list]) => (
                  <div key={locName}>
                    {groups.size > 1 && <div className="muted small">{locName}</div>}
                    {list.map((b) => (
                      <Check key={b.id} checked={links.includes(b.id)} onChange={(on) => setLinks(toggle(links, b.id, on))} label={b.name} />
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <span className="muted small">
                {t('Noch kein Buchungskalender – unter')} <Link to="calendars">{t('Kalender')}</Link> {t('anlegen.')}
              </span>
            )}
          </Field>
          <button className="btn" disabled={busy} onClick={save}>
            {t('Speichern & abgleichen')}
          </button>
        </>
      )}
      {c.log.length > 0 && (
        <details className="oauth-log">
          <summary className="muted small">{t('Protokoll')}</summary>
          {c.log.map((l: any, i: number) => (
            <div key={i} className="small" style={l.level === 'info' ? {} : { color: l.level === 'error' ? 'var(--red)' : 'var(--yellow)' }}>
              <span className="muted">{dt(l.at)}</span> {l.message}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

export function CalendarConnections() {
  const t = useT('settings');
  const data = useLoad(() => api.get<any>('/api/me/calendar-connections'), []);
  const booking = useLoad(() => api.get<any[]>('/api/me/calendar-connections/booking-calendars'), []);
  const session = useSession();
  useOAuthReturn(() => void data.reload());
  if (!data.data || !booking.data) return <Spinner />;
  const { providers, connections } = data.data;
  const has = (p: string) => connections.some((c: any) => c.provider === p);
  const replace = (next?: any) => {
    if (!next) return void data.reload();
    data.setData({ ...data.data, connections: connections.map((c: any) => (c.id === next.id ? next : c)) });
  };
  return (
    <>
      <h2>
        <Icon name="calendars" /> {t('Google- oder Outlook-Kalender')}
      </h2>
      <p className="muted small">
        {t('Termine in deinem Kalender blockieren die Buchungsseiten, gebuchte Termine landen automatisch dort – und wer sie dort verschiebt oder löscht, ändert sie auch hier. Abgleich alle paar Minuten.')}
      </p>
      {!providers.google && !providers.microsoft && (
        <p className="muted small">
          {t('Die Agentur hat noch keine Google- oder Microsoft-App hinterlegt')}
          {session.user.role === 'admin' ? (
            <>
              {' '}
              (<Link to="agency/integrations">{t('Agentur → Integrationen')}</Link>)
            </>
          ) : null}
          . {t('Ohne App geht weiter der iCal-Abgleich im Kalender (Bearbeiten → Google/Outlook-Sync).')}
        </p>
      )}
      <div className="actions" style={{ marginBottom: 10 }}>
        {providers.google && !has('google') && (
          <button className="btn secondary" onClick={() => startOAuth('google', 'calendar')}>
            {t('Mit Google verbinden')}
          </button>
        )}
        {providers.microsoft && !has('microsoft') && (
          <button className="btn secondary" onClick={() => startOAuth('microsoft', 'calendar')}>
            {t('Mit Microsoft (Outlook) verbinden')}
          </button>
        )}
      </div>
      {connections.map((c: any) => (
        <ConnectionCard key={`${c.id}:${c.updated_at}`} c={c} bookingCals={booking.data!} onChange={replace} />
      ))}
    </>
  );
}

// --- Kalender → Bearbeiten → Google/Outlook-Sync -----------------------------------------------

export function CalendarConnectionInfo({ calId }: { calId: string }) {
  // Shown in the calendar editor: translated with it (calendar catalog).
  const t = useT('calendar');
  const list = useLoad(() => api.get<any[]>(`/api/calendars/${calId}/connections`), [calId]);
  return (
    <div className="card" style={{ background: 'var(--bg)', marginTop: 0, marginBottom: 14 }}>
      <h3 style={{ marginTop: 0 }}>{t('Mit Google- oder Outlook-Konto (empfohlen)')}</h3>
      {list.data?.length ? (
        list.data.map((c) => (
          <div key={c.id} className="small">
            {t('{calendar} von {name} ({email})', { calendar: c.provider === 'google' ? t('Google Kalender') : t('Outlook-Kalender'), name: c.user_name || c.account_email, email: c.account_email })}{' '}
            {c.status === 'ok' ? <Badge tone="green">{t('verbunden')}</Badge> : <Badge tone="red">{t('Fehler')}</Badge>} · {c.writes ? t('blockiert und trägt Termine ein') : t('blockiert belegte Zeiten')}
            {c.last_sync_at ? ` · ${t('zuletzt {date}', { date: dt(c.last_sync_at) })}` : ''}
          </div>
        ))
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          {t('Zwei-Wege-Abgleich ohne iCal-Adressen: unter')} <Link to="settings/account">{t('Einstellungen → Mein Konto')}</Link> {t('das eigene Google- oder Microsoft-Konto verbinden und diesen Kalender auswählen.')}
        </p>
      )}
    </div>
  );
}
