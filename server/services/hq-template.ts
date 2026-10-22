import type { SnapshotData } from './snapshots.js';
import { HQ_MAILS, type HqMailKey } from './hq-template-mails.js';

/**
 * „Software- & SaaS-Firma (HQ)“: the building blocks a small SaaS company runs on – plain data in the snapshot format
 * (services/snapshots.ts) plus a few extras snapshots do not carry (help-center skeleton, dashboard, recurring routines,
 * helpdesk settings). modules/hq-template.ts loads it into a sub-account in one click; docs/company-playbook.md explains
 * how to work with it. Ids here are template-local – applySnapshot gives everything new ids and rewires the references.
 *
 * The company it describes sells HyperLevel Cloud (Solo 49,99 €, Team & Company 99,99 €, Agency 199 € per month;
 * self-hosting is free). Everything is a starting point: workflows arrive as drafts, help articles as drafts.
 */

/** What a template brings beyond a snapshot. Applied through the normal API routes (same checks as a click in the app). */
export interface TemplateExtras {
  /** Partial body for PUT /api/helpdesk/settings. */
  helpdesk?: Record<string, any>;
  /** Help-center categories with draft articles (Markdown). */
  kb?: { name: string; description: string; articles: { title: string; excerpt: string; body: string; tags: string[] }[] }[];
  /** Report dashboards; a filter value `pipeline:<name>` is resolved to the copied pipeline's id. */
  dashboards?: { name: string; range: string; widgets: { title: string; w: number; h: number; config: Record<string, any> }[] }[];
  /** A project with recurring tasks (the founder's routines); `due_in_days` anchors the first date. */
  routines?: { project: string; description: string; tasks: { title: string; description: string; due_in_days: number; recurrence: Record<string, any> }[] };
}

export interface BuiltinTemplate {
  id: string;
  name: string;
  description: string;
  snapshot: SnapshotData;
  extras: TemplateExtras;
}

// --- pipelines -----------------------------------------------------------------------------------------------

const LIFECYCLE = 'p-lifecycle';
/** The lifecycle pipeline's name – the cloud → HQ bridge (modules/cloud-hq-bridge.ts) finds it by this name. */
export const LIFECYCLE_PIPELINE = 'Kunden (Cloud)';
export const STAGE = { wait: 's-warteliste', trial: 's-testphase', customer: 's-kunde', churn: 's-gekuendigt' } as const;

const pipelines: SnapshotData['pipelines'] = [
  {
    id: LIFECYCLE,
    name: LIFECYCLE_PIPELINE,
    stages: [
      { id: STAGE.wait, name: 'Warteliste' },
      { id: STAGE.trial, name: 'Testphase' },
      { id: STAGE.customer, name: 'Kunde' },
      { id: STAGE.churn, name: 'Gekündigt / Rückgewinnung' },
    ],
  },
  {
    id: 'p-partner',
    name: 'Agentur-Partner',
    stages: [
      { id: 'ap-1', name: 'Interessiert' },
      { id: 'ap-2', name: 'Erstgespräch' },
      { id: 'ap-3', name: 'Pilot-Kunde' },
      { id: 'ap-4', name: 'Partner aktiv' },
      { id: 'ap-5', name: 'Pausiert' },
    ],
  },
  {
    id: 'p-press',
    name: 'Presse & Influencer',
    stages: [
      { id: 'pr-1', name: 'Recherchiert' },
      { id: 'pr-2', name: 'Kontaktiert' },
      { id: 'pr-3', name: 'Im Gespräch' },
      { id: 'pr-4', name: 'Veröffentlicht' },
      { id: 'pr-5', name: 'Kein Interesse' },
    ],
  },
];

// --- fields and tags -----------------------------------------------------------------------------------------

/** Plan names only – the prices live in the products (and in the cloud's plan catalogue). */
export const PLANS = ['Solo', 'Team & Company', 'Agency', 'Self-hosted'];
const SOURCES = ['Landingpage', 'Warteliste', 'Empfehlung', 'Agentur-Partner', 'Presse', 'Social Media', 'Community', 'GitHub', 'Umzug von HighLevel', 'Cloud-Anmeldung', 'Sonstiges'];

const custom_fields: SnapshotData['custom_fields'] = [
  { key: 'plan', label: 'Tarif', type: 'select', options: PLANS, position: 0 },
  { key: 'mrr', label: 'MRR (€ / Monat)', type: 'number', options: [], position: 1 },
  { key: 'quelle', label: 'Quelle', type: 'select', options: SOURCES, position: 2 },
  { key: 'betrieb', label: 'Betrieb', type: 'select', options: ['Cloud', 'Self-hosted'], position: 3 },
  { key: 'testphase_ende', label: 'Testphase endet am', type: 'date', options: [], position: 4 },
  { key: 'kuendigungsgrund', label: 'Kündigungsgrund', type: 'text', options: [], position: 5 },
  { key: 'intervall', label: 'Abrechnung', type: 'select', options: ['Monatlich', 'Jährlich'], position: 6 },
  { key: 'cloud_konto', label: 'Cloud-Konto (ID)', type: 'text', options: [], position: 7 },
];

export const TAG = {
  wait: 'status:warteliste',
  trial: 'status:testphase',
  customer: 'status:kunde',
  churn: 'status:gekuendigt',
  roadmap: 'roadmap:wunsch',
  sla: 'support:sla-verletzt',
} as const;

const tags = [
  ...Object.values(TAG),
  'plan:solo',
  'plan:team',
  'plan:agency',
  'betrieb:cloud',
  'betrieb:selfhosted',
  'quelle:landingpage',
  'quelle:empfehlung',
  'quelle:partner',
  'quelle:presse',
  'newsletter',
  'demo-anfrage',
  'partner:agentur',
  'presse',
];

// --- forms ---------------------------------------------------------------------------------------------------

const F = { waitlist: 'f-warteliste', demo: 'f-demo', support: 'f-support', feature: 'f-feature' } as const;
const field = (id: string, type: string, label: string, name: string, extra: Record<string, any> = {}) => ({ id, type, label, name, required: false, options: [], ...extra });
const first = (id = 'f1') => field(id, 'text', 'Vorname', 'first_name', { required: true });
const mail = (id = 'f2') => field(id, 'email', 'E-Mail', 'email', { required: true });
const privacy = (id: string) => field(id, 'consent', 'Ich habe die Datenschutzerklärung gelesen und bin einverstanden, dass meine Angaben zur Bearbeitung gespeichert werden.', 'consent', { required: true });

const forms: SnapshotData['forms'] = [
  {
    id: F.waitlist,
    name: 'Warteliste & Newsletter',
    kind: 'form',
    fields: [
      first(),
      mail(),
      field('f3', 'select', 'Welcher Tarif interessiert dich?', 'custom.plan', { options: PLANS }),
      field('f4', 'hidden', 'Quelle', 'source'),
      field('f5', 'consent', 'Ja, ich möchte auf die Warteliste und den Newsletter (ca. 1 Mail pro Woche) erhalten. Abmelden geht jederzeit.', 'consent', { required: true }),
    ],
    settings: {
      title: 'Auf die Warteliste',
      submit_text: 'Eintragen',
      thank_you: 'Fast geschafft – bitte bestätige deine Anmeldung in der E-Mail, die wir dir gerade geschickt haben.',
      tags: [TAG.wait, 'newsletter'],
      // Double opt-in, always: the welcome sequence only starts after the confirmation (consent.confirmed).
      consent: { marketing: true, field: 'consent', purposes: ['newsletter'], channels: [], doi: 'on' },
    },
  },
  {
    id: F.demo,
    name: 'Demo-Anfrage',
    kind: 'form',
    fields: [
      first(),
      mail(),
      field('f3', 'text', 'Firma', 'company'),
      field('f4', 'select', 'Wie groß ist dein Team?', 'team_groesse', { options: ['Nur ich', '2–5', '6–20', 'Mehr als 20', 'Agentur mit Kunden'] }),
      field('f5', 'textarea', 'Was möchtest du in der Demo sehen?', 'wunsch'),
      privacy('f6'),
    ],
    settings: { title: 'Demo anfragen', submit_text: 'Demo anfragen', thank_you: 'Danke! Wir melden uns innerhalb eines Werktags mit Terminvorschlägen.', tags: ['demo-anfrage'] },
  },
  {
    id: F.support,
    name: 'Support',
    kind: 'form',
    fields: [
      first(),
      mail(),
      field('f3', 'select', 'Worum geht es?', 'kategorie', { options: ['Technik', 'Rechnung & Tarif', 'Umzug', 'Self-Hosting', 'Datenschutz'] }),
      field('f4', 'text', 'Betreff', 'betreff', { required: true }),
      field('f5', 'textarea', 'Beschreibe dein Anliegen', 'anliegen', { required: true }),
      privacy('f6'),
    ],
    // Every submission becomes a ticket (modules/tickets.ts) – with SLA, auto-reply and the SLA workflows below.
    settings: { title: 'Support', submit_text: 'Absenden', thank_you: 'Danke – dein Ticket ist angelegt. Du bekommst gleich eine Bestätigung per E-Mail.', create_ticket: true, ticket_priority: 'normal', ticket_category: 'Technik' },
  },
  {
    id: F.feature,
    name: 'Feature-Wunsch',
    kind: 'form',
    fields: [
      first(),
      mail(),
      field('f3', 'text', 'Was wünschst du dir?', 'wunsch', { required: true }),
      field('f4', 'textarea', 'Welches Problem würde das für dich lösen?', 'problem'),
      field('f5', 'radio', 'Wie wichtig ist es dir?', 'wichtigkeit', { options: ['Nice to have', 'Wichtig', 'Ohne das kann ich nicht wechseln'] }),
      privacy('f6'),
    ],
    settings: { title: 'Feature-Wunsch', submit_text: 'Wunsch abschicken', thank_you: 'Danke! Dein Wunsch landet auf unserer Roadmap-Liste.' },
  },
];

// --- workflows -----------------------------------------------------------------------------------------------

let n = 0;
const sid = () => `s${++n}`;
const send = (key: HqMailKey) => ({ id: sid(), type: 'send_email', subject: HQ_MAILS[key].subject, body: HQ_MAILS[key].body, isHtml: false });
const wait = (days: number) => ({ id: sid(), type: 'wait', amount: days, unit: 'days' });
const addTag = (...t: string[]) => ({ id: sid(), type: 'add_tag', tags: t });
const removeTag = (...t: string[]) => ({ id: sid(), type: 'remove_tag', tags: t });
const stage = (stage_id: string) => ({ id: sid(), type: 'move_opportunity', pipeline_id: LIFECYCLE, stage_id, create_if_missing: true });
const task = (title: string, description: string, due_in_days = 0) => ({ id: sid(), type: 'create_task', title, description, due_in_days });
const notify = (subject: string, body: string) => ({ id: sid(), type: 'notify', subject, body });
/** Leaves the sequence once the person is a customer (goal step). */
const untilCustomer = () => ({ id: sid(), type: 'goal', conditions: [{ field: 'tag', op: 'has', value: TAG.customer }], match: 'all' });
const flow = (id: string, name: string, trigger: Record<string, any>, steps: any[]) => ({ id, name, status: 'active', trigger, steps, settings: {} });

const workflows: SnapshotData['workflows'] = [
  flow('w-waitlist', 'Warteliste: Double-Opt-in bestätigt → Willkommens-Serie', { type: 'consent.confirmed', config: { channel: 'email', purpose: 'newsletter', filters: [{ field: 'tag', op: 'has', value: TAG.wait }] } }, [stage(STAGE.wait), send('waitlistWelcome'), wait(3), send('waitlistWhy')]),
  flow('w-trial', 'Testphase: Onboarding (Tag 0/1/3/7/12) mit Check-in', { type: 'contact.tag_added', config: { tag: TAG.trial } }, [
    removeTag(TAG.wait),
    stage(STAGE.trial),
    send('trialDay0'),
    wait(1),
    untilCustomer(),
    send('trialDay1'),
    wait(2),
    untilCustomer(),
    send('trialDay3'),
    wait(4),
    untilCustomer(),
    send('trialDay7'),
    task('Check-in-Anruf: {{contact.first_name}} {{contact.last_name}}', 'Halbzeit der Testphase. 15 Minuten: Was klappt, was fehlt, passt der Tarif? Ergebnis als Notiz am Kontakt festhalten.', 1),
    wait(5),
    untilCustomer(),
    send('trialDay12'),
  ]),
  flow('w-trial-end', 'Testphase endet (3 Tage vorher) → Angebot', { type: 'date.reached', config: { field: 'custom.testphase_ende', offset_days: -3, yearly: false, time: '09:00' } }, [
    untilCustomer(),
    send('trialOffer'),
    task('Testphase endet: {{contact.first_name}} nachfassen', 'Hat das Angebot gepasst? Bei Fragen anrufen, sonst Status setzen (Kunde oder Gekündigt).', 2),
  ]),
  flow('w-customer', 'Kunde geworden → Pipeline & Tags aufräumen', { type: 'contact.tag_added', config: { tag: TAG.customer } }, [removeTag(TAG.trial, TAG.wait, TAG.churn), stage(STAGE.customer), notify('Neuer Kunde: {{contact.first_name}} {{contact.last_name}}', 'Tarif: {{contact.custom.plan|unbekannt}} – MRR: {{contact.custom.mrr|?}} €')]),
  flow('w-churn', 'Kündigung → Danke, Grund erfragen, Rückgewinnung nach 45 Tagen', { type: 'contact.tag_added', config: { tag: TAG.churn } }, [
    removeTag(TAG.customer),
    stage(STAGE.churn),
    send('churnSorry'),
    task('Kündigungsgrund eintragen: {{contact.first_name}} {{contact.last_name}}', 'Grund ins Feld „Kündigungsgrund“ schreiben – er zählt in der Monatsauswertung.', 3),
    wait(45),
    { id: sid(), type: 'goal', conditions: [{ field: 'tag', op: 'has', value: TAG.customer }], match: 'all' },
    send('winback'),
  ]),
  flow('w-sla-warning', 'Support: SLA in Gefahr → Team informieren', { type: 'sla.warning', config: {} }, [
    notify('SLA in Gefahr: {{event.ticket.subject|Ticket}}', 'Ein Ticket nähert sich seiner Frist. Bitte jetzt antworten oder neu zuweisen.'),
    task('SLA in Gefahr: {{event.ticket.subject|Ticket}}', 'Kunden antworten (auch ein Zwischenstand zählt) oder das Ticket neu zuweisen.', 0),
  ]),
  flow('w-sla-breached', 'Support: SLA verletzt → markieren & eskalieren', { type: 'sla.breached', config: {} }, [addTag(TAG.sla), notify('SLA verletzt: {{event.ticket.subject|Ticket}}', 'Die Frist ist überschritten. Kurz beim Kunden entschuldigen und den Grund in der Wochen-Runde besprechen.')]),
  flow('w-feature', 'Feature-Wunsch → Roadmap-Tag & Danke', { type: 'form.submitted', config: { form_id: F.feature } }, [addTag(TAG.roadmap), send('featureThanks'), notify('Neuer Feature-Wunsch von {{contact.first_name}}', 'Steht in den Formular-Einsendungen „Feature-Wunsch“. Freitags in der Roadmap-Runde sichten.')]),
  flow('w-demo', 'Demo-Anfrage → Aufgabe für Terminvorschläge', { type: 'form.submitted', config: { form_id: F.demo } }, [task('Demo vereinbaren: {{contact.first_name}} ({{contact.company|ohne Firma}})', 'Innerhalb eines Werktags zwei Terminvorschläge schicken.', 1)]),
];

// --- templates, products, community ----------------------------------------------------------------------------

const templates: SnapshotData['templates'] = Object.values(HQ_MAILS).map((m) => ({ name: m.name, channel: 'email', subject: m.subject, body: m.body, is_html: 0 }));

const products: SnapshotData['products'] = [
  { id: 'pr-solo', name: 'HyperLevel Cloud – Solo', description: 'Für Selbstständige: ein Login, alle Bereiche.', price_cents: 4999, currency: 'EUR', tax_rate: 19, recurring: 'month' },
  { id: 'pr-team', name: 'HyperLevel Cloud – Team & Company', description: 'Für Teams und kleine Firmen.', price_cents: 9999, currency: 'EUR', tax_rate: 19, recurring: 'month' },
  { id: 'pr-agency', name: 'HyperLevel Cloud – Agency', description: 'Für Agenturen mit Kunden-Sub-Accounts.', price_cents: 19900, currency: 'EUR', tax_rate: 19, recurring: 'month' },
];

const community_groups = [
  {
    id: 'cg-hq',
    name: 'HyperLevel Community',
    slug: 'community',
    description: 'Austausch für Kundinnen, Self-Hoster und Agentur-Partner: Fragen, Tipps, Vorlagen und Wünsche.',
    status: 'active',
    position: 0,
    access: { mode: 'join' },
    settings: {},
    channels: [
      { name: 'Ankündigungen', emoji: '📣', admin_only: 1, position: 0 },
      { name: 'Willkommen & Vorstellung', emoji: '👋', position: 1 },
      { name: 'Fragen & Hilfe', emoji: '❓', category: 'Hilfe', position: 2 },
      { name: 'Self-Hosting', emoji: '🖥️', category: 'Hilfe', position: 3 },
      { name: 'Umzug von HighLevel', emoji: '🚚', category: 'Hilfe', position: 4 },
      { name: 'Vorlagen & Automationen', emoji: '🧩', category: 'Austausch', position: 5 },
      { name: 'Feature-Wünsche', emoji: '💡', category: 'Austausch', position: 6 },
      { name: 'Agentur-Partner', emoji: '🤝', category: 'Austausch', position: 7 },
    ],
  },
];

// --- extras --------------------------------------------------------------------------------------------------

const article = (title: string, excerpt: string, body: string, tags: string[] = []) => ({ title, excerpt, body, tags });

const kb: TemplateExtras['kb'] = [
  {
    name: 'Cloud oder selbst hosten',
    description: 'Was der Unterschied ist und was zu dir passt.',
    articles: [
      article(
        'Cloud oder Self-Hosting – was passt zu mir?',
        'HyperLevel gibt es gehostet (Cloud) oder zum Selbstbetrieb. Funktionen sind gleich, der Aufwand nicht.',
        `## Kurz gesagt\n\n- **Cloud:** Wir betreiben Server, Updates, Backups und Zustellbarkeit. Du zahlst monatlich.\n- **Self-Hosting:** Du betreibst HyperLevel auf deinem eigenen Server (Docker). Die Software ist Open Source (AGPL) und kostenlos – Server, Wartung und Backups liegen bei dir.\n\n## Wann Cloud?\n\nWenn du dich um dein Geschäft kümmern willst und nicht um Server.\n\n## Wann selbst hosten?\n\nWenn du Erfahrung mit Servern hast oder deine Daten zwingend im eigenen Haus liegen müssen.\n\n## Wechseln\n\nDu kannst jederzeit wechseln – der Datenexport nimmt alles mit.`,
        ['cloud', 'self-hosting'],
      ),
    ],
  },
  {
    name: 'Preise & Tarife',
    description: 'Tarife, Testphase, Kündigung.',
    articles: [
      article(
        'Was kostet HyperLevel?',
        'Solo 49,99 €, Team & Company 99,99 €, Agency 199 € pro Monat. Selbst hosten ist kostenlos.',
        `| Tarif | Preis pro Monat | Für wen |\n| --- | --- | --- |\n| Solo | 49,99 € | Selbstständige |\n| Team & Company | 99,99 € | Teams und kleine Firmen |\n| Agency | 199 € | Agenturen mit Kunden-Sub-Accounts |\n| Self-hosted | 0 € | Wer selbst betreibt |\n\nBitte vor dem Veröffentlichen prüfen: Netto oder brutto, Jahresrabatt, Kündigungsfrist – so, wie es auf deiner Preisseite steht.\n\n## Testphase\n\n14 Tage kostenlos, ohne Kreditkarte. Danach entscheidest du.`,
        ['preise'],
      ),
    ],
  },
  {
    name: 'Umzug',
    description: 'Von HighLevel, HubSpot und anderen Tools wechseln.',
    articles: [
      article(
        'Umzug von HighLevel',
        'Kontakte, Pipelines, Termine und mehr mit Vorschau übernehmen – und was du danach prüfen solltest.',
        `## So geht's\n\n1. In HyperLevel **Umzug** öffnen und HighLevel wählen.\n2. API-Schlüssel des HighLevel-Sub-Accounts eintragen.\n3. Vorschau ansehen, Zuordnung prüfen, Umzug starten. Ein Umzug lässt sich rückgängig machen.\n\n## Danach prüfen\n\n- Workflows: Sie kommen als Entwurf und werden erst nach dem Testen aktiviert.\n- Domains und E-Mail-Versand neu verbinden.\n- Einwilligungen: Was in HighLevel nicht nachweisbar war, ist auch hier nicht nachweisbar.\n\nHilfe beim Umzug? Schreib uns über das Support-Formular.`,
        ['umzug', 'highlevel'],
      ),
    ],
  },
  {
    name: 'Datenschutz',
    description: 'DSGVO, AVV und wo deine Daten liegen.',
    articles: [
      article(
        'DSGVO & Auftragsverarbeitung (AVV)',
        'Wo die Daten liegen, wie du einen AVV bekommst und was HyperLevel für dich protokolliert.',
        `## Wo liegen meine Daten?\n\nCloud: auf Servern in der EU (bitte den konkreten Anbieter und Standort hier eintragen). Self-Hosting: dort, wo du betreibst.\n\n## AVV\n\nFür die Cloud schließen wir mit dir einen Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO. Du bekommst ihn bei Abschluss bzw. auf Anfrage über das Support-Formular.\n\n## Was die App für dich mitbringt\n\nDouble-Opt-in mit Nachweis, Einwilligungs-Protokoll, Datenexport und Löschung je Kontakt, Aufbewahrungsfristen, Protokoll aller Änderungen.\n\n*Hinweis: Dieser Artikel ersetzt keine Rechtsberatung.*`,
        ['dsgvo', 'avv'],
      ),
    ],
  },
];

const PIPE = `pipeline:${pipelines[0].name}`;
const kpi = (title: string, query: Record<string, any>, fixed = false) => ({ title, w: 3, h: 2, config: { viz: 'kpi', query: { compare: !fixed, ...query }, ...(fixed ? { fixed_range: true } : {}) } });
const chart = (title: string, viz: string, query: Record<string, any>, fixed = false, w = 6) => ({ title, w, h: 4, config: { viz, query, ...(fixed ? { fixed_range: true } : {}) } });

const dashboards: TemplateExtras['dashboards'] = [
  {
    name: 'CEO-Cockpit (SaaS)',
    range: 'last_30_days',
    widgets: [
      kpi('MRR', { source: 'subscriptions', measures: ['calc:mrr'], range: 'all' }, true),
      kpi('ARR', { source: 'subscriptions', measures: ['calc:arr'], range: 'all' }, true),
      kpi('Aktive Abos', { source: 'subscriptions', measures: ['calc:active_count'], range: 'all' }, true),
      kpi('Laufende Testphasen', { source: 'contacts', measures: ['count'], filters: [{ field: 'tags', op: 'has', value: TAG.trial }], range: 'all' }, true),
      kpi('Lead → Kunde', { source: 'contacts', measures: ['calc:customer_rate'] }),
      kpi('Neue Leads', { source: 'contacts', measures: ['count'] }),
      kpi('Kündigungen', { source: 'opportunities', measures: ['count'], filters: [{ field: 'pipeline', op: 'eq', value: PIPE }, { field: 'stage', op: 'eq', value: STAGE.churn }], date_field: 'stage_changed_at' }),
      kpi('SLA-Quote Support', { source: 'tickets', measures: ['calc:sla_rate'] }),
      chart('Kunden-Lebenszyklus', 'funnel', { source: 'opportunities', measures: ['count'], group_by: ['stage'], filters: [{ field: 'pipeline', op: 'eq', value: PIPE }], range: 'all' }, true),
      chart('Leads je Quelle', 'hbar', { source: 'contacts', measures: ['count'], group_by: ['source'], limit: 10 }),
      chart('MRR je Intervall', 'donut', { source: 'subscriptions', measures: ['calc:mrr'], group_by: ['interval'], range: 'all' }, true),
      chart('Support: erste Antwort und Lösung', 'table', { source: 'tickets', measures: ['count', 'calc:avg_first_response', 'calc:avg_resolution', 'calc:sla_rate'], group_by: ['category'] }),
    ],
  },
];

const weekly = (weekday: number) => ({ freq: 'weekly', interval: 1, weekdays: [weekday], mode: 'due', end: { type: 'never' } });
const routines: TemplateExtras['routines'] = {
  project: 'CEO-Routinen',
  description: 'Die wiederkehrenden Aufgaben aus docs/company-playbook.md – täglich, wöchentlich, monatlich, quartalsweise, jährlich.',
  tasks: [
    { title: 'Morgenrunde (15 Min.): Posteingang, Tickets mit SLA, Aufgaben, Testphasen', description: 'Reihenfolge: SLA-gefährdete Tickets → neue Nachrichten → heute fällige Aufgaben → Testphasen, die heute Tag 3/7/12 haben.', due_in_days: 1, recurrence: { freq: 'daily', interval: 1, mode: 'due', end: { type: 'never' } } },
    { title: 'Wochen-Review (30 Min.) mit dem CEO-Cockpit', description: 'MRR, Testphasen, Lead → Kunde, Kündigungen, SLA-Quote. Drei Entscheidungen für die Woche notieren.', due_in_days: 1, recurrence: weekly(1) },
    { title: 'Roadmap-Runde: Feature-Wünsche sichten', description: 'Kontakte mit Tag roadmap:wunsch und die Einsendungen „Feature-Wunsch“ durchgehen, Top 3 festhalten, Antworten schicken.', due_in_days: 4, recurrence: weekly(5) },
    { title: 'Monatsabschluss: Rechnungen, Mahnungen, DATEV-Export, Kennzahlen', description: 'Offene Rechnungen und Mahnstufen prüfen, Belege vollständig, Export an die Steuerberatung, Monatszahlen ins Wiki.', due_in_days: 3, recurrence: { freq: 'monthly', interval: 1, day_of_month: 3, mode: 'due', end: { type: 'never' } } },
    { title: 'Quartals-Review: Preise, Kanäle, Ziele, Rechte', description: 'Gewinnrechner mit echten Zahlen aktualisieren, Kanäle nach Kosten je Kunde bewerten, Ziele fürs nächste Quartal, Team-Rechte und API-Schlüssel prüfen.', due_in_days: 30, recurrence: { freq: 'monthly', interval: 3, mode: 'due', end: { type: 'never' } } },
    { title: 'Jahres-Check: Jahresabschluss, AVV, Aufbewahrung, Versicherungen', description: 'Unterlagen an die Steuerberatung, Auftragsverarbeitungsverträge und Löschfristen prüfen, Datenschutz-Dokumentation aktualisieren.', due_in_days: 60, recurrence: { freq: 'yearly', interval: 1, mode: 'due', end: { type: 'never' } } },
  ],
};

const helpdesk: TemplateExtras['helpdesk'] = {
  categories: ['Technik', 'Rechnung & Tarif', 'Umzug', 'Self-Hosting', 'Datenschutz', 'Feature-Wunsch'],
  auto_reply: { enabled: true, subject: `${HQ_MAILS.supportReceived.subject} [Ticket #{{ticket.number}}]`, body: HQ_MAILS.supportReceived.body },
  help_center: { title: 'Hilfe-Center', intro: 'Wie können wir helfen? Antworten zu Cloud, Self-Hosting, Preisen, Umzug und Datenschutz.' },
};

export const HQ_TEMPLATE: BuiltinTemplate = {
  id: 'saas-hq',
  name: 'Software- & SaaS-Firma (HQ)',
  description:
    'Für eine kleine Software-Firma, die sich selbst mit der App führt: Kunden-Pipeline (Warteliste → Testphase → Kunde → Gekündigt), Agentur-Partner und Presse, Formulare mit Double-Opt-in, Onboarding- und Rückgewinnungs-Workflows, Support mit SLA und Hilfe-Center, Community, CEO-Cockpit und wiederkehrende Routinen.',
  snapshot: { version: 1, custom_fields, tags, pipelines, calendars: [], forms, funnels: [], workflows, templates, products, community_groups },
  extras: { helpdesk, kb, dashboards, routines },
};
