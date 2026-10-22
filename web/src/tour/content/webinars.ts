import type { Tour } from '../types';

/** Webinare: automated webinars – video at the appointment, registration page, room, reminders, numbers. */
export const WEBINAR_TOURS: Tour[] = [
  {
    id: 'webinars',
    title: 'Webinare: Automatisiert anmelden und verkaufen',
    summary: 'Ein Video zum Termin abspielen, Anmeldungen einsammeln, erinnern, Fragen und Angebot einblenden – und sehen, wer wie lange dabei war.',
    icon: 'webinar',
    group: 'marketing',
    perm: 'funnels',
    minutes: 8,
    routes: ['webinars'],
    keywords: 'webinar automatisiert evergreen termin anmeldung erinnerung aufzeichnung replay raum warteraum angebot umfrage fragen show-up teilnehmer verkaufen video',
    learned: ['Ein Video als automatisiertes Webinar einrichten und ehrlich so nennen', 'Termine festlegen: feste Zeiten, Einzeltermine, „Just in time“, Sofort-Start, Sperrtage', 'Anmeldeseite, Bestätigung und Erinnerungen per E-Mail und SMS', 'Fragen, Umfragen und ein Angebot mit echter Frist im Raum', 'Die Auswertung lesen: Show-up, Sehdauer, Abbruchkurve, Klicks und Umsatz'],
    docs: { label: 'Webinare', file: 'webinars' },
    steps: [
      { title: 'Webinare', route: 'webinars', target: 'nav-webinars', text: 'Hier richtest du **automatisierte Webinare** ein: Das Video läuft zum Termin ab, für alle Angemeldeten gleichzeitig. Der Raum nennt sich immer „Automatisiertes Webinar“ – er behauptet nie, live zu sein.' },
      { title: 'Ein Webinar öffnen', target: 'webinars-list', kind: 'navigate', to: 'webinars/', do: 'Klicke auf ein **Webinar** – oder lege mit „Neues Webinar“ eines an.', optional: true, missing: 'Noch kein Webinar da: Lege mit „Neues Webinar“ eines an und öffne es – dann geht die Tour weiter.', text: 'In der Liste siehst du Status, nächsten Termin, Anmeldungen und wer teilgenommen hat. Neue Webinare sind erst Entwürfe, die niemand sieht.' },
      { title: 'Das Video', target: 'webinar-source', optional: true, text: 'Lade eine Datei hoch, verlinke eine MP4- oder HLS-Datei, nimm YouTube, Vimeo oder ein Video aus dem Video-Studio. Dateien laufen am genauesten: Wer später kommt, steigt an der aktuellen Stelle ein, vorspulen geht nicht.' },
      { title: 'Veröffentlichen', target: 'webinar-publish', optional: true, text: 'Erst wenn Video, Dauer und mindestens ein Termin da sind, lässt sich das Webinar veröffentlichen. Fehlt noch etwas, steht es über den Reitern.' },
      { title: 'Termine', target: 'tab-schedule', kind: 'click', do: 'Klicke auf **Termine**.', optional: true, text: 'Hier legst du fest, wann das Webinar startet.' },
      { title: 'Wann startet es?', target: 'webinar-schedule', optional: true, text: 'Feste Wochentage und Uhrzeiten, Einzeltermine, „Just in time“ (der nächste Start in wenigen Minuten) oder „Sofort starten“. Dazu Sperrtage und optional Plätze pro Termin. Besucher sehen die Zeiten in ihrer eigenen Zeitzone.' },
      { title: 'Anmeldung', target: 'tab-registration', kind: 'click', do: 'Klicke auf **Anmeldung**.', optional: true, text: 'Die Anmeldeseite wird dein Link – oder du bettest sie in eine Funnel-Seite ein.' },
      { title: 'Anmeldeseite und Einwilligung', target: 'webinar-registration', optional: true, text: 'Name, E-Mail, optional Telefon, dazu die Einwilligung. Die Anmeldung legt den Kontakt an, setzt Tags und startet Automationen. Den persönlichen Link bekommen Angemeldete per E-Mail – mit Kalenderdatei.' },
      { title: 'Raum & Angebot', target: 'tab-room', kind: 'click', do: 'Klicke auf **Raum & Angebot**.', optional: true, text: 'Alles, was Zuschauer im Raum sehen.' },
      { title: 'Der Raum', target: 'webinar-room', optional: true, text: 'Fragen gehen ins Postfach (Konversationen). Ein Zähler und automatische Chat-Nachrichten sind aus – und wenn du sie einschaltest, zeigt der Zähler die echte Zahl und jede automatische Nachricht trägt den Hinweis „Automatische Nachricht“.' },
      { title: 'Angebot mit echter Frist', target: 'webinar-offer', optional: true, text: 'Ein Button zum Produkt, Formular oder Link erscheint zum gewählten Zeitpunkt. Eine Frist ist echt: Danach funktioniert der Button nicht mehr – für niemanden. Der Klick und ein Kauf danach landen in der Auswertung.' },
      { title: 'Erinnerungen', target: 'tab-reminders', kind: 'click', do: 'Klicke auf **Erinnerungen**.', optional: true, text: 'Bestätigung und Erinnerungen vor dem Start.' },
      { title: 'Bestätigung und Erinnerungen', target: 'webinar-reminders', optional: true, text: 'Standard: 24 Stunden, 1 Stunde und 15 Minuten vorher und zum Start, per E-Mail, auf Wunsch per SMS. Jede Erinnerung geht einmal raus, nie für Zeitpunkte vor der Anmeldung, und „Nicht stören“ gilt.' },
      { title: 'Auswertung', target: 'tab-stats', kind: 'click', do: 'Klicke auf **Auswertung**.', optional: true, text: 'Zahlen für das Webinar und jeden Termin.' },
      { title: 'Was die Zahlen sagen', target: 'webinar-stats', optional: true, text: 'Anmeldungen, Show-up-Rate, durchschnittliche Sehdauer, Abbruchkurve, Klicks aufs Angebot, Käufe und Umsatz. Wer wie lange da war, steht auch in der Zeitleiste des Kontakts – und die Automationen reagieren darauf („Webinar verpasst“, „Angesehen ab 50 %“).' },
    ],
  },
];
