import type { Copy, Lang } from './landing-copy.js';

/**
 * Landing page in cloud waitlist mode (services/cloud-waitlist.ts): the texts that would sell the hosted cloud as available
 * today, replaced. Self-hosting becomes the main call to action, the cloud is "planned" and every cloud button leads to the
 * waitlist form. Same structure as landing-copy.ts (German and English, `{b}` = product name); replacements that edit a text
 * of landing-copy.ts are keyed by that text, so tests/cloud-waitlist.test.ts notices when the original changes.
 */

interface WaitlistCopy {
  description: string;
  hero: Pick<Copy['hero'], 'eyebrow' | 'sub' | 'badges' | 'ctaSelf' | 'ctaCloud'>;
  calc: Pick<Copy['calc'], 'cloud' | 'ourPlan'>;
  /** dach items, keyed by their title. */
  dach: Record<string, string>;
  /** vsHl rows: our column, keyed by the original cell. */
  vsHl: Record<string, string>;
  hlPage: Pick<Copy['hlPage'], 'description' | 'message'>;
  matrix: Pick<Copy['matrix'], 'ourPrice'>;
  choose: Pick<Copy['choose'], 'lead' | 'cloud' | 'switch'>;
  stack: Pick<Copy['stack'], 'totalCloud'>;
  pricing: Pick<Copy['pricing'], 'lead' | 'vat' | 'ctaCloud' | 'allFeatures'>;
  wl: Pick<Copy['wl'], 'h2' | 'lead'>;
  apps: { android: Pick<Copy['apps']['android'], 'firstStart'>; ios: Pick<Copy['apps']['ios'], 'note'> };
  /** FAQ answers keyed by the original question; `insert` comes after the first question. */
  faq: { replace: Record<string, [string, string]>; insert: [string, string] };
  /** Marker after a research note about our cloud (comparison matrix, stack table). */
  noteMarker: string;
}

const WAITLIST: Record<Lang, WaitlistCopy> = {
  de: {
    description: 'Das freie Open-Source-Wachstums-Betriebssystem für Solopreneure, Agenturen und kleine agentische Unternehmen: CRM, Postfach, Funnels, Automationen und Jarvis als KI-Business-Developer – kostenlos selbst gehostet (AGPL), ohne Gebühr pro Nutzer. Eine gehostete Cloud ist geplant: Warteliste offen.',
    hero: {
      eyebrow: 'Open Source · Selbst gehostet kostenlos · Cloud bald verfügbar',
      sub: 'Jarvis, dein KI-Business-Developer, liest am Morgen deine Zahlen, findet den Deal, den du vergessen hast, und bereitet das Nachfassen vor – du bestätigst mit einem Klick. {b} ist Open Source und läuft kostenlos auf deinem eigenen Server; eine gehostete Cloud ist in Vorbereitung – trag dich auf die Warteliste ein.',
      badges: ['Open Source (AGPL)', 'MCP für Claude, ChatGPT, Codex & Cursor', 'Dein Claude- oder ChatGPT-Abo für deine Chats', 'Dein Server, deine Daten', 'DSGVO'],
      ctaSelf: 'Kostenlos selbst hosten',
      ctaCloud: 'Cloud: auf die Warteliste',
    },
    calc: { cloud: 'Cloud (geplant)', ourPlan: { self: 'selbst gehostet 0 €', solo: 'Cloud Solo (geplant)', team: 'Cloud Team & Company (geplant)', agency: 'Cloud Agentur (geplant)' } },
    dach: { 'Server in der EU': 'Selbst gehostet auf deinem Server, an dem Standort, den du wählst. Die geplante Cloud soll in Frankfurt am Main laufen.' },
    vsHl: {
      'Selbst gehostet 0 € · Cloud Solo 49,99 €': 'Selbst gehostet 0 € · Cloud Solo geplant: 49,99 €',
      'Selbst gehostet 0 € · Cloud Agentur 199 €': 'Selbst gehostet 0 € · Cloud Agentur geplant: 199 €',
      'selbst gehostet: eigene Anbieter-Schlüssel, direkt beim Anbieter bezahlt · Cloud: SMS zum Selbstkostenpreis oder eigene Schlüssel': 'selbst gehostet: eigene Anbieter-Schlüssel, direkt beim Anbieter bezahlt · geplante Cloud: SMS zum Selbstkostenpreis oder eigene Schlüssel',
    },
    hlPage: {
      description: 'HighLevel kostet 97 $ bis 497 $ im Monat, die White-Label-App 497 $ extra. {b} ist Open Source: selbst gehostet 0 €, mit White-Label und SaaS-Modus. Mit HighLevel-Import.',
      message: 'White-Label und SaaS-Modus selbst gehostet ab 0 €. Bei HighLevel beginnt der SaaS-Modus bei 497 $ im Monat, die White-Label-Mobile-App kostet weitere 497 $ im Monat.',
    },
    matrix: { ourPrice: '0 € · Cloud geplant' },
    choose: {
      lead: 'Dieselbe Software, alle Funktionen. Selbst hosten geht heute schon – die Cloud ist geplant.',
      cloud: {
        title: 'Cloud (geplant)',
        price: 'Voraussichtlich Solo 49,99 € · Team & Company 99,99 € · Agentur 199 €',
        items: [
          'Startklar ohne Server, Docker oder Linux-Kenntnisse.',
          'Updates, Sicherheits-Patches, Server-Backups und TLS-Zertifikate übernehmen wir.',
          'Geplanter Standort: Deutschland (Frankfurt am Main), mit Auftragsverarbeitungsvertrag (AVV).',
          'KI-Kontingent, Push-Mitteilungen und die Apps sollen ohne Einrichtung funktionieren.',
          'Keine Grenzen für Kontakte, Funnels und Workflows (Fair Use für E-Mails, KI und Speicher).',
          'Tarif Agentur: White-Label und Kunden-Sub-Accounts.',
        ],
        verdict: 'Noch nicht buchbar.',
      },
      switch: 'Die Cloud ist noch nicht verfügbar. Selbst hosten kannst du schon heute; deine Kontakte nimmst du per CSV-Export und -Import mit.',
    },
    stack: { totalCloud: 'Cloud geplant, voraussichtlich ab 49,99 €/Monat' },
    pricing: {
      lead: 'Selbst gehostet heute kostenlos. Die Cloud-Tarife sind geplant und noch nicht buchbar: keine Gebühr pro Nutzer, kein Kontakt-Limit, alle Funktionen in jedem Tarif – White-Label und Kunden-Accounts nur im Tarif Agentur.',
      vat: 'Geplante Preise, netto zzgl. gesetzlicher USt. Noch nicht buchbar – es gibt noch keine Konten und keine Zahlungen.',
      ctaCloud: 'Auf die Warteliste',
      allFeatures: 'Alle Funktionen in jedem Tarif – White-Label und Kunden-Accounts nur im Tarif Agentur.',
    },
    wl: { h2: 'White-Label: selbst gehostet heute, in der Cloud geplant', lead: 'Deine Kunden sehen deine Marke, nicht unsere – selbst gehostet schon heute kostenlos, in der geplanten Cloud im Tarif Agentur (voraussichtlich 199 € im Monat).' },
    apps: {
      android: { firstStart: 'Diese APK verbindet sich mit der {b}-Cloud, die noch nicht offen ist. Für deinen eigenen Server lädst du die App von deiner Instanz unter /android oder baust sie mit deiner Adresse.' },
      ios: { note: 'Eine Web-App für iPhone und iPad, keine App aus dem App Store (eine native iOS-App gibt es noch nicht) – du öffnest sie auf deiner eigenen Instanz unter /app.' },
    },
    faq: {
      replace: {
        'Ist {b} wirklich kostenlos?': ['Ist {b} wirklich kostenlos?', 'Selbst gehostet ja: Open Source unter AGPL-3.0, alle Funktionen, keine Nutzer- oder Kontaktgrenzen. Du zahlst nur deinen Server. Eine gehostete Cloud ist geplant (voraussichtlich ab 49,99 € im Monat zzgl. USt.), aber noch nicht buchbar.'],
        'Wo liegen meine Daten?': ['Wo liegen meine Daten?', 'Auf deinem eigenen Server – du bestimmst den Standort. Die geplante Cloud soll in Frankfurt am Main laufen, mit Auftragsverarbeitungsvertrag.'],
        'Gibt es eine Gebühr pro Nutzer?': ['Gibt es eine Gebühr pro Nutzer?', 'Nein. Selbst gehostet gibt es keine Nutzergrenze; auch die geplanten Cloud-Tarife Team & Company und Agentur sollen unbegrenzt Nutzer zum gleichen Preis haben.'],
      },
      insert: ['Kann ich die Cloud schon nutzen?', 'Noch nicht. Wir bereiten die gehostete Cloud vor; Konten und Zahlungen gibt es noch nicht. Trag dich auf die Warteliste ein – wir melden uns, sobald sie startet. Bis dahin hostest du {b} kostenlos selbst.'],
    },
    noteMarker: ' (Cloud: geplant, noch nicht verfügbar)',
  },
  en: {
    description: 'The free, open-source growth OS for solopreneurs, agencies and small agentic businesses: CRM, inbox, funnels, automations and Jarvis, an AI business developer – free to self-host (AGPL), no per-seat fee. A hosted cloud is planned: the waitlist is open.',
    hero: {
      eyebrow: 'Open source · Self-host free · Cloud coming soon',
      sub: 'Jarvis, your AI business developer, reads your numbers in the morning, spots the deal you forgot and prepares the follow-up – you confirm with one click. {b} is open source and runs free on your own server; a hosted cloud is being prepared – join the waitlist.',
      badges: ['Open source (AGPL)', 'MCP for Claude, ChatGPT, Codex & Cursor', 'Your Claude or ChatGPT plan for your own chats', 'Your server, your data', 'GDPR'],
      ctaSelf: 'Self-host for free',
      ctaCloud: 'Cloud: join the waitlist',
    },
    calc: { cloud: 'Cloud (planned)', ourPlan: { self: 'self-hosted $0', solo: 'Cloud Solo (planned)', team: 'Cloud Team & Company (planned)', agency: 'Cloud Agency (planned)' } },
    dach: { 'Servers in the EU': 'Self-hosted on your server, wherever you choose. The planned cloud is to run in Frankfurt am Main.' },
    vsHl: {
      'Self-hosted $0 · Cloud Solo €49.99': 'Self-hosted $0 · Cloud Solo planned: €49.99',
      'Self-hosted $0 · Cloud Agency €199': 'Self-hosted $0 · Cloud Agency planned: €199',
      'self-hosted: your own provider keys, paid to the provider directly · cloud: SMS at cost, or your own keys': 'self-hosted: your own provider keys, paid to the provider directly · planned cloud: SMS at cost, or your own keys',
    },
    hlPage: {
      description: 'HighLevel costs $97 to $497 a month, the white-label app $497 extra. {b} is open source: $0 self-hosted, with white-label and SaaS mode. With a HighLevel import.',
      message: 'White-label and SaaS mode self-hosted from $0. At HighLevel, SaaS mode starts at $497 a month, and the white-label mobile app costs another $497 a month.',
    },
    matrix: { ourPrice: '$0 · cloud planned' },
    choose: {
      lead: 'Same software, every feature. Self-hosting works today – the cloud is planned.',
      cloud: {
        title: 'Cloud (planned)',
        price: 'Planned: Solo €49.99 · Team & Company €99.99 · Agency €199',
        items: [
          'Ready without a server, Docker or Linux skills.',
          'We will handle updates, security patches, server backups and TLS certificates.',
          'Planned location: Germany (Frankfurt am Main), with a data processing agreement (DPA).',
          'AI allowance, push notifications and the apps are to work without any setup.',
          'No limits on contacts, funnels or workflows (fair use for e-mails, AI and storage).',
          'Agency plan: white-label and client sub-accounts.',
        ],
        verdict: 'Not available to order yet.',
      },
      switch: 'The cloud is not available yet. You can self-host today; your contacts move with the CSV export and import.',
    },
    stack: { totalCloud: 'Cloud planned, from about €49.99/month' },
    pricing: {
      lead: 'Free to self-host today. The cloud plans are planned and cannot be ordered yet: no per-seat fee, no contact limit, every feature in every plan – white-label and client accounts on the Agency plan only.',
      vat: 'Planned prices, net plus VAT. Not available to order yet – there are no accounts and no payments yet.',
      ctaCloud: 'Join the waitlist',
      allFeatures: 'Every feature in every plan – white-label and client accounts on the Agency plan only.',
    },
    wl: { h2: 'White-label: self-hosted today, planned in the cloud', lead: 'Your clients see your brand, not ours – free when you self-host today, and on the planned cloud Agency plan (planned at €199 a month).' },
    apps: {
      android: { firstStart: 'This APK connects to the {b} cloud, which is not open yet. For your own server, download the app from your instance at /android or build it with your address.' },
      ios: { note: 'A web app for iPhone and iPad, not an App Store app (there is no native iOS app yet) – you open it on your own instance at /app.' },
    },
    faq: {
      replace: {
        'Is {b} really free?': ['Is {b} really free?', 'Self-hosted, yes: open source under AGPL-3.0, every feature, no user or contact limits. You pay for your server only. A hosted cloud is planned (from about €49.99 a month plus VAT) but cannot be ordered yet.'],
        'Where is my data?': ['Where is my data?', 'On your own server – you choose where. The planned cloud is to run in Frankfurt am Main, Germany, with a data processing agreement.'],
        'Is there a per-seat fee?': ['Is there a per-seat fee?', 'No. Self-hosted there is no user limit; the planned cloud plans Team & Company and Agency are to have unlimited users at the same price as well.'],
      },
      insert: ['Can I use the cloud already?', 'Not yet. We are preparing the hosted cloud; there are no accounts and no payments yet. Join the waitlist – we will let you know as soon as it launches. Until then, self-host {b} for free.'],
    },
    noteMarker: ' (cloud: planned, not available yet)',
  },
};

/** The copy of a language with the waitlist texts in place. */
export function withWaitlist(c: Copy, lang: Lang): Copy {
  const o = WAITLIST[lang];
  return {
    ...c,
    description: o.description,
    hero: { ...c.hero, ...o.hero },
    calc: { ...c.calc, ...o.calc },
    dach: { ...c.dach, items: c.dach.items.map(([t, p]) => [t, o.dach[t] ?? p] as [string, string]) },
    vsHl: { ...c.vsHl, rows: c.vsHl.rows.map(([a, b, u]) => [a, b, o.vsHl[u] ?? u] as [string, string, string]) },
    hlPage: { ...c.hlPage, ...o.hlPage },
    matrix: { ...c.matrix, ...o.matrix },
    choose: { ...c.choose, ...o.choose },
    stack: { ...c.stack, ...o.stack },
    pricing: { ...c.pricing, ...o.pricing },
    wl: { ...c.wl, ...o.wl },
    apps: { ...c.apps, android: { ...c.apps.android, ...o.apps.android }, ios: { ...c.apps.ios, ...o.apps.ios } },
    faq: { ...c.faq, items: c.faq.items.flatMap(([q, a], i) => [o.faq.replace[q] ?? ([q, a] as [string, string]), ...(i === 0 ? [o.faq.insert] : [])]) },
  };
}

/** The keys of the replacements above (tests check that each one still matches a text of landing-copy.ts). */
export const waitlistKeys = (lang: Lang) => ({ dach: Object.keys(WAITLIST[lang].dach), vsHl: Object.keys(WAITLIST[lang].vsHl), faq: Object.keys(WAITLIST[lang].faq.replace) });

/**
 * A research note about our own product that speaks of our cloud or its prices ("Cloud Solo 49,99 €/Monat", "Cloud in Frankfurt",
 * "Im Agentur-Plan (199 €/Monat)", "das KI-Kontingent der Cloud") gets the marker; "WhatsApp Cloud API" is left alone.
 */
const OUR_CLOUD = /\bcloud\b(?![\s-]*api\b)|agentur-plan|agency plan|€\s*\/\s*(?:monat|month)/i;
export function waitlistNote(note: string, lang: Lang): string {
  return note && OUR_CLOUD.test(note) && !note.includes(WAITLIST[lang].noteMarker.trim()) ? `${note}${WAITLIST[lang].noteMarker}` : note;
}

/**
 * "Why switch" paragraphs (landing-switch.ts) in waitlist mode: the phrases that quote cloud prices or the cloud's hosting, per vendor
 * and language, as [original, replacement] – the originals must stay in the texts (tests check it).
 */
export const WHY_WAITLIST: Record<string, Record<Lang, [string, string][]>> = {
  highlevel: {
    de: [
      ['Open Source, Self-Hosting, Hosting in Frankfurt, XRechnung', 'Open Source, Self-Hosting auf deinem eigenen Server, XRechnung'],
      ['White-Label kostet in der Cloud 199 € statt 497 $ für Agency Pro', 'White-Label ist selbst gehostet ohne Aufpreis dabei statt 497 $ für Agency Pro (in der geplanten Cloud voraussichtlich 199 €)'],
    ],
    en: [
      ['open source, self-hosting, hosting in Frankfurt, XRechnung', 'open source, self-hosting on your own server, XRechnung'],
      ['White-label costs €199 in the cloud instead of $497 for Agency Pro', 'White-label comes at no extra cost when you self-host instead of $497 for Agency Pro (planned at €199 in the cloud)'],
    ],
  },
  hubspot: {
    de: [['ab dem Solo-Tarif, unbegrenzt Nutzer ab 99,99 € und keine Kontaktstufen', 'ohne Aufpreis, unbegrenzt Nutzer ohne Gebühr pro Platz und keine Kontaktstufen']],
    en: [['from the Solo plan, unlimited users from €99.99 and no contact tiers', 'at no extra cost, unlimited users without a per-seat fee and no contact tiers']],
  },
  clickfunnels: {
    de: [['auf Deutsch, gehostet in Frankfurt, dazu', 'auf Deutsch, auf deinem eigenen Server in der EU, dazu']],
    en: [['in German, hosted in Frankfurt, plus', 'in German, on your own server in the EU, plus']],
  },
  kajabi: {
    de: [['ab 49,99 € ohne Kontaktgrenze', 'selbst gehostet kostenlos und ohne Kontaktgrenze']],
    en: [['from €49.99 with no contact limit', 'free when self-hosted, with no contact limit']],
  },
  keap: {
    de: [['mit unbegrenzt Nutzern ab 99,99 €', 'mit unbegrenzt Nutzern ohne Gebühr pro Platz']],
    en: [['with unlimited users from €99.99', 'with unlimited users and no per-seat fee']],
  },
  brevo: {
    de: [['in jedem Tarif und Kunden-Sub-Accounts im Tarif Agentur', 'ohne Aufpreis und Kunden-Sub-Accounts für Agenturen']],
    en: [['in every plan and client sub-accounts on the Agency plan', 'at no extra cost and client sub-accounts for agencies']],
  },
  klicktipp: {
    de: [
      ['Hosting in Frankfurt)', 'Hosting auf deinem eigenen Server)'],
      ['Agentur-Sub-Accounts zum Festpreis', 'Agentur-Sub-Accounts, selbst gehostet kostenlos'],
    ],
    en: [
      ['hosting in Frankfurt)', 'hosting on your own server)'],
      ['agency sub-accounts at a flat price', 'agency sub-accounts, free when self-hosted'],
    ],
  },
};

export function whyWaitlist(vendor: string, lang: Lang, text: string): string {
  return (WHY_WAITLIST[vendor]?.[lang] ?? []).reduce((t, [from, to]) => t.replace(from, to), text);
}
