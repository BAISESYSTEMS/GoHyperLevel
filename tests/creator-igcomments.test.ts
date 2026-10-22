import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { signBody } from '../server/services/meta.js';
import { appliesTo, cleanButtons, cleanRule, dmContent, matchKeyword, messengerMessage, normText, parseComments, parseStoryReplies, replyAt, whatsappInteractive } from '../server/services/igcomments.js';

/** Comment-to-DM: Meta is a fake Graph API that records every call and refuses a second private reply to the same comment, like Meta does. */
const APP_SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // oss-check: allow (fake test secret)
const WA_TOKEN = 'EAAGwatoken' + 'x'.repeat(40);
const PAGE_TOKEN = 'EAAGpagetoken' + 'y'.repeat(40);
const calls: { method: string; url: string; path: string; body: any }[] = [];
const privateReplied = new Set<string>();
let seq = 0;
let failPublic = false;
const fake = async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const u = new URL(url);
  const path = u.pathname.replace(/^\/v\d+\.\d+\//, '');
  calls.push({ method, url, path, body });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  const auth = (init.headers as any)?.authorization ?? '';
  if (auth !== `Bearer ${PAGE_TOKEN}` && auth !== `Bearer ${WA_TOKEN}`) return json({ error: { message: 'Invalid OAuth access token', code: 190 } }, 401);
  if (method === 'GET' && path === '5551') return json({ first_name: 'Max', last_name: 'Muster' });
  if (method === 'GET' && path === '6661') return json({ name: 'Lena Lustig', username: 'lena.insta' });
  if (method === 'GET' && path === '4444/media') return json({ data: [{ id: '17900001', caption: 'Mein neuer Guide\nmit Zeilenumbruch', media_type: 'VIDEO', permalink: 'https://instagram.com/reel/abc', timestamp: '2026-10-01T10:00:00+0000' }] });
  if (method === 'GET' && path === '3333/posts') return json({ data: [{ id: '3333_900', message: 'Neuer Beitrag', permalink_url: 'https://facebook.com/3333/posts/900', created_time: '2026-10-01T10:00:00+0000' }] });
  if (method === 'POST' && path === 'me/messages') {
    if (body.recipient.comment_id) {
      if (privateReplied.has(body.recipient.comment_id)) return json({ error: { message: '(#10900) Cannot reply privately to this comment again', code: 10900 } }, 400);
      privateReplied.add(body.recipient.comment_id);
      return json({ recipient_id: body.recipient.comment_id.startsWith('fb') ? '5551' : '6661', message_id: `m_pr${++seq}` });
    }
    return json({ recipient_id: body.recipient.id, message_id: `m_out${++seq}` });
  }
  if (method === 'POST' && /\/(replies|comments)$/.test(path)) return failPublic ? json({ error: { message: '(#200) Permission denied', code: 200 } }, 403) : json({ id: `c_reply${++seq}` });
  if (method === 'POST' && path.endsWith('/subscribed_apps')) return path.startsWith('4444') && u.searchParams.get('subscribed_fields')!.includes('comments') && failIg ? json({ error: { message: '(#100) Invalid field', code: 100 } }, 400) : json({ success: true });
  return json({ error: { message: `unknown ${method} ${path}`, code: 100 } }, 400);
};
let failIg = false;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const matched: any[] = [];
const hook = (payload: unknown, opts: { secret?: string } = {}) => {
  const raw = JSON.stringify(payload);
  return t.api.raw(`/hooks/meta/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(raw, opts.secret ?? APP_SECRET) }, body: raw });
};
const igComment = (id: string, text: string, from = '6661', media = '17900001', username = 'lena.insta', parent?: string) => ({
  object: 'instagram',
  entry: [{ id: '4444', time: Date.now(), changes: [{ field: 'comments', value: { id, text, from: { id: from, username }, media: { id: media, media_product_type: 'REELS' }, ...(parent ? { parent_id: parent } : {}) } }] }],
});
const fbComment = (id: string, text: string, from = '5551', post = '3333_900') => ({
  object: 'page',
  entry: [{ id: '3333', time: Date.now(), changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: id, post_id: post, parent_id: post, from: { id: from, name: 'Max Muster' }, message: text, created_time: Math.floor(Date.now() / 1000) } }] }],
});
const callsTo = (pred: (c: (typeof calls)[number]) => boolean) => calls.filter(pred);
const privateReplies = () => callsTo((c) => c.path === 'me/messages' && !!c.body?.recipient?.comment_id);
const rule = async (over: Record<string, unknown> = {}) => (await t.api.post('/api/ig-comments/rules', { name: 'Guide', keywords: ['guide'], dm_text: 'Hier ist dein Guide!', link_url: 'https://example.com/guide.pdf', link_label: 'Guide laden', ...over })).data;
const clearRules = () => t.app.db.run('DELETE FROM igc_rules WHERE location_id = ?', loc);
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.metaFetch = fake;
  await t.setup();
  loc = t.api.location;
  await t.api.put('/api/settings/meta', { wa_phone_number_id: '1111', wa_business_account_id: '2222', wa_token: WA_TOKEN, app_secret: APP_SECRET, page_id: '3333', page_token: PAGE_TOKEN, ig_account_id: '4444' });
  t.app.events.on('igcomment.matched', (e) => void matched.push(e.data));
});
afterAll(async () => {
  await t.close();
});

describe('comment-to-DM: pure helpers', () => {
  it('matches whole words without caring for case, accents, emoji and punctuation', () => {
    expect(normText('Guide, bitte! 🙏')).toBe('guide bitte');
    expect(normText('Größe')).toBe('grosse');
    const r = { match_mode: 'contains' as const, keywords: ['guide', 'ich will mehr'] };
    expect(matchKeyword(r, 'GUIDE!!!')).toBe('guide');
    expect(matchKeyword(r, 'Ich will 🔥 mehr')).toBe('ich will mehr');
    expect(matchKeyword(r, 'Ich will nicht mehr')).toBeNull();
    expect(matchKeyword(r, 'ich   will mehr, bitte')).toBe('ich will mehr');
    expect(matchKeyword(r, 'Leitfaden')).toBeNull();
    // whole words only: "guided" is not "guide"
    expect(matchKeyword(r, 'guided tour')).toBeNull();
    expect(matchKeyword({ match_mode: 'exact', keywords: ['guide'] }, 'Guide!')).toBe('guide');
    expect(matchKeyword({ match_mode: 'exact', keywords: ['guide'] }, 'guide bitte')).toBeNull();
    expect(matchKeyword({ match_mode: 'any', keywords: [] }, '🙏')).toBe('*');
    expect(matchKeyword(r, '')).toBeNull();
  });

  it('limits a rule to a platform and one post', () => {
    const all = { kind: 'comment' as const, platform: 'instagram' as const, scope: 'all', media_id: '' };
    expect(appliesTo(all, { platform: 'instagram', mediaId: '1' })).toBe(true);
    expect(appliesTo(all, { platform: 'facebook', mediaId: '1' })).toBe(false);
    expect(appliesTo({ ...all, platform: 'both' }, { platform: 'facebook', mediaId: '1' })).toBe(true);
    const one = { ...all, scope: 'post', media_id: '17900001' };
    expect(appliesTo(one, { platform: 'instagram', mediaId: '17900001' })).toBe(true);
    expect(appliesTo(one, { platform: 'instagram', mediaId: '17900002' })).toBe(false);
    expect(appliesTo({ ...one, platform: 'facebook', media_id: '900' }, { platform: 'facebook', mediaId: '3333_900' })).toBe(true);
    expect(appliesTo({ ...all, kind: 'story_reply' as any }, { platform: 'instagram', mediaId: '' })).toBe(false);
  });

  it('rotates the public replies round-robin', () => {
    expect(['a', 'b', 'c', 'd'].map((_, i) => replyAt(['x', 'y', 'z'], i))).toEqual(['x', 'y', 'z', 'x']);
    expect(replyAt([], 3)).toBe('');
  });

  it('validates rules', () => {
    const ok = cleanRule({ keywords: ['Guide', 'guide', ' '], dm_text: 'Hi' });
    expect(ok).toMatchObject({ kind: 'comment', platform: 'instagram', scope: 'all', keywords: ['Guide', 'guide'], max_per_hour: 60, enabled: true });
    expect(() => cleanRule({ dm_text: 'Hi' })).toThrow(/Stichwort/);
    expect(cleanRule({ match_mode: 'any', dm_text: 'Hi' }).keywords).toEqual([]);
    expect(() => cleanRule({ keywords: ['a'] })).toThrow(/Direktnachricht/);
    expect(() => cleanRule({ keywords: ['a'], dm_text: 'x', link_url: 'http://x.de' })).toThrow(/https/);
    expect(() => cleanRule({ keywords: ['a'], dm_text: 'x', scope: 'post' })).toThrow(/Beitrag/);
    expect(() => cleanRule({ keywords: ['a'], dm_text: 'x', max_per_hour: 0 })).toThrow(/Stunde/);
    expect(() => cleanRule({ kind: 'story_reply', platform: 'facebook', keywords: ['a'], dm_text: 'x' })).toThrow(/Instagram/);
    // a story reply has no public answer
    expect(cleanRule({ kind: 'story_reply', keywords: ['a'], dm_text: 'x', public_replies: ['Danke'] }).public_replies).toEqual([]);
    // PATCH keeps what it does not mention
    expect(cleanRule({ name: 'Neu' }, ok).keywords).toEqual(['Guide', 'guide']);
    expect(() => cleanButtons([{ type: 'url', title: 'Link', value: 'javascript:alert(1)' }])).toThrow(/https/);
    expect(cleanButtons([{ type: 'reply', title: 'Ja, gerne bitte schön und danke' }])[0]).toMatchObject({ type: 'reply', title: 'Ja, gerne bitte schö', value: 'Ja, gerne bitte schö' });
  });

  it('builds the message bodies of every channel', () => {
    const link = { type: 'url' as const, title: 'Guide laden', value: 'https://example.com/g' };
    const a = { type: 'reply' as const, title: 'Anfänger', value: 'anfaenger' };
    const b = { type: 'reply' as const, title: 'Profi', value: 'profi' };
    expect(messengerMessage('Hallo', [])).toEqual({ text: 'Hallo' });
    expect(messengerMessage('Hallo', [link, a]).attachment.payload).toMatchObject({ template_type: 'button', buttons: [{ type: 'web_url', url: 'https://example.com/g', title: 'Guide laden' }, { type: 'postback', title: 'Anfänger', payload: 'anfaenger' }] });
    expect(messengerMessage('Wähle', [a, b])).toEqual({ text: 'Wähle', quick_replies: [{ content_type: 'text', title: 'Anfänger', payload: 'anfaenger' }, { content_type: 'text', title: 'Profi', payload: 'profi' }] });
    expect(messengerMessage('Wähle', [a, b], 'buttons').attachment.payload.buttons).toHaveLength(2);
    expect(whatsappInteractive('49170', 'Hallo', [link])).toMatchObject({ type: 'interactive', interactive: { type: 'cta_url', action: { parameters: { display_text: 'Guide laden', url: 'https://example.com/g' } } } });
    const w = whatsappInteractive('49170', 'Wähle', [a, b]) as any;
    expect(w.interactive.action.buttons.map((x: any) => x.reply.title)).toEqual(['Anfänger', 'Profi']);
    expect(() => whatsappInteractive('49170', 'x', [link, a])).toThrow(/nicht gemischt/);
    expect(() => whatsappInteractive('49170', 'x', [a, b, a, b])).toThrow(/drei/);
    // the link is a button, so nobody has to copy it
    expect(dmContent({ dm_text: 'Viel Spaß', link_url: 'https://example.com/g', link_label: 'Öffnen', buttons: [a] })).toEqual({ text: 'Viel Spaß', buttons: [{ type: 'url', title: 'Öffnen', value: 'https://example.com/g' }, a] });
  });

  it('reads comment webhooks and ignores edits and replies to comments', () => {
    expect(parseComments(igComment('c1', 'guide'))).toEqual([{ platform: 'instagram', accountId: '4444', commentId: 'c1', mediaId: '17900001', parentId: '', fromId: '6661', fromName: '', fromUsername: 'lena.insta', text: 'guide' }]);
    expect(parseComments(igComment('c2', 'guide', '6661', '17900001', 'x', 'c1'))).toEqual([]);
    expect(parseComments(fbComment('fb1', 'guide'))[0]).toMatchObject({ platform: 'facebook', accountId: '3333', commentId: 'fb1', mediaId: '3333_900', fromName: 'Max Muster' });
    const edited = fbComment('fb1', 'guide');
    (edited.entry[0].changes[0].value as any).verb = 'edited';
    expect(parseComments(edited)).toEqual([]);
    const reply = fbComment('fb2', 'guide');
    (reply.entry[0].changes[0].value as any).parent_id = '3333_900_777';
    expect(parseComments(reply)).toEqual([]);
    expect(parseComments({ object: 'page', entry: [{ id: '3333', changes: [{ field: 'feed', value: { item: 'reaction', verb: 'add' } }] }] })).toEqual([]);
    expect(parseComments(null)).toEqual([]);
    const story = { object: 'instagram', entry: [{ id: '4444', messaging: [{ sender: { id: '6661' }, message: { mid: 'm1', text: 'guide', reply_to: { story: { id: 'st1' } } } }, { sender: { id: '6661' }, message: { mid: 'm2', text: 'hi' } }] }] };
    expect(parseStoryReplies(story)).toEqual([{ accountId: '4444', fromId: '6661', mid: 'm1', text: 'guide', storyId: 'st1' }]);
  });
});

describe('comment-to-DM: rules API', () => {
  it('creates, lists, updates and deletes rules with stats', async () => {
    const r = await rule({ public_replies: ['Check deine DMs!', 'Schau in dein Postfach 📬'], tags: ['lead-magnet'] });
    expect(r).toMatchObject({ name: 'Guide', kind: 'comment', platform: 'instagram', enabled: true, keywords: ['guide'], once_per_person: true });
    expect(r.stats).toEqual({ matches: 0, dms: 0, replies: 0, failed: 0, last_at: null });
    expect((await t.api.get('/api/ig-comments/rules')).data).toHaveLength(1);
    expect((await t.api.post('/api/ig-comments/rules', { keywords: [], dm_text: 'x' })).status).toBe(400);
    expect((await t.api.post('/api/ig-comments/rules', { keywords: ['a'], dm_text: 'x', workflow_id: 'nope' })).status).toBe(400);
    const p = (await t.api.patch(`/api/ig-comments/rules/${r.id}`, { enabled: false, keywords: ['guide', 'pdf'] })).data;
    expect(p).toMatchObject({ enabled: false, keywords: ['guide', 'pdf'], dm_text: 'Hier ist dein Guide!' });
    expect((await t.api.patch('/api/ig-comments/rules/unbekannt', { enabled: true })).status).toBe(404);
    expect((await t.api.del(`/api/ig-comments/rules/${r.id}`)).data).toEqual({ ok: true });
    expect((await t.api.del(`/api/ig-comments/rules/${r.id}`)).status).toBe(404);
  });

  it('tests a sample comment without sending anything', async () => {
    clearRules();
    await rule();
    await rule({ name: 'Nur Reel', keywords: ['guide'], scope: 'post', media_id: '17900001', dm_text: 'Reel-Guide' });
    const before = calls.length;
    const hit = (await t.api.post('/api/ig-comments/test', { text: 'Guide bitte', media_id: '17900001' })).data;
    // the rule for one post beats the rule for all posts
    expect(hit).toMatchObject({ match: true, rule: { name: 'Nur Reel' }, keyword: 'guide', dm: { text: 'Reel-Guide' } });
    expect((await t.api.post('/api/ig-comments/test', { text: 'Guide bitte', media_id: '17900002' })).data.rule.name).toBe('Guide');
    expect((await t.api.post('/api/ig-comments/test', { text: 'nichts' })).data).toEqual({ match: false });
    expect((await t.api.post('/api/ig-comments/test', { text: 'guide', platform: 'facebook' })).data).toEqual({ match: false });
    expect(calls.length).toBe(before);
  });

  it('shows the setup status and never the tokens', async () => {
    const s = (await t.api.get('/api/ig-comments/status')).data;
    expect(s.instagram).toMatchObject({ configured: true, account_id: '4444' });
    expect(s.facebook).toMatchObject({ configured: true, page_id: '3333' });
    expect(s.webhook_url).toBe(`http://localhost/hooks/meta/${loc}`);
    expect(s.permissions.instagram).toEqual(expect.arrayContaining(['instagram_manage_comments', 'instagram_manage_messages']));
    expect(s.webhook_fields.instagram).toContain('comments');
    expect(s.policy.length).toBeGreaterThan(3);
    expect(JSON.stringify(s)).not.toContain(PAGE_TOKEN);
  });

  it('lists recent posts for the picker', async () => {
    const ig = (await t.api.get('/api/ig-comments/media?platform=instagram')).data;
    expect(ig).toEqual([{ id: '17900001', label: 'Mein neuer Guide mit Zeilenumbruch', type: 'VIDEO', url: 'https://instagram.com/reel/abc', at: '2026-10-01T10:00:00+0000' }]);
    expect((await t.api.get('/api/ig-comments/media?platform=facebook')).data[0]).toMatchObject({ id: '3333_900', label: 'Neuer Beitrag' });
  });

  it('subscribes the page to feed and the account to comments, and reports a failing field', async () => {
    const r = (await t.api.post('/api/ig-comments/subscribe')).data.results;
    expect(r.facebook.ok).toBe(true);
    expect(r.instagram.ok).toBe(true);
    const fb = callsTo((c) => c.path === '3333/subscribed_apps').at(-1)!;
    expect(fb.url).toContain('feed');
    expect(fb.url).toContain('messages'); // the existing message fields stay subscribed
    failIg = true;
    const bad = (await t.api.post('/api/ig-comments/subscribe')).data.results;
    failIg = false;
    expect(bad.facebook.ok).toBe(true);
    expect(bad.instagram.ok).toBe(false);
    expect(bad.instagram.error).toContain('Meta-App');
    expect(t.app.db.get(`SELECT 1 AS x FROM audit_log WHERE location_id = ? AND action = 'igcomments.subscribe'`, loc)).toBeTruthy();
  });
});

describe('comment-to-DM: instagram comments', () => {
  it('replies publicly, sends the private reply once, creates the contact and tags it', async () => {
    clearRules();
    const r = await rule({ public_replies: ['Check deine DMs!', 'Schau in dein Postfach 📬'], tags: ['lead-magnet'], buttons: [{ type: 'reply', title: 'Mehr Tipps', value: 'tipps' }] });
    calls.length = 0;
    matched.length = 0;
    const res = await hook(igComment('c100', 'Guide bitte 🙏'));
    expect(res.status).toBe(200);
    const pr = privateReplies();
    expect(pr).toHaveLength(1);
    expect(pr[0].body.recipient).toEqual({ comment_id: 'c100' });
    expect(pr[0].body.message.attachment.payload).toMatchObject({ template_type: 'button', text: 'Hier ist dein Guide!', buttons: [{ type: 'web_url', url: 'https://example.com/guide.pdf', title: 'Guide laden' }, { type: 'postback', title: 'Mehr Tipps', payload: 'tipps' }] });
    const pub = callsTo((c) => c.path === 'c100/replies');
    expect(pub).toHaveLength(1);
    expect(pub[0].body).toEqual({ message: 'Check deine DMs!' });
    const ev = t.app.db.get<any>('SELECT * FROM igc_events WHERE comment_id = ?', 'c100');
    expect(ev).toMatchObject({ status: 'done', dm_status: 'sent', public_status: 'sent', keyword: 'guide', rule_id: r.id, from_username: 'lena.insta' });
    // contact with @username, tag and the DM in the conversation
    const c = (await t.api.get(`/api/contacts/${ev.contact_id}`)).data;
    expect(c.tags).toEqual(expect.arrayContaining(['lead-magnet', 'instagram']));
    expect(c.custom.instagram).toBe('@lena.insta');
    const out = t.app.db.get<any>(`SELECT * FROM messages WHERE contact_id = ? AND direction = 'out'`, ev.contact_id);
    expect(out).toMatchObject({ channel: 'instagram', source: 'Kommentar-zu-DM', status: 'sent', external_id: 'ig:m_pr1' });
    expect(out.body).toContain('Hier ist dein Guide!');
    expect(out.body).toContain('[Guide laden → https://example.com/guide.pdf]');
    // the person is known under both ids, so their answer lands on the same contact
    expect(t.app.db.get<any>(`SELECT contact_id FROM meta_identities WHERE location_id = ? AND channel = 'instagram' AND external_id = '6661'`, loc).contact_id).toBe(ev.contact_id);
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatchObject({ ruleId: r.id, platform: 'instagram', keyword: 'guide', dm_sent: true, public_reply_sent: true, text: 'Guide bitte 🙏' });
    // stats on the rule
    expect((await t.api.get('/api/ig-comments/rules')).data[0].stats).toMatchObject({ matches: 1, dms: 1, replies: 1 });
  });

  it('handles every comment once, even when Meta delivers it twice', async () => {
    calls.length = 0;
    await hook(igComment('c100', 'Guide bitte 🙏'));
    await hook(igComment('c100', 'Guide bitte 🙏'));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM igc_events WHERE comment_id = ?', 'c100').n).toBe(1);
  });

  it('rotates the public replies and sends the lead magnet to each person only once', async () => {
    calls.length = 0;
    await hook(igComment('c101', 'guide', '6662', '17900001', 'anna'));
    expect(callsTo((c) => c.path === 'c101/replies')[0].body.message).toBe('Schau in dein Postfach 📬');
    // same person, new comment: public answer yes, a second lead magnet no
    calls.length = 0;
    await hook(igComment('c102', 'guide nochmal', '6661'));
    expect(privateReplies()).toHaveLength(0);
    expect(callsTo((c) => c.path === 'c102/replies')[0].body.message).toBe('Check deine DMs!');
    expect(t.app.db.get<any>('SELECT dm_status, status FROM igc_events WHERE comment_id = ?', 'c102')).toMatchObject({ dm_status: 'skipped', status: 'done' });
  });

  it('ignores what does not match, own comments, replies to comments and comments for other accounts', async () => {
    calls.length = 0;
    await hook(igComment('c110', 'tolles Video'));
    await hook(igComment('c111', 'guide', '4444', '17900001', 'meinkonto'));
    await hook(igComment('c112', 'guide', '6661', '17900001', 'lena.insta', 'c100'));
    const other = igComment('c113', 'guide');
    other.entry[0].id = '9999';
    await hook(other);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM igc_events WHERE comment_id IN ('c110', 'c111', 'c112', 'c113')`).n).toBe(0);
  });

  it('refuses an unsigned or wrongly signed webhook', async () => {
    const raw = JSON.stringify(igComment('c120', 'guide'));
    expect((await t.api.raw(`/hooks/meta/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })).status).toBe(401);
    expect((await hook(igComment('c120', 'guide'), { secret: 'ein-falsches-secret-0000000000000' })).status).toBe(401);
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM igc_events WHERE comment_id = ?', 'c120').n).toBe(0);
  });

  it('keeps the contact and the other steps when one Graph call fails', async () => {
    clearRules();
    await rule({ public_replies: ['Danke!'], tags: ['x-fail'] });
    failPublic = true;
    calls.length = 0;
    await hook(igComment('c130', 'guide', '6670', '17900001', 'tom'));
    failPublic = false;
    const ev = t.app.db.get<any>('SELECT * FROM igc_events WHERE comment_id = ?', 'c130');
    expect(ev).toMatchObject({ status: 'done', dm_status: 'sent', public_status: 'failed' });
    expect(ev.error).toContain('Antwort: ');
    expect((await t.api.get(`/api/contacts/${ev.contact_id}`)).data.tags).toContain('x-fail');
    // Meta refuses a second private reply for one comment: the event shows it as a failure
    privateReplied.add('c131');
    await hook(igComment('c131', 'guide', '6671', '17900001', 'tim'));
    const f = t.app.db.get<any>('SELECT * FROM igc_events WHERE comment_id = ?', 'c131');
    expect(f).toMatchObject({ dm_status: 'failed', public_status: 'sent', status: 'done' });
    expect(f.error).toContain('DM: ');
    expect(f.contact_id).toBeTruthy();
    // both failing: failed
    privateReplied.add('c132');
    failPublic = true;
    await hook(igComment('c132', 'guide', '6672', '17900001', 'tam'));
    failPublic = false;
    expect(t.app.db.get<any>('SELECT status FROM igc_events WHERE comment_id = ?', 'c132').status).toBe('failed');
    const evs = (await t.api.get('/api/ig-comments/events?status=failed')).data;
    expect(evs.map((e: any) => e.comment_id)).toContain('c132');
    expect(evs[0].rule_name).toBe('Guide');
  });

  it('limits the answers per rule and hour', async () => {
    clearRules();
    const r = await rule({ max_per_hour: 2 });
    calls.length = 0;
    for (const n of [1, 2, 3]) await hook(igComment(`c14${n}`, 'guide', `668${n}`));
    expect(privateReplies()).toHaveLength(2);
    const third = t.app.db.get<any>('SELECT * FROM igc_events WHERE comment_id = ?', 'c143');
    expect(third.status).toBe('rate_limited');
    expect(third.error).toContain('2 pro Stunde');
    expect((await t.api.get('/api/ig-comments/rules')).data.find((x: any) => x.id === r.id).stats.matches).toBe(3);
  });

  it('caps private replies per account', async () => {
    clearRules();
    await rule({ max_per_hour: 700 });
    for (let i = 0; i < 200; i++) t.app.db.run(`INSERT INTO igc_events (id, location_id, platform, kind, comment_id, status, dm_status, created_at) VALUES (?, ?, 'instagram', 'comment', ?, 'done', 'sent', ?)`, `cap${i}`, loc, `cap${i}`, new Date().toISOString());
    calls.length = 0;
    await hook(igComment('c150', 'guide', '6690'));
    expect(privateReplies()).toHaveLength(0);
    expect(t.app.db.get<any>('SELECT error FROM igc_events WHERE comment_id = ?', 'c150').error).toContain('Konto');
    t.app.db.run(`DELETE FROM igc_events WHERE id LIKE 'cap%'`);
  });

  it('answers any comment on a rule for "any"', async () => {
    clearRules();
    await rule({ match_mode: 'any', keywords: [], name: 'Alles', dm_text: 'Danke fürs Kommentieren!', link_url: '' });
    calls.length = 0;
    await hook(igComment('c160', '🔥🔥', '6695'));
    expect(privateReplies()[0].body.message).toEqual({ text: 'Danke fürs Kommentieren!' });
  });

  it('starts the workflow of the rule and the matching trigger workflows', async () => {
    clearRules();
    const wf = (await t.api.post('/api/workflows', { name: 'Nach Kommentar', trigger: { type: 'igcomment.matched', config: {} }, steps: [{ type: 'add_tag', tags: ['kommentar-flow'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const wf2 = (await t.api.post('/api/workflows', { name: 'Nur andere Regel', trigger: { type: 'igcomment.matched', config: { rule_id: 'andere' } }, steps: [{ type: 'add_tag', tags: ['falsch'] }] })).data;
    await t.api.patch(`/api/workflows/${wf2.id}`, { status: 'active' });
    const wf3 = (await t.api.post('/api/workflows', { name: 'Regel-Vorlage', trigger: { type: 'contact.tag_added', config: { tag: 'nie' } }, steps: [{ type: 'add_tag', tags: ['regel-flow'] }] })).data;
    await t.api.patch(`/api/workflows/${wf3.id}`, { status: 'active' });
    await rule({ workflow_id: wf3.id });
    await hook(igComment('c170', 'guide', '6700', '17900001', 'flow'));
    await settle();
    const cid = t.app.db.get<any>('SELECT contact_id FROM igc_events WHERE comment_id = ?', 'c170').contact_id;
    const tags = (await t.api.get(`/api/contacts/${cid}`)).data.tags;
    expect(tags).toContain('regel-flow');
    expect(tags).toContain('kommentar-flow');
    expect(tags).not.toContain('falsch');
    // a rule can only point at its own workflows
    expect((await t.api.post('/api/ig-comments/rules', { keywords: ['a'], dm_text: 'x', workflow_id: 'fremd' })).status).toBe(400);
  });
});

describe('comment-to-DM: facebook comments', () => {
  it('replies under the comment and sends the private reply through the page', async () => {
    clearRules();
    await rule({ platform: 'facebook', public_replies: ['Link kommt per Nachricht!'], link_url: 'https://example.com/fb' });
    calls.length = 0;
    await hook(fbComment('fbc1', 'Guide bitte'));
    expect(privateReplies()[0].body.recipient).toEqual({ comment_id: 'fbc1' });
    expect(callsTo((c) => c.path === 'fbc1/comments')[0].body).toEqual({ message: 'Link kommt per Nachricht!' });
    const ev = t.app.db.get<any>('SELECT * FROM igc_events WHERE comment_id = ?', 'fbc1');
    expect(ev).toMatchObject({ platform: 'facebook', dm_status: 'sent', public_status: 'sent', from_name: 'Max Muster' });
    const c = (await t.api.get(`/api/contacts/${ev.contact_id}`)).data;
    expect(c).toMatchObject({ first_name: 'Max', last_name: 'Muster' });
    expect(c.tags).toContain('messenger');
    expect(t.app.db.get<any>(`SELECT channel FROM messages WHERE contact_id = ? AND direction = 'out'`, ev.contact_id).channel).toBe('messenger');
    // an Instagram-only rule does not touch Facebook comments
    clearRules();
    await rule();
    calls.length = 0;
    await hook(fbComment('fbc2', 'Guide bitte'));
    expect(privateReplies()).toHaveLength(0);
  });
});

describe('comment-to-DM: story replies', () => {
  const storyReply = (mid: string, text: string, from = '6661') => ({
    object: 'instagram',
    entry: [{ id: '4444', time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: '4444' }, timestamp: Date.now(), message: { mid, text, reply_to: { story: { id: 'story_1', url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/x' } } } }] }],
  });

  it('answers a story reply with a keyword through the open 24-hour window', async () => {
    clearRules();
    const r = await rule({ kind: 'story_reply', keywords: ['rabatt'], dm_text: 'Dein Rabattcode: STORY10', link_url: '', tags: ['story-lead'] });
    calls.length = 0;
    matched.length = 0;
    const res = await (await hook(storyReply('ig_ST1', 'Ich will Rabatt!', '6661'))).json();
    expect(res.messages).toBe(1);
    await settle();
    const sent = callsTo((c) => c.path === 'me/messages');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ recipient: { id: '6661' }, message: { text: 'Dein Rabattcode: STORY10' } });
    const ev = t.app.db.get<any>(`SELECT * FROM igc_events WHERE kind = 'story_reply'`);
    expect(ev).toMatchObject({ status: 'done', dm_status: 'sent', rule_id: r.id, keyword: 'rabatt', media_id: 'story_1', text: 'Ich will Rabatt!' });
    expect((await t.api.get(`/api/contacts/${ev.contact_id}`)).data.tags).toContain('story-lead');
    expect(matched[0]).toMatchObject({ kind: 'story_reply', keyword: 'rabatt', dm_sent: true });
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM igc_story_pending').n).toBe(0);
    // the same delivery again changes nothing
    calls.length = 0;
    await hook(storyReply('ig_ST1', 'Ich will Rabatt!', '6661'));
    await settle();
    expect(callsTo((c) => c.path === 'me/messages')).toHaveLength(0);
  });

  it('leaves a story reply without the keyword alone, and plain messages too', async () => {
    calls.length = 0;
    await hook(storyReply('ig_ST2', 'Schönes Foto', '6663'));
    await hook({ object: 'instagram', entry: [{ id: '4444', messaging: [{ sender: { id: '6664' }, recipient: { id: '4444' }, timestamp: Date.now(), message: { mid: 'ig_PLAIN', text: 'rabatt' } }] }] });
    await settle();
    expect(callsTo((c) => c.path === 'me/messages')).toHaveLength(0);
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM igc_story_pending').n).toBe(0);
  });
});

describe('comment-to-DM: workflow action with buttons', () => {
  const run = () => ({ location_id: loc, contact_id: contactId, workflow_id: 'w' }) as any;
  let contactId = '';

  it('sends Instagram quick replies and button templates inside the window', async () => {
    contactId = (await hook({ object: 'instagram', entry: [{ id: '4444', messaging: [{ sender: { id: '6661' }, recipient: { id: '4444' }, timestamp: Date.now(), message: { mid: 'ig_B1', text: 'hallo' } }] }] }).then(() => t.app.db.get<any>(`SELECT contact_id FROM meta_identities WHERE external_id = '6661' AND channel = 'instagram'`).contact_id)) as string;
    const act = t.app.services.workflowActions.meta_buttons_send;
    calls.length = 0;
    const res = await act(run(), { channel: 'instagram', text: 'Hallo {{contact.first_name}}, was interessiert dich?', buttons: [{ type: 'reply', title: 'Anfänger', value: 'anfaenger' }, { type: 'reply', title: 'Profi', value: 'profi' }] }, { contact: { first_name: 'Lena' }, event: {} });
    expect(String(res.result ?? res)).toContain('2 Buttons');
    expect(callsTo((c) => c.path === 'me/messages').at(-1)!.body).toMatchObject({ recipient: { id: '6661' }, message: { text: 'Hallo Lena, was interessiert dich?', quick_replies: [{ title: 'Anfänger', payload: 'anfaenger' }, { title: 'Profi', payload: 'profi' }] } });
    await act(run(), { channel: 'instagram', text: 'Hier', buttons: [{ type: 'url', title: 'Öffnen', value: 'https://example.com' }] }, { event: {} });
    expect(callsTo((c) => c.path === 'me/messages').at(-1)!.body.message.attachment.payload.buttons[0]).toMatchObject({ type: 'web_url', url: 'https://example.com' });
    expect(t.app.db.get<any>(`SELECT body FROM messages WHERE contact_id = ? AND direction = 'out' ORDER BY created_at DESC, rowid DESC LIMIT 1`, contactId).body).toContain('[Öffnen → https://example.com]');
  });

  it('refuses unusable buttons before anything is sent', async () => {
    const act = t.app.services.workflowActions.meta_buttons_send;
    calls.length = 0;
    await expect(act(run(), { channel: 'instagram', text: 'x', buttons: [] }, { event: {} })).rejects.toThrow('Mindestens ein Button');
    await expect(act(run(), { channel: 'instagram', text: '', buttons: [{ type: 'reply', title: 'A' }] }, { event: {} })).rejects.toThrow();
    await expect(act(run(), { channel: 'whatsapp', text: 'x', buttons: [{ type: 'url', title: 'A', value: 'https://a.de' }, { type: 'reply', title: 'B' }] }, { event: {} })).rejects.toThrow(/nicht gemischt/);
    await expect(act(run(), { channel: 'instagram', text: 'x', buttons: [{ type: 'url', title: 'A', value: 'http://a.de' }] }, { event: {} })).rejects.toThrow(/https/);
    expect(callsTo((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('is in the workflow catalogue together with the trigger', async () => {
    const cat = (await t.api.get('/api/workflow-catalog')).data;
    expect(cat.actions.map((a: any) => a.type)).toContain('meta_buttons_send');
    expect(cat.triggers.map((x: any) => x.type)).toContain('igcomment.matched');
  });
});

describe('comment-to-DM: MCP, permissions and isolation', () => {
  const mcp = async (args: any, key: string) => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_ig_comment_rules', arguments: args } }) });
    const j: any = await r.json();
    const text = j.result?.content?.[0]?.text ?? '';
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: !!j.result?.isError, text, data };
  };

  it('manages rules through the MCP tool', async () => {
    clearRules();
    const key = (await t.api.post('/api/api-keys', { name: 'IG-Test' })).data.key;
    const made = await mcp({ location_id: loc, action: 'create', rule: { keywords: ['guide'], dm_text: 'Hi', name: 'Per MCP' } }, key);
    expect(made.data).toMatchObject({ name: 'Per MCP', keywords: ['guide'] });
    expect((await mcp({ location_id: loc }, key)).data).toHaveLength(1);
    expect((await mcp({ location_id: loc, action: 'test', text: 'Guide!' }, key)).data).toMatchObject({ match: true, keyword: 'guide' });
    expect((await mcp({ location_id: loc, action: 'update', rule_id: made.data.id, rule: { enabled: false } }, key)).data.enabled).toBe(false);
    expect(Array.isArray((await mcp({ location_id: loc, action: 'events' }, key)).data)).toBe(true);
    expect((await mcp({ location_id: loc, action: 'delete', rule_id: made.data.id }, key)).data).toEqual({ ok: true });
    expect((await mcp({ location_id: loc, action: 'bogus' }, key)).isError).toBe(true);
  });

  it('is part of the social permission area', async () => {
    const { requiredPermission } = await import('../server/core/permissions.js');
    expect(requiredPermission('GET', '/api/ig-comments/rules')).toBe('social');
    expect(requiredPermission('POST', '/api/ig-comments/subscribe')).toBe('social');
  });
});
