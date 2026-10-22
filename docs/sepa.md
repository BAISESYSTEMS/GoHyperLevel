# SEPA direct debit and transfer files (without Stripe)

**Umsatz → SEPA** collects open invoices by **SEPA direct debit with your own mandate** and writes **transfer files** for supplier invoices and payout lists – no payment provider, no fees per transaction. HyperLevel writes the ISO 20022 files; you upload them in your online banking. HyperLevel never connects to a bank.

- **Mandates** per contact: on paper (you record them) or **online** through a personal link with the legally required mandate text and a proof of consent.
- **Collection runs:** open finalised invoices of contacts with a valid mandate → preview grouped by sequence type → **pre-notification** e-mails → **pain.008.001.08** file → invoices marked *SEPA-Lastschrift eingereicht*.
- **Paid and returned collections** go through the invoice flow (the same payment records as a manual payment): a return (*Rücklastschrift*) reopens the invoice, keeps the reason code and can bill a return fee.
- **Transfers:** **pain.001.001.09** for booked, unpaid supplier invoices (*Buchhaltung → Belegeingang*) and/or a manual payout list.

Everything is per sub-account and belongs to the permission area **Rechnungen & Produkte** (`payments`).

- [Set up](#set-up)
- [Mandates](#mandates)
- [The online mandate page](#the-online-mandate-page)
- [Collection runs](#collection-runs)
- [Paid, returned, withdrawn](#paid-returned-withdrawn)
- [Transfer files](#transfer-files)
- [For developers](#for-developers)
- [Limits and good to know](#limits-and-good-to-know)

## Set up

1. **Creditor identifier (Gläubiger-ID).** Apply for it free of charge at the Deutsche Bundesbank (online form, a few days); outside Germany at your central bank. Enter it in *SEPA → Einstellungen*. HyperLevel checks the format and the check digits (ISO 7064 mod 97 over the national part – the three-letter business code is not part of the check; German ids have 18 characters, e.g. the Bundesbank test id `DE98ZZZ09999999999`).
2. **Your account.** The IBAN/BIC the collections are paid into and transfers are made from. Empty = the bank details of *Einstellungen → Rechnungen*. The creditor name defaults to the invoice sender.
3. **Your bank.** Most banks need a separate agreement for direct debits (*Inkassovereinbarung*, with a limit) before they accept pain.008 files. Ask whether they accept **pain.008.001.08 / pain.001.001.09** (the current versions of the German banking industry's specification since November 2023) and whether you upload through online banking or EBICS.
4. **Pre-notification (Vorabankündigung).** Default **14 days** before the collection date. A shorter period (at least **1 day**) is only valid if it was agreed – HyperLevel writes the period you set into the mandate text, so it is part of every new mandate. The e-mail text is editable (placeholders `{{due_date}}`, `{{total}}`, `{{items}}`, `{{iban}}` (masked), `{{mandate_reference}}`, `{{creditor_id}}`, `{{creditor_name}}`, `{{contact.first_name}}`, `{{location.name}}`).
5. **A sender for e-mail** (*Einstellungen → Kanäle*) – pre-notifications, mandate links and confirmations are transactional mails (no marketing consent needed, *Nicht stören* does not block them). With the provider *log* they are only recorded.

Other settings: prefix of the mandate reference (`M-` → `M-2026-000001`), how long an online mandate link stays valid (default 30 days), default scheme (CORE/B2B), **batch booking** (off by default: every collection is its own line on your statement, so the bank match of *Buchhaltung → Bank* finds each invoice by its number), and a suggested return fee.

## Mandates

*SEPA → Mandate.* A mandate belongs to a contact and has:

| Field | Meaning |
| --- | --- |
| Mandatsreferenz | Unique per sub-account, up to 35 characters `A–Z a–z 0–9 + ? / - : ( ) . , '`, no spaces, no leading `/`, no `//`. Empty = the next number. A paper mandate's reference must be exactly the one printed on it. |
| Lastschriftart | **CORE** (*Basislastschrift*, consumers and businesses, the payer can ask for a refund within 8 weeks) or **B2B** (*Firmenlastschrift*, businesses only, no refund – the payer must also register the mandate with their bank). |
| Mandat für | **wiederkehrend** (RCUR) or **einmalig** (OOFF, exactly one collection). |
| Kontoinhaber, IBAN, BIC | IBAN with mod-97 check and a SEPA country; the BIC is optional inside the EEA and **mandatory** for accounts in CH, GB, MC, SM, AD, VA, the Channel Islands and other non-EEA SEPA countries – where the payer's town and country are mandatory too (they go into the file as a structured address). |
| Unterschrieben am / Ort | Date of signature (goes into every collection as `DtOfSgntr`). |

**Sequence types** are tracked per mandate: the first collection is **FRST**, every further one **RCUR**. A first collection that comes back (or a withdrawn file) does not count – the next one is FRST again. A one-off mandate uses **OOFF** and is *verbraucht* after its collection; mark *Nächster Einzug ist der letzte* and the next collection is **FNAL**, after which the mandate is *beendet*.

**Status:** *Wartet auf Unterschrift* (online, link open) → *Aktiv* → *Widerrufen* (by you, or by the return codes AC04, MD01, MD07), *Gesperrt* (by the return codes AC01, AC06, AC13, AG01, MD02, RC01, SL01 – check the data, then *Wieder freigeben*) or **Abgelaufen**: a mandate expires when **36 months** pass without a collection (counted from the last collection, or the signature if it was never used). A daily job marks expired mandates; they never get into a run.

Account data cannot be changed after the first collection – record a new mandate instead. Lists and mails only show the IBAN masked (`DE89 •••• 3000`); the detail dialog shows it in full.

## The online mandate page

*Online-Mandat anfordern* creates a pending mandate and a link `https://<your-domain>/sepa/m/<token>` (random, per mandate; optionally sent by e-mail). The page shows the full mandate text – creditor, creditor identifier, mandate reference, the authorisation and the refund notice in the wording of the German banking industry, and the agreed pre-notification period – and asks for account holder, IBAN, optional BIC, address, place and a tick *Ich erteile dieses SEPA-Lastschriftmandat*.

On submit HyperLevel stores, as the **proof of consent** (the same minimised evidence the consent ledger keeps, `services/consent.ts`): the time, the **IP network** (/24 resp. /48, not the full address), a fingerprint of the browser string, the **SHA-256 of the exact text** shown (the form carries the hash; if the text changed in between, the person is asked to read it again) and the text itself. The person gets a confirmation e-mail with the mandate text. The page is server-rendered without scripts, `noindex`, rate-limited, and shows nothing but this mandate; once signed, the link only shows a confirmation with the masked IBAN. A revoked mandate's link stops working; an expired link can be renewed (*Neuen Link*).

> An online mandate without a qualified signature is accepted by banks in practice, but in a dispute the creditor has to prove the mandate – keep the proof, and expect a refund claim of up to 13 months for an unauthorised collection. B2B mandates additionally have to be confirmed by the payer to their bank.

## Collection runs

*SEPA → Einzug.*

1. The list shows **finalised, open invoices in euro** of contacts with an **active mandate** (the newest active one per contact) that are not in a run yet, with the open amount (after partial payments, credit notes and deducted partial invoices) and the sequence type. A one-off mandate takes only the oldest invoice.
2. Choose the **collection date**: at least the pre-notification period from today and at least one TARGET2 business day ahead (no weekends, 1 Jan, Good Friday, Easter Monday, 1 May, 25/26 Dec). The **preview** shows one block per scheme and sequence type with count and sum.
3. **Lauf anlegen** creates a draft run and sends the **pre-notification** – one e-mail per mandate listing its invoices, amounts, date, masked IBAN, mandate reference and creditor identifier. Contacts without an e-mail address are flagged (deliver it yourself, then *Vorabankündigung erneut senden* or proceed). Untick *per E-Mail senden* if you pre-notify another way (e.g. on the invoice).
4. **Einreichen** (*Läufe → Lauf*), at the latest one TARGET2 day before the collection date: HyperLevel checks every invoice again (an invoice paid, cancelled or with a changed open amount since the pre-notification is taken out – a new amount needs a new pre-notification), writes the **pain.008.001.08** file and marks the invoices *SEPA-Lastschrift eingereicht* in their audit trail. Download the XML and upload it to your bank.

The file: one `PmtInf` block per scheme, sequence type and date with `NbOfTxs` and `CtrlSum`, header totals over all blocks, `MsgId` per run, `PmtInfId` = `MsgId-<n>`, **`EndToEndId` = the invoice number** (it comes back on your bank statement and on returns), mandate id and date of signature, creditor identifier as `CdtrSchmeId`, `BICFI` where a BIC is known (`NOTPROVIDED` otherwise), text reduced to the SEPA character set (umlauts spelled out).

While a collection is with the bank, the invoice gets a **Mahnstopp** (*Mahnwesen*) with the reason *SEPA-Lastschrift eingereicht*; a return or a withdrawn file lifts it again (a hold you set yourself is never touched).

## Paid, returned, withdrawn

- **Bezahlt** (per item or *Alle als bezahlt*): records the payment on the invoice through the invoice flow (`recordPayment`, method *SEPA-Lastschrift*, source `sepa`) – the invoice becomes paid, `invoice.paid` runs, accounting books it like any other payment. An invoice that gets paid another way (bank match, by hand) settles its collection automatically.
- **Rücklastschrift**: choose the **reason code** your bank reports (AM04 *Keine ausreichende Deckung*, MD06/MS02 *Widerspruch*, AC04 *Konto erloschen*, MD01 *Kein gültiges Mandat* …). The payment is taken back (`revertPayment` – a reversal row, the invoice is open again; for a collection the bank match had booked, the matching payment is reversed), the code is kept on the item and in the invoice's audit trail, the mandate is blocked or ended for codes that make it unusable, the workflow trigger `sepa.returned` runs. Optionally the **return fee** of your bank becomes a draft invoice to the customer (*Rücklastschriftgebühr*, as non-taxable damages – check it before finalising; only pass on the real bank costs). The invoice can then be collected again in a new run (with a new pre-notification) or go to dunning.
- **Verwerfen / Zurückziehen**: a draft run can be thrown away; a submitted run whose file the bank rejected as a whole can be withdrawn as long as nothing in it is marked paid or returned – the mandates get their sequence state back and the invoices' audit trail says *zurückgezogen*.

A run closes once every item is paid or returned. *Läufe* is the history of all runs (direct debits and transfers) with their files.

## Transfer files

*SEPA → Überweisungen* writes **pain.001.001.09** from your own account:

- **Open supplier invoices**: receipts of *Buchhaltung → Belegeingang* that are booked, not credit notes and not yet paid (`payment = open`), with the supplier's IBAN from the receipt. The supplier's invoice number is the `EndToEndId`. HyperLevel does not book the payment: the bank match of the accounting does that when the statement arrives (it finds the invoice number in the purpose).
- **Manual payout list**: name, IBAN, optional BIC (mandatory outside the EEA), amount, purpose – refunds, fees, anything.

The file is ready at once (no pre-notification for transfers); a receipt in a transfer file is not offered again. The affiliate payouts (*Affiliates → Auszahlungen*) keep their own export and use the same file builder.

## For developers

- `server/modules/sepa.ts` – tables (`sepa_settings`, `sepa_mandates`, `sepa_runs`, `sepa_items`), the routes under `/api/sepa`, the daily expiry job, the `invoice.paid` listener, the workflow triggers `sepa.mandate_signed` and `sepa.returned`, DSGVO hooks (`privacyExport`; `privacyErase` deletes unused mandates and keeps used ones and the collections without the link to the contact – they are payment records). Registered with one line (`...sepaModules`) in `server/modules/index.ts`.
- `server/modules/sepa-public.ts` – `GET/POST /sepa/m/:token`. `server/modules/sepa-tools.ts` – MCP tools `ghl_sepa_mandates`, `ghl_sepa_runs` (read-only).
- `server/services/sepa-model.ts` (pure: creditor id, IBAN/BIC, references, mandate text and hash, sequence types, expiry, TARGET2 days, return codes, settings), `sepa-xml.ts` (pure ISO 20022 builder: `creditTransferXml` for pain.001.001.09 and .03, `directDebitXml` + `groupDebits` for pain.008.001.08, `sepaText`/`sepaId`), `sepa-mandates.ts`, `sepa-runs.ts`.
- Payment state only changes through `recordPayment`/`revertPayment` (`services/invoice-flow.ts`), audit lines through `invAudit`, fee drafts through `createInvoice` (`modules/payments.ts`), the Mahnstopp through the dunning route (`callRoute`). OpenAPI entries: `server/services/openapi-sepa.ts`. Page: `web/src/pages/Sepa.tsx` + `SepaRuns.tsx` (lazy chunk), Akademie tour `web/src/tour/content/sepa.ts`.
- Tests: `tests/sepa-model.test.ts` (checks, sequence logic, XML shape and control sums), `tests/sepa.test.ts` (API, public page, runs, returns, transfers, isolation); the tenant-isolation harness seeds SEPA records (`tests/security-fixtures.ts`).

API overview (all `location` routes; details in `/api/docs.html`, tag *SEPA*):

| Route | What |
| --- | --- |
| `GET /api/sepa/overview` | Ready?, problems, counts and sums |
| `GET/PUT /api/sepa/settings` | Settings, effective creditor data, return codes |
| `GET/POST /api/sepa/mandates`, `POST /api/sepa/mandates/request` | List; paper mandate; online mandate (`send: true` mails the link) |
| `GET/PATCH /api/sepa/mandates/:id`, `POST …/revoke`, `…/reactivate`, `…/link` | Detail with proof and collections; note, `final_next`; end; unblock; new link |
| `GET /api/sepa/candidates`, `POST /api/sepa/runs/preview`, `POST /api/sepa/runs` | Collectable invoices; preview; create run (`notify: false` = pre-notified otherwise) |
| `GET /api/sepa/runs`, `GET /api/sepa/runs/:id`, `GET …/xml` | History; run with items; the file |
| `POST /api/sepa/runs/:id/submit`, `…/notify`, `…/cancel`, `…/paid` | Submit; resend pre-notifications; discard/withdraw; all paid |
| `POST /api/sepa/items/:id/paid`, `POST /api/sepa/items/:id/return` | One item paid; return (`code`, `fee_cents`, `fee_invoice`) |
| `GET /api/sepa/payables`, `POST /api/sepa/transfers` | Open supplier invoices; transfer file (`receipt_ids`, `lines`) |

## Limits and good to know

- **No bank connection** (no EBICS, no FinTS): files are uploaded by hand, returns are entered by hand from your bank's notice. Return files (pain.002/camt.054) are not read yet.
- Only **EUR**; one creditor identifier and one account per sub-account.
- The XML follows the structure of the DK specification (*Anlage 3*, pain.008.001.08 / pain.001.001.09); it is checked by tests for namespaces, control sums and grouping, not against the official XSD. Upload a first small run and check your bank's validation report.
- Mandate amendments (`AmdmntInd`, e.g. a new IBAN under the same reference) are not written – record a new mandate.
- Holder and BIC can be corrected until the first collection; a new IBAN needs a new mandate. There is no self-service for payers yet (they ask you, you send a new mandate link).
- Keep paper mandates (and the online proof) for at least 14 months after the last collection – and the files, as they are payment records.
- Not legal or tax advice: the mandate text follows the German banking industry's templates; check the pre-notification period and the return fee against your contracts.
