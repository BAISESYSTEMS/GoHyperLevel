import type { App } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { track, userById } from './collab-actor.js';
import { channelFetch, getAccount } from './channel-kit.js';
import { CHANNEL_ID, isSlackWebhook, slackCall, slackEscape } from './slack.js';
import { markdownToText } from './wiki-markdown.js';
import { hubOf, mayChat, type ChannelRow, type MessageRow } from './teamchat-store.js';

/**
 * Who hears about a message, and how: in the app (the open stream and the unread counters do that), by web push
 * and on the Android feed (event type "chat") – but only for people who are not looking at the chat right now –
 * and, for channels that were switched on for it, a one-way copy to the Slack channel of the Slack bridge.
 *
 * Rules: direct messages and groups notify for every message, channels only for @mentions (and replies in a thread
 * you took part in) unless a person chose otherwise per channel; a muted channel ("none") stays quiet.
 */

const preview = (m: MessageRow, fileCount: number) => {
  const t = markdownToText(m.body).replace(/\s+/g, ' ').trim();
  return (t || (fileCount ? '📎 Datei' : '')).slice(0, 160);
};

export function notifyMessage(app: App, ctx: Ctx, ch: ChannelRow, row: MessageRow, mentioned: string[], opts: { fileCount?: number } = {}) {
  const hub = hubOf(app);
  const members = app.db.all<{ user_id: string; notify: string }>('SELECT user_id, notify FROM teamchat_members WHERE channel_id = ?', ch.id);
  const mentions = new Set(mentioned);
  const prefs = new Map(members.map((m) => [m.user_id, m.notify]));
  const participants = new Set<string>();
  if (row.thread_id) {
    for (const r of app.db.all<{ author_id: string | null }>('SELECT author_id FROM teamchat_messages WHERE id = ? OR thread_id = ?', row.thread_id, row.thread_id)) if (r.author_id) participants.add(r.author_id);
  }
  const direct = ch.kind === 'dm' || ch.kind === 'group';
  const label = direct ? '' : `#${ch.name}`;
  const text = preview(row, opts.fileCount ?? 0);
  const groups = new Map<string, { title: string; users: string[] }>();
  for (const uid of new Set([...members.map((m) => m.user_id), ...mentions])) {
    if (uid === row.author_id) continue;
    const u = userById(app, uid);
    if (!u || !mayChat(u, ch.location_id)) continue;
    const pref = prefs.get(uid) || (direct ? 'all' : 'mentions');
    if (pref === 'none') continue;
    const isMention = mentions.has(uid);
    if (!(pref === 'all' || isMention || participants.has(uid))) continue;
    // somebody reading the chat right now sees it there
    if (hub.looking(uid)) continue;
    const title = direct ? (ch.kind === 'group' ? `${row.author_name} (Gruppe)` : row.author_name) : isMention ? `${row.author_name} hat dich in ${label} erwähnt` : `${row.author_name} in ${label}`;
    const g = groups.get(title) ?? { title, users: [] };
    g.users.push(uid);
    groups.set(title, g);
  }
  const url = `/app/team-chat/${ch.id}${row.thread_id ? `?thread=${row.thread_id}` : ''}`;
  const location = ch.location_id ?? ctx.locationId;
  for (const g of groups.values()) {
    if (app.services.pushNotify) track(app, Promise.resolve(app.services.pushNotify({ userIds: g.users, kind: 'chat', title: g.title.slice(0, 120), body: text, url, tag: `chat:${ch.id}` })));
    for (const uid of g.users) app.services.mobileFeed?.({ locationId: location, type: 'chat', area: '', userId: uid, title: g.title, body: text, link: url, ref: `chat:${row.id}:${uid}` });
  }
  if (ch.slack_mirror && ch.location_id && (ch.kind === 'public' || ch.kind === 'private')) track(app, mirrorToSlack(app, ch, row, text));
  return [...groups.values()].flatMap((g) => g.users);
}

/** One-way copy to the Slack channel of the sub-account's Slack bridge (bot token or incoming webhook). */
async function mirrorToSlack(app: App, ch: ChannelRow, row: MessageRow, text: string) {
  if (!ch.location_id || !text) return;
  const a = getAccount(app, ch.location_id, 'slack');
  if (!a?.enabled) return;
  const f = channelFetch(app);
  const line = `*${slackEscape(row.author_name)}* in #${slackEscape(ch.name)}: ${slackEscape(text)}`;
  try {
    if (a.config.mode === 'webhook') {
      if (!isSlackWebhook(a.secrets.webhook_url ?? '')) return;
      const r = await f(a.secrets.webhook_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: line }), signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`Slack-Webhook ${r.status}`);
    } else {
      if (!a.secrets.bot_token || !CHANNEL_ID.test(a.config.channel ?? '')) return;
      await slackCall(f, a.secrets.bot_token, 'chat.postMessage', { channel: a.config.channel, text: line, unfurl_links: false });
    }
  } catch (e) {
    console.error('[team-chat] slack mirror:', (e as Error).message);
  }
}
