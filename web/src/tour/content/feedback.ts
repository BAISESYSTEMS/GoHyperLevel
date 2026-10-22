import type { Tour } from '../types';

/** „Fehler melden“, „Meine Meldungen“ and the wish list – for every login. */
export const FEEDBACK_TOURS: Tour[] = [
  {
    id: 'feedback',
    title: 'Fehler melden & Wunschliste',
    summary: 'Einen Fehler mit Screenshot melden, Antworten unter „Meine Meldungen“ lesen und für neue Funktionen abstimmen.',
    icon: 'bug',
    group: 'start',
    minutes: 4,
    routes: ['feedback', 'wishes'],
    keywords: 'fehler melden bug feedback screenshot problem wunsch wunschliste roadmap abstimmen idee was ist neu changelog support',
    learned: ['Einen Fehler mit Screenshot und Diagnosedaten melden', 'Diagnosedaten ansehen und einzeln entfernen', 'Antworten und Status unter „Meine Meldungen“ verfolgen', 'Für Wünsche abstimmen und selbst einen einreichen', 'Roadmap und „Was ist neu“ lesen'],
    docs: { label: 'Fehler & Wünsche', file: 'bug-reports', anchor: 'fehler-melden' },
    steps: [
      { title: 'Etwas klappt nicht?', target: 'feedback-button', text: 'Über **Feedback** oben rechts meldest du Fehler, stellst Fragen und reichst Wünsche ein. Ein roter Punkt zeigt Antworten des Teams und Neues aus „Was ist neu“.' },
      { title: 'Das Menü', target: 'feedback-button', kind: 'click', text: 'Hier geht es auch zu „Meine Meldungen“, zur Wunschliste und zu „Was ist neu“.', do: 'Klicke auf **Feedback**.', demo: { click: true, label: 'Zeig’s mir' } },
      { title: 'Fehler melden', target: 'fb-menu-report', kind: 'click', text: 'Schneller geht es mit der Tastenkombination **Strg + Umschalt + F** – auf jeder Seite.', do: 'Klicke auf **Fehler melden**.', demo: { click: true, label: 'Zeig’s mir' } },
      { title: 'Fehler, Wunsch oder Frage', target: 'fb-category', text: 'Fehler und Fragen sieht nur das Team. Ein Verbesserungswunsch landet – ohne deinen Namen – in der Wunschliste, wo andere dafür stimmen.' },
      { title: 'Was ist passiert?', target: 'fb-what', kind: 'fill', text: 'Ein, zwei Sätze reichen. Darunter kannst du ergänzen, was du erwartet hast und wie man den Fehler nachstellt.', do: 'Beschreibe kurz, was passiert ist.', demo: { fill: 'Übung: Beim Speichern dreht sich der Kreis endlos' } },
      { title: 'Wie schlimm ist es?', target: 'fb-severity', text: 'Der Schweregrad bestimmt die Priorität beim Team – „Blockiert mich“ wird schneller bearbeitet als eine Kleinigkeit.' },
      { title: 'Screenshot', target: 'fb-screenshot', text: 'Ein Bild sagt mehr als viele Worte: mit **Strg + V** aus der Zwischenablage einfügen, eine Datei wählen oder mit „Bildschirm aufnehmen“ direkt diese Seite fotografieren.' },
      { title: 'Diagnosedaten', target: 'fb-diagnostics', text: 'Seite, Version, Browser und die letzten technischen Fehler gehen automatisch mit – nie Formularinhalte oder Passwörter. Mit „Ansehen“ siehst du alles, mit ✕ entfernst du einzelne Angaben.' },
      { title: 'Senden', target: 'fb-send', text: 'Nach dem Senden bekommst du die Ticketnummer. Für diese Übung schließt du das Fenster einfach mit ✕ oben rechts.' },
      { title: 'Meine Meldungen', route: 'feedback', target: 'page-head', text: 'Alle deine Meldungen mit Status (Neu, Bestätigt, In Arbeit, Behoben, Ausgeliefert) und den Antworten des Teams. Du kannst Infos nachreichen oder eine erledigte Meldung wieder öffnen.' },
      { title: 'Benachrichtigungen', target: 'fb-prefs', text: 'Ändert sich der Status oder antwortet das Team, siehst du es hier, per Push und per E-Mail. „Fehler automatisch melden“ schickt technische Fehler ohne Inhalte ans Team.' },
      { title: 'Die Wunschliste', route: 'wishes', target: 'wish-filters', text: 'Alle Wünsche aller Nutzer – suchen, nach Bereich filtern und nach Stimmen, neu oder Status sortieren. Mit ▲ stimmst du ab (noch ein Klick nimmt die Stimme zurück).' },
      { title: 'Eigener Wunsch', target: 'wish-new', text: 'Fehlt dir eine Funktion? Titel, kurze Beschreibung, Bereich – optional mit Screenshot. Du und alle, die abgestimmt haben, erfahren, wenn er geplant oder fertig ist.' },
      { title: 'Roadmap & Was ist neu', target: 'tab-roadmap', text: 'Die Roadmap zeigt Idee → Geplant → In Arbeit → Fertig. Unter „Was ist neu“ stehen umgesetzte Wünsche und behobene Fehler mit Versionsnummer.' },
      { title: 'Für die Agentur', route: 'agency/feedback', target: 'agency-feedback-settings', admin: true, text: 'Alle Meldungen landen als Tickets im Support-Sub-Account (Pipeline „Fehler & Wünsche“). Im Ticket zeigt ein Feld Diagnose, Screenshots und Betroffene – mit „Als Duplikat von …“ und „Behoben in Version …“.' },
    ],
  },
];
