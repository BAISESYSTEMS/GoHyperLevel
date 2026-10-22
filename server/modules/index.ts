import type { Module } from '../core/app.js';
import { agencyModule } from './agency.js';
import { aiAssistantModule } from './ai-assistant.js';
import { backupsModule } from './backups.js';
import { trackingModule } from './tracking.js';
import { calendarSyncModule } from './calendar-sync.js';
import { calendarsModule } from './calendars.js';
import { campaignsModule } from './campaigns.js';
import { contactsModule } from './contacts.js';
import { conversationsModule } from './conversations.js';
import { coreModule } from './core.js';
import { dashboardModule } from './dashboard.js';
import { formsModule } from './forms.js';
import { formLibraryModule } from './form-library.js';
import { formAnalyticsModule } from './form-analytics.js';
import { formPaymentModule } from './form-payment.js';
import { funnelsModule } from './funnels.js';
import { siteRoutingModule } from './site-routing.js';
import { siteDesignModule } from './site-design.js';
import { siteA11yModule } from './site-a11y.js';
import { siteCmsModule } from './site-cms.js';
import { siteProductModule } from './site-product.js';
import { siteAnalyticsModule } from './site-analytics.js';
import { siteTemplatesModule } from './site-templates.js';
import { siteMediaModule } from './site-media.js';
import { siteSnapshotModule } from './site-snapshot.js';
import { customValuesModule } from './custom-values.js';
import { siteAiModules } from './site-ai.js';
import { aiStudioModule } from './ai-studio.js';
import { aiStudioPublishModule } from './ai-studio-publish.js';
import { agentAiModule } from './agent-ai.js';
import { pmCostingModule } from './pm-costing.js';
import { pmRetainersModule } from './pm-retainers.js';
import { quoteApprovalsModule } from './quote-approvals.js';
import { livechatModule } from './livechat.js';
import { dateTriggersModule } from './date-triggers.js';
import { twofactorModule } from './twofactor.js';
import { contractsModule } from './contracts.js';
import { socialModule } from './social.js';
import { securityModule } from './security.js';
import { supabaseMirrorModule } from './supabase-mirror.js';
import { invoiceLinksModule } from './invoice-links.js';
import { docsModule } from './docs.js';
import { projectFilesModule } from './project-files.js';
import { claudeImportModule } from './claude-import.js';
import { mcpApiModule } from './mcp-api.js';
import { agentOpsToolsModule } from './agent-ops-tools.js';
import { agencyListsModule } from './agency-lists.js';
import { projectsModule } from './projects.js';
import { emailImportModule } from './email-import.js';
import { mcpModule } from './mcp.js';
import { languageModule } from './language.js';
import { presenceModule } from './presence.js';
import { rootFilesModule } from './root-files.js';
import { landingModule } from './landing.js';
import { mkSegmentsModule } from './mk-segments.js';
import { mkDeliverabilityModule } from './mk-deliverability.js';
import { mkGalleryModule } from './mk-gallery.js';
import { mkAbandonedModule } from './mk-abandoned.js';
import { qrModule } from './qr.js';
import { reviewRepliesModule } from './review-replies.js';
import { reviewSourcesModule } from './review-sources.js';
import { gapsSitesModules } from './gaps-sites.js';
import { socialCommentsModule } from './social-comments.js';
import { voiceOutboundModule } from './voice-outbound.js';
import { callerIdsModule } from './caller-ids.js';
import { bookingExtrasModule } from './booking-extras.js';
import { workflowErrorsModule } from './workflow-errors.js';
import { workflowPauseModule } from './workflow-pause.js';
import { workflowValidateModule } from './workflow-validate.js';
import { workflowClipboardModule } from './workflow-clipboard.js';
import { workflowCanvasModule } from './workflow-canvas.js';
import { consentModule } from './consent.js';
import { consentCaptureModule } from './consent-capture.js';
import { consentPagesModule } from './consent-pages.js';
import { consentBannerModule } from './consent-banner.js';
import { legalPagesModule } from './legal-pages.js';
import { checkoutLawModule } from './checkout-law.js';
import { systemHealthModule } from './system-health.js';
import { perfIndexesModule } from './perf-indexes.js';
import { metaChannelsModule } from './meta-channels.js';
import { mailSyncModule } from './mail-sync.js';
import { ghlImportModule } from './ghl-import.js';
import { paymentsModule } from './payments.js';
import { invoicingModule } from './invoicing.js';
import { invoiceToolsModule } from './invoice-tools.js';
import { invoiceZugferdModule } from './invoice-zugferd.js';
import { pipelinesModule } from './pipelines.js';
import { tagMetaModule } from './tag-meta.js';
import { pipelineBoardModule } from './pipeline-board.js';
import { dealListModule } from './deal-list.js';
import { inboxSpamModule } from './inbox-spam.js';
import { callScriptsModule } from './call-scripts.js';
import { notesPlusModule } from './notes-plus.js';
import { crmGapModules } from './crm-gaps.js';
import { reputationModule } from './reputation.js';
import { workflowsModule } from './workflows.js';
import { stripeModule } from './stripe.js';
import { pushModule } from './push.js';
import { pwaIosModule } from './pwa-ios.js';
import { telephonyModule } from './telephony.js';
import { voiceAiModule } from './voice-ai.js';
import { browserPhoneModule } from './browser-phone.js';
import { telephonyAudioModule } from './telephony-audio.js';
import { telephonyNumbersModule } from './telephony-numbers.js';
import { telephonyIvrModule } from './telephony-ivr.js';
import { telephonyQueuesModule } from './telephony-queues.js';
import { telephonyDniModule } from './telephony-dni.js';
import { dialerModule } from './dialer.js';
import { callIntelModule } from './call-intel.js';
import { callScorecardsModule } from './call-scorecards.js';
import { telephonyCallsModule } from './telephony-calls.js';
import { googleReviewsModule } from './google-reviews.js';
import { blogModule } from './blog.js';
import { coursesModule } from './courses.js';
import { courseVideoModule } from './course-video.js';
import { courseDiscussModule } from './course-discuss.js';
import { courseCohortModule } from './course-paths.js';
import { courseAnalyticsModule } from './course-analytics.js';
import { coursePwaModule } from './course-pwa.js';
import { portalModule } from './portal.js';
import { funnelAbModule } from './funnel-ab.js';
import { buyOffersModule } from './buy-offers.js';
import { saasModule } from './saas.js';
import { saasGateModule } from './saas-gate.js';
import { saasSignupModule } from './saas-signup.js';
import { cloudModule } from './cloud.js';
import { publicUploadQuotaModule } from './public-upload-quota.js';
import { cloudPagesModule } from './cloud-pages.js';
import { cloudSignupModule } from './cloud-signup.js';
import { cloudBillingModule } from './cloud-billing.js';
import { cloudAccountModule } from './cloud-account.js';
import { cloudConsoleModule } from './cloud-console.js';
import { oauthConnectModule } from './oauth-connect.js';
import { calendarConnectModule } from './calendar-connect.js';
import { googleBusinessModule } from './google-business.js';
import { todoistModule } from './todoist.js';
import { emailBuilderModule } from './email-builder.js';
import { contentCopyModule } from './content-copy.js';
import { communityModule } from './community.js';
import { communityPortalModule } from './community-portal.js';
import { attributionModule } from './attribution.js';
import { affiliatesModule } from './affiliates.js';
import { adsModule } from './ads.js';
import { objectSchemaModule } from './object-schema.js';
import { associationsModule } from './associations.js';
import { companiesModule } from './companies.js';
import { customObjectsModule } from './custom-objects.js';
import { formMappingModule } from './form-mapping.js';
import { objectsAutomationModule } from './objects-automation.js';
import { leadScoringModule } from './lead-scoring.js';
import { objectsReportsModule } from './objects-reports.js';
import { ticketsModule } from './tickets.js';
import { helpdeskSlaModule } from './helpdesk-sla.js';
import { knowledgeBaseModule } from './knowledge-base.js';
import { csatModule } from './csat.js';
import { healthScoreModule } from './health-score.js';
import { helpdeskPortalModule } from './helpdesk-portal.js';
import { helpdeskReportsModule } from './helpdesk-reports.js';
import { mobileModule } from './mobile.js';
import { mobileAppModule } from './mobile-app.js';
import { appPushModule } from './app-push.js';
import { appShareModule } from './app-share.js';
import { appDiscoveryModule } from './app-discovery.js';
import { pushRelayModule } from './push-relay.js';
import { desktopAppModule } from './desktop-app.js';
import { reportsModule } from './reports.js';
import { restHooksModule } from './rest-hooks.js';
import { inboundWebhooksModule } from './inbound-webhooks.js';
import { openApiModule } from './openapi.js';
import { integrationsCatalogModule } from './integrations-catalog.js';
import { hubspotImportModule } from './hubspot-import.js';
import { academyModule } from './academy.js';
import { hqTemplateModule } from './hq-template.js';
import { landingWaitlistModule } from './landing-waitlist.js';
import { cloudWaitlistModule } from './cloud-waitlist.js';
import { cloudHqBridgeModule } from './cloud-hq-bridge.js';
import { videoStudioModule } from './video-studio.js';
import { videoStudioToolsModule } from './video-studio-tools.js';
import { videoRecycleModule } from './video-recycle.js';
import { aiProvidersModule } from './ai-providers.js';
import { mcpOAuthModule } from './mcp-oauth.js';
import { aiToolsModule } from './ai-tools.js';
import { githubCodexModule } from './github-codex.js';
import { loginPolicyModule } from './login-policy.js';
import { ssoModule } from './sso.js';
import { passkeysModule } from './passkeys.js';
import { magicLinkModule } from './magic-link.js';
import { composioModule } from './composio.js';
import { composioTriggersModule } from './composio-triggers.js';
import { composioAutomationModule } from './composio-automation.js';
import { connectorsModule } from './connectors.js';
import { connectorChatModule } from './connector-chat.js';
import { connectorNotionModule } from './connector-notion.js';
import { connectorSheetsModule } from './connector-sheets.js';
import { channelsModule } from './channels.js';
import { telegramModule } from './telegram.js';
import { discordModule } from './discord.js';
import { slackBridgeModule } from './slack-bridge.js';
import { emailProvidersModule } from './email-providers.js';
import { smsProvidersModule } from './sms-providers.js';
import { contactPushModule } from './contact-push.js';
import { feedbackModule } from './feedback.js';
import { feedbackAdminModule } from './feedback-admin.js';
import { feedbackCaptureModule } from './feedback-capture.js';
import { versionModule } from './version.js';
import { demoModule } from './demo.js';
import { tlsAskModule } from './tls-ask.js';
import { privacyModule } from './privacy.js';
import { canvasModule } from './canvas.js';
import { canvasIntegrationsModule } from './canvas-integrations.js';
import { canvasPublicModule } from './canvas-public.js';
import { canvasMcpModule } from './canvas-mcp.js';
import { nangoModule } from './nango.js';
import { mcpClientModule } from './mcp-client.js';
import { referralsModule } from './referrals.js';
import { aiConnectionsModule } from './ai-connections.js';
import { aiSubscriptionsModule } from './ai-subscriptions.js';
import { aiEffortModule } from './ai-effort.js';
import { agentModule } from './agent.js';
import { agentCustomModule } from './agent-custom.js';
import { agentConnectModule } from './agent-connect.js';
import { agentBridgeModule } from './agent-bridge.js';
import { genmediaModule } from './genmedia.js';
import { licenseModule } from './license.js';
import { flagsModule } from './flags.js';
import { pluginsModule } from './plugins.js';
import { werkstattModule } from './werkstatt.js';
import { marktplatzModule } from './marktplatz.js';
import { werkstattCoreModule } from './werkstatt-core.js';
import { werkstattToolsModule } from './werkstatt-tools.js';
import { connectorAppsBizModule } from './connector-apps-biz.js';
import { connectorAppsWorkModule } from './connector-apps-work.js';
import { wfxActionsModule } from './wfx-actions.js';
import { wfxToolsModule } from './wfx-tools.js';
import { wfxTriggersModule } from './wfx-triggers.js';
import { accountingModule } from './accounting.js';
import { receiptsModule } from './accounting-receipts.js';
import { bankModule } from './accounting-bank.js';
import { reportsModule as accountingReportsModule } from './accounting-reports.js';
import { accountingAutopostModule } from './accounting-autopost.js';
import { inventoryModule } from './inventory.js';
import { hrModule } from './hr.js';
import { backofficeMobileModule } from './backoffice-mobile.js';
import { backofficeTimeModule } from './backoffice-time.js';
import { pmModule } from './pm.js';
import { pmTimeModule } from './pm-time.js';
import { pmAutomationModule } from './pm-automation.js';
import { pmPortalModule } from './pm-portal.js';
import { pmToolsModule } from './pm-tools.js';
import { pmMobileModule } from './pm-mobile.js';
import { wikiModule } from './wiki.js';
import { wikiExtrasModule } from './wiki-extras.js';
import { wikiPublicModule } from './wiki-public.js';
import { wikiMcpModule } from './wiki-mcp.js';
import { officeModule } from './office.js';
import { officeCollabModule } from './office-collab.js';
import { officeToolsModule } from './office-tools.js';
import { teamchatModule } from './teamchat.js';
import { teamchatCommandsModule } from './teamchat-commands.js';
import { teamchatMcpModule } from './teamchat-mcp.js';
import { collabMobileModule } from './collab-mobile.js';
import { mailboxModules } from './mailboxes.js';
import { adsConnectModule } from './ads-connect.js';
import { adsAudiencesModule } from './ads-audiences.js';
import { adsLeadsModule } from './ads-leads.js';
import { adsCampaignsModule } from './ads-campaigns.js';
import { adsRulesModule } from './ads-rules.js';
import { adsToolsModule } from './ads-tools.js';
import { appearanceModule } from './appearance.js';
import { navUsageModule } from './nav-usage.js';
import { voiceModule } from './voice.js';
import { voicePhoneModule } from './voice-phone.js';
import { calcModule } from './calc.js';
import { calcToolsModule } from './calc-tools.js';
import { boardsModule } from './boards.js';
import { boardsComposeModule } from './boards-compose.js';
import { boardsTemplatesModule } from './boards-templates.js';
import { boardsToolsModule } from './boards-tools.js';
import { focusModule } from './focus.js';
import { companionModule } from './companion.js';
import { companionLiveModule } from './companion-live.js';
import { companionGrowthModule } from './companion-growth.js';
import { xrModule } from './xr.js';
import { webinarsModule } from './webinars.js';
import { webinarPublicModule } from './webinar-public.js';
import { webinarAutomationModule } from './webinar-automation.js';
import { webinarToolsModule } from './webinar-tools.js';
import { communityExtModule } from './community-ext.js';
import { communityPagesModule } from './community-pages.js';
import { communityFeedModule } from './community-feed.js';
import { communityMembersModule } from './community-members.js';
import { communityDmModule } from './community-dm.js';
import { communityGamifyModule } from './community-gamify.js';
import { communityGrowthModule } from './community-growth.js';
import { communityChallengesModule } from './community-challenges.js';
import { communityLiveModule } from './community-live.js';
import { communityPwaModule } from './community-pwa.js';
import { communityImportModule } from './community-import.js';
import { communityAutomationModule } from './community-automation.js';
import { communityMobileModule } from './community-mobile.js';
import { creatorPlansModule } from './creator-plans.js';
import { dunningModule } from './dunning.js';
import { dunningBillingModule } from './dunning-billing.js';
import { dunningInvoicesModule } from './dunning-invoices.js';
import { sepaModules } from './sepa.js';
import { storeModules } from './store.js';
import { quizModule } from './quiz.js';
import { quizAssignmentsModule } from './quiz-assignments.js';
import { quizPortalModule } from './quiz-portal.js';
import { quizCertificatesModule } from './quiz-certificates.js';
import { igCommentsModule } from './igcomments.js';
import { wfaiModule } from './wfai.js';
import { creatorMobileModule } from './creator-mobile.js';
import { umzugModule } from './umzug.js';
import { mailcheckModule } from './umzug-mailcheck.js';
import { umzugToolsModule } from './umzug-tools.js';
import { teamPeopleModule } from './team-people.js';
import { teamInboxModule } from './teaminbox.js';
import { teamInboxEngineModule } from './teaminbox-engine.js';
import { teamInboxAutomationModule } from './teaminbox-automation.js';
import { teamInboxToolsModule } from './teaminbox-tools.js';
import { teamCalModule } from './teamcal.js';
import { teamCalPublicModule } from './teamcal-public.js';
import { teamCalToolsModule } from './teamcal-tools.js';
import { msgDraftsModule } from './msg-drafts.js';
import { undoModule } from './undo.js';
import { undoEntitiesModule } from './undo-entities.js';
import { undoToolsModule } from './undo-tools.js';
import { cogneeModule } from './cognee.js';
import { cogneeSyncModule } from './cognee-sync.js';
import { cogneeToolsModule } from './cognee-tools.js';
import { salesModules } from './sales.js';
import { calendarViewModules } from './calview.js';
import { parityBookingModules } from './parity-booking.js';
import { portalFilesModule } from './portal-files.js';
import { booksSyncModule } from './books-sync.js';
import { adsConversionsModule } from './ads-conversions.js';
import { offsiteBackupModule } from './offsite-backup.js';
import { opsAlertsModule } from './ops-alerts.js';
import { statusPageModule } from './status-page.js';
import { cloudAbuseModule } from './cloud-abuse.js';
import { cloudSitesModule } from './cloud-sites.js';

/**
 * Every feature is a module: its own tables (migrations) and routes. Order matters only for
 * migrations that reference another module's tables, so the base ones come first.
 */
export const MODULES: Module[] = [
  coreModule,
  contactsModule,
  pipelinesModule,
  calendarsModule,
  // Forms: library (templates, themes, Turnstile keys) before forms.ts so /api/forms/templates is not taken for /api/forms/:id; analytics and the payment field after.
  formLibraryModule,
  formsModule,
  formAnalyticsModule,
  formPaymentModule,
  funnelsModule,
  conversationsModule,
  // Team-Posteingang (assignee, status, snooze, notes, SLA): right after the conversations so its message.inbound listener runs
  // before push, mobile feed and the AI assistant – they ask who the assignee is. Team people (availability) is shared with the Team-Kalender.
  teamPeopleModule,
  teamInboxModule,
  teamInboxEngineModule,
  teamInboxAutomationModule,
  teamInboxToolsModule,
  workflowsModule,
  campaignsModule,
  paymentsModule,
  // GoBD invoicing (finalising, Storno, credit notes, XRechnung, PDF): after the invoices table exists
  invoicingModule,
  invoiceToolsModule,
  invoiceZugferdModule,
  reputationModule,
  dashboardModule,
  ghlImportModule,
  agencyModule,
  trackingModule,
  calendarSyncModule,
  backupsModule,
  livechatModule,
  dateTriggersModule,
  twofactorModule,
  contractsModule,
  socialModule,
  securityModule,
  projectsModule,
  agencyListsModule,
  docsModule,
  // Project files (any file of a project, text or binary), moving claude.ai projects over and ghl_api (every REST route over MCP,
  // keys and sign-in excluded) – docs/ai-tools.md#project-files. After projects and docs, whose routes the import calls.
  projectFilesModule,
  claudeImportModule,
  mcpApiModule,
  // Everyday agent tools (tasks, appointments, contacts, drafts, invoices, campaigns, workflows, forms, surveys, settings) –
  // docs/agent.md#abdeckung; relays onto the routes, so the order only matters for the tool list.
  agentOpsToolsModule,
  invoiceLinksModule,
  supabaseMirrorModule,
  emailImportModule,
  aiAssistantModule,
  metaChannelsModule,
  stripeModule,
  pushModule,
  telephonyModule,
  voiceAiModule,
  browserPhoneModule,
  // Telefonie & Gesprächs-Intelligenz: audio files, numbers (buy, route, track), telephone menu, ring groups and queues.
  telephonyAudioModule,
  telephonyNumbersModule,
  telephonyIvrModule,
  telephonyQueuesModule,
  telephonyDniModule,
  dialerModule,
  callIntelModule,
  callScorecardsModule,
  telephonyCallsModule,
  googleReviewsModule,
  blogModule,
  // Creator depth (courses): these register their /api/courses/<name> routes before courses.ts takes /api/courses/:id.
  courseVideoModule,
  courseDiscussModule,
  courseCohortModule,
  courseAnalyticsModule,
  coursePwaModule,
  coursesModule,
  portalModule,
  funnelAbModule,
  buyOffersModule,
  saasModule,
  saasGateModule,
  saasSignupModule,
  oauthConnectModule,
  calendarConnectModule,
  googleBusinessModule,
  todoistModule,
  emailBuilderModule,
  contentCopyModule,
  communityModule,
  communityPortalModule,
  // Attribution first: affiliates and ads hook into its visits (app.services.attributionHooks).
  attributionModule,
  affiliatesModule,
  adsModule,
  // Relational CRM: properties first, then associations (companies and custom objects register their types there).
  objectSchemaModule,
  associationsModule,
  companiesModule,
  customObjectsModule,
  // Form fields into company, deal and custom-object fields (docs/forms.md#field-mapping): hooks of forms.ts, after the objects.
  formMappingModule,
  objectsAutomationModule,
  leadScoringModule,
  objectsReportsModule,
  // Helpdesk (Service): tickets first – SLA, knowledge base, surveys, health score and portal build on its tables.
  ticketsModule,
  helpdeskSlaModule,
  knowledgeBaseModule,
  csatModule,
  healthScoreModule,
  helpdeskPortalModule,
  helpdeskReportsModule,
  // Native Android app: device tokens + /api/mobile/*, APK download page and App Links.
  mobileModule,
  mobileAppModule,
  // Gray-label apps (docs/apps.md): native push (own keys or the operator's relay), share into the CRM, instance discovery
  // (/.well-known/gohyperlevel-app.json + the cloud directory), the push relay itself (PGHL_PUSH_RELAY=1), desktop updates.
  appPushModule,
  appShareModule,
  appDiscoveryModule,
  pushRelayModule,
  desktopAppModule,
  // Integrations: REST hooks (Zapier/Make/n8n), "Webhook empfangen", OpenAPI, catalogue, HubSpot import.
  restHooksModule,
  inboundWebhooksModule,
  openApiModule,
  integrationsCatalogModule,
  hubspotImportModule,
  // Reports read every other module's tables (app.services.reportSources), so they come late.
  reportsModule,
  academyModule,
  // Video-Studio (OpenShorts): shorts from long videos → Social Planner; tools = YouTube-Studio + AI Shorts;
  // recycle = blog/newsletter/social texts from the transcript + the feed autopilot.
  videoStudioModule,
  videoStudioToolsModule,
  videoRecycleModule,
  // KI-Werkzeuge: OpenAI as second AI provider, OAuth 2.1 for MCP clients (ChatGPT, Claude.ai, Codex),
  // keys + connected apps per sub-account/agency, GitHub issues for Codex.
  aiProvidersModule,
  mcpOAuthModule,
  aiToolsModule,
  githubCodexModule,
  // Sign-in: policy first (sessions/tickets), then social + OIDC SSO, passkeys (wraps the 2FA check), magic links.
  loginPolicyModule,
  ssoModule,
  passkeysModule,
  magicLinkModule,
  // Connectors: Composio (250+ apps – catalogue, connect, workflow action + trigger, AI & MCP) and the
  // native ones without Composio (Slack/Discord webhooks, Notion token, Google Sheets via Google OAuth).
  composioModule,
  composioTriggersModule,
  composioAutomationModule,
  connectorsModule,
  connectorChatModule,
  connectorNotionModule,
  connectorSheetsModule,
  // More channels: shared tables first, then Telegram, Discord, Slack (team), email/SMS APIs, push to contacts.
  channelsModule,
  telegramModule,
  discordModule,
  slackBridgeModule,
  emailProvidersModule,
  smsProvidersModule,
  contactPushModule,
  // Fehler & Wünsche: bug reports, wish list and automatic error capture – tickets in the agency's support sub-account.
  feedbackModule,
  feedbackAdminModule,
  feedbackCaptureModule,
  // GET /api/version; demo mode (PGHL_DEMO_MODE=1: seeded data, nightly reset, nothing leaves the server).
  versionModule,
  demoModule,
  // Caddy on-demand TLS: certificates only for domains this install serves.
  tlsAskModule,
  // Canvas: infinite whiteboard/design boards – realtime, live CRM cards, AI drawing, MCP tools, public links.
  canvasModule,
  canvasIntegrationsModule,
  canvasPublicModule,
  canvasMcpModule,
  // GDPR: export / erase one contact across every module (reads all tables, so it comes late).
  privacyModule,
  // "Konto anlegen" links for every provider (optional partner links, /go/ redirect, Agentur → Partner-Links).
  referralsModule,
  // KI-Anbieter (BYOK registry for every text/media provider) and the HyperLevel Agent.
  aiConnectionsModule,
  // Denkstufe (reasoning effort) per capability, default xhigh.
  aiEffortModule,
  agentModule,
  agentCustomModule,
  agentConnectModule,
  agentBridgeModule,
  // "KI-Agent mit KI erstellen": a description → a checked custom-agent config, saved as a draft agent (docs/agent.md#build-with-ai).
  agentAiModule,
  // Abo-Anmeldung: "Mit ChatGPT anmelden" as a personal connection (Claude: bridge or API key, see the module's header).
  aiSubscriptionsModule,
  // KI-Studio: images, video, music, speech and transcription with the sub-account's own provider keys (BYOK).
  genmediaModule,
  // Werkstatt: feature flags, the plugin runtime (isolated UI, bridge, sandboxed server logic), building wishes, Marktplatz.
  licenseModule,
  flagsModule,
  pluginsModule,
  werkstattModule,
  marktplatzModule,
  werkstattCoreModule,
  werkstattToolsModule,
  // Stimme (voice layer): speech providers of the BYOK registry, push-to-talk for the HyperLevel Agent, the KI-Telefonagent with its own voice (Media Streams).
  voiceModule,
  voicePhoneModule,
  // Ads manager: create and manage Meta / Google campaigns (connections, audiences, Lead Ads, campaigns, rules, MCP tools).
  adsConnectModule,
  adsAudiencesModule,
  adsLeadsModule,
  adsCampaignsModule,
  adsRulesModule,
  adsToolsModule,
  // More connectors: Nango (own OAuth apps, Auth + Proxy) and external MCP servers as tool sources (MCP client).
  nangoModule,
  mcpClientModule,
  // More workflow steps (formatter, math, code, find, go-to, split test, loop, drip, waits, CRM, AI, HTTP) – docs/workflow-actions.md.
  wfxActionsModule,
  wfxToolsModule,
  wfxTriggersModule,
  connectorAppsWorkModule,
  connectorAppsBizModule,
  // Back-Office: Buchhaltung light (Vorbereitung für den Steuerberater: Belege, Buchungen, Bank, Berichte, DATEV), Lager & Einkauf, Personal.
  accountingModule,
  receiptsModule,
  bankModule,
  accountingReportsModule,
  accountingAutopostModule,
  inventoryModule,
  hrModule,
  backofficeMobileModule,
  // Hours of the project planner's time tracking for the HR working-time overview (offers the hook only if the planner is built in).
  backofficeTimeModule,
  // Project planning: projects with custom statuses, tasks with subtasks and dependencies, list/board/calendar/Gantt/workload
  // views, time tracking with invoicing, automations + templates, customer portal view, MCP tools and the mobile API.
  pmModule,
  pmTimeModule,
  pmAutomationModule,
  pmPortalModule,
  pmToolsModule,
  pmMobileModule,
  // Wiki (team-internal spaces and pages: versions, share links, help-center publishing, AI, PDF) – after Canvas and
  // the knowledge base, whose records it embeds and publishes to.
  wikiModule,
  wikiExtrasModule,
  wikiPublicModule,
  wikiMcpModule,
  // Office (documents, spreadsheets, presentations, PDF): files with versions, edit lock and comments, the optional browser editors
  // and headless engines, agent/MCP tools – after contacts, deals and projects, which files link to (docs/office.md).
  officeModule,
  officeCollabModule,
  officeToolsModule,
  // Team-Chat (channels, DMs, threads, realtime over SSE, notifications, /aufgabe /kontakt /agent) and the mobile API of both.
  teamchatModule,
  teamchatCommandsModule,
  teamchatMcpModule,
  collabMobileModule,
  // Darstellung: per-user theme/accent/sidebar/icons/hidden menu entries, agency defaults + locks, logo upload.
  appearanceModule,
  // Einfach-Modus: menu use per person (adaptive sidebar) – docs/theming.md#einfach-modus.
  navUsageModule,
  // Event-loop lag, slow requests/queries and job times for Agentur → System.
  systemHealthModule,
  // Indexes for the dashboard / agency / mobile queries (comes after every module that owns a table it indexes).
  perfIndexesModule,
  // Native mailboxes: Gmail and Outlook / Microsoft 365 over their official APIs (sync, push, send, drafts, MCP tools).
  ...mailboxModules,
  // Gewinnrechner: profit calculator (engine, scenarios, MCP tools, app endpoints).
  calcModule,
  calcToolsModule,
  // Living Boards: workspaces composed from widgets – by dragging or by saying what you want to see (versions, realtime, templates, MCP tools).
  boardsModule,
  boardsComposeModule,
  boardsTemplatesModule,
  boardsToolsModule,
  // Fokus-Modus: ask in plain words (typed, spoken or over MCP) and get an ephemeral view of board widgets – docs/living-boards.md#fokus-modus.
  focusModule,
  // Fokus-Modus mit Companion: the person's companion (agent, name, wake phrase, voice), "Was brennt?" and proactive check-ins
  // (scheduler, push, MCP ghl_briefing) – docs/living-boards.md#fokus-modus-mit-companion.
  companionModule,
  // Jarvis live: event triggers (new lead, waiting message, overdue invoice …), the initiative engine (suggestions with prepared
  // drafts) and the realtime voice proxy (Gemini Live) – docs/living-boards.md#jarvis-live.
  companionLiveModule,
  // Jarvis als Business Developer: the role prompt, the Wachstums-Briefing and the Wochenbilanz (scheduler, check-ins, MCP
  // ghl_growth_review) and the rule-based answer when no model answers – docs/living-boards.md#business-developer.
  companionGrowthModule,
  // XR (Raum-Modus): per-person layouts of the floating board panels, the canvas plane and the Arbeitsfläche – docs/xr.md.
  xrModule,
  // Webinare: automated webinars (video on a schedule, registration page, room with questions/polls/offer, reminders, tracking, numbers).
  webinarsModule,
  webinarPublicModule,
  webinarAutomationModule,
  webinarToolsModule,
  // Community, beyond the first version: settings and roles, the public page with joining (tiers, approval, Stripe), then the member
  // extras (messages, polls, challenges, live calls …) – all listed in docs/community.md.
  communityExtModule,
  communityPagesModule,
  communityFeedModule,
  communityMembersModule,
  communityDmModule,
  communityGamifyModule,
  communityGrowthModule,
  communityChallengesModule,
  communityLiveModule,
  communityPwaModule,
  communityImportModule,
  communityAutomationModule,
  communityMobileModule,
  // Creator & Commerce: payment plans (Ratenzahlung) on the Stripe buy links.
  creatorPlansModule,
  // Mahnwesen: failed subscription payments (billing page, access pause) and Mahnstufen for overdue invoices.
  dunningModule,
  dunningBillingModule,
  dunningInvoicesModule,
  // Quizzes, assignments and certificates in courses (lesson gates and extras plug into the member portal).
  quizModule,
  quizAssignmentsModule,
  quizPortalModule,
  quizCertificatesModule,
  igCommentsModule,
  wfaiModule,
  creatorMobileModule,
  // Umzug: switch-over importers (24 tools from Mailchimp to sevDesk, export files; the registry is services/umzug-core.ts) and the deliverability wizard.
  umzugModule,
  mailcheckModule,
  umzugToolsModule,
  // Team-Kalender: round robin, collective and group booking calendars, questions, pay at booking, automatic video links, routing forms.
  // After the calendar sync modules: it chains their busy-time hooks.
  teamCalModule,
  teamCalPublicModule,
  teamCalToolsModule,
  // SMS-/WhatsApp-Entwürfe: the agent/MCP stores a reply draft, the inbox composer sends it – docs/team-inbox.md#sms-and-whatsapp-drafts.
  msgDraftsModule,
  // Einwilligung & Recht: the consent ledger (status per channel and purpose, Double-Opt-in, send gate, proof export, preference
  // centre), the cookie banner (CMP, blocks third-party code until consent), legal text generators (Impressum, Datenschutz, AVV, VVT,
  // Widerrufsbelehrung) and the German checkout rules. After the modules whose pages and hooks they extend – docs/consent.md.
  consentModule,
  consentCaptureModule,
  consentPagesModule,
  consentBannerModule,
  legalPagesModule,
  checkoutLawModule,
  // Rückgängig, Verlauf, Papierkorb: the journal that watches every write (after the modules whose routes it tracks), the records it knows, MCP/mobile/agent access.
  undoModule,
  undoEntitiesModule,
  undoToolsModule,
  // Wissensgedächtnis (Cognee): connection, opt-ins per sub-account and data type, sync job, ask/remember, MCP + agent tools – docs/cognee.md.
  cogneeModule,
  cogneeSyncModule,
  cogneeToolsModule,
  // Vertrieb: record-level access and teams, sequences, line items and quotes, duplicates, quotas – docs/sales.md.
  ...salesModules,
  // QR codes (PNG/SVG) for share links: booking pages, review, buy, funnel and trigger links.
  qrModule,
  // KI-Antwort vorschlagen for Google reviews (tone, brand voice, drafts, optional auto-draft – never posts).
  reviewRepliesModule,
  // Booking polish: several reminders by e-mail and SMS, follow-up and no-show messages (limits and date-specific hours are in calendars.ts).
  bookingExtrasModule,
  // Workflow error handling: error notices (bell, e-mail), "Bei Fehler: anderen Workflow starten", repeat a stopped run from the failed step.
  workflowErrorsModule,
  // Workflow builder: pause single steps (the engine skips them with a log line), validation of required step settings,
  // copy and paste of steps between workflows, the visual canvas's layout (docs/workflow-actions.md).
  workflowPauseModule,
  workflowValidateModule,
  workflowClipboardModule,
  workflowCanvasModule,
  // Cloud mode (PGHL_CLOUD_MODE=1): the hosted service – signup, billing on top of the SaaS tables, customer account area, operator console.
  // Without the flag these register nothing (docs/cloud.md).
  cloudModule,
  cloudPagesModule,
  cloudSignupModule,
  cloudBillingModule,
  cloudAccountModule,
  cloudConsoleModule,
  // Disk quota for files anonymous visitors send through public forms, per sub-account (and the cloud plan's meter) – docs/forms.md.
  publicUploadQuotaModule,
  // iPhone/iPad/foldable app: touch icons and launch images in the white label's look, the badge number (docs/ios-web-app.md).
  pwaIosModule,
  // E-Mail-Marketing: behaviour segments, the template gallery, deliverability (warm-up, reputation, hygiene, address checks) and
  // the abandoned-checkout trigger – docs/email-marketing.md. After campaigns, tracking, stripe and consent, which they build on.
  mkSegmentsModule,
  mkDeliverabilityModule,
  mkGalleryModule,
  mkAbandonedModule,
  // Website builder 2.0 (after the blog: its /blog/<post> route has to match before the generic deep paths): redirects, search, translations.
  siteRoutingModule,
  siteDesignModule,
  siteA11yModule,
  siteCmsModule,
  siteProductModule,
  siteAnalyticsModule,
  siteTemplatesModule,
  siteMediaModule,
  siteSnapshotModule,
  // Funnel & Website AI: brief → page plan → checked block JSON, applied as drafts (unpublished sites, restore points), section commands, AI writer – docs/site-ai.md.
  ...siteAiModules,
  // AI Studio: chat-first builder of static apps/websites with the BYOK registry, sandboxed build, preview, versions – docs/ai-studio.md.
  aiStudioModule,
  // Publishing of AI Studio apps: static files under /apps/<slug>/ with a sandboxing CSP, optional own origin or custom domain – docs/ai-studio.md#publish.
  aiStudioPublishModule,
  // Lexware Office / sevDesk live sync (finalised invoices out, payments back) and Google Ads offline conversions (consent-gated) –
  // docs/integrations.md, docs/ads-manager.md. After invoicing, invoice-links, ads, attribution and consent, whose tables and hooks they use.
  booksSyncModule,
  adsConversionsModule,
  // Job costing & retainers (budgets with alert thresholds, cost rates, external costs, profitability, monthly retainers) and the
  // internal approval of quotes (gate in the send path) – docs/projects.md#job-costing-and-retainers, docs/sales.md#internal-approval.
  pmCostingModule,
  pmRetainersModule,
  quoteApprovalsModule,
  // SEPA without Stripe: mandates (paper and online), collection runs (pain.008), returns, transfer batches (pain.001) – docs/sepa.md.
  ...sepaModules,
  // Payment providers (Stripe, PayPal, Mollie behind one registry), gift cards and the online store with cart, shipping, orders and
  // fulfilment – docs/payment-providers.md, docs/store.md. After payments, Stripe (whose invoice button it extends), inventory and team calendars.
  ...storeModules,
  // Custom Values: global placeholders {{custom_values.key}} per sub-account (e-mail, SMS, workflows, documents, pages, snapshots) – docs/custom-values.md.
  customValuesModule,
  // UI language per person (Accept-Language as the default, user.lang in /api/me) – docs/translating.md.
  languageModule,
  // Live-Zusammenarbeit überall: who of the team is on which page, "saved here", live cursors – live state only (docs/collaboration.md).
  presenceModule,
  // HighLevel parity: tag colours and categories (chips everywhere tags show, snapshot part `tag_meta`) – docs/api.md.
  tagMetaModule,
  // Kanban comfort: the pipelines' order (stage colours live in the stages, folded stages and widths in the browser).
  pipelineBoardModule,
  // Opportunity list view: bulk actions (stage, owner, delete – one undo entry) and the CSV export; filters/sort live in GET /api/opportunities.
  dealListModule,
  // Mark as spam and block sender: receive hook archives a blocked contact's messages, the first call router rejects its calls.
  inboxSpamModule,
  // Call scripts with placeholders and branches per dialer list or pipeline (shown in the browser phone and the power dialer).
  callScriptsModule,
  // Better notes: title, colour, pinning, Markdown (rendered by the wiki sanitiser), search; extends the add_note step.
  notesPlusModule,
  // HighLevel parity – CRM/inbox/automation gaps: tags in bulk, inbox filters and message search, bulk owner, field clean-up, outbound triggers.
  ...crmGapModules,
  // HighLevel parity – reach: reviews from many platforms (adapter registry, one review table – docs/reputation.md), Facebook/Instagram/
  // YouTube/LinkedIn comments as an inbox channel (docs/social-comments.md), outbound Voice AI calls (docs/voice.md#outbound-ai-calls)
  // and verified own numbers as caller ID (docs/telephony.md#your-own-number-as-caller-id). After reputation, meta channels, Nango,
  // telephony, the dialer and the KI-Telefonagent, whose hooks they use.
  reviewSourcesModule,
  socialCommentsModule,
  callerIdsModule,
  voiceOutboundModule,
  // HighLevel parity – sites, marketing, agency: SEO-Check & schema, URL text, own fonts, password pages, … (after funnels, social, agency).
  ...gapsSitesModules,
  // /robots.txt and /favicon.ico of the app's own domain (websites on their own domain keep theirs).
  rootFilesModule,
  // The public launch landing page on the instance's own host (PGHL_LANDING=1, off by default) – docs/landing.md.
  landingModule,
  // Kalender: recurring appointments, day/week/month/team view with drag & drop, AI booking in chat (after calendars, team calendars, agents) – docs/booking.md.
  ...calendarViewModules,
  // HighLevel parity (booking, forms, payments, commerce, documents): several signers with roles and order for contracts – docs/sales.md.
  ...parityBookingModules,
  // Files in the customer portal: share a contact's documents, customer uploads back (after the portal and contact documents) – docs/sales.md.
  portalFilesModule,
  // Built-in templates ("Software- & SaaS-Firma (HQ)") and the landing page's waitlist hook – docs/company-playbook.md.
  // After forms, consent, tickets, knowledge base, reports and projects, whose routes they call.
  hqTemplateModule,
  landingWaitlistModule,
  // Cloud waitlist mode (PGHL_CLOUD_WAITLIST=1, or cloud mode without Stripe): gate on the signup routes, the waitlist form's endpoint
  // (into the landing waitlist hook's form, else a built-in list) and the operator's list – docs/cloud.md#waitlist-mode.
  cloudWaitlistModule,
  // Cloud lifecycle → the operator's own HQ sub-account (PGHL_HQ_LOCATION) – docs/cloud.md#cloud--hq-crm-bridge.
  cloudHqBridgeModule,
  // Operations: off-site encrypted backups with a monthly restore test, /healthz checks and alerts (e-mail, push, webhook), the public
  // status page – docs/backups.md. After feedback capture (the error hook they chain) and push.
  offsiteBackupModule,
  opsAlertsModule,
  statusPageModule,
  // Cloud mode: abuse handling (DSA notices, pause / offline / suspend, auto-pause on complaints) and customer sites on an origin of
  // their own with verified custom domains – docs/cloud.md. After the SaaS gate, the agency's domains and the funnels whose hooks they wrap.
  cloudAbuseModule,
  cloudSitesModule,
  mcpModule,
  mailSyncModule,
];
