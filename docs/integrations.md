# Integrationen: Zapier, Make, n8n, REST-Hooks, eingehende Webhooks, HubSpot-Umzug, Lexware Office/sevDesk

Alles, was HubSpot-Nutzer von „Apps & Integrationen“ kennen – selbst gehostet, ohne Marketplace. Überblick mit Live-Status:

- **Agentur → Integrationen → Katalog**: alle eingebauten Integrationen (Stripe, Twilio, Meta/WhatsApp, Google/Microsoft, Google-Profil, Todoist, Postiz, OpenShorts (Video-Studio), Norman, Supabase, Anthropic, Werbekonten, SMTP/IMAP, MCP) plus Zapier, Make, n8n, REST-Hooks, eingehende Webhooks und die Umzüge aus HubSpot/GHL – mit Suche, Kategorien, Status (eingerichtet / unvollständig / offen / sofort nutzbar) und Anleitung. Per-Sub-Account-Integrationen zeigen „x von y Sub-Accounts eingerichtet“. Die bisherigen Einstellungskarten liegen unter **Einrichtung**. Module ergänzen eigene Einträge samt Status-Probe über `app.services.catalogExtra` (z. B. das Video-Studio).
- **Sub-Account → Apps**: derselbe Katalog für den aktuellen Sub-Account. Kunden-Logins sehen Agentur-Einstellungen nur als „Wird von der Agentur eingerichtet“. Unter den eingebauten Integrationen erscheinen passende Apps aus **Composio** (250+ Apps mit verwalteter Anmeldung); dazu die Reiter *Composio-Apps*, *App-Ereignisse*, *KI & MCP* und *Direkt-Verbindungen* (Slack/Discord, Notion, Google Sheets) – siehe [docs/connectors.md](connectors.md).

Der Status kommt aus den vorhandenen Status-Endpunkten (`GET /api/stripe`, `/api/telephony/settings`, `/api/settings/meta`, `/api/ai/settings`, `/api/ads/accounts`, `/api/agency/todoist`, …) – es wird keine externe API aufgerufen. API: `GET /api/integrations/catalog` (Sub-Account), `GET /api/agency/integrations/catalog` (nur Admins).

## REST-Hooks

Sofort-Auslöser für Automatisierungs-Tools nach dem REST-Hook-Muster (wie bei Zapier üblich): das Tool meldet eine Ziel-URL für einen Auslöser an, HyperLevel schickt jedes passende Ereignis per `POST` dorthin.

| Endpunkt | Zweck |
| --- | --- |
| `GET /api/hooks/me` | Verbindung testen (Name/ID des Sub-Accounts) |
| `GET /api/hooks/triggers` | Auslöser mit Filtern |
| `GET /api/hooks/triggers/:key/sample` | Beispieldaten: die letzten drei echten Ereignisse der letzten 30 Tage, sonst ein Muster (die DSGVO-Löschung eines Kontakts entfernt seine Beispiele und Zustellungen) |
| `POST /api/hooks` | Abonnieren: `{target_url, event, filters?, source?, label?}` (`hookUrl`/`url`/`targetUrl` gehen auch) → Abo mit `id` und `secret` |
| `GET /api/hooks`, `GET/PATCH/DELETE /api/hooks/:id` | Auflisten, pausieren/fortsetzen (`{status: active\|paused}`), Filter ändern, abbestellen |
| `POST /api/hooks/:id/test` | Beispiel sofort zustellen |
| `GET /api/hooks/deliveries`, `GET /api/hooks/deliveries/:id`, `POST /api/hooks/deliveries/:id/retry` | Zustell-Protokoll (30 Tage), Details mit Payload/Antwort, erneut senden |

**Auslöser** (`event`): `contact.created`, `contact.updated`, `contact.tagged` (Filter `tag`), `opportunity.created` (`pipeline_id`), `opportunity.stage_changed` (`pipeline_id`, `stage_id`), `opportunity.won`, `opportunity.lost` (`pipeline_id`), `form.submitted` (`form_id`), `appointment.booked`, `appointment.cancelled` (`calendar_id`), `invoice.paid`, `product.purchased` (`product_id`), `task.completed`, `message.inbound` (`channel`), `call.missed`, `review.received` (eigene, Google- und [weitere Plattformen](reputation.md) – Feld `source`), `any` (alle Ereignisse, optional `events: [...]`).

**Payload**: `{id, event, type, location_id, occurred_at, contact_id, contact, data}` – `id` ist je Ereignis gleich (zum Entdoppeln), `contact` der vollständige Kontakt, `data` die Rohdaten (z. B. `data.opportunity`, `data.appointment`, `data.invoice`).

**Zustellung**: Header `x-pghl-signature = sha256(secret + body)` (wie bei den ausgehenden Webhooks), dazu `x-pghl-event`, `x-pghl-delivery`, `x-pghl-hook`, `x-pghl-attempt`. 2xx = zugestellt. Netzwerkfehler, Zeitüberschreitung (10 s), 408, 429 und 5xx werden wiederholt: nach 1 Min., 5 Min., 30 Min., 2 Std. und 6 Std. (max. 6 Versuche). Andere 4xx sind endgültig. **410 Gone** dreimal hintereinander → Abo wird deaktiviert (wieder aktivieren in der Liste). Ziele in internen Netzen sind gesperrt.

**Aktionen** (`POST /api/hooks/actions/<aktion>`, laufen intern über die normale REST-API mit denselben Rechten, Prüfungen und dem Protokoll): `create_contact`, `update_contact` (per `contact_id`/`email`/`phone`, `new_email`), `add_tag`, `remove_tag`, `create_opportunity` (Pipeline/Stufe per ID **oder Name**), `move_stage`, `create_task`, `add_note`, `send_message`, `create_invoice_draft` (`items: [{name, qty, price}]` in Euro netto oder `price_cents`). Ist ein Kontakt per E-Mail/Telefon nicht bekannt, legen `add_tag`, `create_opportunity`, `create_task`, `add_note`, `send_message` und `create_invoice_draft` ihn an. **Suchen**: `GET /api/hooks/search/contacts?email|phone|q|id`, `GET /api/hooks/search/opportunities?contact_id|email|status|q|id` (je max. 10).

Anmeldung: Sub-Account-Schlüssel (`pghl_…`, Einstellungen → API & Webhooks) oder Agentur-Schlüssel (`pghla_…`) plus `x-location-id`. In der Oberfläche: **Einstellungen → API & Webhooks** zeigt Abos (Quelle Zapier/Make/n8n/API, Status, letzte Antwort) und das Zustell-Protokoll.

## Zapier

Fertige private App im Repo: `integrations/zapier/` (Zapier Platform CLI). Hochladen entscheidest du selbst:

```bash
cd integrations/zapier && npm install && npx zapier login && npx zapier register "HyperLevel" && npx zapier push
```

Verbindung in Zapier: Adresse (z. B. `https://crm.example.com`), API-Schlüssel, bei Agentur-Schlüsseln die Sub-Account-ID. Enthalten: alle 17 Auslöser als Sofort-Auslöser, die 10 Aktionen, „Kontakt finden (oder anlegen)“, „Opportunity finden“, Auswahllisten für Pipelines, Stufen, Tags, Formulare, Kalender, Produkte. Details: [integrations/zapier/README.md](../integrations/zapier/README.md).

## Make

Custom App als JSON in `integrations/make/` (Base, Connection, Dedicated Webhook mit attach/detach, Instant Trigger, Aktionen, Suchen, RPCs). In Make unter **Custom Apps** anlegen und die Abschnitte einfügen: [integrations/make/README.md](../integrations/make/README.md).

## n8n

Importierbare Vorlagen in `integrations/n8n/` (nur Webhook-, HTTP-Request- und Manual-Trigger-Knoten): Abo anlegen, Ereignisse empfangen, Formular → Deal, Deal gewonnen → Rechnungsentwurf, Lead von außen, verpasster Anruf → Rückruf. Zugang in n8n: Header-Auth „HyperLevel API“ mit `Authorization: Bearer pghl_…`. [integrations/n8n/README.md](../integrations/n8n/README.md).

## Eingehende Webhooks

Workflow-Auslöser **„Webhook empfangen (mit Feldzuordnung)“** (`webhook.received`) – für Tools, die nur „Webhook an URL senden“ können (Shops, Typeform, Calendly, eigene Websites):

- Jeder Workflow mit diesem Auslöser bekommt eine geheime URL `https://<domain>/hooks/in/<token>` (im Auslöser kopieren, „Neue URL“ macht die alte ungültig).
- Die letzten fünf Anfragen werden als **Test-Daten** gespeichert (höchstens 30 Tage); „Auf Test-Daten warten“ zeigt neue sofort an. Im **Testmodus** wird nur gespeichert, der Workflow startet nicht. Ist der Workflow nicht aktiv, antwortet die URL mit 409 (Test-Daten werden trotzdem gespeichert). Die DSGVO-Löschung eines Kontakts entfernt Test-Daten mit seiner E-Mail-Adresse oder Telefonnummer.
- **Feldzuordnung**: Pfad im JSON (`customer.email`, `items.0.sku`, `order[0].id`) → Kontaktfeld, eigenes Feld (`custom.<schlüssel>`), Tags oder „Nicht stören“; „Automatisch zuordnen“ schlägt Felder nach Namen vor, „Vorschau“ zeigt das Ergebnis ohne zu speichern. Ohne Zuordnung werden `email`, `phone`, `first_name`, `last_name`, `name`, `company` … und `tags` direkt (oder aus `contact`) gelesen. Dazu feste Tags je Workflow.
- Kontakt wird angelegt oder per E-Mail/Telefon zusammengeführt, dann startet der Workflow; im Workflow steht das ganze JSON als `{{webhook.…}}` bereit.
- **Signatur optional**: „Signatur verlangen“ erzeugt ein Secret (einmal sichtbar, verschlüsselt gespeichert). Dann muss jede Anfrage `X-Signature-256: sha256=<HMAC-SHA256 des Rohtexts, hex>` tragen (auch `X-Hub-Signature-256`, `X-Pghl-Hmac`, Base64 geht auch) – sonst 401.
- **Limit** je URL: Standard 60 Anfragen pro Minute (1–600), darüber 429.
- **Wiederholungen**: Schickt der Absender eine Zustell-ID mit (`webhook-id`, `svix-id`, `Idempotency-Key`, `X-Webhook-Id`, `X-Delivery-Id`, `X-GitHub-Delivery`, `X-Shopify-Webhook-Id` …), startet dieselbe Zustellung den Workflow nur einmal (7 Tage lang); die Wiederholung bekommt `{ok: true, duplicate: true}`. Ohne ID zählt jede Anfrage.

API (Login oder Schlüssel): `GET/PUT /api/inbound-webhooks/:workflowId` (`{mapping: [{from, to}], tags, capture, rate_limit}`), `POST …/secret` (`{enabled: false}` schaltet ab), `POST …/rotate`, `POST …/preview` (`{capture_id?, payload?, mapping?}`), `DELETE …/captures`. Der klassische Auslöser „Eingehender Webhook“ (`/hooks/workflow/:id?key=`) erkennt Wiederholungen an denselben Zustell-IDs und lehnt Anfragen ohne E-Mail, Telefon oder Namen mit 400 ab (sonst entstanden leere Kontakte).

## HubSpot-Import

**Einstellungen → Import → Von HubSpot umziehen** holt einen HubSpot-Account in den aktuellen Sub-Account.

1. In HubSpot: Einstellungen → Integrationen → **Private Apps** → „Private App erstellen“. Scopes (lesen): `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read`, `crm.objects.owners.read`, `crm.schemas.contacts.read`, `crm.lists.read`, `tickets`, `sales-email-read`.
2. Token (`pat-…`) eintragen – er wird geprüft (`/account-info/v3/details`), **verschlüsselt** gespeichert und nie wieder angezeigt; „Trennen“ löscht ihn.
3. Teile wählen und **Probelauf**: Anzahl je Bereich in HubSpot, schon importiert, neu.
4. **Import starten**: läuft im Hintergrund mit Fortschritt je Schritt und Protokoll; „Pausieren“ und „Fortsetzen“ (auch nach Fehlern oder Neustart des Servers – es geht an der gespeicherten Stelle weiter).

| HubSpot | HyperLevel |
| --- | --- |
| Owner | Nutzer mit gleicher E-Mail (für „zugewiesen an“ bei Kontakten, Deals, Aufgaben); ohne Treffer: Hinweis im Protokoll |
| Kontakt-Eigenschaften | eigene Felder (alle selbst angelegten, dazu Position, Lebenszyklus-Phase, Lead-Status, Branche, Bundesland, Mobiltelefon); Auswahlwerte als Klartext |
| Kontakte | Kontakte (Name, E-Mail, Telefon/Mobil, Firma, Adresse, Website, Geburtstag, Erstelldatum, Quelle „HubSpot“); bestehende Kontakte mit gleicher E-Mail werden zusammengeführt |
| Firmen | Firmen-Modul, wenn installiert (`app.services.companies`), sonst Firmenname im Kontaktfeld „Firma“ |
| Deal-Pipelines + Stufen | Pipelines mit gleichen Stufen (eigene, später ergänzte Stufen bleiben) |
| Deals | Opportunities (Wert, Stufe, gewonnen/verloren aus der Stufe, Owner); Deals ohne Kontakt werden gezählt und übersprungen |
| Notizen | Notizen am Kontakt (HTML → Text, Original-Datum) |
| Aufgaben | Aufgaben (erledigt/offen, Fälligkeit, Owner) |
| Anrufe, E-Mails, Meetings | Aktivitäten in der Kontakt-Timeline (`hubspot.call` usw., Original-Datum) |
| Tickets | Helpdesk-Modul, wenn installiert (`app.services.ticketsImport`), sonst übersprungen mit Hinweis |
| Kontaktlisten | Tags mit dem Listennamen |

Mehrfach ausführbar: jede HubSpot-ID wird gemerkt (`hubspot_ids`), ein zweiter Lauf aktualisiert statt zu verdoppeln. Importierte Kontakte lösen keine Workflows/Webhooks aus. HubSpot-Limits: kurze Pause zwischen den Aufrufen, bei 429 wird `Retry-After` abgewartet (sonst 1 s, 2 s, 4 s … bis 30 s, max. 6 Versuche), dasselbe bei 5xx; danach bricht der Lauf ab und lässt sich fortsetzen. Fehlt einem Teil der Scope (403), wird er mit Hinweis übersprungen.

API (nur mit Anmeldung in der Oberfläche): `GET /api/import/hubspot` (Verbindung ohne Token, Teile, letzter Probelauf und Import), `PUT/DELETE /api/import/hubspot/connection` `{token}`, `POST /api/import/hubspot/dry-run` `{parts}`, `POST /api/import/hubspot/start` `{parts}` (Teile: `owners, contacts, companies, deals, notes, tasks, engagements, tickets, lists`), `GET /api/import/hubspot/jobs[/:id]`, `POST /api/import/hubspot/jobs/:id/pause|resume`.

**Für Firmen-/Helpdesk-Module** (Haken, damit der Import sie nutzt): `app.services.companies = { upsert(locationId, {name, domain, website, phone, address, city, postal_code, country, industry, external_source, external_id, existing_id}) → {id} | id, linkContact?(locationId, companyId, contactId) }` (alternativ `app.services.associations.link(locationId, {type:'company', id}, {type:'contact', id})`) und `app.services.ticketsImport(locationId, {external_source, external_id, existing_id, subject, content, pipeline, stage, priority, contact_id, assigned_to, created_at}) → {id} | id`.

<a id="lexware-office-and-sevdesk-live-sync"></a>
## Lexware Office und sevDesk: Live-Sync

HyperLevel stellt die Rechnung aus – lückenlose Nummer, festgeschriebenes Dokument, PDF und XRechnung –, dein Buchhaltungsprogramm bekommt automatisch eine Kopie. Vorher gab es nur den einmaligen [Umzug](umzug.md)-Import und die manuelle Verknüpfung (`ghl_link_invoice`).

**Wo:** Sub-Account → **Apps → Buchhaltung** (auch im Integrationskatalog als *Lexware Office (Live-Sync)* / *sevDesk (Live-Sync)*). Ein Programm je Sub-Account.

**Verbinden:**

| Programm | Was du einträgst | Wo du es bekommst |
| --- | --- | --- |
| Lexware Office (früher lexoffice) | API-Schlüssel der Public API | Lexware Office → *Einstellungen → Erweiterungen → Public API* → Schlüssel anlegen (Tarif mit API-Zugang nötig) |
| sevDesk | API-Token | sevDesk → *Einstellungen → Benutzer* → dein Benutzer → *API-Token* |

Der Schlüssel wird versiegelt gespeichert (AES-256-GCM mit dem Server-Schlüssel) und nie an den Browser zurückgegeben – die Seite zeigt nur `…abcd`. **Verbindung testen** ruft `GET /v1/profile` (Lexware) bzw. `GET /SevUser` (sevDesk; der erste Benutzer wird Ansprechpartner auf sevDesk-Rechnungen, wenn du keinen festlegst) auf.

**Was passiert:**

1. Eine Rechnung oder Gutschrift wird **festgeschrieben** (von Hand, bei Zahlung, durch eine Stornorechnung, über Stripe, aus einem Angebot) – das Ereignis `invoice.finalised` legt sie in die Warteschlange. Ein Auftrag je Dokument und Programm: ein wiederholtes Ereignis, ein manuelles Übertragen oder ein Nachtrag erzeugt nie einen zweiten Auftrag.
2. Der **Kunde** wird im Programm gefunden oder angelegt: zuerst über die gespeicherte Verknüpfung, dann über die Kundennummer aus einem eigenen Kontaktfeld (Standard-Schlüssel `customer_number` – der Umzug-Import füllt es), dann über die E-Mail-Adresse, sonst als neuer Kunde (Firma mit Ansprechpartner oder Person; Rechnungsadresse, E-Mail, Telefon, USt-IdNr.). In Lexware kann stattdessen der *Sammelkunde* genutzt werden.
3. Das **Dokument**:
   - **Lexware Office:** ein Ausgangsbeleg (`POST /v1/vouchers`, Typ `salesinvoice` / `salescreditnote`) mit HyperLevels Nummer als Belegnummer, Rechnungs-, Leistungs- und Fälligkeitsdatum, einer Position je Steuersatz (netto, Steuer, Satz, Buchungskategorie – Standard *Einnahmen* `8f8664a8-fd86-11e1-a21f-0800200c9a66`), danach wird HyperLevels PDF angehängt (`POST /v1/vouchers/{id}/files`). Lexware bucht den Beleg, stellt aber keine zweite Rechnung aus. Eine Schlussrechnung wird ohne die abgezogenen Abschlagsrechnungen gebucht – die wurden schon einzeln gebucht.
   - **sevDesk:** eine Rechnung (`POST /Invoice/Factory/saveInvoice`) mit HyperLevels Nummer, allen Positionen (Nettopreise, Steuersatz, Einheit), der Steuerregel aus HyperLevels Steuerbehandlung (Regelbesteuerung → 1, Ausfuhr → 2, innergemeinschaftliche Lieferung → 3, steuerfrei § 4 → 4, Reverse Charge → 5, Kleinunternehmer § 19 → 11; das ältere `taxType` wird mitgeschickt), Rechnungsart `RE`/`TR`/`ER`, danach *als versendet markiert* (`PUT /Invoice/{id}/sendBy` mit `VPDF` – es wird nichts gemailt). Gutschriften und Stornorechnungen werden zu sevDesk-Gutschriften (`POST /CreditNote/Factory/saveCreditNote`) mit HyperLevels Nummer.
4. Die ID im Programm wird in **`invoice_links`** gespeichert (Anbieter `lexware` / `sevdesk`) – die Rechnungsliste zeigt das Abzeichen, `ghl_list_invoices` gibt sie zurück.
5. Alle zwei Stunden (und mit **Zahlungen abgleichen**) fragt HyperLevel das Programm nach **offenen verknüpften Rechnungen** (Lexware `GET /v1/payments/{id}`, sevDesk `GET /Invoice/{id}`). Was dort mehr eingegangen ist, als HyperLevel kennt, wird über den normalen Zahlungsweg erfasst (`recordPayment`, Quelle `lexware` / `sevdesk`, Datum aus dem Programm): die Rechnung wird *bezahlt* oder *teilweise bezahlt*, `invoice.paid` startet Workflows, die Buchhaltung und – falls eingeschaltet – die Google-Ads-Offline-Conversion.

**Nie doppelt:** neben dem einen Auftrag je Dokument wird die ID im Programm gespeichert, sobald es sie gibt (und der Auftrag merkt sich, wie weit er kam – angelegt, PDF angehängt, als versendet markiert); ein neuer Versuch macht dort weiter, statt von vorn zu beginnen. Bevor etwas angelegt wird, sucht HyperLevel im Programm nach einem Dokument mit derselben Nummer (`GET /v1/vouchers?voucherNumber=`, `GET /Invoice?invoiceNumber=`) und verknüpft es stattdessen – das deckt auch einen Lauf ab, der zwischen „angelegt“ und „gespeichert“ abbrach. Eine Rechnung, die schon mit einem anderen Anbieter (z. B. Norman) verknüpft ist, wird übersprungen.

**Grenzen und Fehler:** Lexware erlaubt zwei Anfragen pro Sekunde und Schlüssel; HyperLevel taktet jeden Aufruf eines Schlüssels entsprechend (sevDesk: vier pro Sekunde). Bei `429` wird `Retry-After` abgewartet, `5xx` und abgebrochene Verbindungen werden innerhalb eines Laufs dreimal mit Wartezeit wiederholt; danach folgt ein neuer Versuch nach 1 min, 5 min, 15 min, 1 h, 3 h, 6 h und 12 h, dann stoppt der Auftrag. Ein abgelehnter Schlüssel (`401/403`) oder ein vom Programm abgewiesenes Dokument (`400/406/422`) stoppt sofort. Alles landet im **Protokoll** auf der Seite; gestoppte Aufträge haben **Erneut versuchen**, und der Katalogeintrag wird gelb, solange ein Auftrag scheitert.

**Ältere Rechnungen:** **Ältere Rechnungen übertragen** stellt festgeschriebene Rechnungen ab einem Datum in die Warteschlange, die noch nirgends verknüpft sind (200 pro Klick).

**Optionen (Zuordnung):** Kundenzuordnung (finden oder anlegen / Lexware-Sammelkunde), eigenes Feld mit der Kundennummer, Gutschriften an/aus, Zahlungsabgleich an/aus, Lexware: PDF anhängen, Buchungskategorie; sevDesk: als versendet markieren, Ansprechpartner (SevUser-ID), Einheit-ID. *Automatisch übertragen* aus pausiert den Abgleich, ohne den Schlüssel zu vergessen.

**(Noch) nicht enthalten:** in HyperLevel erfasste Zahlungen gehen nicht an das Programm (dort buchen oder den Bankimport machen lassen); im Programm abgezogenes Skonto lässt den Rest in HyperLevel offen; Änderungen oder Löschungen im Programm kommen nicht zurück; ein Programm je Sub-Account. Die Anbindung folgt der öffentlichen API-Dokumentation beider Programme und ist gegen Attrappen getestet – prüfe zuerst eine Rechnung, eine Gutschrift und eine Zahlung mit einem echten Konto (besonders die sevDesk-E-Mail-Suche `GET /CommunicationWay`, die Gutschrift-Felder und die Lexware-Buchungskategorien für Reverse Charge / steuerfreie Umsätze).

API (Sub-Account, Bereich *Einstellungen*): `GET /api/books-sync` (Anbieter, Optionen, Status, Zähler – kein Schlüssel), `PUT /api/books-sync` `{provider: lexware|sevdesk, api_key?, enabled?, options?: {contact_match: auto|collective, customer_number_field, push_credit_notes, pull_payments, attach_pdf, category_id, mark_sent, sev_user_id, unity_id}}`, `DELETE /api/books-sync`, `POST /api/books-sync/test`, `GET /api/books-sync/jobs?status=`, `GET /api/books-sync/log`, `POST /api/books-sync/jobs/:id/retry`, `POST /api/books-sync/invoices/:id/push`, `POST /api/books-sync/backfill` `{since: YYYY-MM-DD}`, `POST /api/books-sync/pull`. Code: `server/modules/books-sync.ts` (Warteschlange, Hooks, Routen), `server/services/books-sync-model.ts` (Nutzdaten, Taktung, Wartezeiten), `server/services/books-sync-http.ts` (Clients; Test-Hooks `app.services.booksSyncFetch` / `booksSyncSleep`).

## OpenAPI & API-Referenz

- `GET /api/openapi.json` – OpenAPI 3.1 der öffentlichen REST-API und der REST-Hooks (inkl. `webhooks`-Abschnitt für die Zustellungen), z. B. für Postman, Insomnia, n8n oder Code-Generatoren.
- `GET /api/docs.html` – Referenz als Webseite, von uns gerendert (kein CDN, kein Skript). `/api/docs` selbst ist schon die Dokumente-API der Projekte, deshalb `.html`.

Beides wird aus einem handgeschriebenen Routen-Katalog erzeugt (`server/services/openapi.ts`); ein Test prüft, dass jeder dokumentierte Pfad im Router existiert.
