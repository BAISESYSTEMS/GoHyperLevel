import { createHash } from 'node:crypto';
import { bad } from '../core/http.js';
import type { Platform } from './ads-store.js';

/**
 * The campaign spec of the wizard: what a person (or an agent) describes, independent of the platform's API.
 * `cleanSpec` turns any input into a well-formed spec (unknown keys dropped, texts and numbers bounded),
 * `validateSpec` lists what still blocks publishing, `reviewOf` is the content of the review screen.
 * Pure functions – the platform clients (ads-meta.ts, ads-google.ts) turn a spec into API calls.
 */

export const GOALS = ['leads', 'traffic', 'conversions', 'reach'] as const;
export type Goal = (typeof GOALS)[number];
export const GOAL_LABEL: Record<Goal, string> = { leads: 'Leads gewinnen', traffic: 'Website-Besucher', conversions: 'Conversions / Verkäufe', reach: 'Reichweite' };
export const KINDS = ['website', 'lead_form', 'search', 'pmax'] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABEL: Record<Kind, string> = { website: 'Anzeige mit Link zur Website', lead_form: 'Lead-Anzeige mit Sofortformular', search: 'Suchnetzwerk (Responsive Suchanzeige)', pmax: 'Performance Max' };

/** Call-to-action buttons offered for Meta (API names → label). */
export const CTA_LABEL: Record<string, string> = {
  LEARN_MORE: 'Mehr dazu',
  SIGN_UP: 'Registrieren',
  CONTACT_US: 'Kontakt',
  GET_QUOTE: 'Angebot einholen',
  APPLY_NOW: 'Jetzt bewerben',
  DOWNLOAD: 'Herunterladen',
  SUBSCRIBE: 'Abonnieren',
  BOOK_TRAVEL: 'Jetzt buchen',
  SHOP_NOW: 'Jetzt kaufen',
  ORDER_NOW: 'Jetzt bestellen',
  GET_OFFER: 'Angebot sichern',
};

export const CONVERSION_EVENTS = ['PURCHASE', 'LEAD', 'COMPLETE_REGISTRATION', 'ADD_TO_CART', 'INITIATE_CHECKOUT', 'SCHEDULE', 'CONTACT'] as const;
export const MATCH_TYPES = ['BROAD', 'PHRASE', 'EXACT'] as const;

/** EU member states (+ EEA): Meta wants the beneficiary and payer of an ad set that targets them (DSA). */
export const EU_COUNTRIES = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO'];

export interface MediaRef {
  upload_id: string;
  /** Google Performance Max: which asset slot the image fills. */
  role?: 'image' | 'video' | 'marketing' | 'square' | 'logo' | 'thumbnail';
}

export interface GeoTarget {
  /** Meta: country | region | city | zip (key from the targeting search). Google: geo target constant id. */
  type: 'country' | 'region' | 'city' | 'zip' | 'geo';
  key: string;
  name: string;
  /** ISO country code of the place (from the targeting search), when known. */
  country?: string;
  radius?: number;
  unit?: 'kilometer' | 'mile';
}

export interface AdSpec {
  platform: Platform;
  kind: Kind;
  name: string;
  goal: Goal;
  budget: { type: 'daily' | 'lifetime'; amount_cents: number };
  schedule: { start?: string; end?: string };
  audience: {
    countries?: string[];
    locations?: GeoTarget[];
    age_min?: number;
    age_max?: number;
    genders?: ('male' | 'female')[];
    interests?: { id: string; name: string }[];
    /** Local audience ids (ads_audiences): customer lists and lookalikes. */
    audience_ids?: string[];
    exclude_audience_ids?: string[];
    keywords?: { text: string; match: (typeof MATCH_TYPES)[number] }[];
    negative_keywords?: string[];
    languages?: string[];
  };
  creative: {
    media?: MediaRef[];
    primary_text?: string;
    headline?: string;
    description?: string;
    cta?: string;
    link?: { funnel_id?: string; page_id?: string; url?: string };
    /** Append UTM parameters to the link (default on). */
    utm?: boolean;
    headlines?: string[];
    long_headlines?: string[];
    descriptions?: string[];
    business_name?: string;
    path1?: string;
    path2?: string;
  };
  /** Local id of an instant form (ads_leadforms) for kind lead_form. */
  lead_form_id?: string;
  conversion_event?: string;
  dsa?: { beneficiary?: string; payor?: string };
  max_cpc_cents?: number;
}

const txt = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const multiline = (v: unknown, max: number) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);
const list = (v: unknown, max: number, each: number) => (Array.isArray(v) ? v.map((x) => txt(x, each)).filter(Boolean).slice(0, max) : []);
const intIn = (v: unknown, min: number, max: number, fallback?: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};
const date = (v: unknown) => {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  if (!/^\d{4}-\d\d-\d\d(T\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)?)?$/.test(s)) throw bad(`Datum ungültig: ${s.slice(0, 30)}`);
  if (Number.isNaN(Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s))) throw bad(`Datum ungültig: ${s.slice(0, 30)}`);
  return s;
};
const ids = (v: unknown, max = 20) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? '').trim()).filter((x) => /^[\w-]{1,60}$/.test(x)))].slice(0, max) : []);

/** Any input → a spec with the right shapes. Throws only for things that make no sense at all (unknown platform, bad dates). */
export function cleanSpec(raw: any, defaults: Partial<AdSpec> = {}): AdSpec {
  // An update names only what changes: the groups (budget, audience …) are merged one level deep.
  const r = { ...defaults, ...(raw && typeof raw === 'object' ? raw : {}) } as Record<string, any>;
  for (const k of ['budget', 'schedule', 'audience', 'creative', 'dsa'] as const) {
    const base = (defaults as Record<string, any>)[k];
    const over = raw && typeof raw === 'object' ? raw[k] : undefined;
    if (base && typeof base === 'object' && over && typeof over === 'object' && !Array.isArray(over)) r[k] = { ...base, ...over };
  }
  const platform: Platform = r.platform === 'google' ? 'google' : r.platform === 'meta' ? 'meta' : (defaults.platform as Platform);
  if (platform !== 'meta' && platform !== 'google') throw bad('Plattform: meta oder google');
  const goal: Goal = (GOALS as readonly string[]).includes(r.goal) ? r.goal : 'leads';
  let kind: Kind = (KINDS as readonly string[]).includes(r.kind) ? r.kind : platform === 'google' ? 'search' : goal === 'leads' ? 'lead_form' : 'website';
  // A kind of the other platform is a typo: fall back to the platform's default.
  if (platform === 'meta' && (kind === 'search' || kind === 'pmax')) kind = goal === 'leads' ? 'lead_form' : 'website';
  if (platform === 'google' && (kind === 'website' || kind === 'lead_form')) kind = 'search';
  const b = r.budget && typeof r.budget === 'object' ? r.budget : {};
  const a = r.audience && typeof r.audience === 'object' ? r.audience : {};
  const c = r.creative && typeof r.creative === 'object' ? r.creative : {};
  const link = c.link && typeof c.link === 'object' ? c.link : {};
  const sched = r.schedule && typeof r.schedule === 'object' ? r.schedule : {};
  const age_min = intIn(a.age_min, 13, 65, undefined);
  const age_max = intIn(a.age_max, 13, 65, undefined);
  const spec: AdSpec = {
    platform,
    kind,
    name: txt(r.name, 120),
    goal,
    budget: { type: b.type === 'lifetime' ? 'lifetime' : 'daily', amount_cents: Math.max(0, Math.round(Number(b.amount_cents)) || 0) },
    schedule: { start: date(sched.start), end: date(sched.end) },
    audience: {
      countries: [...new Set(list(a.countries, 30, 8).map((x) => x.toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)))],
      locations: (Array.isArray(a.locations) ? a.locations : [])
        .slice(0, 50)
        .map((l: any): GeoTarget => ({ type: ['country', 'region', 'city', 'zip', 'geo'].includes(l?.type) ? l.type : 'geo', key: txt(l?.key, 60), name: txt(l?.name, 120), country: /^[A-Za-z]{2}$/.test(String(l?.country ?? '')) ? String(l.country).toUpperCase() : undefined, radius: intIn(l?.radius, 1, 80), unit: l?.unit === 'mile' ? 'mile' : l?.radius ? 'kilometer' : undefined }))
        .filter((l: GeoTarget) => l.key),
      age_min,
      age_max,
      genders: [...new Set((Array.isArray(a.genders) ? a.genders : []).filter((g: unknown) => g === 'male' || g === 'female'))] as ('male' | 'female')[],
      interests: (Array.isArray(a.interests) ? a.interests : [])
        .slice(0, 30)
        .map((i: any) => ({ id: txt(i?.id, 40), name: txt(i?.name, 120) }))
        .filter((i: { id: string }) => /^\d{3,25}$/.test(i.id)),
      audience_ids: ids(a.audience_ids),
      exclude_audience_ids: ids(a.exclude_audience_ids),
      keywords: (Array.isArray(a.keywords) ? a.keywords : [])
        .slice(0, 100)
        .map((k: any) => ({ text: txt(typeof k === 'string' ? k : k?.text, 80), match: (MATCH_TYPES as readonly string[]).includes(k?.match) ? k.match : 'PHRASE' }))
        .filter((k: { text: string }) => k.text),
      negative_keywords: list(a.negative_keywords, 100, 80),
      languages: list(a.languages, 10, 40),
    },
    creative: {
      media: (Array.isArray(c.media) ? c.media : [])
        .slice(0, 20)
        .map((m: any): MediaRef => ({ upload_id: txt(m?.upload_id ?? m, 60), role: ['image', 'video', 'marketing', 'square', 'logo', 'thumbnail'].includes(m?.role) ? m.role : undefined }))
        .filter((m: MediaRef) => /^[\w-]{1,60}$/.test(m.upload_id)),
      primary_text: multiline(c.primary_text, 2000),
      headline: txt(c.headline, 255),
      description: txt(c.description, 255),
      cta: txt(c.cta, 40).toUpperCase() || undefined,
      link: { funnel_id: txt(link.funnel_id, 60) || undefined, page_id: txt(link.page_id, 60) || undefined, url: txt(link.url, 2000) || undefined },
      utm: c.utm === false ? false : true,
      headlines: list(c.headlines, 15, 90),
      long_headlines: list(c.long_headlines, 5, 120),
      descriptions: list(c.descriptions, 5, 120),
      business_name: txt(c.business_name, 60) || undefined,
      path1: txt(c.path1, 15) || undefined,
      path2: txt(c.path2, 15) || undefined,
    },
    lead_form_id: txt(r.lead_form_id, 60) || undefined,
    conversion_event: (CONVERSION_EVENTS as readonly string[]).includes(String(r.conversion_event).toUpperCase()) ? String(r.conversion_event).toUpperCase() : undefined,
    dsa: r.dsa && typeof r.dsa === 'object' ? { beneficiary: txt(r.dsa.beneficiary, 100) || undefined, payor: txt(r.dsa.payor, 100) || undefined } : undefined,
    max_cpc_cents: intIn(r.max_cpc_cents, 1, 100_000),
  };
  if (spec.audience.age_min && spec.audience.age_max && spec.audience.age_min > spec.audience.age_max) spec.audience.age_max = spec.audience.age_min;
  return spec;
}

export interface Problems {
  errors: string[];
  warnings: string[];
}

const days = (from?: string, to?: string) => {
  if (!from || !to) return 0;
  return Math.max(1, Math.ceil((Date.parse(to.length === 10 ? `${to}T23:59:59Z` : to) - Date.parse(from.length === 10 ? `${from}T00:00:00Z` : from)) / 864e5));
};

/** Everything that stops a publish (errors) or deserves a second look (warnings). */
export function validateSpec(spec: AdSpec, o: { maxDailyCents: number; hasPixel?: boolean; hasPage?: boolean; hasLeadForm?: boolean; link?: string }): Problems {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { audience: a, creative: c, budget } = spec;
  if (!spec.name) errors.push('Name der Kampagne fehlt');
  if (!budget.amount_cents) errors.push('Budget fehlt');
  const daily = budget.type === 'daily' ? budget.amount_cents : spec.schedule.end ? Math.round(budget.amount_cents / days(spec.schedule.start ?? new Date().toISOString().slice(0, 10), spec.schedule.end)) : budget.amount_cents;
  if (budget.amount_cents && daily > o.maxDailyCents) errors.push(`Das Budget liegt über dem Tageslimit dieses Sub-Accounts (${(o.maxDailyCents / 100).toLocaleString('de-DE')} €) – Limit unter Anzeigen → Verbindungen anpassen`);
  if (budget.type === 'lifetime') {
    if (!spec.schedule.end) errors.push('Ein Gesamtbudget braucht ein Enddatum');
    else if (spec.schedule.start && spec.schedule.end <= spec.schedule.start) errors.push('Das Ende muss nach dem Start liegen');
  } else if (spec.schedule.start && spec.schedule.end && spec.schedule.end < spec.schedule.start) errors.push('Das Ende liegt vor dem Start');
  if (spec.schedule.end && Date.parse(spec.schedule.end.length === 10 ? `${spec.schedule.end}T23:59:59Z` : spec.schedule.end) < Date.now()) errors.push('Das Enddatum liegt in der Vergangenheit');
  if (!o.link) errors.push('Link fehlt: Funnel-Seite wählen oder Adresse eintragen');

  if (spec.platform === 'meta') {
    if (!o.hasPage) errors.push('Facebook-Seite fehlt – unter Anzeigen → Verbindungen wählen (die Anzeige erscheint im Namen der Seite)');
    if (spec.goal === 'leads' && spec.kind === 'website' && !o.hasPixel) errors.push('Website-Leads brauchen ein Meta-Pixel (Verbindungen) – oder wähle ein Sofortformular');
    if (spec.goal === 'conversions' && !o.hasPixel) errors.push('Conversions brauchen ein Meta-Pixel (Anzeigen → Verbindungen)');
    if (spec.kind === 'lead_form' && !o.hasLeadForm) errors.push('Sofortformular fehlt – eines wählen oder anlegen');
    if (!a.countries?.length && !a.locations?.length) errors.push('Ort fehlt: mindestens ein Land oder eine Stadt');
    if (!c.primary_text) errors.push('Haupttext fehlt');
    if (!c.headline) errors.push('Überschrift fehlt');
    if (!c.media?.length) errors.push('Bild oder Video fehlt');
    if (c.primary_text && c.primary_text.length > 125) warnings.push('Der Haupttext wird nach etwa 125 Zeichen mit „… mehr“ gekürzt');
    if (c.headline && c.headline.length > 40) warnings.push('Die Überschrift wird ab etwa 40 Zeichen abgeschnitten');
    if (c.description && c.description.length > 30) warnings.push('Die Beschreibung wird ab etwa 30 Zeichen abgeschnitten');
    if (c.cta && !(c.cta in CTA_LABEL)) errors.push(`Button „${c.cta}“ gibt es nicht`);
    const eu = [...(a.countries ?? [])].some((x) => EU_COUNTRIES.includes(x)) || (a.locations ?? []).some((l) => l.type === 'country' && EU_COUNTRIES.includes(l.key.toUpperCase()));
    if (eu && !spec.dsa?.beneficiary) warnings.push('Für die EU verlangt Meta Begünstigten und Zahler der Anzeige – ohne Angabe wird der Name der Seite genommen');
    if (a.interests?.length && a.audience_ids?.length) warnings.push('Interessen und eigene Zielgruppen werden kombiniert (UND) – die Zielgruppe wird dadurch eng');
    if (!a.audience_ids?.length && !a.interests?.length) warnings.push('Ohne Interessen oder Zielgruppen wählt Meta die Menschen allein (breit) – das ist oft gut, braucht aber mehr Budget');
    if (spec.goal === 'reach' && spec.kind !== 'website') errors.push('Reichweite geht nur mit einer Website-Anzeige');
  } else {
    if (spec.goal === 'reach') errors.push('Reichweite gibt es nur bei Meta – für Google Traffic oder Leads wählen');
    if (!a.locations?.length) errors.push('Ort fehlt: mindestens ein Zielgebiet (Google-Standort)');
    if (spec.kind === 'search') {
      if (!a.keywords?.length) errors.push('Keywords fehlen');
      const h = (c.headlines ?? []).filter(Boolean);
      const d = (c.descriptions ?? []).filter(Boolean);
      if (h.length < 3) errors.push('Mindestens 3 Überschriften (je höchstens 30 Zeichen)');
      if (d.length < 2) errors.push('Mindestens 2 Beschreibungen (je höchstens 90 Zeichen)');
      if (h.some((x) => x.length > 30)) errors.push('Eine Überschrift ist länger als 30 Zeichen');
      if (d.some((x) => x.length > 90)) errors.push('Eine Beschreibung ist länger als 90 Zeichen');
      if (h.length > 15) errors.push('Höchstens 15 Überschriften');
      if (d.length > 4) errors.push('Höchstens 4 Beschreibungen');
      if (c.path1 && c.path1.length > 15) errors.push('Pfad 1: höchstens 15 Zeichen');
      if (c.path2 && c.path2.length > 15) errors.push('Pfad 2: höchstens 15 Zeichen');
      if (h.length && new Set(h.map((x) => x.toLowerCase())).size < h.length) warnings.push('Einige Überschriften sind doppelt');
    } else if (spec.kind === 'pmax') {
      const h = (c.headlines ?? []).filter(Boolean);
      const lh = (c.long_headlines ?? []).filter(Boolean);
      const d = (c.descriptions ?? []).filter(Boolean);
      if (h.length < 3) errors.push('Performance Max: mindestens 3 Überschriften (je höchstens 30 Zeichen)');
      if (lh.length < 1) errors.push('Performance Max: mindestens 1 lange Überschrift (höchstens 90 Zeichen)');
      if (d.length < 2) errors.push('Performance Max: mindestens 2 Beschreibungen (eine höchstens 60, die anderen 90 Zeichen)');
      if (h.some((x) => x.length > 30)) errors.push('Eine Überschrift ist länger als 30 Zeichen');
      if (lh.some((x) => x.length > 90)) errors.push('Eine lange Überschrift ist länger als 90 Zeichen');
      if (d.some((x) => x.length > 90)) errors.push('Eine Beschreibung ist länger als 90 Zeichen');
      if (!d.some((x) => x.length <= 60)) errors.push('Performance Max: eine Beschreibung muss höchstens 60 Zeichen haben');
      if (!c.business_name) errors.push('Performance Max: Firmenname fehlt (höchstens 25 Zeichen)');
      else if (c.business_name.length > 25) errors.push('Firmenname: höchstens 25 Zeichen');
      const roles = new Set((c.media ?? []).map((m) => m.role));
      if (!roles.has('marketing')) errors.push('Performance Max: ein Querformat-Bild (1,91:1) fehlt');
      if (!roles.has('square')) errors.push('Performance Max: ein quadratisches Bild (1:1) fehlt');
      if (!roles.has('logo')) errors.push('Performance Max: ein Logo (1:1) fehlt');
      if (spec.goal === 'traffic') warnings.push('Performance Max optimiert auf Conversions – für reinen Traffic ist das Suchnetzwerk besser');
    }
    if (spec.goal === 'conversions' && !o.hasPixel) warnings.push('Ohne eingerichtete Conversion-Erfassung in Google Ads kann „Conversions“ nicht optimieren – dann zuerst Conversions einrichten');
  }
  return { errors, warnings };
}

// --- links and UTM ------------------------------------------------------------------------------------

export const UTM_SOURCE: Record<Platform, string> = { meta: 'facebook', google: 'google' };
export const UTM_MEDIUM: Record<Platform, string> = { meta: 'paid_social', google: 'cpc' };

/** Adds the UTM parameters the attribution reads. Parameters the link already has stay as they are. */
export function withUtm(url: string, utm: Record<string, string>): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  for (const [k, v] of Object.entries(utm)) if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Tracking for a spec. Meta: `url_tags` with the platform's macros (the name that shows up in the reports, even after
 * a rename). Google: a tracking template with ValueTrack parameters ({campaignid} – the report matches campaign ids).
 * `example` is what a click looks like, for the review screen.
 */
export function tracking(spec: AdSpec, link: string): { urlTags?: string; trackingTemplate?: string; example: string } {
  if (!link || spec.creative.utm === false) return { example: link };
  const present = (() => {
    try {
      return new URL(link).searchParams.has('utm_source');
    } catch {
      return false;
    }
  })();
  if (present) return { example: link };
  const source = UTM_SOURCE[spec.platform];
  const medium = UTM_MEDIUM[spec.platform];
  if (spec.platform === 'meta') {
    return {
      urlTags: `utm_source=${source}&utm_medium=${medium}&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}`,
      example: withUtm(link, { utm_source: source, utm_medium: medium, utm_campaign: spec.name, utm_content: `${spec.name} – Anzeige`, utm_term: `${spec.name} – Anzeigengruppe` }),
    };
  }
  return {
    trackingTemplate: `{lpurl}${link.includes('?') ? '&' : '?'}utm_source=${source}&utm_medium=${medium}&utm_campaign={campaignid}&utm_term={keyword}`,
    example: withUtm(link, { utm_source: source, utm_medium: medium, utm_campaign: '<Kampagnen-ID>', utm_term: '<Keyword>' }),
  };
}

// --- review -----------------------------------------------------------------------------------------------

export const canonical = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object)
    .sort()
    .filter((k) => (v as any)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`)
    .join(',')}}`;
};

/** What the person looked at: publishing is bound to exactly this version of the spec (and this ad account). */
export const reviewHash = (spec: AdSpec, account: string) => createHash('sha256').update(`${account}\n${canonical(spec)}`).digest('hex').slice(0, 32);

const eur = (c: number, cur = 'EUR') => new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur }).format((c || 0) / 100);

export interface Review {
  platform: Platform;
  account: string;
  status_after: 'paused';
  headline: string;
  rows: { label: string; value: string }[];
  preview: { primary_text?: string; headline?: string; description?: string; cta?: string; link?: string; example_link?: string; media: string[]; headlines?: string[]; descriptions?: string[] };
  errors: string[];
  warnings: string[];
  ready: boolean;
  hash: string;
  note: string;
}

/** The review screen: every setting in plain words, the ad as it will look, what blocks and what to double-check. */
export function reviewOf(spec: AdSpec, o: { accountName: string; currency: string; problems: Problems; link: string; mediaNames: string[]; audienceNames: string[]; leadFormName?: string; hash: string }): Review {
  const t = tracking(spec, o.link);
  // Shown to people: decoded, not as a URL-encoded string.
  const readable = (u: string) => {
    try {
      return decodeURIComponent(u.replace(/\+/g, ' '));
    } catch {
      return u;
    }
  };
  const a = spec.audience;
  const where = [...(a.countries ?? []), ...(a.locations ?? []).map((l) => l.name || l.key)].join(', ') || '–';
  const budget = spec.budget.type === 'daily' ? `${eur(spec.budget.amount_cents, o.currency)} pro Tag` : `${eur(spec.budget.amount_cents, o.currency)} insgesamt`;
  const span = spec.schedule.start || spec.schedule.end ? `${spec.schedule.start?.slice(0, 10) ?? 'ab Aktivierung'} bis ${spec.schedule.end?.slice(0, 10) ?? 'offen'}` : 'ab Aktivierung, ohne Ende';
  const maxTotal = spec.budget.type === 'daily' && spec.schedule.end ? ` (höchstens ${eur(spec.budget.amount_cents * days(spec.schedule.start ?? new Date().toISOString().slice(0, 10), spec.schedule.end), o.currency)} in der Laufzeit)` : '';
  const rows: { label: string; value: string }[] = [
    { label: 'Plattform', value: `${spec.platform === 'meta' ? 'Meta (Facebook & Instagram)' : 'Google Ads'} · ${o.accountName}` },
    { label: 'Art', value: KIND_LABEL[spec.kind] },
    { label: 'Ziel', value: GOAL_LABEL[spec.goal] },
    { label: 'Budget', value: `${budget}${maxTotal}` },
    { label: 'Zeitraum', value: span },
    { label: 'Orte', value: where },
  ];
  if (spec.platform === 'meta') {
    rows.push({ label: 'Alter & Geschlecht', value: `${a.age_min ?? 18}–${a.age_max && a.age_max < 65 ? a.age_max : '65+'} Jahre · ${a.genders?.length === 1 ? (a.genders[0] === 'male' ? 'Männer' : 'Frauen') : 'alle'}` });
    rows.push({ label: 'Interessen', value: (a.interests ?? []).map((i) => i.name).join(', ') || 'keine (breite Zielgruppe)' });
  } else {
    rows.push({ label: 'Keywords', value: (a.keywords ?? []).map((k) => (k.match === 'EXACT' ? `[${k.text}]` : k.match === 'PHRASE' ? `"${k.text}"` : k.text)).join(', ') || '–' });
    rows.push({ label: 'Sprachen', value: (a.languages ?? []).join(', ') || 'alle' });
  }
  if (o.audienceNames.length) rows.push({ label: 'Eigene Zielgruppen', value: o.audienceNames.join(', ') });
  if (o.leadFormName) rows.push({ label: 'Sofortformular', value: o.leadFormName });
  rows.push({ label: 'Link', value: o.link || '–' });
  rows.push({ label: 'Tracking', value: spec.creative.utm === false ? 'keine UTM-Parameter' : readable(t.example) });
  const ready = !o.problems.errors.length;
  return {
    platform: spec.platform,
    account: o.accountName,
    status_after: 'paused',
    headline: spec.name,
    rows,
    preview: {
      primary_text: spec.creative.primary_text,
      headline: spec.creative.headline,
      description: spec.creative.description,
      cta: spec.creative.cta ? CTA_LABEL[spec.creative.cta] ?? spec.creative.cta : undefined,
      link: o.link,
      example_link: readable(t.example),
      media: o.mediaNames,
      headlines: spec.creative.headlines,
      descriptions: spec.creative.descriptions,
    },
    errors: o.problems.errors,
    warnings: o.problems.warnings,
    ready,
    hash: o.hash,
    note: 'Die Kampagne wird pausiert angelegt – es wird nichts ausgegeben, bis du sie aktivierst (mit Bestätigung).',
  };
}
