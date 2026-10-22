import type { App } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { ACCOUNT_SID, E164 } from './twilio.js';

/**
 * Buying and releasing phone numbers through the connected Twilio account: the request parameters, the mapping of
 * Twilio's answers and the German explanation of the regulatory rules (address and bundle). The calls themselves go
 * through `app.services.twilioFetch` (the test hook) – tests never reach Twilio. No database here.
 */

export const NUMBER_TYPES = { local: 'Local', mobile: 'Mobile', toll_free: 'TollFree' } as const;
export type NumberType = keyof typeof NUMBER_TYPES;
export const NUMBER_TYPE_LABEL: Record<NumberType, string> = { local: 'Ortsnummer', mobile: 'Mobilnummer', toll_free: 'Gebührenfrei' };
export const ADDRESS_SID = /^AD[0-9a-fA-F]{32}$/;
export const BUNDLE_SID = /^BU[0-9a-fA-F]{32}$/;
export const COUNTRY = /^[A-Z]{2}$/;

export interface AvailableNumber {
  phone_number: string;
  friendly_name: string;
  locality: string;
  region: string;
  postal_code: string;
  country: string;
  type: NumberType;
  /** Twilio: none = no address needed; any/local/foreign = an address of that kind is needed before the number can be bought. */
  address_requirements: 'none' | 'any' | 'local' | 'foreign';
  beta: boolean;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
}

/** The query of a search ("Vorwahl 30", "enthält 1234"); only what Twilio understands and what we validated. */
export function searchParams(o: { area_code?: string; contains?: string; limit?: number }): [string, string][] {
  const p: [string, string][] = [['VoiceEnabled', 'true'], ['PageSize', String(Math.min(Math.max(1, Math.round(o.limit ?? 20)), 50))]];
  const area = String(o.area_code ?? '').replace(/\D/g, '').slice(0, 6);
  if (area) p.push(['AreaCode', area]);
  const contains = String(o.contains ?? '').replace(/[^0-9*]/g, '').slice(0, 15);
  if (contains) p.push(['Contains', contains]);
  return p;
}

const asReq = (v: unknown): AvailableNumber['address_requirements'] => (v === 'any' || v === 'local' || v === 'foreign' ? v : 'none');

/** Twilio's `available_phone_numbers` as our list. */
export function mapAvailable(j: any, type: NumberType): AvailableNumber[] {
  return (Array.isArray(j?.available_phone_numbers) ? j.available_phone_numbers : [])
    .filter((n: any) => E164.test(String(n?.phone_number ?? '')))
    .map((n: any) => ({
      phone_number: String(n.phone_number),
      friendly_name: String(n.friendly_name ?? n.phone_number),
      locality: String(n.locality ?? ''),
      region: String(n.region ?? ''),
      postal_code: String(n.postal_code ?? ''),
      country: String(n.iso_country ?? ''),
      type,
      address_requirements: asReq(n.address_requirements),
      beta: !!n.beta,
      capabilities: { voice: !!(n.capabilities?.voice ?? n.capabilities?.Voice), sms: !!(n.capabilities?.SMS ?? n.capabilities?.sms), mms: !!(n.capabilities?.MMS ?? n.capabilities?.mms) },
    }));
}

/** Monthly prices from Twilio's pricing API ("1,15 US-Dollar") for the number types of a country; null when unknown. */
export function mapPricing(j: any): { currency: string; prices: Record<string, string> } | null {
  const list: any[] = Array.isArray(j?.phone_number_prices) ? j.phone_number_prices : [];
  if (!list.length) return null;
  const prices: Record<string, string> = {};
  for (const p of list) {
    const t = String(p?.number_type ?? '').toLowerCase().replace(/\s+/g, '_');
    const key = t === 'toll_free' || t === 'tollfree' ? 'toll_free' : t;
    if (key && p?.current_price != null) prices[key] = String(p.current_price);
  }
  return { currency: String(j?.price_unit ?? 'USD'), prices };
}

export interface CountryRule {
  address: boolean;
  bundle: boolean;
  text: string;
}
/**
 * What Twilio asks for before it hands out numbers in some countries. Twilio changes this now and then, so the search
 * result's own `address_requirements` wins; this table only explains it in German and tells the user what to prepare.
 */
export const COUNTRY_RULES: Record<string, CountryRule> = {
  DE: {
    address: true,
    bundle: true,
    text: 'Für Rufnummern in Deutschland verlangt Twilio (nach den Regeln der Bundesnetzagentur) eine Adresse in Deutschland und ein genehmigtes „Regulatory Bundle“ mit Nachweisen (Handelsregisterauszug oder Gewerbeanmeldung bzw. Ausweis und Adressnachweis). Beides legst du einmal in der Twilio-Konsole an (Phone Numbers → Regulatory Compliance); die Prüfung dauert meist einige Werktage. Danach wählst du hier Adresse und Bundle aus.',
  },
  AT: { address: true, bundle: true, text: 'Für österreichische Rufnummern verlangt Twilio eine Adresse und ein genehmigtes „Regulatory Bundle“. Beides legst du in der Twilio-Konsole an (Phone Numbers → Regulatory Compliance).' },
  CH: { address: true, bundle: true, text: 'Für Schweizer Rufnummern verlangt Twilio eine Adresse und ein genehmigtes „Regulatory Bundle“. Beides legst du in der Twilio-Konsole an (Phone Numbers → Regulatory Compliance).' },
};
export const regulatoryRule = (country: string): CountryRule | null => COUNTRY_RULES[country.toUpperCase()] ?? null;

export const CONSOLE = { addresses: 'https://console.twilio.com/us1/develop/phone-numbers/manage/addresses', bundles: 'https://console.twilio.com/us1/develop/phone-numbers/regulatory-compliance/bundles' };

/** Twilio error codes that mean "an address or a regulatory bundle is missing or not accepted". */
const REGULATORY_CODES = new Set([21631, 21632, 21649, 21650, 21651, 21652, 21653, 21655]);

/** German explanation for a failed purchase, or null when the error has nothing to do with regulation. */
export function regulatoryError(code: unknown, message: string, country: string): string | null {
  const c = Number(code);
  if (!REGULATORY_CODES.has(c) && !/\b(address|bundle|regulat)/i.test(message)) return null;
  const rule = regulatoryRule(country);
  return `Twilio verkauft diese Nummer erst, wenn die gesetzlichen Nachweise stimmen (${message.replace(/^Twilio:\s*/, '')}). ${rule?.text ?? 'Lege Adresse und Regulatory Bundle in der Twilio-Konsole an (Phone Numbers → Regulatory Compliance) und wähle sie hier aus.'}`;
}

// --- requests -------------------------------------------------------------------------------------------------------

const HOSTS = { api: 'https://api.twilio.com', pricing: 'https://pricing.twilio.com', numbers: 'https://numbers.twilio.com' } as const;
export type TwilioHost = keyof typeof HOSTS;

/** One Twilio REST call to one of the three fixed hosts with the sub-account's credentials. Never follows a user-supplied URL. */
export async function twilioHostRequest(app: App, cfg: { accountSid: string; token: string }, host: TwilioHost, method: string, path: string, query?: [string, string][]): Promise<any> {
  if (!ACCOUNT_SID.test(cfg.accountSid) || !cfg.token) throw new HttpError(400, 'Twilio-Zugangsdaten fehlen (Einstellungen → Telefonie)');
  const fetcher: typeof fetch = app.services.twilioFetch ?? fetch;
  const qs = query?.length ? `?${new URLSearchParams(query)}` : '';
  const r = await fetcher(`${HOSTS[host]}${path}${qs}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.token}`).toString('base64')}` },
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, `Twilio: ${j.message || `Fehler ${r.status}`}`, { twilio_code: j.code ?? null });
  return j;
}

export interface TwilioAddress {
  sid: string;
  name: string;
  street: string;
  city: string;
  postal_code: string;
  country: string;
  validated: boolean;
  verified: boolean;
}
export interface TwilioBundle {
  sid: string;
  name: string;
  status: string;
  approved: boolean;
  country: string;
  type: string;
  valid_until: string | null;
}

/** Addresses of the account (for the purchase of a regulated number). */
export function mapAddresses(j: any): TwilioAddress[] {
  return (Array.isArray(j?.addresses) ? j.addresses : []).map((a: any) => ({
    sid: String(a.sid),
    name: String(a.friendly_name || a.customer_name || ''),
    street: String(a.street ?? ''),
    city: String(a.city ?? ''),
    postal_code: String(a.postal_code ?? ''),
    country: String(a.iso_country ?? ''),
    validated: !!a.validated,
    verified: !!a.verified,
  }));
}

/** Regulatory bundles of the account. Only an approved one can buy a number. */
export function mapBundles(j: any): TwilioBundle[] {
  return (Array.isArray(j?.results) ? j.results : []).map((b: any) => ({
    sid: String(b.sid),
    name: String(b.friendly_name ?? ''),
    status: String(b.status ?? ''),
    approved: b.status === 'twilio-approved',
    country: String(b.iso_country ?? ''),
    type: String(b.number_type ?? ''),
    valid_until: b.valid_until ? String(b.valid_until) : null,
  }));
}
