import type { IconName } from '../icons';

/**
 * What each menu area is for, in one line (the "Mehr" panel and the command palette show it), extra search words, and the
 * quick actions the palette and the Start page offer. German message ids of the `simple` catalog (web/src/i18n/en/simple.ts).
 * A quick action's `to` ends in `?new=1`: the page opens and its primary action starts (PageHead in ui.tsx).
 */

export const AREA_DESC: Record<string, string> = {
  agency: 'Alle Firmen und Kunden, Vorlagen, Domains und White-Label',
  dashboard: 'Kennzahlen und nächste Schritte auf einen Blick',
  boards: 'Eigene Übersichten aus Kacheln zusammenstellen',
  workspace: 'Mehrere Seiten nebeneinander auf großen Bildschirmen',
  reports: 'Auswertungen, eigene Berichte und Zeitpläne',
  project: 'Profil, Status und Links dieser Firma',
  conversations: 'E-Mail, SMS, Chat und Messenger in einem Posteingang',
  calls: 'Telefonate, Anrufliste, Wählhilfe und Leitfäden',
  calendars: 'Termine, Buchungsseiten und Verfügbarkeiten',
  contacts: 'Alle Kontakte mit Verlauf, Tags und Feldern',
  companies: 'Firmen mit ihren Kontakten und Deals',
  objects: 'Eigene Datensätze wie Projekte, Verträge oder Fahrzeuge',
  opportunities: 'Deals in Pipelines vom ersten Gespräch bis zum Abschluss',
  sales: 'Angebote, Sequenzen, Ziele und Bestenliste',
  tasks: 'Meine Aufgaben und Erinnerungen',
  pm: 'Projekte mit Aufgaben, Board, Gantt und Auslastung',
  time: 'Arbeitszeit erfassen und abrechnen',
  canvas: 'Whiteboards und Designs',
  wiki: 'Wissen und Anleitungen des Teams',
  office: 'Dokumente, Tabellen, Präsentationen und PDF',
  'team-chat': 'Chat mit dem Team in Kanälen',
  tickets: 'Support-Anfragen mit Zuständigkeit und Fristen',
  'help-center': 'Hilfeartikel für Kunden',
  surveys: 'Umfragen und Kundenzufriedenheit',
  campaigns: 'E-Mail-Kampagnen, Vorlagen und Zustellung',
  workflows: 'Abläufe automatisieren: wenn das passiert, tu dies',
  social: 'Beiträge für Social Media planen',
  'video-studio': 'Videos schneiden und untertiteln',
  'ki-studio': 'Bilder und Texte mit KI erstellen',
  'ai-studio': 'Apps und Websites im Chat mit KI bauen und veröffentlichen',
  attribution: 'Woher deine Leads kommen',
  ads: 'Werbeanzeigen und Zielgruppen verwalten',
  'lead-scoring': 'Punkte für interessierte Kontakte vergeben',
  webinars: 'Webinare mit Anmeldung und Erinnerungen',
  'comment-dm': 'Auf Kommentare automatisch per Direktnachricht antworten',
  funnels: 'Websites, Landingpages und Verkaufsseiten bauen',
  forms: 'Formulare und Umfragen für Anfragen',
  courses: 'Online-Kurse mit Lektionen und Mitgliederbereich',
  quizzes: 'Quiz und Zertifikate für Teilnehmer',
  community: 'Gruppen, Beiträge und Termine für deine Mitglieder',
  invoices: 'Rechnungen, Angebote und Gutschriften',
  contracts: 'Verträge digital unterschreiben lassen',
  products: 'Leistungen und Preise',
  'payment-plans': 'Beträge in Raten bezahlen lassen',
  dunning: 'Zahlungserinnerungen und Mahnungen',
  sepa: 'Lastschriften einziehen',
  affiliates: 'Partner werben Kunden und bekommen Provision',
  calc: 'Rechnet aus, was sich lohnt',
  profit: 'Was Projekte und Kunden wirklich einbringen',
  reviews: 'Bewertungen sammeln und beantworten',
  accounting: 'Belege, Buchungen und Berichte',
  inventory: 'Lagerbestand und Einkauf',
  personal: 'Mitarbeiter, Abwesenheiten und Dokumente',
  agents: 'KI-Agenten für Chat und Telefon',
  werkstatt: 'Eigene Erweiterungen bauen',
  marktplatz: 'Erweiterungen installieren',
  apps: 'Andere Apps verbinden',
  umzug: 'Daten aus GoHighLevel, HubSpot & Co. übernehmen',
  academy: 'Touren und Anleitungen zu jedem Bereich',
  trash: 'Gelöschtes wiederherstellen',
  settings: 'Firma, Kanäle, Team und Darstellung',
};

/** Extra words the palette and the "Mehr" search match (English names, synonyms). */
/** A small pill next to the menu label (message id of the shell and simple catalogs). */
export const AREA_BADGE: Record<string, string> = { 'ai-studio': 'Beta' };

export const AREA_KEYWORDS: Record<string, string> = {
  'ai-studio': 'App-Builder Lovable Bolt Vibe-Coding React Website KI Claude OpenAI OpenRouter BYOK veröffentlichen', // i18n-ignore
  opportunities: 'Opportunities Pipeline Verkaufschancen', // i18n-ignore
  conversations: 'Posteingang Inbox Nachrichten', // i18n-ignore
  funnels: 'Website Landingpage Seiten', // i18n-ignore
  workflows: 'Automation Workflow', // i18n-ignore
  invoices: 'Angebot Gutschrift Rechnung', // i18n-ignore
  pm: 'Projektplanung Gantt', // i18n-ignore
  project: 'Projekt Firma', // i18n-ignore
  social: 'Social Planner Instagram Facebook LinkedIn', // i18n-ignore
  umzug: 'Import Migration', // i18n-ignore
  'help-center': 'Knowledge Base FAQ', // i18n-ignore
  attribution: 'Lead-Herkunft UTM', // i18n-ignore
  affiliates: 'Partnerprogramm', // i18n-ignore
};

export interface QuickAction {
  id: string;
  label: string;
  icon: IconName;
  /** The menu area (permission and hidden state come from there). */
  area: string;
  to: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'contact', label: 'Kontakt anlegen', icon: 'contact', area: 'contacts', to: 'contacts?new=1' },
  { id: 'message', label: 'Neue Nachricht', icon: 'send', area: 'conversations', to: 'conversations?new=1' },
  { id: 'appointment', label: 'Termin eintragen', icon: 'calendars', area: 'calendars', to: 'calendars?new=1' },
  { id: 'deal', label: 'Deal anlegen', icon: 'deal', area: 'opportunities', to: 'opportunities?new=1' },
  { id: 'invoice', label: 'Rechnung schreiben', icon: 'invoices', area: 'invoices', to: 'invoices?new=1' },
  { id: 'task', label: 'Aufgabe anlegen', icon: 'tasks', area: 'tasks', to: 'tasks?new=1' },
  { id: 'form', label: 'Formular bauen', icon: 'forms', area: 'forms', to: 'forms?new=1' },
  { id: 'funnel', label: 'Website oder Funnel bauen', icon: 'funnels', area: 'funnels', to: 'funnels?new=1' },
  { id: 'campaign', label: 'E-Mail-Kampagne schreiben', icon: 'campaigns', area: 'campaigns', to: 'campaigns?new=1' },
  { id: 'workflow', label: 'Automation bauen', icon: 'workflows', area: 'workflows', to: 'workflows?new=1' },
  { id: 'course', label: 'Kurs anlegen', icon: 'courses', area: 'courses', to: 'courses?new=1' },
];
