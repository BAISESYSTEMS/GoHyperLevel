import { createHash, createPrivateKey, createSign } from 'node:crypto';
import { dedupeKey, type BankTxn } from './acc-bank.js';

/**
 * Bank sync through Enable Banking (https://enablebanking.com/docs/api/reference/): a licensed PSD2 access provider
 * that reaches nearly every German bank and Sparkasse. The agency registers one application (ID + RSA private key,
 * the public certificate stays with Enable Banking); a sub-account connects its bank with the bank's own login (SCA)
 * and gets read access to balances and booked transactions for up to 180 days. Nothing here can move money.
 *
 * - Auth: a short-lived JWT (RS256, header kid = application ID, iss enablebanking.com, aud api.enablebanking.com).
 * - POST /auth → url (the bank's login) · redirect back with ?code&state · POST /sessions {code} → session + accounts.
 * - GET /accounts/{uid}/transactions?date_from&continuation_key · GET /accounts/{uid}/balances · DELETE /sessions/{id}.
 * Without the account holder present a bank answers at most four times a day (PSD2), so the background sync runs every
 * 8 hours; a click on „Jetzt abrufen“ sends the person's IP and browser, which makes it a request with the holder present.
 */

export const EB_BASE = 'https://api.enablebanking.com';
/** Longest consent we ask for (PSD2 allows 180 days); a bank's own maximum is respected. */
export const MAX_CONSENT_DAYS = 180;
/** How far back the first sync reads when nothing was imported before (most banks give 90 days without a new login). */
export const FIRST_SYNC_DAYS = 89;

export interface EbCreds {
  appId: string;
  privateKey: string;
}

export interface EbAspsp {
  name: string;
  country: string;
  logo?: string;
  bic?: string;
  beta?: boolean;
  psu_types?: string[];
  /** Seconds. */
  maximum_consent_validity?: number;
}

export interface EbAccount {
  uid: string;
  account_id?: { iban?: string; other?: { identification?: string } };
  all_account_ids?: { identification?: string; scheme_name?: string }[];
  name?: string;
  details?: string;
  product?: string;
  currency?: string;
  cash_account_type?: string;
}

export class BankSyncError extends Error {
  constructor(
    message: string,
    public status: number,
    public code = '',
  ) {
    super(message);
  }
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** The bearer token for one call (valid one hour; Enable Banking accepts at most 24). */
export function ebJwt(c: EbCreds, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: c.appId }));
  const body = b64u(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: nowSec, exp: nowSec + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(createPrivateKey(c.privateKey));
  return `${head}.${body}.${b64u(sig)}`;
}

/** null when the text is an RSA private key in PEM form, else what is wrong with it. */
export function checkPrivateKey(pem: string): string | null {
  try {
    const k = createPrivateKey(pem);
    return k.asymmetricKeyType === 'rsa' ? null : 'Der Schlüssel muss ein RSA-Schlüssel sein (Enable Banking erzeugt ihn so)';
  } catch {
    return 'Das ist kein gültiger privater Schlüssel – bitte die ganze .pem-Datei einfügen (-----BEGIN PRIVATE KEY----- …)'; // oss-check: allow (hint text, no key)
  }
}

export const isAppId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** The consent at the bank ended (expired, revoked or closed): the bank has to be connected again. */
const isExpired = (status: number, j: any) => status !== 401 && /EXPIRED|CLOSED_SESSION|REVOKED|session.*(expired|closed|revoked)/i.test(`${j?.error ?? ''} ${j?.code ?? ''} ${j?.message ?? ''} ${j?.detail ?? ''}`);

function errorText(status: number, j: any): string {
  const detail = String(j?.message || j?.detail || j?.error_description || j?.error || '').slice(0, 200);
  if (status === 401) return 'Enable Banking lehnt den Zugang ab – App-ID und privaten Schlüssel der Agentur prüfen';
  if (status === 429) return 'Die Bank erlaubt gerade keinen weiteren Abruf (ohne dich höchstens vier am Tag) – später noch einmal';
  if (isExpired(status, j)) return 'Die Freigabe bei der Bank ist abgelaufen oder wurde widerrufen – bitte die Bank neu verbinden';
  return `Enable Banking (${status})${detail ? `: ${detail}` : ''}`;
}

/** Headers that mark a request as made with the account holder present (no daily limit at the bank). */
export const psuHeaders = (ip: string, userAgent: string): Record<string, string> => (ip ? { 'Psu-Ip-Address': ip, 'Psu-User-Agent': userAgent.slice(0, 300) || 'HyperLevel' } : {});

export function ebClient(f: typeof fetch, c: EbCreds) {
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    let r: Response;
    try {
      r = await f(`${EB_BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${ebJwt(c)}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new BankSyncError(`Enable Banking ist nicht erreichbar (${(e as Error).message})`, 502);
    }
    const text = await r.text();
    let j: any = {};
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      j = { message: text.slice(0, 200) };
    }
    if (!r.ok) throw new BankSyncError(errorText(r.status, j), r.status, isExpired(r.status, j) ? 'EXPIRED' : String(j?.error ?? j?.code ?? ''));
    return j;
  };
  return {
    aspsps: async (country: string): Promise<EbAspsp[]> => ((await call('GET', `/aspsps?country=${encodeURIComponent(country)}&service=AIS`)).aspsps ?? []) as EbAspsp[],
    startAuth: (b: { aspsp: { name: string; country: string }; validUntil: string; state: string; redirectUrl: string; psuType: 'business' | 'personal'; language?: string }) =>
      call('POST', '/auth', { access: { valid_until: b.validUntil }, aspsp: b.aspsp, state: b.state, redirect_url: b.redirectUrl, psu_type: b.psuType, ...(b.language ? { language: b.language } : {}) }) as Promise<{ url: string; authorization_id?: string }>,
    createSession: (code: string) => call('POST', '/sessions', { code }) as Promise<{ session_id: string; accounts: EbAccount[]; aspsp?: { name: string; country: string }; psu_type?: string; access?: { valid_until?: string } }>,
    deleteSession: (sessionId: string) => call('DELETE', `/sessions/${encodeURIComponent(sessionId)}`),
    balances: (uid: string, headers?: Record<string, string>) => call('GET', `/accounts/${encodeURIComponent(uid)}/balances`, undefined, headers),
    transactions: (uid: string, q: { date_from: string; date_to?: string; continuation_key?: string }, headers?: Record<string, string>) =>
      call('GET', `/accounts/${encodeURIComponent(uid)}/transactions?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])}`, undefined, headers) as Promise<{ transactions?: any[]; continuation_key?: string | null }>,
  };
}
export type EbClient = ReturnType<typeof ebClient>;

/** The IBAN of an account (or its other identification, e.g. for a credit card). */
export const accountIban = (a: EbAccount): string =>
  String(a.account_id?.iban || a.all_account_ids?.find((x) => /iban/i.test(x.scheme_name ?? ''))?.identification || a.account_id?.other?.identification || '')
    .replace(/\s+/g, '')
    .toUpperCase()
    .slice(0, 34);

const cents = (v: unknown): number => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : NaN;
};
const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}/.test(String(v ?? '')) ? String(v).slice(0, 10) : '');

export type SyncedTxn = BankTxn & { ref: string };

/** One Enable Banking transaction as a bank line of the accounting (null: still pending, or no amount or date). */
export function mapTransaction(t: any, iban: string): SyncedTxn | null {
  if (!t || (t.status && t.status !== 'BOOK')) return null;
  const amount = cents(t.transaction_amount?.amount);
  const booking = day(t.booking_date) || day(t.value_date) || day(t.transaction_date);
  if (!amount || Number.isNaN(amount) || !booking) return null;
  const incoming = t.credit_debit_indicator !== 'DBIT';
  const party = incoming ? t.debtor : t.creditor;
  const partyAcc = incoming ? t.debtor_account : t.creditor_account;
  const info = Array.isArray(t.remittance_information) ? t.remittance_information.join(' ') : String(t.remittance_information ?? '');
  const purpose = (info || t.note || t.bank_transaction_code?.description || '').replace(/\s+/g, ' ').trim();
  const ref = String(t.entry_reference || t.transaction_id || '').slice(0, 64);
  return {
    booking_date: booking,
    value_date: day(t.value_date) || booking,
    amount_cents: incoming ? amount : -amount,
    currency: String(t.transaction_amount?.currency || 'EUR').toUpperCase().slice(0, 3),
    counterparty: String(party?.name ?? '').trim().slice(0, 200),
    counterparty_iban: String(partyAcc?.iban ?? partyAcc?.other?.identification ?? '').replace(/\s+/g, '').toUpperCase().slice(0, 34),
    purpose: purpose.slice(0, 500),
    end_to_end_id: String(t.end_to_end_id ?? t.end_to_end_identification ?? '').replace(/^NOTPROVIDED$/i, '').slice(0, 64),
    bank_ref: ref,
    account_iban: iban,
    ref,
  };
}

/**
 * Keys for a batch of synced lines: a line with the bank's own reference is keyed by account and reference (stable across
 * reconnects – the account's uid is not), the others like a file import (identical lines within the batch are numbered).
 */
export function syncKeys(txns: SyncedTxn[], accountKey: string): string[] {
  const seen = new Map<string, number>();
  return txns.map((t) => {
    if (t.ref) return createHash('sha256').update(JSON.stringify(['eb', accountKey, t.ref])).digest('hex').slice(0, 40);
    const base = dedupeKey(t, 0);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : dedupeKey(t, n);
  });
}

/** The booked balance of an account in cents (closing booked, else expected or available), or null. */
export function pickBalance(balances: any[] | undefined): { cents: number; currency: string; at: string } | null {
  const list = Array.isArray(balances) ? balances : [];
  const order = ['CLBD', 'ITBD', 'XPCD', 'ITAV', 'CLAV', 'OPBD'];
  const rank = (t: unknown) => {
    const i = order.indexOf(String(t));
    return i < 0 ? 99 : i;
  };
  const b = [...list].sort((x, y) => rank(x.balance_type) - rank(y.balance_type))[0];
  if (!b) return null;
  const n = Number(b.balance_amount?.amount);
  if (!Number.isFinite(n)) return null;
  return { cents: Math.round(n * 100), currency: String(b.balance_amount?.currency || 'EUR').toUpperCase().slice(0, 3), at: String(b.reference_date || b.last_change_date_time || '').slice(0, 25) };
}

/** Days → ISO date (UTC) relative to `from`. */
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => isoDay(new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400_000));
