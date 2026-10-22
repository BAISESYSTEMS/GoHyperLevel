import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { daysAgo, boot, box, connect, maps, msgs, settle, syncNow, type T } from './mailbox-helpers.js';
import type { MailFake } from './mailbox-fakes.js';
import { openSecret } from '../server/core/secrets.js';

/**
 * Native Outlook / Microsoft 365 mailbox with a fake Graph: connect (own and shared mailbox), first import with
 * the delta query per folder, incremental changes (moves are not deletions), flags/archive/categories both ways,
 * replies through createReply, big attachments through upload sessions, drafts, token refresh, change notifications.
 */

let t: T;
let fake: MailFake;
let locA = '';
let mb = '';
const me = () => fake.ms.boxes.me;
const conv = (email: string) => t.app.db.get(`SELECT v.* FROM conversations v JOIN contacts c ON c.id = v.contact_id WHERE v.location_id = ? AND c.email = ?`, locA, email);
const flush = () => t.app.services.mailbox.flush(mb);
const remote = (id: string) => me().messages.get(id);

beforeAll(async () => {
  ({ t, fake } = await boot());
  locA = t.api.location;
  const g = fake.graph;
  g.add('me', { id: 'o1', from: 'Anna Kunde <anna@kunde.example>', subject: 'Angebot Küche', text: 'Bitte ein Angebot.', conversationId: 'c-anna', attachments: [{ name: 'plan.pdf', data: Buffer.from('PLAN').toString('base64') }] });
  g.add('me', { id: 'o2', from: 'bernd@handwerk.example', subject: 'Rechnung', read: true, categories: ['Wichtig'] });
  g.add('me', { id: 'o3', folder: 'archive', from: 'carla@kunde.example', subject: 'Archivierte Anfrage', read: true });
  g.add('me', { id: 'o4', folder: 'sentitems', from: 'inhaber@firma.example', to: 'dora@kunde.example', subject: 'Unser Angebot', read: true });
  g.add('me', { id: 'o5', draft: true, to: 'emil@kunde.example', subject: 'Entwurf an Emil', text: 'Halbfertig' });
  g.add('me', { id: 'old', from: 'alt@kunde.example', subject: 'Uralt', date: daysAgo(120) });
  g.add('me', { id: 'k1', folder: 'AAkunden', from: 'fritz@kunde.example', subject: 'Im Unterordner' });
});
afterAll(async () => {
  await t.close();
});

describe('connecting an Outlook mailbox', () => {
  it('asks for Mail.ReadWrite + Mail.Send with offline access; reads the account from the ID token', async () => {
    const start = await t.api.post('/api/mailboxes/connect', { provider: 'microsoft', access: 'full', name: 'Büro' });
    const u = new URL(start.data.url);
    expect(u.href).toContain('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(u.searchParams.get('scope')).toBe('openid email offline_access Mail.ReadWrite Mail.Send');
    const f = fake.authorize(start.data.url);
    const back = await t.api.get(`/oauth/microsoft/callback?code=${f.code}&state=${encodeURIComponent(f.state)}`);
    expect(back.headers.get('location')).toMatch(/oauth=ok&provider=microsoft&mailbox=/);
    mb = new URLSearchParams(back.headers.get('location')!.split('?')[1]).get('mailbox')!;
    await settle(t, mb);
    const row = box(t, mb);
    expect(row).toMatchObject({ provider: 'microsoft', address: 'inhaber@firma.example', access: 'full', scope: 'location', shared_address: '' });
    const conn = t.app.db.get('SELECT * FROM oauth_connections WHERE id = ?', row.connection_id)!;
    expect(openSecret(t.app, conn.refresh_token)).toBe('ms-refresh-1');
  });

  it('uses the .Shared scopes for a shared mailbox and checks that the login can open it', async () => {
    const start = await t.api.post('/api/mailboxes/connect', { provider: 'microsoft', access: 'full', shared_address: 'Shared@Firma.example' });
    expect(new URL(start.data.url).searchParams.get('scope')).toBe('openid email offline_access Mail.ReadWrite.Shared Mail.Send.Shared');
    expect((await t.api.post('/api/mailboxes/connect', { provider: 'microsoft', shared_address: 'kein-mail' })).status).toBe(400);
    // No rights on that mailbox: nothing is connected.
    const bad = await connect(t, fake, { provider: 'microsoft', access: 'full', shared_address: 'fremd@firma.example' });
    expect(bad.query.get('oauth')).toBe('error');
    expect(bad.query.get('msg')).toMatch(/Kein Zugriff auf das gemeinsame Postfach fremd@firma.example/);
    expect(t.app.db.all('SELECT id FROM mailboxes')).toHaveLength(1);
  });

  it('refuses when the mail permission was not granted', async () => {
    fake.ms.grantScope = 'openid email offline_access https://graph.microsoft.com/User.Read';
    const r = await connect(t, fake, { provider: 'microsoft', access: 'readonly', name: 'x' });
    fake.ms.grantScope = undefined;
    expect(r.query.get('msg')).toMatch(/Berechtigungen für E-Mails erlauben \(lesen\)/);
    expect(t.app.db.all('SELECT id FROM mailboxes')).toHaveLength(1);
  });
});

describe('first import with delta queries', () => {
  it('imports inbox, archive, sent items and drafts of the window – not older mail and not sub-folders', () => {
    const subjects = msgs(t, 'location_id = ?', locA).map((m: any) => m.subject).sort();
    expect(subjects).toEqual(['Angebot Küche', 'Archivierte Anfrage', 'Entwurf an Emil', 'Rechnung', 'Unser Angebot']);
  });

  it('asks Graph for stable ids and plain text, filters by date, and one delta call per chosen folder', () => {
    const calls = me().deltaCalls.map((c) => c.folderId).sort();
    expect(calls).toEqual(['AAarchive', 'AAdrafts', 'AAinbox', 'AAsent']);
    const inbox = me().deltaCalls.find((c) => c.folderId === 'AAinbox')!;
    expect(new URL(inbox.url).searchParams.get('$filter')).toMatch(/^receivedDateTime ge \d{4}-\d\d-\d\dT[\d:]+Z$/);
    const drafts = me().deltaCalls.find((c) => c.folderId === 'AAdrafts')!;
    expect(new URL(drafts.url).searchParams.get('$filter')).toBeNull();
    const req = fake.calls(/mailFolders\/AAinbox\/messages\/delta/)[0];
    expect(req.headers.prefer).toContain('IdType="ImmutableId"');
    expect(req.headers.prefer).toContain('outlook.body-content-type="text"');
  });

  it('keeps folder, categories, flags, thread and attachments; drafts stay drafts', () => {
    const rows = maps(t, mb);
    const by = (id: string) => rows.find((r) => r.remote_id === id)!;
    expect(by('o1')).toMatchObject({ folder: 'inbox', unread: 1, thread_id: 'c-anna', internet_id: 'o1@outlook.example', folder_id: 'AAinbox' });
    expect(by('o1').attachments).toEqual([expect.objectContaining({ name: 'plan.pdf', type: 'application/pdf', size: 4 })]);
    expect(by('o2')).toMatchObject({ unread: 0, labels: ['Wichtig'] });
    expect(by('o3').folder).toBe('archive');
    expect(by('o4').folder).toBe('sent');
    expect(by('o5')).toMatchObject({ folder: 'drafts' });
    expect(msgs(t, 'subject = ?', 'Entwurf an Emil')[0]).toMatchObject({ status: 'draft', direction: 'out' });
    expect(msgs(t, 'subject = ?', 'Unser Angebot')[0]).toMatchObject({ status: 'sent', direction: 'out' });
    expect(conv('anna@kunde.example')).toMatchObject({ unread: 1 });
  });

  it('offers the folders and categories to choose from; choosing another folder reads it', async () => {
    const r = (await t.api.get(`/api/mailboxes/${mb}/folders`)).data;
    expect(r.folders.map((f: any) => [f.name, f.kind, f.system])).toEqual(
      expect.arrayContaining([['Posteingang', 'other', true].slice(0, 0).length ? [] : ['Posteingang', 'inbox', true], ['Entwürfe', 'drafts', true], ['Archiv', 'archive', true], ['Posteingang / Kunden', 'other', false]].filter((x) => x.length)),
    );
    expect(r.folders.map((f: any) => f.name)).not.toContain('Gelöschte Elemente');
    expect(r.labels.map((l: any) => l.name)).toEqual(['Wichtig', 'Angebot']);
    const patched = await t.api.patch(`/api/mailboxes/${mb}`, { folders: ['AAinbox', 'AAsent', 'AAdrafts', 'AAarchive', 'AAkunden'] });
    expect(patched.data.folders).toHaveLength(5);
    expect(box(t, mb).sync_due).toBe(1);
    await syncNow(t, mb);
    expect(msgs(t, 'subject = ?', 'Im Unterordner')).toHaveLength(1);
    // Known mail is recognised, not duplicated.
    expect(msgs(t, 'subject = ?', 'Angebot Küche')).toHaveLength(1);
  });
});

describe('incremental sync with delta links', () => {
  it('imports new mail and follows read, flag and category changes', async () => {
    fake.graph.add('me', { id: 'o6', from: 'Gabi <gabi@kunde.example>', subject: 'Neu per Delta', conversationId: 'c-gabi' });
    const o1 = remote('o1');
    o1.isRead = true;
    o1.flag = { flagStatus: 'flagged' };
    o1.categories = ['Angebot'];
    fake.graph.touch(me(), o1);
    const r = await syncNow(t, mb);
    expect(r.created).toBe(1);
    expect(msgs(t, 'subject = ?', 'Neu per Delta')).toHaveLength(1);
    expect(maps(t, mb).find((x) => x.remote_id === 'o1')).toMatchObject({ unread: 0, starred: 1, labels: ['Angebot'] });
    expect(conv('anna@kunde.example')).toMatchObject({ unread: 0, starred: 1 });
  });

  it('a move to another folder is not a deletion; a real deletion keeps the history; a deleted draft disappears', async () => {
    fake.graph.move(me(), remote('o6'), 'AAarchive');
    fake.graph.remove(me(), remote('o2'));
    fake.graph.remove(me(), remote('o5'));
    const r = await syncNow(t, mb);
    expect(r.deleted).toBe(2);
    expect(maps(t, mb).find((x) => x.remote_id === 'o6')).toMatchObject({ folder: 'archive', folder_id: 'AAarchive' });
    expect(maps(t, mb).find((x) => x.remote_id === 'o2')!.folder).toBe('deleted');
    expect(msgs(t, 'subject = ?', 'Rechnung')).toHaveLength(1);
    expect(msgs(t, 'subject = ?', 'Neu per Delta')).toHaveLength(1);
    expect(msgs(t, 'subject = ?', 'Entwurf an Emil')).toHaveLength(0);
  });

  it('starts that folder over when the delta window expired (410), without duplicates', async () => {
    const before = msgs(t, 'location_id = ?', locA).length;
    fake.graph.add('me', { id: 'o7', from: 'Hans <hans@kunde.example>', subject: 'Nach 410' });
    me().expireDelta = true;
    const r = await syncNow(t, mb).finally(() => (me().expireDelta = false));
    expect(msgs(t, 'subject = ?', 'Nach 410')).toHaveLength(1);
    expect(msgs(t, 'location_id = ?', locA)).toHaveLength(before + 1);
    expect(r.more).toBe(false);
  });
});

describe('flags, archive and categories in both directions', () => {
  it('read, unread and star reach Outlook', async () => {
    const hans = conv('hans@kunde.example')!;
    await t.api.get(`/api/conversations/${hans.id}/messages`);
    await flush();
    expect(remote('o7').isRead).toBe(true);
    await t.api.patch(`/api/conversations/${hans.id}`, { unread: true });
    await t.api.patch(`/api/conversations/${hans.id}`, { starred: true });
    await flush();
    expect(remote('o7')).toMatchObject({ isRead: false, flag: { flagStatus: 'flagged' } });
    await t.api.patch(`/api/conversations/${hans.id}`, { starred: false });
    await flush();
    expect(remote('o7').flag.flagStatus).toBe('notFlagged');
  });

  it('archive moves the message into the Archive folder (same id) and back into the inbox', async () => {
    const hans = conv('hans@kunde.example')!;
    const r = await t.api.post(`/api/mail/conversations/${hans.id}/archive`, { archive: true });
    expect(r.data).toMatchObject({ ok: true, changed: 1, pending: 0 });
    expect(remote('o7').parentFolderId).toBe('AAarchive');
    expect(maps(t, mb).find((x) => x.remote_id === 'o7')!.folder).toBe('archive');
    // The next sync sees the message in the archive folder (not as deleted from the inbox).
    await syncNow(t, mb);
    expect(maps(t, mb).find((x) => x.remote_id === 'o7')).toMatchObject({ folder: 'archive', folder_id: 'AAarchive' });
    expect(msgs(t, 'subject = ?', 'Nach 410')).toHaveLength(1);
    await t.api.post(`/api/mail/conversations/${hans.id}/archive`, { archive: false });
    expect(remote('o7').parentFolderId).toBe('AAinbox');
  });

  it('categories are the labels', async () => {
    const hans = conv('hans@kunde.example')!;
    await t.api.post(`/api/mail/conversations/${hans.id}/labels`, { add: ['Wichtig', 'Angebot'] });
    expect(remote('o7').categories.sort()).toEqual(['Angebot', 'Wichtig']);
    await t.api.post(`/api/mail/conversations/${hans.id}/labels`, { remove: ['Angebot'] });
    expect(remote('o7').categories).toEqual(['Wichtig']);
    const made = await t.api.post(`/api/mail/mailboxes/${mb}/labels`, { name: 'Neu' });
    expect(made.data).toMatchObject({ id: 'Neu', name: 'Neu' });
    expect(me().categories).toContain('Neu');
  });

  it('keeps a change queued while Outlook is busy (429 with Retry-After) and delivers it later', async () => {
    const hans = conv('hans@kunde.example')!;
    fake.ms.failures.push({ match: /PATCH me\/messages\/o7$/, status: 429, times: 1 });
    const r = await t.api.post(`/api/mail/conversations/${hans.id}/labels`, { add: ['Angebot'] });
    expect(r.data.pending).toBe(1);
    const row = t.app.db.get('SELECT * FROM mailbox_outbox')!;
    expect(row.attempts).toBe(1);
    expect(Date.parse(row.next_attempt_at)).toBeGreaterThan(Date.now());
    t.app.db.run('UPDATE mailbox_outbox SET next_attempt_at = NULL');
    await flush();
    expect(remote('o7').categories).toContain('Angebot');
    expect(t.app.db.all('SELECT * FROM mailbox_outbox')).toHaveLength(0);
  });
});

describe('sending through Outlook', () => {
  it('answers with createReply so Outlook keeps the conversation; the sent copy is not imported twice', async () => {
    const anna = conv('anna@kunde.example')!;
    await t.api.patch(`/api/mailboxes/${mb}`, { signature: 'Paul Muster' });
    const r = await t.api.post(`/api/mail/conversations/${anna.id}/reply`, { body: 'Gerne, anbei das Angebot.', attachments: [{ filename: 'angebot.pdf', content_base64: Buffer.from('ANGEBOT').toString('base64'), content_type: 'application/pdf' }] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ status: 'sent', thread_id: 'c-anna' });
    expect(fake.calls(/messages\/o1\/createReply/, 'POST')).toHaveLength(1);
    const sent = me().sent.at(-1);
    expect(sent).toMatchObject({ repliedTo: 'o1', subject: 'Re: Angebot Küche' });
    expect(sent.body.content).toContain('Gerne, anbei das Angebot.');
    expect(sent.body.content).toContain('Paul Muster');
    expect(sent.attachments).toEqual([{ name: 'angebot.pdf', size: 7 }]);
    expect(sent.toRecipients[0].emailAddress.address).toBe('anna@kunde.example');
    const mine = msgs(t, 'conversation_id = ? AND direction = ?', anna.id, 'out');
    expect(mine).toHaveLength(1);
    expect(maps(t, mb).find((x) => x.message_id === mine[0].id)).toMatchObject({ folder: 'sent', thread_id: 'c-anna' });
    const before = msgs(t, 'location_id = ?', locA).length;
    await syncNow(t, mb);
    expect(msgs(t, 'location_id = ?', locA)).toHaveLength(before);
    expect(maps(t, mb).filter((x) => x.message_id === mine[0].id)).toHaveLength(1);
    expect(maps(t, mb).find((x) => x.message_id === mine[0].id)!.folder).toBe('sent');
  });

  it('puts big attachments through an upload session without the bearer token', async () => {
    const big = Buffer.alloc(3_600_000, 1).toString('base64');
    const r = await t.api.post('/api/mail/send', { mailbox_id: mb, to: 'gross@kunde.example', subject: 'Groß', body: 'Anbei', signature: false, attachments: [{ filename: 'gross.bin', content_base64: big }, { filename: 'klein.txt', content_base64: Buffer.from('k').toString('base64') }] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(fake.ms.uploads.size).toBe(1);
    const up = [...fake.ms.uploads.values()][0];
    expect(up.chunks.map((c) => c.range)).toEqual(['bytes 0-3499999/3600000', 'bytes 3500000-3599999/3600000']);
    expect(fake.ms.unauthorizedUploads).toBe(0);
    expect(fake.ms.inlineAttachmentLimitHit).toBe(0);
    expect(me().sent.at(-1).attachments.map((a: any) => a.name).sort()).toEqual(['gross.bin', 'klein.txt']);
  });

  it('sends as the shared mailbox through /users/{address}', async () => {
    const c = await connect(t, fake, { provider: 'microsoft', access: 'full', shared_address: 'shared@firma.example', name: 'Team' });
    expect(c.query.get('oauth')).toBe('ok');
    await settle(t, c.id);
    expect(box(t, c.id)).toMatchObject({ address: 'shared@firma.example', shared_address: 'shared@firma.example', name: 'Team' });
    // The login that opens it is the person's own account.
    expect(t.app.db.get('SELECT account_email FROM oauth_connections WHERE id = ?', box(t, c.id).connection_id)!.account_email).toBe('inhaber@firma.example');
    fake.graph.add('shared@firma.example', { id: 's1', from: 'Sven <sven@kunde.example>', subject: 'An das Team' });
    await syncNow(t, c.id);
    expect(msgs(t, 'subject = ?', 'An das Team')).toHaveLength(1);
    const r = await t.api.post('/api/mail/send', { mailbox_id: c.id, to: 'sven@kunde.example', subject: 'Antwort vom Team', body: 'Hallo Sven' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(fake.ms.boxes['shared@firma.example'].sent).toHaveLength(1);
    expect(fake.calls(/graph\.microsoft\.com\/v1\.0\/users\/shared%40firma\.example\/messages$/, 'POST').length).toBeGreaterThan(0);
    expect(me().sent.some((m: any) => m.subject === 'Antwort vom Team')).toBe(false);
    await t.api.del(`/api/mailboxes/${c.id}`);
  });

  it('keeps the recipient and subject of header-injection attempts harmless', async () => {
    const r = await t.api.post('/api/mail/send', { mailbox_id: mb, to: ['x@kunde.example'], subject: 'A\r\nBcc: boese@evil.example', body: 'x', signature: false });
    expect(r.status).toBe(200);
    const sent = me().sent.at(-1);
    expect(sent.subject).toBe('A Bcc: boese@evil.example');
    expect(sent.bccRecipients).toEqual([]);
  });
});

describe('drafts', () => {
  let id = '';
  const draft = () => maps(t, mb).find((x) => x.message_id === id)!;

  it('creates, changes and sends a draft that lives in Outlook', async () => {
    const r = await t.api.post('/api/mail/drafts', { mailbox_id: mb, to: 'gerd@kunde.example', subject: 'Entwurf eins', body: 'Version 1', signature: false });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    id = r.data.message_id;
    expect(remote(draft().remote_id)).toMatchObject({ isDraft: true, subject: 'Entwurf eins' });
    const u = await t.api.put(`/api/mail/drafts/${id}`, { to: 'gerd@kunde.example', subject: 'Entwurf zwei', body: 'Version 2', signature: false });
    expect(u.status, JSON.stringify(u.data)).toBe(200);
    expect(remote(draft().remote_id).subject).toBe('Entwurf zwei');
    expect(msgs(t, 'id = ?', id)).toMatchObject([{ status: 'draft', subject: 'Entwurf zwei' }]);
    const s = await t.api.post(`/api/mail/drafts/${id}/send`, {});
    expect(s.data).toMatchObject({ status: 'sent', message_id: id });
    expect(remote(draft().remote_id)).toMatchObject({ isDraft: false, parentFolderId: 'AAsent' });
    expect(msgs(t, 'id = ?', id)[0].status).toBe('sent');
    const before = msgs(t, 'location_id = ?', locA).length;
    await syncNow(t, mb);
    expect(msgs(t, 'location_id = ?', locA)).toHaveLength(before);
    expect(draft()).toMatchObject({ folder: 'sent' });
  });

  it('follows edits, sending and deleting in Outlook itself', async () => {
    fake.graph.add('me', { id: 'd1', draft: true, to: 'hella@kunde.example', subject: 'Aus Outlook', text: 'v1' });
    await syncNow(t, mb);
    const m = msgs(t, 'subject = ?', 'Aus Outlook');
    expect(m).toMatchObject([{ status: 'draft' }]);
    remote('d1').subject = 'Aus Outlook (bearbeitet)';
    remote('d1').body.content = 'v2';
    fake.graph.touch(me(), remote('d1'));
    await syncNow(t, mb);
    expect(msgs(t, 'id = ?', m[0].id)).toMatchObject([{ subject: 'Aus Outlook (bearbeitet)', body: expect.stringContaining('v2') }]);
    // Sent in Outlook: same id moves to Sent Items.
    remote('d1').isDraft = false;
    fake.graph.move(me(), remote('d1'), 'AAsent');
    await syncNow(t, mb);
    expect(msgs(t, 'id = ?', m[0].id)).toMatchObject([{ status: 'sent' }]);
    expect(maps(t, mb).find((x) => x.remote_id === 'd1')).toMatchObject({ folder: 'sent' });
    // Another draft deleted in Outlook.
    fake.graph.add('me', { id: 'd2', draft: true, to: 'ina@kunde.example', subject: 'Wird gelöscht' });
    await syncNow(t, mb);
    expect(msgs(t, 'subject = ?', 'Wird gelöscht')).toHaveLength(1);
    fake.graph.remove(me(), remote('d2'));
    await syncNow(t, mb);
    expect(msgs(t, 'subject = ?', 'Wird gelöscht')).toHaveLength(0);
  });

  it('deletes a draft in Outlook when it is discarded here', async () => {
    const r = await t.api.post('/api/mail/drafts', { mailbox_id: mb, to: 'jule@kunde.example', subject: 'Verwerfen', body: 'x' });
    const rid = maps(t, mb).find((x) => x.message_id === r.data.message_id)!.remote_id;
    expect(remote(rid)).toBeTruthy();
    expect((await t.api.del(`/api/mail/drafts/${r.data.message_id}`)).data).toEqual({ ok: true });
    expect(remote(rid)).toBeUndefined();
    expect(msgs(t, 'id = ?', r.data.message_id)).toHaveLength(0);
  });
});

describe('tokens', () => {
  it('refreshes by itself; a revoked grant turns the mailbox into "neu verbinden" and reconnecting fixes it', async () => {
    t.app.db.run(`UPDATE oauth_connections SET expires_at = ? WHERE id = (SELECT connection_id FROM mailboxes WHERE id = ?)`, new Date(Date.now() - 1000).toISOString(), mb);
    const n = fake.ms.refreshCount;
    await syncNow(t, mb);
    expect(fake.ms.refreshCount).toBe(n + 1);
    // The refresh request carries no scope list that could exceed what was granted.
    const refresh = fake.calls(/oauth2\/v2\.0\/token/, 'POST').filter((r) => r.body.grant_type === 'refresh_token').at(-1)!;
    expect(refresh.body.scope).toBeUndefined();
    // The user revokes access in their Microsoft account.
    fake.ms.failRefresh = true;
    t.app.db.run(`UPDATE oauth_connections SET expires_at = ? WHERE id = (SELECT connection_id FROM mailboxes WHERE id = ?)`, new Date(Date.now() - 1000).toISOString(), mb);
    await expect(syncNow(t, mb)).rejects.toThrow();
    const list = (await t.api.get('/api/mailboxes')).data.mailboxes.find((m: any) => m.id === mb);
    expect(list).toMatchObject({ status: 'reconnect', needs_reconnect: true });
    expect(list.last_error).toMatch(/neu verbinden/);
    // The background pass leaves it alone.
    const calls = fake.reqs.length;
    t.app.db.run('UPDATE mailboxes SET next_sync_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), mb);
    await t.app.tick();
    expect(fake.reqs.length).toBe(calls);
    fake.ms.failRefresh = false;
    const again = await connect(t, fake, { provider: 'microsoft', access: 'full', mailbox_id: mb });
    expect(again.query.get('oauth')).toBe('ok');
    expect(again.id).toBe(mb);
    await settle(t, mb);
    expect((await t.api.get('/api/mailboxes')).data.mailboxes.find((m: any) => m.id === mb)).toMatchObject({ status: 'ok', needs_reconnect: false });
  });
});
