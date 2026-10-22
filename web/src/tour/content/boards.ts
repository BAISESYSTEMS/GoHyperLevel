import type { Tour } from '../types';

/** Living Boards: workspaces put together from widgets – by dragging or by telling the board what you want. */
export const BOARD_TOURS: Tour[] = [
  {
    id: 'boards',
    title: 'Living Boards: dein Arbeitsplatz, wie du ihn willst',
    summary: 'Setze dir aus Bausteinen eine eigene Startseite zusammen – per Ziehen oder indem du dem Board sagst, was du sehen willst – mit Verlauf und Rückgängig.',
    icon: 'boards',
    group: 'crm',
    perm: 'dashboard',
    minutes: 7,
    routes: ['boards'],
    keywords: 'board boards living dashboard startseite arbeitsfläche widget baustein kachel kennzahl diagramm pipeline kalender notiz wunsch sprache sprechen vorlage marktplatz verlauf rückgängig team',
    learned: ['Ein Board anlegen, aus einer Vorlage starten und festlegen, wer es sieht', 'Widgets verschieben, vergrößern, hinzufügen und einstellen – auch mit der Tastatur', 'Dem Board per Text oder Sprache sagen, was es zeigen soll, und die Änderung prüfen', 'Mit dem Verlauf jede Änderung zurückholen und ein Board als Vorlage teilen'],
    docs: { label: 'Living Boards', file: 'living-boards' },
    steps: [
      { title: 'Boards', route: 'boards', target: 'nav-boards', text: 'Ein Board ist eine Arbeitsfläche, die du dir aus Bausteinen zusammensetzt: Kennzahlen, Listen, Pipeline, Kalender, Notizen und mehr. Es zeigt dir immer, was gerade zählt.' },
      { title: 'Neues Board', target: 'board-new', text: 'Starte leer oder mit einem fertigen Board: Solo-Cockpit, Vertrieb, Agentur-Übersicht, Service oder Projekte. Du entscheidest, ob nur du es siehst oder das ganze Team.' },
      { title: 'Vorlagen', target: 'tab-vorlagen', text: 'Hier liegen die Starter, deine eigenen Vorlagen und – wenn jemand sie veröffentlicht hat – Boards aus dem Marktplatz. Eine Vorlage enthält nur Anordnung und Einstellungen, keine Daten.' },
      { title: 'Ein Board öffnen', target: 'board-card', kind: 'wait', wait: { appear: 'board-page' }, optional: true, missing: 'Lege zuerst mit „Neues Board“ ein Board an – danach geht es hier weiter.', do: 'Klicke auf ein Board.', text: 'Jede Karte zeigt eine Vorschau des Boards. Ein Klick öffnet es.' },
      { title: 'Anpassen', target: 'board-edit', kind: 'click', optional: true, missing: 'Öffne ein Board, dann findest du oben rechts „Anpassen“.', do: 'Klicke auf **Anpassen**.', text: 'Im Anpassen-Modus bekommt jede Karte einen Griff, eine Ecke zum Vergrößern und Einstellungen. Alles, was du änderst, ist sofort gespeichert und lässt sich rückgängig machen.' },
      { title: 'Verschieben und vergrößern', target: 'board-grid', optional: true, text: 'Ziehe eine Karte am Griff, die Ecke unten rechts ändert die Größe – die anderen Karten machen Platz. Mit der Tastatur: Griff wählen, Leertaste, Pfeiltasten, Leertaste. Auf dem Handy sortierst du mit Pfeilen.' },
      { title: 'Widget hinzufügen', target: 'board-add', optional: true, text: 'Die Auswahl lässt sich durchsuchen und nach Themen filtern. Fehlt dir ein Baustein, kannst du ihn direkt in der Werkstatt bauen lassen.' },
      { title: 'Einstellungen eines Widgets', target: 'board-widget-settings', optional: true, text: 'Das Symbol öffnet die Einstellungen am Rand: Titel, Kennzahl, Filter, Zeitraum. Jedes Widget zeigt die Daten mit den Rechten der Person, die das Board gerade ansieht.' },
      { title: 'Sag dem Board, was du willst', target: 'board-prompt', optional: true, text: 'Schreibe oder sprich, was du sehen willst, zum Beispiel „Zeig die offenen Angebote neben dem Kalender“. Das Board prüft den Wunsch und zeigt dir vor dem Übernehmen, was sich ändert.' },
      { title: 'Verlauf und Rückgängig', target: 'board-history-btn', optional: true, text: 'Jede Änderung ist eine Version – auch die per Wunsch oder durch den Agenten. Im Verlauf siehst du, wer wann was geändert hat, und holst jeden Stand zurück.' },
      { title: 'Board-Einstellungen', target: 'board-config', optional: true, text: 'Name, Symbol und Farbe, wer das Board sieht und ändern darf, als Startseite festlegen, duplizieren – und als Vorlage speichern oder im Marktplatz veröffentlichen.' },
      { title: 'Gemeinsam in Echtzeit', text: 'Ändert jemand anderes das Board – oder der Agent –, siehst du es sofort und eine Zeile sagt, was sich geändert hat. Das Team arbeitet am selben Board, ohne neu zu laden.' },
    ],
  },
];
