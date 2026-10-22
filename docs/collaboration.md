# Live-Zusammenarbeit überall

Wer aus dem Team ist gerade wo in der App? HyperLevel zeigt es auf jeder Seite – ohne dass eine Seite dafür etwas tun muss:

- **Avatare in der oberen Leiste:** die Kolleginnen und Kollegen, die gerade dieselbe Seite offen haben. Der Hinweis beim Darüberfahren sagt „Anna – bearbeitet gerade“, ein gelber Punkt am Avatar zeigt, dass dort jemand tippt.
- **Im Seitenmenü:** kleine Avatare neben dem Menüpunkt, in dem jemand gerade arbeitet (abschaltbar: „Team im Menü zeigen“). Ein Klick auf einen Avatar zeigt Name und Seite, **Hingehen** öffnet dieselbe Seite. Per Tastatur: vom Menüpunkt mit Tab auf den Knopf „Wer ist bei …“ (er erscheint, sobald er den Fokus hat), Enter oder Leertaste öffnet die Liste, Esc schließt sie und gibt den Fokus zurück.
- **„Team ist hier“:** der Knopf mit dem Personen-Symbol in der oberen Leiste listet alle, die im Sub-Account online sind, mit ihrer Seite und **Hingehen** – dort liegen auch die Schalter.
- **„Anna hat hier gerade gespeichert“:** speichert jemand auf der Seite, die du offen hast, erscheint ein Hinweis mit **Neu laden** (lädt nur die Seite neu, nicht die ganze App).
- **„Anna bearbeitet das gerade auch“:** tippt ihr beide auf derselben Seite, warnt ein gelber Hinweis – so überschreibt niemand die Änderung des anderen.
- **Mauszeiger der anderen** mit Namen und Farbe: auf Canvas-Boards und Living Boards von Haus aus an, auf allen anderen Seiten nur, wenn beide Seiten es einschalten.

Alle Hinweise schließen mit ✕ oder Esc. Auf Touch-Geräten (Handy, Tablet ohne Maus) werden keine Mauszeiger gezeigt oder gesendet.

## Wo es eigene Live-Funktionen gibt

Einige Bereiche hatten schon vorher eigene Echtzeit – dort bleiben die Avatare oben, die allgemeinen Hinweise „gespeichert“ und „bearbeitet das gerade auch“ entfallen:

| Bereich | Eigene Live-Funktion |
| --- | --- |
| Konversationen | „Anna schreibt gerade…“ und Kollisions-Hinweis je Konversation ([team-inbox.md](team-inbox.md)) |
| Canvas | eigene Mauszeiger, Auswahl und Personenliste je Board ([canvas.md](canvas.md)); neu: **Folgen** – ein Klick auf eine Person in der Kopfzeile, und deine Ansicht bleibt auf ihrem Mauszeiger, bis du selbst verschiebst, zoomst oder ✕ drückst |
| Team-Chat | Anwesenheit und „tippt …“ ([team-chat.md](team-chat.md)) |
| Living Boards | Änderungen kommen sofort bei allen an ([living-boards.md](living-boards.md)); neu: Mauszeiger der anderen, bezogen auf das Raster des Boards |

## Einstellungen

Jede Person entscheidet selbst (gespeichert am Login, gilt in allen Sub-Accounts) im Popover **Team ist hier**:

| Schalter | Standard | Wirkung |
| --- | --- | --- |
| Team im Menü zeigen | an | Avatare neben den Menüpunkten |
| Mauszeiger anderer zeigen | Nur auf Boards und Canvas | *Auf allen Seiten* oder *Aus*. Dein Zeiger geht nur an Leute, die ihren Zeiger auch teilen – und nur, solange ihr auf derselben Seite seid. *Aus* gilt auch im Canvas: keine fremden Zeiger, deiner wird nicht gesendet |
| Unsichtbar | aus | Niemand sieht dich: keine Anwesenheit, kein Mauszeiger, kein „hat gespeichert“. Du siehst weiterhin, wer wo ist – aber keine fremden Mauszeiger (wer selbst nicht zu sehen ist, schaut niemandem unbemerkt auf den Zeiger) |

**Für den ganzen Sub-Account** schaltet jemand mit dem Bereich *Einstellungen* die Live-Zusammenarbeit im selben Popover ein oder aus. Ausgeschaltet nimmt der Server keine Anwesenheit mehr an, vergisst die vorhandene sofort, die Teamliste bleibt leer und offene Tabs zeigen nichts mehr an.

## Datenschutz und Betriebsrat

Anwesenheitsanzeigen können in Deutschland eine technische Einrichtung zur Leistungs- und Verhaltenskontrolle sein (§ 87 Abs. 1 Nr. 6 BetrVG) – wo es einen Betriebsrat gibt, gehört die Funktion vor dem Einschalten in die Abstimmung mit ihm. HyperLevel ist deshalb so gebaut, dass sich daraus keine Überwachung machen lässt:

- **Nur der Live-Zustand.** Anwesenheit, Seite, „bearbeitet gerade“ und Mauszeiger liegen ausschließlich im Arbeitsspeicher des Servers. Es gibt keine Tabelle, keinen Verlauf, keine Statistik, keinen Export und keine Protokollzeile (auch nicht im Audit-Log oder im Rückgängig-Journal). Ein Tab, der sich 45 Sekunden nicht meldet, ist vergessen; ein Neustart des Servers vergisst alles. Nur das Ein- und Ausschalten für den ganzen Sub-Account ist eine Einstellung wie jede andere und steht im Audit-Log (`presence.settings.update`, „Live-Zusammenarbeit eingeschaltet/ausgeschaltet“, mit Person und Zeit).
- **Keine Zeitstempel nach außen.** Die Teamliste sagt nur „online“ und wo – nicht, seit wann.
- **Unsichtbar** ist jederzeit möglich, und das Umschalten wird nirgends protokolliert.
- **Abschaltbar je Sub-Account.**
- **Ein versteckter Tab meldet sich nach einer Minute ab** (keine Anwesenheit, während niemand vor dem Bildschirm sitzt).
- Gespeichert werden nur die Schalter selbst: die drei persönlichen in der Tabelle `presence_prefs`, der Sub-Account-Schalter in den Einstellungen des Sub-Accounts.

## Wer was sieht

- **Nur derselbe Sub-Account.** Wer in Sub-Account A arbeitet, ist nur für Leute sichtbar, die gerade ebenfalls in A sind – nie sub-account-übergreifend, auch nicht für Agentur-Admins, die gerade woanders sind.
- **Die Seite nur mit Recht auf den Bereich.** Ein Mitglied ohne Bereich *Buchhaltung* sieht bei einer Kollegin in der Buchhaltung nur „online“, nicht wo. Welche Seite zu welchem Bereich gehört, steht in `PRESENCE_ROUTES` (`server/services/presence-model.ts`) – dieselben Bereiche wie im Menü; unbekannte Seiten zeigen nur „online“. Die Agentur-Übersicht sehen nur Admins, die Personal-Seite nur Leute mit dem Bereich *Personal*.
- **Kein Datensatz-Name.** Weitergegeben wird nur die Adresse (`/contacts/<id>`), nie ein Text aus dem Browser eines anderen – den Menünamen („Kontakte“) setzt die App des Lesers selbst ein. So kann weder der Name eines Kontakts oder Deals noch sonst ein Text bei den anderen landen. Wer den Datensatz nicht öffnen darf, kommt mit **Hingehen** auch nicht hinein.
- **Nur Personen.** Eine Anmeldung im Browser (auch in der WebView der Android-App) oder das Geräte-Token der App. API-Schlüssel, MCP-Verbindungen und KI-Apps (OAuth), Agentur-Schlüssel, der KI-Agent, Plugins und die Werkstatt bekommen 403 – wie beim Live-Stream des Team-Posteingangs.
- **Versteckte Logins** (der Betreiber im Cloud-Modus) erscheinen nie – und bekommen, wie Unsichtbare, keine fremden Mauszeiger.
- **Der Stream endet mit der Anmeldung.** Abmelden, eine widerrufene Sitzung („Andere Geräte abmelden“, neues Passwort), eine Änderung oder Löschung der Person, das Entfernen aus dem Sub-Account oder das Löschen des Sub-Accounts beenden den Live-Stream sofort; eine abgelaufene Sitzung spätestens bei der nächsten Prüfung (alle 20 Sekunden). Der Server schickt dann `bye`, der Tab meldet sich nicht mehr und verbindet sich erst wieder, wenn er wieder angesehen wird.

## Für Entwickler

Modul `server/modules/presence.ts`, Zustand in `server/services/presence-hub.ts` (im Speicher, ein Prozess), reine Logik in `server/services/presence-model.ts` (Server und Browser nutzen dieselbe Datei). Oberfläche in `web/src/presence/`: `store.ts` (winziger gemeinsamer Zustand, Teil des ersten Downloads), `client.ts` (die eine Verbindung je Tab), `Presence.tsx` (`PresenceLayer`, `PresenceBar`, `NavDots`, eigener Chunk), `canvas.tsx` (Personen und **Folgen** im Canvas).

| Route | Zweck |
| --- | --- |
| `GET /api/presence/stream?clientId=&locationId=` | SSE je Tab und Sub-Account. Ereignisse: `hello` (`enabled`, `prefs`, `peers`), `presence` (ein Tab eines Kollegen), `gone`, `saved` (`name`, `page`), `cursor` (`name`, `color`, `pts`), `settings` (`enabled`), `bye` (`reason`: `signed_out` – Anmeldung beendet oder kein Zugang mehr –, `tabs` – ein neuerer Tab derselben Person hat den Platz übernommen; danach endet der Stream, der Browser soll nicht von selbst neu verbinden). Server voll: 503 statt Stream |
| `POST /api/presence` | Herzschlag alle 15 s und bei jedem Seitenwechsel: `{clientId, page, editing?, saved?, leaving?, x?, y?}` oder gebündelt `pts: [[x, y], …]` (höchstens 10); ein `title` älterer Browser wird ignoriert. Höchstens 300 je Person und Minute (sonst 429). Ohne Audit-Zeile und Journal (`ctx.skipAfterWrite`) |
| `GET /api/presence/team` | online im Sub-Account, eine Zeile je Person: `user_id`, `name`, `color`, `page` (oder `null`), `title` (immer `null`), `editing` |
| `GET`/`PUT /api/presence/prefs` | eigene Schalter `invisible`, `menu`, `cursors` (`boards`, `all`, `off`); ohne Audit-Zeile |
| `GET`/`PUT /api/presence/settings` | Schalter des Sub-Accounts `{enabled}` (Bereich *Einstellungen*); jede Änderung eine Audit-Zeile `presence.settings.update` |

- **Seite:** die Adresse unterhalb von `/app`, streng geprüft (beginnt mit `/`, höchstens 200 Zeichen, nur `A-Za-z0-9/_-.:~`, Query und Anker werden abgeschnitten).
- **Mauszeiger:** `x` als Anteil der Breite (0…1), `y` in Pixeln ab Oberkante inklusive Scrollweg, gemessen am Element `[data-presence-surface]` der Seite (Living Boards: das Raster) oder sonst am Seiteninhalt. Der Browser nimmt etwa 20 Positionen je Sekunde und schickt sie gebündelt rund dreimal je Sekunde (das API-Limit von 900 Anfragen je Minute gilt je Adresse – ein Büro teilt sich eine); der Server leitet höchstens alle 50 ms eine Sendung je Tab weiter und begrenzt die Werte.
- **„Gespeichert“:** `web/src/api.ts` meldet nach jedem erfolgreichen schreibenden Aufruf das Ereignis `pghl:saved`; `client.ts` zählt ihn nur, wenn die Person in den letzten 10 s im Seiteninhalt geklickt oder getippt hat und der Tab sichtbar ist, filtert eigene Dinge (Anwesenheit, Agent, Einstellungen, lesende POSTs wie Vorschau, Suche, Prüfung, Zielgruppen-Zählung, KI-Entwürfe, Abfragen laufender Jobs) heraus und schickt höchstens alle 3 s ein `saved` (der Server höchstens alle 2 s).
- **„Bearbeitet gerade“:** `input`/`change` im Seiteninhalt (`.content`), nach 20 s ohne Eingabe wieder aus; Suchfelder (`type="search"`, `role="searchbox"`) und Bereiche mit `data-presence-ignore` zählen nicht – Filterfelder einer Liste markiert man am besten so.
- **Eine neue Seite** braucht nichts – außer einem Eintrag in `PRESENCE_ROUTES` mit ihrem Bereich (`tests/presence.test.ts` prüft, dass jeder Menüpunkt einen hat). `own: true` schaltet die allgemeinen Hinweise ab (die Seite hat eigene Echtzeit), `cursor: 'board'` macht die Mauszeiger dort zum Standard, `cursor: 'own'` überlässt sie der Seite.
- **Abschied:** beim Schließen des Tabs endet der Stream (der Server vergisst den Tab sofort); zusätzlich geht ein `leaving` per `fetch(…, {keepalive: true})` – `sendBeacon` kann den CSRF-Header `x-pghl` nicht mitschicken.
- **Grenzen:** ein HyperLevel-Prozess hält den Zustand (wie Canvas und Team-Chat); höchstens 1000 Streams (darüber 503 – der Browser versucht es nach 30 s, 60 s … höchstens 5 min wieder) und 10 Tabs je Person (der 11. übernimmt den Platz des ältesten, der `bye` bekommt und erst wieder verbindet, wenn er angesehen wird – kein Hin und Her); 300 Meldungen je Person und Minute. Nach einem Neustart verbinden sich die Tabs mit 5–10 s Abstand (`retry` mit Zufallsanteil) wieder.
- Haken in `app.services`: `presenceHub` (u. a. `now` als Uhr für Tests, `sweep()`), `presence` (`hub`, `enabled`, `prefsOf`).
