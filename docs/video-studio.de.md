[English](video-studio.md) · **Deutsch**

# Video-Studio (OpenShorts)

Aus einem langen Video (Podcast, Webinar, Interview, Livestream) werden KI-gewählte 9:16-Shorts mit Untertiteln und Hook-Text. Im Sub-Account unter **Marketing → Video-Studio**: Link einfügen oder Datei hochladen, Clips prüfen und anpassen, dann direkt im **Social Planner** (Postiz) auf den Kanälen dieses Sub-Accounts einplanen.

Das Schneiden übernimmt [OpenShorts](https://github.com/mutonby/openshorts) (MIT): Whisper-Transkription, Gemini (oder ein eigenes LLM) sucht die Momente, Gesichts-Tracking und Layouts für 9:16, eingebrannte Untertitel. HyperLevel enthält keinen OpenShorts-Code, sondern spricht dessen REST-API an – mit einer **selbst gehosteten Instanz** neben HyperLevel oder der **gehosteten API** von openshorts.app.

## Einrichten

### A) Selbst gehostet neben HyperLevel

Am einfachsten mit dem Profil im [`docker-compose.yml`](../docker-compose.yml) von HyperLevel – gleiches Netz, nichts weiter einzutragen: `docker compose --profile openshorts up -d` (Variablen `GEMINI_API_KEY`, `OPENSHORTS_CPUS` … in `.env`). Alternativ als eigenes Compose-Projekt – die Vorlage liegt in [`deploy/openshorts/docker-compose.yml`](../deploy/openshorts/docker-compose.yml) und wird von nichts automatisch gestartet:

```bash
cd deploy/openshorts
cp .env.example .env        # GEMINI_API_KEY oder LLM_BASE_URL eintragen, GOHIGH_NETWORK prüfen
docker network ls           # Netz von HyperLevel, z. B. gohigh_default
docker compose up -d --build
```

- **CPU-Image**, ein Job gleichzeitig (`MAX_CONCURRENT_JOBS=1`), harte Grenzen (Standard 3 CPUs, 6 GB RAM) und niedrigere CPU-Priorität als das CRM – ein langes Video bremst HyperLevel nicht aus.
- **Kein offener Port:** selbst gehostetes OpenShorts hat keine Anmeldung. Es hängt nur im Docker-Netz von HyperLevel und ist dort als `http://openshorts:8000` erreichbar.
- **Dauer:** etwa 5–8 Minuten je 8 Minuten Video auf der CPU (mit NVIDIA-GPU etwa 1 Minute, siehe OpenShorts-README).
- **Speicher:** Image ca. 4 GB, Modelle ca. 1 GB (Volume `openshorts-models`), je Stunde 1080p-Quelle ca. 1–2 GB plus 20–60 MB je Clip. `OUTPUT_MAX_GB`/`UPLOADS_MAX_GB` begrenzen die Arbeitsordner; alte Jobs fliegen zuerst raus.
- **Aufbewahrung:** HyperLevel speichert keine Videos, sondern streamt die Clips aus OpenShorts. Die Vorlage hält Jobs 7 Tage (`JOB_RETENTION_SECONDS=604800`, OpenShorts-Standard sind 24 Stunden). Eingeplante Posts sind sicher: Postiz holt sich das Video beim Einplanen.
- **Server:** mit HyperLevel zusammen mindestens 4 CPU-Kerne und 8 GB RAM.

Umgebung von OpenShorts (`.env`):

| Variable | Wofür |
| --- | --- |
| `GEMINI_API_KEY` | Sucht die Momente (kostenlos bei [Google AI Studio](https://aistudio.google.com/app/apikey)); außerdem automatisches Layout, stumme Videos, YouTube-Studio und KI-Shorts |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | Statt Gemini ein OpenAI-kompatibler Server (Ollama, vLLM, OpenRouter …). Auch Anthropic bietet eine OpenAI-kompatible Schnittstelle: `LLM_BASE_URL=https://api.anthropic.com/v1`, `LLM_MODEL=claude-haiku-4-5`, `LLM_API_KEY=sk-ant-…`. Automatisches Layout und stumme Videos brauchen weiter Gemini |
| `WHISPER_MODEL` | Transkription auf der CPU: `base` (schnell), `small` (Standard), `medium` (genauer, langsam) |
| `OPENSHORTS_CPUS`, `OPENSHORTS_MEMORY` | Ressourcen-Grenzen des Containers |
| `JOB_RETENTION_SECONDS`, `OUTPUT_MAX_GB`, `UPLOADS_MAX_GB` | Aufbewahrung und Platten-Grenzen |
| `YOUTUBE_COOKIES` | Optional, wenn YouTube Downloads des Servers blockt |

**Nicht nötig:** ein Upload-Post-Schlüssel – HyperLevel veröffentlicht über den eigenen Social Planner (Postiz).

### B) Gehostet auf openshorts.app

Auf [openshorts.app](https://www.openshorts.app/) ein Konto anlegen und unter *Account → API keys* einen Schlüssel (`osk_…`) erzeugen. In HyperLevel als Adresse `https://api.openshorts.app` und den Schlüssel eintragen. Gemini ist dort enthalten, die GPU schneidet ein 8-Minuten-Video in etwa einer Minute; der kostenlose Tarif hat 20 Minuten im Monat und ein Wasserzeichen, bezahlte Tarife nicht.

### In HyperLevel verbinden

**Agentur → Integrationen → Einrichtung → OpenShorts (Video-Studio):**

| Feld | Inhalt |
| --- | --- |
| Adresse | Selbst gehostet `http://openshorts:8000` (Backend, nicht das Dashboard auf Port 5175) · gehostet `https://api.openshorts.app` |
| API-Schlüssel | Nur gehostet: `osk_…` |
| ElevenLabs-Schlüssel (optional) | KI-Vertonung in andere Sprachen, Stimmen für KI-Shorts |
| fal.ai-Schlüssel (optional) | KI-Shorts (Darsteller, Lippensynchron-Video, B-Roll) |
| Max. Dateigröße, laufende Jobs je Sub-Account | Standard 2048 MB (Grenze von OpenShorts) und 3 |

„Speichern & testen“ prüft `/health`, erkennt selbst gehostet oder gehostet (`/api/config`), prüft den Schlüssel (`/api/me`, zeigt Tarif und Restminuten) und liest aus `/openapi.json`, was die Instanz kann (Uploads, YouTube-Studio, KI-Shorts, Vertonung …). Fehlt etwas, blendet das Video-Studio den Teil aus. Alle Schlüssel liegen verschlüsselt in HyperLevel und gehen nie an den Browser. Alternativ per Umgebung: `PGHL_OPENSHORTS_URL`, `PGHL_OPENSHORTS_KEY`.

**Wo welcher Schlüssel hingehört:** Gemini bzw. `LLM_*` stehen in der Umgebung von OpenShorts (selbst gehostet; gehostet ist Gemini enthalten). ElevenLabs und fal.ai nimmt OpenShorts nur pro Anfrage als Header an – auch auf openshorts.app (dort „BYOK“) –, deshalb trägt man sie in HyperLevel ein; HyperLevel schickt sie nur bei Vertonung und KI-Shorts mit.

| | Selbst gehostet | openshorts.app |
| --- | --- | --- |
| Anmeldung | keine – nur im internen Netz betreiben | `Authorization: Bearer osk_…` |
| Gemini | eigener Schlüssel oder `LLM_BASE_URL` in OpenShorts | enthalten |
| ElevenLabs, fal.ai | in HyperLevel (pro Anfrage) | in HyperLevel (pro Anfrage) |
| Tempo | 5–8 Min. je 8 Min. Video (CPU) | ca. 1 Min. (GPU) |
| Grenzen | keine | Minuten je Tarif, Wasserzeichen im Gratis-Tarif |
| Fortschritt | ausführliches Protokoll → feiner Fortschrittsbalken | gekürztes Protokoll → gröbere Stufen |

## Im Sub-Account

**Marketing → Video-Studio** (Recht „Social Planner“; im SaaS-Modus nur mit Tarifen, die den Social Planner enthalten).

1. **Neue Shorts:** YouTube-Link / direkte MP4-Adresse oder Datei (MP4, MOV, WebM, MKV, AVI). Dateien gehen in 8-MB-Teilen an HyperLevel (robust hinter Proxys, nie ganz im Speicher) und werden dann aus der Platte in den Upload-Platz von OpenShorts gestreamt; die Zwischendatei wird danach gelöscht. Älteren OpenShorts-Versionen ohne Upload-Platz gibt HyperLevel stattdessen einen kurzlebigen, signierten Download-Link.
2. **Optionen:**

| Option | Wirkung in OpenShorts |
| --- | --- |
| Anzahl Clips | `target_clips` (1–15; ein Ziel, keine Garantie) |
| Clip-Länge | `clip_min_seconds`/`clip_max_seconds` (Standard 15–60 s) |
| Layout | Automatisch → `layouts: ["auto"]` (KI wählt je Video) · Gesicht verfolgen → `["none"]` · Zwei Sprecher → `["split"]` · Bildschirm + Sprecher → `["screencast"]` · Ganzes Bild → danach je Clip `framing: "full"` |
| Untertitel | Standard → eingebrannt beim Rendern · andere Stile (Wort für Wort, Lila/Grüne Box, Ein Wort, Dezent) → danach je Clip `POST /api/subtitle` mit `preset` · Keine → `captions: false` |
| Hook-Text, Hook-Stil | `auto_hook`, `auto_hook_style` |
| Format | `output_format` (Hochkant, quadratisch, quer) |
| KI-Vertonung | danach je Clip `POST /api/translate` (ElevenLabs), anschließend Untertitel auf den vertonten Ton |
| Sprache | erkennt OpenShorts selbst (Whisper); Titel und Texte kommen in der Sprache des Videos |

3. **Fortschritt:** Jeder Job bekommt eine eigene Webhook-Adresse `https://<domain>/hooks/openshorts/<geheim>` mit eigenem Signatur-Schlüssel (`X-OpenShorts-Signature: sha256=…`, HMAC-SHA256 über den Rumpf). Zusätzlich fragt HyperLevel alle 20 s nach (mit Webhook alle 60 s) – ohne öffentliche https-Adresse nur per Abfrage. Fertige Clips erscheinen schon während des Schneidens. Hat eine YouTube-Quelle nur geringe Auflösung, fragt das Studio nach („Trotzdem verarbeiten“).
4. **Review:** Galerie mit Player (Clips werden mit Range-Anfragen aus OpenShorts durchgereicht), Viralitäts-Score 0–100 mit Begründung, KI-Titel, Beschreibung und Hashtags zum Bearbeiten, Herunterladen, Entfernen. **Nachbearbeiten:** Untertitel-Stil, Vertonung, Bildausschnitt (ganzes Bild / Person verfolgen) – läuft im Hintergrund in OpenShorts, der Clip wird danach ersetzt.
5. **In Social Planner einplanen:** Kanäle dieses Sub-Accounts (auch YouTube Shorts und TikTok, die sonst nur in Postiz gehen), Planen / sofort / Entwurf, Text vorbefüllt mit Beschreibung und Hashtags, YouTube-Titel. Postiz holt das Video über einen signierten Link (2 Stunden gültig) direkt bei HyperLevel ab – HyperLevel muss dafür per https erreichbar sein.
6. **Als Dokument im Projekt speichern:** legt unter *Projekt → Dokumente* einen Eintrag mit Link zum Clip, Beschreibung, Hashtags und Score an.

### YouTube-Studio (optional)

Für ein langes Video: Analyse (Download + Transkription in OpenShorts), 10 Titel-Ideen mit Empfehlung und Verfeinern per Wunsch („kürzer, mit Zahl“), Beschreibung mit Kapitelmarken, KI-Thumbnails (Gemini-Bildmodell) zum Herunterladen. Erscheint nur, wenn die Instanz die Endpunkte hat; Analyse und Thumbnails brauchen Gemini.

### KI-Shorts (optional)

Aus Produkt-Link oder Beschreibung schreibt OpenShorts Skripte (Hook – Problem – Lösung – CTA, derzeit Englisch oder Spanisch) und erzeugt auf Knopfdruck ein Video mit KI-Darsteller, Stimme, B-Roll und Untertiteln (günstig ca. 0,65 $, Premium ca. 2 $ bei fal.ai). Das fertige Video landet als Job mit einem Clip in der normalen Liste – gleiche Prüfung und Planung. Skripte brauchen Gemini, das Video zusätzlich fal.ai- und ElevenLabs-Schlüssel. Veröffentlichung in der öffentlichen OpenShorts-Galerie ist immer aus (`share_to_gallery: false`).

## Content-Recycling & Autopilot

### Recycling: „Aus diesem Video machen …“

Jeder fertige Job hat neben **Clips** den Tab **Recycling**. Der KI-Assistent (Einstellungen → KI-Assistent; jeder Inhalt ist ein KI-Aufruf und zählt aufs Monatslimit des Sub-Accounts) schreibt aus dem OpenShorts-Transkript und den besten Clips:

| Inhalt | Wird beim Klick auf **Übernehmen** … |
| --- | --- |
| Blog-Beitrag (Titel, Kurzbeschreibung, Markdown mit `##`-Abschnitten, SEO-Titel/-Beschreibung, Tags) | … ein **Entwurf** im Blog der gewählten Website. Das Video steht nach der Einleitung: bei YouTube-Quellen das YouTube-Video, sonst der beste Clip; Titelbild = YouTube-Vorschaubild. |
| Newsletter (Betreff, Vorschautext, Einleitung, 3 Kernaussagen, Button) | … ein **Kampagnen-Entwurf** im E-Mail-Designer: „Hallo {{contact.first_name\|du}},“, Video-Block, Kernaussagen, die besten Clips (mit Vorschaubild, sobald der Browser eines aufgenommen hat) und Fußzeile – an wen und wann, entscheidet ihr in der Kampagne. |
| LinkedIn-Beitrag, X-Thread, Instagram-Caption, Facebook-Beitrag | … ein **Entwurf im Social Planner** auf den passenden Kanälen des Sub-Accounts (in Postiz freigeben). Der X-Thread geht als Thread (Antworten), Instagram bekommt den besten Clip als Reel. |
| YouTube-Beschreibung mit Kapiteln + 10 Titel-Ideen | … ein Eintrag im Tab **YouTube-Studio** (Titel wählen, Beschreibung kopieren). |
| Podcast-Shownotes (Zusammenfassung, Kapitel, Kernaussagen, Zitate) | … ein Dokument unter *Projekt → Dokumente* (braucht eine https-Adresse von HyperLevel); sonst kopieren. |
| Community-Beitrag | … in der gewählten Gruppe **veröffentlicht** (mit Rückfrage – die Community kennt keine Entwürfe). |
| Lektion-Teaser (nur mit Kurs-Lektionen) | … in der gewählten Lektion: der beste Clip wird Lektionsvideo (oder steht über dem Text, wenn es schon eins gibt), davor der Teaser. |

Jeder Inhalt lässt sich vorher bearbeiten, kopieren, neu erzeugen oder entfernen; bis zum Klick bleibt er ein Vorschlag. Clips, die in Blog, Newsletter oder Lektion verlinkt werden, kopiert HyperLevel einmal auf die eigene Platte (`data/video-studio/public/`) und liefert sie unter einem dauerhaften, signierten Link `/hooks/openshorts/clip/<id>.<signatur>.mp4` aus – sie bleiben, wenn OpenShorts den Job nach seiner Aufbewahrungszeit löscht, und gehen erst mit dem Job in HyperLevel. Vorschaubilder nimmt der Browser beim Anschauen der Clips auf (`/hooks/openshorts/thumb/…`).

Das Transkript kommt aus `GET /api/clip/{job_id}/{index}/edl` (Wortliste des ganzen Videos); fehlt die, setzt HyperLevel es aus `GET /api/clip/{job_id}/{index}/transcript` der Clips zusammen. Es wird einmal je Job gespeichert. Ist der KI-Assistent aus, ohne Schlüssel oder das Limit erreicht, sagt der Tab das und erzeugt nichts; bricht das Limit mitten im Lauf, hören die übrigen Inhalte sofort auf (keine weiteren Kosten).

### Autopilot

Tab **Autopilot** im Video-Studio, je Sub-Account:

- **Quellen** (bis 5): YouTube-Kanal (Kanal-ID `UC…` oder `youtube.com/channel/UC…`; HyperLevel liest `https://www.youtube.com/feeds/videos.xml?channel_id=…`) oder Podcast-RSS mit Video-Folgen bzw. YouTube-Links. Reine Audio-Folgen werden übersprungen (OpenShorts braucht Bild). Abruf alle 10 Minuten über den abgesicherten Abruf (keine internen Adressen, Größen- und Zeitgrenze); beim ersten Abruf merkt sich der Autopilot die vorhandenen Videos, verarbeitet werden nur neue. Höchstens *n* Videos pro Tag (Standard 3).
- Für jedes neue Video startet ein Shorts-Job (Herkunft „Autopilot“, eigene Optionen für Clips, Untertitel, Layout). Ist er fertig:
  - die **besten N Clips** (nach Score) gehen auf die gewählten Kanäle mit Video, verteilt auf die nächsten freien **Zeitfenster** (Uhrzeiten × Wochentage in der Zeitzone des Sub-Accounts; das nächste Video macht hinter dem letzten Fenster weiter). Kanäle, deren Zeichengrenze die Caption sprengt (X: 280), lässt der Autopilot für diesen Clip aus.
  - das **Recycling-Set** wird erzeugt; Newsletter und Social-Texte werden als Entwürfe übernommen, der Blog-Beitrag in die gewählte Website. YouTube, Shownotes, Community und Lektion warten im Tab Recycling.
  - das Team bekommt eine **Push-Nachricht** und/oder **E-Mail** an die Firmenadresse mit Zusammenfassung und Hinweisen.
- **Entwürfe zur Freigabe** (Standard): alles landet als Entwurf im Social Planner. **Automatisch einplanen** (ausdrücklich einschalten): Clips und Social-Texte werden ohne Freigabe zu den Zeitfenstern geplant. Blog und Newsletter bleiben immer Entwürfe.
- „Jetzt prüfen“ ruft die Quellen sofort ab; das **Protokoll** zeigt, was passiert ist.

### Workflows, MCP, Berichte

- **Aktion „Video recyceln“** (`video_recycle`): `job_id` (Standard `{{event.jobId}}` – passt direkt nach „Shorts fertig“) oder ein Video-Link (dann erst Shorts, danach Recycling), Auswahl der Inhalte. Ergebnis wartet im Tab Recycling.
- **MCP `ghl_recycle_video`:** `job_id` oder `url`, `kinds`, `language`; `list: true` zeigt den Stand mit Texten.
- **Bericht „Video-Studio: Recycelte Inhalte“:** Art, Status, übernommen ja/nein, bearbeitet, gestartet über (manuell, Workflow, MCP, Autopilot), Übernahme-Quote.

## Automationen, MCP, Berichte

- **Auslöser „Shorts fertig (Video-Studio)“** (`shorts.ready`): Daten `jobId`, `title`, `clips`, `bestClipId`, `bestClipTitle`, `bestScore`, `url`. Workflows starten für den Kontakt des Jobs – Jobs aus der Aktion unten oder mit `contact_id` (API/MCP); REST-Hooks und Webhooks bekommen das Ereignis immer.
- **Aktion „Shorts aus Video erstellen“** (`shorts_create`): Video-Link mit Platzhaltern (z. B. `{{contact.custom.video_url}}`), Titel, Anzahl Clips, Layout, Untertitel, Hook. Der Job gehört zum Kontakt des Workflows.
- **MCP:** `ghl_create_shorts` (Job aus Link), `ghl_list_shorts_jobs` (Jobs; mit `job_id` die Clips samt Score), `ghl_schedule_clip` (Clip auf Kanälen einplanen, Standard Entwurf).
- **Berichte:** Quellen „Video-Studio: Jobs“ (Status, Quelle, Clips, Dauer, Erfolgsquote, Kontakt), „Video-Studio: Clips“ (Score, Länge, eingeplant, bearbeitet) und „Video-Studio: Veröffentlichte Clips“ (Datum, Art, Kanäle).

## API (HyperLevel)

| Endpunkt | |
| --- | --- |
| `GET/PATCH /api/agency/video-studio`, `POST /api/agency/video-studio/test` | Verbindung (nur Admins; Schlüssel maskiert) |
| `GET /api/video-studio` | Status, Funktionen, Optionen für die Oberfläche |
| `GET/POST /api/video-studio/jobs`, `GET/DELETE /api/video-studio/jobs/:id` | Jobs (`{url \| upload_id, title, contact_id, options: {clips, layout, subtitles, hook, hook_style, dub_language, format}}`) |
| `POST /api/video-studio/jobs/:id/refresh`, `…/confirm` | Status sofort abrufen, geringe Auflösung bestätigen |
| `POST /api/video-studio/uploads`, `PUT /api/video-studio/uploads/:id?offset=N`, `DELETE …` | Upload in Teilen (Rohdaten, max. 8 MB je Teil) |
| `GET /api/video-studio/clips/:id/video[?download=1]` | Clip streamen (Range) / herunterladen |
| `PATCH/DELETE /api/video-studio/clips/:id`, `POST …/edit` | Texte ändern, entfernen, Nachbearbeitung (`{op: subtitles\|dub\|framing}`) |
| `POST /api/video-studio/clips/:id/schedule`, `POST …/doc` | Einplanen (`{integration_ids, type, date, caption, title}`), als Dokument speichern |
| `GET /api/video-studio/tasks`, `POST /api/video-studio/youtube…`, `POST /api/video-studio/ugc…` | YouTube-Studio und KI-Shorts |
| `GET/POST /api/video-studio/jobs/:id/recycle` | Recycling: Stand, Ziele (Websites, Gruppen, Lektionen, Kanäle) / erzeugen (`{kinds, language}`) |
| `POST /api/video-studio/recycle` | Link statt Job: Shorts starten, danach recyceln (`{url, kinds}`) |
| `PATCH/DELETE /api/video-studio/recycle/:id`, `POST …/apply` | Inhalt ändern (`{content}`), entfernen, übernehmen (`{funnel_id, embed}` · `{integration_ids}` · `{group_id}` · `{course_id, lesson_id}`) |
| `GET/PUT /api/video-studio/autopilot`, `POST …/autopilot/check` | Autopilot-Einstellungen und Protokoll, sofort prüfen |
| `POST /api/video-studio/clips/:id/thumb` | Vorschaubild (JPEG als data:-URL, max. 600 KB) |
| `POST /hooks/openshorts/:geheim` | Webhook von OpenShorts (signiert) |
| `GET /hooks/openshorts/media/:token`, `GET /hooks/openshorts/source/:token` | Signierte, kurzlebige Links für Postiz bzw. OpenShorts |
| `GET /hooks/openshorts/clip/:token`, `GET /hooks/openshorts/thumb/:token` | Dauerhafte, signierte Links auf HyperLevels Kopie eines Clips / Vorschaubild (Blog, Newsletter, Lektion) |

### Genutzte OpenShorts-Endpunkte

`GET /health`, `GET /api/config`, `GET /api/me` (gehostet), `GET /openapi.json`, `GET /api/translate/languages` · `POST /api/uploads` + `PUT /api/uploads/{upload_id}` · `POST /api/process` (`url` oder `upload_id`, `acknowledged`, `layouts`, `output_format`, `target_clips`, `captions`, `auto_hook`, `auto_hook_style`, `webhook_url`, `webhook_secret`, `force_low_quality`) · `GET /api/status/{job_id}` · `GET /api/clip/{job_id}/{index}/edl` und `…/transcript` (Recycling) · `GET /videos/{job_id}/{datei}` (mit `Range`) · `POST /api/subtitle`, `POST /api/translate` (`X-ElevenLabs-Key`), `POST /api/clip/rerender` · `POST /api/thumbnail/upload|analyze|titles|describe|generate`, `GET /thumbnails/…` · `POST /api/saasshorts/analyze|generate` (`X-Fal-Key`, `X-ElevenLabs-Key`), `GET /api/saasshorts/status/{job_id}`, `GET /api/saasshorts/voices`. Webhook von OpenShorts: einmal pro Job beim Ende, `{"event": "job.completed"|"job.failed", "job_id", "status", "clips": [{index, title, video_url}], "error"?}`, drei Versuche (sofort, nach 10 s, nach 60 s).

## Sicherheit

- Webhooks: eigene geheime Adresse und eigener HMAC-Schlüssel je Job, Vergleich in konstanter Zeit, falsche Job-ID wird abgelehnt; der Status kommt danach immer aus OpenShorts selbst.
- Proxy nur für `/videos/…` und `/thumbnails/…` der eingetragenen Instanz (kein `..`, nur Medien-Endungen); öffentliche Links nur signiert und zeitlich begrenzt.
- Uploads: nur Videodateien (Dateiendung + Signatur der ersten Bytes), Größen- und Platz-Prüfung, höchstens 3 offene Uploads je Sub-Account.
- Selbst gehostet hat OpenShorts keine Anmeldung: nie öffentlich ins Netz stellen (die Vorlage veröffentlicht keinen Port).
- Recycling übernimmt über die normalen Routen von Blog, Kampagnen, Social Planner, Community und Kursen – mit den Rechten der Person, die klickt. Der Autopilot handelt als die Person, die ihn eingerichtet hat (sonst der erste Admin); im Protokoll steht „Autopilot (Video-Studio)“. Feeds werden nur über den abgesicherten Abruf geladen; dauerhafte Clip-Links sind HMAC-signiert (ohne Signatur: 404).

## Grenzen

- OpenShorts hat keinen Abbrechen-Endpunkt: „Löschen“ entfernt den Job in HyperLevel; OpenShorts räumt nach seiner Aufbewahrungszeit auf.
- Nach Ablauf der Aufbewahrung zeigt der Player „nicht mehr vorhanden“ – rechtzeitig einplanen oder herunterladen.
- YouTube-Studio-Sitzungen und KI-Shorts-Jobs hält OpenShorts nur im Speicher; nach einem Neustart von OpenShorts neu starten.
- Den Clip-Index für Nachbearbeitungen liest HyperLevel aus dem Dateinamen (`…_clip_N.mp4`), wie OpenShorts ihn vergibt.
- Recycling-Texte entstehen aus dem Transkript – Fakten vor dem Übernehmen prüfen. Für das Transkript muss der Job in OpenShorts noch existieren (Aufbewahrung); danach nutzt HyperLevel das gespeicherte.
- YouTube-@Namen lassen sich nicht in einen Feed übersetzen – Kanal-ID angeben.
