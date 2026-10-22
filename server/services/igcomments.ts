import { bad } from '../core/http.js';
import type { MetaChannel } from './meta.js';

/**
 * Comment-to-DM (ManyChat style) – the pure parts: reading the comment and story-reply webhooks of Instagram and Facebook
 * pages, keyword matching, the rotation of public replies, rule validation, and the bodies of messages with buttons or quick
 * replies for Instagram, Messenger and WhatsApp. No I/O, no database.
 */

export type RuleKind = 'comment' | 'story_reply';
export type Platform = 'instagram' | 'facebook' | 'both';
export type MatchMode = 'contains' | 'exact' | 'any';

export interface Button {
  /** `url` opens a link, `reply` sends the title (or value) back as a message. */
  type: 'url' | 'reply';
  title: string;
  value: string;
}

export interface RuleInput {
  name: string;
  kind: RuleKind;
  platform: Platform;
  scope: 'all' | 'post';
  media_id: string;
  media_label: string;
  keywords: string[];
  match_mode: MatchMode;
  public_replies: string[];
  dm_text: string;
  link_url: string;
  link_label: string;
  buttons: Button[];
  tags: string[];
  workflow_id: string;
  max_per_hour: number;
  enabled: boolean;
  priority: number;
}

export const LIMITS = { dm: 1000, reply: 300, button: 20, keywords: 20, replies: 10, buttons: 3, tags: 10 };

/** Meta's rules for private replies, shown next to the settings (docs/comment-to-dm.md has the long version). */
export const POLICY_NOTES = [
  'Eine private Antwort (Private Reply) pro Kommentar – ein zweiter Versuch zum selben Kommentar wird abgelehnt.',
  'Sie muss innerhalb von 7 Tagen nach dem Kommentar gesendet werden; HyperLevel antwortet sofort.',
  'Danach öffnet erst die Antwort der Person das 24-Stunden-Fenster für weitere Nachrichten.',
  'Nur auf Kommentare zu Beiträgen und Reels deines eigenen Kontos.',
  'Öffentliche Antworten nur mit echtem Mehrwert – wiederholte, gleiche Texte können als Spam gelten. Rotierende Texte helfen.',
  'Instagram: höchstens ca. 750 private Antworten pro Stunde und Konto; HyperLevel bremst früher (Grenze je Regel einstellbar).',
];

const HTTPS = /^https:\/\/[^\s<>"']+$/i;
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const list = (v: unknown, max: number, each: number): string[] =>
  [...new Set((Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => clean(x, each)).filter(Boolean))].slice(0, max);

/** Validated rule fields (`cur` fills what a PATCH leaves out). */
export function cleanRule(b: any, cur?: Partial<RuleInput>): RuleInput {
  const v = { ...(cur ?? {}), ...(b ?? {}) } as Record<string, any>;
  const kind: RuleKind = v.kind === 'story_reply' ? 'story_reply' : 'comment';
  const platform: Platform = ['instagram', 'facebook', 'both'].includes(v.platform) ? v.platform : 'instagram';
  if (kind === 'story_reply' && platform !== 'instagram') throw bad('Story-Antworten gibt es nur bei Instagram');
  const scope = v.scope === 'post' && kind === 'comment' ? 'post' : 'all';
  const media = clean(v.media_id, 80).replace(/\s+/g, '');
  if (scope === 'post' && !/^[\w-]{5,80}$/.test(media)) throw bad('Beitrag: bitte die ID des Beitrags oder Reels angeben (Ziffern, bei Facebook mit Unterstrich)');
  const mode: MatchMode = ['contains', 'exact', 'any'].includes(v.match_mode) ? v.match_mode : 'contains';
  const keywords = list(v.keywords, LIMITS.keywords, 60);
  if (mode !== 'any' && !keywords.length) throw bad('Mindestens ein Stichwort – oder „jeder Kommentar“ wählen');
  const dm = clean(v.dm_text, LIMITS.dm);
  const linkUrl = clean(v.link_url, 500);
  if (linkUrl && !HTTPS.test(linkUrl)) throw bad('Link: bitte mit https:// angeben');
  const buttons = cleanButtons(v.buttons);
  if (!dm && !linkUrl && !buttons.length) throw bad('Die Direktnachricht braucht einen Text, einen Link oder Buttons');
  const replies = list(v.public_replies, LIMITS.replies, LIMITS.reply);
  const maxPerHour = Math.round(Number(v.max_per_hour ?? 60));
  if (!Number.isFinite(maxPerHour) || maxPerHour < 1 || maxPerHour > 700) throw bad('Höchstens pro Stunde: 1 bis 700');
  const name = clean(v.name, 120) || (keywords[0] ? `Stichwort „${keywords[0]}“` : 'Regel');
  return {
    name,
    kind,
    platform,
    scope,
    media_id: scope === 'post' ? media : '',
    media_label: clean(v.media_label, 120),
    keywords: mode === 'any' ? [] : keywords,
    match_mode: mode,
    public_replies: kind === 'story_reply' ? [] : replies,
    dm_text: dm,
    link_url: linkUrl,
    link_label: clean(v.link_label, LIMITS.button) || 'Jetzt öffnen',
    buttons,
    tags: list(v.tags, LIMITS.tags, 60),
    workflow_id: clean(v.workflow_id, 40),
    max_per_hour: maxPerHour,
    enabled: v.enabled === undefined ? true : !!v.enabled,
    priority: Math.max(-100, Math.min(100, Math.round(Number(v.priority) || 0))),
  };
}

export function cleanButtons(v: unknown): Button[] {
  if (!Array.isArray(v)) return [];
  const out: Button[] = [];
  for (const raw of v.slice(0, 13)) {
    const title = clean(raw?.title, LIMITS.button);
    if (!title) continue;
    const type: Button['type'] = raw?.type === 'url' ? 'url' : 'reply';
    const value = clean(raw?.value ?? raw?.url, 500);
    if (type === 'url' && !HTTPS.test(value)) throw bad(`Button „${title}“: Link bitte mit https:// angeben`);
    out.push({ type, title, value: type === 'reply' ? clean(value || title, 200) : value });
  }
  return out;
}

// --- matching ---------------------------------------------------------------------------------------------------

/** Lowercase, no accents, emoji and punctuation turned into spaces: "Guide, bitte! 🙏" → "guide bitte". */
export const normText = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The first keyword the text matches (whole words), or null. `any` matches every text. */
export function matchKeyword(rule: Pick<RuleInput, 'match_mode' | 'keywords'>, text: string): string | null {
  if (rule.match_mode === 'any') return '*';
  const t = ` ${normText(text)} `;
  if (!t.trim()) return null;
  for (const k of rule.keywords) {
    const n = normText(k);
    if (!n) continue;
    if (rule.match_mode === 'exact' ? t.trim() === n : t.includes(` ${n} `)) return k;
  }
  return null;
}

export const appliesTo = (rule: { platform: Platform; scope: string; media_id: string; kind: RuleKind }, ev: { platform: 'instagram' | 'facebook'; mediaId: string }): boolean => {
  if (rule.kind !== 'comment') return false;
  if (rule.platform !== 'both' && rule.platform !== ev.platform) return false;
  // Facebook ids look like <page>_<post>; the post part alone is enough
  return rule.scope !== 'post' || ev.mediaId === rule.media_id || ev.mediaId.endsWith(`_${rule.media_id}`) || rule.media_id.endsWith(`_${ev.mediaId}`);
};

/** Round-robin over the public replies. */
export const replyAt = (replies: string[], index: number): string => (replies.length ? replies[((index % replies.length) + replies.length) % replies.length] : '');

// --- webhooks -------------------------------------------------------------------------------------------------------

export interface CommentEvent {
  platform: 'instagram' | 'facebook';
  /** The Instagram account / Facebook page that was commented on. */
  accountId: string;
  commentId: string;
  mediaId: string;
  parentId: string;
  fromId: string;
  fromName: string;
  fromUsername: string;
  text: string;
}

/** New comments from an Instagram (`comments`) or Page (`feed`) webhook body. Edits, deletions and replies to comments are left out. */
export function parseComments(payload: any): CommentEvent[] {
  const out: CommentEvent[] = [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const accountId = String(entry?.id ?? '');
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = ch?.value ?? {};
      if (payload?.object === 'instagram' && ch?.field === 'comments') {
        if (!v.id || !v.from?.id || v.parent_id) continue;
        out.push({ platform: 'instagram', accountId, commentId: String(v.id), mediaId: String(v.media?.id ?? ''), parentId: '', fromId: String(v.from.id), fromName: '', fromUsername: String(v.from.username ?? '').replace(/[^\w.]/g, '').slice(0, 60), text: String(v.text ?? '').slice(0, 2200) });
      } else if (payload?.object === 'page' && ch?.field === 'feed') {
        // item "comment", verb "add"; a comment on a comment has the comment as parent
        if (v.item !== 'comment' || v.verb !== 'add' || !v.comment_id || !v.from?.id) continue;
        const postId = String(v.post_id ?? '');
        if (v.parent_id && String(v.parent_id) !== postId) continue;
        out.push({ platform: 'facebook', accountId, commentId: String(v.comment_id), mediaId: postId, parentId: String(v.parent_id ?? ''), fromId: String(v.from.id), fromName: String(v.from.name ?? '').slice(0, 120), fromUsername: '', text: String(v.message ?? '').slice(0, 2200) });
      }
    }
  }
  return out;
}

export interface StoryReply {
  accountId: string;
  fromId: string;
  mid: string;
  text: string;
  storyId: string;
}

/** Instagram messages that answer one of the account's stories (`message.reply_to.story`). */
export function parseStoryReplies(payload: any): StoryReply[] {
  const out: StoryReply[] = [];
  if (payload?.object !== 'instagram') return out;
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const ev of Array.isArray(entry?.messaging) ? entry.messaging : []) {
      const m = ev?.message;
      const story = m?.reply_to?.story;
      if (!m || m.is_echo || m.is_deleted || !m.mid || !story || !ev?.sender?.id) continue;
      out.push({ accountId: String(entry.id ?? ''), fromId: String(ev.sender.id), mid: String(m.mid), text: String(m.text ?? '').slice(0, 2200), storyId: String(story.id ?? '') });
    }
  }
  return out;
}

// --- message bodies ---------------------------------------------------------------------------------------------------

/** The text and the buttons of a rule's direct message: the link is a button, so people don't have to copy it. */
export function dmContent(rule: Pick<RuleInput, 'dm_text' | 'link_url' | 'link_label' | 'buttons'>): { text: string; buttons: Button[] } {
  const buttons: Button[] = [...rule.buttons];
  if (rule.link_url) buttons.unshift({ type: 'url', title: rule.link_label || 'Jetzt öffnen', value: rule.link_url });
  const text = rule.dm_text || (rule.link_url ? rule.link_label || 'Hier ist dein Link:' : 'Hallo!');
  return { text, buttons: buttons.slice(0, LIMITS.buttons) };
}

/** `message` of a Messenger/Instagram send call: plain text, a button template (URL / postback buttons) or quick replies. */
export function messengerMessage(text: string, buttons: Button[], style: 'auto' | 'buttons' | 'quick' = 'auto'): Record<string, any> {
  if (!buttons.length) return { text };
  const anyUrl = buttons.some((b) => b.type === 'url');
  const mode = style === 'auto' ? (anyUrl ? 'buttons' : 'quick') : style;
  if (mode === 'quick' && !anyUrl) return { text, quick_replies: buttons.slice(0, 13).map((b) => ({ content_type: 'text', title: b.title.slice(0, 20), payload: (b.value || b.title).slice(0, 1000) })) };
  const bs = buttons.slice(0, 3).map((b) => (b.type === 'url' ? { type: 'web_url', url: b.value, title: b.title.slice(0, 20) } : { type: 'postback', title: b.title.slice(0, 20), payload: (b.value || b.title).slice(0, 1000) }));
  // the text of a button template is limited to 640 characters
  return { attachment: { type: 'template', payload: { template_type: 'button', text: text.slice(0, 640), buttons: bs } } };
}

/** WhatsApp interactive message: up to three reply buttons, or one link button. */
export function whatsappInteractive(to: string, text: string, buttons: Button[]) {
  if (!buttons.length) return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: /https?:\/\//.test(text), body: text } };
  const urls = buttons.filter((b) => b.type === 'url');
  if (urls.length) {
    if (buttons.length > 1) throw bad('WhatsApp erlaubt entweder bis zu drei Antwort-Buttons oder einen einzelnen Link-Button – nicht gemischt');
    return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive: { type: 'cta_url', body: { text: text.slice(0, 1024) }, action: { name: 'cta_url', parameters: { display_text: urls[0].title.slice(0, 20), url: urls[0].value } } } };
  }
  if (buttons.length > 3) throw bad('WhatsApp erlaubt höchstens drei Antwort-Buttons');
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: { type: 'button', body: { text: text.slice(0, 1024) }, action: { buttons: buttons.map((b, i) => ({ type: 'reply', reply: { id: `${i + 1}:${(b.value || b.title).slice(0, 200)}`.slice(0, 256), title: b.title.slice(0, 20) } })) } },
  };
}

/** What the inbox shows for a message with buttons. */
export const describeButtons = (text: string, buttons: Button[]) => (buttons.length ? `${text}\n${buttons.map((b) => `[${b.title}${b.type === 'url' ? ` → ${b.value}` : ''}]`).join(' ')}` : text);

export const channelOf = (platform: 'instagram' | 'facebook'): MetaChannel => (platform === 'instagram' ? 'instagram' : 'messenger');
