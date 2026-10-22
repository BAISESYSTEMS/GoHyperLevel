/**
 * Einfach-Modus as data: the goals of the first-run setup ("Was willst du tun?"), which menu areas each goal puts in the
 * core menu, the adaptive menu (core + pinned + promoted by use, everything else under "Mehr") and the Profi-Funktionen
 * (expert fields hidden until switched on). Pure code without Node or browser APIs – the server validates preferences with
 * it (appearance-model.ts) and the web app builds the sidebar, and the "Mehr" panel from it
 * (web/src/areas/*), so the lists cannot drift apart. docs/theming.md#einfach-modus explains the behaviour.
 *
 * The German labels are the message ids of the web app's `simple` catalog (web/src/i18n/en/simple.ts).
 */

export const GOAL_IDS = ['leads', 'courses', 'agency', 'office', 'all'] as const;
export type GoalId = (typeof GOAL_IDS)[number];

export interface Goal {
  id: GoalId;
  label: string;
  text: string;
  /** Areas this goal puts in the core menu (beyond BASE_CORE), in priority order. */
  areas: string[];
}

/** Always in the core menu (when the person may use them and has not hidden them) – the academy too, so new logins find the tours. */
export const BASE_CORE = ['dashboard', 'conversations', 'contacts', 'calendars', 'tasks', 'academy'];
/** At most this many entries in the core menu (pinned and promoted areas come on top, the current page always shows). */
export const CORE_MAX = 11;

export const GOALS: Goal[] = [
  {
    id: 'leads',
    label: 'Leads & Vertrieb',
    text: 'Anfragen gewinnen und abschließen: Deals, Formulare, Websites, Automationen und E-Mail-Kampagnen.',
    areas: ['opportunities', 'forms', 'funnels', 'workflows', 'campaigns'],
  },
  {
    id: 'courses',
    label: 'Kurse & Community',
    text: 'Wissen verkaufen: Kurse, Community, Verkaufsseiten, E-Mails und Rechnungen.',
    areas: ['courses', 'community', 'funnels', 'campaigns', 'invoices'],
  },
  {
    id: 'agency',
    label: 'Agentur',
    text: 'Kunden betreuen: Deals, Websites, Kampagnen, Social Media und Berichte für jeden Kunden.',
    areas: ['opportunities', 'funnels', 'campaigns', 'social', 'reports'],
  },
  {
    id: 'office',
    label: 'Rechnungen & Büro',
    text: 'Den Laden führen: Rechnungen und Angebote, Projekte, Zeiterfassung und Buchhaltung.',
    areas: ['invoices', 'pm', 'time', 'accounting'],
  },
  { id: 'all', label: 'Alles', text: 'Alle Bereiche im Menü wie bisher – nichts kommt unter „Mehr“.', areas: [] },
];

/** The goal the first-run setup applies when someone skips it. */
export const DEFAULT_GOAL: GoalId = 'leads';

/** Simple mode is on once goals are chosen and "Alles" is not one of them. No goals = the classic full menu. */
export const isSimple = (goals: readonly string[]): boolean => goals.length > 0 && !goals.includes('all');

/** The core areas of a set of goals, in menu order, capped at CORE_MAX (BASE_CORE first, then the goals' areas). */
export function coreForGoals(goals: readonly string[], order: readonly string[]): string[] {
  if (!isSimple(goals)) return [...order];
  const wanted: string[] = [...BASE_CORE];
  // round-robin over the goals, so two goals both get their most important areas before the cap
  const lists = GOALS.filter((g) => goals.includes(g.id)).map((g) => g.areas);
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i] && !wanted.includes(l[i])) wanted.push(l[i]);
  const usable = wanted.filter((r) => order.includes(r)).slice(0, CORE_MAX);
  return order.filter((r) => usable.includes(r));
}

// --- adaptive menu ------------------------------------------------------------------------------------------------

/** Visits of an area within PROMOTE_DAYS that move it from "Mehr" into the menu (at the next session start). */
export const PROMOTE_VISITS = 3;
export const PROMOTE_DAYS = 14;

export interface NavInput {
  /** Every area the person may use and has not hidden, in menu order. */
  order: readonly string[];
  goals: readonly string[];
  pinned: readonly string[];
  unpinned: readonly string[];
  /** Areas promoted at the start of this session (see promotedFrom) – fixed for the whole session. */
  promoted: readonly string[];
  /** The page that is open: always visible. */
  current?: string;
}

/**
 * Splits the menu into the entries shown in the sidebar and those under "Mehr". The order is stable (menu order); only
 * membership adapts, and only between sessions, so nothing jumps while someone works.
 */
export function splitNav({ order, goals, pinned, unpinned, promoted, current }: NavInput): { core: string[]; more: string[] } {
  if (!isSimple(goals)) return { core: [...order], more: [] };
  const base = new Set(coreForGoals(goals, order));
  for (const r of promoted) base.add(r);
  for (const r of unpinned) base.delete(r);
  for (const r of pinned) base.add(r);
  if (current) base.add(current);
  return { core: order.filter((r) => base.has(r)), more: order.filter((r) => !base.has(r)) };
}

/** Usage counts (visits per area in the last PROMOTE_DAYS) → the areas under "Mehr" that earned a place in the menu. */
export function promotedFrom(usage: Readonly<Record<string, number>>, input: Omit<NavInput, 'promoted' | 'current'>): string[] {
  if (!isSimple(input.goals)) return [];
  const { more } = splitNav({ ...input, promoted: [] });
  return more.filter((r) => (usage[r] ?? 0) >= PROMOTE_VISITS && !input.unpinned.includes(r));
}

// --- Profi-Funktionen ----------------------------------------------------------------------------------------------

export interface ProFeature {
  key: string;
  /** The menu area the feature belongs to (shown in its group in Darstellung & Einfach-Modus). */
  area: string;
  label: string;
  desc: string;
}

export const PRO_FEATURES: ProFeature[] = [
  { key: 'invoices.legal', area: 'invoices', label: 'Weitere Rechnungsangaben', desc: 'Leistungszeitraum, Steuerbehandlung, USt-IdNr., Leitweg-ID (XRechnung für Behörden), Kundenreferenz und Skonto.' },
  { key: 'invoices.recurring', area: 'invoices', label: 'Wiederkehrende Rechnungen (Abos) und Zahlungslink', desc: 'Eine Rechnung monatlich oder jährlich automatisch neu erzeugen; eigener Online-Zahlungslink.' },
  { key: 'sites.advanced', area: 'funnels', label: 'Website-Profiwerkzeuge', desc: 'A/B-Tests von Seiten, Inhalte (CMS), Weiterleitungen und der Barrierefreiheits-Check.' },
  { key: 'inbox.views', area: 'conversations', label: 'Team-Ansichten im Posteingang', desc: 'Ansichten SLA gefährdet, Erwähnungen, Wartet auf Kontakt, Zurückgestellt und die Priorität.' },
  { key: 'contacts.advanced', area: 'contacts', label: 'Kontakt-Profiwerkzeuge', desc: 'Lead-Score, Verknüpfungen mit anderen Datensätzen und Sequenzen auf der Kontaktseite.' },
];
export const PRO_KEYS = PRO_FEATURES.map((f) => f.key);

/** Is an expert feature visible? Outside simple mode everything is (nothing is hidden silently). */
export const proOn = (key: string, goals: readonly string[], pro: readonly string[]): boolean => !isSimple(goals) || pro.includes(key);
