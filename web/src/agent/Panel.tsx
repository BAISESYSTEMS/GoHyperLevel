import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, CircleX, Clock, History, LoaderCircle, Lock, Maximize2, Mic, MicOff, Minimize2, Paperclip, Plus, Send, ShieldAlert, Square, Trash2, Undo2, Volume2, VolumeX, X } from 'lucide-react';
import { ago, api } from '../api';
import { useSession } from '../session';
import { act, navigate, toast, useRoute } from '../ui';
import { CARD_TOOLS } from '../../../server/services/werkstatt/names';
import { lazyPages } from '../lazy';
import { currentRoute, useUiContext } from './context';
import { AgentMarkdown } from './markdown';
import { fileToBase64, streamPost, type AgentEvent } from './stream';
import { canRecord, micError, onPlaying, speak, speakableText, startRecording, stopSpeaking, transcribe, type RecordingHandle } from './voice';
import './agent.css';
import { useT } from '../i18n';
import { useCompanion } from '../companion/store';
import { A2uiView } from '../a2ui/A2uiView';

/**
 * The HyperLevel Agent on every page: a right drawer (full screen on phones and on demand), opened with
 * the sidebar/topbar button or Ctrl/Cmd+J. Streams answers (SSE), shows each tool call as a card
 * (expandable arguments/result, links to the records), asks for confirmation before changes, can be
 * stopped, keeps a history per user, switches agents and models, takes files (CSV import, images for
 * vision models) and voice: push-to-talk with the sub-account's own speech recognition (MediaRecorder → /api/voice/transcribe,
 * tap or hold, editable text, optional auto-send), spoken replies with its own voice, the browser's Web Speech API as a fallback.
 * Voice never confirms anything: changes still wait for the confirmation card. Other parts of the app open it
 * with `window.dispatchEvent(new CustomEvent('pghl:agent', { detail: { prompt, agentId, conversationId } }))`; the Fokus-Modus
 * renders the same cards inline (applyEvent, ToolCardView, ConfirmCard are exported for it).
 */

// The Werkstatt's cards (plan, live progress, preview, diff) load only when a result of one of its tools is on screen.
const { WerkstattToolCard } = lazyPages(() => import('../werkstatt/ChatCards'), 'WerkstattToolCard');

export const MODE_LABEL: Record<string, string> = { read: 'Nur lesen', ask: 'Vor Änderungen fragen', book: 'Termin buchen', auto: 'Autonom' };

export interface ToolCard {
  id: string;
  name: string;
  title: string;
  klass?: string;
  args?: Record<string, unknown>;
  status: string;
  links?: { label: string; to: string }[];
  preview?: string;
  error?: string;
  /** What this call changed, as journal entries (modules/undo.ts): the card offers "Rückgängig". */
  undo?: { id: string; label: string; notice?: string }[];
  /** An interface for the result (A2UI 1.0 messages, e.g. the appointment picker of ghl_booking_slots – docs/a2ui.md). */
  ui?: Record<string, unknown>[];
}
export type Block = { kind: 'text'; text: string } | { kind: 'tools'; tools: ToolCard[] };
export interface FileRef {
  id: string;
  name: string;
  mime: string;
  image?: boolean;
}
export type Item = { role: 'user'; text: string; files: FileRef[] } | { role: 'assistant'; blocks: Block[] };
export interface Confirm {
  pending_id: string;
  token: string;
  call_id: string;
  tool: string;
  title: string;
  klass: string;
  args: Record<string, unknown>;
  args_hash: string;
  summary: string;
  target?: string | null;
  bridge?: boolean;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

/** Applies one streamed event to the chat items (same shape the server sends for a reload). */
export function applyEvent(items: Item[], e: AgentEvent): Item[] {
  if (!['text', 'tool', 'tool_result'].includes(e.type)) return items;
  const out = items.slice();
  let last = out[out.length - 1];
  if (!last || last.role !== 'assistant') {
    last = { role: 'assistant', blocks: [] };
    out.push(last);
  }
  const blocks = last.blocks.slice();
  if (e.type === 'text') {
    const b = blocks[blocks.length - 1];
    if (b?.kind === 'text') blocks[blocks.length - 1] = { kind: 'text', text: b.text + e.delta };
    else blocks.push({ kind: 'text', text: String(e.delta ?? '').replace(/^\n+/, '') });
  } else if (e.type === 'tool') {
    const card: ToolCard = { id: e.id, name: e.name, title: e.title ?? e.name, klass: e.klass, args: e.args, status: e.status ?? 'running' };
    const idx = blocks.findIndex((b) => b.kind === 'tools' && b.tools.some((t) => t.id === e.id));
    if (idx >= 0) {
      const b = blocks[idx] as Extract<Block, { kind: 'tools' }>;
      blocks[idx] = { kind: 'tools', tools: b.tools.map((t) => (t.id === e.id ? { ...t, ...card } : t)) };
    } else {
      const b = blocks[blocks.length - 1];
      if (b?.kind === 'tools') blocks[blocks.length - 1] = { kind: 'tools', tools: [...b.tools, card] };
      else blocks.push({ kind: 'tools', tools: [card] });
    }
  } else {
    let found = false;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.kind !== 'tools' || !b.tools.some((t) => t.id === e.id)) continue;
      found = true;
      blocks[i] = { kind: 'tools', tools: b.tools.map((t) => (t.id === e.id ? { ...t, status: e.status, links: e.links ?? t.links, preview: e.preview ?? t.preview, error: e.error ?? t.error, undo: e.undo ?? t.undo, ui: e.ui ?? t.ui } : t)) };
    }
    if (!found && e.status) blocks.push({ kind: 'tools', tools: [{ id: e.id, name: e.name ?? 'werkzeug', title: e.name ?? 'Werkzeug', status: e.status, error: e.error, links: e.links, preview: e.preview, undo: e.undo, ui: e.ui }] });
  }
  out[out.length - 1] = { role: 'assistant', blocks };
  return out;
}

function StatusIcon({ status }: { status: string }) {
  const t = useT('agent');
  if (status === 'running') return <LoaderCircle size={15} className="agent-spin" aria-label={t('läuft')} />;
  if (status === 'ok') return <Check size={15} aria-label={t('erledigt')} />;
  if (status === 'blocked') return <Lock size={15} aria-label={t('gesperrt')} />;
  if (status === 'deferred' || status === 'pending') return <Clock size={15} aria-label={t('wartet')} />;
  return <CircleX size={15} aria-label={t('nicht ausgeführt')} />;
}

/** Where a conversation came from (the history list). */
const SOURCE_LABEL: Record<string, string> = { workflow: 'Workflow', schedule: 'Zeitplan', inbound: 'Auto-Antwort', mobile: 'App', mcp: 'MCP', focus: 'Fokus' };

const STATUS_TEXT: Record<string, string> = { running: 'läuft …', ok: 'erledigt', error: 'Fehler', blocked: 'gesperrt (Nur lesen)', rejected: 'abgelehnt', deferred: 'zur Freigabe', pending: 'offen' };

/** "query: Max · limit: 5" – the first few argument values. */
function argSummary(args?: Record<string, unknown>) {
  if (!args) return '';
  return Object.entries(args)
    .filter(([k, v]) => k !== 'location_id' && v !== null && v !== '' && typeof v !== 'object')
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
    .join(' · ');
}

export function ToolCardView({ t: card, onNavigate }: { t: ToolCard; onNavigate: (to: string) => void }) {
  const t = useT('agent');
  const [openDetail, setOpenDetail] = useState(false);
  return (
    <div className={`agent-tool s-${card.status}`} data-tour="agent-tool">
      <button className="agent-tool-head" onClick={() => setOpenDetail(!openDetail)} aria-expanded={openDetail}>
        <span className="agent-tool-icon">
          <StatusIcon status={card.status} />
        </span>
        <span className="agent-tool-title">{card.title}</span>
        <span className="agent-tool-sum">{card.error && card.status !== 'ok' ? card.error : argSummary(card.args) || t(STATUS_TEXT[card.status] ?? card.status)}</span>
        {openDetail ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {!!card.links?.length && (
        <div className="agent-tool-links">
          {card.links.map((l) => (
            <button key={l.to} className="btn small secondary" onClick={() => onNavigate(l.to)}>
              {l.label}
            </button>
          ))}
        </div>
      )}
      {!!card.undo?.length && (
        <div className="agent-tool-links" data-tour="agent-undo">
          {card.undo.map((u) => (
            <button key={u.id} className="btn small secondary" style={{ minHeight: 'var(--undo-hit, 44px)' }} title={u.label} aria-label={t('Rückgängig: {label}', { label: u.label })} onClick={() => window.dispatchEvent(new CustomEvent('pghl:undo-do', { detail: { id: u.id } }))}>
              <Undo2 size={14} /> {t('Rückgängig')}
            </button>
          ))}
          {card.undo[0]?.notice && <span className="muted small">{card.undo[0].notice}</span>}
        </div>
      )}
      {card.status === 'ok' && (CARD_TOOLS as readonly string[]).includes(card.name) && <WerkstattToolCard t={card} onNavigate={onNavigate} />}
      {card.status === 'ok' && !!card.ui?.length && (
        <A2uiView
          messages={card.ui}
          onAction={(a) => {
            if (a.name !== 'choose_slot') return;
            const m = String(Array.isArray(a.context.slot) ? (a.context.slot[0] ?? '') : (a.context.slot ?? '')).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/);
            if (!m) return t('Bitte zuerst eine Zeit wählen.');
            const slot = `${m[3]}.${m[2]}.${m[1]} ${m[4]}`;
            // The choice goes back to the agent as the person's next message; it then books with ghl_book_appointment.
            window.dispatchEvent(new CustomEvent('pghl:agent-say', { detail: { text: t('Bitte buche den Termin am {slot} Uhr im Kalender „{calendar}“.', { slot, calendar: String(a.context.calendar ?? '') }) } }));
            return t('Gewählt: {slot} Uhr', { slot });
          }}
        />
      )}
      {openDetail && (
        <div className="agent-tool-detail">
          <div className="muted small">
            {card.name} · {STATUS_TEXT[card.status] ? t(STATUS_TEXT[card.status]) : card.status}
          </div>
          {card.args && (
            <>
              <div className="agent-label">{t('Eingaben')}</div>
              <pre>{JSON.stringify(card.args, null, 2)}</pre>
            </>
          )}
          {(card.preview || card.error) && (
            <>
              <div className="agent-label">{t('Ergebnis')}</div>
              <pre>{prettyResult(card.preview || card.error || '')}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function prettyResult(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2).slice(0, 4000);
  } catch {
    return s.slice(0, 4000);
  }
}

/** Readable names for the arguments a confirmation shows (the raw key stays as the tooltip). */
const ARG_LABELS: Record<string, string> = {
  to: 'Empfänger',
  cc: 'Kopie an',
  subject: 'Betreff',
  body: 'Text',
  html: 'Text',
  message: 'Nachricht',
  text: 'Text',
  name: 'Name',
  title: 'Titel',
  first_name: 'Vorname',
  last_name: 'Nachname',
  email: 'E-Mail',
  phone: 'Telefon',
  company: 'Firma',
  amount: 'Betrag',
  value: 'Wert',
  total_cents: 'Summe (Cent)',
  price_cents: 'Preis (Cent)',
  due_at: 'Fällig am',
  due_date: 'Fällig am',
  start_at: 'Beginn',
  end_at: 'Ende',
  date: 'Datum',
  status: 'Status',
  tags: 'Tags',
  tag: 'Tag',
  channel: 'Kanal',
  description: 'Beschreibung',
  notes: 'Notizen',
  note: 'Notiz',
  contact_id: 'Kontakt',
  opportunity_id: 'Deal',
  pipeline_id: 'Pipeline',
  stage_id: 'Phase',
  workflow_id: 'Workflow',
  invoice_id: 'Rechnung',
  assigned_to: 'Zuständig',
};
const argLabel = (k: string) => ARG_LABELS[k] ?? k.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const argValue = (v: unknown, t: (s: string) => string): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? t('ja') : t('nein');
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object' || x === null)) return v.join(', ');
  return JSON.stringify(v, null, 2);
};
/** An error for people: no connection, an expired sign-in and a busy server get a sentence instead of a code. */
const friendlyError = (e: unknown): string => {
  const m = String((e as Error)?.message ?? e ?? '');
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) return 'Keine Verbindung zum Server – prüf das Netz und versuch es noch einmal.';
  if (/\b401\b|unauthori[sz]ed|nicht angemeldet/i.test(m)) return 'Deine Anmeldung ist abgelaufen – bitte neu anmelden.';
  if (/\b(502|503|504)\b|bad gateway|timeout|zeitüberschreitung/i.test(m)) return 'Der Server antwortet gerade nicht – versuch es in einem Moment noch einmal.';
  return m || 'Fehler';
};

export function ConfirmCard({ c, onDecide, busy }: { c: Confirm; onDecide: (approve: boolean) => void; busy: boolean }) {
  const t = useT('agent');
  const sensitive = c.klass === 'sensitive';
  return (
    <div className={`agent-confirm${sensitive ? ' sensitive' : ''}`} data-tour="agent-confirm" role="group" aria-label={t('Bestätigung')}>
      <div className="agent-confirm-head">
        <ShieldAlert size={16} /> {sensitive ? t('Geht nach außen oder ist nicht rückgängig zu machen – bitte prüfen') : t('Änderung – bitte bestätigen')}
      </div>
      <div className="agent-confirm-title">{c.title}</div>
      {c.target && (
        <div className="small">
          {t('Empfänger')}: <strong>{c.target}</strong>
        </div>
      )}
      <dl className="agent-args">
        {Object.entries(c.args ?? {})
          .filter(([k, v]) => k !== 'location_id' && v !== null && v !== undefined && v !== '')
          .map(([k, v]) => (
            <div key={k}>
              <dt title={k}>{t(argLabel(k))}</dt>
              <dd>{argValue(v, t)}</dd>
            </div>
          ))}
      </dl>
      <div className="row">
        <button className="btn" disabled={busy && !c.bridge} onClick={() => onDecide(true)} data-tour="agent-approve">
          <Check size={15} /> {t('Ausführen')}
        </button>
        <button className="btn secondary" onClick={() => onDecide(false)}>
          {t('Ablehnen')}
        </button>
      </div>
    </div>
  );
}

/** The launcher in the top bar (the sidebar entry „KI-Agenten“ opens the agents page). */
export function AgentButton() {
  const t = useT('shell');
  const mod = isMac ? '⌘' : t('Strg');
  // the assistant's name (own choice → sub-account → agency → "Assistent") – the same in focus mode, the panel and here
  const { name, avatar } = useCompanion();
  return (
    <button className="btn secondary small agent-btn" data-tour="agent-button" onClick={() => window.dispatchEvent(new CustomEvent('pghl:agent', { detail: { toggle: true } }))} title={t('{name} öffnen ({key}+J)', { name, key: mod })} aria-label={t('{name} öffnen', { name })}>
      {avatar && avatar !== '✨' ? <span aria-hidden="true">{avatar}</span> : <Bot size={15} />} <span className="agent-btn-label">{name}</span> <kbd>{mod} J</kbd>
    </button>
  );
}

interface SpeechLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: (e: any) => void;
  onend: () => void;
  onerror: (e: any) => void;
}

export function AgentPanel() {
  const t = useT('agent');
  const session = useSession();
  const route = useRoute();
  const routeStr = useMemo(() => currentRoute(), [route.join('/'), typeof location !== 'undefined' ? location.search : '']);
  const [open, setOpen] = useState(() => store.get('pghl.agent.open') === '1');
  const [full, setFull] = useState(false);
  const [boot, setBoot] = useState<any>(null);
  const [agentId, setAgentId] = useState<string | null>(() => store.get(`pghl.agent.id.${session.locationId}`) || null);
  const [modelId, setModelId] = useState('');
  const [convId, setConvId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<FileRef[]>([]);
  const [uploading, setUploading] = useState(false);
  const [useCtx, setUseCtx] = useState(true);
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [history, setHistory] = useState<any[] | null>(null);
  const [listening, setListening] = useState(false);
  const [vp, setVp] = useState<any>(null);
  const [rec, setRec] = useState<'idle' | 'recording' | 'working'>('idle');
  const [recMs, setRecMs] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const recRef = useRef<RecordingHandle | null>(null);
  const finishRef = useRef<() => Promise<void>>(async () => undefined);
  const micRef = useRef<{ starting: boolean; downAt: number; stopOnUp: boolean }>({ starting: false, downAt: 0, stopOnUp: false });
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const speechRef = useRef<SpeechLike | null>(null);
  const lastSent = useRef('');
  const panelRef = useRef<HTMLElement>(null);
  const ui = useUiContext(routeStr, open);
  const SpeechCtor: any = typeof window !== 'undefined' ? ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition) : null;

  const loadBoot = useCallback(() => api.get('/api/agent/bootstrap').then(setBoot).catch(() => setBoot({ error: true })), []);
  useEffect(() => {
    if (open && !boot) void loadBoot();
  }, [open, boot, loadBoot]);
  useEffect(() => {
    store.set('pghl.agent.open', open ? '1' : '0');
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);
  // A different sub-account: a fresh start.
  useEffect(() => {
    setBoot(null);
    setConvId(null);
    setItems([]);
    setConfirm(null);
    setAgentId(store.get(`pghl.agent.id.${session.locationId}`) || null);
  }, [session.locationId]);

  // Voice: what the sub-account has set up (speech recognition, voice) and the person's own choices.
  useEffect(() => {
    if (open) api.get('/api/voice/prefs').then(setVp).catch(() => setVp(null));
  }, [open, session.locationId]);
  useEffect(() => onPlaying(setSpeaking), []);
  useEffect(() => {
    if (rec !== 'recording') return;
    const tick = setInterval(() => setRecMs(recRef.current?.elapsed() ?? 0), 250);
    return () => clearInterval(tick);
  }, [rec]);
  useEffect(
    () => () => {
      recRef.current?.cancel();
      stopSpeaking();
    },
    [],
  );
  const serverStt = canRecord() && !!vp?.ready?.stt;
  const canSpeak = !!vp?.ready?.tts;
  const readAloud = canSpeak && !!vp?.effective?.read_aloud;
  const autoSend = !!vp?.effective?.auto_send;

  const agents: any[] = boot?.agents ?? [];
  const agent = (agentId && agents.find((a) => a.id === agentId)) || boot?.default_agent;
  const starters: string[] = agent?.starters?.length ? agent.starters : (boot?.default_agent?.starters ?? []);
  const noModel = boot && !boot.error && !boot.connection && !(boot.models ?? []).length && !boot.bridge?.paired;

  const reset = () => {
    abortRef.current?.abort();
    setConvId(null);
    setItems([]);
    setConfirm(null);
    setError('');
    setStatus('');
    setView('chat');
  };

  const onEvent = useCallback((e: AgentEvent) => {
    if (e.type === 'start') {
      if (e.conversation_id) setConvId(e.conversation_id);
      if (e.bridge) setStatus(t('Bridge: wird gestartet …'));
    } else if (e.type === 'confirm') setConfirm(e as unknown as Confirm);
    else if (e.type === 'navigate' && typeof e.to === 'string') {
      navigate(e.to);
      toast(t('Geöffnet: {name}', { name: e.label || e.to }));
    } else if (e.type === 'error') setError(String(e.message ?? t('Fehler')));
    else if (e.type === 'bridge') setStatus(e.status === 'queued' ? (e.device ? t('Bridge: wartet auf {device} …', { device: e.device }) : t('Bridge: wartet auf deinen Rechner …')) : e.status === 'running' ? (e.device ? t('Bridge: läuft auf {device} (dein Abo)', { device: e.device }) : t('Bridge: läuft auf deinem Rechner (dein Abo)')) : String(e.text ?? ''));
    else if (e.type === 'step') setStatus('');
    else if (e.type === 'done') {
      setStatus('');
      if (e.status === 'stopped') setError(t('Gestoppt.'));
    }
    setItems((prev) => applyEvent(prev, e));
  }, []);

  // keep the newest message in view while it streams
  useEffect(() => {
    const el = bodyRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [items, confirm, status]);
  // cards that load their own content (the Werkstatt's plan, progress and preview) tell the panel when they grew
  useEffect(() => {
    const grew = () => {
      const el = bodyRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 420) el.scrollTop = el.scrollHeight;
    };
    window.addEventListener('pghl:agent-grew', grew);
    return () => window.removeEventListener('pghl:agent-grew', grew);
  }, []);

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (busy || (!text && !files.length)) return;
    const sending = files;
    lastSent.current = text;
    setItems((prev) => [...prev, { role: 'user', text, files: sending }, { role: 'assistant', blocks: [] }]);
    setInput('');
    setFiles([]);
    setConfirm(null);
    setError('');
    setBusy(true);
    setView('chat');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await streamPost('/api/agent/chat', { conversation_id: convId, agent_id: agentId, connection: modelId, message: text, files: sending.map((f) => f.id), ui: useCtx ? ui : { route: ui.route } }, onEvent, ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) setError(t(friendlyError(e)));
    } finally {
      setBusy(false);
      abortRef.current = null;
      setHistory(null);
    }
  };
  // A choice in an A2UI card (ToolCardView, e.g. a time of the appointment picker) is sent as the person's next message.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const say = (e: Event) => {
      const text = String((e as CustomEvent<{ text?: string }>).detail?.text ?? '').trim();
      if (text) void sendRef.current(text);
    };
    window.addEventListener('pghl:agent-say', say);
    return () => window.removeEventListener('pghl:agent-say', say);
  }, []);

  const startVoice = async () => {
    const m = micRef.current;
    if (m.starting || rec !== 'idle' || busy) return;
    m.starting = true;
    stopSpeaking();
    setError('');
    try {
      recRef.current = await startRecording({ maxMs: 90_000, onLimit: () => void finishRef.current() });
      setRecMs(0);
      setRec('recording');
    } catch (e) {
      setError(micError(e));
    } finally {
      m.starting = false;
    }
  };
  const finishVoice = async () => {
    const h = recRef.current;
    if (!h) return;
    recRef.current = null;
    setRec('working');
    try {
      const blob = await h.stop();
      if (!blob) return;
      const text = (await transcribe(blob)).text.trim();
      if (!text) return setError(t('Ich habe nichts verstanden – bitte noch einmal sprechen.'));
      // The text lands in the box first (editable); with auto-send it goes out as it is. Confirmations stay manual.
      if (autoSend) void send(`${input.trim()} ${text}`.trim());
      else {
        setInput((cur) => `${cur.trim()} ${text}`.trim());
        setTimeout(() => inputRef.current?.focus(), 30);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRec('idle');
    }
  };
  finishRef.current = finishVoice;
  const cancelVoice = () => {
    recRef.current?.cancel();
    recRef.current = null;
    setRec('idle');
  };
  /** Tap starts, tap ends – or hold: recording ends when the button is released. */
  const micDown = () => {
    const m = micRef.current;
    m.downAt = Date.now();
    m.stopOnUp = rec === 'recording';
    if (rec === 'idle') void startVoice();
  };
  const micUp = () => {
    const m = micRef.current;
    if (rec === 'recording' && (m.stopOnUp || Date.now() - m.downAt > 500)) void finishVoice();
  };
  const setPref = async (patch: Record<string, unknown>) => {
    const r = await act(() => api.put('/api/voice/prefs', patch));
    if (r) setVp(r);
  };
  // Spoken reply: when a run is over, read what the agent said (never what was only a tool result).
  const wasBusy = useRef(false);
  const latest = useRef({ items, error, readAloud });
  latest.current = { items, error, readAloud };
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const { items: it, error: err, readAloud: on } = latest.current;
      const last = [...it].reverse().find((x) => x.role === 'assistant');
      const text = last && last.role === 'assistant' ? speakableText(last.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join(' ')) : '';
      if (on && !err && text) speak(text).catch((e) => setError((e as Error).message));
    }
    wasBusy.current = busy;
  }, [busy]);

  const stop = async () => {
    abortRef.current?.abort();
    if (convId) await api.post(`/api/agent/conversations/${convId}/stop`, {}).catch(() => {});
    setBusy(false);
    setStatus('');
  };

  const decide = async (approve: boolean) => {
    const c = confirm;
    if (!c) return;
    setConfirm(null);
    if (c.bridge) {
      // The bridge run is still streaming in the open chat request; just record the decision.
      await act(() => api.post('/api/agent/confirm', { pending_id: c.pending_id, token: c.token, approve, args_hash: c.args_hash }));
      return;
    }
    setBusy(true);
    setError('');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await streamPost('/api/agent/confirm', { pending_id: c.pending_id, token: c.token, approve, args_hash: c.args_hash }, onEvent, ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const openConversation = async (id: string) => {
    const c = await act(() => api.get(`/api/agent/conversations/${id}`));
    if (!c) return;
    setConvId(c.id);
    setItems(c.items);
    setConfirm(c.confirm);
    setAgentId(c.agent_id ?? null);
    setModelId(c.connection ?? '');
    setError(c.status === 'error' ? c.error : '');
    setView('chat');
  };

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(list).slice(0, 6)) {
        if (f.size > 8 * 1024 * 1024) {
          setError(t('{name}: höchstens 8 MB', { name: f.name }));
          continue;
        }
        const r = await api.post('/api/agent/files', { name: f.name, mime: f.type, data: await fileToBase64(f) });
        setFiles((prev) => [...prev, { id: r.id, name: r.name, mime: r.mime, image: r.image }]);
        const model = modelId ? (boot?.models ?? []).find((m: any) => m.id === modelId) : boot?.connection;
        if (r.image && model && !model.vision) toast(t('Hinweis: Das gewählte Modell kann keine Bilder sehen.'));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const toggleVoice = () => {
    if (listening) {
      speechRef.current?.stop();
      return;
    }
    if (!SpeechCtor) return;
    const rec: SpeechLike = new SpeechCtor();
    rec.lang = 'de-DE';
    rec.interimResults = true;
    rec.continuous = false;
    const before = input ? `${input.trim()} ` : '';
    rec.onresult = (e: any) => setInput(before + Array.from(e.results as ArrayLike<any>).map((r: any) => r[0].transcript).join(''));
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    speechRef.current = rec;
    setListening(true);
    rec.start();
  };

  // Ctrl/Cmd+J, Esc and the app-wide "open the agent" event
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && !!panelRef.current?.contains(active);
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        // open but the focus is on the page: jump into the input instead of closing what someone is looking at
        if (open && !inside) return void inputRef.current?.focus();
        setOpen((o) => !o);
      } else if (e.key === 'Escape' && open && !document.querySelector('.modal-bg')) {
        // Esc belongs to whatever has the focus – a menu or a field on the page closes first, the panel only when it has the focus
        if (!inside && active && active !== document.body) return;
        if (recRef.current) cancelVoice();
        else if (full) setFull(false);
        else setOpen(false);
      }
    };
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      if (d.toggle) return setOpen((o) => !o);
      setOpen(true);
      if (d.agentId !== undefined && d.agentId !== agentId) {
        reset();
        setAgentId(d.agentId);
        store.set(`pghl.agent.id.${session.locationId}`, d.agentId ?? '');
      }
      if (d.reload) setBoot(null);
      if (d.prompt) setInput(String(d.prompt));
      // Fokus-Modus mit Companion: "Im Agent-Panel weiterführen" opens the same conversation here
      if (typeof d.conversationId === 'string') void openConversation(d.conversationId);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pghl:agent', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pghl:agent', onOpen);
    };
  }, [open, full, agentId, session.locationId]);

  useEffect(() => {
    if (view === 'history' && !history) api.get('/api/agent/conversations').then(setHistory).catch(() => setHistory([]));
  }, [view, history]);

  const pickAgent = (id: string) => {
    const next = id || null;
    if (next === agentId) return;
    reset();
    setAgentId(next);
    store.set(`pghl.agent.id.${session.locationId}`, id);
  };

  const modelLabel = (() => {
    if (modelId === 'bridge') return t('Mein Abo (Bridge)');
    const m = (boot?.models ?? []).find((x: any) => x.id === modelId);
    if (m) return `${m.label}${m.model ? ` · ${m.model}` : ''}`;
    return boot?.connection ? `${boot.connection.label} · ${boot.connection.model}` : t('kein Modell');
  })();

  if (!open) return null;
  const onNavigate = (to: string) => {
    navigate(to);
    if (window.innerWidth < 700) setOpen(false);
  };

  return (
    <aside ref={panelRef} className={`agent-panel${full ? ' full' : ''}`} data-tour="agent-panel" aria-label={agent?.name ?? t('KI-Agent')}>
      <header className="agent-head">
        <div className="agent-who">
          <span className="agent-avatar" style={agent?.color ? { background: agent.color } : undefined}>
            {agent?.emoji ?? '✨'}
          </span>
          <select className="agent-select" value={agentId ?? ''} onChange={(e) => pickAgent(e.target.value)} aria-label={t('Agent wählen')} data-tour="agent-switch">
            <option value="">{boot?.default_agent?.name ?? 'HyperLevel Agent'}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emoji} {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="agent-head-actions">
          <button className="icon-btn" title={t('Verlauf')} aria-label={t('Verlauf')} onClick={() => setView(view === 'history' ? 'chat' : 'history')}>
            <History size={17} />
          </button>
          <button className="icon-btn" title={t('Neuer Chat')} aria-label={t('Neuer Chat')} onClick={reset}>
            <Plus size={17} />
          </button>
          <button className="icon-btn agent-full-btn" title={full ? t('Verkleinern') : t('Vollbild')} aria-label={full ? t('Verkleinern') : t('Vollbild')} onClick={() => setFull(!full)}>
            {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button className="icon-btn" title={t('Schließen (Esc)')} aria-label={t('Schließen')} onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
        </div>
      </header>
      <div className="agent-subhead">
        <label className="agent-model" title={t('Modell für diesen Chat')} data-tour="agent-model">
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} aria-label={t('Modell wählen')}>
            <option value="">{t('Standard')}{boot?.connection ? ` (${boot.connection.label} · ${boot.connection.model})` : ''}</option>
            {(boot?.models ?? []).map((m: any) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.model ? ` · ${m.model}` : ''}
              </option>
            ))}
            {boot?.bridge?.paired && <option value="bridge">{boot.bridge.online ? t('Mein Abo über die Bridge') : t('Mein Abo über die Bridge (offline)')}</option>}
          </select>
          <span className="agent-model-label">{modelLabel}</span>
        </label>
        {modelId === 'sub:chatgpt' && (
          <a className="agent-plan" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer" title={t('Diese Unterhaltung nutzt dein ChatGPT-Abo – Nutzung und Limits verwaltest du in ChatGPT')}>
            {t('Dein ChatGPT-Abo · Nutzung ↗')}
          </a>
        )}
        <span className={`agent-mode m-${agent?.mode ?? 'ask'}`} title={t('Sicherheitsmodus')}>
          {t(MODE_LABEL[agent?.mode ?? 'ask'] ?? '')}
        </span>
      </div>
      {ui.route && (
        <div className="agent-context" data-tour="agent-context">
          <button className={`agent-chip${useCtx ? ' on' : ''}`} onClick={() => setUseCtx(!useCtx)} title={useCtx ? t('Kontext wird mitgeschickt – klicken zum Abschalten') : t('Kontext abgeschaltet')}>
            {ui.entity?.label ? ui.label : t('Seite: {name}', { name: ui.label || ui.route })}
            {useCtx ? <X size={12} /> : null}
          </button>
        </div>
      )}
      <div className="agent-body" ref={bodyRef}>
        {view === 'history' ? (
          <div className="agent-history">
            <div className="agent-label">{t('Deine Unterhaltungen')}</div>
            {!history && <LoaderCircle className="agent-spin" size={18} />}
            {history?.length === 0 && <p className="muted small">{t('Noch keine Unterhaltungen.')}</p>}
            {history?.map((c) => (
              <div key={c.id} className={`agent-history-row${c.id === convId ? ' on' : ''}`}>
                <button className="agent-history-open" onClick={() => openConversation(c.id)}>
                  <span>{c.title}</span>
                  <span className="muted small">
                    {ago(c.updated_at)}
                    {c.source !== 'chat' ? ` · ${SOURCE_LABEL[c.source as string] ? t(SOURCE_LABEL[c.source as string]) : c.source}` : ''}
                    {c.status === 'awaiting' ? ` · ${t('wartet auf dich')}` : ''}
                  </span>
                </button>
                <button
                  className="icon-btn"
                  aria-label={t('Löschen')}
                  onClick={async () => {
                    if (await act(() => api.del(`/api/agent/conversations/${c.id}`))) {
                      setHistory((h) => h?.filter((x) => x.id !== c.id) ?? null);
                      if (c.id === convId) reset();
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <>
            {!items.length && (
              <div className="agent-empty" data-tour="agent-starters">
                <div className="agent-empty-avatar">{agent?.emoji ?? '✨'}</div>
                <h3>{agent?.name ?? t('HyperLevel Agent')}</h3>
                <p className="muted small">{agent?.description}</p>
                {noModel ? (
                  <div className="agent-notice">
                    {t('Noch kein KI-Modell verbunden.')}{' '}
                    <a href="/app/settings/ai-providers" onClick={(e) => (e.preventDefault(), onNavigate('settings/ai-providers'))}>
                      {t('Einstellungen → KI-Anbieter')}
                    </a>
                    {': '}
                    {t('einen Schlüssel eintragen (OpenAI, Anthropic, Gemini, OpenRouter, Groq, Ollama …) – oder mit deinem eigenen ChatGPT/Claude-Abo über die')}{' '}
                    <a href="/app/agents/bridge" onClick={(e) => (e.preventDefault(), onNavigate('agents/bridge'))}>
                      {t('Bridge')}
                    </a>
                    .
                  </div>
                ) : (
                  <div className="agent-starters">
                    {starters.map((s) => (
                      <button key={s} className="agent-starter" onClick={() => void send(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {items.map((it, i) =>
              it.role === 'user' ? (
                <div key={i} className="agent-msg user">
                  {it.text && <div className="agent-bubble">{it.text}</div>}
                  {!!it.files.length && (
                    <div className="agent-files">
                      {it.files.map((f) =>
                        f.image ? <img key={f.id} src={`/api/agent/files/${f.id}?locationId=${session.locationId}`} alt={f.name} /> : <span key={f.id} className="agent-file"><Paperclip size={12} /> {f.name}</span>,
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div key={i} className="agent-msg assistant">
                  {it.blocks.map((b, j) =>
                    b.kind === 'text' ? (
                      <AgentMarkdown key={j} text={b.text} onNavigate={() => window.innerWidth < 700 && setOpen(false)} />
                    ) : (
                      <div key={j} className="agent-tools">
                        {b.tools.map((tc) => (
                          <ToolCardView key={tc.id} t={tc} onNavigate={onNavigate} />
                        ))}
                      </div>
                    ),
                  )}
                  {busy && i === items.length - 1 && !it.blocks.length && <TypingDots />}
                </div>
              ),
            )}
            {confirm && <ConfirmCard c={confirm} onDecide={decide} busy={busy} />}
            {status && <div className="agent-status">{status}</div>}
            {error && (
              <div className="agent-error" role="alert">
                {error}
                {!busy && lastSent.current && error !== t('Gestoppt.') && (
                  <button className="btn small secondary agent-retry" onClick={() => (setItems((l) => (l.length >= 2 && l[l.length - 1].role === 'assistant' && !(l[l.length - 1] as any).blocks?.length ? l.slice(0, -2) : l)), void send(lastSent.current))}>
                    {t('Nochmal senden')}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <footer className="agent-composer">
        {!!files.length && (
          <div className="agent-attachments">
            {files.map((f) => (
              <span key={f.id} className="agent-file">
                <Paperclip size={12} /> {f.name}
                <button aria-label={t('{name} entfernen', { name: f.name })} onClick={() => setFiles((l) => l.filter((x) => x.id !== f.id))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="agent-input-row">
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            placeholder={confirm ? t('Oder schreib etwas anderes …') : agent?.name ? t('Frag {name} oder gib einen Auftrag …', { name: agent.name }) : t('Frag den Agenten oder gib einen Auftrag …')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            data-tour="agent-input"
            aria-label={t('Nachricht an den Agenten')}
          />
        </div>
        <div className="agent-tools-row">
          <input ref={fileRef} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,.csv,.txt,.md,.json,text/csv" onChange={(e) => void upload(e.target.files)} />
          <button className="icon-btn" title={t('Datei anhängen (CSV, Bild, Text)')} aria-label={t('Datei anhängen')} onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? <LoaderCircle size={17} className="agent-spin" /> : <Paperclip size={17} />}
          </button>
          {serverStt ? (
            <button
              className={`icon-btn agent-mic${rec === 'recording' ? ' agent-rec' : ''}`}
              title={rec === 'recording' ? t('Aufnahme beenden (tippen oder loslassen)') : t('Sprechen: tippen oder gedrückt halten')}
              aria-label={rec === 'recording' ? t('Aufnahme beenden') : t('Spracheingabe')}
              aria-pressed={rec === 'recording'}
              disabled={rec === 'working'}
              data-tour="agent-mic"
              onPointerDown={micDown}
              onPointerUp={micUp}
              onContextMenu={(e) => e.preventDefault()}
              onClick={(e) => {
                // Keyboard activation (Enter/Space) has no pointer events.
                if (e.detail === 0) void (rec === 'recording' ? finishVoice() : startVoice());
              }}
            >
              {rec === 'working' ? <LoaderCircle size={17} className="agent-spin" /> : rec === 'recording' ? <MicOff size={17} /> : <Mic size={17} />}
            </button>
          ) : (
            SpeechCtor && (
              <button className={`icon-btn${listening ? ' agent-rec' : ''}`} title={listening ? t('Aufnahme beenden') : t('Sprechen')} aria-label={t('Spracheingabe')} onClick={toggleVoice}>
                {listening ? <MicOff size={17} /> : <Mic size={17} />}
              </button>
            )
          )}
          {canSpeak && (
            <button
              className={`icon-btn${readAloud || speaking ? ' agent-on' : ''}`}
              title={speaking ? t('Vorlesen stoppen') : readAloud ? t('Vorlesen ist an – klicken zum Ausschalten') : t('Antworten vorlesen')}
              aria-label={speaking ? t('Vorlesen stoppen') : readAloud ? t('Vorlesen ausschalten') : t('Vorlesen einschalten')}
              aria-pressed={readAloud}
              onClick={() => (speaking ? stopSpeaking() : void setPref({ read_aloud: !readAloud }))}
            >
              {readAloud || speaking ? <Volume2 size={17} /> : <VolumeX size={17} />}
            </button>
          )}
          {rec === 'recording' ? (
            <span className="agent-voice-state agent-rec small" role="status">
              ● {t('Aufnahme · {n} s', { n: Math.floor(recMs / 1000) })}
            </span>
          ) : rec === 'working' ? (
            <span className="agent-voice-state muted small" role="status">
              {t('Wird erkannt …')}
            </span>
          ) : (
            <span className="agent-hint muted small">{t('Enter sendet · Shift+Enter neue Zeile')}</span>
          )}
          {busy ? (
            <button className="btn small secondary" onClick={stop} aria-label={t('Stoppen')}>
              <Square size={13} /> {t('Stopp')}
            </button>
          ) : (
            <button className="btn small" onClick={() => void send()} disabled={!input.trim() && !files.length} aria-label={t('Senden')}>
              <Send size={13} /> {t('Senden')}
            </button>
          )}
        </div>
      </footer>
    </aside>
  );
}

function TypingDots(): ReactNode {
  const t = useT('agent');
  return (
    <div className="agent-typing" aria-label={t('schreibt')}>
      <span />
      <span />
      <span />
    </div>
  );
}
