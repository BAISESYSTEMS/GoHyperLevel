import type { Tour } from '../types';

/** Wissensgedächtnis (Cognee): the agency connects the server, each sub-account decides what it shares, asks and remembers. */
export const MEMORY_TOURS: Tour[] = [
  {
    id: 'cognee-memory',
    title: 'Wissensgedächtnis (Cognee)',
    summary: 'Einen Wissensgraph aus Wiki, Notizen, Tickets & Co. befragen – nur mit dem, was dein Sub-Account ausdrücklich freigibt, mit Schwärzung und Löschung.',
    icon: 'sparkles',
    group: 'settings',
    perm: 'settings',
    minutes: 5,
    routes: ['settings/memory', 'agency/integrations'],
    keywords: 'cognee gedächtnis wissensgraph knowledge graph memory rag wiki ki agent mcp datenschutz dsgvo schwärzen freigabe datasets',
    learned: ['Was ein Sub-Account teilt – und dass es standardmäßig nichts ist', 'Datentypen freigeben, Schwärzung und „Daten in Cognee löschen“ nutzen', 'Das Gedächtnis befragen und Quellen öffnen', 'Den Status und das Protokoll lesen'],
    docs: { label: 'Wissensgedächtnis (Cognee)', file: 'cognee' },
    steps: [
      { title: 'Server der Agentur', route: 'agency/integrations/setup', target: 'cognee-agency', admin: true, text: 'Die Agentur trägt hier Adresse und Zugang ihres selbst gehosteten Cognee-Servers ein – am besten ein eigener Cognee-Nutzer für HyperLevel. Das Passwort wird verschlüsselt gespeichert und nie wieder angezeigt.' },
      { title: 'Verbindung testen', target: 'cognee-test', admin: true, optional: true, missing: 'Erst Adresse und Zugang speichern.', text: 'Der Test prüft Erreichbarkeit, Zugriffskontrolle (ENABLE_BACKEND_ACCESS_CONTROL), Anmeldung und die Dataset-Liste – und sagt, wo es hakt. Ohne Zugriffskontrolle sendet HyperLevel nichts.' },
      { title: 'Alle Sub-Accounts im Blick', target: 'cognee-overview', admin: true, optional: true, missing: 'Erscheint, sobald die Verbindung steht.', text: 'Wer teilt was, wie viele Einträge, letzter Abgleich, Fehler. Du kannst ausschalten, Daten in Cognee löschen und einem Sub-Account einen eigenen Cognee-Zugang geben.' },
      { title: 'Das Gedächtnis dieses Sub-Accounts', route: 'settings/memory', target: 'cognee-intro', text: 'Standard ist aus. Erst wenn du einschaltest und Datentypen wählst, wird etwas übertragen – in eigene Datasets dieses Sub-Accounts, nie in die eines anderen.' },
      { title: 'Was geteilt wird', target: 'cognee-types', text: 'Nur das Wiki ist vorausgewählt. Notizen, Tickets, Kursinhalte, Gespräche und Kontakte schaltest du einzeln ein; personenbezogene Typen sind markiert. E-Mails, Telefonnummern und IBANs lassen sich vor dem Senden schwärzen.' },
      { title: 'Speichern', target: 'cognee-save', text: 'Erst „Speichern“ ändert die Freigaben. Beendest du eine Freigabe, bietet HyperLevel an, die schon übertragenen Daten in Cognee zu löschen.' },
      { title: 'Gedächtnis fragen', target: 'cognee-ask', optional: true, missing: 'Erscheint, sobald die Agentur Cognee eingerichtet und du das Gedächtnis eingeschaltet hast.', text: 'Stelle eine Frage in einem Satz. Du bekommst kurze Textstellen mit Quelle und Link. „Antwort formulieren“ lässt zusätzlich das Modell des Cognee-Servers antworten.' },
      { title: 'Status und Protokoll', target: 'cognee-status', text: 'Zustand je Datentyp, Anzahl, letzter Abgleich, Fehler und eine Warnung, falls der Server keine Zugriffskontrolle hat. Darunter die letzten Vorgänge – nur Anzahlen, nie Inhalte.' },
      { title: 'Gemerkte Hinweise', target: 'cognee-memories', optional: true, missing: 'Dazu „Gemerkte Hinweise (manuell)“ freigeben.', text: 'Kurze Hinweise, die du ausdrücklich merken lässt – auch der KI-Agent kann das. Sie liegen zusätzlich in HyperLevel und lassen sich hier löschen, dann verschwinden sie auch in Cognee.' },
    ],
  },
];
