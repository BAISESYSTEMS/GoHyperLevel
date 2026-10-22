import { JOURNEY, MODULE_TOURS, GROUPS } from './catalog';
import { slug } from './slug';
import type { Tour } from './types';

/**
 * The printable handbook: the whole journey „Firma übernehmen“ as Markdown, generated from the same
 * data as the tours. The academy renders it (print → PDF) and docs/handbuch.md is a copy of it –
 * tests/academy.test.ts makes sure the copy stays up to date.
 */

const SECTIONS: Record<string, string> = {
  agency: 'Agentur',
  dashboard: 'Dashboard',
  boards: 'Boards',
  reports: 'Berichte',
  project: 'Projekt',
  conversations: 'Konversationen',
  calls: 'Anrufe',
  calendars: 'Kalender',
  contacts: 'Kontakte',
  companies: 'Firmen',
  objects: 'Objekte',
  properties: 'Eigenschaften',
  opportunities: 'Opportunities',
  tasks: 'Aufgaben',
  campaigns: 'Kampagnen',
  workflows: 'Automationen',
  social: 'Social Planner',
  attribution: 'Attribution',
  'lead-scoring': 'Lead-Scoring',
  webinars: 'Webinare',
  funnels: 'Funnels & Websites',
  forms: 'Formulare & Umfragen',
  courses: 'Kurse',
  community: 'Community',
  invoices: 'Rechnungen & Angebote',
  contracts: 'Verträge',
  products: 'Produkte',
  affiliates: 'Affiliates',
  calc: 'Gewinnrechner',
  reviews: 'Bewertungen',
  accounting: 'Buchhaltung',
  inventory: 'Lager & Einkauf',
  personal: 'Personal',
  tickets: 'Tickets',
  'help-center': 'Wissensdatenbank',
  surveys: 'Umfragen',
  apps: 'Apps',
  settings: 'Einstellungen',
  academy: 'Akademie',
};

const TABS: Record<string, string> = {
  'agency/projects': 'Projekte',
  'agency/contacts': 'Kontakte',
  'agency/deals': 'Deals',
  'agency/tasks': 'Aufgaben',
  'agency/docs': 'Dokumente',
  'agency/clients': 'Kunden',
  'agency/saas': 'SaaS',
  'agency/snapshots': 'Snapshots',
  'agency/domains': 'Domains',
  'agency/branding': 'White-Label',
  'agency/integrations': 'Integrationen',
  'agency/api': 'API & MCP',
  'agency/audit': 'Protokoll',
  'settings/company': 'Firma',
  'settings/messaging': 'E-Mail & SMS',
  'settings/channels': 'Kanäle',
  'settings/telephony': 'Telefonie',
  'settings/billing': 'Rechnungen',
  'settings/stripe': 'Stripe',
  'settings/reviews': 'Bewertungen',
  'settings/chat': 'Live-Chat',
  'settings/ai': 'KI-Assistent',
  'settings/helpdesk': 'Service',
  'settings/fields': 'Felder & Tags',
  'settings/consent': 'Einwilligung & Recht',
  'settings/api': 'API & Webhooks',
  'settings/import': 'Import',
  'settings/team': 'Team',
  'settings/locations': 'Sub-Accounts',
  'settings/account': 'Mein Konto',
  'social/calendar': 'Kalender',
  'social/stats': 'Statistik',
  'attribution/report': 'Bericht',
  'reports/templates': 'Vorlagen',
  'reports/schedules': 'Zeitpläne',
  'reports/new': 'Bericht erstellen',
  'tickets/uebersicht': 'Übersicht',
  'tickets/auslastung': 'Auslastung',
  'surveys/csat': 'Zufriedenheit (CSAT)',
  'surveys/nps': 'Weiterempfehlung (NPS)',
  'properties/company': 'Firmen',
  'affiliates/programs': 'Programme',
  'community/settings': 'Einstellungen',
  'accounting/receipts': 'Belege',
  'accounting/entries': 'Buchungen',
  'accounting/bank': 'Bank',
  'accounting/reports': 'Auswertungen',
  'accounting/export': 'Export & Festschreibung',
  'accounting/settings': 'Einstellungen',
  'inventory/movements': 'Bewegungen',
  'inventory/orders': 'Bestellungen',
  'inventory/counts': 'Inventur',
  'inventory/valuation': 'Bewertung',
  'inventory/places': 'Lagerorte',
  'inventory/settings': 'Einstellungen',
  'personal/overview': 'Übersicht',
  'personal/employees': 'Mitarbeiter',
  'personal/absences': 'Abwesenheiten',
  'personal/time': 'Arbeitszeit',
  'personal/checklists': 'Checklisten',
  'personal/settings': 'Einstellungen',
  'personal/me': 'Mein Bereich',
  'academy/handbuch': 'Handbuch',
  'apps/composio': 'Composio-Apps',
  'apps/events': 'App-Ereignisse',
  'apps/ai': 'KI & MCP',
  'apps/direct': 'Direkt-Verbindungen',
};

/** „Einstellungen → Telefonie“ for `settings/telephony`. */
export function placeLabel(route: string): string {
  const [a, b] = route.split('/');
  const first = SECTIONS[a] ?? a;
  const tab = b ? (TABS[`${a}/${b}`] ?? null) : null;
  return tab ? `${first} → ${tab}` : first;
}

const plain = (s: string, brand: string) => s.replace(/\{brand\}/g, brand).replace(/\s+/g, ' ').trim();
const docLink = (t: Tour) => (t.docs ? `[${t.docs.label}](${t.docs.file === 'README' ? '../README.de.md' : `${t.docs.file}.md`}${t.docs.anchor ? `#${t.docs.anchor}` : ''})` : '');

function chapter(t: Tour, brand: string): string {
  const out: string[] = [];
  out.push(`## Kapitel ${t.chapter}: ${t.title}`, '', `${plain(t.summary, brand)} *(ca. ${t.minutes} Minuten${t.admin ? ', nur für die Agentur' : ''})*`, '');
  let place = '';
  t.steps.forEach((s, i) => {
    const here = s.route ? placeLabel(s.route) : '';
    const where = here && here !== place ? ` *(${here})*` : '';
    if (here) place = here;
    const extra = s.do ? ` – *So geht's:* ${plain(s.do, brand)}` : '';
    out.push(`${i + 1}. **${plain(s.title, brand)}**${where} – ${plain(s.text, brand)}${extra}`);
  });
  out.push('', '**Das hast du gelernt:**', '');
  for (const l of t.learned) out.push(`- ${plain(l, brand)}`);
  if (t.docs) out.push('', `Mehr dazu: ${docLink(t)}`);
  out.push('');
  return out.join('\n');
}

export function handbookMarkdown(brand = 'HyperLevel'): string {
  const minutes = JOURNEY.reduce((s, t) => s + t.minutes, 0);
  const out: string[] = [
    `# Handbuch: Die Firma mit ${brand} übernehmen`,
    '',
    `Dieses Handbuch ist die gedruckte Fassung des Gesamt-Guides **„Firma übernehmen“** aus der **Akademie** (Menüpunkt *Akademie* in ${brand}). Es führt eine Nachfolgerin oder einen Nachfolger in ${JOURNEY.length} Kapiteln durch alles, was man braucht, um die Firma zu führen – vom sicheren Zugang über die Tagesroutine bis zum Betrieb des Servers. Zusammen dauert das etwa ${Math.round(minutes / 60)} Stunden; jedes Kapitel lässt sich einzeln machen und später fortsetzen.`,
    '',
    '> Am besten machst du die Kapitel direkt in der App: Die Tour markiert dort jedes Feld und jeden Knopf, erklärt ihn und wartet, bis du ihn ausprobiert hast. Zum Üben legt die Akademie auf Wunsch eine **Übungs-Firma** mit erfundenen Kunden an – dort kann nichts kaputtgehen und nichts wird verschickt.',
    '',
    '**Inhalt**',
    '',
    ...JOURNEY.map((t) => `${t.chapter}. [${t.title}](#${slug(`Kapitel ${t.chapter}: ${t.title}`)}) – ${plain(t.summary, brand)}`),
    '',
    '---',
    '',
  ];
  for (const t of JOURNEY) out.push(chapter(t, brand), '---', '');
  out.push('## Anhang: Alle Modul-Touren', '', `Neben dem Gesamt-Guide gibt es für jeden Bereich eine kurze Tour (5–15 Schritte). Du findest sie in der Akademie oder über das **?** oben rechts auf jeder Seite.`, '');
  for (const g of GROUPS) {
    const list = MODULE_TOURS.filter((t) => t.group === g.id);
    if (!list.length) continue;
    out.push(`### ${g.label}`, '');
    for (const t of list) out.push(`- **${t.title}** (${t.steps.length} Schritte, ca. ${t.minutes} Min.${t.admin ? ', Agentur' : ''}) – ${plain(t.summary, brand)}`);
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
