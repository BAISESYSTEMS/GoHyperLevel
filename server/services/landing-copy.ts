/**
 * Launch landing page: every visible text in German and English. `Copy` is one interface, so a missing English (or German)
 * text is a type error – the landing page's own translation check. `{b}` is the product name (agency branding, see
 * modules/landing.ts). Claims here must be backed by the code or a dated source (docs/landing.md lists them).
 */

export type Lang = 'de' | 'en';

export interface Copy {
  lang: Lang;
  locale: string;
  title: string;
  description: string;
  nav: { features: string; stack: string; calc: string; compare: string; apps: string; pricing: string; faq: string; switchLang: string; switchLangLabel: string; login: string };
  hero: { eyebrow: string; h1: string; rotate: string[]; sub: string; subStrong: string; badges: string[]; ctaDemo: string; ctaSelf: string; ctaCloud: string; star: string; starCount: (n: string) => string; mockLabel: string; mockAlt: string[] };
  ai: { h2: string; lead: string; items: [string, string][]; tools: (n: string) => string; snippetLabel: string; snippetNote: string; docs: string };
  proof: { title: string; areas: string; tools: string; integrations: string; tests: string; note: string };
  calc: {
    h2: string;
    lead: string;
    modes: string;
    modeMix: string;
    modeHl: string;
    mixLead: string;
    mixTools: string;
    mixPerSeat: string;
    resultMix: (eur: string, n: number) => string;
    mixFoot: (date: string, rate: string) => string;
    plan: string;
    plans: { starter: string; unlimited: string; pro: string };
    subs: string;
    wlApp: string;
    wlAppHint: string;
    hosting: string;
    self: string;
    cloud: string;
    submit: string;
    resultHl: (usd: string, plan: string) => string;
    resultUs: (what: string) => string;
    save: (eur: string) => string;
    bumped: string;
    saasSelf: string;
    ourPlan: { self: string; solo: string; team: string; agency: string };
    perMonth: string;
    perYear: string;
    share: string;
    shareText: (eur: string) => string;
    foot: (date: string, rate: string) => string;
  };
  features: { h2: string; lead: string; items: [string, string][]; more: string };
  dach: { h2: string; lead: string; items: [string, string][] };
  move: { h2: string; lead: string; steps: [string, string][]; note: string };
  vsHl: { h2: string; lead: string; colFeature: string; colHl: string; colUs: string; rows: [string, string, string][]; foot: (date: string) => string; appNote: string };
  hlPage: { title: string; description: string; h1: string; lead: string; message: string; messageNote: string; factsH2: string; facts: string[]; importH2: string; cta: string };
  disclaimer: (date: string) => string;
  matrix: { h2: string; lead: string; all: string; asOf: (d: string) => string; sources: string; yes: string; partial: string; no: string; addon: string; unlisted: string; from: string; empty: string; vendorCol: string; pageTitle: string; pageLead: string; priceRow: string; ourPrice: string; priceNote: string; notes: string; more: string; hlMore: string; whyH2: string; whyLead: string };
  choose: { h2: string; lead: string; cloud: { title: string; price: string; items: string[]; verdict: string }; self: { title: string; price: string; items: string[]; verdict: string }; switch: string };
  stack: { h2: string; lead: string; colFeature: string; colReplaces: string; colPrice: string; included: string; partial: string; unique: string; from: string; total: string; totalUs: string; totalUsNote: string; totalCloud: string; perMonth: string; noPrice: string; onRequest: string; about: string; cheapest: string; fullOnly: (rows: number, eur: string) => string; notCounted: string; usage: string; foot: (date: string, priced: number, rows: number) => string; noConversion: string; converted: (rate: string, source: string) => string };
  pricing: {
    h2: string;
    lead: string;
    self: { name: string; price: string; tag: string; items: string[]; cta: string };
    solo: { name: string; tag: string; items: string[] };
    team: { name: string; tag: string; items: string[] };
    agency: { name: string; tag: string; badge: string; items: string[] };
    perMonth: string;
    yearly: (eur: string) => string;
    vat: string;
    allFeatures: string;
    ctaCloud: string;
  };
  wl: { h2: string; lead: string; items: [string, string][]; saas: string; appsLink: string };
  apps: {
    h2: string;
    lead: string;
    android: { title: string; sub: (v: string, mb: string) => string; subNone: string; button: string; sha: string; qr: string; steps: string[]; firstStart: string; none: string };
    ios: { title: string; sub: string; button: string; qr: string; steps: string[]; works: string; worksItems: string[]; note: string };
    xr: { title: string; sub: string; items: string[]; note: string; docs: string };
    agency: string;
  };
  install: { h2: string; lead: string; copy: string; copied: string; github: string; docs: string; note: string };
  faq: { h2: string; items: [string, string][] };
  foot: { imprint: string; privacy: string; source: string; robot: string; madeIn: string; noTracking: string };
}

const de: Copy = {
  lang: 'de',
  locale: 'de-DE',
  title: '{b} – die Open-Source-Alternative zu GoHighLevel: CRM, Funnels, Automationen, KI',
  description: 'CRM, Postfach, Funnels, Automationen und KI in einer App. Selbst gehostet kostenlos (AGPL), in der Cloud ab 49,99 € im Monat – ohne Gebühr pro Nutzer.',
  nav: { features: 'Funktionen', stack: 'Tool-Stack', calc: 'Rechner', compare: 'Vergleich', apps: 'Apps', pricing: 'Preise', faq: 'FAQ', switchLang: 'EN', switchLangLabel: 'English version', login: 'Anmelden' },
  hero: {
    eyebrow: 'Open Source · Selbst gehostet kostenlos · Cloud ab 49,99 €',
    h1: 'Deine Plattform für',
    rotate: ['Vertrieb & CRM', 'Funnels & Websites', 'E-Mail-Marketing', 'Online-Kurse', 'Terminbuchung', 'Rechnungen', 'KI-Agenten'],
    sub: 'Schluss mit teuren All-in-One-Abos: {b} ist Open Source – selbst gehostet kostenlos oder in unserer Cloud ab 49,99 €. CRM, Funnels, Automationen und KI in einem, mit MCP für Claude und Codex.',
    subStrong: 'Dein Stack gehört dir.',
    badges: ['Open Source (AGPL)', 'MCP für Claude, Codex, ChatGPT, Cursor', 'Gehostet in Frankfurt', 'DSGVO'],
    ctaDemo: 'Live-Demo testen',
    ctaSelf: 'Mit 1 Befehl selbst hosten',
    ctaCloud: 'Cloud starten',
    star: 'auf GitHub',
    starCount: (n) => `${n} Sterne`,
    mockLabel: 'Echte Bildschirme aus der Demo',
    mockAlt: ['Workflow-Editor mit Auslöser und Schritten', 'Gemeinsames Postfach mit einer E-Mail-Unterhaltung', 'Website-Baukasten mit Seitenvorschau', 'Pipeline mit Deals in jeder Phase'],
  },
  ai: {
    h2: 'Gebaut für KI-Agenten',
    lead: 'Dein CRM als Werkzeugkasten für Claude, Codex, ChatGPT und Cursor – mit denselben Rechten und demselben Protokoll wie ein Mensch.',
    items: [
      ['MCP-Server eingebaut', 'Über einen Endpunkt /mcp mit OAuth 2.1 (PKCE) oder API-Schlüssel. Jede Aktion läuft mit deinen Rechten und landet im Protokoll.'],
      ['In einer Minute verbunden', 'Schlüssel mit einem Klick und fertige Befehle für Codex, Claude Code und Cursor; Anmeldung per OAuth für ChatGPT und Claude.ai.'],
      ['Agent in der App', 'Der eingebaute KI-Agent sucht Kontakte, pflegt Deals, legt Aufgaben an – und fragt vor dem Senden, Löschen und Bezahlen.'],
      ['Dein Modell, dein Abo', 'Eigene Schlüssel für jedes Modell (BYOK) – oder dein ChatGPT- bzw. Claude-Abo auf den offiziellen Wegen: als Connector in ChatGPT/Claude oder über die lokale Bridge mit den offiziellen CLIs.'],
    ],
    tools: (n) => `${n} MCP-Werkzeuge`,
    snippetLabel: 'Codex oder Claude Code verbinden',
    snippetNote: 'Aus der Doku (docs/ai-tools.md). Ohne Schlüssel melden sich beide per OAuth an.',
    docs: 'Anleitung für alle KI-Werkzeuge',
  },
  proof: { title: 'Gezählt, nicht behauptet', areas: 'Bereiche', tools: 'MCP-Werkzeuge', integrations: 'Integrationen', tests: 'automatische Tests', note: 'Zahlen aus dem laufenden Code und dem Repository beim Build.' },
  calc: {
    h2: 'Was sparst du?',
    lead: 'Der Link merkt sich dein Ergebnis – teil ihn.',
    modes: 'Vergleichen mit',
    modeMix: 'Typischer Tool-Mix',
    modeHl: 'Von HighLevel',
    mixLead: 'Welche Tools zahlst du heute?',
    mixTools: 'Deine Tools',
    mixPerSeat: 'Preise für einen Nutzer, monatlich; manche Tools kosten je weiterem Nutzer extra.',
    resultMix: (eur, n) => `Deine ${n} Tools: rund ${eur} im Monat`,
    mixFoot: (date, rate) => `Einstiegspreise laut Anbieter-Webseiten, Stand ${date}; Dollar-Preise umgerechnet zum EZB-Referenzkurs (1 € = ${rate} $).`,
    plan: 'Dein HighLevel-Tarif',
    plans: { starter: 'Starter · 97 $ (3 Sub-Accounts)', unlimited: 'Unlimited · 297 $ (unbegrenzt Sub-Accounts)', pro: 'Agency Pro · 497 $ (SaaS-Modus)' },
    subs: 'Sub-Accounts',
    wlApp: 'White-Label-Mobile-App',
    wlAppHint: 'bei HighLevel 497 $ im Monat extra',
    hosting: 'So nutzt du {b}',
    self: 'Selbst gehostet',
    cloud: 'Cloud',
    submit: 'Berechnen',
    resultHl: (usd, plan) => `HighLevel ${plan}: ${usd} im Monat`,
    resultUs: (what) => `{b}: ${what}`,
    save: (eur) => `Du sparst ${eur} im Jahr.`,
    bumped: 'Starter hat nur 3 Sub-Accounts – gerechnet mit Unlimited.',
    saasSelf: 'Den SaaS-Modus (Weiterverkauf mit eigenen Tarifen) gibt es bei uns selbst gehostet, nicht in der Cloud – gerechnet mit 0 €.',
    ourPlan: { self: 'selbst gehostet 0 €', solo: 'Cloud Solo', team: 'Cloud Team & Company', agency: 'Cloud Agentur' },
    perMonth: 'im Monat',
    perYear: 'im Jahr',
    share: 'Ergebnis teilen',
    shareText: (eur) => `Ich spare ${eur} im Jahr mit {b} statt HighLevel – Open Source, selbst gehostet gratis.`,
    foot: (date, rate) => `HighLevel-Listenpreise vom ${date} (gohighlevel.com/pricing), monatlich; umgerechnet zum EZB-Referenzkurs vom ${date} (1 € = ${rate} $). Selbst gehostet zahlst du deinen Server (meist 5–15 € im Monat), keine Lizenz.`,
  },
  features: {
    h2: 'Alles, wofür du sonst fünf Abos bezahlst',
    lead: 'Eine Node-App, eine SQLite-Datei, unbegrenzt Sub-Accounts.',
    items: [
      ['CRM & Pipelines', 'Kontakte, Firmen, Deals, Aufgaben, eigene Objekte und Lead-Scoring.'],
      ['Gemeinsames Postfach', 'E-Mail, SMS, WhatsApp, Messenger, Instagram und Telefon in einer Liste.'],
      ['Funnels & Websites', 'Seiten-Baukasten mit Vorlagen, Blog, A/B-Tests und BFSG-Prüfung.'],
      ['Automationen', 'Workflows mit Auslösern, Bedingungen, Wartezeiten – und ein KI-Workflow-Builder.'],
      ['KI-Agent & MCP', 'Claude, ChatGPT und Co. arbeiten über MCP mit deinen Rechten im CRM.'],
      ['Kalender & Buchung', 'Online-Buchung, Team-Kalender, Round Robin, Zahlung bei Buchung.'],
      ['Kurse & Community', 'Mitgliederbereich, Quiz, Zertifikate, Community und Webinare.'],
      ['Rechnungen & Buchhaltung light', 'Angebote, Rechnungen, Mahnwesen, SEPA, DATEV-Export.'],
      ['Helpdesk', 'Tickets, SLAs, Wissensdatenbank und Kundenportal.'],
      ['Agentur & White-Label', 'Sub-Accounts, Kunden-Logins, eigene Domains, Snapshots, SaaS-Modus.'],
      ['Telefonie & Voice', 'Browser-Telefon, Warteschlangen, IVR und ein KI-Telefonagent.'],
      ['Apps', 'Android-App mit 13 Widgets und Web-App für iPhone und iPad.'],
    ],
    more: 'Alle Funktionen im README',
  },
  dach: {
    h2: 'Dein CRM gehört dir.',
    lead: 'Gebaut für Firmen in Deutschland, Österreich und der Schweiz.',
    items: [
      ['DSGVO', 'Einwilligungs-Nachweis, Double-Opt-in, Auskunft und Löschung auf Knopfdruck, AVV-Vorlage.'],
      ['GoBD-orientiert', 'Lückenlose Rechnungsnummern, festgeschriebene Rechnungen, Audit-Log, Belegarchiv.'],
      ['XRechnung & ZUGFeRD', 'E-Rechnungen erstellen und eingehende exakt einlesen.'],
      ['SEPA', 'Lastschrift-Mandate und Überweisungsdateien – auch ohne Stripe.'],
      ['DATEV', 'Buchungsstapel und Belege für deine Steuerberatung.'],
      ['Server in der EU', 'Selbst gehostet auf deinem Server, die Cloud läuft in Frankfurt am Main.'],
    ],
  },
  move: {
    h2: 'Von HighLevel in einem Rutsch',
    lead: 'Der eingebaute HighLevel-Import holt deinen Sub-Account herüber.',
    steps: [
      ['Token anlegen', 'In HighLevel unter Einstellungen → Private Integrations einen Token erstellen.'],
      ['Import starten', 'In {b} unter Einstellungen → Import einfügen und den Sub-Account wählen.'],
      ['Fertig', 'Kontakte, eigene Felder, Tags, Pipelines, Deals, Kalender und Termine sind da. Nochmal laufen lassen legt nichts doppelt an.'],
    ],
    note: 'Funnels und Workflows überträgt der Import nicht – dafür gibt es Vorlagen. Aus 25 weiteren Tools (HubSpot, Mailchimp, ActiveCampaign, Pipedrive …) holt der Umzugs-Assistent die Daten.',
  },
  vsHl: {
    h2: '{b} und HighLevel im Vergleich',
    lead: 'Listenpreise im Monat, nüchtern nebeneinander.',
    colFeature: 'Was du brauchst',
    colHl: 'HighLevel',
    colUs: '{b}',
    rows: [
      ['Einstieg', 'Starter: 97 $ (3 Sub-Accounts)', 'Selbst gehostet 0 € · Cloud Solo 49,99 €'],
      ['Unbegrenzt Sub-Accounts', 'Unlimited: 297 $', 'Selbst gehostet 0 € · Cloud Agentur 199 €'],
      ['SaaS-Modus (Weiterverkauf unter eigener Marke)', 'Agency Pro: 497 $', 'Selbst gehostet 0 € · in der Cloud nicht enthalten'],
      ['White-Label der Web-App', 'in den FAQ beschrieben, ohne Tarif-Angabe', 'Selbst gehostet 0 € · Cloud Agentur 199 €'],
      ['White-Label-Mobile-App', '497 $ Zusatz im Monat, oder im Enterprise-Tarif (Preis auf Anfrage)', 'teilweise – via PWA-Install mit deinem Namen und Icon (Android zusätzlich als APK), nicht in den App-Stores²'],
      ['Telefon- und E-Mail-Weiterverrechnung', 'Unlimited ohne Aufschlag, Agency Pro mit Aufschlag', 'selbst gehostet: eigene Anbieter-Schlüssel, direkt beim Anbieter bezahlt · Cloud: SMS zum Selbstkostenpreis oder eigene Schlüssel'],
      ['Quellcode', 'proprietär', 'offen (AGPL-3.0)'],
    ],
    foot: (date) => `Quelle: gohighlevel.com/pricing, abgerufen am ${date}.`,
    appNote: '² Keine App im App Store oder Play Store: die Web-App installiert man aus dem Browser, die APK lädt man vom Server. Die eigene Android-APK baust du mit der dokumentierten Anleitung.',
  },
  hlPage: {
    title: '{b} statt HighLevel: Preise, SaaS-Modus, White-Label und Umzug',
    description: 'HighLevel kostet 97 $ bis 497 $ im Monat, die White-Label-App 497 $ extra. {b} ist Open Source: selbst gehostet 0 €, White-Label in der Cloud ab 199 €. Mit HighLevel-Import.',
    h1: 'Von HighLevel zu {b}',
    lead: 'Was HighLevel kostet, was {b} kostet – und wie dein Sub-Account in einem Rutsch umzieht.',
    message: 'White-Label in der Cloud ab 199 €, SaaS-Modus selbst gehostet ab 0 €. Bei HighLevel beginnt der SaaS-Modus bei 497 $ im Monat, die White-Label-Mobile-App kostet weitere 497 $ im Monat.',
    messageNote: 'Unsere gebrandete App ist eine installierbare Web-App (PWA) plus eine selbst gebaute Android-APK, keine App im Store. Den SaaS-Modus (Weiterverkauf mit eigenen Tarifen und eigenem Stripe) gibt es selbst gehostet, in der Cloud noch nicht.',
    factsH2: 'HighLevel-Preise laut Preisseite',
    facts: ['Starter 97 $ im Monat: 3 Sub-Accounts.', 'Unlimited 297 $ im Monat: unbegrenzt Sub-Accounts, Telefon- und E-Mail-Weiterverrechnung ohne Aufschlag.', 'Agency Pro 497 $ im Monat: SaaS-Modus (Weiterverkauf unter eigener Marke), Weiterverrechnung mit Aufschlag.', 'White-Label-Mobile-App: 497 $ im Monat zusätzlich, oder im Enterprise-Tarif (Preis auf Anfrage).', 'White-Label der Desktop-Web-App: in den FAQ beschrieben, ohne Tarif-Angabe.'],
    importH2: 'Der HighLevel-Import',
    cta: 'Live-Demo öffnen',
  },
  disclaimer: (date) => `{b} ist ein unabhängiges Open-Source-Projekt und nicht mit HighLevel Inc. oder den anderen genannten Anbietern verbunden. Alle Marken gehören ihren Inhabern. Preise laut Anbieter-Webseiten, Stand ${date}.`,
  matrix: {
    h2: 'Vergleich mit anderen Tools',
    lead: 'Funktionen und Einstiegspreise, mit Quelle je Angabe.',
    all: 'Alle',
    asOf: (d) => `Stand ${d}`,
    sources: 'Quellen',
    yes: 'ja',
    partial: 'teilweise',
    no: 'nein',
    addon: 'gegen Aufpreis',
    unlisted: 'nicht ausgewiesen',
    from: 'ab',
    empty: 'Die Vergleichstabelle wird gerade aktualisiert.',
    vendorCol: 'Funktion',
    pageTitle: 'Vergleich: {b} und andere CRM- und Marketing-Tools',
    pageLead: 'Funktionen und Listenpreise von HighLevel, HubSpot, ActiveCampaign, ClickFunnels, systeme.io, Kajabi, Keap und weiteren – mit Quelle und Datum je Angabe.',
    priceRow: 'Einstiegspreis',
    ourPrice: '0 € / ab 49,99 €',
    priceNote: 'Preise in der Währung des Anbieters, monatlich; „nicht ausgewiesen“ heißt: auf den Seiten des Anbieters nicht genannt',
    notes: 'Anmerkungen',
    more: 'Ganze Vergleichstabelle',
    hlMore: 'Alles zu HighLevel',
    whyH2: 'Warum wechseln?',
    whyLead: 'Je Anbieter: was {b} zusätzlich bietet – und wo der andere heute besser ist.',
  },
  choose: {
    h2: 'Cloud oder selbst hosten?',
    lead: 'Dieselbe Software, alle Funktionen. Der Unterschied ist, wer den Server betreibt.',
    cloud: {
      title: 'Cloud',
      price: 'Solo 49,99 € · Team & Company 99,99 € · Agentur 199 €',
      items: [
        'In wenigen Minuten startklar – ohne Server, Docker oder Linux-Kenntnisse.',
        'Updates und Sicherheits-Patches spielen wir ein.',
        'Tägliche Server-Backups; deinen Datenexport (ZIP) machst du jederzeit selbst.',
        'TLS-Zertifikate und Betrieb übernehmen wir; eigene Domains im Tarif Agentur.',
        'Gehostet in Deutschland (Frankfurt am Main). AVV schließt du bei der Anmeldung ab und lädst ihn als PDF.',
        'KI-Kontingent, Push-Mitteilungen und die Apps funktionieren ohne Einrichtung.',
        'Keine Grenzen für Kontakte, Funnels und Workflows (Fair Use für E-Mails, KI und Speicher).',
        'Tarif Agentur: White-Label und Kunden-Sub-Accounts.',
      ],
      verdict: 'Für alle, die arbeiten wollen statt Server zu pflegen.',
    },
    self: {
      title: 'Selbst hosten',
      price: '0 € · AGPL-3.0',
      items: [
        'Volle Kontrolle: dein Server, deine Daten, deine Regeln.',
        'Kostenlos, ohne Grenzen, mit dem ganzen Quellcode – anpassbar bis ins Letzte.',
        'Inklusive SaaS-Modus: Sub-Accounts mit eigenen Tarifen über dein Stripe verkaufen.',
        'Updates, Backups, Sicherheit, TLS und E-Mail-Zustellbarkeit liegen bei dir – mit Anleitungen für Docker-Installation, Backups und Updates.',
        'Hilfe aus der Community über GitHub Issues und Discussions.',
      ],
      verdict: 'Für alle, die ihren Server selbst betreiben wollen – oder müssen.',
    },
    switch: 'Wechseln: Aus der Cloud exportierst du jederzeit alles als ZIP (JSON, CSV und Dateien); Kontakte liest der CSV-Import wieder ein. Einen kompletten Umzug zwischen Cloud und eigenem Server auf Knopfdruck gibt es noch nicht.',
  },
  stack: {
    h2: 'Ersetzt deinen Tool-Stack',
    lead: 'Was du sonst einzeln bezahlst – und was davon {b} mitbringt.',
    colFeature: 'Funktion',
    colReplaces: 'Ersetzt',
    colPrice: 'Andere Tools (Monat)',
    included: 'Inklusive',
    partial: 'Teilweise',
    unique: 'Selbst hostbar nur bei {b}',
    from: 'ab',
    total: 'Tool-Stack',
    totalUs: '0 €',
    totalUsNote: '(selbst gehostet)',
    totalCloud: 'Cloud ab 49,99 €/Monat',
    perMonth: '/ Monat',
    noPrice: 'kein öffentlicher Preis belegt',
    onRequest: 'Preis auf Anfrage',
    about: 'ab ca.',
    cheapest: 'günstigstes Tool je Zeile, 1 Nutzer, netto',
    fullOnly: (rows, eur) => `Nur die ${rows} vollständig abgedeckten Zeilen: ca. ${eur} im Monat.`,
    notCounted: 'Mit * markierte Zeilen zählen nicht zur Summe.',
    usage: 'Bei {b} kommen Nutzungskosten beim eigenen Anbieter hinzu (SMS, E-Mail-Versand, KI, Telefonminuten); manche Tools enthalten dafür ein Kontingent. Tools mit „Preis auf Anfrage“ zählen nicht.',
    foot: (date, priced, rows) => `Einstiegspreise laut Anbieter-Webseiten ohne MwSt., Stand ${date}; je Zeile das günstigste Tool für einen Nutzer. Die Summe umfasst ${priced} von ${rows} Zeilen. Quellen:`,
    noConversion: 'USD-Preise ohne Umrechnung.',
    converted: (rate, source) => `Dollar-Preise für die Summe umgerechnet${rate ? ` (1 € = ${rate.replace('.', ',')} $)` : ''}, Kursquelle: ${source}; in der Tabelle stehen die Preise in der Währung des Anbieters.`,
  },
  pricing: {
    h2: 'Preise',
    lead: 'Keine Gebühr pro Nutzer, kein Kontakt-Limit. Alle Funktionen in jedem Tarif – White-Label und Kunden-Accounts nur im Tarif Agentur.',
    self: { name: 'Selbst gehostet', price: '0 €', tag: 'Open Source unter AGPL-3.0', items: ['Alle Funktionen inklusive White-Label und SaaS-Modus', 'Unbegrenzt Nutzer, Kontakte, Sub-Accounts', 'Dein Server, deine Daten'], cta: 'Installieren' },
    solo: { name: 'Cloud Solo', tag: 'Für dich allein', items: ['1 Nutzer', 'Unbegrenzt Kontakte, Funnels, Workflows', 'Alle Funktionen außer White-Label und Kunden-Accounts'] },
    team: { name: 'Cloud Team & Company', tag: 'Für Teams und Firmen', items: ['Unbegrenzt Nutzer – keine Gebühr pro Platz', 'Unbegrenzt Kontakte, Funnels, Workflows', 'Alle Funktionen außer White-Label und Kunden-Accounts'] },
    agency: { name: 'Cloud Agentur', tag: 'White-Label für Agenturen', badge: 'White-Label', items: ['Deine Marke statt unserer: Name, Logo, Farben', 'Eigene Login-Domain und Domains für Kunden', 'App mit deinem Namen und Icon', 'Unbegrenzt Nutzer und Kunden-Sub-Accounts'] },
    perMonth: '/ Monat',
    yearly: (eur) => `oder ${eur} im Jahr`,
    vat: 'Preise netto zzgl. gesetzlicher USt.; die Steuer berechnet Stripe Tax beim Bezahlen nach deinem Land (Reverse Charge für Unternehmen in der EU mit USt-IdNr.).',
    allFeatures: 'Alle Funktionen in jedem Tarif – White-Label und Kunden-Accounts nur im Tarif Agentur.',
    ctaCloud: 'Cloud starten',
  },
  wl: {
    h2: 'White-Label im Tarif Agentur',
    lead: 'Für 199 € im Monat sehen deine Kunden deine Marke, nicht unsere.',
    items: [
      ['Name, Logo, Farben', 'Im Login, in der App und im Browser-Tab – für dich und für jeden Kunden einzeln.'],
      ['Login-Domain', 'crm.deine-agentur.de statt unserer Adresse; das Zertifikat kommt von selbst.'],
      ['Domains für Kunden', 'Jeder Kunden-Account bekommt auf Wunsch seine eigene Domain.'],
      ['Gebrandete App', 'Die installierbare Web-App trägt deinen Namen und dein Icon. Eine eigene Android-APK baust du mit der dokumentierten Anleitung.'],
      ['Kunden-Sub-Accounts', 'Getrennte Konten mit eigenen Logins, ohne Aufpreis pro Kunde.'],
    ],
    saas: 'Weiterverkaufen mit eigenen Tarifen und eigenem Stripe (SaaS-Modus) gehört zum selbst gehosteten Betrieb – in der Cloud ist er nicht enthalten.',
    appsLink: 'Zu den Apps',
  },
  apps: {
    h2: 'Apps für Android, iPhone, iPad und XR',
    lead: 'Ohne App Store: die Android-App kommt direkt von unserem Server, iPhone, iPad und XR-Brillen nutzen die Web-App.',
    android: {
      title: 'Android',
      sub: (v, mb) => `APK · v${v} · ${mb} MB`,
      subNone: 'APK · bald verfügbar',
      button: 'Android-App laden',
      sha: 'SHA-256',
      qr: 'QR-Code zur Download-Seite',
      steps: [
        'Auf dem Handy die APK laden (oder den QR-Code scannen).',
        'Datei öffnen. Fragt Android nach, für den Browser „Apps aus dieser Quelle zulassen“ einschalten.',
        '„Installieren“ tippen. Warnt Play Protect, über „Weitere Details“ → „Trotzdem installieren“ bestätigen.',
        'Updates meldet die App selbst und prüft die Prüfsumme.',
      ],
      firstStart: 'Diese APK verbindet sich mit unserer Cloud. Für deinen eigenen Server baust du die App mit deiner Adresse oder lädst sie von deiner Instanz unter /android.',
      none: 'Die APK ist noch nicht hochgeladen.',
    },
    ios: {
      title: 'iPhone & iPad · Web-App',
      sub: 'Zum Home-Bildschirm hinzufügen',
      button: 'Web-App öffnen',
      qr: 'QR-Code zur Web-App',
      steps: ['Die Web-App in Safari öffnen (QR-Code scannen).', 'Unten auf „Teilen“ tippen.', '„Zum Home-Bildschirm“ wählen und „Hinzufügen“ tippen.', 'Vom Home-Bildschirm starten und anmelden.'],
      works: 'Was funktioniert',
      worksItems: ['Push-Mitteilungen ab iOS 16.4', 'Zähler am App-Symbol', 'Startet offline mit der App-Hülle', 'Vollbild ohne Browser-Leiste'],
      note: 'Eine Web-App für iPhone und iPad, keine App aus dem App Store.',
    },
    xr: {
      title: 'XR- und Datenbrillen (Beta)',
      sub: 'Im Browser der Brille – ohne App Store',
      items: [
        'Raum-Modus: große Ziele für Blick, Pinch und Controller, gut lesbares Glas',
        'Arbeitsfläche: 2–4 Seiten nebeneinander für Ultrawide-Monitore und die virtuellen Riesenbildschirme von Datenbrillen',
        'Boards und Canvas als schwebende Panels in WebXR – ohne WebXR als 3D-Vorschau im Browser',
        'Für Meta Quest, Apple Vision Pro, Android XR und Display-Brillen',
      ],
      note: 'Beta: im Browser und mit einer simulierten WebXR-Brille getestet, noch nicht auf jeder echten Brille. Raum-Modus und 3D-Vorschau laufen überall.',
      docs: 'So funktioniert XR',
    },
    agency: 'Agenturen bekommen beide Apps unter ihrer Marke: die Web-App automatisch mit Name und Icon, die Android-APK baust du mit dem dokumentierten Skript selbst.',
  },
  install: {
    h2: 'Mit einem Befehl installiert',
    lead: 'Auf jedem Linux-Server mit Docker und einer Domain – mit automatischem HTTPS.',
    copy: 'Kopieren',
    copied: 'Kopiert',
    github: 'Quellcode auf GitHub',
    docs: 'Anleitung',
    note: 'Das Skript zeigt vor jedem Schritt, was es tut. Lieber von Hand: git clone, .env anpassen, docker compose up.',
  },
  faq: {
    h2: 'Häufige Fragen',
    items: [
      ['Ist {b} wirklich kostenlos?', 'Selbst gehostet ja: Open Source unter AGPL-3.0, alle Funktionen, keine Nutzer- oder Kontaktgrenzen. Du zahlst nur deinen Server. Die Cloud kostet ab 49,99 € im Monat zzgl. USt.'],
      ['Wie unterscheidet sich {b} von HighLevel?', '{b} deckt die Kernbereiche ab – CRM, Postfach, Funnels, Automationen, Kalender, Kurse, Rechnungen – und ist Open Source. Nicht alles ist gleich: eine App im Store gibt es bei uns nicht, und manche Integrationen fehlen. Die Vergleichstabelle zeigt beides.'],
      ['Kann ich von HighLevel umziehen?', 'Ja. Der HighLevel-Import holt Kontakte, eigene Felder, Tags, Pipelines, Deals, Kalender und Termine. Funnels und Workflows baust du mit Vorlagen nach.'],
      ['Wo liegen meine Daten?', 'Selbst gehostet auf deinem Server. In der Cloud in Frankfurt am Main, Deutschland – mit Auftragsverarbeitungsvertrag.'],
      ['Gibt es eine Gebühr pro Nutzer?', 'Nein. Cloud Team & Company und Cloud Agentur haben unbegrenzt Nutzer zum gleichen Preis.'],
      ['Was bedeutet AGPL für meine Agentur?', 'Du darfst {b} frei nutzen, anpassen und für Kunden betreiben. Wer eine veränderte Fassung als Dienst anbietet, muss den geänderten Quellcode den Nutzern zugänglich machen.'],
      ['Gibt es eine Demo?', 'Ja, mit erfundenen Daten. Sie wird jede Nacht zurückgesetzt und verschickt nichts nach außen.'],
    ],
  },
  foot: { imprint: 'Impressum', privacy: 'Datenschutz', source: 'Quellcode (AGPL-3.0)', robot: 'The Android robot is reproduced or modified from work created and shared by Google and used according to terms described in the Creative Commons 3.0 Attribution License.', madeIn: 'Open Source aus Deutschland', noTracking: 'Diese Seite setzt keine Cookies und lädt nichts von Dritten.' },
};

const en: Copy = {
  lang: 'en',
  locale: 'en-GB',
  title: '{b} – the open-source alternative to GoHighLevel: CRM, funnels, automation, AI',
  description: 'CRM, inbox, funnels, automations and AI in one app. Free to self-host (AGPL), cloud from €49.99 a month – no per-seat fee.',
  nav: { features: 'Features', stack: 'Stack', calc: 'Calculator', compare: 'Compare', apps: 'Apps', pricing: 'Pricing', faq: 'FAQ', switchLang: 'DE', switchLangLabel: 'Deutsche Version', login: 'Sign in' },
  hero: {
    eyebrow: 'Open source · Self-host free · Cloud from €49.99',
    h1: 'Your platform for',
    rotate: ['sales & CRM', 'funnels & websites', 'email marketing', 'online courses', 'bookings', 'invoicing', 'AI agents'],
    sub: 'Sick of all-in-one platforms that drain your wallet? {b} is open source – self-host it for free or run it in our cloud from €49.99. CRM, funnels, automation and AI in one, with MCP for Claude and Codex.',
    subStrong: 'Own your stack.',
    badges: ['Open source (AGPL)', 'MCP for Claude, Codex, ChatGPT, Cursor', 'Hosted in Frankfurt', 'GDPR'],
    ctaDemo: 'Try the live demo',
    ctaSelf: 'Self-host in 1 command',
    ctaCloud: 'Start in the cloud',
    star: 'on GitHub',
    starCount: (n) => `${n} stars`,
    mockLabel: 'Real screens from the demo',
    mockAlt: ['Workflow editor with a trigger and steps', 'Shared inbox with an e-mail conversation', 'Website builder with a page preview', 'Pipeline with deals in every stage'],
  },
  ai: {
    h2: 'Built for AI agents',
    lead: 'Your CRM as a toolbox for Claude, Codex, ChatGPT and Cursor – with the same permissions and the same audit log as a person.',
    items: [
      ['MCP server built in', 'One endpoint, /mcp, with OAuth 2.1 (PKCE) or API keys. Every action runs with your permissions and lands in the audit log.'],
      ['Connected in a minute', 'One-click keys and ready commands for Codex, Claude Code and Cursor; OAuth sign-in for ChatGPT and Claude.ai.'],
      ['Agent in the app', 'The built-in AI agent finds contacts, updates deals, creates tasks – and asks before it sends, deletes or pays.'],
      ['Your model, your subscription', 'Bring your own key for any model (BYOK) – or use your ChatGPT or Claude subscription the official ways: as a connector inside ChatGPT/Claude, or through the local bridge with the official CLIs.'],
    ],
    tools: (n) => `${n} MCP tools`,
    snippetLabel: 'Connect Codex or Claude Code',
    snippetNote: 'From the docs (docs/ai-tools.md). Without a key, both sign in via OAuth.',
    docs: 'Guide for every AI tool',
  },
  proof: { title: 'Counted, not claimed', areas: 'areas', tools: 'MCP tools', integrations: 'integrations', tests: 'automated tests', note: 'Numbers from the running code and from the repository at build time.' },
  calc: {
    h2: 'How much do you save?',
    lead: 'The link keeps your result – share it.',
    modes: 'Compare with',
    modeMix: 'Typical tool mix',
    modeHl: 'Coming from HighLevel',
    mixLead: 'Which tools do you pay for today?',
    mixTools: 'Your tools',
    mixPerSeat: 'Prices for one user, monthly; some tools charge for every further user.',
    resultMix: (eur, n) => `Your ${n} tools: about ${eur} a month`,
    mixFoot: (date, rate) => `Entry prices per the vendors' websites, as of ${date}; dollar prices converted at the ECB reference rate (€1 = $${rate}).`,
    plan: 'Your HighLevel plan',
    plans: { starter: 'Starter · $97 (3 sub-accounts)', unlimited: 'Unlimited · $297 (unlimited sub-accounts)', pro: 'Agency Pro · $497 (SaaS mode)' },
    subs: 'Sub-accounts',
    wlApp: 'White-label mobile app',
    wlAppHint: '$497 a month extra at HighLevel',
    hosting: 'How you use {b}',
    self: 'Self-hosted',
    cloud: 'Cloud',
    submit: 'Calculate',
    resultHl: (usd, plan) => `HighLevel ${plan}: ${usd} a month`,
    resultUs: (what) => `{b}: ${what}`,
    save: (eur) => `You save ${eur} a year.`,
    bumped: 'Starter has 3 sub-accounts only – calculated with Unlimited.',
    saasSelf: 'SaaS mode (reselling with your own plans) is part of self-hosting, not of the cloud – calculated with $0.',
    ourPlan: { self: 'self-hosted $0', solo: 'Cloud Solo', team: 'Cloud Team & Company', agency: 'Cloud Agency' },
    perMonth: 'a month',
    perYear: 'a year',
    share: 'Share the result',
    shareText: (eur) => `I save ${eur} a year with {b} instead of HighLevel – open source, free to self-host.`,
    foot: (date, rate) => `HighLevel list prices of ${date} (gohighlevel.com/pricing), monthly; converted at the ECB reference rate of ${date} (€1 = $${rate}). Self-hosted you pay for your server (usually €5–15 a month), no licence.`,
  },
  features: {
    h2: 'Everything you otherwise pay five subscriptions for',
    lead: 'One Node app, one SQLite file, unlimited sub-accounts.',
    items: [
      ['CRM & pipelines', 'Contacts, companies, deals, tasks, custom objects and lead scoring.'],
      ['Unified inbox', 'E-mail, SMS, WhatsApp, Messenger, Instagram and phone in one list.'],
      ['Funnels & websites', 'Page builder with templates, blog, A/B tests and an accessibility check.'],
      ['Automations', 'Workflows with triggers, conditions, waits – and an AI workflow builder.'],
      ['AI agent & MCP', 'Claude, ChatGPT and others work your CRM over MCP, with your permissions.'],
      ['Calendars & booking', 'Online booking, team calendars, round robin, pay at booking.'],
      ['Courses & community', 'Member area, quizzes, certificates, community and webinars.'],
      ['Invoices & light bookkeeping', 'Quotes, invoices, dunning, SEPA, DATEV export.'],
      ['Helpdesk', 'Tickets, SLAs, knowledge base and customer portal.'],
      ['Agency & white-label', 'Sub-accounts, client logins, custom domains, snapshots, SaaS mode.'],
      ['Telephony & voice', 'Browser phone, queues, IVR and an AI phone agent.'],
      ['Apps', 'Android app with 13 widgets and a web app for iPhone and iPad.'],
    ],
    more: 'Every feature in the README',
  },
  dach: {
    h2: 'Your CRM belongs to you.',
    lead: 'Built for businesses in Germany, Austria and Switzerland.',
    items: [
      ['GDPR', 'Consent records, double opt-in, access and erasure at a click, a DPA template.'],
      ['GoBD-minded', 'Gapless invoice numbers, frozen invoices, audit log, receipt archive.'],
      ['XRechnung & ZUGFeRD', 'Create e-invoices and read incoming ones exactly.'],
      ['SEPA', 'Direct debit mandates and transfer files – without Stripe, too.'],
      ['DATEV', 'Booking batches and receipts for your tax advisor.'],
      ['Servers in the EU', 'Self-hosted on your server; the cloud runs in Frankfurt am Main.'],
    ],
  },
  move: {
    h2: 'Move from HighLevel in one go',
    lead: 'The built-in HighLevel import brings your sub-account over.',
    steps: [
      ['Create a token', 'In HighLevel, Settings → Private Integrations → create a token.'],
      ['Start the import', 'In {b}, paste it under Settings → Import and pick the sub-account.'],
      ['Done', 'Contacts, custom fields, tags, pipelines, deals, calendars and appointments are there. Running it again creates no duplicates.'],
    ],
    note: 'Funnels and workflows are not imported – templates help you rebuild them. The switching wizard brings data from 25 more tools (HubSpot, Mailchimp, ActiveCampaign, Pipedrive …).',
  },
  vsHl: {
    h2: '{b} and HighLevel side by side',
    lead: 'Monthly list prices, plainly next to each other.',
    colFeature: 'What you need',
    colHl: 'HighLevel',
    colUs: '{b}',
    rows: [
      ['Entry', 'Starter: $97 (3 sub-accounts)', 'Self-hosted $0 · Cloud Solo €49.99'],
      ['Unlimited sub-accounts', 'Unlimited: $297', 'Self-hosted $0 · Cloud Agency €199'],
      ['SaaS mode (reselling under your own brand)', 'Agency Pro: $497', 'Self-hosted $0 · not part of the cloud'],
      ['White-label web app', 'described in the FAQ, no plan named', 'Self-hosted $0 · Cloud Agency €199'],
      ['White-label mobile app', '$497 a month add-on, or in Enterprise (price on request)', 'partly – via PWA install with your name and icon (Android also as an APK), not in the app stores²'],
      ['Phone and e-mail rebilling', 'Unlimited without markup, Agency Pro with markup', 'self-hosted: your own provider keys, paid to the provider directly · cloud: SMS at cost, or your own keys'],
      ['Source code', 'proprietary', 'open (AGPL-3.0)'],
    ],
    foot: (date) => `Source: gohighlevel.com/pricing, retrieved ${date}.`,
    appNote: '² Not in the App Store or Play Store: the web app installs from the browser, the APK downloads from the server. You build your own Android APK with the documented guide.',
  },
  hlPage: {
    title: '{b} instead of HighLevel: prices, SaaS mode, white-label and switching',
    description: 'HighLevel costs $97 to $497 a month, the white-label app $497 extra. {b} is open source: $0 self-hosted, white-label in the cloud from €199. With a HighLevel import.',
    h1: 'From HighLevel to {b}',
    lead: 'What HighLevel costs, what {b} costs – and how your sub-account moves over in one go.',
    message: 'White-label in the cloud from €199, SaaS mode self-hosted from $0. At HighLevel, SaaS mode starts at $497 a month, and the white-label mobile app costs another $497 a month.',
    messageNote: 'Our branded app is an installable web app (PWA) plus a self-built Android APK, not an app-store app. SaaS mode (reselling with your own plans and your own Stripe) is part of self-hosting, not of the cloud yet.',
    factsH2: "HighLevel's prices per its pricing page",
    facts: ['Starter $97 a month: 3 sub-accounts.', 'Unlimited $297 a month: unlimited sub-accounts, phone and e-mail rebilling without markup.', 'Agency Pro $497 a month: SaaS mode (reselling under your own brand), rebilling with markup.', 'White-label mobile app: $497 a month on top, or in Enterprise (price on request).', 'White-label of the desktop web app: described in the FAQ without naming a plan.'],
    importH2: 'The HighLevel import',
    cta: 'Open the live demo',
  },
  disclaimer: (date) => `{b} is an independent open-source project and is not affiliated with HighLevel Inc. or the other vendors named. All trademarks belong to their owners. Prices per the vendors' websites, as of ${date}.`,
  matrix: {
    h2: 'Compared with other tools',
    lead: 'Features and entry prices, with a source for every cell.',
    all: 'All',
    asOf: (d) => `As of ${d}`,
    sources: 'Sources',
    yes: 'yes',
    partial: 'partly',
    no: 'no',
    addon: 'paid add-on',
    unlisted: 'not stated',
    from: 'from',
    empty: 'The comparison table is being updated.',
    vendorCol: 'Feature',
    pageTitle: 'Comparison: {b} and other CRM and marketing tools',
    pageLead: 'Features and list prices of HighLevel, HubSpot, ActiveCampaign, ClickFunnels, systeme.io, Kajabi, Keap and more – with source and date for every cell.',
    priceRow: 'Entry price',
    ourPrice: '$0 / from €49.99',
    priceNote: "Prices in the vendor's currency, monthly; “not stated” means the vendor's pages do not mention it; the research notes are in German",
    notes: 'Notes',
    more: 'Full comparison table',
    hlMore: 'All about HighLevel',
    whyH2: 'Why switch?',
    whyLead: 'Per vendor: what {b} adds – and where the other one is better today.',
  },
  choose: {
    h2: 'Cloud or self-hosted?',
    lead: 'Same software, every feature. The difference is who runs the server.',
    cloud: {
      title: 'Cloud',
      price: 'Solo €49.99 · Team & Company €99.99 · Agency €199',
      items: [
        'Ready in minutes – no server, Docker or Linux skills needed.',
        'We install updates and security patches.',
        'Daily server backups; your own data export (ZIP) any time, self-service.',
        'We handle TLS certificates and operations; custom domains on the Agency plan.',
        'Hosted in Germany (Frankfurt am Main). Sign the DPA at sign-up and download it as a PDF.',
        'AI allowance, push notifications and the apps work without any setup.',
        'No limits on contacts, funnels or workflows (fair use for e-mails, AI and storage).',
        'Agency plan: white-label and client sub-accounts.',
      ],
      verdict: 'For everyone who wants to work, not maintain servers.',
    },
    self: {
      title: 'Self-hosted',
      price: '$0 · AGPL-3.0',
      items: [
        'Full control: your server, your data, your rules.',
        'Free, no limits, the full source code – customise everything.',
        'SaaS mode included: sell sub-accounts with your own plans through your own Stripe.',
        'Updates, backups, security, TLS and e-mail deliverability are yours – with guides for the Docker install, backups and updates.',
        'Community help through GitHub Issues and Discussions.',
      ],
      verdict: 'For everyone who wants to – or has to – run their own server.',
    },
    switch: 'Switching: export everything from the cloud as a ZIP (JSON, CSV and files) at any time; the CSV import reads contacts back in. A one-click move between the cloud and your own server does not exist yet.',
  },
  stack: {
    h2: 'Replaces your stack',
    lead: 'What you otherwise pay for one by one – and what {b} brings along.',
    colFeature: 'Feature',
    colReplaces: 'Replaces',
    colPrice: 'Other tools (month)',
    included: 'Included',
    partial: 'Partly',
    unique: 'Self-hostable only in {b}',
    from: 'from',
    total: 'Tool stack',
    totalUs: '$0',
    totalUsNote: '(self-hosted)',
    totalCloud: 'Cloud from €49.99/month',
    perMonth: '/ month',
    noPrice: 'no public price on record',
    onRequest: 'price on request',
    about: 'from about',
    cheapest: 'cheapest tool per row, 1 user, net',
    fullOnly: (rows, eur) => `The ${rows} fully covered rows alone: about ${eur} a month.`,
    notCounted: 'Rows marked * are not in the total.',
    usage: 'With {b}, usage costs at your own providers come on top (SMS, e-mail sending, AI, call minutes); some tools include an allowance for that. Tools with “price on request” are not counted.',
    foot: (date, priced, rows) => `Entry prices per the vendors' websites, without VAT, as of ${date}; the cheapest tool per row for one user. The total covers ${priced} of ${rows} rows. Sources:`,
    noConversion: 'USD prices are not converted.',
    converted: (rate, source) => `Dollar prices converted for the total${rate ? ` (€1 = $${rate})` : ''}, rate source: ${source}; the table shows each vendor's own currency.`,
  },
  pricing: {
    h2: 'Pricing',
    lead: 'No per-seat fee, no contact limit. Every feature in every plan – white-label and client accounts on the Agency plan only.',
    self: { name: 'Self-hosted', price: '$0', tag: 'Open source under AGPL-3.0', items: ['Every feature, white-label and SaaS mode included', 'Unlimited users, contacts, sub-accounts', 'Your server, your data'], cta: 'Install' },
    solo: { name: 'Cloud Solo', tag: 'Just you', items: ['1 user', 'Unlimited contacts, funnels, workflows', 'Every feature except white-label and client accounts'] },
    team: { name: 'Cloud Team & Company', tag: 'For teams and companies', items: ['Unlimited users – no per-seat fee', 'Unlimited contacts, funnels, workflows', 'Every feature except white-label and client accounts'] },
    agency: { name: 'Cloud Agency', tag: 'White-label for agencies', badge: 'White-label', items: ['Your brand instead of ours: name, logo, colours', 'Your own login domain and domains for clients', 'App with your name and icon', 'Unlimited users and client sub-accounts'] },
    perMonth: '/ month',
    yearly: (eur) => `or ${eur} a year`,
    vat: 'Prices are net plus VAT; Stripe Tax calculates the tax at checkout for your country (reverse charge for EU businesses with a VAT ID).',
    allFeatures: 'Every feature in every plan – white-label and client accounts on the Agency plan only.',
    ctaCloud: 'Start in the cloud',
  },
  wl: {
    h2: 'White-label on the Agency plan',
    lead: 'For €199 a month your clients see your brand, not ours.',
    items: [
      ['Name, logo, colours', 'In the login, the app and the browser tab – for you and for each client.'],
      ['Login domain', 'crm.your-agency.com instead of our address; the certificate follows by itself.'],
      ['Domains for clients', 'Every client account can get a domain of its own.'],
      ['Branded app', 'The installable web app carries your name and icon. Build your own Android APK with the documented guide.'],
      ['Client sub-accounts', 'Separate accounts with their own logins, no fee per client.'],
    ],
    saas: 'Reselling with your own plans and your own Stripe (SaaS mode) is part of self-hosting – it is not included in the cloud.',
    appsLink: 'See the apps',
  },
  apps: {
    h2: 'Apps for Android, iPhone, iPad and XR',
    lead: 'No app store: the Android app comes straight from our server, iPhone, iPad and XR headsets use the web app.',
    android: {
      title: 'Android',
      sub: (v, mb) => `APK · v${v} · ${mb} MB`,
      subNone: 'APK · coming soon',
      button: 'Get the Android app',
      sha: 'SHA-256',
      qr: 'QR code to the download page',
      steps: [
        'Download the APK on your phone (or scan the QR code).',
        'Open the file. If Android asks, allow “Install unknown apps” for your browser.',
        'Tap “Install”. If Play Protect warns, confirm with “More details” → “Install anyway”.',
        'The app reports updates itself and checks the checksum.',
      ],
      firstStart: 'This APK connects to our cloud. For your own server, build the app with your address or download it from your instance at /android.',
      none: 'The APK has not been uploaded yet.',
    },
    ios: {
      title: 'iPhone & iPad · Web app',
      sub: 'Add to Home Screen',
      button: 'Open the web app',
      qr: 'QR code to the web app',
      steps: ['Open the web app in Safari (scan the QR code).', 'Tap “Share” at the bottom.', 'Choose “Add to Home Screen”, then “Add”.', 'Start it from the home screen and sign in.'],
      works: 'What works',
      worksItems: ['Push notifications from iOS 16.4', 'Badge count on the icon', 'Starts offline with the app shell', 'Full screen without the browser bar'],
      note: 'A web app for iPhone and iPad, not an App Store app.',
    },
    xr: {
      title: 'XR headsets and display glasses (beta)',
      sub: "In the headset's browser – no app store",
      items: [
        'Spatial mode: large targets for gaze, pinch and controllers, readable glass',
        'Workspace: 2–4 pages side by side for ultrawide monitors and the giant virtual screens of display glasses',
        'Boards and Canvas as floating panels in WebXR – without WebXR as a 3D preview in the browser',
        'For Meta Quest, Apple Vision Pro, Android XR and display glasses',
      ],
      note: 'Beta: tested in the browser and with a simulated WebXR headset, not yet on every real headset. Spatial mode and the 3D preview work everywhere.',
      docs: 'How XR works',
    },
    agency: 'Agencies get both apps under their own brand: the web app automatically with name and icon; the Android APK you build yourself with the documented script.',
  },
  install: {
    h2: 'Installed with one command',
    lead: 'On any Linux server with Docker and a domain – with automatic HTTPS.',
    copy: 'Copy',
    copied: 'Copied',
    github: 'Source on GitHub',
    docs: 'Guide',
    note: 'The script shows what it does before every step. Prefer doing it by hand: git clone, edit .env, docker compose up.',
  },
  faq: {
    h2: 'FAQ',
    items: [
      ['Is {b} really free?', 'Self-hosted, yes: open source under AGPL-3.0, every feature, no user or contact limits. You pay for your server only. The cloud starts at €49.99 a month plus VAT.'],
      ['How is {b} different from HighLevel?', '{b} covers the core areas – CRM, inbox, funnels, automations, calendars, courses, invoices – and is open source. Not everything is the same: there is no app-store app, and some integrations are missing. The comparison table shows both.'],
      ['Can I move from HighLevel?', 'Yes. The HighLevel import brings contacts, custom fields, tags, pipelines, deals, calendars and appointments. You rebuild funnels and workflows with templates.'],
      ['Where is my data?', 'Self-hosted on your server. In the cloud in Frankfurt am Main, Germany – with a data processing agreement.'],
      ['Is there a per-seat fee?', 'No. Cloud Team & Company and Cloud Agency have unlimited users at the same price.'],
      ['What does the AGPL mean for my agency?', 'You may use, adapt and run {b} for clients freely. If you offer a modified version as a service, you have to make the modified source available to its users.'],
      ['Is there a demo?', 'Yes, with made-up data. It resets every night and sends nothing out.'],
    ],
  },
  foot: { imprint: 'Legal notice', privacy: 'Privacy', source: 'Source code (AGPL-3.0)', robot: 'The Android robot is reproduced or modified from work created and shared by Google and used according to terms described in the Creative Commons 3.0 Attribution License.', madeIn: 'Open source from Germany', noTracking: 'This page sets no cookies and loads nothing from third parties.' },
};

export const COPY: Record<Lang, Copy> = { de, en };
