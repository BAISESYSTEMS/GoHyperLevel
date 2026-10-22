import type { App } from '../core/app.js';
import { lookup } from '../core/template.js';
import { connectorFetch } from './connectors.js';
import type { ActionOutcome } from './workflow-engine.js';
import { assign, preview, requireText, rowsOf, text, type ActionDef, type FieldDef } from './wfx-kit.js';

/**
 * Workflow step "HTTP-Anfrage": any method, headers, JSON/form/text body, Bearer/Basic/API-key auth, retries with
 * backoff on 429/5xx/network errors, and a response mapping that puts values of the answer into variables or contact
 * fields. All requests go through safeFetch (no internal network targets, timeouts, size limit) – tests swap it via
 * `app.services.connectorFetch`.
 */

export const MAX_RETRIES = 5;
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token|apikey)$/i;

/** The pause before retry number `attempt` (1-based): 1 s, 2 s, 4 s … plus up to 25 % jitter, or the server's Retry-After (max 30 s). */
export function backoffMs(attempt: number, retryAfter?: string | string[] | undefined, rnd: () => number = Math.random): number {
  const ra = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.min(30_000, Math.max(0, secs * 1000));
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return Math.min(30_000, Math.max(0, at - Date.now()));
  }
  const base = Math.min(16_000, 1000 * 2 ** (attempt - 1));
  return Math.round(base + base * 0.25 * rnd());
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export function httpActions(app: App): ActionDef[] {
  const sleep: (ms: number) => Promise<void> = (ms) => (app.services.wfxSleep ? app.services.wfxSleep(ms) : new Promise((r) => setTimeout(r, ms)));
  const TARGET: FieldDef = { key: 'to', label: 'Speichern in', type: 'target', default: 'var.' };

  const def: ActionDef = {
    meta: {
      type: 'http_request',
      label: 'HTTP-Anfrage (Webhook mit Antwort)',
      category: 'integration',
      icon: 'webhook',
      summary: 'Ruft eine URL auf – mit eigenen Headern, Body, Wiederholungen und Übernahme der Antwort in Felder.',
      doc: 'Methode, URL, Header, Body (JSON, Formular oder Text) und Anmeldung (Bearer, Basic oder API-Key-Header) mit Platzhaltern. Bei Fehlern (429, 5xx, Verbindungsabbruch) wird bis zu 5-mal wiederholt: 1, 2, 4 … Sekunden, „Retry-After“ des Servers wird beachtet. Die Antwort steht als {{var.response.data.…}} bereit (Name einstellbar); „Antwort übernehmen“ legt einzelne Werte direkt in Variablen oder Kontaktfelder: Pfad data.items.0.id, oder $status, $text, $headers.name. Interne Netzwerkziele sind gesperrt. Zugangsdaten gehören besser in Apps → Direkt-Verbindungen; Header mit Schlüsseln werden in Protokoll und Export unkenntlich gemacht.',
      keywords: 'http request api webhook rest post get response antwort retry',
      fields: [
        { key: 'method', label: 'Methode', type: 'select', options: [['GET', 'GET'], ['POST', 'POST'], ['PUT', 'PUT'], ['PATCH', 'PATCH'], ['DELETE', 'DELETE']], default: 'POST' },
        { key: 'url', label: 'URL', type: 'text', placeholder: 'https://api.example.com/leads', required: true },
        { key: 'query', label: 'Query-Parameter', type: 'rows', addLabel: '+ Parameter', rows: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'value', label: 'Wert', type: 'text' }] },
        { key: 'headers', label: 'Header', type: 'rows', addLabel: '+ Header', rows: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'value', label: 'Wert', type: 'text' }] },
        { key: 'auth', label: 'Anmeldung', type: 'select', options: [['none', 'Keine'], ['bearer', 'Bearer-Token'], ['basic', 'Benutzer und Passwort (Basic)'], ['header', 'API-Key im Header']], default: 'none' },
        { key: 'auth_user', label: 'Benutzer / Header-Name', type: 'text', showIf: { field: 'auth', in: ['basic', 'header'] } },
        { key: 'auth_secret', label: 'Token / Passwort / Key', type: 'text', showIf: { field: 'auth', in: ['bearer', 'basic', 'header'] } },
        { key: 'body_type', label: 'Body', type: 'select', options: [['none', 'Kein Body'], ['json', 'JSON'], ['form', 'Formular (key=value)'], ['text', 'Text']], default: 'json' },
        { key: 'body', label: 'Body-Inhalt', type: 'code', default: '{"email": "{{contact.email}}", "name": "{{contact.name}}"}', showIf: { field: 'body_type', in: ['json', 'form', 'text'] } },
        { key: 'retries', label: 'Wiederholungen bei Fehlern', type: 'number', default: 2, help: '0 bis 5' },
        { key: 'timeout_s', label: 'Zeitlimit je Versuch (Sekunden)', type: 'number', default: 15 },
        { key: 'fail_on_error', label: 'Bei Fehlerstatus (4xx/5xx) den Schritt als Fehler werten', type: 'bool', default: true },
        { key: 'response_var', label: 'Antwort speichern als Variable', type: 'text', default: 'response', help: 'Leer = nicht speichern.' },
        { key: 'map', label: 'Antwort übernehmen', type: 'rows', addLabel: '+ Wert', rows: [{ key: 'path', label: 'Pfad in der Antwort', type: 'text', placeholder: 'data.id  ·  $status' }, TARGET] },
      ],
      provides: ['var.response'],
      sample: { method: 'POST', url: 'https://api.example.com/leads', body_type: 'json', body: '{"email":"{{contact.email}}"}', retries: 2, map: [{ path: 'id', to: 'custom.crm_id' }] },
    },
    run: async (run, step, vars) => {
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(step.method)) ? String(step.method) : 'POST';
      const rawUrl = requireText(text(step.url, vars), 'URL');
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        throw new Error('Die URL ist ungültig');
      }
      if (!/^https?:$/.test(url.protocol)) throw new Error('Nur http(s)-Adressen');
      for (const q of rowsOf<{ name: string; value: string }>(step.query, ['name'], 30)) url.searchParams.append(text(q.name, vars), text(q.value, vars));
      const headers: Record<string, string> = {};
      for (const h of rowsOf<{ name: string; value: string }>(step.headers, ['name'], 30)) {
        const n = text(h.name, vars).trim();
        if (/^[\w-]{1,60}$/.test(n)) headers[n.toLowerCase()] = text(h.value, vars).replace(/[\r\n]+/g, ' ');
      }
      const secret = text(step.auth_secret, vars);
      if (step.auth === 'bearer' && secret) headers.authorization = `Bearer ${secret}`;
      else if (step.auth === 'basic') headers.authorization = `Basic ${Buffer.from(`${text(step.auth_user, vars)}:${secret}`).toString('base64')}`;
      else if (step.auth === 'header' && secret && /^[\w-]{1,60}$/.test(text(step.auth_user, vars))) headers[text(step.auth_user, vars).toLowerCase()] = secret;
      let body: string | undefined;
      const bt = String(step.body_type ?? 'json');
      if (method !== 'GET' && bt !== 'none') {
        const rendered = text(step.body, vars);
        if (bt === 'json') {
          try {
            JSON.parse(rendered);
          } catch {
            throw new Error('Der Body ist kein gültiges JSON (nach dem Einsetzen der Platzhalter)');
          }
          headers['content-type'] ??= 'application/json';
        } else if (bt === 'form') {
          headers['content-type'] ??= 'application/x-www-form-urlencoded';
        } else headers['content-type'] ??= 'text/plain; charset=utf-8';
        body = bt === 'form' ? new URLSearchParams(rendered.split(/\r?\n|&/).filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string])).toString() : rendered;
        if (body.length > 1_000_000) throw new Error('Body zu groß (über 1 MB)');
      }
      const retries = Math.min(MAX_RETRIES, Math.max(0, Math.floor(Number(step.retries ?? 2))));
      const timeoutMs = Math.min(30_000, Math.max(1000, (Number(step.timeout_s) || 15) * 1000));
      const fetcher = connectorFetch(app);
      let res: { status: number; ok: boolean; headers: Record<string, any>; text: () => Promise<string> } | null = null;
      let lastError = '';
      let attempts = 0;
      for (let attempt = 0; attempt <= retries; attempt++) {
        attempts++;
        try {
          res = await fetcher(url.toString(), { method, headers, body, timeoutMs, maxBytes: 1024 * 1024 });
          if (!RETRYABLE.has(res.status) || attempt === retries) break;
          lastError = `HTTP ${res.status}`;
          await sleep(backoffMs(attempt + 1, res.headers['retry-after'], app.services.wfxRandom));
        } catch (e) {
          res = null;
          lastError = (e as Error).message;
          // a refused target (internal network) will not get better
          if (/interne|gesperrt|Ungültige URL|Nur http/.test(lastError) || attempt === retries) break;
          await sleep(backoffMs(attempt + 1, undefined, app.services.wfxRandom));
        }
      }
      if (!res) throw new Error(`${method} ${url.origin}${url.pathname}: ${lastError} (${attempts} Versuch${attempts === 1 ? '' : 'e'})`);
      const raw = await res.text();
      let data: unknown = raw;
      const ct = String(res.headers['content-type'] ?? '');
      if (/json/i.test(ct) || /^\s*[[{]/.test(raw)) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
      }
      const safeHeaders = Object.fromEntries(Object.entries(res.headers).filter(([k]) => !/^(set-cookie|authorization)$/i.test(k)).slice(0, 30).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]));
      const response = { status: res.status, ok: res.ok, data, headers: safeHeaders };
      const out: ActionOutcome = { result: '', output: { status: res.status, data: typeof data === 'string' ? data.slice(0, 800) : data } };
      const rv = String(step.response_var ?? 'response').trim();
      if (rv && /^[A-Za-z_]\w{0,40}$/.test(rv)) out.vars = { [rv]: typeof data === 'string' && data.length > 20_000 ? { ...response, data: data.slice(0, 20_000), truncated: true } : response };
      const mapped: string[] = [];
      const missing: string[] = [];
      for (const m of rowsOf<{ path: string; to: string }>(step.map, ['path'], 30)) {
        const p = String(m.path).trim();
        let v: unknown;
        if (p === '$status') v = res.status;
        else if (p === '$text' || p === '$body') v = raw.slice(0, 10_000);
        else if (p.startsWith('$headers.')) v = safeHeaders[p.slice(9).toLowerCase()];
        else v = lookup(data, p.replace(/^\$\.?/, ''));
        if (v === undefined || v === null) missing.push(p);
        else {
          assign(out, m.to, typeof v === 'object' ? v : v);
          mapped.push(p);
        }
      }
      const retried = attempts > 1 ? ` nach ${attempts} Versuchen` : '';
      out.result = `${method} ${url.host}${url.pathname} → ${res.status}${retried}${mapped.length ? ` · übernommen: ${mapped.join(', ')}` : ''}${missing.length ? ` · nicht gefunden: ${missing.join(', ')}` : ''}`;
      if (!res.ok && step.fail_on_error !== false) throw new Error(`${method} ${url.host}${url.pathname} → HTTP ${res.status}${retried}: ${preview(raw.replace(/\s+/g, ' '), 120)}`);
      return out;
    },
  };
  return [def];
}

/** The settings of an `http_request` step without the secrets (for export and sharing). */
export function stripHttpSecrets(step: Record<string, any>): Record<string, any> {
  if (step.type !== 'http_request') return step;
  const out = { ...step };
  if (out.auth_secret) out.auth_secret = '';
  if (Array.isArray(out.headers)) out.headers = out.headers.map((h: any) => (h && SENSITIVE_HEADER.test(String(h.name ?? '').trim()) ? { ...h, value: '' } : h));
  return out;
}
