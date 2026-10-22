import type { App } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { canModify, canRead, canSend } from './mailbox-kit.js';
import { getMailbox, type MailboxRow } from './mailbox-sync.js';
import { parseJson } from '../core/db.js';

/**
 * Who may use which mailbox. A sub-account's mailbox belongs to that sub-account (everyone with the Konversationen
 * area there may read and answer through it; managing it is the settings area). A personal mailbox belongs to
 * one person: only they may use it, and only in a browser session or the app – never through an API key, an
 * agency key or the MCP endpoint, because those act for a sub-account or an agency, not for that person.
 */

export type Need = 'read' | 'modify' | 'send';
type Who = Pick<Ctx, 'locationId' | 'user' | 'via'>;

const PERSONAL_VIA = ['session', 'app'];

export function mayUseMailbox(who: Who, mb: Pick<MailboxRow, 'scope' | 'location_id' | 'owner_user_id' | 'access'>, need: Need = 'read'): boolean {
  const ok = need === 'read' ? canRead(mb.access) : need === 'modify' ? canModify(mb.access) : canSend(mb.access);
  if (!ok) return false;
  if (mb.scope === 'location') return !!who.locationId && mb.location_id === who.locationId;
  return !!who.user && who.user.id === mb.owner_user_id && PERSONAL_VIA.includes(String(who.via ?? ''));
}

/** Managing (settings, reconnect, disconnect): the sub-account's mailbox from its settings, a personal one only by its owner in the browser. */
export function mailboxManageable(who: Who, mb: Pick<MailboxRow, 'scope' | 'location_id' | 'owner_user_id'>): boolean {
  if (who.via !== 'session') return false;
  if (mb.scope === 'location') return mb.location_id === who.locationId;
  return !!who.user && who.user.id === mb.owner_user_id;
}

const COLS = ['folders', 'rules', 'state', 'push', 'last_result'];

/** Every mailbox this caller may see in the current sub-account (any access level). */
export function visibleMailboxes(app: App, who: Who): MailboxRow[] {
  const rows = app.db.all(`SELECT * FROM mailboxes WHERE (scope = 'location' AND location_id = ?) OR (scope = 'user' AND owner_user_id = ?) ORDER BY created_at`, who.locationId, who.user?.id ?? '');
  return rows.map((r) => parseJson(r, COLS) as MailboxRow).filter((mb) => (mb.scope === 'location' ? true : PERSONAL_VIA.includes(String(who.via ?? ''))));
}

/** The mailbox with this id if the caller may use it (otherwise undefined – callers answer 404). */
export function usableMailbox(app: App, who: Who, id: unknown, need: Need = 'read'): MailboxRow | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  const mb = getMailbox(app, id);
  return mb && mayUseMailbox(who, mb, need) ? mb : undefined;
}
