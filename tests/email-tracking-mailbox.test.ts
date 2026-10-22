import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, connect, login, msgs, settle, type T } from './mailbox-helpers.js';
import type { MailFake } from './mailbox-fakes.js';
import { pruneEvents } from '../server/services/email-events.js';

/**
 * Open and click tracking for mail sent from a connected mailbox: opt-in per mailbox (default off, 1:1 mail may
 * need consent), through the tracking module's instrumentEmail hook, switchable per mail, bound to the sub-account's
 * own switches, and visible in the audit log.
 */

let t: T;
let fake: MailFake;
let mb = '';
let A = '';
let chatOnly: Awaited<ReturnType<typeof login>>;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const person = { 'user-agent': CHROME, 'accept-language': 'de-DE,de;q=0.9' };

const lastRaw = () => fake.g.sentRaw.at(-1)!;
const body = '<p>Unser Preis: <a href="https://example.com/preis?a=1&amp;b=2">hier</a> und <a href="https://example.com/agb">AGB</a></p>';
const send = (extra: Record<string, unknown> = {}, to = 'kunde@kunde.example') => t.api.post('/api/mail/send', { mailbox_id: mb, to, subject: 'Angebot', body, html: true, signature: false, ...extra });
const track = (v: boolean) => t.api.patch(`/api/mailboxes/${mb}`, { track_engagement: v });
const links = (messageId: string) => t.app.db.all('SELECT id, url, contact_id FROM tracked_links WHERE message_id = ? ORDER BY url', messageId) as { id: string; url: string; contact_id: string | null }[];

beforeAll(async () => {
  ({ t, fake } = await boot());
  A = t.api.location;
  await t.api.post('/api/users', { email: 'chat@example.com', name: 'Chat', password: 'passwort-1', role: 'member', locations: [A], permissions: ['conversations'] });
  chatOnly = await login(t, 'chat@example.com', 'passwort-1', A);
  const c = await connect(t, fake, { provider: 'google', access: 'full', name: 'Info' });
  mb = c.id;
  await settle(t, mb);
});
afterAll(async () => {
  await t.close();
});

describe('mailbox opt-in', () => {
  it('is off by default: nothing is added to the mail, even when a mail asks for it', async () => {
    const mailbox = (await t.api.get('/api/mailboxes')).data.mailboxes.find((m: any) => m.id === mb);
    expect(mailbox.track_engagement).toBe(false);
    expect(t.app.db.get('SELECT track_engagement FROM mailboxes WHERE id = ?', mb)).toMatchObject({ track_engagement: 0 });
    for (const extra of [{}, { track: true }]) {
      const r = await send(extra);
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      const html = lastRaw().parsed.html;
      expect(html).toContain('href="https://example.com/preis?a=1&amp;b=2"');
      expect(html).not.toContain('/t/c/');
      expect(html).not.toContain('/t/o/');
      expect(links(r.data.message_id)).toHaveLength(0);
    }
  });

  it('is set in the mailbox settings by someone who may manage it – and is written to the audit log', async () => {
    expect((await chatOnly.patch(`/api/mailboxes/${mb}`, { track_engagement: true })).status).toBe(403);
    const r = await track(true);
    expect(r.status).toBe(200);
    expect(r.data.track_engagement).toBe(true);
    expect((await t.api.get('/api/mail/mailboxes')).data.find((m: any) => m.id === mb).track_engagement).toBe(true);
    // The reply composer learns it from the thread info (to show the per-mail switch).
    const conv = t.app.db.get('SELECT id FROM conversations WHERE location_id = ? LIMIT 1', A)!;
    const info = (await t.api.get(`/api/mail/conversations/${conv.id}`)).data;
    expect(info.mailboxes.find((m: any) => m.id === mb)).toMatchObject({ track_engagement: true });
    expect(t.app.db.all(`SELECT summary FROM audit_log WHERE action = 'mailbox.tracking'`)).toMatchObject([{ summary: expect.stringContaining('werden verfolgt') }]);
    // Saving the same value again is not a change.
    await track(true);
    expect(t.app.db.all(`SELECT id FROM audit_log WHERE action = 'mailbox.tracking'`)).toHaveLength(1);
  });

  it('on: links go through /t/c/, the pixel carries the id of the message that is recorded, the text part stays clean', async () => {
    const r = await send({}, 'neu@kunde.example');
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const raw = lastRaw().parsed;
    const ls = links(r.data.message_id);
    expect(ls.map((l) => l.url)).toEqual(['https://example.com/agb', 'https://example.com/preis?a=1&b=2']);
    expect(raw.html).toContain(`href="http://localhost/t/c/${ls[0].id}"`);
    expect(raw.html).toContain(`href="http://localhost/t/c/${ls[1].id}"`);
    expect(raw.html).not.toContain('href="https://example.com/');
    expect(raw.html).toContain(`<img src="http://localhost/t/o/${r.data.message_id}.gif" width="1" height="1" alt="" style="display:none">`);
    expect(raw.text).not.toContain('/t/');
    // The message exists under exactly that id, and its stored text is what the person wrote.
    const m = msgs(t, 'id = ?', r.data.message_id)[0];
    expect(m).toMatchObject({ direction: 'out', status: 'sent', channel: 'email' });
    expect(m.body).not.toContain('/t/');
    // The contact is created after the send, as before – the links carry no contact, the message does.
    expect(ls[0].contact_id).toBeNull();
    expect(t.app.db.get('SELECT contact_id FROM messages WHERE id = ?', r.data.message_id)!.contact_id).toBe(r.data.contact_id);
  });

  it('opens and clicks of that mail: people count, proxies and scanners do not', async () => {
    const r = await send({}, 'leser@kunde.example');
    const id = r.data.message_id as string;
    const ls = links(id);
    // Proxy and Apple Mail load the pixel on delivery; a scanner follows a link seconds after sending.
    await fetch(`${t.base}/t/o/${id}.gif`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)' } });
    expect((await fetch(`${t.base}/t/c/${ls[0].id}`, { redirect: 'manual', headers: person })).status).toBe(302);
    t.app.services.trackingCommit({ force: true });
    expect(t.app.db.get('SELECT opened_at, clicked_at, machine_open_count, machine_click_count FROM messages WHERE id = ?', id)).toEqual({ opened_at: null, clicked_at: null, machine_open_count: 1, machine_click_count: 1 });
    // The person reads it later.
    t.app.db.run('UPDATE messages SET created_at = ? WHERE id = ?', new Date(Date.now() - 3600_000).toISOString(), id);
    t.app.db.run('DELETE FROM email_events WHERE kind = ?', 'click');
    await fetch(`${t.base}/t/o/${id}.gif`, { headers: person });
    const click = await fetch(`${t.base}/t/c/${ls[1].id}`, { redirect: 'manual', headers: person });
    expect(click.headers.get('location')).toBe(ls[1].url);
    t.app.services.trackingCommit({ force: true });
    await t.app.events.flush();
    const m = t.app.db.get('SELECT * FROM messages WHERE id = ?', id)!;
    expect(m).toMatchObject({ open_count: 1, click_count: 1, machine_open_count: 1 });
    expect(m.opened_at).toBeTruthy();
    expect(m.clicked_at).toBeTruthy();
    // The activity of the contact (known through the message) names the link.
    expect(t.app.db.all(`SELECT summary FROM activities WHERE contact_id = ? AND type = 'email.clicked'`, r.data.contact_id)).toMatchObject([{ summary: `Link geklickt: ${ls[1].url}` }]);
  });

  it('replies from the inbox and scheduled sends are tracked too', async () => {
    const lea = (await send({}, 'lea@kunde.example')).data;
    const reply = await t.api.post(`/api/mail/conversations/${lea.conversation_id}/reply`, { mailbox_id: mb, body, html: true, signature: false });
    expect(reply.status, JSON.stringify(reply.data)).toBe(200);
    expect(lastRaw().parsed.html).toContain(`/t/o/${reply.data.message_id}.gif`);
    expect(links(reply.data.message_id)).toHaveLength(2);
    const planned = await send({ send_at: new Date(Date.now() + 3600_000).toISOString() }, 'spaeter@kunde.example');
    expect(planned.data.status).toBe('scheduled');
    t.app.db.run('UPDATE mailbox_scheduled SET send_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), planned.data.scheduled_id);
    await t.app.tick();
    const sent = t.app.db.get('SELECT message_id FROM mailbox_scheduled WHERE id = ?', planned.data.scheduled_id)!.message_id as string;
    expect(sent).toBeTruthy();
    expect(lastRaw().parsed.html).toContain(`/t/o/${sent}.gif`);
    expect(links(sent)).toHaveLength(2);
  });

  it('a single mail can be sent untracked (track: false), the mailbox default stays on', async () => {
    const r = await send({ track: false }, 'diskret@kunde.example');
    expect(lastRaw().parsed.html).toContain('href="https://example.com/preis?a=1&amp;b=2"');
    expect(lastRaw().parsed.html).not.toContain('/t/');
    expect(links(r.data.message_id)).toHaveLength(0);
    expect((await send({}, 'wieder@kunde.example')).data.message_id).toBeTruthy();
    expect(lastRaw().parsed.html).toContain('/t/o/');
  });

  it('the sub-account\'s own switches still apply: tracking off = nothing, track_opens off = links without pixel', async () => {
    await t.api.patch('/api/location', { settings: { email: { track_opens: false } } });
    const noPixel = await send({}, 'ohnepixel@kunde.example');
    expect(lastRaw().parsed.html).toContain('/t/c/');
    expect(lastRaw().parsed.html).not.toContain('/t/o/');
    expect(links(noPixel.data.message_id)).toHaveLength(2);
    await t.api.patch('/api/location', { settings: { email: { tracking: false } } });
    const off = await send({}, 'aus@kunde.example');
    expect(lastRaw().parsed.html).not.toContain('/t/');
    expect(links(off.data.message_id)).toHaveLength(0);
    await t.api.patch('/api/location', { settings: { email: { tracking: true, track_opens: true } } });
  });

  it('a send that fails leaves no message and no contact; its links are cleaned up later', async () => {
    fake.g.failures.push({ match: /POST \/messages\/send/, status: 500, times: 5 });
    const before = t.app.db.all('SELECT id FROM tracked_links').length;
    const r = await send({}, 'kaputt@kunde.example');
    fake.g.failures.length = 0;
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(t.app.db.get(`SELECT id FROM contacts WHERE location_id = ? AND email = 'kaputt@kunde.example'`, A)).toBeUndefined();
    const orphans = t.app.db.all('SELECT id FROM tracked_links WHERE message_id NOT IN (SELECT id FROM messages)');
    expect(orphans.length).toBe(2);
    expect(t.app.db.all('SELECT id FROM tracked_links').length).toBe(before + 2);
    // Fresh ones stay (the mail may still be on its way); old ones go.
    pruneEvents(t.app);
    expect(t.app.db.all('SELECT id FROM tracked_links WHERE message_id NOT IN (SELECT id FROM messages)')).toHaveLength(2);
    t.app.db.run('UPDATE tracked_links SET created_at = ? WHERE message_id NOT IN (SELECT id FROM messages)', new Date(Date.now() - 2 * 864e5).toISOString());
    pruneEvents(t.app);
    expect(t.app.db.all('SELECT id FROM tracked_links WHERE message_id NOT IN (SELECT id FROM messages)')).toHaveLength(0);
  });

  it('switching it off again stops it for new mail', async () => {
    expect((await track(false)).data.track_engagement).toBe(false);
    const r = await send({}, 'schluss@kunde.example');
    expect(lastRaw().parsed.html).not.toContain('/t/');
    expect(links(r.data.message_id)).toHaveLength(0);
    expect(t.app.db.all(`SELECT summary FROM audit_log WHERE action = 'mailbox.tracking' ORDER BY rowid`).map((x: any) => x.summary)).toEqual([expect.stringContaining('werden verfolgt'), expect.stringContaining('werden nicht verfolgt')]);
  });
});
