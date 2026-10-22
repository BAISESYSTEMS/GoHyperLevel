import type { Tour } from '../types';

/** Gewinnrechner: what is left at which price and how many customers, after costs, fees and taxes. */
export const CALC_TOURS: Tour[] = [
  {
    id: 'calc',
    title: 'Gewinnrechner: Was bleibt übrig?',
    summary: 'Preise, Kundenzahl, Kosten und Steuern eintragen und sofort sehen, was nach allem übrig bleibt – mit Tabelle, Break-even, Prognose und Szenarien.',
    icon: 'calculator',
    group: 'revenue',
    perm: 'payments',
    minutes: 8,
    routes: ['calc'],
    keywords: 'gewinnrechner preis preismodell staffel standort gewinn marge break-even kundenwert ltv cac steuer umsatzsteuer kleinunternehmer gmbh einkommensteuer gewerbesteuer szenario prognose kalkulation rechner',
    learned: ['Eine Vorlage laden und Preise, Kunden, Kosten und Steuern auf den eigenen Fall einstellen', 'Die Tabelle lesen: Kundenzahl × Preis, wahlweise Umsatz, EBIT, Nettogewinn oder Marge', 'Break-even, Kundenwert, Prognose und die wichtigsten Hebel verstehen', 'Szenarien speichern, vergleichen und den Agenten rechnen lassen'],
    docs: { label: 'Gewinnrechner', file: 'gewinnrechner' },
    steps: [
      { title: 'Gewinnrechner', route: 'calc', target: 'nav-calc', text: 'Hier rechnest du, was bei einem Preis und einer Kundenzahl **nach allen Kosten, Gebühren und Steuern** übrig bleibt – bevor du etwas festlegst. Es ist eine Schätzung, keine Steuerberatung.' },
      { title: 'Mit einer Vorlage starten', target: 'calc-presets', text: 'Sechs Vorlagen zeigen typische Modelle: HyperLevel Staffel, Standort-Modell, SaaS pro Nutzer, Agentur-Retainer, Kurs/Community und Handwerk. Alle Zahlen sind Beispiele – du ersetzt sie durch deine.' },
      { title: 'Preismodell', target: 'calc-pricing', optional: true, missing: 'Das Feld „Preismodell“ steckt in der Spalte „Eingaben“ – auf dem Handy über „Eingaben“ oben.', text: 'Pro Tarif: Grundpreis, inklusive Einheiten (Standorte, Plätze, Accounts), Stufenpreis je weitere Einheit und ein Deckel. Mehrere Tarife mit „Anteil der Kunden“ bilden Teamgrößen-Staffeln oder Agentur-Stufen ab.' },
      { title: 'Kunden', target: 'calc-customers', optional: true, text: 'Zahl der Kunden, Kündigungsquote, Anteil Geschäfts- und EU-Kunden und – genauer als ein Durchschnitt – die Verteilung der Standorte je Kunde. Das Wachstum füttert die Prognose.' },
      { title: 'Variable Kosten', target: 'calc-costs', optional: true, text: 'Zahlungsgebühren (Standard: Stripe 1,5 % + 0,25 €), Hosting, KI, E-Mail/SMS, Support-Zeit, Partner-Provision und App-Store-Gebühren. Sie steigen mit jedem Kunden.' },
      { title: 'Steuern', target: 'calc-tax', optional: true, text: 'Rechtsform wählen: Einkommensteuer mit Soli, Kirchensteuer und Gewerbesteuer – oder GmbH mit Körperschaftsteuer. Die Tarifwerte sind sichtbar und änderbar. **Schätzung, keine Steuerberatung.**' },
      { title: 'Die Antwort', target: 'calc-headline', text: 'Oben steht die Antwort in einem Satz, darunter die Kennzahlen: Umsatz, nach variablen Kosten, EBIT, Nettogewinn, Break-even, laufender Umsatz, Kundenwert und Amortisation.' },
      { title: 'Die Tabelle', target: 'calc-matrix', text: 'Jede Zeile ist eine Kundenzahl, jede Spalte ein Preis. Grün heißt Gewinn, Rot Verlust. Ein Klick auf ein Feld zeigt darunter die komplette Rechnung für genau diese Kombination.' },
      { title: 'Kennzahl wählen', target: 'calc-metric', text: 'Die Tabelle zeigt wahlweise Umsatz, nach variablen Kosten, EBIT, Nettogewinn nach Steuern oder die Marge – pro Monat oder pro Jahr.' },
      { title: 'Wasserfall', target: 'calc-waterfall', optional: true, text: 'Von der Kundenzahlung bis zum Nettogewinn: Umsatzsteuer, Gebühren, variable Kosten, Fixkosten, Kundengewinnung und Steuern nehmen Schritt für Schritt etwas weg.' },
      { title: 'Hebel', target: 'tab-levers', kind: 'click', do: 'Klicke auf **Hebel**.', text: 'Welche Stellschraube bewegt den Gewinn am meisten – der Preis, die Kündigungen oder die Fixkosten?' },
      { title: 'Was am meisten bewegt', target: 'calc-tornado', optional: true, text: 'Jeder Balken zeigt, wie sich der Nettogewinn pro Jahr ändert, wenn dieser eine Wert um 20 % kleiner oder größer wird. Oben stehen die Hebel mit der größten Wirkung.' },
      { title: 'Prognose', target: 'tab-projection', kind: 'click', do: 'Klicke auf **Prognose**.', text: 'Hier siehst du Kunden, laufenden Umsatz und Gewinn über 12, 24 und 36 Monate mit Neukunden und Kündigungen – und den Monat, ab dem das Geschäft insgesamt im Plus ist.' },
      { title: 'Szenarien speichern', target: 'calc-save', text: 'Speichere die Rechnung als Szenario, zum Beispiel „Standort-Modell, 300 Kunden“. Unter „Szenarien“ vergleichst du bis zu sechs nebeneinander; „CSV“ exportiert die Tabelle für Excel.' },
      { title: 'Der Agent rechnet mit', target: 'calc-agent', optional: true, text: 'Der HyperLevel Agent und externe KI-Clients nutzen denselben Rechner: „Was bleibt bei 300 Kunden übrig?“ oder „Ab wie vielen Kunden bin ich im Plus?“ – mit Annahmen und dem Hinweis auf die Schätzung.' },
    ],
  },
];
