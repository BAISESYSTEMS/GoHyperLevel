import { createHash, generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { OAuthError, REDIRECT_URI, SCOPES, buildAuthorizeUrl, credentialsOf, exchangeCode, listPlanModels, newHostId, isHostId, newPkce, parseCallback, planLabel, refreshCredentials, resetDiscovery, resetJwks, revoke, verifyIdToken } from '../server/services/chatgpt-oauth.js';
import { chatResponses, planError, responsesBody, toResponsesInput } from '../server/services/chatgpt-responses.js';
import { chatWithTools, retry, type ChatRequest } from '../server/services/agent-llm.js';
import { fakeOpenAI, signJwt, sse } from './chatgpt-fakes.js';

/** "Mit ChatGPT anmelden" – the protocol (OpenAI's Sign in with ChatGPT for open-source apps) and the Responses adapter. All HTTP mocked. */

let ai: ReturnType<typeof fakeOpenAI>;
beforeEach(() => {
  retry.ms = 1;
  resetDiscovery();
  resetJwks();
  ai = fakeOpenAI();
});

describe('authorize URL and PKCE', () => {
  it('makes an S256 challenge of the verifier and a stable host id', () => {
    const p = newPkce();
    expect(p.challenge).toBe(createHash('sha256').update(p.verifier).digest('base64url'));
    expect(new Set([p.state, p.nonce, p.verifier]).size).toBe(3);
    expect(isHostId(newHostId())).toBe(true);
    expect(isHostId('user-123')).toBe(false);
  });

  it('registers on the first sign-in with dynamic_agent_client and the app name hint', async () => {
    const p = newPkce();
    const u = new URL(await buildAuthorizeUrl(ai.fetch, { hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', appName: 'HyperLevel', pkce: p }));
    expect(`${u.origin}${u.pathname}`).toBe('https://auth.openai.com/api/accounts/authorize');
    const q = u.searchParams;
    expect(Object.fromEntries(q)).toMatchObject({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'HyperLevel',
      ext_agent_host_id: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:1455/auth/callback',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      code_challenge_method: 'S256',
      code_challenge: p.challenge,
      state: p.state,
      nonce: p.nonce,
    });
    expect(REDIRECT_URI).toBe('http://127.0.0.1:1455/auth/callback');
    expect(SCOPES.split(' ')).toContain('chatgpt.tokens.use.direct');
    // the verifier never goes into the URL
    expect(u.toString()).not.toContain(p.verifier);
  });

  it('re-authorizes with the issued client id, without the name hint, with a login hint and optional re-consent', async () => {
    const u = new URL(await buildAuthorizeUrl(ai.fetch, { clientId: 'oaiapp_abc', hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', appName: 'HyperLevel', pkce: newPkce(), loginHint: 'paula@example.com', reconsent: true }));
    expect(u.searchParams.get('client_id')).toBe('oaiapp_abc');
    expect(u.searchParams.has('agent_name_hint')).toBe(false);
    expect(u.searchParams.get('login_hint')).toBe('paula@example.com');
    expect(u.searchParams.get('prompt')).toBe('consent');
  });

  it('refuses OpenID configurations that point away from auth.openai.com', async () => {
    const evil: typeof ai.fetch = async () => new Response(JSON.stringify({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://evil.example/authorize', token_endpoint: 'https://auth.openai.com/t', jwks_uri: 'https://auth.openai.com/j' }), { status: 200 });
    resetDiscovery();
    // discovery fails -> the documented authorize URL is used, never the foreign one
    const u = await buildAuthorizeUrl(evil, { hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', appName: 'HyperLevel', pkce: newPkce() });
    expect(u.startsWith('https://auth.openai.com/api/accounts/authorize?')).toBe(true);
  });
});

describe('the address the person pastes back', () => {
  const state = 'STATE-123';
  const url = (q: string) => `http://127.0.0.1:1455/auth/callback?${q}`;

  it('takes the whole address, the query string or bare parameters', () => {
    const q = `code=abc&state=${state}&client_id=oaiapp_1&scope=openid`;
    expect(parseCallback(url(q), state)).toEqual({ code: 'abc', clientId: 'oaiapp_1' });
    expect(parseCallback(`?${q}`, state)).toEqual({ code: 'abc', clientId: 'oaiapp_1' });
    expect(parseCallback(q, state)).toEqual({ code: 'abc', clientId: 'oaiapp_1' });
    expect(parseCallback(`  ${url(q)}  \n`, state)).toEqual({ code: 'abc', clientId: 'oaiapp_1' });
    // re-authorization: the callback may omit the client id; the saved one is used
    expect(parseCallback(url(`code=abc&state=${state}`), state, 'oaiapp_saved')).toEqual({ code: 'abc', clientId: 'oaiapp_saved' });
  });

  it('rejects a foreign state, a missing code, other hosts and half-finished registrations', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as OAuthError).code;
      }
      return 'ok';
    };
    expect(code(() => parseCallback(url('code=abc&state=OTHER&client_id=oaiapp_1'), state))).toBe('state_mismatch');
    expect(code(() => parseCallback(url('code=abc&client_id=oaiapp_1'), state))).toBe('state_mismatch');
    expect(code(() => parseCallback(url(`state=${state}&client_id=oaiapp_1`), state))).toBe('no_code');
    expect(code(() => parseCallback(url(`code=a&code=b&state=${state}&client_id=oaiapp_1`), state))).toBe('no_code');
    expect(code(() => parseCallback(`https://evil.example/cb?code=abc&state=${state}&client_id=oaiapp_1`, state))).toBe('bad_callback');
    expect(code(() => parseCallback(url(`code=abc&state=${state}`), state))).toBe('registration_incomplete');
    expect(code(() => parseCallback(url(`code=abc&state=${state}&client_id=dynamic_agent_client`), state))).toBe('registration_incomplete');
    expect(code(() => parseCallback(url(`code=abc&state=${state}&client_id=oaiapp_other`), state, 'oaiapp_saved'))).toBe('registration_incomplete');
    expect(code(() => parseCallback('', state))).toBe('empty');
    expect(code(() => parseCallback(url(`error=access_denied&state=${state}`), state))).toBe('access_denied');
    // an error is only believed with the right state
    expect(code(() => parseCallback(url('error=access_denied&state=nope'), state))).toBe('state_mismatch');
  });
});

describe('code exchange, refresh and revoke against the fake service', () => {
  it('walks the whole flow: PKCE is enforced, tokens and identity come back, the plan scope is checked', async () => {
    const p = newPkce();
    const authorize = await buildAuthorizeUrl(ai.fetch, { hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', appName: 'HyperLevel', pkce: p });
    const pasted = ai.consent(authorize);
    const { code, clientId } = parseCallback(pasted, p.state);
    // a wrong verifier is refused by OpenAI's side
    await expect(exchangeCode(ai.fetch, { clientId, code, verifier: 'wrong-verifier' })).rejects.toMatchObject({ code: 'invalid_grant' });
    const again = parseCallback(ai.consent(authorize), p.state);
    const { credentials, data } = await exchangeCode(ai.fetch, { ...again, verifier: p.verifier });
    expect(credentials.scopes).toContain('chatgpt.tokens.use.direct');
    expect(credentials.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
    const who = await verifyIdToken(ai.fetch, data.id_token, { clientId: again.clientId, nonce: p.nonce });
    expect(who).toMatchObject({ subject: 'user-paula', email: 'paula@example.com', plan: 'plus' });
    expect(planLabel(who.plan)).toBe('ChatGPT Plus');
    // the exchange sent the same redirect URI and the resource, and no client secret
    const token = ai.calls.filter((c) => c.url.endsWith('/oauth/token')).pop()!;
    expect(token.form).toMatchObject({ grant_type: 'authorization_code', redirect_uri: REDIRECT_URI, resource: 'https://api.openai.com/v1', code_verifier: p.verifier });
    expect(Object.keys(token.form!)).not.toContain('client_secret');
  });

  it('rotates the refresh token: the new one works, the old one is dead (reuse needs a new sign-in)', async () => {
    const p = newPkce();
    const cb = parseCallback(ai.consent(await buildAuthorizeUrl(ai.fetch, { hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', appName: 'HyperLevel', pkce: p })), p.state);
    const first = (await exchangeCode(ai.fetch, { ...cb, verifier: p.verifier })).credentials;
    const second = await refreshCredentials(ai.fetch, cb.clientId, first);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.scopes).toEqual(first.scopes);
    const refreshCall = ai.calls.filter((c) => c.form?.grant_type === 'refresh_token')[0];
    expect(refreshCall.form).toMatchObject({ client_id: cb.clientId, resource: 'https://api.openai.com/v1' });
    expect(refreshCall.form).not.toHaveProperty('scope');
    await expect(refreshCredentials(ai.fetch, cb.clientId, first)).rejects.toMatchObject({ reauth: true, status: 401 });
  });

  it('maps unusable refresh tokens to "sign in again" and outages to a retryable error', async () => {
    const creds = { accessToken: 'a', refreshToken: 'r', idToken: '', expiresAt: 0, scopes: ['openid'] };
    for (const code of ['invalid_grant', 'refresh_token_reused'] as const) {
      ai.failRefresh = code;
      await expect(refreshCredentials(ai.fetch, 'oaiapp_1', creds)).rejects.toMatchObject({ reauth: true });
    }
    ai.failRefresh = 'server';
    await expect(refreshCredentials(ai.fetch, 'oaiapp_1', creds)).rejects.toMatchObject({ reauth: false, status: 503 });
  });

  it('revokes the refresh token and reports whether OpenAI confirmed', async () => {
    expect(await revoke(ai.fetch, 'oaiapp_1', 'rt-secret-x')).toBe(true);
    expect(ai.revoked).toEqual(['rt-secret-x']);
    const call = ai.calls.find((c) => c.url.endsWith('/oauth/revoke'))!;
    expect(call.form).toMatchObject({ token_type_hint: 'refresh_token', client_id: 'oaiapp_1' });
    const down: typeof ai.fetch = async (u, i) => (u.endsWith('/oauth/revoke') ? new Response('', { status: 503 }) : ai.fetch(u, i));
    expect(await revoke(down, 'oaiapp_1', 'rt')).toBe(false);
  });

  it('demands scope, bearer type, expiry and a refresh token in a token response', () => {
    const ok = { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' };
    expect(credentialsOf(ok).scopes).toContain('chatgpt.tokens.use.direct');
    for (const bad of [{ ...ok, scope: undefined }, { ...ok, token_type: 'mac' }, { ...ok, expires_in: 0 }, { ...ok, refresh_token: undefined }, { ...ok, access_token: '' }]) expect(() => credentialsOf(bad as any)).toThrow(OAuthError);
    // on a refresh the scope may be left out and the old refresh token kept
    const prev = credentialsOf(ok);
    expect(credentialsOf({ access_token: 'b', token_type: 'bearer', expires_in: 60 }, prev)).toMatchObject({ accessToken: 'b', refreshToken: 'r', scopes: prev.scopes });
  });
});

describe('ID token verification', () => {
  const base = () => {
    const nowS = Math.floor(Date.now() / 1000);
    return { iss: 'https://auth.openai.com', aud: 'oaiapp_1', sub: 's1', email: 'a@b.de', iat: nowS, exp: nowS + 600, nonce: 'n1' };
  };
  const check = (payload: object, o: Parameters<typeof signJwt>[1] = {}, clientId = 'oaiapp_1', nonce: string | undefined = 'n1') => verifyIdToken(ai.fetch, signJwt(payload as any, o), { clientId, nonce });

  it('accepts a good token and rejects forged ones', async () => {
    await expect(check(base())).resolves.toMatchObject({ subject: 's1', email: 'a@b.de' });
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(check(base(), { key: other.privateKey })).rejects.toMatchObject({ code: 'invalid_id_token' });
    await expect(check({ ...base(), iss: 'https://evil.example' })).rejects.toMatchObject({ code: 'invalid_id_token' });
    await expect(check({ ...base(), aud: 'someone-else' })).rejects.toMatchObject({ code: 'invalid_id_token' });
    await expect(check({ ...base(), exp: Math.floor(Date.now() / 1000) - 600 })).rejects.toMatchObject({ code: 'invalid_id_token' });
    await expect(check({ ...base(), nonce: 'other' })).rejects.toMatchObject({ code: 'invalid_id_token' });
    await expect(check(base(), { alg: 'none' })).rejects.toMatchObject({ code: 'invalid_id_token' });
    await expect(verifyIdToken(ai.fetch, 'not.a.jwt', { clientId: 'oaiapp_1' })).rejects.toMatchObject({ code: 'invalid_id_token' });
  });
});

describe('model catalogue', () => {
  it('lists the models marked "list" in the order the server gives them', async () => {
    const p = newPkce();
    const cb = parseCallback(ai.consent(await buildAuthorizeUrl(ai.fetch, { hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', appName: 'HyperLevel', pkce: p })), p.state);
    const { credentials } = await exchangeCode(ai.fetch, { ...cb, verifier: p.verifier });
    expect(await listPlanModels(ai.fetch, credentials.accessToken)).toEqual([
      { slug: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
      { slug: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    ]);
    await expect(listPlanModels(ai.fetch, 'dead-token')).rejects.toMatchObject({ reauth: true });
  });
});

// --- the Responses adapter ------------------------------------------------------------------------------------------------
const conn = { provider: 'chatgpt_plan', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', headers: {}, options: {}, wire: 'responses' as const, capabilities: ['text', 'vision'], label: 'Mein ChatGPT-Abo' };
const FORBIDDEN = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id'];
const tools = [{ name: 'ghl_search_contacts', description: 'Kontakte suchen', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }];
const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({ connection: conn, system: 'Du bist ein Agent.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Finde Lena' }] }], tools, maxTokens: 4000, ...over });

describe('Responses request rules of the ChatGPT-plan route', () => {
  it('follows the preview limitations: store false, stream true, instructions, namespaced tools, no forbidden fields', () => {
    const body: any = responsesBody(req());
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', instructions: 'Du bist ein Agent.', store: false, stream: true, input: [{ role: 'user', content: 'Finde Lena' }] });
    for (const f of FORBIDDEN) expect(body, f).not.toHaveProperty(f);
    expect(body.input.some((i: any) => i.role === 'system')).toBe(false);
    expect(body.tools).toEqual([{ type: 'namespace', name: 'gohigh', description: expect.any(String), tools: [{ type: 'function', name: 'ghl_search_contacts', description: 'Kontakte suchen', parameters: tools[0].inputSchema }] }]);
    expect(body.tools.some((t: any) => t.type === 'function' || t.type === 'tool_search')).toBe(false);
    // the Denkstufe goes in as reasoning.effort for models that take it
    expect(body.reasoning).toEqual({ effort: 'xhigh' });
    expect(responsesBody(req({ tools: [] }))).not.toHaveProperty('tools');
  });

  it('replays tool calls and their results as function_call items and sends images as input_image', () => {
    const input = toResponsesInput(
      [
        { role: 'user', content: [{ type: 'text', text: 'Suche' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Ich suche.' }, { type: 'tool_call', id: 'call_1', name: 'ghl_search_contacts', args: { q: 'Lena' } }] },
        { role: 'user', content: [{ type: 'tool_result', id: 'call_1', name: 'ghl_search_contacts', content: '[]' }] },
      ],
      true,
    );
    expect(input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Suche' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
      { role: 'assistant', content: 'Ich suche.' },
      { type: 'function_call', call_id: 'call_1', name: 'ghl_search_contacts', namespace: 'gohigh', arguments: '{"q":"Lena"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '[]' },
    ]);
    expect(toResponsesInput([{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] }], false)[0].content).toContain('keine Bilder');
  });
});

describe('Responses stream', () => {
  const post = (r: ChatRequest) => chatWithTools(r, ai.fetch as any);
  const login = async () => {
    // an access token the fake accepts
    const p = newPkce();
    const cb = parseCallback(ai.consent(await buildAuthorizeUrl(ai.fetch, { hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', appName: 'HyperLevel', pkce: p })), p.state);
    const { credentials } = await exchangeCode(ai.fetch, { ...cb, verifier: p.verifier });
    return (u: string, i: any = {}) => ai.fetch(u, { ...i, headers: { ...(i.headers ?? {}), authorization: `Bearer ${credentials.accessToken}` } });
  };

  it('streams text, reads usage (cached tokens apart) and is dispatched by chatWithTools for wire "responses"', async () => {
    const f = await login();
    const deltas: string[] = [];
    const r = await chatWithTools(req({ onText: (d) => deltas.push(d) }), f as any);
    expect(r.text).toBe('Hallo Welt');
    expect(deltas.join('')).toBe('Hallo Welt');
    expect(r.usage).toEqual({ input_tokens: 100, output_tokens: 7, cache_read_tokens: 20, cache_write_tokens: 0 });
    expect(r.model).toBe('gpt-6.1-sol');
    expect(r.stopReason).toBe('stop');
    const sent = ai.calls.filter((c) => c.url.endsWith('/v1/responses')).pop()!;
    expect(sent.body).toMatchObject({ store: false, stream: true });
    expect(sent.headers.authorization).toMatch(/^Bearer at-secret-/);
    void post;
  });

  it('collects function calls from the stream (arguments in pieces) as tool calls', async () => {
    const f = await login();
    ai.responses = () => [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'ghl_search_contacts', namespace: 'gohigh', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"q":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"Lena"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'ghl_search_contacts', namespace: 'gohigh', arguments: '{"q":"Lena"}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 50, output_tokens: 9 } } },
    ];
    const r = await chatWithTools(req(), f as any);
    expect(r.toolCalls).toEqual([{ id: 'call_abc', name: 'ghl_search_contacts', args: { q: 'Lena' } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.message.content.find((p) => p.type === 'tool_call')).toMatchObject({ id: 'call_abc' });
  });

  it('turns the documented error codes into German messages with the right status', async () => {
    const f = await login();
    ai.responses = () => [{ type: 'response.created' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'x' }, usage: { input_tokens: 5, output_tokens: 0 } } }];
    await expect(chatWithTools(req(), f as any)).rejects.toMatchObject({ status: 429, code: 'rate_limit', message: expect.stringContaining('chatgpt.com/settings/usage') });
    ai.responses = () => new Response(JSON.stringify({ error: { code: 'subscription_sharing_user_not_eligible', message: 'no' } }), { status: 403 });
    await expect(chatWithTools(req(), f as any)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('API-Schlüssel') });
    ai.responses = () => new Response(JSON.stringify({ error: { code: 'subscription_sharing_unsupported_capability', param: 'tools[0]', message: 'no' } }), { status: 400 });
    await expect(chatWithTools(req(), f as any)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('tools[0]') });
    ai.responses = () => new Response(JSON.stringify({ detail: 'region not served' }), { status: 403 });
    await expect(chatWithTools(req(), f as any)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('region not served') });
    // a dead token: 401 from the direct route
    await expect(chatWithTools(req(), ((u: string, i: any) => ai.fetch(u, { ...i, headers: { authorization: 'Bearer dead' } })) as any)).rejects.toMatchObject({ status: 401, code: 'auth' });
    expect(planError(500, '', '').status).toBe(503);
  });

  it('fails a stream that ends before response.completed, and keeps partial text out of a "success"', async () => {
    const f = await login();
    ai.responses = () => [{ type: 'response.output_text.delta', delta: 'halb' }];
    await expect(chatWithTools(req(), f as any)).rejects.toMatchObject({ code: 'stream_interrupted' });
    ai.responses = () => [{ type: 'response.output_text.delta', delta: 'zu lang' }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }];
    const r = await chatWithTools(req(), f as any);
    expect(r.stopReason).toBe('length');
  });

  it('repeats the request once without the Denkstufe when the route rejects it', async () => {
    const f = await login();
    let n = 0;
    ai.responses = (body) => {
      n++;
      return body.reasoning ? new Response(JSON.stringify({ error: { message: 'Unsupported parameter: reasoning.effort' } }), { status: 400 }) : [{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: {} }];
    };
    const r = await chatWithTools(req(), f as any);
    expect(r.text).toBe('ok');
    expect(n).toBe(2);
    expect(r.usage.input_tokens).toBeGreaterThan(0);
    void chatResponses;
    void sse;
  });
});
