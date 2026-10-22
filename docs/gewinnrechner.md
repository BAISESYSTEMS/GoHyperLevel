# Gewinnrechner (profit calculator)

"What do I earn at which price and how many customers – after VAT, payment fees, running costs, acquisition costs and taxes?" The Gewinnrechner answers that for any pricing model: a flat price per company, per seat, per location with included units, a step price and a cap, size bands by team size (Solo / Team / Firma), agency tiers by client accounts, or a mix of all of them. It was built to price HyperLevel Cloud itself, and works just as well for an agency retainer, a course membership or a craftsman's job.

Where: **Umsatz → Gewinnrechner** (route `/app/calc`). Training for the team: **Akademie → Gewinnrechner: Was bleibt übrig?**.

> **Schätzung, keine Steuerberatung.** The numbers are a planning aid with simplified assumptions. The tax part is an estimate, not tax advice; the notice is shown on the page, in every API answer and in the CSV export. Have the result checked by your Steuerberater before you rely on it.

What you get:

- **Input panel + six presets** (HyperLevel Staffel, HyperLevel Standort-Modell, SaaS pro Nutzer, Agentur-Retainer, Kurs/Community, Handwerk).
- **One-sentence answer** and the key figures: revenue, after variable costs, EBIT, net profit, break-even, MRR/ARR, customer value (LTV), LTV/CAC, payback.
- **Heatmap matrix** customers × price points with a metric selector (revenue gross/net, after variable costs, EBIT, net profit after taxes, margin), per month or per year. A click on a cell shows its calculation.
- **Waterfall** (payments → VAT → fees → variable → fixed → acquisition → taxes → net profit), **tornado** (which input moves the net profit most) and a **12/24/36-month projection** with customer growth and churn – all hand-made SVG, no chart library.
- **Scenarios** per sub-account: save, reopen, compare up to six side by side, CSV export (German spreadsheet format).
- **API, MCP tools and the HyperLevel Agent** use exactly the same engine, so "what does 300 customers on the Standort-Modell leave me?" gets the same answer in the browser, from a script and from Claude.

Nothing to set up: no credentials, no environment variables, no outgoing requests. The calculation runs in the browser; only saving a scenario talks to the server.

## How a number is calculated

A **cell** is one steady-state month with *N* active customers at one set of prices. Everything is computed per customer and multiplied by *N*, so the matrix, the break-even and the projection all agree.

1. **Customers per plan.** The plans' `mix` values are scaled to 100 %. Within a plan, customers are spread over a **distribution of units** (`customers.unit_mix`, e.g. 35 % with 1 location, 3 % with 30), or the plan's `avg_units`, or `customers.avg_units`. A distribution is more exact than an average because caps and included units do not act linearly.
2. **Price per customer:** `base_price + max(0, units − included_units) × unit_price`, limited by `cap` (0 = no cap). The cap acts **per customer**, not on the average. *Examples:* flat per company = base price only; per seat = base price 0 and a unit price; HyperLevel Standort-Modell = 49 € incl. 3 locations, +10 € each, cap 499 €.
3. **Add-ons** add `price × take_rate` (× units for per-unit add-ons). **Prices are net or gross** (`pricing.price_basis`): a gross price of 119 € is 100 € net at 19 % VAT.
4. **Annual payers:** the share that pays yearly gets `discount` percent off (16.7 % = two months free), so the average revenue drops by `share × discount`. The payment fee is then charged once a year, not twelve times.
5. **Umsatzsteuer.** Domestic customers carry the VAT rate (19 / 7 / 0 %). EU business customers pay **no** German VAT (reverse charge), EU consumers the VAT of their country (one-stop shop, default 21 %). **Kleinunternehmer** (§ 19 UStG) charge no VAT, but cannot deduct input VAT, so purchases cost gross. The VAT is not revenue – the waterfall shows it as the first step.
6. **Payment fees** fall on the **gross** charge: per method `pct × gross + fixed`, limited by `cap`, blended by share (default: Stripe EU cards 1.5 % + 0.25 €). The setup fee is its own charge. Customers who pay through an app store pay no payment fee but the store fee.
7. **Variable costs per month:** hosting, AI tokens and e-mail/SMS (each per customer, per user and per unit), support (minutes × hourly rate), other, partner commission (percent of the net revenue of the referred share) and app-store fees.
8. **Fixed costs** per month, and **CAC** for every new customer. In a steady-state month the new customers are the ones replacing the churn (`N × churn`), so no churn means no acquisition cost – and the **setup fees** come in with the same customers.
9. **EBIT** = net revenue − variable costs − fixed costs − acquisition costs.
10. **Taxes** are computed on the yearly profit (12 × the month) by legal form (below). **Net profit** = EBIT − taxes − Vorsorge (health and pension insurance of a sole proprietor, entered as a monthly amount).

### Key figures

| Figure | Definition |
| --- | --- |
| ARPU | recurring net revenue per customer and month (all plans, units, VAT segments) |
| Contribution per customer | ARPU minus payment fees and variable costs |
| Lifetime | `1 / churn`, at most `max_lifetime_months` |
| LTV | contribution × lifetime + setup fee (net of its fee) |
| LTV / CAC | LTV divided by the cost per new customer (3× or more is the usual rule of thumb) |
| Payback | `(CAC − setup fee) / contribution` months until a new customer has paid for his acquisition |
| Break-even | smallest number of customers with EBIT ≥ 0 – and, separately, with net profit ≥ 0 after taxes and Vorsorge |
| Minimum price | lowest base price of the reference plan at which the chosen customer count reaches EBIT 0 |
| MRR / ARR | recurring net revenue per month / times twelve |

### Projection

`customers(t) = customers(t−1) × (1 − churn) + new(t)`, billed on the customers at the end of the month; `new(t)` starts at `growth.monthly_new` and grows by `growth.monthly_new_growth` percent a month. Taxes are computed per fiscal year of twelve months and spread evenly; the one-time investment (`costs.fixed.one_time`) is deducted in month 1. The **break-even month** is the first month after which the cumulative profit stays at or above zero.

### Tornado

Every lever is moved by ± `matrix.sensitivity_pct` (default 20 %) with everything else fixed, and the yearly net profit is recalculated: customers, prices, churn, units per customer, add-on bookings, payment fees, hosting, AI, e-mail/SMS, support, partner commission, CAC and fixed costs. Bars are sorted by their swing.

## Taxes (estimate)

| Legal form | What is calculated |
| --- | --- |
| *Einzelunternehmen / Freiberufler* | Einkommensteuer by the **§ 32a EStG** Grundtarif (or Splittingtarif for joint assessment) on profit + other income − Vorsorge − deductions, income rounded down to full euros; **Solidaritätszuschlag** with Freigrenze and Milderungszone; optional Kirchensteuer (8 / 9 %); **Gewerbesteuer** with Hebesatz, Freibetrag 24,500 € and the credit against the income tax under **§ 35 EStG** (4.0 × the Messbetrag, at most the Gewerbesteuer and at most the share of the income tax that falls on the business income). Freiberufler pay no Gewerbesteuer: switch it off. With *other income* only the extra tax caused by the profit counts. |
| *GmbH / UG* | Körperschaftsteuer 15 % + Soli 5.5 % on it, Gewerbesteuer without a Freibetrag (and without § 35); optionally the Abgeltungsteuer (25 % + Soli) on the share of the profit that is paid out. A managing director's salary belongs in the fixed costs (*Gehälter*) – the calculator warns when it is 0. |
| *Keine* | no taxes: net profit is the result before taxes |

**Sources and parameters.** The tariff coefficients are plain input fields (*Steuern → Tarifwerte bearbeiten*, `tax.est.*`), so a new year is a data change, not a code change. Built in and labelled by year:

| Year | Grundfreibetrag | Zone 2 ends | Zone 3 ends | Soli-Freigrenze (single) |
| --- | --- | --- | --- | --- |
| 2024 | 11,604 € | 17,005 € | 66,760 € | 18,130 € |
| 2025 | 12,096 € | 17,443 € | 68,480 € | 19,950 € |
| **2026** (default) | 12,348 € | 17,799 € | 69,878 € | 20,350 € |

2025 and 2026 follow the **Steuerfortentwicklungsgesetz** (higher Grundfreibetrag and shifted zone borders; 42 % from the end of zone 3 up to 277,825 €, 45 % above). 2026 is the newest enacted tariff at the time of writing – pick the year in the tax box, or set `tax.est: { year: 2025 }` in the API to load another one. **Check the values against the current BMF notice (Programmablaufplan / Lohnsteuer-Tabellen) before relying on them.**

Reference values the tests assert against an independent implementation of the formula (Grundtarif 2026, zu versteuerndes Einkommen → Einkommensteuer, rounded down to full euros): 15,000 € → 435 €, 30,000 € → 4,217 €, 60,000 € → 14,233 €, 100,000 € → 30,864 €, 300,000 € → 115,529 €.

**What is deliberately not modelled** (all of these change the real bill): Verlustvortrag, Kinderfreibeträge and other allowances (use *Weitere Abzüge*), Hinzurechnungen and Kürzungen beyond a flat amount, Investitionsabzugsbetrag and depreciation, income tax on a managing director's salary, Kirchensteuer on dividends, the Vorauszahlungs schedule, and anything about timing within the year.

## Inputs

The whole input is one JSON object. Everything is optional: missing fields take the defaults below, unknown fields are an **error** (an agent typing `custmers` must not get a silently wrong answer), lists are replaced as a whole, objects merge field by field. `GET /api/calc/schema` returns the same as a JSON Schema (draft 2020-12) with a `description` and `default` on every field. Amounts are euros, "pro Monat" unless noted, percentages are 0–100.

The *Meaning* column is the German text the page shows as a tooltip on each field.

<!-- defaults:start -->
| Field | Type | Unit | Default | Meaning |
| --- | --- | --- | --- | --- |
| `pricing.price_basis` | net \| gross |  | `net` | Preise sind Netto (ohne USt) oder Brutto (inkl. deutscher USt, wie sie Endkunden sehen) |
| `pricing.plans[]` | Liste |  | `[Standard]` | Tarife mit Kunden-Mix (Staffeln nach Teamgröße, Agentur-Stufen, Standort-Modell …) |
| `pricing.plans[].name` | Text |  | `Standard` | Name des Tarifs (z. B. Solo, Team, Agentur Pro) |
| `pricing.plans[].mix` | Zahl | % | `100` | Anteil der Kunden in diesem Tarif; die Anteile aller Tarife werden auf 100 % hochgerechnet |
| `pricing.plans[].base_price` | Zahl | €/Monat | `49` | Pauschalpreis pro Kunde und Monat (Staffelpreis, nicht pro Nutzer) |
| `pricing.plans[].included_units` | Zahl |  | `0` | Im Grundpreis enthaltene Einheiten (Standorte, Nutzer oder Kunden-Accounts) |
| `pricing.plans[].unit_price` | Zahl | €/Monat | `0` | Preis je weiterer Einheit über den enthaltenen hinaus (Stufenpreis) |
| `pricing.plans[].cap` | Zahl | €/Monat | `0` | Deckel: höchster Monatspreis (0 = kein Deckel) |
| `pricing.plans[].setup_fee` | Zahl | € | `0` | Einmalige Einrichtungsgebühr pro Neukunde |
| `pricing.plans[].users` | Zahl |  | `1` | Durchschnittliche Nutzer pro Kunde in diesem Tarif (für Kosten pro Nutzer) |
| `pricing.plans[].avg_units` | Zahl |  | `0` | Durchschnittliche Einheiten pro Kunde in diesem Tarif; 0 = Kundeneinstellungen (Verteilung oder Durchschnitt) gelten |
| `pricing.plans[].extra_cost` | Zahl | €/Monat | `0` | Zusätzliche variable Kosten pro Kunde dieses Tarifs (z. B. White-Label-App) |
| `pricing.plans[].note` | Text |  | – | Hinweis zum Tarif (z. B. „2–99 Nutzer“, „bis 5 Clients“) |
| `pricing.annual.share` | Zahl | % | `0` | Anteil der Kunden, die jährlich im Voraus zahlen |
| `pricing.annual.discount` | Zahl | % | `16.7` | Rabatt bei Jahreszahlung (16,7 % = zwei Monate gratis) |
| `pricing.addons[]` | Liste |  | `[]` | Add-ons (zubuchbar) |
| `pricing.addons[].name` | Text |  | `Add-on` | Name |
| `pricing.addons[].price` | Zahl | €/Monat | `0` | Preis pro Monat |
| `pricing.addons[].take_rate` | Zahl | % | `0` | Anteil der Kunden, die es buchen |
| `pricing.addons[].per_unit` | ja/nein |  | `false` | Preis gilt je Einheit (Standort/Nutzer) statt je Kunde |
| `customers.count` | Zahl (ganz) |  | `100` | Anzahl zahlender Kunden für die Einzelrechnung („Was verdiene ich bei … Kunden?“) |
| `customers.avg_units` | Zahl |  | `1` | Durchschnittliche Einheiten (Standorte/Nutzer/Accounts) je Kunde, wenn keine Verteilung angegeben ist |
| `customers.unit_mix[]` | Liste |  | `[]` | Verteilung der Einheiten je Kunde, z. B. 40 % mit 1 Standort, 10 % mit 30 (genauer als ein Durchschnitt, weil Deckel und Inklusiv-Einheiten nicht linear wirken) |
| `customers.unit_mix[].units` | Zahl |  | `1` | Einheiten |
| `customers.unit_mix[].share` | Zahl | % | `0` | Anteil der Kunden |
| `customers.b2b_share` | Zahl | % | `80` | Anteil Geschäftskunden (B2B); wichtig für die Umsatzsteuer bei Kunden im EU-Ausland |
| `customers.eu_share` | Zahl | % | `0` | Anteil der Kunden in anderen EU-Ländern (B2B: Reverse Charge ohne USt, B2C: USt des Landes) |
| `customers.churn` | Zahl | % pro Monat | `3` | Kündigungsquote pro Monat |
| `customers.max_lifetime_months` | Zahl | Monate | `60` | Obergrenze der Kundenlebensdauer für den Kundenwert (LTV), z. B. wenn die Kündigungsquote 0 ist |
| `customers.growth.start` | Zahl (ganz) |  | `0` | Kunden zu Beginn |
| `customers.growth.monthly_new` | Zahl |  | `10` | Neukunden pro Monat |
| `customers.growth.monthly_new_growth` | Zahl | % pro Monat | `0` | Wachstum der Neukunden pro Monat (z. B. 2 = jeden Monat 2 % mehr Neukunden) |
| `customers.growth.months` | Zahl (ganz) | Monate | `36` | Länge der Prognose |
| `vat.rate` | Zahl | % | `19` | Umsatzsteuersatz im Inland (19, 7 oder 0) |
| `vat.kleinunternehmer` | ja/nein |  | `false` | Kleinunternehmer (§ 19 UStG): keine USt auf Umsätze, aber auch keine Vorsteuer – Einkäufe kosten brutto |
| `vat.eu_b2c_rate` | Zahl | % | `21` | USt-Satz für Privatkunden im EU-Ausland (One-Stop-Shop, Durchschnitt) |
| `vat.input_rate` | Zahl | % | `19` | Vorsteuersatz der Einkäufe (nur für Kleinunternehmer relevant) |
| `costs.variable.payment.methods[]` | Liste |  | `[Karte (EU)]` | Zahlungsarten mit Anteil und Gebühr (Richtwerte, beim Anbieter prüfen); die Gebühr fällt auf den Bruttobetrag je Abbuchung an |
| `costs.variable.payment.methods[].label` | Text |  | `Karte (EU)` | Name |
| `costs.variable.payment.methods[].share` | Zahl | % | `100` | Anteil der Zahlungen |
| `costs.variable.payment.methods[].pct` | Zahl | % | `1.5` | Prozent vom Bruttobetrag (Stripe, EU-Karten: 1,5 %) |
| `costs.variable.payment.methods[].fixed` | Zahl | € | `0.25` | Fester Betrag je Abbuchung (Stripe: 0,25 €) |
| `costs.variable.payment.methods[].cap` | Zahl | € | `0` | Höchstgebühr je Abbuchung (0 = keine) |
| `costs.variable.hosting.per_customer` | Zahl | €/Monat | `1` | Hosting: pro Kunde und Monat |
| `costs.variable.hosting.per_user` | Zahl | €/Monat | `0` | Hosting: pro Nutzer und Monat |
| `costs.variable.hosting.per_unit` | Zahl | €/Monat | `0` | Hosting: pro Einheit (Standort/Account) und Monat |
| `costs.variable.ai.per_customer` | Zahl | €/Monat | `1.5` | KI-Token: pro Kunde und Monat |
| `costs.variable.ai.per_user` | Zahl | €/Monat | `0` | KI-Token: pro Nutzer und Monat |
| `costs.variable.ai.per_unit` | Zahl | €/Monat | `0` | KI-Token: pro Einheit (Standort/Account) und Monat |
| `costs.variable.messaging.per_customer` | Zahl | €/Monat | `0.5` | E-Mail/SMS: pro Kunde und Monat |
| `costs.variable.messaging.per_user` | Zahl | €/Monat | `0` | E-Mail/SMS: pro Nutzer und Monat |
| `costs.variable.messaging.per_unit` | Zahl | €/Monat | `0` | E-Mail/SMS: pro Einheit (Standort/Account) und Monat |
| `costs.variable.support.minutes_per_customer` | Zahl | Min. | `5` | Support-Minuten pro Kunde und Monat |
| `costs.variable.support.hourly_rate` | Zahl | €/Std. | `45` | Stundensatz für Support (Vollkosten) |
| `costs.variable.other.per_customer` | Zahl | €/Monat | `0` | Sonstige variable Kosten pro Kunde und Monat |
| `costs.variable.other.pct_of_revenue` | Zahl | % | `0` | Sonstige variable Kosten in Prozent vom Netto-Umsatz |
| `costs.variable.referral.commission_pct` | Zahl | % | `20` | Provision in Prozent vom Netto-Umsatz der vermittelten Kunden (dauerhaft) |
| `costs.variable.referral.share` | Zahl | % | `0` | Anteil der Kunden, die über Partner kommen |
| `costs.variable.app_store.fee_pct` | Zahl | % | `15` | Store-Gebühr in Prozent vom Netto-Umsatz (Apple/Google: 15–30 %) |
| `costs.variable.app_store.share` | Zahl | % | `0` | Anteil der Kunden, die über einen App-Store zahlen (dann fallen keine Zahlungsgebühren an) |
| `costs.fixed.servers_tools` | Zahl | €/Monat | `150` | Server und Software-Werkzeuge |
| `costs.fixed.salaries` | Zahl | €/Monat | `0` | Gehälter inkl. Nebenkosten (ohne Unternehmerlohn) |
| `costs.fixed.insurance` | Zahl | €/Monat | `50` | Versicherungen |
| `costs.fixed.marketing` | Zahl | €/Monat | `500` | Marketing (laufend) |
| `costs.fixed.other` | Zahl | €/Monat | `100` | Sonstige Fixkosten (Buchhaltung, Büro …) |
| `costs.fixed.one_time` | Zahl | € | `0` | Einmalige Anfangsinvestition (nur Prognose; wird im ersten Monat abgezogen) |
| `costs.cac` | Zahl | € | `150` | Kosten je Neukunde (CAC: Werbung, Vertrieb, Onboarding) |
| `tax.legal_form` | einzelunternehmen \| kapitalgesellschaft \| keine |  | `einzelunternehmen` | Rechtsform: Einzelunternehmen (ESt), GmbH/UG (KSt) oder keine Steuern (Ergebnis vor Steuern) |
| `tax.est.year` | Zahl (ganz) |  | `2026` | Veranlagungsjahr der Tarifwerte (nur Beschriftung; 2024–2026 sind eingebaut, „year“ allein lädt die Werte) |
| `tax.est.grundfreibetrag` | Zahl | € | `12348` | Grundfreibetrag: bis hierhin keine Steuer |
| `tax.est.zone2_end` | Zahl | € | `17799` | Ende der ersten Progressionszone |
| `tax.est.zone3_end` | Zahl | € | `69878` | Ende der zweiten Progressionszone (danach Spitzensteuersatz) |
| `tax.est.zone4_end` | Zahl | € | `277825` | Ab hier gilt der Reichensteuersatz |
| `tax.est.y_a` | Zahl |  | `914.51` | Zone 2: Koeffizient von y² ((a·y + b)·y) |
| `tax.est.y_b` | Zahl |  | `1400` | Zone 2: Koeffizient von y |
| `tax.est.z_a` | Zahl |  | `173.1` | Zone 3: Koeffizient von z² ((a·z + b)·z + c) |
| `tax.est.z_b` | Zahl |  | `2397` | Zone 3: Koeffizient von z |
| `tax.est.z_c` | Zahl |  | `1034.87` | Zone 3: konstanter Betrag |
| `tax.est.rate4` | Zahl |  | `0.42` | Spitzensteuersatz als Faktor (0,42) |
| `tax.est.sub4` | Zahl | € | `11135.63` | Spitzensteuersatz: abzuziehender Betrag |
| `tax.est.rate5` | Zahl |  | `0.45` | Reichensteuersatz als Faktor (0,45) |
| `tax.est.sub5` | Zahl | € | `19470.38` | Reichensteuersatz: abzuziehender Betrag |
| `tax.soli.rate` | Zahl | % | `5.5` | Prozent der Einkommensteuer |
| `tax.soli.freigrenze` | Zahl | € | `20350` | Freigrenze der Einkommensteuer (Einzelveranlagung; bei Zusammenveranlagung doppelt) |
| `tax.soli.milderung` | Zahl | % | `11.9` | Milderungszone: höchstens dieser Prozentsatz des Betrags über der Freigrenze |
| `tax.church.enabled` | ja/nein |  | `false` | Kirchensteuer berechnen |
| `tax.church.rate` | Zahl | % | `9` | Prozent der Einkommensteuer (8 in Bayern und Baden-Württemberg, sonst 9) |
| `tax.joint` | ja/nein |  | `false` | Zusammenveranlagung (Splittingtarif) statt Einzelveranlagung |
| `tax.other_income` | Zahl | €/Jahr | `0` | Weitere zu versteuernde Einkünfte pro Jahr (z. B. Gehalt, Partner); der Gewinn kommt obendrauf |
| `tax.deductions` | Zahl | €/Jahr | `0` | Weitere Abzüge pro Jahr (Sonderausgaben, Freibeträge) neben der Vorsorge |
| `tax.vorsorge_monat` | Zahl | €/Monat | `0` | Kranken-, Pflege- und Rentenversicherung als fester Monatsbetrag (nur Einzelunternehmen; mindert Steuer und Gewinn) |
| `tax.gewerbesteuer.enabled` | ja/nein |  | `true` | Gewerbesteuer berechnen (Freiberufler zahlen keine: ausschalten) |
| `tax.gewerbesteuer.hebesatz` | Zahl | % | `400` | Hebesatz der Gemeinde |
| `tax.gewerbesteuer.messzahl` | Zahl | % | `3.5` | Steuermesszahl |
| `tax.gewerbesteuer.freibetrag` | Zahl | €/Jahr | `24500` | Freibetrag bei Einzelunternehmen (Kapitalgesellschaften haben keinen) |
| `tax.gewerbesteuer.hinzurechnung` | Zahl | €/Jahr | `0` | Hinzurechnungen zum Gewerbeertrag pro Jahr |
| `tax.gewerbesteuer.s35_factor` | Zahl |  | `4` | Anrechnung auf die Einkommensteuer nach § 35 EStG: Vielfaches des Messbetrags (Einzelunternehmen) |
| `tax.kst.rate` | Zahl | % | `15` | Körperschaftsteuer |
| `tax.kst.soli_rate` | Zahl | % | `5.5` | Solidaritätszuschlag auf die Körperschaftsteuer |
| `tax.kst.distribution_pct` | Zahl | % | `0` | Anteil des Gewinns nach Steuern, der an den Inhaber ausgeschüttet wird |
| `tax.kst.dividend_rate` | Zahl | % | `25` | Abgeltungsteuer auf Ausschüttungen (zuzüglich Soli darauf) |
| `matrix.customers` | Liste |  | `[10,25,50,100,250,500,1000,5000]` | Zeilen: Kundenzahlen |
| `matrix.columns` | price \| factor \| plan |  | `price` | Spalten: price = Grundpreis des Tarifs „plan_index“, factor = alle Preise mit einem Faktor, plan = ein Tarif pro Spalte |
| `matrix.prices` | Liste | €/Monat | `[29,49,79,99,149]` | Spalten bei columns=price: Grundpreise pro Monat |
| `matrix.factors` | Liste |  | `[0.6,0.8,1,1.25,1.5]` | Spalten bei columns=factor: Preisfaktoren (1 = aktuelle Preise) |
| `matrix.plan_index` | Zahl (ganz) |  | `0` | Tarif (0 = erster), dessen Grundpreis bei columns=price ersetzt wird |
| `matrix.sensitivity_pct` | Zahl | % | `20` | Schwankung für die Sensitivitätsanalyse (Tornado) |
<!-- defaults:end -->

## Presets

All numbers are examples; replace them with your own.

| Preset | Idea |
| --- | --- |
| **HyperLevel Staffel (Vorschlag)** | Solo 49 € (1 user), Team 99 € (2–99 users), Firma 199 € (100+), each with included locations, a step price per extra location and a cap; agency tiers Start 99 € (up to 5 client accounts), Pro 249 € (unlimited, white-label) and SaaS 449 € (resell + own app); customer mix 50 / 35 / 10 / 3 / 1.5 / 0.5 % |
| **HyperLevel Standort-Modell** | 49 € per company incl. 3 locations, +10 € per extra location, cap 499 €; a distribution of locations per customer shows how the cap works |
| **SaaS pro Nutzer** | classic per-seat subscription: 12 € per user and month, 8 users on average, GmbH |
| **Agentur-Retainer** | packages 1,500 / 2,500 / 4,500 € plus a setup fee; the work is support minutes × hourly rate; columns are the packages |
| **Kurs/Community** | membership at 29 € gross for consumers, annual discount, EU customers, card / PayPal / direct debit, a coaching add-on |
| **Handwerk** | jobs per month as "customers" (churn 100 % = every job is new), the job value as the setup fee, labour and material as costs |

## Scenarios, comparison, export

**Als Szenario speichern** stores the complete input (with a name and a note) for the sub-account – up to 200. **Szenarien** lists them with their key figures, reopens one (`/app/calc/<id>`) and compares up to six side by side: every key figure per scenario, the difference to the first one and the best value per row. The comparison is recalculated with the current engine. **CSV** exports the matrix (one row per customers × price, per month and per year, `;` separated, decimal comma, UTF-8 with BOM for German Excel). **JSON** copies the input for the API or the agent.

Unsaved work is kept in your browser (per sub-account, never sent anywhere), so a reload does not lose it.

## API

Sub-account routes: login with `x-location-id`, a sub-account API key, or an agency key with `x-location-id`. **Rights:** the area *Rechnungen & Produkte* (`payments`) for every route; a client login without it gets `403`. Scenarios belong to one sub-account – another account's id is `404`. Calculations (`run`, `breakeven`, `compare`) change nothing and leave no audit entry; saving, changing and deleting a scenario do. Read-only agency keys cannot call the POST routes (the same limit as every other computed endpoint).

| Route | What |
| --- | --- |
| `GET /api/calc/schema` | JSON Schema of the input with descriptions and defaults |
| `GET /api/calc/presets`, `GET /api/calc/presets/:key` | the six presets; with `:key` the complete input |
| `POST /api/calc/run` | `{preset?, scenario_id?, input?, customers?, column?, sensitivity?, compact?, metric?, period?}` → headline, warnings, the matrix (rows × columns), unit economics and break-even per column and the **focus** (`customers` at the configured prices, or at the matrix column `column`: cell with month and year lines, taxes, waterfall, projection, optional tornado). `compact: true` returns one matrix metric (`metric`: `revenue_gross`, `revenue_net`, `contribution`, `ebit`, `net_profit`, `margin`; `period`: `month` \| `year`) plus the assumptions – what agents get |
| `POST /api/calc/breakeven` | same inputs, plus `target_net_profit_month` → break-even customers per price column (before and after taxes), minimum price for `customers`, and with a target the customers or the price needed |
| `GET/POST /api/calc/scenarios` | list with key figures / save `{name, note?, preset?, input?}` |
| `GET/PATCH/DELETE /api/calc/scenarios/:id` | open / change `{name?, note?, input?}` (input is a partial over the stored one) / delete |
| `POST /api/calc/scenarios/:id/run` | run with temporary changes: `{input?, customers?, column?, sensitivity?, compact?}` |
| `POST /api/calc/compare` | `{ids: [2–6 scenario ids]}` → key figures side by side |
| `GET /api/calc/scenarios/:id/export.csv` | the matrix as CSV (recorded as an export in the audit log) |

Errors are German and specific: `Ungültige Eingabe: customers.churn: muss zwischen 0 und 100 liegen`.

```bash
curl -s https://office.example.com/api/calc/run \
  -H "authorization: Bearer $KEY" -H "x-location-id: $LOCATION" -H 'content-type: application/json' \
  -d '{"preset":"gohigh-standort","customers":500,"compact":true}'
```

## MCP tools and the HyperLevel Agent

| Tool | What |
| --- | --- |
| `ghl_calc_run` | calculate (preset, saved scenario or own input): headline, key figures, one matrix metric, top levers, assumptions. Read-only; `location_id` is optional for agency keys |
| `ghl_calc_breakeven` | break-even per price, minimum price, and customers / price for a target net profit per month |
| `ghl_calc_scenarios_list` | saved scenarios with key figures, and the presets |
| `ghl_calc_scenario_run` | recalculate a scenario with changes, or compare it with others (`compare_with`) |
| `ghl_calc_scenario_save` | save a new scenario or change one (a write: the HyperLevel Agent asks for confirmation as usual) |

The tool descriptions double as the **agent hint**: they say when to use the calculator (price, profit, margin, break-even, customer value, "what is left?"), list the input fields, and tell the agent to quote the key figures **and the assumptions**, to ask when price or customer count is missing instead of guessing, and to add *Schätzung, keine Steuerberatung*. Results carry a `link` (`/app/calc/<id>`), which the in-app agent shows as an "Öffnen" button. Examples to ask:

- "Was bleibt bei 300 Kunden im HyperLevel Standort-Modell nach allen Kosten und Steuern übrig?"
- "Ab wie vielen Kunden bin ich mit der HyperLevel Staffel im Plus?"
- "Welcher Grundpreis bringt bei 200 Kunden 5.000 € Nettogewinn im Monat?"
- "Vergleiche meine gespeicherten Szenarien."

The page has buttons that put these questions into the agent. Mobile API (native app, read-only): `GET /api/mobile/calc/scenarios?location=` and `POST /api/mobile/calc/scenarios/:id/run` `{location_id, customers?, input?}` – see [docs/api.md](api.md).

## For self-hosters

- Nothing to configure and no credentials: the module ships with HyperLevel, creates its table (`calc_scenarios`) on start and uses no outside service. The HyperLevel Agent needs an AI connection like for everything else ([docs/agent.md](agent.md)); the calculator itself does not.
- Access follows the member areas: give a client login the area *Rechnungen & Produkte* to let it use the calculator. With SaaS plans the area is the one the plan gates.
- Scenarios contain no personal data (only your own prices and costs); they are deleted with the sub-account. They are not part of the GDPR contact export.

## For developers

The engine is pure TypeScript without imports from the app: `server/services/calc-engine.ts` (cells, break-even, projection, waterfall, tornado, CSV), `calc-spec.ts` (the declarative input: defaults, JSON Schema, validation and the table below), `calc-tax.ts` (the tax functions), `calc-presets.ts`, `calc-summary.ts` (key figures, comparison, compact answers, targets). The browser imports the same files, which keeps page, API and tools identical, and makes the engine packageable as a plugin later. `tests/calc-engine.test.ts` covers the maths (price models, VAT, fees, taxes with reference values, break-even, projection, matrix), `tests/calc-api.test.ts` the API, rights, isolation, MCP tools and app endpoints. This page's defaults table is generated: change a default in `calc-spec.ts` and the test tells you to refresh it.
