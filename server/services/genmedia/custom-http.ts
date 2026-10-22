import { authFor, baseOf, ensureOk, pathGet, urlsIn, withQuery } from './http.js';
import { sniff } from './media.js';
import { ProviderError, type Adapter, type AdapterCtx, type HttpTemplate, type Output, type Step } from './types.js';

/**
 * Custom HTTP template ("Eigener Anbieter"): any provider without code. URL, method, headers and a
 * JSON body with placeholders; where the media URL (or base64) sits in the answer; optional polling
 * (status URL built from the first answer, done/fail conditions, interval). The key comes from the
 * connection (auth style) or a {{api_key}} placeholder in URL/headers – never in a stored template.
 */

const MAX_BODY = 20_000;

export function templateVars(ctx: AdapterCtx, extra: Record<string, any> = {}): Record<string, any> {
  const i = ctx.input;
  return {
    prompt: i.prompt,
    negative_prompt: i.negative_prompt,
    aspect_ratio: i.aspect_ratio,
    duration: i.duration,
    seed: i.seed,
    voice: i.voice,
    language: i.language,
    model: ctx.model,
    image_url: i.image?.url,
    audio_url: i.audio?.url,
    video_url: i.video?.url,
    params: i.params ?? {},
    ...extra,
  };
}

const lookup = (vars: Record<string, any>, path: string) => pathGet(vars, path)[0];

/** URL/header template: `{{x}}` at the very start is inserted as is (a full URL), elsewhere URL-encoded. */
export function renderText(tpl: string, vars: Record<string, any>, opts: { url?: boolean; key?: string } = {}): string {
  return String(tpl ?? '').replace(/\{\{\s*([\w.[\]*]+)\s*\}\}/g, (_m, path: string, offset: number) => {
    let v: any;
    if (path === 'api_key') {
      if (opts.key === undefined) throw new ProviderError('{{api_key}} geht nur in Adresse und Kopfzeilen');
      v = opts.key;
    } else v = lookup(vars, path);
    if (v === undefined || v === null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return opts.url && offset > 0 ? encodeURIComponent(s) : s;
  });
}

/**
 * JSON template: placeholders inside strings are escaped; a placeholder that is a whole string
 * (`"{{seed}}"`) or stands outside strings keeps its JSON type (numbers, objects, null when empty).
 */
export function renderJson(tpl: string, vars: Record<string, any>): any {
  let out = '';
  let inStr = false;
  let strStart = -1;
  for (let i = 0; i < tpl.length; i++) {
    const c = tpl[i];
    if (c === '{' && tpl[i + 1] === '{') {
      const end = tpl.indexOf('}}', i + 2);
      if (end < 0) throw new ProviderError('Vorlage: „}}“ fehlt');
      const path = tpl.slice(i + 2, end).trim();
      if (!/^[\w.[\]*]+$/.test(path)) throw new ProviderError(`Vorlage: Platzhalter „${path}“ ungültig`);
      if (path === 'api_key') throw new ProviderError('{{api_key}} geht nur in Adresse und Kopfzeilen');
      const v = lookup(vars, path);
      const wholeString = inStr && strStart === out.length - 1 && tpl[end + 2] === '"';
      if (wholeString) {
        out = out.slice(0, -1) + JSON.stringify(v ?? null);
        inStr = false;
        i = end + 2; // skip the closing quote
        continue;
      }
      if (inStr) out += v === undefined || v === null ? '' : JSON.stringify(typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(1, -1);
      else out += JSON.stringify(v ?? null);
      i = end + 1;
      continue;
    }
    if (c === '"' && !(inStr && isEscaped(tpl, i))) {
      inStr = !inStr;
      if (inStr) strStart = out.length;
    }
    out += c;
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new ProviderError('Vorlage: der Body ist nach dem Einsetzen kein gültiges JSON');
  }
}

function isEscaped(s: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) n++;
  return n % 2 === 1;
}

const ok = (v: any, list: string[]) => list.some((x) => String(x).toLowerCase() === String(v).toLowerCase());

function extract(ctx: AdapterCtx, tpl: HttpTemplate, data: any, path?: string): Step {
  if (ctx.capability === 'stt') {
    const text = pathGet(data, tpl.text_path || 'text')[0];
    return typeof text === 'string' ? { status: 'done', outputs: [], text } : { status: 'failed', error: `Kein Text unter „${tpl.text_path || 'text'}“ in der Antwort` };
  }
  const p = path || tpl.result_path || '';
  if (!p) return { status: 'failed', error: 'In der Vorlage fehlt der Ergebnis-Pfad' };
  const found = pathGet(data, p);
  let outputs: Output[] = [];
  if (tpl.result_type === 'base64') {
    outputs = found
      .filter((v) => typeof v === 'string' && v.length > 16)
      .map((v: string) => ({ data: Buffer.from(v.replace(/^data:[\w/+.-]+;base64,/, ''), 'base64'), mime: tpl.result_mime }));
  } else outputs = urlsIn(found).map((url) => ({ url }));
  return outputs.length ? { status: 'done', outputs } : { status: 'failed', error: `Keine Datei unter „${p}“ in der Antwort` };
}

function target(ctx: AdapterCtx, tplUrl: string, vars: Record<string, any>): string {
  const auth = authFor(ctx.conn, 'bearer');
  const u = renderText(tplUrl, vars, { url: true, key: ctx.conn.apiKey });
  const full = /^https?:\/\//i.test(u) ? u : `${baseOf(ctx.conn, '')}${u.startsWith('/') ? '' : '/'}${u}`;
  if (!/^https?:\/\//i.test(full)) throw new ProviderError('Vorlage: Adresse braucht https:// oder eine Basis-Adresse in der Verbindung');
  return withQuery(full, auth.query);
}

function headersFor(ctx: AdapterCtx, extra: Record<string, string> | undefined, vars: Record<string, any>): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json, */*', ...authFor(ctx.conn, 'bearer').headers };
  for (const [k, v] of Object.entries(extra ?? {})) h[k.toLowerCase()] = renderText(String(v), vars, { key: ctx.conn.apiKey });
  return h;
}

async function send(ctx: AdapterCtx, method: string, url: string, headers: Record<string, string>, body: any) {
  const hasBody = method !== 'GET' && body !== undefined;
  const r = await ctx.fetch(url, { method, headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...headers }, body: hasBody ? JSON.stringify(body) : undefined, timeoutMs: 180_000, maxBytes: 60 * 1024 * 1024 });
  ensureOk(r, 'Eigener Anbieter');
  return r;
}

export const customHttpAdapter: Adapter = {
  id: 'custom_http',
  label: 'Eigener Anbieter (HTTP-Vorlage)',
  capabilities: ['image', 'video', 'audio_tts', 'audio_music', 'stt'],
  defaultBase: '',
  defaultAuth: 'bearer',
  models: {},
  async submit(ctx): Promise<Step> {
    const tpl = ctx.template;
    if (!tpl?.url) throw new ProviderError('Für diese Verbindung fehlt eine HTTP-Vorlage (KI-Studio → Eigene Anbieter)');
    const vars = templateVars(ctx);
    const method = tpl.method ?? 'POST';
    const body = method === 'GET' ? undefined : tpl.body?.trim() ? renderJson(tpl.body, vars) : { prompt: ctx.input.prompt, ...(ctx.input.params ?? {}) };
    const r = await send(ctx, method, target(ctx, tpl.url, vars), headersFor(ctx, tpl.headers, vars), body);
    const type = r.headers['content-type'] ?? '';
    if (!type.includes('json')) {
      // Some APIs answer with the file itself (e.g. text-to-speech).
      if (sniff(r.body, type)) return { status: 'done', outputs: [{ data: r.body, mime: type.split(';')[0] }] };
      throw new ProviderError('Eigener Anbieter: Antwort ist weder JSON noch eine Mediendatei');
    }
    const data = r.json();
    if (tpl.poll?.url) {
      const keep = JSON.stringify(data ?? {});
      if (keep.length > MAX_BODY) throw new ProviderError('Eigener Anbieter: erste Antwort ist zu groß zum Merken');
      return { status: 'pending', state: { response: data }, pollAfterMs: Math.max(2, Math.min(120, tpl.poll.interval_s ?? 5)) * 1000 };
    }
    return extract(ctx, tpl, data);
  },
  async poll(ctx, state): Promise<Step> {
    const tpl = ctx.template;
    if (!tpl?.poll?.url) throw new ProviderError('Vorlage ohne Abfrage');
    const vars = templateVars(ctx, { response: state.response ?? {} });
    const method = tpl.poll.method ?? 'GET';
    const body = method === 'POST' && tpl.poll.body?.trim() ? renderJson(tpl.poll.body, vars) : undefined;
    const r = await send(ctx, method, target(ctx, tpl.poll.url, vars), headersFor(ctx, tpl.headers, vars), body);
    const data = r.json();
    if (data === null) throw new ProviderError('Eigener Anbieter: Abfrage-Antwort ist kein JSON');
    const status = pathGet(data, tpl.poll.done_path)[0];
    if (status !== undefined && ok(status, tpl.poll.done_values ?? [])) return extract(ctx, tpl, data, tpl.poll.result_path);
    if (tpl.poll.fail_path) {
      const f = pathGet(data, tpl.poll.fail_path)[0];
      if (f !== undefined && ok(f, tpl.poll.fail_values ?? ['failed', 'error', 'true'])) {
        const err = tpl.poll.error_path ? pathGet(data, tpl.poll.error_path)[0] : f;
        return { status: 'failed', error: `Eigener Anbieter: ${String(err ?? 'fehlgeschlagen').slice(0, 300)}` };
      }
    }
    return { status: 'pending', state, pollAfterMs: Math.max(2, Math.min(120, tpl.poll.interval_s ?? 5)) * 1000 };
  },
};

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Validates a template the user saves (throws ProviderError with a German message). */
export function cleanTemplate(raw: any): HttpTemplate {
  const t = raw ?? {};
  const url = str(t.url, 1000);
  if (!url || !(/^https?:\/\//i.test(url) || url.startsWith('/'))) throw new ProviderError('Adresse mit https:// oder als Pfad ab der Basis-Adresse (/v1/…) angeben');
  const method = ['GET', 'POST', 'PUT'].includes(String(t.method).toUpperCase()) ? (String(t.method).toUpperCase() as HttpTemplate['method']) : 'POST';
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.headers && typeof t.headers === 'object' ? t.headers : {}).slice(0, 20)) {
    if (!/^[A-Za-z0-9-]{1,60}$/.test(k)) throw new ProviderError(`Kopfzeile „${k}“ ungültig`);
    if (/^(host|content-length|cookie)$/i.test(k)) throw new ProviderError(`Kopfzeile „${k}“ ist nicht erlaubt`);
    headers[k] = str(v, 2000);
  }
  const body = typeof t.body === 'string' ? t.body.slice(0, MAX_BODY) : t.body && typeof t.body === 'object' ? JSON.stringify(t.body, null, 2) : '';
  const sample = { prompt: 'Test "mit" Anführungszeichen', negative_prompt: '', aspect_ratio: '1:1', duration: 5, seed: 1, voice: 'v', language: 'de', model: 'm', image_url: 'https://example.com/a.png', audio_url: 'https://example.com/a.mp3', video_url: '', params: { a: 1 }, response: { id: 'x' } };
  if (body.trim()) renderJson(body, sample);
  const out: HttpTemplate = { url, method, headers, body, result_path: str(t.result_path, 200), result_type: t.result_type === 'base64' ? 'base64' : 'url', result_mime: str(t.result_mime, 60) || undefined, text_path: str(t.text_path, 200) || undefined };
  if (t.poll && typeof t.poll === 'object' && str(t.poll.url, 1000)) {
    const p = t.poll;
    const pollUrl = str(p.url, 1000);
    if (!(/^https?:\/\//i.test(pollUrl) || pollUrl.startsWith('/') || pollUrl.startsWith('{{'))) throw new ProviderError('Abfrage-Adresse mit https://, als Pfad oder mit {{response.…}} angeben');
    const doneValues = (Array.isArray(p.done_values) ? p.done_values : String(p.done_values ?? '').split(',')).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 10);
    if (!str(p.done_path, 200) || !doneValues.length) throw new ProviderError('Für die Abfrage: Status-Pfad und „fertig“-Werte angeben');
    const failValues = (Array.isArray(p.fail_values) ? p.fail_values : String(p.fail_values ?? '').split(',')).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 10);
    out.poll = {
      url: pollUrl,
      method: String(p.method).toUpperCase() === 'POST' ? 'POST' : 'GET',
      body: typeof p.body === 'string' ? p.body.slice(0, MAX_BODY) : undefined,
      done_path: str(p.done_path, 200),
      done_values: doneValues,
      fail_path: str(p.fail_path, 200) || undefined,
      fail_values: failValues.length ? failValues : undefined,
      error_path: str(p.error_path, 200) || undefined,
      interval_s: Math.max(2, Math.min(120, Number(p.interval_s) || 5)),
      result_path: str(p.result_path, 200) || undefined,
    };
    if (out.poll.body?.trim()) renderJson(out.poll.body, sample);
  }
  if (!out.result_path && !out.text_path) throw new ProviderError('Ergebnis-Pfad angeben (wo steht die Datei-URL in der Antwort?)');
  return out;
}
