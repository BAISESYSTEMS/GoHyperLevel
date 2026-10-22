import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { api } from '../api';
import { canRecord, micError, playDataUrl, startRecording, transcribe, type RecordingHandle } from '../agent/voice';
import { Badge, Check, Empty, Field, Input, Select, Spinner, Textarea, act, navigate, toast, useLoad } from '../ui';
import { MoreFields } from '../areas/fields';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Einstellungen → Stimme: the voice layer on top of KI-Anbieter (BYOK). Which provider speaks and listens, the voice
 * (listed by the provider, free text allowed), "Stimme testen" and a microphone test, the phone agent's engine
 * (Twilio's voices or the own provider, live stream or recorded turns) with the latency of recent calls, the defaults of
 * the HyperLevel Agent's push-to-talk, and voicemail transcription.
 */

const LANGS: [string, string][] = [
  ['de', 'Deutsch'],
  ['en', 'Englisch'],
  ['fr', 'Französisch'],
  ['es', 'Spanisch'],
  ['it', 'Italienisch'],
  ['nl', 'Niederländisch'],
  ['pl', 'Polnisch'],
  ['pt', 'Portugiesisch'],
  ['tr', 'Türkisch'],
];
/** The language list plus a stored value it does not know (e.g. de-DE). */
const langOptions = (v: string): [string, string][] => (LANGS.some(([k]) => k === v) ? LANGS : [[v, v], ...LANGS]);
const TRANSPORTS: [string, string][] = [
  ['auto', 'Automatisch (Live-Stream, wenn der Anbieter es kann)'],
  ['stream', 'Live-Stream (schnell, Anrufer können unterbrechen)'],
  ['turns', 'Aufnahme-Runden (langsamer, geht mit jedem Anbieter)'],
];
const TRANSPORT_NAME: Record<string, string> = { twilio: 'Twilio-Stimme', stream: 'Live-Stream', turns: 'Aufnahme-Runden' };

type Conn = { id: string; provider: string; label: string; model: string; live: boolean; stream: string | null };

function ConnSelect({ value, onChange, list, routed }: { value: string; onChange: (v: string) => void; list: Conn[]; routed?: { label: string } | null }) {
  return <Select value={value} onChange={onChange} options={[['', `Automatisch${routed ? ` (${routed.label})` : ' – keine Verbindung'}`], ...list.map((c) => [c.id, `${c.label}${c.live ? ' · Live' : ''}`] as [string, string])]} />;
}

/** Voice: free text with the provider's own list as suggestions. */
function VoiceField({ value, onChange, connectionId, language, tour, hint }: { value: string; onChange: (v: string) => void; connectionId: string; language: string; tour?: string; hint?: string }) {
  const [voices, setVoices] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const q = new URLSearchParams({ language });
      if (connectionId) q.set('connection_id', connectionId);
      const r = await api.get<any>(`/api/voice/voices?${q}`);
      setVoices(r.voices);
      if (!r.voices.length) toast('Dieser Anbieter hat keine Stimmenliste – die Stimme als Text eintragen.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const id = useRef(`voices-${Math.random().toString(36).slice(2)}`).current;
  return (
    <Field label="Stimme" tour={tour} hint={error || hint || 'Die Stimmen-ID des Anbieters. Leer = Standardstimme des Anbieters.'}>
      <div className="row voice-pick">
        <input list={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Standardstimme" aria-label="Stimme" />
        <datalist id={id}>
          {(voices ?? []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.lang ? ` · ${v.lang}` : ''}
              {v.gender ? ` · ${v.gender}` : ''}
            </option>
          ))}
        </datalist>
        <button type="button" className="btn small secondary" onClick={load} disabled={busy}>
          {busy ? 'Lade …' : voices ? `${voices.length} Stimmen` : 'Stimmen laden'}
        </button>
      </div>
    </Field>
  );
}

function TtsTest({ s, d }: { s: any; d: any }) {
  const [text, setText] = useState('Guten Tag, hier spricht Ihr digitaler Assistent. Wie kann ich Ihnen helfen?');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<any>(null);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<any>('/api/voice/test', { text, voice: s.tts.voice, model: s.tts.model, connection_id: s.tts.connection_id, language: s.tts.language, speed: s.tts.speed, instructions: s.tts.instructions });
      setLast(r);
      await playDataUrl(r.audio);
    } catch (e) {
      setLast({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="voice-test" data-tour="voice-test">
      <Field label="Stimme testen" hint="Spricht diesen Text mit den Einstellungen oben (ungespeicherte Änderungen zählen schon).">
        <Textarea value={text} onChange={setText} rows={2} maxLength={300} />
      </Field>
      <div className="row">
        <button type="button" className="btn small" onClick={run} disabled={busy || !text.trim() || (!d.routed.tts && !s.tts.connection_id)}>
          <Icon name="audio" size={14} /> {busy ? 'Spricht …' : 'Abspielen'}
        </button>
        {last && !last.error && (
          <span className="muted small">
            {last.provider} · {last.model || 'Standardmodell'} · {last.chars} Zeichen · {last.ms} ms
          </span>
        )}
        {last?.error && <span className="voice-warn small">{last.error}</span>}
      </div>
    </div>
  );
}

function MicTest({ s }: { s: any }) {
  const [state, setState] = useState<'idle' | 'recording' | 'working'>('idle');
  const [result, setResult] = useState<{ text?: string; error?: string; ms?: number; provider?: string }>({});
  const rec = useRef<RecordingHandle | null>(null);
  const lang = useRef(s.stt.language);
  lang.current = s.stt.language;
  useEffect(() => () => rec.current?.cancel(), []);
  /** Ends the running recording (also called by the time limit, so it must not depend on render state). */
  const finish = async () => {
    const h = rec.current;
    if (!h) return;
    rec.current = null;
    setState('working');
    try {
      const blob = await h.stop();
      if (!blob) return setResult({ error: 'Es wurde nichts aufgenommen.' });
      const r = await transcribe(blob, { language: lang.current });
      setResult({ text: r.text || '(nichts erkannt)', ms: r.ms, provider: r.provider });
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally {
      setState('idle');
    }
  };
  const toggle = async () => {
    if (rec.current) return finish();
    setResult({});
    try {
      rec.current = await startRecording({ maxMs: 20_000, onLimit: () => void finish() });
      setState('recording');
    } catch (e) {
      setResult({ error: micError(e) });
    }
  };
  if (!canRecord()) return <p className="muted small">Dieser Browser kann keine Aufnahmen machen (Mikrofon-Test nicht möglich).</p>;
  return (
    <div className="voice-test" data-tour="voice-mic-test">
      <div className="row">
        <button type="button" className={`btn small${state === 'recording' ? ' danger' : ' secondary'}`} onClick={toggle} disabled={state === 'working'}>
          <Icon name={state === 'recording' ? 'micOff' : 'mic'} size={14} /> {state === 'recording' ? 'Aufnahme beenden' : state === 'working' ? 'Erkenne …' : 'Mikrofon testen'}
        </button>
        {state === 'recording' && <span className="voice-rec small">● Aufnahme läuft – sprich einen Satz</span>}
        {result.text && (
          <span className="small">
            „{result.text}“ <span className="muted">· {result.provider} · {result.ms} ms</span>
          </span>
        )}
        {result.error && <span className="voice-warn small">{result.error}</span>}
      </div>
    </div>
  );
}

function Latency({ l }: { l: any }) {
  const data = useLoad(() => api.get<any>('/api/voice/latency?limit=12'), []);
  if (!l?.turns) return <p className="muted small">Noch keine Telefonate mit eigener Stimme – hier erscheinen die Antwortzeiten.</p>;
  const ms = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${(v / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s`);
  return (
    <div data-tour="voice-latency">
      <SortableGrid id="voice.latency" className="voice-stats">
        <div>
          <strong>{ms(l.total_p50)}</strong>
          <span className="muted small">typisch (Median)</span>
        </div>
        <div>
          <strong>{ms(l.total_p95)}</strong>
          <span className="muted small">langsamste 5 %</span>
        </div>
        <div>
          <strong>{ms(l.stt_avg)}</strong>
          <span className="muted small">Spracherkennung</span>
        </div>
        <div>
          <strong>{ms(l.llm_avg)}</strong>
          <span className="muted small">KI-Antwort</span>
        </div>
        <div>
          <strong>{ms(l.tts_avg)}</strong>
          <span className="muted small">Sprachausgabe</span>
        </div>
        <div>
          <strong>{l.interrupted}</strong>
          <span className="muted small">von {l.turns} Runden unterbrochen</span>
        </div>
      </SortableGrid>
      {data.data?.turns?.length > 0 && (
        <table className="voice-turns small">
          <thead>
            <tr>
              <th>Wann</th>
              <th>Weg</th>
              <th>Erkennen</th>
              <th>KI</th>
              <th>Stimme</th>
              <th>Gesamt</th>
            </tr>
          </thead>
          <tbody>
            {data.data.turns.map((t: any, i: number) => (
              <tr key={i}>
                <td>{new Date(t.at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                <td>{t.transport === 'stream' ? 'Live' : 'Runden'}{t.interrupted ? ' · unterbrochen' : ''}</td>
                <td>{ms(t.stt_ms)}</td>
                <td>{ms(t.llm_ms)}</td>
                <td>{ms(t.tts_ms)}</td>
                <td>{ms(t.total_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function VoiceSettingsPage() {
  const info = useLoad(() => api.get<any>('/api/voice/settings'), []);
  const [s, setS] = useState<any>();
  useEffect(() => setS(info.data?.settings), [info.data]);
  if (!s || !info.data) return info.error ? <Empty>{info.error}</Empty> : <Spinner />;
  const d = info.data;
  const tts: Conn[] = d.connections.tts;
  const stt: Conn[] = d.connections.stt;
  const set = (key: string, patch: any) => setS({ ...s, [key]: { ...s[key], ...patch } });
  const plan = d.phone.plan;
  const own = s.phone.engine === 'own';
  const save = async () => {
    const r = await act(() => api.put('/api/voice/settings', s), 'Gespeichert');
    if (r) info.setData(r);
  };
  const noProviders = !tts.length && !stt.length;
  const phoneVoiceConn = s.phone.tts_connection_id || s.tts.connection_id;
  return (
    <div className="voice-page" data-tour="voice-page">
      <p className="muted">
        Sprich und höre mit deinem eigenen Anbieter (BYOK): Sprachausgabe für den KI-Agenten und das Telefon, Spracherkennung für die Mikrofon-Taste und Voicemails. Schlüssel liegen unter{' '}
        <a href="/app/settings/ai-providers" onClick={(e) => (e.preventDefault(), navigate('settings/ai-providers'))}>
          KI-Anbieter
        </a>
        ; die Kosten laufen über dein Konto beim Anbieter.
      </p>
      {noProviders && (
        <p className="voice-warn small">
          Noch kein Anbieter für Sprache verbunden. Unter <a href="/app/settings/ai-providers" onClick={(e) => (e.preventDefault(), navigate('settings/ai-providers'))}>KI-Anbieter</a> z. B. OpenAI, ElevenLabs, Deepgram, Cartesia, Azure, Google oder einen lokalen Sprachserver (Kokoro, Whisper) hinzufügen – ohne Anbieter bleibt alles wie bisher.
        </p>
      )}

      <div className="card" data-tour="voice-tts">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>
            <Icon name="audio" size={18} /> Sprachausgabe
          </h2>
          {d.routed.tts ? <Badge tone="green">{d.routed.tts.label}</Badge> : <Badge>nicht verbunden</Badge>}
        </div>
        <div className="grid2">
          <Field label="Anbieter" hint="Automatisch nimmt die Zuordnung „Sprachausgabe“ unter KI-Anbieter.">
            <ConnSelect value={s.tts.connection_id} onChange={(v) => set('tts', { connection_id: v })} list={tts} routed={d.routed.tts} />
          </Field>
          <Field label="Sprache">
            <Select value={s.tts.language} onChange={(v) => set('tts', { language: v })} options={langOptions(s.tts.language)} />
          </Field>
        </div>
        <VoiceField value={s.tts.voice} onChange={(v) => set('tts', { voice: v })} connectionId={s.tts.connection_id} language={s.tts.language} tour="voice-voice" />
        <MoreFields id="voice-tts" values={[s.tts.model, s.tts.instructions, Number(s.tts.speed) !== 1]}>
          <div className="grid2">
            <Field label="Modell (optional)" hint="Leer = Standard der Verbindung.">
              <Input value={s.tts.model} onChange={(v) => set('tts', { model: v })} placeholder="z. B. gpt-4o-mini-tts" />
            </Field>
            <Field label={`Tempo: ${Number(s.tts.speed).toLocaleString('de-DE')}×`} hint="Nicht jeder Anbieter kann das Tempo ändern.">
              <input type="range" min={0.5} max={2} step={0.05} value={s.tts.speed} onChange={(e) => set('tts', { speed: Number(e.target.value) })} aria-label="Sprechtempo" />
            </Field>
          </div>
          <Field label="Stil-Anweisung (optional)" hint="Nur OpenAI gpt-4o-mini-tts: „Freundlich, ruhig, wie am Telefon in einer Praxis.“">
            <Input value={s.tts.instructions} onChange={(v) => set('tts', { instructions: v })} maxLength={500} />
          </Field>
        </MoreFields>
        <TtsTest s={s} d={d} />
      </div>

      <div className="card" data-tour="voice-stt">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>
            <Icon name="mic" size={18} /> Spracherkennung
          </h2>
          {d.routed.stt ? <Badge tone="green">{d.routed.stt.label}</Badge> : <Badge>nicht verbunden</Badge>}
        </div>
        <div className="grid2">
          <Field label="Anbieter" hint="Automatisch nimmt die Zuordnung „Transkription“ unter KI-Anbieter.">
            <ConnSelect value={s.stt.connection_id} onChange={(v) => set('stt', { connection_id: v })} list={stt} routed={d.routed.stt} />
          </Field>
          <Field label="Sprache">
            <Select value={s.stt.language} onChange={(v) => set('stt', { language: v })} options={langOptions(s.stt.language)} />
          </Field>
        </div>
        <MoreFields id="voice-stt" values={[s.stt.model]}>
          <Field label="Modell (optional)">
            <Input value={s.stt.model} onChange={(v) => set('stt', { model: v })} placeholder="z. B. gpt-4o-transcribe, nova-3" />
          </Field>
        </MoreFields>
        <MicTest s={s} />
      </div>

      <div className="card" data-tour="voice-phone">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>
            <Icon name="phone" size={18} /> Telefon (KI-Telefonagent)
          </h2>
          <Badge tone={plan.engine === 'own' && plan.transport !== 'twilio' ? 'green' : 'gray'}>{TRANSPORT_NAME[plan.transport]}</Badge>
        </div>
        <Field label="Stimme und Zuhören am Telefon" tour="voice-phone-engine">
          <Select value={s.phone.engine} onChange={(v) => set('phone', { engine: v })} options={[['twilio', 'Twilio (Standard) – deutsche Stimmen von Amazon Polly und Google'], ['own', 'Eigener Anbieter – deine Stimme und Spracherkennung']]} />
        </Field>
        {own && (
          <>
            <Field label="Übertragung" hint="Live-Stream: Twilio öffnet eine WebSocket-Verbindung zu deinem Server (öffentliche https-Adresse nötig). Aufnahme-Runden: nach jedem Satz wird aufgenommen, erkannt und die Antwort abgespielt – ohne Unterbrechen.">
              <Select value={s.phone.transport} onChange={(v) => set('phone', { transport: v })} options={TRANSPORTS} />
            </Field>
            <details className="voice-more">
              <summary>Am Telefon andere Anbieter oder Stimme als oben</summary>
              <div className="grid2">
                <Field label="Anbieter der Telefon-Stimme">
                  <ConnSelect value={s.phone.tts_connection_id} onChange={(v) => set('phone', { tts_connection_id: v })} list={tts} routed={s.tts.connection_id ? tts.find((c) => c.id === s.tts.connection_id) : d.routed.tts} />
                </Field>
                <Field label="Anbieter der Spracherkennung">
                  <ConnSelect value={s.phone.stt_connection_id} onChange={(v) => set('phone', { stt_connection_id: v })} list={stt} routed={s.stt.connection_id ? stt.find((c) => c.id === s.stt.connection_id) : d.routed.stt} />
                </Field>
                <Field label="Telefon-Stimme (optional)">
                  <Input value={s.phone.tts_voice} onChange={(v) => set('phone', { tts_voice: v })} placeholder="wie oben" />
                </Field>
                <Field label="Modelle (optional)">
                  <div className="row">
                    <Input value={s.phone.tts_model} onChange={(v) => set('phone', { tts_model: v })} placeholder="Stimme" />
                    <Input value={s.phone.stt_model} onChange={(v) => set('phone', { stt_model: v })} placeholder="Erkennung" />
                  </div>
                </Field>
              </div>
              {tts.find((c) => c.id === phoneVoiceConn)?.provider === 'elevenlabs' && <Check checked={s.phone.tts_ws} onChange={(v) => set('phone', { tts_ws: v })} label="ElevenLabs über WebSocket sprechen (noch schnellerer Start)" />}
            </details>
            <Field label={`Pause, bis der Agent antwortet: ${s.phone.endpoint_ms} ms`} hint="So lange muss der Anrufer still sein, damit der Agent annimmt, dass er fertig ist.">
              <input type="range" min={300} max={2500} step={100} value={s.phone.endpoint_ms} onChange={(e) => set('phone', { endpoint_ms: Number(e.target.value) })} aria-label="Pause bis zur Antwort" />
            </Field>
            <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
              <Check checked={s.phone.barge_in} onChange={(v) => set('phone', { barge_in: v })} label="Anrufer dürfen den Agenten unterbrechen" />
              <Check checked={s.phone.filler} onChange={(v) => set('phone', { filler: v })} label="„Einen Moment bitte“, wenn die Antwort länger dauert" />
            </div>
          </>
        )}
        <div className="voice-plan" data-tour="voice-phone-plan">
          <strong className="small">Nächster Anruf <span className="muted">(mit den gespeicherten Einstellungen)</span></strong>
          <div className="small">
            {plan.engine === 'twilio' ? (
              'Twilio-Stimme (Standard).'
            ) : (
              <>
                {TRANSPORT_NAME[plan.transport]}
                {plan.tts && <> · Stimme: {plan.tts.label}</>}
                {plan.stt && <> · Erkennung: {plan.stt.label}{plan.stt.live ? ' (live)' : ' (pro Satz)'}</>}
              </>
            )}
          </div>
          {plan.problems.map((p: string) => (
            <div key={p} className="voice-warn small">
              {p}
            </div>
          ))}
          {own && !d.phone.twilio_ready && <div className="voice-warn small">Twilio-Zugang und Nummer fehlen noch (Einstellungen → Telefonie).</div>}
          {own && !d.phone.agent_ready && <div className="voice-warn small">Der KI-Telefonagent braucht den eingeschalteten KI-Assistenten (Einstellungen → Telefonie).</div>}
          <div className="muted small">Fällt der eigene Anbieter mitten im Gespräch aus, spricht Twilio weiter – der Anruf bleibt nie stumm.</div>
        </div>
        <h3 style={{ marginTop: 16 }}>Antwortzeiten der letzten Anrufe</h3>
        <Latency l={d.latency} />
      </div>

      <div className="card" data-tour="voice-agent">
        <h2>
          <Icon name="bot" size={18} /> HyperLevel Agent
        </h2>
        <p className="muted small">Mikrofon-Taste im Agent-Fenster: aufnehmen, erkennen, Text prüfen und senden. Jede und jeder kann das für sich anders einstellen. Änderungen am CRM bestätigst du immer selbst – gesprochene Befehle bestätigen nichts.</p>
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <Check checked={s.agent.read_aloud} onChange={(v) => set('agent', { read_aloud: v })} label="Antworten des Agenten vorlesen (Standard für alle)" />
          <Check checked={s.agent.auto_send} onChange={(v) => set('agent', { auto_send: v })} label="Erkannten Text sofort senden, ohne ihn vorher zu prüfen" />
        </div>
      </div>

      <div className="card" data-tour="voice-voicemail">
        <h2>
          <Icon name="phone" size={18} /> Voicemails
        </h2>
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <Check checked={s.voicemail_transcribe} onChange={(v) => setS({ ...s, voicemail_transcribe: v })} label="Voicemails mit der eigenen Spracherkennung transkribieren" />
          <Check checked={s.call_summary} onChange={(v) => setS({ ...s, call_summary: v })} label="Kurze Zusammenfassung mit nächstem Schritt dazuschreiben (nutzt den KI-Assistenten)" />
        </div>
        <p className="muted small">Der Text erscheint am Anruf und im Posteingang. Die Transkription von Twilio (Einstellungen → Telefonie) dann bitte ausschalten.</p>
      </div>

      <div className="card">
        <h2>Nutzung der letzten {d.usage.days} Tage</h2>
        <p className="small">
          {d.usage.tts_chars.toLocaleString('de-DE')} Zeichen gesprochen ({d.usage.tts_calls} Aufrufe) · {d.usage.stt_calls} Aufnahmen erkannt · {d.usage.phone_calls} Telefonate mit eigener Stimme ({Math.round(d.usage.phone_seconds / 60)} Min.)
        </p>
        <p className="muted small">Abgerechnet wird beim Anbieter; hier siehst du nur, wie viel HyperLevel angefragt hat.</p>
      </div>

      <div className="row voice-save">
        <button className="btn" onClick={save}>
          Speichern
        </button>
      </div>
    </div>
  );
}
