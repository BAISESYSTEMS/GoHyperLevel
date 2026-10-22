/**
 * Page templates of the Wiki. Plain Markdown in the wiki's own syntax (checklists, callouts, tables);
 * `{{datum}}`, `{{autor}}` and `{{projekt}}` are filled in when a page is created from a template.
 */

export interface WikiTemplate {
  key: string;
  name: string;
  description: string;
  icon: string;
  title: string;
  body: string;
  /** Sub-pages created below the page (the handbook). */
  children?: { title: string; icon?: string; body: string }[];
}

export const WIKI_TEMPLATES: WikiTemplate[] = [
  {
    key: 'meeting',
    name: 'Meeting-Notizen',
    description: 'Agenda, Notizen, Entscheidungen und Aufgaben für ein Meeting.',
    icon: '📝',
    title: 'Meeting {{datum}}',
    body: `| | |
|---|---|
| **Datum** | {{datum}} |
| **Teilnehmer** | |
| **Protokoll** | {{autor}} |

## Agenda
1. Punkt eins
2. Punkt zwei

## Notizen
-

## Entscheidungen
> [!TIP] Beschlossen
> Was wurde entschieden – und von wem?

## Aufgaben
- [ ] Aufgabe – wer – bis wann
- [ ] Aufgabe – wer – bis wann

## Nächstes Meeting
`,
  },
  {
    key: 'sop',
    name: 'Prozess / SOP',
    description: 'Eine Standardarbeitsanweisung: Zweck, Schritte, Checkliste und häufige Fehler.',
    icon: '📋',
    title: 'Prozess: Name des Ablaufs',
    body: `> [!INFO] Zweck
> In einem Satz: Wofür gibt es diesen Ablauf und wann wird er gebraucht?

| | |
|---|---|
| **Verantwortlich** | {{autor}} |
| **Gilt für** | {{projekt}} |
| **Zuletzt geprüft** | {{datum}} |

## Voraussetzungen
- Zugang zu …
- Vorlage / Unterlagen …

## Schritte
1. Erster Schritt – was genau passiert?
2. Zweiter Schritt
3. Dritter Schritt
4. Ergebnis prüfen und dokumentieren

## Checkliste vor dem Abschluss
- [ ] Alles vollständig
- [ ] Kunde informiert
- [ ] Ergebnis abgelegt

## Häufige Fehler
> [!WARNING] Achtung
> Was geht erfahrungsgemäß schief – und wie vermeidet man es?

## Fragen?
Ansprechperson: {{autor}}
`,
  },
  {
    key: 'brief',
    name: 'Projekt-Briefing',
    description: 'Ziel, Umfang, Meilensteine und Risiken auf einer Seite.',
    icon: '🎯',
    title: 'Briefing: Projektname',
    body: `> [!NOTE] Auf einen Blick
> Worum geht es, für wen – und woran merken wir, dass es gelungen ist?

## Ziel
-

## Hintergrund
Warum jetzt? Was ist der Auslöser?

## Zielgruppe
-

## Umfang
**Dazu gehört:**
- …

**Nicht dabei:**
- …

## Meilensteine
| Meilenstein | Verantwortlich | Bis |
|---|---|---|
| Kick-off | {{autor}} | |
| Erster Entwurf | | |
| Abnahme | | |

## Budget & Zeitplan
-

## Risiken
- [ ] Risiko – Gegenmaßnahme

## Beteiligte
- {{autor}} (Projektleitung)

*Stand: {{datum}}*
`,
  },
  {
    key: 'handbook',
    name: 'Onboarding-Handbuch',
    description: 'Willkommensseite mit drei Unterseiten: erste Woche, Tools & Zugänge, Team & Kultur.',
    icon: '🚀',
    title: 'Willkommen bei {{projekt}}',
    body: `> [!SUCCESS] Schön, dass du da bist!
> Dieses Handbuch begleitet dich durch die ersten Wochen. Alles Wichtige steht hier – und was fehlt, ergänzt du bitte.

## So ist dieses Handbuch aufgebaut
- **Erste Woche** – Schritt für Schritt durch die ersten Tage
- **Tools & Zugänge** – womit wir arbeiten und wo du Zugang bekommst
- **Team & Kultur** – wer macht was, wie arbeiten wir zusammen

## Deine Ansprechperson
{{autor}} hilft dir bei allen Fragen weiter.

## Schnellzugriff
- Fragen im Team-Chat stellen – dafür gibt es den Kanal #allgemein
- Wichtige Abläufe findest du als eigene Seiten (Prozess / SOP) in diesem Wiki

*Zuletzt aktualisiert: {{datum}}*
`,
    children: [
      {
        title: 'Erste Woche',
        icon: '📅',
        body: `## Tag 1
- [ ] Zugänge erhalten (E-Mail, CRM, Team-Chat)
- [ ] Team kennenlernen
- [ ] Dieses Handbuch lesen

## Tag 2–3
- [ ] Einen Kundenfall begleiten
- [ ] Die wichtigsten Prozesse (SOPs) durchgehen
- [ ] Erste kleine Aufgabe übernehmen

## Ende der Woche
- [ ] Feedback-Gespräch mit {{autor}}
- [ ] Offene Fragen sammeln und hier ergänzen
`,
      },
      {
        title: 'Tools & Zugänge',
        icon: '🧰',
        body: `| Tool | Wofür | Zugang über |
|---|---|---|
| HyperLevel | CRM, Posteingang, Aufgaben | {{autor}} |
| Team-Chat | Schnelle Abstimmung | Einladung im CRM |
| Wiki | Wissen und Prozesse | du bist schon drin |

> [!WARNING] Passwörter
> Passwörter gehören nie ins Wiki – dafür nutzen wir den Passwortmanager.
`,
      },
      {
        title: 'Team & Kultur',
        icon: '🤝',
        body: `## Wer macht was
| Name | Aufgabe | Erreichbar |
|---|---|---|
| {{autor}} | Ansprechperson Onboarding | Team-Chat |

## Wie wir zusammenarbeiten
- Fragen sind willkommen – lieber einmal zu viel
- Entscheidungen schreiben wir auf (Wiki oder Aufgabe)
- Kundenanfragen werden am selben Tag beantwortet
`,
      },
    ],
  },
  {
    key: 'blank',
    name: 'Leere Seite',
    description: 'Ohne Vorgabe starten.',
    icon: '📄',
    title: 'Neue Seite',
    body: '',
  },
];

export const templateByKey = (key: string) => WIKI_TEMPLATES.find((t) => t.key === key);

/** Fills the placeholders of a template. */
export function fillTemplate(text: string, vars: { datum: string; autor: string; projekt: string }): string {
  return text.replace(/\{\{\s*(datum|autor|projekt)\s*\}\}/g, (_m, k: 'datum' | 'autor' | 'projekt') => vars[k] ?? '');
}
