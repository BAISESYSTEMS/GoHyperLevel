# Service: Tickets, SLAs, Wissensdatenbank, Umfragen & Health-Score

Der Helpdesk von HyperLevel – vergleichbar mit dem HubSpot Service Hub. Menü **Service** mit *Tickets*, *Wissensdatenbank* und *Umfragen*; Einstellungen unter **Einstellungen → Service**. Rechte: Bereich **Service** (Kunden-Logins brauchen den Haken „Service“); die Service-Einstellungen gehören zum Bereich *Einstellungen*, Health-Scores zu *Kontakte*. Im SaaS-Modus muss der Tarif den Bereich „Service“ enthalten (bestehende Tarife bekommen ihn nicht automatisch – unter Agentur → SaaS → Tarif anhaken).

Keine Zugangsdaten nötig: Antworten laufen über den eingerichteten Versand (Einstellungen → E-Mail & SMS, Kanäle für WhatsApp), E-Mail → Ticket über eine Weiterleitung an eine Webhook-URL.

## Tickets

Ein Ticket hat Betreff, Beschreibung, **Status** (Stufe einer Ticket-Pipeline), **Priorität** (niedrig, normal, hoch, dringend), Kategorie, Tags, **Zuständige/n** (Login) und **Team/Queue**, Kontakt (und ein leeres Feld `company_id` für ein späteres Firmen-Objekt), **Quelle** (E-Mail, Chat, WhatsApp, SMS, Formular, Portal, Telefon, manuell, API, Workflow), Fälligkeitsdatum, interne Notizen und einen **Verlauf** mit Kundennachrichten, Antworten, Notizen, Status-, Prioritäts- und Zuweisungswechseln, SLA-Warnungen und Bewertungen.

**Pipelines:** Standard ist *Neu → In Bearbeitung → Wartet auf Kunde → Gelöst → Geschlossen*. Unter *Einstellungen → Service → Pipelines* beliebig viele Pipelines mit eigenen Stufen; jede Stufe hat eine Bedeutung (*Neu*, *Offen*, *Wartet*, *Gelöst*, *Geschlossen*) und optional „SLA pausieren“.

**Ansichten:** Liste oder Kanban (Drag & Drop zwischen Stufen), Filter nach Status, Priorität, Zuständigen („Mir zugewiesen“, „Nicht zugewiesen“), Team, Kategorie, Quelle, SLA („läuft bald ab“, „überschritten“) und Suche (Betreff, Text, Kontakt, `#Nummer`). Filter lassen sich als **Ansicht** speichern – nur für dich oder für das Team. **Massenaktionen:** Status, Priorität, Zuweisung, Team, Tag, Zusammenführen, Löschen.

**Zusammenführen:** Duplikate (z. B. zweimal geschrieben) in ein Ticket: Verlauf, Tags und Kontakt wandern hinüber, die anderen werden geschlossen und verweisen auf das Ziel.

### Woher Tickets kommen

| Weg | So geht’s |
| --- | --- |
| Konversationen | Knopf **Ticket erstellen** im Gespräch – verknüpft das Gespräch und übernimmt die letzte Kundennachricht. Gibt es schon ein Ticket, führt der Knopf dorthin. |
| Support-Postfach | *Einstellungen → Service → E-Mail → Ticket*: die angezeigte URL (`/hooks/<sub-account>/support-email?key=…`) als Ziel einer Mail-Weiterleitung eintragen (Cloudflare Email Workers, ImprovMX, Mailgun Routes …; JSON oder Formular mit `from`, `to`, `subject`, `text`/`html`). Jede Mail wird ein Ticket oder landet im offenen Ticket des Absenders; schickt der Dienst dieselbe Mail noch einmal (gleiche `Message-Id`), wird sie nur einmal übernommen. |
| Normale eingehende E-Mails | gleiche Seite: „Ticket, wenn eine Regel passt“ (an Support-Adresse, Betreff enthält, Absender-Domain) oder „jede E-Mail“. Optional auch Mails aus der Postfach-Synchronisation (IMAP) – ab dem Einschalten, keine alten Mails. |
| Formulare | Formular → Einstellungen → **Jede Einsendung als Ticket anlegen** (Priorität, Kategorie, Team). Ein Feld „Betreff“/„Anliegen“ wird zum Betreff, alle Antworten zur Beschreibung. |
| Kundenportal | „Meine Anfragen“ im Mitgliederbereich (siehe unten). |
| Anrufe | Ticket-Knopf in der Anrufliste – mit Voicemail-Transkript, Anruf verknüpft. |
| API / MCP / Workflow | `POST /api/tickets`, `ghl_create_ticket`, Workflow-Aktion **Ticket anlegen**. |

**Antworten im Ticket** gehen über den normalen Versand (E-Mail, SMS, Live-Chat, WhatsApp) an den Kontakt, erscheinen auch in Konversationen und tragen bei E-Mail `[Ticket #123]` im Betreff. Antwortet der Kunde (mit dieser Nummer oder auf jedem Kanal, solange ein Ticket offen ist), landet die Nachricht im Ticket; *Wartet auf Kunde* und *Gelöst* springen dann zurück auf *In Bearbeitung*. Optional schickt HyperLevel eine **Eingangsbestätigung** (Einstellungen → Service → Antworten).

**Textbausteine** mit Platzhaltern: `{{contact.first_name}}`, `{{contact.name}}`, `{{ticket.number}}`, `{{ticket.subject}}`, `{{ticket.status}}`, `{{agent.name}}`, `{{location.name}}` (Fallback: `{{contact.first_name|du}}`). Beim Schreiben schlägt HyperLevel passende **Hilfe-Artikel** vor (Klick fügt Titel und Link ein).

### Zuweisung

*Einstellungen → Service → Teams & Zuweisung*: **Manuell**, **Round Robin im Standard-Team** oder **nach Kategorie** (Regel Kategorie → Team oder Person, sonst Round Robin). Teams haben Mitglieder und verteilen reihum; im Ticket wählt „↻ Nächste/r im Team“ von Hand. **Auslastung** (Tab in Tickets): offene, wartende, dringende und überfällige Tickets je Person, gelöste der letzten 7 Tage, nicht zugewiesene.

## SLAs

Je Priorität ein Ziel für **erste Antwort** und **Lösung** (Stunden, 8 Std. = ein Arbeitstag). „Geschäftszeit“ zählt nur die Öffnungszeiten des Sub-Accounts (in seiner Zeitzone, ohne Feiertage/Schließtage), „rund um die Uhr“ jede Minute. Standard: dringend 1 Std./1 Tag, hoch 4 Std./3 Tage, normal 1 Tag/5 Tage, niedrig 2/10 Tage. In einer Stufe mit „SLA pausieren“ (*Wartet auf Kunde*) steht die Lösungszeit still und läuft danach mit der Restzeit weiter. Ändert sich die Priorität, gelten die neuen Ziele; wird ein gelöstes Ticket wieder geöffnet, beginnt die Lösungszeit neu.

Timer stehen in Liste, Kanban und Ticket („Antwort in 3 Std.“, gelb „läuft bald ab“ ab 75 % der Zeit – einstellbar, rot „überfällig“). Der Hintergrund-Takt schreibt Warnung und Überschreitung in den Verlauf, meldet sie per Push und löst die Workflows **SLA läuft bald ab** und **SLA überschritten** aus. Eingebaute Eskalation (abschaltbar): Zuständige/n per E-Mail + Push benachrichtigen, Priorität eine Stufe erhöhen, an ein Team geben. Mehr per Workflow (Vorlage „SLA überschritten: Priorität hoch + Team informieren“): Aktion **Ticket ändern / eskalieren** (Status, Priorität „eine Stufe höher“, Team, Zuständige/r inkl. Round Robin, Notiz, Benachrichtigung) und **Team benachrichtigen**.

**Workflow-Auslöser:** Ticket angelegt, Ticket-Status geändert, Ticket zugewiesen, SLA läuft bald ab, SLA überschritten, Health-Score gesunken – mit Filtern (Priorität, Kategorie, Pipeline, Stufe, Zuständige/r, erste Antwort/Lösung, Farbe). Damit jedes Ticket den Workflow startet, im Workflow „Kontakt darf mehrmals hinein“ anhaken. Im Workflow stehen die Ticketdaten als `{{event.ticket.number}}`, `{{event.ticket.subject}}`, `{{event.ticket.url}}` usw. bereit.

## Dashboard

*Tickets → Übersicht*: offene Tickets nach Status, Priorität und Zuständigen, nicht zugewiesene, SLA überschritten / läuft bald ab, **SLA-Quote** (erste Antwort und Lösung, eingehalten vs. verfehlt), Ø erste Antwort und Ø Lösungszeit, Verlauf (offene Tickets je Tag, neu vs. gelöst), CSAT und NPS – für 7, 30 oder 90 Tage.

## Wissensdatenbank & Hilfe-Center

Kategorien und Artikel in Markdown (Überschriften, Listen, Links, Bilder, Hinweise, Code, Video-Links) mit Vorschau, Entwurf/veröffentlicht, Tags als Suchbegriffe, SEO-Titel/-Beschreibung, `noindex`. Entwürfe lassen sich über einen geheimen Vorschau-Link ansehen.

Das **Hilfe-Center** schaltest du unter *Einstellungen → Service → Portal & Hilfe-Center* ein (Adresse, Titel, Begrüßung, Farbe, SEO, Hinweis „Nichts gefunden?“). Es liegt unter `https://<deine-domain>/help/<adresse>`, auf jeder verbundenen Website-Domain des Sub-Accounts unter `/help` (auch in deren `sitemap.xml`) und optional auf einer eigenen Domain (z. B. `hilfe.firma.de`, CNAME/A-Record auf den Server). Besucher suchen (Titel, Tags, Text), stöbern nach Kategorien, bewerten Artikel mit „War das hilfreich?“ (einmal je Besucher und Tag) und kommen über „Anfrage stellen“ ins Kundenportal. Jede Seite hat Titel, Beschreibung, Canonical, Open-Graph-Tags und JSON-LD; `/help/<adresse>/sitemap.xml` listet alle Artikel. Aufrufe und Bewertungen stehen in der Artikelliste.

Veröffentlichte Artikel fließen automatisch ins Wissen des **KI-Assistenten** (Antwortvorschläge, Chat-Bot); MCP sucht mit `ghl_search_kb`.

## Kundenportal „Meine Anfragen“

Im Mitgliederbereich (`/portal/<sub-account>/tickets`, Link oben und Karte auf der Startseite): Kunden sehen ihre Tickets mit Status („Wartet auf dich“), lesen die Antworten des Teams, antworten und stellen neue Anfragen (Betreff, Thema, Nachricht). Interne Notizen, Zuweisungen und SLA-Details sehen sie nie. Anmelden dürfen sich Kontakte mit Ticket (oder Kurs/Community); mit „Jeder Kontakt mit E-Mail darf sich anmelden“ jeder bekannte Kontakt. Formulare im Portal sind gegen fremde Seiten (Origin + Token) geschützt.

## Zufriedenheit (CSAT) & NPS

**CSAT:** Wird ein Ticket gelöst oder geschlossen, bekommt der Kontakt (optional verzögert) einen signierten Link – per E-Mail mit fünf Smiley-Knöpfen, sonst per SMS. Die Seite fragt 1–5 und einen Kommentar; erst das Absenden zählt (Mail-Scanner, die Links öffnen, stimmen nicht ab). Ergebnis am Ticket, am Kontakt, im Dashboard und unter *Umfragen → Zufriedenheit* (Ø, Anteil zufrieden, Antwortquote, Verteilung, Kommentare). Ereignis `csat.received`. Je Ticket geht die Umfrage einmal raus: sie wird am Ticket vermerkt, bevor sie gesendet wird – wird das Ticket wieder geöffnet und erneut gelöst, kommt keine zweite (auch nicht, während die erste noch unterwegs ist). *Umfrage senden* am Ticket schickt sie bewusst noch einmal; ein Doppelklick darauf wird abgewiesen, solange sie unterwegs ist. Eine Zufriedenheitsumfrage gilt rechtlich als Werbung: Kontakte mit „Nicht stören“, einem Widerruf oder ohne Einwilligung nach der [Versandregel](consent.md#the-send-gate) bekommen keine (auch nicht von Hand), die Mail trägt den Abmelde-Link.

**NPS:** *Umfragen → Weiterempfehlung* → Umfrage mit Frage, Kanal (E-Mail/SMS), Zielgruppe (Tags oder Smart List) und Text mit `{{nps_link}}`. „Senden“ schreibt alle passenden Kontakte (ohne „Nicht stören“) im Hintergrund an, „Neue Kontakte anschreiben“ später nur die Neuen. Jeder Empfänger wird vor dem Versand belegt, so dass ihn zwei Läufe gleichzeitig nicht doppelt anschreiben; eine Nachricht, die bei einem Neustart gerade unterwegs war, wird nicht noch einmal gesendet, sondern nach 30 Minuten als fehlgeschlagen („Versand unterbrochen“) gezählt. Jeder Link ist persönlich und signiert; Antworten (0–10 + Grund) lassen sich ändern. NPS = % Promotoren (9–10) − % Kritiker (0–6). Ereignis `nps.received`.

## Kunden-Health-Score

0–100 je Kontakt mit Ampel (grün ab 70, gelb ab 40 – einstellbar) aus gewichteten Signalen: offene Tickets, überfällige Tickets (SLA), letzte CSAT-Bewertung, letzter NPS, Tage seit der letzten Aktivität, überfällige Rechnungen, Deal-Status (gewonnen/offen/verloren im letzten Jahr) und E-Mail-Engagement (Öffnungen/Klicks der letzten 90 Tage). Jedes Signal ergibt 0–100 Punkte; Signale ohne Daten zählen nicht mit. Gewichte, Schwellen und „gesunken ab“ unter *Einstellungen → Service → Health-Score*.

Der Score wird neu berechnet, sobald sich etwas Relevantes tut (Ticket, Bewertung, Zahlung, Deal, Nachricht, E-Mail-Öffnung) und sonst alle 12 Stunden im Hintergrund. Er steht als **Spalte und Filter** in *Kontakte* (auch in Smart Lists speicherbar) und in der Karte **Service** auf der Kontaktseite (mit Aufschlüsselung, Tickets und Umfragen). Wechselt die Farbe nach unten oder fällt der Wert um mindestens 15 Punkte, startet der Auslöser **Health-Score gesunken** (`health_score.dropped` mit `score, band, previousScore, previousBand`).

## Berichte & Import

**Berichte** (Menü *Berichte*): Quellen *Tickets* (Status/Stufe, Status-Art, Priorität, Kategorie, Quelle, Zuständig, Team, Pipeline, Tags, Erstellt/Erste Antwort/Gelöst/Geschlossen am, erste Antwort und Lösungszeit in Minuten, SLA verletzt – gesamt, erste Antwort, Lösung –, CSAT; Kennzahlen SLA-Quote, Lösungsquote, Ø erste Antwort, Ø Lösungszeit), *Zufriedenheit (CSAT)* (Bewertung, zufrieden ja/nein, Kommentar, Zuständig; Ø Bewertung, Anteil zufrieden), *Weiterempfehlung (NPS)* (Bewertung, Promotor/Passiv/Kritiker, Umfrage; NPS) und *Kunden-Health-Score* (Score, Ampel, Veränderung) – jeweils mit Kontaktfeldern. Rechte: Bereich *Service* (Health-Score: *Kontakte*).

**HubSpot-Import** (*Einstellungen → Import*, Teil „Tickets“): HubSpot-Tickets werden zu HyperLevel-Tickets – Pipeline nach Namen (sonst die erste), Stufe nach Namen oder Bedeutung („New“ → Neu, „Waiting on contact“ → Wartet auf Kunde, „Waiting on us“ → In Bearbeitung, „Closed“ → Geschlossen), Priorität LOW/MEDIUM/HIGH/URGENT → niedrig/normal/hoch/dringend, Owner und Kontakt wie beim übrigen Import, Original-Erstelldatum. Ein zweiter Lauf aktualisiert statt zu verdoppeln (HubSpot-ID am Ticket). Importierte Tickets bekommen keine SLA-Fristen und lösen keine Workflows aus.

## API, MCP & Ereignisse

Endpunkte: [docs/api.md](api.md#service-helpdesk). MCP-Werkzeuge: `ghl_list_tickets`, `ghl_create_ticket`, `ghl_update_ticket`, `ghl_reply_ticket`, `ghl_search_kb`.

Ereignisse (Webhooks und Workflows, alle mit `ticketId` und `ticket: {id, number, subject, status, status_kind, stage_id, pipeline_id, priority, category, source, owner_id, team_id, url}`, `contactId` wenn ein Kontakt dran hängt): `ticket.created`, `ticket.status_changed` (`from, to, stageId, status, kind, previousKind`), `ticket.assigned` (`ownerId, teamId, previousOwnerId`), `sla.warning` / `sla.breached` (`slaKind: first_response|resolution, dueAt`). Dazu `csat.received` (`ticketId, score, comment`), `nps.received` (`campaignId, score, comment`), `health_score.dropped`.

## Für Entwickler

Module: `server/modules/tickets.ts` (Tabellen, Tickets, Pipelines, Teams, Ansichten, Textbausteine, Einstellungen, E-Mail → Ticket, Formulare, Workflow-Aktionen, MCP), `helpdesk-sla.ts` (SLA-Takt, Eskalation, Dashboard, Auslastung), `knowledge-base.ts` (Artikel, Hilfe-Center, Suche, KI-Wissen), `csat.ts` (CSAT, NPS), `health-score.ts`, `helpdesk-portal.ts` (über `app.services.portalKit`). Gemeinsame Logik: `server/services/tickets.ts` (Anlegen/Ändern/Antworten/Zusammenführen, Eingangs-Routing), reine Bausteine in `services/helpdesk.ts`, `services/helpdesk-sla.ts` (Geschäftszeiten-Rechnung) und `services/health-score.ts`. Andere Module können über `app.services.helpdesk.createTicket/updateTicket` Tickets anlegen, Importe über `app.services.ticketsImport` (idempotent je `external_source` + `external_id`); `helpdesk-reports.ts` meldet die Berichtsquellen an; neues Wissen für den KI-Assistenten kommt über `app.services.aiKnowledge`.
