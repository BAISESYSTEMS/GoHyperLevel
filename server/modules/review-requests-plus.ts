import type { App, Module } from '../core/app.js';
import { HttpError, bad } from '../core/http.js';
import { now } from '../core/util.js';
import { findContacts } from '../services/contacts.js';
import { sendReviewRequest } from '../services/reviews.js';
import type { Tool } from './mcp.js';

/**
 * Bewertungsanfragen ausbauen – docs/reputation.md#review-requests-in-bulk-and-reminders. Send review requests to many contacts at
 * once (chosen ones or everyone with a tag) – skipping people without an address for the channel and people asked recently – and an
 * optional reminder: a request without an answer after N days is sent once more. Sending goes through the normal review request
 * (template, consent and suppression of `sendToContact`).
 */

const MAX_BULK = 200;

export const reviewRequestsPlusModule: Module = {
  name: 'review-requests-plus',
  migrations: [
    [
      '001-init',
      `CREATE TABLE review_request_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        followup_days INTEGER NOT NULL DEFAULT 0, skip_days INTEGER NOT NULL DEFAULT 90, updated_at TEXT NOT NULL
      );
      CREATE TABLE review_request_followups (
        request_id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, followup_id TEXT, at TEXT NOT NULL
      );`,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const settingsOf = (loc: string) => db.get<{ followup_days: number; skip_days: number }>('SELECT followup_days, skip_days FROM review_request_settings WHERE location_id = ?', loc) ?? { followup_days: 0, skip_days: 90 };

    router.get('/api/reviews/request-settings', 'location', (ctx) => settingsOf(ctx.locationId));
    router.put('/api/reviews/request-settings', 'location', (ctx) => {
      const f = Math.round(Number(ctx.body?.followup_days ?? 0));
      const s = Math.round(Number(ctx.body?.skip_days ?? 90));
      const followup = Number.isFinite(f) && f > 0 ? Math.min(30, Math.max(2, f)) : 0;
      const skip = Number.isFinite(s) ? Math.min(365, Math.max(0, s)) : 90;
      db.run('INSERT INTO review_request_settings (location_id, followup_days, skip_days, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET followup_days = excluded.followup_days, skip_days = excluded.skip_days, updated_at = excluded.updated_at', ctx.locationId, followup, skip, now());
      return settingsOf(ctx.locationId);
    });

    /** `{ contact_ids?: [], tag?: string, channel?: 'email'|'sms' }` → sends, with a reason for everyone skipped. */
    router.post('/api/reviews/request/bulk', 'location', async (ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
      const channel = ctx.body?.channel === 'sms' ? 'sms' : 'email';
      const tag = String(ctx.body?.tag ?? '').trim();
      let ids: string[] = Array.isArray(ctx.body?.contact_ids) ? [...new Set(ctx.body.contact_ids.map(String))] as string[] : [];
      if (!ids.length && tag) ids = findContacts(app, ctx.locationId, { tags: [tag], limit: MAX_BULK + 1, noTotal: true, who: ctx }).contacts.map((c: any) => String(c.id));
      if (!ids.length) throw bad('Keine Kontakte gewählt');
      if (ids.length > MAX_BULK) throw bad(`Höchstens ${MAX_BULK} Kontakte auf einmal`);
      const { skip_days } = settingsOf(ctx.locationId);
      const since = new Date(Date.now() - skip_days * 864e5).toISOString();
      const sent: string[] = [];
      const skipped: { contact_id: string; reason: string }[] = [];
      for (const cid of ids) {
        const c = db.get<{ id: string; email: string | null; phone: string | null }>('SELECT id, email, phone FROM contacts WHERE id = ? AND location_id = ?', cid, ctx.locationId);
        if (!c) {
          skipped.push({ contact_id: cid, reason: 'Kontakt nicht gefunden' });
          continue;
        }
        if (channel === 'email' ? !c.email : !c.phone) {
          skipped.push({ contact_id: cid, reason: channel === 'email' ? 'Keine E-Mail-Adresse' : 'Keine Telefonnummer' });
          continue;
        }
        if (skip_days > 0 && db.get('SELECT 1 FROM review_requests WHERE location_id = ? AND contact_id = ? AND created_at >= ?', ctx.locationId, cid, since)) {
          skipped.push({ contact_id: cid, reason: `Schon in den letzten ${skip_days} Tagen gefragt` });
          continue;
        }
        try {
          await sendReviewRequest(app, ctx.locationId, cid, channel);
          sent.push(cid);
        } catch (e) {
          skipped.push({ contact_id: cid, reason: String((e as Error).message).slice(0, 200) });
        }
      }
      return { sent: sent.length, skipped };
    });

    /** Reminders: one more request for unanswered ones after `followup_days` (not older than two extra weeks). */
    async function followups(limit = 50): Promise<number> {
      const t = Date.now();
      const due = db.all<{ id: string; location_id: string; contact_id: string; channel: string }>(
        `SELECT r.id, r.location_id, r.contact_id, r.channel FROM review_requests r JOIN review_request_settings s ON s.location_id = r.location_id
         WHERE s.followup_days > 0 AND r.responded_at IS NULL AND r.contact_id IS NOT NULL
           AND r.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || s.followup_days || ' days')
           AND r.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || (s.followup_days + 14) || ' days')
           AND NOT EXISTS (SELECT 1 FROM review_request_followups f WHERE f.request_id = r.id OR f.followup_id = r.id)
           AND NOT EXISTS (SELECT 1 FROM review_requests n WHERE n.contact_id = r.contact_id AND n.location_id = r.location_id AND n.created_at > r.created_at)
         ORDER BY r.created_at LIMIT ?`,
        new Date(t).toISOString(), new Date(t).toISOString(), limit,
      );
      let n = 0;
      for (const r of due) {
        let followupId: string | null = null;
        try {
          followupId = (await sendReviewRequest(app, r.location_id, r.contact_id, r.channel === 'sms' ? 'sms' : 'email')).id;
          n++;
        } catch {
          /* not sendable (no consent, no address): remember, never retry */
        }
        db.run('INSERT OR IGNORE INTO review_request_followups (request_id, location_id, followup_id, at) VALUES (?, ?, ?, ?)', r.id, r.location_id, followupId, now());
      }
      return n;
    }
    let last = 0;
    let busy = false;
    app.onTick(async () => {
      if (busy || Date.now() - last < 10 * 60_000) return;
      busy = true;
      last = Date.now();
      try {
        await followups();
      } finally {
        busy = false;
      }
    });
    app.services.reviewFollowups = followups;

    const TOOLS: Tool[] = [
      {
        name: 'ghl_review_request_bulk',
        title: 'Bewertungsanfragen an viele Kontakte senden',
        description: `Sendet Bewertungsanfragen an gewählte Kontakte (contact_ids) oder alle mit einem Tag (tag), höchstens ${MAX_BULK}. Überspringt Kontakte ohne Adresse und solche, die kürzlich gefragt wurden – mit Grund. Verschickt echt.`,
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, contact_ids: { type: 'array', items: { type: 'string' } }, tag: { type: 'string' }, channel: { type: 'string', enum: ['email', 'sms'] } }, required: ['location_id'], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        run: (call, a) => call.api('POST', '/api/reviews/request/bulk', { location: a.location_id, body: { contact_ids: a.contact_ids, tag: a.tag, channel: a.channel } }),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
