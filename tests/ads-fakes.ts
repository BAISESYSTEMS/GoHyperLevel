import { createHash } from 'node:crypto';

/**
 * In-memory stand-ins for the Meta Graph / Marketing API, the Google Ads API and Google's OAuth endpoint – the
 * ads manager's tests never talk to the real services. Plug `fake.fetch` into `app.services.adsFetch`.
 */

export const META_APP = { app_id: '123456789012345', app_secret: '0123456789abcdef0123456789abcdef' };
export const G_APP = { client_id: '1234567890-abcdef.apps.googleusercontent.com', client_secret: 'GOCSPX-test-secret-123' };
export const DEV_TOKEN = 'DEVTOKEN0123456789';
export const LONG_TOKEN = 'EAAG-long-lived-user-token';
export const PAGE_TOKEN = 'EAAG-page-token';

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const gErr = (status: number, message: string, code?: Record<string, string>) => json({ error: { code: status, message, status: 'ERROR', ...(code ? { details: [{ errors: [{ errorCode: code, message }] }] } : {}) } }, status);

export interface Req {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  path: string;
}

export function createAdsFake() {
  const reqs: Req[] = [];
  let n = 100000;
  const f = {
    // Meta
    adAccounts: [{ account_id: '111222333', name: 'Testkonto GmbH', currency: 'EUR', account_status: 1, business: { name: 'Test Business' } }] as any[],
    pages: [{ id: '555000111', name: 'Yogastudio Köln', access_token: PAGE_TOKEN }] as any[],
    granted: ['ads_management', 'ads_read', 'business_management', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads', 'pages_manage_metadata', 'leads_retrieval'],
    pixels: [{ id: '998877665544', name: 'Pixel' }] as any[],
    failStep: '' as '' | 'adsets' | 'adcreatives' | 'ads' | 'campaigns',
    remoteCampaigns: [] as any[],
    budgets: new Map<string, { daily_budget?: string; lifetime_budget?: string }>(),
    adsetsOf: new Map<string, any[]>(),
    leads: new Map<string, any>(),
    formLeads: [] as any[],
    pageForms: [] as any[],
    subscribedFields: ['messages', 'messaging_postbacks'] as string[],
    // Google
    gCodes: new Map<string, string>(),
    gRefresh: '1//g-refresh',
    gAccess: 'ya29.access',
    gScope: 'openid email https://www.googleapis.com/auth/adwords',
    gCampaigns: [] as any[],
    gBudgetMicros: new Map<string, string>(),
    revoked: [] as string[],
  };

  const metaPath = (u: URL) => u.pathname.replace(/^\/v\d+\.\d+\//, '');

  async function handle(input: any, init: any = {}): Promise<Response> {
    const url = String(input);
    const u = new URL(url);
    const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
    const headers: Record<string, string> = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const method = (init.method ?? 'GET').toUpperCase();
    reqs.push({ url, method, headers, body, path: u.pathname });

    // --- Google OAuth ---------------------------------------------------------------------------------
    if (url === 'https://oauth2.googleapis.com/token') {
      const p = new URLSearchParams(init.body);
      if (p.get('grant_type') === 'authorization_code') {
        const email = f.gCodes.get(String(p.get('code')));
        if (!email) return json({ error: 'invalid_grant', error_description: 'Bad code' }, 400);
        return json({ access_token: f.gAccess, refresh_token: f.gRefresh, expires_in: 3599, scope: f.gScope, id_token: `x.${Buffer.from(JSON.stringify({ email, name: 'Anna Ads' })).toString('base64url')}.y` });
      }
      return p.get('refresh_token') === f.gRefresh ? json({ access_token: f.gAccess, expires_in: 3599 }) : json({ error: 'invalid_grant', error_description: 'Token revoked' }, 400);
    }
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') {
      f.revoked.push(String(new URLSearchParams(init.body).get('token')));
      return json({});
    }

    // --- Google Ads ----------------------------------------------------------------------------------------
    if (u.host === 'googleads.googleapis.com') {
      if (headers['developer-token'] !== DEV_TOKEN || headers.authorization !== `Bearer ${f.gAccess}`) return gErr(401, 'Request is missing required authentication credential.', { authenticationError: 'AUTHENTICATION_ERROR' });
      const path = u.pathname.replace(/^\/v\d+\//, '');
      if (path === 'customers:listAccessibleCustomers') return json({ resourceNames: ['customers/1234567890', 'customers/9999999999'] });
      if (path === 'geoTargetConstants:suggest') return json({ geoTargetConstantSuggestions: [{ geoTargetConstant: { resourceName: 'geoTargetConstants/1004528', id: '1004528', name: 'Köln', canonicalName: 'Cologne, North Rhine-Westphalia, Germany', countryCode: 'DE', targetType: 'City' } }] });
      let m = /^customers\/(\d+)\/googleAds:search$/.exec(path);
      if (m) {
        const q = String(body?.query ?? '');
        if (m[1] === '9999999999') return gErr(403, 'The caller does not have permission', { authorizationError: 'USER_PERMISSION_DENIED' });
        if (/FROM customer\b/.test(q) && !/customer_client/.test(q)) return json({ results: [{ customer: { id: m[1], descriptiveName: 'Yoga Google Konto', manager: false, currencyCode: 'EUR', timeZone: 'Europe/Berlin', testAccount: true } }] });
        if (/FROM campaign\b/.test(q) && /campaign_budget\.explicitly_shared/.test(q)) {
          const id = /campaign\.id = (\d+)/.exec(q)?.[1] ?? '';
          const budget = f.gBudgetMicros.get(id) ?? '15000000';
          return json({ results: [{ campaign: { id, campaignBudget: `customers/${m[1]}/campaignBudgets/77` }, campaignBudget: { amountMicros: budget, explicitlyShared: false } }] });
        }
        if (/FROM campaign\b/.test(q)) return json({ results: f.gCampaigns });
        return json({ results: [] });
      }
      m = /^customers\/(\d+)\/googleAds:mutate$/.exec(path);
      if (m) {
        const ops: any[] = body?.mutateOperations ?? [];
        const bad = f.failStep === 'campaigns' ? true : false;
        if (bad) return gErr(400, 'Request contains an invalid argument.', { campaignError: 'CAMPAIGN_NAME_DUPLICATE' });
        const real = new Map<string, string>();
        const responses = ops.map((o) => {
          const key = Object.keys(o)[0];
          const op = o[key];
          const kind = key.replace(/Operation$/, '');
          const rn: string = op.create?.resourceName ?? op.update?.resourceName ?? '';
          let final = rn || `customers/${m![1]}/${kind}s/${++n}`;
          if (/\/-\d+$/.test(rn)) {
            final = rn.replace(/-\d+$/, String(++n));
            real.set(rn, final);
          }
          return { [`${kind}Result`]: { resourceName: final } };
        });
        return json({ mutateOperationResponses: responses });
      }
      if (/^customers\/\d+\/googleAds:searchStream$/.test(path)) return json([{ results: [] }]);
      if (/^customers\/\d+\/campaignBudgets:mutate$/.test(path)) return json({ results: [{ resourceName: body?.operations?.[0]?.update?.resourceName }] });
      if (/^customers\/\d+\/userLists:mutate$/.test(path)) return json({ results: [{ resourceName: `customers/1234567890/userLists/${++n}` }] });
      if (/^customers\/\d+\/offlineUserDataJobs:create$/.test(path)) return json({ resourceName: `customers/1234567890/offlineUserDataJobs/${++n}` });
      if (/offlineUserDataJobs\/\d+:addOperations$/.test(path)) return json({});
      if (/offlineUserDataJobs\/\d+:run$/.test(path)) return json({});
      return gErr(404, `unknown google path ${path}`);
    }

    // --- Meta (Graph) --------------------------------------------------------------------------------------------
    if (u.host === 'www.facebook.com') return json({});
    if (u.host === 'graph.facebook.com') {
      const path = metaPath(u);
      if (path === 'oauth/access_token') {
        const q = u.searchParams;
        if (q.get('client_id') !== META_APP.app_id || q.get('client_secret') !== META_APP.app_secret) return json({ error: { message: 'Invalid client_secret', code: 1 } }, 400);
        if (q.get('grant_type') === 'fb_exchange_token') return q.get('fb_exchange_token')?.startsWith('SHORT') || q.get('fb_exchange_token') === LONG_TOKEN ? json({ access_token: LONG_TOKEN, expires_in: 5184000 }) : json({ error: { message: 'bad token', code: 190 } }, 400);
        return q.get('code')?.startsWith('meta-code') ? json({ access_token: `SHORT-${q.get('code')}`, expires_in: 3600 }) : json({ error: { message: 'Invalid verification code format.', code: 100 } }, 400);
      }
      // The reporting passes its token as a query parameter.
      if (/^act_\d+\/insights$/.test(path)) return u.searchParams.get('access_token') === LONG_TOKEN ? json({ data: [] }) : json({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 400);
      const auth = headers.authorization;
      const isPage = auth === `Bearer ${PAGE_TOKEN}`;
      if (auth !== `Bearer ${LONG_TOKEN}` && !isPage) return json({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 400);
      if (path === 'me') return json({ id: 'fbuser1', name: 'Anna Meta' });
      if (path === 'me/adaccounts') return json({ data: f.adAccounts });
      if (path === 'me/accounts') return json({ data: f.pages });
      if (path === 'me/permissions') {
        if (method === 'DELETE') return json({ success: true });
        return json({ data: f.granted.map((p) => ({ permission: p, status: 'granted' })) });
      }
      if (/^act_\d+\/adspixels$/.test(path)) return json({ data: f.pixels });
      if (path === 'search') {
        if (u.searchParams.get('type') === 'adinterest') return json({ data: [{ id: '6003107902433', name: 'Yoga', audience_size_lower_bound: 1000000, audience_size_upper_bound: 2000000, path: ['Interessen', 'Sport'] }] });
        return json({ data: [{ key: '2511182', name: 'Köln', type: 'city', country_code: 'DE', country_name: 'Deutschland', region: 'Nordrhein-Westfalen' }] });
      }
      if (/^act_\d+\/adimages$/.test(path)) return json({ images: { bytes: { hash: 'imghash1', url: 'https://scontent/x.jpg' } } });
      if (/^act_\d+\/advideos$/.test(path)) return json({ id: '880001' });
      if (/^880001$/.test(path)) return json({ status: { video_status: 'ready' } });
      let m = /^act_(\d+)\/(campaigns|adsets|adcreatives|ads)$/.exec(path);
      if (m && method === 'POST') {
        if (f.failStep === m[2]) return json({ error: { message: 'Invalid parameter', code: 100, error_user_msg: `Feld in ${m[2]} fehlt` } }, 400);
        const id = String(++n);
        if (m[2] === 'adsets') f.adsetsOf.set(body.campaign_id, [{ id, daily_budget: body.daily_budget ? String(body.daily_budget) : undefined, lifetime_budget: body.lifetime_budget ? String(body.lifetime_budget) : undefined, effective_status: 'PAUSED' }]);
        if (m[2] === 'campaigns') f.remoteCampaigns.push({ id, name: body.name, status: 'PAUSED', effective_status: 'PAUSED', objective: body.objective });
        return json({ id });
      }
      if (m && method === 'GET' && m[2] === 'campaigns') return json({ data: f.remoteCampaigns });
      m = /^(\d+)\/adsets$/.exec(path);
      if (m && method === 'GET') return json({ data: f.adsetsOf.get(m[1]) ?? [] });
      if (/^act_\d+\/customaudiences$/.test(path) && method === 'POST') return json({ id: String(++n) });
      m = /^(\d+)\/users$/.exec(path);
      if (m && method === 'POST') return json({ audience_id: m[1], num_received: body.payload.data.length, num_invalid_entries: 0 });
      m = /^(\d+)\/leadgen_forms$/.exec(path);
      if (m && method === 'POST') {
        const id = String(++n);
        f.pageForms.push({ id, name: body.name, status: 'ACTIVE' });
        return json({ id });
      }
      if (m && method === 'GET') return json({ data: f.pageForms });
      m = /^(\d+)\/subscribed_apps$/.exec(path);
      if (m && method === 'GET') return json({ data: [{ id: META_APP.app_id, name: 'HyperLevel', subscribed_fields: f.subscribedFields }] });
      if (m && method === 'POST') {
        if (!isPage) return json({ error: { message: 'Page access token required', code: 190 } }, 400);
        f.subscribedFields = String(body.subscribed_fields).split(',');
        return json({ success: true });
      }
      m = /^(\d+)\/leads$/.exec(path);
      if (m && method === 'GET') return json({ data: f.formLeads.filter((l) => l.form_id === m![1]) });
      if (/^\d+$/.test(path) && method === 'GET') {
        if (u.searchParams.get('fields')?.startsWith('daily_budget')) {
          const b = f.budgets.get(path);
          return json({ id: path, ...(b ?? {}) });
        }
        const lead = f.leads.get(path);
        if (lead) return isPage ? json(lead) : json({ error: { message: 'Page token needed', code: 190 } }, 400);
        return json({ error: { message: 'Unsupported get request.', code: 100 } }, 400);
      }
      if (/^\d+$/.test(path) && method === 'POST') {
        const c = f.remoteCampaigns.find((x) => x.id === path);
        if (c && body.status) Object.assign(c, { status: body.status, effective_status: body.status });
        return json({ success: true });
      }
      if (/^\d+$/.test(path) && method === 'DELETE') {
        f.remoteCampaigns = f.remoteCampaigns.filter((x) => x.id !== path);
        return json({ success: true });
      }
      return json({ error: { message: `unknown graph path ${path}`, code: 100 } }, 404);
    }
    return json({ error: { message: `unknown host ${u.host}` } }, 404);
  }

  const calls = (re: RegExp, method?: string) => reqs.filter((r) => re.test(`${r.method} ${r.path}`) || re.test(r.url)).filter((r) => !method || r.method === method);
  return {
    f,
    reqs,
    calls,
    fetch: handle as unknown as typeof fetch,
    reset: () => (reqs.length = 0),
    /** What the consent screen would do: a code for the authorize URL (Meta: any string starting meta-code; Google: bound to an e-mail). */
    authorize(url: string, email = 'owner@example.com') {
      const u = new URL(url);
      const code = u.host === 'accounts.google.com' ? `gcode-${++n}` : `meta-code-${++n}`;
      if (u.host === 'accounts.google.com') f.gCodes.set(code, email);
      return { code, state: u.searchParams.get('state') ?? '', redirect: u.searchParams.get('redirect_uri') ?? '', scope: u.searchParams.get('scope') ?? '' };
    },
  };
}

export const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** 1×1 PNG. */
export const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
