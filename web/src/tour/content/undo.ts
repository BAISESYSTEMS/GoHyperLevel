import type { Tour } from '../types';

/** Rückgängig, Verlauf and Papierkorb (docs/undo.md). */
export const UNDO_TOURS: Tour[] = [
  {
    id: 'undo',
    title: 'Rückgängig, Verlauf und Papierkorb',
    summary: 'Jede Änderung lässt sich zurücknehmen: Hinweis nach der Änderung, Strg+Z, Verlauf und Papierkorb.',
    icon: 'undo',
    group: 'start',
    minutes: 3,
    routes: ['trash'],
    practice: true,
    keywords: 'rückgängig undo strg z verlauf papierkorb gelöscht wiederherstellen versehentlich abgehakt',
    learned: ['Eine Änderung mit dem Hinweis unten oder mit **Strg+Z** zurücknehmen', 'Im **Verlauf** sehen, was sich wann geändert hat, und es wiederherstellen', 'Gelöschtes aus dem **Papierkorb** zurückholen – 30 Tage lang', 'Was sich nicht zurückholen lässt (Gesendetes)'],
    docs: { label: 'Rückgängig, Verlauf und Papierkorb', file: 'undo' },
    steps: [
      { title: 'Nichts geht mehr verloren', text: 'Jede Änderung, die du machst – eine Aufgabe abhaken, einen Kontakt löschen, einen Deal verschieben – merkt sich {brand}. Du kannst sie zurücknehmen, auch noch Tage später.' },
      { title: 'Der Hinweis nach jeder Änderung', target: 'undo-toast', optional: true, missing: 'Der Hinweis erscheint unten nach jeder Änderung, z. B. wenn du eine Aufgabe abhakst, und verschwindet nach 8 Sekunden.', text: 'Unten steht z. B. „Aufgabe … erledigt · Rückgängig“. Er bleibt 8 Sekunden – solange Maus oder Tastatur darauf sind, läuft die Zeit nicht ab.' },
      { title: 'Strg+Z', text: 'Strg+Z (am Mac ⌘+Z) nimmt deine letzte Änderung zurück – überall, solange du nicht gerade in ein Textfeld tippst. Strg+Umschalt+Z wiederholt sie.' },
      { title: 'Der Verlauf', target: 'history-button', kind: 'click', text: 'Hier stehen deine letzten Änderungen nach Tagen sortiert – mit „vorher → nachher“.', do: 'Klicke auf **Verlauf**.' },
      { title: 'Suchen und filtern', target: 'history-filters', optional: true, missing: 'Der Verlauf ist wieder zu. Mit dem Knopf **Verlauf** oben öffnest du ihn jederzeit.', text: 'Suche nach einem Namen oder filtere nach Art: Aufgaben, Kontakte, Deals, Termine und mehr. Admins sehen auf Wunsch die Änderungen aller.' },
      { title: 'Wiederherstellen', target: 'history-restore', optional: true, missing: 'Sobald du etwas geändert hast, steht hier „Wiederherstellen“.', text: 'Ein Klick stellt den alten Zustand her. Wurde der Datensatz seitdem erneut geändert, zeigt {brand} den Unterschied und fragt, ob du trotzdem zurückgehen willst.' },
      { title: 'Der Papierkorb', route: 'trash', target: 'page-head', text: 'Gelöschtes – ein Kontakt samt Notizen, Aufgaben und Deals, ein Formular, eine Automation – bleibt 30 Tage im Papierkorb. Admins können dort auch endgültig löschen.' },
      { title: 'Was nicht zurückkommt', text: 'Bereits Gesendetes lässt sich nicht zurückholen: E-Mails, SMS, Zahlungen und veröffentlichte Anzeigen. {brand} setzt dann nur den Status zurück und sagt es dir dazu.' },
    ],
  },
];
