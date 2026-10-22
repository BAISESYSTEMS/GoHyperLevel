import { createHash } from 'node:crypto';
import { addDaysYmd } from '../core/time.js';
import { checkBic, checkIban, normalizeIban } from './invoice-model.js';
import type { Scheme, SeqType } from './sepa-xml.js';

/**
 * SEPA direct debit without a payment provider – the pure part: creditor identifier and IBAN/BIC checks, mandate
 * references and the legally required mandate text, sequence types (FRST → RCUR, OOFF, FNAL), the 36-month expiry,
 * TARGET2 business days, return reason codes and the settings with their defaults. No database, no I/O (docs/sepa.md).
 */

export type { Scheme, SeqType };
export type MandateKind = 'RCUR' | 'OOFF';
export type MandateStatus = 'pending' | 'active' | 'suspended' | 'revoked' | 'expired' | 'used' | 'final';

export const SCHEME_LABELS: Record<Scheme, string> = { CORE: 'Basislastschrift (CORE)', B2B: 'Firmenlastschrift (B2B)' };
export const KIND_LABELS: Record<MandateKind, string> = { RCUR: 'Wiederkehrend', OOFF: 'Einmalig' };
export const SEQ_LABELS: Record<SeqType, string> = { FRST: 'Erstlastschrift', RCUR: 'Folgelastschrift', OOFF: 'Einmallastschrift', FNAL: 'Letzte Lastschrift' };
export const STATUS_LABELS: Record<MandateStatus, string> = {
  pending: 'Wartet auf Unterschrift',
  active: 'Aktiv',
  suspended: 'Gesperrt',
  revoked: 'Widerrufen',
  expired: 'Abgelaufen',
  used: 'Verbraucht (einmalig)',
  final: 'Beendet (letzte Lastschrift)',
};
export const isScheme = (v: unknown): v is Scheme => v === 'CORE' || v === 'B2B';
export const isKind = (v: unknown): v is MandateKind => v === 'RCUR' || v === 'OOFF';

// --- countries, IBAN, BIC -------------------------------------------------------------------------------------------------

const EEA = 'AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IS IT LI LT LU LV MT NL NO PL PT RO SE SI SK'.split(' ');
/** SEPA countries outside the EEA: the BIC (and the debtor's address) is mandatory there. */
export const NON_EEA = 'AD AL CH GB GG GI IM JE MC MD ME MK SM VA'.split(' ');
export const SEPA_COUNTRIES = new Set([...EEA, ...NON_EEA]);

export { checkBic, checkIban, normalizeIban };
export const normalizeBic = (raw: unknown) => String(raw ?? '').replace(/\s+/g, '').toUpperCase();

export interface IbanInfo {
  ok: boolean;
  iban: string;
  country: string;
  bicRequired: boolean;
  reason?: string;
}

/** Mod-97 check (shared with the invoices) plus: the country takes part in SEPA, and whether a BIC is needed. */
export function ibanInfo(raw: unknown): IbanInfo {
  const iban = normalizeIban(raw);
  const country = iban.slice(0, 2);
  if (!iban) return { ok: false, iban, country, bicRequired: false, reason: 'IBAN fehlt' };
  if (!checkIban(iban)) return { ok: false, iban, country, bicRequired: false, reason: 'Die IBAN ist ungültig (Prüfziffer oder Länge stimmt nicht)' };
  if (!SEPA_COUNTRIES.has(country)) return { ok: false, iban, country, bicRequired: false, reason: `Konten aus ${country} nehmen nicht am SEPA-Lastschriftverfahren teil` };
  return { ok: true, iban, country, bicRequired: NON_EEA.includes(country) };
}

/** "DE89 •••• 3000" – lists and mails never show the whole IBAN. */
export function maskIban(raw: unknown): string {
  const n = normalizeIban(raw);
  return n.length > 8 ? `${n.slice(0, 4)} •••• ${n.slice(-4)}` : n ? '••••' : '';
}

function mod97(s: string): number {
  let r = 0;
  for (const ch of s) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return r;
}

// --- creditor identifier (Gläubiger-ID) -------------------------------------------------------------------------------------

/**
 * Gläubiger-Identifikationsnummer: country, two check digits, three characters business code (not part of the check,
 * "ZZZ" by default), national identifier. Check digits = 98 − mod97(national id + country + "00"), letters A=10 … Z=35.
 * German ids have 18 characters (11 digits at the end), e.g. the Bundesbank's test id DE98ZZZ09999999999.
 */
export function creditorIdCheck(raw: unknown): { valid: boolean; normalized: string; reason?: string } {
  const n = String(raw ?? '').replace(/\s+/g, '').toUpperCase();
  if (!n) return { valid: false, normalized: n, reason: 'Die Gläubiger-ID fehlt' };
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{3}[A-Z0-9]{1,28}$/.test(n)) return { valid: false, normalized: n, reason: 'Format: Länderkennung, 2 Prüfziffern, 3 Zeichen Geschäftsbereich, Kennung (z. B. DE98ZZZ09999999999)' };
  const cc = n.slice(0, 2);
  if (!SEPA_COUNTRIES.has(cc)) return { valid: false, normalized: n, reason: `${cc} nimmt nicht am SEPA-Verfahren teil` };
  if (cc === 'DE' && !/^DE\d{2}[A-Z0-9]{3}\d{11}$/.test(n)) return { valid: false, normalized: n, reason: 'Deutsche Gläubiger-IDs haben 18 Stellen: DE, 2 Prüfziffern, 3 Zeichen, 11 Ziffern' };
  const expected = 98 - mod97(n.slice(7) + cc + '00');
  if (expected !== Number(n.slice(2, 4))) return { valid: false, normalized: n, reason: `Die Prüfziffern der Gläubiger-ID stimmen nicht (erwartet ${String(expected).padStart(2, '0')})` };
  return { valid: true, normalized: n };
}

// --- mandate reference ------------------------------------------------------------------------------------------------------

/** Mandatsreferenz: up to 35 characters of A–Z a–z 0–9 + ? / - : ( ) . , ' – no spaces, no leading "/", no "//". */
export function refCheck(raw: unknown): { valid: boolean; ref: string; reason?: string } {
  const ref = String(raw ?? '').trim();
  if (!ref) return { valid: false, ref, reason: 'Die Mandatsreferenz fehlt' };
  if (ref.length > 35) return { valid: false, ref, reason: 'Die Mandatsreferenz hat höchstens 35 Zeichen' };
  if (!/^[A-Za-z0-9+?/\-:().,']+$/.test(ref)) return { valid: false, ref, reason: "Mandatsreferenz: nur Buchstaben ohne Umlaute, Ziffern und + ? / - : ( ) . , ' – keine Leerzeichen" };
  if (ref.startsWith('/') || ref.includes('//')) return { valid: false, ref, reason: 'Die Mandatsreferenz darf nicht mit „/“ beginnen und kein „//“ enthalten' };
  return { valid: true, ref };
}

export const cleanPrefix = (raw: unknown): string => String(raw ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);

/** M-2026-000001 */
export const makeRef = (prefix: string, year: string, seq: number): string => `${cleanPrefix(prefix)}${year}-${String(Math.max(1, Math.floor(seq))).padStart(6, '0')}`.slice(0, 35);

// --- sequence and lifetime ----------------------------------------------------------------------------------------------------

/**
 * The sequence type of the next collection: OOFF for a one-off mandate, FRST until a collection went to the bank (a returned
 * first collection counts as not used, so the next one is FRST again), then RCUR – or FNAL when the next one is marked as the last.
 */
export function nextSeq(m: { kind: string; final_next?: number | boolean | null }, used: boolean): SeqType {
  if (m.kind === 'OOFF') return 'OOFF';
  if (!used) return 'FRST';
  return m.final_next ? 'FNAL' : 'RCUR';
}

/** Status of the mandate once a collection with this sequence type was submitted. */
export const statusAfter = (seq: SeqType, current: MandateStatus): MandateStatus => (seq === 'OOFF' ? 'used' : seq === 'FNAL' ? 'final' : current);

export const EXPIRY_MONTHS = 36;

export function addMonthsYmd(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** A mandate not used for 36 months expires (SEPA rulebook): counted from the last collection, or the signature if never used. */
export function expiresOn(m: { signed_at?: string | null; last_used_at?: string | null }): string | null {
  const base = String(m.last_used_at || m.signed_at || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(base) ? addMonthsYmd(base, EXPIRY_MONTHS) : null;
}

export function effectiveStatus(m: { status: string; signed_at?: string | null; last_used_at?: string | null }, today: string): MandateStatus {
  if (m.status === 'active') {
    const e = expiresOn(m);
    if (e && e <= today) return 'expired';
  }
  return m.status as MandateStatus;
}

// --- TARGET2 business days ------------------------------------------------------------------------------------------------------

function easterSunday(y: number): string {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Banks only collect on TARGET2 days: Monday–Friday without 1 Jan, Good Friday, Easter Monday, 1 May, 25 and 26 Dec. */
export function isTargetDay(ymd: string): boolean {
  const wd = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  if (['01-01', '05-01', '12-25', '12-26'].includes(ymd.slice(5))) return false;
  const easter = easterSunday(Number(ymd.slice(0, 4)));
  return ymd !== addDaysYmd(easter, -2) && ymd !== addDaysYmd(easter, 1);
}

export function nextTargetDay(ymd: string): string {
  let d = ymd;
  for (let i = 0; i < 14 && !isTargetDay(d); i++) d = addDaysYmd(d, 1);
  return d;
}

export function addTargetDays(ymd: string, n: number): string {
  let d = ymd;
  for (let i = 0; i < n; ) {
    d = addDaysYmd(d, 1);
    if (isTargetDay(d)) i++;
  }
  return d;
}

/**
 * Earliest collection date for a run whose pre-notification goes out today: the agreed lead time, and at least one
 * TARGET2 day for the bank (the file must reach it by D-1) – then the next TARGET2 day.
 */
export function earliestCollection(today: string, leadDays: number): string {
  const lead = addDaysYmd(today, Math.max(1, Math.round(leadDays)));
  const bank = addTargetDays(today, 1);
  return nextTargetDay(lead > bank ? lead : bank);
}

export const isYmd = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

// --- returns (Rücklastschriften) ------------------------------------------------------------------------------------------------

/** ISO reason codes of returns and rejects; `mandate` says what happens to the mandate (suspend = blocked until checked). */
export const RETURN_CODES: Record<string, { label: string; mandate?: 'suspend' | 'revoke' }> = {
  AM04: { label: 'Keine ausreichende Deckung' },
  MD06: { label: 'Erstattung auf Wunsch des Zahlers (Widerspruch)' },
  MS02: { label: 'Zahler hat widersprochen (ohne Angabe von Gründen)' },
  MS03: { label: 'Grund nicht angegeben (Bank)' },
  AC01: { label: 'IBAN fehlerhaft', mandate: 'suspend' },
  AC04: { label: 'Konto erloschen', mandate: 'revoke' },
  AC06: { label: 'Konto gesperrt', mandate: 'suspend' },
  AC13: { label: 'Zahler ist Verbraucher (Firmenlastschrift nicht möglich)', mandate: 'suspend' },
  AG01: { label: 'Lastschrift auf diesem Konto nicht erlaubt', mandate: 'suspend' },
  AG02: { label: 'Ungültiger Zahlungsvorgang' },
  AM05: { label: 'Doppelte Einreichung' },
  BE05: { label: 'Gläubiger unbekannt (Gläubiger-ID prüfen)' },
  MD01: { label: 'Kein gültiges Mandat', mandate: 'revoke' },
  MD02: { label: 'Mandatsdaten fehlen oder sind fehlerhaft', mandate: 'suspend' },
  MD07: { label: 'Zahler verstorben', mandate: 'revoke' },
  RC01: { label: 'BIC fehlerhaft', mandate: 'suspend' },
  RR01: { label: 'Regulatorische Gründe (Konto des Zahlers)' },
  RR02: { label: 'Regulatorische Gründe (Name/Anschrift des Zahlers)' },
  RR03: { label: 'Regulatorische Gründe (Name/Anschrift des Gläubigers)' },
  RR04: { label: 'Regulatorische Gründe' },
  SL01: { label: 'Besondere Dienstleistung der Bank (z. B. Lastschriftsperre)', mandate: 'suspend' },
  CNOR: { label: 'Bank des Gläubigers nicht erreichbar' },
  DNOR: { label: 'Bank des Zahlers nicht erreichbar' },
  FF01: { label: 'Datei ungültig' },
  FOCR: { label: 'Rückruf nach Stornoanfrage' },
};

// --- mandate text -----------------------------------------------------------------------------------------------------------------

export interface MandateTextInput {
  creditor_name: string;
  creditor_address?: string;
  creditor_id: string;
  reference: string;
  scheme: Scheme;
  kind: MandateKind;
  prenotify_days: number;
}

/**
 * The mandate as the debtor agrees to it, in the wording of the German banking industry (Basislastschrift / Firmenlastschrift),
 * with the agreed lead time of the pre-notification – shorter than 14 days only because it says so here.
 */
export function mandateText(i: MandateTextInput): string {
  const c = i.creditor_name.trim() || 'der Zahlungsempfänger';
  const b2b = i.scheme === 'B2B';
  const pay = i.kind === 'OOFF' ? 'eine Zahlung' : 'Zahlungen';
  const out: string[] = [
    b2b ? 'SEPA-Firmenlastschrift-Mandat' : 'SEPA-Lastschriftmandat',
    `Zahlungsempfänger: ${c}${i.creditor_address ? `, ${i.creditor_address}` : ''}\nGläubiger-Identifikationsnummer: ${i.creditor_id}\nMandatsreferenz: ${i.reference}\nZahlungsart: ${i.kind === 'OOFF' ? 'Einmalige Zahlung' : 'Wiederkehrende Zahlungen'}`,
  ];
  if (b2b) {
    out.push(`Ich ermächtige / Wir ermächtigen ${c}, ${pay} von meinem / unserem Konto mittels Lastschrift einzuziehen. Zugleich weise ich mein / weisen wir unser Kreditinstitut an, die von ${c} auf mein / unser Konto gezogenen Lastschriften einzulösen.`);
    out.push('Hinweis: Dieses Lastschriftmandat dient nur dem Einzug von Lastschriften, die auf Konten von Unternehmen gezogen sind. Ich bin / Wir sind nicht berechtigt, nach der erfolgten Einlösung eine Erstattung des belasteten Betrages zu verlangen. Ich bin / Wir sind berechtigt, mein / unser Kreditinstitut bis zum Fälligkeitstag anzuweisen, Lastschriften nicht einzulösen.');
  } else {
    out.push(`Ich ermächtige ${c}, ${pay} von meinem Konto mittels Lastschrift einzuziehen. Zugleich weise ich mein Kreditinstitut an, die von ${c} auf mein Konto gezogenen Lastschriften einzulösen.`);
    out.push('Hinweis: Ich kann innerhalb von acht Wochen, beginnend mit dem Belastungsdatum, die Erstattung des belasteten Betrages verlangen. Es gelten dabei die mit meinem Kreditinstitut vereinbarten Bedingungen.');
  }
  const d = Math.max(1, Math.round(i.prenotify_days));
  out.push(
    d < 14
      ? `Vorabankündigung: Betrag und Fälligkeit jeder Lastschrift werden mindestens ${d} ${d === 1 ? 'Tag' : 'Tage'} vor dem Einzug mitgeteilt; die Frist für die Vorabankündigung wird hiermit auf ${d} ${d === 1 ? 'Tag' : 'Tage'} verkürzt.`
      : `Vorabankündigung: Betrag und Fälligkeit jeder Lastschrift werden mindestens ${d} Tage vor dem Einzug mitgeteilt.`,
  );
  return out.join('\n\n');
}

export const normText = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** SHA-256 of the mandate text (whitespace-insensitive) – part of the proof of an online mandate. */
export const textHash = (text: string) => createHash('sha256').update(normText(text)).digest('hex');

// --- settings ------------------------------------------------------------------------------------------------------------------------

export const DEFAULT_PRENOTIFY_SUBJECT = 'Vorabankündigung: SEPA-Lastschrift am {{due_date}}';
export const DEFAULT_PRENOTIFY_BODY = `Hallo {{contact.first_name|}},

am {{due_date}} ziehen wir {{total}} per SEPA-Lastschrift von deinem Konto {{iban}} ein:

{{items}}

Mandatsreferenz: {{mandate_reference}}
Gläubiger-ID: {{creditor_id}}

Bitte sorge zum Fälligkeitstag für ausreichende Deckung. Bei Fragen antworte einfach auf diese E-Mail.

Viele Grüße
{{location.name}}`;

export interface SepaSettings {
  creditor_id: string;
  /** Empty = the sender name of the invoices (sub-account name). */
  creditor_name: string;
  /** Empty = IBAN/BIC of the invoice settings. */
  iban: string;
  bic: string;
  /** Lead time of the pre-notification in days (SEPA default 14, at least 1 – shorter only by agreement, which the mandate text states). */
  prenotify_days: number;
  prenotify_email: boolean;
  prenotify_subject: string;
  prenotify_body: string;
  mandate_prefix: string;
  /** Book every collection on its own (best for matching the bank statement) or the whole block as one booking. */
  batch_booking: boolean;
  /** Days the link of an online mandate stays valid. */
  capture_days: number;
  default_scheme: Scheme;
  /** Suggested return fee in cents (form default). */
  return_fee_cents: number;
}

export const DEFAULT_SETTINGS: SepaSettings = {
  creditor_id: '',
  creditor_name: '',
  iban: '',
  bic: '',
  prenotify_days: 14,
  prenotify_email: true,
  prenotify_subject: DEFAULT_PRENOTIFY_SUBJECT,
  prenotify_body: DEFAULT_PRENOTIFY_BODY,
  mandate_prefix: 'M-',
  batch_booking: false,
  capture_days: 30,
  default_scheme: 'CORE',
  return_fee_cents: 0,
};

const int = (v: unknown, min: number, max: number, field: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.round(n) !== n) throw new Error(`${field}: bitte eine ganze Zahl`);
  if (n < min || n > max) throw new Error(`${field}: zwischen ${min} und ${max}`);
  return n;
};
const text = (v: unknown, max: number, field: string): string => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw new Error(`${field} ist zu lang (höchstens ${max} Zeichen)`);
  return s;
};

/** Merges a patch into the current settings; throws an Error with a German message on invalid input. */
export function cleanSettings(patch: Record<string, any>, base: SepaSettings = DEFAULT_SETTINGS): SepaSettings {
  const s: SepaSettings = { ...DEFAULT_SETTINGS, ...base };
  const p = patch ?? {};
  if (p.creditor_id !== undefined) {
    const raw = String(p.creditor_id ?? '').trim();
    if (raw) {
      const c = creditorIdCheck(raw);
      if (!c.valid) throw new Error(c.reason);
      s.creditor_id = c.normalized;
    } else s.creditor_id = '';
  }
  if (p.creditor_name !== undefined) s.creditor_name = text(p.creditor_name, 70, 'Name des Zahlungsempfängers');
  if (p.iban !== undefined) {
    const raw = String(p.iban ?? '').trim();
    if (raw) {
      const i = ibanInfo(raw);
      if (!i.ok) throw new Error(`Empfänger-Konto: ${i.reason}`);
      s.iban = i.iban;
    } else s.iban = '';
  }
  if (p.bic !== undefined) {
    const raw = normalizeBic(p.bic);
    if (raw && !checkBic(raw)) throw new Error('Die BIC ist ungültig (8 oder 11 Zeichen)');
    s.bic = raw;
  }
  if (p.prenotify_days !== undefined) s.prenotify_days = int(p.prenotify_days, 1, 60, 'Vorlauf der Vorabankündigung (Tage)');
  if (p.prenotify_email !== undefined) s.prenotify_email = !!p.prenotify_email;
  if (p.prenotify_subject !== undefined) s.prenotify_subject = text(p.prenotify_subject, 200, 'Betreff der Vorabankündigung') || DEFAULT_PRENOTIFY_SUBJECT;
  if (p.prenotify_body !== undefined) s.prenotify_body = text(p.prenotify_body, 5000, 'Text der Vorabankündigung') || DEFAULT_PRENOTIFY_BODY;
  if (p.mandate_prefix !== undefined) s.mandate_prefix = cleanPrefix(p.mandate_prefix);
  if (p.batch_booking !== undefined) s.batch_booking = !!p.batch_booking;
  if (p.capture_days !== undefined) s.capture_days = int(p.capture_days, 1, 365, 'Gültigkeit des Mandats-Links (Tage)');
  if (p.default_scheme !== undefined) {
    if (!isScheme(p.default_scheme)) throw new Error('Lastschriftart: CORE oder B2B');
    s.default_scheme = p.default_scheme;
  }
  if (p.return_fee_cents !== undefined) s.return_fee_cents = int(p.return_fee_cents, 0, 10_000, 'Rücklastschrift-Gebühr (Cent)');
  return s;
}
