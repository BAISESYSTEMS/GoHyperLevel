import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { getContact } from '../services/contacts.js';
import { getOrCreateConversation } from '../services/messaging.js';
import { WINDOW_MS } from '../services/meta.js';
import type { Tool } from './mcp.js';

/**
 * SMS and WhatsApp reply drafts (docs/team-inbox.md#sms-and-whatsapp-drafts): the in-app agent and MCP store a draft reply in a
 * conversation – a `messages` row with status `draft`, like the e-mail drafts of ghl_draft_email. Nothing is sent here:
 * the inbox puts the draft into the composer of that conversation, a person edits it and sends it through the normal send
 * path (POST /api/messages or /api/messages/meta), so DND, the WhatsApp 24-hour window and templates stay enforced there.
 * Discarding is the existing DELETE /api/messages/:id (drafts only, undo journal). The route sits under /api/conversations,
 * so the area right "Konversationen" and the sub-account scope apply as for every inbox route.
 */

export const DRAFT_CHANNELS = ['sms', 'whatsapp'] as const;
export type DraftChannel = (typeof DRAFT_CHANNELS)[number];
/** Longest text a draft may hold: a long SMS (10 parts) and WhatsApp's free-text limit. */
export const DRAFT_LIMITS: Record<DraftChannel, number> = { sms: 1600, whatsapp: 4096 };
const DEFAULT_SOURCE = 'KI-Agent';

export const MSG_DRAFT_TOOLS: Tool[] = [
  {
    name: 'ghl_draft_message',
    title: 'SMS-/WhatsApp-Entwurf anlegen',
    description:
      'Legt einen Antwort-Entwurf per SMS oder WhatsApp in der Konversation eines Kontakts ab (Status Entwurf – es wird nichts verschickt; der Nutzer sieht ihn im Eingabefeld des Posteingangs, kann ihn ändern und mit einem Klick senden). Ein neuer Entwurf ersetzt den vorigen KI-Entwurf desselben Kanals. WhatsApp: freier Text geht nur innerhalb von 24 h nach der letzten Nachricht des Kontakts raus, sonst nur eine Vorlage (window_open im Ergebnis). E-Mail-Entwürfe: ghl_draft_email.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
        contact_id: { type: 'string', description: 'Kontakt (oder conversation_id)' },
        conversation_id: { type: 'string', description: 'Konversation (oder contact_id)' },
        channel: { type: 'string', enum: [...DRAFT_CHANNELS] },
        body: { type: 'string', description: 'Text der Antwort' },
      },
      required: ['channel', 'body'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      if (!a.contact_id && !a.conversation_id) throw new HttpError(400, 'contact_id oder conversation_id angeben');
      const r = await call.api('POST', '/api/conversations/drafts', { location: a.location_id, body: { contact_id: a.contact_id, conversation_id: a.conversation_id, channel: a.channel, body: a.body } });
      return { ok: true, draft: true, sent: false, id: r.id, channel: r.channel, contact_id: r.contact_id, conversation_id: r.conversation_id, replaced: r.replaced, window_open: r.window_open, hint: r.hint, link: `conversations/${r.conversation_id}` };
    },
  },
];

export const msgDraftsModule: Module = {
  name: 'msg-drafts',
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...MSG_DRAFT_TOOLS];

    router.post('/api/conversations/drafts', 'location', (ctx) => {
      const channel = ctx.body.channel as DraftChannel;
      if (!DRAFT_CHANNELS.includes(channel)) throw bad('Kanal: sms oder whatsapp (E-Mail-Entwürfe: ghl_draft_email)');
      const body = str(ctx.body.body, 'Nachricht', { required: true, max: DRAFT_LIMITS[channel] }).trim();
      if (!body) throw bad('Nachricht fehlt');
      let conversationId: string;
      let contactId: string;
      if (ctx.body.conversation_id) {
        const v = db.get<{ id: string; contact_id: string }>('SELECT id, contact_id FROM conversations WHERE id = ? AND location_id = ?', String(ctx.body.conversation_id), ctx.locationId);
        if (!v) throw notFound('Konversation nicht gefunden');
        if (ctx.body.contact_id && String(ctx.body.contact_id) !== v.contact_id) throw bad('contact_id passt nicht zur Konversation');
        conversationId = v.id;
        contactId = v.contact_id;
      } else {
        contactId = str(ctx.body.contact_id, 'Kontakt', { required: true });
        if (!getContact(app, ctx.locationId, contactId)) throw notFound('Kontakt nicht gefunden');
        conversationId = '';
      }
      const contact = getContact(app, ctx.locationId, contactId)!;
      if (!String(contact.phone ?? '').trim()) throw bad(`Der Kontakt hat keine Telefonnummer – kein ${channel === 'sms' ? 'SMS' : 'WhatsApp'}-Entwurf möglich`);
      conversationId ||= getOrCreateConversation(app, ctx.locationId, contactId);
      const source = str(ctx.body.source, 'Quelle', { max: 60 }) || DEFAULT_SOURCE;
      // one open draft per channel and author: a new one replaces the previous one instead of piling up
      const replaced = db.run(`DELETE FROM messages WHERE conversation_id = ? AND location_id = ? AND status = 'draft' AND channel = ? AND source = ?`, conversationId, ctx.locationId, channel, source).changes;
      const row = {
        id: id(),
        location_id: ctx.locationId,
        conversation_id: conversationId,
        contact_id: contactId,
        channel,
        direction: 'out',
        subject: '',
        body,
        status: 'draft',
        error: '',
        source,
        user_id: ctx.user?.id ?? null,
        created_at: now(),
      };
      db.insert('messages', row);
      let windowOpen: boolean | undefined;
      let hint: string | undefined;
      if (channel === 'whatsapp') {
        const at = db.get<{ at: string | null }>(`SELECT MAX(created_at) AS at FROM messages WHERE location_id = ? AND contact_id = ? AND channel = 'whatsapp' AND direction = 'in'`, ctx.locationId, contactId)?.at;
        windowOpen = !!at && new Date(at).getTime() + WINDOW_MS > Date.now();
        if (!windowOpen) hint = 'Das 24-Stunden-Fenster ist zu: der Text lässt sich erst nach einer neuen Nachricht des Kontakts senden, bis dahin nur eine freigegebene Vorlage.';
      }
      app.services.audit?.({ ctx, action: 'message.draft', summary: `${channel === 'sms' ? 'SMS' : 'WhatsApp'}-Entwurf für ${[contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.phone} angelegt`, locationId: ctx.locationId, entityId: row.id });
      return { id: row.id, conversation_id: conversationId, contact_id: contactId, channel, status: 'draft', replaced, window_open: windowOpen, hint };
    });
  },
};
