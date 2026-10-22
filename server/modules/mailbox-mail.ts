import type { LocationRow, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, clampLimit, notFound, str, type Ctx } from '../core/http.js';
import { callRoute, ownLocation, scope } from '../services/mobile.js';
import type { OutMail } from '../services/messaging.js';
import { OAuthError } from '../services/oauth.js';
import { usableMailbox, visibleMailboxes } from '../services/mailbox-access.js';
import { FOLDER_FILTERS, actOnConversation, threadInfo } from '../services/mailbox-actions.js';
import { MailError, canSend } from '../services/mailbox-kit.js';
import { mailboxOut } from '../services/mailbox-out.js';
import { createDraft, deleteDraft, runScheduled, sendDraft, sendMail, sendRaw, updateDraft, type Actor, type MailInput } from '../services/mailbox-send.js';
import { apiFor, flushOutbox, getMailbox, getMap, type MailboxRow } from '../services/mailbox-sync.js';
import type { Tool } from './mcp.js';

/**
 * The inbox side of native mailboxes (/api/mail/*, area Konversationen): which mailboxes are usable, archive and
 * labels on a conversation, answering a thread through the mailbox, new mail, drafts that live in Gmail/Outlook,
 * scheduled send, search, attachment download. Also: the mailbox as sender for workflow e-mails (provider
 * "Verbundenes Postfach"), the four MCP tools and the mobile endpoints.
 */

const actor = (ctx: Ctx): Actor => ({ locationId: ctx.locationId, userId: ctx.user?.id ?? null });

/** Provider failures become answers the person can read (and a reconnect hint when the grant is gone). */
async function viaProvider<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof OAuthError) throw new HttpError(409, e.needsReconnect ? 'Zugriff auf das Postfach abgelaufen oder entzogen – bitte neu verbinden' : e.message);
    if (e instanceof MailError) throw new HttpError(e.status === 403 ? 403 : e.status === 404 ? 404 : 502, e.message);
    throw e;
  }
}

const TOOL_ANNOTATIONS = { read: { readOnlyHint: true, openWorldHint: false }, write: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, send: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } };
const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects); mit einem Sub-Account-Schlüssel weglassen' } };
const MAIL_FIELDS = {
  mailbox_id: { type: 'string', description: 'Postfach (id aus ghl_mailbox_list)' },
  to: { type: ['array', 'string'], items: { type: 'string' }, description: 'Empfänger (E-Mail-Adressen)' },
  cc: { type: ['array', 'string'], items: { type: 'string' } },
  bcc: { type: ['array', 'string'], items: { type: 'string' } },
  subject: { type: 'string' },
  body: { type: 'string', description: 'Text der Nachricht (Klartext; mit html=true HTML). Die Signatur des Postfachs wird angehängt.' },
  html: { type: 'boolean', description: 'body ist HTML' },
  reply_to_message_id: { type: 'string', description: 'Nachricht (id aus ghl_mail_search / ghl_get_conversation), auf die geantwortet wird – die Antwort bleibt im selben Thread' },
  contact_id: { type: 'string', description: 'Kontakt, in dessen Konversation die Nachricht landet (sonst der erste Empfänger)' },
  attachments: { type: 'array', items: { type: 'object', properties: { filename: { type: 'string' }, content_base64: { type: 'string' }, content_type: { type: 'string' } }, required: ['filename', 'content_base64'] }, description: 'Anhänge (zusammen höchstens 8 MB)' },
};

const TOOLS: Tool[] = [
  {
    name: 'ghl_mailbox_list',
    title: 'Verbundene Postfächer',
    description: 'Gmail- und Outlook-Postfächer, die in diesem Sub-Account verbunden sind (id, Adresse, Anbieter, Status, letzter Abgleich, ob gesendet/verwaltet werden darf). Persönliche Postfächer einzelner Personen sind hier nicht sichtbar.',
    inputSchema: { type: 'object', properties: { ...LOC }, additionalProperties: false },
    annotations: TOOL_ANNOTATIONS.read,
    run: (call, a) => call.api('GET', '/api/mail/mailboxes', { location: a.location_id }),
  },
  {
    name: 'ghl_mail_search',
    title: 'E-Mails durchsuchen',
    description:
      'Sucht in den synchronisierten E-Mails eines Sub-Accounts (Betreff, Text, Absender/Empfänger-Kontakt). Filter: mailbox_id, folder (inbox|archive|sent|drafts|all), unread, label. remote=true sucht zusätzlich direkt bei Gmail/Outlook (mailbox_id nötig) und liefert auch Mails außerhalb des Abgleich-Zeitraums.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        q: { type: 'string', description: 'Suchtext' },
        mailbox_id: { type: 'string' },
        folder: { type: 'string', enum: FOLDER_FILTERS },
        unread: { type: 'boolean' },
        label: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        remote: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    annotations: TOOL_ANNOTATIONS.read,
    run: (call, a) => {
      const q = new URLSearchParams();
      for (const k of ['q', 'mailbox_id', 'folder', 'label', 'limit']) if (a[k] !== undefined && a[k] !== '') q.set(k, String(a[k]));
      if (a.unread) q.set('unread', '1');
      if (a.remote) q.set('remote', '1');
      return call.api('GET', `/api/mail/search${q.size ? `?${q}` : ''}`, { location: a.location_id });
    },
  },
  {
    name: 'ghl_mail_draft',
    title: 'E-Mail-Entwurf anlegen',
    description:
      'Legt einen Entwurf im Postfach an (er erscheint auch in Gmail/Outlook unter „Entwürfe“ und in der Konversation) – es wird nichts gesendet. Mit draft_id (Nachrichten-id eines Entwurfs) wird ein bestehender Entwurf geändert. Antworten: reply_to_message_id setzen, dann bleibt der Entwurf im Thread.',
    inputSchema: { type: 'object', properties: { ...LOC, ...MAIL_FIELDS, draft_id: { type: 'string', description: 'Entwurf ändern statt neu anlegen (Nachrichten-id)' }, signature: { type: 'boolean', description: 'Signatur anhängen (Standard: ja)' } }, required: ['body'], additionalProperties: false },
    annotations: TOOL_ANNOTATIONS.write,
    run: (call, a) => {
      const { location_id: _l, draft_id, ...body } = a;
      return draft_id ? call.api('PUT', `/api/mail/drafts/${encodeURIComponent(draft_id)}`, { location: a.location_id, body }) : call.api('POST', '/api/mail/drafts', { location: a.location_id, body });
    },
  },
  {
    name: 'ghl_mail_send',
    title: 'E-Mail über Postfach senden',
    description:
      'Sendet eine E-Mail über ein verbundenes Postfach (echt, vom Konto der Person/des Sub-Accounts) – neu oder als Antwort im selben Thread (reply_to_message_id). draft_id sendet einen vorhandenen Entwurf. send_at (ISO-Zeit, bis 90 Tage voraus) plant das Senden. Die Nachricht landet in der Konversation des Kontakts.',
    inputSchema: { type: 'object', properties: { ...LOC, ...MAIL_FIELDS, draft_id: { type: 'string', description: 'Vorhandenen Entwurf senden (Nachrichten-id)' }, send_at: { type: 'string', description: 'ISO-Zeitpunkt für geplantes Senden' }, signature: { type: 'boolean' }, reply_all: { type: 'boolean' }, track: { type: 'boolean', description: 'false = diese Mail ohne Öffnungs- und Klick-Verfolgung senden (ob das Postfach überhaupt verfolgt, stellt die Person in den Postfach-Einstellungen ein; true schaltet nichts ein)' } }, additionalProperties: false },
    annotations: TOOL_ANNOTATIONS.send,
    run: (call, a) => {
      const { location_id: _l, draft_id, ...body } = a;
      if (draft_id) return call.api('POST', `/api/mail/drafts/${encodeURIComponent(draft_id)}/send`, { location: a.location_id, body: {} });
      if (!a.body) throw new HttpError(400, 'body fehlt');
      return call.api('POST', '/api/mail/send', { location: a.location_id, body });
    },
  },
];

export const mailboxMailModule: Module = {
  name: 'mailbox-mail',
  register(app) {
    const { db, router } = app;
    const mailboxOf = (ctx: Ctx, id: unknown, need: 'read' | 'modify' | 'send' = 'read') => {
      const mb = usableMailbox(app, ctx, id, need);
      if (mb) return mb;
      // A mailbox the caller may see but that was connected with less access says so; anything else does not exist.
      const seen = usableMailbox(app, ctx, id, 'read') ?? usableMailbox(app, ctx, id, 'send');
      if (seen) throw new HttpError(403, need === 'send' ? 'Dieses Postfach darf nicht senden (nur Lesezugriff)' : need === 'modify' ? 'Dieses Postfach darf nicht verändert werden (nur Lese- oder Sendezugriff)' : 'Dieses Postfach darf nicht gelesen werden (nur Sendezugriff)');
      throw notFound('Postfach nicht gefunden');
    };
    const conversationOf = (ctx: Ctx) => {
      const c = db.get<{ id: string; contact_id: string }>('SELECT id, contact_id FROM conversations WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound('Konversation nicht gefunden');
      return c;
    };
    const usable = (ctx: Ctx, need: 'read' | 'modify' | 'send' = 'read') => visibleMailboxes(app, ctx).filter((mb) => mb.enabled && usableMailbox(app, ctx, mb.id, need));
    const flush = async (ids: string[]) => {
      let pending = 0;
      for (const id of ids) {
        await flushOutbox(app, id).catch(() => undefined);
        pending += Number(db.get('SELECT COUNT(*) AS n FROM mailbox_outbox WHERE mailbox_id = ?', id)?.n ?? 0);
      }
      return pending;
    };

    // --- mailboxes and thread info ------------------------------------------------------------------------
    router.get('/api/mail/mailboxes', 'location', (ctx) =>
      visibleMailboxes(app, ctx).map((mb) => {
        const o = mailboxOut(app, mb, ctx);
        return { id: o.id, name: o.name, address: o.address, provider: o.provider, scope: o.scope, access: o.access, enabled: o.enabled, status: o.status, last_sync_at: o.last_sync_at, signature: o.signature, track_engagement: o.track_engagement, can_read: o.can_read, can_modify: o.can_modify, can_send: o.can_send, mine: o.mine, messages: o.messages };
      }),
    );

    /** Remembers label names for the badges in the inbox. */
    const rememberLabels = (mb: MailboxRow, labels: { id: string; name: string }[]) => {
      const cur = getMailbox(app, mb.id);
      if (cur) db.run('UPDATE mailboxes SET state = ? WHERE id = ?', JSON.stringify({ ...cur.state, labels: { ...(cur.state.labels ?? {}), ...Object.fromEntries(labels.map((l) => [l.id, l.name])) }, labels_at: new Date().toISOString() }), mb.id);
    };
    router.get('/api/mail/mailboxes/:id/labels', 'location', async (ctx) => {
      const mb = mailboxOf(ctx, ctx.params.id, 'read');
      const labels = await viaProvider(() => apiFor(app, mb).labels());
      rememberLabels(mb, labels);
      return labels;
    });
    router.post('/api/mail/mailboxes/:id/labels', 'location', async (ctx) => {
      const mb = mailboxOf(ctx, ctx.params.id, 'modify');
      const name = str(ctx.body.name, 'Name', { required: true, max: 100 });
      const label = await viaProvider(() => apiFor(app, mb).createLabel(name));
      rememberLabels(mb, [label]);
      return label;
    });

    router.get('/api/mail/conversations/:id', 'location', (ctx) => {
      const c = conversationOf(ctx);
      const info = threadInfo(app, ctx, c.id);
      // What a reply would look like: answer the newest mail we received (or write to the contact).
      const last = db.get<{ id: string; subject: string }>(`SELECT id, subject FROM messages WHERE conversation_id = ? AND channel = 'email' AND status != 'draft' ORDER BY CASE direction WHEN 'in' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`, c.id);
      const contact = db.get<{ email: string }>('SELECT email FROM contacts WHERE id = ?', c.contact_id);
      return { ...info, reply: { reply_to_message_id: last?.id ?? null, subject: last?.subject ?? '', to: contact?.email ?? '' } };
    });

    // --- archive and labels ---------------------------------------------------------------------------------
    router.post('/api/mail/conversations/:id/archive', 'location', async (ctx) => {
      const c = conversationOf(ctx);
      const archive = ctx.body?.archive !== false;
      const mailboxId = ctx.body?.mailbox_id ? String(ctx.body.mailbox_id) : undefined;
      if (mailboxId) mailboxOf(ctx, mailboxId, 'modify');
      const r = actOnConversation(app, ctx, c.id, { kind: 'archive', archive }, mailboxId);
      if (!r.changed) throw new HttpError(409, archive ? 'Es gibt nichts zu archivieren (keine Mail im Posteingang eines Postfachs, das du ändern darfst)' : 'Es gibt nichts zurückzuholen');
      return { ok: true, archived: archive, changed: r.changed, pending: await flush(r.mailboxes) };
    });

    router.post('/api/mail/conversations/:id/labels', 'location', async (ctx) => {
      const c = conversationOf(ctx);
      const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).slice(0, 300)).filter(Boolean))].slice(0, 20) : []);
      const add = list(ctx.body?.add);
      const remove = list(ctx.body?.remove);
      if (!add.length && !remove.length) throw bad('Nichts zu ändern (add / remove)');
      const mailboxId = ctx.body?.mailbox_id ? String(ctx.body.mailbox_id) : undefined;
      if (mailboxId) mailboxOf(ctx, mailboxId, 'modify');
      const r = actOnConversation(app, ctx, c.id, { kind: 'labels', add, remove }, mailboxId);
      if (!r.changed) throw new HttpError(409, 'Keine Mail dieser Konversation liegt in einem Postfach, das du ändern darfst');
      return { ok: true, changed: r.changed, pending: await flush(r.mailboxes) };
    });

    // --- reply, send, drafts, scheduled ---------------------------------------------------------------------
    router.post('/api/mail/send', 'location', async (ctx) => {
      const mb = mailboxOf(ctx, ctx.body?.mailbox_id, 'send');
      return viaProvider(() => sendMail(app, mb, actor(ctx), ctx.body as MailInput));
    });

    router.post('/api/mail/conversations/:id/reply', 'location', async (ctx) => {
      const c = conversationOf(ctx);
      const last = db.get<{ id: string }>(`SELECT id FROM messages WHERE conversation_id = ? AND channel = 'email' AND status != 'draft' ORDER BY CASE direction WHEN 'in' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`, c.id);
      // The mailbox that holds the mail answered, else the sub-account's first one that may send.
      let mb: MailboxRow | undefined;
      if (ctx.body?.mailbox_id) mb = mailboxOf(ctx, ctx.body.mailbox_id, 'send');
      else {
        const held = last ? db.all<{ mailbox_id: string }>('SELECT mailbox_id FROM mailbox_messages WHERE message_id = ? AND location_id = ?', last.id, ctx.locationId) : [];
        for (const h of held) mb ??= usableMailbox(app, ctx, h.mailbox_id, 'send');
        mb ??= usable(ctx, 'send')[0];
      }
      if (!mb) throw new HttpError(409, 'Kein Postfach zum Senden verbunden (Einstellungen → E-Mail & SMS → Postfach verbinden)');
      const b = ctx.body ?? {};
      const input: MailInput = { ...b, reply_to_message_id: last?.id, contact_id: c.contact_id };
      if (!last && !b.to) {
        const email = db.get<{ email: string }>('SELECT email FROM contacts WHERE id = ?', c.contact_id)?.email;
        if (!email) throw bad('Der Kontakt hat keine E-Mail-Adresse');
        input.to = [email];
      }
      return viaProvider(() => sendMail(app, mb!, actor(ctx), input));
    });

    router.get('/api/mail/drafts', 'location', (ctx) => {
      const ids = usable(ctx, 'read').map((mb) => mb.id);
      if (!ids.length) return [];
      return db
        .all<any>(
          `SELECT m.id, m.subject, substr(m.body, 1, 300) AS snippet, m.created_at, m.conversation_id, m.contact_id, mm.mailbox_id, mm.thread_id, mm.addrs, c.first_name, c.last_name, c.email
           FROM messages m JOIN mailbox_messages mm ON mm.message_id = m.id AND mm.location_id = m.location_id JOIN contacts c ON c.id = m.contact_id
           WHERE m.location_id = ? AND m.status = 'draft' AND mm.folder = 'drafts' AND mm.mailbox_id IN (${ids.map(() => '?').join(',')}) ORDER BY m.created_at DESC LIMIT 200`,
          ctx.locationId,
          ...ids,
        )
        .map((r) => ({ ...parseJson(r, ['addrs']), to: (r.addrs?.to ?? []).map((a: { email: string }) => a.email) }));
    });
    router.post('/api/mail/drafts', 'location', async (ctx) => {
      const mb = mailboxOf(ctx, ctx.body?.mailbox_id, 'send');
      return viaProvider(() => createDraft(app, mb, actor(ctx), ctx.body as MailInput));
    });
    /** The mailbox that holds this draft, if the caller may send through it. */
    const draftMailbox = (ctx: Ctx): MailboxRow => {
      const rows = db.all<{ mailbox_id: string }>(`SELECT mailbox_id FROM mailbox_messages WHERE message_id = ? AND location_id = ? AND folder = 'drafts'`, ctx.params.id, ctx.locationId);
      for (const r of rows) {
        const mb = usableMailbox(app, ctx, r.mailbox_id, 'send');
        if (mb) return mb;
      }
      throw notFound('Entwurf nicht gefunden');
    };
    router.put('/api/mail/drafts/:id', 'location', async (ctx) => viaProvider(() => updateDraft(app, draftMailbox(ctx), actor(ctx), ctx.params.id, ctx.body as MailInput)));
    router.post('/api/mail/drafts/:id/send', 'location', async (ctx) => viaProvider(() => sendDraft(app, draftMailbox(ctx), actor(ctx), ctx.params.id)));
    router.delete('/api/mail/drafts/:id', 'location', async (ctx) => viaProvider(() => deleteDraft(app, draftMailbox(ctx), actor(ctx), ctx.params.id)));

    router.get('/api/mail/scheduled', 'location', (ctx) => {
      const mine = ctx.user?.id ?? '';
      return db
        .all<any>(`SELECT id, mailbox_id, send_at, input, status, attempts, error, created_at, sent_at FROM mailbox_scheduled WHERE location_id = ? AND status IN ('pending', 'sending', 'failed') ORDER BY send_at LIMIT 200`, ctx.locationId)
        .filter((r) => !!usableMailbox(app, ctx, r.mailbox_id, 'read') || r.user_id === mine)
        .map((r) => {
          const i = JSON.parse(r.input);
          // The recipient is stored as it was sent in (a string or a list): always a list of addresses here.
          const to = (Array.isArray(i.to) ? i.to : [i.to]).filter(Boolean).map((a: unknown) => String(a));
          return { id: r.id, mailbox_id: r.mailbox_id, send_at: r.send_at, status: r.status, error: r.error, subject: String(i.subject ?? ''), to };
        });
    });
    router.delete('/api/mail/scheduled/:id', 'location', (ctx) => {
      const r = db.get<{ mailbox_id: string }>(`SELECT mailbox_id FROM mailbox_scheduled WHERE id = ? AND location_id = ? AND status IN ('pending', 'failed')`, ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Geplante Nachricht nicht gefunden');
      mailboxOf(ctx, r.mailbox_id, 'send');
      db.run(`UPDATE mailbox_scheduled SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'failed')`, ctx.params.id);
      return { ok: true };
    });

    // --- search ------------------------------------------------------------------------------------------------
    const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    router.get('/api/mail/search', 'location', async (ctx) => {
      const q = (ctx.query.get('q') ?? '').trim().slice(0, 200);
      const limit = clampLimit(ctx.query.get('limit'), 20, 100);
      const mailboxId = ctx.query.get('mailbox_id');
      let boxes = usable(ctx, 'read');
      if (mailboxId) boxes = [mailboxOf(ctx, mailboxId, 'read')];
      const out: Record<string, unknown> = { results: [], remote: [] };
      if (boxes.length) {
        const where = ['m.location_id = ?', `mm.mailbox_id IN (${boxes.map(() => '?').join(',')})`];
        const args: unknown[] = [ctx.locationId, ...boxes.map((b) => b.id)];
        for (const term of q.split(/\s+/).filter(Boolean).slice(0, 5)) {
          where.push(`(m.subject LIKE ? ESCAPE '\\' OR m.body LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR (c.first_name || ' ' || c.last_name) LIKE ? ESCAPE '\\')`);
          args.push(like(term), like(term), like(term), like(term));
        }
        const folder = ctx.query.get('folder');
        if (folder && FOLDER_FILTERS.includes(folder) && folder !== 'all') {
          where.push('mm.folder = ?');
          args.push(folder);
        } else where.push(`mm.folder NOT IN ('deleted', 'trash', 'spam')`);
        if (ctx.query.get('unread') === '1') where.push('mm.unread = 1');
        const label = ctx.query.get('label');
        if (label) {
          where.push('EXISTS (SELECT 1 FROM json_each(mm.labels) WHERE value = ?)');
          args.push(label);
        }
        out.results = db
          .all<any>(
            `SELECT m.id, m.conversation_id, m.contact_id, m.subject, substr(m.body, 1, 300) AS snippet, m.direction, m.status, m.created_at, c.first_name, c.last_name, c.email,
                    mm.mailbox_id, mm.folder, mm.unread, mm.starred, mm.labels, mm.thread_id
             FROM messages m JOIN mailbox_messages mm ON mm.message_id = m.id AND mm.location_id = m.location_id JOIN contacts c ON c.id = m.contact_id
             WHERE ${where.join(' AND ')} GROUP BY m.id ORDER BY m.created_at DESC LIMIT ?`,
            ...(args as any[]),
            limit,
          )
          .map((r) => ({ ...parseJson(r, ['labels']), unread: !!r.unread, starred: !!r.starred }));
      }
      // Straight at Gmail/Outlook: finds mail outside the window that was imported.
      if (ctx.query.get('remote') === '1') {
        if (!mailboxId) throw bad('Für die Suche direkt beim Anbieter mailbox_id angeben');
        if (!q) throw bad('Suchtext fehlt');
        const mb = boxes[0];
        if (!mb || !mb.enabled) throw notFound('Postfach nicht gefunden');
        const found = await viaProvider(() => apiFor(app, mb).search(q, limit));
        out.remote = found.map((m) => ({ id: m.id, thread_id: m.threadId, subject: m.subject, from: m.from, to: m.to, date: m.date, snippet: m.snippet || m.text.slice(0, 300), unread: m.unread, imported: !!getMap(app, mb.id, m.id) }));
      }
      return out;
    });

    // --- attachments: streamed from the provider on demand, always as a download --------------------------------------
    router.get('/api/mail/attachments/:messageId/:index', 'location', async (ctx) => {
      const mb = mailboxOf(ctx, ctx.query.get('mailbox'), 'read');
      const row = db.get<{ remote_id: string }>('SELECT remote_id FROM mailbox_messages WHERE mailbox_id = ? AND message_id = ? AND location_id = ?', mb.id, ctx.params.messageId, ctx.locationId);
      const map = row ? getMap(app, mb.id, row.remote_id) : undefined;
      const att = map?.attachments[Number(ctx.params.index)];
      if (!map || !att?.id) throw notFound('Anhang nicht gefunden');
      const api = apiFor(app, mb);
      let data: Buffer;
      try {
        data = await viaProvider(() => api.attachment(map.remote_id, att.id));
      } catch (e) {
        // Gmail attachment ids can go stale: find the same file in a fresh copy of the message.
        if (!(e instanceof HttpError) || e.status !== 404) throw e;
        const fresh = await viaProvider(() => api.get(map.remote_id));
        const same = fresh?.attachments.find((a) => a.name === att.name && a.size === att.size);
        if (!same) throw e;
        data = await viaProvider(() => api.attachment(map.remote_id, same.id));
      }
      const name = att.name.replace(/[\r\n"\\]/g, '_');
      return { __raw: true, status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(att.name)}`, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, no-store' }, body: data };
    });

    // --- workflow e-mails and the composer through a mailbox ------------------------------------------------------------
    app.services.emailTransports = {
      ...(app.services.emailTransports ?? {}),
      mailbox: async (loc: LocationRow, mail: OutMail) => {
        const mb = getMailbox(app, String(loc.settings.email?.mailbox_id ?? ''));
        if (!mb || mb.scope !== 'location' || mb.location_id !== loc.id) throw new Error('Kein Postfach gewählt (Einstellungen → E-Mail & SMS → Anbieter „Verbundenes Postfach“)');
        if (!canSend(mb.access)) throw new Error('Dieses Postfach darf nicht senden');
        const r = await sendRaw(app, mb, mail);
        return { status: 'sent' as const, providerId: r.providerId };
      },
    };

    // --- background: scheduled send --------------------------------------------------------------------------------------
    let busy = false;
    app.onTick(async () => {
      if (busy) return;
      busy = true;
      try {
        await runScheduled(app);
      } finally {
        busy = false;
      }
    });

    // --- MCP tools ---------------------------------------------------------------------------------------------------------
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    // --- mobile app --------------------------------------------------------------------------------------------------------
    router.get('/api/mobile/mailboxes', 'user', (ctx) => {
      const locs = scope(app, ctx, 'conversations', { strict: false });
      const names = new Map(locs.map((l) => [l.id, l.name]));
      const out: unknown[] = [];
      for (const l of locs) {
        for (const mb of visibleMailboxes(app, { ...ctx, locationId: l.id })) {
          if (mb.scope === 'location' && !names.has(mb.location_id ?? '')) continue;
          if (out.some((o: any) => o.id === mb.id)) continue;
          const o = mailboxOut(app, mb, { ...ctx, locationId: l.id });
          out.push({ id: o.id, name: o.name, address: o.address, provider: o.provider, scope: o.scope, location_id: mb.location_id, location_name: mb.location_id ? names.get(mb.location_id) ?? '' : '', status: o.status, last_sync_at: o.last_sync_at, can_send: o.can_send, can_modify: o.can_modify });
        }
      }
      return { mailboxes: out };
    });
    router.post('/api/mobile/conversations/:id/mail-reply', 'user', async (ctx) => {
      ctx.skipAfterWrite = true;
      const loc = ownLocation(app, ctx, 'conversations', ctx.params.id, 'Konversation nicht gefunden');
      const b = ctx.body ?? {};
      const body = { body: str(b.body, 'Nachricht', { required: true, max: 100_000 }), ...(b.subject ? { subject: str(b.subject, 'Betreff', { max: 300 }) } : {}), ...(b.mailbox_id ? { mailbox_id: String(b.mailbox_id) } : {}), ...(b.send_at ? { send_at: String(b.send_at) } : {}), ...(b.signature === false ? { signature: false } : {}) };
      return callRoute(app, ctx, 'POST', `/api/mail/conversations/${encodeURIComponent(ctx.params.id)}/reply`, { locationId: loc.id, body });
    });
  },
};
