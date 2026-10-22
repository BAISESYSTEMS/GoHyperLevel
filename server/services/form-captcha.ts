import type { App } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { openSecret } from '../core/secrets.js';

/**
 * Cloudflare Turnstile as an optional captcha (off by default, own keys per sub-account – the secret key is sealed in the database and never
 * returned). The form page shows the widget; the server checks the token before it stores anything. The honeypot stays on either way.
 */

export const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface CaptchaKeys {
  site_key: string;
  secret: string;
}

export function captchaKeys(app: App, locationId: string): CaptchaKeys | null {
  const row = app.db.get<{ site_key: string; secret_sealed: string }>('SELECT site_key, secret_sealed FROM form_captcha WHERE location_id = ?', locationId);
  if (!row?.site_key || !row.secret_sealed) return null;
  try {
    return { site_key: row.site_key, secret: openSecret(app, row.secret_sealed) };
  } catch {
    return null;
  }
}

export type TurnstileFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/**
 * Asks Cloudflare whether a token is good. Throws a 400 for a wrong or used token and a 503 when Cloudflare cannot be asked (the form stays
 * closed then – a captcha that lets everybody in when it is unreachable protects nothing).
 */
export async function verifyTurnstile(app: App, secret: string, token: unknown, ip: string): Promise<void> {
  const t = String(token ?? '').trim();
  if (!t || t.length > 2048) throw new HttpError(400, 'Bitte die Sicherheitsprüfung abschließen.');
  const f: TurnstileFetch = (app.services.turnstileFetch as TurnstileFetch | undefined) ?? ((url, init) => fetch(url, init));
  let json: any;
  try {
    const r = await f(TURNSTILE_VERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: t, ...(ip ? { remoteip: ip } : {}) }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    json = await r.json();
  } catch (e) {
    console.error('[forms] turnstile', (e as Error).message);
    throw new HttpError(503, 'Die Sicherheitsprüfung ist gerade nicht erreichbar. Bitte in einer Minute noch einmal versuchen.');
  }
  if (json?.success !== true) {
    const codes: string[] = Array.isArray(json?.['error-codes']) ? json['error-codes'] : [];
    // A wrong secret key is the owner's problem, not the visitor's: say so in the log.
    if (codes.some((c) => c === 'invalid-input-secret' || c === 'missing-input-secret')) console.error('[forms] turnstile: der geheime Schlüssel wurde abgelehnt');
    throw new HttpError(400, 'Die Sicherheitsprüfung ist fehlgeschlagen. Bitte versuche es noch einmal.');
  }
}
