import type { App, Module } from '../core/app.js';
import { render } from '../core/template.js';
import { NOTION_TOKEN, NOTION_VERSION, connectorFetch, notionBlocks, notionPageId, readJson, registerConnector, type ConnectorConfig } from '../services/connectors.js';

/**
 * Native connector Notion: an internal integration token (secret_…/ntn_…) and a default page.
 * Workflow action "Notion-Seite ergänzen" (`notion_append`) appends a heading and paragraphs
 * (merge fields allowed) to that page or another one shared with the integration.
 */

const API = 'https://api.notion.com/v1';

const notion = (app: App, token: string, method: string, path: string, body?: unknown) =>
  connectorFetch(app)(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'notion-version': NOTION_VERSION, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 15_000,
    maxBytes: 512 * 1024,
  }).then((r) => readJson(r, 'Notion'));

async function test(app: App, cfg: ConnectorConfig): Promise<string> {
  const me = await notion(app, cfg.token, 'GET', '/users/me');
  let page = '';
  if (cfg.page_id) {
    const id = notionPageId(cfg.page_id);
    if (!id) throw new Error('Seiten-ID ungültig');
    await notion(app, cfg.token, 'GET', `/pages/${id}`);
    page = ' · Seite erreichbar';
  }
  return `Verbunden als ${String(me?.name ?? me?.bot?.owner?.workspace_name ?? 'Integration').slice(0, 60)}${page}`;
}

export const connectorNotionModule: Module = {
  name: 'connector-notion',
  register(app) {
    registerConnector(app, {
      key: 'notion',
      name: 'Notion (Token)',
      category: 'Produktivität',
      icon: 'doc',
      description: 'Notizen, Lead-Infos oder KI-Texte aus Workflows an eine Notion-Seite anhängen – mit eigenem Integrations-Token.',
      credentials: 'Internal-Integration-Token (secret_…/ntn_…) und Standard-Seite unter Apps → Direkt-Verbindungen; die Seite muss mit der Integration geteilt sein.',
      fields: [
        { key: 'token', label: 'Integrations-Token', secret: true, required: true, pattern: NOTION_TOKEN, patternHint: 'Notion-Tokens beginnen mit secret_ oder ntn_', placeholder: 'ntn_…', help: 'notion.so/my-integrations → Neue Integration (intern) → „Internal Integration Secret“.' },
        { key: 'page_id', label: 'Standard-Seite (Link oder ID)', required: true, max: 300, placeholder: 'https://www.notion.so/…', help: 'Auf der Seite: ••• → Verbindungen → deine Integration hinzufügen.' },
      ],
      test,
      steps: ['Notion-Seite ergänzen'],
      guide: ['notion.so/my-integrations: neue interne Integration anlegen und das Secret kopieren.', 'Die Zielseite in Notion öffnen → ••• → Verbindungen → Integration hinzufügen.', 'Token und Seiten-Link unter Apps → Direkt-Verbindungen → Notion eintragen und testen.'],
      actions: {
        notion_append: async (a, cfg, _run, step, vars) => {
          const page = notionPageId(step.page_id ? render(String(step.page_id), vars) : cfg.page_id);
          if (!page) throw new Error('Notion-Seite fehlt oder ist ungültig');
          const blocks = notionBlocks(render(String(step.text ?? ''), vars), step.heading ? render(String(step.heading), vars) : undefined);
          if (!blocks.length) throw new Error('Kein Text für Notion');
          await notion(a, cfg.token, 'PATCH', `/blocks/${page}/children`, { children: blocks });
          return `Notion: ${blocks.length} ${blocks.length === 1 ? 'Block' : 'Blöcke'} angehängt`;
        },
      },
    });
  },
};
