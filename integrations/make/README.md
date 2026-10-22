# HyperLevel für Make (Custom App)

Eigene Make-App als JSON – nichts wird veröffentlicht. Du legst sie in deinem Make-Konto als **Custom App** an und kopierst die Abschnitte hinein (Weboberfläche oder die VS-Code-Erweiterung „Make Apps Editor“).

## Inhalt

| Datei | In Make |
| --- | --- |
| `app.json` | Name, Beschreibung, Farbe, Modul-Gruppen |
| `base.imljson` | **Base**: Basis-URL aus der Verbindung, `Authorization: Bearer …`, Fehlermeldungen |
| `connections/gohigh.json` | **Connection** „HyperLevel“: Adresse, API-Schlüssel (`pghl_…`), optional Sub-Account-ID für Agentur-Schlüssel; Test über `GET /api/hooks/me` |
| `webhooks/gohigh_event.json` | **Webhook** (dedicated): `attach` = `POST /api/hooks` mit `{{webhook.url}}` und dem gewählten Auslöser, `detach` = `DELETE /api/hooks/<id>` |
| `modules/watchEvents.json` | Instant Trigger „Neues Ereignis (sofort)“ – alle 17 Auslöser (Kontakt, Tag, Deal, Formular, Termin, Rechnung, Kauf, Aufgabe, Nachricht, Anruf, Bewertung, jedes Ereignis) mit Filtern |
| `modules/*.json` | Aktionen: Kontakt anlegen/aktualisieren, Tag hinzufügen/entfernen, Opportunity anlegen/verschieben, Aufgabe, Notiz, Nachricht senden, Rechnungsentwurf; Suchen: Kontakte, Opportunities |
| `rpcs/*.json` | Auswahllisten: Pipelines, Stufen, Tags, Formulare, Kalender, Produkte |

## Einrichten

1. Make → **Custom Apps** → „Create a new app“: Name `gohigh`, Label „HyperLevel“, Sprache Deutsch.
2. **Base**: Inhalt von `base.imljson` einfügen.
3. **Connections** → „Create connection“ (Typ *Basic*): `parameters` und `communication` aus `connections/gohigh.json`.
4. **Webhooks** → „Create webhook“ (Typ *Dedicated*, Verbindung „HyperLevel“): `parameters`, `attach`, `detach`, `communication` aus `webhooks/gohigh_event.json`.
5. **RPCs**: je Datei in `rpcs/` eine RPC mit gleichem Namen anlegen.
6. **Modules**: je Datei in `modules/` ein Modul mit gleichem Namen und Typ anlegen (`type`/`typeId`: 10 = Instant Trigger, 4 = Action, 9 = Search); `communication`, `expect` (Mappable parameters), `interface` und `samples` übernehmen.
7. Im Szenario „HyperLevel → Neues Ereignis (sofort)“ wählen, Verbindung anlegen, Auslöser wählen – Make registriert den Webhook selbst. In HyperLevel steht das Abo dann unter **Einstellungen → API & Webhooks** (Quelle „Make“).

Hinweise: Zustellungen tragen `x-pghl-signature = sha256(secret + body)`. Antwortet Make dreimal mit 410 (Webhook gelöscht), schaltet HyperLevel das Abo ab. Alle Endpunkte: `/api/docs.html` bzw. `/api/openapi.json` deiner Installation.
