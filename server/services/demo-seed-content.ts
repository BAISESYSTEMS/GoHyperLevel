import type { PlanKey } from './demo-seed-data.js';

/**
 * Content for the history and depth of the demo seed (services/demo-seed-history.ts): invented customers, deal kinds,
 * invoice volumes, courses and landing pages per business. Pure data – every name is fictional.
 */

/** Invented businesses for the many deals and customers of the history (no real companies). */
export const CUSTOMER_POOL = [
  'Bäckerei Kornfeld', 'Fahrschule Lindner', 'Zahnarztpraxis Dr. Brandt', 'Blumenhaus Frühling', 'Tischlerei Wiedemann', 'Steuerbüro Hartwig',
  'Pflegedienst Sonnenhof', 'Gasthaus Zur Linde', 'Fliesenleger Krause', 'Autowerkstatt Brückner', 'Yogastudio Lotos', 'Weingut Sonnenhang',
  'Kita Regenbogen', 'Malerbetrieb Fuchs', 'Reisebüro Fernweh', 'Tierarztpraxis Dr. Ahlers', 'Buchhandlung Seitenweise', 'Eiscafé Dolce Nord',
  'Sanitär Reinhardt', 'Hausverwaltung Lenz', 'Fotostudio Blende 8', 'Friseursalon Schnittpunkt', 'Optiker Klarblick', 'Schreinerei Vollmer',
  'Dachdecker Heller', 'Ingenieurbüro Maibaum', 'Kosmetikstudio Glanzzeit', 'Eventagentur Funkenflug', 'Bio-Hofladen Wiesengrund', 'Anwaltskanzlei Roth & Kern',
  'Taxi Nordstern', 'Metzgerei Haselbach', 'Kletterhalle Gipfelstürmer', 'Musikschule Taktgefühl', 'Gärtnerei Immergrün', 'Apotheke am Rosenplatz',
  'Elektrohandel Funke', 'Hotel Seeblick', 'Segelschule Windrose', 'Brauerei Hopfenglück', 'Immobilien Lindenhof', 'Druckerei Farbpunkt',
  'Physio Bewegungsraum', 'Tanzschule Schwung', 'Catering Löffelweise', 'Umzüge Kistenkönig', 'Reinigung Blitzblank', 'Schlüsseldienst Sicher & Fix',
];

/** Deal kinds per business: title, lowest and highest value in euros. */
export const DEAL_KINDS: Record<PlanKey, [kind: string, min: number, max: number][]> = {
  agency: [['Website-Relaunch', 4800, 9800], ['SEO-Paket', 2400, 4800], ['Onlineshop', 8900, 16500], ['Landingpage', 1200, 2400], ['Logo + Corporate Design', 2200, 4200], ['Google-Ads-Betreuung', 1800, 3600], ['Wartungsvertrag', 890, 1600], ['Social-Media-Paket', 2600, 4400], ['Newsletter-Setup', 700, 1400], ['CRM-Einrichtung', 2400, 5200]],
  physio: [['Firmenfitness', 3200, 7400], ['Präventionskurs', 900, 1800], ['Vereinsbetreuung', 1800, 3200], ['Massage-Gutscheine', 400, 1100], ['Rückenschule', 1400, 2600], ['Laufanalyse', 450, 900], ['Betriebliche Gesundheitstage', 2400, 4600]],
  craft: [['PV-Anlage', 14500, 24800], ['Wallbox-Installation', 2400, 5200], ['E-Check', 450, 1400], ['Elektroinstallation Neubau', 16000, 38000], ['Smart-Home-Nachrüstung', 3800, 8200], ['Zählerschrank-Erneuerung', 1800, 3600], ['LED-Beleuchtung', 2200, 5800], ['Wartungsvertrag', 2400, 8800], ['Sprechanlage', 1400, 3200]],
  coach: [['1:1-Coaching 3 Monate', 1290, 1690], ['Jahresmitgliedschaft', 490, 690], ['Firmen-Challenge', 2400, 5200], ['Workshop Gesund im Homeoffice', 900, 1800], ['Personal Training 10er-Karte', 650, 950], ['Retreat-Wochenende', 1900, 2900]],
  saas: [['Business', 3800, 5800], ['Team', 1100, 1300], ['Starter', 500, 700]],
  shop: [['Kaffee-Abo', 900, 2200], ['Belieferung', 3200, 8400], ['Firmengeschenke', 1100, 2600], ['Barista-Workshop', 450, 900], ['Röstkurs Teamevent', 600, 1400]],
};

/** Deals created in the oldest month (the number grows 8 % per month). */
export const DEAL_RATE: Record<PlanKey, number> = { agency: 4, physio: 3, craft: 4, coach: 4, saas: 0, shop: 3 };

/** Invoices in the oldest month (growing 7.5 % per month), the quantity range and – instead of the products – own line items in cents. */
export const REVENUE: Record<PlanKey, { perMonth: number; qtyMax: number; custom?: [name: string, cents: number][] }> = {
  agency: { perMonth: 2, qtyMax: 1, custom: [['Website-Relaunch', 680000], ['Website-Paket S', 249000], ['SEO-Audit', 69000], ['Logo + Corporate Design', 320000], ['Google-Ads-Einrichtung', 89000], ['Social-Media-Paket (Quartal)', 180000], ['Wartung & Hosting (Jahr)', 106800], ['Newsletter-Vorlagen', 95000]] },
  physio: { perMonth: 4, qtyMax: 6 },
  craft: { perMonth: 2, qtyMax: 2, custom: [['PV-Anlage 9,8 kWp', 1890000], ['Elektroinstallation Neubau (Abschlag)', 2460000], ['Smart-Home-Nachrüstung', 630000], ['Wallbox 11 kW inkl. Montage', 149000], ['Zählerschrank-Erneuerung', 280000], ['E-Check Mehrfamilienhaus', 189000], ['Wartung Elektroanlage', 72000]] },
  coach: { perMonth: 3, qtyMax: 3, custom: [['Firmen-Challenge Hafenlogistik', 390000], ['Retreat-Wochenende Ostsee', 240000], ['Workshop Gesund im Homeoffice', 120000]] },
  saas: { perMonth: 1, qtyMax: 1, custom: [['Onboarding & Datenübernahme', 29000], ['Schulung Schichtplanung (2 Std.)', 34000], ['Individuelle Schnittstelle', 120000]] },
  shop: { perMonth: 4, qtyMax: 10, custom: [['Belieferung Café Kompass', 186000], ['Kaffee-Abo Bürogemeinschaft Förde (Quartal)', 43200], ['Firmengeschenke Weihnachten', 92500]] },
};

/** Subscriptions besides the SaaS book: product name, how many customers, quantity. */
export const SUBSCRIPTIONS: Partial<Record<PlanKey, { product: string; n: number; qty?: number }>> = {
  agency: { product: 'Wartung (monatlich)', n: 12 },
  physio: { product: 'Prävention Flatrate (Monat)', n: 9 },
  craft: { product: 'Wartungsvertrag Elektroanlage (Monat)', n: 8 },
  coach: { product: '1:1-Coaching (Monat)', n: 8 },
  shop: { product: 'Hafenbohne Espresso (500 g)', n: 9, qty: 4 },
};

/** A course: modules with lessons [title, text, minutes], a quiz on the first lesson of the second module, enrolments and reviews. */
export interface CoursePlan {
  title: string;
  description: string;
  modules: [title: string, lessons: [title: string, text: string, minutes: number][]][];
  quiz?: { title: string; questions: { text: string; options: [string, boolean][] }[] };
  enroll: number;
  reviews?: [rating: number, title: string, text: string][];
}
const L = (title: string, text: string, minutes = 8): [string, string, number] => [title, text, minutes];
const GOOD: [number, string, string][] = [
  [5, 'Sehr klar aufgebaut', 'Kurze Lektionen, die man wirklich im Alltag umsetzen kann.'],
  [5, 'Genau das, was ich gebraucht habe', 'Endlich ein Kurs ohne Fachchinesisch – danke!'],
  [4, 'Gut und praxisnah', 'Ein, zwei Beispiele mehr wären schön, sonst top.'],
  [5, 'Klare Empfehlung', 'Habe schon nach der ersten Woche Ergebnisse gesehen.'],
];

export const COURSE_PLANS: Record<PlanKey, CoursePlan[]> = {
  agency: [
    {
      title: 'Online-Marketing für lokale Betriebe',
      description: 'Die Kunden-Academy von Nordlicht Digital: sichtbar werden, Anfragen gewinnen, Bewertungen sammeln – in kurzen Lektionen.',
      modules: [
        ['Sichtbar werden', [L('Das Google-Unternehmensprofil einrichten', 'Name, Kategorie, Öffnungszeiten und Fotos: So füllst du das Profil vollständig aus – und warum Aktualität mehr zählt als Perfektion.'), L('Lokale Suchbegriffe finden', 'Mit drei einfachen Fragen findest du heraus, wonach deine Kunden in deiner Stadt wirklich suchen.'), L('Die Website in fünf Minuten prüfen', 'Ladezeit, Handy-Ansicht, klarer Kontaktweg: Die Checkliste für den Schnelltest.', 12)]],
        ['Anfragen gewinnen', [L('Ein Kontaktformular, das ausgefüllt wird', 'Weniger Felder, klarer Nutzen, schnelle Antwort: Drei Stellschrauben für mehr Anfragen.'), L('Newsletter mit Plan', 'Wie oft, worüber und mit welchem Betreff – ein Jahresplan zum Abschreiben.'), L('Bewertungen systematisch sammeln', 'Der beste Zeitpunkt, die richtige Frage und eine Vorlage für die Nachricht.', 10)]],
      ],
      quiz: { title: 'Wissens-Check: Anfragen gewinnen', questions: [{ text: 'Was gehört in ein vollständiges Google-Unternehmensprofil?', options: [['Öffnungszeiten, Kategorie und Fotos', true], ['Nur der Firmenname', false], ['Ein Foto vom Logo reicht', false]] }, { text: 'Warum sind aktuelle Öffnungszeiten wichtig?', options: [['Kunden verlassen sich darauf – falsche Angaben kosten Vertrauen', true], ['Sie haben keinen Einfluss', false]] }] },
      enroll: 22,
      reviews: GOOD,
    },
  ],
  physio: [
    {
      title: 'Rückenfit im Alltag',
      description: 'Zehn Minuten am Tag: Übungen und Tipps aus der Praxis für Büro, Haushalt und Freizeit.',
      modules: [
        ['Grundlagen', [L('Wie der Rücken funktioniert', 'Wirbelsäule, Bandscheiben und Muskeln – kurz erklärt, damit du verstehst, warum Bewegung hilft.', 6), L('Richtig sitzen – und öfter aufstehen', 'Die beste Sitzhaltung ist die nächste. Mit drei Mini-Pausen pro Stunde entlastest du den Rücken.', 7), L('Aufwärmen in zwei Minuten', 'Schultern, Becken, Brustwirbelsäule: Die kleine Routine für den Morgen.', 5)]],
        ['Kräftigen', [L('Die Plank-Variationen', 'Von der Einsteiger- bis zur Fortgeschrittenen-Version – mit typischen Fehlern.', 9), L('Mobilisation der Brustwirbelsäule', 'Sanfte Drehungen, die Verspannungen im oberen Rücken lösen.', 8), L('Dein 4-Wochen-Plan', 'Wann du was trainierst und woran du Fortschritte erkennst.', 6)]],
      ],
      quiz: { title: 'Quiz: Rückengesund arbeiten', questions: [{ text: 'Wie oft solltest du im Büro kurz aufstehen?', options: [['Mehrmals pro Stunde', true], ['Einmal pro Tag', false]] }] },
      enroll: 26,
      reviews: GOOD,
    },
  ],
  craft: [
    {
      title: 'Photovoltaik verstehen',
      description: 'Der Kurs für Bauherren und Vermieter: Wie eine PV-Anlage funktioniert, was sie kostet und welche Förderung es gibt.',
      modules: [
        ['Grundlagen', [L('So funktioniert eine PV-Anlage', 'Module, Wechselrichter, Zähler: Der Weg vom Sonnenlicht zur Steckdose.', 9), L('Wie groß darf die Anlage sein?', 'Dachfläche, Ausrichtung und Verbrauch bestimmen die passende Größe.', 8), L('Speicher: ja oder nein?', 'Wann sich ein Batteriespeicher lohnt und wann nicht.', 10)]],
        ['Planung & Betrieb', [L('Von der Anfrage bis zur Inbetriebnahme', 'Ablauf, Fristen und Anmeldung beim Netzbetreiber im Überblick.', 9), L('Wartung und Monitoring', 'Was du selbst prüfen kannst und wann der Fachbetrieb kommt.', 7), L('Förderung und Steuer', 'Kurzer Überblick – bitte immer mit dem Steuerberater abstimmen.', 8)]],
      ],
      quiz: { title: 'Quiz: Photovoltaik-Basics', questions: [{ text: 'Was wandelt den Gleichstrom der Module in Wechselstrom um?', options: [['Der Wechselrichter', true], ['Der Zähler', false], ['Der Speicher', false]] }] },
      enroll: 18,
      reviews: GOOD,
    },
  ],
  coach: [
    {
      title: 'Fit in 30 Tagen',
      description: 'Vier Wochen, zwölf Videos, ein Plan – für Einsteiger.',
      modules: [
        ['Woche 1: Grundlagen', [L('Willkommen & dein Plan', 'So nutzt du den Kurs: Wochenplan, Trainingstage und dein Startfoto.', 6), L('Richtig aufwärmen', 'Fünf Minuten, die Verletzungen vorbeugen.', 7), L('Ganzkörper-Basics (15 Min.)', 'Kniebeuge, Liegestütz, Rudern: die Grundübungen mit Technik-Tipps.', 15)]],
        ['Woche 2: Kraft aufbauen', [L('Ganzkörper-Workout (20 Min.)', 'Dein erstes volles Workout – mit Varianten für Einsteiger und Fortgeschrittene.', 20), L('Mobilität am Morgen', 'Sanfte Bewegung für einen geschmeidigen Start in den Tag.', 10), L('Ernährung: einfache Wochenplanung', 'Eine Einkaufsliste, drei Basisrezepte und ein Wochenplan zum Abhaken.', 12)]],
        ['Woche 3: Ausdauer', [L('Intervalle für Einsteiger', 'Kurze, harte Phasen und lockere Pausen – so steigerst du die Ausdauer.', 14), L('Schlaf und Erholung', 'Warum Fortschritt in der Pause passiert.', 8), L('Motivation halten', 'Kleine Rituale gegen den inneren Schweinehund.', 7)]],
        ['Woche 4: Dranbleiben', [L('Dein Abschluss-Test', 'Wiederhole die Basics aus Woche 1 und vergleiche mit deinem Startwert.', 18), L('Wie es weitergeht', 'Dein Plan für die nächsten 90 Tage.', 6)]],
      ],
      quiz: { title: 'Quiz: Training und Aufwärmen', questions: [{ text: 'Warum wärmst du dich vor dem Training auf?', options: [['Um Verletzungen vorzubeugen', true], ['Weil es Pflicht ist', false]] }, { text: 'Wie lange sollte eine Aufwärm-Routine mindestens dauern?', options: [['Etwa fünf Minuten', true], ['Eine Stunde', false]] }] },
      enroll: 34,
      reviews: GOOD,
    },
    {
      title: 'Ernährung einfach gemacht',
      description: 'Ohne Verbote und Kalorienzählen: Essgewohnheiten Schritt für Schritt verbessern.',
      modules: [
        ['Basics', [L('Was dein Körper wirklich braucht', 'Eiweiß, Kohlenhydrate, Fette – verständlich und ohne Dogma.', 9), L('Der Teller als Faustregel', 'So viel von allem – ohne Waage.', 6)]],
        ['Alltag', [L('Meal-Prep für Berufstätige', 'Zwei Stunden am Sonntag, fünf entspannte Tage.', 14), L('Snacks und Heißhunger', 'Was hilft, wenn der Magen knurrt.', 8), L('Auswärts essen', 'Kantine, Restaurant, Dienstreise: Tipps für unterwegs.', 7)]],
        ['Dranbleiben', [L('Rückschläge einplanen', 'Ein Ausrutscher ist kein Scheitern – so gehst du damit um.', 7)]],
      ],
      enroll: 21,
      reviews: GOOD,
    },
    {
      title: 'Mobility & Rücken',
      description: 'Beweglich und schmerzfrei: tägliche Routinen für Hüfte, Schultern und Wirbelsäule.',
      modules: [
        ['Beweglichkeit', [L('Hüfte öffnen', 'Fünf Übungen gegen steife Hüften.', 10), L('Schultern und Nacken', 'Gegen Verspannungen am Bildschirm.', 9)]],
        ['Stabilität', [L('Rumpfkraft ohne Geräte', 'Eine 12-Minuten-Routine für den Core.', 12), L('Dein Wochenplan', 'Drei kurze Einheiten pro Woche genügen.', 6)]],
      ],
      enroll: 16,
      reviews: GOOD,
    },
  ],
  saas: [
    {
      title: 'Taktwerk-Akademie: Schichtplanung meistern',
      description: 'Der Onboarding-Kurs für neue Kunden: vom ersten Plan bis zur Tauschbörse und zum Export für die Lohnabrechnung.',
      modules: [
        ['Erste Schritte', [L('Team und Standorte anlegen', 'Mitarbeitende importieren, Rollen vergeben und Standorte einrichten.', 7), L('Schichtvorlagen bauen', 'Früh-, Spät- und Nachtschicht als Vorlage – einmal anlegen, immer wieder nutzen.', 9), L('Der erste Wochenplan', 'Vom leeren Plan zur Veröffentlichung in zehn Minuten.', 10)]],
        ['Für Fortgeschrittene', [L('Tauschbörse und Urlaubsanträge', 'Wie dein Team Schichten selbst tauscht – mit Freigabe durch die Leitung.', 8), L('Regeln und Ruhezeiten', 'Mindestruhezeit, Höchstarbeitszeit und Warnungen im Plan.', 9), L('Auswertungen und Export', 'Stunden pro Person, Zuschläge und der Export für die Lohnabrechnung.', 8)]],
        ['Schnittstellen', [L('Kalender-Abo und Erinnerungen', 'Schichten im Handy-Kalender und Erinnerungen per E-Mail.', 6), L('Sicher arbeiten: Rechte und Datenschutz', 'Wer sieht was – und wie du Zugriffe nachvollziehst.', 8)]],
      ],
      quiz: { title: 'Quiz: Dein erster Schichtplan', questions: [{ text: 'Wofür nutzt du Schichtvorlagen?', options: [['Wiederkehrende Schichten schnell einzutragen', true], ['Um Mitarbeitende zu löschen', false]] }, { text: 'Wer gibt einen Schichttausch aus der Tauschbörse frei?', options: [['Die Leitung', true], ['Niemand', false]] }] },
      enroll: 30,
      reviews: GOOD,
    },
  ],
  shop: [
    {
      title: 'Kaffee-Wissen: Von der Bohne zur Tasse',
      description: 'Röstung, Mahlgrad, Zubereitung: der Barista-Kurs für zu Hause.',
      modules: [
        ['Die Bohne', [L('Sorten und Anbau', 'Arabica und Robusta, Höhenlagen und was das mit dem Geschmack zu tun hat.', 9), L('Wie Röstung schmeckt', 'Hell, mittel, dunkel – eine Verkostung zum Mitmachen.', 10), L('Frisch halten und lagern', 'Licht, Luft und Wärme sind die Feinde – so lagerst du richtig.', 6)]],
        ['Zubereitung', [L('Mahlgrad verstehen', 'Warum der Mahlgrad die wichtigste Stellschraube ist.', 8), L('Handfilter wie im Café', 'Wassertemperatur, Ziehzeit und Gießtechnik Schritt für Schritt.', 12), L('Espresso aus der Siebträgermaschine', 'Dosierung, Tampen und Extraktion.', 14)]],
      ],
      quiz: { title: 'Quiz: Kaffee-Basics', questions: [{ text: 'Was beeinflusst den Geschmack am stärksten?', options: [['Der Mahlgrad', true], ['Die Farbe der Tasse', false]] }] },
      enroll: 24,
      reviews: GOOD,
    },
  ],
};

/** Landing pages and funnels besides the website: what is on them and how much traffic they get. */
export interface SitePlan {
  name: string;
  template: 'leadmagnet' | 'booking' | 'blank';
  pages?: { name: string; slug: string; blocks: Record<string, any>[] }[];
  /** Visitors per day at the start of the 60 days (it grows to about 1.6×). */
  traffic: number;
  /** Share of the visitors that continue to the next page. */
  flow: number[];
  conversion: 'form' | 'booking' | 'purchase';
}
const hero = (heading: string, subheading: string, extra: Record<string, any> = {}) => ({ type: 'hero', heading, subheading, align: 'center', ...extra });
const webinar = (title: string, sub: string, thanks: string, replay: string): NonNullable<SitePlan['pages']> => [
  { name: 'Anmeldung', slug: 'anmeldung', blocks: [hero(title, sub, { button_text: 'Platz sichern', button_url: '#anmeldung' }), { type: 'form', form_id: '', heading: 'Jetzt anmelden' }] },
  { name: 'Danke', slug: 'danke', blocks: [hero('Du bist dabei! 🎉', thanks)] },
  { name: 'Replay', slug: 'replay', blocks: [hero('Das Replay', replay)] },
];
export const SITE_PLANS: Record<PlanKey, SitePlan[]> = {
  agency: [
    { name: 'Buchungsseite Erstgespräch', template: 'booking', traffic: 9, flow: [1], conversion: 'booking' },
    { name: 'Landingpage SEO-Check', template: 'leadmagnet', traffic: 14, flow: [0.34, 1], conversion: 'form' },
    { name: 'Webinar: Mehr Anfragen über Google', template: 'blank', traffic: 11, flow: [0.42, 0.7, 0.5], conversion: 'form', pages: webinar('Mehr Anfragen über Google', 'Live-Webinar: In 45 Minuten zum besseren Google-Profil.', 'Den Link zum Webinar bekommst du per E-Mail.', 'Aufzeichnung und Folien zum Download.') },
  ],
  physio: [
    { name: 'Online-Terminbuchung', template: 'booking', traffic: 18, flow: [1], conversion: 'booking' },
    { name: 'Landingpage Präventionskurs', template: 'leadmagnet', traffic: 12, flow: [0.3, 1], conversion: 'form' },
    { name: 'Webinar: Rückenschmerzen im Büro', template: 'blank', traffic: 8, flow: [0.4, 0.65, 0.45], conversion: 'form', pages: webinar('Rückenschmerzen im Büro?', 'Kostenloses Live-Webinar mit unseren Physiotherapeuten.', 'Wir schicken dir den Zugangslink per E-Mail.', 'Replay und Übungsblatt zum Nachmachen.') },
  ],
  craft: [
    { name: 'Terminbuchung Vor-Ort-Beratung', template: 'booking', traffic: 8, flow: [1], conversion: 'booking' },
    { name: 'Landingpage Wallbox-Aktion', template: 'leadmagnet', traffic: 12, flow: [0.28, 1], conversion: 'form' },
    { name: 'Webinar: Photovoltaik für Hausbesitzer', template: 'blank', traffic: 7, flow: [0.38, 0.6, 0.4], conversion: 'form', pages: webinar('Photovoltaik für Hausbesitzer', 'Kosten, Förderung, Ablauf – live erklärt vom Elektromeister.', 'Der Link kommt per E-Mail.', 'Aufzeichnung und Checkliste zum Download.') },
  ],
  coach: [
    { name: 'Bewerbungsseite 1:1-Coaching', template: 'booking', traffic: 16, flow: [1], conversion: 'booking' },
    { name: 'Landingpage Gratis-Trainingsplan', template: 'leadmagnet', traffic: 26, flow: [0.36, 1], conversion: 'form' },
    { name: 'Webinar-Funnel: Masterclass', template: 'blank', traffic: 20, flow: [0.45, 0.72, 0.5], conversion: 'purchase', pages: webinar('Masterclass: Fit trotz Bürojob', 'Live-Webinar mit Fragerunde und Bonus für alle Teilnehmer.', 'Alle Infos stehen in deinem Postfach.', 'Replay und Sonderangebot: „Fit in 30 Tagen“ nur 48 Stunden mit Rabatt.') },
  ],
  saas: [
    { name: 'Landingpage Testphase', template: 'leadmagnet', traffic: 38, flow: [0.34, 1], conversion: 'form' },
    { name: 'Buchungsseite Produkt-Demo', template: 'booking', traffic: 14, flow: [1], conversion: 'booking' },
    { name: 'Webinar: Schichtplanung ohne Excel', template: 'blank', traffic: 22, flow: [0.44, 0.7, 0.48], conversion: 'form', pages: webinar('Schichtplanung ohne Excel', 'Live-Demo mit Fragerunde: So planst du dein Team in zehn Minuten.', 'Wir sehen uns im Webinar – der Link ist unterwegs.', 'Aufzeichnung, Folien und Testphasen-Gutschein.') },
  ],
  shop: [
    { name: 'Landingpage Kaffee-Probierpaket', template: 'leadmagnet', traffic: 16, flow: [0.32, 1], conversion: 'purchase' },
    { name: 'Buchung Barista-Kurs', template: 'booking', traffic: 8, flow: [1], conversion: 'booking' },
    { name: 'Online-Verkostung', template: 'blank', traffic: 9, flow: [0.4, 0.66, 0.45], conversion: 'form', pages: webinar('Online-Verkostung', 'Drei Röstungen, ein Abend – das Probierset kommt vorab per Post.', 'Dein Probierset ist auf dem Weg.', 'Die Verkostung zum Nachschauen.') },
  ],
};
