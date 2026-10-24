[English](social-planner.md) · **Deutsch**

# Social Planner: Kunden-Freigabe und Evergreen-Kategorien

Der Social Planner plant Posts für die Kanäle eines Sub-Accounts über eine selbst gehostete Postiz-Instanz (Einrichten unter *Agentur → Integrationen*, siehe [self-hosting.md](self-hosting.md) und [api.md](api.md)). Diese Seite beschreibt zwei Erweiterungen: die **Freigabe durch Kunden per Link** und **Evergreen-Kategorien**.

## Freigabe durch Kunden (Magic-Link)

*Social Planner → Freigaben → Zur Freigabe schicken*: Kanäle wählen, einen oder mehrere Posts (bis 30) mit geplantem Zeitpunkt schreiben, unter *Weitere Felder* einen Titel für den Kunden – *Link erstellen* liefert **einen Link für alle Posts**. Der Kunde braucht kein Login: er sieht jeden Post mit Text, Bildern und Termin und klickt **Freigeben**, **Änderung wünschen** (mit Anmerkung) oder **Ablehnen**.

- **Freigegeben** → der Post wird sofort über den Social Planner eingeplant (liegt der Termin schon zurück, als Entwurf in Postiz). Klappt das nicht (Planner nicht verbunden, Kanal entfernt), bleibt er *Freigegeben* mit dem Grund, und *Einplanen* holt es nach.
- **Änderung gewünscht** → die Anmerkung steht in der Liste; der Kunde kann denselben Post später noch freigeben.
- Links gelten **30 Tage**; gespeichert wird nur ein Hash des Links. Jede Entscheidung löst das Ereignis `social.approval` aus (für Workflows und Webhooks).
- API: `GET|POST /api/social-approvals` (`{title?, posts: [{content, integration_ids, date?, upload_ids?}]}` → `{url, expires_at, approvals}`), `POST /api/social-approvals/:id/schedule`, `DELETE /api/social-approvals/:id`; Kundenseite `GET /social-review/:token`. MCP: `ghl_social_approval_list`, `ghl_social_approval_create` (gibt die URL zurück, verschickt nichts).

## Evergreen-Kategorien

*Social Planner → Evergreen*: eine Kategorie (z. B. „Tipps“, „Kundenstimmen“) sammelt **wiederverwendbare Posts** und hat einen **Wochenplan** (z. B. Di 09:00, Do 17:00, in der Zeitzone des Sub-Accounts) und Kanäle. Mit *Automatisch posten* erscheint zu jedem Termin der Post, der **am seltensten** verwendet wurde (bei Gleichstand der älteste). *Nächsten jetzt posten* veröffentlicht sofort.

- *Weitere Felder*: **Wiederverwenden** (Standard an) – sind alle Posts einmal erschienen, geht es von vorn los; aus: die Kategorie **pausiert**, wenn nichts Unbenutztes übrig ist. Dort stehen auch die nächsten Termine mit dem jeweiligen Post und *Kategorie löschen*.
- Jeder Lauf wird protokolliert (letzte 50); ein Fehler (z. B. Planner nicht verbunden) steht an der Kategorie, der nächste Termin läuft trotzdem.
- API: `GET|POST /api/social-queues`, `PATCH|DELETE /api/social-queues/:id` (`{name, integration_ids, slots: [{day: mon…sun, time: "HH:MM"}], recycle, active}`), `POST /api/social-queues/:id/items` (`{content}` oder `{items: [...]}`), `PATCH|DELETE /api/social-queues/:id/items/:item`, `GET /api/social-queues/:id/preview`, `POST /api/social-queues/:id/run`. MCP: `ghl_social_queues`, `ghl_social_queue_add`.

## Für Entwickler

`server/modules/social-approval.ts` (Tabellen `social_approval_links`, `social_approvals`) und `server/modules/social-queues.ts` (Tabellen `social_queues`, `social_queue_items`, `social_queue_runs`; Zeitplan rein in `cleanSlots`/`nextSlot`, Scheduler über `app.onTick`, Haken `app.services.socialQueues.run`) posten beide über `app.services.socialPost` aus `modules/social.ts` – eine Registry-Zeile `...gapsSitesModules`. Oberfläche: `web/src/pages/SocialExtras.tsx` (eigener Chunk). Tests: `tests/gaps-sites-marketing.test.ts` (mit einer Fake-Postiz).
