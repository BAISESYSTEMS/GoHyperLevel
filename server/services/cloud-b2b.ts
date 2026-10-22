/**
 * B2B-only signup of the hosted service (docs/cloud.md#b2b-only-signup): with `b2b_only` on (the default) the signup needs the
 * company name and either a VAT ID or the confirmation "I order as a business (§ 14 BGB)". Format check only – Stripe Tax
 * validates the VAT ID at checkout when the operator lets it ask for one. Pure.
 */

/** EU VAT IDs (plus CH, GB, NO, XI): country prefix and 2–13 characters. */
export const VAT_ID = /^(AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK|XI|CH|GB|NO)[0-9A-Z+*]{2,13}$/;

export const normalizeVatId = (v: unknown) => String(v ?? '').toUpperCase().replace(/[\s.\-/]/g, '').slice(0, 20);

export interface Business {
  vat_id: string;
  confirmed: boolean;
}

/** `{ error }` to show on the form, or the data to keep with the signup. Off: nothing is asked, a given VAT ID is still kept. */
export function checkBusiness(b: Record<string, unknown>, on: boolean): { error?: string; data?: Business } {
  const vat = normalizeVatId(b.vat_id);
  const confirmed = !!b.business;
  if (vat && !VAT_ID.test(vat)) return { error: 'Die USt-IdNr. sieht nicht gültig aus (Ländercode und Nummer, z. B. DE123456789).' };
  if (on && !vat && !confirmed) return { error: 'Unser Angebot richtet sich nur an Unternehmen: bitte die USt-IdNr. angeben oder bestätigen, dass du als Unternehmen bestellst.' };
  return vat || confirmed ? { data: { vat_id: vat, confirmed } } : {};
}

/** The line for the customer's history. */
export const businessNote = (d: Business) => [d.confirmed ? 'Bestellung als Unternehmen bestätigt (§ 14 BGB)' : '', d.vat_id ? `USt-IdNr. ${d.vat_id}` : ''].filter(Boolean).join(' · ');
