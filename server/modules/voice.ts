import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { aiConnections } from './ai-connections.js';
import { telephonyConfig } from './telephony.js';
import { callRoute, bodyLocation } from '../services/mobile.js';
import { presetById } from '../services/ai-presets.js';
import { gmFetch } from '../services/genmedia/http.js';
import { MAX_STT_BYTES, MAX_TTS_CHARS, asHttp, ensureVoiceAdapters, listVoices, loadVoiceSettings, peekConnection, phonePlan, publicHttps, sttStreamMode, synthesize, transcribe, ttsStreamMode } from '../services/voice-engine.js';
import { VOICE_RE, cleanUserPrefs, cleanVoiceSettings, withUserDefaults, type VoiceUserPrefs } from '../services/voice-settings.js';
import { VOICE_TOOLS } from './voice-tools.js';
import { resolveTtsVoice } from '../services/companion-prefs.js';

/**
 * Stimme: the voice layer on top of the BYOK registry (KI-Anbieter) – settings per sub-account ("Stimme"),
 * per-user preferences of the HyperLevel Agent panel, voices of the provider, "Stimme testen", speech to text for the
 * push-to-talk button (also for the native app) and the latency of phone calls. The phone transports (Media Streams,
 * recorded turns) live in modules/voice-phone.ts; providers in services/voice-adapters.ts and voice-stream-*.ts.
 * Which provider speaks and listens is decided by the registry's routing ("Sprachausgabe", "Transkription") or by the
 * connection chosen here; keys are never stored or shown by this module.
 */

/** One person may start this many calls of a kind per minute (the providers bill per use). */
const RATE: Record<string, number> = { transcribe: 40, speak: 40, test: 15 };

export const voiceModule: Module = {
  name: 'voice',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE voice_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE TABLE voice_user_prefs (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, location_id)
      );
      CREATE TABLE voice_usage (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        day TEXT NOT NULL, kind TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0, units INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (location_id, day, kind)
      );
      CREATE TABLE voice_turns (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        call_sid TEXT NOT NULL, n INTEGER NOT NULL,
        stt_ms INTEGER, llm_ms INTEGER, tts_ms INTEGER, total_ms INTEGER,
        interrupted INTEGER NOT NULL DEFAULT 0, transport TEXT NOT NULL DEFAULT '', at TEXT NOT NULL
      );
      CREATE INDEX voice_turns_loc ON voice_turns(location_id, at);
      CREATE INDEX voice_turns_call ON voice_turns(call_sid);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    ensureVoiceAdapters();

    // --- limits per person ---------------------------------------------------------------------------------------------
    const hits = new Map<string, number[]>();
    const throttle = (ctx: Ctx, kind: string) => {
      const key = `${ctx.user?.id ?? ctx.ip}:${kind}`;
      const t = Date.now();
      const list = (hits.get(key) ?? []).filter((x) => t - x < 60_000);
      if (list.length >= RATE[kind]) throw new HttpError(429, 'Zu viele Anfragen – bitte eine Minute warten');
      list.push(t);
      hits.set(key, list);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < 60_000)) hits.delete(k);
    };

    // --- settings ------------------------------------------------------------------------------------------------------
    const registry = () => aiConnections(app);
    const connectionsOf = (locId: string, cap: 'audio_tts' | 'stt') =>
      (registry()?.list(locId, cap) ?? []).map((c) => {
        const preset = presetById(c.provider);
        return {
          id: c.id,
          provider: c.provider,
          label: c.label,
          model: c.models?.[cap] || c.model || '',
          scope: c.scope,
          key_set: c.key_set || !preset?.keyRequired,
          live: cap === 'audio_tts' ? !!preset?.realtime?.audio_tts : !!preset?.realtime?.stt,
          stream: cap === 'audio_tts' ? ttsStreamMode(c) : sttStreamMode(c),
        };
      });

    const usageOf = (locId: string) => {
      const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const rows = db.all<{ kind: string; calls: number; units: number; ms: number }>('SELECT kind, SUM(calls) calls, SUM(units) units, SUM(ms) ms FROM voice_usage WHERE location_id = ? AND day >= ? GROUP BY kind', locId, since);
      const by = (k: string) => rows.find((r) => r.kind === k);
      return { days: 30, tts_calls: by('tts')?.calls ?? 0, tts_chars: by('tts')?.units ?? 0, stt_calls: by('stt')?.calls ?? 0, stt_bytes: by('stt')?.units ?? 0, phone_calls: by('phone')?.calls ?? 0, phone_seconds: Math.round((by('phone')?.ms ?? 0) / 1000) };
    };

    const percentile = (xs: number[], p: number) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);
    const latencyOf = (locId: string, limit = 60) => {
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const rows = db.all<any>('SELECT call_sid, n, stt_ms, llm_ms, tts_ms, total_ms, interrupted, transport, at FROM voice_turns WHERE location_id = ? AND at >= ? ORDER BY at DESC LIMIT 500', locId, since);
      const col = (k: string) => rows.map((r) => r[k]).filter((v) => typeof v === 'number') as number[];
      const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
      return {
        summary: {
          turns: rows.length,
          interrupted: rows.filter((r) => r.interrupted).length,
          total_p50: percentile(col('total_ms'), 50),
          total_p95: percentile(col('total_ms'), 95),
          stt_avg: avg(col('stt_ms')),
          llm_avg: avg(col('llm_ms')),
          tts_avg: avg(col('tts_ms')),
        },
        turns: rows.slice(0, limit).map((r) => ({ ...r, interrupted: !!r.interrupted })),
      };
    };

    const settingsOut = (locId: string) => {
      const cfg = telephonyConfig(app, locId);
      const problem: string | null = app.services.aiReady ? app.services.aiReady(locId) : 'Das Modul KI-Assistent fehlt.';
      const tts = peekConnection(app, locId, 'audio_tts');
      const stt = peekConnection(app, locId, 'stt');
      return {
        settings: loadVoiceSettings(app, locId),
        connections: { tts: connectionsOf(locId, 'audio_tts'), stt: connectionsOf(locId, 'stt') },
        routed: {
          tts: tts ? { id: tts.connectionId, provider: tts.provider, label: tts.label || tts.provider } : null,
          stt: stt ? { id: stt.connectionId, provider: stt.provider, label: stt.label || stt.provider } : null,
        },
        phone: {
          plan: phonePlan(app, locId),
          twilio_ready: !!(cfg.accountSid && cfg.token && cfg.numbers.length),
          agent_ready: !problem,
          public_https: publicHttps(app.baseUrl()),
          base_url: app.baseUrl(),
        },
        usage: usageOf(locId),
        latency: latencyOf(locId, 0).summary,
        limits: { max_tts_chars: MAX_TTS_CHARS, max_stt_mb: Math.round(MAX_STT_BYTES / 1024 / 1024) },
      };
    };

    /** A connection id in the settings must be one this sub-account may use for that capability. */
    const checkConnections = (locId: string, s: ReturnType<typeof loadVoiceSettings>) => {
      const tts = new Set(connectionsOf(locId, 'audio_tts').map((c) => c.id));
      const stt = new Set(connectionsOf(locId, 'stt').map((c) => c.id));
      for (const [cid, set, what] of [
        [s.tts.connection_id, tts, 'Sprachausgabe'],
        [s.phone.tts_connection_id, tts, 'Telefon-Stimme'],
        [s.stt.connection_id, stt, 'Spracherkennung'],
        [s.phone.stt_connection_id, stt, 'Spracherkennung am Telefon'],
      ] as const) {
        if (cid && !set.has(cid)) throw bad(`${what}: Diese Verbindung gibt es nicht oder sie kann das nicht (Einstellungen → KI-Anbieter).`);
      }
    };

    router.get('/api/voice/settings', 'location', (ctx) => settingsOut(ctx.locationId));
    router.put('/api/voice/settings', 'location', (ctx) => {
      const next = cleanVoiceSettings(ctx.body ?? {}, loadVoiceSettings(app, ctx.locationId));
      checkConnections(ctx.locationId, next);
      db.run('INSERT INTO voice_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', ctx.locationId, JSON.stringify(next), now());
      return settingsOut(ctx.locationId);
    });

    router.get('/api/voice/voices', 'location', async (ctx) => {
      const language = str(ctx.query.get('language'), 'Sprache', { max: 12 });
      const connectionId = str(ctx.query.get('connection_id'), 'Verbindung', { max: 120 });
      if (connectionId && !connectionsOf(ctx.locationId, 'audio_tts').some((c) => c.id === connectionId)) throw notFound('Verbindung nicht gefunden');
      try {
        const r = await listVoices(app, ctx.locationId, { connectionId: connectionId || null, language: language || undefined, refresh: ctx.query.get('refresh') === '1' });
        return { ...r, free_text: true };
      } catch (e) {
        throw asHttp(e);
      }
    });

    router.get('/api/voice/latency', 'location', (ctx) => latencyOf(ctx.locationId, clampLimit(ctx.query.get('limit'), 60, 200)));

    // --- "Stimme testen" ---------------------------------------------------------------------------------------------------
    const dataUrl = (mime: string, data: Buffer) => `data:${mime};base64,${data.toString('base64')}`;
    router.post('/api/voice/test', 'location', async (ctx) => {
      throttle(ctx, 'test');
      const b = ctx.body ?? {};
      const text = str(b.text, 'Text', { max: 300 }) || 'Guten Tag, hier spricht Ihr digitaler Assistent. Wie kann ich Ihnen helfen?';
      const connectionId = str(b.connection_id, 'Verbindung', { max: 120 });
      if (connectionId && !connectionsOf(ctx.locationId, 'audio_tts').some((c) => c.id === connectionId)) throw notFound('Verbindung nicht gefunden');
      try {
        const out = await synthesize(app, { locationId: ctx.locationId, text, connectionId: connectionId || null, voice: str(b.voice, 'Stimme', { max: 120 }) || undefined, model: str(b.model, 'Modell', { max: 160 }) || undefined, language: str(b.language, 'Sprache', { max: 12 }) || undefined, speed: typeof b.speed === 'number' ? Math.max(0.5, Math.min(2, b.speed)) : undefined, instructions: str(b.instructions, 'Stil', { max: 500 }) || undefined });
        return { audio: dataUrl(out.mime, out.data), mime: out.mime, provider: out.provider, model: out.model, voice: out.voice, chars: out.chars, bytes: out.data.length, ms: out.ms };
      } catch (e) {
        throw asHttp(e);
      }
    });

    // --- speech to text for push-to-talk (browser, Android WebView, native app) ----------------------------------------------
    const prevLimit = app.services.rawBodyLimit;
    app.services.rawBodyLimit = (method: string, path: string, req: any, cookies: Record<string, string>): number | undefined =>
      method === 'POST' && path === '/api/voice/transcribe' && (cookies.pghl_session || req.headers.authorization) ? MAX_STT_BYTES + 1024 : prevLimit?.(method, path, req, cookies);

    /**
     * Raw audio bytes (the browser: `fetch(…, { body: blob })`), or JSON {data: "data:audio/…;base64,…"} – the native app and
     * the API. The body of this route is read raw, so JSON arrives as bytes and is parsed here.
     */
    const readAudio = (ctx: Ctx): { audio: Buffer; language?: string; vocabulary?: string } => {
      let buf = ctx.rawBuffer;
      let body: Record<string, any> = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
      if (buf?.length && String(ctx.req.headers['content-type'] ?? '').includes('application/json')) {
        try {
          const parsed = JSON.parse(buf.toString('utf8'));
          body = parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          throw bad('Ungültiges JSON');
        }
        buf = undefined;
      }
      if (!buf?.length && typeof body.data === 'string') {
        const m = /^data:[\w/+.;=-]+;base64,(.+)$/s.exec(body.data);
        if (!m) throw bad('Erwarte Rohdaten oder eine data:-URL');
        if (m[1].length > MAX_STT_BYTES * 1.4) throw new HttpError(413, `Aufnahme ist zu groß (höchstens ${Math.round(MAX_STT_BYTES / 1024 / 1024)} MB)`);
        buf = Buffer.from(m[1], 'base64');
      }
      if (!buf?.length) throw bad('Aufnahme fehlt');
      if (buf.length > MAX_STT_BYTES) throw new HttpError(413, `Aufnahme ist zu groß (höchstens ${Math.round(MAX_STT_BYTES / 1024 / 1024)} MB)`);
      return {
        audio: buf,
        language: str(ctx.query.get('language') ?? body.language, 'Sprache', { max: 12 }) || undefined,
        vocabulary: str(ctx.query.get('vocabulary') ?? body.vocabulary, 'Begriffe', { max: 500 }) || undefined,
      };
    };

    router.post('/api/voice/transcribe', 'location', async (ctx) => {
      throttle(ctx, 'transcribe');
      const { audio, language, vocabulary } = readAudio(ctx);
      try {
        const r = await transcribe(app, { locationId: ctx.locationId, audio, hint: String(ctx.req.headers['content-type'] ?? ''), language, vocabulary });
        return { text: r.text, provider: r.provider, model: r.model, ms: r.ms, bytes: r.bytes };
      } catch (e) {
        throw asHttp(e);
      }
    });

    /** An audio file that is already ours (media library, KI-Studio) or at a public https address → text (MCP, workflows). */
    router.post('/api/voice/transcribe-url', 'location', async (ctx) => {
      throttle(ctx, 'transcribe');
      const b = ctx.body ?? {};
      let audio: Buffer;
      if (b.upload_id) {
        const row = db.get<{ file: string }>('SELECT file FROM uploads WHERE id = ? AND location_id = ?', str(b.upload_id, 'Datei', { max: 80 }), ctx.locationId);
        if (!row || !/^[\w.-]+$/.test(row.file)) throw notFound('Datei aus der Mediathek nicht gefunden');
        const path = join(app.config.dataDir, 'uploads', row.file);
        if (!existsSync(path)) throw notFound('Datei fehlt auf dem Server');
        audio = readFileSync(path);
        if (audio.length > MAX_STT_BYTES) throw new HttpError(413, 'Datei ist zu groß');
      } else if (b.url) {
        const url = str(b.url, 'Adresse', { max: 2000 });
        if (!/^https:\/\//i.test(url)) throw bad('Bitte eine öffentliche https://-Adresse angeben');
        try {
          const r = await gmFetch(app, url, { maxBytes: MAX_STT_BYTES, timeoutMs: 60_000 });
          if (!r.ok) throw bad(`Download fehlgeschlagen (HTTP ${r.status})`);
          audio = r.body;
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw bad(`Download fehlgeschlagen: ${(e as Error).message}`);
        }
      } else throw bad('Bitte upload_id oder url angeben');
      try {
        const r = await transcribe(app, { locationId: ctx.locationId, audio, language: str(b.language, 'Sprache', { max: 12 }) || undefined, vocabulary: str(b.vocabulary, 'Begriffe', { max: 500 }) || undefined });
        return { text: r.text, provider: r.provider, model: r.model, ms: r.ms, bytes: r.bytes };
      } catch (e) {
        throw asHttp(e);
      }
    });

    // --- spoken replies of the HyperLevel Agent -----------------------------------------------------------------------------------
    const prefsOf = (locId: string, userId: string | undefined): VoiceUserPrefs => {
      if (!userId) return withUserDefaults(null);
      const row = db.get<{ data: string }>('SELECT data FROM voice_user_prefs WHERE user_id = ? AND location_id = ?', userId, locId);
      try {
        return withUserDefaults(row ? JSON.parse(row.data) : null);
      } catch {
        return withUserDefaults(null);
      }
    };
    /**
     * Who speaks: without `provider`/`connection_id` the person's agent voice (prefs) or the sub-account's; with them (the companion's
     * voice, e.g. Google "de-DE-Chirp3-HD-Iapetus"; "auto" = the native Jarvis voice of `lang`) only a connection of this sub-account that can speak – `provider` = its first one of that
     * preset. Another sub-account's connection or an unknown id is "not found", never an address of the caller's choosing.
     */
    const speaker = (ctx: Ctx, b: Record<string, any>): { connectionId: string | null; voice?: string; inherit: boolean } => {
      const asked = str(b.voice, 'Stimme', { max: 120 });
      if (asked && !VOICE_RE.test(asked)) throw bad('Stimme: ungültige Zeichen');
      // "auto" is the Jarvis voice of whichever provider ends up speaking (Google: by language, kie.ai: Brian, others: their default)
      const voiceFor = (provider: string | undefined) => (asked === 'auto' ? resolveTtsVoice(asked, b.lang === 'en' ? 'en' : 'de', provider ?? '') : asked);
      const wantConn = str(b.connection_id, 'Verbindung', { max: 120 });
      const wantProvider = str(b.provider, 'Anbieter', { max: 40 });
      const prefs = prefsOf(ctx.locationId, ctx.user?.id);
      const conns = connectionsOf(ctx.locationId, 'audio_tts');
      if (!wantConn && !wantProvider) {
        const connectionId = prefs.connection_id && conns.some((c) => c.id === prefs.connection_id) ? prefs.connection_id : null;
        const provider = peekConnection(app, ctx.locationId, 'audio_tts', connectionId || loadVoiceSettings(app, ctx.locationId).tts.connection_id || null)?.provider;
        return { connectionId, voice: voiceFor(provider) || prefs.voice || undefined, inherit: true };
      }
      let conn: (typeof conns)[number] | undefined;
      if (wantConn) {
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(wantConn)) throw bad('Verbindung: ungültig');
        conn = conns.find((c) => c.id === wantConn);
        if (!conn) throw notFound('Verbindung nicht gefunden');
        if (wantProvider && conn.provider !== wantProvider) throw bad('Verbindung und Anbieter passen nicht zusammen');
      } else {
        if (!/^[a-z][a-z0-9_]{1,39}$/.test(wantProvider)) throw bad('Anbieter: ungültig');
        conn = conns.find((c) => c.provider === wantProvider && c.key_set);
        if (!conn) throw new HttpError(409, `Keine Verbindung „${presetById(wantProvider)?.label ?? wantProvider}“ für die Sprachausgabe – unter Einstellungen → KI-Anbieter anlegen.`);
      }
      // the sub-account's saved voice/model belong to its own voice connection – not to another provider's
      const own = peekConnection(app, ctx.locationId, 'audio_tts', loadVoiceSettings(app, ctx.locationId).tts.connection_id || null)?.connectionId;
      return { connectionId: conn.id, voice: voiceFor(conn.provider) || undefined, inherit: own === conn.id };
    };
    router.post('/api/voice/speak', 'location', async (ctx) => {
      throttle(ctx, 'speak');
      const b = ctx.body ?? {};
      const text = str(b.text, 'Text', { required: true, max: MAX_TTS_CHARS });
      const { connectionId, voice, inherit } = speaker(ctx, b);
      // the companion says which language it speaks (kie.ai/ElevenLabs Turbo is told it; otherwise the sub-account's setting)
      const language = b.lang === 'en' || b.lang === 'de' ? b.lang : undefined;
      try {
        const out = await synthesize(app, { locationId: ctx.locationId, text, connectionId, voice, inherit, language });
        if (ctx.query.get('format') === 'json' || b.format === 'json') return { audio: dataUrl(out.mime, out.data), mime: out.mime, ms: out.ms, chars: out.chars };
        return { __raw: true, status: 200, headers: { 'content-type': out.mime, 'content-length': String(out.data.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: out.data };
      } catch (e) {
        throw asHttp(e);
      }
    });

    const prefsOut = (ctx: Ctx) => {
      const p = prefsOf(ctx.locationId, ctx.user?.id);
      const s = loadVoiceSettings(app, ctx.locationId);
      return {
        prefs: p,
        effective: { read_aloud: p.read_aloud ?? s.agent.read_aloud, auto_send: p.auto_send ?? s.agent.auto_send },
        defaults: s.agent,
        ready: { stt: !!peekConnection(app, ctx.locationId, 'stt', s.stt.connection_id || null), tts: !!peekConnection(app, ctx.locationId, 'audio_tts', s.tts.connection_id || null) },
        connections: connectionsOf(ctx.locationId, 'audio_tts').map((c) => ({ id: c.id, label: c.label, provider: c.provider, usable: c.key_set })),
        limits: { max_stt_mb: Math.round(MAX_STT_BYTES / 1024 / 1024) },
      };
    };
    router.get('/api/voice/prefs', 'location', (ctx) => prefsOut(ctx));
    router.put('/api/voice/prefs', 'location', (ctx) => {
      if (!ctx.user) throw new HttpError(403, 'Persönliche Einstellungen gibt es nur für angemeldete Personen');
      const next = cleanUserPrefs(ctx.body ?? {}, prefsOf(ctx.locationId, ctx.user.id));
      if (next.connection_id && !connectionsOf(ctx.locationId, 'audio_tts').some((c) => c.id === next.connection_id)) throw bad('Diese Verbindung gibt es nicht oder sie kann keine Sprachausgabe');
      db.run('INSERT INTO voice_user_prefs (user_id, location_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', ctx.user.id, ctx.locationId, JSON.stringify(next), now());
      return prefsOut(ctx);
    });

    // --- native app (bearer ghm_…): relays onto the routes above ----------------------------------------------------------------
    router.post('/api/mobile/voice/transcribe', 'user', async (ctx) => {
      ctx.skipAfterWrite = true;
      const b = ctx.body ?? {};
      const loc = bodyLocation(app, ctx, b.location_id);
      const { location_id: _l, ...body } = b;
      return callRoute(app, ctx, 'POST', '/api/voice/transcribe', { locationId: loc.id, body });
    });
    router.post('/api/mobile/voice/speak', 'user', async (ctx) => {
      ctx.skipAfterWrite = true;
      const b = ctx.body ?? {};
      const loc = bodyLocation(app, ctx, b.location_id);
      const { location_id: _l, ...body } = b;
      return callRoute(app, ctx, 'POST', '/api/voice/speak?format=json', { locationId: loc.id, body });
    });

    // --- MCP tools -----------------------------------------------------------------------------------------------------
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...VOICE_TOOLS];

    // --- housekeeping --------------------------------------------------------------------------------------------------
    let lastPrune = 0;
    app.onTick(() => {
      if (Date.now() - lastPrune < 6 * 3600_000) return;
      lastPrune = Date.now();
      db.run('DELETE FROM voice_turns WHERE at < ?', new Date(Date.now() - 90 * 864e5).toISOString());
      db.run('DELETE FROM voice_usage WHERE day < ?', new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10));
    });

    /** Phone modules store turn latency here. */
    app.services.voiceTurnLog = (locationId: string, callSid: string, transport: string, m: { n: number; stt_ms?: number; llm_ms?: number; tts_ms?: number; total_ms?: number; interrupted?: boolean; at: string }) => {
      try {
        db.insert('voice_turns', { id: id(), location_id: locationId, call_sid: callSid, n: m.n, stt_ms: m.stt_ms ?? null, llm_ms: m.llm_ms ?? null, tts_ms: m.tts_ms ?? null, total_ms: m.total_ms ?? null, interrupted: m.interrupted ? 1 : 0, transport, at: m.at });
      } catch (e) {
        console.error('[voice] turn log', (e as Error).message);
      }
    };
  },
};

