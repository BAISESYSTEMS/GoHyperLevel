import { createHash } from 'node:crypto';

/**
 * Customer lists for Meta Custom Audiences and Google Ads Customer Match: normalisation and SHA-256 exactly
 * as the platforms specify it. Only hashes ever leave the server – never an e-mail address or a phone number.
 *
 *  Meta   (Customer File Custom Audiences, "Customer information parameters"):
 *    EMAIL   trimmed, lower case
 *    PHONE   digits only, with country code, no "+", no leading zeros, no "00"
 *    FN/LN   lower case, no spaces, digits or punctuation (UTF-8 letters stay)
 *    CT      city: lower case, no spaces or punctuation
 *    ZIP     lower case, no spaces or dashes
 *    COUNTRY ISO 3166-1 alpha-2, lower case
 *  Google (Customer Match, "Format and hash data"):
 *    e-mail  trimmed, lower case; in gmail.com / googlemail.com the dots in front of the "@" are removed
 *    phone   E.164 including the leading "+", hashed with it
 *    name    trimmed, lower case; country code and ZIP stay in clear text (only first/last name are hashed)
 */

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const strip = (v: unknown) => String(v ?? '').normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}\d]/gu, '');

// --- Meta --------------------------------------------------------------------------------------

export const metaEmail = (v: unknown): string => {
  const e = String(v ?? '').trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : '';
};

/** Digits with country code. A national number ("0151…") gets `defaultCc` (digits only, e.g. "49"). */
export const metaPhone = (v: unknown, defaultCc = '49'): string => {
  const raw = String(v ?? '').trim();
  if (!raw) return '';
  let d = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) d = d.replace(/^0+/, '');
  else if (d.startsWith('00')) d = d.slice(2).replace(/^0+/, '');
  else if (d.startsWith('0')) d = `${defaultCc}${d.replace(/^0+/, '')}`;
  return d.length >= 8 && d.length <= 15 ? d : '';
};

export const metaName = (v: unknown) => strip(v);
export const metaCity = (v: unknown) => strip(v);
export const metaZip = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/[\s-]/g, '');
export const metaCountry = (v: unknown) => {
  const c = String(v ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(c) ? c : '';
};

export interface ListContact {
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

/** Column order of the upload; a missing value is an empty string (Meta keeps the row if one key matches). */
export const META_SCHEMA = ['EMAIL', 'PHONE', 'FN', 'LN', 'CT', 'ZIP', 'COUNTRY'] as const;

const h = (v: string) => (v ? sha256(v) : '');

/** One row of the upload, or null when the contact has neither a usable e-mail nor a phone number. */
export function metaRow(c: ListContact, defaultCc = '49'): string[] | null {
  const email = metaEmail(c.email);
  const phone = metaPhone(c.phone, defaultCc);
  if (!email && !phone) return null;
  return [h(email), h(phone), h(metaName(c.first_name)), h(metaName(c.last_name)), h(metaCity(c.city)), h(metaZip(c.postal_code)), h(metaCountry(c.country))];
}

// --- Google ------------------------------------------------------------------------------------

export const googleEmail = (v: unknown): string => {
  const e = metaEmail(v);
  if (!e) return '';
  const [local, domain] = e.split('@');
  return domain === 'gmail.com' || domain === 'googlemail.com' ? `${local.replace(/\./g, '')}@${domain}` : e;
};

/** E.164 with "+": "+4915112345678". */
export const googlePhone = (v: unknown, defaultCc = '49'): string => {
  const d = metaPhone(v, defaultCc);
  return d ? `+${d}` : '';
};

const gName = (v: unknown) => String(v ?? '').trim().toLowerCase();

/** UserIdentifier objects of one Customer Match member (REST/JSON field names). */
export function googleIdentifiers(c: ListContact, defaultCc = '49'): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const email = googleEmail(c.email);
  const phone = googlePhone(c.phone, defaultCc);
  if (email) out.push({ hashedEmail: sha256(email) });
  if (phone) out.push({ hashedPhoneNumber: sha256(phone) });
  const fn = gName(c.first_name);
  const ln = gName(c.last_name);
  const zip = String(c.postal_code ?? '').trim();
  const cc = String(c.country ?? '').trim().toUpperCase();
  // Address info only counts with all four parts.
  if (fn && ln && zip && /^[A-Z]{2}$/.test(cc)) out.push({ addressInfo: { hashedFirstName: sha256(fn), hashedLastName: sha256(ln), countryCode: cc, postalCode: zip } });
  return out;
}

/** Splits a long list into the platforms' batch sizes. */
export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
