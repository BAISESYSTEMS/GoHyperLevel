# Back-Office: bookkeeping (light), stock and HR

Three areas in the same system as the CRM, for German small businesses: **Buchhaltung** (bookkeeping light, preparation for the tax advisor), **Lager & Einkauf** (stock and purchasing) and **Personal** (HR basics). Menu group **Back-Office**; each area has its own permission (`accounting`, `inventory`, `personal`) and, in SaaS mode, has to be part of the plan.

> **Legal notice – please read.**
> The bookkeeping is **"Buchhaltung light, Vorbereitung für den Steuerberater"**. It is **not certified accounting software**, it carries **no GoBD certification**, it is **no tax advice** and it does **not transmit anything to the tax office** (no ELSTER). It follows the GoBD principles where practical (see the table below), but whether a booking process is GoBD-compliant is decided by the way a company uses it, its procedure documentation and its tax advisor – not by this software. Every report and every export is meant to be checked and finalised with the tax advisor. Amounts are in EUR (the currency field is kept in the data). The same notice is shown at the top of the accounting screen, in the reports and in the status response (`disclaimer`).

Contents: [Permissions](#permissions-and-who-sees-what) · [Bookkeeping](#1-bookkeeping-light) · [Stock](#2-stock-and-purchasing) · [HR](#3-hr-basics) · [Agents, workflows, API](#agents-workflows-and-api) · [Hooks for other modules](#hooks-for-other-modules) · [Self-hosting](#self-hosting-checklist) · [Not included](#not-included)

## Permissions and who sees what

| Area | Opens | Notes |
| --- | --- | --- |
| `accounting` – Buchhaltung (Belege, Buchungen, Berichte) | `/api/accounting/*` | Members need the tick; agency admins always have it. |
| `inventory` – Lager & Einkauf | `/api/inventory/*` | |
| `personal` – Personal (Mitarbeiter, Abwesenheiten) | `/api/hr/*` | **Must be granted explicitly.** A login with "all areas" (the default of client logins) does *not* get HR – HR data is too sensitive for a default. Agency admins always have it. |

HR has a second gate for the **sensitive fields** (salary, IBAN, tax ID, social security number, tax class, health insurer, birth date) and for documents marked "sensitive": only agency admins and the people HR lists under *Personal → Settings → Access to sensitive data*, only in a browser session (never with API keys, MCP, mobile tokens), and every read and change is written to the audit log (who, which person – never the values). Everybody else – including HR staff who are not on that list – sees the contract data but not those fields.

Every login sees **only its own record** under *Personal → My area* (`/api/me/hr/*`): contract data (without internal notes), vacation balance, own absences, documents HR shared with them, their checklists, and – if they manage people – the requests of their team. The team calendar needs an employee record (or HR/manager rights), because it shows colleagues' names.

## 1. Bookkeeping light

### What is implemented against the GoBD principles

| Principle | In the system | Not covered |
| --- | --- | --- |
| Entries cannot be changed or deleted (Unveränderbarkeit) | Posted entries and their lines are immutable at database level (SQLite triggers refuse `UPDATE`/`DELETE`). A correction is a **storno entry** that swaps debit and credit and references the original; the original stays. Entries carry a SHA-256 hash chained to the previous entry (`GET /api/accounting/verify` re-computes the chain and reports the first break). | Anybody with direct access to the database file can still replace the whole file – that is a hosting question (backups, access control), not something software inside the file can solve. |
| Traceability (Nachvollziehbarkeit) | Every posting has a running number, date, text, source (invoice, payment, receipt, bank, Stripe, manual), the user, and a link to the document. The accounting **audit trail** (`acc_audit`, append-only, never pruned) records who did what and when. | The procedure documentation (Verfahrensdokumentation) is the company's own. |
| Completeness and order | Running numbers without gaps; the journal can be exported as CSV. | |
| Document archive (Belegarchiv) | Receipts are archived the moment they arrive (upload, phone photo, forwarded mail) with their **SHA-256 hash**, written once, never overwritten or deleted. `GET /api/accounting/documents/:id/verify` re-hashes the file on disk. Exact duplicates (same hash) are recognised. | Retention periods and deletion after them are not automated. Privacy erasure of a *contact* only removes the link to the contact; the entries stay (retention duty). |
| Closing a period (Festschreibung) | `POST /api/accounting/periods/lock {through: "2025-12"}` locks all months up to and including that one. A lock **cannot be undone**; no posting (not even a storno) is accepted in a locked month – corrections go into the current period. | |
| Timeliness | The posting date of automatic bookings follows the document (invoice date, payment date, bank date); the system records when they were made. | |

### Set-up

*Buchhaltung → Settings* (or `POST /api/accounting/setup {standard: "skr03"|"skr04"}`): the chart of accounts (SKR03 or SKR04, a practical selection of about 150 accounts, extendable), the **mapping** of the roles the automatic bookings need (bank, receivables, payables, revenue 19/7/0 %, VAT accounts, Stripe clearing account, Stripe fees, …), whether the company uses regular VAT or the small-business rule (§ 19 UStG), **Soll or Ist taxation** (VAT by invoice date or by payment), the first month of the fiscal year, and the DATEV numbers (consultant and client number, account length). Nothing is booked before the area has been set up for the sub-account.

### Receipts inbox (Belege)

1. **Get a receipt in:** upload (PDF, PNG/JPEG/WebP/HEIC, XML invoices; 8 MB), phone photo through the mobile API, or **forward by mail** – a mail-forwarding service (Cloudflare Email Workers, Make, Zapier, n8n …) posts the attachments as JSON to `POST /hooks/<sub-account>/receipts?key=…`. The key is shown in *Settings → Receipt mailbox* and can be rotated; it is stored sealed. A sender allow-list can restrict who may post.
2. **Read it:**
   - **XRechnung / ZUGFeRD (CII) / UBL** are read *exactly* from the XML (also from the XML embedded in a ZUGFeRD PDF) – supplier, number, date, net/VAT/gross per rate, due date, IBAN – with a small safe XML parser (no entities, no external references).
   - Otherwise the **AI** reads PDFs and photos if the sub-account has an AI connection whose model supports vision (*Settings → AI*, Anthropic or OpenAI). The result is treated as **untrusted data**: every field is validated (dates, amounts, rates 0/7/19, net + VAT = gross), implausible values are dropped, and the receipt always waits in *Review* for a person.
   - Without a vision-capable connection the fields are entered **by hand**; nothing else changes.
   - The system suggests the **expense account** from the supplier (learned from earlier receipts of the same supplier) or from keywords (fuel, software, telephone, travel …).
3. **Check and book:** supplier, date, amounts per VAT rate, account, paid or open (payable). Booking creates the entry (expense, input VAT, bank or payable) linked to the archived document. Reverse-charge purchases (§ 13b) use the marker code `rc19` (the amount is net; the system books the self-assessed tax and the matching input tax).

### Tax codes

| Code | Meaning | VAT return (Kz) | DATEV BU |
| --- | --- | --- | --- |
| `ust19` / `ust7` | Revenue with 19 % / 7 % VAT | 81 / 86 (base) | 3 / 2 |
| `ust0` | Tax-free revenue | – | – |
| `ust_ig` | Intra-community supply (tax-free) | 41 | – |
| `ust_export` | Export (tax-free) | 43 | – |
| `ust_rc` | Reverse charge, recipient owes the tax | 21 | – |
| `kl` | Small business (§ 19), no VAT | – | – |
| `vst19` / `vst7` | Input tax 19 % / 7 % | 66 | 9 / 8 |
| `vst0` | Expense without input tax | – | – |
| `rc19` | § 13b purchase, 19 % self-assessed | 46 / 47 (base / tax), input tax 67 | 94 |

A posting has one debit account, one credit account, an amount (gross; for `rc19` the net), a tax code and expands into **balanced lines** (the sum of debits equals the sum of credits, always, per entry – checked in code and again before commit). Rounding is to whole cents, half away from zero.

### Auto-posting

With *Settings → Auto-posting* on (each part separately), HyperLevel books by itself:

- **Invoices** when they are issued (sent / open): receivable against revenue and output VAT per rate (19/7/0 %); small-business invoices without VAT; reverse-charge, intra-community, export and tax-free invoices on their own revenue accounts (by the invoice's tax treatment). Finalised invoices only – drafts are never booked. A cancelled invoice is reversed by its **Stornorechnung**, and a **Gutschrift** is booked reversed with the original number as reference; on a final invoice the deducted partial invoices are subtracted ([invoicing.md](invoicing.md)).
- **Payments** (marked paid, partial payments, Stripe checkout) on the payment date: bank (or Stripe clearing account) against the receivable. The booking is idempotent: each source has a key (`invoice:<id>:issue`, `invoice:<id>:pay:<n>`, `stripe:<payout>` …), so a retry or a second start never books twice, and the balance is checked against the ledger.
- **Stripe:** card payments go to a **clearing account** (1360 / 1460); a payout books clearing → bank and the fees (read from the balance transactions) to the fee account; refunds are booked back. This needs the Stripe webhook of the Stripe module (`payout.paid`, `charge.refunded` …) – no extra credentials.
- A background tick is the safety net for anything missed while the server was off.
- **Norman coexistence:** invoices that were linked to Norman (the badge in the invoice list) are booked by Norman's side if you use both. Turn on *Skip invoices linked to Norman* (`autopost.skip_linked`) so they are not booked twice here.

`POST /api/accounting/autopost/run` runs the catch-up by hand.

### Bank import and matching

*Bank → Import*: **CSV** (the usual German bank exports: header detection, `;` or `,` separators, date and amount formats with decimal comma, debit/credit columns or signed amounts, UTF-8 and Windows-1252) and **CAMT.053** (XML, bank-to-customer statement). **No FinTS / PSD2 connection** – the files are imported by hand. Each line gets a dedupe key (date, amount, text, counter-party), so importing the same file again adds nothing.

Matching proposes, for every line, open invoices (incoming money) or open receipts (outgoing money) with a score from the invoice number in the purpose (60), the amount (35) and the counter-party name (15); from 50 points on it is a candidate, and a single clear candidate is pre-selected. **Nothing is booked without a click** (*Confirm*): confirming books the payment on the **bank date** (partial payments allowed), `book` posts a line to an account of your choice (fees, interest, private), `ignore` hides it. All of it can be reset until the period is locked.

### Reports

All reports are computed from the ledger and are previews for the tax advisor.

- **EÜR** (cash basis, by inflow/outflow): business income and expenses by group, VAT collected and paid, VAT paid to the tax office, depreciation of assets shown as asset purchases, profit. On-credit postings count when the settlement is booked (pro rata for partial payments); reverse-charge tax nets out.
- **SuSa** (Summen- und Saldenliste) and **BWA** by groups; balance accounts carry forward from year to year, profit-and-loss accounts reset with the fiscal year.
- **USt-Voranmeldung:** the key figures **81, 86, 41, 43, 21, 46/47, 66, 67** and the payable amount, for a month, quarter or year, by invoice date (Soll) or by payment (Ist). *Preparation only – no ELSTER.*
- **Open items** (receivables and payables) with age and overdue days, as of a date.
- **Journal** as CSV (semicolon, UTF-8 with BOM, formulas neutralised).

### DATEV export (Buchungsstapel, EXTF)

`GET /api/accounting/datev/preview` shows what would be exported; `GET /api/accounting/datev/export?from=&to=` downloads the file. Format, so your advisor knows what to expect:

- **EXTF**, header version **700**, data category **21** (Buchungsstapel), format version **13**; the header row has 31 fields (format name, consultant and client number, fiscal-year start, account length, date range, name, currency EUR …), the second row the **125 column headings** of that version, then one row per posting.
- **Encoding: Windows-1252** (DATEV's "ANSI"), no byte-order mark, **CR LF** line ends, `;` as separator, text in double quotes (quotes doubled), amounts with a decimal comma and no thousands separator. Characters that do not exist in Windows-1252 are replaced by `?`.
- Columns used: *Umsatz* (gross), *Soll/Haben*, *WKZ* `EUR`, *Konto* / *Gegenkonto*, *BU-Schlüssel*, *Belegdatum* (`TTMM`), *Belegfeld 1* (document number, restricted to the characters DATEV allows), *Buchungstext* (60 characters), *Beleglink* (`BEDI "<GUID>"`, see documents below), *Festschreibung* (0), *Fälligkeit*. All other columns are present and empty.
- **Tax:** the amount is exported **gross** and the tax is carried by the **BU-Schlüssel** (or by the account, if it is an automatic account – the export checks that an account with an automatic function does not also get a BU key). DATEV splits the tax itself, so no separate VAT rows are exported.
- **Documents:** `GET /api/accounting/datev/documents?from=&to=` is a ZIP (stored, no compression) for **DATEV Belegtransfer / DATEV Unternehmen online** with
  - `document.xml` in DATEV's format *Document v06.0* (namespace `http://xml.datev.de/bedi/tps/document/v06.0`): header with date, consultant and client number (when they fit the schema) and the company name; one `document` per file with a **GUID**, `type="1"` (**Rechnungseingang** – booked receipts) or `type="2"` (**Rechnungsausgang** – invoices and credit notes booked from the invoicing), `processID="1"` (*buchungsrelevant*; `&process=archive` gives `2`, archive only), a short description and keywords, and the file as `extension xsi:type="File"`;
  - the files: the original receipt, and for an invoice its **first archived PDF** (the one that was sent – ZUGFeRD or plain) or, if none was archived, a freshly rendered PDF;
  - `index.csv` (entry, dates, document number, partner, amount, file, SHA-256 with check, Rechnungseingang/-ausgang, GUID) – `&index=0` leaves it out if Belegtransfer should only see `document.xml` and the files.
- **Beleglink:** the EXTF rows of an entry with a document carry `BEDI "<GUID>"` in the *Beleglink* column, with the same GUID as that document in `document.xml`. The GUID is derived from the sub-account and the document, so the Buchungsstapel and the documents ZIP match no matter when or in which order they are exported. Payments carry no link (their document is the invoice). `&beleglink=0` on the export leaves the column empty (if the documents do not go to DATEV). Import the documents first, then the Buchungsstapel, so DATEV can resolve the links.
- **Limits of the documents export:** not validated against DATEV's XSD in the test suite (the format follows DATEV's published schema), at most 4,999 documents per ZIP (choose a shorter period), no ledger data files (`accountsReceivableLedger`/`accountsPayableLedger`) and no repository folders; documents of manual entries without a receipt are not included.
- Not covered: cost centres, Skonto, down payments, DATEV Rechnungswesen special cases, the XML ledger formats of the DATEV XML interface.
- **Please test an import with your advisor before relying on it.** The format follows DATEV's published description; the export is not DATEV-certified.

## 2. Stock and purchasing

*Lager & Einkauf*: tabs Stock · Movements · Places · Stock-taking · Purchase orders · Valuation · Settings.

- **Articles** have an SKU (unique per sub-account), name, unit, **EAN** (validated: EAN-8/13, UPC-A, GTIN-14 check digit), optional **variants** (an article can have a parent), a link to a **product** of the Products module, minimum stock, reorder quantity and a supplier (a CRM contact plus the supplier's article number). Articles with history can only be deactivated.
- **Places** (storage locations); one default place ("Hauptlager"). A place with stock cannot be deactivated.
- **Movements:** goods receipt (with unit cost), goods issue, transfer between places, correction (also negative). The movement log is append-only and keeps the moving-average cost after each movement (so the valuation can be computed **as of any date**). Negative stock is refused unless *Allow negative stock* is on.
- **Automatic goods issue:** when an invoice is **paid** (default), **sent**, or never (*Settings → Automatic goods issue*), the stock of the invoice lines is issued. A line is matched to an article by the SKU in its text (`[SKU-123]` or the whole name), the linked product, or the article name; ambiguous matches are skipped, never guessed. `POST /api/inventory/issue-from-invoice/:id` runs it by hand; every invoice is issued only once. Paid **online-store orders** always take their goods out (the variant's SKU is on the invoice line) – the store's variants and stock are these articles ([store.md](store.md#products-variants-and-stock)).
- **Minimum stock:** when the stock falls to or below the minimum, **once per drop** the event `stock.low` fires (workflow trigger, with the supplier contact), and users with the *Lager* area get a push notification. Raising the minimum or restocking re-arms it.
- **Stock-taking (Inventur):** a count lists expected quantities (frozen when started); enter what you counted; closing books the **differences** as correction movements.
- **Purchase orders:** draft → ordered (optionally e-mailed to the supplier contact) → partly received → received. Receiving books the goods receipt with the order's unit cost and fires `purchase_order.received`.
- **Valuation:** stock value at moving-average cost, per article and place, as of today or any past date (the key date ends at midnight in the sub-account's time zone); CSV export.

## 3. HR basics

*Personal* – tabs for HR staff: Employees · Absences · Calendar · Vacation accounts · Working time · Checklists · Holidays · Settings; plus **My area** for every employee.

- **Employees** can be HyperLevel logins or people without any login. Contract data: number (P-001 …), name, contact data, position, department, manager (a login), employment type (full, part, mini job, trainee, freelance), start/end date, probation, notice period, weekly hours, **work days** (e.g. Monday–Thursday), vacation days per year, **state** for public holidays, internal notes (HR only). A CRM contact can be linked so workflows can reach the person. Deleting is possible only for people who have left, by those who may see sensitive data; Lohnunterlagen retention periods (6–10 years) are the employer's responsibility.
- **Sensitive fields** are stored in one sealed block (AES-256-GCM, same key handling as other secrets) and need the second gate described above. **Documents** (contract, certificates, payslips …, 8 MB, PDF/images/text/Office) have a visibility: *HR only*, *employee may see* or *sensitive*.
- **Absences:** types **vacation**, **sick note** and **other** (with a label such as special leave). The working days are counted from the employee's work days, the **public holidays of the state** and half days (start and/or end). The request is checked: not before the start or after the end of the employment, no overlap (two half days on one day are fine), enough **balance** for vacation (per calendar year, also across a year end), and employees cannot book vacation in the past. **Sick notes** record that someone is away – **never why** (health data): no reason is stored; an optional flag says a doctor's note exists. They are approved automatically if *Settings → Sick notes need no approval* is on. Vacation and other leave go through **request → approval** by HR or the employee's manager; **nobody approves their own request** (agency admins excepted – nobody is above them). HR may enter an absence directly approved, or exceed the balance deliberately (`force`).
- **Team calendar:** HR sees every type and status; colleagues see approved absences as "Vacation" or just "away" (sick leave never as such) and their own requests.
- **Leave maths** (`server/services/hr-leave.ts`, pure functions, tested):
  - *Holidays:* Easter-based (Good Friday, Easter Monday, Ascension, Whit Monday, Corpus Christi) and fixed holidays per Bundesland, including Epiphany (BW, BY, ST), Women's Day (BE, MV from 2023), Reformation Day, All Saints, Repentance Day (SN), World Children's Day (TH) and Berlin's one-off holidays. Local holidays that apply only in parts of a state (e.g. Mariä Himmelfahrt in Bavaria, Augsburg's Peace Festival) are **not** included.
  - *Entitlement:* the full annual days for a whole year; in the year of joining or leaving **1/12 per full month of employment**, a fraction of at least half a day rounded up, a smaller one kept (§ 5 BUrlG).
  - *Balance:* entitlement + carry-over + adjustments − approved vacation; requested vacation is *pending* and reduces what is *available*. **Carry-over** is entered per year (the system suggests the unused remainder of the previous year, capped by *Maximum carry-over days*); carry-over not used until the **expiry date** (default 31 March, can be turned off) is forfeited; vacation taken until then uses the carry-over first.
- **Checklists:** standard **onboarding** and **offboarding** templates are created once per sub-account (edit or replace them); starting one for an employee fixes the due dates from the start date (onboarding) or end date (offboarding). Items belong to HR, the employee, the manager or IT; employees tick their own.
- **Working-time overview:** per employee the target hours of a period (weekly hours spread over the work days, minus holidays and approved absences), absence days, and – when a time-tracking module is connected – the tracked hours and the difference. The hours come from the project planner's time tracking (*Zeiterfassung*), matched by login: finished entries that were not rejected on a timesheet, counted per day in the sub-account's time zone. See [Hooks](#hooks-for-other-modules). HR itself does not track time.

## Agents, workflows and API

### MCP tools (HyperLevel agent, Claude, Codex)

| Tool | Area | Does |
| --- | --- | --- |
| `ghl_booking_summary` | accounting | Entries, income, expenses, result, top cost types, open receivables/payables for a period |
| `ghl_euer_report` | accounting | EÜR for a year or period |
| `ghl_vat_overview` | accounting | VAT return key figures for a month/quarter/year |
| `ghl_open_items` | accounting | Open receivables or payables |
| `ghl_receipt_status` | accounting | Receipt inbox counts and the latest receipts, or one receipt |
| `ghl_stock_levels` | inventory | Stock per article (search, low only) |
| `ghl_low_stock` | inventory | Articles at or under the minimum |
| `ghl_stock_movement` | inventory | Book a receipt, issue or correction (changes stock) |
| `ghl_create_absence_request` | personal | File an absence request for an employee (by id or e-mail) – never approves, never skips the checks, never sees sensitive fields |

The tools run through the regular routes, so the same permissions, isolation and audit log apply; they sit in the tool group *Back-Office*.

### Workflow triggers

| Trigger | Fires when | Event data |
| --- | --- | --- |
| `stock.low` | stock falls to or below the minimum (once per drop) | `contactId` (supplier), `articleId`, `sku`, `name`, `qty`, `min_stock`, `reorder_qty`, `unit`, `supplier` |
| `purchase_order.received` | a purchase order is fully received | order id and number, supplier |
| `receipt.received` | a receipt arrived (upload, photo, mail) | `receiptId`, `source`, `file` |
| `receipt.booked` | a receipt was booked | `contactId`, `receiptId`, `entryId`, `entryNumber`, `supplier`, `invoiceNo`, `gross_cents`, `account`, `payment` |
| `absence.requested` | an absence was requested or noted | `contactId` (linked or by e-mail), `absenceId`, `employeeId`, `name`, `type`, `label`, `start_date`, `end_date`, `days`, `status` |
| `absence.approved` | approved (also sick notes confirmed automatically) | same |
| `absence.rejected` | rejected | same |

Workflows need a contact to run for; where an event has none (an employee without a CRM contact or e-mail match) the workflow does not start. Push notifications go to approvers (request), the employee (decision) and the *Lager* users (low stock).

### API overview

All routes are sub-account routes (`x-location-id` or an API key) and are listed in `docs/api.md`. In short:

- `/api/accounting/…` – `status`, `setup`, `settings`, `accounts`, `tax-codes`, `entries` (+ `/:id/storno`), `periods`, `periods/lock`, `audit`, `verify`, `summary`, `receipts` (+ `/status`, `/:id/extract|discard|book`), `documents/:id` (+ `/verify`), `inbound` (+ `/rotate`), `bank/*`, `reports/susa|bwa|euer|ustva|open-items|journal.csv`, `datev/preview|export|documents`, `autopost/run`
- `/api/inventory/…` – `status`, `settings`, `places`, `articles` (+ `from-product`), `stock`, `low-stock`, `movements`, `transfers`, `valuation`, `counts`, `orders`, `issue-from-invoice/:id`
- `/api/hr/…` – `access`, `settings`, `users`, `employees` (+ `/:id/sensitive|documents|balance|leave-years/:year`), `documents/:id`, `absences` (+ `/:id/approve|reject|cancel`), `calendar`, `holidays`, `status`, `working-time`, `checklist-templates`, `checklists`
- `/api/me/hr/…` – the caller's own record: `/api/me/hr`, `balance`, `absences` (+ `/:id/cancel|decide`), `approvals`, `calendar`, `holidays`, `documents`, `checklists`
- `/hooks/<sub-account>/receipts?key=…` – the public receipt mailbox (JSON, up to 24 MB and 10 attachments per call, key-protected)

### Mobile API

`GET/POST /api/mobile/receipts`, `GET/POST /api/mobile/absences` (+ `/:id/cancel`, `/calendar`, `/approvals`, `/:id/decide`) and `GET /api/mobile/stock/low` – thin relays onto the routes above with the same areas and checks (documented in `docs/api.md` → Mobile-App). A device token never reaches `/api/hr`, so the sensitive fields stay closed on the phone.

## Hooks for other modules

- `app.services.stripeEvents: ((app, event) => void)[]` – the Stripe module calls these for events it does not handle itself; the accounting uses them for payouts, fees and refunds.
- `app.services.accounting` – used by the invoices side (and tests) to trigger a catch-up booking; `app.services.accountingPending` / `accountingFlush` let tests and shutdown wait for background work.
- **Time tracking (project planner) ↔ HR**, both directions are plain service hooks, so either side can be replaced:
  - HR **offers** `app.services.absences.forUser(locationId, userId, from, to)` → `[{ date, type: 'vacation'|'sick'|'other'|'holiday', value, name? }]` (approved absences and public holidays of the person's state, `value` 1 or 0.5) and `app.services.absences.targetHours(locationId, userId, from, to)` → hours or `null` when the login is no employee.
  - HR **consumes** `app.services.workingTimeProvider.hoursByUser(locationId, from, to)` → `{ [userId]: hours }` (sync or a promise). If no module provides it, the working-time overview shows target hours and absences only (`tracking_connected: false`).
  - `modules/backoffice-time.ts` is the glue for the planner: it registers `workingTimeProvider` from `pm_time_entries` (read-only, sums per login only – no notes, tasks or projects leave it) when that table exists and no other module has registered a provider first.
- `app.services.hrBalance(locationId, employeeId, year)` – vacation balance; `app.services.hrHolidays(year, state)` – the holidays.
- `app.services.privacyErase`: accounting, stock and HR register hooks that **unlink** an erased contact instead of deleting retained records.

## Self-hosting checklist

No new packages and no new environment variables. Per sub-account:

1. **Buchhaltung → Settings:** choose SKR03/SKR04, check the mapping, VAT mode, Soll/Ist, fiscal-year start; enter consultant and client number if the advisor uses DATEV; decide whether invoices linked to Norman are skipped.
2. **Receipt mailbox (optional):** point a mail-forwarding service at the URL shown in *Settings → Receipt mailbox* (`/hooks/<sub-account>/receipts?key=…`, JSON with `from`, `subject` and `attachments: [{ filename, content_type, content (base64) }]` – up to 10 per mail). Keep the key secret; rotate it if it leaked; add allowed senders.
3. **AI reading (optional):** add an AI connection with a vision-capable model (Anthropic or OpenAI) under *Settings → AI*. Without it receipts are entered by hand. Real receipts leave your server to that provider – say so in your privacy notice.
4. **Stripe (optional):** the existing Stripe webhook is enough; make sure it also delivers `payout.paid` and `charge.refunded` for the clearing-account bookings.
5. **Permissions:** give the bookkeeper `accounting`, warehouse staff `inventory`, HR staff `personal` (explicitly) and – for the few who may see salaries – list them under *Personal → Settings*. Link employees to their logins so they can file absences.
6. **Backups:** the ledger, the document archive (`<data dir>/acc-docs`) and HR documents (`<data dir>/hr-docs`) are part of what must be backed up; the database backup of the platform covers the tables, not the files.
7. **Holidays:** set the default state per sub-account and per employee where it differs.

## Not included

ELSTER transmission, certified GoBD compliance, FinTS/PSD2 bank connection, payroll (Lohnabrechnung), time tracking, DATEV ledger XML (Rechnungsdaten) and cost accounting, multi-currency bookings (the currency field exists, values are EUR), depreciation schedules (assets are posted as purchases), and local holidays below state level.
