import type { Tool } from './mcp.js';

/**
 * MCP tools of the voice layer ("Stimme"): the HyperLevel Agent, Claude and Codex can read and change the voice settings, list
 * voices, try one out and transcribe an audio file. Every tool is a thin relay onto the REST API (modules/voice.ts), so
 * permissions, validation and the audit log apply. Audio itself is never returned (too large for a model's context).
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const OUT = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const q = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};

const SETTINGS_SCHEMA = {
  type: 'object',
  description: 'Nur die Felder angeben, die sich ändern. tts: {connection_id, model, voice, language, speed 0.5–2, instructions}. stt: {connection_id, model, language}. phone: {engine "twilio"|"own", transport "auto"|"stream"|"turns", tts_connection_id, tts_model, tts_voice, stt_connection_id, stt_model, tts_ws, endpoint_ms 300–2500, barge_in, filler}. agent: {read_aloud, auto_send}. voicemail_transcribe, call_summary (Booleans).',
  additionalProperties: true,
};

export const VOICE_TOOLS: Tool[] = [
  {
    name: 'ghl_voice_get_settings',
    title: 'Stimme: Einstellungen',
    description:
      'Die Stimm-Einstellungen eines Sub-Accounts (Sprachausgabe, Spracherkennung, Telefonagent mit eigener Stimme oder Twilio-Stimme, Sprachsteuerung des Agenten) samt den verbundenen Anbietern, dem, was für den nächsten Anruf benutzt wird, Nutzung der letzten 30 Tage und Antwortzeiten.',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: RO,
    run: (call, a) => call.api('GET', '/api/voice/settings', { location: a.location_id }),
  },
  {
    name: 'ghl_voice_update_settings',
    title: 'Stimme: Einstellungen ändern',
    description: 'Ändert Stimm-Einstellungen (nur die genannten Felder). Verbindungen müssen unter Einstellungen → KI-Anbieter existieren. Gibt die neuen Einstellungen zurück.',
    inputSchema: obj({ ...LOC, settings: SETTINGS_SCHEMA }, ['location_id', 'settings']),
    annotations: W,
    run: (call, a) => call.api('PUT', '/api/voice/settings', { location: a.location_id, body: a.settings }),
  },
  {
    name: 'ghl_voice_list_voices',
    title: 'Stimme: verfügbare Stimmen',
    description: 'Stimmen des Sprachausgabe-Anbieters (live vom Anbieter oder eingebaute Liste), optional nach Sprache gefiltert (z. B. "de"). Jede Stimmen-ID kann bei Stimme eingetragen werden; freier Text ist immer erlaubt.',
    inputSchema: obj({ ...LOC, connection_id: { type: 'string', description: 'Verbindung (sonst die Standard-Zuordnung)' }, language: { type: 'string', description: 'Sprachkürzel, z. B. de oder de-DE' } }, ['location_id']),
    annotations: RO,
    run: (call, a) => call.api('GET', `/api/voice/voices${q({ connection_id: a.connection_id, language: a.language })}`, { location: a.location_id }),
  },
  {
    name: 'ghl_voice_test_voice',
    title: 'Stimme testen',
    description: 'Spricht einen kurzen Text mit der gewählten Stimme (kostet beim Anbieter ein paar Zeichen) und meldet, ob es geklappt hat: Anbieter, Modell, Stimme, Dauer. Das Audio selbst wird nicht zurückgegeben.',
    inputSchema: obj({ ...LOC, text: { type: 'string', description: 'Text (höchstens 300 Zeichen)' }, voice: { type: 'string' }, connection_id: { type: 'string' }, model: { type: 'string' }, language: { type: 'string' } }, ['location_id']),
    annotations: OUT,
    run: async (call, a) => {
      const { location_id, ...body } = a;
      const r = await call.api('POST', '/api/voice/test', { location: location_id as string, body });
      const { audio: _audio, ...rest } = r as Record<string, unknown>;
      return { ok: true, ...rest };
    },
  },
  {
    name: 'ghl_voice_transcribe',
    title: 'Audio in Text umwandeln',
    description: 'Transkribiert eine Audiodatei (Voicemail, Aufnahme) mit der Spracherkennung des Sub-Accounts. Entweder upload_id (Datei aus der Mediathek) oder url (öffentliche https-Adresse, höchstens 15 MB).',
    inputSchema: obj({ ...LOC, upload_id: { type: 'string', description: 'ID einer Datei der Mediathek' }, url: { type: 'string', description: 'https-Adresse der Audiodatei' }, language: { type: 'string', description: 'Sprachkürzel, Standard: de' }, vocabulary: { type: 'string', description: 'Namen und Begriffe, die erkannt werden sollen' } }, ['location_id']),
    annotations: OUT,
    run: (call, a) => {
      const { location_id, ...body } = a;
      return call.api('POST', '/api/voice/transcribe-url', { location: location_id as string, body });
    },
  },
  {
    name: 'ghl_voice_phone_latency',
    title: 'Stimme: Antwortzeiten am Telefon',
    description: 'Wie schnell der Telefonagent antwortet: Zusammenfassung (Median/95 % der Gesamtzeit, Spracherkennung, KI, Sprachausgabe, Unterbrechungen) und die letzten Gesprächsrunden.',
    inputSchema: obj({ ...LOC, limit: { type: 'integer', description: 'Wie viele Runden (Standard 60, höchstens 200)' } }, ['location_id']),
    annotations: RO,
    run: (call, a) => call.api('GET', `/api/voice/latency${q({ limit: a.limit })}`, { location: a.location_id }),
  },
];
