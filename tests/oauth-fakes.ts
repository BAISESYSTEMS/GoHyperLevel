import { createHash } from 'node:crypto';

/**
 * In-memory stand-ins for Google (OAuth, Calendar, Business Profile) and Microsoft (Entra ID,
 * Graph calendar) – the tests never talk to the real services. Plug `fake.fetch` into
 * `app.services.oauthFetch`.
 */

export const G_CLIENT = { client_id: '1234567890-abcdef.apps.googleusercontent.com', client_secret: 'GOCSPX-test-secret-123' };
export const MS_CLIENT = { client_id: '11111111-2222-3333-4444-555555555555', client_secret: 'ms~test~secret', tenant: 'common' };

export const jwt = (claims: Record<string, unknown>) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const json = (d: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url');

export interface Req {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

export function createFake() {
  const reqs: Req[] = [];
  let n = 0;
  const g = {
    codes: new Map<string, { challenge: string; scope: string; redirect: string }>(),
    access: 'g-access-0',
    refresh: 'g-refresh-1',
    refreshCount: 0,
    failRefresh: false,
    revoked: [] as string[],
    calendars: [
      { id: 'owner@example.com', summary: 'Paul', primary: true, accessRole: 'owner', backgroundColor: '#4285f4' },
      { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'reader' },
    ] as any[],
    busy: [] as { start: string; end: string }[],
    events: new Map<string, any>(),
    changed: new Set<string>(),
    // Business Profile
    reviews: [] as any[],
    posts: [] as any[],
    gbpDenied: false,
  };
  const ms = {
    codes: new Map<string, { challenge: string; scope: string; redirect: string }>(),
    access: 'ms-access-0',
    refresh: 'ms-refresh-1',
    calendars: [
      { id: 'AQMkCAL1', name: 'Kalender', canEdit: true, isDefaultCalendar: true, hexColor: '#0078d4' },
      { id: 'AQMkCAL2', name: 'Geburtstage', canEdit: false, isDefaultCalendar: false },
    ] as any[],
    view: [] as any[],
    events: new Map<string, any>(),
    changed: new Set<string>(),
    removed: new Set<string>(),
  };

  /** What the provider's consent screen would do: hand back a code for this authorize URL. */
  function authorize(url: string) {
    const u = new URL(url);
    const code = `code-${++n}`;
    const entry = { challenge: u.searchParams.get('code_challenge') ?? '', scope: u.searchParams.get('scope') ?? '', redirect: u.searchParams.get('redirect_uri') ?? '' };
    (u.host === 'accounts.google.com' ? g.codes : ms.codes).set(code, entry);
    return { code, state: u.searchParams.get('state') ?? '', redirect: entry.redirect };
  }

  const gEvent = (e: any) => ({ kind: 'calendar#event', ...e });

  /** Someone moves an event in Google Calendar. */
  function googleMove(eventId: string, start: string, end: string, updatedOffsetMs = 0) {
    const e = g.events.get(eventId)!;
    Object.assign(e, { start: { dateTime: start }, end: { dateTime: end }, updated: new Date(Date.now() + updatedOffsetMs).toISOString(), etag: `"g${++n}"` });
    g.changed.add(eventId);
  }
  function googleDelete(eventId: string) {
    const e = g.events.get(eventId)!;
    Object.assign(e, { status: 'cancelled', updated: new Date().toISOString(), etag: `"g${++n}"` });
    g.changed.add(eventId);
  }
  function graphMove(eventId: string, start: string, end: string) {
    const e = ms.events.get(eventId)!;
    Object.assign(e, { start: { dateTime: start.replace('Z', '').replace(/\.\d+$/, '') + '.0000000', timeZone: 'UTC' }, end: { dateTime: end.replace('Z', '').replace(/\.\d+$/, '') + '.0000000', timeZone: 'UTC' }, lastModifiedDateTime: new Date().toISOString(), '@odata.etag': `W/"m${++n}"` });
    ms.changed.add(eventId);
  }
  function graphDelete(eventId: string) {
    ms.events.delete(eventId);
    ms.removed.add(eventId);
  }

  async function google(url: URL, method: string, headers: Record<string, string>, body: any): Promise<Response> {
    if (url.href === 'https://oauth2.googleapis.com/token') {
      if (body.client_id !== G_CLIENT.client_id || body.client_secret !== G_CLIENT.client_secret) return json({ error: 'invalid_client' }, 401);
      if (body.grant_type === 'authorization_code') {
        const c = g.codes.get(body.code);
        g.codes.delete(body.code);
        if (!c) return json({ error: 'invalid_grant', error_description: 'Bad code' }, 400);
        if (challengeOf(body.code_verifier ?? '') !== c.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
        if (body.redirect_uri !== c.redirect) return json({ error: 'redirect_uri_mismatch' }, 400);
        g.access = `g-access-${++n}`;
        const granted = c.scope.split(' ').map((s) => (s === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : s)).join(' ');
        return json({ access_token: g.access, refresh_token: g.refresh, expires_in: 3599, scope: granted, token_type: 'Bearer', id_token: jwt({ email: 'owner@example.com', name: 'Paul Test', sub: '42' }) });
      }
      if (body.grant_type === 'refresh_token') {
        if (g.failRefresh || body.refresh_token !== g.refresh) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
        g.refreshCount++;
        g.access = `g-access-${++n}`;
        return json({ access_token: g.access, expires_in: 3599, scope: 'x', token_type: 'Bearer' });
      }
    }
    if (url.href === 'https://oauth2.googleapis.com/revoke') {
      g.revoked.push(body.token);
      return json({});
    }
    if (headers.authorization !== `Bearer ${g.access}`) return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
    const p = url.pathname;
    // --- Calendar ---
    if (p === '/calendar/v3/users/me/calendarList') return json({ items: g.calendars });
    if (p === '/calendar/v3/freeBusy') return json({ calendars: Object.fromEntries(body.items.map((i: any) => [i.id, { busy: i.id === 'owner@example.com' ? g.busy.filter((b) => b.end > body.timeMin && b.start < body.timeMax) : [] }])) });
    let m = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
    if (m && method === 'POST') {
      if (g.events.has(body.id)) return json({ error: { code: 409, message: 'The requested identifier already exists.' } }, 409);
      const e = gEvent({ ...body, calendarId: decodeURIComponent(m[1]), status: 'confirmed', etag: `"g${++n}"`, updated: new Date().toISOString() });
      g.events.set(body.id, e);
      g.changed.add(body.id);
      return json(e);
    }
    if (m && method === 'GET') {
      const st = url.searchParams.get('syncToken');
      if (st === 'expired') return json({ error: { code: 410, message: 'Sync token is no longer valid' } }, 410);
      const items = st ? [...g.changed].map((id) => g.events.get(id)).filter(Boolean) : [...g.events.values()];
      g.changed.clear();
      return json({ items, nextSyncToken: `sync-${++n}` });
    }
    m = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/);
    if (m) {
      const e = g.events.get(decodeURIComponent(m[2]));
      if (method === 'GET') return e ? json(e) : json({ error: { code: 404, message: 'Not Found' } }, 404);
      if (method === 'DELETE') {
        if (!e || e.status === 'cancelled') return json({ error: { code: 410, message: 'Resource has been deleted' } }, 410);
        Object.assign(e, { status: 'cancelled', updated: new Date().toISOString(), etag: `"g${++n}"` });
        g.changed.add(e.id);
        return json(null, 204);
      }
      if (method === 'PATCH') {
        if (!e) return json({ error: { code: 404, message: 'Not Found' } }, 404);
        if (headers['if-match'] && headers['if-match'] !== e.etag) return json({ error: { code: 412, message: 'Precondition Failed' } }, 412);
        Object.assign(e, body, { etag: `"g${++n}"`, updated: new Date().toISOString() });
        g.changed.add(e.id);
        return json(e);
      }
    }
    // --- Business Profile ---
    if (g.gbpDenied) return json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'My Business Account Management API has not been used in project 123 before or it is disabled.' } }, 403);
    if (url.host === 'mybusinessaccountmanagement.googleapis.com' && p === '/v1/accounts') return json({ accounts: [{ name: 'accounts/111', accountName: 'Malerei Muster', type: 'PERSONAL' }] });
    if (url.host === 'mybusinessbusinessinformation.googleapis.com' && p === '/v1/accounts/111/locations')
      return json({
        locations: [
          { name: 'locations/222', title: 'Malerei Muster Berlin', storefrontAddress: { addressLines: ['Hauptstr. 1'], postalCode: '10115', locality: 'Berlin' }, metadata: { placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', mapsUri: 'https://maps.google.com/maps?cid=1', newReviewUri: 'https://g.page/r/abc/review' } },
          { name: 'locations/333', title: 'Malerei Muster Potsdam', metadata: {} },
        ],
      });
    if (url.host === 'mybusiness.googleapis.com') {
      if (p === '/v4/accounts/111/locations/222/reviews' && method === 'GET') return json({ reviews: g.reviews, averageRating: 4.333, totalReviewCount: g.reviews.length });
      m = p.match(/^\/v4\/accounts\/111\/locations\/222\/reviews\/([^/]+)\/reply$/);
      if (m) {
        const r = g.reviews.find((x) => x.reviewId === decodeURIComponent(m![1]));
        if (!r) return json({ error: { code: 404, message: 'Not found' } }, 404);
        if (method === 'PUT') {
          r.reviewReply = { comment: body.comment, updateTime: '2026-10-04T10:00:00Z' };
          return json(r.reviewReply);
        }
        if (method === 'DELETE') {
          delete r.reviewReply;
          return json({});
        }
      }
      if (p === '/v4/accounts/111/locations/222/localPosts' && method === 'POST') {
        const post = { ...body, name: `accounts/111/locations/222/localPosts/${++n}`, state: 'LIVE', searchUrl: 'https://local.google.com/place?id=1&use=posts&lpsid=1' };
        g.posts.push(post);
        return json(post);
      }
      m = p.match(/^\/v4\/(accounts\/111\/locations\/222\/localPosts\/[^/]+)$/);
      if (m && method === 'DELETE') {
        g.posts = g.posts.filter((x) => x.name !== m![1]);
        return json({});
      }
    }
    return json({ error: { code: 404, message: `fake google: ${method} ${url.href}` } }, 404);
  }

  async function microsoft(url: URL, method: string, headers: Record<string, string>, body: any): Promise<Response> {
    if (url.href === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
      if (body.client_id !== MS_CLIENT.client_id || body.client_secret !== MS_CLIENT.client_secret) return json({ error: 'invalid_client' }, 401);
      if (body.grant_type === 'authorization_code') {
        const c = ms.codes.get(body.code);
        ms.codes.delete(body.code);
        if (!c || challengeOf(body.code_verifier ?? '') !== c.challenge || body.redirect_uri !== c.redirect) return json({ error: 'invalid_grant', error_description: 'AADSTS: bad code' }, 400);
        ms.access = `ms-access-${++n}`;
        return json({ access_token: ms.access, refresh_token: ms.refresh, expires_in: 3600, scope: 'openid email https://graph.microsoft.com/Calendars.ReadWrite', id_token: jwt({ preferred_username: 'inhaber@firma.de', name: 'Paul Firma', oid: 'o1' }) });
      }
      if (body.grant_type === 'refresh_token') {
        if (body.refresh_token !== ms.refresh) return json({ error: 'invalid_grant', error_description: 'AADSTS70008: refresh token expired' }, 400);
        ms.refresh = `ms-refresh-${++n}`; // Microsoft rotates refresh tokens
        ms.access = `ms-access-${++n}`;
        return json({ access_token: ms.access, refresh_token: ms.refresh, expires_in: 3600, scope: 'https://graph.microsoft.com/Calendars.ReadWrite' });
      }
    }
    if (headers.authorization !== `Bearer ${ms.access}`) return json({ error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired' } }, 401);
    const p = url.pathname;
    if (p === '/v1.0/me/calendars') return json({ value: ms.calendars });
    let m = p.match(/^\/v1\.0\/me\/calendars\/([^/]+)\/calendarView$/);
    if (m) return json({ value: ms.view });
    m = p.match(/^\/v1\.0\/me\/calendars\/([^/]+)\/calendarView\/delta$/);
    if (m) {
      const token = url.searchParams.get('$deltatoken');
      const value = token
        ? [...[...ms.changed].map((id) => ms.events.get(id)).filter(Boolean), ...[...ms.removed].map((id) => ({ id, '@removed': { reason: 'deleted' } }))]
        : [...ms.events.values()];
      ms.changed.clear();
      ms.removed.clear();
      return json({ value, '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/calendars/${m[1]}/calendarView/delta?$deltatoken=d${++n}` });
    }
    m = p.match(/^\/v1\.0\/me\/calendars\/([^/]+)\/events$/);
    if (m && method === 'POST') {
      const existing = [...ms.events.values()].find((e) => e.transactionId === body.transactionId);
      if (existing) return json(existing, 201);
      const id = `AAMkEV${++n}`;
      const e = { ...body, id, start: { dateTime: `${body.start.dateTime}.0000000`, timeZone: 'UTC' }, end: { dateTime: `${body.end.dateTime}.0000000`, timeZone: 'UTC' }, '@odata.etag': `W/"m${++n}"`, lastModifiedDateTime: new Date().toISOString(), calendarId: m[1] };
      ms.events.set(id, e);
      ms.changed.add(id);
      return json(e, 201);
    }
    m = p.match(/^\/v1\.0\/me\/events\/([^/]+)$/);
    if (m) {
      const e = ms.events.get(decodeURIComponent(m[1]));
      if (!e) return json({ error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } }, 404);
      if (method === 'GET') return json(e);
      if (method === 'DELETE') {
        graphDelete(e.id);
        return json(null, 204);
      }
      if (method === 'PATCH') {
        if (headers['if-match'] && headers['if-match'] !== e['@odata.etag']) return json({ error: { code: 'ErrorIrresolvableConflict', message: 'Conflict' } }, 412);
        Object.assign(e, body, { start: { dateTime: `${body.start.dateTime}.0000000`, timeZone: 'UTC' }, end: { dateTime: `${body.end.dateTime}.0000000`, timeZone: 'UTC' }, '@odata.etag': `W/"m${++n}"`, lastModifiedDateTime: new Date().toISOString() });
        ms.changed.add(e.id);
        return json(e);
      }
    }
    return json({ error: { code: 'NotFound', message: `fake graph: ${method} ${url.href}` } }, 404);
  }

  const fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    let body: any = undefined;
    if (typeof init.body === 'string') body = headers['content-type']?.includes('x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body);
    reqs.push({ url: url.href, method, headers, body });
    if (url.host.endsWith('googleapis.com') || url.host === 'accounts.google.com') return google(url, method, headers, body);
    if (url.host === 'login.microsoftonline.com' || url.host === 'graph.microsoft.com') return microsoft(url, method, headers, body);
    throw new Error(`unexpected request to ${url.href}`);
  }) as unknown as typeof globalThis.fetch;

  return { fetch, reqs, g, ms, authorize, googleMove, googleDelete, graphMove, graphDelete };
}
