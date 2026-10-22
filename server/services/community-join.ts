import type { App } from '../core/app.js';
import { HttpError, bad } from '../core/http.js';
import { id, normalizeEmail, now, token } from '../core/util.js';
import { StripeError, stripeRequest } from './stripe.js';
import { getContact, logActivity, upsertContact, type Contact } from './contacts.js';
import { ensureQuestionFields, membershipOf, openMembership, tierOf, tierPrices, tiersOf, activateMembership, checkoutUrl, communityMail, notifyStaff, grants, type Billing, type Membership, type PageRow, type Tier } from './community-tiers.js';

/**
 * The join itself: invite codes, discount codes, the questions, and what a request turns into – a member (free, no approval),
 * an entry in the approval queue, or a checkout. Everything a public form sends is validated here.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
type G = { id: string; location_id: string; name: string; slug: string };

// --- invites ----------------------------------------------------------------------------------------------------

export interface Invite {
  id: string;
  location_id: string;
  group_id: string;
  code: string;
  label: string;
  tier_id: string | null;
  skip_approval: number;
  trial_days: number | null;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  active: number;
  created_by: string;
  created_at: string;
}

export const newInviteCode = () => token(6).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || id(8).toLowerCase();

/** An invite that may be used right now, or undefined (unknown, off, expired, used up). */
export function usableInvite(app: App, groupId: string, code: unknown): Invite | undefined {
  const c = String(code ?? '').trim().toLowerCase().slice(0, 40);
  if (!c) return undefined;
  const inv = app.db.get<Invite>('SELECT * FROM community_invites WHERE group_id = ? AND code = ?', groupId, c);
  if (!inv || !inv.active) return undefined;
  if (inv.expires_at && inv.expires_at < now()) return undefined;
  if (inv.max_uses && inv.uses >= inv.max_uses) return undefined;
  return inv;
}

/**
 * A limited invite whose uses are taken: by people who are in, or held by people paying with it right now (see heldUses).
 * `exceptMembership` is the asker's own membership – its own open Checkout page never counts against it.
 */
export function inviteFull(app: App, inv: Invite, exceptMembership: string | null = null): boolean {
  return !!inv.max_uses && (inv.uses >= inv.max_uses || inv.uses + heldUses(app, inv.location_id, { invite: inv.id }, exceptMembership) >= inv.max_uses);
}
export const INVITE_HELD = 'Dieser Einladungslink ist gerade vergeben – jemand bezahlt gerade damit. Wird der Beitritt nicht abgeschlossen, ist er in einer halben Stunde wieder frei.';

// --- holds: a limited invite or code while somebody pays with it ------------------------------------------------------------

/**
 * A limited invite counts its use when somebody is really in, a limited discount code when the purchase is paid – but the person
 * pays on Stripe's page minutes after joining. Until then the use is *held*: by the Checkout page that carries it (it expires after
 * 31 minutes, a SEPA payment holds it until the bank answers, a paid one until the membership is settled) and, while that page is
 * being made, in memory. Without the hold everybody who started before the first one finished got the invite or the discount too.
 */
const HOLD_MS = 33 * 60_000;
type Hold = { invite?: string; coupon?: string; membership: string; until: number };
const making = new Map<string, Hold>();
const couponKey = (groupId: string, code: string) => `${groupId}:${code}`;

function heldUses(app: App, locationId: string, what: { invite: string } | { group: string; code: string }, exceptMembership: string | null): number {
  const byInvite = 'invite' in what;
  const since = new Date(Date.now() - HOLD_MS).toISOString();
  const rows = app.db.all<{ h: string | null; m: string | null }>(
    `SELECT json_extract(s.meta, '$.community_hold') AS h, json_extract(s.meta, '$.community_membership') AS m FROM stripe_checkouts s
     WHERE s.location_id = ? AND s.status IN ('pending', 'open', 'processing', 'paid')
       AND ${byInvite ? `json_extract(s.meta, '$.community_invite') = ?` : `json_extract(s.meta, '$.community_group') = ? AND json_extract(s.meta, '$.community_coupon') = ?`}
       AND (s.status = 'pending' OR (s.status IN ('open', 'processing') AND s.created_at > ?)
         OR (s.status = 'paid' AND s.paid_at > ? AND EXISTS (SELECT 1 FROM community_memberships cm WHERE cm.id = json_extract(s.meta, '$.community_membership') AND cm.status = 'awaiting_payment')))`,
    locationId,
    ...(byInvite ? [what.invite] : [what.group, what.code]),
    since,
    since,
  );
  const holds = new Set<string>();
  rows.forEach((r, i) => {
    if (!exceptMembership || r.m !== exceptMembership) holds.add(r.h ?? `row-${i}`);
  });
  // a hold in memory ends once its Checkout page is stored (from then on the row speaks for it) – or after two minutes
  for (const [h, x] of making) {
    if (x.until < Date.now() || app.db.get(`SELECT 1 AS x FROM stripe_checkouts WHERE location_id = ? AND json_extract(meta, '$.community_hold') = ?`, locationId, h)) {
      making.delete(h);
      continue;
    }
    if (x.membership !== exceptMembership && (byInvite ? x.invite === what.invite : x.coupon === couponKey(what.group, what.code))) holds.add(h);
  }
  return holds.size;
}

/**
 * The Checkout page of a membership is being made with a limited invite and/or code: the use is held from now on (in memory until
 * the page is stored, then by the page – see heldUses), and the page expires after 31 minutes so an abandoned payment frees it again.
 */
export function holdForCheckout(m: { id: string; group_id: string }, o: { invite?: Invite; coupon?: Coupon }, params: Record<string, any>, meta: Record<string, any>): void {
  const invite = o.invite?.max_uses ? o.invite.id : undefined;
  const coupon = o.coupon?.max_uses ? couponKey(m.group_id, o.coupon.code) : undefined;
  if (!invite && !coupon) return;
  const hold = token(12);
  making.set(hold, { invite, coupon, membership: m.id, until: Date.now() + 2 * 60_000 });
  meta.community_hold = hold;
  if (invite) meta.community_invite = invite;
  params.expires_at = Math.floor(Date.now() / 1000) + 31 * 60;
}

export function cleanInvite(app: App, g: G, input: any, cur?: Invite) {
  const b = input ?? {};
  const out: Record<string, any> = {};
  if (b.label !== undefined || !cur) out.label = String(b.label ?? '').trim().slice(0, 80);
  if (b.tier_id !== undefined) {
    if (b.tier_id && !tierOf(app, g.id, b.tier_id)) throw bad('Stufe nicht gefunden');
    out.tier_id = b.tier_id || null;
  }
  if (b.skip_approval !== undefined) out.skip_approval = b.skip_approval ? 1 : 0;
  if (b.trial_days !== undefined) out.trial_days = b.trial_days === null || b.trial_days === '' ? null : Math.min(Math.max(Math.round(Number(b.trial_days) || 0), 0), 365);
  if (b.max_uses !== undefined) out.max_uses = b.max_uses === null || b.max_uses === '' ? null : Math.max(1, Math.round(Number(b.max_uses) || 1));
  if (b.expires_at !== undefined) {
    if (!b.expires_at) out.expires_at = null;
    else {
      const t = Date.parse(String(b.expires_at));
      if (Number.isNaN(t)) throw bad('Ablaufdatum ist ungültig');
      out.expires_at = new Date(t).toISOString();
    }
  }
  if (b.active !== undefined) out.active = b.active ? 1 : 0;
  if (b.code !== undefined) {
    const code = String(b.code).trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,40}$/.test(code)) throw bad('Code: 3–40 Zeichen, a–z, 0–9, - und _');
    if (app.db.get('SELECT id FROM community_invites WHERE group_id = ? AND code = ? AND id != ?', g.id, code, cur?.id ?? '')) throw bad('Diesen Code gibt es schon');
    out.code = code;
  }
  return out;
}

// --- discount codes ---------------------------------------------------------------------------------------------

export interface Coupon {
  id: string;
  location_id: string;
  group_id: string;
  code: string;
  label: string;
  percent_off: number | null;
  amount_off_cents: number | null;
  duration: 'once' | 'repeating' | 'forever';
  months: number | null;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  tier_id: string | null;
  active: number;
  stripe_coupon_id: string | null;
  created_at: string;
}

const normCode = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');

export function cleanCoupon(app: App, g: G, input: any, cur?: Coupon) {
  const b = input ?? {};
  const out: Record<string, any> = {};
  if (b.code !== undefined || !cur) {
    const code = normCode(b.code);
    if (!/^[A-Z0-9_-]{2,40}$/.test(code)) throw bad('Code: 2–40 Zeichen, A–Z, 0–9, - und _');
    if (app.db.get('SELECT id FROM community_coupons WHERE group_id = ? AND code = ? AND id != ?', g.id, code, cur?.id ?? '')) throw bad('Diesen Code gibt es schon');
    out.code = code;
  }
  if (b.label !== undefined) out.label = String(b.label ?? '').trim().slice(0, 80);
  const kind = b.kind ?? (b.percent_off !== undefined ? 'percent' : b.amount_off_cents !== undefined ? 'amount' : cur ? (cur.percent_off ? 'percent' : 'amount') : '');
  if (b.percent_off !== undefined || b.amount_off_cents !== undefined || !cur) {
    if (kind === 'percent') {
      const p = Math.round(Number(b.percent_off));
      if (!(p >= 1 && p <= 100)) throw bad('Rabatt: 1 bis 100 %');
      Object.assign(out, { percent_off: p, amount_off_cents: null, stripe_coupon_id: null });
    } else if (kind === 'amount') {
      const a = Math.round(Number(b.amount_off_cents));
      if (!(a >= 1)) throw bad('Rabatt: Betrag in Cent über 0');
      Object.assign(out, { percent_off: null, amount_off_cents: a, stripe_coupon_id: null });
    } else throw bad('Rabatt: Prozent oder Betrag angeben');
  }
  if (b.duration !== undefined || !cur) {
    const d = ['once', 'repeating', 'forever'].includes(b.duration) ? b.duration : 'once';
    out.duration = d;
    out.months = d === 'repeating' ? Math.min(Math.max(Math.round(Number(b.months) || 3), 1), 36) : null;
    out.stripe_coupon_id = null;
  }
  if (b.max_uses !== undefined) out.max_uses = b.max_uses === null || b.max_uses === '' ? null : Math.max(1, Math.round(Number(b.max_uses) || 1));
  if (b.expires_at !== undefined) {
    if (!b.expires_at) out.expires_at = null;
    else {
      const t = Date.parse(String(b.expires_at));
      if (Number.isNaN(t)) throw bad('Ablaufdatum ist ungültig');
      out.expires_at = new Date(t).toISOString();
    }
  }
  if (b.tier_id !== undefined) {
    if (b.tier_id && !tierOf(app, g.id, b.tier_id)) throw bad('Stufe nicht gefunden');
    out.tier_id = b.tier_id || null;
  }
  if (b.active !== undefined) out.active = b.active ? 1 : 0;
  return out;
}

/** A code that may be used now (`exceptMembership`: the asker's own membership, whose open Checkout page does not count against it). */
export function usableCoupon(app: App, groupId: string, code: unknown, tierId?: string | null, exceptMembership: string | null = null): { coupon: Coupon } | { error: string } {
  const c = normCode(code);
  if (!c) return { error: 'Bitte einen Code eingeben' };
  const row = app.db.get<Coupon>('SELECT * FROM community_coupons WHERE group_id = ? AND code = ?', groupId, c);
  if (!row || !row.active) return { error: 'Diesen Rabattcode gibt es nicht' };
  if (row.expires_at && row.expires_at < now()) return { error: 'Dieser Rabattcode ist abgelaufen' };
  if (row.max_uses && row.uses >= row.max_uses) return { error: 'Dieser Rabattcode ist schon aufgebraucht' };
  if (row.max_uses && row.uses + heldUses(app, row.location_id, { group: groupId, code: row.code }, exceptMembership) >= row.max_uses) return { error: 'Dieser Rabattcode ist gerade aufgebraucht – jemand bezahlt gerade damit. Wird der Kauf nicht abgeschlossen, ist er in einer halben Stunde wieder frei.' };
  if (row.tier_id && tierId && row.tier_id !== tierId) return { error: 'Dieser Rabattcode gilt nicht für diese Stufe' };
  return { coupon: row };
}

export const couponLabel = (c: Coupon, currency = 'EUR') =>
  `${c.percent_off ? `−${c.percent_off} %` : `−${new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format((c.amount_off_cents ?? 0) / 100)}`}${c.duration === 'once' ? ' auf die erste Zahlung' : c.duration === 'repeating' ? ` für ${c.months} Monate` : ' dauerhaft'}`;

/** The Stripe coupon for a code (created once with the sub-account's key, then reused). */
export async function stripeCouponId(app: App, locationId: string, c: Coupon, currency: string, force = false): Promise<string> {
  if (c.stripe_coupon_id && !force) return c.stripe_coupon_id;
  const key: string = app.services.stripeBuy?.secretKey?.(locationId) ?? '';
  if (!key) throw bad('Stripe ist nicht eingerichtet');
  try {
    const made = await stripeRequest(key, 'POST', '/v1/coupons', {
      ...(c.percent_off ? { percent_off: c.percent_off } : { amount_off: c.amount_off_cents, currency: currency.toLowerCase() }),
      duration: c.duration,
      ...(c.duration === 'repeating' ? { duration_in_months: c.months } : {}),
      name: `Community ${c.code}`.slice(0, 40),
      metadata: { location_id: locationId, community_coupon: c.id },
    });
    app.db.run('UPDATE community_coupons SET stripe_coupon_id = ? WHERE id = ?', made.id, c.id);
    return String(made.id);
  } catch (e) {
    if (e instanceof StripeError) throw new HttpError(502, `Stripe: ${e.message}`);
    throw e;
  }
}

// --- join ----------------------------------------------------------------------------------------------------------------

export interface JoinInput {
  name: string;
  email: string;
  tier_id?: string;
  billing?: string;
  answers?: Record<string, unknown>;
  consent?: boolean;
  invite?: string;
  coupon?: string;
  source?: string;
}

export interface JoinResult {
  membership: Membership;
  contact: Contact;
  /** active: in (log in link goes out) · pending: waits for approval · checkout: pay first (url) · member: was in already */
  next: 'active' | 'pending' | 'checkout' | 'member';
  url?: string;
}

const cleanName = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);

export function validateAnswers(page: PageRow, answers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of page.questions) {
    const v = String(answers?.[q.id] ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 500);
    if (q.required && !v) throw bad(`Bitte beantworte: ${q.label}`);
    if (v) out[q.id] = v;
  }
  return out;
}

/** Billing options a person may choose for a tier, defaulting to the cheapest first. */
export function chooseBilling(app: App, tier: Tier, wanted: unknown): Billing {
  const p = tierPrices(app, tier);
  if (p.free) return 'free';
  const order: Billing[] = ['month', 'year', 'once'];
  const w = String(wanted ?? '') as Billing;
  if (order.includes(w) && p[w as 'month' | 'year' | 'once']) return w;
  const first = order.find((b) => p[b as 'month' | 'year' | 'once']);
  if (!first) throw bad('Diese Stufe hat gerade keine Zahlungsmöglichkeit – bitte später noch einmal');
  return first;
}

/**
 * A person asks to join. Creates or merges the contact (tags, answers on the contact), then: free without approval = member
 * right away; with approval = request; paid = membership "awaiting_payment" and the link to the product's checkout.
 */
export function joinCommunity(app: App, g: G, page: PageRow, input: JoinInput): JoinResult {
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email) || email.length > 200) throw bad('Bitte eine gültige E-Mail-Adresse angeben');
  const name = cleanName(input.name);
  if (name.length < 2) throw bad('Bitte deinen Namen angeben');
  if (/[<>]/.test(name)) throw bad('Name: bitte ohne < >');
  const answers = validateAnswers(page, input.answers);

  // Somebody who comes back (an abandoned payment, a second try) is not held up by their own open Checkout page.
  const existing = getContactByEmail(app, g.location_id, email);
  const own = existing ? (membershipOf(app, g.id, existing.id)?.id ?? null) : null;
  const invite = usableInvite(app, g.id, input.invite);
  if (input.invite && !invite) throw bad('Dieser Einladungslink ist nicht mehr gültig');
  if (invite && inviteFull(app, invite, own)) throw bad(INVITE_HELD);
  const tiers = tiersOf(app, g.id, true);
  if (!tiers.length) throw bad('Diese Community ist gerade nicht offen für neue Mitglieder');
  const tier = (invite?.tier_id && tiers.find((t) => t.id === invite.tier_id)) || tiers.find((t) => t.id === input.tier_id) || (tiers.length === 1 ? tiers[0] : undefined);
  if (!tier) throw bad('Bitte wähle eine Stufe');
  const billing = chooseBilling(app, tier, input.billing);
  const prices = tierPrices(app, tier);
  const product = billing === 'free' ? undefined : prices[billing];
  if (product && !product.active) throw bad('Dieses Angebot ist gerade nicht verfügbar');
  if (product && !app.services.stripeBuy?.secretKey?.(g.location_id)) throw bad('Die Bezahlung ist hier noch nicht eingerichtet – bitte melde dich beim Team');
  let coupon = '';
  if (input.coupon && String(input.coupon).trim()) {
    if (!product) throw bad('Rabattcodes gelten nur für bezahlte Stufen');
    const r = usableCoupon(app, g.id, input.coupon, tier.id, own);
    if ('error' in r) throw bad(r.error);
    coupon = r.coupon.code;
  }

  // A banned person doesn't get back in through the front door.
  if (existing &&app.db.get('SELECT 1 FROM community_members WHERE group_id = ? AND contact_id = ? AND banned_at IS NOT NULL', g.id, existing.id)) throw new HttpError(403, 'Du kannst dieser Community nicht beitreten.');

  const fields = ensureQuestionFields(app, g.location_id, page.questions);
  const custom: Record<string, string> = {};
  for (const q of fields) if (answers[q.id]) custom[q.field_key] = answers[q.id];
  const { contact } = upsertContact(app, g.location_id, { name, email, custom }, { source: input.source || `Community: ${g.name}` });

  const cur = membershipOf(app, g.id, contact.id);
  if (cur && grants(app, cur)) return { membership: cur, contact, next: 'member' };

  const needsApproval = !!page.approval && !invite?.skip_approval;
  const base = { tier_id: tier.id, billing, product_id: product?.id ?? null, answers, invite_id: invite?.id ?? null, coupon_code: coupon, consent: input.consent ? 1 : 0, source: invite ? 'invite' : (input.source ?? 'join') };

  if (needsApproval) {
    const m = openMembership(app, g, contact, { ...base, status: 'pending' });
    logActivity(app, g.location_id, contact.id, 'community.join_requested', `Beitritt zu „${g.name}“ angefragt (Stufe ${tier.name})`);
    app.events.emit(g.location_id, 'community.join_requested', { contactId: contact.id, groupId: g.id, group: { id: g.id, name: g.name }, tier: { id: tier.id, name: tier.name }, answers: Object.fromEntries(page.questions.filter((q) => answers[q.id]).map((q) => [q.label, answers[q.id]])) });
    void notifyStaff(app, g.location_id, `Neue Beitrittsanfrage: ${name} möchte „${g.name}“ beitreten`, `${name} (${email}) hat sich für „${g.name}“ (Stufe ${tier.name}) angemeldet.\n\n${page.questions.filter((q) => answers[q.id]).map((q) => `${q.label}\n→ ${answers[q.id]}`).join('\n\n')}\n\nDie Anfrage prüfst du unter Community → ${g.name} → Beitritt → Anfragen.`);
    return { membership: m, contact, next: 'pending' };
  }
  if (!product) {
    const m = openMembership(app, g, contact, { ...base, status: 'pending' });
    const active = activateMembership(app, g, m, {});
    return { membership: active, contact, next: 'active' };
  }
  const m = openMembership(app, g, contact, { ...base, status: 'awaiting_payment' });
  return { membership: m, contact, next: 'checkout', url: checkoutUrl(app, m) };
}

function getContactByEmail(app: App, locationId: string, email: string): Contact | undefined {
  const row = app.db.get<{ id: string }>('SELECT id FROM contacts WHERE location_id = ? AND email = ?', locationId, email);
  return row ? getContact(app, locationId, row.id) : undefined;
}

/** The mail for somebody who joined for free or came back: the login link. */
export async function sendWelcome(app: App, g: G, contact: Contact, text?: string) {
  if (!contact.email) return;
  try {
    await app.services.sendMemberLoginLink?.(g.location_id, contact.id);
  } catch (e) {
    console.error('[community] login link', (e as Error).message);
  }
  if (text) await communityMail(app, g.location_id, contact.email, `Willkommen in „${g.name}“`, [text]);
}
