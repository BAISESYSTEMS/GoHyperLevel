import { useEffect, useRef, useState, type RefObject } from 'react';
import { canRecord, micError, startRecording, transcribe, type RecordingHandle } from '../agent/voice';
import { bus, useBus } from '../companion/store';
import { useT } from '../i18n';
import { Icon } from '../icons';
import { canRecognise, recognise } from './speech';

/** What the companion (edge button, shortcut) may do with the prompt's microphone. */
export interface PromptControl {
  /** start listening: `hold` ends with release(), `tap` ends when the person pauses (or taps again) */
  start: (mode: 'tap' | 'hold') => void;
  release: (asTap: boolean) => void;
  cancel: () => void;
  /** there is a way to listen here (the sub-account's speech recognition or the browser's own) */
  canListen: () => boolean;
}

/** Silence after speech that ends a hands-free recording, and how long to wait for the first word. */
const SILENCE_MS = 1300;
const WAIT_MS = 7000;

/**
 * The prompt bar of Fokus-Modus mit Companion: text, or push-to-talk (tap to start – it ends when you pause – or hold and let go) –
 * the sub-account's speech to text like the HyperLevel Agent and the boards, the browser's own recognition where none is set up.
 * The edge button and Alt+J start the same microphone; after the wake word the browser's recognizer already listens and its words
 * show here as they come. What was said becomes the question and is sent at once; speech never confirms anything – a confirmation
 * of the agent needs a click. Without a microphone the button is simply not there.
 */
export function FocusPrompt({ busy, serverStt, lang, name, onAsk, inputRef, controlRef, onMic, micOn = false }: { busy: boolean; serverStt: boolean; lang: 'de' | 'en'; name: string; onAsk: (text: string, voice: boolean) => void; inputRef: RefObject<HTMLInputElement | null>; controlRef?: RefObject<PromptControl | null>; /** the realtime voice takes the microphone button (returns true when it did) */ onMic?: () => boolean; micOn?: boolean }) {
  const t = useT('focus');
  const b = useBus();
  const [text, setText] = useState('');
  const [rec, setRec] = useState<'idle' | 'recording' | 'working'>('idle');
  const [recMs, setRecMs] = useState(0);
  const [error, setError] = useState('');
  const recRef = useRef<RecordingHandle | null>(null);
  const browserRef = useRef<{ stop: () => void; cancel: () => void } | null>(null);
  const mic = useRef({ starting: false, downAt: 0, stopOnUp: false, pressed: false });
  const modeRef = useRef<'tap' | 'hold'>('tap');
  const finishRef = useRef<() => Promise<void>>(async () => {});
  const server = serverStt && canRecord();
  const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 560px)').matches;
  const browser = !server && canRecognise();
  const wakeHearing = b.activity === 'hearing' && rec === 'idle';

  useEffect(() => {
    if (rec !== 'recording' || !server) return;
    const timer = setInterval(() => setRecMs(recRef.current?.elapsed() ?? 0), 250);
    return () => clearInterval(timer);
  }, [rec, server]);
  // the companion knows when the prompt listens: the wake-word listener pauses, the edge button and chip show it
  const own = useRef(false);
  useEffect(() => {
    if (rec === 'recording') {
      own.current = true;
      bus.set({ micBusy: true, activity: 'hearing', partial: '' });
    } else if (rec === 'working') bus.set({ micBusy: true });
    else {
      bus.set({ micBusy: false });
      // only the prompt's own listening ends here – the wake-word listener's "hört zu" stays until it heard the command
      if (own.current && bus.state.activity === 'hearing') bus.set({ activity: 'idle' });
      own.current = false;
    }
  }, [rec]);
  useEffect(
    () => () => {
      recRef.current?.cancel();
      browserRef.current?.cancel();
      bus.set({ micBusy: false });
    },
    [],
  );

  const send = (value: string, voice = false) => {
    const q = value.trim();
    if (!q || busy) return;
    setText('');
    setError('');
    onAsk(q, voice);
  };

  const cancel = () => {
    browserRef.current?.cancel();
    browserRef.current = null;
    recRef.current?.cancel();
    recRef.current = null;
    setRec('idle');
  };
  const start = async (mode: 'tap' | 'hold' = 'tap') => {
    const m = mic.current;
    if (m.starting || rec !== 'idle' || busy) return;
    modeRef.current = mode;
    setError('');
    if (browser) {
      browserRef.current = recognise(lang, (said) => send(said, true), () => {
        browserRef.current = null;
        setRec('idle');
      });
      if (browserRef.current) setRec('recording');
      return;
    }
    m.starting = true;
    try {
      recRef.current = await startRecording({
        maxMs: 30_000,
        onLimit: () => void finishRef.current(),
        // hands-free: a pause after speaking ends a tapped recording (a held one ends with the key or the button)
        silence: {
          ms: SILENCE_MS,
          waitMs: WAIT_MS,
          onSilence: (heard) => {
            if (modeRef.current !== 'tap') return;
            if (heard) void finishRef.current();
            else {
              cancel();
              setError(t('Ich habe nichts gehört – tippe auf das Mikrofon und sprich.'));
            }
          },
        },
      });
      setRecMs(0);
      setRec('recording');
    } catch (e) {
      setError(micError(e));
    } finally {
      m.starting = false;
    }
  };
  const finish = async () => {
    if (browserRef.current) return browserRef.current.stop();
    const h = recRef.current;
    if (!h) return;
    recRef.current = null;
    setRec('working');
    try {
      const blob = await h.stop();
      if (!blob) return;
      const said = (await transcribe(blob)).text.trim();
      if (!said) return setError(t('Ich habe nichts verstanden – bitte noch einmal sprechen.'));
      send(said, true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRec('idle');
    }
  };
  finishRef.current = finish;
  const down = () => {
    if (rec === 'idle' && onMic?.()) return;
    const m = mic.current;
    m.pressed = true;
    m.downAt = Date.now();
    m.stopOnUp = rec === 'recording';
    if (rec === 'idle') void start('hold');
  };
  const up = () => {
    const m = mic.current;
    if (!m.pressed) return;
    m.pressed = false;
    // still opening the microphone (permission prompt): the recording that comes ends on a pause
    if (m.starting) return void (modeRef.current = 'tap');
    if (rec !== 'recording') return;
    if (m.stopOnUp || Date.now() - m.downAt > 500) void finish();
    // a quick tap keeps listening and ends on a pause
    else modeRef.current = 'tap';
  };

  const startRef = useRef(start);
  startRef.current = start;
  const recState = useRef(rec);
  recState.current = rec;
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = {
      start: (mode) => void startRef.current(mode),
      release: (asTap) => {
        if (recState.current !== 'recording') {
          // still opening the microphone: the recording that comes ends on a pause
          if (mic.current.starting) modeRef.current = 'tap';
          return;
        }
        if (asTap) modeRef.current = 'tap';
        else void finishRef.current();
      },
      cancel: () => cancel(),
      canListen: () => server || browser,
    };
    return () => {
      controlRef.current = null;
    };
  });

  const placeholder = wakeHearing
    ? b.partial || t('{name} hört zu …', { name })
    : rec === 'recording'
      ? server
        ? t('Ich höre zu … {s} s', { s: Math.floor(recMs / 1000) })
        : t('Ich höre zu …')
      : rec === 'working'
        ? t('Ich schreibe mit …')
        : narrow
          ? t('Frag {name} …', { name })
          : t('Frag {name} – z. B. „Was brennt?“ oder „Erinnere Anna an die Rechnung“', { name });
  return (
    <div className="fx-prompt-wrap">
      <form
        className={`fx-prompt${busy ? ' busy' : ''}${rec !== 'idle' || wakeHearing ? ' rec' : ''}`}
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
        data-tour="focus-prompt"
      >
        <Icon name="sparkles" size={20} />
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Esc clears what was typed first; only an empty box lets Esc end focus mode (FocusPage)
            if (e.key === 'Escape' && text) {
              e.preventDefault();
              setText('');
            }
          }}
          placeholder={placeholder}
          aria-label={t('Deine Frage')}
          maxLength={1000}
          disabled={rec !== 'idle' || wakeHearing}
          autoComplete="off"
          enterKeyHint="send"
        />
        {(server || browser || !!onMic) && (
          <button
            type="button"
            className={`fx-mic${rec === 'recording' || wakeHearing || micOn ? ' on' : ''}`}
            onPointerDown={(e) => {
              e.preventDefault();
              down();
            }}
            onPointerUp={up}
            onPointerLeave={up}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                e.preventDefault();
                if (rec === 'idle' && onMic?.()) return;
                rec === 'recording' ? void finish() : void start('tap');
              }
            }}
            disabled={busy || rec === 'working' || wakeHearing}
            aria-label={rec === 'recording' ? t('Aufnahme beenden') : t('Sprechen (Taste halten oder tippen)')}
            aria-pressed={rec === 'recording'}
            title={t('Sprechen: Taste halten oder tippen – oder Alt+J')}
            data-tour="focus-mic"
          >
            <Icon name={rec === 'recording' || wakeHearing || micOn ? 'micOff' : 'mic'} size={19} />
          </button>
        )}
        <button type="submit" className="btn fx-send" disabled={busy || !text.trim() || rec !== 'idle'} aria-label={t('Fragen')}>
          {busy ? <span className="bd-spin" aria-hidden="true" /> : <Icon name="send" size={16} />}
          <span className="fx-send-text">{t('Fragen')}</span>
        </button>
      </form>
      {error && (
        <p className="fx-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
