/**
 * Fokus-Modus without a language model: German and English keywords → the Living Boards widgets that answer the question best.
 * Pure (no app, no database). The module validates the plan against the widget catalogue and reads every number through the
 * viewer's own rights – the rules only pick widgets and their settings, exactly like the model would.
 */

export type Lang = 'de' | 'en';
export type Intent = 'deals' | 'revenue' | 'overdue' | 'tasks' | 'appointments' | 'contacts' | 'inbox' | 'tickets' | 'overview';
export interface PlannedTile {
  type: string;
  title: string;
  config: Record<string, unknown>;
  /** Part of the general overview: left out when the viewer may not see it (instead of a locked card). */
  optional?: boolean;
}
export interface RulePlan {
  intents: Intent[];
  /** The question matched no intent of its own (and no earlier question it follows up on): the overview. */
  fallback: boolean;
  say: string;
  tiles: PlannedTile[];
  /** The person asked for something to be done (send, create, change …): Fokus only shows – the HyperLevel Agent can take over. */
  action: string | null;
}

/** Lower case, umlauts and accents folded (ü → u, ß → ss), single spaces. */
export const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const INTENTS: [Intent, RegExp][] = [
  ['overdue', /(uberfallig|ueberfaellig|overdue|verspatet|in verzug|ruckstand|liegen ?geblieben|\blate\b)/],
  ['deals', /(\bdeals?\b|opportunit|pipeline|verkaufschance|\bchancen?\b|abschluss|abschlusse|\bsales\b|forecast|prognose)/],
  ['revenue', /(umsatz|umsatze|einnahme|erlos|revenue|rechnung|invoice|bezahlt|\bpaid\b|\bmrr\b|income|\bcash\b|verdient|earned)/],
  ['tasks', /(aufgabe|\btasks?\b|to-?dos?\b|to do\b|erledigen|\bfallig|\bdue\b)/],
  ['appointments', /(termin|kalender|meeting|appointment|calendar|besprechung|agenda)/],
  ['contacts', /(kontakt|\bleads?\b|contact|neukunde|neue kunden|new customers|anmeldung|sign ?ups?\b)/],
  ['inbox', /(nachricht|ungelesen|unread|\bmessages?\b|posteingang|inbox|\be-?mails?\b|\bmails?\b|konversation|conversation|\bchats?\b|whatsapp|\bsms\b)/],
  ['tickets', /(ticket|\bsupport\b|helpdesk|kundenanfrage)/],
];
const OVERVIEW = /(uberblick|ueberblick|ubersicht|overview|dashboard|zusammenfassung|summary|briefing|was steht an|tagesplan|my day|mein tag|wie lauft|how am i doing)/;

/** Verbs that ask for something to be done – unless the sentence asks to see something ("Zeig mir …", "Was …"). */
const ACTION =
  /\b(schick|schicke|schicken|sende|senden|verschicke|send|schreib|schreibe|write|erstelle|erstellen|create|anlegen|lege|losche|loschen|delete|entferne|remove|verschiebe|verschieben|move|buche|buchen|book|rufe|anrufen|antworte|antworten|reply|markiere|markieren|zuweisen|assign|aktualisiere|aktualisieren|update|einplanen|schedule|erinnere|remind|storniere|stornieren|archiviere|archive)\b/;
const VIEW = /\b(zeig|zeige|zeigen|show|liste|list|ubersicht|overview|wie ?viele?|how many|how much|was|what|welche|which|gibt es|anzeigen|sehen|see)\b/;

const MINE = /\b(meine?|meinen|meinem|meiner|mir zugewiesen|my|mine)\b/;
const ALL = /\b(alle|alles|team|gesamt|everyone|everybody|all)\b/;

const RANGES: [string, RegExp][] = [
  ['today', /\b(heute|today|heutigen?)\b/],
  ['yesterday', /\b(gestern|yesterday)\b/],
  ['last_12_months', /(letzten? 12 monate|last 12 months)/],
  ['last_month', /(letzten monat|letzter monat|vormonat|vorigen monat|last month|previous month)/],
  ['last_7_days', /(letzten? 7 tage|last 7 days|letzte woche|last week)/],
  ['this_week', /(diese woche|dieser woche|this week|\bwoche\b|\bweek\b)/],
  ['this_month', /(diesen monat|dieser monat|diesem monat|this month|\bmonat\b|\bmonth\b)/],
  ['this_quarter', /(quartal|quarter)/],
  ['this_year', /(dieses jahr|diesem jahr|this year|\bjahr\b|\byear\b)/],
];
const RANGE_LABEL: Record<string, [de: string, en: string]> = {
  today: ['heute', 'today'],
  yesterday: ['gestern', 'yesterday'],
  this_week: ['diese Woche', 'this week'],
  last_7_days: ['in den letzten 7 Tagen', 'in the last 7 days'],
  last_30_days: ['in den letzten 30 Tagen', 'in the last 30 days'],
  last_90_days: ['in den letzten 90 Tagen', 'in the last 90 days'],
  this_month: ['diesen Monat', 'this month'],
  last_month: ['im letzten Monat', 'last month'],
  this_quarter: ['in diesem Quartal', 'this quarter'],
  last_12_months: ['in den letzten 12 Monaten', 'in the last 12 months'],
  this_year: ['dieses Jahr', 'this year'],
};
export const rangeWords = (range: string, lang: Lang) => RANGE_LABEL[range]?.[lang === 'en' ? 1 : 0] ?? '';

interface Mods {
  /** true = only mine, false = everybody's, null = the widget's default */
  mine: boolean | null;
  range: string | null;
  tomorrow: boolean;
}

const intentsOf = (t: string): Intent[] => INTENTS.filter(([, r]) => r.test(t)).map(([i]) => i);
function modsOf(t: string): Mods {
  return {
    mine: MINE.test(t) ? true : ALL.test(t) ? false : null,
    range: RANGES.find(([, r]) => r.test(t))?.[0] ?? null,
    tomorrow: /\b(morgen|tomorrow)\b/.test(t) && !/guten morgen|good morning/.test(t),
  };
}

const tile = (type: string, title: string, config: Record<string, unknown> = {}, optional = false): PlannedTile => ({ type, title, config, ...(optional ? { optional } : {}) });

/** The widgets for one intent, in the order they are shown (the key figures first). */
function tilesFor(intent: Intent, m: Mods, L: (de: string, en: string) => string): PlannedTile[] {
  const mine = m.mine === true;
  switch (intent) {
    case 'deals':
      return [
        tile('kpi', L('Offener Pipeline-Wert', 'Open pipeline value'), { preset: 'open_pipeline_value' }),
        tile('kpi', L('Offene Deals', 'Open deals'), { preset: 'open_deals' }),
        tile('list', mine ? L('Meine offenen Deals nach Wert', 'My open deals by value') : L('Offene Deals nach Wert', 'Open deals by value'), { entity: 'deals', status: 'open', sort: 'value', limit: 8, mine }),
        tile('pipeline', L('Pipeline', 'Pipeline'), { status: 'open' }),
      ];
    case 'revenue': {
      const range = m.range ?? 'this_month';
      return [
        tile('kpi', L('Bezahlter Umsatz', 'Paid revenue'), { preset: 'paid_revenue', range }),
        tile('kpi', L('Gewonnener Umsatz', 'Won revenue'), { preset: 'won_revenue', range }),
        tile('kpi', L('Offene Rechnungen', 'Open invoices'), { preset: 'open_invoices' }),
        tile('chart', L('Umsatz je Monat', 'Revenue by month'), { preset: 'revenue_by_month' }),
      ];
    }
    case 'overdue':
      return [
        tile('kpi', L('Überfällige Aufgaben', 'Overdue tasks'), { preset: 'overdue_tasks' }),
        tile('kpi', L('Überfällige Rechnungen', 'Overdue invoices'), { preset: 'overdue_invoices' }),
        tile('tasks', mine ? L('Meine überfälligen Aufgaben', 'My overdue tasks') : L('Überfällige Aufgaben', 'Overdue tasks'), { due: 'overdue', mine, limit: 10 }),
        tile('list', L('Deals seit 14 Tagen unberührt', 'Deals untouched for 14 days'), { entity: 'deals', status: 'open', stale_days: 14, sort: 'oldest', limit: 8, mine }),
      ];
    case 'tasks': {
      const due = m.range === 'today' ? 'today' : m.range === 'this_week' || m.range === 'last_7_days' ? 'week' : 'today_overdue';
      const own = m.mine !== false;
      return [
        tile('kpi', L('Offene Aufgaben', 'Open tasks'), { preset: 'open_tasks' }),
        tile('kpi', L('Überfällige Aufgaben', 'Overdue tasks'), { preset: 'overdue_tasks' }),
        tile('tasks', own ? (due === 'week' ? L('Meine Aufgaben dieser Woche', 'My tasks this week') : L('Meine Aufgaben für heute', 'My tasks for today')) : L('Aufgaben des Teams', "The team's tasks"), { due, mine: own, limit: 10 }),
      ];
    }
    case 'appointments': {
      const days = m.tomorrow ? 2 : m.range === 'today' ? 1 : 7;
      return [
        tile('kpi', m.range === 'today' ? L('Termine heute', 'Appointments today') : L('Termine diese Woche', 'Appointments this week'), { preset: 'appointments', range: m.range === 'today' ? 'today' : 'this_week' }),
        tile('agenda', days === 1 ? L('Heute', 'Today') : days === 2 ? L('Heute und morgen', 'Today and tomorrow') : L('Die nächsten 7 Tage', 'The next 7 days'), { days }),
      ];
    }
    case 'contacts': {
      const range = m.range ?? 'last_7_days';
      return [
        tile('kpi', L('Neue Kontakte', 'New contacts'), { preset: 'new_contacts', range }),
        tile('list', L('Neueste Kontakte', 'Newest contacts'), { entity: 'contacts', limit: 8 }),
        tile('chart', L('Kontakte je Quelle', 'Contacts by source'), { preset: 'leads_by_source', range }),
      ];
    }
    case 'inbox':
      return [tile('kpi', L('Ungelesene Gespräche', 'Unread conversations'), { preset: 'unread_conversations' }), tile('inbox', L('Ungelesene Nachrichten', 'Unread messages'), { only_unread: true, limit: 8 })];
    case 'tickets':
      return [tile('kpi', L('Offene Tickets', 'Open tickets'), { preset: 'tickets_open' }), tile('list', mine ? L('Meine offenen Tickets', 'My open tickets') : L('Offene Tickets nach Priorität', 'Open tickets by priority'), { entity: 'tickets', ticket_state: 'open', sort: 'priority', limit: 8, mine })];
    case 'overview':
      return [
        tile('kpi', L('Offener Pipeline-Wert', 'Open pipeline value'), { preset: 'open_pipeline_value' }, true),
        tile('kpi', L('Bezahlter Umsatz diesen Monat', 'Paid revenue this month'), { preset: 'paid_revenue', range: 'this_month' }, true),
        tile('kpi', L('Neue Kontakte (7 Tage)', 'New contacts (7 days)'), { preset: 'new_contacts', range: 'last_7_days' }, true),
        tile('kpi', L('Ungelesene Gespräche', 'Unread conversations'), { preset: 'unread_conversations' }, true),
        tile('tasks', L('Meine Aufgaben für heute', 'My tasks for today'), { due: 'today_overdue', mine: true, limit: 8 }, true),
        tile('agenda', L('Heute und morgen', 'Today and tomorrow'), { days: 2 }, true),
        tile('inbox', L('Ungelesene Nachrichten', 'Unread messages'), { only_unread: true, limit: 6 }, true),
      ];
  }
}

function sayFor(intent: Intent, m: Mods, L: (de: string, en: string) => string, lang: Lang): string {
  switch (intent) {
    case 'deals':
      return m.mine ? L('Hier sind deine offenen Deals und der Wert deiner Pipeline.', 'Here are your open deals and the value of your pipeline.') : L('Hier sind die offenen Deals und der Wert der Pipeline.', 'Here are the open deals and the value of the pipeline.');
    case 'revenue': {
      const r = rangeWords(m.range ?? 'this_month', lang);
      return L(`So steht dein Umsatz ${r}.`, `This is your revenue ${r}.`);
    }
    case 'overdue':
      return L('Das ist überfällig: Aufgaben, Rechnungen und Deals, die liegen geblieben sind.', 'This is overdue: tasks, invoices and deals that have been left lying.');
    case 'tasks':
      return L('Deine Aufgaben – was heute ansteht und was überfällig ist.', 'Your tasks – what is due today and what is overdue.');
    case 'appointments':
      return m.range === 'today' ? L('Das sind deine Termine für heute.', 'These are your appointments for today.') : m.tomorrow ? L('Das sind deine Termine für heute und morgen.', 'These are your appointments for today and tomorrow.') : L('Das sind deine nächsten Termine.', 'These are your next appointments.');
    case 'contacts':
      return L(`Das sind die neuen Kontakte ${rangeWords(m.range ?? 'last_7_days', lang)}.`, `These are the new contacts ${rangeWords(m.range ?? 'last_7_days', 'en')}.`);
    case 'inbox':
      return L('Das sind deine ungelesenen Nachrichten.', 'These are your unread messages.');
    case 'tickets':
      return L('Das sind die offenen Tickets, die dringendsten zuerst.', 'These are the open tickets, the most urgent first.');
    case 'overview':
      return L('Hier ist deine Übersicht für heute.', 'Here is your overview for today.');
  }
}

/** The plan for a question. `history` = the person's previous questions (newest last) for follow-ups like "und nur meine?". */
export function planRules(text: string, lang: Lang = 'de', history: string[] = []): RulePlan {
  const L = (de: string, en: string) => (lang === 'en' ? en : de);
  const t = fold(text);
  const wantsAction = ACTION.test(t) && !VIEW.test(t);
  let intents = intentsOf(t);
  let mods = modsOf(t);
  // A follow-up without a subject of its own ("und nur meine?", "und letzten Monat?") continues the last question that had one.
  if (!intents.length && !wantsAction && !OVERVIEW.test(t)) {
    for (const h of [...history].reverse().slice(0, 4)) {
      const before = fold(h);
      const found = intentsOf(before);
      if (!found.length) continue;
      const prev = modsOf(before);
      intents = found;
      mods = { mine: mods.mine ?? prev.mine, range: mods.range ?? prev.range, tomorrow: mods.tomorrow || prev.tomorrow };
      break;
    }
  }
  const fallback = !intents.length && !OVERVIEW.test(t) && !wantsAction;
  // An action without a subject shows nothing; everything else without one gets the overview.
  if (!intents.length && !wantsAction) intents = ['overview'];
  // overdue already shows the overdue tasks: tasks next to it would only repeat them
  if (intents.includes('overdue')) intents = intents.filter((i) => i !== 'tasks');
  // in "schick eine Mail an …" the mail is the way, not the subject: no inbox next to the offer to continue in the agent
  if (wantsAction) intents = intents.filter((i) => i !== 'inbox');
  const seen = new Set<string>();
  const tiles: PlannedTile[] = [];
  for (const i of intents)
    for (const x of tilesFor(i, mods, L)) {
      const key = `${x.type}:${JSON.stringify(x.config)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tiles.push(x);
    }
  // key figures first, then the lists – at most 8 tiles
  const ordered = [...tiles.filter((x) => x.type === 'kpi').slice(0, 4), ...tiles.filter((x) => x.type !== 'kpi')].slice(0, 8);
  let say: string;
  if (wantsAction) say = L('Fokus zeigt nur an und ändert nichts. Das kann der HyperLevel Agent für dich erledigen – mit „Im Agent fortsetzen“.', 'Focus only shows things and never changes anything. The HyperLevel Agent can do this for you – use “Continue in Agent”.');
  else if (fallback) say = L('Dazu habe ich keine passende Ansicht gefunden – hier ist deine Übersicht für heute.', 'I could not find a matching view for that – here is your overview for today.');
  else say = intents.slice(0, 2).map((i) => sayFor(i, mods, L, lang)).join(' ');
  return { intents, fallback, say, tiles: ordered, action: wantsAction ? text.trim().slice(0, 300) : null };
}
