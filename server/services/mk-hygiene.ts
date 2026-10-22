import type { App } from '../core/app.js';
import { now, id } from '../core/util.js';
import { logActivity } from './contacts.js';
import { getSettings } from './mk-settings.js';
import { cleanDefinition, countMembers, type Group } from './mk-segments.js';
import { checkStatic, validateEmail, type Check } from './mk-validate.js';
import type { DnsResolver } from './umzug-mailcheck.js';

/**
 * List hygiene: addresses that keep failing softly (full mailbox, server trouble) are put on "Nicht stören" after a few
 * tries; contacts who got mail for months without ever opening it form the sunset segment; addresses are checked in the
 * background (syntax, domain, disposable, role) and the verdict is stored per contact for the campaigns to read.
 */

export const SOFT_WINDOW_DAYS = 90;

export interface Suspect {
  contact_id: string;
  email: string;
  name: string;
  count: number;
  last_at: string;
}

/**
 * Contacts with `limit` or more soft bounces (activity "email.failed" – the provider could not deliver and will not try again)
 * within 90 days and no mail that arrived or was opened after the last one. Contacts already on "Nicht stören" are left out.
 */
export function softBounceSuspects(app: App, locationId: string, limit: number): Suspect[] {
  const since = new Date(Date.now() - SOFT_WINDOW_DAYS * 864e5).toISOString();
  const rows = app.db.all<{ contact_id: string; n: number; last_at: string; email: string; first_name: string; last_name: string }>(
    `SELECT a.contact_id, COUNT(*) AS n, MAX(a.created_at) AS last_at, c.email, c.first_name, c.last_name
     FROM activities a JOIN contacts c ON c.id = a.contact_id
     WHERE a.location_id = ? AND a.type = 'email.failed' AND a.created_at >= ? AND c.dnd = 0
     GROUP BY a.contact_id HAVING COUNT(*) >= ? ORDER BY n DESC, last_at DESC LIMIT 1000`,
    locationId,
    since,
    limit,
  );
  const out: Suspect[] = [];
  for (const r of rows) {
    // A mail that went through since the last failure ends the series.
    const ok = app.db.get(
      `SELECT 1 FROM messages WHERE contact_id = ? AND channel = 'email' AND direction = 'out' AND created_at > ? AND (status = 'delivered' OR opened_at IS NOT NULL) LIMIT 1`,
      r.contact_id,
      r.last_at,
    );
    if (!ok) out.push({ contact_id: r.contact_id, email: r.email, name: [r.first_name, r.last_name].filter(Boolean).join(' '), count: Number(r.n), last_at: r.last_at });
  }
  return out;
}

/** Puts contacts on "Nicht stören" with a note in their activity log. Returns how many were changed. */
export function suppress(app: App, locationId: string, contactIds: string[], why: string): number {
  let n = 0;
  for (const cid of contactIds) {
    if (!app.db.run('UPDATE contacts SET dnd = 1, updated_at = ? WHERE id = ? AND location_id = ? AND dnd = 0', now(), cid, locationId).changes) continue;
    logActivity(app, locationId, cid, 'contact.dnd', `„Nicht stören“: ${why}`);
    n++;
  }
  return n;
}

/** The soft-bounce suspects of a sub-account go on „Nicht stören“ (the hourly sweep and the button in the dashboard). */
export function suppressSoftBounces(app: App, locationId: string, only?: string[]): { suppressed: number; limit: number } {
  const limit = getSettings(app, locationId).hygiene.soft_bounce_limit;
  const list = softBounceSuspects(app, locationId, limit).filter((s) => !only || only.includes(s.contact_id));
  return { suppressed: suppress(app, locationId, list.map((s) => s.contact_id), `${limit} Zustellversuche in Folge fehlgeschlagen (Soft Bounce)`), limit };
}

/** Segment definition of the sunset list: mail for N months, nothing opened or clicked. */
export const sunsetDefinition = (months: number): Group => cleanDefinition({ type: 'group', op: 'and', items: [{ type: 'engagement', state: 'inactive', days: Math.round(months * 30), min_received: 3 }, { type: 'dnd', value: false }] });

export const SUNSET_NAME = 'Sunset: lange nicht geöffnet';

/** Creates (or updates) the saved segment of contacts who have not engaged for N months. */
export function ensureSunsetSegment(app: App, locationId: string, months: number): { id: string; count: number } {
  const def = sunsetDefinition(months);
  const count = countMembers(app, locationId, def);
  const row = app.db.get<{ id: string }>('SELECT id FROM mk_segments WHERE location_id = ? AND name = ?', locationId, SUNSET_NAME);
  const description = `Automatisch angelegt: bekommen seit ${months} Monaten Mails, öffnen oder klicken aber nie. Vor dem Entfernen eine Re-Engagement-Mail senden.`;
  if (row) {
    app.db.run('UPDATE mk_segments SET definition = ?, description = ?, count = ?, counted_at = ?, updated_at = ? WHERE id = ?', JSON.stringify(def), description, count, now(), now(), row.id);
    return { id: row.id, count };
  }
  const sid = id();
  app.db.run(`INSERT INTO mk_segments (id, location_id, name, description, definition, watch, count, counted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`, sid, locationId, SUNSET_NAME, description, JSON.stringify(def), count, now(), now(), now());
  return { id: sid, count };
}

// --- address checks -------------------------------------------------------------------------------------------

export interface StoredCheck {
  contact_id: string;
  email: string;
  verdict: string;
  issues: Check['issues'];
  mx: number | null;
  checked_at: string;
}

/** Writes the verdict of a check for a contact (`email` is the address as stored on the contact, so a changed address is checked again). */
export function storeCheck(app: App, locationId: string, contactId: string, email: string, c: Check) {
  app.db.run(
    `INSERT INTO mk_email_checks (contact_id, location_id, email, verdict, issues, role, disposable, mx, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(contact_id) DO UPDATE SET location_id = excluded.location_id, email = excluded.email, verdict = excluded.verdict, issues = excluded.issues, role = excluded.role, disposable = excluded.disposable, mx = excluded.mx, checked_at = excluded.checked_at`,
    contactId,
    locationId,
    email,
    c.verdict,
    JSON.stringify(c.issues),
    c.role ? 1 : 0,
    c.disposable ? 1 : 0,
    c.mx === null ? null : c.mx ? 1 : 0,
    now(),
  );
}

/** Checks addresses of contacts that have no verdict yet (or whose address changed). `resolver` null = no DNS lookups. */
export async function validatePending(app: App, opts: { locationId?: string; limit?: number; resolver?: DnsResolver | null; retryDns?: boolean } = {}): Promise<{ checked: number; invalid: number; left: boolean }> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 25));
  const retry = new Date(Date.now() - 864e5).toISOString();
  // Sub-accounts that switched the background check off are left out of the global scan (an explicit call for one still checks it).
  const scope = opts.locationId ? ' AND c.location_id = ?' : ` AND NOT EXISTS (SELECT 1 FROM mk_settings s WHERE s.location_id = c.location_id AND json_extract(s.data, '$.validation.auto') = 0)`;
  const rows = app.db.all<{ id: string; location_id: string; email: string }>(
    `SELECT c.id, c.location_id, c.email FROM contacts c LEFT JOIN mk_email_checks k ON k.contact_id = c.id
     WHERE c.email != ''${scope} AND (k.contact_id IS NULL OR k.email != c.email${opts.retryDns && opts.resolver ? ` OR (k.mx IS NULL AND k.verdict != 'invalid' AND k.checked_at < ?)` : ''}) LIMIT ?`,
    ...(opts.locationId ? [opts.locationId] : []),
    ...(opts.retryDns && opts.resolver ? [retry] : []),
    limit + 1,
  );
  let invalid = 0;
  const settings = new Map<string, ReturnType<typeof getSettings>>();
  let checked = 0;
  for (const r of rows.slice(0, limit)) {
    const s = settings.get(r.location_id) ?? getSettings(app, r.location_id);
    settings.set(r.location_id, s);
    const c = await validateEmail(r.email, s.validation.mx ? opts.resolver : null);
    storeCheck(app, r.location_id, r.id, r.email, c);
    checked++;
    if (c.verdict === 'invalid') invalid++;
  }
  return { checked, invalid, left: rows.length > limit };
}

/**
 * The contacts a campaign must skip because of their address, with the reason. Syntax and domain are checked right here (no
 * network), a stored "no mail server" verdict counts too; disposable and role addresses only if the sub-account says so.
 */
export function addressBlocks(app: App, locationId: string, contacts: { id: string; email: string }[]): Map<string, string> {
  const s = getSettings(app, locationId).validation;
  const out = new Map<string, string>();
  if (!s.exclude_invalid && !s.exclude_disposable && !s.exclude_role) return out;
  const stored = new Map<string, { email: string; verdict: string; issues: string }>();
  for (let i = 0; i < contacts.length; i += 400) {
    const chunk = contacts.slice(i, i + 400);
    for (const r of app.db.all<{ contact_id: string; email: string; verdict: string; issues: string }>(`SELECT contact_id, email, verdict, issues FROM mk_email_checks WHERE location_id = ? AND contact_id IN (${chunk.map(() => '?').join(',')})`, locationId, ...chunk.map((c) => c.id))) stored.set(r.contact_id, r);
  }
  for (const c of contacts) {
    const st = checkStatic(c.email);
    if (s.exclude_invalid) {
      const err = st.issues.find((i) => i.level === 'error');
      if (err) {
        out.set(c.id, `E-Mail-Adresse ungültig: ${err.text}`);
        continue;
      }
      const row = stored.get(c.id);
      if (row && row.email === c.email && row.verdict === 'invalid') {
        const issues: Check['issues'] = JSON.parse(row.issues || '[]');
        out.set(c.id, `E-Mail-Adresse ungültig: ${issues.find((i) => i.level === 'error')?.text ?? 'kann keine E-Mails empfangen'}`);
        continue;
      }
    }
    if (s.exclude_disposable && st.disposable) out.set(c.id, 'E-Mail-Adresse ist eine Wegwerf-Adresse');
    else if (s.exclude_role && st.role) out.set(c.id, 'E-Mail-Adresse ist eine Funktionsadresse (z. B. info@)');
  }
  return out;
}

export interface Summary {
  total: number;
  checked: number;
  ok: number;
  risky: number;
  invalid: number;
  unchecked: number;
  disposable: number;
  role: number;
}

/** Counts of the address checks of a sub-account (contacts with an address). */
export function checkSummary(app: App, locationId: string): Summary {
  const total = Number(app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts WHERE location_id = ? AND email != ''`, locationId)?.n ?? 0);
  const r = app.db.get<any>(
    `SELECT COUNT(*) AS checked, SUM(k.verdict = 'ok') AS ok, SUM(k.verdict = 'risky') AS risky, SUM(k.verdict = 'invalid') AS invalid, SUM(k.disposable) AS disposable, SUM(k.role) AS role
     FROM mk_email_checks k JOIN contacts c ON c.id = k.contact_id AND c.email = k.email WHERE k.location_id = ? AND c.location_id = ?`,
    locationId,
    locationId,
  );
  const n = (v: unknown) => Number(v) || 0;
  return { total, checked: n(r?.checked), ok: n(r?.ok), risky: n(r?.risky), invalid: n(r?.invalid), unchecked: Math.max(0, total - n(r?.checked)), disposable: n(r?.disposable), role: n(r?.role) };
}
