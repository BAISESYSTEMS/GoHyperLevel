# Handbuch: Die Firma mit HyperLevel übernehmen

Dieses Handbuch ist die gedruckte Fassung des Gesamt-Guides **„Firma übernehmen“** aus der **Akademie** (Menüpunkt *Akademie* in HyperLevel). Es führt eine Nachfolgerin oder einen Nachfolger in 14 Kapiteln durch alles, was man braucht, um die Firma zu führen – vom sicheren Zugang über die Tagesroutine bis zum Betrieb des Servers. Zusammen dauert das etwa 5 Stunden; jedes Kapitel lässt sich einzeln machen und später fortsetzen.

> Am besten machst du die Kapitel direkt in der App: Die Tour markiert dort jedes Feld und jeden Knopf, erklärt ihn und wartet, bis du ihn ausprobiert hast. Zum Üben legt die Akademie auf Wunsch eine **Übungs-Firma** mit erfundenen Kunden an – dort kann nichts kaputtgehen und nichts wird verschickt.

**Inhalt**

1. [Zugang & Sicherheit](#kapitel-1-zugang--sicherheit) – Passwort, Zwei-Faktor-Login, Geräte, wer Zugang hat – und wo Zugangsdaten liegen (nie im Klartext).
2. [Agentur-Überblick](#kapitel-2-agentur-überblick) – Projekte und Kunden, Projekt-Wechsler, Strg+K und die Claude-Sitzungen jedes Projekts.
3. [Tagesroutine](#kapitel-3-tagesroutine) – Die 15-Minuten-Runde jeden Morgen: Posteingang (inkl. WhatsApp und Anrufe), Aufgaben, Termine, Pipeline, Tickets – und dein eigenes Dashboard.
4. [Kunden & Projekte](#kapitel-4-kunden--projekte) – Kontakt- und Firmen-Steckbriefe, eigene Objekte und Eigenschaften, Projekt-Steckbrief, Website-Überwachung, Dokumente und Claude-Artefakte.
5. [Marketing](#kapitel-5-marketing) – Kampagnen mit dem E-Mail-Designer, Social Planner, Workflows, Attribution, Affiliates, Werbung, Lead-Scoring und Marketing-Berichte.
6. [Websites & Funnels](#kapitel-6-websites--funnels) – Seiten-Builder, Blog, A/B-Tests, Formulare, Kalender-Buchung und eigene Domains.
7. [Kurse & Community](#kapitel-7-kurse--community) – Online-Kurse, Mitgliederbereich und Community-Gruppen – Zugang, Moderation, Mitglieder.
8. [Umsatz](#kapitel-8-umsatz) – Rechnungen & Angebote, Stripe, Produkte & Kauf-Links, Buchhaltung mit Norman, Verträge.
9. [Reputation](#kapitel-9-reputation) – Bewertungen sammeln, Google-Profil verbinden, auf Rezensionen antworten.
10. [Service & Support](#kapitel-10-service--support) – Tickets und SLAs, Zuweisung, Support-Postfach, Wissensdatenbank, Zufriedenheit (CSAT/NPS) und gefährdete Kunden im Health-Score.
11. [KI](#kapitel-11-ki) – KI-Assistent im Posteingang und Chat, KI-Telefonagent und die Claude-Werkzeuge (MCP).
12. [Einstellungen & Integrationen](#kapitel-12-einstellungen--integrationen) – Kanäle, Telefonie, Stripe, Integrations-Katalog, Zapier/Make/n8n, HubSpot-Import, OAuth, Todoist, Supabase, Android-App, SaaS, White-Label, Domains, Snapshots.
13. [Betrieb](#kapitel-13-betrieb) – Backups, Protokoll, die wöchentliche Server-Ressourcen-Routine und was zu tun ist, wenn eine Website down ist.
14. [Abschluss-Checkliste](#kapitel-14-abschluss-checkliste) – Alles abhaken: Zugänge, Versand, Zahlungen, Backups, Websites, Automationen – dann ist die Firma übernommen.

---

## Kapitel 1: Zugang & Sicherheit

Passwort, Zwei-Faktor-Login, Geräte, wer Zugang hat – und wo Zugangsdaten liegen (nie im Klartext). *(ca. 20 Minuten)*

1. **Willkommen zur Übernahme** – Dieser Guide führt dich in 14 Kapiteln durch alles, was du brauchst, um die Firma mit HyperLevel zu führen. Jedes Kapitel dauert 10–35 Minuten. Pausiere jederzeit mit ✕ – in der Akademie geht es genau hier weiter.
2. **Grundregel für Zugangsdaten** – Passwörter, API-Schlüssel und Tokens gehören in einen **Passwort-Manager** (z. B. 1Password oder Bitwarden) – nie in Notizen, E-Mails, Chats oder den Projekt-Steckbrief. HyperLevel zeigt gespeicherte Geheimnisse nie wieder an, nur „hinterlegt“.
3. **Dein Passwort** *(Einstellungen → Mein Konto)* – Hast du dein Passwort von jemand anderem bekommen? Dann ändere es jetzt – lang, einzigartig, aus dem Passwort-Manager.
4. **Zwei-Faktor-Login einschalten** – Mit 2FA reicht ein gestohlenes Passwort nicht mehr. Beim Anmelden fragt HyperLevel zusätzlich einen 6-stelligen Code aus deiner Authenticator-App. – *So geht's:* Klicke auf **2FA einrichten**, scanne den QR-Code mit der App und gib den Code ein.
5. **Backup-Codes sichern** – Nach dem Einschalten erscheinen Backup-Codes. Speichere sie im Passwort-Manager oder drucke sie aus – sie helfen, wenn das Handy verloren geht.
6. **Angemeldete Geräte** – Bei einer Übergabe: alle anderen Geräte abmelden. Danach bist nur noch du angemeldet.
7. **Wer hat Zugang?** *(Einstellungen → Team)* – Lösche Zugänge ehemaliger Mitarbeiter und prüfe, wer **Admin** ist. Jeder Admin sollte das grüne 2FA-Zeichen haben – sonst „2FA zurücksetzen“ und neu einrichten lassen.
8. **Übergabe-Status** *(Akademie)* – Hier siehst du auf einen Blick, wer noch ohne 2FA ist, was eingerichtet ist und was fehlt. Wir kommen am Ende darauf zurück.
9. **Schlüssel für Claude & Co.** *(Agentur → API & MCP)* – Agentur-Schlüssel erlauben Claude (MCP) und anderen Programmen den Zugriff. Unbekannte oder alte Schlüssel löschen; neue werden nur einmal angezeigt – sofort in den Passwort-Manager.
10. **API-Schlüssel des Sub-Accounts** *(Einstellungen → API & Webhooks)* – Dasselbe je Sub-Account: Was du nicht kennst, löschen. „Zuletzt benutzt“ zeigt, was noch gebraucht wird.
11. **Konten außerhalb von HyperLevel** – Liste alle Konten auf, die zur Firma gehören: Domain-Anbieter, Server (z. B. Hostinger), Stripe, Twilio, Meta, Google, Anthropic, E-Mail-Postfach. Für jedes gilt: Zugang im Passwort-Manager, 2FA an, Rechnungs- und Kontakt-E-Mail aktuell.

**Das hast du gelernt:**

- Wo Zugangsdaten hingehören: in den Passwort-Manager, nie in Notizen oder Mails
- Den eigenen Zugang mit 2FA und Backup-Codes absichern
- Fremde Geräte abmelden
- Zugänge, Admins und Schlüssel prüfen

Mehr dazu: [Funktionen: Sicherheit](../README.de.md#funktionen)

---

## Kapitel 2: Agentur-Überblick

Projekte und Kunden, Projekt-Wechsler, Strg+K und die Claude-Sitzungen jedes Projekts. *(ca. 15 Minuten)*

1. **Alle Projekte** *(Agentur → Projekte)* – Jede Karte ist ein Projekt oder Kunde (Sub-Account) – mit Status, Website-Erreichbarkeit, offenen Deals, Aufgaben und Post. Ein Klick wechselt hinein.
2. **Dein Projekt** *(Projekt)* – Jedes Projekt hat einen Steckbrief: Was ist das, wie läuft es, wo liegt was.
3. **Projekt-Wechsler** – Oben links wechselst du zwischen den Projekten – mit Suche. Zuletzt benutzte stehen oben.
4. **Strg+K** – Die Befehlsleiste findet Projekte, Seiten, Dokumente und Claude-Sitzungen. – *So geht's:* Klicke auf **Springen** oder drücke Strg+K.
5. **Probier es** – Tippe den Namen eines Projekts und drücke Enter. Esc schließt die Leiste.
6. **Claude-Sitzungen** – Für viele Projekte gibt es eine Claude-Sitzung (claude.ai/code), in der am Projekt gearbeitet wird. Der Link steht hier und im Claude-Knopf – so übernimmst du auch die laufende Entwicklung.
7. **Dokumente & Artefakte** – Berichte, Konzepte und Claude-Artefakte zum Projekt. Lies sie bei der Übernahme einmal durch.
8. **Kunden** *(Agentur → Kunden)* – Alle Kunden mit Kontakten, Websites und Logins. Hier legst du auch neue Kunden an.
9. **Über alle Projekte** *(Agentur → Projekte)* – Kontakte, Deals, Aufgaben und Dokumente gibt es auch projektübergreifend – praktisch für den Überblick am Morgen.
10. **Hilfe ist immer da** – Weißt du auf einer Seite nicht weiter, klick oben rechts auf das **?** – dort startet die passende Tour.

**Das hast du gelernt:**

- Alle Projekte und Kunden finden
- Mit Projekt-Wechsler und Strg+K schnell springen
- Wo die Claude-Sitzungen und Dokumente eines Projekts hängen
- Projektübergreifende Listen nutzen

Mehr dazu: [Als Agentur](../README.de.md#als-agentur)

---

## Kapitel 3: Tagesroutine

Die 15-Minuten-Runde jeden Morgen: Posteingang (inkl. WhatsApp und Anrufe), Aufgaben, Termine, Pipeline, Tickets – und dein eigenes Dashboard. *(ca. 20 Minuten)*

1. **Die Morgenrunde** – Jeden Morgen dieselbe Runde, ca. 15 Minuten: 1. Dashboard, 2. Posteingang, 3. verpasste Anrufe, 4. Aufgaben, 5. Termine, 6. Pipeline – und wenn ihr Kundenservice macht: 7. Tickets. Bei mehreren Projekten: zuerst die Agentur-Übersicht.
2. **1. Dashboard** *(Dashboard)* – Ein Blick genügt: Neue Kontakte, Nachrichten, Termine, Umsatz. Ungewöhnliche Zahlen? Nachhaken.
3. **2. Posteingang: nur Neues** *(Konversationen)* – E-Mail, SMS, WhatsApp, Messenger, Instagram, Chat und Anrufe landen alle hier. – *So geht's:* Klicke auf **Neu**.
4. **Abarbeiten** – Von oben nach unten: öffnen, antworten oder als Aufgabe merken. Unter „Entwürfe“ warten Antworten des KI-Assistenten und importierte Mail-Entwürfe auf deine Freigabe.
5. **Antworten** – Im Verlauf unten den Kanal wählen und schreiben. Bei WhatsApp gilt das 24-Stunden-Fenster – danach nur mit Vorlage.
6. **3. Verpasste Anrufe** *(Anrufe)* – Wer angerufen hat und niemanden erreicht hat – mit Voicemail zum Anhören. – *So geht's:* Klicke auf **Verpasst**.
7. **Zurückrufen** – „Zurückrufen“ klingelt erst bei dir (Handy oder Browser) und verbindet dann.
8. **4. Aufgaben** *(Aufgaben)* – Was ist heute fällig, was überfällig (rot)? Erledigtes abhaken, Neues mit Datum anlegen.
9. **5. Termine** *(Kalender)* – Die anstehenden Termine. Nach einem Termin den Status setzen (erschienen / nicht erschienen) – das zählt fürs Dashboard und kann Workflows starten.
10. **6. Pipeline** *(Opportunities)* – Deals weiterziehen, Werte aktualisieren, Gewonnenes und Verlorenes markieren. Eine gepflegte Pipeline ist deine Umsatzprognose.
11. **7. Tickets** *(Tickets)* – Macht ihr Support: „SLA zuerst“ sortieren und auf „Nicht zugewiesen“ filtern – was gefährdet ist, kommt zuerst dran. Mehr im Kapitel „Service & Support“.
12. **Dein Morgen-Dashboard** *(Berichte)* – Unter **Berichte** legst du dir mit einem Klick ein Dashboard aus einer Vorlage an (z. B. „Vertrieb“ oder „Aktivität“) – und lässt es dir mit „Per E-Mail“ jeden Morgen schicken.
13. **Alle Projekte auf einmal** *(Agentur → Aufgaben)* – Mit mehreren Projekten: Agentur → Aufgaben zeigt alle offenen Aufgaben aller Projekte, überfällige zuerst.
14. **Tipp: Push aufs Handy** *(Einstellungen → Mein Konto)* – Schalte Push-Benachrichtigungen ein, dann musst du nicht ständig nachsehen: neue Nachrichten, fällige Aufgaben, Zahlungen.

**Das hast du gelernt:**

- Die feste Reihenfolge der Morgenrunde
- Ungelesene Nachrichten und verpasste Anrufe abarbeiten
- Aufgaben und Termine im Blick behalten
- Die Pipeline pflegen
- Ein eigenes Dashboard unter Berichte nutzen

Mehr dazu: [Funktionen im Überblick](../README.de.md#funktionen)

---

## Kapitel 4: Kunden & Projekte

Kontakt- und Firmen-Steckbriefe, eigene Objekte und Eigenschaften, Projekt-Steckbrief, Website-Überwachung, Dokumente und Claude-Artefakte. *(ca. 25 Minuten)*

1. **Einen Kunden finden** *(Kontakte)* – Name, E-Mail, Telefon oder Firma – die Suche findet alles. – *So geht's:* Such einen Kunden, z. B. „Anna“.
2. **Öffnen** – Ein Klick auf die Zeile öffnet den Kontakt-Steckbrief mit allen Daten und dem Verlauf. – *So geht's:* Klicke auf einen Kontakt.
3. **Der Steckbrief** – Alle Daten, eigene Felder, Tags, „Nicht stören“ und Aktionen: anrufen, Bewertung anfragen, Rechnung schreiben.
4. **Der Verlauf** – Alles, was mit dem Kunden passiert ist: Nachrichten, Termine, Formulare, Käufe, Notizen, Aufgaben. Lies bei wichtigen Kunden einmal alles durch.
5. **Tags** – Tags steuern Newsletter, Workflows und Kurszugänge. Ändere sie bewusst – ein entfernter Tag kann z. B. einen Kurszugang entziehen.
6. **Firmen** *(Firmen)* – Kontakte gehören zu Firmen – automatisch über das Feld „Firma“ oder die E-Mail-Domain. Die Firmenseite zeigt alle Kontakte, Deals, Tickets und Aufgaben einer Firma.
7. **Doppelte Firmen** – Nach einer Übernahme gibt es Firmen oft doppelt („Muster GmbH“ und „Muster“). Such nach dem Namen und führ sie auf der Firmenseite mit „Zusammenführen“ zusammen.
8. **Eigene Objekte** *(Objekte)* – Gibt es eigene Objekte wie Projekte, Verträge oder Fahrzeuge? Sie stehen hier und in der Seitenleiste – mit Datensätzen und Verknüpfungen zu Kontakten und Firmen.
9. **Der Projekt-Steckbrief** *(Projekt)* – Was ist das Projekt, welche Ziele, welche Links, welche Server? Halte ihn aktuell – er ist das Gedächtnis der Firma.
10. **Website-Überwachung** – Grün = die Website antwortet. Alle 10 Minuten wird geprüft; bei einem Ausfall gibt es eine Meldung.
11. **Website eintragen** – Fehlt die Adresse, ist auch die Überwachung aus.
12. **Dokumente & Artefakte** – Konzepte, Berichte und Claude-Artefakte. Claude legt Berichte über die MCP-Werkzeuge direkt hier ab.
13. **Alle Dokumente** *(Agentur → Dokumente)* – Alle Dokumente aller Projekte an einem Ort – auch über Strg+K zu finden.
14. **Eigenschaften** *(Eigenschaften)* – Fehlt dir eine Information (z. B. „Vertragsende“)? Unter Eigenschaften legst du eigene Felder für Kontakte, Firmen, Deals und eigene Objekte an – in Gruppen und mit Hilfetext.

**Das hast du gelernt:**

- Einen Kunden finden und alles über ihn sehen
- Tags und Notizen sinnvoll nutzen
- Firmen, eigene Objekte und Eigenschaften
- Den Projekt-Steckbrief aktuell halten
- Website-Überwachung, Dokumente und Claude-Artefakte

Mehr dazu: [Funktionen: Kontakte & Projekte](../README.de.md#funktionen)

---

## Kapitel 5: Marketing

Kampagnen mit dem E-Mail-Designer, Social Planner, Workflows, Attribution, Affiliates, Werbung, Lead-Scoring und Marketing-Berichte. *(ca. 30 Minuten)*

1. **Was läuft gerade?** – Bei einer Übernahme zuerst schauen, was automatisch passiert: aktive Workflows, geplante Kampagnen, geplante Social-Posts. Erst verstehen, dann ändern.
2. **Kampagnen** *(Kampagnen)* – Newsletter per E-Mail oder SMS. Geplante Kampagnen gehen von selbst raus – prüfe, ob sie noch passen.
3. **Vorlagen & Designer** – Vorlagen nutzt der Posteingang und jeder Workflow. Gestaltet werden sie mit dem E-Mail-Designer (eigene Tour).
4. **Automationen** *(Automationen)* – Workflows laufen im Hintergrund – z. B. Willkommens-Mails, Erinnerungen, „Verpasster Anruf → SMS“. Status „aktiv“ heißt: läuft wirklich.
5. **Die Liste prüfen** – Öffne jeden aktiven Workflow einmal: Auslöser, Schritte, Verlauf. Was niemand mehr braucht, pausieren statt löschen.
6. **Social Planner** *(Social Planner)* – Geplante Posts für Instagram, Facebook, LinkedIn & Co. im Monatskalender.
7. **Woher kommen die Kunden?** *(Attribution → Bericht)* – Attribution zeigt Leads, Deals und Umsatz je Quelle, Kampagne oder Funnel – ganz ohne Fremd-Tracking.
8. **Werbung** – Sind Meta- oder Google-Ads verbunden: Kosten pro Lead und Umsatz pro Werbe-Euro je Kampagne. So siehst du, welche Anzeige sich lohnt.
9. **Affiliates** *(Affiliates)* – Partner, die dich empfehlen, bekommen Provision. Einmal im Monat: Provisionen freigeben und auszahlen.
10. **Lead-Scoring** *(Lead-Scoring)* – Punkte für passende Eigenschaften und Aktivität zeigen, wer kaufbereit ist. Ab einer Schwelle wie MQL oder SQL kann ein Workflow den Vertrieb informieren – prüfe, ob Regeln und Schwellen noch stimmen.
11. **Marketing-Dashboard** *(Berichte → Vorlagen)* – Die Vorlage „Marketing“ zeigt neue Leads, Lead → Deal, Leads je Quelle und Kampagnen-Performance – mit einem Klick als eigenes Dashboard.
12. **Tiefer einsteigen** – Für jeden Bereich gibt es eine Modul-Tour mit Übungen: Kampagnen, E-Mail-Designer, Workflows, „Webhook empfangen“, Social Planner, Attribution, Affiliates, Lead-Scoring und Berichte.

**Das hast du gelernt:**

- Was gerade an Kampagnen und Workflows läuft
- Wo Newsletter und Vorlagen gestaltet werden
- Social-Posts planen
- Woher Kunden kommen und was Werbung kostet
- Welche Leads kaufbereit sind (Lead-Scoring)

Mehr dazu: [Attribution, Affiliates & Werbung](growth.md)

---

## Kapitel 6: Websites & Funnels

Seiten-Builder, Blog, A/B-Tests, Formulare, Kalender-Buchung und eigene Domains. *(ca. 30 Minuten)*

1. **Alle Seiten** *(Funnels & Websites)* – Funnels (Abfolgen wie Anmeldung → Danke) und ganze Websites. Jede Karte zeigt Aufrufe und Domain.
2. **Die Liste** – Öffne jede Website einmal und klick auf „Live ↗“: Sieht alles richtig aus, stimmen Impressum und Datenschutz?
3. **Bearbeiten** – Seiten bestehen aus Blöcken (Hero, Text, Bild, Formular, Kalender, FAQ, Preise …) mit Live-Vorschau. Die Tour „Funnels & Websites“ zeigt es Schritt für Schritt.
4. **Blog** – Jede Website hat einen Blog (Reiter „Blog“ im Editor). Beiträge können geplant werden; Claude kann Entwürfe schreiben.
5. **A/B-Tests** – Je Seite kannst du zwei Versionen gegeneinander testen (Reiter „A/B-Test“) und den Gewinner mit einem Klick live schalten.
6. **Formulare** *(Formulare & Umfragen)* – Formulare und Umfragen legen Kontakte an und starten Workflows. Unter „Einsendungen“ siehst du alles, was reinkam.
7. **Formular-Liste** – Achte auf die Einsendungen: Kommt nichts mehr rein, ist vielleicht ein Formular kaputt oder von der Website verschwunden.
8. **Online-Buchung** *(Kalender)* – Kalender haben eine öffentliche Buchungsseite. – *So geht's:* Klicke auf **Kalender**.
9. **Buchungslink** – Diesen Link findest du auf Websites, in E-Mails und beim KI-Telefonagenten. Ändere ihn nicht leichtfertig.
10. **Domains** *(Agentur → Domains)* – Eigene Domains: A-Record beim Domain-Anbieter auf den Server, HTTPS kommt von selbst. Wichtig: Domains rechtzeitig verlängern!

**Das hast du gelernt:**

- Welche Websites und Funnels es gibt und wie man sie bearbeitet
- Wo Blog und A/B-Tests stecken
- Formulare und Buchungsseiten
- Wie Domains funktionieren

Mehr dazu: [Blog & Kurse](../README.de.md#blog--kurse)

---

## Kapitel 7: Kurse & Community

Online-Kurse, Mitgliederbereich und Community-Gruppen – Zugang, Moderation, Mitglieder. *(ca. 15 Minuten)*

1. **Kurse** *(Kurse)* – Kurse mit Modulen und Lektionen. Mitglieder lernen im Mitgliederbereich, ohne Passwort – sie bekommen einen Login-Link per E-Mail.
2. **Kursliste** – Status, Lektionen, Teilnehmer. Öffne einen Kurs, um Inhalt, Teilnehmer und Zugang zu sehen.
3. **Mitgliederbereich** – Adresse und Aussehen des Mitgliederbereichs. Ohne funktionierenden E-Mail-Versand kommen keine Login-Links an!
4. **Wie man Zugang bekommt** – Per Tag (z. B. kauf:kurs), beim Kauf eines Produkts, per Workflow oder von Hand. Wird der Tag entfernt, ist der Zugang weg.
5. **Community** *(Community)* – Gruppen mit Kanälen, Beiträgen, Terminen und Rangliste im Mitgliederbereich.
6. **Moderation** – Schau regelmäßig nach Meldungen: Beiträge ausblenden, löschen oder Mitglieder sperren. Beiträge als Team schreibst du in der Gruppe.

**Das hast du gelernt:**

- Wie Kurse aufgebaut sind und wie Mitglieder Zugang bekommen
- Den Mitgliederbereich (Login per E-Mail-Link)
- Community-Gruppen und Moderation

Mehr dazu: [Community](../README.de.md#community)

---

## Kapitel 8: Umsatz

Rechnungen & Angebote, Stripe, Produkte & Kauf-Links, Buchhaltung mit Norman, Verträge. *(ca. 30 Minuten)*

1. **Rechnungen** *(Rechnungen & Angebote)* – Oben: wie viel offen ist und wie viel bezahlt. Einmal pro Woche: Überfälliges nachfassen.
2. **Die Liste** – Status je Rechnung. Ein blaues **Norman**-Badge heißt: die Rechnung ist schon in der Buchhaltung.
3. **Angebote & Abos** – Angebote kann der Kunde online annehmen. Abos sind Rechnungen, die sich automatisch wiederholen – prüfe, ob alle noch laufen sollen.
4. **Rechnungsdaten** *(Einstellungen → Rechnungen)* – Nummernkreis, USt, Zahlungsziel – und ganz wichtig: Bankverbindung und Steuernummer. Ändert sich das Konto, hier anpassen.
5. **Stripe** *(Einstellungen → Stripe)* – Mit Stripe zahlen Kunden per Karte, SEPA oder Apple/Google Pay. „Live“ heißt echtes Geld, „Testmodus“ nicht.
6. **Webhook prüfen** – Steht hier „fehlt“, werden Zahlungen nicht automatisch verbucht. Die Anleitung steht direkt darunter.
7. **Produkte & Kauf-Links** *(Produkte)* – Leistungen mit Preisen. Mit Stripe hat jedes Produkt einen Kauf-Link (/buy/…), optional mit Order-Bump, Upsell und Rabattcodes.
8. **Buchhaltung mit Norman** – Bezahlte Rechnungen überträgt Claude über die MCP-Werkzeuge in Norman (Buchhaltung) – inklusive Beleg. Zuständig ist die Claude-Sitzung bzw. deine Steuerberatung; prüfe monatlich, ob alle Rechnungen das Norman-Badge haben.
9. **Verträge** *(Verträge)* – Verträge aus Vorlagen, online unterschrieben, mit Prüfsumme und Protokoll. Unterschriebene Verträge kannst du jederzeit als PDF drucken.

**Das hast du gelernt:**

- Offene und bezahlte Rechnungen im Blick
- Rechnungsdaten und Stripe prüfen
- Produkte, Kauf-Links und Abos
- Wie Rechnungen in die Buchhaltung (Norman) kommen
- Verträge online unterschreiben lassen

Mehr dazu: [Stripe & Zahlungen](stripe.md)

---

## Kapitel 9: Reputation

Bewertungen sammeln, Google-Profil verbinden, auf Rezensionen antworten. *(ca. 10 Minuten)*

1. **Bewertungen** *(Bewertungen)* – Durchschnitt und Verteilung. Ziel: regelmäßig neue Bewertungen – sie sind das stärkste Verkaufsargument.
2. **Anfragen** – Nach jedem abgeschlossenen Auftrag eine Anfrage senden – am besten automatisch per Workflow nach dem Termin.
3. **Google** – Neue Google-Rezensionen erscheinen hier. Beantworte jede – auch die schlechten, freundlich und sachlich.
4. **Widget** – Das Bewertungs-Widget zeigt gute Bewertungen auf der Website. Ist es eingebaut? Sonst Code kopieren und in die Website einfügen.
5. **Google-Profil verbinden** *(Einstellungen → Bewertungen)* – Mit verbundenem Unternehmensprofil antwortest du direkt aus HyperLevel und veröffentlichst Google-Beiträge.

**Das hast du gelernt:**

- Bewertungsanfragen senden
- Google-Rezensionen lesen und beantworten
- Das Bewertungs-Widget

Mehr dazu: [Google-Bewertungen](self-hosting.md#google-bewertungen)

---

## Kapitel 10: Service & Support

Tickets und SLAs, Zuweisung, Support-Postfach, Wissensdatenbank, Zufriedenheit (CSAT/NPS) und gefährdete Kunden im Health-Score. *(ca. 20 Minuten)*

1. **Service im Überblick** – Macht die Firma Kundenservice, läuft er über Tickets: jede Anfrage mit Nummer, Zuständigkeit und Frist. Bei einer Übernahme zuerst klären: Wer bearbeitet Tickets – und welche Fristen wurden Kunden versprochen?
2. **Offene Tickets** *(Tickets)* – Filtere auf „Nicht zugewiesen“ und „SLA: Überschritten“. Was dort steht, ist die dringendste Baustelle – verteile es zuerst.
3. **Die Liste** – Ein Klick öffnet das Ticket mit Verlauf, Antworten, internen Notizen, SLA und Zufriedenheit. Die Tour „Tickets“ zeigt alles Schritt für Schritt.
4. **Übersicht** *(Tickets → Übersicht)* – SLA-Quoten, Antwort- und Lösungszeiten, CSAT und NPS der letzten Wochen – so siehst du, wie gut der Service gerade läuft.
5. **Auslastung** *(Tickets → Auslastung)* – Wer hat wie viele offene, dringende und überfällige Tickets? Ist jemand überlastet oder geht, verteilst du hier um.
6. **SLAs & Zuweisung** *(Einstellungen → Service)* – Welche Fristen gelten je Priorität, und zählen nur Geschäftszeiten? Unter „Teams & Zuweisung“ steht, wer neue Tickets bekommt – prüfe, ob ehemalige Mitarbeiter noch in Teams sind.
7. **Support-Postfach** – Unter „E-Mail → Ticket“ steht, welche Mails zu Tickets werden. Die Weiterleitung beim Mail-Anbieter (z. B. support@…) gehört mit auf die Liste der Konten.
8. **Wissensdatenbank** *(Wissensdatenbank)* – Hilfe-Artikel fürs öffentliche Hilfe-Center – sie helfen auch beim Antworten und dem KI-Assistenten. Veraltete Artikel (Preise, Abläufe) zuerst überarbeiten.
9. **Zufriedenheit** *(Umfragen → Zufriedenheit (CSAT))* – Nach jedem gelösten Ticket bewertet der Kunde mit 1–5 Smileys. Lies die schlechten Bewertungen der letzten Wochen – und ruf bei Bedarf zurück.
10. **Gefährdete Kunden** *(Kontakte)* – Der Health-Score fasst Tickets, Bewertungen, Aktivität, offene Rechnungen und Deals zu einer Ampel zusammen. Filtere auf „kritisch“ – diese Kunden rufst du nach der Übernahme zuerst an.

**Das hast du gelernt:**

- Wo Kundenanfragen landen und wer sie bearbeitet
- SLA-Fristen, Teams und Zuweisung prüfen
- Wissensdatenbank und Hilfe-Center aktuell halten
- Zufriedenheit messen und gefährdete Kunden erkennen

Mehr dazu: [Service: Tickets, SLAs & mehr](helpdesk.md)

---

## Kapitel 11: KI

KI-Assistent im Posteingang und Chat, KI-Telefonagent und die Claude-Werkzeuge (MCP). *(ca. 20 Minuten)*

1. **KI-Assistent** *(Einstellungen → KI-Assistent)* – Claude schlägt im Posteingang Antworten vor, fasst zusammen und kann im Website-Chat antworten. Oben: an/aus, Modell, Verbrauch.
2. **Schlüssel & Kosten** – Der Anthropic-Schlüssel läuft über ein Anthropic-Konto der Firma – prüfe, wem es gehört und wohin die Rechnung geht.
3. **Wissen pflegen** – Ändern sich Preise, Leistungen oder Öffnungszeiten, hier nachziehen – sonst erzählt der Assistent Altes.
4. **Im Posteingang** *(Konversationen)* – Vorschläge erscheinen neben dem Verlauf. Gesendet wird nie automatisch.
5. **KI-Telefonagent** *(Einstellungen → Telefonie)* – Nimmt Anrufe an, bucht Termine und nimmt Nachrichten auf. Nach jedem Anruf gibt es eine Zusammenfassung am Kontakt.
6. **Claude-Werkzeuge (MCP)** *(Agentur → API & MCP)* – Über MCP arbeitet Claude direkt mit HyperLevel: Kontakte, Deals, Posteingang, Blog-Entwürfe, Berichte, Buchhaltung. Jede Änderung steht im Protokoll.
7. **Claude-Sitzungen** – Entwicklung und größere Aufgaben laufen in Claude-Sitzungen je Projekt (Projekt → Claude-Sitzungen). Dort steht auch, woran zuletzt gearbeitet wurde.

**Das hast du gelernt:**

- Was der KI-Assistent darf und was nicht
- Wissen und Limit pflegen
- Wie der KI-Telefonagent arbeitet
- Wie Claude über MCP mit der Firma arbeitet

Mehr dazu: [KI-Assistent](ai-assistant.md)

---

## Kapitel 12: Einstellungen & Integrationen

Kanäle, Telefonie, Stripe, Integrations-Katalog, Zapier/Make/n8n, HubSpot-Import, OAuth, Todoist, Supabase, Android-App, SaaS, White-Label, Domains, Snapshots. *(ca. 45 Minuten, nur für die Agentur)*

1. **Ein Wort zu Geheimnissen** – In allen Einstellungen gilt: Gespeicherte Passwörter, Tokens und Schlüssel werden nie wieder angezeigt. Musst du einen ändern, trägst du einfach den neuen ein – den alten brauchst du nicht.
2. **Firmendaten** *(Einstellungen → Firma)* – Name, Adresse, Telefon, E-Mail für Team-Benachrichtigungen – bei einer Übernahme meist das Erste, was sich ändert.
3. **E-Mail-Versand** *(Einstellungen → E-Mail & SMS)* – „Nur speichern“ heißt: Es geht keine E-Mail raus. Prüfe, dass SMTP eingerichtet ist und schick dir eine Testnachricht.
4. **Kanäle** *(Einstellungen → Kanäle)* – WhatsApp, Messenger und Instagram über die Meta-App. Die Tokens gehören zu einem System-Benutzer im Meta Business Manager der Firma.
5. **Telefonie** *(Einstellungen → Telefonie)* – Twilio-Zugang und Nummer, Weiterleitung, Voicemail, Browser-Telefon und KI-Telefonagent.
6. **Stripe** *(Einstellungen → Stripe)* – Das Stripe-Konto des Sub-Accounts. Zugang zum Stripe-Dashboard gehört in den Passwort-Manager.
7. **Integrations-Katalog** *(Apps)* – Der Katalog zeigt je Sub-Account, welche Integrationen eingerichtet, unvollständig oder offen sind – mit direktem Weg zur Einstellung. Ideal als Checkliste bei der Übernahme.
8. **Zapier, Make & n8n** *(Einstellungen → API & Webhooks)* – Welche Automatisierungs-Tools hängen am System? Jedes Abo zeigt Quelle und letzte Antwort. Unbekanntes pausieren – und klären, wem das Zapier-, Make- oder n8n-Konto gehört.
9. **Umzug aus HubSpot** *(Einstellungen → Import)* – Kommt die Firma aus HubSpot (oder GoHighLevel)? Hier holst du die Daten herüber – mit Probelauf und mehrfach ausführbar. Danach den HubSpot-Token wieder trennen.
10. **Google & Microsoft** *(Agentur → Integrationen)* – Die OAuth-Apps der Agentur für Kalender-Sync und Google-Profil. Sie gehören zu einem Google-Cloud- bzw. Microsoft-Konto der Firma.
11. **Postfächer** – IMAP-Abgleich der Postfächer mit Regeln, welche Mail in welches Projekt kommt.
12. **Todoist** – Abgleich der Aufgaben mit Todoist – läuft mit dem Todoist-Konto, dessen Token hier hinterlegt ist. Bei einem Wechsel: neuen Token eintragen.
13. **Supabase-Spiegel** – Spiegelt Daten in eine Supabase-Datenbank für andere Projekte. Nicht genutzt? Einfach aus lassen.
14. **App fürs Handy** *(Einstellungen → Mein Konto)* – Die Android-App bringt Posteingang, Aufgaben, Zahlen und Widgets aufs Handy (QR-Code unter „Zur App“, gekoppelte Handys unter „Geräte (App)“ – fremde abmelden). Auf iPhone und iPad läuft HyperLevel als Web-App vom Home-Bildschirm, mit Mitteilungen und Zahl auf dem Symbol.
15. **SaaS-Modus** *(Agentur → SaaS)* – Verkauft HyperLevel als Abo an Kunden – mit eigenem Agentur-Stripe. Prüfe die laufenden Kunden-Abos.
16. **White-Label** *(Agentur → White-Label)* – Name, Logo, Farbe, Login-Texte und **Support-E-Mail** – die solltest du bei der Übernahme auf dich ändern.
17. **Domains** *(Agentur → Domains)* – Alle Domains mit Status. Die Domains selbst liegen beim Domain-Anbieter – Ablaufdaten im Kalender eintragen!
18. **Snapshots** *(Agentur → Snapshots)* – Startpakete für neue Kunden. Exportiere deine wichtigsten Snapshots einmal als Datei – das ist zugleich eine Sicherung deiner Vorlagen.

**Das hast du gelernt:**

- Welche Integrationen es gibt und wo sie eingestellt werden
- Dass Geheimnisse nie wieder angezeigt werden – nur ersetzt
- Automatisierungs-Tools, Importe und gekoppelte Handys prüfen
- Agentur-weite Einstellungen: White-Label, Domains, SaaS, Snapshots

Mehr dazu: [Betrieb & Integrationen](self-hosting.md)

---

## Kapitel 13: Betrieb

Backups, Protokoll, die wöchentliche Server-Ressourcen-Routine und was zu tun ist, wenn eine Website down ist. *(ca. 20 Minuten, nur für die Agentur)*

1. **Backups** *(Einstellungen → Sub-Accounts)* – Täglich automatisch, die letzten 14 bleiben auf dem Server. Lade jetzt eins herunter und leg es an einen zweiten Ort – monatlich wiederholen. – *So geht's:* Klicke auf **Jetzt herunterladen**.
2. **Was im Backup ist** – Die komplette Datenbank (alle Sub-Accounts, Kontakte, Rechnungen …). Bilder und Uploads liegen zusätzlich im Datenordner des Servers – die sichert der Server-Anbieter mit.
3. **Das Protokoll** *(Agentur → Protokoll)* – Jede Änderung mit Zeit, Person und Weg (Oberfläche, API, MCP). Wenn etwas „von allein“ anders ist, findest du hier die Ursache.
4. **Wöchentliche Server-Routine** – Einmal pro Woche (10 Minuten): 1) Letztes Backup von heute? 2) Alle Websites grün? 3) Im Server-Panel (z. B. Hostinger → VPS) CPU, Arbeitsspeicher und Speicherplatz ansehen – über 80 % Speicher heißt: alte Backups/Logs aufräumen oder Paket vergrößern. 4) Gibt es Warnungen beim Domain- oder Server-Anbieter?
5. **Website down – Schritt 1** *(Agentur → Projekte)* – Ein roter Punkt heißt: Die Website antwortet nicht. Öffne sie selbst im Browser (auch am Handy ohne WLAN) – vielleicht war es nur kurz.
6. **Website down – Schritt 2** – Dauert es an: Beim Domain-Anbieter prüfen, ob die Domain bezahlt ist und der A-Record auf den Server zeigt. Dann im Server-Panel prüfen, ob der Server läuft – notfalls neu starten.
7. **Website down – Schritt 3** – Hilft das nicht: Öffne die Claude-Sitzung des Projekts (Strg+K → „Claude: …“) und beschreib, was du siehst. Kunden kurz informieren – ehrlich und mit einer Zeitangabe.
8. **Meldungen aufs Handy** *(Einstellungen → Mein Konto)* – Mit Push erfährst du sofort, wenn eine Website ausfällt – und wenn sie wieder läuft.
9. **Updates** – Neue Versionen von HyperLevel spielt ein Entwickler bzw. Claude ein (siehe Claude-Sitzung). Vorher immer ein Backup anlegen; Datenbank-Änderungen laufen beim Start automatisch.

**Das hast du gelernt:**

- Backups herunterladen und sicher ablegen
- Im Protokoll nachvollziehen, wer was geändert hat
- Die wöchentliche Server-Routine
- Der Notfallplan bei einer ausgefallenen Website

Mehr dazu: [Backup](../README.de.md#backup)

---

## Kapitel 14: Abschluss-Checkliste

Alles abhaken: Zugänge, Versand, Zahlungen, Backups, Websites, Automationen – dann ist die Firma übernommen. *(ca. 15 Minuten, nur für die Agentur)*

1. **Der Übergabe-Status** *(Akademie)* – Geh die offenen Punkte von oben nach unten durch. Jeder Punkt hat einen Link dorthin, wo er erledigt wird.
2. **☐ Zugänge** – Alle Passwörter im Passwort-Manager, 2FA bei allen Admins, alte Zugänge, Schlüssel und fremde Handys (Geräte der App) entfernt, Konten bei Domain-, Server-, Zahlungs- und KI-Anbietern auf dich umgestellt.
3. **☐ Versand** – E-Mail-Versand eingerichtet und mit einer Testnachricht geprüft; SMS/WhatsApp, falls genutzt, ebenfalls.
4. **☐ Geld** – Bankverbindung und Steuernummer auf Rechnungen stimmen, Stripe-Webhook eingerichtet, Abos geprüft, Buchhaltung (Norman) auf dem Stand.
5. **☐ Sicherheit des Betriebs** – Ein Backup liegt außer Haus, alle Websites sind grün, Domains verlängert, die wöchentliche Server-Routine steht im Kalender.
6. **☐ Automatik** – Du kennst alle aktiven Workflows, geplanten Kampagnen/Posts, Berichte per E-Mail und die Abos von Zapier, Make oder n8n. Was nicht mehr passen soll, ist pausiert.
7. **☐ Service** – Offene Tickets sind verteilt, SLA-Ziele und Teams stimmen, das Support-Postfach leitet an HyperLevel weiter und die Hilfe-Artikel sind aktuell.
8. **☐ Kunden & Team** – Support-E-Mail und Absender auf dich geändert, Team informiert, wichtigste Kunden persönlich kontaktiert.
9. **Das Handbuch** *(Akademie → Handbuch)* – Druck dir das Handbuch aus oder speichere es als PDF – für den Ordner im Büro.
10. **Geschafft!** *(Akademie)* – Du hast die Firma übernommen. 🎉 Die Modul-Touren bleiben zum Nachschlagen – und das **?** oben rechts hilft auf jeder Seite.

**Das hast du gelernt:**

- Alle Zugänge gehören dir und sind gesichert
- Versand, Zahlungen und Backups funktionieren
- Du weißt, was automatisch passiert und wo du nachsiehst
- Das Handbuch liegt ausgedruckt bereit

Mehr dazu: [Handbuch](handbuch.md)

---

## Anhang: Alle Modul-Touren

Neben dem Gesamt-Guide gibt es für jeden Bereich eine kurze Tour (5–15 Schritte). Du findest sie in der Akademie oder über das **?** oben rechts auf jeder Seite.

### Erste Schritte

- **So findest du dich zurecht** (10 Schritte, ca. 5 Min.) – Menü, Projekt-Wechsler, Suche, Strg+K und das „?“ – die Oberfläche in fünf Minuten.
- **Die Akademie & die Übungs-Firma** (7 Schritte, ca. 4 Min.) – Gesamt-Guide, Modul-Touren, Abzeichen, Übergabe-Status und das Handbuch.
- **Rückgängig, Verlauf und Papierkorb** (8 Schritte, ca. 3 Min.) – Jede Änderung lässt sich zurücknehmen: Hinweis nach der Änderung, Strg+Z, Verlauf und Papierkorb.
- **Fehler melden & Wunschliste** (15 Schritte, ca. 4 Min.) – Einen Fehler mit Screenshot melden, Antworten unter „Meine Meldungen“ lesen und für neue Funktionen abstimmen.

### Kurs: Deine Firma führen

- **Firmen-Setup: Branding, Team, Rechte, Steuerdaten** (6 Schritte, ca. 15 Min.) – Firmendaten, Logo und Farben, Steuer- und Rechnungsdaten, das Team mit den richtigen Rechten – das Fundament für alles Weitere.
- **Vertrieb: Pipeline, Lead-Scoring, Sequenzen, Angebote** (6 Schritte, ca. 15 Min.) – Vom Interessenten zum Kunden: eine Pipeline, die zu deinem Verkaufsprozess passt, Lead-Scoring, persönliche Sequenzen und Angebote mit Unterschrift.
- **Marketing: Funnels, Formulare, E-Mail, Social, Attribution** (6 Schritte, ca. 15 Min.) – Landingpage und Warteliste, Formulare mit Double-Opt-in, Newsletter, Social Planner und die Frage, welcher Kanal wirklich Kunden bringt.
- **Kundenservice: Posteingang, Helpdesk, SLAs, Wissensdatenbank** (6 Schritte, ca. 15 Min.) – Alle Kanäle in einem Posteingang, Tickets mit SLA, eine Wissensdatenbank, die Fragen beantwortet, bevor sie gestellt werden.
- **Finanzen: Rechnungen, SEPA, Mahnwesen, DATEV, Gewinnrechner** (6 Schritte, ca. 20 Min.) – Rechnungen mit XRechnung/ZUGFeRD, Lastschrift per SEPA, automatisches Mahnwesen, DATEV-Export, Buchhaltung light und der Gewinnrechner für deine Preise.
- **Projekte & Zeit** (6 Schritte, ca. 10 Min.) – Aufgaben, Projekte, wiederkehrende Routinen und Zeiterfassung – damit die Roadmap und deine Woche nicht im Kopf leben.
- **KI-Mitarbeiter & Automatisierung** (6 Schritte, ca. 15 Min.) – Workflows, die dir Routine abnehmen, und KI-Agenten mit klaren Grenzen: Entwürfe, Freigaben, Protokoll – nichts geht ungeprüft an Kunden.
- **Kennzahlen & Wochen-Routine** (6 Schritte, ca. 15 Min.) – Das CEO-Cockpit mit MRR, ARR, Testphasen, Conversion, Kündigungen, Quellen und SLA – und ein Wochen-Review in 30 Minuten.
- **Datenschutz & Compliance: DSGVO, AVV, Aufbewahrung, GoBD** (6 Schritte, ca. 15 Min.) – Einwilligungen mit Nachweis, Auftragsverarbeitung, Löschfristen und unveränderbare Belege – was die App übernimmt und was du selbst regeln musst.
- **Skalieren: Team, Rollen, Snapshots, Agentur-Modus** (6 Schritte, ca. 15 Min., Agentur) – Wenn es mehr wird: Rollen statt Einzelrechte, Vorlagen statt Handarbeit, Agentur-Modus für Partner – und wann du einstellst statt automatisierst.

### Kunden & Tagesgeschäft

- **Dashboard lesen** (7 Schritte, ca. 3 Min.) – Kennzahlen, neue Kontakte, Termine, Pipeline und Lead-Quellen auf einen Blick.
- **Projekt-Steckbrief & Website-Überwachung** (11 Schritte, ca. 5 Min.) – Status, Website-Check alle 10 Minuten, Ziele, Dokumente, Claude-Sitzungen und Server-Hinweise je Projekt.
- **Posteingang: alle Nachrichten an einem Ort** (7 Schritte, ca. 5 Min.) – E-Mail, SMS, Chat, WhatsApp, Messenger, Instagram und Anrufe – lesen, filtern, antworten.
- **Anrufe & Browser-Telefon** (7 Schritte, ca. 4 Min.) – Anrufliste, verpasste Anrufe, Voicemails, Zurückrufen und Telefonieren direkt im Browser.
- **Kalender & Online-Buchung** (9 Schritte, ca. 6 Min.) – Termine sehen, Kalender mit Buchungsseite anlegen, Verfügbarkeit und Erinnerungen einstellen.
- **Kalender-Sync mit Google & Outlook** (7 Schritte, ca. 4 Min.) – Den eigenen Google- oder Outlook-Kalender verbinden, damit nichts doppelt gebucht wird.
- **Kontakte verwalten** (13 Schritte, ca. 7 Min.) – Suchen, filtern, anlegen, Tags vergeben, Verlauf lesen, importieren und exportieren.
- **Pipeline & Deals** (10 Schritte, ca. 5 Min.) – Deals als Karten durch die Stufen ziehen, Werte pflegen, gewonnen/verloren markieren.
- **Aufgaben** (7 Schritte, ca. 3 Min.) – To-dos anlegen, mit Fälligkeit versehen, abhaken – auch am Kontakt.
- **Power-Dialer: Anruflisten abarbeiten** (7 Schritte, ca. 6 Min.) – Aus Smart Lists oder Tags eine Anrufliste machen, Kontakt für Kontakt anrufen, das Ergebnis festhalten, Rückrufe vereinbaren – und dabei Einwilligung, „Nicht stören“ und Anrufzeiten automatisch einhalten.
- **Team-Posteingang: zuweisen, zurückstellen, notieren** (13 Schritte, ca. 7 Min.) – Wer macht was: Ansichten, Zuständige, Status, Zurückstellen, interne Notizen, Antwortfristen und die Regeln für neue Konversationen.
- **Team-Kalender: Round Robin, Fragen, Zahlung, Video** (13 Schritte, ca. 8 Min.) – Buchungen im Team verteilen, Fragen stellen, bei der Buchung bezahlen lassen, Video-Links erzeugen und Routing-Formulare nutzen.
- **Projektplanung: Projekte, Board & Gantt** (15 Schritte, ca. 8 Min.) – Projekte mit Aufgaben, Unteraufgaben und Abhängigkeiten planen – als Liste, Board, Kalender oder Gantt-Diagramm.
- **Zeiterfassung: Timer, Wochenzettel, Abrechnung** (14 Schritte, ca. 6 Min.) – Zeit per Timer oder nachträglich erfassen, Wochen freigeben, Berichte auswerten und Rechnungen daraus machen.
- **Berichte & Dashboards** (11 Schritte, ca. 7 Min.) – Dashboard aus Vorlage, Zeitraum und Filter, teilen, per E-Mail verschicken – und eigene Berichte bauen.
- **Firmen** (12 Schritte, ca. 6 Min.) – Firmenliste mit Ansichten, automatische Zuordnung per E-Mail-Domain, die Firmenseite mit Verknüpfungen – und Dubletten zusammenführen.
- **Eigene Objekte & Verknüpfungen** (14 Schritte, ca. 7 Min.) – Eigene Datensatz-Typen wie Fahrzeuge oder Verträge: Objekt-Builder, Datensätze und Verknüpfungen mit Labels.
- **Eigenschaften & Gruppen** (12 Schritte, ca. 5 Min.) – Eigene Felder für Kontakte, Firmen, Deals und eigene Objekte – in Gruppen, mit Typ und Hilfetext – und die Labels für Verknüpfungen.
- **Wiki: Wissen im Team festhalten** (12 Schritte, ca. 7 Min.) – Seiten in Bereichen und Ebenen, mit Live-Karten aus dem CRM, Checklisten, Kommentaren, Verlauf und Freigabe-Link.
- **Team-Chat: schnell abstimmen** (9 Schritte, ca. 6 Min.) – Kanäle, Direktnachrichten und Threads – mit Karten aus dem CRM, Befehlen wie /aufgabe und dem KI-Agenten.
- **Living Boards: dein Arbeitsplatz, wie du ihn willst** (12 Schritte, ca. 7 Min.) – Setze dir aus Bausteinen eine eigene Startseite zusammen – per Ziehen oder indem du dem Board sagst, was du sehen willst – mit Verlauf und Rückgängig.
- **Sequenzen: Neukunden in mehreren Schritten ansprechen** (11 Schritte, ca. 7 Min.) – Aus dem eigenen Postfach: E-Mails, Aufgaben und Anrufe mit Wartezeiten – und Schluss, sobald jemand antwortet.
- **Quoten, Dubletten und Zugriff** (10 Schritte, ca. 8 Min.) – Ziele und Rangliste fürs Team, doppelte Kontakte sauber zusammenführen und festlegen, wer welche Datensätze sieht.

### Marketing

- **Kampagnen & Newsletter** (11 Schritte, ca. 7 Min.) – E-Mail- oder SMS-Newsletter an Tags oder Smart Lists – mit Testversand und Planung.
- **E-Mail-Marketing: Segmente, Tests & Zustellbarkeit** (13 Schritte, ca. 8 Min.) – Fertige Vorlagen, Zielgruppen nach Verhalten, A/B-Tests, Bestzeit-Versand und Zustellbarkeit – für mehr Öffnungen und weniger Spam-Ordner.
- **E-Mail-Designer** (10 Schritte, ca. 6 Min.) – Schöne E-Mails per Drag & Drop: Abschnitte, Blöcke, Vorschau am Handy, Testmail.
- **Automationen (Workflows)** (11 Schritte, ca. 8 Min.) – Auslöser → Aktionen: automatisch E-Mails senden, Tags setzen, Aufgaben anlegen, warten, verzweigen.
- **Social Planner** (5 Schritte, ca. 4 Min.) – Posts für Instagram, Facebook, LinkedIn & Co. planen – im Monatskalender.
- **Video-Studio** (8 Schritte, ca. 5 Min.) – Aus langen Videos KI-gewählte Shorts mit Untertiteln – prüfen, anpassen und im Social Planner einplanen.
- **Attribution & Werbung** (9 Schritte, ca. 6 Min.) – Woher Leads und Umsatz kommen – UTM, Kampagnen, Funnels – plus Kosten pro Lead und ROAS aus Meta/Google Ads.
- **Affiliates (Partnerprogramm)** (8 Schritte, ca. 5 Min.) – Partner empfehlen dich mit eigenem Link – Provisionen freigeben und auszahlen.
- **Workflows: Schritte finden und einstellen** (12 Schritte, ca. 6 Min.) – Über 130 Aktionen und über 140 Auslöser: Auswahl mit Suche und Hilfe, Formulare je Schritt, Auslöser nach Thema und Filter für jeden Auslöser.
- **Workflows: testen, Versionen und Austausch** (9 Schritte, ca. 5 Min.) – Mit Beispieldaten testen, das Protokoll je Schritt lesen, Entwürfe veröffentlichen, Versionen zurückholen und Workflows als JSON austauschen.
- **Lead-Scoring: MQL & SQL** (12 Schritte, ca. 7 Min.) – Punkte für passende Eigenschaften und Aktivität, Schwellen wie MQL und SQL, Zerfall – und der Score an Kontakt und Kontaktliste.
- **Canvas: zeichnen, planen, gestalten** (15 Schritte, ca. 8 Min.) – Unendliche Boards mit Formen, Pfeilen, Notizen und Designs – mit Live-Karten aus dem CRM, KI-Zeichnen und gemeinsamer Arbeit.
- **Anzeigen: Meta & Google** (15 Schritte, ca. 8 Min.) – Kampagnen bei Facebook, Instagram und Google direkt in HyperLevel anlegen, prüfen, steuern – alles startet pausiert, Geld fließt erst nach deiner Bestätigung.
- **Webinare: Automatisiert anmelden und verkaufen** (15 Schritte, ca. 8 Min.) – Ein Video zum Termin abspielen, Anmeldungen einsammeln, erinnern, Fragen und Angebot einblenden – und sehen, wer wie lange dabei war.
- **Kommentar-zu-DM auf Instagram und Facebook** (9 Schritte, ca. 6 Min.) – Auf ein Stichwort im Kommentar öffentlich antworten, privat den Link schicken und den Kontakt anlegen.
- **„Webhook empfangen“ in Workflows** (10 Schritte, ca. 6 Min.) – Daten aus Shops, Typeform & Co. per Webhook annehmen: geheime URL, Test-Daten, Feldzuordnung und Signatur.

### Websites, Kurse & Community

- **Funnels & Websites bauen** (13 Schritte, ca. 8 Min.) – Landingpages und ganze Websites aus Blöcken – mit Live-Vorschau, SEO und eigener Domain.
- **Website-Baukasten: Vorlagen, Abschnitte & Design** (9 Schritte, ca. 9 Min.) – Aus einer von 23 Vorlagen starten, Abschnitte mit Spalten ziehen, für Handy und Tablet feinschleifen, Farben und Kopfzeile einmal für die ganze Website festlegen.
- **Sammlungen, Weiterleitungen, Barrierefreiheit & Statistik** (9 Schritte, ca. 8 Min.) – Team, Projekte oder Produkte als Sammlung pflegen, alte Adressen weiterleiten, die Seite auf Barrierefreiheit prüfen und je Schritt sehen, wo Besucher abspringen.
- **Blog schreiben** (6 Schritte, ca. 5 Min.) – Beiträge in Markdown mit Titelbild – Entwurf, geplant oder veröffentlicht, mit RSS und Sitemap.
- **A/B-Tests** (5 Schritte, ca. 5 Min.) – Zwei Versionen einer Seite gegeneinander testen – mit Ziel, Aufteilung und Gewinner per Klick.
- **Formulare & Umfragen** (14 Schritte, ca. 8 Min.) – Felder bauen, Leads ins CRM schicken, Workflows starten, einbetten – auch Frage für Frage, mit Punkten und fertigen Vorlagen.
- **Kurse & Mitgliederbereich** (14 Schritte, ca. 9 Min.) – Online-Kurse mit eigenem Video, Modulen und Lektionen – Zugang per Tag, Kauf, Workflow oder von Hand; Lernpfade, Cohorts, Diskussion und Auswertung.
- **Community** (15 Schritte, ca. 10 Min.) – Gruppen mit Kanälen, Beiträgen, Terminen, Punkten und Rangliste – mit öffentlicher Beitrittsseite, Bezahl-Stufen, Zahlen, Challenges, Live-Calls und Nachrichten.
- **Quiz, Aufgaben und Zertifikate** (10 Schritte, ca. 8 Min.) – Wissen prüfen, Aufgaben abnehmen und Zertifikate mit PDF und Prüfseite ausstellen.

### Umsatz

- **Rechnungen & Angebote** (15 Schritte, ca. 7 Min.) – Rechnung schreiben, festschreiben, als PDF/XRechnung senden, Zahlungen erfassen, stornieren – GoBD-konform, mit Angeboten und Abos.
- **Produkte & Kauf-Links** (7 Schritte, ca. 5 Min.) – Leistungen mit Preisen anlegen – und mit Stripe als Kaufseite /buy/… verkaufen, inkl. Order-Bump und Upsell.
- **Stripe verbinden & Order-Bumps** (5 Schritte, ca. 5 Min.) – Online-Zahlung per Karte, SEPA, Apple/Google Pay – Schlüssel, Webhook, Testmodus, Order-Bump und Upsell.
- **Verträge online unterschreiben** (5 Schritte, ca. 4 Min.) – Vorlagen mit Platzhaltern, Link zum Unterschreiben, Prüfsumme und Protokoll.
- **Buchhaltung light: Belege, Buchungen, DATEV** (14 Schritte, ca. 8 Min.) – Belege sammeln, Buchungen vorbereiten, Bank abgleichen und alles dem Steuerberater übergeben – ohne zertifizierte Software zu ersetzen.
- **Lager & Einkauf** (11 Schritte, ca. 6 Min.) – Artikel, Bestände und Lagerorte, Mindestbestand mit Warnung, Bestellungen beim Lieferanten, Inventur und Lagerbewertung.
- **Gewinnrechner: Was bleibt übrig?** (15 Schritte, ca. 8 Min.) – Preise, Kundenzahl, Kosten und Steuern eintragen und sofort sehen, was nach allem übrig bleibt – mit Tabelle, Break-even, Prognose und Szenarien.
- **Ratenzahlung: Kunden zahlen in Raten** (8 Schritte, ca. 5 Min.) – Einen Ratenplan an ein Produkt hängen, auf der Kaufseite anbieten und sehen, wer wie weit gezahlt hat.
- **Mahnwesen: Zahlungsausfälle und überfällige Rechnungen** (14 Schritte, ca. 8 Min.) – Fehlgeschlagene Abo-Zahlungen auffangen, überfällige Rechnungen nachfassen und Kunden ihr Abo selbst verwalten lassen.
- **SEPA: Lastschrift ohne Zahlungsanbieter** (12 Schritte, ca. 7 Min.) – Mandate einholen, offene Rechnungen per Lastschrift einziehen, Rücklastschriften erfassen und Überweisungsdateien für Lieferanten erzeugen.
- **Angebote: vom Deal bis zur Unterschrift** (11 Schritte, ca. 8 Min.) – Positionen am Deal, ein Angebot mit Optionen und Anzahlung, Online-Unterschrift und Rechnung.
- **Buchhaltung: Lexware Office & sevDesk** (6 Schritte, ca. 4 Min.) – Festgeschriebene Rechnungen gehen von selbst an Lexware Office oder sevDesk, Zahlungseingänge kommen zurück – und gewonnene Deals auf Wunsch an Google Ads.

### Reputation

- **Bewertungen sammeln** (7 Schritte, ca. 4 Min.) – Bewertungsanfragen senden: 4–5★ gehen zu Google, Kritik bleibt intern – plus Widget für die Website.
- **Google-Unternehmensprofil** (5 Schritte, ca. 4 Min.) – Profil verbinden: alle Rezensionen, direkt antworten, Google-Beiträge veröffentlichen.

### Service & Support

- **Tickets: Kundenanfragen bearbeiten** (14 Schritte, ca. 8 Min.) – Filtern, Ansichten, ein Ticket anlegen, antworten oder notieren, SLA im Blick – und Übersicht und Auslastung des Teams.
- **Wissensdatenbank & Hilfe-Center** (11 Schritte, ca. 6 Min.) – Hilfe-Artikel in Kategorien schreiben, veröffentlichen und im öffentlichen Hilfe-Center zeigen – auch als Vorschlag beim Antworten.
- **Umfragen (CSAT & NPS) und Health-Score** (9 Schritte, ca. 6 Min.) – Zufriedenheit nach gelösten Tickets, Weiterempfehlung per NPS-Umfrage und die Kunden-Ampel aus allen Signalen.
- **Service einrichten: SLAs, Teams & Zuweisung** (12 Schritte, ca. 10 Min.) – SLA-Ziele und Geschäftszeiten, Ticket-Pipelines, Teams und Zuweisungsregeln, E-Mail → Ticket, Antworten, CSAT, Portal und Health-Score.

### KI

- **Gespräche auswerten: Zusammenfassung, Aufgaben, Scorecards** (9 Schritte, ca. 6 Min.) – Aufgezeichnete Anrufe und Meeting-Aufnahmen transkribieren und auswerten: Zusammenfassung, Aufgaben, Stimmung, Redeanteil, Füllwörter – und mit Scorecards bewerten.
- **KI-Assistent einrichten** (10 Schritte, ca. 6 Min.) – Claude schlägt Antworten vor, fasst zusammen, betreut den Website-Chat – mit eigenem Schlüssel und Monatslimit.
- **KI-Telefonagent** (6 Schritte, ca. 5 Min.) – Claude nimmt Anrufe an, bucht Termine, nimmt Nachrichten auf und verbindet weiter.
- **KI-Werkzeuge verbinden (Codex, ChatGPT, Claude)** (10 Schritte, ca. 5 Min.) – Codex, Claude Code, Cursor, ChatGPT und Claude.ai arbeiten direkt mit HyperLevel – per eigenem Schlüssel oder per Anmeldung (OAuth).
- **Claude-Werkzeuge (MCP)** (5 Schritte, ca. 4 Min., Agentur) – Claude & Co. arbeiten direkt mit HyperLevel: Kontakte, Deals, Posteingang, Blog-Entwürfe, Berichte.
- **Der KI-Agent** (10 Schritte, ca. 5 Min.) – Ein KI-Mitarbeiter auf jeder Seite: sucht, fasst zusammen, legt an und erledigt Aufgaben – mit Bestätigung vor Änderungen.
- **KI-Anbieter (BYOK)** (8 Schritte, ca. 4 Min.) – Jedes Modell mit deinem eigenen Schlüssel: OpenAI, Anthropic, Gemini, OpenRouter, Groq, lokale Modelle, fal.ai, kie.ai und mehr.
- **AI Studio: Apps im Chat bauen (Beta)** (5 Schritte, ca. 3 Min.) – Mit deinem eigenen Claude-, OpenAI- oder OpenRouter-Key kleine Apps und Websites im Chat bauen, in der Vorschau prüfen und unter einer eigenen Adresse veröffentlichen.
- **KI-Studio: Bilder, Videos & Sprache** (12 Schritte, ca. 5 Min.) – Mit deinem eigenen KI-Anbieter (fal.ai, kie.ai, Replicate, OpenAI, Gemini, ElevenLabs …) Bilder, Videos, Musik und Sprache erzeugen – mit jedem Modell.
- **Werkstatt: Wünsche bauen lassen** (15 Schritte, ca. 6 Min.) – Aus einem Wunsch wird ein Plan, nach deiner Bestätigung eine Einrichtung oder ein eigenes Plugin – erst nur für dich.
- **Marktplatz: Plugins entdecken und installieren** (8 Schritte, ca. 4 Min.) – Plugins mit Kategorien, Suche, Live-Vorschau und Bewertungen – installieren mit einer klaren Berechtigungsliste.
- **Stimme & Spracherkennung** (10 Schritte, ca. 6 Min.) – Eigene Stimme für Telefonagent und KI-Agent, Mikrofon-Taste, Voicemail als Text – mit deinem Anbieter (ElevenLabs, OpenAI, Deepgram, lokal …).
- **Workflows mit KI bauen** (8 Schritte, ca. 5 Min.) – Einen Ablauf in Alltagssprache beschreiben, den Vorschlag prüfen und als Entwurf speichern.

### Einstellungen & Kanäle

- **Telefonmenü, Zeitpläne und Warteschlangen** (9 Schritte, ca. 7 Min.) – Anrufer mit einer Ansage begrüßen, per Taste verteilen, Öffnungszeiten und Feiertage beachten, in Gruppen und Warteschlangen klingeln lassen – und den Ablauf vorab testen.
- **Nummern kaufen, zuordnen und Anrufe nach Quelle** (5 Schritte, ca. 6 Min.) – Rufnummern bei Twilio kaufen und freigeben, jeder Nummer ein Ziel geben, Tracking-Nummern je Kampagne und Pool-Nummern für die Website – mit Auswertung der Anrufe nach Quelle.
- **Postfach verbinden: Gmail & Outlook** (12 Schritte, ca. 5 Min.) – Gmail oder Outlook direkt verbinden: Mails im Posteingang, aus HyperLevel im selben Thread antworten, archivieren, Labels, Entwürfe und geplantes Senden.
- **Raum-Modus und XR: mit Blick, Pinch und Brille arbeiten** (9 Schritte, ca. 5 Min.) – Große Ziele für Vision Pro, Quest und Android XR, vier Seiten nebeneinander auf dem Riesen-Bildschirm der Brille – und Boards als schwebende Panels im Raum.
- **Dein Konto absichern** (6 Schritte, ca. 4 Min.) – Passwort, Zwei-Faktor-Login, angemeldete Geräte und hell/dunkel.
- **Darstellung anpassen** (11 Schritte, ca. 5 Min.) – Theme, Akzentfarbe, Bereichsfarben, schmale Seitenleiste, Icon-Pack und welche Bereiche im Menü stehen.
- **App & Push-Benachrichtigungen** (5 Schritte, ca. 3 Min.) – HyperLevel als App installieren und Push für Nachrichten, Website-Ausfälle, Aufgaben und Zahlungen.
- **Einstellungen: die Grundlagen** (11 Schritte, ca. 7 Min.) – Firmendaten, E-Mail- und SMS-Versand, Rechnungsdaten, eigene Felder & Tags, API.
- **Einwilligung & Recht** (11 Schritte, ca. 8 Min.) – Einwilligungen nachweisbar einholen, Cookie-Banner, Rechtstexte und Bestellseite nach deutschem Recht – als Entwurf, nicht als Rechtsberatung.
- **Kanäle: WhatsApp, Messenger, Instagram** (5 Schritte, ca. 5 Min.) – Die Meta-App verbinden, damit WhatsApp-, Messenger- und Instagram-Nachrichten im Posteingang landen.
- **Weitere Kanäle: Telegram, Discord, Slack, Push** (7 Schritte, ca. 6 Min.) – Telegram-Bot, Discord-Community, Slack fürs Team und Browser-Push an Kontakte verbinden.
- **Telefonie & Browser-Telefon** (5 Schritte, ca. 6 Min.) – Twilio verbinden, Weiterleitung, Geschäftszeiten, Voicemail – und Telefonieren im Browser.
- **Website-Chat** (5 Schritte, ca. 3 Min.) – Chat-Blase für jede Website – Nachrichten landen im Posteingang, optional antwortet der KI-Assistent.
- **Team & Zugänge** (6 Schritte, ca. 4 Min., Agentur) – Mitarbeiter und Kunden-Logins anlegen, Rechte je Bereich vergeben, 2FA zurücksetzen.
- **Dein Cloud-Konto** (11 Schritte, ca. 5 Min.) – Nur für gehostete Konten: Tarif und Rechnungen, Team, Verbrauch, Datenexport und Konto löschen.
- **Umzug: Vom bisherigen Tool hierher** (14 Schritte, ca. 7 Min.) – Kontakte, Deals, Tickets, Projekte, Wiki-Seiten, Tabellen, Formulare, Termine und mehr aus 24 Tools – von Mailchimp bis sevDesk – übernehmen, mit Vorschau, Probelauf und Rückgängig.
- **E-Mail-Zustellung prüfen** (9 Schritte, ca. 5 Min.) – SPF, DKIM, DMARC und MX deiner Absender-Domain prüfen und die fehlenden DNS-Einträge mit deutscher Anleitung kopieren – damit Kampagnen nicht im Spam landen.
- **Wissensgedächtnis (Cognee)** (9 Schritte, ca. 5 Min.) – Einen Wissensgraph aus Wiki, Notizen, Tickets & Co. befragen – nur mit dem, was dein Sub-Account ausdrücklich freigibt, mit Schwärzung und Löschung.
- **Integrations-Katalog & Apps** (7 Schritte, ca. 4 Min.) – Was verbunden ist und was noch geht: alle Integrationen mit Status, Anleitung und direktem Weg zur Einrichtung.
- **Composio: 250+ Apps verbinden** (9 Schritte, ca. 6 Min.) – Slack, HubSpot, Shopify, Google Sheets & Co. über Composio verbinden, in Workflows nutzen, App-Ereignisse empfangen und für KI & MCP freigeben.
- **Nango: Apps mit eigenen OAuth-Apps** (7 Schritte, ca. 5 Min.) – Hunderte APIs über Nango verbinden – die Agentur richtet einmal je Anbieter eine OAuth-App ein, Sub-Accounts klicken nur „Verbinden“.
- **Externe MCP-Server als Werkzeuge** (8 Schritte, ca. 6 Min.) – GitHub, Notion, Linear, Zapier & Co. über MCP anbinden: Werkzeuge freigeben, in Workflows und im KI-Agenten nutzen, an Claude und Codex weitergeben.
- **Zapier, Make & n8n (REST-Hooks)** (7 Schritte, ca. 5 Min.) – API-Schlüssel je Tool, Sofort-Auslöser per REST-Hook, Zustell-Protokoll und die API-Referenz.
- **Umzug aus HubSpot** (8 Schritte, ca. 5 Min.) – Kontakte, Firmen, Deals, Notizen, Aufgaben, Aktivitäten und Tickets aus HubSpot holen – mit Probelauf und Fortschritt.
- **App fürs Handy & Widgets** (7 Schritte, ca. 4 Min.) – Die Android-App installieren und koppeln, gekoppelte Geräte verwalten, Widgets und Benachrichtigungen.
- **iPhone & iPad: HyperLevel als App** (9 Schritte, ca. 4 Min.) – Zum Home-Bildschirm hinzufügen, Mitteilungen und Zahl auf dem Symbol einschalten, iPad-Ansicht und Tastaturkürzel.

### Agentur & Betrieb

- **Personal: Urlaub, Abwesenheiten, Mitarbeiter** (13 Schritte, ca. 7 Min.) – Urlaub beantragen und genehmigen, Teamkalender, Mitarbeiterdaten mit geschützten Gehaltsfeldern und Checklisten für Ein- und Austritt.
- **Agentur-Überblick** (7 Schritte, ca. 5 Min., Agentur) – Alle Projekte mit Kennzahlen und Website-Status, projektübergreifende Kontakte, Deals, Aufgaben und Dokumente.
- **Kunden & Snapshots** (5 Schritte, ca. 4 Min., Agentur) – Neue Kunden in Sekunden: Sub-Account aus einem Startpaket, Kunden-Login, eigenes Branding.
- **SaaS-Modus** (5 Schritte, ca. 5 Min., Agentur) – Sub-Accounts als Abo verkaufen: Tarife, Anmeldeseite, Limits, Zahlungen über den Agentur-Stripe.
- **Cloud-Betrieb** (12 Schritte, ca. 7 Min., Agentur) – Gehostete Version betreiben: Kennzahlen, Kunden, Preise, Fair Use, Zahlungsausfall, Stripe und Rechtstexte.
- **White-Label & Domains** (7 Schritte, ca. 5 Min., Agentur) – Eigener Name, Logo, Farbe und App-Domain – und Domains für Kunden-Websites.
- **Anmeldung: SSO, Passkeys & Regeln** (7 Schritte, ca. 6 Min., Agentur) – Wie sich Team und Kunden anmelden: Google, Microsoft, GitHub, Apple, eigener SSO-Anbieter, Passkeys, E-Mail-Link – mit Regeln für neue Konten und 2FA.
- **Integrationen: OAuth, Postfächer, Postiz** (5 Schritte, ca. 5 Min., Agentur) – Google-/Microsoft-Apps für Kalender & Google-Profil, IMAP-Postfach-Sync und der Social Planner.
- **Todoist-Abgleich** (5 Schritte, ca. 3 Min., Agentur) – Aufgaben aller Projekte in beide Richtungen mit deinem Todoist abgleichen.
- **Supabase-Spiegel** (5 Schritte, ca. 3 Min., Agentur) – Projekte, Kontakte, Deals, Aufgaben, Rechnungen und Dokumente laufend in deine Supabase.
- **Betrieb: Backups, Protokoll, Störungen** (6 Schritte, ca. 6 Min., Agentur) – Backups ziehen, das Protokoll lesen, Server-Ressourcen prüfen – und was zu tun ist, wenn eine Website down ist.
- **Partner-Links** (5 Schritte, ca. 2 Min., Agentur) – „Konto anlegen“-Links zu Anbietern: Partner-Links ersetzen, einzeln oder ganz abschalten und Klicks sehen.
