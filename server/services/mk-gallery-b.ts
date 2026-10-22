import { action, bullets, brand, cards, copy, couponBlock, facts, figureBlock, foot, hero, letter, panel, social, stats, steps, tpl, type GalleryTemplate } from './mk-gallery-kit.js';

/** Template gallery, part 2: Event, Webinar, Kurs, Rechnung & Zahlung, Feiertage. */

export const EVENT: GalleryTemplate[] = [
  tpl(
    { key: 'event-einladung', name: 'Einladung zu einer Veranstaltung', category: 'event', description: 'Wann, wo und Anmelde-Button in zwei Spalten – für Feste, Messen, Workshops', subject: 'Einladung: {{location.name}} lädt dich ein', preheader: 'Sei dabei – wir freuen uns auf dich.', theme: 'gold', tags: 'einladung veranstaltung fest messe workshop anmeldung' },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', kicker: 'Du bist eingeladen', title: 'Unser Sommerfest', text: 'Hallo {{contact.first_name|du}}, wir feiern – und du gehörst dazu. Gute Gespräche, Musik und etwas Leckeres zu essen.', padY: 48 }),
      facts(t, [['Wann', 'Samstag, 12. Juli\n16:00 – 22:00 Uhr'], ['Wo', '{{location.name}}\n{{location.address|Adresse folgt}}']], { tone: 'soft' }),
      action(t, 'Jetzt anmelden', 'https://example.com/anmeldung', { note: 'Bitte gib uns bis zum 1. Juli Bescheid.' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'event-erinnerung', name: 'Erinnerung: morgen ist es soweit', category: 'event', description: 'Kurze Erinnerung am Vortag mit Uhrzeit, Ort und Anreisehinweis', subject: 'Morgen geht es los – alle Infos auf einen Blick', preheader: 'Uhrzeit, Ort und was du mitbringen solltest.', theme: 'ocean', tags: 'erinnerung vortag termin morgen reminder' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', kicker: 'Morgen', title: 'Wir sehen uns!', text: 'Hallo {{contact.first_name|du}}, nur noch eine Nacht schlafen. Hier ist alles, was du wissen musst.', padY: 34 }),
      facts(t, [['Beginn', 'Morgen, 10:00 Uhr\nEinlass ab 9:30 Uhr'], ['Ort', '{{location.name}}\n{{location.address|Adresse folgt}}']], { tone: 'plain' }),
      bullets(t, ['Bitte bring einen Ausweis mit', 'Parkplätze findest du direkt am Haus', 'Bei Fragen erreichst du uns telefonisch'], { title: 'Gut zu wissen', mark: '•' }),
      action(t, 'Anfahrt ansehen', 'https://example.com/anfahrt'),
      foot(t),
    ],
  ),
  tpl(
    { key: 'event-danke', name: 'Danke fürs Kommen', category: 'event', description: 'Nach der Veranstaltung: Dank, Unterlagen zum Download und nächster Schritt', subject: 'Danke, dass du dabei warst', preheader: 'Die Unterlagen und ein paar Fotos zum Nachlesen.', theme: 'teal', tags: 'danke nachbereitung unterlagen download fotos nachfass' },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', title: 'Danke, dass du dabei warst', text: 'Hallo {{contact.first_name|du}}, es war ein schöner Tag mit euch. Hier ist, was du jetzt noch mitnehmen kannst.', padY: 40 }),
      steps(t, [['Unterlagen herunterladen', 'Alle Folien und Checklisten in einem Paket. [Zum Download](https://example.com/unterlagen)'], ['Fotos ansehen', 'Die schönsten Momente des Tages. [Zur Galerie](https://example.com/fotos)'], ['Feedback geben', 'Zwei Minuten helfen uns, besser zu werden. [Zur Umfrage](https://example.com/umfrage)']], { title: 'Das kannst du jetzt tun' }),
      letter(t, 'Bis zum nächsten Mal\n{{location.name}}'),
      foot(t),
    ],
  ),
  tpl(
    { key: 'event-offene-tuer', name: 'Tag der offenen Tür', category: 'event', description: 'Einladung mit Programm in Uhrzeiten – für Praxen, Betriebe, Vereine', subject: 'Tag der offenen Tür bei {{location.name}}', preheader: 'Führungen, Gespräche und Kaffee – komm vorbei.', theme: 'forest', tags: 'offene tür programm führung verein praxis betrieb' },
    (t) => [
      brand(t),
      hero(t, { tone: 'accent', kicker: 'Samstag, 21. September', title: 'Tag der offenen Tür', text: 'Schau dir an, wie wir arbeiten, und sprich direkt mit unserem Team.', padY: 40 }),
      steps(t, [['10:00 Uhr · Begrüßung', 'Kaffee, Tee und ein erster Rundgang.'], ['11:30 Uhr · Führung', 'Hinter den Kulissen – mit Zeit für Fragen.'], ['14:00 Uhr · Mitmachen', 'Ausprobieren erlaubt, für Groß und Klein.']], { title: 'Das Programm' }),
      facts(t, [['Eintritt', 'Frei'], ['Anmeldung', 'Nicht nötig']], { tone: 'soft' }),
      action(t, 'So findest du uns', 'https://example.com/anfahrt'),
      foot(t),
    ],
  ),
];

export const WEBINAR: GalleryTemplate[] = [
  tpl(
    { key: 'webinar-einladung', name: 'Webinar-Einladung', category: 'webinar', description: 'Thema, Termin und drei Lernpunkte – mit Anmelde-Button', subject: 'Kostenloses Webinar: {{location.name}} zeigt dir, wie es geht', preheader: 'Live am Donnerstag, 18 Uhr – inklusive Fragerunde.', theme: 'violet', tags: 'webinar einladung online live anmeldung seminar' },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', kicker: 'Kostenloses Live-Webinar', title: 'In 60 Minuten zu deinem ersten Ergebnis', text: 'Hallo {{contact.first_name|du}}, wir zeigen dir Schritt für Schritt, wie du anfängst – mit Zeit für deine Fragen.', button: ['Platz sichern', 'https://example.com/webinar'], padY: 48 }),
      facts(t, [['Wann', 'Donnerstag, 18:00 Uhr'], ['Wo', 'Online – der Link kommt per E-Mail']], { tone: 'soft' }),
      bullets(t, ['Die drei häufigsten Fehler – und wie du sie vermeidest', 'Eine Vorlage, die du sofort nutzen kannst', 'Deine Fragen live beantwortet'], { title: 'Das nimmst du mit', mark: '✓' }),
      action(t, 'Jetzt kostenlos anmelden', 'https://example.com/webinar', { note: 'Du bekommst auch die Aufzeichnung, falls du nicht live dabei sein kannst.' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'webinar-erinnerung', name: 'Webinar startet gleich', category: 'webinar', description: 'Eine Stunde vorher: Zugangslink an erster Stelle, dazu eine Mini-Checkliste', subject: 'In einer Stunde geht es los – hier ist dein Link', preheader: 'Dein persönlicher Zugang zum Webinar.', theme: 'ocean', tags: 'webinar erinnerung link zugang start eine stunde' },
    (t) => [
      brand(t),
      hero(t, { tone: 'accent', kicker: 'Gleich geht es los', title: 'Dein Webinar startet in einer Stunde', text: 'Hallo {{contact.first_name|du}}, klick einfach auf den Button, wenn es soweit ist.', button: ['Zum Webinar-Raum', 'https://example.com/webinar/raum'], padY: 44 }),
      bullets(t, ['Kopfhörer bereitlegen', 'Stift und Papier für Notizen', 'Fragen vorab per Antwort auf diese E-Mail schicken'], { title: 'Kurz vorbereiten', mark: '☐' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'webinar-aufzeichnung', name: 'Aufzeichnung verfügbar', category: 'webinar', description: 'Für alle, die nicht live dabei sein konnten – Link zur Aufzeichnung und Folien', subject: 'Die Aufzeichnung ist da', preheader: 'Anschauen, wann es dir passt.', theme: 'teal', tags: 'webinar aufzeichnung replay video folien nachbereitung' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', title: 'Die Aufzeichnung ist da', text: 'Hallo {{contact.first_name|du}}, danke für dein Interesse. Du kannst dir das Webinar jetzt in Ruhe ansehen – so oft du magst.', button: ['Aufzeichnung ansehen', 'https://example.com/aufzeichnung'], padY: 40 }),
      steps(t, [['Aufzeichnung ansehen', 'Rund 55 Minuten – mit Kapiteln zum Springen.'], ['Folien herunterladen', 'Alle Inhalte als PDF zum Nachlesen. [Download](https://example.com/folien)'], ['Fragen stellen', 'Antworte einfach auf diese E-Mail.']], { title: 'So geht es weiter' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'webinar-nachfass', name: 'Nach dem Webinar: dein Angebot', category: 'webinar', description: 'Nachfass-Mail mit zeitlich begrenztem Angebot für Teilnehmende', subject: 'Danke fürs Zuschauen – dein Angebot', preheader: 'Nur für Webinar-Teilnehmende, nur bis Sonntag.', theme: 'ember', tags: 'webinar nachfass angebot teilnehmer verkauf sonderpreis' },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', kicker: 'Nur für Teilnehmende', title: 'Dein nächster Schritt', text: 'Hallo {{contact.first_name|du}}, im Webinar hast du gesehen, wie es geht. Wenn du es gemeinsam mit uns umsetzen möchtest, gibt es bis Sonntag ein besonderes Angebot.', button: ['Angebot ansehen', 'https://example.com/angebot'], padY: 44 }),
      panel(t, [figureBlock(t, 'soft', 'Webinar-Preis', '−25 %', 'Gültig bis Sonntag, 23:59 Uhr')], 'soft', 22),
      copy(t, 'Du bist unsicher, ob es zu dir passt? Schreib uns – wir sagen dir ehrlich, was wir empfehlen.', { align: 'center' }),
      foot(t),
    ],
  ),
];

export const KURS: GalleryTemplate[] = [
  tpl(
    { key: 'kurs-launch', name: 'Neuer Kurs startet', category: 'kurs', description: 'Kursstart-Ankündigung mit Inhalten, Termin und Anmeldung', subject: 'Neu: unser Kurs startet am 1. Oktober', preheader: 'Alle Inhalte, alle Termine, jetzt anmelden.', theme: 'violet', tags: 'kurs launch start onlinekurs training anmeldung' },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', kicker: 'Startet am 1. Oktober', title: 'Der Kurs, auf den du gewartet hast', text: 'Hallo {{contact.first_name|du}}, in sechs Wochen vom Wunsch zum fertigen Ergebnis – mit klarer Anleitung und persönlicher Begleitung.', button: ['Jetzt anmelden', 'https://example.com/kurs'], padY: 48 }),
      steps(t, [['Woche 1–2: Grundlagen', 'Du legst das Fundament und lernst die wichtigsten Werkzeuge.'], ['Woche 3–4: Umsetzen', 'Mit Vorlagen und Beispielen entsteht dein erstes Ergebnis.'], ['Woche 5–6: Feinschliff', 'Feedback, Verbesserungen und der Weg in die Praxis.']], { title: 'Das erwartet dich' }),
      stats(t, [['6', 'Wochen'], ['24', 'Lektionen'], ['1×', 'Live-Fragerunde pro Woche']]),
      action(t, 'Platz im Kurs sichern', 'https://example.com/kurs', { note: 'Begrenzte Teilnehmerzahl.' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'kurs-willkommen', name: 'Willkommen im Kurs', category: 'kurs', description: 'Zugangsdaten, erste Lektion und Hilfe – für Kursteilnehmende nach dem Kauf', subject: 'Willkommen im Kurs, {{contact.first_name|schön, dass du da bist}}', preheader: 'Hier ist dein Zugang und die erste Lektion.', theme: 'teal', tags: 'kurs willkommen zugang onlinekurs mitgliederbereich', service: true },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', kicker: 'Dein Zugang ist freigeschaltet', title: 'Willkommen im Kurs', text: 'Hallo {{contact.first_name|du}}, ab jetzt kannst du loslegen – in deinem Tempo, wann immer du Zeit hast.', button: ['Zum Kursbereich', 'https://example.com/kurs/start'], padY: 38 }),
      steps(t, [['Anmelden', 'Nutze die E-Mail-Adresse, mit der du bestellt hast.'], ['Erste Lektion ansehen', 'Sie dauert nur zehn Minuten.'], ['Fragen stellen', 'Im Kursbereich oder per Antwort auf diese E-Mail.']], { title: 'So startest du' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'kurs-weitermachen', name: 'Mach weiter: die nächste Lektion wartet', category: 'kurs', description: 'Sanfte Erinnerung für alle, die länger nicht im Kurs waren', subject: 'Du warst schon so weit gekommen', preheader: 'Die nächste Lektion dauert nur zehn Minuten.', theme: 'ocean', tags: 'kurs erinnerung weitermachen lektion abbruch motivation' },
    (t) => [
      brand(t),
      copy(t, 'Hallo {{contact.first_name|du}},\n\nim Alltag bleibt manches liegen – das ist völlig normal. Dein Kurs wartet genau da, wo du aufgehört hast, und die nächste Lektion dauert nur etwa zehn Minuten.', { title: 'Weitermachen lohnt sich', level: 1 }),
      action(t, 'Dort weitermachen, wo ich war', 'https://example.com/kurs/weiter'),
      copy(t, 'Wenn es gerade hakt: Antworte einfach auf diese E-Mail. Wir finden gemeinsam einen Weg.', { align: 'center' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'kurs-zertifikat', name: 'Glückwunsch zum Abschluss', category: 'kurs', description: 'Gratulation mit Zertifikat-Link und Einladung zum Folgekurs', subject: 'Geschafft! Dein Zertifikat ist da', preheader: 'Herzlichen Glückwunsch zum Abschluss.', theme: 'gold', tags: 'kurs abschluss zertifikat gratulation folgekurs', service: true },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', kicker: 'Kurs abgeschlossen', title: 'Herzlichen Glückwunsch, {{contact.first_name|du}}!', text: 'Du hast alle Lektionen geschafft. Dein Zertifikat wartet auf dich.', button: ['Zertifikat herunterladen', 'https://example.com/zertifikat'], padY: 48 }),
      copy(t, 'Wir sind stolz auf dich. Wenn du weitermachen möchtest: Im Aufbaukurs gehen wir tiefer ins Thema.', { title: 'Und jetzt?', align: 'center' }),
      action(t, 'Aufbaukurs ansehen', 'https://example.com/aufbaukurs'),
      foot(t),
    ],
  ),
];

export const RECHNUNG: GalleryTemplate[] = [
  tpl(
    { key: 'rechnung-neu', name: 'Ihre Rechnung', category: 'rechnung', description: 'Sachlicher Rechnungsversand mit Button zur Online-Ansicht (Sie-Form)', subject: 'Ihre Rechnung {{event.invoice.number|}}', preheader: 'Die Rechnung steht zum Abruf bereit.', theme: 'slate', formal: 'sie', service: true, tags: 'rechnung versand invoice zahlung abrechnung' },
    (t) => [
      brand(t, 'plain', 'left'),
      copy(t, 'Guten Tag {{contact.name|Damen und Herren}},\n\nvielen Dank für Ihren Auftrag. Ihre Rechnung {{event.invoice.number|}} steht für Sie bereit. Dort können Sie sie ansehen, als PDF herunterladen und – wenn eingerichtet – direkt online bezahlen.', { title: 'Ihre Rechnung ist da', level: 1 }),
      action(t, 'Rechnung ansehen', 'https://example.com/rechnung', { align: 'left' }),
      copy(t, 'Bei Fragen zur Rechnung antworten Sie einfach auf diese E-Mail.\n\nFreundliche Grüße\n{{location.name}}'),
      foot(t, 'Diese E-Mail betrifft Ihren Auftrag bei uns.'),
    ],
  ),
  tpl(
    { key: 'rechnung-erinnerung', name: 'Freundliche Zahlungserinnerung', category: 'rechnung', description: 'Höflicher Hinweis auf eine offene Rechnung – ohne Vorwurf, mit Button (Sie-Form)', subject: 'Kurze Erinnerung: Rechnung {{event.invoice.number|}}', preheader: 'Vielleicht ist sie untergegangen – kein Problem.', theme: 'ocean', formal: 'sie', service: true, tags: 'zahlungserinnerung erinnerung offen rechnung überfällig freundlich' },
    (t) => [
      brand(t, 'plain', 'left'),
      copy(t, 'Guten Tag {{contact.name|Damen und Herren}},\n\nbei der Durchsicht unserer Konten ist uns aufgefallen, dass die Rechnung {{event.invoice.number|}} noch offen ist. Das kann leicht passieren – vielleicht ist sie im Alltag untergegangen.\n\nSollten Sie bereits gezahlt haben, betrachten Sie diese Nachricht bitte als gegenstandslos. Andernfalls freuen wir uns über Ihre Überweisung in den nächsten Tagen.', { title: 'Eine kurze Erinnerung', level: 1 }),
      action(t, 'Rechnung ansehen und bezahlen', 'https://example.com/rechnung', { align: 'left' }),
      copy(t, 'Wenn etwas unklar ist, melden Sie sich gern direkt bei uns.\n\nFreundliche Grüße\n{{location.name}}'),
      foot(t, 'Diese E-Mail betrifft eine offene Rechnung bei uns.'),
    ],
  ),
  tpl(
    { key: 'rechnung-mahnung', name: '1. Mahnung', category: 'rechnung', description: 'Klare, sachliche Mahnung mit Frist und Hinweis auf Rückfragen (Sie-Form)', subject: 'Mahnung: Rechnung {{event.invoice.number|}} ist überfällig', preheader: 'Bitte begleichen Sie den offenen Betrag bis zur genannten Frist.', theme: 'ember', formal: 'sie', service: true, tags: 'mahnung überfällig frist mahnwesen zahlungsverzug' },
    (t) => [
      brand(t, 'plain', 'left'),
      copy(t, 'Guten Tag {{contact.name|Damen und Herren}},\n\nunsere Zahlungserinnerung zur Rechnung {{event.invoice.number|}} blieb bisher ohne Antwort; der Betrag ist weiterhin offen. Wir bitten Sie, ihn **innerhalb von sieben Tagen** zu überweisen.\n\nSollte sich Ihre Zahlung mit diesem Schreiben überschnitten haben, danken wir Ihnen und bitten, es als erledigt zu betrachten.', { title: 'Mahnung', level: 1 }),
      action(t, 'Rechnung ansehen', 'https://example.com/rechnung', { align: 'left' }),
      copy(t, 'Bei Rückfragen oder wenn Sie eine Ratenzahlung vereinbaren möchten, antworten Sie bitte auf diese E-Mail.\n\nMit freundlichen Grüßen\n{{location.name}}'),
      foot(t, 'Diese E-Mail betrifft eine offene Rechnung bei uns.'),
    ],
  ),
  tpl(
    { key: 'rechnung-bezahlt', name: 'Zahlung eingegangen', category: 'rechnung', description: 'Bestätigung des Zahlungseingangs mit kurzem Dank (Sie-Form)', subject: 'Zahlung eingegangen – vielen Dank', preheader: 'Ihre Zahlung ist bei uns angekommen.', theme: 'forest', formal: 'sie', service: true, tags: 'zahlung eingegangen bestätigung bezahlt danke quittung' },
    (t) => [
      brand(t, 'plain', 'left'),
      hero(t, { tone: 'soft', kicker: 'Zahlung eingegangen', title: 'Vielen Dank!', text: 'Guten Tag {{contact.name|Damen und Herren}}, Ihre Zahlung zur Rechnung {{event.invoice.number|}} ist bei uns eingegangen. Es ist nichts weiter zu tun.', align: 'left', padY: 32 }),
      copy(t, 'Wir freuen uns auf die weitere Zusammenarbeit.\n\nFreundliche Grüße\n{{location.name}}'),
      foot(t, 'Diese E-Mail betrifft Ihre Zahlung bei uns.'),
    ],
  ),
];

export const FEIERTAGE: GalleryTemplate[] = [
  tpl(
    { key: 'feiertag-weihnachten', name: 'Frohe Weihnachten', category: 'feiertage', description: 'Festlicher Gruß mit Dank und Hinweis auf die Betriebsferien', subject: 'Frohe Weihnachten von {{location.name}}', preheader: 'Danke für ein besonderes Jahr.', theme: 'festive', tags: 'weihnachten weihnachtsgruß advent jahresende betriebsferien dank' },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', kicker: 'Frohe Weihnachten', title: 'Danke für ein besonderes Jahr', text: 'Hallo {{contact.first_name|du}}, wir wünschen dir ruhige Tage, gutes Essen und Zeit für die Menschen, die dir wichtig sind.', padY: 52 }),
      copy(t, 'Unser Team macht vom 24. Dezember bis 1. Januar Betriebsferien. Ab dem 2. Januar sind wir wieder für dich da.', { align: 'center' }),
      letter(t, 'Frohe Festtage und einen guten Start ins neue Jahr\n{{location.name}}'),
      social(t),
      foot(t),
    ],
  ),
  tpl(
    { key: 'feiertag-neujahr', name: 'Frohes neues Jahr', category: 'feiertage', description: 'Neujahrsgruß mit Rückblick und Vorfreude auf das kommende Jahr', subject: 'Auf ein gutes neues Jahr', preheader: 'Danke für dein Vertrauen – und auf alles, was kommt.', theme: 'night', tags: 'neujahr silvester jahreswechsel ausblick rückblick' },
    (t) => [
      brand(t, 'plain'),
      hero(t, { tone: 'deep', kicker: 'Frohes neues Jahr', title: 'Auf alles, was kommt', text: 'Hallo {{contact.first_name|du}}, danke für dein Vertrauen im vergangenen Jahr. Wir freuen uns auf die nächsten zwölf Monate mit dir.', padY: 52 }),
      cards(t, [{ title: 'Das haben wir vor', text: 'Neue Angebote, kürzere Wege und ein paar Überraschungen. Du erfährst es zuerst.', link: ['Mehr erfahren', 'https://example.com/ausblick'] }], { tone: 'soft', cols: 2 }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'feiertag-ostern', name: 'Frohe Ostern', category: 'feiertage', description: 'Heiterer Frühlingsgruß mit kleinem Oster-Angebot', subject: 'Frohe Ostern!', preheader: 'Ein kleiner Gruß zum Fest.', theme: 'teal', tags: 'ostern frühling gruß osterangebot feiertag' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', kicker: 'Frohe Ostern', title: 'Schöne Feiertage, {{contact.first_name|du}}', text: 'Wir wünschen dir ein paar entspannte Tage mit Sonne, Familie und der ein oder anderen Überraschung im Nest.', padY: 44 }),
      panel(t, [couponBlock(t, 'plain', 'OSTERN10', 'Ein kleines Dankeschön: 10 % bis Ostermontag.')], 'plain', 14),
      action(t, 'Zur Oster-Aktion', 'https://example.com/ostern'),
      foot(t),
    ],
  ),
  tpl(
    { key: 'feiertag-sommerpause', name: 'Sommerpause', category: 'feiertage', description: 'Hinweis auf Urlaub und Erreichbarkeit – freundlich und klar', subject: 'Wir machen Sommerpause', preheader: 'Vom 4. bis 22. August sind wir im Urlaub.', theme: 'ember', tags: 'sommerpause urlaub betriebsferien erreichbarkeit ferien' },
    (t) => [
      brand(t),
      hero(t, { tone: 'accent', kicker: 'Sommerpause', title: 'Wir sind dann mal weg', text: 'Hallo {{contact.first_name|du}}, vom 4. bis 22. August tanken wir Sonne. Ab dem 25. August sind wir wieder für dich da.', padY: 44 }),
      facts(t, [['Urlaub', '4. – 22. August'], ['Wieder da', 'Montag, 25. August']], { tone: 'soft' }),
      copy(t, 'Dringende Anliegen? Schreib uns – wir melden uns so schnell wie möglich zurück, spätestens nach der Pause.', { align: 'center' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'feiertag-blackfriday', name: 'Black Friday', category: 'feiertage', description: 'Dunkles Aktionsdesign für Black Friday und Cyber Monday', subject: 'Black Friday: nur bis Montag', preheader: 'Unsere besten Preise des Jahres.', theme: 'night', tags: 'black friday cyber monday rabattschlacht november sale' },
    (t) => [
      brand(t, 'plain'),
      hero(t, { tone: 'deep', kicker: 'Black Friday', title: 'Die besten Preise des Jahres', text: 'Bis Montag, 23:59 Uhr – auf viele unserer Bestseller.', button: ['Zu den Angeboten', 'https://example.com/blackfriday'], padY: 56 }),
      stats(t, [['−30 %', 'auf Bestseller'], ['−20 %', 'auf alles andere'], ['4 Tage', 'Zeit zum Zugreifen']]),
      copy(t, 'Hallo {{contact.first_name|du}}, plane nicht lange – die beliebtesten Artikel sind erfahrungsgemäß als Erste vergriffen.', { align: 'center' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'feiertag-oeffnungszeiten', name: 'Öffnungszeiten an den Feiertagen', category: 'feiertage', description: 'Übersicht der geänderten Öffnungszeiten – ideal für Läden, Praxen, Gastronomie', subject: 'Unsere Öffnungszeiten an den Feiertagen', preheader: 'Damit du nicht vor verschlossener Tür stehst.', theme: 'slate', tags: 'öffnungszeiten feiertage geschlossen laden praxis gastronomie' },
    (t) => [
      brand(t),
      copy(t, 'Hallo {{contact.first_name|du}}, rund um die Feiertage gelten bei uns besondere Zeiten. Hier ist die Übersicht.', { title: 'Geänderte Öffnungszeiten', level: 1 }),
      facts(t, [['24. Dezember', '9:00 – 13:00 Uhr'], ['25. + 26. Dezember', 'Geschlossen'], ['27. – 30. Dezember', '10:00 – 16:00 Uhr'], ['31. Dezember', '9:00 – 13:00 Uhr']], { tone: 'soft' }),
      copy(t, 'Ab dem 2. Januar sind wir wieder zu den gewohnten Zeiten für dich da.', { align: 'center' }),
      foot(t),
    ],
  ),
];

