# Roadmap

What we plan next – roughly in this order. Priorities move with feedback: 👍 the matching issue or open a
[feature request](https://github.com/gohyperlevel/gohyperlevel/issues/new?template=feature_request.yml) /
[connector request](https://github.com/gohyperlevel/gohyperlevel/issues/new?template=connector_request.yml).

## Now

- **English UI, phase 3.** Phases 1 and 2 have shipped: a small language layer (German texts are the message ids, one
  lazy catalog per area and language), a language per person with the browser's language as the default, and English
  for the app shell, sign-in, dashboard, contacts, opportunities, inbox, calendar, settings and invoices, then for
  workflows, email marketing, funnels/websites, forms, tasks and projects, reports, the helpdesk, the social planner,
  wiki and team chat, and courses – see [translating.md](translating.md#what-is-translated). Next come the remaining
  pages area by area (the community first, then calls, accounting, HR …; each one a namespace that
  `npm run i18n:check` keeps complete), then the guided tours, the *Akademie* and the handbook, the server-rendered
  public pages and e-mails, and machine-readable codes for the server's own error messages.
- **Community translations.** Adding a language is a folder of catalogs plus two registry lines
  ([how to add a language](translating.md#adding-a-language)) – pull requests for French, Spanish, Dutch … are
  welcome; untranslated areas fall back to German.
- **Public demo instance.** Demo mode itself is done (`PGHL_DEMO_MODE=1`, see [demo-mode.md](demo-mode.md)); what is
  missing is a permanently running public instance of it.

## Next

- **More connectors:** Mollie and PayPal checkout, Cal.com, Telegram, Brevo/Postmark as e-mail providers,
  more SMS gateways. (Lexware Office/sevDesk live sync and Google Ads offline conversions have shipped – see
  [integrations.md](integrations.md#lexware-office-and-sevdesk-live-sync) and [ads-manager.md](ads-manager.md#offline-conversions-google-ads).)
- **Hosted messaging made easier:** guided setup for e-mail domains (SPF/DKIM checks) and Twilio numbers.
- **Plugin packages:** install third-party modules (same registry contract as built-in modules) without
  forking.
- **iOS:** native wrapper with widgets (the PWA with push already works on iOS 16.4+).

## Later

- Optional Postgres backend for very large installs (SQLite stays the default).
- A visual workflow canvas on top of the step editor.
- A marketplace for snapshots (templates) between agencies – the Marktplatz for plugins
  ([werkstatt.md](werkstatt.md)) is the model.

## Recently shipped

The details are in the [changelog](../CHANGELOG.md); the larger steps since this page was first written:

- OAuth for the MCP server and one-click setup of Codex, Claude Code, Cursor, ChatGPT and Claude.ai
  ([ai-tools.md](ai-tools.md)).
- Telegram, Discord and Slack channels, more e-mail and SMS providers, and the SPF/DKIM/DMARC check
  ([channels.md](channels.md), [deliverability.md](deliverability.md)).
- Werkstatt and Marktplatz: wishes that build themselves, sandboxed plugins, signed bundles
  ([werkstatt.md](werkstatt.md)).
- Funnel analytics per step, AI agents with schedules, Living Boards, the Canvas, the Wiki and team chat.
- The hosted cloud mode with pricing page, signup and Stripe billing ([cloud.md](cloud.md)).
- The iPhone and iPad web app ([ios-web-app.md](ios-web-app.md)).
