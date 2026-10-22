import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, text, clampLimit, type Ctx } from '../core/http.js';
import { textToHtml } from '../core/template.js';
import { safeEqual, token } from '../core/util.js';
import { getContact } from '../services/contacts.js';
import { deliverEmail, deliverSms, receiveMessage, sendToContact } from '../services/messaging.js';
import { sealSettings } from '../core/secrets.js';
import { firstSeen, inboundMessageId } from '../services/channel-kit.js';

export const conversationsModule: Module = {
  name: 'conversations',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        unread INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0, last_message TEXT NOT NULL DEFAULT '',
        last_message_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(location_id, contact_id)
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        channel TEXT NOT NULL, direction TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
        status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', provider_id TEXT,
        user_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX messages_conv ON messages(conversation_id, created_at);
      `,
    ],
  ],
  register(app) {
    // Inbound mail forwarded by a provider can be larger than the 1 MB public default.
    app.services.bodyLimits = [...(app.services.bodyLimits ?? []), { match: (m: string, p: string) => m === 'POST' && /^\/hooks\/[^/]+\/email$/.test(p), bytes: 12 * 1024 * 1024 }];
    const { db, router } = app;

    router.get('/api/conversations', 'location', (ctx) => {
      const where = ['v.location_id = ?'];
      const params: any[] = [ctx.locationId];
      if (ctx.query.get('filter') === 'unread') where.push('v.unread > 0');
      if (ctx.query.get('filter') === 'starred') where.push('v.starred = 1');
      if (ctx.query.get('filter') === 'drafts') where.push(`EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = v.id AND m.status = 'draft')`);
      const channel = ctx.query.get('channel');
      if (channel && /^[a-z]{2,20}$/.test(channel)) {
        where.push('EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = v.id AND m.channel = ?)');
        params.push(channel);
      }
      const q = ctx.query.get('q');
      if (q) {
        where.push(`(c.first_name || ' ' || c.last_name || ' ' || c.email || ' ' || c.phone || ' ' || v.last_message) LIKE ?`);
        params.push(`%${q}%`);
      }
      // Modules narrow the list (mailbox filter) and decorate its rows (folder badges): conversationFilters / conversationRows.
      for (const f of (app.services.conversationFilters ?? []) as ((ctx: Ctx, where: string[], params: any[]) => void)[]) f(ctx, where, params);
      const rows = db.all(
        `SELECT v.*, c.first_name, c.last_name, c.email, c.phone, c.dnd,
           (SELECT m.channel FROM messages m WHERE m.conversation_id = v.id ORDER BY m.created_at DESC LIMIT 1) AS last_channel
         FROM conversations v JOIN contacts c ON c.id = v.contact_id
         WHERE ${where.join(' AND ')} ORDER BY v.last_message_at DESC LIMIT ?`,
        ...params,
        clampLimit(ctx.query.get('limit'), 100, 500),
      );
      return ((app.services.conversationRows ?? []) as ((ctx: Ctx, rows: any[]) => any[])[]).reduce((r, f) => f(ctx, r), rows);
    });

    router.get('/api/conversations/:id/messages', 'location', (ctx) => {
      const v = db.get('SELECT * FROM conversations WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!v) throw notFound();
      // Opening a conversation marks it read – for people. An API key or an assistant over MCP reading it must not hide new messages from the team.
      if (!ctx.viaApiKey) db.run('UPDATE conversations SET unread = 0 WHERE id = ?', v.id);
      // messageRows: modules add per-message info (mailbox mail: folder, labels, attachments).
      const messages = ((app.services.messageRows ?? []) as ((ctx: Ctx, conversationId: string, rows: any[]) => any[])[]).reduce((r, f) => f(ctx, v.id, r), db.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at', v.id));
      return { conversation: v, contact: getContact(app, ctx.locationId, v.contact_id), messages };
    });
    router.patch('/api/conversations/:id', 'location', (ctx) => {
      const patch: Record<string, any> = {};
      if (ctx.body.unread !== undefined) patch.unread = ctx.body.unread ? 1 : 0;
      if (ctx.body.starred !== undefined) patch.starred = ctx.body.starred ? 1 : 0;
      if (!db.update('conversations', ctx.params.id, patch, ctx.locationId)) throw notFound();
      return db.get('SELECT * FROM conversations WHERE id = ?', ctx.params.id);
    });

    router.get('/api/contacts/:id/messages', 'location', (ctx) =>
      db.all('SELECT * FROM messages WHERE contact_id = ? AND location_id = ? ORDER BY created_at', ctx.params.id, ctx.locationId),
    );

    router.post('/api/messages', 'location', async (ctx) => {
      // Channels other modules add (WhatsApp, Messenger, Instagram…) send themselves.
      const extras = app.services.messageChannels ?? {};
      if (typeof ctx.body.channel === 'string' && Object.hasOwn(extras, ctx.body.channel)) return extras[ctx.body.channel](ctx);
      const channel = ctx.body.channel === 'sms' ? 'sms' : ctx.body.channel === 'chat' ? 'chat' : 'email';
      const contactId = str(ctx.body.contact_id, 'Kontakt', { required: true });
      if (!getContact(app, ctx.locationId, contactId)) throw notFound('Kontakt nicht gefunden');
      const body = str(ctx.body.body, 'Nachricht', { required: true, max: 100_000 });
      return sendToContact(app, ctx.locationId, {
        contactId,
        channel,
        subject: str(ctx.body.subject, 'Betreff', { max: 300 }),
        body,
        isHtml: !!ctx.body.isHtml,
        userId: ctx.user?.id,
        ignoreDnd: !!ctx.body.ignoreDnd,
      });
    });

    /** Checks the configured provider by sending a real message to the given address/number. */
    router.post('/api/settings/test-message', 'location', async (ctx) => {
      const loc = app.location(ctx.locationId)!;
      const to = str(ctx.body.to, 'Empfänger', { required: true });
      try {
        if (ctx.body.channel === 'sms') return await deliverSms(loc, to, `Test von ${loc.name}: SMS-Versand funktioniert.`);
        const body = `Hallo,\n\ndiese Test-E-Mail kommt von ${loc.name}. Der Versand funktioniert.`;
        return await deliverEmail(loc, { to, subject: 'Test-E-Mail', text: body, html: textToHtml(body) });
      } catch (e) {
        throw bad(`Versand fehlgeschlagen: ${(e as Error).message}`);
      }
    });

    /** Secret for the inbound webhooks; created on first request. */
    router.get('/api/settings/inbound', 'location', (ctx) => {
      const loc = app.location(ctx.locationId)!;
      let key = loc.settings.inbound_key;
      if (!key) {
        key = token(18);
        db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify(sealSettings(app, { ...loc.settings, inbound_key: key }).value), loc.id);
      }
      const base = `${app.baseUrl()}/hooks/${loc.id}`;
      return { sms: `${base}/sms?key=${key}`, email: `${base}/email?key=${key}` };
    });

    const checkKey = (locationId: string, key: string | null) => {
      const loc = app.location(locationId);
      if (!loc || !loc.settings.inbound_key || !safeEqual(key, loc.settings.inbound_key)) throw new HttpError(401, 'Falscher Schlüssel');
      return loc;
    };

    // Twilio (From/Body form post), SMS Gateway for Android ({payload:{phoneNumber,message}}) or plain JSON {from, body}.
    const scalar = (v: unknown) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v).trim() : '');
    router.post('/hooks/:loc/sms', 'public', (ctx) => {
      checkKey(ctx.params.loc, ctx.query.get('key'));
      const b = ctx.body ?? {};
      const from = scalar(b.From ?? b.from ?? b.payload?.phoneNumber ?? b.phoneNumber);
      const body = scalar(b.Body ?? b.body ?? b.payload?.message ?? b.message ?? b.text);
      if (!from || !body) throw bad('from/body fehlen');
      const reply = () => (b.From ? text('<Response></Response>', 'text/xml') : { ok: true });
      // Twilio and the SMS gateways resend a message they think was lost: one message id is taken once.
      if (!firstSeen(app, ctx.params.loc, 'sms-hook', inboundMessageId(b))) return reply();
      receiveMessage(app, ctx.params.loc, { channel: 'sms', from, body });
      return reply();
    });
    // Mail forwarding services (e.g. Cloudflare Email Workers, ImprovMX, Mailgun routes) post here.
    router.post('/hooks/:loc/email', 'public', (ctx) => {
      checkKey(ctx.params.loc, ctx.query.get('key'));
      const b = ctx.body;
      const rawFrom = String(b.from ?? b.sender ?? b.From ?? '');
      const email = rawFrom.match(/<([^>]+)>/)?.[1] ?? rawFrom;
      const name = rawFrom.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim();
      const body = scalar(b.text ?? b['body-plain'] ?? b.body ?? b.html ?? '');
      if (!email.includes('@') || !body) throw bad('from/text fehlen');
      // Forwarding services retry when they miss our answer: the same Message-Id is taken once.
      if (!firstSeen(app, ctx.params.loc, 'email-hook', inboundMessageId(b))) return { ok: true, duplicate: true };
      receiveMessage(app, ctx.params.loc, { channel: 'email', from: email.trim(), name, subject: String(b.subject ?? b.Subject ?? ''), body, to: String(b.to ?? b.recipient ?? b.To ?? '').slice(0, 1000) });
      return { ok: true };
    });
  },
};
