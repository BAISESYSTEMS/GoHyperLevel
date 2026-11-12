import { JOURNEY, MODULE_TOURS, GROUPS } from './catalog';
import { HANDBOOK_EN } from './handbook.en';
import { slug } from './slug';
import type { Tour } from './types';

/**
 * The printable handbook: the whole journey „Firma übernehmen“ as Markdown, generated from the same
 * data as the tours – in German (the tours' own language) and in English (texts from handbook.en.ts).
 * The academy renders it (print → PDF); docs/handbook.de.md and docs/handbook.md are copies of it,
 * written by `npm run docs:gen` – tests/academy.test.ts makes sure the copies stay up to date.
 */

export type HandbookLang = 'de' | 'en';

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

/** The English names of the areas and tabs, as the English app shows them. */
const SECTIONS_EN: Record<string, string> = {
  agency: 'Agency',
  dashboard: 'Dashboard',
  boards: 'Boards',
  reports: 'Reports',
  project: 'Project',
  conversations: 'Conversations',
  calls: 'Calls',
  calendars: 'Calendar',
  contacts: 'Contacts',
  companies: 'Companies',
  objects: 'Objects',
  properties: 'Properties',
  opportunities: 'Opportunities',
  tasks: 'Tasks',
  campaigns: 'Campaigns',
  workflows: 'Automations',
  social: 'Social Planner',
  attribution: 'Attribution',
  'lead-scoring': 'Lead scoring',
  webinars: 'Webinars',
  funnels: 'Funnels & websites',
  forms: 'Forms & surveys',
  courses: 'Courses',
  community: 'Community',
  invoices: 'Invoices & quotes',
  contracts: 'Contracts',
  products: 'Products',
  affiliates: 'Affiliates',
  calc: 'Profit calculator',
  reviews: 'Reviews',
  accounting: 'Accounting',
  inventory: 'Inventory & purchasing',
  personal: 'People',
  tickets: 'Tickets',
  'help-center': 'Knowledge base',
  surveys: 'Surveys',
  apps: 'Apps',
  settings: 'Settings',
  academy: 'Academy',
};

const TABS_EN: Record<string, string> = {
  'agency/projects': 'Projects',
  'agency/contacts': 'Contacts',
  'agency/deals': 'Deals',
  'agency/tasks': 'Tasks',
  'agency/docs': 'Documents',
  'agency/clients': 'Clients',
  'agency/saas': 'SaaS',
  'agency/snapshots': 'Snapshots',
  'agency/domains': 'Domains',
  'agency/branding': 'White label',
  'agency/integrations': 'Integrations',
  'agency/api': 'API & MCP',
  'agency/audit': 'Log',
  'settings/company': 'Company',
  'settings/messaging': 'Email & SMS',
  'settings/channels': 'Channels',
  'settings/telephony': 'Telephony',
  'settings/billing': 'Invoices',
  'settings/stripe': 'Stripe',
  'settings/reviews': 'Reviews',
  'settings/chat': 'Live chat',
  'settings/ai': 'AI assistant',
  'settings/helpdesk': 'Service',
  'settings/fields': 'Fields & tags',
  'settings/consent': 'Consent & legal',
  'settings/api': 'API & webhooks',
  'settings/import': 'Import',
  'settings/team': 'Team',
  'settings/locations': 'Sub-accounts',
  'settings/account': 'My account',
  'social/calendar': 'Calendar',
  'social/stats': 'Statistics',
  'attribution/report': 'Report',
  'reports/templates': 'Templates',
  'reports/schedules': 'Schedules',
  'reports/new': 'Create report',
  'tickets/uebersicht': 'Overview',
  'tickets/auslastung': 'Workload',
  'surveys/csat': 'Satisfaction (CSAT)',
  'surveys/nps': 'Recommendation (NPS)',
  'properties/company': 'Companies',
  'affiliates/programs': 'Programmes',
  'community/settings': 'Settings',
  'accounting/receipts': 'Receipts',
  'accounting/entries': 'Entries',
  'accounting/bank': 'Bank',
  'accounting/reports': 'Reports',
  'accounting/export': 'Export & finalising',
  'accounting/settings': 'Settings',
  'inventory/movements': 'Movements',
  'inventory/orders': 'Orders',
  'inventory/counts': 'Stocktaking',
  'inventory/valuation': 'Valuation',
  'inventory/places': 'Locations',
  'inventory/settings': 'Settings',
  'personal/overview': 'Overview',
  'personal/employees': 'Staff',
  'personal/absences': 'Absences',
  'personal/time': 'Working time',
  'personal/checklists': 'Checklists',
  'personal/settings': 'Settings',
  'personal/me': 'My area',
  'academy/handbuch': 'Handbook',
  'apps/composio': 'Composio apps',
  'apps/events': 'App events',
  'apps/ai': 'AI & MCP',
  'apps/direct': 'Direct connections',
};

/** „Einstellungen → Telefonie“ (or „Settings → Telephony“) for `settings/telephony`. */
export function placeLabel(route: string, lang: HandbookLang = 'de'): string {
  const [sections, tabs] = lang === 'en' ? [SECTIONS_EN, TABS_EN] : [SECTIONS, TABS];
  const [a, b] = route.split('/');
  const first = sections[a] ?? a;
  const tab = b ? (tabs[`${a}/${b}`] ?? null) : null;
  return tab ? `${first} → ${tab}` : first;
}

/** The fixed wording around the tour texts. */
const WORDS = {
  de: {
    chapter: (n: number, title: string) => `Kapitel ${n}: ${title}`,
    minutes: (m: number, admin?: boolean) => `ca. ${m} Minuten${admin ? ', nur für die Agentur' : ''}`,
    howTo: "*So geht's:*",
    learned: '**Das hast du gelernt:**',
    more: 'Mehr dazu:',
    title: (brand: string) => `Handbuch: Die Firma mit ${brand} übernehmen`,
    intro: (brand: string, chapters: number, hours: number) =>
      `Dieses Handbuch ist die gedruckte Fassung des Gesamt-Guides **„Firma übernehmen“** aus der **Akademie** (Menüpunkt *Akademie* in ${brand}). Es führt eine Nachfolgerin oder einen Nachfolger in ${chapters} Kapiteln durch alles, was man braucht, um die Firma zu führen – vom sicheren Zugang über die Tagesroutine bis zum Betrieb des Servers. Zusammen dauert das etwa ${hours} Stunden; jedes Kapitel lässt sich einzeln machen und später fortsetzen.`,
    tip: '> Am besten machst du die Kapitel direkt in der App: Die Tour markiert dort jedes Feld und jeden Knopf, erklärt ihn und wartet, bis du ihn ausprobiert hast. Zum Üben legt die Akademie auf Wunsch eine **Übungs-Firma** mit erfundenen Kunden an – dort kann nichts kaputtgehen und nichts wird verschickt.',
    contents: '**Inhalt**',
    appendix: '## Anhang: Alle Modul-Touren',
    appendixIntro: 'Neben dem Gesamt-Guide gibt es für jeden Bereich eine kurze Tour (5–15 Schritte). Du findest sie in der Akademie oder über das **?** oben rechts auf jeder Seite.',
    tour: (steps: number, m: number, admin?: boolean) => `${steps} Schritte, ca. ${m} Min.${admin ? ', Agentur' : ''}`,
  },
  en: {
    chapter: (n: number, title: string) => `Chapter ${n}: ${title}`,
    minutes: (m: number, admin?: boolean) => `about ${m} minutes${admin ? ', agency only' : ''}`,
    howTo: '*How to:*',
    learned: '**What you have learnt:**',
    more: 'More:',
    title: (brand: string) => `Handbook: Taking over the company with ${brand}`,
    intro: (brand: string, chapters: number, hours: number) =>
      `This handbook is the printed version of the complete guide **“Taking over the company”** from the **Academy** (the *Academy* menu item in ${brand}). In ${chapters} chapters it takes a successor through everything needed to run the company – from secure access and the daily routine to running the server. Altogether it takes about ${hours} hours; each chapter can be done on its own and resumed later.`,
    tip: '> The best way is to do the chapters directly in the app: there the tour highlights every field and button, explains it and waits until you have tried it. For practice, the Academy can create a **practice company** with made-up customers – nothing can break there and nothing is sent.',
    contents: '**Contents**',
    appendix: '## Appendix: All module tours',
    appendixIntro: 'Besides the complete guide, every area has a short tour (5–15 steps). You will find them in the Academy or via the **?** at the top right of every page.',
    tour: (steps: number, m: number, admin?: boolean) => `${steps} steps, about ${m} min.${admin ? ', agency' : ''}`,
  },
} satisfies Record<HandbookLang, unknown>;

/** Where a chapter's „Mehr dazu“ link points in the English handbook when the English page has other headings. */
const DOCS_EN: Record<string, string> = {
  'README#funktionen': '../README.md#features',
  'README#als-agentur': '../README.md#features',
  'README#blog--kurse': 'courses.md',
  'README#community': 'community.md',
  'README#backup': 'backups.md',
  'self-hosting.de#google-bewertungen': 'self-hosting.md#google-reviews',
};

function docTarget(docs: NonNullable<Tour['docs']>, lang: HandbookLang): string {
  const anchor = docs.anchor ? `#${docs.anchor}` : '';
  if (lang === 'de') return `${docs.file === 'README' ? '../README.de.md' : `${docs.file}.md`}${anchor}`;
  const mapped = DOCS_EN[`${docs.file}${anchor}`];
  if (mapped) return mapped;
  // German pages (`growth.de`) have their English twin next to them (`growth.md`).
  return `${docs.file === 'README' ? '../README' : docs.file.replace(/\.de$/, '')}.md${anchor}`;
}

/** The German texts the handbook prints – what handbook.en.ts has to translate. */
export function handbookTexts(): string[] {
  const texts = new Set<string>();
  for (const t of JOURNEY) {
    for (const s of [t.title, t.summary, ...t.steps.flatMap((st) => [st.title, st.text, st.do ?? '']), ...t.learned, t.docs?.label ?? '']) if (s) texts.add(s);
  }
  for (const g of GROUPS) {
    const list = MODULE_TOURS.filter((t) => t.group === g.id);
    if (!list.length) continue;
    texts.add(g.label);
    for (const t of list) texts.add(t.title).add(t.summary);
  }
  return [...texts];
}

/** German texts without an English line in handbook.en.ts – they would be printed in German. */
export const missingTranslations = () => handbookTexts().filter((s) => !Object.prototype.hasOwnProperty.call(HANDBOOK_EN, s));
/** Lines of handbook.en.ts whose German text is no longer used. */
export const unusedTranslations = () => {
  const used = new Set(handbookTexts());
  return Object.keys(HANDBOOK_EN).filter((k) => !used.has(k));
};

function chapter(t: Tour, brand: string, lang: HandbookLang): string {
  const w = WORDS[lang];
  const tr = translator(lang);
  const plain = (s: string) => tr(s).replace(/\{brand\}/g, brand).replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  out.push(`## ${w.chapter(t.chapter!, tr(t.title))}`, '', `${plain(t.summary)} *(${w.minutes(t.minutes, t.admin)})*`, '');
  let place = '';
  t.steps.forEach((s, i) => {
    const here = s.route ? placeLabel(s.route, lang) : '';
    const where = here && here !== place ? ` *(${here})*` : '';
    if (here) place = here;
    const extra = s.do ? ` – ${w.howTo} ${plain(s.do)}` : '';
    out.push(`${i + 1}. **${plain(s.title)}**${where} – ${plain(s.text)}${extra}`);
  });
  out.push('', w.learned, '');
  for (const l of t.learned) out.push(`- ${plain(l)}`);
  if (t.docs) out.push('', `${w.more} [${tr(t.docs.label)}](${docTarget(t.docs, lang)})`);
  out.push('');
  return out.join('\n');
}

/** German stays as written; English comes from handbook.en.ts (a text without a line falls back to German). */
const translator = (lang: HandbookLang) => (s: string) => (lang === 'en' ? (HANDBOOK_EN[s] ?? s) : s);

export function handbookMarkdown(brand = 'HyperLevel', lang: HandbookLang = 'de'): string {
  const w = WORDS[lang];
  const tr = translator(lang);
  const plain = (s: string) => tr(s).replace(/\{brand\}/g, brand).replace(/\s+/g, ' ').trim();
  const minutes = JOURNEY.reduce((s, t) => s + t.minutes, 0);
  const out: string[] = [
    `# ${w.title(brand)}`,
    '',
    w.intro(brand, JOURNEY.length, Math.round(minutes / 60)),
    '',
    w.tip,
    '',
    w.contents,
    '',
    ...JOURNEY.map((t) => `${t.chapter}. [${tr(t.title)}](#${slug(w.chapter(t.chapter!, tr(t.title)))}) – ${plain(t.summary)}`),
    '',
    '---',
    '',
  ];
  for (const t of JOURNEY) out.push(chapter(t, brand, lang), '---', '');
  out.push(w.appendix, '', w.appendixIntro, '');
  for (const g of GROUPS) {
    const list = MODULE_TOURS.filter((t) => t.group === g.id);
    if (!list.length) continue;
    out.push(`### ${tr(g.label)}`, '');
    for (const t of list) out.push(`- **${plain(t.title)}** (${w.tour(t.steps.length, t.minutes, t.admin)}) – ${plain(t.summary)}`);
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** The handbook's files in docs/, written by `npm run docs:gen`. */
export const HANDBOOK_FILES: Record<HandbookLang, string> = { en: 'docs/handbook.md', de: 'docs/handbook.de.md' };

/** A file in docs/: the handbook with the language switcher on top (docs/self-hosting.md does the same by hand). */
export function handbookDoc(lang: HandbookLang, brand = 'HyperLevel'): string {
  const switcher = lang === 'en' ? '**English** · [Deutsch](handbook.de.md)' : '[English](handbook.md) · **Deutsch**';
  return `${switcher}\n\n${handbookMarkdown(brand, lang)}`;
}
