/**
 * Google Business Profile APIs with an OAuth access token (scope business.manage): accounts and
 * locations (Account Management / Business Information v1), reviews with replies and local posts
 * (My Business v4). Google must approve Business Profile API access for the Cloud project first.
 */

const ACCOUNTS = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const INFO = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const V4 = 'https://mybusiness.googleapis.com/v4';

export const STAR: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
export const CTA_TYPES = ['LEARN_MORE', 'BOOK', 'ORDER', 'SHOP', 'SIGN_UP', 'CALL'] as const;
export type CtaType = (typeof CTA_TYPES)[number];
export const CTA_LABEL: Record<CtaType, string> = { LEARN_MORE: 'Mehr erfahren', BOOK: 'Buchen', ORDER: 'Bestellen', SHOP: 'Kaufen', SIGN_UP: 'Registrieren', CALL: 'Anrufen' };

export const isAccountName = (s: unknown) => typeof s === 'string' && /^accounts\/[0-9]{1,30}$/.test(s);
export const isLocationName = (s: unknown) => typeof s === 'string' && /^locations\/[0-9]{1,30}$/.test(s);

export class BusinessError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

type TokenFn = (force?: boolean) => Promise<string>;

export interface GbpLocation {
  name: string;
  title: string;
  address: string;
  place_id: string;
  maps_url: string;
  new_review_url: string;
}
export interface GbpReview {
  name: string;
  review_id: string;
  author: string;
  author_photo: string;
  rating: number;
  text: string;
  published_at: string | null;
  updated_at: string | null;
  reply_text: string;
  reply_at: string | null;
}

const iso = (s: unknown) => (s && !Number.isNaN(Date.parse(String(s))) ? new Date(String(s)).toISOString() : null);

export function normalizeReview(r: any): GbpReview | null {
  const rating = STAR[String(r?.starRating ?? '')] ?? 0;
  if (!rating || !r?.name) return null;
  // Google appends the translation to non-German comments: "(Translated by Google) … (Original) …" – keep the original.
  let text = String(r.comment ?? '');
  const orig = text.match(/\(Original\)\s*([\s\S]+)$/);
  if (orig) text = orig[1].trim();
  return {
    name: String(r.name).slice(0, 300),
    review_id: String(r.reviewId ?? String(r.name).split('/').pop()),
    author: r.reviewer?.isAnonymous ? 'Google-Nutzer' : String(r.reviewer?.displayName ?? '').slice(0, 200) || 'Google-Nutzer',
    author_photo: /^https:\/\//.test(String(r.reviewer?.profilePhotoUrl ?? '')) ? String(r.reviewer.profilePhotoUrl) : '',
    rating,
    text: text.slice(0, 5000),
    published_at: iso(r.createTime),
    updated_at: iso(r.updateTime),
    reply_text: String(r.reviewReply?.comment ?? '').slice(0, 4096),
    reply_at: iso(r.reviewReply?.updateTime),
  };
}

export function formatAddress(a: any): string {
  if (!a) return '';
  return [...(a.addressLines ?? []), [a.postalCode, a.locality].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

export interface LocalPostInput {
  summary: string;
  image_url?: string;
  cta_type?: CtaType | '';
  cta_url?: string;
}

export function localPostBody(p: LocalPostInput) {
  return {
    languageCode: 'de',
    summary: p.summary,
    topicType: 'STANDARD',
    ...(p.cta_type ? { callToAction: { actionType: p.cta_type, ...(p.cta_type !== 'CALL' && p.cta_url ? { url: p.cta_url } : {}) } } : {}),
    ...(p.image_url ? { media: [{ mediaFormat: 'PHOTO', sourceUrl: p.image_url }] } : {}),
  };
}

export function businessApi(fetcher: typeof fetch, token: TokenFn) {
  async function req(url: string, init: { method?: string; body?: unknown } = {}, allow: number[] = []) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await token(attempt > 0);
      let r: Response;
      try {
        r = await fetcher(url, {
          method: init.method ?? 'GET',
          headers: { authorization: `Bearer ${t}`, accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
      } catch (e) {
        throw new BusinessError(`Google nicht erreichbar: ${(e as Error).message}`, 0);
      }
      if (r.status === 401 && attempt === 0) continue;
      const j: any = r.status === 204 ? {} : await r.json().catch(() => ({}));
      if (r.ok || allow.includes(r.status)) return { status: r.status, json: j };
      const msg = String(j?.error?.message ?? `Fehler ${r.status}`);
      if (r.status === 403 && /has not been used|disabled|not been enabled|PERMISSION_DENIED/i.test(`${msg} ${j?.error?.status ?? ''}`))
        throw new BusinessError(`Google Unternehmensprofil: kein API-Zugriff (${msg.slice(0, 160)}) – die Business Profile APIs müssen für das Cloud-Projekt freigeschaltet sein`, 403);
      throw new BusinessError(`Google Unternehmensprofil: ${msg.slice(0, 300)}`, r.status);
    }
    throw new BusinessError('Google Unternehmensprofil: Anmeldung abgelehnt', 401);
  }
  const path = (account: string, location: string) => {
    if (!isAccountName(account) || !isLocationName(location)) throw new BusinessError('Unternehmensprofil: Standort nicht gewählt', 400);
    return `${V4}/${account}/${location}`;
  };

  return {
    async listAccounts(): Promise<{ name: string; title: string; type: string }[]> {
      const { json } = await req(`${ACCOUNTS}/accounts?pageSize=20`);
      return (json.accounts ?? []).filter((a: any) => isAccountName(a.name)).map((a: any) => ({ name: a.name, title: String(a.accountName ?? a.name), type: String(a.type ?? '') }));
    },
    async listLocations(account: string): Promise<GbpLocation[]> {
      if (!isAccountName(account)) throw new BusinessError('Unternehmensprofil: Konto ungültig', 400);
      const out: GbpLocation[] = [];
      let page = '';
      for (let i = 0; i < 5; i++) {
        const q = new URLSearchParams({ readMask: 'name,title,storefrontAddress,metadata', pageSize: '100', ...(page ? { pageToken: page } : {}) });
        const { json } = await req(`${INFO}/${account}/locations?${q}`);
        for (const l of json.locations ?? []) {
          if (!isLocationName(l.name)) continue;
          out.push({
            name: l.name,
            title: String(l.title ?? '').slice(0, 300),
            address: formatAddress(l.storefrontAddress).slice(0, 500),
            place_id: /^[A-Za-z0-9_-]{10,300}$/.test(String(l.metadata?.placeId ?? '')) ? String(l.metadata.placeId) : '',
            maps_url: /^https:\/\//.test(String(l.metadata?.mapsUri ?? '')) ? String(l.metadata.mapsUri) : '',
            new_review_url: /^https:\/\//.test(String(l.metadata?.newReviewUri ?? '')) ? String(l.metadata.newReviewUri) : '',
          });
        }
        page = json.nextPageToken ?? '';
        if (!page) break;
      }
      return out;
    },
    /** Newest reviews first (up to `max`), plus the profile's average and count. */
    async listReviews(account: string, location: string, max = 200) {
      const reviews: GbpReview[] = [];
      let page = '';
      let averageRating: number | null = null;
      let totalReviewCount: number | null = null;
      for (let i = 0; i < Math.ceil(max / 50); i++) {
        const q = new URLSearchParams({ pageSize: '50', orderBy: 'updateTime desc', ...(page ? { pageToken: page } : {}) });
        const { json } = await req(`${path(account, location)}/reviews?${q}`);
        if (typeof json.averageRating === 'number') averageRating = Math.round(json.averageRating * 10) / 10;
        if (Number.isFinite(Number(json.totalReviewCount))) totalReviewCount = Number(json.totalReviewCount);
        for (const r of json.reviews ?? []) {
          const n = normalizeReview(r);
          if (n) reviews.push(n);
        }
        page = json.nextPageToken ?? '';
        if (!page || reviews.length >= max) break;
      }
      return { reviews: reviews.slice(0, max), averageRating, totalReviewCount };
    },
    async reply(account: string, location: string, reviewId: string, comment: string): Promise<{ comment: string; updated_at: string | null }> {
      const { json } = await req(`${path(account, location)}/reviews/${encodeURIComponent(reviewId)}/reply`, { method: 'PUT', body: { comment } });
      return { comment: String(json.comment ?? comment), updated_at: iso(json.updateTime) };
    },
    async deleteReply(account: string, location: string, reviewId: string): Promise<void> {
      await req(`${path(account, location)}/reviews/${encodeURIComponent(reviewId)}/reply`, { method: 'DELETE' }, [404]);
    },
    async createPost(account: string, location: string, p: LocalPostInput): Promise<{ name: string; state: string; search_url: string }> {
      const { json } = await req(`${path(account, location)}/localPosts`, { method: 'POST', body: localPostBody(p) });
      return { name: String(json.name ?? ''), state: String(json.state ?? ''), search_url: /^https:\/\//.test(String(json.searchUrl ?? '')) ? String(json.searchUrl) : '' };
    },
    async deletePost(postName: string): Promise<void> {
      if (!/^accounts\/[0-9]+\/locations\/[0-9]+\/localPosts\/[\w-]+$/.test(postName)) throw new BusinessError('Beitrag ungültig', 400);
      await req(`${V4}/${postName}`, { method: 'DELETE' }, [404]);
    },
  };
}
export type BusinessApi = ReturnType<typeof businessApi>;
