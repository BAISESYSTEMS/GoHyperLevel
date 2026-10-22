import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { G_CLIENT, MS_CLIENT, jwt } from './oauth-fakes.js';

/**
 * In-memory Gmail API and Microsoft Graph (mail) plus their OAuth token endpoints – the tests never talk to the
 * real services. Plug `fake.fetch` into `app.services.oauthFetch`. Both behave like the real thing where the code
 * relies on it: Gmail history ids and 404 for too old ones, label changes, drafts whose message id changes on an
 * edit; Graph delta queries with next/delta links and 410 when the window expired, immutable ids, createReply,
 * upload sessions, subscriptions that are validated by calling the notification URL.
 */

export { G_CLIENT, MS_CLIENT };
const json = (d: unknown, status = 200, headers: Record<string, string> = {}) => new Response(status === 204 || status === 202 ? null : JSON.stringify(d), { status, headers: { 'content-type': 'application/json', ...headers } });
const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url');
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export interface Req {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  raw?: any;
}

export interface GmailSpec {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  text?: string;
  html?: string;
  labels?: string[];
  threadId?: string;
  date?: string;
  messageId?: string;
  references?: string;
  attachments?: { name: string; type?: string; data: string }[];
  charset?: string;
}

export function createMailFake() {
  const reqs: Req[] = [];
  let n = 0;

  // ================================ Google ================================
  const g = {
    address: 'inhaber@gmail.example',
    name: 'Paul Test',
    codes: new Map<string, { challenge: string; scope: string; redirect: string }>(),
    access: 'g-access-0',
    refresh: 'g-refresh-1',
    refreshCount: 0,
    failRefresh: false,
    /** Next access token the server hands out is already expired for the API (a 401 on the first call). */
    revoked: [] as string[],
    grantScope: undefined as string | undefined,
    historyId: 1000,
    messages: new Map<string, any>(),
    history: [] as { id: number; kind: 'added' | 'deleted' | 'labelsAdded' | 'labelsRemoved'; id_: string; labels?: string[] }[],
    oldestHistory: 1000,
    drafts: new Map<string, string>(),
    labels: [
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'SENT', name: 'SENT', type: 'system' },
      { id: 'DRAFT', name: 'DRAFT', type: 'system' },
      { id: 'TRASH', name: 'TRASH', type: 'system' },
      { id: 'SPAM', name: 'SPAM', type: 'system' },
      { id: 'Label_1', name: 'Kunde', type: 'user' },
      { id: 'Label_2', name: 'Angebot', type: 'user' },
    ] as any[],
    watch: null as null | { topicName: string; labelIds: string[] },
    stopped: 0,
    /** Fail the next N calls whose path matches with this status. */
    failures: [] as { match: RegExp; status: number; times: number }[],
    sentRaw: [] as { raw: string; threadId?: string; parsed: any }[],
    attachmentFetches: 0,
  };

  const bump = () => ++g.historyId;
  function gHeaders(m: any) {
    const h: { name: string; value: string }[] = [
      { name: 'From', value: m.from },
      { name: 'To', value: m.to },
      { name: 'Subject', value: m.subject },
      { name: 'Date', value: new Date(m.internalDate).toUTCString() },
    ];
    if (m.cc) h.push({ name: 'Cc', value: m.cc });
    if (m.messageId) h.push({ name: 'Message-ID', value: `<${m.messageId}>` });
    if (m.references) h.push({ name: 'References', value: m.references });
    if (m.inReplyTo) h.push({ name: 'In-Reply-To', value: m.inReplyTo });
    return h;
  }
  function gResource(m: any, format: string) {
    const base = { id: m.id, threadId: m.threadId, labelIds: [...m.labels], snippet: String(m.text).slice(0, 100), historyId: String(m.historyId), internalDate: String(m.internalDate) };
    if (format === 'minimal') return base;
    const ct = `text/plain; charset=${m.charset ?? 'UTF-8'}`;
    const body = m.charset && m.charset.toLowerCase() !== 'utf-8' ? Buffer.from(m.text, m.charset === 'ISO-8859-1' ? 'latin1' : 'utf8') : Buffer.from(m.text);
    const parts: any[] = [{ partId: '0', mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: ct }], body: { size: body.length, data: b64(body) } }];
    if (m.html) parts.push({ partId: '1', mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }], body: { size: m.html.length, data: b64(m.html) } });
    for (const a of m.attachments ?? []) parts.push({ partId: a.id, mimeType: a.type, filename: a.name, headers: [{ name: 'Content-Disposition', value: `attachment; filename="${a.name}"` }], body: { attachmentId: a.id, size: Buffer.from(a.data, 'base64').length } });
    const payload = { mimeType: m.attachments?.length ? 'multipart/mixed' : 'multipart/alternative', headers: gHeaders(m), parts };
    if (format === 'metadata') return { ...base, payload: { headers: gHeaders(m) } };
    return { ...base, payload };
  }
  /** A message arrives (or is created by the person in Gmail): history records it. */
  function gAdd(spec: GmailSpec & { id?: string; sentByUs?: boolean }) {
    const id = spec.id ?? `gm${++n}`;
    const labels = spec.labels ?? ['INBOX', 'UNREAD'];
    const m = {
      id,
      threadId: spec.threadId ?? `th${n}`,
      labels,
      from: spec.from ?? 'kunde@firma.example',
      to: spec.to ?? g.address,
      cc: spec.cc ?? '',
      subject: spec.subject ?? 'Anfrage',
      text: spec.text ?? 'Guten Tag, ich habe eine Frage.',
      html: spec.html ?? '',
      internalDate: spec.date ? Date.parse(spec.date) : Date.now(),
      messageId: spec.messageId ?? `${id}@mail.example`,
      references: spec.references ?? '',
      inReplyTo: '',
      attachments: (spec.attachments ?? []).map((a, i) => ({ id: `att-${id}-${i}`, name: a.name, type: a.type ?? 'application/pdf', data: a.data })),
      charset: spec.charset,
      historyId: bump(),
    };
    g.messages.set(id, m);
    g.history.push({ id: m.historyId, kind: 'added', id_: id, labels });
    return m;
  }
  function gLabels(id: string, add: string[], remove: string[]) {
    const m = g.messages.get(id);
    if (!m) return;
    const before = new Set(m.labels);
    m.labels = [...new Set<string>([...m.labels.filter((l: string) => !remove.includes(l)), ...add])];
    m.historyId = bump();
    const added = add.filter((l) => !before.has(l));
    const removed = remove.filter((l) => before.has(l));
    if (added.length) g.history.push({ id: m.historyId, kind: 'labelsAdded', id_: id, labels: m.labels });
    if (removed.length) g.history.push({ id: m.historyId, kind: 'labelsRemoved', id_: id, labels: m.labels });
  }
  function gDelete(id: string) {
    g.messages.delete(id);
    g.history.push({ id: bump(), kind: 'deleted', id_: id });
  }
  /** The person writes a draft in the Gmail web UI. */
  function gDraft(spec: GmailSpec) {
    const m = gAdd({ ...spec, labels: ['DRAFT'], from: spec.from ?? g.address });
    const draftId = `dr${++n}`;
    g.drafts.set(draftId, m.id);
    return { draftId, message: m };
  }
  /** The person edits a draft in Gmail: the draft keeps its id, the message gets a new one. */
  function gEditDraft(draftId: string, patch: GmailSpec) {
    const old = g.messages.get(g.drafts.get(draftId)!);
    gDelete(old.id);
    const m = gAdd({ from: old.from, to: old.to, subject: old.subject, text: old.text, threadId: old.threadId, messageId: old.messageId, ...patch, labels: ['DRAFT'] });
    g.drafts.set(draftId, m.id);
    return m;
  }

  async function parseRaw(raw: string) {
    const p = await simpleParser(Buffer.from(raw, 'base64url'));
    const list = (v: any) => (v ? (Array.isArray(v) ? v : [v]).flatMap((x: any) => x.value ?? []).map((a: any) => a.address) : []);
    return {
      to: list(p.to),
      cc: list(p.cc),
      bcc: Buffer.from(raw, 'base64url').toString().match(/^Bcc: (.+)$/im)?.[1] ?? '',
      from: list(p.from)[0],
      subject: p.subject ?? '',
      text: String(p.text ?? ''),
      html: String(p.html || ''),
      messageId: String(p.messageId ?? '').replace(/[<>]/g, ''),
      inReplyTo: String(p.inReplyTo ?? '').replace(/[<>]/g, ''),
      references: Array.isArray(p.references) ? p.references.join(' ') : String(p.references ?? ''),
      attachments: (p.attachments ?? []).map((a) => ({ filename: a.filename, type: a.contentType, content: a.content })),
    };
  }

  async function google(url: URL, method: string, headers: Record<string, string>, body: any): Promise<Response> {
    if (url.href === 'https://oauth2.googleapis.com/token') {
      if (body.client_id !== G_CLIENT.client_id || body.client_secret !== G_CLIENT.client_secret) return json({ error: 'invalid_client' }, 401);
      if (body.grant_type === 'authorization_code') {
        const c = g.codes.get(body.code);
        g.codes.delete(body.code);
        if (!c) return json({ error: 'invalid_grant', error_description: 'Bad code' }, 400);
        if (challengeOf(body.code_verifier ?? '') !== c.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
        if (body.redirect_uri !== c.redirect) return json({ error: 'redirect_uri_mismatch' }, 400);
        g.access = `g-access-${++n}`;
        const granted = g.grantScope ?? c.scope.split(' ').map((s) => (s === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : s)).join(' ');
        return json({ access_token: g.access, refresh_token: g.refresh, expires_in: 3599, scope: granted, token_type: 'Bearer', id_token: jwt({ email: g.address, name: g.name, sub: '42' }) });
      }
      if (body.grant_type === 'refresh_token') {
        if (g.failRefresh || body.refresh_token !== g.refresh) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
        g.refreshCount++;
        g.access = `g-access-${++n}`;
        return json({ access_token: g.access, expires_in: 3599, scope: 'x', token_type: 'Bearer' });
      }
    }
    if (url.href === 'https://oauth2.googleapis.com/revoke') {
      g.revoked.push(body.token);
      return json({});
    }
    if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return json({ keys: jwks.keys });
    if (headers.authorization !== `Bearer ${g.access}`) return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
    const p = url.pathname.replace(/^\/gmail\/v1\/users\/me/, '');
    const fail = g.failures.find((f) => f.times > 0 && f.match.test(`${method} ${p}`));
    if (fail) {
      fail.times--;
      return json({ error: { code: fail.status, message: `fake failure ${fail.status}` } }, fail.status, fail.status === 429 ? { 'retry-after': '1' } : {});
    }
    if (p === '/profile') return json({ emailAddress: g.address, historyId: String(g.historyId), messagesTotal: g.messages.size });
    if (p === '/labels' && method === 'GET') return json({ labels: g.labels });
    if (p === '/labels' && method === 'POST') {
      const l = { id: `Label_${g.labels.length + 1}`, name: body.name, type: 'user' };
      g.labels.push(l);
      return json(l);
    }
    if (p === '/messages' && method === 'GET') {
      const want = url.searchParams.getAll('labelIds');
      const after = /after:(\d+)/.exec(url.searchParams.get('q') ?? '')?.[1];
      const max = Number(url.searchParams.get('maxResults') ?? 100);
      const off = Number(url.searchParams.get('pageToken') ?? 0);
      const text = url.searchParams.get('q') ?? '';
      let list = [...g.messages.values()].filter((m) => !m.labels.includes('SPAM') && !m.labels.includes('TRASH') && want.every((l) => m.labels.includes(l)) && (!after || m.internalDate >= Number(after) * 1000));
      if (text && !after) list = list.filter((m) => `${m.subject} ${m.text} ${m.from}`.toLowerCase().includes(text.toLowerCase()));
      list.sort((a, b) => b.internalDate - a.internalDate);
      const page = list.slice(off, off + max);
      return json({ messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), ...(off + max < list.length ? { nextPageToken: String(off + max) } : {}), resultSizeEstimate: list.length });
    }
    let m = p.match(/^\/messages\/([^/]+)$/);
    if (m && method === 'GET') {
      const msg = g.messages.get(decodeURIComponent(m[1]));
      return msg ? json(gResource(msg, url.searchParams.get('format') ?? 'full')) : json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404);
    }
    m = p.match(/^\/messages\/([^/]+)\/modify$/);
    if (m && method === 'POST') {
      if (!g.messages.has(m[1])) return json({ error: { code: 404, message: 'Not found' } }, 404);
      gLabels(m[1], body.addLabelIds ?? [], body.removeLabelIds ?? []);
      return json(gResource(g.messages.get(m[1]), 'minimal'));
    }
    m = p.match(/^\/messages\/([^/]+)\/attachments\/([^/]+)$/);
    if (m) {
      const msg = g.messages.get(m[1]);
      const att = msg?.attachments.find((a: any) => a.id === decodeURIComponent(m![2]));
      g.attachmentFetches++;
      return att ? json({ size: Buffer.from(att.data, 'base64').length, data: b64(Buffer.from(att.data, 'base64')) }) : json({ error: { code: 404, message: 'Attachment not found' } }, 404);
    }
    if (p === '/history') {
      const start = Number(url.searchParams.get('startHistoryId'));
      if (start < g.oldestHistory) return json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404);
      const max = Number(url.searchParams.get('maxResults') ?? 100);
      const off = Number(url.searchParams.get('pageToken') ?? 0);
      const recs = g.history.filter((h) => h.id > start);
      const page = recs.slice(off, off + max);
      const history = page.map((h) => {
        const message = { id: h.id_, threadId: g.messages.get(h.id_)?.threadId ?? '', labelIds: h.labels ?? [] };
        return { id: String(h.id), ...(h.kind === 'added' ? { messagesAdded: [{ message }] } : h.kind === 'deleted' ? { messagesDeleted: [{ message }] } : h.kind === 'labelsAdded' ? { labelsAdded: [{ message, labelIds: [] }] } : { labelsRemoved: [{ message, labelIds: [] }] }) };
      });
      return json({ history, historyId: String(g.historyId), ...(off + max < recs.length ? { nextPageToken: String(off + max) } : {}) });
    }
    if (p === '/messages/send' && method === 'POST') {
      const parsed = await parseRaw(body.raw);
      g.sentRaw.push({ raw: body.raw, threadId: body.threadId, parsed });
      const msg = gAdd({ from: parsed.from, to: parsed.to.join(', '), cc: parsed.cc.join(', '), subject: parsed.subject, text: parsed.text, threadId: body.threadId, labels: ['SENT'], messageId: parsed.messageId, references: parsed.references });
      msg.inReplyTo = parsed.inReplyTo;
      msg.attachments = parsed.attachments.map((a, i) => ({ id: `att-${msg.id}-${i}`, name: a.filename ?? 'x', type: a.type, data: a.content.toString('base64') }));
      return json({ id: msg.id, threadId: msg.threadId, labelIds: msg.labels });
    }
    if (p === '/drafts' && method === 'GET') return json({ drafts: [...g.drafts].filter(([, mid]) => g.messages.has(mid)).map(([id, mid]) => ({ id, message: { id: mid, threadId: g.messages.get(mid).threadId } })) });
    if (p === '/drafts' && method === 'POST') {
      const parsed = await parseRaw(body.message.raw);
      const { draftId, message } = gDraft({ from: parsed.from, to: parsed.to.join(', '), cc: parsed.cc.join(', '), subject: parsed.subject, text: parsed.text, threadId: body.message.threadId, messageId: parsed.messageId });
      message.inReplyTo = parsed.inReplyTo;
      g.sentRaw.push({ raw: body.message.raw, threadId: body.message.threadId, parsed });
      return json({ id: draftId, message: { id: message.id, threadId: message.threadId, labelIds: message.labels } });
    }
    if (p === '/drafts/send' && method === 'POST') {
      const mid = g.drafts.get(body.id);
      if (!mid || !g.messages.has(mid)) return json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404);
      g.drafts.delete(body.id);
      gLabels(mid, ['SENT'], ['DRAFT']);
      const msg = g.messages.get(mid);
      return json({ id: msg.id, threadId: msg.threadId, labelIds: msg.labels });
    }
    m = p.match(/^\/drafts\/([^/]+)$/);
    if (m && method === 'PUT') {
      const did = decodeURIComponent(m[1]);
      if (!g.drafts.has(did)) return json({ error: { code: 404, message: 'Not found' } }, 404);
      const parsed = await parseRaw(body.message.raw);
      const msg = gEditDraft(did, { from: parsed.from, to: parsed.to.join(', '), cc: parsed.cc.join(', '), subject: parsed.subject, text: parsed.text, messageId: parsed.messageId, threadId: body.message.threadId });
      g.sentRaw.push({ raw: body.message.raw, threadId: body.message.threadId, parsed });
      return json({ id: did, message: { id: msg.id, threadId: msg.threadId } });
    }
    if (m && method === 'DELETE') {
      const did = decodeURIComponent(m[1]);
      const mid = g.drafts.get(did);
      if (!mid) return json({ error: { code: 404, message: 'Not found' } }, 404);
      g.drafts.delete(did);
      gDelete(mid);
      return json(null, 204);
    }
    if (p === '/watch' && method === 'POST') {
      g.watch = { topicName: body.topicName, labelIds: body.labelIds };
      return json({ historyId: String(g.historyId), expiration: String(Date.now() + 7 * 864e5) });
    }
    if (p === '/stop' && method === 'POST') {
      g.stopped++;
      g.watch = null;
      return json({});
    }
    return json({ error: { code: 404, message: `fake gmail: ${method} ${url.href}` } }, 404);
  }

  // ================================ Microsoft ================================
  interface GraphBox {
    address: string;
    wk: Record<string, string>;
    folders: { id: string; displayName: string; parent?: string }[];
    messages: Map<string, any>;
    seq: number;
    removed: { folderId: string; id: string; seq: number }[];
    categories: string[];
    expireDelta: boolean;
    /** Messages sent through the API (for assertions). */
    sent: any[];
    deltaCalls: { folderId: string; url: string }[];
  }
  const newBox = (address: string): GraphBox => ({
    address,
    wk: { inbox: 'AAinbox', sentitems: 'AAsent', drafts: 'AAdrafts', archive: 'AAarchive', deleteditems: 'AAdeleted', junkemail: 'AAjunk' },
    folders: [
      { id: 'AAinbox', displayName: 'Posteingang' },
      { id: 'AAsent', displayName: 'Gesendete Elemente' },
      { id: 'AAdrafts', displayName: 'Entwürfe' },
      { id: 'AAarchive', displayName: 'Archiv' },
      { id: 'AAdeleted', displayName: 'Gelöschte Elemente' },
      { id: 'AAjunk', displayName: 'Junk-E-Mail' },
      { id: 'AAkunden', displayName: 'Kunden', parent: 'AAinbox' },
    ],
    messages: new Map(),
    seq: 0,
    removed: [],
    categories: ['Wichtig', 'Angebot'],
    expireDelta: false,
    sent: [],
    deltaCalls: [],
  });
  const ms = {
    codes: new Map<string, { challenge: string; scope: string; redirect: string }>(),
    access: 'ms-access-0',
    refresh: 'ms-refresh-1',
    refreshCount: 0,
    failRefresh: false,
    grantScope: undefined as string | undefined,
    address: 'inhaber@firma.example',
    name: 'Paul Firma',
    boxes: { me: newBox('inhaber@firma.example'), 'shared@firma.example': newBox('shared@firma.example') } as Record<string, GraphBox>,
    subs: new Map<string, { id: string; resource: string; expirationDateTime: string; clientState: string; notificationUrl: string; lifecycleNotificationUrl: string }>(),
    /** Called by subscription creation to check the validation handshake against our server. */
    selfUrl: '',
    validationFailed: false,
    uploads: new Map<string, { messageId: string; name: string; chunks: { range: string; size: number }[] }>(),
    unauthorizedUploads: 0,
    failures: [] as { match: RegExp; status: number; times: number }[],
    inlineAttachmentLimitHit: 0,
  };
  const box = (u: string) => (u === 'me' ? ms.boxes.me : ms.boxes[decodeURIComponent(u.replace(/^users\//, ''))]);
  const mAddr = (s: string) => ({ emailAddress: { address: s.replace(/^.*<|>.*$/g, '').trim().toLowerCase(), name: /^(.*)</.test(s) ? s.replace(/<.*$/, '').replace(/"/g, '').trim() : '' } });

  /** A message arrives in a folder (or is created by the person in Outlook). */
  function mAdd(who: 'me' | string, spec: { folder?: string; from?: string; to?: string; subject?: string; text?: string; conversationId?: string; date?: string; draft?: boolean; read?: boolean; internetMessageId?: string; categories?: string[]; attachments?: { name: string; type?: string; data: string }[]; id?: string }) {
    const b = box(who);
    const folder = spec.folder ?? (spec.draft ? 'drafts' : 'inbox');
    const id = spec.id ?? `gr${++n}`;
    const m: any = {
      id,
      conversationId: spec.conversationId ?? `conv${n}`,
      internetMessageId: spec.internetMessageId ?? `<${id}@outlook.example>`,
      subject: spec.subject ?? 'Anfrage',
      body: { contentType: 'text', content: spec.text ?? 'Guten Tag, ich habe eine Frage.' },
      bodyPreview: String(spec.text ?? 'Guten Tag').slice(0, 100),
      from: spec.draft ? undefined : mAddr(spec.from ?? 'kunde@firma.example'),
      toRecipients: [mAddr(spec.to ?? b.address)],
      ccRecipients: [],
      bccRecipients: [],
      receivedDateTime: spec.date ?? new Date().toISOString(),
      sentDateTime: spec.date ?? new Date().toISOString(),
      isRead: spec.read ?? !!spec.draft,
      isDraft: !!spec.draft,
      flag: { flagStatus: 'notFlagged' },
      categories: spec.categories ?? [],
      parentFolderId: b.wk[folder] ?? folder,
      attachments: (spec.attachments ?? []).map((a, i) => ({ id: `att${id}${i}`, name: a.name, contentType: a.type ?? 'application/pdf', data: a.data, isInline: false, size: Buffer.from(a.data, 'base64').length })),
      seq: ++b.seq,
    };
    m.hasAttachments = m.attachments.length > 0;
    b.messages.set(id, m);
    return m;
  }
  const mTouch = (b: GraphBox, m: any) => (m.seq = ++b.seq);
  function mMove(b: GraphBox, m: any, folderId: string) {
    b.removed.push({ folderId: m.parentFolderId, id: m.id, seq: ++b.seq });
    m.parentFolderId = folderId;
    mTouch(b, m);
  }
  function mDelete(b: GraphBox, m: any) {
    b.removed.push({ folderId: m.parentFolderId, id: m.id, seq: ++b.seq });
    b.messages.delete(m.id);
  }
  const gOut = (m: any) => {
    const { attachments: _a, seq: _s, ...rest } = m;
    return rest;
  };

  async function microsoft(url: URL, method: string, headers: Record<string, string>, body: any, rawBody: any): Promise<Response> {
    if (url.href === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
      if (body.client_id !== MS_CLIENT.client_id || body.client_secret !== MS_CLIENT.client_secret) return json({ error: 'invalid_client' }, 401);
      if (body.grant_type === 'authorization_code') {
        const c = ms.codes.get(body.code);
        ms.codes.delete(body.code);
        if (!c || challengeOf(body.code_verifier ?? '') !== c.challenge || body.redirect_uri !== c.redirect) return json({ error: 'invalid_grant', error_description: 'AADSTS: bad code' }, 400);
        ms.access = `ms-access-${++n}`;
        const granted = ms.grantScope ?? c.scope.split(' ').map((s) => (/^Mail\./.test(s) ? `https://graph.microsoft.com/${s}` : s)).join(' ');
        return json({ access_token: ms.access, refresh_token: ms.refresh, expires_in: 3600, scope: granted, id_token: jwt({ preferred_username: ms.address, name: ms.name, oid: 'o1' }) });
      }
      if (body.grant_type === 'refresh_token') {
        if (ms.failRefresh || body.refresh_token !== ms.refresh) return json({ error: 'invalid_grant', error_description: 'AADSTS70008: expired' }, 400);
        ms.refreshCount++;
        ms.access = `ms-access-${++n}`;
        return json({ access_token: ms.access, expires_in: 3600, scope: 'Mail.ReadWrite', refresh_token: ms.refresh });
      }
    }
    if (url.host === 'upload.example.test') {
      if (headers.authorization) ms.unauthorizedUploads++;
      const up = ms.uploads.get(url.pathname);
      if (!up) return json({ error: { message: 'no session' } }, 404);
      up.chunks.push({ range: headers['content-range'], size: Number(headers['content-length'] ?? rawBody?.length ?? 0) || (rawBody?.length ?? 0) });
      const [, a, z, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers['content-range'] ?? '') ?? [];
      if (Number(z) + 1 >= Number(total)) {
        const b = ms.boxes.me;
        const m = b.messages.get(up.messageId);
        m?.attachments.push({ id: `up${++n}`, name: up.name, contentType: 'application/octet-stream', data: '', isInline: false, size: Number(total) });
        if (m) m.hasAttachments = true;
        return json({ id: 'uploaded' }, 201);
      }
      void a;
      return json({ nextExpectedRanges: [`${Number(z) + 1}-`] }, 200);
    }
    if (headers.authorization !== `Bearer ${ms.access}`) return json({ error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired or is not yet valid.' } }, 401);
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0\//, ''));
    const fail = ms.failures.find((f) => f.times > 0 && f.match.test(`${method} ${path}`));
    if (fail) {
      fail.times--;
      return json({ error: { code: 'ServiceNotAvailable', message: `fake failure ${fail.status}` } }, fail.status, fail.status === 429 ? { 'retry-after': '1' } : {});
    }
    // subscriptions
    if (path === 'subscriptions' && method === 'POST') {
      // Graph validates the notification URL before it creates the subscription.
      const token = `validate-${++n}`;
      try {
        const r = await realFetch(`${body.notificationUrl.replace(/^https?:\/\/[^/]+/, ms.selfUrl)}?validationToken=${token}`, { method: 'POST', headers: { 'content-type': 'text/plain' } });
        const t = await r.text();
        if (!r.ok || t !== token || !/^text\/plain/.test(r.headers.get('content-type') ?? '')) throw new Error(`bad echo ${r.status} ${t}`);
      } catch (e) {
        ms.validationFailed = true;
        return json({ error: { code: 'ValidationError', message: `Subscription validation request failed: ${(e as Error).message}` } }, 400);
      }
      const sub = { id: `sub${++n}`, resource: body.resource, expirationDateTime: body.expirationDateTime, clientState: body.clientState, notificationUrl: body.notificationUrl, lifecycleNotificationUrl: body.lifecycleNotificationUrl };
      ms.subs.set(sub.id, sub);
      return json(sub, 201);
    }
    let m = path.match(/^subscriptions\/([^/]+)$/);
    if (m) {
      const sub = ms.subs.get(m[1]);
      if (!sub) return json({ error: { code: 'ResourceNotFound', message: 'Subscription not found' } }, 404);
      if (method === 'PATCH') {
        sub.expirationDateTime = body.expirationDateTime;
        return json(sub);
      }
      if (method === 'DELETE') {
        ms.subs.delete(m[1]);
        return json(null, 204);
      }
    }
    if (path === 'me' && method === 'GET') return json({ mail: ms.address, userPrincipalName: ms.address, displayName: ms.name });
    const um = path.match(/^(me|users\/[^/]+)\/(.*)$/);
    if (!um) return json({ error: { code: 'NotFound', message: `fake graph: ${method} ${url.href}` } }, 404);
    const b = box(um[1]);
    if (!b) return json({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, 403);
    const rest = um[2];
    // folders
    if (rest === 'mailFolders' && method === 'GET') return json({ value: b.folders.filter((f) => !f.parent).map((f) => ({ id: f.id, displayName: f.displayName })) });
    m = rest.match(/^mailFolders\/([^/]+)$/);
    if (m && method === 'GET') {
      const id = b.wk[m[1]] ?? m[1];
      const f = b.folders.find((x) => x.id === id);
      if (m[1] === 'archive' && b.wk.archive === '') return json({ error: { code: 'ErrorFolderNotFound', message: 'x' } }, 404);
      return f ? json({ id: f.id, displayName: f.displayName }) : json({ error: { code: 'ErrorFolderNotFound', message: 'The specified folder could not be found in the store.' } }, 404);
    }
    m = rest.match(/^mailFolders\/([^/]+)\/childFolders$/);
    if (m) return json({ value: b.folders.filter((f) => f.parent === (b.wk[m![1]] ?? m![1])).map((f) => ({ id: f.id, displayName: f.displayName })) });
    // delta
    m = rest.match(/^mailFolders\/([^/]+)\/messages\/delta$/);
    if (m) {
      const folderId = b.wk[m[1]] ?? m[1];
      if (!b.folders.some((f) => f.id === folderId)) return json({ error: { code: 'ErrorFolderNotFound', message: 'x' } }, 404);
      b.deltaCalls.push({ folderId, url: url.href });
      const token = url.searchParams.get('$deltatoken');
      if (token && b.expireDelta) return json({ error: { code: 'syncStateNotFound', message: 'The sync state is not found' } }, 410);
      const since = token ? Number(token) : 0;
      const filter = /receivedDateTime ge (\S+)/.exec(url.searchParams.get('$filter') ?? '')?.[1];
      const size = Number(/odata\.maxpagesize=(\d+)/.exec(headers.prefer ?? '')?.[1] ?? 50);
      let items: any[] = [...b.messages.values()].filter((x) => x.parentFolderId === folderId && x.seq > since && (!filter || token || x.isDraft || x.receivedDateTime >= filter)).sort((a, c) => a.seq - c.seq).map(gOut);
      if (token) items = [...items, ...b.removed.filter((r) => r.folderId === folderId && r.seq > since).map((r) => ({ id: r.id, '@removed': { reason: 'deleted' } }))];
      const off = Number(url.searchParams.get('$skiptoken') ?? 0);
      const page = items.slice(off, off + size);
      const base = `https://graph.microsoft.com/v1.0/${um[1]}/mailFolders/${m[1]}/messages/delta`;
      if (off + size < items.length) return json({ value: page, '@odata.nextLink': `${base}?$skiptoken=${off + size}&$deltatoken=${token ?? ''}&$filter=${encodeURIComponent(url.searchParams.get('$filter') ?? '')}&$select=x` });
      return json({ value: page, '@odata.deltaLink': `${base}?$deltatoken=${b.seq}` });
    }
    if (rest === 'outlook/masterCategories') {
      if (method === 'POST') {
        b.categories.push(body.displayName);
        return json({ displayName: body.displayName, color: body.color }, 201);
      }
      return json({ value: b.categories.map((c) => ({ displayName: c })) });
    }
    if (rest.startsWith('messages') || rest === 'messages') {
      if (rest === 'messages' && method === 'GET') {
        const term = /^"(.*)"$/.exec(url.searchParams.get('$search') ?? '')?.[1]?.toLowerCase();
        const list = [...b.messages.values()].filter((x) => !term || `${x.subject} ${x.body.content}`.toLowerCase().includes(term)).slice(0, Number(url.searchParams.get('$top') ?? 25));
        return json({ value: list.map(gOut) });
      }
      if (rest === 'messages' && method === 'POST') {
        const d = mAdd(um[1] === 'me' ? 'me' : um[1], { draft: true, subject: body.subject, text: body.body?.content ?? '', to: body.toRecipients?.[0]?.emailAddress?.address });
        d.body = body.body ?? d.body;
        d.toRecipients = body.toRecipients ?? [];
        d.ccRecipients = body.ccRecipients ?? [];
        d.bccRecipients = body.bccRecipients ?? [];
        d.draftNoMessageId = true;
        d.internetMessageId = `<draft-${d.id}@outlook.example>`;
        return json(gOut(d), 201);
      }
      m = rest.match(/^messages\/([^/]+)$/);
      if (m) {
        const msg = b.messages.get(m[1]);
        if (!msg) return json({ error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } }, 404);
        if (method === 'GET') {
          const sel = (url.searchParams.get('$select') ?? '').split(',');
          const full = gOut(msg);
          return json(sel.length && !sel.includes('body') ? Object.fromEntries(Object.entries(full).filter(([k]) => sel.includes(k) || k === 'id')) : full);
        }
        if (method === 'PATCH') {
          Object.assign(msg, body);
          mTouch(b, msg);
          return json(gOut(msg));
        }
        if (method === 'DELETE') {
          mDelete(b, msg);
          return json(null, 204);
        }
      }
      m = rest.match(/^messages\/([^/]+)\/createReply$/);
      if (m && method === 'POST') {
        const orig = b.messages.get(m[1]);
        if (!orig) return json({ error: { code: 'ErrorItemNotFound', message: 'x' } }, 404);
        const d = mAdd(um[1] === 'me' ? 'me' : um[1], { draft: true, subject: `RE: ${orig.subject}`, text: `\n\nOriginal: ${orig.body.content}`, conversationId: orig.conversationId, to: orig.from?.emailAddress?.address });
        d.repliedTo = orig.id;
        d.toRecipients = orig.from ? [orig.from] : [];
        return json(gOut(d), 201);
      }
      m = rest.match(/^messages\/([^/]+)\/send$/);
      if (m && method === 'POST') {
        const d = b.messages.get(m[1]);
        if (!d) return json({ error: { code: 'ErrorItemNotFound', message: 'x' } }, 404);
        d.isDraft = false;
        d.isRead = true;
        d.from = mAddr(b.address);
        d.receivedDateTime = d.sentDateTime = new Date().toISOString();
        mMove(b, d, b.wk.sentitems);
        b.sent.push(JSON.parse(JSON.stringify({ ...gOut(d), attachments: d.attachments.map((a: any) => ({ name: a.name, size: a.size })), repliedTo: d.repliedTo })));
        return json(null, 202);
      }
      m = rest.match(/^messages\/([^/]+)\/move$/);
      if (m && method === 'POST') {
        const msg = b.messages.get(m[1]);
        if (!msg) return json({ error: { code: 'ErrorItemNotFound', message: 'x' } }, 404);
        mMove(b, msg, body.destinationId);
        return json(gOut(msg), 201);
      }
      m = rest.match(/^messages\/([^/]+)\/attachments$/);
      if (m) {
        const msg = b.messages.get(m[1]);
        if (!msg) return json({ error: { code: 'ErrorItemNotFound', message: 'x' } }, 404);
        if (method === 'POST') {
          const size = Buffer.from(body.contentBytes ?? '', 'base64').length;
          if (size > 3_000_000) ms.inlineAttachmentLimitHit++;
          msg.attachments.push({ id: `att${++n}`, name: body.name, contentType: body.contentType, data: body.contentBytes, isInline: false, size });
          msg.hasAttachments = true;
          return json({ id: msg.attachments.at(-1).id, name: body.name }, 201);
        }
        return json({ value: msg.attachments.map((a: any) => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.size, isInline: a.isInline })) });
      }
      m = rest.match(/^messages\/([^/]+)\/attachments\/createUploadSession$/);
      if (m && method === 'POST') {
        const path = `/session/${++n}`;
        ms.uploads.set(path, { messageId: m[1], name: body.AttachmentItem.name, chunks: [] });
        return json({ uploadUrl: `https://upload.example.test${path}`, expirationDateTime: new Date(Date.now() + 3600_000).toISOString() });
      }
      m = rest.match(/^messages\/([^/]+)\/attachments\/([^/]+)$/);
      if (m) {
        const msg = b.messages.get(m[1]);
        const a = msg?.attachments.find((x: any) => x.id === m![2]);
        if (!a) return json({ error: { code: 'ErrorItemNotFound', message: 'x' } }, 404);
        if (method === 'DELETE') {
          msg.attachments = msg.attachments.filter((x: any) => x.id !== a.id);
          return json(null, 204);
        }
        return json({ id: a.id, name: a.name, contentType: a.contentType, size: a.size, contentBytes: a.data });
      }
    }
    return json({ error: { code: 'NotFound', message: `fake graph: ${method} ${url.href}` } }, 404);
  }

  // ================================ JWKS for Pub/Sub tokens ================================
  const jwks = { keys: [] as any[] };

  const realFetch = globalThis.fetch;
  async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    let body: any = {};
    const raw = init.body;
    if (typeof raw === 'string' && raw) {
      body = (headers['content-type'] ?? '').includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : (() => { try { return JSON.parse(raw); } catch { return {}; } })();
    }
    reqs.push({ url: url.href, method, headers, body, raw });
    if (url.host === 'oauth2.googleapis.com' || url.host === 'gmail.googleapis.com' || url.host === 'www.googleapis.com') return google(url, method, headers, body);
    if (url.host === 'login.microsoftonline.com' || url.host === 'graph.microsoft.com' || url.host === 'upload.example.test') return microsoft(url, method, headers, body, raw);
    return json({ error: `fake: unexpected host ${url.host}` }, 502);
  }

  /** Simulates the consent screen: the authorize URL → a code for the callback. */
  function authorize(url: string) {
    const u = new URL(url);
    const code = `code-${++n}`;
    const entry = { challenge: u.searchParams.get('code_challenge') ?? '', scope: u.searchParams.get('scope') ?? '', redirect: u.searchParams.get('redirect_uri') ?? '' };
    (u.host === 'accounts.google.com' ? g.codes : ms.codes).set(code, entry);
    return { code, state: u.searchParams.get('state') ?? '', redirect: entry.redirect, scope: entry.scope };
  }

  return {
    fetch: fakeFetch as typeof fetch,
    reqs,
    calls: (re: RegExp, method?: string) => reqs.filter((r) => re.test(r.url) && (!method || r.method === method)),
    authorize,
    g,
    ms,
    gmail: { add: gAdd, labels: gLabels, delete: gDelete, draft: gDraft, editDraft: gEditDraft },
    graph: { add: mAdd, move: mMove, remove: mDelete, touch: mTouch },
    jwks,
    resetReqs: () => reqs.splice(0),
  };
}

export type MailFake = ReturnType<typeof createMailFake>;
