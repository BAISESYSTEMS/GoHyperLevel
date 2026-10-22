import { action, bullets, brand, cards, copy, couponBlock, facts, foot, hero, panel, quoteBlock, scaleBlock, stats, steps, tpl, type GalleryTemplate } from './mk-gallery-kit.js';

/** Template gallery, part 3: B2B & Vertrieb, Coach & Beratung, Handwerk & Dienstleistung, E-Commerce, Feedback & Reaktivierung. */

export const B2B: GalleryTemplate[] = [
  tpl(
    { key: 'b2b-erstkontakt', name: 'Erstkontakt (kurz und persönlich)', category: 'b2b', description: 'Schlichte Ansprache ohne Bilder, eine konkrete Frage am Ende (Sie-Form)', subject: 'Kurze Frage zu {{contact.company|Ihrem Unternehmen}}', preheader: 'Passt das zu Ihnen? Zwei Minuten Lesezeit.', theme: 'slate', formal: 'sie', tags: 'erstkontakt akquise kaltakquise vertrieb ansprache' },
    (t) => [
      copy(t, 'Guten Tag {{contact.name|Damen und Herren}},\n\nich habe gesehen, dass {{contact.company|Ihr Unternehmen}} ein ähnliches Thema beschäftigt, bei dem wir anderen Firmen aus Ihrer Branche geholfen haben: weniger Aufwand im Tagesgeschäft, mehr Zeit für das Wesentliche.\n\nKonkret: ein Kunde hat damit pro Woche rund sechs Stunden gespart.\n\n**Wäre ein kurzes Gespräch von 15 Minuten für Sie interessant?** Antworten Sie mir einfach mit „Ja“ – ich schlage Ihnen dann zwei Termine vor.\n\nFreundliche Grüße\n{{location.name}}', { padY: 30 }),
      foot(t, 'Sie erhalten diese Nachricht als geschäftlicher Kontakt. Wenn Sie keine weiteren Nachrichten wünschen, melden Sie sich hier ab.'),
    ],
  ),
  tpl(
    { key: 'b2b-fallstudie', name: 'Fallstudie mit Ergebnissen', category: 'b2b', description: 'Ein Kundenerfolg in drei Zahlen, mit Zitat und Link zur ganzen Geschichte (Sie-Form)', subject: 'Wie ein Unternehmen in Ihrer Branche 30 % Zeit gespart hat', preheader: 'Eine Fallstudie in drei Minuten.', theme: 'ocean', formal: 'sie', tags: 'fallstudie case study referenz kundenerfolg ergebnisse' },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', kicker: 'Fallstudie', title: '30 % weniger Aufwand in drei Monaten', text: 'Guten Tag {{contact.name|Damen und Herren}}, so hat ein mittelständischer Betrieb seine Abläufe vereinfacht.', align: 'left', padY: 44 }),
      stats(t, [['−30 %', 'Bearbeitungszeit'], ['+22 %', 'zufriedene Kunden'], ['3 Mon.', 'bis zum Ergebnis']]),
      panel(t, [quoteBlock(t, 'plain', 'Wir hätten nicht gedacht, dass es so schnell geht. Heute möchte niemand mehr zurück zum alten Verfahren.', 'Geschäftsführung, Maschinenbau-Betrieb')], 'plain', 16),
      action(t, 'Ganze Fallstudie lesen', 'https://example.com/fallstudie', { align: 'left' }),
      foot(t, 'Sie erhalten diese Nachricht als geschäftlicher Kontakt.'),
    ],
  ),
  tpl(
    { key: 'b2b-angebot-nachfassen', name: 'Angebot nachfassen', category: 'b2b', description: 'Freundliche Nachfrage nach einem Angebot – ohne Druck, mit einfacher Antwortmöglichkeit (Sie-Form)', subject: 'Ihr Angebot: haben Sie noch Fragen?', preheader: 'Kurz nachgefragt, ob alles klar ist.', theme: 'teal', formal: 'sie', tags: 'angebot nachfassen follow-up vertrieb nachfrage' },
    (t) => [
      copy(t, 'Guten Tag {{contact.name|Damen und Herren}},\n\nvor einigen Tagen haben wir Ihnen unser Angebot geschickt. Ich wollte kurz nachfragen, ob es angekommen ist und ob noch Fragen offen sind.\n\nAm einfachsten antworten Sie mit einer der drei Möglichkeiten:\n\n- **„Passt“** – dann bereite ich alles Weitere vor.\n- **„Fragen“** – dann rufe ich Sie gern an.\n- **„Später“** – dann melde ich mich zu dem Zeitpunkt, den Sie nennen.\n\nFreundliche Grüße\n{{location.name}}', { padY: 28 }),
      foot(t, 'Sie erhalten diese Nachricht, weil wir Ihnen ein Angebot erstellt haben.'),
    ],
  ),
  tpl(
    { key: 'b2b-terminanfrage', name: 'Terminanfrage mit Buchungslink', category: 'b2b', description: 'Kurze Einladung zu einem Gespräch, Termin direkt per Link buchen (Sie-Form)', subject: '15 Minuten für ein Gespräch?', preheader: 'Suchen Sie sich einen Termin aus.', theme: 'violet', formal: 'sie', tags: 'termin buchung gespräch kalender vertrieb demo' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', title: '15 Minuten, die sich lohnen', text: 'Guten Tag {{contact.name|Damen und Herren}}, wir zeigen Ihnen in einem kurzen Gespräch, was wir für {{contact.company|Ihr Unternehmen}} tun können – unverbindlich.', button: ['Termin auswählen', 'https://example.com/termin'], align: 'left', padY: 38 }),
      bullets(t, ['Ihre Situation in fünf Minuten besprechen', 'Konkrete Ideen für Ihren Fall', 'Danach entscheiden Sie in Ruhe'], { title: 'So läuft das Gespräch', mark: '✓' }),
      foot(t, 'Sie erhalten diese Nachricht als geschäftlicher Kontakt.'),
    ],
  ),
];

export const COACH: GalleryTemplate[] = [
  tpl(
    { key: 'coach-erstgespraech', name: 'Kostenloses Erstgespräch', category: 'coach', description: 'Einladung zum Kennenlernen mit Ablauf in drei Schritten und Buchungsbutton', subject: 'Lass uns kennenlernen – kostenlos und unverbindlich', preheader: '30 Minuten, die dich weiterbringen.', theme: 'berry', tags: 'coaching beratung erstgespräch kennenlernen termin buchen' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', kicker: 'Kostenloses Erstgespräch', title: 'Du musst nicht alles allein lösen', text: 'Hallo {{contact.first_name|du}}, in 30 Minuten klären wir, wo du stehst, wo du hinwillst – und ob ich dich dabei begleiten kann.', button: ['Gespräch buchen', 'https://example.com/erstgespraech'], padY: 40 }),
      steps(t, [['Du suchst dir einen Termin', 'Online per Video oder telefonisch.'], ['Wir sprechen offen', 'Du erzählst, ich höre zu und stelle Fragen.'], ['Du entscheidest', 'Ohne Druck – auch „Nein, danke“ ist völlig in Ordnung.']], { title: 'So läuft es ab' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'coach-impuls', name: 'Wochenimpuls', category: 'coach', description: 'Ein Gedanke, eine kleine Aufgabe – persönlich und ruhig gestaltet', subject: 'Dein Impuls für diese Woche', preheader: 'Eine Frage, die dich weiterbringt.', theme: 'gold', tags: 'impuls wochenimpuls achtsamkeit aufgabe coach newsletter' },
    (t) => [
      brand(t),
      copy(t, '„Was würdest du heute tun, wenn du wüsstest, dass es dir gelingt?“', { title: 'Impuls der Woche', level: 1, align: 'center', padY: 28 }),
      copy(t, 'Hallo {{contact.first_name|du}},\n\nnimm dir heute zehn Minuten und schreib die Antwort auf – ungefiltert, ohne sie zu bewerten. Oft zeigt sich darin der nächste, kleine Schritt.\n\nWenn du magst, erzähl mir, was dabei herauskam. Ich antworte persönlich.\n\nHerzlich\n{{location.name}}', { padY: 12 }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'coach-kundenstimme', name: 'Kundenstimme und Angebot', category: 'coach', description: 'Eine echte Erfahrung als Zitat, darunter das passende Angebot', subject: 'Was {{contact.first_name|andere}} mit unserer Begleitung erlebt haben', preheader: 'Eine Erfahrung – und deine Möglichkeit.', theme: 'teal', tags: 'testimonial kundenstimme bewertung erfahrung referenz angebot' },
    (t) => [
      brand(t),
      panel(t, [quoteBlock(t, 'soft', 'Ich habe zum ersten Mal das Gefühl, dass ich meinen eigenen Weg gehe. Die Gespräche haben mir Klarheit gegeben, die ich allein nie gefunden hätte.', 'Anna K., Teilnehmerin')], 'soft', 28),
      copy(t, 'Wenn du dir das auch wünschst: Mein 12-Wochen-Programm startet im nächsten Monat. Es gibt nur wenige Plätze, damit ich mir für jeden Zeit nehmen kann.', { title: 'Das nächste Programm', align: 'center' }),
      action(t, 'Mehr über das Programm', 'https://example.com/programm'),
      foot(t),
    ],
  ),
];

export const HANDWERK: GalleryTemplate[] = [
  tpl(
    { key: 'handwerk-termin', name: 'Termin bestätigt', category: 'handwerk', description: 'Terminbestätigung mit Datum, Uhrzeit und Hinweisen für den Besuch (Sie-Form)', subject: 'Ihr Termin bei {{location.name}} ist bestätigt', preheader: 'Alle Angaben auf einen Blick.', theme: 'ember', formal: 'sie', service: true, tags: 'handwerk termin bestätigung monteur besuch anfahrt' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', kicker: 'Termin bestätigt', title: 'Wir kommen zu Ihnen', text: 'Guten Tag {{contact.name|Damen und Herren}}, schön, dass wir Ihnen helfen dürfen. Hier sind die Angaben zu Ihrem Termin.', align: 'left', padY: 34 }),
      facts(t, [['Datum', 'Dienstag, 14. Oktober'], ['Zeit', 'zwischen 8:00 und 10:00 Uhr'], ['Ort', 'Bei Ihnen vor Ort'], ['Ansprechperson', 'Unser Team-Telefon']], { tone: 'plain' }),
      bullets(t, ['Bitte sorgen Sie für freien Zugang zum Arbeitsbereich', 'Haustiere bitte während des Besuchs sichern', 'Bei Verspätung rufen wir Sie rechtzeitig an'], { title: 'Zur Vorbereitung', mark: '•' }),
      foot(t, 'Diese E-Mail betrifft Ihren Termin bei uns.'),
    ],
  ),
  tpl(
    { key: 'handwerk-angebot', name: 'Ihr Angebot ist fertig', category: 'handwerk', description: 'Angebot per Link zur Ansicht und Annahme – mit Gültigkeit und Rückfrage-Hinweis (Sie-Form)', subject: 'Ihr Angebot von {{location.name}}', preheader: 'Zur Ansicht und Annahme online.', theme: 'slate', formal: 'sie', service: true, tags: 'handwerk angebot kostenvoranschlag annahme online' },
    (t) => [
      brand(t, 'plain', 'left'),
      copy(t, 'Guten Tag {{contact.name|Damen und Herren}},\n\nvielen Dank für Ihre Anfrage. Wir haben Ihr Angebot vorbereitet. Sie können es online ansehen, als PDF speichern und mit einem Klick annehmen.', { title: 'Ihr Angebot ist fertig', level: 1 }),
      facts(t, [['Gültig bis', '31. Oktober'], ['Beginn der Arbeiten', 'nach Absprache']], { tone: 'soft' }),
      action(t, 'Angebot ansehen', 'https://example.com/angebot', { align: 'left' }),
      copy(t, 'Wenn Sie Fragen haben oder etwas anpassen möchten, antworten Sie einfach auf diese E-Mail.\n\nFreundliche Grüße\n{{location.name}}'),
      foot(t, 'Diese E-Mail betrifft Ihre Anfrage bei uns.'),
    ],
  ),
  tpl(
    { key: 'handwerk-wartung', name: 'Wartung ist fällig', category: 'handwerk', description: 'Freundliche Erinnerung an die jährliche Wartung mit Terminlink', subject: 'Zeit für die jährliche Wartung', preheader: 'Damit alles zuverlässig läuft.', theme: 'forest', formal: 'sie', tags: 'wartung inspektion jährlich heizung erinnerung kundenpflege' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', kicker: 'Jährliche Wartung', title: 'Es ist wieder soweit', text: 'Guten Tag {{contact.name|Damen und Herren}}, seit Ihrer letzten Wartung ist ein Jahr vergangen. Eine regelmäßige Prüfung verlängert die Lebensdauer und beugt Ausfällen vor.', button: ['Wartungstermin buchen', 'https://example.com/wartung'], align: 'left', padY: 36 }),
      bullets(t, ['Prüfung aller wichtigen Bauteile', 'Reinigung und Einstellung', 'Kurzer Bericht mit Empfehlungen'], { title: 'Das ist enthalten', mark: '✓' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'handwerk-danke-bewertung', name: 'Danke nach dem Auftrag', category: 'handwerk', description: 'Dank und freundliche Bitte um eine Bewertung nach abgeschlossener Arbeit', subject: 'Danke für Ihren Auftrag – wie zufrieden waren Sie?', preheader: 'Ihre Meinung hilft uns und anderen.', theme: 'ocean', formal: 'sie', tags: 'danke auftrag bewertung google rezension abschluss nachfass' },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', title: 'Vielen Dank für Ihr Vertrauen', text: 'Guten Tag {{contact.name|Damen und Herren}}, die Arbeiten sind abgeschlossen. Wir hoffen, Sie sind zufrieden.', align: 'left', padY: 38 }),
      copy(t, 'Wenn ja, würden wir uns über eine kurze Bewertung freuen. Sie dauert eine Minute und hilft anderen, uns zu finden.', { align: 'center' }),
      action(t, 'Jetzt bewerten', 'https://example.com/bewertung'),
      copy(t, 'Ist etwas nicht ganz so gelaufen, wie es sollte? Antworten Sie bitte direkt auf diese E-Mail – wir kümmern uns darum.', { align: 'center' }),
      foot(t),
    ],
  ),
];

export const ECOMMERCE: GalleryTemplate[] = [
  tpl(
    { key: 'shop-bestellung', name: 'Bestellbestätigung', category: 'ecommerce', description: 'Dank für die Bestellung mit Übersicht, Lieferhinweis und Kontakt', subject: 'Danke für deine Bestellung', preheader: 'Wir haben sie erhalten und kümmern uns darum.', theme: 'ocean', service: true, tags: 'bestellung bestätigung shop order kauf' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', kicker: 'Bestellung erhalten', title: 'Danke, {{contact.first_name|du}}!', text: 'Wir packen deine Bestellung gerade sorgfältig ein. Sobald sie unterwegs ist, bekommst du eine weitere E-Mail.', padY: 36 }),
      facts(t, [['Lieferzeit', '2 – 4 Werktage'], ['Versand', 'Kostenlos ab 50 €']], { tone: 'plain' }),
      action(t, 'Bestellung ansehen', 'https://example.com/konto/bestellungen'),
      copy(t, 'Fragen zur Bestellung? Antworte einfach auf diese E-Mail.', { align: 'center' }),
      foot(t, 'Diese E-Mail betrifft deine Bestellung bei uns.'),
    ],
  ),
  tpl(
    { key: 'shop-warenkorb-1', name: 'Warenkorb: du hast etwas vergessen', category: 'ecommerce', description: 'Erste Erinnerung nach einem abgebrochenen Kauf – freundlich, mit direktem Link', subject: 'Du hast etwas vergessen, {{contact.first_name|}}', preheader: 'Dein Warenkorb wartet auf dich.', theme: 'ocean', tags: 'warenkorb abbruch erinnerung checkout abandoned cart vergessen' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', kicker: 'Fast geschafft', title: 'Dein Warenkorb wartet', text: 'Hallo {{contact.first_name|du}}, du warst gerade dabei, „{{event.product_name|dein Produkt}}“ zu bestellen. Mit einem Klick geht es dort weiter, wo du aufgehört hast.', button: ['Jetzt abschließen', '{{event.recovery_url}}'], padY: 40 }),
      bullets(t, ['Sichere Bezahlung', 'Sofort startklar nach dem Kauf', 'Bei Fragen helfen wir dir gern'], { title: 'Gut zu wissen', mark: '✓' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'shop-warenkorb-2', name: 'Warenkorb: noch unsicher?', category: 'ecommerce', description: 'Zweite Erinnerung: Einwände ausräumen und Fragen beantworten', subject: 'Noch Fragen zu „{{event.product_name|deiner Bestellung}}“?', preheader: 'Wir beantworten, was dich noch zögern lässt.', theme: 'teal', tags: 'warenkorb abbruch fragen einwände faq erinnerung zweite' },
    (t) => [
      brand(t),
      copy(t, 'Hallo {{contact.first_name|du}}, vielleicht hast du dir noch eine Frage gestellt, bevor du bestellst. Hier sind die Antworten auf die häufigsten.', { title: 'Noch unsicher?', level: 1 }),
      cards(t, [
        { title: 'Passt das zu mir?', text: 'Ja, wenn du eine einfache Lösung suchst. Antworte uns kurz, wir beraten dich ehrlich.' },
        { title: 'Was, wenn es nicht passt?', text: 'Du hast 14 Tage Zeit, es dir in Ruhe anzusehen. Ohne Wenn und Aber.' },
      ], { tone: 'soft' }),
      action(t, 'Zurück zu meiner Bestellung', '{{event.recovery_url}}'),
      foot(t),
    ],
  ),
  tpl(
    { key: 'shop-warenkorb-3', name: 'Warenkorb: letzte Erinnerung', category: 'ecommerce', description: 'Dritte und letzte Erinnerung – kurz, klar, ohne Druck', subject: 'Letzte Erinnerung: „{{event.product_name|dein Produkt}}“', preheader: 'Danach lassen wir dich in Ruhe.', theme: 'ember', tags: 'warenkorb abbruch letzte erinnerung dritte' },
    (t) => [
      brand(t),
      hero(t, { tone: 'accent', title: 'Das ist unsere letzte Erinnerung', text: 'Hallo {{contact.first_name|du}}, wir möchten dich nicht nerven. Deshalb ist das hier die letzte E-Mail zu „{{event.product_name|deiner Bestellung}}“.', button: ['Doch noch bestellen', '{{event.recovery_url}}'], padY: 40 }),
      copy(t, 'Wenn du kein Interesse mehr hast, musst du nichts tun. Wir wünschen dir alles Gute!', { align: 'center' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'shop-versand', name: 'Dein Paket ist unterwegs', category: 'ecommerce', description: 'Versandbenachrichtigung mit Sendungsnummer und Link zur Verfolgung', subject: 'Dein Paket ist unterwegs', preheader: 'Verfolge die Lieferung live.', theme: 'forest', service: true, tags: 'versand sendungsverfolgung paket tracking dhl lieferung' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', kicker: 'Auf dem Weg zu dir', title: 'Dein Paket ist unterwegs', text: 'Hallo {{contact.first_name|du}}, deine Bestellung hat unser Lager verlassen und kommt in den nächsten Tagen bei dir an.', button: ['Sendung verfolgen', 'https://example.com/tracking'], padY: 38 }),
      facts(t, [['Voraussichtliche Lieferung', '2 – 3 Werktage'], ['Sendungsnummer', 'steht im Link oben']], { tone: 'plain' }),
      foot(t, 'Diese E-Mail betrifft deine Bestellung bei uns.'),
    ],
  ),
  tpl(
    { key: 'shop-bewertung', name: 'Wie gefällt dir dein Kauf?', category: 'ecommerce', description: 'Bitte um Produktbewertung einige Tage nach der Lieferung', subject: 'Wie gefällt dir {{event.product_name|dein Kauf}}?', preheader: 'Deine Meinung hilft anderen bei der Auswahl.', theme: 'berry', tags: 'bewertung rezension produktbewertung nachkauf feedback sterne' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', title: 'Wie gefällt dir dein Kauf?', text: 'Hallo {{contact.first_name|du}}, du hast deine Bestellung jetzt ein paar Tage. Wir würden gern wissen, wie sie dir gefällt.', button: ['Jetzt bewerten', 'https://example.com/bewertung'], padY: 38 }),
      copy(t, 'Mit deiner Bewertung hilfst du anderen bei der Entscheidung – und uns, besser zu werden. Es dauert nur eine Minute.', { align: 'center' }),
      copy(t, 'Läuft etwas nicht wie erwartet? Antworte einfach auf diese E-Mail. Wir finden eine Lösung.', { align: 'center' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'shop-nachfuellen', name: 'Zeit zum Nachfüllen', category: 'ecommerce', description: 'Erinnerung an Verbrauchsprodukte – kurz bevor sie zur Neige gehen', subject: 'Bald leer? Jetzt nachbestellen', preheader: 'Damit nichts ausgeht.', theme: 'gold', tags: 'nachbestellen nachfüllen wiederkauf verbrauch abo erinnerung' },
    (t) => [
      brand(t),
      hero(t, { tone: 'deep', kicker: 'Zeit für Nachschub', title: 'Bald geht es zur Neige', text: 'Hallo {{contact.first_name|du}}, nach unserer Erfahrung reicht deine letzte Bestellung etwa vier Wochen. Jetzt ist ein guter Moment, nachzubestellen.', button: ['Nachbestellen', 'https://example.com/shop'], padY: 44 }),
      panel(t, [couponBlock(t, 'soft', 'NACHSCHUB5', '5 % für Stammkunden bei jeder Nachbestellung.')], 'soft', 18),
      foot(t),
    ],
  ),
];

export const FEEDBACK: GalleryTemplate[] = [
  tpl(
    { key: 'feedback-empfehlung', name: 'Wie wahrscheinlich empfiehlst du uns?', category: 'feedback', description: 'NPS-Frage mit zehn Stufen als Links und Raum für ein offenes Feedback', subject: 'Eine Frage: würdest du uns weiterempfehlen?', preheader: 'Eine Antwort, eine halbe Minute.', theme: 'violet', tags: 'nps empfehlung umfrage feedback zufriedenheit net promoter' },
    (t) => [
      brand(t),
      copy(t, 'Hallo {{contact.first_name|du}}, wie wahrscheinlich ist es, dass du {{location.name}} einem Freund oder einer Kollegin weiterempfiehlst?', { title: 'Eine kurze Frage', level: 1, align: 'center', padY: 28 }),
      panel(t, [scaleBlock(t, 0, 10, (n) => `https://example.com/nps?s=${n}`)], 'soft', 18),
      copy(t, '0 = auf keinen Fall · 10 = ganz bestimmt\n\nEin Klick genügt. Danach kannst du uns noch sagen, was wir besser machen können.', { align: 'center' }),
      foot(t),
    ],
  ),
  tpl(
    { key: 'reaktivierung-vermisst', name: 'Wir vermissen dich', category: 'feedback', description: 'Reaktivierung für inaktive Kontakte mit einem Anlass zum Zurückkommen', subject: 'Wir haben dich vermisst, {{contact.first_name|du}}', preheader: 'Es hat sich einiges getan – schau vorbei.', theme: 'ocean', tags: 'reaktivierung inaktiv vermissen win-back zurückholen sunset' },
    (t) => [
      brand(t),
      hero(t, { tone: 'soft', kicker: 'Lange nichts gehört', title: 'Wir haben dich vermisst', text: 'Hallo {{contact.first_name|du}}, es ist eine Weile her. Seitdem hat sich bei uns einiges getan – und wir würden dir gern zeigen, was.', button: ['Was ist neu?', 'https://example.com/neu'], padY: 40 }),
      panel(t, [couponBlock(t, 'plain', 'WIEDERDA10', 'Ein kleines Willkommen zurück: 10 % auf deine nächste Bestellung.')], 'plain', 16),
      foot(t),
    ],
  ),
  tpl(
    { key: 'reaktivierung-bleibst-du', name: 'Bleibst du dabei?', category: 'feedback', description: 'Letzte Mail vor dem Entfernen inaktiver Kontakte – ein Klick, um zu bleiben', subject: 'Möchtest du weiterhin von uns hören?', preheader: 'Ein Klick – sonst nehmen wir dich aus dem Verteiler.', theme: 'slate', tags: 'bestätigung bleiben inaktiv liste bereinigen sunset abmelden letzte' },
    (t) => [
      brand(t),
      copy(t, 'Hallo {{contact.first_name|du}},\n\nwir haben gemerkt, dass du unsere E-Mails seit einiger Zeit nicht mehr öffnest. Das ist völlig in Ordnung – aber wir möchten dich nicht mit Nachrichten belästigen, die dich nicht interessieren.\n\n**Wenn du weiterhin von uns hören möchtest, klicke bitte kurz auf den Button.** Sonst nehmen wir dich in den nächsten Wochen aus unserem Verteiler.', { title: 'Bleibst du dabei?', level: 1, padY: 24 }),
      action(t, 'Ja, ich möchte dabeibleiben', 'https://example.com/bleiben'),
      copy(t, 'Du musst nichts tun, wenn du nicht mehr dabei sein möchtest. Danke für die Zeit mit uns!', { align: 'center' }),
      foot(t),
    ],
  ),
];

