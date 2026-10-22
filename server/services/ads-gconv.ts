import { googleEmail, googlePhone, sha256 } from './ads-hash.js';
import type { GoogleApi } from './ads-google.js';
import type { TouchRow } from './attribution.js';

/**
 * Google Ads offline conversion upload (ConversionUploadService.UploadClickConversions, REST) – the pure part plus the call:
 * which click id a contact has (gclid / gbraid / wbraid from the attribution touches), the user identifiers for enhanced
 * conversions for leads (e-mail and phone normalised and SHA-256-hashed exactly as Google specifies), the ClickConversion
 * objects, the conversion time in Google's format and the partial-failure answer split per row. Module: modules/ads-conversions.ts.
 */

export type GEvent = 'deal_won' | 'form_submitted' | 'booking' | 'invoice_paid';
export const G_EVENTS: GEvent[] = ['deal_won', 'form_submitted', 'booking', 'invoice_paid'];
export const G_EVENT_LABEL: Record<GEvent, string> = { deal_won: 'Deal gewonnen', form_submitted: 'Formular abgeschickt', booking: 'Termin gebucht', invoice_paid: 'Rechnung bezahlt' };

/** Google keeps clicks for 90 days; older ones can't be uploaded. */
export const CLICK_WINDOW_MS = 90 * 864e5;
/** Up to 2000 conversions per request are allowed; smaller batches keep a failure small. */
export const BATCH = 200;

export interface EventCfg {
  enabled: boolean;
  /** customers/<10 digits>/conversionActions/<id> */
  action: string;
  /** Fixed value (forms, bookings); deals and invoices bring their own amount. */
  value: number;
  /** Only these forms (empty = all). */
  form_ids: string[];
}

export interface GConvConfig {
  events: Record<GEvent, EventCfg>;
  /** Enhanced conversions for leads: also send hashed e-mail/phone (and upload leads without a click id). */
  enhanced_leads: boolean;
  currency: string;
}

const blankEvent = (): EventCfg => ({ enabled: false, action: '', value: 0, form_ids: [] });
export const DEFAULT_GCONV: GConvConfig = { events: { deal_won: blankEvent(), form_submitted: blankEvent(), booking: blankEvent(), invoice_paid: blankEvent() }, enhanced_leads: true, currency: 'EUR' };

export const ACTION_RE = /^customers\/(\d{10})\/conversionActions\/(\d{1,20})$/;

/** A conversion action resource name from what the user typed: the full name, or the numeric id plus the account's customer id. */
export function actionName(input: unknown, customerId: string): string {
  const s = String(input ?? '').trim().replace(/\s+/g, '');
  if (!s) return '';
  const m = ACTION_RE.exec(s.replace(/^customers\/(\d{3})-?(\d{3})-?(\d{4})\//, 'customers/$1$2$3/'));
  if (m) return `customers/${m[1]}/conversionActions/${m[2]}`;
  if (/^\d{1,20}$/.test(s) && /^\d{10}$/.test(customerId)) return `customers/${customerId}/conversionActions/${s}`;
  throw new Error('Conversion-Aktion: „customers/1234567890/conversionActions/987654321“ oder nur die Aktions-ID (Google Ads → Ziele → Conversions → Aktion → in der Adresszeile ctId)');
}

/** Settings from a request on top of the stored ones; German errors. */
export function cleanConfig(input: Record<string, any> | undefined, cur: Partial<GConvConfig> = {}, customerId = ''): GConvConfig {
  const events = Object.fromEntries(G_EVENTS.map((ev) => [ev, { ...blankEvent(), ...(cur.events?.[ev] ?? {}) }])) as Record<GEvent, EventCfg>;
  const base: GConvConfig = { ...DEFAULT_GCONV, ...cur, events };
  const b = input ?? {};
  if (b.enhanced_leads !== undefined) base.enhanced_leads = !!b.enhanced_leads;
  if (b.currency !== undefined) {
    const c = String(b.currency ?? '').trim().toUpperCase() || 'EUR';
    if (!/^[A-Z]{3}$/.test(c)) throw new Error('Währung: dreistelliger Code wie EUR');
    base.currency = c;
  }
  for (const ev of G_EVENTS) {
    const e = b.events?.[ev];
    if (!e) continue;
    const next: EventCfg = { ...blankEvent(), ...base.events[ev] };
    if (e.enabled !== undefined) next.enabled = !!e.enabled;
    if (e.action !== undefined) next.action = actionName(e.action, customerId);
    if (e.value !== undefined) {
      const v = Number(String(e.value).replace(',', '.'));
      if (!Number.isFinite(v) || v < 0 || v > 1e9) throw new Error(`${G_EVENT_LABEL[ev]}: Wert muss eine Zahl ≥ 0 sein`);
      next.value = Math.round(v * 100) / 100;
    }
    if (e.form_ids !== undefined) next.form_ids = (Array.isArray(e.form_ids) ? e.form_ids : String(e.form_ids).split(/[\s,]+/)).map((x: unknown) => String(x).trim()).filter((x: string) => /^[\w-]{4,64}$/.test(x)).slice(0, 50);
    if (next.enabled && !next.action) throw new Error(`${G_EVENT_LABEL[ev]}: Conversion-Aktion fehlt`);
    base.events[ev] = next;
  }
  return base;
}

// --- click ids and identifiers -------------------------------------------------------------------------------------------

export interface Click {
  kind: 'gclid' | 'gbraid' | 'wbraid';
  value: string;
  at: string;
}

/**
 * The newest Google click of a contact within 90 days. The attribution touch keeps gclid || gbraid || wbraid in `gclid` and
 * the braid ids additionally as `click_id` ("gbraid:…") – that tells which one it is.
 */
export function googleClick(touches: Pick<TouchRow, 'gclid' | 'click_id' | 'created_at'>[], at = new Date()): Click | null {
  for (const t of [...touches].reverse()) {
    const v = String(t.gclid ?? '').trim();
    if (!v) continue;
    if (at.getTime() - Date.parse(t.created_at) > CLICK_WINDOW_MS) return null;
    const cid = String(t.click_id ?? '');
    const kind = cid === `gbraid:${v}` ? 'gbraid' : cid === `wbraid:${v}` ? 'wbraid' : 'gclid';
    return { kind, value: v, at: t.created_at };
  }
  return null;
}

/**
 * User identifiers for enhanced conversions (leads): e-mail trimmed + lower case (+ dots before @ removed for gmail.com /
 * googlemail.com), phone in E.164 with "+", each SHA-256 hex. Only the hashes leave the server.
 */
export function userIdentifiers(c: { email?: string | null; phone?: string | null }, defaultCc = '49'): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const email = googleEmail(c.email);
  const phone = googlePhone(c.phone, defaultCc);
  if (email) out.push({ hashedEmail: sha256(email), userIdentifierSource: 'FIRST_PARTY' });
  if (phone) out.push({ hashedPhoneNumber: sha256(phone), userIdentifierSource: 'FIRST_PARTY' });
  return out;
}

/** "yyyy-mm-dd hh:mm:ss+hh:mm" in the account's time zone (what ClickConversion.conversion_date_time expects). */
export function googleDateTime(d: Date, timeZone = 'Europe/Berlin'): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(d).map((p) => [p.type, p.value]));
  const off = String(parts.timeZoneName ?? 'GMT').replace('GMT', '') || '+00:00';
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}${/^[+-]\d\d:\d\d$/.test(off) ? off : '+00:00'}`;
}

export interface ConversionInput {
  action: string;
  orderId: string;
  at: Date;
  timeZone: string;
  value?: number;
  currency?: string;
  click: Click | null;
  identifiers: Record<string, string>[];
}

/**
 * One ClickConversion. Exactly one of gclid / gbraid / wbraid; user identifiers only with a gclid or without any click id
 * (Google refuses them next to gbraid/wbraid). `consent.adUserData` is GRANTED – the module uploads nothing without consent.
 */
export function clickConversion(i: ConversionInput): Record<string, any> {
  const braid = i.click && i.click.kind !== 'gclid';
  return {
    conversionAction: i.action,
    conversionDateTime: googleDateTime(i.at, i.timeZone),
    ...(i.click ? { [i.click.kind]: i.click.value } : {}),
    ...(i.value !== undefined && i.value > 0 ? { conversionValue: Math.round(i.value * 100) / 100, currencyCode: (i.currency || 'EUR').toUpperCase() } : {}),
    orderId: i.orderId.slice(0, 64),
    ...(!braid && i.identifiers.length ? { userIdentifiers: i.identifiers } : {}),
    consent: { adUserData: 'GRANTED' },
  };
}

// --- the answer ------------------------------------------------------------------------------------------------------------------

export interface RowResult {
  ok: boolean;
  /** Google's error code (e.g. CLICK_NOT_FOUND), '' when ok. */
  code: string;
  message: string;
  /** Worth another try later (click not processed yet, action too new, Google busy). */
  retry: boolean;
  /** Google already has it (same order id / click) – done. */
  duplicate: boolean;
}

const RETRY_CODES = new Set(['CLICK_NOT_FOUND', 'TOO_RECENT_CONVERSION_ACTION', 'TOO_RECENT_CLICK', 'CONVERSION_NOT_FOUND', 'INTERNAL_ERROR', 'TRANSIENT_ERROR', 'RESOURCE_EXHAUSTED', 'RESOURCE_TEMPORARILY_EXHAUSTED']);
const DUPLICATE_CODES = new Set(['CLICK_CONVERSION_ALREADY_EXISTS', 'DUPLICATE_ORDER_ID', 'ORDER_ID_ALREADY_IN_USE']);
const HINT: Record<string, string> = {
  CLICK_NOT_FOUND: 'Google kennt den Klick (noch) nicht – neuer Versuch später',
  TOO_RECENT_CONVERSION_ACTION: 'Die Conversion-Aktion ist jünger als 6 Stunden – neuer Versuch später',
  EXPIRED_CLICK: 'Der Klick ist älter als das Conversion-Fenster',
  CONVERSION_PRECEDES_CLICK: 'Die Conversion liegt vor dem Klick',
  INVALID_CONVERSION_ACTION: 'Unbekannte Conversion-Aktion',
  NO_CONVERSION_ACTION_FOUND: 'Unbekannte Conversion-Aktion',
  CONVERSION_ACTION_NOT_ELIGIBLE_FOR_ENHANCED_CONVERSIONS: 'Die Aktion ist nicht für erweiterte Conversions für Leads eingerichtet',
  CUSTOMER_NOT_ACCEPTED_CUSTOMER_DATA_TERMS: 'Im Google-Ads-Konto sind die Bedingungen für Kundendaten noch nicht akzeptiert',
  UNPARSEABLE_GCLID: 'Die Klick-ID ist ungültig',
  CLICK_CONVERSION_ALREADY_EXISTS: 'Schon hochgeladen',
  DUPLICATE_ORDER_ID: 'Schon hochgeladen',
};

/**
 * Splits a partial-failure answer into one result per sent conversion: errors carry the row in
 * location.fieldPathElements (conversions[i]); a row without error but with an empty result also failed.
 */
export function splitResults(resp: any, count: number): RowResult[] {
  const errs = new Map<number, { code: string; message: string }>();
  const details: any[] = Array.isArray(resp?.partialFailureError?.details) ? resp.partialFailureError.details : [];
  for (const d of details)
    for (const e of Array.isArray(d?.errors) ? d.errors : []) {
      const path: any[] = Array.isArray(e?.location?.fieldPathElements) ? e.location.fieldPathElements : [];
      const idx = Number(path.find((p) => p?.fieldName === 'conversions')?.index ?? (count === 1 ? 0 : -1));
      if (idx < 0 || errs.has(idx)) continue;
      const code = String(Object.values(e?.errorCode ?? {})[0] ?? '');
      errs.set(idx, { code, message: String(e?.message ?? '') });
    }
  const results: any[] = Array.isArray(resp?.results) ? resp.results : [];
  const out: RowResult[] = [];
  for (let i = 0; i < count; i++) {
    const e = errs.get(i);
    if (e) {
      const duplicate = DUPLICATE_CODES.has(e.code);
      out.push({ ok: duplicate, code: e.code, message: `${HINT[e.code] ?? e.message ?? e.code}`.slice(0, 300) || e.code, retry: RETRY_CODES.has(e.code), duplicate });
    } else if (results.length && results[i] && Object.keys(results[i]).length === 0) {
      out.push({ ok: false, code: 'UNKNOWN', message: String(resp?.partialFailureError?.message ?? 'Von Google abgelehnt').slice(0, 300), retry: false, duplicate: false });
    } else out.push({ ok: true, code: '', message: '', retry: false, duplicate: false });
  }
  return out;
}

/** POST customers/{id}:uploadClickConversions with partial failure on; `validateOnly` = dry run (nothing is stored at Google). */
export function uploadClickConversions(api: GoogleApi, conversions: Record<string, any>[], validateOnly: boolean): Promise<any> {
  return api.call('POST', `customers/${api.customerId}:uploadClickConversions`, { conversions, partialFailure: true, validateOnly });
}
