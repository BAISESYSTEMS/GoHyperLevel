import type { Tour } from '../tour/types';

/** Academy tour: the Canvas (boards, tools, live CRM cards, AI drawing, sharing and export). */
export const CANVAS_TOURS: Tour[] = [
  {
    id: 'canvas',
    title: 'Canvas: zeichnen, planen, gestalten',
    summary: 'Unendliche Boards mit Formen, Pfeilen, Notizen und Designs – mit Live-Karten aus dem CRM, KI-Zeichnen und gemeinsamer Arbeit.',
    icon: 'canvas',
    group: 'marketing',
    perm: 'canvas',
    minutes: 8,
    routes: ['canvas'],
    practice: true,
    keywords: 'canvas whiteboard zeichnen design mindmap flussdiagramm board miro excalidraw figma skizze wireframe notiz agent ki',
    learned: ['Ein Board anlegen – leer, aus einer Vorlage oder von der KI gezeichnet', 'Zeichnen, Pfeile an Formen heften und Rahmen für Designs nutzen', 'Live-Karten aus dem CRM aufs Board legen und Notizen zu Aufgaben machen', 'Zusammenarbeiten, kommentieren und das Board exportieren oder teilen'],
    docs: { label: 'Canvas', file: 'canvas' },
    steps: [
      { title: 'Canvas', route: 'canvas', target: 'page-head', text: 'Unendliche Boards zum Zeichnen, Planen und Gestalten: Ideen, Abläufe, Entwürfe – und Live-Daten aus dem CRM, alles an einem Ort. Jedes Board gehört zu diesem Sub-Account.' },
      { title: 'Von der KI zeichnen lassen', target: 'canvas-ai-new', text: 'Beschreibe in einem Satz, was du brauchst, z. B. „Kundenreise für unseren Onlinekurs“. Die KI legt ein neues Board mit Flussdiagramm, Mindmap oder Wireframe an.' },
      { title: 'Neues Board', target: 'canvas-new', kind: 'click', text: 'Oder starte selbst: leer oder mit einer Vorlage wie Mindmap, Flussdiagramm, SWOT, Kanban, Wireframe oder Social-Post.', do: 'Klicke auf **Neues Board**.' },
      { title: 'Name und Vorlage', target: 'canvas-new-name', kind: 'fill', text: 'Gib dem Board einen Namen. Darunter wählst du eine Vorlage, daneben stellst du ein, wer im Projekt es sehen oder bearbeiten darf.', do: 'Tippe einen Namen, z. B. „Herbst-Kampagne“.', demo: { fill: 'Herbst-Kampagne (Übung)' } },
      { title: 'Anlegen', target: 'canvas-new-create', kind: 'wait', wait: { appear: 'canvas-tools' }, text: '„Board anlegen“ öffnet die leere, unendliche Fläche.', do: 'Klicke auf **Board anlegen**.' },
      { title: 'Die Fläche', target: 'canvas-stage', placement: 'top', text: 'Mausrad oder zwei Finger verschieben, Strg + Mausrad oder Spreizen zoomt, Leertaste + Ziehen greift die Fläche. Doppelklick schreibt Text, Rechtsklick öffnet das Menü.' },
      { title: 'Die Werkzeuge', target: 'canvas-tools', text: 'Auswählen, Formen, Pfeile, Stift, Text, Notizen, Rahmen, Bilder, Icons, Tabellen und Diagramme. Pfeile bleiben an Formen haften und folgen, wenn du sie verschiebst. Die Taste **?** zeigt alle Kürzel.' },
      { title: 'Vorlagen', target: 'canvas-tool-templates', text: 'Fertige Startpunkte: Mindmap, Flussdiagramm, Customer Journey, Funnel-Plan, Vertriebsprozess, Organigramm, SWOT, Kanban, Wireframe-Kit und Social-Post-Layouts.' },
      { title: 'Live-Karten aus dem CRM', target: 'canvas-tool-crm', text: 'Kontakte, Firmen, Deals, Aufgaben, Tickets, Termine, Berichte und ganze Pipelines als Karte – immer mit dem aktuellen Stand. Ein Doppelklick öffnet den Datensatz.' },
      { title: 'KI zeichnen lassen', target: 'canvas-ai', text: 'Hier entstehen Diagramme, Mindmaps und Wireframes aus einer Beschreibung. Mit Auswahl: **Auswahl erklären**, **In Aufgaben verwandeln** und **Layout aufräumen**.' },
      { title: 'Stil und Umwandeln', target: 'canvas-inspector', text: 'Farbe, Linie, Schrift, Ecken – und „Handgezeichnet“ für den Skizzen-Look. Bei einer Notiz legst du hier mit einem Klick eine Aufgabe oder einen Deal im CRM an.' },
      { title: 'Zusammen arbeiten', target: 'canvas-people', text: 'Wer gerade am Board ist, siehst du hier und auf der Fläche mit Cursor. Auch KI-Agenten (der HyperLevel-Agent, Claude, ChatGPT) zeichnen live mit – mit eigenem, beschriftetem Cursor.' },
      { title: 'Exportieren und verwenden', target: 'canvas-export', text: 'PNG, SVG oder PDF – ganzes Board, Auswahl oder ein Rahmen. Oder direkt als Social-Post, E-Mail-Entwurf oder Funnel-Bild weiterverwenden.' },
      { title: 'Teilen', target: 'canvas-share', text: 'Team-Zugriff, einzelne Personen und ein öffentlicher Link zum Ansehen – ohne Anmeldung, ohne Live-Daten, jederzeit widerrufbar.' },
      { title: 'Versionen', target: 'canvas-history', text: 'Das Board sichert sich selbst Versionen. Du kannst eigene anlegen und eine ältere zurückholen – der aktuelle Stand wird vorher gesichert.' },
    ],
  },
];
