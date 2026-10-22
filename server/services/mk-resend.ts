import type { App } from '../core/app.js';
import { bad } from '../core/http.js';
import { cleanSender } from './mk-ab.js';

/**
 * Resend to non-openers: some hours or days after a campaign is through, everybody who got it but did not open or click it
 * gets the same mail again under a new subject. "Opened" means a person opened it – a machine's image load (Apple Mail
 * Privacy Protection, Gmail proxy, a scanner) does not count, so those readers are not skipped by mistake. Runs once per campaign.
 */

export interface ResendConfig {
  enabled: boolean;
  after_hours: number;
  subject: string;
  sender_name?: string;
  /** waiting → created (the follow-up campaign exists) | skipped (nobody left, or the campaign was cancelled) */
  status?: 'waiting' | 'created' | 'skipped';
  child_id?: string | null;
  created_at?: string | null;
  note?: string | null;
}

export const MAX_RESEND_HOURS = 720;
export const DEFAULT_RESEND_HOURS = 72;

const clampInt = (v: unknown, min: number, max: number, def: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** The setting from the browser or API; `null` / `enabled: false` turns it off. */
export function cleanResendConfig(input: unknown, campaign: { channel: string; subject?: string; parent_id?: string | null }): ResendConfig | null {
  if (input === null || input === undefined || input === false) return null;
  if (typeof input !== 'object') throw bad('Erneut senden: ungültige Angaben');
  const o = input as Record<string, any>;
  if (o.enabled === false) return null;
  if (campaign.channel !== 'email') throw bad('„Erneut an Nicht-Öffner“ gibt es nur für E-Mail-Kampagnen');
  if (campaign.parent_id) throw bad('Eine Erinnerung lässt sich nicht noch einmal erinnern');
  const subject = String(o.subject ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, 300);
  if (!subject) throw bad('Erneut senden: ein neuer Betreff fehlt');
  if (subject === (campaign.subject ?? '').trim()) throw bad('Erneut senden: der Betreff muss sich vom ersten unterscheiden');
  const sender = cleanSender(o.sender_name);
  return { enabled: true, after_hours: clampInt(o.after_hours, 1, MAX_RESEND_HOURS, DEFAULT_RESEND_HOURS), subject, ...(sender ? { sender_name: sender } : {}), status: 'waiting' };
}

/** When the follow-up is due: `after_hours` after the campaign finished sending. */
export function dueAt(cfg: ResendConfig, sentAt: string): string {
  return new Date(Date.parse(sentAt) + cfg.after_hours * 3600_000).toISOString();
}

export const isDue = (cfg: ResendConfig | null | undefined, sentAt: string | null | undefined, at = Date.now()): boolean =>
  !!cfg?.enabled && cfg.status === 'waiting' && !!sentAt && Date.parse(sentAt) + cfg.after_hours * 3600_000 <= at;

/** Contacts who got the campaign (a mail that went out) and neither opened nor clicked it as a person. */
export function nonOpenerIds(app: App, campaignId: string, locationId: string): string[] {
  return app.db
    .all<{ contact_id: string }>(
      `SELECT r.contact_id FROM campaign_recipients r JOIN messages m ON m.id = r.message_id JOIN campaigns k ON k.id = r.campaign_id
       WHERE r.campaign_id = ? AND k.location_id = ? AND r.status = 'sent' AND m.status IN ('sent', 'delivered', 'logged') AND m.opened_at IS NULL AND m.clicked_at IS NULL`,
      campaignId,
      locationId,
    )
    .map((r) => r.contact_id);
}
