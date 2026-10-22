# Umzug (switch-over importers)

**Umzug** (menu *Umzug*, also *Einstellungen → Umzug* and *Agentur → Umzug*) moves an existing business over to HyperLevel: contacts with tags and custom fields and their consent, lists and segments, companies, deals with pipelines, notes, tasks, e-mail templates, products and courses, helpdesk tickets and help-center articles, conversations, **projects with tasks, wiki pages, tables as custom objects**, forms with their answers, calendars with appointments and accounting documents as history – from **Mailchimp, ActiveCampaign, Kit (ConvertKit), Kajabi, Teachable, Keap, Pipedrive, systeme.io, Klaviyo, Brevo, KlickTipp, ManyChat, Zendesk, Intercom, Salesforce, Zoho CRM, monday.com, ClickUp, Notion, Airtable, Typeform, Calendly, Lexware Office (lexoffice) and sevDesk**, either through the tool's public REST API (you paste an API key) or from the export files you download there. The wizard shows what is there, lets you map the fields, runs a dry run and then the import as a background job – resumable, idempotent and **undoable**.

Everything is per sub-account (the wizard asks for the target when you have several). The menu entry and the API use the area **Einstellungen** (member logins need it).

- [How it works](#how-it-works)
- [Sources: what moves, what does not, where to get the key](#sources)
- [Wechsel von einem anderen Tool (Anleitungen auf Deutsch)](#wechsel-von-einem-anderen-tool-anleitungen-auf-deutsch)
- [Field mapping](#field-mapping)
- [Duplicates, merging and re-runs](#duplicates-merging-and-re-runs)
- [Unsubscribed and consent](#unsubscribed-and-consent)
- [Consent ledger and reference lists](#consent-ledger-and-reference-lists)
- [Projects, pages, tables, forms, calendars and documents](#projects-pages-tables-forms-calendars-and-documents)
- [Dry run, pause, resume and undo](#dry-run-pause-resume-and-undo)
- [Export files](#export-files)
- [Data protection and security](#data-protection-and-security)
- [Set up (self-hosters)](#self-hosting)
- [REST API and MCP tools](#rest-api-and-mcp-tools)
- [For developers](#for-developers)

## How it works

1. **Source** – pick the tool you are leaving.
2. **Connect** – paste the API key (it is sealed on your server and only read during an import) *or* upload export files. The right-hand card says where to find the key; *Was nicht mitkommt* lists what the source cannot hand over.
3. **Preview** – counts per part (contacts, lists, deals …), the parts to take along (each with a note on what happens to it), warnings, the field mapping and the settings. Nothing has been written yet.
4. **Dry run** (optional but recommended) – reads the source and reports what would be created or updated. Nothing is written; it reads at most the first records of each part, so the numbers are a sample.
5. **Import** – runs in the background with a progress bar, step chips and a log. You can leave the page; a running job is shown again when you come back. **Pause** stops after the current page, **Fortsetzen** goes on at the same place.
6. **Report** – per kind: created, updated, skipped, failed – plus warnings in plain German (a segment that became a static list, a template with merge tags nobody knows, an automation that needs a second look).
7. **Undo** – one button takes a whole import back (see below). Every import and undo is in the audit log (*umzug.import.start/done/failed*, *umzug.dryrun.\**, *umzug.undo.\**).

## Sources

| Source | Through the API | From files |
| --- | --- | --- |
| Mailchimp | audiences, members (merge fields, tags, status), segments, templates, optional campaign history | audience export (CSV/ZIP), template HTML |
| ActiveCampaign | contacts with lists, tags and fields, accounts, deals with pipelines and stages, notes, automations as workflow drafts | contacts CSV, deals CSV |
| Kit (ConvertKit) | subscribers with tags and fields, forms as form drafts, sequences as workflow drafts, broadcasts as templates | subscribers CSV |
| Kajabi | contacts with tags, offers as products, products as courses, purchases as course access | contacts CSV, course structure (CSV/JSON), purchases CSV |
| Teachable | students, courses with sections and lessons (drafts), pricing plans as products, enrolments with progress | students CSV, course structure, enrolments CSV |
| Keap | contacts with tags and fields, companies, opportunities as deals, notes, tasks, products | contacts CSV, opportunities CSV |
| Pipedrive | persons with custom fields, organisations, pipelines with stages, deals, activities as tasks, notes | persons CSV, deals CSV |
| systeme.io | contacts with tags, fields and state (consent ledger), products with price plans, courses with modules and lectures (structure), course access, community members, newsletters, e-mail campaigns and automation rules as workflow drafts, funnels as a reference list | contacts CSV |
| Klaviyo | profiles with properties and e-mail/SMS consent (consent ledger), lists and segments as tags (segments also as smart lists), templates, flows as a reference list | profile export CSV |
| Brevo | contacts with attributes, list membership and blocklist state (e-mail and SMS) and double opt-in into the consent ledger, lists and segments as tags, templates | contacts CSV |
| KlickTipp | contacts with fields and tags, opt-in status and time into the consent ledger (API: active contacts; export file: everybody) | contacts CSV |
| ManyChat | tags and a reference list of flows, tags and fields through the API; contacts from the export file (opt-in columns into the consent ledger) | contacts CSV |
| Zendesk | end users as contacts, organizations as companies, tickets with every comment (customer, team, internal notes), help-center articles as knowledge-base drafts | – |
| Intercom | contacts (users and leads) with attributes, tags and company, companies, conversations with all messages as inbox history (internal notes as notes), help-center articles as knowledge-base drafts | contacts CSV |
| Salesforce | accounts as companies, contacts and leads (with your own fields), opportunities as deals with the org's stages, tasks | contacts CSV, opportunities CSV |
| Zoho CRM | accounts as companies, contacts and leads (with your own fields), deals with the pipelines and stages of the account, tasks, notes | contacts CSV, deals CSV |
| monday.com | boards as projects (groups → sections, status column → statuses, other columns → project fields), items as tasks, subitems as subtasks, updates as comments, docs as wiki pages | – |
| ClickUp | lists as projects (statuses, custom fields), tasks with subtasks, checklists, estimates, tags and comments, Docs with their pages as wiki | – |
| Notion | databases with a status property as projects with tasks (page content as description), other databases as custom objects with typed properties and relations as links, pages as a wiki tree, comments | – |
| Airtable | tables as custom objects (field types, choices, primary field), records, linked records as links | – |
| Typeform | forms as form drafts, every completed response as an answer sheet, respondents as contacts (optional) | – |
| Calendly | event types as inactive calendars (weekly and date-specific hours), scheduled events as appointments (one per invitee, cancelled ones marked), invitees as contacts | – |
| Lexware Office (lexoffice) | customers as contacts and companies; invoices, credit notes, quotations, order confirmations, delivery notes and reminders as read-only history entries on the contact | – |
| sevDesk | customers and prospects as contacts and companies; invoices, credit notes, quotations, order confirmations and delivery notes as read-only history entries on the contact | – |

All vendor traffic is plain HTTPS to the vendor's documented API host, with retries and `Retry-After` handling for rate limits. HyperLevel never follows links or hosts a response hands back, and an API key is only ever sent to its own vendor host.

### Mailchimp

- **Moves:** audiences (each becomes the tag *Liste: …*), members with merge fields (name, address, phone, birthday and your own merge fields), member tags, status; static and saved segments (tag plus a smart list – a dynamic segment becomes a static list of the current members, with a warning); templates (HTML, merge tags converted to `{{contact.…}}`); optionally the last 20 sent campaigns as a note per contact (*Kampagne erhalten / geöffnet*).
- **Does not move:** reports and statistics, automations (customer journeys are not readable through the API – rebuild them as a workflow), landing pages, forms, pop-ups and websites; images inside templates stay linked at Mailchimp – download and re-upload them before you cancel.
- **API key:** Mailchimp → profile → *Extras* → *API keys* → *Create A Key*. Paste it **with** the part after the dash (`…-us12`). Read access is enough; delete the key afterwards.

### ActiveCampaign

- **Moves:** contacts (lists become the tags *Liste: …*, tags, custom fields), accounts as companies, deals with pipelines and stages, notes, and – optional – automations as **workflow drafts** marked *bitte prüfen*: common triggers and actions are translated, the rest becomes a note holding the original.
- **Does not move:** campaign content and statistics, forms, landing pages, site tracking, custom deal fields and deal tasks, scoring rules and condition-based segments; automations only as drafts (branches, goals and conditions are yours to rebuild).
- **API key:** ActiveCampaign → *Einstellungen* → *Entwickler* → *API-Zugriff*: the API URL (`https://<account>.api-us1.com`) and the key. Only hosts of the form `*.api-us*.com` / `*.activehosted.com` are accepted.

### Kit (ConvertKit)

- **Moves:** subscribers (tags, custom fields; unsubscribed, bounced and complained become *Nicht stören* plus a tag), forms as form drafts (name and standard fields), broadcasts as e-mail templates (with the HTML of the sent broadcast), and – optional – sequences as workflow drafts.
- **Does not move:** the e-mails *inside* sequences (the API does not provide them – the draft says so), landing pages, form design, commerce products, visual automations, condition-based segments.
- **API key:** Kit → *Settings* → *Developer* → *API Keys* → *Add a new API Key* (a **v4** key, not the old *API Secret*).

### Kajabi

- **Moves:** contacts with tags (unsubscribed ones get *Nicht stören*), offers as products, products as courses (without lessons), purchases as course access.
- **Does not move:** lessons, videos and files (the API does not provide them – use the *course structure* file), community, podcasts, coaching products, pages, funnels and e-mail sequences. Running subscriptions stay with the payment provider; new payments have to be set up in HyperLevel.
- **API access:** Kajabi → *Einstellungen* → *API* / *Entwickler* → create an API key (client ID and client secret). Not every Kajabi plan includes it – use the export files then (contacts, purchases, course structure).

### Teachable

- **Moves:** students as contacts, courses with sections and lessons (as drafts; text and video links as far as the API delivers them), pricing plans as products, enrolments with progress (the API gives a percentage – the first lessons are marked done as an approximation).
- **Does not move:** video files (they stay at Teachable; links and hints are taken over), quizzes, certificates, comments, course design and pages, payments and running subscriptions.
- **API key:** Teachable → *Einstellungen* → *Public API* (Pro plan or higher). Optionally enter the school's address so the id mapping survives a key change.

### Keap

- **Moves:** contacts with tags and custom fields (e-mail status *Unsubscribed*, *NonMarketable* and *Bounced* → *Nicht stören* plus a tag), companies, opportunities as deals, notes, tasks, products.
- **Does not move:** the Campaign Builder (not readable through the REST API – rebuild it as a workflow), invoices, orders and subscriptions, forms and landing pages. Pipeline stages come from the configuration and the opportunities that exist.
- **API key:** Keap → *Einstellungen* → *Keap Developer* / *API* → create a **Service Account Key** (read access is enough). An OAuth access token works too.

### Pipedrive

- **Moves:** persons with custom fields (labels become tags; *unsubscribed* marketing status → *Nicht stören*), organisations as companies, pipelines with stages, deals, activities as tasks (the kind – call, meeting … – goes in front of the title), notes.
- **Does not move:** e-mails (mail sync) and attachments, automations, the leads inbox and projects, custom deal fields and products.
- **API token:** Pipedrive → profile → *Persönliche Einstellungen* → *API*. The token sees what you see – use an admin's. If the account has its own domain, enter the part before `.pipedrive.com`.

### systeme.io

- **Moves:** contacts with tags, custom fields and state (unsubscribed, bounced and not yet confirmed become *Nicht stören* plus a tag; the consent ledger gets one line per person, see [Consent ledger and reference lists](#consent-ledger-and-reference-lists)), digital products with their price plans as products (monthly and yearly directly, other intervals, trials and limited subscriptions as warnings), courses with modules and lectures as drafts (structure only), course access and community memberships (tag *Community: …*), newsletters as templates (merge tags `{{contact.first_name}}` converted), e-mail campaigns (with delays) and automation rules as **workflow drafts** marked *bitte prüfen*, and the funnels with their steps and addresses as a wiki page.
- **Does not move:** funnel pages and their design (the API only names funnels, steps and URLs), the content of lectures (videos, texts, files), orders, invoices and running subscriptions, coupons, booking calendars, SMS templates, and newsletters built in the visual editor (no HTML from the API – the template stays empty and says so).
- **API key:** systeme.io → profile picture → *Settings* → *MCP & API keys* → *Create* (up to three keys per account). Read access only is ever used; delete the key afterwards.

### Klaviyo

- **Moves:** profiles with their custom properties (address, company, title, phone and every property in use), e-mail and SMS consent into the consent ledger – a **double opt-in or an explicit form/checkout consent** becomes a dated *confirmed* line with the method, an API or import consent a *legacy* line, *unsubscribed* and every suppression (spam complaint, hard bounce, manual) a *revoked* line plus *Nicht stören* and a tag, and **never subscribed** (customers who only get transactional mail) a *declined* line so they are not mailed as a newsletter audience; lists as tags *Liste: …*, segments as tags and smart lists (a segment is a rule in Klaviyo – here it is the fixed list of its current members, with a warning), templates (Klaviyo tags like `{{ first_name }}` and `{% unsubscribe %}` converted), and the flows as a reference list in the wiki (name, status, trigger, scope, order of steps).
- **Does not move:** the steps, texts and conditions of flows (the API does not return them in a form a workflow can be built from), events and metrics (purchases, clicks, opens), predictive analytics, forms, pop-ups, campaigns and reports, the product catalog and shop integrations.
- **API key:** Klaviyo → *Settings* → *API keys* → *Create Private API Key* (custom key, read access to accounts, profiles, lists, segments, flows and templates). The key starts with `pk_`; the six-character public key does not work. Requests carry a fixed dated `revision`; Klaviyo's rate limits (`429` with `Retry-After`) are honoured.

### Brevo

- **Moves:** contacts with their attributes (the default ones, your own, and category attributes with their labels instead of numbers; calculated and transactional attributes are skipped), list membership as tags *Liste: …* (a list a person unsubscribed from becomes *Abgemeldet von Liste: …*), the **blocklist** (e-mail → *Nicht stören*, tag and a *revoked* ledger line; SMS blocklist → a *revoked* SMS line only), a confirmed **double opt-in** (attribute `DOUBLE_OPT-IN`) as a dated *confirmed* line and everybody else as *legacy*, segments as tags and smart lists (a segment is a rule at Brevo – here the fixed list of its current members), and SMTP templates (tags like `{{ contact.FIRSTNAME }}` and `{{ unsubscribe }}` converted).
- **Does not move:** sent campaigns and their statistics, automations (workflows) and transactional mails, sign-up forms and landing pages, Brevo's own CRM data (deals, tasks) and chat. The API does not tell why someone is on the blocklist (unsubscribed, bounced, set by hand) – all of them become *Nicht stören*.
- **API key:** Brevo → your name (top right) → *SMTP & API* → *API keys* → *Generate a new API key*; the key starts with `xkeysib-`. Rate limits (`429`, `Retry-After` or `x-sib-ratelimit-reset`) are honoured. The account is identified by a hash of the account e-mail – the address itself is not stored in the id map.

### KlickTipp

- **Moves:** contacts with the standard fields (name, company, address, phones, website, birthday) and your own fields (dates – Unix seconds in KlickTipp – are recognised by value and name), the tags and who carries them, and the opt-in status: a subscriber with an **opt-in time** becomes a dated *confirmed* line in the consent ledger, a subscriber without one a *legacy* line, *Unsubscribed* and hard bounces *revoked* plus *Nicht stören*; *Pending* (double opt-in not clicked yet) writes no line and stays on *Nicht stören*.
- **Does not move:** subscribers who unsubscribed (the API lists the active ones only – use the CSV export for them: the *Status* column decides), smart tags (they are computed from rules), e-mail texts, newsletters and campaigns, the campaign builder (rebuild it as a workflow), sign-up processes, forms and landing pages, statistics. KlickTipp gives no field types: decimal fields arrive as an integer times 100.
- **Access:** the REST API belongs to the plans *Premium* and up. HyperLevel logs in with the user name and password of a KlickTipp user (best: a user created only for the move, whose password you change afterwards); the password is sealed like every secret, never shown again and not part of the "key …1234" hint, the session cookie stays in memory. Contacts are read in batches of 200 through the bulk call; an account without it is read one subscriber at a time.

### ManyChat

- **Moves:** the tags of the account (created before the contacts arrive) and a **reference list** in the wiki: flows with their folders, tags, custom fields with type and description, and the names (never the values – they often hold keys) of bot fields. **Contacts come from the export file**: the ManyChat API cannot list subscribers, only look one up. The file's columns become fields and tags; a column *Opt-in E-Mail* / *Opt-in Telefon* (yes/no) is the person's explicit answer and goes into the consent ledger – yes as *confirmed*, no as *declined* (so they are never mailed as an audience), no column as *legacy*; *Subscribed* = no becomes *Nicht stören*.
- **Does not move:** the content of flows (messages, conditions, buttons), conversation history and live-chat messages, broadcast statistics, channel connections (Instagram, WhatsApp, Messenger, Telegram – connect them again in HyperLevel) and templates. A contact's channel ids (such as the Instagram id) only work inside ManyChat.
- **API key:** ManyChat → *Settings* → *API* → *Generate Your API Key* (Pro plan), in the form `<page id>:<token>`. Only reads.

### Zendesk

- **Moves:** end users as contacts (name, e-mail, phone, tags, notes, your own user fields) linked to their organizations, organizations as companies, **tickets with every comment** – status and priority mapped by meaning (*pending* and *on hold* → waiting, *solved* → resolved), tags, the requester as contact (created from the ticket when the person is not in the user list), customer messages, public team replies and **internal notes** with their original time and author; a first note says where the ticket came from, who handled it and on which channel – and help-center articles as knowledge-base **drafts** in categories named after Zendesk category and section (HTML converted to Markdown).
- **Imported tickets** get no SLA timers, send no mail and start no workflow; a comment that is there already (a re-run) is not added twice. **Undo** deletes the tickets the import created together with their timeline – except a ticket somebody has answered in since.
- **Does not move:** attachments and images (the files stay at Zendesk; names stand in the ticket, articles still link there – download them first), macros, triggers, automations, views, SLA policies and reports (rebuild them as canned responses, workflows and SLAs), agents and groups (the assignee is noted in the ticket), satisfaction ratings, Talk calls and chat transcripts outside tickets, article translations.
- **Consent:** Zendesk knows no marketing consent, so people come in with a *declined* ledger line ("keine Werbeeinwilligung"): service mails and ticket replies work, newsletters and advertising workflows skip them until they opt in.
- **API token:** Zendesk Admin Center → *Apps and integrations* → *APIs* → *Zendesk API* → enable *Token access* → *Add API token*; enter the subdomain, the admin's e-mail and the token. Zendesk allows 200–700 requests per minute depending on the plan (`429` with `Retry-After` is honoured); every ticket's comments are one call each, so a big helpdesk takes a while – the dry run reads only the first tickets' comments.

### Intercom

- **Moves:** contacts – users and leads – with name, e-mail, phone, location, your custom attributes (the data-type is respected), tags and their company (leads get the tag *Intercom: Lead*), companies, **conversations** with every comment as history in the contact's inbox thread (customer messages as *received*, replies of the team and bots as *sent*, original time, subject for e-mails; a re-run skips what is there) – nothing is sent and nothing becomes unread; internal notes become notes on the contact – and help-center articles as knowledge-base **drafts** (collections and sub-collections become categories "Start › Konto"). Unsubscribed, hard-bounced and spam-marked contacts get *Nicht stören*, a tag and a *revoked* ledger line; everybody Intercom could still mail comes in as *legacy* (no proof of its own).
- **Does not move:** attachments and images (they stay at Intercom), segments, campaigns, series, tours, bots and workflows, notes written directly on a contact (only notes from conversations come along), events and app activity, tickets and SLAs (conversations are history, not tickets), article translations.
- **Access:** Intercom → *Settings* → *Integrations* → *Developer Hub* → new internal app → *Authentication* → access token with read rights for contacts, companies, conversations, tags and the help center. A workspace in the EU or Australia needs the region (`eu`, `au`) – only these three hosts (`api.intercom.io`, `api.eu.intercom.io`, `api.au.intercom.io`) are ever called. `429` is answered by waiting until `X-RateLimit-Reset`; the version header is pinned to 2.11. Each conversation's messages are one call each, the dry run reads only the first conversations.

### Salesforce

- **Moves:** accounts as companies (billing address, website, industry), contacts and leads with the standard fields and **every custom field of the org** (type-aware: numbers, dates, picklists), linked to their company; leads get the tag *Salesforce: Lead* and *Lead-Status: …* (converted leads are skipped – they exist as contacts); opportunities as **deals in one pipeline** whose stages come from the org's stage setup in its order with their default probability (a stage only deals still use is added at the end), *Closed Won* / *Closed Lost* → won / lost, the **primary contact role** as the deal's contact (without a role: the oldest contact of the account; without either the deal is counted as "Deals ohne Kontakt"), currency in multi-currency orgs; tasks for contacts, leads and deals.
- **Consent:** Salesforce has an e-mail opt-out flag but no opt-in. Opted-out contacts get *Nicht stören*, a tag and a *revoked* ledger line; **everybody else gets a *declined* line** ("no advertising consent carried over") – service mails and replies work, newsletters and advertising workflows wait for a new opt-in. *Do Not Call* becomes the tag *Salesforce: Nicht anrufen*.
- **Does not move:** reports, dashboards, flows, Apex and approval processes, e-mails and files, notes as ContentNote and the activity history except tasks, products, price books, quotes and contracts, several sales processes (everything lands in one pipeline), campaigns and members, cases, permissions and teams.
- **Access:** the My Domain address of the org (`https://<name>.my.salesforce.com`; only Salesforce hosts are accepted, a Lightning address is converted) and either the **client id and secret** of an app with the *client credentials flow* and a run-as user with read access (robust: HyperLevel fetches and renews the token itself) or an **access token** (for a few hours – paste a new one and use *Fortsetzen* when it expires). Records are read in blocks of 500 ordered by `Id` (`WHERE Id > …`), so a pause or restart continues exactly there; no link from a response is ever followed. The daily API limit of the org counts about one call per 500 records; when it is reached the job stops with a clear message and goes on after the next reset.

### Zoho CRM

- **Moves:** accounts as companies, contacts and leads with the standard fields and **your own fields** (lookups and formulas are skipped; the API takes at most 50 fields per call), linked to their company, leads tagged *Zoho: Lead* and *Lead-Status: …* (converted leads skipped); deals in **pipelines with their stages in the account's order** (a pipeline or stage only deals still use is added), won / lost taken from the stage kind (*Closed Won* / *Closed Lost*), contact and company of the deal; tasks; notes on contacts, leads and deals.
- **Consent:** like Salesforce – Zoho has an e-mail opt-out but no opt-in: opted-out contacts become *Nicht stören* with a *revoked* line, everybody else gets a *declined* line ("no advertising consent carried over").
- **Does not move:** reports, dashboards, workflow rules, blueprints and macros, e-mails, attachments and files, notes on accounts, products, quotes, orders and invoices, campaigns.
- **Access:** a *Self Client* in the Zoho API console of your region: enter region (`com`, `eu`, `in`, `com.au`, `jp`, `ca`, `sa`, `cn` – only these eight are accepted), client id, client secret and a freshly generated **code** (scope `ZohoCRM.modules.READ,ZohoCRM.settings.READ`, valid ten minutes). HyperLevel exchanges the code at once for a **refresh token** and stores that – sealed – instead of the code; access tokens are renewed by itself (about every hour). Pages by `page_token`; withdraw the access in Zoho under connected apps afterwards.

### monday.com

- **Moves:** boards (not archived ones, sub-item boards or doc boards) as **projects**: groups become sections, the board's first status column the project's statuses (with their colours; a label marked "done" in monday is a done status), a status column called *Priority* the task priority, the timeline or a date column the dates, long text called *Description* the description, every other column (text, numbers, dates, choices, links, checkboxes – up to 30) a project field; items as **tasks** with the creation time of the item, **subitems as subtasks**, **updates and replies as comments** (author and time kept, nobody is notified); people columns are matched to team members by e-mail, everybody else is named in the description; **docs** as wiki pages in the space *monday.com* (headings, lists, check lists, quotes, code, tables and links converted to Markdown).
- **Does not move:** files and pictures (picture links in docs still point at monday), automations, integrations, dashboards, views, forms, time tracking, votes, dependencies and board relations (those columns come as text), archived boards and deleted items.
- **API token:** monday.com → profile picture → *Developers* → *My access tokens*. Only reads. monday limits the query complexity per minute and the calls per day: the answer comes with HTTP 200 and an error body, which HyperLevel treats like a `429` (waits the seconds monday names, then goes on); the daily limit stops the job with a clear message and it continues the next day. The API version is pinned (`2025-10`).

### ClickUp

- **Moves:** every list (archived ones not) as a **project** – the list's statuses become the project's statuses (*open* → to do, *custom* → active, *done* and *closed* → done), its custom fields (text, number, date, drop-down, checkbox, URL, labels, rating – up to 30) project fields; **tasks** with description (Markdown), priority, start and due date, tags, estimate, checklists (nested items flattened), assignees (matched to team members by e-mail), the creation and completion time; **subtasks** (parents are written first, whatever the order of the API); optional **comments** (a call per task); **Docs** with their pages as wiki pages (one page becomes one wiki page, several become a parent page with children).
- **Does not move:** attachments, automations, views, dashboards, goals, forms, time entries, dependencies and linked tasks, sprints and points, archived items.
- **API token:** ClickUp → avatar → *Settings* → *Apps* → *API Token* (`pk_…`); an optional workspace id limits the move to one workspace. ClickUp allows 100 requests a minute on most plans – calls are paced and a `429` waits until `X-RateLimit-Reset`.

### Notion

- **Moves:** databases **with a status property** as projects (status groups *To-do / In progress / Complete* decide the category), their rows as tasks – **the page content becomes the description** (headings, lists, to-dos, toggles, quotes, callouts, code, tables, links), due and start date, people (matched to team members), a *Priority* select, a tags multi-select, further properties as project fields; **all other databases as custom objects** with typed properties (select and multi-select keep their options, a value the schema lacks becomes an option) and **relations as links** between the records; **pages that are no database rows as wiki pages** with their hierarchy (the parent comes first; a page whose parent was not shared becomes a top-level page); optional comments of the tasks.
- **Does not move:** only what you share with the integration is visible (Notion's rule); files and images (the addresses expire after an hour), views, filters, formulas and rollups (the current value comes), templates, automations, linked database views, databases with several data sources (skipped with a note), times and end dates of date properties in custom objects.
- **Token:** notion.so/profile/integrations → new internal integration → token (`ntn_…`/`secret_…`); share the pages and databases with it (page → *…* → *Connections*). Three requests a second on average – `429` waits for `Retry-After`. Pinned to API version `2022-06-28`.

### Airtable

- **Moves:** every table of the bases the token sees (or the one base named by its id) as a **custom object**: the primary field becomes the display property *Name*, field types are kept (text, long text, e-mail, URL, phone, number, currency, percent as a number, date, date and time, checkbox, single and multiple select with their choices – a value the table has but the definition lacks becomes a choice), formulas, rollups and lookups as their current value, collaborators and attachment names as text; **records** with their creation time; **linked records as links** between the records (each pair once).
- **Does not move:** attachments themselves (the addresses expire after two hours – only the file names come), views, filters, interfaces, automations, forms, comments, buttons and syncs, formulas as formulas; at most 50 custom objects per sub-account.
- **Token:** airtable.com/create/tokens → scopes `data.records:read` and `schema.bases:read`, the bases under *Access*. Five requests a second per base; after a `429` Airtable locks the base for 30 seconds, so the first retry waits that long.

### Typeform

- **Moves:** forms as **form drafts** named "… (aus Typeform, bitte prüfen)" (question text with recall pieces and markup removed, type, required, choices; groups opened; a consent checkbox is added at the end); **every completed response as an answer sheet** in the form's submissions, with its time and the questions as columns (no mail, no notification, no workflow) – a respondent who is a contact already is linked to it; optional: **respondents with an e-mail address as contacts**, marked "no advertising consent" in the consent ledger; a later run links the answers of contacts that have come to exist since.
- **Does not move:** logic jumps, themes, welcome and thank-you screens, calculations, file uploads (the link to the file at Typeform stands in the answer), payments, incomplete responses, webhooks and integrations; the newest answers (about 30 minutes) are delivered by Typeform later.
- **Token:** Typeform → account → *Personal tokens* with *Forms: Read* and *Responses: Read*; a US/EU data center choice (`eu` for `api.eu.typeform.com`). Two requests a second.

### Calendly

- **Moves:** the event types of the token's owner as **calendars – inactive, without confirmation mail and without reminders** (so no public booking page opens and nobody is mailed by accident): duration, description, colour, location, the weekly hours and the date-specific hours (future days) of the event type, else the host's default schedule; **scheduled events as appointments** – one per invitee, past and upcoming, cancelled ones marked, the answers to the booking questions, location, guests and cancellation reason in the notes; an event whose event type was deleted gets a stand-in calendar; optional **invitees as contacts** (marked "no advertising consent"; an existing contact with the same e-mail is used).
- **Does not move:** other team members' events (repeat with their token), routing forms, workflows and mail texts, polls, payments, calendar connections, the booking page design.
- **Token:** Calendly → *Integrations* → *API & Webhooks* → personal access token. Pages by `page_token`. **Activate** the calendars after checking hours and texts, then switch your Calendly links over.

### Lexware Office (lexoffice)

- **Moves:** customers (not vendors, not archived ones) as **contacts and companies** – a company becomes a company with its main contact person as the contact the documents are filed under (more persons as more contacts, a company without persons as a contact named like the company), customer number, tax number and VAT id as fields, billing address, e-mail and phone; **documents** – invoices, credit notes, quotations, order confirmations, delivery notes, down-payment invoices and reminders, not drafts – as **read-only entries in the contact's history**: number, date, amount, status, due date.
- **Important – documents are history, not invoices.** An imported document takes **no number from HyperLevel's invoice ranges**, is not frozen, archived or sent and changes no bookkeeping; the original with its PDF stays at Lexware. Invoices and records must be kept 8 or 10 years: export them (PDFs, DATEV export) before you cancel. HyperLevel's bookkeeping is *Buchhaltung light* (preparation for the tax advisor), not certified accounting software.
- **Does not move:** vouchers of vendors, bookings, payments, accounts, VAT returns, cash book, articles, templates, recurring invoices, line items and PDFs.
- **API key:** app.lexware.de/addons/public-api (the public API is part of the top plan). Two requests a second, 25 entries per page; host `api.lexware.io`.

### sevDesk

- **Moves:** customers and prospects (suppliers excluded) as **contacts and companies** – an organisation becomes a company and a contact of its own, its persons contacts linked to it; prospects get the tag *Interessent*; main e-mail and phone, address, customer number, tax number and VAT id; **documents** – invoices (types: invoice, cancellation, reminder, partial, advance and final invoice), credit notes, quotations, order confirmations and delivery notes, not drafts – as **read-only entries in the contact's history** with number, date, amount, status and due date (same rules as for Lexware: no HyperLevel invoice, no number, nothing frozen).
- **Does not move:** vouchers of suppliers, bookings, bank accounts and transactions, VAT, cash book, products, templates, recurring invoices, tags, line items and PDFs, drafts.
- **API token:** sevDesk → *Einstellungen* → *Benutzer* → your user → API token (administrators; the API belongs to the top plan). The account is named by sevDesk's client id, not by the token, so a new token does not duplicate anything.

## Wechsel von einem anderen Tool (Anleitungen auf Deutsch)

So läuft ein Wechsel ab, egal von wo: **1.** Schlüssel im alten Tool anlegen (Lesezugriff genügt), **2.** in HyperLevel unter *Einstellungen → Umzug* die Quelle wählen und den Schlüssel einfügen, **3.** Vorschau ansehen und einen **Probelauf** machen – dabei wird nichts geschrieben, **4.** importieren und den Bericht lesen. Alles lässt sich mit einem Knopf **rückgängig** machen, ein zweiter Lauf legt nichts doppelt an, und das alte Konto bleibt unberührt, bis du es selbst kündigst. Exportiere vor der Kündigung zur Sicherheit, was HyperLevel nicht übernimmt (die Listen unten sagen genau, was das ist).

Zur **Einwilligung**: Wer sich im alten Tool abgemeldet hat oder gesperrt ist, bekommt „Nicht stören“ und einen Widerrufs-Eintrag im Einwilligungs-Nachweis. Wer dort nur „angemeldet“ war, kommt als **Altbestand** hinein – mit dem Hinweis, woher er stammt; ein dokumentiertes Opt-in mit Datum (z. B. bestätigtes Double-Opt-in) kommt als **bestätigt**. Ob Altbestand Werbung bekommt, entscheidest du unter *Einwilligung & Recht → Versandregel* (Empfehlung: nach dem Umzug auf „Nur bestätigt“ stellen, sobald deine Listen sauber sind). Das ist keine Rechtsberatung.

### Wechsel von systeme.io

**Das kommt mit:** Kontakte mit Tags, eigenen Feldern und Status (abgemeldet, unzustellbar, unbestätigt) · digitale Produkte mit Preisplänen · Kurse mit Modulen und Lektionen (als Entwurf) · Kurs-Zugänge und Community-Mitgliedschaften (als Tag) · Newsletter als E-Mail-Vorlagen · E-Mail-Folgen und Automatisierungs-Regeln als Workflow-Entwürfe „bitte prüfen“ · deine Funnels mit Schritten und Adressen als Referenzliste im Wiki.

**Das kommt nicht mit:** die Funnel-Seiten selbst und ihr Design (die Schnittstelle nennt nur Namen, Schritte und Adressen) · die Inhalte der Lektionen (Videos, Texte, Dateien – die Schnittstelle liefert nur den Aufbau, in jeder Lektion steht ein Hinweis) · Bestellungen, Rechnungen und laufende Abos (bleiben beim Zahlungsanbieter) · Gutscheine, Buchungskalender, SMS-Vorlagen · im visuellen Editor gebaute Newsletter ohne HTML.

**So gehst du vor:** In systeme.io Profilbild → *Einstellungen* → *MCP & API-Schlüssel* → *Erstellen*. Schlüssel in HyperLevel einfügen, Vorschau und Probelauf, importieren. Danach die Funnels anhand der Referenzliste nachbauen (die Seiten-Vorlagen in HyperLevel helfen), Domains umziehen und erst dann kündigen.

**Warum wechseln?** Bei systeme.io hängt vieles am Tarif: laut Preisseite (Stand Oktober 2026) bietet *Free* 2.000 Kontakte, 3 Funnels und 1 Kurs, *Startup* (17 $) 5.000 Kontakte und 5 Kurse, *Webinar* (47 $) 10.000 Kontakte, unbegrenzte Kontakte und Sub-Accounts gibt es erst im 97-$-Tarif. HyperLevel kennt **keine Kontakt-Stufen**: selbst gehostet 0 € mit allen Funktionen, in der Cloud 49,99 €/Monat für eine Person oder 99,99 €/Monat pro Firma mit beliebig vielen Nutzern – nichts ist gesperrt, nichts wird pro Platz berechnet. Dazu kommt, was systeme.io nicht bietet: Gespräche in beide Richtungen (Postfach, WhatsApp, Instagram), ein vollständiges CRM mit Pipelines, KI-Assistenten, Helpdesk, Team-Werkzeuge, Rechnungen und Buchhaltung – und der Quellcode ist offen, der Export jederzeit möglich.

### Wechsel von Klaviyo

**Das kommt mit:** Profile mit allen Eigenschaften, Adresse und Firma · die Einwilligung für **E-Mail und SMS** mit Datum und Art (Double-Opt-in und Formular-Einwilligungen als *bestätigt*, API-/Import-Einwilligungen als Altbestand, Abmeldungen und Sperren als Widerruf) · „nie angemeldet“ (Kunden, die nur Transaktionsmails bekamen) wird so markiert, dass sie **keine Werbung** bekommen · Listen und Segmente als Tags (Segmente auch als Smart List, mit der festen Mitgliederliste von heute) · E-Mail-Vorlagen mit umgewandelten Platzhaltern · die Flows als Referenzliste im Wiki (Name, Status, Auslöser, Ablauf).

**Das kommt nicht mit:** die Schritte, Texte und Bedingungen der Flows (nachbauen) · Ereignisse und Metriken (Käufe, Klicks, Öffnungen), Vorhersagen · Formulare, Pop-ups, Kampagnen und Berichte · Produktkatalog und Shop-Anbindungen.

**So gehst du vor:** In Klaviyo *Settings* → *API keys* → *Create Private API Key* (Lesezugriff auf Accounts, Profiles, Lists, Segments, Flows, Templates). Der Schlüssel beginnt mit `pk_`. Danach die aktiven Flows als Workflows nachbauen, Shop-Anbindung neu einrichten, Formulare/Pop-ups durch HyperLevel-Formulare ersetzen.

**Warum wechseln?** Klaviyo rechnet nach **aktiven Profilen** ab: der kostenlose Tarif endet bei 250 Profilen und 500 E-Mails im Monat, danach wächst die Rechnung mit jeder Adresse (laut Preisseite, Stand Oktober 2026). Wer eine wachsende Liste hat, bezahlt für Wachstum. HyperLevel berechnet keine Kontakte: selbst gehostet 0 €, Cloud ab 49,99 €/Monat mit allen Funktionen – und zusätzlich CRM, Postfach, Helpdesk und Buchhaltung unter einem Dach statt in fünf Abos.

### Wechsel von Brevo

**Das kommt mit:** Kontakte mit allen Attributen (Auswahl-Attribute mit ihren Bezeichnungen) · Listen als Tags (wer sich von einer Liste abgemeldet hat, bekommt das Tag „Abgemeldet von Liste: …“) · die **Sperrliste** (E-Mail wie SMS) als „Nicht stören“ bzw. Widerruf · ein bestätigtes Double-Opt-in (Attribut DOUBLE_OPT-IN) als bestätigte Einwilligung · Segmente als Tags und Smart Lists · E-Mail-Vorlagen mit umgewandelten Platzhaltern.

**Das kommt nicht mit:** gesendete Kampagnen und Berichte · Automationen (Workflows) und Transaktionsmails · Anmeldeformulare und Landing Pages · Brevos eigenes CRM und Chat. Warum jemand gesperrt ist (abgemeldet, unzustellbar, von Hand), unterscheidet die Schnittstelle nicht – alle werden „Nicht stören“.

**So gehst du vor:** In Brevo *SMTP & API* → *API-Schlüssel* → *Neuen API-Schlüssel erstellen* (beginnt mit `xkeysib-`). Vorschau, Probelauf, Import; danach Automationen als Workflows nachbauen und den Versand (Absender-Domain, SPF/DKIM) in HyperLevel einrichten – der Zustellbarkeits-Assistent unter *Umzug* hilft dabei.

**Warum wechseln?** Bei Brevo richtet sich der Preis nach dem **monatlichen E-Mail-Volumen**, das kostenlose Konto hat ein Tageslimit, und Funktionen wie Automationen und Auswertungen hängen am Tarif (aktuelle Zahlen auf der Preisseite des Anbieters). HyperLevel zählt weder Kontakte noch E-Mails: ein Preis, alle Funktionen, kein Platz-Aufschlag – selbst gehostet 0 €.

### Wechsel von KlickTipp

**Das kommt mit:** Kontakte mit Standard- und eigenen Feldern (Datumsfelder werden erkannt) · Tags und wer sie trägt · der Opt-in-Status: bestätigtes Opt-in mit Zeitpunkt als *bestätigt*, sonst Altbestand, Abmeldungen und Hard-Bounces als Widerruf, „Ausstehend“ bleibt auf „Nicht stören“, bis die Person bestätigt.

**Das kommt nicht mit:** Abgemeldete (die Schnittstelle liefert nur aktive – nimm zusätzlich den CSV-Export, der Status steht darin) · Smart-Tags · E-Mail-Texte, Newsletter, Kampagnen und der Kampagnen-Builder (als Workflow neu bauen) · Anmeldeprozesse, Formulare, Landingpages · Statistiken. Dezimalfelder kommen als ganze Zahl mal 100.

**So gehst du vor:** Die Schnittstelle gibt es ab dem Tarif *Premium*. Lege in KlickTipp einen eigenen Benutzer für den Umzug an, trage Benutzername und Passwort in HyperLevel ein (das Passwort wird verschlüsselt gespeichert) und ändere es danach. Zusätzlich die Kontakte als CSV exportieren und bei *Export-Datei hochladen* ergänzen. Sichere vor der Kündigung die Opt-in-Nachweise, die KlickTipp zu deinen Kontakten führt (Anmeldeprozess, Zeitpunkt, IP): HyperLevel übernimmt Status und Zeitpunkt, den vollständigen Beleg hast nur du.

**Warum wechseln?** KlickTipp staffelt nach Kontakten (laut Preisseite, Stand Oktober 2026: *Standard* 30 €/Monat bis 2.500 Kontakte, *Premium* 50 €, *Deluxe* 70 €, *Enterprise* ab 170 €), begrenzt automatisierte Kampagnen (3 / 6 / 10 je Tarif), erlaubt in den ersten drei Tarifen **einen** Nutzer und hat die Schnittstelle erst ab Premium. HyperLevel: keine Kontakt-Stufen, keine Begrenzung der Automationen, beliebig viele Nutzer ab 99,99 €/Monat pro Firma (Cloud) oder 0 € selbst gehostet – dann auf einem Server deiner Wahl, etwa in Deutschland. Einwilligungs-Nachweis, Double-Opt-in und Rechtstexte für DACH sind eingebaut.

### Wechsel von ManyChat

**Das kommt mit:** die Kontakte aus der **Export-Datei** (Name, E-Mail, Telefon, Tags, eigene Felder) – die Schnittstelle von ManyChat kann Kontakte nicht auflisten, deshalb der Umweg über die Datei · aus den Opt-in-Spalten wird die **Einwilligung** (Ja = bestätigt, Nein = keine Werbung, keine Spalte = Altbestand) · über den Schlüssel: die Tags des Kontos und eine **Referenzliste** im Wiki mit Flows (samt Ordnern), Tags, eigenen Feldern und den Namen der Bot-Felder (ohne Werte).

**Das kommt nicht mit:** der Inhalt der Flows (Nachrichten, Bedingungen, Schaltflächen) · Gesprächsverläufe und Live-Chat · Broadcast-Statistiken · die Verbindungen zu Instagram, WhatsApp, Messenger und Telegram (richtest du in HyperLevel neu ein) · die Kanal-Kennungen der Kontakte, sie gelten nur bei ManyChat.

**So gehst du vor:** Kontakte in ManyChat exportieren (CSV) und bei *Umzug → ManyChat → Export-Datei hochladen* importieren. Danach – für die Referenzliste – *Settings → API → Generate Your API Key* und den Schlüssel eintragen. Die wichtigsten Flows aus der Liste in HyperLevel als Workflows nachbauen, die Kanäle neu verbinden (WhatsApp, Instagram, Messenger), dann kündigen.

**Warum wechseln?** ManyChat rechnet nach **aktiven Kontakten** ab, bei Überschreitung kostet jeder weitere Kontakt extra – und der kostenlose Tarif wurde laut Berichten 2026 stark gekürzt (aktuelle Zahlen bitte auf der Preisseite prüfen). Gespräche bleiben dabei in einer Chat-Blase auf wenigen Kanälen. HyperLevel zählt keine Kontakte: selbst gehostet 0 €, Cloud 49,99 €/Monat (eine Person) oder 99,99 €/Monat pro Firma mit beliebig vielen Nutzern – und die Gespräche landen im gemeinsamen Postfach neben E-Mail, SMS, WhatsApp und Instagram, mit CRM, Terminen und Rechnungen dahinter.

### Wechsel von Zendesk

**Das kommt mit:** Kunden als Kontakte (mit Organisation, Tags, Notizen und eigenen Nutzerfeldern) · Organisationen als Firmen · **Tickets mit allen Kommentaren** – Kundennachrichten, Antworten des Teams und interne Notizen mit Zeitpunkt und Absender, Status und Priorität sinngemäß übersetzt, Tags, Kontakt · eine Notiz am Anfang jedes Tickets (aus Zendesk, Bearbeiter dort, Kanal) · die Hilfe-Center-Artikel als **Entwurf** in der Wissensdatenbank.

**Das kommt nicht mit:** Anhänge und Bilder (die Dateien bleiben bei Zendesk – im Ticket stehen die Dateinamen, Artikel verlinken noch dorthin: vor dem Kündigen herunterladen) · Makros, Trigger, Automationen, Ansichten, SLA-Richtlinien und Berichte (in HyperLevel als Textbausteine, Workflows und SLAs neu bauen) · Agenten und Gruppen (Teammitglieder legst du selbst an; der Bearbeiter steht als Notiz im Ticket) · Zufriedenheitsbewertungen, Talk-Anrufe, Chat-Protokolle · Übersetzungen von Artikeln.

**Wichtig:** Zendesk kennt keine Werbeeinwilligung. Die Kunden kommen deshalb mit „keine Werbeeinwilligung“ im Nachweis herein: Ticket-Antworten und Service-Nachrichten funktionieren, Newsletter und Werbe-Workflows überspringen sie, bis jemand eingewilligt hat.

**So gehst du vor:** Im Zendesk Admin-Center *Apps und Integrationen → APIs → Zendesk-API → Token-Zugriff aktivieren → API-Token hinzufügen*. Subdomain, Admin-E-Mail und Token eintragen, Vorschau, Probelauf, Import. Danach E-Mail-Weiterleitung (Support-Adresse → Ticket), Textbausteine und SLAs in *Einstellungen → Service* einrichten, Artikel prüfen und veröffentlichen, dann erst kündigen. Bei vielen Tickets braucht der Import Zeit (Zendesk begrenzt die Anfragen pro Minute) – er läuft im Hintergrund, lässt sich pausieren und macht dort weiter, wo er war.

**Warum wechseln?** Zendesk berechnet **pro Agent und Monat** – laut Preisseite (Stand Oktober 2026) 19 $ im Tarif *Support Team* bei jährlicher Zahlung (25 $ monatlich), 55 $ für die *Suite Team* und 115 $ für die *Suite Professional* – dazu automatisierte Lösungen der KI ab 1,50 $ das Stück und Zusatzpakete wie Copilot (50 $ pro Agent). Jede Kollegin, die mal ein Ticket beantworten soll, kostet extra. HyperLevel berechnet keine Plätze: Cloud 99,99 €/Monat pro Firma mit beliebig vielen Nutzern (49,99 € für eine Person), selbst gehostet 0 € – mit Tickets, SLAs, Wissensdatenbank und Kundenportal, und obendrein CRM, Postfach, Rechnungen und Automationen im selben Konto statt in zwei Tools mit Schnittstelle.

### Wechsel von Intercom

**Das kommt mit:** Kontakte (Nutzer und Leads) mit Name, E-Mail, Telefon, Ort, eigenen Attributen, Tags und Unternehmen · Unternehmen als Firmen · **Gespräche mit allen Nachrichten** als Verlauf im Postfach des Kontakts (Kundennachrichten als empfangen, Antworten von Team und Bot als gesendet, mit Originalzeit; nichts wird verschickt, nichts erscheint als ungelesen) · interne Notizen als Notizen am Kontakt · die Hilfe-Center-Artikel als **Entwurf** in der Wissensdatenbank (Sammlungen werden Kategorien).

**Das kommt nicht mit:** Anhänge und Bilder · Segmente, Kampagnen, Serien, Touren, Bots und Workflows (nachbauen) · direkt am Kontakt geschriebene Notizen · Ereignisse und App-Aktivität · Tickets und SLAs (Gespräche sind Verlauf, keine Tickets) · Übersetzungen der Artikel.

**Wichtig:** Wer sich in Intercom abgemeldet hat, ist „Nicht stören“. Alle anderen kommen als **Altbestand ohne eigenen Nachweis** in den Einwilligungs-Nachweis – ob sie Werbung bekommen, bestimmt deine Versandregel (Empfehlung: „Nur bestätigt“, sobald die Listen sauber sind).

**So gehst du vor:** Im Intercom Developer Hub eine interne App anlegen und den Zugriffs-Token mit Leserechten kopieren (liegt dein Workspace in der EU oder in Australien, auch die Region eintragen). Vorschau, Probelauf, Import. Danach den Chat auf deiner Website durch den HyperLevel-Live-Chat ersetzen, Bots und Workflows nachbauen, Artikel prüfen und veröffentlichen, dann kündigen.

**Warum wechseln?** Intercom rechnet **pro Platz**: laut Preisseite (Stand Oktober 2026) 29 $ je Platz und Monat im Tarif *Essential*, 85 $ im *Advanced* und 132 $ im *Expert* bei jährlicher Zahlung; dazu kommen 0,99 $ für jede vom KI-Agenten „Fin“ gelöste Anfrage und nutzungsabhängige Kosten für SMS, WhatsApp und E-Mail-Kampagnen. Je größer das Team und je mehr Gespräche, desto teurer. HyperLevel berechnet weder Plätze noch gelöste Anfragen: Cloud 99,99 €/Monat pro Firma mit beliebig vielen Nutzern (49,99 € für eine Person), selbst gehostet 0 € – mit Postfach, Live-Chat, KI-Assistenten, Helpdesk, CRM und Automationen in einem Konto.

### Wechsel von Salesforce

**Das kommt mit:** Accounts als Firmen · Kontakte und Leads mit allen Standardfeldern und **allen eigenen Feldern deiner Org** (Zahlen, Datum, Auswahllisten bleiben das, was sie sind), mit Firma verknüpft; Leads bekommen das Tag „Salesforce: Lead“ und „Lead-Status: …“ (umgewandelte Leads werden übersprungen) · Opportunities als **Deals in einer Pipeline**, deren Phasen aus deiner Org stammen (Reihenfolge und Wahrscheinlichkeit), „Closed Won“/„Closed Lost“ als gewonnen/verloren, Kontakt des Deals ist die primäre Kontaktrolle · Aufgaben.

**Das kommt nicht mit:** Berichte, Dashboards, Flows, Apex und Genehmigungsprozesse · E-Mails, Dateien, Notizen und Aktivitäten außer Aufgaben · Produkte, Preislisten, Angebote, Verträge · mehrere Verkaufsprozesse (alles landet in einer Pipeline) · Kampagnen, Cases, Berechtigungen und Teams.

**Wichtig:** Salesforce kennt kein Opt-in, nur ein Opt-out. Wer sich abgemeldet hat, bekommt „Nicht stören“; alle anderen kommen mit „keine Werbeeinwilligung“ im Nachweis herein – Service-Mails und Antworten gehen, Newsletter erst nach einer neuen Einwilligung.

**So gehst du vor:** In Salesforce unter *Einrichtung → App-Manager* eine App mit „Client Credentials Flow“ und einem Ausführungs-Benutzer mit Leserechten anlegen (Consumer Key und Secret kopieren) – oder kurzfristig einen Zugriffs-Token nehmen. Adresse der Org, Key und Secret in HyperLevel eintragen, Vorschau, Probelauf, Import. Danach Flows und Berichte neu bauen (HyperLevel-Workflows und Berichte), Verkaufsprozesse als Pipelines anlegen, App widerrufen.

**Warum wechseln?** Salesforce wird **pro Nutzer** berechnet – laut Preisseite (Stand Oktober 2026) 25 $ im *Starter Suite*, 100 $ im *Pro Suite*, 195 $ im *Core* und bis 550 $ im *Max* je Nutzer und Monat, dazu Zusatzprodukte wie Agentforce ab 125 $ und ein Premier-Support-Aufschlag von 30 % der Lizenzgebühren. Für ein Team aus fünf Personen sind das schnell mehrere Tausend Euro im Jahr, bevor irgendetwas eingerichtet ist. HyperLevel berechnet keine Plätze: Cloud 99,99 €/Monat pro Firma mit beliebig vielen Nutzern, selbst gehostet 0 € – mit Pipelines, Aufgaben, Postfach, Terminen, Rechnungen und Automationen im selben Konto.

### Wechsel von Zoho CRM

**Das kommt mit:** Accounts als Firmen · Kontakte und Leads mit Standardfeldern und **eigenen Feldern** (Nachschlagefelder und Formeln nicht; pro Abruf höchstens 50 Felder), mit Firma verknüpft, Leads mit Tag „Zoho: Lead“ und „Lead-Status: …“ (umgewandelte werden übersprungen) · Deals in **Pipelines mit ihren Phasen** in der Reihenfolge deines Kontos, gewonnen/verloren nach der Phasen-Art, mit Kontakt und Firma · Aufgaben · Notizen an Kontakten, Leads und Deals.

**Das kommt nicht mit:** Berichte, Dashboards, Workflow-Regeln, Blueprints, Makros · E-Mails, Anhänge, Dateien · Notizen an Accounts · Produkte, Angebote, Aufträge, Rechnungen, Kampagnen.

**Wichtig:** Zoho kennt kein Opt-in, nur ein Opt-out. Wer sich abgemeldet hat, bekommt „Nicht stören“; alle anderen kommen mit „keine Werbeeinwilligung“ im Nachweis herein – Newsletter erst nach einer neuen Einwilligung.

**So gehst du vor:** In der Zoho-API-Konsole deiner Region einen *Self Client* öffnen, im Reiter „Generate Code“ den Scope `ZohoCRM.modules.READ,ZohoCRM.settings.READ` und zehn Minuten Dauer wählen und den Code erzeugen. Region, Client-ID, Client-Secret und Code **innerhalb der zehn Minuten** in HyperLevel eintragen – der Code wird sofort gegen einen Refresh-Token getauscht. Vorschau, Probelauf, Import; danach die Workflow-Regeln als Automationen nachbauen, Zugriff in Zoho widerrufen, kündigen.

**Warum wechseln?** Zoho berechnet **pro Nutzer und Monat** nach Edition: mehrere Pipelines gibt es laut Preisseite erst ab *Standard*, Prozessverwaltung, KI-Agenten und unbegrenzte Berichte ab *Professional*, Freigabe-Workflows und Feldverschlüsselung ab *Enterprise*; die kostenlose Edition endet bei 3 Nutzern und 5.000 API-Aufrufen am Tag (aktuelle Preise je Region auf der Zoho-Preisseite). Wer wächst, steigt Stufe für Stufe auf und zahlt für jeden Platz mit. HyperLevel sperrt keine Funktion hinter einer Edition: alle Funktionen, beliebig viele Nutzer ab 99,99 €/Monat pro Firma (Cloud; 49,99 € für eine Person), selbst gehostet 0 € – mit Pipelines, Aufgaben, Postfach, Terminen, Rechnungen und Automationen.

### Wechsel von monday.com

**Das kommt mit:** Boards als **Projekte** – Gruppen als Abschnitte, die Status-Spalte als Status des Projekts (mit Farben), Priorität, Zeitplan und Fälligkeit, Zuständige (wenn die E-Mail zu einem Teammitglied passt, sonst steht der Name in der Beschreibung), weitere Spalten (Text, Zahl, Datum, Auswahl, Link, Checkbox) als Projektfelder · Items als Aufgaben mit ihrer Originalzeit · Subitems als Unteraufgaben · Updates samt Antworten als Kommentare, ohne dass jemand benachrichtigt wird · Docs als Wiki-Seiten (Überschriften, Listen, Tabellen, Code).

**Das kommt nicht mit:** Dateien und Bilder (Bild-Links in Docs zeigen noch zu monday) · Automationen, Integrationen, Dashboards, Ansichten, Formulare · Zeiterfassung, Abstimmungen, Abhängigkeiten, Board-Beziehungen und Formeln (kommen als Text mit dem aktuellen Wert) · archivierte Boards und gelöschte Items.

**So gehst du vor:** Bei monday.com Profilbild → *Developers* → *My access tokens* → Token kopieren und in HyperLevel einfügen, Vorschau, Probelauf, Import. monday begrenzt die Abfrage-Komplexität pro Minute und die Aufrufe pro Tag – der Umzug wartet bei Bedarf von selbst, und beim Tageslimit macht er am nächsten Tag dort weiter, wo er stand. Danach die Automationen als Aufgaben-Regeln oder Workflows nachbauen, Teammitglieder einladen (Zuweisungen bleiben nur bei passender E-Mail erhalten), dann kündigen.

**Warum wechseln?** monday rechnet **pro Platz** ab – laut Preisseite (Stand Oktober 2026) ab 9 $ je Platz und Monat im Tarif *Basic*, 12 $ im *Standard* und 19 $ im *Pro*, jeweils mit einer Mindestzahl an Plätzen – und was erlaubt ist, hängt am Tarif: im *Standard* 250 Automationen im Monat und 1.000 API-Aufrufe am Tag, im *Pro* 25.000 und 10.000. Wer eine Kollegin oder einen Kunden mitarbeiten lässt, zahlt einen Platz mehr. HyperLevel berechnet keine Plätze und sperrt nichts hinter einem Tarif: Projekte mit Liste, Board, Kalender und Gantt, Zeiterfassung mit Rechnung aus den Stunden, Abhängigkeiten und Vorlagen – ab 99,99 €/Monat pro Firma mit beliebig vielen Nutzern (49,99 € für eine Person), selbst gehostet 0 € – und das CRM, das Postfach und die Rechnungen im selben Konto.

### Wechsel von ClickUp

**Das kommt mit:** Listen als **Projekte** – die Status der Liste werden die Status des Projekts, eigene Felder (Text, Zahl, Datum, Auswahl, Checkbox, URL) Projektfelder · Aufgaben mit Beschreibung, Priorität, Start- und Fälligkeitsdatum, Tags, Zeitschätzung, Checklisten, Zuständigen (bei passender E-Mail) und Originalzeit · Unteraufgaben (Eltern zuerst, egal in welcher Reihenfolge ClickUp sie liefert) · auf Wunsch die Kommentare · Docs mit ihren Seiten als Wiki-Seiten.

**Das kommt nicht mit:** Anhänge · Automationen, Ansichten, Dashboards, Ziele, Formulare · Zeiteinträge · Abhängigkeiten und verknüpfte Aufgaben, Sprints und Story Points · archivierte Spaces, Listen und Docs.

**So gehst du vor:** In ClickUp Avatar → *Einstellungen* → *Apps* → *API-Token* → generieren und einfügen (bei mehreren Workspaces optional die Workspace-ID). Vorschau, Probelauf, Import. ClickUp erlaubt bei den meisten Tarifen 100 Anfragen pro Minute – der Umzug bremst von selbst; mit Kommentaren (eine Anfrage je Aufgabe) dauert er bei großen Listen länger, lässt sich aber jederzeit pausieren und fortsetzen. Danach Automationen nachbauen, dann kündigen.

**Warum wechseln?** ClickUp berechnet **pro Nutzer**: laut Preisseite (Stand Oktober 2026) 7 $ im Tarif *Unlimited* und 12 $ im *Business* bei jährlicher Zahlung (10 $ bzw. 19 $ monatlich), die KI *Brain* kostet 9 $ je Nutzer extra, und im kostenlosen Tarif sind 60 MB Speicher und 100 Automations-Läufe die Grenze. HyperLevel berechnet keine Plätze und hat keine Speicher- oder Automations-Stufen: Cloud 99,99 €/Monat pro Firma mit beliebig vielen Nutzern (49,99 € für eine Person), selbst gehostet 0 € – mit Projekten, Gantt, Zeiterfassung, Wiki, Postfach und CRM in einem Konto.

### Wechsel von Notion

**Das kommt mit:** Datenbanken mit einer **Status-Eigenschaft** als Projekte mit Aufgaben – der Inhalt der Seite hinter jeder Zeile wird zur Beschreibung, dazu Status (nach Gruppe *To-do / In progress / Complete* eingeordnet), Frist, Zuständige, Priorität, Tags und weitere Eigenschaften als Projektfelder · **alle anderen Datenbanken als eigene Objekte** mit passenden Eigenschaftstypen (Auswahl mit ihren Optionen) und Datensätzen, **Relationen als Verknüpfungen** · Seiten, die keine Datenbank-Zeilen sind, als **Wiki-Seiten mit der Seitenhierarchie** · auf Wunsch Kommentare.

**Das kommt nicht mit:** alles, was du der Integration nicht freigibst (so arbeitet Notion) · Dateien und Bilder (die Adressen laufen nach einer Stunde ab) · Ansichten, Filter, Formeln und Rollups (es kommt der aktuelle Wert), Vorlagen, Automationen · Datenbanken mit mehreren Datenquellen (werden mit Hinweis übersprungen) · bei eigenen Objekten Uhrzeiten und Enddaten von Datumsfeldern.

**So gehst du vor:** Unter notion.so/profile/integrations eine interne Integration anlegen (Lese-Rechte genügen), Token kopieren – und die Seiten und Datenbanken **mit der Integration teilen** (*…* → *Verbindungen*). Token in HyperLevel einfügen, Vorschau, Probelauf, Import; danach die Wiki-Seiten sichten (Bilder neu einfügen), Teammitglieder einladen, kündigen.

**Warum wechseln?** Notion rechnet **pro Mitglied** ab – laut Preisseite (Stand Oktober 2026) 8 $ (*Plus*) bzw. 16 $ (*Business*) bei jährlicher Zahlung, 10 $ bzw. 20 $ monatlich; im kostenlosen Tarif sind Uploads auf 5 MB, die Versionshistorie auf 7 Tage und externe Gäste auf 10 begrenzt, KI-Funktionen sind in den kleineren Tarifen nur eingeschränkt enthalten und der Notion Agent wird nach Guthaben abgerechnet. HyperLevel zählt keine Plätze: Wiki mit Seitenbaum und Versionen, Projekte, eigene Objekte mit Verknüpfungen, Formulare und CRM in einem Konto – ab 99,99 €/Monat pro Firma (Cloud; 49,99 € für eine Person) oder selbst gehostet für 0 €, mit allen Funktionen.

### Wechsel von Airtable

**Das kommt mit:** jede Tabelle als **eigenes Objekt** – das Primärfeld wird der Name, Feldtypen bleiben erhalten (Text, Zahl, Währung, Datum, Checkbox, Einfach- und Mehrfachauswahl mit ihren Optionen, E-Mail, URL, Telefon) · Datensätze mit ihrer Erstellzeit · **verknüpfte Datensätze als Verknüpfungen** zwischen den Datensätzen · Formeln, Rollups und Lookups als aktueller Wert, Personen und Anhangsnamen als Text.

**Das kommt nicht mit:** die Anhänge selbst (die Adressen laufen bei Airtable nach zwei Stunden ab – nur die Dateinamen kommen mit; lade die Dateien vorher herunter) · Ansichten, Filter, Interfaces, Automationen, Formulare, Kommentare, Schaltflächen · Formeln als Formeln · mehr als 50 Tabellen (HyperLevel legt höchstens 50 eigene Objekte an).

**So gehst du vor:** Unter airtable.com/create/tokens einen Token mit den Rechten `data.records:read` und `schema.bases:read` anlegen und die Bases freigeben; optional die Base-ID eintragen, wenn nur eine Base mitkommen soll. Vorschau, Probelauf, Import. Airtable erlaubt fünf Anfragen pro Sekunde und sperrt nach einer Überschreitung 30 Sekunden – der Umzug bremst und wartet von selbst. Danach Ansichten als Listenansichten der Objekte und Automationen als Workflows nachbauen.

**Warum wechseln?** Airtable rechnet **pro Bearbeiter** ab – laut Preisseite (Stand Oktober 2026) 20 $ im Tarif *Team* und 45 $ im *Business* je Nutzer und Monat bei jährlicher Zahlung; wer eine Tabelle pflegen darf, kostet einen Platz. HyperLevel hat keine Platzpreise: eigene Objekte mit typisierten Eigenschaften, Verknüpfungen und Listenansichten, dazu CRM, Formulare, Automationen und Postfach – ab 99,99 €/Monat pro Firma mit beliebig vielen Nutzern (49,99 € für eine Person), selbst gehostet 0 €.

### Wechsel von Typeform

**Das kommt mit:** Formulare als **Formular-Entwürfe** „… (aus Typeform, bitte prüfen)“ mit Fragen, Typ, Pflichtangabe und Auswahlmöglichkeiten · **jede abgeschickte Antwort** bei den Antworten des Formulars (mit Datum und den Fragen als Spalten – ohne Benachrichtigung und ohne Workflow); Antworten von Personen, die schon Kontakt sind, werden diesem zugeordnet · auf Wunsch die **Absender mit E-Mail-Adresse als Kontakte**.

**Das kommt nicht mit:** Logik (Sprünge), Designs, Willkommens- und Dankeseiten, Berechnungen · Datei-Uploads (der Link zur Datei bei Typeform steht in der Antwort), Zahlungen · unvollständige Antworten · Webhooks und Integrationen. Die allerneuesten Antworten (etwa 30 Minuten) liefert Typeform erst später aus – ein zweiter Lauf holt sie nach.

**Wichtig:** Typeform kennt keine Werbeeinwilligung. Absender, die als Kontakt angelegt werden, kommen mit „keine Werbeeinwilligung“ im Nachweis herein: Antworten und Service-Nachrichten gehen, Newsletter erst nach einer neuen Einwilligung. Ob jemand in deinem Formular zugestimmt hat, steht in der Antwort – prüfe das, bevor du ihn in einen Newsletter nimmst.

**So gehst du vor:** In Typeform unter *Konto → Persönliche Tokens* einen Token mit *Forms: Read* und *Responses: Read* anlegen (EU-Konto: zusätzlich „eu“ eintragen). Vorschau, Probelauf, Import; danach die Formulare prüfen und mit HyperLevel-Formularen, Auswahllogik und Folgeschritten (Workflow nach dem Absenden) neu verbinden und die Einbettung auf deiner Seite tauschen.

**Warum wechseln?** Typeform begrenzt **Antworten pro Monat** – laut Preisseite (Stand Oktober 2026) 100 im kostenlosen und im Tarif *Basic* (28 $ im Monat bei jährlicher Zahlung), 1.000 im *Plus* (56 $, drei Nutzer), 10.000 im *Business* (91 $, fünf Nutzer); weitere Nutzer und Auswertungen kosten extra. HyperLevel zählt keine Antworten und keine Plätze: Formulare mit Mehrschritt-Logik, die Antworten landen direkt im CRM, lösen Workflows aus und tragen den Einwilligungs-Nachweis mit – Cloud ab 49,99 €/Monat (eine Person) oder 99,99 € pro Firma mit beliebig vielen Nutzern, selbst gehostet 0 €.

### Wechsel von Calendly

**Das kommt mit:** Termintypen als **Kalender** – Dauer, Beschreibung, Farbe, Ort, Wochenzeiten und Sonderzeiten einzelner Tage · alle **Termine** (vergangene, kommende, abgesagte), je Teilnehmer einer, mit den Antworten auf die Buchungsfragen in den Notizen · auf Wunsch die **Teilnehmer als Kontakte**.

**Das kommt nicht mit:** die Termine anderer Teammitglieder (jedes Mitglied hat eigene – wiederhole den Umzug mit deren Token) · Routing-Formulare, Workflows und Mailtexte, Umfragen, Zahlungen, Kalender-Verbindungen, das Design der Buchungsseite.

**Wichtig:** Die Kalender kommen **inaktiv**, ohne Bestätigungs-Mail und ohne Erinnerung an – es geht nichts von selbst live, und niemand bekommt eine Mail zu Terminen, die schon bestätigt sind. Prüfe Zeiten und Texte, verbinde deinen Google- oder Outlook-Kalender neu, aktiviere die Kalender und tausche dann die Calendly-Links auf deiner Seite. Calendly kennt keine Werbeeinwilligung: Teilnehmer kommen mit „keine Werbeeinwilligung“ im Nachweis herein.

**So gehst du vor:** In Calendly *Integrationen → API & Webhooks → Persönliche Zugangs-Tokens* → Token erzeugen, einfügen, Vorschau, Probelauf, Import. Danach Erinnerungen und Nachfass-Mails in den Kalender-Einstellungen einrichten und Zahlungen (Stripe) neu verbinden.

**Warum wechseln?** Calendly gibt es kostenlos nur mit **einem Termintyp** und einer Kalender-Verbindung; Zahlungen, Workflows und Erinnerungen gehören laut Preisseite (Stand Oktober 2026) zum Tarif *Standard* (10 $ je Platz und Monat bei jährlicher Zahlung), Round-Robin und Routing-Formulare zu *Teams* (16 $ je Platz). HyperLevel berechnet keine Plätze und hat keine Termintyp-Grenze: Buchungsseiten mit Limits, Sonderzeiten, Puffern, Erinnerungen, Nachfassen und Team-Kalendern, direkt verbunden mit CRM, Rechnungen und Automationen – Cloud ab 49,99 €/Monat (eine Person) oder 99,99 € pro Firma mit beliebig vielen Nutzern, selbst gehostet 0 €.

### Wechsel von Lexware Office (lexoffice)

**Das kommt mit:** Kunden (Lieferanten und Archiviertes nicht) als **Kontakte und Firmen** – eine Firma wird Firma mit ihrer Hauptansprechperson als Kontakt (weitere Personen als weitere Kontakte), mit Kundennummer, Steuernummer, USt-IdNr., Rechnungsadresse, E-Mail und Telefon · **Belege** (Rechnungen, Gutschriften, Angebote, Auftragsbestätigungen, Lieferscheine, Abschlagsrechnungen, Mahnungen – ohne Entwürfe) als **Eintrag im Verlauf des Kontakts**: Nummer, Datum, Betrag, Status, Fälligkeit.

**Wichtig – Belege sind hier Verlauf, keine Rechnungen:** Ein übernommener Beleg bekommt **keine Nummer aus dem Rechnungs-Nummernkreis von HyperLevel**, wird nicht festgeschrieben, archiviert oder versendet und verändert die Buchhaltung nicht. Das Original mit PDF bleibt bei Lexware – Rechnungen und Buchungsbelege müssen **8 bzw. 10 Jahre aufbewahrt** werden: exportiere sie (PDFs, DATEV-Export) und behalte den Zugriff, bevor du kündigst. Die Buchhaltung von HyperLevel ist „Buchhaltung light, Vorbereitung für den Steuerberater“ und **keine zertifizierte Buchhaltungssoftware** – wer sie auf Lexware stützt, bleibt dort, bis der Steuerberater etwas anderes sagt.

**Das kommt nicht mit:** Belege der Lieferanten, Buchungen, Zahlungen, Konten, Umsatzsteuer-Voranmeldungen, Kassenbuch · Artikel, Vorlagen, wiederkehrende Rechnungen · Positionen und PDFs der Belege · Lieferanten. Lexware kennt keine Werbeeinwilligung: Kunden kommen mit „keine Werbeeinwilligung“ im Nachweis herein.

**So gehst du vor:** Unter app.lexware.de/addons/public-api einen API-Schlüssel erstellen (die öffentliche API gehört zum Tarif *XL*), in HyperLevel einfügen, Vorschau, Probelauf, Import. Ab dann schreibst du neue Rechnungen in HyperLevel (mit eigenem Nummernkreis, XRechnung und Mahnwesen) – oder bleibst für die Buchhaltung bei Lexware und nutzt HyperLevel für Kunden, Angebote und Kommunikation.

**Warum wechseln?** Bei Lexware Office hängt der Funktionsumfang am Tarif: laut Preisseite (Stand Oktober 2026, netto im Monat) *S* 7,90 €, *M* 12,90 €, *L* 21,90 € und *XL* 32,90 € – Mahnungen und Angebote gibt es erst ab *M*, die Buchhaltung ab *L* und die **Schnittstelle erst im teuersten Tarif**. Ein CRM mit Pipelines, Gespräche, Terminbuchung und Marketing hat Lexware nicht: dafür brauchst du weitere Tools. HyperLevel bringt CRM, Postfach, Termine, Automationen und GoBD-orientierte Rechnungen mit – ohne Funktionsstufen: Cloud ab 49,99 €/Monat (eine Person) oder 99,99 € pro Firma, selbst gehostet 0 €.

### Wechsel von sevDesk

**Das kommt mit:** Kunden und Interessenten (Lieferanten nicht) als **Kontakte und Firmen** – eine Organisation wird Firma und Kontakt, ihre Personen werden Kontakte der Firma, Interessenten bekommen das Tag „Interessent“, dazu Haupt-E-Mail und -Telefon, Adresse, Kundennummer, Steuernummer und USt-IdNr. · **Belege** (Rechnungen, Stornorechnungen, Mahnungen, Teil-, Abschlags- und Schlussrechnungen, Gutschriften, Angebote, Auftragsbestätigungen, Lieferscheine – ohne Entwürfe) als **Eintrag im Verlauf des Kontakts** mit Nummer, Datum, Betrag, Status und Fälligkeit.

**Wichtig – Belege sind hier Verlauf, keine Rechnungen:** wie bei Lexware: keine Nummer aus dem Nummernkreis von HyperLevel, nicht festgeschrieben, nichts versendet, die Buchhaltung bleibt unberührt. Die Originale mit PDF liegen bei sevDesk und müssen **8 bzw. 10 Jahre aufbewahrt** werden – exportiere sie, bevor du kündigst. HyperLevel ersetzt keine zertifizierte Buchhaltungssoftware.

**Das kommt nicht mit:** Belege der Lieferanten, Buchungen, Bankkonten und Transaktionen, Umsatzsteuer, Kassenbuch · Produkte, Vorlagen, wiederkehrende Rechnungen, Tags · Positionen und PDFs · Lieferanten. sevDesk kennt keine Werbeeinwilligung: Kunden kommen mit „keine Werbeeinwilligung“ im Nachweis herein.

**So gehst du vor:** In sevDesk unter *Einstellungen → Benutzer* deinen Benutzer öffnen und den API-Token kopieren (nur Administratoren; die Schnittstelle gehört zum Tarif *Buchhaltung Pro*), in HyperLevel einfügen, Vorschau, Probelauf, Import. Das Konto wird an der Mandanten-Nummer erkannt, nicht am Token – ein neuer Token legt nichts doppelt an.

**Warum wechseln?** sevDesk staffelt nach Funktionen und Nutzern: laut Preisseite (Stand Oktober 2026, netto im Monat bei monatlicher Zahlung) *Rechnung* 11,90 €, *Buchhaltung* 25,90 €, *Buchhaltung Pro* 34,90 € – jeweils mit **einem** Nutzer, jeder weitere ab 5,90 € im Monat, der kostenlose Tarif erlaubt drei Rechnungen im Monat, und die **Schnittstelle gibt es erst im teuersten Tarif**. HyperLevel hat keine Funktionsstufen und keine Nutzerpreise: CRM, Postfach, Termine, Automationen und Rechnungen mit XRechnung und Mahnwesen – Cloud ab 49,99 €/Monat (eine Person) oder 99,99 € pro Firma mit beliebig vielen Nutzern, selbst gehostet 0 €.

## Field mapping

The preview lists every field of the source (standard fields and the account's own custom fields) and what it becomes. The automatic mapping recognises the usual names in German and English (*E-Mail-Adresse*, *First Name*, *Vorname*, *Telefon*, *PLZ* …). For each field you can choose:

- a **standard field** (first name, last name, e-mail, phone, company, street, city, postcode, country, website, birthday, source),
- an **existing custom field**,
- **Neues eigenes Feld anlegen …** – asks for a label and a type (text, long text, number, date, choice, yes/no, e-mail, phone, URL); the field is created when the import starts, and an existing field with the same name is reused,
- **a tag** (the value becomes a tag; comma-separated values become several),
- **a note** on the contact,
- or **skip** it.

Fields that need conversion are converted on the way in: dates (ISO, `31.12.2024`, epoch seconds or milliseconds), phone numbers, yes/no values, choices (new options are added to the custom field), currency amounts (to cents).

## Duplicates, merging and re-runs

- A contact is **the same person** when the e-mail (case-insensitive) or the phone number matches one in the sub-account. Contacts without e-mail *and* phone are skipped and counted.
- **Existing contacts** are filled in (default: only empty fields) or overwritten (*Vorhandene Werte überschreiben*). Tags are only ever added.
- Every imported record stores its **external ID** (per vendor account, so two Mailchimp accounts never collide). A second run – or the continuation of an interrupted run – updates what is known and creates only what is new: **nothing is imported twice**. The preview says how much is already known from earlier runs.
- You can **tag every imported contact** (e.g. *Umzug Mailchimp*) to find them later.

## Unsubscribed and consent

People who unsubscribed, bounced or complained at the old tool must not be mailed by accident. They are imported with **Nicht stören** (`dnd`) *and* a tag naming the reason (e.g. *Mailchimp: abgemeldet*), so the history is not lost and campaigns skip them. Only people the source marks as subscribed/active are reachable. Export files are read the same way (a *State*/*Status*/*Email Marketing Status* column, or – for Mailchimp ZIP exports – the separate *unsubscribed* and *cleaned* files).

## Consent ledger and reference lists

Since the second wave of importers the sources that know more than "subscribed" write into the [consent ledger](consent.md) as well:

- **Confirmed** – the old tool holds an explicit, dated opt-in (a confirmed double opt-in, a recorded consent with its method). The ledger gets a `granted` line, dated as in the old tool, with the source named ("Umzug aus Klaviyo").
- **Legacy (Altbestand)** – the person is "subscribed", but the old tool has no proof of its own. The ledger gets a `legacy` line whose note says where the contact came from and that the proof stays with the old provider – export it before you close that account. The send gate treats it as you set it in *Einwilligung & Recht* (default: legacy contacts may still get advertising; switch to *Nur bestätigt* when your lists are clean).
- **Revoked** – unsubscribed, bounced, blocked or complained: a `revoked` line (and *Nicht stören* plus a tag, as before).
- **Pending** (double opt-in not clicked yet) writes **no** line and the person stays on *Nicht stören*: they never said yes.

Merged contacts keep the history they already have – only withdrawals are added to it. A re-run adds nothing twice, an undo removes the lines the import wrote. Nothing is sent and no workflow starts (the ledger lines are written directly, without the `consent.confirmed` event).

**Reference lists** are wiki pages in the space *Umzug* for things that cannot be rebuilt automatically (funnels, flows, boards …): names, steps and addresses, so nothing is forgotten when the old account is closed. A page nobody has touched is refreshed by a re-run; a page you edited stays as you left it, and so does its undo.

## Projects, pages, tables, forms, calendars and documents

The importers of the third wave write into the planner, the wiki, the custom objects, the forms, the calendars and the contact history. The rules are the same everywhere:

- **Nothing is sent and nothing starts.** Tasks, appointments, answer sheets, records and pages are written straight into their tables: no task or form event, no notification, no confirmation mail, no reminder, no workflow. People are never mailed because of an import.
- **Imported things are marked.** Tasks end with a line *Aus … übernommen* (with the link to the original and the people at the old tool that could not be matched to a team member by e-mail), wiki pages are written by *Umzug (…)*, forms say "bitte prüfen", calendars come **inactive**.
- **What a person has changed since stays.** A re-run refreshes a task, record, appointment, calendar or page only while it is still as the import left it (a stamp or fingerprint of what was written is kept in the id map); otherwise it is counted as *skipped*. New items are added, nothing is doubled.
- **Projects** get the statuses of the old board (every project keeps at least a *todo* and a *done* status), sections for groups, and custom project fields for columns. Subtasks are written after their parent (up to six levels). **Wiki pages** keep their hierarchy and go into a space named after the tool; a doc with several pages becomes a parent page with children. **Custom objects** are created per table or database with typed properties (a choice the data has but the definition lacks is added; a value that does not fit its type is left out and noted once); relations become associations (each pair once).
- **Answer sheets** (Typeform) go into the submissions of the imported form – never as a new lead. **Calendars** (Calendly) are saved inactive and without messages; **appointments** are stored as they were (past, upcoming, cancelled), without reminder. **Documents** (Lexware, sevDesk) are read-only entries in the contact's history – no invoice, no number from the invoice ranges, nothing frozen or sent.
- **Undo** deletes what the job created: tasks (subtasks first) and projects, records, links and custom objects, wiki pages and spaces, answer sheets, appointments and calendars, history entries. It keeps what people have worked on since – a task with time entries, comments, attachments or dependencies (and with it its project), a record with notes (and its object), a wiki page somebody edited or that has pages of its own below it, a calendar with appointments that are not from the import – and lists everything that stayed.

## Dry run, pause, resume and undo

- **Dry run** reads the real source and runs the whole mapping and merge logic with virtual ids – nothing is written to your database.
- **Pause / Fortsetzen:** a job saves its position (a cursor per step) after every page. A server restart marks a running job as paused – resume it from the report page or *Letzte Umzüge*.
- **Undo** (*Umzug rückgängig machen*) deletes what the import **created** (contacts, tags, custom fields, lists, companies, pipelines, deals, notes, tasks, templates, products, courses, forms, workflow drafts, tickets, articles, conversation messages, consent-ledger lines, reference lists, and – see [Projects, pages, tables, forms, calendars and documents](#projects-pages-tables-forms-calendars-and-documents) – projects, wiki pages, custom objects, answer sheets, calendars, appointments and history entries), in dependency order, and **restores contacts the import only merged into** from the copy it kept before changing them. It leaves alone what you changed since: contacts you edited, tags and fields that are used elsewhere now, workflows that are active. The result lists everything that stayed. The *before* copies are kept for 30 days; after that an undo still deletes created records but cannot restore merged ones.

## Export files

Upload CSV, TSV, JSON, HTML or **ZIP** (a ZIP is unpacked in memory with limits – no encrypted or zip64 archives, a guard against zip bombs). Excel files are refused with a hint to save them as CSV. The file *kind* (contacts, deals, course structure, students, templates) is detected from the columns and can be changed in the list; several files can go in one import. Character sets (UTF-8 with or without BOM, Windows-1252) and delimiters (`,` `;` tab) are detected.

The generic contact import (*Kontakte → Import*) also recognises the usual header names of these tools' exports (*Email Address*, *Person - Email*, *Organization - Name*, *Phone 1* …) – the Umzug assistant adds the preview, merge options, consent handling and undo on top.

**Course structure** (for Kajabi, Teachable or anything else): CSV with the columns `course, module, lesson, video_url, text`, or JSON `{"courses": [{"title", "modules": [{"title", "lessons": [{"title", "video_url", "text"}]}]}]}`.

## Data protection and security

- **Keys are sealed** with the server's data key (the same mechanism as every other integration secret), are never returned by the API, never logged and never part of an audit entry. The connect routes work for logged-in people in the UI only – not with an API key, agency key or MCP.
- **Files hold personal data:** they are stored with mode 0600 in `data/umzug/`, **deleted right after a successful import** (unless you tick *Dateien behalten*), after 14 days at the latest, and when the sub-account is deleted. The wizard shows column names and counts, never rows from the database.
- **The id map does not keep e-mail addresses:** for file imports the external ID of a contact is a hash of the e-mail address.
- **Erasure:** *DSGVO → Löschen* of a contact also removes its id mappings and undo copies.
- **Isolation:** every route is bound to the sub-account (`x-location-id`) and checked against the logged-in person's areas; ids of other sub-accounts answer 404. Previews are rate limited.
- **Outbound:** only HTTPS to the vendor hosts listed above (validated per account: Mailchimp data centre, ActiveCampaign host pattern, Pipedrive company slug, Zendesk subdomain, Intercom and Zoho region, Salesforce domains, Typeform data centre); response links are never followed; responses are size limited. Imported HTML is cleaned (scripts and `on…` handlers removed).

## Self-hosting

Nothing to install. The server needs outgoing HTTPS to the vendors you want to import from (`<dc>.api.mailchimp.com`, `*.api-us1.com`, `api.kit.com`, `api.kajabi.com`, `developers.teachable.com`, `api.infusionsoft.com`, `api.pipedrive.com` / `<company>.pipedrive.com`, `api.systeme.io`, `a.klaviyo.com`, `api.brevo.com`, `api.klicktipp.com`, `api.manychat.com`, `<subdomain>.zendesk.com`, `api.intercom.io` / `api.eu.intercom.io` / `api.au.intercom.io`, the org's Salesforce My Domain host (`<name>.my.salesforce.com`), `www.zohoapis.<region>` with `accounts.zoho.<region>`, `api.monday.com`, `api.clickup.com`, `api.notion.com`, `api.airtable.com`, `api.typeform.com` / `api.eu.typeform.com`, `api.calendly.com`, `api.lexware.io`, `my.sevdesk.de`) – export files need no outgoing traffic at all. In demo mode outgoing connections are blocked, so the API connections cannot be tried there.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PGHL_UMZUG_MAX_MB` | `50` | Largest export file (1–500 MB). A reverse proxy in front must allow bodies of that size on `POST /api/umzug/files`. |

Back up `data/` as usual – it holds the uploaded files of unfinished imports and the id maps that make re-runs idempotent.

## REST API and MCP tools

Team routes (login with `x-location-id`, sub-account API key or agency key; area *Einstellungen*; every write is in the audit log) are listed under [Umzug in docs/api.md](api.md#umzug-switch-over-importers). MCP tools: `ghl_umzug_sources` (what can be imported and what is connected), `ghl_umzug_preview` (counts, fields, mapping for a connected source), `ghl_umzug_start` (dry run or import with parts, mapping and options), `ghl_umzug_status` (progress and report). Credentials cannot be entered over MCP – connect in the UI first.

## For developers

| File | What it holds |
| --- | --- |
| `modules/umzug.ts` | Tables (`umzug_connections`, `umzug_files`, `umzug_jobs`, `umzug_ids`, `umzug_items`), the routes, the job runner (one job per sub-account), housekeeping, `app.services.umzug.idle()` for tests |
| `services/umzug-core.ts` | Normalised records (`Rec`: contact, tag, membership, smart list, company, pipeline, deal, note, task, template, product, course, enrolment, form, workflow, activity, reference, ticket, article, conversation, project, project task, doc, object type / record / link, submission, calendar, appointment), the source registry `SOURCE_LABELS`, `SourceDef`, `StepDef`, auto-mapping |
| `services/umzug-engine.ts` | `runJob` (steps → batches → one transaction per page, a savepoint per record), `buildPreview`, `undoJob`, report lines |
| `services/umzug-write.ts` | `Writer`: turns records into rows, dedupes, remembers external ids and what to undo |
| `services/umzug-http.ts` | `VendorHttp` (retry, backoff, German errors), `UmzugError` |
| `services/umzug-files.ts`, `umzug-zip.ts` | CSV/TSV/JSON/HTML/ZIP readers and the file-based steps |
| `services/umzug-extra.ts` | `ExtraWriter` for everything beyond the basics – consent-ledger lines, reference lists and wiki pages, tickets, knowledge-base articles, conversations – and it hands projects, objects and bookings to the writers below; `undoExtra` takes them back |
| `services/umzug-pm.ts` | `PmWriter`: projects (statuses, sections, fields), tasks through the planner's `createTask` (quiet), comments; `undoPm` |
| `services/umzug-objects.ts` | `ObjectsWriter`: custom-object types with properties, records through `customObjects.upsert`, associations; `undoObjects` |
| `services/umzug-booking.ts` | `BookingWriter`: calendars (inactive), appointments, form answer sheets; `undoBooking`, `undoSubmissions` |
| `services/umzug-lib.ts`, `umzug-flow.ts`, `umzug-crm.ts` | Plumbing the newer importers share: preview contexts and counters, workflow-draft helpers, CRM consent (`crmConsent`), deal stages and `documentActivity` |
| `services/umzug-<vendor>.ts` | One source: credentials, how-to, parts, `describe`, `steps` |
| `services/umzug-automation.ts` | Translates ActiveCampaign automations and Kit sequences to workflow drafts |
| `services/umzug-text.ts` | Dates, money, HTML and merge-tag conversion |
| `modules/umzug-tools.ts` | The MCP tools |

**Adding a source:** write `services/umzug-<name>.ts` exporting a `SourceDef` (use `VendorHttp` with a `base` URL, never a host taken from a response), add one line to `SOURCE_LABELS` in `umzug-core.ts` and one entry to `SOURCES` in `umzug-sources.ts` (the wizard, the MCP tools and the tests read the registry); steps are async generators yielding `{records, cursor, total}` batches, so resuming works without extra code. A fake vendor server (`FakeVendor` in `tests/umzug-fakes.ts`; the later ones in `umzug2-fakes.ts` and `umzug3-fakes.ts`, run through `umzug2-harness.ts`) makes the whole import testable offline. **Tests** use `app.services.umzugFetch` (the fake), `umzugSleep` and `umzugPauseMs` (no waiting).
