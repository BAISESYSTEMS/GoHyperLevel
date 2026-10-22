import type { App, Module } from '../core/app.js';
import { isRelay } from '../core/app.js';
import { HttpError, notFound, str, type Ctx, type User } from '../core/http.js';
import { id, now, sha256, token } from '../core/util.js';
import { APP_VERSION } from '../version.js';

/**
 * Agency API keys (all sub-accounts at once, read-only or read/write) and an MCP endpoint
 * (Model Context Protocol, Streamable HTTP with JSON responses) at /mcp, so Claude and other
 * assistants can run the agency: projects, contacts, pipelines, tasks, mail, social posts.
 * Every tool is a thin relay onto the REST API, so permissions, validation and the audit log apply.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

type Json = Record<string, any>;
/** Other modules add their own tools via `app.services.mcpTools` (see docs.ts). */
export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  agencyOnly?: boolean;
  /** The HyperLevel Agent's class for this call when it depends on the arguments (e.g. plan only vs. build); defaults to the annotations. */
  klassFor?: (args: Json) => 'read' | 'write' | 'sensitive';
  /** The result is third-party text (messages, notes, search hits): the agent treats it as untrusted data (agent-tools.ts). */
  untrusted?: boolean;
  /** Part of the agent's safety level "Termin buchen": free slots and booking them run without confirmation there (modules/ai-booking.ts). */
  booking?: boolean;
  /** Set at registration: the module that added the tool (core/app.ts). */
  module?: string;
  run: (call: Caller, args: Json) => Promise<unknown>;
}
export interface Caller {
  api: (method: string, path: string, opts?: { body?: unknown; location?: string }) => Promise<any>;
  agency: boolean;
  locationId?: string;
  /** Whether the person behind the call has the area of a route (set by the in-app agent; absent = the route decides). */
  can?: (method: string, path: string) => boolean;
}

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Json, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const q = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};

async function stageId(call: Caller, loc: string, pipelineId: string | undefined, stage: string | undefined) {
  if (!stage) return undefined;
  const pipes: any[] = await call.api('GET', '/api/pipelines', { location: loc });
  const list = pipelineId ? pipes.filter((p) => p.id === pipelineId) : pipes;
  const wanted = String(stage).toLowerCase();
  for (const p of list) {
    const s = p.stages.find((x: any) => x.id === stage || String(x.name).toLowerCase() === wanted);
    if (s) return s.id;
  }
  throw new HttpError(400, `Stufe „${stage}“ nicht gefunden – verfügbare: ${list.flatMap((p) => p.stages.map((s: any) => s.name)).join(', ')}`);
}

export const TOOLS: Tool[] = [
  {
    name: 'ghl_list_projects',
    title: 'Projekte auflisten',
    description: 'Alle Projekte/Sub-Accounts mit Steckbrief (Status, Website, Uptime) und Kennzahlen (Kontakte, offene Deals, Aufgaben, ungelesene Nachrichten, Entwürfe).',
    inputSchema: obj({}),
    annotations: RO,
    run: async (call) => {
      if (!call.agency) return [{ ...(await call.api('GET', '/api/location')), project: await call.api('GET', '/api/project') }];
      const list: any[] = await call.api('GET', '/api/agency/projects');
      return list.map((l) => ({ id: l.id, name: l.name, status: l.profile.status, tagline: l.profile.tagline, website: l.profile.website, uptime: l.profile.uptime, stats: l.stats }));
    },
  },
  {
    name: 'ghl_get_project',
    title: 'Projekt-Steckbrief',
    description: 'Steckbrief eines Projekts (Beschreibung, Ziele, Links, Repos, Server, KPIs, Notizen) plus Kennzahlen und Pipelines.',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: RO,
    run: async (call, a) => ({ project: await call.api('GET', '/api/project', { location: a.location_id }), pipelines: await call.api('GET', '/api/pipelines', { location: a.location_id }) }),
  },
  {
    name: 'ghl_create_project',
    title: 'Projekt anlegen',
    description: 'Legt ein neues Projekt als Sub-Account an (optional gleich mit Steckbrief). Gibt die neue location_id zurück.',
    inputSchema: obj(
      {
        name: { type: 'string', description: 'Projektname, z. B. „Musterprojekt.de“' },
        timezone: { type: 'string', description: 'IANA-Zeitzone, Standard Europe/Berlin' },
        profile: { type: 'object', description: 'Felder wie bei ghl_update_project' },
      },
      ['name'],
    ),
    annotations: W,
    agencyOnly: true,
    run: async (call, a) => {
      const loc = await call.api('POST', '/api/locations', { body: { name: a.name, timezone: a.timezone } });
      const project = a.profile ? await call.api('PUT', '/api/project', { location: loc.id, body: a.profile }) : null;
      return { location_id: loc.id, name: loc.name, project };
    },
  },
  {
    name: 'ghl_update_project',
    title: 'Projekt-Steckbrief ändern',
    description: 'Ändert den Steckbrief. Nur übergebene Felder werden geändert. status: idee|entwicklung|beta|live|pausiert|archiviert. links: [{label,url}], repos: [string], servers: [{name,detail}], kpis: [{label,value,target}], claude_sessions: [{label,url}] (claude.ai-Links oder session_…-IDs, öffnen die Claude-Sitzung zum Projekt mit einem Klick), codex_sessions: [{label,url}] (chatgpt.com/codex-Links, z. B. https://chatgpt.com/codex/tasks/task_e_…, oder task_…-IDs – öffnen die Codex-Aufgabe zum Projekt).',
    inputSchema: obj(
      {
        ...LOC,
        status: { type: 'string', enum: ['idee', 'entwicklung', 'beta', 'live', 'pausiert', 'archiviert'] },
        category: { type: 'string' },
        tagline: { type: 'string' },
        description: { type: 'string' },
        website: { type: 'string' },
        goals: { type: 'string' },
        notes: { type: 'string' },
        priority: { type: 'integer', minimum: 0, maximum: 5 },
        links: { type: 'array', items: { type: 'object' } },
        repos: { type: 'array', items: { type: 'string' } },
        servers: { type: 'array', items: { type: 'object' } },
        kpis: { type: 'array', items: { type: 'object' } },
        claude_sessions: { type: 'array', items: { type: 'object' }, description: '[{label, url}] – Claude-Sitzungen zum Projekt' },
        codex_sessions: { type: 'array', items: { type: 'object' }, description: '[{label, url}] – Codex-Aufgaben/-Umgebungen zum Projekt (chatgpt.com/codex/…)' },
        monitor: { type: 'boolean', description: 'Website alle 10 Minuten prüfen' },
      },
      ['location_id'],
    ),
    annotations: { ...W, idempotentHint: true },
    run: async (call, a) => {
      const { location_id, ...rest } = a;
      return call.api('PUT', '/api/project', { location: location_id, body: rest });
    },
  },
  {
    name: 'ghl_search_contacts',
    title: 'Kontakte suchen',
    description: 'Sucht Kontakte eines Projekts nach Text (Name, E-Mail, Telefon, Firma) und/oder Tag.',
    inputSchema: obj({ ...LOC, query: { type: 'string' }, tag: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      const r = await call.api('GET', `/api/contacts${q({ q: a.query, tag: a.tag, limit: a.limit ?? 25 })}`, { location: a.location_id });
      return { total: r.total, contacts: (r.contacts ?? []).map((c: any) => ({ id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email, phone: c.phone, company: c.company, tags: c.tags, source: c.source })) };
    },
  },
  {
    name: 'ghl_get_contact',
    title: 'Kontakt abrufen',
    description: 'Ein Kontakt mit allen Feldern, Notizen und letzten Aktivitäten.',
    inputSchema: obj({ ...LOC, contact_id: { type: 'string' } }, ['location_id', 'contact_id']),
    annotations: RO,
    run: (call, a) => call.api('GET', `/api/contacts/${encodeURIComponent(a.contact_id)}`, { location: a.location_id }),
  },
  {
    name: 'ghl_upsert_contact',
    title: 'Kontakt anlegen/aktualisieren',
    description: 'Legt einen Kontakt an oder aktualisiert ihn (Abgleich über E-Mail/Telefon). tags werden ergänzt.',
    inputSchema: obj(
      {
        ...LOC,
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        name: { type: 'string', description: 'Voller Name (alternativ zu first/last)' },
        email: { type: 'string' },
        phone: { type: 'string' },
        company: { type: 'string' },
        website: { type: 'string' },
        city: { type: 'string' },
        source: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        custom: { type: 'object', description: 'Eigene Felder {key: value}' },
      },
      ['location_id'],
    ),
    annotations: { ...W, idempotentHint: true },
    run: async (call, a) => {
      const { location_id, ...body } = a;
      return call.api('POST', '/api/contacts', { location: location_id, body });
    },
  },
  {
    name: 'ghl_add_note',
    title: 'Notiz zum Kontakt',
    description: 'Hängt eine Notiz an einen Kontakt.',
    inputSchema: obj({ ...LOC, contact_id: { type: 'string' }, body: { type: 'string' } }, ['location_id', 'contact_id', 'body']),
    annotations: W,
    run: (call, a) => call.api('POST', `/api/contacts/${encodeURIComponent(a.contact_id)}/notes`, { location: a.location_id, body: { body: a.body } }),
  },
  {
    name: 'ghl_list_pipelines',
    title: 'Pipelines',
    description: 'Pipelines eines Projekts mit ihren Stufen (id + Name).',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: RO,
    run: (call, a) => call.api('GET', '/api/pipelines', { location: a.location_id }),
  },
  {
    name: 'ghl_create_pipeline',
    title: 'Pipeline anlegen',
    description: 'Neue Pipeline mit Stufen in Reihenfolge, z. B. ["Recherche","Entwurf","Kontaktiert","Gespräch","Gewonnen"].',
    inputSchema: obj({ ...LOC, name: { type: 'string' }, stages: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['location_id', 'name', 'stages']),
    annotations: W,
    run: (call, a) => call.api('POST', '/api/pipelines', { location: a.location_id, body: { name: a.name, stages: a.stages } }),
  },
  {
    name: 'ghl_list_opportunities',
    title: 'Deals/Opportunities',
    description: 'Opportunities eines Projekts, optional nach Pipeline und Status (open|won|lost|abandoned).',
    inputSchema: obj({ ...LOC, pipeline_id: { type: 'string' }, status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'] } }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      const r = await call.api('GET', `/api/opportunities${q({ pipeline_id: a.pipeline_id, status: a.status })}`, { location: a.location_id });
      const list = Array.isArray(r) ? r : (r.opportunities ?? r);
      return (list as any[]).map((o) => ({ id: o.id, name: o.name, pipeline_id: o.pipeline_id, stage_id: o.stage_id, stage: o.stage_name, status: o.status, value: o.value, currency: o.currency, expected_close_date: o.expected_close_date, lost_reason: o.lost_reason || undefined, contact_id: o.contact_id, contact: [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email, source: o.source, updated_at: o.updated_at }));
    },
  },
  {
    name: 'ghl_create_opportunity',
    title: 'Deal anlegen',
    description: 'Neue Opportunity in einer Pipeline. stage = Stufenname oder -ID. Kontakt per contact_id oder contact {email, first_name, last_name, company} (wird angelegt/gefunden). Optional: erwarteter Abschluss (JJJJ-MM-TT) und Währung.',
    inputSchema: obj(
      {
        ...LOC,
        pipeline_id: { type: 'string' },
        stage: { type: 'string' },
        name: { type: 'string' },
        value: { type: 'number', description: 'Wert (ganze Einheiten der Währung, Standard Euro)' },
        currency: { type: 'string', description: 'Währung als ISO-Code, z. B. EUR, USD, CHF (Standard EUR)' },
        expected_close_date: { type: 'string', description: 'Erwartetes Abschlussdatum JJJJ-MM-TT' },
        contact_id: { type: 'string' },
        contact: { type: 'object' },
        source: { type: 'string' },
      },
      ['location_id', 'pipeline_id', 'name'],
    ),
    annotations: W,
    run: async (call, a) => {
      if (!a.contact_id && !a.contact) throw new HttpError(400, 'contact_id oder contact angeben');
      const stage_id = await stageId(call, a.location_id, a.pipeline_id, a.stage);
      return call.api('POST', '/api/opportunities', { location: a.location_id, body: { pipeline_id: a.pipeline_id, stage_id, name: a.name, value: a.value, currency: a.currency, expected_close_date: a.expected_close_date, contact_id: a.contact_id, contact: a.contact, source: a.source } });
    },
  },
  {
    name: 'ghl_update_opportunity',
    title: 'Deal ändern',
    description: 'Verschiebt eine Opportunity (stage = Name oder ID) oder ändert Status (open|won|lost|abandoned), Wert, Währung, erwarteten Abschluss (JJJJ-MM-TT, leer = löschen) oder Namen. Beim Status lost ist lost_reason Pflicht (Kurztext, z. B. „Preis zu hoch“).',
    inputSchema: obj(
      {
        ...LOC,
        opportunity_id: { type: 'string' },
        stage: { type: 'string' },
        status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'] },
        lost_reason: { type: 'string', description: 'Pflicht bei status=lost: Grund des Verlusts' },
        value: { type: 'number' },
        currency: { type: 'string', description: 'ISO-Code, z. B. EUR, USD, CHF' },
        expected_close_date: { type: 'string', description: 'JJJJ-MM-TT; leerer Text löscht das Datum' },
        name: { type: 'string' },
      },
      ['location_id', 'opportunity_id'],
    ),
    annotations: { ...W, idempotentHint: true },
    run: async (call, a) => {
      const body: Json = {};
      if (a.stage) {
        const all = await call.api('GET', '/api/opportunities', { location: a.location_id });
        const opp = (Array.isArray(all) ? all : (all.opportunities ?? [])).find((o: any) => o.id === a.opportunity_id);
        if (!opp) throw new HttpError(404, 'Opportunity nicht gefunden');
        body.stage_id = await stageId(call, a.location_id, opp.pipeline_id, a.stage);
      }
      for (const k of ['status', 'value', 'name', 'lost_reason', 'currency', 'expected_close_date']) if (a[k] !== undefined) body[k] = a[k];
      return call.api('PATCH', `/api/opportunities/${encodeURIComponent(a.opportunity_id)}`, { location: a.location_id, body });
    },
  },
  {
    name: 'ghl_list_tasks',
    title: 'Aufgaben',
    description: 'Aufgaben eines Projekts (status open|done).',
    inputSchema: obj({ ...LOC, status: { type: 'string', enum: ['open', 'done'] } }, ['location_id']),
    annotations: RO,
    run: (call, a) => call.api('GET', `/api/tasks${q({ status: a.status ?? 'open' })}`, { location: a.location_id }),
  },
  {
    name: 'ghl_list_all_tasks',
    title: 'Alle Aufgaben (alle Projekte)',
    description: 'Offene Aufgaben aller Projekte in einer Liste (Fälligkeit zuerst), mit Projektname und location_id.',
    inputSchema: obj({ status: { type: 'string', enum: ['open', 'done'] } }),
    annotations: RO,
    agencyOnly: true,
    run: async (call, a) => (await call.api('GET', `/api/agency/tasks${q({ status: a.status })}`)).map((t: any) => ({ id: t.id, project: t.project, location_id: t.location_id, title: t.title, due_at: t.due_at, done: !!t.done })),
  },
  {
    name: 'ghl_create_task',
    title: 'Aufgabe anlegen',
    description: 'Neue Aufgabe, optional mit Fälligkeit (ISO-Datum) und Kontakt.',
    inputSchema: obj({ ...LOC, title: { type: 'string' }, description: { type: 'string' }, due_at: { type: 'string', description: 'ISO 8601, z. B. 2026-10-10T09:00:00Z' }, contact_id: { type: 'string' } }, ['location_id', 'title']),
    annotations: W,
    run: (call, a) => call.api('POST', '/api/tasks', { location: a.location_id, body: { title: a.title, description: a.description, due_at: a.due_at, contact_id: a.contact_id } }),
  },
  {
    name: 'ghl_complete_task',
    title: 'Aufgabe erledigt',
    description: 'Markiert eine Aufgabe als erledigt (done=false öffnet sie wieder).',
    inputSchema: obj({ ...LOC, task_id: { type: 'string' }, done: { type: 'boolean' } }, ['location_id', 'task_id']),
    annotations: { ...W, idempotentHint: true },
    run: (call, a) => call.api('PATCH', `/api/tasks/${encodeURIComponent(a.task_id)}`, { location: a.location_id, body: { done: a.done ?? true } }),
  },
  {
    name: 'ghl_list_conversations',
    title: 'Konversationen',
    description: 'Posteingang eines Projekts (filter all|unread|starred, query = Suchtext).',
    inputSchema: obj({ ...LOC, filter: { type: 'string', enum: ['all', 'unread', 'starred'] }, query: { type: 'string' }, limit: { type: 'integer' } }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      const list: any[] = await call.api('GET', `/api/conversations${q({ filter: a.filter === 'all' ? '' : a.filter, q: a.query, limit: a.limit ?? 30 })}`, { location: a.location_id });
      return list.map((v) => ({ id: v.id, contact_id: v.contact_id, contact: [v.first_name, v.last_name].filter(Boolean).join(' ') || v.email, unread: v.unread, last_message: v.last_message, last_message_at: v.last_message_at }));
    },
  },
  {
    name: 'ghl_get_conversation',
    title: 'Konversation lesen',
    description: 'Alle Nachrichten einer Konversation (inkl. Entwürfe).',
    inputSchema: obj({ ...LOC, conversation_id: { type: 'string' } }, ['location_id', 'conversation_id']),
    annotations: RO,
    run: async (call, a) => {
      const r = await call.api('GET', `/api/conversations/${encodeURIComponent(a.conversation_id)}/messages`, { location: a.location_id });
      return { contact: r.contact, messages: (r.messages ?? []).map((m: any) => ({ id: m.id, at: m.created_at, channel: m.channel, direction: m.direction, status: m.status, subject: m.subject, body: String(m.body).slice(0, 4000) })) };
    },
  },
  {
    name: 'ghl_list_drafts',
    title: 'E-Mail-Entwürfe',
    description: 'Alle unversendeten Entwürfe eines Projekts.',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: RO,
    run: (call, a) => call.api('GET', '/api/conversations/drafts', { location: a.location_id }),
  },
  {
    name: 'ghl_import_emails',
    title: 'E-Mails importieren',
    description:
      'Importiert E-Mails (z. B. aus Gmail) in die Konversationen eines Projekts. messages: [{external_id (z. B. Gmail-Message-ID, für Dubletten), direction in|out, status? "draft", from, to: [..], subject, body, date (ISO), contact?: {email,name,company}}]. Höchstens 500 je Aufruf.',
    inputSchema: obj({ ...LOC, messages: { type: 'array', items: { type: 'object' } }, source: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, own_address: { type: 'string', description: 'Eigene Adresse, um ausgehende Mails zu erkennen' } }, ['location_id', 'messages']),
    annotations: { ...W, idempotentHint: true },
    run: async (call, a) => {
      const { location_id, ...body } = a;
      return call.api('POST', '/api/conversations/import', { location: location_id, body });
    },
  },
  {
    name: 'ghl_send_message',
    title: 'Nachricht senden',
    description: 'Sendet eine E-Mail oder SMS an einen Kontakt (echter Versand über den eingerichteten Anbieter). whatsapp/messenger/instagram: freier Text nur innerhalb von 24 h nach der letzten Nachricht des Kontakts (WhatsApp-Vorlagen: ghl_send_whatsapp). telegram/discord: nur an Kontakte, die dort schon geschrieben haben; push: Browser-Benachrichtigung (subject = Titel).',
    inputSchema: obj({ ...LOC, contact_id: { type: 'string' }, channel: { type: 'string', enum: ['email', 'sms', 'whatsapp', 'messenger', 'instagram'] }, subject: { type: 'string' }, body: { type: 'string' } }, ['location_id', 'contact_id', 'channel', 'body']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) => call.api('POST', '/api/messages', { location: a.location_id, body: { contact_id: a.contact_id, channel: a.channel, subject: a.subject, body: a.body } }),
  },
  {
    name: 'ghl_dashboard',
    title: 'Dashboard-Zahlen',
    description: 'Kennzahlen eines Projekts (Leads, Pipeline, Termine, Umsatz, Quellen).',
    inputSchema: obj({ ...LOC, days: { type: 'integer', description: 'Zeitraum in Tagen, Standard 30' } }, ['location_id']),
    annotations: RO,
    run: (call, a) => call.api('GET', `/api/dashboard${q({ days: a.days })}`, { location: a.location_id }),
  },
  {
    name: 'ghl_list_social_posts',
    title: 'Social-Posts',
    description: 'Geplante und veröffentlichte Social-Media-Posts (über Postiz) im Zeitraum (ISO from/to, Standard −7 bis +35 Tage).',
    inputSchema: obj({ ...LOC, from: { type: 'string' }, to: { type: 'string' } }, ['location_id']),
    annotations: RO,
    run: (call, a) => call.api('GET', `/api/social/posts${q({ from: a.from, to: a.to })}`, { location: a.location_id }),
  },
  {
    name: 'ghl_create_social_post',
    title: 'Social-Post anlegen',
    description: 'Legt einen Social-Media-Post an. Standard ist ein Entwurf (type "draft"); "schedule" braucht date (ISO), "now" veröffentlicht sofort. Kanal-IDs aus GET /api/social (ghl_get_project zeigt sie nicht; nutze ghl_list_social_channels).',
    inputSchema: obj({ ...LOC, integration_ids: { type: 'array', items: { type: 'string' } }, content: { type: 'string' }, type: { type: 'string', enum: ['draft', 'schedule', 'now'] }, date: { type: 'string' } }, ['location_id', 'integration_ids', 'content']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) => call.api('POST', '/api/social/posts', { location: a.location_id, body: { integration_ids: a.integration_ids, content: a.content, type: a.type ?? 'draft', date: a.date } }),
  },
  {
    name: 'ghl_list_social_channels',
    title: 'Social-Kanäle',
    description: 'Die Social-Media-Kanäle eines Projekts (IDs für ghl_create_social_post).',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: RO,
    run: async (call, a) => (await call.api('GET', '/api/social', { location: a.location_id })).channels,
  },
  {
    name: 'ghl_audit_log',
    title: 'Protokoll',
    description: 'Wer hat wann was geändert (inkl. Änderungen über API und MCP).',
    inputSchema: obj({ location_id: { type: 'string' }, limit: { type: 'integer', maximum: 500 }, query: { type: 'string' } }),
    annotations: RO,
    agencyOnly: true,
    run: (call, a) => call.api('GET', `/api/admin/audit${q({ location_id: a.location_id, limit: a.limit ?? 50, q: a.query })}`),
  },
];

function checkArgs(tool: Tool, args: Json) {
  const req: string[] = tool.inputSchema.required ?? [];
  const missing = req.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  if (missing.length) throw new RpcError(-32602, `Fehlende Parameter für ${tool.name}: ${missing.join(', ')}`);
}

const TYPE_WORD: Record<string, string> = { string: 'Text', integer: 'eine ganze Zahl', number: 'eine Zahl', boolean: 'true oder false', array: 'eine Liste', object: 'ein Objekt' };
const INVALID = Symbol('invalid');
const isPlain = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
const fits = (v: unknown, type: string) =>
  type === 'string' ? typeof v === 'string' : type === 'integer' || type === 'number' ? typeof v === 'number' && Number.isFinite(v) : type === 'boolean' ? typeof v === 'boolean' : type === 'array' ? Array.isArray(v) : type === 'object' ? isPlain(v) : type === 'null' ? v === null : true;
function coerce(v: unknown, types: string[]): unknown {
  if (types.some((type) => fits(v, type))) return v;
  for (const type of types) {
    if (type === 'string' && ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean')) return String(v);
    if ((type === 'integer' || type === 'number') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    if (type === 'boolean' && (typeof v === 'string' || typeof v === 'number')) {
      const s = String(v).trim().toLowerCase();
      if (['true', '1', 'ja', 'yes'].includes(s)) return true;
      if (['false', '0', 'nein', 'no'].includes(s)) return false;
    }
    // Language models now and then send a list or an object as a JSON string.
    if ((type === 'array' || type === 'object') && typeof v === 'string' && /^\s*[[{]/.test(v)) {
      try {
        const parsed = JSON.parse(v);
        if (fits(parsed, type)) return parsed;
      } catch {
        /* not JSON */
      }
    }
  }
  return INVALID;
}

/**
 * A tool call's arguments checked against the tool's input schema (top-level properties): near misses are converted (a number
 * for a text, "5" for a number, "false" for a boolean, a list or object sent as JSON text), anything else is refused with a German
 * message – instead of reaching the handler and coming back as "x.map is not a function". Unknown properties stay as they are.
 * Used by the MCP endpoint and the in-app agent (services/agent-tools.ts); throws HttpError 400.
 */
export function normalizeArgs(tool: Pick<Tool, 'name' | 'inputSchema'>, input: unknown): Json {
  if (input === undefined || input === null) return {};
  if (!isPlain(input)) throw new HttpError(400, `Die Argumente für ${tool.name} müssen ein Objekt sein`);
  const props: Json = tool.inputSchema?.properties ?? {};
  const out: Json = { ...(input as Json) };
  for (const [k, v] of Object.entries(out)) {
    const s = props[k];
    if (!s || v === undefined || v === null) continue;
    const types: string[] = (Array.isArray(s.type) ? s.type : [s.type]).filter((x: unknown): x is string => typeof x === 'string');
    if (!types.length) continue;
    const fixed = coerce(v, types);
    if (fixed === INVALID) throw new HttpError(400, `Parameter „${k}“ muss ${types.map((x) => TYPE_WORD[x] ?? x).join(' oder ')} sein`);
    out[k] = fixed;
  }
  return out;
}

/**
 * Read-only tools on a read-only connection (agency key or OAuth grant with scope "read"): a few of them ask the API with a POST
 * that does not change anything (reports, calculations, a dry run). The relay marks such calls with a one-time token that only
 * this process knows, and the read-only check lets them through (`isReadOnlyToolRelay`). Tools from external MCP servers never get one.
 */
const readToolTokens = new Set<string>();
export function isReadOnlyToolRelay(ctx: Ctx): boolean {
  const t = ctx.req.headers['x-pghl-read-tool'];
  return isRelay(ctx) && typeof t === 'string' && readToolTokens.has(t);
}

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

function keyUser(app: App, k: any): User {
  const creator = (k.created_by && app.db.get('SELECT * FROM users WHERE id = ?', k.created_by)) || app.db.get(`SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`);
  return { id: creator?.id ?? `key:${k.id}`, email: creator?.email ?? '', name: `API: ${k.name}`, role: 'admin', locations: [], permissions: null };
}

export const mcpModule: Module = {
  name: 'mcp',
  migrations: [
    [
      '001-init',
      `CREATE TABLE agency_api_keys (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL DEFAULT 'write',
        created_by TEXT, created_at TEXT NOT NULL, last_used_at TEXT
      );`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    // MCP is authenticated inside the handler (bearer key): tool arguments get the logged-in limit.
    app.services.bodyLimits = [
      ...(app.services.bodyLimits ?? []),
      {
        // Only with a known key: without one the request stays at the small public limit.
        match: (m: string, p: string, req: { headers: Record<string, any> }) => {
          if (m !== 'POST' || p !== '/mcp') return false;
          const bearer = String(req.headers.authorization ?? '').match(/^Bearer\s+(pghla?_\S+)$/i)?.[1];
          return !!bearer && !!db.get(`SELECT 1 AS x FROM ${bearer.startsWith('pghla_') ? 'agency_api_keys' : 'api_keys'} WHERE key_hash = ?`, sha256(bearer));
        },
        bytes: 12 * 1024 * 1024,
      },
    ];

    // Agency keys: act as an admin across all sub-accounts (location via x-location-id).
    app.bearerAuth.push((ctx: Ctx, tokenValue: string, auth) => {
      if (!tokenValue.startsWith('pghla_')) return false;
      const k = db.get('SELECT * FROM agency_api_keys WHERE key_hash = ?', sha256(tokenValue));
      if (!k) throw new HttpError(401, 'Ungültiger Agentur-Schlüssel');
      if (k.scope === 'read' && ctx.method !== 'GET' && !isReadOnlyToolRelay(ctx)) throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
      db.run('UPDATE agency_api_keys SET last_used_at = ? WHERE id = ?', now(), k.id);
      ctx.user = keyUser(app, k);
      ctx.viaApiKey = true;
      ctx.scope = k.scope;
      ctx.via = isRelay(ctx) ? 'mcp' : 'agency_key';
      if (auth === 'location') {
        const loc = String(ctx.req.headers['x-location-id'] ?? ctx.query.get('locationId') ?? '');
        if (!loc) throw new HttpError(400, 'Kein Sub-Account gewählt (x-location-id)');
        if (!app.location(loc)) throw new HttpError(404, 'Sub-Account nicht gefunden');
        ctx.locationId = loc;
      }
      return true;
    });

    // Keys manage data, not people, other keys, personal connections/devices or whole-database backups
    // (a leaked key must not be able to download password hashes and 2FA secrets).
    const KEY_BLOCKED = /^\/api\/(users|me|agency\/api-keys|auth|admin\/backups?|oauth|push|mobile\/(pair|devices|logout))(\/|$)/;
    app.guards.push((ctx) => {
      if ((ctx.via === 'agency_key' || ctx.via === 'mcp') && KEY_BLOCKED.test(ctx.path)) throw new HttpError(403, 'Mit einem Agentur-Schlüssel nicht erlaubt');
    });

    router.get('/api/agency/api-keys', 'admin', () => db.all('SELECT id, name, prefix, scope, created_at, last_used_at FROM agency_api_keys ORDER BY created_at DESC'));
    router.post('/api/agency/api-keys', 'admin', (ctx) => {
      if (ctx.viaApiKey) throw new HttpError(403, 'Schlüssel nur mit Anmeldung anlegen');
      const key = `pghla_${token(32)}`;
      const row = { id: id(), name: str(ctx.body.name, 'Name', { required: true, max: 100 }), prefix: key.slice(0, 12), key_hash: sha256(key), scope: ctx.body.scope === 'read' ? 'read' : 'write', created_by: ctx.user?.id ?? null, created_at: now() };
      db.insert('agency_api_keys', row);
      const { key_hash: _h, ...out } = row;
      return { ...out, key, mcp_url: `${app.baseUrl()}/mcp` };
    });
    router.delete('/api/agency/api-keys/:id', 'admin', (ctx) => {
      if (!db.run('DELETE FROM agency_api_keys WHERE id = ?', ctx.params.id).changes) throw notFound();
      return { ok: true };
    });

    // --- MCP endpoint -------------------------------------------------------------------
    // ghl_send_message offers every channel a module added to POST /api/messages (Telegram, Discord, push…).
    const withChannels = (t: Tool): Tool => {
      if (t.name !== 'ghl_send_message') return t;
      const extra = Object.keys(app.services.messageChannels ?? {});
      const channel = { ...t.inputSchema.properties.channel, enum: [...new Set(['email', 'sms', ...extra])] };
      return { ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, channel } } };
    };
    const tools = (): Tool[] => [...TOOLS.map(withChannels), ...(app.services.mcpTools ?? [])];
    // Tools that depend on who calls (e.g. external MCP servers re-exposed per sub-account, modules/mcp-client.ts):
    // app.services.mcpToolSources = [...(…), async (caller) => Tool[]]. A failing source only drops its own tools.
    const callerTools = async (c: Caller): Promise<Tool[]> => {
      const out: Tool[] = [];
      for (const src of (app.services.mcpToolSources ?? []) as ((c: Caller) => Promise<Tool[]>)[]) {
        try {
          out.push(...(await src(c)));
        } catch (e) {
          console.error('[mcpToolSources]', (e as Error).message);
        }
      }
      return out;
    };
    router.get('/mcp', 'public', () => ({ __raw: true, status: 405, headers: { allow: 'POST', 'content-type': 'application/json' }, body: JSON.stringify({ error: 'MCP: bitte POST (Streamable HTTP, JSON)' }) }));
    router.delete('/mcp', 'public', () => ({ __raw: true, status: 405, headers: { allow: 'POST' }, body: '' }));
    router.post('/mcp', 'public', async (ctx) => {
      const auth = String(ctx.req.headers.authorization ?? '');
      const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
      let caller: Caller | null = null;
      if (bearer.startsWith('pghla_')) {
        const k = db.get('SELECT * FROM agency_api_keys WHERE key_hash = ?', sha256(bearer));
        if (k) caller = { agency: true, api: () => Promise.resolve() } as any;
      } else if (bearer.startsWith('pghl_')) {
        const k = db.get('SELECT * FROM api_keys WHERE key_hash = ?', sha256(bearer));
        if (k) caller = { agency: false, locationId: k.location_id, api: () => Promise.resolve() } as any;
      } else if (bearer) {
        // Other credentials, e.g. OAuth access tokens (modules/mcp-oauth.ts): same scoping as the keys.
        for (const resolve of (app.services.mcpAuth ?? []) as ((b: string) => { agency: boolean; locationId?: string } | null)[]) {
          const r = resolve(bearer);
          if (r) {
            caller = { agency: r.agency, locationId: r.agency ? undefined : r.locationId, api: () => Promise.resolve() } as any;
            break;
          }
        }
      }
      if (!caller) {
        // The challenge points MCP clients to the OAuth metadata (when the OAuth module is there).
        const challenge: string = app.services.mcpChallenge?.(ctx, bearer ? 'invalid_token' : undefined) ?? 'Bearer realm="gohigh"';
        return { __raw: true, status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': challenge }, body: JSON.stringify({ error: bearer ? 'Schlüssel oder Token ungültig oder abgelaufen' : 'Authorization: Bearer <Schlüssel oder OAuth-Token> fehlt' }) };
      }
      const c = caller;
      const relay = async (method: string, path: string, opts: { body?: unknown; location?: string } = {}, readToken = '') => {
        const location = c.agency ? opts.location : c.locationId;
        if (!c.agency && opts.location && opts.location !== c.locationId) throw new HttpError(403, 'Dieser Schlüssel gilt nur für einen Sub-Account');
        const r = await fetch(app.selfUrl + path, {
          method,
          headers: {
            authorization: `Bearer ${bearer}`,
            'x-pghl-via': 'mcp',
            ...(location ? { 'x-location-id': location } : {}),
            ...(readToken ? { 'x-pghl-read-tool': readToken } : {}),
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
        const data = await r.json().catch(() => null);
        // An agency connection reaches every sub-account: a tool without location_id cannot know which one is meant.
        if (!r.ok && c.agency && !location && r.status === 400 && /^Kein Sub-Account gewählt/.test(String(data?.error ?? ''))) throw new HttpError(400, 'location_id fehlt – mit einem Agentur-Zugang bitte location_id angeben (aus ghl_list_projects)');
        if (!r.ok) throw new HttpError(r.status, data?.error ?? `HTTP ${r.status}`);
        return data;
      };
      c.api = (method, path, opts = {}) => relay(method, path, opts);

      const handleOne = async (msg: any): Promise<any | null> => {
        const isNotification = msg && msg.id === undefined;
        try {
          if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') throw new RpcError(-32600, 'Ungültige JSON-RPC-Anfrage');
          let result: any;
          switch (msg.method) {
            case 'initialize': {
              const wanted = msg.params?.protocolVersion;
              result = {
                protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'gohigh', title: app.services.brandName?.() ?? 'HyperLevel', version: APP_VERSION },
                instructions: c.agency
                  ? 'Agentur-CRM: Jedes Projekt ist ein Sub-Account (location_id). Starte mit ghl_list_projects. Schreibende Tools wirken sofort und landen im Protokoll. Social-Posts standardmäßig als Entwurf anlegen; ghl_send_message verschickt echt.'
                  : `CRM eines einzelnen Sub-Accounts (location_id ${c.locationId}) – andere Sub-Accounts sind mit dieser Verbindung nicht erreichbar. Starte mit ghl_list_projects. Schreibende Tools wirken sofort und landen im Protokoll. Social-Posts standardmäßig als Entwurf anlegen; ghl_send_message verschickt echt.`,
              };
              break;
            }
            case 'ping':
              result = {};
              break;
            case 'tools/list':
              result = {
                tools: [...tools(), ...(await callerTools(c))]
                  .filter((t) => c.agency || !t.agencyOnly)
                  .map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } })),
              };
              break;
            case 'tools/call': {
              const name = msg.params?.name;
              if (typeof name !== 'string' || !name) throw new RpcError(-32602, 'Tool-Name fehlt (params.name)');
              const own = tools().find((x) => x.name === name);
              const t = own ?? (name.startsWith('ext_') ? (await callerTools(c)).find((x) => x.name === name) : undefined);
              if (!t || (!c.agency && t.agencyOnly)) throw new RpcError(-32602, `Unbekanntes Tool: ${name.slice(0, 100)}`);
              let args: Json;
              try {
                args = normalizeArgs(t, msg.params?.arguments);
              } catch (e) {
                throw new RpcError(-32602, (e as Error).message);
              }
              checkArgs(t, args);
              const readToken = own && t.annotations.readOnlyHint ? token(16) : '';
              if (readToken) readToolTokens.add(readToken);
              try {
                // A connection for one sub-account cannot be pointed at another one (also by tools that leave location_id to the key).
                if (!c.agency && args.location_id !== undefined && args.location_id !== null && args.location_id !== '' && String(args.location_id) !== c.locationId) throw new HttpError(403, 'Dieser Schlüssel gilt nur für einen Sub-Account');
                const out = await t.run(readToken ? { ...c, api: (method, path, opts = {}) => relay(method, path, opts, readToken) } : c, args);
                const textOut = JSON.stringify(out ?? { ok: true });
                result = { content: [{ type: 'text', text: textOut.length > 60_000 ? `${textOut.slice(0, 60_000)}… (gekürzt – Filter/limit nutzen)` : textOut }], isError: false };
                if (out && typeof out === 'object' && !Array.isArray(out)) result.structuredContent = out;
              } catch (e) {
                const status = e instanceof HttpError ? ` (${e.status})` : '';
                result = { content: [{ type: 'text', text: `Fehler${status}: ${(e as Error).message}` }], isError: true };
              } finally {
                if (readToken) readToolTokens.delete(readToken);
              }
              break;
            }
            default:
              if (msg.method.startsWith('notifications/')) return null;
              throw new RpcError(-32601, `Methode nicht unterstützt: ${msg.method}`);
          }
          return isNotification ? null : { jsonrpc: '2.0', id: msg.id, result };
        } catch (e) {
          if (isNotification) return null;
          const code = e instanceof RpcError ? e.code : -32603;
          return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message: (e as Error).message } };
        }
      };

      let payload: any;
      try {
        payload = JSON.parse(ctx.rawBody || 'null');
      } catch {
        return { __raw: true, status: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
      }
      const batch = Array.isArray(payload);
      const results = (await Promise.all((batch ? payload : [payload]).map(handleOne))).filter((r) => r !== null);
      if (!results.length) return { __raw: true, status: 202, headers: {}, body: '' };
      return { __raw: true, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch ? results : results[0]) };
    });
  },
};
