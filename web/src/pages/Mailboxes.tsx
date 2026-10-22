import { useEffect, useRef, useState } from 'react';
import { api, dt } from '../api';
import { Icon } from '../icons';
import { Badge, Check, CodeBox, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, toast, toastError, useLoad } from '../ui';
import { MoreFields } from '../areas/fields';

/**
 * Native mailboxes (Gmail and Outlook / Microsoft 365 over their official APIs):
 * - Einstellungen → E-Mail & SMS: "Postfach verbinden", the list with status, folder/label picker, sync window,
 *   routing rules of personal mailboxes, push status; the provider "Verbundenes Postfach" for workflow e-mails;
 * - Agentur → Integrationen: push setup (Pub/Sub topic, service account, Graph notification URLs);
 * - Konversationen: mailbox filter + folders, badges, archive, labels, replying through the mailbox, attachments,
 *   drafts that live in Gmail/Outlook.
 */

const PROVIDER: Record<string, string> = { google: 'Gmail', microsoft: 'Outlook' };
const FOLDER: Record<string, string> = { inbox: 'Posteingang', archive: 'Archiv', sent: 'Gesendet', drafts: 'Entwürfe', all: 'Alle', trash: 'Papierkorb', deleted: 'Gelöscht', other: 'Ordner' };
const ACCESS: [string, string][] = [
  ['full', 'Vollzugriff: lesen, senden und verwalten (Archiv, Labels, gelesen/Stern)'],
  ['readonly', 'Nur lesen (Postfach abgleichen, nichts ändern oder senden)'],
  ['send', 'Nur senden (kein Abgleich – für Workflow-E-Mails)'],
];

/** The focus goes back to what opened a dialog (the ✕ and Esc of Modal close it). */
function useRestoreFocus() {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);
}

/** After the provider sends the browser back (?oauth=ok|error&msg=…): one message, then a clean address. */
function useMailReturn(onOk: () => void) {
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const state = q.get('oauth');
    if (!state || (state === 'ok' && !q.get('mailbox'))) return;
    if (state === 'ok') {
      toast('Postfach verbunden – der Abgleich läuft');
      onOk();
    } else toastError(q.get('msg') || 'Verbinden fehlgeschlagen');
    history.replaceState(null, '', location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const fileToBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
    r.readAsDataURL(f);
  });

const size = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function StatusBadge({ mb }: { mb: any }) {
  if (!mb.enabled) return <Badge>aus</Badge>;
  if (mb.status === 'reconnect') return <Badge tone="red">neu verbinden</Badge>;
  if (mb.status === 'error') return <Badge tone="red">Fehler</Badge>;
  if (mb.status === 'importing' || mb.status === 'new') return <Badge tone="yellow">wird importiert</Badge>;
  return <Badge tone="green">verbunden</Badge>;
}

// --- Einstellungen → E-Mail & SMS -----------------------------------------------------------------------------------

export function MailboxSettings() {
  const s = useLoad(() => api.get<any>('/api/mailboxes'), []);
  const scheduled = useLoad(() => api.get<any[]>('/api/mail/scheduled'), []);
  useMailReturn(() => void s.reload());
  const [f, setF] = useState({ provider: 'google', scope: 'location', access: 'full', shared: '', name: '' });
  const [editing, setEditing] = useState<any>(null);
  const [busy, setBusy] = useState('');
  // While a first import runs the list refreshes itself.
  const importing = (s.data?.mailboxes ?? []).some((m: any) => m.status === 'importing' || m.status === 'new');
  useEffect(() => {
    if (!importing) return;
    const t = setInterval(() => void s.reload(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importing]);
  if (!s.data) return s.error ? <p style={{ color: 'var(--red)' }}>{s.error}</p> : <Spinner />;
  const list: any[] = s.data.mailboxes;
  const usable = s.data.providers[f.provider];
  const connect = async (mailboxId?: string) => {
    const mb = mailboxId ? list.find((m) => m.id === mailboxId) : null;
    const body = mb ? { provider: mb.provider, scope: mb.scope, access: mb.access, mailbox_id: mb.id } : { provider: f.provider, scope: f.scope, access: f.access, name: f.name, ...(f.provider === 'microsoft' && f.shared ? { shared_address: f.shared } : {}) };
    const r = await act(() => api.post<{ url: string }>('/api/mailboxes/connect', body));
    if (r?.url) location.href = r.url;
  };
  const sync = async (m: any, full = false) => {
    setBusy(m.id);
    const r = await act(() => api.post(`/api/mailboxes/${m.id}/sync`, { full }));
    setBusy('');
    if (r) {
      const x = r.result;
      toast(x.busy ? 'Der Abgleich läuft schon' : `Abgeglichen: ${x.created} neu, ${x.updated} geändert${x.deleted ? `, ${x.deleted} gelöscht` : ''}${x.more ? ' – weitere folgen im Hintergrund' : ''}`);
    }
    void s.reload();
  };
  const disconnect = async (m: any) => {
    if (!confirmAsk(`„${m.name}“ trennen? Der Zugriff wird entzogen. Bereits abgeglichene E-Mails bleiben in den Konversationen.`)) return;
    if (await act(() => api.del(`/api/mailboxes/${m.id}`), 'Getrennt')) void s.reload();
  };
  return (
    <div className="card mbx-card" data-tour="mailbox-card" style={{ marginTop: 16 }}>
      <h2>
        <Icon name="email" size={18} /> Postfach verbinden (Gmail / Outlook)
      </h2>
      <p className="muted small">Über die offiziellen Schnittstellen von Google und Microsoft – ohne IMAP/SMTP-Passwörter. Antworten, Archivieren und Labels gelten in beide Richtungen.</p>
      {!s.data.providers.google && !s.data.providers.microsoft && (
        <p className="small" style={{ color: 'var(--red)' }}>
          Die Agentur hat noch keine Google- oder Microsoft-App hinterlegt (<em>Agentur → Integrationen → Google & Microsoft</em>). Anleitung: <code>docs/mailbox-sync.md</code>.
        </p>
      )}
      <div className="grid2" data-tour="mailbox-connect">
        <Field label="Anbieter">
          <div data-tour="mailbox-provider">
            <Select value={f.provider} onChange={(v) => setF({ ...f, provider: v, shared: '' })} options={[['google', 'Gmail / Google Workspace'], ['microsoft', 'Outlook / Microsoft 365']]} />
          </div>
        </Field>
        <Field label="Für wen?" hint="Sub-Account: fürs ganze Team. Persönlich: nur für dich – Regeln bestimmen, was ins CRM kommt.">
          <Select value={f.scope} onChange={(v) => setF({ ...f, scope: v })} options={[['location', s.data.can_manage_location ? 'Dieser Sub-Account' : 'Dieser Sub-Account (Einstellungs-Recht fehlt)'], ['user', 'Nur für mich (persönlich)']]} />
        </Field>
      </div>
      <MoreFields id="mailbox-connect" values={[f.name, f.shared]}>
        <div className="grid2">
          <Field label="Zugriff">
            <Select value={f.access} onChange={(v) => setF({ ...f, access: v })} options={ACCESS} />
          </Field>
          <Field label="Name (optional)">
            <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder="z. B. Info-Postfach" />
          </Field>
          {f.provider === 'microsoft' && (
            <Field label="Gemeinsames Postfach (optional)" hint="Adresse eines Shared Mailbox; du meldest dich mit deinem Konto an, das Zugriff darauf hat.">
              <Input value={f.shared} onChange={(v) => setF({ ...f, shared: v })} placeholder="team@firma.de" />
            </Field>
          )}
        </div>
      </MoreFields>
      <button className="btn" disabled={!usable} onClick={() => connect()}>
        Mit {PROVIDER[f.provider]} verbinden
      </button>
      {f.provider === 'google' && f.access !== 'send' && (
        <p className="muted small" style={{ marginTop: 8 }}>
          Hinweis: Gmail-Lese-/Änderungsrechte sind bei Google „eingeschränkt“. Eine eigene Agentur-App im Modus „Testen“ (Testnutzer eintragen) oder als interne Workspace-App braucht keine Prüfung – im Testmodus muss alle 7 Tage neu verbunden werden. Details: <code>docs/mailbox-sync.md</code>.
        </p>
      )}

      <hr />
      {list.length > 0 && <h3>Verbundene Postfächer</h3>}
      <div className="mbx-list" data-tour="mailbox-list">
        {list.map((m) => (
          <div key={m.id} className="card oauth-conn mbx-item">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <strong>{m.name}</strong> <span className="muted">{m.address}</span> <Badge tone="blue">{PROVIDER[m.provider]}</Badge> <Badge>{m.scope === 'user' ? 'persönlich' : 'Sub-Account'}</Badge> <StatusBadge mb={m} />
                <div className="muted small">
                  {m.access === 'send' ? 'Nur Senden – kein Abgleich' : m.last_sync_at ? `Letzter Abgleich ${dt(m.last_sync_at)} · ${m.messages} Nachrichten` : 'Noch nicht abgeglichen'}
                  {m.access === 'readonly' ? ' · nur lesen' : ''}
                  {m.access !== 'send' ? (m.push.active ? ' · Push aktiv' : ' · Abruf alle 3 Minuten') : ''}
                </div>
                {m.last_error && <div className="small" style={{ color: 'var(--red)' }}>{m.last_error}</div>}
                {m.push.error && !m.push.active && m.access !== 'send' && <div className="muted small">Push: {m.push.error}</div>}
              </div>
              {m.can_manage && (
                <div className="actions">
                  {m.needs_reconnect && (
                    <button className="btn small" onClick={() => connect(m.id)}>
                      Neu verbinden
                    </button>
                  )}
                  <button className="btn small secondary" disabled={busy === m.id || m.needs_reconnect} onClick={() => sync(m)}>
                    <Icon name="refresh" size={14} /> Jetzt abgleichen
                  </button>
                  <button className="btn small secondary" data-tour="mailbox-edit" onClick={() => setEditing(m)}>
                    Einstellungen
                  </button>
                  <button className="btn small danger" onClick={() => disconnect(m)}>
                    Trennen
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {!!scheduled.data?.length && (
        <>
          <hr />
          <h3>Geplante E-Mails</h3>
          {scheduled.data.map((x: any) => (
            <div key={x.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                {dt(x.send_at)} · {(x.to ?? []).map((a: any) => a.email ?? a).join(', ')} · <strong>{x.subject || '(kein Betreff)'}</strong> {x.status === 'failed' && <Badge tone="red">fehlgeschlagen: {x.error}</Badge>}
              </span>
              <button className="btn small secondary" onClick={async () => (await act(() => api.del(`/api/mail/scheduled/${x.id}`), 'Abgebrochen')) && scheduled.reload()}>
                Abbrechen
              </button>
            </div>
          ))}
        </>
      )}
      {editing && <MailboxEditor mb={editing} locations={s.data.locations} push={s.data.push} onClose={() => setEditing(null)} onChanged={() => void s.reload()} />}
    </div>
  );
}

function MailboxEditor({ mb, locations, push, onClose, onChanged }: { mb: any; locations: { id: string; name: string }[]; push: any; onClose: () => void; onChanged: () => void }) {
  useRestoreFocus();
  const folders = useLoad(() => (mb.can_read ? api.get<any>(`/api/mailboxes/${mb.id}/folders`) : Promise.resolve({ folders: [], labels: [], selected: [] })), [mb.id]);
  const [f, setF] = useState({ name: mb.name, enabled: mb.enabled, signature: mb.signature, window_days: String(mb.window_days), contact_policy: mb.contact_policy, skip_promotions: mb.skip_promotions, trigger_workflows: mb.trigger_workflows, track_engagement: !!mb.track_engagement, default_location_id: mb.default_location_id ?? '' });
  const [rules, setRules] = useState<any[]>(mb.rules ?? []);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const all: any[] = folders.data?.folders ?? [];
  const defaults = mb.provider === 'google' ? ['INBOX', 'SENT', 'DRAFT'] : all.filter((x) => x.system && ['inbox', 'sent', 'drafts', 'archive'].includes(x.kind)).map((x) => x.id);
  const current = picked ?? (mb.folders.length ? mb.folders : defaults);
  const toggle = (id: string, on: boolean) => setPicked(on ? [...new Set([...current, id])] : current.filter((x: string) => x !== id));
  const save = async () => {
    setSaving(true);
    const body: any = { name: f.name, enabled: f.enabled, signature: f.signature, window_days: Number(f.window_days), contact_policy: f.contact_policy, skip_promotions: f.skip_promotions, trigger_workflows: f.trigger_workflows, track_engagement: f.track_engagement };
    if (picked) body.folders = picked.sort().join() === [...defaults].sort().join() && !mb.folders.length ? [] : picked;
    if (mb.scope === 'user') {
      body.rules = rules.filter((r) => r.value && r.location_id);
      body.default_location_id = f.default_location_id;
    }
    const r = await act(() => api.patch(`/api/mailboxes/${mb.id}`, body), 'Gespeichert');
    setSaving(false);
    if (r) {
      onChanged();
      onClose();
    }
  };
  const pushNow = async (enable: boolean) => {
    if (await act(() => api.post(`/api/mailboxes/${mb.id}/push`, { enable }), enable ? 'Push eingerichtet' : 'Push ausgeschaltet')) onChanged();
  };
  const resync = async () => {
    if (!confirmAsk('Alle E-Mails im eingestellten Zeitraum noch einmal einlesen? Bereits bekannte Mails werden erkannt, nichts doppelt angelegt.')) return;
    const r = await act(() => api.post(`/api/mailboxes/${mb.id}/sync`, { full: true }));
    if (r) toast('Neu eingelesen');
    onChanged();
  };
  return (
    <Modal
      title={`Postfach: ${mb.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" disabled={saving} onClick={save}>
            Speichern
          </button>
          {mb.can_read && (
            <button className="btn secondary" onClick={resync}>
              Alles neu einlesen
            </button>
          )}
        </>
      }
    >
      <div className="grid2">
        <Field label="Name">
          <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} />
        </Field>
        <Field label="Abgleich-Zeitraum" hint="So weit zurück wird beim ersten Mal gelesen (und nach einer Änderung neu).">
          <div data-tour="mailbox-window">
            <Select value={f.window_days} onChange={(v) => setF({ ...f, window_days: v })} options={[['30', '30 Tage'], ['90', '90 Tage'], ['180', '180 Tage'], ['365', '1 Jahr']]} />
          </div>
        </Field>
      </div>
      <Check checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Postfach aktiv (Abgleich und Senden)" />
      <Field label="Signatur" hint="Wird unter E-Mails gesetzt, die du aus HyperLevel über dieses Postfach sendest.">
        <Textarea value={f.signature} onChange={(v) => setF({ ...f, signature: v })} rows={3} />
      </Field>
      <MoreFields id="mailbox-editor" values={[f.track_engagement, f.contact_policy !== 'all' && f.contact_policy, f.skip_promotions, f.trigger_workflows, picked, mb.folders]}>
      <div data-tour="mailbox-tracking">
        <Check checked={f.track_engagement} onChange={(v) => setF({ ...f, track_engagement: v })} label="Öffnungen und Klicks verfolgen" />
        <p className="muted small">Standard: aus. Eingeschaltet bekommen Mails aus HyperLevel ein Zählpixel und umgeleitete Links – das kann eine Einwilligung der Empfänger erfordern (Datenschutzerklärung).</p>
      </div>

      {mb.can_read && (
        <>
          <h3>{mb.provider === 'google' ? 'Labels' : 'Ordner'}, die abgeglichen werden</h3>
          <div data-tour="mailbox-folders">
            {folders.loading && !folders.data ? (
              <Spinner />
            ) : folders.error ? (
              <p className="small" style={{ color: 'var(--red)' }}>{folders.error}</p>
            ) : (
              <div className="check-list">
                {all.map((x) => (
                  <Check key={x.id} checked={current.includes(x.id)} onChange={(on) => toggle(x.id, on)} label={x.name} />
                ))}
              </div>
            )}
          </div>
          <p className="muted small">Spam und Papierkorb werden nie importiert. Ohne Auswahl: Posteingang, Gesendet und Entwürfe{mb.provider === 'microsoft' ? ' (und Archiv)' : ''}.</p>
          <div className="grid2">
            <Field label="Absender">
              <Select value={f.contact_policy} onChange={(v) => setF({ ...f, contact_policy: v })} options={[['all', 'Alle Absender (neue Kontakte werden angelegt)'], ['known', 'Nur Kontakte, die es schon gibt']]} />
            </Field>
            <div>
              {mb.provider === 'google' && <Check checked={!!f.skip_promotions} onChange={(v) => setF({ ...f, skip_promotions: v })} label="Werbung und soziale Benachrichtigungen (Gmail-Kategorien) überspringen" />}
              <Check checked={!!f.trigger_workflows} onChange={(v) => setF({ ...f, trigger_workflows: v })} label="Neue eingehende Mails starten Automationen („Nachricht empfangen“)" />
            </div>
          </div>
        </>
      )}
      </MoreFields>

      {mb.scope === 'user' && (
        <>
          <h3>Welche Mail in welchen Sub-Account kommt</h3>
          <p className="muted small">Persönliche Postfächer importieren nur, was eine Regel trifft (die erste passende gewinnt) – oder alles Übrige in den Standard-Sub-Account. So landet nichts Privates im CRM.</p>
          {rules.map((r, i) => (
            <div key={i} className="mbx-rule">
              <Select value={r.field} onChange={(v) => setRules(rules.map((x, j) => (j === i ? { ...x, field: v } : x)))} options={[['address', 'Adresse ist'], ['domain', 'Domain ist'], ['subject', 'Betreff enthält'], ['any', 'Text enthält']]} />
              <Input value={r.value} onChange={(v) => setRules(rules.map((x, j) => (j === i ? { ...x, value: v } : x)))} placeholder="z. B. kunde.de" />
              <Select value={r.location_id} onChange={(v) => setRules(rules.map((x, j) => (j === i ? { ...x, location_id: v } : x)))} options={locations.map((l) => [l.id, l.name] as [string, string])} />
              <button className="icon-btn" aria-label="Regel entfernen" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          <button className="btn small secondary" onClick={() => setRules([...rules, { field: 'domain', value: '', location_id: locations[0]?.id ?? '' }])}>
            + Regel
          </button>
          <Field label="Alles andere">
            <Select value={f.default_location_id} onChange={(v) => setF({ ...f, default_location_id: v })} options={locations.map((l) => [l.id, `in „${l.name}“ ablegen`] as [string, string])} placeholder="Nicht importieren" />
          </Field>
        </>
      )}

      {mb.can_read && (
        <>
          <h3>Push</h3>
          <p className="muted small">
            {mb.push.active ? `Push ist aktiv (${mb.push.kind === 'gmail_watch' ? 'Gmail → Pub/Sub' : 'Microsoft-Benachrichtigungen'}) – neue Mails erscheinen in Sekunden.` : `Kein Push: HyperLevel fragt alle 3 Minuten nach. ${mb.push.error ?? ''}`}
            {mb.provider === 'google' && !push?.gmail && ' Für Gmail-Push trägt die Agentur ein Pub/Sub-Thema ein (Agentur → Integrationen).'}
            {mb.provider === 'microsoft' && !push?.graph && ' Microsoft-Push braucht eine öffentliche https-Adresse.'}
          </p>
          <div className="actions">
            <button className="btn small secondary" onClick={() => pushNow(true)}>
              Push (neu) einrichten
            </button>
            {mb.push.active && (
              <button className="btn small secondary" onClick={() => pushNow(false)}>
                Push ausschalten
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

/** Provider "Verbundenes Postfach" in E-Mail & SMS: which mailbox sends the sub-account's e-mails (workflows, campaigns, the composer). */
export function MailboxTransportPanel({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const l = useLoad(() => api.get<any[]>('/api/mail/mailboxes'), []);
  const boxes = (l.data ?? []).filter((m) => m.scope === 'location' && m.can_send && m.enabled);
  return (
    <div data-tour="mailbox-transport">
      <p className="muted small">Alle E-Mails dieses Sub-Accounts (Automationen, Kampagnen, Nachrichten im Posteingang) gehen über das gewählte Postfach – sie erscheinen in dessen „Gesendet“.</p>
      <Field label="Postfach">
        <Select value={value} onChange={onChange} options={boxes.map((m) => [m.id, `${m.name} (${m.address})`] as [string, string])} placeholder="Postfach wählen …" />
      </Field>
      {l.data && !boxes.length && <p className="small" style={{ color: 'var(--red)' }}>Kein Sub-Account-Postfach mit Senderecht verbunden – unten „Postfach verbinden“.</p>}
    </div>
  );
}

// --- Agentur → Integrationen ---------------------------------------------------------------------------------------------

export function MailboxAgencyCard() {
  const s = useLoad(() => api.get<any>('/api/agency/mailbox-push'), []);
  const [f, setF] = useState({ gmail_topic: '', service_account: '', audience: '' });
  useEffect(() => {
    if (s.data) setF({ gmail_topic: s.data.gmail.topic, service_account: s.data.gmail.service_account, audience: s.data.gmail.audience });
  }, [s.data]);
  if (!s.data) return s.error ? <p style={{ color: 'var(--red)' }}>{s.error}</p> : <Spinner />;
  const d = s.data;
  const save = async (extra: any = {}) => {
    const r = await act(() => api.put('/api/agency/mailbox-push', { ...f, ...extra }), 'Gespeichert');
    if (r) s.setData(r);
  };
  return (
    <div className="card" data-tour="mailbox-agency">
      <h2>
        <Icon name="email" size={18} /> Postfach-Sync: Push (Gmail & Outlook)
      </h2>
      <p className="muted small">
        Ohne diese Einstellungen funktioniert der Postfach-Sync trotzdem: HyperLevel fragt dann alle 3 Minuten nach neuen Mails. Mit Push erscheinen sie in Sekunden. Postfächer verbindet jedes Team unter <em>Einstellungen → E-Mail & SMS</em> mit der Google-/Microsoft-App von oben (zusätzliche Berechtigungen: Gmail <code>gmail.modify</code>, <code>gmail.send</code> bzw. Graph <code>Mail.ReadWrite</code>, <code>Mail.Send</code>; dieselben Weiterleitungs-URIs). Anleitung: <code>docs/mailbox-sync.md</code>.
      </p>
      <div className="grid2">
        <div>
          <h3>
            Gmail → Pub/Sub {d.gmail.ready ? <Badge tone="green">Thema eingetragen</Badge> : <Badge>aus</Badge>} {d.active.gmail ? <Badge tone="blue">{d.active.gmail} aktiv</Badge> : null}
          </h3>
          <Field label="Pub/Sub-Thema" hint="projects/<projekt>/topics/<name> – Google-Konto gmail-api-push@system.gserviceaccount.com braucht dort die Rolle „Pub/Sub-Publisher“.">
            <Input value={f.gmail_topic} onChange={(v) => setF({ ...f, gmail_topic: v })} placeholder="projects/mein-projekt/topics/gmail-push" />
          </Field>
          <Field label="Dienstkonto der Push-Subscription" hint="Pub/Sub signiert jeden Aufruf mit einem OpenID-Token dieses Dienstkontos; nur dann wird er per Token akzeptiert.">
            <Input value={f.service_account} onChange={(v) => setF({ ...f, service_account: v })} placeholder="push@mein-projekt.iam.gserviceaccount.com" />
          </Field>
          <Field label="Zielgruppe (audience), optional" hint={`Leer = ${d.gmail.endpoint_url}`}>
            <Input value={f.audience} onChange={(v) => setF({ ...f, audience: v })} />
          </Field>
          <Field label="Push-Endpunkt der Subscription (mit geheimem Schlüssel)">
            <CodeBox text={d.gmail.push_url} />
          </Field>
          <p className="muted small">{d.gmail.jwt_ready ? 'Token-Prüfung aktiv (Zielgruppe + Dienstkonto).' : 'Ohne Dienstkonto gilt nur der geheime Schlüssel in der Adresse.'}</p>
        </div>
        <div>
          <h3>
            Microsoft Graph {d.graph.ready ? <Badge tone="green">bereit</Badge> : <Badge>nicht möglich</Badge>} {d.active.graph ? <Badge tone="blue">{d.active.graph} aktiv</Badge> : null}
          </h3>
          {d.graph.ready ? (
            <>
              <p className="muted small">Wird je Postfach automatisch eingerichtet (Abo mit geheimem clientState, wird vor Ablauf erneuert). Nichts einzutragen.</p>
              <Field label="Benachrichtigungs-URL">
                <CodeBox text={d.graph.notification_url} />
              </Field>
              <Field label="Lifecycle-URL">
                <CodeBox text={d.graph.lifecycle_url} />
              </Field>
            </>
          ) : (
            <p className="muted small">{d.graph.reason}</p>
          )}
        </div>
      </div>
      <div className="actions">
        <button className="btn" onClick={() => save()}>
          Speichern
        </button>
        <button className="btn secondary" onClick={() => confirmAsk('Neuen geheimen Schlüssel erzeugen? Die Push-Adresse der Subscription muss dann neu eingetragen werden.') && save({ rotate_secret: true })}>
          Schlüssel erneuern
        </button>
      </div>
    </div>
  );
}

// --- Konversationen: filter, badges, thread actions ------------------------------------------------------------------------

/** Mailbox filter and folder tabs above the conversation list; nothing is shown while no mailbox is connected. */
export function MailboxBar({ mailbox, folder, onChange }: { mailbox: string; folder: string; onChange: (mailbox: string, folder: string) => void }) {
  const boxes = useLoad(() => api.get<any[]>('/api/mail/mailboxes').catch(() => []), []);
  const list = (boxes.data ?? []).filter((m) => m.can_read && m.enabled);
  if (!list.length) return null;
  const one = mailbox && mailbox !== 'any';
  return (
    <div className="mbx-bar" data-tour="inbox-mailbox">
      <Select
        value={mailbox}
        onChange={(v) => onChange(v, v && v !== 'any' ? folder || 'inbox' : '')}
        options={[['', 'Alle Konversationen'], ['any', 'Nur Postfach-Mails'], ...list.map((m) => [m.id, `${PROVIDER[m.provider]}: ${m.name}`] as [string, string])]}
      />
      {one && (
        <div className="chips mbx-folders">
          {['inbox', 'archive', 'sent', 'drafts', 'all'].map((k) => (
            <button key={k} className={`chip${folder === k ? ' on' : ''}`} onClick={() => onChange(mailbox, k)}>
              {FOLDER[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Folder and label badges of a conversation in the list. */
export function MailBadges({ row }: { row: any }) {
  const m = row?.mail;
  if (!m) return null;
  const names = (m.labels ?? []).slice(0, 3).map((id: string) => m.label_names?.[id] ?? id);
  return (
    <span className="mbx-badges">
      {m.folder !== 'inbox' && <Badge tone={m.folder === 'archive' ? 'gray' : 'purple'}>{FOLDER[m.folder] ?? m.folder}</Badge>}
      {names.map((n: string) => (
        <Badge key={n} tone="blue">
          {n}
        </Badge>
      ))}
    </span>
  );
}

/** Attachments, labels and (for drafts in a mailbox) send / edit / discard under a message. */
export function MailMessageExtras({ m, contact, onChanged }: { m: any; contact: any; onChanged: () => void }) {
  const [edit, setEdit] = useState(false);
  const mail = m.mail;
  if (!mail) return null;
  const files = (mail.attachments ?? []).filter((a: any) => a.url);
  const labels = (mail.labels ?? []).map((id: string) => mail.label_names?.[id] ?? id);
  return (
    <>
      {(files.length > 0 || labels.length > 0) && (
        <div className="mbx-extras">
          {files.map((a: any) => (
            <a key={a.url} className="chip small" href={a.url} download={a.name} data-tour="mail-attachment">
              <Icon name="file" size={12} /> {a.name} <span className="muted">{size(a.size)}</span>
            </a>
          ))}
          {labels.map((l: string) => (
            <Badge key={l} tone="blue">
              {l}
            </Badge>
          ))}
        </div>
      )}
      {m.status === 'draft' && (
        <div className="actions" style={{ marginTop: 6 }}>
          <button
            className="btn small"
            onClick={async () => {
              if (!confirmAsk(`Entwurf jetzt über das Postfach an ${contact?.email || 'den Kontakt'} senden?`)) return;
              if (await act(() => api.post(`/api/mail/drafts/${m.id}/send`, {}), 'Gesendet')) onChanged();
            }}
          >
            Senden
          </button>
          <button className="btn small secondary" onClick={() => setEdit(true)}>
            Bearbeiten
          </button>
          <button
            className="btn small secondary"
            onClick={async () => {
              if (confirmAsk('Entwurf verwerfen? Er wird auch im Postfach gelöscht.') && (await act(() => api.del(`/api/mail/drafts/${m.id}`), 'Verworfen'))) onChanged();
            }}
          >
            Verwerfen
          </button>
        </div>
      )}
      {edit && <DraftEditor m={m} contact={contact} onClose={() => setEdit(false)} onSaved={() => (setEdit(false), onChanged())} />}
    </>
  );
}

function DraftEditor({ m, contact, onClose, onSaved }: { m: any; contact: any; onClose: () => void; onSaved: () => void }) {
  useRestoreFocus();
  const [f, setF] = useState({ to: (m.mail.to ?? []).map((a: any) => a.email).join(', ') || contact?.email || '', cc: (m.mail.cc ?? []).map((a: any) => a.email).join(', '), subject: m.subject ?? '', body: m.body ?? '' });
  return (
    <Modal
      title="Entwurf bearbeiten"
      onClose={onClose}
      footer={
        <button
          className="btn"
          onClick={async () => (await act(() => api.put(`/api/mail/drafts/${m.id}`, { ...f, signature: false }), 'Entwurf gespeichert')) && onSaved()}
        >
          Speichern
        </button>
      }
    >
      <Field label="An">
        <Input value={f.to} onChange={(v) => setF({ ...f, to: v })} />
      </Field>
      <Field label="Cc">
        <Input value={f.cc} onChange={(v) => setF({ ...f, cc: v })} />
      </Field>
      <Field label="Betreff">
        <Input value={f.subject} onChange={(v) => setF({ ...f, subject: v })} />
      </Field>
      <Field label="Nachricht">
        <Textarea value={f.body} onChange={(v) => setF({ ...f, body: v })} rows={8} />
      </Field>
    </Modal>
  );
}

/** Archive, labels and "answer through the mailbox" for the open conversation. */
export function MailThreadPanel({ conversationId, contact, messages, onChanged }: { conversationId: string; contact: any; messages: any[]; onChanged: () => void }) {
  const info = useLoad(() => api.get<any>(`/api/mail/conversations/${conversationId}`), [conversationId, messages.length]);
  const [reply, setReply] = useState(false);
  const data = info.data;
  const modifiable = (data?.mailboxes ?? []).filter((m: any) => m.in_thread && m.can_modify);
  const labelBox = modifiable[0]?.id as string | undefined;
  const labels = useLoad(() => (labelBox ? api.get<any[]>(`/api/mail/mailboxes/${labelBox}/labels`) : Promise.resolve([])), [labelBox]);
  const [newLabel, setNewLabel] = useState('');
  if (!data) return null;
  const senders = data.mailboxes.filter((m: any) => m.can_send);
  if (!data.has_mail && !senders.length) return null;
  const mine = new Set<string>(messages.flatMap((m) => m.mail?.labels ?? []));
  const names: Record<string, string> = Object.assign({}, ...messages.map((m) => m.mail?.label_names ?? {}));
  const run = async (fn: () => Promise<any>, ok: string) => {
    const r = await act(fn, ok);
    if (r) {
      void info.reload();
      onChanged();
    }
  };
  return (
    <div className="mbx-thread" data-tour="inbox-mail-actions">
      <div className="row mbx-actions">
        {data.has_mail && (
          <>
            {data.mailboxes.filter((m: any) => m.in_thread).map((m: any) => (
              <span key={m.id} className="muted small">
                <Icon name="email" size={12} /> {m.name}
              </span>
            ))}
            {modifiable.length > 0 && (
              <>
                <button className="btn small secondary" data-tour="mail-archive" onClick={() => run(() => api.post(`/api/mail/conversations/${conversationId}/archive`, { archive: !data.archived }), data.archived ? 'Zurück im Posteingang' : 'Archiviert')}>
                  <Icon name="archive" size={14} /> {data.archived ? 'Zurück in den Posteingang' : 'Archivieren'}
                </button>
                <details className="mbx-labels" data-tour="mail-labels">
                  <summary className="btn small secondary">
                    <Icon name="tag" size={14} /> Labels
                  </summary>
                  <div className="mbx-pop">
                    <div className="check-list">
                      {(labels.data ?? []).map((l: any) => (
                        <Check key={l.id} checked={mine.has(l.id)} onChange={(on) => run(() => api.post(`/api/mail/conversations/${conversationId}/labels`, on ? { add: [l.id] } : { remove: [l.id] }), 'Label geändert')} label={l.name} />
                      ))}
                      {[...mine].filter((id) => !(labels.data ?? []).some((l: any) => l.id === id)).map((id) => (
                        <Check key={id} checked onChange={() => run(() => api.post(`/api/mail/conversations/${conversationId}/labels`, { remove: [id] }), 'Label entfernt')} label={names[id] ?? id} />
                      ))}
                    </div>
                    <div className="row">
                      <Input value={newLabel} onChange={setNewLabel} placeholder="Neues Label" />
                      <button
                        className="btn small"
                        disabled={!newLabel.trim()}
                        onClick={async () => {
                          const made = await act(() => api.post<any>(`/api/mail/mailboxes/${labelBox}/labels`, { name: newLabel.trim() }));
                          if (made) {
                            setNewLabel('');
                            await run(() => api.post(`/api/mail/conversations/${conversationId}/labels`, { add: [made.id] }), 'Label gesetzt');
                            void labels.reload();
                          }
                        }}
                      >
                        Anlegen
                      </button>
                    </div>
                  </div>
                </details>
              </>
            )}
          </>
        )}
        {senders.length > 0 && contact?.email && (
          <button className="btn small" data-tour="mail-reply-toggle" onClick={() => setReply(!reply)}>
            <Icon name="send" size={14} /> {reply ? 'Antwort schließen' : 'Per Postfach antworten'}
          </button>
        )}
      </div>
      {reply && <MailReply conversationId={conversationId} info={data} contact={contact} onDone={() => (setReply(false), onChanged())} />}
    </div>
  );
}

function MailReply({ conversationId, info, contact, onDone }: { conversationId: string; info: any; contact: any; onDone: () => void }) {
  const senders = info.mailboxes.filter((m: any) => m.can_send);
  const first = senders.find((m: any) => m.in_thread) ?? senders[0];
  const [f, setF] = useState({ mailbox_id: first?.id ?? '', to: info.reply.to || contact?.email || '', cc: '', bcc: '', subject: '', body: '', signature: true, track: true, send_at: '' });
  const [files, setFiles] = useState<{ filename: string; content_base64: string; content_type: string; size: number }[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const tracked = !!senders.find((m: any) => m.id === f.mailbox_id)?.track_engagement;
  const common = () => ({ mailbox_id: f.mailbox_id, to: f.to, cc: f.cc, bcc: f.bcc, subject: f.subject || undefined, body: f.body, signature: f.signature, ...(tracked && !f.track ? { track: false } : {}), attachments: files.map(({ size: _s, ...a }) => a) });
  const send = async () => {
    setBusy(true);
    const at = f.send_at ? new Date(f.send_at).toISOString() : undefined;
    const r = await act(() => api.post<any>(`/api/mail/conversations/${conversationId}/reply`, { ...common(), ...(at ? { send_at: at } : {}) }));
    setBusy(false);
    if (r) {
      toast(r.status === 'scheduled' ? `Geplant für ${dt(r.send_at)}` : 'Gesendet');
      onDone();
    }
  };
  const draft = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/mail/drafts', { ...common(), reply_to_message_id: info.reply.reply_to_message_id ?? undefined, contact_id: contact?.id }), 'Entwurf im Postfach gespeichert');
    setBusy(false);
    if (r) onDone();
  };
  return (
    <div className="mbx-reply" data-tour="inbox-mail-reply">
      <div className="grid2">
        <Field label="Absender-Postfach">
          <Select value={f.mailbox_id} onChange={(v) => setF({ ...f, mailbox_id: v })} options={senders.map((m: any) => [m.id, `${m.name} (${m.address})`] as [string, string])} />
        </Field>
        <Field label="An">
          <Input value={f.to} onChange={(v) => setF({ ...f, to: v })} />
        </Field>
      </div>
      {more && (
        <div className="grid2">
          <Field label="Cc">
            <Input value={f.cc} onChange={(v) => setF({ ...f, cc: v })} />
          </Field>
          <Field label="Bcc">
            <Input value={f.bcc} onChange={(v) => setF({ ...f, bcc: v })} />
          </Field>
        </div>
      )}
      <Field label="Betreff" hint="Leer = „Re: …“ der Mail, auf die du antwortest.">
        <Input value={f.subject} onChange={(v) => setF({ ...f, subject: v })} />
      </Field>
      <Field label="Nachricht">
        <Textarea value={f.body} onChange={(v) => setF({ ...f, body: v })} rows={5} />
      </Field>
      <div className="row mbx-reply-opts">
        <button className="btn small secondary" onClick={() => setMore(!more)}>
          {more ? 'Cc/Bcc ausblenden' : 'Cc/Bcc'}
        </button>
        <button className="btn small secondary" onClick={() => input.current?.click()}>
          <Icon name="file" size={14} /> Anhang
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={async (e) => {
            try {
              const list = await Promise.all([...(e.target.files ?? [])].map(async (x) => ({ filename: x.name, content_base64: await fileToBase64(x), content_type: x.type || 'application/octet-stream', size: x.size })));
              setFiles([...files, ...list]);
            } catch (err) {
              toastError(err);
            }
            e.target.value = '';
          }}
        />
        <Check checked={f.signature} onChange={(v) => setF({ ...f, signature: v })} label="Signatur" />
        {tracked && <Check checked={f.track} onChange={(v) => setF({ ...f, track: v })} label="Öffnungen und Klicks verfolgen" />}
        <label className="mbx-later">
          Später senden <input type="datetime-local" value={f.send_at} onChange={(e) => setF({ ...f, send_at: e.target.value })} />
        </label>
      </div>
      {files.length > 0 && (
        <div className="mbx-extras">
          {files.map((x, i) => (
            <span key={i} className="chip small">
              <Icon name="file" size={12} /> {x.filename} <span className="muted">{size(x.size)}</span>
              <button type="button" className="icon-btn" aria-label={`${x.filename} entfernen`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="actions">
        <button className="btn" disabled={busy || !f.body.trim() || !f.to.trim()} onClick={send}>
          {f.send_at ? 'Planen' : 'Senden'}
        </button>
        <button className="btn secondary" disabled={busy || !f.body.trim() || !f.to.trim()} onClick={draft}>
          Als Entwurf speichern
        </button>
      </div>
    </div>
  );
}

