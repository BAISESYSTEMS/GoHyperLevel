import type { Block } from './site-blocks.js';
import { blockText, walkBlocks } from './site-layout.js';
import { TEMPLATES } from './site-templates.js';
import { AI_BLOCKS, SECTION_LIMITS, blockCatalogText, checkSection, compileSection, decompileSection, h1Count, type AccountRefs, type BlockEnv, type CheckedSection } from './site-ai-schema.js';

export { parseAnswer } from './wfai.js';

/**
 * Funnel & Website AI (pure): the brief ("Briefing"), the two stages the AI answers in – a page plan, then the blocks of every
 * page – the prompts, the checks of both answers against the site block registry and the account (services/site-ai-schema.ts),
 * section commands ("kürzer", "FAQ hinzufügen", "in Du-Form"), the diff for the review step and the cost estimate. The module
 * (modules/site-ai.ts) calls the AI, retries with the errors, stores runs and applies them as drafts.
 */

export const PAGE_TYPES = ['landing', 'funnel', 'website'] as const;
export type PageType = (typeof PAGE_TYPES)[number];
export const GOALS = ['leads', 'booking', 'sale', 'info'] as const;
export type Goal = (typeof GOALS)[number];
export const TONES = ['freundlich', 'professionell', 'locker', 'premium', 'mutig'] as const;
export const LANGS = ['de', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export const LIMITS = { business: 300, offer: 600, audience: 300, extra: 2000, command: 600, pages: { landing: [1, 2], funnel: [2, 6], website: [2, 8] } as Record<PageType, [number, number]> };
const LEGAL = ['impressum', 'datenschutz', 'widerruf', 'agb', 'barrierefreiheit'];
/** Building blocks of a plan (what each page should have), for the plan stage. */
export const PLAN_SECTIONS = ['hero', 'benefits', 'steps', 'stats', 'testimonials', 'pricing', 'faq', 'cta', 'form', 'calendar', 'product', 'text', 'about', 'contact', 'thanks'] as const;

/** Design looks the AI may pick: the gallery templates' tokens (colours, fonts, radius) – the same set the gallery uses. */
export const STYLE_CHOICES = TEMPLATES.map((t) => ({ id: t.id, name: t.name, category: t.category, kind: t.kind, brand: t.tokens.colors?.brand ?? '#2563eb' }));
export const styleOf = (id: unknown) => TEMPLATES.find((t) => t.id === id);
export const defaultStyle = (type: PageType, goal: Goal) => (type === 'website' ? 'agentur' : goal === 'booking' ? 'termin-funnel' : goal === 'sale' ? 'kurs-verkauf' : 'leadmagnet');

export interface Brief {
  business: string;
  offer: string;
  audience: string;
  tone: (typeof TONES)[number];
  address: 'du' | 'sie';
  language: Lang;
  page_type: PageType;
  goal: Goal;
  /** funnel steps or website pages the person asked for (names), optional */
  pages: string[];
  extra: string;
  style?: string;
}

const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const clipText = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');

/** The brief from a request (unknown values fall back to defaults, texts are clipped). */
export function cleanBrief(b: any): Brief {
  const page_type = pick(b?.page_type, PAGE_TYPES, 'landing');
  return {
    business: clipText(b?.business, LIMITS.business),
    offer: clipText(b?.offer, LIMITS.offer),
    audience: clipText(b?.audience, LIMITS.audience),
    tone: pick(b?.tone, TONES, 'freundlich'),
    address: b?.address === 'sie' ? 'sie' : 'du',
    language: pick(b?.language, LANGS, 'de'),
    page_type,
    goal: pick(b?.goal, GOALS, page_type === 'website' ? 'info' : 'leads'),
    pages: (Array.isArray(b?.pages) ? b.pages : typeof b?.pages === 'string' ? b.pages.split(/[,\n]/) : []).map((x: unknown) => clipText(x, 60)).filter(Boolean).slice(0, 8),
    extra: clipText(b?.extra ?? b?.prompt, LIMITS.extra),
    style: typeof b?.style === 'string' && styleOf(b.style) ? b.style : undefined,
  };
}
export const briefProblem = (b: Brief) => (b.business.length + b.offer.length + b.extra.length < 12 ? 'Bitte beschreibe kurz dein Unternehmen und dein Angebot (oder schreibe, was die Seite tun soll).' : null);

const LANG_RULE: Record<Lang, string> = { de: 'Alle Texte auf Deutsch.', en: 'All page texts in English (British spelling is fine).' };
const ADDRESS_RULE = { du: 'Sprich Besucher mit „du“ an (klein geschrieben).', sie: 'Sprich Besucher mit „Sie“ an.' };
const TYPE_RULE: Record<PageType, string> = {
  landing: 'Eine Landingpage: eine Seite (optional eine Danke-Seite „danke“) mit genau einem Ziel.',
  funnel: 'Ein Funnel: 2–6 Schritte, jeder Schritt eine Seite in Reihenfolge (z. B. Opt-in → Danke, oder Verkaufsseite → Kasse → Danke).',
  website: 'Eine Website mit 2–8 Seiten (Startseite zuerst; z. B. Leistungen, Über uns, Kontakt).',
};
const GOAL_RULE: Record<Goal, string> = {
  leads: 'Ziel: Anfragen/Anmeldungen einsammeln – ein Formular-Block auf der ersten Seite, Buttons verlinken auf #formular.',
  booking: 'Ziel: Termine – ein Kalender-Block, Buttons verlinken auf #termin.',
  sale: 'Ziel: Verkauf – ein Produkt-Block (Kasse) und eine Danke-Seite.',
  info: 'Ziel: informieren und Kontakt – ein Kontaktformular auf der Kontaktseite.',
};

export const RULES_COMMON = [
  'Du baust Seiten für den Website-Baukasten von HyperLevel. Antworte ausschließlich mit EINEM JSON-Objekt, ohne Erklärungen.',
  'Erfinde keine Fakten: keine Preise, Zahlen, Auszeichnungen, Kundennamen oder Zitate, die nicht in der Beschreibung stehen. Fehlt etwas, schreibe einen klar erkennbaren Platzhalter in eckigen Klammern, z. B. „[Preis]“, „[Kundenstimme einfügen]“.',
  'Keine Rechtstexte (Impressum, Datenschutz, Widerruf, AGB) – die erzeugt HyperLevel selbst aus den Firmendaten.',
  'Keine Bilder, Videos, HTML oder Skripte. Kurze, konkrete Sätze; Nutzen vor Merkmalen; jede Seite hat genau eine H1 (der Hero oder eine Überschrift mit level 1).',
].join('\n');

export const RULES_PLAN = `${RULES_COMMON}

AUFGABE: Erstelle zuerst nur den SEITENPLAN.
Format: {"site_name": "…", "style": "<style-id>", "summary": "ein Satz", "pages": [{"slug": "start", "name": "Start", "purpose": "ein Satz", "sections": ["hero", "benefits", …]}]}
- slug: Kleinbuchstaben, Ziffern und Bindestriche, eindeutig; die erste Seite ist die Startseite.
- sections: in Reihenfolge, je 3–9 aus: ${PLAN_SECTIONS.join(', ')}.
- style: eine der Design-IDs aus der Liste (passend zur Branche).`;

export const RULES_BLOCKS = `${RULES_COMMON}

AUFGABE: Schreibe die Seiten des Plans aus.
Format: {"pages": [{"slug": "<aus dem Plan>", "seo": {"title": "≤ 60 Zeichen", "description": "≤ 155 Zeichen"}, "sections": [ABSCHNITT, …]}], "notes": ["was die Person noch tun muss", …]}
ABSCHNITT = {"name": "Hero", "style": "plain|soft|brand|dark", "width": "narrow|normal|wide", "anchor": "optional", "layout": "1|2|3|4|7-5|5-7|8-4|4-8", "columns": [[BLOCK, …], [BLOCK, …]]}
- layout bestimmt die Spalten (Zwölftel): "1" = eine Spalte, "2" = zwei gleiche, "7-5" = breit + schmal. Die Zahl der Spalten in columns muss passen.
- Ein Abschnitt mit dem Formular bekommt anchor "formular", einer mit dem Kalender "termin"; Buttons verlinken mit "#formular"/"#termin" darauf, auf andere Seiten mit "page:<slug>".
- Abwechselnde Hintergründe (plain, soft) lesen sich gut; höchstens ein Abschnitt "brand" oder "dark" pro Seite (z. B. der Aufruf am Ende).
- BLOCK ist ein Objekt mit "type" und den Feldern unten (* = Pflicht); andere Felder gibt es nicht.

BLÖCKE
`;

export const RULES_SECTION = `${RULES_COMMON}

AUFGABE: Ändere einen Abschnitt einer bestehenden Seite nach dem Auftrag.
Format: {"sections": [ABSCHNITT, …], "summary": "was du geändert hast, ein Satz"}
- Die Liste ersetzt den gewählten Abschnitt. Den geänderten Abschnitt gibst du mit seiner "id" zurück, Blöcke behalten ihre "id"; neue Abschnitte (z. B. eine FAQ) und neue Blöcke haben keine id.
- Soll der gewählte Abschnitt unverändert bleiben und nur etwas dazukommen: {"id": "<id>", "keep": true} an seiner Stelle.
- Vorhandene Abschnitte im Format {"id", "name", "style", "rows": [{"layout", "columns": [[BLOCK, …]]}]}, neue wie auf einer neuen Seite mit "layout" und "columns".
ABSCHNITT = {"name", "style": "plain|soft|brand|dark", "layout": "1|2|3|4|7-5|5-7|8-4|4-8", "columns": [[BLOCK, …]]} oder mit "rows" wie oben.

BLÖCKE
`;

/** The person's brief as the AI reads it. */
export function briefText(b: Brief): string {
  return [
    `Art: ${b.page_type} – ${TYPE_RULE[b.page_type]}`,
    GOAL_RULE[b.goal],
    LANG_RULE[b.language],
    ADDRESS_RULE[b.address],
    `Tonalität: ${b.tone}`,
    b.business && `Unternehmen: ${b.business}`,
    b.offer && `Angebot: ${b.offer}`,
    b.audience && `Zielgruppe: ${b.audience}`,
    b.pages.length ? `Gewünschte Seiten/Schritte: ${b.pages.join(', ')}` : '',
    b.extra && `Weitere Wünsche: ${b.extra}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Account context: the ids the AI may use (forms, calendars, products) – names only, nothing about contacts. */
export function refsText(refs: AccountRefs): string {
  const list = <T>(label: string, items: T[], fmt: (x: T) => string) => `${label}: ${items.length ? items.slice(0, 30).map(fmt).join('; ') : 'keine vorhanden (Feld leer lassen)'}`;
  return [list('Formulare (form_id)', refs.form, (f) => `${f.id} = „${f.name}“`), list('Kalender (calendar_slug)', refs.calendar, (c) => `${c.slug} = „${c.name}“`), list('Produkte (product_id)', refs.product, (p) => `${p.id} = „${p.name}“${p.price ? ` (${p.price})` : ''}`)].join('\n');
}
export const stylesText = () => STYLE_CHOICES.map((s) => `${s.id} = ${s.name} (${s.category})`).join('; ');
export const catalogFor = (registry: Set<string>) => blockCatalogText(registry);

// --- stage 1: the plan ---------------------------------------------------------------------------------------------------

export interface PlanPage {
  slug: string;
  name: string;
  purpose: string;
  sections: string[];
}
export interface Plan {
  site_name: string;
  style: string;
  summary: string;
  pages: PlanPage[];
}

export function checkPlan(raw: any, brief: Brief): { plan?: Plan; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') return { errors: ['Die Antwort war kein JSON-Objekt.'], warnings };
  const pages: PlanPage[] = [];
  const list = Array.isArray(raw.pages) ? raw.pages : [];
  const [min, max] = LIMITS.pages[brief.page_type];
  if (list.length < min || list.length > max) errors.push(`${list.length} Seiten – für „${brief.page_type}“ sind ${min}–${max} erlaubt`);
  const seen = new Set<string>();
  list.slice(0, max).forEach((p: any, i: number) => {
    const at = `Seite ${i + 1}`;
    const slug = String(p?.slug ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) return void errors.push(`${at}: slug „${slug}“ – nur Kleinbuchstaben, Ziffern und Bindestriche`);
    if (seen.has(slug)) return void errors.push(`${at}: slug „${slug}“ doppelt`);
    if (LEGAL.includes(slug)) return void errors.push(`${at}: „${slug}“ ist eine Rechtsseite – die erzeugt HyperLevel selbst, bitte weglassen`);
    seen.add(slug);
    const name = clipText(p?.name, 60) || slug;
    const sections = (Array.isArray(p?.sections) ? p.sections : []).map((s: unknown) => String(s));
    const unknown = sections.filter((s: string) => !(PLAN_SECTIONS as readonly string[]).includes(s));
    if (unknown.length) warnings.push(`${at}: unbekannte Bausteine ignoriert: ${unknown.join(', ')}`);
    const known = sections.filter((s: string) => (PLAN_SECTIONS as readonly string[]).includes(s)).slice(0, 10);
    if (!known.length) errors.push(`${at}: keine Bausteine in „sections“`);
    pages.push({ slug, name, purpose: clipText(p?.purpose, 200), sections: known });
  });
  let style = String(raw.style ?? '');
  if (!styleOf(style)) {
    if (style) warnings.push(`Design „${style}“ unbekannt – Standard gewählt`);
    style = brief.style ?? defaultStyle(brief.page_type, brief.goal);
  }
  if (brief.style) style = brief.style;
  const site_name = clipText(raw.site_name, 80) || brief.business.split(/[,.–-]/)[0].trim().slice(0, 80) || 'Neue Seite';
  return { plan: errors.length ? undefined : { site_name, style, summary: clipText(raw.summary, 300), pages }, errors, warnings };
}

export function planText(plan: Plan): string {
  return [`Name: ${plan.site_name}`, ...plan.pages.map((p, i) => `${i + 1}. ${p.slug} „${p.name}“ – ${p.purpose || 'ohne Beschreibung'} – Bausteine: ${p.sections.join(', ')}`)].join('\n');
}

// --- stage 2: the pages --------------------------------------------------------------------------------------------------

export interface DraftPage {
  slug: string;
  name: string;
  seo: { title: string; description: string };
  blocks: Block[];
}

/** The pages of the answer: every planned page exactly once, sections and blocks checked, one H1 each. */
export function checkPages(raw: any, plan: Plan, env: Omit<BlockEnv, 'pages'>): { pages?: DraftPage[]; notes: string[]; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.pages)) return { errors: ['Erwartet: {"pages": [...]}'], warnings, notes: [] };
  const benv: BlockEnv = { ...env, pages: new Set(plan.pages.map((p) => p.slug)) };
  const bySlug = new Map<string, any>();
  for (const p of raw.pages) if (p && typeof p.slug === 'string') bySlug.set(p.slug, p);
  const extra = [...bySlug.keys()].filter((s) => !benv.pages.has(s));
  if (extra.length) errors.push(`Seiten, die nicht im Plan stehen: ${extra.join(', ')}`);
  const pages: DraftPage[] = [];
  for (const pp of plan.pages) {
    const p = bySlug.get(pp.slug);
    if (!p) {
      errors.push(`Seite „${pp.slug}“ fehlt`);
      continue;
    }
    const r = checkPageSections(p.sections, benv, `Seite „${pp.slug}“`);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    const title = clipText(p.seo?.title, 70) || pp.name;
    if (String(p.seo?.title ?? '').length > 70) warnings.push(`Seite „${pp.slug}“: SEO-Titel gekürzt`);
    pages.push({ slug: pp.slug, name: pp.name, seo: { title, description: clipText(p.seo?.description, 160) }, blocks: r.blocks });
  }
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).map((n: unknown) => clipText(n, 240)).filter(Boolean).slice(0, 8);
  return { pages: errors.length ? undefined : pages, notes, errors, warnings };
}

/** Sections of one page: limits, each section checked and compiled, the H1 rule. */
export function checkPageSections(list: unknown, env: BlockEnv, where: string): { blocks: Block[]; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(list) || !list.length) return { blocks: [], errors: [`${where}: „sections“ fehlt oder ist leer`], warnings };
  if (list.length > SECTION_LIMITS.sectionsPerPage) errors.push(`${where}: höchstens ${SECTION_LIMITS.sectionsPerPage} Abschnitte`);
  const blocks: Block[] = [];
  list.slice(0, SECTION_LIMITS.sectionsPerPage).forEach((s, i) => {
    const r = checkSection(s, env, `${where} Abschnitt ${i + 1}`);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    if (r.section && !r.section.keep) blocks.push(compileSection(r.section, { first: i === 0 }));
  });
  const h1 = h1Count(blocks);
  if (!errors.length && h1 !== 1) errors.push(`${where}: ${h1} H1-Überschriften – genau eine (Hero oder Überschrift level 1), alle anderen level 2 oder 3`);
  return { blocks, errors, warnings };
}

// --- section commands ------------------------------------------------------------------------------------------------------

/** Ready-made commands of the builder panel (chips); free text works the same way. */
export const SECTION_COMMANDS = [
  { id: 'shorter', label: 'Kürzer machen', prompt: 'Mach diesen Abschnitt deutlich kürzer und prägnanter, ohne Inhalt zu erfinden.' },
  { id: 'faq', label: 'FAQ hinzufügen', prompt: 'Füge nach diesem Abschnitt einen FAQ-Abschnitt mit 4–6 passenden Fragen und Antworten hinzu (der Abschnitt selbst bleibt unverändert).' },
  { id: 'du', label: 'In Du-Form umschreiben', prompt: 'Schreibe alle Texte dieses Abschnitts in die Du-Form um (Inhalt und Länge bleiben).' },
  { id: 'sie', label: 'In Sie-Form umschreiben', prompt: 'Schreibe alle Texte dieses Abschnitts in die Sie-Form um (Inhalt und Länge bleiben).' },
  { id: 'benefits', label: 'Nutzen betonen', prompt: 'Formuliere diesen Abschnitt nutzenorientierter: was hat der Besucher davon?' },
  { id: 'cta', label: 'Aufruf ergänzen', prompt: 'Füge nach diesem Abschnitt einen kurzen Aufruf-Abschnitt (cta) hinzu, der zum Ziel der Seite führt.' },
] as const;

/** What the AI gets for a section command: the section (simple format, with ids) and the page around it. */
export function sectionContext(page: Block[], sectionId: string): { section: ReturnType<typeof decompileSection>; outline: string } | null {
  const sec = page.find((b) => b.type === 'section' && b.id === sectionId);
  if (!sec) return null;
  const outline = page
    .map((b, i) => {
      const heads: string[] = [];
      walkBlocks([b], (x) => {
        if (x.type !== 'section' && heads.length < 2) {
          const t = String(x.heading ?? x.text ?? x.quote ?? '').split('\n')[0].slice(0, 70);
          if (t) heads.push(t);
        }
      });
      return `${i + 1}. ${b.id === sectionId ? '>> ' : ''}${String(b.name || b.type)}${heads.length ? `: ${heads.join(' / ')}` : ''}`;
    })
    .join('\n');
  return { section: decompileSection(sec), outline };
}

/** The checked answer of a section command: the sections that replace the selected one. */
export function checkSectionAnswer(raw: any, page: Block[], sectionId: string, env: BlockEnv): { sections?: CheckedSection[]; summary: string; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections) || !raw.sections.length) return { errors: ['Erwartet: {"sections": [...]} mit mindestens einem Abschnitt'], warnings, summary: '' };
  if (raw.sections.length > 4) errors.push('Höchstens 4 Abschnitte als Ersatz');
  const known = new Set([sectionId]);
  const sections: CheckedSection[] = [];
  raw.sections.slice(0, 4).forEach((s: any, i: number) => {
    const r = checkSection(s, env, `Abschnitt ${i + 1}`, known);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    if (r.section) sections.push(r.section);
  });
  if (sections.filter((s) => s.id === sectionId).length > 1) errors.push('Der gewählte Abschnitt darf nur einmal vorkommen');
  return { sections: errors.length ? undefined : sections, summary: clipText(raw.summary, 300), errors, warnings };
}

// --- review: what changes ------------------------------------------------------------------------------------------------

export interface SectionDiff {
  id: string;
  name: string;
  change: 'new' | 'changed' | 'removed' | 'same';
  blocks: number;
  /** a few words of the first text, to recognise the section */
  preview: string;
}

const sectionKey = (b: Block) => {
  const parts: string[] = [];
  walkBlocks([b], (x) => {
    if (x.type !== 'section') parts.push(`${x.type}:${blockText(x)}`);
  });
  return parts.join('|');
};
const firstText = (b: Block) => {
  let out = '';
  walkBlocks([b], (x) => {
    if (!out && x.type !== 'section') out = blockText(x).slice(0, 90);
  });
  return out;
};
const blockCount = (b: Block) => {
  let n = 0;
  walkBlocks([b], (x) => {
    if (x.type !== 'section') n++;
  });
  return n;
};

/** Section-by-section difference of a page before and after (ids decide; a page without sections counts as one). */
export function diffPage(before: Block[], after: Block[]): { sections: SectionDiff[]; counts: Record<SectionDiff['change'], number> } {
  const old = new Map(before.filter((b) => b.type === 'section').map((b) => [String(b.id), b]));
  const sections: SectionDiff[] = [];
  for (const b of after) {
    const prev = old.get(String(b.id));
    sections.push({ id: String(b.id), name: String(b.name || AI_BLOCKS[b.type]?.label || b.type), change: !prev ? 'new' : sectionKey(prev) === sectionKey(b) && JSON.stringify(prev.bg ?? '') === JSON.stringify(b.bg ?? '') ? 'same' : 'changed', blocks: blockCount(b), preview: firstText(b) });
    old.delete(String(b.id));
  }
  for (const b of before) if (old.has(String(b.id))) sections.push({ id: String(b.id), name: String(b.name || b.type), change: 'removed', blocks: blockCount(b), preview: firstText(b) });
  const counts = { new: 0, changed: 0, removed: 0, same: 0 };
  for (const s of sections) counts[s.change]++;
  return { sections, counts };
}

/** Replaces the selected section by the answer's sections (merged or compiled) – the page after a section command. */
export function applySectionAnswer(page: Block[], sectionId: string, sections: CheckedSection[], merge: (original: Block, s: CheckedSection) => Block): Block[] {
  const at = page.findIndex((b) => b.id === sectionId);
  if (at < 0) return page;
  const original = page[at];
  const replacement = sections.map((s) => (s.id === sectionId ? (s.keep ? original : merge(original, s)) : compileSection(s)));
  return [...page.slice(0, at), ...replacement, ...page.slice(at + 1)];
}

// --- cost -------------------------------------------------------------------------------------------------------------------

/** Tokens a request will roughly take (input includes the instructions and catalogue; output by page count), for the estimate. */
export function estimateTokens(o: { mode: 'site' | 'page' | 'section' | 'write'; pages?: number; systemChars: number; userChars: number }): { input: number; output: number; calls: number } {
  const sys = Math.ceil(o.systemChars / 3.5);
  const user = Math.ceil(o.userChars / 3.5);
  if (o.mode === 'site') {
    const pages = Math.max(1, o.pages ?? 1);
    // plan + pages; one retry is likely on long sites
    return { input: sys * 2 + user * 2 + 800 + (pages > 3 ? sys : 0), output: 700 + pages * 1900, calls: pages > 3 ? 3 : 2 };
  }
  if (o.mode === 'page') return { input: sys + user + 400, output: 2200, calls: 1 };
  if (o.mode === 'section') return { input: sys + user, output: 900, calls: 1 };
  return { input: sys + user, output: 1600, calls: 1 };
}
export const expectedPages = (b: Brief) => (b.pages.length ? Math.min(LIMITS.pages[b.page_type][1], Math.max(LIMITS.pages[b.page_type][0], b.pages.length)) : b.page_type === 'landing' ? 2 : b.page_type === 'funnel' ? 3 : 4);

export function retryText(base: string, previous: string, errors: string[]): string {
  return `${base}\n\nDEINE LETZTE ANTWORT WAR NICHT GÜLTIG:\n${previous.slice(0, 16_000)}\n\nFEHLER:\n${errors.slice(0, 20).map((e) => `- ${e}`).join('\n')}\n\nKorrigiere genau diese Punkte und gib die VOLLSTÄNDIGE Antwort erneut als ein JSON-Objekt aus.`;
}

// --- writer (blog posts, e-mail text blocks) ----------------------------------------------------------------------------------

export const WRITE_KINDS = ['blog', 'email'] as const;
export type WriteKind = (typeof WRITE_KINDS)[number];
export function writerRules(kind: WriteKind, lang: Lang, address: 'du' | 'sie', tone: string): string {
  return [
    kind === 'blog'
      ? 'Du schreibst einen Blog-Beitrag. Antworte nur mit JSON: {"title": "≤ 80 Zeichen", "excerpt": "≤ 200 Zeichen", "markdown": "der Beitrag in Markdown mit ## Zwischenüberschriften, Absätzen und Listen"}.'
      : 'Du schreibst den Text eines Textblocks einer E-Mail. Antworte nur mit JSON: {"text": "2–4 kurze Absätze, getrennt durch eine Leerzeile, ohne Betreff, ohne Gruß-Floskeln am Ende, Platzhalter wie {{contact.first_name|du}} sind erlaubt"}.',
    'Keine erfundenen Fakten, Zahlen, Preise, Studien oder Zitate; Unbekanntes als [Platzhalter]. Kein HTML.',
    LANG_RULE[lang],
    ADDRESS_RULE[address],
    `Tonalität: ${tone}`,
  ].join('\n');
}
export function checkWritten(raw: any, kind: WriteKind): { out?: { title?: string; excerpt?: string; text: string }; errors: string[] } {
  if (!raw || typeof raw !== 'object') return { errors: ['Die Antwort war kein JSON-Objekt.'] };
  const text = clipText(kind === 'blog' ? raw.markdown : raw.text, kind === 'blog' ? 20_000 : 4000);
  if (text.length < 40) return { errors: ['Der Text fehlt oder ist zu kurz.'] };
  if (/<\/?(script|iframe|style|div|p|span|br)\b/i.test(text)) return { errors: ['Kein HTML – nur Markdown bzw. reiner Text.'] };
  return { out: kind === 'blog' ? { title: clipText(raw.title, 80), excerpt: clipText(raw.excerpt, 200), text } : { text }, errors: [] };
}
