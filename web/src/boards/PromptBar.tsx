import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { canRecord, micError, startRecording, transcribe, type RecordingHandle } from '../agent/voice';
import { Icon } from '../icons';
import { Link, toastError } from '../ui';
import { PatchCard } from './PatchCard';
import type { BoardFull, Catalogue, ComposeResult } from './types';

const EXAMPLES = ['Zeig mir die offenen Angebote und die heutigen Aufgaben', 'Mach das Umsatz-Diagramm größer und setz es nach oben', 'Füge einen Kalender neben der Pipeline hinzu', 'Entferne die Notizen und nenne das Board „Montag“', 'Färbe das Board violett'];

/**
 * "Sag dem Board, was du sehen willst": text or push-to-talk (the same speech recognition as the HyperLevel Agent) → a checked
 * change. Small layout changes can go straight through (setting), everything else waits for "Übernehmen". Spoken wishes
 * never confirm anything themselves.
 */
export function PromptBar({ board, catalogue, call, onUndo, canEdit, wish }: { board: BoardFull; catalogue: Catalogue | null; call: <T extends { board?: BoardFull }>(path: string, body?: Record<string, unknown>) => Promise<T>; onUndo: () => Promise<unknown>; canEdit: boolean; wish?: { text: string; n: number } }) {
  const [text, setText] = useState(wish?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState<ComposeResult | null>(null);
  const [applied, setApplied] = useState<{ summary: string; id: number } | null>(null);
  const [error, setError] = useState<{ text: string; setup: boolean } | null>(null);
  const [ex, setEx] = useState(0);
  const [rec, setRec] = useState<'idle' | 'recording' | 'working'>('idle');
  const [recMs, setRecMs] = useState(0);
  const [vp, setVp] = useState<any>(null);
  const input = useRef<HTMLInputElement>(null);
  const recRef = useRef<RecordingHandle | null>(null);
  const mic = useRef({ starting: false, downAt: 0, stopOnUp: false });
  const finishRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    api.get('/api/voice/prefs').then(setVp).catch(() => setVp(null));
  }, []);
  // a wish handed over (an example chip, ?wish= in the address, the agent) lands in the box, ready to send
  useEffect(() => {
    if (!wish) return;
    setText(wish.text);
    setTimeout(() => input.current?.focus(), 60);
  }, [wish]);
  useEffect(() => {
    const t = setInterval(() => setEx((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (rec !== 'recording') return;
    const t = setInterval(() => setRecMs(recRef.current?.elapsed() ?? 0), 250);
    return () => clearInterval(t);
  }, [rec]);
  useEffect(() => () => recRef.current?.cancel(), []);
  useEffect(() => {
    if (!applied) return;
    const t = setTimeout(() => setApplied((a) => (a === applied ? null : a)), 9000);
    return () => clearTimeout(t);
  }, [applied]);
  // a change by somebody else makes an open proposal stale only visually (the server re-applies it), nothing to do here

  const send = async (prompt: string, voice = false) => {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true);
    setError(null);
    setCard(null);
    setApplied(null);
    try {
      const r = await call<ComposeResult>('compose', { prompt: p, voice });
      setText('');
      if (r.applied) setApplied({ summary: r.proposal?.summary || r.message || 'Übernommen', id: Date.now() });
      else setCard(r);
    } catch (e) {
      const m = (e as Error).message;
      setError({ text: m, setup: /KI-Assistent/.test(m) });
    } finally {
      setBusy(false);
    }
  };

  const decide = async (apply: boolean) => {
    const id = card?.proposal?.id;
    if (!id) return setCard(null);
    setBusy(true);
    try {
      if (apply) {
        const r = await call<{ summary: string; board: BoardFull }>(`proposals/${id}/apply`);
        setApplied({ summary: r.summary || 'Übernommen', id: Date.now() });
      } else await call(`proposals/${id}/reject`);
      setCard(null);
    } catch (e) {
      toastError(e);
      if (/nicht mehr aktuell|abgelaufen|geändert/.test((e as Error).message)) setCard(null);
    } finally {
      setBusy(false);
    }
  };

  // --- push-to-talk: tap starts and ends, or hold and let go -----------------------------------------------------
  const serverStt = canRecord() && !!vp?.ready?.stt;
  const autoSend = !!vp?.effective?.auto_send;
  const startVoice = async () => {
    const m = mic.current;
    if (m.starting || rec !== 'idle' || busy) return;
    m.starting = true;
    setError(null);
    try {
      recRef.current = await startRecording({ maxMs: 60_000, onLimit: () => void finishRef.current() });
      setRecMs(0);
      setRec('recording');
    } catch (e) {
      setError({ text: micError(e), setup: false });
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
      const said = (await transcribe(blob)).text.trim();
      if (!said) return setError({ text: 'Ich habe nichts verstanden – bitte noch einmal sprechen.', setup: false });
      if (autoSend) void send(said, true);
      else {
        setText(said);
        setTimeout(() => input.current?.focus(), 30);
      }
    } catch (e) {
      setError({ text: (e as Error).message, setup: false });
    } finally {
      setRec('idle');
    }
  };
  finishRef.current = finishVoice;
  const micDown = () => {
    const m = mic.current;
    m.downAt = Date.now();
    m.stopOnUp = rec === 'recording';
    if (rec === 'idle') void startVoice();
  };
  const micUp = () => {
    const m = mic.current;
    if (rec === 'recording' && (m.stopOnUp || Date.now() - m.downAt > 500)) void finishVoice();
  };

  if (!canEdit)
    return (
      <div className="bd-dock">
        <p className="bd-dock-ro">
          <Icon name="lock" size={14} /> Du darfst dieses Board ansehen, aber nicht ändern.
        </p>
      </div>
    );

  return (
    <div className="bd-dock" data-tour="board-prompt">
      {card && <PatchCard result={card} board={board} catalogue={catalogue} busy={busy} onApply={() => void decide(true)} onReject={() => void decide(false)} />}
      {applied && (
        <div className="bd-applied" role="status">
          <Icon name="check" size={15} />
          <span>{applied.summary}</span>
          <button
            type="button"
            className="btn ghost small"
            onClick={async () => {
              setApplied(null);
              await onUndo();
            }}
          >
            <Icon name="undo" size={14} /> Rückgängig
          </button>
        </div>
      )}
      {error && (
        <p className="bd-error" role="alert">
          {error.text}{' '}
          {error.setup && (
            <Link to="settings/ai">KI-Assistent einrichten</Link>
          )}
        </p>
      )}
      <form
        className={`bd-prompt${busy ? ' busy' : ''}${rec !== 'idle' ? ' rec' : ''}`}
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <Icon name="sparkles" size={18} />
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={rec === 'recording' ? `Ich höre zu … ${Math.floor(recMs / 1000)} s` : rec === 'working' ? 'Ich schreibe mit …' : (typeof matchMedia !== 'undefined' && matchMedia('(max-width: 720px)').matches ? 'Sag dem Board, was du willst …' : `Sag dem Board, was du sehen willst – z. B. „${EXAMPLES[ex % EXAMPLES.length]}“`)}
          aria-label="Wunsch an das Board"
          maxLength={1000}
          disabled={busy || rec !== 'idle'}
          autoComplete="off"
        />
        {serverStt && (
          <button
            type="button"
            className={`bd-mic${rec === 'recording' ? ' on' : ''}`}
            onPointerDown={(e) => {
              e.preventDefault();
              micDown();
            }}
            onPointerUp={micUp}
            onPointerLeave={micUp}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                e.preventDefault();
                rec === 'recording' ? void finishVoice() : void startVoice();
              }
            }}
            disabled={busy || rec === 'working'}
            aria-label={rec === 'recording' ? 'Aufnahme beenden' : 'Sprechen (Taste halten oder tippen)'}
            aria-pressed={rec === 'recording'}
            title="Sprechen: Taste halten oder tippen"
          >
            <Icon name={rec === 'recording' ? 'micOff' : 'mic'} size={17} />
          </button>
        )}
        <button type="submit" className="btn bd-send" disabled={busy || !text.trim() || rec !== 'idle'} aria-label="Senden">
          {busy ? <span className="bd-spin" aria-hidden="true" /> : <Icon name="send" size={16} />}
          <span className="bd-send-text">Los</span>
        </button>
      </form>
    </div>
  );
}
