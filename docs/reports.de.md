[English](reports.md) · **Deutsch**

# Berichte & Dashboards

Eigene Auswertungen über alle Bereiche – wie das Reporting von HubSpot: frei zusammengestellte Berichte, mehrere Dashboards mit Raster zum Ziehen und Vergrößern, Vorlagen, Teilen, TV-Modus und regelmäßige E-Mails. Menü **Berichte** (direkt unter *Dashboard*; vom Dashboard aus auch über **Eigene Dashboards**). Es braucht keine Zugangsdaten und kein zusätzliches Paket – alle Diagramme zeichnet die App selbst.

## Bericht erstellen

**Berichte → Bericht erstellen** (oder **+ Bericht**). Links wird eingestellt, rechts zeigt die Vorschau sofort das Ergebnis.

1. **Datenquelle** wählen (siehe Tabelle unten).
2. **Darstellung**: Kennzahl (mit Vergleich zur Vorperiode), Linie, Fläche, Säulen, Gestapelt, Balken, Kreis, Ring, Trichter (z. B. Pipeline-Phasen), Heatmap (z. B. Wochentag × Uhrzeit), Tabelle (sortierbar per Klick auf die Spalte). Beim Wechsel setzt der Builder passende Gruppierungen (Linie → nach Datum, Heatmap → Wochentag und Stunde, Trichter → Phase).
3. **Kennzahlen** (bis 6): Anzahl, berechnete Kennzahlen der Quelle (Win-Rate, gewichtete Umsatzprognose, MRR, No-Show-Rate …), Summe/Ø/Min./Max. von Zahlenfeldern, „eindeutig zählen“. Diagramme zeigen die erste Kennzahl (bzw. alle mit derselben Einheit), die Tabelle alle.
4. **Gruppieren nach** (bis 2): jedes Feld; Datumsfelder nach Tag, Woche, Monat, Quartal, Jahr, Wochentag oder Uhrzeit – immer in der Zeitzone des Sub-Accounts. Leere Tage/Wochen erscheinen als 0. Bei zwei Gruppen wird die zweite zu den Reihen (gestapelt), mehr als 8 Reihen werden zu „Andere“ zusammengefasst.
5. **Filter** (bis 20): ist / ist nicht / ist eines von / enthält / beginnt mit / leer, Zahlen größer/kleiner/zwischen, Datum im Zeitraum (z. B. „Letzte 30 Tage“) / vor / nach, Ja/Nein, „hat Tag“.
6. **Zeitraum**: welches Datumsfeld (z. B. *Erstellt am*, *Gewonnen am*, *Bezahlt am*) und welcher Zeitraum: Heute, Gestern, Diese/Letzte Woche, Letzte 7/30/90/365 Tage, Dieser/Letzter Monat, Dieses/Letztes Quartal, Dieses/Letztes Jahr, Letzte 12 Monate, Gesamter Zeitraum oder von–bis. **Mit Vorperiode vergleichen** stellt jedem Wert den Zeitraum davor gegenüber; „Dieser Monat“ (bis heute) wird mit denselben Tagen des Vormonats verglichen, „Letzte 30 Tage“ mit den 30 Tagen davor. **Zeitraum im Dashboard beibehalten** hält den Bericht unabhängig vom Dashboard-Zeitraum (z. B. „Offener Pipeline-Wert“ über alle Daten).
7. **Sub-Accounts**: „Nur dieser“ oder „Alle meine Sub-Accounts“ (Agentur-Sicht; jede Quelle hat dafür die Gruppe *Sub-Account*).
8. **Höchstens (Top N)**: nur die größten N Gruppen.

Oben: **Tabelle/Diagramm** umschalten, **CSV** (für Excel: Semikolon, Dezimalkomma), **Zum Dashboard** (bestehendes oder neues), **In Bibliothek speichern** (Name, Beschreibung, sichtbar für mich / Team dieses Sub-Accounts / alle Admins). Gespeicherte Berichte liegen unter **Bibliothek**; fremde Berichte lassen sich als Kopie speichern.

### Datenquellen

| Quelle | Inhalt | Beispiele |
| --- | --- | --- |
| Kontakte | Quelle, Zuständig, Stadt, Tags, „hat Opportunity“, „ist Kunde“, erste/letzte Quelle (Attribution) | Leads je Quelle, Lead → Deal |
| Opportunities | Pipeline, Phase, Status, Wert, Währung, gewichteter Wert, Wahrscheinlichkeit, Verlustgrund, Erwarteter Abschluss (auch „überfällig“), Erstellt/Gewonnen/Verloren/Abgeschlossen am, Tage bis Abschluss, Kontaktfelder | Pipeline-Wert je Phase, Win-Rate, Umsatzprognose (auch je Abschlussmonat), Verlustgründe, Deal-Geschwindigkeit |
| Aufgaben | Zuständig, offen/erledigt, überfällig, fällig/erledigt am | Aufgaben je Nutzer, Erledigungsquote |
| Termine | Kalender, Status, Herkunft, Dauer, Vorlauf | No-Show-Rate, Show-Rate, Absagequote |
| Nachrichten | Kanal, Richtung, Status, gesendet von, geöffnet/geklickt (nur Menschen), maschinell geöffnet | Nachrichten je Kanal, Öffnungsrate |
| Konversationen | ungelesen, markiert, begonnen am | neue Gespräche je Woche |
| Anrufe | Richtung, Status, angenommen, Mitarbeiter, Dauer | Anrufe je Nutzer, Annahmequote, Gesprächsminuten |
| Rechnungen & Zahlungen | Art, Status, überfällig (ab dem Tag nach dem Fälligkeitstag, in der Zeitzone des Sub-Accounts), Abo-Rechnung, Brutto/Netto/Steuer, Kunde | bezahlter Umsatz, offene/überfällige Beträge |
| Umsatz je Produkt | Rechnungspositionen mit Menge und Netto-Umsatz | Umsatz je Produkt |
| Abos (MRR) | wiederkehrende Rechnungen auf den Monat umgerechnet | MRR, ARR, MRR je Intervall |
| Kampagnen | Empfänger je Kampagne | gesendet, Öffnungs-/Klickrate (nur Menschen; Apple Mail, Proxys und Scanner stehen getrennt als „Maschinell geöffnet/geklickt“ – [docs/email-tracking.md](email-tracking.md)) |
| Formular-Einsendungen | Formular, Kontaktfelder | Einsendungen, Conversion zu Deal/Kunde |
| Attribution | Kontaktpunkte nach Art, Kanal, Quelle, Medium, Kampagne, Funnel | eindeutige Besucher je Kanal |
| Affiliate-Provisionen | Partner, Programm, Status, Betrag | Provision je Partner |
| Kurs-Einschreibungen | Kurs, Status, begonnen/abgeschlossen | Abschlussquote |

Dazu kommen „Firmen“, je eigenem Objekt eine Quelle mit seinen Eigenschaften und „Lead-Scores“ ([docs/objects.de.md](objects.de.md#snapshots-supabase-berichte-import)). Weitere Module (z. B. Tickets) können eigene Quellen anmelden, siehe [architecture.de.md](architecture.de.md#berichte-eigene-datenquellen).

### Eigene Kontaktfelder

Die eigenen Felder der Kontakte (*Einstellungen → Eigene Felder*) stehen in der Quelle **Kontakte** unter **Eigene Felder** bereit: **Zahlenfelder** als Kennzahl (Summe, Ø, Min, Max – z. B. „Summe Budget je Paket“, auch als Dashboard-Baustein), **Auswahl**, **Ja/Nein**, **Datum** und Textfelder zum Gruppieren und Filtern. Jedes Feld gilt nur in den Sub-Accounts, in denen es angelegt ist; neue oder geänderte Felder sind sofort da. Technik: `server/modules/report-custom-fields.ts` (ergänzt die Quelle `contacts` in `app.services.reportSources`, Feldschlüssel `cf_<schlüssel>`).

### Phasen-Wahrscheinlichkeit (gewichtete Prognose)

**Opportunities → Pipeline bearbeiten**: rechts neben jeder Stufe die Wahrscheinlichkeit in %, mit der ein Deal dort gewonnen wird. Leer = automatisch nach Position (bei 4 Stufen 20/40/60/80 %). Gewonnene Deals zählen 100 %, verlorene 0 %. Die **Umsatzprognose (gewichtet)** ist die Summe aus Wert × Wahrscheinlichkeit aller offenen Deals. Gewinn- und Verlustdatum merkt sich die App ab jetzt beim Statuswechsel; ältere Deals nutzen ihre letzte Änderung.

### Erwarteter Abschluss, Verlustgrund und Währung

Jeder Deal hat ein **erwartetes Abschlussdatum** (optional), eine **Währung** (Standard EUR) und – wenn er auf „Verloren“ steht – einen **Verlustgrund**. Das Datum treibt die Prognose nach Monat (Vertrieb-Dashboard: *Prognose je erwartetem Abschlussmonat*, Living-Boards-Vorlage `forecast_by_close_month`), der Filter *Abschluss überfällig* zeigt offene Deals, deren Termin verstrichen ist. Die Gründe wählt man aus der Liste der Pipeline (**Opportunities → Pipeline bearbeiten → Verlustgründe**, ein Grund pro Zeile; leer = Standardliste) oder schreibt einen eigenen. *Verlorene Deals nach Grund* (Dashboard Vertrieb, Board-Vorlage `lost_reasons`) gruppiert nach `lost_reason` mit Anzahl und `calc:lost_value`. Beträge in verschiedenen Währungen werden **nicht umgerechnet**: Summen im Kanban stehen je Währung nebeneinander, in Berichten trennt die Gruppierung `currency` sie.

Der Verlustgrund ist **Pflicht** beim Wechsel auf „Verloren“ – in der Oberfläche, per API (`lost_reason`), MCP (`ghl_update_opportunity`), REST-Hook `move_stage` und mobiler App. Workflow-Schritte haben ein Feld „Verlustgrund“; bleibt es leer, steht dort „Per Automation“ (mobile App ohne Angabe: „Per App“). Ein Wechsel zurück auf Offen löscht den Grund; vor diesem Update verlorene Deals bleiben ohne Grund bearbeitbar.

## Dashboards

**Berichte → Dashboards** zeigt dein Standard-Dashboard (oder das erste); oben links wechselst du zwischen allen Dashboards, die du sehen darfst.

- **Filterzeile**: Zeitraum (gilt für alle Widgets ohne festen Zeitraum), Sub-Account oder alle, Auto-Update (1/5/15/60 Minuten), *Mit Vorperiode*, neu laden.
- **Bearbeiten**: Widgets am Griff ziehen, an der Ecke unten rechts vergrößern (12-Spalten-Raster, die anderen rücken nach), Titel direkt ändern, ✕ entfernt. Mit der Tastatur: Griff fokussieren, Pfeiltasten verschieben, mit Umschalt die Größe ändern. **+ Widget** holt einen gespeicherten Bericht oder öffnet den Builder; der Stift an einem Widget bearbeitet es im Builder (**Widget aktualisieren**).
- **Teilen**: nur ich, Team dieses Sub-Accounts oder alle Admins. Geteilte Dashboards sind für andere nur lesbar, und jede Person sieht **nur Zahlen aus den Sub-Accounts und Bereichen, auf die sie selbst Zugriff hat**. Dort auch **Als mein Standard-Dashboard**.
- **TV-Modus**: Vollbild für den Bildschirm im Büro, aktualisiert sich mindestens jede Minute; Esc oder ✕ beendet ihn.
- Auf dem Handy stehen die Widgets untereinander.

### Vorlagen

**Berichte → Vorlagen → Dashboard aus Vorlage** legt mit einem Klick an:

- **Vertrieb**: offener Pipeline-Wert, gewichtete Umsatzprognose, Win-Rate, Deal-Geschwindigkeit, Pipeline-Wert je Phase (Trichter), Prognose je Phase, gewonnener Umsatz je Monat, Deals je Zuständigem.
- **Marketing**: neue Leads, Lead → Deal, Formular-Einsendungen, Öffnungsrate, Leads je Quelle, Leads je Woche, Kampagnen-Performance, Formular-Conversion.
- **Umsatz**: MRR, bezahlter Umsatz, offene und überfällige Rechnungen, Umsatz je Monat und Produkt, offene Rechnungen je Kunde, MRR je Intervall.
- **Aktivität**: Anrufe, ausgehende Nachrichten, erledigte Aufgaben, Annahmequote, Anrufe/Nachrichten/Aufgaben je Nutzer, Heatmap eingehender Nachrichten.
- **Termine**: Termine, No-Show-, Show- und Absagequote, Termine je Kalender und je Woche, No-Show-Rate je Kalender, Heatmap.

## Zeitpläne (Bericht per E-Mail)

Auf einem Dashboard **Per E-Mail**: täglich, wöchentlich (Wochentag) oder monatlich (Tag 1–28) zur gewählten Uhrzeit an bis zu 20 Adressen. Die E-Mail enthält die Kennzahlen mit Veränderung zur Vorperiode und jedes Diagramm als Tabelle mit Balken (ohne Bilder, liest sich in jedem Mailprogramm) plus Link zum Dashboard. Standard-Zeitraum: gestern / letzte Woche / letzter Monat. Gesendet wird über den E-Mail-Versand des Sub-Accounts (**Einstellungen → E-Mail**, SMTP); ohne SMTP wird nur protokolliert. Die Zahlen werden mit den Rechten der Person berechnet, die den Zeitplan angelegt hat. **Berichte → Zeitpläne**: Vorschau, jetzt senden, bearbeiten, pausieren, löschen; dort steht auch das Ergebnis des letzten Versands.

## Sicherheit & Grenzen

- Jede Abfrage ist auf die Sub-Accounts des Nutzers beschränkt (Admins: alle, Kunden-Logins: ihre eigenen, API-Schlüssel eines Sub-Accounts: nur dieser); Kunden-Logins brauchen das Recht *Dashboard* und das Recht des jeweiligen Bereichs (z. B. *Rechnungen & Produkte* für Umsatz-Quellen).
- SaaS-Tarife: Bereiche, die der Tarif eines Sub-Accounts nicht enthält, fehlen auch in dessen Berichten.
- Alle Werte gehen als Parameter an die Datenbank, Feldnamen nur aus der festen Liste der Quelle. Höchstens 1000 Gruppen je Bericht, nach 8 Sekunden bricht eine Abfrage ab („Zeitraum oder Filter einschränken“).

## API & MCP

REST unter `/api/reports/*` (siehe [api.md](api.md)), MCP-Werkzeuge `ghl_run_report` (freier Bericht: Quelle, Kennzahlen, Gruppierungen, Filter, Zeitraum, Vergleich, Agentur-Sicht), `ghl_list_dashboards` und `ghl_get_dashboard` (alle Widgets mit Zahlen, optional anderer Zeitraum).

```bash
# Pipeline-Wert offener Deals je Phase
curl -X POST https://crm.example.com/api/reports/run -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"query":{"source":"opportunities","measures":["sum:value","calc:forecast"],"group_by":["stage"],"filters":[{"field":"status","op":"eq","value":"open"}],"range":"all"}}'
```
