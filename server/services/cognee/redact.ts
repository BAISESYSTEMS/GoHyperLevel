/**
 * PII minimisation before anything leaves for the memory server: e-mail addresses, phone numbers and IBANs
 * are replaced by a placeholder. Pure functions, no imports. This is a safety net, not anonymisation –
 * names and free text stay (the data-type warnings say so).
 */

export interface RedactCounts {
  email: number;
  phone: number;
  iban: number;
}

export const NO_REDACTION: RedactCounts = { email: 0, phone: 0, iban: 0 };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{2,4}){2,8}\b/g;
// Candidates only; phoneLike() decides. Not glued to words, addresses or dashed numbers (invoice numbers, dates in ISO form).
const PHONE = /(?<![\w@./-])(?:\+|00)?\(?\d[\d ()./-]{5,}\d(?![\w@])/g;
const DATE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/;

/** ISO 13616 check: move the first four characters to the end, letters to numbers (A = 10), modulo 97 must be 1. */
export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

/** A number written like a phone number: international (+49…, 0049…) or national with the leading 0, 7–15 digits, no date. */
export function phoneLike(s: string): boolean {
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  if (DATE.test(s.trim())) return false;
  return /^(\+|00|\(?0)/.test(s);
}

export function redact(text: string): { text: string; counts: RedactCounts } {
  const counts: RedactCounts = { email: 0, phone: 0, iban: 0 };
  let out = String(text ?? '').replace(EMAIL, () => {
    counts.email++;
    return '[E-Mail]';
  });
  out = out.replace(IBAN, (m) => {
    if (!ibanValid(m)) return m;
    counts.iban++;
    return '[IBAN]';
  });
  out = out.replace(PHONE, (m) => {
    if (!phoneLike(m)) return m;
    counts.phone++;
    return '[Telefon]';
  });
  return { text: out, counts };
}

export const addCounts = (a: RedactCounts, b: RedactCounts): RedactCounts => ({ email: a.email + b.email, phone: a.phone + b.phone, iban: a.iban + b.iban });
