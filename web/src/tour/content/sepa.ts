import type { Tour } from '../types';

/** SEPA without a payment provider: mandates, collection runs, returns and transfer files (web/src/pages/Sepa.tsx, SepaRuns.tsx). */
export const SEPA_TOURS: Tour[] = [
  {
    id: 'sepa',
    title: 'SEPA: Lastschrift ohne Zahlungsanbieter',
    summary: 'Mandate einholen, offene Rechnungen per Lastschrift einziehen, Rücklastschriften erfassen und Überweisungsdateien für Lieferanten erzeugen.',
    icon: 'bank',
    group: 'revenue',
    perm: 'payments',
    minutes: 7,
    routes: ['sepa'],
    keywords: 'sepa lastschrift mandat gläubiger-id vorabankündigung pain.008 pain.001 rücklastschrift überweisung bankeinzug einzug',
    learned: [
      'Gläubiger-ID und Vorlauf der Vorabankündigung einstellen',
      'Mandate auf Papier erfassen oder online mit Nachweis einholen',
      'Einen Lastschrift-Lauf mit Vorschau anlegen, einreichen und die Datei hochladen',
      'Bezahlte und zurückgegebene Lastschriften eintragen – die Rechnung folgt',
      'Eine Überweisungsdatei für Eingangsrechnungen erzeugen',
    ],
    docs: { label: 'SEPA', file: 'sepa' },
    steps: [
      { title: 'SEPA', route: 'sepa', target: 'nav-sepa', text: 'Hier ziehst du offene Rechnungen **per Lastschrift** ein – mit deinem eigenen Mandat, ohne Stripe. HyperLevel schreibt die Datei, die du im Online-Banking hochlädst; zur Bank verbindet es sich nie.' },
      { title: 'Der Überblick', target: 'sepa-stats', text: 'Aktive Mandate, was gerade einziehbar ist, was bei der Bank liegt und wie viele Lastschriften zuletzt zurückkamen.' },
      { title: 'Einstellungen zuerst', target: 'tab-settings', kind: 'click', do: 'Klicke auf **Einstellungen**.', text: 'Ohne Gläubiger-ID geht keine Lastschrift.' },
      { title: 'Gläubiger-ID und Konto', target: 'sepa-creditor', text: 'Die **Gläubiger-ID** gibt es kostenlos bei der Bundesbank; HyperLevel prüft ihre Prüfziffern. Das Konto kommt aus den Rechnungs-Einstellungen, wenn du hier keins einträgst.' },
      { title: 'Vorabankündigung', target: 'sepa-lead', text: 'Standard sind **14 Tage** vor dem Einzug. Kürzer (mindestens 1 Tag) geht nur, wenn es im Mandat steht – HyperLevel schreibt die Frist deshalb in den Mandatstext.' },
      { title: 'Mandate', target: 'tab-mandates', kind: 'click', do: 'Klicke auf **Mandate**.', text: 'Jede Lastschrift braucht ein Mandat des Kontoinhabers.' },
      { title: 'Online-Mandat', target: 'sepa-new-online', text: 'Die Person bekommt einen Link, liest den Mandatstext und trägt ihr Konto selbst ein. Gespeichert werden Zeitpunkt, IP-Netz, Browser-Fingerabdruck und die Prüfsumme des Textes.' },
      { title: 'Papier-Mandat', target: 'sepa-new-paper', text: 'Liegt ein unterschriebenes Mandat vor, erfasst du es hier. Die Mandatsreferenz muss genau der auf dem Papier entsprechen.' },
      { title: 'Einzug', target: 'tab-collect', kind: 'click', do: 'Klicke auf **Einzug**.', text: 'Hier entsteht ein Lastschrift-Lauf.' },
      { title: 'Rechnungen wählen', target: 'sepa-collect', optional: true, missing: 'Noch keine einziehbare Rechnung: Sie erscheinen, sobald eine Rechnung festgeschrieben und offen ist und der Kontakt ein aktives Mandat hat.', text: 'Festgeschriebene, offene Rechnungen von Kontakten mit Mandat. **FRST** ist die erste Lastschrift eines Mandats, danach **RCUR**.' },
      { title: 'Vorschau und Datum', target: 'sepa-preview', optional: true, text: 'Datum, Blöcke je Sequenztyp und Summen. Der Lauf schickt die Vorabankündigungen; eingereicht wird später unter **Läufe** – dort lädst du die Datei herunter und trägst bezahlte und zurückgegebene Lastschriften ein.' },
      { title: 'Überweisungen', target: 'tab-transfers', kind: 'click', do: 'Klicke auf **Überweisungen**.', text: 'Auch der Weg zurück: eine Überweisungsdatei für gebuchte Eingangsrechnungen oder eine Auszahlungsliste – hochladen, freigeben, fertig.' },
    ],
  },
];
