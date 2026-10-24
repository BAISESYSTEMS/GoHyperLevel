[English](ai-assistant.md) · **Deutsch**

# KI-Assistent (Conversation AI)

Jeder Sub-Account kann einen eigenen KI-Assistenten auf Basis von **Claude** (Anthropic) oder **OpenAI** (GPT) bekommen ([AI provider](#ai-provider-anthropic-or-openai)). Er schreibt Antwortvorschläge und Zusammenfassungen im Posteingang, beantwortet auf Wunsch den Website-Chat selbst, legt Antwort-Entwürfe für eingehende E-Mails an und steht in Workflows und über MCP zur Verfügung. Die Kosten laufen über das Anthropic-Konto des Kunden (eigener API-Schlüssel) und sind pro Monat gedeckelt.

## Einrichten

1. In der [Anthropic Console](https://console.anthropic.com/settings/keys) unter **API Keys** einen Schlüssel erzeugen (beginnt mit `sk-ant-`). Guthaben bzw. Zahlungsmethode im Anthropic-Konto hinterlegen.
2. **Einstellungen → KI-Assistent → Einrichtung:** Schlüssel einfügen, **Verbindung testen** (prüft den Schlüssel über die Models-API, kostet keine Tokens), Haken **KI-Assistent einschalten**, speichern.
3. Modell wählen: **Claude Sonnet 5.5** (Standard, schnell und günstig), **Claude Opus 5.5** (am stärksten, teurer) oder **Claude Haiku 4.5** (am günstigsten).
4. **Tonfall & Persona** und **Fakten zum Unternehmen** ausfüllen.
5. **Wissen:** Fragen & Antworten und Freitext pflegen. Optional werden der **Projekt-Steckbrief** (Kurzbeschreibung, Beschreibung, Ziele, Website – keine Notizen, Server oder Repos) und die **FAQ-Blöcke** aus Funnels & Websites dieses Sub-Accounts mitgeschickt.
6. **Nutzung & Limit:** Monatslimit in US-Dollar (Standard 20 $) und optional ein Token-Limit.

Der Schlüssel wird verschlüsselt gespeichert (AES-256-GCM mit dem Server-Geheimnis) und nie wieder an den Browser geschickt; angezeigt werden nur die letzten vier Zeichen. Alternativ kann die Agentur einen Schlüssel für alle Sub-Accounts in der Umgebung setzen: `PGHL_ANTHROPIC_API_KEY` (gilt, wenn ein Sub-Account keinen eigenen hat; das Monatslimit gilt trotzdem je Sub-Account).

<a id="ai-provider-anthropic-or-openai"></a>

## KI-Anbieter: Anthropic oder OpenAI

Der Assistent läuft auf **Claude** (Anthropic, Standard) oder **OpenAI** (GPT, über die Responses API) – je Sub-Account, mit einem Standard der Agentur.

- **Einstellungen → KI-Assistent → Einrichtung → KI-Anbieter:** „Wie die Agentur“ (Standard der Agentur übernehmen), „Anthropic (Claude)“ oder „OpenAI (GPT)“. Bei OpenAI trägst du einen OpenAI-API-Schlüssel ein (aus [platform.openai.com → API keys](https://platform.openai.com/api-keys), beginnt mit `sk-`), wählst ein Modell und klickst **OpenAI testen** (prüft den Schlüssel über die Models-API, kostet keine Tokens). Die Felder für Anthropic-Schlüssel und -Modell treten zurück, solange OpenAI gewählt ist.
- **Modelle:** GPT-5 mini (Standard, schnell und günstig), GPT-5.1 (am stärksten), GPT-5 nano (am günstigsten), GPT-4.1 mini (ohne Denken, sehr schnell – gut für Chat und Telefon) – oder jede andere Modell-ID als Freitext (auch feinabgestimmte wie `ft:gpt-4.1-mini:org::id`). Denkmodelle laufen mit der **Denkstufe** ihrer Fähigkeit (Standard `xhigh`, auf das gesenkt, was das Modell annimmt; *Einstellungen → KI-Anbieter → Denkstufe*, siehe [docs/werkstatt.md](werkstatt.md#denkstufe-reasoning-effort)) – kurze Texte und den Telefonagenten stellst du niedriger, um Kosten und Zeit zu sparen.
- **Standard der Agentur (Agentur → KI-Werkzeuge → KI-Anbieter):** Anbieter, Modell und optional ein OpenAI-Schlüssel der Agentur, den jeder Sub-Account ohne eigene Wahl bzw. eigenen Schlüssel benutzt. Reihenfolge der Schlüssel bei OpenAI: Schlüssel des Sub-Accounts → Schlüssel der Agentur → `PGHL_OPENAI_API_KEY` in der Server-Umgebung.
- **Alles nutzt den gewählten Anbieter:** Antwortvorschläge, Zusammenfassungen, der Chat-Bot, E-Mail-Entwürfe, die Workflow-Aktion „KI-Text erzeugen“, der Telefonagent, Video-Recycling und Diktat in der App (`app.services.aiRun` kennt keinen bestimmten Anbieter). JSON-Antworten (Zusammenfassungen, Chat-Bot, Telefonagent, Recycling, Diktat) nutzen bei OpenAI **Structured Outputs** (`text.format: json_schema`, streng, wenn das Schema es erlaubt) – das Auslesen funktioniert also bei beiden gleich.
- **Limit und Protokoll bleiben je Sub-Account:** das Monatslimit, das Limit des SaaS-Tarifs und das Protokoll unter **Nutzung & Limit** zählen auch OpenAI-Aufrufe, bepreist mit den Listenpreisen von OpenAI (zwischengespeicherte Eingaben sind günstiger; unbekannte Modelle werden vorsichtig wie ein teures gerechnet). Anfragen gehen mit `store: false` raus.
- Schlüssel werden wie der Anthropic-Schlüssel verschlüsselt gespeichert (AES-256-GCM) und nie an den Browser zurückgeschickt (nur die letzten vier Zeichen).

## Im Posteingang (Konversationen)

- **Antwort vorschlagen** (neben den Kanal-Reitern, auch auf der Kontaktseite): schreibt einen Entwurf für den gewählten Kanal (E-Mail mit Anrede und Gruß, SMS kurz, Chat locker) in das Textfeld. Optional ein Hinweis an die KI, z. B. „Termin am Dienstag anbieten“. Gesendet wird erst, wenn du auf **Senden** klickst.
- **Seitenleiste KI-Assistent:** **Zusammenfassen** (2–4 Sätze plus nächster Schritt, bleibt gespeichert), Status des Chat-Bots in diesem Gespräch (aktiv / an Team übergeben mit Grund / pausiert) mit **Bot pausieren** bzw. **Bot wieder übernehmen lassen**, Links zu vom Bot angelegter Opportunity/Aufgabe.
- Nachrichten des Bots und KI-Entwürfe sind lila markiert („KI-Assistent“ / „KI-Entwurf“).

Mitgeschickt werden: Kontaktdaten (Name, E-Mail, Telefon, Firma, Ort, Tags, eigene Felder), offene Opportunities, die letzten 20 Nachrichten der Konversation, das Wissen und die aktuelle Uhrzeit mit Geschäftszeiten-Status.

## Live-Chat-Bot

**Einstellungen → KI-Assistent → Live-Chat-Bot** (der Live-Chat selbst muss unter Einstellungen → Live-Chat an sein):

| Modus | Verhalten |
| --- | --- |
| Aus | Der Bot antwortet nie; nur Vorschläge für das Team |
| Außerhalb der Geschäftszeiten | Antwortet nur außerhalb der eingetragenen Geschäftszeiten (Zeitzone des Sub-Accounts); gleiche Uhrzeit bei „von“ und „bis“ = rund um die Uhr |
| Immer | Antwortet auf jede Chat-Nachricht |

Bot-Antworten beginnen im Chat mit 🤖; fragt jemand, sagt der Bot ehrlich, dass er eine KI ist. Er nutzt nur das hinterlegte Wissen und erfindet keine Preise oder Zusagen.

**Was der Bot über den Besucher weiß:** nur diesen Chat (ab dem Start des Besuchers) und den Namen. E-Mails, SMS und andere Nachrichten des Kontakts, gespeicherte Telefonnummer, Adresse oder Opportunities bekommt er nicht – wer im Chat eine bekannte E-Mail-Adresse eintippt, hat damit noch nicht bewiesen, dass er diese Person ist ([Sicherheitsprüfung, O-2](security-review-2026-10.md#follow-up-fixes-after-0041)). Die Vorschläge für das Team im Posteingang sehen weiterhin den ganzen Verlauf.

**Übergabe an das Team** – der Bot schreibt den Übergabe-Text, schweigt danach in diesem Gespräch, schickt eine E-Mail an die Firmen-E-Mail (Einstellungen → Firma) und löst den Workflow-Auslöser **„KI-Assistent übergibt an Team“** aus, wenn

- der Besucher einen Menschen verlangt („mit einem Mitarbeiter sprechen“, „ruft mich zurück“, „talk to a human“ …),
- ein Stichwort fällt (Standard: Beschwerde, Reklamation, Anwalt, Kündigung, Datenschutz – frei änderbar),
- die KI selbst übergeben will oder unsicher ist (Mindest-Sicherheit, Standard 60 %),
- die Höchstzahl an Bot-Antworten pro Gespräch erreicht ist (Standard 8),
- die KI nicht erreichbar ist, eine unbrauchbare Antwort liefert oder das Monatslimit erreicht ist.

Schreibt jemand aus dem Team selbst im Gespräch, hält sich der Bot zwei Stunden lang heraus. Höchstens 120 Bot-Antworten pro Stunde und Sub-Account.

**Leads:** Fehlen Name oder E-Mail, fragt der Bot (wenn eingeschaltet) danach und ergänzt den Kontakt – nur leere Felder, keine E-Mail-Adresse, die schon ein anderer Kontakt hat. Bei Kaufinteresse legt er auf Wunsch einmal pro Gespräch eine **Opportunity** (gewählte Pipeline/Stufe) und eine **Aufgabe** „Chat-Lead nachfassen“ an und benachrichtigt das Team.

### Termine buchen

**KI-Assistent → Live-Chat-Bot → Termine buchen:** Ist „Website-Chat-Bot darf Termine buchen“ an, bekommt der Bot die freien Zeiten der nächsten zwei Wochen der freigegebenen Kalender (dieselben Regeln wie Buchungsseite und KI-Telefonagent), kann einen Tag nachsehen und bucht, sobald der Besucher eine Zeit bestätigt und Vor- und Nachname sowie E-Mail (oder Telefon) genannt hat. Die Antwort enthält die Bestätigung mit Links zum **Verschieben** und **Absagen**; die Bestätigungs-E-Mail und die Erinnerungen des Kalenders kommen wie bei jeder Buchung. Kostenpflichtige Kalender und solche mit Pflichtfragen bucht der Bot nie, höchstens zwei Buchungen je Kontakt und Tag (einstellbar bis 10). Welche Kalender die KI buchen darf, gilt auch für KI-Agenten mit der Sicherheitsstufe „Termin buchen“ und für MCP – Details in [booking.md](booking.md#ai-books-appointments).

Technisch hängt dann am JSON-Objekt der Antwort ein Feld `booking` (`action`: `none`, `check_slots` oder `book`, dazu `calendar_id`, `date`, `time`); nach einem Nachsehen fragt der Server das Modell mit dem Ergebnis erneut (höchstens drei Aufrufe je Nachricht), eine gebuchte Zeit hängt er selbst an die Antwort an.

Technisch antwortet das Modell bei jeder Chat-Nachricht mit einem festen JSON-Objekt (`reply`, `confidence`, `handoff`, `handoff_reason`, `lead {first_name, last_name, email, phone}`, `buying_intent`, `intent_summary`). Die API erzwingt das Schema (Structured Outputs), der Server prüft es zusätzlich streng: unbekannte oder fehlende Felder, falsche Typen, ungültige E-Mail/Telefonnummer → keine Antwort, sondern Übergabe.

## E-Mail-Entwürfe

Mit **„Für eingehende E-Mails einen Antwort-Entwurf anlegen“** entsteht zu jeder per Webhook eingehenden E-Mail ein Entwurf in der Konversation (höchstens 30 pro Stunde). E-Mails werden **nie automatisch gesendet** – Entwurf prüfen, dann **Senden** oder **Verwerfen**. Per IMAP-Sync oder Import übernommene Mails lösen keine Entwürfe aus.

## Workflow-Aktion „KI-Text erzeugen“

Ein Auftrag mit Platzhaltern (`{{contact.first_name}}`, `{{contact.custom.<feld>}}` …); Kontaktdaten und die letzten 10 Nachrichten gehen automatisch mit. Ergebnis wahlweise

- in ein Feld (eigene Felder oder Firma/Ort/Land/Website/Quelle) – danach z. B. in E-Mails mit `{{contact.custom.<feld>}}` nutzen,
- als E-Mail-Entwurf in der Konversation (wird nicht gesendet),
- als Notiz.

Fehler (z. B. Limit erreicht) stehen im Protokoll des Workflow-Laufs.

## KI-Telefonagent

Auch am Telefon antwortet dieser Assistent: **Einstellungen → Telefonie → KI-Telefonagent** (Twilio nötig). Er nutzt Wissen, Modell und Monatslimit von hier, bucht Termine, nimmt Nachrichten auf und verbindet weiter; jede Gesprächsrunde und die Zusammenfassung erscheinen unter **Nutzung & Limit** als „KI-Telefonagent“. Ist das Limit erreicht oder der Assistent aus, nimmt der Agent nicht ab und die normale Telefonie (Weiterleitung/Voicemail) greift. Einrichtung und Ablauf: [self-hosting.md](self-hosting.de.md#ki-telefonagent).

## Prompt-Optimierer

*KI-Agenten → Prompt-Tests* (mit dem Bereich *Einstellungen*): Testfälle für die Anweisungen eines **KI-Agenten**, des **KI-Telefonagenten** (Persona + Anweisungen) oder eines **eigenen Prompts** – je Fall eine typische Kundennachricht und was eine gute Antwort tun muss („sagt, dass das Erstgespräch kostenlos ist“, „erfindet keine Öffnungszeiten“).

- **Jetzt testen:** Das Modell beantwortet jeden Fall mit den aktuellen Anweisungen, ein zweiter, strenger Aufruf bewertet die Antwort (bestanden ja/nein, 0–10 Punkte, Begründung). Das Ergebnis bleibt gespeichert, damit derselbe Test nach jeder Änderung wieder läuft. Jeder Fall kostet zwei KI-Aufrufe (Zweck `prompt_lab` im Protokoll, gleiches Monatslimit); höchstens 10 Fälle je Test.
- **Verbesserung vorschlagen:** Aus den nicht bestandenen Fällen schlägt die KI überarbeitete Anweisungen mit einer Liste der Änderungen vor (erfundene Fakten werden durch Platzhalter wie `[PREIS]` ersetzt). Nichts ändert sich, bis du den Vorschlag prüfst und **Übernehmen** klickst – das läuft über die Route des Agenten bzw. des Telefonagenten (Protokoll, Rückgängig).
- API: `GET|POST /api/prompt-lab`, `PATCH|DELETE /api/prompt-lab/:id`, `POST /api/prompt-lab/:id/run` (optional `{prompt}` = Entwurf testen, ohne zu speichern), `POST …/improve`, `POST …/apply` `{instructions}`. MCP: `ghl_prompt_tests`, `ghl_prompt_test_run`. Modul `server/modules/prompt-lab.ts`.
- Nur KI-Agenten, die du auch unter *KI-Agenten* siehst: Den privaten Agenten einer Kollegin (und Tests darauf) sieht niemand sonst – auch kein Admin; ein Sub-Account-API-Schlüssel nur die geteilten Agenten.

## MCP

Werkzeug `ghl_ai_suggest_reply` (`conversation_id` oder `contact_id`, optional `channel`, `instruction`, mit Agentur-Schlüssel `location_id`): liefert `{text, subject, channel}` – sendet nichts und zählt aufs Monatslimit.

## Kosten, Protokoll und Sicherheit

- **Jeder Aufruf wird protokolliert** (Zweck, Modell, Eingabe-/Ausgabe-/Cache-Tokens, Kosten, Dauer, Fehler) – **Nutzung & Limit** zeigt die Monatssumme, eine Aufstellung nach Zweck und die letzten Aufrufe. Kosten werden nach Anthropic-Listenpreisen geschätzt; maßgeblich ist die Abrechnung bei Anthropic.
- **Monatslimit:** Ist es erreicht, lehnt der Assistent weitere Aufrufe ab (Meldung im Posteingang, im Workflow-Protokoll; der Chat-Bot übergibt ans Team).
- **Prompt-Caching:** Die festen Regeln und das Wissen stehen vorne im System-Prompt und werden zwischengespeichert; wiederholte Anfragen zahlen dafür nur einen Bruchteil (sichtbar als „davon aus Cache“).
- **Geheimnisse:** Vor dem Senden werden API-Schlüssel, Tokens, Passwörter („Passwort: …“), Kartennummern und IBANs aus allen Texten entfernt; eigene Felder mit Namen wie `passwort`, `token`, `iban`, `zugang` werden gar nicht mitgeschickt.
- **Fehler** von Anthropic (ungültiger Schlüssel, Rate-Limit, Überlastung, abgelehnte Anfrage) erscheinen als deutsche Meldung; bei Überlastung wird einmal wiederholt.
- Für Sonnet 5.5 und Opus 5.5 ist der serverseitige Fallback von Anthropic bei Sicherheits-Ablehnungen eingeschaltet (`fallbacks: "default"`, Beta `server-side-fallback-2026-07-01`); kennt das Konto die Beta nicht, wird ohne sie wiederholt.

## API

| Methode | Pfad | Bereich | Zweck |
| --- | --- | --- | --- |
| GET | `/api/ai/status` | alle | `{enabled, bot_mode, assistant_name}` |
| GET/PUT | `/api/ai/settings` | Einstellungen | Einstellungen lesen/speichern (`api_key` zum Setzen, `api_key: null` zum Entfernen) |
| POST | `/api/ai/test` | Einstellungen | Schlüssel prüfen (`{api_key?, model?}`) |
| GET/PUT | `/api/ai/provider` | Einstellungen | AI provider `{provider: "" \| anthropic \| openai, openai_model, openai_key}` (key never returned) |
| POST | `/api/ai/provider/test` | Einstellungen | Check the OpenAI key (`{openai_key?, model?}`) |
| GET/PUT | `/api/agency/ai-provider` | Admin | Agency default provider, model and OpenAI key |
| GET | `/api/ai/usage?limit=` | Einstellungen | Monatssumme, nach Zweck, letzte Aufrufe |
| GET/PUT | `/api/ai-booking/settings` | Einstellungen | Termine buchen: `{chat_bot, calendars, per_contact_day}` plus die Kalender mit `bookable` ([booking.md](booking.md#ai-books-appointments)) |
| POST | `/api/ai/suggest` | Konversationen | `{conversation_id \| contact_id, channel?, instruction?}` → `{text, subject, channel}` |
| POST | `/api/ai/summarize` | Konversationen | `{conversation_id}` → `{summary, next_step}` |
| GET/PATCH | `/api/ai/conversations/:id` | Konversationen | Bot-Status und Zusammenfassung; PATCH `{bot_status: active \| paused}` |
