# HyperLevel für n8n (Workflow-Vorlagen)

Importierbare Workflows nur mit Bordmitteln von n8n (Webhook-, HTTP-Request- und Manual-Trigger-Knoten) – keine Community-Nodes nötig.

| Datei | Was sie macht |
| --- | --- |
| `01-ereignisse-abonnieren.json` | Einmal ausführen: registriert die URL eines n8n-Webhooks als REST-Hook (`POST /api/hooks`) |
| `02-ereignisse-empfangen.json` | Webhook nimmt jede Zustellung an und schreibt eine Notiz an den Kontakt zurück |
| `03-formular-zu-deal.json` | Formular eingereicht → Opportunity in „Vertrieb / Neuer Lead“ |
| `04-deal-gewonnen-rechnung.json` | Deal gewonnen → Rechnungsentwurf (netto = Deal-Wert) + Aufgabe „Rechnung prüfen“ |
| `05-externer-lead.json` | Lead aus beliebigem Tool → Kontakt anlegen/zusammenführen + Nachricht als Notiz |
| `06-verpasster-anruf-aufgabe.json` | Anruf verpasst → Rückruf-Aufgabe in 2 Stunden + SMS an den Anrufer |

## Einrichten

1. In HyperLevel unter **Einstellungen → API & Webhooks** einen API-Schlüssel anlegen (`pghl_…`).
2. In n8n: **Credentials → New → Header Auth**, Name „HyperLevel API“, Header-Name `Authorization`, Wert `Bearer pghl_…`.
3. **Workflows → Import from File** und eine Vorlage wählen; in den HTTP-Request-Knoten `https://DEINE-DOMAIN` durch deine Adresse ersetzen und die Zugangsdaten „HyperLevel API“ wählen.
4. Empfangende Workflows (02–06) aktivieren und die **Production URL** des Webhook-Knotens kopieren.
5. Vorlage 01 öffnen, `target_url` (diese URL) und `event` (z. B. `form.submitted`, `opportunity.won`, `call.missed` – Liste: `GET /api/hooks/triggers`) eintragen, einmal ausführen. Das Abo erscheint in HyperLevel mit der Quelle „n8n“.

Abbestellen: `DELETE /api/hooks/<id>` (ID aus der Antwort von Vorlage 01) oder in HyperLevel im Zustell-Protokoll löschen. Wer die Signatur prüfen will: `x-pghl-signature` = SHA-256 von `secret + body` (Secret aus der Antwort von `POST /api/hooks`), z. B. in einem Code-Knoten.

Tipp: n8n kann auch die OpenAPI-Beschreibung `https://DEINE-DOMAIN/api/openapi.json` lesen (HTTP-Request-Knoten → „Import cURL“ bzw. in Tools wie Postman).
