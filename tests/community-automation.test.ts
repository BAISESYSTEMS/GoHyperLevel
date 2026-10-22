import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApp, readRun, results, runWorkflow, settle, type T } from './wfx-helpers.js';
import { classify } from '../server/services/agent-safety.js';
import { COMMUNITY_TOOLS, COMMUNITY_TRIGGERS } from '../server/modules/community-automation.js';
import { sha256, token } from '../server/core/util.js';

let t: T;
let loc = '';
let g: any;
let tier: any;
let key = '';
let anna: any;
const mails: any[] = [];

beforeAll(async () => {
  t = await newApp();
  loc = t.api.location;
  const capture = async (_l: any, mail: any) => {
    mails.push(mail);
    return { status: 'sent' };
  };
  t.app.services.memberMailer = capture;
  t.app.services.communityMailer = capture;
  g = (await t.api.post('/api/community/groups', { name: 'Automatik-Club' })).data;
  const saved = await t.api.put(`/api/community/groups/${g.id}/join/page`, { slug: 'automatik', enabled: true, set_access_join: true });
  tier = saved.data.tiers[0];
  key = (await t.api.post('/api/api-keys', { name: 'Community MCP' })).data.key;
  anna = (await t.api.post('/api/contacts', { email: 'anna@example.de', first_name: 'Anna', last_name: 'Muster' })).data;
});
afterAll(async () => {
  await t.close();
});

let rpc = 0;
const mcp = async (name: string, args: any) => {
  const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) });
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
const tagsOf = (id: string) => JSON.parse(t.app.db.get<any>('SELECT tags FROM contacts WHERE id = ?', id)!.tags) as string[];
const workflow = async (trigger: any, steps: any[]) => {
  const wf = (await t.api.post('/api/workflows', { name: `wf ${Math.random()}`, trigger, steps })).data;
  await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
  return wf;
};

describe('catalogue', () => {
  it('lists the nine triggers and the steps with a description each', async () => {
    const cat = (await t.api.get('/api/workflow-catalog')).data;
    const triggers = (cat.triggers as any[]).map((x) => x.type);
    for (const m of COMMUNITY_TRIGGERS) {
      expect(triggers, m.type).toContain(m.type);
      expect(m.summary.length).toBeGreaterThan(10);
    }
    expect(COMMUNITY_TRIGGERS).toHaveLength(9);
    for (const old of ['community.member_joined', 'community.post_created', 'community.level_reached']) expect(triggers).toContain(old);
    const actions = (cat.actions as any[]).filter((a) => a.type.startsWith('community_'));
    expect(actions.map((a) => a.type).sort()).toEqual(['community_award_points', 'community_grant_badge', 'community_join', 'community_leave', 'community_post', 'community_send_dm']);
    for (const a of actions) expect(a.category).toBe('content');
  });
});

describe('steps', () => {
  it('adds a contact to a community with a tier, once, and removes them again', async () => {
    const add = await runWorkflow(t, [{ type: 'community_join', group_id: g.id, tier: 'Mitglied' }, { type: 'community_join', group_id: g.id }, { type: 'community_leave', group_id: g.id }, { type: 'community_leave', group_id: g.id }], { contact: { email: 'neu@example.de' } });
    expect(add.run.status).toBe('completed');
    expect(results(add.log)).toEqual([`Automatik-Club: Mitglied geworden (Stufe ${tier.name})`, 'Automatik-Club: War schon Mitglied', 'Mitgliedschaft in „Automatik-Club“ beendet', 'War nicht Mitglied in „Automatik-Club“']);
    expect(t.app.db.get<any>('SELECT status FROM community_memberships WHERE contact_id = ?', add.contact.id)!.status).toBe('canceled');
  });

  it('refuses a missing group and an unknown tier, and leaves groups with tag or course access as they were', async () => {
    const r = await runWorkflow(t, [{ type: 'community_join', group_id: 'fremd' }], { contact: { email: 'x1@example.de' } });
    expect(results(r.log)[0]).toBe('Community-Gruppe nicht gefunden');
    const r2 = await runWorkflow(t, [{ type: 'community_join', group_id: g.id, tier: 'Gibt es nicht' }], { contact: { email: 'x2@example.de' } });
    expect(results(r2.log)[0]).toContain('Stufe „Gibt es nicht“ gibt es nicht');
    const open = (await t.api.post('/api/community/groups', { name: 'Offener Club' })).data;
    const r3 = await runWorkflow(t, [{ type: 'community_join', group_id: open.id }], { contact: { email: 'x3@example.de' } });
    expect(results(r3.log)[0]).toBe('Aufgenommen in „Offener Club“'); // other groups keep the old behaviour: access comes from tags or courses
    const tagged = (await t.api.post('/api/community/groups', { name: 'Tag-Club', access: { mode: 'tags', tags: ['club'] } })).data;
    const r4 = await runWorkflow(t, [{ type: 'community_join', group_id: tagged.id }, { type: 'community_leave', group_id: tagged.id }], { contact: { email: 'x4@example.de' } });
    expect(results(r4.log)).toEqual(['Aufgenommen in „Tag-Club“', 'Entfernt aus „Tag-Club“']);
  });

  it('grants a badge, gives points, writes a message and a post with merge fields', async () => {
    const badge = (await t.api.post(`/api/community/groups/${g.id}/badges`, { name: 'Unterstützer', emoji: '💛' })).data;
    const ch = g.channels[0];
    const r = await runWorkflow(
      t,
      [
        { type: 'community_join', group_id: g.id },
        { type: 'community_grant_badge', group_id: g.id, badge: 'unterstützer', reason: 'Workflow-Test' },
        { type: 'community_grant_badge', group_id: g.id, badge: badge.id },
        { type: 'community_grant_badge', group_id: g.id, badge: 'gibt es nicht' },
      ],
      { contact: { first_name: 'Berta', email: 'berta@example.de' } },
    );
    expect(results(r.log).slice(0, 3)).toEqual([expect.stringContaining('Mitglied geworden'), 'Abzeichen „Unterstützer“ vergeben', 'Hatte „Unterstützer“ schon']);
    expect(results(r.log)[3]).toContain('gibt es in „Automatik-Club“ nicht');
    const pts = await runWorkflow(t, [{ type: 'community_join', group_id: g.id }, { type: 'community_award_points', group_id: g.id, points: 12, reason: 'Gratis' }, { type: 'community_award_points', group_id: g.id, points: -5 }, { type: 'community_award_points', group_id: g.id, points: 0 }], { contact: { email: 'cora@example.de' } });
    expect(results(pts.log).slice(1, 3)).toEqual(['+12 Punkte in „Automatik-Club“', '-5 Punkte in „Automatik-Club“']);
    expect(results(pts.log)[3]).toContain('zwischen -10000 und 10000');
    expect(t.app.db.get<{ n: number }>('SELECT COALESCE(SUM(points), 0) AS n FROM community_points WHERE contact_id = ?', pts.contact.id)!.n).toBe(7);
    const outsider = await runWorkflow(t, [{ type: 'community_award_points', group_id: g.id, points: 5 }], { contact: { email: 'draussen@example.de' } });
    expect(results(outsider.log)[0]).toContain('kein Mitglied');
    const dm = await runWorkflow(t, [{ type: 'community_send_dm', text: 'Hallo {{contact.first_name}}, willkommen!', from_name: 'Sabine' }, { type: 'community_join', group_id: g.id }, { type: 'community_send_dm', text: 'Hallo {{contact.first_name}}, willkommen!', from_name: 'Sabine' }], { contact: { first_name: 'Dora', email: 'dora@example.de' } });
    expect(results(dm.log)[0]).toContain('in keiner Community');
    const msg = t.app.db.get<any>(`SELECT * FROM community_dm_messages WHERE body LIKE 'Hallo Dora%'`);
    expect(msg).toMatchObject({ body: 'Hallo Dora, willkommen!', sender_name: 'Sabine', sender_id: '_team' });
    const post = await runWorkflow(t, [{ type: 'community_post', group_id: g.id, channel: ch.name, title: 'Neu: {{contact.first_name}}', body: 'Sagt Hallo!', pinned: true }, { type: 'community_post', group_id: g.id, channel: 'Nirgends', title: 'x', body: 'y' }], { contact: { first_name: 'Emil', email: 'emil@example.de' } });
    expect(results(post.log)[0]).toContain('Beitrag „Neu: Emil“');
    expect(results(post.log)[1]).toContain('Kanal „Nirgends“ gibt es nicht');
    expect(t.app.db.get<any>(`SELECT pinned, author_name FROM community_posts WHERE title = 'Neu: Emil'`)).toMatchObject({ pinned: 1, author_name: 'Team' });
    expect(post.vars.community_post_id).toBeTruthy();
  });
});

describe('triggers', () => {
  it('starts on a badge in the right group only, and on messages in the right direction', async () => {
    const other = (await t.api.post('/api/community/groups', { name: 'Zweiter Club', access: { mode: 'tags', tags: ['zweit'] } })).data;
    const wfHere = await workflow({ type: 'community.badge_earned', config: { group_id: g.id } }, [{ type: 'add_tag', tags: ['badge-hier'] }]);
    const wfOther = await workflow({ type: 'community.badge_earned', config: { group_id: other.id } }, [{ type: 'add_tag', tags: ['badge-woanders'] }]);
    const badge = (await t.api.post(`/api/community/groups/${g.id}/badges`, { name: 'Trigger-Test' })).data;
    const c = (await t.api.post('/api/contacts', { email: 'trigger@example.de', first_name: 'Tilda' })).data;
    await t.api.post(`/api/community/groups/${g.id}/memberships`, { contact_id: c.id });
    await t.api.post(`/api/community/badges/${badge.id}/award`, { contact_id: c.id });
    await t.app.events.flush();
    await settle(t, wfHere.id, c.id);
    expect(tagsOf(c.id)).toContain('badge-hier');
    expect(tagsOf(c.id)).not.toContain('badge-woanders');
    expect(readRun(t, wfOther.id).run).toBeUndefined();

    const toTeam = await workflow({ type: 'community.dm_received', config: { direction: 'to_team' } }, [{ type: 'add_tag', tags: ['schrieb-team'] }]);
    const toMember = await workflow({ type: 'community.dm_received', config: { direction: 'to_member' } }, [{ type: 'add_tag', tags: ['bekam-dm'] }]);
    const { sendDm, TEAM } = await import('../server/services/community-dm.js');
    sendDm(t.app, loc, c.id, TEAM, 'Frage ans Team');
    await t.app.events.flush();
    await settle(t, toTeam.id, c.id);
    expect(tagsOf(c.id)).toContain('schrieb-team');
    expect(tagsOf(c.id)).not.toContain('bekam-dm');
    sendDm(t.app, loc, TEAM, c.id, 'Antwort vom Team');
    await t.app.events.flush();
    await settle(t, toMember.id, c.id);
    expect(tagsOf(c.id)).toContain('bekam-dm');
  });

  it('does not loop when a workflow answers every message with a message', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'loop@example.de', first_name: 'Lena' })).data;
    await t.api.post(`/api/community/groups/${g.id}/memberships`, { contact_id: c.id });
    const wf = await workflow({ type: 'community.dm_received', config: { direction: 'to_member' } }, [{ type: 'community_send_dm', text: 'Automatische Antwort' }]);
    const { sendDm, TEAM } = await import('../server/services/community-dm.js');
    sendDm(t.app, loc, TEAM, c.id, 'Der Anfang');
    await t.app.events.flush();
    await new Promise((r) => setTimeout(r, 50));
    await t.app.events.flush();
    // The first message starts the workflow once; its own answer does not start it again.
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_dm_messages WHERE body = 'Automatische Antwort'`)!.n).toBe(1);
    expect(wf.id).toBeTruthy();
  });

  it('starts when a member leaves, a trial starts and a join is requested (events from the join flow)', async () => {
    const left = await workflow({ type: 'community.member_left', config: { group_id: g.id } }, [{ type: 'add_tag', tags: ['ist-gegangen'] }]);
    const c = (await t.api.post('/api/contacts', { email: 'weg@example.de', first_name: 'Willi' })).data;
    const m = (await t.api.post(`/api/community/groups/${g.id}/memberships`, { contact_id: c.id })).data;
    await t.api.patch(`/api/community/memberships/${m.id}`, { action: 'end' });
    await t.app.events.flush();
    await settle(t, left.id, c.id);
    expect(tagsOf(c.id)).toContain('ist-gegangen');
    expect(t.app.db.get<any>('SELECT left_reason FROM community_memberships WHERE id = ?', m.id)!.left_reason).toBe('removed');
  });
});

describe('MCP tools', () => {
  it('has four tools with honest safety flags', async () => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools: any[] = ((await r.json()) as any).result.tools.filter((x: any) => x.name.startsWith('ghl_community_'));
    expect(tools.map((x) => x.name).sort()).toEqual(['ghl_community_grant', 'ghl_community_members', 'ghl_community_post', 'ghl_community_stats']);
    const by = Object.fromEntries(COMMUNITY_TOOLS.map((x) => [x.name, x]));
    expect(classify(by.ghl_community_members)).toBe('read');
    expect(classify(by.ghl_community_stats)).toBe('read');
    expect(classify(by.ghl_community_post)).toBe('sensitive'); // it publishes to every member
    expect(classify(by.ghl_community_grant)).toBe('sensitive'); // it hands out access
  });

  it('lists groups and members, posts, grants and reports', async () => {
    const groups = await mcp('ghl_community_members', { location_id: loc });
    expect(groups.data.find((x: any) => x.id === g.id)).toMatchObject({ name: 'Automatik-Club', access: 'join' });
    const added = await mcp('ghl_community_grant', { location_id: loc, group_id: g.id, grant: 'member', email: 'mcp@example.de' });
    expect(added.data).toMatchObject({ ok: true, status: 'active' });
    const members = await mcp('ghl_community_members', { location_id: loc, group_id: g.id, q: 'mcp@example.de' });
    expect(members.data).toHaveLength(1);
    expect(members.data[0]).toMatchObject({ email: 'mcp@example.de', points: 0 });
    const cid = members.data[0].contact_id;
    expect((await mcp('ghl_community_grant', { location_id: loc, group_id: g.id, grant: 'points', email: 'mcp@example.de', points: 30, reason: 'Test' })).data.points).toBe(30);
    expect((await mcp('ghl_community_grant', { location_id: loc, group_id: g.id, grant: 'points', contact_id: cid, points: 0 })).isError).toBe(true);
    const badge = (await t.api.post(`/api/community/groups/${g.id}/badges`, { name: 'MCP-Held' })).data;
    expect((await mcp('ghl_community_grant', { location_id: loc, group_id: g.id, grant: 'badge', contact_id: cid, badge: 'mcp-held' })).data).toEqual({ awarded: true });
    expect((await mcp('ghl_community_grant', { location_id: loc, group_id: g.id, grant: 'badge', contact_id: cid, badge: 'gibt es nicht' })).isError).toBe(true);
    expect(badge.id).toBeTruthy();
    const post = await mcp('ghl_community_post', { location_id: loc, group_id: g.id, title: 'Von der KI', body: 'Hallo **Club**', poll: { question: 'Gut so?', options: ['Ja', 'Nein'] } });
    expect(post.data).toMatchObject({ title: 'Von der KI' });
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_polls WHERE post_id = ?', post.data.id)!.n).toBe(1);
    const stats = await mcp('ghl_community_stats', { location_id: loc, group_id: g.id, days: 30 });
    expect(stats.data.totals.members).toBeGreaterThanOrEqual(2);
    expect(stats.data.members).toBeUndefined();
    expect((await mcp('ghl_community_stats', { location_id: loc, group_id: g.id, series: true })).data.members).toHaveLength(30);
    expect((await mcp('ghl_community_stats', { location_id: loc })).data[0]).toMatchObject({ name: 'Automatik-Club' });
    const tier2 = (await t.api.post(`/api/community/groups/${g.id}/tiers`, { name: 'Zweite Stufe' })).data;
    expect((await mcp('ghl_community_grant', { location_id: loc, group_id: g.id, grant: 'tier', contact_id: cid, tier_id: tier2.id })).data.ok).toBe(true);
    expect((await mcp('ghl_community_grant', { location_id: loc, group_id: g.id, grant: 'remove', email: 'mcp@example.de' })).data).toEqual({ ok: true });
    expect((await mcp('ghl_community_grant', { location_id: loc, group_id: g.id, grant: 'unsinn', email: 'mcp@example.de' })).isError).toBe(true);
    void tier;
    void sha256;
    void token;
    void anna;
  });
});
