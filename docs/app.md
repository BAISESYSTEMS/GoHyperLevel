# App installieren & Push-Benachrichtigungen

Zwei Wege aufs Handy: die installierbare Web-App (unten) oder die native [Android-App](#android-app).

Die Oberfläche ist eine installierbare Web-App (PWA): eigenes Symbol auf dem Home-Bildschirm bzw. im Startmenü, eigenes Fenster ohne Browserleiste, startet auch offline (mit den zuletzt geladenen Daten), und sie meldet Neues per Push aufs Gerät.

## Installieren

- **Chrome / Edge (Windows, Mac, Linux, Android):** Unten erscheint „App installieren“ – oder das Installieren-Symbol rechts in der Adressleiste. Auch unter **Einstellungen → Mein Konto** gibt es den Knopf, solange der Browser es anbietet.
- **iPhone / iPad:** In Safari auf *Teilen* → **„Zum Home-Bildschirm“**. Push gibt es auf iOS ab 16.4 und nur in der so installierten App.

Name, Farbe und Symbol kommen aus dem Branding (Agentur → White-Label; auf einer Kunden-Login-Domain das Kunden-Branding). Das Symbol (blaue Fläche mit zwei Pfeilen) liegt als `icon.svg` und PNG in 192/512 px sowie als „maskable“-Variante bei.

## Benachrichtigungen einschalten

**Einstellungen → Mein Konto → Benachrichtigungen:** Haken bei „Benachrichtigungen auf diesem Gerät“, Browser-Nachfrage erlauben, „Test-Benachrichtigung senden“. Das gilt pro Gerät; alle Geräte mit Benachrichtigungen stehen darunter und lassen sich einzeln entfernen.

Was benachrichtigt (abschaltbar, gilt für alle deine Geräte):

| Art | Wann | An wen |
| --- | --- | --- |
| Neue Nachrichten | eingehende E-Mail, SMS, Live-Chat (je Unterhaltung höchstens alle 30 Sekunden) | dem Kontakt zugewiesene Person, sonst alle mit Zugriff auf Konversationen des Sub-Accounts |
| Website nicht erreichbar / wieder online | Website-Überwachung im Projekt-Steckbrief | alle mit Zugriff auf den Sub-Account |
| Aufgaben | dir zugewiesen (von jemand anderem, per Workflow, API oder MCP); morgens ab 8 Uhr: was heute fällig ist | die zugewiesene Person |
| Zahlungen und Käufe | Rechnung über Stripe bezahlt, Produkt gekauft | alle mit Zugriff auf Rechnungen |

Ein Klick auf die Benachrichtigung öffnet die passende Seite (und wechselt in den richtigen Sub-Account).

## Technik & Betrieb

- Push braucht **HTTPS** (oder `localhost`). Es werden keine fremden Dienste eingebunden: Die App spricht Web Push (VAPID + verschlüsselte Nachrichten nach RFC 8291) direkt mit den Push-Diensten der Browser (Google, Mozilla, Apple, Microsoft).
- Die VAPID-Schlüssel entstehen beim ersten Start und liegen in der Datenbank (der private Teil verschlüsselt). Ein Backup enthält sie – nach einem Umzug funktionieren bestehende Abos weiter.
- Optional `PGHL_PUSH_CONTACT=mailto:du@example.com` setzen – diese Kontaktadresse bekommen die Push-Dienste (Standard: E-Mail des ersten Admins).
- Der Service Worker (`/sw.js`, Bereich `/app`) cacht nur die App selbst und – für den Offline-Start – die letzten API-Antworten des eigenen Kontos; beim Abmelden wird dieser Zwischenspeicher gelöscht. Öffentliche Seiten (Buchung, Formulare, Rechnungen, Funnels) bleiben unberührt. Er hält nur Dateien vor, die wirklich sind, was ihr Name sagt (nie eine HTML-Seite unter einem Skriptnamen, nie eine Fehlerantwort), und liefert die Offline-Startseite nur aus, wenn alle Dateien, die sie braucht, im Zwischenspeicher liegen. Startet die Oberfläche nicht, ersetzt `/boot-guard.js` die leere Seite nach 10 Sekunden durch „Die App konnte nicht starten“ (Neu laden, Offline-Daten löschen) – siehe [Android-App](android-app.md#wenn-die-seite-leer-bleibt-fehlersuche).
- Andere Module schicken eigene Benachrichtigungen über `app.services.pushNotify({ locationId | userIds, kind, title, body, url, tag })`.

## Android-App

Neben der Web-App gibt es eine native Android-App (Paket `org.gohigh.android` – bei eigenem Build deine Paket-ID –, Name und Farben aus dem Branding, z. B. „HyperLevel“). Sie zeigt Posteingang, Aufgaben, Termine, Deals, Anrufe, Zahlen und Projekte **aller** Sub-Accounts, auf die man Zugriff hat, bringt Home-Bildschirm-Widgets mit und meldet Neues als Benachrichtigung. Alles Weitere öffnet sie als Web-Ansicht dieser Oberfläche.

### Installieren

- Auf dem Handy **`https://<deine-domain>/android`** öffnen (oder den QR-Code auf dieser Seite mit der Kamera scannen) → **App herunterladen** → `gohigh.apk` öffnen → für den Browser „Apps aus dieser Quelle zulassen“ → **Installieren**. Warnt Google Play Protect: „Weitere Details“ → „Trotzdem installieren“ (die App kommt nicht aus dem Play Store).
- In der App mit den gewohnten Zugangsdaten anmelden (auch mit Zwei-Faktor-Code). Updates meldet die App selbst.
- Unter **Einstellungen → Mein Konto** steht oben die Karte **„App fürs Handy“** mit dem Link auf `/android`.

### Koppeln & Geräte

Nach der Anmeldung in der App tauscht diese ihre Sitzung einmalig gegen einen **Geräte-Schlüssel** (`ghm_…`). Er bleibt nur auf dem Handy; der Server speichert ihn als SHA-256 und zeigt ihn nie wieder. Der Schlüssel gilt nur für die App-Schnittstelle (`/api/mobile/*`) und handelt als der angemeldete Nutzer – Agentur-Admins sehen alle Sub-Accounts, Kunden-Logins nur ihre eigenen und nur ihre freigegebenen Bereiche; der SaaS-Tarif (ausgeblendete Bereiche, pausiertes Konto = nur lesen) gilt genauso wie im Browser.

**Einstellungen → Mein Konto → Geräte (App)** listet alle gekoppelten Handys (Name, App-Version, zuletzt genutzt, IP) mit **Abmelden**. Abgemeldet werden die Geräte außerdem bei *Passwort ändern*, *Alle anderen abmelden* und wenn ein Admin das Passwort des Logins neu setzt (*Team*) oder ihn überall abmeldet (`POST /api/users/:id/sessions/revoke`). Ein abgemeldetes Gerät bekommt `401` und bittet um neue Anmeldung. Jede Änderung aus der App steht im Änderungsprotokoll mit dem Weg **„App“**; je Gerät gelten höchstens 300 Anfragen pro Minute.

### Widgets & Benachrichtigungen

- **Widgets** lesen `GET /api/mobile/summary` (neue Leads heute/7 Tage, offene Deals und Wert, gewonnen im Monat, Umsatz heute/Monat mit 30-Tage-Verlauf, offene Rechnungen, ungelesene Unterhaltungen, Aufgaben heute/überfällig, Termine heute, verpasste Anrufe heute, Sterne, Websites online/offline, Leads der letzten 14 Tage), dazu Posteingang, Aufgaben, Termine, Deals, Anrufe, Bewertungen, Zahlungen und Social-Posts – je wahlweise für alle Sub-Accounts oder einen. „Heute“ ist der Tag in der Zeitzone des jeweiligen Sub-Accounts.
- **Benachrichtigungen** holt die App selbst über `GET /api/mobile/feed?since=<cursor>` (kein Push-Dienst nötig): neue eingehende Nachrichten (je Unterhaltung höchstens alle 30 Sekunden), verpasste Anrufe, neue Leads/Kontakte, bezahlte Rechnungen, Website nicht erreichbar/wieder online, fällige Aufgaben (zur Uhrzeit bzw. um 8 Uhr am Fälligkeitstag, nur für die zugewiesene Person) und neue Bewertungen. Der erste Abruf liefert nur den Cursor – keine alten Meldungen. Gespeichert wird das nur, wenn mindestens ein Handy gekoppelt ist, und 14 Tage lang.
- Ein Tipp auf eine Meldung öffnet die passende Seite in der App, z. B. `/app/conversations?c=<id>&loc=<sub-account>`. **`?loc=`** wechselt dabei vorher in den Sub-Account (wenn man ihn sehen darf); `?c=` öffnet eine Unterhaltung direkt.

### Neue App-Version veröffentlichen (Agentur)

**Einstellungen → Mein Konto → Geräte (App) → Neue App-Version hochladen:** signierte Release-APK wählen, Versionscode (`versionCode`, muss mindestens so hoch sein wie der aktuelle; derselbe Code ersetzt den Build), Versionsname und „Was ist neu?“ eintragen. Per Skript geht das mit Admin-Anmeldung oder einem Agentur-Schlüssel (schreiben):

```bash
curl -X PUT https://crm.example.com/api/mobile/app \
  -H "Authorization: Bearer $AGENTUR_KEY" -H 'content-type: application/vnd.android.package-archive' \
  -H 'x-version-code: 4' -H 'x-version-name: 1.1.0' -H "x-changelog: $(printf 'Neue Widgets' | jq -sRr @uri)" \
  --data-binary @app-release.apk
```

Die Datei (bis 200 MB) liegt unter `<PGHL_DATA_DIR>/mobile-app/` (die letzten drei Versionen), die SHA-256-Prüfsumme rechnet der Server aus. Sofort danach gibt es sie unter `/android`, `/downloads/gohigh.apk` und `GET /api/mobile/app` (Update-Prüfung der App, mit `min_supported_code` – ältere Apps verlangen dann ein Update; optional Header `x-min-supported-code`).

### App Links

`/.well-known/assetlinks.json` bestätigt Android, dass Links auf diese Domain in der App aufgehen dürfen. Standard ist das Release-Zertifikat der App (`51:33:42:92:…:05:DF`) – dafür ist nichts zu tun. Ein anderer Signatur-Schlüssel: unter *Neue App-Version hochladen* den SHA-256-Fingerabdruck eintragen (mehrere mit Komma), per `PUT /api/agency/mobile-app` `{cert_sha256, package_name, min_supported_code}` oder über die Umgebung `PGHL_ANDROID_CERT_SHA256` (gilt, solange in der Agentur nichts eingetragen ist). Die Datei muss auf jeder Domain erreichbar sein, deren Links die App öffnen soll (Haupt-Adresse und Agentur-App-Domain).
