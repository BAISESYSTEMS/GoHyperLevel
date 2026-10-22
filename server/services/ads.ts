import { createHash } from 'node:crypto';

/**
 * Read-only ad reporting: Meta Marketing API insights and Google Ads (GAQL searchStream), mapped
 * to one row per campaign and day. Plus the Meta Conversions API payload (hashed e-mail/phone).
 * Every call takes a `fetcher` so tests (and nothing else) can swap the network out.
 */

export const META_API_VERSION = 'v23.0';
export const GOOGLE_ADS_API_VERSION = 'v21';
const TIMEOUT_MS = 20_000;

export interface AdsDay {
  campaign_id: string;
  campaign_name: string;
  date: string;
  spend_cents: number;
  impressions: number;
  clicks: number;
  leads: number;
  currency: string;
}

export class AdsError extends Error {}

const int = (v: unknown) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const version = (v: unknown, fallback: string, re: RegExp) => (re.test(String(v ?? '')) ? String(v) : fallback);

async function readJson(r: Response): Promise<any> {
  const t = await r.text();
  try {
    return t ? JSON.parse(t) : {};
  } catch {
    throw new AdsError(`Antwort ist kein JSON (HTTP ${r.status})`);
  }
}

// --- Meta ----------------------------------------------------------------------------------------

/** Lead actions Meta reports; "lead" already sums pixel and on-Facebook leads, so it wins. */
export function metaLeads(actions: unknown): number {
  const list = Array.isArray(actions) ? actions : [];
  const get = (t: string) => int(list.find((a: any) => a?.action_type === t)?.value);
  return get('lead') || get('onsite_conversion.lead_grouped') + get('offsite_conversion.fb_pixel_lead');
}

export function mapMetaRow(r: any): AdsDay {
  return {
    campaign_id: String(r.campaign_id ?? ''),
    campaign_name: String(r.campaign_name ?? '').slice(0, 300),
    date: String(r.date_start ?? '').slice(0, 10),
    spend_cents: Math.round((Number(r.spend) || 0) * 100),
    impressions: int(r.impressions),
    clicks: int(r.clicks),
    leads: metaLeads(r.actions),
    currency: String(r.account_currency || 'EUR').toUpperCase(),
  };
}

export async function fetchMetaInsights(fetcher: typeof fetch, o: { token: string; adAccountId: string; since: string; until: string; version?: string }): Promise<AdsDay[]> {
  const v = version(o.version, META_API_VERSION, /^v\d{1,2}\.\d$/);
  const params = new URLSearchParams({
    level: 'campaign',
    fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions,account_currency',
    time_increment: '1',
    time_range: JSON.stringify({ since: o.since, until: o.until }),
    limit: '500',
    access_token: o.token,
  });
  let url: string | undefined = `https://graph.facebook.com/${v}/act_${encodeURIComponent(o.adAccountId)}/insights?${params}`;
  const out: AdsDay[] = [];
  for (let page = 0; url && page < 50; page++) {
    const r = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const j = await readJson(r);
    if (!r.ok || j.error) throw new AdsError(`Meta: ${j.error?.message ?? `HTTP ${r.status}`}`);
    for (const row of Array.isArray(j.data) ? j.data : []) if (row?.campaign_id && row?.date_start) out.push(mapMetaRow(row));
    const next: string = j.paging?.next ?? '';
    url = next.startsWith('https://graph.facebook.com/') ? next : undefined;
  }
  return out;
}

// --- Google Ads ------------------------------------------------------------------------------------

export async function googleAccessToken(fetcher: typeof fetch, o: { client_id: string; client_secret: string; refresh_token: string }): Promise<string> {
  const r = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: o.client_id, client_secret: o.client_secret, refresh_token: o.refresh_token }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await readJson(r);
  if (!r.ok || !j.access_token) throw new AdsError(`Google OAuth: ${j.error_description || j.error || `HTTP ${r.status}`}`);
  return String(j.access_token);
}

export function mapGoogleRow(r: any): AdsDay {
  const m = r.metrics ?? {};
  return {
    campaign_id: String(r.campaign?.id ?? ''),
    campaign_name: String(r.campaign?.name ?? '').slice(0, 300),
    date: String(r.segments?.date ?? '').slice(0, 10),
    spend_cents: Math.round((Number(m.costMicros ?? m.cost_micros) || 0) / 10_000),
    impressions: int(m.impressions),
    clicks: int(m.clicks),
    leads: int(m.conversions),
    currency: String(r.customer?.currencyCode || 'EUR').toUpperCase(),
  };
}

const googleError = (j: any, status: number) => {
  const e = Array.isArray(j) ? j.find((x) => x?.error)?.error : j?.error;
  const detail = e?.details?.[0]?.errors?.[0]?.message;
  return new AdsError(`Google Ads: ${detail || e?.message || `HTTP ${status}`}`);
};

export async function fetchGoogleAds(
  fetcher: typeof fetch,
  o: { developerToken: string; accessToken: string; customerId: string; loginCustomerId?: string; since: string; until: string; version?: string },
): Promise<AdsDay[]> {
  const v = version(o.version, GOOGLE_ADS_API_VERSION, /^v\d{1,3}$/);
  const query = `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, customer.currency_code FROM campaign WHERE segments.date BETWEEN '${o.since}' AND '${o.until}'`;
  const r = await fetcher(`https://googleads.googleapis.com/${v}/customers/${o.customerId}/googleAds:searchStream`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${o.accessToken}`,
      'developer-token': o.developerToken,
      'content-type': 'application/json',
      ...(o.loginCustomerId ? { 'login-customer-id': o.loginCustomerId } : {}),
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await readJson(r);
  if (!r.ok || (Array.isArray(j) ? j.some((x) => x?.error) : j?.error)) throw googleError(j, r.status);
  const batches = Array.isArray(j) ? j : [j];
  return batches.flatMap((b: any) => (Array.isArray(b?.results) ? b.results : [])).map(mapGoogleRow).filter((d) => d.campaign_id && d.date);
}

// --- Meta Conversions API ------------------------------------------------------------------------------

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Meta's normalisation: e-mail trimmed and lower case; phone digits only with country code, no + or 00. */
export const normEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();
export const normPhone = (p: unknown) => String(p ?? '').replace(/\D/g, '').replace(/^00/, '');
/** Names: lower case, no spaces, digits or punctuation; umlauts stay (UTF-8, as Meta asks). */
export const normName = (n: unknown) => String(n ?? '').trim().toLowerCase().normalize('NFC').replace(/[\s\p{P}\p{S}\d]/gu, '');

export interface CapiInput {
  eventName: 'Lead' | 'Purchase';
  eventId: string;
  eventTime: Date;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
  fbclid?: string;
  fbclidAt?: Date;
  sourceUrl?: string;
  value?: number;
  currency?: string;
}

/** One server event; personal data only as SHA-256 hashes, fbc built from the ad click id. */
export function capiEvent(i: CapiInput) {
  const user: Record<string, unknown> = {};
  if (normEmail(i.email)) user.em = [sha(normEmail(i.email))];
  if (normPhone(i.phone)) user.ph = [sha(normPhone(i.phone))];
  if (normName(i.firstName)) user.fn = [sha(normName(i.firstName))];
  if (normName(i.lastName)) user.ln = [sha(normName(i.lastName))];
  if (i.externalId) user.external_id = [sha(i.externalId)];
  if (i.fbclid) user.fbc = `fb.1.${(i.fbclidAt ?? i.eventTime).getTime()}.${i.fbclid}`;
  return {
    event_name: i.eventName,
    event_time: Math.floor(i.eventTime.getTime() / 1000),
    event_id: i.eventId,
    action_source: 'system_generated',
    ...(i.sourceUrl ? { event_source_url: i.sourceUrl } : {}),
    user_data: user,
    ...(i.eventName === 'Purchase' ? { custom_data: { value: Math.round((i.value ?? 0) * 100) / 100, currency: (i.currency || 'EUR').toUpperCase() } } : {}),
  };
}

export async function sendCapi(fetcher: typeof fetch, o: { pixelId: string; token: string; events: unknown[]; testCode?: string; version?: string }): Promise<{ events_received: number }> {
  const v = version(o.version, META_API_VERSION, /^v\d{1,2}\.\d$/);
  const r = await fetcher(`https://graph.facebook.com/${v}/${encodeURIComponent(o.pixelId)}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: o.events, access_token: o.token, ...(o.testCode ? { test_event_code: o.testCode } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await readJson(r);
  if (!r.ok || j.error) throw new AdsError(`Meta CAPI: ${j.error?.message ?? `HTTP ${r.status}`}`);
  return { events_received: Number(j.events_received ?? 0) };
}
