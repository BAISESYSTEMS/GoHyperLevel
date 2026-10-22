# Company playbook: running your company on HyperLevel

*We are our own first customer.* This playbook is the long-term operating manual for a small software company that runs
itself on HyperLevel (today still called HyperLevel in the app) – written for the founder of a German GmbH or sole
proprietorship selling HyperLevel Cloud (Solo 49,99 €, Team & Company 99,99 €, Agency 199 € per month; self-hosting is
free) in the DACH market. It works just as well for any small SaaS.

It has three parts that belong together:

- the template **„Software- & SaaS-Firma (HQ)“** – the building blocks, loaded into a sub-account in one click
  ([what it contains](#the-hq-template)),
- the Academy course **„Deine Firma mit HyperLevel führen“** – ten lessons with a 10-minute task each
  ([printable version](kurs-firma-fuehren.md)),
- this playbook – the routines, numbers and decisions for the years after.

> **Hinweis:** Dieses Playbook ersetzt keine Beratung. Steuerliche Fragen (Rechtsform, Umsatzsteuer, Buchführung,
> Aufbewahrung) gehören zu deiner Steuerberaterin oder deinem Steuerberater, rechtliche Fragen (AGB, AVV, Datenschutz,
> Arbeitsverträge) zu einer Anwältin oder einem Anwalt. Alle Zahlen hier sind Faustregeln, keine Zusagen.

## Quick start (one afternoon)

1. Create a sub-account for your own company (*Einstellungen → Sub-Accounts*), e.g. „HyperLevel GmbH“.
2. *Agentur → Snapshots → Vorlagen von …* → **Software- & SaaS-Firma (HQ)** → *In Sub-Account laden*. Workflows arrive
   as drafts, help articles as drafts.
3. Work through lesson 1 of the course (*Akademie → Kurs: Deine Firma führen*): company data, tax data, team, 2FA.
4. Connect e-mail sending, read the template's mails once, dry-run the workflows, then activate them.
5. Point the landing page at the waitlist form ([landing page](#landing-page-waitlist-dogfooding)) and, on the cloud
   instance, set `PGHL_HQ_LOCATION` ([cloud bridge](#cloud--hq-crm-bridge)).

## Which area handles what

Each heading is one lesson of the course; the lesson walks you through the screens.

### 1. Company setup

*Einstellungen → Firma, Rechnungen, Team, Mein Konto.* Legal name with legal form, address, logo, tax number or VAT ID,
bank account, invoice numbering, small-business rule (Kleinunternehmer) yes/no. One login per person, rights per area,
2FA for every admin. Lesson: [Firmen-Setup](kurs-firma-fuehren.md#lektion-1-firmen-setup-branding-team-rechte-steuerdaten).

### 2. Sales

*Opportunities, Lead-Scoring, Vertrieb.* The pipeline **Kunden (Cloud)** is your customer lifecycle: Warteliste →
Testphase → Kunde → Gekündigt / Rückgewinnung; **Agentur-Partner** and **Presse & Influencer** track the two channels
that compound. Lead scoring tells you whom to call first, sequences send personal follow-ups that stop on reply, quotes
carry an online signature. Lesson: [Vertrieb](kurs-firma-fuehren.md#lektion-2-vertrieb-pipeline-lead-scoring-sequenzen-angebote).

### 3. Marketing

*Funnels, Formulare, Kampagnen, Social Planner, Attribution.* One landing page with one promise and the waitlist form
(Double-Opt-in), a weekly newsletter, social posts planned a week ahead, and attribution to see which source brings
customers, not just leads. Lesson: [Marketing](kurs-firma-fuehren.md#lektion-3-marketing-funnels-formulare-e-mail-social-attribution).

### 4. Customer service

*Konversationen, Tickets, Wissensdatenbank, Einstellungen → Service.* Conversations for quick answers, tickets for
anything with a deadline. The support form creates tickets; the SLA workflows warn before a deadline and mark a breach.
Every question that comes twice becomes a help article. Lesson: [Kundenservice](kurs-firma-fuehren.md#lektion-4-kundenservice-posteingang-helpdesk-slas-wissensdatenbank).

### 5. Finance

*Rechnungen, SEPA, Mahnwesen, Buchhaltung, Gewinnrechner.* E-invoices (ZUGFeRD/XRechnung), SEPA direct debit without a
payment provider, dunning with your approval for the last step, receipts and bank matching, the monthly DATEV export for
your tax advisor, and the profit calculator to test prices against real costs. Lesson: [Finanzen](kurs-firma-fuehren.md#lektion-5-finanzen-rechnungen-sepa-mahnwesen-datev-gewinnrechner).

### 6. Projects & time

*Aufgaben, Projekte, Zeit.* The template's project **CEO-Routinen** holds the recurring tasks of this playbook. Keep a
second project „Roadmap“ (Ideen → Geplant → In Arbeit → Fertig). Track time for one week per quarter to see where your
hours go. Lesson: [Projekte & Zeit](kurs-firma-fuehren.md#lektion-6-projekte--zeit).

### 7. AI employees & automation

*Automationen, KI-Agenten.* Dry-run every workflow before activating it. AI agents get only the tools they need; they
write drafts, people send. Set a cost limit, read the log weekly, send customer data only to providers with a DPA
(AVV). Lesson: [KI-Mitarbeiter & Automatisierung](kurs-firma-fuehren.md#lektion-7-ki-mitarbeiter--automatisierung).

### 8. KPIs & weekly routine

*Berichte → CEO-Cockpit (SaaS).* MRR, ARR, active subscriptions, running trials, lead → customer, cancellations, leads
per source, support SLA. Schedule it by e-mail for Monday 8:00. Targets: [KPIs](#kpis-and-target-ranges). Lesson:
[Kennzahlen & Wochen-Routine](kurs-firma-fuehren.md#lektion-8-kennzahlen--wochen-routine).

### 9. Privacy & compliance

*Einstellungen → Einwilligung & Recht, Protokoll, Buchhaltung.* Double-Opt-in with proof, versioned consent texts,
cookie banner, imprint and privacy policy; a list of every processor with a DPA; retention periods; GoBD: finalised
invoices and bookings are immutable, corrections go through cancellation and credit notes. You still write your own
procedure documentation (Verfahrensdokumentation). Lesson: [Datenschutz & Compliance](kurs-firma-fuehren.md#lektion-9-datenschutz--compliance-dsgvo-avv-aufbewahrung-gobd).

### 10. Scaling

*Einstellungen → Team, Agentur → Snapshots, Agentur → Kunden.* Rights by role (support, sales, bookkeeping), your own
improved HQ saved as a snapshot, agency partners with their own sub-accounts. Lesson: [Skalieren](kurs-firma-fuehren.md#lektion-10-skalieren-team-rollen-snapshots-agentur-modus).

## Routines

The template creates these as recurring tasks in the project **CEO-Routinen**; adjust days and times to your week.

### Daily (15 minutes)

1. Tickets with SLA at risk (*Tickets*, sort „SLA zuerst“) – answer or reassign.
2. New conversations – answer, or turn into a task.
3. Tasks due today, including the workflow tasks (trial check-in calls, demo requests).
4. Trials on day 3, 7 and 12 – a short personal note beats another automated mail.

### Weekly (Monday, 30 minutes – the CEO review)

1. **Numbers (10 min):** open the CEO cockpit. MRR vs. last week, new trials, trial → customer, cancellations, SLA rate.
2. **Three observations:** what changed, and why? Write them into the task.
3. **Customers:** every cancellation reason of the week, every SLA breach.
4. **Three decisions** for the week – not ten.

Friday: roadmap round – contacts tagged `roadmap:wunsch`, the „Feature-Wunsch“ submissions, top 3 into the roadmap
project, a reply to everyone who asked.

### Monthly (first working days)

- Invoices: open items, dunning levels, failed payments (tag `zahlung:offen` from the cloud bridge).
- Bookkeeping: receipts complete, bank matched, DATEV export to your tax advisor; VAT return if you file monthly.
- KPIs of the month into the wiki (one page per month): MRR, net new MRR, churn, trial → paid, CAC by channel.
- Publish one help article from the questions of the month; clean up tags and duplicates.

### Quarterly

- Prices and plans: update the profit calculator with real costs, compare to churn reasons and win/loss notes.
- Channels: cost per customer per source (attribution) – double down on one, stop one.
- Goals for the next quarter (three, measurable), roadmap themes.
- Access review: team rights, admins with 2FA, API keys and AI agents nobody uses any more.
- Restore test of a backup (self-hosted) or a data export (cloud).

### Yearly

- Annual accounts with your tax advisor; check the legal form (sole proprietor → GmbH) with them when profit grows.
- Review processors and DPAs, retention and deletion, consent texts, imprint, terms and privacy policy.
- Insurance (liability, cyber), contracts with freelancers, domain and certificate renewals.
- Write the year's lessons into the wiki and save the HQ sub-account as a new snapshot.

## KPIs and target ranges

Rules of thumb for an early SaaS selling to small businesses (first 1–3 years). Look at trends, not single weeks; with
fewer than ~30 customers every percentage is noise.

| KPI | Where in the app | Healthy range | Act when |
| --- | --- | --- | --- |
| MRR growth (month over month) | CEO cockpit: MRR | 10–20 % in year one, 5–10 % later | below 5 % for two months |
| Waitlist → trial | Pipeline *Kunden (Cloud)* | 20–40 % of confirmed sign-ups | below 15 % – invite faster, sharpen the promise |
| Trial → paid | Cockpit: Lead → Kunde, pipeline | 15–25 % without card, 40–60 % with card upfront | below 10 % – onboarding, not marketing |
| Activation (setup done within 3 days) | Trial check-in tasks, notes | more than 50 % | below 30 % – fix the first ten minutes |
| Logo churn per month | Cockpit: Kündigungen | below 3 % | above 5 % – read every reason this week |
| Net revenue retention | Subscriptions (MRR per cohort) | above 100 % | below 90 % |
| LTV : CAC | Profit calculator, attribution | above 3 : 1 | below 2 : 1 |
| CAC payback | Profit calculator | below 12 months | above 18 months |
| First response (support) | Cockpit: support table | within 8 business hours | SLA rate below 95 % |
| Gross margin | Bookkeeping reports | above 75 % | below 65 % – hosting, AI and support costs |
| Runway | Bookkeeping, bank | more than 12 months | below 6 months – cut costs or raise money now |

## When to hire or automate

Automate first when a task is **repetitive, rule-based and harmless when it goes wrong once** – welcome and onboarding
mails, tagging, task creation, reminders, reports. Keep human what builds trust: cancellations, complaints, pricing
exceptions, anything legal.

Hire when:

- a non-automatable task takes **more than 10 hours a week** for two months in a row (track it with time tracking),
- the SLA rate stays below 95 % although the help center answers the common questions → first hire: **support**,
- you turn away demos or partners because there is no time → next: **sales / partner management**,
- month-end takes more than two days → hand bookkeeping preparation to an assistant or your tax advisor's office.

Before hiring, write the routine into the wiki (what, how often, which screens, what „done“ means) and create a role
with exactly the rights it needs. Freelancers first, employees when the work is permanent – and let your tax advisor or
lawyer check the contract (Scheinselbstständigkeit is a real risk in Germany).

## The HQ template

*Agentur → Snapshots → Vorlagen* (`POST /api/snapshot-templates/saas-hq/apply`, admins; data in
`server/services/hq-template.ts`, mails in `server/services/hq-template-mails.ts`). It loads once per sub-account
(a second load needs `again: true`); a fresh sub-account's empty default pipeline is replaced.

| Part | Contents |
| --- | --- |
| Pipelines | **Kunden (Cloud)**: Warteliste → Testphase → Kunde → Gekündigt / Rückgewinnung · **Agentur-Partner** · **Presse & Influencer** |
| Fields | Tarif (plan), MRR, Quelle (source), Betrieb (Cloud / Self-hosted), Testphase endet am, Kündigungsgrund, Abrechnung (interval), Cloud-Konto (ID) |
| Tags | `status:warteliste`, `status:testphase`, `status:kunde`, `status:gekuendigt`, `plan:*`, `betrieb:*`, `quelle:*`, `roadmap:wunsch`, `support:sla-verletzt`, `newsletter`, `demo-anfrage` … |
| Forms | Warteliste & Newsletter (Double-Opt-in, always on), Demo-Anfrage, Support (creates tickets), Feature-Wunsch |
| Workflows (drafts) | Waitlist DOI confirmed → welcome series · trial onboarding day 0/1/3/7/12 with a check-in task · trial ends (3 days before) → offer · became customer → clean up · cancellation → thanks, reason, winback after 45 days · SLA at risk → team + task · SLA breached → tag + escalate · feature wish → roadmap tag + thanks · demo request → task |
| E-mail templates | 14 German mails in a friendly, honest du-tone (the workflows send the same texts) |
| Products | HyperLevel Cloud Solo, Team & Company, Agency (monthly, 19 % VAT) |
| Helpdesk | Categories, auto-reply with the SLA promise, help-center title; four draft articles: Cloud vs. Self-Hosting, Preise, Umzug von HighLevel, DSGVO & AVV |
| Community | Group „HyperLevel Community“ with eight channels (announcements, introductions, help, self-hosting, moving from HighLevel, templates, feature wishes, agency partners) |
| Dashboard | **CEO-Cockpit (SaaS)**: MRR, ARR, active subscriptions, running trials, lead → customer, new leads, cancellations, SLA rate, lifecycle funnel, leads per source, MRR per interval, support times |
| Routines | Project **CEO-Routinen** with recurring tasks: daily round, weekly review, Friday roadmap round, month-end, quarterly review, yearly check |

The trial workflows count on two signals: the tag `status:testphase` (set by hand, by the landing page flow or by the
cloud bridge) and the date field *Testphase endet am*.

## Landing page waitlist (dogfooding)

The public landing page posts its waitlist/newsletter form into your HQ sub-account through the normal forms module –
same validation, honeypot and rate limit, Double-Opt-in, consent proof, attribution and workflows as every form. A landing
page built elsewhere only needs these routes (`server/modules/landing-waitlist.ts`); the built-in one ([landing.md](landing.md))
uses the hook in **cloud waitlist mode** – see below.

| Setting | Meaning |
| --- | --- |
| `PGHL_LANDING_LOCATION` | Sub-account id that receives the sign-ups. Empty = the hook is off. |
| `PGHL_LANDING_FORM` | Form id in that sub-account. Empty = its newest form named „Warteliste & Newsletter“ (the HQ template's). A wrong id switches the hook off instead of posting elsewhere. |

| Method | Path | |
| --- | --- | --- |
| GET | `/api/public/landing/waitlist` | `{ enabled, form_id, fields, thank_you }` – what to render (`{ enabled: false }` when not configured) |
| POST | `/api/public/landing/waitlist` | Same body as a form submission: the field names (`first_name`, `email`, `consent: true`, …), plus `_hp` (honeypot), `_ts` (Turnstile, if the form has a captcha), `_attr`/`_page`/`_utm_*` for attribution. `plan` is accepted for `custom.plan`; `source` defaults to „Landingpage“. Answers like the form (`{ ok, id }`, or a German error message). |

Server-rendered pages on the same instance can call `app.services.landingWaitlist.config()` and
`.submit(ctx, body)` instead. The flow: sign-up → contact with tags `status:warteliste` and `newsletter` → confirmation
mail → `consent.confirmed` → the waitlist workflow starts the welcome series and moves the contact into *Warteliste*.

**Cloud waitlist mode** (the hosted cloud is not open yet – [cloud.md → Waitlist mode](cloud.md#waitlist-mode)): the
landing page, `/cloud` and `/start` show a waitlist form of their own that posts to `POST /api/public/cloud-waitlist`. With
`PGHL_LANDING_LOCATION` set it goes through this hook – source **„Cloud-Warteliste“**, the chosen plan as `Solo` / `Team &
Company` / `Agency` in `custom.plan`, the form's consent text shown on the page – so every interested person lands in the
pipeline *Kunden (Cloud)* with Double-Opt-in like any other waitlist sign-up. Without it, the entries stay in a built-in list
under *Agentur → Cloud → Warteliste* (CSV export, delete; no mail is ever sent from it); import that CSV into HQ later if you
like.

## Cloud → HQ CRM bridge

On the cloud instance, set `PGHL_HQ_LOCATION` to the HQ sub-account and every customer's lifecycle shows up in your own
CRM: signup and trial, trial ending, subscribed, plan change, failed payment and dunning, cancellation and deletion
create or update one contact and one deal in **Kunden (Cloud)**, with plan, MRR, interval, source and the cloud account
id. An erased account anonymises the contact. Details: [cloud.md](cloud.md#cloud--hq-crm-bridge).
