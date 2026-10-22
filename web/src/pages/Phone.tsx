import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Call, Device } from '@twilio/voice-sdk';
import { Icon } from '../icons';
import { api } from '../api';
import { Badge, Check, CodeBox, Empty, Field, Input, Modal, Select, Spinner, act, toast, toastError, useLoad } from '../ui';
import { CallTools, TransferModal } from './PhoneTools';
import { Slot } from '../slots';
import { MoreFields } from '../areas/fields';

/**
 * Browser phone (Twilio Voice JS SDK, loaded only when switched on): a floating dialer that stays
 * while you move around the app, an incoming-call popup, mute, hold, keypad (DTMF), call timer and
 * audio device selection. Its state lives in a small store outside React so navigation never drops a call.
 */

interface ActiveCall {
  direction: 'in' | 'out';
  number: string;
  name: string;
  callId: string;
  contactId?: string;
  /** Set when a colleague handed this call over (the id of the hand-over). */
  transfer?: string;
  state: 'connecting' | 'ringing' | 'open';
  startedAt?: number;
  muted: boolean;
  holding?: boolean;
}
interface Held {
  callId: string;
  number: string;
  name: string;
  since: number;
}
interface Incoming {
  number: string;
  name: string;
  callId: string;
  transfer?: string;
}
interface PhoneState {
  status: 'off' | 'loading' | 'ready' | 'error';
  error: string;
  available: boolean;
  incomingAllowed: boolean;
  registered: boolean;
  number: string;
  call: ActiveCall | null;
  incoming: Incoming | null;
  held: Held[];
  open: boolean;
}

const INITIAL: PhoneState = { status: 'off', error: '', available: true, incomingAllowed: false, registered: false, number: '', call: null, incoming: null, held: [], open: false };
let state: PhoneState = INITIAL;
const listeners = new Set<() => void>();
function setState(p: Partial<PhoneState>) {
  state = { ...state, ...p };
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const usePhone = () => useSyncExternalStore(subscribe, () => state);

// --- controller (one Device per open app and sub-account) ------------------------------------

let device: Device | null = null;
let current: Call | null = null;
let ringing: Call | null = null;
let generation = 0;
let presenceTimer: ReturnType<typeof setInterval> | undefined;
let heldTimer: ReturnType<typeof setInterval> | undefined;

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`pghl.phone.${k}`) ?? '';
    } catch {
      return '';
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`pghl.phone.${k}`, v);
    } catch {
      /* private mode */
    }
  },
};
const message = (e: unknown) => (e instanceof Error ? e.message : String((e as any)?.message ?? e));
/** The SDK repeats connection errors while it retries: show each message once a minute at most. */
const shown = new Map<string, number>();
function phoneError(text: string) {
  if (Date.now() - (shown.get(text) ?? 0) < 60_000) return;
  shown.set(text, Date.now());
  toastError(text);
}

async function ping(available = state.available) {
  await api.post('/api/phone/presence', { available }).catch(() => undefined);
}

async function applySavedDevices(d: Device) {
  const input = store.get('input');
  const output = store.get('output');
  const ring = store.get('ringtone');
  try {
    if (input) await d.audio?.setInputDevice(input);
    if (output && d.audio?.isOutputSelectionSupported) await d.audio.speakerDevices.set(output);
    if (ring && d.audio?.isOutputSelectionSupported) await d.audio.ringtoneDevices.set(ring);
  } catch {
    /* the device is gone – the default is used */
  }
}

async function register() {
  if (!device) return;
  try {
    await device.register();
    setState({ registered: true });
  } catch (e) {
    setState({ registered: false });
    phoneError(`Telefon: ${message(e)}`);
  }
}

export async function startPhone() {
  const gen = ++generation;
  let st: any;
  try {
    st = await api.get('/api/phone/status');
  } catch {
    return;
  }
  if (gen !== generation) return;
  if (!st.ready) return setState({ ...INITIAL });
  setState({ status: 'loading', error: '' });
  try {
    const [{ Device: DeviceClass }, tok] = await Promise.all([import('@twilio/voice-sdk'), api.get('/api/phone/token')]);
    if (gen !== generation) return;
    const d = new DeviceClass(tok.token, {
      edge: tok.edge,
      closeProtection: 'Ein Anruf läuft – die Seite wirklich verlassen?',
      codecPreferences: ['opus', 'pcmu'],
      logLevel: 'error',
      appName: 'gohigh',
      allowIncomingWhileBusy: false,
      // No call-quality reports to Twilio Insights (keeps the CSP narrow).
      publishEvents: false,
    } as ConstructorParameters<typeof DeviceClass>[1]);
    device = d;
    d.on('tokenWillExpire', async () => {
      const t = await api.get('/api/phone/token').catch(() => null);
      if (t && device === d) d.updateToken(t.token);
    });
    d.on('registered', () => setState({ registered: true }));
    d.on('unregistered', () => setState({ registered: false }));
    d.on('error', (e: any) => phoneError(`Telefon: ${e?.message ?? 'Fehler'}`));
    d.on('incoming', onIncoming);
    void applySavedDevices(d);
    setState({ status: 'ready', available: st.available, incomingAllowed: !!tok.incoming, number: tok.number });
    if (tok.incoming && st.available) await register();
    clearInterval(presenceTimer);
    if (tok.incoming) {
      void ping();
      presenceTimer = setInterval(() => void ping(), 45_000);
    }
  } catch (e) {
    if (gen === generation) setState({ status: 'error', error: message(e) });
  }
}

export function stopPhone() {
  generation++;
  clearInterval(presenceTimer);
  clearInterval(heldTimer);
  try {
    current?.disconnect();
    device?.destroy();
  } catch {
    /* already gone */
  }
  if (state.incomingAllowed && state.status === 'ready') void api.del('/api/phone/presence').catch(() => undefined);
  device = null;
  current = null;
  ringing = null;
  setState({ ...INITIAL });
}

export async function restartPhone() {
  stopPhone();
  await startPhone();
}

function track(call: Call, info: Omit<ActiveCall, 'muted'>) {
  current = call;
  setState({ call: { ...info, muted: false }, open: true });
  const patch = (p: Partial<ActiveCall>) => current === call && state.call && setState({ call: { ...state.call, ...p } });
  call.on('ringing', () => patch({ state: 'ringing' }));
  call.on('accept', async () => {
    patch({ state: 'open', startedAt: Date.now() });
    const sid = call.parameters?.CallSid;
    if (info.direction === 'in' && info.callId && info.transfer) {
      // A colleague handed this call over: from now on it is ours (hold, notes, hang-up).
      const r = await api.post('/api/phone/transfers/accepted', { call_id: info.callId, agent_sid: sid ?? '' }).catch(() => null);
      if (r?.contact_id) patch({ contactId: r.contact_id });
    } else if (info.direction === 'in' && info.callId) {
      const r = await api.post('/api/phone/accepted', { call_id: info.callId, agent_sid: sid ?? '' }).catch(() => null);
      if (r?.contact_name && !info.name) patch({ name: r.contact_name, contactId: r.contact_id ?? undefined });
    } else if (info.direction === 'in' && sid) {
      // Handed over with an announcement: the server knows this leg once the colleague pressed 1 – ask until it does.
      for (let i = 0; i < 25 && current === call; i++) {
        const r = await api.get(`/api/phone/calls/${encodeURIComponent(sid)}`).catch(() => null);
        if (r) return patch({ callId: r.call_id, name: info.name || r.contact_name, contactId: r.contact_id ?? undefined });
        await new Promise((res) => setTimeout(res, 2000));
      }
    } else if (info.direction === 'out' && !info.callId && sid) {
      // The server knows this call by the browser leg's SID: fetch its id (needed for hold) and the contact.
      const r = await api.get(`/api/phone/calls/${encodeURIComponent(sid)}`).catch(() => null);
      if (r) patch({ callId: r.call_id, name: info.name || r.contact_name, contactId: r.contact_id ?? undefined });
    }
  });
  call.on('mute', (muted: boolean) => patch({ muted }));
  const end = () => {
    if (current !== call) return;
    current = null;
    setState({ call: null });
  };
  call.on('disconnect', end);
  call.on('cancel', end);
  call.on('reject', end);
  call.on('error', (e: any) => {
    toastError(`Anruf: ${e?.message ?? 'Fehler'}`);
    end();
  });
}

function onIncoming(call: Call) {
  if (current || ringing) return call.reject();
  ringing = call;
  const p = call.customParameters;
  setState({ incoming: { number: p.get('from') || call.parameters?.From || 'Unbekannt', name: p.get('name') || '', callId: p.get('callId') || '', transfer: p.get('transfer') || undefined } });
  const clear = () => {
    if (ringing !== call) return;
    ringing = null;
    setState({ incoming: null });
  };
  call.on('cancel', clear);
  call.on('disconnect', clear);
  call.on('reject', clear);
  call.on('error', clear);
}

export function acceptIncoming() {
  const call = ringing;
  const inc = state.incoming;
  if (!call || !inc) return;
  ringing = null;
  setState({ incoming: null });
  track(call, { direction: 'in', number: inc.number, name: inc.name, callId: inc.callId, transfer: inc.transfer, state: 'connecting' });
  call.accept();
}
export function rejectIncoming() {
  ringing?.reject();
}
/** Stops ringing here only (others keep ringing, the caller doesn't notice). */
export function ignoreIncoming() {
  const call = ringing;
  ringing = null;
  setState({ incoming: null });
  call?.ignore();
}

/** Calls a number from the browser. Returns false when the browser phone isn't ready (caller falls back). */
export async function phoneDial(number: string, opts: { contactId?: string; name?: string; dialerItem?: string } = {}): Promise<boolean> {
  if (!device || state.status !== 'ready') return false;
  if (current) {
    toast('Es läuft schon ein Anruf.');
    setState({ open: true });
    return true;
  }
  const to = number.trim();
  if (!to) return true;
  setState({ open: true });
  try {
    const call = await device.connect({ params: { To: to, ...(opts.contactId ? { contactId: opts.contactId } : {}), ...(opts.dialerItem ? { dialerItem: opts.dialerItem } : {}) } });
    track(call, { direction: 'out', number: to, name: opts.name ?? '', callId: '', contactId: opts.contactId, state: 'connecting' });
  } catch (e) {
    toastError(`Anruf: ${message(e)}`);
  }
  return true;
}

export const hangUp = () => current?.disconnect();
export const toggleMute = () => current && current.mute(!current.isMuted());
export const sendDigit = (d: string) => current?.sendDigits(d);

export async function holdCall() {
  const c = state.call;
  if (!c || !current) return;
  const key = c.callId || current.parameters?.CallSid;
  if (!key || c.state !== 'open') return toast('Halten geht erst, wenn verbunden ist.');
  setState({ call: { ...c, holding: true } });
  const r = await act(() => api.post(`/api/phone/calls/${encodeURIComponent(key)}/hold`));
  if (!r) return state.call && setState({ call: { ...state.call, holding: false } });
  setState({ held: [...state.held.filter((h) => h.callId !== r.call_id), { callId: r.call_id, number: c.number, name: c.name || r.contact_name, since: Date.now() }] });
  // Twilio ends the browser leg; just in case it lingers:
  setTimeout(() => current && state.call?.holding && current.disconnect(), 4000);
  watchHeld();
}

export async function resumeCall(callId: string) {
  if (!device) return;
  if (current) return toast('Erst den laufenden Anruf beenden oder halten.');
  const h = state.held.find((x) => x.callId === callId);
  if (!h) return;
  setState({ held: state.held.filter((x) => x.callId !== callId) });
  try {
    const call = await device.connect({ params: { resume: callId } });
    track(call, { direction: 'out', number: h.number, name: h.name, callId, state: 'connecting' });
  } catch (e) {
    toastError(`Fortsetzen: ${message(e)}`);
    setState({ held: [...state.held, h] });
  }
}

export async function hangUpHeld(callId: string) {
  const r = await act(() => api.post(`/api/phone/calls/${encodeURIComponent(callId)}/hangup`));
  if (r) setState({ held: state.held.filter((x) => x.callId !== callId) });
}

/** Held calls can end on the other side: poll until none is left. */
function watchHeld() {
  if (heldTimer) return;
  heldTimer = setInterval(async () => {
    if (!state.held.length) {
      clearInterval(heldTimer);
      heldTimer = undefined;
      return;
    }
    for (const h of state.held) {
      const r = await api.get(`/api/phone/calls/${encodeURIComponent(h.callId)}`).catch(() => null);
      if (r?.ended) {
        setState({ held: state.held.filter((x) => x.callId !== h.callId) });
        toast(`Gehaltener Anruf beendet: ${h.name || h.number}`);
      }
    }
  }, 5000);
}

export async function setAvailable(available: boolean) {
  setState({ available });
  await ping(available);
  if (!device || !state.incomingAllowed) return;
  if (available) await register();
  else await device.unregister().catch(() => undefined);
}

// --- UI ------------------------------------------------------------------------------------------

const KEYS: [string, string][] = [
  ['1', ''],
  ['2', 'ABC'],
  ['3', 'DEF'],
  ['4', 'GHI'],
  ['5', 'JKL'],
  ['6', 'MNO'],
  ['7', 'PQRS'],
  ['8', 'TUV'],
  ['9', 'WXYZ'],
  ['*', ''],
  ['0', '+'],
  ['#', ''],
];

function Keypad({ onKey }: { onKey: (k: string) => void }) {
  return (
    <div className="phone-keys">
      {KEYS.map(([k, sub]) => (
        <button key={k} type="button" onClick={() => onKey(k)} aria-label={`Taste ${k}`}>
          <span>{k}</span>
          <small>{sub}</small>
        </button>
      ))}
    </div>
  );
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function useTick(on: boolean) {
  const [, setT] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setT((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

/** Mounted once in the app shell: floating button, dialer panel, incoming popup. */
export function BrowserPhone() {
  const p = usePhone();
  useEffect(() => {
    void startPhone();
    return () => stopPhone();
  }, []);
  useEffect(() => {
    const on = p.status === 'ready' || p.status === 'error';
    document.body.classList.toggle('has-phone', on);
    document.body.classList.toggle('phone-open', on && (p.open || !!p.incoming));
    return () => document.body.classList.remove('has-phone', 'phone-open');
  }, [p.status, p.open, p.incoming]);
  if (p.status === 'off' || p.status === 'loading') return null;
  return (
    <>
      {p.incoming && <IncomingPopup inc={p.incoming} />}
      {p.open && <PhonePanel />}
      <button data-tour="phone-fab" className={`phone-fab${p.call ? ' live' : ''}${p.held.length ? ' held' : ''}`} onClick={() => setState({ open: !state.open })} aria-label="Telefon" title={p.status === 'error' ? `Telefon: ${p.error}` : 'Telefon'}>
        <Icon name="phone" size={22} />
        {p.call?.startedAt ? <CallClock since={p.call.startedAt} /> : null}
        <span className={`dot ${p.status === 'error' ? 'err' : p.registered ? 'on' : 'off'}`} />
      </button>
    </>
  );
}

function CallClock({ since }: { since: number }) {
  useTick(true);
  return <span className="phone-fab-clock">{clock(Date.now() - since)}</span>;
}

function IncomingPopup({ inc }: { inc: Incoming }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && ignoreIncoming();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="phone-incoming" role="alertdialog" aria-label="Eingehender Anruf">
      <button className="icon-btn phone-x" onClick={ignoreIncoming} aria-label="Klingeln hier ausblenden" title="Hier nicht mehr klingeln (Esc)">
        ✕
      </button>
      <div className="muted small">
        <Icon name="callIn" size={14} /> Eingehender Anruf
      </div>
      <div className="phone-who">{inc.name || inc.number}</div>
      {inc.name && <div className="muted">{inc.number}</div>}
      <div className="phone-incoming-actions">
        <button className="btn phone-accept" onClick={acceptIncoming}>
          <Icon name="phone" size={16} /> Annehmen
        </button>
        <button className="btn danger" onClick={rejectIncoming}>
          <Icon name="hangup" size={16} /> Ablehnen
        </button>
      </div>
    </div>
  );
}

function PhonePanel() {
  const p = usePhone();
  const [num, setNum] = useState('');
  const [keypad, setKeypad] = useState(false);
  const [devices, setDevices] = useState(false);
  const [transfer, setTransfer] = useState<{ callId: string; held: boolean; name: string } | null>(null);
  const c = p.call;
  useTick(!!c?.startedAt);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !devices && !transfer && setState({ open: false });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [devices, transfer]);
  const status = p.status === 'error' ? p.error : !p.incomingAllowed ? 'Nur ausgehend' : p.registered ? 'Erreichbar' : p.available ? 'Verbindet…' : 'Nicht erreichbar';
  return (
    <div className="phone-panel" role="dialog" aria-label="Telefon">
      <div className="phone-head">
        <strong>Telefon</strong>
        <span className={`phone-state ${p.registered ? 'on' : ''}`}>{status}</span>
        <button className="icon-btn" onClick={() => setDevices(true)} aria-label="Audiogeräte" title="Mikrofon & Lautsprecher">
          <Icon name="headset" size={16} />
        </button>
        <button className="icon-btn" onClick={() => setState({ open: false })} aria-label="Schließen" title="Schließen (Esc)">
          ✕
        </button>
      </div>
      {c ? (
        <div className="phone-call">
          <div className="phone-who">{c.name || c.number}</div>
          {c.name && <div className="muted">{c.number}</div>}
          <div className="phone-timer">{c.holding ? 'Wird gehalten…' : c.state === 'open' && c.startedAt ? clock(Date.now() - c.startedAt) : c.state === 'ringing' ? 'Klingelt…' : 'Verbinde…'}</div>
          {keypad && <Keypad onKey={sendDigit} />}
          <div className="phone-controls">
            <button className={`phone-ctl${c.muted ? ' on' : ''}`} onClick={toggleMute} aria-pressed={c.muted} title={c.muted ? 'Stummschaltung aufheben' : 'Stumm schalten'}>
              <Icon name={c.muted ? 'micOff' : 'mic'} size={18} />
              <span>{c.muted ? 'Stumm' : 'Mikro'}</span>
            </button>
            <button className="phone-ctl" onClick={holdCall} disabled={c.state !== 'open' || c.holding} title="Halten – der Anrufer hört Wartemusik">
              <Icon name="pause" size={18} />
              <span>Halten</span>
            </button>
            <button className={`phone-ctl${keypad ? ' on' : ''}`} onClick={() => setKeypad(!keypad)} aria-pressed={keypad} title="Tastenfeld (Tonwahl)">
              <Icon name="keypad" size={18} />
              <span>Tasten</span>
            </button>
            <button className="phone-ctl end" onClick={hangUp} title="Auflegen">
              <Icon name="hangup" size={18} />
              <span>Auflegen</span>
            </button>
          </div>
          <CallTools callId={c.callId} open={c.state === 'open'} onTransfer={() => setTransfer({ callId: c.callId, held: false, name: c.name || c.number })} />
          <Slot name="call.panel" contactId={c.contactId} />
        </div>
      ) : (
        <form
          className="phone-dial"
          onSubmit={(e) => {
            e.preventDefault();
            void phoneDial(num);
          }}
        >
          <div className="phone-number">
            <input value={num} onChange={(e) => setNum(e.target.value)} placeholder="Nummer eingeben" inputMode="tel" autoComplete="tel" aria-label="Telefonnummer" />
            {num && (
              <button type="button" className="icon-btn" onClick={() => setNum(num.slice(0, -1))} aria-label="Löschen">
                <Icon name="backspace" size={16} />
              </button>
            )}
          </div>
          <Keypad onKey={(k) => setNum(num + k)} />
          <button className="btn phone-accept phone-go" disabled={!num.trim() || p.status !== 'ready'}>
            <Icon name="phone" size={16} /> Anrufen
          </button>
          {p.incomingAllowed && <Check checked={p.available} onChange={(v) => void setAvailable(v)} label="Für eingehende Anrufe erreichbar" />}
          {p.number && <div className="muted small">Angezeigte Nummer: {p.number}</div>}
        </form>
      )}
      {p.held.length > 0 && (
        <div className="phone-held">
          {p.held.map((h) => (
            <div key={h.callId} className="phone-held-row">
              <Icon name="pause" size={14} />
              <span className="grow">{h.name || h.number}</span>
              <button className="btn small" onClick={() => void resumeCall(h.callId)} disabled={!!c}>
                Fortsetzen
              </button>
              <button className="btn small secondary" onClick={() => setTransfer({ callId: h.callId, held: true, name: h.name || h.number })} title="An eine Kollegin, einen Kollegen oder eine Nummer übergeben">
                Übergeben
              </button>
              <button className="btn small danger" onClick={() => void hangUpHeld(h.callId)} aria-label="Gehaltenen Anruf beenden">
                <Icon name="hangup" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {devices && <DevicesModal onClose={() => setDevices(false)} />}
      {transfer && (
        <TransferModal
          callId={transfer.callId}
          held={transfer.held}
          name={transfer.name}
          ensureHold={async () => {
            await holdCall();
            return state.held.some((h) => h.callId === transfer.callId);
          }}
          onAccepted={() => setState({ held: state.held.filter((h) => h.callId !== transfer.callId) })}
          onClose={() => setTransfer(null)}
        />
      )}
    </div>
  );
}

function DevicesModal({ onClose }: { onClose: () => void }) {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [sel, setSel] = useState({ input: store.get('input'), output: store.get('output'), ringtone: store.get('ringtone') });
  const [err, setErr] = useState('');
  const canPickOutput = !!device?.audio?.isOutputSelectionSupported;
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // Labels only show once the microphone may be used.
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
      } catch {
        if (live) setErr('Kein Zugriff aufs Mikrofon – bitte im Browser erlauben.');
      }
      const list = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
      if (!live) return;
      setInputs(list.filter((d) => d.kind === 'audioinput'));
      setOutputs(list.filter((d) => d.kind === 'audiooutput'));
    })();
    return () => {
      live = false;
    };
  }, []);
  const pick = async (k: 'input' | 'output' | 'ringtone', id: string) => {
    setSel({ ...sel, [k]: id });
    store.set(k, id);
    try {
      if (!device) return;
      if (k === 'input') await (id ? device.audio?.setInputDevice(id) : device.audio?.unsetInputDevice());
      else if (canPickOutput) await (k === 'output' ? device.audio!.speakerDevices : device.audio!.ringtoneDevices).set(id || 'default');
    } catch (e) {
      toastError(message(e));
    }
  };
  const opts = (list: MediaDeviceInfo[]) => list.map((d, i): [string, string] => [d.deviceId, d.label || `Gerät ${i + 1}`]);
  return (
    <Modal title="Mikrofon & Lautsprecher" onClose={onClose}>
      {err && <p className="voice-warn small">{err}</p>}
      <Field label="Mikrofon">
        <Select value={sel.input} onChange={(v) => void pick('input', v)} placeholder="Standard" options={opts(inputs)} />
      </Field>
      {canPickOutput ? (
        <>
          <Field label="Lautsprecher / Headset">
            <Select value={sel.output} onChange={(v) => void pick('output', v)} placeholder="Standard" options={opts(outputs)} />
          </Field>
          <Field label="Klingelton auf">
            <Select value={sel.ringtone} onChange={(v) => void pick('ringtone', v)} placeholder="Standard" options={opts(outputs)} />
          </Field>
        </>
      ) : (
        <p className="muted small">Dieser Browser lässt die Ausgabe nicht wählen – es wird der Standard-Lautsprecher genutzt.</p>
      )}
    </Modal>
  );
}

/** "Wählen" in the call log: opens the dialer when the browser phone is on. */
export function PhoneDialButton() {
  const p = usePhone();
  if (p.status !== 'ready') return null;
  return (
    <button className="btn" data-tour="phone-dial" onClick={() => setState({ open: true })}>
      <Icon name="keypad" size={16} /> Wählen
    </button>
  );
}

// --- settings (Einstellungen → Telefonie) -------------------------------------------------------

const INCOMING: [string, string][] = [
  ['parallel', 'Browser und Handy klingeln gleichzeitig'],
  ['browser_only', 'Nur im Browser (Handy nur, wenn niemand im Browser erreichbar ist)'],
  ['off', 'Nur Handy – der Browser telefoniert nur ausgehend'],
];
const EDGE_LABEL: Record<string, string> = { roaming: 'Automatisch (nächster Standort)', frankfurt: 'Frankfurt', dublin: 'Dublin', ashburn: 'Ashburn (USA)', umatilla: 'Umatilla (USA)', sydney: 'Sydney', tokyo: 'Tokio', singapore: 'Singapur', 'sao-paulo': 'São Paulo' };

export function BrowserPhoneSettings() {
  const data = useLoad(() => api.get<any>('/api/phone/settings'), []);
  const [s, setS] = useState<any>();
  const [busy, setBusy] = useState(false);
  useEffect(() => setS(data.data ? { ...data.data } : undefined), [data.data]);
  if (!s || !data.data) return data.error ? <Empty>{data.error}</Empty> : <Spinner />;
  const d = data.data;
  const set = (p: any) => setS({ ...s, ...p });
  const save = async () => {
    const { enabled, api_key_sid, api_secret, twiml_app_sid, incoming, edge } = s;
    const r = await act(() => api.put('/api/phone/settings', { enabled, api_key_sid, api_secret, twiml_app_sid, incoming, edge }), 'Gespeichert');
    if (r) {
      data.setData(r);
      void restartPhone();
    }
  };
  return (
    <div className="card" style={{ marginTop: 14 }} data-tour="tel-browser">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>
          <Icon name="headset" size={18} /> Browser-Telefon
        </h2>
        {!d.enabled ? <Badge>aus</Badge> : d.ready ? <Badge tone="green">Bereit</Badge> : <Badge tone="yellow">Es fehlt: {d.missing.join(', ')}</Badge>}
      </div>
      <p className="muted small">
        Telefonieren direkt im Browser über Twilio (Headset empfohlen); eingehende Anrufe klingeln bei allen, die erreichbar sind. Braucht HTTPS und Mikrofon-Freigabe.
      </p>
      <Check checked={s.enabled} onChange={(v) => set({ enabled: v })} label="Browser-Telefon einschalten" />
      <MoreFields id="tel-browser-manual" label="Von Hand einrichten" values={[s.api_key_sid, s.twiml_app_sid]}>
      <div className="grid2">
        <Field label="API Key SID" hint="Twilio-Konsole → Account → API keys & tokens → Create API key (Standard).">
          <Input value={s.api_key_sid} onChange={(v) => set({ api_key_sid: v })} placeholder="SK…" autoComplete="off" />
        </Field>
        <Field label="API Key Secret" hint="Wird verschlüsselt gespeichert und nie wieder angezeigt.">
          <Input type="password" value={s.api_secret} onChange={(v) => set({ api_secret: v })} autoComplete="new-password" />
        </Field>
        <Field label="TwiML App SID" hint="Twilio → Voice → TwiML Apps; Voice-URL siehe unten.">
          <Input value={s.twiml_app_sid} onChange={(v) => set({ twiml_app_sid: v })} placeholder="AP…" autoComplete="off" />
        </Field>
        <Field label="Twilio-Standort">
          <Select value={s.edge} onChange={(v) => set({ edge: v })} options={d.edges.map((e: string) => [e, EDGE_LABEL[e] ?? e])} />
        </Field>
      </div>
      <Field label="TwiML App → Voice Request URL (POST)">
        <CodeBox text={d.webhooks.voice} />
      </Field>
      <Field label="TwiML App → Status Callback URL (POST, optional)">
        <CodeBox text={d.webhooks.status} />
      </Field>
      </MoreFields>
      <div className="actions" style={{ margin: '2px 0 12px' }}>
        <button
          className="btn small secondary"
          disabled={busy}
          title="Legt API-Key und TwiML-App mit Account SID und Auth Token an (bzw. trägt die Adressen bei der vorhandenen App ein)"
          onClick={async () => {
            setBusy(true);
            const r = await act(() => api.post('/api/phone/setup'), 'Bei Twilio eingerichtet');
            setBusy(false);
            if (r) {
              data.setData(r);
              void restartPhone();
            }
          }}
        >
          <Icon name="refresh" size={14} /> Bei Twilio automatisch einrichten
        </button>
      </div>
      <Field label="Eingehende Anrufe">
        <Select value={s.incoming} onChange={(v) => set({ incoming: v })} options={INCOMING} />
      </Field>
      <p>
        <button className="btn" onClick={save}>
          Speichern
        </button>
      </p>
    </div>
  );
}
