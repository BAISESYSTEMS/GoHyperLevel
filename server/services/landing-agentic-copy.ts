import type { Lang } from './landing-copy.js';
import type { LogosText } from './landing-logos.js';

/**
 * Launch landing page: the texts of the agentic sections (landing-agentic.ts) – one source of truth, Jarvis, the reasons that make
 * {b} different, the Academy, designs, XR and open source – plus the screenshots' alt texts and the integrations row, in German and
 * English. Same rules as landing-copy.ts: one interface for both languages, `{b}` is the product name, every claim backed by the code
 * or the docs. Live numbers (themes, icon packs, MCP tools) come from the running code; the Academy's numbers are written here and
 * checked against web/src/tour/catalog.ts by tests/landing.test.ts. Nothing here speaks of the hosted cloud, so the cloud waitlist
 * mode needs no replacements.
 */

/** The Academy, as the page states it: chapters exactly, module tours (without the course) and lessons at least, in ten groups. */
export const ACADEMY = { chapters: 14, tours: 120, lessons: 10, groups: 10 } as const;

export type ShotKey = 'jarvis' | 'pipeline' | 'inbox' | 'workflow' | 'funnel' | 'academy' | 'themes' | 'xr';
/** Numbers the texts need, already formatted for the language. */
export interface Nums {
  tools: string;
  themes: string;
  iconPacks: string;
}
export type UspIcon = 'seat' | 'db' | 'jarvis' | 'key' | 'xr' | 'palette' | 'cap' | 'code' | 'flag';

export interface AgenticCopy {
  logos: LogosText;
  ssot: { kicker: string; h2: string; lead: string; flowLabel: string; agentsLabel: string; agents: string[]; hub: string; hubSub: string; dataLabel: string; data: string[]; guards: string[]; fine: string; docs: string };
  jarvis: { h2: string; lead: string; items: [string, string][]; demo: { label: string; you: string; jarvis: string; card: string; run: string; reject: string; note: string }; fine: string; docs: string };
  usp: { h2: string; lead: string; items: (n: Nums) => [UspIcon, string, string][] };
  academy: { h2: string; lead: string; stats: [string, string][]; items: string[]; docs: string };
  designs: { h2: string; lead: string; items: (n: Nums) => string[]; docs: string };
  xr: { h2: string; lead: string; items: string[]; devices: string; note: string; docs: string };
  oss: { h2: string; lead: string; contrib: string; issues: string; star: string; fine: string };
  shots: Record<ShotKey, string>;
  builtWith: string;
}

const A = ACADEMY;

const de: AgenticCopy = {
  logos: {
    h2: 'Verbindet sich mit deinen Lieblings-Tools',
    label: 'Integrationen',
    note: 'Die Logos sind Marken ihrer Inhaber und zeigen verfügbare Integrationen.',
    more: 'Alle Integrationen',
  },
  ssot: {
    kicker: 'Kein weiteres AIOS – die Business-Schicht für deins',
    h2: 'Eine einzige Quelle der Wahrheit – gepflegt von deinen Agenten',
    lead: 'Du hast schon einen Agenten oder ein AIOS? Behalte es – {b} ist der Universaladapter darunter. Claude, ChatGPT, Codex, Cursor, Hermes, dein eigener Agent-Harness oder jedes System, das MCP oder REST spricht, stöpselt sich in Minuten an. Dann legt es Kontakte, Deals, Notizen, Aufgaben, Rechnungen und Projekte an und hält sie aktuell – du tippst nichts mehr selbst ins CRM. Jeder Agent und jeder Mensch liest und schreibt dieselbe Datenbank: mit denselben Rechten, demselben Protokoll und demselben Rückgängig.',
    flowLabel: 'So arbeiten Agenten und Menschen auf denselben Daten',
    agentsLabel: 'Wer daran arbeitet',
    agents: ['Claude', 'ChatGPT', 'Codex', 'Hermes', 'Cursor', 'Jarvis', 'Deine eigenen Agenten', 'Dein Team'],
    hub: 'Eine Datenbank',
    hubSub: 'dieselben Daten für alle',
    dataLabel: 'Was sie aktuell halten',
    data: ['Kontakte', 'Deals', 'Notizen', 'Aufgaben', 'Rechnungen', 'Projekte'],
    guards: ['Dieselben Rechte wie ein Mensch', 'Jede Änderung im Protokoll', 'Rückgängig, Verlauf und Papierkorb', 'Auf Wunsch nur lesende Schlüssel'],
    fine: 'Nichts wird hinter deinem Rücken verschickt, gelöscht oder bezahlt: In {b} zeigt der Agent vorher eine Bestätigungskarte, und jedes MCP-Werkzeug sagt deinem KI-Programm, ob es liest, schreibt oder versendet – so kann es dich vorher fragen. Agenten erreichen nur, was ihr Schlüssel oder Login darf.',
    docs: 'Anleitung für alle KI-Werkzeuge',
  },
  jarvis: {
    h2: 'Jarvis: dein Sprach-Begleiter und KI-Business-Developer',
    lead: 'Tipp auf Fokus, sag „Hey Jarvis“ oder halte Alt+J: Die Menüs treten zur Seite, und ein einziges Eingabefeld antwortet mit Live-Zahlen aus deinen Daten. Als Business Developer denkt Jarvis ans ganze Geschäft – Umsatz, Pipeline, Lead-Fluss, Kundenbindung –, ordnet nach €-Wirkung und endet mit ein bis drei Schritten, die er für dich vorbereitet.',
    items: [
      ['Wachstums-Briefing am Morgen', 'Die Top-3-Chancen und -Risiken mit €-Betrag und eine Wachstumsidee mit fertigem Entwurf – nur, wenn es Neues gibt. Du schaltest es ein.'],
      ['Wochenbilanz am Montag', 'Umsatz, neue Leads, gewonnene Deals, Abschlussquote und Pipeline gegenüber der Vorwoche.'],
      ['Check-ins und Meldungen', 'Zu deinen Uhrzeiten, mit Ruhezeit – und sofort, wenn ein Lead kommt, eine Nachricht zu lange wartet, eine Bewertung schlecht ist oder eine Zahlung fehlschlägt.'],
      ['Bereitet vor, entscheidet nicht', 'Antworten, E-Mails, Aufgaben und Social-Posts als Entwurf. Was rausgeht, wartet auf deinen Klick – die Stimme bestätigt nie.'],
      ['Spricht wie ein Kollege', 'Gesprächsmodus mit Unterbrechen, Antworten werden gesprochen, während sie entstehen, Aufgaben laufen im Hintergrund weiter.'],
      ['Hilft, auch wenn Modelle ausfallen', 'Fällt ein Modell aus, antwortet das nächste der Ersatzkette; antwortet keines, antwortet Jarvis aus deinen Zahlen.'],
    ],
    demo: {
      label: 'Beispiel',
      you: '„Hey Jarvis, was brennt?“',
      jarvis: 'Eine Rechnung ist überfällig, und ein neuer Lead wartet noch auf eine Antwort. Soll ich Anna an ihre Rechnung erinnern?',
      card: 'E-Mail an Anna senden: Zahlungserinnerung',
      run: 'Ausführen',
      reject: 'Ablehnen',
      note: 'Nichts geht raus, bevor du klickst.',
    },
    fine: 'Jarvis spricht mit deinem eigenen Sprachanbieter (Google, kie.ai mit ElevenLabs-Stimmen, OpenAI und andere) oder mit der Browserstimme. Das Weckwort ist pro Gerät freiwillig und nutzt die Spracherkennung des Browsers (Chrome, Edge, Safari).',
    docs: 'So funktionieren Fokus-Modus und Jarvis',
  },
  usp: {
    h2: 'Was {b} anders macht',
    lead: 'Neun Gründe – jeder davon im Code des Repositorys belegt.',
    items: (n) => [
      ['seat', '0 € pro Nutzer, auf deinem Server', 'Selbst gehostet ist das ganze Produkt: alle Funktionen, unbegrenzt Nutzer, Kontakte und Sub-Accounts. Du zahlst einen kleinen Server, nicht pro Person.'],
      ['db', 'Eine Quelle der Wahrheit für Menschen und Agenten', 'Agenten füllen und pflegen das CRM über MCP und die REST-API; alle arbeiten auf denselben Daten – mit denselben Rechten, Protokoll und Rückgängig.'],
      ['jarvis', 'Jarvis, dein agentischer Butler', 'Brieft dich am Morgen, meldet sich, wenn etwas passiert, und bereitet den nächsten Schritt vor – du bestätigst mit einem Klick.'],
      ['key', 'Dein eigenes Claude- oder ChatGPT-Abo', 'Für deine persönlichen Chats: Claude über die offizielle Claude-Code-CLI auf deinem eigenen Rechner (die Bridge), ChatGPT mit „Mit ChatGPT anmelden“ bei selbst gehosteten Installationen. Automationen, Teams und Kunden nutzen API-Schlüssel – so wollen es die Regeln der Anbieter.'],
      ['xr', 'Gemacht für XR- und Datenbrillen', 'Ein Raum-Modus mit 60-px-Zielen für Blick und Pinch, 2–4 Seiten nebeneinander für riesige virtuelle Bildschirme, Boards und Canvas als schwebende Panels in WebXR. Beta.'],
      ['palette', 'Dein Design, bis zu den Icons', `${n.themes} Themes, jedes hell und dunkel, jede Akzentfarbe, ${n.iconPacks} Icon-Pakete, deine Logos und deine Login-Domain – volles White-Label für Agenturen.`],
      ['cap', 'Eine Akademie direkt in der App', `${A.chapters} Kapitel und über ${A.tours} Modul-Touren, die mit dir durch die echte Oberfläche klicken, eine Übungs-Firma und ein Handbuch zum Drucken.`],
      ['code', '100 % offen, 100 % anpassbar', 'Jede Funktion liegt unter AGPL-3.0 im Repository – keine Enterprise-Edition. Eigene Module einbauen, alles anbinden über REST-API, Webhooks und MCP.'],
      ['flag', 'Deutsch & Englisch, DSGVO, E-Rechnung', 'Einwilligungs-Nachweis, Double-Opt-in, DSGVO-Auskunft und -Löschung, XRechnung und ZUGFeRD, SEPA und DATEV-Export – gebaut für Firmen in Deutschland, Österreich und der Schweiz.'],
    ],
  },
  academy: {
    h2: 'Die Akademie: {b} lernen – direkt in {b}',
    lead: 'Geführte Touren in der echten Oberfläche: Die Tour markiert das Feld oder den Knopf, erklärt ihn in ein, zwei Sätzen, sagt, was du klicken oder tippen sollst, wartet, bis du es gemacht hast – und geht weiter, auch über mehrere Seiten.',
    stats: [
      [String(A.chapters), 'Kapitel im Gesamt-Guide'],
      [`${A.tours}+`, 'Modul-Touren'],
      [String(A.lessons), 'Lektionen im Gründer-Kurs'],
    ],
    items: [
      `Gesamt-Guide „Firma übernehmen“: ${A.chapters} Kapitel, zusammen rund fünf Stunden – jedes Kapitel einzeln und jederzeit fortsetzbar.`,
      `Über ${A.tours} Modul-Touren, für jeden Bereich eine mit 5–15 Schritten – in ${A.groups} Gruppen von „Erste Schritte“ bis „Agentur & Betrieb“.`,
      `Kurs „Deine Firma mit {b} führen“: ${A.lessons} Lektionen für Gründerinnen und Gründer, jede mit einer 10-Minuten-Aufgabe in der echten Oberfläche.`,
      'Eine Übungs-Firma mit erfundenen Daten, in der E-Mail und SMS nur gespeichert, nie verschickt werden.',
      'Fortschritt und Abzeichen je Person, auf dem Server gespeichert – nach dem Neuladen bist du sofort wieder in der laufenden Tour.',
      '„In 10 Minuten startklar“ auf der Startseite, „Lernen“ in leeren Ansichten, das „?“ auf jeder Seite – und ein Handbuch zum Drucken oder als PDF.',
    ],
    docs: 'Alles zur Akademie',
  },
  designs: {
    h2: 'So sieht es aus wie dein Business',
    lead: 'Das Aussehen ist Daten, kein Code: Jede Person wählt ihres, die Agentur setzt Vorgaben und Sperren, und jeder Kunde kann seine eigene Marke tragen.',
    items: (n) => [
      `${n.themes} Themes, jedes mit passender heller und dunkler Variante – inklusive eines Kontrast-Themes.`,
      'Jede Akzentfarbe: Hover, Fokusring und Schrift auf dem Akzent leiten sich selbst ab und bleiben lesbar.',
      `${n.iconPacks} Icon-Pakete, eine Farbe je Menübereich, Dichte, Schriftgröße und eine Seitenleiste, die sich auf Icons verkleinert.`,
      'Deine Logos für hell und dunkel, ein quadratisches Zeichen, Favicon, App-Name und Login-Domain – pro Agentur und pro Kunde.',
      'Der Einfach-Modus zeigt zuerst das Wichtige, Profi zeigt alles; Kacheln und Karten ordnest du überall selbst.',
    ],
    docs: 'Darstellung und Themes',
  },
  xr: {
    h2: 'Bereit für XR- und Datenbrillen',
    lead: 'Nutze {b} mit Blick und Pinch, mit Controllern oder auf dem riesigen virtuellen Bildschirm einer Datenbrille – im Browser der Brille, ohne App Store.',
    items: [
      'Raum-Modus: 60-px-Ziele, viel Platz, eine größere Schrift und ein sanftes Leuchten beim Hinsehen – schaltet sich auf einer erkannten Brille selbst ein, oder von Hand.',
      'Arbeitsfläche: 2–4 Seiten nebeneinander – Posteingang, Kontakt, Board, Agent – für 21:9- und 32:9-Bildschirme und die virtuellen Bildschirme von Datenbrillen.',
      'In XR öffnen: ein Living Board als schwebende Panels an einer gebogenen Wand, ein Canvas als große Fläche; greifen, verschieben und per Push-to-Talk mit dem Board sprechen. Ohne WebXR läuft es als 3D-Vorschau im Browser.',
      'Als App installierbar, direkt aus dem Browser der Brille.',
    ],
    devices: 'Automatisch erkannt: Apple Vision Pro (Safari), Meta Quest 2, 3 und Pro (Quest Browser), Android-XR-Brillen (Chrome), Pico und Wolvic. Xreal, Viture und andere Datenbrillen sind externe Bildschirme – dort schaltest du den Raum-Modus von Hand ein.',
    note: 'Beta: im Browser und mit einer simulierten WebXR-Brille getestet, noch nicht auf echter Hardware. Der Raum-Modus von Hand und die 3D-Vorschau funktionieren immer.',
    docs: 'So funktioniert XR',
  },
  oss: {
    h2: 'Open Source – und offen für Beiträge',
    lead: 'Jedes Modul, jede Ansicht und jeder Workflow-Schritt liegt unter AGPL-3.0 auf GitHub – gemacht, um erweitert zu werden. Tippfehler korrigieren, einen Connector ergänzen, die Oberfläche übersetzen oder ein ganzes Modul bauen: Beiträge sind willkommen.',
    contrib: 'So machst du mit (CONTRIBUTING.md)',
    issues: 'Gute erste Issues',
    star: 'Stern auf GitHub geben',
    fine: 'Pull Requests brauchen einmalig eine Unterschrift unter die CLA – der CLA Assistant fragt beim ersten. Sicherheitslücken bitte vertraulich melden (SECURITY.md).',
  },
  shots: {
    jarvis: 'Fokus-Modus mit dem Begleiter Jarvis',
    pipeline: 'Pipeline mit Deals in jeder Phase',
    inbox: 'Gemeinsames Postfach mit einer E-Mail-Unterhaltung',
    workflow: 'Workflow-Editor mit Auslöser und Schritten',
    funnel: 'Website-Baukasten mit Seitenvorschau',
    academy: 'Die Akademie mit ihren geführten Touren',
    themes: 'Mehrere {b}-Designs nebeneinander',
    xr: '{b} im Raum-Modus für XR-Brillen',
  },
  builtWith: 'Gebaut mit Claude',
};

const en: AgenticCopy = {
  logos: {
    h2: 'Integrates with your favorite tools',
    label: 'Integrations',
    note: 'Logos are trademarks of their owners and show available integrations.',
    more: 'All integrations',
  },
  ssot: {
    kicker: 'Not another AIOS – the business layer under yours',
    h2: 'One single source of truth – kept up to date by your agents',
    lead: "Already run an agent or an AI OS? Keep it – {b} is the universal adapter underneath. Claude, ChatGPT, Codex, Cursor, Hermes, your own agent harness or anything that speaks MCP or REST plugs in within minutes. Then it creates and maintains contacts, deals, notes, tasks, invoices and projects for you – you stop typing data into your CRM. Every agent and every person reads and writes the same database – with the same permissions, the same audit log and the same undo.",
    flowLabel: 'How agents and people work on the same data',
    agentsLabel: 'Who works on it',
    agents: ['Claude', 'ChatGPT', 'Codex', 'Hermes', 'Cursor', 'Jarvis', 'Your own agents', 'Your team'],
    hub: 'One database',
    hubSub: 'the same data for everyone',
    dataLabel: 'What they keep up to date',
    data: ['Contacts', 'Deals', 'Notes', 'Tasks', 'Invoices', 'Projects'],
    guards: ['The same permissions as a person', 'Every change in the audit log', 'Undo, history and trash', 'Read-only keys if you want'],
    fine: 'Nothing is sent, deleted or paid behind your back: inside {b} the agent shows a confirmation card first, and every MCP tool tells your AI client whether it reads, writes or sends, so the client can ask you. Agents only reach what their key or login may reach.',
    docs: 'Guide for every AI tool',
  },
  jarvis: {
    h2: 'Jarvis: your voice companion and AI business developer',
    lead: 'Tap Fokus, say “Hey Jarvis” or hold Alt+J: the menus step aside and one prompt answers with live numbers from your data. As business developer, Jarvis looks at the whole business – revenue, pipeline, lead flow, retention – ranks what matters by its impact in euros and ends with one to three steps it prepares for you.',
    items: [
      ['Growth briefing in the morning', 'The top three opportunities and risks with their € amount, and one growth idea with a ready draft – only when there is something new. You switch it on.'],
      ['Weekly review on Mondays', 'Revenue, new leads, won deals, win rate and pipeline against the week before.'],
      ['Check-ins and alerts', 'At the times you choose, with quiet hours – and right away when a lead comes in, a message waits too long, a review is bad or a payment fails.'],
      ['Prepares, never presumes', 'Replies, e-mails, tasks and social posts as drafts. Anything that goes out waits for your click – voice never confirms.'],
      ['Talks like a colleague', 'Conversation mode with barge-in, answers spoken while they are written, tasks that keep running in the background.'],
      ["Helps when models don't", 'If a model fails, the next one in the fallback chain answers; if none does, Jarvis answers from your numbers.'],
    ],
    demo: {
      label: 'Example',
      you: '“Hey Jarvis, what needs me today?”',
      jarvis: 'An invoice is overdue and a new lead is still waiting for an answer. Shall I send Anna a reminder about her invoice?',
      card: 'Send e-mail to Anna: payment reminder',
      run: 'Run',
      reject: 'Decline',
      note: 'Nothing is sent until you click.',
    },
    fine: "Jarvis speaks with your own voice provider (Google, kie.ai with ElevenLabs voices, OpenAI and others) or with the browser's voice. The wake word is opt-in per device and uses the browser's own speech recognition (Chrome, Edge, Safari).",
    docs: 'How focus mode and Jarvis work',
  },
  usp: {
    h2: 'What makes {b} different',
    lead: 'Nine reasons – each one backed by the code in the repository.',
    items: (n) => [
      ['seat', '€0 per seat, on your server', 'Self-hosted is the full product: every feature, unlimited users, contacts and sub-accounts. You pay for a small server, not per person.'],
      ['db', 'One source of truth for people and agents', 'Agents fill and maintain the CRM over MCP and the REST API; everyone works on the same data – with the same permissions, audit log and undo.'],
      ['jarvis', 'Jarvis, your agentic butler', 'Briefs you in the morning, speaks up when something happens and prepares the next step – you confirm with one click.'],
      ['key', 'Your own Claude or ChatGPT plan', "For your personal chats: Claude through the official Claude Code CLI on your own computer (the bridge), ChatGPT with “Sign in with ChatGPT” on self-hosted installs. Automations, teams and clients use API keys – that is what the providers' rules ask for."],
      ['xr', 'Made for XR headsets and display glasses', 'A spatial mode with 60 px targets for eyes and pinch, 2–4 pages side by side for giant virtual screens, boards and canvases as floating panels in WebXR. Beta.'],
      ['palette', 'Your design, down to the icons', `${n.themes} themes, each light and dark, any accent colour, ${n.iconPacks} icon packs, your logos and your login domain – full white-label for agencies.`],
      ['cap', 'An academy built into the app', `${A.chapters} chapters and more than ${A.tours} module tours that click through the real interface with you, a practice company and a handbook to print.`],
      ['code', '100 % open, 100 % customizable', 'Every feature is in the repository under AGPL-3.0 – no enterprise edition. Add your own modules; connect anything through the REST API, webhooks and MCP.'],
      ['flag', 'German & English, GDPR, e-invoices', 'Consent records, double opt-in, GDPR access and erasure, XRechnung and ZUGFeRD, SEPA and DATEV export – built for businesses in Germany, Austria and Switzerland.'],
    ],
  },
  academy: {
    h2: 'The Academy: learn {b} inside {b}',
    lead: 'Guided tours in the real interface: the tour highlights the field or button, explains it in a sentence or two, says what to click or type, waits until you have done it – and moves on, across pages.',
    stats: [
      [String(A.chapters), 'chapters in the takeover guide'],
      [`${A.tours}+`, 'module tours'],
      [String(A.lessons), 'lessons in the founders’ course'],
    ],
    items: [
      `Guide “Take over the company”: ${A.chapters} chapters, about five hours in all – each chapter on its own and resumable at any time.`,
      `More than ${A.tours} module tours, one for every area, with 5–15 steps each – in ${A.groups} groups from first steps to agency operations.`,
      `Course “Run your company with {b}”: ${A.lessons} lessons for founders, each with a 10-minute task in the real interface.`,
      'A practice company with made-up data where e-mail and SMS are only saved, never sent.',
      'Progress and badges per person, saved on the server – after a reload you are straight back in the running tour.',
      '“Ready in 10 minutes” on the start page, “Learn” in empty views, the “?” on every page – and a handbook to print or save as PDF.',
    ],
    docs: 'All about the Academy (German)',
  },
  designs: {
    h2: 'Make it look like your business',
    lead: 'The look is data, not code: everyone picks their own, the agency sets defaults and locks, and every client can carry its own brand.',
    items: (n) => [
      `${n.themes} themes, each with a matched light and dark variant – a high-contrast one included.`,
      'Any accent colour: hover, focus ring and the text on the accent derive themselves and stay readable.',
      `${n.iconPacks} icon packs, a colour for every menu area, density, font size and a sidebar that folds to icons.`,
      'Your logos for light and dark, a square mark, favicon, app name and login domain – per agency and per client.',
      'Einfach-Modus shows the essentials first, Profi shows everything; you put tiles and cards in your own order, everywhere.',
    ],
    docs: 'Appearance and themes',
  },
  xr: {
    h2: 'Ready for XR headsets and display glasses',
    lead: "Use {b} with eyes and a pinch, with controllers, or on the huge virtual screen of display glasses – in the headset's browser, without an app store.",
    items: [
      'Raum-Modus (spatial mode): 60 px targets, roomy spacing, a larger type scale and a soft glow where you look – on by itself on a recognised headset, or by hand.',
      'Arbeitsfläche (workspace): 2–4 pages side by side – inbox, contact, board, agent – for 21:9 and 32:9 screens and the virtual screens of display glasses.',
      'In XR öffnen (open in XR): a Living Board as floating panels on a curved wall, a canvas as a large plane; grab, move and talk to the board with push-to-talk. Without WebXR it runs as a 3D preview in the browser.',
      "Installable as an app, right from the headset's browser.",
    ],
    devices: 'Recognised automatically: Apple Vision Pro (Safari), Meta Quest 2, 3 and Pro (Quest Browser), Android XR headsets (Chrome), Pico and Wolvic. Xreal, Viture and other display glasses are external screens – switch the Raum-Modus on by hand there.',
    note: 'Beta: tested in the browser and with a simulated WebXR headset, not yet on real hardware. The manual Raum-Modus and the 3D preview always work.',
    docs: 'How XR works',
  },
  oss: {
    h2: 'Open source – and open for contributions',
    lead: 'Every module, every screen and every workflow step is on GitHub under AGPL-3.0, made to be extended. Fix a typo, add a connector, translate the interface or ship a whole module – contributions are welcome.',
    contrib: 'How to contribute (CONTRIBUTING.md)',
    issues: 'Good first issues',
    star: 'Star it on GitHub',
    fine: 'Pull requests need a one-time signature of the CLA – the CLA Assistant asks on your first one. Please report vulnerabilities privately (SECURITY.md).',
  },
  shots: {
    jarvis: 'Focus mode with the Jarvis companion',
    pipeline: 'Pipeline with deals in every stage',
    inbox: 'Shared inbox with an e-mail conversation',
    workflow: 'Workflow editor with a trigger and steps',
    funnel: 'Website builder with a page preview',
    academy: 'The Academy with its guided tours',
    themes: 'Several {b} designs side by side',
    xr: '{b} in the spatial mode for XR headsets',
  },
  builtWith: 'Built with Claude',
};

export const AGENTIC: Record<Lang, AgenticCopy> = { de, en };
