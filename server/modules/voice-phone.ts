import type { App, LocationRow, Module } from '../core/app.js';
import { notFound, text, type Ctx } from '../core/http.js';
import { now } from '../core/util.js';
import { SUMMARY_SCHEMA, parseSummary } from '../services/ai-context.js';
import { logActivity } from '../services/contacts.js';
import { ACCOUNT_SID, RECORDING_SID, twiml, xml } from '../services/twilio.js';
import { fillerTwiml } from '../services/voice-ai.js';
import { bumpUsage, liveTts, loadVoiceSettings, openLiveStt, phonePlan, synthesize, transcribe, voiceConnection } from '../services/voice-engine.js';
import { FILLER, PhoneSession, type PhoneCall, type StartInfo } from '../services/voice-phone.js';
import { AudioStore, PhraseCache, playNoun, prependTo, recordTurnNoun, streamToken, streamTwiml, turnTwiml, verifyStreamToken, wsUrl } from '../services/voice-twiml.js';
import type { PhoneReply, VoiceBrain } from '../services/voice-types.js';
import { acceptWebSocket, refuse } from '../services/voice-ws.js';
import { syncMessage, telephonyConfig, twilioRequest, verifyTwilio, type Config } from './telephony.js';
import { voiceTiming } from './voice-ai.js';

/**
 * Telefon mit eigener Stimme: carries the KI-Telefonagent's calls with the sub-account's own speech providers instead of
 * Twilio's <Say>/<Gather>. Three ways, chosen per call from the voice settings (services/voice-engine.ts `phonePlan`):
 *
 *  - Live stream: `<Connect><Stream>` opens a WebSocket from Twilio to /hooks/twilio/stream/<sub-account> (our own RFC 6455
 *    endpoint, see services/voice-ws.ts). Audio runs both ways as µ-law, speech recognition streams, the answer is spoken
 *    as soon as the first bytes arrive, the caller may interrupt (services/voice-phone.ts).
 *  - Recorded turns: `<Record>` → speech to text → the agent → text to speech → `<Play>`. Slower, works with every provider
 *    and without WebSockets.
 *  - Twilio's voices: the default, and the fallback whenever a provider fails – the call never goes silent.
 *
 * The agent itself (prompt, tools, booking, summary) stays in modules/voice-ai.ts and is used through `app.services.voiceBrain`.
 * Also here: transcription (and a summary) of voicemails with the sub-account's own speech recognition.
 */

const MAX_STREAMS = 80;
const MAX_STREAMS_PER_LOCATION = 15;
const MAX_RECORDING = 12 * 1024 * 1024;
const xmlRes = (s: string) => text(s, 'text/xml; charset=utf-8');
const HANGUP = twiml('<Hangup/>');
const TIMEOUT = Symbol('timeout');
const race = <T,>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(TIMEOUT), ms);
    t.unref?.();
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(TIMEOUT)),
    );
  });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());
const EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/webm': 'webm' };

/** A Twilio recording (needs the account's credentials; Twilio answers with a redirect to its media storage). */
export async function twilioRecording(app: App, cfg: Pick<Config, 'accountSid' | 'token'>, recordingSid: string, ext: 'wav' | 'mp3', tries = 3): Promise<Buffer> {
  if (!ACCOUNT_SID.test(cfg.accountSid) || !cfg.token) throw new Error('Twilio-Zugangsdaten fehlen');
  if (!RECORDING_SID.test(recordingSid)) throw new Error('Ungültige Aufnahme');
  const fetcher: typeof fetch = app.services.twilioFetch ?? fetch;
  let status = 0;
  for (let i = 0; i < tries; i++) {
    const r = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Recordings/${recordingSid}.${ext}`, {
      headers: { authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.token}`).toString('base64')}` },
      signal: AbortSignal.timeout(20_000),
    });
    status = r.status;
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_RECORDING) throw new Error('Aufnahme ist zu groß');
      return buf;
    }
    // Twilio may need a moment before a fresh recording can be fetched.
    if (r.status === 404 && i < tries - 1) await sleep(400);
    else break;
  }
  throw new Error(`Twilio: Aufnahme nicht abrufbar (HTTP ${status})`);
}

export const voicePhoneModule: Module = {
  name: 'voice-phone',
  migrations: [],
  register(app) {
    const { router, db } = app;
    const hook = (name: string, loc: string) => `${app.baseUrl()}/hooks/twilio/${name}/${loc}`;
    const brain = () => app.services.voiceBrain as VoiceBrain | undefined;
    const audio = new AudioStore();
    /** Audio of static phrases (greeting, "Einen Moment bitte") – µ-law chunks for streams, files for recorded turns. */
    const phraseStream = new PhraseCache<Buffer[]>();
    const phraseFile = new PhraseCache<{ data: Buffer; mime: string }>();
    const active = new Map<string, number>();
    /** What the call does after its stream ended (the stream's `action` URL asks for it). */
    const streamEnd = new Map<string, { next: string | null; at: number }>();
    const turnJobs = new Map<string, { promise: Promise<PhoneReply>; n: number; at: number }>();

    // --- choosing the transport for a call (hook of modules/voice-ai.ts) ---------------------------------------------
    app.services.voiceTransport = (input: { loc: LocationRow; call: Record<string, any>; sessionId: string; greeting: string }): string | undefined => {
      const plan = phonePlan(app, input.loc.id);
      if (plan.engine !== 'own') return undefined;
      if (plan.transport === 'twilio') {
        console.warn(`[voice-phone] ${input.loc.id}: eigene Stimme nicht möglich – Twilio-Stimme. ${plan.problems.join(' ')}`);
        brain()?.note(input.loc.id, input.call.sid, 'voice_fallback', true, `Twilio-Stimme statt eigener Stimme: ${plan.problems.join(' ').slice(0, 300)}`);
        return undefined;
      }
      brain()?.note(input.loc.id, input.call.sid, 'voice_transport', true, plan.transport === 'stream' ? `Eigene Stimme per Live-Stream (${plan.tts?.label} / ${plan.stt?.label})` : `Eigene Stimme per Aufnahme-Runden (${plan.tts?.label} / ${plan.stt?.label})`);
      if (plan.transport === 'stream') {
        return streamTwiml({ url: wsUrl(app.baseUrl(), `/hooks/twilio/stream/${input.loc.id}`), action: hook('voice-ai-stream-end', input.loc.id), params: { token: streamToken(app.config.secret, input.loc.id, String(input.call.sid)) } });
      }
      return turnTwiml(`<Redirect method="POST">${xml(`${hook('voice-ai-turn', input.loc.id)}?first=1`)}</Redirect>`);
    };

    // --- live stream: the WebSocket Twilio opens -------------------------------------------------------------------------
    const streamEnv = (loc: LocationRow) => ({
      async begin(start: StartInfo): Promise<PhoneCall | null> {
        if (!verifyStreamToken(app.config.secret, start.params.token, loc.id, start.callSid)) {
          console.warn(`[voice-phone] ${loc.id}: Stream mit ungültigem Token abgewiesen`);
          return null;
        }
        const cfg = telephonyConfig(app, loc.id);
        if (start.accountSid && cfg.accountSid && start.accountSid !== cfg.accountSid) return null;
        const b = brain();
        const info = b?.open(loc.id, start.callSid);
        if (!b || !info) return null;
        const vs = loadVoiceSettings(app, loc.id);
        const tc = await voiceConnection(app, loc.id, 'audio_tts', vs.phone.tts_connection_id || vs.tts.connection_id || null);
        const sc = await voiceConnection(app, loc.id, 'stt', vs.phone.stt_connection_id || vs.stt.connection_id || null);
        const live = liveTts(app, loc.id, tc, { model: vs.phone.tts_model, voice: vs.phone.tts_voice, language: vs.tts.language, speed: vs.tts.speed, instructions: vs.tts.instructions, ws: vs.phone.tts_ws });
        if (!live) return null;
        const started = Date.now();
        const sid = start.callSid;
        const keyOf = (t: string) => `${tc.connectionId}|${vs.phone.tts_model || vs.tts.model}|${vs.phone.tts_voice || vs.tts.voice}|${vs.tts.speed}|${t}`;
        active.set(loc.id, (active.get(loc.id) ?? 0) + 1);
        return {
          greeting: info.greeting,
          maxMs: info.maxMs,
          settings: { bargeIn: vs.phone.barge_in, filler: vs.phone.filler, endpointMs: vs.phone.endpoint_ms },
          async *tts(t, signal) {
            const key = keyOf(t);
            const hit = phraseStream.get(key);
            if (hit) return yield* hit;
            // The greeting and the filler are the same every call: kept, so they start without a provider round trip.
            const keep: Buffer[] | null = t === info.greeting || t === FILLER ? [] : null;
            for await (const chunk of live.stream(t, signal)) {
              keep?.push(chunk);
              yield chunk;
            }
            if (keep?.length && !signal.aborted) phraseStream.set(key, keep);
          },
          openStt: (h) => openLiveStt(app, loc.id, sc, { language: vs.stt.language, model: vs.phone.stt_model || vs.stt.model, endpointMs: vs.phone.endpoint_ms, vocabulary: loc.name }, h),
          turn: (speech) => b.turn(loc.id, sid, speech),
          silence: () => b.silence(loc.id, sid),
          degrade: (line, reason) => b.degrade(loc.id, sid, line, reason),
          note: (type, ok, detail) => b.note(loc.id, sid, type, ok, detail),
          metrics: (m) => app.services.voiceTurnLog?.(loc.id, sid, 'stream', m),
          finish: (next, why) => {
            active.set(loc.id, Math.max(0, (active.get(loc.id) ?? 1) - 1));
            streamEnd.set(sid, { next, at: Date.now() });
            bumpUsage(app, loc.id, 'phone', 0, Date.now() - started);
            if (why !== 'caller') b.note(loc.id, sid, 'stream_end', true, `Live-Stream beendet (${why})`);
          },
        };
      },
    });

    const upgrade = (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): boolean => {
      let path = '';
      try {
        path = new URL(req.url ?? '/', 'http://x').pathname;
      } catch {
        return false;
      }
      const m = /^\/hooks\/twilio\/stream\/([A-Za-z0-9_-]{6,64})$/.exec(path);
      if (!m) return false;
      const loc = app.location(m[1]);
      if (!loc) return refuse(socket, 404, 'Not Found'), true;
      const total = [...active.values()].reduce((a, b) => a + b, 0);
      if (total >= MAX_STREAMS || (active.get(loc.id) ?? 0) >= MAX_STREAMS_PER_LOCATION) return refuse(socket, 503, 'Service Unavailable'), true;
      const ws = acceptWebSocket(req, socket, head, { maxPayload: 64 * 1024, idleMs: 120_000 });
      if (!ws) return true;
      const session = new PhoneSession(ws, streamEnv(loc));
      ws.on('message', (d, bin) => session.onMessage(d, bin));
      ws.on('close', () => session.onClose());
      ws.on('error', () => undefined);
      return true;
    };
    app.services.upgradeHandlers = [...(app.services.upgradeHandlers ?? []), upgrade];

    const hookRoute = (name: string, fn: (loc: LocationRow, p: Record<string, string>, cfg: Config, q: URLSearchParams) => string | Promise<string>) =>
      router.post(`/hooks/twilio/${name}/:loc`, 'public', async (ctx: Ctx) => {
        const loc = app.location(ctx.params.loc);
        if (!loc) throw notFound();
        const cfg = telephonyConfig(app, loc.id);
        verifyTwilio(app, ctx, cfg.token);
        const p: Record<string, string> = {};
        for (const [k, v] of Object.entries(ctx.body ?? {})) if (typeof v === 'string') p[k] = v;
        return xmlRes(await fn(loc, p, cfg, ctx.query));
      });

    /** The stream is over (we closed it, or it broke): what does the call do now? */
    hookRoute('voice-ai-stream-end', (loc, p) => {
      const sid = p.CallSid ?? '';
      const e = streamEnd.get(sid);
      if (e) {
        streamEnd.delete(sid);
        return e.next ?? HANGUP;
      }
      // Nobody told us: the connection broke while the call is alive → carry on with Twilio's voice instead of silence.
      return brain()?.degrade(loc.id, sid, '', 'Verbindung zum Live-Stream abgebrochen')?.twiml ?? HANGUP;
    });

    // --- recorded turns -------------------------------------------------------------------------------------------------------
    const speakFile = async (loc: LocationRow, vs: ReturnType<typeof loadVoiceSettings>, say: string, isStatic: boolean) => {
      const key = `${vs.phone.tts_connection_id || vs.tts.connection_id}|${vs.phone.tts_model || vs.tts.model}|${vs.phone.tts_voice || vs.tts.voice}|${say}`;
      let a = isStatic ? phraseFile.get(key) : undefined;
      if (!a) {
        const out = await synthesize(app, { locationId: loc.id, text: say, connectionId: vs.phone.tts_connection_id || null, model: vs.phone.tts_model || undefined, voice: vs.phone.tts_voice || undefined });
        a = { data: out.data, mime: out.mime };
        if (isStatic) phraseFile.set(key, a);
      }
      const token = audio.put(loc.id, a.data, a.mime);
      return `${app.baseUrl()}/hooks/voice/play/${token}.${EXT[a.mime] ?? 'mp3'}`;
    };

    /** Speaks a reply with the own voice (a <Play>) and says what comes next; any trouble falls back to Twilio's voice. */
    const renderTurn = async (loc: LocationRow, sid: string, reply: PhoneReply, greeting = false): Promise<string> => {
      const vs = loadVoiceSettings(app, loc.id);
      let play = '';
      if (reply.say.trim()) {
        try {
          play = playNoun(await speakFile(loc, vs, reply.say, greeting || reply.say === FILLER));
        } catch (e) {
          const msg = (e as Error).message;
          console.warn(`[voice-phone] ${loc.id}: Sprachausgabe fehlgeschlagen – ${msg}`);
          brain()?.note(loc.id, sid, 'tts_error', false, msg.slice(0, 200));
          if (reply.then === 'listen') return brain()?.degrade(loc.id, sid, reply.say, `Sprachausgabe: ${msg}`)?.twiml ?? HANGUP;
          return reply.twiml || HANGUP;
        }
      }
      if (reply.then === 'listen') return turnTwiml(play, recordTurnNoun({ action: hook('voice-ai-turn', loc.id) }));
      if (reply.then === 'hangup') return turnTwiml(play, '<Hangup/>');
      return prependTo(reply.next || reply.twiml || HANGUP, play);
    };

    const transcribeTurn = async (loc: LocationRow, cfg: Config, p: Record<string, string>): Promise<string> => {
      let url: URL;
      try {
        url = new URL(p.RecordingUrl);
      } catch {
        throw new Error('Aufnahme-Adresse ungültig');
      }
      const m = /^\/2010-04-01\/Accounts\/(AC[0-9a-f]{32})\/Recordings\/(RE[0-9a-f]{32})$/i.exec(url.pathname.replace(/\.(wav|mp3)$/i, ''));
      // Only our own account's recordings are fetched with its credentials.
      if (url.hostname !== 'api.twilio.com' || !m || m[1] !== cfg.accountSid) throw new Error('Aufnahme gehört nicht zu diesem Twilio-Konto');
      const vs = loadVoiceSettings(app, loc.id);
      const bytes = await twilioRecording(app, cfg, m[2], 'wav');
      // The caller's voice does not stay at Twilio longer than necessary.
      void twilioRequest(app, cfg, 'DELETE', `/Recordings/${m[2]}.json`).catch(() => undefined);
      const r = await transcribe(app, { locationId: loc.id, audio: bytes, hint: 'audio/wav', connectionId: vs.phone.stt_connection_id || null, model: vs.phone.stt_model || undefined, language: vs.stt.language, vocabulary: loc.name });
      return r.text;
    };

    /** First turn (greeting) and every <Record> result of a call carried with the own voice. */
    hookRoute('voice-ai-turn', async (loc, p, cfg, q) => {
      const sid = p.CallSid ?? '';
      const b = brain();
      const info = b?.open(loc.id, sid);
      if (!b || !info) return HANGUP;
      if (q.get('first') === '1') return renderTurn(loc, sid, { say: info.greeting, then: 'listen', twiml: '', next: '' }, true);
      const secs = Number(p.RecordingDuration ?? 0);
      let speech = '';
      if (p.RecordingUrl && secs >= 1) {
        const t0 = Date.now();
        try {
          speech = await transcribeTurn(loc, cfg, p);
        } catch (e) {
          const msg = (e as Error).message;
          console.warn(`[voice-phone] ${loc.id}: Spracherkennung fehlgeschlagen – ${msg}`);
          b.note(loc.id, sid, 'stt_error', false, msg.slice(0, 200));
          return b.degrade(loc.id, sid, '', `Spracherkennung: ${msg}`)?.twiml ?? HANGUP;
        }
        app.services.voiceTurnLog?.(loc.id, sid, 'turns', { n: 0, stt_ms: Date.now() - t0, at: now() });
      }
      const started = speech ? b.turn(loc.id, sid, speech) : { reply: b.silence(loc.id, sid) ?? undefined };
      if (started.reply) return renderTurn(loc, sid, started.reply);
      if (!started.job) return HANGUP;
      const done = await race(started.job, voiceTiming.replyMs);
      if (done !== TIMEOUT) return renderTurn(loc, sid, done);
      turnJobs.set(sid, { promise: started.job, n: 1, at: Date.now() });
      return fillerTwiml('Einen Moment bitte.', info.voice, `${hook('voice-ai-turn-wait', loc.id)}?n=1`);
    });

    /** The agent was slow: Twilio asks again after the filler line. */
    hookRoute('voice-ai-turn-wait', async (loc, p, _cfg, q) => {
      const sid = p.CallSid ?? '';
      const b = brain();
      const info = b?.open(loc.id, sid);
      const job = turnJobs.get(sid);
      if (!b || !info) return HANGUP;
      if (!job) return b.degrade(loc.id, sid, '', 'Antwort des Agenten fehlt')?.twiml ?? HANGUP;
      const n = Math.max(1, Math.round(Number(q.get('n') ?? 1)));
      const done = await race(job.promise, voiceTiming.waitMs);
      if (done !== TIMEOUT) {
        turnJobs.delete(sid);
        return renderTurn(loc, sid, done);
      }
      if (n >= 2) {
        turnJobs.delete(sid);
        return b.degrade(loc.id, sid, '', 'Der Agent hat zu lange gebraucht')?.twiml ?? HANGUP;
      }
      return fillerTwiml('Ich bin gleich so weit.', info.voice, `${hook('voice-ai-turn-wait', loc.id)}?n=${n + 1}`);
    });

    /** The answers Twilio plays: short-lived, unguessable, never listed. */
    router.get('/hooks/voice/play/:file', 'public', (ctx) => {
      const m = /^([A-Za-z0-9_-]{32})\.(mp3|wav|ogg|m4a|aac|flac|webm)$/.exec(String(ctx.params.file));
      const a = m ? audio.get(m[1]) : undefined;
      if (!a) throw notFound();
      return { __raw: true, status: 200, headers: { 'content-type': a.mime, 'content-length': String(a.data.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: a.data };
    });

    // --- voicemails: own speech recognition, optional summary ------------------------------------------------------------
    app.events.on('call.voicemail', async (e) => {
      const vs = loadVoiceSettings(app, e.locationId);
      if (!vs.voicemail_transcribe && !vs.call_summary) return;
      const call = e.data.callId ? db.get<any>('SELECT * FROM calls WHERE id = ? AND location_id = ?', e.data.callId, e.locationId) : undefined;
      if (!call?.recording_sid) return;
      const cfg = telephonyConfig(app, e.locationId);
      let heard = '';
      try {
        const bytes = await twilioRecording(app, cfg, call.recording_sid, 'mp3');
        heard = (await transcribe(app, { locationId: e.locationId, audio: bytes, hint: 'audio/mpeg', language: vs.stt.language })).text;
      } catch (err) {
        console.warn(`[voice-phone] ${e.locationId}: Voicemail nicht transkribiert – ${(err as Error).message}`);
        return;
      }
      if (!heard) return;
      let body = heard;
      if (vs.call_summary && app.services.aiRun && !app.services.aiReady?.(e.locationId)) {
        try {
          const r = await app.services.aiRun({
            locationId: e.locationId,
            purpose: 'voice_agent',
            user: `<voicemail>\n${heard.slice(0, 6000)}\n</voicemail>\n\nAufgabe: Fasse diese Voicemail in ein bis zwei Sätzen zusammen (Wer? Was will die Person? Bis wann?) und nenne den nächsten Schritt für das Team. Antworte als JSON mit summary und next_step.`,
            schema: SUMMARY_SCHEMA,
            maxTokens: 600,
            contactId: call.contact_id,
          });
          const parsed = parseSummary(r.text);
          if (parsed.ok) body = `${heard}\n\nZusammenfassung: ${parsed.value.summary}${parsed.value.next_step ? `\nNächster Schritt: ${parsed.value.next_step}` : ''}`;
        } catch {
          /* logged by aiRun; the plain transcript is still saved */
        }
      }
      db.run('UPDATE calls SET transcription = ?, updated_at = ? WHERE id = ?', body.slice(0, 5000), now(), call.id);
      app.services.audit?.({ action: 'voice.voicemail.transcribe', actor: 'Stimme (automatisch)', locationId: e.locationId, entityId: call.id, route: 'event call.voicemail', summary: vs.call_summary ? 'Voicemail transkribiert und zusammengefasst' : 'Voicemail transkribiert' });
      const fresh = db.get<any>('SELECT * FROM calls WHERE id = ?', call.id);
      if (fresh) syncMessage(app, fresh);
      if (call.contact_id) logActivity(app, e.locationId, call.contact_id, 'call.voicemail_text', `Voicemail transkribiert: ${heard.slice(0, 160)}`);
    });

    // --- housekeeping ----------------------------------------------------------------------------------------------------
    let lastSweep = 0;
    app.onTick(() => {
      if (Date.now() - lastSweep < 60_000) return;
      lastSweep = Date.now();
      audio.sweep();
      const cut = Date.now() - 15 * 60_000;
      for (const [k, v] of streamEnd) if (v.at < cut) streamEnd.delete(k);
      for (const [k, v] of turnJobs) if (v.at < cut) turnJobs.delete(k);
    });
  },
};

