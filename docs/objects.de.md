[English](objects.md) · **Deutsch**

# Firmen, eigene Objekte, Verknüpfungen & Lead-Scoring

Das relationale CRM wie bei HubSpot: neben Kontakten und Deals gibt es **Firmen**, **eigene Objekte** (z. B. Fahrzeuge, Verträge, Immobilien), **Verknüpfungen** zwischen beliebigen Datensätzen mit Labels, eine Seite **Eigenschaften** für alle Felder und **Lead-Scoring**. Es gibt nichts einzurichten und keine Zugangsdaten – alles läuft im eigenen Server.

## Firmen

Menü **Firmen** (unter Kontakte).

- **Felder:** Name, Domain, Branche, Größe (1-10 … 1000+, eine Zahl wird eingeordnet), Telefon, Webseite, Adresse/PLZ/Ort/Land, Zuständig, Lebenszyklusphase (Abonnent, Lead, MQL, SQL, Opportunity, Kunde, Fürsprecher, Sonstiges), Beschreibung – plus eigene Eigenschaften (siehe unten).
- **Keine Dubletten:** jede Domain gibt es nur einmal. Anlegen mit einer vorhandenen Domain aktualisiert die vorhandene Firma (API, Import, Workflows). Doppelte Firmen (gleicher Name) führt **Zusammenführen** auf der Firmenseite zusammen – Kontakte, Deals, Notizen und leere Felder wandern mit.
- **Kontakte ↔ Firmen:** viele-zu-viele, je Kontakt genau eine **primäre Firma**. Das Feld „Firma“ am Kontakt zeigt immer deren Namen und bleibt so mit älteren Funktionen (Platzhalter `{{contact.company}}`, Exporte, Supabase) kompatibel:
  - Tippt man am Kontakt einen Firmennamen ein (Formular, API, Import), wird die Firma mit diesem Namen primär – gibt es sie nicht, wird sie angelegt (abschaltbar).
  - Leert man das Feld, bleibt die Verknüpfung, nur „primär“ fällt weg. Wird die primäre Verknüpfung gelöst oder die Firma gelöscht, rückt die nächste Firma nach (sonst wird das Feld leer).
  - Umbenennen einer Firma ändert das Feld bei allen Kontakten mit dieser primären Firma.
  - Änderungen ohne Ereignis (CSV-Import, Workflow „Feld setzen“) holt der Hintergrund-Job in wenigen Minuten nach.
- **Automatisch per E-Mail-Domain:** Kontakte mit `…@firma.de` werden mit der Firma `firma.de` verknüpft (beim Anlegen des Kontakts und wenn eine Firma ihre Domain bekommt) – nie bei Freemail-Adressen (gmail.com, web.de, gmx.de, t-online.de, outlook.com, icloud.com …). Optional legt HyperLevel für unbekannte Firmen-Domains selbst eine Firma an. Einstellungen über das Zahnrad in der Firmenliste („Alle Kontakte jetzt abgleichen“ prüft danach alle Kontakte).
- **Deals:** neue Opportunities werden mit der primären Firma ihres Kontakts verknüpft; weitere Firmen lassen sich im Deal-Dialog verknüpfen.
- **Firmenseite:** Eigenschaften (nach Gruppen), Kennzahlen (Kontakte, Deal-Wert ohne verlorene, offene Aufgaben), **Aktivität** aus Firmen-Änderungen *und* allen verknüpften Kontakten, Notizen, Aufgaben (erscheinen auch unter *Aufgaben*), alle Verknüpfungen mit Labels.
- **Liste:** Suche, Filter auf jedes Feld (auch eigene Eigenschaften, Anzahl Kontakte/Deals, Deal-Wert), Spalten wählen und sortieren, **gespeicherte Ansichten** je Nutzer (optional fürs Team sichtbar), CSV-Import (Spalten werden erkannt, gleiche Domain – sonst gleicher Name – aktualisiert; Dateien in UTF-8 oder – wie aus Excel „CSV (Trennzeichen-getrennt)“ – Windows-1252) und CSV-Export.
- **Kontaktlisten & Smart Lists** filtern nach Eigenschaften der verknüpften Firmen (Kontakte → „Firma: …“), z. B. alle Kontakte von Firmen der Branche „Software“; das Filter landet mit in der Smart List und damit auch in Kampagnen.

## Eigene Objekte

Menü **Objekte** zeigt alle Objekte; eigene Objekte stehen zusätzlich direkt darunter in der Seitenleiste.

- **Objekt anlegen:** Name in Einzahl und Mehrzahl, Symbol, Beschreibung und die **Anzeige-Eigenschaft** (der Name eines Datensatzes in Listen und Verknüpfungen, z. B. „Kennzeichen“ – optional eindeutig). Weitere Eigenschaften gleich im selben Dialog oder später. Der interne Name beginnt immer mit `p_` (z. B. `p_fahrzeuge`) und kollidiert so nie mit Typen anderer Module.
- **Eigenschaften** haben einen Typ: Text, mehrzeiliger Text, Zahl, Währung (€), Datum, Datum & Uhrzeit, Auswahl, Mehrfachauswahl, Checkbox, URL, E-Mail, Telefon, Nutzer, Datei (Upload) – und optional **Pflichtfeld** und **eindeutig**. Werte werden beim Speichern je Typ geprüft und vereinheitlicht (z. B. „1.234,50“ → 1234.5, „03.10.2026“ → 2026-10-03, „24.12.2026 18:00“ → 18 Uhr in der Zeitzone des Sub-Accounts, Optionen ohne Groß-/Kleinschreibung; einen Tag wie den 31.02. gibt es nicht).
- **Datensätze:** Liste mit Suche, Filtern (je Typ passende Vergleiche), Spalten, Sortierung und gespeicherten Ansichten je Nutzer; Datensatzseite mit Eigenschaften, Aktivität (jede Änderung mit alt → neu), Notizen und Verknüpfungen; CSV-Import (Spaltenköpfe = Namen der Eigenschaften, eindeutige Eigenschaften aktualisieren statt doppelt anzulegen, Fehler mit Zeilennummer) und Export.
- Ein Objekt löschen entfernt auch seine Datensätze, Eigenschaften, Ansichten und Verknüpfungen (die Oberfläche fragt nach).

## Verknüpfungen

Jeder Datensatz kann mit jedem anderen verknüpft werden: Kontakte, Firmen, Deals, Aufgaben, Datensätze eigener Objekte, **Tickets** des Helpdesks – und Typen, die andere Module anmelden. Das Feld **Verknüpfungen** steht auf Kontakt-, Firmen- und Datensatzseiten und im Deal-Dialog: suchen, verknüpfen, Labels setzen, primär markieren, lösen.

- **Labels** beschreiben die Beziehung, z. B. Kontakt ↔ Firma „Entscheider“, „Rechnungsempfänger“, Kontakt ↔ Fahrzeug „Fahrer“. Labels legt man unter *Eigenschaften* beim jeweiligen Objekt an; ein gelöschtes Label verschwindet von allen Verknüpfungen.
- Wird ein Datensatz gelöscht (Kontakt, Deal, Aufgabe, Firma, Datensatz, auch über einen gelöschten Sub-Account oder eine gelöschte Pipeline), verschwinden seine Verknüpfungen automatisch.
- Ereignisse `association.created` / `association.removed` gehen an Webhooks.

## Eigenschaften

Menü **Objekte → Eigenschaften** (oder *Einstellungen → Felder & Tags → Alle Eigenschaften*): eine Seite für die eigenen Felder von **Kontakten** (die bisherigen eigenen Felder – unverändert nutzbar, jetzt mit Gruppe und Beschreibung), **Firmen**, **Deals** und jedem **eigenen Objekt**.

- Eigenschaften in **Gruppen** ordnen (die Gruppen gliedern die Eigenschaften auf Firmen- und Datensatzseiten), Bezeichnung, Typ, Optionen, Beschreibung (Hilfetext unter dem Feld), Pflicht, eindeutig. Standard-Eigenschaften werden zum Nachschlagen angezeigt.
- Kontakt-Eigenschaften bieten die Typen, die die Kontaktseite kann (Text, mehrzeilig, Zahl, Datum, Auswahl, Checkbox, E-Mail, Telefon, URL); Pflicht/eindeutig gibt es dort nicht.
- **Deal-Eigenschaften** bearbeitest du im Deal-Dialog der Pipeline.
- Beim Löschen einer Eigenschaft von Firmen, Deals oder Objekten werden ihre Werte entfernt; Kontaktfelder behalten ihre Werte (wie bisher). „Eindeutig“ lässt sich nur einschalten, wenn es keine doppelten Werte gibt.

## Workflows

- **Auslöser:** „Firma angelegt“, „Firma geändert“, „Firmen-Eigenschaft geändert“ (Eigenschaft und optional neuer Wert, z. B. Phase = `customer`), „Datensatz (eigenes Objekt) angelegt/geändert“, „Eigenschaft eines Datensatzes geändert“ (je Objekt). Workflows laufen je Kontakt – gestartet werden die **mit dem Datensatz verknüpften Kontakte**, optional nur mit einem Label (z. B. nur „Entscheider“) oder nur die, deren primäre Firma es ist. Platzhalter: `{{event.company.name}}`, `{{event.company.custom.<schlüssel>}}`, `{{event.record.display}}`, `{{event.record.properties.<schlüssel>}}`, `{{event.property}}`, `{{event.value}}`.
- **Aktionen:** „Firma/Datensatz anlegen“ (Werte mit Platzhaltern, Firma per Domain ohne Dublette, gleich mit dem Kontakt verknüpfen – mit Label und als primäre Firma), „Firma/Datensatz ändern“ (den Datensatz aus dem Auslöser, alle mit dem Kontakt verknüpften oder die primäre Firma), „Datensätze verknüpfen“ (über eine Eigenschaft finden, z. B. Firma mit Domain = `{{contact.email}}` – E-Mail-Adressen werden zur Domain –, optional anlegen, wenn keine passt; oder den Datensatz aus dem Auslöser).

## Lead-Scoring

Menü **Lead-Scoring** (Marketing). Ein oder mehrere **Modelle** je Sub-Account; eines ist der **Haupt-Score** (Spalte, Filter und Sortierung in der Kontaktliste).

- **Eigenschaften (Fit):** Punkte, wenn ein Kontakt passt – Kontaktfelder (Quelle, E-Mail, Ort …), eigene Felder, Tags, Herkunft aus der Attribution (erste/letzte Quelle, Medium, Kampagne, Anzahl Besuche) und **Eigenschaften der verknüpften Firmen** (Branche, Größe, Phase, eigene Firmen-Eigenschaften). Vergleiche: ist, ist nicht, enthält, ist leer/nicht leer, größer/kleiner als.
- **Aktivität (Engagement):** Punkte je Ereignis – E-Mail geöffnet, Link geklickt, Formular ausgefüllt, Seitenbesuch (Attribution), Termin gebucht, Nachricht erhalten (jeder Kanal oder nur Chat, WhatsApp, SMS, E-Mail-Antwort), Telefonat geführt, Deal angelegt; je Kriterium optional **Höchstpunkte** und ein **Zeitraum** (z. B. nur Klicks der letzten 90 Tage). Auch frühere Aktivität zählt (gelesen aus den vorhandenen Daten).
- **Negative Punkte** ziehen ab (Freemail, Wettbewerber-Domain …); der Score fällt nie unter 0, optional gibt es einen **Höchstwert** (z. B. 100).
- **Zerfall:** z. B. −10 % je 30 Tage ohne Aktivität (letzte Öffnung, Klick, Einsendung, Buchung, Nachricht …).
- **Schwellen** mit Namen, z. B. MQL ab 50, SQL ab 80 – erscheinen als Label am Kontakt und in der Liste.
- **Neu berechnet** sofort bei passenden Ereignissen (neue Tags, Formulare, Klicks, Termine, Nachrichten, Firmenänderungen …) und jede Nacht (Zerfall, Zeiträume); „Neu berechnen“ geht jederzeit. Nach dem Ändern der Regeln wird sofort neu gerechnet.
- **Am Kontakt:** Score mit Schwelle, Aufschlüsselung je Kriterium und **Verlauf** (wann, warum, ▲/▼).
- **Kontaktliste:** Spalte „Score“ (sortierbar), Filter „Score: ab MQL/SQL“ – auch in Smart Lists und damit in Kampagnen. API: `GET /api/contacts?score_min=50`, `?score_label=SQL` (= SQL oder höher), `?sort=score`.
- **Workflow-Auslöser:** „Lead-Score erreicht Schwelle“ (Modell, Schwelle – nur beim Steigen über die Schwelle) und „Lead-Score geändert“ (gestiegen/gefallen, Mindest-Score); Platzhalter `{{event.score}}`, `{{event.label}}`, `{{event.previous}}`.

## Snapshots, Supabase, Berichte, Import

- **Snapshots** nehmen die **Definitionen** mit: eigene Objekte, alle Eigenschaften mit Gruppen, Gruppen/Beschreibungen der Kontaktfelder, Verknüpfungs-Labels und Lead-Scoring-Modelle – nie Firmen, Datensätze oder Scores.
- **Supabase-Spiegel:** zusätzliche Tabellen `ghl_companies` (mit `custom` als JSON), `ghl_object_records` (`object_type` = Schlüssel wie `p_fahrzeuge`, `object_label`, `display`, `properties` als JSON) und `ghl_associations` (mit Label-Namen). Das SQL steht wie gewohnt unter *Agentur → Integrationen → Supabase-Spiegel* (einmal neu ausführen).
- **Berichte:** Datenquellen „Firmen“ (Branche, Größe, Phase, Zuständig, Ort, Angelegt am, Deal-Wert gesamt/gewonnen/offen, Anzahl Kontakte/Deals, eigene Firmen-Eigenschaften), je eigenem Objekt eine Quelle „<Mehrzahl> (Objekt)“ mit seinen Eigenschaften als Gruppierungen und Kennzahlen und „Lead-Scores“ (Modell, Schwelle, Score, Ø Score, Anteil über einer Schwelle, Kontaktfelder).
- **HubSpot-Import** (*Apps → HubSpot*): Firmen landen in diesem Modul (ohne Dubletten auch beim erneuten Import – über die HubSpot-ID, sonst die Domain), ihre Kontakte werden verknüpft (erste Firma = primär).

## Rechte

Firmen, Datensätze, Verknüpfungen, Ansichten und Scores gehören zum Bereich **Kontakte & Aufgaben**; Objekte, Eigenschaften, Labels und Scoring-Modelle anlegen/ändern braucht **Einstellungen des Sub-Accounts** (die Listen sind für alle lesbar). „Nur lesen“-Agenturschlüssel können nichts ändern.

## API & MCP

Alle Endpunkte in [api.md](api.md#companies-objects--associations). MCP-Werkzeuge: `ghl_list_companies`, `ghl_upsert_company`, `ghl_list_object_types`, `ghl_search_records`, `ghl_upsert_record`, `ghl_associate`, `ghl_lead_score`.

```bash
# Firma anlegen oder per Domain aktualisieren und zwei Kontakte verknüpfen
curl -X POST https://crm.example.com/api/companies -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"Muster GmbH","domain":"muster.de","industry":"Software","custom":{"tier":"A"},"contact_ids":["…","…"]}'

# Datensatz eines eigenen Objekts anlegen (eindeutige Eigenschaft = kein Duplikat) und mit einem Kontakt verknüpfen
curl -X POST https://crm.example.com/api/objects/p_fahrzeuge/records -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"properties":{"name":"HH-AB 123","marke":"VW","kilometer":"12.000"},"associations":[{"type":"contact","id":"…","label":"Fahrer"}]}'

# Filtern: Firmen der Branche Software mit mehr als 10.000 € Deal-Wert, nach Deal-Wert absteigend
curl -G https://crm.example.com/api/companies -H "Authorization: Bearer $KEY" \
  --data-urlencode 'filters=[{"field":"industry","op":"eq","value":"Software"},{"field":"deals_value","op":"gt","value":10000}]' --data-urlencode 'sort=-deals_value'
```

## Für Entwickler: andere Module anbinden

- `app.services.associations` – `registerType({type, label, plural, icon, table, get(locationId, id) → {id, name, sub?, link?}, search?})` meldet einen eigenen Datensatz-Typ an (mit `table` werden Verknüpfungen beim Löschen automatisch entfernt), außerdem `link(loc, a, b, {labels, primary})`, `unlink`, `list(loc, ref, {type, label})`, `ids`, `primary`, `setPrimary`, `removeAll`, `onChange`. Beispiel Helpdesk: `registerType({ type: 'ticket', label: 'Ticket', plural: 'Tickets', table: 'tickets', get: … })`.
- `app.services.objectSchema` – Eigenschaften je Objekt (`defs`, `validate`, `createProperty`), Aktivität und Notizen je Datensatz.
- `app.services.companies` – `upsert(loc, input)` → `{id, created, company}` (mit `external_source`/`external_id` idempotent für Importe), `linkContact`, `get`, `update`, `list`, `findByDomain`, `syncContact`; `app.services.customObjects` – `types`, `type`, `upsert`, `update`, `get`, `list`.
- Neue Haken im Kern: `app.services.supabaseTables` (eigene Spiegel-Tabellen mit SQL), `app.services.workflowTriggerFilters` (Filter für eigene Auslöser), `app.services.contactSorts` (eigene Sortierungen der Kontaktliste).
