import type { Module } from '../core/app.js';
import { HttpError, notFound, str } from '../core/http.js';
import { render } from '../core/template.js';
import { now } from '../core/util.js';
import { CONTACT_FIELDS, contactName, getContact } from '../services/contacts.js';
import { schemaSummary } from '../services/composio-schema.js';
import { getPath } from '../services/inbound-webhooks.js';
import type { ComposioApi } from './composio.js';
import type { Tool } from './mcp.js';

/**
 * Composio in automations: the workflow action "App-Aktion ausführen (Composio)" (arguments from
 * the action's JSON schema with merge fields, result in the run log, optionally mapped into contact
 * fields), the AI agent that may use the sub-account's allow-listed app actions (on the KI-Assistent's
 * `aiRun`, one structured step per call), its workflow action, and the MCP tool `ghl_app_action`.
 */

const MAX_AGENT_STEPS = 6;
const clip = (v: unknown, n: number) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** Maps values from an action result into contact fields: [{from: "data.id", to: "custom.shop_id"}]. */
export function mapResult(result: unknown, map: unknown): { fields: Record<string, string>; custom: Record<string, string>; skipped: string[] } {
  const fields: Record<string, string> = {};
  const custom: Record<string, string> = {};
  const skipped: string[] = [];
  for (const m of Array.isArray(map) ? map.slice(0, 30) : []) {
    const from = String(m?.from ?? '').trim();
    const to = String(m?.to ?? '').trim();
    if (!from || !to) continue;
    const raw = getPath(result, from);
    if (raw === undefined || raw === null || raw === '') {
      skipped.push(from);
      continue;
    }
    const v = (typeof raw === 'object' ? JSON.stringify(raw) : String(raw)).slice(0, 1000);
    if (to.startsWith('custom.') && /^custom\.[\w-]{1,60}$/.test(to)) custom[to.slice(7)] = v;
    else if ((CONTACT_FIELDS as readonly string[]).includes(to) && !['source', 'assigned_to'].includes(to)) fields[to] = v;
    else skipped.push(to);
  }
  return { fields, custom, skipped };
}

const AGENT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['search', 'execute', 'answer'] },
    query: { type: 'string' },
    toolkit: { type: 'string' },
    tool: { type: 'string' },
    arguments_json: { type: 'string' },
    answer: { type: 'string' },
  },
  required: ['action', 'query', 'toolkit', 'tool', 'arguments_json', 'answer'],
  additionalProperties: false,
};

export interface AgentStep {
  action: 'search' | 'execute' | 'answer';
  detail: string;
  tool?: string;
  ok?: boolean;
}

export const composioAutomationModule: Module = {
  name: 'composio-automation',
  register(app) {
    const composio = (): ComposioApi => {
      const c = app.services.composio as ComposioApi | undefined;
      if (!c) throw new HttpError(404, 'Das Composio-Modul ist nicht installiert.');
      return c;
    };

    // --- workflow action: run one app action -------------------------------------------------------
    const runAction = async (run: any, step: any, vars: Record<string, any>): Promise<string> => {
      const tool = String(step.tool ?? '').trim();
      if (!tool) throw new Error('Keine App-Aktion gewählt');
      const r = await composio().execute(run.location_id, tool, step.arguments ?? {}, { vars, source: 'workflow' });
      if (!r.successful) throw new Error(`${r.tool}: ${r.error ?? 'von der App abgelehnt'}`);
      // Later steps read the result as {{event.app_result.…}}.
      run.event = { ...(run.event ?? {}), app_result: r.data };
      try {
        app.db.run(`UPDATE workflow_runs SET event = json_set(COALESCE(event, '{}'), '$.app_result', json(?)) WHERE id = ?`, clip(r.data, 50_000).endsWith('…') ? '{"truncated":true}' : JSON.stringify(r.data ?? null), run.id);
      } catch {
        /* result too odd for JSON – the log still has it */
      }
      let mapped = '';
      if (Array.isArray(step.map) && step.map.length) {
        const m = mapResult(r.data, step.map);
        const c = getContact(app, run.location_id, run.contact_id);
        if (c && (Object.keys(m.fields).length || Object.keys(m.custom).length)) {
          app.db.update('contacts', c.id, { ...m.fields, ...(Object.keys(m.custom).length ? { custom: { ...c.custom, ...m.custom } } : {}), updated_at: now() });
          mapped = ` · übernommen: ${[...Object.keys(m.fields), ...Object.keys(m.custom).map((k) => `custom.${k}`)].join(', ')}`;
        }
        if (m.skipped.length) mapped += ` · nicht gefunden: ${m.skipped.join(', ')}`;
      }
      return `${r.tool}: OK${mapped} · ${clip(r.data, 400)}`;
    };

    // --- AI agent with allow-listed app actions -----------------------------------------------------
    const toolBlock = async (loc: string, slugs: string[]) => {
      const c = composio();
      const info = c.requireKey(loc);
      const lines: string[] = [];
      for (const s of slugs.slice(0, 12)) {
        try {
          const t = await c.getTool(info, s);
          lines.push(`- ${t.slug} (${t.toolkit.name || t.toolkit.slug}): ${clip(t.description, 200)}\n  Eingaben:\n${schemaSummary(t.input_parameters, 15).replace(/^/gm, '    ')}`);
        } catch {
          lines.push(`- ${s}`);
        }
      }
      return lines.join('\n');
    };

    const runAgent = async (loc: string, task: string, opts: { contactId?: string | null; userId?: string | null; purpose: string }) => {
      const c = composio();
      const aiRun = app.services.aiRun as ((i: Record<string, unknown>) => Promise<{ text: string; model: string }>) | undefined;
      if (!aiRun) throw new HttpError(409, 'Der KI-Assistent ist nicht installiert.');
      const allow = c.allowOf(loc);
      if (!allow.length) throw new HttpError(409, 'Für die KI ist noch keine App-Aktion freigegeben (Apps → Composio → KI & MCP).');
      const explicit = allow.filter((a) => !a.endsWith(':*'));
      const apps = allow.filter((a) => a.endsWith(':*')).map((a) => a.slice(0, -2));
      const contact = opts.contactId ? getContact(app, loc, opts.contactId) : undefined;
      const tools = explicit.length ? await toolBlock(loc, explicit) : '';
      const history: string[] = [];
      const steps: AgentStep[] = [];
      const loc_ = app.location(loc);
      for (let i = 0; i < MAX_AGENT_STEPS; i++) {
        const user = [
          `Du erledigst eine Aufgabe für „${loc_?.name ?? 'diesen Sub-Account'}“ und darfst dafür Aktionen in verbundenen Apps ausführen – ausschließlich die unten erlaubten.`,
          `Aufgabe: ${task}`,
          contact ? `Kontakt: ${contactName(contact)} · E-Mail ${contact.email || '–'} · Telefon ${contact.phone || '–'} · Firma ${contact.company || '–'}` : '',
          tools ? `Erlaubte Aktionen:\n${tools}` : '',
          apps.length ? `Ganze Apps (Aktionen mit action "search" finden, optional toolkit setzen): ${apps.join(', ')}` : '',
          history.length ? `Bisherige Schritte:\n${history.map((h, n) => `${n + 1}. ${h}`).join('\n')}` : 'Noch keine Schritte.',
          `Antworte mit genau einem nächsten Schritt: action "search" (query, toolkit optional), "execute" (tool = Slug, arguments_json = Eingaben als JSON-Objekt-Text) oder "answer" (answer = kurzes Ergebnis auf Deutsch für den Nutzer). Führe nur aus, was die Aufgabe verlangt; erfinde keine Daten. Nicht benötigte Felder als "".${i === MAX_AGENT_STEPS - 1 ? ' Dies ist der letzte Schritt: antworte jetzt mit "answer".' : ''}`,
        ]
          .filter(Boolean)
          .join('\n\n');
        const r = await aiRun({ locationId: loc, purpose: opts.purpose, user, schema: AGENT_SCHEMA, maxTokens: 1500, contactId: opts.contactId ?? null, userId: opts.userId ?? null });
        let s: { action?: string; query?: string; toolkit?: string; tool?: string; arguments_json?: string; answer?: string };
        try {
          s = JSON.parse(r.text);
        } catch {
          s = { action: 'answer', answer: r.text };
        }
        if (s.action === 'answer' || !s.action) {
          const answer = String(s.answer ?? '').trim() || 'Fertig.';
          steps.push({ action: 'answer', detail: answer });
          return { answer, steps };
        }
        if (s.action === 'search') {
          const q = String(s.query ?? '').slice(0, 200);
          const found = await c.searchAllowed(loc, q, s.toolkit || undefined, 8).catch((e: Error) => {
            history.push(`search „${q}“ → Fehler: ${e.message}`);
            return null;
          });
          if (!found) continue;
          const detail = found.length ? await toolBlock(loc, found.slice(0, 5).map((t) => t.slug)) : '(nichts gefunden)';
          history.push(`search „${q}“ → ${found.length} Aktion(en):\n${detail}`);
          steps.push({ action: 'search', detail: `Suche „${q}“: ${found.map((t) => t.slug).join(', ') || 'nichts'}` });
          continue;
        }
        const tool = String(s.tool ?? '').trim();
        let args: unknown = {};
        try {
          args = s.arguments_json ? JSON.parse(s.arguments_json) : {};
        } catch {
          history.push(`execute ${tool} → Fehler: arguments_json ist kein gültiges JSON`);
          continue;
        }
        try {
          const res = await c.execute(loc, tool, args, { enforceAllow: true, source: 'ai' });
          history.push(`execute ${res.tool} → ${res.successful ? `OK: ${clip(res.data, 2500)}` : `abgelehnt: ${res.error}`}`);
          steps.push({ action: 'execute', tool: res.tool, ok: res.successful, detail: res.successful ? clip(res.data, 300) : String(res.error) });
        } catch (e) {
          history.push(`execute ${tool} → Fehler: ${(e as Error).message}`);
          steps.push({ action: 'execute', tool, ok: false, detail: (e as Error).message });
        }
      }
      return { answer: 'Abgebrochen – zu viele Schritte.', steps };
    };
    app.services.composioAgent = runAgent;

    app.router.post('/api/composio/ai', 'location', async (ctx) => {
      const prompt = str(ctx.body.prompt, 'Aufgabe', { required: true, max: 4000 });
      const contactId = str(ctx.body.contact_id, 'Kontakt', { max: 64 }) || null;
      if (contactId && !getContact(app, ctx.locationId, contactId)) throw notFound('Kontakt nicht gefunden');
      return runAgent(ctx.locationId, prompt, { contactId, userId: ctx.user?.id ?? null, purpose: 'app_agent' });
    });

    const runAgentStep = async (run: any, step: any, vars: Record<string, any>): Promise<string> => {
      const prompt = render(String(step.prompt ?? ''), vars).trim();
      if (!prompt) throw new Error('Keine Aufgabe für die KI');
      const r = await runAgent(run.location_id, prompt, { contactId: run.contact_id, purpose: 'workflow' });
      const field = String(step.save_field ?? '');
      if (field.startsWith('custom.') && /^custom\.[\w-]{1,60}$/.test(field)) {
        const c = getContact(app, run.location_id, run.contact_id);
        if (c) app.db.update('contacts', c.id, { custom: { ...c.custom, [field.slice(7)]: r.answer.slice(0, 5000) }, updated_at: now() });
      }
      run.event = { ...(run.event ?? {}), app_answer: r.answer };
      const did = r.steps.filter((s) => s.action === 'execute').map((s) => `${s.tool}${s.ok ? '' : ' (Fehler)'}`);
      return `${did.length ? `Aktionen: ${did.join(', ')} · ` : ''}${clip(r.answer, 400)}`;
    };

    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      composio_action: runAction,
      composio_ai: runAgentStep,
    };
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...mcpTools()];
  },
};

function mcpTools(): Tool[] {
  return [
    {
      name: 'ghl_app_action',
      title: 'App-Aktion (Composio)',
      description:
        'Aktionen in den verbundenen Apps eines Projekts über Composio (Slack, Notion, HubSpot, Shopify, Google Sheets, Calendly …). mode=connections: verbundene Apps; mode=search: freigegebene Aktionen finden (query, optional toolkit) – liefert Slug und Eingaben (input_parameters); mode=execute: Aktion ausführen (tool = Slug aus search, arguments = Objekt nach input_parameters). Nur Aktionen, die im Projekt unter Apps → Composio → KI & MCP freigegeben sind. Ausgeführte Aktionen wirken sofort in der App.',
      inputSchema: {
        type: 'object',
        properties: {
          location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
          mode: { type: 'string', enum: ['connections', 'search', 'execute'] },
          query: { type: 'string', description: 'search: was die Aktion tun soll, z. B. „Nachricht in Slack-Kanal senden“' },
          toolkit: { type: 'string', description: 'search: nur diese App (Slug, z. B. slack)' },
          tool: { type: 'string', description: 'execute: Slug der Aktion, z. B. SLACK_SEND_MESSAGE' },
          arguments: { type: 'object', description: 'execute: Eingaben der Aktion' },
        },
        required: ['location_id', 'mode'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      run: async (call, a) => {
        const location = a.location_id;
        if (a.mode === 'connections') {
          const list: any[] = await call.api('GET', '/api/composio/connections', { location });
          return { apps: list.filter((x) => x.status === 'active').map((x) => ({ toolkit: x.toolkit, name: x.toolkit_name, connected_at: x.created_at })) };
        }
        if (a.mode === 'search') {
          const q = new URLSearchParams();
          if (a.query) q.set('search', String(a.query));
          if (a.toolkit) q.set('toolkit', String(a.toolkit));
          const r = await call.api('GET', `/api/composio/tools?${q}`, { location });
          const items: any[] = r.items ?? [];
          const detailed = [];
          for (const t of items.slice(0, 5)) detailed.push(await call.api('GET', `/api/composio/tools/${encodeURIComponent(t.slug)}`, { location }).catch(() => t));
          return {
            tools: [...detailed.map((t: any) => ({ slug: t.slug, name: t.name, toolkit: t.toolkit?.slug, description: t.description, input_parameters: t.input_parameters })), ...items.slice(5).map((t) => ({ slug: t.slug, name: t.name, toolkit: t.toolkit?.slug, description: t.description }))],
            hint: items.length ? undefined : 'Keine freigegebene Aktion gefunden – im Projekt unter Apps → Composio → KI & MCP freigeben.',
          };
        }
        if (a.mode === 'execute') {
          if (!a.tool) throw new HttpError(400, 'tool fehlt (Slug aus mode=search)');
          return call.api('POST', '/api/composio/execute', { location, body: { tool: a.tool, arguments: a.arguments ?? {} } });
        }
        throw new HttpError(400, 'mode muss connections, search oder execute sein');
      },
    },
  ];
}

