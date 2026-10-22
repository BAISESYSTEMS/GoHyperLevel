import type { Module } from '../core/app.js';
import { getContact } from '../services/contacts.js';
import { registerTriggers, type TriggerMeta } from '../services/wfx-kit.js';

/**
 * Workflow triggers for the outgoing side of a conversation (docs/workflow-actions.md#outgoing-messages):
 *
 * - `message.outbound` – an e-mail, SMS, chat or other message left (sent, delivered or recorded), with who sent it
 *   (`sender`: user, workflow, campaign, ai, system);
 * - `message.team_reply` – a person of the team answered a contact (by hand, in the app, the API or MCP).
 *
 * Messages get in and out through many paths (composer, workflows, campaigns, mailbox sync, channel modules), so the sending
 * side is not touched: SQL triggers on `messages` note every message that turns "sent" in a small queue, and the queue is emptied
 * right after each write request and on every tick. Calls are left out (they have `call.completed`). Workflow messages carry a
 * depth so automations that answer each other cannot chain forever, and by default the outbound trigger ignores them.
 */

/** Statuses that mean "it went out" (or was recorded without a provider). */
const SENT = ['sent', 'delivered', 'read', 'logged'];
const SENT_SQL = SENT.map((s) => `'${s}'`).join(',');

export type Sender = 'user' | 'workflow' | 'campaign' | 'ai' | 'system';

/** Who sent a message, from its author and source label. */
export function senderOf(m: { user_id?: string | null; source?: string | null }): Sender {
  const s = String(m.source ?? '').trim();
  if (m.user_id || s === 'manuell' || s === 'manual') return 'user';
  if (/^(workflow|sequenz|sequence)/i.test(s)) return 'workflow';
  if (/^(kampagne|campaign|nps|newsletter)/i.test(s)) return 'campaign';
  if (/^(ki|ai|agent|bot|claude|voice)/i.test(s) || /assistent/i.test(s)) return 'ai';
  return 'system';
}

const SENDERS: [string, string][] = [
  ['', 'Alle außer Workflows'],
  ['user', 'Teammitglied'],
  ['workflow', 'Workflow'],
  ['campaign', 'Kampagne'],
  ['ai', 'KI'],
  ['system', 'System (Termine, Rechnungen …)'],
  ['any', 'Alle, auch Workflows'],
];
const CHANNEL = { key: 'channel', label: 'Kanal', type: 'select' as const, options: [['', 'Jeder'], ['email', 'E-Mail'], ['sms', 'SMS'], ['chat', 'Website-Chat'], ['whatsapp', 'WhatsApp'], ['messenger', 'Messenger'], ['instagram', 'Instagram'], ['telegram', 'Telegram']] as [string, string][] };
const sample = { message: { id: 'm1', channel: 'email', subject: 'Ihr Angebot', body: 'Hallo Erika, anbei das Angebot …', status: 'sent', source: 'manuell', user_id: 'u1' }, sender: 'user', userId: 'u1', userName: 'Anna' };

export const MESSAGE_TRIGGERS: TriggerMeta[] = [
  {
    type: 'message.outbound',
    label: 'Ausgehende Nachricht gesendet',
    category: 'messages',
    summary: 'Eine E-Mail, SMS, Chat- oder WhatsApp-Nachricht an den Kontakt ist rausgegangen – von Hand, per Kampagne, KI oder System.',
    doc: '{{event.message.body}}, {{event.message.subject}}, {{event.message.channel}}, {{event.sender}} (user, workflow, campaign, ai, system) und {{event.userName}} stehen zur Verfügung. Nachrichten von Workflows zählen nur mit „Absender: Workflow“ oder „Alle, auch Workflows“ – so stoßen sich Abläufe nicht gegenseitig an. Anrufe haben ihren eigenen Auslöser.',
    fields: [CHANNEL, { key: 'sender', label: 'Absender', type: 'select', options: SENDERS }],
    sample,
    keywords: 'ausgehend gesendet outbound sent nachricht email sms verschickt',
  },
  {
    type: 'message.team_reply',
    label: 'Teammitglied hat geantwortet',
    category: 'messages',
    summary: 'Jemand aus dem Team schreibt dem Kontakt – im Posteingang, am Kontakt, in der App oder über API/MCP.',
    doc: 'Typisch: Erinnerungs-Workflow beenden, Status setzen, Deal-Stufe ändern oder eine Aufgabe schließen. {{event.userId}} und {{event.userName}} sagen, wer geantwortet hat, {{event.message.body}} was.',
    fields: [CHANNEL, { key: 'user_id', label: 'Teammitglied', type: 'user', help: 'Leer = jede Person' }],
    sample,
    keywords: 'antwort geantwortet team mitarbeiter reply replied outbound',
  },
];

export const messageTriggersModule: Module = {
  name: 'message-triggers',
  migrations: [
    [
      '001-queue',
      `
      CREATE TABLE message_outbound_queue (message_id TEXT PRIMARY KEY, location_id TEXT NOT NULL, queued_at TEXT NOT NULL);
      CREATE TRIGGER message_outbound_ins AFTER INSERT ON messages
        WHEN NEW.direction = 'out' AND NEW.channel != 'call' AND NEW.status IN (${SENT_SQL})
      BEGIN
        INSERT OR IGNORE INTO message_outbound_queue (message_id, location_id, queued_at) VALUES (NEW.id, NEW.location_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      END;
      CREATE TRIGGER message_outbound_upd AFTER UPDATE OF status ON messages
        WHEN NEW.direction = 'out' AND NEW.channel != 'call' AND NEW.status IN (${SENT_SQL}) AND OLD.status NOT IN (${SENT_SQL})
      BEGIN
        INSERT OR IGNORE INTO message_outbound_queue (message_id, location_id, queued_at) VALUES (NEW.id, NEW.location_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      END;
      `,
    ],
  ],
  register(app) {
    const { db } = app;
    registerTriggers(app, MESSAGE_TRIGGERS);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'message.outbound': (c: Record<string, any>, d: Record<string, any>) =>
        (!c.channel || c.channel === d.message?.channel) && (c.sender === 'any' ? true : c.sender ? c.sender === d.sender : d.sender !== 'workflow'),
      'message.team_reply': (c: Record<string, any>, d: Record<string, any>) => (!c.channel || c.channel === d.message?.channel) && (!c.user_id || c.user_id === d.userId),
    };

    const userName = (id: string | null | undefined) => (id ? (db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? '') : '');

    /** Empties the queue: one event per message (plus the team-reply event for people). */
    let draining = false;
    function drain() {
      if (draining || !db.get('SELECT 1 AS x FROM message_outbound_queue LIMIT 1')) return;
      draining = true;
      try {
        for (let round = 0; round < 10; round++) {
          const batch = db.all<{ message_id: string; location_id: string }>('SELECT message_id, location_id FROM message_outbound_queue ORDER BY queued_at LIMIT 200');
          if (!batch.length) break;
          db.run(`DELETE FROM message_outbound_queue WHERE message_id IN (${batch.map(() => '?').join(',')})`, ...batch.map((b) => b.message_id));
          for (const b of batch) {
            const m = db.get<any>('SELECT id, conversation_id, contact_id, channel, direction, subject, body, status, source, user_id, created_at FROM messages WHERE id = ?', b.message_id);
            if (!m) continue;
            const contact = getContact(app, b.location_id, m.contact_id);
            if (!contact) continue;
            const sender = senderOf(m);
            const data = { contactId: m.contact_id, contact, message: m, sender, userId: m.user_id ?? null, userName: userName(m.user_id), ...(sender === 'workflow' ? { wfDepth: 3 } : {}) };
            app.events.emit(b.location_id, 'message.outbound', data);
            if (sender === 'user') app.events.emit(b.location_id, 'message.team_reply', data);
          }
        }
      } catch (e) {
        console.error('[message-triggers]', (e as Error).message);
      } finally {
        draining = false;
      }
    }
    app.afterWrite.push(() => drain());
    app.onTick(() => drain());
    app.services.drainOutboundMessages = drain;
  },
};
