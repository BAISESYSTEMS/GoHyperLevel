import type { Module } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { DOC_KINDS } from './docs.js';
import type { Caller, Tool } from './mcp.js';
import { BATCH_MAX_FILES } from './project-files.js';

/**
 * Moving Claude projects over (docs/ai-tools.md#claude-projekte-umziehen): one MCP tool that turns a claude.ai project – its
 * instructions, knowledge files and chat links – into a sub-account. Everything goes through the caller's own REST access
 * (call.api), so scope, validation and the audit log apply. Re-running it with the same input changes nothing: the sub-account is
 * found by its exact name, files are stored by path (unchanged bytes stay), links are filed by URL.
 */

type Json = Record<string, any>;

/** A batch of the file store must stay under its 25 MB; Base64 is counted at its decoded size. */
const CHUNK_BYTES = 20 * 1024 * 1024;
const approxBytes = (f: Json) => (typeof f?.content === 'string' ? Buffer.byteLength(f.content) : typeof f?.data === 'string' ? Math.floor((f.data.length * 3) / 4) : 0);

function chunks(files: Json[]): Json[][] {
  const out: Json[][] = [];
  let cur: Json[] = [];
  let bytes = 0;
  for (const f of files) {
    const n = approxBytes(f);
    if (cur.length && (cur.length >= BATCH_MAX_FILES || bytes + n > CHUNK_BYTES)) (out.push(cur), (cur = []), (bytes = 0));
    cur.push(f);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

const KIND_ALIAS: Record<string, string> = { chat: 'session', conversation: 'session', project: 'link', knowledge: 'doc', document: 'doc' };

async function findOrCreate(call: Caller, name: string, locationId?: string): Promise<{ id: string; name: string; created: boolean }> {
  const list: { id: string; name: string }[] = await call.api('GET', '/api/agency/projects');
  if (locationId) {
    const hit = list.find((l) => l.id === locationId);
    if (!hit) throw new HttpError(404, `Sub-Account ${String(locationId).slice(0, 60)} gibt es nicht`);
    return { id: hit.id, name: hit.name, created: false };
  }
  const hit = list.find((l) => l.name === name);
  if (hit) return { id: hit.id, name: hit.name, created: false };
  const loc = await call.api('POST', '/api/locations', { body: { name } });
  return { id: loc.id, name: loc.name, created: true };
}

/** The text of a stored file at exactly this path, or null. */
async function storedText(call: Caller, loc: string, path: string): Promise<string | null> {
  const r = await call.api('GET', `/api/project-files?${new URLSearchParams({ prefix: path })}`, { location: loc });
  const f = (r?.files ?? []).find((x: Json) => x.path === path);
  if (!f) return null;
  const full = await call.api('GET', `/api/project-files/${encodeURIComponent(f.id)}`, { location: loc });
  return typeof full?.content === 'string' ? full.content : null;
}

export const CLAUDE_IMPORT_TOOL: Tool = {
  name: 'ghl_import_claude_project',
  title: 'Claude-Projekt übernehmen',
  description:
    'Übernimmt ein claude.ai-Projekt als Sub-Account: name (exakter Projektname – gibt es den Sub-Account schon, wird er wiederverwendet, sonst angelegt; oder location_id), instructions (die Projekt-Anweisungen → Datei CLAUDE.md und, wenn dort noch nichts anderes steht, die Notizen im Steckbrief), description (→ Beschreibung im Steckbrief, wenn leer), files [{path, content} oder {path, data: Base64}] (Wissensdateien → Projektdateien, Herkunft claude-project), links [{url, title, kind: session|artifact|doc|link}] (Chats und Artefakte → Berichte & Artefakte des Projekts). Ein erneuter Aufruf mit denselben Daten ändert nichts. Ein MCP-Aufruf darf etwa 12 MB groß sein – viele große Dateien danach mit ghl_upload_files nachreichen.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name des Claude-Projekts = Name des Sub-Accounts' },
      location_id: { type: 'string', description: 'Vorhandener Sub-Account statt Suche nach dem Namen' },
      instructions: { type: 'string', description: 'Die Projekt-Anweisungen (Custom Instructions)' },
      description: { type: 'string' },
      files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, data: { type: 'string' }, mime: { type: 'string' } }, required: ['path'] } },
      links: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string' } }, required: ['url'] } },
    },
    required: ['name'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  agencyOnly: true,
  run: async (call, a) => {
    const name = String(a.name).trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'name fehlt');
    const files: Json[] = Array.isArray(a.files) ? a.files : [];
    const links: Json[] = Array.isArray(a.links) ? a.links : [];
    if (files.some((f) => !f || typeof f !== 'object' || Array.isArray(f))) throw new HttpError(400, 'files: Liste von Objekten {path, content} erwartet');
    if (links.some((l) => !l || typeof l !== 'object' || Array.isArray(l))) throw new HttpError(400, 'links: Liste von Objekten {url, title, kind} erwartet');

    const loc = await findOrCreate(call, name, a.location_id ? String(a.location_id) : undefined);
    const instructions = typeof a.instructions === 'string' ? a.instructions.trim() : '';
    // The project's own CLAUDE.md among the knowledge files wins the name; the instructions then go to instructions.md.
    const instructionsPath = files.some((f) => String(f.path ?? '').replace(/^\.?\//, '') === 'CLAUDE.md') ? 'instructions.md' : 'CLAUDE.md';

    // Steckbrief: fill what is empty, or what the previous import wrote – never overwrite someone's own notes.
    const profile: Json = await call.api('GET', '/api/project', { location: loc.id });
    const patch: Json = {};
    if (instructions) {
      const before = (profile.notes ?? '').trim();
      if (!before || before === instructions || before === (await storedText(call, loc.id, instructionsPath))?.trim()) {
        if (before !== instructions) patch.notes = instructions;
      }
    }
    const description = typeof a.description === 'string' ? a.description.trim() : '';
    if (description && !(profile.description ?? '').trim()) patch.description = description;
    if (Object.keys(patch).length) await call.api('PUT', '/api/project', { location: loc.id, body: patch });

    const upload = [...(instructions ? [{ path: instructionsPath, content: `${instructions}\n`, mime: 'text/markdown' }] : []), ...files];
    const counts = { created: 0, updated: 0, unchanged: 0 };
    for (const batch of chunks(upload)) {
      const r = await call.api('POST', '/api/project-files', { location: loc.id, body: { files: batch, source: 'claude-project' } });
      for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] += Number(r?.[k] ?? 0);
    }

    let docs = { created: 0, updated: 0 };
    if (links.length) {
      const list = links.map((l) => {
        const kind = String(l.kind ?? '').toLowerCase();
        const k = DOC_KINDS.includes(kind) ? kind : KIND_ALIAS[kind];
        return { url: l.url, title: l.title, ...(k ? { kind: k } : {}), location_id: loc.id, source: 'Claude' };
      });
      const r = await call.api('POST', '/api/agency/docs', { body: { docs: list } });
      docs = { created: Number(r?.created ?? 0), updated: Number(r?.updated ?? 0) };
    }

    return {
      location_id: loc.id,
      name: loc.name,
      created_project: loc.created,
      instructions_file: instructions ? instructionsPath : null,
      profile_updated: Object.keys(patch),
      files: counts,
      links: docs,
    };
  },
};

export const claudeImportModule: Module = {
  name: 'claude-import',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), CLAUDE_IMPORT_TOOL];
  },
};
