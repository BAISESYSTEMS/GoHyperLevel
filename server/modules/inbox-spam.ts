import type { Module } from '../core/app.js';
import { bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { getContact, logActivity } from '../services/contacts.js';
import type { InboundGate } from '../services/inbound-gate.js';
import { tableEntity } from '../services/undo-table.js';
import { twiml } from '../services/twilio.js';
import { registerActions, text, type ActionDef } from '../services/wfx-kit.js';
import { syncMessage, type CallRouteInput } from './telephony.js';

/**
 * Mark as spam and block sender (docs/team-inbox.md#spam-and-blocked-senders). A blocked contact's new messages are stored but
 * archived silently through the receive hook (services/inbound-gate.ts – no unread badge, no `message.inbound`, so no
 * workflow, notification or auto reply), its calls are rejected by the first call router, and its conversations leave the
 * inbox (the conversation filter *Spam* shows them). Blocking from the inbox, by the workflow step `block_contact`, by API;
 * unblocking from the inbox, `unblock_contact` or `DELETE /api/blocked-contacts/:contactId` (the undo journal can take an
 * unblock back). Rows go with the contact (GDPR erasure, export through `contact_id`) and with the sub-account.
 */

export const BLOCK_REASONS = ['spam', 'harassment', 'other'] as const;
const REASON_TEXT: Record<string, string> = { spam: 'Spam', harassment: 'Belästigung', other: 'Sonstiges' };

export const inboxSpamModule: Module = {
  name: 'inbox-spam',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE blocked_contacts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        reason TEXT NOT NULL DEFAULT 'spam', note TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'inbox', blocked_by TEXT,
        blocked_messages INTEGER NOT NULL DEFAULT 0, blocked_calls INTEGER NOT NULL DEFAULT 0, last_blocked_at TEXT, created_at TEXT NOT NULL,
        UNIQUE(location_id, contact_id)
      );
      CREATE INDEX blocked_contacts_contact ON blocked_contacts(contact_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const convCols = new Set(db.all<{ name: string }>(`PRAGMA table_info(conversations)`).map((c) => c.name));
    const teamInbox = convCols.has('inbox_status');
    const blockOf = (locationId: string, contactId: string) => db.get<{ id: string }>('SELECT * FROM blocked_contacts WHERE location_id = ? AND contact_id = ?', locationId, contactId);

    /** Out of the inbox: read, and – with the team inbox – done, with no answer timer running. */
    const archiveConversation = (conversationId: string) => {
      db.run('UPDATE conversations SET unread = 0 WHERE id = ?', conversationId);
      if (teamInbox)
        db.run(
          `UPDATE conversations SET inbox_status = 'closed', closed_at = COALESCE(closed_at, ?), awaiting_since = NULL, awaiting_kind = '', sla_dirty = 0, response_due_at = NULL, response_warn_at = NULL, snoozed_until = NULL WHERE id = ?`,
          now(),
          conversationId,
        );
    };

    /** Blocks a contact (or updates the reason of an existing block) and archives its conversations. */
    const block = (locationId: string, contactId: string, o: { reason?: unknown; note?: unknown; source: string; by?: string | null }) => {
      const contact = getContact(app, locationId, contactId);
      if (!contact) throw notFound('Kontakt nicht gefunden');
      const reason = BLOCK_REASONS.includes(o.reason as (typeof BLOCK_REASONS)[number]) ? String(o.reason) : 'spam';
      const note = String(o.note ?? '').trim().slice(0, 500);
      const cur = blockOf(locationId, contactId);
      db.tx(() => {
        if (cur) db.run('UPDATE blocked_contacts SET reason = ?, note = ? WHERE id = ?', reason, note, cur.id);
        else db.insert('blocked_contacts', { id: id(), location_id: locationId, contact_id: contactId, reason, note, source: o.source, blocked_by: o.by ?? null, created_at: now() });
        for (const c of db.all<{ id: string }>('SELECT id FROM conversations WHERE location_id = ? AND contact_id = ?', locationId, contactId)) archiveConversation(c.id);
      });
      if (!cur) logActivity(app, locationId, contactId, 'contact.blocked', `Als ${REASON_TEXT[reason]} markiert und blockiert`);
      return { ...blockOf(locationId, contactId), blocked: true };
    };
    const unblock = (locationId: string, contactId: string) => {
      const n = db.run('DELETE FROM blocked_contacts WHERE location_id = ? AND contact_id = ?', locationId, contactId).changes;
      if (n) logActivity(app, locationId, contactId, 'contact.unblocked', 'Blockierung aufgehoben');
      return n > 0;
    };

    // --- routes -----------------------------------------------------------------------------------------------------
    router.get('/api/blocked-contacts', 'location', (ctx) =>
      db.all(
        `SELECT b.*, c.first_name, c.last_name, c.email, c.phone, u.name AS blocked_by_name
         FROM blocked_contacts b JOIN contacts c ON c.id = b.contact_id LEFT JOIN users u ON u.id = b.blocked_by
         WHERE b.location_id = ? ORDER BY b.created_at DESC LIMIT 1000`,
        ctx.locationId,
      ),
    );
    router.get('/api/blocked-contacts/:contactId', 'location', (ctx) => {
      if (!getContact(app, ctx.locationId, ctx.params.contactId)) throw notFound('Kontakt nicht gefunden');
      const b = blockOf(ctx.locationId, ctx.params.contactId);
      return b ? { ...b, blocked: true } : { blocked: false, contact_id: ctx.params.contactId };
    });
    router.post('/api/blocked-contacts', 'location', (ctx) => {
      const contactId = str(ctx.body?.contact_id, 'contact_id', { required: true, max: 64 });
      if (ctx.body?.reason !== undefined && !BLOCK_REASONS.includes(ctx.body.reason)) throw bad('Grund: spam, harassment oder other');
      return block(ctx.locationId, contactId, { reason: ctx.body?.reason, note: ctx.body?.note, source: ctx.viaApiKey ? 'api' : 'inbox', by: ctx.user?.id ?? null });
    });
    router.delete('/api/blocked-contacts/:contactId', 'location', (ctx) => {
      if (!unblock(ctx.locationId, ctx.params.contactId)) throw notFound('Dieser Kontakt ist nicht blockiert');
      return { ok: true, blocked: false };
    });

    // --- receive hook: archive what a blocked sender writes -----------------------------------------------------------
    const gate: InboundGate = ({ locationId, contactId }) => {
      const b = contactId ? blockOf(locationId, contactId) : undefined;
      if (!b) return null;
      return {
        archive: (conversationId, messageId) => {
          db.run(`UPDATE messages SET status = 'spam' WHERE id = ?`, messageId);
          archiveConversation(conversationId);
          db.run('UPDATE blocked_contacts SET blocked_messages = blocked_messages + 1, last_blocked_at = ? WHERE id = ?', now(), b.id);
        },
      };
    };
    app.services.inboundGates = [...(app.services.inboundGates ?? []), gate];

    // --- calls: the first router rejects a blocked caller (before menus, ring groups and the AI agent) -------------------
    app.services.callRouters = [
      (input: CallRouteInput): string | undefined => {
        const cid = input.call.contact_id;
        const b = cid ? blockOf(input.loc.id, cid) : undefined;
        if (!b) return undefined;
        // Ended here: the later status callback is a no-op, so nothing counts as missed (no notice, no "missed call" workflow).
        db.run(`UPDATE calls SET status = 'canceled', reason = 'blocked', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?`, now(), now(), input.call.id);
        const call = db.get('SELECT * FROM calls WHERE id = ?', input.call.id);
        if (call) syncMessage(app, call as any);
        if (call?.message_id) db.run(`UPDATE messages SET status = 'spam' WHERE id = ?`, call.message_id);
        for (const c of db.all<{ id: string }>('SELECT id FROM conversations WHERE location_id = ? AND contact_id = ?', input.loc.id, cid)) archiveConversation(c.id);
        db.run('UPDATE blocked_contacts SET blocked_calls = blocked_calls + 1, last_blocked_at = ? WHERE id = ?', now(), b.id);
        return twiml('<Reject reason="rejected"/>');
      },
      ...(app.services.callRouters ?? []),
    ];

    // --- the inbox: blocked senders' conversations only under the filter "Spam" ----------------------------------------
    app.services.conversationFilters = [
      ...(app.services.conversationFilters ?? []),
      (ctx: Ctx, where: string[]) => {
        const cond = 'EXISTS (SELECT 1 FROM blocked_contacts b WHERE b.contact_id = v.contact_id AND b.location_id = v.location_id)';
        where.push(ctx.query.get('filter') === 'spam' ? cond : `NOT ${cond}`);
      },
    ];

    // --- workflow steps -----------------------------------------------------------------------------------------------
    const steps: ActionDef[] = [
      {
        meta: {
          type: 'block_contact',
          label: 'Als Spam markieren & blockieren',
          category: 'crm',
          icon: 'shield',
          summary: 'Blockiert den Kontakt: neue Nachrichten werden still archiviert, Anrufe abgewiesen.',
          doc: 'Der Kontakt landet in der Liste der blockierten Absender. Was er danach schreibt (E-Mail, SMS, WhatsApp, Messenger, Instagram, Telegram, Discord, Slack, synchronisierte Postfächer), wird gespeichert, aber still archiviert – kein Ungelesen-Zähler, keine Benachrichtigung, kein Workflow. Anrufe werden abgewiesen. Seine Konversationen verschwinden aus dem Posteingang (Filter „Spam“). Aufheben mit „Blockierung aufheben“ oder im Posteingang.',
          keywords: 'spam blockieren sperren absender belästigung block',
          fields: [
            { key: 'reason', label: 'Grund', type: 'select', options: [['spam', 'Spam'], ['harassment', 'Belästigung'], ['other', 'Sonstiges']], default: 'spam' },
            { key: 'note', label: 'Notiz (optional)', type: 'text', placeholder: 'z. B. Werbe-Mails trotz Abmeldung' },
          ],
          sample: { reason: 'spam', note: 'Werbung' },
        },
        run: (run, step, vars) => {
          block(run.location_id, run.contact_id, { reason: step.reason, note: text(step.note, vars), source: 'workflow' });
          return { result: `Blockiert (${REASON_TEXT[BLOCK_REASONS.includes(step.reason) ? step.reason : 'spam']})` };
        },
      },
      {
        meta: {
          type: 'unblock_contact',
          label: 'Blockierung aufheben',
          category: 'crm',
          icon: 'unlock',
          summary: 'Hebt die Blockierung des Kontakts auf – seine Nachrichten und Anrufe kommen wieder an.',
          doc: 'Gegenstück zu „Als Spam markieren & blockieren“. Schon archivierte Nachrichten bleiben archiviert; neue landen wieder im Posteingang.',
          keywords: 'spam entsperren freigeben unblock',
          fields: [],
          sample: {},
        },
        run: (run) => ({ result: unblock(run.location_id, run.contact_id) ? 'Blockierung aufgehoben' : 'War nicht blockiert' }),
      },
    ];
    registerActions(app, steps);

    // --- undo: an unblock can be taken back ------------------------------------------------------------------------------
    const undo = app.services.undo as { register(type: string, e: unknown): void; track(rule: unknown): void } | undefined;
    if (undo) {
      undo.register(
        'blocked_contact',
        tableEntity(app, {
          noun: 'Blockierung',
          plural: 'Blockierungen',
          area: 'conversations',
          table: 'blocked_contacts',
          title: (r) => {
            const c = db.get<{ first_name: string; last_name: string; email: string; phone: string }>('SELECT first_name, last_name, email, phone FROM contacts WHERE id = ?', r.contact_id as string);
            return c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.phone || 'Kontakt' : 'Kontakt';
          },
          fields: { reason: { label: 'Grund' }, note: { label: 'Notiz' } },
        }),
      );
      undo.track({
        method: 'DELETE',
        pattern: '/api/blocked-contacts/:contactId',
        entity: 'blocked_contact',
        targets: (ctx: Ctx) => {
          const b = blockOf(ctx.locationId, ctx.params.contactId);
          return b ? [{ id: b.id }] : [];
        },
      });
    }
  },
};

