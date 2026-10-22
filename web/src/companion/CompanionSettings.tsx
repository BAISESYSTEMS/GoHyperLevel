import { useEffect, useState } from 'react';
import { History, Plus, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useLocale, useT } from '../i18n';
import { Check, Field, Modal, Select, Tabs, act, navigate } from '../ui';
import { browserVoices, readAloud, stopReading } from '../focus/speech';
import { canWake, openCheckin, saveCompanion, setWake, useBus, useCompanion, wakeOn, type CheckinPrefs } from './store';
import { GrowthBriefingFields, RoleField } from './Growth';
import { ACCOUNT_TTS, BROWSER_TTS, DEFAULT_TTS_PROVIDER, DEFAULT_TTS_VOICE, JARVIS_PROVIDER_VOICES, JARVIS_VOICE_LABELS, companionConnection, loadVoiceInfo, speechPlan, type VoiceInfo } from './voice';

/**
 * The companion's settings (from the chip next to focus mode's prompt): who answers and its name, the wake word (per device, with the
 * honest note where the audio goes), the shortcut, reading aloud and the voice, and the proactive check-ins with their history.
 * Every change is saved at once. ✕, Esc or a click outside closes it (the shared Modal); the focus goes back to the chip.
 * 1.0.54: the conversation mode (follow-up window, barge-in), the voice engine (classic or realtime via Gemini Live) and the tab
 * "Proaktiv" – Eigeninitiative (level, AI or rules) and the event triggers (on/off and priority each).
 */

interface Proactive {
  triggers: { id: string; label: string; hint: string; default_priority: 'interrupt' | 'digest'; on: boolean; priority: 'interrupt' | 'digest'; allowed: boolean }[];
  ai: { ready: boolean; reason: string };
  level: 'low' | 'balanced' | 'high';
  live: { available: boolean; connections: { id: string; label: string }[] };
}
const WINDOWS = [0, 5, 8, 15];

const browserTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
};

export function CompanionSettings({ onClose, initialTab = 'companion' }: { onClose: () => void; initialTab?: 'companion' | 'voice' | 'checkins' | 'proactive' }) {
  const t = useT('companion');
  const locale = useLocale();
  const lang = locale === 'en' ? 'en' : 'de';
  const c = useCompanion();
  const bus = useBus();
  const p = c.prefs;
  const [tab, setTab] = useState(initialTab);
  const [agents, setAgents] = useState<{ id: string; name: string; emoji: string }[]>([]);
  const [name, setName] = useState(p.name);
  const [phrase, setPhrase] = useState(p.wake_phrase);
  const [wake, setWakeState] = useState(wakeOn());
  const ownVoices = () => browserVoices(lang);
  const [voices, setVoices] = useState(ownVoices);
  const [info, setInfo] = useState<VoiceInfo | null>(null);
  const [serverVoices, setServerVoices] = useState<{ id: string; name: string }[]>([]);
  const shownVoice = (v: string) => (v === DEFAULT_TTS_VOICE || v === 'en-GB-Neural2-B' ? '' : v);
  const [ttsVoice, setTtsVoice] = useState(shownVoice(p.tts_voice));
  const [hearing, setHearing] = useState(false);
  const [history, setHistory] = useState<any[] | null>(null);
  const [custom, setCustom] = useState(() => !c.intervals.includes(p.checkin.minutes));
  const [trying, setTrying] = useState(false);
  const [pro, setPro] = useState<Proactive | null>(null);
  const [ideas, setIdeas] = useState<any[] | null>(null);
  const [thinking, setThinking] = useState(false);

  useEffect(() => {
    api
      .get('/api/agent/bootstrap')
      .then((b) => setAgents((b?.agents ?? []).map((a: any) => ({ id: a.id, name: a.name, emoji: a.emoji }))))
      .catch(() => setAgents([]));
  }, []);
  useEffect(() => {
    setName(p.name);
    setPhrase(p.wake_phrase);
  }, [p.name, p.wake_phrase]);
  useEffect(() => {
    // the browser fills its voice list a moment later
    const s = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
    if (!s) return;
    const on = () => setVoices(ownVoices());
    s.addEventListener?.('voiceschanged', on);
    return () => s.removeEventListener?.('voiceschanged', on);
  }, [lang]);
  useEffect(() => setWakeState(wakeOn()), [bus.wake]);
  useEffect(() => {
    if (tab === 'voice') void loadVoiceInfo(true).then(setInfo);
  }, [tab]);
  useEffect(() => setTtsVoice(shownVoice(p.tts_voice)), [p.tts_voice]);
  const conn = info ? companionConnection(p, info.connections) : null;
  useEffect(() => {
    // the provider's voices for the picker (needs the settings right – otherwise the field is free text)
    setServerVoices([]);
    if (!conn) return;
    let alive = true;
    api
      .get<any>(`/api/voice/voices?connection_id=${encodeURIComponent(conn.id)}`)
      .then((r) => alive && setServerVoices((r?.voices ?? []).filter((v: any) => v && typeof v.id === 'string').map((v: any) => ({ id: v.id, name: String(v.name ?? v.id) }))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [conn?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab === 'checkins' && !history) api.get<any[]>('/api/companion/checkins').then(setHistory).catch(() => setHistory([]));
  }, [tab, history]);
  useEffect(() => {
    if (tab === 'proactive' || tab === 'voice') api.get<Proactive>('/api/companion/proactive').then(setPro).catch(() => setPro(null));
  }, [tab, p.events, p.initiative]);
  const suggestNow = async () => {
    setThinking(true);
    const r = await act(() => api.post<{ suggestions: any[] }>('/api/companion/initiative/run', { lang }));
    setThinking(false);
    setIdeas(r?.suggestions ?? []);
  };

  const save = (patch: Parameters<typeof saveCompanion>[0]) => act(() => saveCompanion(patch));
  const saveCheckin = (patch: Partial<CheckinPrefs>) => save({ checkin: patch, ...(p.tz ? {} : { tz: browserTz() }) });
  const toggleWake = (on: boolean) => {
    setWake(on);
    setWakeState(on);
  };
  const tryNow = async () => {
    setTrying(true);
    const r = await act(() => api.post('/api/companion/checkins/run', { lang }));
    setTrying(false);
    if (r?.id) {
      onClose();
      openCheckin(r.id);
    }
  };

  const conns = (info?.connections ?? []).filter((x) => x.usable !== false);
  const hasGoogle = conns.some((x) => x.provider === DEFAULT_TTS_PROVIDER);
  // a provider with its own Jarvis voice (Google, kie.ai) is connected – then the "add Google" hint is noise
  const hasJarvisVoice = conns.some((x) => !!JARVIS_PROVIDER_VOICES[x.provider]);
  const jarvisLabel = JARVIS_VOICE_LABELS[p.tts_provider]?.[lang === 'en' ? 'en' : 'de'] ?? '';
  const who = p.tts_provider === BROWSER_TTS || p.tts_provider === ACCOUNT_TTS ? p.tts_provider : conn ? `c:${conn.id}` : `p:${p.tts_provider}`;
  const whoOptions: [string, string][] = [
    ...conns.map((x): [string, string] => [`c:${x.id}`, `${x.label || x.provider} (${x.provider})`]),
    ...(who.startsWith('p:') ? [[who, p.tts_provider === DEFAULT_TTS_PROVIDER ? t('Google Cloud Speech – noch keine Verbindung') : t('{provider} – noch keine Verbindung', { provider: p.tts_provider })] as [string, string]] : []),
    ...(!hasGoogle && !who.startsWith('p:') ? [['p:google_speech', t('Google Cloud Speech – noch keine Verbindung')] as [string, string]] : []),
    [ACCOUNT_TTS, t('Stimme des Sub-Accounts (Einstellungen → Stimme)')],
    [BROWSER_TTS, t('Browserstimme')],
  ];
  const pickWho = (v: string) => {
    if (v === BROWSER_TTS || v === ACCOUNT_TTS) return void save({ tts_provider: v });
    if (v.startsWith('p:')) return void save({ tts_provider: v.slice(2), tts_connection_id: '', ...(JARVIS_PROVIDER_VOICES[v.slice(2)] ? { tts_voice: DEFAULT_TTS_VOICE } : {}) });
    const x = conns.find((k) => `c:${k.id}` === v);
    if (!x) return;
    // a voice belongs to its provider: another provider starts with its own default (Jarvis's voice for Google and kie.ai)
    const voice = x.provider === p.tts_provider ? p.tts_voice : JARVIS_PROVIDER_VOICES[x.provider] ? DEFAULT_TTS_VOICE : '';
    void save({ tts_provider: x.provider, tts_connection_id: x.id, tts_voice: voice });
  };
  const listen = async () => {
    if (hearing) {
      stopReading();
      return setHearing(false);
    }
    setHearing(true);
    const plan = speechPlan(p, info ?? (await loadVoiceInfo()), lang === 'en' ? 'en' : 'de');
    await readAloud(lang === 'en' ? `Good day. I am ${c.name}. How can I help?` : `Guten Tag, ich bin ${c.name}. Wie kann ich helfen?`, { ...plan, lang }); // i18n-ignore (spoken sample, chosen by language)
    setHearing(false);
  };
  const serverChosen = p.tts_provider !== BROWSER_TTS && p.tts_provider !== ACCOUNT_TTS;

  const ci = p.checkin;
  const tz = browserTz();
  const next = c.next_checkin ? new Date(c.next_checkin).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <Modal title={t('{name} – Companion', { name: c.name })} onClose={onClose} className="cmp-settings">
      <Tabs
        tabs={[
          ['companion', t('Companion')],
          ['voice', t('Sprechen')],
          ['checkins', t('Check-ins')],
          ['proactive', t('Proaktiv')],
        ]}
        value={tab}
        onChange={(v) => setTab(v as typeof tab)}
      />
      {tab === 'companion' && (
        <div className="cmp-set">
          <Field label={t('Wer antwortet')} hint={t('Der Companion ist der HyperLevel Agent oder einer deiner KI-Agenten – mit seinen Werkzeugen, Rechten, Bestätigungen und dem Protokoll. Er entscheidet auch, wer Aufgaben aus dem Fokus-Modus erledigt.')}>
            <Select
              value={p.agent_id ?? ''}
              onChange={(v) => void save({ agent_id: v || null })}
              options={[['', t('Jarvis – HyperLevel Agent (Standard)')], ...agents.map((a): [string, string] => [a.id, `${a.emoji} ${a.name}`])]}
            />
          </Field>
          {c.agent_missing && <p className="cmp-warn">{t('Der gewählte Agent ist nicht mehr verfügbar – bis du einen anderen wählst, antwortet der HyperLevel Agent.')}</p>}
          <Field label={t('Name')} hint={t('So heißt dein Companion – und so weckst du ihn.')}>
            {/* i18n-ignore-next-line */}
            <input value={name} maxLength={40} placeholder={c.agent.id ? c.agent.name : 'Jarvis'} onChange={(e) => setName(e.target.value)} onBlur={() => name !== p.name && void save({ name })} />
          </Field>
          <RoleField p={p} save={save} />
        </div>
      )}
      {tab === 'voice' && (
        <div className="cmp-set">
          <h3 className="cmp-set-h">{t('Weckwort')}</h3>
          {canWake() ? (
            <>
              <Check checked={wake} onChange={toggleWake} label={t('Auf „{phrase}“ hören – auf diesem Gerät', { phrase: c.wake_phrase })} tour="companion-wake" />
              <Field label={t('Weckwort')} hint={t('Leer = „Hey“ und der Name.')}>
                <input value={phrase} maxLength={60} placeholder={c.wake_phrase} onChange={(e) => setPhrase(e.target.value)} onBlur={() => phrase !== p.wake_phrase && void save({ wake_phrase: phrase })} />
              </Field>
              {bus.wakeError && <p className="cmp-warn">{t(bus.wakeError)}</p>}
              <p className="cmp-note">
                {t(
                  'Das Weckwort nutzt die Spracherkennung deines Browsers – nur auf diesem Gerät und nur, solange der Tab sichtbar ist. In Chrome und Edge geht der Ton dafür an den Browser-Hersteller (Google bzw. Microsoft), in Safari an Apple. HyperLevel bekommt nur den Text nach dem Weckwort; aufgenommen oder gespeichert wird nichts. Solange es zuhört, zeigt der Knopf am Rand ein grünes Ohr – ein Klick schaltet es aus.',
                )}
              </p>
            </>
          ) : (
            <p className="cmp-note">{t('Dieser Browser hat keine eigene Spracherkennung (z. B. Firefox) – das Weckwort gibt es hier nicht. Der Knopf am Rand und Alt+J funktionieren trotzdem.')}</p>
          )}
          <h3 className="cmp-set-h">{t('Gesprächsmodus')}</h3>
          <Field label={t('Nach der Antwort weiter zuhören')} hint={t('So lange bleibt das Mikrofon offen, nachdem {name} gesprochen hat – du sprichst einfach weiter. Stille schließt es wieder; „danke {name}“, „stopp“ oder „das war’s“ beendet das Gespräch.', { name: c.name })}>
            <Select value={String(WINDOWS.includes(p.conversation_window) ? p.conversation_window : 8)} onChange={(v) => void save({ conversation_window: Number(v) })} options={WINDOWS.map((w): [string, string] => [String(w), w === 0 ? t('Aus – eine Frage, eine Antwort') : t('{n} Sekunden', { n: w })])} />
          </Field>
          <Check checked={p.barge_in} onChange={(v) => void save({ barge_in: v })} label={t('Unterbrechen erlaubt: wenn ich spreche, hört {name} auf (auch Klick oder Leertaste)', { name: c.name })} />
          <p className="cmp-note">{t('Das Mikrofon ist nur während eines Gesprächs offen – es beginnt mit deiner gesprochenen Frage und endet mit Stille, Esc oder ✕. Solange es offen ist, zeigt der Fokus-Modus „Mikro an“. Die Erkennung von Sprechpausen läuft nur im Browser.')}</p>
          <Field label={t('Sprach-Engine')} hint={t('Klassisch: Spracherkennung → Agent → Sprachausgabe, Satz für Satz. Echtzeit: Gemini Live spricht und hört gleichzeitig (über den Server, dein Schlüssel bleibt dort); Aufgaben laufen weiter über den Agenten mit Bestätigung per Klick.')}>
            <Select
              value={p.voice_engine}
              onChange={(v) => void save({ voice_engine: v as 'classic' | 'gemini_live' })}
              options={[
                ['classic', t('Klassisch (Standard)')],
                ['gemini_live', t('Echtzeit – Gemini Live')],
              ]}
            />
          </Field>
          {p.voice_engine === 'gemini_live' && pro && !pro.live.available && (
            <p className="cmp-warn">
              {t('Für die Echtzeit-Stimme unter KI-Anbieter eine Verbindung „Google Gemini“ mit API-Schlüssel anlegen. Bis dahin spricht {name} klassisch.', { name: c.name })}{' '}
              <a
                href="/app/settings/ai-providers"
                onClick={(e) => {
                  e.preventDefault();
                  onClose();
                  navigate('settings/ai-providers');
                }}
              >
                {t('Einstellungen → KI-Anbieter')}
              </a>
            </p>
          )}
          {p.voice_engine === 'gemini_live' && pro && pro.live.connections.length > 1 && (
            <Field label={t('Gemini-Verbindung')}>
              <Select value={p.live_connection_id} onChange={(v) => void save({ live_connection_id: v })} options={[['', t('Automatisch (die erste)')], ...pro.live.connections.map((x): [string, string] => [x.id, x.label])]} />
            </Field>
          )}
          <h3 className="cmp-set-h">{t('Tastenkürzel')}</h3>
          <Check checked={p.shortcut} onChange={(v) => void save({ shortcut: v })} label={t('Alt+J: gedrückt halten zum Sprechen, kurz drücken für freihändig')} />
          <h3 className="cmp-set-h">{t('Antworten')}</h3>
          <Check checked={p.voice_reply} onChange={(v) => void save({ voice_reply: v })} label={t('Gesprochene Fragen laut beantworten')} />
          <Check checked={!!p.read_aloud} onChange={(v) => void save({ read_aloud: v })} label={t('Auch getippte Fragen vorlesen')} />
          <h3 className="cmp-set-h">{t('Stimme von {name}', { name: c.name })}</h3>
          <Field label={t('Wer spricht')} hint={t('Die Verbindungen dieses Sub-Accounts, die sprechen können (Einstellungen → KI-Anbieter). Standard: Google Cloud Speech mit einer klaren deutschen Männerstimme ohne Akzent.')}>
            <Select value={who} onChange={pickWho} options={whoOptions} />
          </Field>
          {serverChosen && (
            <Field
              label={t('Stimme des Anbieters')}
              hint={
                p.tts_provider === DEFAULT_TTS_PROVIDER
                  ? t('Leer = automatisch: {voice} (Muttersprachler, passend zur App-Sprache).', { voice: jarvisLabel })
                  : jarvisLabel
                    ? t('Leer = automatisch: {voice}, spricht in der App-Sprache.', { voice: jarvisLabel })
                    : undefined
              }
            >
              <input
                value={ttsVoice}
                maxLength={120}
                list="cmp-tts-voices"
                placeholder={jarvisLabel}
                onChange={(e) => setTtsVoice(e.target.value)}
                onBlur={() => {
                  const v = ttsVoice.trim() || (JARVIS_PROVIDER_VOICES[p.tts_provider] ? DEFAULT_TTS_VOICE : '');
                  if (v !== p.tts_voice) void save({ tts_voice: v });
                }}
              />
              <datalist id="cmp-tts-voices">
                {serverVoices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </datalist>
            </Field>
          )}
          {info && !hasJarvisVoice && (
            <p className="cmp-warn" data-tour="companion-google-hint">
              {t('Für die Jarvis-Stimme unter KI-Anbieter eine Verbindung „Google Cloud Speech“ mit API-Schlüssel anlegen (Text-to-Speech-API im Google-Projekt aktivieren)')}{' – '}
              <a
                href="/app/settings/ai-providers"
                onClick={(e) => {
                  e.preventDefault();
                  onClose();
                  navigate('settings/ai-providers');
                }}
              >
                {t('Einstellungen → KI-Anbieter')}
              </a>
              .{p.tts_provider === DEFAULT_TTS_PROVIDER && ` ${t('Bis dahin spricht die Browserstimme.')}`}
            </p>
          )}
          {serverChosen && /^en-/i.test(p.tts_voice) && lang === 'de' && <p className="cmp-note">{t('Eine englische Stimme liest deutsche Antworten mit englischem Akzent.')}</p>}
          <Field label={t('Browserstimme')} hint={t('Spricht, wenn keine Stimme des Servers da ist. Automatisch = für Jarvis eine britische Männerstimme (z. B. „Google UK English Male“), sonst eine in deiner Sprache.')}>
            <Select value={p.browser_voice} onChange={(v) => void save({ browser_voice: v })} options={[['', t('Automatisch')], ...voices.map((v): [string, string] => [v.name, `${v.name} (${v.lang})`])]} />
          </Field>
          <div className="cmp-actions">
            <button type="button" className="btn secondary small" onClick={() => void listen()}>
              {hearing ? t('Anhalten') : t('Probehören')}
            </button>
          </div>
        </div>
      )}
      {tab === 'checkins' && (
        <div className="cmp-set">
          <p className="cmp-note">{t('{name} meldet sich von selbst: was gerade brennt und wo es weitergeht – aus deinen Daten, mit deinen Rechten. Proaktiv heißt nie eigenmächtig: jeder Schritt geht erst an den Agenten, der vor dem Ausführen fragt.', { name: c.name })}</p>
          <Field label={t('Wann')}>
            <Select
              value={ci.mode}
              onChange={(v) => void saveCheckin({ mode: v as CheckinPrefs['mode'] })}
              options={[
                ['off', t('Aus')],
                ['interval', t('Im Abstand')],
                ['daily', t('Zu festen Uhrzeiten')],
              ]}
            />
          </Field>
          {ci.mode === 'interval' && (
            <div className="cmp-row">
              <Field label={t('Alle')}>
                <Select
                  value={custom ? 'custom' : String(ci.minutes)}
                  onChange={(v) => {
                    if (v === 'custom') return setCustom(true);
                    setCustom(false);
                    void saveCheckin({ minutes: Number(v) });
                  }}
                  options={[...c.intervals.map((m): [string, string] => [String(m), m < 60 ? t('{n} Minuten', { n: m }) : m === 60 ? t('1 Stunde') : t('{n} Stunden', { n: m / 60 })]), ['custom', t('Eigene …')]]}
                />
              </Field>
              {custom && (
                <Field label={t('Minuten (5–1440)')}>
                  <input type="number" min={5} max={1440} defaultValue={ci.minutes} onBlur={(e) => void saveCheckin({ minutes: Math.round(Number(e.target.value)) })} />
                </Field>
              )}
            </div>
          )}
          {ci.mode === 'daily' && (
            <div className="cmp-times" data-tour="companion-times">
              {ci.times.map((tm, i) => (
                <span key={`${tm}-${i}`} className="cmp-time">
                  <input type="time" defaultValue={tm} aria-label={t('Uhrzeit {n}', { n: i + 1 })} onBlur={(e) => e.target.value && e.target.value !== tm && void saveCheckin({ times: ci.times.map((x, j) => (j === i ? e.target.value : x)) })} />
                  {ci.times.length > 1 && (
                    <button type="button" className="icon-btn" aria-label={t('Uhrzeit entfernen')} onClick={() => void saveCheckin({ times: ci.times.filter((_, j) => j !== i) })}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </span>
              ))}
              {ci.times.length < 6 && (
                <button type="button" className="btn small secondary" onClick={() => void saveCheckin({ times: [...ci.times, ci.times.includes('12:00') ? '17:00' : '12:00'] })}>
                  <Plus size={14} /> {t('Uhrzeit')}
                </button>
              )}
            </div>
          )}
          {ci.mode !== 'off' && (
            <>
              {ci.mode === 'interval' && (
                <>
                  <div className="cmp-row">
                    <Field label={t('Ruhezeit von')}>
                      <input type="time" defaultValue={ci.quiet_from} onBlur={(e) => e.target.value && void saveCheckin({ quiet_from: e.target.value })} />
                    </Field>
                    <Field label={t('bis')}>
                      <input type="time" defaultValue={ci.quiet_to} onBlur={(e) => e.target.value && void saveCheckin({ quiet_to: e.target.value })} />
                    </Field>
                  </div>
                  <p className="cmp-note">{t('In der Ruhezeit kommen keine Check-ins im Abstand – feste Uhrzeiten gelten immer.')}</p>
                </>
              )}
              <Check checked={ci.weekdays_only} onChange={(v) => void saveCheckin({ weekdays_only: v })} label={t('Nur werktags (Mo–Fr)')} />
              <Check checked={ci.only_changed} onChange={(v) => void saveCheckin({ only_changed: v })} label={t('Nur wenn sich etwas geändert hat')} />
              <Check checked={ci.speak} onChange={(v) => void saveCheckin({ speak: v })} label={t('Check-ins vorlesen, wenn die App offen ist')} />
              <p className="cmp-note">
                {t('Zeitzone: {tz}', { tz: c.tz })}
                {tz && tz !== c.tz && (
                  <>
                    {' · '}
                    <button type="button" className="linkish" onClick={() => void save({ tz })}>
                      {t('{tz} übernehmen', { tz })}
                    </button>
                  </>
                )}
                {next && ` · ${t('Nächster Check-in frühestens: {when}', { when: next })}`}
              </p>
              <p className="cmp-note">{t('Aufs Handy: Push unter Einstellungen → Mein Konto einschalten (Art „Check-ins des Companions“).')}</p>
            </>
          )}
          <div className="cmp-actions">
            <button type="button" className="btn secondary small" onClick={() => void tryNow()} disabled={trying} data-tour="companion-try">
              {trying ? t('Wird erstellt …') : t('Check-in jetzt ausprobieren')}
            </button>
          </div>
          <h3 className="cmp-set-h">
            <History size={15} /> {t('Verlauf (30 Tage)')}
          </h3>
          {history === null ? (
            <p className="cmp-note">{t('Lädt …')}</p>
          ) : !history.length ? (
            <p className="cmp-note">{t('Noch keine Check-ins.')}</p>
          ) : (
            <ul className="cmp-history">
              {history.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      openCheckin(h.id);
                    }}
                  >
                    <span className="cmp-history-when">{new Date(h.created_at).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    <span className="cmp-history-what">{h.hotspots?.[0]?.title ?? h.say}</span>
                    {!h.seen && <span className="cmp-history-new">{t('neu')}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {tab === 'proactive' && (
        <div className="cmp-set" data-tour="companion-proactive">
          <p className="cmp-note">{t('{name} meldet sich, wenn etwas passiert, und bringt eigene Ideen mit – vorbereitet, aber nie eigenmächtig: Senden, Ändern und Löschen bestätigst du immer selbst per Klick.', { name: c.name })}</p>
          <GrowthBriefingFields p={p} save={save} name={c.name} onClose={onClose} />
          <h3 className="cmp-set-h">
            <Sparkles size={15} /> {t('Eigeninitiative')}
          </h3>
          <Field label={t('Wie proaktiv')} hint={t('Zurückhaltend: höchstens ein Vorschlag je Check-in, nur Operatives. Ausgewogen: bis zu zwei, einmal am Tag auch eine strategische Idee. Sehr proaktiv: öfter, mit Ideen zur Richtung deines Geschäfts.')}>
            <Select
              value={p.initiative}
              onChange={(v) => void save({ initiative: v as 'low' | 'balanced' | 'high' })}
              options={[
                ['low', t('Zurückhaltend')],
                ['balanced', t('Ausgewogen (Standard)')],
                ['high', t('Sehr proaktiv')],
              ]}
            />
          </Field>
          {pro &&
            (pro.ai.ready ? (
              <p className="cmp-note">{t('Die KI schaut sich Pipeline, Posteingang, Aufgaben, Rechnungen, Termine und deine gemerkten Hinweise an und bereitet Entwürfe vor. Abgelehnte Arten schlägt sie seltener vor, nichts doppelt.')}</p>
            ) : (
              <p className="cmp-warn">
                {t('Ohne KI-Anbieter schlägt {name} nach festen Regeln vor (aus „Was brennt?“).', { name: c.name })} {pro.ai.reason ? t(pro.ai.reason) : ''}
              </p>
            ))}
          <div className="cmp-actions">
            <button type="button" className="btn secondary small" onClick={() => void suggestNow()} disabled={thinking} data-tour="companion-suggest">
              {thinking ? t('{name} denkt nach …', { name: c.name }) : t('Was schlägst du jetzt vor?')}
            </button>
          </div>
          {ideas && (ideas.length ? (
            <ul className="cmp-history">
              {ideas.map((s) => (
                <li key={s.id}>
                  <span className="cmp-history-what">
                    <strong>{s.title}</strong> – {s.say}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="cmp-note">{t('Gerade nichts Neues – ich melde mich, sobald es etwas gibt.')}</p>
          ))}
          <h3 className="cmp-set-h">{t('Ereignis-Auslöser')}</h3>
          <Check checked={p.events.on} onChange={(v) => void save({ events: { on: v } })} label={t('Bei Ereignissen von selbst melden')} />
          {p.events.on && (
            <>
              <p className="cmp-note">{t('Sofort: {name} spricht, wenn die App offen ist (höchstens alle drei Minuten), sonst kommt ein Push. Gesammelt: im nächsten Check-in. In der Ruhezeit wird alles gesammelt.', { name: c.name })}</p>
              <table className="cmp-triggers">
                <tbody>
                  {(pro?.triggers ?? []).map((tr) => (
                    <tr key={tr.id} className={tr.allowed ? '' : 'off'}>
                      <td>
                        <Check checked={tr.on && tr.allowed} onChange={(v) => void save({ events: { triggers: { [tr.id]: { on: v } } } })} label={t(tr.label)} />
                        <span className="cmp-trigger-hint">{tr.allowed ? t(tr.hint) : t('Dafür fehlt dir der Zugriff auf diesen Bereich.')}</span>
                      </td>
                      <td>
                        <Select
                          value={tr.priority}
                          onChange={(v) => void save({ events: { triggers: { [tr.id]: { priority: v as 'interrupt' | 'digest' } } } })}
                          options={[
                            ['interrupt', t('Sofort')],
                            ['digest', t('Gesammelt')],
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Field label={t('„Nachricht unbeantwortet“ nach (Minuten)')}>
                <input type="number" min={5} max={1440} defaultValue={p.events.unanswered_minutes} onBlur={(e) => Number(e.target.value) !== p.events.unanswered_minutes && void save({ events: { unanswered_minutes: Math.round(Number(e.target.value)) } })} />
              </Field>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
