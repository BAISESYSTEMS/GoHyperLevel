import { smartListById, type ListReader } from './smart-lists.js';
import type { App } from '../core/app.js';
import { parseJson, parseRows, toSql } from '../core/db.js';
import { render } from '../core/template.js';
import { id, now } from '../core/util.js';
import { DEFAULT_BATCH, allowedNow, batchSize, tickLength } from './campaign-throttle.js';
import { contactVars, findContacts, getContact, type Contact } from './contacts.js';
import { sendToContact } from './messaging.js';
import { abStats, pickWinner, planSplit, variantContent, type AbConfig, type VariantStats } from './mk-ab.js';
import { nonOpenerIds, isDue, type ResendConfig } from './mk-resend.js';
import { getSettings } from './mk-settings.js';
import { loadBuckets, planCampaign } from './mk-sto.js';
import { isMarketing } from './mk-whatsapp.js';
import { segmentMemberIds } from './mk-segments.js';

/**
 * The sending side of campaigns: who gets a campaign, the batches that go out per tick, and the extras around them –
 * A/B tests (a test share first, the winner to the rest), send-time optimisation (every recipient at their own hour), WhatsApp
 * templates, the warm-up cap of a new sender and the follow-up to non-openers. The routes are in modules/campaigns.ts.
 */

/** Columns of `campaigns` that hold JSON. */
export const CAMPAIGN_JSON = ['filter', 'design', 'ab', 'resend', 'wa_template'];

export const parseCampaign = (row: any) => parseJson(row, CAMPAIGN_JSON);

const contactsByIds = (app: App, locationId: string, ids: string[]): Contact[] => {
  const out: Contact[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    out.push(...parseRows(app.db.all<Contact>(`SELECT * FROM contacts WHERE location_id = ? AND id IN (${chunk.map(() => '?').join(',')})`, locationId, ...chunk), ['tags', 'custom']));
  }
  return out;
};

const BASE_KEYS = ['smart_list_id', 'segment_id', 'resend_of'];
const filled = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '' && v !== false);

/**
 * The contacts a filter selects: tags and smart list as before, a saved segment (`segment_id`, narrowing the rest), or the
 * non-openers of an earlier campaign (`resend_of`, set by the follow-up campaign).
 */
export function audience(app: App, locationId: string, filter: any, who: ListReader): Contact[] {
  let f = filter ?? {};
  if (f.resend_of) return contactsByIds(app, locationId, nonOpenerIds(app, String(f.resend_of), locationId));
  if (f.smart_list_id) {
    // A deleted list – or another person's private one (services/smart-lists.ts) – selects nobody, never everybody.
    const sl = smartListById(app, locationId, f.smart_list_id, who);
    if (!sl) return [];
    f = { ...sl.filter, ...f };
  }
  const plain = Object.keys(f).some((k) => !BASE_KEYS.includes(k) && filled(f[k])) || !!f.smart_list_id;
  if (f.segment_id && !plain) return contactsByIds(app, locationId, segmentMemberIds(app, locationId, String(f.segment_id)) ?? []);
  const list = findContacts(app, locationId, { tags: f.tags ?? [], anyTags: f.anyTags ?? [], excludeTags: f.excludeTags ?? [], q: f.q ?? '', limit: 1_000_000, extra: f }).contacts;
  if (!f.segment_id) return list;
  // A segment that no longer exists selects nobody (never everybody).
  const members = new Set(segmentMemberIds(app, locationId, String(f.segment_id)) ?? []);
  return list.filter((c) => members.has(c.id));
}

/** Has an address on the campaign's channel and no „Nicht stören“. */
export const reachable = (c: Contact, channel: string) => !!(channel === 'email' ? c.email : c.phone) && !c.dnd;

/** Messages of the campaign that went out or failed (what counts against its sending speed). */
export const handled = (app: App, campaignId: string) => app.db.get<{ n: number }>(`SELECT COUNT(*) n FROM campaign_recipients WHERE campaign_id = ? AND status IN ('sent', 'failed')`, campaignId)!.n;
export const defaultBatchOf = (loc: { settings: Record<string, any> }) => batchSize(loc.settings.campaigns?.batch_size ?? DEFAULT_BATCH);

/** Consent gate (modules/consent.ts): contact id → why advertising may not go there (only the blocked ones). */
export const consentBlocks = (app: App, locationId: string, contacts: any[], channel: string): Map<string, string> => {
  const verdicts: Map<string, { allow: boolean; reason: string }> | undefined = app.services.consent?.allowMarketingMany?.(locationId, contacts, channel);
  const out = new Map<string, string>();
  if (verdicts) for (const c of contacts) if (verdicts.get(c.id)?.allow === false) out.set(c.id, verdicts.get(c.id)!.reason);
  return out;
};

/** Contacts the campaign must skip, with the reason: no valid consent (advertising only), unusable e-mail address. */
export function blockedContacts(app: App, campaign: any, reach: Contact[]): Map<string, string> {
  const loc = campaign.location_id;
  const blocked = new Map<string, string>();
  // A WhatsApp template of another category than MARKETING is a service message: no advertising consent needed (DND still counts).
  if (!(campaign.channel === 'whatsapp' && !isMarketing(campaign.wa_template))) for (const [k, v] of consentBlocks(app, loc, reach, campaign.channel)) blocked.set(k, v);
  if (campaign.channel === 'email') {
    const quality: Map<string, string> | undefined = app.services.mkEmailBlocks?.(loc, reach);
    if (quality) for (const [k, v] of quality) if (!blocked.has(k)) blocked.set(k, v);
  }
  return blocked;
}

/** Warm-up: the contacts who engage most go first, so the first (capped) mails reach the people who help the reputation. */
function byEngagement(app: App, locationId: string, contacts: Contact[]): Contact[] {
  const buckets = loadBuckets(app, locationId);
  const score = (c: Contact) => (buckets.get(c.id) ?? []).reduce((n, b) => n + b.w, 0);
  return contacts.map((c, i) => ({ c, i, s: score(c) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.c);
}

const stoTimes = (app: App, locationId: string, ids: string[], at = new Date()): Map<string, string> =>
  new Map([...planCampaign(app, locationId, ids, { at, defaultHour: getSettings(app, locationId).sto.default_hour }).at].map(([k, d]) => [k, d.toISOString()]));

/**
 * Fixes the recipients of a campaign and starts it. With an A/B test only the test share is queued, the rest waits as "held";
 * with send-time optimisation every recipient gets their own send time within 24 hours. Returns how many contacts it reaches.
 */
export function startSending(app: App, campaign: any): number {
  const { db } = app;
  const loc = campaign.location_id;
  // The list was checked for the person when it was attached and when sending started (modules/campaigns.ts).
  const reach = audience(app, loc, campaign.filter, 'system').filter((c) => reachable(c, campaign.channel));
  // Contacts without a valid consent are listed as skipped (with the reason), not silently dropped.
  const blocked = blockedContacts(app, campaign, reach);
  let contacts = reach.filter((c) => !blocked.has(c.id));

  const ab: AbConfig | null = campaign.ab?.enabled && campaign.channel === 'email' ? campaign.ab : null;
  let abNext: AbConfig | null = ab;
  let variantOf = new Map<string, string>();
  let heldIds: string[] = [];
  if (ab) {
    const split = planSplit(contacts.map((c) => c.id), ab.variants.map((v) => v.key), ab.test_percent, campaign.id);
    if (split.skipped) abNext = { ...ab, phase: undefined, skipped: split.skipped };
    else {
      variantOf = split.test;
      heldIds = split.held;
      abNext = { ...ab, phase: 'test', skipped: null, winner: null, decide_at: null, decided_at: null, decided_by: null, decided_reason: null, snapshot: null };
    }
  } else if (campaign.channel === 'email' && app.services.mkWarmup?.active?.(loc)) contacts = byEngagement(app, loc, contacts);

  const queue = variantOf.size ? contacts.filter((c) => variantOf.has(c.id)) : contacts;
  const times = campaign.send_mode === 'sto' && campaign.channel === 'email' ? stoTimes(app, loc, queue.map((c) => c.id)) : new Map<string, string>();
  db.tx(() => {
    const ins = `INSERT OR IGNORE INTO campaign_recipients (campaign_id, contact_id, status, variant, send_at) VALUES (?, ?, ?, ?, ?)`;
    for (const c of queue) db.run(ins, campaign.id, c.id, 'pending', variantOf.get(c.id) ?? '', times.get(c.id) ?? null);
    for (const cid of heldIds) db.run(ins, campaign.id, cid, 'held', '', null);
    for (const [cid, why] of blocked) db.run(`INSERT OR IGNORE INTO campaign_recipients (campaign_id, contact_id, status, error) VALUES (?, ?, 'skipped', ?)`, campaign.id, cid, why);
    // The sending speed counts from here.
    db.run(`UPDATE campaigns SET status = 'sending', started_at = ?, throttle_at = ?, throttle_sent = 0, ab = ? WHERE id = ?`, now(), now(), toSql(abNext ?? campaign.ab ?? null), campaign.id);
  });
  return contacts.length;
}

/** Sends one recipient's mail: e-mail, SMS or WhatsApp template. Returns the message (or a failure). */
async function sendOne(app: App, campaign: any, c: Contact, variant: string): Promise<{ id: string | null; status: string; error?: string }> {
  const loc = app.location(campaign.location_id)!;
  const vars = { contact: contactVars(c), location: loc };
  const source = `Kampagne: ${campaign.name}`;
  if (campaign.channel === 'whatsapp') {
    const t = campaign.wa_template;
    const send: ((loc: string, i: any) => Promise<any>) | undefined = app.services.metaSend;
    if (!t || !send) return { id: null, status: 'failed', error: 'WhatsApp ist nicht eingerichtet' };
    const values = Object.fromEntries(Object.entries((t.values ?? {}) as Record<string, string>).map(([k, v]) => [k, render(String(v), vars)]));
    try {
      const m = await send(campaign.location_id, { contactId: c.id, channel: 'whatsapp', template: { name: t.name, language: t.language, values }, source });
      return { id: m.id ?? null, status: m.status, error: m.error };
    } catch (e) {
      return { id: null, status: 'failed', error: (e as Error).message };
    }
  }
  const content = variantContent(campaign, variant);
  const m = await sendToContact(app, campaign.location_id, {
    contactId: c.id,
    channel: campaign.channel,
    subject: render(content.subject, vars),
    body: render(content.body, vars, { escape: !!content.is_html }),
    text: content.body_text ? render(content.body_text, vars) : undefined,
    isHtml: !!content.is_html,
    source,
    ...(campaign.channel === 'email' && content.sender_name ? { fromName: render(content.sender_name, vars) } : {}),
  });
  return { id: m.id, status: m.status, error: m.error };
}

/** A recipient stays 'sending' only while its message is on the way; one older than this was left behind by a restart. */
const SENDING_STALE_MS = 30 * 60_000;
const SEND_INTERRUPTED = 'Versand unterbrochen (Neustart) – nicht noch einmal gesendet, um keine doppelte Nachricht zu riskieren';

/**
 * Sends the next batch of a campaign that is sending; returns how many went out. The size of the batch is the campaign's own speed
 * (messages per hour, see services/campaign-throttle.ts) or, without one, the sub-account's default per tick (30) – and never more
 * than the warm-up cap of a new sender leaves for today. Recipients with a send time wait for it (send-time optimisation).
 */
export async function sendBatch(app: App, campaign: any): Promise<number> {
  const loc = app.location(campaign.location_id)!;
  let perTick = allowedNow({
    speed: campaign.speed_per_hour ?? null,
    defaultBatch: defaultBatchOf(loc),
    tickMs: tickLength(app.config.tickMs),
    anchorAt: Date.parse(campaign.throttle_at ?? campaign.started_at ?? now()) || Date.now(),
    sentSinceAnchor: campaign.speed_per_hour ? handled(app, campaign.id) - Number(campaign.throttle_sent ?? 0) : 0,
    at: Date.now(),
  });
  if (campaign.channel === 'email') {
    const room: number | null | undefined = app.services.mkWarmup?.room?.(campaign.location_id);
    if (typeof room === 'number') perTick = Math.min(perTick, room);
  }
  // A send the process did not live to write down (restart, crash): the provider may well have taken it – it is not sent again.
  app.db.run(`UPDATE campaign_recipients SET status = 'failed', error = ? WHERE campaign_id = ? AND status = 'sending' AND sent_at < ?`, SEND_INTERRUPTED, campaign.id, new Date(Date.now() - SENDING_STALE_MS).toISOString());
  const pending = perTick > 0 ? app.db.all(`SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending' AND (send_at IS NULL OR send_at <= ?) ORDER BY COALESCE(send_at, ''), rowid LIMIT ?`, campaign.id, now(), perTick) : [];
  let taken = 0;
  for (const r of pending) {
    // Claimed before the send: a second batch at the same time ("Senden" and the scheduler) skips this recipient.
    if (!app.db.run(`UPDATE campaign_recipients SET status = 'sending', sent_at = ? WHERE campaign_id = ? AND contact_id = ? AND status = 'pending'`, now(), campaign.id, r.contact_id).changes) continue;
    taken++;
    const c = getContact(app, campaign.location_id, r.contact_id);
    if (!c) {
      app.db.run(`UPDATE campaign_recipients SET status = 'skipped', error = 'gelöscht' WHERE campaign_id = ? AND contact_id = ?`, campaign.id, r.contact_id);
      continue;
    }
    const m = await sendOne(app, campaign, c, r.variant ?? '');
    app.db.run(`UPDATE campaign_recipients SET status = ?, error = ?, message_id = ?, sent_at = ? WHERE campaign_id = ? AND contact_id = ?`, m.status === 'failed' ? 'failed' : 'sent', m.error ?? '', m.id, now(), campaign.id, c.id);
  }
  const count = (status: string) => app.db.get<{ n: number }>(`SELECT COUNT(*) n FROM campaign_recipients WHERE campaign_id = ? AND status = ?`, campaign.id, status)!.n;
  // Done when nothing waits and nothing is on its way (a batch running at the same time may still be sending its share).
  if (!count('pending') && !count('sending')) {
    const ab: AbConfig | null | undefined = campaign.ab;
    if (ab?.enabled && ab.phase === 'test' && count('held') > 0) {
      // The test mails are out: the clock for the winner starts now.
      const next: AbConfig = { ...ab, phase: 'waiting', decide_at: new Date(Date.now() + ab.wait_hours * 3600_000).toISOString() };
      app.db.run(`UPDATE campaigns SET status = 'testing', ab = ? WHERE id = ?`, toSql(next), campaign.id);
    } else app.db.run(`UPDATE campaigns SET status = 'sent', sent_at = ? WHERE id = ?`, now(), campaign.id);
  }
  return taken;
}

// --- the A/B winner ---------------------------------------------------------------------------------------------

const zeroStats = (key: string): VariantStats => ({ key, sent: 0, opened: 0, clicked: 0, buyers: 0, revenue_cents: 0 });

/** Numbers of every variant of the test (variants without a mail count zero). */
export function variantStats(app: App, campaign: any): VariantStats[] {
  const live = abStats(app, campaign.id, campaign.location_id);
  return (campaign.ab?.variants ?? []).map((v: { key: string }) => live.find((s) => s.key === v.key) ?? zeroStats(v.key));
}

/**
 * Sends the winner to everybody who waited. `key` picks a variant by hand; otherwise the best one on the test's measure wins
 * (no events at all: the original, A). The sending speed counts from now on.
 */
export function releaseWinner(app: App, campaign: any, by: 'auto' | 'manual', key?: string): { winner: string; reason: string } {
  const ab: AbConfig = campaign.ab;
  const stats = variantStats(app, campaign);
  const pick = pickWinner(stats, ab.metric);
  const winner = key && ab.variants.some((v) => v.key === key) ? key : pick.winner;
  const decidedBy = by === 'manual' ? 'manual' : pick.reason === 'no_data' ? 'fallback' : 'auto';
  const reason = by === 'manual' ? 'von Hand gewählt' : pick.reason === 'no_data' ? 'keine Öffnungen oder Klicks – die Originalversion geht raus' : pick.reason === 'tie' ? 'Gleichstand – entschieden nach der nächsten Kennzahl' : 'beste Variante';
  const next: AbConfig = { ...ab, phase: 'winner', winner, decided_at: now(), decided_by: decidedBy, decided_reason: reason, snapshot: stats };
  const held = app.db.all<{ contact_id: string }>(`SELECT contact_id FROM campaign_recipients WHERE campaign_id = ? AND status = 'held'`, campaign.id).map((r) => r.contact_id);
  const times = campaign.send_mode === 'sto' ? stoTimes(app, campaign.location_id, held) : new Map<string, string>();
  app.db.tx(() => {
    for (const cid of held) app.db.run(`UPDATE campaign_recipients SET status = 'pending', variant = ?, send_at = ? WHERE campaign_id = ? AND contact_id = ? AND status = 'held'`, winner, times.get(cid) ?? null, campaign.id, cid);
    app.db.run(`UPDATE campaigns SET status = 'sending', ab = ?, throttle_at = ?, throttle_sent = ? WHERE id = ?`, toSql(next), now(), handled(app, campaign.id), campaign.id);
  });
  return { winner, reason };
}

// --- the follow-up to non-openers ---------------------------------------------------------------------------------

/**
 * Creates and queues the follow-up campaign for everybody who did not open the first one (same content, new subject).
 * Returns the new campaign's id, or null when nobody is left to remind.
 */
export function createResend(app: App, parent: any): string | null {
  const cfg: ResendConfig = parent.resend;
  const left = nonOpenerIds(app, parent.id, parent.location_id);
  if (!left.length) {
    app.db.run('UPDATE campaigns SET resend = ? WHERE id = ?', toSql({ ...cfg, status: 'skipped', note: 'Alle haben geöffnet oder geklickt – es gibt niemanden zu erinnern' }), parent.id);
    return null;
  }
  // The winner's content when the first campaign was an A/B test.
  const winner = parent.ab?.winner ? parent.ab.variants.find((v: { key: string }) => v.key === parent.ab.winner) : undefined;
  const content = variantContent(parent, parent.ab?.winner ?? '');
  const childId = id();
  const t = now();
  app.db.tx(() => {
    app.db.insert('campaigns', {
      id: childId,
      location_id: parent.location_id,
      name: `${parent.name} – Erinnerung`,
      channel: 'email',
      subject: cfg.subject,
      body: content.body,
      body_text: content.body_text,
      is_html: content.is_html,
      design: winner?.design ?? parent.design ?? null,
      filter: { resend_of: parent.id },
      status: 'scheduled',
      scheduled_at: t,
      speed_per_hour: parent.speed_per_hour ?? null,
      send_mode: parent.send_mode ?? 'now',
      sender_name: cfg.sender_name || content.sender_name || '',
      parent_id: parent.id,
      created_at: t,
      updated_at: t,
    });
    app.db.run('UPDATE campaigns SET resend = ? WHERE id = ?', toSql({ ...cfg, status: 'created', child_id: childId, created_at: t, note: null }), parent.id);
  });
  return childId;
}

/** One tick: follow-ups that are due, scheduled campaigns, A/B decisions whose waiting time is over, and the next batches. */
export async function runTick(app: App) {
  const { db } = app;
  for (const parent of parseRows(db.all(`SELECT * FROM campaigns WHERE status = 'sent' AND resend IS NOT NULL AND json_extract(resend, '$.status') = 'waiting' LIMIT 50`), CAMPAIGN_JSON)) {
    if (isDue(parent.resend, parent.sent_at)) createResend(app, parent);
  }
  const due = parseRows(db.all(`SELECT * FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ?`, now()), CAMPAIGN_JSON);
  for (const c of due) startSending(app, c);
  for (const c of parseRows(db.all(`SELECT * FROM campaigns WHERE status = 'testing'`), CAMPAIGN_JSON)) {
    if (c.ab?.decide_at && c.ab.decide_at <= now()) releaseWinner(app, c, 'auto');
  }
  for (const c of parseRows(db.all(`SELECT * FROM campaigns WHERE status = 'sending'`), CAMPAIGN_JSON)) await sendBatch(app, c);
}
