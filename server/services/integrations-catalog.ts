/**
 * The integrations catalogue (Agentur → Integrationen → Katalog, Sub-Account → Apps): every
 * built-in integration with category, where it is set up and a short guide. Live status comes
 * from the module's probes, which read the existing status endpoints.
 */

export type CatalogStatus = 'ok' | 'partial' | 'missing' | 'info' | 'unavailable';

export interface CatalogEntry {
  key: string;
  name: string;
  category: string;
  /** Icon name of the web app's icon map. */
  icon: string;
  description: string;
  /** location = per sub-account, agency = once for the agency, both = agency app + per sub-account connection */
  scope: 'location' | 'agency' | 'both';
  /** Where it is set up inside the app (route below /app/). */
  setup?: { location?: string; agency?: string };
  /** What the user enters, and where. */
  credentials: string;
  guide?: string[];
  docs?: string;
}

export const CATEGORIES = ['Zahlungen', 'Kommunikation', 'Kalender & Google', 'KI', 'Marketing', 'Produktivität', 'Daten', 'Automatisierung', 'Umzug'] as const;

export const CATALOG: CatalogEntry[] = [
  { key: 'stripe', name: 'Stripe', category: 'Zahlungen', icon: 'card', scope: 'location', setup: { location: 'settings/stripe' }, description: 'Rechnungen online bezahlen, Kauf-Links, Abos, Order-Bumps und Upsells.', credentials: 'Secret Key (sk_…/rk_…) und Webhook-Secret (whsec_…) je Sub-Account unter Einstellungen → Stripe.', docs: 'docs/stripe.md' },
  { key: 'twilio', name: 'Twilio', category: 'Kommunikation', icon: 'phone', scope: 'location', setup: { location: 'settings/telephony' }, description: 'SMS, Telefonie, Browser-Telefon und KI-Telefonagent.', credentials: 'Account SID, Auth Token und Nummer unter Einstellungen → Telefonie (SMS unter E-Mail & SMS).', docs: 'docs/self-hosting.md#telephony-twilio' },
  { key: 'meta', name: 'Meta: WhatsApp, Messenger, Instagram', category: 'Kommunikation', icon: 'whatsapp', scope: 'location', setup: { location: 'settings/channels' }, description: 'WhatsApp Business, Facebook Messenger und Instagram Direct im Posteingang.', credentials: 'App-Secret, WhatsApp-Token + Phone-Number-ID bzw. Seiten-Token unter Einstellungen → Kanäle.', docs: 'docs/meta-channels.md' },
  { key: 'email', name: 'E-Mail (SMTP) & Postfächer (IMAP)', category: 'Kommunikation', icon: 'email', scope: 'both', setup: { location: 'settings/messaging', agency: 'agency/integrations' }, description: 'Versand über den eigenen SMTP-Server; Postfach-Sync per IMAP (Posteingang, Gesendet, Entwürfe).', credentials: 'SMTP-Server, Benutzer, Passwort unter Einstellungen → E-Mail & SMS; IMAP-Postfächer unter Agentur → Integrationen → Einrichtung.' },
  { key: 'google_microsoft', name: 'Google & Microsoft (OAuth)', category: 'Kalender & Google', icon: 'calendars', scope: 'both', setup: { agency: 'agency/integrations', location: 'settings/account' }, description: 'Zwei-Wege-Sync mit Google Kalender und Outlook je Login; Grundlage für das Google-Unternehmensprofil.', credentials: 'Client-ID und Client-Secret der eigenen OAuth-App unter Agentur → Integrationen → Einrichtung; verbinden je Login unter Einstellungen → Mein Konto.', docs: 'docs/self-hosting.md#connect-google--microsoft-oauth' },
  { key: 'google_business', name: 'Google-Unternehmensprofil', category: 'Kalender & Google', icon: 'place', scope: 'location', setup: { location: 'settings/reviews' }, description: 'Alle Rezensionen mit Antworten, direkt antworten, Google-Beiträge veröffentlichen.', credentials: 'Mit Google verbinden und Standort wählen unter Einstellungen → Bewertungen (braucht die OAuth-App der Agentur).', docs: 'docs/self-hosting.md#google-reviews' },
  { key: 'anthropic', name: 'Anthropic (Claude)', category: 'KI', icon: 'claude', scope: 'location', setup: { location: 'settings/ai' }, description: 'KI-Assistent im Posteingang, Chat-Bot, KI-Texte in Workflows und der KI-Telefonagent.', credentials: 'Anthropic-API-Schlüssel (sk-ant-…) unter Einstellungen → KI-Assistent (oder einer für den ganzen Server).', docs: 'docs/ai-assistant.md' },
  { key: 'mcp', name: 'MCP-Server (Claude & Co.)', category: 'KI', icon: 'bot', scope: 'both', setup: { agency: 'agency/api', location: 'settings/api' }, description: 'Claude, Cursor & Co. verwalten Projekte, Kontakte, Deals und Posteingang über /mcp.', credentials: 'Agentur-Schlüssel (pghla_…) unter Agentur → API & MCP oder Sub-Account-Schlüssel (pghl_…).', docs: 'docs/api.md#mcp-server', guide: ['Agentur → API & MCP → „Schlüssel anlegen“ (lesen oder schreiben).', 'In Claude Code: claude mcp add --transport http ghl https://<deine-domain>/mcp --header "Authorization: Bearer pghla_…"', 'In Claude Desktop/claude.ai: Connector mit der URL https://<deine-domain>/mcp und dem Schlüssel als Bearer-Token.'] },
  { key: 'norman', name: 'Norman (Buchhaltung via MCP)', category: 'Produktivität', icon: 'invoices', scope: 'agency', setup: { agency: 'agency/api' }, description: 'Norman liest Rechnungen über den MCP-Server und verknüpft sie mit der Buchhaltung.', credentials: 'Agentur-Schlüssel unter Agentur → API & MCP; in Norman den MCP-Server https://<deine-domain>/mcp eintragen.', guide: ['Agentur → API & MCP: Schlüssel „Norman“ anlegen (schreiben, damit Verknüpfungen gespeichert werden).', 'In Norman als MCP-Server die URL https://<deine-domain>/mcp mit dem Schlüssel als Bearer-Token eintragen.', 'Norman nutzt ghl_list_invoices und ghl_link_invoice; verknüpfte Rechnungen zeigen das Kennzeichen „Norman“.'] },
  { key: 'todoist', name: 'Todoist', category: 'Produktivität', icon: 'todo', scope: 'agency', setup: { agency: 'agency/integrations' }, description: 'Aufgaben aller Sub-Accounts in beide Richtungen abgleichen.', credentials: 'Persönlicher API-Token (Todoist → Einstellungen → Integrationen → Entwickler) unter Agentur → Integrationen → Einrichtung.', docs: 'docs/todoist.md' },
  { key: 'postiz', name: 'Postiz (Social Planner)', category: 'Marketing', icon: 'social', scope: 'agency', setup: { agency: 'agency/integrations' }, description: 'Veröffentlicht die Posts des Social Planners auf X, LinkedIn, Instagram & Co.', credentials: 'Adresse und Public-API-Schlüssel der eigenen Postiz-Instanz unter Agentur → Integrationen → Einrichtung.', docs: 'docs/self-hosting.md#social-planner-postiz' },
  { key: 'ads', name: 'Werbekonten (Meta & Google Ads)', category: 'Marketing', icon: 'attribution', scope: 'location', setup: { location: 'attribution/settings' }, description: 'Ausgaben, Klicks und Leads je Kampagne; CPL und ROAS mit der Attribution.', credentials: 'Meta: Werbekonto-ID + Token; Google: Kunden-ID, Developer-Token, OAuth-Client + Refresh-Token unter Attribution → Tracking & Werbekonten.', docs: 'docs/growth.md#ad-reports-meta-ads--google-ads' },
  { key: 'supabase', name: 'Supabase-Spiegel', category: 'Daten', icon: 'layers', scope: 'agency', setup: { agency: 'agency/integrations' }, description: 'Projekte, Kontakte, Deals, Aufgaben und Rechnungen laufend in die eigene Supabase.', credentials: 'Projekt-URL und Service-Role-Key unter Agentur → Integrationen → Einrichtung.', docs: 'docs/self-hosting.md#supabase-mirror' },
  {
    key: 'zapier',
    name: 'Zapier',
    category: 'Automatisierung',
    icon: 'trigger',
    scope: 'location',
    setup: { location: 'settings/api' },
    description: 'Fertige Zapier-App im Repo (integrations/zapier): Sofort-Auslöser per REST-Hook, Aktionen und Suchen.',
    credentials: 'API-Schlüssel (pghl_…) unter Einstellungen → API & Webhooks; beim Verbinden in Zapier Adresse + Schlüssel eingeben.',
    docs: 'docs/integrations.md#zapier',
    guide: ['Einmalig (Agentur): im Repo-Ordner integrations/zapier „npm install“, dann „zapier login“ und „zapier push“ – die App bleibt privat in deinem Zapier-Konto.', 'Mitglieder einladen: „zapier users:add <email>“ oder Einladungslink aus dem Zapier-Developer-Portal.', 'Im Zap die App „HyperLevel“ wählen, Adresse (https://<deine-domain>) und API-Schlüssel eintragen.', 'Auslöser wie „Neuer Kontakt“ oder „Deal gewonnen“ abonnieren sich selbst (REST-Hook) – sie erscheinen unten im Zustell-Protokoll.'],
  },
  {
    key: 'make',
    name: 'Make',
    category: 'Automatisierung',
    icon: 'workflows',
    scope: 'location',
    setup: { location: 'settings/api' },
    description: 'Eigene Make-App als JSON im Repo (integrations/make): Verbindung, Sofort-Auslöser, Aktionen, Suchen.',
    credentials: 'API-Schlüssel (pghl_…) unter Einstellungen → API & Webhooks; in Make beim Anlegen der Verbindung eintragen.',
    docs: 'docs/integrations.md#make',
    guide: ['In Make: Custom Apps → „Create a new app“, Name „HyperLevel“.', 'Base, Connection, Webhooks, Modules und RPCs aus integrations/make/ in die gleichnamigen Reiter kopieren (README im Ordner).', 'Im Szenario das Modul „Neues Ereignis (sofort)“ wählen – Make registriert den Webhook selbst.'],
  },
  {
    key: 'n8n',
    name: 'n8n',
    category: 'Automatisierung',
    icon: 'braces',
    scope: 'location',
    setup: { location: 'settings/api' },
    description: 'Importierbare Workflow-Vorlagen (integrations/n8n) mit HTTP-Request- und Webhook-Knoten.',
    credentials: 'In n8n eine „Header Auth“-Anmeldung: Name Authorization, Wert „Bearer pghl_…“.',
    docs: 'docs/integrations.md#n8n',
    guide: ['In n8n: Workflows → „Import from File“ und eine Vorlage aus integrations/n8n wählen.', 'Header-Auth-Zugang anlegen (Authorization: Bearer pghl_…) und in den HTTP-Request-Knoten auswählen.', 'Die Variable BASE_URL in den Knoten auf deine Domain setzen; den Abo-Workflow einmal ausführen.'],
  },
  {
    key: 'rest_hooks',
    name: 'REST-Hooks & API',
    category: 'Automatisierung',
    icon: 'webhook',
    scope: 'location',
    setup: { location: 'settings/api' },
    description: 'Ereignisse abonnieren (signiert, mit Wiederholungen und Protokoll), Aktionen per REST, OpenAPI-Beschreibung.',
    credentials: 'API-Schlüssel (pghl_…) unter Einstellungen → API & Webhooks.',
    docs: 'docs/integrations.md#rest-hooks',
    guide: ['POST /api/hooks mit {"target_url": "https://…", "event": "contact.created"} abonniert, DELETE /api/hooks/<id> bestellt ab.', 'Signatur prüfen: x-pghl-signature = sha256(secret + body); das Secret steht in der Antwort.', 'Alle Endpunkte: /api/docs.html bzw. /api/openapi.json.'],
  },
  {
    key: 'inbound_webhooks',
    name: 'Eingehende Webhooks',
    category: 'Automatisierung',
    icon: 'send',
    scope: 'location',
    setup: { location: 'workflows' },
    description: 'Auslöser „Webhook empfangen“: beliebiges JSON annehmen, Felder zuordnen, Workflow starten.',
    credentials: 'Keine – die geheime URL steht im Workflow; optional HMAC-Signatur.',
    docs: 'docs/integrations.md#inbound-webhooks',
    guide: ['Workflow anlegen, Auslöser „Webhook empfangen“ wählen und speichern.', 'Die URL im sendenden Tool eintragen und eine Test-Anfrage schicken.', 'Felder aus den empfangenen Test-Daten den Kontaktfeldern zuordnen, Workflow aktivieren.'],
  },
  {
    key: 'hubspot',
    name: 'HubSpot-Import',
    category: 'Umzug',
    icon: 'download',
    scope: 'location',
    setup: { location: 'settings/import' },
    description: 'Owner, Kontakte, Firmen, Deals mit Pipelines, Notizen, Aufgaben, Aktivitäten, Tickets und Listen übernehmen.',
    credentials: 'Token einer HubSpot Private App (pat-…) unter Einstellungen → Import; wird verschlüsselt gespeichert.',
    docs: 'docs/integrations.md#hubspot-import',
    guide: ['In HubSpot: Einstellungen → Integrationen → Private Apps → „Private App erstellen“.', 'Scopes: crm.objects.contacts/companies/deals/owners.read, crm.schemas.contacts.read, crm.lists.read, tickets, sales-email-read.', 'Token unter Einstellungen → Import eintragen, Probelauf starten, dann importieren (mehrfach ausführbar).'],
  },
  { key: 'ghl', name: 'GoHighLevel-Import', category: 'Umzug', icon: 'download', scope: 'location', setup: { location: 'settings/import' }, description: 'Kontakte, Felder, Tags, Pipelines, Opportunities, Kalender und Termine aus GHL.', credentials: 'Private-Integration-Token (pit-…) des GHL-Sub-Accounts unter Einstellungen → Import (wird nicht gespeichert).' },
];

export interface ProbeResult {
  status: CatalogStatus;
  detail: string;
}

/** Agency view of a per-sub-account integration: "3 von 5 Sub-Accounts". */
export function aggregate(results: ProbeResult[]): ProbeResult {
  const real = results.filter((r) => r.status !== 'unavailable');
  if (!real.length) return results[0] ?? { status: 'unavailable', detail: 'Modul nicht installiert' };
  const ok = real.filter((r) => r.status === 'ok').length;
  const partial = real.filter((r) => r.status === 'partial').length;
  const info = real.every((r) => r.status === 'info');
  if (info) return real[0];
  const detail = `${ok} von ${real.length} Sub-Account${real.length === 1 ? '' : 's'} eingerichtet${partial ? `, ${partial} unvollständig` : ''}`;
  return { status: ok ? 'ok' : partial ? 'partial' : 'missing', detail };
}
