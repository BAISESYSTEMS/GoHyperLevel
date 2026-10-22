import type { App } from '../core/app.js';
import { TOOLS as MCP_CORE_TOOLS, type Tool } from '../modules/mcp.js';
import { apiReachable } from '../modules/mcp-api.js';
import { agentForbidden } from './agent-safety.js';

/**
 * Which app areas agents can reach (docs/agent.md#abdeckung; tests/agent-coverage.test.ts keeps it honest). Every module with
 * routes behind a login is checked: covered by a specific tool (a tool the module registers, or one whose calls hit the module's
 * routes), reachable through the generic `ghl_api` (writes then always ask first in the HyperLevel Agent), or – only when neither
 * – listed in AGENT_EXEMPT with the reason. A new module whose write routes no agent can reach fails the test until it gets a
 * tool, its routes leave the deny lists, or it is exempted here on purpose.
 */

/** Modules agents must not or cannot reach, with the reason. Only modules no tool and no ghl_api call reaches belong here. */
export const AGENT_EXEMPT: Record<string, string> = {
  twofactor: 'Zweiter Faktor der eigenen Anmeldung – Identität, nie für Agenten',
  security: 'Eigene Sitzungen und Abmelden anderer Geräte – Identität, nie für Agenten',
  language: 'Sprache des eigenen Logins (/api/me) – persönliche Einstellung, nie für Agenten',
  'calendar-connect': 'Persönliche Kalender-Verbindungen (/api/me, OAuth) – Zugangsdaten, nie für Agenten',
  'saas-signup': 'Einladung aus einer SaaS-Anmeldung – Einladungen/Anmeldelinks, nie für Agenten (Übersicht lesbar)',
  'app-share': 'Teilen-Ziel der Mobil-App (Gerät) – dieselben Inhalte legen ghl_upsert_contact/ghl_add_note an',
  'backoffice-mobile': 'Spiegel der Mobil-App (gerätegebundene Token) – Belege/Abwesenheiten über ghl_receipt_status, ghl_create_absence_request',
  'pm-mobile': 'Spiegel der Mobil-App – Projektaufgaben, Kommentare und Zeiten über ghl_pm_*',
  'collab-mobile': 'Spiegel der Mobil-App – Team-Chat über ghl_chat_post/ghl_chat_history',
  'community-mobile': 'Spiegel der Mobil-App – Community über ghl_community_* und ghl_create_community_post',
  passkeys: 'Passkeys der eigenen Anmeldung – Identität, nie für Agenten',
  'mcp-oauth': 'OAuth-Freigaben für MCP-Clients – nur eine Person im Browser darf Zugriff erteilen',
  'oauth-connect': 'OAuth-Verbindungen zu Diensten – Zugangsdaten, nie für Agenten',
  push: 'Push-Geräte der Person – Gerätekopplung, nie für Agenten',
  mobile: 'Kopplung der Mobil-App (eigene Token) – nie für Agenten',
  backups: 'Datenbank-Sicherungen – ganze Datenbank, nie über Agenten',
  'offsite-backup': 'Externe Datenbank-Sicherungen – ganze Datenbank, nie über Agenten',
  sso: 'Agentur-Anmeldung per SSO – Anmeldung, nie für Agenten',
  'login-policy': 'Anmelderegeln der Agentur – Anmeldung, nie für Agenten',
  'ai-tools': 'Schlüssel für KI-Werkzeuge (MCP) – Schlüssel erzeugen nie Schlüssel',
  'ai-connections': 'KI-Anbieter-Schlüssel (BYOK) – der Agent ändert nie seine eigenen Zugänge',
  'ai-providers': 'KI-Anbieter-Einstellungen – der Agent ändert nie seine eigenen Zugänge',
  'agent-custom': 'Eigene KI-Agenten – Agenten konfigurieren sich nie selbst (Entwurf: ghl_agent_generate)',
  'agent-bridge': 'Bridge-Kopplung für das eigene Abo – Gerätekopplung, nie für Agenten',
  'ai-subscriptions': 'ChatGPT-/Claude-Abo der Person – persönliche Anmeldung, nie für Agenten',
};

export interface CoverageRow {
  module: string;
  reads: number;
  writes: number;
  /** Specific tools that read this module's data. */
  readTools: string[];
  /** Specific tools that change this module's data. */
  tools: string[];
  /** Write routes ghl_api can call (in the HyperLevel Agent always after a confirmation). */
  generic: number;
  /** Read routes ghl_api can call. */
  genericReads: number;
  /** How agents change this module's data. */
  status: 'tool' | 'generic' | 'exempt' | 'none';
  /** How agents read it. */
  readStatus: 'tool' | 'generic' | 'none';
  reason?: string;
}

/** `/api/...` paths a tool's code calls (template parts become `:x`). */
export function toolPaths(run: (...a: any[]) => unknown): string[] {
  const out = new Set<string>();
  const re = /(['"`])(\/api\/(?:[^'"`$\\]|\$\{[^}]*\})*)\1/g;
  const src = String(run);
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.add(m[2].replace(/\$\{[^}]*\}/g, ':x').split('?')[0]);
  return [...out];
}

const seg = (p: string) => p.split('/').filter(Boolean);
/** A called path (`/api/forms/:x/submissions`) hits a route pattern (`/api/forms/:id/submissions`). */
export function pathHits(called: string, pattern: string): boolean {
  const a = seg(called);
  const b = seg(pattern);
  return a.length === b.length && a.every((x, i) => x === ':x' || b[i].startsWith(':') || x === b[i] || (x.startsWith(':') && b[i].startsWith(':')));
}

export interface ToolInfo {
  name: string;
  module: string;
  paths: string[];
  /** Traced calls with their method (empty without tracing). */
  calls: { method: string; path: string }[];
  /** Only reads (readOnlyHint, not destructive). */
  readOnly: boolean;
}

/** A value of the right type for each argument (ids become "x1", "x2" …), so a traced call reaches its first route. */
export function sampleArgs(schema: any): Record<string, unknown> {
  let n = 0;
  const one = (k: string, p: any): unknown => {
    if (k === 'location_id') return 'trace-loc';
    if (Array.isArray(p?.enum) && p.enum.length) return p.enum[0];
    const type = Array.isArray(p?.type) ? p.type[0] : p?.type;
    if (type === 'integer' || type === 'number') return p?.minimum ?? 1;
    if (type === 'boolean') return false;
    if (type === 'array') return p?.items?.type === 'object' ? [{ name: 'x' }] : [`x${++n}`];
    if (type === 'object') return {};
    if (/email/.test(k)) return 'trace@example.com';
    if (/url/.test(k)) return 'https://example.com/';
    if (/date|start|end|^from$|^to$|due|_at$/.test(k)) return '2026-11-02T10:00:00Z';
    return `x${++n}`;
  };
  return Object.fromEntries(Object.entries(schema?.properties ?? {}).map(([k, p]) => [k, one(k, p)]));
}

/**
 * The routes a tool calls, found by running it once against a recording caller (no route runs; every call answers {}),
 * for tools that build their paths in helpers. Errors after the first call are expected and ignored.
 */
export async function traceToolCalls(t: Tool, args?: Record<string, unknown>, timeoutMs = 1500): Promise<{ method: string; path: string }[]> {
  const seen = new Map<string, { method: string; path: string }>();
  const caller = {
    agency: false,
    locationId: 'trace-loc',
    api: async (method: string, path: string) => {
      const p = String(path).split('?')[0];
      seen.set(`${method} ${p}`, { method: String(method).toUpperCase(), path: p });
      return {};
    },
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([Promise.resolve().then(() => t.run(caller as any, args ?? sampleArgs(t.inputSchema))), new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
  } catch {
    /* the fake answers don't fit – the first calls are recorded */
  } finally {
    clearTimeout(timer);
  }
  return [...seen.values()];
}

/** Every MCP tool with the module that registered it (core tools → 'mcp') and the paths its code calls (static, plus traced). */
export async function toolInfos(app: App, opts: { trace?: boolean } = {}): Promise<ToolInfo[]> {
  const all = [...MCP_CORE_TOOLS, ...((app.services.mcpTools ?? []) as Tool[])];
  const out: ToolInfo[] = [];
  for (const t of all) {
    const calls = opts.trace && t.name !== 'ghl_api' ? await traceToolCalls(t) : [];
    out.push({ name: t.name, module: t.module ?? 'mcp', paths: [...new Set([...toolPaths(t.run), ...calls.map((c) => c.path)])], calls, readOnly: !!t.annotations?.readOnlyHint && !t.annotations?.destructiveHint });
  }
  return out;
}

/** The coverage matrix of all modules with routes behind a login. */
export function agentCoverage(app: App, tools: ToolInfo[], exempt: Record<string, string> = AGENT_EXEMPT): CoverageRow[] {
  const byModule = new Map<string, { method: string; pattern: string; auth: string }[]>();
  for (const r of app.router.list()) {
    if (r.auth === 'public') continue;
    const list = byModule.get(r.module) ?? [];
    list.push(r);
    byModule.set(r.module, list);
  }
  const rows: CoverageRow[] = [];
  for (const [module, routes] of byModule) {
    const writes = routes.filter((r) => r.method !== 'GET');
    const gets = routes.filter((r) => r.method === 'GET');
    const readHit = new Set<string>();
    const writeHit = new Set<string>();
    for (const t of tools) {
      if (t.name === 'ghl_api' || t.name === 'ghl_api_routes') continue;
      const own = t.module === module;
      if ((own && t.readOnly) || t.paths.some((p) => gets.some((r) => pathHits(p, r.pattern)))) readHit.add(t.name);
      if (!t.readOnly && (own || t.paths.some((p) => writes.some((r) => pathHits(p, r.pattern))))) writeHit.add(t.name);
    }
    const reachable = (r: { method: string; pattern: string; auth: string }) => apiReachable(r.method, r.pattern, r.auth) && !agentForbidden(r.pattern);
    const generic = writes.filter(reachable).length;
    const genericReads = gets.filter(reachable).length;
    const readStatus: CoverageRow['readStatus'] = readHit.size ? 'tool' : genericReads ? 'generic' : 'none';
    // a module without write routes is judged by its reads
    const status: CoverageRow['status'] = (writes.length ? writeHit.size : readHit.size) ? 'tool' : (writes.length ? generic : genericReads) ? 'generic' : exempt[module] ? 'exempt' : 'none';
    rows.push({ module, reads: gets.length, writes: writes.length, readTools: [...readHit].sort(), tools: [...writeHit].sort(), generic, genericReads, status, readStatus, ...(exempt[module] ? { reason: exempt[module] } : {}) });
  }
  return rows.sort((a, b) => a.module.localeCompare(b.module));
}
