/**
 * Legal text generators (pure): Impressum (§ 5 DDG), Datenschutzerklärung (Art. 13 DSGVO) that lists the services a sub-account
 * actually uses, Auftragsverarbeitungsvertrag (Art. 28 DSGVO) and Verzeichnis von Verarbeitungstätigkeiten (Art. 30 DSGVO) as
 * drafts from the company data. They are starting points, not legal advice: every document says so, gaps are marked
 * `[bitte ergänzen: …]` and listed in `missing`. modules/legal-pages.ts collects the facts and serves them.
 */

export const LEGAL_NOTICE = 'Entwurf – keine Rechtsberatung. Diese Vorlage wurde automatisch aus deinen Angaben und den aktiv genutzten Funktionen erstellt. Bitte prüfe jeden Abschnitt, ergänze die markierten Stellen und lass den Text von einer Rechtsanwältin oder einem Rechtsanwalt bzw. dem Datenschutzbeauftragten prüfen, bevor du ihn veröffentlichst oder unterschreibst.';

export const FORMS = ['einzel', 'gbr', 'ek', 'ug', 'gmbh', 'ag', 'verein', 'freiberuf', 'sonstige'] as const;
export type LegalForm = (typeof FORMS)[number];
export const FORM_LABEL: Record<LegalForm, string> = { einzel: 'Einzelunternehmen / Gewerbe', gbr: 'GbR', ek: 'e. K.', ug: 'UG (haftungsbeschränkt)', gmbh: 'GmbH', ag: 'AG', verein: 'Verein', freiberuf: 'Freiberuf', sonstige: 'Sonstige' };
/** Forms that are entered in the Handelsregister / have representatives to name. */
const REGISTERED: LegalForm[] = ['ek', 'ug', 'gmbh', 'ag', 'verein'];

export interface LegalProfile {
  form: LegalForm;
  company: string;
  owner: string;
  street: string;
  zip: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  website: string;
  register_court: string;
  register_no: string;
  vat_id: string;
  responsible: string;
  profession: string;
  authority: string;
  dispute: 'none' | 'willing' | 'unwilling';
  dispute_body: string;
  dpo_name: string;
  dpo_email: string;
  hosting: string;
  supervisory: string;
  /** Services the detection cannot see (outside this system) or got wrong: id → on/off. */
  overrides: Record<string, boolean>;
  /** Optional external text source (eRecht24): only a configurable placeholder, nothing is called without a provider module. */
  external: { enabled: boolean; provider: string; apiKey: string; project: string };
}

export const BLANK_PROFILE: LegalProfile = {
  form: 'einzel',
  company: '',
  owner: '',
  street: '',
  zip: '',
  city: '',
  country: 'Deutschland',
  email: '',
  phone: '',
  website: '',
  register_court: '',
  register_no: '',
  vat_id: '',
  responsible: '',
  profession: '',
  authority: '',
  dispute: 'unwilling',
  dispute_body: '',
  dpo_name: '',
  dpo_email: '',
  hosting: '',
  supervisory: '',
  overrides: {},
  external: { enabled: false, provider: 'erecht24', apiKey: '', project: '' },
};

const s = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const urlOrEmpty = (v: unknown) => (/^https?:\/\/[^\s"'<>]{3,300}$/i.test(String(v ?? '').trim()) ? String(v).trim() : '');

/** Stored profile (anything a client could have written) → complete, clamped profile. */
export function cleanProfile(raw: unknown, base: Partial<LegalProfile> = {}): LegalProfile {
  const r: any = { ...BLANK_PROFILE, ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  const overrides: Record<string, boolean> = {};
  if (r.overrides && typeof r.overrides === 'object') for (const [k, v] of Object.entries(r.overrides)) if (/^[a-z0-9_]{1,40}$/.test(k) && typeof v === 'boolean') overrides[k] = v;
  return {
    form: (FORMS as readonly string[]).includes(r.form) ? r.form : 'einzel',
    company: s(r.company, 200),
    owner: s(r.owner, 300),
    street: s(r.street, 200),
    zip: s(r.zip, 20),
    city: s(r.city, 120),
    country: s(r.country, 80) || 'Deutschland',
    email: s(r.email, 200),
    phone: s(r.phone, 60),
    website: urlOrEmpty(r.website),
    register_court: s(r.register_court, 120),
    register_no: s(r.register_no, 60),
    vat_id: s(r.vat_id, 40),
    responsible: s(r.responsible, 300),
    profession: s(r.profession, 600),
    authority: s(r.authority, 400),
    dispute: r.dispute === 'willing' || r.dispute === 'none' ? r.dispute : 'unwilling',
    dispute_body: s(r.dispute_body, 400),
    dpo_name: s(r.dpo_name, 200),
    dpo_email: s(r.dpo_email, 200),
    hosting: s(r.hosting, 400),
    supervisory: s(r.supervisory, 400),
    overrides,
    external: { enabled: r.external?.enabled === true, provider: /^[a-z0-9_-]{1,30}$/.test(String(r.external?.provider ?? '')) ? String(r.external.provider) : 'erecht24', apiKey: s(r.external?.apiKey, 200), project: s(r.external?.project, 100) },
  };
}

/** "Straße 1\n10115 Berlin" (the sub-account's address field) → street, zip, city. */
export function splitAddress(address: string): { street: string; zip: string; city: string } {
  const lines = String(address ?? '').split(/\r?\n|,\s*(?=\d{5}\s)/).map((x) => x.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const m = last.match(/^(\d{4,5})\s+(.+)$/);
  if (m && lines.length >= 2) return { street: lines.slice(0, -1).join(', '), zip: m[1], city: m[2] };
  if (m) return { street: '', zip: m[1], city: m[2] };
  return { street: lines.join(', '), zip: '', city: '' };
}

// --- document model --------------------------------------------------------------------------------------------------------

export interface Section {
  heading: string;
  /** Plain text: paragraphs separated by a blank line, lines starting with "- " are list items; **bold**, [text](url). */
  body: string;
}
export interface LegalDoc {
  kind: string;
  title: string;
  /** Short line under the title (date, parties). */
  subtitle: string;
  sections: Section[];
  /** Gaps the user must fill: field label → what is missing. */
  missing: string[];
  notice: string;
  /** Ids of the services the text covers (Datenschutzerklärung) – shown in the wizard. */
  services: string[];
}

const TODO = (what: string) => `[bitte ergänzen: ${what}]`;
const or = (v: string, what: string, missing: string[], label = what) => {
  if (v.trim()) return v.trim();
  if (!missing.includes(label)) missing.push(label);
  return TODO(what);
};
const addr = (p: LegalProfile, missing: string[]) => [or(p.street, 'Straße und Hausnummer', missing), `${or(p.zip, 'PLZ', missing)} ${or(p.city, 'Ort', missing)}`, p.country].join('\n');
const dateDe = (at: Date) => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' }).format(at);

// --- Impressum ----------------------------------------------------------------------------------------------------------------

export function impressum(p: LegalProfile, now = new Date()): LegalDoc {
  const missing: string[] = [];
  const reg = REGISTERED.includes(p.form);
  const sections: Section[] = [];
  sections.push({ heading: 'Angaben gemäß § 5 DDG', body: `**${or(p.company, 'Firmenname mit Rechtsform', missing, 'Firmenname')}**\n${addr(p, missing)}` });
  if (p.form === 'einzel' || p.form === 'gbr' || p.form === 'freiberuf' || p.form === 'sonstige' || p.owner) sections.push({ heading: p.form === 'einzel' || p.form === 'freiberuf' ? 'Inhaber/in' : 'Vertretungsberechtigt', body: or(p.owner, 'Name der Inhaberin / des Inhabers bzw. der vertretungsberechtigten Personen', missing, 'Inhaber / Vertretung') });
  else if (reg) sections.push({ heading: 'Vertretungsberechtigt', body: or(p.owner, 'Geschäftsführer/in bzw. Vorstand', missing, 'Inhaber / Vertretung') });
  const contact = [`E-Mail: ${or(p.email, 'E-Mail-Adresse', missing, 'E-Mail')}`, p.phone ? `Telefon: ${p.phone}` : '', p.website ? `Website: ${p.website}` : ''].filter(Boolean).join('\n');
  sections.push({ heading: 'Kontakt', body: contact });
  if (reg || p.register_no || p.register_court) {
    sections.push({ heading: p.form === 'verein' ? 'Vereinsregister' : 'Registereintrag', body: `Registergericht: ${or(p.register_court, 'Registergericht', missing)}\nRegisternummer: ${or(p.register_no, 'Registernummer', missing)}` });
  }
  if (p.vat_id) sections.push({ heading: 'Umsatzsteuer-ID', body: `Umsatzsteuer-Identifikationsnummer gemäß § 27a Umsatzsteuergesetz: ${p.vat_id}` });
  if (p.form === 'freiberuf' || p.profession) sections.push({ heading: 'Berufsbezeichnung und berufsrechtliche Regelungen', body: or(p.profession, 'Berufsbezeichnung, zuständige Kammer, Staat der Verleihung, berufsrechtliche Regelungen mit Fundstelle', missing, 'Berufsrecht') });
  if (p.authority) sections.push({ heading: 'Zuständige Aufsichtsbehörde', body: p.authority });
  sections.push({ heading: 'Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV', body: `${p.responsible || p.owner || TODO('Name')}\n${p.street ? `${p.street}, ` : ''}${p.zip} ${p.city}`.trim() });
  if (!p.responsible && !p.owner) missing.push('Verantwortlich für den Inhalt');
  sections.push({
    heading: 'Verbraucherstreitbeilegung',
    body:
      p.dispute === 'willing'
        ? `Wir sind bereit, an einem Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen. Zuständig ist: ${or(p.dispute_body, 'Name und Anschrift der Verbraucherschlichtungsstelle', missing, 'Schlichtungsstelle')}.`
        : p.dispute === 'none'
          ? 'Hinweis nach § 36 VSBG: nicht erforderlich (weniger als 11 Beschäftigte oder kein Verbrauchergeschäft). Bitte prüfen.'
          : 'Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.',
  });
  sections.push({
    heading: 'Haftung für Inhalte',
    body: 'Als Diensteanbieter sind wir nach den allgemeinen Gesetzen für eigene Inhalte auf diesen Seiten verantwortlich. Wir sind jedoch nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu überwachen oder nach Umständen zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen. Verpflichtungen zur Entfernung oder Sperrung der Nutzung von Informationen nach den allgemeinen Gesetzen bleiben unberührt. Eine Haftung ist erst ab dem Zeitpunkt der Kenntnis einer konkreten Rechtsverletzung möglich; bei Bekanntwerden entsprechender Rechtsverletzungen entfernen wir diese Inhalte umgehend.',
  });
  sections.push({
    heading: 'Haftung für Links',
    body: 'Unser Angebot enthält Links zu externen Websites Dritter, auf deren Inhalte wir keinen Einfluss haben. Für diese fremden Inhalte kann daher keine Gewähr übernommen werden. Für die Inhalte der verlinkten Seiten ist stets der jeweilige Anbieter verantwortlich. Zum Zeitpunkt der Verlinkung waren keine Rechtsverstöße erkennbar; bei Bekanntwerden von Rechtsverletzungen entfernen wir derartige Links umgehend.',
  });
  sections.push({
    heading: 'Urheberrecht',
    body: 'Die durch uns erstellten Inhalte und Werke auf diesen Seiten unterliegen dem deutschen Urheberrecht. Vervielfältigung, Bearbeitung, Verbreitung und jede Art der Verwertung außerhalb der Grenzen des Urheberrechts bedürfen der schriftlichen Zustimmung. Soweit Inhalte nicht von uns erstellt wurden, werden die Urheberrechte Dritter beachtet; sollten Sie trotzdem auf eine Urheberrechtsverletzung aufmerksam werden, bitten wir um einen Hinweis.',
  });
  return { kind: 'impressum', title: 'Impressum', subtitle: `Stand: ${dateDe(now)}`, sections, missing, notice: LEGAL_NOTICE, services: [] };
}

// --- services the privacy policy talks about ----------------------------------------------------------------------------------

/** What the detection found (modules/legal-pages.ts fills it from the database; `overrides` of the profile are applied on top). */
export interface Facts {
  forms: boolean;
  newsletter: boolean;
  doi: boolean;
  email_provider: string;
  sms_provider: string;
  stripe: boolean;
  invoices: boolean;
  calendars: boolean;
  calendar_sync: string[];
  webinars: boolean;
  video_hosts: string[];
  chat: boolean;
  community: boolean;
  courses: boolean;
  telephony: boolean;
  voice_ai: boolean;
  ai_provider: string;
  attribution: boolean;
  cmp: boolean;
  trackers: string[];
  embeds: string[];
  whatsapp: boolean;
  tickets: boolean;
  affiliates: boolean;
  google_reviews: boolean;
  mailbox: boolean;
  email_tracking: boolean;
  employees: boolean;
}

export const EMPTY_FACTS: Facts = {
  forms: false, newsletter: false, doi: false, email_provider: '', sms_provider: '', stripe: false, invoices: false, calendars: false, calendar_sync: [], webinars: false,
  video_hosts: [], chat: false, community: false, courses: false, telephony: false, voice_ai: false, ai_provider: '', attribution: false, cmp: false, trackers: [], embeds: [],
  whatsapp: false, tickets: false, affiliates: false, google_reviews: false, mailbox: false, email_tracking: false, employees: false,
};

/** Every service with a section of its own: id, label for the wizard, and whether the facts say it is in use. */
export const SERVICES: { id: string; label: string; on: (f: Facts) => boolean }[] = [
  { id: 'forms', label: 'Kontaktformulare & Anfragen', on: (f) => f.forms },
  { id: 'newsletter', label: 'Newsletter / E-Mail-Marketing', on: (f) => f.newsletter },
  { id: 'email', label: 'E-Mail-Versand über Dienstleister', on: (f) => !!f.email_provider && f.email_provider !== 'smtp' && f.email_provider !== 'log' },
  { id: 'sms', label: 'SMS-Versand', on: (f) => !!f.sms_provider && f.sms_provider !== 'log' },
  { id: 'whatsapp', label: 'WhatsApp / Facebook Messenger / Instagram (Meta)', on: (f) => f.whatsapp },
  { id: 'stripe', label: 'Zahlungen über Stripe', on: (f) => f.stripe },
  { id: 'invoices', label: 'Rechnungen & Buchhaltung', on: (f) => f.invoices },
  { id: 'calendars', label: 'Online-Terminbuchung', on: (f) => f.calendars },
  { id: 'calendar_sync', label: 'Kalender-Abgleich (Google / Microsoft)', on: (f) => f.calendar_sync.length > 0 },
  { id: 'webinars', label: 'Webinare', on: (f) => f.webinars },
  { id: 'chat', label: 'Live-Chat', on: (f) => f.chat },
  { id: 'community', label: 'Community & Mitgliederbereich', on: (f) => f.community || f.courses },
  { id: 'telephony', label: 'Telefonie (Twilio)', on: (f) => f.telephony },
  { id: 'voice_ai', label: 'KI-Telefonagent', on: (f) => f.voice_ai },
  { id: 'ai', label: 'KI-Funktionen (Texte, Assistent)', on: (f) => !!f.ai_provider },
  { id: 'tickets', label: 'Support / Tickets', on: (f) => f.tickets },
  { id: 'affiliates', label: 'Partnerprogramm', on: (f) => f.affiliates },
  { id: 'google_reviews', label: 'Google-Bewertungen', on: (f) => f.google_reviews },
  { id: 'attribution', label: 'Eigene Herkunftsmessung (Cookie, ohne Drittanbieter)', on: (f) => f.attribution },
  { id: 'cmp', label: 'Cookie-Banner / Einwilligungsverwaltung', on: (f) => f.cmp },
  { id: 'hr', label: 'Beschäftigtendaten (Personal)', on: (f) => f.employees },
  { id: 'ga', label: 'Google Analytics / Google Tag Manager', on: (f) => f.trackers.includes('ga') },
  { id: 'meta_pixel', label: 'Meta-Pixel (Facebook / Instagram)', on: (f) => f.trackers.includes('meta_pixel') },
  { id: 'google_ads', label: 'Google Ads (Conversion-Tracking)', on: (f) => f.trackers.includes('google_ads') },
  { id: 'tiktok', label: 'TikTok-Pixel', on: (f) => f.trackers.includes('tiktok') },
  { id: 'linkedin', label: 'LinkedIn Insight Tag', on: (f) => f.trackers.includes('linkedin') },
  { id: 'hotjar', label: 'Hotjar / Microsoft Clarity', on: (f) => f.trackers.includes('hotjar') },
  { id: 'youtube', label: 'YouTube-Videos', on: (f) => f.embeds.includes('youtube') || f.video_hosts.includes('youtube') },
  { id: 'vimeo', label: 'Vimeo-Videos', on: (f) => f.embeds.includes('vimeo') || f.video_hosts.includes('vimeo') },
  { id: 'gmaps', label: 'Google Maps', on: (f) => f.embeds.includes('gmaps') },
  { id: 'gfonts', label: 'Google Fonts (von Google geladen)', on: (f) => f.embeds.includes('gfonts') },
  { id: 'calendly', label: 'Calendly / Typeform / weitere Einbettungen', on: (f) => f.embeds.includes('other') },
];

/** The ids that are on: what was detected, then the owner's overrides. */
export function activeServices(f: Facts, overrides: Record<string, boolean> = {}): string[] {
  return SERVICES.filter((x) => (x.id in overrides ? overrides[x.id] : x.on(f))).map((x) => x.id);
}

const PROVIDER: Record<string, string> = {
  resend: 'Resend (Resend, Inc., USA)',
  sendgrid: 'SendGrid (Twilio Inc., USA)',
  mailgun: 'Mailgun (Mailgun Technologies, Inc., USA)',
  postmark: 'Postmark (ActiveCampaign, LLC, USA)',
  brevo: 'Brevo (Sendinblue SAS, Frankreich)',
  ses: 'Amazon SES (Amazon Web Services EMEA SARL, Luxemburg)',
  mailjet: 'Mailjet (Mailjet SAS, Frankreich)',
  seven: 'seven.io (seven communications GmbH, Deutschland)',
  twilio: 'Twilio (Twilio Inc., USA)',
  sinch: 'Sinch (Sinch Sweden AB, Schweden)',
  messagebird: 'MessageBird / Bird (Bird B.V., Niederlande)',
};
const providerName = (id: string) => PROVIDER[id.toLowerCase()] ?? id;

// --- Datenschutzerklärung -----------------------------------------------------------------------------------------------------

export function datenschutz(p: LegalProfile, f: Facts, now = new Date()): LegalDoc {
  const missing: string[] = [];
  const on = new Set(activeServices(f, p.overrides));
  const has = (id: string) => on.has(id);
  const S: Section[] = [];
  const controller = [`**${or(p.company, 'Firmenname', missing, 'Firmenname')}**`, addr(p, missing), `E-Mail: ${or(p.email, 'E-Mail-Adresse', missing, 'E-Mail')}`, p.phone ? `Telefon: ${p.phone}` : ''].filter(Boolean).join('\n');

  S.push({ heading: '1. Verantwortlicher', body: `Verantwortlich für die Datenverarbeitung auf dieser Website und in unseren Diensten ist:\n\n${controller}${p.dpo_name || p.dpo_email ? `\n\nDatenschutzbeauftragte/r: ${[p.dpo_name, p.dpo_email].filter(Boolean).join(', ')}` : ''}` });
  S.push({
    heading: '2. Allgemeines zur Datenverarbeitung',
    body: 'Wir verarbeiten personenbezogene Daten nur, soweit das zur Bereitstellung unserer Angebote, zur Erfüllung von Verträgen, zur Beantwortung von Anfragen oder aufgrund Ihrer Einwilligung erforderlich ist. Rechtsgrundlagen sind:\n\n- Art. 6 Abs. 1 lit. a DSGVO (Einwilligung),\n- Art. 6 Abs. 1 lit. b DSGVO (Vertrag oder vorvertragliche Maßnahmen),\n- Art. 6 Abs. 1 lit. c DSGVO (rechtliche Verpflichtung, z. B. Aufbewahrungspflichten),\n- Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse, z. B. sicherer Betrieb).\n\nSoweit Informationen auf Ihrem Endgerät gespeichert oder abgerufen werden (z. B. Cookies), geschieht dies nach § 25 TDDDG nur mit Ihrer Einwilligung oder wenn es unbedingt erforderlich ist. Daten löschen wir, sobald der Zweck entfällt und keine gesetzliche Aufbewahrungsfrist entgegensteht.',
  });
  S.push({
    heading: '3. Hosting und Server-Logfiles',
    body: `Diese Website wird bei ${or(p.hosting, 'Hosting-Anbieter mit Anschrift', missing, 'Hosting-Anbieter')} gehostet, mit dem wir einen Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO geschlossen haben. Beim Aufruf der Seite erhebt der Server automatisch Daten, die Ihr Browser übermittelt: IP-Adresse, Datum und Uhrzeit, aufgerufene Seite, Referrer-URL, Browser und Betriebssystem. Das ist technisch erforderlich, um die Seite auszuliefern und den Betrieb abzusichern (Art. 6 Abs. 1 lit. f DSGVO). Die Logdaten werden nach kurzer Zeit gelöscht ${TODO('Dauer, z. B. 14 Tage')}. Die Verbindung ist per TLS verschlüsselt.`,
  });
  if (has('cmp')) {
    S.push({
      heading: 'Cookies und Einwilligungsverwaltung',
      body: 'Wir setzen einen Cookie-Banner ein. Er speichert Ihre Auswahl in einem Cookie (`pghl_cmp`, bis zu 180 Tage; technisch erforderlich) und protokolliert Ihre Entscheidung als Nachweis (Zeitpunkt, Version des Banners, Ihre Auswahl, gekürzte IP-Adresse – Netzwerk-Teil – und ein Fingerabdruck des Browsers) – Rechtsgrundlage Art. 6 Abs. 1 lit. c i. V. m. Art. 7 Abs. 1 DSGVO und lit. f. Das Protokoll wird nach drei Jahren gelöscht.\n\nOptionale Dienste (Statistik, Marketing, externe Medien) werden erst nach Ihrer Einwilligung geladen. Ihre Auswahl können Sie jederzeit mit Wirkung für die Zukunft ändern oder widerrufen: [Cookie-Einstellungen öffnen](#cookie-settings).',
    });
  }
  if (has('attribution')) {
    S.push({
      heading: 'Eigene Herkunftsmessung',
      body: 'Wir messen ohne Drittanbieter, über welche Quelle (z. B. Anzeige, Suchmaschine, Link) Besucher zu uns finden. Dabei speichern wir auf unserem eigenen Server die Herkunftsparameter (UTM, Referrer, Einstiegsseite – ohne Query-String). Ein Cookie (`pghl_vid`, bis zu 90 Tage), das wiedererkennt, wenn Sie später zurückkehren oder sich anmelden, wird nur mit Ihrer Einwilligung gesetzt (Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG). Ohne Einwilligung bleibt es bei der einmaligen Zuordnung ohne Cookie.',
    });
  }
  if (has('forms')) {
    S.push({
      heading: 'Kontaktformulare und Anfragen',
      body: 'Wenn Sie uns über ein Formular oder per E-Mail kontaktieren, verarbeiten wir Ihre Angaben (z. B. Name, E-Mail-Adresse, Telefonnummer, Nachricht), um Ihre Anfrage zu bearbeiten (Art. 6 Abs. 1 lit. b bzw. lit. f DSGVO). Die Daten werden in unserem Kundenverwaltungssystem gespeichert. Wir löschen sie, wenn Ihre Anfrage erledigt ist und keine Aufbewahrungspflicht besteht – spätestens nach drei Jahren, soweit keine Geschäftsbeziehung entsteht.',
    });
  }
  if (has('newsletter')) {
    S.push({
      heading: 'Newsletter und E-Mail-Werbung',
      body: `Wenn Sie sich für unseren Newsletter oder unsere E-Mail-Informationen anmelden, verarbeiten wir Ihre E-Mail-Adresse (und freiwillig Ihren Namen), um Ihnen die gewünschten Informationen zu senden. Rechtsgrundlage ist Ihre Einwilligung (Art. 6 Abs. 1 lit. a DSGVO, § 7 Abs. 2 Nr. 3 UWG).\n\n${has('forms') || f.doi ? 'Die Anmeldung erfolgt im **Double-Opt-in-Verfahren**: Nach der Anmeldung senden wir Ihnen eine E-Mail mit einem Bestätigungslink; erst mit Ihrem Klick wird die Anmeldung wirksam. ' : ''}Zum Nachweis Ihrer Einwilligung speichern wir Zeitpunkt, Quelle, den angezeigten Einwilligungstext (mit Version), das Netzwerk Ihrer IP-Adresse (gekürzt) und einen Fingerabdruck Ihres Browsers (Art. 6 Abs. 1 lit. c, f DSGVO i. V. m. Art. 7 Abs. 1 DSGVO).\n\nSie können Ihre Einwilligung jederzeit widerrufen – über den Abmeldelink in jeder E-Mail, über die Einstellungsseite, die dort verlinkt ist, oder durch eine Nachricht an uns. Die Rechtmäßigkeit der bis dahin erfolgten Verarbeitung bleibt unberührt.${f.email_tracking ? '\n\nWir messen, ob E-Mails geöffnet und Links angeklickt werden (Erfolgsmessung). Die Auswertung erfolgt pseudonym auf unserem Server; Automatisches Vorab-Laden durch Mail-Programme wird herausgefiltert.' : ''}`,
    });
  }
  if (has('email')) {
    S.push({ heading: 'E-Mail-Versand', body: `Für den Versand von E-Mails nutzen wir den Dienstleister ${providerName(f.email_provider)}. Dabei werden E-Mail-Adresse und Inhalt der Nachricht an den Dienstleister übermittelt. Mit dem Dienstleister besteht ein Vertrag zur Auftragsverarbeitung (Art. 28 DSGVO); bei Übermittlungen in Drittländer stützen wir uns auf Standardvertragsklauseln bzw. den Angemessenheitsbeschluss (EU-US Data Privacy Framework).` });
  }
  if (has('sms')) {
    S.push({ heading: 'SMS-Versand', body: `SMS-Nachrichten versenden wir über ${providerName(f.sms_provider || 'unseren SMS-Dienstleister')}. Übermittelt werden Ihre Telefonnummer und der Nachrichtentext. SMS mit Werbeinhalt senden wir nur mit Ihrer Einwilligung (Art. 6 Abs. 1 lit. a DSGVO, § 7 UWG); Service-Nachrichten (z. B. Terminerinnerungen) auf Grundlage von Art. 6 Abs. 1 lit. b DSGVO. Sie können jederzeit mit „STOP“ antworten.` });
  }
  if (has('whatsapp')) {
    S.push({ heading: 'WhatsApp, Messenger und Instagram', body: 'Wenn Sie uns über WhatsApp, den Facebook Messenger oder Instagram schreiben oder wir Ihnen dort antworten, werden die Nachrichten über die Plattformen der Meta Platforms Ireland Limited (Merrion Road, Dublin 4, Irland) übertragen. Wir erhalten Ihren Profilnamen, Ihre Telefonnummer bzw. Nutzer-ID und den Nachrichteninhalt und speichern sie in unserem Kundenverwaltungssystem (Art. 6 Abs. 1 lit. b bzw. f DSGVO). Werbliche WhatsApp-Nachrichten (Vorlagen) senden wir nur mit Ihrer Einwilligung. Es gelten zusätzlich die Datenschutzhinweise von Meta.' });
  }
  if (has('stripe')) {
    S.push({ heading: 'Zahlungsabwicklung mit Stripe', body: 'Für Kartenzahlung, SEPA-Lastschrift und weitere Zahlungsarten nutzen wir Stripe (Stripe Payments Europe, Ltd., 1 Grand Canal Street Lower, Grand Canal Dock, Dublin, Irland; ggf. Stripe, Inc., USA). Bei der Zahlung werden die für die Abwicklung nötigen Daten (Name, E-Mail, Betrag, Zahlungsdaten, Bestellinformationen) direkt an Stripe übertragen; Zahlungsdaten gelangen nicht auf unsere Server. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung), für Betrugsprävention auch lit. f. Stripe verarbeitet Daten auch als eigener Verantwortlicher – siehe die Datenschutzerklärung von Stripe (stripe.com/de/privacy). Übermittlungen in die USA stützen sich auf Standardvertragsklauseln bzw. das EU-US Data Privacy Framework.' });
  }
  if (has('invoices')) {
    S.push({ heading: 'Rechnungen, Buchhaltung und Aufbewahrung', body: 'Für Angebote, Rechnungen und die Buchführung verarbeiten wir Name, Anschrift, E-Mail-Adresse, Leistungs- und Zahlungsdaten (Art. 6 Abs. 1 lit. b und c DSGVO). Buchungsbelege bewahren wir nach § 147 AO und § 257 HGB acht Jahre, Bücher und Jahresabschlüsse zehn Jahre, Geschäftsbriefe sechs Jahre auf. Wir geben Daten an unsere Steuerberatung weiter, soweit das für die Buchführung nötig ist.' });
  }
  if (has('calendars')) {
    S.push({ heading: 'Online-Terminbuchung', body: 'Wenn Sie über unsere Buchungsseite einen Termin vereinbaren, verarbeiten wir Name, E-Mail-Adresse, ggf. Telefonnummer, gewählten Termin und Ihre Angaben im Formular, um den Termin durchzuführen und zu bestätigen (Art. 6 Abs. 1 lit. b DSGVO). Wir senden Bestätigungen und Erinnerungen per E-Mail oder SMS. Sie können den Termin über den Link in der Bestätigung verschieben oder absagen.' });
  }
  if (has('calendar_sync')) {
    const names = [f.calendar_sync.includes('google') ? 'Google Kalender (Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Irland)' : '', f.calendar_sync.includes('microsoft') ? 'Microsoft 365 / Outlook (Microsoft Ireland Operations Limited, One Microsoft Place, Dublin, Irland)' : ''].filter(Boolean);
    S.push({ heading: 'Kalender-Abgleich', body: `Damit gebuchte Termine in unserem Kalender erscheinen und Ihre Verfügbarkeit stimmt, gleichen wir unsere Termine mit ${names.join(' und ') || 'einem externen Kalenderdienst'} ab. Übertragen werden Termindaten (Zeit, Titel, ggf. Teilnehmer). Rechtsgrundlage ist Art. 6 Abs. 1 lit. b und f DSGVO.` });
  }
  if (has('webinars')) {
    S.push({ heading: 'Webinare', body: `Für die Anmeldung zu unseren Webinaren verarbeiten wir Name, E-Mail-Adresse (optional Telefonnummer), den gewählten Termin und Ihre Zeitzone, um Ihnen den Zugang, Erinnerungen und ggf. die Aufzeichnung zu senden (Art. 6 Abs. 1 lit. b DSGVO; für die Erinnerung per SMS Ihre Einwilligung). Während des Webinars erfassen wir Anwesenheit und Sehdauer, Ihre Fragen und Abstimmungen, um das Webinar durchzuführen und auszuwerten (Art. 6 Abs. 1 lit. f DSGVO).${f.video_hosts.length ? ` Das Video wird über ${f.video_hosts.map((h) => (h === 'youtube' ? 'YouTube' : h === 'vimeo' ? 'Vimeo' : h)).join(' bzw. ')} eingebunden (siehe unten).` : ' Das Video wird von unserem eigenen Server ausgeliefert; es werden keine Daten an Dritte übertragen.'}` });
  }
  if (has('chat')) {
    S.push({ heading: 'Live-Chat', body: 'Wenn Sie den Chat auf unserer Website nutzen, speichern wir Ihre Nachrichten, ggf. Ihren Namen und Ihre E-Mail-Adresse und die aufgerufene Seite, um Ihre Fragen zu beantworten (Art. 6 Abs. 1 lit. b bzw. f DSGVO). Der Chat wird von unserem eigenen System bereitgestellt. Die Nachrichten löschen wir, wenn die Anfrage erledigt ist.' });
  }
  if (has('community')) {
    S.push({ heading: 'Community, Kurse und Mitgliederbereich', body: 'Für den Zugang zu Kursen und zur Community verarbeiten wir Name, E-Mail-Adresse, Ihre Beiträge, Kommentare, Fortschritte und Aktivitäten (Art. 6 Abs. 1 lit. b DSGVO). Der Login erfolgt über einen Link per E-Mail; dazu setzen wir ein technisch erforderliches Sitzungs-Cookie. Beiträge sind für andere Mitglieder der jeweiligen Gruppe sichtbar. Sie können Ihr Konto jederzeit löschen lassen.' });
  }
  if (has('telephony')) {
    S.push({ heading: 'Telefonie', body: `Telefonate und Anrufe über unser System werden über Twilio (Twilio Inc., USA bzw. Twilio Ireland Limited, Dublin) vermittelt. Dabei werden Rufnummern, Zeitpunkt und Dauer verarbeitet; Aufzeichnungen erfolgen nur nach vorheriger Ansage und Ihrer Einwilligung (Art. 6 Abs. 1 lit. a, b DSGVO). Mit Twilio besteht ein Auftragsverarbeitungsvertrag; Drittlandübermittlungen sichern Standardvertragsklauseln bzw. das EU-US Data Privacy Framework.` });
  }
  if (has('voice_ai')) {
    S.push({ heading: 'KI-Telefonagent', body: 'Unser Telefonagent beantwortet Anrufe mit Hilfe künstlicher Intelligenz. Sie werden zu Beginn des Gesprächs darauf hingewiesen, dass Sie mit einer KI sprechen. Das Gespräch wird dazu in Text umgewandelt und von einem KI-Anbieter verarbeitet (siehe KI-Funktionen); eine Aufzeichnung erfolgt nur nach ausdrücklichem Hinweis (Art. 6 Abs. 1 lit. a bzw. f DSGVO). Auf Wunsch verbinden wir Sie mit einem Menschen.' });
  }
  if (has('ai')) {
    S.push({ heading: 'KI-Funktionen', body: `Wir nutzen KI-Funktionen (z. B. Antwortvorschläge, Zusammenfassungen, Texthilfe) auf Basis von ${f.ai_provider ? providerNameAi(f.ai_provider) : TODO('KI-Anbieter')}. Dabei können Inhalte von Nachrichten oder Anfragen an den Anbieter übermittelt werden (Art. 6 Abs. 1 lit. b bzw. f DSGVO). Entscheidungen mit rechtlicher Wirkung treffen wir nicht allein automatisiert. Mit dem Anbieter besteht ein Vertrag zur Auftragsverarbeitung; Drittlandübermittlungen stützen sich auf Standardvertragsklauseln.` });
  }
  if (has('tickets')) {
    S.push({ heading: 'Support und Tickets', body: 'Für Support-Anfragen speichern wir Ihre Nachrichten, Anhänge und Kontaktdaten als Ticket, um sie zu bearbeiten und die Qualität unseres Services zu messen (Art. 6 Abs. 1 lit. b bzw. f DSGVO). Zufriedenheitsumfragen nach einem Ticket sind freiwillig.' });
  }
  if (has('affiliates')) {
    S.push({ heading: 'Partnerprogramm', body: 'Wenn Sie über einen Partnerlink zu uns gelangen, ordnen wir den Besuch bzw. Kauf dem Partner zu, damit seine Provision berechnet werden kann (Art. 6 Abs. 1 lit. f DSGVO). Dabei wird der Partnercode gespeichert; ein Cookie wird nur mit Ihrer Einwilligung gesetzt. Dem Partner geben wir keine personenbezogenen Daten weiter.' });
  }
  if (has('google_reviews')) {
    S.push({ heading: 'Google-Bewertungen', body: 'Bewertungen, die Sie bei Google über uns abgeben, rufen wir über die Google-Schnittstelle (Google Business Profile / Places API) ab und zeigen sie ggf. an. Wir verarbeiten Name, Bewertungstext und -datum (Art. 6 Abs. 1 lit. f DSGVO). Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Irland.' });
  }
  if (has('hr')) {
    S.push({ heading: 'Beschäftigtendaten', body: 'Für das Beschäftigungsverhältnis verarbeiten wir Stammdaten, Abwesenheiten, Arbeitszeiten und Unterlagen unserer Mitarbeitenden (§ 26 BDSG, Art. 6 Abs. 1 lit. b DSGVO). Sie werden gesondert informiert; diese Daten sind für Besucher dieser Website nicht relevant. Bitte streichen, wenn keine eigene Mitarbeiterinformation gewünscht ist.' });
  }
  // Tools of other providers.
  const third: { id: string; heading: string; body: string }[] = [
    { id: 'ga', heading: 'Google Analytics / Google Tag Manager', body: 'Mit Ihrer Einwilligung nutzen wir Google Analytics bzw. den Google Tag Manager (Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Irland; ggf. Google LLC, USA), um die Nutzung unserer Website zu analysieren. Dabei werden Cookies bzw. Kennungen gesetzt und Daten (u. a. IP-Adresse, Seitenaufrufe, Geräteinformationen) an Google übertragen. Wir verwenden den Google Consent Mode: Ohne Ihre Einwilligung werden keine Analyse-Daten gesendet. Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG. Übermittlungen in die USA beruhen auf dem EU-US Data Privacy Framework. Sie können Ihre Einwilligung jederzeit über die [Cookie-Einstellungen](#cookie-settings) widerrufen.' },
    { id: 'google_ads', heading: 'Google Ads', body: 'Mit Ihrer Einwilligung messen wir mit Google Ads (Google Ireland Limited, Dublin, Irland) den Erfolg von Anzeigen (Conversion-Tracking) und spielen ggf. Anzeigen aus. Dabei können Cookies gesetzt und Daten an Google übertragen werden (Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG). Widerruf: [Cookie-Einstellungen](#cookie-settings).' },
    { id: 'meta_pixel', heading: 'Meta-Pixel (Facebook / Instagram)', body: 'Mit Ihrer Einwilligung nutzen wir das Meta-Pixel der Meta Platforms Ireland Limited (Merrion Road, Dublin 4, Irland), um die Wirkung von Werbung zu messen und Zielgruppen zu bilden. Dabei werden Cookies gesetzt und Daten (u. a. IP-Adresse, aufgerufene Seiten, Ereignisse) an Meta übertragen; Meta und wir sind für die Erhebung gemeinsam verantwortlich (Art. 26 DSGVO). Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG. Widerruf: [Cookie-Einstellungen](#cookie-settings).' },
    { id: 'tiktok', heading: 'TikTok-Pixel', body: 'Mit Ihrer Einwilligung nutzen wir das TikTok-Pixel (TikTok Technology Limited, Dublin, Irland), um Werbung zu messen. Dabei werden Cookies gesetzt und Daten an TikTok übertragen, ggf. auch in Drittländer. Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG. Widerruf: [Cookie-Einstellungen](#cookie-settings).' },
    { id: 'linkedin', heading: 'LinkedIn Insight Tag', body: 'Mit Ihrer Einwilligung nutzen wir das LinkedIn Insight Tag (LinkedIn Ireland Unlimited Company, Wilton Plaza, Dublin 2, Irland) zur Conversion-Messung und Zielgruppenbildung. Dabei werden Cookies gesetzt und Daten an LinkedIn übertragen (Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG). Widerruf: [Cookie-Einstellungen](#cookie-settings).' },
    { id: 'hotjar', heading: 'Hotjar / Microsoft Clarity', body: 'Mit Ihrer Einwilligung nutzen wir ein Analysewerkzeug (Hotjar Ltd., Malta, bzw. Microsoft Corporation, USA), das Mausbewegungen, Klicks und Scrollverhalten aufzeichnet, um die Nutzung der Seite zu verbessern. Eingaben in Formularfelder werden maskiert. Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG. Widerruf: [Cookie-Einstellungen](#cookie-settings).' },
    { id: 'youtube', heading: 'YouTube', body: 'Wir binden Videos von YouTube (Google Ireland Limited, Dublin, Irland) im erweiterten Datenschutzmodus (youtube-nocookie.com) ein. Die Videos werden erst nach Ihrer Einwilligung (Kategorie „Externe Medien“) geladen. Dabei wird Ihre IP-Adresse an YouTube übertragen und Informationen auf Ihrem Gerät gespeichert bzw. abgerufen (Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG).' },
    { id: 'vimeo', heading: 'Vimeo', body: 'Wir binden Videos von Vimeo (Vimeo.com, Inc., USA) ein. Sie werden erst nach Ihrer Einwilligung (Kategorie „Externe Medien“) geladen; dabei wird Ihre IP-Adresse an Vimeo übertragen und Informationen auf Ihrem Gerät gespeichert bzw. abgerufen (Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG). Übermittlungen in die USA beruhen auf Standardvertragsklauseln bzw. dem EU-US Data Privacy Framework.' },
    { id: 'gmaps', heading: 'Google Maps', body: 'Wir binden Karten von Google Maps (Google Ireland Limited, Dublin, Irland) ein, die erst nach Ihrer Einwilligung (Kategorie „Externe Medien“) geladen werden. Dabei wird Ihre IP-Adresse an Google übertragen (Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG).' },
    { id: 'gfonts', heading: 'Google Fonts', body: 'Schriften werden von Google Fonts (Google Ireland Limited, Dublin, Irland) geladen – erst nach Ihrer Einwilligung (Kategorie „Externe Medien“). Dabei wird Ihre IP-Adresse an Google übertragen. Ohne Einwilligung verwenden wir Systemschriften. Hinweis: Besser ist es, die Schriften lokal einzubinden.' },
    { id: 'calendly', heading: 'Weitere eingebundene Dienste', body: `Auf einzelnen Seiten binden wir Dienste Dritter ein (z. B. Terminbuchung, Formulare oder Medien). Sie werden erst nach Ihrer Einwilligung geladen; dabei wird Ihre IP-Adresse an den jeweiligen Anbieter übertragen (Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG). ${TODO('Anbieter und Zweck nennen')}` },
  ];
  for (const t of third) if (has(t.id)) S.push({ heading: t.heading, body: t.body });

  S.push({
    heading: 'Ihre Rechte',
    body: 'Sie haben gegenüber uns folgende Rechte hinsichtlich Ihrer personenbezogenen Daten:\n\n- Auskunft (Art. 15 DSGVO),\n- Berichtigung (Art. 16 DSGVO),\n- Löschung (Art. 17 DSGVO),\n- Einschränkung der Verarbeitung (Art. 18 DSGVO),\n- Datenübertragbarkeit (Art. 20 DSGVO),\n- Widerspruch gegen Verarbeitungen auf Grundlage berechtigter Interessen (Art. 21 DSGVO) – bei Direktwerbung jederzeit.\n\n**Widerruf einer Einwilligung:** Sie können eine erteilte Einwilligung jederzeit mit Wirkung für die Zukunft widerrufen. Die Rechtmäßigkeit der bis zum Widerruf erfolgten Verarbeitung bleibt unberührt.\n\nZur Ausübung Ihrer Rechte genügt eine Nachricht an die oben genannte Adresse.',
  });
  S.push({
    heading: 'Beschwerderecht bei der Aufsichtsbehörde',
    body: `Sie haben das Recht, sich bei einer Datenschutz-Aufsichtsbehörde zu beschweren (Art. 77 DSGVO). Zuständig ist ${p.supervisory ? p.supervisory : TODO('Landesdatenschutzbehörde Ihres Bundeslandes')}.`,
  });
  if (!p.supervisory) missing.push('Aufsichtsbehörde');
  S.push({ heading: 'Änderungen', body: `Wir passen diese Datenschutzerklärung an, wenn sich unsere Angebote oder die Rechtslage ändern. Es gilt die jeweils aktuelle Fassung. Stand: ${dateDe(now)}.` });
  return { kind: 'datenschutz', title: 'Datenschutzerklärung', subtitle: `Stand: ${dateDe(now)}`, sections: S, missing, notice: LEGAL_NOTICE, services: [...on] };
}

function providerNameAi(id: string): string {
  const k = id.toLowerCase();
  if (k.includes('anthropic') || k.includes('claude')) return 'Claude (Anthropic PBC, USA)';
  if (k.includes('openai') || k.includes('chatgpt')) return 'OpenAI (OpenAI Ireland Ltd. / OpenAI, L.L.C., USA)';
  return id;
}

// --- AVV ---------------------------------------------------------------------------------------------------------------------------

export interface Party {
  name: string;
  address: string;
  representative?: string;
}
export interface AvvInput {
  /** Auftraggeber (Verantwortlicher). */
  controller: Party;
  /** Auftragnehmer (Auftragsverarbeiter) – by default the company of the profile. */
  processor: Party;
  /** Short description of the service (what the processor does for the controller). */
  service?: string;
  /** Sub-processors: name, task, place. */
  subprocessors?: { name: string; task: string; place: string }[];
}

const TOMS = [
  'Zutrittskontrolle: Betrieb in Rechenzentren mit Zutrittsbeschränkung; keine Daten auf lokalen Endgeräten außer verschlüsselten Zwischenspeichern.',
  'Zugangskontrolle: Anmeldung mit persönlichem Konto und starkem Passwort, optional Zwei-Faktor-Authentifizierung und Passkeys; Sitzungen laufen ab; Sperre nach wiederholten Fehlversuchen.',
  'Zugriffskontrolle: Rollen und Rechte je Bereich (Sub-Account-Zuordnung, Bereichsrechte); Mandantentrennung – jede Abfrage ist auf den Sub-Account des Auftraggebers beschränkt; API-Schlüssel nur je Sub-Account.',
  'Weitergabekontrolle: Verschlüsselung der Übertragung mit TLS; Zugangsdaten und Schlüssel liegen verschlüsselt (AES-256-GCM) in der Datenbank; Webhooks werden signiert.',
  'Eingabekontrolle: Änderungsprotokoll (Audit-Log) für schreibende Zugriffe, Rückgängig-Funktion für Datensätze.',
  'Auftragskontrolle: Verarbeitung nur nach dokumentierter Weisung des Auftraggebers; Unterauftragnehmer sind vertraglich verpflichtet.',
  'Verfügbarkeitskontrolle: regelmäßige Datensicherung, getrennte Aufbewahrung der Sicherungen, Wiederherstellungstests; Überwachung der Systeme.',
  'Trennungsgebot: Daten verschiedener Auftraggeber werden logisch getrennt (je Sub-Account) und nur für den jeweiligen Zweck verarbeitet.',
  'Datenminimierung und Löschung: Löschkonzept; Kontakte lassen sich vollständig exportieren (Art. 15) und löschen (Art. 17); IP-Adressen in Einwilligungsnachweisen werden gekürzt gespeichert.',
  'Organisation: Verpflichtung der Mitarbeitenden auf Vertraulichkeit; Schulung zum Datenschutz; Verfahren zur Meldung von Datenschutzvorfällen innerhalb von 24 Stunden.',
];

export function avv(p: LegalProfile, input: Partial<AvvInput>, f: Facts, now = new Date()): LegalDoc {
  const missing: string[] = [];
  const proc = input.processor ?? { name: p.company, address: [p.street, `${p.zip} ${p.city}`.trim()].filter(Boolean).join(', '), representative: p.owner };
  const ctrl = input.controller ?? { name: '', address: '' };
  const pname = or(proc.name, 'Name des Auftragnehmers', missing, 'Auftragnehmer');
  const cname = or(ctrl.name, 'Name des Auftraggebers', missing, 'Auftraggeber');
  const on = new Set(activeServices(f, p.overrides));
  const subs = input.subprocessors ?? defaultSubprocessors(p, f, on);
  const dataKinds = ['Kontaktdaten (Name, E-Mail, Telefon, Anschrift, Firma)', 'Kommunikationsdaten (E-Mails, SMS, Chat-Nachrichten)', 'Vertrags- und Abrechnungsdaten', 'Nutzungs- und Protokolldaten (IP-Adresse, Zeitstempel, Herkunft)', 'Einwilligungsnachweise (Zeitpunkt, Quelle, Text-Version, gekürzte IP)'];
  if (on.has('calendars') || on.has('webinars')) dataKinds.push('Termin- und Anmeldedaten');
  if (on.has('hr')) dataKinds.push('Beschäftigtendaten (nur nach gesonderter Vereinbarung)');
  const S: Section[] = [
    { heading: 'Vertragsparteien', body: `**Auftraggeber (Verantwortlicher):**\n${cname}\n${or(ctrl.address, 'Anschrift des Auftraggebers', missing, 'Anschrift Auftraggeber')}${ctrl.representative ? `\nVertreten durch: ${ctrl.representative}` : ''}\n\n**Auftragnehmer (Auftragsverarbeiter):**\n${pname}\n${or(proc.address, 'Anschrift des Auftragnehmers', missing, 'Anschrift Auftragnehmer')}${proc.representative ? `\nVertreten durch: ${proc.representative}` : ''}` },
    { heading: '§ 1 Gegenstand und Dauer', body: `(1) Der Auftragnehmer verarbeitet personenbezogene Daten im Auftrag des Auftraggebers. Gegenstand ist ${input.service?.trim() || 'die Bereitstellung und der Betrieb der Kundenverwaltungs-, Kommunikations- und Marketing-Software (CRM, Formulare, Seiten, E-Mail/SMS, Termine, Zahlungen) für den Auftraggeber'} (Hauptvertrag).\n\n(2) Die Dauer dieses Vertrags entspricht der Laufzeit des Hauptvertrags.` },
    { heading: '§ 2 Art, Zweck, Daten und Betroffene', body: `(1) Art und Zweck der Verarbeitung: Speicherung, Abruf, Übermittlung, Auswertung und Löschung von Daten zur Erbringung der vereinbarten Leistung.\n\n(2) Arten personenbezogener Daten:\n${dataKinds.map((x) => `- ${x}`).join('\n')}\n\n(3) Kategorien betroffener Personen: Kundinnen und Kunden, Interessenten, Newsletter-Abonnenten, Teilnehmende von Terminen und Webinaren, Community-Mitglieder, Ansprechpartner von Geschäftskunden, Beschäftigte des Auftraggebers.` },
    { heading: '§ 3 Pflichten des Auftragnehmers', body: '(1) Der Auftragnehmer verarbeitet die Daten ausschließlich nach dokumentierter Weisung des Auftraggebers, auch in Bezug auf Übermittlungen in ein Drittland, es sei denn, er ist durch Unionsrecht oder das Recht eines Mitgliedstaats zur Verarbeitung verpflichtet. Er informiert den Auftraggeber, wenn er eine Weisung für rechtswidrig hält.\n\n(2) Der Auftragnehmer gewährleistet, dass sich die zur Verarbeitung befugten Personen zur Vertraulichkeit verpflichtet haben.\n\n(3) Der Auftragnehmer trifft die in der **Anlage 1** beschriebenen technischen und organisatorischen Maßnahmen (Art. 32 DSGVO) und entwickelt sie weiter.\n\n(4) Er unterstützt den Auftraggeber bei der Erfüllung der Betroffenenrechte (Art. 15 bis 22 DSGVO; die Software bietet Auskunft und Löschung je Kontakt), bei der Einhaltung der Pflichten nach Art. 32 bis 36 DSGVO und bei Datenschutz-Folgenabschätzungen.\n\n(5) Er meldet Verletzungen des Schutzes personenbezogener Daten unverzüglich, spätestens innerhalb von 24 Stunden nach Kenntnis.\n\n(6) Nach Abschluss der Leistungen löscht oder gibt der Auftragnehmer nach Wahl des Auftraggebers alle Daten zurück (Export), sofern keine gesetzliche Aufbewahrungspflicht besteht.' },
    { heading: '§ 4 Rechte und Pflichten des Auftraggebers', body: 'Der Auftraggeber ist für die Rechtmäßigkeit der Verarbeitung und die Wahrung der Betroffenenrechte verantwortlich. Er erteilt Weisungen in Textform (E-Mail genügt). Er ist berechtigt, sich vor Beginn und während der Laufzeit von der Einhaltung der Maßnahmen zu überzeugen (Auskünfte, Nachweise, Prüfungen nach rechtzeitiger Anmeldung). Der Auftragnehmer duldet und unterstützt Überprüfungen.' },
    { heading: '§ 5 Unterauftragsverhältnisse', body: `(1) Der Auftraggeber stimmt dem Einsatz der in **Anlage 2** genannten Unterauftragsverarbeiter zu. Der Auftragnehmer verpflichtet sie vertraglich auf dieselben Pflichten wie in diesem Vertrag.\n\n(2) Über beabsichtigte Änderungen informiert der Auftragnehmer mindestens 14 Tage vorher in Textform; der Auftraggeber kann aus wichtigem Grund widersprechen.` },
    { heading: '§ 6 Drittlandübermittlung', body: 'Eine Verarbeitung außerhalb der EU/des EWR findet nur statt, wenn die Voraussetzungen der Art. 44 ff. DSGVO erfüllt sind (Angemessenheitsbeschluss, z. B. EU-US Data Privacy Framework, oder Standardvertragsklauseln mit zusätzlichen Maßnahmen).' },
    { heading: '§ 7 Haftung', body: 'Für die Haftung gilt Art. 82 DSGVO. Im Übrigen gelten die Haftungsregeln des Hauptvertrags.' },
    { heading: '§ 8 Schlussbestimmungen', body: 'Änderungen und Ergänzungen bedürfen der Textform. Sollte eine Bestimmung unwirksam sein, bleibt der Vertrag im Übrigen wirksam. Es gilt deutsches Recht. Bei Widersprüchen geht dieser Vertrag dem Hauptvertrag vor, soweit es um den Datenschutz geht.\n\nOrt, Datum: ____________\n\n______________________ (Auftraggeber)        ______________________ (Auftragnehmer)' },
    { heading: 'Anlage 1 – Technische und organisatorische Maßnahmen', body: TOMS.map((x) => `- ${x}`).join('\n') },
    { heading: 'Anlage 2 – Unterauftragsverarbeiter', body: subs.length ? subs.map((x) => `- **${x.name}** – ${x.task} (${x.place})`).join('\n') : '- keine' },
  ];
  return { kind: 'avv', title: 'Vertrag zur Auftragsverarbeitung (Art. 28 DSGVO)', subtitle: `Entwurf vom ${dateDe(now)}`, sections: S, missing, notice: LEGAL_NOTICE, services: [...on] };
}

function defaultSubprocessors(p: LegalProfile, f: Facts, on: Set<string>): { name: string; task: string; place: string }[] {
  const out: { name: string; task: string; place: string }[] = [{ name: p.hosting || TODO('Hosting-Anbieter'), task: 'Hosting, Betrieb der Server und Datensicherung', place: 'EU/EWR' }];
  if (on.has('email')) out.push({ name: providerName(f.email_provider), task: 'E-Mail-Versand', place: 'siehe Anbieter' });
  if (on.has('sms')) out.push({ name: providerName(f.sms_provider), task: 'SMS-Versand', place: 'siehe Anbieter' });
  if (on.has('telephony')) out.push({ name: 'Twilio', task: 'Telefonie', place: 'EU/USA (DPF/SCC)' });
  if (on.has('ai')) out.push({ name: providerNameAi(f.ai_provider), task: 'KI-Funktionen (nur wenn aktiviert)', place: 'USA (DPF/SCC)' });
  if (on.has('whatsapp')) out.push({ name: 'Meta Platforms Ireland Limited', task: 'WhatsApp-/Messenger-/Instagram-Nachrichten', place: 'Irland/USA' });
  if (on.has('calendar_sync')) out.push({ name: f.calendar_sync.includes('microsoft') ? 'Google / Microsoft' : 'Google Ireland Limited', task: 'Kalender-Abgleich', place: 'Irland' });
  return out;
}

// --- VVT ---------------------------------------------------------------------------------------------------------------------------

interface Activity {
  id: string;
  name: string;
  purpose: string;
  basis: string;
  subjects: string;
  data: string;
  recipients: string;
  third: string;
  deletion: string;
}

export function vvt(p: LegalProfile, f: Facts, now = new Date()): LegalDoc {
  const missing: string[] = [];
  const on = new Set(activeServices(f, p.overrides));
  const A: Activity[] = [
    { id: 'crm', name: 'Kundenverwaltung (CRM) und Kommunikation', purpose: 'Verwaltung von Kunden- und Interessentendaten, Konversationen, Aufgaben und Pipelines', basis: 'Art. 6 Abs. 1 lit. b, f DSGVO', subjects: 'Kunden, Interessenten, Ansprechpartner', data: 'Name, Kontaktdaten, Firma, Notizen, Kommunikationsverlauf, Herkunft', recipients: 'Hosting-Dienstleister (Auftragsverarbeiter)', third: 'nein', deletion: 'Nach Wegfall des Zwecks; Geschäftsbriefe 6 Jahre (§ 257 HGB)' },
  ];
  if (on.has('forms')) A.push({ id: 'forms', name: 'Kontaktformulare und Anfragen', purpose: 'Bearbeitung von Anfragen', basis: 'Art. 6 Abs. 1 lit. b, f DSGVO', subjects: 'Interessenten', data: 'Name, E-Mail, Telefon, Nachricht, Formularantworten', recipients: 'Hosting-Dienstleister', third: 'nein', deletion: 'Spätestens 3 Jahre nach Erledigung' });
  if (on.has('newsletter')) A.push({ id: 'newsletter', name: 'Newsletter und E-Mail-Werbung', purpose: 'Versand von Informationen und Angeboten', basis: 'Art. 6 Abs. 1 lit. a DSGVO, § 7 UWG; Nachweis Art. 6 Abs. 1 lit. c, f i. V. m. Art. 7 Abs. 1', subjects: 'Abonnenten', data: 'E-Mail, Name, Einwilligungsnachweis (Zeit, Quelle, Text-Version, gekürzte IP, Browser-Fingerabdruck), Öffnungen/Klicks', recipients: `Hosting-Dienstleister${on.has('email') ? `, ${providerName(f.email_provider)}` : ''}`, third: on.has('email') ? 'ggf. USA (DPF/SCC)' : 'nein', deletion: 'Bis zum Widerruf; Nachweis bis 3 Jahre danach (Verjährung)' });
  if (on.has('invoices') || on.has('stripe')) A.push({ id: 'billing', name: 'Rechnungsstellung, Buchhaltung und Zahlung', purpose: 'Abrechnung, Buchführung, Zahlungsabwicklung', basis: 'Art. 6 Abs. 1 lit. b, c DSGVO', subjects: 'Kunden, Lieferanten', data: 'Name, Anschrift, Rechnungs- und Zahlungsdaten', recipients: `Steuerberatung${on.has('stripe') ? ', Stripe (Zahlungsdienstleister)' : ''}, Finanzbehörden`, third: on.has('stripe') ? 'ggf. USA (DPF/SCC)' : 'nein', deletion: 'Belege 8 Jahre, Bücher 10 Jahre (§ 147 AO)' });
  if (on.has('calendars')) A.push({ id: 'calendars', name: 'Terminbuchung', purpose: 'Terminvereinbarung und -erinnerung', basis: 'Art. 6 Abs. 1 lit. b DSGVO', subjects: 'Kunden, Interessenten', data: 'Name, Kontaktdaten, Termin, Antworten', recipients: `Hosting-Dienstleister${on.has('calendar_sync') ? ', Kalenderanbieter (Google/Microsoft)' : ''}`, third: on.has('calendar_sync') ? 'ggf. USA' : 'nein', deletion: '3 Jahre nach dem Termin' });
  if (on.has('webinars')) A.push({ id: 'webinars', name: 'Webinare', purpose: 'Anmeldung, Durchführung, Erinnerung, Auswertung', basis: 'Art. 6 Abs. 1 lit. a, b, f DSGVO', subjects: 'Teilnehmende', data: 'Name, E-Mail, Telefon (optional), Anwesenheit, Sehdauer, Fragen, Abstimmungen', recipients: 'Hosting-Dienstleister', third: f.video_hosts.length ? 'ggf. USA (Videoanbieter)' : 'nein', deletion: '1 Jahr nach dem Webinar bzw. Widerruf' });
  if (on.has('community') ) A.push({ id: 'community', name: 'Kurse, Community und Mitgliederbereich', purpose: 'Bereitstellung von Zugang, Inhalten und Austausch', basis: 'Art. 6 Abs. 1 lit. b DSGVO', subjects: 'Mitglieder, Kursteilnehmende', data: 'Name, E-Mail, Beiträge, Fortschritt, Aktivität', recipients: 'Hosting-Dienstleister', third: 'nein', deletion: 'Bis zur Kündigung des Zugangs, danach 6 Monate' });
  if (on.has('tickets')) A.push({ id: 'tickets', name: 'Support und Tickets', purpose: 'Bearbeitung von Support-Anfragen', basis: 'Art. 6 Abs. 1 lit. b, f DSGVO', subjects: 'Kunden', data: 'Name, Kontaktdaten, Nachrichten, Anhänge', recipients: 'Hosting-Dienstleister', third: 'nein', deletion: '2 Jahre nach Abschluss' });
  if (on.has('telephony') || on.has('voice_ai')) A.push({ id: 'phone', name: 'Telefonie', purpose: 'Anrufe, Anrufprotokoll, ggf. Aufzeichnung und KI-Telefonagent', basis: 'Art. 6 Abs. 1 lit. a, b, f DSGVO', subjects: 'Anrufende, Kunden', data: 'Rufnummer, Zeit, Dauer, ggf. Aufzeichnung/Transkript', recipients: 'Twilio (Telefonanbieter)', third: 'EU/USA (DPF/SCC)', deletion: 'Aufzeichnungen nach 30 Tagen, Protokoll 1 Jahr' });
  if (on.has('attribution') || on.has('cmp') || on.has('ga')) A.push({ id: 'tracking', name: 'Reichweitenmessung und Einwilligungsverwaltung', purpose: 'Herkunftsmessung, Cookie-Einwilligung, Nachweis', basis: 'Art. 6 Abs. 1 lit. a DSGVO, § 25 TDDDG; Nachweis lit. c, f', subjects: 'Website-Besucher', data: 'Herkunftsparameter, Cookie-ID, Einwilligungsprotokoll (gekürzte IP, Browser-Fingerabdruck)', recipients: `Hosting-Dienstleister${on.has('ga') ? ', Google' : ''}${on.has('meta_pixel') ? ', Meta' : ''}`, third: on.has('ga') || on.has('meta_pixel') ? 'USA (DPF)' : 'nein', deletion: 'Cookie 90 Tage; Protokoll 3 Jahre' });
  if (on.has('ai')) A.push({ id: 'ai', name: 'KI-Funktionen', purpose: 'Antwortvorschläge, Zusammenfassungen, Texthilfe', basis: 'Art. 6 Abs. 1 lit. b, f DSGVO', subjects: 'Kunden, Interessenten', data: 'Nachrichteninhalte, Kontaktdaten im Kontext', recipients: providerNameAi(f.ai_provider), third: 'USA (DPF/SCC)', deletion: 'Beim Anbieter gemäß Vertrag (keine Speicherung zu Trainingszwecken vereinbart)' });
  if (on.has('hr')) A.push({ id: 'hr', name: 'Personalverwaltung', purpose: 'Durchführung des Beschäftigungsverhältnisses, Abwesenheiten, Zeiten', basis: '§ 26 BDSG, Art. 6 Abs. 1 lit. b, c DSGVO', subjects: 'Beschäftigte', data: 'Stammdaten, Abwesenheiten, Arbeitszeiten, Unterlagen', recipients: 'Steuerberatung/Lohnbüro, Sozialversicherungsträger', third: 'nein', deletion: 'Nach Gesetz (3–10 Jahre)' });

  const head = `**Verantwortlicher:** ${or(p.company, 'Firmenname', missing, 'Firmenname')}\n${addr(p, missing)}\nE-Mail: ${or(p.email, 'E-Mail-Adresse', missing, 'E-Mail')}${p.phone ? `\nTelefon: ${p.phone}` : ''}\nVertreter: ${or(p.owner, 'Inhaber / Geschäftsführung', missing, 'Inhaber / Vertretung')}\nDatenschutzbeauftragte/r: ${p.dpo_name || p.dpo_email ? [p.dpo_name, p.dpo_email].filter(Boolean).join(', ') : 'nicht benannt (bitte prüfen: Pflicht ab 20 Personen, die ständig Daten automatisiert verarbeiten, § 38 BDSG)'}`;
  const S: Section[] = [{ heading: 'Angaben zum Verantwortlichen (Art. 30 Abs. 1 lit. a)', body: head }];
  A.forEach((a, i) => S.push({ heading: `${i + 1}. ${a.name}`, body: `- **Zweck:** ${a.purpose}\n- **Rechtsgrundlage:** ${a.basis}\n- **Betroffene Personen:** ${a.subjects}\n- **Datenkategorien:** ${a.data}\n- **Empfänger:** ${a.recipients}\n- **Drittlandübermittlung:** ${a.third}\n- **Löschfristen:** ${a.deletion}\n- **Technische und organisatorische Maßnahmen:** siehe Anlage` }));
  S.push({ heading: 'Anlage – Technische und organisatorische Maßnahmen (Art. 32)', body: TOMS.map((x) => `- ${x}`).join('\n') });
  return { kind: 'vvt', title: 'Verzeichnis von Verarbeitungstätigkeiten (Art. 30 DSGVO)', subtitle: `Stand: ${dateDe(now)}`, sections: S, missing, notice: LEGAL_NOTICE, services: [...on] };
}

// --- Widerrufsbelehrung (Muster nach Anlage 1 zu Art. 246a § 1 Abs. 2 Satz 2 EGBGB) ----------------------------------------------------

export type SaleKind = 'digital' | 'service' | 'physical';

/** The model withdrawal notice and form, with the company's data filled in. Keep the wording: deviations lose the protection of the model. */
export function widerruf(p: LegalProfile, kind: SaleKind = 'digital', now = new Date()): LegalDoc {
  const missing: string[] = [];
  const who = [or(p.company, 'Firmenname', missing, 'Firmenname'), [or(p.street, 'Straße und Hausnummer', missing), `${or(p.zip, 'PLZ', missing)} ${or(p.city, 'Ort', missing)}`].join(', '), p.phone ? `Telefon: ${p.phone}` : '', `E-Mail: ${or(p.email, 'E-Mail-Adresse', missing, 'E-Mail')}`].filter(Boolean).join(', ');
  const start = kind === 'physical' ? 'Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag, an dem Sie oder ein von Ihnen benannter Dritter, der nicht der Beförderer ist, die Waren in Besitz genommen haben bzw. hat.' : 'Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag des Vertragsabschlusses.';
  const S: Section[] = [
    { heading: 'Widerrufsrecht', body: `Sie haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen. ${start}\n\nUm Ihr Widerrufsrecht auszuüben, müssen Sie uns (${who}) mittels einer eindeutigen Erklärung (z. B. ein mit der Post versandter Brief oder eine E-Mail) über Ihren Entschluss, diesen Vertrag zu widerrufen, informieren. Sie können dafür das beigefügte Muster-Widerrufsformular verwenden, das jedoch nicht vorgeschrieben ist.\n\nZur Wahrung der Widerrufsfrist reicht es aus, dass Sie die Mitteilung über die Ausübung des Widerrufsrechts vor Ablauf der Widerrufsfrist absenden.` },
    { heading: 'Folgen des Widerrufs', body: `Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle Zahlungen, die wir von Ihnen erhalten haben${kind === 'physical' ? ', einschließlich der Lieferkosten (mit Ausnahme der zusätzlichen Kosten, die sich daraus ergeben, dass Sie eine andere Art der Lieferung als die von uns angebotene, günstigste Standardlieferung gewählt haben)' : ''}, unverzüglich und spätestens binnen vierzehn Tagen ab dem Tag zurückzuzahlen, an dem die Mitteilung über Ihren Widerruf dieses Vertrags bei uns eingegangen ist. Für diese Rückzahlung verwenden wir dasselbe Zahlungsmittel, das Sie bei der ursprünglichen Transaktion eingesetzt haben, es sei denn, mit Ihnen wurde ausdrücklich etwas anderes vereinbart; in keinem Fall werden Ihnen wegen dieser Rückzahlung Entgelte berechnet.${kind === 'physical' ? '\n\nWir können die Rückzahlung verweigern, bis wir die Waren wieder zurückerhalten haben oder bis Sie den Nachweis erbracht haben, dass Sie die Waren zurückgesandt haben, je nachdem, welches der frühere Zeitpunkt ist.\n\nSie haben die Waren unverzüglich und in jedem Fall spätestens binnen vierzehn Tagen ab dem Tag, an dem Sie uns über den Widerruf dieses Vertrags unterrichten, an uns zurückzusenden oder zu übergeben. Die Frist ist gewahrt, wenn Sie die Waren vor Ablauf der Frist von vierzehn Tagen absenden. Sie tragen die unmittelbaren Kosten der Rücksendung der Waren. Sie müssen für einen etwaigen Wertverlust der Waren nur aufkommen, wenn dieser Wertverlust auf einen zur Prüfung der Beschaffenheit, Eigenschaften und Funktionsweise der Waren nicht notwendigen Umgang mit ihnen zurückzuführen ist.' : ''}` },
  ];
  if (kind === 'service') S.push({ heading: 'Besonderheiten bei Dienstleistungen', body: 'Haben Sie verlangt, dass die Dienstleistungen während der Widerrufsfrist beginnen sollen, so haben Sie uns einen angemessenen Betrag zu zahlen, der dem Anteil der bis zu dem Zeitpunkt, zu dem Sie uns von der Ausübung des Widerrufsrechts hinsichtlich dieses Vertrags unterrichten, bereits erbrachten Dienstleistungen im Vergleich zum Gesamtumfang der im Vertrag vorgesehenen Dienstleistungen entspricht.\n\nIhr Widerrufsrecht erlischt bei einem Vertrag über die Erbringung von Dienstleistungen vorzeitig, wenn wir die Dienstleistung vollständig erbracht haben und mit der Ausführung der Dienstleistung erst begonnen haben, nachdem Sie dazu Ihre ausdrückliche Zustimmung gegeben haben und gleichzeitig Ihre Kenntnis davon bestätigt haben, dass Sie Ihr Widerrufsrecht bei vollständiger Vertragserfüllung durch uns verlieren.' });
  if (kind === 'digital') S.push({ heading: 'Vorzeitiges Erlöschen des Widerrufsrechts bei digitalen Inhalten', body: 'Ihr Widerrufsrecht erlischt vorzeitig, wenn wir mit der Ausführung des Vertrags begonnen haben, nachdem Sie ausdrücklich zugestimmt haben, dass wir mit der Ausführung des Vertrags vor Ablauf der Widerrufsfrist beginnen, und Sie Ihre Kenntnis davon bestätigt haben, dass Sie durch Ihre Zustimmung mit Beginn der Ausführung des Vertrags Ihr Widerrufsrecht verlieren.' });
  S.push({ heading: 'Muster-Widerrufsformular', body: `(Wenn Sie den Vertrag widerrufen wollen, dann füllen Sie bitte dieses Formular aus und senden Sie es zurück.)\n\nAn ${who}:\n\nHiermit widerrufe(n) ich/wir (*) den von mir/uns (*) abgeschlossenen Vertrag über den ${kind === 'physical' ? 'Kauf der folgenden Waren (*)' : kind === 'service' ? 'Kauf der folgenden Waren (*)/die Erbringung der folgenden Dienstleistung (*)' : 'Kauf der folgenden digitalen Inhalte (*)/die Erbringung der folgenden Dienstleistung (*)'}\n\n- Bestellt am (*) / erhalten am (*)\n- Name des/der Verbraucher(s)\n- Anschrift des/der Verbraucher(s)\n- Unterschrift des/der Verbraucher(s) (nur bei Mitteilung auf Papier)\n- Datum\n\n(*) Unzutreffendes streichen.` });
  return { kind: 'widerruf', title: 'Widerrufsbelehrung', subtitle: `Stand: ${dateDe(now)}`, sections: S, missing, notice: LEGAL_NOTICE, services: [] };
}

// --- output -----------------------------------------------------------------------------------------------------------------------

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline markdown: **bold**, [text](url) (http, https, #, mailto, /). */
function inline(v: string): string {
  return esc(v)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|#|\/)[^)\s]*)\)/g, (_m, t, u) => `<a href="${u.replace(/&amp;/g, '&amp;')}">${t}</a>`);
}

export function bodyToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((para) => {
      const lines = para.split('\n');
      if (lines.every((l) => /^\s*- /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*- /, ''))}</li>`).join('')}</ul>`;
      return `<p>${lines.map((l) => (/^\s*- /.test(l) ? `• ${inline(l.replace(/^\s*- /, ''))}` : inline(l))).join('<br>')}</p>`;
    })
    .join('\n');
}

export function docToHtml(doc: LegalDoc, o: { notice?: boolean } = {}): string {
  return `${o.notice ? `<p class="legal-notice" style="background:#fef3c7;color:#92400e;padding:12px 14px;border-radius:8px"><strong>${esc(doc.notice)}</strong></p>\n` : ''}<h1>${esc(doc.title)}</h1>\n${doc.subtitle ? `<p class="muted">${esc(doc.subtitle)}</p>\n` : ''}${doc.sections.map((s) => `<h2>${esc(s.heading)}</h2>\n${bodyToHtml(s.body)}`).join('\n')}`;
}

export function docToMarkdown(doc: LegalDoc, o: { notice?: boolean } = {}): string {
  return `${o.notice ? `> ${doc.notice}\n\n` : ''}# ${doc.title}\n\n${doc.subtitle ? `_${doc.subtitle}_\n\n` : ''}${doc.sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n')}\n`;
}

export function docToText(doc: LegalDoc, o: { notice?: boolean } = {}): string {
  const plain = (v: string) => v.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  return `${o.notice ? `${doc.notice}\n\n` : ''}${doc.title.toUpperCase()}\n${doc.subtitle}\n\n${doc.sections.map((s) => `${s.heading}\n${'-'.repeat(Math.min(s.heading.length, 60))}\n${plain(s.body)}`).join('\n\n')}\n`;
}

/**
 * Blocks for a funnel page (heading + text per section): the page builder renders them with its own mini-markdown. Every block
 * is a section of its own, so each one says how much room it takes – with the builder's default (48 px above and below) a
 * heading stood 96 px away from its own text.
 */
export function docToBlocks(doc: LegalDoc): { type: string; [k: string]: unknown }[] {
  const out: { type: string; [k: string]: unknown }[] = [{ type: 'heading', text: doc.title, level: 1, padding: 32 }];
  if (doc.subtitle) out.push({ type: 'text', text: doc.subtitle, padding: 0 });
  for (const sec of doc.sections) {
    out.push({ type: 'heading', text: sec.heading, level: 2, padding: 12 });
    out.push({ type: 'text', text: sec.body.replace(/`([^`]+)`/g, '$1'), padding: 0 });
  }
  return out;
}

export const DOC_KINDS = ['impressum', 'datenschutz', 'widerruf', 'avv', 'vvt'] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const DOC_LABEL: Record<DocKind, string> = { impressum: 'Impressum', datenschutz: 'Datenschutzerklärung', widerruf: 'Widerrufsbelehrung', avv: 'Auftragsverarbeitungsvertrag (AVV)', vvt: 'Verzeichnis von Verarbeitungstätigkeiten (VVT)' };
