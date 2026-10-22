import { action, bullets, brand, cards, copy, couponBlock, figureBlock, foot, hero, letter, line, panel, social, stats, steps, tpl, type GalleryTemplate } from './mk-gallery-kit.js';

/** Template gallery, part 1: Newsletter, Angebot & Rabatt, Willkommen. Copy in German, links are placeholders to replace in the designer. */

export const NEWSLETTER: GalleryTemplate[] = [
  tpl(
    { key: 'newsletter-klassisch', name: 'Klassischer Newsletter', category: 'newsletter', description: 'Aufmacher, zwei Beiträge nebeneinander und ein Button zum Weiterlesen', subject: 'Neuigkeiten von {{location.name}}', preheader: 'Das Wichtigste der letzten Wochen – kurz und knapp.', theme: 'ocean', tags: 'monatlich news beiträge blog' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', kicker: 'Newsletter', title: 'Das ist neu bei {{location.name}}', text: 'Hallo {{contact.first_name|du}}, hier sind die wichtigsten Neuigkeiten der letzten Wochen – kurz und knapp.', button: ['Alle Beiträge lesen', 'https://example.com/blog'], padY: 36 }),
      cards(t, [
        { title: 'Beitrag eins', text: 'Zwei, drei Sätze dazu, worum es geht und warum es sich für dich lohnt.', link: ['Weiterlesen', 'https://example.com/beitrag-1'] },
        { title: 'Beitrag zwei', text: 'Noch ein Thema aus unserem Alltag – ehrlich, praktisch und ohne Fachchinesisch.', link: ['Weiterlesen', 'https://example.com/beitrag-2'] },
      ]),
      letter(t, 'Bis zum nächsten Mal\n{{location.name}}'),
      social(t),
      foot(t),
    ],
  ),
  tpl(
    { key: 'newsletter-magazin', name: 'Magazin-Newsletter', category: 'newsletter', description: 'Großer Aufmacher und drei Kurzbeiträge in Spalten – für Blog und Redaktion', subject: 'Neu im Magazin: {{location.name}}', preheader: 'Drei Geschichten, die du nicht verpassen solltest.', theme: 'gold', tags: 'magazin redaktion blog artikel editorial' },
    (t) => [
      brand(t, 'plain'),
      hero(t, { tone: 'deep', kicker: 'Ausgabe des Monats', title: 'Eine Geschichte, die uns nicht losgelassen hat', text: 'Wie ein kleiner Anfang zu einem großen Thema wurde – und was wir dabei gelernt haben.', button: ['Geschichte lesen', 'https://example.com/magazin/aufmacher'], align: 'left', padY: 48 }),
      cards(t, [
        { title: 'Hinter den Kulissen', text: 'Ein Blick in den Alltag unseres Teams.', link: ['Lesen', 'https://example.com/magazin/1'] },
        { title: 'Praxistipp', text: 'In fünf Minuten umgesetzt, lange nützlich.', link: ['Lesen', 'https://example.com/magazin/2'] },
        { title: 'Aus der Community', text: 'Was Leserinnen und Leser uns geschrieben haben.', link: ['Lesen', 'https://example.com/magazin/3'] },
      ], { cols: 3, title: 'Außerdem in dieser Ausgabe' }),
      line(t),
      copy(t, 'Du hast ein Thema, über das wir schreiben sollen? Antworte einfach auf diese E-Mail.', { align: 'center' }),
      social(t),
      foot(t),
    ],
  ),
  tpl(
    { key: 'newsletter-kompakt', name: 'Kompakt: das Wichtigste in drei Punkten', category: 'newsletter', description: 'Kurzer Newsletter mit drei nummerierten Punkten – in einer Minute gelesen', subject: 'Drei Dinge, die diese Woche wichtig sind', preheader: 'In einer Minute gelesen.', theme: 'teal', tags: 'kurz wöchentlich übersicht liste' },
    (t) => [
      brand(t, 'plain', 'left'),
      copy(t, 'Hallo {{contact.first_name|du}}, das Wichtigste dieser Woche auf einen Blick:', { title: 'Kurz & gut', level: 1 }),
      steps(t, [
        ['Neu im Angebot', 'Ein Satz, der neugierig macht – und ein Link, der direkt dorthin führt. [Mehr erfahren](https://example.com/neu)'],
        ['Termin vormerken', 'Am Donnerstag, 18 Uhr: unsere offene Sprechstunde. [Platz sichern](https://example.com/termin)'],
        ['Tipp der Woche', 'Ein kleiner Kniff aus der Praxis, der Zeit spart. [Zum Tipp](https://example.com/tipp)'],
      ], { tone: 'soft', title: 'Die drei Punkte' }),
      letter(t, 'Bis nächste Woche\n{{location.name}}'),
      foot(t),
    ],
  ),
  tpl(
    { key: 'newsletter-rueckblick', name: 'Monatsrückblick mit Zahlen', category: 'newsletter', description: 'Drei Kennzahlen, ein Highlight und ein Ausblick – schafft Vertrauen', subject: 'Unser {{location.name}}-Monat in Zahlen', preheader: 'Was wir erreicht haben – und was als Nächstes kommt.', theme: 'violet', tags: 'rückblick zahlen jahresrückblick bilanz transparenz' },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', kicker: 'Rückblick', title: 'Das war unser Monat', text: 'Hallo {{contact.first_name|du}}, danke, dass du dabei bist. Hier ist, was zusammengekommen ist.', align: 'center', padY: 40 }),
      stats(t, [['128', 'neue Kundinnen und Kunden'], ['4,9', 'Sterne in Bewertungen'], ['36', 'umgesetzte Projekte']]),
      copy(t, 'Unser Highlight war der Umzug in die neuen Räume. Mehr Platz, mehr Licht – und endlich ein Besprechungstisch, an dem alle sitzen können.', { title: 'Highlight des Monats' }),
      cards(t, [{ title: 'Das kommt als Nächstes', text: 'Im kommenden Monat starten wir mit einem neuen Angebot. Du erfährst es zuerst.', link: ['Auf die Warteliste', 'https://example.com/warteliste'] }], { tone: 'soft', cols: 2 }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'newsletter-tipp', name: 'Tipp der Woche (persönlich)', category: 'newsletter', description: 'Wie ein persönlicher Brief: ein Tipp, eine Geschichte, ein Link', subject: 'Ein Tipp, den ich oft weitergebe', preheader: 'Kurz, praktisch, ohne Verkaufsdruck.', theme: 'slate', tags: 'brief persönlich ratgeber wöchentlich einfach' },
    (t) => [
      copy(t, 'Hallo {{contact.first_name|du}},\n\nin Gesprächen mit unseren Kunden kommt eine Frage immer wieder: „Wo fange ich an?“ Meine Antwort ist fast immer dieselbe.\n\n**Fang mit dem an, was dich am meisten Zeit kostet.** Nicht mit dem, was am spannendsten klingt. Schreib eine Woche lang auf, wofür du am meisten Zeit brauchst – und nimm genau das als Erstes in Angriff.\n\nWenn du magst, schau dir hier an, wie andere das gelöst haben: [Beispiele ansehen](https://example.com/beispiele)\n\nViele Grüße\n{{location.name}}', { padY: 28 }),
      foot(t, 'Du bekommst diese E-Mail, weil du dich für unseren Newsletter eingetragen hast.'),
    ],
  ),
  tpl(
    { key: 'newsletter-neuheiten', name: 'Produktneuheiten', category: 'newsletter', description: 'Zwei neue Produkte oder Leistungen mit Button und Hinweis auf Verfügbarkeit', subject: 'Neu bei {{location.name}}: das haben wir für dich', preheader: 'Zwei Neuheiten, die du zuerst siehst.', theme: 'ember', tags: 'neuheiten produkte launch neu vorstellung' },
    (t) => [
      brand(t),
      hero(t, { tone: 'accent', kicker: 'Neu eingetroffen', title: 'Frisch für dich', text: 'Zwei Neuheiten, die wir dir gern zuerst zeigen.', padY: 36 }),
      cards(t, [
        { title: 'Neuheit eins', text: 'Was es ist, wofür du es brauchst und was es besonders macht – in zwei Sätzen.', link: ['Ansehen', 'https://example.com/neu-1'] },
        { title: 'Neuheit zwei', text: 'Eine zweite Idee, die gut dazu passt. Ab sofort verfügbar.', link: ['Ansehen', 'https://example.com/neu-2'] },
      ]),
      action(t, 'Alle Neuheiten entdecken', 'https://example.com/neu', { note: 'Solange der Vorrat reicht.' }),
      letter(t, 'Viel Freude damit\n{{location.name}}'),
      foot(t),
    ],
  ),
];

export const ANGEBOT: GalleryTemplate[] = [
  tpl(
    { key: 'angebot-rabatt', name: 'Rabattaktion', category: 'angebot', description: 'Große Rabatt-Zeile, Code und Button – für zeitlich begrenzte Aktionen', subject: '{{contact.first_name|Hallo}}, 20 % Rabatt nur bis Sonntag', preheader: 'Mit dem Code HERBST20 im Warenkorb.', theme: 'ember', tags: 'rabatt sale aktion prozent gutschein herbst' },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', kicker: 'Nur bis Sonntag', title: '20 % auf alles', text: 'Als Dankeschön für deine Treue: Spare diese Woche auf unser gesamtes Angebot.', button: ['Jetzt sparen', 'https://example.com/shop'], padY: 44 }),
      panel(t, [couponBlock(t, 'soft', 'HERBST20', 'Im Warenkorb eingeben – gültig bis Sonntag, 23:59 Uhr.')], 'soft', 18),
      bullets(t, ['Kostenloser Versand ab 50 €', '30 Tage Rückgaberecht', 'Persönliche Beratung per Telefon'], { title: 'Dein Vorteil', mark: '✓' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'angebot-flash', name: 'Flash Sale (24 Stunden)', category: 'angebot', description: 'Dunkles, dringliches Design für kurze Aktionen mit großer Zahl', subject: 'Nur 24 Stunden: bis zu 40 % reduziert', preheader: 'Morgen um diese Zeit ist es vorbei.', theme: 'night', tags: 'flash sale 24 stunden dringend countdown blitz' },
    (t) => [
      brand(t, 'plain'),
      hero(t, { tone: 'deep', kicker: 'Nur heute', title: 'Bis zu 40 % reduziert', text: 'Unsere beliebtesten Produkte – 24 Stunden lang zum Aktionspreis.', button: ['Zur Aktion', 'https://example.com/flash'], padY: 48 }),
      panel(t, [figureBlock(t, 'soft', 'Aktion endet', 'morgen, 10:00 Uhr', 'Danach gelten wieder die normalen Preise.')], 'soft', 22),
      copy(t, 'Hallo {{contact.first_name|du}}, wer schnell ist, sichert sich die Favoriten. Was weg ist, ist weg.', { align: 'center' }),
      action(t, 'Jetzt zugreifen', 'https://example.com/flash'),
      foot(t),
    ],
  ),
  tpl(
    { key: 'angebot-paket', name: 'Paketpreise im Vergleich', category: 'angebot', description: 'Drei Pakete nebeneinander – Basis, Plus und Premium mit Preis', subject: 'Welches Paket passt zu dir?', preheader: 'Drei Pakete, ein klarer Preis.', theme: 'violet', tags: 'pakete preise vergleich tarife abo preisliste' },
    (t) => [
      brand(t),
      copy(t, 'Hallo {{contact.first_name|du}}, wir haben unsere Leistungen in drei Pakete gebündelt – damit du genau das bekommst, was du brauchst.', { title: 'Drei Pakete. Ein klarer Preis.', level: 1, align: 'center' }),
      stats(t, [['49 €', 'Basis – der schnelle Einstieg'], ['99 €', 'Plus – für alle, die mehr wollen'], ['199 €', 'Premium – rundum betreut']], { tone: 'soft' }),
      bullets(t, ['Alle Pakete monatlich kündbar', 'Einrichtung ist immer inklusive', 'Wechsel zwischen den Paketen jederzeit möglich'], { title: 'Für alle Pakete gilt', mark: '✓' }),
      action(t, 'Pakete vergleichen', 'https://example.com/pakete'),
      foot(t),
    ],
  ),
  tpl(
    { key: 'angebot-vip', name: 'Exklusiv für Stammkunden', category: 'angebot', description: 'Persönliches Dankeschön mit Vorabzugang und Extra-Rabatt', subject: 'Vorab für dich: unser Stammkunden-Angebot', preheader: 'Du siehst es, bevor es alle anderen sehen.', theme: 'gold', tags: 'vip stammkunden treue exklusiv vorab dankeschön' },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', kicker: 'Nur für Stammkunden', title: 'Du bist uns wichtig, {{contact.first_name|lieber Kunde}}', text: 'Deshalb bekommst du unser neues Angebot 48 Stunden früher – und 15 % obendrauf.', button: ['Vorab ansehen', 'https://example.com/vip'], padY: 48 }),
      panel(t, [couponBlock(t, 'soft', 'DANKE15', 'Gilt für deinen nächsten Einkauf, einmal pro Kunde.')], 'soft', 18),
      copy(t, 'Danke für dein Vertrauen. Ohne Kundinnen und Kunden wie dich gäbe es {{location.name}} nicht.', { align: 'center' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'angebot-gutschein', name: 'Geschenkgutschein', category: 'angebot', description: 'Gutschein-Box mit Code und Einlösehinweis – auch als Geburtstagsgruß', subject: 'Ein kleines Geschenk für dich', preheader: 'Dein persönlicher Gutschein wartet.', theme: 'berry', tags: 'gutschein geschenk geburtstag code voucher' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', kicker: 'Ein Geschenk', title: 'Für dich, {{contact.first_name|von uns}}', text: 'Weil du uns am Herzen liegst, schenken wir dir 10 € auf deinen nächsten Einkauf.', padY: 36 }),
      panel(t, [couponBlock(t, 'plain', 'GESCHENK10', 'Einlösbar bis zum Ende des Monats.')], 'plain', 16),
      steps(t, [['Code kopieren', 'Markiere den Code oben und kopiere ihn.'], ['Einkaufen', 'Such dir aus, was dir gefällt.'], ['Code eingeben', 'Gib ihn an der Kasse oder im Warenkorb ein.']], { title: 'So löst du ihn ein' }),
      action(t, 'Jetzt einlösen', 'https://example.com/shop'),
      foot(t),
    ],
  ),
  tpl(
    { key: 'angebot-letzte-chance', name: 'Letzte Chance', category: 'angebot', description: 'Erinnerung am letzten Tag einer Aktion – kurz, klar, mit einem Button', subject: 'Heute ist der letzte Tag', preheader: 'Danach gilt wieder der normale Preis.', theme: 'ember', tags: 'letzte chance endet heute erinnerung frist' },
    (t) => [
      brand(t),
      hero(t, { tone: 'accent', kicker: 'Heute endet unsere Aktion', title: 'Letzte Chance', text: 'Hallo {{contact.first_name|du}}, nur noch bis Mitternacht gilt dein Vorteil.', button: ['Jetzt noch sichern', 'https://example.com/angebot'], padY: 44 }),
      copy(t, 'Du hast noch überlegt? Dann ist jetzt der richtige Moment. Wenn du Fragen hast, antworte einfach auf diese E-Mail – wir helfen dir gern.', { align: 'center' }),
      foot(t),
    ],
  ),
];

export const WILLKOMMEN: GalleryTemplate[] = [
  tpl(
    { key: 'willkommen-klassisch', name: 'Willkommen mit drei Schritten', category: 'willkommen', description: 'Herzlich empfangen und in drei Schritten zum Start führen', subject: 'Willkommen bei {{location.name}}, {{contact.first_name|schön, dass du da bist}}!', preheader: 'So geht es jetzt weiter.', theme: 'ocean', tags: 'willkommen start anmeldung neukunde onboarding' },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', kicker: 'Schön, dass du da bist', title: 'Willkommen, {{contact.first_name|du}}!', text: 'Wir freuen uns auf die Zusammenarbeit. So kommst du gut an:', padY: 44 }),
      steps(t, [['Profil vervollständigen', 'Zwei Minuten, damit wir dich besser kennenlernen.'], ['Kennenlerngespräch buchen', 'Wir nehmen uns Zeit für deine Fragen.'], ['Newsletter lesen', 'Tipps aus der Praxis, einmal im Monat.']], { title: 'Dein Start in drei Schritten' }),
      action(t, 'Termin buchen', 'https://example.com/termin'),
      letter(t, 'Fragen? Antworte einfach auf diese E-Mail.\n\nViele Grüße\n{{location.name}}'),
      foot(t),
    ],
  ),
  tpl(
    { key: 'willkommen-tag1', name: 'Onboarding Tag 1: das Wichtigste zuerst', category: 'willkommen', description: 'Checkliste für den ersten Tag mit einem klaren nächsten Schritt', subject: 'Dein erster Tag: drei Dinge, dann bist du startklar', preheader: 'Eine kurze Checkliste für den Start.', theme: 'teal', tags: 'onboarding checkliste erster tag einrichten software' },
    (t) => [
      brand(t, 'plain', 'left'),
      copy(t, 'Hallo {{contact.first_name|du}}, schön, dass du angefangen hast. Damit du schnell Ergebnisse siehst, reichen heute drei Schritte.', { title: 'Dein erster Tag', level: 1 }),
      bullets(t, ['Zugang öffnen und Passwort festlegen', 'Dein Unternehmen eintragen (zwei Minuten)', 'Die erste Kontaktliste hochladen'], { tone: 'soft', title: 'Checkliste für heute', mark: '☐' }),
      action(t, 'Jetzt loslegen', 'https://example.com/start', { align: 'left' }),
      copy(t, 'Du kommst nicht weiter? Antworte einfach auf diese E-Mail – eine echte Person liest sie.'),
      foot(t),
    ],
  ),
  tpl(
    { key: 'willkommen-geschenk', name: 'Willkommensgeschenk', category: 'willkommen', description: 'Rabatt-Code für die erste Bestellung nach der Newsletter-Anmeldung', subject: 'Willkommen! Dein Geschenk zum Start', preheader: '10 % auf deine erste Bestellung.', theme: 'forest', tags: 'willkommen rabatt erste bestellung newsletter anmeldung code' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', kicker: 'Danke für deine Anmeldung', title: 'Willkommen bei {{location.name}}', text: 'Als Dankeschön bekommst du 10 % auf deine erste Bestellung.', padY: 36 }),
      panel(t, [couponBlock(t, 'plain', 'WILLKOMMEN10', 'Gilt für deine erste Bestellung.')], 'plain', 14),
      action(t, 'Jetzt stöbern', 'https://example.com/shop'),
      copy(t, 'Du hörst von uns etwa zweimal im Monat – mit Neuigkeiten, Tipps und gelegentlichen Angeboten. Abmelden geht jederzeit mit einem Klick.', { align: 'center' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'willkommen-brief', name: 'Persönlicher Brief vom Gründer', category: 'willkommen', description: 'Schlichte, persönliche Begrüßung ohne Bilder – wirkt wie von Hand geschrieben', subject: 'Schön, dass du da bist', preheader: 'Ein paar persönliche Worte zum Start.', theme: 'slate', tags: 'brief persönlich gründer inhaberin ehrlich schlicht' },
    (t) => [
      copy(t, 'Hallo {{contact.first_name|du}},\n\nich freue mich sehr, dass du dich für {{location.name}} entschieden hast. Ich habe dieses Unternehmen gegründet, weil ich selbst oft genervt war von umständlichen Lösungen – und ich möchte, dass es bei uns einfacher geht.\n\nDeshalb eine Bitte: Wenn dir etwas nicht gefällt, unklar ist oder fehlt, schreib mir direkt. Ich lese jede Antwort selbst.\n\nHerzlich\n{{location.name}}', { padY: 32 }),
      foot(t, 'Du erhältst diese E-Mail, weil du dich bei uns angemeldet hast.'),
    ],
  ),
  tpl(
    { key: 'willkommen-erwartung', name: 'Anmeldung bestätigt: das erwartet dich', category: 'willkommen', description: 'Nach der Newsletter-Anmeldung: Was, wie oft und wie man sich wieder abmeldet', subject: 'Du bist dabei – das kommt jetzt von uns', preheader: 'Kurz erklärt: Inhalt, Rhythmus, Abmeldung.', theme: 'berry', tags: 'anmeldung newsletter bestätigung erwartung rhythmus' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', title: 'Danke für deine Anmeldung', text: 'Hallo {{contact.first_name|du}}, du bist jetzt in unserem Newsletter. Das darfst du erwarten:', padY: 32 }),
      cards(t, [
        { title: 'Was', text: 'Tipps aus der Praxis, Neuigkeiten und ab und zu ein Angebot.' },
        { title: 'Wie oft', text: 'Etwa zweimal im Monat – nie mehr, als sich lohnt.' },
        { title: 'Abmelden', text: 'Jederzeit mit einem Klick am Ende jeder E-Mail.' },
      ], { cols: 3 }),
      action(t, 'Auf der Website stöbern', 'https://example.com'),
      foot(t),
    ],
  ),
];

