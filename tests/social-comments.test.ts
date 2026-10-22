import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { signBody } from '../server/services/meta.js';
import { finishCommentReply, parseLinkedInComments, parseYouTubeThreads } from '../server/services/social-comments.js';
import type { AppEvent } from '../server/core/events.js';

/** Social comments as an inbox channel: Meta webhook (Facebook + Instagram), YouTube and LinkedIn through Nango, reply/hide/AI. */

const APP_SECRET = 'c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6'; // oss-check: allow (fake test secret)
const TOKEN = 'EAAGpagetok' + 'p'.repeat(40);
const graph: { method: string; path: string; body: any; token: string }[] = [];
const fakeMeta = async (input: string, init: RequestInit = {}) => {
  const u = new URL(String(input));
  const path = u.pathname.replace(/^\/v\d+\.\d+\//, '');
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const token = String((init.headers as any)?.authorization ?? '').replace('Bearer ', '');
  graph.push({ method: init.method ?? 'GET', path, body, token });
  const json = (d: any) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  if (path.endsWith('/replies') || path.endsWith('/comments')) return json({ id: `reply_${graph.length}` });
  return json({ success: true });
};

const nangoCalls: { integration: string; method: string; path: string; query?: any; headers?: any; body?: any }[] = [];
let ytComments: any[] = [];
const fakeNango = {
  connections: () => [
    { integration: 'yt-main', provider: 'youtube', status: 'active' },
    { integration: 'li-main', provider: 'linkedin', status: 'active' },
  ],
  request: async (_loc: string, input: any) => {
    nangoCalls.push(input);
    const ok = (data: any) => ({ ok: true, status: 200, data });
    if (input.path === '/youtube/v3/channels') return ok({ items: [{ id: 'UCmine', contentDetails: { relatedPlaylists: { uploads: 'UUmine' } } }] });
    if (input.path === '/youtube/v3/playlistItems') return ok({ items: [{ contentDetails: { videoId: 'vid1' } }] });
    if (input.path === '/youtube/v3/commentThreads') return ok({ items: ytComments });
    if (input.path === '/youtube/v3/comments' || input.path === '/youtube/v3/comments/setModerationStatus') return ok({ id: 'ytreply1' });
    if (input.path === '/rest/posts') return ok({ elements: [{ id: 'urn:li:share:77' }] });
    if (input.path.startsWith('/rest/socialActions/') && input.method === 'GET')
      return ok({ elements: [{ commentUrn: 'urn:li:comment:(urn:li:share:77,501)', actor: 'urn:li:person:abc', message: { text: 'Toller Beitrag!' }, created: { time: Date.now() }, object: 'urn:li:share:77' }] });
    if (input.path.startsWith('/rest/socialActions/')) return ok({ commentUrn: 'urn:li:comment:(urn:li:share:77,502)' });
    return { ok: false, status: 404, data: { message: 'unknown' } };
  },
};

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const events: AppEvent[] = [];
const hook = (payload: unknown) => {
  const raw = JSON.stringify(payload);
  return t.api.raw(`/hooks/meta/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(raw, APP_SECRET) }, body: raw });
};
const igComment = (id: string, from: string, text: string, username = 'lisa.lacht') => ({ object: 'instagram', entry: [{ id: '4040', time: Date.now(), changes: [{ field: 'comments', value: { id, text, from: { id: from, username }, media: { id: 'media1' } } }] }] });

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.metaFetch = fakeMeta;
  await t.setup();
  loc = t.api.location;
  t.app.services.nango = fakeNango;
  t.app.services.aiReady = () => null;
  t.app.services.aiRun = async (input: any) => ({ text: `„Danke dir, ${input.user.includes('Lisa') ? 'Lisa' : 'du'}! Schreib uns gern per DM.“`, model: 'fake' });
  t.app.events.on('*', (e) => void events.push(e));
  await t.api.put('/api/settings/meta', { app_secret: APP_SECRET, page_id: '3030', ig_account_id: '4040', page_token: TOKEN });
});
afterAll(async () => t?.close());

describe('parsers', () => {
  it('reads YouTube threads and LinkedIn comments, skipping the owner', () => {
    const yt = parseYouTubeThreads({ items: [{ id: 'th1', snippet: { videoId: 'v', topLevelComment: { id: 'c1', snippet: { authorDisplayName: 'Ben', authorChannelId: { value: 'UCben' }, textOriginal: 'Super Video', publishedAt: '2026-10-01T10:00:00Z' } } } }, { id: 'th2', snippet: { videoId: 'v', topLevelComment: { id: 'c2', snippet: { authorChannelId: { value: 'UCmine' }, textOriginal: 'Danke!' } } } }] }, 'UCmine');
    expect(yt).toHaveLength(1);
    expect(yt[0]).toMatchObject({ platform: 'youtube', commentId: 'c1', threadId: 'th1', authorName: 'Ben', permalink: 'https://www.youtube.com/watch?v=v&lc=c1' });
    const li = parseLinkedInComments({ elements: [{ commentUrn: 'urn:li:comment:1', actor: 'urn:li:organization:9', message: { text: 'unsere Antwort' } }, { commentUrn: 'urn:li:comment:2', actor: 'urn:li:person:x', message: { text: 'Frage?' } }] }, 'urn:li:organization:9', 'urn:li:share:1');
    expect(li.map((c) => c.commentId)).toEqual(['urn:li:comment:2']);
    expect(finishCommentReply('„Antwort: Danke!“', 'instagram')).toBe('Danke!');
    expect(finishCommentReply('x'.repeat(3000), 'linkedin')).toHaveLength(1250);
  });
});

describe('social comments inbox', () => {
  let commentId = '';
  it('puts an Instagram comment into the inbox as channel "comment" – once', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Kommentar', trigger: { type: 'social_comment.received', config: { platform: 'instagram' } }, steps: [{ type: 'add_tag', tags: ['kommentiert'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    expect((await hook(igComment('c100', '9001', 'Wie lange dauert so ein Umbau?'))).status).toBe(200);
    await hook(igComment('c100', '9001', 'Wie lange dauert so ein Umbau?'));
    // the account's own comment is not an inbox item
    await hook(igComment('c101', '4040', 'Danke euch!', 'malerei'));
    const rows = t.app.db.all('SELECT * FROM social_comments WHERE location_id = ?', loc);
    expect(rows).toHaveLength(1);
    commentId = rows[0].id;
    await t.app.events.flush();
    const msg = t.app.db.get('SELECT * FROM messages WHERE id = ?', rows[0].message_id);
    expect(msg).toMatchObject({ channel: 'comment', direction: 'in', body: 'Wie lange dauert so ein Umbau?', source: 'Instagram-Kommentar' });
    const contact = (await t.api.get(`/api/contacts/${msg.contact_id}`)).data;
    expect(contact).toMatchObject({ first_name: '@lisa.lacht' });
    expect(contact.tags).toEqual(expect.arrayContaining(['instagram-kommentar', 'kommentiert']));
    expect(t.app.db.get(`SELECT account_id FROM meta_identities WHERE external_id = '9001'`)).toEqual({ account_id: '4040' });
    expect(events.some((e) => e.type === 'message.inbound' && e.data.message?.channel === 'comment')).toBe(true);
    // the conversation shows the comment's actions
    const conv = (await t.api.get(`/api/conversations?channel=comment`)).data;
    expect(conv).toHaveLength(1);
    const thread = (await t.api.get(`/api/conversations/${conv[0].id}/messages`)).data;
    expect(thread.messages.find((m: any) => m.id === msg.id).comment).toMatchObject({ id: commentId, platform: 'instagram', can_hide: true, hidden: false, reply: null });
  });

  it('takes Facebook page comments from the feed', async () => {
    await hook({ object: 'page', entry: [{ id: '3030', time: Date.now(), changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: '3030_55_66', post_id: '3030_55', from: { id: '7007', name: 'Paul Post' }, message: 'Was kostet das?' } }] }] });
    expect(t.app.db.get(`SELECT platform, author_name, permalink FROM social_comments WHERE comment_id = '3030_55_66'`)).toEqual({ platform: 'facebook', author_name: 'Paul Post', permalink: 'https://www.facebook.com/3030_55_66' });
    const list = (await t.api.get('/api/social-comments?status=open')).data.comments;
    expect(list.map((c: any) => c.platform).sort()).toEqual(['facebook', 'instagram']);
  });

  it('suggests a reply with the AI, replies publicly with the page token and hides', async () => {
    const s = await t.api.post(`/api/social-comments/${commentId}/suggest`, {});
    expect(s.status, JSON.stringify(s.data)).toBe(200);
    expect(s.data.text).toBe('Danke dir, du! Schreib uns gern per DM.');
    const r = await t.api.post(`/api/social-comments/${commentId}/reply`, { text: 'Etwa zwei Wochen – schreib uns gern per DM!' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ reply: 'Etwa zwei Wochen – schreib uns gern per DM!', suggestion: null });
    expect(graph.at(-1)).toMatchObject({ method: 'POST', path: 'c100/replies', body: { message: 'Etwa zwei Wochen – schreib uns gern per DM!' }, token: TOKEN });
    const out = t.app.db.get(`SELECT * FROM messages WHERE channel = 'comment' AND direction = 'out'`);
    expect(out).toMatchObject({ status: 'sent', source: 'Antwort auf Instagram-Kommentar' });
    expect((await t.api.post(`/api/social-comments/${commentId}/hide`, { hidden: true })).data.hidden).toBe(true);
    expect(graph.at(-1)).toMatchObject({ path: 'c100', body: { hide: true } });
    const fb = t.app.db.get(`SELECT id FROM social_comments WHERE comment_id = '3030_55_66'`).id;
    await t.api.post(`/api/social-comments/${fb}/hide`, { hidden: true });
    expect(graph.at(-1)).toMatchObject({ path: '3030_55_66', body: { is_hidden: true } });
    await t.api.post(`/api/social-comments/${fb}/reply`, { text: 'Schick uns kurz eine Nachricht.' });
    expect(graph.at(-1)).toMatchObject({ path: '3030_55_66/comments' });
    expect((await t.api.post(`/api/social-comments/${fb}/reply`, { text: '' })).status).toBe(400);
  });

  it('polls YouTube and LinkedIn through Nango, only what came after switching on', async () => {
    expect((await t.api.put('/api/social-comments/settings', { linkedin: true })).status).toBe(400);
    expect((await t.api.put('/api/social-comments/settings', { linkedin_org: 'abc' })).status).toBe(400);
    const s = (await t.api.put('/api/social-comments/settings', { youtube: true, linkedin_org: '12345', linkedin: true })).data;
    expect(s).toMatchObject({ youtube: true, linkedin: true, linkedin_org: 'urn:li:organization:12345' });
    expect(s.sources.youtube.available).toBe(true);
    const later = new Date(Date.now() + 1000).toISOString();
    ytComments = [
      { id: 'thOld', snippet: { videoId: 'vid1', topLevelComment: { id: 'old', snippet: { authorDisplayName: 'Alt', authorChannelId: { value: 'UCalt' }, textOriginal: 'von gestern', publishedAt: '2020-01-01T00:00:00Z' } } } },
      { id: 'thNew', snippet: { videoId: 'vid1', topLevelComment: { id: 'new1', snippet: { authorDisplayName: 'Ben', authorChannelId: { value: 'UCben' }, textOriginal: 'Super Video!', publishedAt: later } } } },
    ];
    const r = (await t.api.post('/api/social-comments/poll')).data;
    expect(r.errors).toEqual([]);
    const yt = t.app.db.all(`SELECT comment_id FROM social_comments WHERE platform = 'youtube'`);
    expect(yt).toEqual([{ comment_id: 'new1' }]);
    expect(t.app.db.get(`SELECT author_name FROM social_comments WHERE platform = 'linkedin'`)).toEqual({ author_name: 'LinkedIn-Mitglied' });
    expect(nangoCalls.find((c) => c.path === '/rest/posts')!.headers).toMatchObject({ 'LinkedIn-Version': expect.any(String), 'X-Restli-Protocol-Version': '2.0.0' });
    const ytId = t.app.db.get(`SELECT id FROM social_comments WHERE comment_id = 'new1'`).id;
    await t.api.post(`/api/social-comments/${ytId}/reply`, { text: 'Danke, Ben!' });
    expect(nangoCalls.at(-1)).toMatchObject({ method: 'POST', path: '/youtube/v3/comments', query: { part: 'snippet' }, body: { snippet: { parentId: 'thNew', textOriginal: 'Danke, Ben!' } } });
    await t.api.post(`/api/social-comments/${ytId}/hide`, { hidden: true });
    expect(nangoCalls.at(-1)).toMatchObject({ path: '/youtube/v3/comments/setModerationStatus', query: { id: 'new1', moderationStatus: 'heldForReview' } });
    const liId = t.app.db.get(`SELECT id FROM social_comments WHERE platform = 'linkedin'`).id;
    expect((await t.api.post(`/api/social-comments/${liId}/hide`, {})).status).toBe(400);
    await t.api.post(`/api/social-comments/${liId}/reply`, { text: 'Danke!' });
    expect(nangoCalls.at(-1)).toMatchObject({ method: 'POST', path: `/rest/socialActions/${encodeURIComponent('urn:li:share:77')}/comments`, body: { actor: 'urn:li:organization:12345', parentComment: 'urn:li:comment:(urn:li:share:77,501)', message: { text: 'Danke!' } } });
    // a second poll adds nothing
    expect((await t.api.post('/api/social-comments/poll')).data.new).toBe(0);
  });
});
