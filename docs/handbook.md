**English** · [Deutsch](handbook.de.md)

# Handbook: Taking over the company with HyperLevel

This handbook is the printed version of the complete guide **“Taking over the company”** from the **Academy** (the *Academy* menu item in HyperLevel). In 14 chapters it takes a successor through everything needed to run the company – from secure access and the daily routine to running the server. Altogether it takes about 5 hours; each chapter can be done on its own and resumed later.

> The best way is to do the chapters directly in the app: there the tour highlights every field and button, explains it and waits until you have tried it. For practice, the Academy can create a **practice company** with made-up customers – nothing can break there and nothing is sent.

**Contents**

1. [Access & security](#chapter-1-access--security) – Password, two-factor sign-in, devices, who has access – and where credentials are kept (never in plain text).
2. [Agency overview](#chapter-2-agency-overview) – Projects and clients, the project switcher, Ctrl+K and each project's Claude sessions.
3. [Daily routine](#chapter-3-daily-routine) – The 15-minute round every morning: inbox (including WhatsApp and calls), tasks, appointments, pipeline, tickets – and your own dashboard.
4. [Clients & projects](#chapter-4-clients--projects) – Contact and company profiles, custom objects and properties, project profile, website monitoring, documents and Claude artefacts.
5. [Marketing](#chapter-5-marketing) – Campaigns with the e-mail designer, Social Planner, workflows, attribution, affiliates, advertising, lead scoring and marketing reports.
6. [Websites & funnels](#chapter-6-websites--funnels) – Page builder, blog, A/B tests, forms, calendar booking and custom domains.
7. [Courses & community](#chapter-7-courses--community) – Online courses, members' area and community groups – access, moderation, members.
8. [Revenue](#chapter-8-revenue) – Invoices & quotes, Stripe, products & buy links, accounting with Norman, contracts.
9. [Reputation](#chapter-9-reputation) – Collecting reviews, connecting the Google profile, replying to reviews.
10. [Service & support](#chapter-10-service--support) – Tickets and SLAs, assignment, support mailbox, knowledge base, satisfaction (CSAT/NPS) and at-risk customers in the health score.
11. [AI](#chapter-11-ai) – AI assistant in the inbox and chat, AI phone agent and the Claude tools (MCP).
12. [Settings & integrations](#chapter-12-settings--integrations) – Channels, telephony, Stripe, integrations catalogue, Zapier/Make/n8n, HubSpot import, OAuth, Todoist, Supabase, Android app, SaaS, white label, domains, snapshots.
13. [Operations](#chapter-13-operations) – Backups, the log, the weekly server resources routine and what to do when a website is down.
14. [Final checklist](#chapter-14-final-checklist) – Tick everything off: access, sending, payments, backups, websites, automations – then the company is taken over.

---

## Chapter 1: Access & security

Password, two-factor sign-in, devices, who has access – and where credentials are kept (never in plain text). *(about 20 minutes)*

1. **Welcome to the handover** – This guide takes you through everything you need to run the company with HyperLevel, in 14 chapters. Each chapter takes 10–35 minutes. Pause at any time with ✕ – the Academy picks up exactly where you left off.
2. **The ground rule for credentials** – Passwords, API keys and tokens belong in a **password manager** (e.g. 1Password or Bitwarden) – never in notes, e-mails, chats or the project profile. HyperLevel never shows saved secrets again, only “stored”.
3. **Your password** *(Settings → My account)* – Did someone else give you your password? Then change it now – long, unique, from the password manager.
4. **Turn on two-factor sign-in** – With 2FA, a stolen password is no longer enough. When you sign in, HyperLevel also asks for a 6-digit code from your authenticator app. – *How to:* Click **Set up 2FA**, scan the QR code with the app and enter the code.
5. **Save the backup codes** – Once 2FA is on, backup codes appear. Save them in the password manager or print them – they help if you lose your phone.
6. **Signed-in devices** – At a handover: sign out all other devices. Afterwards only you are signed in.
7. **Who has access?** *(Settings → Team)* – Delete the accounts of former staff and check who is an **admin**. Every admin should have the green 2FA mark – otherwise “Reset 2FA” and have them set it up again.
8. **Handover status** *(Academy)* – This shows at a glance who is still without 2FA, what is set up and what is missing. We come back to it at the end.
9. **Keys for Claude & co.** *(Agency → API & MCP)* – Agency keys let Claude (MCP) and other programs access the system. Delete unknown or old keys; new ones are shown only once – straight into the password manager.
10. **Sub-account API keys** *(Settings → API & webhooks)* – The same for each sub-account: delete anything you don't recognise. “Last used” shows what is still needed.
11. **Accounts outside HyperLevel** – List every account that belongs to the company: domain registrar, server (e.g. Hostinger), Stripe, Twilio, Meta, Google, Anthropic, e-mail mailbox. For each one: credentials in the password manager, 2FA on, billing and contact e-mail up to date.

**What you have learnt:**

- Where credentials belong: in the password manager, never in notes or e-mails
- Securing your own account with 2FA and backup codes
- Signing out unknown devices
- Checking accounts, admins and keys

More: [Features: security](../README.md#features)

---

## Chapter 2: Agency overview

Projects and clients, the project switcher, Ctrl+K and each project's Claude sessions. *(about 15 minutes)*

1. **All projects** *(Agency → Projects)* – Each card is a project or client (sub-account) – with status, website availability, open deals, tasks and messages. One click takes you into it.
2. **Your project** *(Project)* – Every project has a profile: what it is, how it is going, where everything is.
3. **Project switcher** – At the top left you switch between projects – with search. Recently used ones are at the top.
4. **Ctrl+K** – The command bar finds projects, pages, documents and Claude sessions. – *How to:* Click **Jump** or press Ctrl+K.
5. **Try it** – Type the name of a project and press Enter. Esc closes the bar.
6. **Claude sessions** – Many projects have a Claude session (claude.ai/code) where work on the project happens. The link is here and on the Claude button – that is how you take over ongoing development too.
7. **Documents & artefacts** – Reports, concepts and Claude artefacts for the project. Read through them once when you take over.
8. **Clients** *(Agency → Clients)* – All clients with contacts, websites and logins. This is also where you add new clients.
9. **Across all projects** *(Agency → Projects)* – Contacts, deals, tasks and documents are also available across projects – handy for the morning overview.
10. **Help is always there** – Stuck on a page? Click the **?** at the top right – the matching tour starts there.

**What you have learnt:**

- Finding all projects and clients
- Jumping quickly with the project switcher and Ctrl+K
- Where a project's Claude sessions and documents live
- Using cross-project lists

More: [As an agency](../README.md#features)

---

## Chapter 3: Daily routine

The 15-minute round every morning: inbox (including WhatsApp and calls), tasks, appointments, pipeline, tickets – and your own dashboard. *(about 20 minutes)*

1. **The morning round** – The same round every morning, about 15 minutes: 1. dashboard, 2. inbox, 3. missed calls, 4. tasks, 5. appointments, 6. pipeline – and if you do customer service: 7. tickets. With several projects: the agency overview first.
2. **1. Dashboard** *(Dashboard)* – One glance is enough: new contacts, messages, appointments, revenue. Unusual numbers? Follow up.
3. **2. Inbox: new items only** *(Conversations)* – E-mail, SMS, WhatsApp, Messenger, Instagram, chat and calls all land here. – *How to:* Click **New**.
4. **Work through it** – From top to bottom: open, reply or keep as a task. Under “Drafts”, replies from the AI assistant and imported e-mail drafts wait for your approval.
5. **Replying** – Choose the channel at the bottom of the thread and write. WhatsApp has a 24-hour window – after that, only with a template.
6. **3. Missed calls** *(Calls)* – Who called and didn't reach anyone – with voicemail to listen to. – *How to:* Click **Missed**.
7. **Calling back** – “Call back” rings you first (phone or browser) and then connects.
8. **4. Tasks** *(Tasks)* – What is due today, what is overdue (red)? Tick off what's done, add new tasks with a date.
9. **5. Appointments** *(Calendar)* – Upcoming appointments. After an appointment, set its status (showed / no-show) – it counts towards the dashboard and can start workflows.
10. **6. Pipeline** *(Opportunities)* – Move deals on, update values, mark won and lost. A well-kept pipeline is your revenue forecast.
11. **7. Tickets** *(Tickets)* – If you do support: sort by “SLA first” and filter by “Unassigned” – whatever is at risk comes first. More in the chapter “Service & support”.
12. **Your morning dashboard** *(Reports)* – Under **Reports** you create a dashboard from a template with one click (e.g. “Sales” or “Activity”) – and have it sent to you every morning with “By email”.
13. **All projects at once** *(Agency → Tasks)* – With several projects: Agency → Tasks shows all open tasks of all projects, overdue ones first.
14. **Tip: push to your phone** *(Settings → My account)* – Turn on push notifications so you don't have to keep checking: new messages, tasks due, payments.

**What you have learnt:**

- The fixed order of the morning round
- Working through unread messages and missed calls
- Keeping tasks and appointments in view
- Keeping the pipeline up to date
- Using your own dashboard under Reports

More: [Features at a glance](../README.md#features)

---

## Chapter 4: Clients & projects

Contact and company profiles, custom objects and properties, project profile, website monitoring, documents and Claude artefacts. *(about 25 minutes)*

1. **Finding a client** *(Contacts)* – Name, e-mail, phone or company – search finds everything. – *How to:* Search for a client, e.g. “Anna”.
2. **Open** – Clicking the row opens the contact profile with all the details and the history. – *How to:* Click a contact.
3. **The profile** – All details, custom fields, tags, “Do not disturb” and actions: call, request a review, write an invoice.
4. **The history** – Everything that has happened with the client: messages, appointments, forms, purchases, notes, tasks. For important clients, read through it all once.
5. **Tags** – Tags control newsletters, workflows and course access. Change them deliberately – removing a tag can, for example, take away access to a course.
6. **Companies** *(Companies)* – Contacts belong to companies – automatically via the “Company” field or the e-mail domain. The company page shows all contacts, deals, tickets and tasks of a company.
7. **Duplicate companies** – After a takeover, companies are often duplicated (“Muster GmbH” and “Muster”). Search for the name and merge them on the company page with “Merge”.
8. **Custom objects** *(Objects)* – Are there custom objects such as projects, contracts or vehicles? They are listed here and in the sidebar – with records and links to contacts and companies.
9. **The project profile** *(Project)* – What is the project, what are its goals, which links, which servers? Keep it up to date – it is the company's memory.
10. **Website monitoring** – Green = the website responds. It is checked every 10 minutes; if it goes down, you get an alert.
11. **Add the website** – If the address is missing, monitoring is off too.
12. **Documents & artefacts** – Concepts, reports and Claude artefacts. Claude files reports here directly through the MCP tools.
13. **All documents** *(Agency → Documents)* – All documents of all projects in one place – also findable with Ctrl+K.
14. **Properties** *(Properties)* – Missing a piece of information (e.g. “Contract end”)? Under Properties you create your own fields for contacts, companies, deals and custom objects – in groups and with help text.

**What you have learnt:**

- Finding a client and seeing everything about them
- Using tags and notes sensibly
- Companies, custom objects and properties
- Keeping the project profile up to date
- Website monitoring, documents and Claude artefacts

More: [Features: contacts & projects](../README.md#features)

---

## Chapter 5: Marketing

Campaigns with the e-mail designer, Social Planner, workflows, attribution, affiliates, advertising, lead scoring and marketing reports. *(about 30 minutes)*

1. **What is running right now?** – When you take over, first look at what happens automatically: active workflows, scheduled campaigns, scheduled social posts. Understand first, then change.
2. **Campaigns** *(Campaigns)* – Newsletters by e-mail or SMS. Scheduled campaigns go out on their own – check that they still fit.
3. **Templates & designer** – The inbox and every workflow use templates. They are designed with the e-mail designer (it has its own tour).
4. **Automations** *(Automations)* – Workflows run in the background – e.g. welcome e-mails, reminders, “Missed call → SMS”. Status “active” means it really is running.
5. **Check the list** – Open every active workflow once: trigger, steps, history. Pause what nobody needs any more instead of deleting it.
6. **Social Planner** *(Social Planner)* – Scheduled posts for Instagram, Facebook, LinkedIn & co. in a monthly calendar.
7. **Where do the customers come from?** *(Attribution → Report)* – Attribution shows leads, deals and revenue per source, campaign or funnel – without any third-party tracking.
8. **Advertising** – If Meta or Google Ads are connected: cost per lead and revenue per euro spent on ads, for each campaign. That shows you which ad pays off.
9. **Affiliates** *(Affiliates)* – Partners who recommend you earn commission. Once a month: approve and pay out commissions.
10. **Lead scoring** *(Lead scoring)* – Points for matching properties and activity show who is ready to buy. From a threshold such as MQL or SQL, a workflow can notify sales – check that the rules and thresholds are still right.
11. **Marketing dashboard** *(Reports → Templates)* – The “Marketing” template shows new leads, lead → deal, leads per source and campaign performance – as your own dashboard with one click.
12. **Going deeper** – Every area has a module tour with exercises: Campaigns, E-mail designer, Workflows, “Receive webhook”, Social Planner, Attribution, Affiliates, Lead scoring and Reports.

**What you have learnt:**

- What is currently running in campaigns and workflows
- Where newsletters and templates are designed
- Scheduling social posts
- Where customers come from and what advertising costs
- Which leads are ready to buy (lead scoring)

More: [Attribution, affiliates & advertising](growth.md)

---

## Chapter 6: Websites & funnels

Page builder, blog, A/B tests, forms, calendar booking and custom domains. *(about 30 minutes)*

1. **All pages** *(Funnels & websites)* – Funnels (sequences such as sign-up → thank you) and whole websites. Each card shows views and domain.
2. **The list** – Open every website once and click “Live ↗”: does everything look right, are the legal notice and privacy policy correct?
3. **Editing** – Pages are made of blocks (hero, text, image, form, calendar, FAQ, pricing …) with a live preview. The “Funnels & websites” tour shows it step by step.
4. **Blog** – Every website has a blog (the “Blog” tab in the editor). Posts can be scheduled; Claude can write drafts.
5. **A/B tests** – For each page you can test two versions against each other (the “A/B test” tab) and put the winner live with one click.
6. **Forms** *(Forms & surveys)* – Forms and surveys create contacts and start workflows. Under “Submissions” you see everything that came in.
7. **Form list** – Keep an eye on the submissions: if nothing comes in any more, a form may be broken or may have disappeared from the website.
8. **Online booking** *(Calendar)* – Calendars have a public booking page. – *How to:* Click **Calendar**.
9. **Booking link** – You'll find this link on websites, in e-mails and with the AI phone agent. Don't change it lightly.
10. **Domains** *(Agency → Domains)* – Custom domains: an A record at the domain registrar pointing to the server, HTTPS comes by itself. Important: renew domains in good time!

**What you have learnt:**

- Which websites and funnels exist and how to edit them
- Where the blog and A/B tests are
- Forms and booking pages
- How domains work

More: [Blog & courses](courses.md)

---

## Chapter 7: Courses & community

Online courses, members' area and community groups – access, moderation, members. *(about 15 minutes)*

1. **Courses** *(Courses)* – Courses with modules and lessons. Members learn in the members' area without a password – they get a login link by e-mail.
2. **Course list** – Status, lessons, participants. Open a course to see its content, participants and access.
3. **Members' area** – Address and look of the members' area. Without working e-mail delivery, no login links arrive!
4. **How people get access** – By tag (e.g. kauf:kurs), when buying a product, by workflow or by hand. If the tag is removed, the access is gone.
5. **Community** *(Community)* – Groups with channels, posts, events and a leaderboard in the members' area.
6. **Moderation** – Check regularly for reports: hide or delete posts, or block members. You write posts as the team inside the group.

**What you have learnt:**

- How courses are structured and how members get access
- The members' area (login by e-mail link)
- Community groups and moderation

More: [Community](community.md)

---

## Chapter 8: Revenue

Invoices & quotes, Stripe, products & buy links, accounting with Norman, contracts. *(about 30 minutes)*

1. **Invoices** *(Invoices & quotes)* – At the top: how much is outstanding and how much has been paid. Once a week: chase what is overdue.
2. **The list** – Status per invoice. A blue **Norman** badge means the invoice is already in the accounts.
3. **Quotes & subscriptions** – Customers can accept quotes online. Subscriptions are invoices that repeat automatically – check whether they should all still be running.
4. **Invoice details** *(Settings → Invoices)* – Number range, VAT, payment terms – and very important: bank details and tax number. If the account changes, update it here.
5. **Stripe** *(Settings → Stripe)* – With Stripe, customers pay by card, SEPA or Apple/Google Pay. “Live” means real money, “Test mode” does not.
6. **Check the webhook** – If it says “missing” here, payments are not booked automatically. The instructions are right below it.
7. **Products & buy links** *(Products)* – Services with prices. With Stripe, every product has a buy link (/buy/…), optionally with an order bump, upsell and discount codes.
8. **Accounting with Norman** – Claude transfers paid invoices to Norman (accounting) through the MCP tools – including the receipt. This is handled by the Claude session or your tax adviser; check monthly that all invoices have the Norman badge.
9. **Contracts** *(Contracts)* – Contracts from templates, signed online, with a checksum and log. You can print signed contracts as a PDF at any time.

**What you have learnt:**

- Keeping track of outstanding and paid invoices
- Checking invoice details and Stripe
- Products, buy links and subscriptions
- How invoices get into the accounts (Norman)
- Having contracts signed online

More: [Stripe & payments](stripe.md)

---

## Chapter 9: Reputation

Collecting reviews, connecting the Google profile, replying to reviews. *(about 10 minutes)*

1. **Reviews** *(Reviews)* – Average and distribution. The goal: new reviews regularly – they are the strongest selling point.
2. **Requests** – Send a request after every completed job – ideally automatically, by workflow after the appointment.
3. **Google** – New Google reviews appear here. Reply to every one – including the bad ones, politely and factually.
4. **Widget** – The review widget shows good reviews on the website. Is it embedded? If not, copy the code and paste it into the website.
5. **Connect the Google profile** *(Settings → Reviews)* – With the business profile connected, you reply directly from HyperLevel and publish Google posts.

**What you have learnt:**

- Sending review requests
- Reading and replying to Google reviews
- The review widget

More: [Google reviews](self-hosting.md#google-reviews)

---

## Chapter 10: Service & support

Tickets and SLAs, assignment, support mailbox, knowledge base, satisfaction (CSAT/NPS) and at-risk customers in the health score. *(about 20 minutes)*

1. **Service at a glance** – If the company does customer service, it runs through tickets: every request with a number, an owner and a deadline. When you take over, first clarify: who handles tickets – and which deadlines were promised to customers?
2. **Open tickets** *(Tickets)* – Filter by “Unassigned” and “SLA: Breached”. Whatever is there is the most urgent job – assign it first.
3. **The list** – One click opens the ticket with its history, replies, internal notes, SLA and satisfaction. The “Tickets” tour shows everything step by step.
4. **Overview** *(Tickets → Overview)* – SLA rates, response and resolution times, CSAT and NPS for the last few weeks – so you can see how well service is going right now.
5. **Workload** *(Tickets → Workload)* – Who has how many open, urgent and overdue tickets? If someone is overloaded or leaving, you reassign here.
6. **SLAs & assignment** *(Settings → Service)* – Which deadlines apply per priority, and do only business hours count? “Teams & assignment” shows who gets new tickets – check whether former staff are still in teams.
7. **Support mailbox** – “Email → ticket” shows which e-mails become tickets. The forwarding at the mail provider (e.g. support@…) belongs on the list of accounts too.
8. **Knowledge base** *(Knowledge base)* – Help articles for the public help centre – they also help with replies and the AI assistant. Revise outdated articles (prices, processes) first.
9. **Satisfaction** *(Surveys → Satisfaction (CSAT))* – After every solved ticket, the customer rates it with 1–5 smileys. Read the bad ratings of the last few weeks – and call back if needed.
10. **At-risk customers** *(Contacts)* – The health score combines tickets, reviews, activity, open invoices and deals into a traffic light. Filter by “critical” – these are the customers you call first after the handover.

**What you have learnt:**

- Where customer requests land and who handles them
- Checking SLA deadlines, teams and assignment
- Keeping the knowledge base and help centre up to date
- Measuring satisfaction and spotting at-risk customers

More: [Service: tickets, SLAs & more](helpdesk.md)

---

## Chapter 11: AI

AI assistant in the inbox and chat, AI phone agent and the Claude tools (MCP). *(about 20 minutes)*

1. **AI assistant** *(Settings → AI assistant)* – Claude suggests replies in the inbox, summarises and can answer in the website chat. At the top: on/off, model, usage.
2. **Key & costs** – The Anthropic key runs through the company's Anthropic account – check who owns it and where the invoice goes.
3. **Keeping knowledge up to date** – If prices, services or opening hours change, update them here – otherwise the assistant tells people outdated things.
4. **In the inbox** *(Conversations)* – Suggestions appear next to the thread. Nothing is ever sent automatically.
5. **AI phone agent** *(Settings → Telephony)* – Answers calls, books appointments and takes messages. After every call there is a summary on the contact.
6. **Claude tools (MCP)** *(Agency → API & MCP)* – Through MCP, Claude works directly with HyperLevel: contacts, deals, inbox, blog drafts, reports, accounting. Every change is in the log.
7. **Claude sessions** – Development and larger tasks run in Claude sessions per project (Project → Claude sessions). That is also where you see what was worked on last.

**What you have learnt:**

- What the AI assistant may and may not do
- Keeping knowledge and the limit up to date
- How the AI phone agent works
- How Claude works with the company through MCP

More: [AI assistant](ai-assistant.md)

---

## Chapter 12: Settings & integrations

Channels, telephony, Stripe, integrations catalogue, Zapier/Make/n8n, HubSpot import, OAuth, Todoist, Supabase, Android app, SaaS, white label, domains, snapshots. *(about 45 minutes, agency only)*

1. **A word about secrets** – This applies to all settings: saved passwords, tokens and keys are never shown again. If you need to change one, simply enter the new one – you don't need the old one.
2. **Company details** *(Settings → Company)* – Name, address, phone, e-mail for team notifications – usually the first thing that changes at a handover.
3. **E-mail sending** *(Settings → Email & SMS)* – “Save only” means no e-mail goes out. Check that SMTP is set up and send yourself a test message.
4. **Channels** *(Settings → Channels)* – WhatsApp, Messenger and Instagram via the Meta app. The tokens belong to a system user in the company's Meta Business Manager.
5. **Telephony** *(Settings → Telephony)* – Twilio account and number, forwarding, voicemail, browser phone and AI phone agent.
6. **Stripe** *(Settings → Stripe)* – The sub-account's Stripe account. Access to the Stripe dashboard belongs in the password manager.
7. **Integrations catalogue** *(Apps)* – For each sub-account, the catalogue shows which integrations are set up, incomplete or still open – with a direct route to the setting. Ideal as a checklist when you take over.
8. **Zapier, Make & n8n** *(Settings → API & webhooks)* – Which automation tools are connected to the system? Each subscription shows its source and last response. Pause anything unknown – and clarify who owns the Zapier, Make or n8n account.
9. **Moving over from HubSpot** *(Settings → Import)* – Is the company coming from HubSpot (or GoHighLevel)? This is where you bring the data across – with a dry run, and it can be run more than once. Afterwards, disconnect the HubSpot token again.
10. **Google & Microsoft** *(Agency → Integrations)* – The agency's OAuth apps for calendar sync and the Google profile. They belong to a Google Cloud or Microsoft account of the company.
11. **Mailboxes** – IMAP sync of the mailboxes, with rules for which e-mail goes to which project.
12. **Todoist** – Syncs tasks with Todoist – runs with the Todoist account whose token is stored here. If that changes: enter the new token.
13. **Supabase mirror** – Mirrors data into a Supabase database for other projects. Not used? Just leave it off.
14. **App for your phone** *(Settings → My account)* – The Android app brings the inbox, tasks, figures and widgets to your phone (QR code under “Get the app”, paired phones under “Devices (app)” – sign out unknown ones). On iPhone and iPad, HyperLevel runs as a web app from the home screen, with notifications and a badge on the icon.
15. **SaaS mode** *(Agency → SaaS)* – Sells HyperLevel to customers as a subscription – with the agency's own Stripe. Check the running customer subscriptions.
16. **White label** *(Agency → White label)* – Name, logo, colour, login texts and **Support email** – you should change these to yourself when you take over.
17. **Domains** *(Agency → Domains)* – All domains with their status. The domains themselves are held at the domain registrar – put the expiry dates in your calendar!
18. **Snapshots** *(Agency → Snapshots)* – Starter packs for new clients. Export your most important snapshots once as a file – that also backs up your templates.

**What you have learnt:**

- Which integrations exist and where they are set up
- That secrets are never shown again – only replaced
- Checking automation tools, imports and paired phones
- Agency-wide settings: white label, domains, SaaS, snapshots

More: [Operations & integrations](self-hosting.md)

---

## Chapter 13: Operations

Backups, the log, the weekly server resources routine and what to do when a website is down. *(about 20 minutes, agency only)*

1. **Backups** *(Settings → Sub-accounts)* – Automatic every day; the last 14 stay on the server. Download one now and keep it in a second place – repeat monthly. – *How to:* Click **Download now**.
2. **What is in the backup** – The complete database (all sub-accounts, contacts, invoices …). Images and uploads are also in the server's data folder – the server provider backs those up too.
3. **The log** *(Agency → Log)* – Every change with time, person and route (interface, API, MCP). If something has changed “by itself”, this is where you find the cause.
4. **Weekly server routine** – Once a week (10 minutes): 1) Is the last backup from today? 2) Are all websites green? 3) In the server panel (e.g. Hostinger → VPS), look at CPU, memory and disk space – over 80 % disk means: clear out old backups/logs or upgrade the plan. 4) Are there any warnings from the domain or server provider?
5. **Website down – step 1** *(Agency → Projects)* – A red dot means: the website is not responding. Open it yourself in the browser (also on your phone without Wi-Fi) – perhaps it was only brief.
6. **Website down – step 2** – If it continues: check at the domain registrar that the domain is paid for and the A record points to the server. Then check in the server panel that the server is running – restart it if necessary.
7. **Website down – step 3** – If that doesn't help: open the project's Claude session (Ctrl+K → “Claude: …”) and describe what you see. Let customers know briefly – honestly and with a time estimate.
8. **Alerts to your phone** *(Settings → My account)* – With push, you find out immediately when a website goes down – and when it is back up.
9. **Updates** – New versions of HyperLevel are installed by a developer or by Claude (see the Claude session). Always make a backup first; database changes run automatically at start-up.

**What you have learnt:**

- Downloading backups and storing them safely
- Using the log to see who changed what
- The weekly server routine
- The emergency plan for a website that is down

More: [Backup](backups.md)

---

## Chapter 14: Final checklist

Tick everything off: access, sending, payments, backups, websites, automations – then the company is taken over. *(about 15 minutes, agency only)*

1. **The handover status** *(Academy)* – Go through the open items from top to bottom. Each item links to where it gets done.
2. **☐ Access** – All passwords in the password manager, 2FA for all admins, old accounts, keys and unknown phones (app devices) removed, accounts with domain, server, payment and AI providers switched over to you.
3. **☐ Sending** – E-mail sending set up and checked with a test message; SMS/WhatsApp too, if used.
4. **☐ Money** – Bank details and tax number on invoices are correct, Stripe webhook set up, subscriptions checked, accounting (Norman) up to date.
5. **☐ Operational safety** – A backup is kept off-site, all websites are green, domains renewed, the weekly server routine is in the calendar.
6. **☐ Automation** – You know all active workflows, scheduled campaigns/posts, reports by e-mail and the Zapier, Make or n8n subscriptions. Whatever should no longer apply is paused.
7. **☐ Service** – Open tickets are assigned, SLA targets and teams are right, the support mailbox forwards to HyperLevel and the help articles are up to date.
8. **☐ Clients & team** – Support e-mail and sender changed to you, team informed, most important clients contacted personally.
9. **The handbook** *(Academy → Handbook)* – Print the handbook or save it as a PDF – for the folder in the office.
10. **Done!** *(Academy)* – You have taken over the company. 🎉 The module tours stay available for reference – and the **?** at the top right helps on every page.

**What you have learnt:**

- All accounts belong to you and are secured
- Sending, payments and backups work
- You know what happens automatically and where to look
- The handbook is printed and ready

More: [Handbook](handbook.md)

---

## Appendix: All module tours

Besides the complete guide, every area has a short tour (5–15 steps). You will find them in the Academy or via the **?** at the top right of every page.

### Getting started

- **Finding your way around** (10 steps, about 5 min.) – Menu, project switcher, search, Ctrl+K and the “?” – the interface in five minutes.
- **The Academy & the practice company** (7 steps, about 4 min.) – Complete guide, module tours, badges, handover status and the handbook.
- **Undo, history and bin** (8 steps, about 3 min.) – Every change can be undone: the notice after the change, Ctrl+Z, history and bin.
- **Bug reports & wish list** (15 steps, about 4 min.) – Report a bug with a screenshot, read replies under “My reports” and vote for new features.

### Course: Run your company

- **Company setup: branding, team, permissions, tax details** (6 steps, about 15 min.) – Company details, logo and colours, tax and invoice details, your team with the right permissions – the foundation for everything else.
- **Sales: pipeline, lead scoring, sequences, quotes** (6 steps, about 15 min.) – From prospect to customer: a pipeline that fits your sales process, lead scoring, personal sequences and quotes with signature.
- **Marketing: funnels, forms, e-mail, social, attribution** (6 steps, about 15 min.) – Landing page and waitlist, forms with double opt-in, newsletter, social planner and the question of which channel really brings customers.
- **Customer service: inbox, helpdesk, SLAs, knowledge base** (6 steps, about 15 min.) – All channels in one inbox, tickets with SLAs, a knowledge base that answers questions before they are asked.
- **Finance: invoices, SEPA, dunning, DATEV, profit calculator** (6 steps, about 20 min.) – Invoices with XRechnung/ZUGFeRD, SEPA direct debit, automatic dunning, DATEV export, light bookkeeping and the profit calculator for your pricing.
- **Projects & time** (6 steps, about 10 min.) – Tasks, projects, recurring routines and time tracking – so your roadmap and your week do not live in your head.
- **AI employees & automation** (6 steps, about 15 min.) – Workflows that take routine work off your plate, and AI agents with clear boundaries: drafts, approvals, audit log – nothing goes to customers unchecked.
- **Metrics & weekly routine** (6 steps, about 15 min.) – The CEO cockpit with MRR, ARR, trials, conversion, churn, sources and SLAs – and a weekly review in 30 minutes.
- **Privacy & compliance: GDPR, DPA, retention, GoBD** (6 steps, about 15 min.) – Consents with proof, data processing agreements, retention periods and immutable records – what the app handles and what you must arrange yourself.
- **Scaling: team, roles, snapshots, agency mode** (6 steps, about 15 min., agency) – When things grow: roles instead of individual permissions, templates instead of manual work, agency mode for partners – and when to hire instead of automate.

### Clients & daily business

- **Reading the dashboard** (7 steps, about 3 min.) – Key figures, new contacts, appointments, pipeline and lead sources at a glance.
- **Project profile & website monitoring** (11 steps, about 5 min.) – Status, website check every 10 minutes, goals, documents, Claude sessions and server notes per project.
- **Inbox: all messages in one place** (7 steps, about 5 min.) – E-mail, SMS, chat, WhatsApp, Messenger, Instagram and calls – read, filter, reply.
- **Calls & browser phone** (7 steps, about 4 min.) – Call list, missed calls, voicemails, calling back and phoning straight from the browser.
- **Calendars & online booking** (9 steps, about 6 min.) – See appointments, create calendars with a booking page, set availability and reminders.
- **Calendar sync with Google & Outlook** (7 steps, about 4 min.) – Connect your own Google or Outlook calendar so nothing gets double-booked.
- **Managing contacts** (13 steps, about 7 min.) – Search, filter, create, add tags, read the history, import and export.
- **Pipeline & deals** (10 steps, about 5 min.) – Drag deals as cards through the stages, keep values up to date, mark them won/lost.
- **Tasks** (7 steps, about 3 min.) – Create to-dos, give them a due date, tick them off – on the contact too.
- **Power dialler: working through call lists** (7 steps, about 6 min.) – Turn smart lists or tags into a call list, call contact after contact, record the outcome, arrange call-backs – while consent, “Do not disturb” and calling hours are respected automatically.
- **Team inbox: assign, snooze, add notes** (13 steps, about 7 min.) – Who does what: views, assignees, status, snoozing, internal notes, response deadlines and the rules for new conversations.
- **Team calendars: round robin, questions, payment, video** (13 steps, about 8 min.) – Distribute bookings across the team, ask questions, take payment at booking, create video links and use routing forms.
- **Project planning: projects, board & Gantt** (15 steps, about 8 min.) – Plan projects with tasks, subtasks and dependencies – as a list, board, calendar or Gantt chart.
- **Time tracking: timer, timesheets, billing** (14 steps, about 6 min.) – Record time with a timer or afterwards, approve weeks, analyse reports and turn them into invoices.
- **Reports & dashboards** (11 steps, about 7 min.) – Dashboard from a template, period and filters, sharing, sending by e-mail – and building your own reports.
- **Companies** (12 steps, about 6 min.) – Company list with views, automatic matching by e-mail domain, the company page with links – and merging duplicates.
- **Custom objects & associations** (14 steps, about 7 min.) – Your own record types such as vehicles or contracts: object builder, records and associations with labels.
- **Properties & groups** (12 steps, about 5 min.) – Custom fields for contacts, companies, deals and custom objects – in groups, with type and help text – and the labels for associations.
- **Wiki: capturing knowledge in the team** (12 steps, about 7 min.) – Pages in spaces and levels, with live cards from the CRM, checklists, comments, history and a sharing link.
- **Team chat: quick coordination** (9 steps, about 6 min.) – Channels, direct messages and threads – with cards from the CRM, commands such as /aufgabe and the AI agent.
- **Living Boards: your workspace, the way you want it** (12 steps, about 7 min.) – Put together your own start page from building blocks – by dragging, or by telling the board what you want to see – with history and undo.
- **Sequences: reaching new customers in several steps** (11 steps, about 7 min.) – From your own mailbox: e-mails, tasks and calls with waiting times – and it stops as soon as someone replies.
- **Quotas, duplicates and access** (10 steps, about 8 min.) – Targets and a leaderboard for the team, cleanly merging duplicate contacts and deciding who sees which records.

### Marketing

- **Campaigns & newsletters** (11 steps, about 7 min.) – E-mail or SMS newsletters to tags or smart lists – with test sends and scheduling.
- **E-mail marketing: segments, tests & deliverability** (13 steps, about 8 min.) – Ready-made templates, audiences by behaviour, A/B tests, best-time sending and deliverability – for more opens and fewer spam folders.
- **E-mail designer** (10 steps, about 6 min.) – Beautiful e-mails by drag & drop: sections, blocks, phone preview, test e-mail.
- **Automations (workflows)** (11 steps, about 8 min.) – Trigger → actions: send e-mails automatically, set tags, create tasks, wait, branch.
- **Social Planner** (5 steps, about 4 min.) – Schedule posts for Instagram, Facebook, LinkedIn & co. – in a monthly calendar.
- **Video studio** (8 steps, about 5 min.) – AI-picked shorts with subtitles from long videos – review, adjust and schedule them in the Social Planner.
- **Attribution & advertising** (9 steps, about 6 min.) – Where leads and revenue come from – UTM, campaigns, funnels – plus cost per lead and ROAS from Meta/Google Ads.
- **Affiliates (partner programme)** (8 steps, about 5 min.) – Partners recommend you with their own link – approve and pay out commissions.
- **Workflows: finding and configuring steps** (12 steps, about 6 min.) – Over 130 actions and over 140 triggers: picker with search and help, forms per step, triggers by topic and filters for every trigger.
- **Workflows: testing, versions and sharing** (9 steps, about 5 min.) – Test with sample data, read the log for each step, publish drafts, restore versions and exchange workflows as JSON.
- **Lead scoring: MQL & SQL** (12 steps, about 7 min.) – Points for matching properties and activity, thresholds such as MQL and SQL, decay – and the score on the contact and in the contact list.
- **Canvas: draw, plan, design** (15 steps, about 8 min.) – Infinite boards with shapes, arrows, notes and designs – with live cards from the CRM, AI drawing and working together.
- **Ads: Meta & Google** (15 steps, about 8 min.) – Create, review and manage campaigns on Facebook, Instagram and Google directly in HyperLevel – everything starts paused, and money is only spent after your confirmation.
- **Webinars: automated sign-ups and sales** (15 steps, about 8 min.) – Play a video at the scheduled time, collect sign-ups, send reminders, show questions and an offer – and see who attended and for how long.
- **Comment-to-DM on Instagram and Facebook** (9 steps, about 6 min.) – Reply publicly to a keyword in a comment, send the link privately and create the contact.
- **“Receive webhook” in workflows** (10 steps, about 6 min.) – Accept data from shops, Typeform & co. by webhook: secret URL, test data, field mapping and signature.

### Websites, courses & community

- **Building funnels & websites** (13 steps, about 8 min.) – Landing pages and whole websites from blocks – with live preview, SEO and your own domain.
- **Website builder: templates, sections & design** (9 steps, about 9 min.) – Start from one of 23 templates, drag in sections with columns, fine-tune for phone and tablet, set colours and the header once for the whole website.
- **Collections, redirects, accessibility & statistics** (9 steps, about 8 min.) – Keep the team, projects or products as a collection, redirect old addresses, check the page for accessibility and see for each step where visitors drop off.
- **Writing the blog** (6 steps, about 5 min.) – Posts in Markdown with a cover image – draft, scheduled or published, with RSS and sitemap.
- **A/B tests** (5 steps, about 5 min.) – Test two versions of a page against each other – with a goal, a split and the winner in one click.
- **Forms & surveys** (14 steps, about 8 min.) – Build fields, send leads to the CRM, start workflows, embed – also question by question, with scores and ready-made templates.
- **Courses & members' area** (14 steps, about 9 min.) – Online courses with your own video, modules and lessons – access by tag, purchase, workflow or by hand; learning paths, cohorts, discussion and analytics.
- **Community** (15 steps, about 10 min.) – Groups with channels, posts, events, points and a leaderboard – with a public join page, paid tiers, statistics, challenges, live calls and messages.
- **Quizzes, assignments and certificates** (10 steps, about 8 min.) – Test knowledge, review assignments and issue certificates with a PDF and a verification page.

### Revenue

- **Invoices & quotes** (15 steps, about 7 min.) – Write an invoice, finalise it, send it as PDF/XRechnung, record payments, cancel – GoBD-compliant, with quotes and subscriptions.
- **Products & buy links** (7 steps, about 5 min.) – Create services with prices – and sell them with Stripe as a /buy/… page, including order bump and upsell.
- **Connecting Stripe & order bumps** (5 steps, about 5 min.) – Online payment by card, SEPA, Apple/Google Pay – keys, webhook, test mode, order bump and upsell.
- **Signing contracts online** (5 steps, about 4 min.) – Templates with placeholders, a link for signing, checksum and log.
- **Light bookkeeping: receipts, entries, DATEV** (14 steps, about 8 min.) – Collect receipts, prepare entries, reconcile the bank and hand everything to the tax adviser – without replacing certified software.
- **Inventory & purchasing** (11 steps, about 6 min.) – Items, stock and locations, minimum stock with warnings, supplier orders, stocktaking and inventory valuation.
- **Profit calculator: what is left over?** (15 steps, about 8 min.) – Enter prices, customer numbers, costs and taxes and see straight away what is left after everything – with a table, break-even, forecast and scenarios.
- **Instalments: customers pay in instalments** (8 steps, about 5 min.) – Attach an instalment plan to a product, offer it on the buy page and see how far each customer has paid.
- **Dunning: failed payments and overdue invoices** (14 steps, about 8 min.) – Catch failed subscription payments, chase overdue invoices and let customers manage their own subscriptions.
- **SEPA: direct debit without a payment provider** (12 steps, about 7 min.) – Collect mandates, collect open invoices by direct debit, record returned debits and create credit transfer files for suppliers.
- **Quotes: from deal to signature** (11 steps, about 8 min.) – Line items on the deal, a quote with options and a deposit, online signature and invoice.
- **Accounting: Lexware Office & sevDesk** (6 steps, about 4 min.) – Finalised invoices go to Lexware Office or sevDesk by themselves, incoming payments come back – and won deals go to Google Ads if you want.

### Reputation

- **Collecting reviews** (7 steps, about 4 min.) – Send review requests: 4–5★ go to Google, criticism stays internal – plus a widget for the website.
- **Google Business Profile** (5 steps, about 4 min.) – Connect the profile: all reviews, reply directly, publish Google posts.

### Service & support

- **Tickets: handling customer requests** (14 steps, about 8 min.) – Filter, views, creating a ticket, replying or adding notes, keeping the SLA in view – and the team's overview and workload.
- **Knowledge base & help centre** (11 steps, about 6 min.) – Write help articles in categories, publish them and show them in the public help centre – also as suggestions when replying.
- **Surveys (CSAT & NPS) and health score** (9 steps, about 6 min.) – Satisfaction after solved tickets, recommendation via NPS survey and the customer traffic light built from all signals.
- **Setting up service: SLAs, teams & assignment** (12 steps, about 10 min.) – SLA targets and business hours, ticket pipelines, teams and assignment rules, e-mail → ticket, replies, CSAT, portal and health score.

### AI

- **Analysing conversations: summary, tasks, scorecards** (9 steps, about 6 min.) – Transcribe and analyse recorded calls and meeting recordings: summary, tasks, sentiment, talk ratio, filler words – and rate them with scorecards.
- **Setting up the AI assistant** (10 steps, about 6 min.) – Claude suggests replies, summarises and looks after the website chat – with its own key and a monthly limit.
- **AI phone agent** (6 steps, about 5 min.) – Claude answers calls, books appointments, takes messages and transfers calls.
- **Connecting AI tools (Codex, ChatGPT, Claude)** (10 steps, about 5 min.) – Codex, Claude Code, Cursor, ChatGPT and Claude.ai work directly with HyperLevel – with their own key or by signing in (OAuth).
- **Claude tools (MCP)** (5 steps, about 4 min., agency) – Claude & co. work directly with HyperLevel: contacts, deals, inbox, blog drafts, reports.
- **The AI agent** (10 steps, about 5 min.) – An AI employee on every page: searches, summarises, creates records and gets tasks done – with confirmation before any change.
- **AI providers (BYOK)** (8 steps, about 4 min.) – Any model with your own key: OpenAI, Anthropic, Gemini, OpenRouter, Groq, local models, fal.ai, kie.ai and more.
- **AI Studio: build apps in the chat (beta)** (5 steps, about 3 min.) – With your own Claude, OpenAI or OpenRouter key, build small apps and websites in the chat, check them in the preview and publish them at their own address.
- **AI studio: images, videos & voice** (12 steps, about 5 min.) – Generate images, videos, music and speech with your own AI provider (fal.ai, kie.ai, Replicate, OpenAI, Gemini, ElevenLabs …) – with any model.
- **Werkstatt: have wishes built** (15 steps, about 6 min.) – A wish becomes a plan and, after your confirmation, a setup or a plugin of your own – at first just for you.
- **Marketplace: discovering and installing plugins** (8 steps, about 4 min.) – Plugins with categories, search, live preview and ratings – installed with a clear list of permissions.
- **Voice & speech recognition** (10 steps, about 6 min.) – Your own voice for the phone agent and AI agent, a microphone button, voicemail as text – with your provider (ElevenLabs, OpenAI, Deepgram, local …).
- **Building workflows with AI** (8 steps, about 5 min.) – Describe a process in everyday language, review the suggestion and save it as a draft.

### Settings & channels

- **Phone menu, schedules and queues** (9 steps, about 7 min.) – Greet callers with an announcement, route them by keypress, respect opening hours and public holidays, ring groups and queues – and test the flow beforehand.
- **Buying and assigning numbers, and calls by source** (5 steps, about 6 min.) – Buy and release phone numbers at Twilio, give each number a destination, tracking numbers per campaign and pool numbers for the website – with call reports by source.
- **Connecting a mailbox: Gmail & Outlook** (12 steps, about 5 min.) – Connect Gmail or Outlook directly: e-mails in the inbox, reply from HyperLevel in the same thread, archive, labels, drafts and scheduled sending.
- **Spatial mode and XR: working with gaze, pinch and headset** (9 steps, about 5 min.) – Large targets for Vision Pro, Quest and Android XR, four pages side by side on the headset's giant screen – and boards as floating panels in the room.
- **Securing your account** (6 steps, about 4 min.) – Password, two-factor sign-in, signed-in devices and light/dark.
- **Customising the look** (11 steps, about 5 min.) – Theme, accent colour, area colours, narrow sidebar, icon pack and which areas appear in the menu.
- **App & push notifications** (5 steps, about 3 min.) – Install HyperLevel as an app and get push notifications for messages, website outages, tasks and payments.
- **Settings: the basics** (11 steps, about 7 min.) – Company details, e-mail and SMS sending, invoice details, custom fields & tags, API.
- **Consent & legal** (11 steps, about 8 min.) – Collect consent with proof, cookie banner, legal texts and an order page under German law – as a draft, not as legal advice.
- **Channels: WhatsApp, Messenger, Instagram** (5 steps, about 5 min.) – Connect the Meta app so that WhatsApp, Messenger and Instagram messages land in the inbox.
- **More channels: Telegram, Discord, Slack, push** (7 steps, about 6 min.) – Connect a Telegram bot, a Discord community, Slack for the team and browser push to contacts.
- **Telephony & browser phone** (5 steps, about 6 min.) – Connect Twilio, forwarding, business hours, voicemail – and phoning in the browser.
- **Website chat** (5 steps, about 3 min.) – A chat bubble for every website – messages land in the inbox, and the AI assistant can reply if you want.
- **Team & access** (6 steps, about 4 min., agency) – Create staff and client logins, grant rights per area, reset 2FA.
- **Your cloud account** (11 steps, about 5 min.) – Hosted accounts only: plan and invoices, team, usage, data export and deleting the account.
- **Switching over: from your previous tool to here** (14 steps, about 7 min.) – Bring over contacts, deals, tickets, projects, wiki pages, tables, forms, appointments and more from 24 tools – from Mailchimp to sevDesk – with preview, dry run and undo.
- **Checking e-mail deliverability** (9 steps, about 5 min.) – Check SPF, DKIM, DMARC and MX of your sender domain and copy the missing DNS records with instructions in German – so campaigns don't end up in spam.
- **Knowledge memory (Cognee)** (9 steps, about 5 min.) – Query a knowledge graph built from the wiki, notes, tickets & co. – only with what your sub-account explicitly shares, with redaction and deletion.
- **Integrations catalogue & apps** (7 steps, about 4 min.) – What is connected and what else is possible: all integrations with status, instructions and a direct route to setting them up.
- **Composio: connecting 250+ apps** (9 steps, about 6 min.) – Connect Slack, HubSpot, Shopify, Google Sheets & co. via Composio, use them in workflows, receive app events and make them available to AI & MCP.
- **Nango: apps with your own OAuth apps** (7 steps, about 5 min.) – Connect hundreds of APIs via Nango – the agency sets up one OAuth app per provider once, sub-accounts just click “Connect”.
- **External MCP servers as tools** (8 steps, about 6 min.) – Connect GitHub, Notion, Linear, Zapier & co. via MCP: approve tools, use them in workflows and in the AI agent, pass them on to Claude and Codex.
- **Zapier, Make & n8n (REST hooks)** (7 steps, about 5 min.) – API key per tool, instant triggers via REST hook, delivery log and the API reference.
- **Moving over from HubSpot** (8 steps, about 5 min.) – Fetch contacts, companies, deals, notes, tasks, activities and tickets from HubSpot – with a dry run and progress.
- **App for your phone & widgets** (7 steps, about 4 min.) – Install and pair the Android app, manage paired devices, widgets and notifications.
- **iPhone & iPad: HyperLevel as an app** (9 steps, about 4 min.) – Add to the home screen, turn on notifications and the badge on the icon, iPad view and keyboard shortcuts.

### Agency & operations

- **People: holidays, absences, staff** (13 steps, about 7 min.) – Request and approve holidays, team calendar, staff records with protected salary fields and checklists for joiners and leavers.
- **Agency overview** (7 steps, about 5 min., agency) – All projects with key figures and website status, cross-project contacts, deals, tasks and documents.
- **Clients & snapshots** (5 steps, about 4 min., agency) – New clients in seconds: a sub-account from a starter pack, client login, your own branding.
- **SaaS mode** (5 steps, about 5 min., agency) – Sell sub-accounts as a subscription: plans, sign-up page, limits, payments via the agency's Stripe.
- **Cloud operations** (12 steps, about 7 min., agency) – Running the hosted version: key figures, customers, prices, fair use, failed payments, Stripe and legal texts.
- **White label & domains** (7 steps, about 5 min., agency) – Your own name, logo, colour and app domain – and domains for client websites.
- **Sign-in: SSO, passkeys & rules** (7 steps, about 6 min., agency) – How the team and clients sign in: Google, Microsoft, GitHub, Apple, your own SSO provider, passkeys, e-mail link – with rules for new accounts and 2FA.
- **Integrations: OAuth, mailboxes, Postiz** (5 steps, about 5 min., agency) – Google/Microsoft apps for calendars & the Google profile, IMAP mailbox sync and the Social Planner.
- **Todoist sync** (5 steps, about 3 min., agency) – Sync the tasks of all projects with your Todoist in both directions.
- **Supabase mirror** (5 steps, about 3 min., agency) – Projects, contacts, deals, tasks, invoices and documents continuously into your Supabase.
- **Operations: backups, log, incidents** (6 steps, about 6 min., agency) – Take backups, read the log, check server resources – and what to do when a website is down.
- **Partner links** (5 steps, about 2 min., agency) – “Create account” links to providers: replace partner links, switch them off individually or entirely, and see clicks.
