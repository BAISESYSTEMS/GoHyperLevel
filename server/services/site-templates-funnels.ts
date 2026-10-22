import {
  benefits,
  btn,
  calendarBlock,
  card,
  col,
  collectionBlock,
  contact,
  ctaBand,
  faq,
  formBlock,
  h,
  heroCenter,
  heroSplit,
  legalPages,
  p,
  productBlock,
  row,
  section,
  stats,
  steps,
  testimonials,
  twoCols,
  type SiteTemplate,
  type TemplatePage,
} from './site-templates-kit.js';

/**
 * Template gallery, part 2: funnels and campaign pages – lead magnet, webinar, course sales page, event, link in bio, newsletter,
 * podcast, product launch, video sales letter, application and call booking. Funnels have no navigation (nothing leads away from the
 * goal), only the legal links in the footer. After the form the visitor goes to the "Danke" page (set when the template is applied).
 */

const thanks = (title: string, text: string, extra: ReturnType<typeof p>[] = []): TemplatePage => ({
  name: 'Danke',
  slug: 'danke',
  seo: { title: `${title} – {{firma}}`, noindex: true },
  blocks: [heroCenter({ title, lead: text, pad: 96, bg: 'token:surface' }), ...(extra.length ? [section(row([col(12, extra)]), { width: 'narrow', pad_y: 32 })] : [])],
});
const footer = { text: '© {{firma}}' };

export const FUNNEL_TEMPLATES: SiteTemplate[] = [
  // ------------------------------------------------------------------------------------------------------------ Lead-Magnet
  {
    id: 'leadmagnet',
    name: 'Lead-Magnet (Checkliste / E-Book)',
    category: 'Lead-Funnel',
    kind: 'funnel',
    description: 'Opt-in-Seite mit Nutzenversprechen und Formular – danach die Danke-Seite. Für PDF, Checkliste, Vorlage oder Mini-Kurs.',
    tags: ['Opt-in', 'Checkliste', 'E-Mail-Liste'],
    tokens: { colors: { brand: '#2563eb', accent: '#f59e0b', surface: '#eff6ff' }, fonts: { heading: 'modern', body: 'modern' }, radius: { sm: 8, md: 14, lg: 24 } },
    footer,
    needs: ['form'],
    form: 'optin',
    thanks: 'danke',
    legal: ['impressum', 'datenschutz'],
    pages: [
      {
        name: 'Opt-in',
        slug: 'start',
        seo: { title: 'Gratis: Die Checkliste für {{firma}}', description: 'Trag dich ein und erhalte die Checkliste sofort per E-Mail.' },
        blocks: [
          heroSplit({ eyebrow: 'Kostenlos zum Download', title: 'Die 10-Punkte-Checkliste für deinen Start', lead: 'Alles auf einer Seite: was du wirklich brauchst, in welcher Reihenfolge und welche Fehler du dir sparen kannst.', aside: [formBlock('Jetzt kostenlos sichern', {})], bg: 'token:surface', note: 'Kein Spam. Du kannst dich jederzeit abmelden.' }),
          benefits('Das nimmst du mit', [['✅', 'Klarer Fahrplan', 'Zehn Schritte, die aufeinander aufbauen.'], ['⏱️', 'Zeit gespart', 'Du musst nicht mehr suchen, was zuerst dran ist.'], ['🎯', 'Typische Fehler', 'Ich zeige dir, worüber die meisten stolpern.']]),
          testimonials('Das sagen andere', [['Endlich ein Fahrplan, der nicht überfordert.', 'Sabine K.'], ['Kurz, konkret, sofort umsetzbar.', 'Markus T.']], { bg: 'token:surface' }),
        ],
      },
      thanks('Danke – schau in dein Postfach!', 'Die Checkliste ist unterwegs. Falls nach ein paar Minuten nichts da ist, wirf einen Blick in den Spam-Ordner.', [p('**Tipp:** Füge unsere Absenderadresse deinen Kontakten hinzu, damit du nichts verpasst.', { align: 'center' })]),
      ...legalPages(),
    ],
  },

  // --------------------------------------------------------------------------------------------------------------- Webinar
  {
    id: 'webinar',
    name: 'Webinar-Funnel',
    category: 'Events & Webinare',
    kind: 'funnel',
    description: 'Anmeldung mit Countdown, Bestätigungsseite und Replay mit Angebot – für Live- und Evergreen-Webinare.',
    tags: ['Webinar', 'Anmeldung', 'Countdown', 'Replay'],
    tokens: { colors: { brand: '#6d28d9', accent: '#f59e0b', surface: '#f5f3ff' }, fonts: { heading: 'geometric', body: 'modern' }, radius: { sm: 8, md: 14, lg: 24 } },
    footer,
    needs: ['form', 'product'],
    form: 'registration',
    thanks: 'bestaetigung',
    legal: ['impressum', 'datenschutz', 'widerruf'],
    pages: [
      {
        name: 'Anmeldung',
        slug: 'anmeldung',
        seo: { title: 'Kostenloses Live-Webinar – {{firma}}', description: 'In 60 Minuten zeigen wir dir Schritt für Schritt, wie es geht. Jetzt kostenlos anmelden.' },
        blocks: [
          heroSplit({ eyebrow: 'Live-Webinar · kostenlos', title: 'In 60 Minuten zu deinem ersten Ergebnis', lead: 'Wir zeigen dir live, wie du in drei Schritten loslegst – mit Fragerunde am Ende. Du bekommst die Aufzeichnung per E-Mail.', aside: [card([{ type: 'countdown', until: '{{in7days}}', align: 'center', padding: 0 }, p('**Nächster Termin:** in 7 Tagen, 19:00 Uhr', { align: 'center' }), formBlock('Platz sichern', {})], { bg: 'token:bg', shadow: 'lg' })], bg: 'token:surface' }),
          benefits('Das lernst du im Webinar', [['1️⃣', 'Das Fundament', 'Worauf es wirklich ankommt – und was du weglassen kannst.'], ['2️⃣', 'Der Plan', 'Eine Schritt-für-Schritt-Anleitung, die du direkt umsetzt.'], ['3️⃣', 'Die Fehler', 'Typische Stolpersteine und wie du sie umgehst.']]),
          section(row([col(12, [h('Dein Gastgeber', 2), p('Ich begleite seit Jahren Menschen dabei, genau das umzusetzen. Im Webinar teile ich meine besten Methoden und beantworte deine Fragen live.')])]), { width: 'narrow', bg: 'token:surface' }),
          ctaBand('Dein Platz wartet', 'Die Plätze sind begrenzt – melde dich jetzt an.', ['Jetzt anmelden', 'page:anmeldung']),
        ],
      },
      {
        name: 'Bestätigung',
        slug: 'bestaetigung',
        seo: { title: 'Du bist dabei – {{firma}}', noindex: true },
        blocks: [heroCenter({ title: 'Du bist dabei! 🎉', lead: 'Wir haben dir eine E-Mail mit dem Link zum Webinar geschickt. Trag dir den Termin am besten gleich in den Kalender ein.', bg: 'token:surface', pad: 80 }), section(row([col(12, [{ type: 'countdown', until: '{{in7days}}', align: 'center', padding: 0 }, p('**So bereitest du dich vor:** Notiere zwei Fragen, die dir wichtig sind, und halte einen Stift bereit.', { align: 'center' })])]), { width: 'narrow', pad_y: 40 })],
      },
      {
        name: 'Replay & Angebot',
        slug: 'replay',
        seo: { title: 'Webinar-Aufzeichnung – {{firma}}', noindex: true },
        blocks: [
          heroCenter({ title: 'Die Aufzeichnung', lead: 'Hier kannst du das Webinar noch einmal in Ruhe ansehen.', pad: 56 }),
          section(row([col(12, [{ type: 'video', url: '', title: 'Webinar-Aufzeichnung' }])]), { width: 'normal', pad_y: 8 }),
          section(row([col(12, [h('Dein nächster Schritt', 2, { align: 'center' }), productBlock({ heading: '', badge: 'Nur bis Ende der Woche' })])]), { width: 'narrow', bg: 'token:surface' }),
        ],
      },
      ...legalPages(true),
    ],
  },

  // ------------------------------------------------------------------------------------------------------------ Kurs-Verkauf
  {
    id: 'kurs-verkauf',
    name: 'Kurs-Verkauf',
    category: 'Verkauf & Kurse',
    kind: 'funnel',
    description: 'Lange Verkaufsseite für Online-Kurse und Programme mit Inhalten, Stimmen, Preis, Garantie, FAQ – und Danke-Seite.',
    tags: ['Online-Kurs', 'Verkaufsseite', 'Checkout', 'Widerruf'],
    tokens: { colors: { brand: '#1d4ed8', accent: '#f59e0b', surface: '#eff6ff' }, fonts: { heading: 'modern', body: 'modern' }, radius: { sm: 8, md: 14, lg: 24 } },
    footer,
    needs: ['product'],
    legal: ['impressum', 'datenschutz', 'widerruf'],
    pages: [
      {
        name: 'Verkaufsseite',
        slug: 'kurs',
        seo: { title: '{{firma}} – Der Online-Kurs, mit dem du es wirklich schaffst', description: 'Schritt für Schritt zum Ergebnis: Videolektionen, Vorlagen und eine Community. 30 Tage Geld-zurück-Garantie.' },
        blocks: [
          heroCenter({ eyebrow: 'Online-Kurs', title: 'In 6 Wochen zu deinem ersten Ergebnis', lead: 'Videolektionen, Vorlagen und eine Community, die dich trägt – für alle, die nicht länger alleine herumprobieren wollen.', primary: ['Jetzt starten', '#angebot'], secondary: ['Inhalte ansehen', '#inhalt'], bg: 'token:surface', pad: 104, width: 'normal', note: '✔ Sofortiger Zugang   ✔ 30 Tage Geld-zurück   ✔ Lebenslanger Zugriff' }),
          benefits('Kennst du das?', [['😵', 'Zu viele Infos', 'Du hast dir schon viel angesehen – aber es fehlt der rote Faden.'], ['⏳', 'Keine Zeit', 'Du brauchst einen Weg, der in deinen Alltag passt.'], ['🤷', 'Unsicher', 'Du weißt nicht, ob du es richtig machst.']], { bg: 'token:bg' }),
          section(row([col(12, [{ type: 'steps', heading: 'Das erwartet dich im Kurs', anchor: 'inhalt', padding: 0, align: 'center', items: [{ title: 'Woche 1: Fundament', text: 'Ziel, Zielgruppe, Angebot – klar formuliert.' }, { title: 'Woche 2–3: Aufbau', text: 'Alle Bausteine Schritt für Schritt umsetzen.' }, { title: 'Woche 4–5: Feinschliff', text: 'Testen, verbessern, Fehler vermeiden.' }, { title: 'Woche 6: Start', text: 'Launch-Plan und die ersten Kunden.' }] }])]), { bg: 'token:surface' }),
          stats([['350+', 'Teilnehmende'], ['4,8/5', 'Bewertung'], ['6 Wochen', 'bis zum Ergebnis']]),
          testimonials('Das sagen Teilnehmende', [['Ich habe in zwei Wochen mehr geschafft als im ganzen Jahr davor.', 'Sabine K.'], ['Klar strukturiert und sofort umsetzbar.', 'Markus T.'], ['Die Community hat mich motiviert, dranzubleiben.', 'Julia R.']], { bg: 'token:surface' }),
          section(row([col(12, [h('Dein Angebot', 2, { align: 'center' }), productBlock({ highlight: true, badge: 'Beliebt', button_text: 'Zur Bestellung' })])]), { width: 'narrow', anchor: 'angebot' }),
          section(row([col(12, [h('30 Tage Geld-zurück-Garantie', 2, { align: 'center' }), p('Du kannst den Kurs 30 Tage lang in Ruhe testen. Wenn er nicht zu dir passt, schreib uns – wir erstatten dir den Preis. Dein Widerrufsrecht bleibt davon unberührt.', { align: 'center' })])]), { width: 'narrow', bg: 'token:surface' }),
          faq([['Für wen ist der Kurs?', 'Für alle, die strukturiert einsteigen wollen – Vorkenntnisse sind nicht nötig.'], ['Wie lange habe ich Zugriff?', 'Unbegrenzt. Neue Inhalte bekommst du kostenlos.'], ['Wie viel Zeit brauche ich?', 'Plane 2–3 Stunden pro Woche ein.'], ['Gibt es Rechnung und Zahlung auf Raten?', 'Ja, du bekommst eine Rechnung mit ausgewiesener Umsatzsteuer; Zahlung per Karte oder SEPA.']]),
        ],
      },
      thanks('Danke für deine Bestellung!', 'Deine Zahlung ist eingegangen. Die Zugangsdaten und deine Rechnung kommen in wenigen Minuten per E-Mail.', [p('**Nächste Schritte**\n\n1. E-Mail öffnen und Zugang bestätigen\n\n2. Mit Lektion 1 starten\n\n3. In der Community vorstellen', { align: 'center' })]),
      ...legalPages(true),
    ],
  },

  // ---------------------------------------------------------------------------------------------------------------- Event
  {
    id: 'event',
    name: 'Event & Konferenz',
    category: 'Events & Webinare',
    kind: 'funnel',
    description: 'Landingpage für Konferenzen, Workshops und Meetups mit Programm, Referenten, Tickets und FAQ.',
    tags: ['Event', 'Tickets', 'Programm', 'Countdown'],
    tokens: { colors: { brand: '#c2410c', accent: '#0f172a', surface: '#fff7ed' }, fonts: { heading: 'geometric', body: 'modern' }, radius: { sm: 8, md: 14, lg: 24 }, scale: { base: 17, ratio: 1.32 } },
    footer,
    needs: ['product'],
    legal: ['impressum', 'datenschutz', 'widerruf'],
    pages: [
      {
        name: 'Event',
        slug: 'event',
        seo: { title: '{{firma}} – Das Event des Jahres', description: 'Ein Tag voller Impulse, Praxis und Austausch. Jetzt Ticket sichern.' },
        blocks: [
          heroCenter({ eyebrow: 'Konferenz · Vor Ort & online', title: 'Ein Tag. Viele Impulse. Echte Begegnungen.', lead: 'Praxisnahe Vorträge, Workshops und Zeit zum Netzwerken – für alle, die ihr Thema nach vorne bringen wollen.', primary: ['Ticket sichern', '#tickets'], secondary: ['Zum Programm', '#programm'], bg: '#0f172a', pad: 120, width: 'normal' }),
          section(row([col(12, [{ type: 'countdown', until: '{{in30days}}', align: 'center', padding: 0 }])]), { pad_y: 32 }),
          stats([['12', 'Referentinnen und Referenten'], ['300', 'Teilnehmende'], ['6', 'Workshops'], ['1', 'Tag voller Austausch']], { bg: 'token:surface' }),
          section(row([col(12, [{ type: 'steps', heading: 'Das Programm', anchor: 'programm', align: 'center', padding: 0, items: [{ title: '09:00 · Ankommen', text: 'Kaffee, Registrierung, erste Gespräche.' }, { title: '10:00 · Keynote', text: 'Der große Blick nach vorn.' }, { title: '11:30 · Workshops', text: 'Sechs Praxis-Sessions zur Auswahl.' }, { title: '14:00 · Panel & Austausch', text: 'Diskussion mit dem Publikum.' }] }])]), { pad_y: 72 }),
          benefits('Darauf kannst du dich freuen', [['🎤', 'Starke Vorträge', 'Aus der Praxis, ohne Werbung.'], ['🛠️', 'Workshops', 'Kleine Gruppen, direkt anwendbar.'], ['🤝', 'Netzwerk', 'Lerne Menschen kennen, die dein Thema teilen.']], { bg: 'token:surface' }),
          section(row([col(12, [h('Tickets', 2, { align: 'center' }), productBlock({ highlight: true, badge: 'Early Bird' })])]), { width: 'narrow', anchor: 'tickets' }),
          faq([['Wo findet das Event statt?', 'Die genaue Adresse und Anreise stehen in deiner Ticket-E-Mail.'], ['Kann ich mein Ticket übertragen?', 'Ja, bis 7 Tage vor dem Event kostenlos – schreib uns einfach.'], ['Gibt es eine Aufzeichnung?', 'Ja, alle Teilnehmenden erhalten die Aufzeichnungen der Vorträge.']], 'Fragen und Antworten', { bg: 'token:surface' }),
        ],
      },
      thanks('Dein Ticket ist gesichert!', 'Wir haben dir die Bestätigung und dein Ticket per E-Mail geschickt. Bis bald!'),
      ...legalPages(true),
    ],
  },

  // ---------------------------------------------------------------------------------------------------------- Link in Bio
  {
    id: 'link-in-bio',
    name: 'Link-in-Bio',
    category: 'Persönlich',
    kind: 'funnel',
    description: 'Eine Seite für Instagram, TikTok und YouTube: Foto, Kurztext und deine wichtigsten Links als große Buttons.',
    tags: ['Social Media', 'Links', 'Creator'],
    tokens: { colors: { brand: '#111827', accent: '#ec4899', bg: '#f8fafc', surface: '#e2e8f0' }, fonts: { heading: 'rounded', body: 'rounded' }, radius: { sm: 12, md: 999, lg: 28 } },
    footer,
    needs: [],
    legal: ['impressum', 'datenschutz'],
    pages: [
      {
        name: 'Links',
        slug: 'links',
        seo: { title: '{{firma}} – alle Links', description: 'Hier findest du alles auf einen Blick.' },
        layout: {},
        blocks: [
          section(
            row([
              col(12, [
                h('{{firma}}', 1, { align: 'center' }),
                p('Kurz gesagt: Ich helfe dir dabei, mehr aus deinem Alltag zu machen. Hier sind meine wichtigsten Links.', { align: 'center', color: 'token:muted' }),
                btn('📘 Gratis-Guide holen', '#', { align: 'center' }),
                btn('🎥 Neues Video ansehen', '#', { align: 'center' }),
                btn('📅 Kostenloses Gespräch buchen', '#', { align: 'center' }),
                btn('🛒 Zum Shop', '#', { align: 'center' }),
                btn('✉️ Newsletter abonnieren', '#', { align: 'center' }),
              ]),
            ]),
            { width: 'narrow', pad_y: 56 },
          ),
        ],
      },
      ...legalPages(),
    ],
  },

  // ----------------------------------------------------------------------------------------------------------- Newsletter
  {
    id: 'newsletter',
    name: 'Newsletter-Anmeldung',
    category: 'Lead-Funnel',
    kind: 'funnel',
    description: 'Anmeldeseite für deinen Newsletter mit Nutzen, Beispielthemen und Bestätigung (Double-Opt-in).',
    tags: ['Newsletter', 'Opt-in', 'Creator'],
    tokens: { colors: { brand: '#0f766e', accent: '#f59e0b', surface: '#f0fdfa' }, fonts: { heading: 'serif', body: 'humanist' }, radius: { sm: 8, md: 14, lg: 24 } },
    footer,
    needs: ['form'],
    form: 'optin',
    thanks: 'danke',
    legal: ['impressum', 'datenschutz'],
    pages: [
      {
        name: 'Anmeldung',
        slug: 'newsletter',
        seo: { title: 'Newsletter – {{firma}}', description: 'Einmal pro Woche: Ideen, Praxis-Tipps und Links, die dich weiterbringen.' },
        blocks: [
          heroSplit({ eyebrow: 'Jeden Donnerstag', title: 'Ein Newsletter, den du gerne öffnest', lead: 'Einmal pro Woche: eine Idee, ein Praxis-Tipp und drei Links, die sich wirklich lohnen. In fünf Minuten gelesen.', aside: [formBlock('Kostenlos abonnieren', {})], bg: 'token:surface', note: 'Abmeldung mit einem Klick. Deine Daten bleiben bei uns.' }),
          benefits('Das erwartet dich', [['💡', 'Eine Idee', 'Ein Gedanke, der dein Denken erweitert.'], ['🛠️', 'Ein Tipp', 'Direkt umsetzbar – ohne Vorwissen.'], ['🔗', 'Drei Links', 'Das Beste aus dem Netz, handverlesen.']]),
          testimonials('Leserstimmen', [['Der einzige Newsletter, den ich nie ungelesen lösche.', 'Sabine K.'], ['Kurz, klug, nützlich.', 'Markus T.']], { bg: 'token:surface' }),
        ],
      },
      thanks('Fast geschafft!', 'Wir haben dir eine E-Mail geschickt. Klick auf den Bestätigungslink, damit du ab sofort nichts mehr verpasst.'),
      ...legalPages(),
    ],
  },

  // ----------------------------------------------------------------------------------------------------------------- Podcast
  {
    id: 'podcast',
    name: 'Podcast',
    category: 'Persönlich',
    kind: 'website',
    description: 'Seite für deinen Podcast: Folgenliste, Abo-Buttons, Über den Podcast und Gast-Anfrage.',
    tags: ['Podcast', 'Folgen', 'Abo'],
    tokens: { colors: { brand: '#9333ea', accent: '#f97316', surface: '#faf5ff' }, fonts: { heading: 'rounded', body: 'modern' }, radius: { sm: 10, md: 16, lg: 28 } },
    header: { cta_text: 'Podcast abonnieren', cta_url: 'home', sticky: true },
    menu: [['Folgen', 'home'], ['Über den Podcast', 'ueber'], ['Gast werden', 'gast']],
    footer: { text: '© {{firma}}' },
    needs: ['form'],
    form: 'contact',
    collections: [{ preset: 'projects', name: 'Folgen', slug: 'folgen', singular: 'Folge', samples: true }],
    legal: ['impressum', 'datenschutz'],
    search: true,
    pages: [
      {
        name: 'Folgen',
        slug: 'home',
        seo: { title: '{{firma}} – Der Podcast', description: 'Gespräche, die hängen bleiben: neue Folgen alle zwei Wochen.' },
        blocks: [
          heroCenter({ eyebrow: 'Neue Folge alle 2 Wochen', title: 'Gespräche, die hängen bleiben', lead: 'Wir sprechen mit Menschen, die etwas bewegen – ehrlich, konkret und ohne Floskeln.', primary: ['Auf Spotify hören', '#'], secondary: ['Auf Apple Podcasts', '#'], bg: 'token:surface', pad: 96 }),
          section(row([col(12, [h('Die neuesten Folgen', 2, { align: 'center' }), collectionBlock('projects', { limit: 6, layout: 'list', columns: 1 })])]), { width: 'wide' }),
          ctaBand('Nie wieder eine Folge verpassen', 'Abonniere den Podcast in deiner Lieblings-App.', ['Jetzt abonnieren', '#'], { style: 'dark' }),
        ],
      },
      { name: 'Über den Podcast', slug: 'ueber', seo: { title: 'Über den Podcast – {{firma}}' }, blocks: [twoCols([h('Worum es geht', 1), p('Wir stellen Menschen vor, die ihren eigenen Weg gehen, und fragen nach den Entscheidungen, die dahinter stehen.\n\nJede Folge dauert etwa 40 Minuten – ideal für den Weg zur Arbeit.')], [card([h('Dein Host', 3), p('Hier steht eine kurze Vorstellung der Moderatorin oder des Moderators.')], { shadow: 'md' })], { pad_y: 80 }, [7, 5])] },
      { name: 'Gast werden', slug: 'gast', seo: { title: 'Gast werden – {{firma}}' }, blocks: [contact('Du hast eine Geschichte?', 'Schreib uns, worüber du sprechen möchtest. Wir melden uns innerhalb einer Woche.', formBlock('Dein Vorschlag'))] },
      ...legalPages(),
    ],
  },

  // -------------------------------------------------------------------------------------------------------- Produkt-Launch
  {
    id: 'produkt-launch',
    name: 'Produkt-Launch',
    category: 'Verkauf & Kurse',
    kind: 'funnel',
    description: 'Landingpage für einen Produktstart mit Countdown, Nutzen, Preis, FAQ und Danke-Seite.',
    tags: ['Launch', 'Countdown', 'Produkt', 'Checkout'],
    tokens: { colors: { brand: '#047857', accent: '#f59e0b', surface: '#ecfdf5' }, fonts: { heading: 'modern', body: 'modern' }, radius: { sm: 8, md: 14, lg: 24 } },
    footer,
    needs: ['product'],
    legal: ['impressum', 'datenschutz', 'widerruf'],
    pages: [
      {
        name: 'Landingpage',
        slug: 'launch',
        seo: { title: '{{firma}} – Jetzt neu: das Produkt, auf das du gewartet hast', description: 'Zum Start mit Einführungspreis. Nur für kurze Zeit.' },
        blocks: [
          heroSplit({ eyebrow: 'Jetzt neu', title: 'Das Produkt, auf das du gewartet hast', lead: 'Einfach, durchdacht und sofort einsatzbereit. Sichere dir den Einführungspreis – nur für kurze Zeit.', primary: ['Jetzt sichern', '#angebot'], secondary: ['Vorteile ansehen', '#vorteile'], bg: 'token:surface', aside: [card([{ type: 'countdown', until: '{{in7days}}', align: 'center', padding: 0 }, p('Einführungspreis endet in …', { align: 'center' })], { bg: 'token:bg', shadow: 'lg' })] }),
          section(row([col(12, [{ type: 'features', heading: 'Darum lohnt es sich', anchor: 'vorteile', align: 'center', padding: 0, items: [{ icon: '⚡', title: 'Sofort startklar', text: 'Auspacken, anschließen, loslegen.' }, { icon: '🧠', title: 'Durchdacht', text: 'Entwickelt mit Feedback aus über 200 Tests.' }, { icon: '🌱', title: 'Nachhaltig', text: 'Langlebig, reparierbar und fair produziert.' }] }])]), {}),
          testimonials('Erste Stimmen', [['Hätte ich früher haben sollen.', 'Sabine K.'], ['Funktioniert einfach.', 'Markus T.'], ['Preis-Leistung top.', 'Julia R.']], { bg: 'token:surface' }),
          section(row([col(12, [h('Dein Angebot', 2, { align: 'center' }), productBlock({ highlight: true, badge: 'Einführungspreis' })])]), { width: 'narrow', anchor: 'angebot' }),
          faq([['Wann wird geliefert bzw. freigeschaltet?', 'Digitale Produkte sofort nach Zahlung, physische innerhalb von 3–5 Werktagen.'], ['Kann ich zurückgeben?', 'Ja, du hast 14 Tage Widerrufsrecht. Hinweise findest du in der Widerrufsbelehrung.'], ['Welche Zahlungsarten gibt es?', 'Karte, SEPA-Lastschrift, Apple Pay und Google Pay.']], 'Häufige Fragen', { bg: 'token:surface' }),
        ],
      },
      thanks('Danke für deine Bestellung!', 'Wir haben dir die Bestätigung per E-Mail geschickt. Alles Weitere erfährst du dort.'),
      ...legalPages(true),
    ],
  },

  // ------------------------------------------------------------------------------------------------------------------- VSL
  {
    id: 'vsl',
    name: 'Video-Sales-Letter',
    category: 'Verkauf & Kurse',
    kind: 'funnel',
    description: 'Eine Seite, ein Video, ein Angebot: Headline, Video, Button – ideal für Beratung, Coaching und digitale Produkte.',
    tags: ['Video', 'Verkauf', 'Coaching'],
    tokens: { colors: { brand: '#ef4444', accent: '#facc15', bg: '#0b1020', text: '#f8fafc', muted: '#cbd5e1', surface: '#151b32', line: '#2a3358', success: '#34d399', danger: '#f87171' }, fonts: { heading: 'geometric', body: 'modern' }, radius: { sm: 8, md: 14, lg: 22 } },
    footer,
    needs: ['product'],
    legal: ['impressum', 'datenschutz', 'widerruf'],
    pages: [
      {
        name: 'Video',
        slug: 'video',
        seo: { title: 'Sieh dir zuerst das Video an – {{firma}}' },
        blocks: [
          heroCenter({ eyebrow: 'Wichtig: Video ansehen', title: 'So kommst du in 30 Tagen zu deinem ersten Ergebnis', lead: 'Sieh dir das kurze Video an – danach weißt du, ob mein Angebot zu dir passt.', pad: 56, width: 'narrow' }),
          section(row([col(12, [{ type: 'video', url: '', title: 'Video: So geht es' }])]), { width: 'normal', pad_y: 8 }),
          section(row([col(12, [{ type: 'button', text: 'Ja, ich möchte starten', url: '#angebot', align: 'center' }, p('Weniger als 3 Minuten bis zur Entscheidung.', { align: 'center', color: 'token:muted' })])]), { pad_y: 24 }),
          testimonials('Ergebnisse', [['Nach vier Wochen hatte ich meine ersten drei Kunden.', 'Sabine K.'], ['Die Anleitung war klar wie nie.', 'Markus T.'], ['Ich wünschte, ich hätte früher angefangen.', 'Julia R.']]),
          section(row([col(12, [productBlock({ highlight: true })])]), { width: 'narrow', anchor: 'angebot' }),
        ],
      },
      thanks('Willkommen an Bord!', 'Deine Bestellung ist eingegangen. Alle Details bekommst du per E-Mail.'),
      ...legalPages(true),
    ],
  },

  // -------------------------------------------------------------------------------------------------------- Termin-Funnel
  {
    id: 'termin-funnel',
    name: 'Bewerbungs- & Termin-Funnel',
    category: 'Lead-Funnel',
    kind: 'funnel',
    description: 'Für Beratung und Coaching mit höherem Preis: Interessenten bewerben sich, buchen ein Gespräch und landen auf der Bestätigungsseite.',
    tags: ['Bewerbung', 'Beratungsgespräch', 'Terminbuchung', 'High-Ticket'],
    tokens: { colors: { brand: '#0f172a', accent: '#d97706', surface: '#f1f5f9' }, fonts: { heading: 'serif', body: 'modern' }, radius: { sm: 6, md: 10, lg: 18 } },
    footer,
    needs: ['form', 'calendar'],
    form: 'application',
    thanks: 'termin',
    legal: ['impressum', 'datenschutz'],
    pages: [
      {
        name: 'Bewerbung',
        slug: 'bewerbung',
        seo: { title: 'Für ein Strategiegespräch bewerben – {{firma}}' },
        blocks: [
          heroSplit({ eyebrow: 'Persönliche Begleitung · begrenzte Plätze', title: 'Dein Weg zum nächsten Level', lead: 'Ich arbeite mit einer kleinen Zahl von Kundinnen und Kunden intensiv zusammen. Bewirb dich für ein kostenloses Strategiegespräch – wenn es passt, besprechen wir die Zusammenarbeit.', aside: [formBlock('Jetzt bewerben', {})], bg: 'token:surface', note: 'Wir melden uns nur, wenn es wirklich passt. Deine Angaben behandeln wir vertraulich.' }),
          steps('So läuft es ab', [['Bewerben', 'Du beantwortest ein paar Fragen zu deinem Vorhaben.'], ['Termin wählen', 'Direkt danach suchst du dir ein Gespräch aus.'], ['Strategiegespräch', '45 Minuten: Standortbestimmung und nächste Schritte.']], { bg: 'token:bg' }),
          testimonials('Ergebnisse unserer Kundschaft', [['Das Gespräch hat mir in 45 Minuten mehr Klarheit gebracht als ein Jahr Alleingang.', 'Sabine K.'], ['Direkt, wertschätzend, konkret.', 'Markus T.']], { bg: 'token:surface' }),
        ],
      },
      { name: 'Termin', slug: 'termin', seo: { title: 'Wähle deinen Termin – {{firma}}', noindex: true }, blocks: [heroCenter({ title: 'Danke für deine Bewerbung!', lead: 'Wähle jetzt einen Termin für dein Strategiegespräch.', bg: 'token:surface', pad: 56 }), section(row([col(12, [calendarBlock({ title: 'Terminbuchung Strategiegespräch' })])]), { pad_y: 16, width: 'wide' })] },
      thanks('Dein Termin steht', 'Du bekommst eine Bestätigung mit allen Details per E-Mail. Bis bald!'),
      ...legalPages(),
    ],
  },
];
