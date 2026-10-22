import type { FieldType, FormField, FormSettings } from './form-fields.js';

/**
 * Ready-made forms in German (Vorlagen-Galerie): lead qualification with a score, NPS survey, application, event registration, quiz,
 * quote request for craftspeople, coaching intro call, calculators, a paid order and more. Each one is a plain list of fields plus
 * settings – opening one makes a normal form that can be changed like any other.
 */

type Draft = Partial<Omit<FormField, 'jumps' | 'show_if' | 'type'>> & {
  type: FieldType;
  label: string;
  /** Short name other fields refer to (jumps, show_if). */
  key?: string;
  jumps?: { op: string; value?: string; goto: string }[];
  show_if?: { field: string; op: string; value?: string };
};

export interface Template {
  id: string;
  name: string;
  category: string;
  description: string;
  kind: 'form' | 'survey';
  mode: 'classic' | 'typeform';
  /** The form needs one of the sub-account's products (payment field). */
  needs_product?: boolean;
  fields: FormField[];
  settings: FormSettings;
}

const t = (type: FieldType, label: string, extra: Partial<Draft> = {}): Draft => ({ type, label, ...extra });
const text = (label: string, extra: Partial<Draft> = {}) => t('text', label, extra);
const first = () => t('text', 'Vorname', { name: 'first_name', required: true, key: 'vorname' });
const last = () => t('text', 'Nachname', { name: 'last_name', key: 'nachname' });
const email = () => t('email', 'E-Mail', { name: 'email', required: true, key: 'email' });
const phone = (req = false) => t('phone', 'Telefon', { name: 'phone', required: req, key: 'telefon' });
const consent = (label = 'Ich stimme der Verarbeitung meiner Daten gemäß Datenschutzerklärung zu.') => t('consent', label, { name: 'consent', required: true, key: 'consent' });
const contact = (withPhone = true, req = false): Draft[] => [first(), last(), email(), ...(withPhone ? [phone(req)] : []), consent()];
const choice = (type: 'radio' | 'select' | 'checkbox', label: string, options: string[], extra: Partial<Draft> = {}) => t(type, label, { options, ...extra });
const pts = (options: string[], points: number[]) => Object.fromEntries(options.map((o, i) => [o, points[i] ?? 0]));

/** Drafts → fields: ids f1…, names from keys, `@key` references turned into ids (jumps) and names (show_if). */
function build(drafts: Draft[]): FormField[] {
  const idOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  drafts.forEach((d, i) => {
    const id = `f${i + 1}`;
    const name = d.name ?? d.key ?? `feld_${i + 1}`;
    if (d.key) {
      idOf.set(d.key, id);
      nameOf.set(d.key, name);
    }
  });
  const ref = (v: string, m: Map<string, string>) => (v.startsWith('@') ? (m.get(v.slice(1)) ?? v) : v);
  return drafts.map((d, i) => {
    const { key, jumps, show_if, ...rest } = d;
    const out: FormField = { id: `f${i + 1}`, name: d.name ?? key ?? `feld_${i + 1}`, required: false, options: [], ...rest } as FormField;
    if (jumps) out.jumps = jumps.map((j) => ({ op: j.op as any, value: j.value ?? '', goto: j.goto === 'end' ? 'end' : ref(j.goto, idOf) }));
    if (show_if) out.show_if = { field: ref(show_if.field, nameOf), op: show_if.op as any, value: show_if.value ?? '' };
    return out;
  });
}

const THANKS = 'Danke! Wir melden uns in Kürze bei dir.';

const defs: (Omit<Template, 'fields'> & { drafts: Draft[] })[] = [
  {
    id: 'kontakt',
    name: 'Kontaktformular',
    category: 'Allgemein',
    description: 'Name, E-Mail, Telefon und Nachricht – der Klassiker für jede Website.',
    kind: 'form',
    mode: 'classic',
    settings: { title: 'Schreib uns', thank_you: THANKS, submit_text: 'Nachricht senden', theme: { preset: 'standard' } },
    drafts: [first(), last(), email(), phone(), t('textarea', 'Deine Nachricht', { name: 'message', required: true, key: 'nachricht' }), consent()],
  },
  {
    id: 'lead-qualifizierung',
    name: 'Lead-Qualifizierung',
    category: 'Vertrieb',
    description: 'Fünf Fragen, ein Punktestand: heiße, warme und kalte Anfragen bekommen ein eigenes Ergebnis und ein Tag. Wer kein Budget hat, springt direkt zu den Kontaktdaten.',
    kind: 'form',
    mode: 'typeform',
    settings: {
      title: 'Passt das zu uns?',
      thank_you: THANKS,
      submit_text: 'Absenden',
      auto_advance: true,
      theme: { preset: 'dunkel' },
      welcome: { title: 'In 2 Minuten wissen wir, ob wir zusammenpassen', text: 'Beantworte ein paar kurze Fragen – danach melden wir uns persönlich.', button: 'Los geht’s' },
      show_result: false,
      endings: [
        { var: 'score', min: 9, max: null, title: 'Das passt sehr gut!', text: 'Du bekommst heute noch einen Anruf von uns. Dein Ergebnis: {{score}} von 12 Punkten.', redirect_url: '', tag: 'lead:heiss' },
        { var: 'score', min: 5, max: 8, title: 'Das sieht vielversprechend aus', text: 'Wir melden uns in den nächsten Tagen mit einem Vorschlag. Dein Ergebnis: {{score}} von 12 Punkten.', redirect_url: '', tag: 'lead:warm' },
        { var: 'score', min: null, max: 4, title: 'Danke für dein Interesse', text: 'Wir schicken dir hilfreiche Unterlagen, bis der Zeitpunkt passt.', redirect_url: '', tag: 'lead:kalt' },
      ],
    },
    drafts: [
      choice('radio', 'Wie viele Personen arbeiten in deinem Unternehmen?', ['Nur ich', '2 bis 5', '6 bis 20', 'Mehr als 20'], { key: 'team', required: true, points: pts(['Nur ich', '2 bis 5', '6 bis 20', 'Mehr als 20'], [0, 1, 2, 3]) }),
      choice('radio', 'Wie hoch ist dein Budget für dieses Projekt?', ['Kein Budget', 'Bis 1.000 €', '1.000 bis 5.000 €', 'Mehr als 5.000 €'], {
        key: 'budget',
        required: true,
        points: pts(['Kein Budget', 'Bis 1.000 €', '1.000 bis 5.000 €', 'Mehr als 5.000 €'], [0, 1, 2, 3]),
        jumps: [{ op: 'eq', value: 'Kein Budget', goto: '@vorname' }],
      }),
      choice('radio', 'Wann möchtest du starten?', ['Sofort', 'In 1 bis 3 Monaten', 'Später', 'Weiß ich noch nicht'], { key: 'start', required: true, points: pts(['Sofort', 'In 1 bis 3 Monaten', 'Später', 'Weiß ich noch nicht'], [3, 2, 1, 0]) }),
      choice('radio', 'Entscheidest du selbst?', ['Ja, allein', 'Gemeinsam mit anderen', 'Ich sammle Informationen für andere'], { key: 'entscheider', required: true, points: pts(['Ja, allein', 'Gemeinsam mit anderen', 'Ich sammle Informationen für andere'], [3, 2, 0]) }),
      t('heading', 'Fast geschafft – wie erreichen wir dich?', { key: 'ueberschrift' }),
      ...contact(true, false),
    ],
  },
  {
    id: 'nps-umfrage',
    name: 'Kundenumfrage mit NPS',
    category: 'Umfragen',
    description: 'Die klassische Weiterempfehlungsfrage (0–10). Fans werden nach dem Grund gefragt, Kritiker nach dem, was fehlt.',
    kind: 'survey',
    mode: 'typeform',
    settings: { title: 'Wie zufrieden bist du?', thank_you: 'Vielen Dank für dein Feedback!', theme: { preset: 'ozean' }, auto_advance: true, tags: ['umfrage:nps'] },
    drafts: [
      t('nps', 'Wie wahrscheinlich ist es, dass du uns weiterempfiehlst?', { name: 'nps', key: 'nps', required: true }),
      t('textarea', 'Was gefällt dir besonders gut?', { name: 'gut', key: 'gut', show_if: { field: '@nps', op: 'gte', value: '9' } }),
      t('textarea', 'Was können wir besser machen?', { name: 'besser', key: 'besser', show_if: { field: '@nps', op: 'lte', value: '6' } }),
      t('textarea', 'Möchtest du uns noch etwas mitgeben?', { name: 'sonstiges', key: 'sonstiges', show_if: { field: '@nps', op: 'filled' } }),
      t('email', 'Dürfen wir uns bei dir melden? Dann trag hier deine E-Mail ein.', { name: 'email', key: 'email' }),
    ],
  },
  {
    id: 'bewerbung',
    name: 'Bewerbung',
    category: 'Personal',
    description: 'Bewerbungsformular mit Lebenslauf-Upload, Wunschstart und Gehaltsvorstellung auf zwei Seiten.',
    kind: 'form',
    mode: 'classic',
    settings: { title: 'Bewirb dich bei uns', thank_you: 'Danke für deine Bewerbung! Wir melden uns innerhalb von zwei Wochen.', submit_text: 'Bewerbung abschicken', theme: { preset: 'wald' }, tags: ['bewerbung'] },
    drafts: [
      t('heading', 'Zu dir', { key: 'h1' }),
      first(),
      last(),
      email(),
      phone(),
      t('page_break', '', { key: 'p1' }),
      t('heading', 'Zu deiner Bewerbung', { key: 'h2' }),
      choice('select', 'Auf welche Stelle bewirbst du dich?', ['Kundenberatung', 'Vertrieb', 'Marketing', 'Buchhaltung', 'Initiativbewerbung'], { name: 'stelle', key: 'stelle', required: true }),
      t('date', 'Frühester Eintrittstermin', { name: 'start', key: 'start' }),
      t('number', 'Gehaltsvorstellung (brutto pro Jahr, in €)', { name: 'gehalt', key: 'gehalt', min: 0 }),
      t('file', 'Lebenslauf (PDF)', { name: 'lebenslauf', key: 'cv', required: true }),
      t('file', 'Anschreiben und Zeugnisse (optional)', { name: 'unterlagen', key: 'unterlagen' }),
      t('textarea', 'Warum möchtest du bei uns arbeiten?', { name: 'motivation', key: 'motivation' }),
      consent('Ich willige ein, dass meine Bewerbungsdaten zum Zweck des Auswahlverfahrens gespeichert werden.'),
    ],
  },
  {
    id: 'event-anmeldung',
    name: 'Event-Anmeldung',
    category: 'Events',
    description: 'Anmeldung mit Teilnehmerzahl, Essenswünschen und einer Frage ans Publikum.',
    kind: 'form',
    mode: 'classic',
    settings: { title: 'Anmeldung zum Event', thank_you: 'Du bist dabei! Alle Infos kommen per E-Mail.', submit_text: 'Verbindlich anmelden', theme: { preset: 'pastell' }, tags: ['event:angemeldet'] },
    drafts: [
      first(),
      last(),
      email(),
      phone(),
      t('number', 'Wie viele Personen kommen mit dir (inklusive dir)?', { name: 'personen', key: 'personen', required: true, min: 1, max: 10, value: '1' }),
      choice('checkbox', 'Essenswünsche', ['Vegetarisch', 'Vegan', 'Glutenfrei', 'Laktosefrei', 'Keine'], { name: 'essen', key: 'essen' }),
      t('textarea', 'Welche Frage soll das Event unbedingt beantworten?', { name: 'frage', key: 'frage' }),
      consent(),
    ],
  },
  {
    id: 'wissensquiz',
    name: 'Quiz mit Auswertung',
    category: 'Marketing',
    description: 'Fünf Wissensfragen mit Punkten, einer Auswertung nach Punktestand und passendem Tag – ideal als Lead-Magnet.',
    kind: 'form',
    mode: 'typeform',
    settings: {
      title: 'Wie fit bist du in Online-Marketing?',
      thank_you: 'Danke fürs Mitmachen!',
      theme: { preset: 'knallig' },
      auto_advance: true,
      show_result: true,
      welcome: { title: 'Wie fit bist du in Online-Marketing?', text: 'Fünf Fragen, zwei Minuten – am Ende bekommst du deine Auswertung.', button: 'Quiz starten' },
      endings: [
        { var: 'score', min: 5, max: null, title: 'Profi!', text: 'Du hast {{score}} von 5 richtig. Du kennst dich richtig gut aus – wollen wir uns über die nächste Stufe unterhalten?', redirect_url: '', tag: 'quiz:profi' },
        { var: 'score', min: 3, max: 4, title: 'Gut dabei', text: 'Du hast {{score}} von 5 richtig. Mit ein paar Kniffen holst du noch viel heraus.', redirect_url: '', tag: 'quiz:fortgeschritten' },
        { var: 'score', min: null, max: 2, title: 'Da geht noch was', text: 'Du hast {{score}} von 5 richtig. Kein Problem – wir schicken dir die wichtigsten Grundlagen.', redirect_url: '', tag: 'quiz:einsteiger' },
      ],
    },
    drafts: [
      choice('radio', 'Wofür steht die Abkürzung „SEO“?', ['Search Engine Optimization', 'Social Email Outreach', 'Sales Evaluation Overview'], { key: 'q1', required: true, points: { 'Search Engine Optimization': 1 } }),
      choice('radio', 'Welche Kennzahl zeigt, wie viele Besucher etwas gekauft haben?', ['Absprungrate', 'Konversionsrate', 'Reichweite'], { key: 'q2', required: true, points: { Konversionsrate: 1 } }),
      choice('radio', 'Wie oft sollte ein Newsletter mindestens getestet werden, bevor man Ergebnisse vergleicht?', ['Gar nicht', 'Mit einer Variante', 'Mit mindestens zwei Varianten (A/B-Test)'], { key: 'q3', required: true, points: { 'Mit mindestens zwei Varianten (A/B-Test)': 1 } }),
      choice('radio', 'Was gehört zu einem guten Call-to-Action?', ['Ein klares, einzelnes Ziel', 'Möglichst viele Buttons', 'Kleine, graue Schrift'], { key: 'q4', required: true, points: { 'Ein klares, einzelnes Ziel': 1 } }),
      choice('radio', 'Wann ist eine E-Mail-Adresse für Werbung nutzbar?', ['Immer, wenn sie öffentlich ist', 'Nur mit gültiger Einwilligung', 'Wenn man den Namen kennt'], { key: 'q5', required: true, points: { 'Nur mit gültiger Einwilligung': 1 } }),
      t('heading', 'Wohin dürfen wir deine Auswertung schicken?', { key: 'ueb' }),
      first(),
      email(),
      consent(),
    ],
  },
  {
    id: 'angebot-handwerk',
    name: 'Angebotsanfrage Handwerk',
    category: 'Handwerk & Dienstleistung',
    description: 'Gewerk, Objekt, Zeitraum und Fotos – damit du ein Angebot machen kannst, ohne dreimal nachzufragen.',
    kind: 'form',
    mode: 'typeform',
    settings: { title: 'Angebot anfragen', thank_you: 'Danke für deine Anfrage! Du bekommst in der Regel innerhalb von zwei Werktagen ein Angebot.', theme: { preset: 'warm' }, auto_advance: true, tags: ['anfrage:handwerk'] },
    drafts: [
      choice('radio', 'Welches Gewerk brauchst du?', ['Malerarbeiten', 'Elektro', 'Sanitär und Heizung', 'Tischler', 'Garten und Landschaft', 'Sonstiges'], { name: 'gewerk', key: 'gewerk', required: true }),
      choice('radio', 'Um was für ein Objekt geht es?', ['Wohnung', 'Einfamilienhaus', 'Mehrfamilienhaus', 'Gewerbe'], { name: 'objekt', key: 'objekt', required: true }),
      t('textarea', 'Beschreibe kurz, was gemacht werden soll', { name: 'beschreibung', key: 'beschreibung', required: true, placeholder: 'z. B. Wohnzimmer und Flur streichen, Decken sind weiß' }),
      t('file', 'Hast du Fotos? Das hilft uns sehr.', { name: 'fotos', key: 'fotos' }),
      choice('radio', 'Wann soll es losgehen?', ['So schnell wie möglich', 'In 1 bis 2 Monaten', 'Später im Jahr', 'Ich plane erst'], { name: 'zeitraum', key: 'zeitraum', required: true }),
      text('Postleitzahl des Objekts', { name: 'plz', key: 'plz', required: true }),
      t('heading', 'Wohin schicken wir das Angebot?', { key: 'ueb' }),
      ...contact(true, true),
    ],
  },
  {
    id: 'coaching-erstgespraech',
    name: 'Coaching-Erstgespräch',
    category: 'Coaching',
    description: 'Ziele, Dringlichkeit und Verfügbarkeit – so ist das Erstgespräch gut vorbereitet.',
    kind: 'form',
    mode: 'typeform',
    settings: { title: 'Erstgespräch vereinbaren', thank_you: 'Danke! Ich melde mich innerhalb von 24 Stunden mit Terminvorschlägen.', theme: { preset: 'pastell' }, welcome: { title: 'Schön, dass du da bist', text: 'Erzähl mir kurz, wo du stehst – dann nutzen wir unser Gespräch richtig gut.', button: 'Weiter' }, tags: ['coaching:erstgespraech'] },
    drafts: [
      t('textarea', 'Was ist dein wichtigstes Ziel für die nächsten 6 Monate?', { name: 'ziel', key: 'ziel', required: true }),
      t('textarea', 'Was hält dich bisher davon ab?', { name: 'hindernis', key: 'hindernis' }),
      t('scale', 'Wie dringend ist dir das?', { name: 'dringlichkeit', key: 'dringlichkeit', required: true, min: 1, max: 10, labels: ['nicht eilig', 'sehr dringend'] }),
      choice('radio', 'Wie viel Zeit kannst du pro Woche einplanen?', ['Bis 1 Stunde', '1 bis 3 Stunden', 'Mehr als 3 Stunden'], { name: 'zeit', key: 'zeit', required: true }),
      t('date_range', 'In welchem Zeitraum passt dir ein Gespräch?', { name: 'zeitraum', key: 'zeitraum', required: true }),
      ...contact(true, false),
    ],
  },
  {
    id: 'newsletter',
    name: 'Newsletter-Anmeldung',
    category: 'Marketing',
    description: 'Kurz und klar: E-Mail, Vorname und eine echte Einwilligung.',
    kind: 'form',
    mode: 'classic',
    settings: { title: 'Bleib auf dem Laufenden', thank_you: 'Fast geschafft – bitte bestätige deine Anmeldung in der E-Mail, die wir dir gerade geschickt haben.', submit_text: 'Anmelden', theme: { preset: 'minimal' }, tags: ['newsletter'], consent: { marketing: true, field: 'consent', purposes: ['newsletter'], channels: [], doi: 'inherit' } },
    drafts: [first(), email(), consent('Ja, ich möchte den Newsletter erhalten und kann mich jederzeit abmelden.')],
  },
  {
    id: 'terminanfrage',
    name: 'Terminanfrage',
    category: 'Handwerk & Dienstleistung',
    description: 'Wunschzeitraum und Uhrzeit – du bestätigst den Termin per Telefon oder E-Mail.',
    kind: 'form',
    mode: 'classic',
    settings: { title: 'Termin anfragen', thank_you: 'Danke! Wir bestätigen deinen Wunschtermin so schnell wie möglich.', submit_text: 'Termin anfragen', theme: { preset: 'ozean' } },
    drafts: [
      choice('select', 'Worum geht es?', ['Beratung', 'Behandlung / Leistung', 'Rückfrage zu einem Auftrag', 'Sonstiges'], { name: 'anliegen', key: 'anliegen', required: true }),
      t('date_range', 'Wann passt es dir? (Zeitraum)', { name: 'wunschzeitraum', key: 'zeitraum', required: true }),
      choice('radio', 'Tageszeit', ['Vormittags', 'Mittags', 'Nachmittags', 'Abends'], { name: 'tageszeit', key: 'tageszeit' }),
      ...contact(true, true),
    ],
  },
  {
    id: 'csat',
    name: 'Kundenzufriedenheit (Sterne)',
    category: 'Umfragen',
    description: 'Sterne für Service und Produkt, eine Weiterempfehlungsfrage und Platz für Lob und Kritik.',
    kind: 'survey',
    mode: 'typeform',
    settings: { title: 'Wie war dein Erlebnis?', thank_you: 'Danke – dein Feedback hilft uns!', theme: { preset: 'warm' }, auto_advance: true },
    drafts: [
      t('rating', 'Wie zufrieden bist du insgesamt?', { name: 'gesamt', key: 'gesamt', required: true }),
      t('rating', 'Wie bewertest du unseren Service?', { name: 'service', key: 'service', required: true }),
      t('rating', 'Wie bewertest du das Produkt?', { name: 'produkt', key: 'produkt' }),
      t('textarea', 'Was können wir besser machen?', { name: 'besser', key: 'besser', show_if: { field: '@gesamt', op: 'lte', value: '3' } }),
      t('textarea', 'Was hat dir gefallen?', { name: 'gefallen', key: 'gefallen', show_if: { field: '@gesamt', op: 'gte', value: '4' } }),
    ],
  },
  {
    id: 'mitarbeiterbefragung',
    name: 'Mitarbeiterbefragung',
    category: 'Personal',
    description: 'Anonyme Befragung mit Skalen: Zufriedenheit, Zusammenarbeit, Führung und ein freies Feld.',
    kind: 'survey',
    mode: 'classic',
    settings: { title: 'Wie geht es dir im Team?', description: 'Die Umfrage ist anonym. Wir speichern keine Namen.', thank_you: 'Danke für deine Offenheit!', submit_text: 'Abschicken', theme: { preset: 'wald' }, notify_team: false },
    drafts: [
      t('scale', 'Ich arbeite gern bei uns.', { name: 'zufriedenheit', key: 'a', required: true, min: 1, max: 5, labels: ['stimme nicht zu', 'stimme voll zu'] }),
      t('scale', 'Die Zusammenarbeit im Team funktioniert gut.', { name: 'team', key: 'b', required: true, min: 1, max: 5, labels: ['stimme nicht zu', 'stimme voll zu'] }),
      t('scale', 'Ich bekomme das Feedback, das ich brauche.', { name: 'feedback', key: 'c', required: true, min: 1, max: 5, labels: ['stimme nicht zu', 'stimme voll zu'] }),
      t('scale', 'Meine Arbeitsbelastung ist angemessen.', { name: 'belastung', key: 'd', required: true, min: 1, max: 5, labels: ['stimme nicht zu', 'stimme voll zu'] }),
      t('ranking', 'Was wäre dir wichtiger? Bringe in eine Reihenfolge.', { name: 'prioritaeten', key: 'prio', options: ['Mehr Gehalt', 'Flexiblere Arbeitszeiten', 'Weiterbildung', 'Bessere Ausstattung', 'Mehr Teamevents'] }),
      t('textarea', 'Was sollten wir unbedingt ändern – oder beibehalten?', { name: 'freitext', key: 'frei' }),
    ],
  },
  {
    id: 'produkt-feedback',
    name: 'Produkt-Feedback',
    category: 'Umfragen',
    description: 'Sterne, eine Rangfolge der Funktionen und die offene Frage nach dem, was fehlt.',
    kind: 'survey',
    mode: 'typeform',
    settings: { title: 'Dein Feedback zum Produkt', thank_you: 'Danke! Wir lesen jedes Feedback.', theme: { preset: 'dunkel' } },
    drafts: [
      t('rating', 'Wie gut gefällt dir das Produkt?', { name: 'sterne', key: 'sterne', required: true, max: 5 }),
      t('ranking', 'Welche Funktionen sind dir am wichtigsten?', { name: 'funktionen', key: 'fk', required: true, options: ['Einfache Bedienung', 'Geschwindigkeit', 'Auswertungen', 'Schnittstellen', 'Support'] }),
      t('textarea', 'Was fehlt dir noch?', { name: 'fehlt', key: 'fehlt' }),
      t('email', 'Deine E-Mail (nur wenn wir nachfragen dürfen)', { name: 'email', key: 'email' }),
    ],
  },
  {
    id: 'webinar-anmeldung',
    name: 'Webinar-Anmeldung',
    category: 'Events',
    description: 'Name, E-Mail und die Themen, die dich am meisten interessieren.',
    kind: 'form',
    mode: 'classic',
    settings: { title: 'Kostenlos zum Webinar anmelden', thank_you: 'Du bist angemeldet! Der Link kommt per E-Mail.', submit_text: 'Platz sichern', theme: { preset: 'ozean' }, tags: ['webinar:angemeldet'] },
    drafts: [first(), email(), choice('checkbox', 'Was interessiert dich besonders?', ['Grundlagen', 'Praxisbeispiele', 'Werkzeuge', 'Fragen und Antworten'], { name: 'themen', key: 'themen' }), consent()],
  },
  {
    id: 'reklamation',
    name: 'Reklamation und Support-Anfrage',
    category: 'Support',
    description: 'Bestellnummer, Problem, Foto und Dringlichkeit – alles, was der Support zum Start braucht.',
    kind: 'form',
    mode: 'classic',
    settings: { title: 'Wobei können wir helfen?', thank_you: 'Danke, wir kümmern uns darum und melden uns schnellstmöglich.', submit_text: 'Anfrage senden', theme: { preset: 'standard' }, tags: ['support:anfrage'] },
    drafts: [
      text('Bestell- oder Rechnungsnummer', { name: 'bestellnummer', key: 'nr' }),
      choice('select', 'Was ist passiert?', ['Ware beschädigt', 'Falsche Lieferung', 'Funktioniert nicht', 'Rechnung stimmt nicht', 'Sonstiges'], { name: 'problem', key: 'problem', required: true }),
      t('textarea', 'Beschreibe das Problem', { name: 'beschreibung', key: 'beschreibung', required: true }),
      t('file', 'Foto oder Screenshot', { name: 'foto', key: 'foto' }),
      choice('radio', 'Wie dringend ist es?', ['Hat Zeit', 'Bitte bald', 'Dringend'], { name: 'dringlichkeit', key: 'dringlich', required: true }),
      ...contact(true, false),
    ],
  },
  {
    id: 'preisrechner-maler',
    name: 'Preisrechner Malerarbeiten',
    category: 'Handwerk & Dienstleistung',
    description: 'Ein Rechner, der den Richtpreis live ausrechnet (Fläche, Fenster, Decke) – danach hinterlässt der Kunde seine Daten.',
    kind: 'form',
    mode: 'typeform',
    settings: { title: 'Dein Richtpreis in 1 Minute', thank_you: 'Danke! Wir melden uns mit einem genauen Angebot.', theme: { preset: 'warm' }, auto_advance: true, tags: ['rechner:maler'] },
    drafts: [
      t('number', 'Wie groß ist die Fläche in Quadratmetern (Wände)?', { name: 'flaeche', key: 'flaeche', required: true, min: 1, max: 2000, placeholder: 'z. B. 85' }),
      t('number', 'Wie viele Fenster und Türen müssen lackiert werden?', { name: 'fenster', key: 'fenster', min: 0, max: 100, value: '0' }),
      choice('radio', 'Sollen die Decken mitgestrichen werden?', ['Ja', 'Nein'], { name: 'decke', key: 'decke', required: true, points: { Ja: 5, Nein: 0 } }),
      t('calculator', 'Dein Richtpreis (netto, ohne Gewähr)', { name: 'richtpreis', key: 'richtpreis', formula: 'flaeche * (12 + decke) + fenster * 25', format: 'currency', hint: 'Wandfläche 12 € pro m², Decke +5 € pro m², Fenster und Türen je 25 €.' }),
      t('heading', 'Möchtest du ein genaues Angebot?', { key: 'ueb' }),
      ...contact(true, false),
    ],
  },
  {
    id: 'immobilien-anfrage',
    name: 'Immobilien-Anfrage',
    category: 'Vertrieb',
    description: 'Kaufen oder mieten? Je nach Antwort stellt das Formular andere Fragen.',
    kind: 'form',
    mode: 'typeform',
    settings: { title: 'Deine Traumimmobilie', thank_you: 'Danke! Wir suchen passende Objekte für dich und melden uns.', theme: { preset: 'ozean' }, auto_advance: true, tags: ['immobilie:suche'] },
    drafts: [
      choice('radio', 'Möchtest du kaufen oder mieten?', ['Kaufen', 'Mieten'], {
        name: 'art',
        key: 'art',
        required: true,
        jumps: [{ op: 'eq', value: 'Mieten', goto: '@miete' }],
      }),
      choice('radio', 'Wie hoch ist dein Kaufpreisrahmen?', ['Bis 250.000 €', '250.000 bis 500.000 €', 'Mehr als 500.000 €'], { name: 'kaufpreis', key: 'kauf', required: true, jumps: [{ op: 'filled', goto: '@zimmer' }] }),
      choice('radio', 'Wie hoch ist deine Kaltmiete pro Monat?', ['Bis 800 €', '800 bis 1.500 €', 'Mehr als 1.500 €'], { name: 'miete', key: 'miete', required: true }),
      t('scale', 'Wie viele Zimmer brauchst du mindestens?', { name: 'zimmer', key: 'zimmer', required: true, min: 1, max: 8, labels: ['1', '8'] }),
      text('In welchem Ort oder Stadtteil suchst du?', { name: 'ort', key: 'ort', required: true }),
      ...contact(true, false),
    ],
  },
  {
    id: 'kursanmeldung',
    name: 'Kursanmeldung',
    category: 'Events',
    description: 'Kurs und Termin wählen, Rechnungsdaten angeben, AGB bestätigen.',
    kind: 'form',
    mode: 'classic',
    settings: { title: 'Zum Kurs anmelden', thank_you: 'Danke für deine Anmeldung! Du bekommst eine Bestätigung per E-Mail.', submit_text: 'Verbindlich anmelden', theme: { preset: 'wald' }, tags: ['kurs:angemeldet'] },
    drafts: [
      t('heading', 'Dein Kurs', { key: 'h1' }),
      choice('select', 'Kurs', ['Grundkurs', 'Aufbaukurs', 'Intensivwochenende'], { name: 'kurs', key: 'kurs', required: true }),
      choice('radio', 'Termin', ['Montagabend', 'Samstagvormittag', 'Online-Live'], { name: 'termin', key: 'termin', required: true }),
      t('heading', 'Deine Daten', { key: 'h2' }),
      first(),
      last(),
      email(),
      text('Rechnungsadresse (Straße, PLZ, Ort)', { name: 'address', key: 'adresse', required: true }),
      consent('Ich habe die Allgemeinen Geschäftsbedingungen gelesen und akzeptiere sie.'),
    ],
  },
  {
    id: 'bestellung-zahlung',
    name: 'Bestellung mit Zahlung',
    category: 'Shop',
    description: 'Kontaktdaten erfassen und gleich bezahlen lassen (Zahlung über Stripe, Produkt aus deinen Produkten).',
    kind: 'form',
    mode: 'typeform',
    needs_product: true,
    settings: { title: 'Jetzt bestellen', thank_you: 'Danke für deine Bestellung!', theme: { preset: 'standard' }, tags: ['bestellung:formular'] },
    drafts: [
      first(),
      last(),
      email(),
      text('Lieferadresse (Straße, PLZ, Ort)', { name: 'address', key: 'adresse', required: true }),
      t('textarea', 'Anmerkung zur Bestellung', { name: 'anmerkung', key: 'anmerkung' }),
      consent('Ich habe die AGB und die Widerrufsbelehrung gelesen und akzeptiere sie.'),
      t('payment', 'Bezahlung', { name: 'zahlung', key: 'zahlung', product_id: '' }),
    ],
  },
  {
    id: 'gewinnspiel',
    name: 'Gewinnspiel',
    category: 'Marketing',
    description: 'Teilnahme mit Gewinnfrage, Teilnahmebedingungen und optionaler Newsletter-Einwilligung.',
    kind: 'form',
    mode: 'classic',
    settings: { title: 'Mach mit und gewinne', thank_you: 'Du bist dabei – wir drücken die Daumen!', submit_text: 'Teilnehmen', theme: { preset: 'knallig' }, tags: ['gewinnspiel'] },
    drafts: [
      first(),
      last(),
      email(),
      t('text', 'Gewinnfrage: Wie heißt die Hauptstadt von Deutschland?', { name: 'antwort', key: 'antwort', required: true }),
      t('consent', 'Ich akzeptiere die Teilnahmebedingungen.', { name: 'consent', key: 'consent', required: true }),
      t('checkbox', 'Ja, ich möchte künftig Neuigkeiten per E-Mail erhalten (jederzeit widerrufbar).', { name: 'newsletter', key: 'newsletter' }),
    ],
  },
  {
    id: 'umzug-angebot',
    name: 'Umzugs-Angebot',
    category: 'Handwerk & Dienstleistung',
    description: 'Von wo nach wo, wie viel Wohnfläche, welche Etage – mit Richtpreis zum Mitrechnen.',
    kind: 'form',
    mode: 'typeform',
    settings: { title: 'Umzug planen', thank_you: 'Danke! Du bekommst ein verbindliches Angebot per E-Mail.', theme: { preset: 'ozean' }, auto_advance: true, tags: ['anfrage:umzug'] },
    drafts: [
      text('Von welcher Postleitzahl ziehst du um?', { name: 'plz_von', key: 'von', required: true }),
      text('Und nach welcher Postleitzahl?', { name: 'plz_nach', key: 'nach', required: true }),
      t('date', 'Wann soll der Umzug stattfinden?', { name: 'datum', key: 'datum' }),
      t('number', 'Wie viele Quadratmeter Wohnfläche hast du?', { name: 'flaeche', key: 'flaeche', required: true, min: 10, max: 500 }),
      choice('radio', 'In welcher Etage wohnst du (ohne Aufzug)?', ['Erdgeschoss', '1. bis 2. Etage', '3. Etage oder höher'], { name: 'etage', key: 'etage', required: true, points: pts(['Erdgeschoss', '1. bis 2. Etage', '3. Etage oder höher'], [0, 3, 6]) }),
      choice('checkbox', 'Brauchst du zusätzliche Leistungen?', ['Verpackungsservice', 'Möbelmontage', 'Halteverbotszone', 'Einlagerung'], { name: 'extras', key: 'extras', points: pts(['Verpackungsservice', 'Möbelmontage', 'Halteverbotszone', 'Einlagerung'], [250, 150, 90, 120]) }),
      t('calculator', 'Richtpreis (netto, unverbindlich)', { name: 'richtpreis', key: 'richtpreis', formula: '350 + flaeche * 6 + etage * flaeche * 0.4 + extras', format: 'currency' }),
      ...contact(true, true),
    ],
  },
  {
    id: 'reservierung',
    name: 'Restaurant-Reservierung',
    category: 'Handwerk & Dienstleistung',
    description: 'Datum, Uhrzeit, Personenzahl und Anlass – die Reservierung für Gastronomie.',
    kind: 'form',
    mode: 'classic',
    settings: { title: 'Tisch reservieren', thank_you: 'Danke! Wir bestätigen deine Reservierung per E-Mail oder Anruf.', submit_text: 'Reservieren', theme: { preset: 'elegant' } },
    drafts: [
      t('date', 'Datum', { name: 'datum', key: 'datum', required: true }),
      choice('select', 'Uhrzeit', ['12:00', '12:30', '13:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30'], { name: 'uhrzeit', key: 'uhrzeit', required: true }),
      t('number', 'Anzahl Personen', { name: 'personen', key: 'personen', required: true, min: 1, max: 20, value: '2' }),
      choice('select', 'Anlass', ['Kein besonderer Anlass', 'Geburtstag', 'Jubiläum', 'Geschäftsessen', 'Sonstiges'], { name: 'anlass', key: 'anlass' }),
      first(),
      phone(true),
      email(),
      consent(),
    ],
  },
  {
    id: 'probetraining',
    name: 'Fitness-Probetraining',
    category: 'Handwerk & Dienstleistung',
    description: 'Ziel, Erfahrung auf einem Schieberegler und der Wunschzeitraum für das kostenlose Probetraining.',
    kind: 'form',
    mode: 'typeform',
    settings: { title: 'Kostenloses Probetraining', thank_you: 'Danke! Wir melden uns und planen dein Probetraining.', theme: { preset: 'knallig' }, auto_advance: true, tags: ['probetraining'] },
    drafts: [
      choice('radio', 'Was ist dein Ziel?', ['Abnehmen', 'Muskeln aufbauen', 'Fitter werden', 'Rücken und Beweglichkeit', 'Ausgleich zum Alltag'], { name: 'ziel', key: 'ziel', required: true }),
      t('scale', 'Wie viel Trainingserfahrung hast du?', { name: 'erfahrung', key: 'erfahrung', required: true, min: 1, max: 10, style: 'slider', labels: ['Anfänger', 'Profi'] }),
      t('date_range', 'In welchem Zeitraum kannst du zum Probetraining kommen?', { name: 'zeitraum', key: 'zeitraum', required: true }),
      ...contact(true, true),
    ],
  },
  {
    id: 'steuerberater-erstgespraech',
    name: 'Steuerberater-Erstgespräch',
    category: 'Handwerk & Dienstleistung',
    description: 'Rechtsform, Umsatz, Anliegen und bester Rückruf-Zeitpunkt für das Erstgespräch.',
    kind: 'form',
    mode: 'classic',
    settings: { title: 'Erstgespräch anfragen', thank_you: 'Danke! Wir rufen dich zum gewünschten Zeitpunkt an.', submit_text: 'Rückruf anfragen', theme: { preset: 'minimal' }, tags: ['anfrage:steuerberatung'] },
    drafts: [
      choice('select', 'Wie ist dein Unternehmen organisiert?', ['Einzelunternehmen / Freiberuf', 'GbR', 'GmbH / UG', 'Verein', 'Ich gründe erst'], { name: 'rechtsform', key: 'rechtsform', required: true }),
      choice('select', 'Wie hoch ist dein Jahresumsatz?', ['Bis 25.000 €', '25.000 bis 100.000 €', '100.000 bis 500.000 €', 'Mehr als 500.000 €'], { name: 'umsatz', key: 'umsatz' }),
      choice('checkbox', 'Wobei brauchst du Unterstützung?', ['Buchhaltung', 'Jahresabschluss', 'Steuererklärung', 'Lohnabrechnung', 'Beratung zur Gründung'], { name: 'anliegen', key: 'anliegen', required: true }),
      choice('radio', 'Wann dürfen wir dich anrufen?', ['Vormittags', 'Nachmittags', 'Abends'], { name: 'rueckruf', key: 'rueckruf' }),
      ...contact(true, true),
    ],
  },
  {
    id: 'fotoshooting',
    name: 'Fotoshooting-Anfrage',
    category: 'Handwerk & Dienstleistung',
    description: 'Bildauswahl für den Stil (Bilder einfach im Editor hinzufügen), Anlass, Wunschzeitraum und Kontakt.',
    kind: 'form',
    mode: 'typeform',
    settings: { title: 'Dein Fotoshooting', thank_you: 'Danke! Ich melde mich mit Ideen und einem Angebot.', theme: { preset: 'elegant' }, auto_advance: true, tags: ['anfrage:foto'] },
    drafts: [
      t('picture_choice', 'Welcher Stil gefällt dir am besten?', { name: 'stil', key: 'stil', required: true, options: ['Natürlich und hell', 'Dunkel und dramatisch', 'Verspielt und bunt', 'Schwarz-Weiß'], images: ['', '', '', ''] }),
      choice('radio', 'Wofür brauchst du die Fotos?', ['Bewerbung / Business', 'Familie und Paare', 'Hochzeit', 'Produkte', 'Sonstiges'], { name: 'anlass', key: 'anlass', required: true }),
      t('date_range', 'In welchem Zeitraum soll das Shooting stattfinden?', { name: 'zeitraum', key: 'zeitraum' }),
      t('textarea', 'Gibt es etwas, das uns wichtig sein sollte?', { name: 'wunsch', key: 'wunsch' }),
      ...contact(true, false),
    ],
  },
  {
    id: 'vertrag-unterschrift',
    name: 'Einverständnis mit Unterschrift',
    category: 'Allgemein',
    description: 'Eine Einverständniserklärung, die per Finger oder Maus unterschrieben wird (zum Beispiel Foto- oder Teilnahmeerlaubnis).',
    kind: 'form',
    mode: 'classic',
    settings: { title: 'Einverständniserklärung', description: 'Bitte lies die Erklärung und unterschreibe unten.', thank_you: 'Danke! Deine unterschriebene Erklärung ist bei uns angekommen.', submit_text: 'Unterschrieben absenden', theme: { preset: 'minimal' } },
    drafts: [
      first(),
      last(),
      email(),
      t('heading', 'Ich bin damit einverstanden, dass Fotos und Videos, auf denen ich zu sehen bin, für die Öffentlichkeitsarbeit verwendet werden dürfen.', { key: 'text' }),
      t('date', 'Datum', { name: 'datum', key: 'datum', required: true }),
      t('signature', 'Unterschrift', { name: 'unterschrift', key: 'unterschrift', required: true }),
      consent(),
    ],
  },
];

export const TEMPLATES: Template[] = defs.map(({ drafts, ...rest }) => ({ ...rest, fields: build(drafts) }));

export const templateById = (id: string) => TEMPLATES.find((x) => x.id === id);
export const TEMPLATE_CATEGORIES = [...new Set(TEMPLATES.map((x) => x.category))];

/** A short list for the gallery (no fields). */
export const templateCard = (x: Template) => ({ id: x.id, name: x.name, category: x.category, description: x.description, kind: x.kind, mode: x.mode, needs_product: !!x.needs_product, fields: x.fields.filter((f) => !['heading', 'page_break', 'hidden'].includes(f.type)).length, features: featuresOf(x) });

function featuresOf(x: Template): string[] {
  const out: string[] = [];
  if (x.mode === 'typeform') out.push('Eine Frage nach der anderen');
  if (x.fields.some((f) => f.jumps?.length)) out.push('Sprünge');
  if (x.settings.endings?.length || x.fields.some((f) => f.points)) out.push('Punkte & Auswertung');
  if (x.fields.some((f) => f.type === 'calculator')) out.push('Rechner');
  if (x.fields.some((f) => f.type === 'payment')) out.push('Zahlung');
  if (x.fields.some((f) => f.type === 'file')) out.push('Datei-Upload');
  if (x.fields.some((f) => f.type === 'signature')) out.push('Unterschrift');
  return out;
}
