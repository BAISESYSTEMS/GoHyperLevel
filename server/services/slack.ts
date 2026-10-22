import { createHmac } from 'node:crypto';
import { safeEqual, type FetchLike } from './channel-kit.js';

/**
 * Slack as the team's notification + reply channel: Web API calls, signature check of the Events
 * API and the text conversion in both directions. Pure; modules/slack-bridge.ts does the rest.
 */

export const SLACK_API = 'https://slack.com/api';
export const BOT_TOKEN = /^xoxb-[\w-]{20,200}$/;
export const SIGNING_SECRET = /^[0-9a-f]{32}$/i;
export const CHANNEL_ID = /^[CGD](?=[A-Z0-9]*\d)[A-Z0-9]{6,20}$/;

export function isSlackWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com' && /^\/services\/[\w/]{10,200}$/.test(u.pathname) && !u.port && !u.username;
  } catch {
    return false;
  }
}

/** X-Slack-Signature: v0=HMAC-SHA256(signing secret, "v0:<timestamp>:<raw body>"); requests older than 5 minutes are refused. */
export function signSlack(raw: string, timestamp: string, secret: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')}`;
}
export function verifySlack(raw: string, timestamp: string, signature: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!secret || !/^\d{1,12}$/.test(timestamp) || Math.abs(nowSec - Number(timestamp)) > 300) return false;
  return safeEqual(signature, signSlack(raw, timestamp, secret));
}

const SLACK_ERRORS: Record<string, string> = {
  invalid_auth: 'Bot-Token ungültig',
  not_authed: 'Bot-Token fehlt',
  account_inactive: 'Slack-App wurde entfernt',
  channel_not_found: 'Slack-Kanal nicht gefunden (Kanal-ID prüfen)',
  not_in_channel: 'Der Bot ist nicht im Kanal – in Slack /invite @<bot> im Kanal eingeben',
  is_archived: 'Der Slack-Kanal ist archiviert',
  missing_scope: 'Der Slack-App fehlt eine Berechtigung (chat:write, reactions:write)',
  ratelimited: 'Zu viele Anfragen an Slack – bitte kurz warten',
  already_reacted: '',
};

export async function slackCall<T = any>(fetcher: FetchLike, botToken: string, method: string, body: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
  let r: Response;
  try {
    r = await fetcher(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`Slack nicht erreichbar: ${(e as Error).message}`);
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j?.ok) {
    const code = String(j?.error ?? `http_${r.status}`);
    throw new Error(SLACK_ERRORS[code] ?? `Slack: ${code}`);
  }
  return j as T;
}

/** Text for Slack's mrkdwn: & < > must be escaped, everything else is literal. */
export const slackEscape = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A block quote of the customer's message, kept short. */
export const slackQuote = (s: string, max = 1500) => {
  const t = String(s ?? '').trim();
  const cut = t.length > max ? `${t.slice(0, max)} …` : t;
  return cut.split('\n').map((l) => `> ${slackEscape(l)}`).join('\n');
};

/** What a team member typed in Slack → plain text for the customer (links unwrapped, mentions dropped). */
export function fromSlack(text: string): string {
  return String(text ?? '')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url, label) => (label === url.replace(/^mailto:/, '') ? label : `${label} (${url.replace(/^mailto:/, '')})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_m, url) => url.replace(/^mailto:/, ''))
    .replace(/<[@#!][^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
