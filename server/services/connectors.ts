import type { App } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { safeFetch, type SafeResponse } from './net.js';
import type { ActionOutcome } from './workflow-engine.js';

/**
 * Native connectors: small, direct integrations that need no Composio – a Slack/Discord webhook,
 * a Notion token, Google Sheets via the agency's Google OAuth app. One definition per connector;
 * modules/connectors.ts stores the values per sub-account (secrets sealed, never sent back),
 * shows them in Apps → Direkt-Verbindungen and the integrations catalogue, and wires the actions
 * into workflows. How to add one: docs/connectors.md#adding-a-native-connector.
 */

export interface ConnectorField {
  key: string;
  label: string;
  /** Sealed at rest and never returned to the browser. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  pattern?: RegExp;
  /** German message when the pattern does not match. */
  patternHint?: string;
  max?: number;
}

export type ConnectorConfig = Record<string, string>;
/** A connector step returns a short text for the run log, or an outcome with variables/output (services/workflow-engine.ts). */
export type ConnectorAction = (app: App, cfg: ConnectorConfig, run: any, step: any, vars: Record<string, any>) => Promise<string | ActionOutcome>;

export interface ConnectorDef {
  key: string;
  name: string;
  /** Category of the integrations catalogue. */
  category: string;
  /** Icon name of the web app. */
  icon: string;
  description: string;
  /** What the user enters, and where (catalogue text). */
  credentials: string;
  docs?: string;
  guide?: string[];
  fields: ConnectorField[];
  /** Checks the saved values ("Verbindung testen") and returns a short status line; throw on failure. */
  test?: (app: App, cfg: ConnectorConfig) => Promise<string>;
  /** Names of the workflow steps it offers (shown in the UI). */
  steps?: string[];
  /** Workflow actions (step type → handler). The handler gets this connector's values. */
  actions?: Record<string, ConnectorAction>;
  /** Own setup panel instead of the field form (e.g. OAuth): status comes from `probe`. */
  custom?: boolean;
  probe?: (app: App, loc: string, ctx: Ctx) => { status: 'ok' | 'partial' | 'missing' | 'info' | 'unavailable'; detail: string };
}

/** Registers a connector: definition, its workflow actions and a catalogue entry. */
export function registerConnector(app: App, def: ConnectorDef) {
  app.services.connectors = [...(app.services.connectors ?? []), def];
  const wrapped: Record<string, (run: any, step: any, vars: Record<string, any>) => Promise<string | ActionOutcome>> = {};
  for (const [type, fn] of Object.entries(def.actions ?? {})) {
    wrapped[type] = async (run, step, vars) => {
      const cfg: ConnectorConfig | null = app.services.connectorConfig?.(run.location_id, def.key) ?? null;
      if (!cfg) throw new Error(`${def.name} ist in diesem Sub-Account nicht eingerichtet (Apps → Direkt-Verbindungen).`);
      return fn(app, cfg, run, step, vars);
    };
  }
  app.services.workflowActions = { ...(app.services.workflowActions ?? {}), ...wrapped };
  app.services.catalogExtra = [
    ...(app.services.catalogExtra ?? []),
    {
      entry: { key: `connector_${def.key}`, name: def.name, category: def.category, icon: def.icon, scope: 'location', setup: { location: 'apps/direct' }, description: def.description, credentials: def.credentials, guide: def.guide, docs: def.docs ?? 'docs/connectors.md' },
      location: (ctx: Ctx, loc: string) => {
        if (def.probe) return def.probe(app, loc, ctx);
        const st = app.services.connectorStatus?.(loc, def.key);
        return st ?? { status: 'unavailable', detail: 'Modul nicht installiert' };
      },
    },
  ];
}

export type ConnectorFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number }) => Promise<SafeResponse>;

/** Outbound HTTP of native connectors: safeFetch (no internal targets), swappable in tests. */
export const connectorFetch = (app: App): ConnectorFetch => app.services.connectorFetch ?? safeFetch;

/** Reads a JSON answer and turns HTTP errors into a German message naming the service. */
export async function readJson(r: SafeResponse, service: string): Promise<any> {
  const raw = await r.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    /* not JSON */
  }
  if (r.ok) return data;
  const msg = String(data?.message ?? data?.error?.message ?? data?.error ?? raw ?? '').slice(0, 200);
  if (r.status === 401 || r.status === 403) throw new Error(`${service}: Zugriff verweigert (${r.status}) – Token/Freigabe prüfen${msg ? `: ${msg}` : ''}`);
  if (r.status === 404 || r.status === 410) throw new Error(`${service}: nicht gefunden (${r.status})${msg ? ` – ${msg}` : ''}`);
  if (r.status === 429) throw new Error(`${service}: zu viele Anfragen – bitte später erneut`);
  throw new Error(`${service} antwortet ${r.status}${msg ? `: ${msg}` : ''}`);
}

// --- Slack & Discord (pure) ----------------------------------------------------------------------

export const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9/_-]{10,300}$/;
export const DISCORD_WEBHOOK = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/;

/** Slack incoming webhook body: text (mrkdwn), optional bold title. */
export function slackPayload(text: string, title?: string) {
  const body = (title ? `*${title.trim()}*\n${text}` : text).trim().slice(0, 3900);
  return { text: body || '(leer)' };
}

/** Discord webhook body: content up to 2000 characters, no @everyone pings. */
export function discordPayload(text: string, title?: string, username?: string) {
  const body = (title ? `**${title.trim()}**\n${text}` : text).trim().slice(0, 2000);
  return { content: body || '(leer)', allowed_mentions: { parse: [] as string[] }, ...(username ? { username: username.slice(0, 80) } : {}) };
}

// --- Notion (pure) ---------------------------------------------------------------------------------

export const NOTION_VERSION = '2022-06-28';
export const NOTION_TOKEN = /^(secret_|ntn_)[A-Za-z0-9]{20,120}$/;

/** A page id from a Notion URL or id (32 hex characters, with or without dashes). */
export function notionPageId(input: string): string | null {
  const s = String(input ?? '').trim();
  const m = s.replace(/-/g, '').match(/([0-9a-f]{32})(?:\?|#|$)/i) ?? s.replace(/-/g, '').match(/([0-9a-f]{32})/i);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Text → Notion blocks: optional heading, one paragraph per paragraph, "- " lines as bullets. */
export function notionBlocks(text: string, heading?: string): any[] {
  const rich = (t: string) => [{ type: 'text', text: { content: t.slice(0, 2000) } }];
  const blocks: any[] = [];
  if (heading?.trim()) blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: rich(heading.trim()) } });
  for (const para of String(text ?? '').split(/\n{2,}/)) {
    const lines = para.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      for (const l of lines) blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rich(l.replace(/^\s*[-*•]\s+/, '')) } });
    } else blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(lines.join('\n')) } });
  }
  return blocks.slice(0, 100);
}

// --- Google Sheets (pure) -------------------------------------------------------------------------

/** A spreadsheet id from a Google Sheets URL or id. */
export function spreadsheetId(input: string): string | null {
  const s = String(input ?? '').trim();
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})/) ?? s.match(/^([A-Za-z0-9_-]{20,100})$/);
  return m ? m[1] : null;
}

/** Column header → contact field (German and English names, custom fields by key or label). */
export function headerField(header: string, custom: { key: string; label: string }[]): string | null {
  const h = header.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  const map: Record<string, string> = {
    'e mail': 'email', email: 'email', mail: 'email', 'e mail adresse': 'email', 'email address': 'email',
    vorname: 'first_name', 'first name': 'first_name', firstname: 'first_name',
    nachname: 'last_name', 'last name': 'last_name', lastname: 'last_name', surname: 'last_name',
    name: 'name', 'full name': 'name', 'vollständiger name': 'name',
    telefon: 'phone', phone: 'phone', handy: 'phone', mobil: 'phone', mobile: 'phone', 'phone number': 'phone', telefonnummer: 'phone',
    firma: 'company', company: 'company', unternehmen: 'company', organisation: 'company',
    adresse: 'address', address: 'address', straße: 'address', strasse: 'address',
    stadt: 'city', ort: 'city', city: 'city', plz: 'postal_code', postleitzahl: 'postal_code', zip: 'postal_code', 'postal code': 'postal_code',
    land: 'country', country: 'country', website: 'website', webseite: 'website', quelle: 'source', source: 'source', tags: 'tags', tag: 'tags',
    geburtstag: 'date_of_birth', 'date of birth': 'date_of_birth', birthday: 'date_of_birth',
  };
  if (map[h]) return map[h];
  const c = custom.find((f) => f.key.toLowerCase() === header.trim().toLowerCase() || f.label.trim().toLowerCase() === header.trim().toLowerCase());
  return c ? `custom.${c.key}` : null;
}

/** Sheet rows (first row = headers) → contact inputs for upsertContact. */
export function rowsToContacts(values: unknown[][], custom: { key: string; label: string }[]): { contacts: Record<string, any>[]; columns: { header: string; field: string | null }[]; skipped: number } {
  const [head = [], ...rows] = Array.isArray(values) ? values : [];
  const columns = head.map((h) => ({ header: String(h ?? ''), field: headerField(String(h ?? ''), custom) }));
  const contacts: Record<string, any>[] = [];
  let skipped = 0;
  for (const row of rows) {
    const input: Record<string, any> = {};
    const customVals: Record<string, string> = {};
    columns.forEach((c, i) => {
      const v = String((row as unknown[])?.[i] ?? '').trim();
      if (!v || !c.field) return;
      if (c.field === 'tags') input.tags = v.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
      else if (c.field.startsWith('custom.')) customVals[c.field.slice(7)] = v;
      else input[c.field] = v;
    });
    if (Object.keys(customVals).length) input.custom = customVals;
    if (input.email || input.phone) contacts.push(input);
    else if (Object.keys(input).length) skipped++;
  }
  return { contacts, columns, skipped };
}

export const EXPORT_COLUMNS: [string, string][] = [
  ['first_name', 'Vorname'],
  ['last_name', 'Nachname'],
  ['email', 'E-Mail'],
  ['phone', 'Telefon'],
  ['company', 'Firma'],
  ['address', 'Adresse'],
  ['postal_code', 'PLZ'],
  ['city', 'Stadt'],
  ['country', 'Land'],
  ['website', 'Website'],
  ['source', 'Quelle'],
  ['tags', 'Tags'],
  ['created_at', 'Angelegt'],
];

/** Contacts → sheet rows (header + one row each), custom fields as extra columns. */
export function contactsToRows(contacts: any[], custom: { key: string; label: string }[]): string[][] {
  const head = [...EXPORT_COLUMNS.map((c) => c[1]), ...custom.map((f) => f.label || f.key)];
  const cell = (v: unknown) => {
    // Written with valueInputOption=RAW: Sheets stores "=…" as text, never as a formula.
    const s = Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v);
    return s.slice(0, 5000);
  };
  return [head, ...contacts.map((c) => [...EXPORT_COLUMNS.map(([k]) => cell(c[k])), ...custom.map((f) => cell(c.custom?.[f.key]))])];
}
