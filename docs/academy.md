# Akademie – geführte Touren

Die **Akademie** (Menüpunkt *Akademie*, ganz unten über *Einstellungen*) bringt jedem bei, wie man die Firma mit der App führt – direkt in der echten Oberfläche: Die Tour markiert das Feld oder den Knopf, erklärt ihn in ein, zwei Sätzen, sagt, was du klicken oder tippen sollst, wartet, bis du es gemacht hast (oder du klickst „Weiter“), und geht weiter – auch über mehrere Seiten.

## Was es gibt

- **Gesamt-Guide „Firma übernehmen“** – 14 Kapitel für eine Nachfolgerin oder einen Nachfolger, zusammen rund fünf Stunden, jedes Kapitel einzeln und jederzeit fortsetzbar: Zugang & Sicherheit → Agentur-Überblick → Tagesroutine (mit Tickets und eigenem Dashboard) → Kunden & Projekte (mit Firmen, eigenen Objekten und Eigenschaften) → Marketing (mit Lead-Scoring und Marketing-Dashboard) → Websites & Funnels → Kurse & Community → Umsatz → Reputation → Service & Support → KI → Einstellungen & Integrationen (mit Integrations-Katalog, Zapier/Make/n8n, HubSpot-Import und Android-App) → Betrieb → Abschluss-Checkliste.
- **Kurs „Deine Firma mit HyperLevel führen“** – zehn Lektionen für Gründerinnen und Gründer, die ihre eigene Firma mit der App führen (Firmen-Setup, Vertrieb, Marketing, Kundenservice, Finanzen, Projekte & Zeit, KI & Automatisierung, Kennzahlen & Wochen-Routine, Datenschutz & Compliance, Skalieren), jede mit einer 10-Minuten-Aufgabe in der echten Oberfläche; eigene Gruppe und Abzeichen in der Akademie. Gedruckte Fassung: [kurs-firma-fuehren.md](kurs-firma-fuehren.md) (erzeugt aus `web/src/tour/content/company.ts` über `web/src/tour/company-course.ts`), das Betriebs-Handbuch dazu: [company-playbook.md](company-playbook.md).
- **Modul-Touren** – über 110 Touren, für jeden Bereich eine mit 5–15 Schritten, in zehn Gruppen: Erste Schritte, Kunden & Tagesgeschäft, Marketing, Websites & Kurse & Community, Umsatz, Reputation, Service & Support, KI, Einstellungen & Kanäle sowie Agentur & Betrieb. Die vollständige Liste mit Schrittzahl und Dauer steht im [Anhang des Handbuchs](handbuch.md#anhang-alle-modul-touren) und in der Akademie selbst.
- **„?“ oben rechts** – auf jeder Seite: die Touren, die zu genau dieser Seite passen, „Weitermachen“ und der Gesamt-Guide.
- **Fortschritt & Abzeichen** – je Person auf dem Server gespeichert: angefangene Touren, erledigte Touren (✓), letzter Schritt. Wer die Seite neu lädt, ist sofort wieder in der laufenden Tour.
- **Übungs-Firma** (nur Agentur) – ein eigener Sub-Account „Übungs-Firma (Akademie)“ mit erfundenen Kontakten (und den Firmen dazu), Deals, Aufgaben, Termin, Formular, Website, Produkten, Rechnung, Kampagne, Workflow, zwei Tickets, einem Hilfe-Artikel, dem eigenen Objekt „Projekte“ mit zwei Datensätzen, Verknüpfungs-Labels und einem Lead-Scoring-Modell (alle E-Mails `…@example.com`). E-Mail und SMS stehen dort auf „Nur speichern“ – es wird nichts verschickt. Touren mit Übungen bieten am Anfang an, dorthin zu wechseln. Anlegen und Löschen in der Akademie; solange du drin bist, zeigt ein gelber Hinweis oben, dass alles nur Übung ist.
- **Übergabe-Status** (nur Agentur) – was eingerichtet ist und was fehlt (E-Mail-/SMS-Versand, Rechnungsdaten, Kanäle, Telefonie, Browser-Telefon, KI-Assistent, KI-Telefonagent, Stripe, Google, Website-Chat, Social Planner, Service – Zuweisung, Support-Postfach, Hilfe-Center und offene Tickets ohne Zuständige –, HubSpot-Umzug, White-Label, Domains, OAuth, Postfächer, Supabase, Todoist, SaaS, Backups, Agentur-Schlüssel, Android-App mit gekoppelten Handys), **wer Zugang hat** (mit 2FA-Status) und **offene Punkte** (Admins ohne 2FA, fehlende Pflicht-Einrichtungen, ausgefallene Websites, überfällige Aufgaben). Gelesen wird aus den vorhandenen Status-Endpunkten – Passwörter, Tokens und Schlüssel werden nie angezeigt.
- **Handbuch** – der ganze Gesamt-Guide als Dokument (*Akademie → Handbuch*), zum Drucken oder „Als PDF speichern“. Dieselbe Fassung liegt als Markdown in [handbuch.md](handbuch.md).
- **Anleitungen in der App** – am Ende jeder Tour führt „Mehr dazu“ zur passenden Anleitung aus `docs/`, direkt in der App (nur angemeldet; Kunden-Logins sehen nur die Anleitungen ohne Server-Details).

## Einstieg

Die Akademie wird dort angeboten, wo man sie braucht:

- **Willkommenskarte „In 10 Minuten startklar – Academy starten“** – auf der Startseite (Dashboard und Agentur-Übersicht), bis die erste Tour („So findest du dich zurecht“) erledigt ist; in der Demo immer (alle Besucher teilen sich einen Login). ✕ blendet sie in diesem Browser aus. Neue Logins sehen sie zusätzlich oben im Dialog „Was willst du tun?“ des Einfach-Modus – „Academy starten“ übernimmt die gewählten Ziele und öffnet die Tour.
- **„Lernen“ / „Tour starten“** – in den leeren Ansichten der Hauptbereiche (Kontakte, Konversationen, Kalender, Formulare, Websites & Funnels, Workflows, Kampagnen), im Seitenkopf von Dashboard, Agentur und Einstellungen und im Demo-Banner („Geführte Tour starten“). Der Link startet die Tour, die zur Seite passt; gibt es keine, öffnet er die Akademie.
- **Hilfe-Menü „?“** – bis die erste Tour erledigt ist, steht dort „Lernen: In 10 Minuten startklar“.
- **Menü** – im Einfach-Modus gehört *Akademie* zu den festen Einträgen (neben Dashboard, Konversationen, Kontakte, Kalender, Aufgaben).

Technisch: `web/src/tour/learn.tsx` (klein, lädt die Tour-Engine erst beim Klick; `Empty` hat dafür das Prop `learn`) und `web/src/tour/welcome.tsx`.

## Bedienung

- **Weiter / Zurück** blättern, **Überspringen** springt im Gesamt-Guide zum nächsten Kapitel (sonst beendet es die Tour), **✕** oder **Esc** pausiert – der Fortschritt bleibt. Ist gerade ein Dialog offen, schließt Esc zuerst den Dialog.
- Schritte mit 👉 warten auf dich: auf einen Klick, eine Eingabe, einen Seitenwechsel oder eine Erfolgsmeldung („Gespeichert“). „Weiter“ geht immer.
- **Mach’s für mich** füllt bei manchen Schritten ein Beispiel ein (z. B. einen Namen) – nur bei harmlosen Eingaben, nie beim Senden oder Löschen.
- Auf dem Handy erscheint die Erklärung als Leiste unten; das Menü klappt die Tour bei Bedarf selbst auf.
- Kunden-Logins sehen nur Touren und Schritte für die Bereiche, die sie nutzen dürfen; Agentur-Touren und -Schritte nur Admins.

## Für Entwickler

- Touren sind reine Daten in `web/src/tour/content/*.ts` (Typen in `web/src/tour/types.ts`), die Engine in `web/src/tour/engine.tsx`, die Seite in `web/src/pages/Academy.tsx`, der Server in `server/modules/academy.ts`.
- Ein Schritt zeigt auf ein Element über `data-tour="schlüssel"` (bei `Link`, `Field`, `Stat`, `Check` und `Empty` über das Prop `tour`). Automatisch vorhanden: `nav-<route>` (Menü), `tab-<key>` (jeder Reiter), `page-head` / `page-title` / `page-actions` (Seitenkopf), `modal` / `modal-foot`, `search`, `jump`, `help`, `project-switcher`, `account`. Attribute nur ergänzen, nie das Layout ändern.
- Schritt-Arten: `info`, `click` (weiter nach Klick aufs Element), `navigate` (`to`: Route; `to: 'forms/'` = irgendeine Unterseite), `fill` (wartet auf einen Wert; bei einer Auswahlliste auf die Option aus `demo.fill`), `wait` (`toast`, `appear` oder `route`). `route` öffnet die Seite vor dem Schritt, `optional` erlaubt ein fehlendes Element (dann erklärt `missing`), `admin`/`perm` blenden Schritte aus, `demo` ist „Mach’s für mich“.
- `tests/academy.test.ts` prüft, dass jedes Ziel als `data-tour` im Code existiert, Routen und Reiter echt sind, Anleitungs-Links auf vorhandene Überschriften zeigen und `docs/handbuch.md` aktuell ist. Seiten sind alle `case '…':` aus `web/src/main.tsx` (auch ohne Menüeintrag, z. B. `properties`). Werden Kapitel umnummeriert, ändern sich ihre IDs – eine Migration in `server/modules/academy.ts` zieht den gespeicherten Fortschritt mit (siehe `002-journey-service-chapter`). Nach Änderungen am Gesamt-Guide das Handbuch neu erzeugen:

  ```
  node --import tsx -e "import('./web/src/tour/handbook.ts').then((m) => require('node:fs').writeFileSync('docs/handbuch.md', m.handbookMarkdown('HyperLevel')))"
  ```

### API

| Methode | Pfad | Zweck |
| --- | --- | --- |
| GET | `/api/academy` | Fortschritt je Tour, laufende Tour, Übungs-Firma |
| PUT | `/api/academy/tours/:id` | `{step, total, active?, done?}` – Position speichern; `active` = läuft (wird nach dem Neuladen fortgesetzt) |
| DELETE | `/api/academy/tours/:id` | Tour zurücksetzen |
| DELETE | `/api/academy/active` | Keine Tour läuft mehr |
| POST / DELETE | `/api/academy/sandbox` | Übungs-Firma anlegen (mit Demo-Daten) / löschen – nur Admins |
| GET | `/api/academy/docs`, `/api/academy/docs/:name` | Anleitungen aus `docs/` (Admins alle, Kunden-Logins eine Auswahl) |
