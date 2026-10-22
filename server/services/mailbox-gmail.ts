import { mailRequest, type Json, type TokenFn } from './mailbox-http.js';
import {
  MailError,
  bodyText,
  buildMime,
  decodeText,
  isoOrEmpty,
  mapLimit,
  newMessageId,
  parseAddresses,
  stripBrackets,
  type AttachmentInfo,
  type FolderKind,
  type MailApi,
  type MailFolder,
  type MailLabel,
  type MsgChange,
  type OutgoingMail,
  type RemoteMessage,
  type SentRef,
  type SyncInput,
  type SyncOutput,
} from './mailbox-kit.js';

/**
 * Gmail API v1 (users.messages, users.history, users.drafts, users.labels, users.watch) behind the
 * MailApi interface. First import: users.messages.list per chosen label inside the window, remembering the
 * historyId taken *before* listing so nothing that arrives meanwhile is missed. After that: users.history.list
 * from that historyId (added, deleted and label changes); a historyId that is too old (404) means a fresh import.
 */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DEFAULT_LABELS = ['INBOX', 'SENT', 'DRAFT'];
/** Flags and system labels are state, not labels people file mail under. */
const STATE_LABELS = new Set(['INBOX', 'SENT', 'DRAFT', 'UNREAD', 'STARRED', 'SPAM', 'TRASH', 'CHAT']);
const PAGE = 50;

const header = (headers: { name: string; value: string }[] | undefined, name: string) => headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';

export const visibleLabels = (ids: string[]) => ids.filter((l) => !STATE_LABELS.has(l) && !l.startsWith('CATEGORY_'));

export function folderOf(labels: string[]): FolderKind {
  if (labels.includes('TRASH')) return 'trash';
  if (labels.includes('SPAM')) return 'spam';
  if (labels.includes('DRAFT')) return 'drafts';
  if (labels.includes('INBOX')) return 'inbox';
  if (labels.includes('SENT')) return 'sent';
  return 'archive';
}

interface Walked {
  text: string[];
  html: string[];
  attachments: AttachmentInfo[];
}
function walk(part: Json, out: Walked) {
  const mime = String(part.mimeType ?? '').toLowerCase();
  const headers = part.headers as { name: string; value: string }[] | undefined;
  const data = part.body?.data ? Buffer.from(String(part.body.data), 'base64url') : null;
  if (part.filename && part.body?.attachmentId) {
    const disposition = header(headers, 'content-disposition').toLowerCase();
    out.attachments.push({ id: String(part.body.attachmentId), name: String(part.filename), type: mime || 'application/octet-stream', size: Number(part.body.size) || 0, inline: disposition.startsWith('inline') || !!header(headers, 'content-id') });
  } else if (mime === 'text/plain' && data) out.text.push(decodeText(data, header(headers, 'content-type')));
  else if (mime === 'text/html' && data) out.html.push(decodeText(data, header(headers, 'content-type')));
  for (const p of part.parts ?? []) walk(p, out);
}

/** A Gmail message resource (format full, metadata or minimal) as a RemoteMessage. */
export function gmailToRemote(m: Json): RemoteMessage {
  const labels: string[] = m.labelIds ?? [];
  const headers = m.payload?.headers as { name: string; value: string }[] | undefined;
  const out: Walked = { text: [], html: [], attachments: [] };
  if (m.payload) walk(m.payload, out);
  const date = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : isoOrEmpty(header(headers, 'date'));
  const from = parseAddresses(header(headers, 'from'))[0] ?? { email: '', name: '' };
  const text = out.text.length || out.html.length ? bodyText(out.text.join('\n\n'), out.html.join('\n')) : String(m.snippet ?? '');
  return {
    id: String(m.id),
    threadId: String(m.threadId ?? ''),
    internetId: stripBrackets(header(headers, 'message-id')),
    references: header(headers, 'references'),
    folder: folderOf(labels),
    folderId: labels.includes('INBOX') ? 'INBOX' : labels.includes('SENT') ? 'SENT' : '',
    labels: visibleLabels(labels),
    from,
    to: parseAddresses(header(headers, 'to')),
    cc: parseAddresses(header(headers, 'cc')),
    bcc: parseAddresses(header(headers, 'bcc')),
    subject: header(headers, 'subject'),
    text,
    snippet: String(m.snippet ?? ''),
    date,
    unread: labels.includes('UNREAD'),
    starred: labels.includes('STARRED'),
    draft: labels.includes('DRAFT'),
    attachments: out.attachments,
    bulk: labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_SOCIAL'),
    partial: !m.payload,
  };
}

export function gmailApi(fetcher: typeof fetch, token: TokenFn): MailApi {
  const req = (path: string, init: Parameters<typeof mailRequest>[4] = {}) => mailRequest('Gmail', fetcher, token, path.startsWith('http') ? path : `${BASE}${path}`, init);
  const q = (o: Record<string, string | number | undefined | (string | number)[]>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined && x !== '') p.append(k, String(x));
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const getMessage = async (id: string, format: 'full' | 'minimal' | 'metadata' = 'full'): Promise<RemoteMessage | null> => {
    const r = await req(`/messages/${encodeURIComponent(id)}${q({ format, ...(format === 'metadata' ? { metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID'] } : {}) })}`, { allow: [404] });
    return r.status === 404 ? null : gmailToRemote(r.json);
  };
  const sentRef = (j: Json, internetId: string, draftId = ''): SentRef => ({ id: String(j.message?.id ?? j.id), draftId, threadId: String(j.message?.threadId ?? j.threadId ?? ''), internetId });
  const raw = async (m: OutgoingMail) => {
    const internetId = stripBrackets(m.messageId ?? '') || newMessageId(m.from.email);
    const mime = await buildMime({ ...m, messageId: internetId });
    return { internetId, raw: mime.toString('base64url') };
  };

  const api: MailApi = {
    kind: 'google',

    async profile() {
      const r = await req('/profile');
      return { address: String(r.json.emailAddress ?? '').toLowerCase(), historyId: String(r.json.historyId ?? '') };
    },

    async folders() {
      const r = await req('/labels');
      const labels: Json[] = r.json.labels ?? [];
      // Spam and Trash are never imported, so they are not offered.
      const folders: MailFolder[] = [
        { id: 'INBOX', name: 'Posteingang', kind: 'inbox', system: true },
        { id: 'SENT', name: 'Gesendet', kind: 'sent', system: true },
        { id: 'DRAFT', name: 'Entwürfe', kind: 'drafts', system: true },
        { id: '*', name: 'Alle E-Mails (außer Spam und Papierkorb)', kind: 'other', system: true },
      ];
      for (const l of labels) if (l.type === 'user') folders.push({ id: String(l.id), name: String(l.name), kind: 'other', system: false });
      return { folders, state: {} };
    },

    async labels(): Promise<MailLabel[]> {
      const r = await req('/labels');
      return (r.json.labels ?? []).filter((l: Json) => l.type === 'user').map((l: Json) => ({ id: String(l.id), name: String(l.name) }));
    },

    async createLabel(name) {
      const r = await req('/labels', { method: 'POST', body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
      return { id: String(r.json.id), name: String(r.json.name) };
    },

    get: (id) => getMessage(id),

    async sync(o: SyncInput): Promise<SyncOutput> {
      const st: Record<string, any> = { ...o.state };
      const selected = o.folders.length ? o.folders : DEFAULT_LABELS;
      const all = selected.includes('*');
      const wanted = (labels: string[]) => !labels.includes('SPAM') && !labels.includes('TRASH') && (all || labels.some((l) => selected.includes(l)));
      const limit = Math.min(Math.max(o.limit, 1), 100);

      // --- first import: every chosen label inside the window -----------------------------
      if (!st.history_id) {
        if (!st.init) st.init = { start: String((await api.profile()).historyId ?? ''), li: 0, token: '' };
        const label = all ? '' : selected[st.init.li];
        const since = Math.floor(Date.parse(o.since) / 1000);
        // Drafts are few and always wanted, whatever their age.
        const r = await req(`/messages${q({ labelIds: label || undefined, q: label === 'DRAFT' ? undefined : `after:${since}`, maxResults: Math.min(limit, PAGE), pageToken: st.init.token || undefined })}`);
        const ids: string[] = (r.json.messages ?? []).map((m: Json) => String(m.id));
        const messages = (await mapLimit(ids, 5, (id) => getMessage(id))).filter((m): m is RemoteMessage => !!m);
        if (r.json.nextPageToken) st.init.token = String(r.json.nextPageToken);
        else {
          st.init.li++;
          st.init.token = '';
        }
        const more = !all && st.init.li < selected.length ? true : !!r.json.nextPageToken;
        if (!more) {
          st.history_id = st.init.start;
          delete st.init;
        }
        return { messages, deleted: [], state: st, more };
      }

      // --- afterwards: what changed since the last historyId --------------------------------
      let r;
      try {
        r = await req(`/history${q({ startHistoryId: st.history_id, maxResults: 100, pageToken: st.hpage || undefined, historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'] })}`, { allow: [404] });
      } catch (e) {
        if (e instanceof MailError && e.status === 400) r = { status: 404, json: {} as Json };
        else throw e;
      }
      if (r.status === 404) return { messages: [], deleted: [], state: {}, more: true, reset: true };
      const added = new Map<string, string[]>();
      const touched = new Map<string, string[]>();
      const deleted = new Set<string>();
      for (const h of (r.json.history ?? []) as Json[]) {
        for (const x of h.messagesAdded ?? []) added.set(String(x.message.id), x.message.labelIds ?? []);
        for (const x of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) touched.set(String(x.message.id), x.message.labelIds ?? []);
        for (const x of h.messagesDeleted ?? []) deleted.add(String(x.message.id));
      }
      const messages: RemoteMessage[] = [];
      const since = Date.parse(o.since);
      const fetchFull = async (ids: string[], inWindow = false) => {
        for (const m of await mapLimit(ids, 5, (id) => getMessage(id))) if (m && (!inWindow || !m.date || Date.parse(m.date) >= since)) messages.push(m);
      };
      const newIds = [...added.keys()].filter((id) => !deleted.has(id) && !o.known(id));
      await fetchFull(newIds.filter((id) => wanted(added.get(id) ?? [])));
      // Label changes on mail we have: flags only (minimal format); on mail we don't have yet: import it when it entered a chosen label.
      const labelOnly = [...touched.keys()].filter((id) => !deleted.has(id) && !newIds.includes(id));
      const known = labelOnly.filter((id) => o.known(id));
      for (const m of await mapLimit(known, 5, (id) => getMessage(id, 'minimal'))) if (m) messages.push(m);
      // A label chosen for the sync was put on an older message: import it if it lies inside the window.
      await fetchFull(labelOnly.filter((id) => !o.known(id) && wanted(touched.get(id) ?? [])), true);
      if (r.json.nextPageToken) {
        st.hpage = String(r.json.nextPageToken);
        return { messages, deleted: [...deleted].map((id) => ({ id })), state: st, more: true };
      }
      st.history_id = String(r.json.historyId ?? st.history_id);
      delete st.hpage;
      return { messages, deleted: [...deleted].map((id) => ({ id })), state: st, more: false };
    },

    async drafts() {
      const r = await req(`/drafts${q({ maxResults: 100 })}`);
      return (r.json.drafts ?? []).map((d: Json) => ({ draftId: String(d.id), id: String(d.message?.id ?? '') }));
    },

    async attachment(messageId, attachmentId) {
      const r = await req(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
      return Buffer.from(String(r.json.data ?? ''), 'base64url');
    },

    async send(m) {
      const { internetId, raw: data } = await raw(m);
      const r = await req('/messages/send', { method: 'POST', body: { raw: data, ...(m.threadId ? { threadId: m.threadId } : {}) } });
      return sentRef(r.json, internetId);
    },

    async createDraft(m) {
      const { internetId, raw: data } = await raw(m);
      const r = await req('/drafts', { method: 'POST', body: { message: { raw: data, ...(m.threadId ? { threadId: m.threadId } : {}) } } });
      return sentRef(r.json, internetId, String(r.json.id));
    },

    async updateDraft(ref, m) {
      const { internetId, raw: data } = await raw(m);
      const r = await req(`/drafts/${encodeURIComponent(ref.draftId)}`, { method: 'PUT', body: { message: { raw: data, ...(m.threadId ? { threadId: m.threadId } : {}) } } });
      return sentRef(r.json, internetId, String(r.json.id ?? ref.draftId));
    },

    async sendDraft(ref) {
      const r = await req('/drafts/send', { method: 'POST', body: { id: ref.draftId } });
      return { id: String(r.json.id), threadId: String(r.json.threadId ?? '') };
    },

    async deleteDraft(ref) {
      await req(`/drafts/${encodeURIComponent(ref.draftId)}`, { method: 'DELETE', allow: [404] });
    },

    async modify(id, change: MsgChange) {
      const add: string[] = [...(change.addLabels ?? [])];
      const remove: string[] = [...(change.removeLabels ?? [])];
      if (change.read !== undefined) (change.read ? remove : add).push('UNREAD');
      if (change.starred !== undefined) (change.starred ? add : remove).push('STARRED');
      if (change.archived !== undefined) (change.archived ? remove : add).push('INBOX');
      if (!add.length && !remove.length) return;
      await req(`/messages/${encodeURIComponent(id)}/modify`, { method: 'POST', body: { addLabelIds: [...new Set(add)], removeLabelIds: [...new Set(remove)] } });
    },

    async search(query, limit) {
      const r = await req(`/messages${q({ q: query, maxResults: Math.min(Math.max(limit, 1), 50) })}`);
      const ids: string[] = (r.json.messages ?? []).map((m: Json) => String(m.id));
      return (await mapLimit(ids, 5, (id) => getMessage(id, 'metadata'))).filter((m): m is RemoteMessage => !!m);
    },
  };
  return api;
}

// --- push: users.watch ---------------------------------------------------------------------------------

/** Starts (or renews) the mailbox watch; Gmail publishes changes to the Pub/Sub topic. Lasts up to 7 days. */
export async function gmailWatch(fetcher: typeof fetch, token: TokenFn, topic: string, labels: string[]): Promise<{ historyId: string; expiresAt: string }> {
  const r = await mailRequest('Gmail', fetcher, token, `${BASE}/watch`, { method: 'POST', body: { topicName: topic, labelIds: labels.length && !labels.includes('*') ? labels : ['INBOX', 'SENT', 'DRAFT'], labelFilterBehavior: 'INCLUDE' } });
  return { historyId: String(r.json.historyId ?? ''), expiresAt: new Date(Number(r.json.expiration) || Date.now() + 6 * 864e5).toISOString() };
}

export async function gmailStop(fetcher: typeof fetch, token: TokenFn): Promise<void> {
  await mailRequest('Gmail', fetcher, token, `${BASE}/stop`, { method: 'POST', body: {}, allow: [404] });
}
