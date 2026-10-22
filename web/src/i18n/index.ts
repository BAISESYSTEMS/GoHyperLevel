import { use, useSyncExternalStore } from 'react';
import { CATALOGS, LOCALES, SOURCE_LOCALE, type Catalog, type Locale, type Namespace, type PluralForms } from './registry';

/**
 * The language layer of the app – no library, about 1.5 KB gzip in the first download (docs/translating.md):
 *
 *   const t = useT('contacts');                  // in a component: re-renders on a language switch
 *   t('Neuer Kontakt')                           // German text = message id; English from en/contacts.ts (or en/core.ts)
 *   t('{n} ausgewählt', { n: 3 })                // placeholders
 *   t.plural(n, { one: '{n} Kontakt', other: '{n} Kontakte' })
 *   const t = tr('contacts');                    // outside components (helpers, event handlers): the language at call time
 *
 * A namespace's catalog is loaded before the first component that uses it renders (useT suspends inside the page's
 * Suspense boundary); a switch loads every namespace in use first and then re-renders, so nothing flashes in two languages.
 * A catalog that fails to load leaves the texts German.
 */

export type { Locale, Namespace } from './registry';
export type Vars = Record<string, string | number>;
export interface TFn {
  (text: string, vars?: Vars): string;
  /** `forms.other` is the message id; the catalog may give one string or plural forms of its own. `{n}` is set. */
  plural(n: number, forms: PluralForms, vars?: Vars): string;
  readonly locale: Locale;
}

const STORAGE_KEY = 'pghl.lang';
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && has(LOCALES, v);
export const localeNames = () => (Object.keys(LOCALES) as Locale[]).map((id) => ({ id, name: LOCALES[id].name }));

let current: Locale = SOURCE_LOCALE;
const catalogs = new Map<string, Catalog>();
const pending = new Map<string, Promise<void>>();
/** A load React's use() reads synchronously once it is done (React looks at `status`). */
type Tracked = Promise<void> & { status?: 'fulfilled'; value?: undefined };
const DONE: Tracked = Object.assign(Promise.resolve(), { status: 'fulfilled' as const, value: undefined });
/** The last load of each catalog: useT hands use() the same promise on every render, so a render React replays after waiting matches the first. */
const loads = new Map<string, Tracked>();
/** A catalog that failed to load: the texts stay German, the next switch tries again. */
const FAILED: Catalog = Object.freeze({});
const used = new Set<Namespace>(['core', 'errors']);
const listeners = new Set<() => void>();

const slot = (l: Locale, ns: Namespace) => `${l}:${ns}`;
const ready = (l: Locale, ns: Namespace) => l === SOURCE_LOCALE || catalogs.has(slot(l, ns));

function load(l: Locale, ns: Namespace): Promise<void> {
  if (ready(l, ns)) return Promise.resolve();
  const k = slot(l, ns);
  let p = pending.get(k);
  if (!p) {
    const loader = (CATALOGS as Partial<Record<Locale, Partial<Record<Namespace, () => Promise<{ default: Catalog }>>>>>)[l]?.[ns];
    const done = (c: Catalog) => {
      catalogs.set(k, c);
      Object.assign(tracked, { status: 'fulfilled', value: undefined });
    };
    const tracked: Tracked = (loader ? loader().then((m) => m.default) : Promise.resolve({} as Catalog)).then(done, () => done(FAILED));
    p = tracked;
    p.finally(() => pending.delete(k));
    pending.set(k, p);
    loads.set(k, tracked);
  }
  return p;
}

/** Loads the catalogs of a language (default: every namespace in use) – before the first screen, or ahead of a switch. */
export function preloadLocale(l: Locale, namespaces: Iterable<Namespace> = used): Promise<void> {
  const list = [...namespaces];
  for (const ns of list) if (catalogs.get(slot(l, ns)) === FAILED) catalogs.delete(slot(l, ns));
  return Promise.all(list.map((ns) => load(l, ns))).then(() => undefined);
}

export const getLocale = () => current;
const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));
/** The active language; the component re-renders when it changes. */
export const useLocale = () => useSyncExternalStore(subscribe, getLocale, getLocale);

/**
 * Switches the language: loads what the screen needs (every namespace in use, plus `also` – e.g. the shell before the first
 * screen), then re-renders everything at once. `remember` keeps the choice on this device.
 */
export async function setLocale(l: Locale, { remember = true, also = [] }: { remember?: boolean; also?: Namespace[] } = {}): Promise<void> {
  if (!isLocale(l)) return;
  await preloadLocale(l, [...used, ...also]);
  if (remember) {
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* private mode */
    }
  }
  if (l === current) return;
  current = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  listeners.forEach((fn) => fn());
}

/** The language chosen on this device before (login screen, profile), if any. */
export function storedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

/** First supported language in a list like navigator.languages / Accept-Language order; German when none matches. */
export function pickLocale(tags: readonly string[] | undefined): Locale {
  for (const tag of tags ?? []) {
    const base = String(tag).trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return SOURCE_LOCALE;
}
const browserTags = (): readonly string[] => (typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]);
/** What this browser asks for (the same list it sends as Accept-Language). */
export const browserLocale = () => pickLocale(browserTags());

// --- lookup -----------------------------------------------------------------------------------------------------
function lookup(l: Locale, ns: Namespace, text: string): string | PluralForms | undefined {
  if (l === SOURCE_LOCALE) return undefined;
  for (const n of [ns, 'core'] as Namespace[]) {
    const c = catalogs.get(slot(l, n));
    if (c && has(c, text)) return c[text];
  }
  return undefined;
}

/** `{name}` → vars.name; placeholders without a value (and `{{merge.tags}}`) stay as they are. */
export function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (has(vars, k) ? String(vars[k]) : m));
}

const rules = new Map<string, Intl.PluralRules>();
const pluralRule = (l: Locale) => rules.get(l) ?? rules.set(l, new Intl.PluralRules(l)).get(l)!;

function translate(l: Locale, ns: Namespace, text: string, vars?: Vars): string {
  const hit = lookup(l, ns, text);
  return interpolate(hit === undefined ? text : typeof hit === 'string' ? hit : hit.other, vars);
}

function plural(l: Locale, ns: Namespace, n: number, forms: PluralForms, vars?: Vars): string {
  const hit = lookup(l, ns, forms.other);
  const own: PluralForms = hit === undefined ? forms : typeof hit === 'string' ? { other: hit } : hit;
  const by: Locale = hit === undefined ? SOURCE_LOCALE : l;
  const s = (n === 0 && own.zero) || own[pluralRule(by).select(n) as keyof PluralForms] || own.other;
  return interpolate(s, { n, ...vars });
}

const bound = new Map<string, TFn>();
function translator(l: Locale, ns: Namespace): TFn {
  const k = slot(l, ns);
  let fn = bound.get(k);
  if (!fn) {
    const t = ((text: string, vars?: Vars) => translate(l, ns, text, vars)) as TFn & { locale: Locale };
    t.plural = (n, forms, vars) => plural(l, ns, n, forms, vars);
    t.locale = l;
    bound.set(k, (fn = t));
  }
  return fn;
}

/** In a component: the namespace's translator for the active language (waits for its catalog inside the Suspense boundary). */
export function useT(ns: Namespace): TFn {
  const l = useLocale();
  used.add(ns);
  // use() on every render – a conditional use() made React warn about a changed hook order when it replayed a render that had waited for the catalog
  use(ready(l, ns) ? (loads.get(slot(l, ns)) ?? DONE) : load(l, ns));
  return translator(l, ns);
}

/** Outside components (helpers, event handlers, toasts): translates with the language active at call time. */
export function tr(ns: Namespace): TFn {
  used.add(ns);
  const t = ((text: string, vars?: Vars) => translate(current, ns, text, vars)) as TFn;
  Object.defineProperty(t, 'plural', { value: (n: number, forms: PluralForms, vars?: Vars) => plural(current, ns, n, forms, vars) });
  Object.defineProperty(t, 'locale', { get: () => current });
  return t;
}

// --- server messages ----------------------------------------------------------------------------------------------
/** The server answers in German; the most common generic messages have a translation (en/errors.ts), the rest stays German. */
const ERROR_PATTERNS: [RegExp, string][] = [
  [/^Interner Fehler \(Request-ID ([\w-]+)\)$/, 'Interner Fehler (Request-ID {id})'],
  [/^Fehler (\d{3})$/, 'Fehler {id}'],
];
export function serverText(message: string): string {
  if (current === SOURCE_LOCALE || !message) return message;
  const exact = lookup(current, 'errors', message);
  if (exact !== undefined) return translate(current, 'errors', message);
  for (const [re, key] of ERROR_PATTERNS) {
    const m = re.exec(message);
    if (m) return translate(current, 'errors', key, { id: m[1] });
  }
  return message;
}

// --- formatting ---------------------------------------------------------------------------------------------------
/**
 * The Intl locale for numbers, dates and money: German stays de-DE (as before); another language takes the regional
 * variant the browser asks for (en-US, en-AU …) or its default (en-GB).
 */
export function intlLocale(l: Locale = current): string {
  if (l === SOURCE_LOCALE) return LOCALES[l].intl;
  const own = browserTags().find((tag) => tag.toLowerCase().startsWith(`${l}-`));
  return own ?? LOCALES[l].intl;
}
export const fmtNumber = (n: number, opts?: Intl.NumberFormatOptions) => new Intl.NumberFormat(intlLocale(), opts).format(n || 0);
/** Cents → "1.234,50 €" / "€1,234.50". */
export const fmtMoney = (cents: number, currency = 'EUR', opts?: Intl.NumberFormatOptions) => new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: currency || 'EUR', ...opts }).format((cents || 0) / 100);
export const fmtDate = (v: string | number | Date, opts?: Intl.DateTimeFormatOptions) => new Date(v).toLocaleDateString(intlLocale(), opts);
export const fmtDateTime = (v: string | number | Date, opts?: Intl.DateTimeFormatOptions) => new Date(v).toLocaleString(intlLocale(), opts);
export const fmtTime = (v: string | number | Date, opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }) => new Date(v).toLocaleTimeString(intlLocale(), opts);

// --- start ------------------------------------------------------------------------------------------------------
/** First guess before anything is loaded: this device's earlier choice, else the browser's languages. */
export function initialLocale(): Locale {
  return storedLocale() ?? browserLocale();
}
