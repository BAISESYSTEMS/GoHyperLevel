[English](email-marketing.md) · **Deutsch**

# E-Mail-Marketing: Tests, Segmente, Vorlagen und Zustellbarkeit

Kampagnen mit der Tiefe von Klaviyo, ActiveCampaign oder Brevo – ohne zusätzliche Dienste. Alles liegt unter **Kampagnen**: der Reiter *Kampagnen* (mit A/B-Test, Erinnerung und Sendezeit im Entwurf), *Segmente*, *Vorlagengalerie*, *Vorlagen*, *Zustellbarkeit* und *Trigger-Links*. Die Seiten sind einzeln nachladbar, der Rest der App wird davon nicht größer.

- [Einfach-Modus](#einfach-modus)
- [A/B-Tests](#ab-tests)
- [Erinnerung an Nicht-Öffner](#erinnerung-an-nicht-öffner)
- [Zur besten Zeit senden](#zur-besten-zeit-senden)
- [Segmente nach Verhalten](#segmente-nach-verhalten)
- [WhatsApp-Kampagnen mit Vorlagen](#whatsapp-kampagnen-mit-vorlagen)
- [Warenkorbabbruch](#warenkorbabbruch)
- [Vorlagengalerie](#vorlagengalerie)
- [Zustellbarkeit](#zustellbarkeit)
- [Einstellungs-Center im Footer](#einstellungs-center-im-footer)
- [REST-API und MCP](#rest-api-und-mcp)
- [Für Entwickler](#für-entwickler)

## Einfach-Modus

Im [Einfach-Modus](theming.md#einfach-modus) zeigt der Kampagnen-Entwurf nur Name, Kanal, Betreff, Inhalt, Smart List,
Tags, Test und Versand. Hinter **Weitere Felder** liegen: Absendername und *Text ist HTML*, Segment sowie „Mit einem dieser
Tags“/„Ohne Tags“, **A/B-Test & Erinnerung an Nicht-Öffner** und **Sendezeit je Kontakt & Geschwindigkeit**. Jeder Bereich
öffnet sich von selbst, sobald darin etwas eingestellt ist. Im E-Mail-Designer liegen Farben, Abstände, Ausrichtung und
Button-Aussehen eines Blocks, eines Abschnitts und der ganzen Mail unter **Darstellung** (offen, sobald etwas vom Standard
abweicht). Profi zeigt alles wie bisher.

## A/B-Tests

Im Entwurf einer **E-Mail-Kampagne** → Karte **A/B-Test** → *Betreff oder Inhalt testen*.

| Einstellung | Bedeutung |
| --- | --- |
| Varianten | A (Original) und 1–3 weitere. Jede Variante hat einen **Betreff**, optional einen **Absendernamen** (die Adresse bleibt gleich) und optional **eigenen Inhalt** (im E-Mail-Designer; *Eigenen Inhalt gestalten* startet mit einer Kopie des Originals). Eine Variante muss sich in etwas vom Original unterscheiden. |
| Testgruppe | 5–50 % der Empfänger (Standard 20 %), zu gleichen Teilen auf die Varianten verteilt. Die Gruppen sind zufällig, aber wiederholbar (derselbe Entwurf ergibt dieselbe Verteilung). Jede Variante braucht mindestens 2 Empfänger, sonst geht die Kampagne ohne Test an alle (der Grund steht im Ergebnis). |
| Gewinner nach | **Öffnungen** (Personen), **Klicks** oder **Umsatz** (bezahlte Rechnungen des Kontakts in den 14 Tagen nach der Mail). Verglichen wird je Empfänger, nicht die Rohzahl. Maschinelle Öffnungen (Apple Mail, Gmail-Bildproxy, Scanner) zählen nie. |
| Wartezeit | 1 Stunde bis 14 Tage (Standard 24 Stunden). |

**Ablauf:** Beim Senden gehen die Test-Mails an die Testgruppe, alle anderen Empfänger warten (Status *wartet auf Gewinner*, die Kampagne zeigt *A/B-Test läuft*). Nach der Wartezeit bestimmt der Server den Gewinner und sendet ihn an alle, die gewartet haben. Bei Gleichstand entscheidet das nächste Maß (Klicks, dann Öffnungen), dann der kleinere Buchstabe; ohne ein einziges Ereignis geht das Original raus.

**Ergebnis:** In der Kampagne zeigt die Karte *A/B-Test: Ergebnis* je Variante Gesendet, Geöffnet, Geklickt, Käufer, Umsatz und eine Einschätzung gegen das Original („deutlich besser“, „kein klarer Unterschied“, „noch zu früh“, Wahrscheinlichkeit besser zu sein). Solange der Test wartet, lässt sich der Gewinner **sofort bestimmen** (automatisch oder mit „B senden“ eine Variante festlegen). Danach ist die Entscheidung endgültig. Im Entwurf schickt *Testen* auf Wunsch eine bestimmte Variante an einen Testkontakt.

## Erinnerung an Nicht-Öffner

Karte **Erinnerung an Nicht-Öffner** im Entwurf (oder später an einer laufenden oder gesendeten Kampagne): neuer **Betreff**, Zeitpunkt (1 Stunde bis 30 Tage, Standard 72 Stunden nach dem Ende des Versands), optional ein anderer Absendername.

- Erinnert wird, wer die Mail bekommen hat und sie **nicht als Person geöffnet oder angeklickt** hat. Dass ein Mail-Programm Bilder im Hintergrund lädt, zählt nicht als Öffnung – diese Leser werden also nicht fälschlich übersprungen.
- Aus der Erinnerung wird eine eigene Kampagne (mit dem Hinweis *Erinnerung* in der Liste). Sie geht nur einmal raus und erinnert nicht noch einmal. Wer sich inzwischen abgemeldet hat, „Nicht stören“ gesetzt oder die Einwilligung widerrufen hat, wird übersprungen wie bei jeder Kampagne.
- An einer fertig gesendeten Kampagne gibt es zusätzlich **Jetzt an Nicht-Öffner senden**. Ohne Nicht-Öffner entsteht keine Erinnerung (der Grund steht in der Karte).

## Zur besten Zeit senden

Unter *Versand* → **Sendezeit** → *Zur besten Zeit je Kontakt*. Innerhalb von 24 Stunden bekommt jeder Kontakt die Mail in der Stunde, in der er Mails sonst öffnet.

- Grundlage sind die **Öffnungen von Personen** (Tabelle `email_events`, keine maschinellen) der letzten Monate – je Kontakt eine Stundenverteilung in der Zeitzone des Projekts, mit Glättung über die Nachbarstunden (eine einzelne Öffnung um 3 Uhr nachts macht keine Bestzeit).
- **Fallback:** Kontakte ohne eigene Daten bekommen die beliebteste Stunde des ganzen Projekts, ohne Daten überhaupt die *Standard-Sendestunde* (*Zustellbarkeit → Einstellungen*, Standard 10 Uhr).
- Der Versand verteilt sich mit einem festen, je Kontakt unterschiedlichen Minutenversatz (kein Schwall zur vollen Stunde). Wer schon in seiner Stunde ist, bekommt die Mail sofort; alle anderen in der nächsten passenden Stunde, spätestens nach 24 Stunden. Die Zeit wird einmal beim Start berechnet (bei A/B-Tests beim Senden des Gewinners).
- *Verteilung anzeigen* zeigt vorab, wie viele Empfänger auf welche Stunde fallen und wie viele Daten es gibt. Zeitumstellungen werden je Monat berücksichtigt; mitten im Monat kann eine Stunde abweichen.
- Kombinierbar mit Planung (*Geplant für*) und mit dem Aufwärmplan.

## Segmente nach Verhalten

**Kampagnen → Segmente** (REST: `/api/segments`). Ein Segment ist eine gespeicherte Zielgruppe aus **Bedingungen**, verknüpft mit *alle* (UND) oder *mindestens eine* (ODER) – Gruppen lassen sich bis zu 4 Ebenen verschachteln (höchstens 60 Bedingungen), jede Bedingung und jede Gruppe kann mit *nicht* umgekehrt werden. Unten zeigt das Segment **live**, wie viele Kontakte passen, mit Beispielen.

| Bedingung | Beispiel |
| --- | --- |
| E-Mail-Verhalten | hat geöffnet / geklickt / nicht geöffnet / erhalten – irgendeine oder eine bestimmte Kampagne, in den letzten N Tagen |
| Kauf | hat (ein bestimmtes Produkt) gekauft / nicht gekauft, in den letzten N Tagen |
| Seite besucht | Einstiegsseite eines Besuchs enthält `/preise`, in den letzten N Tagen (aus der Besucher-Erfassung der [Attribution](growth.de.md): Funnels, Websites, Links mit UTM) |
| Formular | hat ein bestimmtes Formular ausgefüllt / nicht ausgefüllt |
| Tag, Kontaktfeld | Tag vorhanden; Feld ist / enthält / beginnt mit / leer / größer als / vor einem Datum …, auch benutzerdefinierte Felder |
| Einwilligung | Einwilligung für E-Mail, SMS oder WhatsApp liegt vor / fehlt (das Urteil der Versandregel) |
| Letzte Aktivität, angelegt | innerhalb der letzten / länger her als N Tage; noch nie aktiv |
| Interesse an Mails | aktiv in den letzten N Tagen / öffnet nie, obwohl mindestens X Mails ankamen |
| Adressprüfung, Nicht stören | Adresse ist in Ordnung / riskant / ungültig / ungeprüft; hat „Nicht stören“ |
| Anderes Segment | ist Mitglied in einem anderen gespeicherten Segment |

**Schnellstarts** im Dialog: *Geklickt, aber nicht gekauft*, *Lange nicht geöffnet*, *Neu im Verteiler*, *Preisseite besucht, nicht gekauft*, *Aktive Leser*.

**Verwenden:**
- **In Kampagnen:** Karte *Empfänger* → *Segment (Verhalten)*. Das Segment wird mit Tags und Smart List kombiniert (alles muss zutreffen). Die Versandregel gilt wie immer: Einwilligung, „Nicht stören“ und Adressprüfung bleiben davor.
- **In Workflows:** Auslöser **Kontakt tritt einem Segment bei** und **… verlässt ein Segment** (`segment.entered`, `segment.left`). Dafür beim Segment *Beitritt und Austritt beobachten* einschalten; die Mitgliedschaft wird alle 5 Minuten neu berechnet. Beim Einschalten (und nach einer geänderten Definition) werden die heutigen Mitglieder nur gemerkt und lösen nichts aus.
- *Kampagne starten* legt aus dem Segment sofort einen Entwurf an; *Kontakte ansehen* listet die Mitglieder.

Ein Segment lässt sich nicht löschen, solange es von einem Entwurf, einer geplanten oder laufenden Kampagne, einem aktiven Workflow oder einem anderen Segment verwendet wird. Wird es trotzdem entfernt, erreicht eine Kampagne damit niemanden (nie alle).

## WhatsApp-Kampagnen mit Vorlagen

Kanal **WhatsApp** in der Kampagne. Gesendet wird eine von Meta **freigegebene Vorlage** (die Verbindung und die Vorlagen kommen aus *Einstellungen → Kanäle*, siehe [meta-channels.de.md](meta-channels.de.md)). Die Werte für die Platzhalter der Vorlage dürfen Merge-Felder enthalten (`{{contact.first_name|du}}`).

- Die **Kategorie** liest der Server bei Meta, sie kommt nie aus dem Browser. **Marketing**-Vorlagen sind Werbung: Es bekommen nur Kontakte mit gültiger **WhatsApp-Einwilligung** die Nachricht (die [Versandregel](consent.md)). **Service-Vorlagen (Utility)** brauchen keine Werbeeinwilligung – „Nicht stören“ und fehlende Nummern bleiben aber ausgeschlossen. **Einmalcode-Vorlagen (Authentication)** lassen sich nicht als Kampagne senden.
- Fehlende oder nicht freigegebene Vorlagen, nicht ausgefüllte Platzhalter und fehlende Verbindung werden vor dem Versand mit einer klaren Meldung abgelehnt. Die Empfängerzahl zeigt, wie viele wegen fehlender Einwilligung übersprungen werden.
- Geschwindigkeit, Planung und Segmente gelten wie bei E-Mail; A/B-Test, Erinnerung und Sendezeit gibt es nur für E-Mail.

## Warenkorbabbruch

Auslöser **Checkout abgebrochen (Warenkorbabbruch)** (`checkout.abandoned`) und die Workflow-Vorlage **Warenkorbabbruch-Serie** (*Automationen → Neuer Workflow*).

- Stripe meldet `checkout.session.expired`, wenn eine unbezahlte Bezahlseite nach 24 Stunden abläuft. **Dieses Ereignis im Stripe-Webhook aktivieren** (siehe [stripe.de.md](stripe.de.md)). Berücksichtigt werden nur Produkt-Käufe dieses Projekts, keine Rechnungslinks.
- Der Kontakt wird an seiner E-Mail-Adresse erkannt (vom Checkout oder vom Kauf-Link). Unbekannte Adressen legen nur dann einen Kontakt an, wenn *Zustellbarkeit → Einstellungen → Warenkorbabbruch* das erlaubt – Standard: nein. Wer das Produkt inzwischen gekauft hat, bekommt nichts.
- Auch der **Online-Shop** ([store.md](store.md#abandoned-carts)) meldet `checkout.abandoned`: ein Warenkorb mit E-Mail und ohne bezahlte Bestellung nach der eingestellten Zeit (Standard 60 Minuten). `{{event.recovery_url}}` führt dann zur Kasse mit dem Warenkorb, `{{event.source}}` ist `store`.
- Der Kontakt bekommt den Tag `warenkorbabbruch` (der Kauf entfernt ihn wieder). Das Ereignis enthält `{{event.product_name}}`, `{{event.recovery_url}}` (Link zur Kaufseite), `{{event.amount_cents}}` und `{{event.currency}}`.
- Die Vorlage sendet drei E-Mails aus der Vorlagengalerie (E-Commerce: *Warenkorb: du hast etwas vergessen*, *noch unsicher?*, *letzte Erinnerung*) nach 0, 2 und 5 Tagen. Nach jeder Wartezeit prüft ein Ziel, ob der Tag noch da ist; wer inzwischen gekauft hat, verlässt die Serie. Werbe-Mails brauchen auch hier eine gültige Einwilligung.

## Vorlagengalerie

**Kampagnen → Vorlagengalerie**: 60 fertige, responsive deutsche Vorlagen in 13 Kategorien – Newsletter, Angebot & Rabatt, Willkommen, Event & Einladung, Webinar, Kurs & Training, Rechnung & Zahlung, Feiertage & Saison, B2B & Vertrieb, Coach & Beratung, Handwerk & Dienstleistung, E-Commerce, Feedback & Reaktivierung.

- **Suche** über Name, Beschreibung und Stichwörter (mit Umlaut-Toleranz: „gruesse“ findet „Grüße“); die Zahlen an den Kategorien gehören zur Suche.
- Ein Klick öffnet die **Vorschau** (Computer und Smartphone, mit Beispieldaten). *Neue Kampagne damit anlegen* oder *Als eigene Vorlage speichern* (erscheint unter *Vorlagen*). Im Kampagnen-Entwurf übernimmt *Aus der Galerie wählen* die Vorlage in die aktuelle Kampagne (optional mit dem Betreff der Vorlage).
- Die Vorlagen sind ganz normale Designs des [E-Mail-Designers](email-builder.de.md): danach lässt sich alles ändern. Sie haben Vorschautext, Footer mit Adresse und Abmeldelink, ausreichenden Kontrast und große Tippflächen. *Sie* / *du* und *Service* (Rechnung, Bestellung – keine Werbung) stehen an der Vorlage.

## Zustellbarkeit

**Kampagnen → Zustellbarkeit** (die Prüfung von SPF, DKIM und DMARC der Absender-Domain steht in [deliverability.md](deliverability.md)).

**Reputation.** Bounce-, Beschwerde- und Abmelderate der Kampagnen-Mails – gesamt, **je Kampagne, je Empfänger-Domain und je Woche** (30 Tage bis 1 Jahr):

| Wert | Warnung ab | kritisch ab |
| --- | --- | --- |
| Bounces | 2 % | 5 % |
| Spam-Beschwerden | 0,1 % | 0,3 % |
| Abmeldungen | 0,5 % | 1 % |

Unter 100 versendeten Mails sind Raten kaum aussagekräftig („zu wenig Daten“); nur mehrere Beschwerden warnen schon früh. Zu jeder Warnung steht, was zu tun ist. Abmeldungen werden der letzten Kampagnen-Mail zugerechnet, die der Kontakt in den 7 Tagen davor bekam. In der Kampagne und im Versandfenster erscheint die Warnung ebenfalls.

**Aufwärmplan.** Neue Absender-Domains brauchen Zeit. Der Plan (*Behutsam* ca. 6 Wochen ab 20 Mails/Tag, *Standard* ca. 4 Wochen ab 50, *Zügig* ca. 2,5 Wochen ab 100) begrenzt die **Kampagnen-Mails pro Tag** und steigert das Limit täglich bis zum normalen Betrieb. Kampagnen halten sich beim Senden daran; was nicht mehr passt, geht am nächsten Tag raus, und Kontakte, die zuletzt Mails geöffnet haben, kommen zuerst. Werden die Werte kritisch, **halbiert sich das Limit**. *Pausieren* hebt die Begrenzung auf, bis man fortsetzt.

**Listenhygiene.**
- **Wiederholte Soft Bounces:** Ab 3 (einstellbar 2–10) Zustellfehlern in Folge (90 Tage) wird die Adresse auf „Nicht stören“ gesetzt – automatisch jede Stunde oder per Klick (*Alle ausschließen*).
- **Sunset-Segment:** Kontakte, die seit N Monaten (Standard 6) Mails bekommen, aber nie öffnen oder klicken, in einem automatisch angelegten Segment *Sunset: lange nicht geöffnet* – optional zusätzlich mit dem Tag `inaktiv`. Erst eine Reaktivierungs-Mail senden, dann bereinigen.

**Adressprüfung.** Prüft Schreibweise, ob die Domain Mails empfangen kann (**MX**, mit A-Eintrag als Rückfall, „Null-MX“ = ungültig), **Wegwerf-Domains**, **Funktionsadressen** (`info@`, `support@` …) und schlägt bei Tippfehlern in bekannten Domains (`gmial.com`) eine Korrektur vor. Ergebnis: *in Ordnung*, *riskant* (kommt an, ist aber eine schlechte Wette) oder *ungültig* (bounct). Neue Kontakte werden im Hintergrund geprüft; Kampagnen lassen ungültige Adressen aus (einstellbar auch für Wegwerf- und Funktionsadressen). Ein DNS-Ausfall macht eine Adresse nie ungültig. *Ungültige markieren* versieht sie mit dem Tag *E-Mail prüfen*; *Adressen von Hand prüfen* testet bis zu 200 Adressen sofort. Die DNS-Abfragen laufen nur auf dem laufenden Server (Tests und Offline-Läufe prüfen Schreibweise und Wortlisten).

**Einstellungen:** Soft-Bounce-Grenze, automatisches Ausschließen, Monate bis „inaktiv“, Regeln der Adressprüfung, Standard-Sendestunde, Warenkorbabbruch für unbekannte Adressen.

## Einstellungs-Center im Footer

Das [Einstellungs-Center](consent.md) (Themen und Kanäle wählen statt komplett abmelden) wird in Kampagnen-Mails automatisch **neben „Abmelden“** verlinkt, solange *Einstellungen → Einwilligung → Werbe-Mails verlinken die Einstellungsseite* an ist. Im Designer lässt sich der Linktext im Footer-Block ändern (*Einstellungs-Link*); wer einen eigenen Link mit `{{preferences_url}}` setzt, bekommt keinen zweiten. Der Abmeldelink bleibt in jedem Fall; Tracking leitet beide Links nicht um.

## Bedingte Inhalte

In jeder E-Mail, SMS, Workflow-Nachricht und jedem Dokument mit Platzhaltern lassen sich Abschnitte an Bedingungen knüpfen – im E-Mail-Designer einfach in einen Textblock schreiben:

```
{{#if contact.tags has "VIP"}}Dein VIP-Rabatt: 20 %{{else}}Jetzt 10 % sichern{{/if}}
{{#if contact.city == "Köln"}}Besuch uns in der Ehrenstraße!{{/if}}
{{#if contact.custom.budget >= 5000}}…{{/if}}   {{#unless contact.phone}}Bitte Telefonnummer nachtragen.{{/unless}}
```

- **Operatoren:** `==`, `!=`, `contains`/`enthält` (Text enthält), `has`/`hat` (Liste enthält – z. B. Tags), `>`, `>=`, `<`, `<=` (Zahlen); ohne Operator muss das Feld nur gefüllt sein, `not`/`!` davor kehrt um. Groß-/Kleinschreibung zählt nicht. Vor einem Wort-Operator steht ein Leerzeichen (`contact.tags has "VIP"`, nicht `contact.tagshas "VIP"`).
- Blöcke dürfen verschachtelt sein und `{{else}}` haben; ein unvollständiger Block bleibt unverändert stehen (die Nachricht geht nie kaputt). Vorlagen über 2 Mio. Zeichen werden nicht ausgewertet und gehen unverändert raus.
- Auf Websites gibt es dasselbe mit den Parametern des Links: `{{#if url.quelle == "facebook"}}…{{/if}}` ([sites.de.md](sites.de.md#seo--zugang)).
- Technik: `services/template-conditions.ts` (Parser, rein, linear: handgeschriebener Tag-Scanner statt Regex mit Backtracking, damit eine präparierte Vorlage den Server nicht blockiert), eingehängt über `templatePass` in `core/template.ts` von `modules/template-conditions.ts`; Tests in `tests/gaps-sites-marketing.test.ts` und `tests/sec-w10b-template.test.ts`.

## REST-API und MCP

| Endpunkt | Zweck |
| --- | --- |
| `GET /api/campaigns/:id/ab` | Ergebnisse des A/B-Tests (Varianten, Raten, Einschätzung, Stand) |
| `POST /api/campaigns/:id/ab/winner` `{key?}` | Gewinner jetzt bestimmen (ohne `key` automatisch), solange der Test wartet |
| `POST/DELETE /api/campaigns/:id/resend` | Erinnerung an Nicht-Öffner einrichten (`{subject, after_hours, sender_name?, now?}`) oder entfernen |
| `GET /api/campaigns/:id/sto` | Verteilung der Sendestunden für die aktuelle Empfängerauswahl |
| `PATCH /api/campaigns/:id` | zusätzlich `ab`, `resend`, `send_mode` (`now`/`sto`), `sender_name`, `wa_template` `{name, language, values}`; `filter.segment_id` |
| `GET/POST /api/segments`, `GET/PATCH/DELETE /api/segments/:id`, `GET /api/segments/meta`, `POST /api/segments/count`, `GET /api/segments/:id/contacts`, `POST /api/segments/:id/count` | Segmente; `count` zählt eine ungespeicherte Definition `{definition}` |
| `GET /api/email-gallery?q=&category=`, `GET /api/email-gallery/:key`, `POST /api/email-gallery/:key/use` `{target: 'template'\|'campaign', campaign_id?, name?}` | Vorlagengalerie |
| `GET/POST/PUT/DELETE /api/deliverability/warmup` | Aufwärmplan (`{plan: conservative\|standard\|fast, domain?}`, `{paused}`) |
| `GET /api/deliverability/reputation?days=` | Raten je Kampagne, Domain, Woche mit Schwellen und Warnungen |
| `GET/PUT /api/deliverability/settings` | Einstellungen von Hygiene, Adressprüfung, Sendezeit, Warenkorbabbruch |
| `GET /api/deliverability/hygiene`, `POST …/hygiene/suppress`, `POST …/hygiene/sunset` | Soft Bounces und Sunset |
| `POST /api/email-validation/check` `{emails}`, `GET …/summary`, `POST …/scan`, `GET …/issues?verdict=`, `POST …/tag` | Adressprüfung |

MCP-Tools: `ghl_campaign_ab_results` (A/B-Ergebnis und Erinnerung), `ghl_list_segments`, `ghl_segment_count`, `ghl_save_segment`, `ghl_email_gallery` (Liste, Suche, Vorlage übernehmen), `ghl_deliverability_report`. Rechte: Bereich *Kampagnen*; Segmente und Galerie dürfen alle mit Lesezugriff ansehen.

## Für Entwickler

Logik und Datenbank sind getrennt, jede Funktion hat ihr Modul – keine Funktion steckt in `server.ts` oder im Zustand.

| Datei | Inhalt |
| --- | --- |
| `server/services/mk-ab.ts`, `mk-resend.ts` | Konfiguration, Aufteilung, Gewinner (rein) und die Zahlen aus der Datenbank |
| `server/services/mk-sto.ts` | Stundenverteilung, Glättung, Bestzeit, Sendezeit je Kontakt |
| `server/services/mk-segments.ts`, `modules/mk-segments.ts` | Definition prüfen, in **eine** SQL-Bedingung übersetzen, zählen, Beobachtung |
| `server/services/campaign-run.ts` | Versandschleife: Zielgruppe, Aufteilung, Aufwärm-Limit, Sendezeit, WhatsApp, Gewinner, Erinnerung |
| `server/services/mk-warmup.ts`, `mk-reputation.ts`, `mk-hygiene.ts`, `mk-validate.ts`, `modules/mk-deliverability.ts` | Zustellbarkeit |
| `server/services/mk-whatsapp.ts` | Prüfung der WhatsApp-Vorlage einer Kampagne |
| `server/services/mk-gallery*.ts`, `modules/mk-gallery.ts` | Vorlagen (Bausteine, Themen, 60 Designs), Suche, Vorschau |
| `server/modules/mk-abandoned.ts` | Auslöser `checkout.abandoned` über `app.services.stripeTaps` und die Workflow-Vorlage |
| `web/src/pages/Segments.tsx`, `EmailGallery.tsx`, `Deliverability*.tsx`, `CampaignAb.tsx`, `CampaignExtras.tsx` | Oberfläche (Segmente, Galerie und Zustellbarkeit werden erst beim Öffnen des Reiters geladen) |

**Jeder Empfänger genau einmal:** Vor dem Senden wird der Empfänger belegt (Status *wird gesendet*); ein zweiter Versandlauf zur selben Zeit – „Senden“ und der Zeitplaner – überspringt ihn. Fertig ist die Kampagne erst, wenn nichts mehr wartet und nichts mehr unterwegs ist. Eine Nachricht, die bei einem Neustart des Servers unterwegs war, wird nicht wiederholt (der Anbieter kann sie schon angenommen haben): nach 30 Minuten steht sie als *Fehler* mit „Versand unterbrochen“ in der Liste.

Tests: `tests/mk-*.test.ts` (A/B-Gewinner, Erinnerung, Sendezeit, Segmente und Zählung, Warenkorbabbruch, Aufwärm-Limits, Schwellen, Adressprüfung, WhatsApp, Galerie, Einstellungs-Link) und die Mandanten-Isolation in `tests/tenant-isolation.test.ts` (Seeds in `tests/security-fixtures.ts`).
