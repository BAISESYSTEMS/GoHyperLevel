import { useEffect, useRef, useState } from 'react';
import { EarOff, Menu, Settings2, Volume2, VolumeX, X } from 'lucide-react';
import { api } from '../api';
import { Go } from '../boards/views';
import { useLocale, useT } from '../i18n';
import { Icon } from '../icons';
import { can, useSession } from '../session';
import { navigate, toastError } from '../ui';
import { AgentInline, useAgentRun } from '../companion/AgentRun';
import { Briefing, type BriefingView, type NextStep } from '../companion/Briefing';
import { CompanionSettings } from '../companion/CompanionSettings';
import { bus, isBriefingAsk, saveCompanion, setUnseen, setWake, useBus, useCompanion } from '../companion/store';
import { loadVoiceInfo, speechPlan, type VoiceInfo } from '../companion/voice';
import { Conversation } from '../companion/conversation';
import { acceptOffer, declineOffer, liveStore, offerFrom, offerFromSuggestion, offerOpen, useLive, type LiveEvent, type LiveSuggestion, type Offer } from '../companion/live';
import { ConvPill, OfferCard, SuggestionList, TaskList } from '../companion/Proactive';
import { realtimeEngine, type RealtimeEngine } from '../companion/realtime';
import { SpeakQueue } from '../companion/speak-queue';
import { SentenceSplitter, filler } from '../companion/spoken';
import { taskBus, useTaskList } from '../companion/task-bus';
import { bringToFront, currentRun } from '../companion/tasks';
import type { ConvPhase } from '../companion/vad';
import { FocusPrompt, type PromptControl } from './FocusPrompt';
import { FocusTiles, TileSkeleton } from './FocusTiles';
import { canReadAloud, readAloud, stopReading } from './speech';
import { exitFocus, focusFrom } from './store';
import type { FocusAnswer, FocusStatus, HistoryItem } from './types';
import '../boards/boards.css';
import './focus.css';
import '../companion/companion.css';

/**
 * Fokus-Modus mit Companion (docs/living-boards.md#fokus-modus-mit-companion): no menus, just a question – to the companion ("Jarvis"
 * or another agent the person picked). Typed or spoken, a question about the data becomes a view made of the Living Boards' widgets
 * (POST /api/focus/ask, read only, rules without AI); asking for something to be done goes to the companion's HyperLevel Agent right
 * here – its words, tool steps and confirmation card render in the result area, with the agent's rights, confirmations, audit log
 * and undo. "Was brennt?" and the proactive check-ins show the Brennpunkte and the next steps. One voice reads the answers (the
 * sentence of a view, the agent's final words). Voice never confirms. Esc (with an empty box and nothing open) or "Fokus beenden"
 * returns to the normal layout.
 *
 * Jarvis live (1.0.54): Gesprächsmodus – after a spoken question the microphone stays open (companion/conversation.ts): the answer is
 * spoken sentence by sentence while the agent still writes, the person may talk over it (barge-in, also a click or Space) and simply
 * keeps talking in the follow-up window; "danke Jarvis" / silence / Esc / ✕ end it. A longer task gets a short filler and goes on in
 * the background (companion/tasks.ts) while the person asks the next thing; its end is announced. Proactive offers (events, the
 * initiative's suggestions) show here with their prepared draft; "ja" hands them to the agent – its confirmation card still needs a
 * click. With the realtime engine (Gemini Live) the conversation runs through companion/realtime.ts instead.
 */

/** German texts are the message ids – the chips send the question in the UI language. */
const CHIPS = ['Was brennt?', 'Offene Deals', 'Umsatz diesen Monat', 'Was ist überfällig?', 'Termine heute', 'Neue Kontakte diese Woche', 'Ungelesene Nachrichten'];
const MAX_HISTORY = 8;
const READ_KEY = 'pghl.focus.read';
const historyKey = (loc: string) => `pghl.focus.history.${loc}`;
/** A bare "yes" while a confirmation waits: never sent, never confirming – the card needs a click. */
const YES = /^(ja|jo|jep|jawohl|ok(ay)?|okey|gerne?|mach( das| es)?|mach'?s|bestätig(e|en)?|ausführen|los|klar|passt|yes|yep|sure|do it|go( ahead)?|confirm)[.!\s]*$/i;
const NO = /^(nein|nee|nö|stopp?|abbrechen|ablehnen|lass( es| das)?|doch nicht|no|nope|cancel|stop|reject)[.!\s]*$/i;

const loadQuestions = (loc: string): HistoryItem[] => {
  try {
    const v = JSON.parse(localStorage.getItem(historyKey(loc)) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.q === 'string').slice(0, MAX_HISTORY).map((x) => ({ q: String(x.q).slice(0, 300), at: Number(x.at) || 0 })) : [];
  } catch {
    return [];
  }
};
const saveQuestions = (loc: string, list: HistoryItem[]) => {
  try {
    localStorage.setItem(historyKey(loc), JSON.stringify(list.map(({ q, at }) => ({ q, at }))));
  } catch {
    /* storage blocked: the list lasts as long as the page */
  }
};
/** The old per-browser switch "Antworten vorlesen" – used until the person chooses in the companion settings. */
const loadRead = () => {
  try {
    return localStorage.getItem(READ_KEY) === '1';
  } catch {
    return false;
  }
};

/** The round button at the top left: the normal menu as a drawer (choosing an entry leaves focus mode and goes there). */
export function FocusFab({ open, onMenu }: { open: boolean; onMenu: () => void }) {
  const t = useT('focus');
  return (
    <button type="button" className="fx-fab" onClick={onMenu} aria-label={t('Menü öffnen')} title={t('Menü öffnen')} aria-expanded={open} aria-controls="side-nav" data-tour="focus-menu">
      <Menu size={20} />
    </button>
  );
}

type Mode = 'idle' | 'tiles' | 'agent' | 'briefing';

export function FocusPage() {
  const t = useT('focus');
  const locale = useLocale();
  const lang: 'de' | 'en' = locale === 'en' ? 'en' : 'de';
  const session = useSession();
  const loc = session.locationId;
  const c = useCompanion();
  const b = useBus();
  const [status, setStatus] = useState<FocusStatus | null>(null);
  const [voice, setVoice] = useState<VoiceInfo & { ready: boolean }>({ stt: false, tts: false, connections: [], ready: false });
  const [agentReady, setAgentReady] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [answer, setAnswer] = useState<FocusAnswer | null>(null);
  const [brief, setBrief] = useState<BriefingView | null>(null);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>(() => loadQuestions(loc));
  const [speaking, setSpeaking] = useState(false);
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState(false);
  const [phase, setPhase] = useState<ConvPhase>('idle');
  const [convOn, setConvOn] = useState(false);
  const [liveOn, setLiveOn] = useState(false);
  const [liveText, setLiveText] = useState<{ user: string; model: string }>({ user: '', model: '' });
  const [offer, setOffer] = useState<{ o: Offer; draft?: string } | null>(null);
  const liveState = useLive();
  const taskList = useTaskList();
  const conv = useRef<Conversation | null>(null);
  const engine = useRef<RealtimeEngine | null>(null);
  const liveFailed = useRef(false);
  const live = useRef({ prefs: c.prefs, name: c.name, stt: false, lang });
  live.current = { prefs: c.prefs, name: c.name, stt: voice.stt, lang };
  const input = useRef<HTMLInputElement>(null);
  const prompt = useRef<PromptControl | null>(null);
  const seq = useRef(0);
  const speakSeq = useRef(0);
  const agentId = c.agent_missing ? null : c.prefs.agent_id;
  // the page focus mode was opened from travels along: "erledige das hier" means its record
  const run = useAgentRun(agentId, () => ({ route: 'focus', label: 'Fokus-Modus', from: focusFrom() })); // i18n-ignore (context for the agent, not shown)
  const readAll = c.prefs.read_aloud ?? loadRead();
  // another companion picked in the settings: its own conversation from the next request on
  const lastAgent = useRef(agentId);
  useEffect(() => {
    if (lastAgent.current === agentId) return;
    lastAgent.current = agentId;
    run.reset();
    setMode((m) => (m === 'agent' ? 'idle' : m));
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get<FocusStatus>('/api/focus/status').then(setStatus).catch(() => setStatus(null));
    void loadVoiceInfo().then((v) => setVoice({ ...v, ready: true }));
    api
      .get('/api/agent/bootstrap')
      .then((x) => setAgentReady(!x?.error && x?.enabled !== false && !!(x?.connection || x?.models?.length || x?.bridge?.paired)))
      .catch(() => setAgentReady(false));
  }, [loc]);
  useEffect(() => {
    // the box is ready to type into – not on touch screens, where the keyboard would cover half the page at once
    if (typeof matchMedia !== 'function' || !matchMedia('(pointer: coarse)').matches) input.current?.focus({ preventScroll: true });
    return () => {
      stopReading();
      conv.current?.close('user');
      engine.current?.stop();
      taskBus.setViewing(null);
      bus.set({ activity: 'idle', conv: false });
    };
  }, []);
  // the run shown here: its end is spoken here; any other run's end is announced by the companion layer
  useEffect(() => {
    taskBus.setViewing(mode === 'agent' ? run.id : null);
  }, [mode, run.id]);

  // --- Gesprächsmodus: the open microphone after a spoken question ----------------------------------------------------------
  const wantsConv = () => live.current.prefs.conversation_window > 0 || live.current.prefs.barge_in;
  const getConv = () => {
    if (!conv.current)
      conv.current = new Conversation({
        lang: () => live.current.lang,
        name: () => live.current.name,
        serverStt: () => live.current.stt,
        windowMs: () => live.current.prefs.conversation_window * 1000,
        bargeIn: () => live.current.prefs.barge_in,
        hooks: {
          onPhase: (p) => {
            setPhase(p);
            if (p === 'listening') bus.set({ activity: 'hearing', partial: '' });
            else if (bus.state.activity === 'hearing') bus.set({ activity: 'idle' });
          },
          onUtterance: (text) => void askRef.current(text, true),
          onBargeIn: () => {
            stopRef.current();
            void conv.current?.listen();
          },
          onClose: () => {
            setConvOn(false);
            setPhase('idle');
            bus.set({ conv: false, micBusy: false });
            if (bus.state.activity === 'hearing') bus.set({ activity: 'idle' });
          },
        },
      });
    return conv.current;
  };
  const startConv = async () => {
    if (engine.current?.running || !wantsConv()) return false;
    const ok = await getConv().open();
    if (ok) {
      setConvOn(true);
      bus.set({ conv: true, micBusy: true });
    }
    return ok;
  };
  const endConv = () => {
    conv.current?.close('user');
    engine.current?.stop();
  };
  /** after the companion spoke: the follow-up window (or, without one, the end of the open microphone) */
  const afterTurn = () => {
    const cv = conv.current;
    if (!cv?.active) return;
    if (live.current.prefs.conversation_window > 0) void cv.listen();
    else cv.close('silence');
  };
  /** the person is mid-sentence: the companion waits (at most 5 s) before it speaks */
  const quietUser = async () => {
    for (let i = 0; i < 50 && conv.current?.userSpeaking; i++) await new Promise((r) => setTimeout(r, 100));
  };

  const stopSpeaking = () => {
    speakSeq.current++;
    stopReading();
    setSpeaking(false);
    if (bus.state.activity === 'speaking') bus.set({ activity: 'idle' });
  };
  /** One voice for everything: the sentence of a view, a briefing, the agent's final words. */
  const speakOut = async (text: string, asked: boolean, force = false) => {
    if (!text || !(force || readAll || (asked && c.prefs.voice_reply))) return afterTurn();
    const n = ++speakSeq.current;
    await quietUser();
    if (n !== speakSeq.current) return;
    setSpeaking(true);
    bus.set({ activity: 'speaking' });
    conv.current?.speaking();
    await readAloud(text, { ...speechPlan(c.prefs, voice, lang), lang });
    if (n !== speakSeq.current) return;
    setSpeaking(false);
    if (bus.state.activity === 'speaking') bus.set({ activity: 'idle' });
    afterTurn();
  };
  const toggleRead = () => {
    const next = !readAll;
    void saveCompanion({ read_aloud: next }).catch(toastError);
    if (!next) stopSpeaking();
  };

  const remember = (q: string, r?: FocusAnswer) =>
    setHistory((list) => {
      const next = [{ q, at: Date.now(), answer: r }, ...list.filter((h) => h.q.toLowerCase() !== q.toLowerCase())].slice(0, MAX_HISTORY);
      saveQuestions(loc, next);
      return next;
    });

  /**
   * Something to be done → the companion's agent, right here. A run that still works goes on in the background (its end is
   * announced). The answer is spoken sentence by sentence while the agent writes; a longer task first gets a short filler, and the
   * person may keep talking meanwhile.
   */
  const toAgent = async (q: string, asked: boolean, entity?: NextStep['entity'], display?: string) => {
    if (run.busy || run.confirm) run.detach();
    const rid = currentRun(agentId).id;
    taskBus.setViewing(rid);
    setMode('agent');
    setQuestion(display || q);
    setAnswer(null);
    setBrief(null);
    setNote('');
    setError('');
    bus.set({ activity: 'thinking' });
    conv.current?.thinking();
    const wanted = readAll || (asked && c.prefs.voice_reply);
    const plan = { ...speechPlan(c.prefs, voice, lang), lang };
    const splitter = new SentenceSplitter();
    let fill = '';
    const queue = wanted
      ? new SpeakQueue(
          async (sentence) => {
            await quietUser();
            if (queue!.cancelled) return;
            setSpeaking(true);
            bus.set({ activity: 'speaking' });
            conv.current?.speaking();
            await readAloud(sentence, { ...plan, queue: true });
            // after the filler the person may go on talking while the agent works
            if (sentence === fill && currentRun(agentId).busy && conv.current?.active && live.current.prefs.conversation_window > 0) void conv.current.listen();
          },
          {
            onEnd: () => {
              setSpeaking(false);
              if (bus.state.activity === 'speaking') bus.set({ activity: currentRun(agentId).busy ? 'thinking' : 'idle' });
            },
          },
        )
      : null;
    const timer = setTimeout(() => {
      if (!queue || queue.started || queue.cancelled || !currentRun(agentId).busy) return;
      fill = filler(lang);
      queue.push(fill);
    }, 1400);
    const r = await run.send(q, entity, display, (d) => {
      if (queue) for (const sentence of splitter.push(d)) queue.push(sentence);
    });
    clearTimeout(timer);
    if (bus.state.activity === 'thinking') bus.set({ activity: 'idle' });
    // moved to the background meanwhile: the companion layer announces its end
    if (taskBus.viewing !== rid) return void queue?.cancel();
    if (r.confirm) {
      const rest = splitter.flush();
      if (rest && queue) queue.push(rest);
      const ask = t('Soll ich das ausführen: {title}? Bitte tippe selbst auf „Ausführen“ – per Stimme bestätige ich nichts.', { title: r.confirm.title });
      if (queue) queue.push(ask);
      else return void speakOut(ask, asked);
    } else if (!r.error && queue) queue.push(splitter.flush());
    if (!queue) return afterTurn();
    queue.end();
    if (await queue.done) afterTurn();
  };
  /** The realtime voice hands a request to the agent: the same path, no speaking (the live model speaks). */
  const toAgentLive = async (request: string): Promise<{ result: string; confirm: boolean }> => {
    if (run.busy || run.confirm) run.detach();
    taskBus.setViewing(currentRun(agentId).id);
    setMode('agent');
    setAnswer(null);
    setBrief(null);
    setQuestion(request);
    const r = await run.send(request, undefined, request);
    if (r.confirm) return { result: t('Wartet auf Bestätigung per Klick auf dem Bildschirm: {title}. Eine gesprochene Zustimmung bestätigt nichts.', { title: r.confirm.title }), confirm: true };
    return { result: r.error ? `${t('Fehler')}: ${r.error}` : r.text || t('Erledigt.'), confirm: false };
  };

  // --- Echtzeit-Stimme (Gemini Live) ----------------------------------------------------------------------------------------
  const startLive = async () => {
    if (engine.current?.running) return;
    conv.current?.close('user');
    const e = realtimeEngine('gemini_live', {
      onState: (st) => {
        setPhase(st === 'connecting' ? 'thinking' : st);
        bus.set({ activity: st === 'listening' ? 'hearing' : st === 'speaking' ? 'speaking' : st === 'idle' ? 'idle' : 'thinking' });
      },
      onTranscript: (who, text) => setLiveText((x) => (who === 'user' ? { user: text, model: '' } : { ...x, model: `${x.model}${text}`.slice(-600) })),
      onTool: (request) => toAgentLive(request),
      onEnd: () => {
        setLiveOn(false);
        setPhase('idle');
        bus.set({ conv: false, micBusy: false, activity: 'idle' });
      },
      onFallback: (msg) => {
        liveFailed.current = true;
        setLiveOn(false);
        setPhase('idle');
        bus.set({ conv: false, micBusy: false, activity: 'idle' });
        setNote(t('Echtzeit-Stimme gerade nicht verfügbar – ich nutze die klassische Stimme. {reason}', { reason: msg }));
        if (prompt.current?.canListen()) prompt.current.start('tap');
      },
    });
    if (!e) return;
    engine.current = e;
    setLiveOn(true);
    setLiveText({ user: '', model: '' });
    bus.set({ conv: true, micBusy: true });
    await e.start();
  };
  /** The microphone (button, Alt+J, edge button): the realtime voice when chosen and working, else the prompt's recording. */
  const liveChosen = () => c.prefs.voice_engine === 'gemini_live' && !liveFailed.current;

  // --- proactive offers --------------------------------------------------------------------------------------------------
  const showOffer = (o: Offer, draft?: string, speakIt = true) => {
    setOffer({ o, draft });
    liveStore.set({ offer: o });
    if (speakIt && o.say) void speakOut(o.say, false, true);
  };
  const answerOffer = async (yes: boolean, asked = false, given?: Offer) => {
    const o = given ?? offer?.o ?? liveStore.state.offer;
    setOffer(null);
    if (!o) return;
    if (!yes) {
      declineOffer(o);
      return afterTurn();
    }
    const a = await acceptOffer(o);
    if (a?.prompt) return toAgent(a.prompt, asked, a.entity ?? undefined, a.label);
    if (a?.url) navigate(a.url);
    afterTurn();
  };
  const pickSuggestion = (sg: LiveSuggestion) => showOffer(offerFromSuggestion(sg), sg.draft || undefined, false);

  /** "Was brennt?" or a check-in: the Brennpunkte and the next steps as the current view. */
  const showBriefing = async (o: { q?: string; checkin?: string; asked?: boolean }) => {
    const n = ++seq.current;
    stopSpeaking();
    setMode('briefing');
    setAnswer(null);
    setBrief(null);
    setNote('');
    setError('');
    setQuestion(o.q ?? t('Was brennt?'));
    setBusy(true);
    bus.set({ activity: 'thinking' });
    try {
      const r = o.checkin ? await api.get<BriefingView>(`/api/companion/checkins/${o.checkin}`) : await api.get<BriefingView>(`/api/companion/briefing?lang=${lang}`);
      if (n !== seq.current) return;
      setBrief(r);
      if (r.suggestions?.length) setOffer({ o: offerFromSuggestion(r.suggestions[0]), draft: r.suggestions[0].draft || undefined });
      if (o.checkin) {
        void api.post(`/api/companion/checkins/${o.checkin}/seen`, {}).catch(() => undefined);
        void api.get<any[]>('/api/companion/checkins?unseen=1').then((l) => setUnseen(l.length)).catch(() => undefined);
      } else if (o.q) remember(o.q);
      if (bus.state.activity === 'thinking') bus.set({ activity: 'idle' });
      void speakOut([r.say, r.offer].filter(Boolean).join(' '), !!o.asked, !!o.checkin && c.prefs.checkin.speak);
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
      afterTurn();
    } finally {
      if (n === seq.current) setBusy(false);
      if (bus.state.activity === 'thinking') bus.set({ activity: 'idle' });
    }
  };

  /** `asked`: spoken; `fresh`: a chip or a recent question – never an answer to the agent's question */
  const ask = async (raw: string, asked = false, fresh = false) => {
    const q = raw.trim();
    if (!q) return;
    stopSpeaking();
    // a spoken question opens the conversation (follow-up window, barge-in) – only while the companion is in use
    if (asked && !conv.current?.active) void startConv();
    // a confirmation waits: a bare "ja" never confirms (typed or spoken), a bare "nein" declines like the card's button
    if (run.confirm) {
      if (YES.test(q)) {
        const hint = t('Bestätigen geht nur mit einem Klick auf „Ausführen“ – per Stimme oder Text bestätige ich nichts.');
        setNote(hint);
        void speakOut(hint, asked);
        return;
      }
      if (NO.test(q)) {
        setNote('');
        bus.set({ activity: 'thinking' });
        const r = await run.decide(false);
        if (bus.state.activity === 'thinking') bus.set({ activity: 'idle' });
        if (r?.text) void speakOut(r.text, asked);
        else afterTurn();
        return;
      }
    }
    // the companion offered something: "ja" hands it to the agent (which still asks before it sends), "nein" declines
    if (offerOpen(liveStore.state.offer) && (YES.test(q) || NO.test(q))) return void answerOffer(YES.test(q), asked);
    if (isBriefingAsk(q)) return showBriefing({ q, asked });
    // the agent asked something: the next input answers it
    if (!fresh && mode === 'agent' && run.items.length && run.asked() && agentReady) return toAgent(q, asked);
    const n = ++seq.current;
    setBusy(true);
    setError('');
    setNote('');
    setSaved(null);
    setQuestion(q);
    bus.set({ activity: 'thinking' });
    try {
      const previous = history.map((h) => h.q).filter((h) => h !== q).slice(0, 4).reverse();
      const r = await api.post<FocusAnswer>('/api/focus/ask', { text: q, history: previous, lang });
      if (n !== seq.current) return;
      if (r.action && agentReady) {
        setBusy(false);
        remember(q);
        return toAgent(q, asked);
      }
      setMode('tiles');
      setBrief(null);
      setAnswer(r);
      remember(q, r);
      if (r.note === 'limit' && status?.ai) setStatus({ ...status, ai: false });
      if (bus.state.activity === 'thinking') bus.set({ activity: 'idle' });
      // an action without an agent only gets the offer – the sentence is still read
      void speakOut(r.say, asked);
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
      afterTurn();
    } finally {
      if (n === seq.current) setBusy(false);
      if (bus.state.activity === 'thinking') bus.set({ activity: 'idle' });
    }
  };
  const askRef = useRef(ask);
  askRef.current = ask;
  const briefRef = useRef(showBriefing);
  briefRef.current = showBriefing;
  const stopRef = useRef(stopSpeaking);
  stopRef.current = stopSpeaking;
  const showOfferRef = useRef(showOffer);
  showOfferRef.current = showOffer;
  const acceptRef = useRef((o: Offer) => answerOffer(true, false, o));
  acceptRef.current = (o: Offer) => answerOffer(true, false, o);
  const liveRef = useRef({ start: startLive, use: liveChosen, end: endConv });
  liveRef.current = { start: startLive, use: liveChosen, end: endConv };

  // The companion's bus: edge button, shortcut and wake word reach the prompt here (once the voice settings are known).
  useEffect(() => {
    if (!voice.ready) return;
    return bus.attach({
      start: (m) => {
        stopRef.current();
        if (liveRef.current.use()) return void liveRef.current.start();
        if (prompt.current?.canListen()) prompt.current.start(m);
        else input.current?.focus();
      },
      release: (asTap) => prompt.current?.release(asTap),
      command: (text) => void askRef.current(text, true),
      checkin: (id) => void briefRef.current({ checkin: id }),
      stopSpeaking: () => stopRef.current(),
      proactive: (o) => {
        if (o.accept) return void acceptRef.current(o);
        const ev = liveStore.state.events.find((e) => e.id === o.eventId);
        showOfferRef.current(o, ev?.suggestion?.draft || undefined, o.speak !== false);
      },
      endConversation: () => liveRef.current.end(),
    });
  }, [voice.ready]);
  // a check-in opened from a notification: /app/focus?checkin=<id>; a companion event: ?event=<id>
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const id = q.get('checkin');
    const ev = q.get('event');
    if (ev && /^[A-Za-z0-9_-]{1,64}$/.test(ev)) {
      window.history.replaceState(null, '', location.pathname);
      void api
        .get<LiveEvent>(`/api/companion/events/${ev}`)
        .then((e) => showOffer(offerFrom(e), e.suggestion?.draft || undefined, false))
        .catch(() => undefined);
    }
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
    window.history.replaceState(null, '', location.pathname);
    void showBriefing({ checkin: id });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Space while the companion speaks: interrupt (and listen when a conversation is open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || bus.state.activity !== 'speaking') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName))) return;
      e.preventDefault();
      stopRef.current();
      if (conv.current?.active) void conv.current.listen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** A question from the list: its answer at once when it is still here, else asked again. */
  const jump = (h: HistoryItem) => {
    if (!h.answer) return void ask(h.q, false, true);
    stopSpeaking();
    setMode('tiles');
    setQuestion(h.q);
    setAnswer(h.answer);
    setBrief(null);
    setError('');
    setSaved(null);
  };

  /** A next step of a briefing: the agent's task (it asks before anything goes out), or the page to check. */
  const onStep = (s: NextStep) => {
    if (s.prompt && agentReady) return void toAgent(s.prompt, false, s.entity, s.label);
    if (s.url) return navigate(s.url);
    if (s.prompt) window.dispatchEvent(new CustomEvent('pghl:agent', { detail: { prompt: s.prompt, agentId } }));
  };

  const save = async () => {
    if (!answer?.tiles.length || saving) return;
    setSaving(true);
    try {
      const name = (question || t('Fokus')).slice(0, 80);
      const board = await api.post<{ id: string; name: string }>('/api/boards', { name, scope: 'personal', icon: 'goal' });
      await api.post(`/api/boards/${board.id}/patch`, { ops: answer.tiles.map((x) => ({ op: 'add', type: x.type, title: x.title, config: x.config, w: x.w, h: x.h })), summary: t('Aus dem Fokus-Modus gespeichert') });
      setSaved({ id: board.id, name: board.name });
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };

  const continueInAgent = () => window.dispatchEvent(new CustomEvent('pghl:agent', { detail: { prompt: answer?.action ?? question, agentId } }));

  // Esc with nothing else open and nothing typed: stop listening or speaking first, then back to the normal layout.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"], .agent-panel, .modal-bg')) return;
      if (bus.state.micBusy || bus.state.activity === 'hearing') {
        e.preventDefault();
        prompt.current?.cancel();
        bus.set({ activity: 'idle', partial: '' });
        return;
      }
      if (bus.state.activity === 'speaking') {
        e.preventDefault();
        stopRef.current();
        return;
      }
      if (bus.state.conv) {
        e.preventDefault();
        liveRef.current.end();
        return;
      }
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== input.current && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      stopReading();
      exitFocus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hour = new Date().getHours();
  const hello = hour < 11 ? t('Guten Morgen') : hour < 18 ? t('Hallo') : t('Guten Abend');
  const first = (session.user.name || '').split(/\s+/)[0];
  const noteText = answer?.source === 'ai' ? t('Von der KI zusammengestellt') : answer?.note === 'limit' ? t('KI-Limit für diese Stunde erreicht – nach festen Regeln zusammengestellt') : t('Nach festen Regeln zusammengestellt');
  const shown = mode !== 'idle' || busy || !!error;
  const wakeListening = b.wake === 'on' || b.wake === 'starting';
  const emoji = c.agent.id ? c.agent.emoji : '✨';
  const canSpeak = canReadAloud(voice.tts || !!speechPlan(c.prefs, voice).tts);
  const chipState = b.activity === 'hearing' ? t('hört zu …') : b.activity === 'thinking' ? t('denkt nach …') : b.activity === 'speaking' ? t('spricht …') : wakeListening ? t('wartet auf „{phrase}“', { phrase: c.wake_phrase }) : t('bereit');

  return (
    <div className={`fx-page bd-page${shown ? ' has-answer' : ''}`}>
      <div className="fx-top">
        <span className="fx-top-title">
          <Icon name="goal" size={15} /> {t('Fokus mit {name}', { name: c.name })}
        </span>
        <button type="button" className="btn secondary small fx-exit" onClick={exitFocus} title={t('Zurück zur normalen Ansicht (Esc)')} data-tour="focus-exit">
          <X size={15} /> {t('Fokus beenden')}
        </button>
      </div>

      <section className="fx-hero" aria-label={t('Frage stellen')}>
        <h1 className="fx-hello">
          {first ? `${hello}, ${first}.` : `${hello}.`} <span>{t('Was kann {name} für dich tun?', { name: c.name })}</span>
        </h1>
        <FocusPrompt busy={busy} serverStt={voice.stt} lang={lang} name={c.name} onAsk={(q, v) => void ask(q, v)} inputRef={input} controlRef={prompt} onMic={liveChosen() ? () => (void (liveOn ? endConv() : startLive()), true) : undefined} micOn={liveOn} />
        <div className="fx-opts">
          <span className={`cmp-chip s-${b.activity}${wakeListening ? ' ear' : ''}`} data-tour="companion-chip">
            <button type="button" className="cmp-chip-main" onClick={() => setSettings(true)} aria-haspopup="dialog" aria-label={t('{name}: Companion und Check-ins einstellen', { name: c.name })} title={t('{name}: Companion und Check-ins einstellen', { name: c.name })}>
              <span className="cmp-chip-face" aria-hidden="true">
                {emoji}
              </span>
              <span className="cmp-chip-name">{c.name}</span>
              <span className="cmp-chip-state">{chipState}</span>
              {c.unseen > 0 && <span className="cmp-chip-badge">{t('{n} neu', { n: c.unseen })}</span>}
              <Settings2 size={14} aria-hidden="true" />
            </button>
            {wakeListening && (
              <button type="button" className="cmp-chip-off" onClick={() => setWake(false)} aria-label={t('Weckwort ausschalten')} title={t('Weckwort ausschalten')}>
                <EarOff size={14} />
              </button>
            )}
          </span>
          {canSpeak && (
            <button type="button" className={`fx-toggle${readAll ? ' on' : ''}`} role="switch" aria-checked={readAll} onClick={toggleRead}>
              {readAll ? <Volume2 size={15} /> : <VolumeX size={15} />} {t('Antworten vorlesen')}
            </button>
          )}
          {status && (
            <span className="fx-mode" title={status.reason ?? undefined}>
              <Icon name={status.ai ? 'sparkles' : 'list'} size={13} /> {status.ai ? t('KI stellt die Ansicht zusammen') : t('Ohne KI: feste Regeln für häufige Fragen')}
            </span>
          )}
        </div>
        {(convOn || liveOn) && <ConvPill phase={phase} name={c.name} live={liveOn} onEnd={endConv} />}
        {liveOn && (liveText.user || liveText.model) && (
          <div className="cmp-live-text" aria-live="polite">
            {liveText.user && <p className="fx-q">{t('„{question}“', { question: liveText.user })}</p>}
            {liveText.model && <p>{liveText.model}</p>}
          </div>
        )}
        {offer && <OfferCard offer={offer.o} draft={offer.draft} name={c.name} emoji={emoji} onYes={() => void answerOffer(true)} onNo={() => void answerOffer(false)} onLater={() => setOffer(null)} />}
        <TaskList
          list={taskList}
          currentId={mode === 'agent' ? run.id : null}
          onOpen={(id) => {
            if (!bringToFront(id)) return;
            stopSpeaking();
            setMode('agent');
            setAnswer(null);
            setBrief(null);
          }}
        />
        <SuggestionList list={liveState.suggestions.filter((x) => x.id !== offer?.o.suggestionId)} onPick={pickSuggestion} />
        <div className="fx-chips" role="group" aria-label={t('Vorschläge')}>
          {CHIPS.filter((x) => !shown || !history.some((h) => h.q === t(x))).map((x) => (
            <button key={x} type="button" className={`fx-chip${x === 'Was brennt?' ? ' cmp-hot-chip' : ''}`} onClick={() => void (x === 'Was brennt?' ? showBriefing({ q: t(x) }) : ask(t(x), false, true))} disabled={busy}>
              {t(x)}
            </button>
          ))}
        </div>
        {history.length > 0 && (
          <div className="fx-history" role="group" aria-label={t('Zuletzt gefragt')}>
            <span className="fx-history-label">
              <Icon name="history" size={13} /> {t('Zuletzt')}
            </span>
            {history.map((h) => (
              <button key={h.q} type="button" className={`fx-hist${shown && h.q === question ? ' on' : ''}`} onClick={() => jump(h)} disabled={busy} title={h.answer ? t('Antwort wieder anzeigen') : t('Noch einmal fragen')}>
                {h.q}
              </button>
            ))}
          </div>
        )}
      </section>

      {shown && (
        <section className="fx-answer" aria-live="polite" aria-busy={busy}>
          {note && (
            <p className="cmp-hint" role="status">
              {note}
            </p>
          )}
          {error && (
            <div className="fx-errorbox" role="alert">
              <p>{error}</p>
              <button type="button" className="btn secondary small" onClick={() => void (mode === 'briefing' ? showBriefing({ q: question }) : ask(question))} disabled={busy || !question}>
                {t('Noch einmal')}
              </button>
            </div>
          )}
          {busy && (
            <>
              <div className="fx-say">
                <span className="fx-say-icon">
                  <span className="bd-spin" aria-hidden="true" />
                </span>
                <div>
                  <p className="fx-q">{t('„{question}“', { question })}</p>
                  <p className="fx-say-text muted">{mode === 'briefing' ? t('{name} schaut nach, was brennt …', { name: c.name }) : t('Ich stelle die Ansicht zusammen …')}</p>
                </div>
              </div>
              <TileSkeleton />
            </>
          )}
          {mode === 'agent' && !busy && <AgentInline run={run} name={c.name} emoji={emoji} busyLabel={t('{name} arbeitet …', { name: c.name })} />}
          {mode === 'briefing' && brief && !busy && <Briefing b={brief} name={c.name} emoji={emoji} onStep={onStep} speaking={speaking} canSpeak={canSpeak} onSpeak={() => (speaking ? stopSpeaking() : void speakOut(brief.say, false, true))} />}
          {mode === 'tiles' && answer && !busy && (
            <>
              <div className="fx-say">
                <span className="fx-say-icon">
                  <Icon name="sparkles" size={18} />
                </span>
                <div className="fx-say-body">
                  <p className="fx-q">{t('„{question}“', { question })}</p>
                  <p className="fx-say-text">{answer.say}</p>
                </div>
                {canSpeak && (
                  <button type="button" className="bd-iconbtn lg" onClick={() => (speaking ? stopSpeaking() : void speakOut(answer.say, false, true))} aria-label={speaking ? t('Vorlesen anhalten') : t('Vorlesen')} title={speaking ? t('Vorlesen anhalten') : t('Vorlesen')}>
                    {speaking ? <VolumeX size={17} /> : <Volume2 size={17} />}
                  </button>
                )}
              </div>
              {answer.action && (
                <div className="fx-action">
                  <Icon name="bot" size={18} />
                  <p>
                    {t('Das ist eine Aufgabe – Fokus zeigt nur an und ändert nichts. Der HyperLevel Agent kann sie für dich erledigen.')}{' '}
                    {agentReady === false && <strong>{t('Dafür braucht der Agent ein KI-Modell (Einstellungen → KI-Anbieter).')}</strong>}
                  </p>
                  <button type="button" className="btn small" onClick={continueInAgent} data-tour="focus-agent">
                    {t('Im Agent fortsetzen')}
                  </button>
                </div>
              )}
              {answer.tiles.length > 0 && <FocusTiles tiles={answer.tiles} />}
              <footer className="fx-foot">
                <span className="fx-foot-note">
                  <Icon name="shieldOk" size={14} /> {noteText} · {t('Alle Zahlen live aus deinen Daten, mit deinen Rechten')}
                </span>
                {saved ? (
                  <span className="fx-saved" role="status">
                    <Icon name="check" size={14} /> {t('Als Board gespeichert: „{name}“', { name: saved.name })}{' '}
                    <Go url={`boards/${saved.id}`} className="fx-saved-link">
                      {t('Board öffnen')}
                    </Go>
                  </span>
                ) : (
                  status?.can_save &&
                  can(session, 'dashboard') &&
                  answer.tiles.length > 0 && (
                    <button type="button" className="btn secondary small" onClick={() => void save()} disabled={saving} data-tour="focus-save">
                      <Icon name="boards" size={14} /> {saving ? t('Wird gespeichert …') : t('Als Board speichern')}
                    </button>
                  )
                )}
              </footer>
            </>
          )}
        </section>
      )}
      {settings && <CompanionSettings onClose={() => setSettings(false)} />}
    </div>
  );
}
