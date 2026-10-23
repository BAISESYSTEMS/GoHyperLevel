# Android-App „HyperLevel“

Native App für Android 8 (API 26) und neuer. Sie zeigt die komplette Web-App und bringt alles Wichtige auf den
Home-Bildschirm: 13 Widgets, Schnellaktionen als kleine Dialoge, Mitteilungen ohne Google-Dienste und Updates
direkt vom eigenen Server. Entwickler-Infos: [android/README.md](../android/README.md).

## Installieren

1. Auf dem Handy `https://crm.example.com/android` öffnen (Download-Seite mit QR-Code) und die APK laden.
2. Android fragt einmalig nach „Apps aus dieser Quelle installieren“ – für den Browser erlauben.
3. HyperLevel öffnen und wie gewohnt anmelden. Die App verbindet sich danach von selbst (Gerät erscheint unter
   **Einstellungen → Mein Konto → Geräte (App)**) und fragt nach der Erlaubnis für Mitteilungen.

Neue Versionen lädt der Admin hoch (`PUT /api/mobile/app`, siehe API-Doku). Die App prüft täglich und beim Start,
zeigt „Update verfügbar“, lädt die APK, prüft die SHA-256-Prüfsumme und startet die Installation. Beim ersten Mal
erlaubt man HyperLevel „Apps aus dieser Quelle installieren“.

## Die App

- **Web-App im Vollbild** (`/app`): Login bleibt gespeichert, Datei-Upload, Downloads (auch Exporte), Mikrofon für
  das Browser-Telefon und die Mikrofon-Taste des KI-Agenten (Einstellungen → Stimme, [docs/voice.md](voice.md): die Berechtigung fragt die App beim ersten Mal, Wiedergabe ohne Extra-Tipp), externe Links im Browser-Tab, Zurück-Taste blättert zurück.
- **Links** auf `https://crm.example.com/app/…` (Mails, Chat) öffnen direkt in der App (App Links).
- **Schnellmenü** (runder Knopf unten links): Aufgabe, Kontakt, Notiz, Sprach-Notiz, Anruf, Neu laden, Link teilen,
  Fehler melden, App-Einstellungen. Lange auf das App-Symbol drücken: Neue Aufgabe, Sprach-Notiz, Neuer Kontakt,
  Posteingang, Fehler melden.
- **App-Einstellungen**: Konto und Geräte (andere Geräte abmelden), Mitteilungen je Art, Widget-Aktualisierung
  (15 Min. bis 2 Std.), Standard-Projekt für neue Einträge, Material-You-Farben, Hilfe & Feedback, **Diagnose**, Version,
  Update-Suche, Abmelden. Siebenmal auf „Version“ tippen schaltet Entwickler-Optionen frei (Server-Adresse, Demo-Daten).

## Fehler melden & Wunschliste

Seit Version 1.0.1. Gleiche Tickets wie in der Web-App (siehe [Fehler & Wünsche](bug-reports.md)).

- **Fehler melden**: im Schnellmenü, unter **App-Einstellungen → Hilfe & Feedback**, lange auf das App-Symbol drücken
  oder – wenn eingeschaltet – das Handy schütteln („Schütteln zum Melden“, Standard aus). Die App macht vorher einen
  Screenshot des aktuellen Bildschirms (auch der Web-Ansicht); das Formular zeigt ihn als Vorschau (✕ entfernt ihn,
  „Bild auswählen“ nimmt stattdessen ein Bild aus der Galerie).
- **Formular**: Fehler, Verbesserungswunsch oder Frage; was ist passiert, was hast du erwartet, Schritte, wie schlimm.
  Mitgeschickt werden – sichtbar und einzeln entfernbar – Gerät und Android-Version, App-Version, die aktuelle Seite
  und die letzten 20 fehlgeschlagenen Anfragen der App (Methode, Pfad, Status, Fehlertext – nie Inhalte oder Schlüssel).
  Nach dem Senden zeigt die App die Ticketnummer.
- **Meldungen**: die eigenen Meldungen mit Status und ungelesenen Antworten; Tipp öffnet die Meldung in der Web-App
  (antworten, Infos ergänzen, wieder öffnen).
- **Wunschliste**: alle Wünsche nach Stimmen, neu oder Status; Daumen stimmt ab (nochmal tippen nimmt die Stimme
  zurück), „+ Wunsch“ reicht einen neuen Wunsch ein. Namen anderer Nutzer sind nicht zu sehen.
- **Abstürze**: stürzt die App ab, schickt sie beim nächsten Start Fehlermeldung und Stacktrace an
  `/api/mobile/client-errors`. Der Server behält sie nur, wenn „Fehler automatisch melden“ für den Nutzer an ist.

## Wenn die Seite leer bleibt (Fehlersuche)

Seit Version 1.0.3 nutzt die App den ganzen Bildschirm: Die Web-Ansicht reicht bis unter die Kamera-Aussparung und die Navigationsleiste, die Seite hält ihre Inhalte über `--sal`/`--sar`/`--sab` davon frei. Seit Version 1.0.2 bleibt der Bildschirm nie still leer. Die App prüft selbst, ob die Web-Oberfläche gestartet ist, und
sagt es, wenn nicht.

**„Die Seite lädt nicht“** (nativer Bildschirm über der Web-Ansicht) erscheint, wenn
- die Seite geladen wurde, aber nach etwa 6 Sekunden nichts anzeigt (die Web-App ist nicht gestartet),
- die Web-App selbst „Die App konnte nicht starten“ meldet,
- eine Seite auch nach 30 Sekunden nicht fertig geladen ist,
- der Server mit einem Fehler antwortet (z. B. 502 beim Neustart des Servers); bei einem Zertifikatsfehler (Datum/Uhrzeit
  des Handys falsch, fremdes WLAN) erscheint stattdessen „Keine Verbindung“ mit dem Grund,
- der Web-Prozess der Anzeige ein zweites Mal innerhalb einer Minute ausfällt (beim ersten Mal lädt die App die Seite
  mit einer neuen Web-Ansicht einfach neu; der Grund steht im Bildschirm).

Der Bildschirm nennt den Grund, die **letzten Fehler** (Konsolenfehler der Seite, fehlgeschlagene Anfragen, Prüfungen)
und die **WebView-Version**. Kommt die Seite doch noch, verschwindet er von selbst. Vier Knöpfe:

| Knopf | Was passiert |
| --- | --- |
| Neu laden | lädt die Seite neu – oder die Startseite, wenn es keine Seite zum Neuladen gibt |
| Cache & Offline-Daten löschen | leert Cache, Web-Speicher und Service Worker der Web-Ansicht (die Anmeldung bleibt) und lädt neu |
| Im Browser öffnen | öffnet die Seite im Browser-Tab – läuft sie dort, liegt es an der WebView des Handys |
| Diagnose senden | schickt Gerät, App- und WebView-Version, Status und letzte Fehler als Fehlermeldung an das Team („Fehler & Wünsche“, Schwere hoch); ist die App nicht verbunden, öffnet sich stattdessen „Teilen“ |

**Veraltete WebView.** Die Web-Oberfläche ist für Chrome/WebView **92 oder neuer** gebaut (2021). Ist die
installierte Version älter, zeigt der Bildschirm einen Hinweis mit Knopf zur Play-Store-Seite von
„Android System WebView“ (oder Chrome, je nachdem, welches die Web-Ansicht liefert). Auf Handys ohne Play Store
(z. B. GrapheneOS, LineageOS) kommt die WebView mit den System-Updates bzw. aus dem eigenen App-Store.

**Einstellungen → Diagnose** zeigt dasselbe jederzeit: WebView (Paket und Version, rot wenn zu alt), Server,
Status des letzten Starts („Geladen · vor 3 Min.“ oder der Grund des Fehlers) und die letzten Fehler. Der Status
bleibt auch nach einem Neustart der App sichtbar. „Diagnose senden“ wie oben. **App zurücksetzen (Web-Daten)**
löscht Cache, Offline-Daten und die Anmeldung in der Web-Ansicht (danach dort neu anmelden; Widgets und
Mitteilungen bleiben verbunden, Daten auf dem Server bleiben) und lädt die Startseite neu.

**Auch im Browser:** startet die Web-App dort nicht (nach 10 Sekunden nichts gerendert, z. B. weil eine Datei fehlt
oder der Browser zu alt ist), ersetzt eine einfache Seite die leere: „Die App konnte nicht starten“ mit dem
Fehlertext, **Neu laden** und **Offline-Daten löschen** (meldet Service Worker ab, löscht Zwischenspeicher). Läuft ein
Service Worker auf der leeren Seite, räumt sie vorher einmal selbst auf und lädt neu. Die gesammelten Fehler gehen
– wenn der Nutzer automatische Fehlerberichte erlaubt hat – als Ticket „[Browser] App-Start fehlgeschlagen …“ an
das Team (siehe [Fehler & Wünsche](bug-reports.md)). Wer abgemeldet ist, sendet nichts; dann hilft „Diagnose senden“
in der App oder ein Blick in die Einstellungen → Diagnose.

**Was die App sonst selbst repariert:** Stellt Android die App nach dem Beenden im Hintergrund wieder her und der
gespeicherte Web-Zustand ist leer oder unbrauchbar, lädt sie die Startseite. „Neu laden“ im Schnellmenü funktioniert
auch ohne geladene Seite.

**Für Admins – neue Version ausliefern:** mit `x-min-supported-code` (siehe unten) kann man ältere Versionen zum Update
zwingen. Ist die App leer, aber startet, bietet sie das Update beim Öffnen an (Dialog), auch über dem leeren Bildschirm.

## Widgets

Lange auf den Home-Bildschirm drücken → Widgets → HyperLevel. Beim Hinzufügen wählt man das Projekt („Alle Projekte“
oder ein Sub-Account) und je nach Widget weitere Optionen; später über „Widget bearbeiten“ änderbar. Widgets zeigen
sofort die zuletzt geladenen Daten („vor 3 Min.“), aktualisieren sich im Hintergrund, nach jeder Aktion, beim Öffnen
der App und über den ↻-Knopf.

| Widget | Größen | Was es kann |
| --- | --- | --- |
| Cockpit | 2×2 – 5×3 | Neue Leads heute, offene Deals €, Umsatz Monat, ungelesen, Aufgaben fällig, Termine, Umsatzkurve 30 Tage |
| Posteingang | 3×2 – 5×4 | Neueste Unterhaltungen mit Kanal-Symbol und Ungelesen-Punkt; Tipp öffnet die Unterhaltung, ↩ antwortet direkt (Kanal wählbar). Option: nur ungelesene |
| Aufgaben | 2×2 – 5×4 | Heute & überfällig (oder Woche / alle offenen) mit echten Häkchen; „+“ legt eine Aufgabe an (Fälligkeit, Projekt, Diktat) |
| Termine | 3×2 – 5×3 | Heute und morgen; Tipp: anrufen, navigieren, Meeting öffnen, bestätigen, erschienen/nicht erschienen, absagen |
| Pipeline | 4×2 – 5×3 | Phasen mit Anzahl und Wert, Top-Deals; Tipp: Phase wechseln, gewonnen/verloren |
| Projekte | 3×2 – 5×4 | Alle Projekte mit Website-Status (grün/rot), offenen Aufgaben, ungelesenen Nachrichten |
| Schnellaktionen | 4×1, 2×2, 4×2 | Kontakt, Aufgabe, Notiz, Anruf, Sprach-Notiz, Rechnung, Posteingang – Auswahl einstellbar |
| Umsatz | 2×2 – 4×2 | Monat, heute, offene Rechnungen (überfällige), Kurve |
| Anrufe | 3×2 – 5×3 | Verpasste Anrufe mit Mailbox-Hinweis und Rückruf (Handy oder über HyperLevel/Twilio) |
| Bewertungen | 2×2 – 4×2 | Sterne, Anzahl, Veränderung 30 Tage, neue Bewertungen, neueste Bewertung |
| Sprach-Notiz | 1×1, 2×1 | Ein Tipp, sprechen – wird Aufgabe (mit Fälligkeit) oder Notiz am genannten Kontakt |
| Zahl | 1×1, 2×1 | Eine Kennzahl nach Wahl mit Trendpfeil (z. B. Leads heute, Umsatz Monat, ungelesen) |
| Social | 3×2 – 4×3 | Nächste geplante Beiträge mit Zeit und Kanälen |

Abgemeldet zeigen Widgets „In HyperLevel anmelden“, nach einem Widerruf (Passwortwechsel, „Alle abmelden“, Gerät
entfernt) „Neu anmelden“ – ein Tipp öffnet die App; ist der Web-Login noch gültig, verbindet sie sich sofort wieder.

## Mitteilungen

Die App fragt `/api/mobile/feed` bei jeder Hintergrund-Aktualisierung ab (Standard alle 15 Minuten, Android kann
das im Energiesparmodus strecken) und zeigt neue Ereignisse als Mitteilung – ohne Firebase. Kanäle: Nachrichten,
Team-Chat (Direktnachrichten und Erwähnungen), Anrufe, Leads, Zahlungen, Websites, Aufgaben, Bewertungen, Meine Meldungen (Antworten und Statuswechsel bei
eigenen Meldungen und Wünschen) – je Art in den App-Einstellungen abschaltbar, Töne in
den System-Einstellungen. Tipp öffnet die passende Seite im richtigen Sub-Account. Beim ersten Abruf gibt es keine
alten Meldungen.

## Datenschutz & Sicherheit

- Login nur auf dem eigenen Server; die App tauscht die Anmeldung einmal gegen einen Geräte-Schlüssel (`ghm_…`),
  der nur für `/api/mobile/*` gilt, im Android Keystore verschlüsselt liegt und nicht ins Backup geht.
- „Abmelden“ in der App widerruft den Schlüssel auf dem Server und löscht Login-Cookies und zwischengespeicherte Daten.
- Updates nur per HTTPS und nur mit passender SHA-256-Prüfsumme; Android prüft zusätzlich die Signatur.

## Für Admins

- **App Links**: der Server liefert `/.well-known/assetlinks.json` für die Paket-ID deines Builds (Standard
  `org.gohigh.android`, sonst `PGHL_ANDROID_PACKAGE` bzw. Agentur-Einstellung) mit dem SHA-256 deines
  Signatur-Zertifikats (`PGHL_ANDROID_CERT_SHA256` oder *Agentur → Android-App*). Ohne Fingerabdruck bleibt die Datei
  leer und Links öffnen im Browser. Eigenen Build: siehe [android/README.md](../android/README.md).
- **APK hochladen**: `PUT /api/mobile/app` mit `x-version-code`, `x-version-name`, `x-changelog`, optional
  `x-min-supported-code` (ältere Versionen müssen dann aktualisieren).
- Der Hintergrund-Refresh holt nur, was platzierte Widgets brauchen (gleiche Anfragen werden zusammengelegt).

## Öffentliche APK für alle

Die Startseite des Projekts ([landing.md](landing.md)) bietet die APK von gohyperlevel.com zum Herunterladen an: Knopf auf
`/downloads/hyperlevel.apk` (früher `gohigh.apk`, bleibt als Alias) mit Version, Größe und SHA-256 der zuletzt hochgeladenen Datei, QR-Code zur Seite `/android`,
Anleitung für „Apps aus dieser Quelle zulassen“. Download, Prüfsumme und Selbst-Update sind die vorhandenen Wege (siehe
oben) – neu ist nur der Platz auf der Startseite.

**Was heute fehlt:** (Server-Seite für die Gray-Label-App mit Server-Suche, nativer Push über das Relay und Branding nach dem Login: [apps.md](apps.md).) Die App fragt beim ersten Start **nicht** nach dem Server. Sie nutzt die beim Bau eingetragene
Adresse (`-PgohighBaseUrl` bzw. `GOHIGH_BASE_URL`, ohne Angabe `https://crm.example.com`); umstellen lässt sie sich nur
über die Entwickler-Optionen (siebenmal auf „Version“ tippen). Eine APK, die wirklich für alle funktioniert, braucht einen
Startbildschirm mit zwei Wegen – „HyperLevel Cloud“ (die eingebaute Adresse) oder „Eigener Server“ (Adresse eingeben,
die App prüft `GET /api/version` und speichert sie in `AppSettings.baseUrl`) – und den Hinweis, dass App Links nur für die
eingebaute Domain gelten (`/.well-known/assetlinks.json` nennt das Zertifikat dieses Builds). Bis es den gibt:

- auf gohyperlevel.com eine APK anbieten, die mit der **Cloud-Adresse** gebaut ist (sie verbindet sich mit der Cloud),
- Self-Hoster laden die APK ihrer eigenen Instanz unter `/android` (dort lädt der Admin seinen eigenen Build hoch) oder
  bauen sie mit ihrer Adresse,
- Agenturen bauen ihre gebrandete APK selbst (eigene Paket-ID, Name und Icon im Quellcode, eigener Signatur-Schlüssel).

Die Korrektur „ausgehende Anrufe zeigen die angerufene Nummer“ (Commit `f2781b2`) ist im Quellcode unter `android/` und
kommt mit dem nächsten Build in die APK.

**Bauen und ausliefern** (Android SDK 36, JDK 17 oder neuer; Signatur-Datei nie einchecken):

```bash
cd android
export ANDROID_HOME=/pfad/zum/android-sdk
export GOHIGH_BASE_URL=https://<cloud-adresse>          # die Adresse, mit der sich die öffentliche APK verbindet
export GOHIGH_APPLICATION_ID=<paket-id>                 # z. B. com.gohyperlevel.app – muss zu PGHL_ANDROID_PACKAGE passen
# versionCode/versionName in app/build.gradle.kts erhöhen (heute 4 / 1.0.3)
./gradlew test lintDebug
./gradlew assembleRelease -PsigningProps=/sicherer/ort/signing.properties
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
sha256sum app/build/outputs/apk/release/app-release.apk

# hochladen (Agentur-Schlüssel mit Schreibrecht oder als Admin angemeldet)
curl -X PUT https://gohyperlevel.com/api/mobile/app \
  -H "Authorization: Bearer pghla_…" -H "content-type: application/vnd.android.package-archive" \
  -H "x-version-code: 4" -H "x-version-name: 1.0.3" -H "x-changelog: Ausgehende%20Anrufe%20zeigen%20die%20Nummer" \
  --data-binary @app/build/outputs/apk/release/app-release.apk
```

Danach `PGHL_ANDROID_PACKAGE` und `PGHL_ANDROID_CERT_SHA256` (Fingerabdruck aus `apksigner`) setzen, damit App Links
funktionieren, und auf der Startseite prüfen, dass Version, Größe und Prüfsumme stimmen.
