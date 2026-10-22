import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/**
 * Deleting a team member's login: what is private to the person goes with it (AI chats, own credentials for outside services,
 * login leftovers, own notifications, private views and reports, task assignee/watcher places); what the person did for the
 * team stays with the name on it.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(async () => t?.close());

const n = (sql: string, ...args: string[]) => Number(t.app.db.get<{ n: number }>(sql, ...args)!.n);

describe('deleting a login', () => {
  it('removes what is private to the person and keeps the team records', async () => {
    const uid = (await t.api.post('/api/users', { email: 'mia@example.com', password: 'passwort-m1', name: 'Mia', locations: [loc] })).data.id as string;
    const at = new Date().toISOString();
    const later = new Date(Date.now() + 36e5).toISOString();
    const db = t.app.db;
    const task = (await t.api.post('/api/tasks', { title: 'Angebot schreiben' })).data.id as string;
    const note = (await t.api.post(`/api/contacts/${(await t.api.post('/api/contacts', { email: 'kunde@example.com' })).data.id}/notes`, { body: 'Kunde will Rabatt' })).data.id as string;
    db.insert('agent_conversations', { id: 'miaconv', location_id: loc, user_id: uid, title: 'Mail an Kunde X', source: 'app', messages: JSON.stringify([{ role: 'user', content: 'Schreib Kunde X wegen seiner Schulden' }]), state: '{}', status: 'idle', created_at: at, updated_at: at });
    db.insert('agent_files', { id: 'miafile', location_id: loc, user_id: uid, name: 'liste.csv', mime: 'text/csv', size: 3, data: 'a,b', created_at: at });
    db.insert('agent_gpt_keys', { id: 'miakey', location_id: loc, user_id: uid, name: 'GPT', prefix: 'gha_x', key_hash: 'h', tools: '[]', created_at: at });
    db.insert('mcp_servers', { id: 'mcpsrv', location_id: loc, name: 'Notion', slug: 'notion', url: 'https://mcp.example.com', created_at: at, updated_at: at });
    db.insert('mcp_server_tokens', { id: 'miatok', server_id: 'mcpsrv', location_id: loc, user_id: uid, access_token: 'sealed', created_at: at, updated_at: at });
    db.insert('magic_links', { token_hash: 'mialink', email: 'mia@example.com', user_id: uid, kind: 'login', origin: 'http://localhost', next: '', ip: '', expires_at: later, created_at: at });
    db.insert('pm_notifications', { id: 'mianote', location_id: loc, user_id: uid, kind: 'assigned', title: 'Neue Aufgabe', created_at: at });
    db.insert('pm_assignees', { task_id: task, user_id: uid, created_at: at });
    db.insert('pm_watchers', { task_id: task, user_id: uid, created_at: at });
    db.insert('object_views', { id: 'miaview', location_id: loc, object_key: 'contact', user_id: uid, name: 'Meine', config: '{}', shared: 0, created_at: at, updated_at: at });
    db.insert('object_views', { id: 'teamview', location_id: loc, object_key: 'contact', user_id: uid, name: 'Für alle', config: '{}', shared: 1, created_at: at, updated_at: at });
    db.insert('report_dashboards', { id: 'miadash', location_id: loc, owner_id: uid, name: 'Privat', visibility: 'private', widgets: '[]', settings: '{}', created_at: at, updated_at: at });
    db.insert('report_dashboards', { id: 'teamdash', location_id: loc, owner_id: uid, name: 'Team', visibility: 'team', widgets: '[]', settings: '{}', created_at: at, updated_at: at });
    db.run('UPDATE notes SET user_id = ? WHERE id = ?', uid, note);

    expect((await t.api.del(`/api/users/${uid}`)).status).toBe(200);
    for (const table of ['agent_conversations', 'agent_files', 'agent_gpt_keys', 'mcp_server_tokens', 'magic_links', 'pm_notifications', 'pm_assignees', 'pm_watchers']) {
      expect(n(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, uid), table).toBe(0);
    }
    expect(t.app.db.all('SELECT id FROM object_views WHERE user_id = ?', uid)).toEqual([{ id: 'teamview' }]);
    expect(t.app.db.all('SELECT id FROM report_dashboards WHERE owner_id = ?', uid)).toEqual([{ id: 'teamdash' }]);
    // The team's records stay.
    expect(n('SELECT COUNT(*) AS n FROM notes WHERE id = ?', note)).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM tasks WHERE id = ?', task)).toBe(1);
  });
});
