import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Icon, channelIcon } from '../icons';
import { api, currentLocation } from '../api';
import { Input, Link, Select, Spinner, Textarea, act, confirmAsk, toast, useLoad } from '../ui';
import { ChannelMedia, useMoreChannels } from './ChannelInbox';
import { useT } from '../i18n';
import { DraftOffer, finishDraft, useDraftFill, type ComposerDraft } from './MsgDrafts';

/**
 * WhatsApp, Messenger and Instagram inside Konversationen: channel badges and filter, media in
 * bubbles, and the composer panel with the 24-hour window and WhatsApp templates.
 */

export const META_CHANNELS = ['whatsapp', 'messenger', 'instagram'] as const;
export const CHANNEL_LABELS: Record<string, string> = { email: 'E-Mail', sms: 'SMS', chat: 'Website-Chat', call: 'Anruf', whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram', telegram: 'Telegram', discord: 'Discord', push: 'Push', comment: 'Kommentare' };

/** Channel icon in the platform's colour. */
export function ChannelIcon({ channel, size = 14 }: { channel: string; size?: number }) {
  return <Icon name={channelIcon(channel)} size={size} className={`ico chan-ico chan-${channel}`} aria-label={CHANNEL_LABELS[channel] ?? channel} />;
}

const FILTERS: [string, string][] = [['', 'Alle'], ['email', ''], ['sms', ''], ['chat', ''], ['call', ''], ['whatsapp', ''], ['messenger', ''], ['instagram', ''], ['telegram', ''], ['discord', ''], ['comment', '']];

/** Chips above the conversation list: all channels or just one. */
export function ChannelFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // Translated in phase 1 with the inbox (inbox catalog); the channel names are German message ids there.
  const t = useT('inbox');
  return (
    <div className="chan-filter" role="group" aria-label={t('Kanal')}>
      {FILTERS.map(([k, label]) => (
        <button key={k || 'all'} type="button" className={`chan-chip${value === k ? ' on' : ''}`} title={k ? t(CHANNEL_LABELS[k]) : t('Alle Kanäle')} aria-pressed={value === k} onClick={() => onChange(k)}>
          {k ? <ChannelIcon channel={k} size={15} /> : t(label)}
        </button>
      ))}
    </div>
  );
}

/** Image, audio, video, file or map link of an inbound WhatsApp/Messenger/Instagram message. */
export function MessageMedia({ m }: { m: any }) {
  const [broken, setBroken] = useState(false);
  let a: any = m?.meta_media;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a);
    } catch {
      a = null;
    }
  }
  // Telegram/Discord files live in their own column.
  if (!a) return m?.channel_media ? <ChannelMedia m={m} /> : null;
  if (a.kind === 'location' && Number.isFinite(a.lat) && Number.isFinite(a.lng)) {
    return (
      <a className="media-link" href={`https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=17/${a.lat}/${a.lng}`} target="_blank" rel="noreferrer">
        <Icon name="location" size={14} /> Karte öffnen
      </a>
    );
  }
  const src = `/api/messages/meta/media/${encodeURIComponent(m.id)}?locationId=${encodeURIComponent(currentLocation())}`;
  if (broken) return <div className="media-link muted">Datei bei Meta nicht mehr verfügbar</div>;
  if (a.kind === 'image' || a.kind === 'sticker') {
    return (
      <a href={src} target="_blank" rel="noreferrer" className="media-wrap">
        <img className={`media-img${a.kind === 'sticker' ? ' sticker' : ''}`} src={src} alt={a.kind === 'sticker' ? 'Sticker' : 'Bild'} loading="lazy" onError={() => setBroken(true)} />
      </a>
    );
  }
  if (a.kind === 'audio') return <audio className="media-audio" controls preload="none" src={src} onError={() => setBroken(true)} />;
  if (a.kind === 'video') return <video className="media-video" controls preload="none" src={src} onError={() => setBroken(true)} />;
  return (
    <a className="media-link" href={src} target="_blank" rel="noreferrer">
      <Icon name="file" size={14} /> {a.filename || 'Datei öffnen'}
    </a>
  );
}

export interface ExtraChannel {
  key: string;
  label: string;
  /** `draft`: an SMS/WhatsApp draft of this channel to start from (MsgDrafts.tsx). */
  render: (onSent: () => void, draft?: ComposerDraft) => ReactNode;
}

/**
 * Meta channels the composer can offer for a contact. WhatsApp shows once it is set up;
 * Messenger and Instagram only when the contact has written there. `initial` follows the
 * channel of the contact's last message.
 */
export function useMetaComposer(contact: any, messages: any[] | undefined) {
  const cid: string | undefined = contact?.id;
  const lastIn = (messages ?? []).filter((m) => m.direction === 'in').at(-1);
  const [state, setState] = useState<{ cid?: string; channels: Record<string, any> }>({ channels: {} });
  const load = useCallback(() => {
    if (!cid) return;
    api.get(`/api/messages/meta/status?contact_id=${encodeURIComponent(cid)}`).then(
      (r) => setState({ cid, channels: r.channels ?? {} }),
      () => setState({ cid, channels: {} }),
    );
  }, [cid]);
  // A new inbound message may reopen the 24-hour window.
  useEffect(load, [load, lastIn?.id]);
  const channels = state.cid === cid ? state.channels : {};
  // Telegram, Discord and push (ChannelInbox.tsx) join the same composer.
  const more = useMoreChannels(contact, messages);
  const metaExtra: ExtraChannel[] = META_CHANNELS.filter((ch) => channels[ch]?.configured && (ch === 'whatsapp' || channels[ch].reachable)).map((ch) => ({
    key: ch,
    label: CHANNEL_LABELS[ch],
    render: (onSent, draft) => <MetaComposerPanel key={`${cid}:${ch}`} channel={ch} contact={contact} st={channels[ch]} onSent={onSent} draft={draft} />,
  }));
  const extra = [...metaExtra, ...more.extra];
  return { ready: (!cid || state.cid === cid) && more.ready, extra, initial: lastIn && extra.some((x) => x.key === lastIn.channel) ? (lastIn.channel as string) : undefined };
}

function left(ends: string) {
  const ms = new Date(ends).getTime() - Date.now();
  const h = Math.floor(ms / 3600_000);
  return h >= 1 ? `noch ${h} Std.` : `noch ${Math.max(1, Math.round(ms / 60_000))} Min.`;
}

/** Shows whether free text is allowed right now. */
export function WindowState({ channel, st }: { channel: string; st: any }) {
  const w = st?.window ?? {};
  if (w.open) {
    return (
      <div className="win-state open">
        <Icon name="ok" size={14} /> 24-Stunden-Fenster offen · {left(w.ends_at)}
      </div>
    );
  }
  const label = CHANNEL_LABELS[channel];
  return (
    <div className={`win-state ${channel === 'whatsapp' ? 'tpl' : 'closed'}`}>
      <Icon name="pending" size={14} />{' '}
      {channel === 'whatsapp'
        ? w.last_inbound_at
          ? 'Fenster geschlossen (letzte Nachricht vor über 24 Std.) – nur freigegebene Vorlagen'
          : 'Der Kontakt hat noch nicht per WhatsApp geschrieben – die erste Nachricht muss eine Vorlage sein'
        : `Fenster geschlossen – über ${label} geht es erst weiter, wenn der Kontakt wieder schreibt`}
    </div>
  );
}

const fill = (text: string, values: Record<string, string>, prefix: string) => String(text ?? '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, p) => values[`${prefix}.${p}`] || `[${p}]`);

/** Preview of a WhatsApp template with the values filled in so far. */
export function TemplatePreview({ t, values }: { t: any; values: Record<string, string> }) {
  return (
    <div className="tpl-preview">
      {t.header && <strong>{fill(t.header, values, 'header')}</strong>}
      {t.header_format && t.header_format !== 'TEXT' && <div className="muted small">[{t.header_format === 'IMAGE' ? 'Bild' : t.header_format === 'VIDEO' ? 'Video' : 'Dokument'}]</div>}
      <div>{fill(t.body, values, 'body')}</div>
      {t.footer && <div className="muted small">{t.footer}</div>}
      {t.buttons?.length > 0 && (
        <div className="tpl-buttons">
          {t.buttons.map((b: string, i: number) => (
            <span key={i}>{b}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Inputs for the template's placeholders (header, body, link buttons, header media). */
export function TemplateSlots({ t, values, onChange, hint }: { t: any; values: Record<string, string>; onChange: (v: Record<string, string>) => void; hint?: string }) {
  if (!t.slots?.length) return <p className="muted small">Diese Vorlage hat keine Platzhalter.</p>;
  return (
    <div className="tpl-slots">
      {t.slots.map((s: any) => (
        <label key={s.key} className="field">
          <span>{s.label}</span>
          <Input value={values[s.key]} onChange={(v) => onChange({ ...values, [s.key]: v })} placeholder={s.kind !== 'text' ? 'https://…' : s.example ? `z. B. ${s.example}` : hint} />
        </label>
      ))}
    </div>
  );
}

function MetaComposerPanel({ channel, contact, st, onSent, draft }: { channel: string; contact: any; st: any; onSent: () => void; draft?: ComposerDraft }) {
  const open = !!st.window?.open;
  // A draft starts in text mode with its text; with the 24-hour window closed the text stays visible but only a template can go out.
  const [mode, setMode] = useState<'text' | 'template'>(channel === 'whatsapp' && !open && !draft ? 'template' : 'text');
  const [body, setBody] = useState('');
  const [tpl, setTpl] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // a new draft never overwrites typed text or a chosen template – then it is only offered
  const fill = useDraftFill(draft, mode === 'text' ? body : tpl, (d) => (setMode('text'), setTpl(''), setValues({}), setBody(d.body)));
  const wantTemplates = channel === 'whatsapp' && st.templates && mode === 'template';
  const templates = useLoad(() => (wantTemplates ? api.get<any[]>('/api/messages/meta/templates') : Promise.resolve([] as any[])), [wantTemplates]);
  if (!st.reachable) return <p className="muted small meta-hint">{st.reason}</p>;
  const chosen = (templates.data ?? []).find((t) => `${t.name}|${t.language}` === tpl);
  const filled = !!chosen?.supported && chosen.slots.every((s: any) => String(values[s.key] ?? '').trim());
  const canSend = !busy && (mode === 'text' ? open && !!body.trim() && body.length <= st.limit : filled);

  const send = async () => {
    let ignoreDnd = false;
    if (contact.dnd) {
      if (!confirmAsk('Kontakt hat „Nicht stören“. Trotzdem senden?')) return;
      ignoreDnd = true;
    }
    setBusy(true);
    const r = await act(() =>
      api.post('/api/messages/meta', {
        contact_id: contact.id,
        channel,
        ignoreDnd,
        ...(mode === 'template' && chosen ? { template: { name: chosen.name, language: chosen.language, values } } : { body }),
      }),
    );
    setBusy(false);
    if (!r) return;
    if (r.status === 'failed') toast(`Nicht gesendet: ${r.error}`);
    else {
      toast(`Per ${CHANNEL_LABELS[channel]} gesendet`);
      if (draft && mode === 'text') await finishDraft(draft.id);
    }
    setBody('');
    setValues({});
    onSent();
  };

  return (
    <>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <WindowState channel={channel} st={st} />
        {fill.offer && <DraftOffer onTake={fill.take} />}
        {st.via && (
          <span className="muted small" title={st.via}>
            <Icon name="send" size={12} /> {st.via}
          </span>
        )}
        {channel === 'whatsapp' && (
          <div className="seg" role="group" aria-label="Art">
            <button type="button" className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>
              Text
            </button>
            <button type="button" className={mode === 'template' ? 'on' : ''} onClick={() => setMode('template')}>
              <Icon name="template" size={13} /> Vorlage
            </button>
          </div>
        )}
      </div>
      {mode === 'text' ? (
        <Textarea
          value={body}
          onChange={setBody}
          rows={4}
          disabled={!open}
          placeholder={open ? `${CHANNEL_LABELS[channel]}-Nachricht an ${contact.first_name || 'den Kontakt'}` : channel === 'whatsapp' ? 'Freier Text erst wieder nach einer Nachricht des Kontakts – bitte „Vorlage“ wählen' : 'Freier Text erst wieder nach einer Nachricht des Kontakts'}
        />
      ) : !st.templates ? (
        <p className="muted small">
          Für Vorlagen fehlt die WhatsApp-Business-Konto-ID – <Link to="settings/channels">Einstellungen → Kanäle</Link>.
        </p>
      ) : templates.loading && !templates.data ? (
        <Spinner />
      ) : templates.error ? (
        <p className="muted small">Vorlagen nicht geladen: {templates.error}</p>
      ) : !templates.data?.length ? (
        <p className="muted small">Keine freigegebenen Vorlagen. Vorlagen legst du im WhatsApp Manager von Meta an; nach der Freigabe erscheinen sie hier.</p>
      ) : (
        <>
          <Select
            value={tpl}
            onChange={(v) => (setTpl(v), setValues({}))}
            placeholder="Vorlage wählen…"
            options={templates.data.map((t) => [`${t.name}|${t.language}`, `${t.name} (${t.language}, ${t.category === 'MARKETING' ? 'Marketing' : t.category === 'UTILITY' ? 'Service' : t.category === 'AUTHENTICATION' ? 'Code' : t.category})${t.supported ? '' : ' – nicht unterstützt'}`])}
          />
          {chosen && !chosen.supported && <p className="muted small">{chosen.reason}</p>}
          {chosen?.supported && (
            <div className="tpl-grid">
              <TemplatePreview t={chosen} values={values} />
              <TemplateSlots t={chosen} values={values} onChange={setValues} />
            </div>
          )}
        </>
      )}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <small className="muted">
          {mode === 'text' ? `${body.length} / ${st.limit} Zeichen` : chosen ? 'Vorlagen kosten je nach Kategorie eine Meta-Gebühr.' : ''}
        </small>
        <button className="btn" disabled={!canSend} onClick={send}>
          <ChannelIcon channel={channel} /> Senden
        </button>
      </div>
    </>
  );
}
