import { randomUUID } from 'node:crypto';
import type { SafeResponse } from '../server/services/net.js';

/**
 * A fake Cognee 1.6.2 server for the tests: the routes HyperLevel uses (auth, datasets, add, cognify, status, data, delete, search)
 * with the behaviour that matters – login with a JWT that expires, API keys, datasets owned by their user (403 for foreign ones),
 * identical content deduplicated per dataset, multipart parsing of /add, search over the stored text. Every request is recorded
 * (never the secrets). Plugged in as `app.services.cogneeFetch`.
 */

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  user: string;
  /** Parsed body: JSON object, or the multipart fields. */
  body: any;
  status: number;
}

interface Item {
  id: string;
  text: string;
  ref: string;
  label: string;
  hash: string;
}
interface Dataset {
  id: string;
  name: string;
  owner: string;
  items: Map<string, Item>;
  status: 'completed' | 'running' | 'errored' | 'none';
}

export interface FakeOptions {
  /** ENABLE_BACKEND_ACCESS_CONTROL: false = anonymous access works, search answers a bare list without dataset ids. */
  accessControl?: boolean;
  users?: Record<string, string>;
  apiKeys?: Record<string, string>;
  /** JWT lifetime in seconds (login → token). */
  jwtSeconds?: number;
  /** What cognify does: finish at once, stay running until `finishCognify()`, or fail. */
  cognify?: 'instant' | 'manual' | 'error';
  now?: () => number;
}

export function fakeCognee(o: FakeOptions = {}) {
  const accessControl = o.accessControl ?? true;
  const users: Record<string, string> = { 'gohigh@example.com': 'pw-gohigh', ...(o.users ?? {}) };
  const apiKeys: Record<string, string> = { 'key-gohigh': 'gohigh@example.com', ...(o.apiKeys ?? {}) };
  const clock = o.now ?? Date.now;
  const datasets = new Map<string, Dataset>();
  const tokens = new Map<string, { user: string; exp: number }>();
  const calls: Call[] = [];
  const failures: { re: RegExp; status: number; body: any; times: number; headers?: Record<string, string> }[] = [];
  let cognifyMode = o.cognify ?? 'instant';
  let logins = 0;
  let offline = false;

  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const jwt = (user: string) => {
    const exp = Math.floor(clock() / 1000) + (o.jwtSeconds ?? 3600);
    const token = `${b64({ alg: 'HS256' })}.${b64({ sub: user, exp })}.${randomUUID().replace(/-/g, '')}`;
    tokens.set(token, { user, exp });
    return token;
  };

  const res = (status: number, body: unknown, headers: Record<string, string> = {}): SafeResponse => {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return { status, ok: status >= 200 && status < 300, headers, text: async () => text };
  };

  const parseMultipart = (body: string, contentType: string) => {
    const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? '';
    const fields: [string, string][] = [];
    for (const part of body.split(`--${boundary}`)) {
      const m = /^\r\nContent-Disposition: form-data; name="([^"]+)"\r\n\r\n([\s\S]*)\r\n$/.exec(part);
      if (m) fields.push([m[1], m[2]]);
    }
    return fields;
  };

  const userOf = (headers: Record<string, string>): string | null => {
    const key = headers['x-api-key'];
    if (key) return apiKeys[key] ?? null;
    const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1];
    const t = bearer ? tokens.get(bearer) : undefined;
    return t && t.exp * 1000 > clock() ? t.user : null;
  };

  const find = (id: string) => [...datasets.values()].find((d) => d.id === id);

  const handler = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<SafeResponse> => {
    if (offline) throw new Error('connect ECONNREFUSED');
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const path = u.pathname;
    const query = Object.fromEntries(u.searchParams);
    const ctype = headers['content-type'] ?? '';
    let body: any = undefined;
    if (init.body !== undefined) {
      if (ctype.startsWith('application/json')) body = JSON.parse(init.body);
      else if (ctype.startsWith('multipart/form-data')) body = parseMultipart(init.body, ctype);
      else if (ctype.startsWith('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(init.body));
    }
    let user = userOf(headers);
    const record = (status: number) => calls.push({ method, path, query, user: user ?? (path === '/health' || path.endsWith('/login') ? '' : 'anonymous'), body: path.endsWith('/login') ? undefined : body, status });
    const done = (r: SafeResponse) => (record(r.status), r);

    const fail = failures.find((f) => f.times > 0 && f.re.test(`${method} ${path}`));
    if (fail) {
      fail.times--;
      return done(res(fail.status, fail.body, fail.headers));
    }
    if (path === '/health') return done(res(200, { status: 'ready', health: 'healthy', version: '1.6.2' }));
    if (path === '/api/v1/auth/login' && method === 'POST') {
      logins++;
      const email = body?.username;
      if (!email || users[email] !== body?.password) return done(res(400, { detail: 'LOGIN_BAD_CREDENTIALS' }));
      user = email;
      return done(res(200, { access_token: jwt(email), token_type: 'bearer' }));
    }
    // Access control off: no login needed, everything runs as the default user.
    if (!user && !accessControl) user = 'default@example.com';
    if (!user) return done(res(401, { detail: 'Authentication required (auth posture: inherited from ENABLE_BACKEND_ACCESS_CONTROL). For single-user local use, set ENABLE_BACKEND_ACCESS_CONTROL=false and restart.' }));

    if (path === '/api/v1/auth/me') return done(res(200, { email: user }));
    if (path === '/api/v1/datasets' && method === 'GET') return done(res(200, [...datasets.values()].filter((d) => d.owner === user).map((d) => ({ id: d.id, name: d.name, createdAt: new Date().toISOString(), updatedAt: null, ownerId: d.owner }))));
    if (path === '/api/v1/datasets' && method === 'POST') {
      let d = [...datasets.values()].find((x) => x.owner === user && x.name === body?.name);
      if (!d) datasets.set((d = { id: randomUUID(), name: String(body?.name), owner: user!, items: new Map(), status: 'none' }).id, d);
      return done(res(200, { id: d.id, name: d.name, createdAt: new Date().toISOString(), updatedAt: null, ownerId: d.owner }));
    }
    if (path === '/api/v1/datasets/status') {
      const id = query.dataset;
      const d = find(id);
      if (!d || d.owner !== user) return done(res(403, { detail: 'No access' }));
      return done(res(200, { [id]: d.status === 'running' ? 'DATASET_PROCESSING_STARTED' : d.status === 'errored' ? 'DATASET_PROCESSING_ERRORED' : 'DATASET_PROCESSING_COMPLETED' }));
    }
    const dm0 = /^\/api\/v1\/datasets\/([^/]+)(?:\/(data)(?:\/([^/]+))?)?$/.exec(path);
    // …/data/count is the count, any other third segment a data id.
    const dm = dm0 && [dm0[0], dm0[1], dm0[2], dm0[3] === 'count' ? undefined : dm0[3], dm0[3] === 'count' ? 'count' : undefined];
    if (dm) {
      const d = find(dm[1]);
      if (method === 'DELETE' && !dm[2]) {
        if (!d) return done(res(404, { message: 'not found' }));
        if (d.owner !== user) return done(res(403, { detail: 'No access' }));
        datasets.delete(d.id);
        return done(res(200, null));
      }
      if (!d || d.owner !== user) return done(res(d ? 403 : 404, { detail: 'No access' }));
      if (method === 'DELETE' && dm[3]) {
        d.items.delete(dm[3]);
        return done(res(200, null));
      }
      if (method === 'GET' && dm[4]) return done(res(200, { count: d.items.size }));
      if (method === 'GET' && dm[2]) return done(res(200, [...d.items.values()].map((i) => ({ id: i.id, name: `text_${i.hash.slice(0, 8)}`, label: i.label, externalMetadata: { gh_ref: i.ref }, datasetId: d.id }))));
    }
    if (path === '/api/v1/add' && method === 'POST') {
      const f = new Map<string, string>(body);
      const d = find(f.get('datasetId') ?? '');
      if (!d) return done(res(404, { error: 'Dataset not found' }));
      if (d.owner !== user) return done(res(403, { error: 'No write permission' }));
      const text = f.get('raw_data') ?? '';
      if (/^(\/|file:\/\/|https?:\/\/)/.test(text)) return done(res(500, { error: 'would be read as a path or address' }));
      const hash = Buffer.from(text).toString('base64').slice(0, 24) + text.length;
      let item = [...d.items.values()].find((i) => i.text === text);
      if (!item) d.items.set((item = { id: randomUUID(), text, ref: JSON.parse(f.get('external_metadata') ?? '[{}]')[0]?.gh_ref ?? '', label: JSON.parse(f.get('labels') ?? '[""]')[0] ?? '', hash }).id, item);
      return done(res(200, { status: 'PipelineRunCompleted', pipeline_run_id: randomUUID(), dataset_id: d.id, dataset_name: d.name, payload: null, data_ingestion_info: [{ run_info: { status: 'PipelineRunCompleted' }, data_id: item.id }] }));
    }
    if (path === '/api/v1/cognify' && method === 'POST') {
      const out: Record<string, unknown> = {};
      for (const id of body?.datasetIds ?? []) {
        const d = find(id);
        if (!d || d.owner !== user) return done(res(403, { error: 'No access', detail: id }));
        if (cognifyMode === 'error') return done(res(500, { error: 'Pipeline run errored', detail: 'LLM key missing' }));
        d.status = cognifyMode === 'instant' ? 'completed' : 'running';
        out[id] = { status: 'PipelineRunStarted', dataset_id: id };
      }
      return done(res(200, out));
    }
    if (path === '/api/v1/search' && method === 'POST') {
      if (!accessControl) return done(res(200, [{ id: 'x', text: 'leaked without dataset', document_id: randomUUID(), score: 0.1 }]));
      const out: unknown[] = [];
      const words = String(body?.query ?? '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
      for (const id of body?.datasetIds ?? []) {
        const d = find(id);
        if (!d || d.owner !== user) return done(res(403, { detail: `No read permission on ${id}` }));
        if (body.searchType === 'GRAPH_COMPLETION') {
          out.push({ dataset_id: d.id, dataset_name: d.name, dataset_tenant_id: null, search_result: [`Antwort aus ${d.name}`] });
          continue;
        }
        const hits = [...d.items.values()].filter((i) => !words.length || words.some((w: string) => i.text.toLowerCase().includes(w)));
        out.push({
          dataset_id: d.id,
          dataset_name: d.name,
          dataset_tenant_id: null,
          search_result: hits.slice(0, body.topK ?? 10).map((i, n) => ({ id: randomUUID(), text: i.text, chunk_index: 0, chunk_size: i.text.length, cut_type: 'sentence_end', document_id: i.id, document_name: `text_${i.hash.slice(0, 8)}`, external_metadata: JSON.stringify({ gh_ref: i.ref }), score: 0.1 + n / 100 })),
        });
      }
      return done(res(200, out));
    }
    return done(res(404, { detail: 'Not Found' }));
  };

  return {
    fetch: handler,
    calls,
    datasets,
    /** Items of the dataset with this name (any owner). */
    items: (name: string) => [...(([...datasets.values()].find((d) => d.name === name)?.items) ?? new Map<string, Item>()).values()],
    dataset: (name: string, owner?: string) => [...datasets.values()].find((d) => d.name === name && (!owner || d.owner === owner)),
    logins: () => logins,
    /** Fails the next `times` requests matching "METHOD /path" (regex) with this status. */
    failNext: (re: RegExp, status: number, body: any = { detail: 'boom' }, times = 1, headers?: Record<string, string>) => void failures.push({ re, status, body, times, headers }),
    setCognify: (m: 'instant' | 'manual' | 'error') => void (cognifyMode = m),
    finishCognify: (status: 'completed' | 'errored' = 'completed') => void [...datasets.values()].forEach((d) => d.status === 'running' && (d.status = status)),
    setOffline: (v: boolean) => void (offline = v),
    /** Expires every issued token (the server restarted with a new secret). */
    expireTokens: () => tokens.clear(),
    users,
    apiKeys,
    reset: () => calls.splice(0, calls.length),
  };
}

export type FakeCognee = ReturnType<typeof fakeCognee>;
