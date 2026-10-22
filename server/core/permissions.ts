/** Areas a member (e.g. a client's login) can be given. Admins always have all of them. */
export const PERMISSIONS = {
  dashboard: 'Dashboard',
  conversations: 'Konversationen',
  calendars: 'Kalender',
  contacts: 'Kontakte & Aufgaben',
  opportunities: 'Opportunities',
  campaigns: 'Kampagnen & Vorlagen',
  workflows: 'Automationen',
  funnels: 'Funnels & Websites',
  courses: 'Kurse & Mitgliederbereich',
  forms: 'Formulare',
  payments: 'Rechnungen & Produkte',
  reviews: 'Bewertungen',
  social: 'Social Planner',
  helpdesk: 'Service (Tickets, Wissensdatenbank, Umfragen)',
  canvas: 'Canvas (Whiteboards & Design)',
  accounting: 'Buchhaltung (Belege, Buchungen, Berichte)',
  inventory: 'Lager & Einkauf',
  personal: 'Personal (Mitarbeiter, Abwesenheiten)',
  wiki: 'Wiki & Dokumente',
  teamchat: 'Team-Chat',
  office: 'Office (Dokumente, Tabellen, Präsentationen, PDF)',
  settings: 'Einstellungen des Sub-Accounts',
} as const;

export type Permission = keyof typeof PERMISSIONS;

/**
 * Cloud mode: the operator's admin logins belong to no customer's team – they are left out of people pickers, assignments and
 * notification audiences of a customer's sub-account (modules/cloud.ts sets app.services.hideUser). Without cloud mode: never hidden.
 */
export const hiddenUser = (app: { services: Record<string, any> }, u: { role?: any }, locationId: string): boolean => app.services.hideUser?.(u, locationId) === true;

/**
 * Cloud mode: the operator's lists of sub-accounts (/api/me, agency overview and projects, /api/locations) leave out customers
 * that have not opened their account for support (modules/cloud.ts sets app.services.hiddenLocations). Without cloud mode: unchanged.
 */
export const visibleLocations = <T>(app: { services: Record<string, any> }, u: { role?: any } | undefined, list: T[]): T[] => {
  const hidden = u ? (app.services.hiddenLocations?.(u) as Set<string> | undefined) : undefined;
  return hidden?.size ? list.filter((l) => !hidden.has(String((l as { id?: unknown }).id))) : list;
};

export function cleanPermissions(v: unknown): Permission[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return null;
  return v.map(String).filter((p): p is Permission => p in PERMISSIONS);
}

/**
 * Which area an API route belongs to. Lookups that other screens need (tag, field, pipeline,
 * form and calendar lists…) stay readable for everyone with access to the sub-account.
 */
// /api/werkstatt, /api/plugins, /api/marktplatz and /api/flags are deliberately not listed: who may build is the
// Werkstatt policy (admins by default), and what a plugin may touch is decided per call by its manifest scopes AND
// the area of the data behind each operation (services/werkstatt/manifest.ts → SCOPES[…].area, checked in the bridge).
const ROUTES: [prefix: string, perm: Permission, readableByAll?: boolean][] = [
  ['/api/dashboard', 'dashboard'],
  ['/api/search', 'contacts'],
  ['/api/conversations', 'conversations'],
  ['/api/blocked-contacts', 'conversations'],
  // Team-Posteingang: its settings are sub-account settings, everything else is working in the inbox.
  ['/api/inbox/settings', 'settings'],
  ['/api/inbox', 'conversations'],
  ['/api/messages', 'conversations'],
  ['/api/calls', 'conversations'],
  ['/api/telephony', 'settings'],
  ['/api/voice-ai/calls', 'conversations'],
  // Outbound AI calls: their limit and caller ID are settings, starting one and the list are working with contacts.
  ['/api/voice-ai/outbound/settings', 'settings'],
  ['/api/voice-ai/outbound', 'conversations'],
  ['/api/voice-ai', 'settings'],
  // Prompt-Optimierer: tests and changes of the AI agents' instructions are settings.
  ['/api/prompt-lab', 'settings'],
  // Own numbers as caller ID (verification call, default) are telephony settings.
  ['/api/caller-ids', 'settings'],
  // Stimme: setup, voices, test and latency are settings; push-to-talk, spoken replies and the own preferences need no extra area.
  ['/api/voice/settings', 'settings'],
  ['/api/voice/voices', 'settings'],
  ['/api/voice/test', 'settings'],
  ['/api/voice/latency', 'settings'],
  ['/api/phone/settings', 'settings'],
  ['/api/phone', 'conversations'],
  // Telefonie & Gesprächs-Intelligenz: numbers, menus, queues and tracking are settings (/api/telephony above); the power dialer's rules too,
  // working through a call list is Konversationen work.
  ['/api/dialer/settings', 'settings'],
  ['/api/dialer', 'conversations'],
  // Gesprächs-Intelligenz: reading analyses and uploading a recording is Konversationen work; its settings and the scorecards are managers' (settings).
  ['/api/call-intel/settings', 'settings'],
  ['/api/call-scorecards', 'settings'],
  ['/api/call-scripts/for', 'conversations'],
  ['/api/call-scripts', 'settings', true],
  ['/api/call-intel', 'conversations'],
  ['/api/livechat', 'settings', true],
  ['/api/ai/status', 'conversations', true],
  ['/api/ai/suggest', 'conversations'],
  ['/api/ai/summarize', 'conversations'],
  ['/api/ai/conversations', 'conversations'],
  ['/api/ai', 'settings'],
  ['/api/appointments', 'calendars'],
  ['/api/calendars', 'calendars', true],
  // Kalenderansicht, Terminserien and booking by AI; which calendars the AI may book is a sub-account setting.
  ['/api/calendar-view', 'calendars'],
  ['/api/appointment-series', 'calendars'],
  ['/api/ai-booking/settings', 'settings'],
  ['/api/ai-booking', 'calendars'],
  // Team-Kalender: types, members, pay-at-booking, routing forms.
  ['/api/team-calendars', 'calendars'],
  ['/api/team-routing', 'calendars'],
  // Leistungsmenü: the public services page that groups booking calendars (modules/service-menu.ts).
  ['/api/service-menus', 'calendars'],
  // Vermietung: items booked by date range (modules/rentals.ts).
  ['/api/rentals', 'calendars'],
  // Kalender-KI: why a time is (not) bookable (modules/calendar-ai.ts).
  ['/api/calendar-ai', 'calendars'],
  // Tickets: check-in at the door (modules/event-checkin.ts).
  ['/api/appointment-checkin', 'calendars'],
  // Event tickets with ticket types, sales report and check-in (modules/ticket-events.ts).
  ['/api/ticket-events', 'calendars'],
  ['/api/contacts', 'contacts'],
  ['/api/notes', 'contacts'],
  ['/api/tasks', 'contacts'],
  // Project planning (tasks, boards, Gantt, time entries); hourly rates and invoices from time belong to payments.
  ['/api/pm/billing', 'payments'],
  ['/api/pm', 'contacts'],
  ['/api/smart-lists', 'contacts', true],
  ['/api/activities', 'contacts'],
  ['/api/deal-smart-tags', 'opportunities', true],
  ['/api/deal-forecast', 'opportunities'],
  ['/api/opportunities', 'opportunities'],
  ['/api/pipelines', 'opportunities', true],
  ['/api/campaigns', 'campaigns'],
  ['/api/trigger-links', 'campaigns', true],
  ['/api/templates', 'campaigns', true],
  ['/api/email-builder/starters', 'campaigns', true],
  ['/api/email-builder/sections', 'campaigns', true],
  ['/api/email-builder', 'campaigns'],
  // E-Mail-Marketing: behaviour segments (readable for the pickers in other areas), the template gallery, deliverability and address checks.
  ['/api/segments', 'campaigns', true],
  ['/api/email-gallery', 'campaigns', true],
  ['/api/deliverability', 'campaigns'],
  ['/api/email-validation', 'campaigns'],
  ['/api/workflow-runs', 'workflows'],
  ['/api/workflow-ai', 'workflows'],
  ['/api/workflow-catalog', 'workflows'],
  ['/api/workflow-export', 'workflows'],
  ['/api/workflow-import', 'workflows'],
  ['/api/custom-events', 'workflows'],
  ['/api/workflow-folders', 'workflows', true],
  ['/api/workflows', 'workflows', true],
  ['/api/funnel-pages', 'funnels'],
  ['/api/funnels', 'funnels'],
  ['/api/ai-studio', 'funnels'],
  // Webinare (automated webinars: pages, room, registrations, numbers) belong to the pages area.
  ['/api/webinars', 'funnels'],
  ['/api/ab-tests', 'funnels'],
  ['/api/ab-variants', 'funnels'],
  ['/api/uploads', 'funnels'],
  // Website builder: components, templates, CMS collections and items, redirects (everything else hangs under /api/funnels/:id).
  ['/api/site-components', 'funnels'],
  ['/api/site-templates', 'funnels'],
  ['/api/site-collections', 'funnels'],
  ['/api/site-items', 'funnels'],
  ['/api/site-redirects', 'funnels'],
  ['/api/site-fonts', 'funnels'],
  ['/api/seo-audit', 'funnels'],
  ['/api/wordpress-plugin', 'forms'],
  ['/api/course-ai', 'courses'],
  ['/api/funnel-analytics', 'funnels'],
  // Funnel & Website AI: generation, review, drafts and restore points of the builder's AI panel.
  ['/api/site-ai', 'funnels'],
  ['/api/courses', 'courses', true],
  // Quizzes, assignments and certificates are course work.
  ['/api/quizzes', 'courses'],
  ['/api/assignments', 'courses'],
  ['/api/certificates', 'courses'],
  ['/api/community', 'courses'],
  ['/api/forms', 'forms', true],
  ['/api/form-files', 'forms'],
  ['/api/invoice-settings', 'settings'],
  ['/api/invoices', 'payments'],
  ['/api/invoice-links', 'payments'],
  ['/api/contracts', 'payments'],
  // Single-use discount codes for buy pages (modules/coupon-codes.ts).
  ['/api/coupon-codes', 'payments'],
  // Treuepunkte: settings, balances, rewards (modules/loyalty.ts).
  ['/api/loyalty', 'payments'],
  ['/api/social', 'social'],
  ['/api/social-approvals', 'social'],
  ['/api/social-queues', 'social'],
  ['/api/ig-comments', 'social'],
  // Social comments inbox: which platforms are read is a setting, replying/hiding is inbox work.
  ['/api/social-comments/settings', 'settings'],
  ['/api/social-comments', 'conversations'],
  ['/api/video-studio', 'social'],
  ['/api/audit', 'settings'],
  ['/api/project', 'settings', true],
  ['/api/docs', 'settings', true],
  // Project files (modules/project-files.ts): instructions, knowledge files and repository files of a project.
  ['/api/project-files', 'settings'],
  ['/api/subscriptions', 'payments'],
  ['/api/stripe/payments', 'payments'],
  ['/api/stripe/products', 'payments'],
  ['/api/buy-offers', 'payments'],
  ['/api/buy-coupons', 'payments'],
  // Creator & Commerce: payment plans and dunning belong to the payments area.
  ['/api/payment-plans', 'payments'],
  ['/api/dunning', 'payments'],
  // SEPA: mandates, collection runs and transfer batches are payments work (settings included, like dunning).
  ['/api/sepa', 'payments'],
  // Online store, gift cards: payments work; the provider credentials (PayPal, Mollie) are settings like Stripe's.
  ['/api/store', 'payments'],
  ['/api/gift-cards', 'payments'],
  ['/api/pay/sessions', 'payments'],
  ['/api/pay', 'settings'],
  ['/api/stripe', 'settings', true],
  ['/api/products', 'payments', true],
  ['/api/reviews', 'reviews'],
  // Reviews from other platforms: connecting a platform is a setting, the reviews, drafts and replies are review work.
  ['/api/review-sources', 'settings'],
  ['/api/review-items', 'reviews'],
  ['/api/video-testimonials', 'reviews'],
  // KI-Antworten: the tone and brand-voice settings are settings (readable for the dialog); suggesting and drafts are review work.
  ['/api/google-reviews/reply-settings', 'settings', true],
  ['/api/google-reviews/settings', 'settings'],
  ['/api/google-reviews/business', 'settings'],
  ['/api/google-reviews', 'reviews'],
  ['/api/tags', 'settings', true],
  ['/api/tag-categories', 'settings', true],
  ['/api/custom-fields', 'settings', true],
  // Custom Values: global placeholders {{custom_values.key}} – readable for everyone who writes texts, changed under settings.
  ['/api/custom-values', 'settings', true],
  ['/api/location', 'settings', true],
  ['/api/api-keys', 'settings'],
  ['/api/webhooks', 'settings'],
  ['/api/settings', 'settings'],
  ['/api/import', 'settings'],
  // Umzug zu HyperLevel: connections, uploaded exports, previews and import jobs of the switch-over wizard.
  ['/api/umzug', 'settings'],
  // E-Mail-Zustellung prüfen: the campaign send dialog reads the verdict for the sender's domain (campaigns); the wizard is a setting.
  ['/api/mail-domains/status', 'campaigns'],
  ['/api/mail-domains', 'settings'],
  // SaaS mode: plan, banner and limits are readable for everyone in the sub-account; billing actions need settings.
  ['/api/saas/account', 'settings', true],
  // Einwilligung & Recht: consent settings, texts and log, cookie banner, legal text generators and checkout rules are sub-account settings
  // (the proof of one contact is part of /api/contacts, area contacts).
  ['/api/consent', 'settings'],
  ['/api/cmp', 'settings'],
  ['/api/legal', 'settings'],
  ['/api/checkout-law', 'settings'],
  ['/api/attribution/settings', 'settings'],
  ['/api/attribution', 'dashboard'],
  ['/api/ads/report', 'dashboard'],
  // Ads manager: connections, settings and the agency's credentials are settings; campaigns, audiences, forms, leads,
  // rules, approvals and AI suggestions are campaign work; the numbers are the dashboard's.
  ['/api/ads/insights', 'dashboard'],
  ['/api/ads/overview', 'campaigns'],
  ['/api/ads/campaigns', 'campaigns'],
  ['/api/ads/review', 'campaigns'],
  ['/api/ads/audiences', 'campaigns'],
  ['/api/ads/targeting', 'campaigns'],
  ['/api/ads/leadforms', 'campaigns'],
  ['/api/ads/leads', 'campaigns'],
  ['/api/ads/google-leads', 'campaigns'],
  ['/api/ads/rules', 'campaigns'],
  ['/api/ads/approvals', 'campaigns'],
  ['/api/ads/activity', 'campaigns'],
  ['/api/ads/suggest', 'campaigns'],
  ['/api/ads', 'settings'],
  ['/api/affiliates', 'payments'],
  // Living Boards (and their templates): the Dashboard area; every widget additionally checks the area of the data it shows.
  ['/api/boards', 'dashboard'],
  ['/api/board-templates', 'dashboard'],
  // Gewinnrechner (profit calculator): pricing and cost scenarios belong to the sales/finance area.
  ['/api/calc', 'payments'],
  // Relational CRM: records are contact data, schemas (types, properties, labels) are settings.
  ['/api/companies', 'contacts'],
  ['/api/objects', 'contacts'],
  ['/api/object-views', 'contacts'],
  ['/api/record-notes', 'contacts'],
  ['/api/associations', 'contacts'],
  ['/api/association-labels', 'settings', true],
  ['/api/object-types', 'settings', true],
  ['/api/properties', 'settings', true],
  ['/api/property-groups', 'settings'],
  // Vertrieb: sequences, quotes, quotas and the leaderboard are sales work (Opportunities); who sees which records (rules, hidden fields)
  // is a sub-account setting – every person can read their own view; teams are readable for the pickers, changed by admins.
  ['/api/sales/access/me', 'settings', true],
  ['/api/sales/access', 'settings'],
  ['/api/sales', 'opportunities'],
  ['/api/sequences', 'opportunities'],
  ['/api/sequence-enrollments', 'opportunities'],
  ['/api/sequence-settings', 'opportunities'],
  ['/api/quotes', 'opportunities'],
  // Internal approval of quotes: requests and decisions are sales work; the rule itself checks for the settings area (modules/quote-approvals.ts).
  ['/api/quote-approvals', 'opportunities'],
  ['/api/quotas', 'opportunities'],
  ['/api/quota-settings', 'opportunities'],
  ['/api/leaderboard', 'opportunities'],
  ['/api/meeting-notes', 'opportunities'],
  ['/api/contact-duplicates', 'contacts'],
  // Lead scoring: models are settings (list readable), scores are contact data.
  ['/api/lead-scoring/models', 'settings', true],
  ['/api/lead-scoring/meta', 'contacts'],
  ['/api/lead-scoring', 'contacts'],
  // Helpdesk (Service); its settings belong to the sub-account settings, health scores to contacts.
  ['/api/tickets', 'helpdesk'],
  ['/api/helpdesk/settings', 'settings'],
  ['/api/helpdesk', 'helpdesk'],
  ['/api/kb', 'helpdesk'],
  ['/api/surveys', 'helpdesk'],
  ['/api/health', 'contacts'],
  // Reports & dashboards; each report source additionally checks its own area (modules/reports.ts).
  ['/api/reports', 'dashboard'],
  ['/api/hooks', 'settings'],
  ['/api/inbound-webhooks', 'workflows'],
  ['/api/integrations', 'settings'],
  // KI-Werkzeuge (keys, connected apps, connection test) and GitHub for Codex belong to the sub-account settings.
  ['/api/ai-tools', 'settings'],
  ['/api/github-codex', 'settings'],
  // KI-Anbieter (BYOK) and the agent's sub-account settings and costs; chatting with the agent needs no extra area.
  ['/api/ai-connections', 'settings'],
  ['/api/ai-effort', 'settings'],
  ['/api/agent/settings', 'settings'],
  ['/api/agent/usage', 'settings'],
  // Connectors: keys, catalogue, connections and the AI allow-list are settings; app actions and
  // app events are automations; Google Sheets export/import is contact data.
  ['/api/composio/tools', 'workflows'],
  ['/api/composio/execute', 'workflows'],
  ['/api/composio/triggers', 'workflows'],
  ['/api/composio/ai', 'workflows'],
  ['/api/composio/connections', 'settings', true],
  ['/api/composio', 'settings'],
  ['/api/connector-apps', 'workflows'],
  ['/api/connectors', 'settings', true],
  // Lexware Office / sevDesk live sync: connection, queue and log are sub-account settings (modules/books-sync.ts).
  ['/api/books-sync', 'settings'],
  ['/api/sheets/export', 'contacts'],
  ['/api/sheets/import', 'contacts'],
  ['/api/sheets', 'settings'],
  // Canvas boards; sharing inside a board is decided per board (owner, team access, members).
  ['/api/canvas', 'canvas'],
  // Wiki (team-internal spaces and pages) and Team-Chat; sharing inside a space / channel is decided per record.
  ['/api/wiki', 'wiki'],
  ['/api/team-chat', 'teamchat'],
  // Office: files, versions, edit lock, comments and the agent's engine calls; who may edit is the edit lock, not a per-file share.
  ['/api/office', 'office'],
  // Live-Zusammenarbeit: the sub-account's switch is a setting; presence, the team list and the own choices need no area
  // (a colleague's page is only shown to people who may open its area – services/presence-model.ts).
  ['/api/presence/settings', 'settings'],
  // Nango and external MCP servers: setup is settings; API calls / tool calls (and the editor's tool list) are automations.
  ['/api/nango/request', 'workflows'],
  ['/api/nango/connections', 'settings', true],
  ['/api/nango', 'settings'],
  ['/api/mcp-servers/call', 'workflows'],
  ['/api/mcp-servers/tools', 'workflows'],
  ['/api/mcp-servers', 'settings'],
  // Back-Office: Buchhaltung light, Lager & Einkauf, Personal (HR). The employees' own data lives under /api/me/hr
  // (no area: everyone sees only their own record there); /api/hr additionally needs the area explicitly (modules/hr.ts).
  ['/api/accounting', 'accounting'],
  ['/api/inventory', 'inventory'],
  ['/api/hr', 'personal'],
  // Native mailboxes (Gmail / Outlook): connecting and settings are the sub-account settings, working in the inbox is Konversationen.
  ['/api/mailboxes', 'settings'],
  ['/api/mail', 'conversations'],
  // Wissensgedächtnis (Cognee): what is shared and the status are sub-account settings; asking and remembering (/api/cognee/info, recall,
  // remember, memories) are open to everybody and check the member's own areas themselves (modules/cognee.ts).
  ['/api/cognee/admin', 'settings'],
];

export function requiredPermission(method: string, path: string): Permission | undefined {
  for (const [prefix, perm, readable] of ROUTES) {
    if (path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '.')) {
      // Only the plain list (and workflow meta) is a lookup; details, runs and submissions are data.
      if (readable && method === 'GET' && (path === prefix || path === prefix + '/meta')) return undefined;
      return perm;
    }
  }
  return undefined;
}
