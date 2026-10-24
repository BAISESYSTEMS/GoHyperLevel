[English](office.md) · **Deutsch**

# Office – Dokumente, Tabellen, Präsentationen und PDF

Der Bereich **Office** (Menü *Office*) hält die Office-Dateien eines Sub-Accounts: Word-Dokumente (.docx),
Excel-Tabellen (.xlsx), PowerPoint-Präsentationen (.pptx) und PDFs – jede Datei mit lückenloser Versionsgeschichte,
Kommentaren, einer Bearbeitungssperre und optional verknüpft mit einem Kontakt, Deal oder Projekt. Bearbeitet wird
im Browser (mit den optionalen Editoren, siehe [Einrichtung](#einrichtung-server)) und vom **HyperLevel Agent** bzw. jedem
MCP-Client über fünf Werkzeuge.

Ohne Editoren und Engines funktioniert der Bereich trotzdem: Dateien anlegen, hochladen, herunterladen, als neue
Version hochladen, Versionen wiederherstellen, kommentieren – und der Agent kann den reinen Text von Dokumenten,
Tabellen und Präsentationen lesen und neue Dateien mit Starttext oder Startzeilen anlegen.

## Bedienen

- **Liste:** Filter *Alle · Dokumente · Tabellen · Präsentationen · PDF*, Suche im Dateinamen; je Datei die Verknüpfung,
  Version, wer zuletzt geändert hat, eine Sperre („Anna bearbeitet“), offene Kommentare und wer die Datei gerade
  geöffnet hat (Avatare). Oben *Dokument*, *Tabelle*, *Präsentation* (leer anlegen) und *Hochladen* (mehrere Dateien).
- **Datei öffnen:** *Bearbeiten* öffnet den Editor im Browser und sperrt die Datei für andere, bis du auf *Fertig* klickst
  (oder das Fenster schließt). *Schreibgeschützt öffnen* zeigt die Datei im Editor, ohne zu sperren und ohne zu speichern.
- **Speichern:** *Speichern* in HyperLevel drückt die Speichern-Taste im Editor; Strg+S (bzw. ⌘S) im Editor tut dasselbe.
  Jedes Speichern ist eine **neue Version** – nichts wird überschrieben.
- **Versionen:** jede Version mit Nummer, Zeit, Autor („Anna Muster“, „KI-Agent (im Auftrag von Anna Muster)“ oder der
  Name des API-Schlüssels), Größe und Notiz; *Herunterladen* und *Wiederherstellen* (die alte Fassung wird als neue
  Version gespeichert).
- **Kommentare** zur Datei oder zu einer bestimmten Version, Antworten, *Erledigt*; mit `@Vorname Nachname` erwähnte
  Personen und der Ersteller der Datei bekommen eine Push-/Glocken-Nachricht (abschaltbar unter *Mein Konto*, Art
  „Kommentare und Erwähnungen in Office-Dateien“).
- **Mit KI bearbeiten:** der Wunsch („Ersetze den Preis durch 4.900 € und mache die Überschrift fett“) geht mit Datei-ID und
  Version an den HyperLevel Agent; er liest die Datei, ändert sie mit der Office-Engine und speichert eine neue Version.
  Bestätigungen laufen wie immer im Agent-Fenster.
- **Details:** Kontakt, Deal und Projekt der Datei, Verknüpfen per Suche und Lösen. *Als PDF* (mit Engine) legt ein PDF
  der aktuellen Version als neue Datei mit denselben Verknüpfungen an.

## Zusammenarbeit

- **Bearbeitungssperre („ausgecheckt“):** wer *Bearbeiten* klickt, hält die Sperre; der offene Editor erneuert sie jede
  Minute, ohne Erneuerung endet sie nach 5 Minuten von selbst. Andere sehen „Anna bearbeitet gerade – schreibgeschützt“
  und können schreibgeschützt öffnen; Speichern, neue Versionen, Löschen und Agent-Änderungen anderer werden mit 423
  abgelehnt („Anna Muster bearbeitet die Datei gerade – sie ist bis 14:35 Uhr gesperrt …“). Admins können eine Sperre
  übernehmen. API-Schlüssel und MCP-Verbindungen können keine Sperre halten.
- **Wer ist da:** die Live-Zusammenarbeit der App ([collaboration.de.md](collaboration.de.md)) zeigt, wer welche Datei offen hat
  (Seite `office/<id>`) – in der Liste, im Kopf der Datei und in der Seitenleiste.
- **Konflikte:** wer auf einer älteren Version speichert, bekommt „Seit dem Öffnen gibt es eine neuere Version … Trotzdem
  als neue Version speichern?“ (409); auch dann bleibt die andere Fassung in der Geschichte.
- **Keine Echtzeit-Co-Bearbeitung:** zwei Personen tippen nicht gleichzeitig im selben Dokument – das verhindert die Sperre.

## Einrichtung (Server)

Die Editoren (statische WebAssembly-Seiten) und Engines (Kommandozeilenprogramme) sind **eigenständige Open-Source-Programme**
(MIT OR Apache-2.0, siehe [Herkunft, Lizenzen und Marken](#herkunft-lizenzen-und-marken)); sie gehören nicht zum Repository
und nicht zum HyperLevel-Image. Drei Wege:

1. **Docker (empfohlen):** `docker compose -f docker-compose.yml -f deploy/office/docker-compose.office.yml up -d --build`
   baut [deploy/office/Dockerfile](../deploy/office/Dockerfile) auf dem HyperLevel-Image auf, lädt die festgelegten Versionen,
   prüft ihre SHA-256-Summen und setzt die Pfade. Das Image läuft auf Debian statt Alpine (die Engines brauchen glibc ≥ 2.35).
2. **Ohne Docker:** `deploy/office/install.sh --web-dir /opt/office/web --bin-dir /opt/office/bin` (braucht curl, unzip, tar,
   sha256sum; Linux x86_64 oder aarch64 mit glibc ≥ 2.35 für die Engines), danach die Variablen unten setzen. HyperLevel liest
   sie bei jedem Aufruf – kein Neustart nötig.
3. **Teilweise:** nur die Engines (`--only bin`, für Agent-Bearbeitung und PDF-Export) oder nur einzelne Arten (`--kinds docx,pdf`).

| Variable | Bedeutung |
| --- | --- |
| `PGHL_OFFICE_DIR` | Ordner mit den Editoren: je Art ein Unterordner `docx/`, `xlsx/`, `pptx/`, `pdf/` mit dem Inhalt des jeweiligen Release-Zips (`index.html` + `.js` + `.wasm`). Fehlt er, zeigt der Bereich „Editor nicht installiert“ mit diesem Hinweis. |
| `PGHL_OFFICE_BIN_DIR` | Ordner mit den Engines (`wordcraft-cli`, `gridcraft-cli`, `deckcraft-cli`, `pdfcraft-cli`). Fehlt einer, antworten Bearbeiten und PDF-Export dieser Art mit 503 „Office-Engine nicht installiert“; Lesen fällt auf den reinen Text zurück. |
| `PGHL_OFFICE_SANDBOX` | `strict` (Standard): der Editor läuft in einem Sandbox-iframe **ohne** HyperLevels Origin – sein Code erreicht weder Cookies noch API. `same-origin` nur, falls ein Editor ohne eigenen Speicher nicht startet (siehe [Sicherheit](#sicherheit)). |
| `PGHL_OFFICE_MAX_MB` | Größte Datei (jede Version) in MB, Standard 25. |
| `PGHL_OFFICE_QUOTA_MB` | Speicher aller Versionen aller Office-Dateien je Sub-Account in MB, Standard 2048 (`0` = ohne Grenze); darüber wird mit 413 abgelehnt. |

Festgelegte Versionen und Prüfsummen: [deploy/office/versions.env](../deploy/office/versions.env) (Stand: Dokumente 0.3.0,
Tabellen 0.3.0, Präsentationen 0.3.0, PDF 0.4.0, aus den `SHA256SUMS.txt` der Releases). Die Release-Dateien:

| Art | Editor (Release-Asset) | Engine (Release-Asset, darin `bin/<name>-cli`) |
| --- | --- | --- |
| Dokumente | `wordcraft-web-0.3.0.zip` | `wordcraft-0.3.0-linux-x86_64.tar.gz` / `…-linux-aarch64.tar.gz` |
| Tabellen | `gridcraft-web-0.3.0.zip` | `gridcraft-0.3.0-linux-x86_64.tar.gz` / `…-linux-aarch64.tar.gz` |
| Präsentationen | `deckcraft-web-0.3.0.zip` | `deckcraft-0.3.0-linux-x86_64.tar.gz` / `…-linux-aarch64.tar.gz` |
| PDF | `pdfcraft-web-0.4.0.zip` | `pdfcraft-0.4.0-linux-x86_64.tar.gz` / `…-linux-aarch64.tar.gz` |

Die Editoren sind 13–40 MB groß (WebAssembly); `install.sh` legt `.gz`/`.br` daneben, die HyperLevel ausliefert, wenn der
Browser sie annimmt (etwa ein Drittel der Größe). Die Dateinamen tragen einen Hash und werden ein Jahr gecacht.

## Wie die Editoren laden und speichern

Die Web-Builds kennen nur Dateiauswahl, Ziehen & Ablegen und Downloads – keine Schnittstelle, um ihnen eine Datei zu geben
oder eine zurückzubekommen. HyperLevel ändert am Upstream-Code nichts und legt stattdessen ein kleines Brücken-Skript vor den
Editor (`/office/bridge.js`, mit Nonce in die Editor-Seite eingefügt):

- **Laden:** sobald der Editor läuft (Ereignis `TrunkApplicationStarted` bzw. sein „Loading …“-Hinweis verschwindet), schickt
  HyperLevel die Bytes der Version per `postMessage`, und die Brücke legt sie als synthetisches *Ziehen & Ablegen* auf die
  Zeichenfläche – eine echte `File` in einem `DataTransfer`, genau das, was der Editor bei einem abgelegten File bekommt.
  Der **PDF-Editor** hat einen eigenen Weg: er lädt `?file=<adresse>` selbst; HyperLevel gibt ihm dafür einen signierten,
  10 Minuten gültigen Link (`/office/blob/<token>/<name>.pdf`).
- **Speichern:** die Brücke merkt sich jedes Blob, aus dem die Seite eine Objekt-URL macht, und fängt den Klick auf den
  versteckten Download-Link ab, den der Editor beim Speichern erzeugt. Eine Datei der eigenen Art geht an HyperLevel (neue
  Version) statt in den Download-Ordner; alles andere (z. B. ein PDF-Export aus dem Dokument-Editor) wird normal
  heruntergeladen, und HyperLevel bietet an, es zusätzlich in Office abzulegen.
- **Speichern aus HyperLevel:** der Knopf drückt im Editor Strg/⌘+S (Tabellen: Strg/⌘+Umschalt+S – der Tabellen-Editor speichert
  eine abgelegte Datei nur über *Speichern unter*). Der Präsentations-Editor speichert in seinem eigenen Format
  (`.deckcraft`); HyperLevel wandelt es mit der Engine in `.pptx` um (`POST /api/office/files/:id/versions/convert`). Ohne Engine:
  im Editor *File → Export → PowerPoint Presentation (.pptx)* (Menü des Editors, englisch) wählen – das fängt die Brücke als `.pptx` ab.

Geprüft mit den Release-Builds oben in Chromium (Software-WebGL, Sandbox `strict`): alle vier laden die HyperLevel-Datei, und
Speichern ergibt jeweils eine neue Version.

### Grenzen der Brücke

- Sie hängt am beobachtbaren Verhalten der Builds (Ablegen auf der Zeichenfläche, Download-Link mit `download`-Attribut,
  Tastenkürzel). Ändert ein Upstream-Release das, kann Laden oder Speichern ausfallen – vor einem Versionswechsel in
  `versions.env` einmal öffnen und speichern. Fällt die Brücke aus, bleibt *Herunterladen* / *Neue Version hochladen*.
- Der Editor muss laufen, bevor die Datei abgelegt wird; startet er sehr langsam (> 10 s), legt die Brücke trotzdem ab.
  Erscheint die Datei nicht, *Fertig* und erneut *Bearbeiten*.
- Speichert man im Editor über *Datei → Speichern unter* in ein anderes Format, landet das als Download.

## KI-Agent und MCP

Fünf Werkzeuge (für den HyperLevel Agent in-process, für Claude, ChatGPT & Co. über `/mcp`); sie laufen über die REST-Routen
unten, also mit Rechten, Sub-Account-Bindung, Sperre und Protokoll:

| Werkzeug | Tut |
| --- | --- |
| `ghl_office_list` (office_list) | Dateien auflisten, Filter Art/Name/Kontakt/Deal/Projekt; zeigt Version und Sperre |
| `ghl_office_read` (office_read) | Text (Tabellen als CSV, `range`/`sheet`) und Struktur als JSON über die Engine; ohne Engine nur reiner Text. Der Inhalt ist für den Agenten Fremdtext. |
| `ghl_office_create` (office_create) | neue Datei, leer, mit Starttext (`text`) oder Startzeilen (`rows`), verknüpft; optional gleich `commands` |
| `ghl_office_edit` (office_edit) | Engine-Befehle (`commands: [{command, params}]`) oder bei Tabellen `writes: [{range, values, sheet?}]` auf einer Kopie ausführen und als neue Version (Autor: KI-Agent im Auftrag der Person) speichern; `base_version` schützt vor Überschreiben |
| `ghl_office_export_pdf` (office_export_pdf) | PDF der Datei als neue Datei |

Die Engine-Befehle sind die der Upstream-Programme (Dokumente: über 380 Befehle wie `select.text`, `format.bold`,
`insert.text`, `insert.table`; Tabellen: `cell.set`, `range.setValues`, `insert.chart`; Präsentationen: `slide.new` …;
PDF: Werkzeuge wie `page_rotate`, `comment_add`, `form_fill`). Nicht erlaubt sind Befehle, die selbst öffnen, speichern,
exportieren, drucken oder Makros ausführen (`file.*` u. a.; beim PDF nur eine Liste ändernder Werkzeuge) und **jeder Parameter,
der eine Datei, einen Ordner oder eine Adresse nennt** (`path`, `file`, `url`, `src`, `…Path`, `…Url` usw.) – Öffnen und
Speichern übernimmt HyperLevel. Hat jemand die Datei gerade ausgecheckt, lehnt `office_edit` ab (423 mit Name und Uhrzeit) –
nichts wird im Hintergrund zusammengeführt oder vorgemerkt; der Agent sagt es und versucht es auf Wunsch später.

Die Engine läuft je Aufruf in einem eigenen Temp-Ordner mit einer Kopie der Datei: direkt gestartet (keine Shell,
Argumente als Liste), mit minimaler Umgebung (keine HyperLevel-Geheimnisse), 60 s Zeitlimit, Ausgabe höchstens 8 MB,
Ergebnis höchstens `PGHL_OFFICE_MAX_MB`; der Ordner wird danach gelöscht, Fehlermeldungen kommen ohne Temp-Pfade.

## Sicherheit

- **Editor-Seite** `/office/app/<art>/`: nur angemeldet, eigene Content-Security-Policy – `default-src 'none'`, Skripte nur
  vom eigenen Server mit Nonce, `'wasm-unsafe-eval'` für WebAssembly, `connect-src 'self' blob:`, keine Frames,
  `frame-ancestors 'self'`, keine Anfragen an Dritte. Die Build-Dateien selbst sind öffentliche Open-Source-Dateien
  (`/office/app/<art>/<datei>`, nur Namen aus einem flachen Ordner, kein `index.html`, kein Pfad nach oben).
- **Sandbox `strict`** (Standard): das iframe hat `sandbox="allow-scripts allow-downloads"` ohne `allow-same-origin` – der
  Editor-Code bekommt einen undurchsichtigen Origin und kommt weder an HyperLevels Cookies noch an die API oder die
  übergeordnete Seite. Die Brücke tauscht Nachrichten nur mit `window.parent` und nur mit einer zufälligen Kanal-ID aus
  der Adresse; HyperLevel nimmt nur Nachrichten genau dieses iframes an. Der Preis: die Editoren können ihre eigenen
  Einstellungen nicht im Browser speichern. `same-origin` fügt `allow-same-origin` hinzu – dann läuft der Editor-Code mit
  HyperLevels Origin und damit mit den Rechten der angemeldeten Person; nur mit geprüften Releases (Prüfsummen) verwenden.
- **Uploads** wie überall: Inhalt muss zum Typ passen (Office = ZIP, PDF = `%PDF-`), Speichername aus Zufalls-ID und
  geprüftem Typ, Downloads mit `Content-Security-Policy: sandbox`.
- **Rechte:** Bereich `office` (Kunden-Logins brauchen ihn); innerhalb des Sub-Accounts sehen alle mit dem Bereich alle
  Office-Dateien. Jede schreibende Anfrage steht im Protokoll; Downloads gelten als Export.
- **DSGVO:** Dateien, die mit einem Kontakt verknüpft sind, gehören zur Auskunft (Art. 15) und gehen beim Löschen des
  Kontakts mit – alle Versionen auch auf der Platte, Kommentare und Sperren ebenso.
- **Sub-Account löschen und Datenexport:** wird ein Sub-Account gelöscht (bzw. ein Cloud-Kunde), gehen alle seine
  Office-Dateien mit – Zeilen, Kommentare, Sperren und jede Version unter `<data>/office-files/`. Der Datenexport eines
  Cloud-Kunden enthält die Tabellen und alle Versionen (`dateien/office-files/`).

## Grenzen

- **Alpha-Software:** die Upstream-Programme sind jung (Versionen 0.3/0.4); komplexe Dateien können anders aussehen als in
  Microsoft Office. Jede Version bleibt erhalten, ein Fehler kostet also höchstens die letzte Änderung.
- Keine Echtzeit-Co-Bearbeitung (siehe [Zusammenarbeit](#zusammenarbeit)), keine Freigabe einzelner Dateien an bestimmte
  Personen, keine öffentlichen Links.
- Ältere Formate (.doc, .xls, .ppt) werden nicht angenommen; .odt/.ods/.odp ebenfalls nicht (die Editoren könnten sie öffnen,
  gespeichert wird aber im Office-Open-XML-Format).
- Die Engines sind glibc-Programme für Linux x86_64/aarch64 – nicht für Alpine (musl) oder macOS-Server.

### Bekannte Grenzen

- **Tabellen-Editor 0.3.0:** der Browser-Build bricht beim Bearbeiten einer Zelle ab („time not implemented on this
  platform“ – die Engine misst jede Änderung mit `std::time::Instant`, das es in WebAssembly nicht gibt). Öffnen, Ansehen
  und Speichern gehen, jede Änderung im Editor (Zelle, Format) beendet ihn. Abhilfe bis zu einem Upstream-Release mit Fix:
  [deploy/office/build-from-source.sh](../deploy/office/build-from-source.sh) `--kind xlsx` baut den Editor aus dem Quelltext
  mit [dem Patch](../deploy/office/patches/README.md) (Rust + trunk nötig), oder Zellen über den Agenten bzw. die Engine
  ändern lassen (die Kommandozeile ist nicht betroffen).
- **Präsentationen ohne Engine:** Strg+S im Editor speichert `.deckcraft`; ohne Engine bitte *File → Export →
  PowerPoint Presentation (.pptx)* (Menü des Editors).

## API

Alle Routen mit Anmeldung oder API-Schlüssel und Sub-Account (`x-location-id`), Bereich `office`:

- `GET /api/office/status` – installierte Editoren und Engines, Sandbox-Modus, Grenzen, belegter Speicher
- `GET/POST /api/office/files` – Liste (`?kind=&q=&contact_id=&deal_id=&project_id=&limit=`); anlegen: JSON
  `{kind, name, text?, rows?, contact_id?, deal_id?, project_id?}` (leer/mit Startinhalt) oder `{name, data}` (Base64) bzw.
  roh mit `content-type: application/octet-stream` und `?name=&kind=`
- `GET/PATCH/DELETE /api/office/files/:id` – Details mit Versionen (PDF: `editor_file_url`), umbenennen/verknüpfen, löschen
- `GET /api/office/files/:id/download` und `GET /api/office/files/:id/raw` – Inhalt (`?version=`), als Anhang bzw. für den Editor
- `GET/POST /api/office/files/:id/versions` – Versionen; neue Version roh (`?message=&base_version=&force=1`) oder JSON
  `{data, message, base_version, force}`
- `POST /api/office/files/:id/versions/convert` – Speichern im Editor-Format (`?from=deckcraft`), wird zu .pptx
- `POST /api/office/files/:id/versions/:version/restore` – Version wiederherstellen (als neue Version)
- `GET/POST/DELETE /api/office/files/:id/lock` – Sperre lesen, holen/erneuern (`{take_over: true}` für Admins), freigeben
- `GET/POST /api/office/files/:id/comments`, `PATCH/DELETE /api/office/files/:id/comments/:cid` – Kommentare
  (`{body, version?, parent_id?}`, `{resolved}`), `GET /api/office/people` – Personen für @Erwähnungen
- `GET /api/office/files/:id/read` – Text/Struktur (`?mode=both|text|structure&version=&range=&sheet=`)
- `POST /api/office/files/:id/edit` – `{commands?, writes?, message?, base_version?}`
- `POST /api/office/files/:id/export-pdf` – `{name?}`, legt ein neues PDF an

Ohne Sub-Account-Bezug: `/office/app/<art>/` (Editor-Seite), `/office/app/<art>/<datei>` (Build-Dateien),
`/office/bridge.js`, `/office/blob/<token>/<name>` (signierter PDF-Link).

## Herkunft, Lizenzen und Marken

Die Editoren und Engines stammen aus vier Open-Source-Projekten eines Upstream-Teams (je MIT OR Apache-2.0); welche, in
welcher Version und mit welchem Lizenztext steht in [deploy/office/THIRD-PARTY.md](../deploy/office/THIRD-PARTY.md). Deren
Namen und Logos sind Marken ihres Teams und nicht von den Lizenzen gedeckt – HyperLevel nennt die Bereiche deshalb neutral
*Dokumente*, *Tabellen*, *Präsentationen* und *PDF* und verwendet keine Upstream-Logos. Der unveränderte Editor im Rahmen
kann seinen eigenen Namen zeigen.

## Für Entwickler

`server/modules/office.ts` (Tabellen, Dateien, Versionen, Inhalt, Editor-Routen, `contactFiles`, Push-Art `office`),
`office-collab.ts` (Sperre, Kommentare, Personen), `office-tools.ts` (Lesen/Bearbeiten/PDF/Umwandeln über die Engine, die
fünf MCP-Werkzeuge); Logik in `server/services/office-model.ts` (rein: Arten, Namen, Befehlsprüfung, Sperre),
`office-store.ts` (Bytes auf der Platte unter `<data>/office-files/`, Grenzen, Versionen – ein Trigger verbietet jede
Änderung an `office_versions`), `office-engine.ts` (Adapter zu den Kommandozeilenprogrammen), `office-blank.ts` (leere
Dateien, Text ohne Engine), `office-bridge.ts` + `office-bridge-js.ts` (Editor-Seite, CSP, Brücke, signierte Links).
Oberfläche: `web/src/pages/Office.tsx`, `OfficeFile.tsx`, `OfficeEditor.tsx`, `OfficeParts.tsx` (eigener Chunk,
i18n-Bereich `office`). Tests: `tests/office.test.ts`, `tests/office-engine.test.ts` mit Engine-Attrappen aus
`tests/office-fakes.ts` (keine echten Programme in der CI).
