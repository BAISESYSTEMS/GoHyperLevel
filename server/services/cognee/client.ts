import { createHash, randomBytes } from 'node:crypto';
import { safeFetch, type SafeResponse } from '../net.js';
import { datasetName, isUuid, ownedDataset, type CogneeType, type OwnedDataset } from './model.js';

/**
 * Cognee over its REST API (server to server, no MCP): plain fetch, no SDK. Every HTTP call HyperLevel makes to a Cognee
 * server lives in this file. Written against the Cognee 1.6.2 FastAPI routers (cognee/api/v1/**, see docs/cognee.md for
 * the endpoint list); the network is `safeFetch` unless a test sets `app.services.cogneeFetch`.
 *
 * Two layers:
 *  - CogneeClient: login (JWT bearer, renewed on 401) or API key (X-Api-Key), retries with backoff, 429 handling, pacing.
 *  - LocationClient: everything that touches data. It is bound to ONE sub-account and only works on datasets named
 *    `gh_<locationId>_<type>` of that sub-account – a dataset of another sub-account is refused before any request is made.
 */

export type CogneeFetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number; allowPrivate?: boolean; secretHeaders?: string[] }) => Promise<SafeResponse>;

export class CogneeError extends Error {
  constructor(
    message: string,
    /** Status HyperLevel answers with. */
    public status = 502,
    /** Status Cognee answered with (0 = no answer). */
    public upstream = 0,
    /** Worth trying again later (network, 5xx, 429). */
    public retryable = false,
    public retryAfterMs = 0,
  ) {
    super(message);
  }
}

const clip = (s: unknown, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Cognee error bodies: `{detail: "…"}`, `{detail: [{msg}]}`, `{error, detail}` or `{message}`. */
export function detailOf(body: any): string {
  if (!body || typeof body !== 'object') return clip(body);
  const d = body.detail ?? body.error ?? body.message;
  if (Array.isArray(d)) return clip(d.map((x: any) => x?.msg ?? x).join('; '));
  if (d && typeof d === 'object') return clip(JSON.stringify(d));
  // `{error: "Pipeline run errored", detail: "…"}` (the routers that answer 4xx/5xx themselves): both parts.
  if (typeof body.error === 'string' && typeof body.detail === 'string' && body.error !== body.detail) return `${clip(body.error, 80)}: ${clip(body.detail, 140)}`;
  return clip(d);
}

export function errorFor(status: number, body: any, what = ''): CogneeError {
  const detail = detailOf(body);
  const tail = detail ? `: ${detail}` : '';
  switch (status) {
    case 400:
      if (/LOGIN_BAD_CREDENTIALS/.test(detail)) return new CogneeError('E-Mail oder Passwort bei Cognee stimmen nicht.', 502, status);
      return new CogneeError(`Cognee hat die Anfrage abgelehnt${tail}`, 502, status);
    case 401:
      return new CogneeError('Cognee lehnt die Anmeldung ab – Zugangsdaten prüfen.', 502, status);
    case 402:
      return new CogneeError('Das Token-Budget des Cognee-Servers ist aufgebraucht.', 502, status, true);
    case 403:
      return new CogneeError('Cognee verweigert den Zugriff – dem Cognee-Nutzer fehlen Rechte auf das Dataset.', 502, status);
    case 404:
      return new CogneeError(`Bei Cognee nicht gefunden${what ? ` (${what})` : ''}.`, 502, status);
    case 409:
      return new CogneeError(`Cognee meldet einen Konflikt${tail}`, 502, status);
    case 422:
      return new CogneeError(`Cognee hat die Daten abgelehnt${tail}`, 502, status);
    case 429:
      return new CogneeError('Cognee ist ausgelastet (zu viele Anfragen) – später erneut.', 429, status, true);
    default:
      return status >= 500 ? new CogneeError(`Cognee hat gerade ein Problem (${status})${tail}`, 502, status, true) : new CogneeError(`Fehler von Cognee (${status})${tail}`, 502, status);
  }
}

// --- multipart ----------------------------------------------------------------------------------------------------------

/** multipart/form-data with text fields only (everything HyperLevel sends is text) – FastAPI's `Form(...)` fields. */
export function multipart(fields: [string, string][]): { body: string; contentType: string } {
  const boundary = `----gohigh${randomBytes(12).toString('hex')}`;
  let body = '';
  for (const [name, value] of fields) body += `--${boundary}\r\nContent-Disposition: form-data; name="${name.replace(/["\r\n]/g, '')}"\r\n\r\n${value}\r\n`;
  body += `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

// --- login tokens -----------------------------------------------------------------------------------------------------

interface Token {
  token: string;
  /** Epoch ms after which a new login is made (the JWT's exp minus a minute). */
  until: number;
}
/** Per account, in memory only (never stored): a restart simply logs in again. */
const TOKENS = new Map<string, Token>();
const LAST_CALL = new Map<string, number>();

export const clearTokens = () => TOKENS.clear();

function jwtExpiry(jwt: string): number | null {
  try {
    const p = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof p.exp === 'number' ? p.exp * 1000 : null;
  } catch {
    return null;
  }
}

export interface ClientOptions {
  baseUrl: string;
  /** The agency ticked "internal network" for this server. */
  allowPrivate: boolean;
  mode: 'password' | 'api_key';
  email: string;
  /** Password or API key. */
  secret: string;
  fetch?: CogneeFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Minimum gap between two calls to the same server (ms). */
  minGapMs?: number;
  /** Tries per call for network errors, 429 and 5xx. */
  retries?: number;
}

interface Call {
  json?: unknown;
  form?: Record<string, string>;
  multipart?: [string, string][];
  /** 'none': no credentials (health, login, the open-server probe). */
  auth?: 'none' | 'default';
  timeoutMs?: number;
  /** Tolerate these statuses instead of throwing. */
  accept?: number[];
  /** Tries for network errors, 429 and 5xx (default: the client's). */
  retries?: number;
}
export interface Answer {
  status: number;
  data: any;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CogneeClient {
  private fetchImpl: CogneeFetch;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private minGap: number;
  private retries: number;
  private key: string;

  constructor(readonly o: ClientOptions) {
    this.fetchImpl = o.fetch ?? ((url, init) => safeFetch(url, init));
    this.sleep = o.sleep ?? defaultSleep;
    this.now = o.now ?? Date.now;
    this.minGap = o.minGapMs ?? 120;
    this.retries = o.retries ?? 2;
    this.key = createHash('sha256').update(`${o.baseUrl}\n${o.mode}\n${o.email}\n${o.secret}`).digest('hex').slice(0, 24);
  }

  private async pace() {
    if (this.minGap <= 0) return;
    const wait = this.minGap - (this.now() - (LAST_CALL.get(this.o.baseUrl) ?? 0));
    LAST_CALL.set(this.o.baseUrl, this.now() + Math.max(0, wait));
    if (wait > 0) await this.sleep(wait);
  }

  /** A valid bearer token, logging in when there is none. */
  private async token(force = false): Promise<string> {
    const cached = TOKENS.get(this.key);
    if (!force && cached && cached.until > this.now()) return cached.token;
    const r = await this.send('POST', '/api/v1/auth/login', { form: { username: this.o.email, password: this.o.secret }, auth: 'none', timeoutMs: 20_000 });
    const token = String(r.data?.access_token ?? '');
    if (!token) throw new CogneeError('Cognee hat beim Anmelden kein Token geliefert.', 502, r.status);
    TOKENS.set(this.key, { token, until: Math.min(jwtExpiry(token) ?? Infinity, this.now() + 3_600_000) - 60_000 });
    return token;
  }

  /** One HTTP exchange with retries for network errors, 429 and 5xx; errors become CogneeError. */
  private async send(method: string, path: string, c: Call = {}): Promise<Answer> {
    const url = `${this.o.baseUrl}${path}`;
    let body: string | undefined;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (c.multipart) {
      const m = multipart(c.multipart);
      body = m.body;
      headers['content-type'] = m.contentType;
    } else if (c.form) {
      body = new URLSearchParams(c.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (c.json !== undefined) {
      body = JSON.stringify(c.json);
      headers['content-type'] = 'application/json';
    }
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    let relogged = false;
    const retries = c.retries ?? this.retries;
    for (let attempt = 0; ; attempt++) {
      const h = { ...headers };
      if (c.auth !== 'none') {
        if (this.o.mode === 'api_key') h['x-api-key'] = this.o.secret;
        else h.authorization = `Bearer ${await this.token()}`;
      }
      await this.pace();
      let res: SafeResponse;
      try {
        // The API key never follows a redirect to another origin (safeFetch drops it there, like the Authorization header).
        res = await this.fetchImpl(url, { method, headers: h, body, timeoutMs: c.timeoutMs ?? 30_000, maxBytes: 8 * 1024 * 1024, allowPrivate: this.o.allowPrivate, secretHeaders: ['x-api-key'] });
      } catch (e) {
        const msg = (e as Error).message || 'Netzwerkfehler';
        if (attempt < retries) {
          await this.sleep(400 * 2 ** attempt);
          continue;
        }
        const hint = /intern|EPRIVATE/i.test(msg) ? ' – für einen Server im eigenen Netz „Internes Netz erlauben“ ankreuzen.' : '';
        throw new CogneeError(`Cognee ist nicht erreichbar: ${clip(msg, 140)}${hint}`, 502, 0, !/intern|EPRIVATE|Ungültige URL|Nur http/i.test(msg));
      }
      const text = await res.text();
      let data: any = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON (an HTML error page) */
      }
      // The token ran out (or the server restarted with a new secret): log in again once and repeat.
      if (res.status === 401 && c.auth !== 'none' && this.o.mode === 'password' && !relogged) {
        relogged = true;
        TOKENS.delete(this.key);
        await this.token(true);
        continue;
      }
      if (res.ok || c.accept?.includes(res.status)) return { status: res.status, data };
      const retryAfter = Math.min(Number(res.headers['retry-after']) * 1000 || 0, 300_000);
      if ((res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries && (retryAfter || 0) <= 30_000) {
        await this.sleep(retryAfter || 400 * 2 ** attempt);
        continue;
      }
      const err = errorFor(res.status, data, `${method} ${path.split('?')[0].replace(/[0-9a-f-]{32,36}/gi, ':id')}`);
      err.retryAfterMs = retryAfter;
      throw err;
    }
  }

  // --- server and account -------------------------------------------------------------------------------------------

  /** GET /health (cognee/api/v1/health): `{status: "ready", health, version}`, 503 when a component is down. */
  async health(): Promise<{ ok: boolean; version: string; detail: string }> {
    const r = await this.send('GET', '/health', { auth: 'none', timeoutMs: 15_000, accept: [503] });
    const ok = r.status === 200 && r.data?.status === 'ready';
    return { ok, version: String(r.data?.version ?? ''), detail: ok ? String(r.data?.health ?? 'healthy') : clip(r.data?.reason ?? r.data?.health ?? `Status ${r.status}`) };
  }

  /**
   * Is the server open to anybody? Without credentials `GET /api/v1/datasets` answers 401 when authentication is required
   * (ENABLE_BACKEND_ACCESS_CONTROL=true, the default) and 200 when it is not (access control off: every request runs as the
   * default user and all datasets share one graph). The 401 body names the posture ("auth posture: …").
   */
  async probeOpen(): Promise<{ state: 'closed' | 'open' | 'unknown'; reason: string }> {
    try {
      const r = await this.send('GET', '/api/v1/datasets', { auth: 'none', timeoutMs: 15_000, retries: 0, accept: [200, 401, 403] });
      if (r.status === 200) return { state: 'open', reason: 'Der Server beantwortet Anfragen ohne Anmeldung.' };
      const posture = /auth posture: ([^)]+)\)/.exec(detailOf(r.data))?.[1] ?? '';
      // Authentication was asked for explicitly, which does not say whether per-dataset isolation is on.
      if (/^explicit REQUIRE_AUTHENTICATION/i.test(posture)) return { state: 'unknown', reason: 'Anmeldung ist Pflicht, ob die Zugriffskontrolle je Dataset aktiv ist, lässt sich nicht erkennen.' };
      return { state: 'closed', reason: 'Der Server verlangt eine Anmeldung.' };
    } catch (e) {
      return { state: 'unknown', reason: (e as Error).message };
    }
  }

  /** GET /api/v1/auth/me → `{email}` – proves the credentials (password or API key) work. */
  async me(): Promise<{ email: string }> {
    const r = await this.send('GET', '/api/v1/auth/me');
    return { email: String(r.data?.email ?? '') };
  }

  /** GET /api/v1/datasets – the datasets this account may read. */
  async listDatasets(): Promise<{ id: string; name: string }[]> {
    const r = await this.send('GET', '/api/v1/datasets');
    return (Array.isArray(r.data) ? r.data : []).filter((d: any) => d && isUuid(d.id) && typeof d.name === 'string').map((d: any) => ({ id: String(d.id), name: String(d.name) }));
  }

  /** POST /api/v1/datasets {name}: creates the dataset or returns the existing one of that name. */
  async createDataset(name: string): Promise<{ id: string; name: string }> {
    const r = await this.send('POST', '/api/v1/datasets', { json: { name } });
    if (!isUuid(r.data?.id)) throw new CogneeError('Cognee hat das Dataset ohne Kennung zurückgegeben.', 502, r.status);
    return { id: String(r.data.id), name: String(r.data.name ?? name) };
  }

  // The data plane takes a dataset id from LocationClient only (which checked it belongs to the sub-account).

  /** POST /api/v1/add (multipart): one text document; answers with Cognee's data id. */
  async addText(datasetId: string, text: string, label: string, ref: string): Promise<string> {
    const fields: [string, string][] = [
      ['raw_data', text],
      ['datasetId', datasetId],
      ['labels', JSON.stringify([label])],
      ['external_metadata', JSON.stringify([{ gh_ref: ref }])],
      ['run_in_background', 'false'],
    ];
    const r = await this.send('POST', '/api/v1/add', { multipart: fields, timeoutMs: 120_000 });
    const info = r.data?.data_ingestion_info ?? r.data?.dataIngestionInfo;
    const first = Array.isArray(info) ? info.find((x: any) => x && (x.data_id ?? x.dataId)) : undefined;
    const id = first?.data_id ?? first?.dataId;
    if (isUuid(id)) return String(id);
    // The answer carried no id (an older server): find the item by the reference stored with it.
    const found = await this.findByRef(datasetId, ref);
    if (found) return found;
    throw new CogneeError('Cognee hat das Dokument angenommen, aber keine Kennung genannt.', 502, r.status);
  }

  /** GET /api/v1/datasets/{id}/data (paged): used only to find an item by its reference. */
  private async findByRef(datasetId: string, ref: string): Promise<string | null> {
    for (let offset = 0; offset < 2000; offset += 200) {
      const r = await this.send('GET', `/api/v1/datasets/${datasetId}/data?limit=200&offset=${offset}`);
      const list: any[] = Array.isArray(r.data) ? r.data : [];
      const hit = list.find((d) => (d.externalMetadata ?? d.external_metadata)?.gh_ref === ref);
      if (hit && isUuid(hit.id)) return String(hit.id);
      if (list.length < 200) break;
    }
    return null;
  }

  /** POST /api/v1/cognify {datasetIds, runInBackground}: builds the graph; in the background the run is polled with `status`. */
  async cognify(datasetId: string): Promise<void> {
    const r = await this.send('POST', '/api/v1/cognify', { json: { datasetIds: [datasetId], runInBackground: true }, timeoutMs: 60_000 });
    const runs = r.data && typeof r.data === 'object' ? Object.values(r.data) : [];
    const bad = runs.find((x: any) => /Errored/i.test(String(x?.status ?? '')));
    if (bad) throw new CogneeError(`Cognee konnte den Wissensgraphen nicht bauen${(bad as any).payload ? `: ${clip((bad as any).payload, 160)}` : '.'}`, 502, r.status);
  }

  /** GET /api/v1/datasets/status?dataset=<id>&pipeline=cognify_pipeline → `{<id>: "DATASET_PROCESSING_COMPLETED" | …}`. */
  async cognifyStatus(datasetId: string): Promise<'completed' | 'running' | 'errored' | 'unknown'> {
    const r = await this.send('GET', `/api/v1/datasets/status?dataset=${datasetId}&pipeline=cognify_pipeline`);
    const v = r.data?.[datasetId];
    const s = String(typeof v === 'object' && v ? (v.status ?? '') : (v ?? ''));
    if (/COMPLETED/i.test(s)) return 'completed';
    if (/ERRORED|FAILED/i.test(s)) return 'errored';
    if (/STARTED|INITIATED|PENDING|RUNNING/i.test(s)) return 'running';
    return 'unknown';
  }

  /** DELETE /api/v1/datasets/{dataset}/data/{data}: one data item with its graph and vectors (404 = already gone). */
  async deleteData(datasetId: string, dataId: string): Promise<void> {
    await this.send('DELETE', `/api/v1/datasets/${datasetId}/data/${dataId}`, { accept: [404] });
  }

  /** DELETE /api/v1/datasets/{dataset}: the dataset and everything in it (404 = already gone). */
  async deleteDataset(datasetId: string): Promise<void> {
    await this.send('DELETE', `/api/v1/datasets/${datasetId}`, { accept: [404] });
  }

  /** GET /api/v1/datasets/{dataset}/data/count. */
  async dataCount(datasetId: string): Promise<number> {
    const r = await this.send('GET', `/api/v1/datasets/${datasetId}/data/count`);
    return Number(r.data?.count ?? 0) || 0;
  }

  /** POST /api/v1/search: always with datasetIds (UUIDs); `CHUNKS` returns passages without an LLM call, `GRAPH_COMPLETION` an answer. */
  async search(datasetIds: string[], query: string, searchType: 'CHUNKS' | 'GRAPH_COMPLETION', topK: number, systemPrompt?: string): Promise<any[]> {
    const r = await this.send('POST', '/api/v1/search', {
      json: { searchType, datasetIds, query, topK, onlyContext: false, includeReferences: false, ...(systemPrompt ? { systemPrompt } : {}) },
      timeoutMs: searchType === 'CHUNKS' ? 45_000 : 120_000,
    });
    return Array.isArray(r.data) ? r.data : [];
  }
}

// --- bound to one sub-account -------------------------------------------------------------------------------------------

/**
 * The only way data reaches Cognee or comes back: bound to one sub-account. Dataset names are made here from the
 * sub-account's id (`datasetName`), ids are checked against the server's list by exact name, and a dataset object
 * of another sub-account is refused – before a request exists.
 */
export class LocationClient {
  private known = new Map<string, OwnedDataset>();
  /** The server's dataset list, read once per client (a cycle or a question), so a type does not cost a call of its own. */
  private listing: { id: string; name: string }[] | null = null;

  constructor(
    readonly locationId: string,
    readonly c: CogneeClient,
  ) {}

  private guard(ds: OwnedDataset): OwnedDataset {
    if (!ds || ds.locationId !== this.locationId || ds.name !== datasetName(this.locationId, ds.type) || !isUuid(ds.id)) {
      throw new CogneeError('Dataset gehört nicht zu diesem Sub-Account – Zugriff verweigert.', 403);
    }
    return ds;
  }

  /** The sub-account's dataset for a type: found by exact name, created when asked to. Null when it does not exist. */
  async dataset(type: CogneeType, create = false): Promise<OwnedDataset | null> {
    const name = datasetName(this.locationId, type);
    const hit = this.known.get(name);
    if (hit) return hit;
    const list = (this.listing ??= await this.c.listDatasets());
    const found = list.find((d) => d.name === name);
    const made = found ?? (create ? await this.c.createDataset(name) : null);
    if (!made) return null;
    if (!found) list.push(made);
    if (made.name !== name) throw new CogneeError('Cognee hat ein anderes Dataset als erwartet geliefert.', 502);
    const ds = ownedDataset(this.locationId, type, made.id);
    this.known.set(name, ds);
    return ds;
  }

  /** The dataset a stored id belongs to – only when the server confirms it carries this sub-account's name for that type. */
  async confirm(type: CogneeType, datasetId: string): Promise<OwnedDataset | null> {
    const ds = await this.dataset(type, false);
    return ds && ds.id.toLowerCase() === datasetId.toLowerCase() ? ds : null;
  }

  forget() {
    this.known.clear();
    this.listing = null;
  }

  async add(ds: OwnedDataset, text: string, ref: string) {
    return this.c.addText(this.guard(ds).id, text, ds.type, ref);
  }
  async cognify(ds: OwnedDataset) {
    return this.c.cognify(this.guard(ds).id);
  }
  async status(ds: OwnedDataset) {
    return this.c.cognifyStatus(this.guard(ds).id);
  }
  async deleteData(ds: OwnedDataset, dataId: string) {
    if (!isUuid(dataId)) throw new CogneeError('Ungültige Datenkennung.', 400);
    return this.c.deleteData(this.guard(ds).id, dataId);
  }
  async deleteDataset(ds: OwnedDataset) {
    const r = await this.c.deleteDataset(this.guard(ds).id);
    // Gone on the server: neither the remembered object nor the cached list may offer it again.
    this.known.delete(ds.name);
    if (this.listing) this.listing = this.listing.filter((d) => d.id.toLowerCase() !== ds.id.toLowerCase());
    return r;
  }
  async count(ds: OwnedDataset) {
    return this.c.dataCount(this.guard(ds).id);
  }

  /** Searches the given datasets (all of this sub-account) and returns the raw per-dataset answers. */
  async search(datasets: OwnedDataset[], query: string, mode: 'CHUNKS' | 'GRAPH_COMPLETION', topK: number, systemPrompt?: string) {
    return this.c.search(datasets.map((d) => this.guard(d).id), query, mode, topK, systemPrompt);
  }
}
