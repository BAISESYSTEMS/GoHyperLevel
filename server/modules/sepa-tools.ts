import type { Module } from '../core/app.js';
import type { Tool } from './mcp.js';

/**
 * Read-only MCP tools for SEPA (docs/sepa.md): mandates and collection/transfer runs. Thin relays onto the /api/sepa routes,
 * so rights and sub-account scope are the same as in the app. IBANs come back masked.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS: Tool[] = [
  {
    name: 'ghl_sepa_mandates',
    title: 'SEPA-Mandate auflisten',
    description:
      'SEPA-Lastschriftmandate des Sub-Accounts: Kontakt, Mandatsreferenz, Art (CORE/B2B, wiederkehrend/einmalig), Status (pending = wartet auf Online-Unterschrift, active, suspended, revoked, expired, used, final), nächster Sequenztyp (FRST/RCUR/OOFF/FNAL), IBAN maskiert, Unterschriftsdatum, letzte Nutzung und Ablauf (36 Monate ohne Einzug). Filter: status (auch "ended"), contact_id, q (Suche).',
    inputSchema: { type: 'object', properties: { ...LOC, status: { type: 'string', enum: ['pending', 'active', 'suspended', 'ended'] }, contact_id: { type: 'string' }, q: { type: 'string' } }, additionalProperties: false },
    annotations: RO,
    run: (call, a) => {
      const qs = new URLSearchParams();
      for (const k of ['status', 'contact_id', 'q']) if (a[k]) qs.set(k, String(a[k]));
      return call.api('GET', `/api/sepa/mandates${qs.size ? `?${qs}` : ''}`, { location: a.location_id });
    },
  },
  {
    name: 'ghl_sepa_runs',
    title: 'SEPA-Läufe und offene Lastschriften',
    description:
      'Ohne run_id: Überblick (Gläubiger-ID gesetzt?, Mandate, einziehbare Rechnungen, eingereichte und zurückgegebene Lastschriften) und die letzten Läufe (Lastschrift pain.008 / Überweisung pain.001) mit Status, Fälligkeit, Anzahl und Summe. Mit run_id: ein Lauf mit allen Posten (Rechnung, Betrag, Sequenztyp, Status, Rückgabegrund).',
    inputSchema: { type: 'object', properties: { ...LOC, run_id: { type: 'string' } }, additionalProperties: false },
    annotations: RO,
    run: async (call, a) => {
      if (a.run_id) return call.api('GET', `/api/sepa/runs/${encodeURIComponent(a.run_id)}`, { location: a.location_id });
      const [overview, runs] = await Promise.all([call.api('GET', '/api/sepa/overview', { location: a.location_id }), call.api('GET', '/api/sepa/runs?limit=20', { location: a.location_id })]);
      return { overview, runs };
    },
  },
];

export const sepaToolsModule: Module = {
  name: 'sepa-tools',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
