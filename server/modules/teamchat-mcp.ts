import type { Module } from '../core/app.js';
import type { Caller, Tool } from './mcp.js';

/**
 * MCP tools for the Team-Chat: agents post into public channels and read their history. A key or MCP connection of a
 * sub-account acts for the sub-account (like every other API) and signs with the key's name; it reaches public channels
 * only – never private channels or direct messages, which belong to their members. Everything relays onto the REST API
 * (/api/team-chat/…), so rights, validation, notifications and the audit log are the ordinary ones.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const link = (id: string) => `/app/team-chat/${id}`;

/** The channel a tool names: by id, or by name (with or without "#"). */
async function channelOf(call: Caller, location: string, wanted: unknown): Promise<{ id: string; name: string }> {
  const r = await call.api('GET', '/api/team-chat/channels', { location });
  const list: any[] = r.channels ?? [];
  const q = String(wanted ?? '').trim().toLowerCase().replace(/^#/, '');
  const c = list.find((x) => x.id === wanted) ?? list.find((x) => String(x.name).toLowerCase() === q);
  if (!c) throw new Error(`Kanal „${wanted}“ nicht gefunden${list.length ? ` – verfügbar: ${list.map((x) => `#${x.name}`).join(', ')}` : ' – in diesem Sub-Account gibt es noch keinen öffentlichen Kanal (bitte einmal den Team-Chat öffnen)'}`);
  return { id: c.id, name: c.label ?? `#${c.name}` };
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_chat_post',
    title: 'Im Team-Chat schreiben',
    description:
      'Schreibt eine Nachricht in einen öffentlichen Team-Chat-Kanal des Sub-Accounts (channel = Name wie „allgemein“ oder ID; optional als Antwort in einem Thread: thread_id). Markdown und „@Vorname Nachname“ für Erwähnungen sind möglich (die Person bekommt eine Benachrichtigung). Die Nachricht erscheint unter dem Namen des Schlüssels. In private Kanäle und Direktnachrichten kann ein Schlüssel nicht schreiben.',
    inputSchema: obj({ ...LOC, channel: { type: 'string', description: 'Kanalname (z. B. allgemein) oder ID' }, text: { type: 'string' }, thread_id: { type: 'string' } }, ['location_id', 'channel', 'text']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      const ch = await channelOf(call, a.location_id, a.channel);
      const m = await call.api('POST', `/api/team-chat/channels/${encodeURIComponent(ch.id)}/messages`, { location: a.location_id, body: { body: a.text, ...(a.thread_id ? { thread_id: a.thread_id } : {}) } });
      return { message_id: m.id, channel: ch.name, thread_id: m.thread_id, mentions: m.mentions, link: link(ch.id) };
    },
  },
  {
    name: 'ghl_chat_history',
    title: 'Team-Chat lesen',
    description: 'Liest den Verlauf eines öffentlichen Team-Chat-Kanals (neueste zuletzt) – oder einen Thread (thread_id). before = ID einer Nachricht: davor liegende laden. Ohne channel: die öffentlichen Kanäle des Sub-Accounts.',
    inputSchema: obj({ ...LOC, channel: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'string' }, thread_id: { type: 'string' } }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      if (!a.channel) {
        const r = await call.api('GET', '/api/team-chat/channels', { location: a.location_id });
        return { channels: (r.channels ?? []).map((c: any) => ({ id: c.id, name: c.name, topic: c.topic, last_message_at: c.last_message_at, link: link(c.id) })) };
      }
      const ch = await channelOf(call, a.location_id, a.channel);
      const slim = (m: any) => ({ id: m.id, author: m.author?.name, kind: m.kind, text: m.text, created_at: m.created_at, edited: !!m.edited_at, thread_id: m.thread_id, replies: m.reply_count, reactions: (m.reactions ?? []).map((r: any) => `${r.emoji}${r.count}`).join(' '), files: (m.files ?? []).map((f: any) => f.name), pinned: m.pinned });
      if (a.thread_id) {
        const t = await call.api('GET', `/api/team-chat/messages/${encodeURIComponent(a.thread_id)}/thread`, { location: a.location_id });
        return { channel: ch.name, messages: [t.parent, ...t.replies].map(slim), link: link(ch.id) };
      }
      const q = new URLSearchParams({ limit: String(a.limit ?? 30), ...(a.before ? { before: String(a.before) } : {}) });
      const r = await call.api('GET', `/api/team-chat/channels/${encodeURIComponent(ch.id)}/messages?${q}`, { location: a.location_id });
      return { channel: ch.name, messages: (r.messages ?? []).map(slim), has_more: r.has_more, link: link(ch.id) };
    },
  },
];
export const teamchatMcpModule: Module = {
  name: 'teamchat-mcp',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
