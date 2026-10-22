# HyperLevel – Android-App

Native Android-App für HyperLevel (Paket `org.gohigh.android`, minSdk 26, target/compile 36): die Web-App unter
`/app` im WebView plus 13 Home-Screen-Widgets (Jetpack Glance), Schnellaktionen, lokale Mitteilungen und
In-App-Updates. Nutzerdoku: [../docs/android-app.md](../docs/android-app.md). Server-Vertrag: Mobile-API
(`/api/mobile/*`, siehe `docs/api.md` im Server).

## Bauen

Voraussetzungen: JDK 21, Android SDK (Plattform 36, Build-Tools 36). `local.properties` mit `sdk.dir=…`
oder `ANDROID_HOME` setzen.

```bash
./gradlew assembleDebug                      # app/build/outputs/apk/debug/app-debug.apk (Paket …gohigh.debug)
./gradlew assembleRelease -PsigningProps=/pfad/signing.properties
./gradlew test                               # Unit-, Vertrags- und Render-Tests (Robolectric)
./gradlew lintDebug
```

**Eigener Server:** `-PgohighBaseUrl=https://crm.deine-domain.de` (oder `GOHIGH_BASE_URL`) setzt den
Standard-Server und den Host der App Links; `-PgohighApplicationId=de.deinefirma.crm` (oder `GOHIGH_APPLICATION_ID`)
die Paket-ID. Auf dem Server muss `/.well-known/assetlinks.json` dieselbe Paket-ID und den Fingerabdruck deines
Signatur-Zertifikats nennen (`PGHL_ANDROID_PACKAGE`, `PGHL_ANDROID_CERT_SHA256` oder *Agentur → Android-App*).
Ohne Angaben: `https://crm.example.com` und `org.gohigh.android` – den Server kann man auch im Debug-Bereich der App-Einstellungen umstellen (Versionsnummer mehrmals antippen).

`signing.properties` (nie einchecken) enthält `storeFile`, `storePassword`, `keyAlias`, `keyPassword`;
alternativ `GOHIGH_SIGNING_PROPS=/pfad`. Ohne Angabe entsteht ein unsigniertes Release. Das Release-Zertifikat
muss zu `/.well-known/assetlinks.json` des Servers passen (App Links).

## Tests & Screenshots

- `api/` – Parsing aller Antworten (Fixtures wie vom Server), Client gegen MockWebServer, Demo-Backend.
- `data/`, `notify/`, `update/`, `util/`, `widget/` – Cache, Repository, Feed-Cursor, Updater (Version, SHA-256),
  Deep Links, Formatierung, Widget-Logik.
- `ui/main/` – `WebHealthTest` (Zustand wiederherstellen und Neu laden ohne Seite, Absturzzähler, Zeitplan und Urteil der
  Seitenprüfung, Protokoll, WebView-Version, Diagnosetext) und `DiagnosticsSenderTest` (Fehlermeldung an den Mock-Server,
  Teilen als Rückfall). Die JavaScript-Teile (`PROBE_JS`, `OFFLINE_RESET_JS`) prüft `tests/android-probe.test.ts` im
  Server-Projekt gegen das echte `boot-guard.js`.
- `feedback/` – Fehler melden & Wunschliste: API-Fehler-Protokoll, Schüttel-Erkennung, Fixtures von
  `/api/mobile/bug-reports` und `/api/mobile/wishes` (erzeugt vom echten Server), Client und Demo-Backend.
- `shots/WidgetShotsTest` rendert jedes Widget über echte RemoteViews (Glance → `AppWidgetHostView`) in hell/dunkel
  und mehreren Größen; `ScreenShotsTest` die nativen Screens (Roborazzi). Ausgabe: `-PshotsDir=/pfad`
  (Standard `app/build/shots`).
- Vorschaubilder fürs Widget-Menü neu erzeugen:
  `./gradlew testDebugUnitTest --tests '*PreviewImagesTest*' -PpreviewDir=/tmp/p` und als WebP nach
  `app/src/main/res/drawable-nodpi/` kopieren.
- Gegen einen echten Server (opt-in): `--tests '*LiveContractTest*' -PliveBase=http://… -PliveEmail=… -PlivePassword=…`
  – koppelt per Login-Cookie und ruft jeden Endpunkt auf (danach wird das Test-Gerät wieder abgemeldet).

## Aufbau (`app/src/main/java/org/gohigh/android/`)

| Paket | Inhalt |
| --- | --- |
| `api` | DTOs, `GoHighApi` (OkHttp + kotlinx.serialization), `FakeBackend`/`DemoData` (Demo-Modus) |
| `data` | Einstellungen, Token im Android Keystore, Disk-Cache, `Repository`, Sitzung |
| `widget` | 13 Glance-Widgets, gemeinsame Bausteine (`ui/Kit.kt`), Aktionen, Konfiguration |
| `work` / `notify` / `update` | WorkManager-Refresh, Feed → Mitteilungen, Updater |
| `feedback` | Screenshot (PixelCopy), Geräte-Infos, letzte API-Fehler (`ApiErrorLog`), Schütteln, Absturzberichte |
| `ui` | WebView (`main`), Einstellungen, Schnellaktionen (`quick`), Widget-Einrichtung (`config`), Fehler melden & Wunschliste (`report`), Theme |

`ui/main` im Detail: `MainActivity` (WebView in einem Container, den Compose nur als `View` kennt – die WebView lässt sich
nach einem Absturz des Render-Prozesses austauschen), `WebHealth.kt` (reine Logik, ohne Android-Typen: Wiederherstellung des
WebView-Zustands, Absturzzähler, Zeitplan und Urteil der Seitenprüfung, Protokoll `WebLog`, WebView-Version,
Diagnosetext), `WebMonitor` (verbindet WebView-Rückrufe mit dieser Logik, sendet die Diagnose) und `WebFallback`
(der Bildschirm „Die Seite lädt nicht“). Die Seitenprüfung fragt `#root` und `window.__pghlMounted` ab
(`web/public/boot-guard.js`, `web/src/boot.tsx`); die Mindestversion `MIN_WEBVIEW_MAJOR` entspricht `build.target` in
`vite.config.ts`.

Icons: Material Symbols Rounded (Apache 2.0), erzeugt mit `python3 tools/material_symbols.py`.
