import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { api, dt } from '../api';
import { Badge, CodeBox, Field, Input, MergeHint, Select, Spinner, Textarea, act, confirmAsk, useLoad } from '../ui';
import { MoreFields, ProOnly } from '../areas/fields';
import { ChannelIcon, TemplatePreview, TemplateSlots } from './MetaInbox';
import { SignupLink } from '../referrals';

/** Einstellungen → Kanäle: WhatsApp Business, Facebook Messenger and Instagram Direct (Meta). */

type Result = { ok: boolean; info?: string; error?: string };
const EMPTY_FORM = { wa_phone_number_id: '', wa_business_account_id: '', wa_token: '', page_id: '', page_token: '', ig_account_id: '', app_secret: '', api_version: 'v21.0' };

function ResultLine({ r }: { r?: Result }) {
  if (!r) return null;
  return <div className={`meta-result ${r.ok ? 'ok' : 'err'}`}>{r.ok ? <><Icon name="ok" size={14} /> {r.info}</> : <><Icon name="fail" size={14} /> {r.error}</>}</div>;
}

export function MetaSettings() {
  const s = useLoad(() => api.get('/api/settings/meta'), []);
  const [f, setF] = useState(EMPTY_FORM);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState('');
  useEffect(() => {
    const d = s.data;
    if (!d) return;
    setF({ ...EMPTY_FORM, wa_phone_number_id: d.whatsapp.phone_number_id, wa_business_account_id: d.whatsapp.business_account_id, page_id: d.messenger.page_id, ig_account_id: d.instagram.account_id, api_version: d.api_version });
  }, [s.data]);
  if (!s.data) return s.error ? <p className="muted">{s.error}</p> : <Spinner />;
  const d = s.data;
  const set = (patch: Partial<typeof EMPTY_FORM>) => setF({ ...f, ...patch });

  const save = async (extra: Record<string, any> = {}, ok = 'Gespeichert') => {
    // Empty secret fields keep what is stored.
    const body: Record<string, any> = { ...f, ...extra };
    for (const k of ['wa_token', 'page_token', 'app_secret']) if (body[k] === '') delete body[k];
    const r = await act(() => api.put('/api/settings/meta', body), ok);
    if (r) {
      s.setData(r);
      setF((cur) => ({ ...cur, wa_token: '', page_token: '', app_secret: '' }));
    }
    return r;
  };
  const run = async (what: 'test' | 'subscribe') => {
    setBusy(what);
    if (await save({}, '')) {
      const r = await act(() => api.post(`/api/settings/meta/${what}`));
      if (r) {
        setResults(r.results);
        if (r.settings) s.setData(r.settings);
      }
    }
    setBusy('');
  };
  const disconnect = async (which: 'whatsapp' | 'page') => {
    if (!confirmAsk(which === 'whatsapp' ? 'WhatsApp trennen? Bisherige Nachrichten bleiben erhalten.' : 'Messenger und Instagram trennen? Bisherige Nachrichten bleiben erhalten.')) return;
    const patch = which === 'whatsapp' ? { wa_phone_number_id: '', wa_business_account_id: '', wa_token: null } : { page_id: '', ig_account_id: '', page_token: null };
    const r = await act(() => api.put('/api/settings/meta', patch), 'Getrennt');
    if (r) (s.setData(r), setResults({}));
  };
  const status = (on: boolean, label?: string) => (on ? <Badge tone="green">verbunden{label ? ` · ${label}` : ''}</Badge> : <Badge>nicht eingerichtet</Badge>);

  return (
    <div className="meta-settings">
      <div className="card" data-tour="meta-webhook">
        <h2>
          <Icon name="webhook" size={18} /> Webhook in der Meta-App
        </h2>
        <p className="muted small">
          In der App auf developers.facebook.com unter <b>WhatsApp → Konfiguration</b> bzw. <b>Messenger/Instagram → Webhooks</b> eintragen und das Feld <code>messages</code> abonnieren. Eine Schritt-für-Schritt-Anleitung steht in <code>docs/meta-channels.md</code>. <SignupLink id="meta" />
        </p>
        <MoreFields id="meta-webhook" label="Webhook-Angaben" values={[!d.last_webhook_at || !d.app_secret_set || !!d.last_error]}>
        <div className="grid2">
          <Field label="Rückruf-URL (Callback URL)">
            <CodeBox text={d.webhook_url} />
          </Field>
          <Field label="Verify-Token">
            <CodeBox text={d.verify_token} />
          </Field>
        </div>
        <div className="grid2">
          <Field label="App-Secret" hint="Meta-App → Einstellungen → Allgemein. Damit wird jede eingehende Nachricht geprüft – ohne Secret wird nichts angenommen.">
            <Input type="password" autoComplete="new-password" value={f.app_secret} onChange={(v) => set({ app_secret: v })} placeholder={d.app_secret_set ? '•••••• gespeichert – leer lassen zum Behalten' : 'App-Secret einfügen'} />
          </Field>
          <div className="meta-hook-state">
            {d.last_webhook_at ? <Badge tone="green">Letzter Eingang {dt(d.last_webhook_at)}</Badge> : <Badge>Noch nichts empfangen</Badge>}
            {d.last_error && <div className="meta-result err">{d.last_error}</div>}
            <button className="btn small secondary" onClick={() => confirmAsk('Neuen Verify-Token erzeugen? Danach muss er in der Meta-App neu eingetragen werden.') && save({ regenerate_verify_token: true }, 'Neuer Verify-Token')}>
              Neuen Verify-Token erzeugen
            </button>
          </div>
        </div>
        </MoreFields>
      </div>

      <div className="row" style={{ alignItems: 'stretch' }}>
        <div className="card" style={{ flex: '1 1 380px' }} data-tour="meta-whatsapp">
          <h2 className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <span>
              <ChannelIcon channel="whatsapp" size={18} /> WhatsApp Business
            </span>
            {status(d.whatsapp.configured, d.whatsapp.display_phone || undefined)}
          </h2>
          {d.whatsapp.verified_name && <p className="muted small">Anzeigename: {d.whatsapp.verified_name}</p>}
          <Field label="Telefonnummer-ID" hint="WhatsApp → API-Einrichtung: „Phone number ID“ (nicht die Telefonnummer selbst)">
            <Input value={f.wa_phone_number_id} onChange={(v) => set({ wa_phone_number_id: v })} placeholder="z. B. 106540352242922" inputMode="numeric" />
          </Field>
          <Field label="WhatsApp-Business-Konto-ID" hint="„WhatsApp Business Account ID“ – nötig für Vorlagen">
            <Input value={f.wa_business_account_id} onChange={(v) => set({ wa_business_account_id: v })} placeholder="z. B. 102290129340398" inputMode="numeric" />
          </Field>
          <Field label="Dauerhafter Zugriffstoken" hint="Von einem System-Benutzer im Business-Manager (läuft nicht ab), Rechte whatsapp_business_messaging + whatsapp_business_management">
            <Input type="password" autoComplete="new-password" value={f.wa_token} onChange={(v) => set({ wa_token: v })} placeholder={d.whatsapp.token_set ? '•••••• gespeichert – leer lassen zum Behalten' : 'EAAG…'} />
          </Field>
          <ResultLine r={results.whatsapp} />
          {(d.whatsapp.configured || d.whatsapp.phone_number_id) && (
            <button className="btn small secondary" onClick={() => disconnect('whatsapp')}>
              WhatsApp trennen
            </button>
          )}
        </div>

        <div className="card" style={{ flex: '1 1 380px' }} data-tour="meta-messenger">
          <h2 className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <span>
              <ChannelIcon channel="messenger" size={18} /> Messenger <span className="muted">&amp;</span> <ChannelIcon channel="instagram" size={18} /> Instagram
            </span>
            {status(d.messenger.configured || d.instagram.configured)}
          </h2>
          <p className="muted small">
            {d.messenger.page_name ? <>Seite „{d.messenger.page_name}“</> : 'Facebook-Seite'}
            {d.instagram.username ? <> · Instagram @{d.instagram.username}</> : ''}
          </p>
          <Field label="Seiten-ID" hint="Facebook-Seite → Info → Seitentransparenz, oder Meta Business Suite">
            <Input value={f.page_id} onChange={(v) => set({ page_id: v })} placeholder="z. B. 112233445566778" inputMode="numeric" />
          </Field>
          <Field label="Seiten-Zugriffstoken" hint="Dauerhafter Token der Seite (System-Benutzer), Rechte pages_messaging (+ instagram_manage_messages für Instagram)">
            <Input type="password" autoComplete="new-password" value={f.page_token} onChange={(v) => set({ page_token: v })} placeholder={d.messenger.token_set ? '•••••• gespeichert – leer lassen zum Behalten' : 'EAAG…'} />
          </Field>
          <Field label="Instagram-Konto-ID (optional)" hint="ID des Instagram-Profi-Kontos, das mit der Seite verknüpft ist">
            <Input value={f.ig_account_id} onChange={(v) => set({ ig_account_id: v })} placeholder="z. B. 17841400000000000" inputMode="numeric" />
          </Field>
          <ResultLine r={results.messenger} />
          <ResultLine r={results.instagram} />
          {(d.messenger.configured || d.messenger.page_id) && (
            <button className="btn small secondary" onClick={() => disconnect('page')}>
              Messenger &amp; Instagram trennen
            </button>
          )}
        </div>
      </div>

      <div className="card" data-tour="meta-actions">
        <div className="actions" style={{ flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => save()}>
            Speichern
          </button>
          <button className="btn secondary" disabled={!!busy} onClick={() => run('test')}>
            {busy === 'test' ? 'Prüfe…' : 'Verbindung testen'}
          </button>
          <button className="btn secondary" disabled={!!busy} onClick={() => run('subscribe')} title="Abonniert die App für das WhatsApp-Konto (mit dieser Rückruf-URL) und für die Facebook-Seite">
            {busy === 'subscribe' ? 'Abonniere…' : 'Webhooks bei Meta abonnieren'}
          </button>
          <ProOnly>
            <label className="row" style={{ alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
              <span className="muted small">Graph-API</span>
              <span style={{ width: 90 }}>
                <Input value={f.api_version} onChange={(v) => set({ api_version: v })} />
              </span>
            </label>
          </ProOnly>
        </div>
        <ResultLine r={results.webhook} />
        <p className="muted small" style={{ marginBottom: 0 }}>
          <b>Kosten:</b> Antworten im 24-Stunden-Fenster sind kostenlos, WhatsApp-Vorlagen außerhalb kosten je Nachricht (Meta-Preisliste). Messenger und Instagram sind kostenlos.
        </p>
      </div>
    </div>
  );
}

/** Workflow step „WhatsApp senden“: text in the 24-hour window, otherwise (or always) a template. */
export function WhatsAppStep({ step, set }: { step: any; set: (p: any) => void }) {
  const mode = step.mode ?? 'auto';
  const tpls = useLoad(() => (mode === 'text' ? Promise.resolve([] as any[]) : api.get<any[]>('/api/messages/meta/templates')), [mode]);
  const chosen = (tpls.data ?? []).find((t) => t.name === step.template && (!step.language || t.language === step.language));
  return (
    <>
      <Field label="Senden als">
        <Select
          value={mode}
          onChange={(v) => set({ mode: v })}
          options={[
            ['auto', 'Text im 24-h-Fenster, sonst Vorlage'],
            ['text', 'Nur Text (klappt nur im 24-h-Fenster)'],
            ['template', 'Immer Vorlage'],
          ]}
        />
      </Field>
      {mode !== 'template' && (
        <Field label="Text">
          <Textarea value={step.body} onChange={(v) => set({ body: v })} rows={4} />
        </Field>
      )}
      {mode !== 'text' && (
        <>
          {tpls.loading && !tpls.data ? (
            <Spinner />
          ) : tpls.error ? (
            <p className="muted small">Vorlagen nicht geladen: {tpls.error}</p>
          ) : (
            <Field label={mode === 'auto' ? 'Vorlage (außerhalb des Fensters)' : 'Vorlage'}>
              <Select
                value={step.template ? `${step.template}|${step.language ?? ''}` : ''}
                onChange={(v) => {
                  const [name, language] = v.split('|');
                  set({ template: name || '', language: language || '', values: {} });
                }}
                placeholder="wählen…"
                options={(tpls.data ?? []).filter((t) => t.supported).map((t) => [`${t.name}|${t.language}`, `${t.name} (${t.language})`])}
              />
            </Field>
          )}
          {chosen && (
            <>
              <TemplatePreview t={chosen} values={step.values ?? {}} />
              <TemplateSlots t={chosen} values={step.values ?? {}} onChange={(values) => set({ values })} hint="Text oder {{contact.first_name}}" />
            </>
          )}
        </>
      )}
      <MergeHint />
    </>
  );
}
