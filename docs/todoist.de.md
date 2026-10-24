[English](todoist.md) · **Deutsch**

# Todoist-Abgleich

HyperLevel gleicht die Aufgaben aller Sub-Accounts mit **deinem persönlichen Todoist** ab – in beide Richtungen oder nur HyperLevel → Todoist. Eingerichtet wird das einmal für die ganze Agentur unter **Agentur → Integrationen → Einrichtung → Todoist**.

## Aufbau: Abschnitte oder Projekte

| Aufbau | So sieht es in Todoist aus | Passt für |
| --- | --- | --- |
| **Ein Projekt mit Abschnitten** (Standard, empfohlen) | Ein Projekt „HyperLevel“ (Name frei wählbar, oder ein vorhandenes Projekt), darin ein **Abschnitt je Sub-Account** | Jeden Plan – auch den **kostenlosen** (max. 5 Projekte, 20 Abschnitte je Projekt, also bis zu 20 Sub-Accounts) |
| Ein Projekt je Sub-Account | Ein Projekt je Sub-Account unter einem übergeordneten Projekt „HyperLevel“ | Todoist Pro/Business (bis zu 300 Projekte) |

**Kostenloser Todoist-Plan → „Ein Projekt mit Abschnitten“ nehmen.** Mit „Ein Projekt je Sub-Account“ sind dort nach 5 Projekten (inkl. Eingang) Schluss; HyperLevel meldet das Limit dann im Status (siehe unten), statt es immer wieder zu versuchen. Ob du Pro hast, zeigt die Karte nach dem Verbinden („kostenloser Plan“).

## Einrichten

1. In Todoist: **Einstellungen → Integrationen → Entwickler** → „API-Token“ kopieren.
2. In HyperLevel: **Agentur → Integrationen → Einrichtung → Todoist** → Token einfügen → **Speichern & testen**. Der Token wird sofort gegen Todoist geprüft (falscher Token = Fehlermeldung, nichts wird gespeichert), danach verschlüsselt abgelegt (AES-256-GCM mit dem Schlüssel aus `data/secret`) und nie wieder an den Browser geschickt.
3. Einstellungen wählen:
   - **Richtung:** *Beide Richtungen* oder *Nur HyperLevel → Todoist* (dann werden Änderungen in Todoist ignoriert).
   - **Welche Aufgaben:** *Alle Aufgaben* oder *Nur mir zugewiesene* („mir“ = der Login, der den Token gespeichert hat). Das gilt für neue Aufgaben; bereits verknüpfte bleiben verknüpft.
   - **Aufbau in Todoist:** „Ein Projekt mit Abschnitten“ oder „Ein Projekt je Sub-Account“ (siehe oben).
   - Bei Abschnitten: **Todoist-Projekt** – *Automatisch* nimmt ein Projekt mit dem **Projektnamen** (Standard `HyperLevel`) oder legt genau eins an; alternativ ein vorhandenes Projekt wählen. Ein neuer Projektname benennt das automatische Projekt um.
   - Bei Abschnitten: **Aufgaben ohne Abschnitt** – *Ignorieren* (Standard) oder einem Sub-Account zuordnen (z. B. als Eingang: was du in Todoist direkt ins Projekt tippst, landet dort).
   - Bei Projekten: **Übergeordnetes Projekt** (Standard `HyperLevel`): automatisch angelegte Projekte landen darunter; leer = oberste Ebene.
   - **Label `ghp`** an Aufgaben, die von HyperLevel kommen (abschaltbar).
4. **Abschnitt bzw. Projekt je Sub-Account:** *automatisch* legt einen Abschnitt (bzw. ein Projekt) mit dem Namen des Sub-Accounts an – oder nimmt einen vorhandenen gleichen Namens; *Vorhandener Abschnitt/vorhandenes Projekt …* wählt aus deinem Todoist; *Nicht abgleichen* lässt den Sub-Account außen vor. Sub-Accounts ohne eigene Einstellung folgen „Sub-Accounts ohne eigene Einstellung“. Wird ein Sub-Account umbenannt, wird sein automatischer Abschnitt mit umbenannt.

**Erstes Verbinden:** Mit „Ein Projekt mit Abschnitten“ startet der Abgleich nach „Speichern & testen“ sofort (es entsteht höchstens ein Projekt). Mit „Ein Projekt je Sub-Account“ bleibt er aus, bis du **Abgleich aktiv** anhakst – die Karte fragt dann nach, wie viele Projekte angelegt würden. So entstehen nie überraschend viele Projekte.

„Trennen“ löscht den Token und stoppt den Abgleich; die Aufgaben bleiben in beiden Systemen. Wird später ein Token für ein **anderes** Todoist-Konto gespeichert, beginnt die Verknüpfung von vorn.

## Was abgeglichen wird

| HyperLevel | Todoist |
| --- | --- |
| Titel | `content` |
| Beschreibung | `description` – mit angehängtem Link zurück (`↗ HyperLevel: https://<domain>/app/contacts/<id>` bzw. `/app/tasks`), der beim Zurücklesen wieder entfernt wird |
| Fällig (nur Datum) | ganztägiges Datum |
| Fällig (mit Uhrzeit) | feste Uhrzeit in der Zeitzone des Sub-Accounts; „schwebende“ Todoist-Zeiten werden in deiner Todoist-Zeitzone gelesen |
| Erledigt / wieder offen | abhaken (`item_close`) / wieder öffnen (`item_uncomplete`); wiederkehrende Todoist-Aufgaben springen beim Abhaken aufs nächste Datum, das kommt so zurück |
| Gelöscht | wird in Todoist gelöscht |
| – | In Todoist **gelöscht** → hier **nicht gelöscht**, sondern als erledigt markiert und abgekoppelt (Eintrag im Protokoll). So geht nichts verloren; die Aufgabe steht unter „Erledigt“. |

Neue Aufgaben in einem zugeordneten Abschnitt (bzw. Projekt) kommen (bei „Beide Richtungen“) als Aufgabe ohne Kontakt in den passenden Sub-Account. Aufgaben im Projekt ohne Abschnitt kommen nur, wenn unter „Aufgaben ohne Abschnitt“ ein Sub-Account gewählt ist; Aufgaben in nicht zugeordneten Abschnitten, im Todoist-Eingang oder in anderen Projekten bleiben draußen, ebenso bereits erledigte. Neu nach Todoist gehen nur offene Aufgaben.

**Verschieben:** Eine verknüpfte Aufgabe, die du in Todoist in einen anderen Abschnitt oder ein anderes Projekt ziehst, bleibt hier im bisherigen Sub-Account (und wird weiter abgeglichen). Beim Wechsel des Aufbaus oder einer Zuordnung bleiben bereits verknüpfte Aufgaben, wo sie in Todoist sind; nur neue Aufgaben gehen an das neue Ziel.

## Wann abgeglichen wird

- **Alle 3 Minuten** holt HyperLevel nur die Änderungen (`sync_token` der Todoist Sync-API), **einmal am Tag** liest es alles neu (dabei werden auch Aufgaben geschlossen, die in Todoist erledigt/gelöscht wurden, als niemand hinsah).
- **Änderungen hier** (Oberfläche, API, MCP) gehen nach ~2 Sekunden raus; Aufgaben aus Workflows oder dem KI-Assistenten findet ein kurzer Scan alle 15 Sekunden.
- **Jetzt abgleichen** / **Komplett abgleichen** startet sofort einen Lauf; das MCP-Werkzeug `ghl_todoist_sync` ebenso.

Haben sich **beide Seiten** seit dem letzten Abgleich geändert, gewinnt die spätere Änderung (Todoist: `updated_at`; HyperLevel: Zeitpunkt der Änderung). Jeder Konflikt steht im Protokoll.

## Sicherheit & Grenzen

- Alle Schreibvorgänge laufen gebündelt (bis 100 Befehle je Anfrage) mit eindeutiger `uuid` – ein wiederholter Versuch legt nichts doppelt an.
- Bei `429 Too Many Requests` wartet der Abgleich (`Retry-After`, sonst 1, 2, 4, 8 s) und versucht es bis zu viermal; danach beim nächsten Lauf.
- **Sicherheitsstopp:** Fehlen hier auf einmal mehr als 25 verknüpfte Aufgaben und mehr als die Hälfte aller Verknüpfungen (z. B. nach einem Fehler beim Import), wird in Todoist nichts gelöscht, nur abgekoppelt.
- **Todoist-Limits** (kostenloser Plan: 5 Projekte, 20 Abschnitte je Projekt; auch Aufgaben-Limits): Scheitert das Anlegen an einem Limit, steht im Status eine rote Meldung „Todoist-Limit erreicht …“ (und einmal im Protokoll). Danach versucht HyperLevel **nichts Neues mehr anzulegen** – Änderungen an bestehenden Aufgaben laufen weiter – bis du „Jetzt abgleichen“ klickst, eine Einstellung änderst oder 24 Stunden vergangen sind. Abhilfe: Aufbau „Ein Projekt mit Abschnitten“, vorhandene Projekte/Abschnitte wählen, Sub-Accounts auf „Nicht abgleichen“ stellen oder Todoist Pro.
- Wird ein zugeordnetes Projekt bzw. ein Abschnitt in Todoist gelöscht oder archiviert, stellt HyperLevel den Sub-Account auf „Nicht abgleichen“, statt neu anzulegen; die Aufgaben hier bleiben unverändert (nur abgekoppelt). Verschwindet das eine Projekt des Abschnitt-Aufbaus, wird der Abgleich ganz ausgeschaltet, bis du ein Projekt wählst und wieder einschaltest.
- Eine Aufgabe, die fünfmal scheitert, wird bis zum nächsten kompletten Abgleich übersprungen (steht im Protokoll und im Status).
- Ein Sub-Account auf „Nicht abgleichen“ friert seine Verknüpfungen ein: nichts wird mehr gesendet oder gelesen, nichts gelöscht. Beim Wechsel auf ein anderes Projekt bleiben bereits verknüpfte Aufgaben in ihrem bisherigen Todoist-Projekt.
- Unteraufgaben aus Todoist kommen als normale Aufgaben; Prioritäten, Labels (außer `ghp`), Kommentare und Abschnitte werden nicht abgeglichen.

## Webhook (optional)

Ohne Webhook reicht der 3-Minuten-Abruf. Für sofortige Übernahme aus Todoist:

1. Todoist **App Console** (Einstellungen → Integrationen → Entwickler → App Console) → neue App.
2. **Webhook-URL:** `https://<deine-domain>/hooks/todoist` (steht zum Kopieren im Abschnitt „Webhook“), Ereignisse `item:added`, `item:updated`, `item:completed`, `item:uncompleted`, `item:deleted` wählen, aktivieren.
3. **Client Secret** der App in HyperLevel speichern. Jede Lieferung wird über `X-Todoist-Hmac-SHA256` (Base64-HMAC-SHA256 des Rohinhalts mit dem Client Secret) geprüft; ungültige werden abgewiesen.
4. Todoist schickt Webhooks erst, wenn dein Konto die App einmal per OAuth autorisiert hat (siehe Todoist-Doku „Webhook Activation & Personal Use“).

Der Webhook löst nur einen vorgezogenen Abgleich aus – die Daten selbst kommen immer über die Sync-API.

## Technik

- `server/services/todoist.ts`: jeder HTTP-Aufruf (Todoist API v1, `https://api.todoist.com/api/v1`: `POST /sync` für Lesen/Schreiben, `GET /user` für den Token-Test, `GET /projects` für die Projektauswahl), Fälligkeits-Umrechnung, Webhook-Prüfung. Test-Haken: `app.services.todoistFetch`, `app.services.todoistSleep`.
- `server/services/todoist-sync.ts`: der Abgleich (Projekte, Lesen, Konflikte, Schreiben).
- `server/modules/todoist.ts`: Einstellungen, Routen, Zeitplan, Webhook, MCP-Werkzeuge. Tabellen `todoist_projects` (Zuordnung je Sub-Account: Projekt-Spalten für „ein Projekt je Sub-Account“, `section_*` für Abschnitte – beide bleiben beim Wechsel erhalten), `todoist_links` (Aufgabe ↔ Todoist-ID, Projekt/Abschnitt, letzter Hash beider Seiten, Zeitstempel), `todoist_log` (Protokoll, die letzten 500 Einträge).
- Gelesen werden `projects`, `sections` und `items`; geschrieben `project_add`/`project_update`, `section_add`/`section_update`, `item_add` (mit `section_id`), `item_update`, `item_close`, `item_uncomplete`, `item_delete`.

API (nur Admins / Agentur-Schlüssel): siehe [api.md](api.md#todoist).
