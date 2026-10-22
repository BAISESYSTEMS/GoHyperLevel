import type { App, Module } from '../core/app.js';
import { HttpError, safeDecode } from '../core/http.js';
import { requiredPermission } from '../core/permissions.js';
import { agentForbidden } from '../services/agent-safety.js';
import { ROUTE_DOCS } from '../services/openapi.js';
import type { Tool } from './mcp.js';

/**
 * ghl_api (docs/ai-tools.md#ghl_api-every-app-function): every REST route of the app through one MCP tool, for what no
 * dedicated tool covers. The call goes through the caller's own relay (call.api), so the connection's scope applies unchanged – a
 * sub-account key stays in its sub-account, a read-only grant can only GET, members keep their areas. Never reachable through it:
 * sign-in, people, keys, tokens, passwords, 2FA, passkeys, sessions, OAuth grants and whole-database backups (MCP_API_DENY below,
 * plus the routes the in-app agent never calls).
 */

export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Routes that would let a connection sign in, mint or widen access, or take the whole database. Matched on the canonical path. */
export const MCP_API_DENY: RegExp[] = [
  /^\/api\/auth(\/|$)/, // sign-in, setup, magic links, passkey login, SSO
  /^\/api\/me(\/|$)/, // own password, 2FA, passkeys, sessions, identities
  /^\/api\/users(\/|$)/, // people, roles, 2FA/passkey resets, session revocation
  /^\/api\/(agency\/)?api-keys(\/|$)/, // sub-account and agency keys
  /^\/api\/(agency\/)?ai-tools\/keys(\/|$)/,
  /^\/api\/agent\/gpt-actions\/keys(\/|$)/,
  /^\/api\/(agency\/)?oauth(\/|$)/, // OAuth apps and connections
  /^\/api\/mcp-oauth(\/|$)/, // approving OAuth grants for MCP clients
  /\/oauth(\/|$)/, // connecting external MCP servers by OAuth
  /^\/api\/agency\/(login|sso)(\/|$)/, // agency sign-in settings, invites, SSO
  /^\/api\/admin\/(backups?|offsite-backup)(\/|$)/, // whole-database backups
  /^\/api\/(mobile|push|push-relay)(\/|$)/, // device pairing and push tokens
  /^\/api\/demo\/login$/,
  /^\/api\/cloud\/(team|console|cancel|export)(\/|$)/, // cloud team, operator console, cancelling, the tenant export
  /\/login-link$/, // sign-in links for portal members and affiliates
  /\/invites?(\/|$)/, // invitations into teams and groups
  /\/rotate-key$/,
  /\/secret$/,
  /^\/api\/phone\/token$/,
];

/**
 * The path as the router will see it: no scheme or host, dot segments resolved (as fetch does), repeated slashes folded (as the
 * router does), query kept. Throws a 400 for anything that is not a plain /api/ path or that hits MCP_API_DENY.
 */
export function apiPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'path fehlt');
  const s = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!s.startsWith('/api/') || s.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(s) || s.length > 2000) throw new HttpError(400, 'path muss mit /api/ beginnen (z. B. /api/contacts)');
  const u = new URL(s, 'http://relay.invalid');
  if (u.origin !== 'http://relay.invalid') throw new HttpError(400, 'path muss mit /api/ beginnen (z. B. /api/contacts)');
  const path = `/${u.pathname.split('/').filter(Boolean).join('/')}`;
  const decoded = `/${safeDecode(u.pathname).split('/').filter(Boolean).join('/')}`;
  if (!path.startsWith('/api/')) throw new HttpError(400, 'path muss mit /api/ beginnen (z. B. /api/contacts)');
  for (const p of [path, decoded, path.toLowerCase(), decoded.toLowerCase()]) {
    if (MCP_API_DENY.some((r) => r.test(p)) || agentForbidden(p)) throw new HttpError(403, 'Diese Route ist über ghl_api gesperrt (Anmeldung, Personen, Schlüssel, Tokens, Sitzungen, OAuth, Backups)');
  }
  return path + u.search;
}

export const API_TOOL: Tool = {
  name: 'ghl_api',
  title: 'Beliebige API-Route',
  description:
    'Ruft eine REST-Route der App auf (alles, wofür es kein eigenes Tool gibt; passende Routen findet ghl_api_routes). method GET|POST|PUT|PATCH|DELETE, path wie „/api/contacts?limit=5“, body als Objekt. Mit einem Agentur-Zugang bei Routen eines Sub-Accounts location_id angeben. Es gelten die Rechte der Verbindung (nur-lesen bleibt nur-lesen, ein Sub-Account-Schlüssel bleibt in seinem Sub-Account). Gesperrt: Anmeldung, Personen, Schlüssel, Tokens, Passwörter, 2FA, Passkeys, Sitzungen, OAuth-Freigaben und Datenbank-Backups. Schreibende Aufrufe wirken sofort und landen im Protokoll.',
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: [...API_METHODS] },
      path: { type: 'string', description: 'Beginnt mit /api/, Query-Parameter erlaubt' },
      location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects); mit einem Sub-Account-Zugang weglassen' },
      body: { type: 'object', description: 'JSON-Body für POST/PUT/PATCH' },
    },
    required: ['method', 'path'],
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  klassFor: (a) => (String(a.method).toUpperCase() === 'GET' ? 'read' : 'sensitive'),
  // any route: inbound messages, mails, form entries, booking notes – third-party text, so a call taints the agent run
  untrusted: true,
  run: async (call, a) => {
    const method = String(a.method).toUpperCase();
    if (!(API_METHODS as readonly string[]).includes(method)) throw new HttpError(400, `method muss eines von ${API_METHODS.join(', ')} sein`);
    const path = apiPath(a.path);
    const body = method === 'GET' || method === 'DELETE' ? undefined : (a.body ?? {});
    return call.api(method, path, { body, location: a.location_id ? String(a.location_id) : undefined });
  },
};

/** A route pattern ghl_api can call: behind a login (not public), under /api/ and not on the deny lists. */
export function apiReachable(method: string, pattern: string, auth: string): boolean {
  if (auth === 'public' || !pattern.startsWith('/api/')) return false;
  try {
    apiPath(pattern.replace(/:[A-Za-z_]+/g, 'x'));
    return true;
  } catch {
    return false;
  }
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);

/**
 * ghl_api_routes: which routes ghl_api can call – live from the router (every module, also future ones), with the short
 * description of the API reference where there is one and the area a login needs. Lets a model find "the route for X" instead
 * of guessing; the call itself still runs with the caller's rights.
 */
export function apiRoutesTool(app: App): Tool {
  let summaries: Map<string, string> | null = null;
  const summaryOf = (method: string, pattern: string) => {
    summaries ??= new Map(ROUTE_DOCS.map((d) => [`${d.method.toUpperCase()} ${d.path.replace(/\{(\w+)\}/g, ':$1')}`, d.summary]));
    return summaries.get(`${method} ${pattern}`) ?? summaries.get(`${method} ${pattern.replace(/:[A-Za-z_]+/g, ':id')}`) ?? '';
  };
  return {
    name: 'ghl_api_routes',
    title: 'API-Routen finden',
    description:
      'Findet REST-Routen der App für ghl_api (alles ohne eigenes Tool): query = Stichworte („rechnung storno“, „formular einsendungen“, „workflow pause“), optional method und module. Liefert „METHODE /pfad – Beschreibung [Bereich]“; GET liest, alles andere ändert (im KI-Agenten mit Bestätigung).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Stichworte, Pfadteile oder Modulname' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        module: { type: 'string', description: 'Nur Routen dieses Moduls (z. B. forms, calendars, campaigns)' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const q = [...new Set(words(String(a.query ?? '')))];
      const method = a.method ? String(a.method).toUpperCase() : '';
      const mod = a.module ? String(a.module).toLowerCase() : '';
      const limit = Math.min(Math.max(Number(a.limit) || 40, 1), 100);
      const hits = app.router
        .list()
        .filter((r) => apiReachable(r.method, r.pattern, r.auth) && (!method || r.method === method) && (!mod || r.module.toLowerCase() === mod))
        // the in-app agent knows the person's areas (and agency routes need an admin)
        .filter((r) => !call.can || ((r.auth !== 'admin' || call.agency) && call.can(r.method, r.pattern)))
        .map((r) => {
          const summary = summaryOf(r.method, r.pattern);
          const hay = words(`${r.pattern} ${r.module} ${summary}`);
          const score = q.reduce((n, w) => n + (hay.some((h) => h.startsWith(w) || (w.length > 4 && h.startsWith(w.slice(0, -1)))) ? 1 : 0), 0);
          return { r, summary, score };
        })
        .filter((x) => !q.length || x.score > 0)
        .sort((x, y) => y.score - x.score || x.r.pattern.length - y.r.pattern.length);
      const routes = hits.slice(0, limit).map(({ r, summary }) => {
        const area = requiredPermission(r.method, r.pattern);
        return `${r.method} ${r.pattern}${summary ? ` – ${summary}` : ''}${area ? ` [${area}]` : ''}${r.auth === 'admin' ? ' [nur Agentur]' : ''}`;
      });
      return { total: hits.length, routes, hint: hits.length > limit ? 'Mehr Treffer – Stichworte genauer fassen oder module angeben.' : undefined };
    },
  };
}

export const mcpApiModule: Module = {
  name: 'mcp-api',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), API_TOOL, apiRoutesTool(app)];
  },
};
