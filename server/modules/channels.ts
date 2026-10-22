import type { App, Module } from '../core/app.js';
import { bad, notFound, str, type Ctx } from '../core/http.js';
import { getContact, type Contact } from '../services/contacts.js';
import { sendToContact } from '../services/messaging.js';

/**
 * Base of the extra channels (Telegram, Discord, Slack, email/SMS providers, push to contacts):
 * shared tables (settings with sealed secrets, external user → contact, webhook dedupe, media of
 * inbound messages) and the registries the channel modules fill:
 * - app.services.channelStatus[channel](locationId, contact) → what the composer may offer
 * - app.services.channelMedia[channel](locationId, media, message) → RawResult with the file
 * - app.services.channelSend(locationId, {contactId, channel, body, …}) → send on any channel
 *   (built-in email/SMS/chat, or a module channel from app.services.messageChannels)
 * Helpers for the channel modules live in services/channel-kit.ts.
 */

export interface ChannelSendInput {
  contactId: string;
  channel: string;
  body: string;
  subject?: string;
  userId?: string | null;
  source?: string;
  ignoreDnd?: boolean;
}

/** Sends on any channel the app knows; returns the message (status `failed` with `error` when it did not go out). */
export async function channelSend(app: App, locationId: string, input: ChannelSendInput): Promise<any> {
  const { channel } = input;
  if (channel === 'email' || channel === 'sms' || channel === 'chat') {
    return sendToContact(app, locationId, { contactId: input.contactId, channel, subject: input.subject, body: input.body, userId: input.userId ?? undefined, source: input.source, ignoreDnd: input.ignoreDnd });
  }
  const ext = app.services.messageChannels ?? {};
  if (!Object.hasOwn(ext, channel)) throw bad(`Kanal „${channel}“ ist nicht verfügbar`);
  // The same shape tickets use: the handler reads locationId, body and user.
  return ext[channel]({ locationId, body: { contact_id: input.contactId, body: input.body, subject: input.subject, ignoreDnd: input.ignoreDnd, source: input.source }, user: input.userId ? { id: input.userId } : undefined, method: 'POST', query: new URLSearchParams() } as unknown as Ctx);
}

export const channelsModule: Module = {
  name: 'channels',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE channel_accounts (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}', secrets TEXT NOT NULL DEFAULT '', info TEXT NOT NULL DEFAULT '{}',
        hook_key TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        last_webhook_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (location_id, channel)
      );
      CREATE TABLE channel_identities (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, channel TEXT NOT NULL, external_id TEXT NOT NULL,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT '', handle TEXT NOT NULL DEFAULT '',
        chat_id TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (location_id, channel, external_id)
      );
      CREATE INDEX channel_identities_contact ON channel_identities(contact_id, channel);
      CREATE TABLE channel_seen (location_id TEXT NOT NULL, channel TEXT NOT NULL, event_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (location_id, channel, event_id));
      CREATE INDEX channel_seen_at ON channel_seen(at);
      ALTER TABLE messages ADD COLUMN channel_media TEXT;
      CREATE INDEX messages_provider ON messages(location_id, provider_id) WHERE provider_id IS NOT NULL;
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.channelSend = (locationId: string, input: ChannelSendInput) => channelSend(app, locationId, input);

    /** What the composer can offer for this contact on the extra channels. */
    router.get('/api/messages/channels/status', 'location', (ctx) => {
      const c = getContact(app, ctx.locationId, str(ctx.query.get('contact_id'), 'Kontakt', { required: true }));
      if (!c) throw notFound('Kontakt nicht gefunden');
      const fns: Record<string, (loc: string, contact: Contact) => any> = app.services.channelStatus ?? {};
      return { channels: Object.fromEntries(Object.entries(fns).map(([ch, fn]) => [ch, fn(ctx.locationId, c)])) };
    });

    /** File of an inbound Telegram/Discord message, fetched from the platform when someone looks at it. */
    router.get('/api/messages/channels/media/:id', 'location', async (ctx) => {
      const m = db.get('SELECT * FROM messages WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      let media: any = null;
      try {
        media = m?.channel_media ? JSON.parse(m.channel_media) : null;
      } catch {
        media = null;
      }
      const fn = app.services.channelMedia?.[m?.channel];
      if (!media || !fn) throw notFound();
      return fn(ctx.locationId, media, m);
    });

    // Webhook ids are only needed while providers retry.
    let cleaned = 0;
    app.onTick(() => {
      if (Date.now() - cleaned < 3600_000) return;
      cleaned = Date.now();
      db.run('DELETE FROM channel_seen WHERE at < ?', new Date(Date.now() - 7 * 864e5).toISOString());
    });
  },
};
