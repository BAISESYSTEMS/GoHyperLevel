[English](saas.md) · **Deutsch**

# SaaS-Modus: Sub-Accounts an eigene Kunden verkaufen

Wie der SaaS Configurator von GoHighLevel: Du legst **Tarife** an (Preis, Testphase, Bereiche, Limits), Kunden buchen sie selbst über eine **Anmeldeseite** in deinem White-Label und zahlen per **Stripe-Abo** an dein eigenes Stripe-Konto. Nach der Zahlung entsteht automatisch ein Sub-Account aus einem Snapshot, der Kunde bekommt seinen Login und landet direkt in seinem Konto. Alles unter **Agentur → SaaS**.

- **Übersicht:** MRR/ARR, aktive Abos, Testphasen, offene Zahlungen (davon pausiert), Churn der letzten 30 Tage, Abos und MRR je Tarif, anstehende Verlängerungen, letzte Ereignisse.
- **Tarife:** Name, Beschreibung, Monats- und Jahrespreis, Testphase, Snapshot, sichtbar auf der Anmeldeseite (oder versteckt, nur per Link `/signup?plan=<id>`), Bereiche, Limits, Mehrverbrauch. Die Tarife der gehosteten Cloud (`cloud-solo`, `cloud-team`, `cloud-agency`, `cloud-agency-client` – [cloud.md](cloud.md)) zeigt und verkauft `/signup` nie, auch nicht per Link: `/signup?plan=cloud-…` führt im Cloud-Modus zu `/cloud`, ein `POST` damit antwortet „Bitte einen Tarif wählen.“.
- **Kunden-Abos:** alle Sub-Accounts mit Tarif, Status, Verlängerung und Verbrauch im Monat; Tarif vergeben oder ändern (mit oder ohne Stripe), Bezahllink erzeugen, kündigen. Darunter die Anmeldungen der Anmeldeseite (mit „Einladung neu“).
- **Einstellungen:** Agentur-Stripe, Anmeldeseite, Kulanzzeit, Kosten und Aufschlag für Mehrverbrauch.

Der Kunde sieht im Sub-Account unter **Einstellungen → Abo & Rechnung** seinen Tarif, Status, die nächste Verlängerung, Verbrauch und Limits und kommt mit einem Klick ins **Stripe-Kundenportal** (Zahlungsmethode, Rechnungsadresse, Rechnungen, Kündigung). Bereiche außerhalb seines Tarifs sind im Menü ausgeblendet.

## Einrichten in Stripe (10 Minuten)

Das ist **dein Agentur-Stripe-Konto** – getrennt vom Stripe, das ein Sub-Account unter *Einstellungen → Stripe* für seine eigenen Rechnungen und Kauf-Links verbindet.

1. **Secret Key:** Stripe-Dashboard → *Entwickler* → *API-Schlüssel* → geheimer Schlüssel (`sk_live_…`, zum Ausprobieren `sk_test_…`). In der App unter **Agentur → SaaS → Einstellungen** eintragen – die App prüft ihn sofort.
2. **Webhook:** Stripe-Dashboard → *Entwickler* → *Webhooks* → „Endpunkt hinzufügen“
   - URL: `https://<deine-domain>/hooks/stripe-agency` (steht in den Einstellungen zum Kopieren)
   - Ereignisse: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed` (optional `checkout.session.async_payment_succeeded`, `customer.subscription.paused`, `customer.subscription.resumed`)
   - Das **Signing Secret** (`whsec_…`) in den Einstellungen eintragen.
3. **Kundenportal:** Stripe-Dashboard → *Einstellungen* → *Billing* → *Kundenportal* einmal speichern (dort legst du fest, ob Kunden kündigen, den Tarif wechseln oder Rechnungen laden dürfen). Ohne diesen Schritt lehnt Stripe Portal-Links ab.
4. **Mahnwesen:** Stripe-Dashboard → *Einstellungen* → *Billing* → *Abonnements und E-Mails*: automatische Zahlungswiederholungen (Smart Retries) und E-Mails bei fehlgeschlagener Zahlung einschalten. Die App reagiert auf das Ergebnis (siehe unten).
5. **Tarife anlegen:** Agentur → SaaS → Tarife. Beim Speichern legt die App in Stripe je Tarif ein **Produkt** und je Intervall einen **Preis** an (`metadata.saas_plan_id`). Ändert sich ein Betrag, entsteht ein neuer Preis und der alte wird archiviert – laufende Abos behalten ihren Preis, bis du den Tarif für sie änderst. Mit ↻ gleichst du einen Tarif erneut ab.
6. **Anmeldeseite einschalten:** Einstellungen → „Anmeldeseite aktiv“, Überschrift/Text, optional AGB-Link (dann muss der Kunde sie anhaken), Standard-Snapshot und über welchen Sub-Account die Einladungs-Mails gehen (dessen SMTP aus *Einstellungen → E-Mail & SMS*).

Schlüssel und Signing Secret werden verschlüsselt gespeichert und nie an den Browser geschickt (nur `sk_test_…abcd` als Hinweis).

**Testen:** Im Testmodus mit der Karte `4242 4242 4242 4242` bezahlen. Lokal leitet die [Stripe CLI](https://docs.stripe.com/stripe-cli) die Webhooks weiter: `stripe listen --forward-to localhost:4700/hooks/stripe-agency`.

## Anmeldung: was passiert

1. Der Kunde öffnet `https://<deine-domain>/signup` – im Look deines White-Labels (Name, Logo, Farbe, Support-Adresse), auch auf deiner App-Domain. Er wählt Tarif und monatlich/jährlich, gibt Firma, Name, E-Mail (sein Login) und optional Telefon an.
2. „Konto anlegen“ öffnet **Stripe Checkout** (Abo, mit Testphase, Gutscheincodes erlaubt). Gratis-Tarife (Preis 0) überspringen Stripe.
3. Stripe meldet die Zahlung (`checkout.session.completed`) – oder der Kunde kommt zurück und die App fragt selbst bei Stripe nach. Dann entsteht:
   - ein **neuer Sub-Account** mit dem Snapshot des Tarifs (sonst dem Standard-Snapshot; Workflows als Entwurf, außer „gleich aktivieren“ ist an),
   - ein **Kunden-Login** (Nutzer mit Zugriff auf genau diesen Sub-Account),
   - eine **Einladungs-Mail** mit Link zum Passwort-Festlegen (7 Tage gültig, einmal nutzbar),
   - der Abo-Eintrag (Status `trialing`/`active`, Stripe-Kunde, Abo, Laufzeitende).
4. Im selben Browser geht es direkt weiter zu „Passwort festlegen“ und danach angemeldet nach `/app` – der Kunde landet in seinem Konto. Jedes Ereignis wird nur einmal verarbeitet; doppelte Webhooks legen nichts doppelt an.

Schutz: Pflichtfelder werden geprüft, bereits vergebene E-Mails abgelehnt („bitte anmelden“), unsichtbares Spam-Feld, höchstens 10 Versuche pro Stunde und IP (Gratis-Tarife: 3 neue Konten).

## Bestehende Sub-Accounts auf einen Tarif setzen

Agentur → SaaS → Kunden-Abos → **Tarif**:

- **Ohne Stripe vergeben:** Tarif, Intervall und Status (aktiv, Testphase, Zahlung offen, pausiert, beendet) von Hand – z. B. für Kunden, die per Rechnung zahlen. Limits und Bereiche gelten sofort.
- **Stripe-Bezahllink:** erzeugt einen Checkout-Link für den gewählten Tarif, den du dem Kunden schickst. Nach der Zahlung läuft der Sub-Account über Stripe.
- **Tarif ändern bei laufendem Stripe-Abo:** stellt das Abo bei Stripe auf den neuen Preis um (anteilige Verrechnung). Der Status kommt dann von Stripe.
- **Kündigen:** zum Laufzeitende (rücknehmbar) oder sofort. **Tarif entfernen** hebt alle Regeln auf (bei Stripe-Abos erst nach dem Beenden).

Auch per MCP: `ghl_set_location_plan` (`location_id`, `plan` als ID oder Name, optional `interval`, `status`; ohne `plan` = entfernen) und `ghl_saas_overview`.

## Wie die Sperren funktionieren

Alles hängt an **einem Guard** (`server/modules/saas-gate.ts`), der nach der Anmeldung bei jeder Anfrage läuft – die Funktions-Module selbst wissen nichts davon:

- **Bereiche:** Jede API-Route gehört zu einem Bereich (`server/core/permissions.ts`, dieselbe Zuordnung wie bei den Rechten für Kunden-Logins). Ist der Bereich nicht im Tarif, antwortet die API mit **403** („„Kurse & Mitgliederbereich“ ist in deinem Tarif „Starter“ nicht enthalten …“), und das Menü blendet ihn aus. Einfache Nachschlage-Listen (z. B. Formular- oder Kalenderliste für andere Bildschirme) bleiben lesbar. *Einstellungen* ist immer an, damit „Abo & Rechnung“ erreichbar bleibt.
- **Limits beim Anlegen:** Kontakte (`POST /api/contacts`, CSV-Import), Funnels & Websites (neu und kopiert), Kurse und Nutzer (Kunden-Logins mit Zugriff auf den Sub-Account; Admins zählen nicht). Am Limit: **403** „Limit erreicht: Dein Tarif „Starter“ enthält 1.000 Kontakte. Für mehr bitte auf einen größeren Tarif wechseln (Einstellungen → Abo & Rechnung).“ Einen vorhandenen Kontakt (gleiche E-Mail/Telefon) zu speichern geht immer. Kontakte aus öffentlichen Formularen, Buchungen oder Käufen werden nie verworfen.
- **Verbrauch pro Monat:** E-Mails, SMS und KI-Aufrufe werden je Kalendermonat (UTC) gezählt – direkt vor dem Versand bzw. Claude-Aufruf, auch aus Workflows und Kampagnen (Haken `app.services.usageGate`). Tarif-Einstellung je Art: **sperren** (darüber hinaus wird die Nachricht als „fehlgeschlagen“ mit Hinweis gespeichert bzw. der KI-Aufruf abgelehnt) oder **weiterberechnen**.
- **Agentur ausgenommen:** Agentur-Admins und Agentur-Schlüssel sehen alle Bereiche und können auch in pausierten Konten Daten ändern (um zu helfen; Versand und KI bleiben dort aus). Limits gelten für alle. Kunden-Logins und Sub-Account-API-Schlüssel unterliegen allen Regeln.

## Zahlungsverzug, Pause, Kündigung

| Stripe meldet | In der App |
| --- | --- |
| `invoice.payment_failed` / Abo `past_due` | Status **Zahlung offen**, Banner „Zahlung fehlgeschlagen – bitte bis … aktualisieren“ mit Knopf zum Kundenportal; die **Kulanzzeit** (Standard 7 Tage) startet einmal und verlängert sich bei weiteren Fehlversuchen nicht |
| Kulanzzeit vorbei (prüft die App selbst) / Abo `unpaid` oder `paused` | **pausiert**: alles bleibt lesbar, Änderungen, Versand und KI sind gesperrt; nur „Abo & Rechnung“ funktioniert |
| `invoice.paid` | wieder **aktiv** (Banner weg) |
| Kündigung zum Laufzeitende (`cancel_at_period_end`) | Hinweis „Dein Abo endet am …“ mit „Kündigung zurücknehmen“ |
| `customer.subscription.deleted` | **beendet**: nur noch lesbar; zählt in den Churn |

Ein Banner erscheint außerdem 7 Tage vor Ende einer Testphase. Öffentliche Seiten (Funnels, Formulare, Buchungen) laufen in pausierten Konten weiter.

## Mehrverbrauch weiterberechnen

Für Tarife mit „weiterberechnen“: Nach Monatsende rechnet die App je Sub-Account `(Verbrauch − Inklusiv) × deine Kosten je Stück × (1 + Aufschlag)` und legt das als **Rechnungsposten** (`/v1/invoiceitems`) an das laufende Stripe-Abo – er erscheint auf der nächsten Abo-Rechnung („Mehrverbrauch E-Mails 2026-09: 1.240 über Inklusiv-Kontingent“). Deine Kosten je E-Mail/SMS/KI-Aufruf (in Cent, Bruchteile erlaubt) und den Standard-Aufschlag stellst du in den Einstellungen ein; je Tarif lässt sich ein eigener Aufschlag setzen. Das läuft stündlich im Hintergrund, jeder Monat wird je Art genau einmal berechnet (Idempotenz-Schlüssel bei Stripe); `POST /api/saas/usage/report` stößt es sofort an.

## Texte der System-Mails

*Agentur → Branding → Texte der System-Mails*: Betreff und Text der Mails, die das System an Personen schickt, in deinen eigenen Worten – **Einladung** (Anmelde-Link), **Anmelde-Link per E-Mail**, **SaaS: Willkommen & Passwort festlegen** und **SaaS: weiteres Konto**. Platzhalter wie `{{brand.name}}`, `{{user.name}}`, `{{location.name}}`, `{{plan.name}}`, `{{days}}` und Bedingungen (`{{#if …}}`) gehen; `{{link}}` muss im Text stehen (sonst wird nicht gespeichert, und fehlt der Link beim Versand, geht der Standardtext raus). *Standard* stellt den eingebauten Text wieder her. API (Agentur): `GET /api/agency/system-mails`, `PUT|DELETE /api/agency/system-mails/:key`; Modul `server/modules/system-mails.ts` (`app.services.systemMail(key, fallback, vars)` – die Absender in `magic-link.ts` und `saas-signup.ts` fragen es).

## Ankündigungen für Sub-Accounts

*Agentur → Kunden → Ankündigungen für Sub-Accounts*: ein kurzer Hinweis, der **oben in der App** deiner Kunden erscheint – Wartung heute Abend, neue Funktion, Einladung zum Webinar. Je Ankündigung: Titel, Text, Art (Info, Erfolg, Warnung) und unter *Weitere Felder* ein Link (`https://…` oder ein Pfad der App), Zeitraum (ab/bis), nur bestimmte Sub-Accounts (leer = alle), ob man sie wegklicken darf und ob sie aktiv ist. Wer sie wegklickt, sieht sie nicht wieder (je Person); höchstens drei gleichzeitig.

API (Agentur): `GET|POST /api/agency/banners`, `PATCH|DELETE /api/agency/banners/:id`; im Sub-Account `GET /api/agency-banners/active`, `POST /api/agency-banners/:id/dismiss`. MCP (Agentur-Verbindung): `ghl_agency_banners`, `ghl_agency_banner_create`. Modul `server/modules/agency-banners.ts`, Oberfläche über die Slots `agency.clients` und `shell.banner`.

## API

Siehe [docs/api.md](api.md#saas-mode).
