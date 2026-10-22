import type { Tour } from '../types';

/** Anzeigen: Meta and Google campaigns created and managed from HyperLevel. */
export const ADS_TOURS: Tour[] = [
  {
    id: 'ads',
    title: 'Anzeigen: Meta & Google',
    summary: 'Kampagnen bei Facebook, Instagram und Google direkt in HyperLevel anlegen, prüfen, steuern – alles startet pausiert, Geld fließt erst nach deiner Bestätigung.',
    icon: 'ads',
    group: 'marketing',
    perm: 'campaigns',
    minutes: 8,
    routes: ['ads'],
    keywords: 'anzeigen werbung ads meta facebook instagram google ads kampagne budget zielgruppe lookalike lead ads sofortformular regel pausieren freigabe customer match performance max',
    learned: ['Meta und Google mit dem eigenen Login verbinden und das Werbekonto wählen', 'Eine Kampagne im Assistenten bauen, prüfen und pausiert anlegen', 'Aktivieren und Budget ändern nur mit Bestätigung – Agent und MCP fragen nur an', 'Zielgruppen aus Smart Lists, Lead-Formulare und Regeln wie „pausieren bei zu hohem CPL“'],
    docs: { label: 'Anzeigen-Manager', file: 'ads-manager' },
    steps: [
      { title: 'Anzeigen', route: 'ads', target: 'nav-ads', text: 'Hier legst du Kampagnen für **Meta** (Facebook & Instagram) und **Google Ads** an und steuerst sie. Die Zahlen kommen aus dem Werbebericht, Leads landen als Kontakte im CRM.' },
      { title: 'Konten verbinden', route: 'ads/connections', target: 'ads-connect-meta', optional: true, missing: 'Die Verbindungen gehören zu den Einstellungen – dafür braucht dein Login dieses Recht.', text: 'Mit „Mit Meta verbinden“ meldest du dich bei Facebook an und wählst Werbekonto, Seite und Pixel. Das Passwort sieht HyperLevel nie; der Zugang wird vor dem Ablauf automatisch verlängert.' },
      { title: 'Google Ads', target: 'ads-connect-google', optional: true, text: 'Google läuft über die Google-App und den Developer-Token der Agentur. Du meldest dich an und wählst das Kundenkonto.' },
      { title: 'Tageslimit', target: 'ads-limit', optional: true, text: 'Kein Budget darf über dem Tageslimit liegen – schützt vor Tippfehlern und übereifrigen KI-Agenten. Passe es an dein Budget an.' },
      { title: 'Agentur-Zugänge', target: 'ads-agency', admin: true, optional: true, missing: 'Dieser Kasten ist nur für die Agentur sichtbar.', text: 'Einmal pro Installation: Meta-App (ID und Secret), Google-Ads-Developer-Token und optional das Verwaltungskonto. Danach verbindet jeder Sub-Account nur noch per Login.' },
      { title: 'Deine Kampagnen', route: 'ads', target: 'ads-table', optional: true, missing: 'Noch keine Kampagne – legen wir gleich eine an.', text: 'Status, Budget, Ausgaben, Klicks, Leads im CRM und Kosten pro Lead je Kampagne. Pausieren geht sofort; Aktivieren und Budget ändern fragen vorher nach.' },
      { title: 'Neue Kampagne', target: 'ads-new', text: 'Der Assistent führt in fünf Schritten: Ziel, Budget, Zielgruppe, Anzeige, Prüfen. Bis zum Schluss wird nichts bei Meta oder Google angelegt.' },
      { title: 'Die fünf Schritte', route: 'ads/new', target: 'ads-steps', text: 'Ziel (Leads, Besucher, Conversions, Reichweite), Budget und Zeitraum, Zielgruppe, Anzeige mit Link zu deinem Funnel (UTM kommt automatisch dazu) und zum Schluss die Prüfung.' },
      { title: 'Ziel und Plattform', target: 'ads-step-goal', optional: true, text: 'Wähle Plattform und Ziel. Bei Meta gibt es für Leads das Sofortformular direkt in Facebook/Instagram, bei Google das Suchnetzwerk oder Performance Max.' },
      { title: 'KI-Texte und Bilder', target: 'ads-ai', optional: true, missing: 'Die Texte findest du im vierten Schritt „Anzeige“ – dort gibt es auch KI-Vorschläge und Bilder aus Mediathek und KI-Studio.', text: 'Im Schritt „Anzeige“ schlägt die KI Texte vor (Zeichenlimits beachtet), Bilder kommen aus der Mediathek oder frisch aus dem KI-Studio.' },
      { title: 'Prüfen und pausiert anlegen', target: 'ads-publish', optional: true, missing: 'Der Knopf erscheint im letzten Schritt „Prüfen & anlegen“.', text: 'Die Prüfung zeigt alle Einstellungen, die Anzeige und die Ziel-Adresse mit UTM. „Pausiert anlegen“ erzeugt alles pausiert – es wird nichts ausgegeben.' },
      { title: 'Freigaben', route: 'ads', target: 'ads-approvals', optional: true, missing: 'Gerade ist nichts freizugeben. Fragt ein API-Schlüssel, MCP-Client oder der KI-Agent ein Aktivieren oder eine Budgeländerung an, erscheint es hier.', text: 'Automatisierungen geben nie selbst Geld aus: Sie fragen an, und du entscheidest hier – mit Protokolleintrag, wer es angefragt und wer es freigegeben hat.' },
      { title: 'Zielgruppen aus Smart Lists', route: 'ads/audiences', target: 'ads-audience-new', optional: true, text: 'Mach aus einer Smart List eine Kundenliste bei Meta oder Google. Übertragen werden nur SHA-256-Hashes, Abgemeldete bleiben draußen. Bei Meta entstehen daraus Lookalikes.' },
      { title: 'Leads aus Lead-Anzeigen', route: 'ads/leads', target: 'ads-leads-enable', optional: true, text: 'Schalte den Lead-Import ein: Jede Antwort wird ein Kontakt mit Tags und Notiz und startet Automationen („Neuer Lead aus Anzeige“). Ein Abruf alle 10 Minuten fängt verpasste Webhooks auf.' },
      { title: 'Regeln', route: 'ads/rules', target: 'ads-rule-new', optional: true, text: 'Beispiel: „Pausieren, wenn die Kosten pro Lead über 25 € liegen.“ Regeln prüfen alle 30 Minuten und können nur pausieren oder melden – nie aktivieren oder Budget erhöhen.' },
    ],
  },
];
