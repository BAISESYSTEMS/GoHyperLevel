import { AdsError } from './ads.js';
import { chunks } from './ads-hash.js';
import type { AdSpec } from './ads-manager.js';
import type { RemoteCampaign } from './ads-meta.js';
import type { GoogleAuth } from './ads-store.js';

/**
 * Google Ads API (REST): campaigns are created in ONE atomic `googleAds:mutate` call (budget, campaign, targeting,
 * ad group, keywords, responsive search ad – or the asset group of a Performance Max campaign), all PAUSED, using
 * temporary resource names (-1, -2 …). If any part is refused nothing is created. Plus status, budget, listing,
 * location suggestions and Customer Match uploads.
 */

const BASE = 'https://googleads.googleapis.com';
const TIMEOUT_MS = 30_000;

export interface GoogleApi {
  customerId: string;
  version: string;
  call<T = any>(method: string, path: string, body?: unknown, o?: { customer?: boolean }): Promise<T>;
  /** GAQL query on the customer (all pages). */
  query<T = any>(gaql: string, max?: number): Promise<T[]>;
}

const errorText = (j: any, status: number) => {
  const e = Array.isArray(j) ? j.find((x) => x?.error)?.error : j?.error;
  const details: any[] = Array.isArray(e?.details) ? e.details : [];
  const first = details.flatMap((d) => (Array.isArray(d?.errors) ? d.errors : []))[0];
  const code = first?.errorCode ? Object.values(first.errorCode)[0] : '';
  const known: Record<string, string> = {
    DEVELOPER_TOKEN_NOT_APPROVED: 'Der Developer-Token ist nur für Testkonten freigegeben – Basic-Zugang bei Google beantragen',
    DEVELOPER_TOKEN_PROHIBITED: 'Der Developer-Token ist für dieses Konto nicht erlaubt',
    USER_PERMISSION_DENIED: 'Kein Zugriff auf dieses Google-Ads-Konto (Verwaltungskonto-ID prüfen)',
    CUSTOMER_NOT_ENABLED: 'Das Google-Ads-Konto ist nicht aktiv',
    OAUTH_TOKEN_INVALID: 'Der Google-Zugang ist abgelaufen – bitte neu verbinden',
    OAUTH_TOKEN_REVOKED: 'Der Google-Zugang wurde entzogen – bitte neu verbinden',
    AUTHENTICATION_ERROR: 'Google lehnt die Anmeldung ab – bitte neu verbinden',
    RESOURCE_EXHAUSTED: 'Google drosselt gerade die Anfragen – bitte später noch einmal',
  };
  const hint = known[String(code)] ?? '';
  return `Google Ads: ${hint || first?.message || e?.message || `HTTP ${status}`}${first?.location?.fieldPathElements?.length && !hint ? ` (${first.location.fieldPathElements.map((x: any) => x.fieldName).join('.')})` : ''}`.slice(0, 500);
};

/** GAQL on any customer (all pages, up to `max` rows). */
export async function queryOn(api: GoogleApi, customerId: string, gaql: string, max = 10_000): Promise<any[]> {
  const out: any[] = [];
  let pageToken = '';
  for (let page = 0; page < 50 && out.length < max; page++) {
    const r: any = await api.call('POST', `customers/${customerId}/googleAds:search`, { query: gaql, ...(pageToken ? { pageToken } : {}) });
    out.push(...(Array.isArray(r?.results) ? r.results : []));
    pageToken = String(r?.nextPageToken ?? '');
    if (!pageToken) break;
  }
  return out;
}

export function googleApi(f: typeof fetch, auth: GoogleAuth): GoogleApi {
  const api: GoogleApi = {
    customerId: auth.customerId,
    version: auth.version,
    async call(method, path, body, o = {}) {
      const url = `${BASE}/${auth.version}/${path}`;
      let r: Response;
      try {
        r = await f(url, {
          method,
          headers: {
            authorization: `Bearer ${auth.accessToken}`,
            'developer-token': auth.developerToken,
            'content-type': 'application/json',
            ...(auth.loginCustomerId && o.customer !== false ? { 'login-customer-id': auth.loginCustomerId } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        throw new AdsError(`Google Ads nicht erreichbar: ${(e as Error).message}`);
      }
      const t = await r.text();
      let j: any = {};
      try {
        j = t ? JSON.parse(t) : {};
      } catch {
        throw new AdsError(`Google Ads: Antwort ist kein JSON (HTTP ${r.status})`);
      }
      if (!r.ok || (Array.isArray(j) ? j.some((x) => x?.error) : j?.error)) throw new AdsError(errorText(j, r.status));
      return j;
    },
    query: (gaql, max) => queryOn(api, auth.customerId, gaql, max),
  };
  return api;
}

// --- helpers --------------------------------------------------------------------------------------------------

const micros = (cents: number) => String(Math.round(cents) * 10_000);
const tmp = (cid: string, kind: string, n: number) => `customers/${cid}/${kind}/-${n}`;

/** Google's campaign dates are `yyyy-MM-dd HH:mm:ss` in the account's time zone. */
const dateTime = (d: string | undefined, end: boolean) => (d ? `${d.slice(0, 10)} ${end ? '23:59:59' : '00:00:00'}` : undefined);

const dayCount = (from: string, to: string) => Math.max(1, Math.ceil((Date.parse(`${to.slice(0, 10)}T23:59:59Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 864e5));

/** Google budgets are per day: a total budget is spread over the days of the run. */
export function dailyCents(spec: AdSpec): number {
  if (spec.budget.type === 'daily') return spec.budget.amount_cents;
  const from = spec.schedule.start ?? new Date().toISOString().slice(0, 10);
  return Math.max(1, Math.round(spec.budget.amount_cents / dayCount(from, spec.schedule.end ?? from)));
}

/** Common language constants (id of `languageConstants/<id>`); anything numeric or already a resource name passes through. */
export const LANGUAGES: Record<string, number> = { en: 1000, de: 1001, fr: 1002, es: 1003, it: 1004, ja: 1005, da: 1009, nl: 1010, fi: 1011, ko: 1012, no: 1013, pt: 1014, sv: 1015, cs: 1021, el: 1022, hu: 1024, pl: 1030, ru: 1031, ro: 1032, tr: 1037 };

export function languageConstant(v: string): string | undefined {
  const s = v.trim().toLowerCase();
  if (/^languageconstants\/\d+$/.test(s)) return v.trim();
  if (/^\d{3,5}$/.test(s)) return `languageConstants/${s}`;
  const id = LANGUAGES[s.slice(0, 2)];
  return id ? `languageConstants/${id}` : undefined;
}

const EU_POLITICAL = 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING';

export interface GoogleBuildContext {
  customerId: string;
  finalUrl: string;
  trackingTemplate?: string;
  /** Resource names of Customer Match user lists to add as audiences. */
  userLists?: string[];
  /** Base64 data of the images, by media role (Performance Max). */
  images?: { role: 'marketing' | 'square' | 'logo'; data: string; name: string }[];
  /** Makes budget and asset names unique per account. */
  tag: string;
}

function campaignBase(spec: AdSpec, ctx: GoogleBuildContext, channel: 'SEARCH' | 'PERFORMANCE_MAX') {
  const cid = ctx.customerId;
  const c: Record<string, any> = {
    resourceName: tmp(cid, 'campaigns', 2),
    name: spec.name,
    status: 'PAUSED',
    advertisingChannelType: channel,
    campaignBudget: tmp(cid, 'campaignBudgets', 1),
    containsEuPoliticalAdvertising: EU_POLITICAL,
    geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
  };
  const start = dateTime(spec.schedule.start, false);
  const end = dateTime(spec.schedule.end, true);
  if (start) c.startDateTime = start;
  if (end) c.endDateTime = end;
  if (ctx.trackingTemplate) c.trackingUrlTemplate = ctx.trackingTemplate;
  if (channel === 'SEARCH') {
    // Search only; the partner network and the display network dilute a small budget.
    c.networkSettings = { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false };
    if (spec.max_cpc_cents) c.manualCpc = { enhancedCpcEnabled: false };
    else if (spec.goal === 'traffic') c.targetSpend = {};
    else c.maximizeConversions = {};
  } else {
    c.maximizeConversions = {};
    c.urlExpansionOptOut = false;
  }
  return c;
}

function sharedOps(spec: AdSpec, ctx: GoogleBuildContext, channel: 'SEARCH' | 'PERFORMANCE_MAX') {
  const cid = ctx.customerId;
  const ops: Record<string, any>[] = [
    { campaignBudgetOperation: { create: { resourceName: tmp(cid, 'campaignBudgets', 1), name: `${spec.name} – Budget ${ctx.tag}`, amountMicros: micros(dailyCents(spec)), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
    { campaignOperation: { create: campaignBase(spec, ctx, channel) } },
  ];
  const campaign = tmp(cid, 'campaigns', 2);
  for (const l of spec.audience.locations ?? []) ops.push({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: `geoTargetConstants/${l.key.replace(/^geoTargetConstants\//, '')}` } } } });
  for (const lang of spec.audience.languages ?? []) {
    const lc = languageConstant(lang);
    if (lc) ops.push({ campaignCriterionOperation: { create: { campaign, language: { languageConstant: lc } } } });
  }
  for (const k of spec.audience.negative_keywords ?? []) ops.push({ campaignCriterionOperation: { create: { campaign, negative: true, keyword: { text: k, matchType: 'BROAD' } } } });
  return ops;
}

/** Search campaign: budget, campaign, targeting, ad group, keywords, responsive search ad (+ Customer Match audiences). */
export function searchMutate(spec: AdSpec, ctx: GoogleBuildContext) {
  const cid = ctx.customerId;
  const adGroup = tmp(cid, 'adGroups', 3);
  const ops = sharedOps(spec, ctx, 'SEARCH');
  ops.push({
    adGroupOperation: {
      create: { resourceName: adGroup, name: `${spec.name} – Anzeigengruppe`, campaign: tmp(cid, 'campaigns', 2), status: 'PAUSED', type: 'SEARCH_STANDARD', ...(spec.max_cpc_cents ? { cpcBidMicros: micros(spec.max_cpc_cents) } : {}) },
    },
  });
  for (const k of spec.audience.keywords ?? []) ops.push({ adGroupCriterionOperation: { create: { adGroup, status: 'ENABLED', keyword: { text: k.text, matchType: k.match } } } });
  for (const ul of ctx.userLists ?? []) ops.push({ adGroupCriterionOperation: { create: { adGroup, userList: { userList: ul } } } });
  const c = spec.creative;
  ops.push({
    adGroupAdOperation: {
      create: {
        adGroup,
        status: 'PAUSED',
        ad: {
          finalUrls: [ctx.finalUrl],
          responsiveSearchAd: {
            headlines: (c.headlines ?? []).map((text) => ({ text })),
            descriptions: (c.descriptions ?? []).map((text) => ({ text })),
            ...(c.path1 ? { path1: c.path1 } : {}),
            ...(c.path2 ? { path2: c.path2 } : {}),
          },
        },
      },
    },
  });
  return { mutateOperations: ops, partialFailure: false };
}

const FIELD: Record<string, string> = { marketing: 'MARKETING_IMAGE', square: 'SQUARE_MARKETING_IMAGE', logo: 'LOGO' };

/** Performance Max basics: campaign + asset group with text and image assets. */
export function pmaxMutate(spec: AdSpec, ctx: GoogleBuildContext) {
  const cid = ctx.customerId;
  const assetGroup = tmp(cid, 'assetGroups', 3);
  const ops = sharedOps(spec, ctx, 'PERFORMANCE_MAX');
  const c = spec.creative;
  ops.push({ assetGroupOperation: { create: { resourceName: assetGroup, name: `${spec.name} – Asset-Gruppe`, campaign: tmp(cid, 'campaigns', 2), finalUrls: [ctx.finalUrl], status: 'PAUSED', ...(c.path1 ? { path1: c.path1 } : {}), ...(c.path2 ? { path2: c.path2 } : {}) } } });
  let n = 10;
  const link = (field: string, assetOp: Record<string, any>) => {
    const resourceName = tmp(cid, 'assets', n++);
    ops.push({ assetOperation: { create: { resourceName, ...assetOp } } });
    ops.push({ assetGroupAssetOperation: { create: { assetGroup, asset: resourceName, fieldType: field } } });
  };
  for (const text of c.headlines ?? []) link('HEADLINE', { textAsset: { text } });
  for (const text of c.long_headlines ?? []) link('LONG_HEADLINE', { textAsset: { text } });
  for (const text of c.descriptions ?? []) link('DESCRIPTION', { textAsset: { text } });
  link('BUSINESS_NAME', { textAsset: { text: c.business_name ?? '' } });
  for (const im of ctx.images ?? []) link(FIELD[im.role], { name: `${im.name} ${ctx.tag}`.slice(0, 120), imageAsset: { data: im.data } });
  return { mutateOperations: ops, partialFailure: false };
}

export interface GooglePublished {
  budget: string;
  campaign: string;
  ad_group?: string;
  ad_group_ad?: string;
  asset_group?: string;
  campaign_id: string;
}

/** Resource names of what the atomic mutate created, by kind. */
export function parseMutate(r: any): GooglePublished {
  const out: Record<string, string> = {};
  for (const item of Array.isArray(r?.mutateOperationResponses) ? r.mutateOperationResponses : []) {
    for (const [k, v] of Object.entries(item as Record<string, any>)) {
      const name = String((v as any)?.resourceName ?? '');
      if (!name) continue;
      if (k === 'campaignBudgetResult') out.budget = name;
      else if (k === 'campaignResult') out.campaign = name;
      else if (k === 'adGroupResult') out.ad_group = name;
      else if (k === 'adGroupAdResult') out.ad_group_ad = name;
      else if (k === 'assetGroupResult') out.asset_group = name;
    }
  }
  if (!out.campaign) throw new AdsError('Google Ads hat keine Kampagne angelegt');
  return { budget: out.budget ?? '', campaign: out.campaign, ad_group: out.ad_group, ad_group_ad: out.ad_group_ad, asset_group: out.asset_group, campaign_id: out.campaign.split('/').pop()! };
}

export async function publishGoogle(api: GoogleApi, body: { mutateOperations: Record<string, any>[]; partialFailure: boolean }): Promise<GooglePublished> {
  return parseMutate(await api.call('POST', `customers/${api.customerId}/googleAds:mutate`, body));
}

// --- status & budget -------------------------------------------------------------------------------------------

/** Turns a campaign (and what HyperLevel created below it) on or off. Pausing the campaign alone already stops delivery. */
export function statusMutate(ids: { campaign: string; ad_group?: string; ad_group_ad?: string; asset_group?: string }, status: 'ENABLED' | 'PAUSED') {
  const ops: Record<string, any>[] = [{ campaignOperation: { update: { resourceName: ids.campaign, status }, updateMask: 'status' } }];
  // Switching on also switches on the parts that were created paused.
  if (status === 'ENABLED') {
    if (ids.ad_group) ops.push({ adGroupOperation: { update: { resourceName: ids.ad_group, status }, updateMask: 'status' } });
    if (ids.ad_group_ad) ops.push({ adGroupAdOperation: { update: { resourceName: ids.ad_group_ad, status }, updateMask: 'status' } });
    if (ids.asset_group) ops.push({ assetGroupOperation: { update: { resourceName: ids.asset_group, status }, updateMask: 'status' } });
  }
  return { mutateOperations: ops, partialFailure: false };
}

export const setStatus = (api: GoogleApi, ids: Parameters<typeof statusMutate>[0], status: 'ENABLED' | 'PAUSED') => api.call('POST', `customers/${api.customerId}/googleAds:mutate`, statusMutate(ids, status));

export interface GoogleBudgetTarget {
  resource: string;
  /** Micros. */
  amount: number;
  shared: boolean;
}

export async function budgetTarget(api: GoogleApi, campaignId: string): Promise<GoogleBudgetTarget> {
  const rows = await api.query(`SELECT campaign.id, campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${Number(campaignId)}`);
  const r = rows[0];
  if (!r) throw new AdsError('Kampagne nicht gefunden');
  const resource = String(r.campaign?.campaignBudget ?? r.campaign?.campaign_budget ?? '');
  const b = r.campaignBudget ?? r.campaign_budget ?? {};
  if (!resource) throw new AdsError('Für diese Kampagne ist bei Google kein Budget gesetzt');
  if (b.explicitlyShared ?? b.explicitly_shared) throw new AdsError('Das Budget wird von mehreren Kampagnen geteilt – bitte direkt in Google Ads ändern');
  return { resource, amount: Number(b.amountMicros ?? b.amount_micros ?? 0), shared: false };
}

export const setBudget = (api: GoogleApi, resource: string, dailyCentsValue: number) =>
  api.call('POST', `customers/${api.customerId}/campaignBudgets:mutate`, { operations: [{ update: { resourceName: resource, amountMicros: micros(dailyCentsValue) }, updateMask: 'amount_micros' }] });

const G_STATUS: Record<string, string> = { ENABLED: 'active', PAUSED: 'paused', REMOVED: 'deleted' };

export async function listCampaigns(api: GoogleApi): Promise<RemoteCampaign[]> {
  const rows = await api.query(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, campaign_budget.period FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.id`);
  return rows.map((r) => {
    const c = r.campaign ?? {};
    const b = r.campaignBudget ?? r.campaign_budget ?? {};
    const amount = Number(b.amountMicros ?? b.amount_micros ?? 0);
    return {
      id: String(c.id),
      name: String(c.name ?? '').slice(0, 300),
      status: G_STATUS[String(c.status)] ?? 'other',
      raw_status: String(c.status ?? ''),
      objective: String(c.advertisingChannelType ?? c.advertising_channel_type ?? ''),
      budget_cents: amount ? Math.round(amount / 10_000) : null,
      budget_type: amount ? ('daily' as const) : null,
    };
  });
}

// --- account discovery ------------------------------------------------------------------------------------------

export interface GoogleCustomer {
  id: string;
  name: string;
  manager: boolean;
  currency: string;
  time_zone: string;
  test: boolean;
  /** Child account of the agency's manager account. */
  via_mcc?: boolean;
}

/** Accounts the login can reach, plus the clients of the agency's manager account when one is configured. */
export async function discoverCustomers(api: GoogleApi, loginCustomerId?: string): Promise<GoogleCustomer[]> {
  const list = await api.call<any>('GET', 'customers:listAccessibleCustomers', undefined, { customer: false });
  const out = new Map<string, GoogleCustomer>();
  for (const rn of Array.isArray(list?.resourceNames) ? list.resourceNames : []) {
    const cid = String(rn).split('/').pop()!;
    if (!/^\d{10}$/.test(cid)) continue;
    try {
      const rows = await queryOn(api, cid, 'SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code, customer.time_zone, customer.test_account FROM customer');
      const c = rows[0]?.customer ?? {};
      out.set(cid, { id: cid, name: String(c.descriptiveName ?? c.descriptive_name ?? `Konto ${cid}`), manager: !!c.manager, currency: String(c.currencyCode ?? c.currency_code ?? 'EUR'), time_zone: String(c.timeZone ?? c.time_zone ?? ''), test: !!(c.testAccount ?? c.test_account) });
    } catch {
      // Not reachable without the manager account's login id, or not enabled: still offered by id.
      out.set(cid, { id: cid, name: `Konto ${cid}`, manager: false, currency: 'EUR', time_zone: '', test: false });
    }
  }
  if (loginCustomerId && /^\d{10}$/.test(loginCustomerId)) {
    try {
      const rows = await queryOn(api, loginCustomerId, `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.currency_code, customer_client.time_zone, customer_client.status, customer_client.test_account FROM customer_client WHERE customer_client.level = 1 AND customer_client.status = 'ENABLED'`);
      for (const r of rows) {
        const c = r.customerClient ?? r.customer_client ?? {};
        const cid = String(c.id ?? '');
        if (!/^\d{10}$/.test(cid) || (c.manager ?? false)) continue;
        out.set(cid, { id: cid, name: String(c.descriptiveName ?? c.descriptive_name ?? `Konto ${cid}`), manager: false, currency: String(c.currencyCode ?? c.currency_code ?? 'EUR'), time_zone: String(c.timeZone ?? c.time_zone ?? ''), test: !!(c.testAccount ?? c.test_account), via_mcc: true });
      }
    } catch {
      /* the list of accessible accounts above still works */
    }
  }
  return [...out.values()].filter((c) => !c.manager).sort((a, b) => a.name.localeCompare(b.name));
}

export async function suggestLocations(api: GoogleApi, q: string, country?: string) {
  const r = await api.call<any>('POST', 'geoTargetConstants:suggest', { locale: 'de', ...(country ? { countryCode: country.toUpperCase() } : {}), locationNames: { names: [q] } }, { customer: false });
  return (Array.isArray(r?.geoTargetConstantSuggestions) ? r.geoTargetConstantSuggestions : [])
    .map((s: any) => s.geoTargetConstant ?? {})
    .filter((g: any) => g.id)
    .map((g: any) => ({ type: 'geo' as const, key: String(g.id), name: String(g.canonicalName ?? g.name ?? g.id), country: g.countryCode ? String(g.countryCode).toUpperCase() : undefined, kind: String(g.targetType ?? '') }));
}

// --- Customer Match ----------------------------------------------------------------------------------------------

/**
 * Creates a customer list and uploads hashed members. `consent` states that these people agreed to ads based on
 * their data (required by Google for the EEA and the UK); the caller makes the advertiser confirm it.
 */
export async function uploadCustomerMatch(api: GoogleApi, o: { name: string; description: string; members: Record<string, any>[][] }): Promise<{ userList: string; job: string; sent: number }> {
  const cid = api.customerId;
  const created = await api.call<any>('POST', `customers/${cid}/userLists:mutate`, {
    operations: [{ create: { name: o.name.slice(0, 120), description: o.description.slice(0, 200), membershipLifeSpan: 540, crmBasedUserList: { uploadKeyType: 'CONTACT_INFO', dataSourceType: 'FIRST_PARTY' } } }],
  });
  const userList = String(created?.results?.[0]?.resourceName ?? '');
  if (!userList) throw new AdsError('Google hat die Kundenliste nicht angelegt');
  const r = await appendCustomerMatch(api, userList, o.members);
  return { userList, ...r };
}

/** Adds members to an existing customer list (one offline user data job). */
export async function appendCustomerMatch(api: GoogleApi, userList: string, members: Record<string, any>[][]): Promise<{ job: string; sent: number }> {
  const cid = api.customerId;
  const job = await api.call<any>('POST', `customers/${cid}/offlineUserDataJobs:create`, {
    job: { type: 'CUSTOMER_MATCH_USER_LIST', customerMatchUserListMetadata: { userList, consent: { adUserData: 'GRANTED', adPersonalization: 'GRANTED' } } },
  });
  const jobName = String(job?.resourceName ?? '');
  if (!jobName) throw new AdsError('Google hat den Upload nicht gestartet');
  let sent = 0;
  for (const batch of chunks(members, 2000)) {
    await api.call('POST', `${jobName}:addOperations`, { operations: batch.map((userIdentifiers) => ({ create: { userIdentifiers } })), enablePartialFailure: true });
    sent += batch.length;
  }
  await api.call('POST', `${jobName}:run`, {});
  return { job: jobName, sent };
}

export const removeUserList = (api: GoogleApi, resource: string) => api.call('POST', `customers/${api.customerId}/userLists:mutate`, { operations: [{ remove: resource }] });
