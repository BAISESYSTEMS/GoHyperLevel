import type { App } from '../../core/app.js';
import { escapeHtml, textToHtml } from '../../core/template.js';
import { id as newId, now, uniq } from '../../core/util.js';
import { getBranding } from '../../modules/agency.js';
import { loadFeedbackSettings } from '../feedback-store.js';
import { deliverEmail } from '../messaging.js';

/**
 * Tells people what happens to their orders: a note in the app (the strip on the Werkstatt page and the badge in
 * the menu), a push notification (with action buttons where it makes sense) and – for decisions that someone is
 * waiting for – an email with links. Nothing here ever changes anything by itself: the links open the order in the
 * app, where "Freigeben" or "Ablehnen" is a button the admin presses after reading the plan.
 */

export interface Tell {
  userIds: (string | null | undefined)[];
  kind: 'plan' | 'approval' | 'decision' | 'done' | 'failed' | 'alarm';
  title: string;
  body?: string;
  /** Path in the web app, without query. */
  path: string;
  buildId?: string;
  /** Sub-account the order lives in (opens the right one when an admin clicks). */
  locationId?: string;
  /** Push action buttons: `?action=` is appended to `path`. */
  actions?: { action: 'approve' | 'reject' | 'rollback'; title: string }[];
  /** Also send an email (to everyone who did not switch feedback emails off). */
  email?: boolean;
}

const q = (path: string, locationId?: string, action?: string) => {
  const params = new URLSearchParams();
  if (locationId) params.set('loc', locationId);
  if (action) params.set('action', action);
  const s = params.toString();
  return `${path}${s ? `?${s}` : ''}`;
};

export async function tell(app: App, t: Tell): Promise<void> {
  const { db } = app;
  const ids = uniq(t.userIds.filter((x): x is string => !!x)).filter((u) => db.get('SELECT 1 FROM users WHERE id = ?', u));
  if (!ids.length) return;
  const body = String(t.body ?? '').slice(0, 400);
  const url = q(t.path, t.locationId);
  // 1. in the app
  try {
    for (const u of ids) {
      const nid = newId();
      db.insert('werkstatt_notices', { id: nid, user_id: u, build_id: t.buildId ?? null, kind: t.kind, title: t.title.slice(0, 200), body, url, read_at: null, created_at: now() });
      // The phone app's local notifications read the same note from its feed (type "werkstatt"; apps that do not know it skip it).
      if (t.locationId) app.services.mobileFeed?.({ locationId: t.locationId, type: 'werkstatt', area: '', userId: u, title: t.title, body, link: url, ref: `werkstatt:${nid}` });
      db.run(`DELETE FROM werkstatt_notices WHERE user_id = ? AND id NOT IN (SELECT id FROM werkstatt_notices WHERE user_id = ? ORDER BY created_at DESC LIMIT 100)`, u, u);
    }
  } catch (e) {
    console.error('[werkstatt] notice', (e as Error).message);
  }
  // 2. push (the app's service worker shows the action buttons and opens the link with ?action=…)
  try {
    await Promise.resolve(
      app.services.pushNotify?.({
        userIds: ids,
        ...(t.locationId ? { locationId: t.locationId } : {}),
        kind: 'werkstatt',
        title: t.title,
        body,
        url,
        tag: t.buildId ? `build-${t.buildId}` : undefined,
        urgency: t.kind === 'approval' || t.kind === 'alarm' ? 'high' : 'normal',
        ...(t.actions?.length ? { actions: t.actions.map((a) => ({ action: a.action, title: a.title, url: q(t.path, t.locationId, a.action) })) } : {}),
      }),
    );
  } catch (e) {
    console.error('[werkstatt] push', (e as Error).message);
  }
  // 3. email
  if (!t.email) return;
  const supportLoc = loadFeedbackSettings(app).support_location_id;
  const loc = app.location(supportLoc && app.location(supportLoc) ? supportLoc : (t.locationId ?? ''));
  if (!loc) return;
  const send = (app.services.feedbackMailer as typeof deliverEmail | undefined) ?? deliverEmail;
  const brand = getBranding(app).name || 'HyperLevel';
  const base = app.baseUrl();
  for (const u of ids) {
    const user = db.get<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', u);
    if (!user?.email) continue;
    const prefs = db.get<{ email: number }>('SELECT email FROM feedback_prefs WHERE user_id = ?', u);
    if (prefs && prefs.email === 0) continue;
    const lines = [`Hallo ${String(user.name || '').split(' ')[0] || ''},`, '', t.title, ...(body ? ['', body] : []), '', `Auftrag öffnen: ${base}${url}`];
    for (const a of t.actions ?? []) lines.push(`${a.title}: ${base}${q(t.path, t.locationId, a.action)}`);
    if (t.actions?.length) lines.push('', 'Die Links öffnen die Seite in der App – erst dort bestätigst du.');
    lines.push('', 'Viele Grüße', brand);
    const text = lines.join('\n');
    let html = textToHtml(text);
    for (const link of new Set(lines.filter((l) => l.includes(`${base}/`)).map((l) => l.slice(l.indexOf(base))))) html = html.replace(escapeHtml(link), `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`);
    try {
      await send(loc, { to: user.email, subject: t.title, text, html });
    } catch (e) {
      console.error('[werkstatt] mail', (e as Error).message);
    }
  }
}
