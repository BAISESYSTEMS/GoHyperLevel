/**
 * Einfach-Modus on the pages a busy admin opens every day – dashboard, contacts, companies, deals, custom objects and the
 * calendar settings: which cards, columns, tabs and form fields show at first glance. Pure data and rules, shared by the pages
 * and tests/easy-core.test.ts (how to use the building blocks: docs/theming.md#einfach-modus).
 *
 * Profi always gets everything exactly as before; Einfach-Modus only reorders and folds – nothing is removed.
 */

// --- dashboard ---------------------------------------------------------------------------------------------------------------

/** Stat tiles of the dashboard in Profi order, with the area each belongs to (a hidden area takes its tiles with it). */
export const DASH_STATS = {
  contacts: 'contacts',
  pipeline: 'opportunities',
  won: 'opportunities',
  booked: 'calendars',
  forms: 'forms',
  messages: 'conversations',
  revenue: 'invoices',
  reviews: 'reviews',
} as const;
/** The few tiles that call for action today – first (and alone) in Einfach-Modus. */
export const DASH_SIMPLE_STATS = {
  tasks: 'tasks',
  unread: 'conversations',
  upcoming: 'calendars',
  pipeline: 'opportunities',
} as const;
/** Cards below the tiles, in Profi order. `next` (next appointments and open tasks) belongs to calendars or tasks. */
export const DASH_CARDS = ['leads', 'next', 'pipelines', 'sources'] as const;
export const DASH_SIMPLE_CARDS: readonly DashCard[] = ['next'];
export type DashStat = keyof typeof DASH_STATS | keyof typeof DASH_SIMPLE_STATS;
export type DashCard = (typeof DASH_CARDS)[number];

const CARD_AREAS: Record<DashCard, string[]> = { leads: ['contacts'], next: ['calendars', 'tasks'], pipelines: ['opportunities'], sources: ['contacts'] };

export interface DashLayout {
  stats: DashStat[];
  cards: DashCard[];
  /** Behind "Mehr anzeigen" (Einfach-Modus only; always empty in Profi). */
  moreStats: DashStat[];
  moreCards: DashCard[];
  /** Plugin widgets go with the rest behind the fold-out in Einfach-Modus. */
  widgetsInMore: boolean;
}

/**
 * What the dashboard shows. Profi: every tile and card of a visible area, as before. Einfach-Modus: today's tasks, unread
 * conversations, upcoming appointments and the open pipeline, plus the "next appointments" card – everything else (without
 * repeating the open pipeline) in `more*`.
 */
export function dashboardLayout(simple: boolean, visible: (area: string) => boolean): DashLayout {
  const stats = (Object.keys(DASH_STATS) as (keyof typeof DASH_STATS)[]).filter((k) => visible(DASH_STATS[k]));
  const cards = DASH_CARDS.filter((c) => CARD_AREAS[c].some(visible));
  if (!simple) return { stats, cards, moreStats: [], moreCards: [], widgetsInMore: false };
  const main = (Object.keys(DASH_SIMPLE_STATS) as (keyof typeof DASH_SIMPLE_STATS)[]).filter((k) => visible(DASH_SIMPLE_STATS[k]));
  return {
    stats: main,
    // without calendars the card would only repeat the tasks tile
    cards: cards.filter((c) => DASH_SIMPLE_CARDS.includes(c) && (c !== 'next' || visible('calendars'))),
    moreStats: stats.filter((s) => !(main as string[]).includes(s)),
    moreCards: cards.filter((c) => !DASH_SIMPLE_CARDS.includes(c)),
    widgetsInMore: true,
  };
}

// --- tables --------------------------------------------------------------------------------------------------------------------

/** Contacts list: column keys in display order and the essential ones (the rest via the "Spalten" picker). */
export const CONTACT_COLUMNS = ['name', 'email', 'phone', 'tags', 'score', 'source', 'health', 'created'] as const;
export const CONTACT_ESSENTIAL = ['name', 'email', 'phone', 'tags'] as const;

/** Default columns of lists that already have their own column chooser (Firmen, Deal-Liste) – Einfach-Modus starts leaner. */
export const COMPANY_COLUMNS = { pro: ['name', 'industry', 'lifecycle_stage', 'city', 'contacts_count', 'deals_value', 'owner_id', 'updated_at'], simple: ['name', 'lifecycle_stage', 'city', 'contacts_count'] };
export const DEAL_COLUMNS = { pro: ['name', 'contact_name', 'pipeline_id', 'stage_id', 'status', 'value', 'assigned_to', 'expected_close_date', 'updated_at'], simple: ['name', 'contact_name', 'stage_id', 'value', 'expected_close_date'] };
export const defaultColumns = (set: { pro: string[]; simple: string[] }, simple: boolean): string[] => [...(simple ? set.simple : set.pro)];

/** Custom object records: the primary property plus the next few (5 in Profi with "Geändert", 3 in Einfach-Modus). */
export function recordColumns(primary: string, others: readonly string[], simple: boolean): string[] {
  const rest = others.filter((k) => k !== primary);
  return simple ? [primary, ...rest.slice(0, 3)] : [primary, ...rest.slice(0, 5), 'updated_at'];
}

// --- forms ---------------------------------------------------------------------------------------------------------------------

/** How many fields a create/edit form shows at first glance in Einfach-Modus before "Weitere Felder". */
export const FIRST_GLANCE = 6;

/**
 * Splits a form's fields into those shown at first glance and those behind "Weitere Felder": required fields and the
 * primary one always stay visible, then the others in their order until `max` is reached. Order within each part is kept.
 */
export function splitFields<T extends { key: string; required?: boolean }>(fields: readonly T[], opts: { primary?: string; max?: number } = {}): { main: T[]; more: T[] } {
  const max = opts.max ?? FIRST_GLANCE;
  const must = new Set(fields.filter((f) => f.required || f.key === opts.primary).map((f) => f.key));
  let room = Math.max(0, max - must.size);
  const keep = new Set(must);
  for (const f of fields) {
    if (keep.has(f.key)) continue;
    if (room <= 0) break;
    keep.add(f.key);
    room--;
  }
  return { main: fields.filter((f) => keep.has(f.key)), more: fields.filter((f) => !keep.has(f.key)) };
}

/** Contact form (detail → Bearbeiten): what stays visible in Einfach-Modus; address, birthday, source and custom fields fold away. */
export const CONTACT_MAIN_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'company'] as const;

// --- tabs ----------------------------------------------------------------------------------------------------------------------

/**
 * Tabs of a settings dialog in Einfach-Modus: the essential ones, the open one and those that already hold settings
 * (`filled`); the rest behind one "Mehr …" tab until `expanded`. Profi shows all. Returns the tabs to render (original order)
 * and how many are folded away.
 */
export function simpleTabs<T extends [string, string]>(all: readonly T[], opts: { simple: boolean; essential: readonly string[]; current?: string; filled?: readonly string[]; expanded?: boolean }): { tabs: T[]; hidden: number } {
  if (!opts.simple || opts.expanded) return { tabs: [...all], hidden: 0 };
  const keep = new Set([...opts.essential, ...(opts.filled ?? []), ...(opts.current ? [opts.current] : [])]);
  const tabs = all.filter(([k]) => keep.has(k));
  return { tabs, hidden: all.length - tabs.length };
}

/** Calendar settings dialog: tabs a busy admin needs to get a booking page running. */
export const CALENDAR_TABS_ESSENTIAL = ['basic', 'hours', 'notify', 'team', 'sync'] as const;

/**
 * Did the booking page get its URL path from its name (server/core/util.ts `slugify`, plus "-2" … when taken)? Such a path
 * is not something anyone typed, so it does not open the folded fields by itself.
 */
export function isAutoSlug(slug: string | undefined | null, name: string | undefined | null): boolean {
  if (!slug) return true;
  const auto =
    String(name ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'seite';
  return slug === auto || new RegExp(`^${auto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`).test(slug);
}
