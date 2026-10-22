import type { App } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { parseJson } from '../core/db.js';
import { mayUseMailbox, usableMailbox, visibleMailboxes } from './mailbox-access.js';
import type { MsgChange } from './mailbox-kit.js';
import { applyLocal, getMailbox, getMap, queueChange, type MailboxRow, type MapRow } from './mailbox-sync.js';

/**
 * What people do with mail in the inbox: archive, label, read/unread, star – applied to our copy at once and
 * sent to Gmail / Outlook through the outbox. Also the read side the inbox needs: filters for the conversation
 * list, per-conversation mailbox info, and the details of a thread (attachments, labels, folders).
 */

type Who = Pick<Ctx, 'locationId' | 'user' | 'via'>;

const BOX = (mb: MailboxRow) => ({ id: mb.id, name: mb.name, address: mb.shared_address || mb.address, provider: mb.provider, scope: mb.scope, track_engagement: !!mb.track_engagement });

/** Mappings of the non-draft mail of a conversation in this sub-account, with the direction and time of each message. */
function threadMaps(app: App, conversationId: string, locationId: string) {
  return app.db
    .all<any>(
      `SELECT mm.mailbox_id, mm.remote_id, m.direction, m.created_at FROM mailbox_messages mm JOIN messages m ON m.id = mm.message_id
       WHERE mm.conversation_id = ? AND mm.location_id = ? AND mm.folder NOT IN ('drafts', 'deleted', 'trash', 'spam') ORDER BY m.created_at DESC`,
      conversationId,
      locationId,
    )
    .map((r) => ({ map: getMap(app, r.mailbox_id, r.remote_id)!, direction: r.direction as string, at: r.created_at as string }));
}

export type ConversationAction = { kind: 'archive'; archive: boolean } | { kind: 'labels'; add: string[]; remove: string[] } | { kind: 'read'; read: boolean } | { kind: 'star'; starred: boolean };

/**
 * Applies an action to the mail of a conversation. Only mailboxes the caller may change (modify access) are
 * touched; `mailboxId` narrows it to one. Returns the mailboxes whose outbox should be flushed.
 */
export function actOnConversation(app: App, who: Who, conversationId: string, action: ConversationAction, mailboxId?: string): { changed: number; mailboxes: string[] } {
  const usable = new Map<string, MailboxRow | null>();
  const mayChange = (id: string) => {
    if (!usable.has(id)) {
      const mb = getMailbox(app, id);
      usable.set(id, mb && mayUseMailbox(who, mb, 'modify') ? mb : null);
    }
    return !!usable.get(id);
  };
  const items = threadMaps(app, conversationId, who.locationId).filter((i) => (!mailboxId || i.map.mailbox_id === mailboxId) && mayChange(i.map.mailbox_id));
  const picks: { map: MapRow; change: MsgChange }[] = [];
  if (action.kind === 'archive') {
    for (const i of items) if (i.map.folder === (action.archive ? 'inbox' : 'archive')) picks.push({ map: i.map, change: { archived: action.archive } });
  } else if (action.kind === 'labels') {
    for (const i of items) picks.push({ map: i.map, change: { ...(action.add.length ? { addLabels: action.add } : {}), ...(action.remove.length ? { removeLabels: action.remove } : {}) } });
  } else if (action.kind === 'read') {
    if (action.read) for (const i of items) if (i.map.unread) picks.push({ map: i.map, change: { read: true } });
    // "Mark as unread" brings back the newest mail we received.
    if (!action.read) {
      const latest = items.find((i) => i.direction === 'in' && !i.map.unread);
      if (latest) picks.push({ map: latest.map, change: { read: false } });
    }
  } else if (action.kind === 'star') {
    if (action.starred) {
      const latest = items.find((i) => !i.map.starred);
      if (latest && !items.some((i) => i.map.starred)) picks.push({ map: latest.map, change: { starred: true } });
    } else for (const i of items) if (i.map.starred) picks.push({ map: i.map, change: { starred: false } });
  }
  for (const { map, change } of picks) {
    if (!Object.keys(change).length) continue;
    applyLocal(app, map, change);
    queueChange(app, map.mailbox_id, map.remote_id, change);
  }
  return { changed: picks.length, mailboxes: [...new Set(picks.map((p) => p.map.mailbox_id))] };
}

// --- reading side of the inbox ---------------------------------------------------------------------------

export const FOLDER_FILTERS = ['inbox', 'archive', 'sent', 'drafts', 'all'];

/** `?mailbox=<id|any>&folder=inbox|archive|sent|drafts|all&label=<id>` on GET /api/conversations. */
export function conversationFilter(app: App, ctx: Ctx, where: string[], params: unknown[]) {
  const mailbox = ctx.query.get('mailbox');
  if (!mailbox) return;
  const cond: string[] = ['mm.conversation_id = v.id', 'mm.location_id = v.location_id'];
  const args: unknown[] = [];
  if (mailbox !== 'any') {
    if (!usableMailbox(app, ctx, mailbox, 'read')) {
      where.push('0');
      return;
    }
    cond.push('mm.mailbox_id = ?');
    args.push(mailbox);
  }
  const folder = ctx.query.get('folder') ?? 'all';
  if (FOLDER_FILTERS.includes(folder) && folder !== 'all') {
    cond.push('mm.folder = ?');
    args.push(folder);
  } else cond.push(`mm.folder NOT IN ('deleted', 'trash', 'spam')`);
  const label = ctx.query.get('label');
  if (label) {
    cond.push('EXISTS (SELECT 1 FROM json_each(mm.labels) WHERE value = ?)');
    args.push(label);
  }
  where.push(`EXISTS (SELECT 1 FROM mailbox_messages mm WHERE ${cond.join(' AND ')})`);
  params.push(...args);
}

const rank = ['inbox', 'drafts', 'archive', 'sent', 'other', 'deleted'];

/** id → name of the labels of these mailboxes (cached by the sync; Graph categories are their own names). */
export function labelNames(app: App, mailboxIds: string[]): Record<string, string> {
  if (!mailboxIds.length) return {};
  const out: Record<string, string> = {};
  for (const r of app.db.all<{ state: string }>(`SELECT state FROM mailboxes WHERE id IN (${mailboxIds.map(() => '?').join(',')})`, ...mailboxIds)) {
    try {
      Object.assign(out, JSON.parse(r.state).labels ?? {});
    } catch {
      /* no names yet */
    }
  }
  return out;
}

/** Adds `mail: { mailboxes, folder, labels }` to the conversations that have mailbox mail (folder badges in the list). */
export function decorateConversations(app: App, who: Who, rows: any[]): any[] {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id as string);
  const maps = app.db.all<any>(
    `SELECT conversation_id, mailbox_id, folder, labels FROM mailbox_messages WHERE location_id = ? AND conversation_id IN (${ids.map(() => '?').join(',')})`,
    who.locationId,
    ...ids,
  );
  if (!maps.length) return rows;
  const visible = new Map(visibleMailboxes(app, who).map((mb) => [mb.id, mb]));
  const names = labelNames(app, [...new Set(maps.map((m) => m.mailbox_id as string))]);
  const by = new Map<string, any[]>();
  for (const m of maps) by.set(m.conversation_id, [...(by.get(m.conversation_id) ?? []), m]);
  return rows.map((r) => {
    const list = by.get(r.id);
    if (!list) return r;
    const folder = list.map((m) => m.folder as string).sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0];
    const labels = [...new Set(list.flatMap((m) => (parseJson(m, ['labels']).labels as string[]) ?? []))];
    const boxes = [...new Set(list.map((m) => m.mailbox_id as string))].map((id) => visible.get(id)).filter((mb): mb is MailboxRow => !!mb).map((mb) => ({ id: mb.id, name: mb.name }));
    return { ...r, mail: { folder, labels, label_names: Object.fromEntries(labels.map((l) => [l, names[l] ?? l])), mailboxes: boxes } };
  });
}

/** Per-message mail info for the thread: attachments, labels, flags, which mailbox. */
export function decorateMessages(app: App, who: Who, conversationId: string, rows: any[]): any[] {
  const maps = app.db.all<any>('SELECT * FROM mailbox_messages WHERE conversation_id = ? AND location_id = ?', conversationId, who.locationId).map((m) => parseJson(m, ['labels', 'attachments', 'addrs']));
  if (!maps.length) return rows;
  const visible = new Map(visibleMailboxes(app, who).map((mb) => [mb.id, mb]));
  const names = labelNames(app, [...new Set(maps.map((m) => m.mailbox_id as string))]);
  return rows.map((r) => {
    const mine = maps.filter((m) => m.message_id === r.id);
    if (!mine.length) return r;
    const first = mine[0];
    return {
      ...r,
      mail: {
        folder: first.folder,
        labels: [...new Set(mine.flatMap((m: any) => m.labels as string[]))],
        label_names: Object.fromEntries([...new Set(mine.flatMap((m: any) => m.labels as string[]))].map((l) => [l, names[l] ?? l])),
        unread: mine.some((m: any) => m.unread),
        starred: mine.some((m: any) => m.starred),
        mailboxes: mine.map((m: any) => visible.get(m.mailbox_id)).filter((mb): mb is MailboxRow => !!mb).map(BOX),
        from: first.addrs?.from ?? null,
        to: first.addrs?.to ?? [],
        cc: first.addrs?.cc ?? [],
        attachments: ((first.attachments ?? []) as { name: string; type: string; size: number; inline: boolean; id: string }[]).map((a, i) => ({ name: a.name, type: a.type, size: a.size, inline: a.inline, url: a.id ? `/api/mail/attachments/${r.id}/${i}?mailbox=${first.mailbox_id}` : '' })),
        draft: r.status === 'draft',
      },
    };
  });
}

/** What the thread panel needs: usable mailboxes, reply suggestions and the labels to pick from. */
export function threadInfo(app: App, who: Who, conversationId: string) {
  const mailboxes = visibleMailboxes(app, who).filter((mb) => mb.enabled && mayUseMailbox(who, mb, 'read'));
  const maps = app.db.all<any>('SELECT mailbox_id, folder, unread, starred FROM mailbox_messages WHERE conversation_id = ? AND location_id = ?', conversationId, who.locationId);
  const used = [...new Set(maps.map((m) => m.mailbox_id as string))];
  return {
    mailboxes: mailboxes.map((mb) => ({ ...BOX(mb), access: mb.access, can_send: mayUseMailbox(who, mb, 'send'), can_modify: mayUseMailbox(who, mb, 'modify'), in_thread: used.includes(mb.id) })),
    has_mail: maps.length > 0,
    archived: maps.length > 0 && !maps.some((m) => m.folder === 'inbox'),
    unread: maps.some((m) => m.unread),
    starred: maps.some((m) => m.starred),
  };
}
