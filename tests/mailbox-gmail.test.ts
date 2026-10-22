import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { daysAgo, boot, box, connect, maps, msgs, settle, syncNow, type T } from './mailbox-helpers.js';
import type { MailFake } from './mailbox-fakes.js';
import { openSecret } from '../server/core/secrets.js';

/**
 * Native Gmail mailbox with a fake Gmail API: OAuth connect, first import (window, labels, flags, drafts,
 * promotions, routing, contacts), incremental sync through history, token refresh.
 */

let t: T;
let fake: MailFake;
let locA = '';
let mb = '';

beforeAll(async () => {
  ({ t, fake } = await boot());
  locA = t.api.location;
  // Mail that is there before the connection: inbox, read + starred, with attachment, old, sent, draft, promotion, spam.
  const g = fake.gmail;
  g.add({ id: 'in1', from: 'Anna Kunde <anna@kunde.example>', subject: 'Angebot Küche', text: 'Bitte schicken Sie ein Angebot.', labels: ['INBOX', 'UNREAD'], threadId: 'th-anna' });
  g.add({ id: 'in2', from: 'bernd@handwerk.example', subject: 'Rechnung', text: 'Anbei die Rechnung.', labels: ['INBOX', 'STARRED', 'Label_1'], attachments: [{ name: 'rechnung.pdf', data: Buffer.from('PDFDATA').toString('base64') }] });
  g.add({ id: 'old1', from: 'alt@kunde.example', subject: 'Uralt', date: daysAgo(120), labels: ['INBOX'] });
  g.add({ id: 'sent1', from: 'inhaber@gmail.example', to: 'Cora <cora@kunde.example>', subject: 'Unser Angebot', text: 'Hier unser Angebot.', labels: ['SENT'], threadId: 'th-cora' });
  g.draft({ to: 'dora@kunde.example', subject: 'Entwurf an Dora', text: 'Noch nicht fertig' });
  g.add({ id: 'promo1', from: 'news@shop.example', subject: 'Rabatt!', labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'] });
  g.add({ id: 'spam1', from: 'spam@evil.example', subject: 'Gewinn', labels: ['SPAM', 'UNREAD'] });
  g.add({ id: 'charset1', from: 'umlaut@kunde.example', subject: 'Grüße', text: 'Schöne Grüße aus Köln', labels: ['INBOX'], charset: 'ISO-8859-1' });
});
afterAll(async () => {
  await t.close();
});

const conv = (email: string) => t.app.db.get(`SELECT v.* FROM conversations v JOIN contacts c ON c.id = v.contact_id WHERE v.location_id = ? AND c.email = ?`, locA, email);

describe('connecting a Gmail mailbox', () => {
  it('asks for modify + send, offline access and PKCE; the shared callback hands "mail" to the mailbox module', async () => {
    const start = await t.api.post('/api/mailboxes/connect', { provider: 'google', scope: 'location', access: 'full', name: 'Info' });
    expect(start.status).toBe(200);
    const u = new URL(start.data.url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ access_type: 'offline', prompt: 'consent', code_challenge_method: 'S256', redirect_uri: 'http://localhost/oauth/google/callback' });
    // The consent screen sends the browser back to the callback.
    const f = fake.authorize(start.data.url);
    const back = await t.api.get(`/oauth/google/callback?code=${f.code}&state=${encodeURIComponent(f.state)}`);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toMatch(/^\/app\/settings\/messaging\?oauth=ok&provider=google&mailbox=/);
    mb = new URLSearchParams(back.headers.get('location')!.split('?')[1]).get('mailbox')!;
    await settle(t, mb);
    // The same callback twice is refused (the pending flow is consumed).
    const again = await t.api.get(`/oauth/google/callback?code=${f.code}&state=${encodeURIComponent(f.state)}`);
    expect(again.headers.get('location')).toMatch(/oauth=error/);
  });

  it('stores the tokens sealed and never shows them', async () => {
    const row = t.app.db.get('SELECT c.* FROM oauth_connections c JOIN mailboxes m ON m.connection_id = c.id WHERE m.id = ?', mb)!;
    expect(row.purpose).toBe('mail');
    expect(row.access_token).toMatch(/^v[12]:/);
    expect(openSecret(t.app, row.refresh_token)).toBe('g-refresh-1');
    expect(row.scopes).toContain('gmail.modify');
    const list = await t.api.get('/api/mailboxes');
    const text = JSON.stringify(list.data);
    expect(text).not.toContain('g-refresh-1');
    expect(text).not.toContain('g-access');
    expect(text).not.toMatch(/v[12]:[A-Za-z0-9+/=]{10}/);
    expect(list.data.mailboxes).toHaveLength(1);
    expect(list.data.mailboxes[0]).toMatchObject({ name: 'Info', address: 'inhaber@gmail.example', provider: 'google', scope: 'location', access: 'full', can_send: true, can_modify: true, can_manage: true, status: 'ok' });
    expect(list.data.providers).toEqual({ google: true, microsoft: true });
  });

  it('rejects a forged state and offers read-only and send-only access levels', async () => {
    const forged = await t.api.get(`/oauth/google/callback?code=x&state=${encodeURIComponent('abc.def')}`);
    expect(forged.status).toBe(400);
    const ro = new URL((await t.api.post('/api/mailboxes/connect', { provider: 'google', access: 'readonly' })).data.url);
    expect(ro.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/gmail.readonly');
    const send = new URL((await t.api.post('/api/mailboxes/connect', { provider: 'google', access: 'send' })).data.url);
    expect(send.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/gmail.send');
    expect((await t.api.post('/api/mailboxes/connect', { provider: 'google', access: 'everything' })).status).toBe(400);
    expect((await t.api.post('/api/mailboxes/connect', { provider: 'google', shared_address: 'shared@firma.example' })).status).toBe(400);
  });

  it('refuses a connection whose permissions were unticked and revokes the grant', async () => {
    fake.g.grantScope = 'openid https://www.googleapis.com/auth/userinfo.email';
    const start = await t.api.post('/api/mailboxes/connect', { provider: 'google', access: 'full', name: 'Zu wenig' });
    const f = fake.authorize(start.data.url);
    const back = await t.api.get(`/oauth/google/callback?code=${f.code}&state=${encodeURIComponent(f.state)}`);
    fake.g.grantScope = undefined;
    expect(back.headers.get('location')).toMatch(/oauth=error&msg=Bitte\+beim\+Verbinden\+alle\+Berechtigungen/);
    expect(fake.g.revoked).toContain('g-refresh-1');
    expect(t.app.db.all('SELECT id FROM mailboxes')).toHaveLength(1);
  });

  it('connecting the same account again keeps the mailbox and its settings (new tokens only)', async () => {
    await t.api.patch(`/api/mailboxes/${mb}`, { signature: 'Paul Muster\nMuster GmbH' });
    const before = t.app.db.get('SELECT connection_id FROM mailboxes WHERE id = ?', mb)!.connection_id;
    const again = await connect(t, fake, { provider: 'google', access: 'full', name: 'egal' });
    expect(again.query.get('oauth')).toBe('ok');
    expect(again.id).toBe(mb);
    expect(t.app.db.all('SELECT id FROM mailboxes')).toHaveLength(1);
    expect(t.app.db.get('SELECT connection_id, signature FROM mailboxes WHERE id = ?', mb)).toMatchObject({ connection_id: before, signature: 'Paul Muster\nMuster GmbH' });
    await settle(t, mb);
  });
});

describe('first import', () => {
  it('reads the inbox, sent mail and drafts inside the window and skips spam, promotions and old mail', async () => {
    const m = msgs(t, 'location_id = ?', locA);
    const subjects = m.map((x: any) => x.subject).sort();
    expect(subjects).toEqual(['Angebot Küche', 'Entwurf an Dora', 'Grüße', 'Rechnung', 'Unser Angebot']);
    // The window (90 days) excludes the old mail, spam and promotions never come in.
    expect(m.some((x: any) => x.subject === 'Uralt' || x.subject === 'Gewinn' || x.subject === 'Rabatt!')).toBe(false);
  });

  it('matches contacts by e-mail, files mail per direction and keeps drafts as drafts', () => {
    const anna = t.app.db.get('SELECT * FROM contacts WHERE location_id = ? AND email = ?', locA, 'anna@kunde.example')!;
    expect(anna).toMatchObject({ first_name: 'Anna', last_name: 'Kunde', source: 'Postfach Info' });
    expect(msgs(t, 'contact_id = ?', anna.id)).toMatchObject([{ direction: 'in', status: 'received', channel: 'email', body: 'Bitte schicken Sie ein Angebot.' }]);
    const cora = t.app.db.get('SELECT * FROM contacts WHERE location_id = ? AND email = ?', locA, 'cora@kunde.example')!;
    expect(msgs(t, 'contact_id = ?', cora.id)).toMatchObject([{ direction: 'out', status: 'sent', subject: 'Unser Angebot' }]);
    const dora = t.app.db.get('SELECT * FROM contacts WHERE location_id = ? AND email = ?', locA, 'dora@kunde.example')!;
    expect(msgs(t, 'contact_id = ?', dora.id)).toMatchObject([{ direction: 'out', status: 'draft', subject: 'Entwurf an Dora' }]);
  });

  it('decodes other charsets', () => {
    expect(msgs(t, 'subject = ?', 'Grüße')[0].body).toBe('Schöne Grüße aus Köln');
  });

  it('keeps thread, folder, labels, flags and attachments of every message', () => {
    const rows = maps(t, mb);
    const by = (rid: string) => rows.find((r) => r.remote_id === rid)!;
    expect(by('in1')).toMatchObject({ thread_id: 'th-anna', folder: 'inbox', unread: 1, starred: 0, internet_id: 'in1@mail.example' });
    expect(by('in2')).toMatchObject({ folder: 'inbox', unread: 0, starred: 1, labels: ['Label_1'] });
    expect(by('in2').attachments).toEqual([expect.objectContaining({ name: 'rechnung.pdf', type: 'application/pdf', size: 7 })]);
    expect(by('sent1').folder).toBe('sent');
    expect(rows.filter((r) => r.folder === 'drafts')).toHaveLength(1);
    expect(rows.find((r) => r.folder === 'drafts')!.draft_id).toMatch(/^dr/);
    expect(rows.some((r) => ['promo1', 'spam1', 'old1'].includes(r.remote_id))).toBe(false);
  });

  it('counts unread mail and the star on the conversation', () => {
    expect(conv('anna@kunde.example')).toMatchObject({ unread: 1, starred: 0 });
    expect(conv('bernd@handwerk.example')).toMatchObject({ unread: 0, starred: 1 });
  });

  it('is idempotent: reading again changes nothing', async () => {
    const before = msgs(t, 'location_id = ?', locA).length;
    const r = await syncNow(t, mb, { full: true });
    expect(r.created).toBe(0);
    expect(msgs(t, 'location_id = ?', locA)).toHaveLength(before);
  });

  it('lists the conversations of a mailbox and its folder (folder badges)', async () => {
    const all = (await t.api.get(`/api/conversations?mailbox=${mb}&folder=inbox`)).data;
    expect(all.map((c: any) => c.email).sort()).toEqual(['anna@kunde.example', 'bernd@handwerk.example', 'umlaut@kunde.example']);
    expect(all.find((c: any) => c.email === 'bernd@handwerk.example').mail).toMatchObject({ folder: 'inbox', labels: ['Label_1'], mailboxes: [{ id: mb, name: 'Info' }] });
    expect((await t.api.get(`/api/conversations?mailbox=${mb}&folder=sent`)).data.map((c: any) => c.email)).toEqual(['cora@kunde.example']);
    expect((await t.api.get(`/api/conversations?mailbox=${mb}&folder=drafts`)).data.map((c: any) => c.email)).toEqual(['dora@kunde.example']);
    expect((await t.api.get(`/api/conversations?mailbox=${mb}&label=Label_1`)).data.map((c: any) => c.email)).toEqual(['bernd@handwerk.example']);
    expect((await t.api.get('/api/conversations?mailbox=nonexistent')).data).toEqual([]);
    expect((await t.api.get('/api/conversations?mailbox=any')).data.length).toBe(5);
  });

  it('shows attachments on the messages and downloads them as a plain download', async () => {
    const bernd = conv('bernd@handwerk.example')!;
    const thread = (await t.api.get(`/api/conversations/${bernd.id}/messages`)).data;
    const mail = thread.messages[0].mail;
    expect(mail).toMatchObject({ folder: 'inbox', starred: true, labels: ['Label_1'], attachments: [{ name: 'rechnung.pdf', size: 7 }] });
    const res = await t.api.raw(mail.attachments[0].url, { headers: { cookie: t.api.cookie, 'x-location-id': locA } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="rechnung.pdf"');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PDFDATA');
  });
});

describe('incremental sync through history', () => {
  it('imports new mail and starts no workflow for the first import but does for new mail', async () => {
    const events: any[] = [];
    t.app.events.on('message.inbound', (e) => void events.push(e));
    fake.gmail.add({ id: 'in3', from: 'Eva <eva@kunde.example>', subject: 'Neue Anfrage', text: 'Hallo!', threadId: 'th-eva' });
    const r = await syncNow(t, mb);
    expect(r).toMatchObject({ created: 1, more: false });
    expect(msgs(t, 'subject = ?', 'Neue Anfrage')).toHaveLength(1);
    await t.app.events.flush();
    expect(events.map((e) => e.data.message.subject)).toEqual(['Neue Anfrage']);
    expect(conv('eva@kunde.example')!.unread).toBe(1);
  });

  it('follows label changes: read, star, archive – and keeps the unread counter right', async () => {
    fake.gmail.labels('in1', [], ['UNREAD']);
    fake.gmail.labels('in2', [], ['STARRED']);
    fake.gmail.labels('in3', [], ['INBOX']);
    fake.gmail.labels('in3', ['Label_2'], []);
    const r = await syncNow(t, mb);
    expect(r.updated).toBeGreaterThanOrEqual(3);
    const rows = maps(t, mb);
    expect(rows.find((x) => x.remote_id === 'in1')).toMatchObject({ unread: 0 });
    expect(rows.find((x) => x.remote_id === 'in2')).toMatchObject({ starred: 0 });
    expect(rows.find((x) => x.remote_id === 'in3')).toMatchObject({ folder: 'archive', labels: ['Label_2'] });
    expect(conv('anna@kunde.example')!.unread).toBe(0);
    expect(conv('bernd@handwerk.example')!.starred).toBe(0);
    // Marking unread again at Gmail raises it again.
    fake.gmail.labels('in1', ['UNREAD'], []);
    await syncNow(t, mb);
    expect(conv('anna@kunde.example')!.unread).toBe(1);
  });

  it('keeps a mail that is deleted or trashed over there (history stays), but removes deleted drafts', async () => {
    fake.gmail.labels('in2', ['TRASH'], ['INBOX']);
    fake.gmail.delete('in3');
    const draft = [...fake.g.drafts][0];
    fake.gmail.delete(draft[1]);
    fake.g.drafts.delete(draft[0]);
    const r = await syncNow(t, mb);
    expect(r.deleted).toBeGreaterThanOrEqual(2);
    const rows = maps(t, mb);
    expect(rows.find((x) => x.remote_id === 'in2')!.folder).toBe('trash');
    expect(rows.find((x) => x.remote_id === 'in3')!.folder).toBe('deleted');
    expect(msgs(t, 'subject = ?', 'Rechnung')).toHaveLength(1);
    expect(msgs(t, 'subject = ?', 'Neue Anfrage')).toHaveLength(1);
    expect(msgs(t, 'subject = ?', 'Entwurf an Dora')).toHaveLength(0);
  });

  it('starts over when the history id is too old, without duplicating anything', async () => {
    const before = msgs(t, 'location_id = ?', locA).length;
    fake.gmail.add({ id: 'in4', from: 'frank@kunde.example', subject: 'Nach dem Reset', threadId: 'th-frank' });
    const calls = fake.calls(/history/).length;
    // A cursor from before Gmail's oldest kept history id: users.history.list answers 404.
    t.app.db.run('UPDATE mailboxes SET state = ? WHERE id = ?', JSON.stringify({ ...box(t, mb).state, history_id: '1' }), mb);
    fake.g.oldestHistory = 100000;
    const r = await syncNow(t, mb);
    fake.g.oldestHistory = 0;
    expect(fake.calls(/history/).length).toBeGreaterThan(calls);
    expect(msgs(t, 'subject = ?', 'Nach dem Reset')).toHaveLength(1);
    expect(msgs(t, 'location_id = ?', locA)).toHaveLength(before + 1);
    expect(r.more).toBe(false);
    expect(box(t, mb).state.history_id).toBeTruthy();
  });
});

describe('access tokens', () => {
  it('refreshes an expired access token once, even for parallel calls', async () => {
    t.app.db.run(`UPDATE oauth_connections SET expires_at = ? WHERE id = (SELECT connection_id FROM mailboxes WHERE id = ?)`, new Date(Date.now() - 1000).toISOString(), mb);
    const before = fake.g.refreshCount;
    await Promise.all([syncNow(t, mb), t.app.services.mailbox.flush(mb)]);
    expect(fake.g.refreshCount).toBe(before + 1);
  });

  it('retries once with a fresh token when Gmail answers 401', async () => {
    const before = fake.g.refreshCount;
    fake.g.access = 'g-access-rotated-elsewhere';
    await syncNow(t, mb);
    expect(fake.g.refreshCount).toBe(before + 1);
    expect(box(t, mb).status).toBe('ok');
  });
});

describe('flags, archive and labels in both directions', () => {
  const flush = () => t.app.services.mailbox.flush(mb);
  const labelsOf = (id: string) => fake.g.messages.get(id).labels as string[];

  it('opening a conversation marks its mail as read at Gmail', async () => {
    const anna = conv('anna@kunde.example')!;
    expect(labelsOf('in1')).toContain('UNREAD');
    await t.api.get(`/api/conversations/${anna.id}/messages`);
    await flush();
    expect(labelsOf('in1')).not.toContain('UNREAD');
    expect(maps(t, mb).find((r) => r.remote_id === 'in1')!.unread).toBe(0);
  });

  it('"Ungelesen" and the star on a conversation reach the newest received mail', async () => {
    const anna = conv('anna@kunde.example')!;
    await t.api.patch(`/api/conversations/${anna.id}`, { unread: true });
    await flush();
    expect(labelsOf('in1')).toContain('UNREAD');
    await t.api.patch(`/api/conversations/${anna.id}`, { starred: true });
    await flush();
    expect(labelsOf('in1')).toContain('STARRED');
    await t.api.patch(`/api/conversations/${anna.id}`, { starred: false });
    await flush();
    expect(labelsOf('in1')).not.toContain('STARRED');
    // Our own copy follows right away.
    expect(maps(t, mb).find((r) => r.remote_id === 'in1')).toMatchObject({ unread: 1, starred: 0 });
    // The next sync sees the labels we just wrote and changes nothing.
    await syncNow(t, mb);
    expect(conv('anna@kunde.example')).toMatchObject({ unread: 1, starred: 0 });
  });

  it('archives and brings back', async () => {
    const anna = conv('anna@kunde.example')!;
    const r = await t.api.post(`/api/mail/conversations/${anna.id}/archive`, { archive: true });
    expect(r.data).toMatchObject({ ok: true, archived: true, changed: 1, pending: 0 });
    expect(labelsOf('in1')).not.toContain('INBOX');
    expect(maps(t, mb).find((x) => x.remote_id === 'in1')!.folder).toBe('archive');
    expect((await t.api.get(`/api/conversations?mailbox=${mb}&folder=archive`)).data.map((c: any) => c.email)).toContain('anna@kunde.example');
    expect((await t.api.get(`/api/conversations?mailbox=${mb}&folder=inbox`)).data.map((c: any) => c.email)).not.toContain('anna@kunde.example');
    expect((await t.api.get(`/api/mail/conversations/${anna.id}`)).data).toMatchObject({ archived: true, has_mail: true });
    // Nothing left to archive.
    expect((await t.api.post(`/api/mail/conversations/${anna.id}/archive`, { archive: true })).status).toBe(409);
    await syncNow(t, mb);
    expect(maps(t, mb).find((x) => x.remote_id === 'in1')!.folder).toBe('archive');
    const back = await t.api.post(`/api/mail/conversations/${anna.id}/archive`, { archive: false });
    expect(back.data).toMatchObject({ archived: false, changed: 1 });
    expect(labelsOf('in1')).toContain('INBOX');
  });

  it('adds and removes labels, and creates new ones', async () => {
    const anna = conv('anna@kunde.example')!;
    expect((await t.api.post(`/api/mail/conversations/${anna.id}/labels`, {})).status).toBe(400);
    const r = await t.api.post(`/api/mail/conversations/${anna.id}/labels`, { add: ['Label_1', 'Label_2'] });
    expect(r.data).toMatchObject({ ok: true, changed: 1, pending: 0 });
    expect(labelsOf('in1')).toEqual(expect.arrayContaining(['Label_1', 'Label_2']));
    expect(maps(t, mb).find((x) => x.remote_id === 'in1')!.labels).toEqual(expect.arrayContaining(['Label_1', 'Label_2']));
    await t.api.post(`/api/mail/conversations/${anna.id}/labels`, { remove: ['Label_2'] });
    expect(labelsOf('in1')).not.toContain('Label_2');
    expect((await t.api.get(`/api/mail/mailboxes/${mb}/labels`)).data.map((l: any) => l.name)).toEqual(['Kunde', 'Angebot']);
    const created = await t.api.post(`/api/mail/mailboxes/${mb}/labels`, { name: 'Neu' });
    expect(created.data).toMatchObject({ name: 'Neu' });
    expect((await t.api.get(`/api/mail/mailboxes/${mb}/labels`)).data.map((l: any) => l.name)).toContain('Neu');
  });

  it('a failing Gmail keeps the change queued; the sync does not undo it; the retry delivers it', async () => {
    const frank = conv('frank@kunde.example')!;
    fake.g.failures.push({ match: /POST \/messages\/in4\/modify/, status: 500, times: 1 });
    const r = await t.api.post(`/api/mail/conversations/${frank.id}/archive`, { archive: true });
    expect(r.data).toMatchObject({ ok: true, pending: 1 });
    expect(t.app.db.all('SELECT * FROM mailbox_outbox WHERE ref = ?', 'in4')).toHaveLength(1);
    expect(maps(t, mb).find((x) => x.remote_id === 'in4')!.folder).toBe('archive');
    // Something else changes the mail at Gmail: the sync reads INBOX again, but our pending change wins.
    fake.gmail.labels('in4', ['Label_1'], []);
    await syncNow(t, mb);
    expect(maps(t, mb).find((x) => x.remote_id === 'in4')).toMatchObject({ folder: 'archive' });
    // The retry is due later; make it due and let the background pass run.
    t.app.db.run('UPDATE mailbox_outbox SET next_attempt_at = NULL');
    await flush();
    expect(labelsOf('in4')).not.toContain('INBOX');
    expect(t.app.db.all('SELECT * FROM mailbox_outbox')).toHaveLength(0);
  });

  it('gives up on changes Gmail refuses for good and says why on the mailbox', async () => {
    const frank = conv('frank@kunde.example')!;
    fake.g.failures.push({ match: /POST \/messages\/in4\/modify/, status: 403, times: 1 });
    await t.api.post(`/api/mail/conversations/${frank.id}/archive`, { archive: false });
    expect(t.app.db.all('SELECT * FROM mailbox_outbox')).toHaveLength(0);
    expect(box(t, mb).last_error).toMatch(/Keine Berechtigung/);
  });
});

describe('sending through the mailbox', () => {
  const lastRaw = () => fake.g.sentRaw.at(-1)!;

  it('answers in the same thread: threadId, In-Reply-To, References, "Re:", signature, Bcc – and records it in the conversation', async () => {
    const anna = conv('anna@kunde.example')!;
    const r = await t.api.post(`/api/mail/conversations/${anna.id}/reply`, { body: 'Gerne, hier das Angebot.', cc: 'chef@kunde.example', bcc: 'archiv@intern.example' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ status: 'sent', conversation_id: anna.id, thread_id: 'th-anna' });
    const raw = lastRaw();
    expect(raw.threadId).toBe('th-anna');
    expect(raw.parsed).toMatchObject({ to: ['anna@kunde.example'], cc: ['chef@kunde.example'], subject: 'Re: Angebot Küche', inReplyTo: 'in1@mail.example' });
    expect(raw.parsed.references).toContain('in1@mail.example');
    expect(raw.parsed.bcc).toContain('archiv@intern.example');
    expect(raw.parsed.text).toContain('Gerne, hier das Angebot.');
    expect(raw.parsed.text).toContain('-- \nPaul Muster\nMuster GmbH');
    expect(raw.parsed.html).toContain('Muster GmbH');
    expect(raw.parsed.messageId).toMatch(/^[0-9a-f-]{36}@gmail\.example$/);
    const mine = msgs(t, 'conversation_id = ? AND direction = ?', anna.id, 'out');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'sent', channel: 'email', subject: 'Re: Angebot Küche', source: 'Postfach Info', provider_id: `<${raw.parsed.messageId}>` });
    expect(mine[0].user_id).toBeTruthy();
    const map = maps(t, mb).find((x) => x.message_id === mine[0].id)!;
    expect(map).toMatchObject({ folder: 'sent', thread_id: 'th-anna', internet_id: raw.parsed.messageId });
  });

  it('does not import the sent copy a second time', async () => {
    const before = msgs(t, 'location_id = ?', locA).length;
    const r = await syncNow(t, mb);
    expect(msgs(t, 'location_id = ?', locA)).toHaveLength(before);
    expect(r.created).toBe(0);
    expect(maps(t, mb).filter((x) => x.internet_id === lastRaw().parsed.messageId)).toHaveLength(1);
  });

  it('sends new mail with attachments and HTML; creates the contact; validates input', async () => {
    const send = (b: any) => t.api.post('/api/mail/send', { mailbox_id: mb, ...b });
    expect((await send({ to: 'kaputt', body: 'x' })).status).toBe(400);
    expect((await send({ to: 'a@b.de' })).status).toBe(400);
    expect((await send({ body: 'x' })).data.error).toBe('Empfänger fehlt');
    // Together over 8 MB (the request itself stays under the 12 MB body limit).
    const big = Buffer.alloc(4_400_000).toString('base64');
    const tooBig = await send({ to: 'a@b.de', body: 'x', attachments: [{ filename: 'eins.bin', content_base64: big }, { filename: 'zwei.bin', content_base64: big }] });
    expect(tooBig).toMatchObject({ status: 400 });
    expect(tooBig.data.error).toMatch(/höchstens 8 MB/);
    expect((await send({ to: 'a@b.de', body: 'x', attachments: [{ filename: 'x' }] })).status).toBe(400);
    const r = await send({ to: 'Neu Kunde <neu@kunde.example>', subject: 'Hallo\r\nBcc: boese@evil.example', body: '<p>Fett <b>gedruckt</b></p>', html: true, signature: false, attachments: [{ filename: 'notiz.txt', content_base64: Buffer.from('Inhalt').toString('base64'), content_type: 'text/plain' }] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const raw = lastRaw();
    expect(raw.parsed.to).toEqual(['neu@kunde.example']);
    expect(raw.parsed.subject).toBe('Hallo Bcc: boese@evil.example');
    expect(raw.parsed.bcc).toBe('');
    expect(raw.parsed.html).toContain('<b>gedruckt</b>');
    expect(raw.parsed.text).toContain('Fett gedruckt');
    expect(raw.parsed.text).not.toContain('Muster GmbH');
    expect(raw.parsed.attachments).toMatchObject([{ filename: 'notiz.txt', type: 'text/plain' }]);
    expect(raw.parsed.attachments[0].content.toString()).toBe('Inhalt');
    const c = t.app.db.get('SELECT * FROM contacts WHERE location_id = ? AND email = ?', locA, 'neu@kunde.example')!;
    expect(c).toMatchObject({ first_name: 'Neu', last_name: 'Kunde', source: 'Postfach Info' });
    expect(msgs(t, 'contact_id = ?', c.id)).toMatchObject([{ direction: 'out', status: 'sent' }]);
  });

  it('plans a send for later and sends it from the background job', async () => {
    const send = (b: any) => t.api.post('/api/mail/send', { mailbox_id: mb, to: 'spaeter@kunde.example', subject: 'Später', body: 'Bis dann', ...b });
    expect((await send({ send_at: 'morgen' })).status).toBe(400);
    expect((await send({ send_at: new Date(Date.now() - 1000).toISOString() })).data.error).toMatch(/30 Sekunden/);
    expect((await send({ send_at: new Date(Date.now() + 100 * 864e5).toISOString() })).data.error).toMatch(/90 Tage/);
    const sentBefore = fake.g.sentRaw.length;
    const r = await send({ send_at: new Date(Date.now() + 3600_000).toISOString() });
    expect(r.data).toMatchObject({ status: 'scheduled' });
    expect(fake.g.sentRaw).toHaveLength(sentBefore);
    expect((await t.api.get('/api/mail/scheduled')).data).toMatchObject([{ id: r.data.scheduled_id, subject: 'Später', status: 'pending', mailbox_id: mb, to: ['spaeter@kunde.example'] }]);
    await t.app.tick();
    expect(fake.g.sentRaw).toHaveLength(sentBefore);
    t.app.db.run('UPDATE mailbox_scheduled SET send_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), r.data.scheduled_id);
    await t.app.tick();
    expect(fake.g.sentRaw).toHaveLength(sentBefore + 1);
    expect(lastRaw().parsed).toMatchObject({ to: ['spaeter@kunde.example'], subject: 'Später' });
    expect(t.app.db.get('SELECT status, message_id FROM mailbox_scheduled WHERE id = ?', r.data.scheduled_id)).toMatchObject({ status: 'sent' });
    expect(t.app.db.get('SELECT message_id FROM mailbox_scheduled WHERE id = ?', r.data.scheduled_id)!.message_id).toBeTruthy();
    // Not sent twice by the next run.
    await t.app.tick();
    expect(fake.g.sentRaw).toHaveLength(sentBefore + 1);
    expect((await t.api.get('/api/mail/scheduled')).data).toEqual([]);
  });

  it('cancels a planned send; a failing send is marked failed after a few tries', async () => {
    const r = await t.api.post('/api/mail/send', { mailbox_id: mb, to: 'nie@kunde.example', subject: 'Nie', body: 'x', send_at: new Date(Date.now() + 3600_000).toISOString() });
    expect((await t.api.del(`/api/mail/scheduled/${r.data.scheduled_id}`)).data).toEqual({ ok: true });
    t.app.db.run('UPDATE mailbox_scheduled SET status = ? WHERE id = ?', 'pending', r.data.scheduled_id);
    t.app.db.run('UPDATE mailbox_scheduled SET status = ? WHERE id = ?', 'cancelled', r.data.scheduled_id);
    const before = fake.g.sentRaw.length;
    await t.app.tick();
    expect(fake.g.sentRaw).toHaveLength(before);
    const f = await t.api.post('/api/mail/send', { mailbox_id: mb, to: 'fehler@kunde.example', subject: 'Fehler', body: 'x', send_at: new Date(Date.now() + 3600_000).toISOString() });
    fake.g.failures.push({ match: /POST \/messages\/send/, status: 500, times: 3 });
    for (let i = 0; i < 3; i++) {
      t.app.db.run('UPDATE mailbox_scheduled SET send_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), f.data.scheduled_id);
      await t.app.tick();
    }
    expect(t.app.db.get('SELECT status, attempts, error FROM mailbox_scheduled WHERE id = ?', f.data.scheduled_id)).toMatchObject({ status: 'failed', attempts: 3 });
    expect((await t.api.get('/api/mail/scheduled')).data).toMatchObject([{ status: 'failed' }]);
  });
});

describe('drafts round trip', () => {
  const draftOf = (localId: string) => maps(t, mb).find((x) => x.message_id === localId)!;
  let id = '';
  let draftId = '';

  it('creates a draft in the mailbox (it shows up in Gmail) and keeps it in the conversation', async () => {
    const r = await t.api.post('/api/mail/drafts', { mailbox_id: mb, to: 'gerd@kunde.example', subject: 'Entwurf eins', body: 'Version 1' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    id = r.data.message_id;
    expect(msgs(t, 'id = ?', id)).toMatchObject([{ status: 'draft', direction: 'out', subject: 'Entwurf eins', body: expect.stringContaining('Version 1') }]);
    const m = draftOf(id);
    draftId = m.draft_id;
    expect(m).toMatchObject({ folder: 'drafts' });
    expect(fake.g.drafts.has(draftId)).toBe(true);
    expect(fake.g.messages.get(fake.g.drafts.get(draftId)!).labels).toEqual(['DRAFT']);
    const list = (await t.api.get('/api/mail/drafts')).data;
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ id, subject: 'Entwurf eins', mailbox_id: mb, to: ['gerd@kunde.example'] })]));
    expect((await t.api.get(`/api/conversations?filter=drafts`)).data.map((c: any) => c.email)).toContain('gerd@kunde.example');
  });

  it('changes it: Gmail gives the draft a new message id, the mapping follows, nothing is duplicated', async () => {
    const oldRemote = draftOf(id).remote_id;
    const r = await t.api.put(`/api/mail/drafts/${id}`, { to: 'gerd@kunde.example', subject: 'Entwurf zwei', body: 'Version 2' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const m = draftOf(id);
    expect(m.remote_id).not.toBe(oldRemote);
    expect(m.draft_id).toBe(draftId);
    expect(maps(t, mb).filter((x) => x.remote_id === oldRemote)).toHaveLength(0);
    expect(fake.g.messages.get(m.remote_id).subject).toBe('Entwurf zwei');
    expect(msgs(t, 'id = ?', id)).toMatchObject([{ subject: 'Entwurf zwei', body: expect.stringContaining('Version 2') }]);
    const before = msgs(t, 'location_id = ?', locA).length;
    await syncNow(t, mb);
    expect(msgs(t, 'location_id = ?', locA)).toHaveLength(before);
    expect(maps(t, mb).filter((x) => x.message_id === id)).toHaveLength(1);
  });

  it('picks up an edit made in Gmail itself', async () => {
    fake.gmail.editDraft(draftId, { subject: 'Entwurf drei', text: 'Version 3 aus Gmail' });
    await syncNow(t, mb);
    expect(msgs(t, 'id = ?', id)).toMatchObject([{ subject: 'Entwurf drei', body: expect.stringContaining('Version 3 aus Gmail') }]);
    expect(maps(t, mb).filter((x) => x.message_id === id)).toHaveLength(1);
    expect(draftOf(id).remote_id).toBe(fake.g.drafts.get(draftId));
  });

  it('sends the draft: it becomes a sent message in place, without a second copy', async () => {
    const r = await t.api.post(`/api/mail/drafts/${id}/send`, {});
    expect(r.data).toMatchObject({ status: 'sent', message_id: id });
    expect(fake.g.drafts.has(draftId)).toBe(false);
    expect(msgs(t, 'id = ?', id)).toMatchObject([{ status: 'sent' }]);
    expect(draftOf(id)).toMatchObject({ folder: 'sent', draft_id: '' });
    const before = msgs(t, 'location_id = ?', locA).length;
    await syncNow(t, mb);
    expect(msgs(t, 'location_id = ?', locA)).toHaveLength(before);
    expect((await t.api.get('/api/mail/drafts')).data.map((d: any) => d.id)).not.toContain(id);
  });

  it('deletes a draft in Gmail when it is deleted here – through the mail API and through the old delete route', async () => {
    const a = (await t.api.post('/api/mail/drafts', { mailbox_id: mb, to: 'hanna@kunde.example', subject: 'Weg 1', body: 'x' })).data.message_id;
    const da = draftOf(a).draft_id;
    expect((await t.api.del(`/api/mail/drafts/${a}`)).data).toEqual({ ok: true });
    expect(fake.g.drafts.has(da)).toBe(false);
    expect(msgs(t, 'id = ?', a)).toHaveLength(0);
    expect((await t.api.del(`/api/mail/drafts/${a}`)).status).toBe(404);
    const b = (await t.api.post('/api/mail/drafts', { mailbox_id: mb, to: 'ida@kunde.example', subject: 'Weg 2', body: 'x' })).data.message_id;
    const db_ = draftOf(b).draft_id;
    // The inbox's own "Verwerfen" button: DELETE /api/messages/:id.
    expect((await t.api.del(`/api/messages/${b}`)).status).toBe(200);
    await t.app.services.mailbox.flush(mb);
    expect(fake.g.drafts.has(db_)).toBe(false);
    expect(maps(t, mb).some((x) => x.message_id === b)).toBe(false);
  });

  it('shows drafts written in Gmail and forgets those that were sent or deleted there', async () => {
    const d = fake.gmail.draft({ to: 'jan@kunde.example', subject: 'Aus Gmail', text: 'Entwurf im Browser' });
    await syncNow(t, mb);
    const m = msgs(t, 'subject = ?', 'Aus Gmail');
    expect(m).toMatchObject([{ status: 'draft' }]);
    // Sent in Gmail: the draft becomes a sent message (same row), not a duplicate.
    fake.g.drafts.delete(d.draftId);
    fake.gmail.labels(d.message.id, ['SENT'], ['DRAFT']);
    await syncNow(t, mb);
    expect(msgs(t, 'subject = ?', 'Aus Gmail')).toMatchObject([{ id: m[0].id, status: 'sent' }]);
    expect(maps(t, mb).find((x) => x.message_id === m[0].id)).toMatchObject({ folder: 'sent', draft_id: '' });
    // Another draft that is simply deleted in Gmail.
    const e = fake.gmail.draft({ to: 'kai@kunde.example', subject: 'Verworfen', text: 'weg damit' });
    await syncNow(t, mb);
    expect(msgs(t, 'subject = ?', 'Verworfen')).toHaveLength(1);
    fake.g.drafts.delete(e.draftId);
    fake.gmail.delete(e.message.id);
    await syncNow(t, mb);
    expect(msgs(t, 'subject = ?', 'Verworfen')).toHaveLength(0);
  });
});

describe('the sub-account setting "Verbundenes Postfach" for workflow e-mails', () => {
  it('sends the sub-account\'s e-mails through the mailbox and does not import them twice', async () => {
    await t.api.patch('/api/location', { settings: { email: { provider: 'mailbox', mailbox_id: mb, fromEmail: 'egal@x.de' } } });
    const c = (await t.api.post('/api/contacts', { first_name: 'Lena', last_name: 'Test', email: 'lena@kunde.example' })).data;
    const r = await t.api.post('/api/messages', { contact_id: c.id, channel: 'email', subject: 'Workflow-Mail', body: 'Automatisch gesendet' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ status: 'sent' });
    const raw = fake.g.sentRaw.at(-1)!.parsed;
    expect(raw).toMatchObject({ to: ['lena@kunde.example'], subject: 'Workflow-Mail', from: 'inhaber@gmail.example' });
    expect(raw.text).toContain('Automatisch gesendet');
    const stored = msgs(t, 'contact_id = ?', c.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].provider_id).toBe(`<${raw.messageId}>`);
    // The copy in the sent folder is the same mail (provider id = Message-ID).
    await syncNow(t, mb);
    expect(msgs(t, 'contact_id = ?', c.id)).toHaveLength(1);
    expect(maps(t, mb).find((x) => x.internet_id === raw.messageId)).toMatchObject({ message_id: stored[0].id, folder: 'sent' });
  });

  it('says what is missing instead of sending when no (valid) mailbox is chosen', async () => {
    await t.api.patch('/api/location', { settings: { email: { provider: 'mailbox', mailbox_id: 'gibt-es-nicht' } } });
    const c = t.app.db.get('SELECT id FROM contacts WHERE email = ?', 'lena@kunde.example')!;
    const r = await t.api.post('/api/messages', { contact_id: c.id, channel: 'email', subject: 'X', body: 'Y' });
    expect(r.data).toMatchObject({ status: 'failed', error: expect.stringContaining('Kein Postfach gewählt') });
    await t.api.patch('/api/location', { settings: { email: { provider: 'log' } } });
  });
});
