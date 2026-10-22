import { randomUUID } from 'node:crypto';
import addressparser from 'nodemailer/lib/addressparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import { escapeHtml, textToHtml } from '../core/template.js';
import { htmlToText } from './email-render.js';
import type { Provider } from './oauth.js';

/**
 * Building blocks of the native mailbox sync (Gmail API and Microsoft Graph): the provider-neutral
 * message model, the scopes each access level needs, address and subject helpers and the MIME
 * builder for Gmail. No database and no HTTP in here – the clients (mailbox-gmail, mailbox-graph),
 * the sync engine (mailbox-sync) and the module use it.
 */

export type MailProviderKind = Provider;
/** full = read, send and manage (archive, labels, read/star); readonly = read only; send = send only, no sync. */
export type MailAccess = 'full' | 'readonly' | 'send';
export const MAIL_ACCESS: MailAccess[] = ['full', 'readonly', 'send'];
export type FolderKind = 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash' | 'spam' | 'other';

export interface MailAddress {
  email: string;
  name: string;
}
export interface MailFolder {
  id: string;
  name: string;
  kind: FolderKind;
  /** Built-in folder / system label (not created by the user). */
  system: boolean;
}
export interface MailLabel {
  id: string;
  name: string;
}
export interface AttachmentInfo {
  id: string;
  name: string;
  type: string;
  size: number;
  inline: boolean;
}

/** One message as Gmail or Graph describe it, in one shape. */
export interface RemoteMessage {
  id: string;
  /** Gmail threadId / Graph conversationId. */
  threadId: string;
  /** RFC 5322 Message-ID without the angle brackets. */
  internetId: string;
  /** The References header as sent (ids with brackets). */
  references: string;
  folder: FolderKind;
  folderId: string;
  /** User labels (Gmail label ids, Graph categories) – not the state flags below. */
  labels: string[];
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string;
  snippet: string;
  /** ISO timestamp. */
  date: string;
  unread: boolean;
  starred: boolean;
  draft: boolean;
  attachments: AttachmentInfo[];
  /** Gmail: sorted into Promotions or Social (newsletters) – skipped when the mailbox says so. */
  bulk?: boolean;
  /** Graph: the attachment list still has to be fetched. */
  hasAttachments?: boolean;
  /** Only ids, labels and flags are valid (Gmail "minimal" format for label changes). */
  partial?: boolean;
}

/** A change made here that Gmail / Outlook has to learn about. */
export interface MsgChange {
  read?: boolean;
  starred?: boolean;
  /** true = out of the inbox, false = back into it. */
  archived?: boolean;
  addLabels?: string[];
  removeLabels?: string[];
}

export interface OutgoingMail {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
  /** Message-ID we generated (Gmail); Graph assigns its own. */
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  /** Gmail: keep the reply in this thread. */
  threadId?: string;
  /** Graph: reply to this message (createReply keeps the conversation). */
  replyToRemoteId?: string;
}

export interface SentRef {
  /** Provider id of the message (Gmail message id, Graph message id). */
  id: string;
  /** Gmail draft id (drafts only). */
  draftId: string;
  threadId: string;
  /** RFC Message-ID without brackets. */
  internetId: string;
}

export interface SyncInput {
  /** ISO date: the import window starts here. */
  since: string;
  /** Chosen folder/label ids; empty = the defaults of the provider. */
  folders: string[];
  state: Record<string, any>;
  /** Is this remote id already in the database? */
  known: (id: string) => boolean;
  /** Most messages to fetch in this call. */
  limit: number;
}
export interface SyncOutput {
  messages: RemoteMessage[];
  /** Gone at the provider (Graph: with the folder the report came from). */
  deleted: { id: string; folderId?: string }[];
  state: Record<string, any>;
  /** Call again for the next page. */
  more: boolean;
  /** The saved cursor was too old: everything inside the window is read again. */
  reset?: boolean;
}

export interface PushInfo {
  kind: 'gmail_watch' | 'graph_subscription';
  id: string;
  expires_at: string;
  /** Graph: sealed clientState the notifications must carry. */
  client_state?: string;
}

/** What a mailbox client offers; sync, send and the inbox actions only talk to this. */
export interface MailApi {
  kind: MailProviderKind;
  profile(): Promise<{ address: string; name?: string; historyId?: string }>;
  folders(state?: Record<string, any>): Promise<{ folders: MailFolder[]; state: Record<string, any> }>;
  labels(): Promise<MailLabel[]>;
  sync(o: SyncInput): Promise<SyncOutput>;
  get(id: string): Promise<RemoteMessage | null>;
  /** Gmail: the drafts that exist now (to notice drafts sent or deleted over there). */
  drafts?(): Promise<{ draftId: string; id: string }[]>;
  attachment(messageId: string, attachmentId: string): Promise<Buffer>;
  send(m: OutgoingMail): Promise<SentRef>;
  createDraft(m: OutgoingMail): Promise<SentRef>;
  updateDraft(ref: { id: string; draftId: string }, m: OutgoingMail): Promise<SentRef>;
  sendDraft(ref: { id: string; draftId: string }): Promise<{ id: string; threadId: string }>;
  deleteDraft(ref: { id: string; draftId: string }): Promise<void>;
  modify(id: string, change: MsgChange, state?: Record<string, any>): Promise<void>;
  createLabel(name: string): Promise<MailLabel>;
  search(query: string, limit: number): Promise<RemoteMessage[]>;
}

export class MailError extends Error {
  /**
   * The request may well have reached the provider and taken effect – only the answer is missing (a timeout, a connection lost
   * while waiting). A send must not simply be repeated then: the mail may be out already.
   */
  unknownOutcome = false;
  constructor(
    message: string,
    public status = 0,
    /** Seconds the provider asked us to wait. */
    public retryAfter = 0,
  ) {
    super(message);
  }
  /** Worth another try later (network, rate limit, provider trouble); everything else is final. */
  get transient() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

// --- scopes ----------------------------------------------------------------------------------

const GMAIL = 'https://www.googleapis.com/auth/gmail';
const GRAPH = 'https://graph.microsoft.com';

/**
 * What to ask for. Gmail's modify/readonly are "restricted" scopes, gmail.send only "sensitive" (see
 * docs/mailbox-sync.md for what that means for the OAuth app). Graph's delegated mail scopes need no
 * review; shared mailboxes need the `.Shared` variants.
 */
export function mailScopes(provider: MailProviderKind, access: MailAccess, shared = false): string[] {
  if (provider === 'google') {
    const base = ['openid', 'email'];
    if (access === 'full') return [...base, `${GMAIL}.modify`, `${GMAIL}.send`];
    if (access === 'readonly') return [...base, `${GMAIL}.readonly`];
    return [...base, `${GMAIL}.send`];
  }
  const base = ['openid', 'email', 'offline_access'];
  const s = shared ? '.Shared' : '';
  if (access === 'full') return [...base, `Mail.ReadWrite${s}`, `Mail.Send${s}`];
  if (access === 'readonly') return [...base, `Mail.Read${s}`];
  return [...base, `Mail.Send${s}`];
}

/** The scopes that must really have been granted (Google lets people untick single permissions). */
function requiredMailScopes(provider: MailProviderKind, access: MailAccess, shared: boolean): string[] {
  if (provider === 'google') return [access === 'full' ? `${GMAIL}.modify` : access === 'readonly' ? `${GMAIL}.readonly` : `${GMAIL}.send`];
  const s = shared ? '.Shared' : '';
  return [access === 'full' ? `Mail.ReadWrite${s}` : access === 'readonly' ? `Mail.Read${s}` : `Mail.Send${s}`];
}

export function missingMailScopes(provider: MailProviderKind, access: MailAccess, shared: boolean, granted: string): string[] {
  const have = new Set(granted.split(/\s+/).filter(Boolean).map((s) => s.toLowerCase()));
  // Microsoft answers with short names or full URIs; Google modify also covers reading and sending.
  const has = (s: string) => have.has(s.toLowerCase()) || have.has(`${GRAPH}/${s}`.toLowerCase()) || (provider === 'google' && s !== `${GMAIL}.modify` && have.has(`${GMAIL}.modify`));
  return requiredMailScopes(provider, access, shared).filter((s) => !has(s));
}

export const canRead = (access: string) => access === 'full' || access === 'readonly';
export const canModify = (access: string) => access === 'full';
export const canSend = (access: string) => access === 'full' || access === 'send';

// --- addresses and subjects -----------------------------------------------------------------------

export const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/** Header values never carry line breaks. */
export const oneLine = (v: unknown) => String(v ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

export function parseAddresses(header: unknown): MailAddress[] {
  const s = oneLine(header);
  if (!s) return [];
  const out: MailAddress[] = [];
  const walk = (list: { address?: string; name?: string; group?: any[] }[]) => {
    for (const a of list) {
      if (a.group) walk(a.group);
      else if (a.address) out.push({ email: a.address.toLowerCase(), name: oneLine(a.name) });
    }
  };
  try {
    walk(addressparser(s) as any);
  } catch {
    /* unreadable header: no addresses */
  }
  return out;
}

export const addrOf = (a: MailAddress | undefined) => (a?.email ?? '').toLowerCase();
export const sameAddress = (a: string, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

/** `Name <a@b.de>` with a safe name (no quotes, brackets or line breaks). */
export function formatAddress(a: MailAddress): string {
  const name = oneLine(a.name).replace(/["\\<>]/g, '');
  return name ? `"${name}" <${a.email}>` : a.email;
}

/** "Re: …" once (also keeps "AW:" and "Antw:" of the other side). */
export function replySubject(subject: string): string {
  const s = oneLine(subject);
  if (!s) return 'Re:';
  return /^\s*(re|aw|antw|sv|vs)\s*(\[\d+\])?\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** Message-ID for a mail we send (Gmail keeps the header as it is). */
export function newMessageId(address: string): string {
  const domain = (address.split('@')[1] ?? 'gohigh.invalid').replace(/[^A-Za-z0-9.-]/g, '') || 'gohigh.invalid';
  return `${randomUUID()}@${domain}`;
}

export const stripBrackets = (id: string) => String(id ?? '').trim().replace(/^<|>$/g, '');

/** The last id of a References header, or '' (for In-Reply-To). */
export function appendReference(references: string, internetId: string): string {
  const ids = (String(references ?? '').match(/<[^>]+>/g) ?? []).slice(-9);
  const mine = internetId ? `<${stripBrackets(internetId)}>` : '';
  if (mine && !ids.includes(mine)) ids.push(mine);
  return ids.join(' ');
}

// --- body ----------------------------------------------------------------------------------------

/** Decodes the bytes of a text part with the charset from its Content-Type (UTF-8 when unknown). */
export function decodeText(buf: Buffer, contentType = ''): string {
  const cs = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType)?.[1]?.toLowerCase();
  if (cs && cs !== 'utf-8' && cs !== 'utf8') {
    try {
      return new TextDecoder(cs).decode(buf);
    } catch {
      /* unknown charset: fall through */
    }
  }
  return buf.toString('utf8');
}

export const MAX_BODY = 100_000;
export const clip = (s: string, n = MAX_BODY) => (s.length > n ? s.slice(0, n) : s);

export function bodyText(text: string, html: string): string {
  const t = text.trim() ? text : html ? htmlToText(html) : '';
  return clip(t.replace(/\r\n/g, '\n').trim());
}

/** Signature as text and HTML, appended below the message. */
export function withSignature(body: { text: string; html: string }, signature: string): { text: string; html: string } {
  const sig = signature.trim();
  if (!sig) return body;
  return { text: `${body.text}\n\n-- \n${sig}`, html: `${body.html}\n<p>-- <br>${escapeHtml(sig).replace(/\n/g, '<br>')}</p>` };
}

/** Text and HTML versions of what the person wrote (plain text by default, HTML from the editor or MCP). */
export function composeBody(input: string, isHtml: boolean): { text: string; html: string } {
  if (isHtml) return { text: htmlToText(input), html: input };
  return { text: input, html: textToHtml(input) };
}

// --- MIME (Gmail wants the whole message) ----------------------------------------------------------

export function buildMime(m: OutgoingMail): Promise<Buffer> {
  const composer = new MailComposer({
    from: formatAddress(m.from),
    to: m.to.map(formatAddress),
    cc: m.cc.length ? m.cc.map(formatAddress) : undefined,
    bcc: m.bcc.length ? m.bcc.map(formatAddress) : undefined,
    replyTo: m.replyTo ? oneLine(m.replyTo) : undefined,
    subject: oneLine(m.subject),
    text: m.text,
    html: m.html,
    messageId: m.messageId ? `<${stripBrackets(m.messageId)}>` : undefined,
    inReplyTo: m.inReplyTo ? `<${stripBrackets(m.inReplyTo)}>` : undefined,
    references: m.references ? (m.references.match(/<[^>]+>/g) ?? undefined) : undefined,
    attachments: m.attachments.map((a) => ({ filename: oneLine(a.filename).replace(/[\\/"]/g, '_') || 'Anhang', content: a.content, contentType: a.contentType || 'application/octet-stream' })),
  } as any);
  const node: any = composer.compile();
  // Gmail reads the recipients of the mail from its headers (Bcc included) and removes Bcc itself.
  node.keepBcc = true;
  return new Promise((resolve, reject) => node.build((err: Error | null, buf: Buffer) => (err ? reject(err) : resolve(buf))));
}

// --- misc ---------------------------------------------------------------------------------------------

export const isoOrEmpty = (v: unknown): string => {
  const t = Date.parse(String(v ?? ''));
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
};

/** Concurrency-limited map (fetching many messages without hammering the API). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export const FOLDER_LABELS: Record<FolderKind, string> = {
  inbox: 'Posteingang',
  sent: 'Gesendet',
  drafts: 'Entwürfe',
  archive: 'Archiv',
  trash: 'Papierkorb',
  spam: 'Spam',
  other: 'Ordner',
};

/** Default folders to sync when the person chose none. */
export const DEFAULT_SYNC_KINDS: FolderKind[] = ['inbox', 'sent', 'drafts'];

/**
 * Network errors that happen before a request reaches the provider (no address, nobody listening, no connection made): the
 * request certainly did nothing. Everything else without an answer – a timeout, a connection that broke while waiting – may
 * have been carried out.
 */
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
export function outcomeUnknown(e: unknown): boolean {
  const code = String((e as any)?.cause?.code ?? (e as any)?.code ?? '');
  return !NOT_SENT.has(code);
}
