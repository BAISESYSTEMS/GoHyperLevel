import { id, now, token } from '../core/util.js';
import { syncInvoices } from './acc-autopost.js';
import type { Kit } from './demo-seed-extras.js';
import { getOrCreateConversation } from './messaging.js';
import { sealSecret } from '../core/secrets.js';
import { postEntry } from './acc-ledger.js';

/**
 * The rest of the business for the demo seed (services/demo-seed.ts): real conversations over e-mail, SMS, WhatsApp and the
 * website chat, Google reviews with the owner's replies, social media queues and an approval link, a team with vacation and
 * sick days, an NPS survey with answers, a sales sequence, a loyalty programme, inventory with a purchase order, canvas boards,
 * affiliate commissions, credit notes and – after the history is dated – the bookkeeping (chart of accounts, invoices posted,
 * a year of running costs) so the EÜR shows a real year. Pure demo data, everything fictional; failures are collected by the kit.
 */

const DAY = 864e5;
const iso = (ms: number) => new Date(ms).toISOString();
const int = (k: Kit, a: number, b: number) => a + Math.floor(k.aux() * (b - a + 1));
const todayMs = (k: Kit) => Math.min(Date.parse(k.inDays(0, 9)), k.nowMs - 60_000);
const fill = (text: string, c: any) => text.replace(/\{first\}/g, c.first_name ?? '').replace(/\{last\}/g, c.last_name ?? '');

// --- conversations with a real back and forth ---------------------------------------------------------------------------------

type Line = [dir: 'in' | 'out', text: string];
type Thread = { channel: 'email' | 'sms' | 'whatsapp' | 'chat'; subject?: string; lines: Line[] };

const THREADS: Record<string, Thread[]> = {
  agency: [
    { channel: 'email', subject: 'Relaunch: Feedback zum Entwurf', lines: [
      ['in', 'Hallo zusammen,\n\nwir haben uns den Entwurf der Startseite angesehen – grundsätzlich super! Zwei Punkte: Das Foto oben wirkt etwas dunkel, und könnten die Öffnungszeiten weiter nach oben?\n\nViele Grüße\n{first}'],
      ['out', 'Hallo {first},\n\ndanke für das schnelle Feedback! Wir hellen das Bild auf und setzen die Öffnungszeiten direkt unter die Überschrift. Die neue Version kommt bis Donnerstag.\n\nBeste Grüße\nNordlicht Digital'],
      ['in', 'Perfekt, dann warten wir auf Donnerstag. Ist der Go-live am Monatsersten weiter realistisch?'],
      ['out', 'Ja, der Termin steht. Wir ziehen die Domain am Abend davor um, damit morgens alles läuft.'],
    ] },
    { channel: 'whatsapp', lines: [
      ['in', 'Kurze Frage: Unsere Google-Anzeige läuft seit gestern nicht mehr?'],
      ['out', 'Guten Morgen! Das Tagesbudget war aufgebraucht – ich habe es für den Rest der Woche auf 25 € erhöht, die Anzeige läuft wieder.'],
      ['in', 'Super, danke dir! 👍'],
    ] },
    { channel: 'chat', lines: [
      ['in', 'Hallo, was kostet bei euch eine Website für einen kleinen Handwerksbetrieb?'],
      ['out', 'Hallo! Unser Website-Paket S startet bei 2.490 € netto – bis zu fünf Seiten, inklusive Texte-Check. Magst du ein kostenloses Erstgespräch buchen?'],
      ['in', 'Gern, am liebsten nächste Woche vormittags.'],
      ['out', 'Ich habe dir Dienstag um 10 Uhr reserviert – die Bestätigung kommt per E-Mail.'],
    ] },
    { channel: 'sms', lines: [
      ['in', 'Bin 10 Minuten später beim Termin, Stau auf der A100.'],
      ['out', 'Kein Problem, wir warten. Bis gleich!'],
    ] },
    { channel: 'email', subject: 'Newsletter-Texte zur Freigabe', lines: [
      ['out', 'Hallo {first},\n\nanbei die Texte für den Dezember-Newsletter. Wenn bis Mittwoch nichts dagegen spricht, planen wir den Versand für Donnerstag 9 Uhr.\n\nViele Grüße\nNordlicht Digital'],
      ['in', 'Sieht gut aus! Nur beim Gutschein bitte „bis 24.12.“ statt „bis Weihnachten“.'],
    ] },
  ],
  physio: [
    { channel: 'email', subject: 'Rezept über 6× Krankengymnastik', lines: [
      ['in', 'Guten Tag,\n\nich habe ein Rezept über sechsmal Krankengymnastik (Lendenwirbelsäule) bekommen. Haben Sie in den nächsten zwei Wochen Termine, gern ab 17 Uhr?\n\nMit freundlichen Grüßen\n{first} {last}'],
      ['out', 'Hallo {first} {last},\n\nsehr gern! Wir können Ihnen dienstags und donnerstags jeweils 17:30 Uhr anbieten, Start nächste Woche. Bitte bringen Sie das Rezept und ein Handtuch mit.\n\nViele Grüße\nPraxis Sonnenweg'],
      ['in', 'Passt perfekt, danke! Muss ich vorher noch etwas beachten?'],
      ['out', 'Bequeme Kleidung reicht. Das Rezept muss innerhalb von 28 Tagen nach Ausstellung starten – das passt bei Ihnen.'],
    ] },
    { channel: 'whatsapp', lines: [
      ['in', 'Hallo, ich liege leider mit Fieber im Bett – kann ich den Termin morgen um 8 absagen?'],
      ['out', 'Gute Besserung! Wir haben den Termin storniert, es entstehen keine Kosten. Melden Sie sich gern, wenn es Ihnen besser geht.'],
      ['in', 'Danke, sehr nett!'],
    ] },
    { channel: 'chat', lines: [
      ['in', 'Bieten Sie auch Lymphdrainage an?'],
      ['out', 'Ja, manuelle Lymphdrainage gibt es mit Verordnung oder als Selbstzahler (45 Min. für 65 €). Möchten Sie einen Termin?'],
      ['in', 'Ich frage erst beim Arzt nach dem Rezept, danke!'],
    ] },
    { channel: 'sms', lines: [
      ['in', 'Ist im Rückenkurs am Mittwoch noch ein Platz frei?'],
      ['out', 'Es sind noch zwei Plätze frei – soll ich Sie eintragen?'],
      ['in', 'Ja bitte!'],
      ['out', 'Erledigt: Mittwoch 18 Uhr, Raum 2. Bis dann!'],
    ] },
  ],
  craft: [
    { channel: 'email', subject: 'Angebot PV-Anlage – Rückfragen', lines: [
      ['in', 'Guten Tag,\n\ndanke für das Angebot über die 9,8-kWp-Anlage. Zwei Fragen: Lässt sich ein Speicher später nachrüsten, und wie lange dauert die Anmeldung beim Netzbetreiber?\n\nMit freundlichen Grüßen\n{first} {last}'],
      ['out', 'Guten Tag {first} {last},\n\nder Wechselrichter ist speicherfähig – ein Speicher lässt sich jederzeit nachrüsten. Die Anmeldung übernehmen wir; der Netzbetreiber braucht erfahrungsgemäß drei bis sechs Wochen. Die Montage wäre ab KW 49 möglich.\n\nViele Grüße\nElektro Meyer'],
      ['in', 'Dann machen wir es so. Bitte schicken Sie mir die Auftragsbestätigung.'],
      ['out', 'Gern – die Auftragsbestätigung ist unterwegs. Unser Team meldet sich eine Woche vorher mit der genauen Uhrzeit.'],
    ] },
    { channel: 'whatsapp', lines: [
      ['in', 'Hallo, im Keller ist der FI rausgeflogen und lässt sich nicht mehr einschalten. Können Sie heute noch kommen?'],
      ['out', 'Bitte alle Geräte im betroffenen Kreis ausstecken und es noch einmal versuchen. Wenn es nicht klappt: Kollege Jan ist um 15:30 Uhr bei Ihnen.'],
      ['in', 'Geht leider immer noch nicht. 15:30 passt!'],
      ['out', 'Jan ist unterwegs. Die Notdienst-Pauschale entfällt, weil es innerhalb der Geschäftszeiten ist.'],
    ] },
    { channel: 'chat', lines: [
      ['in', 'Gibt es für eine Wallbox noch Förderung?'],
      ['out', 'Ein bundesweites Programm gibt es gerade nicht, aber einige Stadtwerke zahlen Zuschüsse. Wir prüfen das gern beim Vor-Ort-Termin für Sie.'],
    ] },
    { channel: 'sms', lines: [
      ['in', 'Seid ihr morgen um 7 auf der Baustelle Lindenstraße? Der Estrich kommt um 9.'],
      ['out', 'Ja, zwei Leute ab 7 Uhr – die Leerrohre im EG sind bis 9 fertig.'],
    ] },
  ],
  coach: [
    { channel: 'email', subject: 'Frage zum 1:1-Coaching', lines: [
      ['in', 'Hi!\n\nIch war bei der Masterclass und überlege, das 1:1-Coaching zu buchen. Wie viel Zeit pro Woche muss ich einplanen? Ich arbeite Vollzeit im Schichtdienst.\n\nLG {first}'],
      ['out', 'Hey {first},\n\nsuper, dass du dabei warst! Drei Einheiten à 30–40 Minuten reichen am Anfang völlig – wir bauen den Plan um deine Schichten herum. Magst du einen kostenlosen Strategie-Call buchen?\n\nSportliche Grüße\nFitWerk Coaching'],
      ['in', 'Ja, gerne! Am besten Mittwochnachmittag.'],
      ['out', 'Mittwoch 15 Uhr ist eingetragen – der Link zum Call kommt per Mail. Bis dann! 💪'],
    ] },
    { channel: 'whatsapp', lines: [
      ['in', 'Tag 21 von 30 geschafft!! Heute 5 km am Stück gelaufen 🎉'],
      ['out', 'Wie stark ist das denn! Teil das gern in der Community – das motiviert die anderen enorm.'],
      ['in', 'Mach ich 😊'],
    ] },
    { channel: 'chat', lines: [
      ['in', 'Kann ich „Fit in 30 Tagen“ auch mit Knieproblemen machen?'],
      ['out', 'Ja – zu jeder Übung gibt es eine gelenkschonende Variante. Bei akuten Beschwerden sprich bitte vorher kurz mit deinem Arzt.'],
    ] },
    { channel: 'email', subject: 'Rechnung auf die Firma', lines: [
      ['in', 'Hallo, kannst du mir die Rechnung fürs Coaching auf meine Firma ausstellen? Mein Arbeitgeber übernimmt die Hälfte.'],
      ['out', 'Klar – schick mir kurz die Firmenadresse, dann stelle ich sie dir neu aus.'],
    ] },
  ],
  saas: [
    { channel: 'email', subject: 'CSV-Import bricht bei Umlauten ab', lines: [
      ['in', 'Hallo Taktwerk-Team,\n\nwir testen gerade und wollen 46 Mitarbeitende per CSV importieren. Bei Namen mit Umlauten bricht der Import ab. Habt ihr einen Tipp?\n\nViele Grüße\n{first}'],
      ['out', 'Hallo {first},\n\ndanke für den Hinweis! Bitte speichere die Datei als „CSV UTF-8“ (in Excel unter „Speichern unter“). Deine Testphase habe ich vorsorglich um sieben Tage verlängert.\n\nViele Grüße\nSupport Taktwerk'],
      ['in', 'Hat geklappt, alle 46 sind drin. Und danke für die Verlängerung!'],
      ['out', 'Sehr gern! Wenn du magst, zeigen wir dir in 20 Minuten die Tauschbörse – einfach einen Termin buchen.'],
    ] },
    { channel: 'chat', lines: [
      ['in', 'Gibt es eine Schnittstelle zu unserem Lohnprogramm?'],
      ['out', 'Im Tarif Business exportierst du die Stunden mit Zuschlägen als CSV für die gängigen Lohnprogramme. Eine direkte Schnittstelle ist für das erste Quartal geplant.'],
      ['in', 'Gut zu wissen, dann schauen wir uns Business an.'],
    ] },
    { channel: 'email', subject: 'Kündigung zum Monatsende', lines: [
      ['in', 'Hallo,\n\nwir haben unseren Standort geschlossen und möchten Taktwerk zum Monatsende kündigen.\n\nGruß {first} {last}'],
      ['out', 'Hallo {first},\n\nschade, dass ihr geht – danke für das Vertrauen! Die Kündigung ist bestätigt. Euer Zugang bleibt bis zum Monatsende aktiv, danach könnt ihr 90 Tage lang alle Daten exportieren.\n\nViele Grüße\nTaktwerk Software'],
    ] },
    { channel: 'sms', lines: [
      ['in', 'Die Status-Seite zeigt eine Störung – betrifft das uns?'],
      ['out', 'Kurzer Ausfall beim Kalender-Abo seit 9:12 Uhr, wir sind dran. Die Schichtpläne selbst laufen normal.'],
      ['in', 'Danke für die schnelle Info!'],
    ] },
  ],
  shop: [
    { channel: 'email', subject: 'Falscher Mahlgrad geliefert', lines: [
      ['in', 'Moin!\n\nIch habe den Fördeblick als ganze Bohne bestellt, bekommen habe ich ihn gemahlen für Filter. Kann man das tauschen?\n\nGruß {first}'],
      ['out', 'Moin {first},\n\noh, das tut uns leid! Wir schicken dir heute eine neue Packung ganze Bohnen – die gemahlene darfst du behalten.\n\nLiebe Grüße aus der Rösterei'],
      ['in', 'Wow, danke! Da bestelle ich gern wieder.'],
    ] },
    { channel: 'whatsapp', lines: [
      ['in', 'Habt ihr am Samstag noch Plätze im Barista-Kurs? Wir wären zu zweit.'],
      ['out', 'Moin! Samstag 10 Uhr sind noch genau zwei Plätze frei. Soll ich sie für euch reservieren?'],
      ['in', 'Ja, bitte! Zahlen wir vor Ort?'],
      ['out', 'Gern vor Ort mit Karte oder bar. Ihr seid eingetragen ☕'],
    ] },
    { channel: 'chat', lines: [
      ['in', 'Welchen Espresso empfehlt ihr für einen Vollautomaten?'],
      ['out', 'Für Vollautomaten passt unser Hafenbohne Espresso super – schokoladig, wenig Säure und nicht zu ölig.'],
      ['in', 'Dann nehme ich zwei Packungen, danke!'],
    ] },
    { channel: 'email', subject: 'Firmengeschenke zu Weihnachten', lines: [
      ['in', 'Hallo,\n\nwir bräuchten 40 Geschenksets mit Kaffee und Karte bis zum 15.12. Ist das machbar und was kostet das?\n\nViele Grüße\n{first} {last}'],
      ['out', 'Hallo {first},\n\ndas schaffen wir! Ein Set mit 250 g Kaffee, Karte und Schleife kostet 14,90 € netto, ab 30 Stück 12,90 €. Ich schicke dir ein Angebot mit Musterbild.\n\nLiebe Grüße\nRösterei Hafenbohne'],
      ['in', 'Klingt gut, bitte das Angebot an mich.'],
    ] },
  ],
};

/** Conversations of the last days with several messages each – run after the backdating and dated here: a day each, the answers a little later. */
export async function seedThreads(k: Kit) {
  const db = k.app.db;
  for (const [ti, t] of (THREADS[k.plan.key] ?? []).entries()) {
    const c = k.contact(ti * 6 + 20);
    await k.step('thread', () =>
      db.tx(() => {
        const conv = getOrCreateConversation(k.app, k.L, c.id);
        let at = todayMs(k) - (ti * 2 + int(k, 0, 2)) * DAY - int(k, 60, 300) * 60e3;
        let last = '';
        for (const [dir, text] of t.lines) {
          const when = iso(Math.min(at, k.nowMs - 60_000));
          db.insert('messages', {
            id: id(), location_id: k.L, conversation_id: conv, contact_id: c.id, channel: t.channel, direction: dir,
            subject: t.channel === 'email' ? (dir === 'in' ? t.subject : `Re: ${t.subject}`) : '', body: fill(text, c),
            status: dir === 'in' ? 'received' : 'logged', error: '', source: dir === 'in' ? (t.channel === 'chat' ? 'Live-Chat' : 'eingehend') : 'Demo', created_at: when,
          });
          last = when;
          at += (t.channel === 'chat' ? int(k, 1, 4) : int(k, 12, 150)) * 60e3;
        }
        const end = t.lines[t.lines.length - 1];
        const prev = db.get<{ last_message_at: string | null }>('SELECT last_message_at FROM conversations WHERE id = ?', conv)?.last_message_at;
        if (!prev || prev < last) db.run('UPDATE conversations SET last_message_at = ?, last_message = ?, unread = ? WHERE id = ?', last, fill(end[1], c).slice(0, 120), end[0] === 'in' ? 1 : 0, conv);
        if (t.channel === 'chat') db.insert('chat_visitors', { token: token(16), location_id: k.L, contact_id: c.id, page: `${k.plan.website}/`, created_at: iso(todayMs(k) - (ti * 2 + 1) * DAY) });
      }),
    );
  }
}

// --- Google reviews with replies --------------------------------------------------------------------------------------------------

const GOOGLE: Record<string, [rating: number, text: string, reply: string][]> = {
  agency: [
    [5, 'Unsere neue Website ist schneller und bringt spürbar mehr Anfragen. Termine wurden immer eingehalten.', 'Danke für das tolle Feedback – es hat Spaß gemacht, mit euch zu arbeiten!'],
    [5, 'Endlich eine Agentur, die erklärt statt Fachchinesisch zu reden. Klare Empfehlung!', 'Vielen Dank! Genau so wollen wir arbeiten.'],
    [4, 'Gute Arbeit beim Relaunch, die Abstimmung hätte manchmal schneller gehen können.', 'Danke für die ehrliche Rückmeldung – wir haben unsere Abstimmungswege inzwischen verkürzt.'],
    [5, 'Google-Ads-Betreuung top: mehr Anfragen bei gleichem Budget.', ''],
    [5, 'Sehr kreatives Team, unser neues Logo kommt bei allen super an.', 'Das freut uns riesig – danke!'],
  ],
  physio: [
    [5, 'Nach sechs Terminen sind meine Rückenschmerzen deutlich besser. Sehr einfühlsames Team!', 'Das freut uns sehr – bleiben Sie in Bewegung! Ihr Team der Praxis Sonnenweg'],
    [5, 'Online-Termin in zwei Minuten gebucht, pünktlich drangekommen. So muss das sein.', 'Danke! Genau dafür haben wir die Online-Buchung eingeführt.'],
    [4, 'Kompetente Behandlung, nur Parkplätze sind in der Gegend knapp.', 'Danke für den Hinweis! Tipp: Im Parkhaus am Markt parken Sie mit unserem Stempel zwei Stunden kostenlos.'],
    [5, 'Der Rückenkurs am Mittwoch ist super – macht sogar Spaß.', ''],
    [3, 'Behandlung gut, aber ich musste 20 Minuten warten.', 'Das tut uns leid – an dem Tag ist eine Kollegin krank ausgefallen. Wir arbeiten daran, dass das die Ausnahme bleibt.'],
    [5, 'Sehr saubere Praxis und tolle Beratung zu Übungen für zu Hause.', 'Vielen Dank für die netten Worte!'],
  ],
  craft: [
    [5, 'PV-Anlage in zwei Tagen montiert, alles sauber hinterlassen. Anmeldung beim Netzbetreiber lief reibungslos.', 'Vielen Dank! Wir wünschen viele Sonnenstunden.'],
    [5, 'Notdienst am Sonntag kam innerhalb einer Stunde. Fairer Preis.', 'Danke – dafür sind wir da!'],
    [4, 'Gute Arbeit, das Angebot hat allerdings eine Woche gedauert.', 'Danke für die Rückmeldung – in der Hochsaison wird es manchmal knapp, wir arbeiten daran.'],
    [5, 'Wallbox installiert, alles erklärt, sehr freundlich.', ''],
    [5, 'Zuverlässiger Partner für unsere Wohnanlagen – seit Jahren.', 'Danke für das Vertrauen!'],
  ],
  coach: [
    [5, 'In 30 Tagen fitter als in zwei Jahren Fitnessstudio. Die Community ist Gold wert.', 'Wie schön! Danke, dass du dabei bist 💪'],
    [5, 'Das 1:1-Coaching hat mein Training komplett verändert – endlich ein Plan, der zu meinem Schichtdienst passt.', 'Danke dir – so soll es sein!'],
    [4, 'Gute Videos, ich hätte mir noch mehr Rezepte gewünscht.', 'Danke! Im neuen Ernährungskurs gibt es jetzt 20 weitere Rezepte.'],
    [5, 'Super motivierend und trotzdem realistisch.', ''],
  ],
  saas: [
    [5, 'Taktwerk hat unsere Schichtplanung von Excel befreit. Der Support antwortet blitzschnell.', 'Danke! Das hören wir gern.'],
    [4, 'Sehr einfache Bedienung, die Lohn-Schnittstelle fehlt uns noch.', 'Danke für das Feedback – die Schnittstelle kommt im ersten Quartal.'],
    [5, 'Die Tauschbörse spart unserer Leitung jede Woche Stunden.', ''],
    [5, 'Onboarding in einem Nachmittag, das Team war sofort dabei.', 'Danke, das freut uns sehr!'],
  ],
  shop: [
    [5, 'Der beste Espresso in Kiel! Und der Barista-Kurs war richtig gut.', 'Moin und danke! Bis zum nächsten Kurs ☕'],
    [5, 'Frisch geröstet, schnell geliefert, super freundlich.', 'Danke dir – schön, dass es geschmeckt hat!'],
    [4, 'Toller Kaffee, die Versandkosten könnten günstiger sein.', 'Danke! Ab 40 € liefern wir versandkostenfrei – vielleicht hilft das.'],
    [5, 'Gemütlicher Laden mit Blick aufs Wasser, tolle Beratung.', ''],
    [5, 'Unsere Firmengeschenke kamen super an – alles pünktlich.', 'Das freut uns – danke für die Bestellung!'],
    [5, 'Fördeblick Filterkaffee ist mein neuer Liebling.', ''],
  ],
};

export async function seedGoogleReviews(k: Kit) {
  const list = GOOGLE[k.plan.key];
  if (!list) return;
  const db = k.app.db;
  await k.step('google reviews', () =>
    db.tx(() => {
      const place = `demo-place-${k.plan.key}`;
      const today = todayMs(k);
      // more than the shown reviews: the profile has a history (rating and count over 120 days)
      const total = 38 + list.length * 7;
      db.run(
        `INSERT INTO google_places (location_id, api_key, place_id, place_name, place_address, maps_url, rating, total, connected_at, last_sync_at, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(location_id) DO NOTHING`,
        k.L, sealSecret(k.app, 'demo-ohne-verbindung'), place, k.plan.name, k.plan.address, `https://maps.example.org/?q=${encodeURIComponent(k.plan.name)}`, 4.8, total, iso(today - 300 * DAY), iso(k.nowMs), iso(k.nowMs),
      );
      for (let d = 119; d >= 0; d--) {
        const day = k.ymd(-d);
        const n = total - Math.floor((d * list.length * 7) / 120);
        db.run('INSERT OR IGNORE INTO google_review_stats (location_id, day, rating, total) VALUES (?, ?, ?, ?)', k.L, day, Math.round((4.6 + (0.2 * (119 - d)) / 119) * 10) / 10, n);
      }
      for (const [i, [rating, text, reply]] of list.entries()) {
        const c = k.contact(i * 5 + 11);
        const published = today - (2 + i * 9 + int(k, 0, 4)) * DAY;
        db.insert('google_reviews', {
          id: id(), location_id: k.L, place_id: place, review_key: `demo-${k.plan.key}-${i}`, author: `${c.first_name} ${String(c.last_name).slice(0, 1)}.`, author_url: '', author_photo: '',
          rating, text, language: 'de', published_at: iso(published), relative_time: '', link: '', contact_id: c.id, notified: 1,
          first_seen_at: iso(published + 3600e3), updated_at: iso(published + 3600e3), reply_text: reply, reply_at: reply ? iso(Math.min(published + int(k, 3, 30) * 3600e3, today)) : null,
        });
      }
    }),
  );
}

// --- social media: evergreen queues and an approval link ---------------------------------------------------------------------------

const SOCIAL: Record<string, { tips: string[]; approval: string[] }> = {
  agency: {
    tips: ['💡 Tipp: Antworte auf jede Google-Bewertung – auch auf die kritischen. Interessenten lesen die Antworten mit.', 'Wie schnell lädt deine Website auf dem Handy? Über 3 Sekunden springt jeder zweite Besucher ab. Wir prüfen es kostenlos.', 'Ein Kontaktformular mit drei Feldern bekommt mehr Anfragen als eins mit zehn. Weniger ist mehr!', 'Newsletter-Betreffzeilen unter 40 Zeichen werden häufiger geöffnet. Probier es aus.'],
    approval: ['Vorher/Nachher: Die neue Website der Bäckerei Morgenrot ist live! 🥐 Schneller, mobil optimiert und mit Online-Vorbestellung.', 'Wir suchen Verstärkung: Junior-Webdesigner (m/w/d) in Berlin. Jetzt bewerben!', 'Unser kostenloses Webinar „Mehr Anfragen über Google“ – nächster Termin am Donnerstag. Link in der Bio.'],
  },
  physio: {
    tips: ['Übung der Woche: Katze-Kuh im Vierfüßlerstand – 10 Wiederholungen mobilisieren die ganze Wirbelsäule. 🐈', 'Sitzt du gerade? Steh kurz auf und streck dich – dein Rücken sagt danke.', 'Wusstest du? Präventionskurse werden von vielen Krankenkassen bis zu 80 % bezuschusst.', 'Wärme oder Kälte bei Rückenschmerzen? Bei Verspannungen hilft meist Wärme.'],
    approval: ['Neu ab Januar: Rückenkurs am Samstagvormittag! Jetzt online anmelden.', 'Unser Team wächst: Willkommen, Lena! Sie verstärkt uns als Physiotherapeutin mit Schwerpunkt Sportverletzungen.', 'Zwischen den Jahren geöffnet: 27.–30.12. von 8 bis 14 Uhr.'],
  },
  craft: {
    tips: ['E-Check alle vier Jahre: Für Vermieter Pflicht, für alle anderen eine gute Idee. ⚡', 'PV-Anlage im Winter? Auch bei Kälte produzieren Module Strom – sogar effizienter als bei Hitze.', 'Sicherung fliegt immer wieder raus? Bitte nicht einfach erneut einschalten – lass es prüfen.', 'Smart Home nachrüsten geht auch im Altbau – meist ganz ohne Wände aufzustemmen.'],
    approval: ['Fertig: 9,8 kWp auf einem Einfamilienhaus in Hannover-List. Danke an Familie H. für das Vertrauen! ☀️', 'Wir bilden aus! Ausbildung zum Elektroniker (m/w/d) ab August – jetzt bewerben.', 'Zwischen den Jahren erreichbar: Notdienst rund um die Uhr unter unserer Hotline.'],
  },
  coach: {
    tips: ['3 Workouts à 20 Minuten pro Woche reichen für den Anfang. Konstanz schlägt Intensität. 💪', 'Trink ein Glas Wasser direkt nach dem Aufstehen – der einfachste Gesundheits-Hack.', 'Muskelkater? Lockere Bewegung hilft mehr als komplette Pause.', 'Meal-Prep am Sonntag spart dir unter der Woche jeden Tag 30 Minuten.'],
    approval: ['Die neue 30-Tage-Challenge startet am 1. Januar! Wer ist dabei? 🙋', 'Kundenstimme: „In 30 Tagen fitter als in zwei Jahren Fitnessstudio.“ – Danke, Sophie!', 'Live-Q&A am Donnerstag um 19 Uhr – stellt eure Fragen schon jetzt in die Kommentare.'],
  },
  saas: {
    tips: ['Schichtplan in 10 Minuten: Mit Vorlagen für Früh-, Spät- und Nachtschicht planst du die Woche per Klick.', 'Die Tauschbörse lässt dein Team Schichten selbst tauschen – du gibst nur noch frei.', 'Ruhezeiten im Blick: Taktwerk warnt automatisch, wenn zwischen zwei Schichten weniger als 11 Stunden liegen.', 'Tipp: Mit dem Kalender-Abo landen alle Schichten direkt im Handy-Kalender.'],
    approval: ['Neu in Taktwerk 2.0: Schichtgruppen für Küche, Service und Lager. Jetzt in der Warteliste eintragen!', 'Webinar: Schichtplanung ohne Excel – live am Mittwoch, 11 Uhr.', 'Danke an 40 Teams, die Taktwerk schon täglich nutzen! 🎉'],
  },
  shop: {
    tips: ['☕ Brüh-Tipp: 60 g Kaffee auf einen Liter Wasser – damit liegst du beim Filter fast immer richtig.', 'Kaffee immer luftdicht, dunkel und kühl lagern – aber bitte nicht im Kühlschrank.', 'Frisch gemahlen schmeckt am besten: Mahl nur so viel, wie du gerade brauchst.', 'Wassertemperatur für Filterkaffee: 92–96 °C, also kurz nach dem Kochen.'],
    approval: ['Rösttag! Diese Woche frisch: der neue Brasilien-Espresso mit Noten von Schokolade und Haselnuss.', 'Adventskalender mit 24 Kaffees – nur solange der Vorrat reicht! 🎄', 'Barista-Kurs im Januar: noch 4 Plätze frei. Jetzt buchen.'],
  },
};

export async function seedSocial(k: Kit) {
  const s = SOCIAL[k.plan.key];
  if (!s) return;
  const q = await k.call('POST', '/api/social-queues', { name: 'Tipps & Wissen', slots: [{ day: 'tue', time: '09:00' }, { day: 'thu', time: '18:30' }], recycle: true });
  if (q?.id) await k.call('POST', `/api/social-queues/${q.id}/items`, { items: s.tips.map((content) => ({ content })) });
  const reviewsQueue = await k.call('POST', '/api/social-queues', { name: 'Kundenstimmen', slots: [{ day: 'fri', time: '12:00' }], recycle: true });
  const quotes = (GOOGLE[k.plan.key] ?? []).filter(([r]) => r === 5).slice(0, 3).map(([, text]) => ({ content: `⭐⭐⭐⭐⭐ „${text}“` }));
  if (reviewsQueue?.id && quotes.length) await k.call('POST', `/api/social-queues/${reviewsQueue.id}/items`, { items: quotes });
  const link = await k.call('POST', '/api/social-approvals', { title: 'Posts für die nächsten zwei Wochen', posts: s.approval.map((content, i) => ({ content, date: k.inDays(3 + i * 4, 10) })) });
  // the client already looked at the link: one approved, one with a change request, one still open
  const ids: string[] = (link?.approvals ?? []).map((a: any) => a.id);
  await k.step('social approvals', () => {
    const [a, b] = ids;
    if (a) k.app.db.run(`UPDATE social_approvals SET status = 'approved', reviewer = 'Kunde', updated_at = ? WHERE id = ?`, now(), a);
    if (b) k.app.db.run(`UPDATE social_approvals SET status = 'changes', reviewer = 'Kunde', note = 'Bitte ein Foto vom Team statt Grafik.', updated_at = ? WHERE id = ?`, now(), b);
  });
}

// --- team (HR): employees, vacation and sick days ------------------------------------------------------------------------------------

const TEAM: Record<string, [first: string, last: string, position: string, department: string, type: string, hours: number][]> = {
  agency: [['Sven', 'Petersen', 'Geschäftsführer', 'Leitung', 'full', 40], ['Mara', 'Jensen', 'Webdesignerin', 'Design', 'full', 40], ['Tobias', 'Krüger', 'Entwickler', 'Entwicklung', 'full', 40], ['Ayla', 'Demir', 'Online-Marketing', 'Marketing', 'part', 30], ['Nils', 'Hansen', 'Werkstudent', 'Entwicklung', 'mini', 10]],
  physio: [['Katrin', 'Sonnleitner', 'Praxisinhaberin', 'Leitung', 'full', 40], ['Lena', 'Maurer', 'Physiotherapeutin', 'Therapie', 'full', 38], ['Daniel', 'Huber', 'Physiotherapeut', 'Therapie', 'full', 38], ['Sabine', 'Ostermann', 'Empfang', 'Verwaltung', 'part', 25], ['Jonas', 'Weiß', 'Masseur', 'Therapie', 'part', 20]],
  craft: [['Thomas', 'Meyer', 'Elektrotechnikermeister', 'Leitung', 'full', 40], ['Jan', 'Kowalski', 'Elektroniker', 'Montage', 'full', 40], ['Ali', 'Yıldız', 'Elektroniker', 'Montage', 'full', 40], ['Kevin', 'Brandes', 'Auszubildender', 'Montage', 'intern', 40], ['Petra', 'Meyer', 'Büro', 'Verwaltung', 'part', 20]],
  coach: [['Nina', 'Falk', 'Coach & Gründerin', 'Leitung', 'full', 40], ['Robin', 'Albers', 'Community-Manager', 'Community', 'part', 25], ['Jule', 'Peters', 'Video & Social Media', 'Marketing', 'freelance', 15]],
  saas: [['Martin', 'Vogt', 'CEO', 'Leitung', 'full', 40], ['Selin', 'Arslan', 'CTO', 'Entwicklung', 'full', 40], ['Felix', 'Groß', 'Entwickler', 'Entwicklung', 'full', 40], ['Hanna', 'Lehmann', 'Customer Success', 'Support', 'full', 40], ['Erik', 'Schröder', 'Vertrieb', 'Vertrieb', 'full', 40]],
  shop: [['Kai', 'Thomsen', 'Röster & Inhaber', 'Leitung', 'full', 40], ['Freya', 'Nielsen', 'Barista', 'Laden', 'part', 30], ['Ole', 'Carstens', 'Versand', 'Lager', 'mini', 12]],
};

export async function seedTeam(k: Kit) {
  const team = TEAM[k.plan.key];
  if (!team) return;
  const domain = new URL(k.plan.website).hostname;
  const people: string[] = [];
  for (const [i, [first, last, position, department, type, hours]] of team.entries()) {
    const e = await k.call('POST', '/api/hr/employees', {
      first_name: first, last_name: last, email: `${first.toLowerCase().replace(/ı/g, 'i').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')}@${domain}`, position, department,
      employment_type: type, weekly_hours: hours, start_date: k.ymd(-(1900 - i * 330)), ...(type === 'intern' ? { probation_end: k.ymd(-(1900 - i * 330) + 120) } : {}),
    });
    if (e?.id) people.push(e.id);
  }
  // past vacation, a sick day last week, an approved vacation ahead and an open request
  const plan: [who: number, type: string, from: number, to: number, decide?: 'approved'][] = [
    [1, 'vacation', -60, -51, 'approved'], [2, 'sick', -9, -8], [0, 'vacation', -33, -29, 'approved'], [1, 'vacation', 24, 30, 'approved'], [2, 'vacation', 40, 44], [3, 'sick', -2, -2],
  ];
  for (const [who, type, from, to, decide] of plan) {
    const emp = people[who % Math.max(people.length, 1)];
    if (!emp) continue;
    const [start, end] = [k.ymd(from), k.ymd(to)];
    // weekends hold no working day – move a lone weekend day to the Monday after
    const a = await k.call('POST', '/api/hr/absences', { employee_id: emp, type, start_date: start, end_date: end, note: type === 'sick' ? 'Krankmeldung liegt vor' : '' });
    if (a?.id && decide) await k.call('POST', `/api/hr/absences/${a.id}/approve`, { note: 'Viel Erholung!' });
  }
}

// --- NPS survey with answers ---------------------------------------------------------------------------------------------------------

const NPS_COMMENTS: Record<string, string[]> = {
  promoter: ['Immer freundlich und schnell – gerne wieder!', 'Top Beratung, ich habe euch schon zweimal weiterempfohlen.', 'Alles hat perfekt geklappt.', '', 'Sehr zuverlässig.', ''],
  passive: ['Gut, aber die Terminfindung dauert manchmal.', 'Passt, die Preise sind etwas hoch.', ''],
  detractor: ['Rückruf kam erst nach drei Tagen.', 'Die Rechnung war zuerst falsch.'],
};

export async function seedNps(k: Kit) {
  const c = await k.call('POST', '/api/surveys/nps', { name: `Kundenzufriedenheit ${new Date(k.nowMs).getFullYear()}`, question: `Wie wahrscheinlich ist es, dass du ${k.plan.name} Freunden oder Kollegen empfiehlst?` });
  if (!c?.id) return;
  const db = k.app.db;
  await k.step('nps answers', () =>
    db.tx(() => {
      const sentAt = todayMs(k) - 24 * DAY;
      db.run(`UPDATE nps_campaigns SET status = 'sent', sent_at = ?, created_at = ?, updated_at = ? WHERE id = ?`, iso(sentAt), iso(sentAt - 2 * DAY), iso(sentAt), c.id);
      const seen = new Set<string>();
      for (let i = 0; i < 34; i++) {
        const ct = k.contact(i * 2 + 3);
        if (seen.has(ct.id)) continue;
        seen.add(ct.id);
        db.run('INSERT OR IGNORE INTO nps_sends (campaign_id, contact_id, status, error, sent_at) VALUES (?, ?, ?, ?, ?)', c.id, ct.id, 'sent', '', iso(sentAt + i * 60e3));
        if (i % 4 === 3) continue; // not everyone answers
        const roll = k.aux();
        const score = roll < 0.66 ? int(k, 9, 10) : roll < 0.88 ? int(k, 7, 8) : int(k, 3, 6);
        const pool = score >= 9 ? NPS_COMMENTS.promoter : score >= 7 ? NPS_COMMENTS.passive : NPS_COMMENTS.detractor;
        const at = iso(sentAt + int(k, 1, 120) * 3600e3);
        db.insert('nps_responses', { id: id(), location_id: k.L, campaign_id: c.id, contact_id: ct.id, score, comment: pool[i % pool.length], created_at: at, updated_at: at });
      }
    }),
  );
}

// --- a sales sequence -----------------------------------------------------------------------------------------------------------------

const SEQUENCE: Partial<Record<string, { name: string; steps: Record<string, any>[] }>> = {
  agency: { name: 'Nachfassen nach dem Erstgespräch', steps: [
    { type: 'email', delay_days: 0, subject: 'Danke für das Gespräch, {{contact.first_name}}', body: 'Hallo {{contact.first_name}},\n\ndanke für das nette Gespräch! Wie besprochen schicke ich dir bis Freitag ein Angebot.\n\nViele Grüße\n{{user.name}}' },
    { type: 'task', delay_days: 3, title: 'Angebot fertigstellen und verschicken' },
    { type: 'email', delay_days: 4, subject: 'Fragen zum Angebot?', body: 'Hallo {{contact.first_name}},\n\nhast du schon Zeit gehabt, dir das Angebot anzusehen? Gern gehen wir es gemeinsam in 15 Minuten durch.', reply_in_thread: true },
    { type: 'call', delay_days: 5, title: 'Kurz anrufen und Entscheidung klären' },
  ] },
  craft: { name: 'PV-Anfrage: Angebot und Nachfassen', steps: [
    { type: 'email', delay_days: 0, subject: 'Ihre Anfrage zur Photovoltaik', body: 'Guten Tag {{contact.first_name}} {{contact.last_name}},\n\ndanke für Ihre Anfrage! Für ein genaues Angebot schauen wir uns Dach und Zählerschrank vor Ort an. Passt Ihnen ein Termin in der kommenden Woche?' },
    { type: 'call', delay_days: 2, title: 'Vor-Ort-Termin vereinbaren' },
    { type: 'email', delay_days: 7, subject: 'Ihr Angebot – noch Fragen?', body: 'Guten Tag {{contact.first_name}} {{contact.last_name}},\n\nhaben Sie noch Fragen zum Angebot? Die Montage ist aktuell in etwa sechs Wochen möglich.', reply_in_thread: true },
  ] },
  saas: { name: 'Testphase: Aktivierung', steps: [
    { type: 'email', delay_days: 0, subject: 'Willkommen bei Taktwerk – dein erster Plan in 10 Minuten', body: 'Hallo {{contact.first_name}},\n\nschön, dass du Taktwerk testest! Starte mit einer Schichtvorlage – in zehn Minuten steht dein erster Wochenplan.' },
    { type: 'email', delay_days: 3, subject: 'Tipp: Lass dein Team Schichten tauschen', body: 'Hallo {{contact.first_name}},\n\nmit der Tauschbörse tauscht dein Team Schichten selbst – du gibst nur noch frei.' },
    { type: 'call', delay_days: 4, title: 'Check-in-Call: Läuft der Test? Fragen klären' },
    { type: 'email', delay_days: 4, subject: 'Noch 3 Tage Testphase', body: 'Hallo {{contact.first_name}},\n\ndeine Testphase endet in drei Tagen. Mit einem Klick auf „Tarif wählen“ geht alles nahtlos weiter.' },
  ] },
};

export async function seedSequence(k: Kit) {
  const spec = SEQUENCE[k.plan.key];
  if (!spec) return;
  const s = await k.call('POST', '/api/sequences', { name: spec.name, description: 'Schritt für Schritt – endet automatisch, sobald der Kontakt antwortet.', steps: spec.steps });
  if (!s?.id) return;
  // active, but nobody enrolled: a sequence sends from the user's own mailbox, and the demo has none connected
  await k.call('PATCH', `/api/sequences/${s.id}`, { status: 'active' });
}

// --- loyalty programme ------------------------------------------------------------------------------------------------------------------

export async function seedLoyalty(k: Kit) {
  if (!['shop', 'physio', 'coach'].includes(k.plan.key)) return;
  const reward = k.plan.key === 'shop' ? 'Gratis-Packung Kaffee (500 g)' : k.plan.key === 'physio' ? 'Massage (30 Min.) gratis' : 'Monat Community gratis';
  await k.call('PUT', '/api/loyalty/settings', {
    enabled: true,
    notify: false,
    points_per_euro: 1,
    tiers: [{ name: 'Bronze', min_points: 0 }, { name: 'Silber', min_points: 250 }, { name: 'Gold', min_points: 750 }],
    rewards: [{ name: `Gutschein 10 €`, points: 200, kind: 'gift_card', value: 1000 }, { name: reward, points: 400, kind: 'gift_card', value: k.plan.key === 'shop' ? 1690 : 3900 }],
  });
  const reasons = k.plan.key === 'shop' ? ['Einkauf im Laden', 'Online-Bestellung', 'Barista-Kurs', 'Bewertung geschrieben'] : k.plan.key === 'physio' ? ['Behandlung Selbstzahler', 'Präventionskurs', 'Freundin geworben', 'Bewertung geschrieben'] : ['Programm gekauft', 'Challenge abgeschlossen', 'Freund geworben', 'Bewertung geschrieben'];
  for (let i = 0; i < 18; i++) {
    const c = k.contact(i * 3 + 1);
    for (let j = 0; j < 1 + (i % 4); j++) await k.call('POST', `/api/loyalty/contacts/${c.id}/adjust`, { points: [40, 85, 120, 25, 160, 60][(i + j) % 6] * (i % 5 === 0 ? 3 : 1), reason: reasons[(i + j) % reasons.length] });
  }
  await k.step('loyalty dates', () => {
    for (const [i, row] of k.app.db.all<{ id: string }>('SELECT id FROM loyalty_ledger WHERE location_id = ? ORDER BY rowid', k.L).entries())
      k.app.db.run('UPDATE loyalty_ledger SET created_at = ? WHERE id = ?', iso(todayMs(k) - ((i * 37) % 170) * DAY - int(k, 0, 600) * 60e3), row.id);
  });
}

// --- inventory ----------------------------------------------------------------------------------------------------------------------------

const STOCK: Partial<Record<string, { places: [string, string][]; supplier: string; articles: [sku: string, name: string, unit: string, qty: number, min: number, costCents: number][] }>> = {
  shop: {
    places: [['Rösterei-Lager', 'LAG'], ['Laden', 'LAD']],
    supplier: 'Rohkaffee-Import Nord GmbH',
    articles: [['RK-BRA-60', 'Rohkaffee Brasilien Cerrado (60-kg-Sack)', 'Sack', 4, 2, 41000], ['RK-ETH-60', 'Rohkaffee Äthiopien Sidamo (60-kg-Sack)', 'Sack', 1, 2, 52000], ['RK-COL-60', 'Rohkaffee Kolumbien Huila (60-kg-Sack)', 'Sack', 3, 1, 46500], ['VP-500', 'Ventilbeutel 500 g, kraft', 'Stk', 1800, 500, 18], ['VP-250', 'Ventilbeutel 250 g, kraft', 'Stk', 240, 400, 14], ['ET-HB', 'Etiketten Hafenbohne (Rolle)', 'Rolle', 6, 2, 2900], ['VK-S', 'Versandkarton S', 'Stk', 320, 100, 45]],
  },
  craft: {
    places: [['Hauptlager Werkstatt', 'HL'], ['Transporter 1', 'T1'], ['Transporter 2', 'T2']],
    supplier: 'Elektro-Großhandel Leine KG',
    articles: [['NYM-3x1.5', 'NYM-J 3×1,5 mm² (Ring 100 m)', 'Ring', 14, 5, 6900], ['NYM-5x2.5', 'NYM-J 5×2,5 mm² (Ring 50 m)', 'Ring', 3, 4, 9800], ['WB-11', 'Wallbox 11 kW', 'Stk', 3, 2, 62000], ['FI-40', 'FI-Schutzschalter 40 A, Typ A', 'Stk', 9, 4, 3800], ['LS-B16', 'Leitungsschutzschalter B16', 'Stk', 64, 20, 290], ['SD-UP', 'Schalterdose Unterputz', 'Stk', 410, 150, 25], ['STD-R', 'Steckdose reinweiß', 'Stk', 85, 40, 390]],
  },
  physio: {
    places: [['Praxislager', 'PL']],
    supplier: 'Therapiebedarf Süd GmbH',
    articles: [['TB-M', 'Theraband mittel (Rolle 5,5 m)', 'Rolle', 12, 4, 1490], ['MO-1L', 'Massageöl neutral 1 l', 'Flasche', 3, 4, 1250], ['KT-5', 'Kinesio-Tape 5 cm', 'Rolle', 24, 10, 690], ['LK-50', 'Liegenauflagen (50 Stk.)', 'Pack', 7, 3, 1990]],
  },
};

export async function seedInventory(k: Kit, products: any[]) {
  const spec = STOCK[k.plan.key];
  if (!spec) return;
  const places: any[] = [];
  for (const [name, code] of spec.places) {
    const p = await k.call('POST', '/api/inventory/places', { name, code });
    if (p?.id) places.push(p);
  }
  const articles: any[] = [];
  for (const [sku, name, unit, qty, min, cost] of spec.articles) {
    const a = await k.call('POST', '/api/inventory/articles', { sku, name, unit, min_stock: min, reorder_qty: min * 3, supplier_name: spec.supplier, initial_qty: qty + min * 2, initial_cost_cents: cost });
    if (a?.id) articles.push({ ...a, qty, min, cost });
  }
  // the shop's own products are stock articles too (sold through the store)
  if (k.plan.key === 'shop')
    for (const p of products) {
      const a = await k.call('POST', '/api/inventory/articles/from-product', { product_id: p.id });
      if (a?.id) await k.call('POST', '/api/inventory/movements', { article_id: a.id, type: 'receipt', qty: 40 + (p.price_cents % 7) * 6, unit_cost_cents: Math.round(p.price_cents * 0.38), note: 'Röstung KW' });
    }
  // usage over the last weeks brings some articles under their minimum
  for (const [i, a] of articles.entries()) {
    const used = a.min * 2;
    for (let j = 0; j < 3; j++) await k.call('POST', '/api/inventory/movements', { article_id: a.id, type: 'issue', qty: Math.max(1, Math.round(used / 3)), note: ['Baustelle / Auftrag', 'Verbrauch', 'Entnahme'][j] });
    if (i === 2 && places[1]) await k.call('POST', '/api/inventory/transfers', { article_id: a.id, from_place_id: places[0].id, to_place_id: places[1].id, qty: 1, note: 'Für die Woche umgelagert' });
  }
  const low = articles.filter((a) => a.qty < a.min);
  const draft = await k.call('POST', '/api/inventory/orders', { supplier_name: spec.supplier, expected_at: k.ymd(6), notes: 'Nachbestellung Mindestbestand', lines: (low.length ? low : articles.slice(0, 2)).map((a) => ({ article_id: a.id, qty: a.min * 3, unit_cost_cents: a.cost })) });
  const placed = await k.call('POST', '/api/inventory/orders', { supplier_name: spec.supplier, expected_at: k.ymd(2), notes: 'Monatsbestellung', lines: articles.slice(-2).map((a) => ({ article_id: a.id, qty: a.min * 2, unit_cost_cents: a.cost })) });
  if (placed?.id) await k.call('POST', `/api/inventory/orders/${placed.id}/place`, {});
  void draft;
  await k.step('inventory dates', () => {
    const db = k.app.db;
    for (const [i, m] of db.all<{ id: string }>('SELECT id FROM inv_movements WHERE location_id = ? ORDER BY rowid', k.L).entries())
      db.run('UPDATE inv_movements SET created_at = ? WHERE id = ?', iso(todayMs(k) - Math.max(0, 40 - i * 2) * DAY - int(k, 0, 480) * 60e3), m.id);
  });
}

// --- canvas boards ----------------------------------------------------------------------------------------------------------------------

const BOARDS: Record<string, [name: string, mermaid: string][]> = {
  agency: [
    ['Kundenreise Website-Relaunch', 'flowchart LR\n  A[Anfrage über Website] --> B[Erstgespräch 30 Min.]\n  B --> C{Passt das Projekt?}\n  C -->|Ja| D[Angebot in 48 h]\n  C -->|Nein| E[Empfehlung an Partner]\n  D --> F[Kick-off & Moodboard]\n  F --> G[Entwurf & Feedback]\n  G --> H[Go-live]\n  H --> I[Wartungsvertrag]'],
    ['Content-Plan Q1', 'flowchart TD\n  J[Januar: Website-Check-Aktion] --> F[Februar: Google-Profil-Webinar]\n  F --> M[März: Kundenstimmen-Serie]\n  M --> R[Review: Anfragen je Kanal]'],
  ],
  physio: [['Ablauf Neupatient', 'flowchart LR\n  A[Online-Buchung] --> B[Erinnerung per SMS]\n  B --> C[Erstbefund 60 Min.]\n  C --> D{Rezept vorhanden?}\n  D -->|Ja| E[6× KG planen]\n  D -->|Nein| F[Selbstzahler-Angebot]\n  E --> G[Abschlussgespräch]\n  G --> H[Bewertung anfragen]']],
  craft: [['Ablauf PV-Projekt', 'flowchart LR\n  A[Anfrage] --> B[Vor-Ort-Termin]\n  B --> C[Angebot]\n  C --> D{Auftrag?}\n  D -->|Ja| E[Material bestellen]\n  E --> F[Montage 2 Tage]\n  F --> G[Anmeldung Netzbetreiber]\n  G --> H[Inbetriebnahme & Übergabe]\n  D -->|Nein| I[Nachfassen in 14 Tagen]']],
  coach: [['Funnel Masterclass', 'flowchart LR\n  A[Instagram-Reel] --> B[Landingpage Masterclass]\n  B --> C[Anmeldung]\n  C --> D[Webinar live]\n  D --> E{Angebot angenommen?}\n  E -->|Ja| F[Fit in 30 Tagen]\n  E -->|Nein| G[E-Mail-Serie 5 Tage]\n  F --> H[Community & 1:1-Upsell]']],
  saas: [
    ['Roadmap Taktwerk 2.0', 'flowchart TD\n  Q4[Q4: Schichtgruppen] --> Q1[Q1: Lohn-Schnittstelle]\n  Q1 --> Q2[Q2: App für die Tauschbörse]\n  Q2 --> Q3[Q3: KI-Vorschläge für Pläne]'],
    ['Customer Journey Testphase', 'flowchart LR\n  A[Warteliste] --> B[Testphase 14 Tage]\n  B --> C[Onboarding-Mails]\n  C --> D[Check-in-Call Tag 4]\n  D --> E{Tarif gewählt?}\n  E -->|Ja| F[Kunde]\n  E -->|Nein| G[Feedback-Umfrage]'],
  ],
  shop: [['Weg der Bohne', 'flowchart LR\n  A[Rohkaffee-Import] --> B[Röstung donnerstags]\n  B --> C[Abfüllen & Etikett]\n  C --> D{Kanal}\n  D --> E[Laden]\n  D --> F[Online-Shop]\n  D --> G[Café-Belieferung]\n  F --> H[Versand DHL]']],
};

export async function seedCanvas(k: Kit) {
  for (const [i, [name, mermaid]] of (BOARDS[k.plan.key] ?? []).entries()) {
    const b = await k.call('POST', '/api/canvas', { name, description: 'Demo-Board – frei bearbeitbar', mermaid });
    if (b?.id && i === 0) await k.call('POST', `/api/canvas/${b.id}/comments`, { body: 'Sieht gut aus – lass uns den Schritt mit der Bewertung noch automatisieren.' });
  }
  if (k.plan.key === 'agency') await k.call('POST', '/api/canvas', { name: 'SWOT Nordlicht Digital 2027', template: 'swot' });
}

// --- affiliates: clicks, referrals, commissions and a payout ------------------------------------------------------------------------------

export async function seedAffiliateDepth(k: Kit) {
  if (k.plan.key !== 'coach') return;
  const db = k.app.db;
  const affs = db.all<{ id: string; program_id: string }>('SELECT id, program_id FROM affiliates WHERE location_id = ? ORDER BY rowid', k.L);
  if (!affs.length) return;
  await k.step('affiliate history', () =>
    db.tx(() => {
      for (const [ai, a] of affs.entries()) {
        for (let d = 0; d < 60; d++) for (let n = 0; n < (ai === 0 ? 4 : 2) + (d % 3); n++) db.insert('affiliate_clicks', { id: id(), location_id: k.L, affiliate_id: a.id, visitor_id: token(8), ip_hash: '', landing: '/masterclass', referrer: ai === 0 ? 'instagram.com' : 'podcast', counted: 1, reason: '', created_at: iso(todayMs(k) - d * DAY - int(k, 0, 600) * 60e3) });
        for (let r = 0; r < (ai === 0 ? 9 : 5); r++) {
          const c = k.contact(30 + ai * 10 + r);
          const at = todayMs(k) - (3 + r * 9) * DAY;
          db.run('INSERT OR IGNORE INTO affiliate_referrals (location_id, contact_id, affiliate_id, program_id, touch_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', k.L, c.id, a.id, a.program_id, iso(at), iso(at));
          const paid = r >= 4;
          db.insert('affiliate_commissions', { id: id(), location_id: k.L, program_id: a.program_id, affiliate_id: a.id, contact_id: c.id, invoice_id: `demo-${a.id}-${r}`, kind: 'sale', base_cents: 14900, amount_cents: 3725, currency: 'EUR', status: paid ? 'paid' : r < 2 ? 'pending' : 'approved', note: 'Fit in 30 Tagen', created_at: iso(at), approved_at: r < 2 ? null : iso(at + 14 * DAY), paid_at: paid ? iso(at + 30 * DAY) : null });
        }
      }
    }),
  );
}

// --- after the history is dated: credit notes, bookkeeping with a year of costs --------------------------------------------------------------

/** Running costs per business: account (SKR03), text, monthly gross in euros (0 = part of the variable budget), tax code, every n months, day of month. */
type Cost = [account: string, text: string, euros: number, tax: string, every: number, day: number];
const COSTS: Record<string, { ratio: number; fixed: Cost[]; variable: [account: string, text: string, weight: number, tax: string][] }> = {
  agency: { ratio: 0.7, fixed: [['4210', 'Büromiete Lindenallee', 1428, 'vst19', 1, 3], ['4240', 'Strom Büro', 96, 'vst19', 1, 15], ['4920', 'Telefon und Internet', 71.4, 'vst19', 1, 8], ['4806', 'Software-Abos (Design, Hosting)', 345.1, 'vst19', 1, 1], ['4360', 'Betriebshaftpflicht', 61.2, 'none', 1, 1], ['4955', 'Steuerberatung', 297.5, 'vst19', 3, 20], ['4970', 'Kontoführung', 14.9, 'none', 1, 30]], variable: [['4120', 'Gehälter', 0.78, 'none'], ['4930', 'Bürobedarf', 0.02, 'vst19'], ['4650', 'Bewirtung Kundentermin', 0.02, 'vst19'], ['4610', 'Werbung Google Ads (eigene)', 0.06, 'vst19']] },
  physio: { ratio: 0.74, fixed: [['4210', 'Praxismiete Sonnenweg', 2380, 'none', 1, 3], ['4240', 'Strom und Heizung', 214, 'vst19', 1, 15], ['4920', 'Telefon und Internet', 59.9, 'vst19', 1, 8], ['4806', 'Praxissoftware', 119, 'vst19', 1, 1], ['4360', 'Berufshaftpflicht', 48.5, 'none', 1, 1], ['4955', 'Steuerberatung', 238, 'vst19', 3, 20], ['4970', 'Kontoführung und Kartenterminal', 39.5, 'none', 1, 30]], variable: [['4120', 'Gehälter', 0.82, 'none'], ['4930', 'Praxisbedarf (Tapes, Öle, Bänder)', 0.06, 'vst19'], ['4610', 'Werbung', 0.03, 'vst19']] },
  craft: { ratio: 0.8, fixed: [['4210', 'Miete Werkstatt und Lager', 1785, 'vst19', 1, 3], ['4240', 'Strom Werkstatt', 248, 'vst19', 1, 15], ['4920', 'Mobilfunk und Internet', 129, 'vst19', 1, 8], ['4806', 'Handwerkersoftware', 89, 'vst19', 1, 1], ['4360', 'Betriebs- und Kfz-Versicherung', 312, 'none', 1, 1], ['4955', 'Steuerberatung', 357, 'vst19', 3, 20], ['4970', 'Kontoführung', 19.9, 'none', 1, 30]], variable: [['3400', 'Material Großhandel', 0.55, 'vst19'], ['4120', 'Gehälter', 0.36, 'none'], ['4530', 'Diesel Transporter', 0.05, 'vst19']] },
  coach: { ratio: 0.58, fixed: [['4210', 'Studio-Miete (Drehtage)', 595, 'vst19', 1, 3], ['4920', 'Telefon und Internet', 49.9, 'vst19', 1, 8], ['4806', 'Software (Video, Mail, Kurse)', 214.2, 'vst19', 1, 1], ['4955', 'Steuerberatung', 178.5, 'vst19', 3, 20], ['4970', 'Kontoführung', 9.9, 'none', 1, 30]], variable: [['4610', 'Werbung Instagram', 0.45, 'vst19'], ['4120', 'Gehälter', 0.45, 'none'], ['4930', 'Equipment und Bürobedarf', 0.1, 'vst19']] },
  saas: { ratio: 0.96, fixed: [['4210', 'Büro im Coworking', 1190, 'vst19', 1, 3], ['4806', 'Server und Cloud-Hosting', 642.6, 'vst19', 1, 1], ['4920', 'Telefon und Internet', 59.9, 'vst19', 1, 8], ['4360', 'Cyber- und Haftpflichtversicherung', 98, 'none', 1, 1], ['4955', 'Steuerberatung und Lohnbuchhaltung', 476, 'vst19', 1, 20], ['4970', 'Kontoführung', 19.9, 'none', 1, 30]], variable: [['4120', 'Gehälter', 0.85, 'none'], ['4610', 'Werbung und Messen', 0.1, 'vst19'], ['4650', 'Bewirtung', 0.05, 'vst19']] },
  shop: { ratio: 0.79, fixed: [['4210', 'Miete Laden und Rösterei', 1650, 'none', 1, 3], ['4240', 'Gas und Strom Röster', 386, 'vst19', 1, 15], ['4920', 'Telefon und Internet', 44.9, 'vst19', 1, 8], ['4806', 'Kassensystem und Shop', 79, 'vst19', 1, 1], ['4360', 'Versicherungen', 87, 'none', 1, 1], ['4955', 'Steuerberatung', 214, 'vst19', 3, 20], ['4910', 'Porto DHL', 0, 'vst19', 1, 28]], variable: [['3300', 'Rohkaffee Einkauf', 0.6, 'vst7'], ['4120', 'Gehälter', 0.32, 'none'], ['4930', 'Verpackung', 0.08, 'vst19']] },
};

/** A few credit notes on paid invoices (goodwill, a returned item) – before the bookkeeping, so they are booked too. */
export async function seedCreditNotes(k: Kit) {
  const db = k.app.db;
  const paid = db.all<any>(`SELECT id, items FROM invoices WHERE location_id = ? AND kind = 'invoice' AND status = 'paid' ORDER BY issued_at DESC LIMIT 12`, k.L);
  const reasons = ['Kulanz: Termin verschoben', 'Rabatt nachträglich gewährt', 'Rücksendung'];
  for (const [i, inv] of paid.filter((_, j) => j % 5 === 2).slice(0, 2).entries()) {
    const items = JSON.parse(inv.items || '[]');
    const first = items[0];
    if (!first) continue;
    const part = Math.max(100, Math.round(first.price_cents * (i === 0 ? 0.1 : 1)));
    await k.call('POST', `/api/invoices/${inv.id}/credit-note`, { items: [{ name: `${first.name}${i === 0 ? ' – 10 % Nachlass' : ''}`, qty: 1, price_cents: part, tax_rate: first.tax_rate ?? 19 }], reason: reasons[(i + k.plan.key.length) % reasons.length] });
  }
}

export async function seedBookkeeping(k: Kit) {
  const spec = COSTS[k.plan.key];
  if (!spec) return;
  const db = k.app.db;
  const setup = await k.call('POST', '/api/accounting/setup', { standard: 'skr03', vat_mode: 'regular' });
  if (!setup?.ok) return;
  await k.step('autopost', () => {
    for (let round = 0; round < 40; round++) {
      const r = syncInvoices(k.app, k.L, { limit: 500 });
      if (r.errors.length) throw new Error(r.errors[0]);
      if (!r.posted && !r.payments && !r.cancelled) break;
    }
  });
  // a year of running costs: about `ratio` of what came in, fixed costs at most 45 % of it, the rest variable
  const revenue = Number(db.get<{ n: number }>(`SELECT COALESCE(SUM(total_cents), 0) n FROM invoices WHERE location_id = ? AND kind = 'invoice' AND status = 'paid' AND paid_at >= ?`, k.L, iso(k.nowMs - 365 * DAY))?.n ?? 0);
  const target = revenue * spec.ratio;
  const fixedYear = spec.fixed.reduce((n, [, , euros, , every]) => n + euros * 100 * (12 / every), 0);
  const f = fixedYear ? Math.min(1, (0.45 * target) / fixedYear) : 1;
  const monthly = Math.max(0, target - fixedYear * f) / 12;
  const entries: { date: string; text: string; account: string; cents: number; tax: string }[] = [];
  const base = new Date(k.nowMs);
  for (let m = 11; m >= 0; m--) {
    const month = new Date(base.getFullYear(), base.getMonth() - m, 1);
    const at = (day: number) => {
      const d = new Date(month.getFullYear(), month.getMonth(), Math.min(day, 28), 12);
      return d.getTime() <= k.nowMs - DAY ? d.toISOString().slice(0, 10) : null;
    };
    const label = month.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    for (const [account, text, euros, tax, every, day] of spec.fixed) {
      if ((11 - m) % every) continue;
      const date = at(day);
      const cents = euros ? (f < 1 ? Math.round(euros * f) * 100 : Math.round(euros * 100)) : Math.round(monthly * 0.04 * (0.85 + k.aux() * 0.3));
      if (date && cents > 0) entries.push({ date, text: `${text} ${label}`, account, cents, tax });
    }
    for (const [vi, [account, text, weight, tax]] of spec.variable.entries()) {
      const date = at(account === '4120' ? 28 : 6 + vi * 5);
      const cents = Math.round(monthly * weight * (account === '4120' ? 1 : 0.8 + k.aux() * 0.4));
      if (date && cents > 0) entries.push({ date, text: `${text} ${label}`, account, cents, tax });
    }
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  await k.step('running costs', () =>
    db.tx(() => {
      for (const [i, e] of entries.entries())
        postEntry(k.app, k.L, {
          date: e.date, doc_date: e.date, due_date: null, text: e.text, doc_ref: `ER-${e.date.slice(0, 7).replace('-', '')}-${String(i + 1).padStart(3, '0')}`, source: 'manual',
          postings: [{ debit: e.account, credit: '1200', amount_cents: e.cents, tax_code: e.tax as any, text: e.text }], party_name: '', contact_id: null, user_id: k.me.id, actor: k.me.name,
        });
    }),
  );
}
