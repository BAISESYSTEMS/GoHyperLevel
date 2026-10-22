/**
 * Known remote MCP servers to start from (Einstellungen/Agentur → MCP-Server → Vorlagen). URLs and auth
 * as documented by the vendors (October 2026) – vendors move endpoints, so every preset links its docs.
 * `signup` is the id in the provider catalogue of modules/referrals.ts („Konto anlegen“).
 */

export interface McpPreset {
  id: string;
  name: string;
  /** Server URL; `<…>` parts must be replaced by the admin. */
  url: string;
  transport: 'auto' | 'http' | 'sse';
  auth: 'none' | 'bearer' | 'oauth';
  /** Bearer alternative to OAuth (or OAuth alternative to a token). */
  alt_auth?: 'bearer' | 'oauth';
  header_name?: string;
  /** What the token is (shown under the field). */
  token_hint?: string;
  /** OAuth: the server supports dynamic client registration (no client id needed). */
  dcr?: boolean;
  docs: string;
  signup?: string;
  note: string;
  license?: string;
  self_hosted?: boolean;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'anythingmcp',
    name: 'AnythingMCP (selbst gehostet)',
    url: 'https://<deine-anythingmcp-instanz>/mcp',
    transport: 'auto',
    auth: 'bearer',
    alt_auth: 'oauth',
    token_hint: 'API-Schlüssel aus dem AnythingMCP-Dashboard',
    docs: 'https://github.com/HelpCode-ai/anythingmcp',
    note: 'MCP-Gateway zum Selbsthosten: macht REST-, SOAP-, GraphQL- und SQL-Systeme (ERP, Shop …) zu MCP-Werkzeugen. Läuft im eigenen Netz – dann „internes Netz“ erlauben.',
    license: 'AGPL-3.0',
    self_hosted: true,
  },
  {
    id: 'github',
    name: 'GitHub (offizieller MCP-Server)',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'http',
    auth: 'bearer',
    alt_auth: 'oauth',
    token_hint: 'Fine-grained Personal Access Token (github.com → Settings → Developer settings)',
    docs: 'https://github.com/github/github-mcp-server',
    signup: 'github',
    note: 'Issues, Pull Requests, Code und Actions. Mit einem Personal Access Token am einfachsten; OAuth braucht eine eigene GitHub-OAuth-App (keine automatische Registrierung).',
  },
  {
    id: 'notion',
    name: 'Notion MCP',
    url: 'https://mcp.notion.com/mcp',
    transport: 'auto',
    auth: 'oauth',
    dcr: true,
    docs: 'https://developers.notion.com/docs/mcp',
    signup: 'notion',
    note: 'Seiten und Datenbanken suchen, lesen und anlegen. Nur mit OAuth – „Verbinden“ meldet den Workspace an.',
  },
  {
    id: 'linear',
    name: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    transport: 'auto',
    auth: 'oauth',
    alt_auth: 'bearer',
    dcr: true,
    token_hint: 'Alternativ ein Linear-API-Schlüssel',
    docs: 'https://linear.app/docs/mcp',
    signup: 'linear',
    note: 'Issues, Projekte und Kommentare in Linear.',
  },
  {
    id: 'atlassian',
    name: 'Atlassian (Jira & Confluence)',
    url: 'https://mcp.atlassian.com/v1/mcp',
    transport: 'auto',
    auth: 'oauth',
    dcr: true,
    docs: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
    signup: 'atlassian',
    note: 'Jira-Vorgänge und Confluence-Seiten (Atlassian Rovo MCP Server). OAuth mit automatischer Registrierung.',
  },
  {
    id: 'zapier',
    name: 'Zapier MCP',
    url: 'https://mcp.zapier.com/api/v1/connect',
    transport: 'auto',
    auth: 'bearer',
    token_hint: 'Connection-Token des MCP-Servers (mcp.zapier.com)',
    docs: 'https://docs.zapier.com/mcp/get-started/connect/other',
    signup: 'zapier',
    note: 'Tausende Zapier-Aktionen, die du auf mcp.zapier.com freigibst.',
  },
  {
    id: 'make',
    name: 'Make MCP',
    url: 'https://<zone>.make.com/mcp',
    transport: 'http',
    auth: 'bearer',
    alt_auth: 'oauth',
    token_hint: 'MCP-Token (Make → Profil → API/MCP); <zone> z. B. eu2',
    docs: 'https://developers.make.com/mcp-server',
    signup: 'make',
    note: 'Make-Szenarien als Werkzeuge. Mit Token am eigenen Zone-Host oder per OAuth über https://mcp.make.com.',
  },
  {
    id: 'stripe',
    name: 'Stripe MCP',
    url: 'https://mcp.stripe.com',
    transport: 'http',
    auth: 'bearer',
    alt_auth: 'oauth',
    token_hint: 'Eingeschränkter Schlüssel (rk_…) mit nur den nötigen Rechten',
    docs: 'https://docs.stripe.com/mcp',
    signup: 'stripe',
    note: 'Kunden, Zahlungen, Rechnungen und Doku-Suche bei Stripe. Am besten mit einem eingeschränkten Schlüssel.',
  },
  {
    id: 'supabase',
    name: 'Supabase MCP',
    url: 'https://mcp.supabase.com/mcp?read_only=true',
    transport: 'http',
    auth: 'oauth',
    alt_auth: 'bearer',
    dcr: true,
    token_hint: 'Alternativ ein Personal Access Token (supabase.com → Account → Access Tokens)',
    docs: 'https://supabase.com/docs/guides/getting-started/mcp',
    signup: 'supabase',
    note: 'Tabellen, SQL und Projekte. Die Vorlage ist nur lesend (read_only=true); project_ref=… beschränkt auf ein Projekt.',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    transport: 'auto',
    auth: 'oauth',
    dcr: true,
    docs: 'https://docs.sentry.io/product/sentry-mcp/',
    signup: 'sentry',
    note: 'Fehler, Issues und Releases aus Sentry.',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare (Docs)',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    transport: 'auto',
    auth: 'none',
    docs: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
    signup: 'cloudflare',
    note: 'Cloudflare-Dokumentation ohne Anmeldung. Weitere Cloudflare-Server (z. B. bindings.mcp.cloudflare.com/mcp, observability.mcp.cloudflare.com/mcp) nutzen OAuth.',
  },
];
