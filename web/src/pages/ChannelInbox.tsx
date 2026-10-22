import { useCallback, useEffect, useState } from 'react';
import { Icon, channelIcon } from '../icons';
import { api, currentLocation } from '../api';
import { Input, Textarea, act, confirmAsk, toast } from '../ui';
import type { ExtraChannel } from './MetaInbox';

/**
 * Telegram, Discord and push inside Konversationen: composer tabs for contacts reachable there
 * and the files of inbound messages. Hooked into the inbox through useMetaComposer/MessageMedia.
 */

export const MORE_LABELS: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', push: 'Push' };
const ORDER = ['telegram', 'discord', 'push'] as const;

export function useMoreChannels(contact: any, messages: any[] | undefined) {
  const cid: string | undefined = contact?.id;
  const lastIn = (messages ?? []).filter((m) => m.direction === 'in').at(-1);
  const [state, setState] = useState<{ cid?: string; channels: Record<string, any> }>({ channels: {} });
  const load = useCallback(() => {
    if (!cid) return;
    api.get(`/api/messages/channels/status?contact_id=${encodeURIComponent(cid)}`).then(
      (r) => setState({ cid, channels: r.channels ?? {} }),
      () => setState({ cid, channels: {} }),
    );
  }, [cid]);
  // A first message on Telegram/Discord makes the contact reachable there.
  useEffect(load, [load, lastIn?.id]);
  const channels = state.cid === cid ? state.channels : {};
  const extra: ExtraChannel[] = ORDER.filter((ch) => channels[ch]?.configured && channels[ch]?.reachable).map((ch) => ({
    key: ch,
    label: MORE_LABELS[ch],
    render: (onSent) => (ch === 'push' ? <PushPanel key={`${cid}:push`} contact={contact} st={channels.push} onSent={onSent} /> : <ChatPanel key={`${cid}:${ch}`} channel={ch} contact={contact} st={channels[ch]} onSent={onSent} />),
  }));
  return { ready: !cid || state.cid === cid, extra };
}

function ChatPanel({ channel, contact, st, onSent }: { channel: string; contact: any; st: any; onSent: () => void }) {
  const [body, setBody] = useState('');
  const [file, setFile] = useState('');
  const [showFile, setShowFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const limit = file ? 1024 : (st.limit ?? 4096);
  const canSend = !busy && (!!body.trim() || !!file.trim()) && body.length <= limit && (!file || /^https:\/\/\S+$/.test(file.trim()));
  const send = async () => {
    let ignoreDnd = false;
    if (contact.dnd) {
      if (!confirmAsk('Kontakt hat „Nicht stören“. Trotzdem senden?')) return;
      ignoreDnd = true;
    }
    setBusy(true);
    const r = await act(() => api.post('/api/messages', { contact_id: contact.id, channel, body, ...(file.trim() ? { media_url: file.trim() } : {}), ignoreDnd }));
    setBusy(false);
    if (!r) return;
    if (r.status === 'failed') toast(`Nicht gesendet: ${r.error}`);
    else toast(`Per ${MORE_LABELS[channel]} gesendet`);
    setBody('');
    setFile('');
    onSent();
  };
  return (
    <div data-tour={`composer-${channel}`}>
      <div className="muted small chan-to">
        <Icon name={channelIcon(channel)} size={13} /> an {st.handle || 'den Kontakt'}
        {channel === 'discord' && <> · {st.where === 'channel' ? 'Antwort im Kanal' : 'Direktnachricht'}</>}
      </div>
      <Textarea value={body} onChange={setBody} rows={4} placeholder={`${MORE_LABELS[channel]}-Nachricht an ${contact.first_name || 'den Kontakt'}`} />
      {channel === 'telegram' && showFile && <Input value={file} onChange={setFile} placeholder="https://… (Bild, PDF, Audio oder Video)" aria-label="Datei-Link" />}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <small className="muted">
          {body.length} / {limit} Zeichen
          {channel === 'telegram' && !showFile && (
            <>
              {' · '}
              <button type="button" className="linkbtn" onClick={() => setShowFile(true)}>
                <Icon name="file" size={12} /> Datei-Link anhängen
              </button>
            </>
          )}
        </small>
        <button className="btn" disabled={!canSend} onClick={send}>
          <Icon name={channelIcon(channel)} size={14} className={`ico chan-ico chan-${channel}`} /> Senden
        </button>
      </div>
    </div>
  );
}

function PushPanel({ contact, st, onSent }: { contact: any; st: any; onSent: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const canSend = !busy && !!body.trim() && body.length <= 300 && (!url || /^https:\/\/\S+$/.test(url.trim()));
  const send = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/messages', { contact_id: contact.id, channel: 'push', subject: title, body, url: url.trim() }));
    setBusy(false);
    if (!r) return;
    toast(r.status === 'failed' ? `Nicht gesendet: ${r.error}` : `Push an ${r.devices ?? 1} Gerät(e) gesendet`);
    setTitle('');
    setBody('');
    setUrl('');
    onSent();
  };
  return (
    <>
      <div className="muted small chan-to">
        <Icon name="push" size={13} /> Browser-Benachrichtigung an {st.devices} {st.devices === 1 ? 'Gerät' : 'Geräte'}
      </div>
      <Input value={title} onChange={setTitle} placeholder="Titel (leer = Firmenname)" maxLength={80} />
      <Textarea value={body} onChange={setBody} rows={3} placeholder="Kurzer Text" />
      <Input value={url} onChange={setUrl} placeholder="Link beim Antippen (https://…, optional)" />
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <small className="muted">{body.length} / 300 Zeichen</small>
        <button className="btn" disabled={!canSend} onClick={send}>
          <Icon name="push" size={14} /> Senden
        </button>
      </div>
    </>
  );
}

/** Photo, voice message, video, document or map link of a Telegram/Discord message. */
export function ChannelMedia({ m }: { m: any }) {
  const [broken, setBroken] = useState(false);
  let a: any = m?.channel_media;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a);
    } catch {
      a = null;
    }
  }
  if (!a) return null;
  if (a.kind === 'location' && Number.isFinite(a.lat) && Number.isFinite(a.lng)) {
    return (
      <a className="media-link" href={`https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=17/${a.lat}/${a.lng}`} target="_blank" rel="noreferrer">
        <Icon name="location" size={14} /> Karte öffnen
      </a>
    );
  }
  // Files we sent are a link the platform fetched; only https is shown.
  if (m.direction === 'out') {
    return /^https:\/\//.test(String(a.url ?? '')) ? (
      <a className="media-link" href={a.url} target="_blank" rel="noreferrer">
        <Icon name="file" size={14} /> {String(a.url).split(/[?#]/)[0].split('/').pop()}
      </a>
    ) : null;
  }
  const src = `/api/messages/channels/media/${encodeURIComponent(m.id)}?locationId=${encodeURIComponent(currentLocation())}`;
  if (broken) return <div className="media-link muted">Datei nicht mehr verfügbar</div>;
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
