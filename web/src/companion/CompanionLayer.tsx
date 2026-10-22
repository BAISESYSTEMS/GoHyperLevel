import { useEffect, useRef, useState } from 'react';
import { AudioLines, BellRing, EarOff, Loader2, Mic, Sparkles, X } from 'lucide-react';
import { api } from '../api';
import { useLocale, useT } from '../i18n';
import { toast, toastError, useRoute } from '../ui';
import { enterFocus } from '../focus/store';
import { bus, canWake, deliverCommand, endConversation, focusTakesOffers, interruptSpeaking, openCheckin, openOffer, release, setUnseen, setWake, summon, useBus, useCompanion, wakeOn } from './store';
import { declineOffer, liveStore, offerFrom, startLivePoll, type Offer } from './live';
import { taskBus, useTaskList } from './task-bus';
import { taskLine } from './spoken';
import { WakeListener } from './wake';
import './companion.css';

/**
 * Fokus-Modus mit Companion on every page (mounted once by the shell, a chunk of its own): the edge button on the right (summons the
 * companion – focus mode with it listening), the shortcut Alt+J (hold to talk, tap for hands-free), the wake word (only when switched
 * on for this device and only while the tab is visible; an always-visible "hört zu" mark on the edge button or in focus mode's chip
 * with a one-click off) and the proactive check-ins (polled while the tab is visible; a card next to the edge button, optionally
 * read aloud). Inside focus mode the prompt's own microphone is the companion – the edge button steps aside there, so there are
 * never two microphones on screen.
 *
 * Jarvis live (1.0.54): the poll of /api/companion/live (companion/live.ts) brings interrupts ("Neuer Lead …") – focus mode shows and
 * speaks them when it is open, otherwise a card here offers the next step (and speaks it when answers are read aloud). Agent runs that
 * end in the background are announced ("Erledigt: …" as a toast and by voice); the edge button shows running tasks and a red
 * microphone mark while a conversation keeps the microphone open.
 */

const HOLD_MS = 350;
const POLL_MS = 60_000;

/** A short two-tone "I'm listening" – Web Audio, nothing is recorded. */
function earcon() {
  try {
    const Ctx: typeof AudioContext = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ac = new Ctx();
    const now = ac.currentTime;
    [660, 880].forEach((f, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.07, now + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.08);
      o.connect(g).connect(ac.destination);
      o.start(now + i * 0.09);
      o.stop(now + i * 0.09 + 0.09);
    });
    setTimeout(() => void ac.close().catch(() => undefined), 400);
  } catch {
    /* no audio: silent */
  }
}

export function CompanionLayer() {
  const t = useT('companion');
  const locale = useLocale();
  const route = useRoute();
  const inFocus = route[0] === 'focus';
  const c = useCompanion();
  const b = useBus();
  const [checkin, setCheckin] = useState<{ id: string; title: string; body: string } | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const tasks = useTaskList();
  const running = tasks.filter((x) => x.status === 'running').length;
  const shown = useRef(new Set<string>());
  const wake = useRef<WakeListener | null>(null);
  const live = useRef({ phrase: c.wake_phrase, lang: locale, inFocus });
  live.current = { phrase: c.wake_phrase, lang: locale, inFocus };

  // --- wake word -----------------------------------------------------------------------------------------------------------
  const [wakeWanted, setWakeWanted] = useState(() => wakeOn() && canWake());
  useEffect(() => bus.on(() => setWakeWanted(wakeOn() && canWake())), []);
  useEffect(() => {
    if (!c.loaded || !wakeWanted) return;
    const l = new WakeListener({
      lang: () => (live.current.lang === 'en' ? 'en-GB' : 'de-DE'),
      phrase: () => live.current.phrase,
      onWake: () => {
        interruptSpeaking();
        earcon();
        bus.set({ activity: 'hearing', partial: '' });
        if (!live.current.inFocus) enterFocus();
      },
      onPartial: (text) => bus.set({ partial: text }),
      onCommand: (text) => {
        bus.set({ activity: 'idle', partial: '' });
        deliverCommand(text);
      },
      onTimeout: () => bus.set({ activity: 'idle', partial: '' }),
      onState: (s, error) => {
        if (s === 'error') {
          // a refused microphone turns the wake word off on this device – the person sees why in the chip and the settings
          try {
            localStorage.removeItem('pghl.companion.wake');
          } catch {
            /* nothing stored */
          }
        }
        bus.set({ wake: s, wakeError: error ?? '' });
      },
    });
    wake.current = l;
    const sync = () => {
      if (document.hidden || bus.state.micBusy || bus.state.conv) l.pause();
      else if (!l.listening) l.resume();
    };
    l.start();
    sync();
    const off = bus.on(sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      off();
      document.removeEventListener('visibilitychange', sync);
      l.stop();
      wake.current = null;
      if (bus.state.activity === 'hearing') bus.set({ activity: 'idle', partial: '' });
    };
  }, [c.loaded, wakeWanted]);

  // --- shortcut: Alt+J (hold = push to talk, tap = hands-free; Esc in focus mode stops) ----------------------------------------
  const keyDown = useRef(0);
  useEffect(() => {
    if (!c.prefs.shortcut) return;
    const isKey = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'KeyJ' || e.key.toLowerCase() === 'j');
    const down = (e: KeyboardEvent) => {
      if (!isKey(e)) return;
      e.preventDefault();
      if (e.repeat || keyDown.current) return;
      keyDown.current = Date.now();
      summon('hold');
    };
    const up = (e: KeyboardEvent) => {
      if (!keyDown.current || !(e.code === 'KeyJ' || e.key === 'Alt' || e.key.toLowerCase() === 'j')) return;
      const held = Date.now() - keyDown.current;
      keyDown.current = 0;
      // a quick press keeps listening until the person pauses; a long one ends with the key
      release(held < HOLD_MS);
    };
    const blur = () => {
      if (keyDown.current) {
        keyDown.current = 0;
        release();
      }
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
    };
  }, [c.prefs.shortcut]);

  // --- check-ins -----------------------------------------------------------------------------------------------------------
  const checkinsOn = c.loaded && c.prefs.checkin.mode !== 'off';
  useEffect(() => {
    if (!checkinsOn) return;
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      const list = await api.get<any[]>('/api/companion/checkins?unseen=1').catch(() => null);
      if (!alive || !list) return;
      setUnseen(list.length);
      const top = list[0];
      if (!top || shown.current.has(top.id)) return;
      shown.current.add(top.id);
      const first = top.hotspots?.[0];
      setCheckin({ id: top.id, title: first ? t('{name}: {n} Brennpunkte', { name: c.name, n: top.hotspots.length }) : t('{name}: alles ruhig', { name: c.name }), body: first ? `${first.title} – ${first.detail}` : top.say });
      if (c.prefs.checkin.speak) {
        const [{ readAloud }, { companionSpeech }] = await Promise.all([import('../focus/speech'), import('./voice')]);
        void readAloud(top.say, { ...(await companionSpeech(c.prefs, locale === 'en' ? 'en' : 'de')), lang: locale === 'en' ? 'en' : 'de' });
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    const vis = () => !document.hidden && void poll();
    document.addEventListener('visibilitychange', vis);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [checkinsOn, c.name, c.prefs.checkin.speak, c.prefs.browser_voice, c.prefs.tts_provider, c.prefs.tts_connection_id, c.prefs.tts_voice, locale, t]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Jarvis live: interrupts and background tasks ------------------------------------------------------------------------
  const speakRef = useRef<(text: string) => void>(() => undefined);
  speakRef.current = (text: string) => {
    if (!c.prefs.voice_reply || document.hidden) return;
    void Promise.all([import('../focus/speech'), import('./voice')]).then(async ([{ readAloud }, { companionSpeech }]) => readAloud(text, { ...(await companionSpeech(c.prefs, locale === 'en' ? 'en' : 'de')), lang: locale === 'en' ? 'en' : 'de' }));
  };
  useEffect(() => {
    if (!c.loaded) return;
    const stop = startLivePoll();
    const off = liveStore.onEvent((e) => {
      const o = offerFrom(e);
      // focus mode is open: it shows and speaks the offer (and listens for "ja" when a conversation runs)
      if (focusTakesOffers()) return openOffer(o);
      setOffer(o);
      liveStore.set({ offer: o });
      if (e.route === 'speak') speakRef.current(e.say);
    });
    return () => {
      stop();
      off();
    };
  }, [c.loaded]);
  useEffect(
    () =>
      taskBus.onSettled((task, watched) => {
        if (watched) return;
        const lang = locale === 'en' ? 'en' : 'de';
        const line = taskLine(task.status === 'confirm' ? 'confirm' : task.status === 'done' ? 'done' : task.status === 'stopped' ? 'stopped' : 'failed', task.confirmTitle || task.label, lang);
        if (task.status === 'failed') toastError(line);
        else toast(line);
        if (task.status !== 'stopped') speakRef.current(line);
      }),
    [locale],
  );

  const openCard = () => {
    if (!checkin) return;
    const id = checkin.id;
    setCheckin(null);
    openCheckin(id);
  };
  const dismissCard = () => {
    if (!checkin) return;
    void api.post(`/api/companion/checkins/${checkin.id}/seen`, {}).catch(() => undefined);
    setUnseen(Math.max(0, c.unseen - 1));
    setCheckin(null);
  };

  const listening = b.wake === 'on' || b.wake === 'starting';
  const state = b.activity !== 'idle' ? b.activity : listening ? 'wake' : 'idle';
  const label =
    state === 'hearing'
      ? t('{name} hört zu …', { name: c.name })
      : state === 'thinking'
        ? t('{name} denkt nach …', { name: c.name })
        : state === 'speaking'
          ? t('{name} spricht – klicken zum Unterbrechen', { name: c.name })
          : listening
            ? t('{name} wartet auf „{phrase}“ – klicken zum Sprechen', { name: c.name, phrase: c.wake_phrase })
            : t('Mit {name} sprechen (Alt+J)', { name: c.name });

  return (
    <>
      {!inFocus && (
        <div className={`cmp-edge s-${state}${c.unseen ? ' has-news' : ''}`} data-tour="companion-edge">
          <button type="button" className="cmp-edge-btn" onClick={() => (state === 'speaking' ? interruptSpeaking() : summon('tap'))} aria-label={label} title={label}>
            <span className="cmp-edge-face" aria-hidden="true">
              {c.agent.id ? c.agent.emoji : <AudioLines size={20} />}
            </span>
            {listening && <span className="cmp-edge-ear" aria-hidden="true" />}
            {b.conv && (
              <span className="cmp-edge-mic" aria-hidden="true">
                <Mic size={10} />
              </span>
            )}
            {running > 0 && (
              <span className="cmp-edge-task" title={t('{n} Aufgaben laufen', { n: running })}>
                <Loader2 size={11} className="cmp-spin-ico" aria-hidden="true" />
              </span>
            )}
            {c.unseen > 0 && <span className="cmp-edge-badge">{c.unseen > 9 ? '9+' : c.unseen}</span>}
          </button>
          {b.conv && (
            <button type="button" className="cmp-edge-off" onClick={() => endConversation()} aria-label={t('Gespräch beenden (Esc)')} title={t('Mikro an – klicken zum Beenden')}>
              <X size={14} />
            </button>
          )}
          {listening && (
            <button type="button" className="cmp-edge-off" onClick={() => setWake(false)} aria-label={t('Weckwort ausschalten')} title={t('Hört auf „{phrase}“ – klicken zum Ausschalten', { phrase: c.wake_phrase })}>
              <EarOff size={14} />
            </button>
          )}
        </div>
      )}
      {offer && !inFocus && (
        <div className="cmp-card cmp-card-offer" role="status" aria-live="polite" data-tour="companion-event">
          <span className="cmp-card-icon" aria-hidden="true">
            <Sparkles size={17} />
          </span>
          <button
            type="button"
            className="cmp-card-main"
            onClick={() => {
              setOffer(null);
              openOffer({ ...offer, accept: true });
            }}
          >
            <strong>{offer.title}</strong>
            <span>{offer.say}</span>
            <em>{t('Ja, bitte')}</em>
          </button>
          <button
            type="button"
            className="icon-btn cmp-card-x"
            onClick={() => {
              declineOffer(offer);
              setOffer(null);
            }}
            aria-label={t('Nein danke')}
            title={t('Nein danke')}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {checkin && (
        <div className="cmp-card" role="status" aria-live="polite" data-tour="companion-checkin">
          <span className="cmp-card-icon" aria-hidden="true">
            <BellRing size={17} />
          </span>
          <button type="button" className="cmp-card-main" onClick={openCard}>
            <strong>{checkin.title}</strong>
            <span>{checkin.body}</span>
            <em>{t('Ansehen')}</em>
          </button>
          <button type="button" className="icon-btn cmp-card-x" onClick={dismissCard} aria-label={t('Später')} title={t('Später')}>
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );
}
