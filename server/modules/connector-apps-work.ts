import type { App, Module } from '../core/app.js';
import { ymdInTz } from '../core/time.js';
import { sha256 } from '../core/util.js';
import { teamOf } from './wfx-crm.js';
import { appCall, appMeta, MAP_FIELD, NANGO_FIELD, qs, saveResult, setVars, usesNango, whenOf, WHEN_FIELDS, type AppSpec } from '../services/app-kit.js';
import { connectorFetch, NOTION_VERSION, notionPageId, readJson, registerConnector, spreadsheetId, type ConnectorConfig } from '../services/connectors.js';
import { addToDate, parseDate, parseNumber } from '../services/formatters.js';
import { registerActionMeta, requireText, rowsOf, text, tzOf, type ActionMeta, type FieldDef } from '../services/wfx-kit.js';

/**
 * Native app steps without Composio, part 1 – work tools: Slack (bot token, post to a channel), Microsoft Teams (webhook),
 * Trello (card), Asana (task), ClickUp (task), Notion (database item, with the existing Notion token), Airtable (create/update
 * record), Google Sheets (append/update row, through the existing Google connection) and Google Calendar (create event, through
 * a connected calendar). Credentials: Apps → Direkt-Verbindungen (or a Nango integration for OAuth). Docs: docs/workflow-actions.md#apps.
 */

/** An optional due date for task tools: a date text, or "in N days". */
function dueOf(app: App, run: any, step: any, vars: Record<string, any>): Date | null {
  const tz = tzOf(app, run.location_id);
  const raw = text(step.due, vars).trim();
  if (raw) {
    const d = parseDate(raw, tz);
    if (!d) throw new Error(`Fälligkeit „${raw.slice(0, 30)}“ ist kein Datum`);
    return d;
  }
  if (step.due_in_days !== undefined && String(step.due_in_days).trim() !== '') return addToDate(new Date(), Number(step.due_in_days) || 0, 'days', tz);
  return null;
}

const DUE_FIELDS: FieldDef[] = [
  { key: 'due', label: 'Fällig am', type: 'text', placeholder: '2026-12-01  ·  {{var.faellig}}', help: 'Datum oder Platzhalter; leer = keine Frist.' },
  { key: 'due_in_days', label: 'oder in … Tagen', type: 'number' },
];

// --- Notion database items (pure) ------------------------------------------------------------------

type NotionProp = { type: string; name?: string };

/** A value written for a Notion property of the given type (Notion's API shape), or throws for types that cannot be filled. */
export function notionValue(prop: NotionProp, raw: string, name: string): unknown {
  const v = raw.trim();
  const list = () => v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  switch (prop.type) {
    case 'title':
      return { title: [{ text: { content: raw.slice(0, 2000) } }] };
    case 'rich_text':
      return { rich_text: [{ text: { content: raw.slice(0, 2000) } }] };
    case 'number': {
      const n = parseNumber(v);
      if (Number.isNaN(n)) throw new Error(`Notion-Eigenschaft „${name}“: „${v.slice(0, 30)}“ ist keine Zahl`);
      return { number: n };
    }
    case 'select':
      return v ? { select: { name: v.slice(0, 100) } } : { select: null };
    case 'status':
      return { status: { name: v.slice(0, 100) } };
    case 'multi_select':
      return { multi_select: list().map((x) => ({ name: x.slice(0, 100) })) };
    case 'checkbox':
      return { checkbox: /^(1|true|ja|yes|an|on|x)$/i.test(v) };
    case 'date':
      return v ? { date: { start: v.slice(0, 40) } } : { date: null };
    case 'email':
      return { email: v || null };
    case 'phone_number':
      return { phone_number: v || null };
    case 'url':
      return { url: v || null };
    default:
      throw new Error(`Notion-Eigenschaft „${name}“ (Typ ${prop.type}) lässt sich hier nicht befüllen`);
  }
}

/** Notion `properties` from the step's rows, using the database schema for the types (names match ignoring case). */
export function notionProperties(schema: Record<string, NotionProp>, rows: { property: string; value: string }[], title?: string): Record<string, unknown> {
  const byLower = new Map(Object.entries(schema).map(([n, p]) => [n.toLowerCase(), n] as const));
  const out: Record<string, unknown> = {};
  if (title !== undefined && title !== '') {
    const t = Object.entries(schema).find(([, p]) => p.type === 'title');
    if (!t) throw new Error('Die Datenbank hat keine Titel-Spalte');
    out[t[0]] = notionValue(t[1], title, t[0]);
  }
  for (const r of rows) {
    const real = byLower.get(String(r.property).trim().toLowerCase());
    if (!real) throw new Error(`Notion-Datenbank hat keine Spalte „${String(r.property).slice(0, 40)}“ (vorhanden: ${Object.keys(schema).slice(0, 8).join(', ')})`);
    out[real] = notionValue(schema[real], String(r.value ?? ''), real);
  }
  return out;
}

// --- Airtable / Sheets helpers (pure) --------------------------------------------------------------

/** `{Feld}="wert"` for filterByFormula, with quotes in the value escaped. */
export function airtableMatch(field: string, value: string): string {
  const f = field.replace(/[{}]/g, '').trim();
  return `{${f}}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Column letters to a 0-based index (A=0, Z=25, AA=26). */
export function colIndex(letters: string): number {
  const s = letters.trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(s)) throw new Error(`„${letters}“ ist keine Spalte (A, B, … AA)`);
  return [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}
export const colLetters = (i: number): string => {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};
/** A1 range with a quoted sheet name. */
export const a1 = (sheet: string, range: string) => (sheet ? `'${sheet.replace(/'/g, "''")}'!${range}` : range);

// --- Slack -----------------------------------------------------------------------------------------

const SLACK_ERRORS: Record<string, string> = {
  channel_not_found: 'Kanal nicht gefunden – Namen (#kanal) oder Kanal-ID prüfen',
  not_in_channel: 'Der Bot ist nicht im Kanal – dort „/invite @DeinBot“ eingeben',
  invalid_auth: 'Token ungültig',
  token_revoked: 'Token wurde widerrufen',
  account_inactive: 'Das Konto ist deaktiviert',
  missing_scope: 'Dem Bot fehlt die Berechtigung chat:write (öffentliche Kanäle ohne Einladung: chat:write.public)',
  is_archived: 'Der Kanal ist archiviert',
  msg_too_long: 'Die Nachricht ist zu lang',
  no_text: 'Kein Text',
  ratelimited: 'Zu viele Anfragen – später erneut versuchen',
};

const slackSpec: AppSpec = { name: 'Slack', base: () => 'https://slack.com/api', headers: (c): Record<string, string> => (c.token ? { authorization: `Bearer ${c.token}` } : {}) };

// --- Trello / Asana / ClickUp ---------------------------------------------------------------------

const trelloSpec: AppSpec = { name: 'Trello', base: () => 'https://api.trello.com/1', query: (c): Record<string, string> => (c.api_key && c.token ? { key: c.api_key, token: c.token } : {}), nangoPrefix: '/1' };
const asanaSpec: AppSpec = { name: 'Asana', base: () => 'https://app.asana.com/api/1.0', headers: (c): Record<string, string> => (c.token ? { authorization: `Bearer ${c.token}` } : {}), nangoPrefix: '/api/1.0' };
const clickupSpec: AppSpec = { name: 'ClickUp', base: () => 'https://api.clickup.com/api/v2', headers: (c): Record<string, string> => (c.token ? { authorization: c.token } : {}), nangoPrefix: '/api/v2' };
const airtableSpec: AppSpec = { name: 'Airtable', base: () => 'https://api.airtable.com/v0', headers: (c): Record<string, string> => (c.token ? { authorization: `Bearer ${c.token}` } : {}), nangoPrefix: '/v0' };

const needToken = (cfg: ConnectorConfig, what: string) => {
  if (!usesNango(cfg) && !cfg.token) throw new Error(`${what}: Token fehlt (Apps → Direkt-Verbindungen)`);
};

export const connectorAppsWorkModule: Module = {
  name: 'connector-apps-work',
  register(app) {
    const metas: ActionMeta[] = [];
    const meta = (m: ReturnType<typeof appMeta>) => void metas.push(m);
    const loc = (run: any) => run.location_id as string;

    // ---- Slack bot ----------------------------------------------------------------------------
    registerConnector(app, {
      key: 'slack_bot',
      name: 'Slack (Bot-Token)',
      category: 'Kommunikation',
      icon: 'slack',
      description: 'Nachrichten in beliebige Slack-Kanäle posten – mit einem Bot-Token statt einer Webhook-URL je Kanal.',
      credentials: 'Bot-Token (xoxb-…) einer Slack-App mit chat:write unter Apps → Direkt-Verbindungen; optional ein Standardkanal.',
      guide: ['api.slack.com/apps: neue App → OAuth & Permissions → Bot Token Scope „chat:write“ (und „chat:write.public“ für Kanäle ohne Einladung) → App installieren.', 'Den „Bot User OAuth Token“ (xoxb-…) hier eintragen, optional einen Standardkanal wie #vertrieb.', 'Im Workflow „Slack: Nachricht in Kanal“ – Kanal und Text mit Platzhaltern.'],
      fields: [
        { key: 'token', label: 'Bot-Token', secret: true, max: 200, pattern: /^xox[bp]-[\w-]{10,}$/, patternHint: 'Slack-Bot-Tokens beginnen mit xoxb-', placeholder: 'xoxb-…' },
        { key: 'default_channel', label: 'Standardkanal', max: 100, placeholder: '#vertrieb oder C0123456', help: 'Kanalname mit # oder die Kanal-ID.' },
        NANGO_FIELD,
      ],
      steps: ['Slack: Nachricht in Kanal'],
      test: async (a, cfg) => {
        needToken(cfg, 'Slack');
        const r = await appCall(a, '', cfg, slackSpec, { method: 'POST', path: '/auth.test', body: {} });
        if (!r.data?.ok) throw new Error(`Slack: ${SLACK_ERRORS[r.data?.error] ?? r.data?.error ?? 'Antwort ungültig'}`);
        return `Verbunden als ${String(r.data.user ?? 'Bot')} in ${String(r.data.team ?? 'Slack')}`;
      },
      actions: {
        slack_post_message: async (a, cfg, run, step, vars) => {
          needToken(cfg, 'Slack');
          const channel = text(step.channel, vars).trim() || cfg.default_channel;
          if (!channel) throw new Error('Kanal fehlt (im Schritt oder als Standardkanal)');
          const body = (step.title ? `*${text(step.title, vars).trim()}*\n` : '') + text(step.text, vars);
          if (!body.trim()) throw new Error('Kein Text');
          const r = await appCall(a, loc(run), cfg, slackSpec, { method: 'POST', path: '/chat.postMessage', body: { channel, text: body.slice(0, 3900), unfurl_links: !!step.unfurl, ...(step.thread_ts ? { thread_ts: text(step.thread_ts, vars) } : {}) } });
          if (!r.data?.ok) throw new Error(`Slack: ${SLACK_ERRORS[r.data?.error] ?? r.data?.error ?? 'Antwort ungültig'}`);
          return setVars({ result: `Slack: in ${channel} gepostet`, output: { ts: r.data.ts, channel: r.data.channel } }, { slack_ts: r.data.ts, slack_channel: r.data.channel });
        },
      },
    });
    meta(appMeta('Slack', { type: 'slack_post_message', label: 'Slack: Nachricht in Kanal', summary: 'Postet eine Nachricht in einen Slack-Kanal (Bot-Token).', doc: 'Kanal als #name oder ID (leer = Standardkanal der Verbindung). Text mit Platzhaltern, optional fetter Titel; mit „Thread-Zeitstempel“ antwortest du in einem Thread ({{var.slack_ts}} aus einer früheren Nachricht). Der Bot muss im Kanal sein (oder chat:write.public haben). Für einfache Benachrichtigungen reicht auch der Webhook-Schritt „Benachrichtigung an Slack/Discord“.', icon: 'slack', needs: 'Apps → Direkt-Verbindungen → Slack (Bot-Token)', keywords: 'slack kanal channel chat nachricht bot', fields: [{ key: 'channel', label: 'Kanal', type: 'text', placeholder: '#vertrieb' }, { key: 'title', label: 'Titel (fett)', type: 'text' }, { key: 'text', label: 'Text', type: 'textarea', default: 'Neuer Lead: {{contact.name}} ({{contact.email}})', required: true }, { key: 'thread_ts', label: 'Antwort in Thread (ts)', type: 'text', placeholder: '{{var.slack_ts}}' }, { key: 'unfurl', label: 'Link-Vorschau zeigen', type: 'bool' }], provides: ['var.slack_ts', 'var.slack_channel'], sample: { channel: '#vertrieb', text: 'Neuer Lead: {{contact.name}}' } }));

    // ---- Microsoft Teams --------------------------------------------------------------------------
    const TEAMS = /^https:\/\/(?:[\w-]+\.webhook\.office\.com\/webhook(?:b2|2)?\/|outlook\.office\.com\/webhook\/|[\w.-]+\.logic\.azure\.com(?::443)?\/workflows\/|[\w.-]+\.powerplatform\.com(?::443)?\/powerautomate\/automations\/)[\w@./?=&%+~:,-]{10,800}$/;
    const teamsCard = (title: string, body: string, link?: { title: string; url: string }) => ({
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [...(title ? [{ type: 'TextBlock', text: title.slice(0, 200), weight: 'Bolder', size: 'Medium', wrap: true }] : []), { type: 'TextBlock', text: body.slice(0, 3800) || ' ', wrap: true }],
            ...(link ? { actions: [{ type: 'Action.OpenUrl', title: link.title.slice(0, 40) || 'Öffnen', url: link.url }] } : {}),
          },
        },
      ],
    });
    const teamsPost = async (a: App, url: string, title: string, body: string, link?: { title: string; url: string }) => {
      if (!TEAMS.test(url)) throw new Error('Teams-Webhook-URL ungültig (erwartet: …webhook.office.com/… oder die URL aus einem Workflows-Webhook)');
      const r = await connectorFetch(a)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(teamsCard(title, body, link)), timeoutMs: 15_000, maxBytes: 64 * 1024 });
      if (!r.ok) {
        const detail = (await r.text()).slice(0, 140);
        if (r.status === 404 || r.status === 410) throw new Error(`Teams: Webhook gibt es nicht mehr (${r.status}) – neue URL eintragen`);
        throw new Error(`Teams antwortet ${r.status}${detail ? `: ${detail}` : ''}`);
      }
    };
    registerConnector(app, {
      key: 'teams',
      name: 'Microsoft Teams (Webhook)',
      category: 'Kommunikation',
      icon: 'chat',
      description: 'Nachrichten als Karte in einen Teams-Kanal posten – über einen Workflows-/Incoming-Webhook.',
      credentials: 'Webhook-URL des Kanals (Teams → Kanal → Workflows „Beim Eingang einer Webhookanforderung in einem Kanal posten“) unter Apps → Direkt-Verbindungen.',
      guide: ['In Teams im Kanal: ••• → Workflows → „Beim Eingang einer Webhookanforderung in einem Kanal posten“ einrichten (oder – falls noch verfügbar – den Konnektor „Incoming Webhook“).', 'Die erzeugte URL hier eintragen und „Verbindung testen“ klicken.', 'Im Workflow „Teams: Nachricht in Kanal“.'],
      fields: [{ key: 'webhook_url', label: 'Webhook-URL', secret: true, required: true, max: 900, pattern: TEAMS, patternHint: 'Teams-Webhook-URL erwartet (…webhook.office.com/… oder Workflows-URL)', placeholder: 'https://…webhook.office.com/…' }],
      steps: ['Teams: Nachricht in Kanal'],
      test: async (a, cfg) => {
        await teamsPost(a, cfg.webhook_url, 'HyperLevel', 'Verbindung getestet ✓');
        return 'Test-Nachricht gesendet';
      },
      actions: {
        teams_post: async (a, cfg, _run, step, vars) => {
          const url = text(step.webhook_url, vars).trim() || cfg.webhook_url;
          const body = text(step.text, vars);
          if (!body.trim() && !step.title) throw new Error('Kein Text');
          const link = step.link_url ? { title: text(step.link_title, vars) || 'Öffnen', url: text(step.link_url, vars) } : undefined;
          if (link && !/^https:\/\//.test(link.url)) throw new Error('Der Link muss mit https:// beginnen');
          await teamsPost(a, url, text(step.title, vars), body, link);
          return 'Teams: gesendet';
        },
      },
    });
    meta(appMeta('Microsoft Teams', { type: 'teams_post', label: 'Teams: Nachricht in Kanal', summary: 'Postet eine Karte mit Titel, Text und optionalem Link in einen Teams-Kanal.', doc: 'Nutzt die Webhook-URL der Verbindung (oder eine andere URL für einen anderen Kanal). Titel und Text mit Platzhaltern; ein optionaler Button öffnet einen https-Link, z. B. den Kontakt im CRM.', icon: 'chat', needs: 'Apps → Direkt-Verbindungen → Microsoft Teams', keywords: 'teams microsoft kanal chat webhook', fields: [{ key: 'title', label: 'Titel', type: 'text', default: 'Neuer Lead' }, { key: 'text', label: 'Text', type: 'textarea', default: '{{contact.name}} ({{contact.email}})', required: true }, { key: 'link_title', label: 'Button-Text', type: 'text', default: 'Öffnen' }, { key: 'link_url', label: 'Button-Link (https)', type: 'text' }, { key: 'webhook_url', label: 'Andere Webhook-URL (optional)', type: 'text' }], sample: { title: 'Neuer Lead', text: '{{contact.name}}' } }));

    // ---- Trello ---------------------------------------------------------------------------------
    registerConnector(app, {
      key: 'trello',
      name: 'Trello',
      category: 'Produktivität',
      icon: 'kanban',
      description: 'Karten in Trello-Listen anlegen – z. B. für jeden neuen Auftrag.',
      credentials: 'API-Key und Token (trello.com/power-ups/admin) unter Apps → Direkt-Verbindungen; optional die ID der Standard-Liste.',
      guide: ['trello.com/power-ups/admin → neues Power-Up → API-Key; dort „Token“ erzeugen.', 'Key und Token hier eintragen; die Listen-ID steht im JSON einer Karte (…/c/…​.json → idList) oder per Trello-API.', 'Im Workflow „Trello: Karte anlegen“.'],
      fields: [
        { key: 'api_key', label: 'API-Key', max: 100, pattern: /^[a-f0-9]{32}$/i, patternHint: 'Der Key hat 32 Zeichen (0–9, a–f)' },
        { key: 'token', label: 'Token', secret: true, max: 200, pattern: /^[\w-]{30,200}$/ },
        { key: 'default_list_id', label: 'Standard-Liste (ID)', max: 40, pattern: /^[a-f0-9]{24}$/i, patternHint: 'Listen-IDs haben 24 Zeichen' },
        NANGO_FIELD,
      ],
      steps: ['Trello: Karte anlegen'],
      test: async (a, cfg) => {
        if (!usesNango(cfg) && !(cfg.api_key && cfg.token)) throw new Error('Trello: API-Key und Token eintragen');
        const r = await appCall(a, '', cfg, trelloSpec, { path: '/members/me', query: { fields: 'username,fullName' } });
        return `Verbunden als ${String(r.data?.fullName || r.data?.username || 'Trello')}`;
      },
      actions: {
        trello_create_card: async (a, cfg, run, step, vars) => {
          if (!usesNango(cfg) && !(cfg.api_key && cfg.token)) throw new Error('Trello: API-Key und Token fehlen (Apps → Direkt-Verbindungen)');
          const list = text(step.list_id, vars).trim() || cfg.default_list_id;
          if (!list) throw new Error('Liste fehlt (im Schritt oder als Standard-Liste)');
          const name = requireText(text(step.name, vars), 'Kartentitel');
          const due = dueOf(a, run, step, vars);
          const r = await appCall(a, loc(run), cfg, trelloSpec, { method: 'POST', path: '/cards', query: { idList: list, name: name.slice(0, 16000), desc: text(step.desc, vars).slice(0, 16000), due: due?.toISOString(), idLabels: text(step.labels, vars).replace(/\s+/g, ''), pos: step.pos === 'bottom' ? 'bottom' : 'top' } });
          const out = setVars({ result: `Trello-Karte angelegt: ${name.slice(0, 50)}`, output: { id: r.data?.id, url: r.data?.shortUrl } }, { trello_card_id: r.data?.id, trello_card_url: r.data?.shortUrl });
          return saveResult(out, step, r.data?.shortUrl);
        },
      },
    });
    meta(appMeta('Trello', { type: 'trello_create_card', label: 'Trello: Karte anlegen', summary: 'Legt eine Karte in einer Trello-Liste an.', doc: 'Liste (ID) leer = Standard-Liste der Verbindung. Titel und Beschreibung mit Platzhaltern, optional Fälligkeit und Label-IDs (komma-getrennt). Danach stehen {{var.trello_card_url}} und {{var.trello_card_id}} bereit.', icon: 'kanban', needs: 'Apps → Direkt-Verbindungen → Trello', keywords: 'trello karte card board kanban', fields: [{ key: 'list_id', label: 'Liste (ID)', type: 'text' }, { key: 'name', label: 'Titel', type: 'text', default: '{{contact.name}} – Auftrag', required: true }, { key: 'desc', label: 'Beschreibung', type: 'textarea', default: '{{contact.email}}\n{{contact.phone}}' }, ...DUE_FIELDS, { key: 'labels', label: 'Label-IDs (komma-getrennt)', type: 'text' }, { key: 'pos', label: 'Position', type: 'select', options: [['top', 'Oben'], ['bottom', 'Unten']], default: 'top' }, MAP_FIELD], provides: ['var.trello_card_url', 'var.trello_card_id'], sample: { name: '{{contact.name}} – Auftrag', due_in_days: 7 } }));

    // ---- Asana ----------------------------------------------------------------------------------
    registerConnector(app, {
      key: 'asana',
      name: 'Asana',
      category: 'Produktivität',
      icon: 'tasks',
      description: 'Aufgaben in Asana-Projekten anlegen.',
      credentials: 'Persönliches Zugriffstoken (app.asana.com/0/my-apps) unter Apps → Direkt-Verbindungen; optional Standardprojekt und Workspace.',
      guide: ['app.asana.com → Profilbild → Meine Einstellungen → Apps → „Persönliche Zugriffstoken“ → neues Token.', 'Token hier eintragen; Projekt-ID (gid) aus der URL des Projekts: …/0/<projekt-gid>/list.', 'Im Workflow „Asana: Aufgabe anlegen“.'],
      fields: [
        { key: 'token', label: 'Zugriffstoken', secret: true, max: 200, pattern: /^[\w/.:-]{20,200}$/ },
        { key: 'default_project_gid', label: 'Standardprojekt (gid)', max: 30, pattern: /^\d{5,30}$/, patternHint: 'Nur Ziffern' },
        { key: 'workspace_gid', label: 'Workspace (gid, nur ohne Projekt)', max: 30, pattern: /^\d{5,30}$/, patternHint: 'Nur Ziffern' },
        NANGO_FIELD,
      ],
      steps: ['Asana: Aufgabe anlegen'],
      test: async (a, cfg) => {
        needToken(cfg, 'Asana');
        const r = await appCall(a, '', cfg, asanaSpec, { path: '/users/me' });
        return `Verbunden als ${String(r.data?.data?.name ?? 'Asana')}`;
      },
      actions: {
        asana_create_task: async (a, cfg, run, step, vars) => {
          needToken(cfg, 'Asana');
          const project = text(step.project_gid, vars).trim() || cfg.default_project_gid;
          if (!project && !cfg.workspace_gid) throw new Error('Projekt oder Workspace fehlt');
          const name = requireText(text(step.name, vars), 'Aufgabentitel');
          const due = dueOf(a, run, step, vars);
          const data: Record<string, unknown> = { name: name.slice(0, 1000), notes: text(step.notes, vars).slice(0, 60_000), ...(project ? { projects: [project] } : { workspace: cfg.workspace_gid }) };
          if (due) data.due_on = ymdInTz(due, tzOf(a, run.location_id));
          const who = text(step.assignee, vars).trim();
          if (who) data.assignee = who;
          const r = await appCall(a, loc(run), cfg, asanaSpec, { method: 'POST', path: '/tasks', body: { data } });
          const gid = r.data?.data?.gid;
          const url = r.data?.data?.permalink_url;
          return saveResult(setVars({ result: `Asana-Aufgabe angelegt: ${name.slice(0, 50)}`, output: { gid, url } }, { asana_task_gid: gid, asana_task_url: url }), step, url);
        },
      },
    });
    meta(appMeta('Asana', { type: 'asana_create_task', label: 'Asana: Aufgabe anlegen', summary: 'Legt eine Aufgabe in einem Asana-Projekt an.', doc: 'Projekt (gid) leer = Standardprojekt. Titel/Notizen mit Platzhaltern, Fälligkeit als Datum, Verantwortlicher als „me“, E-Mail oder gid. Danach {{var.asana_task_url}}.', icon: 'tasks', needs: 'Apps → Direkt-Verbindungen → Asana', keywords: 'asana aufgabe task projekt', fields: [{ key: 'project_gid', label: 'Projekt (gid)', type: 'text' }, { key: 'name', label: 'Titel', type: 'text', default: 'Rückruf: {{contact.name}}', required: true }, { key: 'notes', label: 'Notizen', type: 'textarea', default: '{{contact.email}}\n{{contact.phone}}' }, ...DUE_FIELDS, { key: 'assignee', label: 'Verantwortlich', type: 'text', placeholder: 'me  ·  name@firma.de' }, MAP_FIELD], provides: ['var.asana_task_url', 'var.asana_task_gid'], sample: { name: 'Rückruf: {{contact.name}}', due_in_days: 2, assignee: 'me' } }));

    // ---- ClickUp --------------------------------------------------------------------------------
    registerConnector(app, {
      key: 'clickup',
      name: 'ClickUp',
      category: 'Produktivität',
      icon: 'tasks',
      description: 'Aufgaben in ClickUp-Listen anlegen.',
      credentials: 'Persönliches API-Token (ClickUp → Einstellungen → Apps, beginnt mit pk_) unter Apps → Direkt-Verbindungen; optional die Standard-Liste.',
      guide: ['ClickUp → Avatar → Einstellungen → Apps → „API-Token“ erzeugen (pk_…).', 'Listen-ID: in der Listen-URL oder per „Link kopieren“ (…/li/<id>).', 'Im Workflow „ClickUp: Aufgabe anlegen“.'],
      fields: [
        { key: 'token', label: 'API-Token', secret: true, max: 200, pattern: /^[\w.-]{20,200}$/ },
        { key: 'default_list_id', label: 'Standard-Liste (ID)', max: 30, pattern: /^\d{5,20}$/, patternHint: 'Nur Ziffern' },
        NANGO_FIELD,
      ],
      steps: ['ClickUp: Aufgabe anlegen'],
      test: async (a, cfg) => {
        needToken(cfg, 'ClickUp');
        const r = await appCall(a, '', cfg, clickupSpec, { path: '/user' });
        return `Verbunden als ${String(r.data?.user?.username ?? 'ClickUp')}`;
      },
      actions: {
        clickup_create_task: async (a, cfg, run, step, vars) => {
          needToken(cfg, 'ClickUp');
          const list = text(step.list_id, vars).trim() || cfg.default_list_id;
          if (!list || !/^\d{3,20}$/.test(list)) throw new Error('Liste fehlt oder ist ungültig (nur Ziffern)');
          const name = requireText(text(step.name, vars), 'Aufgabentitel');
          const due = dueOf(a, run, step, vars);
          const body: Record<string, unknown> = { name: name.slice(0, 1000), description: text(step.description, vars).slice(0, 60_000) };
          if (due) (body.due_date = due.getTime()), (body.due_date_time = true);
          const prio = Number(step.priority);
          if (prio >= 1 && prio <= 4) body.priority = prio;
          const assignees = text(step.assignees, vars).split(/[,\s]+/).filter((x) => /^\d+$/.test(x)).map(Number);
          if (assignees.length) body.assignees = assignees;
          const tags = text(step.tags, vars).split(',').map((x) => x.trim()).filter(Boolean);
          if (tags.length) body.tags = tags;
          const r = await appCall(a, loc(run), cfg, clickupSpec, { method: 'POST', path: `/list/${list}/task`, body });
          return saveResult(setVars({ result: `ClickUp-Aufgabe angelegt: ${name.slice(0, 50)}`, output: { id: r.data?.id, url: r.data?.url } }, { clickup_task_id: r.data?.id, clickup_task_url: r.data?.url }), step, r.data?.url);
        },
      },
    });
    meta(appMeta('ClickUp', { type: 'clickup_create_task', label: 'ClickUp: Aufgabe anlegen', summary: 'Legt eine Aufgabe in einer ClickUp-Liste an.', doc: 'Liste (ID) leer = Standard-Liste. Priorität 1 (dringend) bis 4 (niedrig), Verantwortliche als Nutzer-IDs, Tags komma-getrennt. Danach {{var.clickup_task_url}}.', icon: 'tasks', needs: 'Apps → Direkt-Verbindungen → ClickUp', keywords: 'clickup aufgabe task liste', fields: [{ key: 'list_id', label: 'Liste (ID)', type: 'text' }, { key: 'name', label: 'Titel', type: 'text', default: 'Neuer Auftrag: {{contact.name}}', required: true }, { key: 'description', label: 'Beschreibung', type: 'textarea' }, ...DUE_FIELDS, { key: 'priority', label: 'Priorität', type: 'select', options: [['', 'keine'], ['1', 'Dringend'], ['2', 'Hoch'], ['3', 'Normal'], ['4', 'Niedrig']] }, { key: 'assignees', label: 'Verantwortliche (Nutzer-IDs)', type: 'text' }, { key: 'tags', label: 'Tags', type: 'text' }, MAP_FIELD], provides: ['var.clickup_task_url', 'var.clickup_task_id'], sample: { name: 'Neuer Auftrag: {{contact.name}}', priority: '2' } }));

    // ---- Airtable -------------------------------------------------------------------------------
    registerConnector(app, {
      key: 'airtable',
      name: 'Airtable',
      category: 'Daten',
      icon: 'csv',
      description: 'Datensätze in Airtable-Tabellen anlegen oder aktualisieren.',
      credentials: 'Personal Access Token (airtable.com/create/tokens, Rechte data.records:read und :write) und die Base-ID (app…) unter Apps → Direkt-Verbindungen.',
      guide: ['airtable.com/create/tokens: Token mit „data.records:read“ und „data.records:write“ für deine Base erzeugen.', 'Die Base-ID (app…) steht in der URL der Base bzw. in der API-Dokumentation.', 'Im Workflow „Airtable: Datensatz anlegen/ändern“.'],
      fields: [
        { key: 'token', label: 'Personal Access Token', secret: true, max: 300, pattern: /^pat[\w.-]{20,300}$/, patternHint: 'Airtable-Tokens beginnen mit pat', placeholder: 'pat…' },
        { key: 'base_id', label: 'Standard-Base (ID)', max: 30, pattern: /^app[A-Za-z0-9]{10,20}$/, patternHint: 'Base-IDs beginnen mit app' },
        NANGO_FIELD,
      ],
      steps: ['Airtable: Datensatz anlegen', 'Airtable: Datensatz ändern'],
      test: async (a, cfg) => {
        needToken(cfg, 'Airtable');
        const r = await appCall(a, '', cfg, airtableSpec, { path: '/meta/whoami' });
        return `Verbunden (${String(r.data?.email ?? r.data?.id ?? 'Airtable')})`;
      },
      actions: {
        airtable_create_record: async (a, cfg, run, step, vars) => {
          needToken(cfg, 'Airtable');
          const base = text(step.base_id, vars).trim() || cfg.base_id;
          if (!base) throw new Error('Base fehlt (im Schritt oder als Standard-Base)');
          const table = requireText(text(step.table, vars), 'Tabelle');
          const fields = airtableFields(step.rows, vars);
          const r = await appCall(a, loc(run), cfg, airtableSpec, { method: 'POST', path: `/${base}/${encodeURIComponent(table)}`, body: { fields, typecast: true } });
          return saveResult(setVars({ result: `Airtable: Datensatz ${r.data?.id ?? ''} angelegt`, output: { id: r.data?.id, fields: r.data?.fields } }, { airtable_record_id: r.data?.id }), step, r.data?.id);
        },
        airtable_update_record: async (a, cfg, run, step, vars) => {
          needToken(cfg, 'Airtable');
          const base = text(step.base_id, vars).trim() || cfg.base_id;
          if (!base) throw new Error('Base fehlt (im Schritt oder als Standard-Base)');
          const table = requireText(text(step.table, vars), 'Tabelle');
          const fields = airtableFields(step.rows, vars);
          let id = text(step.record_id, vars).trim();
          if (!id) {
            const field = requireText(text(step.match_field, vars), 'Suchfeld');
            const value = requireText(text(step.match_value, vars), 'Suchwert');
            const f = await appCall(a, loc(run), cfg, airtableSpec, { path: `/${base}/${encodeURIComponent(table)}`, query: { filterByFormula: airtableMatch(field, value), maxRecords: 1 } });
            id = String(f.data?.records?.[0]?.id ?? '');
            if (!id) {
              if (!step.create_if_missing) return { result: `Airtable: kein Datensatz mit ${field} = ${value.slice(0, 40)}`, vars: { airtable_found: false } };
              const c = await appCall(a, loc(run), cfg, airtableSpec, { method: 'POST', path: `/${base}/${encodeURIComponent(table)}`, body: { fields: { ...fields, [field]: value }, typecast: true } });
              return saveResult(setVars({ result: `Airtable: Datensatz ${c.data?.id ?? ''} neu angelegt`, output: { id: c.data?.id } }, { airtable_record_id: c.data?.id, airtable_found: false }), step, c.data?.id);
            }
          }
          const r = await appCall(a, loc(run), cfg, airtableSpec, { method: 'PATCH', path: `/${base}/${encodeURIComponent(table)}/${encodeURIComponent(id)}`, body: { fields, typecast: true } });
          return saveResult(setVars({ result: `Airtable: Datensatz ${r.data?.id ?? id} aktualisiert`, output: { id: r.data?.id ?? id, fields: r.data?.fields } }, { airtable_record_id: r.data?.id ?? id, airtable_found: true }), step, r.data?.id ?? id);
        },
      },
    });
    const airtableRows: FieldDef = { key: 'rows', label: 'Felder', type: 'rows', addLabel: '+ Feld', rows: [{ key: 'field', label: 'Feldname in Airtable', type: 'text' }, { key: 'value', label: 'Wert', type: 'text', placeholder: '{{contact.email}}' }] };
    meta(appMeta('Airtable', { type: 'airtable_create_record', label: 'Airtable: Datensatz anlegen', summary: 'Legt einen Datensatz in einer Airtable-Tabelle an.', doc: 'Base leer = Standard-Base. Tabelle als Name oder ID. Pro Zeile ein Feld (genau der Spaltenname) und ein Wert mit Platzhaltern; Airtable wandelt Texte passend um (typecast). Danach {{var.airtable_record_id}}.', icon: 'csv', needs: 'Apps → Direkt-Verbindungen → Airtable', keywords: 'airtable datenbank tabelle record datensatz', fields: [{ key: 'base_id', label: 'Base (ID)', type: 'text' }, { key: 'table', label: 'Tabelle', type: 'text', required: true, placeholder: 'Leads' }, airtableRows, MAP_FIELD], provides: ['var.airtable_record_id'], sample: { table: 'Leads', rows: [{ field: 'E-Mail', value: '{{contact.email}}' }, { field: 'Name', value: '{{contact.name}}' }] } }));
    meta(appMeta('Airtable', { type: 'airtable_update_record', label: 'Airtable: Datensatz ändern', summary: 'Ändert einen Airtable-Datensatz – per ID oder gesucht über ein Feld; optional anlegen, wenn er fehlt.', doc: 'Entweder die Datensatz-ID (recXXXX, z. B. {{var.airtable_record_id}}) oder ein Suchfeld mit Suchwert (der erste Treffer wird geändert). „Anlegen, wenn nicht gefunden“ macht daraus ein Upsert. {{var.airtable_found}} sagt, ob einer gefunden wurde.', icon: 'csv', needs: 'Apps → Direkt-Verbindungen → Airtable', keywords: 'airtable update ändern upsert', fields: [{ key: 'base_id', label: 'Base (ID)', type: 'text' }, { key: 'table', label: 'Tabelle', type: 'text', required: true }, { key: 'record_id', label: 'Datensatz-ID', type: 'text', placeholder: '{{var.airtable_record_id}}' }, { key: 'match_field', label: 'oder Suchfeld', type: 'text', default: 'E-Mail' }, { key: 'match_value', label: 'Suchwert', type: 'text', default: '{{contact.email}}' }, { key: 'create_if_missing', label: 'Anlegen, wenn nicht gefunden', type: 'bool' }, airtableRows, MAP_FIELD], provides: ['var.airtable_record_id', 'var.airtable_found'], sample: { table: 'Leads', match_field: 'E-Mail', match_value: '{{contact.email}}', rows: [{ field: 'Status', value: 'Kunde' }], create_if_missing: true } }));

    // ---- Notion database item (uses the Notion token of the "Notion" connection) ------------------
    const notion = async (a: App, token: string, method: string, path: string, body?: unknown) =>
      readJson(await connectorFetch(a)(`https://api.notion.com/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, 'notion-version': NOTION_VERSION, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 20_000, maxBytes: 1024 * 1024 }), 'Notion');
    const notionCreate = async (run: any, step: any, vars: Record<string, any>) => {
      const cfg = app.services.connectorConfig?.(run.location_id, 'notion') as ConnectorConfig | null;
      if (!cfg?.token) throw new Error('Notion ist in diesem Sub-Account nicht eingerichtet (Apps → Direkt-Verbindungen → Notion).');
      const dbId = notionPageId(text(step.database_id, vars));
      if (!dbId) throw new Error('Datenbank-Link oder -ID fehlt oder ist ungültig');
      const db = await notion(app, cfg.token, 'GET', `/databases/${dbId}`);
      const rows = rowsOf<{ property: string; value: string }>(step.rows, ['property']).map((r) => ({ property: r.property, value: text(r.value, vars) }));
      const props = notionProperties(db?.properties ?? {}, rows, step.title ? text(step.title, vars) : undefined);
      const page = await notion(app, cfg.token, 'POST', '/pages', { parent: { database_id: dbId }, properties: props });
      return saveResult(setVars({ result: `Notion: Eintrag angelegt${page?.url ? ` (${String(page.url).slice(0, 80)})` : ''}`, output: { id: page?.id, url: page?.url } }, { notion_page_id: page?.id, notion_page_url: page?.url }), step, page?.url);
    };
    meta(appMeta('Notion', { type: 'notion_create_item', label: 'Notion: Datenbank-Eintrag anlegen', summary: 'Legt einen Eintrag (Seite) in einer Notion-Datenbank an.', doc: 'Datenbank als Link oder ID – sie muss mit der Integration geteilt sein (Notion → ••• → Verbindungen). Titel füllt die Titel-Spalte; weitere Zeilen setzen Spalten nach ihrem Namen (Text, Zahl, Auswahl, Mehrfachauswahl, Status, Haken, Datum, E-Mail, Telefon, URL). Danach {{var.notion_page_url}}.', icon: 'doc', needs: 'Apps → Direkt-Verbindungen → Notion (Token)', keywords: 'notion datenbank database eintrag seite item', fields: [{ key: 'database_id', label: 'Datenbank (Link oder ID)', type: 'text', required: true }, { key: 'title', label: 'Titel', type: 'text', default: '{{contact.name}}' }, { key: 'rows', label: 'Weitere Spalten', type: 'rows', addLabel: '+ Spalte', rows: [{ key: 'property', label: 'Spalte', type: 'text' }, { key: 'value', label: 'Wert', type: 'text' }] }, MAP_FIELD], provides: ['var.notion_page_url', 'var.notion_page_id'], sample: { database_id: 'https://www.notion.so/…', title: '{{contact.name}}', rows: [{ property: 'E-Mail', value: '{{contact.email}}' }] } }));

    // ---- Google Sheets (through the existing Google connection) ---------------------------------
    const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
    const sheetsCall = (run: any, method: string, url: string, body?: unknown) => {
      const api = app.services.sheetsApi as ((loc: string, method: string, url: string, body?: unknown) => Promise<any>) | undefined;
      if (!api) throw new Error('Google Sheets ist nicht verfügbar');
      return api(run.location_id, method, url, body).catch((e: Error) => {
        throw new Error(e.message);
      });
    };
    const sheetOf = (step: any, vars: Record<string, any>) => {
      const id = spreadsheetId(text(step.spreadsheet, vars));
      if (!id) throw new Error('Tabellen-Link oder -ID fehlt oder ist ungültig');
      return { id, tab: text(step.sheet, vars).trim() };
    };
    const cell = (v: string) => v.slice(0, 5000);
    meta(appMeta('Google Sheets', { type: 'gsheets_append_row', label: 'Google Sheets: Zeile anhängen', summary: 'Hängt eine neue Zeile unten an eine Google-Tabelle an.', doc: 'Nutzt die Google-Verbindung des Sub-Accounts (Apps → Direkt-Verbindungen → Google Sheets → „Mit Google verbinden“). Tabelle als Link oder ID, optional der Reiter. Jede Zeile unten ist eine Spalte von links nach rechts (A, B, C …); Werte mit Platzhaltern. Texte mit „=“ am Anfang werden als Text gespeichert, nicht als Formel.', icon: 'csv', needs: 'Apps → Direkt-Verbindungen → Google Sheets (mit Google verbinden)', keywords: 'google sheets tabelle zeile anhängen append spreadsheet', fields: [{ key: 'spreadsheet', label: 'Tabelle (Link oder ID)', type: 'text', required: true }, { key: 'sheet', label: 'Reiter', type: 'text', placeholder: 'Tabelle1 (leer = erster Reiter)' }, { key: 'columns', label: 'Spalten (von links)', type: 'rows', addLabel: '+ Spalte', rows: [{ key: 'value', label: 'Wert', type: 'text', placeholder: '{{contact.email}}' }] }], provides: ['var.sheet_range'], sample: { spreadsheet: 'https://docs.google.com/spreadsheets/d/…', columns: [{ value: '{{contact.name}}' }, { value: '{{contact.email}}' }, { value: '{{contact.custom.budget}}' }] } }));
    meta(appMeta('Google Sheets', { type: 'gsheets_update_row', label: 'Google Sheets: Zeile ändern', summary: 'Sucht eine Zeile über einen Wert in einer Spalte und ändert Zellen – oder hängt sie an.', doc: 'Suchspalte (z. B. B) und Suchwert (z. B. {{contact.email}}): die erste passende Zeile wird geändert (Groß/Klein egal). Pro Zeile unten eine Spalte (Buchstabe) mit neuem Wert. „Anhängen, wenn nicht gefunden“ macht ein Upsert: Die neue Zeile bekommt die Zellen an den angegebenen Spalten und den Suchwert in der Suchspalte.', icon: 'csv', needs: 'Apps → Direkt-Verbindungen → Google Sheets (mit Google verbinden)', keywords: 'google sheets tabelle zeile ändern update upsert suchen', fields: [{ key: 'spreadsheet', label: 'Tabelle (Link oder ID)', type: 'text', required: true }, { key: 'sheet', label: 'Reiter', type: 'text' }, { key: 'key_column', label: 'Suchspalte', type: 'text', default: 'A', required: true }, { key: 'key_value', label: 'Suchwert', type: 'text', default: '{{contact.email}}', required: true }, { key: 'cells', label: 'Zellen setzen', type: 'rows', addLabel: '+ Zelle', rows: [{ key: 'column', label: 'Spalte', type: 'text', placeholder: 'C' }, { key: 'value', label: 'Wert', type: 'text' }] }, { key: 'append_if_missing', label: 'Anhängen, wenn nicht gefunden', type: 'bool' }], provides: ['var.sheet_row'], sample: { key_column: 'B', key_value: '{{contact.email}}', cells: [{ column: 'C', value: 'Kunde' }], append_if_missing: true } }));

    const sheetsActions = {
      gsheets_append_row: async (run: any, step: any, vars: Record<string, any>) => {
        const { id, tab } = sheetOf(step, vars);
        const values = (Array.isArray(step.columns) ? step.columns : []).slice(0, 100).map((c: any) => cell(text(c?.value, vars)));
        if (!values.some((v: string) => v !== '')) throw new Error('Keine Spalten angegeben');
        const range = a1(tab, 'A1');
        const r = await sheetsCall(run, 'POST', `${SHEETS}/${id}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { majorDimension: 'ROWS', values: [values] });
        const where = String(r?.updates?.updatedRange ?? '');
        return setVars({ result: `Google Sheets: Zeile angehängt${where ? ` (${where})` : ''}`, output: r?.updates }, { sheet_range: where });
      },
      gsheets_update_row: async (run: any, step: any, vars: Record<string, any>) => {
        const { id, tab } = sheetOf(step, vars);
        const keyCol = colIndex(String(step.key_column || 'A'));
        const keyValue = requireText(text(step.key_value, vars), 'Suchwert').trim();
        const cells = rowsOf<{ column: string; value: string }>(step.cells, ['column'], 50).map((c) => ({ idx: colIndex(c.column), value: cell(text(c.value, vars)) }));
        if (!cells.length) throw new Error('Keine Zellen angegeben');
        const L = colLetters(keyCol);
        const found = await sheetsCall(run, 'GET', `${SHEETS}/${id}/values/${encodeURIComponent(a1(tab, `${L}1:${L}5000`))}?majorDimension=COLUMNS`);
        const colVals: string[] = found?.values?.[0] ?? [];
        const at = colVals.findIndex((v) => String(v ?? '').trim().toLowerCase() === keyValue.toLowerCase());
        if (at < 0) {
          if (!step.append_if_missing) return { result: `Google Sheets: keine Zeile mit ${keyValue.slice(0, 40)} in Spalte ${L}`, vars: { sheet_row: 0 } };
          const width = Math.max(keyCol, ...cells.map((c) => c.idx)) + 1;
          const row = Array.from({ length: width }, () => '');
          row[keyCol] = cell(keyValue);
          for (const c of cells) row[c.idx] = c.value;
          const r = await sheetsCall(run, 'POST', `${SHEETS}/${id}/values/${encodeURIComponent(a1(tab, 'A1'))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { majorDimension: 'ROWS', values: [row] });
          return setVars({ result: `Google Sheets: neue Zeile angehängt (${keyValue.slice(0, 40)})`, output: r?.updates }, { sheet_row: 0, sheet_range: String(r?.updates?.updatedRange ?? '') });
        }
        const row = at + 1;
        await sheetsCall(run, 'POST', `${SHEETS}/${id}/values:batchUpdate`, { valueInputOption: 'RAW', data: cells.map((c) => ({ range: a1(tab, `${colLetters(c.idx)}${row}`), values: [[c.value]] })) });
        return setVars({ result: `Google Sheets: Zeile ${row} aktualisiert (${cells.length} Zellen)`, output: { row, cells: cells.length } }, { sheet_row: row });
      },
    };

    // ---- Google Calendar event (through a connected Google calendar) ------------------------------
    /** Google calendar connections of the sub-account's team members (they belong to people, not to the sub-account). */
    const calendarConnections = (locationId: string) => {
      const users = teamOf(app, locationId);
      if (!users.length) return [];
      return app.db.all<any>(`SELECT id, account_email, account_name, status FROM oauth_connections WHERE provider = 'google' AND purpose = 'calendar' AND status = 'ok' AND user_id IN (${users.map(() => '?').join(',')}) ORDER BY created_at`, ...users.map((u) => u.id));
    };
    app.router.get('/api/connector-apps/google-calendars', 'location', (ctx) => calendarConnections(ctx.locationId).map((c) => ({ id: c.id, account_email: c.account_email, status: c.status })));
    meta(appMeta('Google Kalender', { type: 'gcal_create_event', label: 'Google Kalender: Termin anlegen', summary: 'Legt einen Termin im Google Kalender an (verbundener Kalender oder Nango).', doc: 'Nutzt einen verbundenen Google-Kalender (Einstellungen → Mein Konto → Google- oder Outlook-Kalender) – gibt es nur einen, wird er genommen. Kalender-ID „primary“ = Hauptkalender. Zeitpunkt: in X Stunden/Tagen oder zu einem Datum, dazu Dauer in Minuten. Wiederholt sich der Schritt mit denselben Daten (Wiederholung nach Fehler), entsteht kein zweiter Termin. Mit einem Teilnehmer verschickt Google die Einladung per E-Mail. Danach {{var.gcal_event_url}}.', icon: 'calendars', needs: 'Einstellungen → Mein Konto → Google- oder Outlook-Kalender (Google) oder Nango-Integration', keywords: 'google kalender calendar termin event meeting', fields: [{ key: 'connection_id', label: 'Verbindung', type: 'text', help: 'Leer = die einzige verbundene Google-Verbindung' }, { key: 'nango_integration', label: 'Oder Nango-Integration', type: 'text', placeholder: 'google-calendar' }, { key: 'calendar_id', label: 'Kalender-ID', type: 'text', default: 'primary' }, { key: 'title', label: 'Titel', type: 'text', default: 'Termin mit {{contact.name}}', required: true }, { key: 'description', label: 'Beschreibung', type: 'textarea' }, { key: 'location', label: 'Ort / Link', type: 'text' }, ...WHEN_FIELDS, { key: 'attendee', label: 'Teilnehmer (E-Mail, optional)', type: 'text', placeholder: '{{contact.email}}' }], provides: ['var.gcal_event_url', 'var.gcal_event_id'], sample: { title: 'Termin mit {{contact.name}}', when: 'in', amount: 2, unit: 'days', time: '10:00', duration: 45 } }));
    const gcalCreate = async (run: any, step: any, vars: Record<string, any>) => {
      const { start, end } = whenOf(app, run.location_id, step, vars);
      const calId = text(step.calendar_id, vars).trim() || 'primary';
      const attendee = text(step.attendee, vars).trim();
      // The id makes a retry create the same event, not a second one (Google ids: a–v and 0–9).
      const eventId = `pghl${sha256(`${run.id}:${step.id}:${calId}`).slice(0, 28)}`;
      const body: Record<string, unknown> = { id: eventId, summary: text(step.title, vars).slice(0, 500), description: text(step.description, vars).slice(0, 8000), location: text(step.location, vars).slice(0, 500) || undefined, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, ...(attendee && /^[^\s@]+@[^\s@]+$/.test(attendee) ? { attendees: [{ email: attendee }] } : {}) };
      const path = `/calendars/${encodeURIComponent(calId)}/events`;
      let data: any;
      if (step.nango_integration) {
        const r = await appCall(app, run.location_id, { nango_integration: String(step.nango_integration) }, { name: 'Google Kalender', base: () => '', nangoPrefix: '/calendar/v3' }, { method: 'POST', path, query: { sendUpdates: body.attendees ? 'all' : 'none' }, body, accept: [409] });
        data = r.data;
      } else {
        const conns = calendarConnections(run.location_id);
        const wanted = text(step.connection_id, vars).trim();
        const conn = wanted ? conns.find((c) => c.id === wanted) : conns.length === 1 ? conns[0] : undefined;
        if (!conn) throw new Error(conns.length > 1 ? 'Mehrere Google-Verbindungen – bitte eine auswählen' : 'Kein Google-Kalender verbunden (Einstellungen → Mein Konto → Google- oder Outlook-Kalender) – oder eine Nango-Integration angeben');
        const tok = await app.services.oauth?.token(conn.id);
        if (!tok) throw new Error('Google-Zugriff nicht verfügbar – Verbindung neu herstellen');
        const r = await connectorFetch(app)(`https://www.googleapis.com/calendar/v3${path}${qs({ sendUpdates: body.attendees ? 'all' : 'none' })}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 20_000, maxBytes: 1024 * 1024 });
        const raw = await r.text();
        data = raw ? JSON.parse(raw) : {};
        if (r.status === 409) data = { id: eventId, htmlLink: '' };
        else if (!r.ok) await readJson({ status: r.status, ok: false, headers: r.headers, text: async () => raw }, 'Google Kalender');
      }
      return setVars({ result: `Google Kalender: Termin „${String(body.summary).slice(0, 40)}“ am ${start.toISOString()} angelegt`, output: { id: data?.id ?? eventId, url: data?.htmlLink } }, { gcal_event_id: data?.id ?? eventId, gcal_event_url: data?.htmlLink ?? '' });
    };

    // These steps use connections that exist elsewhere, so there is no form of their own; they only need their handlers.
    app.services.workflowActions = { ...(app.services.workflowActions ?? {}), notion_create_item: notionCreate, ...sheetsActions, gcal_create_event: gcalCreate };
    registerActionMeta(app, metas);
  },
};

/** Airtable `fields` from the step's rows (empty names dropped, values rendered). */
function airtableFields(rows: unknown, vars: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rowsOf<{ field: string; value: string }>(rows, ['field'], 100)) out[String(r.field).trim()] = text(r.value, vars);
  if (!Object.keys(out).length) throw new Error('Keine Felder angegeben');
  return out;
}
