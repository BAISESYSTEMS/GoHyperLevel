import { EU_COUNTRIES, type AdSpec, type GeoTarget } from './ads-manager.js';
import { AdsError } from './ads.js';
import { META_SCHEMA } from './ads-hash.js';
import { MetaApiError, graphCall, type FetchLike } from './meta.js';

/**
 * Meta Marketing API (Graph API): the payloads of the three levels campaign → ad set → ad (+ creative), audiences,
 * instant forms, targeting search and the calls that change a running campaign. Everything is created PAUSED.
 * The builders are pure functions (tested against the payloads); `metaApi` does the HTTP.
 */

export interface MetaApi {
  call<T = any>(method: string, path: string, body?: unknown): Promise<T>;
}

/** Graph errors become AdsError, so the ads manager treats Meta and Google alike. */
export function metaApi(f: FetchLike, version: string, token: string, timeoutMs = 30_000): MetaApi {
  return {
    async call(method, path, body) {
      try {
        return await graphCall(f, version, token, method, path, body, timeoutMs);
      } catch (e) {
        if (e instanceof MetaApiError) throw new AdsError(adsHint(e));
        throw e;
      }
    },
  };
}

/** Meta's text plus what usually helps with the ads-specific codes. */
function adsHint(e: MetaApiError): string {
  const code = e.code;
  if (code === 200 || code === 10 || code === 283) return `${e.message} – dem Zugang fehlt eine Berechtigung (ads_management bzw. Seitenrechte); neu verbinden und alle Rechte erlauben`;
  if (code === 2635 || code === 2690) return `${e.message} – das Werbekonto ist deaktiviert oder gesperrt`;
  if (code === 17 || code === 80004 || code === 613) return 'Meta drosselt gerade die Anfragen – bitte in ein paar Minuten noch einmal';
  if (code === 2667 || code === 3858081) return `${e.message} – für Ziele in der EU braucht Meta Angaben zu Begünstigtem und Zahler`;
  if (code === 190) return 'Der Meta-Zugang ist abgelaufen oder wurde entzogen – bitte unter Anzeigen → Verbindungen neu verbinden';
  return e.message;
}

// --- mapping ------------------------------------------------------------------------------------------

export const META_OBJECTIVE: Record<string, string> = { leads: 'OUTCOME_LEADS', traffic: 'OUTCOME_TRAFFIC', conversions: 'OUTCOME_SALES', reach: 'OUTCOME_AWARENESS' };

export interface MetaContext {
  pageId: string;
  pageName?: string;
  pixelId?: string;
  accountName?: string;
  currency: string;
  /** Minor units per whole unit (100 for EUR). */
  divisor: number;
  link: string;
  urlTags?: string;
  /** Platform ids of the custom audiences / lookalikes. */
  audiences?: string[];
  excluded?: string[];
  imageHash?: string;
  thumbnailHash?: string;
  videoId?: string;
  /** Platform id of the instant form (kind lead_form). */
  leadFormId?: string;
}

export function campaignPayload(spec: AdSpec) {
  return {
    name: spec.name,
    objective: META_OBJECTIVE[spec.goal],
    status: 'PAUSED',
    buying_type: 'AUCTION',
    special_ad_categories: [] as string[],
    // Budgets live on the ad set; Meta wants the choice stated explicitly when the campaign has no budget of its own.
    is_adset_budget_sharing_enabled: false,
  };
}

/** How the ad set optimises: the goal's mapping onto Meta's optimisation goal, destination and promoted object. */
export function optimisation(spec: AdSpec, ctx: Pick<MetaContext, 'pageId' | 'pixelId'>) {
  if (spec.goal === 'leads' && spec.kind === 'lead_form') return { optimization_goal: 'LEAD_GENERATION', destination_type: 'ON_AD', promoted_object: { page_id: ctx.pageId } };
  if (spec.goal === 'leads') return { optimization_goal: 'OFFSITE_CONVERSIONS', destination_type: 'WEBSITE', promoted_object: { pixel_id: ctx.pixelId, custom_event_type: spec.conversion_event ?? 'LEAD' } };
  if (spec.goal === 'conversions') return { optimization_goal: 'OFFSITE_CONVERSIONS', destination_type: 'WEBSITE', promoted_object: { pixel_id: ctx.pixelId, custom_event_type: spec.conversion_event ?? 'PURCHASE' } };
  if (spec.goal === 'reach') return { optimization_goal: 'REACH', destination_type: 'WEBSITE' };
  return { optimization_goal: 'LINK_CLICKS', destination_type: 'WEBSITE' };
}

const radiusKm = (l: GeoTarget) => {
  const km = l.unit === 'mile' ? (l.radius ?? 25) * 1.609 : (l.radius ?? 25);
  return Math.min(80, Math.max(17, Math.round(km)));
};

export function targetingOf(spec: AdSpec, ctx: Pick<MetaContext, 'audiences' | 'excluded'>) {
  const a = spec.audience;
  const geo: Record<string, any> = {};
  const countries = new Set<string>(a.countries ?? []);
  const regions: any[] = [];
  const cities: any[] = [];
  const zips: any[] = [];
  for (const l of a.locations ?? []) {
    if (l.type === 'country') countries.add(l.key.toUpperCase());
    else if (l.type === 'region') regions.push({ key: l.key });
    else if (l.type === 'city') cities.push({ key: l.key, radius: radiusKm(l), distance_unit: 'kilometer' });
    else if (l.type === 'zip') zips.push({ key: l.key });
  }
  if (countries.size) geo.countries = [...countries];
  if (regions.length) geo.regions = regions;
  if (cities.length) geo.cities = cities;
  if (zips.length) geo.zips = zips;
  const t: Record<string, any> = {
    geo_locations: geo,
    age_min: a.age_min ?? 18,
    age_max: a.age_max ?? 65,
    // Targeting is set by hand here: Advantage+ audience off, so the age range and interests are kept as typed.
    targeting_automation: { advantage_audience: 0 },
  };
  if (a.genders?.length === 1) t.genders = [a.genders[0] === 'male' ? 1 : 2];
  if (a.interests?.length) t.flexible_spec = [{ interests: a.interests.map((i) => ({ id: i.id, name: i.name })) }];
  if (ctx.audiences?.length) t.custom_audiences = ctx.audiences.map((id) => ({ id }));
  if (ctx.excluded?.length) t.excluded_custom_audiences = ctx.excluded.map((id) => ({ id }));
  return t;
}

export const targetsEu = (spec: AdSpec) =>
  (spec.audience.countries ?? []).some((c) => EU_COUNTRIES.includes(c)) || (spec.audience.locations ?? []).some((l) => (l.country ? EU_COUNTRIES.includes(l.country) : l.type !== 'country' || EU_COUNTRIES.includes(l.key.toUpperCase())));

/** Start/end as ISO instants: a plain date starts at 00:00 and ends at 23:59 UTC of that day. */
const instant = (d: string | undefined, end: boolean) => (d ? (d.length === 10 ? `${d}T${end ? '23:59:00' : '00:00:00'}+0000` : d) : undefined);

export function adsetPayload(spec: AdSpec, campaignId: string, ctx: MetaContext) {
  const opt = optimisation(spec, ctx);
  const amount = Math.round((spec.budget.amount_cents / 100) * ctx.divisor);
  const p: Record<string, any> = {
    name: `${spec.name} – Anzeigengruppe`,
    campaign_id: campaignId,
    status: 'PAUSED',
    billing_event: 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    ...opt,
    ...(spec.budget.type === 'daily' ? { daily_budget: amount } : { lifetime_budget: amount }),
    targeting: targetingOf(spec, ctx),
  };
  const start = instant(spec.schedule.start, false);
  const end = instant(spec.schedule.end, true);
  if (start) p.start_time = start;
  if (end) p.end_time = end;
  if (targetsEu(spec)) {
    p.dsa_beneficiary = spec.dsa?.beneficiary || ctx.pageName || ctx.accountName || '';
    p.dsa_payor = spec.dsa?.payor || spec.dsa?.beneficiary || ctx.pageName || ctx.accountName || '';
  }
  return p;
}

export function creativePayload(spec: AdSpec, ctx: MetaContext) {
  const c = spec.creative;
  const cta = c.cta || (spec.kind === 'lead_form' ? 'SIGN_UP' : 'LEARN_MORE');
  const value = spec.kind === 'lead_form' ? { lead_gen_form_id: ctx.leadFormId, link: ctx.link } : { link: ctx.link };
  const call_to_action = { type: cta, value };
  const story: Record<string, any> = { page_id: ctx.pageId };
  if (ctx.videoId) {
    story.video_data = {
      video_id: ctx.videoId,
      message: c.primary_text,
      title: c.headline,
      ...(c.description ? { link_description: c.description } : {}),
      ...(ctx.thumbnailHash ? { image_hash: ctx.thumbnailHash } : {}),
      call_to_action,
    };
  } else {
    story.link_data = {
      message: c.primary_text,
      link: ctx.link,
      name: c.headline,
      ...(c.description ? { description: c.description } : {}),
      image_hash: ctx.imageHash,
      call_to_action,
    };
  }
  return { name: `${spec.name} – Creative`, object_story_spec: story, ...(ctx.urlTags ? { url_tags: ctx.urlTags } : {}) };
}

export const adPayload = (spec: AdSpec, adsetId: string, creativeId: string) => ({ name: `${spec.name} – Anzeige`, adset_id: adsetId, creative: { creative_id: creativeId }, status: 'PAUSED' });

// --- publishing ----------------------------------------------------------------------------------------

export interface MetaPublished {
  campaign_id: string;
  adset_id: string;
  creative_id: string;
  ad_id: string;
  image_hash?: string;
  video_id?: string;
}

export interface MediaFile {
  kind: 'image' | 'video';
  /** Image bytes (base64) – or, for a video, the public address Meta fetches it from. */
  base64?: string;
  url?: string;
  name: string;
  /** Marks the image that is only a video's thumbnail. */
  thumbnail?: boolean;
}

const idOf = (r: any, what: string): string => {
  const v = String(r?.id ?? '');
  if (!v) throw new AdsError(`Meta hat keine ${what}-ID geliefert`);
  return v;
};

export async function uploadImage(api: MetaApi, adAccountId: string, base64: string): Promise<string> {
  const r = await api.call<any>('POST', `act_${adAccountId}/adimages`, { bytes: base64 });
  const hash = Object.values(r?.images ?? {}).map((x: any) => x?.hash).find(Boolean);
  if (!hash) throw new AdsError('Meta hat das Bild nicht angenommen');
  return String(hash);
}

export async function uploadVideo(api: MetaApi, adAccountId: string, url: string, name: string, sleep: (ms: number) => Promise<void>): Promise<string> {
  const r = await api.call<any>('POST', `act_${adAccountId}/advideos`, { file_url: url, name: name.slice(0, 100) });
  const video = idOf(r, 'Video');
  // Meta processes the file first; a creative with an unfinished video is refused.
  for (let i = 0; i < 24; i++) {
    const s = await api.call<any>('GET', `${video}?fields=status`);
    const st = String(s?.status?.video_status ?? '');
    if (st === 'ready') return video;
    if (st === 'error') throw new AdsError('Meta konnte das Video nicht verarbeiten');
    await sleep(5000);
  }
  throw new AdsError('Das Video wird bei Meta noch verarbeitet – bitte in ein paar Minuten noch einmal veröffentlichen');
}

/**
 * Creates campaign, ad set, creative and ad – all PAUSED. When a step fails, what was created before is deleted
 * again (best effort), so a failed publish leaves nothing behind in the ad account.
 */
export async function publishMeta(api: MetaApi, adAccountId: string, spec: AdSpec, ctx: MetaContext, media: { image?: MediaFile; video?: MediaFile; thumbnail?: MediaFile }, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<MetaPublished> {
  const created: string[] = [];
  const out: Partial<MetaPublished> = {};
  try {
    const c: MetaContext = { ...ctx };
    if (media.image?.base64) c.imageHash = out.image_hash = await uploadImage(api, adAccountId, media.image.base64);
    if (media.thumbnail?.base64) c.thumbnailHash = await uploadImage(api, adAccountId, media.thumbnail.base64);
    if (media.video?.url) c.videoId = out.video_id = await uploadVideo(api, adAccountId, media.video.url, media.video.name, sleep);
    if (!c.imageHash && !c.videoId) throw new AdsError('Bild oder Video fehlt');
    out.campaign_id = idOf(await api.call('POST', `act_${adAccountId}/campaigns`, campaignPayload(spec)), 'Kampagnen');
    created.push(out.campaign_id);
    out.adset_id = idOf(await api.call('POST', `act_${adAccountId}/adsets`, adsetPayload(spec, out.campaign_id, c)), 'Anzeigengruppen');
    out.creative_id = idOf(await api.call('POST', `act_${adAccountId}/adcreatives`, creativePayload(spec, c)), 'Creative');
    out.ad_id = idOf(await api.call('POST', `act_${adAccountId}/ads`, adPayload(spec, out.adset_id, out.creative_id)), 'Anzeigen');
    return out as MetaPublished;
  } catch (e) {
    // Deleting the campaign removes its ad sets and ads with it.
    for (const id of created.reverse()) await api.call('DELETE', id).catch(() => undefined);
    throw e;
  }
}

// --- status, budget ----------------------------------------------------------------------------------

export const setStatus = (api: MetaApi, id: string, status: 'ACTIVE' | 'PAUSED') => api.call('POST', id, { status });

export interface MetaBudgetTarget {
  /** Where the budget lives: an ad set (or the campaign itself with a campaign budget). */
  id: string;
  kind: 'campaign' | 'adset';
  type: 'daily' | 'lifetime';
  /** Minor units. */
  amount: number;
}

/** The one place a campaign's budget lives; refuses campaigns with several budgets (ask the person to use Meta). */
export async function budgetTarget(api: MetaApi, campaignId: string): Promise<MetaBudgetTarget> {
  const c = await api.call<any>('GET', `${campaignId}?fields=daily_budget,lifetime_budget`);
  if (Number(c?.daily_budget) > 0) return { id: campaignId, kind: 'campaign', type: 'daily', amount: Number(c.daily_budget) };
  if (Number(c?.lifetime_budget) > 0) return { id: campaignId, kind: 'campaign', type: 'lifetime', amount: Number(c.lifetime_budget) };
  const sets = await api.call<any>('GET', `${campaignId}/adsets?fields=id,daily_budget,lifetime_budget,effective_status&limit=25`);
  const live = (Array.isArray(sets?.data) ? sets.data : []).filter((s: any) => s.effective_status !== 'ARCHIVED' && s.effective_status !== 'DELETED');
  if (live.length !== 1) throw new AdsError(live.length ? 'Die Kampagne hat mehrere Anzeigengruppen mit eigenem Budget – bitte direkt in Meta ändern' : 'Die Kampagne hat keine Anzeigengruppe');
  const s = live[0];
  if (Number(s.daily_budget) > 0) return { id: s.id, kind: 'adset', type: 'daily', amount: Number(s.daily_budget) };
  if (Number(s.lifetime_budget) > 0) return { id: s.id, kind: 'adset', type: 'lifetime', amount: Number(s.lifetime_budget) };
  throw new AdsError('Für diese Kampagne ist bei Meta kein Budget gesetzt');
}

export const setBudget = (api: MetaApi, t: MetaBudgetTarget, minorUnits: number) => api.call('POST', t.id, t.type === 'daily' ? { daily_budget: minorUnits } : { lifetime_budget: minorUnits });

export interface RemoteCampaign {
  id: string;
  name: string;
  /** active | paused | ended | deleted | other */
  status: string;
  raw_status: string;
  objective: string;
  budget_cents: number | null;
  budget_type: 'daily' | 'lifetime' | null;
}

const META_STATUS: Record<string, string> = { ACTIVE: 'active', PAUSED: 'paused', CAMPAIGN_PAUSED: 'paused', ADSET_PAUSED: 'paused', ARCHIVED: 'deleted', DELETED: 'deleted', WITH_ISSUES: 'active', IN_PROCESS: 'active', PENDING_REVIEW: 'active' };

export async function listCampaigns(api: MetaApi, adAccountId: string, divisor = 100): Promise<RemoteCampaign[]> {
  const out: RemoteCampaign[] = [];
  let after = '';
  for (let page = 0; page < 20; page++) {
    const r = await api.call<any>('GET', `act_${adAccountId}/campaigns?fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    for (const c of Array.isArray(r?.data) ? r.data : []) {
      const raw = String(c.effective_status || c.status || '');
      const daily = Number(c.daily_budget) > 0;
      const life = Number(c.lifetime_budget) > 0;
      out.push({
        id: String(c.id),
        name: String(c.name ?? '').slice(0, 300),
        status: META_STATUS[raw] ?? 'other',
        raw_status: raw,
        objective: String(c.objective ?? ''),
        budget_cents: daily || life ? Math.round((Number(daily ? c.daily_budget : c.lifetime_budget) / divisor) * 100) : null,
        budget_type: daily ? 'daily' : life ? 'lifetime' : null,
      });
    }
    after = String(r?.paging?.next ? (r?.paging?.cursors?.after ?? '') : '');
    if (!after) break;
  }
  return out;
}

// --- account discovery (after the login) ------------------------------------------------------------------

export interface MetaOptions {
  user: { id: string; name: string };
  ad_accounts: { id: string; name: string; currency: string; status: string; business: string }[];
  pages: { id: string; name: string; token: string }[];
}

const ACCOUNT_STATUS: Record<number, string> = { 1: 'aktiv', 2: 'deaktiviert', 3: 'Zahlung offen', 7: 'wird geprüft', 8: 'Zahlungsfrist', 9: 'Nachfrist', 100: 'wird geschlossen', 101: 'geschlossen', 201: 'beliebig aktiv', 202: 'beliebig geschlossen' };

export async function discover(api: MetaApi): Promise<MetaOptions> {
  const me = await api.call<any>('GET', 'me?fields=id,name');
  const accounts = await api.call<any>('GET', 'me/adaccounts?fields=account_id,name,currency,account_status,business{name}&limit=100').catch(() => ({ data: [] }));
  const pages = await api.call<any>('GET', 'me/accounts?fields=id,name,access_token&limit=100').catch(() => ({ data: [] }));
  return {
    user: { id: String(me?.id ?? ''), name: String(me?.name ?? '') },
    ad_accounts: (Array.isArray(accounts?.data) ? accounts.data : []).map((a: any) => ({ id: String(a.account_id ?? '').replace(/^act_/, ''), name: String(a.name ?? ''), currency: String(a.currency ?? 'EUR'), status: ACCOUNT_STATUS[Number(a.account_status)] ?? 'unbekannt', business: String(a.business?.name ?? '') })).filter((a: any) => a.id),
    pages: (Array.isArray(pages?.data) ? pages.data : []).map((p: any) => ({ id: String(p.id), name: String(p.name ?? ''), token: String(p.access_token ?? '') })),
  };
}

export async function pixels(api: MetaApi, adAccountId: string): Promise<{ id: string; name: string }[]> {
  const r = await api.call<any>('GET', `act_${adAccountId}/adspixels?fields=id,name&limit=50`);
  return (Array.isArray(r?.data) ? r.data : []).map((p: any) => ({ id: String(p.id), name: String(p.name ?? '') }));
}

// --- targeting search ----------------------------------------------------------------------------------------

export async function searchInterests(api: MetaApi, q: string) {
  const r = await api.call<any>('GET', `search?type=adinterest&q=${encodeURIComponent(q)}&limit=25&locale=de_DE`);
  return (Array.isArray(r?.data) ? r.data : []).map((i: any) => ({ id: String(i.id), name: String(i.name ?? ''), path: Array.isArray(i.path) ? i.path.join(' › ') : '', audience: [Number(i.audience_size_lower_bound) || 0, Number(i.audience_size_upper_bound) || 0] }));
}

export async function searchLocations(api: MetaApi, q: string): Promise<GeoTarget[]> {
  const types = encodeURIComponent(JSON.stringify(['country', 'region', 'city', 'zip']));
  const r = await api.call<any>('GET', `search?type=adgeolocation&q=${encodeURIComponent(q)}&location_types=${types}&limit=25&locale=de_DE`);
  return (Array.isArray(r?.data) ? r.data : [])
    .map((l: any): GeoTarget => ({ type: (['country', 'region', 'city', 'zip'].includes(l.type) ? l.type : 'city') as GeoTarget['type'], key: String(l.key ?? ''), name: [l.name, l.region && l.type === 'city' ? l.region : '', l.country_name].filter(Boolean).join(', '), country: l.country_code ? String(l.country_code).toUpperCase() : undefined }))
    .filter((l: GeoTarget) => l.key);
}

// --- audiences ------------------------------------------------------------------------------------------------

export async function createCustomAudience(api: MetaApi, adAccountId: string, name: string, description: string): Promise<string> {
  const r = await api.call('POST', `act_${adAccountId}/customaudiences`, { name: name.slice(0, 100), subtype: 'CUSTOM', description: description.slice(0, 200), customer_file_source: 'USER_PROVIDED_ONLY' });
  return idOf(r, 'Zielgruppen');
}

/** Uploads hashed rows in batches of at most 10 000 (Meta's limit), as one session. */
export async function addUsers(api: MetaApi, audienceId: string, rows: string[][], batch = 10_000): Promise<{ received: number; invalid: number }> {
  let received = 0;
  let invalid = 0;
  const sessionId = Math.floor(Math.random() * 2 ** 31);
  const total = rows.length;
  for (let i = 0, seq = 1; i < rows.length; i += batch, seq++) {
    const slice = rows.slice(i, i + batch);
    const last = i + batch >= rows.length;
    const r = await api.call<any>('POST', `${audienceId}/users`, {
      payload: { schema: [...META_SCHEMA], data: slice },
      session: { session_id: sessionId, batch_seq: seq, last_batch_flag: last, estimated_num_total: total },
    });
    received += Number(r?.num_received ?? slice.length);
    invalid += Number(r?.num_invalid_entries ?? 0);
  }
  return { received, invalid };
}

export async function createLookalike(api: MetaApi, adAccountId: string, o: { name: string; originId: string; country: string; ratio: number }): Promise<string> {
  const ratio = Math.min(0.2, Math.max(0.01, Math.round(o.ratio * 100) / 100));
  const r = await api.call('POST', `act_${adAccountId}/customaudiences`, {
    name: o.name.slice(0, 100),
    subtype: 'LOOKALIKE',
    origin_audience_id: o.originId,
    lookalike_spec: { type: 'custom_ratio', ratio, country: o.country.toUpperCase() },
  });
  return idOf(r, 'Lookalike');
}

export const deleteAudience = (api: MetaApi, id: string) => api.call('DELETE', id);

// --- instant forms (Lead Ads) ---------------------------------------------------------------------------------

export type LeadQuestion = string | { type: 'CUSTOM'; key: string; label: string };
export interface LeadFormSpec {
  name: string;
  headline?: string;
  description?: string;
  questions: LeadQuestion[];
  privacy_url: string;
  thank_you?: { title?: string; body?: string; button_text?: string; url?: string };
  locale?: string;
}

/** Standard questions Meta pre-fills from the person's profile. */
export const STANDARD_QUESTIONS = ['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE', 'CITY', 'ZIP', 'STREET_ADDRESS', 'COMPANY_NAME', 'JOB_TITLE', 'STATE', 'COUNTRY', 'DOB', 'GENDER'];

export function leadFormPayload(f: LeadFormSpec) {
  const p: Record<string, any> = {
    name: f.name.slice(0, 200),
    locale: f.locale || 'DE_DE',
    questions: f.questions.map((q) => (typeof q === 'string' ? { type: q } : { type: 'CUSTOM', key: q.key, label: q.label })),
    privacy_policy: { url: f.privacy_url, link_text: 'Datenschutz' },
    follow_up_action_url: f.thank_you?.url || f.privacy_url,
  };
  if (f.headline || f.description) p.context_card = { title: (f.headline || f.name).slice(0, 60), style: 'PARAGRAPH_STYLE', content: [(f.description || '').slice(0, 500)].filter(Boolean), button_text: 'Weiter' };
  if (f.thank_you?.title || f.thank_you?.body) {
    p.thank_you_page = { title: (f.thank_you.title || 'Danke!').slice(0, 60), body: (f.thank_you.body || '').slice(0, 200), button_type: 'VIEW_WEBSITE', button_text: (f.thank_you.button_text || 'Zur Website').slice(0, 30), website_url: f.thank_you.url || f.privacy_url };
  }
  return p;
}

export async function createLeadForm(api: MetaApi, pageId: string, f: LeadFormSpec): Promise<string> {
  return idOf(await api.call('POST', `${pageId}/leadgen_forms`, leadFormPayload(f)), 'Formular');
}

/** Subscribes the page to the app's `leadgen` webhook, keeping the fields the app already gets (messages …). */
export async function subscribeLeadgen(api: MetaApi, pageId: string, appId?: string): Promise<string[]> {
  const cur = await api.call<any>('GET', `${pageId}/subscribed_apps`).catch(() => ({ data: [] }));
  const mine = (Array.isArray(cur?.data) ? cur.data : []).filter((a: any) => !appId || String(a.id) === appId);
  const fields = [...new Set<string>([...mine.flatMap((a: any) => (Array.isArray(a.subscribed_fields) ? a.subscribed_fields : [])), 'leadgen'])];
  await api.call('POST', `${pageId}/subscribed_apps`, { subscribed_fields: fields.join(',') });
  return fields;
}

export const LEAD_FIELDS = 'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data,platform,is_organic';

export const fetchLead = (api: MetaApi, leadgenId: string) => api.call<any>('GET', `${encodeURIComponent(leadgenId)}?fields=${LEAD_FIELDS}`);

/** Leads of a form created after `sinceUnix` (polling fallback). */
export async function listFormLeads(api: MetaApi, formId: string, sinceUnix: number, max = 500): Promise<any[]> {
  const out: any[] = [];
  const filter = encodeURIComponent(JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix }]));
  let after = '';
  for (let page = 0; page < 10 && out.length < max; page++) {
    const r = await api.call<any>('GET', `${encodeURIComponent(formId)}/leads?fields=${LEAD_FIELDS}&limit=100&filtering=${filter}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    out.push(...(Array.isArray(r?.data) ? r.data : []));
    after = String(r?.paging?.next ? (r?.paging?.cursors?.after ?? '') : '');
    if (!after) break;
  }
  return out;
}

// --- OAuth (Facebook Login) -------------------------------------------------------------------------------------

export const metaAuthorizeUrl = (version: string, o: { appId: string; redirectUri: string; state: string; scopes: string[] }) =>
  `https://www.facebook.com/${version}/dialog/oauth?${new URLSearchParams({ client_id: o.appId, redirect_uri: o.redirectUri, state: o.state, response_type: 'code', scope: o.scopes.join(',') })}`;

async function tokenCall(f: FetchLike, version: string, params: Record<string, string>): Promise<{ access_token: string; expires_in: number }> {
  let r: Response;
  try {
    r = await f(`https://graph.facebook.com/${version}/oauth/access_token?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new AdsError(`Meta nicht erreichbar: ${(e as Error).message}`);
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new AdsError(`Meta: ${j.error?.message ?? `Anmeldung fehlgeschlagen (HTTP ${r.status})`}`.slice(0, 300));
  return { access_token: String(j.access_token), expires_in: Number(j.expires_in) > 0 ? Number(j.expires_in) : 60 * 86400 };
}

/** Authorisation code → short-lived token → long-lived (about 60 days) user token. */
export async function exchangeMetaCode(f: FetchLike, version: string, o: { appId: string; appSecret: string; redirectUri: string; code: string }) {
  const short = await tokenCall(f, version, { client_id: o.appId, client_secret: o.appSecret, redirect_uri: o.redirectUri, code: o.code });
  return extendMetaToken(f, version, { appId: o.appId, appSecret: o.appSecret, token: short.access_token });
}

export const extendMetaToken = (f: FetchLike, version: string, o: { appId: string; appSecret: string; token: string }) =>
  tokenCall(f, version, { grant_type: 'fb_exchange_token', client_id: o.appId, client_secret: o.appSecret, fb_exchange_token: o.token });

/** Permissions the person actually granted (they can untick single ones in the dialog). */
export async function grantedScopes(api: MetaApi): Promise<string[]> {
  const r = await api.call<any>('GET', 'me/permissions');
  return (Array.isArray(r?.data) ? r.data : []).filter((p: any) => p.status === 'granted').map((p: any) => String(p.permission));
}
