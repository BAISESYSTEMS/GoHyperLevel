# Invoicing: GoBD finalising, Storno, credit notes and the e-invoice

**Umsatz → Rechnungen** writes invoices, credit notes and quotes the way German bookkeeping expects them: a finalised invoice has a **gap-free number** and **cannot be changed any more**, mistakes are corrected with a **Stornorechnung** or a **Gutschrift**, and every finalised invoice can be downloaded as a **PDF with a GiroCode**, as an **XRechnung 3.0** (EN 16931, CII or UBL) and as a **ZUGFeRD 2.3 / Factur-X 1.07** PDF with the XML inside. Everything is per sub-account and belongs to the area **Rechnungen & Zahlungen** (`payments`).

> **Not legal or tax advice, and no certification.** HyperLevel gives you the technical means for GoBD-conformant invoicing (immutability, traceability, completeness) and for the e-invoice. Whether your process as a whole is compliant (process documentation / *Verfahrensdokumentation*, retention, who may do what) stays your responsibility and your tax advisor's call. See [open questions](#limits-and-open-questions).

- [States and what each one allows](#states-and-what-each-one-allows)
- [Finalising (GoBD)](#finalising-gobd)
- [Number ranges](#number-ranges)
- [Storno and credit notes](#storno-and-credit-notes)
- [Fields of an invoice](#fields-of-an-invoice)
- [The e-invoice (XRechnung)](#the-e-invoice-xrechnung)
- [ZUGFeRD / Factur-X (PDF with the XML inside)](#zugferd--factur-x-pdf-with-the-xml-inside)
- [PDF and GiroCode](#pdf-and-girocode)
- [Archive and retention](#archive-and-retention)
- [Settings](#settings)
- [Existing invoices after the update](#existing-invoices-after-the-update)
- [API, events and MCP](#api-events-and-mcp)
- [Limits and open questions](#limits-and-open-questions)

## States and what each one allows

The stored `status` stays `draft | sent | paid | void | accepted` (so integrations keep working); the screen and the API add a derived `state`:

| `state` | Shown as | Meaning | What you can do |
| --- | --- | --- | --- |
| `draft` | Entwurf | No number yet. Freely editable, can be deleted. | Edit, **Festschreiben**, **Senden** (finalises first), delete |
| `open` | offen | Finalised, nothing paid yet. Frozen. | **Zahlung erfassen**, resend, Gutschrift, **Stornieren** (only without credit notes – see [below](#storno-and-credit-notes)) |
| `partially_paid` | teilweise bezahlt | Finalised, part of the amount is paid. | Add the rest, Gutschrift, Stornieren (only without credit notes) |
| `paid` | bezahlt | Paid in full. | Gutschrift, Stornieren (only without credit notes), take a payment back |
| `cancelled` | storniert | Cancelled by a Stornorechnung. Final. | Nothing – the Storno document stands next to it |
| `credited` | gutgeschrieben | Credited in full by credit notes (Gutschriften) with nothing paid. Stored as `void` with `cancelled_at`, but without a Stornorechnung. Final. | Nothing – the credit notes stand next to it |
| `discarded` | verworfen | A draft that was dropped (it never had a number). | Nothing |
| `accepted` | angenommen | Quotes only. | Convert into an invoice |

The rules live in one place (`server/services/invoice-model.ts`, `actionFor`). A change that is not allowed is refused with **409** and a German message ("Eine festgeschriebene Rechnung kann nicht zurück in den Entwurf – storniere sie und schreibe eine neue"). A database trigger enforces the same, so even a script or raw SQL cannot edit a finalised invoice.

**Senden** (invoice, quote, credit note – web, app, API, MCP and workflows alike) mails the customer once per click: while a document is on its way, a second send of the same document (a double click, two colleagues, a workflow step at that moment) is refused with **409** ("… wird gerade gesendet"). Once the first send is through, sending again – a deliberate resend – works as before.

## Finalising (GoBD)

*Festschreiben* (button on a draft, or implicitly by **Senden**, by marking a draft as paid and by the API/MCP) does, in **one transaction**:

1. gives the invoice its **number** from its [range](#number-ranges) – no number is ever consumed without a document (a rollback rolls the counter back too) and two parallel finalisations never get the same number;
2. fixes the **invoice date** (today, unless you chose one) and the **service date** (*Leistungsdatum*; empty means "same as the invoice date", printed that way);
3. stores a **snapshot** of everything that is printed – seller, buyer, lines, tax groups, terms, bank data – and its **SHA-256** (`doc_hash`);
4. writes an **audit entry** (`invoice_audit`, append-only, with the actor);
5. books the invoice in the ledger (see [Bookkeeping](backoffice.md)) and emits `invoice.finalised`.

From then on **lines, amounts, customer, tax treatment, number, date and snapshot are frozen** – by the API (409 with the field that was touched) and by database triggers. Still editable: the **note** (*Hinweistext*), the **due date** and the **payment link**; every such change is written to the audit trail with before and after. A finalised invoice **cannot be deleted**.

*Prüfsumme prüfen* in the lock banner (or `GET /api/invoices/:id/verify`) recomputes the hash from the stored snapshot and compares it with the invoice row, the archive and the ledger entry.

Before finalising, the dialog shows a **pre-check** (`GET /api/invoices/:id/precheck`): what blocks (no line, a tax treatment without its mandatory text or with the `…` placeholder still in it, a missing or invalid VAT ID where the tax treatment needs one, an invalid Leitweg-ID, a service period that ends before it starts …) and what is only a warning (seller name, address or tax number missing – mandatory under § 14 UStG; customer address above 250 €). With **Streng prüfen** (*Einstellungen → Rechnungen*) warnings block too.

## Number ranges

Four ranges, each gap-free and with its own counter: **Rechnungen** (`RE-`), **Gutschriften** (`GS-`), **Stornorechnungen** (`ST-`) and **Angebote** (`AN-`). Per range: prefix, optional **year in the number** (`RE-2026-1001`), optional **restart every year**, digits with leading zeros and the start number. The **next number** can only be raised, never lowered – numbers already given out are never given out twice. A number that exists already (imported documents) is skipped; that is the only way a number is left out.

Drafts have **no number** (the API shows `""`; the screen says "Entwurf"). Quotes get theirs when they are created, as before.

## Storno and credit notes

- **Stornieren** (button on a finalised invoice, `POST /api/invoices/:id/storno`, `ghl_invoice_cancel`) creates a **Stornorechnung** with its own number from the Storno range, a reference to the original (*"Storno zu RE-1001 vom …"*, with your reason) and **all amounts with the opposite sign**. The original becomes `cancelled`, the ledger gets the counter-booking and the invoice drops out of dunning. Optionally the Storno is e-mailed in the same step. Time entries that were billed on the invoice are released.
- **No Storno after a credit note – credit the rest instead.** A Stornorechnung always reverses the **whole** invoice (that is what a *Stornorechnung* is under German practice for § 14 UStG; a partial correction is a credit note). Once a credit note (Gutschrift) has been finalised for an invoice, *Stornieren* is therefore refused with **409**: together with the credit notes it would refund more than the invoice was for (before, a Storno after a partial credit note credited the full amount again). The message names what is left and points to **Restbetrag gutschreiben** – the button in the credit-note dialog, `POST /api/invoices/:id/credit-note` with `{ "remainder": true }`, or `ghl_invoice_credit_note` with `remainder: true`. It makes a draft credit note with one line *Restbetrag zu RE-…* per tax rate for what has not been credited yet; for a final invoice that is what the final invoice itself still asks for (the deducted partial invoices stay valid, as with its Storno). VAT is rounded per rate, so the nets are moved by a cent where that makes the rest exact to the cent; where no net can (about one case in ten with a single rate) the credit note stops **one cent short – never above** – and its `warnings` say so; settle that cent by hand. Finalised, it closes the invoice like any invoice credited in full (state `credited` when nothing was paid; a paid part is refunded separately, as after a Storno).
- **Gutschrift** (`POST /api/invoices/:id/credit-note`, `ghl_invoice_credit_note`) is the partial variant: pick lines, quantities and prices; a draft credit note with negative amounts is created, which you finalise like an invoice. The total of all credit notes can never exceed the invoice. When the credit notes leave **nothing open and nothing was paid**, the invoice is **closed** with the credit note that settles it: state `credited` (*gutgeschrieben*; stored `void` like a cancelled invoice, so it takes no payment, no further credit note or Storno, drops out of the open lists, dunning, online payment and SEPA collection, and reports show it as *Gutgeschrieben*). Pending dunning notices are withdrawn. In the books nothing more happens: the credit notes already reverse the invoice's entry (unlike a Stornorechnung, which reverses it itself). Invoices credited in full before the update were closed by the migration `invoicing:002-credited-closed`.
- Credit notes and Stornos are documents of their own (`kind: credit_note`, `credit_type: storno | credit`), are frozen like invoices, are booked **reversed** in the ledger (reference: the original number) and are exported as **type code 381** in the XRechnung.
- Rounding is symmetric (half away from zero), so a Storno **exactly negates** the invoice, cent for cent.
- A payment that was received on a cancelled invoice is not refunded automatically – the dialog says so; the refund is a separate step at your bank or Stripe (a Stripe refund of an invoice triggers the Storno automatically for team-calendar bookings).

## Fields of an invoice

| Field | Notes |
| --- | --- |
| **Leistungsdatum / Leistungszeitraum** | One date or a period. Mandatory content of a German invoice; empty prints "entspricht dem Rechnungsdatum". |
| **Steuerbehandlung** | *Regelbesteuerung*, *Kleinunternehmer (§ 19 UStG)*, *Reverse Charge (§ 13b UStG)*, *innergemeinschaftliche Lieferung*, *Ausfuhrlieferung*, *sonstige Steuerbefreiung (§ 4 UStG)*. Each non-standard mode sets 0 % and inserts its **mandatory note text** (editable, but never empty); reverse charge and intra-community supply additionally require your VAT ID and the customer's. |
| **USt-IdNr. des Kunden** | Format check per country incl. the German check digit; optional **VIES** lookup (*Einstellungen → Rechnungen → VIES*): the result is shown and stored in the snapshot, an unreachable service only warns. |
| **Leitweg-ID** | For authorities (B2G); checked for format and check digits (a wrong check digit warns, because some issuers use other schemes). Goes to BT-10 (buyer reference) and as the buyer's routing endpoint (scheme 0204). |
| **Kundenreferenz / Bestellnummer** | Printed and exported as the buyer reference (BT-10) when there is no Leitweg-ID; without either, the invoice number is used, because XRechnung requires the field. |
| **Skonto** | Percent and days. Printed as a sentence, exported **structured** (`#SKONTO#TAGE=…#PROZENT=…#BASISBETRAG=…#`); a payment marked *Skonto abgezogen* is stored as a Skonto row next to the payment (the invoice counts as paid). The ledger does **not** book the Skonto automatically – a warning says the difference stays on the receivable until you and your tax advisor clear it (*Erlösschmälerung*). |
| **Abschlags- und Schlussrechnung** | `inv_type` *partial* is a normal invoice titled *Abschlagsrechnung* (type code 326). A *final* invoice lists the full delivery and **deducts the finalised partial invoices** you pick (their VAT is taken into account; BT-113 "prepaid amount" in the XRechnung). A partial invoice can be deducted once. A Stornorechnung of a final invoice keeps the deductions: the partial invoices stay valid, so it refunds only what the final invoice asked for (also BT-113/BT-115 in its XRechnung). |
| **Unit per line** | UN/ECE code (Stk., Std., Tag, Monat, kg, m, pauschal …), exported as given. |
| **Angebot → Rechnung** | *In Rechnung umwandeln* copies lines, customer and tax treatment into a draft that **references the quote**; a quote can be converted several times (Abschlag, Abschlag, Schluss). An accepted or converted quote is frozen. |

VAT is rounded **once per tax rate** over the sum of the net lines (EN 16931 BR-CO-17), not per line. Invoices created before the update keep their old per-line rounding (`calc = line`), so no old total changes by a cent.

## The e-invoice (XRechnung)

A finalised invoice or credit note can be downloaded as **XRechnung 3.0** – `urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`, Peppol BIS profile – in two syntaxes:

- **CII** (UN/CEFACT Cross Industry Invoice D16B) – the format inside ZUGFeRD / Factur-X;
- **UBL 2.1** (`Invoice`, or `CreditNote` for type code 381).

Covered: seller and buyer with address and contact (BG-4/5/6/8/9), VAT IDs and tax number, invoice and service date or period, due date and structured payment terms, **SEPA credit transfer** (IBAN, BIC), lines with quantity, unit and VAT category, **VAT breakdown** (S, Z, E, AE, K, G with exemption reason and VATEX code), document-level totals, prepaid amount, references to a preceding invoice (Storno, credit note, final invoice) and the order/Leitweg-ID, notes.

**Own validator.** Every file is parsed back and checked before it is offered: all mandatory business terms (BT) of XRechnung, the arithmetic rules **BR-CO-10 … BR-CO-17** (sums, rounding, VAT per category), VAT-breakdown consistency (BR-S/Z/E/AE/IC/G rules), code lists (currency, country, unit, VAT category, type code) and the German **BR-DE** rules (seller contact, payment means, Leitweg-ID/reference). A failing file is never handed out (`422` with the list of problems). *E-Rechnung prüfen* in the invoice shows the same check as a preview, also for drafts.

> The built-in validator is **not** the official KoSIT validator. It covers the rules that matter for the generated documents, but you should run the first productive files through the [KoSIT validator](https://github.com/itplr-kosit/validator) (or your receiver's portal) once. The fixtures under `tests/invoice-fixtures.ts` (standard, mixed rates, reverse charge, § 19, credit note 381, partial payments / final invoice) are meant for exactly that.

**Sending.** *Einstellungen → Rechnungen → XRechnung anhängen* attaches the XML to the invoice e-mail next to the PDF; `POST /api/invoices/:id/send` takes `attach_xrechnung: "cii" | "ubl"` per call. The customer page `/i/<token>` offers *PDF* and *XRechnung (XML)*. Upload to a federal portal (ZRE/OZG-RE) or a Peppol access point is **not** built in – download the file and upload it there.

## ZUGFeRD / Factur-X (PDF with the XML inside)

*Dokumente → ZUGFeRD-PDF* on a finalised invoice or credit note (or `GET /api/invoices/:id/zugferd`) gives a **hybrid invoice**: the same PDF as the PDF download, with the CII XML embedded the way **ZUGFeRD 2.3 / Factur-X 1.07** describe it. A person reads the PDF, a program (DATEV, lexoffice, sevDesk, the receipts inbox of another HyperLevel …) reads the XML.

| | |
| --- | --- |
| Profile | **EN 16931** (Comfort; default) – guideline `urn:cen.eu:en16931:2017`, attached as `factur-x.xml`. `?profile=xrechnung` gives the ZUGFeRD profile **XRECHNUNG**: the attached `xrechnung.xml` is byte for byte the XRechnung (CII) download. |
| XML | The CII generator and the own validator of the XRechnung (profile `en16931` relaxes only the XRechnung-only rules). Same data requirements – a missing seller phone number or IBAN answers `422` with the list. Checked in development against the Factur-X 1.07 EN 16931 XSD. |
| Attachment | Embedded file stream `/Subtype text/xml` (compressed, `/Params` with size, MD5 and date), file specification with `/AFRelationship /Alternative`, the `EmbeddedFiles` name tree and the `/AF` array on the catalog. |
| Metadata | XMP with `pdfaid:part 3` / `conformance B`, Dublin Core, the Factur-X PDF/A extension schema and `fx:DocumentType INVOICE`, `fx:DocumentFileName`, `fx:Version 1.0`, `fx:ConformanceLevel` (`EN 16931` or `XRECHNUNG`); an Info dictionary with the same title, author, subject and dates; a document ID. |
| Colour | An OutputIntent `GTS_PDFA1` with an **sRGB ICC profile** (written by HyperLevel, ICC v2, no binary file in the repository). |
| Archive | Every generated file goes into the invoice archive (`kind: zugferd`, SHA-256, retention 8 years; identical bytes once) with an audit entry `zugferd.generated`. |

The file is made by a small post-processing step on HyperLevel's own PDF writer (it reads the PDF's cross-reference table and writes it again as one PDF 1.7 revision) – **no PDF library and no new dependency**.

**Sending.** *Einstellungen → Rechnungen → ZUGFeRD-PDF statt einfachem PDF anhängen* (`attach_zugferd`, **off by default**) puts the hybrid PDF (profile EN 16931) into the invoice e-mail instead of the plain PDF and archives exactly that file. If the e-invoice cannot be made (data missing), the mail goes out with the plain PDF and the trail notes `zugferd.attach_skipped`. `POST /api/invoices/:id/send` takes `attach_zugferd: true | false` per call; an explicit `true` refuses with `422` instead of falling back.

**Honest limit – PDF/A-3.** The e-invoice part (XML, attachment, relationship, XMP, output intent) follows the specification, but the **page content keeps the PDF base fonts (Helvetica) without embedding them**. PDF/A requires embedded fonts, so a strict PDF/A-3 validator (veraPDF, the Mustang validator, some portals) reports the file as *not PDF/A-3b conformant* (font rule 6.2.11.4 of ISO 19005-3)<!-- oss-check: allow -->, even though the XML is valid and readable. Most receiving programs extract the XML regardless; if a receiver insists on a validated PDF/A-3, send the **XRechnung** (the XML is the legal original anyway) or convert the PDF with a PDF/A tool (e.g. Ghostscript) and attach the XML there. Full PDF/A-3 needs an embedded font (a font file in the repository and a TrueType writer) – not done yet.

### The timeline in Germany (as of 2026)

| From | What |
| --- | --- |
| 1 Jan 2025 | **Every business must be able to receive** e-invoices in the EN 16931 format (XRechnung, ZUGFeRD ≥ 2.0.1 EN16931/Extended). HyperLevel reads them in the receipts inbox ([backoffice.md](backoffice.md)). A plain PDF counts as a *sonstige Rechnung* and may still be issued during the transition. |
| 2025 – 2026 | Transition: paper and other formats (PDF) remain allowed for issuing, if the receiver agrees. |
| 1 Jan 2027 | **Issuing** an e-invoice is mandatory for businesses with a **prior-year turnover above 800,000 €**. |
| 1 Jan 2028 | Mandatory for **all** domestic B2B invoices. |

Exceptions: invoices up to 250 € (*Kleinbetragsrechnung*), tickets, and invoices of **Kleinunternehmer (§ 19 UStG)** do not have to be e-invoices (they may be, and HyperLevel can produce them). B2C invoices are not covered. Details and edge cases (see the BMF letters on the e-invoice): ask your tax advisor.

## PDF and GiroCode

`GET /api/invoices/:id/pdf` (and `/i/<token>/pdf` for the customer) renders the invoice **on the server** – no browser needed, deterministic bytes: **DIN 5008 Form B** layout (address in the window of a C6/5 envelope, sender line, folding marks), the invoice information block, lines with VAT per line, **VAT breakdown per rate**, deductions, mandatory tax note, payment terms with Skonto, **bank data**, footer, page numbers on multiple pages, logo of the sub-account, a *Entwurf* watermark on drafts and a *Bezahlt* / *Storniert* stamp from the live status. The PDF is generated from the **frozen snapshot**, so it is the same file today and in eight years (except the note and the due date, which stay editable).

Long names, addresses and references stay on the page and never run into each other: a line gets smaller (down to a readable size) before anything is cut, the customer's address wraps inside the window (it is never shortened), and emoji are left out because the PDF base fonts cannot print them. The dunning letter follows the same rules.

Open invoices carry a **GiroCode** (EPC069-12 v002 QR code: recipient, IBAN, BIC, amount, remittance) so a banking app fills the transfer in. It is drawn as vector graphics and shows the **open** amount.

The PDF is attached to the invoice e-mail (switch off with *PDF anhängen*). The plain PDF is a normal PDF without embedded XML; the **ZUGFeRD-PDF** carries the XML – see [ZUGFeRD / Factur-X](#zugferd--factur-x-pdf-with-the-xml-inside).

## Archive and retention

Every PDF, ZUGFeRD-PDF and XRechnung that is **e-mailed**, and every XRechnung and ZUGFeRD-PDF that is downloaded, is stored once in the **document archive** of the bookkeeping (the same one as the receipts: written once, never changed or deleted, SHA-256) and linked to the invoice (`invoice_documents`; the invoice page lists them under *Dokumente*). Identical bytes are stored once. Each entry notes its **retention until 31 Dec of the issue year + 8** – booking vouchers (*Buchungsbelege*, thus invoices) have to be kept eight years since 2025 (§ 147 AO; commercial letters six years, § 257 HGB). Deleting the sub-account is the only thing that removes the archive; nothing in the app deletes a document earlier. Keep `data/` in your backups.

## Settings

*Einstellungen → Rechnungen* (`GET/PUT /api/invoice-settings`):

- **Absender** – street, postal code, city, country, tax number, VAT ID, contact person (name, e-mail, phone: the XRechnung needs a contact), footer. Company name, e-mail and phone come from *Firma*.
- **Bank** – bank, IBAN (checked, mod 97), BIC, PayPal.me.
- **Steuer und Zahlung** – default VAT rate, payment term, default tax treatment for new invoices, *Kleinunternehmer*.
- **Beim Festschreiben und Senden** – strict check, VIES lookup, attach PDF, attach the ZUGFeRD-PDF instead of the plain PDF (`attach_zugferd`, off by default), attach XRechnung, syntax (CII or UBL).
- **Nummernkreise** – the four ranges above.

## Existing invoices after the update

The migration `invoicing:001-gobd` is non-destructive:

- invoices that were **sent, paid or cancelled** are **finalised** (snapshot of what they printed at that moment, SHA-256, audit entry *beim Update festgeschrieben*); their numbers stay, and the counters continue **after the highest issued number** of each prefix;
- **drafts** get a placeholder (`Entwurf-…`, never shown) and receive their number when finalised;
- recognisable tax treatments (e.g. the old *Kleinunternehmer* flag, 0 % lines with the § 19 note) are set; paid invoices get their `paid_cents`;
- other modules that still flip the status with raw SQL (imports, scripts) are picked up by a background pass within 30 seconds and **adopted** (number, snapshot, freeze) with an audit entry *nachträglich übernommen*.

Stripe payments, the dunning module, Norman/Lexware links, recurring invoices, project time billing and team-calendar bookings keep working: they finalise on payment or send, and read the **open amount** (total minus payments, credits and deducted partial invoices). Online payment asks for exactly that amount – Stripe Checkout (*Jetzt bezahlen*, one line *Restbetrag Rechnung …* once something is paid, credited or deducted), the PayPal.me link, the GiroCode and SEPA collection – and a Stripe payment is booked for what arrived, never more than is open ([stripe.md](stripe.md#was-beim-bezahlen-passiert)). **PayPal and Mollie** take the open amount the same way through the pay page, and a **gift card** is booked as a payment *Gutschein* – both through `recordPayment` with the same rules ([payment-providers.md](payment-providers.md#what-happens-when-the-money-arrives), [store.md](store.md#gift-cards)).

Finalised, open invoices can also be **collected by SEPA direct debit** with your own mandate ([sepa.md](sepa.md)): the collection is recorded as a payment of the method *SEPA-Lastschrift*, a return as a reversal, and the audit trail shows *SEPA-Lastschrift eingereicht*.

## API, events and MCP

| Endpoint | |
| --- | --- |
| `POST /api/invoices/:id/finalise` · `GET …/precheck` | Finalise / what blocks or warns |
| `POST …/storno` · `POST …/credit-note` · `POST …/convert` | Storno (`reason`, `send`; 409 once credit notes exist), credit note (`items`, `reason` – or `remainder: true` for the rest), quote → invoice (`inv_type`) |
| `GET/POST …/payments` · `POST …/payments/:pid/revert` | Payments (`amount_cents`, `paid_at`, `method`, `note`, `skonto`) and taking one back (a reversal row, nothing is deleted) |
| `GET …/pdf` · `GET …/xrechnung?syntax=cii\|ubl[&format=json]` · `GET …/zugferd?profile=en16931\|xrechnung[&format=json[&include_pdf=1]][&download=1]` · `GET …/einvoice/check` | Files and the preview check |
| `GET …/documents` · `GET …/documents/:docId/download` | The archive of the invoice |
| `GET …/audit` · `GET …/verify` | Trail and integrity check |
| `POST /api/invoices/vat-check` | Format (and optional VIES) check of a VAT ID |
| `GET/PUT /api/invoice-settings` | Settings and ranges |

`PATCH /api/invoices/:id` with `{ status }` follows the state machine above; fields that are frozen answer **409** with `{ locked: true, field }`.

Every invoice in the API carries `state`, `state_label`, `open_cents` and `days_overdue` – calendar days past the due date in the sub-account's time zone (0 on the due day itself and for anything that is not open; the same count as [dunning](dunning.md#overdue-invoices)).

**Events** on the internal event bus (other modules listen to them; there are no workflow triggers for the new ones yet): `invoice.finalised`, `invoice.partially_paid`, `invoice.paid`, `invoice.cancelled`.

**MCP tools:** `ghl_invoice_finalise`, `ghl_invoice_cancel` (creates the Stornorechnung; destructive hint), `ghl_invoice_credit_note`, `ghl_invoice_record_payment`, `ghl_invoice_xrechnung` (returns the XML), `ghl_invoice_zugferd` (ZUGFeRD-PDF: file name, SHA-256, the embedded XML and the download path; `include_pdf: true` adds the PDF as Base64), `ghl_quote_to_invoice`. The existing `ghl_list_invoices`, `ghl_link_invoice` and `ghl_pm_invoice_time` keep working and show the new `state`, `number` (empty for drafts) and amounts.

## Limits and open questions

- **ZUGFeRD is not strictly PDF/A-3.** The ZUGFeRD-PDF has the attached XML, XMP, extension schema and sRGB output intent, but the fonts are not embedded, so a strict PDF/A-3b validator rejects the PDF part (see [above](#zugferd--factur-x-pdf-with-the-xml-inside)). Profiles MINIMUM, BASIC WL, BASIC and EXTENDED are not offered. For authorities send the **XRechnung**.
- **Validation** is the built-in rule set, not KoSIT's complete Schematron – see above.
- **No transport** to Peppol or the federal portals; download and upload.
- **VIES** is the simple lookup, not the *qualified confirmation* (qualifizierte Bestätigungsabfrage with proof for the tax office); do that at the BZSt if a dispute is likely.
- **Rounding.** VAT per rate is the EN 16931 way; some accounting programs round per line. A receiver that recomputes per line can see a one-cent difference on invoices with many lines – the document is correct as stated.
- **Paid in part, credited for the rest.** Such an invoice has nothing open but keeps the status *sent* (state *offen*): it is no longer dunned, counted as overdue or offered for payment, but it is not closed either. Whether it should become *paid* (what happens when the payment comes last) depends on how revenue should count credit notes that are not refunded – open for a decision.
- **Corrections.** HyperLevel offers Storno plus a new invoice, and partial credit notes. A correction of a *Kleinunternehmer* invoice that wrongly showed VAT (§ 14c UStG) needs a tax advisor.
- **Verfahrensdokumentation.** The app helps with the technical part (immutability, audit trail, archive); the process documentation and the retention of the backups are yours.
- Open for your tax advisor: whether the *Leistungsdatum* default "same as the invoice date" is acceptable in your cases; the e-invoice transition rules for your turnover; the retention of the XRechnung as the "original" (the XML is the original, the PDF a visualisation).
