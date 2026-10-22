import { mailRequest, type HttpInit, type Json, type TokenFn } from './mailbox-http.js';
import {
  MailError,
  bodyText,
  isoOrEmpty,
  mapLimit,
  stripBrackets,
  type AttachmentInfo,
  type FolderKind,
  type MailApi,
  type MailFolder,
  type MailLabel,
  type MailAddress,
  type MsgChange,
  type OutgoingMail,
  type RemoteMessage,
  type SentRef,
  type SyncInput,
  type SyncOutput,
} from './mailbox-kit.js';
import { htmlToText } from './email-render.js';

/**
 * Microsoft Graph (v1.0, /me or /users/{shared mailbox}) behind the MailApi interface. Sync uses one delta
 * query per chosen folder (the first call filtered by receivedDateTime; afterwards the stored deltaLink);
 * ids are immutable (a message keeps its id when it moves from Drafts to Sent Items or into the Archive).
 * Replies go through createReply so Outlook keeps the conversation together.
 */

const BASE = 'https://graph.microsoft.com/v1.0';
const SELECT = 'id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,createdDateTime,isRead,isDraft,flag,categories,hasAttachments,parentFolderId,bodyPreview,body';
const WELL_KNOWN = ['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems', 'junkemail'] as const;
const DEFAULT_FOLDERS = ['inbox', 'sentitems', 'drafts', 'archive'];
/** Above this a file goes through an upload session instead of the JSON body. */
const INLINE_ATTACHMENT_MAX = 3_000_000;
const CHUNK = 3_500_000;

const KIND: Record<string, FolderKind> = { inbox: 'inbox', sentitems: 'sent', drafts: 'drafts', archive: 'archive', deleteditems: 'trash', junkemail: 'spam' };

const addr = (r: Json | undefined): MailAddress => ({ email: String(r?.emailAddress?.address ?? '').toLowerCase(), name: String(r?.emailAddress?.name ?? '').replace(/[\r\n]+/g, ' ').trim() });
const recipients = (list: MailAddress[]) => list.map((a) => ({ emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) } }));

/** A Graph message resource as a RemoteMessage; `wk` maps well-known folder names to ids. */
export function graphToRemote(m: Json, wk: Record<string, string>): RemoteMessage {
  const kindOfFolder = (Object.entries(wk).find(([, id]) => id === m.parentFolderId)?.[0] ?? '') as string;
  const html = m.body?.contentType === 'html';
  const content = String(m.body?.content ?? '');
  const date = isoOrEmpty(m.receivedDateTime) || isoOrEmpty(m.sentDateTime) || isoOrEmpty(m.createdDateTime);
  return {
    id: String(m.id),
    threadId: String(m.conversationId ?? ''),
    internetId: stripBrackets(m.internetMessageId ?? ''),
    references: '',
    folder: KIND[kindOfFolder] ?? (m.isDraft ? 'drafts' : 'other'),
    folderId: String(m.parentFolderId ?? ''),
    labels: Array.isArray(m.categories) ? m.categories.map(String) : [],
    from: addr(m.from),
    to: (m.toRecipients ?? []).map(addr),
    cc: (m.ccRecipients ?? []).map(addr),
    bcc: (m.bccRecipients ?? []).map(addr),
    subject: String(m.subject ?? ''),
    text: bodyText(html ? htmlToText(content) : content, ''),
    snippet: String(m.bodyPreview ?? '').slice(0, 300),
    date,
    unread: m.isRead === false,
    starred: m.flag?.flagStatus === 'flagged',
    draft: m.isDraft === true,
    attachments: [],
    hasAttachments: m.hasAttachments === true,
    partial: false,
  };
}

const trusted = (url: string) => url.startsWith('https://graph.microsoft.com/');

/** `shared` is the address of a shared mailbox (then /users/{address}); empty = the signed-in user's own (/me). */
export function graphApi(fetcher: typeof fetch, token: TokenFn, shared = ''): MailApi {
  const u = shared ? `users/${encodeURIComponent(shared)}` : 'me';
  const req = (path: string, init: HttpInit = {}) => mailRequest('Microsoft', fetcher, token, path.startsWith('http') ? path : `${BASE}/${path.replace(/^\//, '')}`, init);
  const PREFER = 'IdType="ImmutableId", outlook.body-content-type="text"';
  let wkMemo: Record<string, string> | undefined;

  async function wellKnown(state?: Json): Promise<Record<string, string>> {
    if (state?.wk && Object.keys(state.wk).length) return (wkMemo = state.wk as Record<string, string>);
    if (wkMemo) return wkMemo;
    const found = await Promise.all(WELL_KNOWN.map(async (name) => [name, (await req(`${u}/mailFolders/${name}?$select=id`, { allow: [404] })).json.id] as const));
    wkMemo = Object.fromEntries(found.filter(([, id]) => !!id).map(([n, id]) => [n, String(id)]));
    return wkMemo;
  }

  const withAttachments = async (msgs: RemoteMessage[]) => {
    await mapLimit(msgs.filter((m) => m.hasAttachments), 4, async (m) => {
      try {
        m.attachments = await listAttachments(m.id);
      } catch (e) {
        if (e instanceof MailError && !e.transient && e.status !== 404) throw e;
      }
    });
    return msgs;
  };
  async function listAttachments(id: string): Promise<AttachmentInfo[]> {
    const r = await req(`${u}/messages/${encodeURIComponent(id)}/attachments?$select=id,name,contentType,size,isInline`);
    return (r.json.value ?? []).map((a: Json) => ({ id: String(a.id), name: String(a.name ?? 'Anhang'), type: String(a.contentType ?? 'application/octet-stream'), size: Number(a.size) || 0, inline: a.isInline === true }));
  }

  async function addAttachments(messageId: string, files: OutgoingMail['attachments']) {
    for (const f of files) {
      if (f.content.length <= INLINE_ATTACHMENT_MAX) {
        await req(`${u}/messages/${encodeURIComponent(messageId)}/attachments`, { method: 'POST', body: { '@odata.type': '#microsoft.graph.fileAttachment', name: f.filename, contentType: f.contentType, contentBytes: f.content.toString('base64') } });
        continue;
      }
      const s = await req(`${u}/messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`, { method: 'POST', body: { AttachmentItem: { attachmentType: 'file', name: f.filename, size: f.content.length, contentType: f.contentType } } });
      const url = String(s.json.uploadUrl ?? '');
      if (!url.startsWith('https://')) throw new MailError('Microsoft: Upload-Adresse fehlt', 502);
      for (let start = 0; start < f.content.length; start += CHUNK) {
        const part = f.content.subarray(start, Math.min(start + CHUNK, f.content.length));
        // The upload URL is pre-authorised: no bearer token (Graph refuses one here).
        const r = await fetcher(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${start + part.length - 1}/${f.content.length}` }, body: new Uint8Array(part), signal: AbortSignal.timeout(60_000) });
        if (!r.ok) throw new MailError(`Microsoft: Anhang „${f.filename}“ konnte nicht hochgeladen werden (${r.status})`, r.status);
      }
    }
  }

  const bodyOf = (m: OutgoingMail) => ({ subject: m.subject, body: { contentType: 'html', content: m.html }, toRecipients: recipients(m.to), ccRecipients: recipients(m.cc), bccRecipients: recipients(m.bcc), ...(m.replyTo ? { replyTo: [{ emailAddress: { address: m.replyTo } }] } : {}) });

  async function makeDraft(m: OutgoingMail): Promise<Json> {
    if (m.replyToRemoteId) {
      const d = await req(`${u}/messages/${encodeURIComponent(m.replyToRemoteId)}/createReply`, { method: 'POST', body: {}, headers: { prefer: PREFER }, allow: [404] });
      if (d.status !== 404) {
        const patched = await req(`${u}/messages/${encodeURIComponent(String(d.json.id))}`, { method: 'PATCH', body: bodyOf(m), headers: { prefer: PREFER } });
        return { ...d.json, ...patched.json };
      }
    }
    return (await req(`${u}/messages`, { method: 'POST', body: bodyOf(m), headers: { prefer: PREFER } })).json;
  }

  const refOf = (d: Json, draftId = ''): SentRef => ({ id: String(d.id), draftId, threadId: String(d.conversationId ?? ''), internetId: stripBrackets(d.internetMessageId ?? '') });

  const api: MailApi = {
    kind: 'microsoft',

    async profile() {
      if (shared) return { address: shared.toLowerCase() };
      const r = await req('me?$select=mail,userPrincipalName,displayName');
      return { address: String(r.json.mail || r.json.userPrincipalName || '').toLowerCase(), name: String(r.json.displayName ?? '') };
    },

    async folders(state = {}) {
      const wk = await wellKnown(state);
      const root = await req(`${u}/mailFolders?$top=100&$select=id,displayName`);
      const list: MailFolder[] = [];
      const seen = new Set<string>();
      const add = (f: Json, prefix = '') => {
        const id = String(f.id);
        if (seen.has(id)) return;
        seen.add(id);
        const key = Object.entries(wk).find(([, v]) => v === id)?.[0] ?? '';
        if (key === 'deleteditems' || key === 'junkemail') return;
        list.push({ id, name: `${prefix}${String(f.displayName)}`, kind: KIND[key] ?? 'other', system: !!key });
      };
      for (const f of (root.json.value ?? []) as Json[]) add(f);
      if (wk.inbox) {
        const kids = await req(`${u}/mailFolders/${wk.inbox}/childFolders?$top=100&$select=id,displayName`, { allow: [404] });
        for (const f of (kids.json.value ?? []) as Json[]) add(f, 'Posteingang / ');
      }
      return { folders: list, state: { ...state, wk } };
    },

    async labels(): Promise<MailLabel[]> {
      const r = await req(`${u}/outlook/masterCategories`, { allow: [403, 404] });
      return ((r.json.value ?? []) as Json[]).map((c) => ({ id: String(c.displayName), name: String(c.displayName) }));
    },

    async createLabel(name) {
      const r = await req(`${u}/outlook/masterCategories`, { method: 'POST', body: { displayName: name, color: 'preset0' } });
      return { id: String(r.json.displayName ?? name), name: String(r.json.displayName ?? name) };
    },

    async get(id) {
      const r = await req(`${u}/messages/${encodeURIComponent(id)}?$select=${SELECT}`, { headers: { prefer: PREFER }, allow: [404] });
      if (r.status === 404) return null;
      const [msg] = await withAttachments([graphToRemote(r.json, await wellKnown())]);
      return msg;
    },

    async sync(o: SyncInput): Promise<SyncOutput> {
      const st: Record<string, any> = { ...o.state, delta: { ...(o.state.delta ?? {}) }, pending: { ...(o.state.pending ?? {}) } };
      const wk = await wellKnown(st);
      st.wk = wk;
      const folderIds = [...new Set((o.folders.length ? o.folders : DEFAULT_FOLDERS).map((f) => wk[f] ?? f).filter(Boolean))];
      // Folders no longer chosen drop their cursors.
      for (const k of Object.keys(st.delta)) if (!folderIds.includes(k)) delete st.delta[k];
      for (const k of Object.keys(st.pending)) if (!folderIds.includes(k)) delete st.pending[k];
      const cycle: string[] = Array.isArray(st.cycle) ? st.cycle : [];
      const messages: RemoteMessage[] = [];
      const deleted: SyncOutput['deleted'] = [];
      let budget = Math.min(Math.max(o.limit, 1), 100);
      for (const folderId of folderIds) {
        if (cycle.includes(folderId)) continue;
        let url: string = st.pending[folderId] || st.delta[folderId] || '';
        if (url && !trusted(url)) url = '';
        const hadLink = !!url;
        if (!url) {
          const filter = folderId === wk.drafts ? '' : `&$filter=${encodeURIComponent(`receivedDateTime ge ${new Date(o.since).toISOString().replace(/\.\d+Z$/, 'Z')}`)}`;
          url = `${BASE}/${u}/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=${SELECT}${filter}`;
        }
        const r = await req(url, { headers: { prefer: `odata.maxpagesize=${Math.min(budget, 50)}, ${PREFER}` }, allow: [404, 410] });
        if (r.status === 404 || r.status === 410) {
          // Without a stored link the folder itself is gone: skip it. With one, the delta window expired:
          // read this folder again from the start of the window.
          delete st.delta[folderId];
          delete st.pending[folderId];
          if (hadLink) {
            st.cycle = cycle;
            return { messages, deleted, state: st, more: true };
          }
          cycle.push(folderId);
          continue;
        }
        for (const item of (r.json.value ?? []) as Json[]) {
          if (item['@removed']) deleted.push({ id: String(item.id), folderId });
          else messages.push(graphToRemote(item, wk));
        }
        budget -= (r.json.value ?? []).length;
        const next = r.json['@odata.nextLink'];
        const delta = r.json['@odata.deltaLink'];
        if (next && trusted(String(next))) st.pending[folderId] = String(next);
        else {
          delete st.pending[folderId];
          if (delta) st.delta[folderId] = String(delta);
          cycle.push(folderId);
        }
        if (budget <= 0) break;
      }
      const more = folderIds.some((f) => !cycle.includes(f));
      if (more) st.cycle = cycle;
      else delete st.cycle;
      await withAttachments(messages);
      return { messages, deleted, state: st, more };
    },

    async attachment(messageId, attachmentId) {
      const r = await req(`${u}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
      if (!r.json.contentBytes) throw new MailError('Microsoft: Dieser Anhang hat keinen Inhalt zum Herunterladen', 404);
      return Buffer.from(String(r.json.contentBytes), 'base64');
    },

    async send(m) {
      const d = await makeDraft(m);
      await addAttachments(String(d.id), m.attachments);
      await req(`${u}/messages/${encodeURIComponent(String(d.id))}/send`, { method: 'POST' });
      let ref = refOf(d);
      if (!ref.internetId) {
        // Some drafts have no Message-ID before they are sent: read it from the sent copy.
        const sent = await req(`${u}/messages/${encodeURIComponent(ref.id)}?$select=internetMessageId,conversationId`, { allow: [404] });
        ref = { ...ref, internetId: stripBrackets(sent.json.internetMessageId ?? ''), threadId: ref.threadId || String(sent.json.conversationId ?? '') };
      }
      return ref;
    },

    async createDraft(m) {
      const d = await makeDraft(m);
      await addAttachments(String(d.id), m.attachments);
      return refOf(d);
    },

    async updateDraft(ref, m) {
      const d = await req(`${u}/messages/${encodeURIComponent(ref.id)}`, { method: 'PATCH', body: bodyOf(m), headers: { prefer: PREFER } });
      if (m.attachments.length) {
        for (const a of await listAttachments(ref.id)) await req(`${u}/messages/${encodeURIComponent(ref.id)}/attachments/${encodeURIComponent(a.id)}`, { method: 'DELETE', allow: [404] });
        await addAttachments(ref.id, m.attachments);
      }
      return refOf({ ...d.json, id: ref.id });
    },

    async sendDraft(ref) {
      await req(`${u}/messages/${encodeURIComponent(ref.id)}/send`, { method: 'POST' });
      return { id: ref.id, threadId: '' };
    },

    async deleteDraft(ref) {
      await req(`${u}/messages/${encodeURIComponent(ref.id)}`, { method: 'DELETE', allow: [404] });
    },

    async modify(id, change: MsgChange, state) {
      const patch: Json = {};
      if (change.read !== undefined) patch.isRead = change.read;
      if (change.starred !== undefined) patch.flag = { flagStatus: change.starred ? 'flagged' : 'notFlagged' };
      if (change.addLabels?.length || change.removeLabels?.length) {
        const cur = await req(`${u}/messages/${encodeURIComponent(id)}?$select=categories`, { allow: [404] });
        if (cur.status === 404) return;
        const set = new Set<string>((cur.json.categories ?? []).map(String));
        for (const l of change.addLabels ?? []) set.add(l);
        for (const l of change.removeLabels ?? []) set.delete(l);
        patch.categories = [...set];
      }
      if (Object.keys(patch).length) await req(`${u}/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, allow: [404] });
      if (change.archived !== undefined) {
        const wk = await wellKnown(state);
        const dest = change.archived ? wk.archive : wk.inbox;
        if (!dest) throw new MailError('Microsoft: Der Ordner „Archiv“ fehlt in diesem Postfach', 404);
        await req(`${u}/messages/${encodeURIComponent(id)}/move`, { method: 'POST', body: { destinationId: dest }, headers: { prefer: PREFER }, allow: [404] });
      }
    },

    async search(query, limit) {
      const term = query.replace(/["\\]/g, ' ').trim();
      const r = await req(`${u}/messages?$search=${encodeURIComponent(`"${term}"`)}&$top=${Math.min(Math.max(limit, 1), 50)}&$select=${SELECT}`, { headers: { prefer: PREFER } });
      const wk = await wellKnown();
      return ((r.json.value ?? []) as Json[]).map((m) => graphToRemote(m, wk));
    },
  };
  return api;
}

// --- push: change notifications ---------------------------------------------------------------------

/** Longest lifetime of a message subscription is 4230 minutes; we ask for a little less. */
const SUBSCRIPTION_MINUTES = 4200;
const expiry = () => new Date(Date.now() + SUBSCRIPTION_MINUTES * 60_000).toISOString();

export async function graphSubscribe(fetcher: typeof fetch, token: TokenFn, o: { shared?: string; notificationUrl: string; lifecycleUrl: string; clientState: string }): Promise<{ id: string; expiresAt: string }> {
  const resource = o.shared ? `users/${o.shared}/messages` : 'me/messages';
  const r = await mailRequest('Microsoft', fetcher, token, `${BASE}/subscriptions`, {
    method: 'POST',
    body: { changeType: 'created,updated,deleted', notificationUrl: o.notificationUrl, lifecycleNotificationUrl: o.lifecycleUrl, resource, expirationDateTime: expiry(), clientState: o.clientState },
  });
  return { id: String(r.json.id), expiresAt: isoOrEmpty(r.json.expirationDateTime) || expiry() };
}

/** Renews a subscription; null when Graph no longer knows it (create a new one). */
export async function graphRenew(fetcher: typeof fetch, token: TokenFn, id: string): Promise<{ expiresAt: string } | null> {
  const r = await mailRequest('Microsoft', fetcher, token, `${BASE}/subscriptions/${encodeURIComponent(id)}`, { method: 'PATCH', body: { expirationDateTime: expiry() }, allow: [404] });
  return r.status === 404 ? null : { expiresAt: isoOrEmpty(r.json.expirationDateTime) || expiry() };
}

export async function graphUnsubscribe(fetcher: typeof fetch, token: TokenFn, id: string): Promise<void> {
  await mailRequest('Microsoft', fetcher, token, `${BASE}/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE', allow: [404] });
}
