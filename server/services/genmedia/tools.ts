import type { App } from '../../core/app.js';
import { render } from '../../core/template.js';
import type { Caller, Tool } from '../../modules/mcp.js';
import { createJob, kick } from './engine.js';
import { sleep } from './http.js';

/**
 * MCP tools (thin relays onto /api/genmedia – same scoping, checks and audit log as the UI; the
 * in-app agent picks them up from app.services.mcpTools) and the workflow actions
 * „KI-Bild generieren“, „KI-Video generieren“ and „Text in Sprache“.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects; mit einem Sub-Account-Schlüssel optional)' } };
const COMMON = {
  connection_id: { type: 'string', description: 'KI-Verbindung (BYOK) – leer = Standard des Sub-Accounts für diese Art' },
  model: { type: 'string', description: 'Modell-ID des Anbieters, z. B. fal-ai/flux/dev, google/nano-banana, gpt-image-1, veo-3.1-generate-preview' },
  params: { type: 'object', description: 'Rohe Anbieter-Parameter, werden zuletzt übernommen' },
  wait_seconds: { type: 'integer', minimum: 0, maximum: 120, description: 'So lange auf das Ergebnis warten (sonst später ghl_get_media_job)' },
};
const W = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

/** Starts a job and waits up to `wait` seconds for it. */
async function startAndWait(call: Caller, a: Record<string, any>, body: Record<string, any>, waitDefault: number) {
  const job = await call.api('POST', '/api/genmedia/jobs', { location: a.location_id, body: { ...body, source: 'mcp', library: true } });
  return waitFor(call, a.location_id, job, Math.max(0, Math.min(120, Number(a.wait_seconds ?? waitDefault) || 0)));
}

async function waitFor(call: Caller, location: string | undefined, job: any, seconds: number) {
  const until = Date.now() + seconds * 1000;
  let cur = job;
  while (!['succeeded', 'failed', 'canceled'].includes(cur.status) && Date.now() < until) {
    await sleep(1500);
    cur = await call.api('GET', `/api/genmedia/jobs/${encodeURIComponent(cur.id)}`, { location });
  }
  return summary(cur);
}

function summary(j: any) {
  return {
    job_id: j.id,
    status: j.status,
    capability: j.capability,
    provider: j.provider,
    model: j.model,
    url: j.url,
    files: (j.results ?? []).map((r: any) => ({ url: r.library_url ?? r.url, mime: r.mime, upload_id: r.upload_id })),
    text: j.text ?? undefined,
    cost: j.cost ?? undefined,
    error: j.error ?? undefined,
    hint: j.status === 'queued' || j.status === 'running' ? 'Läuft noch – später mit ghl_get_media_job abfragen.' : undefined,
  };
}

export const GENMEDIA_TOOLS: Tool[] = [
  {
    name: 'ghl_generate_image',
    title: 'KI-Bild generieren',
    description: 'Erzeugt ein Bild mit dem verbundenen KI-Anbieter des Sub-Accounts (BYOK: fal.ai, kie.ai, Replicate, OpenAI, Gemini, Stability, Runway, Luma oder eigene HTTP-Vorlage). Das Ergebnis landet in der Mediathek; url ist dauerhaft. Optional image_url als Referenz (Bild bearbeiten/Variante).',
    inputSchema: {
      type: 'object',
      properties: { ...LOC, prompt: { type: 'string' }, negative_prompt: { type: 'string' }, aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'] }, seed: { type: 'integer' }, image_url: { type: 'string', description: 'Referenzbild (https)' }, ...COMMON },
      required: ['prompt'],
    },
    annotations: W,
    run: (call, a) => startAndWait(call, a, { capability: 'image', prompt: a.prompt, negative_prompt: a.negative_prompt, aspect_ratio: a.aspect_ratio, seed: a.seed, image_url: a.image_url, connection_id: a.connection_id, model: a.model, params: a.params }, 60),
  },
  {
    name: 'ghl_generate_video',
    title: 'KI-Video generieren',
    description: 'Erzeugt ein kurzes Video (Text oder Bild zu Video, z. B. Veo, Kling, Sora, Runway, Luma) mit dem verbundenen KI-Anbieter. Dauert meist Minuten: ohne wait_seconds kommt sofort die job_id, später mit ghl_get_media_job abfragen.',
    inputSchema: {
      type: 'object',
      properties: { ...LOC, prompt: { type: 'string' }, negative_prompt: { type: 'string' }, aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'] }, duration: { type: 'integer', minimum: 1, maximum: 60, description: 'Sekunden' }, seed: { type: 'integer' }, image_url: { type: 'string', description: 'Startbild (https) für Bild zu Video' }, ...COMMON },
      required: ['prompt'],
    },
    annotations: W,
    run: (call, a) => startAndWait(call, a, { capability: 'video', prompt: a.prompt, negative_prompt: a.negative_prompt, aspect_ratio: a.aspect_ratio, duration: a.duration, seed: a.seed, image_url: a.image_url, connection_id: a.connection_id, model: a.model, params: a.params }, 0),
  },
  {
    name: 'ghl_generate_audio',
    title: 'KI-Audio erzeugen (Sprache oder Musik)',
    description: 'kind=tts: Text in Sprache (ElevenLabs, OpenAI, Gemini, fal …; voice = Stimmen-ID). kind=music: Musik/Sound aus einer Beschreibung (Suno über kie.ai, Eleven Music, Lyria, Stable Audio …; duration in Sekunden). Ergebnis als MP3/WAV in der Mediathek.',
    inputSchema: {
      type: 'object',
      properties: { ...LOC, kind: { type: 'string', enum: ['tts', 'music'] }, text: { type: 'string', description: 'tts: der Text; music: die Beschreibung' }, voice: { type: 'string' }, language: { type: 'string' }, duration: { type: 'integer', minimum: 1, maximum: 600 }, ...COMMON },
      required: ['kind', 'text'],
    },
    annotations: W,
    run: (call, a) => startAndWait(call, a, { capability: a.kind === 'music' ? 'audio_music' : 'audio_tts', prompt: a.text, voice: a.voice, language: a.language, duration: a.kind === 'music' ? a.duration : undefined, connection_id: a.connection_id, model: a.model, params: a.params }, 60),
  },
  {
    name: 'ghl_transcribe',
    title: 'Sprache in Text (Transkription)',
    description: 'Transkribiert eine Audio- oder Videodatei (https-Link oder Datei aus der Mediathek per upload_id) mit dem verbundenen Anbieter (OpenAI, ElevenLabs, Gemini, fal Wizper/Whisper, Replicate …).',
    inputSchema: {
      type: 'object',
      properties: { ...LOC, audio_url: { type: 'string' }, upload_id: { type: 'string', description: 'Datei aus der Mediathek' }, language: { type: 'string', description: 'z. B. de' }, prompt: { type: 'string', description: 'Fachbegriffe/Hinweise' }, ...COMMON },
    },
    annotations: W,
    run: (call, a) => startAndWait(call, a, { capability: 'stt', audio_url: a.audio_url, audio_upload_id: a.upload_id, language: a.language, prompt: a.prompt, connection_id: a.connection_id, model: a.model, params: a.params }, 90),
  },
  {
    name: 'ghl_get_media_job',
    title: 'KI-Medien-Auftrag abfragen',
    description: 'Status und Ergebnis (Datei-URLs, Text, Kosten, Fehler) eines KI-Medien-Auftrags; wait_seconds wartet bis zu 120 s auf das Ende.',
    inputSchema: { type: 'object', properties: { ...LOC, job_id: { type: 'string' }, wait_seconds: COMMON.wait_seconds }, required: ['job_id'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const job = await call.api('GET', `/api/genmedia/jobs/${encodeURIComponent(a.job_id)}`, { location: a.location_id });
      return waitFor(call, a.location_id, job, Math.max(0, Math.min(120, Number(a.wait_seconds ?? 0) || 0)));
    },
  },
];

// --- workflow actions -----------------------------------------------------------------------------------

const TARGET_TEXT: Record<string, string> = { field: 'eigenes Feld', note: 'Notiz am Kontakt', social_draft: 'Social-Entwurf', none: 'KI-Studio' };

function action(app: App, capability: 'image' | 'video' | 'audio_tts') {
  return async (run: any, step: any, vars: Record<string, any>) => {
    const prompt = render(String(capability === 'audio_tts' ? (step.text ?? step.prompt ?? '') : (step.prompt ?? '')), vars).trim();
    if (!prompt) throw new Error(capability === 'audio_tts' ? 'Text fehlt' : 'Prompt fehlt');
    const kind = ['field', 'note', 'social_draft'].includes(step.target) ? step.target : 'none';
    const target = kind === 'none' ? null : { type: kind, contactId: run.contact_id, field: step.field, integrationIds: Array.isArray(step.integration_ids) ? step.integration_ids : [], content: render(String(step.social_text ?? ''), vars) };
    const job = await createJob(app, {
      locationId: run.location_id,
      userId: null,
      source: 'workflow',
      target,
      body: { capability, prompt, connection_id: step.connection_id || undefined, model: step.model || undefined, aspect_ratio: step.aspect_ratio || undefined, duration: step.duration || undefined, voice: step.voice || undefined, params: step.params || undefined, library: true },
    });
    kick(app, job.id);
    return `gestartet (${job.model || job.provider}) – Ergebnis kommt in: ${TARGET_TEXT[kind]}`;
  };
}

export function workflowActions(app: App) {
  return { genmedia_image: action(app, 'image'), genmedia_video: action(app, 'video'), genmedia_tts: action(app, 'audio_tts') };
}
