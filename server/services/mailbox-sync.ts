import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, notFound } from '../core/http.js';
import { sliceTimer } from '../core/perf.js';
import { now } from '../core/util.js';
import { importMessages } from '../modules/email-import.js';
import { routeMail, type MailRule } from '../modules/mail-sync.js';
import { OAuthError } from './oauth.js';
import { gmailApi } from './mailbox-gmail.js';
import { graphApi } from './mailbox-graph.js';
import { MailError, canRead, formatAddress, sameAddress, type MailAccess, type MailApi, type MailProviderKind, type MsgChange, type RemoteMessage } from './mailbox-kit.js';
import { inboundGate } from './inbound-gate.js';

/**
 * The sync engine behind native mailboxes: turns what Gmail / Graph report into conversations and messages
 * (contacts matched by e-mail, routing rules for personal mailboxes), keeps a row per remote message
 * (`mailbox_messages`: thread, labels, flags, attachments) and sends changes made here back through an outbox
 * (read/unread, star, archive, labels, deleted drafts) with retries. Provider differences stay inside the clients.
 */

export interface MailboxRow {
  id: string;
  connection_id: string;
  provider: MailProviderKind;
  scope: 'location' | 'user';
  location_id: string | null;
  owner_user_id: string | null;
  name: string;
  address: string;
  shared_address: string;
  access: MailAccess;
  enabled: number;
  window_days: number;
  folders: string[];
  rules: MailRule[];
  default_location_id: string | null;
  contact_policy: 'all' | 'known';
  skip_promotions: number;
  trigger_workflows: number;
  /** 1 = mail sent from HyperLevel through this mailbox carries the open pixel and tracked links (opt-in). */
  track_engagement: number;
  signature: string;
  state: Record<string, any>;
  push: Record<string, any>;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  last_result: Record<string, any> | null;
  sync_due: number;
  next_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

const JSON_COLS = ['folders', 'rules', 'state', 'push', 'last_result'];

export function getMailbox(app: App, id: string): MailboxRow | undefined {
  return parseJson(app.db.get('SELECT * FROM mailboxes WHERE id = ?', id), JSON_COLS) as MailboxRow | undefined;
}

export const MAX_BATCH = 50;
const POLL_MS = 3 * 60_000;
const POLL_WITH_PUSH_MS = 15 * 60_000;
const FRESH_MS = 48 * 3600_000;

export function apiFor(app: App, mb: Pick<MailboxRow, 'provider' | 'connection_id' | 'shared_address'>): MailApi {
  const oauth = app.services.oauth;
  if (!oauth) throw new HttpError(503, 'OAuth-Modul fehlt');
  const fetcher: typeof fetch = oauth.fetcher();
  const token = (force?: boolean) => oauth.token(mb.connection_id, force) as Promise<string>;
  return mb.provider === 'google' ? gmailApi(fetcher, token) : graphApi(fetcher, token, mb.shared_address);
}

/** Has this mailbox's connection lost its grant (only reconnecting helps)? */
export const needsReconnect = (mb: Pick<MailboxRow, 'status' | 'last_error'>) => mb.status === 'error' && /neu verbinden/.test(mb.last_error ?? '');

/** May the owner of a personal mailbox file mail into this sub-account? (Rights can change after the rules were set.) */
export function ownerMayUse(app: App, userId: string | null, locationId: string): boolean {
  if (!userId) return false;
  const u = app.db.get('SELECT role, locations FROM users WHERE id = ?', userId);
  if (!u) return false;
  if (u.role === 'admin') return true;
  try {
    return (JSON.parse(u.locations || '[]') as string[]).includes(locationId);
  } catch {
    return false;
  }
}

const sourceLabel = (mb: Pick<MailboxRow, 'name'>) => `Postfach ${mb.name}`.slice(0, 60);
export const externalId = (mailboxId: string, remoteId: string) => `mbx:${mailboxId}:${remoteId}`;

// --- mapping rows ------------------------------------------------------------------------------------

export interface MapRow {
  mailbox_id: string;
  remote_id: string;
  location_id: string;
  message_id: string;
  conversation_id: string;
  thread_id: string;
  internet_id: string;
  refs: string;
  folder: string;
  folder_id: string;
  labels: string[];
  unread: number;
  starred: number;
  draft_id: string;
  attachments: { id: string; name: string; type: string; size: number; inline: boolean }[];
  addrs: { from: { email: string; name: string }; to: { email: string; name: string }[]; cc: { email: string; name: string }[] };
  synced_at: string;
}
const MAP_JSON = ['labels', 'attachments', 'addrs'];

export const getMap = (app: App, mailboxId: string, remoteId: string) => parseJson(app.db.get('SELECT * FROM mailbox_messages WHERE mailbox_id = ? AND remote_id = ?', mailboxId, remoteId), MAP_JSON) as MapRow | undefined;

export function saveMap(app: App, row: Partial<MapRow> & Pick<MapRow, 'mailbox_id' | 'remote_id' | 'location_id' | 'message_id' | 'conversation_id'>) {
  const full = { thread_id: '', internet_id: '', refs: '', folder: 'inbox', folder_id: '', labels: [], unread: 0, starred: 0, draft_id: '', attachments: [], addrs: { from: { email: '', name: '' }, to: [], cc: [] }, synced_at: now(), ...row };
  app.db.run(
    `INSERT INTO mailbox_messages (mailbox_id, remote_id, location_id, message_id, conversation_id, thread_id, internet_id, refs, folder, folder_id, labels, unread, starred, draft_id, attachments, addrs, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mailbox_id, remote_id) DO UPDATE SET location_id = excluded.location_id, message_id = excluded.message_id, conversation_id = excluded.conversation_id, thread_id = excluded.thread_id,
       internet_id = excluded.internet_id, refs = excluded.refs, folder = excluded.folder, folder_id = excluded.folder_id, labels = excluded.labels, unread = excluded.unread, starred = excluded.starred,
       draft_id = excluded.draft_id, attachments = excluded.attachments, addrs = excluded.addrs, synced_at = excluded.synced_at`,
    full.mailbox_id,
    full.remote_id,
    full.location_id,
    full.message_id,
    full.conversation_id,
    full.thread_id,
    full.internet_id,
    full.refs,
    full.folder,
    full.folder_id,
    JSON.stringify(full.labels),
    full.unread ? 1 : 0,
    full.starred ? 1 : 0,
    full.draft_id,
    JSON.stringify(full.attachments),
    JSON.stringify(full.addrs),
    full.synced_at,
  );
}

const addrsOf = (m: RemoteMessage) => ({ from: m.from, to: m.to, cc: m.cc });

/** The preview of a conversation follows its newest message. */
export function refreshPreview(app: App, conversationId: string) {
  const last = app.db.get('SELECT subject, body, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conversationId);
  if (last) app.db.run('UPDATE conversations SET last_message_at = ?, last_message = ? WHERE id = ?', last.created_at, String(last.subject || last.body).replace(/\s+/g, ' ').slice(0, 140), conversationId);
}

/** A local message that is the same mail (RFC Message-ID) in this sub-account: another mailbox's copy, or one we sent ourselves. */
function findLocal(app: App, locationId: string, internetId: string): { message_id: string; conversation_id: string } | undefined {
  if (!internetId) return undefined;
  return (
    app.db.get<{ message_id: string; conversation_id: string }>('SELECT message_id, conversation_id FROM mailbox_messages WHERE location_id = ? AND internet_id = ? LIMIT 1', locationId, internetId) ??
    app.db.get<{ message_id: string; conversation_id: string }>('SELECT id AS message_id, conversation_id FROM messages WHERE location_id = ? AND provider_id IN (?, ?) LIMIT 1', locationId, internetId, `<${internetId}>`)
  );
}

// --- applying what the provider reports ------------------------------------------------------------

export interface SyncCounts {
  fetched: number;
  created: number;
  updated: number;
  linked: number;
  deleted: number;
  skipped: number;
}
const zero = (): SyncCounts => ({ fetched: 0, created: 0, updated: 0, linked: 0, deleted: 0, skipped: 0 });

function directionOf(mb: MailboxRow, m: RemoteMessage): 'in' | 'out' {
  if (m.draft || m.folder === 'sent') return 'out';
  const own = (mb.shared_address || mb.address).toLowerCase();
  return sameAddress(m.from.email, own) ? 'out' : 'in';
}

function targetLocation(app: App, mb: MailboxRow, m: RemoteMessage, direction: 'in' | 'out'): string | null {
  if (mb.scope === 'location') return mb.location_id && app.location(mb.location_id) ? mb.location_id : null;
  const loc = routeMail(mb.rules ?? [], mb.default_location_id, { from: m.from.email, to: m.to.map((a) => a.email), cc: m.cc.map((a) => a.email), subject: m.subject, body: m.text, direction });
  if (!loc || !app.location(loc)) return null;
  return ownerMayUse(app, mb.owner_user_id, loc) ? loc : null;
}

/** Who the conversation is with: the sender of mail we received, the first recipient of mail we sent. */
function counterparty(m: RemoteMessage, direction: 'in' | 'out') {
  return direction === 'in' ? m.from : (m.to[0] ?? m.cc[0] ?? m.bcc[0]);
}

interface Applied {
  newInbound: { locationId: string; messageId: string }[];
}

/**
 * Writes one batch: updates what is known, links copies (same Message-ID) and files new mail into the
 * sub-account its mailbox or rules point to. Runs in one transaction; events go out after it.
 */
export function applyBatch(app: App, mb: MailboxRow, messages: RemoteMessage[], counts: SyncCounts, pending: Set<string>): Applied {
  const { db } = app;
  const applied: Applied = { newInbound: [] };
  const fresh: { remote: RemoteMessage; loc: string; direction: 'in' | 'out'; party: { email: string; name: string } }[] = [];
  db.tx(() => {
    for (const remote of messages) {
      counts.fetched++;
      const map = getMap(app, mb.id, remote.id);
      if (map) {
        updateMapped(app, mb, map, remote, counts, pending.has(remote.id));
        continue;
      }
      if (remote.partial) continue;
      if (remote.folder === 'trash' || remote.folder === 'spam' || (mb.skip_promotions && remote.bulk)) {
        counts.skipped++;
        continue;
      }
      const direction = directionOf(mb, remote);
      const loc = targetLocation(app, mb, remote, direction);
      const party = counterparty(remote, direction);
      const own = (mb.shared_address || mb.address).toLowerCase();
      if (!loc || !party?.email || sameAddress(party.email, own)) {
        counts.skipped++;
        continue;
      }
      if (mb.contact_policy === 'known' && !db.get('SELECT id FROM contacts WHERE location_id = ? AND email = ?', loc, party.email.toLowerCase())) {
        counts.skipped++;
        continue;
      }
      // The same mail again (copy in another mailbox, or sent from here / by a workflow): link, don't duplicate.
      const same = findLocal(app, loc, remote.internetId);
      if (same) {
        link(app, mb, remote, loc, same);
        counts.linked++;
        continue;
      }
      fresh.push({ remote, loc, direction, party });
    }
    const byLoc = new Map<string, typeof fresh>();
    for (const f of fresh) byLoc.set(f.loc, [...(byLoc.get(f.loc) ?? []), f]);
    for (const [loc, list] of byLoc) {
      importMessages(
        app,
        loc,
        list.map(({ remote, direction, party }) => ({
          external_id: externalId(mb.id, remote.id),
          direction,
          status: remote.draft ? 'draft' : undefined,
          from: formatAddress(remote.from),
          to: [formatAddress(party)],
          subject: remote.subject,
          body: remote.text || remote.snippet,
          date: remote.date,
          unread: direction === 'in' && remote.unread,
        })),
        { source: sourceLabel(mb) },
      );
      for (const { remote, direction } of list) {
        const row = db.get<{ id: string; conversation_id: string; contact_id: string }>('SELECT id, conversation_id, contact_id FROM messages WHERE location_id = ? AND external_id = ?', loc, externalId(mb.id, remote.id));
        if (!row) {
          counts.skipped++;
          continue;
        }
        saveMap(app, {
          mailbox_id: mb.id,
          remote_id: remote.id,
          location_id: loc,
          message_id: row.id,
          conversation_id: row.conversation_id,
          thread_id: remote.threadId,
          internet_id: remote.internetId,
          refs: remote.references,
          folder: remote.folder,
          folder_id: remote.folderId,
          labels: remote.labels,
          unread: remote.unread ? 1 : 0,
          starred: remote.starred ? 1 : 0,
          attachments: remote.attachments,
          addrs: addrsOf(remote),
        });
        if (remote.starred) db.run('UPDATE conversations SET starred = 1 WHERE id = ?', row.conversation_id);
        counts.created++;
        if (direction === 'in' && !remote.draft) {
          // Receive hook (services/inbound-gate.ts): mail of a blocked sender is archived silently and starts no workflow.
          const claim = inboundGate(app, { locationId: loc, contactId: row.contact_id, channel: 'email' });
          if (claim) claim.archive(row.conversation_id, row.id);
          else applied.newInbound.push({ locationId: loc, messageId: row.id });
        }
      }
    }
  });
  return applied;
}

/** Another copy of a mail we already have: the mapping points at the existing message; a draft that was sent becomes a sent message. */
function link(app: App, mb: MailboxRow, remote: RemoteMessage, loc: string, same: { message_id: string; conversation_id: string }) {
  const { db } = app;
  const local = db.get<{ status: string; direction: string }>('SELECT status, direction FROM messages WHERE id = ?', same.message_id);
  if (local?.status === 'draft' && !remote.draft) db.run(`UPDATE messages SET status = 'sent' WHERE id = ?`, same.message_id);
  // A draft edited over there (Gmail: a new message with the same Message-ID): its text follows.
  if (local?.status === 'draft' && remote.draft) {
    db.run('UPDATE messages SET subject = ?, body = ? WHERE id = ?', remote.subject, remote.text || remote.snippet, same.message_id);
    refreshPreview(app, same.conversation_id);
  }
  // A mail sent from here has no external id until it comes back: it gets the one of this mailbox.
  db.run('UPDATE messages SET external_id = ? WHERE id = ? AND external_id IS NULL AND NOT EXISTS (SELECT 1 FROM messages WHERE location_id = ? AND external_id = ?)', externalId(mb.id, remote.id), same.message_id, loc, externalId(mb.id, remote.id));
  saveMap(app, {
    mailbox_id: mb.id,
    remote_id: remote.id,
    location_id: loc,
    message_id: same.message_id,
    conversation_id: same.conversation_id,
    thread_id: remote.threadId,
    internet_id: remote.internetId,
    refs: remote.references,
    folder: remote.folder,
    folder_id: remote.folderId,
    labels: remote.labels,
    unread: remote.unread ? 1 : 0,
    starred: remote.starred ? 1 : 0,
    attachments: remote.attachments,
    addrs: addrsOf(remote),
  });
}

function updateMapped(app: App, mb: MailboxRow, map: MapRow, remote: RemoteMessage, counts: SyncCounts, hasPendingChange: boolean) {
  const { db } = app;
  const patch: Record<string, unknown> = { synced_at: now() };
  let starChanged = false;
  // A change made here that has not reached the provider yet wins over what the provider still says.
  if (!hasPendingChange) {
    const unread = remote.unread ? 1 : 0;
    const starred = remote.starred ? 1 : 0;
    const dir = db.get<{ direction: string }>('SELECT direction FROM messages WHERE id = ?', map.message_id)?.direction;
    if (unread !== map.unread && dir === 'in') {
      if (unread) db.run('UPDATE conversations SET unread = unread + 1 WHERE id = ?', map.conversation_id);
      else db.run('UPDATE conversations SET unread = MAX(0, unread - 1) WHERE id = ?', map.conversation_id);
    }
    patch.unread = unread;
    patch.starred = starred;
    patch.folder = remote.folder;
    if (remote.folderId) patch.folder_id = remote.folderId;
    if (!remote.partial) patch.labels = JSON.stringify(remote.labels);
    else if (remote.labels.length || map.labels.length) patch.labels = JSON.stringify(remote.labels);
    starChanged = starred !== map.starred;
  }
  if (!remote.partial) {
    if (remote.threadId) patch.thread_id = remote.threadId;
    if (remote.internetId) patch.internet_id = remote.internetId;
    if (remote.references) patch.refs = remote.references;
    if (remote.attachments.length || remote.hasAttachments === false) patch.attachments = JSON.stringify(remote.attachments);
    patch.addrs = JSON.stringify(addrsOf(remote));
    const local = db.get<{ status: string }>('SELECT status FROM messages WHERE id = ?', map.message_id);
    if (local?.status === 'draft' && remote.draft) {
      db.run('UPDATE messages SET subject = ?, body = ? WHERE id = ?', remote.subject, remote.text || remote.snippet, map.message_id);
      refreshPreview(app, map.conversation_id);
    }
  }
  // A draft that was sent over there (the DRAFT label is gone, or it moved to Sent Items) is a sent message now.
  if (!remote.draft && map.folder === 'drafts' && remote.folder !== 'drafts') {
    db.run(`UPDATE messages SET status = 'sent' WHERE id = ? AND status = 'draft'`, map.message_id);
    patch.draft_id = '';
  }
  const keys = Object.keys(patch);
  db.run(`UPDATE mailbox_messages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE mailbox_id = ? AND remote_id = ?`, ...keys.map((k) => patch[k] as any), mb.id, map.remote_id);
  if (starChanged) db.run('UPDATE conversations SET starred = EXISTS (SELECT 1 FROM mailbox_messages WHERE conversation_id = ? AND starred = 1) WHERE id = ?', map.conversation_id, map.conversation_id);
  counts.updated++;
}

/** Messages gone at the provider: unsent drafts disappear here too, everything else stays in the conversation. */
export function applyDeletes(app: App, mb: MailboxRow, deleted: { id: string; folderId?: string }[], counts: SyncCounts) {
  const { db } = app;
  db.tx(() => {
    for (const d of deleted) {
      const map = getMap(app, mb.id, d.id);
      if (!map) continue;
      // Graph reports a move as "removed" from the old folder: the message lives on in another one.
      if (d.folderId && map.folder_id && map.folder_id !== d.folderId) continue;
      const local = db.get<{ status: string }>('SELECT status FROM messages WHERE id = ?', map.message_id);
      if (map.folder === 'drafts' || local?.status === 'draft') {
        if (removeDraft(app, map)) counts.deleted++;
      } else {
        db.run(`UPDATE mailbox_messages SET folder = 'deleted', unread = 0 WHERE mailbox_id = ? AND remote_id = ?`, mb.id, map.remote_id);
        counts.deleted++;
      }
    }
  });
}

/** Removes a draft here (the message too, unless another mailbox still holds a copy of it). */
export function removeDraft(app: App, map: Pick<MapRow, 'mailbox_id' | 'remote_id' | 'message_id' | 'conversation_id'>): boolean {
  const { db } = app;
  db.run('DELETE FROM mailbox_messages WHERE mailbox_id = ? AND remote_id = ?', map.mailbox_id, map.remote_id);
  if (db.get('SELECT 1 AS x FROM mailbox_messages WHERE message_id = ?', map.message_id)) return false;
  const gone = db.run(`DELETE FROM messages WHERE id = ? AND status = 'draft'`, map.message_id).changes > 0;
  refreshPreview(app, map.conversation_id);
  return gone;
}

// --- the outbox: changes made here on their way to the provider --------------------------------------

const uniq = (a: string[]) => [...new Set(a)];

/** Merges a newer change into an older one for the same message (the newer wins; labels add up). */
export function mergeChange(old: MsgChange, next: MsgChange): MsgChange {
  const out: MsgChange = { ...old };
  for (const k of ['read', 'starred', 'archived'] as const) if (next[k] !== undefined) out[k] = next[k];
  const add = uniq([...(old.addLabels ?? []).filter((l) => !(next.removeLabels ?? []).includes(l)), ...(next.addLabels ?? [])]);
  const remove = uniq([...(old.removeLabels ?? []).filter((l) => !(next.addLabels ?? []).includes(l)), ...(next.removeLabels ?? [])]);
  if (add.length) out.addLabels = add;
  else delete out.addLabels;
  if (remove.length) out.removeLabels = remove;
  else delete out.removeLabels;
  return out;
}

export function queueChange(app: App, mailboxId: string, remoteId: string, change: MsgChange) {
  const { db } = app;
  const cur = db.get<{ id: number; args: string }>(`SELECT id, args FROM mailbox_outbox WHERE mailbox_id = ? AND ref = ? AND op = 'modify' ORDER BY id DESC LIMIT 1`, mailboxId, remoteId);
  if (cur) db.run('UPDATE mailbox_outbox SET args = ?, attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE id = ?', JSON.stringify(mergeChange(JSON.parse(cur.args), change)), cur.id);
  else db.run(`INSERT INTO mailbox_outbox (mailbox_id, op, ref, args, created_at) VALUES (?, 'modify', ?, ?, ?)`, mailboxId, remoteId, JSON.stringify(change), now());
}

export function queueDraftDelete(app: App, mailboxId: string, ref: { id: string; draftId: string }) {
  app.db.run(`INSERT INTO mailbox_outbox (mailbox_id, op, ref, args, created_at) VALUES (?, 'delete_draft', ?, ?, ?)`, mailboxId, ref.id, JSON.stringify(ref), now());
}

const backoffMs = (attempts: number) => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3600_000);
const MAX_ATTEMPTS = 12;

/** Sends the queued changes of one mailbox (or all). Failures stay queued with a growing delay; final ones are dropped. */
export async function flushOutbox(app: App, mailboxId?: string): Promise<{ done: number; failed: number }> {
  const { db } = app;
  const out = { done: 0, failed: 0 };
  const ids = mailboxId ? [mailboxId] : db.all<{ mailbox_id: string }>(`SELECT DISTINCT mailbox_id FROM mailbox_outbox WHERE next_attempt_at IS NULL OR next_attempt_at <= ?`, now()).map((r) => r.mailbox_id);
  for (const mid of ids) {
    const mb = getMailbox(app, mid);
    if (!mb) continue;
    const rows = db.all<{ id: number; op: string; ref: string; args: string; attempts: number }>(`SELECT * FROM mailbox_outbox WHERE mailbox_id = ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT 100`, mid, now());
    if (!rows.length) continue;
    const api = apiFor(app, mb);
    for (const row of rows) {
      try {
        const args = JSON.parse(row.args);
        if (row.op === 'delete_draft') await api.deleteDraft(args);
        else await api.modify(row.ref, args, mb.state);
        db.run('DELETE FROM mailbox_outbox WHERE id = ?', row.id);
        out.done++;
      } catch (e) {
        if (e instanceof OAuthError) {
          db.run('UPDATE mailboxes SET status = ?, last_error = ?, updated_at = ? WHERE id = ?', 'error', e.needsReconnect ? 'Zugriff abgelaufen oder entzogen – bitte neu verbinden' : e.message.slice(0, 300), now(), mid);
          break;
        }
        const err = e as MailError;
        const attempts = row.attempts + 1;
        if (err instanceof MailError && err.transient && attempts < MAX_ATTEMPTS) {
          db.run('UPDATE mailbox_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?', attempts, new Date(Date.now() + Math.max(backoffMs(attempts), (err.retryAfter || 0) * 1000)).toISOString(), err.message.slice(0, 300), row.id);
        } else {
          // Gone (404) or not allowed (403): retrying will not help.
          db.run('DELETE FROM mailbox_outbox WHERE id = ?', row.id);
          if (err instanceof MailError && err.status === 403) db.run('UPDATE mailboxes SET last_error = ?, updated_at = ? WHERE id = ?', `Keine Berechtigung zum Ändern von Mails: ${err.message}`.slice(0, 300), now(), mid);
        }
        out.failed++;
      }
    }
  }
  return out;
}

/** Applies a change to our own copy right away (the provider hears about it through the outbox). */
export function applyLocal(app: App, map: Pick<MapRow, 'mailbox_id' | 'remote_id' | 'conversation_id' | 'folder' | 'labels'>, change: MsgChange) {
  const { db } = app;
  const sets: string[] = [];
  const args: unknown[] = [];
  if (change.read !== undefined) {
    sets.push('unread = ?');
    args.push(change.read ? 0 : 1);
  }
  if (change.starred !== undefined) {
    sets.push('starred = ?');
    args.push(change.starred ? 1 : 0);
  }
  if (change.archived !== undefined && (map.folder === 'inbox' || map.folder === 'archive')) {
    sets.push('folder = ?');
    args.push(change.archived ? 'archive' : 'inbox');
  }
  if (change.addLabels?.length || change.removeLabels?.length) {
    const labels = uniq([...map.labels.filter((l) => !(change.removeLabels ?? []).includes(l)), ...(change.addLabels ?? [])]);
    sets.push('labels = ?');
    args.push(JSON.stringify(labels));
  }
  if (sets.length) db.run(`UPDATE mailbox_messages SET ${sets.join(', ')} WHERE mailbox_id = ? AND remote_id = ?`, ...(args as any[]), map.mailbox_id, map.remote_id);
}

// --- one sync run -------------------------------------------------------------------------------------

export interface SyncResult extends SyncCounts {
  /** More is waiting (a long first import is spread over several runs). */
  more: boolean;
  busy?: boolean;
  skippedRun?: string;
}

const running = new Set<string>();

export interface SyncOptions {
  /** Most messages to read in this run. */
  maxMessages?: number;
  /** Stop reading after this many ms. */
  deadlineMs?: number;
  /** Read the whole window again (the cursor is dropped). */
  full?: boolean;
}

const failDelay = (fails: number) => Math.min(POLL_MS * 2 ** Math.max(0, fails - 1), 3600_000);

export async function syncMailbox(app: App, mailboxId: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const { db } = app;
  const first = getMailbox(app, mailboxId);
  if (!first) throw notFound('Postfach nicht gefunden');
  const counts = zero();
  if (running.has(mailboxId)) return { ...counts, more: false, busy: true };
  if (!canRead(first.access)) {
    // Send-only mailboxes have nothing to read.
    db.run(`UPDATE mailboxes SET status = 'ok', sync_due = 0, last_error = NULL, updated_at = ? WHERE id = ?`, now(), mailboxId);
    return { ...counts, more: false, skippedRun: 'send-only' };
  }
  running.add(mailboxId);
  const maxMessages = opts.maxMessages ?? 200;
  const deadline = Date.now() + (opts.deadlineMs ?? 20_000);
  const pause = sliceTimer(40);
  const removals: { id: string; folderId?: string }[] = [];
  let state: Record<string, any> = opts.full ? {} : { ...first.state };
  let more = false;
  try {
    // What was changed here goes out first, so the provider's state does not flip it back.
    await flushOutbox(app, mailboxId).catch(() => undefined);
    let mb = getMailbox(app, mailboxId)!;
    const api = apiFor(app, mb);
    const ready = !!state.ready;
    if (!ready) db.run(`UPDATE mailboxes SET status = 'importing', updated_at = ? WHERE id = ?`, now(), mailboxId);
    const since = new Date(Date.now() - Math.max(1, mb.window_days) * 864e5).toISOString();
    const newInbound: Applied['newInbound'] = [];
    let read = 0;
    for (;;) {
      const pending = new Set(db.all<{ ref: string }>('SELECT ref FROM mailbox_outbox WHERE mailbox_id = ?', mailboxId).map((r) => r.ref));
      const out = await api.sync({ since, folders: mb.folders ?? [], state, known: (rid) => !!db.get('SELECT 1 AS x FROM mailbox_messages WHERE mailbox_id = ? AND remote_id = ?', mailboxId, rid), limit: Math.min(MAX_BATCH, Math.max(1, maxMessages - read)) });
      state = out.reset ? { ...out.state } : out.state;
      read += out.messages.length;
      if (out.messages.length) newInbound.push(...applyBatch(app, mb, out.messages, counts, pending).newInbound);
      removals.push(...out.deleted);
      db.run('UPDATE mailboxes SET state = ?, updated_at = ? WHERE id = ?', JSON.stringify(state), now(), mailboxId);
      more = out.more;
      if (!more) break;
      if (read >= maxMessages || Date.now() > deadline) break;
      await pause();
      mb = getMailbox(app, mailboxId) ?? mb;
    }
    // Removals last: a message that only moved to another folder was seen again in the meantime.
    if (removals.length) applyDeletes(app, mb, removals, counts);
    if (!more && api.drafts && (mb.folders.length === 0 || mb.folders.includes('DRAFT') || mb.folders.includes('*'))) await reconcileDrafts(app, mb, api, counts);
    if (!more) {
      state.ready = true;
      // The names of the labels (the inbox shows them as badges); refreshed a few times a day.
      if (!state.labels_at || Date.now() - Date.parse(state.labels_at) > 6 * 3600_000) {
        try {
          state.labels = Object.fromEntries((await api.labels()).map((l) => [l.id, l.name]));
          state.labels_at = now();
        } catch {
          /* names are a convenience */
        }
      }
    }
    const finished = !more;
    const interval = mb.push?.id ? POLL_WITH_PUSH_MS : POLL_MS;
    db.run(
      // sync_due 2 = a push arrived while this run was going: run again.
      `UPDATE mailboxes SET state = ?, status = 'ok', last_sync_at = ?, last_error = NULL, last_result = ?, sync_due = CASE WHEN sync_due = 2 THEN 1 ELSE ? END, next_sync_at = CASE WHEN sync_due = 2 THEN NULL ELSE ? END, updated_at = ? WHERE id = ?`,
      JSON.stringify({ ...state, fails: 0 }),
      now(),
      JSON.stringify({ ...counts, at: now() }),
      finished ? 0 : 1,
      new Date(Date.now() + (finished ? interval : 5_000)).toISOString(),
      now(),
      mailboxId,
    );
    // New mail that arrives after the first import can start workflows (the import itself never does).
    if (ready && mb.trigger_workflows) {
      for (const n of newInbound) {
        const msg = db.get('SELECT * FROM messages WHERE id = ?', n.messageId);
        if (!msg || Date.now() - Date.parse(msg.created_at) > FRESH_MS) continue;
        app.events.emit(n.locationId, 'message.inbound', { contactId: msg.contact_id, contact: db.get('SELECT * FROM contacts WHERE id = ?', msg.contact_id), message: msg });
      }
    }
    if (counts.created || counts.deleted) {
      app.services.audit?.({ action: 'mailbox.sync', summary: `${mb.name}: ${counts.created} neu${counts.linked ? `, ${counts.linked} verknüpft` : ''}${counts.deleted ? `, ${counts.deleted} gelöscht` : ''}`, locationId: mb.location_id, entityId: mb.id });
    }
    return { ...counts, more };
  } catch (e) {
    const cur = getMailbox(app, mailboxId);
    const fails = Number(cur?.state?.fails ?? 0) + 1;
    let msg = (e as Error).message || 'Fehler';
    let nextMs = failDelay(fails);
    if (e instanceof OAuthError) {
      if (e.needsReconnect) {
        msg = 'Zugriff abgelaufen oder entzogen – bitte neu verbinden';
        nextMs = 24 * 3600_000;
      }
    } else if (e instanceof MailError && (e.status === 403 || e.status === 401)) nextMs = Math.max(nextMs, 30 * 60_000);
    else if (e instanceof MailError && e.retryAfter) nextMs = Math.max(nextMs, e.retryAfter * 1000);
    db.run(
      `UPDATE mailboxes SET state = ?, status = 'error', last_error = ?, last_sync_at = ?, sync_due = 0, next_sync_at = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify({ ...state, fails }),
      msg.slice(0, 500),
      now(),
      new Date(Date.now() + nextMs).toISOString(),
      now(),
      mailboxId,
    );
    throw e;
  } finally {
    running.delete(mailboxId);
  }
}

/** Gmail only tells draft ids through users.drafts: finds drafts sent, deleted or edited over there (an edit is a new message id). */
async function reconcileDrafts(app: App, mb: MailboxRow, api: MailApi, counts: SyncCounts) {
  const { db } = app;
  const live = await api.drafts!();
  const byDraft = new Map(live.map((d) => [d.draftId, d]));
  for (const row of db.all<{ remote_id: string; draft_id: string }>(`SELECT remote_id, draft_id FROM mailbox_messages WHERE mailbox_id = ? AND draft_id != ''`, mb.id)) {
    const map = getMap(app, mb.id, row.remote_id)!;
    const d = byDraft.get(row.draft_id);
    if (!d) {
      // Sent or deleted over there (a sent draft was already promoted when its sent copy was read).
      if (removeDraft(app, map)) counts.deleted++;
    } else if (d.id !== row.remote_id) {
      // Edited over there: the draft kept its id, the message got a new one.
      const m = await api.get(d.id);
      if (!m) continue;
      db.tx(() => {
        db.run('DELETE FROM mailbox_messages WHERE mailbox_id = ? AND remote_id = ?', mb.id, row.remote_id);
        db.run('UPDATE messages SET external_id = ?, subject = ?, body = ? WHERE id = ?', externalId(mb.id, m.id), m.subject, m.text || m.snippet, map.message_id);
        saveMap(app, { ...map, remote_id: m.id, thread_id: m.threadId || map.thread_id, internet_id: m.internetId || map.internet_id, draft_id: d.draftId, attachments: m.attachments, addrs: addrsOf(m), labels: m.labels, synced_at: now() });
        refreshPreview(app, map.conversation_id);
      });
      counts.updated++;
    }
  }
  // Drafts imported this run learn their draft id (unmapped ones were read by the normal flow).
  for (const d of live) {
    const map = getMap(app, mb.id, d.id);
    if (map && map.folder === 'drafts' && map.draft_id !== d.draftId) db.run('UPDATE mailbox_messages SET draft_id = ? WHERE mailbox_id = ? AND remote_id = ?', d.draftId, mb.id, d.id);
  }
}

/** Something changed at the provider (push, or a person asked): sync soon. A run that is going on runs once more. */
export function markDue(app: App, mailboxId: string) {
  app.db.run('UPDATE mailboxes SET sync_due = ?, next_sync_at = NULL WHERE id = ?', running.has(mailboxId) ? 2 : 1, mailboxId);
}

/** Starts a sync in the background (push notifications answer first, then read). */
export function kickSync(app: App, mailboxId: string) {
  markDue(app, mailboxId);
  setImmediate(() => void syncMailbox(app, mailboxId, { maxMessages: 150, deadlineMs: 8_000 }).catch(() => undefined));
}

/** Background pass: mailboxes whose time has come (push marks them due), oldest first, a few per tick. */
export async function syncDue(app: App, limit = 3): Promise<void> {
  const rows = app.db.all<{ id: string; status: string; last_error: string | null }>(
    `SELECT id, status, last_error FROM mailboxes WHERE enabled = 1 AND access != 'send' AND (sync_due = 1 OR next_sync_at IS NULL OR next_sync_at <= ?) ORDER BY COALESCE(next_sync_at, '') LIMIT ?`,
    now(),
    limit * 3,
  );
  let n = 0;
  for (const r of rows) {
    if (n >= limit) break;
    if (needsReconnect(r)) continue;
    n++;
    try {
      await syncMailbox(app, r.id, { maxMessages: 150, deadlineMs: 10_000 });
    } catch {
      /* recorded on the mailbox */
    }
  }
}

