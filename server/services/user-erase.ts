import type { App } from '../core/app.js';

/**
 * What goes with a deleted login (a team member removed under Agentur → Nutzer, in the cloud team or with a client account).
 * Sessions, passkeys, devices, presence, push, OAuth connections and personal mailboxes have foreign keys and cascade; these
 * tables point at the person without one. Only what is private to the person goes: AI chats and their uploads and pending
 * confirmations, personal credentials for outside services, login and connect leftovers, the own notification lists, private
 * views and reports, and the person's places in task assignee and watcher lists. What the person did for the team stays with
 * the name written on it (messages, notes, comments, tasks, time entries, the audit log).
 */
const PRIVATE: [table: string, where: string][] = [
  ['agent_conversations', 'user_id = ?'],
  ['agent_pending', 'user_id = ?'],
  ['agent_files', 'user_id = ?'],
  ['agent_bridge_codes', 'user_id = ?'],
  ['agent_bridge_jobs', 'user_id = ?'],
  ['agent_gpt_keys', 'user_id = ?'],
  ['mcp_server_tokens', 'user_id = ?'],
  ['magic_links', 'user_id = ?'],
  ['auth_tickets', 'user_id = ?'],
  ['webauthn_challenges', 'user_id = ?'],
  ['sso_flows', 'user_id = ?'],
  ['oauth_pending', 'user_id = ?'],
  ['mailbox_pending', 'user_id = ?'],
  ['sheets_pending', 'user_id = ?'],
  ['mcp_oauth_pending', 'user_id = ?'],
  ['ads_oauth_pending', 'user_id = ?'],
  ['pm_notifications', 'user_id = ?'],
  ['mobile_feed', 'user_id = ?'],
  ['inbox_mention_seen', 'user_id = ?'],
  ['helpdesk_views', 'user_id = ?'],
  ['object_views', 'user_id = ? AND shared = 0'],
  ['pm_views', 'user_id = ? AND shared = 0'],
  ['report_dashboards', `owner_id = ? AND visibility = 'private'`],
  ['report_definitions', `owner_id = ? AND visibility = 'private'`],
  ['pm_watchers', 'user_id = ?'],
  ['pm_assignees', 'user_id = ?'],
];

/** Removes the private leftovers of a deleted login (call it with the user row gone or going). Returns the rows removed. */
export function forgetUser(app: App, userId: string): number {
  const present = new Set(app.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name));
  let n = 0;
  for (const [table, where] of PRIVATE) if (present.has(table)) n += app.db.run(`DELETE FROM "${table}" WHERE ${where}`, userId).changes;
  return n;
}
