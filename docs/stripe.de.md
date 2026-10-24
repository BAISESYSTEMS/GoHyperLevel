[English](stripe.md) · **Deutsch**

# Stripe-Zahlungen

Jeder Sub-Account verbindet **sein eigenes Stripe-Konto**. Danach:

- **Rechnungen:** Auf dem Kunden-Link (`/i/…`) jeder offenen Rechnung erscheint **„Jetzt bezahlen (Karte, SEPA, Apple Pay …)“**. Der Knopf öffnet Stripe Checkout über den **offenen Betrag** und mit der E-Mail des Kunden: eine unberührte Rechnung mit allen Positionen (brutto, inkl. USt.); ist schon etwas bezahlt, per Gutschrift gutgeschrieben oder – bei einer Schlussrechnung – über Abschlagsrechnungen abgezogen, eine Zeile **„Restbetrag Rechnung RE-…“**, die nennt, was abgezogen ist (mit dem USt.-Hinweis wie bei den Positionen). Ist nichts mehr offen, gibt es keinen Knopf. Nach der Zahlung steht die Rechnung auf **bezahlt** (mit Datum und Stripe-Referenz), der Workflow-Auslöser **„Rechnung bezahlt“** startet, ausgehende Webhooks bekommen `invoice.paid` (mit `via: "Stripe"`).
- **Produkte:** Jedes Produkt hat einen öffentlichen **Kauf-Link** `https://<domain>/buy/<produkt-id>` oder mit Kurzname `…/buy/online-kurs`. Nach dem Kauf: Kontakt wird angelegt oder per E-Mail erkannt, eine **bezahlte Rechnung** entsteht (und geht auf Wunsch automatisch per E-Mail raus), der Kontakt bekommt den Tag **`kauf:<kurzname>`** (z. B. für Kurs-Freischaltungen) und der Workflow-Auslöser **„Produkt gekauft“** startet (`product.purchased` mit `contactId`, `productId`, `invoiceId`).
- **Abo-Produkte** (Intervall monatlich/jährlich) laufen als Stripe-Abo: jede Verlängerung erzeugt hier eine bezahlte Rechnung, bei Kündigung wird der Kauf-Tag wieder entfernt.
- In **Rechnungen & Angebote** zeigt „Stripe verbunden“ den Status, „via Stripe“ markiert online bezahlte Rechnungen; in der Rechnung steht, wann und mit welcher Referenz bezahlt wurde (Link ins Stripe-Dashboard).

**Weitere Zahlungsanbieter:** Neben Stripe lassen sich **PayPal** (auch „Später bezahlen“) und **Mollie** (iDEAL, SEPA-Überweisung, Karten, Klarna) verbinden – unter *Einstellungen → Stripe & Zahlungen*. Dann fragt die Kaufseite „Bezahlen mit“, Rechnungen bekommen neben „Jetzt bezahlen“ einen zweiten Knopf zur Bezahlseite (dort lassen sich auch Gutscheine einlösen), und der [Online-Shop](store.md) bietet jeden verbundenen Anbieter an. Abos und Ratenzahlung bleiben bei Stripe. Einrichtung und Ablauf: [payment-providers.md](payment-providers.md).

## Einrichten (5 Minuten)

1. **Secret Key:** Stripe-Dashboard → *Entwickler* → *API-Schlüssel* → „Geheimer Schlüssel“ (`sk_live_…`, zum Ausprobieren erst `sk_test_…` im Testmodus). In der App unter **Einstellungen → Stripe** eintragen und speichern – die App prüft den Schlüssel sofort („Verbindung testen“ geht jederzeit).
2. **Webhook:** Stripe-Dashboard → *Entwickler* → *Webhooks* → **„Endpunkt hinzufügen“**
   - Endpunkt-URL: `https://<deine-domain>/hooks/stripe/<locationId>` – die fertige Adresse steht unter Einstellungen → Stripe zum Kopieren.
   - Ereignisse: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`; für Abo-Produkte zusätzlich `invoice.paid` und `customer.subscription.deleted`. Optional `charge.refunded` (Workflow-Auslöser „Zahlung erstattet“), `invoice.payment_failed` und `checkout.session.async_payment_failed` (Auslöser „Zahlung fehlgeschlagen“, [docs/workflow-actions.md](workflow-actions.md#triggers)) sowie `customer.subscription.deleted` (Auslöser „Abo gekündigt / beendet“). `charge.refunded`: Erstattungen melden `payment.refunded` (Webhooks/Workflows) und stornieren Affiliate-Provisionen ([docs/growth.de.md](growth.de.md#affiliate-manager)).
   - Für den Auslöser **Checkout abgebrochen (Warenkorbabbruch)** zusätzlich `checkout.session.expired` ([E-Mail-Marketing](email-marketing.de.md#warenkorbabbruch)): Stripe meldet damit eine unbezahlte Bezahlseite nach 24 Stunden.
   - Für [Ratenzahlung](payment-plans.md) und das [Mahnwesen](dunning.md) zusätzlich: `invoice.payment_failed`, `invoice.payment_action_required`, `customer.subscription.updated` (und `invoice.paid`, `customer.subscription.deleted`, `checkout.session.completed` wie oben). Bei Ratenplänen und Abos unter *Einstellungen → Abos und E-Mails → Fehlgeschlagene Zahlungen* in Stripe die **Smart Retries** einstellen.
   - Nach dem Anlegen das **Signing Secret** (`whsec_…`) des Endpunkts aufdecken und unter Einstellungen → Stripe eintragen.
3. **Zahlungsarten:** Stripe-Dashboard → *Einstellungen* → *Zahlungsmethoden*. Checkout zeigt automatisch alles, was dort aktiv ist (Karte, SEPA-Lastschrift, Apple Pay, Google Pay, Klarna …). Apple Pay braucht bei Stripe Checkout keine eigene Domain-Prüfung.

Schlüssel und Signing Secret werden verschlüsselt gespeichert und nie wieder an den Browser geschickt (nur `sk_test_…abcd` als Hinweis). „Trennen“ löscht beides; „Jetzt bezahlen“ und Kauf-Links sind dann aus.

## Kauf-Links

Produkte → beim Produkt **„Kauf-Link“** kopieren, über das Zahnrad einstellen:

| Einstellung | Wirkung |
| --- | --- |
| Kurzname | `/buy/<kurzname>` statt der Produkt-ID (eindeutig über alle Sub-Accounts) |
| Tag für Käufer | Standard `kauf:<kurzname>` (ohne Kurzname: aus dem Produktnamen) |
| Weiterleitung nach dem Kauf | z. B. die Kurs- oder Danke-Seite (`https://…`); sonst zeigt die App eine Danke-Seite |
| Kauf-Link aktiv | Aus = Seite nicht erreichbar |

Der Link öffnet eine kleine Produktseite mit Preis (brutto) und „Jetzt kaufen“ – mit Order-Bump und Rabattcode-Feld, wenn eingestellt (siehe unten). `?email=kunde@example.com` am Link füllt die E-Mail in Stripe vor (praktisch aus Funnels oder Mails).

## Order-Bump, Upsell und Rabattcodes

Ebenfalls im Zahnrad-Dialog des Kauf-Links, gespeichert mit *Speichern*. Es braucht **keine weiteren Schlüssel und keine weiteren Webhook-Ereignisse**.

| Einstellung | Wirkung |
| --- | --- |
| Order-Bump | Ein zweites Produkt (Einmalkauf, gleiche Währung) als Häkchen auf der Kaufseite, mit eigenem Text. Angehakt → zweite Position in Stripe Checkout; die bezahlte Rechnung enthält beide Positionen (je mit eigenem Steuersatz). Der Kontakt bekommt beide Kauf-Tags, „Produkt gekauft“ startet für beide Produkte (das Bump-Ereignis trägt `via: "order_bump"`). Geht auch bei Abo-Produkten (der Bump wird einmalig mit der ersten Zahlung berechnet). |
| One-Click-Upsell | Ein Produkt (Einmalkauf), das direkt nach dem Bezahlen angeboten wird. Dafür legt Checkout einen Stripe-Kunden an und speichert die Zahlungsart (`customer_creation=always`, `payment_intent_data.setup_future_usage=off_session`). „Ja, hinzufügen“ bucht ohne erneute Eingabe ab (PaymentIntent `off_session`, `confirm`), es entsteht eine eigene bezahlte Rechnung, Tag und „Produkt gekauft“ wie bei jedem Kauf. Verlangt die Bank eine Bestätigung (3-D Secure, `authentication_required`) oder wird die Karte abgelehnt, geht es über eine normale Stripe-Bezahlseite für das Upsell-Produkt weiter (Kunde und E-Mail vorausgefüllt). „Nein danke“ führt zur Danke-Seite bzw. zur Weiterleitung des Hauptprodukts. Das Angebot gilt eine Stunde und lässt sich nur einmal annehmen. Nur nach Einmalkäufen (nicht nach Abos). Im Dialog steht, wie oft es angeboten und angenommen wurde. |
| Rabattcodes | Eigene Codes je Produkt: Prozent oder fester Betrag (brutto), optional Ablaufdatum und Höchstzahl an Einlösungen, abschaltbar. Käufer geben den Code auf der Kaufseite ein (sofortige Prüfung, Gesamtpreis aktualisiert sich); Checkout berechnet den reduzierten Preis, auf der Rechnung steht der Rabatt als eigene Zeile. Gilt für das Hauptprodukt, nur bei Einmalkäufen. Mit Höchstzahl ist eine Einlösung reserviert, solange ein Käufer damit auf der Stripe-Bezahlseite ist: die Seite läuft dann nach 31 Minuten ab, wird der Kauf nicht abgeschlossen, ist der Code wieder frei (eine SEPA-Zahlung hält ihn bis zur Antwort der Bank) – so geht ein Code „für die ersten 10“ auch bei vielen gleichzeitigen Käufern nur zehnmal raus. |
| Stripe-Gutscheincodes erlauben | Zeigt auf der Stripe-Bezahlseite das Feld für Promotion Codes (`allow_promotion_codes`). Codes legst du im Stripe-Dashboard an (*Produktkatalog → Gutscheine*). Der von Stripe gewährte Rabatt kommt als Zeile „Gutschein (Stripe)“ auf die Rechnung. Wird ein eigener Rabattcode eingelöst, ist das Stripe-Feld aus. |

**Für das Upsell im Stripe-Dashboard:** nichts extra – Karten, Apple Pay, Google Pay und SEPA lassen sich für spätere Zahlungen speichern. Bei SEPA ist die Upsell-Zahlung erst „in Bearbeitung“; die App fragt alle 10 Minuten bei Stripe nach und stellt die Rechnung aus, sobald das Geld bestätigt ist.

**A/B-Tests:** Kauf-Links auf Funnel-Seiten mit laufendem A/B-Test bekommen automatisch die Besucher-ID (`?ab=…`); sie wandert über die Kaufseite in die Checkout-Metadaten, damit der Kauf der richtigen Variante zugerechnet wird.

## Was beim Bezahlen passiert

- Stripe meldet die Zahlung an `/hooks/stripe/<locationId>`. Die Signatur (`Stripe-Signature`, HMAC-SHA256 über Zeitstempel + Inhalt) wird geprüft; älter als 5 Minuten oder falsch → abgelehnt.
- Jedes Ereignis wird nur einmal verarbeitet (Stripe wiederholt Webhooks bei Fehlern). Eine Rechnung wird nie zweimal „bezahlt“, ein Kauf erzeugt nie zwei Rechnungen.
- Kommt der Kunde von Stripe zurück, fragt die App direkt bei Stripe nach – die Rechnung steht also auch dann sofort auf bezahlt, wenn der Webhook noch unterwegs ist.
- **SEPA-Lastschrift** dauert ein paar Tage: bis Stripe das Geld bestätigt (`checkout.session.async_payment_succeeded`), steht die Zahlung auf „in Bearbeitung“. So lange zeigt die Rechnung statt „Jetzt bezahlen“ den Hinweis, dass eine Zahlung in Bearbeitung ist, und öffnet keine zweite Bezahlseite (sonst zahlt der Kunde doppelt); nach drei Wochen ohne Antwort gibt es den Knopf wieder. Scheitert sie, steht es in der Kontakt-Aktivität, und die Rechnung lässt sich wieder online bezahlen.
- Ein Doppelklick auf „Jetzt bezahlen“ öffnet eine Bezahlseite, nicht zwei; wer innerhalb von 30 Minuten wiederkommt, bekommt dieselbe (solange der offene Betrag derselbe ist).
- Gebucht wird, was ankommt – nie mehr, als offen ist: Der offene Betrag macht die Rechnung bezahlt, weniger wird als **Teilzahlung** gebucht (die Rechnung bleibt mit dem Rest offen). Kommt mehr an – etwa weil zwischen dem Öffnen der Bezahlseite und dem Bezahlen eine Überweisung oder Gutschrift einging –, wird nur der offene Betrag gebucht. Jede Abweichung (zu viel, zu wenig, andere Währung, Geld für eine Rechnung ohne offenen Betrag) steht im Protokoll der Rechnung (`payment.mismatch`) und in der Aktivität des Kontakts, damit eine Erstattung nicht vergessen wird. Dieselbe Zahlung (Webhook-Wiederholung, PaymentIntent-Ereignis, Rückkehr von Stripe) wird nur einmal gebucht.
- Kauf-Links und Stripe-Zahlungen erzeugen **festgeschriebene** Rechnungen mit der nächsten Nummer des Rechnungs-Nummernkreises (GoBD, siehe [invoicing.md](invoicing.md)); ein Entwurf wird beim Bezahlen festgeschrieben. Eine Erstattung in Stripe storniert die Rechnung nicht von selbst – das machst du mit „Stornieren“ in der Rechnung (nur bei Termin-Buchungen mit Zahlung läuft das automatisch).

## Testen

Im Testmodus (`sk_test_…`) mit der Testkarte `4242 4242 4242 4242`, beliebigem Ablaufdatum in der Zukunft und beliebiger Prüfziffer bezahlen. Lokal ohne öffentliche Adresse leitet die [Stripe CLI](https://docs.stripe.com/stripe-cli) die Webhooks weiter:

```bash
stripe listen --forward-to localhost:4700/hooks/stripe/<locationId>
# zeigt ein whsec_… – das unter Einstellungen → Stripe eintragen
```
