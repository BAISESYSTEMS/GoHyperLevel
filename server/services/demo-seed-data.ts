/**
 * The fictional companies of the demo (services/demo-seed.ts): the agency „Nordlicht Digital“ and five client sub-accounts
 * it looks after – a physiotherapy practice, an electrician, an online coach, a small SaaS start-up and a local shop with an
 * online store. Pure data. Names are invented; e-mail addresses use example.com/.org/.net or a `.example` domain, phone
 * numbers the test range +49 30 1234 xxx.
 *
 * Keep the contacts of all sub-accounts (plans plus the form senders) under 400: the background job that scores contacts
 * handles 200 per tick and tests/scheduler-sweep.test.ts gives the demo data two ticks.
 */

export type PlanKey = 'agency' | 'physio' | 'craft' | 'coach' | 'saas' | 'shop';

export interface LocPlan {
  key: PlanKey;
  name: string;
  email: string;
  address: string;
  website: string;
  project: Record<string, any>;
  /** Companies: name, industry, city (contacts get them through their „Firma“ field). */
  companies: [name: string, industry: string, city: string][];
  sources: string[];
  tags: [name: string, color: string][];
  contacts: number;
  /** Contact fields (custom fields) – each contact gets a value from `options` (or a number in `range`). */
  fields: { key: string; label: string; type: 'select' | 'number' | 'text' | 'date'; options?: string[]; range?: [number, number] }[];
  /** Custom values (placeholders like {{custom_values.oeffnungszeiten}}). */
  values: [name: string, value: string][];
  /** Pipeline name to fill (default: the first pipeline). */
  pipeline?: string;
  deals: [name: string, euros: number][];
  calendars: [name: string, minutes: number, description: string][];
  /** Appointments per weekday over the past and the next four weeks. */
  perDay: number;
  /** A weekly recurring appointment (title, RRULE weekday). */
  series: [title: string, day: 'MO' | 'TU' | 'WE' | 'TH' | 'FR'];
  form: string;
  funnel: string;
  posts: [title: string, intro: string][];
  products: [name: string, description: string, cents: number][];
  /** Review platforms besides the own review requests (imported, as for portals without an API). */
  platforms: string[];
  tickets: number;
  script?: string;
  pm?: { name: string; template?: string; tasks?: [title: string, startDay: number, days: number, milestone?: boolean][] };
  office?: [kind: 'docx' | 'xlsx', name: string][];
  webinar?: string;
  reports: string[];
  /** Load the built-in template „Software- & SaaS-Firma (HQ)“ first (services/hq-template.ts). */
  hq?: boolean;
  store?: boolean;
}

export const AGENCY_NAME = 'Nordlicht Digital';

export const FIRST = ['Lena', 'Jonas', 'Mia', 'Felix', 'Hannah', 'Lukas', 'Emma', 'Paul', 'Sophie', 'Leon', 'Marie', 'Finn', 'Clara', 'Elias', 'Lea', 'Noah', 'Anna', 'Ben', 'Laura', 'Tim', 'Julia', 'David', 'Nora', 'Moritz', 'Sarah', 'Jan', 'Ida', 'Max', 'Frieda', 'Oskar', 'Greta', 'Emil', 'Romy', 'Theo', 'Pia', 'Karl', 'Merle'];
export const LAST = ['Hoffmann', 'Becker', 'Schulte', 'Wagner', 'Krämer', 'Lindner', 'Vogel', 'Brandt', 'Seidel', 'Kühn', 'Albrecht', 'Hartmann', 'Busch', 'Franke', 'Roth', 'Winkler', 'Lorenz', 'Haas', 'Pohl', 'Engel', 'Sommer', 'Frank', 'Graf', 'Kraus', 'Jung', 'Böhm', 'Ludwig', 'Simon', 'Arnold', 'Ernst', 'Lang', 'Thiel', 'Marx', 'Kessler', 'Brück', 'Wolff', 'Ritter'];

/** A demo phone number in the test range: +49 30 1234 000 … 999. */
export const demoPhone = (n: number) => `+49 30 1234 ${String(n % 1000).padStart(3, '0')}`;

export const PLANS: LocPlan[] = [
  {
    key: 'agency',
    name: AGENCY_NAME,
    email: 'hallo@nordlicht-digital.example',
    address: 'Lindenallee 12, 10115 Berlin',
    website: 'https://nordlicht-digital.example',
    project: { status: 'live', category: 'Agentur', tagline: 'Websites, Kampagnen und CRM für kleine Unternehmen', description: 'Erfundene Agentur mit fünf Kunden-Sub-Accounts (White-Label). Alles darf ausprobiert werden – E-Mails und SMS werden nur gespeichert.' },
    companies: [
      ['Bäckerei Morgenrot', 'Lebensmittel', 'Berlin'],
      ['Holzwerk Brandt GmbH', 'Handwerk', 'Potsdam'],
      ['Kanzlei Seidel & Partner', 'Recht', 'Berlin'],
      ['Café Sonnendeck', 'Gastronomie', 'Berlin'],
      ['Atelier Vogel', 'Design', 'Leipzig'],
      ['Gartenbau Lindner', 'Garten- und Landschaftsbau', 'Cottbus'],
      ['Hotel Am Kanal', 'Hotellerie', 'Berlin'],
    ],
    sources: ['Website', 'Google', 'Empfehlung', 'LinkedIn', 'Formular: Kontaktformular', 'Messe', 'Live-Chat'],
    tags: [['Interessent', '#f59e0b'], ['Kunde', '#16a34a'], ['Newsletter', '#0ea5e9'], ['VIP', '#a855f7'], ['Website', '#2563eb'], ['SEO', '#14b8a6']],
    contacts: 52,
    fields: [
      { key: 'branche', label: 'Branche', type: 'select', options: ['Handwerk', 'Gastronomie', 'Gesundheit', 'Handel', 'Dienstleistung'] },
      { key: 'monatsbudget', label: 'Monatsbudget (€)', type: 'number', range: [300, 4000] },
    ],
    values: [['Telefon Hotline', '+49 30 1234 900'], ['Bürozeiten', 'Mo–Fr 9–17 Uhr'], ['Buchungslink', 'https://nordlicht-digital.example/erstgespraech']],
    deals: [
      ['Website-Relaunch Bäckerei Morgenrot', 6800],
      ['SEO-Paket 12 Monate', 4200],
      ['Onlineshop Holzwerk Brandt', 12500],
      ['Landingpage Frühjahrsaktion', 1900],
      ['Logo + Corporate Design', 3200],
      ['Google-Ads-Betreuung', 2400],
      ['Wartungsvertrag Kanzlei', 1068],
      ['Buchungssystem Hotel Am Kanal', 8900],
      ['Fotoshooting Team', 1500],
      ['Newsletter-Vorlagen', 950],
      ['Social-Media-Paket', 3600],
      ['Barrierefreiheits-Audit', 2200],
      ['Intranet Gartenbau Lindner', 7400],
      ['CRM-Einrichtung Atelier Vogel', 2900],
    ],
    calendars: [['Kostenloses Erstgespräch', 30, '30 Minuten per Video – wir sprechen über dein Projekt.']],
    perDay: 1,
    series: ['Wochen-Jour-fixe Hotel Am Kanal', 'MO'],
    form: 'Kontaktformular',
    funnel: 'Kostenloser Website-Check',
    posts: [
      ['Warum langsame Websites Kunden kosten', 'Jede Sekunde Ladezeit senkt die Conversion-Rate. So findest du heraus, wo es hakt …'],
      ['Checkliste: Relaunch ohne Ranking-Verlust', 'Weiterleitungen, Sitemap, Meta-Daten – die wichtigsten Punkte vor dem Go-live …'],
      ['Newsletter, die gelesen werden', 'Ein klarer Betreff, ein Thema, ein Ziel. Drei Regeln für bessere Öffnungsraten …'],
    ],
    products: [
      ['Website-Paket S', 'Bis zu 5 Seiten, responsive, inkl. Texte-Check', 249000],
      ['Wartung (monatlich)', 'Updates, Backups, kleine Änderungen', 8900],
      ['SEO-Audit', 'Technik, Inhalte und Wettbewerb', 69000],
    ],
    platforms: ['Google', 'Branchenportal'],
    tickets: 4,
    script: 'Erstgespräch Website',
    webinar: 'Mehr Anfragen über Google',
    pm: { name: 'Relaunch Bäckerei Morgenrot', template: 'website-projekt' },
    office: [['docx', 'Angebot Relaunch Bäckerei Morgenrot'], ['xlsx', 'Kampagnenbudget Q4']],
    reports: ['sales', 'marketing', 'revenue'],
  },
  {
    key: 'physio',
    name: 'Praxis Sonnenweg',
    email: 'team@praxis-sonnenweg.example',
    address: 'Sonnenweg 4, 80331 München',
    website: 'https://praxis-sonnenweg.example',
    project: { status: 'live', category: 'Gesundheit', tagline: 'Physiotherapie & Prävention', description: 'Erfundene Physiotherapie-Praxis: Online-Termine, Erinnerungen und Bewertungen.' },
    companies: [
      ['Firmenfitness Isar AG', 'Betriebliches Gesundheitsmanagement', 'München'],
      ['Sportverein Blau-Weiß', 'Sportverein', 'München'],
    ],
    sources: ['Google', 'Empfehlung', 'Website', 'Arzt-Überweisung', 'Instagram'],
    tags: [['Patient', '#16a34a'], ['Rücken', '#ef4444'], ['Knie', '#f97316'], ['Prävention', '#14b8a6'], ['Newsletter', '#0ea5e9']],
    contacts: 58,
    fields: [
      { key: 'krankenkasse', label: 'Krankenkasse', type: 'select', options: ['Gesetzlich', 'Privat', 'Selbstzahler'] },
      { key: 'behandlungen_offen', label: 'Offene Behandlungen', type: 'number', range: [0, 10] },
    ],
    values: [['Öffnungszeiten', 'Mo–Fr 7–20 Uhr, Sa 9–13 Uhr'], ['Absagefrist', '24 Stunden vor dem Termin'], ['Telefon Praxis', '+49 30 1234 910']],
    deals: [
      ['Firmenfitness Isar AG – 10 Kurse', 5400],
      ['Präventionskurs Rücken (Gruppe)', 1200],
      ['Sportverein Blau-Weiß – Betreuung', 2600],
      ['Massage-Gutscheine Weihnachten', 800],
      ['Rückenschule für Pflegekräfte', 1900],
      ['Laufanalyse-Paket Lauftreff', 650],
    ],
    calendars: [
      ['Physiotherapie (45 Min.)', 45, 'Behandlung nach Verordnung oder als Selbstzahler.'],
      ['Erstbefund (60 Min.)', 60, 'Ausführliche Untersuchung beim ersten Termin.'],
    ],
    perDay: 4,
    series: ['Rückenkurs (Gruppe)', 'WE'],
    form: 'Terminanfrage',
    funnel: 'Rückenkurs Anmeldung',
    posts: [
      ['5 Übungen gegen Rückenschmerzen im Büro', 'Langes Sitzen belastet die Wirbelsäule. Diese fünf Übungen dauern zusammen nur zehn Minuten …'],
      ['Was passiert beim Erstbefund?', 'Beim ersten Termin nehmen wir uns eine Stunde Zeit für Gespräch und Untersuchung …'],
    ],
    products: [
      ['Physiotherapie Selbstzahler (45 Min.)', 'Einzelbehandlung', 6500],
      ['Präventionskurs Rücken (8 Termine)', 'Von Krankenkassen bezuschusst', 16000],
      ['Massage (30 Min.)', 'Klassische Massage', 3900],
      ['Prävention Flatrate (Monat)', 'Kurse und Trainingsfläche ohne Zusatzkosten', 3900],
    ],
    platforms: ['Google', 'Arztportal', 'Facebook'],
    tickets: 3,
    webinar: 'Rückenschmerzen im Büro – was wirklich hilft',
    reports: ['revenue'],
  },
  {
    key: 'craft',
    name: 'Elektro Meyer',
    email: 'info@elektro-meyer.example',
    address: 'Werkstattweg 7, 30159 Hannover',
    website: 'https://elektro-meyer.example',
    project: { status: 'live', category: 'Handwerk', tagline: 'Elektroinstallation, Photovoltaik und Smart Home', description: 'Erfundener Elektro-Meisterbetrieb mit sechs Mitarbeitenden: Anfragen, Angebote, Baustellen und Rechnungen.' },
    companies: [
      ['Wohnbau Leinetal eG', 'Wohnungswirtschaft', 'Hannover'],
      ['Autohaus Riedel', 'Autohandel', 'Laatzen'],
      ['Kita Pusteblume', 'Kinderbetreuung', 'Hannover'],
      ['Stadtverwaltung Musterstadt', 'Öffentliche Verwaltung', 'Musterstadt'],
    ],
    sources: ['Google', 'Empfehlung', 'Website', 'Handwerkerportal', 'Fahrzeugwerbung'],
    tags: [['Neubau', '#2563eb'], ['Altbau', '#a16207'], ['Photovoltaik', '#eab308'], ['Wartung', '#64748b'], ['Gewerbe', '#7c3aed']],
    contacts: 48,
    fields: [
      { key: 'objektart', label: 'Objektart', type: 'select', options: ['Einfamilienhaus', 'Mehrfamilienhaus', 'Gewerbe', 'Wohnung'] },
      { key: 'baujahr', label: 'Baujahr', type: 'number', range: [1955, 2024] },
    ],
    values: [['Notdienst', '+49 30 1234 920 (24/7)'], ['Anfahrtspauschale', '39 € netto im Stadtgebiet'], ['Meisterbrief', 'Elektrotechnikermeister, eingetragen in der Handwerksrolle']],
    deals: [
      ['PV-Anlage 9,8 kWp Familie Hoffmann', 18900],
      ['Wallbox-Installation Autohaus Riedel', 4200],
      ['E-Check Kita Pusteblume', 890],
      ['Elektroinstallation Neubau Lindenstraße', 24600],
      ['Smart-Home-Nachrüstung Altbau', 6300],
      ['Zählerschrank-Erneuerung', 2800],
      ['Beleuchtung Werkstatt LED', 3500],
      ['Wartungsvertrag Wohnbau Leinetal', 7200],
      ['Sanierung Rathaus Musterstadt (Los 3)', 31800],
      ['Sprechanlage Mehrfamilienhaus', 2100],
    ],
    calendars: [['Vor-Ort-Termin', 60, 'Wir schauen uns die Anlage an und besprechen das Angebot.']],
    perDay: 2,
    series: ['Baustellenbesprechung Neubau Lindenstraße', 'TH'],
    form: 'Angebotsanfrage',
    funnel: 'Photovoltaik-Rechner',
    posts: [
      ['Lohnt sich eine Wallbox?', 'Kosten, Förderung und worauf du beim Anschluss achten solltest …'],
      ['E-Check: Pflicht für Vermieter?', 'Warum die regelmäßige Prüfung Ärger und Haftung erspart …'],
    ],
    products: [
      ['Stunde Elektromeister', 'Arbeitszeit inkl. Werkzeug', 7800],
      ['Wallbox 11 kW inkl. Montage', 'Montage, Anschluss und Anmeldung beim Netzbetreiber', 149000],
      ['E-Check Wohnung', 'Prüfung nach DGUV V3 mit Protokoll', 18900],
      ['Wartungsvertrag Elektroanlage (Monat)', 'Jährliche Prüfung und Notdienst mit Vorrang', 4900],
    ],
    platforms: ['Google', 'Handwerkerportal'],
    tickets: 2,
    script: 'Anfrage Photovoltaik',
    webinar: 'Photovoltaik für Hausbesitzer',
    pm: {
      name: 'Neubau Lindenstraße 14',
      tasks: [
        ['Baustelle einrichten', -12, 2],
        ['Leerrohre und Dosen setzen', -10, 5],
        ['Zählerschrank montieren', -4, 3],
        ['Rohinstallation abgeschlossen', -1, 1, true],
        ['Kabel einziehen', 1, 6],
        ['Feininstallation Schalter und Steckdosen', 9, 4],
        ['Messung und Prüfprotokoll', 14, 2],
        ['Übergabe an Bauherrn', 17, 1, true],
      ],
    },
    office: [['docx', 'Prüfprotokoll Vorlage'], ['xlsx', 'Materialliste Neubau Lindenstraße']],
    reports: ['sales', 'revenue'],
  },
  {
    key: 'coach',
    name: 'FitWerk Coaching',
    email: 'support@fitwerk.example',
    address: 'Hafenstraße 8, 20457 Hamburg',
    website: 'https://fitwerk.example',
    project: { status: 'live', category: 'Online-Kurse', tagline: 'Online-Fitnesscoaching mit Kursen und Community', description: 'Erfundenes Coaching-Business: Kurse, Mitgliederbereich, Community, Webinar und Partnerprogramm.' },
    companies: [['Hafenlogistik Nord GmbH', 'Logistik', 'Hamburg']],
    sources: ['Instagram', 'YouTube', 'Podcast', 'Empfehlung', 'Affiliate', 'Webinar'],
    tags: [['Mitglied', '#16a34a'], ['Interessent', '#f59e0b'], ['Newsletter', '#0ea5e9'], ['Challenge', '#ef4444'], ['VIP', '#a855f7']],
    contacts: 54,
    fields: [
      { key: 'ziel', label: 'Ziel', type: 'select', options: ['Abnehmen', 'Muskelaufbau', 'Fit bleiben', 'Rücken stärken'] },
      { key: 'trainingstage', label: 'Trainingstage pro Woche', type: 'number', range: [1, 6] },
    ],
    values: [['Community-Link', 'https://fitwerk.example/community'], ['Support-Zeiten', 'Mo–Fr 10–16 Uhr'], ['Rabattcode', 'HERBST20']],
    deals: [
      ['1:1-Coaching 3 Monate', 1490],
      ['Jahresmitgliedschaft', 590],
      ['Firmen-Challenge Hafenlogistik', 3900],
      ['Workshop „Gesund im Homeoffice“', 1200],
      ['Personal Training 10er-Karte', 750],
      ['Retreat-Wochenende Ostsee', 2400],
    ],
    calendars: [['Strategie-Call', 45, 'Wir finden heraus, welches Programm zu dir passt.']],
    perDay: 1,
    series: ['Live-Training (Gruppe)', 'TU'],
    form: 'Bewerbung 1:1-Coaching',
    funnel: '30-Tage-Challenge',
    posts: [['Training trotz vollem Kalender', 'Drei Workouts à 20 Minuten pro Woche reichen für den Anfang …']],
    products: [
      ['Online-Programm „Fit in 30 Tagen“', 'Videokurs mit Community-Zugang', 14900],
      ['1:1-Coaching (Monat)', 'Wöchentlicher Call und individueller Plan', 49000],
    ],
    platforms: ['Google', 'Facebook'],
    tickets: 2,
    webinar: 'Masterclass: Fit trotz Bürojob',
    reports: ['marketing'],
  },
  {
    key: 'saas',
    name: 'Taktwerk Software',
    email: 'hello@taktwerk.example',
    address: 'Speicherstraße 21, 04109 Leipzig',
    website: 'https://taktwerk.example',
    project: { status: 'beta', category: 'Software', tagline: 'Schichtplanung für kleine Teams – im Browser', description: 'Erfundenes SaaS-Start-up, geführt mit der Vorlage „Software- & SaaS-Firma (HQ)“: Warteliste, Testphasen, Support und Community.' },
    companies: [
      ['Pflegedienst Lichtblick', 'Pflege', 'Leipzig'],
      ['Burgerei Ostkreuz', 'Gastronomie', 'Berlin'],
      ['Kino am Markt', 'Kultur', 'Halle'],
      ['Sicherheitsdienst Wacht', 'Sicherheit', 'Dresden'],
    ],
    sources: ['Website', 'Product Hunt', 'Google', 'Empfehlung', 'Partner'],
    tags: [['Testphase', '#f59e0b'], ['Kunde', '#16a34a'], ['Warteliste', '#64748b'], ['Partner', '#7c3aed'], ['Newsletter', '#0ea5e9']],
    contacts: 64,
    fields: [
      { key: 'teamgroesse', label: 'Teamgröße', type: 'number', range: [3, 120] },
      { key: 'tarif', label: 'Tarif', type: 'select', options: ['Starter', 'Team', 'Business'] },
    ],
    values: [['Status-Seite', 'https://status.taktwerk.example'], ['Support-E-Mail', 'support@taktwerk.example'], ['Testphase (Tage)', '14']],
    pipeline: 'Kunden (Cloud)',
    deals: [
      ['Pflegedienst Lichtblick – Business', 4788],
      ['Burgerei Ostkreuz – Team', 1188],
      ['Kino am Markt – Team', 1188],
      ['Sicherheitsdienst Wacht – Business', 9576],
      ['Bäckereikette Kornfeld – Pilot', 2388],
      ['Klinikum Südpark – Anfrage', 14400],
      ['Fahrradkurier Flink – Starter', 588],
      ['Eventagentur Pulsschlag – Team', 1188],
      ['Hausmeisterservice Blank – Starter', 588],
      ['Zoo-Gastronomie – Business', 4788],
    ],
    calendars: [['Produkt-Demo', 30, 'Wir zeigen dir Taktwerk live und beantworten deine Fragen.']],
    perDay: 1,
    series: ['Sprint-Review', 'FR'],
    form: 'Demo anfragen',
    funnel: 'Warteliste Taktwerk 2.0',
    posts: [['Schichtplan in 10 Minuten', 'So baust du den ersten Wochenplan – mit Vorlagen und Tauschbörse …']],
    products: [
      ['Taktwerk Team (Monat)', 'Bis 25 Mitarbeitende', 9900],
      ['Taktwerk Business (Monat)', 'Unbegrenzt, mit Schnittstellen', 39900],
      ['Taktwerk Starter (Monat)', 'Bis 8 Mitarbeitende, ein Standort', 4900],
      ['Taktwerk Team (Jahr)', 'Bis 25 Mitarbeitende, 2 Monate geschenkt', 99000],
      ['Taktwerk Business (Jahr)', 'Unbegrenzt, mit Schnittstellen, 2 Monate geschenkt', 399000],
    ],
    platforms: ['Google', 'Software-Vergleichsportal'],
    tickets: 4,
    script: 'Demo-Call Qualifizierung',
    pm: { name: 'Onboarding Pflegedienst Lichtblick', template: 'kunden-onboarding' },
    webinar: 'Live-Demo: Schichtplanung ohne Excel',
    reports: ['sales'],
    hq: true,
  },
  {
    key: 'shop',
    name: 'Rösterei Hafenbohne',
    email: 'moin@hafenbohne.example',
    address: 'Am Fischmarkt 3, 24103 Kiel',
    website: 'https://hafenbohne.example',
    project: { status: 'live', category: 'Handel', tagline: 'Kaffeerösterei mit Laden und Online-Shop', description: 'Erfundene Kaffeerösterei: Laden, Online-Shop mit Bestellungen, Gutscheine, Kurse und Bewertungen.' },
    companies: [
      ['Café Kompass', 'Gastronomie', 'Kiel'],
      ['Bürogemeinschaft Förde', 'Büro', 'Kiel'],
    ],
    sources: ['Laden', 'Online-Shop', 'Instagram', 'Google', 'Markt'],
    tags: [['Stammkunde', '#16a34a'], ['Abo', '#2563eb'], ['Gastro', '#a16207'], ['Newsletter', '#0ea5e9'], ['Barista-Kurs', '#db2777']],
    contacts: 50,
    fields: [
      { key: 'lieblingsroestung', label: 'Lieblingsröstung', type: 'select', options: ['Espresso', 'Filter', 'Entkoffeiniert'] },
      { key: 'zubereitung', label: 'Zubereitung', type: 'select', options: ['Siebträger', 'Handfilter', 'Vollautomat', 'French Press'] },
    ],
    values: [['Öffnungszeiten Laden', 'Di–Sa 9–18 Uhr'], ['Versandkosten', '4,90 €, ab 40 € frei'], ['Rösttag', 'Jeden Donnerstag frisch geröstet']],
    deals: [
      ['Kaffee-Abo Bürogemeinschaft Förde', 1440],
      ['Belieferung Café Kompass', 6200],
      ['Firmengeschenke Weihnachten', 1850],
      ['Barista-Workshop Teamevent', 690],
    ],
    calendars: [['Barista-Kurs', 120, 'Zwei Stunden Siebträger-Praxis in der Rösterei.']],
    perDay: 1,
    series: ['Röstplanung', 'TH'],
    form: 'Newsletter-Anmeldung',
    funnel: 'Kaffee-Abo',
    posts: [['Filterkaffee wie im Café', 'Mahlgrad, Wassertemperatur, Ziehzeit – drei Stellschrauben für mehr Geschmack …']],
    products: [
      ['Hafenbohne Espresso (500 g)', 'Schokoladig, wenig Säure – für Siebträger', 1690],
      ['Fördeblick Filterkaffee (500 g)', 'Fruchtig mit Noten von Beeren', 1590],
      ['Entkoffeiniert Nachtwache (250 g)', 'Schonend entkoffeiniert', 990],
      ['Handfilter-Set Keramik', 'Filter, Kanne und 100 Filterpapiere', 3900],
    ],
    platforms: ['Google', 'Facebook'],
    tickets: 2,
    webinar: 'Online-Verkostung: Drei Röstungen im Vergleich',
    reports: ['revenue'],
    store: true,
  },
];
