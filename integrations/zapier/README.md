# HyperLevel für Zapier

Private Zapier-App (Zapier Platform CLI) für eine selbst gehostete HyperLevel-Installation. Nichts davon wird automatisch veröffentlicht – du entscheidest, ob und wann du `zapier push` ausführst.

## Was drin ist

| Art | Inhalt |
| --- | --- |
| Verbindung | Adresse der Installation + API-Schlüssel (`pghl_…`, Einstellungen → API & Webhooks); Agentur-Schlüssel (`pghla_…`) mit Sub-Account-ID. Test: `GET /api/hooks/me` |
| Sofort-Auslöser (REST-Hooks) | Neuer Kontakt, Kontakt geändert, Tag hinzugefügt, Neue Opportunity, Pipeline-Stufe geändert, Deal gewonnen, Deal verloren, Formular eingereicht, Termin gebucht, Termin abgesagt, Rechnung bezahlt, Produkt gekauft, Aufgabe erledigt, Nachricht empfangen, Anruf verpasst, Bewertung erhalten, Jedes Ereignis – mit optionalen Filtern (Tag, Pipeline, Stufe, Formular, Kalender, Produkt, Kanal) |
| Aktionen | Kontakt anlegen/aktualisieren, Kontakt aktualisieren, Tag hinzufügen/entfernen, Opportunity anlegen, Opportunity verschieben, Aufgabe anlegen, Notiz hinzufügen, Nachricht senden, Rechnungsentwurf anlegen |
| Suchen | Kontakt finden (auch „finden oder anlegen“), Opportunity finden |

Zapier abonniert beim Einschalten eines Zaps `POST /api/hooks` mit seiner Ziel-URL und bestellt beim Ausschalten per `DELETE /api/hooks/<id>` ab. Die Abos und jede Zustellung siehst du in HyperLevel unter **Einstellungen → API & Webhooks** (Zustell-Protokoll). Beispieldaten für „Test trigger“ kommen aus `GET /api/hooks/triggers/<auslöser>/sample` (die letzten echten Ereignisse, sonst ein Muster).

## Hochladen (einmalig, als Agentur)

```bash
cd integrations/zapier
npm install                 # nur hier, nicht im Hauptprojekt
npx zapier login            # mit deinem Zapier-Konto
npx zapier register "HyperLevel"   # legt die private App an (.zapierapprc)
npm test                    # läuft auch ohne Installation (node --test)
npx zapier push             # lädt Version 1.0.0 hoch – bleibt privat
```

Danach im Zapier-Editor die App „HyperLevel“ wählen, Adresse (z. B. `https://crm.example.com`) und API-Schlüssel eintragen.

- Mitglieder/Kunden einladen: `npx zapier users:add kunde@example.com 1.0.0` oder den Einladungslink aus <https://developer.zapier.com>.
- Neue Version: `version` in `package.json` erhöhen, `npx zapier push`, dann `npx zapier promote <version>` und ggf. `npx zapier migrate <alt> <neu>`.
- `zapier-platform-core`: Steht die Version in `package.json` nicht mehr zur Verfügung, die von `npx zapier init` vorgeschlagene eintragen – `index.js` liest die installierte Version selbst.

## Aufbau

```
index.js            App-Definition (Auslöser, Aktionen, Suchen, Middleware)
authentication.js   Verbindung: Adresse, API-Schlüssel, optional Sub-Account-ID
lib/definitions.js  Auslöser/Aktionen wie auf dem Server (wird im Repo-Test gegen den Server geprüft)
lib/hooks.js        REST-Hook-Auslöser + versteckte Auswahllisten (Pipelines, Stufen, Tags, Formulare, Kalender, Produkte)
lib/creates.js      Aktionen → POST /api/hooks/actions/<aktion>
lib/searches.js     Suchen → GET /api/hooks/search/…
test/app.test.js    node --test, ohne Abhängigkeiten
```

Signatur der Zustellungen: `x-pghl-signature = sha256(secret + body)` – Zapier braucht sie nicht, eigene Empfänger können sie prüfen (das Secret steht in der Antwort von `POST /api/hooks`).
