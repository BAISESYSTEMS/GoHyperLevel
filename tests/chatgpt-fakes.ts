import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

/**
 * A fake OpenAI for the "Mit ChatGPT anmelden" tests – no network. It behaves like the documented service:
 * OpenID configuration, JWKS, a token endpoint that enforces PKCE and the redirect URI, rotating refresh tokens
 * (a used refresh token is dead), an RS256-signed ID token, revocation, the model catalogue and a Responses stream.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
export const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };
const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');

export function signJwt(payload: Record<string, unknown>, o: { kid?: string; alg?: string; key?: typeof privateKey } = {}) {
  const head = b64u(JSON.stringify({ alg: o.alg ?? 'RS256', typ: 'JWT', kid: o.kid ?? KID }));
  const body = b64u(JSON.stringify(payload));
  const sig = cryptoSign('RSA-SHA256', Buffer.from(`${head}.${body}`), o.key ?? privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}

export const sse = (events: object[]) => events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const sseResponse = (text: string) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  form?: Record<string, string>;
  body?: any;
}

export function fakeOpenAI() {
  const calls: Call[] = [];
  const codes = new Map<string, { challenge: string; redirect: string; clientId: string; nonce: string; email: string; sub: string; plan: string }>();
  const liveRefresh = new Set<string>();
  const liveAccess = new Set<string>();
  const revoked: string[] = [];
  let n = 0;
  const s = {
    /** The plan scope is granted unless the test switches it off. */
    grantPlan: true,
    expiresIn: 3600,
    email: 'paula@example.com',
    sub: 'user-paula',
    plan: 'plus',
    clientCounter: 0,
    failRefresh: '' as '' | 'invalid_grant' | 'refresh_token_reused' | 'server',
    models: [
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
      { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list' },
      { slug: 'internal-hidden', display_name: 'Hidden', visibility: 'hide' },
    ],
    /** What POST /v1/responses answers (a list of stream events, or a Response). */
    responses: ((_body: any, _n: number): object[] | Response => [
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'response.output_text.delta', delta: 'Hallo ' },
      { type: 'response.output_text.delta', delta: 'Welt' },
      { type: 'response.completed', response: { model: 'gpt-6.1-sol', usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 7 } } },
    ]) as (body: any, n: number) => object[] | Response,
    responseCount: 0,
    calls,
    revoked,
    /** What happens when the person approves in the browser: the address the browser lands on. */
    consent(authorizeUrl: string, o: { state?: string } = {}) {
      const u = new URL(authorizeUrl);
      const q = u.searchParams;
      if (u.origin + u.pathname !== 'https://auth.openai.com/api/accounts/authorize') throw new Error(`unexpected authorize URL ${u.origin}${u.pathname}`);
      const clientId = q.get('client_id') === 'dynamic_agent_client' ? `oaiapp_test${++s.clientCounter}` : q.get('client_id')!;
      const code = `code-${++n}`;
      codes.set(code, { challenge: q.get('code_challenge')!, redirect: q.get('redirect_uri')!, clientId, nonce: q.get('nonce')!, email: s.email, sub: s.sub, plan: s.plan });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('scope', s.grantPlan ? 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke' : 'email offline_access openid profile');
      back.searchParams.set('state', o.state ?? q.get('state')!);
      if (q.get('client_id') === 'dynamic_agent_client') back.searchParams.set('client_id', clientId);
      return back.toString();
    },
    fetch: (async (input: any, init: any = {}) => {
      const url = String(typeof input === 'string' ? input : input.url);
      const headers: Record<string, string> = {};
      new Headers(init.headers ?? {}).forEach((v, k) => (headers[k] = v));
      const method = init.method ?? 'GET';
      const call: Call = { method, url, headers };
      if (typeof init.body === 'string') {
        if ((headers['content-type'] ?? '').includes('x-www-form-urlencoded')) call.form = Object.fromEntries(new URLSearchParams(init.body));
        else call.body = JSON.parse(init.body);
      }
      calls.push(call);
      const issue = (clientId: string, nonce: string | undefined, email: string, sub: string, plan: string) => {
        const idn = ++n;
        const access = `at-secret-${idn}`;
        const refresh = `rt-secret-${idn}`;
        liveAccess.add(access);
        liveRefresh.add(refresh);
        const nowS = Math.floor(Date.now() / 1000);
        const idToken = signJwt({ iss: 'https://auth.openai.com', aud: clientId, sub, email, name: 'Paula Beispiel', iat: nowS, exp: nowS + 3600, ...(nonce ? { nonce } : {}), 'https://api.openai.com/auth': { chatgpt_plan_type: plan } });
        return { access_token: access, refresh_token: refresh, id_token: idToken, token_type: 'Bearer', expires_in: s.expiresIn, scope: s.grantPlan ? 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke' : 'email offline_access openid profile' };
      };
      if (url === 'https://auth.openai.com/.well-known/openid-configuration')
        return jsonResponse({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json' });
      if (url === 'https://auth.openai.com/.well-known/jwks.json') return jsonResponse({ keys: [jwk] });
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        const f = call.form ?? {};
        if (f.resource !== 'https://api.openai.com/v1') return jsonResponse({ error: 'invalid_target' }, 400);
        if (f.grant_type === 'authorization_code') {
          const c = codes.get(f.code);
          codes.delete(f.code);
          if (!c || c.clientId !== f.client_id || c.redirect !== f.redirect_uri) return jsonResponse({ error: 'invalid_grant' }, 400);
          if (createHash('sha256').update(f.code_verifier ?? '').digest('base64url') !== c.challenge) return jsonResponse({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
          return jsonResponse(issue(c.clientId, c.nonce, c.email, c.sub, c.plan));
        }
        if (f.grant_type === 'refresh_token') {
          if (s.failRefresh === 'server') return jsonResponse({ error: 'server_error' }, 503);
          if (s.failRefresh) return jsonResponse({ error: s.failRefresh }, 400);
          if (!liveRefresh.has(f.refresh_token)) return jsonResponse({ error: 'invalid_grant', error_description: 'refresh token already used' }, 400);
          liveRefresh.delete(f.refresh_token);
          return jsonResponse(issue(f.client_id, undefined, s.email, s.sub, s.plan));
        }
        return jsonResponse({ error: 'unsupported_grant_type' }, 400);
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/revoke') {
        revoked.push(call.form?.token ?? '');
        liveRefresh.delete(call.form?.token ?? '');
        return new Response('', { status: 200 });
      }
      if (url.startsWith('https://api.openai.com/')) {
        const token = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1] ?? '';
        if (!liveAccess.has(token)) return jsonResponse({ detail: 'Unauthorized' }, 401);
        if (url === 'https://api.openai.com/v1/models') return jsonResponse({ models: s.models });
        if (url === 'https://api.openai.com/v1/responses' && method === 'POST') {
          const out = s.responses(call.body, ++s.responseCount);
          return out instanceof Response ? out : sseResponse(sse(out));
        }
      }
      return jsonResponse({ error: { message: `fake OpenAI: no route ${method} ${url}` } }, 404);
    }) as (url: string, init?: RequestInit) => Promise<Response>,
    /** Make every issued access token dead (the server did not like it). */
    killAccess: () => liveAccess.clear(),
  };
  return s;
}

/** The address of a callback: the whole thing a person copies from the browser. */
export const callbackOf = (url: string) => url;
