import type { Module } from '../core/app.js';
import { HttpError, bad, str } from '../core/http.js';
import { render } from '../core/template.js';
import { now } from '../core/util.js';
import { contactName, getContact, logActivity } from '../services/contacts.js';
import { openSecret, sealSecret } from './mail-sync.js';

/**
 * Workflow action "GitHub-Issue für Codex anlegen": creates an issue in a repository of the sub-account's
 * choice with the contact's context and a line `@codex …`, so Codex cloud (with the Codex GitHub
 * integration enabled on that repository) picks it up as a task. The GitHub token is sealed per
 * sub-account and never sent back to the browser. Test hook: `app.services.githubFetch`.
 */

const API = 'https://api.github.com';
const TOKEN_RE = /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/;
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export const githubCodexModule: Module = {
  name: 'github-codex',
  migrations: [
    [
      '001-init',
      `CREATE TABLE github_codex_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        token TEXT, default_repo TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
      );`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const gh = (url: string, init: RequestInit) => ((app.services.githubFetch as typeof fetch | undefined) ?? fetch)(url, init);
    const load = (locId: string) => db.get<{ token: string | null; default_repo: string }>('SELECT token, default_repo FROM github_codex_settings WHERE location_id = ?', locId) ?? { token: null, default_repo: '' };
    const tokenOf = (locId: string) => {
      const s = load(locId).token;
      if (!s) return null;
      try {
        return openSecret(app, s);
      } catch {
        return null;
      }
    };
    const headers = (tok: string) => ({ authorization: `Bearer ${tok}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'HyperLevel-CRM', 'content-type': 'application/json' });
    const repoOf = (v: unknown, fallback = '') => {
      const r = str(v, 'Repository', { max: 201 }).replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '') || fallback;
      if (r && !REPO_RE.test(r)) throw bad('Repository bitte als besitzer/name angeben, z. B. acme/website');
      return r;
    };
    const ghError = (status: number, msg: string) =>
      status === 401 ? 'GitHub-Token ist ungültig oder abgelaufen.' : status === 403 ? `GitHub verweigert den Zugriff (Rechte des Tokens: Issues lesen & schreiben?)${msg ? `: ${msg}` : ''}` : status === 404 ? 'Repository nicht gefunden – oder der Token darf es nicht sehen.' : status === 410 ? 'In diesem Repository sind Issues ausgeschaltet.' : `Fehler von GitHub (${status})${msg ? `: ${msg}` : ''}`;

    const out = (locId: string) => {
      const s = load(locId);
      const tok = tokenOf(locId);
      return { token_set: !!s.token, token_hint: tok ? `…${tok.slice(-4)}` : s.token ? '(nicht lesbar – bitte neu eintragen)' : '', default_repo: s.default_repo };
    };
    router.get('/api/github-codex/settings', 'location', (ctx) => out(ctx.locationId));
    router.put('/api/github-codex/settings', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const cur = load(ctx.locationId);
      let sealed = cur.token;
      if (b.token === null) sealed = null;
      else if (b.token) {
        const t = str(b.token, 'Token', { max: 300 });
        if (!TOKEN_RE.test(t)) throw bad('Das sieht nicht nach einem GitHub-Token aus (github_pat_… oder ghp_…).');
        sealed = sealSecret(app, t);
      }
      const repo = b.default_repo !== undefined ? repoOf(b.default_repo) : cur.default_repo;
      db.run(
        `INSERT INTO github_codex_settings (location_id, token, default_repo, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(location_id) DO UPDATE SET token = excluded.token, default_repo = excluded.default_repo, updated_at = excluded.updated_at`,
        ctx.locationId,
        sealed,
        repo,
        now(),
      );
      return out(ctx.locationId);
    });
    /** Checks token + repository (GET /repos/{repo}) – creates nothing. */
    router.post('/api/github-codex/test', 'location', async (ctx) => {
      const tok = tokenOf(ctx.locationId);
      if (!tok) throw bad('Bitte zuerst einen GitHub-Token speichern.');
      const repo = repoOf(ctx.body?.repo, load(ctx.locationId).default_repo);
      if (!repo) throw bad('Bitte ein Repository angeben.');
      let r: Response;
      try {
        r = await gh(`${API}/repos/${repo}`, { method: 'GET', headers: headers(tok), signal: AbortSignal.timeout(15_000) });
      } catch {
        throw new HttpError(504, 'GitHub ist nicht erreichbar.');
      }
      const data: any = await r.json().catch(() => null);
      if (!r.ok) throw new HttpError(502, ghError(r.status, String(data?.message ?? '')));
      if (data?.has_issues === false) throw new HttpError(502, ghError(410, ''));
      return { ok: true, repo: String(data?.full_name ?? repo), private: !!data?.private };
    });

    interface NewIssue {
      repo?: string;
      title: string;
      body?: string;
      /** The instruction line for the coding agent (after "@codex" / "@claude"). */
      prompt: string;
      labels?: string[];
      agent?: 'codex' | 'claude';
      /** Extra context block between the body and the instruction (e.g. the contact). */
      context?: string;
    }
    /** Creates an issue with the sub-account's token: shared by the workflow action and other modules (Werkstatt → Kernfeature). */
    const createIssue = async (locId: string, o: NewIssue): Promise<{ repo: string; number: number | string; url: string; title: string }> => {
      const tok = tokenOf(locId);
      if (!tok) throw new Error('Kein GitHub-Token (Einstellungen → KI-Werkzeuge → GitHub für Codex)');
      const repo = repoOf(o.repo ?? '', load(locId).default_repo);
      if (!repo) throw new Error('Repository fehlt');
      const title = String(o.title ?? '').trim().slice(0, 250);
      if (!title) throw new Error('Titel fehlt');
      const prompt = String(o.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
      if (!prompt) throw new Error('Auftrag an Codex fehlt');
      const handle = o.agent === 'claude' ? '@claude' : '@codex';
      const body = [String(o.body ?? '').trim(), o.context ?? '', `${handle} ${prompt}`].filter(Boolean).join('\n\n').slice(0, 60_000);
      const labels = (o.labels ?? []).map((l) => String(l).trim()).filter(Boolean).slice(0, 10);
      let r: Response;
      try {
        r = await gh(`${API}/repos/${repo}/issues`, { method: 'POST', headers: headers(tok), body: JSON.stringify({ title, body, ...(labels.length ? { labels } : {}) }), signal: AbortSignal.timeout(20_000) });
      } catch {
        throw new Error('GitHub ist nicht erreichbar');
      }
      const data: any = await r.json().catch(() => null);
      if (!r.ok) throw new Error(ghError(r.status, String(data?.message ?? '')));
      return { repo, number: data?.number ?? '?', url: String(data?.html_url ?? ''), title };
    };
    /** State of an issue and of pull requests that reference it (for status tracking). */
    const issueStatus = async (locId: string, repo: string, number: number): Promise<{ state: string; closed: boolean; prs: { number: number; url: string; state: string; merged: boolean }[] }> => {
      const tok = tokenOf(locId);
      if (!tok) throw new Error('Kein GitHub-Token');
      const r = repoOf(repo);
      const get = async (path: string) => {
        const res = await gh(`${API}/repos/${r}/${path}`, { method: 'GET', headers: headers(tok), signal: AbortSignal.timeout(15_000) });
        const data: any = await res.json().catch(() => null);
        if (!res.ok) throw new Error(ghError(res.status, String(data?.message ?? '')));
        return data;
      };
      const issue = await get(`issues/${number}`);
      const timeline: any[] = await get(`issues/${number}/timeline?per_page=100`).catch(() => []);
      const prs = (Array.isArray(timeline) ? timeline : [])
        .filter((e) => e?.event === 'cross-referenced' && e.source?.issue?.pull_request)
        .map((e) => ({ number: Number(e.source.issue.number), url: String(e.source.issue.html_url ?? ''), state: String(e.source.issue.state ?? ''), merged: !!e.source.issue.pull_request?.merged_at }));
      return { state: String(issue?.state ?? ''), closed: issue?.state === 'closed', prs };
    };
    app.services.githubIssues = { create: createIssue, status: issueStatus, hasToken: (locId: string) => !!tokenOf(locId), defaultRepo: (locId: string) => load(locId).default_repo };

    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      /** step: { repo?, title, body?, prompt, labels?, agent?: "codex"|"claude" } – all with merge fields. */
      github_issue: async (run: any, step: any, vars: Record<string, any>) => {
        const locId = run.location_id;
        const contact = run.contact_id ? getContact(app, locId, run.contact_id) : undefined;
        const context = contact ? [`**Kontakt:** ${contactName(contact)}${contact.email ? ` <${contact.email}>` : ''}`, contact.company ? `**Firma:** ${contact.company}` : '', `**CRM:** ${app.baseUrl()}/app/contacts/${contact.id}`].filter(Boolean).join('\n') : '';
        const labels = (Array.isArray(step.labels) ? step.labels : String(step.labels ?? '').split(',')).map((l: unknown) => String(l).trim()).filter(Boolean);
        const i = await createIssue(locId, { repo: render(String(step.repo ?? ''), vars).trim(), title: render(String(step.title ?? ''), vars), body: render(String(step.body ?? ''), vars), prompt: render(String(step.prompt ?? ''), vars), labels, agent: step.agent === 'claude' ? 'claude' : 'codex', context });
        if (contact) logActivity(app, locId, contact.id, 'github.issue', `GitHub-Issue für Codex angelegt: ${i.repo}#${i.number} ${i.title}`, { url: i.url });
        return `Issue ${i.repo}#${i.number} angelegt${i.url ? `: ${i.url}` : ''}`;
      },
    };
  },
};
