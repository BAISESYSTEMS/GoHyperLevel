[English](meta-channels.md) · **Deutsch**

# WhatsApp, Messenger & Instagram

WhatsApp Business (Cloud API), Facebook Messenger und Instagram Direct landen direkt in **Konversationen** – neben E-Mail, SMS und Live-Chat. Jeder Sub-Account verbindet seine eigene Nummer und eine oder [mehrere Seiten mit ihren Instagram-Konten](#mehrere-seiten-und-instagram-konten).

- **Posteingang:** Kanal-Symbol an jeder Konversation und Nachricht, Filter je Kanal, Bilder/Sprachnachrichten/Videos/Dokumente direkt in der Nachricht, Standorte als Kartenlink, Status *gesendet → zugestellt → gelesen* (oder *fehlgeschlagen* mit Grund).
- **Antworten:** Im Eingabefeld erscheinen die Reiter *WhatsApp*, *Messenger* bzw. *Instagram*. Das Feld zeigt, ob das 24-Stunden-Fenster offen ist. Außerhalb des Fensters bietet WhatsApp die freigegebenen **Vorlagen** an (Vorschau, Platzhalter ausfüllen).
- **Kontakte:** WhatsApp-Absender werden über die Telefonnummer (E.164, wie im Kontaktmodul) zugeordnet – vorhandene Kontakte werden wiederverwendet und nicht umbenannt. Messenger/Instagram-Absender bekommen einen Kontakt mit Namen aus dem Meta-Profil (soweit Meta ihn herausgibt) und den Tag `messenger` bzw. `instagram`; die Zuordnung PSID/IGSID → Kontakt merkt sich die App.
- **Automationen:** Auslöser „Nachricht empfangen“ mit Kanal *WhatsApp/Messenger/Instagram*; Aktion **„WhatsApp senden“** (Text im 24-h-Fenster, sonst Vorlage – oder immer eins von beiden, Platzhalter wie `{{contact.first_name}}` gehen). „STOP“ setzt „Nicht stören“.
- **API & MCP:** `POST /api/messages` mit `channel: whatsapp|messenger|instagram`, Vorlagen über `POST /api/messages/meta`; MCP-Werkzeuge `ghl_send_message` (alle Kanäle), `ghl_list_whatsapp_templates`, `ghl_send_whatsapp`.

Voraussetzung: HyperLevel ist unter einer öffentlichen **https**-Adresse erreichbar (`PGHL_BASE_URL`), sonst kann Meta keine Nachrichten zustellen.

## 1. Meta-App anlegen

1. Auf [business.facebook.com](https://business.facebook.com) ein Business-Portfolio haben (für höhere Limits später verifizieren).
2. Auf [developers.facebook.com](https://developers.facebook.com/apps) → **App erstellen** → Anwendungsfall *Sonstiges* → Typ **Business** → mit dem Business-Portfolio verbinden.
3. **App-Einstellungen → Allgemein:** den **App-Geheimcode** (App-Secret) kopieren. Er kommt in HyperLevel unter **Einstellungen → Kanäle → App-Secret**. Ohne ihn nimmt HyperLevel keine Nachricht an – jede Zustellung wird mit der Signatur `X-Hub-Signature-256` geprüft.

## 2. WhatsApp Business

1. In der App **Produkt hinzufügen → WhatsApp**. Unter **WhatsApp → API-Einrichtung** eine eigene Nummer hinzufügen (oder zum Testen die Testnummer nehmen). Die Nummer darf nicht gleichzeitig in der normalen WhatsApp-App laufen.
2. Dort **Telefonnummer-ID** (*Phone number ID*, nicht die Nummer selbst) und **WhatsApp-Business-Konto-ID** (*WhatsApp Business Account ID*) kopieren.
3. **Dauerhaften Token** erzeugen (der Token auf der API-Seite läuft nach 24 Stunden ab):
   - Business-Einstellungen → **Benutzer → Systembenutzer** → *Hinzufügen* (Rolle Admin).
   - *Assets zuweisen*: die App und das WhatsApp-Konto (volle Kontrolle).
   - *Neuen Token generieren*: App wählen, Ablauf **Nie**, Berechtigungen `whatsapp_business_messaging` und `whatsapp_business_management`.
4. In HyperLevel **Einstellungen → Kanäle**: Telefonnummer-ID, Konto-ID, Token eintragen → **Speichern** → **Verbindung testen** (zeigt Anzeigename, Nummer und Qualitätsstufe).
5. **Webhook:** in der App unter **WhatsApp → Konfiguration → Webhook bearbeiten** die **Rückruf-URL** (`https://<domain>/hooks/meta/<locationId>`) und den **Verify-Token** aus HyperLevel eintragen → *Überprüfen und speichern*. Danach bei den Webhook-Feldern **`messages`** abonnieren.
   Alternativ setzt **„Webhooks bei Meta abonnieren“** in HyperLevel die Rückruf-URL nur für dieses WhatsApp-Konto (Webhook-Override) und abonniert die App für das Konto; das Feld `messages` muss in der App trotzdem abonniert sein.
6. App auf **Live** schalten. Im Entwicklungsmodus gehen Nachrichten nur an eingetragene Testnummern (Fehler „nicht als Testnummer freigegeben“).
7. Im **WhatsApp Manager** eine Zahlungsmethode hinterlegen und **Vorlagen** anlegen (Kategorie Marketing, Service oder Authentifizierung). Freigegebene Vorlagen erscheinen nach ein paar Minuten in HyperLevel (Liste wird 5 Minuten zwischengespeichert). Unterstützt werden Text-Kopfzeilen, Bild/Video/Dokument-Kopfzeilen (per https-Link), Platzhalter `{{1}}` oder benannte `{{vorname}}`, Antwort-, Telefon- und Link-Buttons.

## 3. Facebook Messenger und Instagram Direct

1. Die Facebook-Seite gehört zum Business-Portfolio; das Instagram-Profi-Konto ist mit der Seite verknüpft. In der Instagram-App: **Einstellungen → Nachrichten und Story-Antworten → Verbundene Tools → Zugriff auf Nachrichten erlauben**.
2. In der App **Produkt hinzufügen → Messenger** (für Instagram zusätzlich **Instagram** mit *Facebook Login*).
3. **Seiten-Token:** dem Systembenutzer die Seite als Asset zuweisen und einen Token (Ablauf *Nie*) mit `pages_messaging`, `pages_manage_metadata`, `pages_show_list` sowie für Instagram `instagram_basic` und `instagram_manage_messages` erzeugen.
4. **Seiten-ID** (Seite → Info → Seitentransparenz) und **Instagram-Konto-ID** (im Graph-API-Explorer: `GET /<seiten-id>?fields=instagram_business_account`) in HyperLevel eintragen, Token dazu → Speichern → Verbindung testen.
5. **Webhooks:** unter **Messenger → Einstellungen → Webhooks** (Objekt *Page*) und für das Objekt **Instagram** dieselbe Rückruf-URL und denselben Verify-Token eintragen. Felder: `messages`, `messaging_postbacks`, `message_deliveries`, `message_reads` (optional `message_reactions`).
6. Die Seite muss die App abonnieren: **„Webhooks bei Meta abonnieren“** in HyperLevel erledigt das (`POST /<seiten-id>/subscribed_apps`), alternativ in der Messenger-Einstellung der App „Seite hinzufügen“.
7. Für Nachrichten von beliebigen Personen braucht die App die **App-Prüfung** (Advanced Access) für `pages_messaging` und `instagram_manage_messages`. Bis dahin funktioniert es nur mit Personen, die eine Rolle in der App haben.

Namen kommen aus dem Meta-Profil (`first_name/last_name` bzw. `name/username`). Fehlt die Berechtigung, heißt der Kontakt „Messenger-Kontakt“ bzw. „Instagram-Kontakt“ und kann umbenannt werden.

## Mehrere Seiten und Instagram-Konten

Ein Sub-Account kann **mehrere Facebook-Seiten** (je mit verknüpftem Instagram-Konto) verbinden – z. B. eine Seite je Filiale oder Marke. Unter **Einstellungen → Kanäle → Seiten und Instagram-Konten** → *+ Weitere Seite*: Seiten-ID, optional Instagram-Konto-ID und den Token **dieser** Seite eintragen; *Verbindung testen* liest Namen und Benutzernamen aller Seiten, *Webhooks bei Meta abonnieren* abonniert jede Seite.

- **Eingang:** Jede Nachricht wird über die Seiten-ID bzw. Instagram-Konto-ID (`entry.id` des Webhooks) der richtigen Seite zugeordnet – auch über Sub-Accounts mit gleichem App-Secret hinweg.
- **Posteingang:** Bei mehr als einer Seite steht die Seite als Unterkanal an der Nachricht („Messenger · Filiale Nord“, „Instagram · @marke“), und das Eingabefeld zeigt, über welche Seite die Antwort rausgeht.
- **Antwort:** Facebook vergibt je Seite eigene Personen-IDs (PSID/IGSID). HyperLevel merkt sich, an welche Seite jemand geschrieben hat, und antwortet mit dem **Token dieser Seite**. Wird eine Seite entfernt, kann ihren Kontakten nicht mehr geantwortet werden (Fehler „… ist nicht mehr verbunden“).
- **Umstellung:** Die bisherige einzelne Seite wurde beim Update automatisch zur ersten Seite der Liste (Migration `002-pages`), ihre Kontakte bleiben ihr zugeordnet. Die Felder `page_id`, `page_token`, `ig_account_id` von `PUT /api/settings/meta` bearbeiten weiterhin diese erste Seite.
- [Bewertungen von Facebook](reputation.md) wählen eine der Seiten, [Kommentare im Posteingang](social-comments.md) antworten mit dem Token der Seite, unter deren Beitrag kommentiert wurde. [Kommentar-zu-DM](comment-to-dm.md) arbeitet mit der ersten Seite.

## Kommentare unter Beiträgen (Kommentar-zu-DM)

Dieselbe Verbindung trägt auch [Kommentar-zu-DM](comment-to-dm.md): Auf ein Stichwort im Kommentar unter einem Instagram-Beitrag, Reel oder Facebook-Beitrag antwortet HyperLevel öffentlich und schickt privat eine Nachricht mit Link. Dafür zusätzlich im Webhook abonnieren: Instagram `comments`, Seite `feed` (der Knopf *Kommentare abonnieren* auf der Seite *Kommentar-zu-DM* erledigt es per API) und die Berechtigungen `instagram_manage_comments`, `pages_manage_engagement`, `pages_read_engagement`, `pages_manage_metadata`; für fremde Konten braucht die App Advanced Access (App Review) – Einzelheiten in der Anleitung.

## Eine Meta-App für mehrere Sub-Accounts

Eine Meta-App hat pro Produkt nur **eine** Rückruf-URL. Zwei Wege:

- **Eigene App je Kunde** – jede trägt ihre eigene `…/hooks/meta/<locationId>` ein.
- **Eine Agentur-App** – in allen Sub-Accounts **dasselbe App-Secret** eintragen und in der App die Rückruf-URL eines beliebigen dieser Sub-Accounts verwenden. HyperLevel ordnet jede Nachricht über Telefonnummer-ID, Seiten-ID bzw. Instagram-ID dem richtigen Sub-Account zu (nur zwischen Sub-Accounts mit gleichem App-Secret). Bei WhatsApp setzt „Webhooks bei Meta abonnieren“ ohnehin eine eigene Adresse je WhatsApp-Konto.

Nachrichten an IDs, die keinem Sub-Account gehören, werden ignoriert; der Hinweis steht unter **Einstellungen → Kanäle**.

## 24-Stunden-Fenster und Kosten

- **Fenster:** Freien Text darfst du nur innerhalb von 24 Stunden nach der letzten Nachricht des Kontakts schicken. Bei WhatsApp geht außerhalb (und für die allererste Nachricht) nur eine **freigegebene Vorlage**; Messenger und Instagram erlauben außerhalb nichts (Message-Tags werden hier nicht unterstützt). HyperLevel prüft das vor dem Senden und zeigt den Zustand im Eingabefeld.
- **WhatsApp kostet Geld:** Meta berechnet Vorlagen nach Kategorie (Marketing, Service, Authentifizierung) und Land des Empfängers – früher pro 24-Stunden-Konversation, inzwischen pro Vorlagen-Nachricht. Antworten innerhalb des Fensters sind derzeit kostenlos. Aktuelle Preise: [WhatsApp Business Platform Pricing](https://developers.facebook.com/docs/whatsapp/pricing). Messenger und Instagram sind kostenlos.

## Was die App speichert

- IDs im Klartext, **Tokens und App-Secret verschlüsselt** (AES-256-GCM mit dem Server-Schlüssel aus dem Datenordner); sie werden nie an den Browser zurückgegeben. Wird der Server-Schlüssel gewechselt, müssen die Tokens neu eingetragen werden.
- Nachrichten in der normalen Nachrichtentabelle (`channel` = `whatsapp`/`messenger`/`instagram`), jede Meta-Nachricht nur einmal (Meta stellt bei Fehlern mehrfach zu).
- Medien nur als Verweis: WhatsApp-Dateien holt HyperLevel erst beim Ansehen über die Graph-API (Meta hält sie 30 Tage vor), Messenger/Instagram-Anhänge über Metas CDN-Link. Der Token geht dabei nur an Metas eigene Server.
- Nachrichten, die direkt in der WhatsApp-Business-App, der Meta Business Suite oder Instagram geschrieben werden, erscheinen nicht (Meta schickt sie nicht bzw. nur als „Echo“, das ignoriert wird).

## Fehlersuche

| Meldung | Ursache |
| --- | --- |
| Meta: „Rückruf-URL konnte nicht überprüft werden“ | Verify-Token falsch kopiert, Adresse nicht per https erreichbar, oder ein Proxy blockt `/hooks/` |
| Keine eingehenden Nachrichten, „Noch nichts empfangen“ | Feld `messages` nicht abonniert, Seite nicht abonniert, App im Entwicklungsmodus |
| 401 „Signatur ungültig“ im Server-Log | App-Secret in HyperLevel passt nicht zur App |
| „Zugriffstoken ungültig oder abgelaufen“ | Kurzzeit-Token benutzt – dauerhaften Systembenutzer-Token eintragen |
| „Außerhalb des 24-Stunden-Fensters“ | Vorlage senden oder warten, bis der Kontakt schreibt |
| „Empfänger ist nicht als Testnummer freigegeben“ | App noch im Entwicklungsmodus |
| „…an unbekannte ID … ignoriert“ | Telefonnummer-ID/Seiten-ID/Instagram-ID in den Einstellungen prüfen |

## API

```bash
# Text (nur im 24-Stunden-Fenster)
curl -X POST https://crm.example.com/api/messages -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"contact_id":"…","channel":"whatsapp","body":"Passt Dienstag 10 Uhr?"}'

# Freigegebene Vorlagen mit ihren Platzhaltern (slots)
curl https://crm.example.com/api/messages/meta/templates -H "Authorization: Bearer $KEY"

# Vorlage senden (geht auch außerhalb des Fensters)
curl -X POST https://crm.example.com/api/messages/meta -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"contact_id":"…","channel":"whatsapp","template":{"name":"termin_erinnerung","language":"de","values":{"body.1":"Anna","body.2":"Dienstag"}}}'
```

Weitere Endpunkte: `GET /api/messages/meta/status?contact_id=` (Kanäle, Empfänger, Fensterzustand, `via` = Seite der Antwort), `GET /api/messages/meta/media/:messageId` (Datei einer eingehenden Nachricht), `GET/PUT/DELETE /api/settings/meta` (mit `pages`), `GET/POST /api/settings/meta/pages` (`{page_id, ig_account_id, page_token}`), `PATCH/DELETE /api/settings/meta/pages/:id`, `POST /api/settings/meta/test`, `POST /api/settings/meta/subscribe`, `GET /api/conversations?channel=whatsapp`. Öffentlich: `GET/POST /hooks/meta/:locationId` (Meta-Webhook).
