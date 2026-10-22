import type { App } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { mailboxManageable } from './mailbox-access.js';
import { canModify, canRead, canSend } from './mailbox-kit.js';
import { needsReconnect, type MailboxRow } from './mailbox-sync.js';

/** What the browser may see of a mailbox: never tokens, cursors or push secrets. */
export function mailboxOut(app: App, mb: MailboxRow, who?: Pick<Ctx, 'locationId' | 'user' | 'via'>) {
  const conn = app.db.get<{ account_email: string; scopes: string; status: string; last_error: string | null }>('SELECT account_email, scopes, status, last_error FROM oauth_connections WHERE id = ?', mb.connection_id);
  const messages = Number(app.db.get('SELECT COUNT(*) AS n FROM mailbox_messages WHERE mailbox_id = ?', mb.id)?.n ?? 0);
  const reconnect = needsReconnect(mb) || (conn?.status === 'error' && /neu verbinden/.test(conn.last_error ?? ''));
  const manage = !who || mailboxManageable(who, mb);
  return {
    id: mb.id,
    name: mb.name,
    address: mb.shared_address || mb.address,
    login: conn?.account_email ?? '',
    provider: mb.provider,
    scope: mb.scope,
    location_id: mb.location_id,
    mine: !!who?.user && who.user.id === mb.owner_user_id,
    shared_address: mb.shared_address,
    access: mb.access,
    enabled: !!mb.enabled,
    window_days: mb.window_days,
    folders: mb.folders,
    rules: mb.rules,
    default_location_id: mb.default_location_id,
    contact_policy: mb.contact_policy,
    skip_promotions: !!mb.skip_promotions,
    trigger_workflows: !!mb.trigger_workflows,
    track_engagement: !!mb.track_engagement,
    signature: mb.signature,
    status: reconnect ? 'reconnect' : mb.status,
    last_sync_at: mb.last_sync_at,
    next_sync_at: mb.next_sync_at,
    last_error: mb.last_error,
    last_result: mb.last_result,
    messages,
    needs_reconnect: reconnect,
    push: { active: !!mb.push?.id, kind: mb.push?.kind ?? null, expires_at: mb.push?.expires_at ?? null, error: mb.push?.error ?? null },
    can_read: canRead(mb.access),
    can_modify: canModify(mb.access),
    can_send: canSend(mb.access),
    can_manage: manage,
  };
}
