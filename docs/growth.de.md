[English](growth.md) · **Deutsch**

# Wachstum: Attribution, Affiliates & Werbeberichte

Drei Module, die zusammenspielen:

- **Attribution** – woher Leads, Kunden und Umsatz kommen (UTM, gclid/fbclid, Verweis-Seite, Einstiegsseite), erster und letzter Kontaktpunkt am Kontakt, Bericht je Quelle/Kampagne/Funnel. Ohne Google Analytics, ohne Meta-Pixel: alles läuft über deinen eigenen Server.
- **Affiliate-Manager** – Partner werben mit eigenem Link (`?ref=<code>`), bekommen Provision auf Verkäufe und sehen ihre Zahlen in einem kleinen Partnerbereich.
- **Werbeberichte** – Ausgaben, Klicks und Leads aus Meta Ads und Google Ads (nur lesend, täglich), verknüpft mit der Attribution zu Kosten pro Lead (CPL) und ROAS. Optional meldet die Conversions API Leads und Käufe an Meta zurück.
- **Anzeigen-Manager** – Kampagnen für Meta und Google Ads direkt in HyperLevel anlegen (pausiert, mit Prüfung und Bestätigung), steuern und Leads aus Lead-Anzeigen als Kontakte holen. UTM-Parameter setzt der Manager automatisch, die Zahlen erscheinen im selben Werbebericht – siehe [docs/ads-manager.md](ads-manager.md) (englisch).

Menü: **Attribution** (unter *Marketing*) und **Affiliates** (unter *Umsatz*). Rechte: der Bericht gehört zum Bereich *Dashboard*, Tracking- und Werbekonto-Einstellungen zu *Einstellungen*, Affiliates zu *Rechnungen & Produkte*.

## Attribution

### Was erfasst wird

| Wo | Wie |
| --- | --- |
| Funnel- und Website-Seiten | Beim Aufruf liest der Server UTM-Parameter (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`), Klick-IDs (`gclid`, `gbraid`/`wbraid`, `fbclid`, `msclkid`, `ttclid`, `li_fat_id`), Affiliate-Code (`ref`) und die Verweis-Seite. Die Seite bekommt ein signiertes Besucher-Token, das Formulare, eingebettete Termin-Buchungen, Kauf-Links und der Live-Chat mitschicken. |
| Kauf-Links `/buy/…` | wie Funnel-Seiten; das Token läuft durch Stripe Checkout bis zum Kauf |
| Formulare `/f/…` | die UTM-Parameter der Seite, auf der das Formular steht |
| Termin-Buchung, Live-Chat | Token bzw. die Adresse der Seite, auf der Buchung oder Chat laufen |
| andere Websites (WordPress & Co.) | mit dem Skript unter *Attribution → Tracking & Werbekonten* (siehe unten) |

Ohne UTM gilt: Klick-ID → Quelle der Werbeplattform (`google / cpc`, `facebook / social` …), bekannte Suchmaschine → `organic`, soziales Netzwerk → `social`, andere Website → `referral`, gar nichts → `(direkt)`. Ein Affiliate-Link ohne UTM erscheint als `affiliate / affiliate`.

Am **Kontakt** (Karte *Herkunft*) stehen erster und letzter Kontaktpunkt mit Kampagne, Funnel und Zeit, darunter der ganze Verlauf. „Letzter Kontakt“ ist der letzte *nicht direkte* Besuch vor dem Abschluss (wer erst über Google kommt und später die Adresse eintippt, bleibt Google zugeordnet).

### Bericht

*Attribution → Bericht*: Zeitraum (mit 7/30/90 Tagen und „Jahr“), gruppiert nach **Quelle**, **Quelle / Medium**, **Kampagne** oder **Funnel**, zugeordnet nach **erstem** oder **letztem Kontakt**. Je Zeile: neue Leads (Kontakte, die im Zeitraum angelegt wurden), gewonnene Deals mit Deal-Wert (nach dem Tag, an dem sie gewonnen wurden), zahlende Kunden und Umsatz (bezahlte Rechnungen inkl. Stripe, nach Zahlungsdatum). **CSV** lädt die Tabelle herunter (mit BOM, öffnet in Excel mit Umlauten).

Kontakte ohne Angaben (Import, manuell, ohne Einwilligung) stehen als `(unbekannt)`.

### Kontakte & Smart Lists filtern

In **Kontakte** gibt es (sobald Daten da sind) Filter für Quelle und Kampagne, wahlweise nur erster oder letzter Kontakt; `(ohne Herkunft)` zeigt Kontakte ohne Angaben. „Filter speichern“ legt eine Smart List an – Kampagnen an diese Smart List nutzen denselben Filter. Per API: `GET /api/contacts?attr_source=google&attr_campaign=Sommer&attr_touch=first`.

### UTM-Parameter in Anzeigen

- **Meta Ads** (Anzeige → *URL-Parameter*): `utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}`
- **Google Ads** (Konto → *Tracking-Vorlage*): `{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={campaignid}` – Auto-Tagging (`gclid`) kann zusätzlich an bleiben.

Für die Werbeberichte muss `utm_campaign` dem **Kampagnennamen** oder der **Kampagnen-ID** entsprechen (Groß/Kleinschreibung egal).

### Andere Websites einbinden

```html
<script src="https://<deine-domain>/a/<locationId>/t.js" async></script>
```

Das Skript (fertig zum Kopieren unter *Tracking & Werbekonten*) meldet den Besuch an `/api/public/attribution/<locationId>/touch`, merkt sich das Token nur mit Einwilligung in einem eigenen Cookie **dieser** Website und hängt es an Links und iFrames zu Formularen (`/f/`), Termin-Buchungen (`/book/`) und Kauf-Links (`/buy/`); der Live-Chat liest es ebenfalls.

Einwilligung aus deinem Cookie-Banner:

```js
window.pghlConsent = true;        // vor dem Skript, oder später:
pghl.consent(true);               // Ja – Cookie wird gesetzt
pghl.consent(false);              // Nein – Cookie wird gelöscht
// alternativ setzt das Banner ein Cookie pghl_consent=1 (Ja) bzw. 0 (Nein)
```

### Einwilligung auf Funnel-Seiten

Funnel-Seiten laufen aus Sicherheitsgründen in einer Sandbox – Skripte auf der Seite können dort keine Cookies setzen. Deshalb:

- Haken **„Eigenen kleinen Hinweis … zeigen“**: ein schlichter Hinweis mit *Einverstanden / Nein, danke* unten auf jeder Funnel-Seite (nur im Modus „Nur mit Einwilligung“ und solange noch keine Wahl getroffen ist).
- oder ein eigenes Banner verlinkt auf `<website>/pghl-consent?v=1` (Ja) bzw. `?v=0` (Nein), optional mit `&r=/seite` als Rücksprung (nur Pfade derselben Website). Auf der App-Domain heißt der Pfad `/p/<funnel>/pghl-consent`, für Kauf-Links `/a/consent?v=1&r=/buy/…`.
- **Der Cookie-Banner von HyperLevel** (*Einstellungen → Einwilligung & Recht → Cookie-Banner*, [docs/consent.md](consent.md#cookie-banner-cmp)) ersetzt den kleinen Hinweis: Ist er eingeschaltet, erscheint nur **ein** Banner. Das Besucher-Cookie `pghl_vid` wird gesetzt, wenn *Statistik* oder *Marketing* erlaubt ist; die Wahl wird im Cookie `pghl_cmp` (mit `pghl_consent` als Kurzform) gespeichert und protokolliert.

### Einstellungen

*Attribution → Tracking & Werbekonten → Tracking*:

| Einstellung | Wirkung |
| --- | --- |
| Herkunft erfassen | aus = nichts wird erfasst |
| Besucher-Cookie | **Nur mit Einwilligung** (Standard), **Immer** (nur mit eigener Rechtsgrundlage), **Nie** |
| Cookie-Laufzeit | 1–730 Tage, Standard 90 |
| Hinweis-Banner | siehe oben |

## Datenschutz (DSGVO, TDDDG)

- **Kein Fremd-Tracking.** Es werden keine Dritt-Skripte geladen; alle Daten liegen in deiner Datenbank.
- **Cookie `pghl_vid`:** eine zufällige ID (kein Name, keine E-Mail), First-Party, `HttpOnly`, `SameSite=Lax`, Laufzeit einstellbar. Es ist **nicht** technisch notwendig – nach § 25 TDDDG (früher TTDSG) braucht es eine Einwilligung. Deshalb ist „Nur mit Einwilligung“ voreingestellt. „Immer“ nur wählen, wenn du eine andere Rechtsgrundlage sauber begründen kannst.
- **Cookie `pghl_consent`:** speichert nur die Wahl (Ja/Nein), ist dafür technisch notwendig.
- **Ohne Einwilligung** wird nichts auf dem Gerät gespeichert: das Token steht nur in der aufgerufenen Seite. Schickt jemand darauf ein Formular ab, wird die Herkunft *dieses* Besuchs dem neuen Kontakt zugeordnet (die Daten schickt er mit dem Formular selbst). Direkte Aufrufe ohne Cookie hinterlassen keinen Datensatz.
- **Nein heißt nein:** Mit `pghl_consent=0` oder aktivierter Global Privacy Control (`Sec-GPC: 1`, ohne ausdrückliches Ja) wird der Besuch gar nicht erfasst.
- **Datensparsam:** Einstiegs- und Verweis-Seite werden ohne Query-String gespeichert (dort stehen manchmal E-Mails oder Tokens). Besuche, aus denen kein Kontakt wurde, löscht die App nach Ablauf der Cookie-Laufzeit. Link-Vorschauen und Crawler werden ignoriert.
- **Löschen:** Wird ein Kontakt gelöscht, verschwindet seine ganze Herkunfts-Historie mit (Recht auf Löschung).
- **Datenschutzerklärung**, Vorschlag: *„Wir speichern auf unserem eigenen Server, über welche Anzeige oder Website Sie zu uns gefunden haben (Kampagnen-Parameter, verweisende Seite, Einstiegsseite). Mit Ihrer Einwilligung (Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG) setzen wir dafür ein eigenes Cookie mit einer zufälligen Kennung (Laufzeit 90 Tage). Eine Weitergabe an Dritte findet nicht statt.“* – plus die Absätze zu Meta Conversions API und Partnerprogramm, falls genutzt.
- **Conversions API (Meta):** überträgt E-Mail, Telefon und Name als SHA-256-Hash sowie die Klick-ID an Meta. Das ist eine Übermittlung personenbezogener Daten an Meta (USA, gemeinsame Verantwortlichkeit) und braucht eine **Einwilligung** und einen Hinweis in der Datenschutzerklärung. Standardmäßig aus; wenn an, gehen nur Kontakte raus, die über Meta-Werbung kamen **und** deren Einwilligung „Tracking & Cookies → Marketing“ bestätigt ist (Cookie-Banner oder von Hand erfasst) – wie bei den Offline-Conversions für Google Ads. Ohne Einwilligung steht die Conversion als *blockiert* in der Liste.
- **Offline-Conversions (Google Ads):** überträgt Klick-ID (gclid/gbraid/wbraid), Wert und – bei erweiterten Conversions für Leads – E-Mail und Telefon als SHA-256-Hash an Google. HyperLevel lädt nur Kontakte hoch, deren Einwilligung „Tracking & Cookies → Marketing“ bestätigt ist (geprüft beim Ereignis und direkt vor dem Hochladen), und meldet sie mit `consent.adUserData: GRANTED`. Hinweis in der Datenschutzerklärung nicht vergessen. Einrichtung: [docs/ads-manager.md](ads-manager.md#offline-conversions-google-ads).
- **Werbeberichte** lesen nur zusammengefasste Kampagnenzahlen – keine personenbezogenen Daten.
- **Partnerprogramm:** Name, E-Mail und Bankdaten der Partner werden zur Abrechnung gespeichert (Art. 6 Abs. 1 lit. b DSGVO). Partner sehen nie Namen oder E-Mails der geworbenen Kunden, nur Datum, Art und Betrag der Provision.

## Affiliate-Manager

### Einrichten

1. **Affiliates → Programme → + Programm**:
   - **Provision** in Prozent vom Nettoumsatz oder als Festbetrag je Verkauf,
   - **Es zählt der** letzte oder erste Klick,
   - **Cookie-Laufzeit** (wie alt der Klick beim Lead höchstens sein darf; das Besucher-Cookie selbst richtet sich nach der Attribution, also Laufzeit dort mindestens so lang einstellen),
   - **Abo-Verlängerungen** (wiederkehrende Provision ja/nein),
   - **Auszahlung ab** (Mindestbetrag), **Haltefrist** (0 = von Hand freigeben, sonst automatisch nach N Tagen, z. B. 14 für das Widerrufsrecht),
   - **Ziel-Link** der Partner-Links (leer = dein erster Funnel), öffentliche Anmeldung, sofort freischalten, Bedingungen.
2. Den **Anmelde-Link** (`https://<domain>/affiliate/<programm>/join`) teilen oder Partner unter *Affiliates → + Affiliate* von Hand anlegen. Jeder Partner wird auch als Kontakt mit Tag `affiliate` angelegt.
3. Partner melden sich im **Partnerbereich** `https://<domain>/affiliate/<programm>` mit ihrer E-Mail an (Login-Link, 30 Minuten gültig, einmal nutzbar, eigenes Cookie – getrennt von Admin- und Mitglieder-Logins). Dafür muss unter **Einstellungen → E-Mail & SMS** ein SMTP-Versand eingerichtet sein; *Login-Link senden* am Affiliate verschickt ihn von Hand.

Im Partnerbereich: persönlicher Link und Code, Klicks, Leads, Verkäufe, Provision offen/freigegeben/ausgezahlt, Liste der Provisionen und Auszahlungen, eigene Auszahlungsdaten (IBAN oder PayPal).

### So wird gezählt

- **Klick:** Aufruf einer Funnel-/Website-Seite, eines Kauf-Links oder einer Seite mit Tracking-Skript mit `?ref=<code>` eines aktiven Partners. Derselbe Besucher bzw. dieselbe Verbindung zählt höchstens einmal in 24 Stunden; Klicks von der Verbindung, mit der sich der Partner zuletzt angemeldet hat, zählen nicht. Besucher-ID und Verbindungs-Hash eines Klicks werden nach zwei Tagen gelöscht, der Klick selbst (Seite, Verweis, gezählt) bleibt für die Zahlen.
- **Lead:** Der Besucher wird Kontakt (Formular, Termin, Chat, Kauf) und hat einen Partner-Klick innerhalb der Cookie-Laufzeit. Einmal geworben bleibt geworben.
- **Eigenempfehlung** (gleicher Kontakt oder gleiche E-Mail wie der Partner) wird nicht gezählt und steht in der Aktivität.
- **Provision:** Jede bezahlte Rechnung eines geworbenen Kunden – von Hand auf bezahlt gesetzt, über Stripe bezahlt oder per Kauf-Link gekauft – erzeugt eine Provision (Status *offen*). Abo-Verlängerungen (Stripe-Abo, wiederkehrende Rechnungen) nur, wenn das Programm es erlaubt. Jede Rechnung zählt nur einmal.
- **Storno, Erstattung, Gutschrift:** Stripe-Erstattung (`charge.refunded`, im Stripe-Webhook zusätzlich abonnieren), stornierte Rechnung oder **Gutschrift / Rechnungskorrektur** zur Rechnung → offene/freigegebene Provision wird storniert, bei Teil-Erstattung bzw. Teil-Gutschrift anteilig gekürzt (bei Gutschriften im Verhältnis des gutgeschriebenen Nettos; eine Gutschrift, die schon vor der Zahlung geschrieben war, zählt gleich beim Entstehen der Provision mit). War die Provision schon ausgezahlt oder steckt sie in einer offenen Auszahlung, bleibt sie, wie sie war, und es entsteht eine negative **Rückbuchung**, die mit der nächsten Auszahlung verrechnet wird – nie mehr als ausgezahlt wurde. Erstattung und Gutschrift für dasselbe Geld zählen nicht doppelt (es gilt die größere Kürzung). Eine Abo-Kündigung beendet nur künftige Provisionen.

### Freigeben und auszahlen

1. *Provisionen* (Filter „Offen“) → Haken setzen → **freigeben** (oder automatisch per Haltefrist).
2. *Auszahlungen* → **Auszahlungen erstellen**: bündelt je Partner alle freigegebenen Provisionen, sobald die Summe die Auszahlungsgrenze erreicht.
3. **CSV** (alle offenen Auszahlungen mit IBAN/PayPal) oder **SEPA-Datei** (`pain.001.001.03`, Ausführung am nächsten Tag) herunterladen und im Online-Banking hochladen. Die SEPA-Datei nutzt deine IBAN/BIC aus **Einstellungen → Rechnungen**; PayPal-Partner sind nur in der CSV.
4. Nach der Überweisung **Ausgezahlt** klicken – die Provisionen stehen dann auf *ausgezahlt*.

Daneben: *Gutschrift / Korrektur* für manuelle Buchungen (auch negativ), *Stornieren* für einzelne Provisionen.

### Workflows

Auslöser **„Neuer Affiliate“** (`affiliate.created`) und **„Provision erstellt“** (`affiliate.commission_created`); `contactId` ist jeweils der Kontakt des Partners (z. B. Begrüßungs-Mail, „Du hast Provision verdient“). Daten: `affiliateId`, `programId`, `affiliate.{name, email, code, status, link, portal}` bzw. `commissionId`, `amount_cents`, `kind`, `customerId`, `invoiceId`.

## Werbeberichte (Meta Ads & Google Ads)

*Attribution → Tracking & Werbekonten*. Alle Schlüssel werden verschlüsselt gespeichert und nie wieder an den Browser geschickt. Die App ruft täglich die letzten 7 Tage ab (beim ersten Mal 30), weil die Plattformen Zahlen nachträglich korrigieren; „30 Tage abrufen“ und „Jetzt abrufen“ gehen jederzeit.

### Meta Ads

1. [Meta Business Suite](https://business.facebook.com/settings) → *Benutzer → Systembenutzer* → Systembenutzer anlegen (Rolle Mitarbeiter reicht), ihm das **Werbekonto** zuweisen (Berechtigung *Werbekonto ansehen*).
2. *Token generieren* für deine Meta-App mit der Berechtigung **`ads_read`**, Ablauf „Nie“.
3. In der App eintragen: **Werbekonto-ID** (`act_1234567890` oder nur die Ziffern) und den **Token**. „Verbindung testen“ ruft die letzten 7 Tage ab.

Gelesen wird `GET /v23.0/act_<id>/insights` (Ebene Kampagne, je Tag): Ausgaben, Impressionen, Klicks und Leads (Aktion `lead`). Die API-Version lässt sich bei Bedarf über `api_version` in `PUT /api/ads/accounts/meta` ändern.

**Conversions API (optional):** Pixel-/Dataset-ID aus dem Events-Manager eintragen und den Haken setzen; der Token oben braucht dann auch Zugriff auf das Dataset (oder du trägst einen eigenen CAPI-Token ein, Events-Manager → Einstellungen → *Zugriffstoken generieren*). Gesendet werden `Lead` (erster Kontakt aus Formular, Termin oder Chat) und `Purchase` (jede bezahlte Rechnung, mit Betrag) als `action_source: system_generated` mit gehashter E-Mail/Telefon/Name, `external_id` und – falls vorhanden – `fbc` aus der `fbclid`. Jede Conversion geht genau einmal raus (`event_id` `lead_<kontakt>` / `purchase_<rechnung>`); mit dem **Test-Code** erscheinen sie unter *Events testen*. Die Liste „Gesendete Conversions“ zeigt Status und Fehler. Datenschutz: siehe oben.

### Google Ads

Die Google Ads API braucht vier Dinge – einmal einrichten, dann läuft es:

1. **Developer-Token:** Google Ads (Verwaltungskonto/MCC) → *Tools → API-Center*. Für eigene Konten reicht der Zugang „Explorer“/„Basic“; ein Test-Token liest nur Testkonten.
2. **OAuth-Client:** [Google Cloud Console](https://console.cloud.google.com) → Projekt anlegen → *Google Ads API* aktivieren → *APIs & Dienste → Anmeldedaten → OAuth-Client-ID* (Typ „Webanwendung“, autorisierte Weiterleitungs-URI `https://developers.google.com/oauthplayground`). Client-ID und Client-Secret notieren.
3. **Refresh-Token** (ohne eigenes Login-Formular, manuell): [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) → Zahnrad → *Use your own OAuth credentials* → Client-ID/Secret eintragen → links als Scope `https://www.googleapis.com/auth/adwords` eingeben → *Authorize APIs* mit dem Google-Konto, das Zugriff auf das Werbekonto hat → *Exchange authorization code for tokens* → **Refresh token** kopieren. (Steht der OAuth-Zustimmungsbildschirm auf „Testing“, läuft der Token nach 7 Tagen ab – auf „In production“ stellen.)
4. **Kunden-ID** des Werbekontos (`123-456-7890`, oben rechts in Google Ads); läuft der Zugriff über ein Verwaltungskonto, zusätzlich dessen ID als **Verwaltungskonto-ID**.

Gelesen wird per `googleAds:searchStream` (API `v21`, änderbar über `api_version`): Kosten, Impressionen, Klicks und Conversions je Kampagne und Tag.

### CPL und ROAS

*Attribution → Werbung: CPL & ROAS*: je Kampagne Ausgaben, Klicks, CTR, Leads laut Plattform, **Leads im CRM** (Kontakte, deren `utm_campaign` dem Namen oder der ID der Kampagne entspricht – bei Meta-Kampagnen mit Quelle facebook/instagram, bei Google mit Quelle google), **Kosten pro Lead** (Ausgaben ÷ CRM-Leads), **Umsatz** (bezahlte Rechnungen dieser Leads im Zeitraum) und **ROAS** (Umsatz ÷ Ausgaben). Darüber die Ausgaben je Tag. Leads zählen wahlweise nach letztem (Standard) oder erstem Kontakt.

## API

| Bereich | Endpunkte |
| --- | --- |
| Attribution | `GET /api/attribution/report?from&to&group=source\|source_medium\|campaign\|funnel&model=first\|last`, `GET /api/attribution/report.csv` (gleiche Parameter), `GET /api/attribution/sources`, `GET /api/contacts/:id/attribution`, `GET/PUT /api/attribution/settings` `{enabled, cookie: consent\|always\|never, cookie_days, banner, banner_text}`; Filter `GET /api/contacts?attr_source&attr_medium&attr_campaign&attr_touch=first\|last` |
| Affiliates | `GET/POST /api/affiliates/programs`, `PATCH/DELETE /api/affiliates/programs/:id`, `GET/POST /api/affiliates` (`?program_id&status`), `PATCH/DELETE /api/affiliates/:id`, `POST /api/affiliates/:id/login-link`, `GET /api/affiliates/overview`, `GET /api/affiliates/commissions?status&affiliate_id`, `POST /api/affiliates/commissions` `{affiliate_id, amount_cents, note}`, `POST /api/affiliates/commissions/approve` `{ids}`, `POST /api/affiliates/commissions/:id/reverse`, `GET/POST /api/affiliates/payouts`, `POST /api/affiliates/payouts/:id/paid`, `DELETE /api/affiliates/payouts/:id`, `GET /api/affiliates/payouts/export.csv?ids=`, `GET /api/affiliates/payouts/sepa.xml?ids=` |
| Werbung | `GET /api/ads/accounts`, `PUT/DELETE /api/ads/accounts/meta\|google`, `POST /api/ads/accounts/:platform/test`, `POST /api/ads/sync` `{platform?, days?}`, `GET /api/ads/report?from&to&model`, `GET /api/ads/capi-log` |
| Öffentlich | `GET /a/<locationId>/t.js`, `POST /api/public/attribution/<locationId>/touch` `{url, referrer, token?, consent?}`, `GET /a/consent?v=1\|0&r=`, `<website>/pghl-consent?v=1\|0&r=`, Partnerbereich `/affiliate/<programm>` (+ `/join`, `/login`, `/auth`) |

MCP-Werkzeuge: `ghl_attribution_report` (Leads, Deals, Umsatz je Quelle/Kampagne/Funnel) und `ghl_list_affiliates` (Partner mit Zahlen, ohne Bankdaten).
