import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

const calls: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
let respond: (url: string, body: any) => { status: number; json: any } = () => ({ status: 201, json: { number: 7, html_url: 'https://github.com/acme/website/issues/7' } });
const fake = (async (url: string, init: any = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body });
  const r = respond(String(url), body);
  return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz';
let t: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.githubFetch = fake;
  await t.setup();
});
afterAll(() => t.close());

describe('GitHub for Codex', () => {
  it('stores the token sealed and checks repository access', async () => {
    expect((await t.api.put('/api/github-codex/settings', { token: 'nope' })).status).toBe(400);
    expect((await t.api.put('/api/github-codex/settings', { default_repo: 'kein repo' })).status).toBe(400);
    const r = await t.api.put('/api/github-codex/settings', { token: TOKEN, default_repo: 'https://github.com/acme/website.git' });
    expect(r.data).toEqual({ token_set: true, token_hint: '…wxyz', default_repo: 'acme/website' });
    expect(JSON.stringify(t.app.db.all('SELECT * FROM github_codex_settings'))).not.toContain(TOKEN);
    respond = () => ({ status: 200, json: { full_name: 'acme/website', private: true, has_issues: true } });
    expect((await t.api.post('/api/github-codex/test', {})).data).toEqual({ ok: true, repo: 'acme/website', private: true });
    expect(calls.at(-1)).toMatchObject({ url: 'https://api.github.com/repos/acme/website', headers: { authorization: `Bearer ${TOKEN}` } });
    respond = () => ({ status: 404, json: { message: 'Not Found' } });
    expect((await t.api.post('/api/github-codex/test', { repo: 'acme/geheim' })).data.error).toContain('nicht gefunden');
  });

  it('the workflow action creates an issue with the context and an @codex line', async () => {
    respond = () => ({ status: 201, json: { number: 7, html_url: 'https://github.com/acme/website/issues/7' } });
    calls.length = 0;
    const wf = (
      await t.api.post('/api/workflows', {
        name: 'Bug an Codex',
        trigger: { type: 'contact.tag_added', config: { tag: 'bug' } },
        steps: [{ type: 'github_issue', title: 'Fehler gemeldet von {{contact.first_name}}', body: 'Kundin meldet: Formular lädt nicht.', prompt: 'Bitte den Fehler im Kontaktformular finden und beheben.', labels: 'bug, kunde' }],
      })
    ).data;
    expect(wf.id).toBeTruthy();
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const c = (await t.api.post('/api/contacts', { first_name: 'Erika', email: 'erika@kunde.example', tags: ['bug'] })).data;
    await t.app.events.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/repos/acme/website/issues', method: 'POST' });
    expect(calls[0].body.title).toBe('Fehler gemeldet von Erika');
    expect(calls[0].body.labels).toEqual(['bug', 'kunde']);
    expect(calls[0].body.body).toContain('Kundin meldet: Formular lädt nicht.');
    expect(calls[0].body.body).toContain('erika@kunde.example');
    expect(calls[0].body.body).toMatch(/\n\n@codex Bitte den Fehler im Kontaktformular finden und beheben\.$/);
    const acts = (await t.api.get(`/api/contacts/${c.id}`)).data.activities ?? [];
    expect(JSON.stringify(acts)).toContain('acme/website#7');
    expect((await t.api.get('/api/workflows/meta')).data.steps).toContain('github_issue');
  });
});
