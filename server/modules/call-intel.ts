import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, num, str, type Ctx } from '../core/http.js';
import { ymdInTz, zonedToUtc } from '../core/time.js';
import { id, now } from '../core/util.js';
import { contactBlock } from '../services/ai-context.js';
import {
  ANALYSIS_SCHEMA,
  FILLERS,
  analysisPrompt,
  countFillers,
  keywords,
  parseAnalysis,
  questionCount,
  sentimentOf,
  splitChannels,
  talkStats,
  wavChunks,
  wordCount,
  type ActionItem,
  type Analysis,
} from '../services/call-intel.js';
import { sniff } from '../services/genmedia/media.js';
import { contactName, getContact, logActivity } from '../services/contacts.js';
import { MAX_STT_BYTES, asHttp, transcribe } from '../services/voice-engine.js';
import { registerTriggers, type TriggerMeta } from '../services/wfx-kit.js';
import { PURPOSES } from './ai-assistant.js';
import type { Tool } from './mcp.js';
import { syncMessage, telephonyConfig } from './telephony.js';

/**
 * Gesprächs-Intelligenz: what was said in a conversation, turned into something the team can use. A recorded call (or an
 * uploaded meeting recording, or a pasted transcript) is transcribed with the sub-account's own speech provider (KI-Anbieter →
 * Transkription), measured – talk-time ratio, longest monologue, interruptions, filler words, questions, keywords – and
 * analysed by the AI assistant: summary, action items (optionally tasks), topics, objections and sentiment. Two-channel
 * recordings (Twilio's "dual" recordings) separate the speakers exactly: every side is transcribed on its own and the talk time
 * comes from the audio. The summary lands on the contact's timeline and is offered to other modules as
 * `app.services.callSummaries`. Nothing is analysed unless the sub-account switched it on; audio is deleted after use.
 */

export interface IntelSettings {
  /** Analyse every recorded conversation (needs a speech provider). Off by default: audio goes to the provider. */
  auto_calls: boolean;
  /** Shorter recordings are ignored (seconds). */
  min_seconds: number;
  /** Action items of the employee side become tasks right away. */
  auto_tasks: boolean;
  /** Ask the AI assistant for summary, action items, topics and sentiment (else only the counted metrics and the word-list sentiment). */
  ai: boolean;
  language: string;
  stt_connection_id: string;
  default_scorecard_id: string;
  /** Delete the analyses (transcripts) after this many days; 0 = keep. */
  retention_days: number;
  /** Own filler words, added to the built-in list. */
  fillers: string[];
  /** Names and terms the speech recognition should know. */
  glossary: string;
  /** The timeline of the contact gets an entry with the summary. */
  timeline: boolean;
  /** Twilio's first channel is the other side's, the second ours – flip it when your recordings are the other way round. */
  channel_swap: boolean;
}

export const DEFAULT_INTEL: IntelSettings = {
  auto_calls: false,
  min_seconds: 30,
  auto_tasks: false,
  ai: true,
  language: 'de',
  stt_connection_id: '',
  default_scorecard_id: '',
  retention_days: 0,
  fillers: [],
  glossary: '',
  timeline: true,
  channel_swap: false,
};

interface IntelRow {
  id: string;
  location_id: string;
  source: 'call' | 'upload' | 'text';
  call_id: string | null;
  contact_id: string | null;
  user_id: string | null;
  title: string;
  status: 'queued' | 'transcribing' | 'analyzing' | 'done' | 'failed';
  error: string;
  ai_error: string;
  language: string;
  provider: string;
  audio_file: string;
  audio_bytes: number;
  duration_s: number;
  separated: number;
  transcript: string;
  utterances: { speaker: string; text: string }[];
  summary: string;
  next_step: string;
  action_items: ActionItem[];
  topics: string[];
  objections: string[];
  sentiment: Analysis['sentiment'] | null;
  metrics: Record<string, any>;
  consent_note: string;
  created_at: string;
  analyzed_at: string | null;
}
const JSON_COLS = ['utterances', 'action_items', 'topics', 'objections', 'sentiment', 'metrics'];

const TRIGGERS: TriggerMeta[] = [
  {
    type: 'call.analyzed',
    label: 'Gespräch ausgewertet',
    category: 'messages',
    summary: 'Ein aufgezeichnetes Gespräch wurde transkribiert und ausgewertet (Zusammenfassung, Aufgaben, Stimmung).',
    doc: 'Startet, wenn die Gesprächs-Intelligenz ein Gespräch fertig ausgewertet hat. {{event.summary}} ist die Zusammenfassung, {{event.next_step}} der nächste Schritt, {{event.sentiment}} die Stimmung (positiv, neutral, negativ, gemischt), {{event.action_items}} die Liste der Aufgaben. Typisch: bei negativer Stimmung die Führungskraft informieren, bei „Preis“ als Thema eine Aufgabe anlegen.',
    fields: [{ key: 'sentiment', label: 'Stimmung', type: 'select', options: [['', 'Jede'], ['positiv', 'Positiv'], ['neutral', 'Neutral'], ['negativ', 'Negativ'], ['gemischt', 'Gemischt']] }],
    sample: { summary: 'Kundin möchte ein Angebot für 20 Lizenzen.', next_step: 'Angebot bis Freitag senden', sentiment: 'positiv', topics: ['Angebot', 'Preis'], source: 'call' },
    keywords: 'gespräch analyse transkript zusammenfassung stimmung aufgaben anruf meeting',
  },
];

const TOOLS: Tool[] = [
  {
    name: 'ghl_call_analyses',
    title: 'Gesprächsauswertungen',
    description: 'Ausgewertete Gespräche (Telefonate, hochgeladene Besprechungen) eines Projekts: Titel, Zusammenfassung, Stimmung, Themen, Aufgaben, Redeanteil. Filter: contact_id, sentiment (positiv|neutral|negativ|gemischt), q (Suche), limit. Nur lesen.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
        contact_id: { type: 'string' },
        sentiment: { type: 'string', enum: ['positiv', 'neutral', 'negativ', 'gemischt'] },
        q: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['location_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const q = new URLSearchParams();
      for (const k of ['contact_id', 'sentiment', 'q']) if (a[k]) q.set(k, String(a[k]));
      q.set('limit', String(a.limit ?? 20));
      const r = await call.api('GET', `/api/call-intel?${q}`, { location: a.location_id });
      return { analyses: r.items };
    },
  },
  {
    name: 'ghl_call_analysis',
    title: 'Gesprächsauswertung lesen',
    description: 'Eine Gesprächsauswertung mit Transkript, Zusammenfassung, Aufgaben, Themen und Kennzahlen (Redeanteil, Füllwörter). Nur lesen.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, id: { type: 'string' } }, required: ['location_id', 'id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/call-intel/${encodeURIComponent(a.id)}`, { location: a.location_id }),
  },
];

export const callIntelDir = (app: App) => join(app.config.dataDir, 'call-intel');

export const callIntelModule: Module = {
  name: 'call-intel',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE call_intel_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE TABLE call_intel (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        source TEXT NOT NULL, call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
        contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE, user_id TEXT,
        title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '', ai_error TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT 'de', provider TEXT NOT NULL DEFAULT '', audio_file TEXT NOT NULL DEFAULT '', audio_bytes INTEGER NOT NULL DEFAULT 0,
        duration_s INTEGER NOT NULL DEFAULT 0, separated INTEGER NOT NULL DEFAULT 0, transcript TEXT NOT NULL DEFAULT '', utterances TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '', next_step TEXT NOT NULL DEFAULT '', action_items TEXT NOT NULL DEFAULT '[]', topics TEXT NOT NULL DEFAULT '[]',
        objections TEXT NOT NULL DEFAULT '[]', sentiment TEXT, metrics TEXT NOT NULL DEFAULT '{}', consent_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, analyzed_at TEXT
      );
      CREATE INDEX call_intel_loc ON call_intel(location_id, created_at);
      CREATE INDEX call_intel_contact ON call_intel(contact_id, created_at);
      CREATE UNIQUE INDEX call_intel_call ON call_intel(call_id) WHERE call_id IS NOT NULL;
      CREATE INDEX call_intel_open ON call_intel(status, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    registerTriggers(app, TRIGGERS);
    PURPOSES.call_intel = 'Gesprächsanalyse';
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.workflowTriggerFilters = { ...(app.services.workflowTriggerFilters ?? {}), 'call.analyzed': (c: any, d: any) => !c.sentiment || c.sentiment === d.sentiment };

    // --- settings -------------------------------------------------------------------------------------------------------
    const settingsOf = (locationId: string): IntelSettings => ({ ...DEFAULT_INTEL, ...(parseJson(db.get<any>('SELECT data FROM call_intel_settings WHERE location_id = ?', locationId), ['data'])?.data ?? {}) });
    const cleanSettings = (b: any, cur: IntelSettings, locationId: string): IntelSettings => {
      const s: IntelSettings = { ...cur };
      for (const k of ['auto_calls', 'auto_tasks', 'ai', 'timeline', 'channel_swap'] as const) if (b[k] !== undefined) s[k] = !!b[k];
      if (b.min_seconds !== undefined) s.min_seconds = Math.min(Math.max(Math.round(num(b.min_seconds, 30)), 5), 3600);
      if (b.retention_days !== undefined) s.retention_days = Math.min(Math.max(Math.round(num(b.retention_days, 0)), 0), 3650);
      if (b.language !== undefined) {
        const l = String(b.language).trim().toLowerCase();
        if (!/^[a-z]{2}(-[a-z]{2})?$/.test(l)) throw bad('Sprache als Kürzel (z. B. de oder en)');
        s.language = l;
      }
      if (b.stt_connection_id !== undefined) s.stt_connection_id = str(b.stt_connection_id, 'Transkriptions-Verbindung', { max: 64 });
      if (b.glossary !== undefined) s.glossary = str(b.glossary, 'Begriffe', { max: 500 });
      if (b.fillers !== undefined) {
        if (!Array.isArray(b.fillers)) throw bad('Füllwörter als Liste');
        s.fillers = [...new Set(b.fillers.map((f: unknown) => String(f).trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 50) as string[];
      }
      if (b.default_scorecard_id !== undefined) {
        const sid = str(b.default_scorecard_id, 'Scorecard', { max: 64 });
        if (sid && !db.get('SELECT 1 FROM call_scorecards WHERE id = ? AND location_id = ?', sid, locationId)) throw bad('Scorecard nicht gefunden');
        s.default_scorecard_id = sid;
      }
      return s;
    };
    const aiProblem = (locationId: string): string | null => (app.services.aiReady ? (app.services.aiReady(locationId) as string | null) : 'Das Modul KI-Assistent fehlt.');
    router.get('/api/call-intel/settings', 'location', (ctx) => {
      const s = settingsOf(ctx.locationId);
      const stt = app.services.aiConnections?.list?.(ctx.locationId, 'stt');
      return { settings: s, ai_problem: aiProblem(ctx.locationId), stt_ready: Array.isArray(stt) ? stt.length > 0 : false, stt_connections: Array.isArray(stt) ? stt.map((c: any) => ({ id: c.id, label: c.label, provider: c.provider })) : [], scorecards: db.all('SELECT id, name FROM call_scorecards WHERE location_id = ? ORDER BY name', ctx.locationId), fillers: FILLERS };
    });
    router.put('/api/call-intel/settings', 'location', (ctx) => {
      const next = cleanSettings(ctx.body ?? {}, settingsOf(ctx.locationId), ctx.locationId);
      db.run('INSERT INTO call_intel_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', ctx.locationId, JSON.stringify(next), now());
      return { settings: next };
    });

    // --- rows -------------------------------------------------------------------------------------------------------------
    const row = (locationId: string, key: string): IntelRow | undefined => parseJson(db.get<any>('SELECT * FROM call_intel WHERE id = ? AND location_id = ?', key, locationId), JSON_COLS);
    const userName = (uid: string | null) => (uid ? (db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', uid)?.name ?? '') : '');
    const out = (r: IntelRow, full = false) => {
      const c = r.contact_id ? getContact(app, r.location_id, r.contact_id) : undefined;
      const base = {
        id: r.id,
        source: r.source,
        call_id: r.call_id,
        contact_id: r.contact_id,
        contact_name: c ? contactName(c) : '',
        user_id: r.user_id,
        user_name: userName(r.user_id),
        title: r.title,
        status: r.status,
        error: r.error,
        ai_error: r.ai_error,
        language: r.language,
        provider: r.provider,
        duration_s: r.duration_s,
        separated: !!r.separated,
        summary: r.summary,
        next_step: r.next_step,
        sentiment: r.sentiment,
        topics: r.topics,
        objections: r.objections,
        action_items: r.action_items,
        metrics: r.metrics,
        has_audio: !!r.audio_file,
        created_at: r.created_at,
        analyzed_at: r.analyzed_at,
      };
      return full ? { ...base, transcript: r.transcript, utterances: r.utterances, consent_note: r.consent_note } : base;
    };

    // --- callSummaries: what other modules (timeline of deals, reports) read -----------------------------------------------
    const listeners: ((s: Record<string, unknown>) => void)[] = [];
    const summaryOf = (r: IntelRow) => ({ id: r.id, source: r.source, call_id: r.call_id, contact_id: r.contact_id, user_id: r.user_id, title: r.title, summary: r.summary, next_step: r.next_step, sentiment: r.sentiment?.overall ?? '', sentiment_score: r.sentiment?.score ?? 0, topics: r.topics, action_items: r.action_items, created_at: r.created_at, analyzed_at: r.analyzed_at });
    app.services.callSummaries = {
      list: (locationId: string, o: { contactId?: string; limit?: number } = {}) =>
        db
          .all<any>(`SELECT * FROM call_intel WHERE location_id = ? AND status = 'done' AND summary <> '' ${o.contactId ? 'AND contact_id = ?' : ''} ORDER BY created_at DESC LIMIT ?`, locationId, ...(o.contactId ? [o.contactId] : []), Math.min(o.limit ?? 20, 200))
          .map((r) => summaryOf(parseJson(r, JSON_COLS))),
      get: (locationId: string, intelId: string) => {
        const r = row(locationId, intelId);
        return r && r.status === 'done' ? summaryOf(r) : undefined;
      },
      /** `fn(summary)` runs after every finished analysis (the deal timeline of the sales module can attach it). */
      subscribe: (fn: (s: Record<string, unknown>) => void) => void listeners.push(fn),
    };

    // --- the pipeline -----------------------------------------------------------------------------------------------------
    const running = new Set<Promise<void>>();
    const kick = (intelId: string) => {
      const p: Promise<void> = processRow(intelId)
        .catch((e) => console.error('[call-intel]', (e as Error).message))
        .finally(() => running.delete(p));
      running.add(p);
    };
    const setRow = (intelId: string, patch: Record<string, unknown>) => void db.update('call_intel', intelId, patch);

    const channelRoles = (direction: string, swap: boolean): ['agent' | 'customer', 'agent' | 'customer'] => {
      // Twilio's first channel is the leg that placed the Dial (the caller of an inbound call, the agent's own phone/browser of an outbound one).
      const first: 'agent' | 'customer' = direction === 'in' ? 'customer' : 'agent';
      const a: ['agent' | 'customer', 'agent' | 'customer'] = first === 'agent' ? ['agent', 'customer'] : ['customer', 'agent'];
      return swap ? [a[1], a[0]] : a;
    };

    async function recordingOf(locationId: string, call: Record<string, any>): Promise<Buffer> {
      const cfg = telephonyConfig(app, locationId);
      if (!call.recording_sid || !cfg.accountSid || !cfg.token) throw new HttpError(409, 'Zu diesem Anruf gibt es keine abrufbare Aufnahme');
      const fetcher: typeof fetch = app.services.twilioFetch ?? fetch;
      const stereo = Number(call.recording_channels) >= 2;
      const r = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Recordings/${call.recording_sid}.${stereo ? 'wav?RequestedChannels=2' : 'mp3'}`, {
        headers: { authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.token}`).toString('base64')}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new HttpError(502, `Aufnahme bei Twilio nicht abrufbar (HTTP ${r.status})`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new HttpError(502, 'Die Aufnahme ist leer');
      return buf;
    }

    interface Heard {
      text: string;
      utterances: { speaker: string; text: string }[];
      separated: boolean;
      talk: ReturnType<typeof talkStats> | null;
      roles: ['agent' | 'customer', 'agent' | 'customer'] | null;
      provider: string;
      seconds: number;
    }

    /** Audio → text. Stereo WAV: each side on its own (speakers exact, talk time from the audio); anything else: one transcript. */
    async function hear(locationId: string, r: IntelRow, audio: Buffer, direction: string, s: IntelSettings): Promise<Heard> {
      const common = { locationId, language: r.language || s.language, vocabulary: s.glossary || undefined, connectionId: s.stt_connection_id || null };
      const wav = sniff(audio, 'audio/') === 'audio/wav' ? splitChannels(audio) : null;
      if (wav && wav.pcm.length === 2) {
        const roles = channelRoles(direction, s.channel_swap);
        const texts: string[] = [];
        let provider = '';
        for (const pcm of wav.pcm) {
          const parts: string[] = [];
          for (const chunk of wavChunks(pcm, wav.rate)) {
            const t = await transcribe(app, { ...common, audio: chunk, hint: 'audio/wav' });
            provider = t.provider;
            if (t.text) parts.push(t.text);
          }
          texts.push(parts.join(' ').trim());
        }
        const utterances: { speaker: string; text: string }[] = roles.map((role, i) => ({ speaker: role as string, text: texts[i] })).filter((u) => u.text);
        const label = (sp: string) => (sp === 'customer' ? 'Kunde' : 'Mitarbeiter');
        const talk = talkStats(wav.pcm, wav.rate);
        const ordered = ['customer', 'agent'].flatMap((sp) => utterances.filter((u) => u.speaker === sp));
        return { text: ordered.map((u) => `${label(u.speaker)}: ${u.text}`).join('\n'), utterances, separated: true, talk, roles, provider, seconds: Math.round(talk.total_ms / 1000) };
      }
      if (audio.length > MAX_STT_BYTES) throw new HttpError(413, `Die Aufnahme ist größer als ${Math.round(MAX_STT_BYTES / 1024 / 1024)} MB – bitte in kleinere Teile aufteilen oder als WAV hochladen`);
      const t = await transcribe(app, { ...common, audio, hint: sniff(audio, 'audio/') });
      return { text: t.text, utterances: [], separated: false, talk: null, roles: null, provider: t.provider, seconds: 0 };
    }

    /** The counted part of an analysis: no AI needed. */
    function measure(text: string, utterances: { speaker: string; text: string }[], heard: Pick<Heard, 'talk' | 'roles'> | null, s: IntelSettings, language: string) {
      const list = [...(FILLERS[language.slice(0, 2)] ?? FILLERS.de), ...s.fillers];
      const per100 = (n: number, w: number) => (w ? Math.round((n / w) * 1000) / 10 : 0);
      const side = (sp: string) => utterances.filter((u) => u.speaker === sp).map((u) => u.text).join(' ');
      // The speaker labels ("Kunde:") are not words of the conversation.
      const plain = utterances.length ? utterances.map((u) => u.text).join(' ') : text;
      const total = countFillers(plain, list);
      const words = wordCount(plain);
      const metrics: Record<string, any> = { words: { total: words }, fillers: { total: total.total, per_100: per100(total.total, words), by: total.by }, questions: { total: questionCount(plain) }, keywords: keywords(plain, 10) };
      if (utterances.length) {
        for (const sp of ['agent', 'customer']) {
          const t = side(sp);
          const w = wordCount(t);
          const f = countFillers(t, list);
          metrics.words[sp] = w;
          metrics.fillers[sp] = { total: f.total, per_100: per100(f.total, w) };
          metrics.questions[sp] = questionCount(t);
        }
      }
      if (heard?.talk && heard.roles) {
        const idx = (sp: string) => heard.roles!.indexOf(sp as 'agent' | 'customer');
        const a = heard.talk.talk_ms[idx('agent')] ?? 0;
        const c = heard.talk.talk_ms[idx('customer')] ?? 0;
        const sum = a + c;
        metrics.talk = {
          agent_ms: a,
          customer_ms: c,
          agent_pct: sum ? Math.round((a / sum) * 100) : 0,
          customer_pct: sum ? 100 - Math.round((a / sum) * 100) : 0,
          overlap_ms: heard.talk.overlap_ms,
          longest_agent_s: Math.round((heard.talk.longest_ms[idx('agent')] ?? 0) / 1000),
          longest_customer_s: Math.round((heard.talk.longest_ms[idx('customer')] ?? 0) / 1000),
          turns: heard.talk.turns,
        };
        metrics.wpm = { agent: a ? Math.round(metrics.words.agent / (a / 60000)) : 0, customer: c ? Math.round(metrics.words.customer / (c / 60000)) : 0 };
      }
      return metrics;
    }

    /** Summary, action items, topics and sentiment from the AI assistant; on failure the counted metrics and the word-list sentiment stay. */
    async function analyse(r: IntelRow, s: IntelSettings, transcript: string, separated: boolean): Promise<{ analysis: Analysis | null; error: string }> {
      if (!s.ai) return { analysis: null, error: '' };
      const problem = aiProblem(r.location_id);
      if (problem || !app.services.aiRun) return { analysis: null, error: problem || 'KI-Assistent fehlt' };
      const loc = app.location(r.location_id)!;
      const contact = r.contact_id ? getContact(app, r.location_id, r.contact_id) : undefined;
      try {
        const res = await app.services.aiRun({
          locationId: r.location_id,
          purpose: 'call_intel',
          user: analysisPrompt({ transcript, separated, today: new Intl.DateTimeFormat('de-DE', { timeZone: loc.timezone, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date()) + ` (${ymdInTz(new Date(), loc.timezone)})`, contact: contactBlock(contact), kind: r.source === 'call' ? 'call' : 'meeting', language: r.language || s.language }),
          schema: ANALYSIS_SCHEMA,
          maxTokens: 3000,
          contactId: r.contact_id,
        });
        const parsed = parseAnalysis(res.text);
        return parsed.ok ? { analysis: parsed.value, error: '' } : { analysis: null, error: `Ungültige KI-Antwort: ${parsed.error}` };
      } catch (e) {
        return { analysis: null, error: (e as Error).message };
      }
    }

    /** After the analysis: timeline, tasks, trigger, the call log and the listeners. */
    function effects(r: IntelRow, s: IntelSettings) {
      const fresh = row(r.location_id, r.id)!;
      const loc = app.location(r.location_id)!;
      if (fresh.contact_id && s.timeline && fresh.summary) logActivity(app, r.location_id, fresh.contact_id, 'call.summary', `Gesprächsauswertung: ${fresh.title || 'Gespräch'} – ${fresh.summary.slice(0, 220)}`, { intelId: fresh.id, callId: fresh.call_id, sentiment: fresh.sentiment?.overall ?? '' });
      if (s.auto_tasks) fresh.action_items.forEach((a, i) => a.owner === 'agent' && makeTask(fresh, i, loc.timezone));
      // The call log and the conversation show the summary where nothing else was transcribed.
      if (fresh.call_id && fresh.summary) {
        const call = db.get<any>('SELECT * FROM calls WHERE id = ?', fresh.call_id);
        if (call && !call.transcription && call.status !== 'voicemail') {
          db.run('UPDATE calls SET transcription = ?, updated_at = ? WHERE id = ?', `Zusammenfassung: ${fresh.summary}`.slice(0, 1000), now(), call.id);
          syncMessage(app, db.get('SELECT * FROM calls WHERE id = ?', call.id)!);
        }
      }
      const last = row(r.location_id, r.id)!;
      app.events.emit(r.location_id, 'call.analyzed', { contactId: last.contact_id ?? undefined, callId: last.call_id, intelId: last.id, source: last.source, title: last.title, summary: last.summary, next_step: last.next_step, sentiment: last.sentiment?.overall ?? '', topics: last.topics, action_items: last.action_items });
      for (const fn of listeners) {
        try {
          fn(summaryOf(last));
        } catch (e) {
          console.error('[call-intel] listener', (e as Error).message);
        }
      }
      if (s.default_scorecard_id && s.ai && !aiProblem(r.location_id)) void app.services.callScorecards?.score(r.location_id, r.id, s.default_scorecard_id).catch(() => undefined);
    }

    const makeTask = (r: IntelRow, index: number, tz: string): string | null => {
      const item = r.action_items[index];
      if (!item || item.task_id) return item?.task_id ?? null;
      const taskId = id();
      db.insert('tasks', {
        id: taskId,
        location_id: r.location_id,
        contact_id: r.contact_id,
        title: item.title.slice(0, 200),
        description: `Aus der Gesprächsauswertung „${r.title || 'Gespräch'}“.${r.next_step ? `\nNächster Schritt: ${r.next_step}` : ''}`.slice(0, 4000),
        due_at: item.due ? zonedToUtc(item.due, '09:00', tz).toISOString() : now(),
        assigned_to: r.user_id,
        done: 0,
        created_at: now(),
      });
      const items = r.action_items.map((a, i) => (i === index ? { ...a, task_id: taskId } : a));
      setRow(r.id, { action_items: items });
      r.action_items = items;
      return taskId;
    };

    async function processRow(intelId: string): Promise<void> {
      const r0 = db.get<any>('SELECT * FROM call_intel WHERE id = ?', intelId);
      if (!r0) return;
      const r = parseJson(r0, JSON_COLS) as IntelRow;
      const s = settingsOf(r.location_id);
      try {
        let text = r.transcript;
        let utterances = r.utterances;
        let separated = !!r.separated;
        let heard: Heard | null = null;
        if (r.source !== 'text') {
          setRow(r.id, { status: 'transcribing', error: '' });
          let audio: Buffer;
          let direction = 'in';
          if (r.source === 'call') {
            const call = db.get<any>('SELECT * FROM calls WHERE id = ?', r.call_id ?? '');
            if (!call) throw new HttpError(404, 'Der Anruf existiert nicht mehr');
            direction = call.direction;
            audio = await recordingOf(r.location_id, call);
          } else {
            const path = join(callIntelDir(app), r.audio_file);
            if (!r.audio_file || !existsSync(path)) throw new HttpError(404, 'Die hochgeladene Aufnahme fehlt auf dem Server');
            audio = readFileSync(path);
          }
          heard = await hear(r.location_id, r, audio, direction, s);
          if (!heard.text.trim()) throw new HttpError(422, 'In der Aufnahme wurde keine Sprache erkannt');
          text = heard.text;
          utterances = heard.utterances;
          separated = heard.separated;
          setRow(r.id, { transcript: text, utterances, separated: separated ? 1 : 0, provider: heard.provider, duration_s: r.duration_s || heard.seconds, audio_bytes: audio.length });
        }
        setRow(r.id, { status: 'analyzing' });
        const language = r.language || s.language;
        const metrics = measure(text, utterances, heard, s, language);
        const { analysis, error } = await analyse(r, s, text, separated);
        const customerText = utterances.filter((u) => u.speaker === 'customer').map((u) => u.text).join(' ');
        const local = sentimentOf(separated && customerText ? customerText : text);
        setRow(r.id, {
          status: 'done',
          title: r.title || analysis?.title || (r.source === 'call' ? 'Telefonat' : 'Gespräch'),
          summary: analysis?.summary ?? '',
          next_step: analysis?.next_step ?? '',
          action_items: analysis?.action_items ?? [],
          topics: analysis?.topics?.length ? analysis.topics : metrics.keywords.slice(0, 6),
          objections: analysis?.objections ?? [],
          sentiment: analysis?.sentiment ?? { overall: local.label, score: local.score, customer: separated ? local.label : '', agent: '' },
          metrics,
          ai_error: error.slice(0, 300),
          error: '',
          analyzed_at: now(),
        });
        // The audio is not kept: it was only needed for the transcript.
        if (r.source === 'upload' && r.audio_file) {
          rmSync(join(callIntelDir(app), r.audio_file), { force: true });
          setRow(r.id, { audio_file: '' });
        }
        effects(r, s);
      } catch (e) {
        const he = e instanceof HttpError ? e : asHttp(e);
        setRow(r.id, { status: 'failed', error: he.message.slice(0, 400) });
      }
    }

    const enqueue = (r: Partial<IntelRow> & { location_id: string; source: IntelRow['source'] }): string => {
      const rid = id();
      db.insert('call_intel', { id: rid, status: 'queued', language: settingsOf(r.location_id).language, created_at: now(), title: '', ...r, utterances: r.utterances ?? [], action_items: [], topics: [], objections: [], metrics: {} });
      kick(rid);
      return rid;
    };

    /** A recorded conversation: analysed automatically when the sub-account switched that on. Returns the row's id. */
    const enqueueCall = (locationId: string, callId: string, o: { force?: boolean; userId?: string | null } = {}): string | null => {
      const call = db.get<any>('SELECT * FROM calls WHERE id = ? AND location_id = ?', callId, locationId);
      if (!call?.recording_sid) return null;
      const exists = db.get<{ id: string }>('SELECT id FROM call_intel WHERE call_id = ?', callId);
      if (exists) return exists.id;
      const s = settingsOf(locationId);
      if (!o.force && (!s.auto_calls || (call.recording_duration ?? 0) < s.min_seconds)) return null;
      return enqueue({ location_id: locationId, source: 'call', call_id: callId, contact_id: call.contact_id ?? null, user_id: call.user_id ?? o.userId ?? null, duration_s: call.recording_duration ?? 0 });
    };
    app.events.on('call.recorded', (e) => {
      if (e.data.voicemail || !e.data.callId) return;
      enqueueCall(e.locationId, e.data.callId);
    });
    app.services.callIntel = { enqueueCall, idle: async () => { while (running.size) await Promise.allSettled([...running]); } };

    // --- API: analyses ------------------------------------------------------------------------------------------------------
    router.get('/api/call-intel', 'location', (ctx) => {
      const where = ['i.location_id = ?'];
      const params: any[] = [ctx.locationId];
      for (const [k, col] of [['contact_id', 'i.contact_id'], ['status', 'i.status'], ['source', 'i.source'], ['user_id', 'i.user_id']] as const) {
        const v = ctx.query.get(k);
        if (v) (where.push(`${col} = ?`), params.push(v));
      }
      const sentiment = ctx.query.get('sentiment');
      if (sentiment) (where.push(`json_extract(i.sentiment, '$.overall') = ?`), params.push(sentiment));
      const q = (ctx.query.get('q') ?? '').trim();
      if (q) (where.push(`(i.title || ' ' || i.summary || ' ' || i.transcript) LIKE ?`), params.push(`%${q}%`));
      const from = ctx.query.get('from');
      const to = ctx.query.get('to');
      if (from && /^\d{4}-\d\d-\d\d/.test(from)) (where.push('i.created_at >= ?'), params.push(from));
      if (to && /^\d{4}-\d\d-\d\d/.test(to)) (where.push('i.created_at < ?'), params.push(`${to}T23:59:59.999Z`));
      const limit = Math.min(Math.max(1, num(ctx.query.get('limit'), 50)), 200);
      const rows = db.all<any>(`SELECT i.* FROM call_intel i WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT ?`, ...params, limit);
      return { items: rows.map((r) => out(parseJson(r, JSON_COLS))), open: db.get<{ n: number }>(`SELECT COUNT(*) n FROM call_intel WHERE location_id = ? AND status IN ('queued', 'transcribing', 'analyzing')`, ctx.locationId)!.n };
    });

    router.get('/api/call-intel/stats', 'location', (ctx) => {
      const days = Math.min(Math.max(1, num(ctx.query.get('days'), 30)), 365);
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const rows = db.all<any>(`SELECT * FROM call_intel WHERE location_id = ? AND status = 'done' AND created_at >= ? ORDER BY created_at DESC LIMIT 5000`, ctx.locationId, since).map((r) => parseJson(r, JSON_COLS) as IntelRow);
      const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
      const sent: Record<string, number> = {};
      const topics = new Map<string, number>();
      const agents = new Map<string, { n: number; talk: number[]; fillers: number[]; score: number[]; sentiment: number[] }>();
      const talk: number[] = [];
      const fillers: number[] = [];
      const scores = db.all<{ intel_id: string; final_total: number | null }>(`SELECT s.intel_id, s.final_total FROM call_scores s JOIN call_intel i ON i.id = s.intel_id WHERE i.location_id = ? AND i.created_at >= ?`, ctx.locationId, since);
      const scoreOf = new Map<string, number[]>();
      for (const s of scores) if (s.final_total !== null) scoreOf.set(s.intel_id, [...(scoreOf.get(s.intel_id) ?? []), s.final_total]);
      for (const r of rows) {
        const o = r.sentiment?.overall ?? 'neutral';
        sent[o] = (sent[o] ?? 0) + 1;
        for (const t of r.topics) topics.set(t.toLowerCase(), (topics.get(t.toLowerCase()) ?? 0) + 1);
        const a = agents.get(r.user_id ?? '') ?? { n: 0, talk: [], fillers: [], score: [], sentiment: [] };
        a.n++;
        if (r.metrics?.talk) (talk.push(r.metrics.talk.agent_pct), a.talk.push(r.metrics.talk.agent_pct));
        if (r.metrics?.fillers) (fillers.push(r.metrics.fillers.per_100), a.fillers.push(r.metrics.fillers.agent?.per_100 ?? r.metrics.fillers.per_100));
        a.score.push(...(scoreOf.get(r.id) ?? []));
        if (r.sentiment) a.sentiment.push(r.sentiment.score);
        agents.set(r.user_id ?? '', a);
      }
      return {
        days,
        analysed: rows.length,
        open: db.get<{ n: number }>(`SELECT COUNT(*) n FROM call_intel WHERE location_id = ? AND status IN ('queued', 'transcribing', 'analyzing')`, ctx.locationId)!.n,
        failed: db.get<{ n: number }>(`SELECT COUNT(*) n FROM call_intel WHERE location_id = ? AND status = 'failed' AND created_at >= ?`, ctx.locationId, since)!.n,
        avg_duration_s: avg(rows.map((r) => r.duration_s).filter(Boolean)),
        avg_agent_talk_pct: avg(talk),
        avg_fillers_per_100: avg(fillers),
        avg_sentiment: avg(rows.map((r) => r.sentiment?.score ?? 0)),
        sentiment: sent,
        topics: [...topics].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([topic, n]) => ({ topic, n })),
        agents: [...agents].map(([uid, a]) => ({ user_id: uid || null, name: uid ? userName(uid) : '(unbekannt)', calls: a.n, avg_agent_talk_pct: avg(a.talk), avg_fillers_per_100: avg(a.fillers), avg_score: avg(a.score), avg_sentiment: avg(a.sentiment) })).sort((a, b) => b.calls - a.calls),
      };
    });

    /** For the picker next to a conversation: the active scorecards (everybody who may open the analyses may pre-score). */
    router.get('/api/call-intel/scorecards', 'location', (ctx) => db.all('SELECT id, name, description FROM call_scorecards WHERE location_id = ? AND active = 1 ORDER BY name', ctx.locationId));

    router.get('/api/call-intel/by-call/:callId', 'location', (ctx) => {
      const r = parseJson(db.get<any>('SELECT * FROM call_intel WHERE call_id = ? AND location_id = ?', ctx.params.callId, ctx.locationId), JSON_COLS) as IntelRow | undefined;
      return r ? out(r) : { id: null };
    });

    // Raw audio for the upload (up to the size the speech provider takes).
    const prev = app.services.rawBodyLimit;
    app.services.rawBodyLimit = (method: string, path: string, req: any, cookies: Record<string, string>): number | undefined =>
      method === 'POST' && path === '/api/call-intel/upload' && (cookies.pghl_session || req.headers.authorization) ? MAX_STT_BYTES + 1024 : prev?.(method, path, req, cookies);

    const hits = new Map<string, number[]>();
    const throttle = (ctx: Ctx) => {
      const key = ctx.user?.id ?? ctx.ip;
      const t0 = Date.now();
      const list = (hits.get(key) ?? []).filter((x) => t0 - x < 60_000);
      if (list.length >= 12) throw new HttpError(429, 'Zu viele Uploads – bitte eine Minute warten');
      list.push(t0);
      hits.set(key, list);
    };
    const contactOf = (ctx: Ctx, key: unknown) => {
      const cid = String(key ?? '').trim();
      if (!cid) return null;
      if (!getContact(app, ctx.locationId, cid)) throw bad('Kontakt nicht gefunden');
      return cid;
    };
    const consentGiven = (v: unknown) => v === true || v === '1' || v === 'true';

    /** A meeting recording: raw audio in the body (`?title=&contact_id=&language=&consent=1`). All participants must have agreed. */
    router.post('/api/call-intel/upload', 'location', (ctx) => {
      throttle(ctx);
      const audio = ctx.rawBuffer;
      if (!audio?.length) throw bad('Aufnahme fehlt');
      if (!consentGiven(ctx.query.get('consent'))) throw bad('Bitte bestätigen, dass alle Beteiligten der Aufzeichnung zugestimmt haben (§ 201 StGB, DSGVO)');
      if (audio.length > MAX_STT_BYTES) throw new HttpError(413, `Aufnahme ist zu groß (höchstens ${Math.round(MAX_STT_BYTES / 1024 / 1024)} MB)`);
      const mime = sniff(audio, 'audio/');
      if (!mime.startsWith('audio/')) throw bad('Das ist keine Audioaufnahme (erlaubt: MP3, WAV, M4A, WebM, Ogg, FLAC)');
      const ext = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/flac': 'flac', 'audio/aac': 'aac' }[mime] ?? 'bin';
      mkdirSync(callIntelDir(app), { recursive: true });
      const file = `${id(24)}.${ext}`;
      writeFileSync(join(callIntelDir(app), file), audio);
      const language = (ctx.query.get('language') ?? '').trim().toLowerCase();
      const rid = enqueue({
        location_id: ctx.locationId,
        source: 'upload',
        title: str(ctx.query.get('title'), 'Titel', { max: 120 }),
        contact_id: contactOf(ctx, ctx.query.get('contact_id')),
        user_id: ctx.user?.id ?? null,
        audio_file: file,
        audio_bytes: audio.length,
        language: /^[a-z]{2}(-[a-z]{2})?$/.test(language) ? language : settingsOf(ctx.locationId).language,
        consent_note: `Zustimmung aller Beteiligten bestätigt von ${ctx.user?.name ?? 'API'} am ${now()}`,
      });
      return out(row(ctx.locationId, rid)!);
    });

    /** A transcript that exists already (Teams, Zoom, Meet): analysed like a recording, without audio. */
    router.post('/api/call-intel/text', 'location', (ctx) => {
      throttle(ctx);
      const b = ctx.body ?? {};
      const transcript = str(b.transcript, 'Transkript', { required: true, max: 200_000 });
      if (wordCount(transcript) < 20) throw bad('Das Transkript ist zu kurz für eine Auswertung (mindestens 20 Wörter)');
      const rid = enqueue({ location_id: ctx.locationId, source: 'text', title: str(b.title, 'Titel', { max: 120 }), contact_id: contactOf(ctx, b.contact_id), user_id: ctx.user?.id ?? null, transcript, language: String(b.language ?? '').toLowerCase().slice(0, 5) || settingsOf(ctx.locationId).language });
      return out(row(ctx.locationId, rid)!);
    });

    /** Analyse a recorded call on demand (also when the automatic analysis is off). */
    router.post('/api/call-intel/calls/:callId/analyze', 'location', (ctx) => {
      const call = db.get<any>('SELECT * FROM calls WHERE id = ? AND location_id = ?', ctx.params.callId, ctx.locationId);
      if (!call) throw notFound('Anruf nicht gefunden');
      if (!call.recording_sid) throw bad('Zu diesem Anruf gibt es keine Aufnahme');
      const existing = db.get<{ id: string; status: string }>('SELECT id, status FROM call_intel WHERE call_id = ?', call.id);
      if (existing && existing.status !== 'failed') return out(row(ctx.locationId, existing.id)!);
      if (existing) db.run('DELETE FROM call_intel WHERE id = ?', existing.id);
      const rid = enqueueCall(ctx.locationId, call.id, { force: true, userId: ctx.user?.id ?? null });
      return out(row(ctx.locationId, rid!)!);
    });

    router.get('/api/call-intel/:id', 'location', (ctx) => {
      const r = row(ctx.locationId, ctx.params.id);
      if (!r) throw notFound('Auswertung nicht gefunden');
      return out(r, true);
    });
    router.patch('/api/call-intel/:id', 'location', (ctx) => {
      const r = row(ctx.locationId, ctx.params.id);
      if (!r) throw notFound('Auswertung nicht gefunden');
      const patch: Record<string, unknown> = {};
      if (ctx.body?.title !== undefined) patch.title = str(ctx.body.title, 'Titel', { max: 120 });
      if (ctx.body?.contact_id !== undefined) patch.contact_id = contactOf(ctx, ctx.body.contact_id);
      db.update('call_intel', r.id, patch);
      return out(row(ctx.locationId, r.id)!, true);
    });
    /** Runs the analysis again: after a failed run, with another provider or after the AI assistant was set up. */
    router.post('/api/call-intel/:id/retry', 'location', (ctx) => {
      const r = row(ctx.locationId, ctx.params.id);
      if (!r) throw notFound('Auswertung nicht gefunden');
      if (['queued', 'transcribing', 'analyzing'].includes(r.status)) throw bad('Die Auswertung läuft noch');
      if (r.source === 'upload' && !r.audio_file && !r.transcript) throw bad('Die Aufnahme wurde nach der Auswertung gelöscht – bitte neu hochladen');
      // With a transcript at hand only the analysis is repeated.
      setRow(r.id, { status: 'queued', error: '', ai_error: '', ...(r.transcript && r.source !== 'call' ? {} : { transcript: '', utterances: [] }) });
      kick(r.id);
      return out(row(ctx.locationId, r.id)!);
    });
    router.delete('/api/call-intel/:id', 'location', (ctx) => {
      const r = row(ctx.locationId, ctx.params.id);
      if (!r) throw notFound('Auswertung nicht gefunden');
      if (r.audio_file) rmSync(join(callIntelDir(app), r.audio_file), { force: true });
      db.run('DELETE FROM call_intel WHERE id = ?', r.id);
      return { ok: true };
    });

    router.post('/api/call-intel/:id/action-items/:n/task', 'location', (ctx) => {
      const r = row(ctx.locationId, ctx.params.id);
      if (!r) throw notFound('Auswertung nicht gefunden');
      const i = Math.round(num(ctx.params.n, -1));
      if (!r.action_items[i]) throw notFound('Aufgabe nicht gefunden');
      const taskId = makeTask(r, i, app.location(ctx.locationId)!.timezone);
      return { ok: true, task_id: taskId, items: row(ctx.locationId, r.id)!.action_items };
    });
    router.patch('/api/call-intel/:id/action-items/:n', 'location', (ctx) => {
      const r = row(ctx.locationId, ctx.params.id);
      if (!r) throw notFound('Auswertung nicht gefunden');
      const i = Math.round(num(ctx.params.n, -1));
      if (!r.action_items[i]) throw notFound('Aufgabe nicht gefunden');
      setRow(r.id, { action_items: r.action_items.map((a, k) => (k === i ? { ...a, done: !!ctx.body?.done } : a)) });
      return { items: row(ctx.locationId, r.id)!.action_items };
    });

    // --- housekeeping -------------------------------------------------------------------------------------------------------
    // Analyses that were interrupted by a restart start again; the retention period of each sub-account is applied once an hour.
    let last = 0;
    app.onTick(() => {
      if (Date.now() - last < 3600_000) return;
      last = Date.now();
      for (const r of db.all<{ id: string }>(`SELECT id FROM call_intel WHERE status IN ('queued', 'transcribing', 'analyzing') AND created_at < ? LIMIT 20`, new Date(Date.now() - 10 * 60_000).toISOString())) kick(r.id);
      for (const { location_id } of db.all<{ location_id: string }>('SELECT DISTINCT location_id FROM call_intel')) {
        const days = settingsOf(location_id).retention_days;
        if (!days) continue;
        const before = new Date(Date.now() - days * 864e5).toISOString();
        for (const r of db.all<{ id: string; audio_file: string }>('SELECT id, audio_file FROM call_intel WHERE location_id = ? AND created_at < ? LIMIT 500', location_id, before)) {
          if (r.audio_file) rmSync(join(callIntelDir(app), r.audio_file), { force: true });
          db.run('DELETE FROM call_intel WHERE id = ?', r.id);
        }
      }
    });

    // A deleted or erased contact takes the stored audio of its uploads with it (the rows go with the contact).
    app.services.contactFiles = [
      ...(app.services.contactFiles ?? []),
      (_a: App, loc: string, cid: string) => db.all<{ audio_file: string }>(`SELECT audio_file FROM call_intel WHERE location_id = ? AND contact_id = ? AND audio_file <> ''`, loc, cid).map((r) => join(callIntelDir(app), r.audio_file.replace(/[^\w.-]/g, ''))),
    ];
  },
};
