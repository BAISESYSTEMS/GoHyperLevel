[English](bug-reports.md) · **Deutsch**

# Fehler & Wünsche

Jeder Login – Agentur-Admins genauso wie Kunden-Logins, die nur ihren eigenen Sub-Account sehen – kann in HyperLevel
Fehler melden, Fragen stellen und Funktionen wünschen. Alles landet als **Ticket im Helpdesk** eines
Support-Sub-Accounts der Agentur (Pipeline „Fehler & Wünsche“); es gibt keinen zweiten Ticket-Speicher.
Keine Zugangsdaten nötig.

## Wohin die Meldungen gehen

*Agentur → Fehler & Wünsche → Support-Bereich für Fehlermeldungen*: der Sub-Account, dessen Tickets die Meldungen
bekommen. Standard: beim ersten Bericht legt HyperLevel einen eigenen Sub-Account **„HyperLevel Support“** an (Name nach
dem White-Label, Zufriedenheits-Umfrage dort aus). Du kannst stattdessen einen vorhandenen wählen, z. B. das Projekt
„Mein Projekt“ – neue Meldungen gehen dann dorthin, ältere bleiben, wo sie sind.

Dort entsteht einmalig:

- die Ticket-Pipeline **Fehler & Wünsche**: *Neu → Bestätigt → In Arbeit → Behoben → Ausgeliefert*, dazu
  *Abgelehnt* und *Duplikat* (Stufen-IDs `neu`, `bestaetigt`, `in_arbeit`, `behoben`, `ausgeliefert`,
  `abgelehnt`, `duplikat`),
- die Kategorien **Fehler**, **Verbesserungswunsch**, **Frage**,
- die geteilten Ansichten **Fehler & Wünsche** und **Automatisch erfasste Fehler** in *Tickets*.

Die **SLA-Ziele des Helpdesks** gelten wie für jedes Ticket (Priorität aus dem Schweregrad: Kleinigkeit → niedrig,
Stört → normal, Blockiert mich → hoch, Kritisch → dringend). Wünsche haben nur eine Frist für die erste Antwort,
keine für die Umsetzung. Wer meldet, wird im Support-Sub-Account ein **Kontakt** (per Login-E-Mail, Tag
`GoHigh-Nutzer`, ohne Workflows auszulösen) – Zugang zu diesem Sub-Account bekommt er nie.

## Fehler melden

Oben rechts **Feedback** (neben dem „?“ der Akademie) → *Fehler melden* – oder auf jeder Seite
<kbd>Strg</kbd>+<kbd>Umschalt</kbd>+<kbd>F</kbd>. Das Fenster (✕ oben rechts, <kbd>Esc</kbd> schließt) fragt:

- **Art:** Fehler, Verbesserungswunsch oder Frage,
- **Was ist passiert?**, **Was hast du erwartet?**, **Schritte zum Nachstellen**, **Wie schlimm ist es?**,
- **Screenshot** (optional): aus der Zwischenablage einfügen (<kbd>Strg</kbd>+<kbd>V</kbd>), Datei wählen oder
  **Bildschirm aufnehmen** (`getDisplayMedia`, wenn der Browser es kann – das Fenster blendet sich dabei aus).
  PNG, JPG oder WebP bis 3 MB; große Bilder verkleinert der Browser vorher.
- **Diagnosedaten** – werden automatisch angehängt, lassen sich ansehen und einzeln (oder alle) entfernen:
  Seite/URL, Sub-Account und Rolle, Web-Build, Browser und System, Fenstergröße, die letzten 20 Fehler im Browser
  (`window.onerror`/`unhandledrejection`) und die letzten 20 fehlgeschlagenen API-Aufrufe (Status, Pfad,
  Fehlertext). **Nie** Anfrage-Inhalte, Formularwerte, Passwörter oder Schlüssel; der Server säubert alles noch
  einmal (Tokens, `key=`/`token=` in URLs, E-Mail-Adressen, Kartennummern, lange Zufallsfolgen) und ergänzt
  Server-Version, Rolle und Sub-Account selbst.

Danach zeigt HyperLevel die **Ticketnummer**. Die Agentur bekommt bei neuen Fehlern und Fragen eine Push-Mitteilung.

## Meine Meldungen

*Feedback → Meine Meldungen* (`/app/feedback`): nur die eigenen Meldungen mit Status, den **öffentlichen Antworten
des Teams** (interne Notizen nie), Status-Wechseln und „Behoben in Version …“. Man kann Infos (auch mit Screenshot)
nachreichen und eine erledigte oder abgelehnte Meldung **wieder öffnen** (sie geht zurück auf *Neu*).

Ändert sich der Status oder antwortet das Team, gibt es eine **Benachrichtigung in der App** (rote Zahl am
Feedback-Knopf), eine **Push-Mitteilung** (Art „Meine Meldungen & Wünsche“, abschaltbar unter Mein Konto), eine
Meldung in der **Android-App** und eine **E-Mail** (über den Versand des Support-Sub-Accounts, abschaltbar unter
Meine Meldungen). Antworten aus der normalen Ticket-Ansicht per E-Mail gehen nicht doppelt raus.

## Wunschliste

*Feedback → Wunschliste* (`/app/wishes`) – für alle Nutzer:

- **Alle Wünsche** aller Nutzer; Namen der Einreichenden und Sub-Accounts sieht nur die Agentur.
- **Einreichen:** Titel, Beschreibung, Bereich (CRM, Marketing, Websites & Funnels, Automationen, Service, Umsatz,
  KI, App, Agentur, Sonstiges), optional Screenshot (für alle sichtbar). Wer einreicht, stimmt automatisch mit.
- **Abstimmen:** eine Stimme je Nutzer, ein zweiter Klick nimmt sie zurück. **Kommentare** sind öffentlich (Autor
  „Nutzer“, „Du“ oder „Team“); der Autor erfährt von neuen Kommentaren.
- **Suchen, filtern** nach Bereich und Status, **sortieren** nach Stimmen, neu oder Status.
- **Roadmap:** *Idee → Geplant → In Arbeit → Fertig*, dazu *Abgelehnt* mit Begründung. Das sind dieselben
  Ticket-Stufen (Neu → Bestätigt → In Arbeit → Ausgeliefert/Behoben, Abgelehnt).
- Ändert sich der Status oder wird ein Wunsch umgesetzt, hören **Autor und alle Abstimmenden** davon (App, Push,
  E-Mail). **Duplikate** werden zusammengeführt – Stimmen und Abstimmende ziehen mit um.

### Was ist neu

*Wunschliste → Was ist neu*: umgesetzte Wünsche und behobene Fehler, gruppiert nach Version. Titel von
Fehlermeldungen bleiben privat – dort steht nur die Zeile, die das Team bei „Behoben in Version …“ einträgt (sonst
„n Fehlerbehebungen“). Gibt es seit dem letzten Besuch Neues, zeigt der Feedback-Knopf einen Hinweis.

## Automatische Fehlererfassung

- **Browser:** unbehandelte Fehler gehen – ohne Inhalte – an `/api/feedback/client-errors`, wenn der Nutzer es
  erlaubt (*Meine Meldungen → Fehler automatisch melden*; für Admins standardmäßig an, für Kunden-Logins aus).
  Rauschen wie `Script error.`, `ResizeObserver loop` oder Browser-Erweiterungen wird ignoriert.
- **App-Start:** kommt die Web-App nach 10 Sekunden nicht hoch (leere Seite, fehlende Datei, zu alter Browser), schickt
  `web/public/boot-guard.js` die gesammelten Fehler (ohne Inhalte) als „App-Start fehlgeschlagen …“ – ein Ticket je Ursache
  wie alle Browser-Fehler, nur für angemeldete Nutzer mit eingeschalteter Erfassung, höchstens alle 10 Minuten je Gerät.
  Dasselbe gilt für Darstellungsfehler, die keine Seite abgefangen hat (die ganze Oberfläche wäre sonst leer).
- **Server:** unerwartete Fehler (HTTP 500) werden mit Stack, Route und **Request-ID** erfasst – nie mit dem
  Anfrage-Inhalt. Die Antwort an den Browser enthält die Request-ID (`request_id`, Header `x-request-id`).
- **Android-App:** Abstürze und Fehler der App über denselben Weg (Gerät, App-Version). „Diagnose senden“ auf dem
  Fehlerbildschirm der Web-Ansicht legt eine Fehlermeldung mit WebView-Version, Status und den letzten Fehlern an.
- **Gruppierung:** ein Ticket je Fehler (Fingerabdruck aus der Meldung ohne Zahlen/IDs und der obersten
  Stack-Zeile ohne Zeilennummer und Build-Hash) mit Zähler, erstem/letztem Auftreten, den letzten 10 Vorkommen und
  betroffenen Sub-Accounts; bei 10, 100, 1000 … Vorkommen eine Notiz am Ticket. Tritt ein behobener Fehler wieder
  auf, geht das Ticket zurück auf *Bestätigt*.
- **Grenzen:** je Nutzer 20 Fehlerberichte in 10 Minuten, höchstens 30 neue Fehler-Tickets pro Stunde (ein
  kaputtes Update erzeugt keine Ticketflut), im Browser höchstens 10 Berichte je Seitenaufruf.
- Abschalten: *Agentur → Fehler & Wünsche* (Server-Fehler und/oder Browser-/App-Fehler).

Betroffene Nutzer mit eingeschalteter Erfassung erfahren nur, wenn der Fehler **behoben** ist.

## Triage für die Agentur

In *Tickets* des Support-Sub-Accounts (Ansicht „Fehler & Wünsche“) zeigt jedes dieser Tickets rechts das Feld
**Fehler & Wünsche**: Diagnose (Seite, Versionen – mit Hinweis, wenn der Browser eine alte Web-Version hatte –,
Browser/Gerät, letzte Fehler mit Stack, fehlgeschlagene Anfragen, letzte Vorkommen mit Request-ID), Screenshots,
Vorkommen, Melder bzw. betroffene Nutzer mit Rolle und Sub-Account, betroffene Sub-Accounts, Stimmen und
Abstimmende, und was der Melder sieht. Aktionen:

- **Als Duplikat von …** – Original suchen (Titel oder #Nummer); Melder, Stimmen und Vorkommen ziehen um, das
  Ticket wird „Duplikat“, die Melder erfahren es.
- **Behoben in Version …** (bei Wünschen „Fertig in Version …“) – Version, optional eine Zeile für „Was ist neu“,
  „schon ausgeliefert“ (sonst Status *Behoben*). Alle verknüpften Melder werden benachrichtigt.
- **Öffentlich antworten**, **Ablehnen** (mit öffentlicher Begründung), bei Wünschen **ausblenden**.

Status, Priorität, Zuständige und interne Notizen pflegst du wie bei jedem Ticket – jeder Status-Wechsel
benachrichtigt die Melder. *Agentur → Fehler & Wünsche* listet offene Meldungen, Top-Wünsche (nach Stimmen) und die
häufigsten Fehler.

**Berichte:** Quellen *Fehlermeldungen* (Art, Status, Schweregrad, Plattform, Version, Sub-Account, Melder,
Vorkommen, Tage bis behoben; Behoben-Quote) und *Feature-Wünsche* (Bereich, Stimmen, Status; Umgesetzt-Quote).

### Mit Claude oder Codex triagieren (MCP)

Mit einem Agentur-Schlüssel stehen am MCP-Server bereit:

| Werkzeug | Zweck |
| --- | --- |
| `ghl_list_bug_reports` | Meldungen (`kind`: reports/bug/question/auto, `state`, `status`, `sort` inkl. `occurrences`, `q`) |
| `ghl_get_bug_report` | alles für die Fehlersuche inkl. Diagnose, Stack, Request-IDs, Verlauf und internen Notizen |
| `ghl_update_bug_report` | `status`, `reason`, `reply` (öffentlich), `fixed_in` + `changelog`, `note` (intern), `duplicate_of` |
| `ghl_list_wishes` | Wünsche nach Stimmen (`status`: idea/planned/in_progress/done/declined, `area`, `q`) |
| `ghl_update_wish` | `status`, `reason`, `reply`, `shipped_in` + `changelog`, `note`, `duplicate_of`, `hidden` |

Typischer Ablauf: `ghl_list_bug_reports {sort: "priority"}` → `ghl_get_bug_report` → Fehler im Code beheben →
`ghl_update_bug_report {fixed_in: "2.4.1", changelog: "…"}`.

## Android-App

*App-Einstellungen → Fehler melden* oder lange auf das App-Symbol drücken → **Fehler melden**; optional
„Schütteln zum Melden“. Das Formular nimmt einen Screenshot des aktuellen Bildschirms mit (entfernbar), Gerät
(Modell, Android-Version), App-Version und die letzten fehlgeschlagenen API-Aufrufe der App. Dazu *Meine Meldungen*
und eine einfache *Wunschliste* (abstimmen, einreichen). Schnittstelle: `/api/mobile/bug-reports` und
`/api/mobile/wishes` ([docs/api.md](api.md#mobile-app)).

## API

Alle Routen gelten für jeden angemeldeten Nutzer (bewusst nicht in `permissions.ts`) und liefern nur eigene
Meldungen bzw. öffentliche Wunsch-Daten; die Triage-Routen sind Admin-only. Liste: [docs/api.md](api.md#bug-reports--wishes).

## Für Entwickler

`server/modules/feedback.ts` (Tabellen, Routen für Nutzer und App, Benachrichtigungen), `feedback-admin.ts`
(Einstellung, Triage, MCP, Berichtsquellen), `feedback-capture.ts` (automatische Erfassung,
`app.services.serverError`), Datenschicht `server/services/feedback-store.ts` (nutzt `services/tickets.ts`),
reine Bausteine in `services/feedback.ts`. Oberfläche: `web/src/pages/Feedback.tsx` (Knopf, Formular, Meine
Meldungen), `Wishes.tsx`, `FeedbackAdmin.tsx` (Feld im Ticket, Agentur-Reiter), Ringpuffer in
`web/src/feedback/diagnostics.ts` (fehlgeschlagene API-Aufrufe meldet `api.ts` per Ereignis `pghl:api-error`).
Test-Haken: `app.services.feedbackMailer` (E-Mails), `app.services.feedbackCaptureReset()` (Grenzen).
