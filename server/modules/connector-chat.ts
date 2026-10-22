import type { App, Module } from '../core/app.js';
import { render } from '../core/template.js';
import { DISCORD_WEBHOOK, SLACK_WEBHOOK, connectorFetch, discordPayload, registerConnector, slackPayload, type ConnectorConfig } from '../services/connectors.js';

/**
 * Native connectors Slack and Discord (incoming webhooks, no Composio needed) and the workflow
 * action "Benachrichtigung an Slack/Discord" (`chat_notify`). A step may name another webhook URL
 * of the same service (another channel) instead of the saved one.
 */

type Service = 'slack' | 'discord';
const LABEL: Record<Service, string> = { slack: 'Slack', discord: 'Discord' };

async function post(app: App, service: Service, url: string, text: string, title?: string): Promise<string> {
  const ok = service === 'slack' ? SLACK_WEBHOOK.test(url) : DISCORD_WEBHOOK.test(url);
  if (!ok) throw new Error(`${LABEL[service]}-Webhook-URL ungültig`);
  const body = JSON.stringify(service === 'slack' ? slackPayload(text, title) : discordPayload(text, title, 'HyperLevel'));
  const r = await connectorFetch(app)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, timeoutMs: 15_000, maxBytes: 64 * 1024 });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 120);
    if (r.status === 404 || r.status === 410) throw new Error(`${LABEL[service]}: Webhook gibt es nicht mehr (${r.status}) – neue URL eintragen`);
    throw new Error(`${LABEL[service]} antwortet ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  return `${LABEL[service]}: gesendet`;
}

export const connectorChatModule: Module = {
  name: 'connector-chat',
  register(app) {
    const fields = (service: Service) => [
      {
        key: 'webhook_url',
        label: 'Incoming-Webhook-URL',
        secret: true,
        required: true,
        max: 400,
        pattern: service === 'slack' ? SLACK_WEBHOOK : DISCORD_WEBHOOK,
        placeholder: service === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://discord.com/api/webhooks/…',
        patternHint: service === 'slack' ? 'Slack-Webhook-URLs beginnen mit https://hooks.slack.com/services/' : 'Discord-Webhook-URLs beginnen mit https://discord.com/api/webhooks/',
        help: service === 'slack' ? 'Slack → Apps → „Incoming Webhooks“ → Kanal wählen → Webhook-URL kopieren.' : 'Discord → Kanal bearbeiten → Integrationen → Webhooks → Neuer Webhook → URL kopieren.',
      },
    ];
    for (const service of ['slack', 'discord'] as Service[]) {
      registerConnector(app, {
        key: service,
        name: `${LABEL[service]} (Webhook)`,
        category: 'Kommunikation',
        icon: 'chat',
        description: `Benachrichtigungen aus Workflows direkt in einen ${LABEL[service]}-Kanal – ohne Composio, ohne Bot.`,
        credentials: `${LABEL[service]}-Incoming-Webhook-URL unter Apps → Direkt-Verbindungen (wird verschlüsselt gespeichert).`,
        fields: fields(service),
        steps: ['Benachrichtigung an Slack/Discord'],
        test: (a, cfg) => post(a, service, cfg.webhook_url, '✅ HyperLevel ist verbunden – Benachrichtigungen aus Workflows kommen hier an.'),
        guide:
          service === 'slack'
            ? ['In Slack: api.slack.com/apps → App erstellen → „Incoming Webhooks“ aktivieren → „Add New Webhook to Workspace“ → Kanal wählen.', 'Die Webhook-URL unter Apps → Direkt-Verbindungen → Slack eintragen und testen.', 'Im Workflow den Schritt „Benachrichtigung an Slack/Discord“ einfügen.']
            : ['In Discord: Servereinstellungen oder Kanal bearbeiten → Integrationen → Webhooks → „Neuer Webhook“ → URL kopieren.', 'Unter Apps → Direkt-Verbindungen → Discord eintragen und testen.', 'Im Workflow den Schritt „Benachrichtigung an Slack/Discord“ einfügen.'],
      });
    }

    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      chat_notify: async (run: any, step: any, vars: Record<string, any>) => {
        const service: Service = step.service === 'discord' ? 'discord' : 'slack';
        const text = render(String(step.text ?? ''), vars).trim();
        if (!text) throw new Error('Kein Text für die Benachrichtigung');
        const title = step.title ? render(String(step.title), vars) : undefined;
        let url = String(step.webhook_url ?? '').trim();
        if (!url) {
          const cfg: ConnectorConfig | null = app.services.connectorConfig?.(run.location_id, service) ?? null;
          if (!cfg) throw new Error(`${LABEL[service]} ist in diesem Sub-Account nicht eingerichtet (Apps → Direkt-Verbindungen).`);
          url = cfg.webhook_url;
        }
        return post(app, service, url, text, title);
      },
    };
  },
};
